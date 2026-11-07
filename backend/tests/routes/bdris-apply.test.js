// Route tests for backend/routes/bdris-apply.js (wallet charging).
// Covers the security fix: client-supplied idempotency_key (≤64 chars)
// builds a stable wallet ref instead of a fresh Date.now() each retry.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
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
const bdrisRouter = require('../../routes/bdris-apply');
const push = require('../../utils/push');
const storedOriginal = require('../../lib/storedOriginal');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bdris-apply', bdrisRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());

beforeEach(() => { db.__reset(); push.notifyAdmins.mockClear(); push.notifyUser.mockClear(); });

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

  test('2026-10-25 double-charge fix: same key again → no new deduction, token returned', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['FROM transactions', { rows: [{ 1: 1 }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'dup-key-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, alreadyCharged: true });
    expect(typeof r.body.chargeToken).toBe('string');
    expect(r.body.chargeToken.length).toBeGreaterThan(20);
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
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
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', inserted: true }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: 'টেস্ট' }).expect(201);
    expect(r.body.application.ack_no).toBe('265530312');
    const ins = db.query.mock.calls.find((c) => /INSERT INTO bdris_applications/.test(c[0]));
    // ALL-BUGS (i): the conflict clause upgrades the original-PDF
    // flag (OR, never downgrades) instead of DO NOTHING, so a
    // later flag-only re-POST is no longer silently ignored.
    expect(ins[0]).toMatch(/ON CONFLICT \(user_id, ack_no\) DO UPDATE SET/);
    expect(ins[0]).toContain('original_pdf_available = bdris_applications.original_pdf_available OR EXCLUDED.original_pdf_available');
    expect(ins[1]).toEqual(['u1', '265530312', 'টেস্ট', false]);
  });

  test('flag-only re-POST on an existing record → duplicate, flag upgraded, NO repeat notification', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', inserted: false }] }],
      ['FROM bdris_applications WHERE user_id', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', original_pdf_available: true }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: '', original_pdf_available: true }).expect(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.application.original_pdf_available).toBe(true);
    // The name is never blanked by a flag-only re-POST…
    const ins = db.query.mock.calls.find((c) => /INSERT INTO bdris_applications/.test(c[0]));
    expect(ins[0]).not.toMatch(/applicant_name\s*=/);
    // …and the customer is NOT notified again for the same filing.
    expect(push.notifyUser).not.toHaveBeenCalled();
  });

  test('own list carries the original-PDF flag', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [{ id: 'a1', ack_no: '123', original_pdf_available: true }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications')).expect(200);
    expect(r.body.applications).toHaveLength(1);
    expect(r.body.applications[0].original_pdf_available).toBe(true);
    const listQ = db.query.mock.calls.find((c) => /FROM bdris_applications/.test(c[0]));
    expect(listQ[0]).toContain('original_pdf_available');
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
    expect(push.notifyUser).toHaveBeenCalledTimes(1);
  });

  test('failure report requires auth → 401', async () => {
    await request(app()).post('/api/bdris-apply/applications/failure')
      .send({ name: 'x', reason: 'y' }).expect(401);
    expect(push.notifyAdmins).not.toHaveBeenCalled();
  });

  // Audit #39 — every filing also gets an orders row, so it is
  // findable in "আমার অর্ডার" by its tracking number.
  test('audit #39 — submitted application also writes a completed orders row', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', inserted: true }] }],
      ['SELECT id, price FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris', price: 100 }] }],
      ['INSERT INTO orders', { rows: [{ id: 'o1' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: 'টেস্ট' }).expect(201);
    expect(r.body.application.ack_no).toBe('265530312');
    const ord = db.query.mock.calls.find((c) => /INSERT INTO orders/.test(c[0]));
    expect(ord).toBeDefined();
    expect(ord[0]).toContain("ON CONFLICT (user_id, idempotency_key)");
    expect(ord[1][0]).toBe('u1');
    expect(ord[1][1]).toBe('svc-bdris');
    expect(ord[1][2]).toBe('completed');
    expect(JSON.parse(ord[1][3])).toMatchObject({ kind: 'bdris-apply', ack_no: '265530312', applicant_name: 'টেস্ট' });
    expect(ord[1][4]).toBe(100);
    expect(ord[1][5]).toBe('bdris-apply-265530312');
  });

  test('audit #39 — failure report also writes a failed orders row (price 0)', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'f1', created_at: 'x' }] }],
      ['SELECT id, price FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris', price: 100 }] }],
      ['INSERT INTO orders', { rows: [{ id: 'o2' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications/failure'))
      .send({ name: 'টেস্ট আবেদনকারী', reason: 'সার্ভার ব্যস্ত' }).expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'f1' });
    const ord = db.query.mock.calls.find((c) => /INSERT INTO orders/.test(c[0]));
    expect(ord).toBeDefined();
    expect(ord[1][2]).toBe('failed');
    expect(ord[1][4]).toBe(0);
    expect(JSON.parse(ord[1][3]).failure_reason).toBe('সার্ভার ব্যস্ত');
    expect(ord[1][5]).toMatch(/^bdris-apply-FAIL-[0-9A-F]{8}$/);
  });

  test('audit #39 — no active bdris-apply service → filing still succeeds, no orders row', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', inserted: true }] }],
      ['SELECT id, price FROM services WHERE engine_id', { rows: [] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: 'টেস্ট' }).expect(201);
    expect(r.body.application.ack_no).toBe('265530312');
    expect(db.query.mock.calls.filter((c) => /INSERT INTO orders/.test(c[0]))).toHaveLength(0);
  });

  test('bug-hunt F3 — order priced from the ledger amount actually charged (not the services row), charge_ref stored', async () => {
    // Services price is 100, but the submit charge actually took
    // 90 (70 balance + 20 locked credit). The order must show 90.
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'a1', ack_no: '265530312', applicant_name: 'টেস্ট', created_at: 'x', inserted: true }] }],
      ['SELECT id, price FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris', price: 100 }] }],
      ['SELECT trxid, amount FROM transactions', { rows: [
        { trxid: 'bdris-apply-submit-draft-x-submit-u1', amount: -70 },
        { trxid: 'bdris-apply-submit-draft-x-submit-u1:svc', amount: -20 },
      ] }],
      ['INSERT INTO orders', { rows: [{ id: 'o3' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: '265530312', name: 'টেস্ট', charge_key: 'draft-x-submit' }).expect(201);
    expect(r.body.application.ack_no).toBe('265530312');
    const ord = db.query.mock.calls.find((c) => /INSERT INTO orders/.test(c[0]));
    expect(ord).toBeDefined();
    expect(ord[1][2]).toBe('completed');
    expect(ord[1][4]).toBe(90); // ledger total, NOT the services 100
    expect(JSON.parse(ord[1][3]).charge_ref).toBe('bdris-apply-submit-draft-x-submit-u1');
  });

  test('bug-hunt F3 — failed order priced at the submit charge already taken (not ৳0)', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [{ id: 'f1', created_at: 'x' }] }],
      ['SELECT id, price FROM services WHERE engine_id', { rows: [{ id: 'svc-bdris', price: 100 }] }],
      ['SELECT trxid, amount FROM transactions', { rows: [
        { trxid: 'bdris-apply-submit-draft-x-submit-u1', amount: -90 },
      ] }],
      ['INSERT INTO orders', { rows: [{ id: 'o4' }] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications/failure'))
      .send({ name: 'টেস্ট আবেদনকারী', reason: 'সার্ভার ব্যস্ত', charge_key: 'draft-x-submit' }).expect(201);
    expect(r.body).toMatchObject({ ok: true, id: 'f1' });
    const ord = db.query.mock.calls.find((c) => /INSERT INTO orders/.test(c[0]));
    expect(ord).toBeDefined();
    expect(ord[1][2]).toBe('failed');
    expect(ord[1][4]).toBe(90); // the submit charge already ran
    expect(JSON.parse(ord[1][3]).charge_ref).toBe('bdris-apply-submit-draft-x-submit-u1');
  });
});

// Past-applications list (2026-11-07): re-download of one's own
// stored original Form-1 PDF. No new charge — the copy was already
// paid for at submit time. Owner-only + flag + file-on-disk, or 404.
describe('GET /api/bdris-apply/applications/:ackNo/original — stored original re-download', () => {
  const KEY = '999000111';
  const FN = 'bdris-original-' + KEY + '.pdf';
  const FP = path.join(__dirname, '..', '..', '..', 'frontend', FN);
  const PDF = '%PDF-1.4\n' + 'A'.repeat(8100); // over the 8000-byte real-PDF floor
  beforeEach(() => { fs.writeFileSync(FP, PDF); });
  afterEach(() => { try { fs.unlinkSync(FP); } catch {} });

  test('requires auth → 401', async () => {
    await request(app()).get('/api/bdris-apply/applications/' + KEY + '/original').expect(401);
  });

  test('unknown ack → 404 NOT_FOUND', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original')).expect(404);
    expect(r.body.error).toBe('NOT_FOUND');
  });

  test('record without the original flag → 404 PDF_NOT_AVAILABLE', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [{ original_pdf_available: false }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original')).expect(404);
    expect(r.body.error).toBe('PDF_NOT_AVAILABLE');
  });

  test('flagged record but no file on disk → 404 FILE_MISSING', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [{ original_pdf_available: true }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/999000112/original')).expect(404);
    expect(r.body.error).toBe('FILE_MISSING');
  });

  test('owner + flag + file → 200, real PDF bytes, attachment filename', async () => {
    db.__routeQuery([
      ['FROM bdris_applications', { rows: [{ original_pdf_available: true }] }],
    ]);
    const r = await withUser(request(app()).get('/api/bdris-apply/applications/' + KEY + '/original')).expect(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toContain(FN);
    expect(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.text).toContain('%PDF-1.4');
  });

  test('a crafted ack can never escape the originals dir', () => {
    const dir = storedOriginal.originalsDir();
    for (const hostile of ['../../etc/passwd', '/etc/passwd', KEY + '/../../x', '..\\..\\win']) {
      const p = storedOriginal.storedOriginalPath(hostile);
      if (p) expect(p.startsWith(dir + path.sep)).toBe(true);
    }
    expect(storedOriginal.storedOriginalPath('../../etc/passwd')).toBe(null);
    expect(storedOriginal.storedOriginalPath('')).toBe(null);
  });
});

describe('MONEY/PDF cycle 4 (2026-11-03)', () => {
  const dupKeyError = () => {
    const e = new Error('duplicate key value violates unique constraint "transactions_trxid_key"');
    e.code = '23505';
    return e;
  };

  test('C21 submit: concurrent same-key charge (unique violation) → already-charged, not 500', async () => {
    db.__routeQuery([
      ['FROM services WHERE engine_id', { rows: [{ price: '100' }] }],
      ['wallet_apply', () => { throw dupKeyError(); }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/submit'))
      .send({ idempotency_key: 'race-key-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, alreadyCharged: true });
    expect(typeof r.body.chargeToken).toBe('string');
  });

  test('C21 pdf: concurrent same-key charge (unique violation) → already-charged, not 500', async () => {
    db.__routeQuery([
      ["SELECT value FROM settings WHERE key = 'bdris_apply.pdf_price'", { rows: [{ value: 10 }] }],
      ['wallet_apply', () => { throw dupKeyError(); }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/charge/pdf'))
      .send({ idempotency_key: 'pdf-race-1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, charged: 0, alreadyCharged: true });
  });

  test('B6: mixed-form ack is stored canonical digits-only', async () => {
    db.__routeQuery([
      ['INSERT INTO bdris_applications', { rows: [] }],
    ]);
    const r = await withUser(request(app()).post('/api/bdris-apply/applications'))
      .send({ ack_no: 'TRK-1234567890', name: 'টেস্ট' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true });
    const ins = db.query.mock.calls.find((c) => /INSERT INTO bdris_applications/.test(c[0]));
    expect(ins).toBeDefined();
    expect(ins[1][1]).toBe('1234567890');
  });

  test('B6/DELETE: delete matches by canonical digits (legacy raw rows too)', async () => {
    db.__routeQuery([
      ['DELETE FROM bdris_applications', { rows: [{ id: 'a1' }] }],
    ]);
    await withUser(request(app()).delete('/api/bdris-apply/applications/TRK-1234567890')).expect(200);
    const del = db.query.mock.calls.find((c) => /DELETE FROM bdris_applications/.test(c[0]));
    expect(del[0]).toMatch(/regexp_replace\(ack_no/);
    expect(del[1]).toEqual(['u1', '1234567890']);
  });
});
