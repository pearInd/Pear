-- =============================================================================
-- PEAR · Supabase Setup V12 - duplicate-panel validation on garment_cache
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THE BUG: "the back view shows the chest logo again."
--
-- Until now the only duplicate test protecting the back reference was
-- sameImage()/canonicalImageUrl() - a URL-identity check. It correctly catches
-- `shirt.jpg` vs `shirt_800x.jpg` vs `shirt?width=1400`: one photograph under
-- three spellings, which is what V9 exists to record.
--
-- It cannot catch the case actually reported. A storefront ships TWO GENUINELY
-- DIFFERENT PHOTOGRAPHS OF THE SAME SIDE - a straight-on front packshot and a
-- second front shot at a slight angle, different crop, different file, different
-- bytes. canonicalImageUrl() correctly reports two distinct photos, so the
-- `!sameImage()` guard passes. If the front/back classifier then labels the
-- angled one "back" - a turned shoulder over an occluded placket is precisely
-- the weak-cue case FRONT_BACK_SYSTEM_PROMPT warns about - the FRONT gets bound
-- as the BACK reference. The shopper turns around in the fitting room and sees
-- the chest graphic on their back: the same visible symptom as the positional-
-- guessing bug in CLAUDE.md §2.1, reached from a completely different direction.
--
-- This migration stores the evidence needed to veto that binding from the
-- PIXELS rather than from the URL.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   Adds three nullable columns to `garment_cache`, all populated by the SAME
--   Gemini call that already classifies front/back and kids/adult (see the
--   extended FRONT_BACK_SYSTEM_PROMPT and responseSchema in server.js) - this is
--   not a second model call:
--
--     text_ocr           TEXT  - the garment's own lettering, transcribed
--                                verbatim. Two photos whose transcriptions match
--                                are the same side of the same garment, whatever
--                                either front/back verdict claims. This is the
--                                signal that catches the reported case: both
--                                panels read "BE YOUR OWN Healer WORLDWIDE"
--                                because both panels were the front.
--     is_true_back_view  BOOLEAN - the model's stricter, independent second
--                                opinion on its own `classification`. False
--                                whenever treating this photo as the definitive
--                                rear reference would be a mistake.
--     primary_color_hex  TEXT  - '#rrggbb' sampled from the garment's MAIN
--                                FABRIC. Consumed by synthesizeBackView() so a
--                                generated rear panel does not drift off the
--                                front's colour and read as a different garment
--                                mid-turn.
--
-- NULL IS LOAD-BEARING HERE - DO NOT BACKFILL IT WITH A DEFAULT.
-- ──────────────────────────────────────────────────────────────
--   For text_ocr, NULL and '' mean DIFFERENT things and the safety of the whole
--   check depends on the difference:
--       NULL = this photo was never asked / answered (pre-V12 row, DOM-hint row,
--              rate-limited fallback). validateBackCandidate() ABSTAINS.
--       ''   = the model looked and the garment carries no legible lettering.
--
--   A backfill of '' would make every unbranded garment in the catalog compare
--   EQUAL to every other unbranded garment - "two plain tees have equally empty
--   prints" is true - and would therefore veto every legitimate back panel on
--   the site. validateBackCandidate() only ever compares two NON-EMPTY
--   transcriptions for exactly this reason (CLAUDE.md §2.5: never block on
--   ambiguity; a wrong veto costs a real rear view).
--
--   Same for is_true_back_view: NULL is "not asked", not "denied". The veto
--   fires only on an explicit FALSE from a `source = 'gemini'` row, so a
--   pre-V12 row and a storefront-markup row are never penalised for evidence
--   nobody ever collected.
--
-- SAFE TO SHIP THE CODE FIRST. saveClassification() and
-- getCachedClassificationDetailed() in server.js degrade one migration tier at a
-- time (V12 -> V11 -> V8 -> bare V5) on the "column does not exist" error, so the
-- deploy works before this SQL runs; only the duplicate-panel veto and the
-- colour lock sit idle until the columns exist.
--
-- WHY THESE COLUMNS ARE CACHED AT ALL, rather than living only in the live
-- /api/classify-images response: that endpoint is CACHE-FIRST. A cached row
-- carrying no text_ocr would make the veto abstain on every repeat visit - it
-- would work exactly once per photograph, on the visit that happened to classify
-- it, and never again. That is the same shape as the pre-V8 bug where a row said
-- 'front' without recording whether that was a verdict or a throttled default.
-- =============================================================================

ALTER TABLE garment_cache
  ADD COLUMN IF NOT EXISTS text_ocr          TEXT,
  ADD COLUMN IF NOT EXISTS is_true_back_view BOOLEAN,
  ADD COLUMN IF NOT EXISTS primary_color_hex TEXT,
  ADD COLUMN IF NOT EXISTS has_graphic       BOOLEAN,
  ADD COLUMN IF NOT EXISTS classifier_version INTEGER;

-- ── classifier_version: WHY A PROMPT FIX USED TO CHANGE NOTHING ──────────────────────
--
-- /api/classify-images is CACHE-FIRST. A photo is classified once and every later visit
-- reads this table instead of asking Gemini. So a correction to the classifier prompt
-- never reached any photo that had already been classified - its old verdict was served
-- forever.
--
-- That is how a mislabelled rear photo survived several rounds of fixes. The prompt told
-- the model that "front graphic or lettering read the right way round" was a decisive
-- FRONT cue. A flat-lay photo of a garment's BACK satisfies that - the camera faces the
-- rear panel squarely, so its lettering reads correctly too. The real rear photo was
-- labelled front, no back was resolved, the server generated a plain one, and the shopper
-- turned around to smooth fabric in the garment colour with no artwork. Fixing the cue did
-- nothing for that product, because its wrong verdict was already in this table.
--
-- Every write now stamps CLASSIFIER_PROMPT_VERSION (server.js). A row carrying an OLDER
-- number, or NULL, is treated as a cache miss and re-classified on the next visit.
-- Existing rows get NULL when this column is added, so running this migration triggers a
-- ONE-TIME lazy refresh of the catalog: spread across real traffic (a product is
-- re-asked only when someone opens it) and rate-spaced per call.

-- ════════════════════════════════════════════════════════════════════════════════════
-- ⚠ BEFORE THIS MIGRATION RUNS: CLEAR THE ROWS FOR A SPECIFIC BROKEN PRODUCT BY HAND
-- ════════════════════════════════════════════════════════════════════════════════════
-- Until classifier_version exists, the server cannot tell a stale verdict from a current
-- one and deliberately treats every cached row as current (re-asking the whole catalog on
-- every visit would exhaust the Gemini rate limit on a merely pending migration). So a
-- product that was classified wrongly stays wrong until its rows are removed. Deleting
-- them forces a fresh classification against the corrected prompt on the next visit -
-- harmless, since the table is a cache and the source photos are untouched.
--
-- Find the product's rows first (substitute the PDP URL):
--
--   SELECT image_url, classification, confidence, source, cue
--     FROM garment_cache
--    WHERE product_url = 'https://<store>/products/<handle>';
--
-- A rear photo showing classification = 'front' is the fault. Then clear them:
--
--   DELETE FROM garment_cache
--    WHERE product_url = 'https://<store>/products/<handle>';
--
-- If product_url was never populated for this product, match the photos directly:
--
--   DELETE FROM garment_cache
--    WHERE image_url ILIKE '%<distinctive part of the photo filename>%';
--
-- A generated rear is ALSO persisted in Supabase Storage (bucket garment-synth-backs,
-- keyed by a hash of the front photo) and is served from there before any classification
-- runs. Once the real rear photo is correctly classified the server stops asking for a
-- synthetic one, so the stale generated file is simply never requested again - but if you
-- want it gone, delete that object from the bucket as well.

-- ── has_graphic, ADDED AFTER A LIVE BUG. READ THIS BEFORE USING text_ocr FOR ANYTHING ──
--
-- The fitting room needs to know whether a garment's rear panel is BLANK, so it can stop
-- telling Decart to "precisely lock the rear print, logos and back seams" on a garment
-- that has none (those nouns are positive tokens with no negative_prompt to hang them on,
-- so they instruct the model to invent rear graphics).
--
-- The first implementation answered that from text_ocr: back_is_plain = (text_ocr === "").
-- THAT WAS WRONG AND IT ERASED ARTWORK. text_ocr transcribes LETTERING. A rear panel
-- carrying a large PHOTOGRAPHIC print with no legible words transcribes to "" - so the
-- back was declared plain, the room selected its plain-back anchor ("The rear panel is
-- smooth unbroken fabric"), and the model was instructed to render a blank back over a
-- reference that had a mountain photo on it. Reported live: the shopper turned 180 and
-- got a generic plain back.
--
-- has_graphic asks the question directly: does this side carry ANY applied decoration -
-- print, photo, logo, embroidery, appliqué, all-over pattern, lettering, badge, number.
-- It is a SEPARATE verdict from text_ocr and the two are EXPECTED to disagree on exactly
-- the case above. Never infer one from the other.
--
-- IT ABSTAINS TO "DECORATED", unlike every other nullable column here, because its errors
-- are not symmetric: a garment wrongly called plain has its artwork erased from the
-- render, while one wrongly called decorated simply keeps today's wording. Only an
-- explicit FALSE is licence to call a side plain; NULL (pre-v12 row, older build,
-- rate-limited fallback) leaves the room's existing behaviour untouched.

-- '#rrggbb', lowercase, or NULL. normalizeHexColor() in server.js produces exactly
-- this shape and returns null for anything it cannot parse, so a malformed value
-- never reaches the column - the constraint is here to keep a future writer honest
-- rather than to catch today's one.
ALTER TABLE garment_cache
  DROP CONSTRAINT IF EXISTS garment_cache_primary_color_hex_chk;
ALTER TABLE garment_cache
  ADD CONSTRAINT garment_cache_primary_color_hex_chk
  CHECK (primary_color_hex IS NULL OR primary_color_hex ~ '^#[0-9a-f]{6}$');

COMMENT ON COLUMN garment_cache.text_ocr IS
  'Garment lettering transcribed by the front/back classifier. NULL = never asked (abstain); '''' = asked, garment is plain. Never backfill NULL to ''''.';
COMMENT ON COLUMN garment_cache.is_true_back_view IS
  'Stricter independent second opinion on `classification`. NULL = never asked. The duplicate-panel veto fires only on explicit FALSE from a gemini-sourced row.';
COMMENT ON COLUMN garment_cache.primary_color_hex IS
  'Main-fabric colour as #rrggbb, sampled from the garment body (not print/trim/background). Consumed by synthesizeBackView().';

-- ── DIAGNOSTIC: galleries where the resolved back repeats the front's graphic ──
-- The rows this migration exists to find. Any product appearing here shipped two
-- photos of the same side, and before V12 one of them could bind as the back.
-- After V12 these are vetoed at resolve time and logged as
-- "back REJECTED (front_text_repeated)".
--
--   SELECT f.product_url,
--          f.image_url AS front_url,
--          b.image_url AS suspect_back_url,
--          f.text_ocr
--     FROM garment_cache f
--     JOIN garment_cache b
--       ON b.product_url = f.product_url
--      AND b.canonical_url <> f.canonical_url
--    WHERE f.classification = 'front'
--      AND b.classification = 'back'
--      AND f.text_ocr IS NOT NULL AND f.text_ocr <> ''
--      AND lower(regexp_replace(f.text_ocr, '[^a-zA-Z0-9]+', ' ', 'g'))
--        = lower(regexp_replace(b.text_ocr, '[^a-zA-Z0-9]+', ' ', 'g'));

-- ── DIAGNOSTIC: backs the model itself would not stand behind ──
--   SELECT product_url, image_url, confidence, cue
--     FROM garment_cache
--    WHERE classification = 'back'
--      AND source = 'gemini'
--      AND is_true_back_view IS FALSE;

-- ── COVERAGE: how much of the cache predates V12 ──
--   SELECT count(*) FILTER (WHERE text_ocr IS NULL)          AS ocr_unknown,
--          count(*) FILTER (WHERE text_ocr = '')             AS ocr_plain,
--          count(*) FILTER (WHERE text_ocr > '')             AS ocr_present,
--          count(*) FILTER (WHERE primary_color_hex IS NULL) AS colour_unknown,
--          count(*)                                          AS total
--     FROM garment_cache;
