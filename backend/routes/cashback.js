// ============================================================
// All In One (Abc Authentic) - Daily Cashback routes
// - Cashback % comes from settings: cashback = {enabled, percent}
// - "Today" = Asia/Dhaka date (user's day, not UTC)
// - Only APPROVED recharges count toward today's total
// - One redeem per user per day (UNIQUE user_id, day) — idempotent
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
const DHARAKA_TODAY_TX_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS total
  FROM transactions
  WHERE user_id = $1
    AND type = 'recharge'
    AND status = 'approved'
    AND DATE((created_at AT TIME ZONE 'Asia/Dhaka')) = ${DHARAKA_DAY_SQL}`;

async function cashbackConfig(client) {
  const q = client.query || db.query.bind(db);
  const r = await q(`SELECT value FROM settings WHERE key = 'cashback' LIMIT 1`);
  const v = (r.rows[0] && r.rows[0].value) || {};
  return {
    enabled: !!v.enabled,
    percent: Number(v.percent) || 0,
  };
}

function makeCouponCode(dayStr) {
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'CB-' + dayStr.replace(/-/g, '') + '-' + rand;
}

// GET /api/cashback/today — today's status for this user
router.get('/today', async (req, res) => {
  try {
    const cfg = await cashbackConfig(db);
    const t = await db.query(DHARAKA_TODAY_TX_SQL, [req.user.id]);
    const rechargeTotal = Number(t.rows[0].total) || 0;
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

      const t = await client.query(
        DHARAKA_TODAY_TX_SQL.replace(DHARAKA_DAY_SQL, '$2::date'),
        [req.user.id, dayStr]
      );
      const rechargeTotal = Number(t.rows[0].total) || 0;
      const amount = cfg.enabled && cfg.percent > 0 && rechargeTotal > 0
        ? Math.floor(rechargeTotal * cfg.percent / 100 * 100) / 100
        : 0;
      if (amount <= 0) {
        const err = new Error('NOTHING_TO_REDEEM');
        err.statusCode = 400;
        throw err;
      }

      const couponCode = makeCouponCode(dayStr);
      // Record redemption (unique constraint = second idempotency net)
      const ins = await client.query(
        `INSERT INTO daily_cashback_redemptions
           (user_id, day, recharge_total, percent, amount, coupon_code)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         ON CONFLICT (user_id, day) DO NOTHING
         RETURNING *`,
        [req.user.id, dayStr, rechargeTotal, cfg.percent, amount, couponCode]
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

module.exports = router;
