'use strict';

// Server-side charge gate for the birth-certificate and death-verify
// engines (2026-10-30 payment-bypass audit, item 3).
//
// Problem: /api/bdris-engine (engines/birth-final) and /api/death-engine
// (engines/death-final) were mounted with requireAuth + rate limit ONLY.
// Their engines have no charge logic and their frontend pages called
// verify/preview/PDF with no charge call, so any logged-in user could
// verify + generate certificates completely free. Pankaj confirmed ALL
// services are paid.
//
// This middleware sits between requireAuth/rate-limit and the engine
// proxy app in backend/server.js. It is the gate — a frontend shim
// alone would never be one. The engines' own verification logic is
// untouched; only the mount path is gated.
//
// Rules (mirroring backend/routes/land.js and qr-verify.js):
// - Price comes ONLY from the `services` table (engine_id +
//   status='active'), with the same per-user user_services override
//   (access_enabled=false -> 403, custom_price). NEVER hardcoded.
//   No active row or price 0 -> the service stays free for now, but
//   the gate stays in place, so charging starts automatically once
//   Pankaj sets rates in Admin -> Services.
// - Captcha endpoints stay free: they return no record.
// - POST /api/verify: the engine response is intercepted. ONLY a
//   successful verification (record found) is charged, and the record
//   is forwarded to the client ONLY after the charge succeeds. A
//   failed verify, or a charge that fails with INSUFFICIENT_BALANCE,
//   never leaks the record (402 instead). Retrying the same attempt
//   (same idempotency_key, same user, same engine) never charges
//   twice: payForService dedupes on the transaction ref, and the
//   completed order row is re-checked for preview/PDF.
// - POST /api/preview, /generate-pdf (birth), /api/pdf (death):
//   allowed WITHOUT a second charge only when the attempt's
//   idempotency_key matches a completed charged order for this user
//   and engine. Without that proof the request is rejected with 402
//   CHARGE_REQUIRED before it ever reaches the engine, so the
//   engine cannot be used to render a certificate from
//   self-supplied fields without paying for a verification first.
//   When the price is 0 these paths pass through freely.
// - Any other engine path is NOT part of the shop flow (e.g. the
//   builder record store /api/records, /api/engine, /api/store/health,
//   dev debug pages) and is rejected with 404 at this mount, so the
//   store cannot be listed through the shop backend to read a
//   record without paying. The engines themselves are unchanged;
//   builder tooling can still reach them directly if needed.
// - A fresh verification (new captcha, new idempotency_key) is a new
//   service and may charge again; only the same attempt is deduped.
// - The frontend pages send one stable idempotency_key for the whole
//   attempt (captcha -> verify -> preview -> PDF). If a client sends
//   none, the gate generates one, charges under it, and returns it
//   in the verify response so the client can reuse it for
//   preview/PDF.

const crypto = require('crypto');

const dbModule = require('../db');
const serviceCreditsModule = require('./serviceCredits');

// Paths (relative to the engine mount) and their gate policy.
// `verify` is the only path that charges; `render` paths require a
// previously charged attempt; `free` paths pass through untouched.
function policyFor(engineKind, relPath, method) {
  if (method === 'GET' && relPath === '/api/captcha') return 'free';
  if (method === 'POST' && relPath === '/api/solve-captcha') return 'free';
  if (method === 'POST' && relPath === '/api/verify') return 'verify';
  if (engineKind === 'birth') {
    if (method === 'POST' && (relPath === '/api/preview' || relPath === '/generate-pdf')) return 'render';
  } else if (engineKind === 'death') {
    if (method === 'POST' && (relPath === '/api/preview' || relPath === '/api/pdf')) return 'render';
  }
  return 'blocked';
}

// Engine success shape (both engines): HTTP 200 + { success: true,
// data } where data carries a BRN/DRN or a name. Anything else —
// failure JSON, 4xx/5xx, unparseable body — is NOT a success and
// is never charged.
function isVerifySuccess(status, body) {
  if (status !== 200 || !body || typeof body !== 'object') return false;
  if (body.success !== true || !body.data || typeof body.data !== 'object') return false;
  return Boolean(body.data.brn || body.data.nameEn);
}

function attemptKeyOf(body) {
  if (!body || typeof body !== 'object') return null;
  const k = String(body.idempotency_key || '').trim().slice(0, 80);
  return k || null;
}

function orderKeyOf(engineId, attemptKey) {
  return engineId + ':' + attemptKey;
}

function txRefOf(engineId, attemptKey) {
  return engineId + '-' + attemptKey;
}

// Same pricing rule as land.js getServicePrice / qr-verify.js.
async function getEngineServicePrice(db, engineId, userId) {
  const r = await db.query(
    'SELECT id, price FROM services WHERE engine_id = $1 AND status = \'active\' LIMIT 1',
    [engineId]
  );
  if (!r.rows.length) return { allowed: true, price: 0, serviceId: null };
  const serviceId = r.rows[0].id;
  const basePrice = Number(r.rows[0].price) || 0;
  const ov = await db.query(
    'SELECT custom_price, access_enabled FROM user_services WHERE user_id = $1 AND service_id = $2 LIMIT 1',
    [userId, serviceId]
  );
  if (ov.rows.length) {
    if (ov.rows[0].access_enabled === false) return { allowed: false, price: 0, serviceId };
    const cp = ov.rows[0].custom_price;
    return { allowed: true, price: cp !== null && cp !== undefined ? Number(cp) : basePrice, serviceId };
  }
  return { allowed: true, price: basePrice, serviceId };
}

async function balanceAndCredit(db, serviceCredits, userId, serviceId) {
  const u = await db.query('SELECT balance FROM users WHERE id = $1', [userId]);
  const balance = u.rows[0] ? Number(u.rows[0].balance) : 0;
  const lockedCredit = serviceId ? await serviceCredits.availableFor(db, userId, serviceId) : 0;
  return { balance, lockedCredit };
}

async function alreadyPaid(db, userId, ref) {
  const r = await db.query(
    'SELECT 1 FROM transactions WHERE user_id = $1 AND trxid IN ($2, $3) AND status = \'approved\' LIMIT 1',
    [userId, ref, ref + ':svc']
  );
  return r.rows.length > 0;
}

async function recordOrder(db, userId, serviceId, price, orderKey) {
  await db.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key)
     VALUES ($1, $2, 'completed', $3, $4, $5)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [userId, serviceId, JSON.stringify({ verified: true }), price, orderKey]
  );
}

async function hasChargedOrder(db, userId, orderKey) {
  const r = await db.query(
    'SELECT 1 FROM orders WHERE user_id = $1 AND idempotency_key = $2 AND status = \'completed\' LIMIT 1',
    [userId, orderKey]
  );
  return r.rows.length > 0;
}

// Charge once for one attempt. Returns 'charged', 'already-paid', or
// throws INSUFFICIENT_BALANCE / other errors. The duplicate check
// inside payForService (row lock + ref dedupe) also covers a
// concurrent double-submit racing this check.
async function chargeOnce(db, serviceCredits, userId, serviceId, price, ref) {
  if (await alreadyPaid(db, userId, ref)) return 'already-paid';
  try {
    await db.withTransaction((client) =>
      serviceCredits.payForService(client, {
        userId, serviceId, amount: Math.abs(price), ref,
      }));
  } catch (e) {
    if (/DUPLICATE_TRANSACTION/.test(e.message)) return 'already-paid';
    throw e;
  }
  return 'charged';
}

// Intercept a downstream response so the gate can decide AFTER seeing
// whether the engine succeeded, but BEFORE the client sees a record.
// Only used for /api/verify. The downstream here is the engine proxy,
// which calls res.writeHead + pipe (write/end); Express-style
// downstream (setHeader + end) is handled the same way.
//
// `send` offers exactly two exits, both of which restore the
// original response methods first:
//   send.forward(status, body) — the buffered engine response, as-is
//     (or a replacement body of the same status, e.g. the verify
//     JSON with a server-generated idempotency_key appended).
//   send.replace(status, obj) — discard the engine response entirely
//     and send a fresh JSON body (used for 402/500: the record must
//     never reach the client when the charge did not succeed).
function interceptVerifyResponse(res, onFinished) {
  const origWriteHead = res.writeHead;
  const origWrite = res.write;
  const origEnd = res.end;
  let headStatus = null;
  let headHeaders = null;
  let originalBody = null;
  const chunks = [];
  let done = false;

  function restore() {
    res.writeHead = origWriteHead;
    res.write = origWrite;
    res.end = origEnd;
  }

  const send = {
    forward(status, outBody) {
      restore();
      const merged = Object.assign({}, headHeaders || {}, res.getHeaders ? res.getHeaders() : {});
      if (outBody !== originalBody) delete merged['content-length'];
      try { origWriteHead.call(res, status, merged); } catch (_) { /* already sent */ }
      try { origEnd.call(res, outBody); } catch (_) { /* already sent */ }
    },
    replace(status, obj) {
      restore();
      const payload = Buffer.from(JSON.stringify(obj));
      try {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', payload.length);
        origWriteHead.call(res, status, res.getHeaders());
      } catch (_) { /* already sent */ }
      try { origEnd.call(res, payload); } catch (_) { /* already sent */ }
    },
  };

  res.writeHead = function (statusCode, statusMessage, headers) {
    headStatus = statusCode;
    if (typeof statusMessage === 'object' && statusMessage !== null) headers = statusMessage;
    headHeaders = headers || null;
    // Headers are NOT flushed yet — the gate may still replace the
    // whole response (e.g. 402 instead of a record).
    return res;
  };
  res.write = function (chunk) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  res.end = function (chunk) {
    if (done) return res;
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    done = true;
    const body = Buffer.concat(chunks);
    originalBody = body;
    const status = headStatus !== null ? headStatus : res.statusCode;
    // Run the decision asynchronously; the response stays open until
    // send.forward/send.replace is called, so the record is never
    // sent early.
    Promise.resolve()
      .then(() => onFinished(status, body, send))
      .catch(() => {
        try { send.replace(500, { success: false, error: 'GATE_FAILED', message: 'চার্জ যাচাইয়ে সমস্যা হয়েছে — আবার চেষ্টা করুন।' }); } catch (_) {}
      });
    return res;
  };
}

function gateError(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}

// engineId: 'bdris-certificate' | 'death-verify' (services table).
// engineKind: 'birth' | 'death' (path shapes differ per engine).
// mount: '/api/bdris-engine' | '/api/death-engine'.
// deps: { db, serviceCredits } — injectable for tests.
function chargeGate(engineId, engineKind, mount, deps) {
  const db = (deps && deps.db) || dbModule;
  const serviceCredits = (deps && deps.serviceCredits) || serviceCreditsModule;

  return async function engineChargeGate(req, res, next) {
    try {
      const user = req.user;
      if (!user || !user.id) return gateError(res, 401, 'NO_TOKEN', 'লগইন প্রয়োজন।');
      const userId = user.id;
      const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
      const rel = rawPath.startsWith(mount) ? rawPath.slice(mount.length) || '/' : rawPath;
      const policy = policyFor(engineKind, rel, req.method);

      if (policy === 'free') return next();
      if (policy === 'blocked') {
        return gateError(res, 404, 'NOT_FOUND', 'এই পথটি দোকানের সেবার অংশ নয়।');
      }

      const { allowed, price, serviceId } = await getEngineServicePrice(db, engineId, userId);
      if (!allowed) {
        return gateError(res, 403, 'SERVICE_ACCESS_DISABLED', 'এই সেবায় আপনার প্রবেশাধিকার স্থগিত রয়েছে।');
      }

      if (policy === 'render') {
        // Already free while no rate is set; otherwise a charged
        // attempt (same user, same engine, same attempt key) is the
        // only proof that lets preview/PDF through without a second
        // charge. The check happens BEFORE the engine runs, so the
        // engine cannot render from self-supplied fields unpaid.
        if (price <= 0 || !serviceId) return next();
        const key = attemptKeyOf(req.body);
        if (key && (await hasChargedOrder(db, userId, orderKeyOf(engineId, key)))) return next();
        return gateError(res, 402, 'CHARGE_REQUIRED', 'এই সনদের জন্য প্রথমে যাচাই ও পেমেন্ট সম্পন্ন করুন, তারপর প্রিভিউ/PDF খুলবে।');
      }

      // policy === 'verify'
      if (price > 0 && serviceId) {
        const { balance, lockedCredit } = await balanceAndCredit(db, serviceCredits, userId, serviceId);
        if (balance + lockedCredit < price) {
          return gateError(res, 402, 'INSUFFICIENT_BALANCE', `পর্যাপ্ত ব্যালেন্স নেই। যাচাই করতে ৳${price} প্রয়োজন, বর্তমান ব্যালেন্স ৳${balance}।`);
        }
      }

      let attemptKey = attemptKeyOf(req.body);
      let generatedKey = false;
      if (!attemptKey) {
        attemptKey = 'auto-' + crypto.randomUUID();
        generatedKey = true;
      }
      const orderKey = orderKeyOf(engineId, attemptKey);
      const ref = txRefOf(engineId, attemptKey);

      interceptVerifyResponse(res, async (status, body, send) => {
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch (_) { parsed = null; }
        if (!isVerifySuccess(status, parsed)) {
          // Failure, session error, engine error: forward untouched,
          // never charged.
          return send.forward(status, body);
        }
        if (price <= 0 || !serviceId) return send.forward(status, body);
        try {
          await chargeOnce(db, serviceCredits, userId, serviceId, price, ref);
        } catch (e) {
          if (/INSUFFICIENT_BALANCE/.test(e.message)) {
            // Record withheld: the client gets 402, not the record.
            return send.replace(402, {
              success: false, error: 'INSUFFICIENT_BALANCE',
              message: `পর্যাপ্ত ব্যালেন্স নেই। যাচাই করতে ৳${price} প্রয়োজন।`,
            });
          }
          throw e;
        }
        await recordOrder(db, userId, serviceId, price, orderKey);
        if (generatedKey && parsed) {
          parsed.idempotency_key = attemptKey;
          return send.forward(status, Buffer.from(JSON.stringify(parsed)));
        }
        return send.forward(status, body);
      });

      return next();
    } catch (e) {
      // Fail closed: an unexpected gate error must not leak a record
      // or let an unpaid render through. If headers already went out
      // (downstream finished), there is nothing safe left to send.
      if (!res.headersSent) {
        return gateError(res, 500, 'GATE_FAILED', 'চার্জ যাচাইয়ে সমস্যা হয়েছে — আবার চেষ্টা করুন।');
      }
      return undefined;
    }
  };
}

module.exports = {
  chargeGate,
  getEngineServicePrice,
  isVerifySuccess,
  attemptKeyOf,
  orderKeyOf,
  txRefOf,
  policyFor,
};
