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

  it('names the country state when the division list stays empty even after country (country option missing)', async () => {
    const page = makePage({
      countryOptions: placeholder(),
      divisionOptions: placeholder(),
      cascade,
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.getAddressOptions('zone', parents, 'birth'),
      (e) => /division list still empty after country selection/.test(e.message)
        && /country selection succeeded: false/.test(e.message)
        && /country options present: 0/.test(e.message)
        && /division options present: 0/.test(e.message),
    );
  });

  it('names a successful country selection when division still never populates', async () => {
    const page = makePage({
      countryOptions: placeholder().concat([{ value: '1', text: 'বাংলাদেশ' }]),
      divisionOptions: placeholder(),
      cascade: {}, // country selects, but nothing populates division
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.getAddressOptions('zone', parents, 'birth'),
      (e) => /division list still empty after country selection/.test(e.message)
        && /country selection succeeded: true/.test(e.message)
        && /division options present: 0/.test(e.message),
    );
  });

  it('navigates to the form page when the session page is on a non-form BDRIS page, then succeeds', async () => {
    const inner = makePage({
      countryOptions: placeholder().concat([{ value: '1', text: 'বাংলাদেশ' }]),
      divisionOptions: placeholder(),
      cascade,
    });
    let currentUrl = 'https://bdris.gov.bd/other-page';
    let gotoCalls = 0;
    const page = {
      ...inner,
      url: () => currentUrl,
      goto: async (u) => { gotoCalls++; currentUrl = u; },
      waitForSelector: async () => {},
    };
    const nav = new BdrisNavigator(page);
    const opts = await nav.getAddressOptions('zone', parents, 'birth');
    assert.strictEqual(gotoCalls, 1, 'a non-form page must navigate to /br/application before the cascade');
    assert.strictEqual(currentUrl, 'https://bdris.gov.bd/br/application');
    assert.deepStrictEqual(opts.map((o) => o.name), ['অঞ্চল - ১', 'অঞ্চল - ২']);
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

describe('BdrisNavigator page-state classification (live banner 2026-10-26: /br/application with no token and no division select)', () => {
  // Fake page whose DOM state is fully controlled: form element,
  // per-form division presence, token presence, title/body. No live
  // contact, no personal data. Reproduces the exact live banner:
  // page URL is the form URL, yet no CSRF token and no division
  // select — i.e. no form content at all, not a name mismatch.
  function makeStatePage({ url0, formElement, title, bodyText, meta, hidden, divisions, flipTo }) {
    let state = {
      formElement: !!formElement, title: title || '', bodyText: bodyText || '',
      meta: !!meta, hidden: !!hidden,
      divisions: { birth: false, perm: false, prsnt: false, ...(divisions || {}) },
    };
    let currentUrl = url0;
    const placeholderOpt = [{ value: '', text: '--- নির্বাচন করুন ---' }];
    const nodeFor = (sel) => {
      if (sel === 'form#birth_application_form' || sel === 'form') return state.formElement ? {} : null;
      if (sel === 'meta[name="_csrf"]') return state.meta ? { content: 'fixture' } : null;
      if (sel === 'input[name="_csrf"]') return state.hidden ? { value: 'fixture' } : null;
      if (sel.includes('birthPlaceDiv')) return state.divisions.birth ? { options: placeholderOpt } : null;
      if (sel.includes('permAddrDiv')) return state.divisions.perm ? { options: placeholderOpt } : null;
      if (sel.includes('prsntAddrDiv')) return state.divisions.prsnt ? { options: placeholderOpt } : null;
      return null;
    };
    const page = {
      gotoCalls: 0,
      url: () => currentUrl,
      goto: async (u) => {
        page.gotoCalls++;
        currentUrl = u;
        if (flipTo) {
          state = {
            formElement: !!flipTo.formElement, title: flipTo.title || '', bodyText: flipTo.bodyText || '',
            meta: !!flipTo.meta, hidden: !!flipTo.hidden,
            divisions: { birth: false, perm: false, prsnt: false, ...(flipTo.divisions || {}) },
          };
        }
      },
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      waitForFunction: async (fn, arg) => {
        const prev = global.document;
        global.document = documentStub;
        try { return !!fn(arg); } finally { global.document = prev; }
      },
      evaluate: async (fn, arg) => {
        const prev = global.document;
        global.document = documentStub;
        try { return await fn(arg); } finally { global.document = prev; }
      },
    };
    const documentStub = {
      get title() { return state.title; },
      body: { get innerText() { return state.bodyText; } },
      querySelector: nodeFor,
    };
    return page;
  }

  const permParents = { division: 'ঢাকা', district: 'ঢাকা', upazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', zone: '' };

  it('a stub page at /br/application throws "form content not loaded" naming form element and divisions, and a second check does not re-navigate', async () => {
    const page = makeStatePage({
      url0: 'https://bdris.gov.bd/br/application',
      formElement: false, title: '', bodyText: '',
      meta: false, hidden: false, divisions: {},
    });
    const nav = new BdrisNavigator(page);
    const first = await nav.ensureFormPage('perm');
    assert.strictEqual(first.formPresent, false);
    assert.strictEqual(page.gotoCalls, 1, 'a content-less page must be reloaded once, not once per check');
    const second = await nav.ensureFormPage('perm');
    assert.strictEqual(second.formPresent, false);
    assert.strictEqual(page.gotoCalls, 1, 'memoized check must not pay a second navigation');
    await assert.rejects(
      () => nav.getAddressOptions('zone', permParents, 'perm'),
      (e) => /form content not loaded/.test(e.message)
        && /form element: false/.test(e.message)
        && /birth=false perm=false prsnt=false/.test(e.message),
    );
  });

  it('a real form page with birth present but perm missing throws "section not rendered" and does not navigate', async () => {
    const page = makeStatePage({
      url0: 'https://bdris.gov.bd/br/application',
      formElement: true, title: 'Birth Registration', bodyText: 'form content here',
      meta: true, hidden: true, divisions: { birth: true, perm: false, prsnt: false },
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.getAddressOptions('zone', permParents, 'perm'),
      (e) => /section not rendered/.test(e.message)
        && /birth=true perm=false/.test(e.message),
    );
    assert.strictEqual(page.gotoCalls, 0, 'a real form page must not be reloaded to find a section it does not render');
  });

  it('a stub page that becomes the form on reload is classified as form-present after one navigation', async () => {
    const page = makeStatePage({
      url0: 'https://bdris.gov.bd/br/application',
      formElement: false, divisions: {},
      flipTo: { formElement: true, title: 'Birth Registration', meta: true, hidden: true, divisions: { birth: true, perm: true, prsnt: true } },
    });
    const nav = new BdrisNavigator(page);
    const check = await nav.ensureFormPage('perm');
    assert.strictEqual(check.formPresent, true);
    assert.strictEqual(page.gotoCalls, 1);
  });

  it('gotoForm throws instead of reporting a false ready when the loaded page has no form content', async () => {
    const page = makeStatePage({
      url0: 'https://bdris.gov.bd/br/application',
      formElement: false, divisions: {},
    });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.gotoForm(),
      (e) => /form content not loaded/.test(e.message),
    );
  });
});
