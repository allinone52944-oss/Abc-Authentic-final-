// ============================================================
// All In One (Abc Authentic) - Web Push client
// Sends push notifications to admin devices (sound + vibration
// even when the mobile screen is off) via the Web Push protocol.
// Config from env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// Subscriptions live in the push_subscriptions table (per user).
// Never throws to callers: all entry points return { ok, error }
// or resolve silently. Dead (410/404) endpoints are pruned.
// ============================================================
const { safeLog } = require('../security');

let webpush = null;
let configured = null;

function getWebpush() {
  if (webpush) return webpush;
  try {
    // eslint-disable-next-line global-require
    webpush = require('web-push');
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) {
      safeLog('[push] VAPID keys missing — push disabled');
      webpush = null;
      return null;
    }
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@abc-authentic.store',
      pub,
      priv
    );
    return webpush;
  } catch (e) {
    safeLog('[push] web-push unavailable:', e.message);
    return null;
  }
}

function isConfigured() {
  if (configured === null) configured = !!getWebpush();
  return configured;
}

function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

// Save (upsert) a subscription for a user. Never throws.
// M-6 fix (2026-10-15): endpoint URL validated (https only); the upsert can
// only refresh a row the SAME user already owns — it can no longer re-assign
// someone else's endpoint (ON CONFLICT ... WHERE user_id matches).
async function saveSubscription(db, userId, sub) {
  try {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return { ok: false, error: 'INVALID_SUBSCRIPTION' };
    }
    let url;
    try { url = new URL(String(sub.endpoint)); } catch (e) { url = null; }
    if (!url || url.protocol !== 'https:') {
      return { ok: false, error: 'INVALID_ENDPOINT' };
    }
    if (String(sub.keys.p256dh).length > 200 || String(sub.keys.auth).length > 100) {
      return { ok: false, error: 'INVALID_SUBSCRIPTION' };
    }
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
       WHERE push_subscriptions.user_id = EXCLUDED.user_id`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    return { ok: true };
  } catch (e) {
    safeLog('[push] saveSubscription failed:', e.message);
    return { ok: false, error: 'SAVE_FAILED' };
  }
}

// Remove a subscription by endpoint + owner. Never throws.
async function removeSubscription(db, endpoint, userId) {
  try {
    if (!endpoint) return { ok: false, error: 'MISSING_ENDPOINT' };
    if (!userId) return { ok: false, error: 'MISSING_USER' };
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
    return { ok: true };
  } catch (e) {
    safeLog('[push] removeSubscription failed:', e.message);
    return { ok: false, error: 'DELETE_FAILED' };
  }
}

// Low-level: push a JSON payload to a list of subscription rows.
// Prunes dead endpoints (410 Gone / 404 Not Found). Never throws.
async function pushToSubscriptions(db, subs, payload) {
  const wp = getWebpush();
  if (!wp) return { ok: false, error: 'NOT_CONFIGURED' };
  if (!subs || !subs.length) return { ok: true, sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await wp.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 86400, urgency: 'high' }
        );
        sent += 1;
      } catch (e) {
        if (e && (e.statusCode === 410 || e.statusCode === 404)) {
          dead.push(s.endpoint);
        } else {
          safeLog('[push] send failed:', e && e.message);
        }
      }
    })
  );
  // Prune dead endpoints so future sends stay clean
  for (const ep of dead) {
    try {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [ep]);
    } catch (e) { /* best effort */ }
  }
  return { ok: true, sent };
}

// Notify ALL admin-role users' devices. Never throws.
async function notifyAdmins(db, title, body, url) {
  try {
    const r = await db.query(
      `SELECT ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.role = 'admin' AND u.status = 'active'`
    );
    if (!r.rows.length) return { ok: true, sent: 0 };
    return await pushToSubscriptions(db, r.rows, { title, body, url: url || '/admin.html' });
  } catch (e) {
    safeLog('[push] notifyAdmins failed:', e.message);
    return { ok: false, error: 'FAILED' };
  }
}

// ---- High-level event notifiers (Bengali, fire-and-forget) ----
// Each takes IDs and resolves display names inside the promise so
// route handlers stay fast (the caller does `.catch(()=>{})`).

async function userLabel(db, userId) {
  try {
    const r = await db.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
    if (!r.rows.length) return '—';
    return r.rows[0].name || r.rows[0].phone || '—';
  } catch (e) { return '—'; }
}

async function notifyNewOrder(db, order, serviceName, userId) {
  try {
    const shortId = String(order.id || '').slice(0, 8).toUpperCase();
    const uname = await userLabel(db, userId);
    return await notifyAdmins(
      db,
      '🔔 নতুন অর্ডার!',
      `অর্ডার #${shortId} — ${serviceName || 'সেবা'} (গ্রাহক: ${uname})`,
      '/admin.html'
    );
  } catch (e) {
    safeLog('[push] notifyNewOrder failed:', e.message);
    return { ok: false };
  }
}

async function notifyNewRecharge(db, tx, userId) {
  try {
    const uname = await userLabel(db, userId);
    return await notifyAdmins(
      db,
      '💰 নতুন রিচার্জ রিকোয়েস্ট!',
      `৳${Number(tx.amount || 0).toLocaleString('bn-BD')} — ${uname} (TrxID: ${tx.trxid || '—'})`,
      '/admin.html'
    );
  } catch (e) {
    safeLog('[push] notifyNewRecharge failed:', e.message);
    return { ok: false };
  }
}

async function notifyNewUser(db, user) {  try {
    return await notifyAdmins(
      db,
      '👤 নতুন ইউজার!',
      `${user.name || user.phone || 'নতুন গ্রাহক'} রেজিস্টার করেছেন`,
      '/admin.html'
    );
  } catch (e) {
    safeLog('[push] notifyNewUser failed:', e.message);
    return { ok: false };
  }
}

// M-14 fix (2026-10-15): user chat message → admin push notification (with name, per SPEC).
async function notifyNewChatMessage(db, orderId, userId, message) {
  try {
    const uname = await userLabel(db, userId);
    const shortId = String(orderId || '').slice(0, 8).toUpperCase();
    const preview = String(message || '').slice(0, 80);
    return await notifyAdmins(
      db,
      '💬 নতুন মেসেজ!',
      `অর্ডার #${shortId} — ${uname}: ${preview}`,
      '/admin.html'
    );
  } catch (e) {
    safeLog('[push] notifyNewChatMessage failed:', e.message);
    return { ok: false };
  }
}

module.exports = {
  isConfigured,
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  pushToSubscriptions,
  notifyAdmins,
  notifyNewOrder,
  notifyNewRecharge,
  notifyNewUser,
  notifyNewChatMessage,
};
