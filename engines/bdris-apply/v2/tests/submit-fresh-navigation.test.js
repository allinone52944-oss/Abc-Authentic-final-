/**
 * Dedicated-page fresh navigation before submit (2026-10-30) — step 5c
 * of the HTTP chain. Attempt 10's journal proved the OLD step 5c
 * (navigate the shared session.page behind an idle-guard) SKIPPED:
 * the guard correctly refused a page the bot fallback builds
 * StepHandler on, so fresh navigation could never run on the shared
 * page. Step 5c now navigates a FRESH, dedicated page (created by
 * the executor's factory, closed in a finally) and never navigates
 * session.page or the user's tab. These tests drive the real
 * runHttpChain with a fake client and mock pages (no browser, no
 * network, no real submit): the real BdrisNavigator.gotoFormViaSite
 * runs against the mock dedicated page, so navigation is proven by
 * the mock's recorded effects, not by a stub.
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

// Mock page. Its evaluate() dispatches on the in-page function's
// shape, exactly as the old warm-page mock did:
// - called with an argument → getPageState (form-content poll)
// - source mentions _csrf → the session read (returns the page's
//   token; noToken → null token, proving the reseed skip)
// - source mentions querySelectorAll → the homepage link click
function mockPage(scenario, order) {
  const calls = { goto: [], evaluateKinds: [], waitForTimeout: 0, closed: false };
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
    close: async () => { calls.closed = true; if (order) order.push('close'); },
    evaluate: async (fn, ...args) => {
      const src = Function.prototype.toString.call(fn);
      if (args.length > 0) {
        calls.evaluateKinds.push('page-state');
        const formContent = scenario.formContent !== false;
        return { formElement: formContent, hasMetaCsrf: !scenario.noToken, hasHiddenCsrf: false, title: '', bodyTextLength: 100, divisions: { birth: formContent, perm: false, prsnt: false }, scriptCount: 0, cookieCount: 0, formContent };
      }
      if (src.includes('_csrf')) {
        calls.evaluateKinds.push('session-read');
        if (scenario.noToken) {
          return { token: null, headerName: null, source: null, pageUrl: 'https://bdris.gov.bd/br/application', formElement: false };
        }
        return { token: scenario.token || 'page-csrf', headerName: 'X-CSRF-TOKEN', source: 'meta', pageUrl: 'https://bdris.gov.bd/br/application', formElement: true };
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

describe('dedicated-page fresh navigation before submit (step 5c)', () => {
  it('dedicated page: created, homepage-route navigated, re-seeded from it, closed; session.page never navigated', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const closed = [];
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const dedicated = mockPage({ token: 'dedicated-csrf' }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-1'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      createDedicatedPage: async () => { order.push('create'); return dedicated.page; },
      closeDedicatedPage: async (p) => { closed.push(p); await p.close(); },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    // Only the dedicated page is navigated, to the homepage.
    assert.deepStrictEqual(dedicated.calls.goto, ['https://bdris.gov.bd/']);
    assert.deepStrictEqual(warm.calls.goto, [], 'the shared session.page must never be navigated');
    assert.ok(dedicated.calls.evaluateKinds.includes('link-click'), 'the homepage link click must run');
    assert.strictEqual(closed.length, 1, 'the dedicated page must be closed');
    assert.strictEqual(closed[0], dedicated.page);
    // Exact chain order: non-navigating re-seed, then dedicated
    // creation + navigation + fresh re-seed + close, then submit.
    assert.deepStrictEqual(order, ['otp-send', 'verify', 'refreshSeed', 'create', 'goto:https://bdris.gov.bd/', 'refreshSeed', 'close', 'submit']);
    // The post-navigation re-seed carries the dedicated token.
    assert.strictEqual(refreshSeeds.length, 2);
    assert.strictEqual(refreshSeeds[0].csrfToken, 'stale-csrf');
    assert.strictEqual(refreshSeeds[1].csrfToken, 'dedicated-csrf');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('dedicated page re-navigated'), `expected a dedicated re-navigated log line, got: ${line}`);
  });

  it('factory throws: skipped, submit still proceeds, nothing to close', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const closed = [];
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-2'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      createDedicatedPage: async () => { throw new Error('no browser'); },
      closeDedicatedPage: async (p) => { closed.push(p); },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.ok(order.includes('submit'), 'submit must still proceed');
    assert.deepStrictEqual(closed, [], 'nothing was created, so nothing closes');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('skipped') && line.includes('failed'), `expected a failed-navigation skip line, got: ${line}`);
  });

  it('navigation yielding no form content: skipped, page still closed, submit still proceeds', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const closed = [];
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const dedicated = mockPage({ gotoFails: true, formContent: false, token: 'dedicated-csrf' }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-3'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      createDedicatedPage: async () => dedicated.page,
      closeDedicatedPage: async (p) => { closed.push(p); await p.close(); },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(dedicated.calls.goto.length, 1, 'navigation must be attempted once');
    assert.strictEqual(closed.length, 1, 'a failed navigation must still close its page');
    assert.ok(order.includes('submit'), 'submit must still proceed');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('did not yield form content'), `expected a no-form-content skip line, got: ${line}`);
  });

  it('dedicated page without a token: reseed skipped, page closed, submit still proceeds', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const closed = [];
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const dedicated = mockPage({ noToken: true, formContent: true }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-4'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      createDedicatedPage: async () => dedicated.page,
      closeDedicatedPage: async (p) => { closed.push(p); await p.close(); },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(closed.length, 1, 'a tokenless page must still be closed');
    assert.ok(order.includes('submit'), 'submit must still proceed');
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('skipped') && line.includes('token missing'), `expected a token-missing skip line, got: ${line}`);
  });

  it('no factory supplied: skipped, submit still proceeds', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-5'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.ok(order.includes('submit'));
    const line = freshNavLogLine(logs);
    assert.ok(line && line.includes('no dedicated-page factory'), `expected a no-factory skip line, got: ${line}`);
  });

  it('only the dedicated page is ever navigated (a decoy page is untouched)', async () => {
    const order = [];
    const refreshSeeds = [];
    const submitInputs = [];
    const logs = [];
    const decoyCalls = [];
    const decoyPage = { goto: async () => { decoyCalls.push('navigated'); } };
    const warm = mockPage({ token: 'stale-csrf' }, order);
    const dedicated = mockPage({ token: 'dedicated-csrf' }, order);
    const out = await runHttpChain({
      data: chainData('ref-dnav-6'),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient(order, refreshSeeds, submitInputs),
      reseedPage: warm.page,
      createDedicatedPage: async () => dedicated.page,
      closeDedicatedPage: async (p) => { await p.close(); },
      log: (...a) => logs.push(a.join(' ')),
    });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(decoyCalls, [], 'no page other than the dedicated page may be navigated');
    assert.deepStrictEqual(warm.calls.goto, [], 'the shared session.page must never be navigated');
    assert.strictEqual(dedicated.calls.goto.length, 1);
    void decoyPage;
  });

  it('dedicated navigation changes no submit field, value, or header input', async () => {
    const mkRun = async (ref, withDedicated) => {
      const order = [];
      const refreshSeeds = [];
      const submitInputs = [];
      const logs = [];
      const dedicated = mockPage({ token: 'dedicated-csrf' }, order);
      const out = await runHttpChain({
        data: chainData(ref),
        userId: 'user-1',
        secret: 'test-secret',
        client: fakeClient(order, refreshSeeds, submitInputs),
        ...(withDedicated ? {
          createDedicatedPage: async () => dedicated.page,
          closeDedicatedPage: async (p) => { await p.close(); },
        } : {}),
        log: (...a) => logs.push(a.join(' ')),
      });
      assert.strictEqual(out.ok, true);
      return submitInputs[0];
    };
    const a = await mkRun('ref-dnav-7a', true);
    const b = await mkRun('ref-dnav-7b', false);
    delete a._chargeToken;
    delete b._chargeToken;
    assert.deepStrictEqual(a, b, 'the submit payload must be identical with and without dedicated navigation');
  });
});

describe('isPageMidFlow guard (kept exported; step 5c no longer needs it)', () => {
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

describe('dedicated navigation step structure', () => {
  it('step 5c uses a dedicated-page factory + close + gotoFormViaSite + re-seed; never navigates reseedPage, never reload', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'HttpPathRunner.js'), 'utf8');
    const start = src.indexOf('5c. DEDICATED-PAGE FRESH NAVIGATION');
    assert.ok(start >= 0, 'step 5c must exist');
    const end = src.indexOf('6. Final submit', start);
    assert.ok(end > start, 'step 5c must end before step 6');
    const section = src.slice(start, end);
    assert.ok(section.includes('createDedicatedPage'), 'step 5c must create a dedicated page');
    assert.ok(section.includes('closeDedicatedPage'), 'step 5c must close the dedicated page');
    assert.ok(section.includes('gotoFormViaSite'), 'step 5c must re-run gotoFormViaSite');
    assert.ok(section.includes('reseedFromPage'), 'step 5c must re-seed after navigation');
    assert.ok(!section.includes('opts.reseedPage'), 'step 5c must never navigate the shared session.page');
    assert.ok(!section.includes('isPageMidFlow'), 'no idle-guard on a fresh page: nothing shared to protect');
    assert.ok(!section.includes('reload('), 'plain reload is forbidden');
    assert.ok(!section.toLowerCase().includes('qr'), 'no fallback-logic reference in step 5c');
  });
});
