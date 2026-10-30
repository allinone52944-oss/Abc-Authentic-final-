/**
 * SUBMIT-FINAL FIX PACK (2026-10-30) — submit error wording
 * + S4 OTP-step gate (node:test, no live contact, no browser,
 * no personal data; fixture values only).
 *
 * REVISED per user directive 2026-10-30 that ALL logics are
 * required: the direct-payload transit change is REJECTED and
 * reverted — submit names stay VERBATIM (backticks/marks
 * preserved exactly as given), single-name joins stay single
 * and are never doubled, and the input draft is untouched.
 * What remains from SUBMIT-FINAL is diagnostics only: the
 * submit response carries error wording so the true wall cause
 * can be learned live, instead of stripping the user's names
 * on an unproven hypothesis.
 *
 * Covered:
 *  #1  buildSubmitPayload keeps applicant/father/mother
 *      names verbatim (backticks preserved) and joins
 *      single names once, never doubled; the input draft is
 *      untouched.
 *  #2  submitErrorWording returns wording only: JSON
 *      message/code, or an error-class HTML snippet with digit
 *      runs removed; a re-rendered form with values in input
 *      attributes yields '' (no leak).
 *  #2b submitApplication attaches responseErrorWording on the
 *      SUBMIT_NOT_SUCCESS throw alongside responseSummary.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-final.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const {
  BdrisHttpClient,
  buildSubmitPayload,
  submitErrorWording,
} = require('../client');

// Fixture application in the builders' canonical input shape.
// All values are mock fixtures.
function fixtureApplication(overrides = {}) {
  const addr = (division) => ({
    country: 'বাংলাদেশ', division, district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ১', postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    locationId: '700', en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
  });
  const base = {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: addr('ঢাকা'),
    permAddr: addr('ঢাকা'),
    prsntAddr: addr('ঢাকা'),
    relation: 'FATHER',
    declaration: true,
    email: 'mock@example.com',
    phone: 'mock-phone',
    otp: '123456',
    documents: [
      { attachmentType: 40, id: 'doc-40' },
      { attachmentType: 41, id: 'doc-41' },
    ],
  };
  return { ...base, ...overrides };
}

test('single-name applicant + backticks: payload is verbatim, never doubled', () => {
  const input = fixtureApplication({
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আহাম্মদ আলী`', nameEn: 'Ahammad Ali`', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'রোকিয়া খাতুন`', nameEn: 'Rokia Khathun`', nationality: 'বাংলাদেশী' },
  });
  const p = buildSubmitPayload(input);
  // Applicant: single name joined once, never doubled.
  assert.equal(p['personInfoForBirth.personFirstNameEn'], 'Abul');
  assert.equal(p['personInfoForBirth.personLastNameEn'], '');
  assert.equal(p['personInfoForBirth.personNameEn'], 'Abul');
  assert.equal(p['personInfoForBirth.personFirstNameBn'], 'আবুল');
  assert.equal(p['personInfoForBirth.personLastNameBn'], '');
  assert.equal(p['personInfoForBirth.personNameBn'], 'আবুল');
  // Parents: backticks preserved exactly as given (verbatim).
  assert.equal(p['personInfoForBirth.father.personNameBn'], 'আহাম্মদ আলী`');
  assert.equal(p['personInfoForBirth.father.personNameEn'], 'Ahammad Ali`');
  assert.equal(p['personInfoForBirth.mother.personNameBn'], 'রোকিয়া খাতুন`');
  assert.equal(p['personInfoForBirth.mother.personNameEn'], 'Rokia Khathun`');
  // The input draft is untouched (verbatim applies to the payload as given).
  assert.equal(input.person.lastNameEn, '');
  assert.equal(input.father.nameBn, 'আহাম্মদ আলী`');
});

test('empty last name stays single; marks stay verbatim', () => {
  const p = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul.', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
  }));
  assert.equal(p['personInfoForBirth.personFirstNameEn'], 'Abul.');
  assert.equal(p['personInfoForBirth.personLastNameEn'], '');
  assert.equal(p['personInfoForBirth.personNameEn'], 'Abul.');
  assert.equal(p['personInfoForBirth.personNameBn'], 'আবুল');
});

test('normal two-name case is unchanged', () => {
  const p = buildSubmitPayload(fixtureApplication());
  assert.equal(p['personInfoForBirth.personFirstNameEn'], 'Abdul');
  assert.equal(p['personInfoForBirth.personLastNameEn'], 'Karim');
  assert.equal(p['personInfoForBirth.personNameEn'], 'Abdul Karim');
  assert.equal(p['personInfoForBirth.personNameBn'], 'আবদুল করিম');
  assert.equal(p['personInfoForBirth.father.personNameEn'], 'Abdul Hamid');
});

test('supplied applicantName stays verbatim, never doubled', () => {
  const p = buildSubmitPayload(fixtureApplication({ applicantName: 'Abul`' }));
  assert.equal(p.applicantName, 'Abul`');
  const p2 = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
  }));
  assert.equal(p2.applicantName, 'Abul');
});

test('submitErrorWording: JSON message/code, HTML error-class, no leak', () => {
  assert.equal(submitErrorWording({ json: { message: '  Validation failed  ' }, text: '' }), 'Validation failed');
  assert.equal(submitErrorWording({ json: { code: 'INVALID_FIELD' }, text: '' }), 'INVALID_FIELD');
  // HTML error-class snippet: wording kept, digit runs removed.
  assert.equal(
    submitErrorWording({ json: null, text: '<div class="text-danger">এই ঘরটি পূরণ আবশ্যক ১২৩</div>' }),
    'এই ঘরটি পূরণ আবশ্যক',
  );
  // Re-rendered form with values in input attributes but NO
  // error-class text yields '' — values never leak into the log.
  assert.equal(
    submitErrorWording({ json: null, text: '<form><input name="personFirstNameEn" value="SomeName"><input name="phone" value="999999"></form>' }),
    '',
  );
  assert.equal(submitErrorWording({ json: null, text: '' }), '');
  assert.equal(submitErrorWording(null), '');
});

test('submitApplication attaches responseErrorWording on the form-wall throw', async () => {
  const client = new BdrisHttpClient({ base: 'http://mock' });
  client.csrfToken = 'mock-csrf';
  client.apiHeaders = () => ({});
  client.request = async () => ({
    status: 200, ok: true, json: null,
    text: '<html><form><input name="personInfoForBirth"><div class="text-danger">এই ঘরটি পূরণ আবশ্যক</div></form></html>',
  });
  let thrown = null;
  try {
    await client.submitApplication(fixtureApplication());
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'submit must throw on the form wall');
  assert.equal(thrown.code, 'SUBMIT_NOT_SUCCESS');
  assert.ok(thrown.responseSummary, 'shape summary attached');
  assert.equal(thrown.responseSummary.hasFormFields, true);
  assert.equal(thrown.responseSummary.hasSuccessPhrase, false);
  assert.equal(thrown.responseErrorWording, 'এই ঘরটি পূরণ আবশ্যক');
});
