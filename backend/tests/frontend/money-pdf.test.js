/**
 * Money/PDF fix cycle (2026-11-03) — bdris-apply.html regression tests.
 *
 * Covers the 8 cycle-4 items. Pure helpers are extracted by brace
 * matching and evaluated with stubs (same approach as
 * final-pack.test.js); browser-only wiring is pinned by static
 * patterns so it cannot be silently reverted. No personal values.
 *
 *  A14: numberless card's original-PDF button charges before the
 *       ack-validity check; sentinel 'সংরক্ষিত নয়' → MISSING_ACK.
 *  B6:  digits-only original flag creates a duplicate nameless row.
 *  B7:  delete paths lie (unconditional local remove, fire-and-
 *       forget server DELETE) — the only PDF copy can be destroyed.
 *  B8:  PDF charge keys differ by path → same PDF charged twice.
 *  B9:  dedupe treats the sentinel as a key.
 *  B10: original PDFs are unauthenticated static files; the DONE
 *       direct button bypasses the charge.
 *  C14: home PDF button has no watchdog.
 *  C21: covered by backend/tests/routes/bdris-apply.test.js
 *       (concurrent same-key charge → already-charged, not 500).
 */

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'bdris-apply.html');

let html;
beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
  expect(html.length).toBeGreaterThan(10000);
});

/** Extract the full `function name(...) { ... }` definition by brace matching. */
function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\('));
  if (!m) throw new Error('function not found: ' + name);
  // Keep a preceding `async ` — dropping it makes `await` inside illegal.
  const start = src.slice(m.index - 6, m.index) === 'async ' ? m.index - 6 : m.index;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for: ' + name);
}

function helpersSrc() {
  return [
    extractFn(html, 'canonicalAck'),
    extractFn(html, 'isSentinelAck'),
    extractFn(html, 'pdfChargeKey'),
    extractFn(html, 'dedupeAcks'),
  ].join('\n');
}

describe('canonical ack helpers (B6/B8/B9)', () => {
  test('canonicalAck strips everything but digits', () => {
    const run = new Function(`${helpersSrc()}; return { canonicalAck, isSentinelAck, pdfChargeKey };`);
    const h = run();
    expect(h.canonicalAck('12345678901234567')).toBe('12345678901234567');
    expect(h.canonicalAck('TRK-1234567890')).toBe('1234567890');
    expect(h.canonicalAck('আবেদন নম্বর: 1234567')).toBe('1234567');
    expect(h.canonicalAck('সংরক্ষিত নয়')).toBe('');
    expect(h.canonicalAck('')).toBe('');
    expect(h.canonicalAck(null)).toBe('');
  });

  test('sentinel and digitless values are never a key', () => {
    const run = new Function(`${helpersSrc()}; return { isSentinelAck, pdfChargeKey };`);
    const h = run();
    expect(h.isSentinelAck('সংরক্ষিত নয়')).toBe(true);
    expect(h.isSentinelAck('')).toBe(true);
    expect(h.isSentinelAck(null)).toBe(true);
    expect(h.isSentinelAck('1234567')).toBe(false);
    expect(h.pdfChargeKey('সংরক্ষিত নয়')).toBeNull();
    expect(h.pdfChargeKey('')).toBeNull();
    expect(h.pdfChargeKey('TRK-1234567')).toBe('pdf-1234567');
    expect(h.pdfChargeKey('1234567')).toBe('pdf-1234567');
  });

  test('dedupeAcks: same canonical number dedupes, sentinel entries pass through', () => {
    const run = new Function(`${helpersSrc()}; return dedupeAcks;`);
    const dedupeAcks = run();
    const list = [
      { id: 'a', no: 'TRK-1234567' },
      { id: 'b', no: '1234567' },
      { id: 'c', no: 'সংরক্ষিত নয়' },
      { id: 'd', no: 'সংরক্ষিত নয়' },
      { id: 'e', no: '7654321' },
    ];
    const out = dedupeAcks(list);
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('delAck honesty (B7)', () => {
  function makeEnv(fetchImpl) {
    let store = {};
    const localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    const notes = [];
    const src = [
      extractFn(html, 'canonicalAck'),
      extractFn(html, 'isSentinelAck'),
      extractFn(html, 'dedupeAcks'),
      extractFn(html, 'getAcks'),
      extractFn(html, 'delAck'),
    ].join('\n');
    const run = new Function('localStorage', 'fetch', 'getToken', 'note',
      `${src}; return delAck;`);
    return {
      localStorage,
      notes,
      seed: (acks) => { store.bdris_acks = JSON.stringify(acks); },
      read: () => JSON.parse(store.bdris_acks || '[]'),
      delAck: run(localStorage, fetchImpl, () => 'tok', (m) => notes.push(m)),
    };
  }

  test('failed server delete keeps the entry and reports failure', async () => {
    const calls = [];
    const env = makeEnv(async (url, opts) => {
      calls.push([url, opts]);
      return { ok: false, status: 500 };
    });
    env.seed([{ id: 'x1', no: '1234567', name: 'A' }]);
    const ok = await env.delAck('x1');
    expect(ok).toBe(false);
    expect(env.read()).toHaveLength(1);
    expect(env.notes.join(' ')).toMatch(/সার্ভার থেকে মোছা যায়নি/);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('/api/bdris-apply/applications/1234567');
  });

  test('successful server delete removes the entry', async () => {
    const env = makeEnv(async () => ({ ok: true, status: 200 }));
    env.seed([{ id: 'x1', no: '1234567', name: 'A' }]);
    const ok = await env.delAck('x1');
    expect(ok).toBe(true);
    expect(env.read()).toHaveLength(0);
  });

  test('sentinel card deletes locally without a server call', async () => {
    const calls = [];
    const env = makeEnv(async (url) => { calls.push(url); return { ok: true, status: 200 }; });
    env.seed([{ id: 'x1', no: 'সংরক্ষিত নয়', name: 'A', pdfB64: 'xx' }]);
    const ok = await env.delAck('x1');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(env.read()).toHaveLength(0);
  });
});

describe('home original-PDF wiring (A14/B8/C14)', () => {
  test('fetchHomeOriginal validates the ack BEFORE charging', () => {
    const src = extractFn(html, 'fetchHomeOriginal');
    const keyAt = src.indexOf('pdfChargeKey(ackNo)');
    const chargeAt = src.indexOf("charge('pdf'");
    const warnAt = src.indexOf('নম্বর সংরক্ষিত হয়নি');
    expect(keyAt).toBeGreaterThan(-1);
    expect(chargeAt).toBeGreaterThan(keyAt);
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(chargeAt);
  });

  test('both home buttons use the shared function (no raw key building)', () => {
    expect(html).toMatch(/data-srvorig[^;]*fetchHomeOriginal\(b, b\.dataset\.srvorig\)/);
    expect(html).toMatch(/data-orig[^;]*fetchHomeOriginal\(b, b\.dataset\.orig\)/);
    // No charge call anywhere still builds a raw 'pdf-' + value key.
    expect(html).not.toMatch(/charge\('pdf',\s*ackNo/);
    expect(html).not.toMatch(/charge\('pdf',\s*'pdf-'/);
  });

  test('home watchdog is bounded with an honest failure state', () => {
    const src = extractFn(html, 'armHomeOrigWatch');
    expect(src).toMatch(/setTimeout\(\(\) => \{[\s\S]*?120000/);
    expect(src).toMatch(/S\._origDone/);
    expect(src).toMatch(/আসল PDF আসেনি/);
    expect(html).toMatch(/S\._origProgressByAck/);
  });

  test('ORIGINAL_PDF outcome resets matching home buttons', () => {
    expect(html).toMatch(/els\('\[data-orig\]'\)\.forEach\(x => \{ if \(canonicalAck\(x\.dataset\.orig\) === ono\)/);
    expect(html).toMatch(/els\('\[data-srvorig\]'\)\.forEach\(x => \{ if \(canonicalAck\(x\.dataset\.srvorig\) === ono\)/);
  });
});

describe('delete handlers honesty (B7)', () => {
  test('local-card delete awaits delAck and claims success only on ok', () => {
    expect(html).toMatch(/const ok = await delAck\(b\.dataset\.ackdel\)/);
    expect(html).toMatch(/if \(ok\) note\('✔ সাম্প্রতিক আবেদন মুছে ফেলা হয়েছে'/);
  });

  test('server-card delete checks r.ok instead of rendering regardless', () => {
    const m = html.match(/data-srvdel[^]*?renderHome\(\);/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/if \(!r\.ok\)/);
    expect(m[0]).toMatch(/সার্ভার থেকে মোছা যায়নি/);
  });
});

describe('DONE direct path + download gate (B10)', () => {
  test('akOrig charges before downloading (no bare static download)', () => {
    const m = html.match(/const og = \$\('akOrig'\); if \(og\) og\.onclick = async \(\) => \{([\s\S]*?)\n  \};/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/pdfChargeKey\(no\)/);
    expect(m[1]).toMatch(/await charge\('pdf', key\)/);
    expect(m[1]).toMatch(/downloadOriginal\(origUrl, no\)/);
    expect(m[1].indexOf("charge('pdf'")).toBeLessThan(m[1].indexOf('downloadOriginal'));
  });

  test('downloadOriginal fetches with JWT + charge token, never a bare anchor', () => {
    const src = extractFn(html, 'downloadOriginal');
    // PREIUM-PRIVATE (2026-11-13): the copy comes from the owner-only
    // route — the bare /bdris-original-*.pdf URL is no longer a public
    // file, and fetching it was how a stored copy leaked.
    expect(src).toMatch(/fetch\('\/api\/bdris-apply\/applications\/' \+ encodeURIComponent\(canon\) \+ '\/original', \{ headers/);
    expect(src).toMatch(/'Authorization': 'Bearer ' \+ getToken\(\)/);
    expect(src).toMatch(/'X-Charge-Token'/);
    expect(src).toMatch(/URL\.createObjectURL/);
    expect(src).not.toMatch(/a\.href = url;/);
    expect(src).not.toMatch(/fetch\(\s*url/);
  });
});

describe('server-record key agreement (B6)', () => {
  test('COMPLETED extraction takes the longest digit run, not a truncated match', () => {
    expect(html).not.toMatch(/match\(\/\\d\{17\}\|\\d\{7,12\}\/\)/);
    expect(html).toMatch(/match\(\/\\d\{4,\}\/g\)/);
    expect(html).toMatch(/reduce\(\(a, b\) => \(b\.length > a\.length \? b : a\)\)/);
  });

  test('reportAckToServer sends the canonical ack', () => {
    const src = extractFn(html, 'reportAckToServer');
    expect(src).toMatch(/isSentinelAck\(a\.no\)/);
    expect(src).toMatch(/ack_no: canonicalAck\(a\.no\)/);
  });

  test('socket FETCH_ORIGINAL path uses the canonical charge key', () => {
    expect(html).toMatch(/var pdfKey = pdfChargeKey\(ackNo\);/);
  });
});
