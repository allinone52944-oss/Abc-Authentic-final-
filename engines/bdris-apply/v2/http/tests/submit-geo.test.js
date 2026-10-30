/**
 * SUBMIT-GEO FIX PACK (2026-10-30) — direct submit payload mirrors
 * the browser's submitted value shapes (node:test, no live contact,
 * no browser, no personal data; fixture values only).
 *
 * Bot evidence (the reference — nothing here is guessed):
 *  #1  Cascade selects submit the selected option's VALUE, and the
 *      site's cascade option values are BDRIS geo ids
 *      (BdrisNavigator selectOption value-first, Phase 1 2026-10-27;
 *      StepHandler _selectFirstMatch value-first). So Div/Dist/
 *      CityCorpCantOrUpazila/PaurasavaOrUnion/WardInCityCorp/
 *      WardInPaurasavaOrUnion send geo ids when present, display
 *      names only as fallback.
 *  #2  City-corp pattern (StepHandler _fillAddressSection,
 *      live-verified 2026-10-11, DSCC): the zone goes in
 *      WardInCityCorp and PaurasavaOrUnion stays empty; the ward
 *      goes in WardInPaurasavaOrUnion. Union pattern: union in
 *      PaurasavaOrUnion, ward in WardInPaurasavaOrUnion,
 *      WardInCityCorp empty. Detection is the bot's exact test
 *      on the cityCorpUpazila display value (/সিটি কর্পোরেশন/).
 *  #3  Masked date inputs hold DD/MM/YYYY at submit (StepHandler
 *      _typeMaskedDate types isoToBdFormat output with exact
 *      read-back, S1 person + S2 parents). So person/parent birth
 *      dates send DD/MM/YYYY, never ISO.
 *  #4  thChild is a select whose options carry no value attribute
 *      (mock form mirrors the live form), so the submitted value
 *      IS the option text — the Bengali single digit from
 *      StepHandler thChildSite (live-verified v1).
 *  #5  applicantDob is DELIBERATELY unchanged: no bot code types
 *      an applicantDob into any site input, so its form format is
 *      unproven and converting it would be a guess.
 *  #6  Names stay VERBATIM through all of this: single-name joins
 *      stay single (never doubled), backticks preserved exactly.
 *
 * Run: node --test engines/bdris-apply/v2/http/tests/submit-geo.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { buildSubmitPayload } = require('../client');

// Fixture application in the builders' canonical input shape.
// All values are mock fixtures.
function fixtureApplication(overrides = {}) {
  const addr = (over = {}) => ({
    country: 'বাংলাদেশ', division: 'ঢাকা', district: 'ঢাকা',
    cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', paurasavaUnion: 'অঞ্চল - ৮',
    ward: 'ওয়ার্ড - ৬৮', postOfficeBn: 'সারুলিয়া', postOfficeEn: 'Sarulia',
    villageBn: 'সারুলিয়া', villageEn: 'Sarulia', houseRoadBn: '', houseRoadEn: '',
    locationId: '700', en: 'Sarulia, Dhaka', bn: 'সারুলিয়া, ঢাকা',
    ...over,
  });
  const base = {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: addr(),
    permAddr: addr(),
    prsntAddr: addr(),
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

const ID_ADDR = {
  divisionId: '3', districtId: '19', cityCorpUpazilaId: '184',
  paurasavaUnionId: '1988', wardId: '7193',
};

test('geo ids preferred when present, on all three address sections', () => {
  const p = buildSubmitPayload(fixtureApplication({
    birthPlace: fixtureApplication().birthPlace,
    permAddr: { ...fixtureApplication().permAddr, ...ID_ADDR },
    prsntAddr: { ...fixtureApplication().prsntAddr, ...ID_ADDR },
  }));
  // No ids on birthPlace → display names (fallback), city-corp swap still applies.
  assert.strictEqual(p.birthPlaceDiv, 'ঢাকা');
  assert.strictEqual(p.birthPlaceWardInCityCorp, 'অঞ্চল - ৮');
  assert.strictEqual(p.birthPlacePaurasavaOrUnion, '');
  // Ids on perm/present → ids win on every cascade field.
  for (const pre of ['permAddr', 'prsntAddr']) {
    assert.strictEqual(p[`${pre}Div`], '3');
    assert.strictEqual(p[`${pre}Dist`], '19');
    assert.strictEqual(p[`${pre}CityCorpCantOrUpazila`], '184');
    assert.strictEqual(p[`${pre}WardInCityCorp`], '1988');
    assert.strictEqual(p[`${pre}PaurasavaOrUnion`], '');
    assert.strictEqual(p[`${pre}WardInPaurasavaOrUnion`], '7193');
  }
});

test('display names used when an id is absent — never a new throw for ids', () => {
  const p = buildSubmitPayload(fixtureApplication({
    // Only some ids present: the rest fall back to names, and the
    // payload still builds (ids are never newly required).
    permAddr: { ...fixtureApplication().permAddr, divisionId: '3', wardId: '' },
  }));
  assert.strictEqual(p.permAddrDiv, '3');
  assert.strictEqual(p.permAddrDist, 'ঢাকা');
  assert.strictEqual(p.permAddrCityCorpCantOrUpazila, 'ঢাকা দক্ষিণ সিটি কর্পোরেশন');
  assert.strictEqual(p.permAddrWardInCityCorp, 'অঞ্চল - ৮');
  assert.strictEqual(p.permAddrWardInPaurasavaOrUnion, 'ওয়ার্ড - ৬৮');
  // Numeric ids pass through as strings.
  const q = buildSubmitPayload(fixtureApplication({
    permAddr: { ...fixtureApplication().permAddr, divisionId: 3, districtId: 19 },
  }));
  assert.strictEqual(q.permAddrDiv, '3');
  assert.strictEqual(q.permAddrDist, '19');
});

test('union addresses keep the union mapping (no city-corp swap)', () => {
  const union = {
    division: 'ঢাকা', district: 'কিশোরগঞ্জ', cityCorpUpazila: 'কটিয়াদী',
    paurasavaUnion: 'চান্দপুর', ward: 'ওয়ার্ড - ৬',
    divisionId: '3', districtId: '19', cityCorpUpazilaId: '184',
    paurasavaUnionId: '1988', wardId: '7193',
    postOfficeBn: 'মানিকখালী', postOfficeEn: 'Manikkhali',
    villageBn: 'মীরের পাড়া', villageEn: 'Mirer Para',
    locationId: '700', en: '', bn: '',
  };
  const p = buildSubmitPayload(fixtureApplication({ birthPlace: union }));
  assert.strictEqual(p.birthPlaceDiv, '3');
  assert.strictEqual(p.birthPlaceDist, '19');
  assert.strictEqual(p.birthPlaceCityCorpCantOrUpazila, '184');
  assert.strictEqual(p.birthPlacePaurasavaOrUnion, '1988');
  assert.strictEqual(p.birthPlaceWardInCityCorp, '');
  assert.strictEqual(p.birthPlaceWardInPaurasavaOrUnion, '7193');
});

test('dates send DD/MM/YYYY for person and both parents; applicantDob unchanged', () => {
  const p = buildSubmitPayload(fixtureApplication());
  assert.strictEqual(p['personInfoForBirth.personBirthDate'], '15/01/2020');
  assert.strictEqual(p['personInfoForBirth.father.personBirthDate'], '01/05/1990');
  assert.strictEqual(p['personInfoForBirth.mother.personBirthDate'], '01/03/1992');
  // applicantDob defaults to the person's dob and is left as
  // supplied (ISO) — its form format is unproven (see #5 above).
  assert.strictEqual(p.applicantDob, '2020-01-15');
  // Empty parent DOBs stay empty, never a placeholder.
  const q = buildSubmitPayload(fixtureApplication({
    father: { brn: '', dob: '', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
  }));
  assert.strictEqual(q['personInfoForBirth.father.personBirthDate'], '');
  assert.strictEqual(q['personInfoForBirth.mother.personBirthDate'], '');
  // Already-DD/MM/YYYY input passes through untouched.
  const r = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '15/01/2020', gender: 'পুরুষ', thChild: '১ম' },
  }));
  assert.strictEqual(r['personInfoForBirth.personBirthDate'], '15/01/2020');
});

test('thChild sends the Bengali single digit, mirroring thChildSite', () => {
  const cases = [
    ['১ম', '১'], ['২য়', '২'], ['৩য়', '৩'], ['১০ম', '১০'], ['১১তম', '১১'],
    ['3', '৩'], ['1st', '১'],
  ];
  for (const [input, want] of cases) {
    const p = buildSubmitPayload(fixtureApplication({
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: input },
    }));
    assert.strictEqual(p['personInfoForBirth.thChild'], want, `thChild ${input} → ${want}`);
  }
  // Unparseable thChild passes through, never drops the filing.
  const p = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: 'প্রথম' },
  }));
  assert.strictEqual(p['personInfoForBirth.thChild'], 'প্রথম');
});

test('names byte-unchanged through the geo/date/thChild reshaping', () => {
  const p = buildSubmitPayload(fixtureApplication({
    person: { firstNameBn: 'আবুল', lastNameBn: '', firstNameEn: 'Abul', lastNameEn: '', dob: '1980-02-02', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আহাম্মদ আলী`', nameEn: 'Ahammad Ali`', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'রোকিয়া খাতুন`', nameEn: 'Rokia Khathun`', nationality: 'বাংলাদেশী' },
    permAddr: { ...fixtureApplication().permAddr, ...ID_ADDR },
  }));
  // Single name joined once, never doubled.
  assert.strictEqual(p['personInfoForBirth.personNameBn'], 'আবুল');
  assert.strictEqual(p['personInfoForBirth.personNameEn'], 'Abul');
  assert.strictEqual(p['personInfoForBirth.personFirstNameBn'], 'আবুল');
  assert.strictEqual(p['personInfoForBirth.personLastNameBn'], '');
  // Backticks preserved exactly, in both languages, all three names.
  assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'আহাম্মদ আলী`');
  assert.strictEqual(p['personInfoForBirth.father.personNameEn'], 'Ahammad Ali`');
  assert.strictEqual(p['personInfoForBirth.mother.personNameBn'], 'রোকিয়া খাতুন`');
  assert.strictEqual(p['personInfoForBirth.mother.personNameEn'], 'Rokia Khathun`');
  // And the reshaped fields still reshaped alongside verbatim names.
  assert.strictEqual(p['personInfoForBirth.personBirthDate'], '02/02/1980');
  assert.strictEqual(p.permAddrDiv, '3');
  assert.strictEqual(p.permAddrWardInCityCorp, '1988');
});
