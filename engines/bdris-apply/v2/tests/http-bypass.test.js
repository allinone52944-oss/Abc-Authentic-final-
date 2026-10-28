/**
 * DIRECT HTTP BYPASS (2026-10-29): plain-HTTP trigger for the direct chain.
 *
 * The browser socket dies every few minutes (transport close), so the
 * direct send/submit phases are triggered with a POST to /http-chain
 * (externally /api/bdris-apply/http-chain) instead of a socket emit.
 * The route runs the SAME executor call as the socket ENGINE_COMMAND
 * handler, so response shapes cannot drift. Covered here:
 *  - Body/token/flag/session gating order (bad input never reaches
 *    the executor; the flag is enforced server-side, never trusted
 *    from the client).
 *  - Param stripping (_authToken/_commandId/_timeoutMs never reach
 *    the executor) and ctx.userId derivation (same id precedence as
 *    the socket handshake check) — the charge gate binds tokens to
 *    that id, so a client-supplied userId must never be trusted.
 *  - Result passthrough verbatim, BOT_STATUS emit forwarding to the
 *    session's socket id, and POST /http-chain route wiring.
 *  - Real-executor behavior: submit charge-gate refusal (blocked,
 *    no HTTP attempt) and send-phase seed failure (fallback shape,
 *    no bare bootstrap) — both without a warm page.
 *
 * Run: node --test engines/bdris-apply/v2/tests/http-bypass.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { BdrisEngineV2 } = require('../server');
const { CommandExecutor } = require('../core/CommandExecutor');

const TEST_SECRET = 'http-bypass-test-secret';

function mintToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function makeEngine({ session = null, executor = null, io = null } = {}) {
  const engine = Object.create(BdrisEngineV2.prototype);
  const seenUsers = [];
  engine.sessionManager = {
    touched: [],
    seenUsers,
    findByUser(uid) { seenUsers.push(uid); return session; },
    touch(id) { this.touched.push(id); },
  };
  engine.executor = executor || {
    calls: [],
    async execute(cmd, params, ctx) {
      this.calls.push({ cmd, params, ctx });
      return { ok: true, echoed: true };
    },
  };
  engine.io = io;
  engine.log = () => {};
  return engine;
}

function makeSession() {
  return {
    id: 'sess_http',
    userId: 'u1',
    page: null,
    metadata: { socketId: 'sock-9' },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'ACTIVE',
  };
}

describe('DIRECT HTTP BYPASS: handleHttpChainRequest gating', () => {
  let savedFlag;
  let savedJwt;
  let savedAbcJwt;

  beforeEach(() => {
    savedFlag = process.env.BDRIS_HTTP_PATH;
    savedJwt = process.env.JWT_SECRET;
    savedAbcJwt = process.env.ABC_JWT_SECRET;
    process.env.BDRIS_HTTP_PATH = 'on';
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.ABC_JWT_SECRET;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.BDRIS_HTTP_PATH;
    else process.env.BDRIS_HTTP_PATH = savedFlag;
    if (savedJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwt;
    if (savedAbcJwt === undefined) delete process.env.ABC_JWT_SECRET;
    else process.env.ABC_JWT_SECRET = savedAbcJwt;
  });

  it('non-object body → 400 BAD_REQUEST, executor untouched', async () => {
    const engine = makeEngine({ session: makeSession() });
    for (const bad of [null, 'x', [], 42]) {
      const r = await engine.handleHttpChainRequest(bad);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'BAD_REQUEST');
    }
    assert.strictEqual(engine.executor.calls.length, 0);
  });

  it('missing/invalid token → 401 UNAUTHORIZED, executor untouched', async () => {
    const engine = makeEngine({ session: makeSession() });
    const noToken = await engine.handleHttpChainRequest({ phase: 'send' });
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.body.error, 'UNAUTHORIZED');
    const garbage = await engine.handleHttpChainRequest({ phase: 'send', _authToken: 'not.a.jwt' });
    assert.strictEqual(garbage.status, 401);
    const wrongSecret = await engine.handleHttpChainRequest({
      phase: 'send',
      _authToken: (() => {
        const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const p = Buffer.from(JSON.stringify({ id: 'u1' })).toString('base64url');
        const sig = crypto.createHmac('sha256', 'other-secret').update(`${h}.${p}`).digest('base64url');
        return `${h}.${p}.${sig}`;
      })(),
    });
    assert.strictEqual(wrongSecret.status, 401);
    assert.strictEqual(engine.executor.calls.length, 0);
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
  });

  it('flag off → disabled shape verbatim, executor untouched', async () => {
    delete process.env.BDRIS_HTTP_PATH;
    const engine = makeEngine({ session: makeSession() });
    const r = await engine.handleHttpChainRequest({ phase: 'send', uiDirect: true, _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.httpPath, 'disabled');
    assert.strictEqual(r.body.disabled, true);
    assert.strictEqual(r.body.error, 'HTTP_PATH_DISABLED');
    assert.strictEqual(engine.executor.calls.length, 0);
  });

  it('valid token but no session → NO_SESSION, executor untouched', async () => {
    const engine = makeEngine({ session: null });
    const r = await engine.handleHttpChainRequest({ phase: 'send', uiDirect: true, _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.strictEqual(engine.executor.calls.length, 0);
  });

  it('valid token + session → executor called with stripped params, ctx.userId, result passthrough', async () => {
    const engine = makeEngine({ session: makeSession() });
    const r = await engine.handleHttpChainRequest({
      phase: 'send', uiDirect: true, phone: '01000000000',
      _authToken: mintToken({ id: 'u1' }), _commandId: 'old-id', _timeoutMs: 999,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.echoed, true);
    assert.strictEqual(engine.executor.calls.length, 1);
    const call = engine.executor.calls[0];
    assert.strictEqual(call.cmd, 'SUBMIT_HTTP_CHAIN');
    assert.strictEqual(call.params.phase, 'send');
    assert.strictEqual(call.params.uiDirect, true);
    assert.strictEqual(call.params.phone, '01000000000');
    assert.strictEqual('_authToken' in call.params, false);
    assert.strictEqual('_commandId' in call.params, false);
    assert.strictEqual('_timeoutMs' in call.params, false);
    assert.strictEqual(call.ctx.userId, 'u1');
    assert.strictEqual(call.ctx.socket, null);
    assert.strictEqual(call.ctx.session.id, 'sess_http');
    assert.deepStrictEqual(engine.sessionManager.touched, ['sess_http']);
  });

  it('token sub field → userId from sub (same precedence as socket handshake)', async () => {
    const engine = makeEngine({ session: makeSession() });
    await engine.handleHttpChainRequest({ phase: 'send', _authToken: mintToken({ sub: 'u2' }) });
    assert.deepStrictEqual(engine.sessionManager.seenUsers, ['u2']);
  });

  it('emit forwarding goes to the session socket id', async () => {
    const forwarded = [];
    const io = { to: (sid) => ({ emit: (ev, msg) => forwarded.push([sid, ev, msg]) }) };
    const executor = {
      calls: [],
      async execute(cmd, params, ctx) {
        this.calls.push({ cmd, params, ctx });
        ctx.emit('BOT_STATUS', { status: 'COMPLETED' });
        return { ok: true };
      },
    };
    const engine = makeEngine({ session: makeSession(), executor, io });
    await engine.handleHttpChainRequest({ phase: 'submit', _authToken: mintToken({ id: 'u1' }) });
    assert.deepStrictEqual(forwarded, [['sock-9', 'BOT_STATUS', { status: 'COMPLETED' }]]);
  });

  it('setupHttpRoutes registers POST /http-chain and maps status/body', async () => {
    const posts = [];
    const app = { post: (p, h) => posts.push([p, h]) };
    const engine = makeEngine({ session: makeSession() });
    engine.setupHttpRoutes(app);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0][0], '/http-chain');
    const handler = posts[0][1];
    let status = 0;
    let body = null;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
    engine.executor.execute = async () => ({ ok: true, sent: true, sendCode: 'MESSAGE_SENT' });
    await handler({ body: { phase: 'send', _authToken: mintToken({ id: 'u1' }) } }, res);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.sent, true);
  });
});

describe('DIRECT HTTP BYPASS: real executor behavior (no warm page)', () => {
  let savedFlag;
  let savedJwt;
  let savedAbcJwt;

  beforeEach(() => {
    savedFlag = process.env.BDRIS_HTTP_PATH;
    savedJwt = process.env.JWT_SECRET;
    savedAbcJwt = process.env.ABC_JWT_SECRET;
    process.env.BDRIS_HTTP_PATH = 'on';
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.ABC_JWT_SECRET;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.BDRIS_HTTP_PATH;
    else process.env.BDRIS_HTTP_PATH = savedFlag;
    if (savedJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwt;
    if (savedAbcJwt === undefined) delete process.env.ABC_JWT_SECRET;
    else process.env.ABC_JWT_SECRET = savedAbcJwt;
  });

  function makeRealEngine() {
    const io = { use: () => {}, on: () => {} };
    const engine = new BdrisEngineV2(io, {});
    engine.log = () => {};
    const sess = {
      id: 'sess_real', userId: 'u1', page: null, metadata: {},
      createdAt: Date.now(), lastActivity: Date.now(), state: 'ACTIVE',
    };
    engine.sessionManager.sessions.set(sess.id, sess);
    return engine;
  }

  it('submit phase with a bogus charge token → gate blocked, no HTTP attempt', async () => {
    const engine = makeRealEngine();
    const r = await engine.handleHttpChainRequest({
      phase: 'submit', uiDirect: true, otp: '123456', _chargeToken: 'bogus', _authToken: mintToken({ id: 'u1' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.blocked, true);
    assert.strictEqual(r.body.error, 'CHARGE_REQUIRED');
  });

  it('send phase with no session page → fallback shape, never a bare bootstrap', async () => {
    const engine = makeRealEngine();
    const r = await engine.handleHttpChainRequest({
      phase: 'send', uiDirect: true, _authToken: mintToken({ id: 'u1' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.fallback, true);
  });
});
