// ============================================================
// All In One (Abc Authentic) - Web Push subscription routes
// Mounted at /api/push.
// ============================================================
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { safeLog } = require('../security');
const push = require('../utils/push');

const router = express.Router();

// GET /api/push/vapid-public-key — public (needed before login to subscribe)
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.vapidPublicKey() });
});

// POST /api/push/subscribe — save current user's subscription (auth)
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    // First-ever subscription for this user? Captured BEFORE the
    // save so a welcome push goes out exactly once (when the
    // customer first turns notifications on — at registration
    // time they have no subscription to reach).
    const before = await db.query(
      'SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE user_id = $1',
      [req.user.id]
    );
    const firstEver = !before.rows.length || Number(before.rows[0].c) === 0;
    const r = await push.saveSubscription(db, req.user.id, req.body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    if (firstEver) {
      push.notifyUser(db, req.user.id, '👋 Abc Authentic-এ স্বাগতম!',
        'নোটিফিকেশন চালু হয়েছে — এখন থেকে সব সেবার ফলাফল সঙ্গে সঙ্গে এখানেই পাবেন।', '/dashboard.html').catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    safeLog('[push] subscribe route error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// POST /api/push/unsubscribe — remove by endpoint (auth)
router.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const r = await push.removeSubscription(db, req.body && req.body.endpoint, req.user.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (e) {
    safeLog('[push] unsubscribe route error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

// GET /api/push/status — does current user have any subscription? (auth)
router.get('/status', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT COUNT(*) FROM push_subscriptions WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ subscribed: parseInt(r.rows[0].count, 10) > 0 });
  } catch (e) {
    safeLog('[push] status route error:', e.message);
    res.status(500).json({ error: 'FAILED' });
  }
});

module.exports = router;
