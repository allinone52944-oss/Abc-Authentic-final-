/**
 * Recharge approve — loading state / no double-click (Bug 5, 2026-11-11).
 *
 * Before the fix, AdmTx._doApprove() fired the approve API call with no
 * loading state: after closeModal() the row still showed as pending, so
 * on a slow response the admin clicked Approve again, confirmed again,
 * and the second API call came back 400 ALREADY_PROCESSED — "এই অনুরোধের
 * সিদ্ধান্ত আগেই হয়েছে।" — right after they had just approved it. No
 * money was lost (the backend guard blocks double credit), but the UX
 * was confusing.
 *
 * The fix tracks in-flight approve ids on AdmTx (this._appr, a Set):
 * approve() refuses to open a 2nd modal for an id already being
 * approved (and toasts "অনুমোদন চলছে"), and _doApprove() ignores a
 * 2nd call for the same id while one is in flight. A finally clears
 * the id on success AND failure, so the button is never permanently
 * disabled; the guard is per-id, so a different transaction still
 * approves in parallel.
 *
 * Approach (same pattern as admin-recharge-approve.test.js): read the
 * CURRENT admin.js source, extract the exact `approve` and `_doApprove`
 * methods by brace-matching, and evaluate them on one object with
 * stubbed globals. Fake fixture data only.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_JS = path.join(__dirname, '../../../frontend/js/admin.js');

function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(signature + ' not found in admin.js');
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
  if (depth !== 0) throw new Error('unbalanced braces for ' + signature);
  return src.slice(start, i + 1);
}

function loadAdmTx() {
  const src = fs.readFileSync(ADMIN_JS, 'utf8');
  const approveSrc = extractMethod(src, '  approve(id, amount, name) {');
  const doApproveSrc = extractMethod(src, '  async _doApprove(id) {');
  // new Function keeps the stubs in scope regardless of strict mode.
  const factory = new Function('modal', 'bn', 'esc', 'closeModal', 'ABC', 'admToast', 'show', // eslint-disable-line no-new-func
    'return ({' + approveSrc + ',' + doApproveSrc + '});');
  return factory;
}

function fakeResponse({ ok, body }) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('AdmTx approve — loading state / no double-click (Bug 5)', () => {
  let AdmTx;
  let toasts;
  let shown;
  let modals;
  let apiCalls;
  let apiImpl;

  beforeEach(() => {
    toasts = [];
    shown = [];
    modals = [];
    apiCalls = [];
    apiImpl = null;
    const factory = loadAdmTx();
    AdmTx = factory(
      (title) => { modals.push(title); },
      (n) => String(n || 0),
      (s) => s,
      () => {},
      { api: (...args) => { apiCalls.push(args); return apiImpl(...args); } },
      (title, message, type) => { toasts.push({ title, message, type }); },
      (tab) => { shown.push(tab); },
    );
  });

  test('2nd approve click on the same id while in flight makes NO 2nd API call', async () => {
    const d = deferred();
    apiImpl = () => d.promise;
    const first = AdmTx._doApprove('t-fake-1');
    // First call is in flight (ABC.api invoked, awaiting the deferred).
    expect(apiCalls).toHaveLength(1);
    // Second click on the same transaction: ignored, no 2nd API call.
    const second = AdmTx._doApprove('t-fake-1');
    await second;
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(0);
    // Finish the first call: success toast + list refresh, no confusion.
    d.resolve(fakeResponse({ ok: true, body: { ok: true } }));
    await first;
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual(['recharge']);
  });

  test('after a successful approve the same id is usable again', async () => {
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    // Approve the same transaction again: a fresh call is made.
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(2);
    expect(toasts).toHaveLength(2);
    expect(toasts[1].title).toBe('রিচার্জ সফল 🎉');
  });

  test('after a FAILED approve the same id is usable again (not permanently disabled)', async () => {
    apiImpl = async () => { throw new Error('offline'); };
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('নেটওয়ার্ক ত্রুটি');
    // Retry the same transaction: a fresh call is made, not blocked.
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(2);
    expect(toasts).toHaveLength(2);
    expect(toasts[1].title).toBe('রিচার্জ সফল 🎉');
  });

  test('a DIFFERENT transaction still approves while the first is in flight', async () => {
    const d1 = deferred();
    const d2 = deferred();
    apiImpl = (url) => (url.includes('t-fake-1') ? d1.promise : d2.promise);
    const first = AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    // Different id: not blocked by the first one's in-flight flag.
    const second = AdmTx._doApprove('t-fake-2');
    expect(apiCalls).toHaveLength(2);
    d1.resolve(fakeResponse({ ok: true, body: { ok: true } }));
    d2.resolve(fakeResponse({ ok: true, body: { ok: true } }));
    await first;
    await second;
    expect(toasts).toHaveLength(2);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(toasts[1].title).toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual(['recharge', 'recharge']);
  });

  test('approve() does not open a 2nd modal for an id already being approved', async () => {
    const d = deferred();
    apiImpl = () => d.promise;
    const first = AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    // Row Approve clicked again while in flight: no modal, "in progress" toast.
    AdmTx.approve('t-fake-1', 500, 'Fake Name');
    expect(modals).toHaveLength(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('অনুমোদন চলছে');
    // A different id still opens its modal.
    AdmTx.approve('t-fake-2', 500, 'Fake Name');
    expect(modals).toHaveLength(1);
    d.resolve(fakeResponse({ ok: true, body: { ok: true } }));
    await first;
    // After the first call settles, the same id opens its modal again.
    AdmTx.approve('t-fake-1', 500, 'Fake Name');
    expect(modals).toHaveLength(2);
  });
});
