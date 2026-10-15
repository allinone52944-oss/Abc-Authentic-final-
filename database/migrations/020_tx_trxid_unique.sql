-- 020_tx_trxid_unique.sql
-- M-3/C-4 fix (2026-10-15): idempotency at the schema level — the same
-- trxid can never appear twice for one user, even if application code
-- misses the check. NULL trxids (internal debits etc.) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_user_trxid_unique
  ON transactions(user_id, trxid) WHERE trxid IS NOT NULL;
