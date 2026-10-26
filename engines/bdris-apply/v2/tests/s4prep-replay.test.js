/**
 * S4Prep replay (2026-10-26, permanent fix) — mock only.
 * When contact anchors (#email/#phone) are missing, submitS4Prep must
 * NOT fail immediately: it detects the site step once (v1 anchors) and
 * replays AT MOST ONCE — docs step: Next only (no doc re-upload);
 * unknown/steps 1-4: catch up from formCtx through S3 — then retries
 * the anchors once. If anchors are still missing it must fail
 * honestly with code CONTACT_ANCHORS_MISSING and must never click
 * the OTP button, verify an OTP, or submit. No live contact, no
 * browser, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/s4prep-replay.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StepHandler } = require('../services/StepHandler');
const { BdrisEngineV2 } = require('../server');

// Fake page: evaluate runs against a null-document (no anchors), so
// any real DOM path reports "nothing visible" unless a test stubs
// the handler methods below. _dismissNotices / cinno probe / phone
// normalisation all tolerate this shape.
function fakePage() {
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
  return {
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    waitForTimeout: async () => {},
  };
}

function makeHandler() {
  const h = new StepHandler({ page: fakePage() }, { emit: () => {} });
  return h;
}

// Install a controllable anchor/next/OTP stub set on one handler.
// state.contactVisible flips when the test's Next stub runs.
function installStubs(h, state) {
  h._waitVisible = async (sels) => {
    const list = Array.isArray(sels) ? sels : [sels];
    const isContact = list.some((s) => s.includes('#email') || s.includes('email') || s.includes('#phone') || s.includes('phone'));
    if (isContact) return state.contactVisible ? { anchor: true } : null;
    if (list.some((s) => s.includes('ওটিপি পাঠান'))) return { button: true };
    return null;
  };
  h._typeInto = async () => ({ ok: true });
  h._robustClick = async (target, label) => {
    state.robustClicks.push(label || '');
    return true;
  };
  h._waitOtpEvidence = async () => {
    state.otpEvidenceCalls += 1;
    return { ok: true, note: 'mock otp evidence' };
  };
  h._detectSiteStep = async () => ({ step: state.siteStep, probe: state.probe });
  h._clickNextAndWait = async (label) => {
    state.nextCalls.push(label);
    if (state.nextAdvances) state.contactVisible = true;
    return state.nextResult;
  };
}

describe('S4Prep replay: docs step -> Next only -> contact', () => {
  it('succeeds with exactly one replay, no doc re-upload, OTP sent', async () => {
    const h = makeHandler();
    const state = {
      contactVisible: false, siteStep: 5, nextCalls: [], nextResult: { ok: true },
      nextAdvances: true, robustClicks: [], otpEvidenceCalls: 0,
      probe: { contact: false, docs: true, start: false, form: true, bodyLen: 500 },
    };
    installStubs(h, state);
    h.submitS3 = async () => { throw new Error('S3 must not run on a docs-step replay'); };
    h.submitS4 = async () => { throw new Error('submit must never run from S4Prep'); };
    const out = await h.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed));
    assert.strictEqual(out.otpSent, true);
    assert.strictEqual(out.s4prepReplay.replayed, 'docs-next');
    assert.strictEqual(out.s4prepReplay.siteStep, 5);
    assert.strictEqual(state.nextCalls.length, 1, 'exactly one Next replay');
    assert.strictEqual(state.otpEvidenceCalls, 1);
    assert.deepStrictEqual(h.contact, { email: 'test@example.com', phone: '01900000000' });
  });

  it('fails honestly after exactly one replay, zero OTP clicks, when contact never appears', async () => {
    const h = makeHandler();
    const state = {
      contactVisible: false, siteStep: 5, nextCalls: [], nextResult: { ok: true },
      nextAdvances: false, robustClicks: [], otpEvidenceCalls: 0,
      probe: { contact: false, docs: true, start: false, form: true, bodyLen: 500 },
    };
    installStubs(h, state);
    const out = await h.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.otpSent, false);
    assert.strictEqual(out.code, 'CONTACT_ANCHORS_MISSING');
    assert.strictEqual(out.failed[0].code, 'CONTACT_ANCHORS_MISSING');
    assert.strictEqual(state.nextCalls.length, 1, 'exactly one replay, never a second');
    assert.strictEqual(state.robustClicks.filter((l) => l.includes('ওটিপি পাঠান')).length, 0, 'OTP send button must never be clicked');
    assert.strictEqual(state.otpEvidenceCalls, 0);
  });

  it('fails honestly when the docs-step Next itself fails, still exactly one replay', async () => {
    const h = makeHandler();
    const state = {
      contactVisible: false, siteStep: 5, nextCalls: [], nextResult: { ok: false, field: 'পরবর্তী', reason: 'বাটন পাওয়া যায়নি' },
      nextAdvances: false, robustClicks: [], otpEvidenceCalls: 0,
      probe: { contact: false, docs: true, start: false, form: true, bodyLen: 500 },
    };
    installStubs(h, state);
    const out = await h.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'CONTACT_ANCHORS_MISSING');
    assert.strictEqual(state.nextCalls.length, 1);
    assert.strictEqual(state.otpEvidenceCalls, 0);
  });
});

describe('S4Prep replay: unknown step catch-up from formCtx', () => {
  it('runs S0-S3 exactly once each, in order, then succeeds', async () => {
    const h = makeHandler();
    const state = {
      contactVisible: false, siteStep: 0, nextCalls: [], nextResult: { ok: true },
      nextAdvances: false, robustClicks: [], otpEvidenceCalls: 0,
      probe: { contact: false, docs: false, start: false, form: true, bodyLen: 500 },
    };
    installStubs(h, state);
    const order = [];
    const args = {};
    for (const m of ['submitS0', 'submitS1', 'submitS2', 'submitS2B']) {
      h[m] = async (a) => { order.push(m); args[m] = a; return { ok: true }; };
    }
    h.submitS3 = async (a) => {
      order.push('submitS3'); args.submitS3 = a; state.contactVisible = true; return { ok: true };
    };
    h.submitS4 = async () => { throw new Error('submit must never run from S4Prep'); };
    const ctx = {
      s0: { addressType: 'BIRTHPLACE' },
      s1: { firstNameBn: 'Fixture', dob: '2020-01-01' },
      s2: { father: { nameBn: 'Fixture' } },
      s2b: { perm: {} },
    };
    const out = await h.submitS4Prep({
      email: 'test@example.com', phone: '01900000000', ...ctx,
      docs: [{ name: 'a.jpg', docType: '40', base64: 'AAAA' }],
    });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed));
    assert.strictEqual(out.otpSent, true);
    assert.strictEqual(out.s4prepReplay.replayed, 'catch-up');
    assert.deepStrictEqual(order, ['submitS0', 'submitS1', 'submitS2', 'submitS2B', 'submitS3']);
    assert.strictEqual(args.submitS1.docsAvailable, true, 'S1 catch-up keeps docsAvailable');
    assert.strictEqual(state.otpEvidenceCalls, 1);
  });

  it('unknown step with no formCtx returns resumable and runs no catch-up step', async () => {
    const h = makeHandler();
    const state = {
      contactVisible: false, siteStep: 1, nextCalls: [], nextResult: { ok: true },
      nextAdvances: false, robustClicks: [], otpEvidenceCalls: 0,
      probe: { contact: false, docs: false, start: true, form: true, bodyLen: 500 },
    };
    installStubs(h, state);
    let catchUpCalls = 0;
    for (const m of ['submitS0', 'submitS1', 'submitS2', 'submitS2B', 'submitS3']) {
      h[m] = async () => { catchUpCalls += 1; return { ok: true }; };
    }
    const out = await h.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.resumable, true);
    assert.strictEqual(out.otpSent, false);
    assert.strictEqual(catchUpCalls, 0, 'no catch-up without formCtx');
    assert.strictEqual(state.nextCalls.length, 0);
    assert.strictEqual(state.otpEvidenceCalls, 0);
  });
});

describe('server docs carry S3 -> S4Prep (replay needs docs)', () => {
  it('stores session.docs on S3 and hands them to a docs-less S4Prep', async () => {
    let connectionCb = null;
    const io = { use: () => {}, on: (ev, cb) => { if (ev === 'connection') connectionCb = cb; } };
    const engine = new BdrisEngineV2(io, {});
    const session = { id: 'sess_docs', page: fakePage() };
    const ctx = { session, emit: () => {}, socket: { abcUser: { id: 'u1' } } };
    const docs = [{ name: 'a.jpg', docType: '40', base64: 'AAAA' }];
    const origS3 = StepHandler.prototype.submitS3;
    StepHandler.prototype.submitS3 = async function () { return { ok: true, step: 6 }; };
    try {
      await engine.executor.execute('SUBMIT_S3_DOCS', { docs, relation: 'SELF' }, ctx);
    } finally { StepHandler.prototype.submitS3 = origS3; }
    assert.deepStrictEqual(session.docs, docs);
    const origPrep = StepHandler.prototype.submitS4Prep;
    let captured = null;
    StepHandler.prototype.submitS4Prep = async function (data) { captured = data; return { ok: true, otpSent: true }; };
    try {
      await engine.executor.execute('SUBMIT_S4_PREP', { email: 't@e.com', phone: '01900000000' }, ctx);
    } finally { StepHandler.prototype.submitS4Prep = origPrep; }
    assert.deepStrictEqual(captured.docs, docs, 'S4Prep replay must receive docs even when its own payload has none');
  });
});

describe('S4Prep timeout raised for replay + OTP evidence', () => {
  it('registers SUBMIT_S4_PREP with a 300000ms timeout', async () => {
    let connectionCb = null;
    const io = { use: () => {}, on: (ev, cb) => { if (ev === 'connection') connectionCb = cb; } };
    const engine = new BdrisEngineV2(io, {});
    assert.ok(connectionCb, 'engine must register a connection handler');
    const reg = engine.executor.handlers.get('SUBMIT_S4_PREP');
    assert.ok(reg, 'SUBMIT_S4_PREP must be registered');
    assert.strictEqual(reg.timeoutMs, 300000);
  });
});
