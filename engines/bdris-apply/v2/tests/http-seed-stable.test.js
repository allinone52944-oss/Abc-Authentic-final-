/**
 * Seed-stability fix (live journal 2026-10-29 09:24:56 UTC, twice):
 * 'HTTP seed skipped: page.evaluate: Execution context was
 * destroyed, most likely because of a navigation', then the UI
 * direct call fell back with 'No session-seeded client: bare
 * bootstrap is refused'. The session was not missing — the seed
 * ran while the page was navigating.
 *
 * These tests pin the permanent fix in HttpGeoService.seedFromPage:
 * a destroyed execution context waits for the page to settle and
 * retries the full seed exactly once; any other failure still
 * fails fast with no retry; a bare bootstrap is never attempted.
 * Fake client / mock page only — no live bdris.gov.bd contact,
 * no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/http-seed-stable.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { HttpGeoService } = require('../services/HttpGeoService');
const { runHttpChain } = require('../services/HttpPathRunner');

function unbootstrappedClient() {
  return {
    bootstrapped: false,
    seeded: null,
    seedFromBrowser({ cookies, csrfToken, csrfHeaderName }) {
      if (!csrfToken) throw new Error('BOOTSTRAP_NO_CSRF');
      this.bootstrapped = true;
      this.seeded = { cookies, csrfToken, csrfHeaderName };
    },
  };
}

// Fake Playwright page. evaluate runs the real extraction function
// against a fake document carrying a meta _csrf token, unless the
// behaviour says to throw first (navigation destroying the context).
function fakePage({ behaviour = 'ok', withWaitForLoadState = true } = {}) {
  let evaluateCalls = 0;
  const waitCalls = [];
  const page = {
    evaluateCalls: () => evaluateCalls,
    waitCalls,
    context: () => ({ cookies: async () => [{ name: 'TS01', value: 'browser-session-fixture' }] }),
    url: () => 'https://bdris.gov.bd/br/application',
    evaluate: async (fn) => {
      evaluateCalls += 1;
      if (behaviour === 'destroyOnce' && evaluateCalls === 1) {
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      }
      if (behaviour === 'destroyAlways') {
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      }
      if (behaviour === 'otherError') {
        throw new Error('evaluate boom');
      }
      if (behaviour === 'noToken') {
        return { token: null, headerName: null, source: null, pageUrl: 'https://bdris.gov.bd/br/application', formElement: true };
      }
      const prevDoc = global.document;
      global.document = {
        querySelector: (sel) => {
          if (sel === 'meta[name="_csrf"]') return { content: 'settled-fixture-token' };
          if (sel === 'meta[name="_csrf_headerName"]') return { content: 'X-CSRF-TOKEN' };
          if (sel === 'form#birth_application_form' || sel === 'form') return {};
          return null;
        },
      };
      try { return await fn(); } finally { global.document = prevDoc; }
    },
  };
  if (withWaitForLoadState) {
    page.waitForLoadState = async (state, opts) => { waitCalls.push([state, opts]); };
  }
  return page;
}

function addr() {
  return {
    division: 'ঢাকা', district: 'ঢাকা', cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
    paurasavaUnion: 'অঞ্চল - ১', ward: 'ওয়ার্ড - ১',
    postBn: 'ঢাকা', postEn: 'Dhaka', vilBn: 'মহল্লা', vilEn: 'Moholla',
    houseBn: 'বাসা ১', houseEn: 'House 1',
  };
}

function draft() {
  return {
    s1: {
      firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim',
      dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম',
      ...addr(), divisionId: '1', districtId: '2', cityCorpUpazilaId: '3', paurasavaUnionId: '4', wardId: '5',
    },
    s2: {
      father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid' },
      mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
    },
    s2b: { permCopy: false, presCopy: false, perm: addr(), pres: addr() },
    s3: { relation: 'FATHER', docs: [] },
    docs: [],
  };
}

describe('Seed stability: destroyed context retries once after settling', () => {
  it('seed succeeds after a navigation destroys the first context', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const page = fakePage({ behaviour: 'destroyOnce' });
    const ok = await httpGeo.seedFromPage(page);
    assert.strictEqual(ok, true);
    assert.strictEqual(client.bootstrapped, true);
    assert.strictEqual(client.seeded.csrfToken, 'settled-fixture-token');
    assert.strictEqual(page.evaluateCalls(), 2);
    assert.strictEqual(page.waitCalls.length, 1);
    assert.strictEqual(page.waitCalls[0][0], 'domcontentloaded');
  });

  it('seed still retries once when the page offers no waitForLoadState', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const page = fakePage({ behaviour: 'destroyOnce', withWaitForLoadState: false });
    const ok = await httpGeo.seedFromPage(page);
    assert.strictEqual(ok, true);
    assert.strictEqual(client.seeded.csrfToken, 'settled-fixture-token');
    assert.strictEqual(page.evaluateCalls(), 2);
  });

  it('a second destroyed context fails fast after exactly one retry, never looping', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const page = fakePage({ behaviour: 'destroyAlways' });
    const ok = await httpGeo.seedFromPage(page);
    assert.strictEqual(ok, false);
    assert.strictEqual(page.evaluateCalls(), 2);
    assert.match(httpGeo.lastSeedError.message, /Execution context was destroyed/);
  });

  it('a non-navigation evaluate error is not retried', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const page = fakePage({ behaviour: 'otherError' });
    const ok = await httpGeo.seedFromPage(page);
    assert.strictEqual(ok, false);
    assert.strictEqual(page.evaluateCalls(), 1);
    assert.match(httpGeo.lastSeedError.message, /evaluate boom/);
  });

  it('a page with no CSRF token still fails fast with no retry', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const page = fakePage({ behaviour: 'noToken' });
    const ok = await httpGeo.seedFromPage(page);
    assert.strictEqual(ok, false);
    assert.strictEqual(page.evaluateCalls(), 1);
    assert.match(httpGeo.lastSeedError.message, /no CSRF token/);
  });

  it('genuinely no warm session page still fails fast with the no-warm-page error', async () => {
    const client = unbootstrappedClient();
    const httpGeo = new HttpGeoService({ client });
    const ok = await httpGeo.seedFromPage(null);
    assert.strictEqual(ok, false);
    assert.strictEqual(client.bootstrapped, false);
    assert.match(httpGeo.lastSeedError.message, /no warm Playwright session/);
  });

  it('an already-bootstrapped client needs no page and no retry', async () => {
    const client = unbootstrappedClient();
    client.bootstrapped = true;
    const httpGeo = new HttpGeoService({ client });
    const ok = await httpGeo.seedFromPage(null);
    assert.strictEqual(ok, true);
  });
});

describe('Seed stability: bare bootstrap remains refused', () => {
  it('send phase with noBareBootstrap and no client fails SEED_FAILED, never bootstraps', async () => {
    const r = await runHttpChain({
      data: draft(), log: () => {}, phase: 'send', noBareBootstrap: true,
    });
    assert.strictEqual(r.fallback, true);
    assert.strictEqual(r.httpStep, 'bootstrap');
    assert.match(r.httpReason, /bare bootstrap is refused/);
  });
});
