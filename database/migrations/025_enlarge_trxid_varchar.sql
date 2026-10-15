-- 025_enlarge_trxid_varchar.sql
-- Fix: bdris-apply submit charge ref ('bdris-apply-submit-<key>-<uuid>' = ~121 chars)
-- exceeds transactions.trxid VARCHAR(60) → "value too long for type character varying(60)".
-- Enlarge to VARCHAR(255) to accommodate service-generated refs.

ALTER TABLE transactions ALTER COLUMN trxid TYPE VARCHAR(255);
