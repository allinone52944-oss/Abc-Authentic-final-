-- Additive replay identity; preserve all coupons, credits and balances.
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS claimed_code VARCHAR(40);
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS claimed_expires_at TIMESTAMPTZ;
-- Deleted legacy coupons cannot be reconstructed: leave their code NULL.
UPDATE coupon_redemptions r
SET claimed_code = UPPER(TRIM(c.code)), claimed_expires_at = c.expires_at
FROM coupons c WHERE r.coupon_id = c.id AND r.claimed_code IS NULL;
COMMENT ON COLUMN coupon_redemptions.claimed_code IS 'Original normalized code; survives coupon deletion. NULL legacy code fails closed.';
COMMENT ON COLUMN coupon_redemptions.claimed_expires_at IS 'Original campaign expiry; immutable alongside claimed_code, including NULL for no expiry.';
