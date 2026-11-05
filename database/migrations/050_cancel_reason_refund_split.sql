-- 050_cancel_reason_refund_split.sql
-- Audit #28: the cancel reason was lost. The admin order-status
-- endpoint accepted cancel_reason but only used it for the
-- notification — the orders table had no column for it, so after
-- the notification the reason was gone. Same for the recharge
-- reject endpoint (status + admin_id only). And the refund split
-- (wallet vs locked service credit) lived only in the
-- notification text, never on the order — the status page could
-- only claim the full price went to the wallet.
--
--   orders.cancel_reason    — customer-facing reason, set on a
--     cancelled/failed transition (NULL otherwise).
--   orders.refund_balance / refund_credit — the actual refund
--     split stored when a refund runs (see refundOrderPrice in
--     lib/serviceCredits). Both 0 means no refund ran (or a
--     legacy refund from before this change — the page falls
--     back to the generic text for those).
--   transactions.cancel_reason — customer-facing reason for a
--     rejected recharge, set by the admin reject endpoint.
--
-- admin_note stays internal-only and is NOT exposed on customer
-- endpoints (P2, 2026-11-03); cancel_reason is the only reason
-- the customer ever sees.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_credit NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
