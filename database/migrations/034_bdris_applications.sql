-- 034: server-side record of submitted BDRIS applications.
-- Until now a submitted application existed only in the customer's
-- browser localStorage ('সাম্প্রতিক আবেদন') — the admin saw nothing
-- of the platform's main automated service. Every successful submit
-- now also reports here: the customer sees their list from the
-- server on any device, and the admin sees everyone's applications
-- and can delete a record.
CREATE TABLE IF NOT EXISTS bdris_applications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ack_no         VARCHAR(64) NOT NULL,
  applicant_name VARCHAR(160) NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, ack_no)
);
CREATE INDEX IF NOT EXISTS idx_bdris_apps_user ON bdris_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bdris_apps_created ON bdris_applications(created_at DESC);
