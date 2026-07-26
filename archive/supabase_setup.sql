-- =============================================================================
-- PEAR · Supabase Setup — paste this entire file into the SQL Editor and run it
-- =============================================================================
--
-- WHERE TO FIND THE SQL EDITOR
-- ────────────────────────────
-- 1. Open https://supabase.com and sign in.
-- 2. Click your project (or create one if you haven't yet).
-- 3. In the left sidebar click "SQL Editor".
-- 4. Click "New query" (top-left of the editor pane).
-- 5. Paste the entire contents of this file into the editor.
-- 6. Click "Run" (or press Cmd/Ctrl + Enter).
-- 7. You should see "Success. No rows returned." — the table is ready.
--
-- WHERE TO FIND YOUR CREDENTIALS
-- ────────────────────────────────
-- In the Supabase dashboard left sidebar go to:
--   Settings → API
--
--   SUPABASE_URL              → "Project URL"  (looks like https://xxxx.supabase.co)
--   SUPABASE_SERVICE_ROLE_KEY → "service_role" key under "Project API keys"
--                               (click the eye icon to reveal it)
--
-- Add both to your .env file:
--   SUPABASE_URL=https://xxxx.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
--
-- And add the same two variables to your Vercel project:
--   Vercel Dashboard → Your project → Settings → Environment Variables
-- =============================================================================


-- Drop existing table cleanly (safe to re-run; CASCADE removes dependent objects).
DROP TABLE IF EXISTS sessions CASCADE;


-- ── Main table ────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id            BIGSERIAL PRIMARY KEY,

  -- Session identity (anonymised UUID minted client-side)
  session_id    TEXT        NOT NULL DEFAULT '',

  -- Body measurements (nullable — user may not provide all values)
  height        NUMERIC(6,2),   -- cm
  weight        NUMERIC(6,2),   -- kg
  chest         NUMERIC(6,2),   -- cm
  waist         NUMERIC(6,2),   -- cm
  legs          NUMERIC(6,2),   -- cm (inseam / leg length)

  -- Sizing output
  size          TEXT,           -- e.g. "S", "M", "L", "XL"

  -- Garment metadata
  garment_id    TEXT,
  garment_name  TEXT,
  garment_type  TEXT,           -- e.g. "shirt", "trousers"
  sleeve_type   TEXT,           -- e.g. "slim", "regular"
  pants_fit     TEXT,           -- e.g. "slim", "relaxed"

  -- Audit
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── Index ─────────────────────────────────────────────────────────────────────
-- Fast descending sort for the admin dashboard (newest first).
CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);


-- ── Row Level Security ────────────────────────────────────────────────────────
-- Enable RLS so no public anonymous reads/writes are possible.
-- The service role key used by the server bypasses RLS entirely, so it can
-- read and write freely without a matching policy — but we add an explicit
-- policy anyway to make the intent clear and to allow future tooling.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Service role: full access (INSERT, SELECT, DELETE).
-- Note: the service role key already bypasses RLS, but this policy is explicit.
CREATE POLICY "service_role_full_access"
  ON sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Deny everything to the anonymous / authenticated roles (no public access).
-- (No additional policy = no access for those roles since RLS is enabled.)
