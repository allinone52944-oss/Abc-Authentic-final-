-- 024: Drop ambiguous 4-param wallet_apply overload (2026-10-15)
--
-- schema.sql defines wallet_apply(UUID, NUMERIC, VARCHAR, VARCHAR, UUID DEFAULT NULL)
-- (5 params, C-4 double-ledger fix). Migrations 016/021 defined a 4-param version.
-- CREATE OR REPLACE with different arity creates SEPARATE functions, not replacements.
-- A 4-arg call now matches BOTH (5-param has DEFAULT for 5th), causing:
--   "function wallet_apply(unknown, unknown, unknown, unknown) is not unique"
-- Drop the 4-param overload; the 5-param handles 4-arg calls via its DEFAULT.
DROP FUNCTION IF EXISTS wallet_apply(UUID, NUMERIC, VARCHAR, VARCHAR);
