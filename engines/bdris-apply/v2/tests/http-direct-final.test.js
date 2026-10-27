/**
 * Direct-path final wiring (2026-10-28): Stage C (user-run real
 * application, 2026-10-27) live-proved the OTP shapes:
 * - OTP send: POST /api/otp/sent, query has officeId but NO
 *   geoLocationId; success response {code: 'MESSAGE_SENT',
 *   success: true, payload: null}.
 * - OTP verify: POST /api/otp/verify, query only, empty body;
 *   success = TOP-LEVEL {isVerified: true}; officeId was 0 and
 *   the server accepted it; geoLocationId = the address's
 *   LocationId (PERMANENT in that run).
 * - NO /api/office/* request from the browser at all.
 * So the wiring is: absent officeId defaults to '0' everywhere
 * (never ''), geoLocationId derives from officeAddressType
 * (BIRTHPLACE → birthplace, PERMANENT → permanent), an explicit
 * geoLocationId/locationId always wins, and a draft address with
 * only *Id fields falls back to its finest level's id
 * (ward → union → upazila → district → division) — that last
 * mapping is INFERRED, and the live test confirms it.
 * Run: node --test engines/bdris-apply/v2/tests/http-direct-final.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { normalizeChainInput, finestAddressId, runHttpChain } = require('../services/HttpPathRunner');
const { BdrisHttpClient, buildVerifyPayload, buildSubmitPayload } = require('../http/client');

function validChargeToken(userId, secret, ref = 'ref-1') {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function fullAddr(overrides = {}) {
  return {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ১', postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
    ...overrides,
  };
}

function fullApplication(overrides = {}) {
  return {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: fullAddr(),
    permAddr: fullAddr(),
    prsntAddr: fullAddr(),
    relation: 'FATHER',
    applicantName: 'Abdul Hamid',
    declaration: true,
    email: 'mock@example.com',
    phone: 'mock-phone',
    officeAddressType: 'BIRTH',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    ...overrides,
  };
}

function stubClient(captured) {
  const c = new BdrisHttpClient({ base: 'https://example.invalid' });
  c.apiHeaders = () => ({});
  c.request = async (url, opts) => {
    captured.push({ url, method: opts?.method, body: opts?.body });
    if (url.startsWith('/api/otp/sent')) {
      return { ok: true, status: 200, text: '', json: { code: 'MESSAGE_SENT', message: 'mock', success: true, payload: null } };
    }
    if (url.startsWith('/api/otp/verify')) {
      return { ok: true, status: 200, text: '', json: { isVerified: true } };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return c;
}

describe('finestAddressId', () => {
  it('ward wins, then union, upazila, district, division; empty → ""', () => {
    assert.strictEqual(finestAddressId({ wardId: '7193', paurasavaUnionId: '1988' }), '7193');
    assert.strictEqual(finestAddressId({ paurasavaUnionId: '1988', districtId: '19' }), '1988');
    assert.strictEqual(finestAddressId({ cityCorpUpazilaId: '184' }), '184');
    assert.strictEqual(finestAddressId({ districtId: '19' }), '19');
    assert.strictEqual(finestAddressId({ divisionId: '3' }), '3');
    assert.strictEqual(finestAddressId({}), '');
    assert.strictEqual(finestAddressId({ wardId: '' }), '');
  });
});

describe('normalizeChainInput final wiring', () => {
  it('absent officeId defaults to "0" in canonical + otpContext; explicit wins', () => {
    const n = normalizeChainInput({ person: { dob: '2020-01-15' } });
    assert.strictEqual(n.canonical.officeId, '0');
    assert.strictEqual(n.otpContext.officeId, '0');
    const n2 = normalizeChainInput({ person: {}, officeId: '42' });
    assert.strictEqual(n2.canonical.officeId, '42');
    assert.strictEqual(n2.otpContext.officeId, '42');
  });

  it('draft *Ids fall back to locationIds; explicit locationId wins', () => {
    const n = normalizeChainInput({
      person: { dob: '2020-01-15' },
      birthPlace: { wardId: '7193', paurasavaUnionId: '1988' },
      permAddr: { paurasavaUnionId: '1988' },
    });
    assert.strictEqual(n.otpContext.birthPlaceLocationId, '7193');
    assert.strictEqual(n.otpContext.permAddrLocationId, '1988');
    const n2 = normalizeChainInput({
      person: {},
      birthPlace: { wardId: '7193', locationId: '555' },
    });
    assert.strictEqual(n2.otpContext.birthPlaceLocationId, '555');
  });

  it('explicit geoLocationId passes through untouched', () => {
    const n = normalizeChainInput({ person: {}, geoLocationId: '9999' });
    assert.strictEqual(n.otpContext.geoLocationId, '9999');
  });
});

describe('buildVerifyPayload final wiring', () => {
  it('absent officeId → "0"; PERMANENT → perm id; BIRTHPLACE → birth id; explicit geo wins', () => {
    const base = { phone: 'p', otp: '123456' };
    assert.strictEqual(buildVerifyPayload({ ...base }).officeId, '0');
    const perm = buildVerifyPayload({ ...base, officeAddressType: 'PERMANENT', permAddrLocationId: '1988', birthPlaceLocationId: '7193' });
    assert.strictEqual(perm.geoLocationId, '1988');
    assert.strictEqual(perm.officeAddressType, 'PERMANENT');
    const birth = buildVerifyPayload({ ...base, officeAddressType: 'BIRTHPLACE', permAddrLocationId: '1988', birthPlaceLocationId: '7193' });
    assert.strictEqual(birth.geoLocationId, '7193');
    const over = buildVerifyPayload({ ...base, officeAddressType: 'PERMANENT', permAddrLocationId: '1988', geoLocationId: '4242' });
    assert.strictEqual(over.geoLocationId, '4242');
  });
});

describe('buildSubmitPayload final wiring', () => {
  it('absent officeId → "0"; PERMANENT accepts explicit geoLocationId', () => {
    const p = buildSubmitPayload(fullApplication({ officeAddressType: 'PERMANENT', geoLocationId: '1988' }));
    assert.strictEqual(p.officeId, '0');
    assert.strictEqual(p.geoLocationId, '1988');
    assert.strictEqual(p.officeAddressType, 'PERMANENT');
    const p2 = buildSubmitPayload(fullApplication({ officeId: '7' }));
    assert.strictEqual(p2.officeId, '7');
  });
});

describe('live OTP shapes through the real client (stubbed transport)', () => {
  it('otpSend carries officeId=0 when none supplied and returns MESSAGE_SENT', async () => {
    const captured = [];
    const c = stubClient(captured);
    const res = await c.otpSend({
      phone: 'mock-phone', email: '', personUbrn: '', relation: 'SELF',
      applicantName: 'Mock Name', applicantBrn: '', applicantDob: '', officeAddressType: 'PERMANENT',
      person: { firstNameBn: 'আ', lastNameBn: 'ক', firstNameEn: 'A', lastNameEn: 'K' },
      father: { nameBn: 'ফ', nameEn: 'F' }, mother: { nameBn: 'ম', nameEn: 'M' },
    });
    assert.strictEqual(res.code, 'MESSAGE_SENT');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.payload, null);
    const q = new URLSearchParams(captured[0].url.split('?')[1]);
    assert.strictEqual(q.get('officeId'), '0');
    assert.strictEqual(q.get('geoLocationId'), null, 'send has NO geoLocationId (live proof)');
  });

  it('verifyOtp accepts top-level {isVerified: true} and sends officeId=0 + derived geo', async () => {
    const captured = [];
    const c = stubClient(captured);
    const res = await c.verifyOtp({
      phone: 'mock-phone', otp: '123456', officeAddressType: 'PERMANENT',
      permAddrLocationId: '1988', birthPlaceLocationId: '7193',
    });
    assert.strictEqual(res.isVerified, true);
    const q = new URLSearchParams(captured[0].url.split('?')[1]);
    assert.strictEqual(q.get('officeId'), '0');
    assert.strictEqual(q.get('geoLocationId'), '1988');
    assert.strictEqual(captured[0].method, 'POST');
  });

  it('verifyOtp rejects a non-verified response', async () => {
    const c = new BdrisHttpClient({ base: 'https://example.invalid' });
    c.apiHeaders = () => ({});
    c.request = async () => ({ ok: true, status: 200, text: '', json: { isVerified: false } });
    await assert.rejects(() => c.verifyOtp({ phone: 'p', otp: '123456' }), (e) => e.code === 'VERIFY_NOT_VERIFIED');
  });
});

describe('runHttpChain end-to-end with live shapes (fake client)', () => {
  it('draft *Ids + no officeId → otpSend/verify carry officeId 0 and PERMANENT geo id', async () => {
    const seen = {};
    const fakeClient = {
      bootstrapped: true,
      otpSend: async (ctx) => { seen.send = ctx; return { code: 'MESSAGE_SENT', success: true, payload: null }; },
      verifyOtp: async (ctx) => { seen.verify = ctx; return { isVerified: true }; },
      submitApplication: async () => ({ hasPrintLink: false }),
    };
    const out = await runHttpChain({
      data: {
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
        _chargeToken: validChargeToken('user-1', 'test-secret', 'ref-final'),
      },
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient,
      log: () => {},
    });
    assert.strictEqual(out.ok, true);
    assert.ok(out.steps.includes('otp-send'));
    assert.ok(out.steps.includes('verify'));
    assert.ok(out.steps.includes('submit'));
    assert.strictEqual(seen.send.officeId, '0');
    assert.strictEqual(seen.verify.officeId, '0');
    // The chain passes the PERMANENT address LocationId through
    // (union fallback id); the real client derives geoLocationId
    // from it inside buildVerifyPayload (unit-tested above).
    assert.strictEqual(seen.verify.permAddrLocationId, '1988');
    assert.strictEqual(seen.verify.geoLocationId, '');
  });
});
