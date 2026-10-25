/**
 * A-to-Z continuation (2026-10-26, on top of ce2cd3c) — mock only.
 *
 * 1. Charge gates fail closed + submit tokens are single-use (consumed
 *    only at a clean success point, never on attempt).
 * 2. S1 uses v1's live-verified selectors: applicant DOB via the masked
 *    #personBirthDate field (NOT the invented #personDob), gender via
 *    #gender, thChild filled (frontend-required, previously dropped),
 *    and the attachment-availability modal handled (previously absent).
 *
 * No live contact, no browser, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/a-to-z-fixes.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const {
  StepHandler, verifyChargeToken, thChildSite, consumeSubmitToken, isSubmitTokenConsumed,
} = require('../services/StepHandler');
const { BdrisNavigator } = require('../services/BdrisNavigator');
const { runHttpChain } = require('../services/HttpPathRunner');

function mintToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

describe('thChildSite (v1 mapping)', () => {
  it('maps frontend ordinals to site Bengali digits', () => {
    assert.strictEqual(thChildSite('১ম'), '১');
    assert.strictEqual(thChildSite('৩য়'), '৩');
    assert.strictEqual(thChildSite('১১তম'), '১১');
    assert.strictEqual(thChildSite('3'), '৩');
    assert.strictEqual(thChildSite(''), '');
  });
});

describe('submit token single-use', () => {
  it('consumes once, then reports consumed; expired entries prune', () => {
    const tok = mintToken('user-9', 'test-secret', 'ref-consume-' + Date.now());
    assert.strictEqual(verifyChargeToken(tok, 'user-9', 'submit', 'test-secret'), true);
    assert.strictEqual(isSubmitTokenConsumed(tok), false);
    assert.strictEqual(consumeSubmitToken(tok), true);
    assert.strictEqual(isSubmitTokenConsumed(tok), true);
    assert.strictEqual(consumeSubmitToken(tok), false, 'second consume must fail');
    // Expired token (ts 31 minutes ago) prunes on read.
    const oldHead = `v1.user-9.submit.ref-old.${Date.now() - 31 * 60 * 1000}`;
    const oldTok = `${oldHead}.${nodeCrypto.createHmac('sha256', 'test-secret').update(oldHead).digest('hex')}`;
    assert.strictEqual(consumeSubmitToken(oldTok), true);
    assert.strictEqual(isSubmitTokenConsumed(oldTok), false, 'expired entry must prune, not block');
  });
});

describe('charge gate fail-closed (HTTP path)', () => {
  it('blocks with no token and no secret, before any HTTP attempt', async () => {
    let bootstrapCalls = 0;
    const fakeClient = { bootstrap: async () => { bootstrapCalls += 1; } };
    const out = await runHttpChain({
      data: { person: {}, otp: '123456' },
      userId: 'user-1',
      secret: '',
      client: fakeClient,
      log: () => {},
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.error, 'CHARGE_REQUIRED');
    assert.strictEqual(bootstrapCalls, 0, 'gate must block before bootstrap');
  });

  it('blocks a consumed token at the gate', async () => {
    const tok = mintToken('user-1', 'test-secret', 'ref-gate-' + Date.now());
    assert.strictEqual(consumeSubmitToken(tok), true);
    let bootstrapCalls = 0;
    const fakeClient = { bootstrap: async () => { bootstrapCalls += 1; } };
    const out = await runHttpChain({
      data: { person: {}, otp: '123456', _chargeToken: tok },
      userId: 'user-1',
      secret: 'test-secret',
      client: fakeClient,
      log: () => {},
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'CHARGE_TOKEN_CONSUMED');
    assert.strictEqual(bootstrapCalls, 0);
  });
});

// ---- Fake page for submitS1 (names + DOB + thChild + gender only;
// no division/district/village, so submitS1 now fails honestly for
// the missing birth address (submit-debug 2026-10-26) — the selector
// assertions below still prove the DOB/thChild/gender behaviour) ----
function makeS1Page({ modalText = '' } = {}) {
  const values = { personBirthDate: '' };
  const requestedLocators = [];
  let modalClicked = false;
  const selects = {
    '#thChild': { options: ['১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯', '১০', '১১'].map((t) => ({ text: t, value: t })), value: '', dispatchEvent: () => {} },
    '#gender': { options: ['পুরুষ', 'মহিলা', 'তৃতীয় লিঙ্গ'].map((t) => ({ text: t, value: t })), value: '', dispatchEvent: () => {} },
  };
  const nameValues = {};
  const doc = {
    body: { innerText: modalText },
    querySelector: (sel) => {
      if (sel === '#personBirthDate') return { value: values.personBirthDate };
      if (selects[sel]) return selects[sel];
      const m = sel.match(/personInfoForBirth\.(\w+)/);
      if (m && selects['#' + m[1]]) return selects['#' + m[1]];
      if (m) return null;
      for (const part of ['personFirstNameBn', 'personLastNameBn', 'personFirstNameEn', 'personLastNameEn']) {
        if (sel.includes(part)) return { value: nameValues[part] || '' };
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  const elFor = (sel) => ({
    click: async () => {},
    fill: async (v) => { if (sel.includes('personBirthDate')) values.personBirthDate = v; },
    type: async (v) => { if (sel.includes('personBirthDate')) values.personBirthDate = v; },
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ y: 0 }),
  });
  const page = {
    $: async (sel) => {
      // Name fields only (fillInput path); DOB must NOT come via $.
      if (sel.includes('personDob')) throw new Error('TEST FAIL: #personDob must never be requested');
      if (/person(First|Last)Name/.test(sel)) {
        const part = sel.match(/person(?:First|Last)Name(?:Bn|En)/)[0];
        return {
          click: async () => {},
          fill: async () => {},
          type: async (v) => { nameValues[part] = v; },
        };
      }
      return null;
    },
    locator: (sel) => {
      requestedLocators.push(sel);
      const isDob = sel.includes('personBirthDate');
      const isModalBtn = sel.includes('আমার কাছে এই ডকুমেন্টগুলি আছে');
      return {
        count: async () => (isDob || isModalBtn ? 1 : 0),
        nth: () => ({
          isVisible: async () => true,
          isEnabled: async () => true,
          boundingBox: async () => ({ y: 0 }),
          click: async () => { if (isModalBtn) modalClicked = true; },
          fill: async (v) => { if (isDob) values.personBirthDate = v; },
          type: async (v) => { if (isDob) values.personBirthDate = v; },
        }),
      };
    },
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try {
        if (arg && typeof arg === 'object' && arg.sel !== undefined) {
          // BdrisNavigator.selectOption evaluate: querySelector + options.
          return fn(arg);
        }
        if (typeof arg === 'string' && arg.includes('personBirthDate')) return values.personBirthDate;
        if (typeof fn === 'function' && fn.length === 0) return fn();
        return fn(arg);
      } finally { global.document = prev; }
    },
  };
  return { page, values, selects, requestedLocators, get modalClicked() { return modalClicked; } };
}

describe('submitS1 selectors (v1 live-verified)', () => {
  it('types DOB into #personBirthDate (masked), fills thChild + gender, never touches #personDob', async () => {
    const { page, values, selects, requestedLocators } = makeS1Page();
    const nav = new BdrisNavigator(page);
    const handler = new StepHandler(nav, { emit: () => {} });
    const out = await handler.submitS1({
      firstNameBn: 'আবদুল', lastNameBn: 'করিম', firstNameEn: 'Abdul', lastNameEn: 'Karim',
      dob: '2020-01-15', gender: 'পুরুষ', thChild: '৩য়',
    });
    // Selectors must still be filled, but the step itself is an
    // honest failure: no birth address was supplied, so it cannot
    // claim step 2 complete (submit-debug 2026-10-26).
    assert.strictEqual(out.ok, false, 'missing birth address must not be ok:true');
    assert.ok((out.failed || []).some((f) => /জন্মস্থানের ঠিকানা/.test(f.field || '')));
    assert.strictEqual(values.personBirthDate, '15/01/2020', 'DOB must be DD/MM/YYYY in the masked field');
    assert.strictEqual(selects['#thChild'].value, '৩');
    assert.strictEqual(selects['#gender'].value, 'পুরুষ');
    assert.ok(requestedLocators.some((s) => s.includes('personBirthDate')), 'masked DOB selector must be requested');
    assert.ok(!requestedLocators.some((s) => s.includes('personDob')), '#personDob must never be requested');
  });

  it('attachment modal: absent -> no-op; shown + docs -> clicked; shown + no docs -> fail', async () => {
    const noModal = makeS1Page({ modalText: '' });
    const h1 = new StepHandler(new BdrisNavigator(noModal.page), { emit: () => {} });
    assert.deepStrictEqual(await h1._handleAttachmentModal(true), { ok: true, shown: false });

    const shown = makeS1Page({ modalText: 'অ্যাটাচমেন্ট অ্যাভেইলেবিলিটি চেক' });
    const h2 = new StepHandler(new BdrisNavigator(shown.page), { emit: () => {} });
    const r2 = await h2._handleAttachmentModal(true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.shown, true);
    assert.strictEqual(shown.modalClicked, true);

    const h3 = new StepHandler(new BdrisNavigator(shown.page), { emit: () => {} });
    const r3 = await h3._handleAttachmentModal(false);
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.shown, true);
  });
});
