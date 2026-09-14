/* garment_cache access: colourway-scoped back recovery (v14) and the failures that used to
   happen without a word in the log.

   1. getVariantViews() / tagVariantBack() (server.js). Recovery used to be keyed by PRODUCT
      (so one colour could inherit another's rear photo), was never written by the classify
      endpoint, and swallowed "column does not exist" - observed on the project
      admin/admin.js points at: 42703 "column garment_cache.product_url does not exist".
   2. variantKeyOf() in widget/pear-widget.js and scanner/scan-store.js. The server recovers
      by string equality, so the two copies must agree byte for byte.
   3. The scanner's saveClassification() on a database without v14 must drop ONLY
      variant_key, not fall through to the bare v5 row.
   4. supabaseKeyRole() (lib/supabase.js): a non-service-role key makes RLS apply to the
      server, and RLS answers an unauthorised read with an EMPTY 200, not an error. */
import { readFileSync } from "node:fs";
import { supabaseKeyRole } from "../lib/supabase.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const sliceOf = (src, from, to, what) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a === -1 || b === -1) { console.log(`FAIL  could not extract ${what}`); process.exit(1); }
  return src.slice(a, b);
};
async function captureWarn(fn) {
  const lines = [], orig = console.warn;
  console.warn = (...a) => lines.push(a.join(" "));
  try { return { value: await fn(), lines }; } finally { console.warn = orig; }
}

/* ── server.js ───────────────────────────────────────────────────────────────────── */
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const server = await import("data:text/javascript," + encodeURIComponent(
  "const supabase = null;\n" +
  sliceOf(SERVER, "const MISSING_COLUMN_RE = ", "\n", "MISSING_COLUMN_RE") + "\n" +
  sliceOf(SERVER, "const PRESENTATION_PARAMS = new Set([", "/* ── THE PIXEL-LEVEL DUPLICATE CHECK", "URL identity") + "\n" +
  sliceOf(SERVER, "const SOURCE_TRUST = ", "\n/* ── Generated rear view", "colourway cache block") +
  "\nexport { getVariantViews, tagVariantBack, variantBackToTag, sanitizeVariantKey, canonicalImageUrl };"
));
const { getVariantViews, tagVariantBack, variantBackToTag, sanitizeVariantKey, canonicalImageUrl } = server;

/* A client whose query chain resolves to a fixed {data, error}, recording what was asked. */
/* `update` chains end at .eq(); `select` chains end at .limit(). */
function fakeClient(result, { update = false } = {}) {
  const calls = [];
  const chain = {
    select(cols) { calls.push(["select", cols]); return chain; },
    update(row)  { calls.push(["update", row]);  return chain; },
    eq(col, v)   { calls.push(["eq", col, v]);   return update ? Promise.resolve(result) : chain; },
    limit(n)     { calls.push(["limit", n]);     return Promise.resolve(result); },
  };
  return { calls, from(t) { calls.push(["from", t]); return chain; } };
}

console.log("── getVariantViews(): recovery is keyed by COLOURWAY, and a missing migration is reported once ──");
{
  const KEY = "8123456789:black";
  const missing = fakeClient({ data: null, error: { code: "42703", message: "column garment_cache.variant_key does not exist" } });
  const first  = await captureWarn(() => getVariantViews(KEY, missing));
  const second = await captureWarn(() => getVariantViews(KEY, missing));
  check("a missing column still degrades to {} - the classify handler carries on",
    JSON.stringify(first.value) === "{}" && JSON.stringify(second.value) === "{}");
  check("REGRESSION: it is not silent - the first miss warns, naming v8, v9 AND v14",
    first.lines.length === 1 && /supabase_setup_v8\.sql/.test(first.lines[0]) && /v9\.sql/.test(first.lines[0]) &&
    /v14\.sql/.test(first.lines[0]), JSON.stringify(first.lines));
  check("...but only once per process", second.lines.length === 0, JSON.stringify(second.lines));

  const transient = fakeClient({ data: null, error: { message: "fetch failed: ECONNRESET" } });
  const t1 = await captureWarn(() => getVariantViews(KEY, transient));
  const t2 = await captureWarn(() => getVariantViews(KEY, transient));
  check("any OTHER error warns every time", t1.lines.length === 1 && t2.lines.length === 1, JSON.stringify([t1.lines, t2.lines]));

  const F = "https://cdn.shopify.com/s/files/1/cove-front.jpg", B = "https://cdn.shopify.com/s/files/1/cove-back.jpg";
  const ok = fakeClient({ error: null, data: [
    { image_url: F, canonical_url: null, classification: "front", confidence: 0.9, source: "gemini" },
    { image_url: B, canonical_url: null, classification: "back", confidence: 0.8, source: "gemini" },
  ] });
  const r = await getVariantViews(KEY, ok);
  check("with the columns present it returns the colourway's front and back", r.front === F && r.back === B, JSON.stringify(r));
  check("REGRESSION: it filters on variant_key - never on product_url, which mixed colourways",
    ok.calls.some(([k, c, v]) => k === "eq" && c === "variant_key" && v === KEY) &&
    !ok.calls.some(([k, c]) => k === "eq" && c === "product_url"), JSON.stringify(ok.calls));
  check("no client or no key is an immediate {} with no query",
    JSON.stringify(await getVariantViews(KEY, null)) === "{}" && JSON.stringify(await getVariantViews("", ok)) === "{}");
}

console.log("\n── sanitizeVariantKey(): only the widget's shape reaches a query filter ──");
check("a colourway key passes", sanitizeVariantKey("8123456789:black") === "8123456789:black");
check("a single-look product's key (no non-size options) passes", sanitizeVariantKey("8123456789:") === "8123456789:");
check("multi-option and non-Latin values pass", sanitizeVariantKey("8123456789:שחור/organic cotton") === "8123456789:שחור/organic cotton");
check("anything else is dropped to \"\"",
  ["", "black", "abc:black", ":black", "8123456789", 42, null, undefined, "1:" + "x".repeat(201), "1:bad\nkey"]
    .every((v) => sanitizeVariantKey(v) === ""));

console.log("\n── variantBackToTag(): only a back EARNED on this visit is filed ──");
{
  const views = (back_source) => ({ front: "https://x/f.jpg", back: "https://x/b.jpg", back_source });
  check("a DOM-named back is filed", variantBackToTag(views("dom"), "1:black") === "https://x/b.jpg");
  check("a confident classifier back is filed", variantBackToTag(views("classifier"), "1:black") === "https://x/b.jpg");
  check("a low-confidence salvage is NOT filed - the model would not stake the verdict",
    variantBackToTag(views("classifier_weak"), "1:black") === "");
  check("a recovered back is NOT re-filed - it could hop colourways", variantBackToTag(views("cache"), "1:black") === "");
  check("a generated rear is NOT filed - it is not a catalog photo", variantBackToTag(views("synthetic"), "1:black") === "");
  check("no key, or no back, files nothing",
    variantBackToTag(views("classifier"), "") === "" && variantBackToTag({ back: "", back_source: "none" }, "1:black") === "");
}

console.log("\n── tagVariantBack(): an UPDATE by canonical photo, never an insert ──");
{
  const spelled = "https://cdn.shopify.com/s/files/1/cove-back_800x.jpg?v=123";
  const ok = fakeClient({ error: null }, { update: true });
  const accepted = await tagVariantBack(spelled, "1:black", ok);
  check("the write is an update of variant_key only", accepted === true &&
    ok.calls.some(([k, row]) => k === "update" && JSON.stringify(row) === JSON.stringify({ variant_key: "1:black" })),
    JSON.stringify(ok.calls));
  check("...matched on the CANONICAL photo, so the gallery's spelling finds the classified row",
    ok.calls.some(([k, c, v]) => k === "eq" && c === "canonical_url" && v === canonicalImageUrl("https://cdn.shopify.com/s/files/1/cove-back.jpg")),
    JSON.stringify(ok.calls));

  const missing = fakeClient({ error: { message: "Could not find the 'variant_key' column of 'garment_cache' in the schema cache" } }, { update: true });
  const m1 = await captureWarn(() => tagVariantBack(spelled, "1:black", missing));
  const m2 = await captureWarn(() => tagVariantBack(spelled, "1:black", missing));
  check("before v14 it reports false and warns once, naming v14",
    m1.value === false && m1.lines.length === 1 && /v14\.sql/.test(m1.lines[0]) && m2.lines.length === 0,
    JSON.stringify([m1.lines, m2.lines]));
  const idle = fakeClient({ error: null }, { update: true });
  check("no key means no write at all", (await tagVariantBack(spelled, "", idle)) === false && idle.calls.length === 0);
}

console.log("\n── handler wiring (source contract) ──");
{
  const handler = sliceOf(SERVER, 'app.post("/api/classify-images"', "\n});", "classify handler");
  check("the handler reads variant_key through the sanitizer", /sanitizeVariantKey\(req\.body\?\.variant_key\)/.test(handler));
  check("recovery runs only with a key, and never by page_url",
    /if \(!views\.back && variantKey\)/.test(handler) && !/page_url\)\s*\{/.test(handler) && !/getProductViews/.test(handler));
  check("tagging runs AFTER synthesis, so back_source is final when it is read",
    handler.indexOf("synthesizeBackView(") !== -1 && handler.indexOf("variantBackToTag(views, variantKey)") > handler.indexOf("synthesizeBackView("));
}

/* ── LOCKSTEP: widget vs scanner key ─────────────────────────────────────────────── */
console.log("\n── variantKeyOf(): widget and scanner produce the SAME key ──");
const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const SCANNER = readFileSync(new URL("../scanner/scan-store.js", import.meta.url), "utf8");
const widgetKey = new Function(
  sliceOf(WIDGET, "function sizeOptionIndexOf(options) {", "  function loadShopifyProductJSON()", "widget key fns") +
  "\nreturn { sizeOptionIndexOf, variantKeyOf };")();
const scannerKey = new Function(
  sliceOf(SCANNER, "function sizeOptionIndexOf(options) {", "/* File an ALREADY-CACHED photo", "scanner key fns") +
  "\nreturn { sizeOptionIndexOf, variantKeyOf, variantKeyForImage };")();
{
  const product = {
    id: 8123456789,
    options: [{ name: "Color" }, { name: "Size" }],
    variants: [
      { id: 111, option1: "Black", option2: "M" },
      { id: 112, option1: "Black", option2: "L" },
      { id: 211, option1: "Navy",  option2: "M" },
    ],
  };
  const w = (v) => widgetKey.variantKeyOf(product.id, v, widgetKey.sizeOptionIndexOf(product.options));
  const sc = (v) => scannerKey.variantKeyOf(product.id, v, scannerKey.sizeOptionIndexOf(product.options));
  check("LOCKSTEP: both sides agree on every variant", product.variants.every((v) => w(v) === sc(v)),
    JSON.stringify(product.variants.map((v) => [w(v), sc(v)])));
  check("the size is dropped: black M and black L are ONE colourway", w(product.variants[0]) === "8123456789:black" && w(product.variants[1]) === "8123456789:black");
  check("colours stay apart: black and navy never share a key", w(product.variants[0]) !== w(product.variants[2]));
  check("the widget's product.js string-array options resolve the same size index",
    widgetKey.sizeOptionIndexOf(["Color", "Size"]) === 1 && scannerKey.sizeOptionIndexOf(["Color", "Size"]) === 1);
  check("the Hebrew size name is recognised on both sides",
    widgetKey.sizeOptionIndexOf([{ name: "צבע" }, { name: "מידה" }]) === 1 && scannerKey.sizeOptionIndexOf([{ name: "צבע" }, { name: "מידה" }]) === 1);
  const taille = [{ name: "Couleur" }, { name: "Taille" }];
  check("an unrecognised size name keeps size in the key on BOTH sides - lower hit rate, never mixed colours",
    widgetKey.variantKeyOf(1, { option1: "Noir", option2: "M" }, widgetKey.sizeOptionIndexOf(taille)) === "1:noir/m" &&
    scannerKey.variantKeyOf(1, { option1: "Noir", option2: "M" }, scannerKey.sizeOptionIndexOf(taille)) === "1:noir/m");
}

console.log("\n── variantKeyForImage() (scanner): attribute a photo only when it cannot be another colour's ──");
{
  const { variantKeyForImage } = scannerKey;
  const multi = { id: 9, options: [{ name: "Color" }, { name: "Size" }], variants: [
    { id: 1, option1: "Black", option2: "M" }, { id: 2, option1: "Black", option2: "L" }, { id: 3, option1: "Navy", option2: "M" } ] };
  const single = { id: 7, options: [{ name: "Size" }], variants: [{ id: 1, option1: "M" }, { id: 2, option1: "L" }] };
  check("single-colourway product: EVERY photo is tagged, the unassigned rear photo included",
    variantKeyForImage(single, { variant_ids: [] }) === "7:");
  check("multi-colour product: an unassigned photo stays unattributed - it could be any colour's back",
    variantKeyForImage(multi, { variant_ids: [] }) === "");
  check("multi-colour product: a photo assigned to black M and black L is black",
    variantKeyForImage(multi, { variant_ids: [1, 2] }) === "9:black");
  check("multi-colour product: a photo shared by black AND navy stays unattributed",
    variantKeyForImage(multi, { variant_ids: [1, 3] }) === "");
}

/* ── scanner saveClassification(): a pre-v14 database loses ONLY variant_key ─────────── */
console.log("\n── scanner saveClassification(): v14 missing must not fall to the bare v5 row ──");
{
  const upserts = [];
  const client = { from() { return { upsert(rows) {
    upserts.push(rows[0]);
    return Promise.resolve("variant_key" in rows[0]
      ? { error: { message: "Could not find the 'variant_key' column of 'garment_cache' in the schema cache" } }
      : { error: null });
  } }; } };
  const save = new Function("supabase", "canonicalImageUrl",
    sliceOf(SCANNER, "const MISSING_COLUMN_RE = ", "\n", "scanner MISSING_COLUMN_RE") + "\n" +
    sliceOf(SCANNER, "let _v14Warned = false;", "\nfunction sizeOptionIndexOf", "scanner warnV14Once") + "\n" +
    sliceOf(SCANNER, "async function saveClassification(", "\n/* ── Gemini classification", "scanner saveClassification") +
    "\nreturn saveClassification;")(client, (u) => u);
  const r = await captureWarn(() => save("https://x/b.jpg", "back",
    { confidence: 0.9, source: "gemini", cue: "tag", productUrl: "https://s/products/p", variantKey: "9:black", ageGroup: "adult", ageGroupConfidence: 0.8 }));
  const last = upserts[upserts.length - 1] || {};
  check("REGRESSION: the retry drops variant_key and nothing else",
    upserts.length === 2 && !("variant_key" in last) && last.confidence === 0.9 && last.source === "gemini" && last.age_group === "adult",
    JSON.stringify(upserts));
  check("...and says v14 is the missing migration, not v11/v8",
    r.lines.some((l) => /supabase_setup_v14\.sql/.test(l)) && !r.lines.some((l) => /v11 columns absent|V8 columns absent/.test(l)),
    JSON.stringify(r.lines));
  upserts.length = 0;
  await save("https://x/f.jpg", "front", { confidence: 0.9, source: "gemini" });
  check("an unattributed photo never writes variant_key: null over a filed colourway",
    upserts.length === 1 && !("variant_key" in upserts[0]), JSON.stringify(upserts));
}

/* ── lib/supabase.js ─────────────────────────────────────────────────────────────── */
console.log("\n── supabaseKeyRole(): the key the server runs as ──");
{
  const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
  check("a legacy service-role JWT reads as service_role", supabaseKeyRole(jwt({ role: "service_role" })) === "service_role");
  check("REGRESSION: the public anon JWT is caught - RLS would silently empty server reads",
    supabaseKeyRole(jwt({ role: "anon" })) === "anon");
  check("the newer opaque secret key reads as service_role", supabaseKeyRole("sb_secret_abc123") === "service_role");
  check("the newer publishable key reads as anon", supabaseKeyRole("sb_publishable_abc123") === "anon");
  check("anything unparseable is unknown, which never warns (CLAUDE.md 2.5)",
    supabaseKeyRole("not-a-key") === "unknown" && supabaseKeyRole("a.%%%.c") === "unknown" &&
    supabaseKeyRole("") === "unknown" && supabaseKeyRole(undefined) === "unknown");
  const lib = readFileSync(new URL("../lib/supabase.js", import.meta.url), "utf8");
  check("the startup check warns on anon/authenticated only, and still creates the client",
    /if \(role === "anon" \|\| role === "authenticated"\)/.test(lib) &&
    lib.indexOf('role === "anon"') < lib.indexOf("supabase = createClient(url, key"));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
