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
 *    entry's id as the next parent. Names are matched on nameBn.
 *  - Document upload to POST /admin/doc/upload (multipart, types 40/41).
 *  - OTP send over GET /api/otp/sent (no token/id is returned).
 *
 * What this module does NOT do (still UNOBSERVED — see DESIGN.md):
 *  - OTP verify (/api/otp/verify): request params unobserved.
 *  - Final submit (/api/br/application/register): method + payload field
 *    list unobserved.
 *  Both are explicit NOT_IMPLEMENTED stubs that throw. Until they are
 *  observed, the current Playwright v2 path remains the fallback for
 *  those two steps: hybrid = HTTP for geo/docs/OTP-send, Playwright
 *  for verify+submit. Never claim this HTTP path is complete.
 *
 * Also UNPROVEN: the first parent id of the geo chain (observed chains
 * start at parent 4, while the page script shows bangladeshId=null).
 * walkGeoChain() therefore REQUIRES firstParentId as an explicit caller
 * input and refuses to run without it. The value 4 is NOT hardcoded
 * anywhere in this module as a fact.
 *
 * Node built-ins only (global fetch/FormData/Blob). No new npm deps.
 * Never contacts a live host in tests — tests use a local mock server.
 */

'use strict';

const FORM_PATH = '/br/application';
const GEO_PATH = '/v1/api/geo/parentGeoIdWithGeoGroupAndGeoOrder';
const UPLOAD_PATH = '/admin/doc/upload';
const OTP_SENT_PATH = '/api/otp/sent';
const OFFICE_BY_GEO_PATH = '/api/office/find-by-geo-id';
const OFFICE_PROJECTION_PATH = '/api/office/find-office-geo-projection-by-geo-id';
const VERIFY_PATH = '/api/otp/verify';
const SUBMIT_PATH = '/api/br/application/register';
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

  key(parentGeoId, geoOrder, geoType, ward) {
    return [String(parentGeoId), String(geoOrder), String(geoType), ward ? 'ward' : ''].join('|');
  }

  get(parentGeoId, geoOrder, geoType, ward) {
    const hit = this.map.get(this.key(parentGeoId, geoOrder, geoType, ward));
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(this.key(parentGeoId, geoOrder, geoType, ward));
      return null;
    }
    return hit.entries;
  }

  set(parentGeoId, geoOrder, geoType, ward, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return; // never cache empty
    this.map.set(this.key(parentGeoId, geoOrder, geoType, ward), { entries, at: Date.now() });
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
  async getGeo(parentGeoId, geoOrder, geoType, { ward = false } = {}) {
    if (parentGeoId === undefined || parentGeoId === null || parentGeoId === '') {
      throw err('PARENT_REQUIRED', 'getGeo requires parentGeoId (taken from the previous step).');
    }
    const cached = this.geoCache.get(parentGeoId, geoOrder, geoType, ward);
    if (cached) return { entries: cached, cached: true };

    const qs = new URLSearchParams({
      geoGroup: 'birthPlace',
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
    this.geoCache.set(parentGeoId, geoOrder, geoType, ward, entries);
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
   * Walk a geo chain by nameBn. Each step picks one entry by exact nameBn;
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
  async walkGeoChain({ firstParentId, firstGeoOrder, steps }) {
    if (firstParentId === undefined || firstParentId === null || firstParentId === '') {
      throw err(
        'FIRST_PARENT_REQUIRED',
        'walkGeoChain requires explicit firstParentId: the first-parent source is unproven (observed chains start at 4, page script shows bangladeshId=null) and must not be guessed.',
      );
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw err('STEPS_REQUIRED', 'walkGeoChain requires a non-empty steps array.');
    }
    const out = [];
    let parent = firstParentId;
    let order = firstGeoOrder;
    for (const step of steps) {
      const res = await this.getGeo(parent, order, step.geoType, { ward: !!step.ward });
      const chosen = res.entries.find((e) => e.nameBn === step.nameBn);
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
   * OTP send. Query params are the verified names; appType is fixed.
   * The response carries no token/id (payload is null) — verify must
   * therefore reuse the same applicant/phone context (unverified step).
   */
  async otpSend({ phone = '', email = '', officeId = '', personUbrn = '', relation = '', applicantName = '', applicantBrn = '', applicantDob = '', officeAddressType = '' } = {}) {
    const qs = new URLSearchParams({
      appType: 'BIRTH_REGISTRATION_APPLICATION',
      phone,
      email,
      officeId,
      personUbrn,
      relation,
      applicantName,
      applicantBrn,
      applicantDob,
      officeAddressType,
    });
    const res = await this.request(`${OTP_SENT_PATH}?${qs.toString()}`, { headers: this.apiHeaders() });
    if (!res.ok || !res.json) {
      throw err('OTP_SEND_FAILED', `OTP send returned status ${res.status}.`);
    }
    return res.json; // {code, message, success, payload}
  }

  /**
   * NOT IMPLEMENTED — request params for /api/otp/verify are unobserved.
   * Do not guess them. Playwright v2 remains the fallback for this step.
   */
  async verifyOtp() {
    throw err(
      'NOT_IMPLEMENTED_VERIFY_PARAMS',
      'NOT_IMPLEMENTED: request params for /api/otp/verify are still unobserved. ' +
        'Needed before this stub can be implemented: the verify request method and parameter names ' +
        '(names only, no values). Until then use the Playwright v2 path for OTP verify.',
    );
  }

  /**
   * NOT IMPLEMENTED — method + payload field list for
   * /api/br/application/register are unobserved. Do not guess them.
   * Playwright v2 remains the fallback for this step.
   */
  async submitApplication() {
    throw err(
      'NOT_IMPLEMENTED_SUBMIT_PAYLOAD',
      'NOT_IMPLEMENTED: method + payload field list for /api/br/application/register are still unobserved. ' +
        'Needed before this stub can be implemented: the submit request method and payload field names ' +
        '(names only, no values). Until then use the Playwright v2 path for final submit.',
    );
  }
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
  FORM_PATH,
  GEO_PATH,
  UPLOAD_PATH,
  OTP_SENT_PATH,
  VERIFY_PATH,
  SUBMIT_PATH,
  PRINT_PATH,
  SUCCESS_PHRASE,
  GEO_CACHE_TTL_MS,
  MAX_UPLOAD_BYTES,
};
