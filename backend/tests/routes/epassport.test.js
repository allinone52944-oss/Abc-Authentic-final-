// Route tests for backend/routes/epassport.js (integrated
// E-Passport engine, 2026-11-17) — mirror of
// backend/tests/routes/passport.test.js.
// Money rules under test (same discipline as land-khatian /
// engineChargeGate):
//   - price comes ONLY from the services table (engine_id
//     'epassport'), per-user user_services override wins
//   - price 0 → free, but the order is still recorded
//   - price > 0 → wallet charged + completed order created
//   - insufficient balance → 402, no charge, no order
//   - access disabled → 403
//   - an idempotency_key replay never charges twice
//   - already-paid ref (concurrent retry) → no second charge
//   - missing passport_no → 400 BAD_INPUT
//   - unauthenticated → 401
// Price 30 below is a TEST FIXTURE ONLY, not a decided
// service price (migration 059 deliberately sets price 0;
// the admin sets the price in Admin → Services).
// The passport number below (EP0000001) is a synthetic
// test fixture, not a real document number.
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
const db = require('../../db');
const auth = require('../../auth');
const push = require('../../utils/push');
const { _resetForTests } = require('../../lib/missingPriceAlert');
const epassportRouter = require('../../routes/epassport');
const SAVED_ORDER = { id: 'o1', price: 30, status: 'completed', engine: 'epassport', passport_no: 'EP0000001' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/epassport', epassportRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

function baseRoutes(extra = []) {
  return [
    ...extra, // per-test overrides win over the defaults below
    ['FROM orders WHERE', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 15, price: 30, status: 'active' }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ new_balance: 470 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
  ];
}

const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
const orderInserts = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('GET /api/epassport/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/epassport/price').expect(401);
  });
  test('price + balance → 200 (land-khatian shape)', async () => {
    const r = await withUser(request(app()).get('/api/epassport/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, engineId: 'epassport', price: 30, balance: 500, serviceId: 15, allowed: true });
  });
  test('per-user override price wins', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).get('/api/epassport/price')).expect(200);
    expect(r.body.price).toBe(15);
  });
  test('access disabled → allowed false (create then 403s)', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).get('/api/epassport/price')).expect(200);
    expect(r.body.allowed).toBe(false);
  });
  test('no active services row → unavailable and admin alert', async () => {
    _resetForTests(); // the alert is throttled once per engine per hour
    db.__routeQuery(baseRoutes([
      ['FROM services WHERE', { rows: [] }],
    ]));
    const r = await withUser(request(app()).get('/api/epassport/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, price: 0, serviceId: null, allowed: false });
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins.mock.calls[0][1]).toContain('epassport');
  });
  test('an intentionally inactive service is unavailable without a missing setup alert', async () => {
    db.__routeQuery(baseRoutes([['FROM services WHERE', { rows: [{ id: 15, price: 30, status: 'inactive' }] }]]));
    const r = await withUser(request(app()).get('/api/epassport/price')).expect(200);
    expect(r.body.allowed).toBe(false);
    expect(push.notifyAdmins).not.toHaveBeenCalled();
  });
});

describe('POST /api/epassport/create', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/epassport/create')
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-401' }).expect(401);
  });
  test('BAD_INPUT: missing passport_no → 400, no charge, no order', async () => {
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ idempotency_key: 't-ep-bad' }).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('price > 0 → 200, charged 30, completed order + history', async () => {
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1', balance: 470 });
    expect(walletCalls()).toHaveLength(1);
    expect(orderInserts()).toHaveLength(1);
    const ins = orderInserts()[0];
    expect(ins[1]).toContain('completed');
    expect(ins[1]).toContain(30); // price
    expect(ins[1]).toContain('t-ep-1'); // idempotency_key
    expect(String(ins[1][3])).toContain('EP0000001'); // passport number in order data (JSON param)
    expect(push.notifyAdmins).toHaveBeenCalled();
    expect(push.notifyUser).not.toHaveBeenCalled();
  });
  test('price 0 → 200, charged 0, wallet untouched, order still recorded', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM services WHERE', { rows: [{ id: 15, price: 0, status: 'active' }] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-0' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(1);
    expect(orderInserts()[0][1]).toContain(0); // price 0
  });
  test('insufficient balance → 402, no charge, no order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-402' }).expect(402);
    expect(r.body).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
    expect(r.body.message).toContain('পর্যাপ্ত ব্যালেন্স নেই');
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('access disabled → 403, no charge, no order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-403' }).expect(403);
    expect(r.body).toMatchObject({ error: 'SERVICE_ACCESS_DISABLED' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('per-user override charged, not the table price', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-ovr' }).expect(200);
    expect(r.body.charged).toBe(15);
  });
  test('idempotency replay → stored outcome, no second charge', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: [SAVED_ORDER] }],
      ['FROM services WHERE', { rows: [] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-1' }).expect(200);
    expect(r.body).toMatchObject({ duplicate: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('recovers an earlier debit at its original price even with a low balance', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM transactions WHERE', { rows: [{ amount: '-16.50' }, { amount: '-3.50' }] }],
      ['FROM users WHERE', { rows: [{ balance: 0 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-dup' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 20, orderId: 'o1', balance: 0 });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(1);
  });
  test('missing service stops before the debit and order insert', async () => {
    db.__routeQuery(baseRoutes([['FROM services WHERE', { rows: [] }]]));
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-missing' }).expect(403);
    expect(r.body.error).toBe('SERVICE_UNAVAILABLE');
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('same request key with a different passport does not replay or debit', async () => {
    db.__routeQuery(baseRoutes([['FROM orders WHERE', { rows: [SAVED_ORDER] }]]));
    await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000002', idempotency_key: 't-ep-1' }).expect(409);
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('an order insert failure rolls back the debit and sends no success notification', async () => {
    db.__routeQuery(baseRoutes([['INSERT INTO orders', () => { throw new Error('ORDER_NOT_SAVED'); }]]));
    const actualDb = jest.requireActual('../../db');
    const connect = jest.spyOn(actualDb.pool, 'connect').mockResolvedValue(db.__client);
    db.withTransaction.mockImplementation(actualDb.withTransaction);
    try {
      await withUser(request(app()).post('/api/epassport/create'))
        .send({ passport_no: 'EP0000001', idempotency_key: 't-ep-rollback' }).expect(500);
      const sql = db.__client.query.mock.calls.map(([text]) => text);
      expect(sql[0]).toBe('BEGIN');
      expect(sql.at(-1)).toBe('ROLLBACK');
      expect(sql).not.toContain('COMMIT');
      expect(walletCalls()).toHaveLength(1);
      expect(orderInserts()).toHaveLength(1);
      expect(push.notifyAdmins).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
  test('no idempotency key → server generates one with the epassport- prefix, still charges once', async () => {
    const r = await withUser(request(app()).post('/api/epassport/create'))
      .send({ passport_no: 'EP0000001' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(1);
    const key = orderInserts()[0][1].find((v) => typeof v === 'string' && v.startsWith('epassport-'));
    expect(key).toBeTruthy();
  });
});
