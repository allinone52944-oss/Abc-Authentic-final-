/**
 * ALL-BUGS (c) — success banner must appear the MOMENT the site
 * accepts, never after screenshot + PDF capture.
 *
 * Live evidence (2026-10-30): submit success was detected, but the
 * banner only appeared after screenshot (15s) + PDF-button wait
 * (10s) + download wait (25s) + copy-PDF generation — users
 * reported "submit hobar sate sate success banner asena".
 *
 * This test hangs the screenshot capture forever and asserts the
 * COMPLETED event still fires promptly: on the old code COMPLETED
 * was emitted only after capture, so this test times out there
 * (no COMPLETED within the wait) and passes on the fixed code.
 *
 * Run: node --test engines/bdris-apply/v2/tests/submit-immediate-completed.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const nodeCrypto = require('node:crypto');

const { StepHandler } = require('../services/StepHandler');

function validChargeToken(userId, secret, ref) {
  const head = `v1.${userId}.submit.${ref}.${Date.now()}`;
  const mac = nodeCrypto.createHmac('sha256', secret).update(head).digest('hex');
  return `${head}.${mac}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('COMPLETED emits before screenshot/PDF capture completes', async () => {
  const prevSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-all-bugs-c';
  const events = [];
  try {
    const page = {
      // Success detection: selector appears at once.
      waitForSelector: async () => ({}),
      waitForTimeout: async () => {},
      // Screenshot capture hangs forever (the old delay).
      screenshot: () => new Promise(() => {}),
      evaluate: async (fn) => {
        const src = String((fn && fn.toString()) || '');
        // clickSubmit's success probe (the only evaluate carrying
        // the toast check) reports visible success.
        if (src.includes('jq-toast-single')) return { succ: true, errs: [] };
        // Ack-text / live-number probes read the success banner.
        return 'আবেদন নম্বর: 123456789';
      },
    };
    const h = new StepHandler({ page }, {
      emit: (ev, payload) => { events.push({ ev, payload }); },
      userId: 'u1',
    });
    h._ensureOtpStep = async () => ({ ok: true });
    h._typeInto = async () => ({ ok: true });
    h._waitVisible = async () => ({ el: true });
    h._robustClick = async () => {};

    const tok = validChargeToken('u1', 'test-secret-all-bugs-c', 'imm-completed-1');
    let settled = false;
    const pending = h.submitS4({
      otp: '123456', _chargeToken: tok, s1: {}, s2: {}, s2b: {}, s3: {}, s4prep: {},
    }).then(() => { settled = true; }, () => { settled = true; });

    // The banner event must arrive while capture is still hung.
    await sleep(1500);
    const completed = events.find(
      (e) => e.ev === 'BOT_STATUS' && e.payload && e.payload.status === 'COMPLETED'
    );
    assert.ok(completed, 'COMPLETED must fire even while screenshot capture hangs');
    assert.equal(completed.payload.attachmentsPending, true);
    assert.match(String(completed.payload.ackId || ''), /123456789/);
    // And the handler itself must still be stuck in capture (it
    // has NOT returned — the banner did not wait for it).
    assert.equal(settled, false, 'submitS4 must still be pending in capture');
    // No attachments event yet — nothing was captured.
    const attachments = events.find(
      (e) => e.ev === 'BOT_STATUS' && e.payload && e.payload.status === 'COMPLETED_ATTACHMENTS'
    );
    assert.equal(attachments, undefined);
    // NOTE: the submitS4 promise is deliberately left pending (the
    // hung screenshot never resolves and holds no timers, so the
    // test process still exits cleanly).
  } finally {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  }
});
