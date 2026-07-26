-- =============================================================================
-- PEAR · Supabase Setup V2 — returning-user identification
-- =============================================================================
--
-- WHAT THIS DOES (and why it is SAFE to run on a live database)
-- ────────────────────────────────────────────────────────────
-- This migration is PURELY ADDITIVE. Unlike supabase_setup.sql it does NOT drop
-- the `sessions` table, so existing session rows are preserved. It:
--   1. Creates a `users` table (one row per remembered browser/device).
--   2. Adds a nullable `user_id` column to `sessions` linking each session to a
--      user (old rows simply keep user_id = NULL).
--   3. Adds an index on users.device_id for fast lookup.
--   4. Enables RLS + a service_role full-access policy (mirrors `sessions`).
--
-- Every statement uses IF NOT EXISTS / IF EXISTS so the file is idempotent —
-- re-running it never errors and never destroys data.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter). Expect "Success. No rows returned."
--
-- (Credentials live in .env as SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — already
--  configured for this project; nothing to change there.)
-- =============================================================================


-- ── 1. Users table ────────────────────────────────────────────────────────────
-- One row per remembered device. device_id is generated client-side (a UUID kept
-- in localStorage as 'pear_device_id'); it is the stable handle that lets a
-- returning visitor skip the name/phone form.
CREATE TABLE IF NOT EXISTS users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   TEXT        UNIQUE NOT NULL,
  name        TEXT        NOT NULL,
  phone       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 2. Link sessions → users ──────────────────────────────────────────────────
-- Additive, nullable FK. Existing session rows keep user_id = NULL.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);


-- ── 3. Indexes ────────────────────────────────────────────────────────────────
-- Fast device_id lookup (GET /api/users/:device_id runs on every page load).
CREATE INDEX IF NOT EXISTS idx_users_device_id ON users (device_id);
-- Fast per-user session aggregation for the admin "users" view.
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);


-- ── 4. Row Level Security ─────────────────────────────────────────────────────
-- Mirror the `sessions` security model: RLS on, service_role gets full access
-- (the service_role key the server uses already bypasses RLS, but we declare the
-- policy explicitly for clarity and future tooling). No anon/authenticated policy
-- = no public access.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON users;
CREATE POLICY "service_role_full_access"
  ON users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
