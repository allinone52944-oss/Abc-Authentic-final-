/**
 * HttpPathRunner — HTTP-first execution path for the BDRIS v2 engine.
 *
 * This is the "best method" integration (land-like: direct JSON calls,
 * no browser robot for the HTTP steps), wired as an OPT-IN path only
 * when explicitly enabled, with the existing Playwright path as the
 * live default and as fallback.
 *
 * CANDIDATE — READ FIRST: the submit/verify shapes sent here follow
 * the pasted form page source (2026-10-25: form POST to
 * /br/application, OTP verify as query-param POST), but they have
 * NOT been run live (see v2/http/DESIGN.md). Every log line and
 * every response from this module carries that label, and this path
 * must never be described as realtime until one live run confirms
 * it. Scope is only up to a successful SUBMIT + success page;
 * office registration is out of scope entirely.
 *
 * Safety rules (deliberate, do not weaken):
 *  - Charge gate first, identical to Playwright submitS4: when a JWT
 *    secret is configured, the _chargeToken must verify for kind
 *    'submit' or the chain is BLOCKED — no HTTP attempt and no
 *    Playwright fallback (the fallback would block on the same gate,
 *    so falling back could only waste a session, never bypass payment).
 *  - Fallback: on any HTTP-step failure BEFORE submit (bootstrap, geo,
 *    upload, OTP send, verify) or on a definitive submit rejection
 *    (server answered, but not the verified success shape), the chain
 *    falls back to the Playwright path for that session and logs the
 *    step + reason. It never fails the user outright when Playwright
 *    could still work, and never switches silently.
 *  - Submit outcome unknown: if the submit request itself fails
 *    WITHOUT a server response (network error, timeout — no error
 *    code from the client), the outcome is UNKNOWN and automatic
 *    fallback is SUPPRESSED, returning SUBMIT_OUTCOME_UNKNOWN. A
 *    blind Playwright retry could double-submit a real application
 *    that the HTTP attempt already created. The user must check
 *    manually before retrying.
 *  - No invented data: geo chain runs only when the caller supplies
 *    an explicit geoChain spec (firstParentId + steps); without one
 *    the geo step is logged as skipped and addresses come from the
 *    input data, exactly as the Playwright path would have filled
 *    them. Missing documents, missing fields, or a bad OTP are loud
 *    failures that trigger the (safe) fallback, never silent guesses.
 *
 * Input data: the same combined draft the Playwright path receives
 * ({s1, s2, s2b, s3, s4prep, otp, _chargeToken, docs}) OR the HTTP
 * client's canonical shape ({person, father, mother, birthPlace,
 * permAddr, prsntAddr, relation, documents, ...}). normalizeChainInput
 * accepts both. Upload files are Playwright-shaped docs
 * ({name, mimeType, base64, docType '40'|'41'}); already-uploaded
 * references ({attachmentType, url, id}) are used as-is.
 *
 * Enable/disable: env BDRIS_HTTP_PATH. Default OFF (safe-by-default,
 * senior decision 2026-10-25): the HTTP path is OPT-IN ONLY until one
 * live capture confirms the candidate submit/verify payloads, because
 * those payloads are derived, not live-verified. Set
 * BDRIS_HTTP_PATH=on (or 1/true/yes/enabled) to enable it explicitly;
 * unset, empty, or off/0/false/no/disabled (or any other value)
 * disables it, and the engine then runs Playwright directly.
 * The fallback to Playwright on HTTP failure is always on, even
 * when the HTTP path is enabled; it is not separately switchable.
 */

'use strict';

const { BdrisHttpClient } = require('../http/client');
const { verifyChargeToken, bnToArab, consumeSubmitToken, isSubmitTokenConsumed } = require('./StepHandler');

const HTTP_CANDIDATE_LABEL = 'CANDIDATE (submit/verify shapes from the pasted form source, NOT live-verified)';
const HTTP_BASE = 'https://bdris.gov.bd';

function isHttpPathEnabled(env = process.env) {
  // Safe-by-default: only an explicit opt-in enables the HTTP path.
  // Unset/empty/unknown values are OFF, never silently ON.
  const raw = env && env.BDRIS_HTTP_PATH !== undefined && env.BDRIS_HTTP_PATH !== null
    ? String(env.BDRIS_HTTP_PATH).trim().toLowerCase()
    : '';
  return ['on', '1', 'true', 'yes', 'enabled'].includes(raw);
}

/**
 * Non-destructive status probe (HTTP_PATH_STATUS). Pure function:
 * it reads only the enable flag and returns a status object. It
 * NEVER starts a session, sends OTP, uploads, submits, runs
 * Playwright, or changes any state — it does not even create an
 * HTTP client. Callers must not attach a dedup _commandId to the
 * probe (the executor caches by _commandId), or they will get a
 * stale cached status instead of a fresh one.
 *
 * `ready: true` means ONLY that the engine process answered this
 * probe. It says nothing about bdris.gov.bd reachability, a
 * browser session, or a form page — those are live state the
 * probe deliberately never touches.
 */
function getHttpPathStatus(env = process.env) {
  const enabled = isHttpPathEnabled(env);
  return {
    httpPath: enabled ? 'enabled' : 'disabled',
    enabled,
    ready: true,
    candidate: true,
    candidateLabel: HTTP_CANDIDATE_LABEL,
  };
}

/**
 * SUBMIT_HTTP_CHAIN entry point, separated from execution so the
 * disabled branch can never double-execute (2026-10-25 fix).
 *
 * BEFORE this fix, the server's disabled branch AWAITED the full
 * Playwright chain (S0→S4, including submit) and then returned
 * {...playwrightResult, httpPath:'disabled'}. A frontend "probe,
 * then run the old flow if disabled" would therefore have run
 * Playwright twice: once inside this command, once in the old flow.
 *
 * NOW: when HTTP is disabled this function returns immediately
 * with httpPath:'disabled' and NEVER invokes playwrightRunner,
 * NEVER checks the charge gate, and NEVER touches HTTP or a
 * browser. The CALLER — the existing frontend Playwright flow —
 * remains responsible for running Playwright itself. When HTTP is
 * enabled, behaviour is unchanged: runHttpChain with the charge
 * gate first, Playwright fallback on HTTP failure, candidate
 * label everywhere, and no fallback on unknown submit outcome.
 */
async function runSubmitHttpChain(opts = {}) {
  if (!isHttpPathEnabled(opts.env)) {
    return {
      ok: false,
      httpPath: 'disabled',
      disabled: true,
      error: 'HTTP_PATH_DISABLED',
      candidate: true,
      candidateLabel: HTTP_CANDIDATE_LABEL,
      message: 'HTTP path is disabled (opt-in BDRIS_HTTP_PATH=on not set) — this command executed nothing; the caller runs the existing Playwright flow itself.',
    };
  }
  return runHttpChain(opts);
}

/** Accept draft shape or canonical shape; return canonical + extras. */
function normalizeChainInput(data = {}) {
  const s1 = data.s1 || {};
  const s2 = data.s2 || {};
  const s2b = data.s2b || {};
  const s3 = data.s3 || {};
  const s4prep = data.s4prep || {};
  const canonical = {
    person: data.person || s1,
    father: data.father || s2.father || {},
    mother: data.mother || s2.mother || {},
    birthPlace: data.birthPlace || s1.birth || s2b.birth || s2b.birthPlace || data.birth || {},
    permAddr: data.permAddr || s2b.perm || {},
    prsntAddr: data.prsntAddr || s2b.pres || s2b.prsnt || {},
    relation: data.relation || s3.relation,
    applicantName: data.applicantName || s3.applicantName,
    declaration: data.declaration !== undefined ? data.declaration : s3.declaration,
    email: data.email || s4prep.email,
    phone: bnToArab(data.phone || s4prep.phone),
    officeAddressType: data.officeAddressType || s4prep.officeAddressType,
    officeAddrCountry: data.officeAddrCountry || s4prep.officeAddrCountry,
    officeId: data.officeId || s4prep.officeId,
    addressType: data.addressType || 'BIRTHPLACE',
    otp: data.otp,
  };
  // OTP-send/verify context (verified param names, see client.js).
  const person = canonical.person;
  const otpContext = {
    phone: canonical.phone || '',
    email: canonical.email || '',
    officeId: canonical.officeId || '',
    personUbrn: String(data.personUbrn || person.brn || s1.brn || ''),
    relation: String(canonical.relation || ''),
    applicantName: String(canonical.applicantName || ''),
    applicantBrn: String(data.applicantBrn || person.brn || s1.brn || ''),
    applicantDob: String(person.dob || ''),
    officeAddressType: String(canonical.officeAddressType || ''),
    // OTP-send body needs the six names; verify needs the office
    // group's LocationId (derived from officeAddressType in client).
    person: canonical.person,
    father: canonical.father,
    mother: canonical.mother,
    birthPlaceLocationId: String(canonical.birthPlace.locationId || ''),
    permAddrLocationId: String(canonical.permAddr.locationId || ''),
  };
  const uploadFiles = data.docs || data.uploadFiles || null;
  const documentRefs = data.documents || s3.documents || null;
  return {
    canonical,
    otpContext,
    uploadFiles: Array.isArray(uploadFiles) ? uploadFiles : null,
    documentRefs: Array.isArray(documentRefs) ? documentRefs : null,
    geoChain: data.geoChain || null,
    otp: data.otp,
    chargeToken: data._chargeToken,
  };
}

/**
 * Is this HTTP failure safe to fall back from? Only a submit failure
 * without a server response (no client error code) is unsafe — the
 * application may already exist. Every other failure is a definitive
 * rejection or a pre-submit failure, so Playwright can still try.
 */
function isFallbackSafe(step, err) {
  if (step !== 'submit') return true;
  if (!err) return true;
  // Client-thrown rejection codes mean the server answered (or the
  // payload never left): SUBMIT_BAD_RESPONSE / SUBMIT_NOT_SUCCESS /
  // MISSING_SUBMIT_FIELD. A bare network/timeout error has no code.
  return !!err.code;
}

function candidateLog(log, step, message) {
  // Every HTTP-path log line carries the CANDIDATE label (requirement).
  log(`[HTTP-CANDIDATE] ${step}: ${message} — ${HTTP_CANDIDATE_LABEL}`);
}

/**
 * Run the full chain via HTTP, falling back to Playwright on failure.
 *
 * @param {object} opts
 * @param {object} opts.data - combined draft or canonical input
 * @param {string} [opts.userId] - for the charge-token gate
 * @param {string} [opts.secret] - JWT secret override (else env)
 * @param {object} [opts.client] - injected BdrisHttpClient (tests)
 * @param {function} [opts.clientFactory] - () => BdrisHttpClient
 * @param {string} [opts.base] - HTTP base for the default client
 * @param {function} [opts.playwrightRunner] - async (data) => result;
 *   when absent, a fallback need is returned instead of executed
 * @param {function} [opts.log] - log fn (default: console.log)
 * @param {function} [opts.emit] - progress emit fn (optional)
 */
async function runHttpChain(opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const emit = opts.emit || (() => {});
  const data = opts.data || {};
  const userId = opts.userId || null;
  const secret = opts.secret !== undefined ? opts.secret
    : (process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '');

  const baseResult = { path: 'http', candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL };

  // ── Gate (identical to Playwright submitS4; never bypassed) ──
  // Fail-CLOSED (2026-10-26, A-to-Z audit): see submitS4 — backend
  // cannot start without JWT_SECRET and the adapter passes the full
  // env to the engine, so a missing secret is misconfiguration, not
  // a free pass. verifyChargeToken returns false on empty secret.
  if (!verifyChargeToken(data._chargeToken, userId, 'submit', secret)) {
    candidateLog(log, 'gate', 'CHARGE_REQUIRED — charge token did not verify; chain blocked, no HTTP attempt, no Playwright fallback');
    return { ...baseResult, ok: false, blocked: true, error: 'CHARGE_REQUIRED', message: '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।' };
  }
  if (isSubmitTokenConsumed(data._chargeToken)) {
    candidateLog(log, 'gate', 'CHARGE_TOKEN_CONSUMED — token already used for a successful submit; chain blocked');
    return { ...baseResult, ok: false, blocked: true, error: 'CHARGE_TOKEN_CONSUMED', message: '❌ এই পেমেন্টে ইতিমধ্যে একটি আবেদন জমা হয়েছে — নতুন করে চার্জ করে আবার চেষ্টা করুন।' };
  }

  const norm = normalizeChainInput(data);
  const client = opts.client
    || (typeof opts.clientFactory === 'function' ? opts.clientFactory() : null)
    || new BdrisHttpClient({ base: opts.base || HTTP_BASE });

  const stepsDone = [];
  const fail = async (step, err) => {
    const reason = (err && err.message) || String(err);
    candidateLog(log, 'fallback', `HTTP_PATH_FALLBACK step=${step} reason=${reason}`);
    if (step === 'submit' && !isFallbackSafe(step, err)) {
      candidateLog(log, 'submit', 'SUBMIT_OUTCOME_UNKNOWN — no server response, automatic Playwright fallback SUPPRESSED to avoid a duplicate submission');
      return {
        ...baseResult, ok: false, error: 'SUBMIT_OUTCOME_UNKNOWN',
        message: 'সাবমিটের ফল জানা যায়নি (সার্ভারের উত্তর আসেনি) — ডাবল আবেদন এড়াতে স্বয়ংক্রিয় পুনঃচেষ্টা বন্ধ রাখা হয়েছে; আবেদন হয়েছে কিনা যাচাই করে আবার চেষ্টা করুন।',
        httpStep: step, httpReason: reason,
      };
    }
    if (typeof opts.playwrightRunner === 'function') {
      const pw = await opts.playwrightRunner(data);
      return {
        ...(pw || {}), path: 'playwright', httpFallback: true, httpStep: step, httpReason: reason,
        candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL,
      };
    }
    return {
      ...baseResult, ok: false, fallback: true, httpStep: step, httpReason: reason,
      message: `HTTP ${step} failed (${reason}); Playwright fallback is required but no Playwright runner was provided.`,
    };
  };

  let currentStep = 'bootstrap';
  try {
    // 1. Bootstrap (verified session + CSRF + cookie jar) — SKIPPED
    // when the caller already seeded the client from a warm browser
    // session (seedFromBrowser sets bootstrapped=true). A bare fetch
    // form-GET is proven blocked with 403, so re-bootstrapping a
    // seeded client would break the very session it was given.
    // Unseeded clients (and test doubles without the flag) keep the
    // old behaviour: bootstrap runs.
    if (client.bootstrapped) {
      candidateLog(log, 'bootstrap', 'skipped — client already seeded from browser session');
    } else {
      candidateLog(log, 'bootstrap', 'GET form page for session + CSRF');
      await client.bootstrap();
      stepsDone.push('bootstrap');
    }

    // 2. Geo chain — only when the caller supplies an explicit spec.
    currentStep = 'geo';
    if (norm.geoChain) {
      candidateLog(log, 'geo', 'walking caller-supplied geo chain (firstParentId explicit, targetGeoOrder followed)');
      const chain = await client.walkGeoChain(norm.geoChain);
      stepsDone.push('geo');
      emit('HTTP_GEO', { steps: chain.length });
    } else {
      candidateLog(log, 'geo', 'skipped — no geoChain spec in input; addresses come from input data, as Playwright would have filled them');
    }

    // 3. Document uploads (mandatory types 40 and 41).
    currentStep = 'upload';
    let refs = null;
    if (norm.uploadFiles) {
      const uploaded = [];
      for (const d of norm.uploadFiles) {
        if (!d || !d.base64) continue;
        const type = d.docType === '41' || d.attachmentType === 41 ? 41 : 40;
        candidateLog(log, 'upload', `uploading document type ${type}`);
        const out = await client.uploadDocument({
          fileBuffer: Buffer.from(d.base64, 'base64'),
          filename: d.name || 'document.jpg',
          mimeType: d.mimeType || 'image/jpeg',
          attachmentType: type,
        });
        uploaded.push({ attachmentType: type, attachmentTypeId: out.attachmentTypeId, url: out.url, id: out.id });
      }
      refs = uploaded;
    } else if (norm.documentRefs) {
      refs = norm.documentRefs;
      candidateLog(log, 'upload', 'using caller-supplied upload references (no re-upload)');
    }
    if (!refs || !refs.some((r) => Number(r.attachmentType || r.attachmentTypeId) === 40)
      || !refs.some((r) => Number(r.attachmentType || r.attachmentTypeId) === 41)) {
      throw Object.assign(new Error('Both mandatory document types 40 and 41 are required'), { code: 'MISSING_DOCUMENTS' });
    }
    stepsDone.push('upload');

    // 4. OTP send (verified params).
    currentStep = 'otp-send';
    candidateLog(log, 'otp-send', 'POST /api/otp/sent with applicant/phone/office context + six name fields');
    const sent = await client.otpSend(norm.otpContext);
    if (sent && sent.success !== undefined && sent.success !== true) {
      throw Object.assign(new Error(`OTP send rejected: ${sent.code || 'unknown'}`), { code: 'OTP_SEND_FAILED' });
    }
    stepsDone.push('otp-send');

    // 5. OTP verify (CANDIDATE payload).
    currentStep = 'verify';
    candidateLog(log, 'verify', 'POST /api/otp/verify — query params, empty body (otpSend context + otp + geoLocationId)');
    await client.verifyOtp({ ...norm.otpContext, otp: norm.otp });
    stepsDone.push('verify');

    // 6. Final submit (CANDIDATE payload; scope ends at success page).
    currentStep = 'submit';
    candidateLog(log, 'submit', 'POST /br/application — the form itself, multipart, scope ends at success page, office registration is out of scope');
    const submitInput = { ...norm.canonical, documents: refs, otp: norm.otp };
    const submitted = await client.submitApplication(submitInput);
    stepsDone.push('submit');

    candidateLog(log, 'done', `HTTP chain complete (steps: ${stepsDone.join(', ')}); success accepted only on the verified success shape`);
    // Clean success point ONLY (same rule as submitS4): consume here,
    // never on attempt, so retries after a failed chain keep the token.
    consumeSubmitToken(data._chargeToken);
    return {
      ...baseResult, ok: true, success: true, hasPrintLink: !!submitted.hasPrintLink,
      steps: stepsDone, ackNumber: null, // never extracted: format unverified
      message: '✅ HTTP পথে সাবমিট সফল (প্রার্থী পে-লোড — লাইভ নিশ্চিতকরণ বাকি)।',
    };
  } catch (e) {
    // currentStep is set before each stage, so a skipped geo step
    // cannot mislabel a later upload failure as a geo failure.
    return fail(currentStep, e);
  }
}

/**
 * Stage A probe (2026-10-27): READ-ONLY verification of the direct
 * path's front half — session-seeded client, bootstrap skip, geo
 * chain, office lookups — and it STOPS before upload/OTP/submit.
 *
 * Safety properties (pinned by tests):
 *  - Never builds a bare client: opts.client is required; without
 *    it the probe returns NO_SEEDED_CLIENT and touches nothing.
 *  - Never bootstraps: an unseeded client returns NOT_SEEDED and
 *    touches nothing (bare fetch form-GET is proven 403).
 *  - Never uploads, sends/verifies OTP, or submits: those client
 *    methods are never called (test fakes throw if called).
 *  - No charge gate: the probe performs no chargeable action, so
 *    no charge token is needed or checked. This is deliberate and
 *    safe ONLY because the probe cannot submit anything.
 *  - Office params are caller-supplied verbatim (shapes unverified);
 *    nothing is invented. Each attempted step records its own
 *    result; a failed step does not hide earlier steps' results.
 *  - Not gated on BDRIS_HTTP_PATH: like GET_ADDRESS_OPTIONS (also
 *    read-only seeded HTTP), the probe is flag-independent. The
 *    SUBMIT path keeps its own opt-in flag.
 *
 * @param {object} opts
 * @param {object} opts.client - session-seeded BdrisHttpClient (required)
 * @param {object} [opts.geoChain] - walkGeoChain spec (firstParentId,
 *   firstGeoOrder, steps); skipped when absent
 * @param {object} [opts.officeParams] - verbatim params for
 *   findOfficeByGeoId; skipped when absent
 * @param {object} [opts.officeProjectionParams] - verbatim params for
 *   findOfficeGeoProjectionByGeoId; skipped when absent
 * @param {function} [opts.log] - log fn (default: console.log)
 */
async function runStageAProbe(opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const baseResult = { path: 'http-probe', stage: 'A', candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL, stoppedBefore: 'upload' };
  const client = opts.client || null;
  if (!client) {
    return { ...baseResult, ok: false, error: 'NO_SEEDED_CLIENT', message: 'Stage A probe needs a session-seeded client; it never builds a bare one.' };
  }
  if (!client.bootstrapped) {
    return { ...baseResult, ok: false, error: 'NOT_SEEDED', message: 'Client is not seeded from a browser session; the probe refuses a bare bootstrap (proven 403).' };
  }
  candidateLog(log, 'bootstrap', 'skipped — client already seeded from browser session');
  const steps = ['bootstrap-skipped'];
  const results = { bootstrap: 'skipped-seeded' };
  let allOk = true;

  if (opts.geoChain) {
    try {
      const chain = await client.walkGeoChain(opts.geoChain);
      steps.push('geo');
      results.geo = {
        ok: true,
        steps: chain.map((c) => ({ nameBn: c.step.nameBn, geoType: c.step.geoType, chosenId: c.chosen.id, chosenNameBn: c.chosen.nameBn, targetGeoOrder: c.targetGeoOrder })),
      };
    } catch (e) {
      allOk = false;
      results.geo = { ok: false, error: e.code || 'GEO_FAILED', message: e.message };
    }
  } else {
    results.geo = { ok: null, skipped: 'no geoChain spec supplied' };
  }

  if (opts.officeParams) {
    try {
      // Raw method preferred (live client): records URL, status,
      // content-type, body length + preview, so a null response can
      // be told apart from an empty body vs an HTML page. Older
      // test doubles without the raw method keep the old shape.
      if (typeof client.findOfficeByGeoIdRaw === 'function') {
        const raw = await client.findOfficeByGeoIdRaw(opts.officeParams);
        steps.push('office');
        results.office = { ok: raw.ok, response: raw.json, url: raw.url, status: raw.status, contentType: raw.contentType, bodyLength: raw.bodyLength, bodyPreview: raw.bodyPreview };
        if (!raw.ok) allOk = false;
      } else {
        const office = await client.findOfficeByGeoId(opts.officeParams);
        steps.push('office');
        results.office = { ok: true, response: office };
      }
    } catch (e) {
      allOk = false;
      results.office = { ok: false, error: e.code || 'OFFICE_FAILED', message: e.message };
    }
  } else {
    results.office = { ok: null, skipped: 'no officeParams supplied' };
  }

  if (opts.officeProjectionParams) {
    try {
      if (typeof client.findOfficeGeoProjectionByGeoIdRaw === 'function') {
        const raw = await client.findOfficeGeoProjectionByGeoIdRaw(opts.officeProjectionParams);
        steps.push('office-projection');
        results.officeProjection = { ok: raw.ok, response: raw.json, url: raw.url, status: raw.status, contentType: raw.contentType, bodyLength: raw.bodyLength, bodyPreview: raw.bodyPreview };
        if (!raw.ok) allOk = false;
      } else {
        const proj = await client.findOfficeGeoProjectionByGeoId(opts.officeProjectionParams);
        steps.push('office-projection');
        results.officeProjection = { ok: true, response: proj };
      }
    } catch (e) {
      allOk = false;
      results.officeProjection = { ok: false, error: e.code || 'OFFICE_FAILED', message: e.message };
    }
  } else {
    results.officeProjection = { ok: null, skipped: 'no officeProjectionParams supplied' };
  }

  if (opts.scriptProbe) {
    try {
      // Read the form page's OWN script: the office URLs are known
      // only from that script, and the guessed GET+?geoId= call
      // returned the HTML shell — so the real call convention
      // (method, params) must be read from the source, not guessed.
      const form = await client.fetchFormPageText();
      const pageMatches = extractOfficeMatches(form.text);
      // Call-site grep (2026-10-27): the live form page defines the
      // office URLs as findOfficeByParentGeoIdRestUrl /
      // findOfficeGeoProjectionByParentGeoIdRestUrl constants, but the
      // URL strings alone do not show HOW they are called (method,
      // params). Grep the page and the bundles for the constant names
      // too, so the actual call site surfaces with context.
      const pageCallMatches = extractOfficeCallMatches(form.text);
      // getOfficeId grep (2026-10-27): the uploaded OTP/office log
      // proves officeId comes from a page function getOfficeId()
      // (empty → 0) — but not what that function does inside. Grep
      // the page and the bundles for its definition/body, so the
      // derivation (geo? stored value? always 0?) surfaces.
      const pageFnMatches = extractGetOfficeIdMatches(form.text);
      const scripts = [];
      // Up to 15 bundles (was 5): the live page's first 5 srcs are
      // libraries (jquery, bootstrap, ...) with no office matches —
      // the app code using the constants lives in later bundles.
      const srcs = extractScriptSrcs(form.text, client.base || '').slice(0, 15);
      for (const src of srcs) {
        try {
          const bundle = await client.fetchPageText(src);
          const capped = bundle.bodyLength > 500000;
          const text = capped ? bundle.text.slice(0, 500000) : bundle.text;
          scripts.push({ url: src, status: bundle.status, ok: bundle.ok, bodyLength: bundle.bodyLength, truncated: capped, matches: extractOfficeMatches(text), callMatches: extractOfficeCallMatches(text), fnMatches: extractGetOfficeIdMatches(text) });
        } catch (e) {
          scripts.push({ url: src, ok: false, error: e.code || 'SCRIPT_FETCH_FAILED', message: e.message });
        }
      }
      steps.push('script');
      results.script = { ok: form.ok, page: { url: form.url, status: form.status, contentType: form.contentType, bodyLength: form.bodyLength }, pageMatches, pageCallMatches, pageFnMatches, scripts };
      if (!form.ok) allOk = false;
    } catch (e) {
      allOk = false;
      results.script = { ok: false, error: e.code || 'SCRIPT_FAILED', message: e.message };
    }
  }

  return { ...baseResult, ok: allOk, steps, results };
}

// Office-call grep for the script probe (pure, tested): each match
// carries +-context so the call convention is visible, not just the
// URL string. Capped so a huge page cannot flood the ack.
function extractOfficeMatches(text, maxMatches = 5, context = 400) {
  const out = [];
  if (!text) return out;
  const re = /find-by-geo-id|find-office-geo-projection-by-geo-id/gi;
  let m;
  while (out.length < maxMatches && (m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - context);
    const end = Math.min(text.length, m.index + m[0].length + context);
    out.push({ at: m.index, match: m[0], context: text.slice(start, end) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// Call-site grep for the script probe (pure, tested): same +-context
// shape as extractOfficeMatches, but matching the JS constant names
// the live form page uses (findOfficeByParentGeoIdRestUrl /
// findOfficeGeoProjectionByParentGeoIdRestUrl) instead of the URL
// strings — so the actual call (method, params) surfaces, not just
// the definition. Capped so a huge page cannot flood the ack.
function extractOfficeCallMatches(text, maxMatches = 5, context = 400) {
  const out = [];
  if (!text) return out;
  const re = /findOfficeByParentGeoIdRestUrl|findOfficeGeoProjectionByParentGeoIdRestUrl/gi;
  let m;
  while (out.length < maxMatches && (m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - context);
    const end = Math.min(text.length, m.index + m[0].length + context);
    out.push({ at: m.index, match: m[0], context: text.slice(start, end) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// getOfficeId grep for the script probe (pure, tested): same
// +-context shape, matching the page function name getOfficeId —
// so its definition/body (and its call sites) surface with context.
// Capped so a huge page cannot flood the ack.
function extractGetOfficeIdMatches(text, maxMatches = 5, context = 400) {
  const out = [];
  if (!text) return out;
  const re = /getOfficeId/gi;
  let m;
  while (out.length < maxMatches && (m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - context);
    const end = Math.min(text.length, m.index + m[0].length + context);
    out.push({ at: m.index, match: m[0], context: text.slice(start, end) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// Same-origin <script src> list for the script probe (pure, tested):
// relative paths kept, absolute URLs kept only on the same base,
// third-party / data: / blob: skipped, duplicates removed.
function extractScriptSrcs(html, base = '') {
  const srcs = [];
  const seen = new Set();
  if (!html) return srcs;
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = (m[1] || '').trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    if (/^https?:\/\//i.test(src)) {
      if (base && src.startsWith(base)) srcs.push(src.slice(base.length) || '/');
    } else if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      srcs.push(src.startsWith('/') ? src : `/${src}`);
    }
  }
  return srcs;
}

module.exports = { runHttpChain, runSubmitHttpChain, runStageAProbe, getHttpPathStatus, normalizeChainInput, isHttpPathEnabled, isFallbackSafe, HTTP_CANDIDATE_LABEL, HTTP_BASE, extractOfficeMatches, extractOfficeCallMatches, extractGetOfficeIdMatches, extractScriptSrcs };
