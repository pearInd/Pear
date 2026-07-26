/* =============================================================================
   PEAR / MERIDIAN - secure backend proxy for Decart Lucy VTON (realtime)
   -----------------------------------------------------------------------------
   Token-minting strategy (three-tier waterfall, most to least specific):

     Tier 1 - SDK  : decart.tokens.create({ expiresIn, allowedModels })
     Tier 2 - REST : POST https://api.decart.ai/v1/realtime/tokens
     Tier 3 - REST : POST https://api.decart.ai/v1/client/tokens

   Each tier logs the full Decart response body on failure so the exact
   upstream error is visible in the server terminal.  The browser always
   receives a clean JSON object - either { apiKey, expiresAt, model } or
   { error, message, decart_status, decart_body }.

   Endpoints exposed by this server:
     POST|GET /api/realtime-token   → ephemeral ek_… token
     POST|GET /api/tryon            → alias (blueprint-compatible)
     GET      /api/health           → diagnostics
   ============================================================================ */

import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDecartClient } from "@decartai/sdk";
import { logTryOn } from "./lib/sheets.js";
import { supabase } from "./lib/supabase.js";

logTryOn({ garmentName: "Local Test Shirt", size: "XL" }).catch(e => console.error("Sheets test failed:", e.message));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── environment ─────────────────────────────────────────────────────────── */
const KEY_SOURCE =
  (process.env.DECART_API_KEY    && "DECART_API_KEY") ||
  (process.env.DESCARTES_API_KEY && "DESCARTES_API_KEY") ||
  null;
const API_KEY  = process.env.DECART_API_KEY || process.env.DESCARTES_API_KEY || "";
const PORT     = Number(process.env.PORT) || 3000;
const VTON_MODEL  = process.env.DECART_VTON_MODEL  || "lucy-vton-latest";
const TOKEN_TTL   = Math.min(3600, Math.max(1, Number(process.env.DECART_TOKEN_TTL) || 600));
const ALLOWED_ORIGINS = (process.env.DECART_ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/* Admin authorization allowlist. requireAdminAuth() only accepts a Supabase Auth
   JWT whose verified email is in this list. Without it, ANY account that can sign
   up against the public anon key would pass the auth check (authentication ≠
   authorization). Set ADMIN_EMAILS in .env AND in your Vercel env vars:
     ADMIN_EMAILS=you@example.com,partner@example.com                            */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/* ── Express setup ───────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: "8mb" }));
app.disable("x-powered-by");
app.set("trust proxy", true);   // Vercel/edge sets X-Forwarded-For; needed for req.ip + rate limiting

/* ── Security headers (all responses) ──────────────────────────────────────────
   Applied globally so HTML pages (not just /api) carry hardening headers. The
   admin dashboard additionally gets strict anti-framing + no-store to defeat
   clickjacking and stop the (login-gated) page being cached on shared machines.
   The rest of the site allows same-origin framing so the storefront can embed the
   fitting room (its "back to store" link uses target="_top", implying embedding). */
app.use((req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  const isAdmin = /(^|\/)admin(\.html|\.js|\.css)?(\/|$)/i.test(req.path);
  // The fitting room is embedded cross-origin by the pear-widget.js modal on
  // third-party store pages, so it (and the widget assets) must be frameable
  // from anywhere. It is a public, unauthenticated surface - the clickjacking
  // protections stay in force on the admin dashboard and the rest of the site.
  const isEmbeddable = /^\/(fitting-room|widget)(\/|$)/i.test(req.path);
  if (isAdmin) {
    res.header("X-Frame-Options", "DENY");
    res.header("Content-Security-Policy", "frame-ancestors 'none'");
    res.header("Cache-Control", "no-store, no-cache, must-revalidate");
  } else if (isEmbeddable) {
    res.header("Content-Security-Policy", "frame-ancestors *");
    // Same no-store guarantee as /admin above: the fitting-room HTML/JS/CSS iterate
    // fast (active demo work) and are embedded via <iframe>/<script src> on third-party
    // pages we don't control the caching of, so nothing here should ever be served
    // from a browser/CDN/proxy cache - every load must hit the origin fresh. Query
    // strings (id/itemType/color/img) are irrelevant once caching is off outright.
    res.header("Cache-Control", "no-store, no-cache, must-revalidate");
  } else {
    res.header("X-Frame-Options", "SAMEORIGIN");
    res.header("Content-Security-Policy", "frame-ancestors 'self'");
  }
  next();
});

/* ── Lightweight in-memory rate limiter ────────────────────────────────────────
   Sliding-window per client IP. NOTE: on serverless (Vercel) each warm instance
   keeps its own counters, so this is a best-effort brake against casual flooding
   /brute-forcing, not a distributed guarantee. For hard limits put a shared store
   (Upstash/Redis) or the platform WAF in front. Still, it meaningfully raises the
   cost of registration spam, session-table flooding, and token-mint abuse. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();   // ip -> [timestamps]
  return (req, res, next) => {
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) {                 // opportunistic cleanup of idle IPs
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    if (arr.length > max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "rate_limited", message: "Too many requests - slow down." });
    }
    next();
  };
}

// Per-surface limiters (generous enough to never bother a real user).
const tokenLimiter    = rateLimit({ windowMs: 60_000, max: 30 });   // ek_ token mint - costs money
const sessionLimiter  = rateLimit({ windowMs: 60_000, max: 40 });   // session-log ingest
const userLimiter     = rateLimit({ windowMs: 60_000, max: 20 });   // user registration
const trackLimiter    = rateLimit({ windowMs: 60_000, max: 60 });   // analytics ping
const proxyLimiter    = rateLimit({ windowMs: 60_000, max: 120 });  // image proxy
const authLimiter     = rateLimit({ windowMs: 60_000, max: 10 });   // admin login - brake password guessing
const classifyLimiter = rateLimit({ windowMs: 60_000, max: 200 });   // garment front/back classification - calls Gemini
const storeCatalogLimiter = rateLimit({ windowMs: 60_000, max: 30 }); // "Complete the Look" store-scoped catalog reads

/* ── CORS enforcement ────────────────────────────────────────────────────────
   The fitting room is PUBLICLY ACCESSIBLE to any anonymous visitor - no login
   or account is required. CORS is used solely to ensure API calls originate
   from our storefront domain, not from third-party scrapers or abusers.

   Production: set DECART_ALLOWED_ORIGINS to your live domain(s), e.g.:
     DECART_ALLOWED_ORIGINS=https://yourstore.vercel.app,https://yourshop.myshopify.com
   Dev / unset: all origins are allowed (with a one-time startup warning) so a
   missing env var never silently breaks a live deployment.

   WebRTC transport: DTLS/SRTP is mandated by the WebRTC spec and enforced by
   the browser - all peer-connection media is end-to-end encrypted regardless
   of this server's config.
   Zero-retention: this proxy never receives, buffers, or persists user images,
   WebRTC frames, or body measurements.  It only mints short-lived ek_ tokens;
   all sensitive data flows over the encrypted peer channel to Decart's servers. */
const ORIGINS_LOCKED = ALLOWED_ORIGINS.length > 0;

const isOriginAllowed = (origin, reqHost) => {
  if (!origin) return true;              // same-origin / server-to-server requests
  if (!ORIGINS_LOCKED) return true;      // open fallback - env var not configured yet
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Auto-allow the server's own host so a fetch() from /fitting-room/ to
  // /api/realtime-token always works on any Vercel URL, preview deployment,
  // or custom domain without needing to update DECART_ALLOWED_ORIGINS.
  if (reqHost &&
      (origin === `https://${reqHost}` || origin === `http://${reqHost}`)) return true;
  return false;
};

/* /api/classify-images is called cross-origin FROM the third-party store's own
   domain (fox.co.il, etc.) by widget/pear-widget.js's classifyImages() - by
   design that call must succeed from ANY storefront, unlike the rest of /api
   which is deliberately locked to our own storefront via DECART_ALLOWED_ORIGINS.
   When ORIGINS_LOCKED is on and the store's origin isn't allowlisted, the
   origin-lock below used to reject it - both the OPTIONS preflight (403, via
   `allowed ? 204 : 403`) and the real POST (403 with ACAO: "null") - which the
   browser surfaces as a CORS failure (ERR_FAILED) exactly as reported. This is
   the ONLY origin-lock bypass; every other /api route keeps the existing
   DECART_ALLOWED_ORIGINS enforcement below, completely untouched.
   /api/send-otp and /api/verify-otp get the same bypass: the fitting-room
   iframe is embedded on third-party store domains, so its identity-gate calls
   hit this same origin-lock 403 there too. /api/users/relink is the monthly
   re-auth's device-relink step (Case 3 - new device, email already
   registered) and runs from that same embedded identity-gate flow, so it
   needs the identical bypass. */
const PUBLIC_API_PATHS = new Set(["/classify-images", "/send-otp", "/verify-otp", "/users/relink"]);   // mount-relative (see app.use("/api", …) below)

app.use("/api", (req, res, next) => {
  const origin = req.headers.origin || "";
  const isPublicEndpoint = PUBLIC_API_PATHS.has(req.path);
  const allowed = isPublicEndpoint || isOriginAllowed(origin, req.headers.host);

  if (isPublicEndpoint) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (origin) {
    res.header("Access-Control-Allow-Origin", allowed ? origin : "null");
  }
  res.header("Vary",                          "Origin");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Max-Age",       "600");
  res.header("X-Content-Type-Options",       "nosniff");
  res.header("Referrer-Policy",              "strict-origin-when-cross-origin");

  if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
  if (!allowed) {
    console.warn(
      `[cors] blocked: origin="${origin}" host="${req.headers.host}" ` +
      `allowed=[${ALLOWED_ORIGINS.join(", ") || "(none)"}]`
    );
    return res.status(403).json({ error: "forbidden", message: "Origin not allowed." });
  }
  console.log(`[api] ${req.method} ${req.originalUrl}`);
  next();
});

/* ── SDK client (holds the permanent key - never sent to the browser) ─────── */
let decart = null;
if (API_KEY && /^(?:one)?dct_|^dct_last-/.test(API_KEY)) {
  try {
    decart = createDecartClient({ apiKey: API_KEY });
    console.log(`✓ Decart SDK client initialised (key from ${KEY_SOURCE}).`);
  } catch (err) {
    console.error("✗ Decart SDK init failed:", err?.message || err);
  }
} else {
  console.warn(
    "⚠ No valid Decart key found in DECART_API_KEY or DESCARTES_API_KEY.\n" +
    "  Set DECART_API_KEY in .env (copy from platform.decart.ai → API Keys).\n" +
    "  /api/realtime-token will return 503 until a key is configured."
  );
}

/* ── Tier 1: SDK ─────────────────────────────────────────────────────────── */
async function trySDK() {
  if (!decart) throw Object.assign(new Error("SDK not initialised"), { tier: "sdk" });

  const opts = { expiresIn: TOKEN_TTL, allowedModels: [VTON_MODEL] };
  if (ALLOWED_ORIGINS.length) opts.allowedOrigins = ALLOWED_ORIGINS;

  let token;
  try {
    token = await decart.tokens.create(opts);
  } catch (errScoped) {
    console.warn(`[tier1-sdk] scoped create failed: ${errScoped?.message || errScoped}`);
    token = await decart.tokens.create();   // bare call - no scope
  }

  if (!token?.apiKey) throw Object.assign(new Error("SDK returned no apiKey"), { tier: "sdk" });
  console.log("[tier1-sdk] ✓ token minted via SDK");
  return {
    apiKey:      token.apiKey,
    expiresAt:   token.expiresAt   ?? null,
    permissions: token.permissions ?? null,
  };
}

/* ── Tier 2 & 3: direct REST ─────────────────────────────────────────────── */
const REST_ENDPOINTS = [
  "https://api.decart.ai/v1/realtime/tokens",  // 2026 realtime endpoint
  "https://api.decart.ai/v1/client/tokens",    // legacy client endpoint
];

async function tryREST(url) {
  const body = JSON.stringify({ model: VTON_MODEL, expires_in: TOKEN_TTL });
  console.log(`[rest] POST ${url}`);

  const resp = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY":    API_KEY,
      "Authorization": `Bearer ${API_KEY}`,
    },
    body,
  });

  const rawText = await resp.text();

  if (!resp.ok) {
    // Log the full upstream response so the exact Decart error is visible.
    console.error(
      `[rest] ✗ ${url} → HTTP ${resp.status}\n` +
      `  response body: ${rawText}`
    );
    const err = new Error(`Decart ${resp.status} from ${url}`);
    err.decart_status = resp.status;
    err.decart_body   = rawText;
    err.tier          = "rest";
    throw err;
  }

  let parsed;
  try { parsed = JSON.parse(rawText); } catch (_) {
    throw Object.assign(new Error("Decart returned non-JSON"), { tier: "rest", decart_body: rawText });
  }

  // Accept either { apiKey } (SDK-style) or { api_key } (REST-style)
  const apiKey = parsed.apiKey || parsed.api_key || parsed.token || parsed.key;
  if (!apiKey) {
    console.error(`[rest] ✗ ${url} → no apiKey field in response: ${rawText}`);
    throw Object.assign(new Error("Decart response has no apiKey field"), { tier: "rest", decart_body: rawText });
  }

  console.log(`[rest] ✓ token minted via ${url}`);
  return {
    apiKey,
    expiresAt:   parsed.expiresAt ?? parsed.expires_at ?? null,
    permissions: parsed.permissions                    ?? null,
  };
}

/* ── Waterfall: SDK → REST endpoints in order ────────────────────────────── */
async function mintTokenWaterfall() {
  // Tier 1
  try { return await trySDK(); } catch (e) {
    console.warn(`[waterfall] SDK failed (${e.message}), trying REST fallback…`);
  }

  // Tier 2 + 3
  let lastErr;
  for (const url of REST_ENDPOINTS) {
    try { return await tryREST(url); } catch (e) {
      lastErr = e;
      console.warn(`[waterfall] ${url} failed, trying next…`);
    }
  }

  // All tiers exhausted - surface the last error
  const err = lastErr || new Error("All token-mint strategies failed");
  err.allFailed = true;
  throw err;
}

/* ── Express handler ─────────────────────────────────────────────────────── */
async function mintToken(req, res) {
  console.log(`[realtime-token] ${req.method} ${req.originalUrl} - request received`);
  if (!API_KEY) {
    return res.status(503).json({
      error:   "decart_unconfigured",
      message: "Server has no Decart API key (set DECART_API_KEY in .env).",
    });
  }

  try {
    const token = await mintTokenWaterfall();
    return res.json({ ...token, model: VTON_MODEL });
  } catch (err) {
    console.error("[mintToken] all tiers failed:", err?.message || err);
    return res.status(502).json({
      error:        "token_mint_failed",
      message:      err?.message || "Could not mint a Decart client token.",
      decart_status: err?.decart_status ?? null,
      decart_body:   err?.decart_body   ?? null,
    });
  }
}

/* ── Routes ──────────────────────────────────────────────────────────────── */
function mountTokenRoute(p) {
  app.route(p)
    .get(tokenLimiter, mintToken)
    .post(tokenLimiter, mintToken)
    .all((_req, res) =>
      res.set("Allow", "GET, POST, OPTIONS").status(405).json({
        error:   "method_not_allowed",
        message: `Use GET or POST on ${p}. If you're getting 405, make sure the page is ` +
                 `served by THIS Express server: http://localhost:${PORT}/pear-demo/`,
      })
    );
}

mountTokenRoute("/api/realtime-token");
mountTokenRoute("/api/tryon");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, decart: !!decart, model: VTON_MODEL, keySource: KEY_SOURCE, ttl: TOKEN_TTL });
});

app.get("/api/speed-probe", (_req, res) => {
  const payload = Buffer.alloc(102_400); // 100 KB calibration payload for bandwidth check
  res
    .set("Content-Type", "application/octet-stream")
    .set("Cache-Control", "no-store, no-cache, must-revalidate")
    .set("Pragma", "no-cache")
    .send(payload);
});

/* ── Analytics: log a garment try-on to Google Sheets ───────────────────────── */
app.post("/api/track-tryon", trackLimiter, async (req, res) => {
  const { garmentId, garmentName, garmentType, subType, size } = req.body || {};
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "";
  try {
    await logTryOn({ garmentId, garmentName, garmentType, subType, size, ip });
    console.log("[track-tryon] sheet row written");
    res.json({ ok: true });
  } catch (err) {
    console.error("[track-tryon] sheet write failed:", err?.message);
    res.json({ ok: false, error: err?.message });
  }
});

/* ── Debug: verify Sheets env vars and write a test row (admin-only) ──────────
   Gated behind requireAdminAuth: it previously exposed the Google Sheet ID and the
   service-account email to any anonymous caller and let anyone write test rows.
   Env-var VALUES are no longer echoed - only presence - even to admins. */
app.get("/api/test-sheets", requireAdminAuth, async (req, res) => {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const email   = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key     = process.env.GOOGLE_PRIVATE_KEY;
  const envCheck = {
    GOOGLE_SHEET_ID:              sheetId ? "✓ present" : "✗ MISSING",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: email   ? "✓ present" : "✗ MISSING",
    GOOGLE_PRIVATE_KEY:           key     ? "✓ present" : "✗ MISSING",
  };
  if (!sheetId || !email || !key) {
    return res.json({ ok: false, envCheck, error: "Missing env vars - check Vercel settings" });
  }
  try {
    await logTryOn({ garmentId: "test", garmentName: "TEST", garmentType: "test", subType: "test", size: "test", ip: req.ip });
    res.json({ ok: true, envCheck, message: "Row written successfully - check the sheet!" });
  } catch (err) {
    res.json({ ok: false, envCheck, error: err?.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN DASHBOARD - session-log ingest + read API (OPEN ACCESS)
   ---------------------------------------------------------------------------
   The password/login gate has been removed: the admin endpoints below respond
   directly with no auth header required. Session rows persist in Supabase
   (lib/supabase.js), shared and durable across all server instances.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Session persistence ──────────────────────────────────────────────────────
   Durable storage via Supabase (Postgres). Survives cold starts, redeploys,
   and is shared across all server instances. Requires the `sessions` table
   created by supabase_setup.sql and two env vars:
     SUPABASE_URL              - from Supabase Dashboard → Settings → API
     SUPABASE_SERVICE_ROLE_KEY - from Supabase Dashboard → Settings → API
   ──────────────────────────────────────────────────────────────────────────── */
console.log(`[sessions] storage backend: ${supabase ? "Supabase" : "DISABLED (env vars missing)"}`);

/* Guard for Supabase-backed routes. When the client is null (env vars missing)
   we return a clear 503 instead of dereferencing null and crashing. Returns true
   when it has already sent the error response, so the caller should `return`. */
function storageUnavailable(res) {
  if (supabase) return false;
  res.status(503).json({
    ok: false,
    error: "storage_unconfigured",
    message: "Database not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing). " +
             "Session and user features are temporarily unavailable.",
  });
  return true;
}

/* ── Admin auth middleware - verifies Supabase Auth JWT + admin allowlist ───────
   Two independent checks, both required:
     1. AUTHENTICATION - the Bearer token is a valid, unexpired Supabase Auth JWT
        (verified server-side via getUser()).
     2. AUTHORIZATION  - the token's verified email is in ADMIN_EMAILS. This is the
        critical second gate: the fitting room ships the PUBLIC anon key, so anyone
        who signs up against it gets a valid JWT. Without the allowlist, "logged in"
        would equal "admin" and any member of the public could read all PII and wipe
        the sessions table.
   On success the verified email is attached as req.adminEmail for audit logging. */
async function requireAdminAuth(req, res, next) {
  if (storageUnavailable(res)) return;   // no Supabase client → can't verify → fail closed
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ ok: false, error: "unauthorized", message: "Missing auth token." });
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ ok: false, error: "unauthorized", message: "Invalid or expired token." });
    }
    const email = (user.email || "").toLowerCase();
    if (ADMIN_EMAILS.length === 0) {
      // Allowlist not configured - fail OPEN for backward compatibility, but shout
      // about it. Configure ADMIN_EMAILS to close this hole (see the env comment).
      console.warn(
        `[admin-auth] ⚠ ADMIN_EMAILS is empty - authorizing ANY authenticated user ` +
        `(${email || "unknown"}). Set ADMIN_EMAILS to restrict admin access.`
      );
    } else if (!ADMIN_EMAILS.includes(email)) {
      console.warn(`[admin-auth] blocked non-admin login: "${email}"`);
      return res.status(403).json({ ok: false, error: "forbidden", message: "Not an admin account." });
    }
    req.adminEmail = email;
    next();
  } catch (err) {
    console.error("[admin-auth] getUser failed:", err?.message);
    return res.status(401).json({ ok: false, error: "unauthorized", message: "Auth check failed." });
  }
}

async function readSessionLogs() {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveSessionLog(entry) {
  const { error } = await supabase.from("sessions").insert([entry]);
  if (error) throw new Error(error.message);
  // Return approximate total count without a separate COUNT query.
  return null;
}

async function clearSessionLogs() {
  // Delete every row. Supabase requires a filter for safety; `neq` on id covers all rows.
  const { error } = await supabase.from("sessions").delete().neq("id", 0);
  if (error) throw new Error(error.message);
}

/* ═══════════════════════════════════════════════════════════════════════════
   USER IDENTITY - first-time visitors enter name + email once; the browser is
   then remembered via a client-generated device_id (localStorage 'pear_device_id').
   On return visits the client looks the user up by device_id and skips the form,
   so new measurements just attach to the existing profile via sessions.user_id.
   ══════════════════════════════════════════════════════════════════════════ */
/* device_id is NOT unique (a shared/QA browser can legitimately attach to several
   different email-identified profiles over its lifetime - see V3 migration), so
   this can no longer assume a single row. Used by GET/PATCH /api/users/:deviceId
   for returning-device auto-login and the measurements refresh - never by
   createUser's identification logic, which must go by email alone. Returns the
   most recently touched row, an accepted tradeoff for the auto-login convenience
   (see fitting-room/app.js setupIdentityGate comment). */
async function findUserByDeviceId(deviceId) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/* Email is the human-facing UNIQUE identity (a person keeps their address across
   browsers/devices) - enforced both here in application logic AND by a UNIQUE
   index in the database (see supabase_setup_v6.sql). We store and compare it
   normalized to trimmed lowercase so "Dana@Example.com" and "dana@example.com "
   both resolve to the same user. */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function findUserByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  // .limit(1) BEFORE reading a single row: if pre-existing legacy rows (from
  // before email became the identity key) normalize to the same address, a bare
  // .maybeSingle() throws "multiple rows returned" and every lookup for that
  // email 500s - masquerading as "the whole feature doesn't work." Taking the
  // most recent of any duplicates keeps this working even before that legacy
  // data is cleaned up.
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", norm)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/* Shape a user row for the client. NOTE: this used to strip email as PII (an
   unauthenticated endpoint never returned it). The returning-user profile panel
   now needs to display email, so it's included - device_id is an unguessable
   client-generated UUID that already proves "this is the browser that
   registered", a comparable trust level to what already gates the account.
   height/weight live directly on `users` now (see supabase_setup_v7.sql) -
   the single source of truth for "this person's current measurements";
   `sessions` stays the append-only try-on log. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email,
    height: u.height, weight: u.weight,
    created_at: u.created_at,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMAIL OTP VERIFICATION - first-time visitors (no remembered device_id) must
   verify their email with a 6-digit code before their user row is created.
   Codes live in memory only (otpStore) - reset on server restart is an
   accepted tradeoff (see fitting-room/app.js verifyOtp/resendOtp). Sending
   goes through Resend (RESEND_API_KEY); returning visitors never hit this. */
const otpStore = new Map();      // normalized email -> { code, expires }
const otpAttempts = new Map();   // normalized email -> { count, windowStart }
const OTP_TTL_MS = 60_000;
const OTP_MAX_PER_HOUR = 10;

function otpRateLimited(email) {
  const now = Date.now();
  const rec = otpAttempts.get(email);
  if (!rec || now - rec.windowStart > 3_600_000) {
    otpAttempts.set(email, { count: 1, windowStart: now });
    return false;
  }
  if (rec.count >= OTP_MAX_PER_HOUR) return true;
  rec.count += 1;
  return false;
}

app.post("/api/send-otp", userLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const name  = String(req.body?.name || "").trim().slice(0, 80);
  if (!email || !name) {
    return res.status(400).json({ ok: false, error: "missing_fields", message: "email and name are required." });
  }
  if (otpRateLimited(email)) {
    return res.status(429).json({ ok: false, error: "rate_limited", message: "יותר מדי בקשות - נסה שוב בעוד שעה." });
  }

  const code = Math.floor(100000 + Math.random() * 900000);
  otpStore.set(email, { code, expires: Date.now() + OTP_TTL_MS });

  try {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PEAR Virtual Try-On <noreply@pear-ai.io>",
        to: email,
        subject: `קוד האימות שלך: ${code}`,
        html: `
          <div dir="rtl" style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;">
            <h2 style="color:#000;">PEAR Virtual Try-On</h2>
            <p>הקוד שלך להתחברות:</p>
            <div style="background:#f4f4f4;border-radius:8px;padding:24px;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:#000;">
              ${code}
            </div>
            <p style="color:#999;font-size:13px;margin-top:24px;">הקוד תקף לדקה אחת.</p>
          </div>
        `,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[send-otp] Resend ${resp.status}: ${text}`);
      throw new Error(`Resend ${resp.status}`);
    }
    console.log(`[send-otp] code sent to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[send-otp] failed:", err?.message || err);
    res.status(502).json({ ok: false, error: "send_failed", message: err?.message || "Could not send verification email." });
  }
});

app.post("/api/verify-otp", userLimiter, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code  = String(req.body?.code || "").trim();
  const rec   = otpStore.get(email);

  if (!rec || Date.now() > rec.expires) {
    otpStore.delete(email);
    return res.json({ ok: false, error: "expired" });
  }
  if (String(rec.code) !== code) {
    return res.json({ ok: false, error: "invalid" });
  }
  otpStore.delete(email);
  res.json({ ok: true });
});

/* POST /api/users - identify (or create) a user by EMAIL. Email is the ONLY
   lookup key here - device_id is never consulted for identification, it is
   purely an audit field written/refreshed on the matched row. This is
   deliberate: an earlier version checked device_id FIRST ("known browser →
   return its profile"), which meant typing a different name/email into the
   identity form on a browser that had registered before silently returned the
   PREVIOUS visitor's real saved profile instead of respecting what was typed.
   See supabase_setup_v6.sql for the matching schema change (email UNIQUE,
   device_id no longer unique). Returns { ok, user, ...measurements }. */
async function createUser(req, res) {
  if (storageUnavailable(res)) return;
  const b = req.body || {};
  const str = (v, max = 80) => (v == null ? "" : String(v).trim().slice(0, max));
  const deviceId = str(b.deviceId, 64);
  const name     = str(b.name, 80);
  const email    = normalizeEmail(str(b.email, 254));

  if (!deviceId || !name || !email) {
    return res.status(400).json({
      error: "missing_fields",
      message: "deviceId, name and email are all required.",
    });
  }

  const sameName = (a, c) =>
    String(a || "").trim().toLowerCase() === String(c || "").trim().toLowerCase();

  // Same person, matching name → re-link this device to their profile (an audit
  // update only - never used for lookup) and hand back their saved measurements.
  // Different name on the same email → BLOCK; that email is taken. Shared by both
  // the normal path and the insert-race fallback below.
  const respondForExistingEmail = async (row) => {
    if (sameName(row.name, name)) {
      await supabase.from("users").update({ device_id: deviceId }).eq("id", row.id);
      console.log(`[users] name+email match → auto-login user ${row.id}, relinked device "${deviceId}"`);
      return {
        status: 200,
        body: { ok: true, user: publicUser({ ...row, device_id: deviceId }), existed: true, matched: "email" },
      };
    }
    console.warn(`[users] email already registered to a different name → blocked`);
    return {
      status: 409,
      body: { ok: false, error: "email_taken", message: "This email address is already registered to another user." },
    };
  };

  try {
    const byEmail = await findUserByEmail(email);
    if (byEmail) {
      const { status, body } = await respondForExistingEmail(byEmail);
      return res.status(status).json(body);
    }

    const { data, error } = await supabase
      .from("users")
      .insert([{ device_id: deviceId, name, email }])
      .select()
      .single();

    if (error) {
      // Race: another request registered the SAME EMAIL between our check and this
      // insert (email now has a UNIQUE index - see supabase_setup_v6.sql). Re-run
      // the same email-match/block decision against the row that won the race.
      const raced = await findUserByEmail(email);
      if (raced) {
        const { status, body } = await respondForExistingEmail(raced);
        return res.status(status).json(body);
      }
      throw new Error(error.message);
    }

    console.log(`[users] created user ${data.id} (email-unique, device "${deviceId}")`);
    res.json({ ok: true, user: publicUser(data), existed: false });
  } catch (err) {
    console.error("[users] create failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

/* GET /api/users/:deviceId - return the user for this device_id, or 404. */
async function getUserByDevice(req, res) {
  if (storageUnavailable(res)) return;
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  const deviceId = String(req.params.deviceId || "").trim();
  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });
  try {
    const user = await findUserByDeviceId(deviceId);
    if (!user) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("[users] lookup failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

/* PATCH /api/users/:deviceId - update this device's user row with a fresh
   height/weight (the monthly returning-user measurements refresh). Same
   sane-range bounds as the client's isSaneProfile()/calculateSize() gate, so
   the server never persists a value the form itself would reject. */
async function updateUserMeasurements(req, res) {
  if (storageUnavailable(res)) return;
  const deviceId = String(req.params.deviceId || "").trim();
  if (!deviceId) return res.status(400).json({ error: "missing_device_id" });

  const height = Number(req.body?.height);
  const weight = Number(req.body?.weight);
  const sane = Number.isFinite(height) && Number.isFinite(weight) &&
    height >= 130 && height <= 240 && weight >= 35 && weight <= 220;
  if (!sane) {
    return res.status(400).json({ ok: false, error: "invalid_measurements" });
  }

  try {
    const user = await findUserByDeviceId(deviceId);
    if (!user) return res.status(404).json({ ok: false, error: "not_found" });

    const { error } = await supabase
      .from("users")
      .update({ height, weight })
      .eq("id", user.id);
    if (error) throw new Error(error.message);

    console.log(`[users] measurements updated for user ${user.id} (device "${deviceId}")`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[users] measurements update failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

/* PATCH /api/users/relink - client-side monthly re-auth, Case 3: a NEW device
   submitted a name+email that POST /api/users found already registered to a
   different device (409/email_taken). By the time the client calls this, it
   has already verified a fresh OTP for that exact email (see
   fitting-room/app.js relinkExistingDevice), so re-pointing device_id at the
   existing account is safe - same trust bar as createUser's own
   sameName-match auto-relink above, just without requiring the name to match
   too, since OTP ownership of the email is the stronger proof here. */
async function relinkUserDevice(req, res) {
  if (storageUnavailable(res)) return;
  const email    = normalizeEmail(req.body?.email);
  const deviceId = String(req.body?.deviceId || "").trim().slice(0, 64);
  if (!email || !deviceId) {
    return res.status(400).json({ ok: false, error: "missing_fields", message: "email and deviceId are required." });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ ok: false, error: "not_found" });

    const { error } = await supabase.from("users").update({ device_id: deviceId }).eq("id", user.id);
    if (error) throw new Error(error.message);

    console.log(`[users] relinked device "${deviceId}" to user ${user.id} (${email})`);
    res.json({ id: user.id, name: user.name, email: user.email, height: user.height, weight: user.weight });
  } catch (err) {
    console.error("[users] relink failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

/* GET /api/admin/users - open access. Returns every user with their total
   measurement (session) count, newest user first. */
async function getUsersWithCounts(_req, res) {
  if (storageUnavailable(res)) return;
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const [{ data: users, error: uErr }, { data: rows, error: sErr }] = await Promise.all([
      supabase.from("users").select("*").order("created_at", { ascending: false }),
      supabase.from("sessions").select("user_id"),
    ]);
    if (uErr) throw new Error(uErr.message);
    if (sErr) throw new Error(sErr.message);

    // Tally sessions per user_id in one pass.
    const counts = new Map();
    for (const r of rows || []) {
      if (!r.user_id) continue;
      counts.set(r.user_id, (counts.get(r.user_id) || 0) + 1);
    }

    const withCounts = (users || []).map((u) => ({
      ...u,
      session_count: counts.get(u.id) || 0,
    }));

    res.json({ ok: true, count: withCounts.length, users: withCounts });
  } catch (err) {
    console.error("[admin/users] read failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message, users: [], count: 0 });
  }
}

/* GET /api/admin/stats/averages - admin-only. Average height/weight across all
   users that have both measurements set (users.height/weight, not sessions -
   see publicUser comment: those columns are the single current-measurement
   source of truth per user). */
async function getAverageMeasurements(_req, res) {
  if (storageUnavailable(res)) return;
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const { data, error } = await supabase
      .from("users")
      .select("height, weight")
      .not("height", "is", null)
      .not("weight", "is", null);
    if (error) throw new Error(error.message);

    if (!data.length) {
      return res.json({ avgHeight: null, avgWeight: null, count: 0 });
    }

    const avgHeight = Math.round(
      data.reduce((sum, u) => sum + u.height, 0) / data.length
    );
    const avgWeight = Math.round(
      data.reduce((sum, u) => sum + u.weight, 0) / data.length
    );

    res.json({ avgHeight, avgWeight, count: data.length });
  } catch (err) {
    console.error("[admin/stats/averages] read failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

app.get("/api/admin/stats/averages", requireAdminAuth, getAverageMeasurements);

/* ── POST: save a session → appends to sessions.json ─────────────────────── */
async function saveSession(req, res) {
  if (storageUnavailable(res)) return;
  const b = req.body || {};
  const m = b.measurements || {};   // tolerate either nested {measurements} or flat fields
  const str = (v, max = 80) => (v == null ? "" : String(v).slice(0, max));
  const n   = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const pick = (a, c) => (a !== undefined && a !== null && a !== "" ? a : c);

  const entry = {
    session_id:    str(b.sessionId,    64) || crypto.randomUUID(),
    user_id:       b.userId || null,   // links the session to a remembered user (users.id)
    height:        n(pick(b.height,    m.height)),
    weight:        n(pick(b.weight,    m.weight)),
    chest:         n(pick(b.chest,     m.chest)),
    waist:         n(pick(b.waist,     m.waist)),
    legs:          n(pick(b.legs,      m.legs)),
    size:          str(b.size,         8),
    garment_id:    str(b.garmentId,    64),
    garment_name:  str(b.garmentName,  80),
    garment_type:  str(b.garmentType,  40),
    sleeve_type:   str(b.sleeveType,   40),
    pants_fit:     str(b.pantsFit,     40),
  };

  try {
    await saveSessionLog(entry);
    console.log("[sessions] saved session → Supabase");
    res.json({ ok: true });
  } catch (err) {
    console.error("[sessions] persist failed:", err?.message);
    res.json({ ok: false, error: err?.message });
  }
}

/* ── GET: retrieve sessions (open access) → reads from Supabase ───────────── */
async function getSessions(_req, res) {
  if (storageUnavailable(res)) return;
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  try {
    const sessions = await readSessionLogs();   // already newest-first from Supabase ORDER BY
    console.log(`[admin/sessions] Supabase → ${sessions.length} session(s) found`);
    res.json({ ok: true, count: sessions.length, sessions });
  } catch (err) {
    console.error("[admin/sessions] read failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message, sessions: [], count: 0 });
  }
}

/* DELETE: wipe all sessions (admin-only). */
async function clearSessions(req, res) {
  if (storageUnavailable(res)) return;
  try {
    await clearSessionLogs();
    console.log(`[sessions] cleared all → Supabase (by admin: ${req.adminEmail || "unknown"})`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[sessions] clear failed:", err?.message);
    res.status(500).json({ ok: false, error: err?.message });
  }
}

/* Canonical routes the dashboard uses. POST (fitting-room ingest) is open but rate
   limited; GET and DELETE are admin-only and require a valid Supabase Auth token. */
app.post("/api/sessions", sessionLimiter, saveSession);
app.get("/api/sessions", requireAdminAuth, getSessions);
app.delete("/api/sessions", requireAdminAuth, clearSessions);

/* Back-compat aliases (older clients / earlier code paths).
   SECURITY: these MUST carry the same guards as the canonical routes above - the
   GET/DELETE aliases previously had NO auth, which fully bypassed the admin gate
   (unauthenticated read of all data + wipe of the entire table). */
app.post("/api/session-log",      sessionLimiter, saveSession);
app.get("/api/admin/sessions",    requireAdminAuth, getSessions);
app.delete("/api/admin/sessions", requireAdminAuth, clearSessions);

/* User identity routes (returning-visitor recognition). POST is rate limited; the
   public GET returns non-PII fields only; the admin list is auth-gated. */
app.post("/api/users",            userLimiter, createUser);
// NOTE: /api/users/relink must be registered BEFORE the /:deviceId param
// route below - otherwise Express would match "relink" as a deviceId value
// and this handler would never be reached.
app.patch("/api/users/relink",    userLimiter, relinkUserDevice);
app.get("/api/users/:deviceId",   getUserByDevice);
app.patch("/api/users/:deviceId", userLimiter, updateUserMeasurements);
app.get("/api/admin/users",       requireAdminAuth, getUsersWithCounts);

/* Pre-login allowlist check: the admin login page calls this before requesting a
   magic link so only ADMIN_EMAILS + ADMIN_PASSWORDS matches ever trigger a
   Supabase email send. Returns only { allowed: true|false } - no PII, no
   token, no session. POST with a JSON body (not GET query params) so the
   password is never written into a URL - URLs land in server/proxy access
   logs and browser history in plaintext, which a query-string password would
   leak into. ADMIN_PASSWORDS must list one password per ADMIN_EMAILS entry,
   in the SAME ORDER (index i pairs with index i). Rate limited - this is a
   password-guessing target. */
app.post("/api/admin/check-auth", authLimiter, (req, res) => {
  const email    = (req.body?.email || "").toLowerCase().trim();
  const password = req.body?.password || "";
  const allowed = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.toLowerCase().trim());
  console.log('[admin-auth] email received:', email);
  console.log('[admin-auth] allowed emails:', allowed);
  const emailIndex = allowed.indexOf(email);
  if (emailIndex === -1) {
    console.log('[admin-auth] match result:', false);
    return res.json({ allowed: false });
  }
  const passwords = (process.env.ADMIN_PASSWORDS || "")
    .split(",")
    .map((p) => p.trim());
  const correctPassword = passwords[emailIndex];
  if (!correctPassword || password !== correctPassword) {
    console.log('[admin-auth] match result:', false);
    return res.json({ allowed: false });
  }
  console.log('[admin-auth] match result:', true);
  res.json({ allowed: true });
});

/* ── In-memory image cache - avoids re-fetching the same CDN image within a warm
   Lambda container. Keyed by full URL; evicts oldest entry when the cap is hit.
   Vercel's CDN also caches the HTTP response (via Cache-Control), so Decart's
   server often hits the edge cache on repeat fetches - this cache additionally
   cuts Lambda execution time for the first in-process hit. */
const imgCache = new Map();
const IMG_CACHE_MAX = 50;

/* ── Image-proxy SSRF guard ────────────────────────────────────────────────────
   The proxy fetches an arbitrary caller-supplied URL server-side. We block
   private/internal network ranges (where SSRF is dangerous), but allow any
   public http(s) host - including plain HTTP - so widget garments from any
   store load without manual allowlist additions.
   Blocked ranges:
     • loopback:      127.0.0.0/8
     • private A:     10.0.0.0/8
     • private B:     172.16.0.0/12
     • private C:     192.168.0.0/16
     • link-local:    169.254.0.0/16  (AWS/GCP metadata endpoint)
     • IPv6 loopback: ::1
     • plain hostname: localhost, *.local, *.internal                          */
function isPrivateHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;

  // IPv6 loopback / link-local
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("[::1]") || h.startsWith("[fe80:")) return true;

  // Named internal hosts
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;

  // IPv4 literal check
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 127)                        return true;  // loopback
    if (a === 10)                         return true;  // private A
    if (a === 172 && b >= 16 && b <= 31)  return true;  // private B
    if (a === 192 && b === 168)           return true;  // private C
    if (a === 169 && b === 254)           return true;  // link-local / metadata
    return true; // all other bare IP literals - block by default
  }

  return false;
}

/* BUG FIX: this used to hard-require HTTPS, silently 403-ing every plain-HTTP
   product image (some storefronts, e.g. older Israeli retail sites, still serve
   CDN images over http://) even though the request-validation above it already
   advertises "http(s)" and accepts both. SSRF protection is about the
   DESTINATION host (isPrivateHost, unchanged below), not the transport, so
   allowing http: here doesn't weaken it - it just stops rejecting legitimate
   public images that happen not to be TLS. */
function isProxyHostAllowed(hostname, protocol) {
  if (protocol !== "https:" && protocol !== "http:") return false;
  return !isPrivateHost(hostname);
}

/* ── Image proxy - fetches garment images server-side to sidestep CORS restrictions
   on CDN hosts (cdn.suitsupply.com, img.magnific.com, etc.) that block browser
   cross-origin fetch.  The Decart SDK calls fetch(imageUrl) internally when you
   pass a URL string to rtClient.set(), which fails for those CDNs.  By proxying
   through this endpoint the browser always makes a same-origin request, and the
   server (no CORS restriction) retrieves the image and pipes it back as a Blob.
   The client then passes the Blob directly to rtClient.set() - no CDN fetch needed.
   ─────────────────────────────────────────────────────────────────────────────── */
app.get("/api/img-proxy", proxyLimiter, async (req, res) => {
  const raw = req.query.url;
  console.log(`[img-proxy] request for url=${raw ? String(raw).slice(0, 200) : "(missing)"}`);
  if (!raw) return res.status(400).json({ error: "missing_url", message: "?url= is required" });

  let parsed;
  try {
    parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    console.warn(`[img-proxy] invalid url: "${raw}"`);
    return res.status(400).json({ error: "invalid_url", message: "url must be an absolute http(s) URL" });
  }

  // SSRF guard - block private/internal hosts; http(s) both allowed (see isProxyHostAllowed).
  if (!isProxyHostAllowed(parsed.hostname, parsed.protocol)) {
    console.warn(`[img-proxy] blocked disallowed host: "${parsed.hostname}" (protocol: ${parsed.protocol})`);
    return res.status(403).json({ error: "host_not_allowed", message: "This image host is not permitted." });
  }

  const cacheKey = parsed.href;
  if (imgCache.has(cacheKey)) {
    const { buffer, contentType } = imgCache.get(cacheKey);
    return res
      .set("Content-Type", contentType)
      .set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
      .set("Access-Control-Allow-Origin", "*")
      .set("X-Cache", "HIT")
      .send(buffer);
  }

  try {
    const upstream = await fetch(parsed.href, {
      headers: { "User-Agent": "PEAR-VTON-Proxy/1.0" },
    });
    if (!upstream.ok) {
      return res.status(502).json({
        error: "upstream_error",
        message: `Upstream returned HTTP ${upstream.status} for ${parsed.href}`,
      });
    }
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Populate in-process cache (oldest-first eviction at cap).
    if (imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
    imgCache.set(cacheKey, { buffer, contentType });

    res
      .set("Content-Type", contentType)
      .set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
      .set("Access-Control-Allow-Origin", "*")
      .send(buffer);
  } catch (err) {
    console.error("[img-proxy] fetch failed:", err?.message || err);
    res.status(502).json({ error: "proxy_fetch_failed", message: err?.message || String(err) });
  }
});

/* ── Garment front/back classification (Gemini + Supabase cache) ────────────────
   Classifies a garment product photo as depicting the front or back of the item.
   Backed by the garment_cache table (see supabase_setup_v5.sql) so the same CDN
   image is never re-classified - shared with scanner/scan-store.js, which writes
   to the same table during a bulk store crawl.
   Requires GEMINI_API_KEY (https://aistudio.google.com/apikey) in .env.        */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_CLASSIFY_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

async function fetchImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status}`);
  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: contentType };
}

async function classifyFrontBack(imageUrl) {
  const secureUrl = imageUrl.replace(/^http:\/\//, 'https://');
  const { base64, mimeType } = await fetchImageAsBase64(secureUrl);
  const resp = await fetch(GEMINI_CLASSIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Is this the front or the back of the garment? Answer with exactly one word: front or back" },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const answer = text.trim().toLowerCase();
  return answer.includes("back") ? "back" : "front";
}

async function getCachedClassification(imageUrl) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("garment_cache")
    .select("classification")
    .eq("image_url", imageUrl)
    .maybeSingle();
  if (error) { console.warn("[garment_cache] read failed:", error.message); return null; }
  return data ? data.classification : null;
}

async function saveClassification(imageUrl, classification) {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("garment_cache")
    .upsert([{ image_url: imageUrl, classification }], { onConflict: "image_url" });
  console.log('[classify] Supabase save result:', data, error);
  if (error) console.warn("[garment_cache] write failed:", error.message);
}

/* POST /api/classify-images - { images: string[] } → { results: ("front"|"back")[] },
   one result per input URL, in order. Cache-first; uncached images are classified via
   Gemini and written back to garment_cache. A single image's classification failure
   falls back to "front" rather than failing the whole batch. */
app.post("/api/classify-images", classifyLimiter, async (req, res) => {
  console.log('[classify] Received images:', req.body.images);
  // Belt-and-suspenders alongside the PUBLIC_API_PATHS bypass in the shared /api
  // CORS middleware above (which already sets these for this path) - explicit
  // here too so this endpoint's cross-origin behavior doesn't silently depend on
  // that middleware never changing.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const images = Array.isArray(req.body?.images)
    ? req.body.images.filter((u) => typeof u === "string" && u)
    : [];
  if (!images.length) {
    return res.status(400).json({ error: "missing_images", message: "images: string[] is required." });
  }
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: "gemini_unconfigured", message: "GEMINI_API_KEY not set." });
  }

  const uniqueUrls = [...new Map(
      images.map(url => [url.split('?')[0], url])
  ).values()];

  const results = [];
  for (const url of uniqueUrls) {
    try {
      let classification = await getCachedClassification(url);
      if (!classification) {
        classification = await classifyFrontBack(url);
        await saveClassification(url, classification);
        await new Promise((r) => setTimeout(r, 1100)); // stay under Gemini's 60 RPM
      }
      results.push(classification);
    } catch (err) {
      console.error(`[classify-images] failed for ${url}:`, err?.message || err);
      results.push("front");
    }
  }
  res.json({ results });
});

/* POST /api/store-catalog - { domain, type } → { items: [{ image_url, classification }] }
   Backs "Complete the Look" for a widget/store session (see fetchStoreLookItems in
   fitting-room/app.js): recommends garments already cached for the SAME store domain
   instead of the hardcoded demo PEAR_CATALOG - a real shopper should never be shown
   stock photos of unrelated merchandise. `type` is accepted but NOT filtered on here:
   garment_cache's `classification` column is front|back (see classifyFrontBack above),
   not a garment category, so the client filters these same rows by category itself
   via guessTypeFromUrl(). No cached rows yet for a domain → an empty list, which the
   client treats as "hide the section" rather than falling back to the demo catalog. */
app.post("/api/store-catalog", storeCatalogLimiter, async (req, res) => {
  const domain = typeof req.body?.domain === "string" ? req.body.domain.trim() : "";
  if (!domain) {
    return res.status(400).json({ error: "missing_domain", message: "domain is required." });
  }
  if (!supabase) {
    return res.json({ items: [] });   // DB not configured - empty result, not an error the caller must handle
  }
  try {
    const { data, error } = await supabase
      .from("garment_cache")
      .select("image_url, classification")
      .ilike("image_url", `%${domain}%`)
      .limit(8);
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) {
    console.error("[store-catalog] query failed:", err?.message || err);
    res.status(500).json({ error: "query_failed", message: err?.message || String(err) });
  }
});

app.all("/api/*", (req, res) => {
  // Previously silent - a 404 here left zero trace in the server logs, making
  // it impossible to tell an unmatched API route from a client-side failure.
  console.warn(`[api] 404 - no route matched: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "not_found", message: `No API route for ${req.method} ${req.path}` });
});

/* ── Embeddable widget (pear-widget.js) ────────────────────────────────────
   Served with an explicit route so it carries CORS + cache headers - stores
   embed it with a plain <script src> from any origin. */
app.get("/widget/pear-widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(path.join(__dirname, "widget/pear-widget.js"));
});

/* Store-integration guide (widget/pear-widget-guide.html). */
app.get("/widget/guide", (req, res) => {
  res.sendFile(path.join(__dirname, "widget/pear-widget-guide.html"));
});

/* Root redirect - index.html no longer exists, so send visitors straight to the
   fitting room instead of falling through to a 404. Registered before the static
   middleware so it takes priority over any static-file resolution for "/". */
app.get("/", (req, res) => {
  res.redirect("/fitting-room/");
});

/* ── Static hosting ──────────────────────────────────────────────────────── */
const uiRoot = __dirname;

/* serve-static for all assets (JS, CSS, images, fonts…) */
app.use(express.static(uiRoot, { extensions: ["html"], index: false }));

/* Page router - resolves every URL to the right HTML file under ui/ */
app.use((req, res) => {
  const candidates = [
    path.join(uiRoot, req.path),                     // exact file
    path.join(uiRoot, req.path, "index.html"),        // directory index
    path.join(uiRoot, req.path.replace(/\/$/, "") + ".html"), // extensionless → .html
    path.join(uiRoot, "index.html"),                  // SPA fallback
  ];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        console.log(`[page-router] ${req.method} ${req.path} → ${path.relative(uiRoot, file) || "index.html"}`);
        return res.sendFile(file);
      }
    } catch {}
  }
  // Unreachable in practice - candidate 4 (root index.html) always exists, so this
  // route never actually 404s; logged anyway in case that ever changes.
  console.warn(`[page-router] 404 - no file resolved for ${req.method} ${req.path}`);
  res.status(404).json({ error: "not_found", path: req.path });
});

/* ── Start (local only - Vercel manages its own listener) ────────────────── */
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log("\n────────────────────────────────────────────────────────");
    console.log(`  PEAR VTON server → http://localhost:${PORT}`);
    console.log(`  Storefront  : http://localhost:${PORT}/`);
    console.log(`  Fitting room: http://localhost:${PORT}/fitting-room/   ← OPEN THIS`);
    console.log(`  Decart      : ${decart ? `SDK ready (${VTON_MODEL}, TTL ${TOKEN_TTL}s)` : "SDK not ready - will use REST fallback"}`);
    console.log(`  Key source  : ${KEY_SOURCE || "(none - set DECART_API_KEY in .env)"}`);
    console.log(`  REST order  : ${REST_ENDPOINTS.join(" → ")}`);
    if (ORIGINS_LOCKED) {
      console.log(`  Origin lock : ${ALLOWED_ORIGINS.join(", ")}`);
    } else {
      console.warn("  ⚠ CORS open : DECART_ALLOWED_ORIGINS not set - all origins allowed.");
      console.warn("    Set it in .env or Vercel env vars before going to production:");
      console.warn("    DECART_ALLOWED_ORIGINS=https://yourstore.vercel.app");
    }
    console.log("────────────────────────────────────────────────────────\n");
  });
}

export default app;
