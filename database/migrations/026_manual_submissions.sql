-- 026_manual_submissions.sql
-- Manual service submissions: customer pastes formatted text + uploads documents.
-- Admin views auto-formatted, copies clean text, downloads documents.
-- Standalone module: does not touch orders/engines.

CREATE TABLE IF NOT EXISTS manual_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  raw_text TEXT NOT NULL,
  parsed_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manual_submissions_user ON manual_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_manual_submissions_status ON manual_submissions(status);
CREATE INDEX IF NOT EXISTS idx_manual_submissions_created ON manual_submissions(created_at DESC);
