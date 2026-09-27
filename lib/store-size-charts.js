/* =============================================================================
   GET /api/store-size-chart - the store's captured size guides, for the room.
   -----------------------------------------------------------------------------
   The scanner (scanner/size-charts.js, `--size-charts --save`) writes a store's own
   size guides into `store_size_charts` (archive/supabase_setup_v15.sql). The fitting
   room asks for them by store host and uses one ONLY when the widget could not read a
   chart off the product page itself, and ONLY through applyStoreChartOverlay() - the
   fine-tune tie-break. CLAUDE.md §2.5b is unchanged by any of this.

   THE CLAMPS ARE RE-APPLIED HERE, on every read. The rows came from a stranger's HTML
   by way of a database anyone with the service key can write to; this is the last
   server-side gate before they reach a shopper, so a band outside what a human body
   can measure is dropped here rather than trusted. STORE_CHART_CLAMPS is the THIRD
   copy of one decision (widget SIZE_CHART_CLAMPS, app.js STORE_CHART_CLAMPS) - CLAUDE.md
   §3; test/store-size-chart-api.test.mjs compares all three by value.

   EVERYTHING DEGRADES TO "no charts" (CLAUDE.md §2.5): no Supabase configured, the
   migration not run yet, a query error, a malformed row - each answers 200 with an
   empty list, which the room reads as "use the vetted default matrix", i.e. exactly
   the behaviour before this existed. Only a missing/unusable host is a 400, because
   that is a caller bug rather than a store without data.
   ============================================================================= */

export const STORE_CHART_CLAMPS = {
  chest: [50, 200], waist: [40, 200], hips: [50, 200], legs: [40, 140],
};

/* CROSS-FILE LOCKSTEP (CLAUDE.md §3) with widget/pear-widget.js, fitting-room/app.js
   and scanner/size-charts.js - this is the store_size_charts key. */
export function canonicalStoreHost(raw) {
  let h = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
  h = h.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  h = h.replace(/^(?:www\d*|m)\./, "");
  return /^[a-z0-9.-]+$/.test(h) && h.indexOf(".") > 0 ? h : "";
}

/* stored body key -> [overlay column, clamp key]. `outseam` is the parser's `legs`
   (the widget's minLegs/maxLegs convention - see SIZE_CHART_MEASURE_KEYS). */
const BODY_KEYS = { chest: ["Chest", "chest"], waist: ["Waist", "waist"], hips: ["Hips", "hips"], outseam: ["Legs", "legs"] };
const ALIAS_KEYS = new Set(["eu", "us", "uk", "it", "fr", "alt", "int"]);
const TOKEN_RE = /^[A-Za-z0-9]{1,5}$/;

/**
 * Stored rows ({ size, aliases?, body: { chest:[lo,hi], ... } }) -> the flat rows
 * applyStoreChartOverlay() reads ({ size, aliases?, minChest, maxChest, ... }), with
 * every band re-checked against STORE_CHART_CLAMPS. A band that fails is DROPPED (its
 * row keeps the others); a row left with no band is dropped; a duplicate size keeps
 * its first row. Never throws.
 * @returns {Array<object>}
 */
export function toOverlayRows(storedRows) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(storedRows)) return out;
  for (const r of storedRows) {
    try {
      if (!r || typeof r !== "object") continue;
      const size = String(r.size == null ? "" : r.size).trim().toUpperCase();
      if (!size || !TOKEN_RE.test(size) || seen.has(size)) continue;
      const row = { size };
      let bands = 0;
      const body = r.body && typeof r.body === "object" ? r.body : {};
      for (const [key, [cap, clampKey]] of Object.entries(BODY_KEYS)) {
        const band = body[key];
        if (!Array.isArray(band) || band.length !== 2) continue;
        const lo = Number(band[0]), hi = Number(band[1]);
        const [cMin, cMax] = STORE_CHART_CLAMPS[clampKey];
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < cMin || hi > cMax) continue;
        row["min" + cap] = lo;
        row["max" + cap] = hi;
        bands++;
      }
      if (!bands) continue;
      if (r.aliases && typeof r.aliases === "object") {
        const aliases = {};
        for (const [k, v] of Object.entries(r.aliases)) {
          const tok = String(v == null ? "" : v).trim().toUpperCase();
          if (ALIAS_KEYS.has(k) && TOKEN_RE.test(tok)) aliases[k] = tok;
        }
        if (Object.keys(aliases).length) row.aliases = aliases;
      }
      seen.add(size);
      out.push(row);
    } catch { /* one malformed row costs that row, never the chart */ }
  }
  return out;
}

const GENDERS = new Set(["men", "women", "unisex", "unknown"]);
const AGES = new Set(["adult", "kids"]);
const TYPES = new Set(["tops", "bottoms", "jeans", "dresses", "outerwear"]);

/** One DB row -> the chart the room receives, or null when it is not usable. */
export function toRoomChart(dbRow) {
  if (!dbRow || typeof dbRow !== "object") return null;
  if (!GENDERS.has(dbRow.gender) || !AGES.has(dbRow.age_group) || !TYPES.has(dbRow.garment_type)) return null;
  const rows = toOverlayRows(dbRow.rows);
  if (rows.length < 2) return null;
  return {
    gender: dbRow.gender,
    age_group: dbRow.age_group,
    garment_type: dbRow.garment_type,
    size_system: typeof dbRow.size_system === "string" ? dbRow.size_system : "unknown",
    source: typeof dbRow.source === "string" ? dbRow.source : "unknown",
    confidence: Number.isFinite(Number(dbRow.confidence)) ? Number(dbRow.confidence) : null,
    updated_at: dbRow.updated_at || null,
    rows,
  };
}

export function isMissingTableError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || err);
  return code === "42P01" || code === "PGRST205" ||
    (/store_size_charts/.test(msg) && /does not exist|schema cache|not find/i.test(msg));
}

/**
 * Active, store-wide charts for one host, newest first. Product-scoped rows
 * (product_key <> '') are not served yet - Phase 1 reads the store's general guides.
 * @returns {Promise<{charts: Array<object>, note?: string}>}
 */
export async function loadStoreSizeCharts(supabase, host) {
  if (!supabase) return { charts: [], note: "storage_unavailable" };
  try {
    const { data, error } = await supabase
      .from("store_size_charts")
      .select("gender, age_group, garment_type, size_system, rows, source, confidence, updated_at")
      .eq("store_domain", host)
      .eq("status", "active")
      .eq("product_key", "")
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) {
      if (isMissingTableError(error)) return { charts: [], note: "table_missing" };
      console.warn("[store-size-chart] query failed:", error.message || error);
      return { charts: [], note: "query_failed" };
    }
    const charts = (data || []).map(toRoomChart).filter(Boolean);
    return { charts };
  } catch (e) {
    console.warn("[store-size-chart] query threw:", e?.message || e);
    return { charts: [], note: "query_failed" };
  }
}

/** Express handler factory - `getSupabase` so tests can inject a fake client. */
export function makeStoreSizeChartHandler(getSupabase) {
  return async function storeSizeChartHandler(req, res) {
    const host = canonicalStoreHost(req.query ? req.query.host : "");
    if (!host) {
      return res.status(400).json({ error: "missing_host", message: "host is required (a store hostname)." });
    }
    const { charts, note } = await loadStoreSizeCharts(getSupabase(), host);
    if (typeof res.set === "function") res.set("Cache-Control", "public, max-age=300");
    return res.json(note ? { host, charts, note } : { host, charts });
  };
}
