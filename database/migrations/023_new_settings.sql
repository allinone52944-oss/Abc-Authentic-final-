-- 023_new_settings.sql
-- Seeds for settings added by the 2026-10-15 fix batches (existing installs).
INSERT INTO settings (key, value) VALUES
  ('session_timeout', '{"idle_minutes": 120, "absolute_hours": 168}'),
  ('ip_blocklist',    '{"ips": []}')
ON CONFLICT (key) DO NOTHING;
