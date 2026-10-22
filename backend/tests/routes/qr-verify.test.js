// Route tests for backend/routes/qr-verify.js (QR + Photo
// verification). The gateway adapter is mocked — no real gateway
// calls, no real money. Money rules under test:
//   - wallet is charged ONLY on a gateway-verified match
//   - subject_ref is OPTIONAL (owner's decision, 2026-10-21):
//     QR + photo alone are enough to verify
//   - a completed idempotency_key replays from the stored order
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/qr-photo-verify/adapter', () => ({
  verify: jest.fn(),
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
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const auth = require('../../auth');
const qrRouter = require('../../routes/qr-verify');
const adapter = require('../../../engines/qr-photo-verify/adapter');
const wa = require('../../utils/whatsapp');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/qr-verify', qrRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ORDERS_DIR = '/opt/all-in-one-abc-authentic/uploads/orders';

function baseRoutes(extra = []) {
  return [
    ['FROM orders WHERE user_id', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 200 }] }],
    ['FROM settings WHERE', { rows: [{ value: { api_key: 'test-key' } }] }],
    ...extra,
  ];
}

function postVerify(req, { subject = 'NID-123', idem = 'idem-1', withFiles = true } = {}) {
  let r = req.post('/api/qr-verify/verify');
  if (withFiles) {
    r = r.attach('photo', PNG, 'photo.png').attach('qr_image', PNG, 'qr.png');
  }
  if (subject !== null) r = r.field('subject_ref', subject);
  if (idem !== null) r = r.field('idempotency_key', idem);
  return withUser(r);
}

beforeEach(() => {
  db.__reset();
  adapter.verify.mockReset();
  wa.notifyServiceCompleted.mockClear();
  wa.notifyServiceFailed.mockClear();
  push.notifyAdmins.mockClear();
  delete process.env.QR_GATEWAY_API_KEY;
  if (qrRouter.__resetKeyCache) qrRouter.__resetKeyCache();
});

describe('GET /api/qr-verify/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/qr-verify/price').expect(401);
  });

  test('service price + balance → 200', async () => {
    db.__routeQuery(baseRoutes());
    const r = await withUser(request(app()).get('/api/qr-verify/price')).expect(200);
    expect(r.body).toEqual({ ok: true, allowed: true, price: 50, balance: 200, serviceId: 20 });
  });
});

describe('POST /api/qr-verify/verify — guards before any gateway call', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/qr-verify/verify').expect(401);
  });

  test('missing files → 400 MISSING_FILES, gateway not called', async () => {
    db.__routeQuery(baseRoutes());
    const r = await postVerify(request(app()), { withFiles: false }).expect(400);
    expect(r.body.error).toBe('MISSING_FILES');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('non-image file → 400 NOT_AN_IMAGE, gateway not called', async () => {
    db.__routeQuery(baseRoutes());
    const r = await withUser(request(app()).post('/api/qr-verify/verify'))
      .attach('photo', PNG, 'evil.exe')
      .attach('qr_image', PNG, 'qr.png')
      .field('subject_ref', 'NID-123')
      .field('idempotency_key', 'idem-x')
      .expect(400);
    expect(r.body.error).toBe('NOT_AN_IMAGE');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('no subject_ref → still verifies on QR + photo alone (optional field)', async () => {
    let insertParams = null;
    db.__routeQuery(baseRoutes([
      ['FROM transactions WHERE', { rows: [] }],
      ['wallet_apply', () => ({ rows: [{ balance: 150 }] })],
      ['INSERT INTO orders', (text, params) => { insertParams = params; return { rows: [{ id: 'o11' }] }; }],
      ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
      ['UPDATE orders SET documents', { rows: [] }],
    ]));
    adapter.verify.mockResolvedValue({
      ok: true, verified: true, message: 'Verification completed successfully',
      charged: 30, remainingBalance: 440,
    });
    const r = await postVerify(request(app()), { subject: null, idem: 'idem-11' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, verified: true, charged: 50, orderId: 'o11' });
    expect(adapter.verify).toHaveBeenCalledTimes(1);
    // no subject was given → the order records subject_ref: null
    expect(JSON.parse(insertParams[2]).subject_ref).toBeNull();
    const fp = path.join(ORDERS_DIR, 'delivery-qr-idem-11.pdf');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  test('access disabled → 403 SERVICE_ACCESS_DISABLED', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [{ access_enabled: false }] }],
    ]);
    const r = await postVerify(request(app())).expect(403);
    expect(r.body.error).toBe('SERVICE_ACCESS_DISABLED');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('insufficient balance → 402, gateway not called', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]);
    const r = await postVerify(request(app())).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('gateway key not configured → 503 GATEWAY_NOT_CONFIGURED, adapter not called', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 200 }] }],
      ['FROM settings WHERE', { rows: [] }],
    ]);
    const r = await postVerify(request(app())).expect(503);
    expect(r.body.error).toBe('GATEWAY_NOT_CONFIGURED');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('duplicate idempotency_key → stored outcome, gateway NOT called again', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', {
        rows: [{ id: 'o7', price: 50, data: {}, documents: JSON.stringify([{ type: 'delivery', filename: 'delivery-qr-idem-1.pdf' }]) }],
      }],
    ]);
    const r = await postVerify(request(app())).expect(200);
    expect(r.body).toMatchObject({ ok: true, verified: true, duplicate: true, orderId: 'o7', charged: 50 });
    expect(r.body.receipt).toContain('delivery-qr-idem-1.pdf');
    expect(adapter.verify).not.toHaveBeenCalled();
  });
});

describe('POST /api/qr-verify/verify — gateway outcomes', () => {
  test('gateway transport error → 502 GATEWAY_ERROR, no charge, no order', async () => {
    let charged = false; let ordered = false;
    db.__routeQuery(baseRoutes([
      ['wallet_apply', () => { charged = true; return { rows: [] }; }],
      ['INSERT INTO orders', () => { ordered = true; return { rows: [] }; }],
    ]));
    adapter.verify.mockResolvedValue({ ok: false, error: 'GATEWAY_UNREACHABLE: timeout' });
    const r = await postVerify(request(app())).expect(502);
    expect(r.body.error).toBe('GATEWAY_ERROR');
    expect(charged).toBe(false);
    expect(ordered).toBe(false);
  });

  test('gateway says no match → 422 NOT_VERIFIED, no charge, failed order + failure receipt + notifications', async () => {
    let charged = false; let insertSql = null; let insertParams = null; let updatedDocs = null;
    db.__routeQuery(baseRoutes([
      ['wallet_apply', () => { charged = true; return { rows: [] }; }],
      ['INSERT INTO orders', (text, params) => { insertSql = text; insertParams = params; return { rows: [{ id: 'oF1' }] }; }],
      ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
      ['UPDATE orders SET documents', (text, params) => { updatedDocs = params[0]; return { rows: [] }; }],
    ]));
    adapter.verify.mockResolvedValue({
      ok: true, verified: false, message: 'Record not found', charged: 0, remainingBalance: 440,
    });
    const r = await postVerify(request(app()), { idem: 'idem-f1' }).expect(422);
    expect(r.body.error).toBe('NOT_VERIFIED');
    expect(r.body.charged).toBe(0);
    expect(r.body.orderId).toBe('oF1');
    // the customer sees a Bengali reason, never the raw gateway text
    expect(r.body.message).toContain('কোনো রেকর্ড পাওয়া যায়নি');
    expect(charged).toBe(false);
    // a FAILED order is recorded (no charge) with the failure receipt
    expect(insertSql).toContain("'failed'");
    expect(insertSql).toMatch(/ON CONFLICT \(user_id, idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);
    expect(JSON.parse(insertParams[2]).verified).toBe(false);
    expect(r.body.receipt).toContain('/api/orders/oF1/documents/delivery-qr-failed-idem-f1.pdf');
    const docs = JSON.parse(updatedDocs);
    expect(docs[0]).toMatchObject({ type: 'delivery', filename: 'delivery-qr-failed-idem-f1.pdf', originalname: 'qr-verification-failed-receipt.pdf' });
    const fp = path.join(ORDERS_DIR, 'delivery-qr-failed-idem-f1.pdf');
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp).subarray(0, 5).toString()).toBe('%PDF-');
    fs.unlinkSync(fp);
    // customer WhatsApp + admin push both fired exactly once
    expect(wa.notifyServiceFailed).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
  });

  test('duplicate idempotency_key of a FAILED attempt → stored 422 + receipt, gateway NOT called again', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', {
        rows: [{ id: 'oF9', price: 0, status: 'failed', data: {}, documents: JSON.stringify([{ type: 'delivery', filename: 'delivery-qr-failed-idem-1.pdf' }]) }],
      }],
    ]);
    const r = await postVerify(request(app())).expect(422);
    expect(r.body).toMatchObject({ verified: false, duplicate: true, orderId: 'oF9', charged: 0 });
    expect(r.body.receipt).toContain('delivery-qr-failed-idem-1.pdf');
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
  });

  test('verified → charge once + order (partial-index SQL) + receipt stored', async () => {
    let charged = false; let insertSql = null; let updatedDocs = null;
    db.__routeQuery(baseRoutes([
      ['FROM transactions WHERE', { rows: [] }],
      ['wallet_apply', () => { charged = true; return { rows: [{ balance: 150 }] }; }],
      ['INSERT INTO orders', (text) => { insertSql = text; return { rows: [{ id: 'o9' }] }; }],
      ['SELECT documents FROM orders', { rows: [{ documents: '[]' }] }],
      ['UPDATE orders SET documents', (text, params) => { updatedDocs = params[0]; return { rows: [] }; }],
    ]));
    adapter.verify.mockResolvedValue({
      ok: true, verified: true, message: 'Verification completed successfully',
      charged: 30, remainingBalance: 440,
    });
    const r = await postVerify(request(app()), { idem: 'idem-9' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, verified: true, charged: 50, orderId: 'o9' });
    expect(r.body.receipt).toContain('/api/orders/o9/documents/delivery-qr-idem-9.pdf');
    expect(charged).toBe(true);
    expect(insertSql).toMatch(/ON CONFLICT \(user_id, idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);
    // adapter received the settings key + both buffers
    expect(adapter.verify).toHaveBeenCalledTimes(1);
    const args = adapter.verify.mock.calls[0][0];
    expect(args.apiKey).toBe('test-key');
    expect(Buffer.isBuffer(args.photo.buffer)).toBe(true);
    expect(Buffer.isBuffer(args.qr.buffer)).toBe(true);
    // receipt became the order's delivery document (→ History)
    const docs = JSON.parse(updatedDocs);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: 'delivery', filename: 'delivery-qr-idem-9.pdf', uploaded_by: 'admin', originalname: 'qr-verification-receipt.pdf' });
    const fp = path.join(ORDERS_DIR, 'delivery-qr-idem-9.pdf');
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp).subarray(0, 5).toString()).toBe('%PDF-');
    fs.unlinkSync(fp);
    // customer WhatsApp + admin push both fired exactly once
    expect(wa.notifyServiceCompleted).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
  });
});
