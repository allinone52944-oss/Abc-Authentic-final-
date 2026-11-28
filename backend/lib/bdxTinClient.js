'use strict';

const ENDPOINT = 'https://api.bd-x.com/api-portal/api/tin-download.php';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIN_PATTERN = /^\d{12}$/;
const fields = [
  'fatherName', 'motherName', 'presentAddress', 'permanentAddress',
  'previousTIN', 'taxZone', 'taxCircle', 'status', 'date',
];

function normalizeTin(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
  return TIN_PATTERN.test(normalized) ? normalized : '';
}

function clean(value, limit = 180) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
    : '';
}

async function readJson(response) {
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function lookupBdxTin({ tin, apiKey }, fetchImpl = globalThis.fetch) {
  const unavailable = { error: 'PROVIDER_UNAVAILABLE', charged: false };
  if (normalizeTin(tin) !== tin || !tin || !apiKey) return unavailable;

  let reply, payload;
  try {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ key: apiKey, tin });
    reply = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    payload = await readJson(reply);
  } catch {
    // The URL and the response can contain private data.
    return unavailable;
  }

  if (!Number.isInteger(payload?.http_status) || payload.http_status < 200 || payload.http_status > 599 ||
      !Object.hasOwn(payload, 'response')) return unavailable;
  const charged = payload.charged === true && payload.from_cache !== true &&
    Number.isFinite(payload.amount) && payload.amount > 0;
  if (payload.http_status === 404 && (reply.ok || reply.status === 404)) {
    return { error: 'RECORD_NOT_FOUND', charged };
  }
  if (!reply.ok || payload.http_status !== 200) return { ...unavailable, charged };

  const data = payload.response?.data ?? payload.response;
  const returnedTin = normalizeTin(data?.TIN ?? data?.tin);
  const name = clean(data?.nameEn) || clean(data?.name);
  if (returnedTin !== tin || !name) return { ...unavailable, charged };
  const record = { tin, name };
  for (const field of fields) record[field] = clean(data[field], field.endsWith('Address') ? 600 : 180);
  return { record, charged };
}

module.exports = { lookupBdxTin, normalizeTin };
