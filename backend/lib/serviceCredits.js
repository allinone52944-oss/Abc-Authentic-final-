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

module.exports = { addServiceCredit, availableFor, payForService, lockedCreditRows };
