/**
 * SUBMIT-FINAL FIX PACK (2026-10-30) — bot fallback S4 OTP-step
 * gate (node:test, no live contact, no browser, no personal
 * data; fixture values only).
 *
 * Live evidence (2026-10-30): after a direct submit failure,
 * the frontend emits bare SUBMIT_S4_OTP (direct-fallback)
 * without driving the bot page through S0–S4Prep, so the page
 * is not at the OTP step — and submitS4 failed twice with the
 * misleading 'কোডের ঘর পাওয়া যায়নি' even after the code was
 * cleared, freshly re-entered, and verified on screen.
 *
 * Covered:
 *  #3  _ensureOtpStep returns {ok:true} when an OTP field is
 *      visible; when absent it returns a distinct page-state
 *      failure (message names the step hint + page path, never
 *      the field error) with a pageState object.
 *  #3  _otpPageState strips query/hash from the URL (path
 *      only), classifies login vs form pages, and reads control
 *      descriptors only (tag/type/id/name — never values/text).
 *
 * Run: node --test engines/bdris-apply/v2/tests/s4-otp-step-gate.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { StepHandler } = require('../services/StepHandler');

// Fake page: url() + evaluate against a stub document. The
// evaluate stub runs the handler's function against a doc whose
// querySelector/querySelectorAll report the test's page shape.
function fakePage({ url, hasForm, hasLogin, inputs = [] }) {
  const doc = {
    querySelector: (sel) => {
      if (sel === 'form') return hasForm ? {} : null;
      if (sel === 'input[type="password"]') return hasLogin ? {} : null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'input') {
        return inputs.map((inp) => ({
          offsetParent: {},
          getAttribute: (name) => (name === 'type' ? inp.type || '' : name === 'name' ? inp.name || '' : ''),
          id: inp.id || '',
        }));
      }
      return [];
    },
  };
  return {
    url: () => url,
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    waitForTimeout: async () => {},
    _doc: doc,
  };
}

function makeHandler(page) {
  const h = new StepHandler({ page }, { emit: () => {} });
  return h;
}

test('OTP field visible → gate passes', async () => {
  const h = makeHandler(fakePage({ url: 'https://bdris.gov.bd/br/application', hasForm: true, hasLogin: false }));
  h._waitVisible = async () => ({ el: true });
  const r = await h._ensureOtpStep(['#otp']);
  assert.equal(r.ok, true);
});

test('OTP field absent on form page → distinct page-state error, never the field error', async () => {
  const page = fakePage({
    url: 'https://bdris.gov.bd/br/application?session=abc123',
    hasForm: true, hasLogin: false,
    inputs: [{ type: 'radio', id: '', name: 'officeAddressType' }],
  });
  const h = makeHandler(page);
  h._waitVisible = async () => null;
  const r = await h._ensureOtpStep(['#otp', 'input[name="otp"]']);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('OTP ধাপে নেই'), 'message names the missing OTP step');
  assert.ok(r.message.includes('ফর্ম পেজ'), 'message names the form-page hint');
  assert.ok(!r.message.includes('কোডের ঘর পাওয়া যায়নি'), 'never the misleading field error');
  assert.equal(r.pageState.url, '/br/application', 'query stripped, path only');
  assert.equal(r.pageState.onBdris, true);
  assert.equal(r.pageState.hasForm, true);
  assert.equal(r.pageState.inputs[0].name, 'officeAddressType');
  assert.ok(!('value' in (r.pageState.inputs[0] || {})), 'no values in descriptors');
});

test('OTP field absent on login page → login hint', async () => {
  const page = fakePage({
    url: 'https://bdris.gov.bd/login',
    hasForm: false, hasLogin: true,
    inputs: [{ type: 'password', id: 'pass', name: 'password' }],
  });
  const h = makeHandler(page);
  h._waitVisible = async () => null;
  const r = await h._ensureOtpStep(['#otp']);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('লগইন পেজ'), 'message names the login page');
  assert.equal(r.pageState.url, '/login');
});

test('_otpPageState tolerates a page without url()', async () => {
  const h = makeHandler({ evaluate: async () => ({ hasForm: false, hasLogin: false, inputs: [] }) });
  h._waitVisible = async () => null;
  const r = await h._ensureOtpStep(['#otp']);
  assert.equal(r.ok, false);
  assert.equal(r.pageState.url, '');
  assert.equal(r.pageState.hint, 'অজানা পেজ');
});
