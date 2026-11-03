-- 047: Land khatian collection INDEX / METADATA table only
-- (engine: land-khatian, collection store — see
-- engines/land-khatian/STORE.md).
--
-- BULK RECORDS NEVER GO HERE. This table holds only
-- index/metadata: which (mouza, survey) pairs have been
-- collected, how many records each holds, and when. The bulk
-- records themselves live in the SEPARATE store (a second
-- small server, or the local file store in dev), reached
-- via backend/lib/khatianStore.js. That split is what keeps
-- the production database (abc_authentic_new) free of bulk
-- site load. There is NO bulk records table in this
-- migration, or anywhere else in this change.
--
-- A row is one UNIT (jl_id × survey_key, source) pair.
-- source carries 'dlrms' only.
--
-- Reconciliation fields (the mouza-collection rule):
-- expected_count = FULL index-list length, recorded BEFORE
-- any detail is loaded; collected_count = distinct stored
-- records for the unit, counted from the separate store
-- (store countForUnit) — NEVER a running increment, so the
-- row always reconciles against the store itself.
-- status is 'complete' ONLY when collected == expected
-- AND zero failed details AND zero unparseable records; any
-- mismatch, failed detail, or unreadable record → 'partial'
-- with the missing khatian_nos + reasons kept OPEN in
-- issues (JSONB, capped — see route capIssues). A single
-- stored record proves loading works, never completeness.
-- LIVE-SEARCH upserts NEVER set a unit 'complete' and
-- NEVER downgrade a 'complete' unit to 'partial': they
-- refresh collected_count / dates only, leaving status,
-- expected_count, and issues untouched.

CREATE TABLE IF NOT EXISTS land_khatian_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  division_bbs TEXT NOT NULL,
  district_bbs TEXT NOT NULL,
  upazila_bbs TEXT NOT NULL,
  division_name TEXT,
  district_name TEXT,
  upazila_name TEXT,
  mouza_id TEXT,
  mouza_name TEXT,
  jl_number TEXT,
  jl_id TEXT NOT NULL,
  survey_key TEXT NOT NULL,
  survey_name TEXT,
  record_count INT NOT NULL DEFAULT 0,
  expected_count INT,
  collected_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'partial' CHECK (status IN ('complete', 'partial')),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'dlrms',
  first_collected_at TIMESTAMPTZ,
  last_collected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (jl_id, survey_key, source)
);

CREATE INDEX IF NOT EXISTS idx_land_khatian_index_district_upazila
  ON land_khatian_index (district_bbs, upazila_bbs);
