/* garment_cache.age_group - written on new rows, never wiped, whatever schema prod has
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED 2026-10-01: rows created in garment_cache AFTER the age_group backfill still
   have age_group = NULL (production, rows from 2026-08-23 on).

   Production's garment_cache is not a clean migration prefix - it has V9 (canonical_url)
   and V11 (age_group) WITHOUT V8 (confidence/source/cue/product_url). Three things
   dropped or erased age_group on that table:
     1. server writes - the fallback ladder assumed columns arrive in version order; its
        "no v8" retry still carried v12/v13/v14, so a table missing any of those fell to
        the bare v5 row (and before 2026-09-15 both writers dropped v11 FIRST);
     2. server reads - every tier selected the v8 columns, so the read came back
        { age_group: null } even when the column held "kids";
     3. server re-saves - GET /api/garment-category re-upserts the row it just read, and
        the write sent `age_group: meta.ageGroup || null` unconditionally: the null from
        (2) overwrote the real value on every try-on.

   This runs the REAL saveClassification() / getCachedClassificationDetailed() from
   server.js and saveClassification() from scanner/scan-store.js (sliced, CLAUDE.md §2.6)
   against a fake table that rejects unknown columns exactly the way PostgREST does and
   merges on conflict exactly the way an upsert does. Every §1-§3 case fails on the code
   before this fix.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRV = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SCAN = readFileSync(new URL("../scanner/scan-store.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function slice(src, start, end) {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`marker not found: ${start}`);
  const b = src.indexOf(end, a);
  if (b === -1) throw new Error(`end marker not found: ${end}`);
  return src.slice(a, b);
}

/* ── the schemas ────────────────────────────────────────────────────────────── */
const V5 = ["id", "image_url", "classification", "created_at"];
const V8 = ["confidence", "source", "cue", "product_url", "updated_at"];
const V9 = ["canonical_url"];
const V11 = ["age_group", "age_group_confidence"];
const V12 = ["text_ocr", "is_true_back_view", "primary_color_hex", "has_graphic", "classifier_version"];
const V13 = ["garment_category"];
const V14 = ["size_run_type"];
const SCHEMAS = {
  production: [...V5, ...V9, ...V11],                                  // v9 + v11, no v8
  productionPlus: [...V5, ...V9, ...V11, ...V12, ...V13, ...V14],       // + v12-14, still no v8
  full: [...V5, ...V8, ...V9, ...V11, ...V12, ...V13, ...V14],
  preV11: [...V5, ...V8, ...V9],
};

/* A garment_cache that behaves like PostgREST: an unknown column on write -> PGRST204
   "Could not find the 'x' column ..."; on select -> 42703 "column garment_cache.x does not
   exist"; upsert = merge the provided columns into the conflicting row. `anonymous` makes
   the errors name no column, to exercise the fallback order. */
function fakeTable(columns, { anonymous = false } = {}) {
  const have = new Set(columns);
  const rows = [];
  const writes = [];
  const missing = (cols, mode) => {
    const c = cols.find((k) => !have.has(k));
    if (!c) return null;
    if (anonymous) return { message: "column <redacted> does not exist", code: "42703" };
    return mode === "write"
      ? { message: `Could not find the '${c}' column of 'garment_cache' in the schema cache`, code: "PGRST204" }
      : { message: `column garment_cache.${c} does not exist`, code: "42703" };
  };
  const client = {
    from() {
      return {
        upsert: async (list, { onConflict }) => {
          const row = list[0];
          const err = missing(Object.keys(row), "write");
          if (err) return { error: err };
          writes.push({ ...row });
          const hit = rows.find((r) => r[onConflict] === row[onConflict]);
          if (hit) Object.assign(hit, row); else rows.push({ ...row });
          return { error: null };
        },
        select: (colStr) => {
          const cols = colStr.split(",").map((c) => c.trim());
          let filter = null;
          const b = {
            eq: (col, val) => { filter = [col, val]; return b; },
            limit: () => b,
            maybeSingle: async () => {
              const err = missing(cols, "read") || (filter && !have.has(filter[0]) ? missing([filter[0]], "read") : null);
              if (err) return { data: null, error: err };
              const hit = rows.find((r) => r[filter[0]] === filter[1]);
              if (!hit) return { data: null, error: null };
              return { data: Object.fromEntries(cols.map((c) => [c, hit[c] ?? null])), error: null };
            },
          };
          return b;
        },
      };
    },
  };
  return { client, rows, writes };
}

const canonical = (u) => String(u).split("?")[0].toLowerCase();

/* ── the real code, sliced ──────────────────────────────────────────────────── */
const SERVER_SPAN = slice(SRV, "async function garmentCacheQuery(imageUrl, columns) {", "/* Per-product view lookup");
function loadServer(supabase) {
  const warnings = [];
  const fakeConsole = { warn: (...a) => warnings.push(a.join(" ")), log() {}, error() {} };
  const api = new Function("supabase", "canonicalImageUrl", "console",
    SERVER_SPAN + "\nreturn { saveClassification, getCachedClassificationDetailed };")(supabase, canonical, fakeConsole);
  return { ...api, warnings };
}
const SCANNER_FN = slice(SCAN, "async function saveClassification(", "/* ── Gemini classification");
function loadScanner(supabase) {
  const warnings = [];
  const fakeConsole = { warn: (...a) => warnings.push(a.join(" ")), log() {}, error() {} };
  const save = new Function("supabase", "canonicalImageUrl", "MISSING_COLUMN_RE", "console",
    SCANNER_FN + "\nreturn saveClassification;")(supabase, canonical, /column .* does not exist|Could not find the/i, fakeConsole);
  return { save, warnings };
}

const URL1 = "https://cdn.example.com/kids-tee.jpg?width=800";
const GEMINI = { confidence: 0.92, source: "gemini", cue: "front placket", ageGroup: "kids", ageGroupConfidence: 0.91 };

console.log("\n── §1 server: a NEW row gets its age_group on production's schema ──");
for (const name of ["production", "productionPlus", "full"]) {
  const t = fakeTable(SCHEMAS[name]);
  const srv = loadServer(t.client);
  await srv.saveClassification(URL1, "front", { ...GEMINI, textOcr: "SUPER", classifierVersion: 3, garmentCategory: "tops", sizeRunType: "alpha" });
  const row = t.rows[0];
  check(`§1 [${name}] the row exists, keyed by canonical_url`, !!row && row.canonical_url === canonical(URL1), JSON.stringify(row));
  check(`§1 [${name}] age_group = "kids", confidence kept`, row && row.age_group === "kids" && row.age_group_confidence === 0.91,
    JSON.stringify(row));
  const keptAll = SCHEMAS[name].filter((c) => !V5.includes(c) && c !== "updated_at" && c !== "product_url")
    .every((c) => row && row[c] !== undefined);
  check(`§1 [${name}] every column the table HAS was written (no column lost to a ladder)`, keptAll, JSON.stringify(row));
}

console.log("\n── §2 server: the read returns age_group whenever its column exists ──");
for (const name of ["production", "productionPlus", "full"]) {
  const t = fakeTable(SCHEMAS[name]);
  const srv = loadServer(t.client);
  await srv.saveClassification(URL1, "front", GEMINI);
  const cached = await srv.getCachedClassificationDetailed(URL1);
  check(`§2 [${name}] cached.age_group = "kids"`, cached && cached.age_group === "kids", JSON.stringify(cached));
  check(`§2 [${name}] absent columns read as null, garment_category included`,
    cached && (SCHEMAS[name].includes("garment_category") || cached.garment_category === null) &&
    (SCHEMAS[name].includes("text_ocr") || cached.text_ocr === null));
  check(`§2 [${name}] a missing classifier_version column reads UNDEFINED (not stale), a present one is read`,
    cached && (SCHEMAS[name].includes("classifier_version") ? cached.classifier_version !== undefined : cached.classifier_version === undefined),
    String(cached && cached.classifier_version));
}

console.log("\n── §3 server: nothing erases it ──");
{
  const t = fakeTable(SCHEMAS.production);
  const srv = loadServer(t.client);
  await srv.saveClassification(URL1, "front", GEMINI);
  /* GET /api/garment-category's cached branch, verbatim in shape: read, then re-save the
     row with what was read plus the category. */
  const cached = await srv.getCachedClassificationDetailed(URL1);
  await srv.saveClassification(URL1, cached.classification, {
    confidence: cached.confidence, source: cached.source || "gemini", cue: cached.cue,
    ageGroup: cached.age_group, ageGroupConfidence: cached.age_group_confidence,
    textOcr: cached.text_ocr, isTrueBackView: cached.is_true_back_view, hasGraphic: cached.has_graphic,
    primaryColorHex: cached.primary_color_hex, classifierVersion: cached.classifier_version,
    garmentCategory: "tops",
  });
  check("§3.1 the garment-category re-save keeps age_group (it used to write NULL over it)",
    t.rows[0].age_group === "kids" && t.rows[0].age_group_confidence === 0.91, JSON.stringify(t.rows[0]));

  await srv.saveClassification(URL1, "front", { source: "gemini" });
  check("§3.2 a write that carries no age verdict leaves the column alone",
    t.rows[0].age_group === "kids", JSON.stringify(t.rows[0]));
  check("§3.3 ...because it never sends the column at all", !("age_group" in t.writes[t.writes.length - 1]),
    JSON.stringify(t.writes[t.writes.length - 1]));
  await srv.saveClassification(URL1, "front", { ageGroup: "uncertain", ageGroupConfidence: 0.3 });
  check("§3.4 a real verdict (even 'uncertain') is still written", t.rows[0].age_group === "uncertain");
  await srv.saveClassification(URL1, "front", { ageGroup: "teen" });
  check("§3.5 an out-of-vocabulary value is not written", t.rows[0].age_group === "uncertain");
}

console.log("\n── §4 server: degradation still works, and says which migration ──");
{
  const t = fakeTable(SCHEMAS.preV11);
  const srv = loadServer(t.client);
  await srv.saveClassification(URL1, "back", GEMINI);
  check("§4.1 a pre-v11 table still gets the row (no throw), minus the age columns",
    t.rows.length === 1 && t.rows[0].classification === "back" && !("age_group" in t.rows[0]), JSON.stringify(t.rows[0]));
  check("§4.2 ...and the v8 columns that DO exist were kept", t.rows[0].confidence === 0.92 && t.rows[0].source === "gemini");
  check("§4.3 the warning names supabase_setup_v11.sql", srv.warnings.some((w) => /supabase_setup_v11\.sql/.test(w)),
    srv.warnings.join(" | "));
  const r = await srv.getCachedClassificationDetailed(URL1);
  check("§4.4 the read returns the row with age_group null", r && r.classification === "back" && r.age_group === null, JSON.stringify(r));

  const p = fakeTable(SCHEMAS.production);
  const sp = loadServer(p.client);
  await sp.saveClassification(URL1, "front", GEMINI);
  await sp.saveClassification(URL1, "front", GEMINI);
  check("§4.5 production warns about v8 ONCE per process, naming supabase_setup_v8.sql",
    sp.warnings.filter((w) => /supabase_setup_v8\.sql/.test(w)).length === 1, sp.warnings.join(" | "));

  const anon = fakeTable(SCHEMAS.productionPlus, { anonymous: true });
  const sa = loadServer(anon.client);
  await sa.saveClassification(URL1, "front", GEMINI);
  check("§4.6 an error that names NO column: the fallback order gives up age_group LAST",
    anon.rows[0] && anon.rows[0].age_group === "kids", JSON.stringify(anon.rows[0]));
}

console.log("\n── §5 scanner: the same guarantees on its own write path ──");
for (const name of ["production", "full"]) {
  const t = fakeTable(SCHEMAS[name]);
  const sc = loadScanner(t.client);
  await sc.save(URL1, "front", { ...GEMINI, productUrl: "https://shop.example/products/kids-tee" });
  check(`§5 [${name}] scanner row has age_group = "kids"`, t.rows[0] && t.rows[0].age_group === "kids", JSON.stringify(t.rows[0]));
  await sc.save(URL1, "front", { source: "gemini" });
  check(`§5 [${name}] ...and a verdict-less write does not erase it`, t.rows[0].age_group === "kids", JSON.stringify(t.rows[0]));
}
{
  const t = fakeTable(SCHEMAS.preV11);
  const sc = loadScanner(t.client);
  await sc.save(URL1, "front", GEMINI);
  check("§5 [preV11] scanner still writes the row, with its v8 columns", t.rows.length === 1 && t.rows[0].confidence === 0.92,
    JSON.stringify(t.rows[0]));
  check("§5 [preV11] ...and points at supabase_setup_v11.sql", sc.warnings.some((w) => /supabase_setup_v11\.sql/.test(w)));
  const anon = fakeTable(SCHEMAS.production, { anonymous: true });
  const sa = loadScanner(anon.client);
  await sa.save(URL1, "front", GEMINI);
  check("§5 [anonymous errors] scanner gives up age_group last", anon.rows[0] && anon.rows[0].age_group === "kids",
    JSON.stringify(anon.rows[0]));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("garment-cache-age-group: all checks passed.");
