// Route tests for backend/routes/bdris-apply.js (wallet charging).
// Covers the security fix: client-supplied idempotency_key (≤64 chars)
// builds a stable wallet ref instead of a fresh Date.now() each retry.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const bdrisRouter = require('../../routes/bdris-apply');
const push = require('../../utils/push');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bdris-apply', bdrisRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

beforeEach(() => { db.__reset(); push.notifyAdmins.mockClear(); });

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

describe('POST/GET/DELETE /api/bdris-apply/applications (আবেদনের সার্ভার রেকর্ড)', () => {
  test('record a submitted application → 201, idempotent on (user, ack)', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: 'টেস্ট' }).expect(201);
    expect(r.body.application.ack_no).toBe('265530312');
    const ins = db.query.mock.calls.find((c) => /INSERT INTO bdris_applications/.test(c[0]));
    expect(ins[0]).toMatch(/ON CONFLICT \(user_id, ack_no\) DO NOTHING/);
    expect(ins[1]).toEqual(['u1', '265530312', 'টেস্ট']);
  });

  test('missing ack_no → 400', async () => {
    await withUser(request(app()).post('/api/bdris-apply/applications')).send({}).expect(400);
  });

  test('own list + own delete by ack number', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [{ id: 'a1', ack_no: '123' }] }],
      ['DELETE FROM bdris_applications', { rows: [{ id: 'a1' }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications')).expect(200);
    expect(r.body.applications).toHaveLength(1);
    // the customer's own list shows submitted applications only —
    // failure records are an admin-side trace
    const listQ = db.query.mock.calls.find((c) => /FROM bdris_applications/.test(c[0]) && !/DELETE/.test(c[0]));
    expect(listQ[0]).toContain("status = 'submitted'");
    await withUser(request(app()).delete('/api/bdris-apply/applications/123')).expect(200);
    const del = db.query.mock.calls.find((c) => /DELETE FROM bdris_applications/.test(c[0]));
    expect(del[1]).toEqual(['u1', '123']); // always scoped to the caller
  });

  test('failure report → failed record with FAIL- marker + admin push', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'f1', created_at: 'x' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications/failure'))
      .send({ name: 'টেস্ট আবেদনকারী', reason: 'সার্ভার ব্যস্ত' }).expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'f1' });
    const ins = db.query.mock.calls.find((c) => /INSERT INTO bdris_applications/.test(c[0]));
    expect(ins[0]).toContain("'failed'");
    expect(ins[1][0]).toBe('u1');
    expect(ins[1][1]).toMatch(/^FAIL-[0-9A-F]{8}$/);
    expect(ins[1][3]).toBe('সার্ভার ব্যস্ত');
    expect(push.notifyAdmins).toHaveBeenCalledTimes(1);
  });

  test('failure report requires auth → 401', async () => {
    await request(app()).post('/api/bdris-apply/applications/failure')
      .send({ name: 'x', reason: 'y' }).expect(401);
    expect(push.notifyAdmins).not.toHaveBeenCalled();
  });
});
