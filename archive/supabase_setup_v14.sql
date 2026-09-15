-- =============================================================================
-- PEAR · Supabase Setup V14 - size_run_type on garment_cache
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THE BUG: "the numeric jeans sizing logic incorrectly applies to sports pants and
-- other garments that use alphabetic sizing."
--
-- fitting-room/app.js's isPantsProduct() correctly identifies a pair of sweatpants
-- as a lower-body garment from its TITLE alone ("sweatpants" is a bottoms noun) even
-- when the product's own size run is S/M/L, not numeric. Before this shipped,
-- pantsChartForSizes()'s "no confidently-numeric run" case defaulted straight to
-- ADULT_JEANS_WAIST_CHART (the waist-inch ladder written for 28/30/32 jeans) - the
-- same default that correctly rescues a jeans product whose picker is rendered in
-- JavaScript (nothing to scrape) now ALSO caught a garment whose size run genuinely
-- is letters. The shopper was quoted a bare waist-inch number ("32") for a product
-- whose own picker only ever offers S/M/L.
--
-- app.js closes the common case for free: isAlphaSizeRun() reads the SAME size list
-- already scraped this visit and vetoes the waist chart outright when it is
-- confidently letters. But that only works when the size picker actually scraped -
-- a JS-rendered control that hasn't hydrated yet on THIS page load scrapes to
-- nothing, exactly the case pantsChartForSizes()'s waist-chart default exists for.
-- When a PREVIOUS visit's scrape succeeded, that answer is worth remembering rather
-- than re-guessing (or mis-guessing) every single time - the same reasoning
-- archive/supabase_setup_v13.sql already applied to the Gemini vision category tier.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ───────────────────────────────────────────────
--   Adds ONE nullable column to `garment_cache`:
--
--     size_run_type TEXT DEFAULT NULL
--       'numeric'  the product's own size run is confidently numeric (waist inches
--                  or an EU ladder) - see pear-widget.js: classifySizeRunType().
--       'alpha'    the product's own size run is confidently letters (S/M/L/XL/...).
--       NULL       never recorded. NOT the same as "unknown" - see below.
--
-- UNLIKE garment_category, "unknown" IS NEVER WRITTEN HERE.
-- ────────────────────────────────────────────────────────────────────────────────
--   garment_category's "unknown" is a real verdict (the model looked and declined),
--   and v13 deliberately caches it so the endpoint does not re-ask forever. This
--   column has no model call behind it at all - "unknown" here only ever means "the
--   widget's DOM scrape found nothing readable THIS visit", which says nothing about
--   whether it will fail again next visit (the JS-rendered control may simply not
--   have hydrated in time). Caching that as a permanent verdict would freeze a
--   product on the wrong chart the first time its picker was slow to render. Only
--   'numeric' and 'alpha' - genuine, confidently-read size lists - are ever written
--   (see server.js: saveClassification()'s v14Fields and getCachedSizeRunType()).
--
-- KEYED BY product_url, NOT canonical_url, ON READ.
-- ────────────────────────────────────────────────────────────────────────────────
--   The size run belongs to the PRODUCT, not to any one photograph - a later visit's
--   reference image can be a different photo of the same product and must still get
--   the same answer. The column lives on the same per-photo row every other
--   garment_cache column does (there is no per-product table to put it on instead),
--   but getCachedSizeRunType() reads it by product_url, mirroring getProductViews()
--   beside it - not by canonical_url the way garment_category is read.
--
-- SAFE TO SHIP THE CODE FIRST. saveClassification() and
-- getCachedClassificationDetailed() in server.js degrade one migration tier at a
-- time (V14 -> V13 -> V12 -> V11 -> V8 -> bare V5) on the "column does not exist"
-- error, so the deploy works before this SQL runs; only the cached size-run-type
-- sits idle until the column exists, and the size calculator falls back to the
-- size-run and title tiers it already had.
--
-- ⚠ THIS MIGRATION DEPENDS ON V8 - RUN V8 THROUGH V13 FIRST ON A FRESH DATABASE.
-- ────────────────────────────────────────────────────────────────────────────────
-- getCachedSizeRunType() reads this column BY product_url (see its own comment
-- above), and product_url itself is a V8 column, not a V5 one - a database that
-- only ever ran supabase_setup.sql/V5 (garment_cache created as bare
-- image_url + classification) does not have it yet. Running V14 alone on such a
-- database fails at the CREATE INDEX below with:
--   ERROR: 42703: column "product_url" does not exist
-- That error means exactly what it says - V8 (and everything after it) has not
-- been applied yet, NOT that this migration named the wrong column. Run, in order:
--   supabase_setup_v8.sql, v9.sql, v10.sql, v11.sql, v12.sql, v13.sql, THEN v14.sql.
-- The index below is still guarded defensively (skips itself with a NOTICE rather
-- than erroring) so a V14-before-V8 run leaves the size_run_type COLUMN in place
-- even if the index has to wait - but size_run_type is inert without product_url
-- to query it by, so the actual fix is running the missing migrations, not relying
-- on the guard.
-- =============================================================================

ALTER TABLE garment_cache
  ADD COLUMN IF NOT EXISTS size_run_type TEXT DEFAULT NULL;

-- Deliberately permits NULL (never recorded) and deliberately NOT a NOT NULL column
-- with a default - see the note above on why "unknown" must never be backfilled or
-- written at all.
ALTER TABLE garment_cache
  DROP CONSTRAINT IF EXISTS garment_cache_size_run_type_chk;
ALTER TABLE garment_cache
  ADD CONSTRAINT garment_cache_size_run_type_chk
  CHECK (size_run_type IS NULL OR size_run_type IN ('numeric', 'alpha'));

COMMENT ON COLUMN garment_cache.size_run_type IS
  'Numeric ("28/30/32") vs alphabetic ("S/M/L") size run, read from the storefront''s '
  'own picker at scan time: numeric|alpha. NULL = never recorded (a genuine cache '
  'miss, not "checked and unreadable" - see archive/supabase_setup_v14.sql on why '
  '"unknown" is never written here). Read by product_url, not canonical_url - the '
  'size run belongs to the product, not to one photograph.';

-- Index for the read path: getCachedSizeRunType() filters on product_url with
-- size_run_type NOT NULL. A plain product_url index already exists from v8 for
-- getProductViews(); this one is scoped to the (much smaller) set of rows that
-- actually carry a size-run verdict.
--
-- GUARDED, NOT a bare CREATE INDEX: product_url is a V8 column (see the ⚠ note
-- above), so a database that hasn't run V8 yet does not have it, and an
-- unconditional CREATE INDEX ... ON garment_cache (product_url) fails the whole
-- script with "column product_url does not exist" - the exact error this guard
-- exists to avoid. Skips itself with a NOTICE instead, so size_run_type's own
-- ADD COLUMN above still lands even when the prerequisite migrations are missing;
-- re-run this file (or just this DO block) after V8 has been applied to actually
-- get the index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'garment_cache' AND column_name = 'product_url'
  ) THEN
    CREATE INDEX IF NOT EXISTS garment_cache_size_run_type_idx
      ON garment_cache (product_url)
      WHERE size_run_type IS NOT NULL;
  ELSE
    RAISE NOTICE 'garment_cache.product_url does not exist yet (run supabase_setup_v8.sql first) - skipping garment_cache_size_run_type_idx for now';
  END IF;
END $$;

-- ── DIAGNOSTIC: products now routed off the numeric-pants default by evidence ────
--   SELECT product_url, size_run_type, count(*) AS photos
--     FROM garment_cache
--    WHERE size_run_type IS NOT NULL
--    GROUP BY product_url, size_run_type
--    ORDER BY product_url;
