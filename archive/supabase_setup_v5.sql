-- =============================================================================
-- PEAR · Supabase Setup V5 — garment_cache (front/back classification cache)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Both scanner/scan-store.js (bulk store crawl on Railway) and the widget's
-- POST /api/classify-images call Gemini to classify a garment product photo
-- as "front" or "back". Gemini calls cost money and are rate-limited, so every
-- classified image URL is cached here — a URL classified once by either the
-- scanner or the live widget is never re-classified by the other.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → your project → SQL Editor → New query.
-- 2. Paste this ENTIRE file.
-- 3. Click Run (Cmd/Ctrl + Enter).
-- =============================================================================

CREATE TABLE IF NOT EXISTS garment_cache (
  id             BIGSERIAL PRIMARY KEY,
  image_url      TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('front', 'back')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_garment_cache_image_url ON garment_cache (image_url);
