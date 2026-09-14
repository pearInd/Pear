import { createClient } from "@supabase/supabase-js";

/* =============================================================================
   Supabase client - created ONLY when both env vars are present.
   -----------------------------------------------------------------------------
   IMPORTANT: createClient("") throws "supabaseUrl is required." synchronously.
   If we called it unconditionally at module load and SUPABASE_URL were missing,
   the throw would crash the ENTIRE serverless function on cold start - taking
   down every route, including ones that never touch the database (token proxy,
   image proxy, health, the size calculator, camera/MediaPipe assets).

   So instead: if either env var is missing we log a warning and export `null`.
   Callers must null-check `supabase` and return a clear error response rather
   than dereferencing it - the rest of the site keeps working regardless.
   ============================================================================= */
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

/* Which Postgres role a Supabase key authenticates as: "service_role", "anon",
   "authenticated", or "unknown". Pure - no network, no signature check; it only reads
   the claim the key already carries, to catch a configuration mistake.
     sb_secret_* / sb_publishable_*  the newer opaque keys, identified by prefix
     eyJ...                          a legacy JWT key; the role is its `role` claim
   @param {string} k @returns {string} */
function supabaseKeyRole(k) {
  if (typeof k !== "string" || !k) return "unknown";
  if (k.startsWith("sb_secret_")) return "service_role";
  if (k.startsWith("sb_publishable_")) return "anon";
  const parts = k.split(".");
  if (parts.length !== 3) return "unknown";
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof claims.role === "string" && claims.role ? claims.role : "unknown";
  } catch {
    return "unknown";
  }
}

let supabase = null;

if (url && key) {
  /* ── THE ONE WAY RLS CAN SILENTLY EMPTY THIS SERVER'S READS ──────────────────────
     Every server-side table (garment_cache, sessions, users) is meant to be reached with
     the service-role key, which bypasses row-level security. Paste the PUBLIC anon key
     into SUPABASE_SERVICE_ROLE_KEY instead - an easy slip, since admin/admin.js carries
     one - and every query runs as `anon`: with RLS on, reads return an empty 200 rather
     than an error, so a cached verdict or a cached back simply never comes back and
     nothing says why. Warn, never refuse: a wrong refusal would take sessions down
     with it (CLAUDE.md 2.5), and "unknown" stays silent for the same reason. */
  const role = supabaseKeyRole(key);
  if (role === "anon" || role === "authenticated") {
    console.error(
      `[supabase] SUPABASE_SERVICE_ROLE_KEY authenticates as "${role}", not "service_role". ` +
      "Row-level security applies to every server query: with RLS enabled, reads come back " +
      "EMPTY (not failed) and writes are rejected. Set the service-role key from " +
      "Supabase Dashboard → Settings → API."
    );
  }
  supabase = createClient(url, key, { auth: { persistSession: false } });
} else {
  console.warn(
    "[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set - Supabase " +
    "client DISABLED. Session/user features will return a clear error until " +
    "these are configured. The rest of the site keeps working normally."
  );
}

export { supabase, supabaseKeyRole };
