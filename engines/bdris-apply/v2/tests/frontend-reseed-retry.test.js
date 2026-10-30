/**
 * Frontend reseed retry (2026-10-30) — static tests against
 * frontend/bdris-apply.html. No browser, no DOM execution: the
 * file is read as text and the retry wiring is asserted by
 * structure. The retry shape: after SUBMIT_OUTCOME_UNKNOWN the
 * user checks first, then ONE deliberate banner click re-submits
 * the SAME remembered code on the already-verified session (no
 * new send, no re-verify with a consumed code, no auto-retry).
 * Run: node --test engines/bdris-apply/v2/tests/frontend-reseed-retry.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', '..', '..', '..', 'frontend', 'bdris-apply.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function section(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist in bdris-apply.html`);
  const end = endMarker ? html.indexOf(endMarker, start + 1) : html.length;
  return html.slice(start, end >= 0 ? end : html.length);
}

describe('direct retry after outcome-unknown', () => {
  it('directSubmit stores the code and threads alreadyVerified only on retry', () => {
    const fn = section('async function directSubmit(otp', 'function directSubmitAck');
    assert.ok(fn.includes('S._lastDirectOtp = otp'), 'directSubmit must remember the submitted code');
    assert.ok(fn.includes('alreadyVerified ? { alreadyVerified: true }'), 'the retry flag must reach the chain payload');
  });

  it('directSubmitUnknown offers ONE deliberate direct retry when a code is remembered', () => {
    const fn = section('function directSubmitUnknown(msg)', 'function directHttpEnabled');
    assert.ok(fn.includes('S._lastDirectOtp'), 'the retry must use the remembered code');
    assert.ok(fn.includes('/^\\d{6}$/'), 'the retry must require a 6-digit remembered code');
    assert.ok(fn.includes('showBanner'), 'the retry must be a banner action button (explicit user click, never automatic)');
    assert.ok(fn.includes('সরাসরি আবার চেষ্টা'), 'the retry button must be labeled');
    assert.ok(fn.includes('directSubmit(retryCode, true)'), 'the retry must pass the already-verified flag');
    assert.ok(fn.includes('S._directOtp = true'), 'the retry must re-arm the direct gate it cleared');
  });

  it('a fresh send and DONE both clear the remembered code', () => {
    const send = section('async function directSend()', 'function directSendAck');
    assert.ok(send.includes('S._lastDirectOtp = null'), 'a fresh send must supersede the remembered code');
    assert.ok(html.includes('S._directOtp = false; S._lastDirectOtp = null;'), 'DONE must clear the remembered code');
  });

  it('the normal OTP submit button path is unchanged (no alreadyVerified on first attempt)', () => {
    // The OTP view's submit button still calls directSubmit(otp)
    // with no retry flag — first attempts always verify.
    assert.ok(html.includes('directSubmit(otp); return;'), 'first-attempt submit must stay flag-free');
  });
});
