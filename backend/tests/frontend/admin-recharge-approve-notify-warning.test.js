/**
 * Recharge approve — UI warning when the notification fails (Bug 6
 * follow-up, 2026-11-12).
 *
 * Bug 6's backend (5929e69, live) returns notify:{whatsapp, push,
 * whatsapp_error} in the approve response and logs a WhatsApp failure
 * server-side, but the frontend never showed it: the admin saw only
 * "রিচার্জ সফল 🎉" while the customer got no notification. The UI
 * warning was deferred because its 138-byte line did not fit in
 * admin.js's 27-byte headroom; the SMS delete UI split (4a18b5d)
 * freed 10663 bytes, so it fits now.
 *
 * The fix adds one line to AdmTx._doApprove()'s success path: after
 * the success toast, if d.notify && !d.notify.whatsapp, it also shows
 * admToast('সতর্কতা', 'গ্রাহককে জানানো যায়নি', 'error'). The type is
 * 'error' (not 'warn'): 'warn' is unused in the codebase, has no
 * toast-warn CSS class, and renders with a ✅ icon — while 'error' is
 * the codebase's problem signal and renders with the ⚠️ icon. The
 * title 'সতর্কতা' plus the success toast alongside make it clear the
 * approve succeeded and only the notification failed.
 *
 * Approach (same pattern as admin-recharge-approve-loading.test.js):
 * read the CURRENT admin.js source, extract the exact `_doApprove`
 * method by brace-matching, and evaluate it with stubbed globals.
 * Fake fixture data only.
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
  const doApproveSrc = extractMethod(src, '  async _doApprove(id) {');
  // new Function keeps the stubs in scope regardless of strict mode.
  const factory = new Function('modal', 'bn', 'esc', 'closeModal', 'ABC', 'admToast', 'show', // eslint-disable-line no-new-func
    'return ({' + doApproveSrc + '});');
  return factory;
}

function fakeResponse({ ok, body }) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

describe('AdmTx approve — warning when the notification fails (Bug 6 follow-up)', () => {
  let AdmTx;
  let toasts;
  let shown;
  let apiCalls;
  let apiImpl;

  beforeEach(() => {
    toasts = [];
    shown = [];
    apiCalls = [];
    apiImpl = null;
    const factory = loadAdmTx();
    AdmTx = factory(
      (title) => {},
      (n) => String(n || 0),
      (s) => s,
      () => {},
      { api: (...args) => { apiCalls.push(args); return apiImpl(...args); } },
      (title, message, type) => { toasts.push({ title, message, type }); },
      (tab) => { shown.push(tab); },
    );
  });

  test('approve success + WhatsApp FAILED shows BOTH the success and the warning', async () => {
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true, notify: { whatsapp: false, push: true, whatsapp_error: 'FAILED' } } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    // Success is still shown, AND the warning appears after it.
    expect(toasts).toHaveLength(2);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(toasts[1].title).toBe('সতর্কতা');
    expect(toasts[1].message).toBe('গ্রাহককে জানানো যায়নি');
    expect(toasts[1].type).toBe('error');
    expect(shown).toEqual(['recharge']);
  });

  test('approve success + WhatsApp SUCCEEDED shows NO warning (success only)', async () => {
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true, notify: { whatsapp: true, push: true } } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual(['recharge']);
  });

  test('approve success with notify:null (non-recharge) shows NO warning', async () => {
    apiImpl = async () => fakeResponse({ ok: true, body: { ok: true, notify: null } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual(['recharge']);
  });

  test('approve FAILURE shows no warning and no success toast', async () => {
    apiImpl = async () => fakeResponse({ ok: false, body: { error: 'ALREADY_PROCESSED' } });
    await AdmTx._doApprove('t-fake-1');
    expect(apiCalls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('অনুমোদন হয়নি');
    expect(toasts[0].title).not.toBe('সতর্কতা');
    expect(toasts[0].title).not.toBe('রিচার্জ সফল 🎉');
    expect(shown).toEqual([]);
  });
});
