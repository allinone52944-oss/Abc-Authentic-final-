// Office finder for the mouza wizard (step 1) — frontend only.
//
// Regression: the wizard's office dropdown held all 488 offices with no
// search, so finding one office meant scrolling the whole list; and 9
// display names collided across districts (19 keys) with no way to tell
// them apart. The fix adds an office search box + count line mirroring
// the mouza search pattern, and a verified district suffix on ONLY the
// colliding names (display-only — option values stay the office keys).
//
// These tests run the REAL wizard functions from frontend/land.html in a
// Node vm with a minimal DOM shim (the repo's frontend-test pattern: no
// jsdom, no exec-Chromium). Only the wizard slice is executed — not the
// whole page script — so no network, storage, or login stubs are needed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LAND_HTML = fs.readFileSync(
  path.join(__dirname, '../../../frontend/land.html'),
  'utf8',
);
// Audit #63 — the office table moved out of land.html into
// mouza-offices.json, fetched lazily when the mouza mode opens.
// The tests inject it directly (no network in the vm).
const MOUZA_JSON = fs.readFileSync(
  path.join(__dirname, '../../../frontend/mouza-offices.json'),
  'utf8',
);

function slice(from, to, label) {
  const a = LAND_HTML.indexOf(from);
  if (a === -1) throw new Error('marker not found: ' + label + ' :: ' + from);
  if (to == null) return LAND_HTML.slice(a);
  const b = LAND_HTML.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + label + ' :: ' + to);
  return LAND_HTML.slice(a, b);
}

function lineMatching(re, label) {
  const m = LAND_HTML.match(re);
  if (!m) throw new Error('line not found: ' + label);
  return m[0];
}

// Minimal select/option/input element: enough for wzFillOffices,
// wzFilterOffices, wzFillMouzas, wzOnOffice and wzResetWizard.
class El {
  constructor(tag) {
    this.tagName = tag;
    this.value = '';
    this.textContent = '';
    this.style = { display: '' };
    this.options = [];
    this.children = [];
    const cls = new Set();
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    };
  }
  appendChild(c) {
    this.children.push(c);
    if (c.tagName === 'OPTION') this.options.push(c);
    return c;
  }
  addEventListener() {}
  set innerHTML(v) {
    this.children = [];
    this.options = [];
    for (const m of String(v).matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)) {
      const o = new El('OPTION');
      o.value = m[1];
      o.textContent = m[2];
      this.options.push(o);
    }
  }
  get innerHTML() { return ''; }
}

function setup() {
  const els = new Map();
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, new El('DIV'));
      return els.get(id);
    },
    createElement: (tag) => new El(tag.toUpperCase()),
  };
  const parts = [
    "let MODE = 'mouza';",
    slice('const BN =', 'const esc', 'BN+bn'),
    slice('const $ =', 'function showErr', '$ helper'),
    lineMatching(/function clearBoxes\(\) \{[^}]*\}/, 'clearBoxes'),
    // Audit #63 — table from the JSON file, not the HTML.
    'let MOUZA_OFFICES = ' + MOUZA_JSON + ';',
    // Audit #63 — the real loader fetches; the tests run offline.
    'async function loadMouzaOffices() { return MOUZA_OFFICES; }',
    lineMatching(/const MOUZA_OTHER_OFFICE = '[^']+';/, 'MOUZA_OTHER_OFFICE'),
    lineMatching(/const MOUZA_MANUAL_MOUZA = '[^']+';/, 'MOUZA_MANUAL_MOUZA'),
    slice('const WZ = {', '  const WZ_STEP_IDS', 'WZ'),
    lineMatching(/const WZ_STEP_IDS = \{[^}]*\};/, 'WZ_STEP_IDS'),
    lineMatching(/const WZ_TITLES = \{[^}]*\};/, 'WZ_TITLES'),
    slice('function wzShowStep(step)', '  async function wzResetWizard()', 'wzShowStep'),
    slice('async function wzResetWizard()', '  // Duplicate display names', 'wzResetWizard'),
    slice('  // Duplicate display names', '  function wzFillMouzas()', 'district map + fill + filter'),
    slice('function wzFillMouzas()', '  function wzFilterMouzas()', 'wzFillMouzas'),
    slice('function wzFilterMouzas()', '  function wzOnOffice()', 'wzFilterMouzas'),
    slice('function wzOnOffice()', '  function wzOnMouza()', 'wzOnOffice'),
    'globalThis.__WZ = WZ;',
    'globalThis.__DISTRICTS = MOUZA_OFFICE_DISTRICTS;',
    'globalThis.__OFFICES = MOUZA_OFFICES;',
    'globalThis.__fn = { wzFillOffices, wzFilterOffices, wzOnOffice, wzResetWizard, wzFillMouzas };',
  ];
  const ctx = { document: doc, console };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n'), ctx);
  const $ = (id) => doc.getElementById(id);
  return { ctx, $, fn: ctx.__fn, WZ: ctx.__WZ, DISTRICTS: ctx.__DISTRICTS, OFFICES: ctx.__OFFICES };
}

function officeOptions($) {
  return $('mOffice').options.filter((o) => o.value && o.value !== '__other__');
}
function visibleOfficeOptions($) {
  return officeOptions($).filter((o) => o.style.display !== 'none');
}
function optionFor($, key) {
  return $('mOffice').options.find((o) => o.value === key);
}

// District suffix per key — verified individually from the batch data
// files (mouza count + batch-file district context), never inferred
// from key spelling: bare daulatpur is Manikganj's, bare kaliganj is
// Gazipur's, bare mirpur and bare nawabganj are Dhaka's.
const EXPECTED_DISTRICTS = {
  kachua: 'চাঁদপুর', 'kachua-bagerhat': 'বাগেরহাট',
  gauripur: 'কুমিল্লা', gouripur: 'ময়মনসিংহ',
  nawabganj: 'ঢাকা', 'nawabganj-dinajpur': 'দিনাজপুর',
  mirpur: 'ঢাকা', 'mirpur-kushtia': 'কুষ্টিয়া',
  daulatpur: 'মানিকগঞ্জ', 'daulatpur-kushtia': 'কুষ্টিয়া', 'daulatpur-thana-khulna': 'খুলনা',
  kaliganj: 'গাজীপুর', 'jhenaidah-kaliganj': 'ঝিনাইদহ',
  durgapur: 'রাজশাহী', 'durgapur-netrokona': 'নেত্রকোণা',
  'pirganj-rangpur': 'রংপুর', 'pirganj-thakurgaon': 'ঠাকুরগাঁও',
  'fulbari-dinajpur': 'দিনাজপুর', 'fulbari-kurigram': 'কুড়িগ্রাম',
};

describe('office finder markup + wiring', () => {
  test('search box sits above the office select, count line under it', () => {
    expect(LAND_HTML).toContain('id="wzOfficeSearch"');
    expect(LAND_HTML).toContain('placeholder="অফিসের নাম লিখে খুঁজুন…"');
    expect(LAND_HTML).toContain('id="wzOfficeCount"');
    const searchAt = LAND_HTML.indexOf('id="wzOfficeSearch"');
    const selectAt = LAND_HTML.indexOf('id="mOffice"');
    const countAt = LAND_HTML.indexOf('id="wzOfficeCount"');
    expect(searchAt).toBeLessThan(selectAt);
    expect(countAt).toBeGreaterThan(selectAt);
    expect(LAND_HTML).toContain("$('wzOfficeSearch').addEventListener('input', wzFilterOffices)");
    expect(LAND_HTML).toContain('function wzFilterOffices()');
  });
});

describe('office search behaviour (real wizard functions)', () => {
  test('(b) empty search shows all 488 offices with the full count', () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    expect(officeOptions($)).toHaveLength(488);
    expect(visibleOfficeOptions($)).toHaveLength(488);
    expect($('wzOfficeCount').textContent).toBe('৪৮৮টি অফিস');
  });

  test('(a) search narrows to substring matches and the count updates', () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    $('wzOfficeSearch').value = 'কচুয়া';
    fn.wzFilterOffices();
    expect(visibleOfficeOptions($).map((o) => o.value).sort()).toEqual([
      'kachua',
      'kachua-bagerhat',
    ]);
    expect($('wzOfficeCount').textContent).toBe('২টি মিলেছে');
  });

  test('(a) typing a district finds the suffixed duplicate, not its twin', () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    $('wzOfficeSearch').value = 'কুমিল্লা';
    fn.wzFilterOffices();
    expect(optionFor($, 'gauripur').style.display).toBe('');
    expect(optionFor($, 'gouripur').style.display).toBe('none');
  });

  test('(c) each of the 9 duplicate names carries a distinct district-suffixed label', () => {
    const { $, fn, DISTRICTS } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    expect(DISTRICTS).toEqual(EXPECTED_DISTRICTS);
    for (const [key, dist] of Object.entries(EXPECTED_DISTRICTS)) {
      const op = optionFor($, key);
      expect(op).toBeDefined();
      expect(op.textContent).toContain(' (' + dist + ')');
      expect(op.textContent).toContain(' — তালিকার হার আছে');
    }
    // Same base name, different suffixes — no two colliding keys share a label.
    const byName = {};
    for (const [key, dist] of Object.entries(EXPECTED_DISTRICTS)) {
      const base = optionFor($, key).textContent.split(' (')[0];
      (byName[base] = byName[base] || []).push(dist);
    }
    for (const [base, dists] of Object.entries(byName)) {
      expect(new Set(dists).size).toBe(dists.length);
    }
  });

  test('(c) non-duplicate labels stay exactly as before', () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    expect(optionFor($, 'boalkhali').textContent).toBe('বোয়ালখালী — তালিকার হার আছে');
    expect(optionFor($, 'chandgaon').textContent).toBe('চাঁদগাঁও থানা — তালিকার হার আছে');
  });

  test('(d) placeholder + "অন্য অফিস" stay visible on a non-matching query', () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    $('wzOfficeSearch').value = 'qqq-no-such-office';
    fn.wzFilterOffices();
    expect(visibleOfficeOptions($)).toHaveLength(0);
    const placeholder = $('mOffice').options.find((o) => o.value === '');
    const other = $('mOffice').options.find((o) => o.value === '__other__');
    expect(placeholder.style.display).toBe('');
    expect(other.style.display).toBe('');
    expect($('wzOfficeCount').textContent).toContain('কিছু মিলেনি');
    expect($('wzOfficeCount').textContent).toContain('অন্য অফিস');
  });

  test('(e) selecting a filtered office still yields its correct key', () => {
    const { $, fn, WZ, OFFICES } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    $('wzOfficeSearch').value = 'কচুয়া';
    fn.wzFilterOffices();
    $('mOffice').value = 'kachua-bagerhat';
    fn.wzOnOffice();
    expect(WZ.office).toBe('kachua-bagerhat');
    expect(WZ.covered).toBe(true);
    // Suffix is display-only: the report payload name stays the bare name.
    expect(WZ.officeName).toBe('কচুয়া');
    const mouzaValues = $('wzMouza').options.map((o) => o.value);
    // Frontend MOUZA_OFFICES holds mouza name arrays (unlike rates.js).
    expect(mouzaValues).toContain(OFFICES['kachua-bagerhat'].mouzas[0]);
    expect(mouzaValues).toContain('__manual__');
  });

  test('(f) reset restores the full list and clears the search box', async () => {
    const { $, fn } = setup();
    fn.wzFillOffices();
    fn.wzFilterOffices();
    $('wzOfficeSearch').value = 'কচুয়া';
    fn.wzFilterOffices();
    $('mOffice').value = 'kachua';
    fn.wzOnOffice();
    expect(visibleOfficeOptions($).length).toBeLessThan(488);
    // Audit #63 — the reset awaits the lazy office-list load.
    await fn.wzResetWizard();
    expect($('wzOfficeSearch').value).toBe('');
    expect($('mOffice').value).toBe('');
    expect(visibleOfficeOptions($)).toHaveLength(488);
    expect($('wzOfficeCount').textContent).toBe('৪৮৮টি অফিস');
  });
});

// Bug-hunt F5 — a failed mouza-table fetch must not poison the
// lazy-load cache. The old catch set MOUZA_OFFICES = {}; (truthy,
// so loadMouzaOffices short-circuited forever) and the fills threw
// on null. Now the table stays null, the promise is cleared, the
// next open retries, and the fills are null-safe.
function setupRetry() {
  const els = new Map();
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, new El('DIV'));
      return els.get(id);
    },
    createElement: (tag) => new El(tag.toUpperCase()),
  };
  let fetchCalls = 0;
  const table = { testoffice: { name: 'টেস্ট অফিস', mouzas: ['মৌজা ১', 'মৌজা ২'] } };
  const fetchStub = () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return Promise.reject(new Error('network down'));
    return Promise.resolve({ ok: true, json: async () => table });
  };
  const parts = [
    "let MODE = 'mouza';",
    slice('const BN =', 'const esc', 'BN+bn'),
    slice('const $ =', 'function showErr', '$ helper'),
    lineMatching(/function clearBoxes\(\) \{[^}]*\}/, 'clearBoxes'),
    // Real loader + real null table (not the injected JSON).
    slice('let MOUZA_OFFICES = null;', 'const MOUZA_CARD_CLASSES', 'real loader'),
    lineMatching(/const MOUZA_OTHER_OFFICE = '[^']+';/, 'MOUZA_OTHER_OFFICE'),
    lineMatching(/const MOUZA_MANUAL_MOUZA = '[^']+';/, 'MOUZA_MANUAL_MOUZA'),
    slice('const WZ = {', '  const WZ_STEP_IDS', 'WZ'),
    lineMatching(/const WZ_STEP_IDS = \{[^}]*\};/, 'WZ_STEP_IDS'),
    lineMatching(/const WZ_TITLES = \{[^}]*\};/, 'WZ_TITLES'),
    slice('function wzShowStep(step)', '  async function wzResetWizard()', 'wzShowStep'),
    slice('async function wzResetWizard()', '  // Duplicate display names', 'wzResetWizard'),
    slice('  // Duplicate display names', '  function wzFillMouzas()', 'district map + fill + filter'),
    slice('function wzFillMouzas()', '  function wzFilterMouzas()', 'wzFillMouzas'),
    slice('function wzFilterMouzas()', '  function wzOnOffice()', 'wzFilterMouzas'),
    slice('function wzOnOffice()', '  function wzOnMouza()', 'wzOnOffice'),
    'globalThis.__getOffices = () => MOUZA_OFFICES;',
    'globalThis.__fn5 = { loadMouzaOffices, wzFillOffices, wzFilterOffices, wzFillMouzas, wzOnOffice, wzResetWizard };',
  ];
  const ctx = { document: doc, console, fetch: fetchStub };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n'), ctx);
  const $ = (id) => doc.getElementById(id);
  return { ctx, $, fn: ctx.__fn5, getOffices: ctx.__getOffices, fetchCalls: () => fetchCalls, table };
}

describe('mouza table load failure (bug-hunt F5)', () => {
  test('a failed load leaves the table null and the next load retries (not poisoned)', async () => {
    const t = setupRetry();
    expect(t.getOffices()).toBeNull();
    await expect(t.fn.loadMouzaOffices()).rejects.toThrow('network down');
    expect(t.getOffices()).toBeNull(); // not {} — the loader retries
    const d = await t.fn.loadMouzaOffices();
    expect(d).toEqual(t.table);
    expect(t.getOffices()).toEqual(t.table);
    expect(t.fetchCalls()).toBe(2);
    // A third call uses the cached table, no third fetch.
    await t.fn.loadMouzaOffices();
    expect(t.fetchCalls()).toBe(2);
  });

  test('the fills do not throw on a null table, and only the manual option is offered', () => {
    const t = setupRetry();
    expect(() => {
      t.fn.wzFillOffices();
      t.fn.wzFilterOffices();
      t.fn.wzFillMouzas();
      t.fn.wzOnOffice();
    }).not.toThrow();
    const values = t.$('mOffice').options.map((o) => o.value);
    expect(values).toEqual(['', '__other__']);
    expect(t.$('wzOfficeCount').textContent).toBe('০টি অফিস');
  });

  test('wzResetWizard survives a failed load (manual path, note says why) and retries on the next open', async () => {
    const t = setupRetry();
    await t.fn.wzResetWizard(); // first fetch fails
    expect(t.getOffices()).toBeNull();
    expect(t.$('wzOfficeNote').textContent).toContain('অফিসের তালিকা আসেনি');
    expect(t.$('mOffice').options.map((o) => o.value)).toEqual(['', '__other__']);
    await t.fn.wzResetWizard(); // second fetch succeeds
    expect(t.getOffices()).toEqual(t.table);
    expect(t.$('wzOfficeNote').textContent).toBe('');
    expect(t.$('mOffice').options.map((o) => o.value)).toContain('testoffice');
    expect(t.$('wzOfficeCount').textContent).toBe('১টি অফিস');
  });
});
