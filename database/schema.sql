-- ============================================================
-- All In One (Abc Authentic) - Database Schema v1
-- Database: abc_authentic_new | PostgreSQL
-- Created: 2026-10-11 | Fresh rebuild, no legacy data
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    phone           VARCHAR(20)  NOT NULL UNIQUE,
    whatsapp        VARCHAR(20)  NOT NULL,              -- MANDATORY per spec
    email           VARCHAR(160) UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    religion        VARCHAR(20)  DEFAULT 'other'
                    CHECK (religion IN ('islam','hindu','buddhist','christian','other')),
    gender          VARCHAR(10)  DEFAULT 'other'
                    CHECK (gender IN ('male','female','child','other')),
    role            VARCHAR(20)  NOT NULL DEFAULT 'user'
                    CHECK (role IN ('admin','user')),
    balance         NUMERIC(12,2) NOT NULL DEFAULT 0
                    CHECK (balance >= 0),                       -- never negative
    status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','blocked')),
    login_enabled   BOOLEAN      NOT NULL DEFAULT TRUE,
    failed_attempts INT          NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    email_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ------------------------------------------------------------
-- SERVICES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               VARCHAR(160) NOT NULL,           -- English name
    name_bn            VARCHAR(160),                    -- Bengali name
    type               VARCHAR(20) NOT NULL DEFAULT 'manual'
                       CHECK (type IN ('manual','automated')),
    price              NUMERIC(12,2) NOT NULL DEFAULT 0,
    serial             INT NOT NULL DEFAULT 0,          -- display order
    documents_required JSONB NOT NULL DEFAULT '[]',    -- ["NID","Photo",...] for manual
    fields_required    JSONB NOT NULL DEFAULT '[]',    -- form field definitions
    schedule           JSONB NOT NULL DEFAULT '{}',    -- {"open":"09:00","close":"17:00","days":[...]}
    rules_text         TEXT,                            -- attractive rules shown per service
    engine_id          VARCHAR(60),                     -- links to engines/ manifest id (automated)
    status             VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','disabled')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_services_serial ON services(serial);
CREATE INDEX IF NOT EXISTS idx_services_type   ON services(type);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

-- ------------------------------------------------------------
-- USER_SERVICES (per-user price & access override)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_services (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id     UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    custom_price   NUMERIC(12,2),                       -- NULL = use service default
    access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (user_id, service_id)
);

-- ------------------------------------------------------------
-- ORDERS (8 statuses per spec)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id  UUID NOT NULL REFERENCES services(id),
    status      VARCHAR(20) NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','pending','processing','completed',
                                  'delivered','failed','cancelled','refunded')),
    data        JSONB NOT NULL DEFAULT '{}',           -- order form data
    documents   JSONB NOT NULL DEFAULT '[]',          -- uploaded document refs
    notes       TEXT,                                   -- user notes
    admin_note  TEXT,
    price       NUMERIC(12,2) NOT NULL DEFAULT 0,      -- price at order time
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_service ON orders(service_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- ------------------------------------------------------------
-- TRANSACTIONS (wallet: recharge / cashback / promo / refund)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(20) NOT NULL
                CHECK (type IN ('recharge','cashback','promo','refund','debit','bonus')),
    amount      NUMERIC(12,2) NOT NULL,
    method      VARCHAR(30),                            -- bkash_payment, bkash_personal, nagad, rocket
    sender_no   VARCHAR(20),
    trxid       VARCHAR(60),
    screenshot  TEXT,                                   -- base64 or file ref
    status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
    admin_id    UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user   ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_trxid  ON transactions(trxid);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);

-- ------------------------------------------------------------
-- COUPONS (cashback + promo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(40) NOT NULL UNIQUE,
    type        VARCHAR(20) NOT NULL CHECK (type IN ('cashback','promo')),
    percent     NUMERIC(5,2) NOT NULL DEFAULT 0,
    amount      NUMERIC(12,2) NOT NULL DEFAULT 0,        -- fixed amount alternative
    service_id  UUID REFERENCES services(id),          -- NULL = any service (promo scoped)
    user_id     UUID REFERENCES users(id),             -- NULL = any user
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','redeemed','expired','disabled')),
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);

-- ------------------------------------------------------------
-- NOTICES (per-user or broadcast)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notices (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = all users
    title      VARCHAR(200) NOT NULL,
    message    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id);

-- ------------------------------------------------------------
-- ACTIVITY LOG (admin audit trail)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id   UUID REFERENCES users(id),
    action     VARCHAR(80) NOT NULL,                   -- e.g. user.delete, balance.adjust
    details    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_admin  ON activity_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);

-- ------------------------------------------------------------
-- BANNERS / ADS / POPUPS (15-20 ready designs in admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banners (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type       VARCHAR(20) NOT NULL CHECK (type IN ('banner','ad','popup')),
    title      VARCHAR(200) NOT NULL,
    design_id  INT NOT NULL DEFAULT 1,                 -- 1..20 sample designs
    content    JSONB NOT NULL DEFAULT '{}',            -- {image, link, text_bn, text_en}
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- CHAT MESSAGES (contextual: order complaints / reviews)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id   UUID REFERENCES orders(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     VARCHAR(10) NOT NULL CHECK (sender IN ('user','admin')),
    message    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_order ON chat_messages(order_id);

-- ------------------------------------------------------------
-- SETTINGS (key-value: registration on/off, maintenance mode, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key        VARCHAR(80) PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('registration_enabled', '{"enabled": true}'),
    ('maintenance_mode',     '{"enabled": false, "message": ""}'),
    ('file_upload',          '{"max_mb": 5, "allowed": ["pdf","jpg","jpeg","png"]}'),
    ('login_security',       '{"max_attempts": 5, "lock_minutes": 30}'),
    ('cashback',             '{"enabled": false, "percent": 0}'),
    ('welcome_bonus',        '{"enabled": false, "amount": 0}')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- REFRESH TOKENS (opaque, stored as SHA-256 hash only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,            -- sha256 hex
    expires_at TIMESTAMPTZ NOT NULL,
    revoked    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);

-- ------------------------------------------------------------
-- WALLET INTEGRITY: atomic credit/debit, no negative, no double-spend
-- Usage: SELECT * FROM wallet_apply(p_user, p_amount, p_type, p_ref);
--   p_amount > 0 = credit, < 0 = debit. Raises on insufficient funds.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION wallet_apply(
    p_user   UUID,
    p_amount NUMERIC,
    p_type   VARCHAR,
    p_ref    VARCHAR DEFAULT NULL
)
RETURNS TABLE(new_balance NUMERIC, tx_id UUID) AS $$
DECLARE
    v_tx   UUID;
    v_bal  NUMERIC;
BEGIN
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

    INSERT INTO transactions (user_id, type, amount, trxid, status)
    VALUES (p_user, p_type, p_amount, p_ref, 'approved')
    RETURNING id INTO v_tx;

    new_balance := v_bal;
    tx_id := v_tx;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- Updated_at trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_services_updated ON services;
CREATE TRIGGER trg_services_updated BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated ON orders;
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
