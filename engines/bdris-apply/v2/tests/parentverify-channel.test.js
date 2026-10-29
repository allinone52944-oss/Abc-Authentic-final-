/**
 * Parent-verify channel (2026-10-29, permanent) — mock only, no live contact.
 *
 * Mechanism (code-proven, not assumed): the live Step 6 panel
 * "Father birth record not verified [personInfoForBirth.father.ubrn]
 * | Mother birth record not verified [personInfoForBirth.mother.ubrn]"
 * is the BDRIS site page's own Next-validation text, read by
 * _detectValidationBlock (visible .text-danger/.invalid-feedback
 * elements, nearest input name appended) and returned by submitS2's
 * tail as a site error. It is a verification-STATE error, not a
 * required-field gate error: the 2013-gate relax only removes
 * required markers/rules, and a required-rule relax cannot set a
 * record to verified — verified state comes only from the site's
 * own Verify (a real registry BRN). The old tail fed this text
 * into the relax-and-retry branch (it contains "ubrn"), so it
 * deterministically re-failed after a futile relax + Next, and
 * the panel told the user to "fill the field and retry" — false
 * when no parent BRN exists at all.
 *
 * Scope (user direction 2026-10-29 ~19:25): NOT just 2013. This
 * branch has no year or bracket condition — it covers every
 * parent-registration case: pre-2013, 2013, 2014+ with a BRN
 * presented but unverified, 2014+ with no BRN at all, family
 * names-only, and a single unverified parent. The note is picked
 * by whether a BRN was WITHHELD by a site rule (exempt or family
 * clear) versus PRESENTED to Verify and failed — a rule-based
 * split, not a year hack. The applicant-channel note is the
 * honest next step: no BRN is invented, no verified result is
 * faked, no rejection is forced; the applicant files themselves
 * through their own OTP-verified direct channel, the server
 * decides, and the officer verifies against the parents' ID
 * cards — submission alone registers nothing.
 *
 * What this build deliberately does NOT do: it does not pass the
 * bot page's parents step without verified parent records. On
 * the bot path that pass is genuinely impossible without a real
 * BRN (mock live-verified 2026-10-10: non-pre-2013 requires
 * verified.father && verified.mother; Verify succeeds only on a
 * registry hit). That impossibility is reported, not hidden by
 * narrowing scope to 2013 or by relaxing another validator rule.
 *
 * Never: no BRN/DOB invented or substituted, no name altered,
 * no document claimed uploaded, no QR/single-name/cinno change.
 * Run: node --test engines/bdris-apply/v2/tests/parentverify-channel.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  StepHandler, isParentVerifyStateError,
  PARENT_VERIFY_CHANNEL_NOTE_WITHHELD, PARENT_VERIFY_CHANNEL_NOTE_PRESENTED,
  PARENT_BRN_2013_NOTE,
} = require('../services/StepHandler');
const { buildSubmitPayload, parentBrnDirectDecision } = require('../http/client');

const LIVE_TEXT = 'সাইট এগোতে দিচ্ছে না — Father birth record not verified [personInfoForBirth.father.ubrn] | Mother birth record not verified [personInfoForBirth.mother.ubrn]';
const REQUIRED_TEXT = 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn] | Click to select your birth date [personInfoForBirth.father.personBirthDate]';
const FAMILY_TEXT = 'সাইট এগোতে দিচ্ছে না — Difference of age among children needs to be at least 180 days';

function fakePage(siteDobValue) {
  return {
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (arg && Array.isArray(arg)) return 'ok';
      if (typeof fn === 'function' && siteDobValue !== undefined) return siteDobValue;
      return '';
    },
  };
}

function baseHandler() {
  const h = new StepHandler({ page: fakePage('') }, { emit: () => {} });
  h._typeInto = async () => ({ ok: true });
  h._typeMaskedDate = async () => ({ ok: true });
  h._selectFirstMatch = async () => ({ ok: true });
  h._dismissNotices = async () => false;
  h._parentsFieldsGone = async () => false;
  return h;
}

// BRN-clear fills (father, mother), then nulls — matches the exempt
// fill path, and the advanced-proof _waitVisible call in the stale
// test (fields gone).
function waitStub() {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls <= 2 ? { fill: async () => {} } : null;
  };
}

function runVerifyCase({ dob, parents, verifyResult, familyNamesOnly, fieldsGone }) {
  const h = baseHandler();
  let nextCalls = 0;
  let verifyCalls = 0;
  let relaxCalls = 0;
  h._relaxParentBrnGate = async () => { relaxCalls += 1; return 'ok'; };
  h._clickNextAndWait = async () => { nextCalls += 1; return { ok: true }; };
  h._clickVerify = async () => {
    verifyCalls += 1;
    if (verifyResult === 'throw') throw new Error('Verify must never run for a withheld BRN');
    return { verified: verifyResult };
  };
  h._readParentLanded = async () => ({ brn: 'present', dob: 'present' });
  h._waitVisible = waitStub();
  if (fieldsGone !== undefined) h._parentsFieldsGone = async () => fieldsGone;
  const blocks = [
    { blocked: true, reason: LIVE_TEXT },
    { blocked: true, reason: LIVE_TEXT },
  ];
  h._detectValidationBlock = async () => blocks.shift() || { blocked: false };
  const data = { applicantDob: dob, father: parents.father, mother: parents.mother };
  if (familyNamesOnly) data.familyNamesOnly = true;
  return h.submitS2(data).then((out) => ({ out, nextCalls, verifyCalls, relaxCalls }));
}

const namesOnly = {
  father: { nameBn: 'পিতা', nameEn: 'Father' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother' },
};
const brnGiven = {
  father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567', dob: '1980-01-01' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567', dob: '1982-01-01' },
};

describe('isParentVerifyStateError', () => {
  it('matches the live two-parent text and a single-parent text', () => {
    assert.strictEqual(isParentVerifyStateError(LIVE_TEXT), true);
    assert.strictEqual(isParentVerifyStateError('Father birth record not verified [personInfoForBirth.father.ubrn]'), true);
    assert.strictEqual(isParentVerifyStateError('মাতার জন্ম নিবন্ধন যাচাই হয়নি [personInfoForBirth.mother.ubrn]'), true);
  });
  it('does not match required-field, family, unrelated-verified, or empty text', () => {
    assert.strictEqual(isParentVerifyStateError(REQUIRED_TEXT), false);
    assert.strictEqual(isParentVerifyStateError(FAMILY_TEXT), false);
    assert.strictEqual(isParentVerifyStateError('OTP verified'), false);
    assert.strictEqual(isParentVerifyStateError(''), false);
    assert.strictEqual(isParentVerifyStateError(null), false);
  });
});

describe('submitS2 parent-verify state — every bracket, one classified failure', () => {
  it('pre-2013, no BRN: classified, withheld note, no second Next, no Verify, no verifyUncertain', async () => {
    const { out, nextCalls, verifyCalls } = await runVerifyCase({ dob: '2012-06-15', parents: namesOnly, verifyResult: 'throw' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.parentVerifyUnverified, true);
    assert.strictEqual(out.parentVerifyChannel, 'applicant');
    assert.strictEqual(out.reason, LIVE_TEXT, 'site text preserved verbatim');
    assert.strictEqual(out.failed[0].code, 'PARENT_VERIFY_UNVERIFIED');
    assert.ok(out.failed[0].reason.includes(PARENT_VERIFY_CHANNEL_NOTE_WITHHELD));
    assert.ok(!out.message.includes('ঘরটি পূরণ করে আবার চেষ্টা করুন'), 'no false fill-and-retry instruction');
    assert.strictEqual(nextCalls, 1, 'no futile gate-relax retry Next');
    assert.strictEqual(verifyCalls, 0);
    assert.strictEqual(out.verifyUncertain, undefined, 'replay must not treat this as advance-anyway');
  });
  it('2013, no BRN: classified with the withheld note and the 2013 brnNote', async () => {
    const { out, nextCalls } = await runVerifyCase({ dob: '2013-07-11', parents: namesOnly, verifyResult: 'throw' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.parentVerifyUnverified, true);
    assert.ok(out.failed[0].reason.includes(PARENT_VERIFY_CHANNEL_NOTE_WITHHELD));
    assert.strictEqual(out.brnNote, PARENT_BRN_2013_NOTE);
    assert.strictEqual(nextCalls, 1);
  });
  it('2014+, BRN presented but Verify failed: classified with the presented note, Verify result preserved', async () => {
    const { out, verifyCalls } = await runVerifyCase({ dob: '2014-01-01', parents: brnGiven, verifyResult: false });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.parentVerifyUnverified, true);
    assert.ok(out.failed[0].reason.includes(PARENT_VERIFY_CHANNEL_NOTE_PRESENTED));
    assert.strictEqual(out.verifyStatus.father, false, 'failed Verify is reported, not overwritten');
    assert.ok(verifyCalls >= 2, 'both parents were Verify-attempted on the site channel');
  });
  it('2014+, no BRN at all: classified with the presented note (a real BRN is the only site input)', async () => {
    const { out } = await runVerifyCase({ dob: '2014-01-01', parents: namesOnly, verifyResult: 'throw' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.parentVerifyUnverified, true);
    assert.ok(out.failed[0].reason.includes(PARENT_VERIFY_CHANNEL_NOTE_PRESENTED));
  });
  it('family names-only, 2014+: withheld note, Verify never runs, no second Next', async () => {
    const { out, nextCalls, verifyCalls } = await runVerifyCase({ dob: '2014-01-01', parents: namesOnly, verifyResult: 'throw', familyNamesOnly: true });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.parentVerifyUnverified, true);
    assert.ok(out.failed[0].reason.includes(PARENT_VERIFY_CHANNEL_NOTE_WITHHELD), 'BRN withheld by the family rule, not presented');
    assert.strictEqual(verifyCalls, 0);
    assert.strictEqual(nextCalls, 1);
  });
  it('stale verify text with fields already gone: advance is claimed on fields-gone proof, not blocked on text', async () => {
    const { out } = await runVerifyCase({ dob: '2013-07-11', parents: namesOnly, verifyResult: 'throw', fieldsGone: true });
    assert.strictEqual(out.ok, true, 'fields gone = site advanced, stale text must not block');
    assert.strictEqual(out.parentVerifyUnverified, undefined);
  });
});

describe('direct channel agreement — no invented value in any bracket', () => {
  it('exempt and non-exempt no-BRN both send empty ubrn; a presented BRN passes through normalised', () => {
    const exempt = parentBrnDirectDecision({ applicantDob: '2013-07-11', s2: namesOnly });
    assert.strictEqual(exempt.fatherUbrn, '');
    assert.strictEqual(exempt.motherUbrn, '');
    const noBrn = parentBrnDirectDecision({ applicantDob: '2014-01-01', s2: namesOnly });
    assert.strictEqual(noBrn.fatherUbrn, '');
    const given = parentBrnDirectDecision({ applicantDob: '2014-01-01', s2: { father: { brn: '১২৩৪৫৬৭৮৯০১২৩৪৫৬৭' }, mother: { brn: '12345678901234567' } } });
    assert.strictEqual(given.fatherUbrn, '12345678901234567', 'Bengali digits normalise, value never replaced');
    const payload = buildSubmitPayload({
      birthPlace: { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' },
      s1: { firstNameBn: 'ক', firstNameEn: 'K', dob: '2014-01-01', thChild: '1', gender: 'মহিলা' },
      s2: namesOnly, relation: 'SELF', phone: '01', otp: '123456',
      documents: [{ attachmentType: 40, id: 1 }, { attachmentType: 41, id: 2 }],
      s2b: { perm: { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' }, pres: { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' } },
    });
    assert.strictEqual(payload['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(payload['personInfoForBirth.father.personNameBn'], 'পিতা', 'names verbatim, never altered');
  });
});
