// Gateway session pause/resume deadline — frontend only (bug-hunt F4).
//
// Audit #19/#20 froze the 10-minute gateway deadline while the user
// reads the manual instructions (gw.pausedAt), but the pause was only
// ever held in memory: gwSaveSession never persisted pausedAt, and
// neither gwGoManual nor gwBackToAuto saved the session. After a
// pause → resume, a page reload restored the stale pre-pause endsAt
// from localStorage, so the timer showed less time than the session
// really had and could expire early; a reload during Manual restored
// an un-paused session with the original deadline ticking.
//
// These tests run the REAL gateway functions from frontend/wallet.html
// in a Node vm with a minimal DOM shim (the repo's frontend-test
// pattern: no jsdom, no exec-Chromium). Only the gateway slice is
// executed — not the whole page script — so no network, storage, or
// login stubs are needed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WALLET_HTML = fs.readFileSync(
  path.join(__dirname, '../../../frontend/wallet.html'),
  'utf8',
);

function slice(from, to, label) {
  const a = WALLET_HTML.indexOf(from);
  if (a === -1) throw new Error('marker not found: ' + label + ' :: ' + from);
  if (to == null) return WALLET_HTML.slice(a);
  const b = WALLET_HTML.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + label + ' :: ' + to);
  return WALLET_HTML.slice(a, b);
}

// Minimal element: enough for gwRestoreSession / gwGoManual /
// gwBackToAuto (textContent, value, style.display, innerHTML).
class El {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = { display: '' };
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  addEventListener() {}
  scrollIntoView() {}
}

function setup() {
  const els = new Map();
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, new El());
      return els.get(id);
    },
    createElement: () => new El(),
  };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(k),
  };
  const calls = { tick: 0, timeline: 0, polling: 0, intervals: 0 };
  let nextTimerId = 1;
  const parts = [
    slice('const GW_METHOD_NAMES', 'function gwFmtDt', 'method names + gw state'),
    slice('function gwStopAll', 'function gwSaveSession', 'stop + store key'),
    slice('function gwSaveSession()', 'function gwClearSession()', 'gwSaveSession'),
    slice('function gwClearSession()', 'function gwRestoreSession()', 'gwClearSession'),
    slice('function gwRestoreSession()', 'function gwStopTimer()', 'gwRestoreSession'),
    slice('function gwGoManual()', 'function gwScrollManual()', 'gwGoManual'),
    slice('function gwBackToAuto()', 'async function gwAutoMatch()', 'gwBackToAuto'),
    'globalThis.__gw = { get: () => gw, set: (v) => { gw = v; } };',
    'globalThis.__fn = { gwSaveSession, gwClearSession, gwRestoreSession, gwGoManual, gwBackToAuto };',
  ];
  const ctx = {
    document: doc,
    localStorage,
    console,
    bn: (n) => String(n),
    rechargeNums: {},
    setInterval: () => { calls.intervals += 1; return nextTimerId++; },
    clearInterval: () => {},
    gwTick: () => { calls.tick += 1; },
    gwRenderTimeline: () => { calls.timeline += 1; },
    gwStartPolling: () => { calls.polling += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n'), ctx);
  const fn = ctx.__fn;
  const getGw = () => ctx.__gw.get();
  const setGw = (v) => ctx.__gw.set(v);
  const stored = () => {
    const raw = localStorage.getItem('abc_gw_session_v1');
    return raw ? JSON.parse(raw) : null;
  };
  const seedStored = (s) => localStorage.setItem('abc_gw_session_v1', JSON.stringify(s));
  const liveSession = (over = {}) => ({
    method: 'bkash_payment', sender: '01700000000', amount: 100,
    endsAt: Date.now() + 60000, timerId: null, pollId: null,
    submitted: false, submittedTrxid: null, done: false, pausedAt: null,
    ...over,
  });
  return { fn, getGw, setGw, stored, seedStored, liveSession, calls, store };
}

describe('gateway pause/resume deadline persistence (bug-hunt F4)', () => {
  test('gwSaveSession persists pausedAt', () => {
    const t = setup();
    const pausedAt = Date.now() - 5000;
    t.setGw(t.liveSession({ pausedAt }));
    t.fn.gwSaveSession();
    const s = t.stored();
    expect(s.pausedAt).toBe(pausedAt);
    expect(s.endsAt).toBe(t.getGw().endsAt);
  });

  test('gwGoManual persists the pause (reload during Manual keeps it paused)', () => {
    const t = setup();
    const endsAt = Date.now() + 60000;
    t.setGw(t.liveSession({ endsAt }));
    t.fn.gwGoManual();
    expect(t.getGw().pausedAt).toBeGreaterThan(0);
    const s = t.stored();
    expect(s.pausedAt).toBe(t.getGw().pausedAt);
    expect(s.endsAt).toBe(endsAt); // deadline frozen, not consumed
  });

  test('gwBackToAuto extends the deadline by the paused duration and persists it', () => {
    const t = setup();
    const now = Date.now();
    const endsAt = now + 60000;
    t.setGw(t.liveSession({ endsAt, pausedAt: now - 30000 }));
    t.fn.gwBackToAuto();
    const gw = t.getGw();
    expect(gw.pausedAt).toBeNull();
    // 60s remaining at pause + 30s paused ≈ 90s from now.
    expect(gw.endsAt).toBeGreaterThanOrEqual(now + 89000);
    expect(gw.endsAt).toBeLessThanOrEqual(now + 91000);
    const s = t.stored();
    expect(s.endsAt).toBe(gw.endsAt);
    expect(s.pausedAt).toBeNull();
  });

  test('gwRestoreSession shifts a paused deadline and resumes (persisted, so a second restore does not shift again)', () => {
    const t = setup();
    const now = Date.now();
    t.seedStored({
      method: 'bkash_payment', sender: '01700000000', amount: 100,
      endsAt: now + 60000, pausedAt: now - 30000, submitted: false,
    });
    expect(t.fn.gwRestoreSession()).toBe(true);
    const gw = t.getGw();
    expect(gw.pausedAt).toBeNull();
    // 60s remaining at pause + 30s paused ≈ 90s from now.
    expect(gw.endsAt).toBeGreaterThanOrEqual(now + 89000);
    expect(gw.endsAt).toBeLessThanOrEqual(now + 91000);
    // The resumed session is saved — a second restore must not
    // shift the deadline a second time.
    const savedEndsAt = t.stored().endsAt;
    expect(t.stored().pausedAt).toBeNull();
    expect(t.fn.gwRestoreSession()).toBe(true);
    expect(t.getGw().endsAt).toBeGreaterThanOrEqual(savedEndsAt - 1000);
    expect(t.getGw().endsAt).toBeLessThanOrEqual(savedEndsAt + 1000);
  });

  test('a session paused near its deadline is not cleared as expired on reload', () => {
    const t = setup();
    const now = Date.now();
    // Stale deadline already passed while the user read the manual
    // — but the pause froze it with 50s remaining, so the restore
    // must shift before the expiry check, not clear the session.
    t.seedStored({
      method: 'bkash_payment', sender: '01700000000', amount: 100,
      endsAt: now - 10000, pausedAt: now - 60000, submitted: false,
    });
    expect(t.fn.gwRestoreSession()).toBe(true);
    expect(t.getGw().endsAt).toBeGreaterThanOrEqual(now + 49000);
    expect(t.getGw().endsAt).toBeLessThanOrEqual(now + 51000);
  });

  test('an un-paused expired session is still cleared on restore', () => {
    const t = setup();
    t.seedStored({
      method: 'bkash_payment', sender: '01700000000', amount: 100,
      endsAt: Date.now() - 1000, submitted: false,
    });
    expect(t.fn.gwRestoreSession()).toBe(false);
    expect(t.stored()).toBeNull();
  });
});
