// Audit #73 — alert() is gone from every customer page; one shared
// inline-message component (ABC.showPageMsg + Bengali error maps)
// in frontend/js/app.js replaces it. bdris-apply uses its own
// note(); login.html (no app.js by design) has a tiny local banner
// in the same pattern. Admin JS keeps its alerts (working surface,
// not a customer page).
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

const CUSTOMER_PAGES = [
  'order-status.html', 'order-detail.html', 'history.html',
  'bdris-apply.html', 'wallet.html',
  'order-create.html', 'dashboard.html', 'login.html',
  'service-detail.html',
];

describe('audit #73 — no alert() on customer pages', () => {
  test('no alert( remains in any customer HTML page', () => {
    const left = [];
    for (const f of fs.readdirSync(FRONTEND).filter((x) => x.endsWith('.html'))) {
      if (f === 'admin.html') continue; // admin alerts live in admin.js (out of scope)
      if (read(f).includes('alert(')) left.push(f);
    }
    expect(left).toEqual([]);
  });

  test('each page routes its former alerts through the inline component', () => {
    const counts = {
      'order-status.html': 8, 'order-detail.html': 10, 'history.html': 4,
      'wallet.html': 3, 'order-create.html': 5,
      'dashboard.html': 2, 'service-detail.html': 2,
    };
    for (const [file, n] of Object.entries(counts)) {
      const hits = (read(file).match(/ABC\.showPageMsg\(/g) || []).length;
      expect(hits).toBeGreaterThanOrEqual(n);
    }
    // bdris-apply uses its own inline note(); login has a local banner.
    expect((read('bdris-apply.html').match(/note\(reason, 'err'\)/g) || []).length).toBe(2);
    expect(read('bdris-apply.html')).toContain("note(d.message || 'ব্যালেন্স অপর্যাপ্ত — রিচার্জ করুন', 'err')");
    expect(read('login.html')).toContain('function showLoginMsg(text)');
    expect(read('login.html')).not.toContain('alert(');
  });

  test('no raw error code reaches the user on the mapped paths', () => {
    expect(read('wallet.html')).not.toContain('(d.error ||');
    expect(read('bdris-apply.html')).not.toContain("return 'চার্জ ব্যর্থ হয়েছে — ' + d.error;");
    expect(read('bdris-apply.html')).toContain("if (d.error === 'CHARGE_FAILED') return 'চার্জ ব্যর্থ হয়েছে — আবার চেষ্টা করুন';");
    expect(read('order-status.html')).not.toContain("ST_TEXT[d.status] || d.status");
    expect(read('order-detail.html')).not.toContain("STBN[d.status] || d.status");
  });
});

describe('audit #73 — shared component in app.js', () => {
  test('app.js defines and exposes showPageMsg + the Bengali maps', () => {
    const app = read('js/app.js');
    expect(app).toContain('function showPageMsg(text, kind)');
    expect(app).toContain('function httpErrBn(status, action)');
    expect(app).toContain('function apiErrBn(d, fallback)');
    expect(app).toContain('showPageMsg, httpErrBn, apiErrBn');
    expect(app).toContain("id = 'abc-page-msg'");
  });

  test('every page that loads app.js loads the new version (v=20)', () => {
    // Pages that never loaded app.js (login, bdris-apply, 404/offline,
    // auth pages) are out of this pin — they use their own inline code.
    for (const f of fs.readdirSync(FRONTEND).filter((x) => x.endsWith('.html'))) {
      const html = read(f);
      if (!html.includes('/js/app.js?v=')) continue;
      expect(html).toContain('/js/app.js?v=20');
      expect(html).not.toContain('/js/app.js?v=19');
    }
  });
});

describe('audit #73 — shared component behavior (stubbed DOM)', () => {
  function loadApp() {
    jest.resetModules();
    const els = {};
    function makeEl(tag) {
      const el = {
        tagName: (tag || 'div').toUpperCase(),
        style: {},
        children: [],
        _listeners: {},
        setAttribute() {},
        appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; },
        addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
        remove() { this._removed = true; if (this.id) delete els[this.id]; },
        querySelector(sel) {
          const id = String(sel || '').replace(/^#/, '');
          return this.children.find((c) => c.id === id) || null;
        },
      };
      return el;
    }
    const body = makeEl('body');
    global.document = {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl(tag),
      addEventListener: jest.fn(),
      body,
      documentElement: makeEl('html'),
      head: makeEl('head'),
    };
    global.window = {
      addEventListener: jest.fn(),
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    };
    global.navigator = { standalone: false };
    global.localStorage = { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() };
    global.sessionStorage = { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() };
    jest.useFakeTimers();
    require('../../../frontend/js/app.js');
    return global.window.ABC;
  }

  afterEach(() => {
    jest.useRealTimers();
    delete global.document;
    delete global.window;
    delete global.navigator;
    delete global.localStorage;
    delete global.sessionStorage;
  });

  test('showPageMsg renders text (not HTML), colors by kind, reuses the banner', () => {
    const ABC = loadApp();
    ABC.showPageMsg('ডাউনলোড ব্যর্থ হয়েছে — ফাইলটি পাওয়া যায়নি।', 'err');
    let d = global.document.getElementById('abc-page-msg');
    expect(d).toBeTruthy();
    expect(d.querySelector('#abc-page-msg-text').textContent).toBe('ডাউনলোড ব্যর্থ হয়েছে — ফাইলটি পাওয়া যায়নি।');
    expect(d.style.cssText).toContain('#fef2f2');
    // HTML in the message is shown as text, never injected.
    ABC.showPageMsg('<script>alert(1)</script>', 'err');
    const span = d.querySelector('#abc-page-msg-text');
    expect(span.textContent).toBe('<script>alert(1)</script>');
    expect(span.children).toEqual([]);
    // ok reuses the same banner and recolors it.
    ABC.showPageMsg('কপি হয়েছে!', 'ok');
    expect(global.document.getElementById('abc-page-msg')).toBe(d);
    expect(d.style.cssText).toContain('#f0fdf4');
  });

  test('ok/info auto-hide; errors stay until dismissed', () => {
    const ABC = loadApp();
    ABC.showPageMsg('কপি হয়েছে!', 'ok');
    expect(global.document.getElementById('abc-page-msg')).toBeTruthy();
    jest.advanceTimersByTime(6000);
    expect(global.document.getElementById('abc-page-msg')).toBeNull();
    ABC.showPageMsg('ব্যর্থ হয়েছে।', 'err');
    jest.advanceTimersByTime(30000);
    expect(global.document.getElementById('abc-page-msg')).toBeTruthy();
  });

  test('httpErrBn maps statuses to Bengali, never a raw status', () => {
    const ABC = loadApp();
    expect(ABC.httpErrBn(404, 'ডাউনলোড')).toContain('পাওয়া যায়নি');
    expect(ABC.httpErrBn(403, 'ডাউনলোড')).toContain('অনুমতি নেই');
    expect(ABC.httpErrBn(500, 'আপলোড')).toContain('সার্ভারে সমস্যা');
    expect(ABC.httpErrBn(429, 'ডাউনলোড')).toContain('অনেক রিকোয়েস্ট');
    expect(ABC.httpErrBn(413, 'আপলোড')).toContain('১০ মেগাবাইট');
    expect(ABC.httpErrBn(0, 'ডাউনলোড')).toContain('সংযোগ');
    expect(ABC.httpErrBn(418, 'ডাউনলোড')).not.toContain('418');
  });

  test('audit #77 — a JS error shows only a friendly line + reload; detail goes to the console', () => {
    const ABC = loadApp();
    expect(ABC).toBeTruthy();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const errorHandler = global.window.addEventListener.mock.calls.find((c) => c[0] === 'error')[1];
    global.location = { reload: jest.fn() };
    errorHandler({ message: 'boom: undefined is not a function', lineno: 42 });
    const d = global.document.getElementById('abc-fatal');
    expect(d).toBeTruthy();
    const text = d.querySelector('#abc-fatal-text').textContent;
    expect(text).toBe('⚠️ পেজে সমস্যা হয়েছে — রিফ্রেশ করুন।');
    expect(text).not.toContain('boom');
    expect(text).not.toContain('42');
    expect(text).not.toContain('পেজ ত্রুটি');
    // Technical detail stays in the console.
    expect(errSpy).toHaveBeenCalledWith('[abc-fatal]', expect.stringContaining('boom'));
    expect(errSpy).toHaveBeenCalledWith('[abc-fatal]', expect.stringContaining('42'));
    // The reload button reloads the page.
    const btn = d.children.find((c) => c.tagName === 'BUTTON');
    expect(btn.textContent).toContain('রিফ্রেশ করুন');
    btn._listeners.click[0]();
    expect(global.location.reload).toHaveBeenCalled();
    errSpy.mockRestore();
    delete global.location;
  });

  test('apiErrBn maps known codes, falls back in Bengali, never leaks a raw code', () => {
    const ABC = loadApp();
    expect(ABC.apiErrBn({ error: 'INVALID_CODE' })).toContain('সঠিক নয়');
    expect(ABC.apiErrBn({ error: 'EXPIRED_CODE' })).toContain('মেয়াদ শেষ');
    expect(ABC.apiErrBn({ error: 'ALREADY_REDEEMED' })).toContain('ইতোমধ্যে রিডিম');
    expect(ABC.apiErrBn({ error: 'ALREADY_REDEEMED_TODAY' })).toContain('ইতোমধ্যে সংগ্রহ');
    expect(ABC.apiErrBn({ error: 'TOTALLY_UNKNOWN_CODE' })).toBe('ব্যর্থ হয়েছে — আবার চেষ্টা করুন।');
    expect(ABC.apiErrBn({ error: 'TOTALLY_UNKNOWN_CODE' })).not.toContain('TOTALLY_UNKNOWN_CODE');
    expect(ABC.apiErrBn({ message: 'সার্ভার বার্তা' })).toBe('সার্ভার বার্তা');
  });
});
