-- =============================================================================
-- PEAR · Supabase Setup V6 — replace phone identity with email
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- The identity gate now asks for name + EMAIL instead of name + phone (see
-- server.js normalizeEmail()/findUserByEmail() and fitting-room/app.js
-- submitIdentity()). Email replaces phone as the unique identity key — same
-- role phone played since supabase_setup_v3.sql, just a different field.
--
-- WHAT THIS DOES (safe to run on a live database)
-- ─────────────────────────────────────────────────
--   1. Adds the new `email` column.
--   2. Drops the old UNIQUE index on phone (must happen before the column can
--      be dropped) and then drops the `phone` column itself.
--   3. Adds a UNIQUE index on email — the real identity constraint, enforced
--      at the database level (defense in depth alongside the application
--      check in POST /api/users).
--
-- ⚠ This DROPS the phone column and its data. If you need to keep historical
-- phone numbers, export the `phone` column before running step 2.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

-- ── 1. Add the new email column ─────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- ── 2. Phone is no longer the identity key ──────────────────────────────────
DROP INDEX IF EXISTS idx_users_phone_unique;
ALTER TABLE users DROP COLUMN IF EXISTS phone;

-- ── 3. Email becomes the real unique identity, enforced in the database ────
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email);
