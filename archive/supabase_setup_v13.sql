-- =============================================================================
-- PEAR · Supabase Setup V13 - lock garment_cache to the server (RLS on, no policies)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- THE EXPOSURE: no migration from V5 to V12 ever enabled row-level security on
-- `garment_cache`, and the PUBLIC anon key ships to every browser in
-- admin/admin.js. On a Supabase project where RLS is off, anyone holding that key
-- can UPDATE or DELETE rows through the REST API - including flipping
-- `classification` or `has_graphic`, which is exactly the verdict that decides
-- whether a shopper's back render keeps its print. A poisoned row is served
-- CACHE-FIRST to every later visitor.
--
-- WHY NO POLICIES AT ALL, not an anon read-only policy: nothing outside the server
-- reads this table. Every real client uses the service-role key, which bypasses RLS:
--   server.js (via lib/supabase.js), scanner/scan-store.js, scanner/backfill-age-group.js
-- fitting-room/ and widget/ never query it. A read policy would have no consumer and
-- would still publish every scanned merchant URL and verdict to anyone with the key.
--
-- WHAT THIS DOES (safe to run on a live database; re-runnable)
-- ─────────────────────────────────────────────────────────────
--   1. Enables RLS on garment_cache with NO policies: anon/authenticated see zero rows
--      and cannot write. service_role is unaffected (BYPASSRLS).
--   2. Revokes the default table grants from anon/authenticated, so the REST API
--      answers them "permission denied" instead of an empty 200 - an unauthorised read
--      is then an ERROR you can see, not a silent empty result.
--   3. Verification queries at the bottom. Read-only.
--
-- IF THE SERVER ITSELF IS MISCONFIGURED with the anon key in
-- SUPABASE_SERVICE_ROLE_KEY, this migration makes every cache read fail. That is the
-- correct outcome, and lib/supabase.js logs it at startup:
--   [supabase] SUPABASE_SERVICE_ROLE_KEY authenticates as "anon", not "service_role"
--
-- RUN ORDER FOR A DATABASE THAT IS BEHIND
-- ───────────────────────────────────────
-- Observed 2026-09-14 on the project admin/admin.js points at: 42703
-- "column garment_cache.product_url does not exist", i.e. V8 has not run there. Confirm
-- which project the server actually uses (Vercel env SUPABASE_URL) before running
-- anything - the admin page and the server may not share one.
--
--   0. BACK UP FIRST. V9 DELETES duplicate rows and that cannot be undone:
--        CREATE TABLE garment_cache_backup_20260914 AS TABLE garment_cache;
--   1. supabase_setup_v8.sql   confidence, source, cue, product_url, updated_at
--   2. supabase_setup_v9.sql   canonical_url + DELETE of duplicate spellings (needs V8's
--                              source/updated_at for its ranking)
--   3. supabase_setup_v11.sql  age_group, age_group_confidence
--   4. supabase_setup_v12.sql  text_ocr, is_true_back_view, primary_color_hex,
--                              has_graphic, classifier_version
--   5. supabase_setup_v13.sql  this file
--   6. supabase_setup_v14.sql  variant_key (colourway-scoped back recovery)
--   (supabase_setup_v10.sql touches users/sessions only - not needed for garment_cache.)
--
-- HOW TO RUN
-- ──────────
-- 1. Supabase → the project named by the server's SUPABASE_URL → SQL Editor.
-- 2. Paste this ENTIRE file.
-- 3. Run. Then read the three result sets from section 3.
-- =============================================================================

-- ── 1. RLS on, no policies ───────────────────────────────────────────────────
ALTER TABLE garment_cache ENABLE ROW LEVEL SECURITY;

-- ── 2. No table grants for the browser-facing roles ──────────────────────────
REVOKE ALL ON TABLE garment_cache FROM anon, authenticated;

-- ── 3. Verify (read-only) ────────────────────────────────────────────────────
-- Expect rls_enabled = true.
SELECT relrowsecurity AS rls_enabled
FROM pg_class
WHERE oid = 'public.garment_cache'::regclass;

-- Expect ZERO rows: no policy should grant anon or authenticated anything.
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'garment_cache';

-- Expect no rows for anon / authenticated; service_role keeps its grants.
SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'garment_cache'
GROUP BY grantee
ORDER BY grantee;

-- Which migration-era columns exist (V8 / V9 / V11 / V12) - every one listed in the
-- RUN ORDER above should appear once the catch-up has run.
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'garment_cache'
ORDER BY ordinal_position;
