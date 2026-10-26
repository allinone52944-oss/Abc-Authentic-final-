/**
 * BDRIS zone stub-page fix (senior investigation 2026-10-26):
 * hardened session context, gotoForm polling, in-site navigation,
 * and safe navigation diagnostics. Mock pages only — no live
 * bdris.gov.bd contact, no browser, no personal data.
 *
 * Live shape reproduced: direct goto to /br/application yields a
 * stub (form element false, title '', body length 44, no token,
 * no divisions), while the homepage carries a real
 * /br/application link whose click renders the form.
 *
 * Run: node --test engines/bdris-apply/v2/tests/navigator-stub-fix.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisNavigator } = require('../services/BdrisNavigator');
const { BrowserManager, SESSION_USER_AGENT, SESSION_LOCALE } = require('../core/BrowserManager');

function resp(status, url) {
  return {
    status: () => status,
    url: () => url,
    headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
    request: () => ({ redirectedFrom: () => null }),
  };
}

// Fake page: 'stub' (direct form goto), 'home' (homepage with a
// real /br/application link), 'form' (rendered form). An evaluate
// click on the homepage link flips the page to 'form', modelling
// in-site navigation. No live contact.
function makePage({ homeHasLink = true, slowRenderAfter = null } = {}) {
  let state = 'stub';
  let currentUrl = 'https://bdris.gov.bd/br/application';
  let evaluateCalls = 0;
  const page = {
    url: () => currentUrl,
    goto: async (u) => {
      if (u === 'https://bdris.gov.bd/') {
        state = 'home';
        currentUrl = u;
        return resp(200, u);
      }
      state = 'stub';
      currentUrl = u;
      return resp(403, u);
    },
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      evaluateCalls++;
      if (slowRenderAfter !== null && evaluateCalls > slowRenderAfter) state = 'form';
      const isForm = state === 'form';
      const link = {
        getAttribute: (n) => (n === 'href' ? '/br/application' : null),
        click: () => { state = 'form'; currentUrl = 'https://bdris.gov.bd/br/application'; },
      };
      const doc = {
        get title() { return isForm ? 'Birth Registration' : ''; },
        body: { get innerText() { return isForm ? 'form content here' : 'x'.repeat(44); } },
        scripts: isForm ? [{}, {}] : [],
        cookie: isForm ? 'a=1; b=2' : '',
        querySelector: (sel) => {
          if (!isForm) return null;
          if (sel === 'form#birth_application_form' || sel === 'form') return {};
          if (sel === 'meta[name="_csrf"]') return { content: 'fixture' };
          if (sel === 'input[name="_csrf"]') return { value: 'fixture' };
          if (sel.includes('Div')) return { options: [{ value: '', text: '--- নির্বাচন করুন ---' }] };
          return null;
        },
        querySelectorAll: (sel) => {
          if (state === 'home' && homeHasLink && sel === 'a[href]') return [link];
          return [];
        },
      };
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
  };
  return page;
}

describe('BrowserManager hardened session context (v1 settings, 2026-10-26)', () => {
  it('exports the v1 user-agent and locale, and launches with AutomationControlled disabled', () => {
    assert.strictEqual(SESSION_LOCALE, 'bn-BD');
    assert.match(SESSION_USER_AGENT, /Chrome\/124\.0\.0\.0/);
    const bm = new BrowserManager();
    assert.ok(bm.launchOptions.args.includes('--disable-blink-features=AutomationControlled'));
  });

  it('newContext defaults to the hardened settings; UA/locale are non-overridable, other options still win', async () => {
    const bm = new BrowserManager();
    let captured = null;
    bm.launch = async () => ({ newContext: async (opts) => { captured = opts; return {}; } });
    await bm.newContext();
    assert.strictEqual(captured.locale, 'bn-BD');
    assert.strictEqual(captured.userAgent, SESSION_USER_AGENT);
    assert.strictEqual(captured.ignoreHTTPSErrors, true);
    assert.deepStrictEqual(captured.viewport, { width: 1280, height: 800 });
    // G5 (A-to-Z audit): a caller passing stock UA/locale must not
    // silently unharden a session page, but viewport still wins.
    await bm.newContext({ locale: 'en-US', userAgent: 'stock', viewport: { width: 800, height: 600 } });
    assert.strictEqual(captured.locale, 'bn-BD');
    assert.strictEqual(captured.userAgent, SESSION_USER_AGENT);
    assert.deepStrictEqual(captured.viewport, { width: 800, height: 600 });
  });
});

describe('BdrisNavigator gotoForm: poll + in-site navigation + diagnostics', () => {
  it('a slow render found via the homepage route resolves, without a direct-goto stub first', async () => {
    // Homepage-first (2026-10-26): the form is reached via the
    // homepage link, so there is no direct-goto navigation to
    // record; the homepage route itself must have found the link.
    const page = makePage({ slowRenderAfter: 2 });
    const nav = new BdrisNavigator(page);
    await nav.gotoForm();
    assert.strictEqual(nav.lastSiteNavigation.foundLink, true);
  });

  it('a persistent stub throws naming the navigation and the failed in-site attempt', async () => {
    const page = makePage({ homeHasLink: false });
    const nav = new BdrisNavigator(page);
    await assert.rejects(
      () => nav.gotoForm(),
      (e) => /form content not loaded/.test(e.message)
        && /navigation: status=403/.test(e.message)
        && /in-site navigation: no \/br\/application link found on homepage/.test(e.message),
    );
  });

  it('a stub direct goto followed by a homepage link click renders the form and resolves', async () => {
    const page = makePage({ homeHasLink: true });
    const nav = new BdrisNavigator(page);
    await nav.gotoForm();
    assert.strictEqual(nav.lastSiteNavigation.foundLink, true);
  });

  it('page state carries script/cookie counts and navigation, and describe names them', async () => {
    const page = makePage({ slowRenderAfter: 0 });
    const nav = new BdrisNavigator(page);
    await nav.gotoForm();
    const state = await nav.getPageState();
    assert.strictEqual(state.scriptCount, 2);
    assert.strictEqual(state.cookieCount, 2);
    const text = BdrisNavigator.describePageState(state);
    assert.match(text, /scripts: 2, cookies: 2/);
    // Homepage-first: no direct goto happened, so there is no
    // direct navigation to describe; the form itself must be present.
    assert.strictEqual(state.formContent, true);
  });

  it('contentChanged distinguishes a changing page from a persistent 44-char stub', async () => {
    const changing = new BdrisNavigator(makePage({ slowRenderAfter: 2 }));
    const found = await changing.waitForFormContent(10);
    assert.strictEqual(found.formContent, true);
    const stub = new BdrisNavigator(makePage({ homeHasLink: false }));
    const still = await stub.waitForFormContent(3);
    assert.strictEqual(still.formContent, false);
    assert.strictEqual(still.contentChanged, false);
    assert.strictEqual(still.bodyTextLength, 44);
  });
});

describe('ensureFormPage fresh-page branch: in-site navigation after a stub fresh page', () => {
  it('a fresh stub page whose homepage links to the form renders via the link', async () => {
    const stale = makePage({ homeHasLink: false });
    const fresh = makePage({ homeHasLink: true });
    let factoryCalls = 0;
    const nav = new BdrisNavigator(stale, {
      createFreshPage: async () => { factoryCalls++; return fresh; },
    });
    const check = await nav.ensureFormPage('perm');
    assert.strictEqual(check.formPresent, true);
    assert.strictEqual(factoryCalls, 1);
    assert.strictEqual(nav.page, fresh);
  });

  it('a fresh stub page with no homepage link still classifies false with the site note', async () => {
    const stale = makePage({ homeHasLink: false });
    const fresh = makePage({ homeHasLink: false });
    const nav = new BdrisNavigator(stale, {
      createFreshPage: async () => fresh,
    });
    const check = await nav.ensureFormPage('perm');
    assert.strictEqual(check.formPresent, false);
    assert.match(
      BdrisNavigator.describePageState(check.pageState),
      /in-site navigation: no \/br\/application link found on homepage/,
    );
  });
});
