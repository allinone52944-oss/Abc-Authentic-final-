-- 012: Service categories (admin-created groups, e.g. "জন্মনিবন্ধন সেবা")
-- - service_categories table (id, name, name_bn, icon, serial, status)
-- - services.category_id FK nullable, ON DELETE SET NULL
-- - Existing services keep NULL category -> shown under "অন্যান্য" on user side

CREATE TABLE IF NOT EXISTS service_categories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(160) NOT NULL,          -- English name
    name_bn    VARCHAR(160),                   -- Bengali name
    icon       VARCHAR(20) NOT NULL DEFAULT '📁',
    serial     INT NOT NULL DEFAULT 0,         -- display order
    status     VARCHAR(20) NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scats_serial ON service_categories(serial);
CREATE INDEX IF NOT EXISTS idx_scats_status ON service_categories(status);

ALTER TABLE services
    ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES service_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);

DROP TRIGGER IF EXISTS trg_service_categories_updated ON service_categories;
CREATE TRIGGER trg_service_categories_updated BEFORE UPDATE ON service_categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
