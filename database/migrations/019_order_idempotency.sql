-- 019_order_idempotency.sql
-- M-2/M-15 fix (2026-10-15): orders carry the client idempotency key so a
-- retried submit returns the already-created order instead of 500.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idem
  ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
