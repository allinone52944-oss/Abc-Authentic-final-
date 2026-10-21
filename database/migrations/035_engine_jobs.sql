-- 035: stored delivery copies of standalone engine results
-- (birth-certificate and death-verify PDFs). Those engines stream
-- the generated PDF straight to the browser and keep no record, so
-- the work could never appear in the customer's History (delivery
-- files only). The engine pages now report a copy here after a
-- successful PDF download; History lists it as a delivery file,
-- and the admin can list/delete records.
CREATE TABLE IF NOT EXISTS engine_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine_id       VARCHAR(40) NOT NULL,
  ref_no          VARCHAR(64) NOT NULL DEFAULT '',
  subject_name    VARCHAR(160) NOT NULL DEFAULT '',
  filename        VARCHAR(120) NOT NULL,
  originalname    VARCHAR(200) NOT NULL DEFAULT '',
  idempotency_key VARCHAR(80) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_engine_jobs_user ON engine_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engine_jobs_created ON engine_jobs(created_at DESC);
