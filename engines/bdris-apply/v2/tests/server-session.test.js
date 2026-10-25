/**
 * Server session handling — a failed form load must not leave a
 * reusable broken session (live stub page, 2026-10-26).
 *
 * Proven trap, from server.js code: INIT_SESSION /
 * START_BDRIS_SESSION / legacy GET_ADDRESS_OPTIONS created a
 * session, then called gotoForm(); when gotoForm threw, the
 * session stayed in SessionManager and the next INIT/START found
 * it via findByUser and reused it as READY without ever
 * re-navigating — so every later geo call inherited the same
 * stub page at /br/application (form element false, title '',
 * body length 44, no divisions, no token).
 *
 * These tests drive the real socket handlers with fake pages and
 * a patched SessionManager.create (no browser launch, no live
 * contact, no personal data). The first created page is a stub;
 * the second is a real form page. Without the destroy-on-failure
 * fix, the second INIT/START would reuse the stub session and
 * report success; with it, the stub is destroyed and a fresh
 * page is created instead.
 *
 * Run: node --test engines/bdris-apply/v2/tests/server-session.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BdrisEngineV2 } = require('../server');

// Fake Playwright page: either a content-less stub (live banner
// shape) or a real form page. evaluate() runs the navigator's
// functions against a document stub, as in navigator-geo.test.js.
function makePage(kind) {
  const isForm = kind === 'form';
  const documentStub = {
    get title() { return isForm ? 'Birth Registration' : ''; },
    body: { get innerText() { return isForm ? 'form content here' : 'x'.repeat(44); } },
    querySelector: (sel) => {
      if (!isForm) return null;
      if (sel === 'form#birth_application_form' || sel === 'form') return {};
      if (sel === 'meta[name="_csrf"]') return { content: 'fixture' };
      if (sel === 'input[name="_csrf"]') return { value: 'fixture' };
      if (sel.includes('Div')) return { options: [{ value: '', text: '--- নির্বাচন করুন ---' }] };
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

// Patch create() to hand out a stub page first, then a form page,
// recording creations and destroys against the real session map.
function patchCreate(engine, kinds) {
  let creates = 0;
  const destroyed = [];
  const origDestroy = engine.sessionManager.destroy.bind(engine.sessionManager);
  engine.sessionManager.destroy = async (id) => {
    destroyed.push(id);
    return origDestroy(id);
  };
  engine.sessionManager.create = async (userId, metadata) => {
    creates++;
    const kind = kinds[Math.min(creates - 1, kinds.length - 1)];
    const sess = {
      id: `sess_${creates}`,
      userId: userId || null,
      page: makePage(kind),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      metadata,
      state: 'ACTIVE',
    };
    engine.sessionManager.sessions.set(sess.id, sess);
    return sess;
  };
  return {
    get creates() { return creates; },
    destroyed,
  };
}

describe('server session: failed gotoForm must not leave a reusable stub session', () => {
  it('INIT_SESSION destroys a stub session, and the next INIT creates a fresh page instead of reusing it', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    const patched = patchCreate(engine, ['stub', 'form']);

    let cbArg = null;
    await socket.handlers['INIT_SESSION']({}, (arg) => { cbArg = arg; });
    assert.strictEqual(cbArg.ok, false, 'first INIT must fail on the stub page');
    assert.deepStrictEqual(patched.destroyed, ['sess_1'], 'stub session must be destroyed');
    assert.strictEqual(engine.sessionManager.sessions.size, 0, 'no broken session may remain in the map');

    cbArg = null;
    await socket.handlers['INIT_SESSION']({}, (arg) => { cbArg = arg; });
    assert.strictEqual(cbArg.ok, true, 'second INIT must succeed on a fresh page');
    assert.strictEqual(cbArg.reused, false, 'second INIT must not reuse the destroyed stub session');
    assert.strictEqual(patched.creates, 2, 'second INIT must create a fresh session');
    assert.strictEqual(engine.sessionManager.sessions.size, 1);
  });

  it('START_BDRIS_SESSION destroys a stub session, and the next START creates a fresh page instead of reporting a false READY', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    const patched = patchCreate(engine, ['stub', 'form']);

    await socket.handlers['START_BDRIS_SESSION']();
    const firstStatuses = socket.emitted.filter(([ev]) => ev === 'BOT_STATUS').map(([, p]) => p.status);
    assert.ok(firstStatuses.includes('ERROR'), 'first START must report ERROR on the stub page');
    assert.deepStrictEqual(patched.destroyed, ['sess_1'], 'stub session must be destroyed');
    assert.strictEqual(engine.sessionManager.sessions.size, 0);

    socket.emitted.length = 0;
    await socket.handlers['START_BDRIS_SESSION']();
    const secondStatuses = socket.emitted.filter(([ev]) => ev === 'BOT_STATUS').map(([, p]) => p.status);
    assert.ok(secondStatuses.includes('READY'), 'second START must report READY on a fresh page');
    assert.strictEqual(patched.creates, 2, 'second START must create a fresh session');
  });
});

describe('server session: a degraded reused session must not be reported READY (G7)', () => {
  it('INIT_SESSION destroys a stub session found via findByUser and creates a fresh one instead of reusing it', async () => {
    const { engine, connectionCb } = makeEngine();
    const socket = makeSocket('u1');
    connectionCb(socket);
    const patched = patchCreate(engine, ['form']);
    // A session that was healthy at creation but degraded to a stub.
    engine.sessionManager.sessions.set('sess_stub', {
      id: 'sess_stub', userId: 'u1', page: makePage('stub'),
      createdAt: Date.now(), lastActivity: Date.now(), metadata: {}, state: 'ACTIVE',
    });
    let cbArg = null;
    await socket.handlers['INIT_SESSION']({}, (arg) => { cbArg = arg; });
    assert.strictEqual(cbArg.ok, true, 'INIT must succeed on the fresh page');
    assert.strictEqual(cbArg.reused, false, 'the stub session must not be reused');
    assert.deepStrictEqual(patched.destroyed, ['sess_stub'], 'stub session must be destroyed');
    assert.strictEqual(patched.creates, 1, 'a fresh session must be created');
  });
});
