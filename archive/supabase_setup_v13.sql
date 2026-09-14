-- =============================================================================
-- PEAR · Supabase Setup V13 - garment_category on garment_cache
-- =============================================================================
--
-- ⚠ FILE NAME. The task this shipped under asked for "supabase_setup_v8.sql".
-- That file already exists and is a DIFFERENT migration (provenance columns:
-- confidence / source / cue / product_url / updated_at). Re-using the name would
-- have silently rewritten a migration that is already applied in production, so
-- this is V13 - the next free number after V12 - and nothing about V8 is touched.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THE BUG: "the size calculator recommends L for a pair of jeans."
--
-- A numeric-sized bottoms product (jeans sold 28/30/32/34/36) was being fitted
-- against ZARA_SIZE_CHART - the adult LETTER chart, which describes chest, not
-- waist. The shopper got "L" on a product whose size selector only ever shows
-- numbers, so the recommendation could not even be selected.
--
-- fitting-room/app.js already resolves that from two free, synchronous signals:
-- the product's own size run (24-48 integers can only be a waist) and its title
-- ("ג'ינס", "מכנס", "jeans", "pants"). Both abstain on a real catalog, though:
--   · a store that renders its size picker in JS ships no size list to scrape;
--   · a title like "STRAIGHT BASIC" or "LOOSE" names a CUT and a FIT and carries
--     no garment noun at all (this file's V12 sibling records the same report).
--
-- When both abstain the only remaining evidence is the PHOTOGRAPH, which Gemini
-- Vision can already read. This column is where that verdict is cached, for the
-- same reason every other verdict in this table is cached: /api/garment-category
-- is CACHE-FIRST, so a verdict that lived only in the live response would cost a
-- Gemini call on every single page view of every product.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ───────────────────────────────────────────────
--   Adds ONE nullable column to `garment_cache`:
--
--     garment_category TEXT DEFAULT NULL
--       'pants'   worn on the lower body - trousers, jeans, shorts, skirts,
--                 leggings. This is the value that routes the size calculator
--                 onto a waist chart instead of the letter chart.
--       'top'     worn on the upper body.
--       'dress'   covers both regions; deliberately NOT 'pants' (see below).
--       'unknown' the model looked and would not commit.
--       NULL      never asked. NOT the same as 'unknown'.
--
-- NULL vs 'unknown' IS LOAD-BEARING - DO NOT BACKFILL NULL WITH A DEFAULT.
-- ────────────────────────────────────────────────────────────────────────
--   NULL is the ONLY thing that makes GET /api/garment-category classify a row:
--   the endpoint treats NULL as a cache miss, calls Gemini, and upserts the
--   answer. 'unknown' is a real verdict and is served from cache like any other,
--   so a backfill of 'unknown' would permanently freeze every un-classified row
--   in the catalog as un-classifiable and the endpoint would never ask again.
--
--   Backfilling 'top' would be worse still, and in the exact shape CLAUDE.md §2.5
--   warns about: a guess that is indistinguishable from a verdict outranks the
--   room's own stronger classifier. Every pair of jeans in the cache would assert
--   "top" with the full authority of a model verdict, and the letter chart would
--   come straight back - the bug this migration exists to close, restored by its
--   own migration.
--
-- WHY 'dress' IS NOT FOLDED INTO 'pants'
-- ──────────────────────────────────────
--   A dress covers both regions and has no correct answer on a waist-vs-chest
--   question, which is exactly why resolveGarmentCategory() in app.js leaves
--   "dress" out of EXPLICIT_BOTTOM_TYPES. Storing it distinctly keeps it falling
--   through to the letter chart rather than being forced onto a waist ladder.
--
-- SAFE TO SHIP THE CODE FIRST. saveClassification() and
-- getCachedClassificationDetailed() in server.js degrade one migration tier at a
-- time (V13 -> V12 -> V11 -> V8 -> bare V5) on the "column does not exist" error,
-- so the deploy works before this SQL runs; only the cached category sits idle
-- until the column exists, and the size calculator falls back to the size-run and
-- title tiers it already had.
-- =============================================================================

ALTER TABLE garment_cache
  ADD COLUMN IF NOT EXISTS garment_category TEXT DEFAULT NULL;

-- Keeps a future writer honest. Deliberately permits NULL (never asked) and is
-- deliberately NOT a NOT NULL column with a default - see the note above on why
-- backfilling this column re-opens the bug it closes.
ALTER TABLE garment_cache
  DROP CONSTRAINT IF EXISTS garment_cache_garment_category_chk;
ALTER TABLE garment_cache
  ADD CONSTRAINT garment_cache_garment_category_chk
  CHECK (garment_category IS NULL
         OR garment_category IN ('pants', 'top', 'dress', 'unknown'));

COMMENT ON COLUMN garment_cache.garment_category IS
  'Body region the garment is worn on, from Gemini Vision: pants|top|dress|unknown. '
  'NULL = never asked (GET /api/garment-category treats it as a cache miss and classifies); '
  '''unknown'' = asked, model declined. Never backfill NULL - see archive/supabase_setup_v13.sql.';

-- Partial index over exactly the rows the backfill script scans. Tiny (it holds
-- only the un-classified rows) and it shrinks to nothing as the backfill drains
-- the NULLs, which is the access pattern:
--   node scripts/backfill-garment-categories.js
CREATE INDEX IF NOT EXISTS garment_cache_category_pending_idx
  ON garment_cache (image_url)
  WHERE garment_category IS NULL;

-- ── COVERAGE: how much of the cache still has no category ────────────────────
--   SELECT count(*) FILTER (WHERE garment_category IS NULL)      AS never_asked,
--          count(*) FILTER (WHERE garment_category = 'unknown')  AS declined,
--          count(*) FILTER (WHERE garment_category = 'pants')    AS pants,
--          count(*) FILTER (WHERE garment_category = 'top')      AS tops,
--          count(*) FILTER (WHERE garment_category = 'dress')    AS dresses,
--          count(*)                                              AS total
--     FROM garment_cache;

-- ── DIAGNOSTIC: products the size calculator can now route off the letter chart ──
--   SELECT product_url, image_url, garment_category
--     FROM garment_cache
--    WHERE garment_category = 'pants'
--    ORDER BY product_url;
