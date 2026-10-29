// Route tests for backend/lib/engineChargeGate.js (2026-10-30 charge gate
// for the birth-certificate and death-verify engines).
//
// The gate is tested with a fake downstream (standing in for the engine
// proxy) and mocked db/serviceCredits — no real portal calls, no real
// money. Money rules under test (same discipline as land/qr-verify):
//   - charged ONLY on a successful verification (record found)
//   - failed verify / session error -> no charge, response forwarded
//   - insufficient balance blocks BEFORE any portal lookup, and a
//     charge failure after success withholds the record (402, no leak)
//   - retry of the same attempt (same idempotency_key) never charges
//     twice
//   - preview/PDF without a charged attempt -> 402 before the engine
//     runs; with a charged attempt -> through, no second charge
//   - captcha stays free; unknown engine paths are blocked at the mount
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../lib/serviceCredits', () => ({
  payForService: jest.fn(),
  availableFor: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const serviceCredits = require('../../lib/serviceCredits');
const {
  chargeGate, isVerifySuccess, policyFor,
} = require('../../lib/engineChargeGate');

const ENGINE = 'bdris-certificate';
const MOUNT = '/api/bdris-engine';

// Fake downstream: mimics the engine proxy. `mode` controls the verify
// response; preview/captcha always succeed. Counts calls so tests can
// prove the engine was (or was not) reached.
function downstream(mode, calls) {
  return (req, res) => {
    calls.push(req.url);
    if (req.url === '/api/verify') {
      if (mode === 'success') {
        return res.json({ success: true, data: { brn: '19900101123456789', nameEn: 'Test Person' } });
      }
      if (mode === 'session-error') {
        return res.status(400).json({ success: false, error: 'Session expired.' });
      }
      return res.json({ success: false, error: 'No record found' });
    }
    if (req.url === '/api/captcha') {
      return res.json({ success: true, image: 'data:image/png;base64,xx', sessionId: 'sess-1' });
    }
    return res.json({ success: true, html: '<h1>cert</h1>' });
  };
}

function appWith({ mode = 'success', authed = true, engine = ENGINE, mount = MOUNT, kind = 'birth' } = {}) {
  const calls = [];
  const a = express();
  a.use(express.json());
  if (authed) a.use((req, _res, next) => { req.user = { id: 'u1', role: 'user' }; next(); });
  a.use(mount, chargeGate(engine, kind, mount, { db, serviceCredits }), downstream(mode, calls));
  return { app: a, calls };
}

// Route db answers per test. `opts`: serviceRow (null = no row),
// balance, alreadyPaid, chargedOrder.
function routeDb({ serviceRow = { id: 7, price: 100 }, balance = 1000, alreadyPaid = false, chargedOrder = false } = {}) {
  db.__routeQuery([
    ['FROM services', serviceRow ? [serviceRow] : []],
    ['FROM user_services', []],
    ['FROM users', [{ balance }]],
    ['FROM transactions', alreadyPaid ? [{ '1': 1 }] : []],
    ['FROM orders', chargedOrder ? [{ '1': 1 }] : []],
  ]);
  serviceCredits.availableFor.mockResolvedValue(0);
  serviceCredits.payForService.mockResolvedValue({ paidFromBalance: 100, newBalance: 900 });
}

beforeEach(() => {
  db.__reset();
  jest.clearAllMocks();
});

describe('pure helpers', () => {
  test('verify success needs 200 + success:true + brn/nameEn', () => {
    expect(isVerifySuccess(200, { success: true, data: { brn: '1' } })).toBe(true);
    expect(isVerifySuccess(200, { success: true, data: { nameEn: 'X' } })).toBe(true);
    expect(isVerifySuccess(200, { success: false, error: 'No record' })).toBe(false);
    expect(isVerifySuccess(400, { success: false })).toBe(false);
    expect(isVerifySuccess(200, { success: true, data: {} })).toBe(false);
  });
  test('policy: captcha free, verify charges, render needs proof, other blocked', () => {
    expect(policyFor('birth', '/api/captcha', 'GET')).toBe('free');
    expect(policyFor('birth', '/api/solve-captcha', 'POST')).toBe('free');
    expect(policyFor('birth', '/api/verify', 'POST')).toBe('verify');
    expect(policyFor('birth', '/api/preview', 'POST')).toBe('render');
    expect(policyFor('birth', '/generate-pdf', 'POST')).toBe('render');
    expect(policyFor('death', '/api/pdf', 'POST')).toBe('render');
    expect(policyFor('birth', '/api/records', 'GET')).toBe('blocked');
    expect(policyFor('death', '/api/birth-debug', 'GET')).toBe('blocked');
  });
});

describe('charge gate', () => {
  test('no login -> 401, engine not reached', async () => {
    routeDb();
    const { app, calls } = appWith({ authed: false });
    const r = await request(app).post('/api/bdris-engine/api/verify').send({ idempotency_key: 'k1' });
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('price 0 (no service row) -> verify forwarded free, no charge', async () => {
    routeDb({ serviceRow: null });
    const { app } = appWith({ mode: 'success' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-free' });
    expect(r.status).toBe(200);
    expect(r.body.data.brn).toBe('19900101123456789');
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('price >0 + verify success -> exactly one charge, record forwarded', async () => {
    routeDb();
    const { app } = appWith({ mode: 'success' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-pay' });
    expect(r.status).toBe(200);
    expect(r.body.data.nameEn).toBe('Test Person');
    expect(serviceCredits.payForService).toHaveBeenCalledTimes(1);
    const args = serviceCredits.payForService.mock.calls[0][1];
    expect(args.userId).toBe('u1');
    expect(args.amount).toBe(100);
    expect(args.ref).toBe('bdris-certificate-k-pay');
  });

  test('retry same attempt key -> forwarded, no second charge', async () => {
    routeDb({ alreadyPaid: true, chargedOrder: true });
    const { app } = appWith({ mode: 'success' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-pay' });
    expect(r.status).toBe(200);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('verify failure -> forwarded, no charge', async () => {
    routeDb();
    const { app } = appWith({ mode: 'failure' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-fail' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(false);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('verify session error (400) -> forwarded, no charge', async () => {
    routeDb();
    const { app } = appWith({ mode: 'session-error' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 'bad', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-sess' });
    expect(r.status).toBe(400);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('insufficient balance -> 402 before engine, engine not reached', async () => {
    routeDb({ balance: 10 });
    const { app, calls } = appWith({ mode: 'success' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-poor' });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(calls).toHaveLength(0);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('charge fails after success -> 402 and record withheld (no leak)', async () => {
    routeDb();
    serviceCredits.payForService.mockRejectedValue(new Error('INSUFFICIENT_BALANCE'));
    const { app } = appWith({ mode: 'success' });
    const r = await request(app).post('/api/bdris-engine/api/verify')
      .send({ sessionId: 's', brn: '1', dob: '2000-01-01', captcha: 'x', idempotency_key: 'k-leak' });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(r.text).not.toContain('Test Person');
    expect(r.text).not.toContain('19900101123456789');
  });

  test('preview without charged attempt -> 402, engine not reached', async () => {
    routeDb();
    const { app, calls } = appWith({});
    const r = await request(app).post('/api/bdris-engine/api/preview')
      .send({ brn: '1', nameEn: 'X', idempotency_key: 'k-unpaid' });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('CHARGE_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  test('preview with charged attempt -> through, no second charge', async () => {
    routeDb({ chargedOrder: true });
    const { app, calls } = appWith({});
    const r = await request(app).post('/api/bdris-engine/api/preview')
      .send({ brn: '1', nameEn: 'X', idempotency_key: 'k-pay' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('preview free when price 0, even without a charged attempt', async () => {
    routeDb({ serviceRow: null });
    const { app, calls } = appWith({});
    const r = await request(app).post('/api/bdris-engine/api/preview').send({ brn: '1' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('captcha stays free, engine reached, no charge', async () => {
    routeDb();
    const { app, calls } = appWith({});
    const r = await request(app).get('/api/bdris-engine/api/captcha');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(serviceCredits.payForService).not.toHaveBeenCalled();
  });

  test('unknown engine path blocked at mount, engine not reached', async () => {
    routeDb();
    const { app, calls } = appWith({});
    const r = await request(app).get('/api/bdris-engine/api/records');
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('death engine: verify success charges, pdf with charged key passes', async () => {
    routeDb();
    const calls = [];
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = { id: 'u1', role: 'user' }; next(); });
    a.use('/api/death-engine', chargeGate('death-verify', 'death', '/api/death-engine', { db, serviceCredits }),
      (req, res) => {
        calls.push(req.url);
        if (req.url === '/api/verify') {
          return res.json({ success: true, data: { brn: '19900101123456789', nameEn: 'Test Person' } });
        }
        return res.json({ success: true });
      });
    const v = await request(a).post('/api/death-engine/api/verify')
      .send({ sessionId: 's', drn: '1', dod: '01-01-2020', captcha: 'x', idempotency_key: 'd-pay' });
    expect(v.status).toBe(200);
    expect(serviceCredits.payForService).toHaveBeenCalledTimes(1);
    expect(serviceCredits.payForService.mock.calls[0][1].ref).toBe('death-verify-d-pay');
    // Now the pdf path: charged order exists for the same key.
    routeDb({ chargedOrder: true });
    const p = await request(a).post('/api/death-engine/api/pdf')
      .send({ brn: '1', nameEn: 'X', idempotency_key: 'd-pay' });
    expect(p.status).toBe(200);
    expect(serviceCredits.payForService).toHaveBeenCalledTimes(1);
  });
});
