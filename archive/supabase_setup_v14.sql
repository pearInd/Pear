-- =============================================================================
-- PEAR · Supabase Setup V14 - colourway-scoped back recovery (garment_cache.variant_key)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THE BUG: back recovery was keyed by PRODUCT (product_url), so a product with several
-- colours could hand a black tee a navy tee's rear photo - and in practice it never ran
-- at all: the classify endpoint never wrote product_url, and the lookup compared the
-- shopper's full page URL to the scanner's /products/<handle> URL by exact equality.
--
-- WHY NOT A RAW SHOPIFY variant_id. A Shopify variant is COLOUR x SIZE. The same black
-- tee in M and in L are two variant ids that share every photo, so a raw variant id
-- would (a) never let an M visit recover what an L visit cached, and (b) re-tag every
-- shared photo with whichever size was viewed last. The key is the variant with its
-- SIZE option removed:
--
--     variant_key = "<shopify product id>:<every non-size option value, lowercased, '/'-joined>"
--     e.g.  8123456789:black        8123456789:navy        8123456789:black/organic
--
-- Computed identically by widget/pear-widget.js (variantKeyOf, from product.js) and
-- scanner/scan-store.js (variantKeyOf, from products.json) - keep the two in lockstep;
-- test/garment-cache-access.test.mjs asserts they agree. The size option is the one
-- Shopify NAMES "size" / "מידה"; a store using another name keeps size in the key, which
-- only lowers the hit rate - it never mixes colours.
--
-- WHO WRITES IT (never an INSERT - only an UPDATE of a row that already exists)
--   · server.js tagVariantBack(): after a classify request that carried a variant_key,
--     the rear photo resolved ON THAT VISIT from real evidence (back_source "dom" or
--     "classifier") is tagged. Recovery can therefore only replay a back this same
--     colourway has already been rendered with.
--   · scanner/scan-store.js: single-colour products tag every photo; multi-colour
--     products tag only photos Shopify assigns to exactly one colourway.
--
-- ONE COLUMN, ONE KEY PER PHOTO. canonical_url is unique (V9), so a photo genuinely
-- shared by two colourways carries whichever tagged it last. That is a MISS for the
-- other colourway (it falls back to a generated rear, as before), never a wrong colour.
--
-- DEPENDS ON: V8 (source, confidence), V9 (canonical_url). See supabase_setup_v13.sql
-- for the full catch-up run order; run this after V13.
--
-- HOW TO RUN
-- ──────────
-- Supabase → the project named by the server's SUPABASE_URL → SQL Editor → paste → Run.
-- Safe on a live database and re-runnable.
-- =============================================================================

ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS variant_key TEXT;

-- The recovery lookup is `WHERE variant_key = $1`; canonical_url rides along so the
-- per-photo dedupe in getVariantViews() reads from the index.
CREATE INDEX IF NOT EXISTS idx_garment_cache_variant_key
  ON garment_cache (variant_key, canonical_url)
  WHERE variant_key IS NOT NULL;

COMMENT ON COLUMN garment_cache.variant_key IS
  'Colourway this photo belongs to: "<shopify product id>:<non-size option values>". NULL = not attributed. Written by tagVariantBack (server) and the scanner; read by getVariantViews for back recovery.';

-- Verify (read-only): expect one row, data_type text.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'garment_cache' AND column_name = 'variant_key';
