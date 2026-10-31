/**
 * 2013-gate relax (2026-10-29, permanent) — mock only, no live contact.
 *
 * Researched mechanism (not a frontend assumption): the engine's
 * frontend already exempts 2013 from parent BRN/DOB, but the BDRIS
 * site page's own validator still marks father/mother ubrn and
 * father/mother personBirthDate as required — the live fill on
 * b2bd0cb2 showed exactly "please fill this field" [father.ubrn]
 * and "Click to select your birth date" [father.personBirthDate]
 * while the frontend said 2013 needs no BRN. The bot previously only
 * cleared the BRN field and skipped Verify; it never relaxed the
 * site's required rules, so the site gate still blocked. This build
 * mirrors relaxEmptyLast (single-name bridge) for those four fields:
 * required markers + validator rules removed, fields left EMPTY.
 *
 * User correction honoured (2026-10-29 ~17:17): the server keys its
 * age/verify decision off the applicant DOB as held on ITS page, so
 * submitS2 now guards against a site-held DOB that puts the child in
 * a different bracket than the draft DOB, instead of proceeding
 * under the wrong exemption. The whole-2013 exemption itself is a
 * USER rule (2026-10-29), never live-proven at the server — these
 * tests prove the in-page gate behaviour only. Server-side POST
 * acceptance for 2013 with empty ubrn remains UNPROVEN; a submit
 * rejection there is surfaced verbatim, never forced.
 *
 * Never: no BRN invented, no parent DOB invented or substituted, no
 * name altered, no single-name/cinno rule touched, no QR change.
 * Run: node --test engines/bdris-apply/v2/tests/2013-gate-relax.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  StepHandler, relaxParentBrnGate, parseSiteDateToIso, isParentBrnExempt,
  PARENT_BRN_2013_NOTE,
} = require('../services/StepHandler');
const { buildSubmitPayload } = require('../http/client');

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
  h._clickVerify = async () => { throw new Error('Verify must never run for an exempt year'); };
  h._clickNextAndWait = async () => ({ ok: true });
  h._dismissNotices = async () => false;
  h._parentsFieldsGone = async () => true;
  return h;
}

function waitStub() {
  let calls = 0;
  return async (sels) => {
    // STEP-PROOF (A1): address calls answer present without
    // consuming the parent-field call count.
    const _list = Array.isArray(sels) ? sels : [sels];
    if (_list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))) return { fill: async () => {} };
    calls += 1;
    return calls <= 2 ? { fill: async () => {} } : null;
  };
}

const parentsNoBrnNoDob = (dob) => ({
  applicantDob: dob,
  father: { nameBn: 'পিতা', nameEn: 'Father' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother' },
});

describe('parseSiteDateToIso', () => {
  it('parses DD/MM/YYYY and ISO, rejects garbage', () => {
    assert.strictEqual(parseSiteDateToIso('11/07/2013'), '2013-07-11');
    assert.strictEqual(parseSiteDateToIso('2013-07-11'), '2013-07-11');
    assert.strictEqual(parseSiteDateToIso(''), null);
    assert.strictEqual(parseSiteDateToIso('not-a-date'), null);
    assert.strictEqual(parseSiteDateToIso(null), null);
  });
});

describe('relaxParentBrnGate (DOM effect, simulated page)', () => {
  it('clears required on the four parent fields and deletes only their validator rules', async () => {
    const elements = {};
    const mk = () => ({
      required: true, removed: false,
      removeAttribute() { this.required = false; this.removed = true; },
    });
    ['fatherBrn', 'motherBrn', 'fatherBirthDate', 'motherBirthDate'].forEach((id) => { elements[id] = mk(); });
    const rules = {
      'personInfoForBirth.father.ubrn': { required: true },
      'personInfoForBirth.mother.personBirthDate': { required: true },
      'personInfoForBirth.personLastNameBn': { required: true },
    };
    const chain = { removeClass: () => chain, closest: () => ({ find: () => ({ remove: () => {} }) }), data: () => ({ settings: { rules } }) };
    const $fn = () => chain;
    $fn.validator = true;
    const fake = {
      evaluate: async (fn, arg) => {
        const prevWin = global.window;
        const prevDoc = global.document;
        global.window = { jQuery: $fn };
        global.document = { querySelector: (sel) => {
          const m = sel.match(/^#(\w+)$/);
          return m ? (elements[m[1]] || null) : null;
        } };
        try { return fn(arg); } finally { global.window = prevWin; global.document = prevDoc; }
      },
    };
    const res = await relaxParentBrnGate(fake);
    assert.strictEqual(res, 'ok');
    for (const id of Object.keys(elements)) {
      assert.strictEqual(elements[id].required, false, `${id} must no longer be required`);
      assert.strictEqual(elements[id].removed, true, `${id} required attribute must be removed`);
    }
    assert.ok(!('required' in rules['personInfoForBirth.father.ubrn']), 'father.ubrn rule must lose required');
    assert.ok(!('required' in rules['personInfoForBirth.mother.personBirthDate']), 'mother.personBirthDate rule must lose required');
    assert.strictEqual(rules['personInfoForBirth.personLastNameBn'].required, true, 'single-name rule must be untouched');
  });
  it('_relaxParentBrnGate skips non-exempt and missing DOB', async () => {
    const h = new StepHandler({ page: fakePage() }, { emit: () => {} });
    h.applicantDob = '2014-01-01';
    assert.strictEqual(await h._relaxParentBrnGate(), 'skip');
    h.applicantDob = null;
    assert.strictEqual(await h._relaxParentBrnGate(), 'skip');
    h.applicantDob = '2013-06-15';
    assert.strictEqual(await h._relaxParentBrnGate(), 'ok');
  });
});

describe('submitS2 2013 gate', () => {
  it('site ubrn/dob block for 2013 is relaxed and retried, advance claimed only on fields gone', async () => {
    const h = baseHandler('');
    let relaxCalls = 0;
    h._relaxParentBrnGate = async () => { relaxCalls += 1; return 'ok'; };
    h._waitVisible = waitStub();
    // Three detect calls: initial block, the existing stale re-check
    // (still blocked — this is a persistent site gate, not stale
    // text), then clear after the relax retry.
    const blocks = [
      { blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn] | Click to select your birth date [personInfoForBirth.father.personBirthDate]' },
      { blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn] | Click to select your birth date [personInfoForBirth.father.personBirthDate]' },
      { blocked: false },
    ];
    h._detectValidationBlock = async () => blocks.shift() || { blocked: false };
    const out = await h.submitS2(parentsNoBrnNoDob('2013-07-11'));
    assert.strictEqual(out.ok, true, 'site advanced after relax retry');
    assert.strictEqual(out.brnNote, PARENT_BRN_2013_NOTE);
    assert.deepStrictEqual(out.verifyStatus, { father: 'skipped-2013', mother: 'skipped-2013' });
    assert.ok(relaxCalls >= 2, `pre-fill relax + retry relax expected, got ${relaxCalls}`);
  });
  it('still blocked after relax returns the site text exactly, no advance claimed', async () => {
    const h = baseHandler('');
    h._relaxParentBrnGate = async () => 'ok';
    h._waitVisible = waitStub();
    h._parentsFieldsGone = async () => false;
    h._detectValidationBlock = async () => ({ blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn]' });
    const out = await h.submitS2(parentsNoBrnNoDob('2013-07-11'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /father\.ubrn/);
  });
  it('non-exempt 2014 ubrn block is NOT relaxed', async () => {
    const h = baseHandler('');
    let relaxCalls = 0;
    h._relaxParentBrnGate = async () => { relaxCalls += 1; return 'ok'; };
    h._clickVerify = async () => ({ verified: true });
    h._waitVisible = async () => null;
    h._detectValidationBlock = async () => ({ blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — অনুগ্রহ করে ঘরটি পূরণ করুন! [personInfoForBirth.father.ubrn]' });
    const out = await h.submitS2({
      applicantDob: '2014-01-01',
      father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567' },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(relaxCalls, 0, '2014 must never be gate-relaxed');
  });
  it('site-held DOB in a different bracket than the draft blocks honestly (DOB race guard)', async () => {
    const h = baseHandler('15/06/2020');
    let typed = 0;
    h._typeInto = async () => { typed += 1; return { ok: true }; };
    const out = await h.submitS2(parentsNoBrnNoDob('2013-07-11'));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.applicantDobMismatch, true);
    assert.strictEqual(typed, 0, 'no parent field may be filled under a mismatched exemption');
    assert.match(out.reason, /মিলছে না/);
  });
  it('site-held DOB in the same bracket proceeds (no false race block)', async () => {
    const h = baseHandler('11/07/2013');
    h._relaxParentBrnGate = async () => 'ok';
    h._waitVisible = waitStub();
    h._detectValidationBlock = async () => ({ blocked: false });
    const out = await h.submitS2(parentsNoBrnNoDob('2013-07-11'));
    assert.strictEqual(out.ok, true);
  });
});

describe('direct path for 2013: nothing invented', () => {
  it('exempt payload keeps ubrn and ungiven parent DOB empty, names verbatim', () => {
    const addr = { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' };
    const p = buildSubmitPayload({
      birthPlace: addr,
      s1: { firstNameBn: 'ক', firstNameEn: 'K', dob: '2013-07-11', thChild: '1', gender: 'মহিলা' },
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
    assert.strictEqual(p['personInfoForBirth.father.personBirthDate'], '', 'ungiven parent DOB must stay empty, never a placeholder');
    assert.strictEqual(p['personInfoForBirth.mother.personBirthDate'], '');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'পিতা');
    assert.strictEqual(isParentBrnExempt('2013-07-11'), true);
  });
});
