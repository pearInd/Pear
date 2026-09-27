-- =============================================================================
-- PEAR · Supabase Setup V15 - store_size_charts (the store's OWN size guides)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- fitting-room/app.js fits every shopper against ONE hardcoded matrix
-- (ZARA_SIZE_CHART and the two pants ladders). The widget already reads a size table
-- off the product page when one is in the DOM at click time, but most stores keep
-- their guide somewhere the widget cannot see from a PDP: a separate "size guide"
-- page, a modal rendered only after a click, a chart shared by the whole catalogue.
-- The scanner now finds those once per store (scanner/size-charts.js,
-- `node scanner/scan-store.js --size-charts --save <store-url>`) and writes them here.
--
-- WHAT A ROW MAY DO, AND WHAT IT MAY NOT (CLAUDE.md §2.5b - unchanged)
-- ────────────────────────────────────────────────────────────────────
-- The room reads these through GET /api/store-size-chart ONLY when the widget sent no
-- chart of its own, and applies them ONLY through applyStoreChartOverlay(): the
-- chest/waist/hips/legs fine-tune tie-break between sizes the height/weight kernel
-- already admitted. There is deliberately no height or weight column in `rows` - a
-- store chart is evidence about cloth, never about which bodies a size admits.
--
-- WHAT THIS DOES (safe to run on a live database, safe to run twice)
-- ──────────────────────────────────────────────────────────────────
--   Creates ONE new table, `store_size_charts`, with its indexes and RLS enabled.
--   It touches no existing table. Every statement is IF NOT EXISTS / DROP ... IF
--   EXISTS + ADD, so re-running it is a no-op.
--
-- SAFE TO SHIP THE CODE FIRST
-- ───────────────────────────
--   · GET /api/store-size-chart answers `{ charts: [], note: "table_missing" }` until
--     this runs (lib/store-size-charts.js: isMissingTableError), and the room reads an
--     empty list as "use the vetted default matrix" - today's behaviour, byte for byte.
--   · The scanner's --save prints "run archive/supabase_setup_v15.sql" and exits
--     cleanly instead of crashing; the dry run (--size-charts without --save) never
--     touches the database at all.
--
-- ROW SHAPE (`rows` JSONB), one element per size, centimetres:
--   { "size": "M",
--     "aliases": { "eu": "48", "us": "M", "alt": "38" },          -- optional, from the
--                                                                 -- store's own table
--     "body": { "chest": [96, 101], "waist": [82, 87],
--               "hips": [100, 105], "outseam": [98, 104] } }      -- any subset
--   `outseam` is the widget parser's `legs` column (minLegs/maxLegs). Inseam is not
--   captured yet and would be its own key - never folded into outseam.
--
-- KEY: one row per (store_domain, gender, age_group, garment_type, product_key, source).
--   product_key = ''   a store-wide guide (a linked size-guide page, or the same PDP
--                      table seen on 2+ products) - the only rows the room reads today.
--   product_key = URL  a chart seen on exactly one product page - kept for Phase 2.
--   '' rather than NULL so the key is a plain unique constraint that supabase-js
--   upsert(onConflict: ...) can target (a COALESCE expression index cannot be).
-- =============================================================================

CREATE TABLE IF NOT EXISTS store_size_charts (
  id             BIGSERIAL PRIMARY KEY,
  store_domain   TEXT        NOT NULL,              -- canonicalStoreHost(): lowercase, no www./m., no port
  gender         TEXT        NOT NULL DEFAULT 'unknown',
  age_group      TEXT        NOT NULL DEFAULT 'adult',
  garment_type   TEXT        NOT NULL,
  size_system    TEXT        NOT NULL DEFAULT 'unknown',   -- alpha | numeric | mixed
  product_key    TEXT        NOT NULL DEFAULT '',
  rows           JSONB       NOT NULL,
  source         TEXT        NOT NULL,              -- inline_table | product_description | linked_page | (future: merchant | widget_sighting | vision)
  source_url     TEXT,
  confidence     REAL,
  status         TEXT        NOT NULL DEFAULT 'active',
  sightings      INTEGER     NOT NULL DEFAULT 1,
  content_hash   TEXT        NOT NULL,
  parser_version INTEGER     NOT NULL DEFAULT 1,
  raw_snapshot   TEXT,                              -- the table's HTML (capped), for audit
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Value checks, dropped-then-added so a re-run (or a later edit to the allowed set)
-- replaces the constraint instead of failing on "already exists".
ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_gender_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_gender_chk
  CHECK (gender IN ('men', 'women', 'unisex', 'unknown'));

ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_age_group_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_age_group_chk
  CHECK (age_group IN ('adult', 'kids'));

ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_garment_type_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_garment_type_chk
  CHECK (garment_type IN ('tops', 'bottoms', 'jeans', 'dresses', 'outerwear'));

ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_status_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_status_chk
  CHECK (status IN ('active', 'pending_review', 'rejected'));

ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_rows_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_rows_chk
  CHECK (jsonb_typeof(rows) = 'array');

-- The upsert target (scanner: onConflict "store_domain,gender,age_group,garment_type,product_key,source").
CREATE UNIQUE INDEX IF NOT EXISTS store_size_charts_key_idx
  ON store_size_charts (store_domain, gender, age_group, garment_type, product_key, source);

-- The read path: GET /api/store-size-chart filters store_domain + status='active' +
-- product_key='' and orders by updated_at.
CREATE INDEX IF NOT EXISTS store_size_charts_read_idx
  ON store_size_charts (store_domain, updated_at DESC)
  WHERE status = 'active' AND product_key = '';

-- RLS ON, NO POLICIES: the fitting room ships the PUBLIC anon key, and a size chart
-- is written by the scanner and read by server.js - both with the service role key,
-- which bypasses RLS. So the anon key can neither read nor write this table, which
-- is the point: the only path to a shopper is the server endpoint that re-applies
-- the clamps.
ALTER TABLE store_size_charts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE store_size_charts IS
  'A storefront''s own size guide, captured by scanner/size-charts.js. Read by '
  'GET /api/store-size-chart; applied by the room ONLY as the fine-tune tie-break '
  '(CLAUDE.md §2.5b) and ONLY when the widget sent no chart. See archive/supabase_setup_v15.sql.';
COMMENT ON COLUMN store_size_charts.rows IS
  'JSONB array: [{ size, aliases?: {eu,us,uk,it,fr,int,alt}, body: {chest,waist,hips,outseam: [min_cm,max_cm]} }]. '
  'No height/weight - by design.';

-- ── DIAGNOSTICS ─────────────────────────────────────────────────────────────────
--   What each store has:
--     SELECT store_domain, gender, age_group, garment_type, source,
--            jsonb_array_length(rows) AS sizes, confidence, updated_at
--       FROM store_size_charts ORDER BY store_domain, garment_type, gender;
--
--   Which captures the room will actually read (store-wide, active):
--     SELECT store_domain, gender, age_group, garment_type
--       FROM store_size_charts WHERE status = 'active' AND product_key = '';
