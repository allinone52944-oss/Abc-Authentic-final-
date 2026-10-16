-- Migration 027: Manual service config columns on services table
-- Safe: IF NOT EXISTS, no existing data touched, separate statements

ALTER TABLE services ADD COLUMN IF NOT EXISTS manual_instructions TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS manual_sample TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS manual_doc_count INT NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_services_manual_doc_count'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT chk_services_manual_doc_count
      CHECK (manual_doc_count BETWEEN 1 AND 6);
  END IF;
END $$;

COMMENT ON COLUMN services.manual_instructions IS 'Admin-লেখা নির্দেশনা (manual সেবার জন্য)';
COMMENT ON COLUMN services.manual_sample IS 'নমুনা ফরম্যাট (copy button সহ দেখাবে)';
COMMENT ON COLUMN services.manual_doc_count IS 'কয়টা document লাগবে (১-৬, admin নির্ধারণ)';
