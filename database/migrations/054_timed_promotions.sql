-- Additive: existing personal recharge cashback remains single-use.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS is_campaign BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS max_uses INTEGER CHECK (max_uses > 0);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 service_id UUID REFERENCES services(id),
 ref VARCHAR(180) NOT NULL UNIQUE,
 amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The existing application owner role exclusively accesses these tables;
-- no anonymous/Data API grants are introduced into the Oracle deployment.
GRANT SELECT, INSERT, UPDATE, DELETE ON coupon_redemptions TO CURRENT_USER;
CREATE INDEX IF NOT EXISTS coupon_redemptions_customer ON coupon_redemptions(coupon_id,user_id);
COMMENT ON COLUMN coupons.is_campaign IS 'Reusable checkout campaigns; false preserves preexisting personal wallet cashback.';
