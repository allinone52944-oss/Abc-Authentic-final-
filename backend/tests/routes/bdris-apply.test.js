// Route tests for backend/routes/bdris-apply.js (wallet charging).
// Covers the security fix: client-supplied idempotency_key (≤64 chars)
// builds a stable wallet ref instead of a fresh Date.now() each retry.
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

// Charging now goes through lib/serviceCredits.payForService inside a
// transaction: it needs the service id row and the locked user balance
// row, and the wallet_apply call lands on the transaction client.
// Defaults are appended AFTER each test's own handlers so tests can
// still override (e.g. a zero balance for the insufficient cases).
const __origRQ = db.__routeQuery.bind(db);
db.__routeQuery = (handlers = [], fallback) => __origRQ([
  ...handlers,
  ['SELECT id FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris' }] }],
  ['users WHERE id = $1 FOR UPDATE', { rows: [{ balance: 10000 }] }],
], fallback);

function walletRefOfLastCharge() {
  const call = db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0])).pop();
  return call ? call[1][3] : null;
}

describe('POST /api/bdris-apply/charge/submit', () => {
  test('requires auth → 401', async () => {
    await request(app()).post('/api/bdris-apply/charge/submit').send({}).expect(401);
  });

  test('service missing → 404 SERVICE_NOT_FOUND', async () => {
    db.__routeQuery([['FROM services WHERE engine_id', { rows: [] }]]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit')).send({}).expect(404);
    expect(r.body.error).toBe('SERVICE_NOT_FOUND');
  });

  test('price 0 → free, no wallet hit', async () => {
    db.__routeQuery([['FROM services WHERE engine_id', { rows: [{ price: '0' }] }]]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit')).send({}).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0 });
    expect(db.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('happy path charges the service price', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['wallet_apply', { rows: [{ new_balance: '900' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'job-abc-123' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 100, newBalance: 900 });
  });

  test('security fix: stable idempotency_key in wallet ref', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['wallet_apply', { rows: [{ new_balance: '900' }] }],
    ]);
    await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'job-abc-123' }).expect(200);
    const ref1 = walletRefOfLastCharge();
    expect(ref1).toBe('bdris-apply-submit-job-abc-123-u1');

    // same key again → identical ref (idempotent retry)
    await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'job-abc-123' }).expect(200);
    expect(walletRefOfLastCharge()).toBe(ref1);
  });

  test('idempotency_key truncated to 64 chars', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['wallet_apply', { rows: [{ new_balance: '900' }] }],
    ]);
    const longKey = 'k'.repeat(100);
    await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: longKey }).expect(200);
    const ref = walletRefOfLastCharge();
    expect(ref).toBe('bdris-apply-submit-' + 'k'.repeat(64) + '-u1');
  });

  test('insufficient balance → 402 INSUFFICIENT_BALANCE (Bengali message)', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['users WHERE id = $1 FOR UPDATE', { rows: [{ balance: 0 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'k1' }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(r.body.message).toContain('ব্যালেন্স');
  });
});

describe('POST /api/bdris-apply/charge/pdf', () => {
  function priceHandlers(priceValue) {
    return [
      ["SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price'", { rows: [{ value: priceValue }] }],
      ['wallet_apply', { rows: [{ new_balance: '950' }] }],
    ];
  }

  test('price 0 → free download, no wallet hit', async () => {
    db.__routeQuery(priceHandlers(0));
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/pdf')).send({}).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0 });
  });

  test('charges pdf price with stable ref', async () => {
    db.__routeQuery(priceHandlers(50));
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/pdf'))
      .send({ idempotency_key: 'pdf-job-1' }).expect(200);
    expect(r.body.charged).toBe(50);
    expect(walletRefOfLastCharge()).toBe('bdris-apply-pdf-pdf-job-1-u1');
  });

  test('string-encoded JSON price setting is parsed', async () => {
    db.__routeQuery(priceHandlers('"75"'));
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/pdf'))
      .send({ idempotency_key: 'k' }).expect(200);
    expect(r.body.charged).toBe(75);
  });

  test('insufficient balance → 402', async () => {
    db.__routeQuery([
      ["SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price'", { rows: [{ value: 50 }] }],
      ['users WHERE id = $1 FOR UPDATE', { rows: [{ balance: 0 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/pdf'))
      .send({ idempotency_key: 'k' }).expect(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
  });
});

describe('GET /api/bdris-apply/prices', () => {
  test('returns both prices (no charge)', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '120' }] }],
      ["SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price'", { rows: [{ value: 30 }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/prices')).expect(200);
    expect(r.body).toMatchObject({ ok: true, submitPrice: 120, pdfPrice: 30 });
    expect(db.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('missing service → submitPrice null', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [] }],
      ["SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price'", { rows: [] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/prices')).expect(200);
    expect(r.body.submitPrice).toBeNull();
    expect(r.body.pdfPrice).toBe(0);
  });
});
