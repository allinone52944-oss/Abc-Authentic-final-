// Route tests for backend/routes/sms.js (webhook + adminSms).
// Covers the security fix: SMS large-amount hold (SMS_MAX_AUTO_APPROVE).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const auth = require('../../auth');
const push = require('../../utils/push');
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
const atomicSmsHandlers = (trxid = null) => [
  ["status = 'approved' AND type = 'recharge'", { rows: [] }],
  ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid, matched_recharge_id: null }] }],
  ['WHERE id <> $1', { rows: [] }],
  ['UPDATE incoming_sms SET matched_recharge_id', { rows: [{ id: 's1' }] }],
];

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
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }]]);
    await request(webhookApp()).post('/api/sms/incoming?secret=' + SECRET)
      .send({ message: 'garbage text' }).expect(200);
    db.__reset();
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['INSERT INTO incoming_sms', { rows: [{ id: 's2' }] }]]);
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
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }]]);
    const r = await postIncoming({ secret: SECRET, message: 'hello world', sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: false, sms_id: 's1', parsed: false });
    // audit #34 — an unparsed SMS is stored as 'unparsed', never 'parsed'
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO incoming_sms/.test(c[0]));
    expect(ins[1][6]).toBe('unparsed'); // parse_status
  });

  test('parsed but no matching recharge → matched:false', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }], // dup check
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [] }], // exact trxid
      ['AND amount = $1 AND sender_no = $2', { rows: [] }], // fuzzy
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: false, parsed: true });
    // audit #34 — a parsed SMS is still stored as 'parsed'
    const ins = db.__client.query.mock.calls.find((c) => /INSERT INTO incoming_sms/.test(c[0]));
    expect(ins[1][6]).toBe('parsed'); // parse_status
  });

  test('duplicate trxid (already matched) → stored as duplicate, no re-match', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
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
  const TX = { id: 't1', user_id: 'u1', amount: '500', method: 'bkash_personal', trxid: '9HXK2LQM4N', status: 'pending' };
  function matchHandlers(tx = TX) {
    return [
    ["status = 'approved' AND type = 'recharge'", { rows: [] }],      ...atomicSmsHandlers('9HXK2LQM4N'),
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
    // C-4 fix: wallet_apply reuses the existing pending row (5th param = tx id),
    // so no second ledger row is inserted; only admin_id is touched afterwards.
    expect(wallet[1]).toEqual(['u1', 500, 'recharge', '9HXK2LQM4N', 't1']);
    const upd = db.__client.query.mock.calls.find((c) => /UPDATE transactions SET admin_id = NULL/.test(c[0]));
    expect(upd).toBeDefined();
    const legacyFlip = db.__client.query.mock.calls.find((c) => /UPDATE transactions SET status = 'approved'/.test(c[0]));
    expect(legacyFlip).toBeUndefined(); // old double-row path must be gone
    // audit #33 — the auto-match is recorded as auto
    const smsUpd = db.__client.query.mock.calls.find((c) => /UPDATE incoming_sms SET matched_recharge_id/.test(c[0]));
    expect(smsUpd).toBeDefined();
    expect(smsUpd[0]).toContain('matched_via');
    expect(smsUpd[1]).toEqual(['t1', 's1', 'auto']);
  });

  test('security fix: amount > SMS_MAX_AUTO_APPROVE → held_for_review, NO wallet credit', async () => {
    process.env.SMS_MAX_AUTO_APPROVE = '100';
    const spy = jest.spyOn(push, 'notifyUser').mockResolvedValue({ ok: true, sent: 0 });
    db.__routeQuery(matchHandlers());
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true });
    const wallet = db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]));
    expect(wallet).toHaveLength(0);
    // activity log records the hold (via db.query, not the tx client)
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(log).toBeDefined();
    expect(JSON.parse(log[1][2]).amount).toBe(500);
    // audit #27 — the hold is not silent: the customer is told why
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'u1', expect.stringContaining('যাচাই'),
      expect.stringContaining('ম্যানুয়াল যাচাই'), '/wallet.html');
    spy.mockRestore();
  });

  test('amount == threshold → still auto-approved (boundary)', async () => {
    process.env.SMS_MAX_AUTO_APPROVE = '500';
    db.__routeQuery(matchHandlers());
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(true);
  });

  test('two identical Auto claims are ambiguous: no wallet credit', async () => {
    const auto = { id: 'auto1', user_id: 'u1', amount: 500, method: 'bkash_personal', sender_no: '01712345678', trxid: null, status: 'pending' };
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [] }],
      ['AND amount = $1 AND sender_no = $2', { rows: [auto, { ...auto, id: 'auto2', user_id: 'u2' }] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(false);
    expect(db.__client.query.mock.calls.filter(c => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('late SMS auto-matches by amount+sender (Rule 2): no time window', async () => {
    // The bug: a late SMS (>30 min after the recharge) never matched —
    // both match paths had a hard 30-minute window and no retry. The
    // window is gone; the guards that stay are exact amount + sender +
    // method, a real SMS TrxID, an unmatched SMS, and exactly one
    // candidate. The mock has no clock, so the regression is asserted
    // on the SQL the code actually issues: it must carry no window.
    const auto = { id: 'auto1', user_id: 'u1', amount: 500, method: 'bkash_personal', sender_no: '01712345678', trxid: null, status: 'pending' };
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [] }],
      ['AND amount = $1 AND sender_no = $2', { rows: [auto] }],
      ['SELECT * FROM transactions', { rows: [auto] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true, how: 'amount+sender', tx_id: 'auto1' });
    const wallet = db.__client.query.mock.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(wallet).toBeDefined();
    expect(wallet[1]).toEqual(['u1', 500, 'recharge', 'tx-auto1', 'auto1']);
    const rule2 = db.__client.query.mock.calls.find((c) => /AND amount = \$1 AND sender_no = \$2/.test(c[0]));
    expect(rule2).toBeDefined();
    expect(rule2[0]).not.toContain("INTERVAL '30 minutes'");
    // Exact values only — a wrong amount or sender can never match.
    expect(rule2[1]).toEqual([500, '01712345678', ['bkash_payment', 'bkash_personal']]);
    // Audit #33 — the auto-match is recorded as auto
    const smsUpd = db.__client.query.mock.calls.find((c) => /UPDATE incoming_sms SET matched_recharge_id/.test(c[0]));
    expect(smsUpd).toBeDefined();
    expect(smsUpd[1]).toEqual(['auto1', 's1', 'auto']);
  });

  test('Rule 2 with no exact amount+sender recharge → no match, no credit', async () => {
    // Wrong amount OR wrong sender: the lookup finds nothing, so the
    // SMS stays unmatched and no wallet is touched.
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [] }],
      ['AND amount = $1 AND sender_no = $2', { rows: [] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(false);
    expect(db.__client.query.mock.calls.filter(c => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('an already consumed provider TrxID cannot credit another request', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid: '9HXK2LQM4N', matched_recharge_id: null }] }],
      ['WHERE id <> $1', { rows: [{ id: 'older-sms' }] }],
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [TX] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(409);
    expect(r.body.error).toBe('SMS_ALREADY_MATCHED');
    expect(db.__client.query.mock.calls.filter(c => /wallet_apply/.test(c[0]))).toHaveLength(0);
    expect(db.__client.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
  });

  test('money-OUT messages never auto-match', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
    ]);
    const out = 'Cash Out Tk 200.00 sent to 01900000000. TrxID OUT123ABC.';
    const r = await postIncoming({ secret: SECRET, message: out, sender: 'bKash' }).expect(200);
    expect(r.body.matched).toBe(false);
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('audit #25 — direction unknown never auto-matches: held for review', async () => {
    db.__routeQuery(matchHandlers());
    // No in-words (received/credited/cash in) and no out-words:
    // the direction is 'unknown', yet the TrxID + amount match a
    // pending recharge exactly. Before the fix this auto-approved.
    const unknown = 'Tk 500.00 TrxID 9HXK2LQM4N. Balance Tk 1200.00.';
    const r = await postIncoming({ secret: SECRET, message: unknown, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true, reason: 'DIRECTION_UNKNOWN' });
    expect(r.body.matched).toBeUndefined();
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
    // the hold is logged for the admin
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(log).toBeDefined();
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
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT COUNT(*) FROM incoming_sms s', { rows: [{ count: '2' }] }],
      // Delete All added a grand-total COUNT (exact query, no WHERE).
      [(t) => t.trim() === 'SELECT COUNT(*) FROM incoming_sms', { rows: [{ count: '2' }] }],
      ['FROM incoming_sms s', { rows: [{ id: 's1' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms?matched=no&page=1')).expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.sms).toHaveLength(1);
    const countQ = db.query.mock.calls.find((c) => /SELECT COUNT\(\*\) FROM incoming_sms/.test(c[0]));
    expect(countQ[0]).toContain("parse_status IN ('parsed', 'unparsed')"); // audit #34
  });

  test('POST /:id/match: missing transaction → 400; sms 404; already matched → 400', async () => {
    const r1 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match')).send({}).expect(400);
    expect(r1.body.error).toBe('MISSING_TRANSACTION');
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['SELECT * FROM incoming_sms WHERE id', { rows: [] }]]);
    const r2 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(404);
    expect(r2.body.error).toBe('SMS_NOT_FOUND');
    db.__reset();
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: 't9' }] }]]);
    const r3 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(400);
    expect(r3.body.error).toBe('ALREADY_MATCHED');
  });

  test('POST /:id/match happy → 200; tx not pending → 400 TX_NOT_PENDING', async () => {
    const TX = { id: 't1', user_id: 'u1', amount: '500', trxid: 'X', status: 'pending' };
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, tx_id: 't1' });

    db.__reset();
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [] }],
    ]);
    const r2 = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(400);
    expect(r2.body.error).toBe('TX_NOT_PENDING');
  });

  test('POST /:id/ignore: not found → 404; ok → 200', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['UPDATE incoming_sms SET parse_status', { rows: [] }]]);
    await withAdmin(request(adminApp()).post('/api/admin/sms/s1/ignore')).expect(404);
    db.__reset();
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['UPDATE incoming_sms SET parse_status', { rows: [{ id: 's1' }] }]]);
    await withAdmin(request(adminApp()).post('/api/admin/sms/s1/ignore')).expect(200);
  });

  test('GET /pending-recharges → 200', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],['FROM transactions t JOIN users u', { rows: [{ id: 't1' }] }]]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms/pending-recharges')).expect(200);
    expect(r.body.pending).toHaveLength(1);
  });
});

// ============================================================
// Fraud guard: TrxID match must also agree on the amount
// (claimed amount vs SMS amount) — mismatch => HOLD + notify
// (audit #26: never auto-cancel — the parser may have misread
// the amount, and cancelling destroys the real request).
// ============================================================
describe('POST /api/sms/incoming — TrxID amount fraud guard', () => {
  const TX = { id: 't1', user_id: 'u1', amount: '500', method: 'bkash_personal', trxid: '9HXK2LQM4N', status: 'pending' };
  const SMS50 = 'You have received Tk 50.00 from 01712345678. TrxID 9HXK2LQM4N.';

  test('SMS amount ≠ claimed amount → HELD (not cancelled), NO wallet credit (audit #26)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }], // dup check
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [TX] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: SMS50, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true, reason: 'AMOUNT_MISMATCH', sms_id: 's1' });
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
    // the pending is NOT cancelled — no reject update runs
    const cancel = db.__client.query.mock.calls.find((c) => /UPDATE transactions SET status = 'rejected'/.test(c[0]));
    expect(cancel).toBeUndefined();
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(log).toBeDefined();
    expect(JSON.parse(log[1][2])).toMatchObject({ claimed_amount: 500, sms_amount: 50 });
  });

  test('SMS amount == claimed amount → still auto-approved', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [TX] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
    ]);
    const r = await postIncoming({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true, how: 'trxid' });
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(1);
  });

  test('amount unparseable → held for review, NO wallet credit', async () => {
    const spy = jest.spyOn(push, 'notifyUser').mockResolvedValue({ ok: true, sent: 0 });
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers('9HXK2LQM4N'),
      ['FROM incoming_sms', { rows: [] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's1' }] }],
      ['UPPER(trxid) = UPPER($1)', { rows: [TX] }],
    ]);
    const r = await postIncoming({
      secret: SECRET,
      message: 'You have received money. TrxID 9HXK2LQM4N.',
      sender: 'bKash',
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true, reason: 'AMOUNT_UNPARSED' });
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
    // audit #27 — the hold is not silent: the customer is told why
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'u1', expect.stringContaining('যাচাই'),
      expect.stringContaining('পরিমাণ পড়া যায়নি'), '/wallet.html');
    spy.mockRestore();
  });
});

describe('adminSms manual match — amount fraud guard', () => {
  test('SMS amount ≠ request amount → 400 AMOUNT_MISMATCH, NO wallet credit', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null, amount: '50' }] }],
      ['SELECT * FROM transactions', { rows: [{ id: 't1', user_id: 'u1', amount: '500', trxid: 'X', status: 'pending', type: 'recharge' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(400);
    expect(r.body).toMatchObject({ error: 'AMOUNT_MISMATCH', sms_amount: 50, requested_amount: 500 });
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('SMS amount == request amount → match proceeds', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', matched_recharge_id: null, amount: '500' }] }],
      ['SELECT * FROM transactions', { rows: [{ id: 't1', user_id: 'u1', amount: '500', trxid: 'X', status: 'pending', type: 'recharge' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, tx_id: 't1' });
  });
});

describe('findMatch amount+sender safety', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../routes/sms.js'), 'utf8');
  const fuzzyStart = src.indexOf('// 2) Number-only Auto');
  const fuzzy = src.slice(fuzzyStart, src.indexOf('\n}\n', fuzzyStart) + 2);

  test('sender fallback is Auto-only, real-TrxID and ambiguity-safe (no time window — late SMS must match)', () => {
    expect(fuzzy).toContain('parsed.trxid');
    expect(fuzzy).toContain("(trxid IS NULL OR trxid ~ '^AUTO-[0-9A-F]{12}$')");
    expect(fuzzy).not.toContain("INTERVAL '30 minutes'");
    expect(fuzzy).toContain('LIMIT 2');
    expect(fuzzy).toContain('r.rows.length === 1');
    expect(fuzzy).not.toContain('LIMIT 1');
  });
});

describe('POST /api/admin/sms/:id/match — manual match (audit #33)', () => {
  const TX = { id: 't1', type: 'recharge', amount: 500, status: 'pending', user_id: 'u1', trxid: 'TRX1' };
  test('manual match records matched_via = manual', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ...atomicSmsHandlers(),
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
      ['SELECT * FROM transactions WHERE id = $1 FOR UPDATE', { rows: [TX] }],
      ["AND status = 'pending' AND type = 'recharge' FOR UPDATE", { rows: [TX] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/s1/match'))
      .send({ transaction_id: 't1' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, tx_id: 't1' });
    const smsUpd = db.__client.query.mock.calls.find((c) => /UPDATE incoming_sms SET matched_recharge_id/.test(c[0]));
    expect(smsUpd).toBeDefined();
    expect(smsUpd[0]).toContain('matched_via');
    expect(smsUpd[1]).toEqual(['t1', 's1', 'manual']);
    // the manual-match activity is logged under its own action
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(log).toBeDefined();
    expect(JSON.parse(log[1][2]).sms_id).toBe('s1');
  });
});

describe('migration 051_sms_matched_via.sql (audit #33)', () => {
  const fs = require('fs');
  const path = require('path');
  const mig = fs.readFileSync(
    path.join(__dirname, '../../../database/migrations/051_sms_matched_via.sql'), 'utf8');
  test('adds the matched_via column with the auto/manual check', () => {
    expect(mig).toContain('ALTER TABLE incoming_sms ADD COLUMN IF NOT EXISTS matched_via VARCHAR(10)');
    expect(mig).toContain("CHECK (matched_via IN ('auto', 'manual'))");
  });
});

describe('GET /api/admin/sms — unmatched list (audit #34)', () => {
  test('matched=no includes unparsed SMS, not just parsed ones', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT COUNT(*) FROM incoming_sms', { rows: [{ count: '2' }] }],
      ['FROM incoming_sms s', { rows: [] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms?matched=no')).expect(200);
    expect(r.body.total).toBe(2);
    const list = db.query.mock.calls.find((c) => /FROM incoming_sms s/.test(c[0]));
    expect(list[0]).toContain("s.parse_status IN ('parsed', 'unparsed')");
  });

  test('the late-submit lookup still needs a parsed SMS (trxid + amount)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../../routes/sms.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function tryAutoMatchRecharge'));
    expect(fn).toContain("AND parse_status = 'parsed'");
  });
});

describe('GET /api/admin/sms — pagination (audit #36)', () => {
  test('page=2&limit=30 → LIMIT 30 OFFSET 30', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT COUNT(*) FROM incoming_sms s', { rows: [{ count: '61' }] }],
      // Delete All added a grand-total COUNT (exact query, no WHERE).
      [(t) => t.trim() === 'SELECT COUNT(*) FROM incoming_sms', { rows: [{ count: '61' }] }],
      ['FROM incoming_sms s', { rows: [{ id: 's1' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms?matched=no&page=2&limit=30')).expect(200);
    expect(r.body.total).toBe(61);
    expect(r.body.page).toBe(2);
    const rowsQ = db.query.mock.calls.find((c) => /FROM incoming_sms s/.test(c[0]) && /LIMIT/.test(c[0]));
    expect(rowsQ[1]).toEqual([30, 30]); // limit, offset
  });
});

describe('holdRateLimitedSms — over-cap SMS are held, not lost (audit #37)', () => {
  const { holdRateLimitedSms } = require('../../routes/sms');
  const fakeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.json = jest.fn((b) => { res.body = b; return res; });
    return res;
  };
  const fakeReq = (body) => ({ body, query: {}, headers: {} });

  test('valid secret + room in the hold queue → 202 held, stored as unparsed', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ["parse_status = 'unparsed' AND created_at", { rows: [{ count: '3' }] }],
      ['INSERT INTO incoming_sms', { rows: [{ id: 's99' }] }],
    ]);
    const res = fakeRes();
    await holdRateLimitedSms(fakeReq({ secret: SECRET, message: BKASH_MSG, sender: 'bKash' }), res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true, held_for_review: true, reason: 'RATE_LIMITED', sms_id: 's99' });
    const ins = db.query.mock.calls.find((c) => /INSERT INTO incoming_sms/.test(c[0]));
    expect(ins[0]).toContain("'unparsed'"); // parse_status is a literal in the SQL
    expect(ins[1][0]).toBe(BKASH_MSG); // raw_message
    expect(ins[1][1]).toBe('bKash'); // raw_sender
    const log = db.query.mock.calls.find((c) => /INSERT INTO activity_log/.test(c[0]));
    expect(JSON.parse(log[1][2]).sms_id).toBe('s99');
  });

  test('invalid secret → 429, nothing stored', async () => {
    const res = fakeRes();
    await holdRateLimitedSms(fakeReq({ secret: 'wrong', message: BKASH_MSG }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'RATE_LIMITED' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('hold queue full → 429, nothing stored', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],["parse_status = 'unparsed' AND created_at", { rows: [{ count: '50' }] }]]);
    const res = fakeRes();
    await holdRateLimitedSms(fakeReq({ secret: SECRET, message: BKASH_MSG }), res);
    expect(res.statusCode).toBe(429);
    expect(db.query.mock.calls.filter((c) => /INSERT INTO incoming_sms/.test(c[0]))).toHaveLength(0);
  });

  test('no message → 429, nothing stored', async () => {
    const res = fakeRes();
    await holdRateLimitedSms(fakeReq({ secret: SECRET, message: '   ' }), res);
    expect(res.statusCode).toBe(429);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('the limiter wires the hold handler (not a bare 429 message)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../../routes/sms.js'), 'utf8');
    expect(src).toContain('handler: (req, res) => { void holdRateLimitedSms(req, res); }');
    expect(src).toContain('max: 120');
    expect(src).not.toContain("message: { error: 'RATE_LIMITED' }");
  });
});

// ============================================================
// Recharge Bug 4 (2026-11-11): SMS-hub manual match race — the
// match endpoint's catch collapsed SMS_ALREADY_MATCHED to generic
// MATCH_FAILED, so the admin saw a raw code with no explanation.
// The race: a racing actor (auto-match/webhook/another admin) links
// the SMS after the early ALREADY_MATCHED check but before
// approveRechargeTx's conditional link. The fix preserves the real
// code in the endpoint's error regex (sms.js match catch).
describe('POST /api/admin/sms/:id/match — SMS_ALREADY_MATCHED preserved (Bug 4)', () => {
  const TX = { id: 't1', type: 'recharge', amount: 500, status: 'pending', user_id: 'u1', trxid: 'FAKE-TRX-1' };
  const postMatch = () => withAdmin(request(adminApp()).post('/api/admin/sms/s1/match')).send({ transaction_id: 't1' });

  test('race: SMS linked between early check and approveRechargeTx → 400 SMS_ALREADY_MATCHED (not MATCH_FAILED), no credit', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      // Early check reads the SMS as still unmatched …
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
      // … but by the time approveRechargeTx locks it, another actor linked it.
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid: 'FAKE-TRX-1', matched_recharge_id: 't-other' }] }],
    ]);
    const r = await postMatch().expect(400);
    expect(r.body.error).toBe('SMS_ALREADY_MATCHED');
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('DUPLICATE_TRANSACTION is still preserved (not MATCH_FAILED)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [{ id: 't-approved' }] }],
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid: 'FAKE-TRX-1', matched_recharge_id: null }] }],
      ['WHERE id <> $1', { rows: [] }],
    ]);
    const r = await postMatch().expect(400);
    expect(r.body.error).toBe('DUPLICATE_TRANSACTION');
    expect(db.__client.query.mock.calls.filter((c) => /wallet_apply/.test(c[0]))).toHaveLength(0);
  });

  test('INSUFFICIENT_BALANCE is still preserved (not MATCH_FAILED)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid: 'FAKE-TRX-1', matched_recharge_id: null }] }],
      ['WHERE id <> $1', { rows: [] }],
      ['SELECT * FROM wallet_apply', async () => { throw new Error('INSUFFICIENT_BALANCE'); }],
    ]);
    const r = await postMatch().expect(400);
    expect(r.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  test('a genuinely unknown error still returns MATCH_FAILED', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['SELECT * FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
      ['SELECT * FROM transactions', { rows: [TX] }],
      ['SELECT id, trxid, matched_recharge_id FROM incoming_sms', { rows: [{ id: 's1', trxid: 'FAKE-TRX-1', matched_recharge_id: null }] }],
      ['WHERE id <> $1', { rows: [] }],
      ['SELECT * FROM wallet_apply', async () => { throw new Error('SOME_WEIRD_DB_ERROR'); }],
    ]);
    const r = await postMatch().expect(400);
    expect(r.body.error).toBe('MATCH_FAILED');
  });
});

// ============================================================
// SMS delete system: per-card hard delete + bulk delete of all
// ignored SMS. A MATCHED SMS is payment evidence and must never
// be deletable; the guard lives in the DELETE SQL itself.
// ============================================================
describe('SMS delete system', () => {
  const delCalls = () => db.query.mock.calls.filter((c) => /DELETE FROM incoming_sms/.test(c[0]));
  const activityCalls = () => db.query.mock.calls.filter((c) => /INSERT INTO activity_log/.test(c[0]));

  test('DELETE /:id — unmatched SMS is deleted (200) and logged', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['DELETE FROM incoming_sms', { rows: [{ id: 's1' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).delete('/api/admin/sms/s1')).expect(200);
    expect(r.body.ok).toBe(true);
    // The guard is in the SQL: only unmatched rows can be deleted.
    expect(delCalls()).toHaveLength(1);
    expect(delCalls()[0][0]).toContain('matched_recharge_id IS NULL');
    expect(delCalls()[0][1]).toEqual(['s1']);
    // Activity logged with the sms id only (no body/phone/TrxID).
    const acts = activityCalls();
    expect(acts).toHaveLength(1);
    expect(acts[0][1][1]).toBe('sms.delete');
    expect(JSON.parse(acts[0][1][2])).toEqual({ sms_id: 's1' });
  });

  test('DELETE /:id — matched SMS is rejected (400) and the record stays', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      // The guarded DELETE deletes nothing (matched row excluded).
      ['DELETE FROM incoming_sms', { rows: [] }],
      ['SELECT matched_recharge_id FROM incoming_sms', { rows: [{ matched_recharge_id: 't1' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).delete('/api/admin/sms/s1')).expect(400);
    expect(r.body.error).toBe('MATCHED_SMS');
    expect(r.body.message).toContain('মিলেছে');
    // The DELETE was attempted but the guard excluded the matched row.
    expect(delCalls()).toHaveLength(1);
    expect(delCalls()[0][0]).toContain('matched_recharge_id IS NULL');
    // No delete activity was logged for a rejected delete.
    expect(activityCalls()).toHaveLength(0);
  });

  test('DELETE /:id — missing SMS returns 404, not success', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['DELETE FROM incoming_sms', { rows: [] }],
      ['SELECT matched_recharge_id FROM incoming_sms', { rows: [] }],
    ]);
    const r = await withAdmin(request(adminApp()).delete('/api/admin/sms/nope')).expect(404);
    expect(r.body.error).toBe('SMS_NOT_FOUND');
    expect(activityCalls()).toHaveLength(0);
  });

  test('POST /delete-ignored — deletes ONLY ignored SMS, returns the count', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ["parse_status = 'ignored'", { rows: [{ id: 's-ign1' }, { id: 's-ign2' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/delete-ignored')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted).toBe(2);
    // The SQL deletes only ignored AND unmatched rows — matched and
    // unmatched-but-not-ignored SMS are never touched.
    expect(delCalls()).toHaveLength(1);
    expect(delCalls()[0][0]).toContain("parse_status = 'ignored'");
    expect(delCalls()[0][0]).toContain('matched_recharge_id IS NULL');
    const acts = activityCalls();
    expect(acts).toHaveLength(1);
    expect(acts[0][1][1]).toBe('sms.delete-ignored');
    expect(JSON.parse(acts[0][1][2])).toEqual({ count: 2 });
  });

  test('POST /delete-ignored — zero ignored SMS deletes nothing (count 0)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ["parse_status = 'ignored'", { rows: [] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/delete-ignored')).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted).toBe(0);
    expect(delCalls()).toHaveLength(1);
    const acts = activityCalls();
    expect(acts).toHaveLength(1);
    expect(JSON.parse(acts[0][1][2])).toEqual({ count: 0 });
  });

  test('POST /delete-all — without confirm flag → 400 CONFIRM_REQUIRED, nothing deleted', async () => {
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/delete-all')).send({}).expect(400);
    expect(r.body.error).toBe('CONFIRM_REQUIRED');
    // No DELETE ran at all without the confirm flag.
    expect(delCalls()).toHaveLength(0);
    expect(activityCalls()).toHaveLength(0);
  });

  test('POST /delete-all — with confirm:true deletes EVERYTHING (matched + unmatched), returns count', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      // 3 rows: the mock cannot tell matched from unmatched, so the
      // SQL itself is the proof — it must have NO guard at all.
      ['DELETE FROM incoming_sms', { rows: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/delete-all'))
      .send({ confirm: true }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted).toBe(3);
    // The DELETE has no WHERE clause: no matched guard, no ignored filter.
    expect(delCalls()).toHaveLength(1);
    expect(delCalls()[0][0]).not.toContain('matched_recharge_id IS NULL');
    expect(delCalls()[0][0]).not.toContain("parse_status = 'ignored'");
    expect(delCalls()[0][0]).not.toContain('WHERE');
    const acts = activityCalls();
    expect(acts).toHaveLength(1);
    expect(acts[0][1][1]).toBe('sms.delete-all');
    expect(JSON.parse(acts[0][1][2])).toEqual({ count: 3 });
  });

  test('POST /delete-all — zero SMS deletes nothing (count 0)', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      ['DELETE FROM incoming_sms', { rows: [] }],
    ]);
    const r = await withAdmin(request(adminApp()).post('/api/admin/sms/delete-all'))
      .send({ confirm: true }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted).toBe(0);
    expect(delCalls()).toHaveLength(1);
    const acts = activityCalls();
    expect(acts).toHaveLength(1);
    expect(JSON.parse(acts[0][1][2])).toEqual({ count: 0 });
  });

  test('GET /api/admin/sms — list carries ignored_total for the bulk button', async () => {
    db.__routeQuery([
      ["status = 'approved' AND type = 'recharge'", { rows: [] }],
      // The ignored-count query must be matched before the generic
      // total-count handler (routeQuery takes the first match).
      ["parse_status = 'ignored'", { rows: [{ count: '5' }] }],
      // The grand-total query is exactly this string (no WHERE); the
      // filtered total carries ' s' + a WHERE, so the exact matcher
      // only fires for total_all.
      [(t) => t.trim() === 'SELECT COUNT(*) FROM incoming_sms', { rows: [{ count: '7' }] }],
      ['SELECT COUNT(*) FROM incoming_sms', { rows: [{ count: '2' }] }],
      ['FROM incoming_sms s', { rows: [] }],
    ]);
    const r = await withAdmin(request(adminApp()).get('/api/admin/sms?matched=no')).expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.ignored_total).toBe(5);
    expect(r.body.total_all).toBe(7);
  });
});
