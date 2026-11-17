// E-Passport engine — frontend only (text-reading + vm).
//
// Flow (user direction 2026-11-17): entering the passport
// engine offers an MRP / e-passport choice; each leads to its
// OWN clean view (premium = separation). MRP keeps the
// existing flow exactly. E-passport: form → Create → real
// PDF, NO editor/workbench surface (like the MRP engine).
// The e-passport document is the user-provided document-data
// engine's template (57 fields, 3 slots), integrated with a
// ported minimal renderer (derive/render/slotGeometry).
//
// Editability (user requirement 2026-11-17): EVERY output
// field must be editable through the form. Verified here:
// all 27 data values change from the form; the 2 MRZ lines
// are GENERATED from the record (a deliberate deviation from
// the source file's read-only reference MRZ, which does not
// follow edits); the 30 heading/label values are template
// text, not user data, and stay as the template's own text.
// Photo (user requirement 2026-11-17): one upload → the
// document's photo slots. The source document has exactly
// TWO photo placements (primary + secondary portrait) — the
// test asserts photoSlotCount() === 2 and that one upload
// fills both. There is NO third placement in the source;
// do not invent one (see the build report).
//
// The passport number / names below are synthetic test
// fixtures, not real document data.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../../../frontend');
const EPASS_HTML = fs.readFileSync(path.join(FRONTEND, 'epassport.html'), 'utf8');
const MRP_HTML = fs.readFileSync(path.join(FRONTEND, 'passport.html'), 'utf8');
const SERVICE_DETAIL = fs.readFileSync(path.join(FRONTEND, 'service-detail.html'), 'utf8');
const FLOW_CSS = fs.readFileSync(path.join(FRONTEND, 'css/passport-flow.css'), 'utf8');

function extractModel(html) {
  const m = html.match(/<script type="application\/json" id="epassport-model">([\s\S]*?)<\/script>/);
  expect(m).toBeTruthy();
  return JSON.parse(m[1]);
}
function extractMainScript(html) {
  const m = html.match(/<script>\n\(function\(\)\{\n'use strict';([\s\S]*?)<\/script>/);
  expect(m).toBeTruthy();
  return m[0].slice('<script>\n'.length, -'</script>'.length);
}
const MODEL = extractModel(EPASS_HTML);
const MAIN_SCRIPT = extractMainScript(EPASS_HTML);

// ---------- minimal stub DOM ----------
function styleText(el) {
  const parts = [];
  if (el.style.cssText) parts.push(el.style.cssText);
  for (const k of Object.keys(el.style)) {
    if (k === 'cssText') continue;
    const v = el.style[k];
    if (v !== '' && v != null) parts.push(k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + v);
  }
  return parts.join(';');
}
function serialize(el) {
  const tag = el.tagName.toLowerCase();
  let attrs = '';
  if (el.id) attrs += ' id="' + el.id + '"';
  if (el._class && el._class.size) attrs += ' class="' + [...el._class].join(' ') + '"';
  const st = styleText(el);
  if (st) attrs += ' style="' + st + '"';
  if (el.src) attrs += ' src="' + el.src + '"';
  for (const k of Object.keys(el.dataset || {})) attrs += ' data-' + k + '="' + el.dataset[k] + '"';
  const inner = (el.textContent || '') + el.children.map(serialize).join('');
  if (tag === 'img' || tag === 'input' || tag === 'br' || tag === 'hr') return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
}
function makeEl(tag, id) {
  const listeners = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    parent: null,
    style: {},
    dataset: {},
    attributes: {},
    _class: new Set(),
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    src: '',
    alt: '',
    type: 'text',
    files: [],
    focused: false,
    _customValidity: '',
  };
  el.classList = {
    add: (c) => el._class.add(c),
    remove: (c) => el._class.delete(c),
    toggle: (c, f) => {
      if (f === undefined) { if (el._class.has(c)) el._class.delete(c); else el._class.add(c); }
      else if (f) el._class.add(c); else el._class.delete(c);
    },
    contains: (c) => el._class.has(c),
  };
  el.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  el.fire = (ev, arg) => { (listeners[ev] || []).forEach((fn) => fn(arg || { target: el })); };
  el.click = () => el.fire('click');
  el.focus = () => { el.focused = true; };
  el.appendChild = (child) => { child.parent = el; el.children.push(child); return child; };
  el.setAttribute = (k, v) => { el.attributes[k] = String(v); if (k === 'id') el.id = String(v); if (k.startsWith('data-')) el.dataset[k.slice(5)] = String(v); if (k === 'src') el.src = String(v); };
  el.getAttribute = (k) => el.attributes[k];
  el.removeAttribute = (k) => { delete el.attributes[k]; if (k.startsWith('data-')) delete el.dataset[k.slice(5)]; if (k === 'src') el.src = ''; };
  el.setCustomValidity = (v) => { el._customValidity = v; };
  el.decode = () => Promise.resolve();
  el.cloneNode = (deep) => {
    const c = makeEl(el.tagName.toLowerCase(), el.id);
    c.style = Object.assign({}, el.style);
    c.dataset = Object.assign({}, el.dataset);
    c.attributes = Object.assign({}, el.attributes);
    c._class = new Set(el._class);
    c.textContent = el.textContent;
    c.value = el.value;
    c.checked = el.checked;
    c.hidden = el.hidden;
    c.src = el.src;
    c.alt = el.alt;
    c.type = el.type;
    if (deep) el.children.forEach((ch) => c.appendChild(ch.cloneNode(true)));
    return c;
  };
  el.querySelectorAll = (sel) => {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (sel === '*') out.push(ch);
        else if (sel === '[data-engine]' && ch.dataset && ch.dataset.engine) out.push(ch);
        else if (sel === 'img[src]' && ch.tagName === 'IMG' && ch.src) out.push(ch);
        walk(ch);
      }
    };
    walk(el);
    return out;
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  Object.defineProperty(el, 'innerHTML', {
    get: () => el.children.map(serialize).join(''),
    set: () => { el.children = []; },
  });
  Object.defineProperty(el, 'outerHTML', { get: () => serialize(el) });
  return el;
}

const FORM_KEYS = [
  'givenName', 'surname', 'passportNo', 'docType', 'countryCode',
  'previousPassport', 'additionalNo', 'fatherName', 'motherName',
  'spouseName', 'dob', 'sex', 'issueDate', 'expiryDate', 'birthPlace',
  'nationality', 'nationalityCode', 'personalNo', 'authority',
  'address1', 'postalCode', 'district', 'sameEmergency',
  'emergencyName', 'relationship', 'emergencyAddress', 'phone',
  'mrz1', 'mrz2',
];

function runPage() {
  const els = {};
  const all = [];
  const reg = (el) => { if (el.id) els[el.id] = el; all.push(el); return el; };
  // Model script element (the JSON the page parses).
  const modelEl = reg(makeEl('script', 'epassport-model'));
  modelEl.textContent = JSON.stringify(MODEL);
  // Stage containers (mirror the page: #page-shell > #ep-stage >
  // #ep-scan + #ep-repairs + #ep-text-regions + #ep-asset-slots).
  const shell = reg(makeEl('div', 'page-shell'));
  const stage = reg(makeEl('div', 'ep-stage'));
  const scan = reg(makeEl('img', 'ep-scan'));
  scan.src = 'data:image/jpeg;base64,/9j/FAKE';
  const repairs = reg(makeEl('div', 'ep-repairs'));
  const regions = reg(makeEl('div', 'ep-text-regions'));
  const slots = reg(makeEl('div', 'ep-asset-slots'));
  const topRegions = reg(makeEl('div', 'ep-top-regions'));
  stage.appendChild(scan);
  stage.appendChild(repairs);
  stage.appendChild(regions);
  stage.appendChild(slots);
  stage.appendChild(topRegions);
  shell.appendChild(stage);
  // Form inputs (found via [data-engine="..."]).
  FORM_KEYS.forEach((k) => {
    const el = reg(makeEl(k === 'sex' ? 'select' : (k === 'mrz1' || k === 'mrz2' ? 'textarea' : 'input'), 'eng-' + k));
    el.dataset.engine = k;
    el.type = k === 'sameEmergency' ? 'checkbox' : (k === 'sex' ? 'select-one' : 'text');
  });
  // Other ids the script touches.
  ['create-message', 'toast', 'balVal', 'eng-passportPreview', 'form-sample-warning',
   'form-photo-status', 'form-photo-thumb', 'form-photo-name',
   'form-signature-status', 'form-signature-thumb', 'form-signature-name',
   'passport-price-line', 'create-passport-button', 'result-message',
   'start-passport-button', 'back-to-landing-button', 'download-again-button',
   'back-to-form-button', 'new-passport-button', 'eng-remrz', 'eng-reapply', 'eng-emergency-box',
   'form-photo-upload', 'form-signature-upload',
   'form-upload-photo-button', 'form-upload-signature-button',
   'form-remove-photo', 'form-remove-signature'].forEach((id) => {
    const el = reg(makeEl(id.includes('button') ? 'button' : (id.includes('upload') ? 'input' : 'p'), id));
    if (id === 'form-photo-upload' || id === 'form-signature-upload') el.type = 'file';
    if (id === 'form-photo-thumb' || id === 'form-signature-thumb') el.tagName = 'IMG';
  });
  // The warning carries hidden="" in the real HTML (it is set by
  // clearForm / showUploadState on first form entry, MRP-style).
  els['form-sample-warning'].hidden = true;
  // The upload buttons carry their add-labels in the real HTML.
  els['form-upload-photo-button'].textContent = 'ছবি যোগ করুন';
  els['form-upload-signature-button'].textContent = 'স্বাক্ষর যোগ করুন';
  const body = makeEl('body');
  body.classList.add('flow-landing');
  const documentStub = {
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => {
      const m = /^\[data-engine="([^"]+)"\]$/.exec(sel);
      if (m) return all.find((e) => e.dataset && e.dataset.engine === m[1]) || null;
      if (sel.startsWith('#')) return els[sel.slice(1)] || null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-engine]') return all.filter((e) => e.dataset && e.dataset.engine);
      const m = /^#([\w-]+) img\[src\]$/.exec(sel);
      if (m && els[m[1]]) return els[m[1]].querySelectorAll('img[src]');
      return [];
    },
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'canvas') {
        // Minimal 2D context: the barcode / perforation / cutout code
        // draws with it. getImageData synthesizes a photo — a white
        // backdrop with a dark person (central column, from 20% down
        // to the bottom edge) — so the cutout mask has a component
        // to find. toDataURL returns a fixed stub URL.
        el.getContext = () => ({
          fillStyle: '', strokeStyle: '', globalAlpha: 1, font: '',
          fillRect() {}, clearRect() {}, save() {}, restore() {},
          translate() {}, rotate() {}, scale() {}, drawImage() {},
          fillText() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
          moveTo() {}, lineTo() {}, closePath() {},
          measureText: (t) => ({ width: String(t).length * 8 }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          getImageData: (x, y, w, h) => {
            const W = el.width || w, H = el.height || h;
            const data = new Uint8ClampedArray(w * h * 4);
            for (let j = 0; j < h; j++) {
              for (let i = 0; i < w; i++) {
                const gx = x + i, gy = y + j;
                const idx = (j * w + i) * 4;
                const inPerson = gx >= W * 0.3 && gx < W * 0.7 && gy >= H * 0.2;
                const v = inPerson ? [80, 60, 50] : [255, 255, 255];
                data[idx] = v[0]; data[idx + 1] = v[1]; data[idx + 2] = v[2]; data[idx + 3] = 255;
              }
            }
            return { width: w, height: h, data };
          },
          putImageData() {},
        });
        el.toDataURL = () => 'data:image/png;base64,FAKE';
      }
      return el;
    },
    body,
    fonts: { ready: Promise.resolve() },
    readyState: 'complete',
    addEventListener: () => {},
  };
  const sandbox = {
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: async () => ({ ok: true }),
    sessionStorage: { getItem: () => '' },
    localStorage: { getItem: () => '' },
    // Stub Image: loads synchronously (100x100) so loadImage /
    // processPhotoCutout can run. The synthetic photo comes from
    // the canvas stub's getImageData, not from this image.
    Image: function () {
      const img = { width: 100, height: 100, naturalWidth: 100, naturalHeight: 100, _src: '' };
      Object.defineProperty(img, 'src', {
        set(v) { img._src = v; if (img.onload) img.onload(); },
        get() { return img._src; },
      });
      return img;
    },
  };
  sandbox.window = sandbox;
  sandbox.ABC = {
    api: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, engineId: 'epassport', price: 0, balance: 500, serviceId: 15, allowed: true }),
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(MAIN_SCRIPT, sandbox);
  const api = sandbox.window.epassportEngine;
  expect(api).toBeTruthy();
  return { api, els, all, documentStub };
}

// Independent ICAO TD3 check-digit computation (the test's own
// oracle — it does not reuse the page's mrzCheck).
function mrzCheck(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let v = 0;
    if (c >= '0' && c <= '9') v = +c;
    else if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 55;
    sum += v * [7, 3, 1][i % 3];
  }
  return String(sum % 10);
}
function mrzName(v) {
  return String(v || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[\s-]+/g, '<').replace(/[^A-Z<]/g, '');
}
function expectedMrz1() {
  return ('P<BGD' + mrzName('UDDIN') + '<<' + mrzName('RAHIM')).padEnd(44, '<');
}
function expectedMrz2() {
  const pp = 'EP0000001';
  const core = pp + mrzCheck(pp) + 'BGD' + '791217' + mrzCheck('791217') + 'M' + '300101' + mrzCheck('300101') + '<'.repeat(14) + mrzCheck('<'.repeat(14));
  return core + mrzCheck(core.slice(0, 10) + core.slice(13, 20) + core.slice(21, 43));
}

const FULL_FORM = {
  givenName: 'RAHIM', surname: 'UDDIN', passportNo: 'EP0000001',
  docType: 'P', countryCode: 'BGD', previousPassport: 'AB1234567',
  additionalNo: '999', fatherName: 'KARIM UDDIN', motherName: 'FATEMA BEGUM',
  spouseName: '', dob: '1979-12-17', sex: 'M',
  issueDate: '2020-01-01', expiryDate: '2030-01-01',
  birthPlace: 'DHAKA', nationality: 'BANGLADESHI', nationalityCode: 'BGD',
  personalNo: '1234567890', authority: 'DIP',
  address1: 'HOUSE 1 ROAD 2', postalCode: '1205', district: 'DHAKA',
  emergencyName: 'KARIM UDDIN', relationship: 'FATHER',
  emergencyAddress: 'HOUSE 1 ROAD 2', phone: '01700000000',
};
function fillForm(els, values) {
  for (const [k, v] of Object.entries(values)) {
    const el = els['eng-' + k];
    expect(el).toBeTruthy();
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

describe('selector (passport.html)', () => {
  test('landing offers MRP and e-passport as two clean choices', () => {
    expect(MRP_HTML).toContain('id="start-passport-button"');
    expect(MRP_HTML).toContain('id="start-epassport-button"');
    expect(MRP_HTML).toContain('passport-choice');
    expect(MRP_HTML).toContain('MRP পাসপোর্ট');
    expect(MRP_HTML).toContain('ই-পাসপোর্ট');
  });
  test('e-passport choice navigates to its own clean view', () => {
    expect(MRP_HTML).toContain("location.href='/epassport.html'");
  });
  test('MRP flow is unchanged (form, dates, Create, MRZ targets)', () => {
    expect(MRP_HTML).toContain('id="eng-givenName"');
    expect(MRP_HTML).toContain('id="eng-surname"');
    expect(MRP_HTML).toContain('id="eng-dob"');
    expect(MRP_HTML).toContain('class="date-input"');
    expect(MRP_HTML).toContain('id="create-passport-button"');
    expect(MRP_HTML).toContain('data-engine="mrz1"');
    expect(MRP_HTML).toContain('data-engine="mrz2"');
  });
});

describe('service-detail route', () => {
  test("epassport engine opens /epassport.html", () => {
    expect(SERVICE_DETAIL).toContain("'epassport'");
    expect(SERVICE_DETAIL).toContain("'/epassport.html'");
  });
});

describe('e-passport page structure', () => {
  test('model + stage + login gate + shared flow stylesheet', () => {
    expect(EPASS_HTML).toContain('id="epassport-model"');
    expect(EPASS_HTML).toContain('id="ep-stage"');
    expect(EPASS_HTML).toContain('id="ep-scan"');
    expect(EPASS_HTML).toContain('/login.html?next=');
    expect(EPASS_HTML).toContain('passport-flow.css?v=7');
  });
  test('form inputs fill their grid tracks (no mobile overflow)', () => {
    // Regression: the MRP page carries an inline rule making text
    // inputs width:100%; without it the e-passport inputs fall back
    // to their default ~233px size and overflow their 121px grid
    // tracks on mobile (right column clipped, no page scroll).
    expect(EPASS_HTML).toMatch(/#panel-engine input\[type=text\][^{]*\{[^}]*width:100%/);
    expect(EPASS_HTML).toMatch(/#panel-engine input\[type=text\][^{]*\{[^}]*min-width:0/);
  });
  test('photo/signature upload row fits its card on mobile (no right-column clip)', () => {
    // Regression (found by viewing the filled-form screenshot at
    // 360px): with files attached, the attached-file rows' nowrap
    // filenames set the plain 1fr tracks' min-content (~190/208px),
    // so the row ran ~140px past the card's right edge — the
    // signature upload button and its remove button unreachable,
    // with no page scroll. minmax(0,1fr) tracks + min-width:0 grid
    // items let both columns shrink to the card; the filename
    // ellipsizes instead. The shared stylesheet owns the row, so
    // this also repairs the MRP form, which clipped identically
    // once files were attached.
    expect(FLOW_CSS).toContain('.form-upload-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}');
    expect(FLOW_CSS).toContain('.form-upload-row>div{min-width:0}');
  });
  test('no editor/workbench surface: no contenteditable attribute; MRZ is editable like MRP', () => {
    // No element carries a contenteditable attribute (the script
    // only strips the attribute in cleanDocumentShell).
    expect(EPASS_HTML).not.toMatch(/contenteditable\s*=/);
    expect(EPASS_HTML).not.toContain('documentEditor');
    // MRP-style: the MRZ boxes are editable textareas with a
    // re-generate button AND a re-apply button (a hand edit is kept
    // until the next regenerate).
    expect(EPASS_HTML).not.toMatch(/id="eng-mrz1"[^>]*readonly/);
    expect(EPASS_HTML).not.toMatch(/id="eng-mrz2"[^>]*readonly/);
    expect(EPASS_HTML).toContain('id="eng-reapply"');
    expect(EPASS_HTML).toContain('পাতায় আবার বসান');
  });
  test('form mirrors the MRP serial: photo/signature first, then first/last name', () => {
    const photoAt = EPASS_HTML.indexOf('id="eng-photo-group"');
    const nameAt = EPASS_HTML.indexOf('id="eng-givenName"');
    const passportAt = EPASS_HTML.indexOf('id="eng-passportNo"');
    expect(photoAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(photoAt);
    expect(passportAt).toBeGreaterThan(nameAt);
  });
  test('model has 57 fields and 3 slots (2 photo + 1 signature)', () => {
    expect(MODEL.fields.length).toBe(57);
    expect(MODEL.slots.length).toBe(3);
    const photoSlots = MODEL.slots.filter((s) => s.asset === 'photo');
    expect(photoSlots.length).toBe(2);
    expect(photoSlots.map((s) => s.id).sort()).toEqual(['portrait', 'secondary-portrait']);
    expect(MODEL.slots.filter((s) => s.asset === 'signature').length).toBe(1);
  });
});

describe('date-paste universality (MRP rule, all formats)', () => {
  const { api } = runPage();
  const cases = [
    ['17/12/1979', '1979-12-17'],
    ['17-12-1979', '1979-12-17'],
    ['17.12.1979', '1979-12-17'],
    ['1979-12-17', '1979-12-17'],
    ['17 DEC 1979', '1979-12-17'],
    ['17 December 1979', '1979-12-17'],
    ['১৭/১২/১৯৭৯', '1979-12-17'],
    ['  17/12/1979\n', '1979-12-17'],
    ['12/17/1979', '1979-12-17'], // MM/DD fallback: second > 12
    ['17/12/1979', '1979-12-17'], // first > 12 → DD/MM
    ['05/06/1979', '1979-06-05'], // both ≤ 12 → DD/MM
    ['32/13/1979', ''],
    ['', ''],
  ];
  test.each(cases)('parsePastedDate(%s) → %s', (input, expected) => {
    expect(api.parsePastedDate(input)).toBe(expected);
  });
  test('invalid dates are still blocked', () => {
    expect(api.validDate('1979-02-30')).toBe(false);
    expect(api.validDate('1979-12-17')).toBe(true);
  });
});

describe('MRZ generation (independent ICAO oracle)', () => {
  test('both lines are 44 chars with correct check digits', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    expect(api.buildMrz1()).toBe(expectedMrz1());
    expect(api.buildMrz2()).toBe(expectedMrz2());
    expect(api.buildMrz1().length).toBe(44);
    expect(api.buildMrz2().length).toBe(44);
  });
  test('single name is never doubled in MRZ line 1', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, surname: '' });
    api.applyAll();
    const m1 = api.buildMrz1();
    expect(m1.startsWith('P<BGD<<<RAHIM')).toBe(true);
    expect((m1.match(/RAHIM/g) || []).length).toBe(1);
  });
});

describe('editability: every output field follows the form', () => {
  test('all 27 data values derive from the master record', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    const d = api.derive(api.state());
    expect(d['name']).toBe('RAHIM UDDIN');
    expect(d['father']).toBe('KARIM UDDIN');
    expect(d['mother']).toBe('FATEMA BEGUM');
    expect(d['spouse']).toBe('NA'); // empty spouse → NA (MRP rule)
    expect(d['permanent-address']).toBe('HOUSE 1 ROAD 2\n1205, DHAKA');
    expect(d['contact-name']).toBe('KARIM UDDIN');
    expect(d['relationship']).toBe('FATHER');
    expect(d['contact-address']).toBe('HOUSE 1 ROAD 2');
    expect(d['telephone']).toBe('01700000000');
    expect(d['type']).toBe('P');
    expect(d['country-code']).toBe('BGD');
    expect(d['passport-number']).toBe('EP0000001');
    expect(d['surname']).toBe('UDDIN');
    expect(d['given-name']).toBe('RAHIM');
    expect(d['nationality']).toBe('BANGLADESHI');
    expect(d['personal-no']).toBe('1234567890');
    expect(d['birth-date']).toBe('17 DEC 1979');
    expect(d['secondary-birth-date']).toBe('17.12.79');
    expect(d['previous-passport']).toBe('AB1234567');
    expect(d['sex']).toBe('M');
    expect(d['birthplace']).toBe('DHAKA');
    expect(d['printed-number']).toBe('999');
    expect(d['issue-date']).toBe('1 JAN 2020');
    expect(d['authority']).toBe('DIP');
    expect(d['expiry-date']).toBe('1 JAN 2030');
    expect(d['mrz-1']).toBe(expectedMrz1());
    expect(d['mrz-2']).toBe(expectedMrz2());
  });
  test('spouse name shows when given; previous passport blanks when empty', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, spouseName: 'AYESHA BEGUM', previousPassport: '' });
    api.applyAll();
    const d = api.derive(api.state());
    expect(d['spouse']).toBe('AYESHA BEGUM');
    expect(d['previous-passport']).toBe('');
  });
  test('output uppercases whatever case is typed in the form', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, givenName: 'rahim', surname: 'uddin', fatherName: 'karim uddin' });
    api.applyAll();
    const d = api.derive(api.state());
    expect(d['given-name']).toBe('RAHIM');
    expect(d['surname']).toBe('UDDIN');
    expect(d['father']).toBe('KARIM UDDIN');
    expect(els['eng-givenName'].value).toBe('rahim'); // the form keeps typed text
  });
  test('same-emergency tick reuses the permanent address', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    els['eng-sameEmergency'].checked = true;
    els['eng-emergencyAddress'].value = 'SOMEWHERE ELSE';
    api.applyAll();
    expect(api.derive(api.state())['contact-address']).toBe('HOUSE 1 ROAD 2\n1205, DHAKA');
  });
  test('headings/labels are template text, not user data (unchanged)', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    const d = api.derive(api.state());
    const heading = MODEL.fields.find((f) => f.id === 'personal-heading');
    expect(d['personal-heading']).toBe(heading.original);
  });
  test('render paints the derived values into the stage (regions + repairs)', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const region = els['ep-text-regions'].children.find((c) => c.dataset.field === 'given-name');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('RAHIM');
    expect(region._class.has('changed')).toBe(true);
    const repair = els['ep-repairs'].children.find((c) => c.dataset.field === 'given-name');
    expect(repair._class.has('active')).toBe(true);
  });
});

describe('upper page: name + address match the scan (position + font)', () => {
  // The render must use the source workbench's text calibration
  // (reference + uniform scale + model line-height), not the old
  // font-size shrink with line-height 'normal'. The old render
  // came out ~13-15% too wide with the address second line ~5px
  // too high; the calibrated render matches the scan (measured
  // on the real PDF at 400dpi: name width 367.7 -> 310.8 source
  // px, address pitch 64.8 -> 72.6 vs the scan's ~70).
  //
  // NOTE: the stub canvas measures 8px per character, so the
  // absolute scale factors below are stub artefacts; what these
  // tests pin is the MECHANISM (scale transform + model
  // line-height + formula width, no font-size shrink). The
  // absolute match to the scan was verified by measuring the
  // real PDF, not by these tests.
  function expectedCalibration(f, value) {
    const measure = (t) => String(t).length * 8; // stub canvas
    const longest = (t) => Math.max(...String(t || '').split('\n').map(measure), 1);
    const reference = f.ink && f.original ? f.ink / longest(f.original) : 1;
    const lines = Math.max(1, String(value).split('\n').length);
    const uniform = Math.min(1, (f.w - 8) / (longest(value) * reference), (f.h - 2) / ((f.line || f.size) * lines));
    return { reference, uniform, scaleX: reference * uniform, scaleY: uniform, width: (f.w - 8) / (reference * uniform) };
  }
  function regionFor(els, id) { return els['ep-text-regions'].children.find((c) => c.dataset.field === id); }
  function parseScale(transform) {
    const m = /^scale\(([\d.]+),([\d.]+)\)$/.exec(String(transform || ''));
    expect(m).toBeTruthy();
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  test('name region is calibrated: scale transform, model line-height, formula width, no font-size shrink', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const f = MODEL.fields.find((x) => x.id === 'name');
    const region = regionFor(els, 'name');
    expect(region).toBeTruthy();
    const exp = expectedCalibration(f, 'RAHIM UDDIN');
    const s = parseScale(region.style.transform);
    expect(s.x).toBeCloseTo(exp.scaleX, 2);
    expect(s.y).toBeCloseTo(exp.scaleY, 2);
    expect(region.style.lineHeight).toBe(f.line + 'px');
    expect(parseFloat(region.style.width)).toBeCloseTo(exp.width, 0);
    expect(region.style.fontSize).toBeFalsy();
    expect(region.style.transformOrigin).toBe('left top');
  });

  test('permanent address region uses the model line-height (the line pitch that was too tight)', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const f = MODEL.fields.find((x) => x.id === 'permanent-address');
    const region = regionFor(els, 'permanent-address');
    expect(region).toBeTruthy();
    expect(region.style.lineHeight).toBe(f.line + 'px');
    const exp = expectedCalibration(f, 'HOUSE 1 ROAD 2\n1205, DHAKA');
    const s = parseScale(region.style.transform);
    expect(s.x).toBeCloseTo(exp.scaleX, 2);
    expect(s.y).toBeCloseTo(exp.scaleY, 2);
    expect(region.style.fontSize).toBeFalsy();
  });

  test('a field with no ink in the model renders at reference 1 (spouse NA)', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const f = MODEL.fields.find((x) => x.id === 'spouse');
    const region = regionFor(els, 'spouse');
    expect(region).toBeTruthy();
    const exp = expectedCalibration(f, 'NA');
    const s = parseScale(region.style.transform);
    expect(s.x).toBeCloseTo(exp.scaleX, 2);
    expect(s.y).toBeCloseTo(exp.scaleY, 2);
    expect(region.style.lineHeight).toBe(f.line + 'px');
  });

  test('an empty value resets the calibration (no stale transform)', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, previousPassport: '' });
    api.applyAll();
    api.render();
    const prev = regionFor(els, 'previous-passport');
    expect(prev).toBeTruthy();
    expect(prev.textContent).toBe('');
    expect(prev.style.transform).toBeFalsy();
    expect(prev.style.width).toBe(MODEL.fields.find((x) => x.id === 'previous-passport').w + 'px');
    expect(prev.style.fontSize).toBeFalsy();
  });

  test('upper-page value fields render BOLD (700) — the scan is bold, not the workbench 400', () => {
    // User rebuke 2026-11-17: the side-by-side showed the scan's
    // upper-page values plainly heavier than the render. The workbench
    // model records weight 400 for these fields, but the scan's print
    // is bold (stroke ~7px vs regular ~5px at the model size; bold +
    // calibration scale matches the scan's stroke and width). The
    // side-by-side is the standard — no metric overrules it.
    const upperValueIds = ['name', 'father', 'mother', 'spouse',
      'permanent-address', 'contact-name', 'relationship',
      'contact-address', 'telephone'];
    for (const id of upperValueIds) {
      const f = MODEL.fields.find((x) => x.id === id);
      expect(f).toBeTruthy();
      expect(f.weight).toBe(700);
    }
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    for (const id of upperValueIds) {
      const region = regionFor(els, id);
      expect(region).toBeTruthy();
      expect(String(region.style.font || '')).toMatch(/^700 /);
    }
  });

  test('data-page values stay bold and small data-page labels stay regular (scope guard)', () => {
    for (const id of ['passport-number', 'surname', 'given-name', 'birth-date']) {
      expect(MODEL.fields.find((x) => x.id === id).weight).toBe(700);
    }
    for (const id of ['type-label', 'country-code-label', 'passport-number-label']) {
      expect(MODEL.fields.find((x) => x.id === id).weight).toBe(400);
    }
  });

  test('MRZ lines fit inside their region: no CSS letter-spacing on top of the ink calibration', () => {
    // Audit 2026-11-17: both MRZ lines overflowed the right page edge
    // (last character clipped; MRZ-1 reached 603.8pt on a 595pt page).
    // Root cause: the .region.mrz rule added letter-spacing:0.04em,
    // but fitText's width math never accounts for it — and the
    // reference calibration (ink / measured original) ALREADY includes
    // the scan's own letter spacing, so the CSS spacing double-counted
    // it and the lines came out ~4% too wide. The source workbench
    // has no MRZ letter-spacing at all.
    const mrzRule = EPASS_HTML.match(/#ep-text-regions \.region\.mrz\{[^}]*\}/);
    expect(mrzRule).toBeTruthy();
    expect(mrzRule[0]).not.toContain('letter-spacing');
    for (const id of ['mrz-1', 'mrz-2']) {
      const f = MODEL.fields.find((x) => x.id === id);
      expect(f).toBeTruthy();
      const value = id === 'mrz-1' ? expectedMrz1() : expectedMrz2();
      expect(value.length).toBe(44);
      const exp = expectedCalibration(f, value);
      // Real invariant (stub-canvas-free): the scan's own ink width,
      // shrunk by the same uniform factor fitText applies, fits the
      // region — the MRZ value is 44 chars like the original, so its
      // ink is the model's ink to within a glyph.
      expect(f.ink * exp.uniform).toBeLessThanOrEqual(f.w - 8);
    }
  });

  test('repair patches are valid images sized to their field boxes', () => {
    // Guards the patch regeneration (ghost removal): a corrupt or
    // mis-sized patch would blank the wrong area or break the render.
    // Patches are PNG or JPEG data URLs (the originals are JPEG,
    // regenerated ones PNG) — both are decoded for dimensions.
    function imageSize(dataUrl) {
      const b64 = String(dataUrl || '').split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      expect(buf.length).toBeGreaterThan(16);
      if (buf[0] === 0x89) { // PNG: IHDR width/height
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
      }
      expect(buf[0]).toBe(0xff); // JPEG: scan markers for SOF0/SOF2
      expect(buf[1]).toBe(0xd8);
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        off += 2 + buf.readUInt16BE(off + 2);
      }
      throw new Error('no SOF marker in patch image');
    }
    for (const f of MODEL.fields) {
      expect(f.patch).toBeTruthy();
      const size = imageSize(f.patch);
      // The patch is the scan crop round(x+w)-round(x); allow ±1px —
      // the workbench's older patches are 1px short in height after
      // the bff2273 calibration shift, which is invisible (the <img>
      // is stretched to the field box). This guards against a corrupt
      // or wrong-field patch, not rounding.
      const expW = Math.round(f.x + f.w) - Math.round(f.x);
      const expH = Math.round(f.y + f.h) - Math.round(f.y);
      expect(Math.abs(size.w - expW)).toBeLessThanOrEqual(1);
      expect(Math.abs(size.h - expH)).toBeLessThanOrEqual(1);
    }
  });
});

describe('photo propagation (one upload → both photo slots)', () => {
  test('photoSlotCount is 2 — the source has two photo placements, not three', () => {
    const { api } = runPage();
    expect(api.photoSlotCount()).toBe(2);
    expect(api.slotCount()).toBe(3);
  });
  test('one photo fills both slots with the same image; signature stays empty', () => {
    const { api, els } = runPage();
    api.state().assets.photo = { dataUrl: 'data:image/png;base64,AAA', width: 100, height: 100 };
    api.render();
    const slots = els['ep-asset-slots'].children;
    const portrait = slots.find((s) => s.dataset.slot === 'portrait');
    const secondary = slots.find((s) => s.dataset.slot === 'secondary-portrait');
    const signature = slots.find((s) => s.dataset.slot === 'signature');
    expect(portrait.children[1].src).toBe('data:image/png;base64,AAA');
    expect(secondary.children[1].src).toBe('data:image/png;base64,AAA');
    expect(portrait._class.has('active')).toBe(true);
    expect(secondary._class.has('active')).toBe(true);
    expect(signature.children[1].src).toBe('');
  });
  test('no signature → signature area is blanked by the clearPatch (MRP rule)', () => {
    const { api, els } = runPage();
    api.render();
    const signature = els['ep-asset-slots'].children.find((s) => s.dataset.slot === 'signature');
    expect(signature._class.has('active')).toBe(true); // clearPatch visible
    expect(signature.children[1].src).toBe(''); // no signature image
    expect(signature.children[0].src.startsWith('data:image/')).toBe(true); // clearPatch (JPEG after the inpainted regeneration)
  });
  test('sample warning shows on first form entry (clearForm), not at load', () => {
    const { api, els } = runPage();
    // At load the warning stays hidden (MRP: it is set by clearForm /
    // showUploadState on first form entry, not by initEngine).
    expect(els['form-sample-warning'].hidden).toBe(true);
    api.clearForm();
    expect(els['form-sample-warning'].hidden).toBe(false);
    expect(els['form-sample-warning'].textContent).toContain('নমুনার ছবি');
  });
});

describe('validation blocks Create with the reason named', () => {
  test('requiredMissing names the first missing required field', () => {
    const { api } = runPage();
    expect(api.requiredMissing()).toEqual(['passportNo', 'পাসপোর্ট নম্বর']);
    const { api: api2, els } = runPage();
    fillForm(els, FULL_FORM);
    api2.applyAll();
    expect(api2.requiredMissing()).toBeNull();
  });
  test('a fully valid form passes validation', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    // regenerate the MRZ textareas the way the page does, then validate
    els['eng-mrz1'].value = api.buildMrz1();
    els['eng-mrz2'].value = api.buildMrz2();
    expect(api.validateEngine()).toEqual([]);
  });
  test('bad passport number and bad date are flagged', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, passportNo: 'EP-0000001', dob: '32/13/1979' });
    api.applyAll();
    const issues = api.validateEngine();
    expect(issues.length).toBeGreaterThan(0);
    expect(els['eng-passportNo']._customValidity).not.toBe('');
    expect(els['eng-dob']._customValidity).not.toBe('');
  });
  test('issue date before birth date is flagged', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, dob: '2020-01-01', issueDate: '2019-01-01' });
    api.applyAll();
    expect(api.validateEngine().length).toBeGreaterThan(0);
  });
});

describe('snapshot (document-only HTML for the PDF render)', () => {
  test('A4 scale fits the 2890px stage on A4 width', () => {
    const { api } = runPage();
    expect(api.a4Scale()).toBeCloseTo(792 / 2890, 10);
    expect(api.a4Scale() * 4038).toBeLessThanOrEqual(1123); // fits one A4 page height
  });
  test('snapshot carries the stage, the fixed scale, and the derived MRZ — no editor chrome', async () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const snap = await api.snapshotHTML();
    expect(snap.html).toContain('id="ep-stage"');
    expect(snap.html).toContain('scale(0.2740484429');
    expect(snap.html).toContain(expectedMrz2());
    expect(snap.html).toContain('RAHIM');
    expect(snap.html).not.toContain('contenteditable');
    expect(snap.html).not.toContain('data-field=');
    expect(snap.html).not.toContain('data-slot=');
    expect(typeof snap.revision).toBe('number');
  });
});

describe('Point 1: DOB once → 2 derived places; passport number once → 4 places', () => {
  test('secondary birth date paints in the top layer (above the ghost photo)', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    api.render();
    const region = els['ep-top-regions'].children.find((c) => c.dataset.field === 'secondary-birth-date');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('17.12.79');
    // It must NOT be in the text layer (which the ghost photo covers).
    expect(els['ep-text-regions'].children.find((c) => c.dataset.field === 'secondary-birth-date')).toBeUndefined();
  });
  test('DOB derives to the data page, the secondary date, and MRZ-2', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    const d = api.derive(api.state());
    expect(d['birth-date']).toBe('17 DEC 1979');
    expect(d['secondary-birth-date']).toBe('17.12.79');
    expect(d['mrz-2']).toContain('791217');
  });
  test('Code 128 encoder matches bwip-js exactly (8 reference numbers)', () => {
    const { api } = runPage();
    // Reference runs extracted from bwip-js 4.11.4 toSVG output
    // (the independent oracle — the page's table is not reused).
    const cases = {
      EP0000001: [2, 1, 1, 2, 1, 4, 1, 3, 2, 1, 1, 3, 3, 1, 3, 1, 2, 1, 1, 2, 3, 1, 2, 2, 1, 1, 3, 1, 4, 1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 1, 1, 2, 4, 1, 2, 2, 3, 3, 1, 1, 1, 2],
      A12345678: [2, 1, 1, 2, 1, 4, 1, 1, 1, 3, 2, 3, 1, 1, 3, 1, 4, 1, 1, 1, 2, 2, 3, 2, 1, 3, 1, 1, 2, 3, 3, 3, 1, 1, 2, 1, 2, 4, 1, 1, 1, 2, 2, 2, 1, 1, 3, 2, 2, 3, 3, 1, 1, 1, 2],
      AB1234567: [2, 1, 1, 2, 1, 4, 1, 1, 1, 3, 2, 3, 1, 3, 1, 1, 2, 3, 1, 2, 3, 2, 2, 1, 1, 1, 3, 1, 4, 1, 3, 1, 2, 1, 3, 1, 1, 1, 3, 1, 2, 3, 1, 4, 1, 1, 2, 2, 1, 1, 1, 4, 2, 2, 2, 3, 3, 1, 1, 1, 2],
      ZZ9999999: [2, 1, 1, 2, 1, 4, 3, 1, 2, 3, 1, 1, 3, 1, 2, 3, 1, 1, 3, 2, 1, 1, 2, 2, 1, 1, 3, 1, 4, 1, 1, 1, 3, 1, 4, 1, 1, 1, 3, 1, 4, 1, 1, 1, 3, 1, 4, 1, 3, 3, 2, 1, 1, 1, 2, 3, 3, 1, 1, 1, 2],
      B00000002: [2, 1, 1, 2, 1, 4, 1, 3, 1, 1, 2, 3, 1, 1, 3, 1, 4, 1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 1, 3, 2, 3, 3, 1, 1, 1, 2],
      C11111111: [2, 1, 1, 2, 1, 4, 1, 3, 1, 3, 2, 1, 1, 1, 3, 1, 4, 1, 2, 3, 1, 2, 1, 2, 2, 3, 1, 2, 1, 2, 2, 3, 1, 2, 1, 2, 2, 3, 1, 2, 1, 2, 2, 2, 1, 2, 3, 1, 2, 3, 3, 1, 1, 1, 2],
      A00000001: [2, 1, 1, 2, 1, 4, 1, 1, 1, 3, 2, 3, 1, 1, 3, 1, 4, 1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 3, 2, 1, 2, 1, 2, 3, 3, 1, 1, 1, 2],
      '123456789': [2, 1, 1, 2, 3, 2, 1, 1, 2, 2, 3, 2, 1, 3, 1, 1, 2, 3, 3, 3, 1, 1, 2, 1, 2, 4, 1, 1, 1, 2, 1, 1, 4, 1, 3, 1, 3, 2, 1, 1, 2, 2, 1, 3, 4, 1, 1, 1, 2, 3, 3, 1, 1, 1, 2],
    };
    for (const [n, exp] of Object.entries(cases)) {
      expect(api.code128Runs(n)).toEqual(exp);
    }
    expect(api.code128Runs('')).toBeNull();
    expect(api.code128Runs('---')).toBeNull();
  });
  test('barcode + perforation regenerate for an entered number, stay as scan art for the sample number', () => {
    const { api, els } = runPage();
    const sample = api.model().samplePassportNo;
    expect(sample).toBeTruthy();
    expect(sample).not.toBe('EP0000001');
    // Entered number differs from the sample: cover + regenerated
    // art show (barcode + both perforation strips).
    fillForm(els, { ...FULL_FORM, passportNo: 'EP0000001' });
    api.applyAll();
    api.render();
    const repairs = els['ep-repairs'].children;
    const barcode = repairs.find((c) => c.className === 'repair cover barcode');
    expect(barcode).toBeTruthy();
    expect(barcode.style.display).toBe('block');
    expect(barcode.src).toBe('data:image/png;base64,FAKE');
    const generated = repairs.filter((c) => c.src === 'data:image/png;base64,FAKE');
    expect(generated.length).toBe(3); // barcode + top holes + bottom holes
    const covers = repairs.filter((c) => c.className === 'repair cover');
    expect(covers.length).toBe(5); // barcode + top + bottom covers/holes share the class
    expect(covers[0].style.display).toBe('block'); // barcode cover hides the old barcode
    // Same number as the sample: the scan's own barcode/holes are
    // correct, so no cover and no regenerated art.
    fillForm(els, { ...FULL_FORM, passportNo: sample });
    api.applyAll();
    api.render();
    expect(barcode.style.display).toBe('none');
    expect(repairs.filter((c) => c.src === 'data:image/png;base64,FAKE').length).toBe(0);
    expect(covers[0].style.display).toBe('none');
  });
  test('perforation slots sit on the scan left edge, bottom-to-top', () => {
    const { api } = runPage();
    expect(api.perfSlots).toEqual([1626, 1444, 1276, 1124, 956, 787, 635, 452, 285]);
    expect(api.perfCols).toEqual([133, 164, 192]);
  });
  test('barcode + perforation renderers return data URLs', () => {
    const { api } = runPage();
    expect(api.renderBarcodeDataURL('EP0000001').startsWith('data:image/png;base64,')).toBe(true);
    expect(api.renderPerfDataURL('EP0000001', 0, 200, 1500).startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('Point 3: photo background (MRP cutout + plate)', () => {
  test('portrait slot background is the levelled plate, not white', () => {
    const { api, els } = runPage();
    api.render();
    const portrait = els['ep-asset-slots'].children.find((s) => s.dataset.slot === 'portrait');
    expect(portrait.children[0].src).toBe(api.model().assets.photoPlate);
  });
  test('epCutoutMask finds the person in a synthetic photo', () => {
    const { api } = runPage();
    // Raw pixel data (what getImageData returns): white backdrop
    // with a dark person (central column, from 20% to the bottom).
    const w = 100, h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inPerson = x >= 30 && x < 70 && y >= 20;
        const v = inPerson ? [80, 60, 50] : [255, 255, 255];
        data[i] = v[0]; data[i + 1] = v[1]; data[i + 2] = v[2]; data[i + 3] = 255;
      }
    }
    const mask = api.epCutoutMask(data, w, h);
    expect(mask.ok).toBe(true);
    expect(mask.alpha.length).toBe(w * h);
  });
  test('processPhotoCutout returns a cut-out data URL for a person photo', async () => {
    const { api } = runPage();
    const out = await api.processPhotoCutout('data:image/png;base64,AAA');
    expect(out.startsWith('data:image/png;base64,')).toBe(true);
  });
  test('render uses the cut-out person for the portrait slot when present', () => {
    const { api, els } = runPage();
    api.state().assets.photo = {
      dataUrl: 'data:image/png;base64,AAA', width: 100, height: 100,
      cutoutRendered: 'data:image/png;base64,CUTOUT',
    };
    api.render();
    const portrait = els['ep-asset-slots'].children.find((s) => s.dataset.slot === 'portrait');
    expect(portrait.children[1].src).toBe('data:image/png;base64,CUTOUT');
    // The ghost slot keeps the full photo (monochrome), not the cutout.
    const secondary = els['ep-asset-slots'].children.find((s) => s.dataset.slot === 'secondary-portrait');
    expect(secondary.children[1].src).toBe('data:image/png;base64,AAA');
  });
});

describe('Point 4: form flow like MRP', () => {
  test('a pasted/typed date normalizes to ISO on input (MRP rule)', () => {
    const { els } = runPage();
    const dob = els['eng-dob'];
    dob.value = '17/12/1979';
    dob.fire('input');
    expect(dob.value).toBe('1979-12-17');
    // A paste is intercepted and set to ISO at once.
    dob.value = '';
    dob.fire('paste', { clipboardData: { getData: () => '17 DEC 1979' }, preventDefault: () => {} });
    expect(dob.value).toBe('1979-12-17');
  });
  test('nationality without a code is flagged with the MRP message', () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, nationalityCode: '' });
    api.applyAll();
    const issues = api.validateEngine();
    expect(issues).toContain('তিন অক্ষরের জাতীয়তার কোড লিখুন; ইস্যুকারী দেশ থেকে এটি ধরে নেওয়া হয় না।');
  });
  test("sex '<' (third option) reaches MRZ-2 as '<'", () => {
    const { api, els } = runPage();
    fillForm(els, { ...FULL_FORM, sex: '<' });
    api.applyAll();
    const m2 = api.buildMrz2();
    expect(m2.length).toBe(44);
    expect(m2[20]).toBe('<');
  });
  test('upload button toggles to the change label once a file is attached', () => {
    const { api, els } = runPage();
    const btn = els['form-upload-photo-button'];
    expect(btn.textContent).toBe('ছবি যোগ করুন');
    api.showUploadState('photo', { name: 'photo.png' });
    expect(btn.textContent).toBe('ছবি বদলান');
    api.showUploadState('photo', null);
    expect(btn.textContent).toBe('ছবি যোগ করুন');
    const signBtn = els['form-upload-signature-button'];
    api.showUploadState('signature', { name: 'sign.png' });
    expect(signBtn.textContent).toBe('স্বাক্ষর বদলান');
  });
  test('MRZ is editable: a hand edit is kept by re-apply, cleared by re-generate', () => {
    const { api, els } = runPage();
    fillForm(els, FULL_FORM);
    api.applyAll();
    els['eng-mrz1'].value = 'P<BGD' + '<'.repeat(39);
    els['eng-mrz2'].value = 'X'.repeat(44);
    api.reapplyMRZ();
    expect(api.derive(api.state())['mrz-1']).toBe('P<BGD' + '<'.repeat(39));
    expect(api.derive(api.state())['mrz-2']).toBe('X'.repeat(44));
    api.regenerateMRZ();
    expect(api.derive(api.state())['mrz-1']).toBe(expectedMrz1());
    expect(api.derive(api.state())['mrz-2']).toBe(expectedMrz2());
  });
  test('idempotency key is a random UUID, not the passport number + timestamp', () => {
    expect(EPASS_HTML).toContain('crypto.randomUUID()');
    expect(EPASS_HTML).not.toContain("'epassport-'+pp+'-'+Date.now()");
  });
  test('create applies the form + regenerates MRZ before the required/validation gates', () => {
    const body = EPASS_HTML.match(/function createEpassport\(\)\{([\s\S]*?)\n\}/)[1];
    const applyAt = body.indexOf('applyAll();');
    const regenAt = body.indexOf('regenerateMRZ();');
    const reqAt = body.indexOf('requiredMissing()');
    const valAt = body.indexOf('validateEngine()');
    expect(applyAt).toBeGreaterThan(-1);
    expect(regenAt).toBeGreaterThan(applyAt);
    expect(reqAt).toBeGreaterThan(regenAt);
    expect(valAt).toBeGreaterThan(reqAt);
  });
  test('PDF retry reuses the key only for the same passport number and keeps it until a PDF succeeds', () => {
    const body = EPASS_HTML.match(/function createEpassport\(\)\{([\s\S]*?)\n\}/)[1];
    expect(body).toContain('pdfRetry.no===pp');
    expect(body).not.toContain('pdfRetry=null');
  });
});
