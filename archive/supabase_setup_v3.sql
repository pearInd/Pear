-- =============================================================================
-- PEAR · Supabase Setup V3 — phone is the true unique identity
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- V2 made `device_id` UNIQUE and used it as the primary lookup key: "known
-- device → return its profile." That silently returned a visitor's REAL saved
-- profile even when they typed a completely different name/phone into the
-- identity form on a browser that had registered before — because the server
-- checked device_id BEFORE it ever looked at what was submitted, and because
-- device_id being UNIQUE meant a genuinely new phone from a known browser could
-- fail to insert and fall back to returning the OLD device-linked row.
--
-- The product requirement is: PHONE is the unique identity, and duplicate
-- phones under a different name must be blocked. device_id is now just an
-- audit field (which browser last touched a profile) — never a lookup key.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   1. Normalizes every existing phone value to digits-only, matching the
--      server's normalizePhone() so old + new rows compare consistently.
--   2. Drops the UNIQUE constraint on device_id (one browser may legitimately
--      register/attach to several different phone-identified profiles over
--      its lifetime — a shared device, or QA testing several numbers).
--   3. Adds a UNIQUE index on phone — the real identity constraint, enforced
--      at the database level (defense in depth alongside the application
--      check in POST /api/users).
--
-- ⚠ STEP 1 CAN FAIL THE UNIQUE INDEX IN STEP 3 if two existing rows normalize
-- to the same digits (e.g. "050-1234567" and "0501234567" were both stored
-- before this fix existed). If step 3 errors, run:
--     SELECT phone, COUNT(*) FROM users GROUP BY phone HAVING COUNT(*) > 1;
-- and manually decide which duplicate row to keep before re-running step 3.
-- This migration does NOT delete any row automatically — no data loss risk.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================


-- ── 1. Normalize existing phone values to digits-only ──────────────────────
UPDATE users SET phone = regexp_replace(phone, '\D', '', 'g')
WHERE phone <> regexp_replace(phone, '\D', '', 'g');


-- ── 2. device_id is no longer a unique lookup key ───────────────────────────
-- Default constraint name for an inline `UNIQUE` column def is <table>_<col>_key.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_device_id_key;
-- The plain (non-unique) lookup index from V2 still stands — no change needed.


-- ── 3. Phone becomes the real unique identity, enforced in the database ────
-- See the ⚠ note above if this errors on pre-existing duplicate data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users (phone);
