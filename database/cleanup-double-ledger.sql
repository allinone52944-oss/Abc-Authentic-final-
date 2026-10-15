-- Double-ledger cleanup (C-4 historical rows) — RUN ON ORACLE MANUALLY
-- 1. First run ONLY the diagnostic (read-only) and inspect the rows.
-- 2. If the duplicates are confirmed as C-4 double-approves, run the DELETE.
-- 3. The DELETE keeps the EARLIEST approved row per (user_id, trxid).
--
-- Usage: psql "$DATABASE_URL" -f cleanup-double-ledger.sql
--    (or paste the diagnostic part into psql interactively)

-- ============ STEP 1: DIAGNOSTIC (read-only) ============
SELECT user_id, trxid, COUNT(*) AS n,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at,
       SUM(amount) AS total_amount
FROM transactions
WHERE status = 'approved' AND type = 'recharge' AND trxid IS NOT NULL
GROUP BY user_id, trxid
HAVING COUNT(*) > 1
ORDER BY last_at DESC;

-- ============ STEP 2: DELETE (keeps earliest per group) ============
-- UNCOMMENT TO RUN after reviewing step 1:
--
-- DELETE FROM transactions a
-- USING transactions b
-- WHERE a.status = 'approved' AND a.type = 'recharge' AND a.trxid IS NOT NULL
--   AND b.status = 'approved' AND b.type = 'recharge'
--   AND a.user_id = b.user_id AND a.trxid = b.trxid
--   AND a.created_at > b.created_at;
--
-- NOTE: if balances were double-credited by the old bug, adjust them too:
--   (compare users.balance against SUM of approved transactions per user
--    before deciding — do NOT blindly subtract)
