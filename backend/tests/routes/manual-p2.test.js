// P2 second sweep (2026-11-03): manual queue search, /mine note leak
// closure + delivery visibility, rejected WhatsApp notification.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceRejected: jest.fn().mockResolvedValue({ ok: true }),
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
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/manual';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/manual', customerManual);
  a.use('/api/admin/manual', adminManual);
  return a;
}
const userTok = () => auth.signAccess({ id: 'u1', role: 'user' });
const adminTok = () => auth.signAccess({ id: 'a1', role: 'admin' });
const asUser = (r) => r.set('Authorization', 'Bearer ' + userTok());
const asAdmin = (r) => r.set('Authorization', 'Bearer ' + adminTok());

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
});

const DOCS = [
  { filename: 'manual-own.pdf', originalname: 'my-nid.pdf', uploaded_by: 'customer' },
  { filename: 'manual-del.pdf', originalname: 'result.pdf', uploaded_by: 'admin', type: 'delivery' },
];

describe('P2 items 1+6: /mine hides admin notes and undelivered admin files', () => {
  test('processing submission: own file lists, admin file does not; SQL has no admin_note', async () => {
    db.__routeQuery([
      ['FROM manual_submissions m', { rows: [{ id: 'm1', status: 'processing', created_at: '2026-11-01T00:00:00Z', admin_note: 'secret', documents: DOCS, service_name_bn: 'ম্যানুয়াল সেবা', service_name: 'Manual', doc_count: 2 }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/mine')).expect(200);
    expect(r.body.list).toHaveLength(1);
    expect(r.body.list[0].documents).toHaveLength(1);
    expect(r.body.list[0].documents[0].uploaded_by).toBe('customer');
    const q = db.query.mock.calls.find((c) => /FROM manual_submissions m/.test(c[0]));
    expect(q[0]).not.toContain('admin_note');
  });

  test('completed submission: admin delivery file lists', async () => {
    db.__routeQuery([
      ['FROM manual_submissions m', { rows: [{ id: 'm1', status: 'completed', created_at: '2026-11-01T00:00:00Z', documents: DOCS, service_name_bn: 'ম্যানুয়াল সেবা', service_name: 'Manual', doc_count: 2 }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/mine')).expect(200);
    expect(r.body.list[0].documents).toHaveLength(2);
  });

  test('admin file download on a processing submission → 403', async () => {
    db.__routeQuery([
      ['WHERE id = $1 AND user_id = $2', { rows: [{ status: 'processing', documents: DOCS }] }],
    ]);
    const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-del.pdf')).expect(403);
    expect(r.body.error).toBe('NOT_DELIVERED_YET');
  });

  test('admin file download on a completed submission → 200', async () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const fp = path.join(UPLOAD_DIR, 'manual-del.pdf');
    fs.writeFileSync(fp, 'PDF-DELIVERY');
    try {
      db.__routeQuery([
        ['WHERE id = $1 AND user_id = $2', { rows: [{ status: 'completed', documents: DOCS }] }],
      ]);
      const r = await asUser(request(app()).get('/api/manual/m1/documents/manual-del.pdf')).expect(200);
      expect(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.text).toContain('PDF-DELIVERY');
    } finally {
      try { fs.unlinkSync(fp); } catch (_) {}
    }
  });
});

describe('P2 item 10: admin manual queue search + total', () => {
  test('q filters name/phone/number and total counts the same filter', async () => {
    db.__routeQuery([
      ['COUNT(*) FROM manual_submissions', { rows: [{ count: '3' }] }],
      ['FROM manual_submissions m', { rows: [
        { id: 'm1', status: 'new', user_name: 'Rahim', user_phone: '0171', doc_count: 0, name_bn: 'রহিম' },
      ] }],
    ]);
    const r = await asAdmin(request(app()).get('/api/admin/manual?q=rahim&status=new')).expect(200);
    expect(r.body.total).toBe(3);
    expect(r.body.list).toHaveLength(1);
    const q = db.query.mock.calls.find((c) => /FROM manual_submissions m/.test(c[0]) && /ILIKE/.test(c[0]));
    expect(q).toBeDefined();
    expect(q[1]).toContain('new');
    expect(q[1]).toContain('%rahim%');
  });
});

describe('P2 item 13: rejected manual submission notifies on WhatsApp', () => {
  test('new → rejected: WhatsApp rejected + push, no completed wording', async () => {
    db.__routeQuery([
      ['SELECT user_id, service_id, status, documents, admin_note FROM manual_submissions', { rows: [{ user_id: 'u1', service_id: 7, status: 'new', documents: [] }] }],
      ['UPDATE manual_submissions SET', { rows: [{ id: 'm1', status: 'rejected' }] }],
      ['SELECT name_bn, name FROM services', { rows: [{ name_bn: 'পাসপোর্ট সেবা', name: 'Passport' }] }],
    ]);
    const r = await asAdmin(request(app()).put('/api/admin/manual/m1'))
      .send({ status: 'rejected' }).expect(200);
    expect(r.body.status).toBe('rejected');
    expect(wa.notifyServiceRejected).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceRejected.mock.calls[0][2]).toBe('পাসপোর্ট সেবা');
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });
});
