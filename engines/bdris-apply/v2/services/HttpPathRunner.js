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

const { BdrisHttpClient, parentBrnDirectDecision, submitSummaryText, submitErrorWording, submitResponseFingerprint } = require('../http/client');
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

/**
 * Finest selected geo level's id (pure, tested): the frontend draft
 * carries per-level *Id fields (divisionId … wardId, Phase 1) but no
 * locationId. The address's LocationId is its finest selected
 * level's id — ward first, then union, upazila, district, division.
 * INFERRED (not live-proven): the live run proved only that
 * geoLocationId is the address's LocationId; which level's id that
 * is for a ward/union address is confirmed by the live test, and an
 * explicit locationId/geoLocationId always overrides this fallback.
 */
function finestAddressId(addr = {}) {
  for (const k of ['wardId', 'paurasavaUnionId', 'cityCorpUpazilaId', 'districtId', 'divisionId']) {
    if (addr[k] !== undefined && addr[k] !== null && String(addr[k]) !== '') return String(addr[k]);
  }
  return '';
}

/**
 * Is an address record empty? Every geo + postal field blank/absent.
 * Used only for the ticked-copy guard: a ticked copy whose SOURCE
 * is empty must fail loudly, never submit as an empty address.
 * Field list covers both naming variants (readAddrFields' postBn/
 * vilBn/houseBn and the test/canonical postOfficeBn/villageBn/
 * houseRoadBn forms).
 */
function isAddrEmpty(addr = {}) {
  if (!addr || typeof addr !== 'object') return true;
  const fields = ['division', 'district', 'cityCorpUpazila', 'paurasavaUnion', 'ward',
    'postBn', 'postEn', 'postOfficeBn', 'postOfficeEn',
    'vilBn', 'vilEn', 'villageBn', 'villageEn',
    'houseBn', 'houseEn', 'houseRoadBn', 'houseRoadEn'];
  return fields.every((k) => addr[k] === undefined || addr[k] === null || String(addr[k]).trim() === '');
}
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
    // LIVE-CONFIRMED 2026-10-27 (Stage C, user-run real application):
    // the page sends officeId 0 when getOfficeId() is empty, and the
    // server accepts it — so an absent officeId defaults to '0',
    // never ''. No /api/office/* lookup is needed or performed.
    officeId: data.officeId || s4prep.officeId || '0',
    addressType: data.addressType || 'BIRTHPLACE',
    otp: data.otp,
  };
  // DIRECT-PATH WIRING (2026-10-28): same-address copy resolution.
  // Tick semantics, carried from the bot path: a ticked copy REUSES
  // the source record — permCopy → birthplace, presCopy → permanent
  // (after perm resolution). The copy BUTTON writes values into
  // pres directly (presCopy false), so it needs no resolution.
  // A ticked copy whose SOURCE is empty resolves to an empty record
  // and sets copySourceEmpty — the chain then fails loudly at the
  // 'address' step (bot fallback) instead of submitting an empty
  // address. Nothing is invented: only recorded flags + recorded
  // records are used; the frontend ctx builder never re-reads DOM.
  const s2bIn = data.s2b || {};
  const birthRec = canonical.birthPlace || {};
  let permRec = canonical.permAddr || {};
  let presRec = canonical.prsntAddr || {};
  if (s2bIn.permCopy) permRec = { ...birthRec };
  if (s2bIn.presCopy) presRec = { ...permRec };
  canonical.permAddr = permRec;
  canonical.prsntAddr = presRec;
  canonical.copyFlags = { permCopy: !!s2bIn.permCopy, presCopy: !!s2bIn.presCopy };
  // DIRECT-PATH WIRING (2026-10-28): name-logic flags carried, NOT
  // consumed. singleBn/singleEn = the bot rule (last name has no
  // letters); hasCinno = a backtick mark present in any of the
  // three names. The payload builders (joinName) are UNCHANGED:
  // single names join to the first name alone (never doubled) and
  // backticks pass through raw — whether the API accepts them is
  // the live test's question, and a bridge (if needed) can read
  // these flags without re-plumbing. Caller-supplied nameFlags win.
  const hasLetters = (s) => /[A-Za-z\u0980-\u09FF]/.test(String(s || ''));
  const hasBacktick = (s) => String(s || '').includes('`');
  const personN = canonical.person || {};
  const fatherN = canonical.father || {};
  const motherN = canonical.mother || {};
  canonical.nameFlags = data.nameFlags || {
    singleBn: !hasLetters(personN.lastNameBn),
    singleEn: !hasLetters(personN.lastNameEn),
    hasCinno: [personN.firstNameBn, personN.lastNameBn, personN.firstNameEn, personN.lastNameEn,
      fatherN.nameBn, fatherN.nameEn, motherN.nameBn, motherN.nameEn].some(hasBacktick),
  };
  canonical.singleName = data.singleName || null;
  // LocationId fallback: the draft's address objects carry *Id
  // fields but no locationId (see finestAddressId). Copy, never
  // mutate the caller's objects, so submit + verify both see it.
  // (prsntAddr included: buildSubmitPayload sends its LocationId
  // too, and the old birth+perm-only loop left it blank.)
  for (const key of ['birthPlace', 'permAddr', 'prsntAddr']) {
    const a = canonical[key] || {};
    canonical[key] = { ...a, locationId: a.locationId || finestAddressId(a) || '' };
  }
  // OTP-send/verify context (verified param names, see client.js).
  const person = canonical.person;
  const otpContext = {
    phone: canonical.phone || '',
    email: canonical.email || '',
    officeId: canonical.officeId || '0',
    // Explicit caller geoLocationId wins in buildVerifyPayload; else
    // the officeAddressType derivation uses the LocationIds above.
    geoLocationId: String(data.geoLocationId || ''),
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
  // DIRECT BRN-FREE ROUTE (2026-10-29): routing information, NOT
  // a forced switch. A filing is BRN-free when its direct payload
  // carries no parent ubrn at all — no BRN given, BRN withheld by
  // the exemption/family rule, any bracket. That is derived here
  // from the merged parentBrnDirectDecision (the unmerged
  // singlename-pattern branch's decision object is NOT duplicated
  // here; if it merges, the two markers should be unified). The
  // marker only tells the caller/UI that this filing belongs on
  // the direct channel — the bot page's verified gate cannot pass
  // it BRN-free — and it never authorises sending, verifying, or
  // submitting on its own; those still need the user's own
  // phone/OTP/submit. Fallback behaviour is unchanged.
  const brnDecision = parentBrnDirectDecision(data);
  const brnFree = brnDecision.fatherUbrn === '' && brnDecision.motherUbrn === '';
  return {
    brnFree,
    brnFreeRoute: brnFree ? 'direct' : null,
    canonical,
    otpContext,
    // DIRECT-PATH WIRING: an EMPTY file list is not a file list —
    // without this, docs: [] (a draft with no files attached yet)
    // shadowed valid documentRefs and the upload step failed with
    // MISSING_DOCUMENTS despite refs being present. Truly missing
    // docs still fail at the upload step, unchanged.
    uploadFiles: (Array.isArray(uploadFiles) && uploadFiles.length) ? uploadFiles : null,
    documentRefs: Array.isArray(documentRefs) ? documentRefs : null,
    geoChain: data.geoChain || null,
    otp: data.otp,
    chargeToken: data._chargeToken,
    // DIRECT-PATH WIRING: true when a ticked copy's source record
    // is empty — runHttpChain fails loudly at 'address' on this.
    copySourceEmpty: (s2bIn.permCopy && isAddrEmpty(permRec)) || (s2bIn.presCopy && isAddrEmpty(presRec)),
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
 * @param {string} [opts.phase] - DIRECT-PATH WIRING (2026-10-28):
 *   'send' = OTP send only (no charge gate, no verify/submit;
 *   returns sent proof; Playwright fallback is the CALLER's job —
 *   pass no playwrightRunner for this phase) or 'submit' =
 *   verify + submit (charge gate first, OTP send skipped — the
 *   send phase already sent it). Absent = the full chain, as before.
 * @param {boolean} [opts.noBareBootstrap] - DIRECT-PATH WIRING:
 *   when true and no client/factory was injected, fail with
 *   SEED_FAILED instead of building a bare client (proven 403).
 */
async function runHttpChain(opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const emit = opts.emit || (() => {});
  const data = opts.data || {};
  const userId = opts.userId || null;
  const secret = opts.secret !== undefined ? opts.secret
    : (process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '');
  // DIRECT-PATH WIRING: the UI calls the chain in two phases so
  // the OTP the user types can arrive between send and submit.
  const phase = opts.phase || null;

  const baseResult = { path: 'http', candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL };

  // ── Gate (identical to Playwright submitS4; never bypassed) ──
  // Fail-CLOSED (2026-10-26, A-to-Z audit): see submitS4 — backend
  // cannot start without JWT_SECRET and the adapter passes the full
  // env to the engine, so a missing secret is misconfiguration, not
  // a free pass. verifyChargeToken returns false on empty secret.
  // DIRECT-PATH WIRING: the send phase is NOT chargeable (the
  // submit charge precedes submit, as on the bot path), so it
  // skips the gate; the submit phase keeps it, unchanged.
  if (phase !== 'send') {
    if (!verifyChargeToken(data._chargeToken, userId, 'submit', secret)) {
      candidateLog(log, 'gate', 'CHARGE_REQUIRED — charge token did not verify; chain blocked, no HTTP attempt, no Playwright fallback');
      return { ...baseResult, ok: false, blocked: true, error: 'CHARGE_REQUIRED', message: '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।' };
    }
    if (isSubmitTokenConsumed(data._chargeToken)) {
      candidateLog(log, 'gate', 'CHARGE_TOKEN_CONSUMED — token already used for a successful submit; chain blocked');
      return { ...baseResult, ok: false, blocked: true, error: 'CHARGE_TOKEN_CONSUMED', message: '❌ এই পেমেন্টে ইতিমধ্যে একটি আবেদন জমা হয়েছে — নতুন করে চার্জ করে আবার চেষ্টা করুন।' };
    }
  } else {
    candidateLog(log, 'gate', 'skipped — send phase is not chargeable (charge precedes submit, as on the bot path)');
  }

  const norm = normalizeChainInput(data);
  // DIRECT BRN-FREE ROUTE: routing information carried on every
  // post-normalize result below (information only — see the
  // normalizeChainInput note; it never triggers a send, verify,
  // submit, or fallback on its own).
  const routeInfo = { brnFree: norm.brnFree, brnFreeRoute: norm.brnFreeRoute };
  const client = opts.client
    || (typeof opts.clientFactory === 'function' ? opts.clientFactory() : null)
    || new BdrisHttpClient({ base: opts.base || HTTP_BASE });

  const stepsDone = [];
  const fail = async (step, err) => {
    const reason = (err && err.message) || String(err);
    candidateLog(log, 'fallback', `HTTP_PATH_FALLBACK step=${step} reason=${reason}`);
    // FINAL-SOLUTION (2026-10-30, problem-map #1 + #6): the
    // direct-vs-fallback DECISION is logged with its cause, and a
    // submit failure carries the response summary (shape/status
    // only) so the next live filing's path and outcome are
    // provable from the journal instead of guessed. Machine flags
    // (never identifiers) let the UI branch without parsing
    // Bengali wording: sessionDead (#8) and otpUnexpired (#14).
    const decisionFlags = {
      sessionDead: !!(err && (err.code === 'SESSION_DEAD' || err.code === 'NO_SESSION' || err.code === 'SESSION_EXPIRED' || err.code === 'SEED_FAILED')),
      otpUnexpired: !!(err && err.code === 'OTP_SEND_UNEXPIRED'),
    };
    if (step === 'submit' && err && err.responseSummary) {
      // SUBMIT-FINAL: the error wording (wording only, never
      // values) rides on the same line when the client attached
      // it, so the journal names the validation reason instead
      // of only the shape. When no wording was attached, the
      // line is unchanged.
      const wording = err.responseErrorWording || '';
      const fp = err.responseFingerprint || '';
      candidateLog(log, 'submit', `SUBMIT-RESPONSE ${submitSummaryText(err.responseSummary)}${wording ? ` errorWording=${wording}` : ''}${fp ? ` fingerprint=${fp}` : ''} — filed-vs-not must be read from this shape, not from the [field: …] heuristic`);
    }
    candidateLog(log, 'decision', `DIRECT-DECISION step=${step} outcome=fallback sessionDead=${decisionFlags.sessionDead} otpUnexpired=${decisionFlags.otpUnexpired}`);
    if (step === 'submit' && !isFallbackSafe(step, err)) {
      candidateLog(log, 'submit', 'SUBMIT_OUTCOME_UNKNOWN — no server response, automatic Playwright fallback SUPPRESSED to avoid a duplicate submission');
      return {
        ...baseResult, ...routeInfo, ok: false, error: 'SUBMIT_OUTCOME_UNKNOWN',
        message: 'সাবমিটের ফল জানা যায়নি (সার্ভারের উত্তর আসেনি) — ডাবল আবেদন এড়াতে স্বয়ংক্রিয় পুনঃচেষ্টা বন্ধ রাখা হয়েছে; আবেদন হয়েছে কিনা যাচাই করে আবার চেষ্টা করুন।',
        httpStep: step, httpReason: reason, ...decisionFlags,
      };
    }
    if (typeof opts.playwrightRunner === 'function') {
      const pw = await opts.playwrightRunner(data);
      return {
        ...(pw || {}), ...routeInfo, path: 'playwright', httpFallback: true, httpStep: step, httpReason: reason, ...decisionFlags,
        candidate: true, candidateLabel: HTTP_CANDIDATE_LABEL,
      };
    }
    return {
      ...baseResult, ...routeInfo, ok: false, fallback: true, httpStep: step, httpReason: reason, ...decisionFlags,
      message: `HTTP ${step} failed (${reason}); Playwright fallback is required but no Playwright runner was provided.`,
      // Information only: a BRN-free filing cannot pass the bot
      // page's verified gate, so a bot fallback after a direct
      // failure is futile for it — the caller/user decides the
      // next step (direct retry with the same true data, or stop);
      // nothing here resends a rejected request.
      brnFreeNote: routeInfo.brnFree && step !== 'submit'
        ? 'BRN-free filing: bot fallback cannot pass BRN-free (bot page requires verified parent BRN).'
        : null,
    };
  };

  let currentStep = 'bootstrap';
  try {
    // DIRECT-PATH WIRING (2026-10-28): pre-step guards — fail
    // before any HTTP leaves. A ticked copy with an empty source
    // must never become an empty submitted address, and a UI
    // direct call must run SEEDED (bare fetch is proven 403).
    currentStep = 'address';
    if (norm.copySourceEmpty) {
      throw Object.assign(new Error('Copy-source address is empty (ticked same-address copy with an empty source address)'), { code: 'COPY_SOURCE_EMPTY' });
    }
    currentStep = 'bootstrap';
    if (opts.noBareBootstrap && !opts.client && typeof opts.clientFactory !== 'function') {
      throw Object.assign(new Error('No session-seeded client: bare bootstrap is refused for the UI direct path'), { code: 'SEED_FAILED' });
    }
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
    // DIRECT-PATH WIRING: the send phase needs no geo walk
    // (otpContext derives LocationIds from the draft *Ids).
    currentStep = 'geo';
    if (phase === 'send') {
      candidateLog(log, 'geo', 'skipped — send phase needs no geo walk');
    } else if (norm.geoChain) {
      candidateLog(log, 'geo', 'walking caller-supplied geo chain (firstParentId explicit, targetGeoOrder followed)');
      // NOTE (final wiring): the walked chain's ids are NOT copied
      // into the OTP/submit locationIds here — the chain's address
      // (birthplace vs permanent) is caller-defined, so copying its
      // final id to the wrong address would send a wrong
      // geoLocationId. LocationIds come from the draft's *Ids
      // (finestAddressId) or an explicit geoLocationId override.
      const chain = await client.walkGeoChain(norm.geoChain);
      stepsDone.push('geo');
      emit('HTTP_GEO', { steps: chain.length });
    } else {
      candidateLog(log, 'geo', 'skipped — no geoChain spec in input; addresses come from input data, as Playwright would have filled them');
    }

    // 3. Document uploads (mandatory types 40 and 41).
    // DIRECT-PATH WIRING: uploads belong to the submit phase —
    // the send phase must not upload (it would double-upload when
    // the submit phase runs with the same files).
    currentStep = 'upload';
    let refs = null;
    if (phase === 'send') {
      candidateLog(log, 'upload', 'skipped — uploads belong to the submit phase');
    } else {
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
    }

    // 4. OTP send (verified params).
    currentStep = 'otp-send';
    let sent = null;
    if (phase !== 'submit') {
      candidateLog(log, 'otp-send', 'POST /api/otp/sent with applicant/phone/office context + six name fields');
      sent = await client.otpSend(norm.otpContext);
      if (sent && sent.success !== undefined && sent.success !== true) {
        throw Object.assign(new Error(`OTP send rejected: ${sent.code || 'unknown'}`), { code: 'OTP_SEND_FAILED' });
      }
      stepsDone.push('otp-send');
    } else {
      candidateLog(log, 'otp-send', 'skipped — the send phase already sent the OTP');
    }

    // DIRECT-PATH WIRING: the send phase ends here — verify and
    // submit need the user's typed OTP, which arrives with the
    // submit phase. Returning now keeps 'sent' as server proof
    // (code/message) without touching verify, submit, or the charge.
    if (phase === 'send') {
      candidateLog(log, 'done', 'send phase complete (OTP sent, proof returned); verify + submit await the submit phase');
      // FINAL-SOLUTION (problem-map #6): the send decision is
      // logged with its server proof code (a constant, never an
      // identifier) so a later "sent" claim can be checked.
      candidateLog(log, 'decision', `DIRECT-DECISION step=otp-send outcome=direct-success sendCode=${sent ? sent.code : null}`);
      return {
        ...baseResult, ...routeInfo, ok: true, sent: true,
        sendCode: sent ? sent.code : null,
        sendMessage: sent ? sent.message : null,
        steps: stepsDone,
      };
    }

    // 5. OTP verify (CANDIDATE payload).
    currentStep = 'verify';
    candidateLog(log, 'verify', 'POST /api/otp/verify — query params, empty body (otpSend context + otp + geoLocationId)');
    await client.verifyOtp({ ...norm.otpContext, otp: norm.otp });
    stepsDone.push('verify');

    // 6. Final submit (CANDIDATE payload; scope ends at success page).
    currentStep = 'submit';
    candidateLog(log, 'submit', 'POST /br/application — the form itself, multipart, scope ends at success page, office registration is out of scope');
    const submitInput = { ...norm.canonical, documents: refs, otp: norm.otp };
    let submitted;
    let familyAdvance = false;
    try {
      submitted = await client.submitApplication(submitInput);
    } catch (e) {
      // Family/180-days ADVANCE (2026-10-29 follow-up): the direct
      // path previously had no family branch at all — a family
      // rejection failed the chain outright. Mirror the bot rule:
      // on a DEFINITIVE server rejection (err.code present, the
      // same rule isFallbackSafe uses for bot fallback) whose
      // wording carries the family marker, retry ONCE names-only
      // (ubrn empty, names + nationality + DOB untouched, draft
      // BRN retained). Never on an unknown outcome (no code:
      // network/timeout) — that application may already exist,
      // and a retry could double-submit. If the retry also fails,
      // its exact error is what fail() reports below.
      const familyRejection = !!(e && e.code && /\[family: 180-days\]/.test(String(e.message || '')));
      if (!familyRejection) throw e;
      candidateLog(log, 'submit', 'family/180-days rejection — retrying once names-only (ubrn empty, names unchanged)');
      submitted = await client.submitApplication({ ...submitInput, _familyNamesOnly: true });
      familyAdvance = true;
    }
    stepsDone.push('submit');

    // FINAL-SOLUTION (problem-map #1): success also logs its
    // shape — a later existence check compares against this.
    if (submitted && submitted.responseSummary) {
      candidateLog(log, 'submit', `SUBMIT-RESPONSE ${submitSummaryText(submitted.responseSummary)} outcome=success`);
    }
    candidateLog(log, 'decision', 'DIRECT-DECISION step=submit outcome=direct-success');
    candidateLog(log, 'done', `HTTP chain complete (steps: ${stepsDone.join(', ')}); success accepted only on the verified success shape`);
    // Clean success point ONLY (same rule as submitS4): consume here,
    // never on attempt, so retries after a failed chain keep the token.
    consumeSubmitToken(data._chargeToken);
    return {
      ...baseResult, ...routeInfo, ok: true, success: true, hasPrintLink: !!submitted.hasPrintLink,
      steps: stepsDone, ackNumber: null, // never extracted: format unverified
      message: '✅ HTTP পথে সাবমিট সফল (প্রার্থী পে-লোড — লাইভ নিশ্চিতকরণ বাকি)।',
      familyNamesOnly: familyAdvance,
      familyNote: familyAdvance ? 'সাইটের পারিবারিক নিয়ম: পিতামাতার BRN ছাড়াই (নাম + জাতীয়তা দিয়ে) এগোনো হয়েছে — BRN ড্রাফটে রাখা আছে।' : null,
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

module.exports = { runHttpChain, runSubmitHttpChain, runStageAProbe, getHttpPathStatus, normalizeChainInput, finestAddressId, isAddrEmpty, isHttpPathEnabled, isFallbackSafe, HTTP_CANDIDATE_LABEL, HTTP_BASE, extractOfficeMatches, extractOfficeCallMatches, extractGetOfficeIdMatches, extractScriptSrcs };
