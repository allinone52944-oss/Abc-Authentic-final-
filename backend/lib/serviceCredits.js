'use strict';

// Service-locked credits (owner rule, 2026-10-21).
//
// Money that comes from a service-scoped coupon — or from cashback
// while the admin scoped cashback to one service — must be spendable
// ONLY on that service. It NEVER merges into the spend-anywhere
// wallet balance (users.balance). It is held in `service_credits`
// and consumed — first, before balance — only when the user pays
// for that exact service (order create, bdris-apply charge, NID
// charge). Paying for any other service cannot touch it.
//
// All functions take a transaction client; callers wrap with
// db.withTransaction so credit consumption, ledger rows and the
// balance debit commit or roll back together.

async function addServiceCredit(client, { userId, serviceId, amount, source, ref, expiresAt }) {
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (!userId || !serviceId || !(amt > 0)) return null;
  const r = await client.query(
    `INSERT INTO service_credits (user_id, service_id, source, ref, amount, remaining, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6)
     ON CONFLICT (ref) DO NOTHING
     RETURNING id`,
    [userId, serviceId, source || 'coupon', ref || null, amt, expiresAt || null]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

async function lockedCreditRows(client, userId, serviceId) {
  const r = await client.query(
    `SELECT id, remaining FROM service_credits
      WHERE user_id = $1 AND service_id = $2 AND remaining > 0
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at ASC
      FOR UPDATE`,
    [userId, serviceId]
  );
  return r.rows;
}

async function availableFor(client, userId, serviceId) {
  if (!serviceId) return 0;
  const r = await client.query(
    `SELECT COALESCE(SUM(remaining), 0) AS s FROM service_credits
      WHERE user_id = $1 AND service_id = $2 AND remaining > 0
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId, serviceId]
  );
  return Number((r.rows[0] && r.rows[0].s) || 0) || 0;
}

// Pay `amount` for `serviceId`: locked credit for this service is
// consumed first (FIFO), the rest comes out of the wallet balance
// via wallet_apply. Throws INSUFFICIENT_BALANCE / DUPLICATE_TRANSACTION
// / USER_NOT_FOUND with those exact words (callers already map them).
async function payForService(client, { userId, serviceId, amount, ref }) {
  const amt = Math.round(Math.abs(Number(amount) || 0) * 100) / 100;
  if (!(amt > 0)) return { paidFromCredit: 0, paidFromBalance: 0, newBalance: null };

  // Idempotency, mirroring wallet_apply: the same payment ref —
  // balance part OR credit part — must never be applied twice.
  if (ref) {
    const dup = await client.query(
      `SELECT 1 FROM transactions
        WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved' LIMIT 1`,
      [userId, ref, ref + ':svc']
    );
    if (dup.rows.length) throw new Error('DUPLICATE_TRANSACTION');
  }

  // Lock the user row first — the same lock order as wallet_apply.
  const u = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!u.rows.length) throw new Error('USER_NOT_FOUND');
  const balance = Number(u.rows[0].balance);

  let rows = [];
  let creditAvail = 0;
  if (serviceId) {
    rows = await lockedCreditRows(client, userId, serviceId);
    creditAvail = rows.reduce((s, r) => s + Number(r.remaining), 0);
  }
  const fromCredit = Math.min(creditAvail, amt);
  const fromBalance = Math.round((amt - fromCredit) * 100) / 100;
  if (balance < fromBalance) throw new Error('INSUFFICIENT_BALANCE');

  if (fromCredit > 0) {
    let left = fromCredit;
    for (const row of rows) {
      if (left <= 0) break;
      const take = Math.min(Number(row.remaining), left);
      if (take > 0) {
        await client.query(
          'UPDATE service_credits SET remaining = remaining - $1 WHERE id = $2',
          [take, row.id]
        );
        left = Math.round((left - take) * 100) / 100;
      }
    }
    // Ledger row for the credit part. users.balance is NOT touched
    // for this part — the row exists so the spend is visible in the
    // user's transaction history.
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, trxid, status)
       VALUES ($1, 'debit', $2, $3, 'approved')`,
      [userId, -fromCredit, (ref || 'svc-pay') + ':svc']
    );
  }

  let newBalance = balance;
  if (fromBalance > 0) {
    const w = await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
      userId, -fromBalance, 'debit', ref,
    ]);
    newBalance = Number(w.rows[0].new_balance);
  }
  return { paidFromCredit: fromCredit, paidFromBalance: fromBalance, newBalance };
}

// ---- Proportional refunds (admin-order fix, 2026-11-03) ----------
//
// A charge paid partly from service-locked credit and partly from the
// wallet balance must refund the same way: the credit part back to
// service_credits, the balance part back to users.balance. Refunding
// everything to the balance would widen the spending scope of locked
// money (the lock exists precisely to prevent that).
//
// The charge split is NOT stored on the order row, so it is rebuilt
// from the transactions ledger: payForService writes a balance debit
// under the charge ref and, when credit was used, a credit debit
// under ref + ':svc'. Candidate refs, in order (every format below
// is proven in code — no format is guessed):
//   - POST /api/orders: 'order-' + idempotency_key + '-' + userId
//     (user.js order create; idempotency_key IS the client key)
//   - charge gate: engineId + '-' + attemptKey, where the order's
//     idempotency_key is engineId + ':' + attemptKey
//     (engineChargeGate.js orderKeyOf/txRefOf)
//   - land.js: ref 'land-' + mode + '-' + idem, order key IS idem.
//     The mode is NOT stored on the order row, so all four modes
//     (search/scan/verify/mouza) are tried; the ledger-agreement
//     check below rejects a wrong mode. The same formula covers a
//     client-supplied idem AND an auto idem ('land-' + mode + '-'
//     + uuid, land.js idemOf), where the real ref carries the mode
//     twice ('land-<mode>-land-<mode>-<uuid>').
//   - nid.js: order key 'nid-' + jobId, ref 'nid-card-' + jobId.
//   - nid-server-copy.js: the order key IS the ref
//     ('nidsc-' + jobId + '-' + kind) — it is inserted as the
//     order's idempotency_key, so the key itself is the candidate.
//   - qr-verify.js: order key IS idem, ref 'qr-verify-' + idem.
// Other charges (e.g. bdris-apply, which records no order row) use
// refs that cannot be rebuilt from the order row alone. When no
// candidate matches the ledger reliably, the whole price refunds
// to the balance (the old behaviour) — NEVER invent credit from a
// guess.
//
// All queries run on the caller's transaction client, so the credit
// restore, the balance credit and the caller's own status/delete
// write commit or roll back together. DUPLICATE_TRANSACTION on the
// balance leg means a concurrent refund already landed the money —
// that counts as success, not failure (the same rule as the status
// endpoint: never report 200 + refunded for money that never moved,
// and never fail a refund whose money already arrived).
async function reconstructChargeSplit(client, userId, order) {
  const price = Math.round((Number(order.price) || 0) * 100) / 100;
  const key = order.idempotency_key ? String(order.idempotency_key) : '';
  if (!key || !(price > 0)) return null;
  const candidates = ['order-' + key + '-' + userId];
  // bdris-apply: the order records its submit-charge ref in data
  // (bug-hunt F3) — the ref carries the client key, so it cannot
  // be rebuilt from the order key alone. It is the most specific
  // candidate, so it is tried first; the ledger-agreement check
  // below still rejects it if the recorded price does not match
  // the real charge (e.g. an order priced before this fix).
  let chargeRef = null;
  try {
    const d = typeof order.data === 'string' ? JSON.parse(order.data) : order.data;
    if (d && typeof d.charge_ref === 'string' && d.charge_ref) chargeRef = d.charge_ref;
  } catch (e) { /* no usable charge ref */ }
  if (chargeRef) candidates.unshift(chargeRef);
  const colon = key.indexOf(':');
  if (colon > 0) candidates.push(key.slice(0, colon) + '-' + key.slice(colon + 1));
  // land.js: mode unknown from the row alone — try all four.
  for (const mode of ['search', 'scan', 'verify', 'mouza']) {
    candidates.push('land-' + mode + '-' + key);
  }
  // nid.js: 'nid-' + jobId → 'nid-card-' + jobId.
  if (key.startsWith('nid-')) candidates.push('nid-card-' + key.slice(4));
  // nid-server-copy.js: the key IS the ref.
  if (key.startsWith('nidsc-')) candidates.push(key);
  // qr-verify.js: key IS idem → 'qr-verify-' + idem.
  candidates.push('qr-verify-' + key);
  for (const ref of candidates) {
    const r = await client.query(
      `SELECT trxid, amount FROM transactions
        WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved'`,
      [userId, ref, ref + ':svc']
    );
    const svc = r.rows.find((x) => x.trxid === ref + ':svc');
    const bal = r.rows.find((x) => x.trxid === ref);
    if (!svc && !bal) continue;
    const creditPart = svc ? Math.round(Math.abs(Number(svc.amount)) * 100) / 100 : 0;
    if (creditPart < 0 || creditPart > price) continue;
    const balancePart = Math.round((price - creditPart) * 100) / 100;
    // If a balance leg exists it must agree with the split; a
    // mismatch means this candidate is not this order's charge.
    if (bal && Math.abs(Math.abs(Number(bal.amount)) - balancePart) > 0.01) continue;
    return { creditPart, balancePart };
  }
  return null;
}

// Restore only into non-expiring credit rows; remainder becomes a
// service-scoped permanent refund so another offer cannot expire it.
async function restoreServiceCredit(client, userId, serviceId, amount, refKey) {
  let left = Math.round((Number(amount) || 0) * 100) / 100;
  if (!(left > 0)) return;
  const rows = await client.query(
    `SELECT id, amount, remaining FROM service_credits
      WHERE user_id = $1 AND service_id = $2 AND remaining < amount
        AND expires_at IS NULL
      ORDER BY created_at ASC
      FOR UPDATE`,
    [userId, serviceId]
  );
  for (const row of rows.rows) {
    if (!(left > 0)) break;
    const headroom = Math.round((Number(row.amount) - Number(row.remaining)) * 100) / 100;
    if (!(headroom > 0)) continue;
    const add = Math.min(headroom, left);
    await client.query(
      'UPDATE service_credits SET remaining = remaining + $1 WHERE id = $2',
      [add, row.id]
    );
    left = Math.round((left - add) * 100) / 100;
  }
  if (left > 0) {
    await client.query(
      `INSERT INTO service_credits (user_id, service_id, source, ref, amount, remaining, expires_at)
       VALUES ($1, $2, 'refund', $3, $4, $4, NULL)
       ON CONFLICT (ref) DO NOTHING`,
      [userId, serviceId, refKey, left]
    );
  }
}

// Refund one order's price through `client` (caller's transaction).
// refPrefix: 'refund' (status refund) or 'refund-del' (delete refund),
// matching the wallet_apply refs the old code used. Returns the split
// actually refunded. Throws on any non-duplicate failure so the
// caller's transaction rolls back — the order must never flip to
// refunded (or disappear) while the money never moved.
async function refundOrderPrice(client, order, refPrefix) {
  const price = Math.round((Number(order.price) || 0) * 100) / 100;
  if (!(price > 0)) return { refunded: false, creditPart: 0, balancePart: 0 };
  const split = await reconstructChargeSplit(client, order.user_id, order);
  const creditPart = split ? split.creditPart : 0;
  const balancePart = split ? split.balancePart : price;
  if (creditPart > 0 && order.service_id) {
    await restoreServiceCredit(
      client, order.user_id, order.service_id, creditPart,
      (refPrefix || 'refund') + '-' + order.id
    );
  }
  // Auto-refund guard completeness (2026-11-03, stricter): EVERY
  // refund at price > 0 must leave an approved refund-<id> (or
  // refund-del-<id>) transaction row — even a credit-only refund
  // whose balance part is 0. wallet_apply(0) inserts a 0-amount
  // approved row (balance untouched), and that row is the marker
  // hasPriorRefund() checks. Without it, a credit-only refund
  // restored purely into headroom would leave NO trace, and a
  // later refund could double-restore the same credit.
  try {
    await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
      order.user_id, balancePart, 'refund', (refPrefix || 'refund') + '-' + order.id,
    ]);
  } catch (e) {
    if (/DUPLICATE_TRANSACTION/.test(e.message)) {
      // A concurrent refund already credited the balance leg once.
      // The money is there; do not fail the refund for it.
    } else {
      throw e;
    }
  }
  return { refunded: true, creditPart, balancePart };
}

// ---- Hold release (audit #9, QR double-fee trap) -----------------
//
// A hold is a charge taken BEFORE the risky step (the QR gateway
// call, up to 120s) under the attempt's idempotency ref, via
// payForService. If the step then fails, the hold is released here:
// the exact split the hold consumed (locked credit first, then
// wallet balance) is read back from the ledger and returned, so a
// failed verification costs ৳0 net. Idempotent: a release writes
// an approved 'release-'+ref marker row (via wallet_apply, even
// for a credit-only hold), and a second release returns early
// when that marker exists — so the credit leg can never restore
// twice (bug-hunt F2). All queries run on the caller's
// transaction client, so the credit restore, the balance credit
// and the caller's own writes commit or roll back together.
async function releaseHold(client, { userId, serviceId, ref }) {
  if (!ref) return { released: false, creditPart: 0, balancePart: 0 };
  // Bug-hunt F2 — a second release must be a TRUE no-op. The old
  // comment claimed it was, but only the balance leg was
  // protected (wallet_apply dedupes on the 'release-'+ref trxid).
  // The credit leg was not: when the first release already
  // restored the consumed rows to full, restoreServiceCredit
  // minted a FRESH service_credits row — creating locked credit
  // from nothing. The release marker row (approved
  // 'release-'+ref, written by wallet_apply on every release,
  // including a 0-amount marker for a credit-only hold) is the
  // proof a release already completed — return early when it
  // exists. (The marker is written in the same transaction as
  // the restore, so it exists exactly when a release committed.)
  const prior = await client.query(
    `SELECT 1 FROM transactions WHERE user_id = $1 AND trxid = $2 AND status = 'approved' LIMIT 1`,
    [userId, 'release-' + ref]
  );
  if (prior.rows.length) return { released: false, creditPart: 0, balancePart: 0 };
  const r = await client.query(
    `SELECT trxid, amount FROM transactions
      WHERE user_id = $1 AND trxid IN ($2, $3) AND status = 'approved'`,
    [userId, ref, ref + ':svc']
  );
  const svc = r.rows.find((x) => x.trxid === ref + ':svc');
  const bal = r.rows.find((x) => x.trxid === ref);
  const creditPart = svc ? Math.round(Math.abs(Number(svc.amount)) * 100) / 100 : 0;
  const balancePart = bal ? Math.round(Math.abs(Number(bal.amount)) * 100) / 100 : 0;
  if (creditPart <= 0 && balancePart <= 0) return { released: false, creditPart: 0, balancePart: 0 };
  if (creditPart > 0 && serviceId) {
    await restoreServiceCredit(client, userId, serviceId, creditPart, 'release-' + ref);
  }
  // Balance leg (plus a zero-amount marker row for a credit-only
  // hold, so the release always leaves an audit trace — same rule
  // as refundOrderPrice's zero-balance leg).
  try {
    await client.query('SELECT * FROM wallet_apply($1, $2, $3, $4)', [
      userId, balancePart, 'refund', 'release-' + ref,
    ]);
  } catch (e) {
    if (!/DUPLICATE_TRANSACTION/.test(e.message)) throw e;
    // A concurrent release already credited the balance leg once.
  }
  return { released: true, creditPart, balancePart };
}

module.exports = {
  addServiceCredit, availableFor, payForService, lockedCreditRows,
  refundOrderPrice, reconstructChargeSplit, releaseHold,
};
