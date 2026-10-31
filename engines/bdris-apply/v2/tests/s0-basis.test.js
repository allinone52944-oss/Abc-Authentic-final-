/**
 * D1 (senior audit 2026-10-26) — S0 basis selection, mock only.
 *
 * The old v2 S0 clicked #aBirth/#aPerm (our own frontend cards) and
 * #brOfficeSelectionNextBtn (appears nowhere else). The fix ports v1's
 * applyS0Core: radios #officeBirthplace/#officePermanent
 * (input[name="officeAddressType"][value="BIRTHPLACE"|"PERMANENT"]),
 * embassy checkbox #bdMissionCheckbox, and the generic "পরবর্তী"
 * button via _clickNextAndWait with the S1 anchor as the advance check.
 *
 * No live contact, no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/s0-basis.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');
const { BdrisNavigator } = require('../services/BdrisNavigator');

function makeS0Page(opts = {}) {
  const { radios = true, checkbox = true, embassyChecked = false, neverAdvance = false, laterStep = false } = opts;
  const state = { radio: null, embassyChecked, nextClicked: false, requested: [], basis: radios && !laterStep, laterStep };
  const radioValueFor = (sel) => {
    if (sel.includes('officePermanent') || sel.includes('value="PERMANENT"')) return 'PERMANENT';
    if (sel.includes('officeBirthplace') || sel.includes('value="BIRTHPLACE"')) return 'BIRTHPLACE';
    return null;
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === '#bdMissionCheckbox') return checkbox ? { checked: state.embassyChecked, offsetParent: {} } : null;
      if (sel === '#personFirstNameBn' || sel.includes('personInfoForBirth.personFirstNameBn')) {
        return state.laterStep ? { offsetParent: {} } : null;
      }
      const val = radioValueFor(sel);
      if (val) return state.basis ? { checked: state.radio === val, offsetParent: {} } : null;
      return null;
    },
  };
  const nextEl = {
    innerText: 'পরবর্তী',
    parentElement: null,
    click: async () => { state.nextClicked = true; },
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ y: 100 }),
    evaluate: async (fn) => fn(nextEl),
    waitFor: async () => {},
  };
  const elFor = (sel) => {
    const val = radioValueFor(sel);
    if (val) {
      return {
        isVisible: async () => true,
        check: async () => { state.radio = val; },
        click: async () => { state.radio = val; },
      };
    }
    if (sel === '#bdMissionCheckbox') {
      return {
        isVisible: async () => true,
        check: async () => { state.embassyChecked = true; },
        uncheck: async () => { state.embassyChecked = false; },
        click: async () => { state.embassyChecked = !state.embassyChecked; },
      };
    }
    return null;
  };
  const page = {
    url: () => 'https://bdris.gov.bd/br/application',
    click: async (sel) => {
      // Guard: the old S0 used page.click on frontend/site-wrong ids.
      if (sel.includes('aBirth') || sel.includes('aPerm') || sel.includes('brOfficeSelectionNextBtn')) {
        throw new Error('TEST FAIL: wrong selector used: ' + sel);
      }
    },
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return fn(arg); } finally { global.document = prev; }
    },
    locator: (sel) => {
      state.requested.push(sel);
      const val = radioValueFor(sel);
      const isRadio = val && state.basis;
      const isCheckbox = sel === '#bdMissionCheckbox' && checkbox;
      const isNext = sel.includes('পরবর্তী') || sel.includes('Next');
      const isAnchor = sel.includes('personFirstNameBn');
      const count = isRadio || isCheckbox || isNext
        ? 1
        : (isAnchor && state.nextClicked && !neverAdvance ? 1 : 0);
      return {
        count: async () => count,
        nth: () => {
          if (isNext) return nextEl;
          if (isCheckbox) {
            return {
              isVisible: async () => true,
              check: async () => { state.embassyChecked = true; },
              uncheck: async () => { state.embassyChecked = false; },
              click: async () => { state.embassyChecked = !state.embassyChecked; },
              evaluate: async (fn) => fn({ innerText: sel }),
            };
          }
          return {
            isVisible: async () => true,
            check: async () => { if (val) state.radio = val; },
            uncheck: async () => { state.embassyChecked = false; },
            click: async () => { if (val) state.radio = val; },
            evaluate: async (fn) => fn({ innerText: sel }),
          };
        },
      };
    },
  };
  return { page, state };
}

describe('submitS0 basis (v1 site selectors)', () => {
  it('selects the birthplace radio and advances to the person section', async () => {
    const { page, state } = makeS0Page();
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'BIRTHPLACE' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(state.radio, 'BIRTHPLACE');
    assert.strictEqual(state.nextClicked, true);
    assert.ok(state.requested.some((s) => s.includes('officeBirthplace')));
    assert.ok(!state.requested.some((s) => s.includes('aBirth') || s.includes('brOfficeSelectionNextBtn')),
      'frontend cards and the invented Next id must never be requested');
  });

  it('selects the permanent radio', async () => {
    const { page, state } = makeS0Page();
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'PERMANENT' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(state.radio, 'PERMANENT');
  });

  it('aligns frontend/engine values: legacy BIRTH and no value both select BIRTHPLACE', async () => {
    const p1 = makeS0Page();
    const o1 = await new StepHandler(new BdrisNavigator(p1.page), { emit: () => {} })
      .submitS0({ addressType: 'BIRTH' });
    assert.strictEqual(o1.ok, true, JSON.stringify(o1.failed || o1));
    assert.strictEqual(p1.state.radio, 'BIRTHPLACE', 'legacy BIRTH must map to the site BIRTHPLACE radio');

    const p2 = makeS0Page();
    const o2 = await new StepHandler(new BdrisNavigator(p2.page), { emit: () => {} }).submitS0({});
    assert.strictEqual(o2.ok, true, JSON.stringify(o2.failed || o2));
    assert.strictEqual(p2.state.radio, 'BIRTHPLACE', 'default must be BIRTHPLACE like the frontend');
  });

  it('embassy: checks the mission checkbox and still advances', async () => {
    const { page, state } = makeS0Page();
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'BIRTHPLACE', embassy: true });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(state.embassyChecked, true);
  });

  it('embassy off: clears a stale checked mission checkbox before selecting the radio', async () => {
    const { page, state } = makeS0Page({ embassyChecked: true });
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'PERMANENT', embassy: false });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(state.embassyChecked, false);
    assert.strictEqual(state.radio, 'PERMANENT');
  });

  it('fails honestly when the basis radio is missing (no false-ready)', async () => {
    const { page, state } = makeS0Page({ radios: false });
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'BIRTHPLACE' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.failed[0].field, 'আবেদনের ভিত্তি');
    assert.strictEqual(out.code, undefined, 'an empty/booting page must NOT trigger the wrong-step gate — the 30s settle wait stays the arbiter there');
    assert.strictEqual(state.nextClicked, false, 'Next must not be clicked without a radio');
  });

  it('fails honestly when Next does not advance to the person section', async () => {
    const { page, state } = makeS0Page({ neverAdvance: true });
    const out = await new StepHandler(new BdrisNavigator(page), { emit: () => {} })
      .submitS0({ addressType: 'BIRTHPLACE' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(state.nextClicked, true);
    assert.strictEqual(state.radio, 'BIRTHPLACE');
  });

  // S0-BASIS-GATE (2026-10-31): a reused session page sitting on a
  // later BDRIS step must not burn 30s and die with the misleading
  // radio field error — it must repair (fresh form) or fail with
  // the machine-readable gate code. No live contact, no browser.
  it('wrong-step page: re-navigates once to a fresh form and then selects the basis', async () => {
    const { page, state } = makeS0Page({ laterStep: true });
    const h = new StepHandler(new BdrisNavigator(page), { emit: () => {} });
    let renavCalls = 0;
    h.navigator.gotoForm = async () => { renavCalls++; state.basis = true; state.laterStep = false; };
    const out = await h.submitS0({ addressType: 'BIRTHPLACE' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(renavCalls, 1, 'exactly one repair navigation');
    assert.strictEqual(state.radio, 'BIRTHPLACE');
    assert.strictEqual(state.nextClicked, true);
  });

  it('wrong-step page + failed re-navigation: gate code, no Next, fail-fast', async () => {
    const { page, state } = makeS0Page({ laterStep: true });
    const h = new StepHandler(new BdrisNavigator(page), { emit: () => {} });
    h.navigator.gotoForm = async () => { throw new Error('nav fail'); };
    const t0 = Date.now();
    const out = await h.submitS0({ addressType: 'BIRTHPLACE' });
    const dt = Date.now() - t0;
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'BOT_PAGE_NOT_ON_BASIS_STEP');
    assert.strictEqual(out.failed[0].field, 'আবেদনের ভিত্তি');
    assert.strictEqual(state.nextClicked, false, 'Next must not be clicked on a wrong-step page');
    assert.ok(dt < 15000, `gate failure must be fast, took ${dt}ms (old path burned 30s+)`);
  });

  it('step-0 page: no re-navigation happens on the success path', async () => {
    const { page } = makeS0Page();
    const h = new StepHandler(new BdrisNavigator(page), { emit: () => {} });
    let renavCalls = 0;
    h.navigator.gotoForm = async () => { renavCalls++; };
    const out = await h.submitS0({ addressType: 'BIRTHPLACE' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed || out));
    assert.strictEqual(renavCalls, 0, 'the success path must pay no repair cost');
  });
});
