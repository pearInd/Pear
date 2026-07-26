-- =============================================================================
-- PEAR · Supabase Setup V4 — merge duplicate accounts left by the old bug
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Before phone became the identity key, the old code created a SEPARATE `users`
-- row per browser/device — so testing the same real phone number from more than
-- one browser (or across the various bugs fixed today) left several `users` rows
-- for the SAME person, each with its own slice of `sessions` history. Now that
-- lookups go by phone, the lookup finds ONE of those rows — often not the one
-- your measurements are attached to — so it "recognizes" you but shows nothing.
--
-- WHAT THIS DOES (safe — no measurement data is deleted, only merged)
-- ─────────────────────────────────────────────────────────────────────
--   1. Normalizes every phone to digits-only (safe to re-run even if V3 already
--      did this).
--   2. For every phone with more than one `users` row, picks the EARLIEST
--      registered row as the "canonical" one, re-points every `sessions` row
--      from the other duplicate(s) onto it (so ALL of a person's measurement
--      history ends up under ONE account), then removes the now-empty
--      duplicate `users` rows. Every session row is kept — none are deleted.
--   3. Drops the old UNIQUE constraint on device_id (same as V3 — safe to
--      re-run if V3 already did it, or if it silently didn't).
--   4. Creates the UNIQUE index on phone — this can only succeed once step 2
--      has actually removed the duplicates, which is the whole point of this
--      file.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter). Read the result — if step 4 errors, run:
--       SELECT phone, COUNT(*) FROM users GROUP BY phone HAVING COUNT(*) > 1;
--    and tell me what it returns.
-- =============================================================================


-- ── 1. Normalize phones to digits-only ──────────────────────────────────────
UPDATE users SET phone = regexp_replace(phone, '\D', '', 'g')
WHERE phone <> regexp_replace(phone, '\D', '', 'g');


-- ── 2. Merge duplicate accounts per phone ───────────────────────────────────
WITH ranked AS (
  SELECT id, phone,
         ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at ASC) AS rn
  FROM users
),
canonical AS (
  SELECT phone, id AS canonical_id FROM ranked WHERE rn = 1
),
dupes AS (
  SELECT r.id AS dupe_id, c.canonical_id
  FROM ranked r
  JOIN canonical c ON c.phone = r.phone
  WHERE r.rn > 1
)
UPDATE sessions s
SET user_id = d.canonical_id
FROM dupes d
WHERE s.user_id = d.dupe_id;

WITH ranked AS (
  SELECT id, phone,
         ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at ASC) AS rn
  FROM users
)
DELETE FROM users WHERE id IN (SELECT id FROM ranked WHERE rn > 1);


-- ── 3. device_id is no longer a unique lookup key ───────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_device_id_key;


-- ── 4. Phone becomes the real unique identity, enforced in the database ────
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users (phone);
