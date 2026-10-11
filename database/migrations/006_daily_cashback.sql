-- ============================================================
-- 006_daily_cashback.sql — Daily Cashback redemptions
-- One redeem per user per day (Dhaka date). Expires at midnight.
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_cashback_redemptions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day            DATE NOT NULL,                                  -- Asia/Dhaka date
    recharge_total NUMERIC(12,2) NOT NULL DEFAULT 0,                -- today's approved recharge sum
    percent        NUMERIC(8,4)  NOT NULL DEFAULT 0,                -- cashback % used
    amount         NUMERIC(12,2) NOT NULL DEFAULT 0,                -- credited amount
    coupon_code    VARCHAR(40) NOT NULL,                            -- CB-YYYYMMDD-XXXX
    redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, day)                                         -- once per day, idempotent
);
CREATE INDEX IF NOT EXISTS idx_dcb_user_day ON daily_cashback_redemptions(user_id, day DESC);
