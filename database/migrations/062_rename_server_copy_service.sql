-- 062: Rename the NID Server Copy Report service to "Sign to Server Copy"
-- (user direction 2026-11-19): the engine's display name is now
-- 'Sign to Server Copy' / 'সাইন টু সার্ভার কপি', matching the
-- Smart Card engine's "Sign to ..." naming. engine_id stays
-- 'nid-server-report' — only the display name changes, so no
-- History/order/engine mapping is affected.
-- Migration 060 already ran live, so editing it cannot rename the
-- live row — this UPDATE does it.
-- Idempotent: only touches rows whose name still differs.
UPDATE services
SET name = 'Sign to Server Copy', name_bn = 'সাইন টু সার্ভার কপি'
WHERE engine_id = 'nid-server-report'
  AND (name <> 'Sign to Server Copy' OR name_bn <> 'সাইন টু সার্ভার কপি');
