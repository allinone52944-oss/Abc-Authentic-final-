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

const router = express.Router();
const idempotencyPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const normalizeDigits = value => value.trim().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));

router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

function parseLookup(body) {
  const { type, nid, dob, authorized, price, idempotencyKey } = body || {};
  if (typeof type !== 'string' || !Object.hasOwn(products, type) || typeof nid !== 'string' || typeof dob !== 'string' ||
      typeof idempotencyKey !== 'string' || !idempotencyPattern.test(idempotencyKey) ||
      authorized !== true || !Number.isFinite(price) || price <= 0) return null;
  const number = normalizeDigits(nid);
  const date = normalizeDigits(dob);
  if (!/^(?:[0-9]{10}|[0-9]{13}|[0-9]{17})$/.test(number) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date ||
      date < '1900-01-01' || time > Date.now()) return null;
  return { type, nid: number, dob: date, price, key: 'nid-auto-server-copy:' + idempotencyKey.toLowerCase() };
}

async function loadOptions(client, userId, configured) {
  const { rows } = await client.query(
    `SELECT s.id, s.engine_id, s.type, s.status, s.schedule, u.access_enabled,
            COALESCE(u.custom_price, s.price) AS price
       FROM services s
       LEFT JOIN user_services u ON u.service_id = s.id AND u.user_id = $1
       WHERE s.engine_id = ANY($2::text[])`, [userId, engineIds]
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

async function walletBalance(client, userId) {
  const { rows } = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);
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
const accepted = (orderId, filename) => ({
  status: 200, body: { orderId, downloadUrl: '/api/orders/' + orderId + '/documents/' + filename },
});

async function deliver(client, userId, lookup, apiKey, key) {
  // A single in-flight purchase per account also covers retries using a fresh request key.
  const lock = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('nid-auto-server-copy:' || $1, 0)) AS acquired",
    [String(userId)]
  );
  if (!lock.rows[0]?.acquired) return reject(409, 'LOOKUP_BUSY');
  const hash = fingerprint(key, userId, lookup);
  const prior = await client.query(
    `SELECT o.id, o.status, r.request_hash, r.filename FROM orders o
       LEFT JOIN auto_nid_reports r ON r.order_id = o.id
       WHERE o.user_id = $1 AND o.idempotency_key = $2`, [userId, lookup.key]
  );
  if (prior.rows.length) {
    const row = prior.rows[0];
    if (row.request_hash !== hash) return reject(409, 'IDEMPOTENCY_CONFLICT');
    return ['completed', 'delivered', 'refunded'].includes(row.status)
      ? accepted(row.id, row.filename)
      : reject(409, 'SERVICE_UNAVAILABLE');
  }

  const selectOption = async () => (await loadOptions(client, userId, Boolean(apiKey)))
    .find(option => option.type === lookup.type);
  const option = await selectOption();
  if (!option.available) return reject(403, 'SERVICE_UNAVAILABLE');
  if (option.price !== lookup.price) return reject(409, 'PRICE_CHANGED');
  const balance = await walletBalance(client, userId);
  const credit = await availableFor(client, userId, option.serviceId);
  if (Math.round((balance + credit) * 100) < Math.round(option.price * 100)) return reject(402, 'INSUFFICIENT_BALANCE');

  const record = await lookupBdxNid({ type: lookup.type, nid: lookup.nid, dob: lookup.dob, apiKey });
  const pdf = await buildAutoNidReportPdf({ label: option.label, record });
  const latestOption = await selectOption();
  if (!latestOption.available || latestOption.serviceId !== option.serviceId) return reject(403, 'SERVICE_UNAVAILABLE');
  if (latestOption.price !== option.price) return reject(409, 'PRICE_CHANGED');

  const filename = 'nid-' + lookup.type + '-report.pdf';
  const documents = [{ type: 'delivery', filename, originalname: filename, uploaded_by: 'admin', storage: 'auto-nid-report' }];
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key, documents)
       VALUES ($1, $2, 'completed', $3, $4, $5, $6) RETURNING id`,
    [userId, option.serviceId, JSON.stringify({ auto_nid_type: lookup.type }), option.price, lookup.key, JSON.stringify(documents)]
  );
  await client.query(
    'INSERT INTO auto_nid_reports (order_id, request_hash, filename, encrypted_pdf) VALUES ($1, $2, $3, $4)',
    [order.id, hash, filename, encryptReport(key, order.id, pdf)]
  );
  await payForService(client, {
    userId, serviceId: option.serviceId, amount: option.price, ref: 'order-' + lookup.key + '-' + userId,
  });
  return accepted(order.id, filename);
}

router.post('/lookup', async (req, res) => {
  const lookup = parseLookup(req.body);
  if (!lookup) return res.status(400).json({ error: 'INVALID_INPUT' });
  const key = storageKey();
  if (!key) return res.status(403).json({ error: 'SERVICE_UNAVAILABLE' });
  try {
    const apiKey = process.env.BDX_NID_API_KEY?.trim();
    const result = await db.withTransaction(client => deliver(client, req.user.id, lookup, apiKey, key));
    return res.status(result.status).json(result.body);
  } catch (e) {
    if (e.code === 'record_not_found') return res.status(422).json({ error: 'RECORD_NOT_FOUND' });
    if (e.code === 'address_incomplete') return res.status(422).json({ error: 'ADDRESS_INCOMPLETE' });
    if (e.code === 'provider_unavailable') return res.status(502).json({ error: 'PROVIDER_UNAVAILABLE' });
    if (e.message === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: 'INSUFFICIENT_BALANCE' });
    safeLog('[nid-auto-server-copy] purchase failed');
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
});

module.exports = router;
