-- 008: Invite links — admin-generated registration links that work
-- even when public registration is OFF.
-- An invite code bypasses the registration_enabled check.
-- max_uses NULL = unlimited; expires_at NULL = never expires.

CREATE TABLE IF NOT EXISTS invite_links (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(24) NOT NULL UNIQUE,
    created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses    INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
    used_count  INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    expires_at  TIMESTAMPTZ,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    note        VARCHAR(255) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_links(code);
CREATE INDEX IF NOT EXISTS idx_invite_creator ON invite_links(created_by);
