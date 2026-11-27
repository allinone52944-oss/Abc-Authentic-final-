const ORIGIN = 'https://api.bd-x.com';
const PATHS = new Map([
  ['backup', '/api-portal/api/s-v-becup.php'],
  ['premium', '/api-portal/api/of-sv-copy.php'],
  ['half', '/api-portal/api/sv-half.php'],
]);
const PREMIUM_FALLBACK_PATH = '/api-portal/api/sv-copy.php';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const NID_PATTERN = /^(?:[0-9]{10}|[0-9]{13}|[0-9]{17})$/;
const NO_RECORD_CODES = new Set(['not_found', 'record_not_found', 'no_record', 'no_data']);
const RESPONSE_STATUS_FIELDS = new Set(['status', 'code', 'message', 'error', 'success', 'data']);

function providerError(code = 'provider_unavailable') {
  return Object.assign(new Error(code), { code });
}

function recordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerDebitStatus(payload) {
  if (!recordObject(payload) || !Object.hasOwn(payload, 'response')) return undefined;
  const { charged, http_status: httpStatus, from_cache: fromCache, amount } = payload;
  if (typeof charged !== 'boolean' || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599) {
    return undefined;
  }
  if (Object.hasOwn(payload, 'from_cache') && (typeof fromCache !== 'boolean' || (charged && fromCache))) {
    return undefined;
  }
  if (Object.hasOwn(payload, 'amount') && (!Number.isFinite(amount) || (charged ? amount <= 0 : amount !== 0))) {
    return undefined;
  }
  return charged;
}

function isEmptyRecordResponse(response) {
  const { data } = response;
  const emptyData = data == null || data === ''
    || ((recordObject(data) || Array.isArray(data)) && Object.keys(data).length === 0);
  return emptyData && Object.keys(response).every(field => RESPONSE_STATUS_FIELDS.has(field));
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

function addressText(value, limit) {
  const text = cleanText(value, limit);
  return /^(?:[-–—./,?\s]+|n\s*\/?\s*a|null|none|unknown|not available|অপ্রযোজ্য|নেই)$/i.test(text) ? '' : text;
}

function addressWords(value) {
  const words = normalizeDigits(value).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return words ? ' ' + words + ' ' : '';
}

function normalizeFullAddress(value) {
  if (!recordObject(value)) return addressText(value, 600);
  const addressLine = addressText(value.addressLine, 600);
  const parts = [
    value.homeOrHoldingNo, value.villageOrRoad, value.mouzaMoholla, value.unionOrWard,
    value.postOffice, value.postCode, addressText(value.upazila) || value.upozila,
    value.district, value.region, value.division,
  ];
  const result = addressLine ? [addressLine] : [];
  const lineWords = addressWords(addressLine);
  const added = new Set();
  for (const part of parts) {
    const text = addressText(part);
    const words = addressWords(text);
    if (!words || lineWords.includes(words) || added.has(words)) continue;
    result.push(text);
    added.add(words);
  }
  return result.join(', ').slice(0, 600);
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
  if (type === 'premium') {
    result.presentAddress = normalizeFullAddress(data.presentAddress);
    result.permanentAddress = normalizeFullAddress(data.permanentAddress);
  } else if (type === 'backup') {
    result.presentAddress = normalizeAddress(data.presentAddress);
    result.permanentAddress = normalizeAddress(data.permanentAddress);
  }
  return result;
}

async function lookupEndpoint(path, { type, nid, dob, apiKey }, fetchImpl, signal) {
  let response;
  let payload;
  try {
    const url = new URL(path, ORIGIN);
    url.search = new URLSearchParams({ key: apiKey.trim(), nid, dob }).toString();
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal,
    });
    if (!response.ok && response.status !== 404 && type !== 'premium') {
      await response.body?.cancel();
      throw providerError();
    }
    payload = await readBoundedJson(response);
  } catch {
    // Fetch and parse exceptions can contain the request URL or provider body.
    throw providerError();
  }

  try {
    if (!response.ok && (response.status !== 404 || payload?.http_status !== 404)) throw providerError();
    return normalizeResult(payload, { type, nid, dob });
  } catch (e) {
    const error = providerError(e.code === 'record_not_found' ? 'record_not_found' : undefined);
    if (type === 'premium') {
      const charged = providerDebitStatus(payload);
      if (charged === true || (charged === false && error.code === 'record_not_found' && isEmptyRecordResponse(payload.response))) {
        error.providerCharged = charged;
      }
    }
    throw error;
  }
}

async function lookupBdxNid(input, fetchImpl = globalThis.fetch) {
  const { type, nid, dob, apiKey } = input;
  const path = PATHS.get(type);
  if (!path || typeof apiKey !== 'string' || !apiKey.trim() || typeof nid !== 'string'
      || !NID_PATTERN.test(nid) || !isIsoDate(dob)) {
    throw providerError();
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await lookupEndpoint(path, input, fetchImpl, signal);
  } catch (e) {
    // A second call can incur a fee, so it needs an explicit free miss from the primary.
    if (type !== 'premium' || e.code !== 'record_not_found' || e.providerCharged !== false || signal.aborted) throw e;
  }
  return lookupEndpoint(PREMIUM_FALLBACK_PATH, input, fetchImpl, signal);
}

module.exports = { lookupBdxNid };
