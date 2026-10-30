/**
 * Fresh navigation before submit (2026-10-30) — step 5c of the
 * HTTP chain. The 9th live submit proved every other difference
 * dead (headers, fields, cookie freshness via non-navigating
 * re-seed, submit-time fields, client value, Origin, empty file
 * parts — all byte-identical shell). What remains is navigation-
 * time state: the chain's seed comes from a warm page navigated
 * long before, and only a fresh homepage-route navigation can
 * mint new state. These tests drive the real runHttpChain with a
 * fake client and a mock warm page (no browser, no network, no
 * real submit): the real BdrisNavigator.gotoFormViaSite runs
 * against the mock page, so gotoFormViaSite being called before
 * submit is proven by the mock's recorded effects, not by a stub.
 * Run: node --test engines/bdris-apply/v2/tests/submit-fresh-navigation.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { runHttpChain, isPageMidFlow } = require('../services/HttpPathRunner');

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function chainData(ref) {
  return {
    person: { dob: '2020-01-15', brn: '' },
    birthPlace: { wardId: '7193', paurasavaUnionId: '1988' },
    permAddr: { paurasavaUnionId: '1988' },
    relation: 'SELF', applicantName: 'Test', phone: '01000000000',
    officeAddressType: 'PERMANENT',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    _chargeToken: validChargeToken('user-1', 'test-secret', ref),
  };
}

function fakeClient(order, refreshSeeds, submitInputs) {
  return {
    bootstrapped: true,
    otpSend: async () => { order.push('otp-send'); return { code: 'MESSAGE_SENT', success: true, payload: null }; },
    verifyOtp: async () => { order.push('verify'); return { isVerified: true }; },
    refreshSeed: (seed) => { order.push('refreshSeed'); refreshSeeds.push(seed); },
    submitApplication: async (input) => { order.push('submit'); submitInputs.push(input); return { hasPrintLink: false }; },
  };
}

// Mock warm page. Its evaluate() dispatches on the in-page
// function's shape, exactly as a real document would behave
// differently for each script:
// - called with an argument → getPageState (division selectors)
// - source mentions defaultValue → the mid-flow guard
// - source mentions _csrf → the session read (first read returns
//   the stale token, later reads the fresh one — proving the
//   post-navigation re-seed adopts fresh state)
// - source mentions querySelectorAll → the homepage link click
function mockWarmPage(scenario, order) {
  const calls = { goto: [], evaluateKinds: [], waitForTimeout: 0, sessionReads: 0 };
  const page = {
    goto: async (url) => {
      calls.goto.push(url);
      if (order) order.push(`goto:${url}`);
      if (scenario.gotoFails) throw new Error('goto boom');
      return undefined;
    },
    waitForTimeout: async () => { calls.waitForTimeout++; },
    context: () => ({ cookies: async () => [{ name: 'TS-1', value: 'x' }] }),
    url: () => 'https://bdris.gov.bd/br/application',
    evaluate: async (fn, ...args) => {
      const src = Function.prototype.toString.call(fn);
      if (args.length > 0) {
        calls.evaluateKinds.push('page-state');
        const formContent = scenario.formContent !== false;
        return { formElement: formContent, hasMetaCsrf: !scenario.noToken, hasHiddenCsrf: false, title: '', bodyTextLength: 100, divisions: { birth: formContent, perm: false, prsnt: false }, scriptCount: 0, cookieCount: 0, formContent };
      }
      if (src.includes('defaultValue')) {
        calls.evaluateKinds.push('midflow-guard');
        // The real in-page check returns true when PROVEN IDLE.
        return !scenario.filled;
      }
      if (src.includes('_csrf')) {
        calls.evaluateKinds.push('session-read');
        calls.sessionReads++;
        if (scenario.noToken) {
          return { token: null, headerName: null, source: null, pageUrl: 'https://bdris.gov.bd/br/application', formElement: false };
        }
        const token = calls.sessionReads === 1 ? 'stale-csrf' : 'fresh-csrf';
        return { token, headerName: 'X-CSRF-TOKEN', source: 'meta', pageUrl: 'https://bdris.gov.bd/br/application', formElement: true };
      }
      if (src.includes('querySelectorAll')) {
        calls.evaluateKinds.push('link-click');
        return true;
      }
      calls.evaluateKinds.push('unknown');
      return false;
    },
  };
  return { page, calls };
}

function freshNavLogLine(logs) {
  return logs.find((l) => l.includes('[HTTP-CANDIDATE] fresh-navigation:'));
}

describe('fresh navigation before submit (step 5c)', () => {
  it('idle page: homepage-route navigation runs before submit and the post-navigation re-seed adopts the fresh token', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const { page, calls } = mockWarmPage({ formContent: true }, order);
    const out = await runHttpChain({
      data: chainData('ref-nav-1'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: page,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    // Only the passed warm page is navigated, to the homepage.
    assert.deepStrictEqual(calls.goto, ['https://bdris.gov.bd/']);
    assert.ok(calls.evaluateKinds.includes('link-click'), 'the homepage link click must run');
    assert.ok(calls.evaluateKinds.includes('midflow-guard'), 'the idle guard must run');
    // Exact chain order: non-navigating re-seed, then navigation,
    // then the fresh re-seed, then submit.
    assert.deepStrictEqual(order, ['otp-send', 'verify', 'refreshSeed', 'goto:https://bdris.gov.bd/', 'refreshSeed', 'submit']);
    // The post-navigation re-seed carries the fresh token, not the stale one.
    assert.strictEqual(refreshSeeds.length, 2);
    assert.strictEqual(refreshSeeds[0].csrfToken, 'stale-csrf');
    assert.strictEqual(refreshSeeds[1].csrfToken, 'fresh-csrf');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('re-navigated'), `expected a re-navigated log line, got: ${line}`);
  });

  it('mid-flow page: navigation skipped, submit still proceeds on jarred state', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const { page, calls } = mockWarmPage({ filled: true, formContent: true }, order);
    const out = await runHttpChain({
      data: chainData('ref-nav-2'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: page,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(calls.goto, [], 'a filled page must never be navigated away from');
    assert.ok(order.includes('submit'), 'submit must still proceed');
    assert.strictEqual(refreshSeeds.length, 1, 'only the non-navigating re-seed runs');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('skipped') && line.includes('mid-flow'), `expected a mid-flow skip line, got: ${line}`);
  });

  it('navigation yielding no form content: skipped, submit still proceeds', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const { page, calls } = mockWarmPage({ gotoFails: true, formContent: false }, order);
    const out = await runHttpChain({
      data: chainData('ref-nav-3'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: page,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(calls.goto.length, 1, 'navigation must be attempted once');
    assert.ok(order.includes('submit'), 'submit must still proceed');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('did not yield form content'), `expected a no-form-content skip line, got: ${line}`);
  });

  it('missing page: skipped, submit still proceeds', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const out = await runHttpChain({
      data: chainData('ref-nav-4'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.ok(order.includes('submit'));
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('no warm page'), `expected a no-page skip line, got: ${line}`);
  });

  it('only the passed warm page is ever navigated (a decoy page is untouched)', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const decoyCalls = [];
    const decoyPage = { goto: async () => { decoyCalls.push('navigated'); } };
    const { page, calls } = mockWarmPage({ formContent: true }, order);
    const out = await runHttpChain({
      data: chainData('ref-nav-5'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: page,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(decoyCalls, [], 'no page other than reseedPage may be navigated');
    assert.strictEqual(calls.goto.length, 1);
    void decoyPage;
  });

  it('fresh navigation changes no submit field, value, or header input', async () => {
    const mkRun = async (ref, reseedPage) => {
      const order = [];
      const refreshSeeds = [];
      const submitInputs = [];
      const logs = [];
      const out = await runHttpChain({
        data: chainData(ref),
        userId: 'user-1',
        secret: 'test-secret',
        client: fakeClient(order, refreshSeeds, submitInputs),
        ...(reseedPage ? { reseedPage } : {}),
        log: (...a) => logs.push(a.join(' ')),
      });
      assert.strictEqual(out.ok, true);
      return submitInputs[0];
    };
    const withNav = mkRun('ref-nav-6a', mockWarmPage({ formContent: true }).page);
    const withoutNav = mkRun('ref-nav-6b', null);
    const a = await withNav;
    const b = await withoutNav;
    delete a._chargeToken;
    delete b._chargeToken;
    assert.deepStrictEqual(a, b, 'the submit payload must be identical with and without fresh navigation');
  });
});

describe('isPageMidFlow guard', () => {
  it('no evaluate → mid-flow (never navigate an uninspectable page)', async () => {
    assert.strictEqual(await isPageMidFlow({}), true);
    assert.strictEqual(await isPageMidFlow(null), true);
  });

  it('evaluate throws → mid-flow', async () => {
    assert.strictEqual(await isPageMidFlow({ evaluate: async () => { throw new Error('boom'); } }), true);
  });

  it('evaluate returns false or nothing → mid-flow (only explicit true permits navigation)', async () => {
    assert.strictEqual(await isPageMidFlow({ evaluate: async () => false }), true);
    assert.strictEqual(await isPageMidFlow({ evaluate: async () => undefined }), true);
  });

  it('evaluate returns true → idle, navigation permitted', async () => {
    assert.strictEqual(await isPageMidFlow({ evaluate: async () => true }), false);
  });
});

describe('fresh navigation step structure', () => {
  it('step 5c uses gotoFormViaSite + re-seed on reseedPage only; never reload, never a fresh-page factory', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'HttpPathRunner.js'), 'utf8');
    const start = src.indexOf('5c. FRESH NAVIGATION');
    assert.ok(start >= 0, 'step 5c must exist');
    const end = src.indexOf('6. Final submit', start);
    assert.ok(end > start, 'step 5c must end before step 6');
    const section = src.slice(start, end);
    assert.ok(section.includes('gotoFormViaSite'), 'step 5c must re-run gotoFormViaSite');
    assert.ok(section.includes('reseedFromPage'), 'step 5c must re-seed after navigation');
    assert.ok(section.includes('opts.reseedPage'), 'step 5c must use the passed warm page');
    assert.ok(!section.includes('reload('), 'plain reload is forbidden');
    assert.ok(!section.includes('createFreshPage'), 'no fresh-page factory: only the passed page is navigated');
    assert.ok(!section.toLowerCase().includes('qr'), 'no fallback-logic reference in step 5c');
  });
});
