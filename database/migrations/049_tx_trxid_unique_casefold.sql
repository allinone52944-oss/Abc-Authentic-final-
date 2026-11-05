-- 049_tx_trxid_unique_casefold.sql
-- Audit #23: TrxID comparisons must be case-folded. A user who
-- submits 'abc123' after 'ABC123' bypassed the DUP check
-- (Postgres text '=' is case-sensitive) and the same TrxID could
-- be credited twice; the same class of hole lived in the
-- wallet_apply() double-credit guard and the SMS dedupe.
--
-- Why a NEW file: 016 and 020 are already applied on live
-- (migrate.js tracks files by name in schema_migrations and runs
-- each exactly once), so editing them in place would change
-- nothing on live. This file carries all three schema pieces:
--   1) a case-insensitive unique index (user_id, UPPER(trxid)),
--   2) the old case-sensitive index dropped (after the new one
--      exists, so a failure here loses no protection),
--   3) wallet_apply() redefined with the UPPER double-credit
--      guard (same signature as 016 — CREATE OR REPLACE).
-- The application-side comparisons move to UPPER in the same
-- change (routes/user.js DUP check, routes/sms.js SMS dedupe;
-- sms.js findMatch and the smsArrived check already use UPPER).
--
-- NOTE: if live already holds the same TrxID in two cases for
-- one user, step (1) fails loudly (unique violation) and the
-- migration rolls back — the old index stays in place. Clean up
-- first (keep the earliest row per case-folded TrxID), e.g.:
--   SELECT user_id, UPPER(trxid), COUNT(*) FROM transactions
--   WHERE trxid IS NOT NULL
--   GROUP BY user_id, UPPER(trxid) HAVING COUNT(*) > 1;

-- 1) Case-insensitive uniqueness first: a conflict here aborts
-- the migration before the old index is touched.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_user_trxid_unique_ci
  ON transactions(user_id, UPPER(trxid)) WHERE trxid IS NOT NULL;

-- 2) The old case-sensitive index is now redundant.
DROP INDEX IF EXISTS idx_tx_user_trxid_unique;

-- 3) wallet_apply() double-credit guard, case-folded (same
-- signature and body as 016, only the guard comparison changes).
CREATE OR REPLACE FUNCTION wallet_apply(
    p_user   UUID,
    p_amount NUMERIC,
    p_type   VARCHAR,
    p_ref    VARCHAR DEFAULT NULL,
    p_existing_tx UUID DEFAULT NULL
)
RETURNS TABLE(new_balance NUMERIC, tx_id UUID) AS $$
DECLARE
    v_tx   UUID;
    v_bal  NUMERIC;
BEGIN
    SELECT balance INTO v_bal FROM users WHERE id = p_user FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    IF v_bal + p_amount < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    IF p_ref IS NOT NULL THEN
        PERFORM 1 FROM transactions
         WHERE user_id = p_user AND UPPER(trxid) = UPPER(p_ref) AND status = 'approved';
        IF FOUND THEN
            RAISE EXCEPTION 'DUPLICATE_TRANSACTION';
        END IF;
    END IF;

    UPDATE users SET balance = balance + p_amount WHERE id = p_user
    RETURNING balance INTO v_bal;

    IF p_existing_tx IS NOT NULL THEN
        UPDATE transactions SET status = 'approved'
        WHERE id = p_existing_tx AND user_id = p_user AND status = 'pending'
        RETURNING id INTO v_tx;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'TX_NOT_FOUND';
        END IF;
    ELSE
        INSERT INTO transactions (user_id, type, amount, trxid, status)
        VALUES (p_user, p_type, p_amount, p_ref, 'approved')
        RETURNING id INTO v_tx;
    END IF;

    new_balance := v_bal;
    tx_id := v_tx;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
