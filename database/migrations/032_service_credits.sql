-- 032: service-locked credits (owner rule, 2026-10-21).
-- Money from a service-scoped coupon (or service-scoped cashback)
-- must be spendable ONLY on that service. It never merges into the
-- spend-anywhere wallet balance (users.balance); it is held here
-- and consumed — first, before balance — only when the user pays
-- for that exact service (order create / engine charges).
CREATE TABLE IF NOT EXISTS service_credits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  source     VARCHAR(20) NOT NULL DEFAULT 'coupon',  -- coupon | cashback
  ref        VARCHAR(255) UNIQUE,                    -- idempotency key
  amount     NUMERIC(12,2) NOT NULL,
  remaining  NUMERIC(12,2) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_svc_credits_user_service
  ON service_credits(user_id, service_id) WHERE remaining > 0;
