// MRP deep output — regression tests (2026-11-18, branch
// fix-passport-mrp-deep-output).
//
// The MRP template scan was a faded wash and the printed values were
// thin grey sans, while a vivid real MRP photo shows deep saturated
// background art and bold black printed values. The fix:
//  - data-page values: sans 400 grey (#4c4c4c) -> sans-bold 700 black
//  - top-page values: serif-bold grey (#696a69) -> black
//  - top-page labels: sans-bold-italic grey -> serif-bold-italic black
//    (needs the 'serif-bold-italic' families entry)
//  - vertical passport number: mono grey (#747677) -> black
//  - all background-derived raster assets deepened in place
//    (saturate 1.8 / contrast 1.1 / brightness .95); MRZ untouched.
// These tests pin the model side (fonts/weights/colors). The asset
// deepening is verified by the rendered-PDF colour measurement in the
// branch report, not by pixels here.
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '../../../frontend');
const PAGE = fs.readFileSync(path.join(FRONTEND, 'passport.html'), 'utf8');

function documentState() {
  const m = PAGE.match(/<script type="application\/json" id="document-state">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m[1]);
}

const DATA_VALUES = ['type', 'country-code', 'passport-no', 'surname', 'given-name',
  'nationality', 'birth-date', 'sex', 'birthplace', 'issue-date', 'expiry-date',
  'authority', 'personal-no', 'previous-passport'];
const TOP_VALUES = ['personal-name', 'father', 'mother', 'spouse', 'permanent-address',
  'permanent-city', 'emergency-name', 'relationship', 'emergency-address',
  'emergency-city', 'phone'];
const TOP_LABELS = ['name-label', 'father-label', 'mother-label', 'spouse-label',
  'permanent-label', 'emergency-label', 'contact-name-label', 'relationship-label',
  'address-label', 'telephone-label'];

describe('MRP deep output — printed text matches a vivid real passport', () => {
  test('data-page values are sans-bold 700 black', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    for (const id of DATA_VALUES) {
      const f = byId[id];
      expect(f).toBeDefined();
      expect(f.font).toBe('sans-bold');
      expect(f.color).toBe('#000000');
      expect(f.style.family).toBe('ScanSans');
      expect(f.style.weight).toBe(700);
      expect(f.style.color).toBe('#000000');
    }
  });

  test('top-page values are serif-bold black', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    for (const id of TOP_VALUES) {
      const f = byId[id];
      expect(f).toBeDefined();
      expect(f.font).toBe('serif-bold');
      expect(f.color).toBe('#000000');
      expect(f.style.family).toBe('ScanSerif');
      expect(f.style.weight).toBe(700);
      expect(f.style.color).toBe('#000000');
    }
  });

  test('top-page labels are serif-bold-italic black', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    for (const id of TOP_LABELS) {
      const f = byId[id];
      expect(f).toBeDefined();
      expect(f.font).toBe('serif-bold-italic');
      expect(f.color).toBe('#000000');
      expect(f.style.family).toBe('ScanSerif');
      expect(f.style.weight).toBe(700);
      expect(f.style.italic).toBe(true);
      expect(f.style.color).toBe('#000000');
    }
    expect(PAGE).toContain("'serif-bold-italic':['ScanSerif',700,true]");
  });

  test('vertical passport number is black; MRZ untouched', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    expect(byId['vertical-passport'].color).toBe('#000000');
    expect(byId['vertical-passport'].style.color).toBe('#000000');
    expect(byId['mrz-1'].color).toBe('#262626');
    expect(byId['mrz-2'].color).toBe('#262626');
    expect(byId['mrz-1'].style.weight).toBe(400);
  });

  test('no faded grey value ink remains in the model', () => {
    const doc = documentState();
    for (const f of doc.fields) {
      expect(f.color).not.toBe('#4c4c4c');
      expect(f.color).not.toBe('#696a69');
      expect(f.color).not.toBe('#747677');
      expect(f.style.color).not.toBe('#4c4c4c');
      expect(f.style.color).not.toBe('#696a69');
      expect(f.style.color).not.toBe('#747677');
    }
  });

  test('background scan asset is present as a WebP data URI', () => {
    const m = PAGE.match(/<img class="scan" id="scan" src="data:image\/webp;base64,([A-Za-z0-9+/=]+)"/);
    expect(m).not.toBeNull();
    const raw = Buffer.from(m[1], 'base64');
    expect(raw.slice(0, 4).toString('latin1')).toBe('RIFF');
    expect(raw.slice(8, 12).toString('latin1')).toBe('WEBP');
    expect(raw.length).toBeGreaterThan(500000);
  });
});
