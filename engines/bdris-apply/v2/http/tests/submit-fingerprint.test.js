/**
 * SUBMIT-CAUSE (2026-10-30) — response fingerprint probe for the
 * silent direct-submit wall (5× live: 200 HTML re-rendered form,
 * no JSON wording, no error-class text).
 *
 * submitResponseFingerprint records STRUCTURE ONLY: form action
 * path (+query-present flag, never query values), step-marker
 * presence, Bengali message-word presence, per-control echoed
 * value presence (yes/no ONLY), hidden input NAMES, and submit
 * button NAMES. It must NEVER leak a value, person name, number,
 * code, token, date, or identifier — digit runs are stripped and
 * the output is capped.
 *
 * All fixture values below are fake. Run:
 * node --test engines/bdris-apply/v2/http/tests/submit-fingerprint.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const {
  BdrisHttpClient,
  buildSubmitPayload,
  submitResponseFingerprint,
} = require('../client');

// Fake values chosen to be tempting leaks: names (both scripts),
// digits (phone, dates, codes, ids), a token, and an address.
const LEAKS = [
  'FakeNameBn', 'FakeNameEn', '01999999999', '1990-05-01',
  '02/02/1980', 'tok-abc-12345', '987654', 'SomeVillage',
  'HiddenVal', 'DocId-777', 'secretword',
];
const FORM_HTML = `<html><body>
<form action="/br/application?appType=NEWBORN" method="post">
<input type="hidden" name="_csrf" value="tok-abc-12345">
<input type="hidden" name="personInfoForBirth.id" value="">
<input type="hidden" name="officeId" value="0">
<input name="personInfoForBirth.personFirstNameEn" value="FakeNameEn">
<input name="personInfoForBirth.personFirstNameBn" value="FakeNameBn">
<input name="personInfoForBirth.personLastNameEn" value="">
<input name="personInfoForBirth.father.personNameBn" value="FakeNameBn">
<input name="personInfoForBirth.personBirthDate" value="02/02/1980">
<input name="birthPlaceDiv" value="">
<select name="birthPlaceDist"><option value="">---</option><option value="19" selected>DistrictText</option></select>
<select name="permAddrDiv"><option value="">---</option><option value="3">DivisionText</option></select>
<input name="phone" value="01999999999">
<input name="otp" value="987654">
<input type="checkbox" name="declaration" value="true" checked>
<input type="checkbox" name="copyBirthPlaceToPermAddr" value="true">
<textarea name="note">SomeVillage</textarea>
<input name="attachments" value="DocId-777">
<button type="submit" name="saveBtn" value="save">Submit</button>
</form>
<div>এই তথ্যটি ভুল হয়েছে, অনুগ্রহ করে সঠিক করুন</div>
</body></html>`;

function fixtureApplication() {
  const addr = (division) => ({
    country: 'বাংলাদেশ', division, district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ১',
    ward: 'ওয়ার্ড - ১', postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka',
    villageBn: 'মহল্লা', villageEn: 'Moholla', houseRoadBn: 'বাসা ১', houseRoadEn: 'House 1',
    locationId: '700', en: 'House 1, Moholla, Dhaka', bn: 'বাসা ১, মহল্লা, ঢাকা',
  });
  return {
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
}

test('fingerprint leaks no value, name, number, code, token, or date', () => {
  const fp = submitResponseFingerprint({ text: FORM_HTML });
  for (const leak of LEAKS) assert.ok(!fp.includes(leak), `fingerprint must not contain ${leak}`);
  // No digit run at all (Arabic or Bengali digits) may survive.
  assert.ok(!/[0-9০-৯]/.test(fp), `fingerprint must contain no digits: ${fp}`);
  // Query values never appear, only the query-present flag.
  assert.ok(!fp.includes('NEWBORN'), 'query value must not appear');
  assert.ok(fp.includes('formQuery=yes'), 'query presence must be flagged');
});

test('fingerprint reports structure: action, steps, words, fields, hidden, buttons', () => {
  const fp = submitResponseFingerprint({ text: FORM_HTML });
  assert.ok(fp.includes('formAction=/br/application'), 'action path recorded');
  // Step markers: person + parents present, pres-address absent.
  assert.ok(fp.includes('stepPerson:yes'), 'person marker present');
  assert.ok(fp.includes('stepParents:yes'), 'parents marker present');
  assert.ok(fp.includes('stepPresAddr:no'), 'present-address marker absent');
  // Message words: ভুল + সঠিক present, আবশ্যক + ত্রুটি absent.
  assert.ok(fp.includes('ভুল:yes') && fp.includes('সঠিক:yes'), 'present words flagged');
  assert.ok(fp.includes('আবশ্যক:no') && fp.includes('ত্রুটি:no'), 'absent words flagged');
  // Echoed values: filled yes, empty no, checkbox checked yes / unchecked no.
  assert.ok(fp.includes('personInfoForBirth.personFirstNameEn:yes'), 'filled input yes');
  assert.ok(fp.includes('personInfoForBirth.personLastNameEn:no'), 'empty input no');
  assert.ok(fp.includes('birthPlaceDist:yes'), 'selected option yes');
  assert.ok(fp.includes('permAddrDiv:no'), 'unselected select no');
  assert.ok(fp.includes('declaration:yes'), 'checked box yes');
  assert.ok(fp.includes('copyBirthPlaceToPermAddr:no'), 'unchecked box no');
  assert.ok(fp.includes('note:yes'), 'non-empty textarea yes (text itself absent)');
  // Hidden names listed (names only), submit button named.
  assert.ok(fp.includes('hidden=_csrf|personInfoForBirth.id|officeId'), 'hidden names listed');
  assert.ok(fp.includes('submitBtn=yes') && fp.includes('submitBtnNames=saveBtn'), 'submit button named');
  assert.ok(fp.includes('submitBtnValue=yes'), 'submit button value presence flagged');
});

test('fingerprint is capped and handles empty bodies', () => {
  assert.equal(submitResponseFingerprint({ text: '' }), '');
  assert.equal(submitResponseFingerprint(null), '');
  const many = Array.from({ length: 300 }, (_, i) => `<input type="hidden" name="h${i}" value="v${i}">`).join('');
  const fp = submitResponseFingerprint({ text: `<form action="/br/application">${many}</form>` });
  assert.ok(fp.length <= 2000, `fingerprint capped, got ${fp.length}`);
  assert.ok(!/[0-9০-৯]/.test(fp), 'capped fingerprint still digit-free');
});

test('submitApplication attaches responseFingerprint on the form-wall throw', async () => {
  const client = new BdrisHttpClient({ base: 'http://mock' });
  client.csrfToken = 'mock-csrf';
  client.apiHeaders = () => ({});
  client.request = async () => ({
    status: 200, ok: true, json: null,
    text: '<html><form action="/br/application"><input name="personInfoForBirth"><input name="phone" value="01999999999"></form></html>',
  });
  let thrown = null;
  try {
    await client.submitApplication(fixtureApplication());
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'submit must throw on the form wall');
  assert.equal(thrown.code, 'SUBMIT_NOT_SUCCESS');
  assert.ok(thrown.responseFingerprint, 'fingerprint attached');
  assert.ok(thrown.responseFingerprint.includes('formAction=/br/application'), 'action in fingerprint');
  assert.ok(!thrown.responseFingerprint.includes('01999999999'), 'phone value never in fingerprint');
  assert.ok(!/[0-9০-৯]/.test(thrown.responseFingerprint), 'fingerprint digit-free');
});
