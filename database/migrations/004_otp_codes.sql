-- 004: OTP codes for email verification (hashed, 5-min expiry)
CREATE TABLE IF NOT EXISTS otp_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) NOT NULL,
    code_hash   VARCHAR(255) NOT NULL,
    purpose     VARCHAR(40) NOT NULL DEFAULT 'verify',
    attempts    INT NOT NULL DEFAULT 0,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email, created_at DESC);
