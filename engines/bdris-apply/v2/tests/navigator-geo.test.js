/**
 * BdrisNavigator.getAddressOptions — country-first cascade tests.
 * Fake DOM page only — no live bdris.gov.bd contact, no browser,
 * no personal data. Mock names are fixtures from the reported
 * production case (Dhaka / Dhaka / Dhaka South City Corporation).
 *
 * Reproduces the exact live failure of 2026-10-26: the Playwright
 * fallback threw `Parent option not found: division="ঢাকা"` on a
 * warm page whose division list was placeholder-only because
 * country had never been selected. The old code attempted the
 * first parent with no wait and no country selection; the submit
 * cascade (StepHandler._fillAddressSection) selects country first.
 *
 * Run: node --test engines/bdris-apply/v2/tests/navigator-geo.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisNavigator } = require('../services/BdrisNavigator');

function placeholder() {
  return [{ value: '', text: '--- নির্বাচন করুন ---' }];
}

// Minimal DOM stub: nodes are plain objects with options/value/
// dispatchEvent, and a change on a parent populates its child from
// the cascade table — the same async-cascade shape the real form
// has, minus the network (population here is synchronous, which
// is exactly what waitForOptions resolves on).
function makePage({ countryOptions, divisionOptions, cascade }) {
  const levels = {
    country: { options: countryOptions, value: '' },
    division: { options: divisionOptions, value: '' },
    district: { options: placeholder(), value: '' },
    upazila: { options: placeholder(), value: '' },
    zone: { options: placeholder(), value: '' }, // PaurasavaOrUnion slot
    cityWard: { options: placeholder(), value: '' }, // WardInCityCorp slot
    ward: { options: placeholder(), value: '' },
  };
  const levelOf = (sel) => {
    if (sel.includes('WardInPaurasavaOrUnion')) return 'ward';
    if (sel.includes('WardInCityCorp')) return 'cityWard';
    if (sel.includes('PaurasavaOrUnion')) return 'zone';
    if (sel.includes('CityCorpCantOrUpazila')) return 'upazila';
    if (sel.includes('Dist')) return 'district';
    if (sel.includes('Div')) return 'division';
    if (sel.includes('Country')) return 'country';
    return null;
  };
  const childOf = { country: 'division', division: 'district', district: 'upazila', upazila: 'cityWard' };
  const nodes = {};
  for (const [level, state] of Object.entries(levels)) {
    nodes[level] = {
      get options() { return state.options; },
      get value() { return state.value; },
      set value(v) { state.value = v; },
      dispatchEvent(ev) {
        if (ev && ev.type === 'change') {
          const child = childOf[level];
          if (child && cascade) {
            const selected = state.options.find((o) => o.value === state.value);
            const next = selected ? cascade[level]?.[selected.text] : null;
            if (next) levels[child].options = placeholder().concat(next);
          }
        }
      },
    };
  }
  const documentStub = {
    querySelector(sel) {
      const level = levelOf(sel);
      return level ? nodes[level] : null;
    },
  };
  return {
    async evaluate(fn, arg) {
      const prev = global.document;
      global.document = documentStub;
      try {
        return await fn(arg);
      } finally {
        global.document = prev;
      }
    },
    async waitForFunction(fn, arg) {
      const prev = global.document;
      global.document = documentStub;
      try {
        return !!fn(arg);
      } finally {
        global.document = prev;
      }
    },
    async waitForTimeout() {},
  };
}

const cascade = {
  country: { 'বাংলাদেশ': [{ value: '4', text: 'ঢাকা' }, { value: '5', text: 'চট্টগ্রাম' }] },
  division: { 'ঢাকা': [{ value: '30', text: 'ঢাকা' }] },
  district: { 'ঢাকা': [{ value: '300', text: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন' }] },
  upazila: { 'ঢাকা দক্ষিণ সিটি কর্পোরেশন': [{ value: '400', text: 'অঞ্চল - ১' }, { value: '401', text: 'অঞ্চল - ২' }] },
};

const parents = { division: 'ঢাকা', district: 'ঢাকা', upazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', zone: '' };

describe('BdrisNavigator.getAddressOptions country-first (live case 2026-10-26)', () => {
  it('does NOT throw division-not-found when division starts placeholder-only and country populates it', async () => {
    const page = makePage({
      countryOptions: placeholder().concat([{ value: '1', text: 'বাংলাদেশ' }]),
      divisionOptions: placeholder(),
      cascade,
    });
    const nav = new BdrisNavigator(page);
    const opts = await nav.getAddressOptions('zone', parents, 'birth');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ১', 'অঞ্চল - ২']);
  });

  it('reports options present: 0 when the division list stays empty even after country', async () => {
    const page = makePage({
      countryOptions: placeholder(),
      divisionOptions: placeholder(),
      cascade,
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.getAddressOptions('zone', parents, 'birth'),
      (e) => /Parent option not found: division="ঢাকা"/.test(e.message)
        && /options present: 0/.test(e.message),
    );
  });

  it('distinguishes a real name mismatch (options present > 0) from an empty list', async () => {
    const page = makePage({
      countryOptions: placeholder().concat([{ value: '1', text: 'বাংলাদেশ' }]),
      divisionOptions: placeholder().concat([{ value: '5', text: 'চট্টগ্রাম' }]),
      cascade,
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.getAddressOptions('zone', parents, 'birth'),
      (e) => /Parent option not found: division="ঢাকা"/.test(e.message)
        && /options present: 1/.test(e.message),
    );
  });
});
