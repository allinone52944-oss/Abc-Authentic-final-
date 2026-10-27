/**
 * Script-probe flag forward (2026-10-27): the frontend script-probe
 * button emits socket.emit('HTTP_PROBE_STAGE_A', {scriptProbe:true}),
 * but the executor registration previously dropped that flag when
 * calling runStageAProbe, so the script step never ran and the button
 * returned a plain-probe result (bootstrap-skipped only). These tests
 * drive the real socket handlers with fake pages (same harness style
 * as http-probe-socket.test.js) and a stubbed fetch serving a canned
 * form page: with the flag the ack must carry a 'script' step with a
 * find-by-geo-id page match; without it the script step must stay off.
 * This test forwards scriptProbe to runStageAProbe through the real
 * registration — it fails on the old registration (flag dropped).
 * No browser launch, no live contact, no personal data.
 * Run: node --test engines/bdris-apply/v2/tests/http-script-flag.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisEngineV2 } = require('../server');

// Fake Playwright page: form page (meta + hidden CSRF 'fixture').
function makePage() {
  const documentStub = {
    get title() { return 'Birth Registration'; },
    body: { get innerText() { return 'form content here'; } },
    querySelector: (sel) => {
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

function presetSession(engine, userId) {
  const sess = {
    id: 'sess_form',
    userId,
    page: makePage(),
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
    assert.strictEqual(typeof handler, 'function', 'socket.on(HTTP_PROBE_STAGE_A) must be registered');
    const t = setTimeout(() => reject(new Error('probe ack never fired')), 10000);
    handler(data, (r) => { clearTimeout(t); resolve(r); });
  });
}

// Canned form page: mentions the office URL inline, no script srcs,
// so the probe fetches exactly one page and finds exactly its match.
const FORM_HTML = '<html><body><script>fetch("/api/office/find-by-geo-id?geoId=1")</script></body></html>';

function stubFetch() {
  let calls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      status: 200,
      ok: true,
      headers: {
        get: (n) => (String(n).toLowerCase() === 'content-type' ? 'text/html;charset=UTF-8' : null),
        getSetCookie: () => [],
      },
      text: async () => FORM_HTML,
    };
  };
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = prev; },
  };
}

describe('script-probe flag: executor registration forwards scriptProbe', () => {
  it('scriptProbe:true runs the script step with a find-by-geo-id page match', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    presetSession(engine, 'u1');
    const fetchStub = stubFetch();
    try {
      const r = await emitWithAck(socket, { scriptProbe: true });
      assert.strictEqual(r.ok, true);
      assert.ok(r.steps.includes('script'), `expected 'script' step, got ${JSON.stringify(r.steps)}`);
      assert.strictEqual(r.results.script.ok, true);
      assert.ok(Array.isArray(r.results.script.pageMatches) && r.results.script.pageMatches.length >= 1);
      assert.strictEqual(r.results.script.pageMatches[0].match, 'find-by-geo-id');
      assert.strictEqual(fetchStub.calls(), 1, 'script probe with no bundle srcs fetches only the form page');
    } finally {
      fetchStub.restore();
    }
  });

  it('scriptProbe:false leaves the script step off (opt-in, not always-on)', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    presetSession(engine, 'u1');
    const fetchStub = stubFetch();
    try {
      const r = await emitWithAck(socket, { scriptProbe: false });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.steps, ['bootstrap-skipped']);
      assert.strictEqual(r.results.script, undefined);
      assert.strictEqual(fetchStub.calls(), 0, 'no script step means no page fetch');
    } finally {
      fetchStub.restore();
    }
  });
});
