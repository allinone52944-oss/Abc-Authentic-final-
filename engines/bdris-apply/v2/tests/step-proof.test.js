/**
 * STEP-PROOF (audit cycle 1: A1–A4) — mock only, no live contact.
 *
 * Regression tests for the step-proof fixes in services/StepHandler.js:
 *   A1. submitS2 (parents) no longer reports success while discarding fill
 *       failures — success requires failed.length === 0 AND a positive
 *       address-step anchor; failed[] is carried through.
 *   A2. submitS1 / submitS2 / submitS2B fail fast with a machine-readable
 *       BOT_PAGE_NOT_ON_<STEP> code when the page is on the wrong step.
 *   A3. _clickNextAndWait returns ok:false on a failed click or a missing
 *       destination anchor, and scopes its button search to the current
 *       section instead of blindly picking the lowest visible "Next".
 *   A4. S3's attemptUpload requires positive upload evidence (row collapse);
 *       a no-collapse upload fails with a distinct upload-not-confirmed
 *       reason and is NOT retried (a retry could double-upload).
 *
 * Each test FAILS on pre-fix code by construction:
 *   A1 — pre-fix advanced branch returned { ok:true, failed:[] } even with
 *        failed fills; A2 — pre-fix there was no gate at all, so a
 *        wrong-step page proceeded into fills; A3 — pre-fix
 *        _clickNextAndWait ignored the click result and the anchor wait
 *        and returned ok:true; A4 — pre-fix both .catch(()=>{}) swallowed
 *        the failure and attemptUpload returned 'ok'.
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StepHandler } = require('../services/StepHandler');
const { BdrisNavigator } = require('../services/BdrisNavigator');

// ---------------------------------------------------------------------------
// Fake page that models the BDRIS form as a single "current step" plus
// per-selector visibility. The fake document mirrors the selectors the
// step handlers probe (see _detectSiteStep / _waitVisible / evaluate fns).
// ---------------------------------------------------------------------------

// Which site step owns a selector. Returns null for selectors this fake
// does not model (treated as absent).
function stepOf(sel) {
  const s = String(sel);
  if (s.includes('officeBirthplace') || s.includes('officeAddressType')) return 'basis';
  if (s.includes('personFirstNameBn') || s.includes('personBirthDate')) return 'person';
  if (s.includes('fatherBrn') || s.includes('father.ubrn')
    || s.includes('motherBrn') || s.includes('mother.ubrn')
    || s.includes('fatherNameBn') || s.includes('fatherNameEn')
    || s.includes('motherNameBn') || s.includes('motherNameEn')
    || s.includes('fatherNationality') || s.includes('motherNationality')
    || s.includes('father.personNameBn') || s.includes('father.personNameEn')
    || s.includes('mother.personNameBn') || s.includes('mother.personNameEn')
    || s.includes('father.personNationality') || s.includes('mother.personNationality')) return 'parents';
  if (s.includes('permAddr') || s.includes('prsntAddr')
    || s.includes('copyBirthPlaceToPermAddr') || s.includes('copyPermAddrToPrsntAddr')
    || s.includes('permFields')) return 'address';
  if (s.includes('relationWithApplicant') || s.includes('input[name="files"]')) return 'docs';
  if (s.includes('#email') || s.includes('input[name="email"]')
    || s.includes('#phone') || s.includes('input[name="phone"]')) return 'contact';
  if (s.includes('type="password"')) return 'login';
  return null;
}

function makeStepPage(opts = {}) {
  const state = {
    step: opts.step || 'parents',
    advanceTo: opts.advanceTo || null, // step the Next click moves to
    missing: opts.missing || null, // (sel) => boolean, selectors to hide
    collapseNever: !!opts.collapseNever,
    rowVisible: false,
    startClicks: 0,
    setFiles: 0,
    checkedRel: null,
    selectedType: null,
    nextClicks: 0,
  };

  const isVisibleSel = (sel) => {
    if (state.missing && state.missing(sel)) return false;
    return stepOf(sel) === state.step;
  };

  // Generic visible element (fill/click/check/selectOption/type).
  const el = () => ({
    value: '',
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async (v) => { /* value recorded on the element itself */ },
    click: async () => {},
    check: async () => {},
    selectOption: async () => {},
    type: async () => {},
    waitFor: async () => {},
    boundingBox: async () => ({ y: 100 }),
    evaluate: async (fn) => fn({ innerText: 'পরবর্তী', parentElement: null }),
    inputValue: async () => '',
  });

  const selectFake = () => ({
    options: [{ value: '', text: '---' }, { value: '1', text: 'বাংলাদেশী' }],
    value: '',
    dispatchEvent: () => {},
    offsetParent: {},
    getClientRects: () => [{}],
  });

  const fakeDoc = {
    body: { innerText: state.step === 'empty' ? '' : 'form page' },
    querySelector: (sel) => {
      const s = String(sel);
      if (s === 'form') return state.step === 'empty' ? null : {};
      if (s.includes(':checked')) {
        return state.checkedRel
          ? { value: state.checkedRel, offsetParent: {}, getClientRects: () => [{}] }
          : null;
      }
      if (s === '#applicantName') {
        return { value: 'XY', offsetParent: {}, removeAttribute: () => {}, dispatchEvent: () => {} };
      }
      if (s.includes('Nationality')) {
        return isVisibleSel(sel) ? selectFake() : null;
      }
      if (!isVisibleSel(sel)) return null;
      return { value: '', offsetParent: {}, getClientRects: () => [{}], required: false, removeAttribute: () => {} };
    },
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (s.includes('text-danger') || s.includes('invalid-feedback')) return [];
      if (s.includes('relationWithApplicant') && state.step === 'docs') {
        return ['SELF', 'FATHER', 'MOTHER', 'OTHER'].map((v) => ({
          value: v,
          offsetParent: {},
          getClientRects: () => [{}],
          click: () => { state.checkedRel = v; },
        }));
      }
      return [];
    },
  };

  const page = {
    state,
    url: () => 'https://bdris.gov.bd/br/application',
    waitForTimeout: async () => {},
    waitForFunction: async () => {
      if (state.collapseNever) throw new Error('timeout');
      return true;
    },
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = fakeDoc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    locator: (sel) => {
      const s = String(sel);
      if (s.includes('পরবর্তী') || s.includes('Next')) {
        return {
          count: async () => 1,
          nth: () => ({
            isVisible: async () => true,
            isEnabled: async () => true,
            boundingBox: async () => ({ y: 100 }),
            waitFor: async () => {},
            evaluate: async (fn) => fn({ innerText: 'পরবর্তী', parentElement: null }),
            click: async () => {
              state.nextClicks++;
              if (state.advanceTo) state.step = state.advanceTo;
            },
          }),
        };
      }
      if (s.includes('Start')) {
        return {
          count: async () => 1,
          nth: () => ({ isVisible: async () => true }),
          first: () => ({
            elementHandle: async () => ({
              click: async () => { state.startClicks++; },
            }),
          }),
        };
      }
      if (s.includes('label:has-text')) return { count: async () => 0, nth: () => ({}) };
      const visible = isVisibleSel(sel);
      return {
        count: async () => (visible ? 1 : 0),
        nth: () => (visible ? el() : { isVisible: async () => false }),
      };
    },
    $: (sel) => {
      const s = String(sel);
      if (s.includes('type="file"')) {
        return Promise.resolve({
          setInputFiles: async () => { state.setFiles++; state.rowVisible = true; },
        });
      }
      return Promise.resolve(null);
    },
    waitForSelector: (sel) => {
      if (String(sel).includes('attchment') && state.rowVisible) {
        return Promise.resolve({ selectOption: async (v) => { state.selectedType = v; } });
      }
      return Promise.resolve(null);
    },
  };
  return page;
}

function makeHandler(page, options = {}) {
  return new StepHandler(new BdrisNavigator(page), { emit: () => {}, ...options });
}

// ---------------------------------------------------------------------------
// A1 — submitS2 must not report success while discarding fill failures.
// ---------------------------------------------------------------------------

describe('A1 submitS2 success requires fills + address anchor', () => {
  it('a page already on the address step never yields ok:true with nothing filled', async () => {
    const page = makeStepPage({ step: 'address' });
    const h = makeHandler(page, { applicantDob: '1980-01-01' });
    const out = await h.submitS2({
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    }, '1980-01-01');
    assert.strictEqual(out.ok, false);
    // The S2 gate (A2) fires first on a wrong-step page — either way the
    // pre-fix { ok:true, failed:[] } with nothing filled is impossible.
    assert.strictEqual(out.code, 'BOT_PAGE_NOT_ON_PARENTS_STEP');
  });

  it('a named parent fill failure is carried through the advanced branch', async () => {
    const page = makeStepPage({
      step: 'parents',
      advanceTo: 'address',
      missing: (sel) => sel.includes('motherNameBn') || sel.includes('mother.personNameBn'),
    });
    const h = makeHandler(page, { applicantDob: '1980-01-01' });
    const out = await h.submitS2({
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    }, '1980-01-01');
    assert.strictEqual(out.ok, false);
    // The gate passed (page WAS on the parents step); the failure is the
    // missing mother's Bengali name field, named exactly.
    assert.strictEqual(out.code, undefined);
    assert.ok(Array.isArray(out.failed) && out.failed.length > 0);
    assert.ok(out.failed.some((f) => f.field === 'মাতা-এর নাম (বাংলা)'),
      `expected the mother's Bengali name failure, got ${JSON.stringify(out.failed)}`);
  });
});

// ---------------------------------------------------------------------------
// A2 — entry step gates for S1 / S2 / S2B.
// ---------------------------------------------------------------------------

describe('A2 entry step gates', () => {
  it('S1 on the basis page fails fast with BOT_PAGE_NOT_ON_PERSON_STEP', async () => {
    const page = makeStepPage({ step: 'basis' });
    const h = makeHandler(page);
    const out = await h.submitS1({});
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BOT_PAGE_NOT_ON_PERSON_STEP');
  });

  it('S2 on the person page fails fast with BOT_PAGE_NOT_ON_PARENTS_STEP', async () => {
    const page = makeStepPage({ step: 'person' });
    const h = makeHandler(page, { applicantDob: '1980-01-01' });
    const out = await h.submitS2({
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    }, '1980-01-01');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BOT_PAGE_NOT_ON_PARENTS_STEP');
  });

  it('S2B on the parents page fails fast with BOT_PAGE_NOT_ON_ADDRESS_STEP', async () => {
    const page = makeStepPage({ step: 'parents' });
    const h = makeHandler(page);
    const out = await h.submitS2B({});
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BOT_PAGE_NOT_ON_ADDRESS_STEP');
  });

  it('S2B on its own address step does not trip the gate', async () => {
    const page = makeStepPage({ step: 'address' });
    const h = makeHandler(page);
    const out = await h.submitS2B({});
    // Fails only because the copy checkboxes are absent on this stub —
    // the failure carries NO gate code, proving the gate passed.
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, undefined);
    assert.ok(Array.isArray(out.failed) && out.failed.length > 0);
  });
});

// ---------------------------------------------------------------------------
// A3 — _clickNextAndWait honesty + section scoping.
// ---------------------------------------------------------------------------

function makeNextPage(buttons, anchorVisible) {
  const state = { anchorVisible, clicked: null, clickCalls: 0 };
  const section = (id, hasControls) => ({
    id,
    parentElement: null,
    querySelector: () => (hasControls ? {} : null),
  });
  const btn = (b) => ({
    innerText: 'পরবর্তী',
    parentElement: b.section ? section(b.section, b.hasControls) : null,
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ y: b.y }),
    waitFor: async () => {},
    evaluate: async (fn) => fn({
      innerText: 'পরবর্তী',
      parentElement: b.section ? section(b.section, b.hasControls) : null,
    }),
    click: async () => {
      state.clickCalls++;
      state.clicked = b.name;
      if (b.onClick) b.onClick();
      if (b.throws) throw new Error('click failed');
    },
  });
  const page = {
    state,
    url: () => 'https://bdris.gov.bd/br/application',
    waitForTimeout: async () => {},
    waitForFunction: async () => true,
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => fn(arg),
    locator: (sel) => {
      const s = String(sel);
      if (s.includes('পরবর্তী') || s.includes('Next')) {
        return {
          count: async () => buttons.length,
          nth: (i) => btn(buttons[i]),
        };
      }
      return {
        count: async () => (state.anchorVisible ? 1 : 0),
        nth: () => ({ isVisible: async () => state.anchorVisible }),
      };
    },
  };
  return page;
}

describe('A3 _clickNextAndWait', () => {
  it('a click that throws returns ok:false (no advance claimed)', async () => {
    const page = makeNextPage([
      { name: 'only', y: 100, section: null, throws: true },
    ], false);
    const h = new StepHandler({ page }, { emit: () => {} });
    // The stub button's click throws AND its evaluate fallback is the
    // same click path (throws) — _robustClick returns false.
    h.page = page;
    const out = await h._clickNextAndWait('পরবর্তী');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(page.state.clickCalls, 1);
  });

  it('two Next buttons, lowest clicked, anchor never appears: ok:false', async () => {
    const page = makeNextPage([
      { name: 'upper', y: 100, section: 'secA', hasControls: true },
      { name: 'lower', y: 300, section: 'secB', hasControls: true },
    ], false);
    const h = new StepHandler({ page }, { emit: () => {} });
    const out = await h._clickNextAndWait('পরবর্তী', { nextAnchor: ['#fatherBrn'] });
    assert.strictEqual(out.ok, false);
    // The lowest button was clicked; no fallback guessing to the other.
    assert.strictEqual(page.state.clicked, 'lower');
  });

  it('section scoping: a bare-container lower button is passed over for the in-section upper button', async () => {
    const page = makeNextPage([
      { name: 'upper', y: 100, section: 'secA', hasControls: true },
      { name: 'lower', y: 300, section: 'secB', hasControls: false },
    ], true);
    const h = new StepHandler({ page }, { emit: () => {} });
    const out = await h._clickNextAndWait('পরবর্তী', { nextAnchor: ['#fatherBrn'] });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(page.state.clicked, 'upper');
  });
});

// ---------------------------------------------------------------------------
// A4 — S3 upload requires positive evidence (row collapse).
// ---------------------------------------------------------------------------

describe('A4 S3 upload not confirmed', () => {
  it('a no-collapse upload fails S3 with a distinct reason and is not retried', async () => {
    const page = makeStepPage({ step: 'docs', collapseNever: true });
    const h = makeHandler(page, { applicantDob: '1980-01-01' });
    const tiny = Buffer.from('x').toString('base64');
    const out = await h.submitS3({
      relation: 'নিজ',
      docs: [
        { name: 'a.jpg', mimeType: 'image/jpeg', base64: tiny, docType: '40' },
        { name: 'b.jpg', mimeType: 'image/jpeg', base64: tiny, docType: '41' },
      ],
    });
    assert.strictEqual(out.ok, false);
    assert.ok(Array.isArray(out.failed) && out.failed.length > 0);
    assert.ok(out.failed.some((f) => /নিশ্চিত হওয়া যায়নি/.test(f.reason || '')),
      `expected the upload-not-confirmed reason, got ${JSON.stringify(out.failed)}`);
    // Exactly one Start click per document — the not-confirmed failure
    // is NOT retried (a retry could double-upload).
    assert.strictEqual(page.state.startClicks, 2);
  });
});
