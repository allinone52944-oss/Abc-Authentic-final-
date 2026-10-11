-- 007: Mandatory email verification + password reset via email
-- - email_verification_tokens: link-based verification (24h expiry, single-use)
-- - password_reset_tokens: forgot-password flow (1h expiry, single-use)
-- - Grandfather existing users: they were created before mandatory
--   verification, so mark them verified + active (admin included).

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evt_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_evt_hash ON email_verification_tokens(token_hash);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_prt_hash ON password_reset_tokens(token_hash);

-- Grandfather: everyone registered before this migration is trusted.
UPDATE users SET email_verified = TRUE WHERE email_verified = FALSE;
UPDATE users SET status = 'active' WHERE status = 'pending';
