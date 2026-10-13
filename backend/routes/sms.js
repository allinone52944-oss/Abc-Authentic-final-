// ============================================================
// All In One (Abc Authentic) - SMS auto-match routes
// 1) Webhook  POST /api/sms/incoming  (system token, NOT JWT)
//    Called by the merchant's SMS-forwarding app when a bKash /
//    Nagad / Rocket money-received SMS arrives.
// 2) Admin    /api/admin/sms/*        (requireAuth + requireAdmin)
//    List incoming SMS, manual match, ignore.
// Auto-match: exact TrxID first, then amount+sender fuzzy match.
// On match: atomic wallet credit via wallet_apply(), idempotent.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { safeLog } = require('../security');
const { parseSms } = require('../utils/sms-parser');
const wa = require('../utils/whatsapp');

const smsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120, // SMS forwarding apps retry; 120/hour is generous but bounded
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

async function logActivity(adminId, action, details) {
  try {
    await db.query(
      'INSERT INTO activity_log (admin_id, action, details) VALUES ($1, $2, $3)',
      [adminId, action, JSON.stringify(details || {})]
    );
  } catch (e) { safeLog('[sms] log failed:', e.message); }
}

// ---- shared atomic approve -----------------------------------
// Locks the pending recharge row; credits wallet idempotently;
// links the SMS. Returns the tx row or null if already processed.
async function approveRechargeTx(client, txId, smsId) {
  const r = await client.query(
    `SELECT * FROM transactions
     WHERE id = $1 AND status = 'pending' AND type = 'recharge' FOR UPDATE`,
    [txId]
  );
  const tx = r.rows[0];
  if (!tx) return null;
  // wallet_apply is atomic + idempotent (raises DUPLICATE_TRANSACTION)
  await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
    tx.user_id, Number(tx.amount), 'recharge', tx.trxid || ('tx-' + tx.id),
  ]);
  await client.query(
    `UPDATE transactions SET status = 'approved', admin_id = NULL WHERE id = $1`,
    [tx.id]
  );
  if (smsId) {
    await client.query(
      `UPDATE incoming_sms SET matched_recharge_id = $1, matched_at = NOW()
       WHERE id = $2`,
      [tx.id, smsId]
    );
  }
  return tx;
}

const SMS_METHODS = {
  bkash: ['bkash_payment', 'bkash_personal'],
  nagad: ['nagad'],
  rocket: ['rocket'],
  unknown: ['bkash_payment', 'bkash_personal', 'nagad', 'rocket'],
};

async function findMatch(client, parsed) {
  // 1) Exact TrxID (case-insensitive)
  if (parsed.trxid) {
    const r = await client.query(
      `SELECT * FROM transactions
       WHERE type = 'recharge' AND status = 'pending'
         AND trxid IS NOT NULL AND UPPER(trxid) = UPPER($1)
       LIMIT 1`,
      [parsed.trxid]
    );
    if (r.rows[0]) return { tx: r.rows[0], how: 'trxid' };
  }
  // 2) Fuzzy: same amount + same sender number
  if (parsed.amount != null && parsed.sender) {
    const methods = SMS_METHODS[parsed.method] || SMS_METHODS.unknown;
    const r = await client.query(
      `SELECT * FROM transactions
       WHERE type = 'recharge' AND status = 'pending'
         AND amount = $1 AND sender_no = $2 AND method = ANY($3)
       LIMIT 1`,
      [parsed.amount, parsed.sender, methods]
    );
    if (r.rows[0]) return { tx: r.rows[0], how: 'amount+sender' };
  }
  return null;
}

function checkSecret(req) {
  const configured = process.env.SMS_WEBHOOK_SECRET;
  if (!configured) return false;
  const given = String(
    req.body?.secret || req.query?.secret || req.headers['x-sms-secret'] || ''
  );
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================
// WEBHOOK router — mounted at /api/sms (no JWT; token-guarded)
// ============================================================
const webhook = express.Router();
webhook.use(smsLimiter);

// POST /api/sms/incoming
webhook.post('/incoming', async (req, res) => {
  try {
    if (!process.env.SMS_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'SMS_NOT_CONFIGURED' });
    }
    if (!checkSecret(req)) return res.status(401).json({ error: 'BAD_SECRET' });

    const rawMessage = String(req.body?.message || '').slice(0, 2000).trim();
    const rawSender = String(req.body?.sender || '').slice(0, 60).trim();
    if (!rawMessage) return res.status(400).json({ error: 'MISSING_MESSAGE' });

    const parsed = parseSms(rawMessage, rawSender);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Dedupe: same trxid already matched before → ignore
      let parseStatus = 'parsed';
      let matchInfo = null;
      if (parsed && parsed.trxid) {
        const dup = await client.query(
          `SELECT id FROM incoming_sms
           WHERE trxid = $1 AND matched_recharge_id IS NOT NULL LIMIT 1`,
          [parsed.trxid]
        );
        if (dup.rows.length) parseStatus = 'duplicate';
      }

      const ins = await client.query(
        `INSERT INTO incoming_sms
           (method, amount, sender, trxid, raw_message, raw_sender, parse_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          parsed ? parsed.method : 'unknown',
          parsed ? parsed.amount : null,
          parsed ? parsed.sender : null,
          parsed ? parsed.trxid : null,
          rawMessage, rawSender || null, parseStatus,
        ]
      );
      const smsId = ins.rows[0].id;

      // Only auto-match money-IN messages with a usable parse
      if (parsed && parseStatus === 'parsed' && parsed.direction !== 'out') {
        matchInfo = await findMatch(client, parsed);
        if (matchInfo) {
          // Anomaly protection: large amounts require manual review
          const MAX_AUTO_APPROVE = Number(process.env.SMS_MAX_AUTO_APPROVE || 50000);
          if (Number(matchInfo.tx.amount) > MAX_AUTO_APPROVE) {
            await client.query('COMMIT');
            await logActivity(null, 'sms.large_amount_hold', {
              sms_id: smsId, tx_id: matchInfo.tx.id, amount: Number(matchInfo.tx.amount),
            });
            return res.json({ ok: true, held_for_review: true });
          }
          const tx = await approveRechargeTx(client, matchInfo.tx.id, smsId);
          if (tx) {
            await client.query('COMMIT');
            await logActivity(null, 'sms.auto_match', {
              sms_id: smsId, tx_id: tx.id, user_id: tx.user_id,
              amount: Number(tx.amount), how: matchInfo.how, trxid: tx.trxid,
            });
            // WhatsApp: auto-approved recharge -> customer success message
            // (async, non-blocking, never breaks the webhook response)
            wa.notifyRechargeApproved(db, tx).catch(() => {});
            return res.json({ ok: true, matched: true, how: matchInfo.how, tx_id: tx.id });
          }
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, matched: false, sms_id: smsId, parsed: !!parsed });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    safeLog('[sms] incoming error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// ADMIN router — mounted at /api/admin/sms (JWT admin required)
// ============================================================
const adminSms = express.Router();
adminSms.use(requireAuth, requireAdmin);

// GET /api/admin/sms?matched=yes|no&page=
adminSms.get('/', async (req, res) => {
  try {
    const { page, limit, offset } = pageParams(req);
    const conds = [];
    const params = [];
    let i = 1;
    if (req.query.matched === 'yes') conds.push('s.matched_recharge_id IS NOT NULL');
    if (req.query.matched === 'no') {
      conds.push(`s.matched_recharge_id IS NULL AND s.parse_status = 'parsed'`);
    }
    if (req.query.q) {
      conds.push(`(s.trxid ILIKE $${i} OR s.sender ILIKE $${i} OR s.raw_message ILIKE $${i})`);
      params.push('%' + String(req.query.q).trim() + '%'); i++;
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(`SELECT COUNT(*) FROM incoming_sms s ${where}`, params);
    const rows = await db.query(
      `SELECT s.*, t.user_id, t.amount AS tx_amount, t.status AS tx_status,
              u.name AS user_name, u.phone AS user_phone
       FROM incoming_sms s
       LEFT JOIN transactions t ON t.id = s.matched_recharge_id
       LEFT JOIN users u ON u.id = t.user_id
       ${where} ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );
    res.json({ sms: rows.rows, total: parseInt(total.rows[0].count, 10), page, limit });
  } catch (e) {
    safeLog('[sms] list error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/admin/sms/:id/match { transaction_id }
adminSms.post('/:id/match', async (req, res) => {
  try {
    const smsId = req.params.id;
    const txId = req.body?.transaction_id;
    if (!txId) return res.status(400).json({ error: 'MISSING_TRANSACTION' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const s = await client.query('SELECT * FROM incoming_sms WHERE id = $1', [smsId]);
      const sms = s.rows[0];
      if (!sms) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'SMS_NOT_FOUND' }); }
      if (sms.matched_recharge_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ALREADY_MATCHED' });
      }
      const tx = await approveRechargeTx(client, txId, smsId);
      await client.query('COMMIT');
      if (!tx) return res.status(400).json({ error: 'TX_NOT_PENDING' });
      await logActivity(req.user.id, 'sms.manual_match', {
        sms_id: smsId, tx_id: tx.id, user_id: tx.user_id, amount: Number(tx.amount),
      });
      // WhatsApp: manually matched recharge -> customer success message
      // (async, non-blocking, never breaks the response)
      wa.notifyRechargeApproved(db, tx).catch(() => {});
      res.json({ ok: true, tx_id: tx.id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    safeLog('[sms] match error:', e.message);
    const msg = /DUPLICATE_TRANSACTION|INSUFFICIENT_BALANCE/.test(e.message) ? e.message : 'MATCH_FAILED';
    res.status(400).json({ error: msg });
  }
});

// POST /api/admin/sms/:id/ignore — mark as reviewed/ignored
adminSms.post('/:id/ignore', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE incoming_sms SET parse_status = 'ignored'
       WHERE id = $1 AND matched_recharge_id IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
    await logActivity(req.user.id, 'sms.ignore', { sms_id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[sms] ignore error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/admin/sms/pending-recharges — candidate list for manual match
adminSms.get('/pending-recharges', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT t.id, t.amount, t.method, t.sender_no, t.trxid, t.created_at,
              u.name AS user_name, u.phone AS user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.type = 'recharge' AND t.status = 'pending'
       ORDER BY t.created_at DESC LIMIT 50`
    );
    res.json({ pending: rows.rows });
  } catch (e) {
    safeLog('[sms] pending error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = { webhook, adminSms };
