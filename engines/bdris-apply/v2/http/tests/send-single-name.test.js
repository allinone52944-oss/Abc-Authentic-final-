'use strict';
// DIRECT SEND SINGLE-NAME TEST (2026-10-29): TEST-ONLY diagnostic.
// The bot path bridges single names at the gate (last name without
// letters → the first name's form in the last slot), but the direct
// send has no such bridge — whether /api/otp/sent requires a
// two-word applicantName is unproven. These tests prove the send
// request (query applicantName + the six body name fields) carries
// the gate form for single names, while the submit payload keeps
// the true single name (never doubled) and verify is untouched.
// Mock fetch only; never contacts a live host. All fixture values
// are invented; no real phone, name, or application data is used.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  BdrisHttpClient,
  buildOtpSendBody,
  buildSubmitPayload,
  buildVerifyPayload,
} = require('../client');

function capturingClient() {
  const seen = { url: '', body: null };
  const fetchImpl = async (url, opts) => {
    seen.url = url;
    seen.body = opts && opts.body ? opts.body : null;
    return {
      status: 200,
      ok: true,
      headers: { getSetCookie: undefined, get: () => null },
      text: async () => JSON.stringify({ code: 'MESSAGE_SENT', message: 'Message has been sent', success: true, payload: null }),
    };
  };
  const c = new BdrisHttpClient({ base: 'http://mock', fetchImpl });
  c.seedFromBrowser({ cookies: [], csrfToken: 'mock-csrf' });
  return { c, seen };
}

function queryOf(url) {
  return new URL(url).searchParams;
}

function bodyField(body, name) {
  return body && typeof body.get === 'function' ? body.get(name) : null;
}

function addr() {
  return {
    division: 'ঢাকা', district: 'ঢাকা', cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
    postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka', villageBn: 'মহল্লা', villageEn: 'Moholla',
  };
}

describe('send-phase single-name gate (DIRECT SEND SINGLE-NAME TEST)', () => {
  it('single-name applicant → query applicantName + both body person names gated', async () => {
    const { c, seen } = capturingClient();
    await c.otpSend({
      phone: 'mock-phone', applicantName: 'Rahim',
      person: { firstNameBn: 'রহিম', lastNameBn: '', firstNameEn: 'Rahim', lastNameEn: '' },
      father: { nameBn: 'করিম', nameEn: 'Karim' },
      mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
    });
    assert.strictEqual(queryOf(seen.url).get('applicantName'), 'Rahim Rahim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameBn'), 'রহিম রহিম');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameEn'), 'Rahim Rahim');
  });

  it('single-token father gated, two-token mother verbatim (both languages)', async () => {
    const { c, seen } = capturingClient();
    await c.otpSend({
      phone: 'mock-phone', applicantName: 'Rahim',
      person: { firstNameBn: 'রহিম', lastNameBn: '', firstNameEn: 'Rahim', lastNameEn: '' },
      father: { nameBn: 'করিম', nameEn: 'Karim' },
      mother: { nameBn: 'ফাতেমা বেগম', nameEn: 'Fatema Begum' },
    });
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.father.personNameBn'), 'করিম করিম');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.father.personNameEn'), 'Karim Karim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.mother.personNameBn'), 'ফাতেমা বেগম');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.mother.personNameEn'), 'Fatema Begum');
  });

  it('two-part names go out byte-identical (query + all six body fields)', async () => {
    const { c, seen } = capturingClient();
    await c.otpSend({
      phone: 'mock-phone', applicantName: 'Abdul Karim',
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim' },
      father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid' },
      mother: { nameBn: 'ফাতেমা বেগম', nameEn: 'Fatema Begum' },
    });
    assert.strictEqual(queryOf(seen.url).get('applicantName'), 'Abdul Karim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameBn'), 'আবদুল করিম');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameEn'), 'Abdul Karim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.father.personNameBn'), 'আবদুল হামিদ');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.father.personNameEn'), 'Abdul Hamid');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.mother.personNameBn'), 'ফাতেমা বেগম');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.mother.personNameEn'), 'Fatema Begum');
  });

  it('marks-only last part (no letters) is gated, not passed through', () => {
    const body = buildOtpSendBody({
      person: { firstNameBn: 'রহিম', lastNameBn: '`', firstNameEn: 'Rahim', lastNameEn: '' },
      father: {}, mother: {},
    });
    assert.strictEqual(body['personInfoForBirth.personNameBn'], 'রহিম রহিম');
    assert.strictEqual(body['personInfoForBirth.personNameEn'], 'Rahim Rahim');
  });

  it('explicitly joined person name: single token gated, two-part verbatim', () => {
    const single = buildOtpSendBody({
      person: { personNameBn: 'রহিম', personNameEn: 'Rahim', firstNameBn: 'রহিম', lastNameBn: '' },
      father: {}, mother: {},
    });
    assert.strictEqual(single['personInfoForBirth.personNameBn'], 'রহিম রহিম');
    assert.strictEqual(single['personInfoForBirth.personNameEn'], 'Rahim Rahim');
    const twoPart = buildOtpSendBody({
      person: { personNameBn: 'আবদুল করিম', personNameEn: 'Abdul Karim' },
      father: {}, mother: {},
    });
    assert.strictEqual(twoPart['personInfoForBirth.personNameBn'], 'আবদুল করিম');
    assert.strictEqual(twoPart['personInfoForBirth.personNameEn'], 'Abdul Karim');
  });

  it('no person split at all: single-token explicit applicantName gated, two-part verbatim', async () => {
    const one = capturingClient();
    await one.c.otpSend({ phone: 'mock-phone', applicantName: 'Rahim', person: {}, father: {}, mother: {} });
    assert.strictEqual(queryOf(one.seen.url).get('applicantName'), 'Rahim Rahim');
    const two = capturingClient();
    await two.c.otpSend({ phone: 'mock-phone', applicantName: 'Abdul Karim', person: {}, father: {}, mother: {} });
    assert.strictEqual(queryOf(two.seen.url).get('applicantName'), 'Abdul Karim');
  });

  it('SUBMIT payload still carries the true single name (never doubled)', () => {
    const payload = buildSubmitPayload({
      person: { firstNameBn: 'রহিম', lastNameBn: '', firstNameEn: 'Rahim', lastNameEn: '', dob: '2003-08-14', thChild: '২য়', gender: 'পুরুষ' },
      father: { nameBn: 'করিম', nameEn: 'Karim' },
      mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
      birthPlace: addr(), permAddr: addr(), prsntAddr: addr(),
      relation: 'FATHER', phone: 'mock-phone', otp: '123456',
      officeAddressType: 'BIRTHPLACE',
      documents: [
        { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
        { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
      ],
    });
    assert.strictEqual(payload.applicantName, 'Rahim');
    assert.strictEqual(payload['personInfoForBirth.personNameBn'], 'রহিম');
    assert.strictEqual(payload['personInfoForBirth.personNameEn'], 'Rahim');
    assert.strictEqual(payload['personInfoForBirth.father.personNameBn'], 'করিম');
    assert.strictEqual(payload['personInfoForBirth.mother.personNameBn'], 'ফাতেমা');
    assert.ok(!Object.values(payload).some((v) => typeof v === 'string' && /Rahim Rahim|রহিম রহিম/.test(v)), 'no doubled name anywhere in the submit payload');
  });

  it('VERIFY payload keeps the true single applicantName (verify untouched)', () => {
    const payload = buildVerifyPayload({
      otp: '123456', applicantName: 'Rahim', officeAddressType: 'BIRTHPLACE',
      birthPlaceLocationId: '700',
    });
    assert.strictEqual(payload.applicantName, 'Rahim');
  });
});
