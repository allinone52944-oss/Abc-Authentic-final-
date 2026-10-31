/**
 * Parent-BRN non-blocking arrangement (2026-10-29, permanent) — mock only.
 * Implements the approved investigation proposal, point by point:
 *  1. Intake normalisation (Bengali digits → Arabic, spaces/dashes
 *     stripped) with a WARNING for non-17 values, never a block;
 *     paste no longer silently drops a non-17 parent number.
 *  2. Verify never blocks alone: a Verify false no longer lands in
 *     failed[], and the not-advanced reason is never verify-derived
 *     — it is the fresh site error, or an honest "no fresh error".
 *     A stale validation text is re-checked after a settle.
 *     SUPERSEDED 2026-10-31 (parent-verify cycle, branch
 *     fix-bdris-parentverify @ 65b468f): where a parent BRN is
 *     required and verification is attempted, a mismatch /
 *     missing control / inconclusive wait IS an honest failure with
 *     a per-parent failed entry + verbatim reason, and the path
 *     stops — the user-reported "যাচাই বাকি forever" bug was this
 *     rule letting an unverified BRN through silently. The
 *     not-advanced tail reason and the point-7 replay exception
 *     (advance proven by gone fields) are unchanged.
 *     RESTORED 2026-10-31 (adjustment on the same branch): the
 *     blocking semantics above were REVERSED — they made OUR
 *     engine add a block the site did not impose, contradicting
 *     this standing rule (own site adds no blocking validation;
 *     easy submission, then the officer verifies). What survives
 *     from the branch: the REAL verify attempt (control search,
 *     refill-once + re-attempt-once, 15s wait) and the honest
 *     badge (verifyStatus false + verbatim verifyReason) — only
 *     the failed entry is gone, so the site's own Next gate is
 *     again the only authority on advance.
 *  3. On Verify false the landed BRN/DOB are re-read (presence
 *     only, never values) and refilled once when a field is empty.
 *  4. Pre-2013 keeps clearing the site BRN field (site rule) but
 *     says so (progress + brnNote); a missing applicant DOB no
 *     longer silently defaults to post-2013.
 *  5. A family/180-days site error gets one names-only attempt
 *     (BRN fields cleared, names untouched) with a visible note.
 *  6. Direct path mirrors the bot rules: digit normalisation +
 *     pre-2013 ubrn clearing + submit-rejection wording with the
 *     field name. No direct BRN-verify call is invented.
 *  7. Replay does not re-block on Verify uncertainty alone when
 *     the site actually advanced past the parents step.
 *  8. Submit-time parent-BRN error decision (pure): pre-2013 /
 *     family → names-only attempt, anything else → surface only.
 *  9. Never: no BRN/DOB invented, substituted, or altered in the
 *     final record; no rejected submit resent to force it; parent
 *     NAMES go exactly as given (verbatim on the direct path, and
 *     this build adds no name-altering step anywhere).
 * No live contact, no browser, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/parentbrn-nonblock.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  StepHandler, normalizeBrn, brnWarning, isFamilyErrorText,
  parentBrnSubmitAction, isParentBrnExempt, parentBrnExemptNote,
  PARENT_BRN_PRE2013_NOTE, PARENT_BRN_2013_NOTE, PARENT_BRN_FAMILY_NOTE,
} = require('../services/StepHandler');
const {
  buildSubmitPayload, parentBrnDirectDecision, normalizeDirectBrn,
  isParentBrnExemptDirect, submitRejectionWording, submitRejectionField,
} = require('../http/client');

const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in bdris-apply.html`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function loadFrontendBrnHelpers() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${extractFn('normalizeBrnField')}\n${extractFn('brnFieldWarning')}`, ctx);
  return ctx;
}

function fakePage() {
  return {
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      // _readParentLanded passes {brn, dob} selector lists; the
      // Step-3 diagnostic passes no arg. Presence only, no values.
      if (arg && Array.isArray(arg.brn)) return { brn: '', dob: '' };
      return { fBn: '', fEn: '', mBn: '', mEn: '' };
    },
  };
}

function baseHandler() {
  const h = new StepHandler({ page: fakePage() }, { emit: () => {} });
  h._typeInto = async () => ({ ok: true });
  h._typeMaskedDate = async () => ({ ok: true });
  h._selectFirstMatch = async () => ({ ok: true });
  h._clickVerify = async () => ({ verified: true });
  h._clickNextAndWait = async () => ({ ok: true });
  h._dismissNotices = async () => false;
  return h;
}

const parentArgs = (dob) => ({
  applicantDob: dob,
  father: { nameBn: 'পিতা', nameEn: 'Father', brn: '১২৩৪৫৬৭৮৯০১২৩৪৫৬৭', dob: '1980-01-01' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567', dob: '1982-01-01' },
});

describe('point 1+3: bot BRN normalisation and Verify-false handling', () => {
  it('normalizeBrn converts Bengali digits and strips spaces/dashes', () => {
    assert.strictEqual(normalizeBrn('১২৩৪ ৫৬৭৮-৯০১২৩৪৫৬৭'), '12345678901234567');
    assert.strictEqual(normalizeBrn(''), '');
  });
  it('brnWarning is empty for empty/17-digit, warning otherwise', () => {
    assert.strictEqual(brnWarning(''), '');
    assert.strictEqual(brnWarning('12345678901234567'), '');
    assert.match(brnWarning('123'), /১৭ ডিজিট/);
  });
  it('Verify false pushes no failed entry and the tail reason is not verify-derived (point 2, restored 2026-10-31)', async () => {
    const h = baseHandler();
    const typed = [];
    h._typeInto = async (sels, value, label) => { typed.push(label); return { ok: true }; };
    h._clickVerify = async () => ({ verified: false, reason: 'No birth record found' });
    h._detectValidationBlock = async () => ({ blocked: false });
    h._waitVisible = async () => ({ fill: async () => {}, isVisible: async () => true });
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, false, 'site never advanced, so still honest failure');
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.verifyUncertain, true);
    assert.ok(!(out.failed || []).some((f) => /BRN যাচাই/.test(f.field || '')), 'Verify must not land in failed[]');
    assert.ok(!/verify হয়নি/.test(out.reason), `reason must not be verify-derived: ${out.reason}`);
    assert.match(out.reason, /নতুন কোনো ভুল-বার্তা পাওয়া যায়নি/);
    // The branch's honest badge survives the restore: the attempt
    // was made, so the status is false (never null) and the site's
    // verbatim reason travels for the badge — only the block is gone.
    assert.strictEqual(out.verifyStatus.father, false);
    assert.strictEqual(out.verifyStatus.mother, false);
    assert.strictEqual(out.verifyReason.father, 'No birth record found');
    assert.strictEqual(out.verifyReason.mother, 'No birth record found');
    assert.strictEqual(typed.filter((l) => /BRN/.test(l)).length, 4, 'initial BRN fill + one refill per parent');
  });
});

describe('point 4: pre-2013 rule kept, silence removed, DOB guard', () => {
  it('missing applicant DOB surfaces a DOB reason instead of defaulting to post-2013', async () => {
    const h = baseHandler();
    const out = await h.submitS2({ father: { nameBn: 'পিতা', nameEn: 'Father' }, mother: { nameBn: 'মাতা', nameEn: 'Mother' } });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.applicantDobMissing, true);
    assert.match(out.reason, /জন্ম তারিখ পাওয়া যায়নি/);
  });
  it('pre-2013 advances with the withholding note, BRN cleared on the site form only', async () => {
    const h = baseHandler();
    const cleared = [];
    let waitCalls = 0;
    h._waitVisible = async (sels) => {
      // STEP-PROOF (A1): address calls answer present without
      // consuming the parent-field call count.
      const _list = Array.isArray(sels) ? sels : [sels];
      if (_list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))) return { fill: async () => {} };
      waitCalls += 1;
      // First two calls: the pre-2013 BRN clears (father, mother).
      // Later calls: the advanced check — fields are gone.
      return waitCalls <= 2 ? { fill: async (v) => { cleared.push(v); } } : null;
    };
    h._detectValidationBlock = async () => ({ blocked: false });
    const out = await h.submitS2({ applicantDob: '2010-05-01', father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567' }, mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '12345678901234567' } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, PARENT_BRN_PRE2013_NOTE);
    assert.deepStrictEqual(cleared, ['', '']);
  });
});

describe('2013 rule: ID cards only, no parent BRN, names exact', () => {
  it('a 2013 application advances with no parent BRN at all: no Verify, no required-field block', async () => {
    const h = baseHandler();
    let waitCalls = 0;
    h._waitVisible = async (sels) => {
      // STEP-PROOF (A1): address calls answer present without
      // consuming the parent-field call count.
      const _list = Array.isArray(sels) ? sels : [sels];
      if (_list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))) return { fill: async () => {} };
      waitCalls += 1;
      return waitCalls <= 2 ? { fill: async () => {} } : null;
    };
    h._detectValidationBlock = async () => ({ blocked: false });
    h._clickVerify = async () => { throw new Error('Verify must never run for an exempt year'); };
    const out = await h.submitS2({
      applicantDob: '2013-06-15',
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, PARENT_BRN_2013_NOTE);
    assert.deepStrictEqual(out.verifyStatus, { father: 'skipped-2013', mother: 'skipped-2013' });
  });
  it('a 2013 application with BRNs given still clears the site BRN fields and keeps names exact', async () => {
    const h = baseHandler();
    const cleared = [];
    let waitCalls = 0;
    h._waitVisible = async (sels) => {
      // STEP-PROOF (A1): address calls answer present without
      // consuming the parent-field call count.
      const _list = Array.isArray(sels) ? sels : [sels];
      if (_list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))) return { fill: async () => {} };
      waitCalls += 1;
      return waitCalls <= 2 ? { fill: async (v) => { cleared.push(v); } } : null;
    };
    h._detectValidationBlock = async () => ({ blocked: false });
    h._clickVerify = async () => { throw new Error('Verify must never run for an exempt year'); };
    const out = await h.submitS2(parentArgs('2013-06-15'));
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(cleared, ['', '']);
    assert.strictEqual(out.brnNote, PARENT_BRN_2013_NOTE);
  });
  it('2014 still requires the BRN path (exemption ends at 2013)', async () => {
    const h = baseHandler();
    h._clickVerify = async () => ({ verified: true });
    h._detectValidationBlock = async () => ({ blocked: false });
    h._waitVisible = async (sels) => {
      const _list = Array.isArray(sels) ? sels : [sels];
      // STEP-PROOF (A1): a real advanced page HAS address anchors.
      return _list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))
        ? { fill: async () => {} } : null;
    };
    const out = await h.submitS2(parentArgs('2014-01-01'));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, null);
  });
});

describe('point 2+5: stale re-check and family branch', () => {
  it('a stale validation text is re-checked and does not block when it clears', async () => {
    const h = baseHandler();
    let calls = 0;
    h._detectValidationBlock = async () => {
      calls += 1;
      return calls === 1 ? { blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — পুরনো ভুল' } : { blocked: false };
    };
    h._waitVisible = async (sels) => {
      const _list = Array.isArray(sels) ? sels : [sels];
      // STEP-PROOF (A1): a real advanced page HAS address anchors.
      return _list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))
        ? { fill: async () => {} } : null;
    }; // parents fields gone = advanced
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(calls, 2, 'exactly one settle re-check');
  });
  it('a 180-days error gets one names-only attempt and the family note on success', async () => {
    const h = baseHandler();
    assert.ok(isFamilyErrorText('Difference of age among children needs to be at least 180 days'));
    assert.ok(!isFamilyErrorText('some other site error'));
    let detectCalls = 0;
    h._detectValidationBlock = async () => {
      detectCalls += 1;
      // 1: first Next, 2: settle re-check (still family), 3: after
      // the names-only Next — cleared.
      return detectCalls <= 2
        ? { blocked: true, reason: 'সাইট এগোতে দিচ্ছে না — Difference of age among children needs to be at least 180 days' }
        : { blocked: false };
    };
    let waitCalls = 0;
    h._waitVisible = async (sels) => {
      // STEP-PROOF (A1): address calls answer present without
      // consuming the parent-field call count.
      const _list = Array.isArray(sels) ? sels : [sels];
      if (_list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))) return { fill: async () => {} };
      waitCalls += 1;
      return waitCalls <= 2 ? { fill: async () => {} } : null;
    };
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, PARENT_BRN_FAMILY_NOTE);
    assert.strictEqual(detectCalls, 3);
  });
});

describe('point 7: replay does not re-block on Verify uncertainty alone', () => {
  it('continues when the site advanced past parents despite a verify-uncertain S2 failure', async () => {
    const h = baseHandler();
    h.submitS2 = async () => ({ ok: false, blocked: true, verifyUncertain: true, message: 'replay S2 uncertain' });
    h.submitS2B = async () => ({ ok: true });
    h.submitS3 = async () => ({ ok: true });
    h._waitVisible = async (sels) => {
      const _list = Array.isArray(sels) ? sels : [sels];
      // STEP-PROOF (A1): a real advanced page HAS address anchors.
      return _list.some((s) => String(s).includes('permAddr') || String(s).includes('prsntAddr'))
        ? { fill: async () => {} } : null;
    }; // parents fields gone
    const out = await h._replayToContact(3, { s2: {}, s1: { dob: '2020-01-01' } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.replayed, 'catch-up');
  });
  it('still fails when the parents fields are still on the page', async () => {
    const h = baseHandler();
    h.submitS2 = async () => ({ ok: false, blocked: true, verifyUncertain: true, message: 'replay S2 uncertain' });
    h._waitVisible = async () => ({ fill: async () => {} });
    const out = await h._replayToContact(3, { s2: {}, s1: { dob: '2020-01-01' } });
    assert.strictEqual(out.ok, false);
  });
});

describe('point 8: submit-time parent-BRN decision (pure)', () => {
  it('exempt-year ubrn error → names-only; family error → names-only; other ubrn error → surface only; no hit → null', () => {
    assert.strictEqual(parentBrnSubmitAction(['not verified [father.ubrn]'], '2010-01-01'), 'brn-exempt-names-only');
    assert.strictEqual(parentBrnSubmitAction(['not verified [father.ubrn]'], '2013-06-15'), 'brn-exempt-names-only');
    assert.strictEqual(parentBrnExemptNote('2010-01-01'), PARENT_BRN_PRE2013_NOTE);
    assert.strictEqual(parentBrnExemptNote('2013-06-15'), PARENT_BRN_2013_NOTE);
    assert.strictEqual(parentBrnExemptNote('2014-01-01'), null);
    assert.strictEqual(isParentBrnExempt('2012-12-31'), true);
    assert.strictEqual(isParentBrnExempt('2013-01-01'), true);
    assert.strictEqual(isParentBrnExempt('2013-12-31'), true);
    assert.strictEqual(isParentBrnExempt('2014-01-01'), false);
    assert.strictEqual(isParentBrnExempt(''), false);
    assert.strictEqual(parentBrnSubmitAction(['Difference of age among children needs to be at least 180 days'], '2020-01-01'), 'family-names-only');
    assert.strictEqual(parentBrnSubmitAction(['not verified [father.ubrn]'], '2020-01-01'), 'surface-only');
    assert.strictEqual(parentBrnSubmitAction(['random site error'], '2020-01-01'), null);
    assert.strictEqual(parentBrnSubmitAction([], '2020-01-01'), null);
  });
});

describe('point 6: direct path mirrors the bot rules', () => {
  const addr = { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' };
  const base = (dob, fbrn) => ({
    birthPlace: addr,
    s1: { firstNameBn: 'ক', firstNameEn: 'K', dob, thChild: '1', gender: 'পুরুষ' },
    s2: {
      father: { nameBn: 'পিতা', nameEn: 'Father', brn: fbrn },
      mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '98765432109876543' },
    },
    relation: 'SELF', phone: '01', otp: '123456',
    documents: [{ attachmentType: 40, id: 1 }, { attachmentType: 41, id: 2 }],
    s2b: { perm: addr, pres: addr },
  });
  it('post-2013: Bengali-digit BRN normalised, names verbatim', () => {
    const p = buildSubmitPayload(base('2020-01-01', '১২৩৪ ৫৬৭৮-৯০১২৩৪৫৬৭'));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '12345678901234567');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'পিতা');
    assert.strictEqual(p['personInfoForBirth.mother.personNameEn'], 'Mother');
  });
  it('2013: ubrn cleared in the payload, decision reports the ID-card-only rule', () => {
    const p = buildSubmitPayload(base('2013-06-15', '12345678901234567'));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'পিতা', 'parent names go exactly as given');
    const d = parentBrnDirectDecision({ s1: { dob: '2013-06-15' }, s2: { father: { brn: '123' } } });
    assert.strictEqual(d.brnExempt, true);
    assert.strictEqual(d.withheldBySiteRule, true);
    assert.match(d.note, /২০১৩ সালের নিয়ম/);
    assert.strictEqual(isParentBrnExemptDirect('2013-12-31'), true);
    assert.strictEqual(isParentBrnExemptDirect('2014-01-01'), false);
  });
  it('pre-2013: ubrn cleared in the payload, decision reports the withholding', () => {
    const p = buildSubmitPayload(base('2010-01-01', '12345678901234567'));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
    const d = parentBrnDirectDecision({ s1: { dob: '2010-01-01' }, s2: { father: { brn: '123' } } });
    assert.strictEqual(d.withheldBySiteRule, true);
    assert.match(d.note, /২০১৩-পূর্ব/);
  });
  it('submit rejection wording carries message + field name, never a value', () => {
    assert.strictEqual(
      submitRejectionWording({ text: 'father.ubrn not verified', json: { code: 'VALIDATION_FAILED', message: 'Father ubrn not verified' } }),
      'Father ubrn not verified [field: father.ubrn]',
    );
    assert.strictEqual(submitRejectionField({ text: 'mother.ubrn missing', json: null }), 'mother.ubrn');
    assert.strictEqual(submitRejectionWording({ text: 'plain', json: null }), '');
    assert.strictEqual(normalizeDirectBrn('১২৩৪-৫৬৭৮'), '12345678');
  });
});

describe('point 1+4 (frontend): intake helpers and call sites', () => {
  it('frontend 2013 exemption: helper boundary + Step-3/auto paths use it, 2013 badge exists', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(extractFn('isParentBrnExemptClient'), ctx);
    assert.strictEqual(ctx.isParentBrnExemptClient('2012-12-31'), true);
    assert.strictEqual(ctx.isParentBrnExemptClient('2013-06-15'), true);
    assert.strictEqual(ctx.isParentBrnExemptClient('2014-01-01'), false);
    assert.match(html, /const brnExempt = isParentBrnExemptClient\(S\.d\.s1\.dob\);/);
    assert.match(html, /const brnExempt = isParentBrnExemptClient\(s1\.dob\);/);
    assert.match(html, /skipped-2013/);
    assert.match(html, /২০১৩ সাল — BRN প্রয়োজন নেই/);
  });
  it('frontend normalizeBrnField / brnFieldWarning behave like the bot helpers', () => {
    const ctx = loadFrontendBrnHelpers();
    assert.strictEqual(ctx.normalizeBrnField('১২৩৪ ৫৬৭৮-৯০১২৩৪৫৬৭'), '12345678901234567');
    assert.strictEqual(ctx.brnFieldWarning(''), '');
    assert.strictEqual(ctx.brnFieldWarning('12345678901234567'), '');
    assert.match(ctx.brnFieldWarning('123'), /১৭ ডিজিট/);
  });
  it('readPerson/readPersonAuto normalise BRN; Step-3 and auto paths warn without blocking; paste keeps non-17; ack shows brnNote', () => {
    assert.match(html, /brn: normalizeBrnField\(\$\(p \+ '_brn'\)\.value \|\| ''\)/);
    assert.match(html, /const brnWarn = parentBrnWarnings\(\);/);
    assert.match(html, /const brnWarnAuto = parentBrnWarnings\(\);/);
    assert.match(html, /if \(state === 'father' \|\| state === 'mother'\) \{ \(state === 'father' \? f : m\)\.brn = dd; n\+\+; if \(dd\.length !== 17\) brnWarn = true; \}/);
    assert.match(html, /brnWarn: brnWarn/);
    assert.match(html, /if \(d\.brnNote\) note\(d\.brnNote, 'warn'\);/);
  });
});
