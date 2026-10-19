/**
 * Frontend unit tests — js/admin.js pure helpers + modal() (fix #7).
 *
 * admin.js is a large IIFE: most of it is DOM-heavy tab logic that cannot
 * be unit-tested without a browser. The genuinely pure/testable units are
 * `esc`, `bn`, `urlBase64ToUint8Array`, and `modal`/`closeModal` — but they
 * are NOT exported (only window.Adm*, window.VoiceAlert, window.PushNotify).
 *
 * Approach (no source modification): read the real file, extract the exact
 * function definitions by brace-matching, and evaluate them with a stubbed
 * `document`. The tests always run the CURRENT source text — if someone
 * edits esc/modal in admin.js, these tests exercise the edited version.
 * A final smoke test loads the whole script with stubs to prove it boots
 * and exposes its public API.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '../../../frontend/js/admin.js'),
  'utf8',
);

/** Extract the full `function name(...) { ... }` definition by brace matching. */
function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\('));
  if (!m) throw new Error('function not found in admin.js: ' + name);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error('unbalanced braces for: ' + name);
}

/** Minimal DOM stub sufficient for modal()/closeModal(). */
function makeDocument() {
  const created = [];
  const bodyChildren = [];
  const listeners = {};
  const doc = {
    // M-19 fix (2026-10-15): the stub was missing addEventListener, which
    // modal() calls — all 6 modal tests threw TypeError, leaving the XSS
    // title-escaping (FIX #7) unverified.
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = listeners[type];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    _listeners: listeners,
    createElement() {
      const el = {
        className: '',
        id: '',
        innerHTML: '',
        onclick: null,
        _removed: false,
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        remove() {
          this._removed = true;
          const i = bodyChildren.indexOf(this);
          if (i >= 0) bodyChildren.splice(i, 1);
        },
      };
      created.push(el);
      return el;
    },
    getElementById(id) {
      return created.find((e) => e.id === id && !e._removed) || null;
    },
    body: {
      appendChild(c) { bodyChildren.push(c); return c; },
      get children() { return bodyChildren; },
    },
  };
  return { doc, created, bodyChildren };
}

function loadHelpers(doc) {
  const names = ['esc', 'bn', 'closeModal', 'modal', 'urlBase64ToUint8Array'];
  const code = names.map((n) => extractFn(ADMIN_SRC, n)).join('\n');
  const factory = new Function('document', code + '\nreturn { esc, bn, modal, closeModal, urlBase64ToUint8Array };');
  return factory(doc);
}

describe('esc() — HTML escaping', () => {
  test('escapes all five special characters', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test('escapes a realistic XSS payload', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(esc(`' onmouseover='alert(1)`)).toBe('&#39; onmouseover=&#39;alert(1)');
  });

  test('null and undefined become empty string', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('coerces non-strings via String()', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc(0)).toBe('0');
    expect(esc(123)).toBe('123');
    expect(esc(true)).toBe('true');
  });

  test('leaves plain text untouched', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc('সাধারণ টেক্সট 123')).toBe('সাধারণ টেক্সট 123');
  });

  test('double-escapes already-escaped input (documented behavior)', () => {
    const { esc } = loadHelpers(makeDocument().doc);
    expect(esc('&lt;')).toBe('&amp;lt;');
  });
});

describe('bn() — Bengali digit formatting', () => {
  test('formats with bn-BD grouping and digits', () => {
    const { bn } = loadHelpers(makeDocument().doc);
    expect(bn(1234567)).toBe('১২,৩৪,৫৬৭');
    expect(bn(500)).toBe('৫০০');
  });

  test('zero, null, undefined → ০', () => {
    const { bn } = loadHelpers(makeDocument().doc);
    expect(bn(0)).toBe('০');
    expect(bn(null)).toBe('০');
    expect(bn(undefined)).toBe('০');
  });

  test('negatives and decimals', () => {
    const { bn } = loadHelpers(makeDocument().doc);
    expect(bn(-500)).toBe('-৫০০');
    expect(bn(99.5)).toBe('৯৯.৫');
  });

  test('non-numeric strings produce "NaN" (documented behavior)', () => {
    const { bn } = loadHelpers(makeDocument().doc);
    expect(bn('abc')).toBe('NaN');
  });

  test('numeric strings are formatted', () => {
    const { bn } = loadHelpers(makeDocument().doc);
    expect(bn('2500')).toBe('২,৫০০');
  });
});

describe('modal() — FIX #7 title escaping (XSS)', () => {
  test('escapes an XSS payload in the title', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    modal('<script>alert("pwned")</script>', '<p>body</p>');
    const bg = bodyChildren[0];
    expect(bg.className).toBe('modal-bg');
    expect(bg.id).toBe('admModal');
    expect(bg.innerHTML).toContain('<h3>&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;</h3>');
    expect(bg.innerHTML).not.toContain('<script>alert');
  });

  test('escapes quotes and ampersands in the title', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    modal(`Tom & "Jerry" 'x'`, '');
    expect(bodyChildren[0].innerHTML).toContain('Tom &amp; &quot;Jerry&quot; &#39;x&#39;');
  });

  test('null title renders as empty heading without throwing', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    expect(() => modal(null, '<p>b</p>')).not.toThrow();
    expect(bodyChildren[0].innerHTML).toContain('<h3></h3>');
  });

  test('bodyHtml is intentionally NOT escaped (trusted markup by design)', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    modal('Title', '<b>bold</b><input id="x">');
    expect(bodyChildren[0].innerHTML).toContain('<b>bold</b><input id="x">');
  });

  test('opening a second modal removes the first (only one #admModal)', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    modal('one', '');
    const first = bodyChildren[0];
    modal('two', '');
    expect(bodyChildren).toHaveLength(1);
    expect(first._removed).toBe(true);
    expect(bodyChildren[0].innerHTML).toContain('<h3>two</h3>');
  });

  test('clicking the backdrop closes the modal; clicking inside does not', () => {
    const { doc, bodyChildren } = makeDocument();
    const { modal } = loadHelpers(doc);
    modal('t', '');
    const bg = bodyChildren[0];
    expect(typeof bg.onclick).toBe('function');
    bg.onclick({ target: {} }); // click on inner content
    expect(bodyChildren).toHaveLength(1);
    bg.onclick({ target: bg }); // click on backdrop
    expect(bodyChildren).toHaveLength(0);
  });

  test('closeModal with no modal present does not throw', () => {
    const { doc } = makeDocument();
    const { closeModal } = loadHelpers(doc);
    expect(() => closeModal()).not.toThrow();
  });

  test('modal() source still routes the title through esc() (regression guard)', () => {
    // If someone later removes esc() from modal's title, this fails loudly.
    const modalSrc = extractFn(ADMIN_SRC, 'modal');
    expect(modalSrc).toMatch(/esc\s*\(\s*title\s*\)/);
  });
});

describe('urlBase64ToUint8Array() — VAPID key decoding', () => {
  test('decodes unpadded base64url ("hello")', () => {
    const { urlBase64ToUint8Array } = loadHelpers(makeDocument().doc);
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  test('decodes padded standard base64', () => {
    const { urlBase64ToUint8Array } = loadHelpers(makeDocument().doc);
    expect(Array.from(urlBase64ToUint8Array('aGk='))).toEqual([104, 105]);
  });

  test('translates url-safe chars - → + and _ → /', () => {
    const { urlBase64ToUint8Array } = loadHelpers(makeDocument().doc);
    // bytes [0xfb, 0xff] are '+/8=' in standard base64, '-_8' in base64url
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });

  test('empty input → empty array', () => {
    const { urlBase64ToUint8Array } = loadHelpers(makeDocument().doc);
    const out = urlBase64ToUint8Array('');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(0);
  });
});

describe('admin.js full-script smoke test', () => {
  function makeStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => m.set(String(k), String(v)),
      removeItem: (k) => { m.delete(String(k)); },
    };
  }

  beforeEach(() => {
    jest.resetModules();
    global.localStorage = makeStorage(); // VoiceAlert reads this at top level
    global.ABC = {
      api: jest.fn(async () => ({ ok: false, status: 401 })),
      clearTokens: jest.fn(),
    };
    global.location = { href: '' };
    global.window = {};
    global.document = {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ appendChild() {}, addEventListener() {} }),
      addEventListener: jest.fn(),
      readyState: 'complete', // run init() immediately
      body: { appendChild() {} },
      head: { appendChild() {} },
    };
    require('../../../frontend/js/admin.js');
  });

  afterEach(() => {
    delete global.localStorage;
    delete global.ABC;
    delete global.location;
    delete global.window;
    delete global.document;
  });

  test('boots without throwing and redirects to login when unauthenticated', async () => {
    await new Promise((r) => setTimeout(r, 50)); // let async init() settle
    expect(global.ABC.api).toHaveBeenCalledWith('/auth/me');
    expect(global.location.href).toBe('/login.html');
  });

  test('exposes the public tab controllers and helpers on window', () => {
    for (const k of ['AdmSvc', 'AdmCat', 'AdmUsers', 'AdmOrders', 'VoiceAlert', 'PushNotify']) {
      expect(global.window[k]).toBeDefined();
    }
    expect(typeof global.window.VoiceAlert.init).toBe('function');
    expect(typeof global.window.PushNotify.ensure).toBe('function');
  });
});

describe('TABS.stats — never renders undefined cards on API failure', () => {
  // Extract the `TABS.stats = async () => { ... }` assignment from the real
  // source and run it with stubbed ABC/content/esc/bn.
  function loadStatsTab() {
    const idx = ADMIN_SRC.indexOf('TABS.stats = async ()');
    expect(idx).toBeGreaterThan(-1);
    const open = ADMIN_SRC.indexOf('{', ADMIN_SRC.indexOf('=>', idx));
    let depth = 0, end = open;
    for (let i = open; i < ADMIN_SRC.length; i++) {
      if (ADMIN_SRC[i] === '{') depth++;
      else if (ADMIN_SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(depth).toBe(0);
    const assign = ADMIN_SRC.slice(idx, end + 1);
    const factory = new Function('ABC', 'content', 'esc', 'bn',
      'const TABS = {};\n' + assign + ';\nreturn TABS.stats;');
    return factory;
  }
  const escStub = (s) => String(s == null ? '' : s);
  const bnStub = (n) => String(Number(n || 0));

  test('throws (does not render) when /admin/stats returns 429', async () => {
    const stats = loadStatsTab()( { api: async () => ({ ok: false, status: 429, json: async () => ({ error: 'RATE_LIMITED' }) }) },
      { innerHTML: 'ORIGINAL' }, escStub, bnStub);
    await expect(stats()).rejects.toThrow('অনেক রিকোয়েস্ট');
  });

  test('leaves content untouched on 429 (no undefined cards)', async () => {
    const content = { innerHTML: 'ORIGINAL' };
    const stats = loadStatsTab()( { api: async () => ({ ok: false, status: 429, json: async () => ({ error: 'RATE_LIMITED' }) }) },
      content, escStub, bnStub);
    await expect(stats()).rejects.toThrow();
    expect(content.innerHTML).toBe('ORIGINAL');
  });

  test('renders stat numbers (no "undefined") on success', async () => {
    const data = { users: 5, admins: 1, orders_total: 10, orders_new: 2, orders_active: 3, orders_completed: 4, pending_recharge: 1, revenue_today: 500 };
    const content = { innerHTML: '' };
    const stats = loadStatsTab()( { api: async () => ({ ok: true, status: 200, json: async () => data }) },
      content, escStub, bnStub);
    await stats();
    expect(content.innerHTML).toContain('stat-grid');
    expect(content.innerHTML).toContain('৳500');
    expect(content.innerHTML).not.toContain('undefined');
  });
});

describe('init() — selective redirect on /auth/me failure (static guard)', () => {
  test('redirects to login only on 401/403/404, shows retry on 429/5xx', () => {
    const m = ADMIN_SRC.match(/async function init\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const src = m[0];
    // Must NOT blanket-redirect on every !r.ok
    expect(src).not.toMatch(/if\s*\(!r\.ok\)\s*\{\s*location\.href/);
    // Must redirect on real auth failures…
    expect(src).toContain("location.href = '/login.html'");
    expect(src).toMatch(/r\.status\s*===\s*401/);
    // …and show a retry UI for transient failures like 429
    expect(src).toMatch(/429/);
    expect(src).toContain('পুনরায় চেষ্টা');
  });
});

/**
 * Admin panel regression tests — one-click email verification (2026-10-15).
 * Static tests on frontend/js/admin.js: verify button + handler + status badge.
 */
const ADMIN_JS = path.join(__dirname, '..', '..', '..', 'frontend', 'js', 'admin.js');
let ajs;
beforeAll(() => { ajs = fs.readFileSync(ADMIN_JS, 'utf8'); });

describe('admin one-click email verify (2026-10-15)', () => {
  test('edit modal shows verify button for unverified users only', () => {
    expect(ajs).toMatch(/AdmUsers\.verifyEmail/);
    // Verified → badge, unverified → verify button (2026-10-17 UI improvement)
    expect(ajs).toMatch(/u\.email_verified \? '<div[^>]*>✅ ইমেইল যাচাইকৃত<\/div>'/);
    expect(ajs).toMatch(/: '<button[^>]*>✅ ইমেইল যাচাই করুন<\/button>/);
  });

  test('verifyEmail calls the backend endpoint with confirm', () => {
    const m = ajs.match(/async verifyEmail\(id\) \{([\s\S]*?)\n  \},/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/\/admin\/users\/' \+ id \+ '\/verify-email/);
    expect(m[1]).toMatch(/confirm\(/);
  });

  test('user list flags unverified emails', () => {
    expect(ajs).toMatch(/ইমেইল অযাচাইকৃত/);
    expect(ajs).toMatch(/u\.email_verified === false/);
  });
});


describe('admin panel navigation & premium workflows (2026-10-19)', () => {
  const ADMIN_HTML = path.join(__dirname, '..', '..', '..', 'frontend', 'admin.html');
  let ahtml;
  beforeAll(() => { ahtml = fs.readFileSync(ADMIN_HTML, 'utf8'); });

  test('admin.html categorizes sidebar navigation into distinct functional groups', () => {
    expect(ahtml).toContain('মূল নিয়ন্ত্রণ');
    expect(ahtml).toContain('অপারেশন ও লেনদেন');
    expect(ahtml).toContain('মার্কেটিং ও কন্টেন্ট');
    expect(ahtml).toContain('সিস্টেম ও অডিট');
    expect(ahtml).toMatch(/admin\.js\?v=51/);
  });

  test('admin.js exposes getAuthToken helper and uses it across downloads & uploads', () => {
    expect(ajs).toMatch(/function getAuthToken\(\)/);
    expect(ajs).toMatch(/AdmStorage\s*=\s*\{[\s\S]*?getAuthToken\(\)/);
    expect(ajs).toMatch(/AdmReports\s*=\s*\{[\s\S]*?getAuthToken\(\)/);
  });

  test('admin.js has live search and filter handlers for Recharge, Storage and Reports', () => {
    expect(ajs).toMatch(/AdmTx\s*=\s*\{[\s\S]*?search\(q\)/);
    expect(ajs).toMatch(/AdmStorage\s*=\s*\{[\s\S]*?search\(q\)/);
    expect(ajs).toMatch(/AdmReports\s*=\s*\{[\s\S]*?setPreset\(preset\)/);
  });

  test('reports tab does not reference undefined orders.length and aggregates byStatus safely', () => {
    const rpBlock = ajs.slice(ajs.indexOf("TABS.reports = async"), ajs.indexOf("TABS.monitor = async"));
    expect(rpBlock).not.toContain("orders.length");
    expect(rpBlock).toContain("Object.values(byStatus).reduce");
  });

  test('settings tab clearly differentiates admin live alerts from customer login greetings', () => {
    expect(ajs).toContain('অ্যাডমিন লাইভ অ্যালার্ট ও WhatsApp');
    expect(ajs).toContain('কাস্টমার লগইন ভয়েস শুভেচ্ছা');
  });
});
