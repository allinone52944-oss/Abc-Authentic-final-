/**
 * REGISTER-PROBE TRIGGER (2026-10-30): auth-gated POST /probe-register.
 *
 * The probeRegisterEndpoint() diagnostic (empty-body POST to
 * /api/br/application/register, wording-only result) is deliberately
 * unwired from every chain, route, and UI button, so the live server
 * cannot run it at all — this trigger is the minimal safe entry
 * point. Covered here:
 *  - Auth gating order (same two-layer gate as /http-chain and
 *    /draft-save): bad body → 400, missing/invalid/wrong-secret
 *    token → 401, and the session lookup never runs before the
 *    token verifies; a client-supplied userId is never trusted
 *    (the token's id/sub/userId wins).
 *  - Session-page seeding exactly like the submit chain: the
 *    requesting user's session page goes through
 *    HttpGeoService.seedFromPage; no session, no page, or a failed
 *    seed returns an error and attempts NO bare bootstrap and NO
 *    probe call.
 *  - Probe exclusivity: the handler calls probeRegisterEndpoint
 *    and nothing else (a fake client whose other methods throw
 *    proves it), and the success body is EXACTLY
 *    {status, isJson, wording} — no extra keys, no values.
 *  - Route wiring: setupHttpRoutes registers POST /probe-register
 *    and maps its {status, body} to the HTTP response.
 *  - No frontend button is added for this endpoint (the live run
 *    is an explicit server-side call, not customer UI).
 *
 * Run: node --test engines/bdris-apply/v2/tests/probe-register-trigger.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { BdrisEngineV2 } = require('../server');
const { HttpGeoService } = require('../services/HttpGeoService');

const TEST_SECRET = 'probe-trigger-test-only-secret';

function mintToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function makeEngine({ session = null } = {}) {
  const engine = Object.create(BdrisEngineV2.prototype);
  const seenUsers = [];
  engine.sessionManager = {
    seenUsers,
    findByUser(uid) { seenUsers.push(uid); return session; },
    touch() {},
  };
  engine.log = () => {};
  return engine;
}

function makeSession(page) {
  return {
    id: 'sess_probe',
    userId: 'u1',
    page: page || null,
    metadata: {},
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'ACTIVE',
  };
}

function makeFakeClient(result) {
  const calls = { probe: 0, submit: 0, send: 0, verify: 0 };
  return {
    calls,
    async probeRegisterEndpoint() { calls.probe += 1; return result; },
    async submitApplication() { calls.submit += 1; throw new Error('probe must never submit'); },
    async otpSend() { calls.send += 1; throw new Error('probe must never send'); },
    async verifyOtp() { calls.verify += 1; throw new Error('probe must never verify'); },
  };
}

describe('REGISTER-PROBE TRIGGER: handleProbeRegisterRequest gating', () => {
  let savedJwt;
  let savedAbcJwt;
  let origSeed;
  let seedCalls;

  function stubSeed(client, ok = true) {
    seedCalls = [];
    HttpGeoService.prototype.seedFromPage = async function (page) {
      seedCalls.push(page);
      if (ok) this.client = client;
      return ok;
    };
  }

  beforeEach(() => {
    savedJwt = process.env.JWT_SECRET;
    savedAbcJwt = process.env.ABC_JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.ABC_JWT_SECRET;
    origSeed = HttpGeoService.prototype.seedFromPage;
  });

  afterEach(() => {
    if (savedJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwt;
    if (savedAbcJwt === undefined) delete process.env.ABC_JWT_SECRET;
    else process.env.ABC_JWT_SECRET = savedAbcJwt;
    HttpGeoService.prototype.seedFromPage = origSeed;
  });

  it('non-object body → 400 BAD_REQUEST, session lookup never runs', async () => {
    const engine = makeEngine({ session: makeSession({}) });
    for (const bad of [null, 'x', [], 42]) {
      const r = await engine.handleProbeRegisterRequest(bad);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'BAD_REQUEST');
    }
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
  });

  it('missing/invalid/wrong-secret token → 401 UNAUTHORIZED, nothing seeded or probed', async () => {
    const engine = makeEngine({ session: makeSession({}) });
    const fake = makeFakeClient({ status: 400, isJson: true, wording: 'nope' });
    stubSeed(fake, true);
    const noToken = await engine.handleProbeRegisterRequest({});
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.body.error, 'UNAUTHORIZED');
    const garbage = await engine.handleProbeRegisterRequest({ _authToken: 'not.a.jwt' });
    assert.strictEqual(garbage.status, 401);
    const wrongSecret = await engine.handleProbeRegisterRequest({
      _authToken: (() => {
        const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const p = Buffer.from(JSON.stringify({ id: 'u1' })).toString('base64url');
        const sig = crypto.createHmac('sha256', 'wrong-secret').update(h + '.' + p).digest('base64url');
        return `${h}.${p}.${sig}`;
      })(),
    });
    assert.strictEqual(wrongSecret.status, 401);
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.probe, 0);
  });

  it('client-supplied userId is never trusted: token id wins', async () => {
    const engine = makeEngine({ session: null });
    const r = await engine.handleProbeRegisterRequest({
      userId: 'attacker', _authToken: mintToken({ id: 'u1' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.deepStrictEqual(engine.sessionManager.seenUsers, ['u1']);
  });

  it('valid token + no session → 200 NO_SESSION, no probe', async () => {
    const engine = makeEngine({ session: null });
    const fake = makeFakeClient({ status: 400, isJson: true, wording: 'nope' });
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.probe, 0);
  });

  it('valid token + session without page → 200 NO_SESSION_PAGE, no probe', async () => {
    const engine = makeEngine({ session: makeSession(null) });
    const fake = makeFakeClient({ status: 400, isJson: true, wording: 'nope' });
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION_PAGE');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.probe, 0);
  });

  it('valid token + session page + seed failure → 200 SEED_FAILED, no probe, no bare bootstrap', async () => {
    const page = { marker: 'session-page' };
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({ status: 400, isJson: true, wording: 'nope' });
    stubSeed(fake, false);
    const r = await engine.handleProbeRegisterRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'SEED_FAILED');
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
    assert.strictEqual(fake.calls.probe, 0);
  });

  it('valid token + seeded session page → probe once, nothing else, body exactly {status, isJson, wording}', async () => {
    const page = { marker: 'session-page' };
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({ status: 400, isJson: true, wording: 'Invalid Operation' });
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { status: 400, isJson: true, wording: 'Invalid Operation' });
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['isJson', 'status', 'wording']);
    assert.deepStrictEqual(engine.sessionManager.seenUsers, ['u1']);
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
    assert.strictEqual(fake.calls.probe, 1);
    assert.strictEqual(fake.calls.submit, 0);
    assert.strictEqual(fake.calls.send, 0);
    assert.strictEqual(fake.calls.verify, 0);
  });

  it('handler source calls only the probe (static proof, no other BDRIS action)', async () => {
    const src = BdrisEngineV2.prototype.handleProbeRegisterRequest.toString();
    assert.ok(src.includes('probeRegisterEndpoint'), 'must call probeRegisterEndpoint');
    assert.ok(src.includes('seedFromPage'), 'must seed via seedFromPage');
    for (const forbidden of ['submitApplication', 'otpSend', 'verifyOtp', 'saveDraftRecord', 'consumeSubmitToken']) {
      assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  it('setupHttpRoutes registers POST /probe-register and maps status/body', async () => {
    const posts = [];
    const app = { post: (p, h) => posts.push([p, h]) };
    const page = { marker: 'session-page' };
    const engine = makeEngine({ session: makeSession(page) });
    engine.setupHttpRoutes(app);
    assert.ok(posts.map((p) => p[0]).includes('/probe-register'), 'route must be registered');
    const handler = posts.find((p) => p[0] === '/probe-register')[1];
    const fake = makeFakeClient({ status: 404, isJson: true, wording: 'Not Found' });
    stubSeed(fake, true);
    let status = 0;
    let body = null;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
    await handler({ body: { _authToken: mintToken({ id: 'u1' }) } }, res);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { status: 404, isJson: true, wording: 'Not Found' });
    assert.strictEqual(fake.calls.probe, 1);
    let status2 = 0;
    let body2 = null;
    const res2 = { status: (s) => { status2 = s; return res2; }, json: (b) => { body2 = b; } };
    await handler({ body: {} }, res2);
    assert.strictEqual(status2, 401);
    assert.strictEqual(body2.error, 'UNAUTHORIZED');
  });
});
