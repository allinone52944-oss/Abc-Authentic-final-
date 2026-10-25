/**
 * Debug-2 (2026-10-26, on top of 218ea55) — mock only.
 * Second independent pass, focused on what submit-debug did NOT cover:
 *  1. Original-PDF path was broken in two code-proven places:
 *     (a) submitS4's buildOriginalRec always got an empty s4prep —
 *         the S4_OTP payload carries only {otp} + ctx {s0,s1,s2,s2b},
 *         never phone/email — so mobileNo was empty and originalRec
 *         was always null. Fix: S4Prep records this.contact, the
 *         server copies it onto the session and merges it into S4's
 *         s4prep (explicit s4prep fields still win).
 *     (b) v2 never saved the record: saveRec had zero production
 *         callers, so every post-submit FETCH_ORIGINAL {ack} died
 *         with NO_RECORD (v1 did origIndexPut at submit success).
 *         Fix: the legacy S4 handler now saveRec()s on success.
 *     (c) showDone treated COMPLETED.original (a record object in
 *         v2, a URL string in v1) as a download link — that test
 *         lives in the frontend suite (origUrl string-only).
 *  2. Auto-chain draft uiStep: chainAck preferred the engine's
 *     SITE-step numbers (S0 -> 1, S1 -> 2) over the OPS SCREEN
 *     numbers (S0 done -> screen 2, S1 done -> screen 3), while
 *     manualStepAck already used the OPS step — a chain draft saved
 *     after S0/S1 resumed one screen too early. (Frontend suite.)
 *  3. Charge-failure self-recovery: the charge shim's emitStep is
 *     async, so callers' `=== false` checks could never see a
 *     failed charge; the wrapper must release the buttons and reset
 *     otpStage itself. (Frontend suite.)
 * No live contact, no browser, no personal data. Fixture values only.
 * Run: node --test engines/bdris-apply/v2/tests/debug2.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StepHandler } = require('../services/StepHandler');
const { BdrisEngineV2 } = require('../server');

// Minimal document: nothing on the page (stub shape).
function fakePage() {
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
  return {
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
    waitForTimeout: async () => {},
  };
}

// Form page (server-session.test.js shape): form + CSRF + divisions.
function makeFormPage() {
  const doc = {
    get title() { return 'Birth Registration'; },
    body: { innerText: 'form content here' },
    querySelector: (sel) => {
      if (sel === 'form#birth_application_form' || sel === 'form') return {};
      if (sel === 'meta[name="_csrf"]') return { content: 'fixture' };
      if (sel === 'input[name="_csrf"]') return { value: 'fixture' };
      if (sel.includes('Div')) return { options: [{ value: '', text: '---' }] };
      return null;
    },
    querySelectorAll: () => [],
  };
  return {
    url: () => 'https://bdris.gov.bd/br/application',
    goto: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => true,
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = doc;
      try { return await fn(arg); } finally { global.document = prev; }
    },
  };
}

function makeEngine() {
  let connectionCb = null;
  const io = {
    use: () => {},
    on: (ev, cb) => { if (ev === 'connection') connectionCb = cb; },
  };
  const engine = new BdrisEngineV2(io, {});
  return { engine, connectionCb };
}

function makeSocket(userId) {
  const handlers = {};
  const emitted = [];
  return {
    abcUser: userId ? { id: userId } : null,
    handlers,
    emitted,
    on(ev, cb) { handlers[ev] = cb; },
    emit(ev, payload) { emitted.push([ev, payload]); },
  };
}

describe('S4Prep contact capture (original-PDF fix 1a)', () => {
  it('records this.contact even when the contact step itself fails', async () => {
    const origWait = StepHandler.prototype._waitVisible;
    StepHandler.prototype._waitVisible = async () => null;
    try {
      const handler = new StepHandler({ page: fakePage() }, { emit: () => {} });
      const out = await handler.submitS4Prep({ email: 'test@example.com', phone: '01900000000' });
      assert.deepStrictEqual(handler.contact, { email: 'test@example.com', phone: '01900000000' });
      assert.strictEqual(out.ok, false, 'anchor missing must still fail honestly');
      assert.match(out.failed[0].reason, /পেজ পাওয়া যায়নি/);
    } finally {
      StepHandler.prototype._waitVisible = origWait;
    }
  });
});

describe('server contact carry S4Prep -> S4 (original-PDF fix 1a)', () => {
  it('stores session.contact on S4Prep and merges it into S4 s4prep', async () => {
    const { engine } = makeEngine();
    const session = { id: 'sess_debug2', page: fakePage() };
    const ctx = { session, emit: () => {}, socket: { abcUser: { id: 'u1' } } };
    const origWait = StepHandler.prototype._waitVisible;
    StepHandler.prototype._waitVisible = async () => null;
    try {
      await engine.executor.execute('SUBMIT_S4_PREP',
        { email: 'test@example.com', phone: '01900000000' }, ctx);
      assert.deepStrictEqual(session.contact,
        { email: 'test@example.com', phone: '01900000000' });

      const origS4 = StepHandler.prototype.submitS4;
      let captured = null;
      StepHandler.prototype.submitS4 = async function (data) {
        captured = data;
        return { ok: false, message: 'probe' };
      };
      try {
        await engine.executor.execute('SUBMIT_S4_OTP', { otp: '123456' }, ctx);
      } finally {
        StepHandler.prototype.submitS4 = origS4;
      }
      assert.deepStrictEqual(captured.s4prep,
        { email: 'test@example.com', phone: '01900000000' });
    } finally {
      StepHandler.prototype._waitVisible = origWait;
    }
  });

  it('explicit S4 s4prep fields win over the stored session contact', async () => {
    const { engine } = makeEngine();
    const session = {
      id: 'sess_debug2b', page: fakePage(),
      contact: { email: 'old@example.com', phone: '01800000000' },
    };
    const ctx = { session, emit: () => {}, socket: { abcUser: { id: 'u1' } } };
    const origS4 = StepHandler.prototype.submitS4;
    let captured = null;
    StepHandler.prototype.submitS4 = async function (data) {
      captured = data;
      return { ok: false, message: 'probe' };
    };
    try {
      await engine.executor.execute('SUBMIT_S4_OTP',
        { otp: '123456', s4prep: { email: 'new@example.com', phone: '01700000000' } }, ctx);
    } finally {
      StepHandler.prototype.submitS4 = origS4;
    }
    assert.deepStrictEqual(captured.s4prep,
      { email: 'new@example.com', phone: '01700000000' });
  });
});

describe('submit-success original-record persistence (original-PDF fix 1b)', () => {
  it('legacy S4 handler saveRec()s so a later FETCH_ORIGINAL {ack} finds it', async () => {
    const { engine, connectionCb } = makeEngine();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdris-debug2-'));
    engine.originalFetcher.indexFile = path.join(tmp, 'originals-index.json');
    const socket = makeSocket('u1');
    connectionCb(socket);
    engine.sessionManager.create = async (userId, metadata) => {
      const sess = {
        id: 'sess_debug2c', userId: userId || null, page: makeFormPage(),
        createdAt: Date.now(), lastActivity: Date.now(), metadata, state: 'ACTIVE',
      };
      engine.sessionManager.sessions.set(sess.id, sess);
      return sess;
    };
    const rec = { appId: '123456789', date: '01/01/2020', nameEn: 'Test', mobileNo: '01900000000' };
    const origS4 = StepHandler.prototype.submitS4;
    StepHandler.prototype.submitS4 = async () => ({
      ok: true, completed: true, step: 7,
      ackId: 'আবেদন নম্বর: 123456789', ackNum: '123456789',
      screenshot: null, pdf: null, originalRec: rec, failed: [],
    });
    try {
      await socket.handlers['SUBMIT_S4_OTP']({ otp: '123456' });
    } finally {
      StepHandler.prototype.submitS4 = origS4;
    }
    assert.deepStrictEqual(engine.originalFetcher.loadRec('123456789'), rec);
    const completed = socket.emitted
      .filter(([ev, p]) => ev === 'BOT_STATUS' && p.status === 'COMPLETED')
      .map(([, p]) => p);
    assert.strictEqual(completed.length, 1);
    assert.deepStrictEqual(completed[0].original, rec);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
