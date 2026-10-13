// Route tests for backend/routes/cashback.js (daily cashback).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const cashbackRouter = require('../../routes/cashback');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/cashback', cashbackRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

const CASHBACK_ON = { rows: [{ value: { enabled: true, percent: 10 } }] };

function baseHandlers({ cashback = CASHBACK_ON, total = '500', redeemed = null } = {}) {
  return [
    ["SELECT value FROM settings WHERE key = 'cashback'", cashback],
    ['COALESCE(SUM(amount), 0) AS total', { rows: [{ total }] }],
    ['FROM daily_cashback_redemptions', redeemed ? { rows: [redeemed] } : { rows: [] }],
  ];
}

beforeEach(() => { db.__reset(); });

describe('GET /api/cashback/today', () => {
  test('disabled config → amount 0, can_redeem false', async () => {
    db.__routeQuery(baseHandlers({ cashback: { rows: [{ value: { enabled: false, percent: 10 } }] } }));
    const r = await withUser(request(app()).get('/api/cashback/today')).expect(200);
    expect(r.body).toMatchObject({ ok: true, enabled: false, cashback_amount: 0, can_redeem: false });
  });

  test('zero percent → hidden (amount 0)', async () => {
    db.__routeQuery(baseHandlers({ cashback: { rows: [{ value: { enabled: true, percent: 0 } }] } }));
    const r = await withUser(request(app()).get('/api/cashback/today')).expect(200);
    expect(r.body.cashback_amount).toBe(0);
    expect(r.body.can_redeem).toBe(false);
  });

  test('enabled with recharges → computed amount, can_redeem true', async () => {
    db.__routeQuery(baseHandlers());
    const r = await withUser(request(app()).get('/api/cashback/today')).expect(200);
    expect(r.body).toMatchObject({
      ok: true, recharge_total: 500, percent: 10, enabled: true,
      cashback_amount: 50, already_redeemed: false, can_redeem: true, coupon_code: null,
    });
  });

  test('already redeemed → coupon_code returned, can_redeem false', async () => {
    db.__routeQuery(baseHandlers({ redeemed: { id: 'd1', coupon_code: 'CB-20261013-AB12', amount: 50 } }));
    const r = await withUser(request(app()).get('/api/cashback/today')).expect(200);
    expect(r.body.already_redeemed).toBe(true);
    expect(r.body.coupon_code).toBe('CB-20261013-AB12');
    expect(r.body.can_redeem).toBe(false);
  });

  test('requires auth → 401', async () => {
    await request(app()).get('/api/cashback/today').expect(401);
  });
});

describe('POST /api/cashback/redeem', () => {
  function redeemHandlers(over = {}) {
    return [
      ["SELECT value FROM settings WHERE key = 'cashback'", over.cashback || CASHBACK_ON],
      ['TO_CHAR', { rows: [{ d: '2026-10-13' }] }],
      ['SELECT id FROM daily_cashback_redemptions WHERE user_id', over.exist || { rows: [] }],
      ['COALESCE(SUM(amount), 0) AS total', { rows: [{ total: over.total === undefined ? '500' : over.total }] }],
      ['INSERT INTO daily_cashback_redemptions', over.insert || {
        rows: [{ coupon_code: 'CB-20261013-AB12', amount: 50, recharge_total: 500, percent: 10 }],
      }],
      ['SELECT balance FROM users WHERE id', { rows: [{ balance: '550' }] }],
    ];
  }

  test('happy path → 200 with coupon code, wallet credited inside transaction', async () => {
    db.__routeQuery(redeemHandlers());
    const r = await withUser(request(app()).post('/api/cashback/redeem')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.coupon_code).toMatch(/^CB-\d{8}-[A-F0-9]{4}$/);
    expect(r.body.amount).toBe(50);
    expect(r.body.balance).toBe(550);
    expect(db.withTransaction).toHaveBeenCalled();
    const wallet = db.__client.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(wallet).toBeDefined();
    expect(wallet[1][3]).toContain('daily-cashback-'); // idempotent ref
  });

  test('double redeem same day → 409 ALREADY_REDEEMED_TODAY', async () => {
    db.__routeQuery(redeemHandlers({ exist: { rows: [{ id: 'd1' }] } }));
    const r = await withUser(request(app()).post('/api/cashback/redeem')).expect(409);
    expect(r.body.error).toBe('ALREADY_REDEEMED_TODAY');
  });

  test('nothing to redeem → 400 NOTHING_TO_REDEEM', async () => {
    db.__routeQuery(redeemHandlers({ total: '0' }));
    const r = await withUser(request(app()).post('/api/cashback/redeem')).expect(400);
    expect(r.body.error).toBe('NOTHING_TO_REDEEM');
  });

  test('race: ON CONFLICT DO NOTHING wins → 409', async () => {
    db.__routeQuery(redeemHandlers({ insert: { rows: [], rowCount: 0 } }));
    const r = await withUser(request(app()).post('/api/cashback/redeem')).expect(409);
    expect(r.body.error).toBe('ALREADY_REDEEMED_TODAY');
  });

  test('requires auth → 401', async () => {
    await request(app()).post('/api/cashback/redeem').expect(401);
  });
});
