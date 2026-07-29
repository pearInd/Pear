-- =============================================================================
-- PEAR · Supabase Setup V8 - garment_cache provenance + back-view diagnostics
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- V5 created garment_cache as (image_url, classification). That shape cannot
-- answer the one question that matters when a shopper turns around and the back
-- of the garment doesn't render: WHY is this row "front"?
--
-- Three completely different bugs produce an identical "front" row today:
--
--   1. The crawl never found a back image  - the store ships one photo, or the
--      scraper only ever saw the front (lazy-loaded gallery). Nothing is wrong
--      with the classifier; there is simply no rear asset in the catalog.
--   2. Gemini misclassified a real back as front - the old prompt explicitly
--      instructed "if this is a detail shot, side view, or lifestyle image,
--      answer 'front' as default", so a rear photo at a slight angle, cropped,
--      or worn by a model in a lifestyle setting was rounded to "front".
--   3. The rate-limit / error fallback fired - server.js and scan-store.js both
--      pushed "front" on a failed or 429'd Gemini call. That is a DEFAULT, not
--      a verdict, and it was indistinguishable from a real one.
--
-- Fix 1 is a scraper change (widget/pear-widget.js lazy-attribute extraction).
-- Fix 2 is a prompt change (FRONT_BACK_SYSTEM_PROMPT in server.js).
-- Fix 3 is THIS migration: record the provenance so the three are separable.
--
-- Columns added:
--   confidence  0..1 from the model; NULL for rows written before V8.
--   source      how the value was arrived at:
--                 'gemini'     a real model verdict (confidence is meaningful)
--                 'uncertain'  model declined to commit; stored as front, NOT a verdict
--                 'dom_hint'   the storefront's own markup named the view
--                 'synthetic'  a generated rear view (see synthesizeBackView)
--                 'fallback'   classification failed/was throttled - a DEFAULT
--                 'legacy'     written before this migration; provenance unknown
--   cue         the single visual cue the model says decided it (audit trail)
--   product_url groups a product's photos so "which products have zero backs"
--               becomes answerable. NULL until the scanner backfills it.
--   updated_at  so a re-classification is visible as a change, not an overwrite.
--
-- SAFE TO RUN ON A LIVE TABLE: every column is nullable or defaulted, and
-- server.js degrades to the V5 column set if this hasn't been applied yet.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS confidence  REAL;
ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS cue         TEXT;
ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS product_url TEXT;
ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- Deliberately NOT a CHECK constraint: a new source value shipped by the server
-- must never start failing writes (which would silently disable the cache).
CREATE INDEX IF NOT EXISTS idx_garment_cache_source      ON garment_cache (source);
CREATE INDEX IF NOT EXISTS idx_garment_cache_product_url ON garment_cache (product_url);
CREATE INDEX IF NOT EXISTS idx_garment_cache_class       ON garment_cache (classification);

-- Keep updated_at honest on re-classification.
CREATE OR REPLACE FUNCTION garment_cache_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_garment_cache_touch ON garment_cache;
CREATE TRIGGER trg_garment_cache_touch
  BEFORE UPDATE ON garment_cache
  FOR EACH ROW EXECUTE FUNCTION garment_cache_touch();


-- =============================================================================
-- DIAGNOSTIC QUERIES - run these in order when a back view doesn't render.
-- They are ordered so each one rules out one of the three causes above.
-- =============================================================================

-- ── D0. Health overview: is this a catalog problem or a classifier problem? ──
-- A healthy store lands somewhere near 40-50% back. Under ~10% means the crawl
-- is not finding rear photos (cause 1) or is mislabeling them (cause 2).
SELECT
  classification,
  source,
  COUNT(*)                                   AS rows,
  ROUND(AVG(confidence)::numeric, 3)         AS avg_confidence,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM garment_cache
GROUP BY classification, source
ORDER BY rows DESC;


-- ── D1. CAUSE 1 - back images entirely missing from the crawl ───────────────
-- Products whose every cached photo is a front. These are single-view products:
-- nothing was misclassified, there is simply no rear asset. This is the set the
-- generated-rear fallback (synthesizeBackView) exists to serve.
-- Requires product_url to be populated by the scanner; see D1b for the fallback.
SELECT
  product_url,
  COUNT(*)                                              AS images,
  COUNT(*) FILTER (WHERE classification = 'back')        AS backs,
  MIN(created_at)                                       AS first_seen
FROM garment_cache
WHERE product_url IS NOT NULL
GROUP BY product_url
HAVING COUNT(*) FILTER (WHERE classification = 'back') = 0
ORDER BY images DESC
LIMIT 100;

-- ── D1b. Same question without product_url, grouped by the CDN asset id ─────
-- Storefront CDNs (Shopify included) embed a per-product numeric id in the path,
-- which is the same heuristic pear-widget.js uses to group a gallery. Works on
-- rows the scanner wrote before product_url existed.
WITH grouped AS (
  SELECT
    COALESCE((regexp_match(image_url, '(\d{6,})'))[1], image_url) AS product_key,
    classification
  FROM garment_cache
)
SELECT product_key,
       COUNT(*)                                        AS images,
       COUNT(*) FILTER (WHERE classification = 'back') AS backs
FROM grouped
GROUP BY product_key
HAVING COUNT(*) > 1 AND COUNT(*) FILTER (WHERE classification = 'back') = 0
ORDER BY images DESC
LIMIT 100;


-- ── D2. CAUSE 2 - Gemini misclassified a back as front ──────────────────────
-- Rows the model committed to but was not confident about. These are the prime
-- re-classification candidates under the V8 prompt; a real rear photo that the
-- old prompt rounded to "front" shows up here.
SELECT image_url, classification, confidence, cue, updated_at
FROM garment_cache
WHERE source = 'gemini'
  AND confidence IS NOT NULL
  AND confidence < 0.75
ORDER BY confidence ASC
LIMIT 100;

-- ── D2b. The smoking gun for cause 2: the URL says back, the row says front ──
-- The storefront's own filename/alt named it a rear photo and the classifier
-- disagreed. Every row here is a misclassification until proven otherwise.
SELECT image_url, classification, confidence, source, cue
FROM garment_cache
WHERE classification = 'front'
  AND (
    image_url ~* '(^|[^a-z0-9])(back|backside|rear)([^a-z0-9]|$)'
    OR image_url ~* '[_\-.](b|bk|back|rear)[_\-.]?[0-9]*\.(jpe?g|png|webp)'
  )
ORDER BY updated_at DESC
LIMIT 100;

-- ── D2c. Rows the V8 prompt refused to commit to ────────────────────────────
-- Stored as 'front' to satisfy the V5 CHECK constraint, but flagged. These were
-- INVISIBLE before V8 - they looked like ordinary front verdicts.
SELECT image_url, confidence, cue, updated_at
FROM garment_cache
WHERE source = 'uncertain'
ORDER BY updated_at DESC
LIMIT 100;


-- ── D3. CAUSE 3 - the rate-limit / error fallback defaulted a row to front ───
-- Any row here is NOT a verdict. server.js no longer caches fallbacks at all, so
-- a non-empty result means either an old row or the scanner is being throttled.
SELECT image_url, classification, confidence, cue AS error, updated_at
FROM garment_cache
WHERE source = 'fallback'
ORDER BY updated_at DESC
LIMIT 100;

-- ── D3b. Throttling leaves a time signature: a burst of same-second writes ───
-- A crawl that hit Gemini's 60 RPM ceiling writes a dense cluster of rows whose
-- classification is uniformly 'front'. Buckets that are 100% front AND dense are
-- the fingerprint.
SELECT
  date_trunc('minute', created_at)                        AS minute,
  COUNT(*)                                                AS rows,
  COUNT(*) FILTER (WHERE classification = 'front')        AS fronts,
  COUNT(*) FILTER (WHERE classification = 'back')         AS backs
FROM garment_cache
GROUP BY 1
HAVING COUNT(*) >= 20 AND COUNT(*) FILTER (WHERE classification = 'back') = 0
ORDER BY minute DESC
LIMIT 50;


-- ── D4. Force a re-classification of the suspect rows ───────────────────────
-- Deleting a row is how you re-classify: both the scanner and /api/classify-images
-- are cache-first, so the next visit re-runs Gemini under the V8 prompt and writes
-- a fresh verdict with provenance. Reviewed manually first - run D2/D2b/D2c above
-- and confirm the list before deleting.
--
-- DRY RUN (count what would go):
SELECT COUNT(*) AS would_reclassify
FROM garment_cache
WHERE source IN ('fallback', 'legacy', 'uncertain')
   OR (source = 'gemini' AND confidence < 0.75);
--
-- THE DELETE (uncomment to run):
-- DELETE FROM garment_cache
-- WHERE source IN ('fallback', 'legacy', 'uncertain')
--    OR (source = 'gemini' AND confidence < 0.75);


-- ── D5. Trace ONE product end-to-end ────────────────────────────────────────
-- Paste the numeric asset id (or any URL fragment) from the failing PDP.
-- Expected on a working product: at least one 'front' AND one 'back' row.
SELECT image_url, classification, confidence, source, cue, created_at, updated_at
FROM garment_cache
WHERE image_url ILIKE '%PASTE_PRODUCT_ID_HERE%'
ORDER BY classification, confidence DESC NULLS LAST;
