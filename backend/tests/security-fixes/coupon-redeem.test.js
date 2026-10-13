// FIX-5 + FIX-15 regression: coupon redeem race + code length guard.
// FIX-5: the whole redeem flow (SELECT ... FOR UPDATE → validate → credit →
// mark redeemed) runs inside db.withTransaction. This file uses the REAL
// db.withTransaction implementation (backend/db.js) with a mocked pg Pool,
// asserting the client actually sees BEGIN/COMMIT on success and
// BEGIN/ROLLBACK (no COMMIT) when the flow throws.
// FIX-15: codes longer than 40 chars → 400 CODE_TOO_LONG before any DB work.
jest.mock('pg', () => {
  const state = { statements: [] };
  const client = {
    query: jest.fn(async (text) => {
      state.statements.push(String(text));
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    on: jest.fn(),
    end: jest.fn(async () => {}),
  };
  return { Pool: jest.fn(() => pool), __mock: { state, client, pool } };
});

const pg = require('pg');
const { __mock } = pg;
const db = require('../../db'); // REAL db.js (pool is the mock above)
const express = require('express');
const request = require('supertest');
const auth = require('../../auth');
const userRouter = require('../../routes/user');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

// Route SQL through the tx client by substring matching.
function setClientHandlers(handlers) {
  __mock.client.query.mockImplementation(async (text, params) => {
    __mock.state.statements.push(String(text));
    for (const [match, resp] of handlers) {
      if (String(text).includes(match)) {
        return typeof resp === 'function' ? await resp(text, params) : resp;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}
beforeEach(() => {
  __mock.state.statements = [];
  __mock.client.query.mockReset();
  __mock.client.release.mockClear();
  setClientHandlers([]);
});

const COUPON = {
  id: 'c1', code: 'SAVE10', amount: '100', percent: null,
  user_id: null, expires_at: null, status: 'active', type: 'recharge',
};
function redeemHandlers(coupon = COUPON) {
  return [
    ['FROM coupons WHERE code', { rows: [coupon] }],
    ['wallet_apply', { rows: [{}] }],
    ['UPDATE coupons SET status', { rows: [], rowCount: 1 }],
    ['SELECT balance FROM users', { rows: [{ balance: '600' }] }],
  ];
}

describe('FIX-5 coupon redeem runs inside a real transaction', () => {
  test('happy path: BEGIN → FOR UPDATE select → COMMIT (no ROLLBACK)', async () => {
    setClientHandlers(redeemHandlers());
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'save10' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, credited: 100 });

    const stmts = __mock.state.statements;
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts[stmts.length - 1]).toBe('COMMIT');
    expect(stmts).not.toContain('ROLLBACK');
    const select = stmts.find((s) => /FROM coupons/.test(s));
    expect(select).toMatch(/FOR UPDATE/); // row lock defeats the race
    expect(__mock.client.release).toHaveBeenCalled();
  });

  test('invalid code → error inside tx → ROLLBACK, never COMMIT', async () => {
    setClientHandlers([['FROM coupons WHERE code', { rows: [] }]]);
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'NOPE' }).expect(404);
    expect(r.body.error).toBe('INVALID_CODE');

    const stmts = __mock.state.statements;
    expect(stmts).toContain('BEGIN');
    expect(stmts).toContain('ROLLBACK');
    expect(stmts).not.toContain('COMMIT');
    expect(__mock.client.release).toHaveBeenCalled();
  });

  test('expired code → 400 EXPIRED_CODE, tx rolled back', async () => {
    const expired = { ...COUPON, expires_at: new Date(Date.now() - 1000).toISOString() };
    setClientHandlers(redeemHandlers(expired));
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'SAVE10' }).expect(400);
    expect(r.body.error).toBe('EXPIRED_CODE');
    expect(__mock.state.statements).toContain('ROLLBACK');
  });

  test("another user's bound coupon → 403 NOT_YOUR_CODE, tx rolled back", async () => {
    setClientHandlers(redeemHandlers({ ...COUPON, user_id: 'someone-else' }));
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'SAVE10' }).expect(403);
    expect(r.body.error).toBe('NOT_YOUR_CODE');
    expect(__mock.state.statements).toContain('ROLLBACK');
  });
});

describe('FIX-15 coupon code length guard', () => {
  test('41-char code → 400 CODE_TOO_LONG, no transaction started', async () => {
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'X'.repeat(41) }).expect(400);
    expect(r.body.error).toBe('CODE_TOO_LONG');
    expect(__mock.state.statements).not.toContain('BEGIN');
  });

  test('exactly 40 chars → passes the guard (reaches DB lookup)', async () => {
    setClientHandlers([['FROM coupons WHERE code', { rows: [] }]]);
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({ code: 'Y'.repeat(40) }).expect(404);
    expect(r.body.error).toBe('INVALID_CODE'); // got past CODE_TOO_LONG
  });

  test('missing code → 400 MISSING_CODE', async () => {
    const r = await withUser(request(app()).post('/api/wallet/coupon'))
      .send({}).expect(400);
    expect(r.body.error).toBe('MISSING_CODE');
  });
});
