-- 016_wallet_apply_reuse_tx.sql
-- C-4 fix (2026-10-15): wallet_apply() এখন optional p_existing_tx নেয়।
-- Recharge approve-এর সময় pending row আগে থেকেই থাকে — তখন নতুন ledger row
-- INSERT না করে ওই row-কেই 'approved' করা হয়। আগে প্রতিটা approve-এ ডবল
-- row হতো, revenue/cashback aggregate দ্বিগুণ গুনত।
-- NOTE: অতীতের ডবল row গুলো এই migration মুছবে না — নিচের query দিয়ে
-- চিহ্নিত করে manually যাচাই করে পরিষ্কার করতে হবে:
--   SELECT trxid, COUNT(*) FROM transactions
--   WHERE status = 'approved' AND type = 'recharge'
--   GROUP BY trxid HAVING COUNT(*) > 1;

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
         WHERE user_id = p_user AND trxid = p_ref AND status = 'approved';
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
