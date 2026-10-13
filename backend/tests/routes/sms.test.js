// Route tests for backend/routes/sms.js (webhook + adminSms).
// Covers the security fix: SMS large-amount hold (SMS_MAX_AUTO_APPROVE).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const { webhook, adminSms } = require('../../routes/sms');

function webhookApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/sms', webhook);
  return a;
}
function adminApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/sms', adminSms);
  return a;
}
const adminToken = () => auth.signAccess({ id: 'admin1', role: 'admin' });
const withAdmin = (req) => req.set('Authorization', 'Bearer ' + adminToken());

const SECRET = 'test-webhook-secret';
let savedSecret;
let savedMax;
beforeEach(() => {
  db.__reset();
  savedSecret = process.env.SMS_WEBHOOK_SECRET;
  savedMax = process.env.SMS_MAX_AUTO_APPROVE;
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  delete process.env.SMS_MAX_AUTO_APPROVE;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.SMS_WEBHOOK_SECRET; else process.env.SMS_WEBHOOK_SECRET = savedSecret;
  if (savedMax === undefined) delete process.env.SMS_MAX_AUTO_APPROVE; else process.env.SMS_MAX_AUTO_APPROVE = savedMax;
});

const postIncoming = (body) => request(webhookApp()).post('/api/sms/incoming').send(body);
const BKASH_MSG = 'You have received Tk 500.00 from 01712345678. TrxID 9HXK2LQM4N. New balance Tk 1200.00.';

describe('POST /api/sms/incoming — auth', () => {
  test('no SMS_WEBHOOK_SECRET configured → 503 SMS_NOT_CONFIGURED', async () => {
    delete process.env.SMS_WEBHOOK_SECRET;
    const r = await postIncoming({ secret: 'x', message: 'hi' }).expect(503);
    expect(r.body.error).toBe('SMS_NOT_CONFIGURED');
  });
  test('wrong secret → 401 BAD_SECRET', async () => {
    const r = await postIncoming({ secret: 'wrong', message: BKASH_MSG }).expect(401);
    expect(r.body.error).toBe('BAD_SECRET');
  });
  test('secret via query param and x-sms-secret header also accepted', async () => {
    db.__reset();
    db.__routeQuery([['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }]]);
    await request(webhookApp()).post('/api/sms/incoming?secret=' + SECRET)
      .send({ message: 'garbage text' }).expect(200);
    db.__reset();
    db.__routeQuery([['INSERT INTO incoming_sms', { rows: [{ id: 's2' }] }]]);
    await request(webhookApp()).post('/api/sms/incoming')
      .set('x-sms-secret', SECRET).send({ message: 'garbage text' }).expect(200);
  });
  test('missing message → 400 MISSING_MESSAGE', async () => {
    const r = await postIncoming({ secret: SECRET, sender: 'bKash' }).expect(400);
    expect(r.body.error).toBe('MISSING_MESSAGE');
  });
});

describe('POST /api/sms/incoming — parsing', () => {
  test('unparseable message → stored, matched:false', async () => {
    db.__routeQuery([['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }]]);
    const r = await postIncoming({ secret: SECRET, message: 'hello world', sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: false, sms_id: 's1', parsed: false });
  });

  test('parsed but no matching recharge → matched:false', async () => {
    db.__routeQuery([
      ['FROM incoming_sms', { rows: [] }], // dup check
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [] }], // exact trxid
      ['AND amount = $1 AND sender_no = $2', { rows: [] }], // fuzzy
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: false, parsed: true });
  });

  test('duplicate trxid (already matched) → stored as duplicate, no re-match', async () => {
    db.__routeQuery([
      ['FROM incoming_sms', { rows: [{ id: 's0' }] }], // dup found
      ['INSERT INTO incoming_sms', { rows: [{ id: 's9' }] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(false);
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO incoming_sms/.test(c[0]));
    expect(ins[1][6]).toBe('duplicate'); // parse_status
  });
});

describe('POST /api/sms/incoming — auto-match', () => {
  const TX = { id: 't1', user_id: 'u1', amount: '500', trxid: '9HXK2LQM4N', status: 'pending' };
  function matchHandlers(tx = TX) {
    return [
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [tx] }],
      ['SELECT * FROM transactions', { rows: [tx] }],
    ];
  }

  test('exact TrxID match → approved + matched:true', async () => {
    db.__routeQuery(matchHandlers());
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true, how: 'trxid', tx_id: 't1' });
    const wallet = db.__client.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(wallet).toBeDefined();
    const upd = db.__client.query.mock.calls.find((c) => /UPDATE transactions SET status = 'approved'/.test(c[0]));
    expect(upd).toBeDefined();
  });

  test('security fix: amount > SMS_MAX_AUTO_APPROVE → held_for_review, NO wallet credit', async () => {
    process.env.SMS_MAX_AUTO_APPROVE = '100';
    db.__routeQuery(matchHandlers());
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true });
    const wallet = db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]));
    expect(wallet).toHaveLength(0);
    // activity log records the hold (via db.query, not the tx client)
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(log).toBeDefined();
    expect(JSON.parse(log[1][2]).amount).toBe(500);
  });

  test('amount == threshold → still auto-approved (boundary)', async () => {
    process.env.SMS_MAX_AUTO_APPROVE = '500';
    db.__routeQuery(matchHandlers());
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(true);
  });

  test('money-OUT messages never auto-match', async () => {
    db.__routeQuery([
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
    ]);
    const out = 'Cash Out Tk 200.00 sent to 01900000000. TrxID OUT123ABC.';
    const r = await postIncoming({ secret: SECRET, message: out, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(false);
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });
});

describe('adminSms routes', () => {
  test('require admin → 401/403', async () => {
    await request(adminApp()).get('/api/admin/sms').expect(401);
    const userTok = auth.signAccess({ id: 'u1', role: 'user' });
    await request(adminApp()).get('/api/admin/sms')
      .set('Authorization', 'Bearer ' + userTok).expect(403);
  });

  test('GET / lists with matched filter', async () => {
    db.__routeQuery([
      ['SELECT COUNT(*) FROM incoming_sms s', { rows: [{ count: '2' }] }],
      ['FROM incoming_sms s', { rows: [{ id: 's1' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms?matched=no&page=1')).expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.sms).toHaveLength(1);
    const countQ = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM incoming_sms/.test(c[0]));
    expect(countQ[0]).toContain("parse_status = 'parsed'");
  });

  test('POST /:id/match: missing transaction → 400; sms 404; already matched → 400', async () => {
    const r1 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match')).send({}).expect(400);
    expect(r1.body.error).toBe('MISSING_TRANSACTION');
    db.__routeQuery([['SELECT * FROM incoming_sms WHERE id', { rows: [] }]]);
    const r2 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(404);
    expect(r2.body.error).toBe('SMS_NOT_FOUND');
    db.__reset();
    db.__routeQuery([['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: 't9' }] }]]);
    const r3 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(400);
    expect(r3.body.error).toBe('ALREADY_MATCHED');
  });

  test('POST /:id/match happy → 200; tx not pending → 400 TX_NOT_PENDING', async () => {
    const TX = { id: 't1', user_id: 'u1', amount: '500', trxid: 'X', status: 'pending' };
    db.__routeQuery([
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, tx_id: 't1' });

    db.__reset();
    db.__routeQuery([
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [] }],
    ]);
    const r2 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(400);
    expect(r2.body.error).toBe('TX_NOT_PENDING');
  });

  test('POST /:id/ignore: not found → 404; ok → 200', async () => {
    db.__routeQuery([['UPDATE incoming_sms SET parse_status', { rows: [] }]]);
    await withAdmin(request(adminApp()).post('/api/admin/sms/s1/ignore')).expect(404);
    db.__reset();
    db.__routeQuery([['UPDATE incoming_sms SET parse_status', { rows: [{ id: 's1' }] }]]);
    await withAdmin(request(adminApp()).post('/api/admin/sms/s1/ignore')).expect(200);
  });

  test('GET /pending-recharges → 200', async () => {
    db.__routeQuery([['FROM transactions t JOIN users u', { rows: [{ id: 't1' }] }]]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms/pending-recharges')).expect(200);
    expect(r.body.pending).toHaveLength(1);
  });
});
