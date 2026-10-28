'use strict';

/**
 * S4PREP silent-timeout fix (2026-10-28) — STEP_CHANGE_ACK shaping.
 *
 * Root cause (live-proven 2026-10-28, then code-proven): the executor
 * returns a TIMEOUT as {ok:false, error:'TIMEOUT', message} with NO
 * failed list, and the legacy SUBMIT handler forwarded it verbatim as
 * STEP_CHANGE_ACK {ok:false, failed:[], message}. manualStepAck's
 * failure branch requires d.blocked || failed.length, so a TIMEOUT
 * SKIPPED the failure branch and landed in the success branch's
 * S4_PREP block, which renders the OTP 'sending' view whenever
 * otpSent !== true (and skips busy(false) unless otpStage === 'code'):
 * the timeout masqueraded as 'sending' forever, with disabled
 * buttons and no error. toStepAck guarantees every !ok result
 * carries a non-empty failed list, so the failure branch always
 * fires (fail box + retry banner + busy freed). Success shapes pass
 * through unchanged; an existing failed list is never replaced.
 *
 * shouldDropSession pins the zombie rule: withTimeout never cancels
 * the underlying Playwright work, so a timed-out op keeps driving
 * the shared session.page in the background, and sessions are
 * reused across reloads (SessionManager.findByUser, same-user
 * takeover). A timed-out op's page is therefore untrusted: the
 * caller must drop the session so the next op bootstraps a fresh
 * page instead of fighting the zombie. Only TIMEOUT drops — a
 * cleanly returned failure leaves the page in a known state.
 */

function toStepAck(result) {
  const r = result || {};
  const failed = Array.isArray(r.failed) ? r.failed.slice() : [];
  if (r.ok === false && failed.length === 0) {
    failed.push({ reason: r.message || r.error || 'EXECUTION_FAILED' });
  }
  return {
    step: r.step || 0,
    message: r.message || '',
    failed,
    blocked: r.blocked || undefined,
    ok: r.ok,
    resumable: r.resumable || undefined,
    otpSent: r.otpSent,
    code: r.code || undefined,
    relationBn: r.relationBn,
  };
}

function shouldDropSession(result) {
  return !!(result && result.error === 'TIMEOUT');
}

module.exports = { toStepAck, shouldDropSession };
