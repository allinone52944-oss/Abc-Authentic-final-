// FIX-1 regression: BDRIS apply double-charge.
// Submission accepts a general retry key. Original-PDF charges use the
// acknowledgement of an owned application as the stable retry key.
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
// Charging goes through lib/serviceCredits inside a transaction now:
// defaults appended after each test's handlers (see routes/bdris test).
const __origRQ = db.__routeQuery.bind(db);
db.__routeQuery = (handlers = [], fallback) => __origRQ([
  ...handlers,
  ['SELECT id FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris' }] }],
  ['users WHERE id = $1 FOR UPDATE', { rows: [{ balance: 10000 }] }],
], fallback);

function lastWalletRef() {
  const calls = db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]));
  return calls.length ? calls[calls.length - 1][1][3] : null;
}

describe('FIX-1 idempotency_key — POST /api/bdris-apply/charge/submit', () => {
  const path = '/charge/submit';
  const kind = 'bdris-apply-submit';
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

describe('acknowledgement-based original PDF charge retries', () => {
  const path = '/api/bdris-apply/charge/pdf';
  const key = 'pdf-000123456';

  test('the same owned acknowledgement debits once and returns a new receipt on retry', async () => {
    const approved = new Set();
    db.__routeQuery([
      ['FROM bdris_applications', (_, params) => {
        expect(params).toEqual(['u1', '000123456']);
        return { rows: [{ original_pdf_available: true }] };
      }],
      ['SELECT 1 FROM transactions', (_, [, ref]) => ({ rows: approved.has(ref) ? [{}] : [] })],
      ['wallet_apply', (_, [, , , ref]) => {
        approved.add(ref);
        return { rows: [{ new_balance: '950' }] };
      }],
      ...chargeHandlers(),
    ]);
    const first = await withUser(request(app()).post(path)).send({ idempotency_key: key }).expect(200);
    expect(first.body).toMatchObject({ charged: 50, chargeToken: expect.any(String) });
    const retry = await withUser(request(app()).post(path)).send({ idempotency_key: key }).expect(200);
    expect(retry.body).toMatchObject({ charged: 0, alreadyCharged: true, chargeToken: expect.any(String) });
    expect([...approved]).toEqual(['bdris-apply-pdf-' + key + '-u1']);
    expect(db.__client.query.mock.calls.filter(([sql]) => /wallet_apply/.test(sql))).toHaveLength(1);
  });

  test.each([{}, { idempotency_key: 98765 }, { idempotency_key: 'k'.repeat(100) }])(
    'rejects an invalid acknowledgement key before debiting: %j',
    async body => {
      await withUser(request(app()).post(path)).send(body).expect(400);
      expect(lastWalletRef()).toBeNull();
    }
  );
});
