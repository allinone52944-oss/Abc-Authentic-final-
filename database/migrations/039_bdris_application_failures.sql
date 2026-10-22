-- 039: bdris_applications gains failure records. Until now only
-- successful submissions were recorded; a final submission that
-- failed on the portal left no trace for the admin. A failed
-- attempt now lands here with status='failed' and the reason
-- (its ack_no is a generated 'FAIL-…' marker — no real
-- acknowledgement number exists). The customer's own list keeps
-- showing submitted applications only.
ALTER TABLE bdris_applications ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'submitted';
ALTER TABLE bdris_applications ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(240) NOT NULL DEFAULT '';
