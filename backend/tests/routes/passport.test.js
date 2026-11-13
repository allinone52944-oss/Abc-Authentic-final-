// Route tests for backend/routes/passport.js (integrated
// Passport engine, 2026-11-13).
// The page used to be a standalone offline tool (no backend,
// Create → download as a local blob, free). It now calls
// POST /create BEFORE the download, and the download happens
// only after this call succeeds.
// Money rules under test (same discipline as land-khatian /
// engineChargeGate):
//   - price comes ONLY from the services table (engine_id
//     'passport'), per-user user_services override wins
//   - price 0 → free, but the order is still recorded
//   - price > 0 → wallet charged + completed order created
//   - insufficient balance → 402, no charge, no order
//   - access disabled → 403
//   - an idempotency_key replay never charges twice
//   - already-paid ref (concurrent retry) → no second charge
//   - missing passport_no → 400 BAD_INPUT
//   - unauthenticated → 401
// Price 30 below is a TEST FIXTURE ONLY, not a decided
// service price (migration 058 deliberately sets price 0;
// the admin sets the price in Admin → Services).
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
const passportRouter = require('../../routes/passport');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/passport', passportRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

function baseRoutes(extra = []) {
  return [
    ...extra, // per-test overrides win over the defaults below
    ['FROM orders WHERE', { rows: [] }],
    ['FROM services WHERE', { rows: [{ id: 13, price: 30 }] }],
    ['FROM user_services WHERE', { rows: [] }],
    ['FROM users WHERE', { rows: [{ balance: 500 }] }],
    ['FROM service_credits', { rows: [] }],
    ['FROM transactions WHERE', { rows: [] }],
    ['wallet_apply', { rows: [{ balance: 470 }] }],
    ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
  ];
}

const walletCalls = () => db.__client.query.mock.calls.filter((c) => String(c[0]).includes('wallet_apply'));
const orderInserts = () => db.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO orders'));

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
  db.__routeQuery(baseRoutes());
});

describe('GET /api/passport/price', () => {
  test('requires auth → 401', async () => {
    await request(app()).get('/api/passport/price').expect(401);
  });
  test('price + balance → 200 (land-khatian shape)', async () => {
    const r = await withUser(request(app()).get('/api/passport/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, engineId: 'passport', price: 30, balance: 500, serviceId: 13, allowed: true });
  });
  test('per-user override price wins', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).get('/api/passport/price')).expect(200);
    expect(r.body.price).toBe(15);
  });
  test('access disabled → allowed false (create then 403s)', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).get('/api/passport/price')).expect(200);
    expect(r.body.allowed).toBe(false);
  });
  test('no services row → price 0 AND admin missing-price alert fires (audit #17)', async () => {
    _resetForTests(); // the alert is throttled once per engine per hour
    db.__routeQuery(baseRoutes([
      ['FROM services WHERE', { rows: [] }],
    ]));
    const r = await withUser(request(app()).get('/api/passport/price')).expect(200);
    expect(r.body).toMatchObject({ ok: true, price: 0, serviceId: null, allowed: true });
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(push.notifyAdmins.mock.calls[0][1]).toContain('passport');
  });
});

describe('POST /api/passport/create', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/passport/create')
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-401' }).expect(401);
  });
  test('BAD_INPUT: missing passport_no → 400, no charge, no order', async () => {
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ idempotency_key: 't-pp-bad' }).expect(400);
    expect(r.body).toMatchObject({ error: 'BAD_INPUT' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('price > 0 → 200, charged 30, completed order + history', async () => {
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(1);
    expect(orderInserts()).toHaveLength(1);
    const ins = orderInserts()[0];
    expect(ins[1]).toContain('completed');
    expect(ins[1]).toContain(30); // price
    expect(ins[1]).toContain('t-pp-1'); // idempotency_key
    expect(String(ins[1][3])).toContain('EJ0762655'); // passport number in order data (JSON param)
    expect(push.notifyUser).toHaveBeenCalled();
  });
  test('price 0 → 200, charged 0, wallet untouched, order still recorded', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM services WHERE', { rows: [{ id: 13, price: 0 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-0' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(1);
    expect(orderInserts()[0][1]).toContain(0); // price 0
  });
  test('insufficient balance → 402, no charge, no order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM users WHERE', { rows: [{ balance: 10 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-402' }).expect(402);
    expect(r.body).toMatchObject({ error: 'INSUFFICIENT_BALANCE' });
    expect(r.body.message).toContain('পর্যাপ্ত ব্যালেন্স নেই');
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('access disabled → 403, no charge, no order', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: null, access_enabled: false }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-403' }).expect(403);
    expect(r.body).toMatchObject({ error: 'SERVICE_ACCESS_DISABLED' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('per-user override charged, not the table price', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM user_services WHERE', { rows: [{ custom_price: 15, access_enabled: true }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-ovr' }).expect(200);
    expect(r.body.charged).toBe(15);
  });
  test('idempotency replay → stored outcome, no second charge', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM orders WHERE', { rows: [{ id: 'o1', price: 30, status: 'completed' }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-1' }).expect(200);
    expect(r.body).toMatchObject({ duplicate: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(0);
  });
  test('already-paid ref (concurrent retry) → no second charge, order still recorded', async () => {
    db.__routeQuery(baseRoutes([
      ['FROM transactions WHERE', { rows: [{ '?column?': 1 }] }],
    ]));
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655', idempotency_key: 't-pp-dup' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(0);
    expect(orderInserts()).toHaveLength(1);
  });
  test('no idempotency key → server generates one, still charges once', async () => {
    const r = await withUser(request(app()).post('/api/passport/create'))
      .send({ passport_no: 'EJ0762655' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 30, orderId: 'o1' });
    expect(walletCalls()).toHaveLength(1);
    const key = orderInserts()[0][1].find((v) => typeof v === 'string' && v.startsWith('passport-'));
    expect(key).toBeTruthy();
  });
});
