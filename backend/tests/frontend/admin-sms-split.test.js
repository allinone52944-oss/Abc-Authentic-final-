/**
 * SMS hub split + delete UI (feat-sms-delete-ui, 2026-11-11).
 *
 * The SMS hub (TABS.sms renderer + AdmSms handlers) lived inside
 * admin.js, which left only 27 bytes of headroom under the 368000-byte
 * limit — so the delete UI (1514 bytes) could not fit. The hub now
 * lives in its own chunk frontend/js/admin-sms.js, loaded before
 * admin.js like admin-notify.js; admin.js keeps a one-line shim
 * (TABS.sms delegates to window.renderSmsTab at run time).
 *
 * The delete UI (backend already live in 2b99fc3):
 *  - a Delete button on each UNMATCHED card (never on matched cards —
 *    a matched SMS is payment evidence and the backend refuses it);
 *  - a bulk-delete button below the filter, only when ignored_total > 0;
 *  - AdmSms.del (confirm -> DELETE /admin/sms/:id -> toast + refresh;
 *    on failure shows the server's d.message, e.g. the MATCHED_SMS
 *    Bengali reason) and AdmSms.deleteIgnored (confirm with the count
 *    -> POST /admin/sms/delete-ignored -> toast with d.deleted +
 *    refresh).
 *
 * Approach: read the CURRENT admin-sms.js source and evaluate the
 * whole file in a sandbox with stubbed globals (stronger than
 * extracting single methods — it tests the file as shipped).
 * Fake fixture data only.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
const SMS_JS = path.join(FRONTEND, 'js', 'admin-sms.js');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

function fakeResponse({ ok, body }) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function loadSmsHub() {
  const src = fs.readFileSync(SMS_JS, 'utf8');
  // new Function keeps the stubs in scope regardless of strict mode.
  const factory = new Function('window', 'ABC', 'bn', 'esc', 'content', 'location', // eslint-disable-line no-new-func
    'show', 'admToast', 'alert', 'confirm', 'prompt', 'document',
    src + '\nreturn { renderSmsTab: window.renderSmsTab, AdmSms: window.AdmSms };');
  return factory;
}

const UNMATCHED = {
  id: 'sms-fake-1', matched_recharge_id: null, method: 'bkash_payment',
  amount: 500, sender: 'bKash', trxid: 'FAKE-TRX-001',
  raw_message: 'Fake bKash message', created_at: '2026-11-11T10:00:00.000Z',
  user_name: null, user_phone: null, tx_amount: null, matched_via: null,
};
const MATCHED = {
  id: 'sms-fake-2', matched_recharge_id: 'tx-fake-9', method: 'nagad',
  amount: 1000, sender: 'Nagad', trxid: 'FAKE-TRX-002',
  raw_message: 'Fake Nagad message', created_at: '2026-11-11T11:00:00.000Z',
  user_name: 'Fake User', user_phone: '01000000000', tx_amount: 1000,
  matched_via: 'auto',
};
const PENDING = [{
  id: 'tx-fake-1', amount: 500, method: 'bkash_payment',
  sender_no: '01000000000', user_name: 'Fake User', trxid: 'FAKE-TRX-001',
}];

describe('SMS hub split (admin-sms.js)', () => {
  test('the SMS chunk lives in admin-sms.js, not in admin.js', () => {
    const sms = read('js/admin-sms.js');
    expect(sms).toContain('window.renderSmsTab = async () => {');
    expect(sms).toContain('window.AdmSms = {');
    expect(sms).toContain('function smsMethodBn(m) {');
    // Regression (2026-11-12, live "bn is not defined"): admin.js is an
    // IIFE, so its bn/esc are NOT global — the chunk must define its own.
    expect(sms).toContain('function bn(n){return Number(n||0).toLocaleString');
    expect(sms).toContain('function esc(s){return String(s==null');
    expect(sms).toContain("AdmSms.del(\\'' + s.id + '\\')");
    expect(sms).toContain('AdmSms.deleteIgnored(');
    expect(sms).toContain('async del(smsId) {');
    expect(sms).toContain('async deleteIgnored(n) {');

    const admin = read('js/admin.js');
    expect(admin).not.toContain('window.AdmSms = {');
    expect(admin).not.toContain('function smsMethodBn(m) {');
    expect(admin).not.toContain('SMS গেটওয়ে ও অটো-ম্যাচ হাব');
    expect(admin).not.toContain('AdmSms.deleteIgnored');
    expect(admin).toContain('TABS.sms = () => window.renderSmsTab();');
    expect(admin).toContain('admin-sms.js');
  });

  test('admin.js is smaller and the SMS chunk is a real file', () => {
    expect(fs.statSync(path.join(FRONTEND, 'js/admin.js')).size).toBeLessThan(368000);
    expect(fs.statSync(path.join(FRONTEND, 'js/admin-sms.js')).size).toBeGreaterThan(10000);
  });

  test('admin.html loads the SMS chunk BEFORE admin.js (and bumps its version)', () => {
    const html = read('admin.html');
    expect(html).toContain('<script src="/js/admin-sms.js?v=20261111-1"></script>');
    expect(html).toContain('<script src="/js/admin.js?v=20261111-11"></script>');
    expect(html.indexOf('admin-sms.js')).toBeLessThan(html.indexOf('/js/admin.js?v=20261111-11'));
  });
});

describe('SMS hub — render + delete UI', () => {
  let windowStub;
  let content;
  let toasts;
  let alerts;
  let confirms;
  let confirmImpl;
  let shown;
  let apiCalls;
  let apiImpl;
  let elements;
  let hub;

  function render(list, ignoredTotal) {
    apiImpl = async (url) => {
      if (url.includes('pending-recharges')) return fakeResponse({ ok: true, body: { pending: PENDING } });
      return fakeResponse({ ok: true, body: { sms: list, total: list.length, ignored_total: ignoredTotal, page: 1, limit: 30 } });
    };
    return hub.renderSmsTab();
  }

  beforeEach(() => {
    windowStub = {};
    content = { innerHTML: '' };
    toasts = [];
    alerts = [];
    confirms = [];
    confirmImpl = () => true;
    shown = [];
    apiCalls = [];
    apiImpl = null;
    elements = {};
    const factory = loadSmsHub();
    hub = factory(
      windowStub,
      { api: (...args) => { apiCalls.push(args); return apiImpl(...args); } },
      (n) => String(n || 0),
      (s) => s,
      content,
      { origin: 'https://fake.test' },
      (tab) => { shown.push(tab); },
      (title, message, type) => { toasts.push({ title, message, type }); },
      (msg) => { alerts.push(msg); },
      (msg) => { confirms.push(msg); return confirmImpl(msg); },
      () => null,
      { getElementById: (id) => elements[id] || null },
    );
  });

  test('Delete button appears only on the unmatched card, never on the matched card', async () => {
    await render([UNMATCHED, MATCHED], 0);
    const html = content.innerHTML;
    // Rendered HTML has plain quotes (the \' in the source is JS escaping).
    expect(html).toContain("AdmSms.del('sms-fake-1')");
    expect(html).not.toContain("AdmSms.del('sms-fake-2')");
    // Unmatched card keeps Match + Ignore; matched card has neither.
    expect(html).toContain("AdmSms.match('sms-fake-1')");
    expect(html).toContain("AdmSms.ignore('sms-fake-1')");
    expect(html).not.toContain("AdmSms.match('sms-fake-2')");
    expect(html).not.toContain("AdmSms.ignore('sms-fake-2')");
    expect(html).toContain('✅ ম্যাচড');
    expect(html).toContain('ম্যাচকৃত গ্রাহক');
  });

  test('bulk-delete button appears only when ignored_total > 0 and shows the count', async () => {
    await render([UNMATCHED], 3);
    expect(content.innerHTML).toContain('AdmSms.deleteIgnored(3)');
    expect(content.innerHTML).toContain('সব ignored SMS মুছুন');
    expect(content.innerHTML).toContain('৩টি'); // real bn() formats in Bengali (not the old English stub)

    await render([UNMATCHED], 0);
    expect(content.innerHTML).not.toContain('deleteIgnored');
  });

  test('match still works (no regression from the split)', async () => {
    elements['sms-tx-sms-fake-1'] = { value: 'tx-fake-1' };
    apiImpl = async (url, opts) => {
      expect(url).toBe('/admin/sms/sms-fake-1/match');
      expect(opts.method).toBe('POST');
      expect(opts.body.transaction_id).toBe('tx-fake-1');
      return fakeResponse({ ok: true, body: { ok: true } });
    };
    await hub.AdmSms.match('sms-fake-1');
    expect(alerts).toEqual(['✅ ম্যাচ সফল! টাকা যোগ হয়েছে।']);
    expect(shown).toEqual(['sms']);
  });

  test('ignore still works (no regression from the split)', async () => {
    apiImpl = async (url, opts) => {
      expect(url).toBe('/admin/sms/sms-fake-1/ignore');
      expect(opts.method).toBe('POST');
      return fakeResponse({ ok: true, body: { ok: true } });
    };
    await hub.AdmSms.ignore('sms-fake-1');
    expect(confirms).toHaveLength(1);
    expect(apiCalls).toHaveLength(1);
    expect(shown).toEqual(['sms']);
  });

  test('del deletes on confirm, toasts and refreshes', async () => {
    apiImpl = async (url, opts) => {
      expect(url).toBe('/admin/sms/sms-fake-1');
      expect(opts.method).toBe('DELETE');
      return fakeResponse({ ok: true, body: { ok: true } });
    };
    await hub.AdmSms.del('sms-fake-1');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('স্থায়ীভাবে মুছে ফেলবেন');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('SMS মুছে ফেলা হয়েছে');
    expect(shown).toEqual(['sms']);
  });

  test('del shows the server message on failure (matched SMS) and does not refresh', async () => {
    apiImpl = async () => fakeResponse({
      ok: false,
      body: { error: 'MATCHED_SMS', message: 'এই SMS একটি রিচার্জের সাথে মিলেছে, তাই মুছে ফেলা যাবে না।' },
    });
    await hub.AdmSms.del('sms-fake-2');
    expect(alerts).toEqual(['এই SMS একটি রিচার্জের সাথে মিলেছে, তাই মুছে ফেলা যাবে না।']);
    expect(toasts).toHaveLength(0);
    expect(shown).toEqual([]);
  });

  test('del does nothing when confirm is cancelled', async () => {
    confirmImpl = () => false;
    await hub.AdmSms.del('sms-fake-1');
    expect(apiCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
    expect(shown).toEqual([]);
  });

  test('deleteIgnored confirms with the count, toasts the deleted count and refreshes', async () => {
    apiImpl = async (url, opts) => {
      expect(url).toBe('/admin/sms/delete-ignored');
      expect(opts.method).toBe('POST');
      return fakeResponse({ ok: true, body: { ok: true, deleted: 3 } });
    };
    await hub.AdmSms.deleteIgnored(3);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('3টি');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Ignored SMS মোছা হয়েছে');
    expect(toasts[0].message).toContain('3টি');
    expect(shown).toEqual(['sms']);
  });

  test('deleteIgnored does nothing when confirm is cancelled', async () => {
    confirmImpl = () => false;
    await hub.AdmSms.deleteIgnored(3);
    expect(apiCalls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
    expect(shown).toEqual([]);
  });
});
