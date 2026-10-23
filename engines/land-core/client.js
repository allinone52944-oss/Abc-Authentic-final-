// ============================================================
// Land (DLRMS) data client — ভূমি মন্ত্রণালয়ের Digital Land
// Record Management System (dlrms.land.gov.bd) public channel.
//
// PROVEN LIVE 2026-10-23 (production, from a plain server —
// no citizen login, no office login):
//   1. GET https://dlrms.land.gov.bd/ sets two guest cookies:
//      dlrms_app_token + dlrms_app_refresh_token. The access
//      cookie IS the gateway bearer token. (A bare POST to
//      /api/renew-app-token without the refresh cookie = 401.)
//   2. API base: https://gateway.dlrms.land.gov.bd/core-api/api
//      with header Authorization: Bearer <dlrms_app_token>.
//   3. Cascade (all realtime, nothing hardcoded):
//      /public/divisions → /public/districts?DIVISION_BBS_CODE=
//      → /public/upazilas?DISTRICT_BBS_CODE=
//      → /public/upazilas/surveys?DISTRICT_BBS_CODE=&UPAZILA_BBS_CODE=
//      → /public/mouzas/jl-numbers?...&SURVEY_ID=<id>
//      ⚠️ jl-numbers filters by SURVEY_ID (numeric). SURVEY_TYPE
//      is silently IGNORED there and returns the namjari list.
//   4. Khatian index (whole mouza in ONE call):
//      GET /public/index-khatian/{SURVEY_KEY}?JL_NUMBER_ID=<id>
//      → [{ ID, KHATIAN_NO, OWNERS (one string), ... }]
//      KHATIAN_NO filters server-side; OWNER_NAME is ignored
//      (name filtering is done locally — the list is small).
//   5. Detail: GET /public/index-khatian/{KEY}/{ID}
//      → + DAGS (dag numbers string), TOTAL_LAND, area names,
//        KHATIAN_ENTRY_ID (the office-entry key — the full
//        written page behind it needs an office login; the
//        public record ends here by the portal's own design).
//   6. Hal-sabek (correction history, usually empty):
//      GET /public/hal-sabeks/khatian?DIVISION_BBS_CODE=&
//      DISTRICT_BBS_CODE=&UPAZILA_BBS_CODE=&SURVEY_TYPE=<KEY>&
//      JL_NUMBER_ID=&KHATIAN_NO=
//
// Every function returns data or throws a typed Error with
// .code — the route turns failures into "no charge" answers.
// ============================================================

const SITE = 'https://dlrms.land.gov.bd';
const GATEWAY = 'https://gateway.dlrms.land.gov.bd/core-api/api';
const TIMEOUT_MS = 30000;

let _tok = { access: '', refresh: '', at: 0 };

function parseSetCookies(headers) {
  let list = [];
  if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
  else {
    const single = headers.get && headers.get('set-cookie');
    if (single) list = [single];
  }
  const out = {};
  for (const line of list) {
    const m = /^([^=]+)=([^;]*)/.exec(String(line).trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function bootstrap() {
  const res = await fetch(SITE + '/', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const cookies = parseSetCookies(res.headers);
  const access = cookies['dlrms_app_token'] || '';
  const refresh = cookies['dlrms_app_refresh_token'] || '';
  if (!access) {
    const err = new Error('LAND_TOKEN_MISSING');
    err.code = 'LAND_UNREACHABLE';
    throw err;
  }
  _tok = { access, refresh, at: Date.now() };
  return access;
}

async function renew() {
  if (!_tok.refresh) return bootstrap();
  const res = await fetch(SITE + '/api/renew-app-token', {
    method: 'POST',
    headers: { 'R-Token': _tok.refresh },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return bootstrap();
  const body = await res.json().catch(() => null);
  const access = body && (body.access_token || (body.data && body.data.access_token));
  if (!access) return bootstrap();
  _tok.access = access;
  _tok.at = Date.now();
  return access;
}

async function token(force) {
  if (!force && _tok.access && Date.now() - _tok.at < 10 * 60 * 1000) return _tok.access;
  if (!force && _tok.access) {
    // Have a token but it is old — try it; api() renews on 401.
    return _tok.access;
  }
  return bootstrap();
}

async function api(pathname, retried) {
  const tok = await token(retried);
  let res;
  try {
    res = await fetch(GATEWAY + pathname, {
      headers: { Authorization: 'Bearer ' + tok },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error('LAND_UNREACHABLE: ' + e.message);
    err.code = 'LAND_UNREACHABLE';
    throw err;
  }
  if (res.status === 401 && !retried) {
    await renew().catch(() => bootstrap());
    return api(pathname, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success !== true) {
    const err = new Error('LAND_API_ERROR (HTTP ' + res.status + '): ' +
      (body && body.message ? JSON.stringify(body.message).slice(0, 200) : 'no body'));
    err.code = 'LAND_API_ERROR';
    throw err;
  }
  return body.data;
}

// ---------- cascade ----------
const divisions = () => api('/public/divisions');
const districts = (divisionBbs) =>
  api('/public/districts?DIVISION_BBS_CODE=' + encodeURIComponent(divisionBbs));
const upazilas = (districtBbs) =>
  api('/public/upazilas?DISTRICT_BBS_CODE=' + encodeURIComponent(districtBbs));
const surveys = () => api('/public/surveys'); // [{ID, NAME, NAME_EN, KEY}]
const upazilaSurveys = (districtBbs, upazilaBbs) =>
  api('/public/upazilas/surveys?DISTRICT_BBS_CODE=' + encodeURIComponent(districtBbs) +
      '&UPAZILA_BBS_CODE=' + encodeURIComponent(upazilaBbs)); // [{SURVEY_ID, LOCAL_NAME}]
const jlNumbers = (districtBbs, upazilaBbs, surveyId) =>
  api('/public/mouzas/jl-numbers?DISTRICT_BBS_CODE=' + encodeURIComponent(districtBbs) +
      '&UPAZILA_BBS_CODE=' + encodeURIComponent(upazilaBbs) +
      '&SURVEY_ID=' + encodeURIComponent(surveyId));

// ---------- khatian data ----------
const indexList = (surveyKey, jlId) =>
  api('/public/index-khatian/' + encodeURIComponent(surveyKey) +
      '?JL_NUMBER_ID=' + encodeURIComponent(jlId));
const indexByKhatianNo = (surveyKey, jlId, khatianNo) =>
  api('/public/index-khatian/' + encodeURIComponent(surveyKey) +
      '?JL_NUMBER_ID=' + encodeURIComponent(jlId) +
      '&KHATIAN_NO=' + encodeURIComponent(khatianNo));
const detail = (surveyKey, id) =>
  api('/public/index-khatian/' + encodeURIComponent(surveyKey) + '/' + encodeURIComponent(id));
const halSabek = ({ divisionBbs, districtBbs, upazilaBbs, surveyKey, jlId, khatianNo }) =>
  api('/public/hal-sabeks/khatian?DIVISION_BBS_CODE=' + encodeURIComponent(divisionBbs) +
      '&DISTRICT_BBS_CODE=' + encodeURIComponent(districtBbs) +
      '&UPAZILA_BBS_CODE=' + encodeURIComponent(upazilaBbs) +
      '&SURVEY_TYPE=' + encodeURIComponent(surveyKey) +
      '&JL_NUMBER_ID=' + encodeURIComponent(jlId) +
      '&KHATIAN_NO=' + encodeURIComponent(khatianNo));

// ---------- helpers ----------
/** Owner-name match: whitespace-insensitive substring, both ways light-normalised. */
function ownerMatches(owners, name) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const a = norm(owners);
  const q = norm(name);
  if (!a || !q) return false;
  return a.includes(q);
}

/** Sum TOTAL_LAND strings like '0.0544' — returns a number (acres). */
function sumLand(details) {
  let total = 0;
  for (const d of details) {
    const v = parseFloat(d && d.TOTAL_LAND);
    if (Number.isFinite(v)) total += v;
  }
  return Math.round(total * 10000) / 10000;
}

module.exports = {
  divisions, districts, upazilas, surveys, upazilaSurveys, jlNumbers,
  indexList, indexByKhatianNo, detail, halSabek,
  ownerMatches, sumLand,
  _resetToken: () => { _tok = { access: '', refresh: '', at: 0 }; },
};
