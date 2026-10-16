-- Migration 029: Add recharge tracking to coupons table
-- For per-recharge coupon generation (user spec 2026-10-16)

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS recharge_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_coupons_recharge ON coupons(recharge_id) WHERE recharge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_user_status ON coupons(user_id, status);
