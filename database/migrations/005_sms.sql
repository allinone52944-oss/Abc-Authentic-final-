-- ============================================================
-- 005_sms.sql — Auto SMS payment matching
-- incoming_sms: raw forwarded MFS SMS + parse result + match link
-- ============================================================

CREATE TABLE IF NOT EXISTS incoming_sms (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    method             VARCHAR(20),                        -- bkash | nagad | rocket | unknown
    amount             NUMERIC(12,2),
    sender             VARCHAR(30),                        -- MFS sender no/account
    trxid              VARCHAR(60),
    raw_message        TEXT NOT NULL,
    raw_sender         VARCHAR(60),                        -- SMS sender id (e.g. bKash, 16247)
    parse_status       VARCHAR(20) NOT NULL DEFAULT 'parsed'
                       CHECK (parse_status IN ('parsed','unparsed','ignored','duplicate')),
    matched_recharge_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    matched_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_trxid    ON incoming_sms(trxid);
CREATE INDEX IF NOT EXISTS idx_sms_matched  ON incoming_sms(matched_recharge_id);
CREATE INDEX IF NOT EXISTS idx_sms_created  ON incoming_sms(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_unmatched ON incoming_sms(created_at DESC)
    WHERE matched_recharge_id IS NULL AND parse_status = 'parsed';
