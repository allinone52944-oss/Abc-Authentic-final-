-- 044: bdris_applications gains original-PDF availability. The engine
-- already writes the fetched Form-1 PDF to disk, but nothing linked
-- it to the submitted record, so after leaving the DONE page the
-- original was unretrievable from the record. The record now flags
-- whether the original PDF is stored for this ack number (set by a
-- flag-only re-POST when the fetch succeeds; the conflict clause
-- upgrades the flag and never blanks the name).
ALTER TABLE bdris_applications ADD COLUMN IF NOT EXISTS original_pdf_available BOOLEAN NOT NULL DEFAULT FALSE;
