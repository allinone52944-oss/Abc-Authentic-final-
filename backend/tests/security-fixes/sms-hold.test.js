// FIX-12 regression: SMS webhook large-amount hold.
// When a matched recharge exceeds SMS_MAX_AUTO_APPROVE (env, default 50000),
// the webhook must NOT credit the wallet — it COMMITs the SMS row, logs
// 'sms.large_amount_hold', and answers { held_for_review: true }.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const db = require('../../db');
const { webhook } = require('../../routes/sms');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/sms', webhook);
  return a;
}

const SECRET = 'test-webhook-secret';
let savedSecret;
let savedMax;
beforeEach(() => {
  db.__reset();
  savedSecret = process.env.SMS_WEBHOOK_SECRET;
  savedMax = process.env.SMS_MAX_AUTO_APPROVE;
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  delete process.env.SMS_MAX_AUTO_APPROVE; // default 50000
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.SMS_WEBHOOK_SECRET;
  else process.env.SMS_WEBHOOK_SECRET = savedSecret;
  if (savedMax === undefined) delete process.env.SMS_MAX_AUTO_APPROVE;
  else process.env.SMS_MAX_AUTO_APPROVE = savedMax;
});

const BIG_MSG = 'You have received Tk 60000.00 from 01712345678. TrxID HOLD99XYZ1. Fee Tk 0.00. New balance Tk 70000.00.';
const SMALL_MSG = 'You have received Tk 500.00 from 01712345678. TrxID OK123ABC4. Fee Tk 0.00. New balance Tk 1200.00.';

function incomingHandlers(tx) {
  return [
    ['INSERT INTO incoming_sms', { rows: [{ id: 'sms1' }] }],
    ['SELECT id FROM incoming_sms', { rows: [] }], // not a duplicate
    ['UPPER(trxid)', { rows: [tx] }], // findMatch: exact TrxID
    ['FOR UPDATE', { rows: [tx] }], // approveRechargeTx lock
    ['wallet_apply', { rows: [{}] }],
    ['SELECT name, whatsapp, balance FROM users', { rows: [] }],
  ];
}
const clientCalls = () => db.__client.query.mock.calls;
const walletHits = () => clientCalls().filter((c) => /wallet_apply/.test(c[0]));
const activityActions = () =>
  db.query.mock.calls
    .filter((c) => /INSERT INTO activity_log/.test(c[0]))
    .map((c) => c[1][1]);

describe('FIX-12 SMS large-amount hold', () => {
  test('60000 > default 50000 → held_for_review, NO wallet credit', async () => {
    const tx = { id: 't1', user_id: 'u9', amount: '60000', trxid: 'HOLD99XYZ1', status: 'pending' };
    db.__routeQuery(incomingHandlers(tx));
    const r = await request(app()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: BIG_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, held_for_review: true });

    expect(walletHits()).toHaveLength(0); // wallet untouched
    expect(clientCalls().some((c) => /status = 'approved'/.test(c[0]))).toBe(false);
    expect(activityActions()).toContain('sms.large_amount_hold');
    expect(activityActions()).not.toContain('sms.auto_match');
  });

  test('amount exactly at the threshold → still auto-approved (only > holds)', async () => {
    const tx = { id: 't2', user_id: 'u9', amount: '50000', trxid: 'EDGE50000X', status: 'pending' };
    db.__routeQuery(incomingHandlers(tx));
    const msg = 'You have received Tk 50000.00 from 01712345678. TrxID EDGE50000X. New balance Tk 51000.00.';
    const r = await request(app()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: msg, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true });
    expect(walletHits()).toHaveLength(1);
  });

  test('small amount → normal auto-approve path unchanged', async () => {
    const tx = { id: 't3', user_id: 'u9', amount: '500', trxid: 'OK123ABC4', status: 'pending' };
    db.__routeQuery(incomingHandlers(tx));
    const r = await request(app()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: SMALL_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true, tx_id: 't3' });
    expect(walletHits()).toHaveLength(1);
    expect(activityActions()).toContain('sms.auto_match');
  });

  test('SMS_MAX_AUTO_APPROVE env raises the bar (100000 → 60000 auto-approved)', async () => {
    process.env.SMS_MAX_AUTO_APPROVE = '100000';
    const tx = { id: 't4', user_id: 'u9', amount: '60000', trxid: 'HOLD99XYZ1', status: 'pending' };
    db.__routeQuery(incomingHandlers(tx));
    const r = await request(app()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: BIG_MSG, sender: 'bKash' }).expect(200);
    expect(r.body).toMatchObject({ ok: true, matched: true });
    expect(walletHits()).toHaveLength(1);
  });

  test('hold logs the amount and tx id for manual review', async () => {
    const tx = { id: 't5', user_id: 'u9', amount: '75000', trxid: 'HOLD75KXX1', status: 'pending' };
    db.__routeQuery(incomingHandlers(tx));
    const msg = 'You have received Tk 75000.00 from 01712345678. TrxID HOLD75KXX1. New balance Tk 76000.00.';
    await request(app()).post('/api/sms/incoming')
      .send({ secret: SECRET, message: msg, sender: 'bKash' }).expect(200);
    const logCall = db.query.mock.calls.find((c) =>
      /INSERT INTO activity_log/.test(c[0]) && c[1][1] === 'sms.large_amount_hold');
    expect(logCall).toBeDefined();
    const details = JSON.parse(logCall[1][2]);
    expect(details).toMatchObject({ tx_id: 't5', amount: 75000 });
  });
});
