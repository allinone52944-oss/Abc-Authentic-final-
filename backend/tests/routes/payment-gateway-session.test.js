// Recharge status and duplicates, SMS-triggered approvals and admin alerts.
// The real routers run against the shared database mock.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const push = require('../../utils/push');
const userRouter = require('../../routes/user');
const { webhook, adminSms } = require('../../routes/sms');
const adminRouter = require('../../routes/admin');

function userApp() {
  const a = express();
  a.use(express.json());
  a.use('/api', userRouter);
  return a;
}
function webhookApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/sms', webhook);
  return a;
}
function adminSmsApp() {
  const a = express();
  a.use(express.json());
  // Production mounts adminSms behind requireAuth+requireAdmin, which sets
  // req.user; the match handler reads req.user.id for its activity log.
  a.use((req, _res, next) => { req.user = { id: 'admin1', role: 'admin' }; next(); });
  a.use('/api/admin/sms', adminSms);
  return a;
}
function adminApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}
const userToken = (id = 'u1') => auth.signAccess({ id, role: 'user' });
const adminToken = () => auth.signAccess({ id: 'admin1', role: 'admin' });
const withUser = (req, id) => req.set('Authorization', 'Bearer ' + userToken(id));
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());

const GOOD = { method: 'bkash_personal', sender_no: '01712345678', trxid: 'TRX12345', amount: 500 };
const SECRET = 'test-webhook-secret';
const BKASH_MSG = 'You have received Tk 500.00 from 01712345678. TrxID 9HXK2LQM4N. New balance Tk 1200.00.';
const atomicSmsHandlers = (trxid = null) => [
  ["status = 'approved' AND type = 'recharge'", { rows: [] }],
  ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid, matched_recharge_id: null }] }],
  ['WHERE id <> $1', { rows: [] }],
  ['UPDATE incoming_sms SET matched_recharge_id', { rows: [{ id: 's1' }] }],
];

beforeEach(() => {
  db.__reset();
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  delete process.env.SMS_MAX_AUTO_APPROVE;
  jest.restoreAllMocks();
});
afterEach(() => { jest.restoreAllMocks(); });

describe('POST /api/wallet/recharge — DUP_TRXID same-user info', () => {
  test('same user resubmits → 409 + existing_tx (amount, status, date)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [{
        id: 't9', user_id: 'u1', amount: '500', status: 'approved',
        created_at: '2026-11-04T10:00:00.000Z', trxid: 'TRX12345',
      }] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(409);
    expect(r.body.error).toBe('DUP_TRXID');
    expect(r.body.existing_tx).toMatchObject({ amount: '500', status: 'approved', trxid: 'TRX12345' });
    expect(r.body.existing_tx.created_at).toBe('2026-11-04T10:00:00.000Z');
  });

  test('another user\'s TrxID → 409 generic, NO existing_tx leaked', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [{
        id: 't9', user_id: 'u2', amount: '500', status: 'approved',
        created_at: '2026-11-04T10:00:00.000Z', trxid: 'TRX12345',
      }] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(409);
    expect(r.body.error).toBe('DUP_TRXID');
    expect(r.body.existing_tx).toBeUndefined();
  });
});

describe('POST /api/wallet/recharge — submit response carries tx status', () => {
  test('pending submit → 201 + transaction.status pending', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['INSERT INTO transactions', { rows: [{ id: 't1', status: 'pending' }] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(201);
    expect(r.body.transaction.status).toBe('pending');
  });

  test('submit-time auto-approve → 201 approved + admin auto-approve notified', async () => {
    const spy = jest.spyOn(push, 'notifyAutoApproveRecharge').mockResolvedValue({ ok: true, sent: 0 });
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['INSERT INTO transactions', { rows: [{ id: 't1', user_id: 'u1', amount: 500, method: 'bkash_personal', trxid: 'TRX12345', status: 'pending' }] }],
      ...atomicSmsHandlers('TRX12345'),
      ['FROM incoming_sms', { rows: [{ id: 'sms1', amount: 500, trxid: 'TRX12345', raw_message: 'You have received Tk 500.00 from 01712345678. TrxID TRX12345.', raw_sender: 'bKash' }] }],
      ['WHERE id = $1 AND status = \'pending\' AND type = \'recharge\'', { rows: [{ id: 't1', user_id: 'u1', amount: 500, method: 'bkash_personal', trxid: 'TRX12345', status: 'pending' }] }],
      ['SELECT * FROM wallet_apply', { rows: [{ new_balance: '600', tx_id: 't1' }] }],
      ['UPDATE transactions SET admin_id = NULL', { rows: [] }],
      ['UPDATE incoming_sms SET matched_recharge_id', { rows: [] }],
      ['INSERT INTO activity_log', { rows: [] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(201);
    expect(r.body.transaction.status).toBe('approved');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ id: 't1', trxid: 'TRX12345' });
    expect(spy.mock.calls[0][2]).toBe('u1');
  });

  test('SMS-first money-OUT never auto-approves a manual recharge', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['FROM public.incoming_sms', { rows: [] }],
      ["type = 'recharge' AND status = 'pending'", { rows: [{ count: '0' }] }],
      ['SELECT amount FROM incoming_sms', { rows: [] }],
      ['INSERT INTO transactions', { rows: [{ id: 't1', user_id: 'u1', amount: 500, method: 'bkash_personal', trxid: 'TRX12345', status: 'pending' }] }],
      ['WHERE matched_recharge_id IS NULL', { rows: [{ id: 'sms-out', amount: 500, trxid: 'TRX12345', raw_message: 'Cash Out Tk 500 sent to 01712345678. TrxID TRX12345.', raw_sender: 'bKash' }] }],
    ]);
    const r = await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(201);
    expect(r.body.transaction.status).toBe('pending');
    expect(db.__client.query.mock.calls.filter(c => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('pending submit → admin auto-approve NOT notified (pending push path unchanged)', async () => {
    const spy = jest.spyOn(push, 'notifyAutoApproveRecharge').mockResolvedValue({ ok: true, sent: 0 });
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['INSERT INTO transactions', { rows: [{ id: 't1', status: 'pending' }] }],
    ]);
    await withUser(request(userApp()).post('/api/wallet/recharge')).send(GOOD).expect(201);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/sms/incoming — webhook auto-approve notifies admin', () => {
  test('webhook form-first match → matched + admin auto-approve notified', async () => {
    const spy = jest.spyOn(push, 'notifyAutoApproveRecharge').mockResolvedValue({ ok: true, sent: 0 });
    const TX = { id: 't1', user_id: 'u1', amount: '500', method: 'bkash_personal', trxid: '9HXK2LQM4N', status: 'pending' };
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [TX] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
    ]);
    const r = await request(webhookApp()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true, how: 'trxid' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ id: 't1', trxid: '9HXK2LQM4N' });
  });

  test('manual admin match → admin auto-approve NOT notified (admin is the actor)', async () => {
    const spy = jest.spyOn(push, 'notifyAutoApproveRecharge').mockResolvedValue({ ok: true, sent: 0 });
    const TX = { id: 't1', user_id: 'u1', amount: 500, trxid: 'TRX12345', status: 'pending', type: 'recharge' };
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null, parse_status: 'parsed', trxid: 'TRX12345' }] }],
      ['FROM transactions WHERE id', { rows: [TX] }],
      ['WHERE id = $1 AND status = \'pending\' AND type = \'recharge\'', { rows: [TX] }],
      ['SELECT * FROM wallet_apply', { rows: [{ new_balance: '600', tx_id: 't1' }] }],
      ['UPDATE transactions SET admin_id', { rows: [] }],
      ['UPDATE incoming_sms SET matched_recharge_id', { rows: [] }],
      ['INSERT INTO activity_log', { rows: [] }],
    ]);
    const r = await withAdmin(request(adminSmsApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/stats — auto-match dashboard signal', () => {
  test('stats SQL computes auto_matched_recharge + latest_auto_match is surfaced', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['details->>', { rows: [{ amount: '500', trxid: '9HXK2LQM4N', user_name: 'Rahim', user_phone: '01711223344' }] }],
      ['pending_recharge', { rows: [{ auto_matched_recharge: '7', pending_recharge: '2' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/stats')).expect(200);
    expect(r.body.auto_matched_recharge).toBe('7');
    expect(r.body.latest_auto_match).toMatchObject({
      amount: '500', trxid: '9HXK2LQM4N', user_name: 'Rahim',
    });
    const statsSql = db.query.mock.calls.map((c) => c[0]).join('\n');
    expect(statsSql).toContain("action = 'sms.auto_match'");
  });
});
