// ============================================================
// QR Photo Verification engine adapter — NID Secure Gateway
// (my-api.top). One call does everything server-side at the
// gateway: QR decode + record lookup + face match.
//
//   POST https://my-api.top/api/v1/nid-secure-gateway
//   Header: X-API-Key: <key from Admin → Settings (qr_verify)>
//   Form (multipart): photo_file + qr_file
//
// LIVE-VERIFIED response shapes (2026-10-21, production):
//   success: { success: true, message: "Verification completed
//              successfully", charged: 30, remaining_balance: N }
//            — NO identity/score is returned; the gateway is a
//              pure match / no-match oracle.
//   failure: { success: false, charged: 0, remaining_balance: N,
//              message: "Record not found" | "Verification
//              request failed" | "Insufficient balance." }
//   The gateway charges ONLY on success (৳30); failures cost 0.
//   Each NID QR is effectively one-time (the NID server issues
//   a fresh QR every time) — a consumed QR fails uncharged.
//
// verify() never throws: transport/config problems come back
// as { ok: false, error } so the route can answer cleanly and
// never charge the customer for a gateway-side failure.
// ============================================================

const DEFAULT_GATEWAY_URL = 'https://my-api.top/api/v1/nid-secure-gateway';
const GATEWAY_TIMEOUT_MS = 120000;

/** Gateway যাচাই সফল বলেছে কিনা (duplicate-"success"-key আকারসহ) */
function isVerified(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.success === true) return true;
  if (Array.isArray(body.success)) return true; // docs-এর duplicate-key আকার
  return false;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {object} args
 * @param {string} args.apiKey  gateway API key (settings/env)
 * @param {{buffer: Buffer, name: string, mime: string}} args.photo
 * @param {{buffer: Buffer, name: string, mime: string}} args.qr
 * @param {string} [args.url]   override (tests)
 * @returns {Promise<{ok:true, verified:boolean, message:string,
 *   charged:(number|null), remainingBalance:(number|null), body:object}
 *   | {ok:false, error:string}>}
 */
async function verify({ apiKey, photo, qr, url }) {
  const endpoint = url || process.env.QR_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  if (!apiKey) return { ok: false, error: 'GATEWAY_NOT_CONFIGURED' };
  if (!photo || !photo.buffer || !qr || !qr.buffer) {
    return { ok: false, error: 'MISSING_FILES' };
  }

  const form = new FormData();
  form.append('photo_file',
    new Blob([photo.buffer], { type: photo.mime || 'image/jpeg' }),
    photo.name || 'photo.jpg');
  form.append('qr_file',
    new Blob([qr.buffer], { type: qr.mime || 'image/png' }),
    qr.name || 'qr.png');

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: 'GATEWAY_UNREACHABLE: ' + err.message };
  }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }

  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'GATEWAY_BAD_RESPONSE (HTTP ' + res.status + ')' };
  }
  if (!res.ok) {
    const msg = body.message || body.error || ('HTTP ' + res.status);
    return { ok: false, error: String(msg).slice(0, 300) };
  }
  return {
    ok: true,
    verified: isVerified(body),
    message: String(body.message || (isVerified(body) ? 'Verification completed successfully' : 'Verification failed')).slice(0, 300),
    charged: numOrNull(body.charged),
    remainingBalance: numOrNull(body.remaining_balance),
    body,
  };
}

module.exports = { verify, isVerified, DEFAULT_GATEWAY_URL };
