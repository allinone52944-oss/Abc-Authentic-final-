/**
 * DIRECT-PATH WIRING (2026-10-28): the live UI's HTTP chain.
 *
 * Covers what the wiring adds over the already-merged direct-final
 * code (officeId '0', finestAddressId, verify success check):
 *  - Same-address copy resolution in normalizeChainInput (tick
 *    reuses the source; button-written values pass through; a
 *    ticked copy with an empty source fails loudly, never submits
 *    an empty address).
 *  - Name-logic flags carried, payloads unchanged: single names
 *    join to the first name alone (never doubled), backticks pass
 *    through raw in buildSubmitPayload — the live test decides API
 *    acceptance; no bridge is built here.
 *  - Phased chain: 'send' = OTP send only (no charge gate, no
 *    verify/submit/upload/geo, sent proof returned); 'submit' =
 *    charge gate + verify + submit with OTP send skipped;
 *    unknown submit outcome never auto-retries; definitive
 *    rejection falls back to Playwright.
 *  - Seeded-only guard: noBareBootstrap refuses a bare client
 *    (proven 403) with SEED_FAILED instead of attempting it.
 *  - Frontend directCtx: recorded state only (never re-collects
 *    from DOM), birthPlace projected from S.d.s1, s2b passed
 *    through by reference.
 *
 * Run: node --test engines/bdris-apply/v2/tests/direct-path-wiring.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  normalizeChainInput, finestAddressId, isAddrEmpty, runHttpChain, runSubmitHttpChain,
} = require('../services/HttpPathRunner');
const { buildSubmitPayload } = require('../http/client');

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function addr(overrides = {}) {
  return {
    division: 'ঢাকা', district: 'ঢাকা', cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
    paurasavaUnion: 'অঞ্চল - ১', ward: 'ওয়ার্ড - ১',
    postBn: 'ঢাকা', postEn: 'Dhaka', vilBn: 'মহল্লা', vilEn: 'Moholla',
    houseBn: 'বাসা ১', houseEn: 'House 1',
    ...overrides,
  };
}

function draft(overrides = {}) {
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
    s4prep: { email: 'mock@example.com', phone: '01700000000' },
    docs: [],
    ...overrides,
  };
}

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    bootstrapped: true,
    bootstrap: async () => { calls.push('bootstrap'); },
    walkGeoChain: async () => { calls.push('geo'); return []; },
    uploadDocument: async () => { calls.push('upload'); return { attachmentTypeId: 40, url: 'u', id: 1 }; },
    otpSend: async () => { calls.push('otp-send'); return { success: true, code: 'MESSAGE_SENT', message: 'Message has been sent', payload: null }; },
    verifyOtp: async () => { calls.push('verify'); },
    submitApplication: async () => { calls.push('submit'); return { success: true, hasPrintLink: true, json: null }; },
    ...overrides,
  };
  return client;
}

const REFS = [
  { attachmentType: 40, attachmentTypeId: 40, url: 'u40', id: 1 },
  { attachmentType: 41, attachmentTypeId: 41, url: 'u41', id: 2 },
];

describe('direct wiring: same-address copy resolution', () => {
  it('permCopy resolves permanent to the birthplace record', () => {
    const birth = addr({ district: 'কক্সবাজার' });
    const n = normalizeChainInput(draft({
      // Like directCtx: birthPlace is passed explicitly — the
      // normalizer never derives it from s1.
      birthPlace: birth,
      s2b: { permCopy: true, presCopy: false, perm: null, pres: addr() },
    }));
    assert.equal(n.canonical.permAddr.district, 'কক্সবাজার');
    assert.equal(n.canonical.copyFlags.permCopy, true);
    assert.equal(n.copySourceEmpty, false);
  });

  it('presCopy resolves present to the (resolved) permanent record', () => {
    const perm = addr({ district: 'চট্টগ্রাম' });
    const n = normalizeChainInput(draft({
      s2b: { permCopy: false, presCopy: true, perm, pres: null },
    }));
    assert.equal(n.canonical.prsntAddr.district, 'চট্টগ্রাম');
    assert.equal(n.copySourceEmpty, false);
  });

  it('copy-button values (presCopy false, pres filled) pass through untouched', () => {
    const pres = addr({ district: 'সিলেট' });
    const n = normalizeChainInput(draft({ s2b: { permCopy: false, presCopy: false, perm: addr(), pres } }));
    assert.equal(n.canonical.prsntAddr.district, 'সিলেট');
    assert.equal(n.copySourceEmpty, false);
  });

  it('ticked copy with an empty source is flagged, never silently empty', () => {
    const n = normalizeChainInput(draft({
      s1: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
      s2b: { permCopy: true, presCopy: false, perm: null, pres: addr() },
    }));
    assert.equal(n.copySourceEmpty, true);
    assert.equal(isAddrEmpty(n.canonical.permAddr), true);
  });

  it('unticked empty addresses are NOT a copy error', () => {
    const n = normalizeChainInput(draft({ s2b: { permCopy: false, presCopy: false, perm: {}, pres: {} } }));
    assert.equal(n.copySourceEmpty, false);
  });

  it('present LocationId falls back to its finest *Id (ward first)', () => {
    const n = normalizeChainInput(draft({
      s2b: { permCopy: false, presCopy: false, perm: addr(), pres: addr({ wardId: '7193', paurasavaUnionId: '1988' }) },
    }));
    assert.equal(n.canonical.prsntAddr.locationId, '7193');
    assert.equal(finestAddressId(addr({ wardId: '', paurasavaUnionId: '1988' })), '1988');
  });
});

describe('direct wiring: name flags carried, payloads unchanged', () => {
  it('singleBn/singleEn follow the no-letters-in-last-name rule', () => {
    const n = normalizeChainInput(draft({
      s1: { firstNameBn: 'আবদুল', lastNameBn: '', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
    }));
    assert.equal(n.canonical.nameFlags.singleBn, true);
    assert.equal(n.canonical.nameFlags.singleEn, false);
  });

  it('hasCinno detects a backtick in any of the three names', () => {
    const n = normalizeChainInput(draft({
      s2: { father: { nameBn: 'আবদুল `হামিদ', nameEn: 'Abdul Hamid' }, mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' } },
    }));
    assert.equal(n.canonical.nameFlags.hasCinno, true);
    const clean = normalizeChainInput(draft());
    assert.equal(clean.canonical.nameFlags.hasCinno, false);
  });

  it('buildSubmitPayload still joins single names once and transits backticks (bot bridge)', () => {
    const payload = buildSubmitPayload({
      person: { firstNameBn: 'আবদুল', lastNameBn: '', firstNameEn: 'Abdul', lastNameEn: '', dob: '2020-01-15', thChild: '১ম', gender: 'পুরুষ' },
      father: { nameBn: 'আবদুল `হামিদ', nameEn: 'Abdul Hamid' },
      mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
      birthPlace: addr(), permAddr: addr(), prsntAddr: addr(),
      relation: 'FATHER', phone: '01700000000', otp: '123456',
      documents: REFS,
    });
    assert.equal(payload['personInfoForBirth.personNameBn'], 'আবদুল');
    assert.equal(payload['personInfoForBirth.personNameEn'], 'Abdul');
    // SUBMIT-FINAL (2026-10-30): the old keeps-backticks-raw rule
    // rested on a live-test question, answered 2026-10-30 (four
    // 200 HTML form walls) — the payload carries the transit form.
    assert.equal(payload['personInfoForBirth.father.personNameBn'], 'আবদুল হামিদ');
  });
});

describe('direct wiring: phased chain', () => {
  it("send phase sends only, needs no charge token, returns sent proof", async () => {
    const client = fakeClient();
    const r = await runHttpChain({
      data: draft(), client, log: () => {}, phase: 'send',
    });
    assert.equal(r.ok, true);
    assert.equal(r.sent, true);
    assert.equal(r.sendCode, 'MESSAGE_SENT');
    assert.deepEqual(client.calls, ['otp-send']);
  });

  it('send phase OTP rejection returns fallback (server passes no runner for this phase)', async () => {
    const client = fakeClient({ otpSend: async () => ({ success: false, code: 'DUPLICATE', message: 'Duplicate', payload: null }) });
    const r = await runHttpChain({
      data: draft(), client, log: () => {}, phase: 'send',
      // NOTE: the server passes playwrightRunner=null for the send
      // phase, so the frontend owns the bot fallback. No runner
      // here mirrors that exactly.
    });
    assert.equal(r.fallback, true);
    assert.equal(r.httpStep, 'otp-send');
    assert.match(r.httpReason, /DUPLICATE/);
  });

  it('send phase with noBareBootstrap and no client fails SEED_FAILED, never bootstraps', async () => {
    const r = await runHttpChain({
      data: draft(), log: () => {}, phase: 'send', noBareBootstrap: true,
    });
    assert.equal(r.fallback, true);
    assert.equal(r.httpStep, 'bootstrap');
    assert.match(r.httpReason, /bare bootstrap is refused/);
  });

  it('copySourceEmpty fails at address before any HTTP', async () => {
    const client = fakeClient();
    const r = await runHttpChain({
      data: draft({
        s1: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
        s2b: { permCopy: true, presCopy: false, perm: null, pres: addr() },
      }),
      client, log: () => {}, phase: 'send',
    });
    assert.equal(r.fallback, true);
    assert.equal(r.httpStep, 'address');
    assert.match(r.httpReason, /Copy-source address is empty/);
    assert.deepEqual(client.calls, []);
  });

  it('submit phase skips OTP send, verifies + submits behind the charge gate', async () => {
    const secret = 'test-secret';
    const userId = 'u1';
    const client = fakeClient({
      otpSend: async () => { throw new Error('otp-send must not run in submit phase'); },
    });
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken(userId, secret, 'direct-submit-1') },
      userId, secret, client, log: () => {}, phase: 'submit',
    });
    assert.equal(r.ok, true);
    assert.equal(r.success, true);
    assert.deepEqual(client.calls, ['verify', 'submit']);
  });

  it('submit phase without a charge token is blocked before any HTTP', async () => {
    const client = fakeClient();
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456' },
      userId: 'u1', secret: 'test-secret', client, log: () => {}, phase: 'submit',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.error, 'CHARGE_REQUIRED');
    assert.deepEqual(client.calls, []);
  });

  it('submit phase unknown outcome never auto-retries', async () => {
    const secret = 'test-secret';
    let pwCalls = 0;
    const client = fakeClient({
      submitApplication: async () => { throw new Error('socket hung up'); },
    });
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'direct-unknown-1') },
      userId: 'u1', secret, client, log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true }; },
    });
    assert.equal(r.error, 'SUBMIT_OUTCOME_UNKNOWN');
    assert.equal(pwCalls, 0);
  });

  it('submit phase definitive rejection falls back to Playwright', async () => {
    const secret = 'test-secret';
    let pwCalls = 0;
    const client = fakeClient({
      submitApplication: async () => { throw Object.assign(new Error('Submit rejected'), { code: 'SUBMIT_NOT_SUCCESS' }); },
    });
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'direct-fallback-1') },
      userId: 'u1', secret, client, log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true, path: 'playwright', completed: true }; },
    });
    assert.equal(r.httpFallback, true);
    assert.equal(pwCalls, 1);
  });

  it('disabled chain still executes nothing (phase irrelevant)', async () => {
    let pwCalls = 0;
    const r = await runSubmitHttpChain({
      env: {}, data: draft(), log: () => {}, phase: 'send',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true }; },
    });
    assert.equal(r.error, 'HTTP_PATH_DISABLED');
    assert.equal(pwCalls, 0);
  });
});

// ── Frontend directCtx: recorded state only ──────────────────────
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

describe('frontend directCtx: recorded state, never DOM re-collect', () => {
  it('directCtx exists with the wiring marker and no collect calls', () => {
    assert.match(html, /DIRECT-PATH WIRING \(2026-10-28\)/);
    const src = extractFn('directCtx');
    // Call patterns only (the comment itself names the collectors
    // it refuses to call, so bare names would false-positive).
    assert.doesNotMatch(src, /collectStep4\(|collectAuto\(|collectStep6\(|document\.|getElementById|\$\(/);
  });

  it('directCtx passes s2b through by reference and projects birthPlace from s1', () => {
    const s2b = { permCopy: true, presCopy: false, perm: null, pres: { division: 'ঢাকা' } };
    const ctx = { S: { d: {
      s0: { addressType: 'PERMANENT', embassy: false },
      s1: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', division: 'ঢাকা', district: 'ঢাকা', cityCorpUpazila: 'উপজেলা', paurasavaUnion: 'ইউনিয়ন', ward: 'ওয়ার্ড - ১', divisionId: '1', wardId: '5', postBn: 'পো', postEn: 'Po', vilBn: 'গ্রাম', vilEn: 'Village', houseBn: 'বাসা', houseEn: 'House' },
      s2: { father: {}, mother: {} },
      s2b,
      relation: 'FATHER', docs: [], email: 'e@x.com', phone: '01700000000',
    } }, defaultRelation: () => 'FATHER' };
    vm.createContext(ctx);
    vm.runInContext(`${extractFn('directCtx')}\nthis.__ctx = directCtx();`, ctx);
    const out = ctx.__ctx;
    assert.equal(out.s2b, s2b, 's2b must be the recorded object, not a re-collect');
    assert.equal(out.birthPlace.division, 'ঢাকা');
    assert.equal(out.birthPlace.wardId, '5');
    assert.equal(out.officeAddressType, 'PERMANENT');
    assert.equal(out.applicantName, 'Abdul Karim');
    assert.equal(out.s4prep.phone, '01700000000');
  });

  it('send/submit/resend gates and the READY probe exist', () => {
    assert.match(html, /if \(directHttpEnabled\(\)\) \{ directSend\(\); return; \}/);
    assert.match(html, /if \(directHttpEnabled\(\) && S\._directOtp\) \{ directSubmit\(otp\); return; \}/);
    assert.match(html, /if \(directHttpEnabled\(\) && S\._directOtp\) \{ directSend\(\); return; \}/);
    assert.match(html, /probeHttpPath\(\);/);
    assert.match(html, /command: 'HTTP_PATH_STATUS'/);
    // DIRECT HTTP BYPASS (2026-10-29): the trigger is a plain HTTP
    // POST now, not a socket emit — the old 'SUBMIT_HTTP_CHAIN'
    // socket command string is gone from the frontend by design
    // (the v2 executor command itself is unchanged; the route
    // invokes it server-side). The trigger must be the fetch POST.
    assert.match(html, /\/api\/bdris-apply\/http-chain/);
    assert.match(extractFn('directSend'), /directHttpPost\(/);
    assert.match(extractFn('directSubmit'), /directHttpPost\(/);
    assert.doesNotMatch(extractFn('directSend'), /socket\.emit/);
    assert.doesNotMatch(extractFn('directSubmit'), /socket\.emit/);
    assert.match(html, /window\.abcDirectSubmitToken/);
  });

  it('no optimistic sent render on the direct send path', () => {
    const sendSrc = extractFn('directSend');
    assert.doesNotMatch(sendSrc, /renderOtpCode/);
    const ackSrc = extractFn('directSendAck');
    assert.match(ackSrc, /renderOtpCode\(true\)/);
  });
});
