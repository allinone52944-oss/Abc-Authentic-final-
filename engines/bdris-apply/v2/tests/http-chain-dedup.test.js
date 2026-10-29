/**
 * HTTP-CHAIN IDEMPOTENCY GUARD (2026-10-30, double-emit root fix).
 *
 * Journal proof (2026-10-30, UTC): ONE user send press produced TWO
 * identical HTTP-chain runs in the same second (send twice → two
 * different OTP SMS), the submit phase also ran twice (charge hit
 * DUPLICATE_TRANSACTION), and a bot SUBMIT_S4_OTP op was enqueued
 * twice. The guard in handleHttpChainRequest keys on what the
 * request IS (user + phase + phone + name + DOB + otp + docs
 * fingerprint), not how it arrived, so it is trigger-agnostic.
 *
 * Covered here (all through handleHttpChainRequest with a stub
 * executor, no network, no real OTP/submit):
 *  - Two concurrent identical send POSTs → ONE executor call; the
 *    second waits and returns the first run's result.
 *  - Two concurrent identical submit POSTs (same otp) → ONE call.
 *  - A repeat identical POST after a SUCCESS (within TTL) → cached
 *    result, executor still called once.
 *  - A repeat after a FAILURE → runs fresh (failed runs stay
 *    retryable by a deliberate user action).
 *  - A repeat after OUTCOME_UNKNOWN / blocked / fallback → runs
 *    fresh (unknown handling untouched: unknown is ok:false).
 *  - A submit with a DIFFERENT otp → a different attempt, runs.
 *  - A different user, phone, name, DOB, or phase → runs.
 *  - Key derivation: otp excluded for send phase, included for
 *    submit; docs enter only as (type, base64 length) pairs.
 *  - No payload mutation: params reaching the executor are
 *    unchanged (names, backticks, charge token intact).
 *
 * Run: node --test engines/bdris-apply/v2/tests/http-chain-dedup.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { BdrisEngineV2, httpChainGuardKey, HTTP_CHAIN_DEDUP_TTL_MS } = require('../server');

const TEST_SECRET = 'http-chain-dedup-test-secret';

function mintToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function makeSession() {
  return {
    id: 'sess_dedup',
    userId: 'u1',
    page: null,
    metadata: { socketId: 'sock-dedup' },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'ACTIVE',
  };
}

function makeEngine({ executor } = {}) {
  const engine = Object.create(BdrisEngineV2.prototype);
  engine.sessionManager = {
    findByUser() { return makeSession(); },
    touch() {},
  };
  engine.executor = executor || {
    calls: [],
    async execute(cmd, params, ctx) {
      this.calls.push({ cmd, params, ctx });
      return { ok: true, sent: true };
    },
  };
  engine.io = null;
  engine.log = () => {};
  return engine;
}

function sendBody(over = {}) {
  return {
    phase: 'send',
    phone: '01700000000',
    applicantName: 'Test Person',
    s1: { firstNameEn: 'Test', lastNameEn: 'Person', dob: '1980-02-02' },
    s4prep: { phone: '01700000000', email: '' },
    _authToken: mintToken({ id: 'u1' }),
    ...over,
  };
}

function submitBody(over = {}) {
  return {
    phase: 'submit',
    phone: '01700000000',
    applicantName: 'Test Person',
    s1: { firstNameEn: 'Test', lastNameEn: 'Person', dob: '1980-02-02' },
    s4prep: { phone: '01700000000', email: '' },
    otp: '123456',
    docs: [
      { docType: '41', base64: 'AAA' },
      { docType: '40', base64: 'BBBB' },
    ],
    _authToken: mintToken({ id: 'u1' }),
    ...over,
  };
}

describe('HTTP-CHAIN IDEMPOTENCY GUARD', () => {
  let savedFlag;
  let savedJwt;
  let savedAbcJwt;

  beforeEach(() => {
    savedFlag = process.env.BDRIS_HTTP_PATH;
    savedJwt = process.env.JWT_SECRET;
    savedAbcJwt = process.env.ABC_JWT_SECRET;
    process.env.BDRIS_HTTP_PATH = 'on';
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.ABC_JWT_SECRET;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.BDRIS_HTTP_PATH;
    else process.env.BDRIS_HTTP_PATH = savedFlag;
    if (savedJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwt;
    if (savedAbcJwt === undefined) delete process.env.ABC_JWT_SECRET;
    else process.env.ABC_JWT_SECRET = savedAbcJwt;
  });

  it('two concurrent identical send POSTs → ONE executor call, same result', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          await gate;
          return { ok: true, sent: true, sendCode: 'MESSAGE_SENT' };
        },
      },
    });
    const p1 = engine.handleHttpChainRequest(sendBody());
    const p2 = engine.handleHttpChainRequest(sendBody());
    // Both must be in flight together before either resolves.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(engine.executor.calls.length, 1);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(engine.executor.calls.length, 1);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r2.body, r1.body);
    assert.strictEqual(r1.body.sent, true);
  });

  it('two concurrent identical submit POSTs (same otp) → ONE executor call', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          await gate;
          return { ok: true, success: true, path: 'http' };
        },
      },
    });
    const p1 = engine.handleHttpChainRequest(submitBody());
    const p2 = engine.handleHttpChainRequest(submitBody());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(engine.executor.calls.length, 1);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(engine.executor.calls.length, 1);
    assert.strictEqual(r2.body.success, true);
    assert.deepStrictEqual(r2.body, r1.body);
  });

  it('repeat identical POST after SUCCESS (within TTL) → cached, executor still once', async () => {
    const engine = makeEngine();
    const r1 = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(r1.body.ok, true);
    const r2 = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(engine.executor.calls.length, 1);
    assert.deepStrictEqual(r2.body, r1.body);
  });

  it('repeat after FAILURE → runs fresh (failed runs stay retryable)', async () => {
    let n = 0;
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          n += 1;
          return n === 1
            ? { ok: false, fallback: true, httpStep: 'otp-send', httpReason: 'boom' }
            : { ok: true, sent: true };
        },
      },
    });
    const r1 = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(r1.body.ok, false);
    const r2 = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(engine.executor.calls.length, 2);
    assert.strictEqual(r2.body.ok, true);
  });

  it('repeat after OUTCOME_UNKNOWN / blocked → runs fresh (unknown handling untouched)', async () => {
    const outcomes = [
      { ok: false, error: 'SUBMIT_OUTCOME_UNKNOWN' },
      { ok: false, blocked: true, error: 'CHARGE_REQUIRED' },
      { ok: true, success: true, path: 'http' },
    ];
    let i = 0;
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          return outcomes[i++];
        },
      },
    });
    const r1 = await engine.handleHttpChainRequest(submitBody());
    assert.strictEqual(r1.body.error, 'SUBMIT_OUTCOME_UNKNOWN');
    const r2 = await engine.handleHttpChainRequest(submitBody());
    assert.strictEqual(engine.executor.calls.length, 2);
    assert.strictEqual(r2.body.blocked, true);
    const r3 = await engine.handleHttpChainRequest(submitBody());
    assert.strictEqual(engine.executor.calls.length, 3);
    assert.strictEqual(r3.body.success, true);
  });

  it('submit with a DIFFERENT otp → a different attempt, runs', async () => {
    const engine = makeEngine();
    await engine.handleHttpChainRequest(submitBody({ otp: '111111' }));
    await engine.handleHttpChainRequest(submitBody({ otp: '222222' }));
    assert.strictEqual(engine.executor.calls.length, 2);
  });

  it('different user / phone / name / DOB / phase → runs (no cross-filing dedup)', async () => {
    const engine = makeEngine();
    await engine.handleHttpChainRequest(sendBody());
    await engine.handleHttpChainRequest(sendBody({ phone: '01800000000', s4prep: { phone: '01800000000', email: '' } }));
    await engine.handleHttpChainRequest(sendBody({ applicantName: 'Other Person' }));
    await engine.handleHttpChainRequest(sendBody({ s1: { firstNameEn: 'Test', lastNameEn: 'Person', dob: '1990-01-01' } }));
    await engine.handleHttpChainRequest(sendBody({ phase: 'submit', otp: '123456' }));
    assert.strictEqual(engine.executor.calls.length, 5);
    // A different userId token is a different key even with identical content.
    const otherUser = sendBody({ _authToken: mintToken({ id: 'u2' }) });
    await engine.handleHttpChainRequest(otherUser);
    assert.strictEqual(engine.executor.calls.length, 6);
  });

  it('executor throwing → 500 for both waiters, executor called once, retry runs fresh', async () => {
    let n = 0;
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          n += 1;
          if (n === 1) throw new Error('kaboom');
          return { ok: true, sent: true };
        },
      },
    });
    const p1 = engine.handleHttpChainRequest(sendBody());
    const p2 = engine.handleHttpChainRequest(sendBody());
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(engine.executor.calls.length, 1);
    assert.strictEqual(r1.status, 500);
    assert.strictEqual(r2.status, 500);
    assert.strictEqual(r2.body.error, 'EXECUTION_FAILED');
    const r3 = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(engine.executor.calls.length, 2);
    assert.strictEqual(r3.body.ok, true);
  });

  it('key derivation: otp excluded for send, included for submit; docs as (type,length)', () => {
    const base = { phone: '01700000000', applicantName: 'Test Person', s1: { dob: '1980-02-02' } };
    assert.strictEqual(
      httpChainGuardKey('u1', { ...base, phase: 'send', otp: '999999' }),
      httpChainGuardKey('u1', { ...base, phase: 'send' }),
    );
    assert.notStrictEqual(
      httpChainGuardKey('u1', { ...base, phase: 'submit', otp: '111111' }),
      httpChainGuardKey('u1', { ...base, phase: 'submit', otp: '222222' }),
    );
    const withDocs = { ...base, phase: 'submit', otp: '123456', docs: [{ docType: '41', base64: 'AAA' }] };
    const sameLenDocs = { ...withDocs, docs: [{ docType: '41', base64: 'BBB' }] };
    const diffLenDocs = { ...withDocs, docs: [{ docType: '41', base64: 'BBBB' }] };
    assert.strictEqual(httpChainGuardKey('u1', withDocs), httpChainGuardKey('u1', sameLenDocs));
    assert.notStrictEqual(httpChainGuardKey('u1', withDocs), httpChainGuardKey('u1', diffLenDocs));
    assert.ok(HTTP_CHAIN_DEDUP_TTL_MS > 0);
  });

  it('no payload mutation: executor receives stripped params unchanged (names/backtick/token intact)', async () => {
    let seen = null;
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute(cmd, params) {
          this.calls.push(1);
          seen = params;
          return { ok: true, sent: true };
        },
      },
    });
    const body = submitBody({
      applicantName: 'Test` Person',
      s1: { firstNameEn: 'Test`', lastNameEn: 'Person', dob: '1980-02-02' },
      _chargeToken: 'tok-abc',
    });
    await engine.handleHttpChainRequest(body);
    assert.strictEqual(seen.applicantName, 'Test` Person');
    assert.strictEqual(seen.s1.firstNameEn, 'Test`');
    assert.strictEqual(seen._chargeToken, 'tok-abc');
    assert.strictEqual(seen._authToken, undefined);
    assert.strictEqual(seen._commandId, undefined);
  });
});
