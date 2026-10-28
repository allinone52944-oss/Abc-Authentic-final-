/**
 * S4Prep-area fixes (2026-10-28, permanent contract fixes, items 4/6/22):
 *  A. HTTP-chain Playwright fallback carries the per-step merge context
 *     (s0/s1/s2/s2b, docs, contact, relation, singleName, applicantDob).
 *  B. Relation plumbing end to end: frontend S4Prep payload + ctx ->
 *     server merge -> catch-up submitS3 args (non-undefined), so the
 *     relation radio is selected during replay.
 *  C. Legacy SUBMIT_* auto-init gotoForm failure destroys the session
 *     and clears the closure sessionId (mirroring INIT/START/
 *     GET_ADDRESS/PROBE).
 *
 * NOTE on the relation test: s4prep-replay.test.js stubs submitS3,
 * which would stub away the very wiring this fix proves. Here the
 * replay runs FOR REAL (_replayToContact) and only the leaf step
 * methods are recording spies — the test asserts what arguments
 * the real replay passes to submitS3, not what submitS3 does with
 * them (the radio click itself is a page effect, out of scope).
 *
 * Run: node --test engines/bdris-apply/v2/tests/s4area-fixes.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { BdrisEngineV2, mergeStepParams, buildPlaywrightFallbackPlan } = require('../server');
const { StepHandler } = require('../services/StepHandler');

describe('A. fallback plan carries the per-step merge context', () => {
  const draft = {
    s0: { addressType: 'PERMANENT', embassy: false },
    s1: { dob: '2003-05-06', firstNameBn: 'X' },
    s2: { fatherNameBn: 'Y' },
    s2b: { perm: { division: 'Dhaka' } },
    s3: { relation: 'FATHER' },
    s4prep: { email: 'a@b.c' },
    docs: [{ name: 'd40', docType: '40' }],
    relation: 'FATHER',
    otp: '123456',
    _chargeToken: 'tok',
  };
  const session = {
    page: {},
    contact: { email: 'sess@b.c', phone: '01000000000' },
    docs: [{ name: 'sess-doc', docType: '41' }],
    relation: 'MOTHER',
    singleName: { bn: true },
    applicantDob: '2003-05-06',
  };

  it('submitS4Prep args carry s0/s1/s2/s2b, docs, relation and contact-filled s4prep', () => {
    const { steps } = buildPlaywrightFallbackPlan(draft, session);
    const s4prep = steps.find(([m]) => m === 'submitS4Prep')[1];
    assert.deepStrictEqual(s4prep.s0, draft.s0);
    assert.deepStrictEqual(s4prep.s1, draft.s1);
    assert.deepStrictEqual(s4prep.s2, draft.s2);
    assert.deepStrictEqual(s4prep.s2b, draft.s2b);
    assert.deepStrictEqual(s4prep.docs, draft.docs);
    assert.strictEqual(s4prep.relation, 'FATHER');
    // Explicit draft email wins; session contact fills the phone gap.
    assert.strictEqual(s4prep.email, 'a@b.c');
    assert.strictEqual(s4prep.phone, '01000000000');
  });

  it('session copies fill only the gaps; explicit draft fields win', () => {
    const gapDraft = { s1: { dob: '2003-05-06' }, s4prep: {} };
    const { steps } = buildPlaywrightFallbackPlan(gapDraft, session);
    const s4prep = steps.find(([m]) => m === 'submitS4Prep')[1];
    assert.deepStrictEqual(s4prep.docs, session.docs);
    assert.strictEqual(s4prep.relation, 'MOTHER');
    assert.strictEqual(s4prep.email, 'sess@b.c');
    assert.strictEqual(s4prep.phone, '01000000000');
    const s3 = steps.find(([m]) => m === 'submitS3')[1];
    assert.strictEqual(s3.relation, 'MOTHER');
  });

  it('handler options carry singleName/applicantDob and S0 carries s0 fields', () => {
    const { handlerOptions, steps } = buildPlaywrightFallbackPlan(draft, session);
    assert.deepStrictEqual(handlerOptions.singleName, session.singleName);
    assert.strictEqual(handlerOptions.applicantDob, '2003-05-06');
    const s0 = steps.find(([m]) => m === 'submitS0')[1];
    assert.strictEqual(s0.addressType, 'PERMANENT');
    assert.strictEqual(s0.embassy, false);
    const s2 = steps.find(([m]) => m === 'submitS2')[1];
    assert.strictEqual(s2.applicantDob, '2003-05-06');
  });

  it('a complete draft behaves as before: no session value overrides it', () => {
    const { steps } = buildPlaywrightFallbackPlan(draft, { page: {} });
    const s4prep = steps.find(([m]) => m === 'submitS4Prep')[1];
    assert.strictEqual(s4prep.email, 'a@b.c');
    assert.strictEqual(s4prep.phone, '');
    assert.deepStrictEqual(s4prep.docs, draft.docs);
  });
});

describe('B. relation plumbing: merge + real replay -> submitS3 args', () => {
  it('mergeStepParams: explicit relation wins, then ctx, then session', () => {
    assert.strictEqual(
      mergeStepParams({ relation: 'FATHER', ctx: { relation: 'MOTHER' } }, { relation: 'GUARDIAN' }, 'SUBMIT_S4_PREP').relation,
      'FATHER');
    assert.strictEqual(
      mergeStepParams({ ctx: { relation: 'MOTHER' } }, { relation: 'GUARDIAN' }, 'SUBMIT_S4_PREP').relation,
      'MOTHER');
    assert.strictEqual(
      mergeStepParams({}, { relation: 'MOTHER' }, 'SUBMIT_S4_PREP').relation,
      'MOTHER');
    assert.strictEqual(
      mergeStepParams({}, {}, 'SUBMIT_S4_PREP').relation,
      undefined);
  });

  it('mergeStepParams keeps the pre-existing fills (ctx steps, contact, docs)', () => {
    const session = {
      formCtx: { s0: { addressType: 'PERMANENT' }, s1: { dob: '2003-05-06' }, s2b: { perm: {} } },
      contact: { email: 'sess@b.c', phone: '01000000000' },
      docs: [{ name: 'sess-doc', docType: '41' }],
    };
    // No params.ctx here, so the session's stored ctx is the source.
    const merged = mergeStepParams({}, session, 'SUBMIT_S4_PREP');
    assert.deepStrictEqual(merged.s0, { addressType: 'PERMANENT' });
    assert.strictEqual(merged.applicantDob, '2003-05-06');
    assert.deepStrictEqual(merged.s2b, { perm: {} });
    assert.strictEqual(merged.s4prep.email, 'sess@b.c');
    assert.deepStrictEqual(merged.docs, session.docs);
    // A present params.ctx wins entirely over the stored ctx (either/or, pre-existing rule).
    const merged2 = mergeStepParams(
      { ctx: { s0: { addressType: 'BIRTHPLACE' } } },
      { formCtx: { s0: { addressType: 'PERMANENT' } } },
      'SUBMIT_S4_PREP');
    assert.strictEqual(merged2.s0.addressType, 'BIRTHPLACE');
  });

  it('real _replayToContact passes a non-undefined relation to submitS3', async () => {
    const handler = new StepHandler({ page: null }, { emit: () => {} });
    const seen = {};
    handler.submitS2B = async (args) => { seen.s2b = args; return { ok: true }; };
    handler.submitS3 = async (args) => { seen.s3 = args; return { ok: true }; };
    const docs = [{ name: 'd40', docType: '40' }];
    const out = await handler._replayToContact(4, {
      s2b: { perm: { division: 'Dhaka' } },
      s1: { dob: '2003-05-06' },
      relation: 'FATHER',
      docs,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(seen.s3.relation, 'FATHER', 'catch-up submitS3 must receive a real relation, not undefined');
    assert.deepStrictEqual(seen.s3.docs, docs);
    assert.deepStrictEqual(seen.s3.s1, { dob: '2003-05-06' });
  });

  it('replay without relation still yields undefined (the test distinguishes)', async () => {
    const handler = new StepHandler({ page: null }, { emit: () => {} });
    const seen = {};
    handler.submitS2B = async () => ({ ok: true });
    handler.submitS3 = async (args) => { seen.s3 = args; return { ok: true }; };
    const out = await handler._replayToContact(4, { s2b: {}, s1: {}, docs: [] });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(seen.s3.relation, undefined);
  });
});

describe('C. legacy auto-init gotoForm failure destroys and clears', () => {
  function makeSocket(userId) {
    const handlers = {};
    const emitted = [];
    return {
      abcUser: userId ? { id: userId } : null,
      handlers, emitted,
      on(ev, cb) { handlers[ev] = cb; },
      emit(ev, payload) { emitted.push([ev, payload]); },
    };
  }
  function makeEngine() {
    let connectionCb = null;
    const io = { use: () => {}, on: (ev, cb) => { if (ev === 'connection') connectionCb = cb; } };
    return { engine: new BdrisEngineV2(io, {}), connectionCb };
  }

  it('failed auto-init destroys the session, clears the id, and the next op re-creates', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);

    // Patch create() to hand out fake sessions on the real map.
    let creates = 0;
    const destroyed = [];
    const origDestroy = engine.sessionManager.destroy.bind(engine.sessionManager);
    engine.sessionManager.destroy = async (id) => { destroyed.push(id); return origDestroy(id); };
    engine.sessionManager.create = async (userId, metadata) => {
      creates += 1;
      const sess = { id: `sess_${creates}`, userId: userId || null, page: {}, createdAt: Date.now(), lastActivity: Date.now(), metadata, state: 'ACTIVE' };
      engine.sessionManager.sessions.set(sess.id, sess);
      return sess;
    };
    // The step executor is NOT the unit under test here; stub it so
    // the second call completes without running a real page step.
    engine.executor.execute = async () => ({ ok: true, step: 2 });

    // gotoForm throws on the first auto-init only.
    const { BdrisNavigator } = require('../services/BdrisNavigator');
    const origGoto = BdrisNavigator.prototype.gotoForm;
    BdrisNavigator.prototype.gotoForm = async () => { throw new Error('FORM_NOT_LOADED'); };
    try {
      await socket.handlers['SUBMIT_S0']({});
    } finally {
      BdrisNavigator.prototype.gotoForm = origGoto;
    }
    const firstAcks = socket.emitted.filter(([ev]) => ev === 'STEP_CHANGE_ACK');
    assert.strictEqual(firstAcks.length, 1, 'first SUBMIT must ack once');
    assert.strictEqual(firstAcks[0][1].failed[0].reason, 'FORM_NOT_LOADED');
    assert.deepStrictEqual(destroyed, ['sess_1'], 'failed auto-init session must be destroyed');
    assert.strictEqual(engine.sessionManager.sessions.size, 0, 'no broken session may remain in the map');

    // Second op on the same socket: with the id cleared, it must
    // auto-init fresh (creates == 2), not hit SESSION_EXPIRED.
    BdrisNavigator.prototype.gotoForm = async () => {};
    try {
      socket.emitted.length = 0;
      await socket.handlers['SUBMIT_S0']({});
    } finally {
      BdrisNavigator.prototype.gotoForm = origGoto;
    }
    assert.strictEqual(creates, 2, 'second SUBMIT must re-create after the id was cleared');
    const secondAcks = socket.emitted.filter(([ev]) => ev === 'STEP_CHANGE_ACK');
    assert.strictEqual(secondAcks.length, 1);
    assert.notStrictEqual(
      secondAcks[0][1].failed && secondAcks[0][1].failed[0] && secondAcks[0][1].failed[0].reason,
      'SESSION_EXPIRED');
  });
});

describe('B. frontend S4Prep payload + ctx carry relation', () => {
  const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  function extractFn(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist in bdris-apply.html`);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  it('payloadFor(SUBMIT_S4_PREP) returns the draft relation (real run, not regex)', () => {
    const ctx = {
      S: { d: { email: 'a@b.c', phone: '01000000000', docs: [{ name: 'd' }], relation: 'FATHER' } },
      defaultRelation: () => 'SELF',
    };
    vm.createContext(ctx);
    vm.runInContext(extractFn('payloadFor'), ctx);
    const p = ctx.payloadFor('SUBMIT_S4_PREP');
    assert.strictEqual(p.relation, 'FATHER');
    assert.strictEqual(p.email, 'a@b.c');
    assert.strictEqual(p.docs.length, 1);
  });

  it('payloadFor(SUBMIT_S4_PREP) falls back to defaultRelation when unset', () => {
    const ctx = {
      S: { d: { email: '', phone: '', docs: [], relation: '' } },
      defaultRelation: () => 'SELF',
    };
    vm.createContext(ctx);
    vm.runInContext(extractFn('payloadFor'), ctx);
    assert.strictEqual(ctx.payloadFor('SUBMIT_S4_PREP').relation, 'SELF');
  });

  it('emitStep ctx carries relation, and the preview-OTP inline S4Prep does too', () => {
    assert.match(html, /ctx: \{ s0: S\.d\.s0, s1: S\.d\.s1, s2: S\.d\.s2, s2b: S\.d\.s2b, relation: S\.d\.relation \|\| defaultRelation\(\) \}/);
    assert.match(html, /emitStep\('SUBMIT_S4_PREP', \{ email: S\.d\.email \|\| '', phone: np, docs: S\.d\.docs \|\| \[\], relation: S\.d\.relation \|\| defaultRelation\(\) \}\)/);
  });
});
