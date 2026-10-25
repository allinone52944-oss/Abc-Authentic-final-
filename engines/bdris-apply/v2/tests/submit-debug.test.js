/**
 * Submit-debug (2026-10-26, on top of d31fdbf) — mock only.
 * Bugs fixed up to SUBMIT (S0 -> S4_OTP), each proven from code:
 * 1. S1 without a birth address returned ok:true without filling
 *    the address or clicking Next (UI advanced, site did not).
 * 2. S2 pre-2013 returned ok:true even when the site never
 *    advanced past the parents step.
 * 3. S4 accepted 7+ digit OTP input into a 6-digit field.
 * 4. The SUBMIT success gate accepted any 7-12 digit number on the
 *    page as an application number (extractAckNumber).
 * 5. A ctx-only S0 call (resume/replay) lost a PERMANENT basis
 *    because submitS0 read only flat fields.
 * No live contact, no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/submit-debug.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { StepHandler, extractAckNumber } = require('../services/StepHandler');

describe('extractAckNumber (SUBMIT success gate)', () => {
  it('accepts a labelled number and a 17-digit number', () => {
    assert.strictEqual(extractAckNumber('আবেদনপত্র নম্বর : 265370215'), '265370215');
    assert.strictEqual(extractAckNumber('ref 12345678901234567 done'), '12345678901234567');
  });
  it('rejects a bare 7-12 digit number (phone fragment / code, not an ack)', () => {
    assert.strictEqual(extractAckNumber('কোড 1234567 পাঠানো হয়েছে'), '');
    assert.strictEqual(extractAckNumber('মোবাইল 01712345678'), '');
    assert.strictEqual(extractAckNumber('কিছুই নেই'), '');
  });
});

describe('submitS4 OTP length', () => {
  it('rejects 7-digit input before touching the page', async () => {
    const secret = 'test-secret-submit-debug';
    const prevAbc = process.env.ABC_JWT_SECRET;
    const prevJwt = process.env.JWT_SECRET;
    process.env.ABC_JWT_SECRET = '';
    process.env.JWT_SECRET = secret;
    try {
      const head = `v1.user-otp.submit.ref-otp7.${Date.now()}`;
      const tok = `${head}.${nodeCrypto.createHmac('sha256', secret).update(head).digest('hex')}`;
      const handler = new StepHandler({ page: {} }, { emit: () => {}, userId: 'user-otp' });
      const out = await handler.submitS4({ otp: '1234567', _chargeToken: tok });
      assert.strictEqual(out.ok, false);
      assert.match(out.message, /৬ ডিজিটের/);
    } finally {
      if (prevAbc === undefined) delete process.env.ABC_JWT_SECRET; else process.env.ABC_JWT_SECRET = prevAbc;
      if (prevJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevJwt;
    }
  });
});

describe('submitS2 not-advanced (pre-2013)', () => {
  it('fails honestly when the site stays on the parents step', async () => {
    const fakePage = {
      waitForTimeout: async () => {},
      evaluate: async () => ({ fBn: '', fEn: '', mBn: '', mEn: '' }),
    };
    const handler = new StepHandler({ page: fakePage }, { emit: () => {} });
    // Parents fields stay visible = site never advanced.
    handler._waitVisible = async () => ({ fill: async () => {}, isVisible: async () => true });
    handler._typeInto = async () => ({ ok: true });
    handler._typeMaskedDate = async () => ({ ok: true });
    handler._selectFirstMatch = async () => ({ ok: true });
    handler._clickNextAndWait = async () => ({ ok: true });
    handler._detectValidationBlock = async () => ({ blocked: false });
    handler._dismissNotices = async () => false;
    const out = await handler.submitS2({
      applicantDob: '2010-05-01',
      father: { nameBn: 'পিতা', nameEn: 'Father' },
      mother: { nameBn: 'মাতা', nameEn: 'Mother' },
    });
    assert.strictEqual(out.ok, false, 'not-advanced must not return ok:true');
    assert.strictEqual(out.step, 3);
    assert.strictEqual(out.blocked, true);
  });
});

describe('submitS1 missing birth address', () => {
  it('fails honestly instead of returning ok:true without Next', async () => {
    const nameValues = {};
    const doc = {
      body: { innerText: '' },
      querySelector: (sel) => {
        for (const part of ['personFirstNameBn', 'personLastNameBn', 'personFirstNameEn', 'personLastNameEn']) {
          if (sel.includes(part)) return { value: nameValues[part] || '' };
        }
        return null;
      },
      querySelectorAll: () => [],
    };
    const page = {
      $: async (sel) => {
        if (/person(First|Last)Name/.test(sel)) {
          const part = sel.match(/person(?:First|Last)Name(?:Bn|En)/)[0];
          return { click: async () => {}, fill: async () => {}, type: async (v) => { nameValues[part] = v; } };
        }
        return null;
      },
      locator: (sel) => ({
        count: async () => (sel.includes('personBirthDate') ? 1 : 0),
        nth: () => ({
          isVisible: async () => true, isEnabled: async () => true,
          click: async () => {}, fill: async (v) => { doc.querySelector = () => ({ value: v }); },
          type: async () => {},
        }),
      }),
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
      evaluate: async (fn, arg) => {
        const prev = global.document;
        global.document = doc;
        try { return typeof fn === 'function' ? fn(arg) : fn; }
        finally { global.document = prev; }
      },
    };
    const handler = new StepHandler({ page, selectOption: async () => true }, { emit: () => {} });
    // No division/district/village at all.
    const out = await handler.submitS1({
      firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim',
      dob: '2020-01-15', gender: 'পুরুষ', thChild: '৩য়',
    });
    assert.strictEqual(out.ok, false, 'missing birth address must not be ok:true');
    assert.ok((out.failed || []).some((f) => /জন্মস্থানের ঠিকানা/.test(f.field || '')));
  });
});

describe('submitS0 ctx basis', () => {
  it('selects PERMANENT from ctx.s0, not the BIRTHPLACE default', async () => {
    const requested = [];
    const handler = new StepHandler({ page: { evaluate: async () => true, waitForTimeout: async () => {} } }, { emit: () => {} });
    handler._waitVisible = async (sels) => {
      requested.push(Array.isArray(sels) ? sels.join(' ') : String(sels));
      return { check: async () => {}, uncheck: async () => {}, click: async () => {} };
    };
    handler._robustClick = async () => true;
    handler._clickNextAndWait = async () => ({ ok: true });
    const out = await handler.submitS0({ s0: { addressType: 'PERMANENT', embassy: false } });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.ok(requested.some((s) => s.includes('officePermanent')), 'must request the PERMANENT radio, got: ' + requested.join(' | '));
  });
});
