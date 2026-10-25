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
 * What this module does NOT have verified (see DESIGN.md):
 *  - OTP verify (/api/otp/verify): URL verified, but the request
 *    method + params are UNOBSERVED. verifyOtp() therefore sends a
 *    CANDIDATE request (POST, the otpSend context + otp) built by
 *    buildVerifyPayload(), and fails loudly on a bad response.
 *  - Final submit (/api/br/application/register): URL verified, but
 *    the request method + payload field list are UNOBSERVED.
 *    submitApplication() therefore sends a CANDIDATE payload built by
 *    buildSubmitPayload() — flat form-field names taken verbatim from
 *    the Playwright v2 StepHandler field map (personInfoForBirth.*,
 *    birthPlace*, permAddr*, prsntAddr*, relationWithApplicant,
 *    applicantName, declaration, email, phone, otp) plus the upload
 *    references (types 40/41) — as JSON over POST, and parses only
 *    the verified success-page shape.
 *  CANDIDATE means derived, not live-captured: never present these
 *  two requests as verified. Until one live capture confirms the
 *  real method + field list, the Playwright v2 path remains the
 *  fallback for verify+submit if the candidate is rejected live.
 *  Hybrid today = HTTP for geo/docs/OTP-send, candidate HTTP (with
 *  Playwright fallback) for verify+submit. Never claim realtime
 *  live speed — no live call has been made from this module.
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
   * CANDIDATE OTP-verify request (DERIVED, NOT live-captured).
   * Derivation: the verified otpSend param names (appType, phone,
   * email, officeId, personUbrn, relation, applicantName, applicantBrn,
   * applicantDob, officeAddressType) plus the OTP code itself, which
   * the Playwright flow types into the single input#otp / name="otp"
   * field. The live verify may carry a subset or different names —
   * that is exactly what one live capture must confirm. Method POST
   * is likewise candidate (a code check with a body is not a GET).
   * Throws OTP_REQUIRED / OTP_BAD_FORMAT instead of guessing.
   */
  async verifyOtp(data = {}) {
    const payload = buildVerifyPayload(data);
    const res = await this.request(VERIFY_PATH, {
      method: 'POST',
      headers: this.apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw err('VERIFY_FAILED', `OTP verify returned status ${res.status}.`);
    }
    return res.json !== null ? res.json : { ok: res.ok, text: res.text };
  }

  /**
   * CANDIDATE final submit (DERIVED, NOT live-captured).
   * Sends buildSubmitPayload(data) as JSON over POST to
   * /api/br/application/register with the verified API headers.
   * The response is accepted ONLY in the verified success shape:
   * HTML containing the Bengali success phrase (plus print link if
   * present), or JSON with success === true. Anything else throws
   * SUBMIT_NOT_SUCCESS / SUBMIT_BAD_RESPONSE — never a silent pass.
   * No application number is extracted (format unverified).
   */
  async submitApplication(data = {}) {
    const payload = buildSubmitPayload(data);
    const res = await this.request(SUBMIT_PATH, {
      method: 'POST',
      headers: this.apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw err('SUBMIT_BAD_RESPONSE', `Submit returned status ${res.status}.`);
    }
    if (res.json && res.json.success === true) {
      return { success: true, hasPrintLink: false, json: res.json };
    }
    const parsed = parseSuccessPage(res.text);
    if (!parsed.success) {
      throw err('SUBMIT_NOT_SUCCESS', 'Submit response contains neither success:true JSON nor the verified success phrase.');
    }
    return { success: true, hasPrintLink: parsed.hasPrintLink, json: res.json };
  }
}

/**
 * CANDIDATE submit payload builder (pure, no I/O).
 *
 * Derivation, field by field, from the Playwright v2 StepHandler
 * field map — the site's own form field names, copied verbatim:
 *  - Person (submitS1): personInfoForBirth.personFirstNameBn /
 *    personLastNameBn / personFirstNameEn / personLastNameEn, plus
 *    the joined personNameBn / personNameEn (site join rule: first +
 *    ' ' + last; a first-name-only applicant joins to the first name
 *    alone — the standing 1-name rule), personDob, personGender.
 *  - Parents (submitS2, base personInfoForBirth.father./mother.):
 *    ubrn, personBirthDate, personNameBn, personNameEn,
 *    personNationality. Pre-2013 applicants leave ubrn empty, per
 *    the live-verified 2013 rule — the builder keeps an empty string
 *    rather than inventing a value.
 *  - Addresses (submitS2B, prefixes birthPlace / permAddr / prsntAddr):
 *    Country, Div, Dist, CityCorpCantOrUpazila, PaurasavaOrUnion,
 *    WardInCityCorp, WardInPaurasavaOrUnion, PostOfc, PostOfcEn,
 *    PostCode, VilAreaTownBn, VilAreaTownEn, HouseRoadBn, HouseRoadEn.
 *    PostCode is carried only if supplied (the visible form usually
 *    hides it). Copy flags copyBirthPlaceToPermAddr /
 *    copyPermAddrToPrsntAddr are carried when the caller sets them.
 *  - Documents (submitS3): relationWithApplicant (FATHER/MOTHER/
 *    SELF/...), applicantName, declaration, plus `documents`: the
 *    upload references from uploadDocument() — one entry per
 *    mandatory type 40 and 41 ({attachmentType, attachmentTypeId,
 *    url, id}). The upload itself is verified; how the register call
 *    references the uploads is CANDIDATE.
 *  - Contact (submitS4Prep): email, phone, officeAddressType,
 *    officeAddrCountry, officeId (from the office lookup step).
 *  - OTP (submitS4): otp — the single code field.
 *  - Basis (submitS0): addressType (BIRTH | PERMANENT), default BIRTH.
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
      [`${prefix}WardInCityCorp`]: str(addr.wardInCityCorp || addr.paurasavaUnion),
      [`${prefix}WardInPaurasavaOrUnion`]: str(addr.ward),
      [`${prefix}PostOfc`]: str(addr.postOfficeBn || addr.postBn),
      [`${prefix}PostOfcEn`]: str(addr.postOfficeEn || addr.postEn),
      [`${prefix}PostCode`]: str(addr.postCode),
      [`${prefix}VilAreaTownBn`]: str(addr.villageBn || addr.vilBn),
      [`${prefix}VilAreaTownEn`]: str(addr.villageEn || addr.vilEn),
      [`${prefix}HouseRoadBn`]: str(addr.houseRoadBn || addr.houseBn),
      [`${prefix}HouseRoadEn`]: str(addr.houseRoadEn || addr.houseEn),
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

  const otp = req(data.otp, 'otp');
  if (otp && !/^\d{6}$/.test(String(otp).replace(/\D/g, ''))) missing.push('otp (must be 6 digits)');

  if (missing.length) {
    throw err('MISSING_SUBMIT_FIELD', `Cannot build submit payload, missing required fields: ${missing.join(', ')}`);
  }

  return {
    addressType: data.addressType || 'BIRTH',
    'personInfoForBirth.personFirstNameBn': str(firstBn),
    'personInfoForBirth.personLastNameBn': str(lastBn),
    'personInfoForBirth.personFirstNameEn': str(firstEn),
    'personInfoForBirth.personLastNameEn': str(lastEn),
    'personInfoForBirth.personNameBn': joinName(firstBn, lastBn),
    'personInfoForBirth.personNameEn': joinName(firstEn, lastEn),
    'personInfoForBirth.personDob': str(dob),
    'personInfoForBirth.personGender': str(person.gender),
    'personInfoForBirth.father.ubrn': str(father.brn),
    'personInfoForBirth.father.personBirthDate': str(father.dob),
    'personInfoForBirth.father.personNameBn': str(father.nameBn),
    'personInfoForBirth.father.personNameEn': str(father.nameEn),
    'personInfoForBirth.father.personNationality': str(father.nationality || 'বাংলাদেশী'),
    'personInfoForBirth.mother.ubrn': str(mother.brn),
    'personInfoForBirth.mother.personBirthDate': str(mother.dob),
    'personInfoForBirth.mother.personNameBn': str(mother.nameBn),
    'personInfoForBirth.mother.personNameEn': str(mother.nameEn),
    'personInfoForBirth.mother.personNationality': str(mother.nationality || 'বাংলাদেশী'),
    ...birthFields,
    ...permFields,
    ...presFields,
    copyBirthPlaceToPermAddr: !!(data.permCopy || s2b.permCopy),
    copyPermAddrToPrsntAddr: !!(data.presCopy || s2b.presCopy),
    relationWithApplicant: str(relation),
    applicantName: str(applicantName),
    declaration: data.declaration !== undefined ? !!data.declaration : true,
    email: str(data.email || (data.s4prep && data.s4prep.email)),
    phone: str(phone),
    officeAddressType: str(data.officeAddressType || (data.s4prep && data.s4prep.officeAddressType)),
    officeAddrCountry: str(data.officeAddrCountry || 'বাংলাদেশ'),
    officeId: str(data.officeId),
    documents: [docsByType.get(40), docsByType.get(41)],
    otp: String(otp).replace(/\D/g, ''),
  };
}

/**
 * CANDIDATE OTP-verify payload builder (pure, no I/O).
 * Reuses the VERIFIED otpSend param names and adds `otp`.
 * Method + exact param set are CANDIDATE until live-confirmed.
 */
function buildVerifyPayload(data = {}) {
  const otp = String(data.otp || '').replace(/\D/g, '');
  if (!otp) throw err('OTP_REQUIRED', 'verifyOtp requires data.otp.');
  if (!/^\d{6}$/.test(otp)) throw err('OTP_BAD_FORMAT', 'OTP must be 6 digits.');
  return {
    appType: 'BIRTH_REGISTRATION_APPLICATION',
    phone: String(data.phone || ''),
    email: String(data.email || ''),
    officeId: String(data.officeId || ''),
    personUbrn: String(data.personUbrn || ''),
    relation: String(data.relation || ''),
    applicantName: String(data.applicantName || ''),
    applicantBrn: String(data.applicantBrn || ''),
    applicantDob: String(data.applicantDob || ''),
    officeAddressType: String(data.officeAddressType || ''),
    otp,
  };
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
  buildVerifyPayload,
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
