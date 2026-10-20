// ============================================================
// All In One (Abc Authentic) - Daily Cashback routes
// - Cashback % comes from settings: cashback = {enabled, percent}
// - "Today" = Asia/Dhaka date (user's day, not UTC)
// - ONE claim per user per day (UNIQUE user_id, day) — idempotent
// - STRICTLY same-day (owner rule, corrected 2026-10-21): a claim
//   covers the day's APPROVED recharges up to the moment of the
//   claim, combined into one total — however many recharges that
//   is. No carry-over: a day not claimed is forfeited, and a
//   recharge can never be claimed on a later day. Claimed recharge
//   ids are stored on the redemption row (recharge_ids, migration
//   031) so the same recharge can never ALSO mint a per-recharge
//   coupon (POST /generate guard), and recharges that already have
//   a per-recharge coupon are excluded from the day's total.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');

const router = express.Router();
router.use(requireAuth);

// Dhaka "today" as DATE
const DHARAKA_DAY_SQL = `DATE((NOW() AT TIME ZONE 'Asia/Dhaka'))`;
// The day's claimable recharges: approved TODAY (Asia/Dhaka), no
// per-recharge coupon, and not already inside today's claim.
const UNCLAIMED_WHERE = `
    user_id = $1
    AND type = 'recharge'
    AND status = 'approved'
    AND DATE((created_at AT TIME ZONE 'Asia/Dhaka')) = ${DHARAKA_DAY_SQL}
    AND NOT EXISTS (SELECT 1 FROM coupons c WHERE c.recharge_id = transactions.id)
    AND NOT EXISTS (
      SELECT 1 FROM daily_cashback_redemptions r
      WHERE r.user_id = $1
        AND r.recharge_ids @> jsonb_build_array(transactions.id::text)
    )`;
const UNCLAIMED_TOTAL_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS cnt
  FROM transactions
  WHERE ${UNCLAIMED_WHERE}`;
const UNCLAIMED_LIST_SQL = `
  SELECT id, amount
  FROM transactions
  WHERE ${UNCLAIMED_WHERE}
  ORDER BY created_at ASC`;

async function cashbackConfig(client) {
  const runner = client && typeof client.query === 'function' ? client : db;
  const r = await runner.query(`SELECT value FROM settings WHERE key = 'cashback' LIMIT 1`);
  const v = (r.rows[0] && r.rows[0].value) || {};
  return {
    enabled: !!v.enabled,
    percent: Number(v.percent) || 0,
    expiry_days: Number(v.expiry_days) || 30,
    service_id: (typeof v.service_id === 'string' && v.service_id.trim().length === 36) ? v.service_id.trim() : null,
  };
}

function makeCouponCode(dayStr) {
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'CB-' + dayStr.replace(/-/g, '') + '-' + rand;
}

// GET /api/cashback/today — claim status for this user:
// what today's claim would pay (today's approved recharges combined),
// and whether today's one claim is still available.
router.get('/today', async (req, res) => {
  try {
    const cfg = await cashbackConfig(db);
    const t = await db.query(UNCLAIMED_TOTAL_SQL, [req.user.id]);
    const rechargeTotal = Number(t.rows[0].total) || 0;
    const rechargeCount = Number(t.rows[0].cnt) || 0;
    const amount = cfg.enabled && cfg.percent > 0 && rechargeTotal > 0
      ? Math.floor(rechargeTotal * cfg.percent / 100 * 100) / 100
      : 0;
    const red = await db.query(
      `SELECT id, coupon_code, amount FROM daily_cashback_redemptions
       WHERE user_id = $1 AND day = ${DHARAKA_DAY_SQL} LIMIT 1`,
      [req.user.id]
    );
    const already = red.rows.length > 0;
    res.json({
      ok: true,
      recharge_total: rechargeTotal,
      recharge_count: rechargeCount,
      percent: cfg.percent,
      enabled: cfg.enabled,
      cashback_amount: amount,
      already_redeemed: already,
      can_redeem: !already && amount > 0,
      coupon_code: already ? red.rows[0].coupon_code : null,
    });
  } catch (e) {
    safeLog('[cashback] today error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/cashback/redeem — one per day, atomic + idempotent
router.post('/redeem', async (req, res) => {
  try {
    const out = await db.withTransaction(async (client) => {
      const cfg = await cashbackConfig(client);

      // Already redeemed today? (unique guard — double-click safe)
      const dayRow = await client.query(`SELECT TO_CHAR(${DHARAKA_DAY_SQL}, 'YYYY-MM-DD') AS d`);
      const dayStr = dayRow.rows[0].d; // 'YYYY-MM-DD'
      const exist = await client.query(
        `SELECT id FROM daily_cashback_redemptions WHERE user_id = $1 AND day = $2::date LIMIT 1`,
        [req.user.id, dayStr]
      );
      if (exist.rows.length) {
        const err = new Error('ALREADY_REDEEMED_TODAY');
        err.statusCode = 409;
        throw err;
      }

      // Lock today's claimable recharges and take the combined
      // total — one claim per day, however many recharges it covers.
      const list = await client.query(UNCLAIMED_LIST_SQL + ' FOR UPDATE', [req.user.id]);
      const rechargeIds = list.rows.map((x) => String(x.id));
      const rechargeTotal = list.rows.reduce((sum, x) => sum + Number(x.amount || 0), 0);
      const amount = cfg.enabled && cfg.percent > 0 && rechargeTotal > 0
        ? Math.floor(rechargeTotal * cfg.percent / 100 * 100) / 100
        : 0;
      if (amount <= 0) {
        const err = new Error('NOTHING_TO_REDEEM');
        err.statusCode = 400;
        throw err;
      }

      const couponCode = makeCouponCode(dayStr);
      // Record redemption (unique constraint = second idempotency net).
      // recharge_ids freezes exactly which recharges this claim covered.
      const ins = await client.query(
        `INSERT INTO daily_cashback_redemptions
           (user_id, day, recharge_total, percent, amount, coupon_code, recharge_ids)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (user_id, day) DO NOTHING
         RETURNING *`,
        [req.user.id, dayStr, rechargeTotal, cfg.percent, amount, couponCode, JSON.stringify(rechargeIds)]
      );
      if (!ins.rows.length) {
        const err = new Error('ALREADY_REDEEMED_TODAY');
        err.statusCode = 409;
        throw err;
      }
      // Credit wallet atomically (idempotent ref)
      await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
        req.user.id, amount, 'cashback', 'daily-cashback-' + couponCode,
      ]);
      return ins.rows[0];
    });

    const bal = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({
      ok: true,
      coupon_code: out.coupon_code,
      amount: Number(out.amount),
      recharge_total: Number(out.recharge_total),
      percent: Number(out.percent),
      balance: Number(bal.rows[0].balance),
    });
  } catch (e) {
    safeLog('[cashback] redeem error:', e.message);
    if (e.statusCode === 409) return res.status(409).json({ error: 'ALREADY_REDEEMED_TODAY' });
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'FAILED' });
  }
});

// ============================================================
// POST /api/cashback/generate — Per-recharge coupon (user spec 2026-10-16)
// - User recharges → clicks "Coupon Create" → generates coupon
// - Amount = recharge_amount × admin_percent
// - Admin sets: percent, expiry days, allowed service_id
// ============================================================
router.post('/generate', async (req, res) => {
  try {
    const { recharge_id } = req.body || {};
    if (!recharge_id) return res.status(400).json({ error: 'MISSING_RECHARGE' });

    const out = await db.withTransaction(async (client) => {
      // Get the recharge (must be approved and belong to user)
      const rc = await client.query(
        `SELECT id, amount, user_id,
                TO_CHAR(DATE(created_at AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM-DD') AS day
         FROM transactions
         WHERE id = $1 AND user_id = $2 AND type = 'recharge' AND status = 'approved'
         LIMIT 1 FOR UPDATE`,
        [recharge_id, req.user.id]
      );
      if (!rc.rows.length) {
        const err = new Error('INVALID_RECHARGE');
        err.statusCode = 400;
        throw err;
      }

      // Already generated for this recharge? (one coupon per recharge)
      const exist = await client.query(
        `SELECT id FROM coupons WHERE recharge_id = $1 LIMIT 1`,
        [recharge_id]
      );
      if (exist.rows.length) {
        const err = new Error('ALREADY_GENERATED');
        err.statusCode = 409;
        throw err;
      }

      // Same recharge must not earn cashback twice (daily claim + coupon).
      // Primary check: the recharge is already covered by a daily claim
      // (recharge_ids, migration 031). Legacy check: a daily redemption
      // exists for the recharge's own day (pre-031 claims store no ids).
      const claimed = await client.query(
        `SELECT id FROM daily_cashback_redemptions
         WHERE user_id = $1 AND recharge_ids @> jsonb_build_array($2::text) LIMIT 1`,
        [req.user.id, String(recharge_id)]
      );
      if (claimed.rows.length) {
        const err = new Error('ALREADY_GENERATED');
        err.statusCode = 409;
        throw err;
      }
      if (rc.rows[0].day) {
        const daily = await client.query(
          `SELECT id FROM daily_cashback_redemptions WHERE user_id = $1 AND day = $2::date LIMIT 1`,
          [req.user.id, rc.rows[0].day]
        );
        if (daily.rows.length) {
          const err = new Error('ALREADY_GENERATED');
          err.statusCode = 409;
          throw err;
        }
      }

      const cfg = await cashbackConfig(client);
      if (!cfg.enabled || cfg.percent <= 0) {
        const err = new Error('CASHBACK_DISABLED');
        err.statusCode = 400;
        throw err;
      }

      const rechargeAmount = Number(rc.rows[0].amount);
      const amount = Math.floor(rechargeAmount * cfg.percent / 100 * 100) / 100;
      if (amount <= 0) {
        const err = new Error('NOTHING_TO_GENERATE');
        err.statusCode = 400;
        throw err;
      }

      // Expiry from settings (default 30 days)
      const expiryDays = Number(cfg.expiry_days) || 30;
      const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

      const code = 'CB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const ins = await client.query(
        `INSERT INTO coupons (code, type, percent, amount, service_id, user_id, expires_at, recharge_id, notes)
         VALUES ($1, 'cashback', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [code, cfg.percent, amount, cfg.service_id || null,
         req.user.id, expiresAt.toISOString(), recharge_id, 'recharge:' + recharge_id]
      );
      return ins.rows[0];
    });

    res.status(201).json({
      ok: true,
      coupon: {
        id: out.id,
        code: out.code,
        amount: Number(out.amount),
        percent: Number(out.percent),
        expires_at: out.expires_at,
        service_id: out.service_id,
      },
    });
  } catch (e) {
    safeLog('[cashback] generate error:', e.message);
    if (e.statusCode === 409) return res.status(409).json({ error: 'ALREADY_GENERATED', message: e.message });
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, message: e.message });
    res.status(500).json({ error: 'FAILED', message: e.message });
  }
});

module.exports = router;
