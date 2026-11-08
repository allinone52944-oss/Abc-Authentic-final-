// Number-only Auto recharge (2026-11-08): Auto needs no TrxID — it is
// matched by sender number + amount; Manual still requires a TrxID.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const userRouter = require('../../routes/user');

function userApp() { const a = express(); a.use(express.json()); a.use('/api', userRouter); return a; }
const withUser = (req) => req.set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' }));
const AUTO = { method: 'bkash_personal', sender_no: '01712345678', amount: 500 };

beforeEach(() => { if (db.__reset) db.__reset(); });

describe('POST /api/wallet/recharge/auto', () => {
  test('creates a pending request without any TrxID', async () => {
    let inserted = null;
    db.__routeQuery([
      ["type = 'recharge' AND status = 'pending'", { rows: [{ count: '0' }] }],
      ['INSERT INTO transactions', (sql, params) => { inserted = params; return { rows: [{ id: 't9', user_id: 'u1', amount: 500, method: 'bkash_personal', sender_no: '01712345678', trxid: params[4], status: 'pending' }] }; }],
      ['FROM incoming_sms', { rows: [] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge/auto')).send(AUTO).expect(201);
    expect(r.body.transaction.status).toBe('pending');
    expect(inserted[3]).toBe('01712345678');
    expect(String(inserted[4])).toMatch(/^AUTO-[0-9A-F]{12}$/);
  });

  test('rejects a wrong sender number', async () => {
    const r = await withUser(request(userApp()).post('/api/wallet/recharge/auto')).send({ ...AUTO, sender_no: '12345' }).expect(400);
    expect(r.body.error).toBe('INVALID_SENDER');
  });

  test('blocks a 4th pending request', async () => {
    db.__routeQuery([["type = 'recharge' AND status = 'pending'", { rows: [{ count: '3' }] }]]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge/auto')).send(AUTO).expect(400);
    expect(r.body.error).toBe('TOO_MANY_PENDING');
  });
});

describe('POST /api/wallet/recharge (manual)', () => {
  test('still requires a TrxID', async () => {
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(AUTO).expect(400);
    expect(r.body.error).toBe('INVALID_TRXID');
  });

  test('a TrxID already credited through an Auto match cannot be claimed again', async () => {
    db.__routeQuery([
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['FROM public.incoming_sms', { rows: [{ '?column?': 1 }] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send({ ...AUTO, trxid: 'TRX99999' }).expect(409);
    expect(r.body.error).toBe('DUP_TRXID');
  });
});
