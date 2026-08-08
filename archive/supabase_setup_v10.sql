-- =============================================================================
-- PEAR · Supabase Setup V10 - age joins the profile (child vs adult sizing)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- The size calculator now recommends children's sizes (CHILD_SIZE_CHART in
-- fitting-room/app.js, numeric sizes 8-18) alongside the adult S/M/L/XL chart.
-- Age is what decides WHICH chart a visitor is scored against - see
-- pickSizeCategory(): below CHILD_AGE_MAX (16) → the kids chart, at or above →
-- the adult chart. Height/weight still choose the exact size within that chart.
--
-- An earlier iteration inferred the category from height/weight alone. That
-- guess misread real bodies - a petite adult at 150cm/50kg scored closer to kids
-- size 14 than to adult S, and a slim 174cm/56kg adult landed on kids 18 at
-- penalty 0, so it presented as a confident match. Age replaces the guess with an
-- explicit answer from the visitor, which is why it must be stored rather than
-- recomputed.
--
-- WITHOUT THIS MIGRATION the app breaks on write, not just on read:
--   · PATCH /api/users/:deviceId (updateUserMeasurements) does
--     .update({ height, weight, age }) → PostgREST rejects the unknown column,
--     so the 30-day measurements refresh fails for every returning user.
--   · POST /api/sessions (saveSession) inserts an `age` field → same failure,
--     so no try-on session is logged at all.
-- Run this BEFORE deploying the accompanying application change.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   1. Adds `age` to `users` and to `sessions`, both nullable.
--   2. Backfills `users.age` from each user's most recent `sessions` row - a
--      no-op on first run (no session carries an age yet), but it makes the
--      script re-runnable and matches the V7 pattern for height/weight.
--
-- NOTE ON NULLS: age is deliberately nullable. Every profile created before this
-- ships has no age, and the client treats that as an INCOMPLETE profile -
-- isSaneProfile() requires a finite age, so those visitors are routed back
-- through Screen 1 to supply one instead of being silently sized as adults.
-- Do not add a DEFAULT here; a default would fabricate that answer.
--
-- Age is SMALLINT rather than the NUMERIC(6,2) used for height/weight: it is
-- entered and used as a whole number of years, and the 1-120 range the client and
-- server both enforce fits comfortably.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

-- ── 1. Add the new columns ──────────────────────────────────────────────────
ALTER TABLE users    ADD COLUMN IF NOT EXISTS age SMALLINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS age SMALLINT;

-- ── 2. Backfill users.age from each user's most recent session row ──────────
--     Mirrors V7's backfill. Only fills rows that are still NULL, so re-running
--     this file can never overwrite an age a visitor has since entered.
UPDATE users u
SET age = s.age
FROM (
  SELECT DISTINCT ON (user_id) user_id, age
  FROM sessions
  WHERE user_id IS NOT NULL AND age IS NOT NULL
  ORDER BY user_id, created_at DESC
) s
WHERE s.user_id = u.id AND u.age IS NULL;
