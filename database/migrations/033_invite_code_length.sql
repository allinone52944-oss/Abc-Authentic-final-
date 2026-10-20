-- 033: invite code column too short for the current code format.
-- invite_links.code was VARCHAR(24) (from the 32-bit code era), but
-- genCode() now mints 'INV-' + 32 hex chars = 36 characters
-- (128-bit entropy). Every admin invite creation failed with
-- "value too long" -> 500 FAILED. Widen the column.
ALTER TABLE invite_links ALTER COLUMN code TYPE VARCHAR(48);
