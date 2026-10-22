// Route tests for backend/routes/nid.js (NID replica engine).
// The engine adapter is mocked — no Python, no real PDFs.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/nid-replica/adapter', () => ({
  extractFields: jest.fn(),
  buildCard: jest.fn(),
}));
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const nidRouter = require('../../routes/nid');
const adapter = require('../../../engines/nid-replica/adapter');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/nid-engine', nidRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const PDF_BUF = Buffer.from('%PDF-1.4 fake-bytes');

beforeEach(() => {
  db.__reset();
  adapter.extractFields.mockReset();
  adapter.buildCard.mockReset();
  wa.notifyServiceCompleted.mockClear();
  wa.notifyServiceFailed.mockClear();
  push.notifyAdmins.mockClear();
});

describe('GET /api/nid-engine/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/nid-engine/price').expect(401);
  });

  test('default service price and user balance → 200', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-engine/price')).expect(200);
    expect(r.body).toEqual({ ok: true, allowed: true, price: 50, balance: 120, serviceId: 10 });
  });

  test('custom price override → 200 with custom price', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ custom_price: 30, access_enabled: true }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-engine/price')).expect(200);
    expect(r.body).toEqual({ ok: true, allowed: true, price: 30, balance: 120, serviceId: 10 });
  });

  test('access disabled in user_services → 200 with allowed: false', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
      ['FROM users WHERE', { rows: [{ balance: 120 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/nid-engine/price')).expect(200);
    expect(r.body).toEqual({ ok: true, allowed: false, price: 0, balance: 120, serviceId: 10 });
  });
});

describe('POST /api/nid-engine/extract', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-engine/extract').expect(401);
  });

  test('no file → 400 NO_FILE', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract')).expect(400);
    expect(r.body.error).toBe('NO_FILE');
  });

  test('non-PDF extension → 400 NOT_A_PDF', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'evil.exe').expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('spoofed MIME (pdf name, text/plain) → 400 NOT_A_PDF (MIME-map fix)', async () => {
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, { filename: 'spoof.pdf', contentType: 'text/plain' })
      .expect(400);
    expect(r.body.error).toBe('NOT_A_PDF');
    expect(adapter.extractFields).not.toHaveBeenCalled();
  });

  test('valid PDF → 200 with jobId/fields/images', async () => {
    adapter.extractFields.mockResolvedValue({
      ok: true, jobId: 'job1', fields: { name: 'Rahim' }, images: ['img1'],
    });
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(200);
    expect(r.body).toMatchObject({ ok: true, jobId: 'job1', fields: { name: 'Rahim' } });
    expect(adapter.extractFields).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(adapter.extractFields.mock.calls[0][0])).toBe(true);
    expect(adapter.extractFields.mock.calls[0][1]).toBe('u1');
  });

  test('adapter failure → 422 with its error code', async () => {
    adapter.extractFields.mockResolvedValue({ ok: false, error: 'BAD_PDF' });
    const r = await withUser(request(app()).post('/api/nid-engine/extract'))
      .attach('pdf', PDF_BUF, 'form.pdf').expect(422);
    expect(r.body.error).toBe('BAD_PDF');
    // admins are pushed (pattern visibility); the customer is
    // NOT WhatsApp-spammed for a retryable bad scan
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
  });
});

describe('POST /api/nid-engine/build', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/nid-engine/build').send({}).expect(401);
  });

  test.each([
    ['missing jobId', { fields: {} }],
    ['missing fields', { jobId: 'j1' }],
    ['fields not object', { jobId: 'j1', fields: 'nope' }],
    ['empty body', {}],
  ])('%s → 400 INVALID_REQUEST', async (_l, body) => {
    const r = await withUser(request(app()).post('/api/nid-engine/build')).send(body).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST');
  });

  test('service access disabled → 403 SERVICE_ACCESS_DISABLED', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ access_enabled: false }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: { name: 'R' } }).expect(403);
    expect(r.body.error).toBe('SERVICE_ACCESS_DISABLED');
  });

  test('insufficient balance → 402 INSUFFICIENT_BALANCE', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: { name: 'R' } }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(adapter.buildCard).not.toHaveBeenCalled();
  });

  test('JOB_NOT_FOUND → 404', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'JOB_NOT_FOUND' });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: {} }).expect(404);
    expect(r.body.error).toBe('JOB_NOT_FOUND');
    // a stale job id is a session error, not a service failure
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
    expect(push.notifyAdmins).not.toHaveBeenCalled();
  });

  test('NOT_YOUR_JOB → 403', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'NOT_YOUR_JOB' });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: {} }).expect(403);
    expect(r.body.error).toBe('NOT_YOUR_JOB');
  });

  test('other adapter error → 422', async () => {
    db.__routeQuery([
      ['FROM services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]);
    adapter.buildCard.mockResolvedValue({ ok: false, error: 'RENDER_FAILED' });
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: {} }).expect(422);
    expect(r.body.error).toBe('RENDER_FAILED');
    // a real build failure notifies the customer + the admins
    expect(wa.notifyServiceFailed).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
  });

  test('happy path with wallet debit and order creation → 200 application/pdf', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let walletDebitCalled = false;
    let orderInsertCalled = false;

    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 40 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 100 }] }],
      ['FROM transactions WHERE', { rows: [] }],
      ['wallet_apply', () => { walletDebitCalled = true; return { rows: [{ balance: 60 }] }; }],
      ['INSERT INTO orders', () => { orderInsertCalled = true; return { rows: [] }; }],
    ]);

    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: { name: 'R' } }).expect(200);

    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('nid-card.pdf');
    expect(walletDebitCalled).toBe(true);
    expect(orderInsertCalled).toBe(true);
  });

  test('already paid job → no double debit on download retry', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let walletDebitCalled = false;

    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 40 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 100 }] }],
      ['FROM transactions WHERE', { rows: [{ id: 99 }] }], // already paid
      ['wallet_apply', () => { walletDebitCalled = true; return { rows: [] }; }],
    ]);

    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j1', fields: { name: 'R' } }).expect(200);

    expect(r.headers['content-type']).toContain('application/pdf');
    expect(walletDebitCalled).toBe(false);
  });
});

describe('POST /api/nid-engine/build — delivery copy stored for History', () => {
  const fs = require('fs');
  const path = require('path');
  const ORDERS_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';
  const FN = 'delivery-nid-j9.pdf';

  test('generated PDF is stored as the order delivery file', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let updatedDocs = null;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 40 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 100 }] }],
      ['FROM transactions WHERE', { rows: [] }],
      ['wallet_apply', { rows: [{ balance: 60 }] }],
      ['INSERT INTO orders', { rows: [] }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 'o9', documents: '[]' }] }],
      ['UPDATE orders SET documents', (text, params) => { updatedDocs = params[0]; return { rows: [] }; }],
    ]);
    const r = await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j9', fields: { name: 'R' } }).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(updatedDocs).toBeTruthy();
    const docs = JSON.parse(updatedDocs);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ filename: FN, uploaded_by: 'admin', type: 'delivery', originalname: 'nid-card.pdf' });
    const fp = path.join(ORDERS_DIR, FN);
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp).toString()).toBe('%PDF-1.4 card');
    fs.unlinkSync(fp);
  });

  test('order insert targets the PARTIAL idempotency index (migration 019)', async () => {
    // Production regression: idx_orders_user_idem is created
    // WHERE idempotency_key IS NOT NULL. A bare
    // ON CONFLICT (user_id, idempotency_key) cannot infer a partial
    // index — real PostgreSQL rejects it and the order is never
    // recorded. The mock DB cannot reproduce that, so pin the SQL.
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let insertSql = null;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 40 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 100 }] }],
      ['FROM transactions WHERE', { rows: [] }],
      ['wallet_apply', { rows: [{ balance: 60 }] }],
      ['INSERT INTO orders', (text) => { insertSql = text; return { rows: [] }; }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 'o9', documents: '[]' }] }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]);
    await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j9', fields: { name: 'R' } }).expect(200);
    expect(insertSql).toBeTruthy();
    expect(insertSql).toMatch(/ON CONFLICT \(user_id, idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);
    const fp = path.join(ORDERS_DIR, FN);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  test('retry does not duplicate the delivery file entry', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 card');
    adapter.buildCard.mockResolvedValue({ ok: true, pdfBuffer: pdfBytes });
    let updateCalled = false;
    db.__routeQuery([
      ['FROM services WHERE', { rows: [{ id: 10, price: 40 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 100 }] }],
      ['FROM transactions WHERE', { rows: [{ id: 99 }] }],
      ['INSERT INTO orders', { rows: [] }],
      ['SELECT id, documents FROM orders WHERE', { rows: [{ id: 'o9', documents: JSON.stringify([{ filename: FN, uploaded_by: 'admin', type: 'delivery' }]) }] }],
      ['UPDATE orders SET documents', () => { updateCalled = true; return { rows: [] }; }],
    ]);
    await withUser(request(app()).post('/api/nid-engine/build'))
      .send({ jobId: 'j9', fields: { name: 'R' } }).expect(200);
    expect(updateCalled).toBe(false);
  });
});
