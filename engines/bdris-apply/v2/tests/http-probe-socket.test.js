/**
 * Probe socket route (2026-10-27): the frontend button emits
 * socket.emit('HTTP_PROBE_STAGE_A', payload, ack) directly, but
 * v2/server.js originally had NO socket.on handler for that event
 * — only the executor.register. The emit then reached no listener,
 * the ack never fired, and the button timed out with zero server
 * log lines (live demo 2026-10-27). These tests drive the real
 * socket handlers with fake pages (same harness style as
 * server-session.test.js): a pre-set ACTIVE session with a form
 * page must complete the probe via ack, and a stub page must
 * answer SEED_FAILED via ack — never hang. No browser launch, no
 * live contact, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/http-probe-socket.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisEngineV2 } = require('../server');

// Fake Playwright page: form page (meta + hidden CSRF 'fixture')
// or content-less stub (no token anywhere). evaluate() runs the
// engine's functions against a document stub.
function makePage(kind) {
  const isForm = kind === 'form';
  const documentStub = {
    get title() { return isForm ? 'Birth Registration' : ''; },
    body: { get innerText() { return isForm ? 'form content here' : 'x'.repeat(44); } },
    querySelector: (sel) => {
      if (!isForm) return null;
      if (sel === 'form#birth_application_form' || sel === 'form') return {};
      if (sel === 'meta[name="_csrf"]') return { content: 'fixture' };
      if (sel === 'meta[name="_csrf_headerName"]') return { content: 'X-CSRF-TOKEN' };
      if (sel === 'input[name="_csrf"]') return { value: 'fixture' };
      return null;
    },
  };
  return {
    url: () => 'https://bdris.gov.bd/br/application',
    goto: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => true,
    evaluate: async (fn, arg) => {
      const prev = global.document;
      global.document = documentStub;
      try { return await fn(arg); } finally { global.document = prev; }
    },
  };
}

function makeSocket(userId) {
  const handlers = {};
  const emitted = [];
  return {
    id: 'sock_1',
    abcUser: userId ? { id: userId } : null,
    handlers,
    emitted,
    on(ev, cb) { handlers[ev] = cb; },
    emit(ev, payload) { emitted.push([ev, payload]); },
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

function presetSession(engine, userId, kind) {
  const sess = {
    id: `sess_${kind}`,
    userId,
    page: makePage(kind),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'ACTIVE',
  };
  engine.sessionManager.sessions.set(sess.id, sess);
  return sess;
}

function emitWithAck(socket, data) {
  return new Promise((resolve, reject) => {
    const handler = socket.handlers['HTTP_PROBE_STAGE_A'];
    assert.strictEqual(typeof handler, 'function', 'socket.on(HTTP_PROBE_STAGE_A) must be registered (else the button emit hangs with no ack)');
    const t = setTimeout(() => reject(new Error('probe ack never fired (route missing?)')), 10000);
    handler(data, (r) => { clearTimeout(t); resolve(r); });
  });
}

describe('probe socket route: direct emit must reach the executor and ack', () => {
  it('form-page session completes the probe via ack (seed + bootstrap-skip, no geo/office)', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    presetSession(engine, 'u1', 'form');
    const r = await emitWithAck(socket, {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, 'http-probe');
    assert.strictEqual(r.stage, 'A');
    assert.deepStrictEqual(r.steps, ['bootstrap-skipped']);
    assert.strictEqual(r.stoppedBefore, 'upload');
  });

  it('stub-page session answers SEED_FAILED via ack (never hangs)', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    presetSession(engine, 'u1', 'stub');
    const r = await emitWithAck(socket, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'SEED_FAILED');
  });
});
