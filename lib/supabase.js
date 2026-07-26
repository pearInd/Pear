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

let supabase = null;

if (url && key) {
  supabase = createClient(url, key, { auth: { persistSession: false } });
} else {
  console.warn(
    "[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set - Supabase " +
    "client DISABLED. Session/user features will return a clear error until " +
    "these are configured. The rest of the site keeps working normally."
  );
}

export { supabase };
