/**
 * S4PREP silent-timeout fix (2026-10-28) — no more silent sends.
 *
 * Live-proven 2026-10-28: three S4_PREP sends left zero journal
 * lines and the page stuck on 'sending' with disabled buttons.
 * Code-proven causes: (1) the executor never logged timeouts or
 * failures; (2) the legacy SUBMIT handler forwarded a TIMEOUT as
 * STEP_CHANGE_ACK {ok:false, failed:[]} and manualStepAck's failure
 * branch requires d.blocked || failed.length, so the timeout skipped
 * the failure branch and landed in the success branch's S4_PREP
 * block, which renders the OTP 'sending' view whenever otpSent !==
 * true; (3) StepHandler progress() is socket-only, so a pre-send
 * replay in progress was journal-invisible. This file pins the
 * three repairs plus the zombie rule: every executor timeout /
 * failure logs one journal line (command + window/code only, never
 * params); every !ok STEP_CHANGE_ACK carries a non-empty failed
 * list; every S4_PREP pre-send stage logs one journal line; a
 * TIMEOUT result must drop the session (timed-out Playwright work
 * is never cancelled and the page is shared across reloads).
 * No live contact, no browser, no personal data. Fixture values
 * only (the phone below is the same dummy the replay tests use).
 * Run: node --test engines/bdris-apply/v2/tests/s4prep-silent-timeout.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { CommandExecutor } = require('../core/CommandExecutor');
const { toStepAck, shouldDropSession } = require('../core/stepAck');
const { StepHandler } = require('../services/StepHandler');

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

describe('CommandExecutor journal lines', () => {
  it('logs a timeout with command + window, returns TIMEOUT', async () => {
    const ex = new CommandExecutor();
    ex.register('NEVER', async () => new Promise(() => {}), { timeoutMs: 20 });
    let res;
    const lines = await captureLogs(async () => { res = await ex.execute('NEVER', {}); });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'TIMEOUT');
    assert.ok(lines.some((l) => l.includes('EXECUTOR-TIMEOUT: NEVER after 20ms')), lines.join('\n'));
  });

  it('logs a failure with command + code, returns EXECUTION_FAILED', async () => {
    const ex = new CommandExecutor();
    ex.register('BOOM', async () => { throw Object.assign(new Error('boom'), { code: 'SOME_CODE' }); });
    let res;
    const lines = await captureLogs(async () => { res = await ex.execute('BOOM', {}); });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'EXECUTION_FAILED');
    assert.ok(lines.some((l) => l.includes('EXECUTOR-FAILED: BOOM SOME_CODE')), lines.join('\n'));
  });

  it('logs nothing on success, and dedups only completed commands', async () => {
    const ex = new CommandExecutor();
    let calls = 0;
    ex.register('OKCMD', async () => { calls += 1; return { step: 2 }; });
    let r1; let r2;
    const lines = await captureLogs(async () => {
      r1 = await ex.execute('OKCMD', { _commandId: 'c1' });
      r2 = await ex.execute('OKCMD', { _commandId: 'c1' });
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(calls, 1);
    assert.ok(!lines.some((l) => l.includes('EXECUTOR-TIMEOUT') || l.includes('EXECUTOR-FAILED')), lines.join('\n'));
  });
});

describe('toStepAck failure shaping', () => {
  it('gives a TIMEOUT a non-empty failed list with the timeout message', () => {
    const ack = toStepAck({ ok: false, error: 'TIMEOUT', message: 'SUBMIT_S4_PREP timed out after 300000ms' });
    assert.strictEqual(ack.ok, false);
    assert.strictEqual(ack.failed.length, 1);
    assert.strictEqual(ack.failed[0].reason, 'SUBMIT_S4_PREP timed out after 300000ms');
  });

  it('gives a bare failure a failed reason from error', () => {
    const ack = toStepAck({ ok: false, error: 'EXECUTION_FAILED' });
    assert.strictEqual(ack.failed.length, 1);
    assert.strictEqual(ack.failed[0].reason, 'EXECUTION_FAILED');
  });

  it('passes success shapes through unchanged', () => {
    const ack = toStepAck({ ok: true, step: 6, otpSent: false, failed: [] });
    assert.strictEqual(ack.ok, true);
    assert.strictEqual(ack.step, 6);
    assert.strictEqual(ack.otpSent, false);
    assert.deepStrictEqual(ack.failed, []);
  });

  it('never replaces an existing failed list', () => {
    const ack = toStepAck({ ok: false, failed: [{ reason: 'r', code: 'C' }] });
    assert.deepStrictEqual(ack.failed, [{ reason: 'r', code: 'C' }]);
  });
});

describe('shouldDropSession zombie rule', () => {
  it('drops only on TIMEOUT', () => {
    assert.strictEqual(shouldDropSession({ ok: false, error: 'TIMEOUT' }), true);
    assert.strictEqual(shouldDropSession({ ok: false, error: 'EXECUTION_FAILED' }), false);
    assert.strictEqual(shouldDropSession({ ok: true }), false);
    assert.strictEqual(shouldDropSession(null), false);
  });
});

describe('S4PREP journal stage lines', () => {
  function fakePage() {
    const doc = { querySelector: () => null, querySelectorAll: () => [], body: { innerText: '' } };
    return {
      evaluate: async (fn, arg) => {
        const prev = global.document;
        global.document = doc;
        try { return await fn(arg); } finally { global.document = prev; }
      },
      waitForTimeout: async () => {},
    };
  }

  it('logs ANCHOR, DETECT and REPLAY stages on the docs-step replay path', async () => {
    const h = new StepHandler({ page: fakePage() }, { emit: () => {} });
    const state = { contactVisible: false, siteStep: 5, nextCalls: [], nextResult: { ok: true }, nextAdvances: true, robustClicks: [], otpEvidenceCalls: 0, probe: { contact: false, docs: true, start: false, form: true, bodyLen: 500 } };
    h._waitVisible = async (sels) => {
      const list = Array.isArray(sels) ? sels : [sels];
      const isContact = list.some((s) => s.includes('#email') || s.includes('email') || s.includes('#phone') || s.includes('phone'));
      if (isContact) return state.contactVisible ? { anchor: true } : null;
      if (list.some((s) => s.includes('ওটিপি পাঠান'))) return { button: true };
      return null;
    };
    h._typeInto = async () => ({ ok: true });
    h._robustClick = async (target, label) => { state.robustClicks.push(label || ''); return true; };
    h._waitOtpEvidence = async () => { state.otpEvidenceCalls += 1; return { ok: true, note: 'mock otp evidence' }; };
    h._detectSiteStep = async () => ({ step: state.siteStep, probe: state.probe });
    h._clickNextAndWait = async (label) => {
      state.nextCalls.push(label);
      if (state.nextAdvances) state.contactVisible = true;
      return state.nextResult;
    };
    let out;
    const lines = await captureLogs(async () => {
      out = await h.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
    });
    assert.strictEqual(out.ok, true, JSON.stringify(out.failed));
    assert.ok(lines.some((l) => l === 'S4PREP-ANCHOR: missing'), lines.join('\n'));
    assert.ok(lines.some((l) => l === 'S4PREP-DETECT: step=5'), lines.join('\n'));
    assert.ok(lines.some((l) => l === 'S4PREP-REPLAY: start step=5'), lines.join('\n'));
    assert.ok(lines.some((l) => l === 'S4PREP-REPLAY: ok docs-next'), lines.join('\n'));
  });
});
