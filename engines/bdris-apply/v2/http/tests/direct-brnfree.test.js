'use strict';
// DIRECT BRN-FREE ROUTE (2026-10-29): the direct path for filings
// that carry NO parent BRN at all, in every bracket — not 2013-only.
// This is DIRECT-path logic, not bot logic: there is no page
// Next-validation gate on the direct path, the server POST decides.
// What is pinned here (all mock fixtures, never a live host):
//  - the direct payload carries fatherUbrn/motherUbrn = '' whenever
//    no parent BRN was given (pre-2013, 2013, 2014+ alike), and
//    carries a digit-normalised BRN only when one was given and
//    not withheld by the exemption/family rule;
//  - send/verify names use the transit (typed) form — backticks
//    and other marks stripped, single names NEVER doubled (the
//    refuted send-gate that doubled them is deleted);
//  - relation travels as the site's enum value on send, verify,
//    and submit (the draft's Bengali label maps via the bot's own
//    REL_VALUE map; enums and unknown values pass through);
//  - verify geoLocationId derives from officeAddressType
//    (PERMANENT → permanent LocationId, else birthplace; an
//    explicit geoLocationId wins) and officeId defaults to '0';
//  - the runner marks BRN-free filings with brnFreeRoute 'direct'
//    as INFORMATION only — it never sends, verifies, or submits
//    on its own.
// What is NOT pinned here (live proof still owed): whether the
// BDRIS server accepts a direct BRN-free submit, and whether it
// accepts a backtick in the final submit record (submit names
// stay verbatim on purpose — see DIRECT-BRN-FREE-LIVE-TEST.md).

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  BdrisHttpClient,
  buildOtpSendBody,
  buildSubmitPayload,
  buildVerifyPayload,
  transitDirectName,
  mapDirectRelation,
  parentBrnDirectDecision,
} = require('../client');
const { normalizeChainInput, runHttpChain } = require('../../services/HttpPathRunner');

function addr(overrides = {}) {
  return {
    division: 'ঢাকা', district: 'ঢাকা', cityCorpUpazila: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন',
    paurasavaUnion: 'অঞ্চল - ১', ward: 'ওয়ার্ড - ১',
    postOfficeBn: 'ঢাকা', postOfficeEn: 'Dhaka', villageBn: 'মহল্লা', villageEn: 'Moholla',
    locationId: '700',
    ...overrides,
  };
}

function completeApplication(overrides = {}) {
  return {
    person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', nationality: 'বাংলাদেশী' },
    mother: { brn: '', dob: '1992-03-01', nameBn: 'ফাতেমা', nameEn: 'Fatema', nationality: 'বাংলাদেশী' },
    birthPlace: addr({ locationId: '111' }),
    permAddr: addr({ locationId: '222' }),
    prsntAddr: addr({ locationId: '222' }),
    relation: 'পিতা',
    applicantName: 'Abdul Hamid',
    declaration: true,
    email: 'mock@example.com',
    phone: 'mock-phone',
    officeAddressType: 'PERMANENT',
    officeId: '',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    ...overrides,
  };
}

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

describe('direct BRN-free payload, all brackets', () => {
  it('pre-2013, no BRN: parent ubrn empty in submit', () => {
    const p = buildSubmitPayload(completeApplication({
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2012-06-01', gender: 'পুরুষ', thChild: '১ম' },
    }));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
  });

  it('2013, no BRN: parent ubrn empty in submit', () => {
    const p = buildSubmitPayload(completeApplication({
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2013-07-11', gender: 'পুরুষ', thChild: '১ম' },
    }));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
  });

  it('2014+, no BRN at all: parent ubrn empty in submit (BRN-free, not exempt-only)', () => {
    const p = buildSubmitPayload(completeApplication({
      person: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob: '2020-01-15', gender: 'পুরুষ', thChild: '১ম' },
    }));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
  });

  it('2014+, BRN given and not withheld: digit-normalised BRN carried (not BRN-free)', () => {
    const d = parentBrnDirectDecision({
      person: { dob: '2020-01-15' },
      father: { brn: '১২৩৪৫৬৭৮৯০১২৩৪৫৬৭' },
      mother: { brn: '12345678901234567' },
    });
    assert.strictEqual(d.fatherUbrn, '12345678901234567');
    assert.strictEqual(d.motherUbrn, '12345678901234567');
    assert.strictEqual(d.withheldBySiteRule, false);
  });

  it('family names-only with BRN given: ubrn withheld, draft BRN untouched by the decision', () => {
    const d = parentBrnDirectDecision({
      person: { dob: '2020-01-15' },
      father: { brn: '12345678901234567' },
      mother: { brn: '12345678901234567' },
      _familyNamesOnly: true,
    });
    assert.strictEqual(d.fatherUbrn, '');
    assert.strictEqual(d.motherUbrn, '');
    assert.strictEqual(d.familyNamesOnly, true);
  });
});

describe('direct send/verify: transit names, never doubled', () => {
  it('single-name applicant goes out verbatim on send query and body, never doubled', async () => {
    const { c, seen } = capturingClient();
    await c.otpSend({
      phone: 'mock-phone', applicantName: 'Rahim',
      person: { firstNameBn: 'রহিম', lastNameBn: '', firstNameEn: 'Rahim', lastNameEn: '' },
    });
    assert.strictEqual(queryOf(seen.url).get('applicantName'), 'Rahim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameEn'), 'Rahim');
    assert.strictEqual(bodyField(seen.body, 'personInfoForBirth.personNameBn'), 'রহিম');
  });

  it('backtick and other marks stripped on send body (transit form), letters kept', () => {
    const b = buildOtpSendBody({
      person: { firstNameBn: 'আবদুল`', lastNameBn: 'করিম', firstNameEn: 'Abdul.', lastNameEn: 'Karim' },
      father: { nameBn: 'আবদুল` হামিদ', nameEn: 'Abdul` Hamid' },
      mother: { nameBn: 'ফাতেমা:', nameEn: 'Fatema*' },
    });
    assert.strictEqual(b['personInfoForBirth.personNameBn'], 'আবদুল করিম');
    assert.strictEqual(b['personInfoForBirth.personNameEn'], 'Abdul Karim');
    assert.strictEqual(b['personInfoForBirth.father.personNameBn'], 'আবদুল হামিদ');
    assert.strictEqual(b['personInfoForBirth.father.personNameEn'], 'Abdul Hamid');
    assert.strictEqual(b['personInfoForBirth.mother.personNameEn'], 'Fatema');
    assert.ok(!Object.values(b).some((v) => String(v).includes('`')));
  });

  it('transitDirectName: marks-only names become empty, two-part names unchanged', () => {
    assert.strictEqual(transitDirectName('`.*'), '');
    assert.strictEqual(transitDirectName('Abdul Karim'), 'Abdul Karim');
    assert.strictEqual(transitDirectName('আবদুল করিম'), 'আবদুল করিম');
  });

  it('verify applicantName uses the transit form', () => {
    const p = buildVerifyPayload({ otp: '123456', applicantName: 'Abdul` Karim', relation: 'পিতা' });
    assert.strictEqual(p.applicantName, 'Abdul Karim');
  });
});

describe('direct relation: Bengali label maps to enum', () => {
  it('all bot REL_VALUE labels map, enums and unknowns pass through', () => {
    assert.strictEqual(mapDirectRelation('পিতা'), 'FATHER');
    assert.strictEqual(mapDirectRelation('মাতা'), 'MOTHER');
    assert.strictEqual(mapDirectRelation('নিজ'), 'SELF');
    assert.strictEqual(mapDirectRelation('পিতামহ'), 'GRANDFATHER');
    assert.strictEqual(mapDirectRelation('অভিভাবক'), 'GUARDIAN');
    assert.strictEqual(mapDirectRelation('অন্যান্য'), 'OTHERS');
    assert.strictEqual(mapDirectRelation('FATHER'), 'FATHER');
    assert.strictEqual(mapDirectRelation('SOMETHING_ELSE'), 'SOMETHING_ELSE');
    assert.strictEqual(mapDirectRelation(''), '');
  });

  it('send query, verify query, and submit payload all carry the enum', async () => {
    const { c, seen } = capturingClient();
    await c.otpSend({ phone: 'mock-phone', applicantName: 'Abdul Karim', relation: 'পিতা' });
    assert.strictEqual(queryOf(seen.url).get('relation'), 'FATHER');
    assert.strictEqual(buildVerifyPayload({ otp: '123456', relation: 'মাতা' }).relation, 'MOTHER');
    assert.strictEqual(buildSubmitPayload(completeApplication()).relationWithApplicant, 'FATHER');
  });
});

describe('direct verify: geoLocationId and officeId', () => {
  it('PERMANENT uses the permanent LocationId, BIRTHPLACE the birthplace one', () => {
    const perm = buildVerifyPayload({ otp: '123456', officeAddressType: 'PERMANENT', permAddrLocationId: '222', birthPlaceLocationId: '111' });
    assert.strictEqual(perm.geoLocationId, '222');
    const birth = buildVerifyPayload({ otp: '123456', officeAddressType: 'BIRTHPLACE', permAddrLocationId: '222', birthPlaceLocationId: '111' });
    assert.strictEqual(birth.geoLocationId, '111');
  });

  it('explicit geoLocationId wins, officeId defaults to 0', () => {
    const p = buildVerifyPayload({ otp: '123456', officeAddressType: 'PERMANENT', geoLocationId: '999', permAddrLocationId: '222' });
    assert.strictEqual(p.geoLocationId, '999');
    assert.strictEqual(p.officeId, '0');
  });

  it('submit geoLocationId follows officeAddressType and officeId defaults to 0', () => {
    const p = buildSubmitPayload(completeApplication());
    assert.strictEqual(p.geoLocationId, '222');
    assert.strictEqual(p.officeId, '0');
  });
});

describe('direct submit: final record truth for BRN-free filings', () => {
  it('submit names carry the transit form (bot bridge) and documents 40/41 are required', () => {
    const p = buildSubmitPayload(completeApplication({
      father: { brn: '', dob: '1990-05-01', nameBn: 'আবদুল` হামিদ', nameEn: 'Abdul` Hamid', nationality: 'বাংলাদেশী' },
    }));
    // SUBMIT-FINAL (2026-10-30): the old verbatim rule rested
    // on a live-test question, answered 2026-10-30 (four 200
    // HTML form walls with verbatim backtick names) — the
    // submit payload mirrors the bot's transit form; the draft
    // is untouched and the record is never doubled.
    assert.strictEqual(p['personInfoForBirth.father.personNameEn'], 'Abdul Hamid');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'আবদুল হামিদ');
    assert.deepStrictEqual(p.attachments, [40, 41]);
    assert.throws(() => buildSubmitPayload(completeApplication({ documents: [] })), /documents\[40\]/);
  });
});

describe('runner: BRN-free routing marker is information only', () => {
  function draftInput(dob, fatherBrn) {
    return {
      s1: { firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim', dob, gender: 'পুরুষ', thChild: '১ম' },
      s2: {
        father: { nameBn: 'আবদুল হামিদ', nameEn: 'Abdul Hamid', brn: fatherBrn },
        mother: { nameBn: 'ফাতেমা', nameEn: 'Fatema', brn: '' },
      },
      s2b: { perm: {}, pres: {} },
      s3: { relation: 'পিতা', docs: [] },
      s4prep: { email: 'mock@example.com', phone: '01700000000' },
    };
  }

  it('no BRN in any bracket marks brnFreeRoute direct; BRN given does not', () => {
    for (const dob of ['2012-06-01', '2013-07-11', '2020-01-15']) {
      const n = normalizeChainInput(draftInput(dob, ''));
      assert.strictEqual(n.brnFree, true, dob);
      assert.strictEqual(n.brnFreeRoute, 'direct', dob);
    }
    const given = normalizeChainInput(draftInput('2020-01-15', '12345678901234567'));
    assert.strictEqual(given.brnFree, false);
    assert.strictEqual(given.brnFreeRoute, null);
  });

  it('send-phase result carries the marker and does not touch verify/submit', async () => {
    const calls = [];
    const client = {
      bootstrapped: true,
      otpSend: async () => { calls.push('otp-send'); return { success: true, code: 'MESSAGE_SENT', message: 'Message has been sent', payload: null }; },
      verifyOtp: async () => { calls.push('verify'); },
      submitApplication: async () => { calls.push('submit'); return { success: true, hasPrintLink: false, json: null }; },
    };
    const out = await runHttpChain({ data: draftInput('2013-07-11', ''), phase: 'send', client, env: { BDRIS_HTTP_PATH: 'on' } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sent, true);
    assert.strictEqual(out.brnFree, true);
    assert.strictEqual(out.brnFreeRoute, 'direct');
    assert.deepStrictEqual(calls, ['otp-send']);
  });

  it('pre-submit failure result carries the marker and the BRN-free note, no resend', async () => {
    const client = {
      bootstrapped: true,
      otpSend: async () => { const e = new Error('OTP send returned status 400: duplicate.'); e.code = 'OTP_SEND_FAILED'; throw e; },
    };
    const out = await runHttpChain({ data: draftInput('2020-01-15', ''), phase: 'send', client, env: { BDRIS_HTTP_PATH: 'on' } });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.brnFree, true);
    assert.strictEqual(out.brnFreeRoute, 'direct');
    assert.match(out.brnFreeNote, /bot fallback cannot pass BRN-free/);
    assert.strictEqual(out.fallback, true);
  });
});
