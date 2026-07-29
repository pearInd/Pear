-- =============================================================================
-- PEAR · Supabase Setup V9 - garment_cache deduplication by canonical URL
-- =============================================================================
--
-- THE BUG THIS FIXES
-- ──────────────────
-- garment_cache keyed on the RAW image_url, and both writers (server.js's
-- /api/classify-images and scanner/scan-store.js) read with `.eq("image_url", …)`.
-- Storefront CDNs serve ONE photograph under many URLs:
--
--     …/tee-1.jpg?v=1699&width=1400      ← what the PDP renders
--     …/tee-1.jpg?v=1699&width=800       ← what the thumbnail strip renders
--     …/tee-1_800x.jpg                   ← what an older theme build emitted
--
-- Each spelling missed the cache, was classified independently, and was written as
-- its OWN row. Three consequences, in increasing order of damage:
--
--   1. Wasted Gemini calls and cache bloat.
--   2. CONFLICTING classifications for a single photograph - the same image can
--      legitimately classify differently at 800px vs 1400px (less detail, a cropped
--      neck label), so one row says 'front' and another says 'back'.
--   3. That conflict is then read back as "this product has a front AND a back",
--      and the try-on binds ONE photograph as both views. The model is handed the
--      front image with "reproduce the BACK" steering, and renders the chest print
--      on the back - the reported symptom.
--
-- The fix is a canonical key: one row per PHOTOGRAPH, not per URL spelling.
-- canonical_url mirrors canonicalImageUrl() in server.js / fitting-room/app.js and
-- canonicalPhoto() in widget/pear-widget.js - all four must stay in lockstep.
--
-- ORDER MATTERS: existing duplicates are collapsed BEFORE the unique index is
-- created, or the index creation fails on the very rows it is meant to prevent.
--
-- SAFE TO RUN ON A LIVE TABLE. Requires V8 (source/confidence columns) - run that
-- first if you have not. Both writers degrade gracefully if this has not been run.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.  3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS canonical_url TEXT;

-- ── 1. Canonicaliser, matching the JS implementations ────────────────────────
-- Strips: protocol + host case, presentation/cache query params, CDN size suffixes
-- in the filename, and the fragment. Resizer endpoints (…?url=<real asset>) reduce
-- to the wrapped asset, which is where their identity actually lives.
CREATE OR REPLACE FUNCTION pear_canonical_url(raw TEXT) RETURNS TEXT AS $$
DECLARE
  u TEXT := raw;
  inner_url TEXT;
BEGIN
  IF u IS NULL OR u = '' THEN RETURN NULL; END IF;
  IF u LIKE 'data:%' OR u LIKE 'blob:%' THEN RETURN u; END IF;

  -- Image resizer: identity is the wrapped url= parameter, not the endpoint path.
  inner_url := (regexp_match(u, '[?&]url=([^&]+)'))[1];
  IF inner_url IS NOT NULL THEN
    inner_url := replace(replace(replace(inner_url, '%2F', '/'), '%3A', ':'), '%2f', '/');
    IF inner_url LIKE 'http%' THEN
      RETURN pear_canonical_url(inner_url);
    END IF;
    -- Root-relative wrapped path: resolve against the resizer's own origin.
    RETURN pear_canonical_url((regexp_match(u, '^(https?://[^/]+)'))[1] || inner_url);
  END IF;

  u := split_part(u, '#', 1);                                  -- drop fragment
  u := regexp_replace(u, '^http://', 'https://');               -- protocol
  -- Presentation / cache-busting params.
  u := regexp_replace(u, '([?&])(width|height|w|h|size|quality|q|dpr|format|fm|crop|fit|scale|v|ver|version|t|cache|_)=[^&]*', '\1', 'gi');
  u := regexp_replace(u, '[?&]+$', '');
  u := regexp_replace(u, '\?&+', '?');
  u := regexp_replace(u, '&&+', '&', 'g');
  -- CDN size suffix in the filename (Shopify named + WxH, WooCommerce -WxH).
  u := regexp_replace(u, '_(pico|icon|thumb|small|compact|medium|large|grande|master|[0-9]{1,4}x([0-9]{1,4})?)(_crop_[a-z]+)?(\.(jpe?g|png|webp|gif))', '\4', 'i');
  u := regexp_replace(u, '-([0-9]{2,3})x([0-9]{2,3})(\.(jpe?g|png|webp|gif))', '\3', 'i');
  RETURN lower(u);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── 2. Backfill ──────────────────────────────────────────────────────────────
UPDATE garment_cache SET canonical_url = pear_canonical_url(image_url)
WHERE canonical_url IS NULL;

-- ── 3. INSPECT the damage before deleting anything ───────────────────────────
-- Run this on its own first. Every row here is one photograph stored more than
-- once; `distinct_classes = 2` marks the actively harmful ones - a single photo
-- the cache currently claims is BOTH the front and the back.
SELECT
  canonical_url,
  COUNT(*)                                  AS duplicate_rows,
  COUNT(DISTINCT classification)            AS distinct_classes,
  array_agg(DISTINCT classification)        AS classes,
  array_agg(DISTINCT source)                AS sources,
  max(confidence)                           AS best_confidence
FROM garment_cache
GROUP BY canonical_url
HAVING COUNT(*) > 1
ORDER BY distinct_classes DESC, duplicate_rows DESC
LIMIT 100;

-- ── 4. Collapse duplicates - keep the single most trustworthy row ────────────
-- Ranking, highest priority first:
--   a. source trust: a storefront's own markup beats a model verdict, which beats
--      an ambiguous one, which beats a rate-limit default or a pre-V8 legacy row;
--   b. confidence, descending;
--   c. most recently updated.
-- This resolves a front/back conflict deterministically instead of leaving the
-- winner to whichever row a query happened to return first.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY canonical_url
           ORDER BY
             CASE source
               WHEN 'dom_hint'  THEN 1
               WHEN 'gemini'    THEN 2
               WHEN 'synthetic' THEN 3
               WHEN 'uncertain' THEN 4
               WHEN 'fallback'  THEN 5
               ELSE 6                      -- 'legacy' and anything unknown
             END,
             confidence DESC NULLS LAST,
             updated_at DESC NULLS LAST,
             id DESC
         ) AS rn
  FROM garment_cache
)
DELETE FROM garment_cache
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 5. Enforce it from here on ───────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_garment_cache_canonical ON garment_cache (canonical_url);

-- Keep canonical_url correct no matter which writer inserts, including any older
-- deploy still writing only image_url.
CREATE OR REPLACE FUNCTION garment_cache_canonicalise() RETURNS trigger AS $$
BEGIN
  IF NEW.canonical_url IS NULL OR NEW.canonical_url = '' THEN
    NEW.canonical_url := pear_canonical_url(NEW.image_url);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_garment_cache_canonicalise ON garment_cache;
CREATE TRIGGER trg_garment_cache_canonicalise
  BEFORE INSERT OR UPDATE ON garment_cache
  FOR EACH ROW EXECUTE FUNCTION garment_cache_canonicalise();


-- =============================================================================
-- VERIFY
-- =============================================================================

-- Must return zero rows.
SELECT canonical_url, COUNT(*) FROM garment_cache
GROUP BY canonical_url HAVING COUNT(*) > 1;

-- One front + one back per product, which is what the try-on pipeline consumes.
-- Anything with backs = 0 is genuinely single-view and is served by the generated
-- rear view (synthesizeBackView) rather than by a duplicate row pretending to be one.
SELECT
  product_url,
  COUNT(*) FILTER (WHERE classification = 'front') AS fronts,
  COUNT(*) FILTER (WHERE classification = 'back')  AS backs
FROM garment_cache
WHERE product_url IS NOT NULL
GROUP BY product_url
ORDER BY backs ASC, fronts DESC
LIMIT 50;
