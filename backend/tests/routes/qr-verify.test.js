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
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
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

// Stateful wallet ledger for hold tests (audit #9): the mock DB is
// stateless, but production Postgres remembers the hold. These
// handlers simulate it — wallet_apply debits record the hold, and
// the ledger lookups then report it, so the post-gateway
// already-paid check and the release see the hold exactly as the
// real DB would. `movements` records every wallet_apply call
// (amount/type/ref) so tests can prove the net movement is ৳0 on
// failure and exactly one debit on success.
// Bug-hunt F1 — the ledger also models the RELEASE: a release
// writes a 'release-<ref>' refund row but leaves the debit rows
// 'approved' (exactly like production). The debit check and the
// release-marker check are separate queries; hasApprovedCharge
// combines them in JS (standing charge = debit rows AND no
// release row), while payForService's duplicate check sees the
// debit rows alone (a stale duplicate still throws).
function holdLedger({ ref, price }) {
  const state = { held: false, released: false, movements: [] };
  return {
    state,
    routes: [
      ['wallet_apply', (text, params) => {
        state.movements.push({ amount: params[1], type: params[2], ref: params[3] });
        if (params[1] < 0) state.held = true;
        if (typeof params[3] === 'string' && params[3].indexOf('release-') === 0) state.released = true;
        return { rows: [{ balance: 150 }] };
      }],
      [(text) => text.includes('SELECT 1 FROM transactions'), (text, params) => {
        const isReleaseQ = (params || []).some((p) => typeof p === 'string' && p.indexOf('release-') === 0);
        const found = isReleaseQ ? state.released : state.held;
        return { rows: found ? [{ '1': 1 }] : [] };
      }],
      [(text) => text.includes('SELECT trxid, amount FROM transactions'), () => ({
        rows: state.held ? [{ trxid: ref, amount: -price }] : [],
      })],
    ],
  };
}

// Standard routes for hold tests (explicit array — NOT baseRoutes,
// so the stateful ledger handlers above win over the generic
// 'FROM transactions WHERE' route).
function holdRoutes(ledger, extra = []) {
  return [
    ...ledger.routes,
    ['FROM orders WHERE user_id', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 200 }] }],
    ['FROM settings WHERE', { rows: [{ value: { api_key: 'test-key' } }] }],
    ...extra,
  ];
}

beforeEach(() => {
  db.__reset();
  adapter.verify.mockReset();
  wa.notifyServiceCompleted.mockClear();
  wa.notifyServiceFailed.mockClear();
  push.notifyAdmins.mockClear();
  push.notifyUser.mockClear();
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

  test('balance drops between pre-check and hold → 402 before gateway, QR untouched (audit #9)', async () => {
    // The pre-check reads ৳200 (enough), but the hold's locked
    // re-read sees ৳10 — the race the old code only caught AFTER
    // the gateway had charged its fee and consumed the QR. The
    // hold fails here instead, before any gateway cost.
    db.__routeQuery([
      [(text) => text.includes('FROM users WHERE') && text.includes('FOR UPDATE'), { rows: [{ balance: 10 }] }],
      ['FROM orders WHERE user_id', { rows: [] }],
      ['FROM services WHERE', { rows: [{ id: 20, price: 50 }] }],
      ['FROM user_services WHERE', { rows: [] }],
      ['FROM users WHERE', { rows: [{ balance: 200 }] }],
      ['FROM settings WHERE', { rows: [{ value: { api_key: 'test-key' } }] }],
    ]);
    const r = await postVerify(request(app()), { idem: 'idem-drop' }).expect(402);
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
  test('gateway error (ok:false) → 502 + failed order recorded, same-key retry replays it (no second gateway call)', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-1', price: 50 });
    let failedData = null;
    db.__routeQuery(holdRoutes(ledger, [
      ['INSERT INTO orders', (text, params) => { failedData = JSON.parse(params[2]); return { rows: [{ id: 'oT1' }] }; }],
    ]));
    adapter.verify.mockResolvedValue({ ok: false, error: 'GATEWAY_UNREACHABLE: timeout' });
    const r = await postVerify(request(app())).expect(502);
    expect(r.body.error).toBe('GATEWAY_ERROR');
    expect(r.body.orderId).toBe('oT1');
    // Bug-hunt F1 — the failed outcome is recorded, so a retry
    // replays it instead of re-entering the gateway with a
    // released hold behind it.
    expect(failedData).toMatchObject({ verified: false, gateway_error: true });
    // Audit #9: the hold is taken before the gateway call and
    // released when the gateway fails — the customer pays ৳0 net.
    expect(ledger.state.movements).toHaveLength(2);
    expect(ledger.state.movements[0]).toMatchObject({ amount: -50, type: 'debit' });
    expect(ledger.state.movements[1]).toMatchObject({ amount: 50, type: 'refund' });
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
    // Retry with the same key → replays the stored failure.
    db.__routeQuery([
      ['FROM orders WHERE user_id', { rows: [{ id: 'oT1', price: 0, status: 'failed', data: JSON.stringify(failedData), documents: '[]' }] }],
    ]);
    const r2 = await postVerify(request(app())).expect(422);
    expect(r2.body).toMatchObject({ verified: false, duplicate: true, orderId: 'oT1', charged: 0 });
    expect(r2.body.message).toContain('সার্ভারে সমস্যা');
    expect(adapter.verify).toHaveBeenCalledTimes(1);
  });

  test('gateway transport throw → 502 + failed order recorded, same-key retry replays it', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-throw', price: 50 });
    let failedData = null;
    db.__routeQuery(holdRoutes(ledger, [
      ['INSERT INTO orders', (text, params) => { failedData = JSON.parse(params[2]); return { rows: [{ id: 'oT2' }] }; }],
    ]));
    adapter.verify.mockRejectedValue(new Error('connect timeout'));
    const r = await postVerify(request(app()), { idem: 'idem-throw' }).expect(502);
    expect(r.body.error).toBe('GATEWAY_ERROR');
    expect(r.body.orderId).toBe('oT2');
    expect(failedData).toMatchObject({ verified: false, gateway_error: true });
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
    db.__routeQuery([
      ['FROM orders WHERE user_id', { rows: [{ id: 'oT2', price: 0, status: 'failed', data: JSON.stringify(failedData), documents: '[]' }] }],
    ]);
    const r2 = await postVerify(request(app()), { idem: 'idem-throw' }).expect(422);
    expect(r2.body).toMatchObject({ verified: false, duplicate: true, orderId: 'oT2', charged: 0 });
    expect(r2.body.message).toContain('সার্ভারে সমস্যা');
    expect(adapter.verify).toHaveBeenCalledTimes(1);
  });

  test('order insert keeps failing, then same-key retry → 409 STALE_ATTEMPT, gateway NOT called again, never free', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-norec2', price: 50 });
    db.__routeQuery(holdRoutes(ledger, [
      ['INSERT INTO orders', () => ({ rows: [] })],
    ]));
    adapter.verify.mockResolvedValue({
      ok: true, verified: true, message: 'Verification completed successfully',
      charged: 30, remainingBalance: 440,
    });
    const r1 = await postVerify(request(app()), { idem: 'idem-norec2' }).expect(500);
    expect(r1.body.error).toBe('ORDER_RECORD_FAILED');
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
    // Bug-hunt F1 — the hold was released and this ref can never
    // hold again (ledger trxid uniqueness): fail fast instead of
    // pretending the money is held and handing out a free result.
    const r2 = await postVerify(request(app()), { idem: 'idem-norec2' }).expect(409);
    expect(r2.body.error).toBe('STALE_ATTEMPT');
    expect(adapter.verify).toHaveBeenCalledTimes(1);
    expect(ledger.state.movements).toHaveLength(2); // hold + release only
  });

  test('concurrent release during the gateway call → post-gateway stale duplicate is a charge failure, never free', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-race', price: 50 });
    let failedData = null;
    db.__routeQuery(holdRoutes(ledger, [
      ['INSERT INTO orders', (text, params) => { failedData = JSON.parse(params[2]); return { rows: [{ id: 'oRace' }] }; }],
    ]));
    // A concurrent same-key request releases the hold while this
    // request is inside the gateway call: the release marker lands
    // and the refund is recorded, as the real ledger would.
    adapter.verify.mockImplementation(async () => {
      ledger.state.released = true;
      ledger.state.movements.push({ amount: 50, type: 'refund', ref: 'release-qr-verify-idem-race' });
      return { ok: true, verified: true, message: 'Verification completed successfully', charged: 30, remainingBalance: 440 };
    });
    const r = await postVerify(request(app()), { idem: 'idem-race' }).expect(402);
    expect(r.body.error).toBe('CHARGE_FAILED_AFTER_GATEWAY');
    expect(r.body.orderId).toBe('oRace');
    expect(failedData).toMatchObject({ verified: false, charge_failed_after_gateway: true });
    // The hold was released by the concurrent request, so no
    // second charge was taken: debit + refund = ৳0 net.
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
  });

  test('gateway says no match → 422 NOT_VERIFIED, hold released (net ৳0), failed order + failure receipt + notifications', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-f1', price: 50 });
    let insertSql = null; let insertParams = null; let updatedDocs = null;
    db.__routeQuery(holdRoutes(ledger, [
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
    // Audit #9: the hold is taken before the gateway call and
    // released when it does not verify — the customer pays ৳0 net.
    expect(ledger.state.movements).toHaveLength(2);
    expect(ledger.state.movements[0]).toMatchObject({ amount: -50, type: 'debit' });
    expect(ledger.state.movements[1]).toMatchObject({ amount: 50, type: 'refund' });
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
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
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    // C2: the failed push must NOT promise the receipt in
    // History — a failed order's file reaches the customer
    // through no path (download gate: NOT_DELIVERED_YET).
    const failedPushMsg = push.notifyUser.mock.calls[0][3];
    expect(failedPushMsg).toContain('কোনো টাকা কাটা হয়নি');
    expect(failedPushMsg).not.toContain('ইতিহাসে');
    expect(failedPushMsg).not.toContain('ইতিহাস');
    expect(wa.notifyServiceCompleted).not.toHaveBeenCalled();
  });

  test('non-image file → Bengali message paired with the code (no bare code to the customer)', async () => {
    db.__routeQuery(baseRoutes());
    const r = await withUser(request(app()).post('/api/qr-verify/verify'))
      .attach('photo', PNG, 'evil.exe')
      .attach('qr_image', PNG, 'qr.png')
      .field('subject_ref', 'NID-123')
      .field('idempotency_key', 'idem-msg')
      .expect(400);
    expect(r.body.error).toBe('NOT_AN_IMAGE');
    expect(r.body.message).toContain('JPG/PNG');
  });

  test('failed replay keeps the stored reason (not a generic message)', async () => {
    db.__routeQuery([
      ['FROM orders WHERE user_id', {
        rows: [{ id: 'oF9', price: 0, status: 'failed',
          data: JSON.stringify({ reason: 'Record not found', verified: false }),
          documents: JSON.stringify([{ type: 'delivery', filename: 'delivery-qr-failed-idem-1.pdf' }]) }],
      }],
    ]);
    const r = await postVerify(request(app())).expect(422);
    expect(r.body).toMatchObject({ verified: false, duplicate: true, orderId: 'oF9', charged: 0 });
    expect(r.body.message).toContain('কোনো রেকর্ড পাওয়া যায়নি');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  test('order insert keeps failing after charge → 500 ORDER_RECORD_FAILED, hold released (net ৳0), never a record-less success', async () => {
    const ledger = holdLedger({ ref: 'qr-verify-idem-norec', price: 50 });
    db.__routeQuery(holdRoutes(ledger, [
      ['INSERT INTO orders', () => ({ rows: [] })],
    ]));
    adapter.verify.mockResolvedValue({
      ok: true, verified: true, message: 'Verification completed successfully',
      charged: 30, remainingBalance: 440,
    });
    const r = await postVerify(request(app()), { idem: 'idem-norec' }).expect(500);
    expect(r.body.error).toBe('ORDER_RECORD_FAILED');
    expect(r.body.message).toContain('রেকর্ড তৈরি হয়নি');
    // Audit #9: no order row means no charge either — the hold is
    // released instead of leaving money taken with a 500.
    expect(ledger.state.movements).toHaveLength(2);
    expect(ledger.state.movements.reduce((s, m) => s + m.amount, 0)).toBe(0);
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
    const ledger = holdLedger({ ref: 'qr-verify-idem-9', price: 50 });
    let insertSql = null; let updatedDocs = null;
    db.__routeQuery(holdRoutes(ledger, [
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
    // Audit #9: the hold taken before the gateway call IS the
    // charge — exactly one wallet debit, no second charge after
    // the gateway verifies.
    expect(ledger.state.movements).toHaveLength(1);
    expect(ledger.state.movements[0]).toMatchObject({ amount: -50, type: 'debit', ref: 'qr-verify-idem-9' });
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
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
    expect(wa.notifyServiceFailed).not.toHaveBeenCalled();
  });
});
