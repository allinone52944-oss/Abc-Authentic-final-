/**
 * OTP-TRAP (audit cycle 2, 2026-10-31) — A5 is frontend-only (see
 * backend/tests/frontend/bdris-apply.test.js); A6's auto branch is
 * frontend-only too, with the shared classifier pinned there.
 * This file pins the engine side:
 *  - A7: a 400 whose wording says the number hit the 5-use cap is
 *    classified OTP_SEND_CAP (not generic OTP_SEND_FAILED), and
 *    the chain carries otpCapped so the UI routes to
 *    change-number instead of a doomed bot replay.
 *  - C3: a submit-phase verify that reports not-verified carries
 *    otpVerifyFailed so the UI shows the code-expired resend
 *    message instead of degrading to a BOT_PAGE_NOT_ON_OTP_STEP
 *    gate error via a bot replay.
 *  - C1: a replayed cached send result is marked replayed:true
 *    on a copy — the cache itself stays unmutated, so the UI can
 *    honestly say "previous code still valid, no new SMS".
 * No live contact, no browser, no personal data. Fixture values
 * only. Run: node --test
 *   engines/bdris-apply/v2/tests/otptrap.test.js (from
 *   engines/bdris-apply/).
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');

const { BdrisHttpClient, OTP_CAP_RE } = require('../http/client');
const { runHttpChain } = require('../services/HttpPathRunner');
const { BdrisEngineV2 } = require('../server');

const TEST_SECRET = 'otptrap-test-secret';

function capErr() {
  return Object.assign(new Error('OTP send returned status 400: maximum 5 times.'), { code: 'OTP_SEND_CAP' });
}

function verifyErr() {
  return Object.assign(new Error('OTP verify response does not report isVerified === true.'), { code: 'VERIFY_NOT_VERIFIED' });
}

function validChargeToken(userId, secret, ref = 'ref-otptrap') {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function chainData(over = {}) {
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
    uiDirect: true,
    ...over,
  };
}

describe('OTP-TRAP A7: 5-use cap classification', () => {
  it('cap wording matches the shared cap pattern', () => {
    assert.ok(OTP_CAP_RE.test('OTP can be sent maximum 5 times for this number'));
    assert.ok(OTP_CAP_RE.test('এই নম্বরে সর্বোচ্চ ৫ বার কোড পাঠানো হয়ে গেছে'));
    assert.ok(!OTP_CAP_RE.test('OTP has not expired'));
  });

  it('client sendOtp throws OTP_SEND_CAP on a 400 cap body, not OTP_SEND_FAILED', async () => {
    const c = new BdrisHttpClient({ base: 'https://example.invalid' });
    c.bootstrapped = true;
    c.csrfToken = 'test-csrf';
    c.request = async () => ({
      ok: false, status: 400,
      json: { message: 'OTP can be sent maximum 5 times for this number' },
      text: '',
    });
    await assert.rejects(() => c.otpSend({ phone: '01000000000' }), (e) => {
      assert.strictEqual(e.code, 'OTP_SEND_CAP');
      return true;
    });
  });

  it('chain send phase carries otpCapped so the UI never bot-replays a capped number', async () => {
    const fakeClient = {
      bootstrapped: true,
      otpSend: async () => { throw capErr(); },
    };
    const out = await runHttpChain({
      phase: 'send',
      data: chainData(),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient,
      log: () => {},
    });
    assert.strictEqual(out.otpCapped, true);
    assert.strictEqual(out.fallback, true);
    assert.strictEqual(out.otpUnexpired, false);
  });
});

describe('OTP-TRAP C3: verify failure classification', () => {
  it('submit chain with a not-verified code carries otpVerifyFailed', async () => {
    const fakeClient = {
      bootstrapped: true,
      otpSend: async () => ({ code: 'MESSAGE_SENT', success: true, payload: null }),
      verifyOtp: async () => { throw verifyErr(); },
      submitApplication: async () => ({ hasPrintLink: false }),
    };
    const out = await runHttpChain({
      data: chainData({ _chargeToken: validChargeToken('user-1', 'test-secret') }),
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient,
      log: () => {},
    });
    assert.strictEqual(out.otpVerifyFailed, true);
    assert.strictEqual(out.ok, false);
  });
});

describe('OTP-TRAP C1: cached send replay is marked honestly', () => {
  let savedFlag;
  let savedJwt;
  let savedAbcJwt;

  function mintToken(payload) {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', TEST_SECRET).update(h + '.' + p).digest('base64url');
    return `${h}.${p}.${sig}`;
  }

  function makeEngine({ executor } = {}) {
    const engine = Object.create(BdrisEngineV2.prototype);
    engine.sessionManager = {
      findByUser() {
        return { id: 'sess_otptrap', userId: 'u1', page: null, metadata: { socketId: 'sock-otptrap' }, createdAt: Date.now(), lastActivity: Date.now(), state: 'ACTIVE' };
      },
      touch() {},
    };
    engine.executor = executor || {
      calls: [],
      async execute() {
        this.calls.push(1);
        return { ok: true, sent: true, sendCode: 'MESSAGE_SENT' };
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

  it('repeat send within TTL returns replayed:true and leaves the cached body unmutated', async () => {
    let executorResult = null;
    const engine = makeEngine({
      executor: {
        calls: [],
        async execute() {
          this.calls.push(1);
          executorResult = { ok: true, sent: true, sendCode: 'MESSAGE_SENT' };
          return executorResult;
        },
      },
    });
    const first = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(first.body.ok, true);
    assert.strictEqual(first.body.replayed, undefined);
    const second = await engine.handleHttpChainRequest(sendBody());
    assert.strictEqual(second.body.ok, true);
    assert.strictEqual(second.body.replayed, true);
    assert.strictEqual(engine.executor.calls.length, 1);
    assert.strictEqual(executorResult.replayed, undefined);
  });
});
