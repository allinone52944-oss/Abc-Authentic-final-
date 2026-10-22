// Route tests for manual-submission file flows + /api/history.
// Covers the 2026-10-21 gap: manual services had NO delivery-file path back
// to the customer (admin could only set status/note) and no admin delete;
// and History (per the owner's simplification) lists ONLY delivery files —
// admin-uploaded files on orders + manual submissions — with no details.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const auth = require('../../auth');
const { customerManual, adminManual } = require('../../routes/manual');
const userRouter = require('../../routes/user');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/manual';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/manual', customerManual);
  a.use('/api/admin/manual', adminManual);
  a.use('/api', userRouter);
  return a;
}
const userTok = () => auth.signAccess({ id: 'u1', role: 'user' });
const adminTok = () => auth.signAccess({ id: 'a1', role: 'admin' });
const asUser = (r) => r.set('Authorization', 'Bearer ' + userTok());
const asAdmin = (r) => r.set('Authorization', 'Bearer ' + adminTok());

beforeEach(() => {
  db.__reset();
  wa.notifyServiceCompleted.mockClear();
  push.notifyUser.mockClear();
});

function putFile(name, content) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), content);
}
function dropFile(name) {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (_) {}
}

const DOCS = [
  { filename: 'manual-own.pdf', originalname: 'my-nid.pdf', uploaded_by: 'customer' },
  { filename: 'manual-del.pdf', originalname: 'result.pdf', uploaded_by: 'admin', type: 'delivery' },
];

describe('GET /api/manual/mine — includes the file list', () => {
  test('documents are returned (own uploads + admin delivery)', async () => {
    db.__routeQuery([
      ['FROM manual_submissions m', { rows: [{ id: 'm1', status: 'completed', created_at: '2026-10-21T00:00:00Z', admin_note: 'হয়ে গেছে', documents: DOCS, service_name_bn: 'ম্যানুয়াল সেবা', service_name: 'Manual', doc_count: 2 }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/mine')).expect(200);
    expect(r.body.list).toHaveLength(1);
    expect(r.body.list[0].documents).toHaveLength(2);
    expect(r.body.list[0].documents[0].uploaded_by).toBe('customer');
    expect(r.body.list[0].documents[1].uploaded_by).toBe('admin');
  });

  test('requires auth → 401', async () => {
    await request(app()).get('/api/manual/mine').expect(401);
  });
});

describe('GET /api/manual/:id/documents/:filename — customer download', () => {
  beforeEach(() => putFile('manual-del.pdf', 'PDF-DELIVERY'));
  afterEach(() => dropFile('manual-del.pdf'));

  test('owner can download an admin delivery file', async () => {
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [{ documents: DOCS }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-del.pdf')).expect(200);
    expect(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.text).toContain('PDF-DELIVERY');
  });

  test('owner can download their own upload too', async () => {
    putFile('manual-own.pdf', 'PDF-OWN');
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [{ documents: DOCS }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-own.pdf')).expect(200);
    expect(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.text).toContain('PDF-OWN');
    dropFile('manual-own.pdf');
  });

  test('not the owner → 404 (submission lookup is user-scoped)', async () => {
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-del.pdf')).expect(404);
    expect(r.body.error).toBe('NOT_FOUND');
  });

  test('filename not in documents → 404 DOCUMENT_NOT_FOUND', async () => {
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [{ documents: DOCS }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-nope.pdf')).expect(404);
    expect(r.body.error).toBe('DOCUMENT_NOT_FOUND');
  });

  test('path traversal attempt is basenamed away → 404', async () => {
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [{ documents: DOCS }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/..%2F..%2Fsecret.pdf')).expect(404);
    expect(['DOCUMENT_NOT_FOUND', 'NOT_FOUND']).toContain(r.body.error);
  });

  test('requires auth → 401', async () => {
    await request(app()).get('/api/manual/m1/documents/manual-del.pdf').expect(401);
  });
});

describe('POST /api/admin/manual/:id/delivery-docs — admin delivery upload', () => {
  test('appends an admin delivery doc the customer can later download', async () => {
    let saved = null;
    db.__routeQuery([
      ['SELECT documents FROM manual_submissions WHERE id = $1', { rows: [{ documents: [DOCS[0]] }] }],
      ['UPDATE manual_submissions SET documents', (text, params) => { saved = JSON.parse(params[0]); return { rows: [] }; }],
    ]);
    const r = await asAdmin(request(app()).post('/api/admin/manual/m1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.filename).toMatch(/^manual-.+\.pdf$/);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ uploaded_by: 'admin', type: 'delivery', originalname: 'result.pdf', filename: r.body.filename });
    dropFile(r.body.filename);
  });

  test('unknown submission → 404 and the uploaded file is cleaned up', async () => {
    db.__routeQuery([
      ['SELECT documents FROM manual_submissions WHERE id = $1', { rows: [] }],
    ]);
    const before = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
    await asAdmin(request(app()).post('/api/admin/manual/nope/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(404);
    const after = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
    expect(after).toBe(before);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await asAdmin(request(app()).post('/api/admin/manual/m1/delivery-docs')).expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('non-admin → 403', async () => {
    await asUser(request(app()).post('/api/admin/manual/m1/delivery-docs'))
      .attach('file', Buffer.from('%PDF-1.4 delivery'), 'result.pdf')
      .expect(403);
  });
});

describe('DELETE /api/admin/manual/:id — admin delete with file cleanup', () => {
  test('deletes the row and its files from disk', async () => {
    putFile('manual-del.pdf', 'PDF-DELIVERY');
    let deleted = false;
    db.__routeQuery([
      ['SELECT documents FROM manual_submissions WHERE id = $1', { rows: [{ documents: DOCS }] }],
      ['DELETE FROM manual_submissions', () => { deleted = true; return { rows: [] }; }],
    ]);
    const r = await asAdmin(request(app()).delete('/api/admin/manual/m1')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(deleted).toBe(true);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'manual-del.pdf'))).toBe(false);
  });

  test('unknown submission → 404', async () => {
    db.__routeQuery([
      ['SELECT documents FROM manual_submissions WHERE id = $1', { rows: [] }],
    ]);
    await asAdmin(request(app()).delete('/api/admin/manual/nope')).expect(404);
  });

  test('non-admin → 403', async () => {
    await asUser(request(app()).delete('/api/admin/manual/m1')).expect(403);
  });
});

describe('GET /api/history — delivery files only, no work details', () => {
  test('only orders/manual submissions WITH admin delivery files appear; customer files and detail fields stay out', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [
        { id: 'o1', documents: JSON.stringify([
          { filename: 'order-own.pdf', originalname: 'my-doc.pdf', uploaded_by: 'customer' },
          { filename: 'delivery-x.pdf', originalname: 'cert.pdf', uploaded_by: 'admin' },
        ]), created_at: '2026-10-20T10:00:00Z', service_name: 'Birth Certificate', service_name_bn: 'জন্ম সনদ' },
        { id: 'o2', documents: JSON.stringify([
          { filename: 'order-only-own.pdf', originalname: 'only-mine.pdf', uploaded_by: 'customer' },
        ]), created_at: '2026-10-21T10:00:00Z', service_name: 'No Delivery Yet', service_name_bn: 'ডেলিভারি হয়নি' },
        { id: 'o3', documents: JSON.stringify([
          { filename: 'delivery-z.pdf', originalname: 'nid.pdf', uploaded_by: 'admin' },
        ]), created_at: '2026-10-19T10:00:00Z', service_name: 'NID Replica', service_name_bn: 'এনআইডি রেপ্লিকা' },
      ] }],
      ['FROM manual_submissions m LEFT JOIN services', { rows: [
        { id: 'm1', documents: [{ filename: 'manual-y.pdf', originalname: 'res.pdf', uploaded_by: 'admin' }], created_at: '2026-10-21T09:00:00Z', service_name: 'Manual Svc', service_name_bn: 'ম্যানুয়াল সেবা' },
        { id: 'm2', documents: [{ filename: 'manual-own2.pdf', originalname: 'mine.pdf', uploaded_by: 'customer' }], created_at: '2026-10-21T11:00:00Z', service_name: 'Manual No Delivery', service_name_bn: 'ম্যানুয়াল ডেলিভারি হয়নি' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.ok).toBe(true);
    // o2 (no delivery file) and m2 (no delivery file) are excluded even
    // though they are the newest records; newest-first among the rest.
    expect(r.body.items.map(i => i.id)).toEqual(['m1', 'o1', 'o3']);
    const byId = Object.fromEntries(r.body.items.map(i => [i.id, i]));
    // the order carries ONLY its delivery file, not the customer's upload
    expect(byId.o1.documents).toHaveLength(1);
    expect(byId.o1.documents[0]).toMatchObject({ filename: 'delivery-x.pdf', url: '/orders/o1/documents/delivery-x.pdf' });
    expect(byId.m1.documents[0].url).toBe('/manual/m1/documents/manual-y.pdf');
    expect(byId.o3.documents[0].url).toBe('/orders/o3/documents/delivery-z.pdf');
    // no detail fields leak into History items
    for (const it of r.body.items) {
      expect(it.status).toBeUndefined();
      expect(it.price).toBeUndefined();
      expect(it.ack_no).toBeUndefined();
      expect(it.admin_note).toBeUndefined();
    }
    // every source query was scoped to the caller
    const scoped = db.query.mock.calls.filter(c => /FROM (orders|manual_submissions)/.test(c[0]));
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    for (const c of scoped) expect(c[1][0]).toBe('u1');
  });

  test('empty account → empty list, still ok', async () => {
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body).toMatchObject({ ok: true, items: [] });
  });

  test('requires auth → 401', async () => {
    await request(app()).get('/api/history').expect(401);
  });
});

describe('PUT /api/admin/manual/:id — outcome notifications on transition', () => {
  function putHandlers(prevStatus, newStatus) {
    return [
      ['SELECT user_id, service_id, status FROM manual_submissions', { rows: [{ user_id: 'u1', service_id: 7, status: prevStatus }] }],
      ['UPDATE manual_submissions SET', { rows: [{ id: 'm1', status: newStatus }] }],
      ['SELECT name_bn, name FROM services', { rows: [{ name_bn: 'পাসপোর্ট সেবা', name: 'Passport' }] }],
    ];
  }

  test('processing → completed: customer gets WhatsApp + push with the service label', async () => {
    db.__routeQuery(putHandlers('processing', 'completed'));
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed' }).expect(200);
    expect(r.body.status).toBe('completed');
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted.mock.calls[0][2]).toBe('পাসপোর্ট সেবা');
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });

  test('re-save with the SAME status (note edit) → no re-notify', async () => {
    db.__routeQuery(putHandlers('completed', 'completed'));
    await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'completed', admin_note: 'note' }).expect(200);
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('new → rejected: push only, no WhatsApp success wording anywhere', async () => {
    db.__routeQuery(putHandlers('new', 'rejected'));
    await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'rejected' }).expect(200);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
  });
});
