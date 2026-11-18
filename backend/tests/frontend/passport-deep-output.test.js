// MRP deep output — regression tests (2026-11-18, branch
// fix-passport-mrp-deep-output).
//
// The MRP template scan was a faded wash and the printed values were
// thin grey sans, while a vivid real MRP photo shows deep saturated
// background art and bold black printed values. The 69ba4ec fix:
//  - data-page values: sans 400 grey (#4c4c4c) -> sans-bold 700 black
//  - top-page values: serif-bold grey (#696a69) -> black
//  - top-page labels: sans-bold-italic grey -> serif-bold-italic black
//    (needs the 'serif-bold-italic' families entry)
//  - vertical passport number: mono grey (#747677) -> black
//  - all background-derived raster assets deepened in place
//    (saturate 1.8 / contrast 1.1 / brightness .95); MRZ untouched.
// The glyph fix (same branch, after the user rejected 69ba4ec's
// "text matches" claim — "ekhono hoinai likha gula milenai"):
//  - top-page values are NOT Times: the scan prints them in the same
//    bold grotesque as the data-page values -> serif-bold becomes
//    sans-bold (ScanSans 700). Country heading English stays serif-bold.
//  - MRZ is NOT Consolas: the scan prints OCR-B -> mono becomes ocr
//    (ScanOcr 400, CTAN ocr-b-outline, free licence).
//  - vertical passport number is NOT mono: the scan prints it in the
//    bold grotesque -> mono becomes sans-bold (ScanSans 700).
//  - data-page labels print Bengali + English, but the English part is
//    a serif italic, not the Bengali sans -> renderField splits them
//    (labelParts / writeFieldText / measureFieldText).
//  - top-page labels need a REAL Times bold italic face (the model had
//    no italic face, so the browser synthesised the slant) -> a
//    ScanSerif 700 italic @font-face is embedded.
// Data-page values stay sans-bold 700: the scan's BANGLADESHI measures
// W/capH 10.47 against Arial Bold 10.43 (Arial Regular is 10.07), so
// the bold grotesque was already right there.
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
const DATA_LABELS = ['surname-label', 'given-label', 'nationality-label',
  'personal-no-label', 'dob-label', 'previous-label', 'sex-label',
  'birthplace-label', 'issue-label', 'authority-label', 'signature-label',
  'expiry-label', 'type-label', 'country-code-label', 'passport-no-label',
  'vertical-label'];

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

  test('top-page values are sans-bold 700 black (same grotesque as data values)', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    for (const id of TOP_VALUES) {
      const f = byId[id];
      expect(f).toBeDefined();
      expect(f.font).toBe('sans-bold');
      expect(f.color).toBe('#000000');
      expect(f.style.family).toBe('ScanSans');
      expect(f.style.weight).toBe(700);
      expect(f.style.color).toBe('#000000');
    }
    // Country heading English is the one serif-bold that stays Times.
    expect(byId['country-en'].font).toBe('serif-bold');
    expect(byId['country-en'].style.family).toBe('ScanSerif');
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

  test('MRZ is OCR-B and vertical passport number is sans-bold; colours untouched', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    expect(byId['vertical-passport'].font).toBe('sans-bold');
    expect(byId['vertical-passport'].style.family).toBe('ScanSans');
    expect(byId['vertical-passport'].style.weight).toBe(700);
    expect(byId['vertical-passport'].color).toBe('#000000');
    expect(byId['vertical-passport'].style.color).toBe('#000000');
    for (const id of ['mrz-1', 'mrz-2']) {
      expect(byId[id].font).toBe('ocr');
      expect(byId[id].style.family).toBe('ScanOcr');
      expect(byId[id].style.weight).toBe(400);
      expect(byId[id].color).toBe('#262626');
    }
  });

  test('OCR-B and real serif bold-italic faces are embedded; ocr is in the families map', () => {
    expect(PAGE).toContain("ocr:['ScanOcr',400,false]");
    expect(PAGE).toMatch(/@font-face\{font-family:ScanOcr;font-style:normal;font-weight:400;src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\);\}/);
    expect(PAGE).toMatch(/@font-face\{font-family:ScanSerif;font-style:italic;font-weight:700;src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\);\}/);
  });

  test('data labels carry Bengali + English and the renderer splits them', () => {
    const byId = {};
    for (const f of documentState().fields) byId[f.id] = f;
    for (const id of DATA_LABELS) {
      const f = byId[id];
      expect(f).toBeDefined();
      expect(f.font).toBe('bengali');
      expect(f.text).toContain(' / ');
    }
    expect(PAGE).toContain('function labelParts(f,text)');
    expect(PAGE).toContain('function writeFieldText(n,f,s)');
    expect(PAGE).toContain('function measureFieldText(f,style,text)');
    expect(PAGE).toContain('if(write)writeFieldText(n,f,s);');
    expect(PAGE).toContain('const originalWidth=measureFieldText(f,b,f.original);');
    expect(PAGE).toContain('const width=Math.max(2,measureFieldText(f,s,f.text));');
    // The English half is rendered in a serif italic (ScanSerif 400 italic).
    expect(PAGE).toContain("en.style.fontFamily='ScanSerif, ScanBengali, sans-serif'");
    expect(PAGE).toContain('en.style.fontStyle=\'italic\'');
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
