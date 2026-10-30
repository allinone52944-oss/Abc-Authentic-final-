-- 045: refresh_tokens gains a persistent rotation lineage. The 30s
-- rotation leeway used to live only in process memory: after a
-- service restart it vanished, so a second tab presenting the
-- pre-restart token looked like token theft and the whole chain
-- was revoked (forced logout after every restart). The lineage
-- below survives restarts: a revoked token rotated within the
-- leeway still refreshes (by rotating its replacement) instead
-- of revoking the chain. Anything outside the leeway is still
-- theft and still revokes the chain.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by_hash VARCHAR(64);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ;
