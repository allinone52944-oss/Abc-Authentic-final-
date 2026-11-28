-- 067_telegram_joined.sql
-- Per-user flag for the Telegram join banner (2026-11-28).
-- Once a user joins the Telegram group, the banner must never show
-- again — on any device or browser. The banner sets this flag when
-- the user clicks Join (POST /api/user/telegram-joined) and reads it
-- on load (GET /api/user/telegram-joined); localStorage is the
-- same-device fast path, this column is the cross-device source of
-- truth. Additive only: no existing column or behaviour changes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_joined BOOLEAN NOT NULL DEFAULT FALSE;
