/**
 * NATIVE-POST (2026-10-30) — direct submit must match the live
 * browser's native form POST (live script-probe 2026-10-30: the
 * form submits by native <form> POST to /br/application, mechanism
 * native, NO JS submit construction, NO 'application/register' in
 * any page script). The old XHR-style POST (X-Requested-With +
 * Accept: application/json + a mismatched field set) is what the
 * server answers with its static SPA shell.
 *
 * Covered (node:test, no live contact, no browser, fixture data):
 *  #1  submit headers are the document-navigation set and contain
 *      NO x-requested-with (XHR marker dropped on submit only).
 *  #2  the builder field-name set equals the live DOM list
 *      modulo: minus {files, personImage} (the BUILDER emits
 *      neither — submitApplication appends both at wire time as
 *      the browser's empty file parts, see
 *      submit-origin-emptyparts.test.js) plus the retained extras
 *      {personInfoForBirth.father.id, personInfoForBirth.mother.id,
 *      attachments} (dotted ids retained same-value; attachments
 *      ids are the submit-time reference — file bytes go only to
 *      the upload endpoint, never to the submit POST).
 *  #3  copy checkboxes sent only when the copy is effective
 *      (target equals source); a tick with separate target data
 *      sends NO flag (server must not overwrite real data).
 *  #4  City fields dropped; flat father.id/mother.id present;
 *      officeAddr group present (Country from canonical, City /
 *      Office empty — nothing fills them pre-submit); wardId
 *      follows the officeAddressType address (INFERRED).
 *  #5  safety regression: a 200 shell response under the new
 *      headers still throws SUBMIT_NOT_SUCCESS — never a false
 *      success, never an auto-retry (runner suppression untouched).
 *  #6  names stay VERBATIM (single-name never doubled, backticks
 *      preserved) — no name logic is touched by this change.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-native-post.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const {
  BdrisHttpClient,
  buildSubmitPayload,
} = require('../client');

// Live DOM form field names, transcribed from the 2026-10-30
// script-probe result (warm page, all forms, names only).
const DOM_SUBMIT_FIELDS = [
  '_csrf', 'applicantBrn', 'applicantDob', 'applicantName',
  'birthPlaceArea', 'birthPlaceBn', 'birthPlaceCityCorpCantOrUpazila',
  'birthPlaceCountry', 'birthPlaceDist', 'birthPlaceDiv', 'birthPlaceEn',
  'birthPlaceHouseRoadBn', 'birthPlaceHouseRoadEn', 'birthPlaceLocationId',
  'birthPlacePaurasavaOrUnion', 'birthPlacePostCode', 'birthPlacePostOfc',
  'birthPlacePostOfcEn', 'birthPlaceVilAreaTownBn', 'birthPlaceVilAreaTownEn',
  'birthPlaceWardInCityCorp', 'birthPlaceWardInPaurasavaOrUnion',
  'copyBirthPlaceToPermAddr', 'copyPermAddrToPrsntAddr',
  'declaration', 'email', 'father.id', 'files', 'geoLocationId', 'mother.id',
  'officeAddrCity', 'officeAddrCountry', 'officeAddrOffice',
  'officeAddressType', 'officeId', 'otp',
  'permAddrArea', 'permAddrBn', 'permAddrCityCorpCantOrUpazila',
  'permAddrCountry', 'permAddrDist', 'permAddrDiv', 'permAddrEn',
  'permAddrHouseRoadBn', 'permAddrHouseRoadEn', 'permAddrLocationId',
  'permAddrPaurasavaOrUnion', 'permAddrPostCode', 'permAddrPostOfc',
  'permAddrPostOfcEn', 'permAddrVilAreaTownBn', 'permAddrVilAreaTownEn',
  'permAddrWardInCityCorp', 'permAddrWardInPaurasavaOrUnion',
  'personImage',
  'personInfoForBirth.father.passportNumber',
  'personInfoForBirth.father.personBirthDate',
  'personInfoForBirth.father.personNameBn',
  'personInfoForBirth.father.personNameEn',
  'personInfoForBirth.father.personNationality',
  'personInfoForBirth.father.ubrn',
  'personInfoForBirth.gender',
  'personInfoForBirth.mother.passportNumber',
  'personInfoForBirth.mother.personBirthDate',
  'personInfoForBirth.mother.personNameBn',
  'personInfoForBirth.mother.personNameEn',
  'personInfoForBirth.mother.personNationality',
  'personInfoForBirth.mother.ubrn',
  'personInfoForBirth.personBirthDate',
  'personInfoForBirth.personFirstNameBn',
  'personInfoForBirth.personFirstNameEn',
  'personInfoForBirth.personLastNameBn',
  'personInfoForBirth.personLastNameEn',
  'personInfoForBirth.personNameBn',
  'personInfoForBirth.personNameEn',
  'personInfoForBirth.personNid',
  'personInfoForBirth.religionOther',
  'personInfoForBirth.thChild',
  'phone',
  'prsntAddrArea', 'prsntAddrBn', 'prsntAddrCityCorpCantOrUpazila',
  'prsntAddrCountry', 'prsntAddrDist', 'prsntAddrDiv', 'prsntAddrEn',
  'prsntAddrHouseRoadBn', 'prsntAddrHouseRoadEn', 'prsntAddrLocationId',
  'prsntAddrPaurasavaOrUnion', 'prsntAddrPostCode', 'prsntAddrPostOfc',
  'prsntAddrPostOfcEn', 'prsntAddrVilAreaTownBn', 'prsntAddrVilAreaTownEn',
  'prsntAddrWardInCityCorp', 'prsntAddrWardInPaurasavaOrUnion',
  'relationWithApplicant', 'religion', 'wardId',
];

function fixtureAddr(overrides = {}) {
  return {
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ৬', wardId: '7193',
    postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    locationId: '700', en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
    ...overrides,
  };
}

function fixtureApplication(overrides = {}) {
  const base = {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { id: '123', brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { id: '456', brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: fixtureAddr(),
    permAddr: fixtureAddr(),
    prsntAddr: fixtureAddr(),
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

function submitClient(capture, responseText) {
  const client = new BdrisHttpClient({ base: 'http://mock' });
  client.bootstrapped = true;
  client.csrfToken = 'mock-csrf';
  client.request = async (path, opts = {}) => {
    capture.path = path;
    capture.headers = opts.headers || {};
    return { status: 200, ok: true, json: null, text: responseText };
  };
  return client;
}

const SUCCESS_HTML = '<html>আবেদনপত্রটি সফল ভাবে সাবমিট করা হয়েছে'
  + '<a href="/admin/br/application/print">print</a></html>';
const SHELL_HTML = '<html><form><input name="personInfoForBirth"></form></html>';

test('submit headers are the navigation set, never XHR', async () => {
  const capture = {};
  const client = submitClient(capture, SUCCESS_HTML);
  const out = await client.submitApplication(fixtureApplication());
  assert.equal(out.success, true);
  assert.equal(capture.path, '/br/application');
  const keys = Object.keys(capture.headers).map((k) => k.toLowerCase());
  assert.equal(keys.includes('x-requested-with'), false, 'XHR marker must be dropped on submit');
  assert.equal(capture.headers.Accept, 'text/html');
  assert.equal(capture.headers['Sec-Fetch-Dest'], 'document');
  assert.equal(capture.headers['Sec-Fetch-Mode'], 'navigate');
  assert.equal(capture.headers['Sec-Fetch-Site'], 'same-origin');
  assert.equal(capture.headers['Sec-Fetch-User'], '?1');
  assert.equal(capture.headers['Upgrade-Insecure-Requests'], '1');
  // Kept exactly: referer, CSRF header, client marker.
  assert.equal(capture.headers.Referer, 'http://mock/br/application');
  assert.equal(capture.headers['X-CSRF-TOKEN'], 'mock-csrf');
  assert.equal(capture.headers.client, 'bris');
});

test('payload field set equals the DOM list modulo documented exceptions', () => {
  const p = buildSubmitPayload(fixtureApplication({
    copyFlags: { permCopy: true, presCopy: true },
  }));
  const expected = new Set(DOM_SUBMIT_FIELDS);
  expected.delete('files');
  expected.delete('personImage');
  // _csrf is appended by submitApplication, not by the builder.
  expected.delete('_csrf');
  expected.add('personInfoForBirth.father.id');
  expected.add('personInfoForBirth.mother.id');
  expected.add('attachments');
  assert.deepStrictEqual(Object.keys(p).sort(), [...expected].sort());
  // Explicitly: no City fields (live DOM has none).
  assert.equal('birthPlaceCity' in p, false);
  assert.equal('permAddrCity' in p, false);
  assert.equal('prsntAddrCity' in p, false);
  // Flat parent ids carry the same value as the dotted ids.
  assert.equal(p['father.id'], '123');
  assert.equal(p['personInfoForBirth.father.id'], '123');
  assert.equal(p['mother.id'], '456');
  assert.equal(p['personInfoForBirth.mother.id'], '456');
  // Attachments ids are the submit-time document reference.
  assert.deepStrictEqual(p.attachments, ['doc-40', 'doc-41']);
});

test('copy flags sent only when the copy is effective', () => {
  // Effective: identical records + ticks → both flags present.
  const effective = buildSubmitPayload(fixtureApplication({
    copyFlags: { permCopy: true, presCopy: true },
  }));
  assert.equal(effective.copyBirthPlaceToPermAddr, 'true');
  assert.equal(effective.copyPermAddrToPrsntAddr, 'true');
  // Ticked but separate data → NO flag (server must not overwrite).
  const separate = buildSubmitPayload(fixtureApplication({
    copyFlags: { permCopy: true, presCopy: true },
    permAddr: fixtureAddr({ district: 'গাজীপুর' }),
    prsntAddr: fixtureAddr({ district: 'নারায়ণগঞ্জ' }),
  }));
  assert.equal('copyBirthPlaceToPermAddr' in separate, false);
  assert.equal('copyPermAddrToPrsntAddr' in separate, false);
  // No ticks → no flags.
  const none = buildSubmitPayload(fixtureApplication());
  assert.equal('copyBirthPlaceToPermAddr' in none, false);
  assert.equal('copyPermAddrToPrsntAddr' in none, false);
});

test('officeAddr group present; wardId follows the officeAddressType address', () => {
  const p = buildSubmitPayload(fixtureApplication({ officeAddrCountry: 'বাংলাদেশ' }));
  assert.equal(p.officeAddrCountry, 'বাংলাদেশ');
  assert.equal(p.officeAddrCity, '');
  assert.equal(p.officeAddrOffice, '');
  // Default BIRTHPLACE → birthplace ward.
  assert.equal(p.wardId, '7193');
  const perm = buildSubmitPayload(fixtureApplication({
    officeAddressType: 'PERMANENT',
    permAddr: fixtureAddr({ wardId: '7200', ward: 'ওয়ার্ড - ৭' }),
  }));
  assert.equal(perm.wardId, '7200');
  // Non-numeric *Id falls back to the display name (safety guard).
  const named = buildSubmitPayload(fixtureApplication({
    birthPlace: fixtureAddr({ wardId: 'ওয়ার্ড - ৬', ward: 'ওয়ার্ড - ৬' }),
  }));
  assert.equal(named.wardId, 'ওয়ার্ড - ৬');
});

test('shell response under navigation headers still throws, never succeeds', async () => {
  const capture = {};
  const client = submitClient(capture, SHELL_HTML);
  let thrown = null;
  try {
    await client.submitApplication(fixtureApplication());
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'shell must throw');
  assert.equal(thrown.code, 'SUBMIT_NOT_SUCCESS');
  const keys = Object.keys(capture.headers).map((k) => k.toLowerCase());
  assert.equal(keys.includes('x-requested-with'), false);
  assert.equal(capture.headers['Sec-Fetch-Dest'], 'document');
});

test('names stay verbatim: single-name never doubled, backticks preserved', () => {
  const p = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul', lastNameEn: '', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আহাম্মদ আলী`', nameEn: 'Ahammad Ali`', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'রোকিয়া খাতুন`', nameEn: 'Rokia Khathun`', nationality: 'বাংলাদেশী' },
  }));
  assert.equal(p['personInfoForBirth.personNameEn'], 'Abul');
  assert.equal(p['personInfoForBirth.personNameBn'], 'আবুল');
  assert.equal(p['personInfoForBirth.father.personNameBn'], 'আহাম্মদ আলী`');
  assert.equal(p['personInfoForBirth.mother.personNameEn'], 'Rokia Khathun`');
});
