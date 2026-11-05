-- Audit #33 — record HOW an SMS was matched (auto vs manual) so the
-- admin SMS hub labels it truthfully instead of calling every match
-- "অটো প্রসেসড". Legacy matched rows keep matched_via NULL (unknown);
-- the hub shows those as plain "মিলেছে".
ALTER TABLE incoming_sms ADD COLUMN IF NOT EXISTS matched_via VARCHAR(10)
  CHECK (matched_via IN ('auto', 'manual'));
