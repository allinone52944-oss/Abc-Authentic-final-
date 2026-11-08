// Number-only Auto recharge (2026-11-08): Auto needs no TrxID — it is
// matched by sender number + amount; Manual still requires a TrxID.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const userRouter = require('../../routes/user');
const { approveRechargeTx } = require('../../routes/sms');

function userApp() { const a = express(); a.use(express.json()); a.use('/api', userRouter); return a; }
const withUser = (req) => req.set('Authorization', 'Bearer ' + auth.signAccess({ id: 'u1', role: 'user' }));
const AUTO = { method: 'bkash_personal', sender_no: '01712345678', amount: 500 };

beforeEach(() => { if (db.__reset) db.__reset(); });

describe('POST /api/wallet/recharge/auto', () => {
  test('creates a pending request without any TrxID', async () => {
    let inserted = null;
    db.__routeQuery([
      ["type = 'recharge' AND status = 'pending'", { rows: [{ count: '0' }] }],
      ['INSERT INTO transactions', (sql, params) => { inserted = params; return { rows: [{ id: 't9', user_id: 'u1', amount: 500, method: 'bkash_personal', sender_no: '01712345678', trxid: null, status: 'pending' }] }; }],
      ['FROM incoming_sms', { rows: [] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge/auto')).send(AUTO).expect(201);
    expect(r.body.transaction.status).toBe('pending');
    expect(r.body.transaction.trxid).toBeNull();
    expect(r.body.request_id).toBe('t9');
    expect(r.body.ref).toBeUndefined();
    expect(inserted).toEqual(['u1', 500, 'bkash_personal', '01712345678']);
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

describe('Auto SMS approval', () => {
  test('stores the real SMS TrxID after a number+amount match', async () => {
    db.__routeQuery([
      ["AND status = 'pending' AND type = 'recharge' FOR UPDATE", { rows: [{ id: 't9', user_id: 'u1', amount: 500, method: 'bkash_personal', sender_no: '01712345678', trxid: null, status: 'pending', type: 'recharge' }] }],
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 'sms1', trxid: 'REAL9HXK2LQM4N', matched_recharge_id: null }] }],
      ['WHERE id <> $1', { rows: [] }],
      ['SELECT * FROM wallet_apply', { rows: [{ new_balance: 600, tx_id: 't9' }] }],
      ['UPDATE transactions AS t', { rows: [{ trxid: 'REAL9HXK2LQM4N' }] }],
      ['UPDATE transactions SET admin_id = NULL', { rows: [] }],
      ['UPDATE incoming_sms SET matched_recharge_id', { rows: [{ id: 'sms1' }] }],
    ]);
    const tx = await approveRechargeTx(db.__client, 't9', 'sms1');
    expect(tx).toMatchObject({ id: 't9', status: 'approved', trxid: 'REAL9HXK2LQM4N' });
    const wallet = db.__client.query.mock.calls.find(c => c[0].includes('wallet_apply'));
    expect(wallet[1]).toEqual(['u1', 500, 'recharge', 'tx-t9', 't9']);
    const linked = db.__client.query.mock.calls.find(c => c[0].includes('UPDATE incoming_sms SET matched_recharge_id'));
    expect(linked[0]).toContain('matched_recharge_id IS NULL RETURNING id');
  });
});

describe('GET /api/wallet/recharge/request/:id', () => {
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  test('finds only the signed-in user\'s Auto request by transaction ID', async () => {
    db.__routeQuery([['AND id = $2 LIMIT 1', { rows: [{ id: ID, user_id: 'u1', status: 'pending', trxid: null }] }]]);
    const r = await withUser(request(userApp()).get('/api/wallet/recharge/request/' + ID)).expect(200);
    expect(r.body.transaction).toMatchObject({ id: ID, status: 'pending', trxid: null });
    const q = db.query.mock.calls.find(c => c[0].includes('AND id = $2 LIMIT 1'));
    expect(q[1]).toEqual(['u1', ID]);
  });
  test('rejects a malformed request ID without querying the database', async () => {
    const r = await withUser(request(userApp()).get('/api/wallet/recharge/request/not-a-uuid')).expect(400);
    expect(r.body.error).toBe('INVALID_REQUEST_ID');
    expect(db.query).not.toHaveBeenCalled();
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
