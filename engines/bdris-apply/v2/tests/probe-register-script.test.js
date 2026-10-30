/**
 * REGISTER-SCRIPT PROBE (2026-10-30): auth-gated POST /probe-register-script.
 *
 * Read-only diagnostic that settles WHERE the warm form page itself
 * calls /api/br/application/register: script refs from the user's warm
 * page, same-origin script texts fetched with the seeded client, result
 * reduced to paths/booleans/counts/payload key NAMES only. Covered:
 *  - Auth gating order (same gate as /probe-register): bad body →
 *    400, missing/invalid/wrong-secret token → 401, session lookup
 *    never runs before the token verifies; a client-supplied userId
 *    is never trusted (the token's id/sub/userId wins).
 *  - Session-page seeding exactly like the submit chain (seedFromPage;
 *    no session, no page, or failed seed → error, NO bare bootstrap,
 *    NO script search).
 *  - Search + names-only reduction: matching external script yields
 *    method + fieldNames; non-matching scripts carry NO method/
 *    fieldNames keys; inline entries carry path null; cross-origin
 *    scripts are skipped (base-bound client cannot fetch them);
 *    failed fetches are fetchFailed — never misreported as not-found.
 *  - Submit construction + engine diff: the form's OWN submit POST
 *    (inline handler first, then external scripts) is reported as
 *    URL/method/contentType/mechanism plus JS key names and the DOM
 *    form's input names, diffed against the engine's live
 *    buildSubmitPayload wire list (extraVsEngine/missingVsEngine);
 *    a register URL (/br/application/register) is NOT mistaken for
 *    the form POST (exact-path rule, tested).
 *  - Privacy: a script text stuffed with realistic values (phone-like
 *    digits, OTP-like code, a name, a token-like string) yields a
 *    response containing NONE of those values — keys only.
 *  - Exclusivity: the handler calls probePageScripts and nothing else
 *    (a fake client whose submit/OTP/probe/charge methods throw proves
 *    it), plus a static source test.
 *  - Parity: the in-page reducer (collectWarmPageScripts, executed
 *    against a stubbed document) agrees with the server reducer
 *    (reduceRegisterText) on the same samples.
 *  - Route wiring: setupHttpRoutes registers POST /probe-register-script
 *    and maps its {status, body} to the HTTP response.
 *  - No frontend button is added for this endpoint (the live run is
 *    an explicit call, not customer UI).
 *
 * Run: node --test engines/bdris-apply/v2/tests/probe-register-script.test.js
 * (from engines/bdris-apply/)
 */

'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { BdrisEngineV2 } = require('../server');
const { HttpGeoService } = require('../services/HttpGeoService');
const {
  reduceRegisterText,
  extractSubmitPost,
  ENGINE_SUBMIT_FIELDS,
  scriptPathname,
  collectWarmPageScripts,
  probePageScripts,
} = require('../services/RegisterScriptProbe');
const { buildSubmitPayload } = require('../http/client');

const TEST_SECRET = 'probe-script-test-only-secret';

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
    id: 'sess_script_probe',
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

describe('REGISTER-SCRIPT PROBE: handleProbeRegisterScriptRequest gating', () => {
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
    process.env.JWT_SECRET = 'probe-script-test-only-secret';
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
      const r = await engine.handleProbeRegisterScriptRequest(bad);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'BAD_REQUEST');
    }
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
  });

  it('missing/invalid/wrong-secret token → 401 UNAUTHORIZED, nothing seeded or searched', async () => {
    const engine = makeEngine({ session: makeSession({}) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const noToken = await engine.handleProbeRegisterScriptRequest({});
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.body.error, 'UNAUTHORIZED');
    const garbage = await engine.handleProbeRegisterScriptRequest({ _authToken: 'not.a.jwt' });
    assert.strictEqual(garbage.status, 401);
    assert.deepStrictEqual(engine.sessionManager.seenUsers, []);
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('client-supplied userId is never trusted: token id wins', async () => {
    const engine = makeEngine({ session: null });
    const r = await engine.handleProbeRegisterScriptRequest({
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
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + session without page → 200 NO_SESSION_PAGE, no search', async () => {
    const engine = makeEngine({ session: makeSession(null) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'NO_SESSION_PAGE');
    assert.strictEqual(seedCalls.length, 0);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + session page + seed failure → 200 SEED_FAILED, no search, no bare bootstrap', async () => {
    const page = makeFakePage({ url: PAGE_URL, scripts: [], inline: [] });
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({});
    stubSeed(fake, false);
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'SEED_FAILED');
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
    assert.strictEqual(fake.calls.request, 0);
  });

  it('valid token + seeded page → search runs once, nothing else; shape exactly {ok, found, scripts, truncated}', async () => {
    const refs = {
      url: PAGE_URL,
      scripts: [
        { src: 'https://bdris.gov.bd/static/js/main.js', inline: false },
        { src: '', inline: true },
        { src: 'https://cdn.example.com/lib.js', inline: false },
        { src: 'https://bdris.gov.bd/static/js/missing.js', inline: false },
        { src: 'https://bdris.gov.bd/static/js/plain.js', inline: false },
      ],
      inline: [{ found: true, matchCount: 2, method: 'POST', fieldNames: ['applicantName', 'otp'] }],
      submit: { found: true, url: '/br/application', method: 'POST', contentType: 'multipart/form-data', mechanism: 'formdata-append', jsFieldNames: ['otp'] },
      formFieldNames: ['personInfoForBirth.personFirstNameBn', 'extraFormField'],
      formActions: [],
    };
    const page = makeFakePage(refs);
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({
      '/static/js/main.js': 'fetch("/api/br/application/register",{method:"POST",body:JSON.stringify({applicantName:"Abul",phone:"01712345678"})})',
      '/static/js/plain.js': 'console.log("nothing here");',
    });
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['found', 'ok', 'scripts', 'submitPost', 'truncated']);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.found, true);
    assert.strictEqual(r.body.truncated, false);
    assert.strictEqual(r.body.scripts.length, 5);
    const [main, inl, cdn, missing, plain] = r.body.scripts;
    assert.deepStrictEqual(main, {
      path: '/static/js/main.js', inline: false, found: true, matchCount: 1,
      method: 'POST', fieldNames: ['applicantName', 'phone'],
    });
    assert.deepStrictEqual(inl, {
      path: null, inline: true, found: true, matchCount: 2,
      method: 'POST', fieldNames: ['applicantName', 'otp'],
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
    // Non-matching scripts carry NO method/fieldNames keys at all.
    for (const e of [cdn, missing, plain]) {
      assert.ok(!('method' in e) && !('fieldNames' in e), 'non-match must not carry context');
    }
    // Submit construction: inline evidence wins; the register fetch
    // in main.js is NOT mistaken for the form POST (exact-path rule),
    // so no external path joins foundIn and no register key leaks in.
    const sp = r.body.submitPost;
    assert.strictEqual(sp.found, true);
    assert.deepStrictEqual(sp.foundIn, ['inline']);
    assert.strictEqual(sp.url, '/br/application');
    assert.strictEqual(sp.urlSource, 'js');
    assert.strictEqual(sp.method, 'POST');
    assert.strictEqual(sp.contentType, 'multipart/form-data');
    assert.strictEqual(sp.mechanism, 'formdata-append');
    assert.deepStrictEqual(sp.jsFieldNames, ['otp']);
    assert.deepStrictEqual(sp.formFieldNames, ['extraFormField', 'personInfoForBirth.personFirstNameBn']);
    assert.deepStrictEqual(sp.formActions, []);
    assert.deepStrictEqual(sp.fieldNames, ['extraFormField', 'otp', 'personInfoForBirth.personFirstNameBn']);
    assert.deepStrictEqual(sp.extraVsEngine, ['extraFormField']);
    assert.ok(!sp.missingVsEngine.includes('otp'), 'otp is an engine field');
    assert.ok(!sp.missingVsEngine.includes('personInfoForBirth.personFirstNameBn'));
    assert.ok(sp.missingVsEngine.includes('_csrf'), 'engine _csrf is missing from handler evidence');
    assert.ok(sp.missingVsEngine.includes('personInfoForBirth.personLastNameBn'));
    // Exclusivity: only script fetches ran — no submit/OTP/probe/charge.
    assert.strictEqual(fake.calls.submit, 0);
    assert.strictEqual(fake.calls.send, 0);
    assert.strictEqual(fake.calls.verify, 0);
    assert.strictEqual(fake.calls.probe, 0);
    assert.strictEqual(fake.calls.charge, 0);
    assert.strictEqual(seedCalls.length, 1);
    assert.strictEqual(seedCalls[0], page);
  });

  it('response contains NO values from a value-stuffed script (keys only)', async () => {
    const refs = {
      url: PAGE_URL,
      scripts: [{ src: 'https://bdris.gov.bd/static/js/app.js', inline: false }],
      inline: [],
    };
    const page = makeFakePage(refs);
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({
      '/static/js/app.js':
        'var fd=new FormData();'
        + 'fd.append("personNameBn","Abul Mia");'
        + 'fd.append("otp","123456");'
        + 'fetch("/api/br/application/register?phone=01712345678&applicantName=Abul",{method:"POST",body:fd});'
        + 'var token="eyJhbGciOiJIUzI1NiJ9.secret";',
    });
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    const dumped = JSON.stringify(r.body);
    for (const value of ['Abul Mia', '123456', '01712345678', 'eyJhbGciOiJIUzI1NiJ9']) {
      assert.ok(!dumped.includes(value), `response must not contain value ${value}`);
    }
    const entry = r.body.scripts[0];
    assert.strictEqual(entry.found, true);
    assert.strictEqual(entry.method, 'POST');
    for (const key of ['personNameBn', 'otp', 'phone', 'applicantName']) {
      assert.ok(entry.fieldNames.includes(key), `fieldNames must include ${key}`);
    }
  });

  it('page evaluate failure → 200 SCRIPT_PROBE_FAILED, no throw', async () => {
    const page = { evaluate: async () => { throw new Error('page gone'); } };
    const engine = makeEngine({ session: makeSession(page) });
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    const r = await engine.handleProbeRegisterScriptRequest({ _authToken: mintToken({ id: 'u1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.error, 'SCRIPT_PROBE_FAILED');
  });

  it('handler source calls only the script probe (static proof, no other BDRIS action)', async () => {
    const src = BdrisEngineV2.prototype.handleProbeRegisterScriptRequest.toString();
    assert.ok(src.includes('probePageScripts'), 'must call probePageScripts');
    assert.ok(src.includes('seedFromPage'), 'must seed via seedFromPage');
    for (const forbidden of ['submitApplication', 'otpSend', 'verifyOtp', 'saveDraftRecord', 'consumeSubmitToken', 'probeRegisterEndpoint', 'REGISTER_PATH']) {
      assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  it('setupHttpRoutes registers POST /probe-register-script and maps status/body', async () => {
    const posts = [];
    const app = { post: (p, h) => posts.push([p, h]) };
    const page = makeFakePage({ url: PAGE_URL, scripts: [], inline: [] });
    const engine = makeEngine({ session: makeSession(page) });
    engine.setupHttpRoutes(app);
    assert.ok(posts.map((p) => p[0]).includes('/probe-register-script'), 'route must be registered');
    const handler = posts.find((p) => p[0] === '/probe-register-script')[1];
    const fake = makeFakeClient({});
    stubSeed(fake, true);
    let status = 0;
    let body = null;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
    await handler({ body: { _authToken: mintToken({ id: 'u1' }) } }, res);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      ok: true, found: false, scripts: [], truncated: false,
      submitPost: {
        found: false, foundIn: [], url: null, urlSource: null, method: null,
        contentType: null, mechanism: 'unknown', jsFieldNames: [],
        formFieldNames: [], formActions: [], fieldNames: [],
        extraVsEngine: [], missingVsEngine: ENGINE_SUBMIT_FIELDS,
      },
    });
    let status2 = 0;
    let body2 = null;
    const res2 = { status: (s) => { status2 = s; return res2; }, json: (b) => { body2 = b; } };
    await handler({ body: {} }, res2);
    assert.strictEqual(status2, 401);
    assert.strictEqual(body2.error, 'UNAUTHORIZED');
  });
});

describe('REGISTER-SCRIPT PROBE: pure reduction', () => {
  it('reduceRegisterText: fetch call → POST + key names only, values dropped', () => {
    const ctx = reduceRegisterText(
      'fetch("/api/br/application/register",{method:"POST",headers:{"Content-Type":"application/json"},'
      + 'body:JSON.stringify({applicantName:"Abul",applicantBrn:"",phone:"01712345678",otp:"123456"})});',
    );
    assert.strictEqual(ctx.found, true);
    assert.strictEqual(ctx.matchCount, 1);
    assert.strictEqual(ctx.method, 'POST');
    for (const key of ['applicantName', 'applicantBrn', 'phone', 'otp']) {
      assert.ok(ctx.fieldNames.includes(key), `must include ${key}`);
    }
    const dumped = JSON.stringify(ctx);
    for (const value of ['Abul', '01712345678', '123456']) {
      assert.ok(!dumped.includes(value), `must not contain value ${value}`);
    }
    // Transport keys are not payload fields.
    for (const noise of ['method', 'headers', 'body']) {
      assert.ok(!ctx.fieldNames.includes(noise), `must not include transport key ${noise}`);
    }
  });

  it('reduceRegisterText: no match → found false, no context keys', () => {
    assert.deepStrictEqual(reduceRegisterText('console.log("hello");'), {
      found: false, matchCount: 0, method: null, fieldNames: [],
    });
  });

  it('reduceRegisterText: FormData appends + query keys + jQuery type', () => {
    const ctx = reduceRegisterText(
      'var fd=new FormData();fd.append("personNameBn",n);fd.append("geoLocationId",g);'
      + '$.ajax({type:"POST",url:"/api/br/application/register?officeId=0",data:fd});',
    );
    assert.strictEqual(ctx.found, true);
    assert.strictEqual(ctx.method, 'POST');
    for (const key of ['personNameBn', 'geoLocationId', 'officeId']) {
      assert.ok(ctx.fieldNames.includes(key), `must include ${key}`);
    }
  });

  it('scriptPathname strips origin + query, resolves relative srcs', () => {
    assert.strictEqual(
      scriptPathname('https://bdris.gov.bd/static/js/main.js?v=abc123', PAGE_URL),
      '/static/js/main.js',
    );
    assert.strictEqual(scriptPathname('/static/js/x.js', PAGE_URL), '/static/js/x.js');
    assert.strictEqual(scriptPathname('js/y.js', PAGE_URL), '/br/js/y.js');
    assert.strictEqual(scriptPathname('https://', PAGE_URL), null);
  });

  it('probePageScripts truncates past 100 scripts, honestly', async () => {
    const scripts = Array.from({ length: 105 }, (_, i) => ({
      src: `https://bdris.gov.bd/static/js/s${i}.js`, inline: false,
    }));
    const page = makeFakePage({ url: PAGE_URL, scripts, inline: [] });
    const result = await probePageScripts({
      page,
      fetchText: async () => 'console.log("x");',
    });
    assert.strictEqual(result.scripts.length, 100);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.found, false);
  });

  it('in-page reducer agrees with the server reducer (parity, real page function)', async () => {
    const samples = [
      'fetch("/api/br/application/register",{method:"POST",body:JSON.stringify({applicantName:"Abul",otp:"123456"})});',
      'var fd=new FormData();fd.append("personNameBn",n);$.ajax({type:"POST",url:"/api/br/application/register",data:fd});',
      'console.log("nothing here");',
    ];
    const savedDoc = global.document;
    const savedLoc = global.location;
    try {
      global.location = { href: PAGE_URL };
      global.document = {
        querySelectorAll: () => samples.map((textContent) => ({ src: '', textContent })),
      };
      const refs = collectWarmPageScripts();
      assert.strictEqual(refs.scripts.length, samples.length);
      assert.ok(refs.scripts.every((s) => s.inline));
      assert.strictEqual(refs.inline.length, samples.length);
      for (let i = 0; i < samples.length; i++) {
        assert.deepStrictEqual(refs.inline[i], reduceRegisterText(samples[i]));
      }
    } finally {
      if (savedDoc === undefined) delete global.document;
      else global.document = savedDoc;
      if (savedLoc === undefined) delete global.location;
      else global.location = savedLoc;
    }
  });
});

describe('REGISTER-SCRIPT PROBE: submit construction', () => {
  it('extractSubmitPost: FormData-append sample → exact URL/method/multipart/keys', () => {
    const sub = extractSubmitPost(
      'var fd = new FormData(); fd.append("personInfoForBirth.personFirstNameBn", a);'
      + ' fd.append("otp", o); fetch("/br/application", { method: "POST", body: fd });',
    );
    assert.strictEqual(sub.found, true);
    assert.strictEqual(sub.url, '/br/application');
    assert.strictEqual(sub.method, 'POST');
    assert.strictEqual(sub.contentType, 'multipart/form-data');
    assert.strictEqual(sub.mechanism, 'formdata-append');
    assert.deepStrictEqual(sub.jsFieldNames, ['otp', 'personInfoForBirth.personFirstNameBn']);
  });

  it('extractSubmitPost: JSON submit + form-serialization mechanism', () => {
    const js = extractSubmitPost(
      '$.ajax({type:"POST",url:"/br/application",contentType:"application/json",'
      + 'data:JSON.stringify({applicantName:"A",otp:"123456"})});',
    );
    assert.strictEqual(js.found, true);
    assert.strictEqual(js.url, '/br/application');
    assert.strictEqual(js.method, 'POST');
    assert.strictEqual(js.contentType, 'application/json');
    assert.strictEqual(js.mechanism, 'json');
    assert.ok(js.jsFieldNames.includes('applicantName') && js.jsFieldNames.includes('otp'));
    const form = extractSubmitPost(
      'document.querySelector("form").addEventListener("submit", function(e){'
      + ' var fd = new FormData(this); fetch("/br/application", { method: "POST", body: fd }); });',
    );
    assert.strictEqual(form.found, true);
    assert.strictEqual(form.mechanism, 'formdata-form');
    assert.deepStrictEqual(form.jsFieldNames, []);
  });

  it('extractSubmitPost: register URL is NOT the form POST; bare mention is NOT evidence', () => {
    assert.strictEqual(extractSubmitPost(
      'fetch("/api/br/application/register",{method:"POST",body:JSON.stringify({applicantName:"Abul"})});',
    ).found, false);
    assert.strictEqual(extractSubmitPost(
      'var u = "/br/application"; console.log(u);',
    ).found, false);
  });

  it('ENGINE_SUBMIT_FIELDS equals the live buildSubmitPayload wire list', () => {
    const addr = {
      division: 'Dhaka', district: 'Dhaka', cityCorpUpazila: 'X',
      postOfficeBn: 'PO', postOfficeEn: 'PO', villageBn: 'V', villageEn: 'V',
    };
    const payload = buildSubmitPayload({
      person: { firstNameBn: 'A', firstNameEn: 'A', dob: '1980-02-02', thChild: '১', gender: 'MALE' },
      father: { nameBn: 'F', nameEn: 'F' },
      mother: { nameBn: 'M', nameEn: 'M' },
      birthPlace: addr, permAddr: addr, prsntAddr: addr,
      relation: 'SELF', phone: '01700000000', otp: '123456',
      documents: [{ attachmentType: 40, id: '1' }, { attachmentType: 41, id: '2' }],
    });
    assert.deepStrictEqual([...Object.keys(payload), '_csrf'].sort(), ENGINE_SUBMIT_FIELDS);
  });

  it('probePageScripts: external submit evidence + form-action fallback', async () => {
    const page = makeFakePage({
      url: PAGE_URL,
      scripts: [{ src: 'https://bdris.gov.bd/static/js/app.js', inline: false }],
      inline: [],
    });
    const result = await probePageScripts({
      page,
      fetchText: async () => 'var fd = new FormData(); fd.append("declaration", d);'
        + ' fetch("/br/application", { method: "POST", body: fd });',
    });
    assert.strictEqual(result.submitPost.found, true);
    assert.deepStrictEqual(result.submitPost.foundIn, ['/static/js/app.js']);
    assert.strictEqual(result.submitPost.url, '/br/application');
    assert.strictEqual(result.submitPost.urlSource, 'js');
    assert.strictEqual(result.submitPost.mechanism, 'formdata-append');
    assert.deepStrictEqual(result.submitPost.jsFieldNames, ['declaration']);
    assert.ok(!result.submitPost.missingVsEngine.includes('declaration'));

    const formOnly = makeFakePage({
      url: PAGE_URL,
      scripts: [],
      inline: [],
      submit: { found: false, url: null, method: null, contentType: null, mechanism: 'unknown', jsFieldNames: [] },
      formFieldNames: ['personInfoForBirth.personFirstNameBn', 'otp'],
      formActions: ['/br/application'],
    });
    const result2 = await probePageScripts({ page: formOnly, fetchText: async () => '' });
    assert.strictEqual(result2.submitPost.found, true);
    assert.deepStrictEqual(result2.submitPost.foundIn, []);
    assert.strictEqual(result2.submitPost.url, '/br/application');
    assert.strictEqual(result2.submitPost.urlSource, 'form-action');
    assert.strictEqual(result2.submitPost.mechanism, 'native');
    assert.deepStrictEqual(result2.submitPost.fieldNames, ['otp', 'personInfoForBirth.personFirstNameBn']);
  });

  it('in-page submit reducer agrees with the server reducer; form names collected', async () => {
    const samples = [
      'var fd = new FormData(); fd.append("personInfoForBirth.personFirstNameBn", a);'
      + ' fd.append("otp", o); fetch("/br/application", { method: "POST", body: fd });',
      'document.querySelector("form").addEventListener("submit", function(e){'
      + ' var fd = new FormData(this); fetch("/br/application", { method: "POST", body: fd }); });',
    ];
    const savedDoc = global.document;
    const savedLoc = global.location;
    try {
      global.location = { href: PAGE_URL };
      for (const sample of samples) {
        const formStub = {
          getAttribute: (n) => (n === 'action' ? null : null),
          querySelectorAll: () => [{ name: 'personInfoForBirth.personFirstNameBn' }, { name: 'otp' }, { name: '' }],
        };
        global.document = {
          querySelectorAll: (sel) => {
            if (sel === 'script') return [{ src: '', textContent: sample }];
            if (sel === 'form') return [formStub];
            return [];
          },
        };
        const refs = collectWarmPageScripts();
        assert.deepStrictEqual(refs.submit, extractSubmitPost(sample));
        assert.deepStrictEqual(refs.formFieldNames, ['otp', 'personInfoForBirth.personFirstNameBn']);
        assert.deepStrictEqual(refs.formActions, []);
      }
    } finally {
      if (savedDoc === undefined) delete global.document;
      else global.document = savedDoc;
      if (savedLoc === undefined) delete global.location;
      else global.location = savedLoc;
    }
  });
});
