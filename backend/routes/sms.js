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
const push = require('../utils/push');

const smsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120, // SMS forwarding apps retry; 120/hour is generous but bounded
  standardHeaders: true,
  legacyHeaders: false,
  // Audit #37 — over the cap, a VALID SMS is HELD, not dropped: the
  // handler stores it as 'unparsed' so it stays visible in the admin
  // hub for a manual match, and the forwarder gets a 202
  // (accepted-held) instead of a 429 it would retry. Invalid-secret
  // traffic is still dropped with 429 and never stored. The hold
  // itself is capped (SMS_RATE_HOLD_MAX, default 50/hour) so a flood
  // cannot fill the table; past the cap the 429 returns.
  handler: (req, res) => { void holdRateLimitedSms(req, res); },
});

// Over-cap SMS, held for the admin instead of lost. Exported for tests.
const SMS_RATE_HOLD_MAX = Math.max(0, parseInt(process.env.SMS_RATE_HOLD_MAX || '50', 10) || 50);
async function holdRateLimitedSms(req, res) {
  try {
    if (!checkSecret(req)) return res.status(429).json({ error: 'RATE_LIMITED' });
    const rawMessage = String(req.body?.message || '').slice(0, 2000).trim();
    const rawSender = String(req.body?.sender || '').slice(0, 60).trim();
    if (!rawMessage) return res.status(429).json({ error: 'RATE_LIMITED' });
    // The cap bounds the unprocessed pile (held + genuinely unparsed
    // SMS together): past it, the old drop behaviour returns.
    const held = await db.query(
      `SELECT COUNT(*) FROM incoming_sms
        WHERE parse_status = 'unparsed' AND created_at >= NOW() - INTERVAL '1 hour'`,
      []);
    if (parseInt(held.rows[0].count, 10) >= SMS_RATE_HOLD_MAX) {
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    const ins = await db.query(
      `INSERT INTO incoming_sms (method, amount, sender, trxid, raw_message, raw_sender, parse_status)
       VALUES ('unknown', NULL, NULL, NULL, $1, $2, 'unparsed') RETURNING id`,
      [rawMessage, rawSender || null]);
    const smsId = ins.rows[0].id;
    await logActivity(null, 'sms.rate_limited_hold', { sms_id: smsId, reason: 'RATE_LIMITED' });
    return res.status(202).json({ ok: true, held_for_review: true, reason: 'RATE_LIMITED', sms_id: smsId });
  } catch (e) {
    safeLog('[sms] rate-limit hold failed:', e.message);
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }
}

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
// Locks the recharge AND the SMS, serializes consumption of the provider
// TrxID, then credits and links both in the same transaction. Any consumed
// or concurrently claimed SMS aborts the wallet credit as well.
async function approveRechargeTx(client, txId, smsId, via = 'auto') {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('recharge-credit'))");
  const r = await client.query(
    `SELECT * FROM transactions WHERE id = $1 AND status = 'pending' AND type = 'recharge' FOR UPDATE`,
    [txId]
  );
  const tx = r.rows[0];
  if (!tx) return null;

  let sms = null;
  if (smsId) {
    const lockedSms = await client.query(
      `SELECT id, trxid, matched_recharge_id FROM incoming_sms
       WHERE id = $1 FOR UPDATE`,
      [smsId]
    );
    sms = lockedSms.rows[0];
    if (!sms) throw new Error('SMS_NOT_FOUND');
    if (sms.matched_recharge_id) throw new Error('SMS_ALREADY_MATCHED');
    if (sms.trxid) {
      // Two duplicate SMS rows can represent one provider payment. The
      // advisory lock plus consumed check makes that TrxID single-use
      // across webhook, late-submit and admin-match entry points.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sms-payment:' + String(sms.trxid).toUpperCase()]);
      const consumed = await client.query(
        `SELECT id FROM incoming_sms
         WHERE id <> $1 AND UPPER(trxid) = UPPER($2)
           AND matched_recharge_id IS NOT NULL LIMIT 1`,
        [sms.id, sms.trxid]
      );
      if (consumed.rows.length) throw new Error('SMS_ALREADY_MATCHED');
    }
  }

  const paymentRef = sms?.trxid || tx.trxid;
  if (paymentRef) {
    const paid = await client.query(
      `SELECT id FROM transactions WHERE status = 'approved' AND type = 'recharge'
       AND UPPER(trxid) = UPPER($1) AND id <> $2 LIMIT 1`, [paymentRef, tx.id]);
    if (paid.rows.length) throw new Error('DUPLICATE_TRANSACTION');
  }

  // wallet_apply is atomic + idempotent (raises DUPLICATE_TRANSACTION)
  // C-4 fix (2026-10-15): existing pending row reuse — ডবল ledger row নয়
  await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4, $5)', [
    tx.user_id, Number(tx.amount), 'recharge', tx.trxid || ('tx-' + tx.id), tx.id,
  ]);
  // Number-only Auto starts with no TrxID. Once a real SMS is matched,
  // store that SMS's actual TrxID instead of leaving an invented AUTO-*
  // placeholder. Manual requests already have a TrxID and stay unchanged.
  const realTrx = smsId ? await client.query(
    `UPDATE transactions AS t
        SET trxid = s.trxid
       FROM incoming_sms AS s
      WHERE t.id = $1 AND s.id = $2 AND s.trxid IS NOT NULL
        AND (t.trxid IS NULL OR t.trxid ~ '^AUTO-[0-9A-F]{12}$')
      RETURNING t.trxid`,
    [tx.id, smsId]
  ) : null;
  await client.query(
    `UPDATE transactions SET admin_id = NULL WHERE id = $1`,
    [tx.id]
  );
  if (smsId) {
    const linked = await client.query(
      // Audit #33 — record how the match happened, so the admin hub
      // can tell an auto-match from a manual one. The conditional link
      // is the final atomic guard against two actors using one SMS row.
      `UPDATE incoming_sms SET matched_recharge_id = $1, matched_at = NOW(), matched_via = $3
       WHERE id = $2 AND matched_recharge_id IS NULL RETURNING id`,
      [tx.id, smsId, via]
    );
    if (!linked.rows.length) throw new Error('SMS_ALREADY_MATCHED');
  }
  return { ...tx, status: 'approved', trxid: realTrx?.rows[0]?.trxid || tx.trxid };
}

// Amount equality with 2-decimal tolerance (NUMERIC column vs parsed float).
function amountsEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

// Cancel a pending recharge without touching the wallet.
// Retained for manual/admin cancellation. The webhook no longer
// calls it: an amount mismatch HELDS the request (audit #26)
// instead of voiding it, so a parser misread cannot destroy a
// real recharge.
async function cancelRechargeTx(client, txId) {
  const r = await client.query(
    `UPDATE transactions SET status = 'rejected', admin_id = NULL
     WHERE id = $1 AND status = 'pending' AND type = 'recharge' RETURNING *`,
    [txId]
  );
  return r.rows[0] || null;
}

const SMS_METHODS = {
  bkash: ['bkash_payment', 'bkash_personal'],
  nagad: ['nagad'],
  rocket: ['rocket'],
  unknown: ['bkash_payment', 'bkash_personal', 'nagad', 'rocket'],
};

async function findMatch(client, parsed) {
  // 1) Exact TrxID (case-insensitive). Multiple pending claims are
  // ambiguous and must be reviewed instead of selecting an arbitrary user.
  if (parsed.trxid) {
    const r = await client.query(
      `SELECT * FROM transactions
       WHERE type = 'recharge' AND status = 'pending'
         AND trxid IS NOT NULL AND UPPER(trxid) = UPPER($1)
       LIMIT 2`,
      [parsed.trxid]
    );
    if (r.rows.length === 1) return { tx: r.rows[0], how: 'trxid' };
    if (r.rows.length > 1) return null;
  }
  // 2) Number-only Auto: amount + sender + provider + real SMS TrxID.
  // A manual request with a wrong TrxID must NEVER fall back to this path.
  // Only a unique, recent Auto request is eligible; ambiguity stays pending.
  if (parsed.amount != null && parsed.sender && parsed.trxid) {
    const methods = SMS_METHODS[parsed.method] || [];
    if (!methods.length) return null;
    const r = await client.query(
      `SELECT * FROM transactions
       WHERE type = 'recharge' AND status = 'pending'
         AND (trxid IS NULL OR trxid ~ '^AUTO-[0-9A-F]{12}$')
         AND amount = $1 AND sender_no = $2 AND method = ANY($3)
         AND created_at >= NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 2`,
      [parsed.amount, parsed.sender, methods]
    );
    if (r.rows.length === 1) return { tx: r.rows[0], how: 'amount+sender' };
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext('recharge-credit'))");

      // Dedupe: same trxid already matched before → ignore.
      // Audit #23 — case-folded: a re-delivered SMS whose TrxID
      // differs only in case is the same SMS, not a fresh one.
      // Audit #34 — an SMS the parser could not read is 'unparsed',
      // never 'parsed': the old default lied, and the unmatched
      // counts/list (which filter on the status) then treated it as
      // a normal parsed-but-unmatched SMS. The CHECK constraint in
      // migration 005 already allows 'unparsed' — only the code
      // never used it.
      let parseStatus = parsed ? 'parsed' : 'unparsed';
      let matchInfo = null;
      if (parsed && parsed.trxid) {
        const dup = await client.query(
          `SELECT id FROM incoming_sms
           WHERE UPPER(trxid) = UPPER($1) AND matched_recharge_id IS NOT NULL LIMIT 1`,
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

      // Only auto-match money-IN messages with a usable parse.
      // Audit #25 — direction 'unknown' is NOT money-in: the old
      // `!== 'out'` gate auto-matched any SMS the parser could
      // not classify, so a money-out wording the parser misses
      // could credit a pending recharge.
      if (parsed && parseStatus === 'parsed' && parsed.direction === 'in') {
        matchInfo = await findMatch(client, parsed);
        if (matchInfo) {
          // The provider family must agree as well as TrxID/amount. This
          // prevents a same-looking reference from another MFS being used.
          const allowedMethods = SMS_METHODS[parsed.method] || [];
          if (!allowedMethods.includes(matchInfo.tx.method)) {
            await client.query('COMMIT');
            await logActivity(null, 'sms.method_mismatch_hold', {
              sms_id: smsId, tx_id: matchInfo.tx.id, sms_method: parsed.method,
            });
            return res.json({ ok: true, held_for_review: true, reason: 'METHOD_MISMATCH' });
          }
          // Fraud guard: a TrxID match must also agree on the amount.
          // Without this, a customer could submit ৳5,000 against a ৳50 SMS.
          if (matchInfo.how === 'trxid') {
            if (parsed.amount == null) {
              // Amount could not be parsed from the SMS — never auto-credit blind.
              await client.query('COMMIT');
              await logActivity(null, 'sms.amount_unverified_hold', {
                sms_id: smsId, tx_id: matchInfo.tx.id, amount: Number(matchInfo.tx.amount),
              });
              // Audit #27 — a hold must not be silent: tell the
              // customer why their request is waiting.
              push.notifyUser(db, matchInfo.tx.user_id, '⏳ রিচার্জ যাচাইয়ে আছে',
                'আপনার SMS-এর পরিমাণ পড়া যায়নি — অনুরোধটি আটকে আছে, এডমিন দেখছেন।', '/wallet.html').catch(() => {});
              return res.json({ ok: true, held_for_review: true, reason: 'AMOUNT_UNPARSED' });
            }
            if (!amountsEqual(parsed.amount, matchInfo.tx.amount)) {
              // Audit #26 — HOLD, never cancel: the parser takes
              // the first amount in the SMS, which may not be the
              // received amount (a fee or a balance can come
              // first), and cancelling destroys the customer's
              // real request on a parser misread. The pending
              // stays pending and the SMS stays unmatched, both
              // visible to the admin for a manual decision. No
              // credit is given — the fraud guard's purpose
              // (never credit on a mismatch) is preserved.
              await client.query('COMMIT');
              await logActivity(null, 'sms.amount_mismatch_hold', {
                sms_id: smsId, tx_id: matchInfo.tx.id, user_id: matchInfo.tx.user_id,
                claimed_amount: Number(matchInfo.tx.amount), sms_amount: parsed.amount,
              });
              // Notify customer (WhatsApp + own-device push) + admins
              // (Web Push). Async, never breaks the webhook. The
              // request is NOT cancelled — the messages say so.
              wa.notifyRechargeMismatch(db, matchInfo.tx, parsed.amount, true).catch(() => {});
              push.notifyUser(db, matchInfo.tx.user_id, '⚠️ রিচার্জে পরিমাণের অমিল',
                'রিচার্জের অনুরোধে লেখা পরিমাণের সঙ্গে প্রাপ্ত SMS-এর পরিমাণ মেলেনি — অনুরোধটি বাতিল হয়নি, এডমিন যাচাই করছেন।', '/wallet.html').catch(() => {});
              push.notifyAmountMismatch(db, matchInfo.tx, parsed.amount, true).catch(() => {});
              return res.json({ ok: true, held_for_review: true, reason: 'AMOUNT_MISMATCH', sms_id: smsId });
            }
          }
          // Anomaly protection: large amounts require manual review
          const MAX_AUTO_APPROVE = Number(process.env.SMS_MAX_AUTO_APPROVE || 50000);
          if (Number(matchInfo.tx.amount) > MAX_AUTO_APPROVE) {
            await client.query('COMMIT');
            await logActivity(null, 'sms.large_amount_hold', {
              sms_id: smsId, tx_id: matchInfo.tx.id, amount: Number(matchInfo.tx.amount),
            });
            // Audit #27 — a hold must not be silent: tell the
            // customer why their request is waiting.
            push.notifyUser(db, matchInfo.tx.user_id, '⏳ রিচার্জ যাচাইয়ে আছে',
              'বড় অঙ্কের রিচার্জ — ম্যানুয়াল যাচাই হবে, এডমিন দেখছেন।', '/wallet.html').catch(() => {});
            return res.json({ ok: true, held_for_review: true });
          }
          const tx = await approveRechargeTx(client, matchInfo.tx.id, smsId);
          if (tx) {
            await client.query('COMMIT');
            await logActivity(null, 'sms.auto_match', {
              sms_id: smsId, tx_id: tx.id, user_id: tx.user_id,
              amount: Number(tx.amount), how: matchInfo.how, trxid: tx.trxid,
            });
            // Customer: auto-approved recharge (WhatsApp + push)
            wa.notifyRechargeApproved(db, tx).catch(() => {});
            push.notifyUser(db, tx.user_id, '✅ রিচার্জ সফল!',
              '৳' + tx.amount + ' আপনার ওয়ালেটে যোগ হয়েছে।', '/wallet.html').catch(() => {});
            // Admin: auto-approved recharges never reach the pending list,
            // so without this the admin sees only the unmatched-SMS toast
            // and then silence. Manual matches are excluded (admin actor).
            push.notifyAutoApproveRecharge(db, tx, tx.user_id).catch(() => {});
            return res.json({ ok: true, matched: true, how: matchInfo.how, tx_id: tx.id });
          }
        }
      }

      // Audit #25 — direction unknown: not money-in until proven.
      // Never auto-match; hold for admin review (the SMS stays
      // stored as unmatched and visible in the admin hub), in the
      // same shape as the amount-unparsed / large-amount holds.
      if (parsed && parseStatus === 'parsed' && parsed.direction === 'unknown') {
        await client.query('COMMIT');
        await logActivity(null, 'sms.direction_unknown_hold', {
          sms_id: smsId, trxid: parsed.trxid, amount: parsed.amount,
        });
        // Audit #27 note: no customer notification is possible
        // here — no transaction is matched yet, so there is no
        // identified customer to tell. The SMS stays unmatched
        // for the admin, and the owner is told when their pending
        // is reviewed. (The two holds above DO have a matched tx
        // and notify that customer.)
        return res.json({ ok: true, held_for_review: true, reason: 'DIRECTION_UNKNOWN' });
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
    if (e.message === 'SMS_ALREADY_MATCHED') {
      return res.status(409).json({ ok: false, error: 'SMS_ALREADY_MATCHED' });
    }
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
      // Audit #34 — unparsed SMS are unmatched too (they still need
      // admin attention; the hub shows their raw message), so the
      // unmatched list includes both statuses. The late-submit
      // auto-match lookup below keeps `= 'parsed'` on purpose: it
      // needs a TrxID + amount, which an unparsed SMS never has.
      conds.push(`s.matched_recharge_id IS NULL AND s.parse_status IN ('parsed', 'unparsed')`);
    }
    if (req.query.q) {
      conds.push(`(s.trxid ILIKE $${i} OR s.sender ILIKE $${i} OR s.raw_message ILIKE $${i})`);
      params.push('%' + String(req.query.q).trim() + '%'); i++;
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = await db.query(`SELECT COUNT(*) FROM incoming_sms s ${where}`, params);
    // SMS delete system: the hub shows a bulk-delete button only when
    // there is at least one ignored SMS, so the list carries that count.
    const ignored = await db.query(
      `SELECT COUNT(*) FROM incoming_sms s
        WHERE s.parse_status = 'ignored' AND s.matched_recharge_id IS NULL`
    );
    // SMS Delete All: the button needs the grand total (matched +
    // unmatched, all filters ignored) — `total` above respects the
    // current filter, so it cannot serve this.
    const totalAll = await db.query(`SELECT COUNT(*) FROM incoming_sms`);
    const rows = await db.query(
      `SELECT s.*, t.user_id, t.amount AS tx_amount, t.status AS tx_status,
              u.name AS user_name, u.phone AS user_phone
       FROM incoming_sms s
       LEFT JOIN transactions t ON t.id = s.matched_recharge_id
       LEFT JOIN users u ON u.id = t.user_id
       ${where} ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );
    res.json({ sms: rows.rows, total: parseInt(total.rows[0].count, 10), ignored_total: parseInt(ignored.rows[0].count, 10), total_all: parseInt(totalAll.rows[0].count, 10), page, limit });
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext('recharge-credit'))");
      const s = await client.query('SELECT * FROM incoming_sms WHERE id = $1', [smsId]);
      const sms = s.rows[0];
      if (!sms) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'SMS_NOT_FOUND' }); }
      if (sms.matched_recharge_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ALREADY_MATCHED' });
      }
      // Fraud guard: manual match must also agree on the amount.
      if (sms.amount != null) {
        const t = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const txRow = t.rows[0];
        if (txRow && txRow.type === 'recharge' && !amountsEqual(sms.amount, txRow.amount)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'AMOUNT_MISMATCH',
            sms_amount: Number(sms.amount),
            requested_amount: Number(txRow.amount),
          });
        }
      }
      const tx = await approveRechargeTx(client, txId, smsId, 'manual'); // audit #33 — a manual match is recorded as manual
      await client.query('COMMIT');
      if (!tx) return res.status(400).json({ error: 'TX_NOT_PENDING' });
      await logActivity(req.user.id, 'sms.manual_match', {
        sms_id: smsId, tx_id: tx.id, user_id: tx.user_id, amount: Number(tx.amount),
      });
      // Customer: manually matched recharge (WhatsApp + push)
      wa.notifyRechargeApproved(db, tx).catch(() => {});
      push.notifyUser(db, tx.user_id, '✅ রিচার্জ সফল!',
        '৳' + tx.amount + ' আপনার ওয়ালেটে যোগ হয়েছে।', '/wallet.html').catch(() => {});
      res.json({ ok: true, tx_id: tx.id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    safeLog('[sms] match error:', e.message);
    // Recharge Bug 4: SMS_ALREADY_MATCHED is a real answer, not a generic
    // failure — a racing actor (auto-match/webhook/another admin) can link
    // this SMS after the early ALREADY_MATCHED check but before
    // approveRechargeTx's conditional link. Preserve it so the admin sees why.
    const msg = /DUPLICATE_TRANSACTION|INSUFFICIENT_BALANCE|SMS_ALREADY_MATCHED/.test(e.message) ? e.message : 'MATCH_FAILED';
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

// DELETE /api/admin/sms/:id — permanently delete one SMS (hard delete).
// Safety: a MATCHED SMS (matched_recharge_id IS NOT NULL) is payment
// evidence for a recharge and must NEVER be deleted. The guard lives in
// the DELETE itself (atomic); a second SELECT only tells a matched SMS
// apart from a missing one so the admin gets the real reason.
adminSms.delete('/:id', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM incoming_sms
        WHERE id = $1 AND matched_recharge_id IS NULL RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length) {
      await logActivity(req.user.id, 'sms.delete', { sms_id: req.params.id });
      return res.json({ ok: true });
    }
    const s = await db.query(
      'SELECT matched_recharge_id FROM incoming_sms WHERE id = $1',
      [req.params.id]
    );
    if (!s.rows[0]) return res.status(404).json({ error: 'SMS_NOT_FOUND' });
    return res.status(400).json({
      error: 'MATCHED_SMS',
      message: 'এই SMS একটি রিচার্জের সাথে মিলেছে, তাই মুছে ফেলা যাবে না।',
    });
  } catch (e) {
    safeLog('[sms] delete error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/admin/sms/delete-ignored — permanently delete ALL ignored SMS.
// Only parse_status = 'ignored' AND unmatched rows; matched and
// unmatched-but-not-ignored SMS are never touched.
adminSms.post('/delete-ignored', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM incoming_sms
        WHERE parse_status = 'ignored' AND matched_recharge_id IS NULL
        RETURNING id`
    );
    const deleted = r.rows.length;
    await logActivity(req.user.id, 'sms.delete-ignored', { count: deleted });
    res.json({ ok: true, deleted });
  } catch (e) {
    safeLog('[sms] delete-ignored error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/admin/sms/delete-all — permanently delete EVERY SMS in the hub
// (matched + unmatched). Destructive by design: a matched SMS is payment
// evidence for a recharge, and deleting it removes that proof forever.
// The recharge itself is untouched — no table references incoming_sms
// (the link lives only on the SMS row's matched_recharge_id, and
// transactions store no sms id), so nothing dangles and nothing breaks.
// Requires an explicit {confirm:true} body flag; without it, refuse with
// 400 CONFIRM_REQUIRED. Logs the count only, never SMS content/TrxIDs.
adminSms.post('/delete-all', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        error: 'CONFIRM_REQUIRED',
        message: 'সব SMS মুছতে নিশ্চিত করুন — এই কাজটি ফেরানো যাবে না।',
      });
    }
    const r = await db.query(`DELETE FROM incoming_sms RETURNING id`);
    const deleted = r.rows.length;
    await logActivity(req.user.id, 'sms.delete-all', { count: deleted });
    res.json({ ok: true, deleted });
  } catch (e) {
    safeLog('[sms] delete-all error:', e.message);
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


// Check if an unmatched incoming SMS arrived before the user submitted recharge
async function tryAutoMatchRecharge(tx) {
  if (!tx || !tx.id || !tx.trxid || tx.status !== 'pending') return null;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('recharge-credit'))");
    // Lock matching unmatched SMS (exact TrxID + matching amount)
    const r = await client.query(
      `SELECT * FROM incoming_sms
       WHERE matched_recharge_id IS NULL
         AND parse_status = 'parsed'
         AND trxid IS NOT NULL AND UPPER(trxid) = UPPER($1)
         AND amount = $2
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [String(tx.trxid).trim(), Number(tx.amount)]
    );
    const sms = r.rows[0];
    if (!sms) {
      await client.query('COMMIT');
      return null;
    }
    // The request-first webhook applies these same guards. SMS-first
    // manual/Auto submission must never bypass money-IN or provider checks.
    const parsed = parseSms(sms.raw_message, sms.raw_sender);
    const allowedMethods = parsed ? (SMS_METHODS[parsed.method] || []) : [];
    if (!parsed || parsed.direction !== 'in' || !allowedMethods.includes(tx.method)) {
      await client.query('COMMIT');
      return null;
    }

    const MAX_AUTO_APPROVE = Number(process.env.SMS_MAX_AUTO_APPROVE || 50000);
    if (Number(tx.amount) > MAX_AUTO_APPROVE) {
      await client.query('COMMIT');
      await logActivity(null, 'sms.large_amount_hold', {
        sms_id: sms.id, tx_id: tx.id, amount: Number(tx.amount),
      });
      return null;
    }

    const approvedTx = await approveRechargeTx(client, tx.id, sms.id);
    await client.query('COMMIT');

    if (approvedTx) {
      await logActivity(null, 'sms.auto_match', {
        sms_id: sms.id, tx_id: approvedTx.id, user_id: approvedTx.user_id,
        amount: Number(approvedTx.amount), how: 'trxid_late_submit', trxid: approvedTx.trxid,
      });
      wa.notifyRechargeApproved(db, approvedTx).catch(() => {});
      push.notifyUser(db, approvedTx.user_id, '✅ রিচার্জ সফল!',
        '৳' + approvedTx.amount + ' আপনার ওয়ালেটে যোগ হয়েছে।', '/wallet.html').catch(() => {});
      // Admin: same gap as the webhook path — an auto-approved recharge
      // never reaches the pending list, so the admin must be told here.
      push.notifyAutoApproveRecharge(db, approvedTx, approvedTx.user_id).catch(() => {});
      return approvedTx;
    }
    return null;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    safeLog('[sms] tryAutoMatchRecharge failed:', e.message);
    return null;
  } finally {
    client.release();
  }
}

// Auto (number-only) late submit: the SMS arrived BEFORE the user's
// auto request. Match an unmatched money-in SMS with the same amount,
// sender number and method family from the last 30 minutes.
async function tryAutoMatchBySender(tx) {
  if (!tx || !tx.id || tx.status !== 'pending' || !tx.sender_no) return null;
  const fam = String(tx.method || '').startsWith('bkash') ? 'bkash' : tx.method;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('recharge-credit'))");
    const r = await client.query(
      `SELECT * FROM incoming_sms
       WHERE matched_recharge_id IS NULL AND parse_status = 'parsed'
         AND trxid IS NOT NULL
         AND amount = $1 AND sender = $2 AND method = $3
         AND created_at >= NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 5
       FOR UPDATE`,
      [Number(tx.amount), String(tx.sender_no).trim(), fam]
    );
    // Never credit on an SMS that is not clearly money-in.
    const candidates = r.rows.filter(function (row) {
      const p = parseSms(row.raw_message, row.raw_sender);
      return p && p.direction === 'in';
    });
    const sms = candidates.length === 1 ? candidates[0] : null;
    const MAX_AUTO_APPROVE = Number(process.env.SMS_MAX_AUTO_APPROVE || 50000);
    if (!sms || Number(tx.amount) > MAX_AUTO_APPROVE) {
      await client.query('COMMIT');
      return null;
    }
    const approvedTx = await approveRechargeTx(client, tx.id, sms.id);
    await client.query('COMMIT');
    if (approvedTx) {
      await logActivity(null, 'sms.auto_match', {
        sms_id: sms.id, tx_id: approvedTx.id, user_id: approvedTx.user_id,
        amount: Number(approvedTx.amount), how: 'sender_late_submit', trxid: approvedTx.trxid,
      });
      wa.notifyRechargeApproved(db, approvedTx).catch(() => {});
      push.notifyUser(db, approvedTx.user_id, '✅ রিচার্জ সফল!',
        '৳' + approvedTx.amount + ' আপনার ওয়ালেটে যোগ হয়েছে।', '/wallet.html').catch(() => {});
      push.notifyAutoApproveRecharge(db, approvedTx, approvedTx.user_id).catch(() => {});
      return approvedTx;
    }
    return null;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    safeLog('[sms] tryAutoMatchBySender failed:', e.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { webhook, adminSms, tryAutoMatchRecharge, tryAutoMatchBySender, approveRechargeTx, holdRateLimitedSms };
