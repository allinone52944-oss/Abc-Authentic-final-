/**
 * Recharge approve — server error vs network error (Bug 3, 2026-11-11).
 *
 * Before the fix, AdmTx._doApprove() wrapped the API call AND the JSON
 * parse in one try/catch: a non-JSON body (e.g. a 500 HTML error page
 * from the server/proxy) made r.json() throw a SyntaxError, and the
 * catch showed "নেটওয়ার্ক ত্রুটি" — the admin thought their network
 * was down when the server had errored, and could not tell whether the
 * approve had succeeded or failed.
 *
 * Approach (same pattern as admin.test.js): read the CURRENT admin.js
 * source, extract the exact `_doApprove` method by brace-matching, and
 * evaluate it with stubbed globals. Fake fixture data only.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_JS = path.join(__dirname, '../../../frontend/js/admin.js');

function loadDoApprove() {
  const src = fs.readFileSync(ADMIN_JS, 'utf8');
  const start = src.indexOf('async _doApprove(id) {');
  if (start < 0) throw new Error('_doApprove not found in admin.js');
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
  if (depth !== 0) throw new Error('unbalanced braces for _doApprove');
  const methodSrc = src.slice(start, i + 1);
  // new Function keeps the stubs in scope regardless of strict mode.
  const factory = new Function('closeModal', 'ABC', 'admToast', 'show', 'return ({' + methodSrc + '});'); // eslint-disable-line no-new-func
  return factory;
}

function fakeResponse({ ok, status, body, jsonThrows }) {
  return {
    ok,
    status,
    json: jsonThrows
      ? async () => { throw new SyntaxError('Unexpected token < in JSON'); }
      : async () => body,
  };
}

describe('AdmTx._doApprove — server error vs network error (Bug 3)', () => {
  let AdmTx;
  let toasts;
  let shown;
  let apiImpl;

  beforeEach(() => {
    toasts = [];
    shown = [];
    apiImpl = null;
    const factory = loadDoApprove();
    AdmTx = factory(
      () => {},
      { api: (...args) => apiImpl(...args) },
      (title, message, type) => { toasts.push({ title, message, type }); },
      (tab) => { shown.push(tab); },
    );
  });

  test('non-JSON 500 (HTML body) shows a SERVER error, not "নেটওয়ার্ক ত্রুটি"', async () => {
    apiImpl = async () => fakeResponse({ ok: false, status: 500, jsonThrows: true });
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('সার্ভার ত্রুটি');
    expect(toasts[0].title).not.toBe('নেটওয়ার্ক ত্রুটি');
    expect(toasts[0].type).toBe('error');
    expect(shown).toEqual([]);
  });

  test('fetch itself throwing still shows "নেটওয়ার্ক ত্রুটি"', async () => {
    apiImpl = async () => { throw new Error('fetch failed'); };
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('নেটওয়ার্ক ত্রুটি');
    expect(toasts[0].message).toBe('সার্ভারে সংযোগ করা যায়নি');
    expect(shown).toEqual([]);
  });

  test('synthetic 503 NETWORK_ERROR (ABC.api network failure) shows "নেটওয়ার্ক ত্রুটি"', async () => {
    apiImpl = async () => fakeResponse({ ok: false, status: 503, body: { error: 'NETWORK_ERROR' } });
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('নেটওয়ার্ক ত্রুটি');
    expect(shown).toEqual([]);
  });

  test('JSON error body ALREADY_PROCESSED still shows its mapped message unchanged', async () => {
    apiImpl = async () => fakeResponse({ ok: false, status: 400, body: { error: 'ALREADY_PROCESSED' } });
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('অনুমোদন হয়নি');
    expect(toasts[0].message).toBe('এই অনুরোধের সিদ্ধান্ত আগেই হয়েছে। তালিকা নতুন করে দেখুন।');
    expect(shown).toEqual([]);
  });

  test('JSON error body AMOUNT_MISMATCH still shows its mapped message unchanged', async () => {
    apiImpl = async () => fakeResponse({ ok: false, status: 400, body: { error: 'AMOUNT_MISMATCH' } });
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('অনুমোদন হয়নি');
    expect(toasts[0].message).toBe('SMS ও অনুরোধের পরিমাণ মিলছে না — টাকা জমা হয়নি।');
    expect(shown).toEqual([]);
  });

  test('success path unchanged: success toast + recharge tab shown', async () => {
    apiImpl = async () => fakeResponse({ ok: true, status: 200, body: { ok: true } });
    await AdmTx._doApprove('t-fake-1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual(['recharge']);
  });
});
