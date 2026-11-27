const ORIGIN = 'https://api.bd-x.com';
const PATHS = new Map([
  ['backup', '/api-portal/api/s-v-becup.php'],
  ['premium', '/api-portal/api/sv-copy.php'],
  ['half', '/api-portal/api/sv-half.php'],
]);
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const NID_PATTERN = /^(?:[0-9]{10}|[0-9]{13}|[0-9]{17})$/;
const NO_RECORD_CODES = new Set(['not_found', 'record_not_found', 'no_record', 'no_data']);

function providerError(code = 'provider_unavailable') {
  return Object.assign(new Error(code), { code });
}

function recordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, limit = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
    : '';
}

function normalizeDigits(value) {
  return value.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
}

function normalizeId(value) {
  const id = normalizeDigits(Number.isSafeInteger(value) ? String(value) : cleanText(value));
  return NID_PATTERN.test(id) ? id : '';
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(`${value}T`);
}

function normalizeDob(value) {
  const date = normalizeDigits(cleanText(value));
  const dayFirst = /^(\d{2})([/-])(\d{2})\2(\d{4})$/.exec(date);
  const isoDate = dayFirst ? `${dayFirst[4]}-${dayFirst[3]}-${dayFirst[1]}` : date;
  return isIsoDate(isoDate) ? isoDate : '';
}

function normalizeAddress(value) {
  if (!recordObject(value)) return cleanText(value, 600);
  const addressLine = cleanText(value.addressLine, 600);
  if (addressLine) return addressLine;
  return [
    value.homeOrHoldingNo, value.villageOrRoad, value.unionOrWard,
    value.upozila, value.district, value.division,
  ].map(part => cleanText(part)).filter(Boolean).join(', ').slice(0, 600);
}

async function readBoundedJson(response) {
  if (!response.body) throw providerError();
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw providerError();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw providerError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
}

function normalizeResult(payload, { type, nid, dob }) {
  if (!recordObject(payload) || !recordObject(payload.response)) throw providerError();
  const response = payload.response;
  const status = cleanText(response.status).toLowerCase();
  const code = cleanText(response.code).toLowerCase();
  if ((payload.http_status === 200 || payload.http_status === 404)
      && (NO_RECORD_CODES.has(status) || NO_RECORD_CODES.has(code))) {
    throw providerError('record_not_found');
  }
  if (payload.http_status !== 200 || (status && status !== 'success')) throw providerError();

  // The docs show both a nested response.data record and a flat response record.
  const data = response.data === undefined ? response : response.data;
  if (!recordObject(data) || (data !== response && status !== 'success')) throw providerError();
  const nationalId = normalizeId(data.nationalId);
  const pin = normalizeId(data.pin);
  const dateOfBirth = normalizeDob(data.dateOfBirth);
  const nameBn = cleanText(data.nameBn) || cleanText(data.name);
  const nameEn = cleanText(data.nameEn);
  if ((nationalId !== nid && pin !== nid) || dateOfBirth !== dob || (!nameBn && !nameEn)) {
    throw providerError();
  }

  const result = {
    nameBn,
    nameEn,
    fatherName: cleanText(data.fatherName) || cleanText(data.father),
    motherName: cleanText(data.motherName) || cleanText(data.mother),
    nationalId,
    pin,
    dateOfBirth,
    gender: cleanText(data.gender, 40),
  };
  if (type !== 'half') {
    result.presentAddress = normalizeAddress(data.presentAddress);
    result.permanentAddress = normalizeAddress(data.permanentAddress);
  }
  return result;
}

async function lookupBdxNid({ type, nid, dob, apiKey }, fetchImpl = globalThis.fetch) {
  const path = PATHS.get(type);
  if (!path || typeof apiKey !== 'string' || !apiKey.trim() || typeof nid !== 'string'
      || !NID_PATTERN.test(nid) || !isIsoDate(dob)) {
    throw providerError();
  }

  let payload;
  try {
    const url = new URL(path, ORIGIN);
    url.search = new URLSearchParams({ key: apiKey.trim(), nid, dob }).toString();
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw providerError();
    }
    payload = await readBoundedJson(response);
    if (!response.ok && payload?.http_status !== response.status) throw providerError();
  } catch {
    // Fetch and parse exceptions can contain the request URL or provider body.
    throw providerError();
  }

  return normalizeResult(payload, { type, nid, dob });
}

module.exports = { lookupBdxNid };
