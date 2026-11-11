/**
 * SMS-hub manual match — clear message for SMS_ALREADY_MATCHED (Bug 4, 2026-11-11).
 *
 * Before the fix, AdmSms.match() showed `alert('ব্যর্থ: ' + d.error)` for
 * every failure. When a racing actor (auto-match/webhook/another admin)
 * linked the SMS between the list render and the match click, the backend
 * collapsed the real code to generic MATCH_FAILED, so the admin saw the
 * raw code "ব্যর্থ: MATCH_FAILED" with no explanation. The backend now
 * preserves SMS_ALREADY_MATCHED, and match() shows a plain Bengali
 * message for it instead of the raw code.
 *
 * Approach (same pattern as admin-recharge-approve.test.js): read the
 * CURRENT admin.js source, extract the exact `match` method by
 * brace-matching, and evaluate it with stubbed globals. Fake fixture
 * data only.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_JS = path.join(__dirname, '../../../frontend/js/admin.js');

function loadSmsMatch() {
  const src = fs.readFileSync(ADMIN_JS, 'utf8');
  const start = src.indexOf('async match(smsId) {');
  if (start < 0) throw new Error('AdmSms.match not found in admin.js');
  const open = src.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces for AdmSms.match');
  const methodSrc = src.slice(start, i + 1);
  // new Function keeps the stubs in scope regardless of strict mode.
  const factory = new Function('document', 'alert', 'confirm', 'ABC', 'show', 'return ({' + methodSrc + '});'); // eslint-disable-line no-new-func
  return factory;
}

function fakeResponse({ ok, body }) {
  return { ok, json: async () => body };
}

describe('AdmSms.match — SMS_ALREADY_MATCHED message (Bug 4)', () => {
  let AdmSms;
  let alerts;
  let shown;
  let apiImpl;
  let selectedTx;

  beforeEach(() => {
    alerts = [];
    shown = [];
    apiImpl = null;
    selectedTx = 't-fake-1';
    const factory = loadSmsMatch();
    AdmSms = factory(
      { getElementById: () => (selectedTx ? { value: selectedTx } : null) },
      (msg) => { alerts.push(msg); },
      () => true,
      { api: (...args) => apiImpl(...args) },
      (tab) => { shown.push(tab); },
    );
  });

  test('SMS_ALREADY_MATCHED shows a plain Bengali message, not the raw code', async () => {
    apiImpl = async () => fakeResponse({ ok: false, body: { error: 'SMS_ALREADY_MATCHED' } });
    await AdmSms.match('s-fake-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe('এই SMS ইতিমধ্যে অন্য একটি রিচার্জে ব্যবহৃত হয়েছে। তালিকা নতুন করে দেখুন।');
    expect(alerts[0]).not.toContain('SMS_ALREADY_MATCHED');
    expect(alerts[0]).not.toContain('MATCH_FAILED');
    expect(shown).toEqual([]);
  });

  test('MATCH_FAILED still shows the raw-code alert unchanged', async () => {
    apiImpl = async () => fakeResponse({ ok: false, body: { error: 'MATCH_FAILED' } });
    await AdmSms.match('s-fake-1');
    expect(alerts).toEqual(['ব্যর্থ: MATCH_FAILED']);
    expect(shown).toEqual([]);
  });

  test('other errors (e.g. AMOUNT_MISMATCH) still show the raw-code alert unchanged', async () => {
    apiImpl = async () => fakeResponse({ ok: false, body: { error: 'AMOUNT_MISMATCH' } });
    await AdmSms.match('s-fake-1');
    expect(alerts).toEqual(['ব্যর্থ: AMOUNT_MISMATCH']);
    expect(shown).toEqual([]);
  });

  test('success path unchanged: success alert + sms tab shown', async () => {
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true } });
    await AdmSms.match('s-fake-1');
    expect(alerts).toEqual(['✅ ম্যাচ সফল! টাকা যোগ হয়েছে।']);
    expect(shown).toEqual(['sms']);
  });

  test('no recharge selected still shows the pick-a-request alert', async () => {
    selectedTx = null;
    await AdmSms.match('s-fake-1');
    expect(alerts).toEqual(['একটি রিচার্জ রিকোয়েস্ট বেছে নিন']);
    expect(shown).toEqual([]);
  });
});
