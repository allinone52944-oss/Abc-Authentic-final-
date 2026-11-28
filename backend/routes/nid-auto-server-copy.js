'use strict';

const express = require('express');
const db = require('../db');
const { safeLog } = require('../security');
const { serviceAcceptsNewWork } = require('../lib/serviceAvailability');
const { availableFor, payForService } = require('../lib/serviceCredits');
const { lookupBdxNid } = require('../lib/bdxNidClient');
const { buildAutoNidReportPdf } = require('../lib/autoNidReportPdf');
const { storageKey, fingerprint, encryptReport } = require('../lib/autoNidReportStore');
const { products, engineIds } = require('../lib/autoNidProducts');
const telegramNotify = require('../lib/telegramNotify'); // group notifications (2026-11-28)

// Telegram group notification for an NID server-copy lookup
// (2026-11-28). Fire-and-forget: runs after the charge commits and
// can never fail the lookup (all errors swallowed inside).
// kind 'success' = report delivered; kind 'paid-failure' = paid but no report.
async function telegramNidCopyNotify(userId, type, fee, orderId, kind) {
  try {
    const u = await db.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    const user = u.rows[0];
    if (!user) return;
    const label = (products[type] && products[type].label) || 'NID Server Copy';
    const params = {
      userName: user.name, userPhone: user.phone,
      serviceLabel: label, fee: Number(fee) || 0, orderId: String(orderId),
    };
    if (kind === 'success') await telegramNotify.notifySuccess(params);
    else await telegramNotify.notifyPaidFailure(params);
  } catch (_) { /* Telegram never fails a lookup */ }
}

const router = express.Router();
const idempotencyPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const normalizeDigits = value => value.trim().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));

router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

function parseLookup(body) {
  const { type, nid, dob, authorized, price, idempotencyKey, acceptPremiumChargeOnLookup } = body || {};
  if (typeof type !== 'string' || !Object.hasOwn(products, type) || typeof nid !== 'string' || typeof dob !== 'string' ||
      typeof idempotencyKey !== 'string' || !idempotencyPattern.test(idempotencyKey) ||
      authorized !== true || !Number.isFinite(price) || price <= 0) return null;
  const number = normalizeDigits(nid);
  const date = normalizeDigits(dob);
  if (!/^(?:[0-9]{10}|[0-9]{13}|[0-9]{17})$/.test(number) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date ||
      date < '1900-01-01' || time > Date.now()) return null;
  return {
    type, nid: number, dob: date, price, acceptedPremiumTerms: acceptPremiumChargeOnLookup === true,
    key: 'nid-auto-server-copy:' + idempotencyKey.toLowerCase(),
  };
}

async function loadOptions(client, userId, configured, lockPremium = false) {
  const ids = lockPremium ? [products.backup.engineId, products.premium.engineId] : engineIds;
  const { rows } = await client.query(
    `SELECT s.id, s.engine_id, s.type, s.status, s.schedule, u.access_enabled,
            COALESCE(u.custom_price, s.price) AS price
       FROM services s
       LEFT JOIN user_services u ON u.service_id = s.id AND u.user_id = $1
       WHERE s.engine_id = ANY($2::text[])
       ${lockPremium ? 'ORDER BY s.id FOR SHARE OF s' : ''}`, [userId, ids]
  );
  const byEngine = engineId => {
    const matches = rows.filter(row => row.engine_id === engineId);
    return matches.length === 1 && matches[0].type === 'automated' ? matches[0] : null;
  };
  const enabled = service => service?.status === 'active' && serviceAcceptsNewWork(service);
  const parent = byEngine(products.backup.engineId);
  const allowed = configured && enabled(parent) && parent.access_enabled === true;
  return Object.entries(products).map(([type, { engineId, label }]) => {
    const service = byEngine(engineId);
    const price = Number(service?.price);
    const available = Boolean(allowed && enabled(service) && service.access_enabled !== false && price > 0);
    return { type, label, available, price: available ? price : null, serviceId: service?.id };
  });
}

async function walletBalance(client, userId, lock = false) {
  const sql = lock
    ? 'SELECT balance FROM users WHERE id = $1 FOR UPDATE'
    : 'SELECT balance FROM users WHERE id = $1';
  const { rows } = await client.query(sql, [userId]);
  return Number(rows[0]?.balance || 0);
}

router.get('/options', async (req, res) => {
  try {
    const userId = req.user.id;
    const configured = Boolean(process.env.BDX_NID_API_KEY?.trim() && storageKey());
    const [options, balance] = await Promise.all([loadOptions(db, userId, configured), walletBalance(db, userId)]);
    return res.json({
      options: options.map(({ type, label, available, price }) => ({ type, label, available, price })),
      balance,
    });
  } catch (_) {
    safeLog('[nid-auto-server-copy] options failed');
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
});

const reject = (status, error) => ({ status, body: { error } });
const accepted = (orderId, filename, addressLimited) => ({
  status: 200,
  body: {
    orderId, downloadUrl: '/api/orders/' + orderId + '/documents/' + filename,
    ...(addressLimited ? { addressLimited: true } : {}),
  },
});
const paidFailure = (orderId, price, refunded = false) => ({
  status: 422,
  body: {
    error: 'PREMIUM_CHARGED_NO_REPORT', orderId, chargedAmount: refunded ? 0 : Number(price),
    ...(refunded ? { refunded: true } : {}),
  },
});

async function settlePurchase(client, userId, lookup, option, { hash, key, pdf, addressLimited }) {
  const filename = 'nid-' + lookup.type + '-report.pdf';
  const documents = pdf
    ? [{ type: 'delivery', filename, originalname: filename, uploaded_by: 'admin', storage: 'auto-nid-report' }]
    : [];
  const data = { auto_nid_type: lookup.type };
  if (addressLimited && pdf) data.auto_nid_address_limited = true;
  if (!pdf) {
    data.auto_nid_paid_failure = true;
    data.auto_nid_request_hash = hash;
  }
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key, documents)
       VALUES ($1, $2, $7, $3, $4, $5, $6) RETURNING id`,
    [userId, option.serviceId, JSON.stringify(data), option.price, lookup.key, JSON.stringify(documents),
      pdf ? 'completed' : 'failed']
  );
  if (pdf) {
    await client.query(
      'INSERT INTO auto_nid_reports (order_id, request_hash, filename, encrypted_pdf) VALUES ($1, $2, $3, $4)',
      [order.id, hash, filename, encryptReport(key, order.id, pdf)]
    );
  }
  await payForService(client, {
    userId, serviceId: option.serviceId, amount: option.price, ref: 'order-' + lookup.key + '-' + userId,
  });
  // Fresh charge only: the replay branch in deliver() returns
  // accepted()/paidFailure() directly, with no fresh flag, so the
  // handler never re-notifies.
  const out = pdf ? accepted(order.id, filename, addressLimited) : paidFailure(order.id, option.price);
  out.fresh = true;
  return out;
}

async function deliver(client, userId, lookup, apiKey, key) {
  // A single in-flight purchase per account also covers retries using a fresh request key.
  const lock = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('nid-auto-server-copy:' || $1, 0)) AS acquired",
    [String(userId)]
  );
  if (!lock.rows[0]?.acquired) return reject(409, 'LOOKUP_BUSY');
  const hash = fingerprint(key, userId, lookup);
  const prior = await client.query(
    `SELECT o.id, o.status, o.price, r.filename,
            COALESCE(r.request_hash::text, o.data->>'auto_nid_request_hash') AS request_hash,
            o.data->>'auto_nid_paid_failure' = 'true' AS paid_failure,
            o.data->>'auto_nid_address_limited' = 'true' AS address_limited
       FROM orders o
       LEFT JOIN auto_nid_reports r ON r.order_id = o.id
       WHERE o.user_id = $1 AND o.idempotency_key = $2`, [userId, lookup.key]
  );
  if (prior.rows.length) {
    const row = prior.rows[0];
    if (row.request_hash !== hash) return reject(409, 'IDEMPOTENCY_CONFLICT');
    if (row.paid_failure) return paidFailure(row.id, row.price, row.status === 'refunded');
    return ['completed', 'delivered', 'refunded'].includes(row.status)
      ? accepted(row.id, row.filename, row.address_limited)
      : reject(409, 'SERVICE_UNAVAILABLE');
  }

  const premium = lookup.type === 'premium';
  if (premium && !lookup.acceptedPremiumTerms) return reject(409, 'PREMIUM_TERMS_CHANGED');
  // Premium can incur an upstream fee without a PDF, so lock both service
  // rows in the same read that accepts the reviewed price and availability.
  const selectOption = async () => (await loadOptions(client, userId, Boolean(apiKey), premium))
    .find(option => option.type === lookup.type);
  const option = await selectOption();
  if (!option.available) return reject(403, 'SERVICE_UNAVAILABLE');
  if (option.price !== lookup.price) return reject(409, 'PRICE_CHANGED');
  const balance = await walletBalance(client, userId, premium);
  const credit = premium
    ? await availableFor(client, userId, option.serviceId, { lock: true })
    : await availableFor(client, userId, option.serviceId);
  if (Math.round((balance + credit) * 100) < Math.round(option.price * 100)) return reject(402, 'INSUFFICIENT_BALANCE');

  let record;
  try {
    record = await lookupBdxNid({ type: lookup.type, nid: lookup.nid, dob: lookup.dob, apiKey });
  } catch (err) {
    if (!premium || err.providerCharged !== true) throw err;
    return settlePurchase(client, userId, lookup, option, { hash, key });
  }

  let pdf;
  try {
    pdf = await buildAutoNidReportPdf({ type: lookup.type, label: option.label, record });
  } catch (err) {
    if (!premium) throw err;
    safeLog('[nid-auto-server-copy] premium PDF creation failed after verification');
    return settlePurchase(client, userId, lookup, option, { hash, key });
  }
  if (!premium) {
    const latestOption = await selectOption();
    if (!latestOption.available || latestOption.serviceId !== option.serviceId) return reject(403, 'SERVICE_UNAVAILABLE');
    if (latestOption.price !== option.price) return reject(409, 'PRICE_CHANGED');
  }
  const addressLimited = premium && (!record.presentAddress || !record.permanentAddress);
  return settlePurchase(client, userId, lookup, option, { hash, key, pdf, addressLimited });
}

router.post('/lookup', async (req, res) => {
  const lookup = parseLookup(req.body);
  if (!lookup) return res.status(400).json({ error: 'INVALID_INPUT' });
  const key = storageKey();
  if (!key) return res.status(403).json({ error: 'SERVICE_UNAVAILABLE' });
  try {
    const apiKey = process.env.BDX_NID_API_KEY?.trim();
    const result = await db.withTransaction(client => deliver(client, req.user.id, lookup, apiKey, key));
    // Telegram: fresh charge only (replays carry no fresh flag).
    if (result.fresh && result.body && result.body.orderId) {
      if (result.status === 200) telegramNidCopyNotify(req.user.id, lookup.type, lookup.price, result.body.orderId, 'success').catch(() => {});
      else if (result.status === 422) telegramNidCopyNotify(req.user.id, lookup.type, lookup.price, result.body.orderId, 'paid-failure').catch(() => {});
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    if (e.code === 'record_not_found') return res.status(422).json({ error: 'RECORD_NOT_FOUND' });
    if (e.code === 'provider_unavailable') return res.status(502).json({ error: 'PROVIDER_UNAVAILABLE' });
    if (e.message === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: 'INSUFFICIENT_BALANCE' });
    safeLog('[nid-auto-server-copy] purchase failed');
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
});

module.exports = router;
