-- 038: engine_jobs gains an outcome. Until now only SUCCESSFUL
-- certificate / death verifications were ever recorded (the
-- engine pages report a copy of the finished PDF). A failed
-- verification now records a 'failed' row too — its file is a
-- generated failure receipt, so the attempt appears in the
-- customer's History with the reason and a clear no-charge
-- line, exactly like the QR + photo verification flow.
ALTER TABLE engine_jobs ADD COLUMN IF NOT EXISTS outcome VARCHAR(12) NOT NULL DEFAULT 'completed';
ALTER TABLE engine_jobs ADD COLUMN IF NOT EXISTS reason VARCHAR(240) NOT NULL DEFAULT '';
