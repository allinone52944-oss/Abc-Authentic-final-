-- Admin-controlled dashboard display: highlight + show on dashboard.
-- Presentation only: price, access, engine and money rules untouched.
ALTER TABLE services ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS show_on_dashboard BOOLEAN NOT NULL DEFAULT TRUE;
