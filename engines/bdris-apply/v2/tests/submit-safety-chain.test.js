/**
 * SUBMIT-SAFETY FIX PACK (2026-10-30) — chain + frontend policy
 * (node:test, no live contact, no browser, no personal data;
 * fixture values only).
 *
 *  - isFallbackSafe: a submit 200 with an unrecognized shape is
 *    outcome-unknown (fallback SUPPRESSED); only an explicit JSON
 *    success:false, a non-200 rejection, or a never-sent payload
 *    stays fallback-safe.
 *  - finestAddressId: name-valued *Ids are skipped, never used
 *    as a LocationId.
 *  - Same-address copy: ticked permCopy/presCopy apply ONLY when
 *    the target record is empty (bot permHasData rule) — a real
 *    address is never overwritten by the source.
 *  - officeAddressType defaults to BIRTHPLACE in canonical.
 *  - BRN-free submit failures skip the bot fallback and surface
 *    the direct reason.
 *  - Direct HTTP path (uiDirect): the direct result returns
 *    BEFORE any bot fallback; the frontend owns the fallback
 *    separately. Socket path keeps inline fallback.
 *  - Timeout policy (one policy for the whole submit): the submit
 *    fetch (200s) and the adapter proxy (200s) both sit above the
 *    180s executor race, so the UI can no longer declare unknown
 *    while the server chain is still running; S2B is aligned to
 *    300s like S4_PREP.
 *  - Forward Next auto-saves even before any draft exists
 *    (advanceAndSend calls autoSaveDraft unconditionally — the
 *    old draftId-guarded saveDraft never saved a fresh filing).
 *
 * Run: node --test engines/bdris-apply/v2/tests/submit-safety-chain.test.js
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
  normalizeChainInput, finestAddressId, isAddrEmpty, isFallbackSafe, runHttpChain,
} = require('../services/HttpPathRunner');

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

const REFS = [
  { attachmentType: 40, attachmentTypeId: 40, url: 'u40', id: 1 },
  { attachmentType: 41, attachmentTypeId: 41, url: 'u41', id: 2 },
];

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

function shape200(over = {}) {
  return {
    status: 200, isJson: false, jsonSuccess: false, jsonExplicitFailure: false,
    textLen: 118673, hasSuccessPhrase: false, hasPrintLink: false, hasFormFields: true,
    ...over,
  };
}

describe('isFallbackSafe: 200-shape submit failures never replay', () => {
  it('200 unrecognized shape is unsafe (no bot replay)', () => {
    assert.equal(isFallbackSafe('submit', { code: 'SUBMIT_NOT_SUCCESS', responseSummary: shape200() }), false);
  });
  it('200 with explicit JSON failure stays safe (positive non-filing signal)', () => {
    assert.equal(isFallbackSafe('submit', { code: 'SUBMIT_NOT_SUCCESS', responseSummary: shape200({ isJson: true, jsonExplicitFailure: true }) }), true);
  });
  it('non-200 rejection with a code stays safe', () => {
    assert.equal(isFallbackSafe('submit', { code: 'SUBMIT_BAD_RESPONSE', responseSummary: shape200({ status: 400, hasFormFields: false }) }), true);
  });
  it('code-only rejection (no summary) stays safe, as before', () => {
    assert.equal(isFallbackSafe('submit', { code: 'SUBMIT_NOT_SUCCESS' }), true);
  });
  it('bare network error stays unsafe; non-submit steps always safe', () => {
    assert.equal(isFallbackSafe('submit', new Error('socket hung up')), false);
    assert.equal(isFallbackSafe('verify', new Error('x')), true);
  });
});

describe('finestAddressId: name-valued *Ids are absent', () => {
  it('skips name ids and takes the finest numeric one', () => {
    assert.equal(finestAddressId(addr({ wardId: 'ওয়ার্ড - ১', paurasavaUnionId: '1988' })), '1988');
    assert.equal(finestAddressId(addr({ wardId: '7193' })), '7193');
  });
  it('all-name ids yield empty, never a name as LocationId', () => {
    assert.equal(finestAddressId(addr({ wardId: 'ওয়ার্ড - ১', paurasavaUnionId: 'অঞ্চল - ৮', divisionId: 'ঢাকা' })), '');
  });
});

describe('same-address copy: only when the target is empty', () => {
  it('ticked permCopy does NOT overwrite a real permanent address', () => {
    const perm = addr({ district: 'চট্টগ্রাম' });
    const n = normalizeChainInput(draft({ s2b: { permCopy: true, presCopy: false, perm, pres: addr() } }));
    assert.equal(n.canonical.permAddr.district, 'চট্টগ্রাম');
    assert.equal(n.copySourceEmpty, false);
  });
  it('ticked permCopy still copies into an empty target', () => {
    const birth = addr({ district: 'কক্সবাজার' });
    const n = normalizeChainInput(draft({ birthPlace: birth, s2b: { permCopy: true, presCopy: false, perm: null, pres: addr() } }));
    assert.equal(n.canonical.permAddr.district, 'কক্সবাজার');
  });
  it('ticked presCopy does NOT overwrite a real present address', () => {
    const pres = addr({ district: 'সিলেট' });
    const n = normalizeChainInput(draft({ s2b: { permCopy: false, presCopy: true, perm: addr(), pres } }));
    assert.equal(n.canonical.prsntAddr.district, 'সিলেট');
  });
  it('isAddrEmpty still flags a ticked copy with an empty source', () => {
    const n = normalizeChainInput(draft({ s2b: { permCopy: true, presCopy: false, perm: null, pres: addr() } }));
    assert.equal(n.copySourceEmpty, true);
    assert.equal(isAddrEmpty(n.canonical.permAddr), true);
  });
});

describe('officeAddressType defaults to BIRTHPLACE', () => {
  it('canonical defaults a missing value (frontend already does)', () => {
    const n = normalizeChainInput(draft());
    assert.equal(n.canonical.officeAddressType, 'BIRTHPLACE');
    const explicit = normalizeChainInput(draft({ s4prep: { email: 'e@x.com', phone: '01700000000', officeAddressType: 'PERMANENT' } }));
    assert.equal(explicit.canonical.officeAddressType, 'PERMANENT');
  });
});

describe('submit fallback routing: BRN-free skip, uiDirect deferral, 200 suppression', () => {
  it('fixture parents without BRN are BRN-free', () => {
    assert.equal(normalizeChainInput(draft()).brnFree, true);
  });

  it('BRN-free submit failure skips the bot runner and surfaces the direct reason', async () => {
    const secret = 'test-secret';
    let pwCalls = 0;
    const client = fakeClient({
      submitApplication: async () => { throw Object.assign(new Error('Submit rejected'), { code: 'SUBMIT_NOT_SUCCESS' }); },
    });
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'brnfree-skip-1') },
      userId: 'u1', secret, client, log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true }; },
    });
    assert.equal(pwCalls, 0);
    assert.equal(r.ok, false);
    assert.equal(r.fallback, false);
    assert.match(r.message, /bot fallback skipped/);
    assert.match(r.message, /Submit rejected/);
  });

  it('200-shape submit failure is outcome-unknown with the runner present', async () => {
    const secret = 'test-secret';
    let pwCalls = 0;
    const client = fakeClient({
      submitApplication: async () => {
        throw Object.assign(new Error('Submit response contains neither success:true JSON nor the verified success phrase.'),
          { code: 'SUBMIT_NOT_SUCCESS', responseSummary: shape200() });
      },
    });
    const r = await runHttpChain({
      // Parents WITH brn so the BRN-free skip does not mask the 200 rule.
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'shape200-1'),
        s2: { father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', brn: '1234567890' }, mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema', brn: '1234567891' } } },
      userId: 'u1', secret, client, log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true }; },
    });
    assert.equal(r.error, 'SUBMIT_OUTCOME_UNKNOWN');
    assert.equal(pwCalls, 0);
  });

  it('200 with explicit JSON failure still falls back (definitive rejection)', async () => {
    const secret = 'test-secret';
    let pwCalls = 0;
    const client = fakeClient({
      submitApplication: async () => {
        throw Object.assign(new Error('Submit rejected'), { code: 'SUBMIT_NOT_SUCCESS', responseSummary: shape200({ isJson: true, jsonExplicitFailure: true, hasFormFields: false }) });
      },
    });
    const r = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'explicit-fail-1'),
        s2: { father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', brn: '1234567890' }, mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema', brn: '1234567891' } } },
      userId: 'u1', secret, client, log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwCalls += 1; return { ok: true, path: 'playwright', completed: true }; },
    });
    assert.equal(r.httpFallback, true);
    assert.equal(pwCalls, 1);
  });

  it('uiDirect failure returns before the runner; socket path still runs it', async () => {
    const secret = 'test-secret';
    const mkClient = () => fakeClient({ verifyOtp: async () => { throw Object.assign(new Error('OTP verify returned status 500.'), { code: 'VERIFY_FAILED' }); } });
    let pwDirect = 0;
    const rDirect = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', uiDirect: true, _chargeToken: validChargeToken('u1', secret, 'uidirect-1') },
      userId: 'u1', secret, client: mkClient(), log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwDirect += 1; return { ok: true }; },
    });
    assert.equal(pwDirect, 0);
    assert.equal(rDirect.ok, false);
    assert.equal(rDirect.fallback, true);
    let pwSocket = 0;
    const rSocket = await runHttpChain({
      data: { ...draft(), documents: REFS, otp: '123456', _chargeToken: validChargeToken('u1', secret, 'uidirect-2') },
      userId: 'u1', secret, client: mkClient(), log: () => {}, phase: 'submit',
      playwrightRunner: async () => { pwSocket += 1; return { ok: true, path: 'playwright', completed: true }; },
    });
    assert.equal(pwSocket, 1);
    assert.equal(rSocket.httpFallback, true);
  });
});

describe('timeout policy: one window for the whole submit', () => {
  it('submit fetch, proxy, and S2B all sit above the 180s executor race', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const adapterJs = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html'), 'utf8');
    assert.match(serverJs, /\['SUBMIT_S2B', 'submitS2B', 300000\]/);
    assert.match(serverJs, /\{ timeoutMs: 180000 \}/);
    assert.match(adapterJs, /proxyReq\.setTimeout\(200000\)/);
    const m = html.match(/DIRECT_HTTP_SUBMIT_TIMEOUT_MS = (\d+)/);
    assert.ok(m, 'submit fetch window must be defined');
    assert.ok(Number(m[1]) > 180000, 'submit fetch window must exceed the 180s executor race');
    assert.match(html, /directHttpPost\(Object\.assign\(\{\}, payload, \{ _authToken: curAccessToken\(\) \}\), DIRECT_HTTP_SUBMIT_TIMEOUT_MS\)/);
    assert.match(html, /busy\(true, '⏳ আবেদন জমা হচ্ছে… একটু অপেক্ষা করুন', DIRECT_HTTP_SUBMIT_TIMEOUT_MS\)/);
    assert.match(html, /setInterval\(\(\) => \{\s*try \{ note\('⏳ আবেদন জমা হচ্ছে…/);
  });
});

// ── Frontend: forward Next auto-save ──────────────────────────────
const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

function extractFn(name) {
  const start = htmlSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in bdris-apply.html`);
  const open = htmlSrc.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < htmlSrc.length; i++) {
    if (htmlSrc[i] === '{') depth += 1;
    else if (htmlSrc[i] === '}') { depth -= 1; if (depth === 0) return htmlSrc.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('frontend forward Next auto-saves before any draft exists', () => {
  it('advanceAndSend calls autoSaveDraft(n) unconditionally', () => {
    const src = extractFn('advanceAndSend');
    assert.match(src, /autoSaveDraft\(n\)/);
    // Strip line comments first: the explanatory comment itself
    // names the old guarded call, so only code lines count.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /if \(S\.draftId\) saveDraft/);
    assert.doesNotMatch(code, /saveDraft\(n/);
    const autoCalls = [];
    const goCalls = [];
    const ctx = {
      S: { d: {} },
      goStep: (n) => { goCalls.push(n); },
      emitStep: () => true,
      autoSaveDraft: (n) => { autoCalls.push(n); },
    };
    vm.createContext(ctx);
    vm.runInContext(`${src}\nthis.__r = advanceAndSend(3, 'SUBMIT_S1', {});`, ctx);
    assert.deepEqual(autoCalls, [3]);
    assert.deepEqual(goCalls, [3]);
    assert.equal(ctx.S.d.uiStep, 3);
  });

  it('directSubmitAck maps executor TIMEOUT to outcome-unknown handling', () => {
    const src = extractFn('directSubmitAck');
    assert.match(src, /r\.error === 'TIMEOUT'/);
    assert.match(src, /directSubmitUnknown\('সাবমিটের ফল জানা যায়নি/);
  });

  it('directHttpPost takes a per-call timeout (send keeps 90s, submit 200s)', () => {
    const src = extractFn('directHttpPost');
    assert.match(src, /timeoutMs/);
    assert.match(src, /DIRECT_HTTP_TIMEOUT_MS/);
  });
});
