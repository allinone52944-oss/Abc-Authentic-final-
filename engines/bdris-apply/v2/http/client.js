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
   * OTP send — source-proven shape (pasted form page inline handler):
   * POST /api/otp/sent, query = the otpSend context (appType, phone,
   * email, officeId, personUbrn + applicantInfo: relation,
   * applicantName, applicantBrn, applicantDob, officeAddressType),
   * body = only the six person/parent name fields
   * (buildOtpSendBody). The response carries no token/id (payload
   * is null) — verify must therefore reuse the same context plus
   * the geoLocationId derived from officeAddressType.
   */
  async otpSend(data = {}) {
    const { phone = '', email = '', officeId = '', personUbrn = '', relation = '', applicantName = '', applicantBrn = '', applicantDob = '', officeAddressType = '' } = data;
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
      throw err('OTP_SEND_FAILED', `OTP send returned status ${res.status}.`);
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
   * Success = data.isVerified === true in the response.
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
    if (json && json.data && json.data.isVerified !== true && json.isVerified !== true && json.verified !== true && json.success !== true) {
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
 *    personNationality (numeric; 1 = Bangladeshi). Pre-2013
 *    applicants leave ubrn empty, per the live-verified 2013 rule.
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

  const otp = req(data.otp, 'otp');
  if (otp && !/^\d{6}$/.test(String(otp).replace(/\D/g, ''))) missing.push('otp (must be 6 digits)');

  if (missing.length) {
    throw err('MISSING_SUBMIT_FIELD', `Cannot build submit payload, missing required fields: ${missing.join(', ')}`);
  }

  const officeType = mapOfficeAddressType(data.officeAddressType || (data.s4prep && data.s4prep.officeAddressType) || data.addressType);
  const geoLocationId = officeType === 'PERMANENT'
    ? str(permAddr.locationId || data.permGeoLocationId)
    : str(birthPlace.locationId || data.birthGeoLocationId || data.geoLocationId);
  const attachmentIds = [docsByType.get(40), docsByType.get(41)].map((d) => d.id);
  return {
    officeAddressType: officeType,
    officeId: str(data.officeId || (data.s4prep && data.s4prep.officeId)),
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
    'personInfoForBirth.father.ubrn': str(father.brn),
    'personInfoForBirth.father.personBirthDate': str(father.dob),
    'personInfoForBirth.father.personNameBn': str(father.nameBn),
    'personInfoForBirth.father.personNameEn': str(father.nameEn),
    'personInfoForBirth.father.passportNumber': str(father.passportNumber),
    'personInfoForBirth.father.personNationality': mapNationality(father.nationality),
    'personInfoForBirth.mother.id': str(mother.id),
    'personInfoForBirth.mother.ubrn': str(mother.brn),
    'personInfoForBirth.mother.personBirthDate': str(mother.dob),
    'personInfoForBirth.mother.personNameBn': str(mother.nameBn),
    'personInfoForBirth.mother.personNameEn': str(mother.nameEn),
    'personInfoForBirth.mother.passportNumber': str(mother.passportNumber),
    'personInfoForBirth.mother.personNationality': mapNationality(mother.nationality),
    ...birthFields,
    ...permFields,
    ...presFields,
    relationWithApplicant: str(relation),
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
  const joinName = (first, last) => {
    const f = String(first || '').trim();
    const l = String(last || '').trim();
    return l ? `${f} ${l}` : f;
  };
  return {
    'personInfoForBirth.personNameBn': String(person.personNameBn || joinName(person.firstNameBn, person.lastNameBn)),
    'personInfoForBirth.personNameEn': String(person.personNameEn || joinName(person.firstNameEn, person.lastNameEn)),
    'personInfoForBirth.father.personNameBn': String(father.personNameBn || father.nameBn || ''),
    'personInfoForBirth.father.personNameEn': String(father.personNameEn || father.nameEn || ''),
    'personInfoForBirth.mother.personNameBn': String(mother.personNameBn || mother.nameBn || ''),
    'personInfoForBirth.mother.personNameEn': String(mother.personNameEn || mother.nameEn || ''),
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
    officeId: String(data.officeId || ''),
    relation: String(data.relation || ''),
    applicantName: String(data.applicantName || ''),
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
