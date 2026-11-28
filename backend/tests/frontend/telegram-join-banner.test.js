/**
 * Telegram join banner — behaviour tests (frontend/js/app.js).
 *
 * The banner lives in the shared app shell (app.js): it invites
 * logged-in users to join the Telegram group until they join, then
 * never shows again. Join is permanent (localStorage flag + a
 * server-side flag via POST /api/user/telegram-joined); dismiss
 * ("পরে" / ✕) hides it only for the current session.
 *
 * These tests load the REAL app.js in a Node vm with a minimal DOM
 * shim (the repo's frontend-test pattern: no jsdom, no network).
 * fetch is stubbed; the server joined flag is driven by the
 * `serverJoined` variable.
 */

const APP_PATH = '../../../frontend/js/app.js';
const INVITE_URL = 'https://t.me/+vT8HVTCZ2zFmNjRl';

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => m.set(String(k), String(v)),
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
  };
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this._listeners = {};
    this._text = '';
    this.id = '';
    this.className = '';
  }
  // Real DOM textContent aggregates all descendant text; setting it
  // replaces the children. The banner test reads the popup's whole
  // copy through its container element, so the shim must match.
  get textContent() {
    let t = this._text || '';
    for (const child of this.children) t += child.textContent;
    return t;
  }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.children = [];
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners[type];
    if (a) { const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1); }
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i !== -1) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  click() {
    const fns = (this._listeners.click || []).slice();
    for (const fn of fns) fn({ type: 'click', target: this, preventDefault() {} });
  }
  getBoundingClientRect() {
    return { height: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0 };
  }
}

function walk(el, fn) {
  if (fn(el)) return el;
  for (const child of el.children) {
    const hit = walk(child, fn);
    if (hit) return hit;
  }
  return null;
}

function matchesSel(el, sel) {
  if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}

function makeDocument() {
  const body = new FakeEl('body');
  const head = new FakeEl('head');
  const docEl = new FakeEl('html');
  docEl.appendChild(head);
  docEl.appendChild(body);
  return {
    readyState: 'complete',
    body,
    head,
    documentElement: docEl,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => walk(docEl, (el) => el.id === id),
    querySelector: (sel) => walk(docEl, (el) => matchesSel(el, sel)),
    querySelectorAll: () => [],
    addEventListener: jest.fn(),
  };
}

const okJson = (data) => ({ ok: true, status: 200, json: async () => data });

let serverJoined = false;

function installGlobals(pathname) {
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  global.fetch = jest.fn(async (url, opts) => {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (String(url).includes('/user/telegram-joined')) {
      if (method === 'POST') return okJson({ joined: true });
      return okJson({ joined: serverJoined });
    }
    return okJson({});
  });
  global.navigator = {};
  global.document = makeDocument();
  global.window = {
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    matchMedia: () => ({ matches: false }),
    navigator: global.navigator,
    location: { pathname: pathname || '/dashboard.html', href: 'https://example.test/dashboard.html' },
    innerHeight: 800,
  };
  global.location = global.window.location;
}

function loadApp() {
  jest.resetModules();
  require(APP_PATH);
  return global.window.ABC;
}

function banner() {
  return global.document.getElementById('abc-telegram-banner');
}

function findInBanner(cls) {
  const bar = banner();
  if (!bar) return null;
  return walk(bar, (el) => el.className.split(/\s+/).includes(cls));
}

async function flush(times) {
  for (let i = 0; i < (times || 10); i++) await Promise.resolve();
}

function login() {
  global.localStorage.setItem('abc_refresh_token', 'rt-test');
}

beforeEach(() => {
  serverJoined = false;
  installGlobals('/dashboard.html');
});

afterEach(() => {
  jest.useRealTimers();
  delete global.localStorage;
  delete global.sessionStorage;
  delete global.fetch;
  delete global.navigator;
  delete global.document;
  delete global.window;
  delete global.location;
});

describe('telegram join banner', () => {
  test('shows the banner with the group invite when logged in and not joined', async () => {
    login();
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    const bar = banner();
    expect(bar).not.toBeNull();
    const join = findInBanner('tg-join');
    expect(join).not.toBeNull();
    expect(join.href).toBe(INVITE_URL);
    expect(join.target).toBe('_blank');
    expect(bar.textContent).toContain('ABC_Authentic ✓ Verified');
    expect(bar.textContent).toContain('অভিনন্দন বার্তা');
  });

  test('is a SMALL popup card, not a wide banner', async () => {
    login();
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).not.toBeNull();
    const styleEl = global.document.head.children.find((el) => el.tagName === 'STYLE');
    expect(styleEl).toBeDefined();
    const css = styleEl.textContent;
    // Compact fixed-size card anchored bottom-right…
    expect(css).toContain('width:320px');
    expect(css).toContain('max-width:calc(100vw - 24px)');
    expect(css).toContain('right:16px');
    // …never stretched edge-to-edge like a wide banner.
    expect(css).not.toContain('left:12px;right:12px');
    expect(css).not.toContain('left:12px;right:12px;bottom:12px');
  });

  test('never shows when the local joined flag is set', async () => {
    login();
    global.localStorage.setItem('abc_telegram_joined', '1');
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).toBeNull();
  });

  test('never shows on the login page', async () => {
    installGlobals('/login.html');
    login();
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('never shows when not logged in', async () => {
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Join click sets the joined flag, persists it server-side, and hides the banner', async () => {
    login();
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).not.toBeNull();
    findInBanner('tg-join').click();
    await flush();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBe('1');
    expect(banner()).toBeNull();
    const post = global.fetch.mock.calls.find(
      ([url, opts]) => String(url).includes('/user/telegram-joined')
        && String((opts && opts.method) || 'GET').toUpperCase() === 'POST',
    );
    expect(post).toBeDefined();
    expect(global.localStorage.getItem('abc_telegram_joined_synced')).toBe('1');
  });

  test('dismiss ("পরে") hides the banner but does NOT set the joined flag, and it returns next visit', async () => {
    login();
    let ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).not.toBeNull();
    findInBanner('tg-later').click();
    expect(banner()).toBeNull();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBeNull();
    expect(global.sessionStorage.getItem('abc_telegram_dismissed')).toBe('1');
    // Same session, fresh page load: still hidden.
    ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).toBeNull();
    // Next visit (session flag cleared): the banner returns.
    global.sessionStorage.removeItem('abc_telegram_dismissed');
    ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).not.toBeNull();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBeNull();
  });

  test('the ✕ button dismisses exactly like "পরে"', async () => {
    login();
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    findInBanner('tg-x').click();
    expect(banner()).toBeNull();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBeNull();
    expect(global.sessionStorage.getItem('abc_telegram_dismissed')).toBe('1');
  });

  test('server says joined: banner hidden and the local flag is adopted', async () => {
    login();
    serverJoined = true;
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).toBeNull();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBe('1');
  });

  test('server error: the banner still shows (local state is the fallback)', async () => {
    login();
    global.fetch.mockImplementation(async (url) => {
      if (String(url).includes('/user/telegram-joined')) {
        throw new Error('network down');
      }
      return okJson({});
    });
    const ABC = loadApp();
    await ABC.TelegramJoinBanner.ready;
    expect(banner()).not.toBeNull();
  });

  test('server check timeout: the banner shows instead of hanging', async () => {
    jest.useFakeTimers();
    login();
    global.fetch.mockImplementation(() => new Promise(() => {})); // never resolves
    const ABC = loadApp();
    expect(banner()).toBeNull();
    jest.advanceTimersByTime(2600);
    expect(banner()).not.toBeNull();
    expect(global.localStorage.getItem('abc_telegram_joined')).toBeNull();
  });
});
