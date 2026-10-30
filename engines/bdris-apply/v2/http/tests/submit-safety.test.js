/**
 * SUBMIT-SAFETY FIX PACK (2026-10-30) — client-level value guards
 * (node:test, no live contact, no browser, no personal data;
 * fixture values only).
 *
 *  - *Id numeric guard: an address-book *Id holding a display name
 *    is not an id (addrBookFill builds options with value=name,
 *    readAddrFields stores the value as *Id) — it must fall back
 *    to the name, never be sent as an id.
 *  - Country id: the bot selects country value-first with
 *    countryId (StepHandler _fillAddressSection), so the payload
 *    sends countryId when present, name only as fallback.
 *  - officeAddressType default: empty input maps to BIRTHPLACE
 *    (frontend ctx builder already defaults this way).
 *  - submitResponseSummary explicit-failure flag: JSON
 *    success === false is a positive non-filing signal, distinct
 *    from an unrecognized-shape 200 page.
 *  - Names stay VERBATIM through all of this (single join never
 *    doubled, backticks exact) — asserted in the country test.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-safety.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const {
  buildSubmitPayload, mapOfficeAddressType, submitResponseSummary,
} = require('../client');

function addr(over = {}) {
  return {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ৮',
    ward: 'ওয়ার্ড - ৬৮', postOfficeBn: 'সারুলিয়া', postOfficeEn: 'Sarulia',
    villageBn: 'সারুলিয়া', villageEn: 'Sarulia', houseRoadBn: '', houseRoadEn: '',
    ...over,
  };
}

function payload(over = {}) {
  return buildSubmitPayload({
    person: { firstNameBn: 'আবদুল', lastNameBn: '', firstNameEn: 'Abdul', lastNameEn: '', dob: '2020-01-15', thChild: '১ম', gender: 'পুরুষ' },
    father: { nameBn: 'আবদুল `হামিদ', nameEn: 'Abdul Hamid' },
    mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema' },
    birthPlace: addr(), permAddr: addr(), prsntAddr: addr(),
    relation: 'FATHER', phone: '01700000000', otp: '123456',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: 'u40', id: 1 },
      { attachmentType: 41, attachmentTypeId: 41, url: 'u41', id: 2 },
    ],
    ...over,
  });
}

test('numeric guard: a name stored in an *Id falls back to the name', () => {
  const p = payload({ birthPlace: addr({ divisionId: 'ঢাকা', wardId: 'ওয়ার্ড - ৬৮' }) });
  assert.equal(p.birthPlaceDiv, 'ঢাকা');
  assert.equal(p.birthPlaceWardInPaurasavaOrUnion, 'ওয়ার্ড - ৬৮');
});

test('numeric guard: a real numeric *Id still wins over the name', () => {
  const p = payload({ birthPlace: addr({ divisionId: '3', districtId: '19', wardId: '7193' }) });
  assert.equal(p.birthPlaceDiv, '3');
  assert.equal(p.birthPlaceDist, '19');
  assert.equal(p.birthPlaceWardInPaurasavaOrUnion, '7193');
});

test('country: countryId wins when numeric, name otherwise', () => {
  assert.equal(payload({ birthPlace: addr({ countryId: '19' }) }).birthPlaceCountry, '19');
  assert.equal(payload({ birthPlace: addr({ countryId: 'বাংলাদেশ' }) }).birthPlaceCountry, 'বাংলাদেশ');
  assert.equal(payload().birthPlaceCountry, 'বাংলাদেশ');
});

test('country change leaves names verbatim (single + backticks)', () => {
  const p = payload();
  assert.equal(p['personInfoForBirth.personNameBn'], 'আবদুল');
  assert.equal(p['personInfoForBirth.personNameEn'], 'Abdul');
  assert.equal(p['personInfoForBirth.father.personNameBn'], 'আবদুল `হামিদ');
});

test('mapOfficeAddressType: empty input defaults to BIRTHPLACE', () => {
  assert.equal(mapOfficeAddressType(''), 'BIRTHPLACE');
  assert.equal(mapOfficeAddressType(null), 'BIRTHPLACE');
  assert.equal(mapOfficeAddressType(undefined), 'BIRTHPLACE');
  assert.equal(mapOfficeAddressType('PERMANENT'), 'PERMANENT');
  assert.equal(mapOfficeAddressType('BIRTH'), 'BIRTHPLACE');
  assert.equal(mapOfficeAddressType('MISSION'), 'MISSION');
});

test('submitResponseSummary flags explicit JSON failure distinctly', () => {
  const explicit = submitResponseSummary({ status: 200, json: { success: false, message: 'bad' }, text: '' });
  assert.equal(explicit.jsonExplicitFailure, true);
  assert.equal(explicit.jsonSuccess, false);
  const page = submitResponseSummary({ status: 200, json: null, text: '<form>personInfoForBirth</form>' });
  assert.equal(page.jsonExplicitFailure, false);
  assert.equal(page.hasFormFields, true);
  const ok = submitResponseSummary({ status: 200, json: { success: true }, text: '' });
  assert.equal(ok.jsonExplicitFailure, false);
  assert.equal(ok.jsonSuccess, true);
});
