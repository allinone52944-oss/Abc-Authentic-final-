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
  const doc = {
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
