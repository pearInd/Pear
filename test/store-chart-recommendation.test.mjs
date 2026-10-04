/* THE STORE'S CHART DECIDES THE SIZE - CLAUDE.md §2.5b as changed 2026-10-03
   ─────────────────────────────────────────────────────────────────────────────
   The owner's decision: when a CONFIDENT store chart exists for the garment (store,
   gender, kids/adult, garment type, >= 2 sizes shared with the product), it decides the
   recommended size - not only the tie-break. Everything else stays: the kids/adult
   guard, genuine-fit-or-no-match, the blocked Continue.

   §1 THE BODY ESTIMATE. estimateBodyMeasurements(): the documented sqrt(weight/height)
      model, its error ranges, typed measurements overriding it, and unknown gender
      being honestly LESS certain.
   §2 IT DECIDES. A body our kernel calls L is an M on the store's own chart - the
      chart's answer wins, and a typed chest moves it.
   §3 EVERY FALLBACK returns null (= today's logic): no chart, garment gender unknown
      with men's+women's charts, kids product, unknown size list, a body on a band
      edge, an unknown-gender shopper the estimate cannot place, a chart with no
      comparable column, a letter answer on a numeric-pants route.
   §4 ALL CHARTS KEPT (Part 2, room side). With an alpha AND a numeric chart for one
      audience/type (castro's women's tops), the one that shares sizes with THIS
      product is picked.
   §5 THE REAL calculateSize(), end to end with a stubbed DOM: the decision lands in
      currentUserSize and the result box, and the guard state (currentSizeCategory,
      currentBodyCategory, the no-match path, Continue) is exactly what it was.

   ON THE HIDDEN BUILD the fit is server-side (lib/sizing.js, CLAUDE.md §2.12): the decision
   runs inside computeSizeVerdict(), the pick reads the size EVIDENCE the room sends. So the
   harness runs the room's real sizing slice for the state and the evidence, and the real
   module behind a JSON round trip and the sanitiser for every verdict - the checks are
   main's, unchanged, except that a picked chart is compared by value (after the wire it is
   a copy) and §5 awaits calculateSize() (it waits on the server).
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

const SIZING = await import("../lib/sizing.js");
const LIB = readFileSync(new URL("../lib/sizing.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* The room's sizing slice (CLAUDE.md §2.6 interface) with its module state exposed, and the fit behind
   requestSizeVerdict() - defined just outside the slice so a harness injects it: here the REAL module,
   through JSON and the sanitiser, as the wire does. */
const SLICE = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");
const STATE = ["activeItem", "pendingSizes", "pendingAgeGroup", "pendingTitle", "pendingSizeRunType",
  "pendingSizeChart", "pendingGarmentGender", "storedSizeCharts", "storedSizeChartsHost",
  "currentUserSize", "currentSizeCategory", "currentBodyCategory", "currentUserGender", "pendingSoldOutSizes",
  "pendingSoldOutForImg", "__els"];
const prefix = `let ${STATE.join(", ")};\nactiveItem = null; currentUserGender = null; __els = {};\n` +
  `const $ = (id) => __els[id] || null;\nconst t = (k) => k;\nconst tf = (k) => k;\n` +
  `const console = { log() {}, warn() {}, error() {} };\nconst localStream = {};\n` +
  `const requestSizeVerdict = (evidence) => Promise.resolve(globalThis.__pearSizeLib.computeSizeVerdict(` +
  `globalThis.__pearSizeLib.sanitizeSizeEvidence(JSON.parse(JSON.stringify(evidence)))));\n`;
globalThis.__pearSizeLib = SIZING;
const setter = `function __set(o) {\n${STATE.map((k) => `  if ("${k}" in o) ${k} = o.${k};`).join("\n")}\n}\n` +
  "function __get() { return { currentUserSize, currentSizeCategory, currentBodyCategory }; }\n" +
  /* calculateSize()'s own evidence block (stored-size-chart §0 pins it line for line). */
  `function __evidence() {
  const evidence = { height: null, weight: null, chest: null, waist: null, legs: null,
    gender: currentUserGender || null, storeChart: resolvedStoreSizeChart(), product: sizeProductEvidence() };
  const storedCharts = typeof storedSizeChartsEvidence === "function" ? storedSizeChartsEvidence() : null;
  if (storedCharts) { evidence.storedCharts = storedCharts; evidence.garmentGender = resolvedGarmentGender(); }
  return evidence;
}
`;
const room = await import("data:text/javascript," + encodeURIComponent(
  prefix + SLICE + "\n" + setter + "export { __set, __get, __evidence, calculateSize };"));
const { __set, __get, calculateSize } = room;
const { estimateBodyMeasurements, ZARA_SIZE_CHART, coreHwPenalty } = SIZING;
/* The evidence as the server receives it. */
const wire = () => SIZING.sanitizeSizeEvidence(JSON.parse(JSON.stringify(room.__evidence())));
const pickStoredSizeChart = () => SIZING.pickStoredSizeChart(wire());
const storeChartRecommendation = (args) => SIZING.storeChartRecommendation({ ev: wire(), ...args });
/* A picked chart after the wire is a copy - compared by value. */
const same = (a, b) => !!a && !!b && a.gender === b.gender && a.garment_type === b.garment_type &&
  (a.size_system || null) === (b.size_system || null) &&
  JSON.stringify(a.rows.map((r) => ({ ...r }))) === JSON.stringify(b.rows.map((r) => ({ ...r })));

const RESET = {
  activeItem: null, pendingSizes: undefined, pendingAgeGroup: undefined, pendingTitle: undefined,
  pendingSizeRunType: undefined, pendingSizeChart: undefined, pendingGarmentGender: undefined,
  storedSizeCharts: undefined, storedSizeChartsHost: undefined, currentUserGender: null,
};
const set = (o) => __set({ ...RESET, ...o });

const chart = (gender, type, rows, extra = {}) =>
  ({ gender, age_group: "adult", garment_type: type, size_system: "alpha", source: "linked_page", rows, ...extra });
const MEN_TOPS = chart("men", "tops", [
  { size: "S", minChest: 92, maxChest: 98 }, { size: "M", minChest: 99, maxChest: 104 },
  { size: "L", minChest: 105, maxChest: 110 }, { size: "XL", minChest: 111, maxChest: 116 }]);
const WOMEN_TOPS = chart("women", "tops", [
  { size: "XS", minChest: 78, maxChest: 82 }, { size: "S", minChest: 83, maxChest: 87 },
  { size: "M", minChest: 88, maxChest: 92 }, { size: "L", minChest: 93, maxChest: 97 }]);
const decide = (body, extra = {}) => storeChartRecommendation({
  chest: null, waist: null, legs: null, garmentSizes: ["S", "M", "L", "XL"], baseChart: ZARA_SIZE_CHART,
  numericOnly: false, userGender: null, ...body, ...extra });

console.log("\n── §1 the body estimate ──");
{
  const man = estimateBodyMeasurements(180, 80, "men");
  check("§1.1 180cm/80kg man: chest 103.3 ±4, waist 89.3 ±6 (the documented plausibility point)",
    man.chest.mean === 103.3 && man.chest.sd === 4 && man.waist.mean === 89.3 && man.waist.sd === 6, JSON.stringify(man));
  const woman = estimateBodyMeasurements(165, 60, "women");
  check("§1.2 165cm/60kg woman: bust 88 ±5, waist 73 ±6, hips 95.9 ±4.5 (EU 38 / M)",
    woman.chest.mean === 88 && woman.waist.mean === 73 && woman.hips.mean === 95.9 && woman.hips.sd === 4.5, JSON.stringify(woman));
  const unknown = estimateBodyMeasurements(180, 80, null);
  check("§1.3 gender unknown: between the two models, and LESS certain than either",
    unknown.chest.mean > woman.chest.mean && unknown.chest.mean < man.chest.mean &&
    unknown.chest.sd > 5 && unknown.gender === "unknown", JSON.stringify(unknown.chest));
  const typed = estimateBodyMeasurements(180, 80, "men", { chest: 97, waist: null, legs: 104 });
  check("§1.4 a typed chest replaces the estimate (±1.5 tape error); untyped waist stays estimated",
    typed.chest.mean === 97 && typed.chest.sd === 1.5 && typed.chest.typed && !typed.waist.typed, JSON.stringify(typed));
  check("§1.5 a typed outseam is carried (legs is never estimated)", typed.legs && typed.legs.mean === 104 &&
    estimateBodyMeasurements(180, 80, "men").legs === undefined);
  check("§1.6 the estimate grows with weight at a fixed height (monotonic)",
    estimateBodyMeasurements(180, 70, "men").chest.mean < man.chest.mean &&
    man.chest.mean < estimateBodyMeasurements(180, 95, "men").chest.mean);
}

console.log("\n── §2 a confident store chart decides ──");
{
  /* 180/80 is only an L on OUR kernel (M stops at 76kg) - so an M here is the store's
     chart deciding, not a tie-break between kernel candidates. */
  const kernel = ZARA_SIZE_CHART.filter((r) => coreHwPenalty(r, 180, 80) === 0).map((r) => r.size).join("/");
  check("§2.0 precondition: our kernel admits only L for 180/80", kernel === "L", kernel);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL" });
  const d = decide({ height: 180, weight: 80, userGender: "men" });
  check("§2.1 the store's men's chart puts chest 103.3±4 in M (99-104)", d && d.size === "M", JSON.stringify(d && d.size));
  check("§2.2 ...with a real margin (score >= 0.4, beats the runner-up by >= 0.1)",
    d && d.score >= 0.4 && d.score - d.runnerUp >= 0.1, d && `${d.score} vs ${d.runnerUp}`);
  const typed = decide({ height: 180, weight: 80, userGender: "men", chest: 107 });
  check("§2.3 a TYPED 107cm chest decides L", typed && typed.size === "L", JSON.stringify(typed && typed.size));
  const typedSmall = decide({ height: 180, weight: 80, userGender: "men", chest: 95 });
  check("§2.4 ...and a typed 95cm chest decides S - a size our kernel never admitted for this body",
    typedSmall && typedSmall.size === "S", JSON.stringify(typedSmall && typedSmall.size));
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,2XL,L" });
  const spelled = decide({ height: 196, weight: 120, userGender: "men", chest: 118 }, { garmentSizes: ["S", "M", "L", "2XL"] });
  check("§2.5 a size outside the chart (2XL, no store row) is never invented", spelled === null || spelled.size !== "2XL",
    JSON.stringify(spelled && spelled.size));
  set({ storedSizeCharts: [WOMEN_TOPS], pendingGarmentGender: "women", pendingSizes: "XS,S,M,L" });
  const w = decide({ height: 165, weight: 62.7, userGender: "women" }, { garmentSizes: ["XS", "S", "M", "L"] });
  check("§2.6 women's chart: a 165/62.7 woman (bust 90±5, mid-M) is an M", w && w.size === "M", JSON.stringify(w && [w.size, w.score, w.runnerUp]));
  check("§2.7 ...while a 165/60 woman (bust 88±5, ON the S|M edge) abstains - an honest coin flip",
    decide({ height: 165, weight: 60, userGender: "women" }, { garmentSizes: ["XS", "S", "M", "L"] }) === null);
}

console.log("\n── §3 every fallback keeps today's logic ──");
{
  set({ storedSizeCharts: [], pendingGarmentGender: "men", pendingSizes: "S,M,L" });
  check("§3.1 no stored chart -> null", decide({ height: 180, weight: 80, userGender: "men" }) === null);
  set({ storedSizeCharts: [MEN_TOPS, WOMEN_TOPS], pendingSizes: "S,M,L" });
  check("§3.2 garment gender unknown + store has men's AND women's charts -> null (never guessed)",
    decide({ height: 180, weight: 80, userGender: "men" }) === null, pickStoredSizeChart().reason);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "8,10,12" });
  check("§3.3 kids product -> null", decide({ height: 150, weight: 40 }, { garmentSizes: ["8", "10", "12"] }) === null);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: undefined });
  check("§3.4 product size list unknown -> null (the >= 2 overlap cannot be checked)",
    decide({ height: 180, weight: 80, userGender: "men" }, { garmentSizes: [] }) === null);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL" });
  /* chest estimate 98.5 = exactly the S|M boundary: 0.46 vs 0.43 - a coin flip. */
  check("§3.5 a body on a band edge (S/M coin flip) -> null", decide({ height: 175, weight: 70.7, userGender: "men" }) === null);
  check("§3.6 the SAME 180/80 body that decides M for a man abstains when the shopper's gender is unknown",
    decide({ height: 180, weight: 80, userGender: null }) === null);
  const hipsOnly = chart("men", "tops", [{ size: "S", minHips: 90, maxHips: 95 }, { size: "M", minHips: 96, maxHips: 101 }]);
  set({ storedSizeCharts: [hipsOnly], pendingGarmentGender: "men", pendingSizes: "S,M" });
  check("§3.7 a tops chart with no chest column has nothing primary to decide on -> null",
    decide({ height: 180, weight: 80, userGender: "men" }, { garmentSizes: ["S", "M"] }) === null);
  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL" });
  check("§3.8 a letter answer on a numeric-pants route -> null (formatSizeLabel would strip it)",
    decide({ height: 180, weight: 80, userGender: "men" }, { numericOnly: true }) === null);
  const euOnly = chart("men", "tops", [{ size: "46", minChest: 88, maxChest: 94 }, { size: "48", minChest: 95, maxChest: 101 }]);
  set({ storedSizeCharts: [euOnly], pendingGarmentGender: "men", pendingSizes: "S,M,L" });
  check("§3.9 a chart sharing < 2 sizes with the product -> null",
    decide({ height: 180, weight: 80, userGender: "men" }, { garmentSizes: ["S", "M", "L"] }) === null);
}

console.log("\n── §4 an alpha AND a numeric chart for one audience: the product's own list picks ──");
{
  const WOMEN_EU = chart("women", "tops", [
    { size: "36", minChest: 82, maxChest: 85 }, { size: "38", minChest: 86, maxChest: 89 },
    { size: "40", minChest: 90, maxChest: 93 }, { size: "42", minChest: 94, maxChest: 97 }], { size_system: "numeric" });
  set({ storedSizeCharts: [WOMEN_EU, WOMEN_TOPS], pendingGarmentGender: "women", pendingSizes: "XS,S,M,L" });
  /* The EU chart also answers to S/M/L (WOMEN_TOPS_EU_SIZE_CHART aliases) - 3 shared vs
     the alpha chart's 4, so the alpha chart wins on the letter product. */
  check("§4.1 a product sold XS-L takes the ALPHA chart", same(pickStoredSizeChart().chart, WOMEN_TOPS), pickStoredSizeChart().reason);
  /* castro's real shape: EU 34-42 answers to XS-L via the vetted aliases - a 5-5 TIE on
     overlap with the store's own letter chart. The chart whose OWN labels match wins,
     whichever order the server listed them in. */
  const EU_FULL = chart("women", "tops", ["34", "36", "38", "40", "42"].map((s, i) =>
    ({ size: s, minChest: 78 + i * 5, maxChest: 82 + i * 5 })), { size_system: "numeric" });
  for (const order of [[EU_FULL, WOMEN_TOPS], [WOMEN_TOPS, EU_FULL]]) {
    set({ storedSizeCharts: order, pendingGarmentGender: "women", pendingSizes: "XS,S,M,L" });
    check(`§4.1b equal overlap (EU via aliases vs own letters), ${order[0] === EU_FULL ? "EU listed first" : "letters listed first"}: the letter chart wins`,
      same(pickStoredSizeChart().chart, WOMEN_TOPS), pickStoredSizeChart().reason);
  }
  /* The numeric side is exercised on BOTTOMS: a numeric TOPS run (EU 34-46) is read as
     a waist/EU pants run by isPantsProduct()'s size-run tier (pre-existing room
     behaviour), so a product sold in numbers never asks for a tops chart at all - the
     women's EU tops chart is kept in the table, but today only a letter product can
     use it, and only through its aliases (§4.1). */
  const W_BOTTOMS_ALPHA = chart("women", "bottoms", [
    { size: "XS", minWaist: 60, maxWaist: 64 }, { size: "S", minWaist: 65, maxWaist: 69 }, { size: "M", minWaist: 70, maxWaist: 74 }]);
  const W_BOTTOMS_NUM = chart("women", "bottoms", [
    { size: "26", minWaist: 64, maxWaist: 67 }, { size: "28", minWaist: 69, maxWaist: 72 }, { size: "30", minWaist: 74, maxWaist: 77 }],
    { size_system: "numeric" });
  set({ storedSizeCharts: [W_BOTTOMS_ALPHA, W_BOTTOMS_NUM], pendingGarmentGender: "women", pendingSizes: "26,28,30" });
  check("§4.2 a product sold 26-30 takes the NUMERIC bottoms chart (listed second - order-independent)",
    same(pickStoredSizeChart().chart, W_BOTTOMS_NUM), pickStoredSizeChart().reason);
  check("§4.3 the reason names the size system", /numeric/.test(pickStoredSizeChart().reason), pickStoredSizeChart().reason);
  set({ storedSizeCharts: [W_BOTTOMS_NUM, W_BOTTOMS_ALPHA], pendingGarmentGender: "women", pendingSizes: "XS,S,M", pendingTitle: "Wide Leg Pants" });
  check("§4.4 ...and the same store's letter pants take the ALPHA chart", same(pickStoredSizeChart().chart, W_BOTTOMS_ALPHA), pickStoredSizeChart().reason);
}

console.log("\n── §5 the real calculateSize() ──");
{
  const el = () => ({ value: "", innerText: "", disabled: false, hidden: false,
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle() {} }, remove() {} });
  const mount = async (h, w, extra = {}) => {
    const els = {};
    for (const id of ["height", "weight", "chest", "waist", "legs", "resultBox", "sizeResult", "resultLabel",
      "btn-next-screen", "resultActions", "optionalFields"]) els[id] = el();
    els.height.value = String(h); els.weight.value = String(w);
    for (const [k, v] of Object.entries(extra)) els[k].value = String(v);
    for (const id of ["sizeMismatchView", "sizeMismatchText", "captureBtn", "cameraCard", "progressFill", "progressPercent"]) els[id] = el();
    els.progressFill.style = {};
    __set({ __els: els });
    await calculateSize();
    return { els, ...__get() };
  };
  set({ storedSizeCharts: [], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL", currentUserGender: "men" });
  const before = await mount(180, 80);
  check("§5.1 no store chart: today's answer (L), Continue enabled", before.currentUserSize === "L" &&
    !before.els["btn-next-screen"].disabled, before.currentUserSize);

  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL", currentUserGender: "men" });
  const after = await mount(180, 80);
  check("§5.2 with the store's men's chart: M, in currentUserSize AND on screen",
    after.currentUserSize === "M" && after.els.sizeResult.innerText === "M", `${after.currentUserSize} / ${after.els.sizeResult.innerText}`);
  check("§5.3 the guard state is exactly today's (adult/adult), Continue enabled",
    after.currentSizeCategory === before.currentSizeCategory && after.currentBodyCategory === before.currentBodyCategory &&
    !after.els["btn-next-screen"].disabled, `${after.currentSizeCategory}/${after.currentBodyCategory}`);
  const typed = await mount(180, 80, { chest: 107 });
  check("§5.4 a typed chest reaches the decision through the real form", typed.currentUserSize === "L", typed.currentUserSize);

  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL", currentUserGender: null });
  check("§5.5 shopper gender unknown -> the estimate abstains -> today's L", (await mount(180, 80)).currentUserSize === "L");

  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "S,M,L,XL", currentUserGender: "men" });
  const huge = await mount(215, 150);
  check("§5.6 out of catalog stays NO MATCH with Continue blocked - the store chart cannot rescue it",
    huge.currentUserSize === null && huge.els["btn-next-screen"].disabled && huge.els.resultBox.classList.contains("no-match-result"),
    `${huge.currentUserSize} disabled=${huge.els["btn-next-screen"].disabled}`);

  set({ storedSizeCharts: [MEN_TOPS], pendingGarmentGender: "men", pendingSizes: "8,10,12,14,16", currentUserGender: "men" });
  const kid = await mount(180, 80);
  check("§5.7 adult body + kids-only product: still no adult size, still blocked (guard intact)",
    kid.currentUserSize === null && kid.els["btn-next-screen"].disabled && kid.currentBodyCategory === "adult",
    `${kid.currentUserSize} ${kid.currentSizeCategory}/${kid.currentBodyCategory}`);

  const calc = extract(LIB, "export function computeSizeVerdict(ev", "\n/* ══ THE WIRE");
  const at = calc.indexOf("storeChartRecommendation({");
  check("§5.8 the decision runs AFTER the no-match early return and AFTER the kernel's own answer",
    at > calc.indexOf("if (!currentSizeCategory) {") && at > calc.indexOf("// SNAP TO THE PRODUCT'S OWN LIST."));
  check("§5.9 ...gated on an ADULT size category", /if \(currentSizeCategory === "adult" && typeof storeChartRecommendation === "function"\)/.test(calc));
  check("§5.10 ...and nothing after it re-assigns the guard state",
    !/currentSizeCategory\s*=[^=]|bodyCategory\s*=[^=]/.test(calc.slice(at)));
  const fn = extract(LIB, "function storeChartRecommendation(", "\n/* ── PHASE 0: STORE CHART vs DEFAULT");
  check("§5.11 storeChartRecommendation() never names a height/weight BAND (it cannot reach the kernel)",
    !/(?:min|max)(?:Height|Weight)/.test(fn));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("store-chart-recommendation: all checks passed.");
