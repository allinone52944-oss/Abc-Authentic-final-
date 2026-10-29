/**
 * Family/180-days ADVANCE (2026-10-29 follow-up, permanent) — mock only.
 * The parent-BRN build gave the family case ONE names-only attempt
 * that could still block: (a) a leftover family text on an already
 * advanced page, (b) a names-only Next whose wait failed though the
 * site advanced, (c) a BRN clear nobody verified, (d) no family
 * branch at all on the direct path, (e) a replay / later step that
 * re-filled the BRN that already triggered the family error.
 * This build closes those five gaps. Advance is claimed ONLY on
 * the fields-gone proof (bot) or a verified success shape (direct).
 * Never: no BRN/DOB/name invented, substituted, or altered; no
 * rejected submit resent to force it; no QR / single-name / cinno
 * logic touched. No live contact, no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/family180-advance.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const {
  StepHandler, isFamilyErrorText, PARENT_BRN_FAMILY_NOTE,
} = require('../services/StepHandler');
const {
  buildSubmitPayload, parentBrnDirectDecision, submitRejectionWording,
  isFamilyRejectionText, DIRECT_FAMILY_NOTE,
} = require('../http/client');
const { runHttpChain } = require('../services/HttpPathRunner');

const FAMILY = 'Difference of age among children needs to be at least 180 days';

function fakePage(landedBrn = '') {
  return {
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (arg && Array.isArray(arg.brn)) return { brn: landedBrn, dob: '' };
      return { fBn: '', fEn: '', mBn: '', mEn: '' };
    },
  };
}

function baseHandler(landedBrn = '') {
  const h = new StepHandler({ page: fakePage(landedBrn) }, { emit: () => {} });
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
  father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567', dob: '1980-01-01' },
  mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '98765432109876543', dob: '1982-01-01' },
});

const addr = { division: 'd', district: 'd', cityCorpUpazila: 'u', postBn: 'p', postEn: 'p', villageBn: 'v', villageEn: 'v' };
const directBase = (overrides = {}) => ({
  birthPlace: addr,
  s1: { firstNameBn: 'ক', firstNameEn: 'K', dob: '2020-01-01', thChild: '1', gender: 'পুরুষ' },
  s2: {
    father: { nameBn: 'পিতা', nameEn: 'Father', brn: '12345678901234567' },
    mother: { nameBn: 'মাতা', nameEn: 'Mother', brn: '98765432109876543' },
  },
  relation: 'SELF', phone: '01', otp: '123456',
  documents: [{ attachmentType: 40, id: 1 }, { attachmentType: 41, id: 2 }],
  s2b: { perm: addr, pres: addr },
  ...overrides,
});

function validChargeToken(userId, secret, ref = 'ref-1') {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

function runnerData() {
  return {
    person: { dob: '2020-01-15', brn: '' },
    birthPlace: { wardId: '7193', paurasavaUnionId: '1988' },
    permAddr: { paurasavaUnionId: '1988' },
    relation: 'SELF', applicantName: 'Test', phone: '01000000000',
    officeAddressType: 'PERMANENT',
    documents: [
      { attachmentType: 40, attachmentTypeId: 40, url: '/admin/doc/40', id: 40 },
      { attachmentType: 41, attachmentTypeId: 41, url: '/admin/doc/41', id: 41 },
    ],
    otp: '123456',
    _chargeToken: validChargeToken('user-1', 'test-secret', 'ref-family'),
  };
}

describe('bot: family advance on an already-advanced page', () => {
  it('leftover family text does NOT block when parents fields are gone', async () => {
    const h = baseHandler();
    // Every validation read still shows the family text (stale),
    // but the parents fields are gone — the site already advanced.
    h._detectValidationBlock = async () => ({ blocked: true, reason: FAMILY });
    const goneQueue = [false, true]; // entry: still there; after names-only Next: gone
    h._parentsFieldsGone = async () => goneQueue.shift();
    h._waitVisible = async () => null; // tail: fields gone = advanced
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, PARENT_BRN_FAMILY_NOTE);
    assert.strictEqual(out.familyNamesOnly, true);
  });

  it('names-only Next wait failure does NOT block when fields are gone', async () => {
    const h = baseHandler();
    let detectCalls = 0;
    h._detectValidationBlock = async () => {
      detectCalls += 1;
      return detectCalls <= 2 ? { blocked: true, reason: FAMILY } : { blocked: true, reason: FAMILY };
    };
    const goneQueue = [false, true];
    h._parentsFieldsGone = async () => goneQueue.shift();
    let nextCalls = 0;
    h._clickNextAndWait = async () => {
      nextCalls += 1;
      // First Next ok; names-only Next reports failure though the
      // site moved on (fields gone on the _parentsFieldsGone check).
      return nextCalls === 1 ? { ok: true } : { ok: false, field: 'পরবর্তী', reason: 'বাটন সক্রিয় হয়নি' };
    };
    h._waitVisible = async () => null;
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.brnNote, PARENT_BRN_FAMILY_NOTE);
  });

  it('family error that truly persists is an honest failure, no family note', async () => {
    const h = baseHandler();
    h._detectValidationBlock = async () => ({ blocked: true, reason: FAMILY });
    h._parentsFieldsGone = async () => false; // fields still there
    h._waitVisible = async () => ({ fill: async () => {} }); // fields present
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /180 days/);
    assert.strictEqual(out.brnNote, null, 'no advance note without advance');
  });
});

describe('bot: clear verification and seeded replay', () => {
  it('_clearParentBrnFields reports false when a BRN field stays filled', async () => {
    const h = baseHandler('12345678901234567'); // landed BRN stays present
    h._waitVisible = async () => ({ fill: async () => {} });
    assert.strictEqual(await h._clearParentBrnFields(), false);
  });

  it('_clearParentBrnFields reports true when fields are empty', async () => {
    const h = baseHandler('');
    h._waitVisible = async () => ({ fill: async () => {} });
    assert.strictEqual(await h._clearParentBrnFields(), true);
  });

  it('a seeded familyNamesOnly run never fills a BRN and never calls Verify', async () => {
    const h = new StepHandler({ page: fakePage('') }, { emit: () => {}, familyNamesOnly: true });
    const typed = [];
    h._typeInto = async (sels, value, label) => { typed.push(label); return { ok: true }; };
    h._typeMaskedDate = async () => ({ ok: true });
    h._selectFirstMatch = async () => ({ ok: true });
    h._clickVerify = async () => { throw new Error('Verify must not run names-only'); };
    h._clickNextAndWait = async () => ({ ok: true });
    h._detectValidationBlock = async () => ({ blocked: false });
    h._waitVisible = async () => null;
    h._dismissNotices = async () => false;
    const out = await h.submitS2(parentArgs('2020-01-01'));
    assert.strictEqual(out.ok, true);
    assert.ok(!typed.some((l) => /BRN/.test(l)), 'no BRN field filled');
    assert.strictEqual(out.brnNote, PARENT_BRN_FAMILY_NOTE);
    assert.strictEqual(out.familyNamesOnly, true);
  });
});

describe('direct: family flag, marker, and submit retry', () => {
  it('family flag clears ubrn in the payload, names verbatim, family note', () => {
    const p = buildSubmitPayload(directBase({ _familyNamesOnly: true }));
    assert.strictEqual(p['personInfoForBirth.father.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.mother.ubrn'], '');
    assert.strictEqual(p['personInfoForBirth.father.personNameBn'], 'পিতা');
    assert.strictEqual(p['personInfoForBirth.mother.personNameEn'], 'Mother');
    const d = parentBrnDirectDecision({ s1: { dob: '2020-01-01' }, s2: { father: { brn: '123' } }, _familyNamesOnly: true });
    assert.strictEqual(d.familyNamesOnly, true);
    assert.strictEqual(d.withheldBySiteRule, true);
    assert.strictEqual(d.note, DIRECT_FAMILY_NOTE);
  });

  it('family wording in a rejection body carries the marker; other text does not', () => {
    assert.ok(isFamilyRejectionText(FAMILY));
    assert.ok(!isFamilyRejectionText('some other error'));
    assert.match(
      submitRejectionWording({ text: FAMILY, json: null }),
      /\[family: 180-days\]/,
    );
    assert.ok(!/family: 180-days/.test(submitRejectionWording({ text: 'plain', json: null })));
  });

  it('runner retries a family-coded submit rejection once, names-only', async () => {
    const seen = [];
    const familyErr = new Error('Submit returned status 400: [family: 180-days].');
    familyErr.code = 'SUBMIT_BAD_RESPONSE';
    const fakeClient = {
      bootstrapped: true,
      otpSend: async () => ({ code: 'MESSAGE_SENT', success: true, payload: null }),
      verifyOtp: async () => ({ isVerified: true }),
      submitApplication: async (input) => {
        seen.push(input);
        if (seen.length === 1) throw familyErr;
        return { hasPrintLink: false };
      },
    };
    const out = await runHttpChain({
      data: runnerData(), userId: 'user-1', secret: 'test-secret',
      client: fakeClient, log: () => {},
    });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1]._familyNamesOnly, true);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.familyNamesOnly, true);
    assert.strictEqual(out.familyNote, DIRECT_FAMILY_NOTE);
  });

  it('runner does NOT retry an unknown-outcome submit failure', async () => {
    let calls = 0;
    const fakeClient = {
      bootstrapped: true,
      otpSend: async () => ({ code: 'MESSAGE_SENT', success: true, payload: null }),
      verifyOtp: async () => ({ isVerified: true }),
      submitApplication: async () => { calls += 1; throw new Error('socket timeout'); },
    };
    const out = await runHttpChain({
      data: runnerData(), userId: 'user-1', secret: 'test-secret',
      client: fakeClient, log: () => {},
    });
    assert.strictEqual(calls, 1, 'unknown outcome is never retried');
    assert.strictEqual(out.ok, false);
  });

  it('runner does NOT retry a non-family coded submit rejection', async () => {
    let calls = 0;
    const fakeClient = {
      bootstrapped: true,
      otpSend: async () => ({ code: 'MESSAGE_SENT', success: true, payload: null }),
      verifyOtp: async () => ({ isVerified: true }),
      submitApplication: async () => {
        calls += 1;
        const e = new Error('Submit returned status 400: something else.');
        e.code = 'SUBMIT_BAD_RESPONSE';
        throw e;
      },
    };
    const out = await runHttpChain({
      data: runnerData(), userId: 'user-1', secret: 'test-secret',
      client: fakeClient, log: () => {},
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(out.ok, false);
  });
});
