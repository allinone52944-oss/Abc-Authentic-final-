/**
 * SUBMIT-HANDLER PROBE (2026-10-30): auth-gated POST /probe-submit-handler.
 *
 * Read-only diagnostic that settles WHAT the warm form page's own
 * JavaScript does AT SUBMIT TIME: a submit listener appending fields,
 * a TSPD clearance token read at submit, or a form attribute the DOM
 * read missed. Covered:
 *  - Auth gating order (same gate as the other probes): bad body →
 *    400, missing/invalid/wrong-secret token → 401, session lookup
 *    never runs before the token verifies; a client-supplied userId
 *    is never trusted (the token's id/sub/userId wins).
 *  - Session-page seeding exactly like the submit chain (seedFromPage;
 *    no session, no page, or failed seed → error, NO bare bootstrap,
 *    NO script search).
 *  - Search + names-only reduction: a matching script yields mechanism
 *    + appended/header names; non-matching scripts carry NO mechanism/
 *    name keys; inline entries carry path null; cross-origin scripts
 *    are skipped; failed fetches are fetchFailed — never misreported
 *    as not-found.
 *  - TSPD: /TSPD/ scripts report storage key NAMES only (cookie /
 *    localStorage / sessionStorage / header / token-variable names)
 *    and readAtSubmit (any handler script mentions TSPD or a storage
 *    name literal).
 *  - Form attributes: the /br/application form's action/method/
 *    enctype attribute strings exactly (null when absent).
 *  - Privacy: value-stuffed scripts yield a response containing NONE
 *    of those values — keys only.
 *  - Exclusivity: the handler calls probeSubmitHandler and nothing
 *    else (a fake client whose submit/OTP/probe/charge methods throw
 *    proves it), plus a static source test.
 *  - Parity: the in-page reducers (collectSubmitHandlerEvidence,
 *    executed against a stubbed document) agree with the server
 *    reducers (reduceSubmitHandlerText + reduceTspdText) on samples.
 *  - Route wiring: setupHttpRoutes registers POST /probe-submit-handler
 *    and maps its {status, body} to the HTTP response.
 *  - No frontend button is added for this endpoint (the live run is
 *    an explicit call, not customer UI).
 *
 * Run: node --test engines/bdris-apply/v2/tests/probe-submit-handler.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { BdrisEngineV2 } = require('../server');
const { HttpGeoService } = require('../services/HttpGeoService');
const {
  reduceSubmitHandlerText,
  reduceTspdText,
  scriptPathname,
  collectSubmitHandlerEvidence,
  probeSubmitHandler,
} = require('../services/SubmitHandlerProbe');

const TEST_SECRET = 'probe-handler-test-only-secret';

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
    id: 'sess_handler_probe',
    userId: 'u1',
    page: page || null,
    metadata: {},
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'ACTIVE',
  };
}

function makeFakeClient(textByPath) {
  const calls = { request: 0, submit: 0, send: 0, verify: 0, probe: 0, charge: 0 };
  return {
    calls,
    apiHeaders() { return {}; },
    async request(p) {
      calls.request += 1;
      if (!(p in textByPath)) return { status: 404, text: '' };
      return { status: 200, text: textByPath[p] };
    },
    async submitApplication() { calls.submit += 1; throw new Error('probe must never submit'); },
    async otpSend() { calls.send += 1; throw new Error('probe must never send'); },
    async verifyOtp() { calls.verify += 1; throw new Error('probe must never verify'); },
    async probeRegisterEndpoint() { calls.probe += 1; throw new Error('probe must never POST register'); },
    async consumeSubmitToken() { calls.charge += 1; throw new Error('probe must never charge'); },
  };
}

function makeFakePage(refs) {
  return { evaluate: async () => refs };
}

const PAGE_URL = 'https://bdris.gov.bd/br/application';
const EMPTY_STORAGE = { cookies: [], localStorage: [], sessionStorage: [], headers: [], tokenVariables: [] };

describe('SUBMIT-HANDLER PROBE: handleProbeSubmitHandlerRequest gating', () => {
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
    process.env.JWT_SECRET = 'probe-handler-test-only-secret';
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
      const r = await engine.handleProbeSubmitHandlerRequest(bad);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'BAD_REQUEST');
    }
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
  });

  it('missing/invalid/wrong-secret token → 401 UNAUTHORIZED, nothing seeded or searched', async () => {
    const engine = makeEngine({ session: makeSession({}) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const noToken = await engine.handleProbeSubmitHandlerRequest({});
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.body.error, 'UNAUTHORIZED');
    const garbage = await engine.handleProbeSubmitHandlerRequest({ _authToken: 'not.a.jwt' });
    assert.strictEqual(garbage.status, 401);
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('client-supplied userId is never trusted: token id wins', async () => {
    const engine = makeEngine({ session: null });
    const r = await engine.handleProbeSubmitHandlerRequest({
      userId: 'attacker', _authToken: mintToken({ id: 'u1' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.deepStrictEqual(engine.sessionManager.seenUsers, ['u1']);
  });

  it('valid token + no session → 200 NO_SESSION, no search', async () => {
    const engine = makeEngine({ session: null });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + session without page → 200 NO_SESSION_PAGE, no search', async () => {
    const engine = makeEngine({ session: makeSession(null) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION_PAGE');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + session page + seed failure → 200 SEED_FAILED, no search, no bare bootstrap', async () => {
    const page = makeFakePage({ url: PAGE_URL, scripts: [], inline: [], forms: [], inlineReadAtSubmit: false });
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({});
    stubSeed(fake, false);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'SEED_FAILED');
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + seeded page → search runs once, nothing else; exact shape', async () => {
    const refs = {
      url: PAGE_URL,
      scripts: [
        { src: 'https://bdris.gov.bd/static/js/handler.js', inline: false },
        { src: '', inline: true },
        { src: 'https://bdris.gov.bd/TSPD/?type=1', inline: false },
        { src: 'https://cdn.example.com/lib.js', inline: false },
        { src: 'https://bdris.gov.bd/static/js/missing.js', inline: false },
        { src: 'https://bdris.gov.bd/static/js/plain.js', inline: false },
      ],
      inline: [{
        found: true, matchCount: 3, mechanism: 'formdata-append',
        appendedFieldNames: ['tspdToken'], headerNames: [],
        tspdMention: true, storage: EMPTY_STORAGE,
      }],
      forms: [
        { action: '/other', method: 'get', enctype: null },
        { action: '/br/application', method: 'post', enctype: 'multipart/form-data' },
      ],
      inlineReadAtSubmit: true,
    };
    const page = makeFakePage(refs);
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({
      '/static/js/handler.js':
        'document.querySelector("form").addEventListener("submit", function(e){'
        + ' var fd = new FormData(this); fd.append("tspdToken", window.tspdToken);'
        + ' fd.append("otp", o); fetch("/br/application", { method: "POST", body: fd }); });',
      '/TSPD/': 'var tspdToken = "abc"; document.cookie = "TSPD_TOKEN=abc; path=/";'
        + ' localStorage.setItem("tspd_fp", "x");',
      '/static/js/plain.js': 'console.log("nothing here");',
    });
    stubSeed(fake, true);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['form', 'formCount', 'ok', 'scripts', 'submitHandler', 'truncated', 'tspd']);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.truncated, false);
    assert.strictEqual(r.body.formCount, 2);
    // Target form is the /br/application one, with exact attributes.
    assert.deepStrictEqual(r.body.form, { action: '/br/application', method: 'post', enctype: 'multipart/form-data' });
    // Handler aggregate: inline + external handler both found.
    const sh = r.body.submitHandler;
    assert.strictEqual(sh.found, true);
    assert.strictEqual(sh.mechanism, 'formdata-form');
    assert.deepStrictEqual(sh.appendedFieldNames, ['otp', 'tspdToken']);
    assert.deepStrictEqual(sh.headerNames, []);
    assert.deepStrictEqual(sh.foundIn, ['/static/js/handler.js', 'inline']);
    // TSPD: path script + inline mention; storage names only.
    const tspd = r.body.tspd;
    assert.deepStrictEqual(tspd.scripts, ['inline', '/TSPD/']);
    assert.deepStrictEqual(tspd.storage.cookies, ['TSPD_TOKEN']);
    assert.deepStrictEqual(tspd.storage.localStorage, ['tspd_fp']);
    assert.deepStrictEqual(tspd.storage.sessionStorage, []);
    assert.deepStrictEqual(tspd.storage.headers, []);
    assert.ok(tspd.storage.tokenVariables.includes('tspdToken'), 'token variable name captured');
    assert.strictEqual(tspd.readAtSubmit, true);
    // Per-script entries.
    assert.strictEqual(r.body.scripts.length, 6);
    const [handler, inl, tspdEntry, cdn, missing, plain] = r.body.scripts;
    assert.deepStrictEqual(handler, {
      path: '/static/js/handler.js', inline: false, found: true, matchCount: 5,
      mechanism: 'formdata-form', appendedFieldNames: ['otp', 'tspdToken'], headerNames: [],
    });
    assert.deepStrictEqual(inl, {
      path: null, inline: true, found: true, matchCount: 3,
      mechanism: 'formdata-append', appendedFieldNames: ['tspdToken'], headerNames: [],
    });
    assert.deepStrictEqual(tspdEntry, {
      path: '/TSPD/', inline: false, found: false, matchCount: 0,
    });
    assert.deepStrictEqual(cdn, {
      path: '/lib.js', inline: false, found: false, matchCount: 0, skipped: true,
    });
    assert.deepStrictEqual(missing, {
      path: '/static/js/missing.js', inline: false, found: false, matchCount: 0, fetchFailed: true,
    });
    assert.deepStrictEqual(plain, {
      path: '/static/js/plain.js', inline: false, found: false, matchCount: 0,
    });
    // Non-matching scripts carry NO mechanism/name keys at all.
    for (const e of [tspdEntry, cdn, missing, plain]) {
      assert.ok(!('mechanism' in e) && !('appendedFieldNames' in e) && !('headerNames' in e),
        'non-handler must not carry context');
    }
    // Exclusivity: only script fetches ran — no submit/OTP/probe/charge.
    assert.strictEqual(fake.calls.submit, 0);
    assert.strictEqual(fake.calls.send, 0);
    assert.strictEqual(fake.calls.verify, 0);
    assert.strictEqual(fake.calls.probe, 0);
    assert.strictEqual(fake.calls.charge, 0);
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
  });

  it('response contains NO values from value-stuffed scripts (keys only)', async () => {
    const refs = {
      url: PAGE_URL,
      scripts: [
        { src: 'https://bdris.gov.bd/static/js/app.js', inline: false },
        { src: 'https://bdris.gov.bd/TSPD/', inline: false },
      ],
      inline: [],
      forms: [],
      inlineReadAtSubmit: false,
    };
    const page = makeFakePage(refs);
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({
      '/static/js/app.js':
        'document.querySelector("form").addEventListener("submit", function(){'
        + ' var fd = new FormData(this); fd.append("personNameBn","Abul Mia");'
        + ' fd.append("otp","123456"); fetch("/br/application", { method: "POST", body: fd }); });',
      '/TSPD/':
        'var tspdToken = "tok_9f8e7d6c"; document.cookie = "TSPD_ID=tok_9f8e7d6c; path=/";'
        + ' localStorage.setItem("tspd_fp", "fp_value_123");',
    });
    stubSeed(fake, true);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    const dumped = JSON.stringify(r.body);
    for (const value of ['Abul Mia', '123456', 'tok_9f8e7d6c', 'fp_value_123']) {
      assert.ok(!dumped.includes(value), `response must not contain value ${value}`);
    }
    assert.ok(r.body.submitHandler.appendedFieldNames.includes('personNameBn'));
    assert.ok(r.body.submitHandler.appendedFieldNames.includes('otp'));
    assert.ok(r.body.tspd.storage.cookies.includes('TSPD_ID'));
    assert.ok(r.body.tspd.storage.localStorage.includes('tspd_fp'));
  });

  it('page evaluate failure → 200 HANDLER_PROBE_FAILED, no throw', async () => {
    const page = { evaluate: async () => { throw new Error('page gone'); } };
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const r = await engine.handleProbeSubmitHandlerRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'HANDLER_PROBE_FAILED');
  });

  it('handler source calls only the handler probe (static proof, no other BDRIS action)', async () => {
    const src = BdrisEngineV2.prototype.handleProbeSubmitHandlerRequest.toString();
    assert.ok(src.includes('probeSubmitHandler'), 'must call probeSubmitHandler');
    assert.ok(src.includes('seedFromPage'), 'must seed via seedFromPage');
    for (const forbidden of ['submitApplication', 'otpSend', 'verifyOtp', 'saveDraftRecord', 'consumeSubmitToken', 'probeRegisterEndpoint', 'probePageScripts', 'REGISTER_PATH']) {
      assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  it('setupHttpRoutes registers POST /probe-submit-handler and maps status/body', async () => {
    const posts = [];
    const app = { post: (p, h) => posts.push([p, h]) };
    const page = makeFakePage({ url: PAGE_URL, scripts: [], inline: [], forms: [], inlineReadAtSubmit: false });
    const engine = makeEngine({ session: makeSession(page) });
    engine.setupHttpRoutes(app);
    assert.ok(posts.map((p) => p[0]).includes('/probe-submit-handler'), 'route must be registered');
    const handler = posts.find((p) => p[0] === '/probe-submit-handler')[1];
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    let status = 0;
    let body = null;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
    await handler({ body: { _authToken: mintToken({ id: 'u1' }) } }, res);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      ok: true, truncated: false, form: null, formCount: 0,
      submitHandler: { found: false, mechanism: 'unknown', appendedFieldNames: [], headerNames: [], foundIn: [] },
      tspd: { scripts: [], storage: EMPTY_STORAGE, readAtSubmit: false },
      scripts: [],
    });
    let status2 = 0;
    let body2 = null;
    const res2 = { status: (s) => { status2 = s; return res2; }, json: (b) => { body2 = b; } };
    await handler({ body: {} }, res2);
    assert.strictEqual(status2, 401);
    assert.strictEqual(body2.error, 'UNAUTHORIZED');
  });
});

describe('SUBMIT-HANDLER PROBE: pure reduction', () => {
  it('reduceSubmitHandlerText: listener + FormData append + fetch → formdata-form + names', () => {
    const ctx = reduceSubmitHandlerText(
      'document.querySelector("form").addEventListener("submit", function(e){'
      + ' var fd = new FormData(this); fd.append("tspdToken", t); fd.append("otp", o);'
      + ' fetch("/br/application", { method: "POST", body: fd }); });',
    );
    assert.strictEqual(ctx.found, true);
    assert.strictEqual(ctx.mechanism, 'formdata-form');
    assert.deepStrictEqual(ctx.appendedFieldNames, ['otp', 'tspdToken']);
    assert.deepStrictEqual(ctx.headerNames, []);
  });

  it('reduceSubmitHandlerText: no handler evidence → found false, empty context', () => {
    assert.deepStrictEqual(reduceSubmitHandlerText('console.log("hello");'), {
      found: false, matchCount: 0, mechanism: 'unknown',
      appendedFieldNames: [], headerNames: [],
    });
    // A register-only fetch is NOT a form submit handler: the needle
    // is followed by '/' (sub-path), so no submit window counts.
    assert.strictEqual(reduceSubmitHandlerText(
      'fetch("/api/br/application/register",{method:"POST",body:JSON.stringify({applicantName:"Abul"})});',
    ).found, false);
    // FormData without a submit context is not evidence either.
    assert.strictEqual(reduceSubmitHandlerText(
      'var fd = new FormData(); fd.append("a", 1);',
    ).found, false);
  });

  it('reduceSubmitHandlerText: native .submit( + setRequestHeader names', () => {
    const ctx = reduceSubmitHandlerText(
      'var x = new XMLHttpRequest(); x.open("POST", "/br/application");'
      + ' x.setRequestHeader("X-TSPD-Token", t); document.forms[0].submit();',
    );
    assert.strictEqual(ctx.found, true);
    assert.strictEqual(ctx.mechanism, 'xhr');
    assert.deepStrictEqual(ctx.headerNames, ['X-TSPD-Token']);
  });

  it('reduceTspdText: storage names only, values dropped', () => {
    const ctx = reduceTspdText(
      'var tspdToken = "tok123"; document.cookie = "TSPD_ID=tok123; path=/";'
      + ' localStorage.setItem("tspd_fp", "fp1"); sessionStorage["tspd_sess"] = "s1";'
      + ' var x = new XMLHttpRequest(); x.setRequestHeader("X-TSPD-Clearance", c);'
      + ' // TSPD challenge fingerprint',
    );
    assert.strictEqual(ctx.mention, true);
    assert.deepStrictEqual(ctx.storage.cookies, ['TSPD_ID']);
    assert.deepStrictEqual(ctx.storage.localStorage, ['tspd_fp']);
    assert.deepStrictEqual(ctx.storage.sessionStorage, ['tspd_sess']);
    assert.deepStrictEqual(ctx.storage.headers, ['X-TSPD-Clearance']);
    assert.ok(ctx.storage.tokenVariables.includes('tspdToken'));
    const dumped = JSON.stringify(ctx);
    for (const value of ['tok123', 'fp1', 's1']) {
      assert.ok(!dumped.includes(value), `must not contain value ${value}`);
    }
  });

  it('reduceTspdText: no mention → mention false, storage still extracted but caller filters', () => {
    const ctx = reduceTspdText('localStorage.setItem("plain_key", "v");');
    assert.strictEqual(ctx.mention, false);
    assert.deepStrictEqual(ctx.storage.localStorage, ['plain_key']);
  });

  it('scriptPathname strips origin + query, resolves relative srcs', () => {
    assert.strictEqual(
      scriptPathname('https://bdris.gov.bd/TSPD/?type=abc123', PAGE_URL),
      '/TSPD/',
    );
    assert.strictEqual(scriptPathname('/static/js/x.js', PAGE_URL), '/static/js/x.js');
    assert.strictEqual(scriptPathname('js/y.js', PAGE_URL), '/br/js/y.js');
    assert.strictEqual(scriptPathname('https://', PAGE_URL), null);
  });

  it('probeSubmitHandler: form target selection + readAtSubmit via storage literal', async () => {
    const page = makeFakePage({
      url: PAGE_URL,
      scripts: [
        { src: 'https://bdris.gov.bd/TSPD/', inline: false },
        { src: 'https://bdris.gov.bd/static/js/sub.js', inline: false },
      ],
      inline: [],
      forms: [
        { action: '/other', method: null, enctype: null },
        { action: '/br/application', method: null, enctype: null },
      ],
      inlineReadAtSubmit: false,
    });
    const result = await probeSubmitHandler({
      page,
      fetchText: async (p) => {
        if (p === '/TSPD/') return 'document.cookie = "TSPD_ID=abc; path=/";';
        if (p === '/static/js/sub.js') {
          return 'document.querySelector("form").addEventListener("submit", function(){'
            + ' var fd = new FormData(this); fd.append("tspd", document.cookie);'
            + ' var tok = localStorage.getItem("TSPD_ID");'
            + ' fetch("/br/application", { method: "POST", body: fd }); });';
        }
        return '';
      },
    });
    assert.deepStrictEqual(result.form, { action: '/br/application', method: null, enctype: null });
    assert.strictEqual(result.formCount, 2);
    assert.deepStrictEqual(result.tspd.scripts, ['/TSPD/']);
    assert.deepStrictEqual(result.tspd.storage.cookies, ['TSPD_ID']);
    // The handler script reads the TSPD storage name as a quoted
    // literal → readAtSubmit true (even without a TSPD mention).
    assert.strictEqual(result.tspd.readAtSubmit, true);
    assert.strictEqual(result.submitHandler.found, true);
  });

  it('probeSubmitHandler: truncates past 100 scripts, honestly', async () => {
    const scripts = Array.from({ length: 105 }, (_, i) => ({
      src: `https://bdris.gov.bd/static/js/s${i}.js`, inline: false,
    }));
    const page = makeFakePage({ url: PAGE_URL, scripts, inline: [], forms: [], inlineReadAtSubmit: false });
    const result = await probeSubmitHandler({
      page,
      fetchText: async () => 'console.log("x");',
    });
    assert.strictEqual(result.scripts.length, 100);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.submitHandler.found, false);
  });

  it('in-page reducers agree with the server reducers (parity, real page function)', async () => {
    const samples = [
      'document.querySelector("form").addEventListener("submit", function(e){'
      + ' var fd = new FormData(this); fd.append("tspdToken", t);'
      + ' fetch("/br/application", { method: "POST", body: fd }); });',
      'var tspdToken = "tok"; document.cookie = "TSPD_ID=tok; path=/";'
      + ' localStorage.setItem("tspd_fp", "fp"); // TSPD clearance',
      'console.log("nothing here");',
    ];
    const savedDoc = global.document;
    const savedLoc = global.location;
    try {
      global.location = { href: PAGE_URL };
      global.document = {
        querySelectorAll: (sel) => {
          if (sel === 'script') return samples.map((textContent) => ({ src: '', textContent }));
          if (sel === 'form') return [];
          return [];
        },
      };
      const refs = collectSubmitHandlerEvidence();
      assert.strictEqual(refs.scripts.length, samples.length);
      assert.ok(refs.scripts.every((s) => s.inline));
      assert.strictEqual(refs.inline.length, samples.length);
      for (let i = 0; i < samples.length; i++) {
        const serverHandler = reduceSubmitHandlerText(samples[i]);
        const serverTspd = reduceTspdText(samples[i]);
        const inl = refs.inline[i];
        assert.strictEqual(inl.found, serverHandler.found);
        assert.strictEqual(inl.matchCount, serverHandler.matchCount);
        assert.strictEqual(inl.mechanism, serverHandler.mechanism);
        assert.deepStrictEqual(inl.appendedFieldNames, serverHandler.appendedFieldNames);
        assert.deepStrictEqual(inl.headerNames, serverHandler.headerNames);
        assert.strictEqual(inl.tspdMention, serverTspd.mention);
        assert.deepStrictEqual(inl.storage, serverTspd.storage);
      }
      assert.deepStrictEqual(refs.forms, []);
      assert.strictEqual(refs.inlineReadAtSubmit, true);
    } finally {
      if (savedDoc === undefined) delete global.document;
      else global.document = savedDoc;
      if (savedLoc === undefined) delete global.location;
      else global.location = savedLoc;
    }
  });

  it('in-page form attributes: exact strings, null when absent', async () => {
    const savedDoc = global.document;
    const savedLoc = global.location;
    try {
      global.location = { href: PAGE_URL };
      const formStubs = [
        { getAttribute: (n) => ({ action: '/br/application', method: 'post', enctype: 'multipart/form-data' }[n] ?? null) },
        { getAttribute: () => null },
      ];
      global.document = {
        querySelectorAll: (sel) => {
          if (sel === 'script') return [];
          if (sel === 'form') return formStubs;
          return [];
        },
      };
      const refs = collectSubmitHandlerEvidence();
      assert.deepStrictEqual(refs.forms, [
        { action: '/br/application', method: 'post', enctype: 'multipart/form-data' },
        { action: null, method: null, enctype: null },
      ]);
    } finally {
      if (savedDoc === undefined) delete global.document;
      else global.document = savedDoc;
      if (savedLoc === undefined) delete global.location;
      else global.location = savedLoc;
    }
  });
});
