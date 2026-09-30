/* THE ROOM'S STORED-CHART FALLBACK, EU/US ALIASES AND THE PHASE 0 COMPARISON
   ─────────────────────────────────────────────────────────────────────────────
   Main (bd766b2) ran this in the browser. With the code hiding (CLAUDE.md §2.12) the
   pick, the aliases, the overlay and the comparison are lib/sizing.js's, and the browser
   only fetches the store's charts and forwards them. So every case below runs the WHOLE
   path: the real browser sizing slice of fitting-room/app.js (the same span every sizing
   suite extracts - CLAUDE.md §2.6) with the module state set per case builds the
   evidence exactly as calculateSize() does; it goes through JSON and
   sanitizeSizeEvidence(); the real lib/sizing.js answers. Main's own checks, unchanged
   in what they assert. Pins:

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
   §8 THE WIRE - a chart as GET /api/store-size-chart serves it survives the sanitiser
      unchanged; the Phase 0 summary reaches the support view only.
   ============================================================================= */
import { readFileSync } from "node:fs";
import * as SIZING from "../lib/sizing.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LIB = readFileSync(new URL("../lib/sizing.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

/* The browser half: the Screen 1 sizing slice (CLAUDE.md §2.6), run with its module state
   exposed. __evidence() is calculateSize()'s evidence block - §0 asserts it is, line for line. */
const BROWSER = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");
const STATE = ["activeItem", "pendingSizes", "pendingAgeGroup", "pendingTitle", "pendingSizeRunType",
  "pendingSizeChart", "pendingGarmentGender", "storedSizeCharts", "storedSizeChartsHost",
  "currentUserSize", "currentSizeCategory", "currentBodyCategory", "currentUserGender", "pendingSoldOutSizes",
  "pendingSoldOutForImg", "currentGarmentCategory"];
/* currentGarmentCategory is declared inside the slice itself; the rest are the room's module state. */
const prefix = `let ${STATE.filter((k) => k !== "currentGarmentCategory").join(", ")};\nactiveItem = null; currentUserGender = null;\n`;
const setter = `function __set(o) {\n${STATE.map((k) => `  if ("${k}" in o) ${k} = o.${k};`).join("\n")}\n}\n` +
  "function __get(k) { return ({ storedSizeCharts, storedSizeChartsHost })[k]; }\n" +
  `function __evidence(extra) {
  const product = sizeProductEvidence();
  const evidence = {
    height: null, weight: null, chest: null, waist: null, legs: null,
    gender: currentUserGender || null,
    storeChart: resolvedStoreSizeChart(),
    product,
  };
  const storedCharts = typeof storedSizeChartsEvidence === "function" ? storedSizeChartsEvidence() : null;
  if (storedCharts) {
    evidence.storedCharts = storedCharts;
    evidence.garmentGender = resolvedGarmentGender();
  }
  return Object.assign(evidence, extra || {});
}
`;
const EXPORTS = ["__set", "__get", "__evidence", "loadStoredSizeCharts", "logStoreChartDiag"];
const room = await import("data:text/javascript," + encodeURIComponent(
  prefix + BROWSER + "\n" + setter + `export { ${EXPORTS.join(", ")} };`));
const { __set } = room;
const { applyStoreChartOverlay, canonicalSizeToken, fineTunePickForDiagnostics, coreHwPenalty,
  ZARA_SIZE_CHART, ADULT_PANTS_SIZE_CHART } = SIZING;
/* The evidence as the server receives it - through JSON and the sanitiser, like the wire. */
const wire = (extra) => SIZING.sanitizeSizeEvidence(JSON.parse(JSON.stringify(room.__evidence(extra))));
const resolvedStoreSizeChart = () => SIZING.resolvedStoreSizeChart(wire());
const pickStoredSizeChart = () => SIZING.pickStoredSizeChart(wire());
const resolvedStoreSizeChartSource = () => SIZING.storeSizeChartSource(wire());
/* Main compared the picked chart by identity; after the wire it is a copy, so by value. */
const same = (a, b) => !!a && !!b && a.gender === b.gender && a.garment_type === b.garment_type &&
  JSON.stringify(a.rows.map((r) => ({ ...r }))) === JSON.stringify(b.rows.map((r) => ({ ...r })));

console.log("\n── §0 calculateSize() builds the evidence the harness builds ──");
{
  const calc = extract(APP, "function calculateSize() {", "\nfunction applySizeVerdict(");
  check("§0.1 the widget chart rides as storeChart, raw", /storeChart: resolvedStoreSizeChart\(\),/.test(calc));
  check("§0.2 stored charts + the garment's gender ride ONLY when some landed",
    /const storedCharts = typeof storedSizeChartsEvidence === "function" \? storedSizeChartsEvidence\(\) : null;\s*if \(storedCharts\) \{\s*evidence\.storedCharts = storedCharts;\s*evidence\.garmentGender = resolvedGarmentGender\(\);\s*\}/.test(calc));
  __set({ activeItem: null, storedSizeCharts: undefined });
  check("§0.3 no stored charts -> the evidence carries neither field (what it always sent)",
    !("storedCharts" in room.__evidence()) && !("garmentGender" in room.__evidence()));
}

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
    /stored men\/adult\/tops/.test(resolvedStoreSizeChartSource()), resolvedStoreSizeChartSource());
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
  check("§3.3 men's garment -> the men's chart", same(pickStoredSizeChart().chart, MEN_TOPS));
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "women" });
  check("§3.4 women's garment, only a men's chart -> none", resolvedStoreSizeChart().length === 0, pickStoredSizeChart().reason);
  const unisex = chart("unisex", "tops", MEN_TOPS.rows);
  set({ storedSizeCharts: [MEN_TOPS, unisex], pendingGarmentGender: "women" });
  check("§3.5 ...but a unisex chart serves any garment", same(pickStoredSizeChart().chart, unisex));
  const unlabelled = chart("unknown", "tops", MEN_TOPS.rows);
  set({ storedSizeCharts: [unlabelled] });
  check("§3.6 an unlabelled chart is used when the store has no gendered one", same(pickStoredSizeChart().chart, unlabelled));
  set({ storedSizeCharts: [unlabelled, WOMEN_TOPS_EU] });
  check("§3.7 ...but NOT when the store also publishes gendered charts of that type",
    pickStoredSizeChart().chart === null, pickStoredSizeChart().reason);

  set({ storedSizeCharts: [MEN_TOPS, JEANS, BOTTOMS], pendingGarmentGender: "men", pendingTitle: "Slim Fit Jeans", pendingSizes: "30,32,34" });
  check("§3.8 a jeans product picks the jeans chart", same(pickStoredSizeChart().chart, JEANS), pickStoredSizeChart().reason);
  set({ storedSizeCharts: [MEN_TOPS, JEANS, BOTTOMS], pendingTitle: "Cargo Pants", pendingSizes: "S,M,L" });
  check("§3.9 trousers pick the bottoms chart first", same(pickStoredSizeChart().chart, BOTTOMS), pickStoredSizeChart().reason);
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
    same(pickStoredSizeChart().chart, menEuAliased));

  set({ storedSizeCharts: [WOMEN_TOPS_EU], pendingGarmentGender: "women", pendingSizes: "XS,S,M,L" });
  const women = pickStoredSizeChart();
  check("§3.13 women's EU 36/38/40 answer to S/M/L (WOMEN_TOPS_EU_SIZE_CHART, the one vetted convention)",
    same(women.chart, WOMEN_TOPS_EU) && women.rows.map((r) => r.aliases?.int).join(",") === "S,M,L", JSON.stringify(women.rows));
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
  const fn = extract(LIB, "function applyStoreChartOverlay(baseChart, storeRows) {", "\n/*");
  const helper = extract(LIB, "function storeChartTokenMap(storeRows, numericBase) {", "\n}\n");
  check("§5.4 neither the overlay nor its token map names a height or weight field",
    !/(?:min|max)(?:Height|Weight)/.test(fn + helper));
}

console.log("\n── §6 Phase 0 comparison ──");
{
  const loopSrc = extract(LIB, 'const candidates = currentSizeCategory === "child" ? childFits : adultFits;',
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

  /* Main's logStoreChartComparison() = the server's summary + the browser's once-per-outcome log. */
  const logStoreChartComparison = (args) => {
    const summary = SIZING.storeChartComparison(args);
    room.logStoreChartDiag(summary);
    return summary;
  };
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

  const fit = extract(LIB, "export function computeSizeVerdict(ev", "\n/* ══ THE WIRE");
  const paint = extract(APP, "function applySizeVerdict(verdict) {", "\nfunction ");
  check("§6.10 the comparison runs AFTER the recommendation is final, and is logged before it is painted",
    fit.indexOf("storeChartComparison(") > fit.indexOf("// SNAP TO THE PRODUCT'S OWN LIST.") &&
    fit.indexOf("storeChartComparison(") < fit.lastIndexOf('return { status: "ok"') &&
    paint.indexOf("logStoreChartDiag(verdict.storeChartDiag)") > 0 &&
    paint.indexOf("logStoreChartDiag(verdict.storeChartDiag)") < paint.indexOf("sizeResult.innerText = formatSizeLabel(bestSize);"));
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

console.log("\n── §8 the wire ──");
{
  /* A chart exactly as lib/store-size-charts.js's toRoomChart() serves it. */
  const served = { gender: "women", age_group: "adult", garment_type: "tops", size_system: "eu", source: "linked_page",
    confidence: 0.9, updated_at: "2026-09-27T00:00:00Z",
    rows: [{ size: "36", minChest: 82, maxChest: 85, aliases: { int: "S", us: "4" } }, { size: "38", minChest: 86, maxChest: 89 }] };
  __set({ activeItem: null, storedSizeCharts: [served, { ...served, age_group: "kids" }], pendingGarmentGender: "women" });
  const ev = wire();
  check("§8.1 only the adult charts travel (the pick never reads another)", ev.storedCharts.length === 1);
  check("§8.2 every field the pick and the overlay read survives the sanitiser unchanged",
    JSON.stringify(ev.storedCharts[0]) === JSON.stringify({ gender: "women", age_group: "adult", garment_type: "tops",
      source: "linked_page", rows: served.rows.map((r) => ({ size: r.size, minChest: r.minChest, maxChest: r.maxChest,
        ...(r.aliases ? { aliases: r.aliases } : {}) })) }), JSON.stringify(ev.storedCharts[0]));
  check("§8.3 the garment gender rides with them", ev.garmentGender === "women");
  const junk = SIZING.sanitizeStoredCharts(Array.from({ length: 90 }, () => ({ rows: Array.from({ length: 500 }, () => ({ size: "x".repeat(99), minChest: "9", aliases: { "EVIL KEY": "M", eu: { x: 1 } } })) })));
  check("§8.4 a forged body is bounded: 50 charts, 60 rows, strings capped, non-numbers and odd keys dropped",
    junk.length === 50 && junk[0].rows.length === 60 && junk[0].rows[0].size.length === 16 &&
    !("minChest" in junk[0].rows[0]) && JSON.stringify(junk[0].rows[0].aliases) === "{}");
  const body = { height: 171, weight: 66, chest: 97, waist: null, legs: null, gender: "men", storeChart: "",
    product: { sizes: ["S", "M", "L"], ageGroup: "adult", title: "Tee" }, storedCharts: [MEN_TOPS], garmentGender: "men" };
  const shopper = SIZING.computeSizeVerdict(SIZING.sanitizeSizeEvidence(body));
  const support = SIZING.computeSizeVerdict(SIZING.sanitizeSizeEvidence(body), { diag: true });
  check("§8.5 the stored chart moves the tie-break end to end (97cm chest at 171/66: S, not M)", shopper.size === "S", shopper.size);
  check("§8.6 a shopper's verdict carries no comparison (its band deltas describe our chart)", !("storeChartDiag" in shopper));
  check("§8.7 the support view's does - main's summary, the recommendation included",
    support.storeChartDiag && support.storeChartDiag.recommended === "S" && support.storeChartDiag.defaultPick === "M" &&
    /stored men\/adult\/tops/.test(support.storeChartDiag.source), JSON.stringify(support.storeChartDiag));
  const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const WORKER = readFileSync(new URL("../cloudflare/orient/src/worker.js", import.meta.url), "utf8");
  check("§8.8 both answering ends gate it on the support token",
    /computeSizeVerdict\(sanitizeSizeEvidence\(req\.body\), \{ diag: isDebugToken\(req\.body && req\.body\.dk\) \}\)/.test(SERVER) &&
    /computeSizeVerdict\(sanitizeSizeEvidence\(body\), \{ diag: keyMatches\(body && body\.dk, env\.PEAR_DEBUG_TOKEN\) \}\)/.test(WORKER));
  check("§8.9 ...and the browser sends the key only from a debug build",
    /\(typeof PEAR_DEBUG_BUILD === "undefined" \|\| PEAR_DEBUG_BUILD\) && typeof location !== "undefined"\) \{\s*try \{\s*const dk = new URLSearchParams\(location\.search\)\.get\("pear_debug"\);/.test(APP));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("stored-size-chart: all checks passed.");
