-- Bug #4 — distinguish money-in from money-out SMS: store the parser's
-- direction ('in' | 'out' | 'unknown') on each incoming SMS so the admin
-- hub can badge it and manual match can refuse money-out SMS. Legacy rows
-- keep direction NULL (unknown); the hub shows no badge for them and the
-- manual-match guard does not block them.
ALTER TABLE incoming_sms ADD COLUMN IF NOT EXISTS direction VARCHAR(10)
  CHECK (direction IN ('in', 'out', 'unknown'));
COMMENT ON COLUMN incoming_sms.direction IS 'Parser direction: in = money received, out = money sent, unknown = could not classify. NULL = stored before this column existed.';
