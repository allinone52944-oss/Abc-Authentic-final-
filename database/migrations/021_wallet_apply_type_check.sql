-- 021_wallet_apply_type_check.sql
-- M-4 fix (2026-10-15): wallet_apply validates p_type with a clear error.
-- (Same body as schema.sql — CREATE OR REPLACE keeps it idempotent.)

CREATE OR REPLACE FUNCTION wallet_apply(
    p_user   UUID,
    p_amount NUMERIC,
    p_type   VARCHAR,
    p_ref    VARCHAR DEFAULT NULL,
    p_existing_tx UUID DEFAULT NULL
    -- C-4 fix (2026-10-15): p_existing_tx দেওয়া থাকলে (recharge approve-এর মতো
    -- pending row আগে থেকেই আছে) নতুন row INSERT না করে ওই row-কেই 'approved'
    -- করা হয় — নইলে প্রতিটা approve-এ ডবল ledger row হতো।
)
RETURNS TABLE(new_balance NUMERIC, tx_id UUID) AS $$
DECLARE
    v_tx   UUID;
    v_bal  NUMERIC;
BEGIN
    -- M-4 fix (2026-10-15): validate p_type early with a clear error instead
    -- of a raw CHECK-violation from the INSERT.
    IF p_type NOT IN ('recharge','cashback','promo','refund','debit','bonus') THEN
        RAISE EXCEPTION 'INVALID_TX_TYPE: %', p_type;
    END IF;

    -- Lock the user row for the whole transaction (prevents double-spend)
    SELECT balance INTO v_bal FROM users WHERE id = p_user FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    IF v_bal + p_amount < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- Idempotency: same ref must not be applied twice
    IF p_ref IS NOT NULL THEN
        PERFORM 1 FROM transactions
         WHERE user_id = p_user AND trxid = p_ref AND status = 'approved';
        IF FOUND THEN
            RAISE EXCEPTION 'DUPLICATE_TRANSACTION';
        END IF;
    END IF;

    UPDATE users SET balance = balance + p_amount WHERE id = p_user
    RETURNING balance INTO v_bal;

    IF p_existing_tx IS NOT NULL THEN
        -- Reuse the existing pending row: flip it to approved (no second row)
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
