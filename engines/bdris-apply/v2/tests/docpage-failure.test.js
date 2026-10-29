/**
 * Document-page failure fix (2026-10-29) — mock only.
 *
 * Live report on main b2bd0cb2: Step 6 preview showed
 * "Document page not found — document page not open" even though
 * Step 5 documents were uploaded and marked present, after an
 * earlier SUBMIT_S2B (address op) timeout. Root cause: submitS3
 * failed immediately when its anchors were not visible in 10s,
 * with no site-step detection and no catch-up — while S4Prep
 * already solved the same problem for the contact step. The
 * engine-UI "documents present" mark is a draft mark, not a
 * site-upload proof, so it never contradicted the site state:
 * the site page was simply still behind (address step).
 *
 * The fix mirrors S4Prep for submitS3, with pre-docs catch-up
 * only (never a recursive submitS3): detect the site step, catch
 * up S0/S1/S2/S2B as needed, re-wait the anchors, and only then
 * fail honestly with a classified reason + machine-readable code.
 * No document is invented, no rejected submit is resent, no
 * name/BRN/DOB is altered. No live contact, no browser, no
 * personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/docpage-failure.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');

const DOC_ANCHORS = ['input[name="relationWithApplicant"]', 'input[name="files"]'];

function fakePage(state) {
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
  const fileHandle = {
    setInputFiles: async () => { state.uploads += 1; },
  };
  return {
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    waitForTimeout: async () => {},
    $: async (sel) => (String(sel).includes('input[type="file"]') ? fileHandle : null),
    waitForSelector: async () => ({ selectOption: async () => {} }),
    locator: () => ({ first: () => ({ elementHandle: async () => ({ click: async () => {} }) }) }),
    waitForFunction: async () => true,
  };
}

function makeHandler(state) {
  const h = new StepHandler({ page: fakePage(state) }, { emit: () => {} });
  h._clickNextAndWait = async () => ({ ok: true });
  h._detectValidationBlock = async () => ({ blocked: false });
  return h;
}

function docs() {
  const b64 = Buffer.from('fixture-image').toString('base64');
  return [
    { name: 'mother.jpg', mimeType: 'image/jpeg', base64: b64, docType: '40' },
    { name: 'father.jpg', mimeType: 'image/jpeg', base64: b64, docType: '41' },
  ];
}

// _waitVisible stub for submitS3 tests: the docs-anchor call fails
// the first time (site behind / re-render), then succeeds; contact
// anchors always succeed; everything else returns null.
function installWait(h, state) {
  h._waitVisible = async (sels) => {
    const list = Array.isArray(sels) ? sels : [sels];
    if (list.some((s) => s.includes('relationWithApplicant'))) {
      state.docsAnchorCalls += 1;
      return state.docsAnchorCalls === 1 ? null : { anchor: true };
    }
    if (list.some((s) => s.includes('#email') || s.includes('email'))) return { anchor: true };
    return null;
  };
}

describe('submitS3 anchor recovery: site behind at address step', () => {
  it('catches up with S2B once, then uploads both docs and succeeds', async () => {
    const state = { uploads: 0, docsAnchorCalls: 0, s2bCalls: 0 };
    const h = makeHandler(state);
    installWait(h, state);
    h._detectSiteStep = async () => ({ step: 4, probe: { form: true, bodyLen: 500, docs: false, contact: false } });
    h.submitS2B = async () => { state.s2bCalls += 1; return { ok: true }; };
    const out = await h.submitS3({ docs: docs(), s2b: { perm: {} } });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed));
    assert.strictEqual(state.s2bCalls, 1, 'exactly one S2B catch-up, never a second');
    assert.strictEqual(state.uploads, 2, 'both docs uploaded by this call, none invented');
    assert.strictEqual(out.docsAlreadyOnSite, undefined);
  });

  it('site already at contact step: recognises docs on site, no re-upload, no S2B', async () => {
    const state = { uploads: 0, docsAnchorCalls: 0, s2bCalls: 0 };
    const h = makeHandler(state);
    installWait(h, state);
    h._detectSiteStep = async () => ({ step: 6, probe: { form: true, bodyLen: 500, docs: false, contact: true } });
    h.submitS2B = async () => { state.s2bCalls += 1; return { ok: true }; };
    const out = await h.submitS3({ docs: docs(), s2b: { perm: {} } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.docsAlreadyOnSite, true);
    assert.strictEqual(state.s2bCalls, 0, 'no catch-up when the site is already past docs');
    assert.strictEqual(state.uploads, 0, 'docs already on site must not be re-uploaded');
  });

  it('site at docs step but anchors not visible: second wait succeeds, no S2B', async () => {
    const state = { uploads: 0, docsAnchorCalls: 0, s2bCalls: 0 };
    const h = makeHandler(state);
    installWait(h, state);
    h._detectSiteStep = async () => ({ step: 5, probe: { form: true, bodyLen: 500, docs: true, contact: false } });
    h.submitS2B = async () => { state.s2bCalls += 1; return { ok: true }; };
    const out = await h.submitS3({ docs: docs(), s2b: { perm: {} } });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed));
    assert.strictEqual(state.s2bCalls, 0, 'docs step needs a longer wait, not a catch-up');
    assert.strictEqual(state.uploads, 2);
  });

  it('catch-up fails honestly: classified code, replay reason, zero uploads', async () => {
    const state = { uploads: 0, docsAnchorCalls: 0, s2bCalls: 0 };
    const h = makeHandler(state);
    // Anchors never appear, even after catch-up.
    h._waitVisible = async (sels) => {
      const list = Array.isArray(sels) ? sels : [sels];
      if (list.some((s) => s.includes('#email'))) return { anchor: true };
      return null;
    };
    h._detectSiteStep = async () => ({ step: 4, probe: { form: true, bodyLen: 500, docs: false, contact: false } });
    h.submitS2B = async () => { state.s2bCalls += 1; return { ok: false, message: 'ঠিকানার ধাপে সমস্যা' }; };
    const out = await h.submitS3({ docs: docs(), s2b: { perm: {} } });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.failed[0].code, 'DOCS_ANCHORS_MISSING');
    assert.match(out.failed[0].reason, /ঠিকানার ধাপে আছে/);
    assert.notStrictEqual(out.failed[0].reason, 'প্রত্যয়ন/ডকুমেন্ট পেজ খোলা নেই', 'old generic reason must not return');
    assert.ok(out.failed.some((f) => f.code === 'S3_REPLAY_FAILED'), 'replay failure must be named, not swallowed');
    assert.strictEqual(state.uploads, 0, 'no document may be claimed uploaded on a failed run');
  });

  it('stub/empty page is classified, not labelled as a docs-step problem', async () => {
    const state = { uploads: 0, docsAnchorCalls: 0 };
    const h = makeHandler(state);
    h._waitVisible = async () => null;
    h._detectSiteStep = async () => ({ step: 0, probe: { form: false, bodyLen: 0, docs: false, contact: false } });
    const out = await h.submitS3({ docs: docs(), s0: {}, s1: {}, s2: {}, s2b: {} });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.failed[0].code, 'DOCS_ANCHORS_MISSING');
    assert.match(out.failed[0].reason, /খালি\/স্টাব পাতা/);
    assert.strictEqual(state.uploads, 0);
  });
});

describe('_catchUpToDocs: pre-docs plans only, never submitS3', () => {
  it('step 3 runs submitS2 then submitS2B, in order, and never submitS3', async () => {
    const h = makeHandler({ uploads: 0 });
    const order = [];
    h.submitS2 = async () => { order.push('submitS2'); return { ok: true }; };
    h.submitS2B = async () => { order.push('submitS2B'); return { ok: true }; };
    h.submitS3 = async () => { throw new Error('submitS3 must never run from catch-up'); };
    const out = await h._catchUpToDocs(3, { s2: {}, s2b: {} });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(order, ['submitS2', 'submitS2B']);
  });

  it('submitS2 verify-uncertain with parents fields gone continues (replay rule)', async () => {
    const h = makeHandler({ uploads: 0 });
    h._waitVisible = async () => null; // parents fields gone = site advanced
    h.submitS2 = async () => ({ ok: false, verifyUncertain: true, message: 'verify অনিশ্চিত' });
    h.submitS2B = async () => ({ ok: true });
    const out = await h._catchUpToDocs(3, { s2: {}, s2b: {} });
    assert.strictEqual(out.ok, true, 'uncertainty alone must not stop a catch-up the site already passed');
  });

  it('unknown site step fails honestly without running any step', async () => {
    const h = makeHandler({ uploads: 0 });
    h.submitS0 = async () => { throw new Error('no step may run for an unknown site step'); };
    const out = await h._catchUpToDocs(9, {});
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /চেনা যায়নি/);
  });
});
