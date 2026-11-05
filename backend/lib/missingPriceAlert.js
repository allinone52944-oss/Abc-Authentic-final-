'use strict';

// Audit #17 — admin alert for an engine serving free because no
// active services row exists for its engine_id.
//
// The price-0 behaviour itself is a design decision (charge starts
// when a price is set) and is NOT changed here: an active row with
// price 0 is an explicit free service and never alerts. Only the
// MISSING row alerts — the wrong-engine_id case from audit #14
// (an admin rates the wrong engine_id and the service runs free
// forever with no signal).
//
// Throttled: at most once per engine_id per hour, so a busy engine
// cannot flood the admin push channel (same pattern as the fraud
// alerts in routes/user.js). Fire-and-forget: the alert must never
// fail or delay the request it was triggered from (notifyAdmins
// itself never throws either).
const push = require('../utils/push');

const ALERT_INTERVAL_MS = 3600e3;
const lastAlerted = new Map();

function alertMissingPrice(db, engineId) {
  if (!engineId) return;
  const now = Date.now();
  const last = lastAlerted.get(engineId);
  if (last && now - last < ALERT_INTERVAL_MS) return;
  lastAlerted.set(engineId, now);
  if (lastAlerted.size > 500) lastAlerted.clear();
  try {
    const p = push.notifyAdmins(
      db,
      '⚠️ দাম ছাড়া সেবা চলছে: ' + engineId,
      'এই ইঞ্জিনের জন্য services টেবিলে কোনো সক্রিয় দাম নেই — সেবাটি ফ্রি চলছে। অ্যাডমিনে গিয়ে সঠিক engine_id-তে দাম বসান।',
      '/admin.html'
    );
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    // never fail the request the alert was triggered from
  }
}

module.exports = { alertMissingPrice, _resetForTests: () => lastAlerted.clear() };
