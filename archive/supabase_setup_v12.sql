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
  ADD COLUMN IF NOT EXISTS primary_color_hex TEXT;

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
