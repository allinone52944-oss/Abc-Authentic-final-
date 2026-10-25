/**
 * HttpPathRunner — HTTP-first execution path for the BDRIS v2 engine.
 *
 * This is the "best method" integration (land-like: direct JSON calls,
 * no browser robot for the HTTP steps), wired as an OPT-IN path only
 * when explicitly enabled, with the existing Playwright path as the
 * live default and as fallback.
 *
 * CANDIDATE — READ FIRST: the submit and OTP-verify payloads sent here
 * are CANDIDATE (derived from the Playwright v2 StepHandler field map,
 * NOT live-captured; see v2/http/DESIGN.md). Every log line and every
 * response from this module carries that label, and this path must
 * never be described as realtime until one live capture confirms the
 * real submit method/field list and verify params. Scope is only up
 * to a successful SUBMIT + success page; office registration is out
 * of scope and is never conflated with the /api/br/application/register
 * submit call (that path name is the submit API, not office registration).
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
const { verifyChargeToken } = require('./StepHandler');

const HTTP_CANDIDATE_LABEL = 'CANDIDATE (submit/verify payloads derived from StepHandler, NOT live-verified)';
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
    phone: data.phone || s4prep.phone,
    officeAddressType: data.officeAddressType || s4prep.officeAddressType,
    officeAddrCountry: data.officeAddrCountry || s4prep.officeAddrCountry,
    officeId: data.officeId || s4prep.officeId,
    addressType: data.addressType || 'BIRTH',
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
  if (secret) {
    if (!verifyChargeToken(data._chargeToken, userId, 'submit', secret)) {
      candidateLog(log, 'gate', 'CHARGE_REQUIRED — charge token did not verify; chain blocked, no HTTP attempt, no Playwright fallback');
      return { ...baseResult, ok: false, blocked: true, error: 'CHARGE_REQUIRED', message: '❌ পেমেন্ট যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন।' };
    }
  } else {
    candidateLog(log, 'gate', 'no JWT secret configured — charge gate skipped, same as Playwright without a secret');
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
    // 1. Bootstrap (verified session + CSRF + cookie jar).
    candidateLog(log, 'bootstrap', 'GET form page for session + CSRF');
    await client.bootstrap();
    stepsDone.push('bootstrap');

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
    candidateLog(log, 'otp-send', 'GET /api/otp/sent with applicant/phone/office context');
    const sent = await client.otpSend(norm.otpContext);
    if (sent && sent.success !== undefined && sent.success !== true) {
      throw Object.assign(new Error(`OTP send rejected: ${sent.code || 'unknown'}`), { code: 'OTP_SEND_FAILED' });
    }
    stepsDone.push('otp-send');

    // 5. OTP verify (CANDIDATE payload).
    currentStep = 'verify';
    candidateLog(log, 'verify', 'POST /api/otp/verify — CANDIDATE payload (otpSend context + otp)');
    await client.verifyOtp({ ...norm.otpContext, otp: norm.otp });
    stepsDone.push('verify');

    // 6. Final submit (CANDIDATE payload; scope ends at success page).
    currentStep = 'submit';
    candidateLog(log, 'submit', 'POST /api/br/application/register — CANDIDATE payload; scope ends at success page, office registration is out of scope');
    const submitInput = { ...norm.canonical, documents: refs, otp: norm.otp };
    const submitted = await client.submitApplication(submitInput);
    stepsDone.push('submit');

    candidateLog(log, 'done', `HTTP chain complete (steps: ${stepsDone.join(', ')}); success accepted only on the verified success shape`);
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

module.exports = { runHttpChain, runSubmitHttpChain, getHttpPathStatus, normalizeChainInput, isHttpPathEnabled, isFallbackSafe, HTTP_CANDIDATE_LABEL, HTTP_BASE };
