// FIX-1 regression: BDRIS apply double-charge.
// routes/bdris-apply.js builds the wallet ref from req.body.idempotency_key
// (max 64 chars), falling back to Date.now() only when the key is absent.
// A retried request with the same key must produce the SAME ref so the
// wallet debit is idempotent instead of charging twice.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const bdrisRouter = require('../../routes/bdris-apply');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bdris-apply', bdrisRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

beforeEach(() => { db.__reset(); });

// price 100 for submit; pdf price 50 from settings (so the pdf endpoint charges)
function chargeHandlers() {
  return [
    ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
    ['FROM settings WHERE key', { rows: [{ value: '50' }] }],
    ['wallet_apply', { rows: [{ new_balance: '900' }] }],
  ];
}
function lastWalletRef() {
  const calls = db.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]));
  return calls.length ? calls[calls.length - 1][1][3] : null;
}

describe.each([
  ['/charge/submit', 'bdris-apply-submit'],
  ['/charge/pdf', 'bdris-apply-pdf'],
])('FIX-1 idempotency_key — POST /api/bdris-apply%s', (path, kind) => {
  test('same idempotency_key → identical wallet ref on retry (no double charge)', async () => {
    db.__routeQuery(chargeHandlers());
    const key = 'client-key-abc-123';
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: key }).expect(200);
    const ref1 = lastWalletRef();
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: key }).expect(200);
    const ref2 = lastWalletRef();
    expect(ref1).toBe(`${kind}-${key}-u1`);
    expect(ref2).toBe(ref1);
  });

  test('key longer than 64 chars is truncated to 64', async () => {
    db.__routeQuery(chargeHandlers());
    const long = 'k'.repeat(100);
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: long }).expect(200);
    expect(lastWalletRef()).toBe(`${kind}-${'k'.repeat(64)}-u1`);
  });

  test('missing key → legacy fallback ref (timestamp-based)', async () => {
    db.__routeQuery(chargeHandlers());
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({}).expect(200);
    expect(lastWalletRef()).toMatch(new RegExp(`^${kind}-\\d+-u1$`));
  });

  test('numeric key is coerced to string', async () => {
    db.__routeQuery(chargeHandlers());
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: 98765 }).expect(200);
    expect(lastWalletRef()).toBe(`${kind}-98765-u1`);
  });

  test('different keys → different refs', async () => {
    db.__routeQuery(chargeHandlers());
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: 'aaa' }).expect(200);
    const ref1 = lastWalletRef();
    await withUser(request(app()).post('/api/bdris-apply' + path)).send({ idempotency_key: 'bbb' }).expect(200);
    expect(lastWalletRef()).not.toBe(ref1);
  });
});
