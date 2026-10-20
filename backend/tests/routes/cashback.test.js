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
      ['SELECT id, amount', over.list || { rows: over.total === '0' ? [] : [{ id: 'tx1', amount: over.total === undefined ? '500' : over.total }] }],
      ['recharge_ids @>', { rows: [] }],
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
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO daily_cashback_redemptions/.test(c[0]));
    expect(ins).toBeDefined();
    expect(JSON.parse(ins[1][6])).toEqual(['tx1']); // covered recharge ids frozen (migration 031)
  });

  test('claim covers ALL unclaimed recharges combined, not per-recharge', async () => {
    db.__routeQuery(redeemHandlers({
      list: { rows: [{ id: 'tx1', amount: '200' }, { id: 'tx2', amount: '300' }] },
      insert: { rows: [{ coupon_code: 'CB-20261013-AB12', amount: 50, recharge_total: 500, percent: 10 }] },
    }));
    const r = await withUser(request(app()).post('/api/cashback/redeem')).expect(200);
    expect(r.body.amount).toBe(50); // 10% of combined 200+300
    expect(r.body.recharge_total).toBe(500);
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO daily_cashback_redemptions/.test(c[0]));
    expect(JSON.parse(ins[1][6])).toEqual(['tx1', 'tx2']);
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

describe('claim basis — strictly same-day (owner rule)', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '../../routes/cashback.js'), 'utf8');
  test("unclaimed set is limited to today's (Asia/Dhaka) recharges — no carry-over", () => {
    const where = SRC.slice(SRC.indexOf('const UNCLAIMED_WHERE'), SRC.indexOf('const UNCLAIMED_TOTAL_SQL'));
    expect(where).toContain("DATE((created_at AT TIME ZONE 'Asia/Dhaka'))");
    expect(where).toContain('daily_cashback_redemptions');
  });
});

describe('POST /api/cashback/generate', () => {
  function genHandlers(over = {}) {
    return [
      ['FROM transactions', over.rc || { rows: [{ id: 'tx-123', amount: 1000, user_id: 'u1' }] }],
      ['SELECT id FROM coupons WHERE recharge_id', over.exist || { rows: [] }],
      ["SELECT value FROM settings WHERE key = 'cashback'", over.cashback || CASHBACK_ON],
      ['INSERT INTO coupons', over.insert || {
        rows: [{
          id: 'cp-1',
          code: 'CB-ABCD1234',
          percent: 10,
          amount: 100,
          service_id: null,
          user_id: 'u1',
          expires_at: new Date().toISOString(),
          recharge_id: 'tx-123',
          notes: 'recharge:tx-123'
        }],
      }],
    ];
  }

  test('happy path → 201 with coupon code, amount and percent', async () => {
    db.__routeQuery(genHandlers());
    const r = await withUser(request(app()).post('/api/cashback/generate'))
      .send({ recharge_id: 'tx-123' })
      .expect(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.coupon.id).toBe('cp-1');
    expect(r.body.coupon.code).toBe('CB-ABCD1234');
    expect(r.body.coupon.amount).toBe(100);
    expect(r.body.coupon.percent).toBe(10);
    expect(db.withTransaction).toHaveBeenCalled();
  });

  test('missing recharge_id → 400 MISSING_RECHARGE', async () => {
    const r = await withUser(request(app()).post('/api/cashback/generate')).send({}).expect(400);
    expect(r.body.error).toBe('MISSING_RECHARGE');
  });

  test('invalid / unapproved recharge → 400 INVALID_RECHARGE', async () => {
    db.__routeQuery(genHandlers({ rc: { rows: [] } }));
    const r = await withUser(request(app()).post('/api/cashback/generate'))
      .send({ recharge_id: 'tx-unapproved' })
      .expect(400);
    expect(r.body.error).toBe('INVALID_RECHARGE');
  });

  test('already generated for this recharge → 409 ALREADY_GENERATED', async () => {
    db.__routeQuery(genHandlers({ exist: { rows: [{ id: 'cp-exist' }] } }));
    const r = await withUser(request(app()).post('/api/cashback/generate'))
      .send({ recharge_id: 'tx-123' })
      .expect(409);
    expect(r.body.error).toBe('ALREADY_GENERATED');
  });

  test('daily cashback already taken for that day → 409, no coupon created', async () => {
    db.__routeQuery([
      ['FROM transactions', { rows: [{ id: 'tx-123', amount: 1000, user_id: 'u1', day: '2026-10-20' }] }],
      ['FROM daily_cashback_redemptions', { rows: [{ id: 'd1' }] }],
      ...genHandlers(),
    ]);
    const r = await withUser(request(app()).post('/api/cashback/generate'))
      .send({ recharge_id: 'tx-123' })
      .expect(409);
    expect(r.body.error).toBe('ALREADY_GENERATED');
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO coupons/.test(c[0]));
    expect(ins).toBeUndefined();
  });

  test('cashback disabled → 400 CASHBACK_DISABLED', async () => {
    db.__routeQuery(genHandlers({ cashback: { rows: [{ value: { enabled: false, percent: 10 } }] } }));
    const r = await withUser(request(app()).post('/api/cashback/generate'))
      .send({ recharge_id: 'tx-123' })
      .expect(400);
    expect(r.body.error).toBe('CASHBACK_DISABLED');
  });

  test("preserves client query context inside withTransaction", async () => {
    let calledWithCorrectThis = false;
    db.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: function (sql, params) {
          if (this !== client) throw new Error("Unbound client.query called!");
          if (/settings/.test(sql)) {
            calledWithCorrectThis = true;
            return { rows: [{ value: { enabled: true, percent: 10 } }] };
          }
          if (/FROM transactions/.test(sql)) return { rows: [{ id: "tx-ctx", amount: 500, user_id: "u1" }] };
          if (/SELECT id FROM coupons/.test(sql)) return { rows: [] };
          if (/INSERT INTO coupons/.test(sql)) return {
            rows: [{ id: "cp-ctx", code: "CB-CTX", amount: 50, percent: 10, expires_at: new Date().toISOString() }]
          };
          return { rows: [] };
        }
      };
      return fn(client);
    });

    const r = await withUser(request(app()).post("/api/cashback/generate"))
      .send({ recharge_id: "tx-ctx" })
      .expect(201);
    expect(r.body.ok).toBe(true);
    expect(calledWithCorrectThis).toBe(true);
  });

  test('requires auth → 401', async () => {
    await request(app()).post('/api/cashback/generate').send({ recharge_id: 'tx-123' }).expect(401);
  });
});
