-- =============================================================================
-- PEAR · Supabase Setup V11 - kids/adult classification on garment_cache
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- The size calculator can now recommend children's sizes (CHILD_SIZE_CHART in
-- fitting-room/app.js) as well as adult S/M/L/XL. So far the only signal that
-- picks which chart applies is the VISITOR's own age (pickSizeCategory() in
-- app.js) - nothing yet says whether the PRODUCT itself is kids' or adult
-- clothing. This migration adds storage for that second, independent signal.
--
-- The classifier that already runs on every product photo - classifyFrontBack-
-- Detailed() in server.js, which decides front vs. back via Gemini - is extended
-- to ALSO report a kids-vs-adult verdict in the SAME model call (see the extended
-- FRONT_BACK_SYSTEM_PROMPT and responseSchema). This migration gives that verdict
-- somewhere to live, following the exact shape V8 used for the front/back verdict:
-- a value column paired with a confidence column, so the classification can be
-- trusted-or-distrusted downstream the same way front/back already is.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   Adds `age_group` (TEXT: 'kids' | 'adult' | 'uncertain') and
--   `age_group_confidence` (REAL, 0.0-1.0) to `garment_cache`. Both nullable -
--   NULL means "not yet classified under this migration", not "adult" or any
--   other default. saveClassification()/getCachedClassificationDetailed() in
--   server.js degrade gracefully when these columns are absent, so this deploy
--   is safe to ship BEFORE this SQL runs (existing front/back caching keeps
--   working; only the age-group verdict is skipped until the columns exist).
--
-- NOTE ON SCOPE: unlike V7/V10 (users.age - an explicit fact the VISITOR states),
-- age_group here is a MODEL INFERENCE about the PRODUCT PHOTO, cached exactly
-- like the front/back verdict it rides alongside - re-classified only when the
-- photo itself is new, not on every request.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS age_group            TEXT;
ALTER TABLE garment_cache ADD COLUMN IF NOT EXISTS age_group_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_garment_cache_age_group ON garment_cache (age_group);
