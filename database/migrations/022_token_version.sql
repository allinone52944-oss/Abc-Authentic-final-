-- 022_token_version.sql
-- M-7 fix (2026-10-15): token_version lets the backend invalidate all
-- sessions when a user's role changes (bumped on role change; refresh
-- tokens are revoked at the same time).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
