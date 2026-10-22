// Route tests for stored engine delivery copies (migration 035) and
// their appearance in /api/history. Certificate / death-verify engines
// stream PDFs to the browser and keep no record — the engine pages now
// report a copy to POST /api/engine-jobs so the delivery file stays in
// the customer's History (owner-downloadable, admin can delete).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
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
const { customerEngineJobs, adminEngineJobs } = require('../../routes/engine-jobs');
const userRouter = require('../../routes/user');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

const UPLOAD_DIR = '/opt/all-in-one-abc-authentic/uploads/engine-jobs';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/engine-jobs', customerEngineJobs);
  a.use('/api/admin/engine-jobs', adminEngineJobs);
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
  wa.notifyServiceFailed.mockClear();
  push.notifyAdmins.mockClear();
  push.notifyUser.mockClear();
});

function dirCount() {
  try { return fs.readdirSync(UPLOAD_DIR).length; } catch (_) { return 0; }
}
function dropFile(name) {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (_) {}
}

describe('POST /api/engine-jobs — report a delivery copy', () => {
  test('stores the PDF and the record', async () => {
    let insertParams = null;
    db.__routeQuery([
      ['INSERT INTO engine_jobs', (text, params) => { insertParams = params; return { rows: [{ id: 'j1' }] }; }],
    ]);
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'bdris-certificate')
      .field('ref_no', '12345678901234567')
      .field('name', 'Test Name')
      .field('idempotency_key', 'bdris-certificate-12345678901234567')
      .attach('file', Buffer.from('%PDF-1.4 cert'), 'Certificate_123.pdf')
      .expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'j1' });
    expect(insertParams[0]).toBe('u1');
    expect(insertParams[1]).toBe('bdris-certificate');
    expect(insertParams[4]).toMatch(/^engine-.+\.pdf$/);
    expect(fs.existsSync(path.join(UPLOAD_DIR, insertParams[4]))).toBe(true);
    dropFile(insertParams[4]);
  });

  test('duplicate report → 200 duplicate, no second file kept', async () => {
    db.__routeQuery([
      ['INSERT INTO engine_jobs', { rows: [] }],
    ]);
    const before = dirCount();
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'death-verify')
      .field('ref_no', '999')
      .field('idempotency_key', 'death-verify-999')
      .attach('file', Buffer.from('%PDF-1.4 cert'), 'Death_999.pdf')
      .expect(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true });
    expect(dirCount()).toBe(before);
  });

  test('unknown engine → 400 BAD_ENGINE and no file kept', async () => {
    const before = dirCount();
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'bdris-apply')
      .attach('file', Buffer.from('%PDF-1.4 x'), 'x.pdf')
      .expect(400);
    expect(r.body.error).toBe('BAD_ENGINE');
    expect(dirCount()).toBe(before);
  });

  test('non-PDF file → 400', async () => {
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'bdris-certificate')
      .attach('file', Buffer.from('plain text'), 'x.txt');
    expect(r.status).toBe(400);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'bdris-certificate')
      .expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('requires auth → 401', async () => {
    await request(app()).post('/api/engine-jobs').expect(401);
  });
});

describe('POST /api/engine-jobs/failure — record a failed verification', () => {
  const failBody = {
    engine_id: 'bdris-certificate', ref_no: '12345678901234567',
    reason: 'Record not found', idempotency_key: 'bdris-certificate-fail-sess1',
  };

  test('records a failed row + failure receipt + notifies customer and admins', async () => {
    let insertSql = null; let insertParams = null;
    db.__routeQuery([
      ['SELECT id FROM engine_jobs WHERE user_id', { rows: [] }],
      ['INSERT INTO engine_jobs', (text, params) => { insertSql = text; insertParams = params; return { rows: [{ id: 'f1' }] }; }],
    ]);
    const r = await asUser(request(app()).post('/api/engine-jobs/failure'))
      .send(failBody).expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'f1', receipt: '/api/engine-jobs/f1/file' });
    expect(insertSql).toContain("'failed'");
    expect(insertParams[4]).toMatch(/^engine-fail-.+\.pdf$/);
    // the stored reason is the mapped Bengali line, never raw engine text
    expect(insertParams[6]).toContain('কোনো রেকর্ড পাওয়া যায়নি');
    const fp = path.join(UPLOAD_DIR, insertParams[4]);
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp).subarray(0, 5).toString()).toBe('%PDF-');
    dropFile(insertParams[4]);
    expect(wa.notifyServiceFailed).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
  });

  test('duplicate failure report → stored outcome, no second record, no re-notify', async () => {
    db.__routeQuery([
      ['SELECT id FROM engine_jobs WHERE user_id', { rows: [{ id: 'f9' }] }],
      ['INSERT INTO engine_jobs', () => { throw new Error('must not insert'); }],
    ]);
    const r = await asUser(request(app()).post('/api/engine-jobs/failure'))
      .send(failBody).expect(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true, id: 'f9', receipt: '/api/engine-jobs/f9/file' });
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
  });

  test('unknown engine → 400; missing idempotency_key → 400', async () => {
    await asUser(request(app()).post('/api/engine-jobs/failure'))
      .send({ ...failBody, engine_id: 'bdris-apply' }).expect(400);
    await asUser(request(app()).post('/api/engine-jobs/failure'))
      .send({ engine_id: 'death-verify', ref_no: '9' }).expect(400);
  });

  test('a later SUCCESS report in the same session supersedes the failure record', async () => {
    let deleteParams = null;
    db.__routeQuery([
      ['INSERT INTO engine_jobs', { rows: [{ id: 'j9' }] }],
      ['DELETE FROM engine_jobs', (text, params) => { deleteParams = params; return { rows: [{ filename: 'engine-fail-gone.pdf' }] }; }],
    ]);
    const r = await asUser(request(app()).post('/api/engine-jobs'))
      .field('engine_id', 'bdris-certificate')
      .field('ref_no', '12345678901234567')
      .field('idempotency_key', 'bdris-certificate-sess1')
      .attach('file', Buffer.from('%PDF-1.4 cert'), 'Certificate_123.pdf')
      .expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'j9' });
    expect(deleteParams[2]).toBe('bdris-certificate-fail-sess1');
  });
});

describe('GET /api/engine-jobs/:id/file — owner download', () => {
  const FN = 'engine-testdl.pdf';
  beforeEach(() => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, FN), 'PDF-CERT-COPY');
  });
  afterEach(() => dropFile(FN));

  test('owner downloads the stored copy', async () => {
    db.__routeQuery([
      ['FROM engine_jobs WHERE id = $1 AND user_id = $2', { rows: [{ filename: FN, originalname: 'Certificate_1.pdf' }] }],
    ]);
    const r = await asUser(request(app()).get('/api/engine-jobs/j1/file')).expect(200);
    expect(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.text).toContain('PDF-CERT-COPY');
  });

  test('not the owner → 404', async () => {
    db.__routeQuery([
      ['FROM engine_jobs WHERE id = $1 AND user_id = $2', { rows: [] }],
    ]);
    await asUser(request(app()).get('/api/engine-jobs/j1/file')).expect(404);
  });
});

describe('admin engine-jobs', () => {
  test('list returns jobs for admin, 403 for users', async () => {
    db.__routeQuery([
      ['FROM engine_jobs j JOIN users', { rows: [{ id: 'j1', engine_id: 'death-verify', ref_no: '999', subject_name: 'X', created_at: '2026-10-21T00:00:00Z', user_name: 'U', user_phone: '01' }] }],
    ]);
    const r = await asAdmin(request(app()).get('/api/admin/engine-jobs')).expect(200);
    expect(r.body.jobs).toHaveLength(1);
    await asUser(request(app()).get('/api/admin/engine-jobs')).expect(403);
  });

  test('delete removes record and file; unknown id → 404', async () => {
    const FN = 'engine-todel.pdf';
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, FN), 'PDF');
    db.__routeQuery([
      ['DELETE FROM engine_jobs', { rows: [{ filename: FN }] }],
    ]);
    const r = await asAdmin(request(app()).delete('/api/admin/engine-jobs/j1')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(fs.existsSync(path.join(UPLOAD_DIR, FN))).toBe(false);

    db.__routeQuery([
      ['DELETE FROM engine_jobs', { rows: [] }],
    ]);
    await asAdmin(request(app()).delete('/api/admin/engine-jobs/nope')).expect(404);
  });
});

describe('GET /api/history — engine deliveries are included', () => {
  test('certificate + death jobs appear as delivery files; BDRIS applications do not exist as a source', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [] }],
      ['FROM manual_submissions m LEFT JOIN services', { rows: [] }],
      ['FROM engine_jobs', { rows: [
        { id: 'j1', engine_id: 'bdris-certificate', subject_name: 'Rahim', filename: 'engine-a.pdf', originalname: 'Certificate_1.pdf', created_at: '2026-10-21T08:00:00Z' },
        { id: 'j2', engine_id: 'death-verify', subject_name: 'Karim', filename: 'engine-b.pdf', originalname: 'Death_2.pdf', created_at: '2026-10-21T09:00:00Z' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items.map(i => i.id)).toEqual(['j2', 'j1']);
    expect(r.body.items[0].title).not.toContain('ব্যর্থ');
    expect(r.body.items[0].kind).toBe('engine');
    expect(r.body.items[0].title).toContain('মৃত্যু সনদ');
    expect(r.body.items[1].title).toContain('জন্ম সনদ');
    expect(r.body.items[1].documents[0].url).toBe('/engine-jobs/j1/file');
    // history must not query BDRIS applications at all
    const bdrisQueries = db.query.mock.calls.filter(c => /bdris_applications/.test(c[0]));
    expect(bdrisQueries).toHaveLength(0);
  });

  test('a failed engine job appears in history marked ব্যর্থ with its receipt', async () => {
    db.__routeQuery([
      ['FROM orders o LEFT JOIN services', { rows: [] }],
      ['FROM manual_submissions m LEFT JOIN services', { rows: [] }],
      ['FROM engine_jobs', { rows: [
        { id: 'jF', engine_id: 'death-verify', subject_name: '', filename: 'engine-fail-x.pdf', originalname: 'verification-failed-receipt.pdf', created_at: '2026-10-22T09:00:00Z', outcome: 'failed' },
      ] }],
    ]);
    const r = await asUser(request(app()).get('/api/history')).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].title).toContain('ব্যর্থ');
    expect(r.body.items[0].documents[0].url).toBe('/engine-jobs/jF/file');
  });
});
