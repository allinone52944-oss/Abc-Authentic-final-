'use strict';
/**
 * Render token (audit #5, 2026-11-05) — defense-in-depth for the paid
 * birth/death certificate engines.
 *
 * Problem: the engines render a certificate from ANY request body
 * (birth: POST /api/preview, /generate-pdf; death: POST /api/preview,
 * /api/pdf) with no check of their own. The backend charge gate is
 * the only control, and the engines also listen on localhost
 * (birth :3000, death :3104), so anything that can reach the port
 * renders certificates free, bypassing the gate entirely.
 *
 * Fix: the gate mints a short-lived HMAC token for every render
 * request it allows (after the charged-order / price-0 check) and
 * passes it as the `x-engine-render-token` header; the engine
 * verifies it before rendering. The token binds the render to one
 * user + one attempt + one engine + a 15-minute window, so a stolen
 * token can only re-render the same paid attempt, never a fresh
 * certificate from arbitrary fields.
 *
 * Secret: ABC_JWT_SECRET || JWT_SECRET — the same secret the
 * backend charge tokens already use (backend/auth.js refuses to
 * start without JWT_SECRET, and the engines are spawned with the
 * backend's full env). No secret -> mint returns null, verify
 * returns false: the gate fails closed, never open.
 *
 * Format: v1.<engineKind>.<b64u(userId)>.<b64u(attemptKey)>.<expMs>.<hmacHex>
 * hmac = HMAC-SHA256(secret, "v1.<kind>.<b64u(uid)>.<b64u(key)>.<expMs>")
 * (userId/attemptKey are base64url-encoded because an attempt key
 * may contain '.', which would break the dot-split parse).
 *
 * Zero dependencies (Node built-ins only) so both engines — the
 * Express birth engine and the zero-dep raw-http death engine —
 * can require this from engines/shared/ without new installs.
 */
const crypto = require('crypto');

const RENDER_TOKEN_TTL_MS = 15 * 60 * 1000;
const RENDER_TOKEN_HEADER = 'x-engine-render-token';

function renderTokenSecret() {
  return process.env.ABC_JWT_SECRET || process.env.JWT_SECRET || '';
}

function b64u(s) {
  return Buffer.from(String(s === undefined || s === null ? '' : s), 'utf8').toString('base64url');
}

function mintRenderToken(engineKind, userId, attemptKey, opts = {}) {
  const secret = opts.secret || renderTokenSecret();
  if (!secret) return null;
  const exp = (opts.nowMs || Date.now()) + (opts.ttlMs !== undefined ? opts.ttlMs : RENDER_TOKEN_TTL_MS);
  const head = ['v1', String(engineKind), b64u(userId), b64u(attemptKey || 'no-key'), String(exp)].join('.');
  const mac = crypto.createHmac('sha256', secret).update(head).digest('hex');
  return head + '.' + mac;
}

function verifyRenderToken(token, engineKind, opts = {}) {
  const secret = opts.secret || renderTokenSecret();
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') return false;
  const kind = parts[1];
  const userId = parts[2];
  const attemptKey = parts[3];
  const expStr = parts[4];
  const mac = parts[5];
  if (kind !== String(engineKind)) return false;
  if (!userId || !attemptKey) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= (opts.nowMs || Date.now())) return false;
  const head = parts.slice(0, 5).join('.');
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(head).digest('hex');
  } catch (_) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_) {
    return false;
  }
}

module.exports = { mintRenderToken, verifyRenderToken, renderTokenSecret, RENDER_TOKEN_TTL_MS, RENDER_TOKEN_HEADER };
