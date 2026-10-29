/**
 * Parent-verify, single-name pattern mirror (2026-10-29, permanent) — mock only, no live contact.
 *
 * User instruction: apply it the SAME WAY the single-name logic fix
 * was done. Chain (user): age given → verify system comes; the
 * applicant himself is not the verify subject in the application.
 *
 * Single-name pattern as found in code:
 *   detect (last name letterless → singleName) → relax page
 *   validator only (relaxEmptyLast) → gate-pass with TRUE given
 *   data only (fillDoubledLast: first name in the last slot) →
 *   final record truth (buildCinnos: joined name = first name ONCE,
 *   never doubled) → advance proof (fields gone), quiet proceed.
 *
 * Mirror result (code-proven, see StepHandler comments): steps
 * detect / relaxable-rules / final-record-truth / advance-proof
 * mirror; the GATE-PASS step BREAKS for verify-state, because the
 * verify gate slot is registry-derived boolean state (verified
 * flags set only by a registry hit in _clickVerify / mock
 * verifyParent), not a validator rule and not a text field. No
 * given true value maps to it — parents' names are already on the
 * page, ID-card documents are not yet on the site at S2, and
 * neither is a registry verification. Setting verified=true via
 * page.evaluate would manufacture a verification — forbidden here.
 * So the bot page stops, classified, and the BRN-free route is the
 * applicant's own direct channel (final ubrn ''), where the SERVER
 * decides. Server acceptance of a BRN-free direct filing is still
 * UNPROVEN; these tests prove classification + final-record shape
 * only, never a live pass.
 *
 * Never: no BRN invented, no name altered/doubled/substituted, no
 * verified result faked, no rejected submit resent, no QR change,
 * no single-name/cinno rule touched.
 * Run: node --test engines/bdris-apply/v2/tests/parentverify-singlename-pattern.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  StepHandler, isParentVerifyStateError, parentVerifyPatternDecision,
} = require('../services/StepHandler');
const { buildSubmitPayload } = require('../http/client');

const VERIFY_TEXT = 'সাইট এগোতে দিচ্ছে না — Father birth record not verified [personInfoForBirth.father.ubrn] | Mother birth record not verified [personInfoForBirth.mother.ubrn]';
const REQUIRED_TEXT = 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn]';
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

function baseHandler(siteDobValue) {
  const h = new StepHandler({ page: fakePage(siteDobValue) }, { emit: () => {} });
  h._typeInto = async () => ({ ok: true });
  h._typeMaskedDate = async () => ({ ok: true });
  h._selectFirstMatch = async () => ({ ok: true });
  h._clickVerify = async () => { throw new Error('Verify must never run for an exempt/BRN-free case'); };
  h._dismissNotices = async () => false;
  h._parentsFieldsGone = async () => false;
  return h;
}

const parentsNoBrn = (dob) => ({
  applicantDob: dob,
  father: { nameBn: 'পিতা', nameEn: 'Father' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother' },
});

describe('isParentVerifyStateError (distinct class)', () => {
  it('matches father+mother verified text', () => {
    assert.strictEqual(isParentVerifyStateError(VERIFY_TEXT), true);
  });
  it('matches a single-parent verified text', () => {
    assert.strictEqual(isParentVerifyStateError('Father birth record not verified [personInfoForBirth.father.ubrn]'), true);
  });
  it('does NOT match a required-field gate text', () => {
    assert.strictEqual(isParentVerifyStateError(REQUIRED_TEXT), false);
  });
  it('does NOT swallow family/180-days text (family branch stays first)', () => {
    assert.strictEqual(isParentVerifyStateError(FAMILY_TEXT), false);
  });
  it('rejects unrelated text', () => {
    assert.strictEqual(isParentVerifyStateError('কিছু ঘর অসম্পূর্ণ'), false);
    assert.strictEqual(isParentVerifyStateError(''), false);
    assert.strictEqual(isParentVerifyStateError(null), false);
  });
});

describe('parentVerifyPatternDecision (gate-pass break, final record truth)', () => {
  it('BRN-free + names present → direct-brn-free, final ubrn empty, gate NOT passable', () => {
    const d = parentVerifyPatternDecision({
      siteError: VERIFY_TEXT,
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    });
    assert.strictEqual(d.gatePassable, false);
    assert.strictEqual(d.channel, 'direct-brn-free');
    assert.strictEqual(d.finalFatherUbrn, '');
    assert.strictEqual(d.finalMotherUbrn, '');
    assert.match(d.gateBreakReason, /রেজিস্ট্রি-স্টেট/);
    assert.match(d.note, /direct চ্যানেল/);
  });
  it('BRN presented but Verify failed → verify-again, never a fabricated pass', () => {
    const d = parentVerifyPatternDecision({
      siteError: VERIFY_TEXT,
      father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567' },
    });
    assert.strictEqual(d.gatePassable, false);
    assert.strictEqual(d.channel, 'verify-again');
    assert.strictEqual(d.finalFatherUbrn, '');
  });
  it('names missing → no channel at all (cannot route on nothing)', () => {
    const d = parentVerifyPatternDecision({
      siteError: VERIFY_TEXT, father: {}, mother: {},
    });
    assert.strictEqual(d.channel, null);
    assert.strictEqual(d.gatePassable, false);
  });
  it('non-verify text → null (required gates keep their own branch)', () => {
    assert.strictEqual(parentVerifyPatternDecision({ siteError: REQUIRED_TEXT, father: {}, mother: {} }), null);
  });
});

describe('submitS2 verify-state branch (all brackets, one Next, honest failure)', () => {
  for (const [label, dob] of [['pre-2013', '2010-01-01'], ['2013', '2013-07-11'], ['2014+', '2020-01-01']]) {
    it(`${label}: BRN-free verify block → classified failure, exactly 1 Next, no fill-and-retry line`, async () => {
      const h = baseHandler('');
      let nextCalls = 0;
      h._clickNextAndWait = async () => { nextCalls += 1; return { ok: true }; };
      h._detectValidationBlock = async () => ({ blocked: true, reason: VERIFY_TEXT });
      const out = await h.submitS2(parentsNoBrn(dob));
      assert.strictEqual(out.ok, false, `${label} must not advance on a verify-state block`);
      assert.strictEqual(nextCalls, 1, `${label}: no second Next after a verify-state block`);
      assert.strictEqual(out.parentVerifyUnverified, true);
      assert.strictEqual(out.parentVerifyCode, 'PARENT_VERIFY_UNVERIFIED');
      assert.strictEqual(out.parentVerifyPattern.channel, 'direct-brn-free');
      assert.strictEqual(out.parentVerifyPattern.finalFatherUbrn, '');
      assert.strictEqual(out.parentVerifyPattern.finalMotherUbrn, '');
      assert.match(out.reason, /not verified/);
      assert.doesNotMatch(out.message, /ঘরটি পূরণ করে আবার চেষ্টা করুন/);
    });
  }
  it('BRN presented but Verify failed → verify-again channel, still 1 Next', async () => {
    const h = baseHandler('');
    let nextCalls = 0;
    h._clickNextAndWait = async () => { nextCalls += 1; return { ok: true }; };
    h._clickVerify = async () => ({ verified: false });
    h._readParentLanded = async () => ({ brn: 'present', dob: 'present' });
    h._detectValidationBlock = async () => ({ blocked: true, reason: VERIFY_TEXT });
    const out = await h.submitS2({
      applicantDob: '2020-01-01',
      father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567' },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(out.parentVerifyPattern.channel, 'verify-again');
  });
  it('stale verify text with parents fields gone → NOT a failure (advance proof wins)', async () => {
    const h = baseHandler('');
    h._clickNextAndWait = async () => ({ ok: true });
    h._parentsFieldsGone = async () => true;
    h._waitVisible = async () => null;
    h._detectValidationBlock = async () => ({ blocked: true, reason: VERIFY_TEXT });
    const out = await h.submitS2(parentsNoBrn('2013-07-11'));
    assert.strictEqual(out.ok, true, 'fields gone means the site advanced; stale text must not block');
    assert.strictEqual(out.parentVerifyUnverified, undefined);
  });
});

describe('direct final record for BRN-free (all brackets): ubrn empty, names verbatim', () => {
  it('2014+ no-BRN payload carries empty ubrn, never a placeholder', () => {
    const addr = { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' };
    const p = buildSubmitPayload({
      birthPlace: addr,
      s1: { firstNameBn: 'ক', firstNameEn: 'K', dob: '2020-01-01', thChild: '1', gender: 'মহিলা' },
      s2: {
        father: { nameBn: 'পিতা', nameEn: 'Father' },
        mother: { nameBn: 'মাতা', nameEn: 'Mother' },
      },
      relation: 'SELF', phone: '01', otp: '123456',
      documents: [{ attachmentType: 40, id: 1 }, { attachmentType: 41, id: 2 }],
      s2b: { perm: addr, pres: addr },
    });
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'পিতা');
    assert.strictEqual(p['personInfoForBirth.mother.personNameEn'], 'Mother');
  });
});
