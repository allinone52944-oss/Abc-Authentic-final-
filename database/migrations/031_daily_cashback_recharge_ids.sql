-- ============================================================
-- 031_daily_cashback_recharge_ids.sql — Daily Cashback: claim coverage
-- A daily claim now covers ALL still-unclaimed approved recharges
-- (not only today's), so a recharge approved after the day's claim
-- is never lost — it joins the next day's single claim. To know
-- exactly which recharges a claim covered, their ids are stored.
-- ============================================================

ALTER TABLE daily_cashback_redemptions
    ADD COLUMN IF NOT EXISTS recharge_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
