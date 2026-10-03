-- =============================================================================
-- PEAR · Supabase Setup V16 - store_size_charts keeps EVERY chart a store publishes
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- v15 keyed a store's charts on (store_domain, gender, age_group, garment_type,
-- product_key, source). A store very often publishes TWO charts for one audience and
-- garment type - one per size system: castro.com's women's guide is a single block
-- holding an EU 32-46 table AND an XS-XL table, both women/adult/tops. Under the v15
-- key they collide, so the scanner had to pick one and drop the other (it kept the
-- size system the garment type is "conventionally" sold in - a guess about which one
-- the room could use). The dropped chart was never stored at all.
--
-- `size_system` (alpha | numeric | mixed | unknown) has been a column since v15; this
-- migration only puts it IN THE KEY, so an alpha and a numeric chart for the same
-- audience/type are two rows. The room chooses between them per product, by which one
-- actually shares sizes with that product's own size list
-- (fitting-room/app.js: pickStoredSizeChart).
--
-- WHAT THIS DOES (safe to run on a live database, safe to run twice)
-- ──────────────────────────────────────────────────────────────────
--   1. Adds a CHECK on size_system's values (dropped-then-added, so a re-run replaces it).
--   2. Creates the NEW unique key, including size_system.
--   3. Drops the OLD v15 unique key. It must go: while it exists, a second chart for the
--      same (gender, age_group, garment_type, product_key, source) still violates it.
--   Every existing row already satisfies the new key (it is the old key plus a column),
--   so step 2 cannot fail on existing data. No row is changed or deleted.
--
-- ORDER WITH THE CODE
-- ───────────────────
--   · The scanner's --save now upserts with onConflict on the NEW key. Before this
--     migration runs, Postgres answers 42P10 ("no unique or exclusion constraint
--     matching the ON CONFLICT specification"); the scanner prints "run
--     archive/supabase_setup_v16.sql" and writes NOTHING (scanner/size-charts.js:
--     saveSizeChartRecords). It never falls back to the old key - that would overwrite
--     the very charts this migration exists to keep.
--   · GET /api/store-size-chart and the room are unaffected by the order: they read
--     every active store-wide row and never depended on the key.
--   · After running it, re-run --save for each captured store so charts the old key
--     dropped are written:
--       node scanner/scan-store.js --size-charts --save https://www.fox.co.il
--       node scanner/scan-store.js --size-charts --save https://www.castro.com
--       node scanner/scan-store.js --size-charts --save https://www.adidas.co.il
-- =============================================================================

ALTER TABLE store_size_charts DROP CONSTRAINT IF EXISTS store_size_charts_size_system_chk;
ALTER TABLE store_size_charts ADD CONSTRAINT store_size_charts_size_system_chk
  CHECK (size_system IN ('alpha', 'numeric', 'mixed', 'unknown'));

-- The upsert target (scanner: onConflict
-- "store_domain,gender,age_group,garment_type,size_system,product_key,source").
CREATE UNIQUE INDEX IF NOT EXISTS store_size_charts_key_v16_idx
  ON store_size_charts (store_domain, gender, age_group, garment_type, size_system, product_key, source);

DROP INDEX IF EXISTS store_size_charts_key_idx;

COMMENT ON COLUMN store_size_charts.size_system IS
  'alpha | numeric | mixed | unknown - part of the unique key since v16, so a store''s '
  'letter and numeric charts for one audience/garment type are both kept.';

-- ── DIAGNOSTICS ─────────────────────────────────────────────────────────────────
--   Confirm the key moved (expect store_size_charts_key_v16_idx, and NO store_size_charts_key_idx):
--     SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'store_size_charts';
--
--   Stores that now carry more than one chart for one audience/type:
--     SELECT store_domain, gender, age_group, garment_type, array_agg(size_system) AS systems
--       FROM store_size_charts WHERE status = 'active' AND product_key = ''
--      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
