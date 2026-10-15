-- 018_session_timeout.sql
-- H-8 fix (2026-10-15): idle + absolute session limits.
-- refresh_tokens.last_activity tracks last refresh; the /refresh endpoint
-- revokes the session when idle_minutes or absolute_hours is exceeded.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO settings (key, value) VALUES
  ('session_timeout', '{"idle_minutes": 120, "absolute_hours": 168}')
ON CONFLICT (key) DO NOTHING;
