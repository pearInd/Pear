-- =============================================================================
-- PEAR · Supabase Setup V7 — height/weight move onto users (returning-user profile)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Returning-user auto-login (fitting-room/app.js setupIdentityGate) needs the
-- visitor's current height/weight available from a single GET /api/users/:deviceId
-- lookup, without joining `sessions` (which is an append-only try-on log, not a
-- profile). `users.height`/`users.weight` become the single source of truth for
-- "this person's current measurements"; PATCH /api/users/:deviceId (server.js
-- updateUserMeasurements) keeps them fresh on the 30-day refresh.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   1. Adds `height` / `weight` columns to `users` (same NUMERIC(6,2) shape as
--      the existing `sessions.height`/`sessions.weight`).
--   2. Backfills them from each user's most recent `sessions` row, so existing
--      users don't lose their profile the moment this ships.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

-- ── 1. Add the new columns ──────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS height NUMERIC(6,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS weight NUMERIC(6,2);

-- ── 2. Backfill from each user's most recent session row ───────────────────
UPDATE users u
SET height = s.height, weight = s.weight
FROM (
  SELECT DISTINCT ON (user_id) user_id, height, weight
  FROM sessions
  WHERE user_id IS NOT NULL
  ORDER BY user_id, created_at DESC
) s
WHERE s.user_id = u.id AND u.height IS NULL AND u.weight IS NULL;
