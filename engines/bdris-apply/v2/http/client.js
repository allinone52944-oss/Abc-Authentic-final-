/**
 * BDRIS HTTP-first client — FIRST VERSION (partial, honest).
 *
 * What this module DOES (verified facts only, 2026-10-25):
 *  - Bootstrap a public session by GETting the form page first and parsing
 *    meta _csrf / _csrf_headerName. No login. No hardcoded cookie/token.
 *  - Keep a live cookie jar updated from EVERY Set-Cookie response, because
 *    the server rotates its TS cookies (one with ~30s Max-Age).
 *  - Send on every API call: session cookies, the CSRF header, header
 *    `x-requested-with: XMLHttpRequest`, referer <base>/br/application,
 *    and header `client: bris`.
 *  - Geo cascade over GET
 *    /v1/api/geo/parentGeoIdWithGeoGroupAndGeoOrder/{parentGeoId}
 *    ?geoGroup=birthPlace&geoOrder=N&geoType=M[&ward=true], following
 *    the response's targetGeoOrder (NEVER order+1) and using the chosen
 *    entry's id as the next parent. Names are matched with the
 *    shared loose matcher (v2/http/geoMatch.js), identical to the
 *    working path — never strict equality (live-proven 2026-10-27).
 *  - Document upload to POST /admin/doc/upload (multipart, types 40/41).
 *  - OTP send over POST /api/otp/sent (query = otpSend context, body
 *    = the six person/parent name fields; no token/id is returned).
 *  - OTP verify over POST /api/otp/verify (query params, empty body;
 *    success = data.isVerified === true).
 *  - Final submit as the form's OWN POST to /br/application
 *    (multipart/form-data, every form field + `attachments` hidden
 *    ids + _csrf) — the verified page flow after a successful
 *    verify (or directly for a mission application). The page script
 *    also contains /api/br/application/register, but that URL is NOT
 *    used by this form's verified flow, so this module no longer
 *    submits to it; where register is actually used is UNRESOLVED.
 *
 * What is STILL source-derived, not live-captured (see DESIGN.md):
 *  - The exact form-submit field VALUES for a few fields whose page
 *    option values were not in the pasted source (e.g. declaration
 *    checkbox value, officeAddr group fields): buildSubmitPayload()
 *    sends the field NAMES from the pasted form source, with those
 *    few values marked as the best available mapping, and the
 *    Playwright v2 path remains the fallback if the server rejects
 *    the form submit live. Never claim realtime live speed — no
 *    live call has been made from this module.
 *
 * First parent: the pasted page source shows bangladeshId = "1",
 * so a Bangladesh division chain starts at parent 1. walkGeoChain()
 * still REQUIRES firstParentId as an explicit caller input and
 * refuses to run without it — "1" is documented, not defaulted.
 *
 * Node built-ins only (global fetch/FormData/Blob). No new npm deps.
 * Never contacts a live host in tests — tests use a local mock server.
 */

'use strict';

// Shared matcher (2026-10-27): walkGeoChain must match geo names
// exactly like the working path — strict equality failed live at
// step 1 ("চট্টগ্রাম" vs the list's actual division name).
const { findGeoEntry } = require('./geoMatch');

const FORM_PATH = '/br/application';
const GEO_PATH = '/v1/api/geo/parentGeoIdWithGeoGroupAndGeoOrder';
const UPLOAD_PATH = '/admin/doc/upload';
const OTP_SENT_PATH = '/api/otp/sent';
const OFFICE_BY_GEO_PATH = '/api/office/find-by-geo-id';
const OFFICE_PROJECTION_PATH = '/api/office/find-office-geo-projection-by-geo-id';
const VERIFY_PATH = '/api/otp/verify';
// Present in the page script but NOT used by this form's verified
// flow (which submits the form itself); kept for reference only.
const REGISTER_PATH = '/api/br/application/register';
const SUBMIT_PATH = FORM_PATH;
const PRINT_PATH = '/admin/br/application/print';
const SUCCESS_PHRASE = 'আবেদনপত্রটি সফল ভাবে সাবমিট করা হয়েছে';

const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, in-memory only
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB, enforced by caller contract
const UPLOAD_TYPES = [40, 41]; // the two mandatory document types
const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png'];

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// DIRECT OTP BODY (2026-10-29): mirror the bot path's
// _otpSendBodyMsg rule (StepHandler.js, JSON branch) for the direct
// chain. A non-2xx OTP-send body carries the site's own reason
// wording in {message} else {code}. Only those two fields are ever
// read — never payload, phone, names, or any other field.
// Whitespace is collapsed and the wording is capped at 200 chars.
// Returns '' when nothing safe and usable is present, so the caller
// keeps the exact previous status-only message.
function otpSendBodyWording(json) {
  if (!json || typeof json !== 'object') return '';
  const m = typeof json.message === 'string' ? json.message
    : (typeof json.code === 'string' ? json.code : '');
  if (!m.trim()) return '';
  return m.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Parent-BRN direct-path helpers (2026-10-29, points 1+6): the
// bot path's rules, mirrored on the direct path. Digit
// normalisation only (Bengali → Arabic, spaces/dashes stripped);
// this decision touches ONLY the ubrn fields. Name transit for
// the send/verify steps lives in transitDirectName; the submit
// payload keeps names verbatim (final record) — RESTORED per
// user directive 2026-10-30 that ALL logics are required: the
// SUBMIT-FINAL transit change is rejected, and the wall cause
// must be learned from the error-wording diagnostic instead of
// by stripping the user's names.
// Pre-2013 applicants send ubrn empty (the bot's live-verified
// site rule) — the draft's BRN is untouched, only the payload
// omits it, and parentBrnDirectDecision reports the withholding.
function normalizeDirectBrn(v) {
  return String(v || '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[\s\-]/g, '');
}
function isParentBrnExemptDirect(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) < '2014-01-01';
}
function isPre2013Direct(iso) {
  if (!iso) return false;
  return String(iso).slice(0, 10) < '2013-01-01';
}
// Family/180-days direct-path helpers (2026-10-29 follow-up):
// the site's family validation is triggered by the parent linkage,
// so the same names-only site rule the bot uses applies here —
// ubrn empty, names + nationality + DOB untouched, draft BRN
// retained. The direct family trigger itself is UNPROVEN (direct
// submit has never been live-run); this only mirrors the rule so a
// family-worded rejection can be retried once names-only instead
// of failing outright. No direct family-verify call is invented.
const DIRECT_FAMILY_NOTE = 'সাইটের পারিবারিক নিয়ম: পিতামাতার BRN ছাড়াই (নাম + জাতীয়তা দিয়ে) এগোনো হয়েছে — BRN ড্রাফটে রাখা আছে।';
function isFamilyRejectionText(t) {
  return /180|difference of age/i.test(String(t || ''));
}
function familyRejectionMarker(res) {
  const hay = [res && res.text, res && res.json && JSON.stringify(res.json)].filter(Boolean).join(' ');
  return isFamilyRejectionText(hay) ? '[family: 180-days]' : '';
}
function parentBrnDirectDecision(data = {}) {
  const s2 = data.s2 || {};
  const father = data.father || s2.father || {};
  const mother = data.mother || s2.mother || {};
  const person = data.person || data.s1 || {};
  const applicantDob = data.applicantDob || person.dob || '';
  // 2013-rule (2026-10-29): pre-2013 + পুরো 2013 সাল — ubrn
  // খালি, শুধু আইডি কার্ড (types 40/41, আগেই বাধ্যতামূলক)
  // প্রমাণ হিসেবে যায়। কোনো BRN বানানো হয় না।
  const brnExempt = isParentBrnExemptDirect(applicantDob);
  // Family advance (2026-10-29 follow-up): the caller sets
  // _familyNamesOnly only after a family-worded rejection, or
  // when the session already advanced names-only on the bot path.
  const familyNamesOnly = !!data._familyNamesOnly;
  const fatherGiven = normalizeDirectBrn(father.brn);
  const motherGiven = normalizeDirectBrn(mother.brn);
  const withheld = (brnExempt || familyNamesOnly) && !!(fatherGiven || motherGiven);
  return {
    brnExempt,
    familyNamesOnly,
    fatherUbrn: (brnExempt || familyNamesOnly) ? '' : fatherGiven,
    motherUbrn: (brnExempt || familyNamesOnly) ? '' : motherGiven,
    withheldBySiteRule: withheld,
    note: !withheld ? null
      : familyNamesOnly && !brnExempt ? DIRECT_FAMILY_NOTE
      : (isPre2013Direct(applicantDob)
        ? '২০১৩-পূর্ব নিয়ম: পিতামাতার BRN সাইটে পাঠানো হয়নি, ড্রাফটে আছে।'
        : '২০১৩ সালের নিয়ম: পিতামাতার BRN ছাড়াই (শুধু মা-বাবার আইডি কার্ড দিয়ে) এগোনো হয়েছে।'),
  };
}
// Direct submit rejection wording (2026-10-29, point 6): mirror
// the OTP-send rule — a non-2xx body's message/code IS the site's
// own reason. If the response names a parent field
// (father.ubrn / mother.ubrn / ubrn), only that FIELD NAME is
// appended — never a value, never the request payload. The
// fallback to the bot path on a definitive rejection is the
// chain's existing behaviour (HttpPathRunner fail()); this helper
// only makes the reason truthful. A rejected submit is never
// resent to force it through.
function submitRejectionField(res) {
  const hay = [res && res.text, res && res.json && JSON.stringify(res.json)].filter(Boolean).join(' ');
  if (/father\.ubrn/i.test(hay)) return 'father.ubrn';
  if (/mother\.ubrn/i.test(hay)) return 'mother.ubrn';
  if (/\bubrn\b/i.test(hay)) return 'ubrn';
  return '';
}
function submitRejectionWording(res) {
  const wording = res && res.json ? otpSendBodyWording(res.json) : '';
  const field = submitRejectionField(res);
  const marker = familyRejectionMarker(res);
  if (!wording && !field && !marker) return '';
  return [wording, field ? `[field: ${field}]` : '', marker].filter(Boolean).join(' ');
}

// FINAL-SOLUTION (2026-10-30, problem-map #1): submit-response
// summary — shape/status ONLY, never response text, never
// identifiers, codes, or tokens. Tonight's filings proved the gap:
// candidate logs recorded phase plans only, so a phrase-check
// fallback left filed-vs-not unprovable, and the [field: ubrn]
// heuristic (a bare word-scan of the body) was misread as a
// rejection when the body was just a re-rendered form page. The
// summary distinguishes those two shapes: a re-rendered form has
// form-field names and no success phrase; a real rejection names
// its reason in JSON wording. hasFormFields is presence-only.
function submitResponseSummary(res) {
  const text = String((res && res.text) || '');
  const json = res && res.json;
  return {
    status: res ? res.status : null,
    isJson: !!json,
    jsonSuccess: !!(json && json.success === true),
    textLen: text.length,
    hasSuccessPhrase: text.includes(SUCCESS_PHRASE),
    hasPrintLink: text.includes(PRINT_PATH),
    hasFormFields: /personInfoForBirth|<form/i.test(text),
  };
}
function submitSummaryText(s) {
  if (!s) return 'none';
  return `status=${s.status} json=${s.isJson} jsonSuccess=${s.jsonSuccess} textLen=${s.textLen} successPhrase=${s.hasSuccessPhrase} printLink=${s.hasPrintLink} formFields=${s.hasFormFields}`;
}

// SUBMIT-FINAL (2026-10-30, problem-map #1 follow-up): the
// shape-only SUBMIT-RESPONSE hides the server's validation
// wording — the next diagnosis needs the REASON, not just the
// shape. This extractor returns WORDING ONLY, from two safe
// sources and no others:
//  - JSON body: the message/code wording (otpSendBodyWording,
//    already capped at 200 chars, fields only).
//  - HTML body: the inner text of an element whose class marks
//    it as a validation/error display (text-danger,
//    invalid-feedback, alert-danger) — the site's own error
//    wording, never a form field value: tags are stripped by
//    the match itself (text up to the next tag only), digit
//    runs are removed (a digit run could be an identifier),
//    and the snippet is capped at 200 chars.
// Anything else — re-rendered form labels, input values,
// names, numbers, codes, tokens — is never returned: a body
// with no JSON wording and no error-class text yields ''.
const SUBMIT_ERROR_CLASS_RE = /class\s*=\s*"[^"]*(?:text-danger|invalid-feedback|alert-danger)[^"]*"[^>]*>([^<]+)/gi;
function submitErrorWording(res) {
  const json = res && res.json;
  if (json) {
    const w = otpSendBodyWording(json);
    if (w) return w;
  }
  const text = String((res && res.text) || '');
  if (!text) return '';
  SUBMIT_ERROR_CLASS_RE.lastIndex = 0;
  let m;
  let tried = 0;
  while ((m = SUBMIT_ERROR_CLASS_RE.exec(text)) && tried < 5) {
    tried += 1;
    const cleaned = String(m[1] || '').replace(/\s+/g, ' ').trim()
      .replace(/[0-9০-৯]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned.slice(0, 200);
  }
  return '';
}

// FINAL-SOLUTION (2026-10-30, problem-map #14): the server's
// unexpired-OTP wording — a second send while the previous code
// is still live is REJECTED (live-proven 2026-10-30: direct 400
// 'ওটিপি-এর মেয়াদ শেষ হয়নি'), and the previous code STAYS
// valid. Matched on the server's own wording only.
const OTP_UNEXPIRED_RE = /মেয়াদ শেষ হয়নি|not expired|has not expired/i;

// DIRECT BRN-FREE ROUTE (2026-10-29): two wire fixes for the
// typing-equivalent steps (OTP send + verify), plus the removal of
// the refuted send-gate below.
//  - transitDirectName mirrors the bot path's transitName
//    (StepHandler.js: cleanName minus backticks): letters
//    (Bengali/Latin) + space only, other marks stripped, marks-only
//    → ''. The bot's typed form is exactly this — BDRIS does NOT
//    accept ` when typing (live-verified 2026-10-11) — so the direct
//    send/verify steps must not carry raw backticks or other marks.
//    Names are NEVER doubled, substituted, or otherwise invented:
//    a single name goes out as the single name, verbatim.
//  - mapDirectRelation mirrors the bot path's REL_VALUE map
//    (StepHandler.js submitS3): the site's relation radio values
//    are enums (FATHER/MOTHER/SELF/...), while the engine draft
//    carries the Bengali label (পিতা/মাতা/...). The direct path
//    previously passed the Bengali label verbatim on send, verify,
//    and submit — a direct-only defect. Known labels map to the
//    enum; enums pass through unchanged; anything else passes
//    through unchanged (never guessed).
// REMOVED 2026-10-29: the DIRECT SEND SINGLE-NAME TEST gate
// (gateSendJoinName/gateSendSingleField) that DOUBLED single names
// on the send request. The live test refuted it (OTP send returned
// 400 again with the gate live, 2026-10-29), and doubling violates
// the standing never-double rule — so the gate is deleted, not
// kept, and its test file is deleted with it. Single names now go
// out verbatim on send, as they already did on submit/verify.
function directHasLetters(s) {
  return /[A-Za-z\u0980-\u09FF]/.test(String(s || ''));
}
function transitDirectName(s) {
  const t = String(s || '').replace(/[^A-Za-z\u0980-\u09FF\u200C\u200D` ]/g, '').replace(/\s+/g, ' ').trim().replace(/`/g, '').trim();
  return directHasLetters(t) ? t : '';
}
const DIRECT_RELATION_MAP = {
  'পিতা': 'FATHER', 'মাতা': 'MOTHER', 'নিজ': 'SELF',
  'পিতামহ': 'GRANDFATHER', 'পিতামহী': 'GRANDMOTHER',
  'মাতামহ': 'MATERNALGRANDFATHER', 'মাতামহী': 'MATERNALGRANDMOTHER',
  'অভিভাবক': 'GUARDIAN', 'অন্যান্য': 'OTHERS',
};
function mapDirectRelation(v) {
  const s = String(v || '');
  return DIRECT_RELATION_MAP[s] || s;
}

/** Minimal live cookie jar: name -> value, updated from Set-Cookie. */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /** Apply one Set-Cookie header value (or an array of them). */
  updateFromSetCookie(setCookie) {
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const header of headers) {
      if (!header || typeof header !== 'string') continue;
      const first = header.split(';')[0].trim();
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      // Max-Age=0 (or a past Expires) deletes the cookie.
      if (/max-age=0/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  headerValue() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.cookies.get(name);
  }

  size() {
    return this.cookies.size;
  }
}

/**
 * Geo cache with the same rule as the existing AddressService:
 * ONLY non-empty results from a live fetch are cached, 24h TTL,
 * in-memory only (a client restart drops it). An empty result is
 * never cached, so one flaky empty list cannot stick for 24 hours.
 */
class GeoCache {
  constructor(ttlMs = GEO_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  key(parentGeoId, geoOrder, geoType, ward, geoGroup = 'birthPlace') {
    return [String(geoGroup || 'birthPlace'), String(parentGeoId), String(geoOrder), String(geoType), ward ? 'ward' : ''].join('|');
  }

  get(parentGeoId, geoOrder, geoType, ward, geoGroup = 'birthPlace') {
    const hit = this.map.get(this.key(parentGeoId, geoOrder, geoType, ward, geoGroup));
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(this.key(parentGeoId, geoOrder, geoType, ward, geoGroup));
      return null;
    }
    return hit.entries;
  }

  set(parentGeoId, geoOrder, geoType, ward, entries, geoGroup = 'birthPlace') {
    if (!Array.isArray(entries) || entries.length === 0) return; // never cache empty
    this.map.set(this.key(parentGeoId, geoOrder, geoType, ward, geoGroup), { entries, at: Date.now() });
  }

  clear() {
    this.map.clear();
  }
}

function parseMeta(html, name) {
  // Tolerates either attribute order: name/content or content/name.
  const re1 = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1] : null;
}

class BdrisHttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.base - e.g. 'https://bdris.gov.bd' (tests: mock origin)
   * @param {function} [opts.fetchImpl] - injectable fetch (tests use global fetch)
   */
  constructor(opts = {}) {
    if (!opts.base) throw err('BASE_REQUIRED', 'BdrisHttpClient requires opts.base');
    this.base = String(opts.base).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.jar = new CookieJar();
    this.geoCache = new GeoCache();
    this.csrfToken = null;
    this.csrfHeaderName = 'X-CSRF-TOKEN'; // default; replaced by meta if present
    this.bootstrapped = false;
  }

  get formUrl() {
    return this.base + FORM_PATH;
  }

  /** Low-level request: applies jar, reads Set-Cookie, returns {status, text, json}. */
  async request(path, { method = 'GET', headers = {}, body = null } = {}) {
    const res = await this.fetchImpl(this.base + path, { method, headers, body });
    const setCookie = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie');
    if (setCookie) this.jar.updateFromSetCookie(setCookie);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null; // HTML pages (form, success) are not JSON — that is expected
    }
    return { status: res.status, ok: res.ok, text, json, headers: res.headers };
  }

  /**
   * Seed this client from a warm Playwright browser session instead
   * of a standalone fetch bootstrap. Proven need (live banner
   * 2026-10-26): a bare fetch GET of the form page is blocked with
   * 403 (bot protection), while the browser session already passed
   * that challenge, so its cookies + page CSRF are the only session
   * a fetch-based geo call can use. cookies are Playwright-format
   * {name, value} entries (or a Cookie header string); the CSRF
   * token comes from the page (meta _csrf first, then the form's
   * inline `csrf` variable, then the hidden `_csrf` field — the
   * same order the form's own util.js uses; see HttpGeoService
   * seedFromPage). After seeding, bootstrapped is true and no
   * form-GET bootstrap is ever attempted for this client.
   */
  seedFromBrowser({ cookies = [], csrfToken = null, csrfHeaderName = null } = {}) {
    const list = Array.isArray(cookies)
      ? cookies
      : String(cookies || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        return eq > 0 ? { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() } : null;
      }).filter(Boolean);
    for (const c of list) {
      if (c && c.name) this.jar.cookies.set(c.name, c.value);
    }
    if (!csrfToken) {
      throw err('BOOTSTRAP_NO_CSRF', 'Browser page has no CSRF token (meta _csrf, inline csrf and hidden _csrf field all absent); cannot build API headers.');
    }
    this.csrfToken = csrfToken;
    if (csrfHeaderName) this.csrfHeaderName = csrfHeaderName;
    this.bootstrapped = true;
    return { cookies: this.jar.size() };
  }

  /** Headers every BDRIS API call must carry (verified). */
  apiHeaders(extra = {}) {
    if (!this.bootstrapped) {
      throw err('NOT_BOOTSTRAPPED', 'Call bootstrap() (GET the form page) before any API call.');
    }
    const cookie = this.jar.headerValue();
    return {
      ...(cookie ? { Cookie: cookie } : {}),
      [this.csrfHeaderName]: this.csrfToken,
      'x-requested-with': 'XMLHttpRequest',
      Referer: this.formUrl,
      client: 'bris',
      Accept: 'application/json',
      ...extra,
    };
  }

  /**
   * Session bootstrap: GET the form page, keep its cookies, parse CSRF.
   * @param {string} [formPath] - override only for tests (mock no-meta page)
   */
  async bootstrap(formPath = FORM_PATH) {
    const res = await this.request(formPath);
    if (!res.ok) throw err('BOOTSTRAP_FAILED', `Form page GET failed with status ${res.status}`);
    const token = parseMeta(res.text, '_csrf');
    const headerName = parseMeta(res.text, '_csrf_headerName');
    if (!token) {
      throw err('BOOTSTRAP_NO_CSRF', 'Form page has no meta _csrf token; cannot build API headers.');
    }
    this.csrfToken = token;
    if (headerName) this.csrfHeaderName = headerName;
    this.bootstrapped = true;
    return { csrfHeaderName: this.csrfHeaderName, cookies: this.jar.size() };
  }

  /**
   * One geo-cascade step. Returns {entries, targetGeoOrder, geoOrder, geoType, geoGroup}.
   * entries are normalised to {id, nameEn, nameBn, geoLevelId, geoCode, parentGeoId}.
   */
  async getGeo(parentGeoId, geoOrder, geoType, { ward = false, geoGroup = 'birthPlace' } = {}) {
    if (parentGeoId === undefined || parentGeoId === null || parentGeoId === '') {
      throw err('PARENT_REQUIRED', 'getGeo requires parentGeoId (taken from the previous step).');
    }
    const cached = this.geoCache.get(parentGeoId, geoOrder, geoType, ward, geoGroup);
    if (cached) return { entries: cached, cached: true };

    const qs = new URLSearchParams({
      geoGroup: geoGroup || 'birthPlace',
      geoOrder: String(geoOrder),
      geoType: String(geoType),
    });
    if (ward) qs.set('ward', 'true');
    const path = `${GEO_PATH}/${encodeURIComponent(String(parentGeoId))}?${qs.toString()}`;
    const res = await this.request(path, { headers: this.apiHeaders() });
    if (!res.ok || !res.json || !Array.isArray(res.json.geoObject)) {
      throw err('GEO_BAD_RESPONSE', `Geo call ${path} returned status ${res.status} without a geoObject array.`);
    }
    const entries = res.json.geoObject.map((o) => ({
      id: o.id,
      nameEn: o.nameEn,
      nameBn: o.nameBn,
      geoLevelId: o.geoLevelId,
      geoCode: o.geoCode,
      parentGeoId: o.parentGeoId,
    }));
    this.geoCache.set(parentGeoId, geoOrder, geoType, ward, entries, geoGroup);
    return {
      entries,
      cached: false,
      targetGeoOrder: res.json.targetGeoOrder,
      geoOrder: res.json.geoOrder,
      geoType: res.json.geoType,
      geoGroup: res.json.geoGroup,
    };
  }

  /**
   * Walk a geo chain by nameBn. Each step picks one entry with the
   * shared loose matcher (exact, substring, dot/dash/space-stripped);
   * the next parent is that entry's id and the next order is the previous
   * response's targetGeoOrder — never order+1.
   *
   * @param {object} opts
   * @param {string|number} opts.firstParentId - REQUIRED explicit input
   *   (first-parent source unproven; never defaulted to 4 here).
   * @param {number} opts.firstGeoOrder - order of the first step (caller input).
   * @param {Array<{geoType:number, nameBn:string, ward?:boolean}>} opts.steps
   * @returns {Promise<Array<{step, chosen, targetGeoOrder}>>}
   */
  async walkGeoChain({ firstParentId, firstGeoOrder, steps, geoGroup = 'birthPlace' }) {
    if (firstParentId === undefined || firstParentId === null || firstParentId === '') {
      throw err(
        'FIRST_PARENT_REQUIRED',
        'walkGeoChain requires explicit firstParentId (for a Bangladesh chain this is "1", bangladeshId from the pasted form source) and must not be guessed.',
      );
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw err('STEPS_REQUIRED', 'walkGeoChain requires a non-empty steps array.');
    }
    const out = [];
    let parent = firstParentId;
    let order = firstGeoOrder;
    for (const step of steps) {
      const res = await this.getGeo(parent, order, step.geoType, { ward: !!step.ward, geoGroup: step.geoGroup || geoGroup });
      const chosen = findGeoEntry(res.entries, step.nameBn);
      if (!chosen) {
        throw err(
          'GEO_NOT_FOUND',
          `No geo entry with nameBn "${step.nameBn}" under parent ${parent} (order ${order}, type ${step.geoType}${step.ward ? ', ward=true' : ''}).`,
        );
      }
      out.push({ step, chosen, targetGeoOrder: res.targetGeoOrder });
      parent = chosen.id;
      order = res.targetGeoOrder; // follow the response; orders can jump (e.g. 3 -> 5)
    }
    return out;
  }

  /**
   * Office lookups — URL ONLY is verified (from the form page script).
   * Query/payload shapes are UNVERIFIED, so the caller supplies params
   * verbatim; nothing is invented here. Response is returned as-is.
   */
  async findOfficeByGeoId(params = {}) {
    return this.officeGet(OFFICE_BY_GEO_PATH, params);
  }

  async findOfficeGeoProjectionByGeoId(params = {}) {
    return this.officeGet(OFFICE_PROJECTION_PATH, params);
  }

  async officeGet(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await this.request(qs ? `${path}?${qs}` : path, { headers: this.apiHeaders() });
    if (!res.ok) throw err('OFFICE_BAD_RESPONSE', `Office lookup ${path} returned status ${res.status}.`);
    return res.json;
  }

  /**
   * Probe-only raw office lookup (2026-10-27): the same request as
   * officeGet, but returns the raw response shape instead of just
   * the parsed JSON, so a live probe can distinguish "empty body"
   * from "HTML page served with 200" from "JSON null" — the three
   * cases officeGet collapses to a bare null. NEVER used by the
   * submit chain: officeGet keeps its strict contract there.
   * Does not throw on HTTP status (the probe records it); only a
   * network failure propagates. No cookies, tokens or headers are
   * included in the returned record.
   */
  async officeGetRaw(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${path}?${qs}` : path;
    const res = await this.request(url, { headers: this.apiHeaders() });
    const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
    return {
      url,
      status: res.status,
      ok: res.ok,
      contentType,
      bodyLength: res.text ? res.text.length : 0,
      bodyPreview: res.text ? res.text.slice(0, 300) : '',
      json: res.json,
    };
  }

  async findOfficeByGeoIdRaw(params = {}) {
    return this.officeGetRaw(OFFICE_BY_GEO_PATH, params);
  }

  /**
   * Probe-only raw page fetch (2026-10-27): GET a same-origin path
   * with the SEEDED session — apiHeaders throws NOT_BOOTSTRAPPED
   * when unseeded, so a bare fetch is never attempted here.
   * Returns {url, status, ok, contentType, bodyLength, text} and
   * never throws on HTTP status; only a network failure propagates.
   * Used by the script probe to read the form page's own script.
   */
  async fetchPageText(path) {
    const res = await this.request(path, { headers: this.apiHeaders() });
    const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
    return { url: path, status: res.status, ok: res.ok, contentType, bodyLength: res.text ? res.text.length : 0, text: res.text || '' };
  }

  async fetchFormPageText() {
    return this.fetchPageText(FORM_PATH);
  }

  async findOfficeGeoProjectionByGeoIdRaw(params = {}) {
    return this.officeGetRaw(OFFICE_PROJECTION_PATH, params);
  }

  /**
   * Document upload. attachmentType must be 40 or 41; attachmentSubType
   * is always -1; _csrf goes both as a form field and as a header.
   * Returns {url, id, attachmentTypeId, name, thumbnailUrl, deleteUrl}
   * taken from files[0] of the response.
   */
  async uploadDocument({ fileBuffer, filename, mimeType, attachmentType }) {
    if (!UPLOAD_TYPES.includes(attachmentType)) {
      throw err('UPLOAD_BAD_TYPE', `attachmentType must be 40 or 41 (the two mandatory types), got ${attachmentType}.`);
    }
    if (!Buffer.isBuffer(fileBuffer)) {
      throw err('UPLOAD_BAD_FILE', 'uploadDocument requires fileBuffer as a Buffer.');
    }
    if (fileBuffer.length > MAX_UPLOAD_BYTES) {
      throw err('FILE_TOO_LARGE', `Upload file is ${fileBuffer.length} bytes, over the 2MB limit.`);
    }
    if (!UPLOAD_MIME_TYPES.includes(mimeType)) {
      throw err('UPLOAD_BAD_MIME', `Upload file must be JPG or PNG, got ${mimeType}.`);
    }
    const form = new FormData();
    form.append('attachmentType', String(attachmentType));
    form.append('attachmentSubType', '-1');
    form.append('_csrf', this.csrfToken);
    form.append('files', new Blob([fileBuffer], { type: mimeType }), filename);
    // Note: no manual Content-Type — fetch sets the multipart boundary.
    const res = await this.request(UPLOAD_PATH, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: form,
    });
    if (!res.ok || !res.json || !Array.isArray(res.json.files) || !res.json.files[0]) {
      throw err('UPLOAD_BAD_RESPONSE', `Upload returned status ${res.status} without a files[0] entry.`);
    }
    const f = res.json.files[0];
    return {
      url: f.url,
      id: f.id,
      attachmentTypeId: f.attachmentTypeId,
      name: f.name,
      thumbnailUrl: f.thumbnailUrl,
      deleteUrl: f.deleteUrl,
    };
  }

  /**
   * OTP send — source-proven shape (pasted form page inline handler):
   * POST /api/otp/sent, query = the otpSend context (appType, phone,
   * email, officeId, personUbrn + applicantInfo: relation,
   * applicantName, applicantBrn, applicantDob, officeAddressType),
   * body = only the six person/parent name fields
   * (buildOtpSendBody). The response carries no token/id (payload
   * is null) — LIVE-CONFIRMED 2026-10-27 (Stage C user run):
   * {code: 'MESSAGE_SENT', success: true, payload: null}.
   * Verify must therefore reuse the same context plus
   * the geoLocationId derived from officeAddressType.
   */
  async otpSend(data = {}) {
    const { phone = '', email = '', officeId = '', personUbrn = '', relation = '', applicantName = '', applicantBrn = '', applicantDob = '', officeAddressType = '' } = data;
    // DIRECT BRN-FREE ROUTE: send query carries the transit
    // (typed) applicant name and the enum relation — never a
    // doubled name, never a raw backtick, never a Bengali label
    // where the site's radio value is the enum.
    const qs = new URLSearchParams({
      appType: 'BIRTH_REGISTRATION_APPLICATION',
      phone,
      email,
      // LIVE-CONFIRMED 2026-10-27 (Stage C): officeId 0 when empty.
      officeId: officeId || '0',
      personUbrn,
      relation: mapDirectRelation(relation),
      applicantName: transitDirectName(applicantName),
      applicantBrn,
      applicantDob,
      officeAddressType: mapOfficeAddressType(officeAddressType),
    });
    const body = buildOtpSendBody(data);
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.append(k, v);
    const res = await this.request(`${OTP_SENT_PATH}?${qs.toString()}`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: form,
    });
    if (!res.ok || !res.json) {
      // DIRECT OTP BODY (2026-10-29): a non-ok response body names
      // the site's own reason (message else code, ≤200 chars) — the
      // old message carried only the status, so a 400 never said
      // whether it meant duplicate or payload. Non-JSON bodies and
      // bodies without a wording keep the exact previous message;
      // an ok response without JSON keeps it too (wording is read
      // for non-ok responses only).
      const wording = !res.ok ? otpSendBodyWording(res.json) : '';
      // FINAL-SOLUTION (2026-10-30, problem-map #8): session-dead
      // detection, ONLY for proven-dead shapes. A redirect/auth
      // status, or a 2xx body that is not JSON (we landed on an
      // HTML / stub / login page, not the API), is NEVER a valid
      // send proof — the session context is gone. Live-proven
      // 2026-10-30: a 200 non-JSON send and 302 bot sends both
      // produced UI "sent" confirmations while no SMS ever left.
      // SESSION_DEAD carries the code so the chain and the UI
      // can show "session refresh needed" instead of falling
      // back to a bot replay on the same dead session or
      // claiming delivery. A NON-2xx non-JSON body is NOT
      // classified dead: a 400/500 HTML body is a server answer
      // without wording, and the bot fallback stays available
      // for it (old OTP_SEND_FAILED status-only message kept).
      if (res.status === 301 || res.status === 302 || res.status === 401 || res.status === 403
          || (res.ok && !res.json)) {
        throw err('SESSION_DEAD', `OTP send got a non-JSON response (status ${res.status}) — session refresh needed.`);
      }
      // FINAL-SOLUTION (2026-10-30, problem-map #14): a 400 whose
      // wording says the previous OTP has not expired is NOT a
      // generic send failure and must NOT trigger a bot replay —
      // the previous code is still valid. Machine-readable code
      // so the chain/UI can say exactly that.
      if (res.status === 400 && OTP_UNEXPIRED_RE.test(wording)) {
        throw err('OTP_SEND_UNEXPIRED', `OTP send returned status 400: ${wording}. Previous code still valid.`);
      }
      throw err('OTP_SEND_FAILED', wording
        ? `OTP send returned status ${res.status}: ${wording}.`
        : `OTP send returned status ${res.status}.`);
    }
    return res.json; // {code, message, success, payload}
  }

  /**
   * OTP verify — source-proven shape (pasted form page inline
   * handler): POST /api/otp/verify, query params only, EMPTY body.
   * Query: otp, appType, personUbrn, phone, geoLocationId (the
   * office group's LocationId: birthPlaceLocationId when
   * officeAddressType is BIRTHPLACE, permAddrLocationId when
   * PERMANENT), email, officeId + applicantInfo (relation,
   * applicantName, applicantBrn, applicantDob, officeAddressType).
   * Success = top-level isVerified === true in the response
   * (LIVE-CONFIRMED 2026-10-27, Stage C user run; data.isVerified
   * also accepted). officeId defaults to '0' when empty (same
   * live proof; no /api/office/* lookup is performed).
   * Throws OTP_REQUIRED / OTP_BAD_FORMAT instead of guessing.
   */
  async verifyOtp(data = {}) {
    const qs = buildVerifyQuery(data);
    const res = await this.request(`${VERIFY_PATH}?${qs.toString()}`, {
      method: 'POST',
      headers: this.apiHeaders(),
    });
    if (!res.ok) {
      throw err('VERIFY_FAILED', `OTP verify returned status ${res.status}.`);
    }
    const json = res.json !== null ? res.json : { ok: res.ok, text: res.text };
    // Strict success check (fixed 2026-10-28, found by the final-
    // wiring tests): the old check required json.data to exist
    // before testing anything, so a response WITHOUT a data
    // wrapper — including {isVerified: false} — passed as
    // verified. Now any one true signal verifies, and anything
    // else throws; a failed verify must never reach submit.
    const verified = !!json && (json.isVerified === true || json.verified === true || json.success === true
      || (json.data && json.data.isVerified === true));
    if (!verified) {
      throw err('VERIFY_NOT_VERIFIED', 'OTP verify response does not report isVerified === true.');
    }
    return json;
  }

  /**
   * Final submit — the form's OWN POST (source-proven page flow):
   * multipart/form-data to /br/application with every field from
   * buildSubmitPayload() + one `attachments` field per uploaded
   * document id + _csrf. The response is accepted ONLY in the
   * verified success shape: HTML containing the Bengali success
   * phrase (plus print link if present), or JSON with
   * success === true. Anything else throws SUBMIT_NOT_SUCCESS /
   * SUBMIT_BAD_RESPONSE — never a silent pass. No application
   * number is extracted (format unverified).
   */
  async submitApplication(data = {}) {
    const payload = buildSubmitPayload(data);
    const form = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'attachments') continue;
      form.append(k, String(v));
    }
    for (const id of payload.attachments || []) form.append('attachments', String(id));
    form.append('_csrf', this.csrfToken);
    const res = await this.request(SUBMIT_PATH, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: form,
    });
    if (!res.ok) {
      const wording = submitRejectionWording(res);
      const e = err('SUBMIT_BAD_RESPONSE', wording
        ? `Submit returned status ${res.status}: ${wording}.`
        : `Submit returned status ${res.status}.`);
      // FINAL-SOLUTION (problem-map #1): shape/status only, never
      // text — the chain logs this so filed-vs-not is provable.
      // SUBMIT-FINAL: the error wording rides along too (wording
      // only, see submitErrorWording) so the journal can name
      // the validation reason instead of only the shape.
      e.responseSummary = submitResponseSummary(res);
      e.responseErrorWording = submitErrorWording(res);
      throw e;
    }
    if (res.json && res.json.success === true) {
      return { success: true, hasPrintLink: false, json: res.json, responseSummary: submitResponseSummary(res) };
    }
    const parsed = parseSuccessPage(res.text);
    if (!parsed.success) {
      const field = submitRejectionField(res);
      const extra = [field ? `[field: ${field}]` : '', familyRejectionMarker(res)].filter(Boolean).join(' ');
      const e = err('SUBMIT_NOT_SUCCESS', extra
        ? `Submit response contains neither success:true JSON nor the verified success phrase. ${extra}`
        : 'Submit response contains neither success:true JSON nor the verified success phrase.');
      // Same summary here: a re-rendered form page (formFields
      // true, successPhrase false) is NOT a proven rejection —
      // the [field: …] extra above is a weak word-scan only, and
      // the summary is what lets the next diagnosis tell the two
      // apart. The message text itself is unchanged.
      // SUBMIT-FINAL: error wording attached (wording only).
      e.responseSummary = submitResponseSummary(res);
      e.responseErrorWording = submitErrorWording(res);
      throw e;
    }
    return { success: true, hasPrintLink: parsed.hasPrintLink, json: res.json, responseSummary: submitResponseSummary(res) };
  }
}

/**
 * Form-submit payload builder (pure, no I/O).
 *
 * Field NAMES from the pasted form page source (2026-10-25),
 * flat dotted names, for the form's own POST to /br/application:
 *  - Person: personInfoForBirth.personFirstNameBn /
 *    personLastNameBn / personFirstNameEn / personLastNameEn, plus
 *    the joined personNameBn / personNameEn (site join rule: first +
 *    ' ' + last; a first-name-only applicant joins to the first name
 *    alone — the standing 1-name rule), personBirthDate, thChild,
 *    gender (MALE/FEMALE/THIRD_GENDER), religionOther, personNid,
 *    plus hidden religion=NOT_APPLICABLE.
 *  - Parents (base personInfoForBirth.father./mother.): id, ubrn,
 *    personBirthDate, personNameBn, personNameEn, passportNumber,
 *    personNationality (numeric; 1 = Bangladeshi). Pre-2013 and
 *    2013 applicants leave ubrn empty (pre-2013: live-verified
 *    2013 rule; 2013: 2026-10-29 ID-card-only rule).
 *  - Addresses (prefixes birthPlace / permAddr / prsntAddr):
 *    Country, Div, Dist, CityCorpCantOrUpazila, PaurasavaOrUnion,
 *    WardInCityCorp, Area, WardInPaurasavaOrUnion, City, PostOfc,
 *    PostOfcEn, PostCode, VilAreaTownBn, VilAreaTownEn, HouseRoadBn,
 *    HouseRoadEn, LocationId, En, Bn. PostCode is carried only if
 *    supplied. The old copy flags are NOT form fields and are dropped.
 *  - Documents: `attachments` = the uploaded file ids for types 40
 *    and 41 (the form's hidden `attachments` inputs), NOT a JSON
 *    documents array. The upload itself is verified.
 *  - Basis/contact: officeAddressType (BIRTHPLACE/PERMANENT/MISSION),
 *    officeId, geoLocationId (office group's LocationId),
 *    relationWithApplicant, applicantBrn, applicantDob,
 *    applicantName, declaration, email, phone, otp.
 *  Still CANDIDATE in one respect: this builder has never been
 *  run live against bdris.gov.bd, so a live rejection still falls
 *  back to Playwright. Field names above are source-proven; the
 *  live run is what remains.
 *
 * Input shape: canonical keys (person, father, mother, birthPlace,
 * permAddr, prsntAddr, relation, applicantName, declaration, email,
 * phone, officeAddressType, officeId, documents, otp, addressType),
 * with the frontend draft aliases s1 / s2 / s2b / s3 accepted for
 * person / parents / addresses / relation+documents.
 * Missing required fields throw MISSING_SUBMIT_FIELD listing every
 * missing field name — never a silent guess.
 */
function buildSubmitPayload(data = {}) {
  const missing = [];
  const req = (value, name) => {
    if (value === undefined || value === null || String(value).trim() === '') missing.push(name);
    return value;
  };
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  const person = data.person || data.s1 || {};
  const s2 = data.s2 || {};
  const father = data.father || s2.father || {};
  const mother = data.mother || s2.mother || {};
  const s2b = data.s2b || {};
  const birthPlace = data.birthPlace || {};
  const permAddr = data.permAddr || s2b.perm || {};
  const prsntAddr = data.prsntAddr || s2b.pres || {};
  const s3 = data.s3 || {};
  const documents = data.documents || s3.documents || [];

  const firstBn = req(person.firstNameBn, 'person.firstNameBn');
  const lastBn = person.lastNameBn;
  const firstEn = req(person.firstNameEn, 'person.firstNameEn');
  const lastEn = person.lastNameEn;
  const dob = req(person.dob, 'person.dob');
  req(person.thChild, 'person.thChild');
  req(person.gender, 'person.gender');
  // Joined names follow the site rule: first + ' ' + last, or the
  // first name alone for a 1-name applicant (never a doubled name).
  const joinName = (first, last) => {
    const f = str(first).trim();
    const l = str(last).trim();
    return l ? `${f} ${l}` : f;
  };
  req(father.nameBn, 'father.nameBn');
  req(father.nameEn, 'father.nameEn');
  req(mother.nameBn, 'mother.nameBn');
  req(mother.nameEn, 'mother.nameEn');

  const addressFields = (addr, prefix, label) => {
    req(addr.division, `${label}.division`);
    req(addr.district, `${label}.district`);
    req(addr.cityCorpUpazila, `${label}.cityCorpUpazila`);
    req(addr.postOfficeBn || addr.postBn, `${label}.postOfficeBn`);
    req(addr.postOfficeEn || addr.postEn, `${label}.postOfficeEn`);
    req(addr.villageBn || addr.vilBn, `${label}.villageBn`);
    req(addr.villageEn || addr.vilEn, `${label}.villageEn`);
    return {
      [`${prefix}Country`]: str(addr.country || 'বাংলাদেশ'),
      [`${prefix}Div`]: str(addr.division),
      [`${prefix}Dist`]: str(addr.district),
      [`${prefix}CityCorpCantOrUpazila`]: str(addr.cityCorpUpazila),
      [`${prefix}PaurasavaOrUnion`]: str(addr.paurasavaUnion),
      [`${prefix}WardInCityCorp`]: str(addr.wardInCityCorp),
      [`${prefix}Area`]: str(addr.area),
      [`${prefix}WardInPaurasavaOrUnion`]: str(addr.ward),
      [`${prefix}City`]: str(addr.city),
      [`${prefix}PostOfc`]: str(addr.postOfficeBn || addr.postBn),
      [`${prefix}PostOfcEn`]: str(addr.postOfficeEn || addr.postEn),
      [`${prefix}PostCode`]: str(addr.postCode),
      [`${prefix}VilAreaTownBn`]: str(addr.villageBn || addr.vilBn),
      [`${prefix}VilAreaTownEn`]: str(addr.villageEn || addr.vilEn),
      [`${prefix}HouseRoadBn`]: str(addr.houseRoadBn || addr.houseBn),
      [`${prefix}HouseRoadEn`]: str(addr.houseRoadEn || addr.houseEn),
      [`${prefix}LocationId`]: str(addr.locationId),
      [`${prefix}En`]: str(addr.en),
      [`${prefix}Bn`]: str(addr.bn),
    };
  };
  const birthFields = addressFields(birthPlace, 'birthPlace', 'birthPlace');
  const permFields = addressFields(permAddr, 'permAddr', 'permAddr');
  const presFields = addressFields(prsntAddr, 'prsntAddr', 'prsntAddr');

  const relation = req(data.relation || s3.relation, 'relation');
  const applicantName = req(
    data.applicantName || s3.applicantName || joinName(firstEn, lastEn),
    'applicantName',
  );
  const phone = req(data.phone || (data.s4prep && data.s4prep.phone), 'phone');

  const docsByType = new Map();
  for (const d of documents) {
    const t = Number(d.attachmentType !== undefined ? d.attachmentType : d.attachmentTypeId);
    if (t === 40 || t === 41) {
      docsByType.set(t, {
        attachmentType: t,
        attachmentTypeId: d.attachmentTypeId !== undefined ? d.attachmentTypeId : t,
        url: d.url || '',
        id: d.id !== undefined ? d.id : null,
      });
    }
  }
  if (!docsByType.has(40)) missing.push('documents[40]');
  if (!docsByType.has(41)) missing.push('documents[41]');

  const brnDecision = parentBrnDirectDecision(data);
  const otp = req(data.otp, 'otp');
  if (otp && !/^\d{6}$/.test(String(otp).replace(/\D/g, ''))) missing.push('otp (must be 6 digits)');

  if (missing.length) {
    throw err('MISSING_SUBMIT_FIELD', `Cannot build submit payload, missing required fields: ${missing.join(', ')}`);
  }

  const officeType = mapOfficeAddressType(data.officeAddressType || (data.s4prep && data.s4prep.officeAddressType) || data.addressType);
  const geoLocationId = officeType === 'PERMANENT'
    ? str(permAddr.locationId || data.permGeoLocationId || data.geoLocationId)
    : str(birthPlace.locationId || data.birthGeoLocationId || data.geoLocationId);
  const attachmentIds = [docsByType.get(40), docsByType.get(41)].map((d) => d.id);
  return {
    officeAddressType: officeType,
    // LIVE-CONFIRMED 2026-10-27 (Stage C): officeId 0 when empty.
    officeId: str(data.officeId || (data.s4prep && data.s4prep.officeId)) || '0',
    geoLocationId,
    'personInfoForBirth.personFirstNameBn': str(firstBn),
    'personInfoForBirth.personLastNameBn': str(lastBn),
    'personInfoForBirth.personFirstNameEn': str(firstEn),
    'personInfoForBirth.personLastNameEn': str(lastEn),
    'personInfoForBirth.personNameBn': joinName(firstBn, lastBn),
    'personInfoForBirth.personNameEn': joinName(firstEn, lastEn),
    'personInfoForBirth.personBirthDate': str(dob),
    'personInfoForBirth.thChild': str(person.thChild),
    'personInfoForBirth.gender': mapGender(person.gender),
    'personInfoForBirth.religionOther': str(person.religionOther),
    'personInfoForBirth.personNid': str(person.nid || person.personNid),
    religion: 'NOT_APPLICABLE',
    'personInfoForBirth.father.id': str(father.id),
    'personInfoForBirth.father.ubrn': str(brnDecision.fatherUbrn),
    'personInfoForBirth.father.personBirthDate': str(father.dob),
    'personInfoForBirth.father.personNameBn': str(father.nameBn),
    'personInfoForBirth.father.personNameEn': str(father.nameEn),
    'personInfoForBirth.father.passportNumber': str(father.passportNumber),
    'personInfoForBirth.father.personNationality': mapNationality(father.nationality),
    'personInfoForBirth.mother.id': str(mother.id),
    'personInfoForBirth.mother.ubrn': str(brnDecision.motherUbrn),
    'personInfoForBirth.mother.personBirthDate': str(mother.dob),
    'personInfoForBirth.mother.personNameBn': str(mother.nameBn),
    'personInfoForBirth.mother.personNameEn': str(mother.nameEn),
    'personInfoForBirth.mother.passportNumber': str(mother.passportNumber),
    'personInfoForBirth.mother.personNationality': mapNationality(mother.nationality),
    ...birthFields,
    ...permFields,
    ...presFields,
    // DIRECT BRN-FREE ROUTE: relationWithApplicant carries the
    // site's enum value (bot REL_VALUE map), not the draft's
    // Bengali label. Person/parent names above stay VERBATIM on
    // purpose: the submit payload IS the final record, and the
    // bot's final step re-applies the backtick form through the
    // site's own handler — whether the direct form POST accepts
    // a backtick in the final record is a live-test question
    // (see DIRECT-BRN-FREE-LIVE-TEST.md), not something to guess
    // by stripping the draft's names here. VERBATIM RESTORED per
    // user directive 2026-10-30 that ALL logics are required:
    // the SUBMIT-FINAL transit change is rejected; the wall
    // cause must be learned from the error-wording diagnostic.
    relationWithApplicant: mapDirectRelation(relation),
    applicantBrn: str(data.applicantBrn || person.brn),
    applicantDob: str(data.applicantDob || dob),
    applicantName: str(applicantName),
    declaration: data.declaration !== undefined ? !!data.declaration : true,
    email: str(data.email || (data.s4prep && data.s4prep.email)),
    phone: str(phone),
    otp: String(otp).replace(/\D/g, ''),
    attachments: attachmentIds,
  };
}

/** Map the app's Bengali gender labels to the form's enum values. */
function mapGender(v) {
  const s = String(v || '').trim();
  if (s === 'পুরুষ' || s === 'MALE') return 'MALE';
  if (s === 'মহিলা' || s === 'FEMALE') return 'FEMALE';
  if (s === 'তৃতীয় লিঙ্গ' || s === 'THIRD_GENDER') return 'THIRD_GENDER';
  return s;
}

/** Map the app's nationality label to the form's numeric option value. */
function mapNationality(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s === '' || s === 'বাংলাদেশী') return '1';
  if (/^\d+$/.test(s)) return s;
  return s;
}

/** Map legacy BIRTH/PERMANENT to the form's officeAddressType values. */
function mapOfficeAddressType(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'BIRTH' || s === 'BIRTHPLACE') return 'BIRTHPLACE';
  if (s === 'PERMANENT') return 'PERMANENT';
  if (s === 'MISSION') return 'MISSION';
  return s;
}

/**
 * OTP-send body builder (pure, no I/O) — source-proven: only the
 * six person/parent name fields. Accepts the canonical shape
 * (person/father/mother) or the flat joined names.
 */
function buildOtpSendBody(data = {}) {
  const person = data.person || data.s1 || {};
  const s2 = data.s2 || {};
  const father = data.father || s2.father || {};
  const mother = data.mother || s2.mother || {};
  // DIRECT BRN-FREE ROUTE: the six send-body fields carry the
  // transit (typed) form — backticks/marks stripped, names never
  // doubled. A split name joins first + ' ' + last (or first
  // alone); an explicitly joined name transits as-is.
  const joinTransit = (joined, first, last) => {
    if (joined) return transitDirectName(joined);
    const f = String(first || '').trim();
    const l = String(last || '').trim();
    return transitDirectName(l ? `${f} ${l}` : f);
  };
  return {
    'personInfoForBirth.personNameBn': joinTransit(person.personNameBn, person.firstNameBn, person.lastNameBn),
    'personInfoForBirth.personNameEn': joinTransit(person.personNameEn, person.firstNameEn, person.lastNameEn),
    'personInfoForBirth.father.personNameBn': transitDirectName(father.personNameBn || father.nameBn || ''),
    'personInfoForBirth.father.personNameEn': transitDirectName(father.personNameEn || father.nameEn || ''),
    'personInfoForBirth.mother.personNameBn': transitDirectName(mother.personNameBn || mother.nameBn || ''),
    'personInfoForBirth.mother.personNameEn': transitDirectName(mother.personNameEn || mother.nameEn || ''),
  };
}

/**
 * OTP-verify query builder (pure, no I/O) — source-proven shape:
 * POST /api/otp/verify with query params only, empty body.
 * geoLocationId is derived from officeAddressType: BIRTHPLACE uses
 * the birth-place LocationId, PERMANENT uses the permanent
 * LocationId; a caller-supplied geoLocationId wins when present.
 */
function buildVerifyPayload(data = {}) {
  const otp = String(data.otp || '').replace(/\D/g, '');
  if (!otp) throw err('OTP_REQUIRED', 'verifyOtp requires data.otp.');
  if (!/^\d{6}$/.test(otp)) throw err('OTP_BAD_FORMAT', 'OTP must be 6 digits.');
  const officeType = mapOfficeAddressType(data.officeAddressType);
  const geoLocationId = String(data.geoLocationId || '')
    || (officeType === 'PERMANENT' ? String(data.permAddrLocationId || data.permLocationId || '') : String(data.birthPlaceLocationId || data.birthLocationId || ''));
  return {
    otp,
    appType: 'BIRTH_REGISTRATION_APPLICATION',
    personUbrn: String(data.personUbrn || ''),
    phone: String(data.phone || ''),
    geoLocationId,
    email: String(data.email || ''),
    officeId: String(data.officeId || '0'),
    relation: mapDirectRelation(data.relation || ''),
    applicantName: transitDirectName(data.applicantName || ''),
    applicantBrn: String(data.applicantBrn || ''),
    applicantDob: String(data.applicantDob || ''),
    officeAddressType: officeType,
  };
}

function buildVerifyQuery(data = {}) {
  return new URLSearchParams(buildVerifyPayload(data));
}

/**
 * Minimal success-page check for later parsing. Only asserts what the
 * verified shape states: the success phrase and the print link.
 * It does not try to extract an application number (format unverified).
 */
function parseSuccessPage(html) {
  if (typeof html !== 'string') return { success: false, hasPrintLink: false };
  return {
    success: html.includes(SUCCESS_PHRASE),
    hasPrintLink: html.includes(PRINT_PATH),
  };
}

module.exports = {
  BdrisHttpClient,
  CookieJar,
  GeoCache,
  parseSuccessPage,
  buildSubmitPayload,
  transitDirectName,
  mapDirectRelation,
  parentBrnDirectDecision,
  normalizeDirectBrn,
  isPre2013Direct,
  isParentBrnExemptDirect,
  submitRejectionWording,
  submitRejectionField,
  submitResponseSummary,
  submitSummaryText,
  submitErrorWording,
  OTP_UNEXPIRED_RE,
  isFamilyRejectionText,
  familyRejectionMarker,
  DIRECT_FAMILY_NOTE,
  buildVerifyPayload,
  buildOtpSendBody,
  buildVerifyQuery,
  mapGender,
  mapNationality,
  mapOfficeAddressType,
  FORM_PATH,
  GEO_PATH,
  UPLOAD_PATH,
  OTP_SENT_PATH,
  VERIFY_PATH,
  REGISTER_PATH,
  SUBMIT_PATH,
  PRINT_PATH,
  SUCCESS_PHRASE,
  GEO_CACHE_TTL_MS,
  MAX_UPLOAD_BYTES,
};
