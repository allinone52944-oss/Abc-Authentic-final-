/**
 * ALL-BUGS (h) — bot fallback page-position failure.
 *
 * Live evidence (2026-10-30): a bare SUBMIT_S4_OTP against a bot
 * page that was not on the OTP step failed with a message ending
 * "try the direct path again" — a loop back into the failing
 * path — and no machine-readable code for the frontend to branch
 * on, so the user got a generic retry that could never succeed.
 *
 * The honest root-cause fix (a silent bot replay is NOT possible:
 * it would re-send an already-sent code — 400-unexpired — and
 * cannot pass the parent gate for a BRN-free filing) is: the gate
 * failure carries a machine-readable code, the message names the
 * TRUE recovery, and the frontend routes on the code. This test
 * pins the engine half: the code exists on both the gate and the
 * submitS4 return, and the looping message is gone.
 *
 * Run: node --test engines/bdris-apply/v2/tests/otp-step-gate-code.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'StepHandler.js'),
  'utf8'
);

test('OTP-step gate carries a machine-readable code', () => {
  assert.match(SRC, /code: 'BOT_PAGE_NOT_ON_OTP_STEP'/);
});

test('submitS4 gate failure returns the code (not message-only)', () => {
  assert.match(
    SRC,
    /return \{ ok: false, code: 'BOT_PAGE_NOT_ON_OTP_STEP', message: otpStep\.message, pageState: otpStep\.pageState \}/
  );
});

test('the looping "try the direct path again" message is gone', () => {
  assert.doesNotMatch(SRC, /সরাসরি পথে আবার চেষ্টা করুন/);
});

test('the gate message names the true recovery (bot-path re-send)', () => {
  assert.match(SRC, /বটের পথে আবার কোড পাঠিয়ে জমা দিন/);
});
