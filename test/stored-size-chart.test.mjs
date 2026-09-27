/* THE ROOM'S STORED-CHART FALLBACK, EU/US ALIASES AND THE PHASE 0 COMPARISON
   ─────────────────────────────────────────────────────────────────────────────
   Runs the real sizing slice of fitting-room/app.js (the same span every sizing suite
   extracts - CLAUDE.md §2.6) with the module state set per case. Pins:

   §1 NOTHING STORED = TODAY. No stored charts (not fetched, fetched empty) -> the
      resolver returns [] and the overlay hands back the default matrix BY IDENTITY.
   §2 THE WIDGET WINS. A chart read off the product page outranks any stored guide;
      the stored guide is used only when the widget sent none or re-checked to "".
   §3 WHICH STORED CHART - kids abstains, type follows isPantsProduct(), gender rules
      (never guess between a store's men's and women's charts), the >= 2 size-overlap
      guard, and the women's EU convention as the one vetted numeric alias.
   §4 ALIASES IN THE OVERLAY - "2XL" is XXL, a declared letter alias lands on the letter
      chart, an EU number lands only on the EU pants chart, a US/unlabelled number never
      lands anywhere, and an alias can never take a size from a row that owns it.
   §5 §2.5b STILL HOLDS THROUGH ALL OF IT - every height/weight bound identical after a
      stored, aliased chart is overlaid (size-chart-overlay.test.mjs §1, re-asserted on
      the new path).
   §6 PHASE 0 - fineTunePickForDiagnostics() agrees with the REAL marked tie-break loop
      on a grid of bodies, and logStoreChartComparison() reports disagreement, band
      deltas and the idle tie-break, once per distinct outcome.
   §7 loadStoredSizeCharts() - one GET per host, and every failure lands on [].
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function extract(src, start, end) {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`could not find "${start}"`);
  const b = src.indexOf(end, a);
  if (b === -1) throw new Error(`could not find "${end}"`);
  return src.slice(a, b);
}

const SIZING = extract(APP, "const ZARA_SIZE_CHART", "\nfunction onMeasurementKeydown");
const STATE = ["activeItem", "pendingSizes", "pendingAgeGroup", "pendingTitle", "pendingSizeRunType",
  "pendingSizeChart", "pendingGarmentGender", "storedSizeCharts", "storedSizeChartsHost",
  "currentUserSize", "currentSizeCategory", "currentBodyCategory", "currentUserGender", "pendingSoldOutSizes",
  "pendingSoldOutForImg"];
const prefix = `let ${STATE.join(", ")};\nactiveItem = null; currentUserGender = null;\n`;
const setter = `function __set(o) {\n${STATE.map((k) => `  if ("${k}" in o) ${k} = o.${k};`).join("\n")}\n}\n` +
  "function __get(k) { return ({ storedSizeCharts, storedSizeChartsHost })[k]; }\n";
const EXPORTS = ["__set", "__get", "resolvedStoreSizeChart", "pickStoredSizeChart", "applyStoreChartOverlay",
  "canonicalSizeToken", "storeChartTokenMap", "fineTunePickForDiagnostics", "logStoreChartComparison",
  "loadStoredSizeCharts", "coreHwPenalty", "resolvedStoreSizeChartSource",
  "ZARA_SIZE_CHART", "ADULT_PANTS_SIZE_CHART"];
const room = await import("data:text/javascript," + encodeURIComponent(
  prefix + SIZING + "\n" + setter + `export { ${EXPORTS.join(", ")} };`));
const { __set, resolvedStoreSizeChart, pickStoredSizeChart, applyStoreChartOverlay, canonicalSizeToken,
  fineTunePickForDiagnostics, logStoreChartComparison, coreHwPenalty, ZARA_SIZE_CHART, ADULT_PANTS_SIZE_CHART } = room;

const RESET = {
  activeItem: null, pendingSizes: undefined, pendingAgeGroup: undefined, pendingTitle: undefined,
  pendingSizeRunType: undefined, pendingSizeChart: undefined, pendingGarmentGender: undefined,
  storedSizeCharts: undefined, storedSizeChartsHost: undefined,
};
const set = (o) => __set({ ...RESET, ...o });

/* Store charts in the shape GET /api/store-size-chart serves (lib/store-size-charts.js). */
const chart = (gender, type, rows, extra = {}) => ({ gender, age_group: "adult", garment_type: type, source: "linked_page", rows, ...extra });
const MEN_TOPS = chart("men", "tops", [
  { size: "S", minChest: 92, maxChest: 98 }, { size: "M", minChest: 99, maxChest: 104 }, { size: "L", minChest: 105, maxChest: 110 }]);
const WOMEN_TOPS_EU = chart("women", "tops", [
  { size: "36", minChest: 82, maxChest: 85 }, { size: "38", minChest: 86, maxChest: 89 }, { size: "40", minChest: 90, maxChest: 93 }]);
const JEANS = chart("men", "jeans", [
  { size: "30", minWaist: 75, maxWaist: 78 }, { size: "32", minWaist: 80, maxWaist: 84 }, { size: "34", minWaist: 85, maxWaist: 89 }]);
const BOTTOMS = chart("unknown", "bottoms", [
  { size: "S", minWaist: 70, maxWaist: 75 }, { size: "M", minWaist: 76, maxWaist: 81 }]);
const KERNEL = ["minHeight", "maxHeight", "minWeight", "maxWeight"];
const kernelOf = (c) => JSON.stringify(c.map((r) => KERNEL.map((k) => r[k])));

console.log("\n── §1 nothing stored = today's behaviour ──");
{
  set({});
  check("§1.1 no fetch yet -> resolver [] ", resolvedStoreSizeChart().length === 0);
  check("§1.2 ...and the overlay returns the default matrix BY IDENTITY",
    applyStoreChartOverlay(ZARA_SIZE_CHART, resolvedStoreSizeChart()) === ZARA_SIZE_CHART);
  set({ storedSizeCharts: [] });
  check("§1.3 fetched, store has nothing -> [] and identity",
    resolvedStoreSizeChart().length === 0 && applyStoreChartOverlay(ZARA_SIZE_CHART, resolvedStoreSizeChart()) === ZARA_SIZE_CHART);
  set({ storedSizeCharts: [chart("men", "tops", "not-an-array")] });
  check("§1.4 a malformed stored chart is skipped, not thrown", resolvedStoreSizeChart().length === 0);
}

console.log("\n── §2 the widget's chart wins ──");
{
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizeChart: "cm;shopify;S:90-95:::|M:96-101:::" });
  check("§2.1 widget chart present -> it is used, the stored one is not",
    resolvedStoreSizeChart().find((r) => r.size === "M").minChest === 96, JSON.stringify(resolvedStoreSizeChart()));
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizeChart: "" });
  check("§2.2 widget re-checked and sent '' -> the stored guide is the fallback",
    resolvedStoreSizeChart().find((r) => r.size === "M")?.minChest === 99, JSON.stringify(resolvedStoreSizeChart()));
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men" });
  check("§2.3 widget never sent a chart -> stored guide", resolvedStoreSizeChart().length === 3);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", activeItem: { sizeChart: "cm;x;S:90-95:::|M:96-101:::" } });
  check("§2.4 the active item's widget chart outranks both",
    resolvedStoreSizeChart().find((r) => r.size === "M").minChest === 96);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizeChart: "" });
  check("§2.5 the Phase 0 source label names the stored chart",
    /stored men\/adult\/tops/.test(room.resolvedStoreSizeChartSource()), room.resolvedStoreSizeChartSource());
}

console.log("\n── §3 which stored chart ──");
{
  set({ storedSizeCharts: [MEN_TOPS], pendingSizes: "8,10,12,14" });
  check("§3.1 a kids product takes no stored chart", resolvedStoreSizeChart().length === 0,
    pickStoredSizeChart().reason);

  set({ storedSizeCharts: [MEN_TOPS, WOMEN_TOPS_EU] });
  check("§3.2 garment gender unknown + store has men's AND women's charts -> none (never guessed)",
    resolvedStoreSizeChart().length === 0 && /not guessing/.test(pickStoredSizeChart().reason), pickStoredSizeChart().reason);
  set({ storedSizeCharts: [MEN_TOPS, WOMEN_TOPS_EU], pendingGarmentGender: "men" });
  check("§3.3 men's garment -> the men's chart", pickStoredSizeChart().chart === MEN_TOPS);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "women" });
  check("§3.4 women's garment, only a men's chart -> none", resolvedStoreSizeChart().length === 0, pickStoredSizeChart().reason);
  const unisex = chart("unisex", "tops", MEN_TOPS.rows);
  set({ storedSizeCharts: [MEN_TOPS, unisex], pendingGarmentGender: "women" });
  check("§3.5 ...but a unisex chart serves any garment", pickStoredSizeChart().chart === unisex);
  const unlabelled = chart("unknown", "tops", MEN_TOPS.rows);
  set({ storedSizeCharts: [unlabelled] });
  check("§3.6 an unlabelled chart is used when the store has no gendered one", pickStoredSizeChart().chart === unlabelled);
  set({ storedSizeCharts: [unlabelled, WOMEN_TOPS_EU] });
  check("§3.7 ...but NOT when the store also publishes gendered charts of that type",
    pickStoredSizeChart().chart === null, pickStoredSizeChart().reason);

  set({ storedSizeCharts: [MEN_TOPS, JEANS, BOTTOMS], pendingGarmentGender: "men", pendingTitle: "Slim Fit Jeans", pendingSizes: "30,32,34" });
  check("§3.8 a jeans product picks the jeans chart", pickStoredSizeChart().chart === JEANS, pickStoredSizeChart().reason);
  set({ storedSizeCharts: [MEN_TOPS, JEANS, BOTTOMS], pendingTitle: "Cargo Pants", pendingSizes: "S,M,L" });
  check("§3.9 trousers pick the bottoms chart first", pickStoredSizeChart().chart === BOTTOMS, pickStoredSizeChart().reason);
  set({ storedSizeCharts: [JEANS, BOTTOMS], pendingGarmentGender: "men", pendingTitle: "Basic Tee", pendingSizes: "S,M,L" });
  check("§3.10 a top never takes a bottoms/jeans chart", pickStoredSizeChart().chart === null);

  const menEuOnly = chart("men", "tops", [
    { size: "46", minChest: 88, maxChest: 94 }, { size: "48", minChest: 95, maxChest: 101 }, { size: "50", minChest: 102, maxChest: 108 }]);
  set({ storedSizeCharts: [menEuOnly], pendingGarmentGender: "men", pendingSizes: "S,M,L" });
  check("§3.11 size overlap < 2 with the product's own list -> not its chart",
    pickStoredSizeChart().chart === null && /shares 0 size/.test(pickStoredSizeChart().reason), pickStoredSizeChart().reason);
  const menEuAliased = chart("men", "tops", menEuOnly.rows.map((r, i) => ({ ...r, aliases: { int: ["S", "M", "L"][i] } })));
  set({ storedSizeCharts: [menEuAliased], pendingGarmentGender: "men", pendingSizes: "S,M,L" });
  check("§3.12 ...the same chart with the store's own INT column overlaps via its aliases",
    pickStoredSizeChart().chart === menEuAliased);

  set({ storedSizeCharts: [WOMEN_TOPS_EU], pendingGarmentGender: "women", pendingSizes: "XS,S,M,L" });
  const women = pickStoredSizeChart();
  check("§3.13 women's EU 36/38/40 answer to S/M/L (WOMEN_TOPS_EU_SIZE_CHART, the one vetted convention)",
    women.chart === WOMEN_TOPS_EU && women.rows.map((r) => r.aliases?.int).join(",") === "S,M,L", JSON.stringify(women.rows));
  check("§3.14 ...and the stored chart itself was not mutated", !WOMEN_TOPS_EU.rows[0].aliases);
  const overlaid = applyStoreChartOverlay(ZARA_SIZE_CHART, women.rows);
  check("§3.15 ...so the women's bands land on our S/M/L rows",
    overlaid.find((r) => r.size === "M").minChest === 86, JSON.stringify(overlaid.find((r) => r.size === "M")));
  const menNumeric = chart("men", "tops", WOMEN_TOPS_EU.rows);
  set({ storedSizeCharts: [menNumeric], pendingGarmentGender: "men" });
  check("§3.16 the women's convention is NEVER applied to a men's chart",
    pickStoredSizeChart().rows.every((r) => !r.aliases || !r.aliases.int));
}

console.log("\n── §4 aliases in the overlay ──");
{
  check("§4.1 canonicalSizeToken: 2XL=XXL, 3XS=XXXS, ' m '=M, a number stays a number",
    canonicalSizeToken("2XL") === "XXL" && canonicalSizeToken("3xs") === "XXXS" && canonicalSizeToken(" m ") === "M" &&
    canonicalSizeToken("38") === "38" && canonicalSizeToken("XXL") === "XXL");
  const spelled = applyStoreChartOverlay(ZARA_SIZE_CHART, [{ size: "2XL", minChest: 118, maxChest: 124 }]);
  check("§4.2 a store's '2XL' row lands on our XXL (it used to be silently ignored)",
    spelled.find((r) => r.size === "XXL").minChest === 118, JSON.stringify(spelled.find((r) => r.size === "XXL")));
  const letterAlias = applyStoreChartOverlay(ZARA_SIZE_CHART, [{ size: "48", aliases: { int: "M" }, minChest: 99, maxChest: 104 }]);
  check("§4.3 a numeric row with a declared LETTER alias lands on the letter chart",
    letterAlias.find((r) => r.size === "M").minChest === 99);
  check("§4.4 a US / unlabelled NUMBER alias never lands on the letter chart",
    applyStoreChartOverlay(ZARA_SIZE_CHART, [{ size: "X1", aliases: { us: "38", alt: "40" }, minChest: 99, maxChest: 104 }]) === ZARA_SIZE_CHART);
  const euPants = applyStoreChartOverlay(ADULT_PANTS_SIZE_CHART, [{ size: "M", aliases: { eu: "40" }, minWaist: 73, maxWaist: 79 }]);
  check("§4.5 an EU number alias lands on the EU pants chart", euPants.find((r) => r.size === "40").minWaist === 73);
  check("§4.6 ...a US number alias does not",
    applyStoreChartOverlay(ADULT_PANTS_SIZE_CHART, [{ size: "M", aliases: { us: "40" }, minWaist: 73, maxWaist: 79 }]) === ADULT_PANTS_SIZE_CHART);
  check("§4.7 ...and a letter never lands on a numeric chart",
    applyStoreChartOverlay(ADULT_PANTS_SIZE_CHART, [{ size: "40X", aliases: { int: "M" }, minWaist: 73, maxWaist: 79 }]) === ADULT_PANTS_SIZE_CHART);
  const steal = applyStoreChartOverlay(ZARA_SIZE_CHART, [
    { size: "S", aliases: { alt: "M" }, minChest: 90, maxChest: 97 },
    { size: "M", minChest: 99, maxChest: 104 }]);
  check("§4.8 an 'S/M' row's alias can NOT take M from the real M row",
    steal.find((r) => r.size === "M").minChest === 99 && steal.find((r) => r.size === "S").minChest === 90);
  const fillIn = applyStoreChartOverlay(ZARA_SIZE_CHART, [{ size: "S", aliases: { alt: "M" }, minChest: 90, maxChest: 97 }]);
  check("§4.9 ...but it does serve M when no row owns M", fillIn.find((r) => r.size === "M").minChest === 90);
}

console.log("\n── §5 §2.5b holds on the new path ──");
{
  const before = kernelOf(ZARA_SIZE_CHART);
  set({ storedSizeCharts: [WOMEN_TOPS_EU], pendingGarmentGender: "women", pendingSizes: "S,M,L" });
  const hostile = pickStoredSizeChart().rows.map((r) => ({ ...r, minHeight: 100, maxHeight: 250, minWeight: 1, maxWeight: 500 }));
  const out = applyStoreChartOverlay(ZARA_SIZE_CHART, hostile);
  check("§5.1 a stored, aliased chart carrying height/weight changes neither", kernelOf(out) === before, kernelOf(out));
  check("§5.2 ...its chest bands still landed", out.find((r) => r.size === "S").minChest === 82);
  const pantsBefore = kernelOf(ADULT_PANTS_SIZE_CHART);
  check("§5.3 same on the pants chart via an EU alias",
    kernelOf(applyStoreChartOverlay(ADULT_PANTS_SIZE_CHART, [{ size: "M", aliases: { eu: "40" }, minWaist: 73, maxWaist: 79, minHeight: 1 }])) === pantsBefore);
  const fn = extract(APP, "function applyStoreChartOverlay(baseChart, storeRows) {", "\n/**");
  const helper = extract(APP, "function storeChartTokenMap(storeRows, numericBase) {", "\n}\n");
  check("§5.4 neither the overlay nor its token map names a height or weight field",
    !/(?:min|max)(?:Height|Weight)/.test(fn + helper));
}

console.log("\n── §6 Phase 0 comparison ──");
{
  const loopSrc = extract(APP, 'const candidates = currentSizeCategory === "child" ? childFits : adultFits;',
    "// SNAP TO THE PRODUCT'S OWN LIST.");
  const realLoop = new Function("currentSizeCategory", "useNumericPantsChart", "childFits", "adultFits",
    "chest", "waist", "legs", loopSrc + "\nreturn bestSize;");
  let agree = 0, total = 0, firstDiff = "";
  const store = applyStoreChartOverlay(ZARA_SIZE_CHART, MEN_TOPS.rows);
  for (const chart of [ZARA_SIZE_CHART, store, ADULT_PANTS_SIZE_CHART]) {
    const numeric = chart === ADULT_PANTS_SIZE_CHART;
    for (let h = 160; h <= 195; h += 5) for (let w = 55; w <= 100; w += 5) {
      const fits = chart.filter((r) => coreHwPenalty(r, h, w) === 0);
      if (!fits.length) continue;
      for (const m of [null, 80, 90, 97, 103, 115]) {
        total++;
        const a = realLoop("adult", numeric, [], fits, m, m && m - 14, null);
        const b = fineTunePickForDiagnostics(fits, numeric, m, m && m - 14, null);
        if (a === b) agree++; else if (!firstDiff) firstDiff = `${h}/${w}/${m}: loop ${a} vs mirror ${b}`;
      }
    }
  }
  check(`§6.1 the diagnostic mirror agrees with the REAL tie-break loop on all ${total} cases`,
    total > 100 && agree === total, firstDiff);

  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);
  const args = { source: "stored men/adult/tops chart", baseChart: ZARA_SIZE_CHART, overlaidChart: store,
    storeRows: MEN_TOPS.rows, height: 171, weight: 66, chest: 97, waist: null, legs: null, numericPants: false, recommended: "S" };
  const s1 = logStoreChartComparison(args);
  const s2 = logStoreChartComparison(args);
  const s3 = logStoreChartComparison({ ...args, chest: null });
  console.log = orig;
  check("§6.2 a 97cm chest at 171/66: default says M, the store's chart says S - disagreement reported",
    s1 && s1.defaultPick === "M" && s1.storePick === "S" && s1.disagree === true, JSON.stringify(s1));
  check("§6.3 band deltas are reported per size", s1 && /M chest \+3cm/.test(s1.bandDeltas), s1 && s1.bandDeltas);
  check("§6.4 unmatched store sizes are listed (none here)", s1 && s1.unmatchedStoreSizes === "(none)");
  check("§6.5 logged ONCE for a repeated identical outcome, again when it changes",
    logs.length === 2 && JSON.stringify(s1) === JSON.stringify(s2), `${logs.length} log line(s)`);
  check("§6.6 no optional measurement -> the tie-break is reported idle, no disagreement",
    s3 && /idle/.test(s3.tieBreak) && s3.disagree === false, JSON.stringify(s3));
  check("§6.7 [PEAR] prefix on the log line", logs[0] && /^\[PEAR\] store chart vs default:/.test(logs[0][0]));
  check("§6.8 no store rows -> nothing logged, nothing returned",
    logStoreChartComparison({ ...args, storeRows: [] }) === null);
  const unmatched = logStoreChartComparison({ ...args, storeRows: [...MEN_TOPS.rows, { size: "5XL", minChest: 140, maxChest: 150 }] });
  check("§6.9 a store size our chart lacks is surfaced, not silently dropped",
    unmatched && unmatched.unmatchedStoreSizes === "5XL", JSON.stringify(unmatched));

  const calc = extract(APP, "function calculateSize() {", "\nfunction setGender(");
  check("§6.10 calculateSize() calls the comparison AFTER the recommendation is final",
    calc.indexOf("logStoreChartComparison(") > calc.indexOf("// SNAP TO THE PRODUCT'S OWN LIST.") &&
    calc.indexOf("logStoreChartComparison(") < calc.indexOf("sizeResult.innerText = formatSizeLabel(bestSize);"));
}

console.log("\n── §7 loadStoredSizeCharts ──");
{
  const calls = [];
  const quiet = console.log;
  console.log = () => {};
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ host: "fox.co.il", charts: [MEN_TOPS] }) };
  };
  set({});
  room.loadStoredSizeCharts("https://www.fox.co.il/");
  room.loadStoredSizeCharts("fox.co.il");
  await new Promise((r) => setTimeout(r, 10));
  check("§7.1 one GET per host, on the canonical host", calls.length === 1 && calls[0] === "/api/store-size-chart?host=fox.co.il", calls.join(","));
  check("§7.2 the charts land in module state", room.__get("storedSizeCharts")?.length === 1);

  globalThis.fetch = async () => { throw new Error("offline"); };
  set({});
  room.loadStoredSizeCharts("castro.com");
  await new Promise((r) => setTimeout(r, 10));
  check("§7.3 a network failure lands on []", Array.isArray(room.__get("storedSizeCharts")) && room.__get("storedSizeCharts").length === 0);

  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  set({});
  room.loadStoredSizeCharts("terminalx.com");
  await new Promise((r) => setTimeout(r, 10));
  check("§7.4 an older server without the route (404) lands on []", room.__get("storedSizeCharts")?.length === 0);

  calls.length = 0;
  globalThis.fetch = async (u) => { calls.push(u); return { ok: true, json: async () => ({ charts: [] }) }; };
  set({});
  room.loadStoredSizeCharts("localhost");
  room.loadStoredSizeCharts("");
  await new Promise((r) => setTimeout(r, 10));
  check("§7.5 no usable host -> no request at all", calls.length === 0);
  console.log = quiet;
  delete globalThis.fetch;
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("stored-size-chart: all checks passed.");
