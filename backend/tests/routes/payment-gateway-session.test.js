// Regression tests for the premium gateway-style wallet recharge session
// (2026-11-04): status-truth messages, same-user duplicate info, admin
// auto-approve notification on both auto paths (never on session start,
// never on manual match), stats signal for the admin dashboard toast,
// and session/timer invariants in frontend/wallet.html.
// Backend behavior is exercised through the real routers with the shared
// mocked DB; wallet.html invariants are asserted on the shipped file text
// (the page has no JS module harness — the session code is inline).
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
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

beforeEach(() => {
  db.__reset();
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  delete process.env.SMS_MAX_AUTO_APPROVE;
  jest.restoreAllMocks();
});
afterEach(() => { jest.restoreAllMocks(); });

// Slice a top-level function body out of wallet.html text for invariant
// assertions (no JS harness exists for the inline page script).
function walletHtml() {
  return fs.readFileSync(path.join(__dirname, '../../../frontend/wallet.html'), 'utf8');
}
function fnSlice(src, startMarker) {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const stops = ['\nfunction ', '\nasync function ', '\n// ==== End gateway session ===='].map(
    (m) => rest.indexOf(m, 1)).filter((i) => i !== -1);
  const next = stops.length ? Math.min(...stops) : -1;
  return next === -1 ? rest : rest.slice(0, next);
}

describe('POST /api/wallet/recharge — DUP_TRXID same-user info', () => {
  test('same user resubmits → 409 + existing_tx (amount, status, date)', async () => {
    db.__routeQuery([
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
      ['type = \'recharge\' AND status = \'pending\'', { rows: [{ count: '0' }] }],
      ['FROM transactions WHERE UPPER(trxid)', { rows: [] }],
      ['INSERT INTO transactions', { rows: [{ id: 't1', user_id: 'u1', amount: 500, trxid: 'TRX12345', status: 'pending' }] }],
      ['FROM incoming_sms', { rows: [{ id: 'sms1', amount: 500, trxid: 'TRX12345' }] }],
      ['WHERE id = $1 AND status = \'pending\' AND type = \'recharge\'', { rows: [{ id: 't1', user_id: 'u1', amount: 500, trxid: 'TRX12345', status: 'pending' }] }],
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

  test('pending submit → admin auto-approve NOT notified (pending push path unchanged)', async () => {
    const spy = jest.spyOn(push, 'notifyAutoApproveRecharge').mockResolvedValue({ ok: true, sent: 0 });
    db.__routeQuery([
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
    const TX = { id: 't1', user_id: 'u1', amount: '500', trxid: '9HXK2LQM4N', status: 'pending' };
    db.__routeQuery([
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
      ['FROM incoming_sms WHERE id', { rows: [{ id: 's1', amount: 500, matched_recharge_id: null }] }],
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

describe('frontend/wallet.html — gateway session invariants', () => {
  test('classic-form success branches on transaction.status (approved vs pending)', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'async function submitRecharge()');
    expect(body).toContain('d.transaction');
    expect(body).toContain("status==='approved'");
    expect(body).toContain('যোগ হয়েছে');
    expect(body).toContain('যাচাই');
  });

  test('session start performs NO network request (no admin notice possible)', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'function gwStartSession(');
    expect(body).not.toContain('ABC.api(');
    expect(body).not.toContain('fetch(');
  });

  test('timer expiry performs NO network request and cancels nothing', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'function gwExpireSession(');
    expect(body).not.toContain('ABC.api(');
    expect(body).not.toContain('fetch(');
    // Expiry stops timers/polling through gwStopAll (no cancel API exists:
    // a pending request simply stays pending for admin verification).
    expect(body).toContain('gwStopAll()');
    expect(fnSlice(src, 'function gwStopAll(')).toContain('clearInterval');
  });

  test('audit #20 — the session survives a reload: persisted + restored with polling', () => {
    const src = walletHtml();
    // persisted on start and on submit (TrxID + absolute deadline)
    const save = fnSlice(src, 'function gwSaveSession(');
    expect(save).toContain('localStorage.setItem');
    expect(save).toContain('endsAt');
    expect(save).toContain('submittedTrxid');
    expect(fnSlice(src, 'function gwStartSession(')).toContain('gwSaveSession()');
    expect(fnSlice(src, 'async function gwAutoMatch(')).toContain('gwSaveSession()');
    // restored on page load, after the wallet loads
    expect(src).toContain('loadWallet();\n  gwRestoreSession();');
    const restore = fnSlice(src, 'function gwRestoreSession(');
    expect(restore).toContain('localStorage.getItem');
    expect(restore).toContain('s.endsAt <= Date.now()'); // expired while away → cleared, not restored
    expect(restore).toContain('gw.timerId = setInterval(gwTick, 1000)');
    expect(restore).toContain('gwStartPolling()');
    expect(restore).toContain('gwPollOnce()'); // immediate flip-check, not 15s later
    // a done/expired session is cleared, never restored
    expect(src).toContain('gwClearSession(); // audit #20 — a done session is never restored');
    expect(src).toContain('gwClearSession(); // audit #20 — an expired session is never restored');
  });

  test('audit #19 — going to Manual pauses the timer/polling, returning resumes', () => {
    const src = walletHtml();
    const goManual = fnSlice(src, 'function gwGoManual(');
    // pause: freeze the deadline and stop both intervals
    expect(goManual).toContain('gw.pausedAt = Date.now()');
    expect(goManual).toContain('gwStopAll()');
    const back = fnSlice(src, 'function gwBackToAuto(');
    // resume: shift the deadline by the Manual dwell, restart
    // the timer (with an immediate tick) and the match polling
    expect(back).toContain('gw.endsAt += Date.now() - gw.pausedAt');
    expect(back).toContain('gwTick(); gw.timerId = setInterval(gwTick, 1000)');
    expect(back).toContain('if (gw.submitted && !gw.pollId) gwStartPolling()');
    // the session tracks the pause state from the start
    expect(src).toContain('done: false, pausedAt: null');
  });

  test('audit #18 — a done session never expires: the timer stops when done', () => {
    const src = walletHtml();
    // gwTick bails out on a done session, so expiry can never fire
    // on top of a success/reject card even if a path forgets to
    // stop the timer.
    const tick = fnSlice(src, 'function gwTick(');
    expect(tick).toContain('if (!gw || gw.done) return;');
    // every gw.done = true site stops the timer as well as polling
    const doneSites = src.split('gw.done = true;').length - 1;
    expect(doneSites).toBe(3);
    const timerStops = (src.match(/gwStopTimer\(\);/g) || []).length;
    expect(timerStops).toBeGreaterThanOrEqual(3);
    expect(fnSlice(src, 'function gwStopTimer(')).toContain('clearInterval(gw.timerId)');
  });

  test('session timer is 10 minutes with a last-minute warning', () => {
    const src = walletHtml();
    expect(src).toContain('GW_SESSION_SECONDS = 600');
    expect(src).toContain('GW_WARN_SECONDS = 60');
  });

  test('audit #21 — one session, one pending: a second Auto Match shows the pending state, no resubmit', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'async function gwAutoMatch(');
    // the guard runs before any /wallet/recharge call and returns
    // after re-rendering the pending state with the submitted TrxID
    expect(body).toContain('if (gw.submitted && gw.submittedTrxid) {');
    expect(body).toContain('SMS এখনো আসেনি');
    expect(body).toContain('esc(gw.submittedTrxid)');
    expect(body.indexOf('if (gw.submitted && gw.submittedTrxid)')).toBeLessThan(body.indexOf('/wallet/recharge'));
  });

  test('audit #22 — a manual-form pending is polled until it flips', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'async function submitRecharge(');
    // the pending branch starts the poll for the submitted TrxID
    expect(body).toContain('manualStartPolling(trxid, ok)');
    const poll = fnSlice(src, 'async function manualPollOnce(');
    expect(poll).toContain("'/wallet?limit=10'");
    expect(poll).toContain("tx.status === 'approved'");
    expect(poll).toContain("tx.status === 'rejected'");
    expect(poll).toContain('manualStopPolling()');
    const start = fnSlice(src, 'function manualStartPolling(');
    expect(start).toContain('setInterval');
    expect(start).toContain('15000');
    expect(start).toContain('manualPollOnce(trxid, okEl)');
  });

  test('audit #29 — all wallet copy says SMS-auto first, admin only as fallback; no SLA claim', () => {
    const src = walletHtml();
    // the contradicting lines are gone
    expect(src).not.toContain('এডমিন ভেরিফাই করলেই');
    expect(src).not.toContain('৫ থেকে ১৫ মিনিট');
    expect(src).not.toContain('এডমিন যাচাই করে দ্রুত ব্যালেন্স যুক্ত করবেন');
    // every spot now leads with the auto-approve truth
    expect(src).toContain('SMS মিললে স্বয়ংক্রিয়ভাবে ব্যালেন্স যোগ হবে, না হলে এডমিন যাচাই করে যোগ করবেন');
    expect(src).toContain('SMS মিললে রিচার্জ স্বয়ংক্রিয়ভাবে অনুমোদিত হয়, না হলে এডমিন যাচাই করে জমা করেন');
    expect(src).toContain('SMS মিললে স্বয়ংক্রিয়ভাবে মিলে যাবে, না হলে এডমিন যাচাই করবেন');
  });

  test('audit #30 — classic form validates like the gateway and maps every recharge code', () => {
    const src = walletHtml();
    const classic = fnSlice(src, 'async function submitRecharge(');
    // gateway-level validation in the classic form
    expect(classic).toContain('Number(amt) > 100000');
    expect(classic).toContain("/^01[3-9]\\d{8}$/.test(sender)");
    expect(classic).toContain('trxid.length < 4');
    // the shared Bengali map covers every recharge error code
    const map = fnSlice(src, 'function rechargeErrText(');
    for (const code of ['TOO_MANY_PENDING', 'INVALID_SENDER', 'INVALID_AMOUNT', 'INVALID_TRXID', 'INVALID_METHOD']) {
      expect(map).toContain("case '" + code + "'");
    }
    expect(classic).toContain('rechargeErrText(d.error)');
    const gw = fnSlice(src, 'async function gwAutoMatch(');
    expect(gw).toContain('rechargeErrText(d.error)');
    // no raw code reaches the customer on either recharge path
    expect(classic).not.toContain("(d.error||'ব্যর্থ')");
    expect(gw).not.toContain("(d.error || 'ব্যর্থ')");
  });

  test('audit #35 — history: full TrxID, method/sender, pending elapsed + SMS state, load-more + filters', () => {
    const src = walletHtml();
    // every transaction type has a Bengali label (no raw English type)
    for (const [type, bn] of [['cashback', 'ক্যাশব্যাক'], ['promo', 'প্রোমো'], ['debit', 'ডেবিট'], ['bonus', 'বোনাস']]) {
      expect(src).toContain(type + ":'" + bn + "'");
    }
    // the full TrxID is shown — the 24-char truncation is gone
    expect(src).not.toContain('x.slice(0, 24)');
    // method + paying number on the row
    expect(src).toContain('GW_METHOD_NAMES[t.method]');
    expect(src).toContain('t.sender_no');
    // pending rows: elapsed + SMS-arrived state
    const row = fnSlice(src, 'async function loadWallet(');
    expect(row).toContain('fmtElapsed(t.created_at)');
    expect(row).toContain('SMS এসেছে');
    expect(row).toContain('SMS এখনো আসেনি');
    expect(row).toContain('t.sms_arrived');
    // load-more + filters (the history list is no longer a hardcoded 10-row fetch;
    // the two remaining limit=10 fetches are the gateway/manual polls — item #38)
    const load = fnSlice(src, 'async function loadWallet(');
    expect(load).not.toContain("'/wallet?limit=10'");
    expect(load).toContain('TX_PAGE_SIZE');
    expect(src).toContain("id=\"txFilterType\"");
    expect(src).toContain("id=\"txFilterStatus\"");
    expect(src).toContain("id=\"txMoreBtn\"");
    expect(src).toContain('txLoadMore()');
    expect(src).toContain('txApplyFilter()');
  });

  test('audit #35 — the wallet + history inline scripts parse (no stray braces)', () => {
    // the #30 edit once left a stray `}` that closed submitRecharge
    // early; a syntax check keeps a broken page from shipping silently
    const inlineScript = (html) => {
      const start = html.indexOf('<script>', html.indexOf('app.js')) + '<script>'.length;
      const end = html.indexOf('</script>', start);
      return html.slice(start, end);
    };
    expect(() => new Function(inlineScript(walletHtml()))).not.toThrow();
    const historyHtml = fs.readFileSync(path.join(__dirname, '../../../frontend/history.html'), 'utf8');
    expect(() => new Function(inlineScript(historyHtml))).not.toThrow();
    // history page: search + kind filter + paged render
    expect(historyHtml).toContain('id="histSearch"');
    expect(historyHtml).toContain('id="histKind"');
    expect(historyHtml).toContain('id="histMoreBtn"');
    expect(historyHtml).toContain('HIST_PAGE = 20');
    expect(historyHtml).toContain('histFiltered()');
    // the deliverable PDF copy stays downloadable; records with no
    // documents show no download button (no fake link)
    expect(historyHtml).toContain("docs ? '<div class=\"hist-docs\">'");
  });

  test('no forbidden word in the wallet page copy', () => {
    expect(walletHtml().toLowerCase()).not.toContain('captcha');
  });

  test('auto is the default: session card precedes the classic manual card', () => {
    const src = walletHtml();
    expect(src.indexOf('id="gwCard"')).toBeGreaterThan(-1);
    expect(src.indexOf('id="classicRechargeCard"')).toBeGreaterThan(-1);
    expect(src.indexOf('id="gwCard"')).toBeLessThan(src.indexOf('id="classicRechargeCard"'));
  });

  test('manual button sits with the auto logic in step 1 and step 2', () => {
    const src = walletHtml();
    expect(src).toContain('onclick="gwGoManual()">📝 Manual-এ দিন');
    const step1 = src.slice(src.indexOf('id="gwStep1"'), src.indexOf('id="gwStep2"'));
    expect(step1).toContain('onclick="gwGoManual()"');
    const step2 = src.slice(src.indexOf('id="gwStep2"'), src.indexOf('id="gwExpired"'));
    expect(step2).toContain('onclick="gwGoManual()"');
  });

  test('manual section: hidden by default, holds the guide + classic form, auto shown', () => {
    const src = walletHtml();
    // The manual section itself is hidden on load; the auto card is not.
    const secOpen = src.slice(src.indexOf('id="manualSection"'), src.indexOf('id="manualSection"') + 120);
    expect(secOpen).toContain('display:none');
    const gwCardOpen = src.slice(src.indexOf('id="gwCard"'), src.indexOf('id="gwCard"') + 120);
    expect(gwCardOpen).not.toContain('display:none');
    // The section holds the back button, the classic form and the guide.
    const sec = src.slice(src.indexOf('id="manualSection"'), src.indexOf('Recharge Cashback Hub Card'));
    expect(sec).toContain('onclick="gwBackToAuto()"');
    expect(sec).toContain('id="classicRechargeCard"');
    expect(sec).toContain('id="manualGuide"');
    // The guide itself is no longer an inline hidden block: it is always
    // visible inside the manual section.
    const guideOpen = src.slice(src.indexOf('id="manualGuide"'), src.indexOf('id="manualGuide"') + 200);
    expect(guideOpen).not.toContain('display:none');
    const guide = src.slice(src.indexOf('id="manualGuide"'), src.indexOf('id="methods"'));
    expect(guide).toContain('Manual-এ দেওয়ার নির্দেশনা');
    expect(guide).toContain('যেকোনো নম্বরে টাকা পাঠান');
    expect(guide).toContain('TrxID লিখুন');
    expect(guide).toContain('রিকোয়েস্ট পাঠান');
    expect(guide).toContain('এডমিন যাচাই করে ব্যালেন্স যোগ করবেন');
  });

  test('gwGoManual navigates to the manual section (auto hidden, no inline reveal)', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'function gwGoManual(');
    expect(body).toContain("getElementById('gwCard')");
    expect(body).toContain("style.display = 'none'");
    expect(body).toContain("getElementById('manualSection')");
    expect(body).toContain("style.display = 'block'");
    expect(body).toContain('scrollIntoView');
    // No inline expand on the auto view: the guide is never revealed here,
    // and the classic card is never scrolled to directly.
    expect(body).not.toContain('manualGuide');
    expect(body).not.toContain('classicRechargeCard');
  });

  test('gwBackToAuto returns to the auto session card', () => {
    const src = walletHtml();
    const body = fnSlice(src, 'function gwBackToAuto(');
    expect(body).toContain("getElementById('manualSection')");
    expect(body).toContain("style.display = 'none'");
    expect(body).toContain("getElementById('gwCard')");
    expect(body).toContain("style.display = 'block'");
    expect(body).toContain('scrollIntoView');
  });

  test('expired-state manual button also navigates to the manual section', () => {
    const src = walletHtml();
    const expired = src.slice(src.indexOf('id="gwExpired"'), src.indexOf('id="manualSection"'));
    expect(expired).toContain('onclick="gwScrollManual()"');
    expect(fnSlice(src, 'function gwScrollManual(')).toContain('gwGoManual()');
  });

  test('classic form submit path unchanged inside the manual section', () => {
    const src = walletHtml();
    const card = src.slice(src.indexOf('id="classicRechargeCard"'), src.indexOf('Recharge Cashback Hub Card'));
    expect(card).toContain('id="amount"');
    expect(card).toContain('id="sender"');
    expect(card).toContain('id="trxid"');
    expect(card).toContain('onclick="submitRecharge()"');
    const body = fnSlice(src, 'async function submitRecharge()');
    expect(body).toContain("'/wallet/recharge'");
    expect(body).toContain('sender_no');
    expect(body).toContain('trxid');
  });
});
