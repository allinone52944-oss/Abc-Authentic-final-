'use strict';

const express = require('express');
const db = require('../db');
const { safeLog } = require('../security');
const { serviceAcceptsNewWork } = require('../lib/serviceAvailability');
const { availableFor, payForService } = require('../lib/serviceCredits');
const { lookupBdxTin, normalizeTinIdentifier } = require('../lib/bdxTinClient');
const { buildAutoTinReportPdf } = require('../lib/autoNidReportPdf');
const { storageKey, tinFingerprint, encryptReport, decryptReport } = require('../lib/autoNidReportStore');
const telegramNotify = require('../lib/telegramNotify'); // group notifications (2026-11-28)

// Telegram group notification for a TIN lookup (2026-11-28).
// Fire-and-forget: runs after the charge commits and can never
// fail the lookup (all errors swallowed inside). kind 'success'
// = certificate delivered; kind 'order' = paid but no report.
async function telegramTinNotify(userId, fee, orderId, kind) {
  try {
    const u = await db.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    const user = u.rows[0];
    if (!user) return;
    const s = await db.query(`SELECT name_bn FROM services WHERE engine_id = 'auto-tin' LIMIT 1`);
    const label = (s.rows[0] && s.rows[0].name_bn) || 'TIN সার্টিফিকেট';
    const params = {
      userName: user.name, userPhone: user.phone,
      serviceLabel: label, fee: Number(fee) || 0, orderId: String(orderId),
    };
    if (kind === 'success') await telegramNotify.notifySuccess(params);
    else await telegramNotify.notifyOrder(params);
  } catch (_) { /* Telegram never fails a lookup */ }
}

const router = express.Router();
const filename = 'tin-certificate.pdf';
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const providerKey = () => process.env.BDX_TIN_API_KEY?.trim() || process.env.BDX_NID_API_KEY?.trim();
const reject = (status, error) => ({ status, body: { error } });

router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

async function openService(client, userId, lock = false) {
  const { rows } = await client.query(
    `SELECT s.id, s.type, s.status, s.schedule, u.access_enabled,
            COALESCE(u.custom_price, s.price) AS price
       FROM services s LEFT JOIN user_services u ON u.user_id = $1 AND u.service_id = s.id
      WHERE s.engine_id = 'auto-tin'${lock ? ' FOR SHARE OF s' : ''}`, [userId]
  );
  if (rows.length !== 1) return null;
  const service = rows[0];
  const price = Number(service.price);
  return service.type === 'automated' && service.status === 'active' && service.access_enabled !== false
    && serviceAcceptsNewWork(service) && Number.isFinite(price) && price > 0 ? { id: service.id, price } : null;
}

function outcome(order, encryptionKey) {
  if (order.data?.auto_tin_paid_failure === true) {
    return {
      status: 422,
      body: {
        error: 'CHARGED_NO_REPORT',
        chargedAmount: order.status === 'refunded' ? 0 : Number(order.price),
        orderId: order.id,
      },
    };
  }
  if (!['completed', 'delivered', 'refunded'].includes(order.status)) return reject(409, 'SERVICE_UNAVAILABLE');
  const body = { orderId: order.id, downloadUrl: `/api/orders/${order.id}/documents/${filename}` };
  if (typeof order.data?.auto_tin_encrypted_number === 'string') {
    try {
      const encrypted = Buffer.from(order.data.auto_tin_encrypted_number, 'base64');
      const tin = decryptReport(encryptionKey, 'tin-number:' + order.data.auto_tin_request_hash, encrypted).toString('utf8');
      if (/^\d{12}$/.test(tin)) body.tin = tin;
    } catch {
      // The saved PDF remains available if optional display metadata cannot be decoded.
    }
  }
  return { status: 200, body };
}

async function purchase(client, userId, lookup, apiKey, encryptionKey) {
  const { rows: [lock] } = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('auto-tin:' || $1, 0)) AS acquired", [userId]
  );
  if (!lock.acquired) return reject(409, 'LOOKUP_BUSY');

  const { rows: [prior] } = await client.query(
    'SELECT id, data, status, price FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [userId, lookup.key]
  );
  const hash = tinFingerprint(encryptionKey, userId, lookup);
  if (prior) {
    return prior.data?.auto_tin_request_hash === hash
      ? outcome(prior, encryptionKey) : reject(409, 'IDEMPOTENCY_CONFLICT');
  }

  if (!apiKey) return reject(403, 'SERVICE_UNAVAILABLE');
  const { rows: [user] } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!user) return reject(403, 'SERVICE_UNAVAILABLE');
  const service = await openService(client, userId, true);
  if (!service) return reject(403, 'SERVICE_UNAVAILABLE');
  if (service.price !== lookup.price) return reject(409, 'PRICE_CHANGED');
  const credit = await availableFor(client, userId, service.id, { lock: true });
  if (Math.round((Number(user.balance) + credit) * 100) < Math.round(service.price * 100)) {
    return reject(402, 'INSUFFICIENT_BALANCE');
  }

  const result = await lookupBdxTin({ tin: lookup.tin, apiKey });
  if (!result.record && !result.charged) {
    return reject(result.error === 'RECORD_NOT_FOUND' ? 422 : 502, result.error);
  }
  let pdf;
  if (result.record) {
    try {
      pdf = await buildAutoTinReportPdf(result.record);
    } catch {
      safeLog('[auto-tin] report generation failed after verification');
    }
  }

  const data = { auto_tin_request_hash: hash, auto_tin_paid_failure: !pdf };
  if (pdf) {
    data.auto_tin_encrypted_number = encryptReport(
      encryptionKey, 'tin-number:' + hash, Buffer.from(result.record.tin, 'utf8')
    ).toString('base64');
  }
  const documents = pdf
    ? [{ type: 'delivery', filename, originalname: filename, uploaded_by: 'admin', storage: 'auto-nid-report' }]
    : [];
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (user_id, service_id, status, data, price, idempotency_key, documents)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, data, status, price`,
    [userId, service.id, pdf ? 'completed' : 'failed', JSON.stringify(data), service.price,
      lookup.key, JSON.stringify(documents)]
  );
  // Reuse the encrypted report storage and owner-only history/download gate.
  if (pdf) {
    await client.query(
      'INSERT INTO auto_nid_reports (order_id, request_hash, filename, encrypted_pdf) VALUES ($1, $2, $3, $4)',
      [order.id, hash, filename, encryptReport(encryptionKey, order.id, pdf)]
    );
  }
  await payForService(client, {
    userId, serviceId: service.id, amount: service.price, ref: 'order-' + lookup.key + '-' + userId,
  });
  // Fresh charge only: a replay returns outcome(prior) above, which
  // carries no fresh flag, so the handler never re-notifies.
  const out = outcome(order, encryptionKey);
  out.fresh = true;
  return out;
}

router.get('/options', async (req, res) => {
  try {
    const service = providerKey() && storageKey() && await openService(db, req.user.id);
    return res.json({ price: service ? service.price : null });
  } catch {
    safeLog('[auto-tin] options failed');
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
});

router.post('/lookup', async (req, res) => {
  const { tin: input, price, authorized, idempotencyKey } = req.body || {};
  const tin = normalizeTinIdentifier(input);
  if (!tin || authorized !== true || !Number.isFinite(price) || price <= 0 ||
      typeof idempotencyKey !== 'string' || !requestIdPattern.test(idempotencyKey)) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  const encryptionKey = storageKey();
  if (!encryptionKey) return res.status(403).json({ error: 'SERVICE_UNAVAILABLE' });

  try {
    const lookup = { tin, price, key: 'auto-tin:' + idempotencyKey.toLowerCase() };
    const result = await db.withTransaction(client => purchase(client, req.user.id, lookup, providerKey(), encryptionKey));
    // Telegram: fresh charge only (replays carry no fresh flag).
    if (result.fresh && result.body && result.body.orderId) {
      if (result.status === 200) telegramTinNotify(req.user.id, lookup.price, result.body.orderId, 'success').catch(() => {});
      else if (result.status === 422) telegramTinNotify(req.user.id, lookup.price, result.body.orderId, 'order').catch(() => {});
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') return res.status(402).json({ error: 'INSUFFICIENT_BALANCE' });
    safeLog('[auto-tin] purchase failed');
    return res.status(500).json({ error: 'LOOKUP_FAILED' });
  }
});

module.exports = router;
