/* GET /api/store-size-chart - lib/store-size-charts.js, with a fake Supabase client
   ─────────────────────────────────────────────────────────────────────────────
   §1 CLAMPS RE-APPLIED ON READ. A stored row came from a stranger's HTML; the server is
      the last gate before a shopper. Out-of-range, inverted, non-numeric and malformed
      bands are dropped (the row keeps its good bands), rows left with nothing are
      dropped, a chart left with < 2 rows is not served.
   §2 THE HANDLER. 400 only for a missing/unusable host; every storage problem - no
      Supabase configured, the v15 migration not run, a query error, a throw - is a 200
      with an empty list, which the room reads as "use the vetted default matrix".
   §3 THE QUERY. Store-wide (product_key ''), active rows only, for the canonical host.
   §4 LOCKSTEP (CLAUDE.md §3). STORE_CHART_CLAMPS agrees across lib/store-size-charts.js,
      lib/sizing.js (the overlay's and the live reader's - the fit moved server-side with
      the code hiding, §2.12) and the scanner's reader source, and canonicalStoreHost
      agrees across widget / app.js / lib / scanner, by value.
   §5 WIRING. server.js registers the route, above the /api/* 404 catch-all.
   ============================================================================= */
import { readFileSync } from "node:fs";
import {
  STORE_CHART_CLAMPS, canonicalStoreHost, toOverlayRows, toRoomChart, loadStoreSizeCharts,
  makeStoreSizeChartHandler, isMissingTableError,
} from "../lib/store-size-charts.js";
import { canonicalStoreHost as scannerHost } from "../scanner/size-charts.js";
import { STORE_CHART_CLAMPS as FIT_CLAMPS, SIZE_CHART_CLAMPS as READER_CLAMPS } from "../lib/sizing.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SCANNER_READER = readFileSync(new URL("../scanner/size-chart-reader.src.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
  if (b === -1) throw new Error(`end not found: ${end}`);
  return src.slice(a, b);
}

const GOOD_ROWS = [
  { size: "S", aliases: { eu: "46" }, body: { chest: [90, 95], waist: [76, 81] } },
  { size: "M", aliases: { eu: "48", bogus: "x", us: "<script>" }, body: { chest: [96, 101], waist: [82, 87] } },
  { size: "L", body: { chest: [102, 107], waist: [88, 93], outseam: [102, 107] } },
];

console.log("\n── §1 clamps re-applied on read ──");
{
  const rows = toOverlayRows(GOOD_ROWS);
  check("§1.1 stored shape -> the overlay's flat shape", rows.length === 3 && rows[1].minChest === 96 &&
    rows[1].maxWaist === 87 && rows[2].minLegs === 102, JSON.stringify(rows));
  check("§1.2 outseam is served as the overlay's Legs column", rows[2].maxLegs === 107);
  check("§1.3 only known alias keys with token-shaped values survive",
    JSON.stringify(rows[1].aliases) === '{"eu":"48"}', JSON.stringify(rows[1].aliases));

  const hostile = toOverlayRows([
    { size: "S", body: { chest: [10, 20], waist: [76, 81] } },            // a price column
    { size: "M", body: { chest: [101, 96] } },                             // inverted
    { size: "L", body: { chest: ["a", "b"], waist: [88, 250] } },          // junk + over-clamp
    { size: "XL", body: { chest: [108, 113], height: [180, 190], weight: [80, 90] } },
    { size: "XXL", body: { legs: [100, 110] } },                           // unknown key
    { size: "S", body: { chest: [90, 95] } },                              // duplicate size
    { size: "", body: { chest: [90, 95] } },
    { size: "<b>", body: { chest: [90, 95] } },
    null, 42, "x",
  ]);
  check("§1.4 an out-of-clamp band is dropped, the row keeps its good band",
    hostile[0] && hostile[0].size === "S" && hostile[0].minChest === undefined && hostile[0].minWaist === 76,
    JSON.stringify(hostile[0]));
  check("§1.5 inverted / non-numeric / over-clamp rows with nothing left are dropped",
    !hostile.some((r) => r.size === "M" || r.size === "L"), JSON.stringify(hostile.map((r) => r.size)));
  check("§1.6 height/weight in a stored row are never served", hostile.every((r) =>
    !Object.keys(r).some((k) => /height|weight/i.test(k))), JSON.stringify(hostile));
  check("§1.7 unknown body keys, duplicates, empty and non-token sizes, junk rows: all dropped",
    hostile.map((r) => r.size).join("/") === "S/XL", hostile.map((r) => r.size).join("/"));
  check("§1.8 non-array input -> []", toOverlayRows(null).length === 0 && toOverlayRows("x").length === 0);

  const chart = { gender: "men", age_group: "adult", garment_type: "tops", size_system: "alpha", rows: GOOD_ROWS, source: "linked_page" };
  check("§1.9 a valid DB row becomes a room chart", toRoomChart(chart)?.rows.length === 3);
  check("§1.10 an unknown gender/age/type enum is not served",
    toRoomChart({ ...chart, gender: "x" }) === null && toRoomChart({ ...chart, age_group: "teen" }) === null &&
    toRoomChart({ ...chart, garment_type: "hats" }) === null);
  check("§1.11 a chart left with < 2 usable rows is not served",
    toRoomChart({ ...chart, rows: [GOOD_ROWS[0], { size: "M", body: { chest: [1, 2] } }] }) === null);
}

/* A fake supabase-js query builder that records the filters it was given. */
function fakeClient(result) {
  const q = { filters: [], order: null, limit: null, select: null };
  const builder = {
    select(cols) { q.select = cols; return builder; },
    eq(col, val) { q.filters.push([col, val]); return builder; },
    order(col, o) { q.order = [col, o]; return builder; },
    limit(n) { q.limit = n; return typeof result === "function" ? result() : Promise.resolve(result); },
  };
  return { q, client: { from(t) { q.table = t; return builder; } } };
}
function fakeRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
const DB_ROW = { gender: "men", age_group: "adult", garment_type: "tops", size_system: "alpha",
  rows: GOOD_ROWS, source: "linked_page", confidence: 0.9, updated_at: "2026-09-26T10:00:00Z" };

console.log("\n── §2 the handler ──");
{
  let { client } = fakeClient({ data: [DB_ROW], error: null });
  let res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "https://WWW.Fox.co.il/" } }, res);
  check("§2.1 200 with the store's charts", res.statusCode === 200 && res.body.host === "fox.co.il" &&
    res.body.charts.length === 1 && res.body.charts[0].rows[0].minChest === 90, JSON.stringify(res.body));
  check("§2.2 cacheable for a few minutes", /max-age=300/.test(res.headers["Cache-Control"] || ""));
  check("§2.3 no note on the happy path", res.body.note === undefined);

  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: {} }, res);
  check("§2.4 missing host -> 400", res.statusCode === 400 && res.body.error === "missing_host");
  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "localhost" } }, res);
  check("§2.5 a non-host -> 400", res.statusCode === 400);

  res = fakeRes();
  await makeStoreSizeChartHandler(() => null)({ query: { host: "fox.co.il" } }, res);
  check("§2.6 no Supabase configured -> 200, empty, storage_unavailable",
    res.statusCode === 200 && res.body.charts.length === 0 && res.body.note === "storage_unavailable", JSON.stringify(res.body));

  ({ client } = fakeClient({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.store_size_charts' in the schema cache" } }));
  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "fox.co.il" } }, res);
  check("§2.7 migration NOT run -> 200, empty, table_missing (the pre-v15 state is safe)",
    res.statusCode === 200 && res.body.charts.length === 0 && res.body.note === "table_missing", JSON.stringify(res.body));

  ({ client } = fakeClient({ data: null, error: { code: "57014", message: "statement timeout" } }));
  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "fox.co.il" } }, res);
  check("§2.8 any other query error -> 200, empty, query_failed", res.body.charts.length === 0 && res.body.note === "query_failed");

  ({ client } = fakeClient(() => { throw new Error("network down"); }));
  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "fox.co.il" } }, res);
  check("§2.9 a throwing client -> 200, empty, query_failed", res.statusCode === 200 && res.body.note === "query_failed");

  ({ client } = fakeClient({ data: [DB_ROW, { ...DB_ROW, gender: "nope" }, { ...DB_ROW, rows: [] }], error: null }));
  res = fakeRes();
  await makeStoreSizeChartHandler(() => client)({ query: { host: "fox.co.il" } }, res);
  check("§2.10 unusable rows are filtered, not fatal", res.body.charts.length === 1);

  check("§2.11 isMissingTableError: 42P01 and PGRST205, not other codes",
    isMissingTableError({ code: "42P01" }) && isMissingTableError({ code: "PGRST205" }) && !isMissingTableError({ code: "23505", message: "dup" }));
}

console.log("\n── §3 the query ──");
{
  const { q, client } = fakeClient({ data: [], error: null });
  await loadStoreSizeCharts(client, "fox.co.il");
  const f = Object.fromEntries(q.filters);
  check("§3.1 reads store_size_charts", q.table === "store_size_charts");
  check("§3.2 ...for the canonical host", f.store_domain === "fox.co.il");
  check("§3.3 ...active rows only", f.status === "active");
  check("§3.4 ...store-wide rows only (product_key '')", f.product_key === "");
  check("§3.5 ...newest first, capped", q.order[0] === "updated_at" && q.order[1].ascending === false && q.limit === 50);
  check("§3.6 ...and never selects the raw snapshot", !/raw_snapshot/.test(q.select));
}

console.log("\n── §4 lockstep across files ──");
{
  const scannerClamps = (await import("data:text/javascript," + encodeURIComponent(
    slice(SCANNER_READER, "var SIZE_CHART_CLAMPS = {", "};") + "};\nexport { SIZE_CHART_CLAMPS };"))).SIZE_CHART_CLAMPS;
  for (const k of ["chest", "waist", "hips", "legs"]) {
    check(`§4 ${k} clamp: lib == the fit's overlay == the live reader == the scanner's reader`,
      STORE_CHART_CLAMPS[k][0] === FIT_CLAMPS[k][0] && STORE_CHART_CLAMPS[k][1] === FIT_CLAMPS[k][1] &&
      STORE_CHART_CLAMPS[k][0] === READER_CLAMPS[k].min && STORE_CHART_CLAMPS[k][1] === READER_CLAMPS[k].max &&
      STORE_CHART_CLAMPS[k][0] === scannerClamps[k].min && STORE_CHART_CLAMPS[k][1] === scannerClamps[k].max,
      `lib ${STORE_CHART_CLAMPS[k]} fit ${FIT_CLAMPS[k]} reader ${JSON.stringify(READER_CLAMPS[k])} scanner ${JSON.stringify(scannerClamps[k])}`);
  }
  check("§4 the widget no longer carries a clamp table (it only collects tables)", !/SIZE_CHART_CLAMPS/.test(PW));
  const fnSrc = (src) => slice(src, "function canonicalStoreHost(raw) {", "\n}") + "\n}";
  const appHost = (await import("data:text/javascript," + encodeURIComponent(fnSrc(APP) + "\nexport { canonicalStoreHost };"))).canonicalStoreHost;
  const widgetHost = (await import("data:text/javascript," + encodeURIComponent(
    slice(PW, "function canonicalStoreHost(raw) {", "\n  }\n") + "\n  }\nexport { canonicalStoreHost };"))).canonicalStoreHost;
  const inputs = ["https://WWW.Fox.co.il/products/x?y=1", "fox.co.il", "m.castro.com", "www2.terminalx.com:8443",
    "shop.adidas.co.il.", "user@store.example", "localhost", "", null, "a b.com", "xn--4dbrk0ce.co.il", "HTTP://Store.Example#x"];
  for (const i of inputs) {
    const want = canonicalStoreHost(i);
    check(`§4 canonicalStoreHost(${JSON.stringify(i)}) = "${want}" in all four copies`,
      appHost(i) === want && widgetHost(i) === want && scannerHost(i) === want,
      `app "${appHost(i)}" widget "${widgetHost(i)}" scanner "${scannerHost(i)}"`);
  }
}

console.log("\n── §5 wiring ──");
{
  const route = SERVER.indexOf('app.get("/api/store-size-chart"');
  const catchAll = SERVER.indexOf('app.all("/api/*"');
  check("§5.1 server.js registers GET /api/store-size-chart", route > 0);
  check("§5.2 ...above the /api/* 404 catch-all", route > 0 && catchAll > route);
  check("§5.3 ...through the lib handler, with a rate limiter",
    /app\.get\("\/api\/store-size-chart", storeCatalogLimiter, makeStoreSizeChartHandler\(\(\) => supabase\)\)/.test(SERVER));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("store-size-chart-api: all checks passed.");
