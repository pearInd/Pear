/* THE STOREFRONT SIZE CHART, LAID OVER THE VETTED MATRIX
   ─────────────────────────────────────────────────────────────────────────────
   WHAT THIS FEATURE IS: calculateSize() fits every shopper against ONE hardcoded
   global matrix (ZARA_SIZE_CHART, ADULT_PANTS_SIZE_CHART, ADULT_JEANS_WAIST_CHART).
   Those bands are vetted and they are OURS. The storefront the shopper is standing on
   almost always publishes its own size guide with real chest/waist/hip centimetres per
   size, and that is the chart the merchant gets judged against when the parcel arrives.
   pear-widget.js now reads it; applyStoreChartOverlay() here decides what it may do.

   WHAT THESE TESTS ARE REALLY PINNING, and it is one thing above all others:

   §1 THE KERNEL IS UNTOUCHABLE. calculateSize() computes in two stages. The kernel is
      height + weight via coreHwPenalty(), and it decides which rows are candidates at
      all, whether the shopper is adult or child (and therefore the kids/adult go-live
      guard), and the overflow ceiling behind "no size available". The fine-tune is the
      ×0.5 chest/waist/legs pass that only breaks a tie BETWEEN rows the kernel already
      admitted. A merchant's chart publishes body circumferences - never a height or a
      weight band - so the overlay writes fine-tune columns and nothing else. That bound
      is the entire reason parsing a stranger's HTML is an acceptable input to the size
      calculator, and §1 exists to hold it: every height/weight bound on every row of
      every chart is asserted byte-identical before and after, including against a
      malicious chart that tries to smuggle one in.

   §2 IT ACTUALLY CHANGES SOMETHING. A safety argument that also describes dead code is
      worth nothing (CLAUDE.md RULE 0). §2 runs the REAL fine-tune loop, extracted from
      calculateSize() itself, and shows a body that resolves to M on our bands resolving
      to S on a store's - the whole point of the feature.

   §3 EVERY REFUSAL. Partial charts, unknown sizes, out-of-clamp bands, inverted bands,
      a column the base chart deliberately does not carry, a non-cm unit on the wire,
      garbage, and a throwing input - each must leave the default matrix in place, and
      §3 checks the IDENTITY of the returned array (===), not just its contents, because
      "returns an equal copy" and "returns the base chart" are different promises to the
      caller and only one of them is free.

   §4 THE LOCKSTEP (CLAUDE.md §3). Since 2026-09-26 the widget sends the page's tables
      RAW (encodeRawSizeChart()) and lib/sizing.js reads them (decodeRawSizeChart() ->
      readStoreSizeChart() -> encodeSizeChart() -> parseStoreSizeChart()). §4 round-trips
      the v1 grammar through the decoder, and the widget's own RAW encoder through the
      server's raw decoder, so a change to either side that the other did not receive
      fails here rather than in production.
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
/* The decoder, the overlay and the fit moved out of the browser on 2026-09-26 - they run
   server-side from lib/sizing.js now. This suite imports that module for execution and
   reads its source for the absence checks; app.js is still read for what stayed there
   (the evidence it sends, the handoff, the widget listener). */
const LIB = readFileSync(new URL("../lib/sizing.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PW  = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

const load = (code, exports) =>
  import("data:text/javascript," + encodeURIComponent(code + "\nexport {" + exports.join(",") + "};"));

const {
  applyStoreChartOverlay, parseStoreSizeChart, parseSizeList, coreHwPenalty,
  STORE_CHART_CLAMPS, ZARA_SIZE_CHART, ADULT_PANTS_SIZE_CHART,
  encodeSizeChart, decodeRawSizeChart, readStoreSizeChart, storeChartWire, SIZE_CHART_CLAMPS, RAW_CHART_PREFIX,
} = await import("../lib/sizing.js");

const KERNEL_KEYS = ["minHeight", "maxHeight", "minWeight", "maxWeight"];
const kernelOf = (chart) =>
  JSON.stringify(chart.map((r) => KERNEL_KEYS.map((k) => r[k])));

/* A store chart in the decoded (row-object) shape, so the §1-§3 cases read as data
   rather than as strings. §4 exercises the string path end to end. */
const rows = (...list) => list;

/* ══════════════════════════════════════════════════════════════════════════════
   §1 THE KERNEL IS UNTOUCHABLE
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §1 height and weight are not writable ──");
{
  const before = kernelOf(ZARA_SIZE_CHART);
  const out = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "S", minChest: 92, maxChest: 98, minWaist: 74, maxWaist: 80, minLegs: 90, maxLegs: 96 },
    { size: "M", minChest: 99, maxChest: 104, minWaist: 81, maxWaist: 86, minLegs: 97, maxLegs: 103 },
    { size: "L", minChest: 105, maxChest: 110, minWaist: 87, maxWaist: 92, minLegs: 101, maxLegs: 106 },
  ));

  check("§1.1 every height/weight bound on the OVERLAID chart is identical",
    kernelOf(out) === before, `${kernelOf(out)}\n        vs ${before}`);
  check("§1.2 ...and the base chart itself was not mutated",
    kernelOf(ZARA_SIZE_CHART) === before);
  check("§1.3 the fine-tune columns DID move (or §1.1 proves nothing)",
    out.find((r) => r.size === "M").minChest === 99 &&
    ZARA_SIZE_CHART.find((r) => r.size === "M").minChest === 96,
    `overlaid M chest ${out.find((r) => r.size === "M").minChest}, base M chest ${ZARA_SIZE_CHART.find((r) => r.size === "M").minChest}`);

  /* THE HOSTILE CASE. A merchant's HTML is a stranger's input, and the one thing that
     would make this feature dangerous is a chart that reaches the kernel. It cannot
     even be expressed: applyStoreChartOverlay() spreads the base row and overwrites
     only the four fine-tune keys, so a height/weight field on a store row is not
     "rejected", it is never read. */
  const smuggled = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "M", minHeight: 100, maxHeight: 250, minWeight: 1, maxWeight: 500, minChest: 99, maxChest: 104 },
  ));
  check("§1.4 a chart that tries to smuggle height/weight bands changes neither",
    kernelOf(smuggled) === before, kernelOf(smuggled));
  check("§1.5 ...while its legitimate chest column still landed",
    smuggled.find((r) => r.size === "M").minChest === 99);

  /* The same promise on the OTHER chart family - the pants ladder has a different
     column shape (waist + hips, no chest/legs) and must be just as safe. */
  const pantsBefore = kernelOf(ADULT_PANTS_SIZE_CHART);
  const pantsOut = applyStoreChartOverlay(ADULT_PANTS_SIZE_CHART, rows(
    { size: "40", minWaist: 74, maxWaist: 80, minHips: 98, maxHips: 104 },
    { size: "42", minWaist: 81, maxWaist: 88, minHips: 105, maxHips: 111 },
  ));
  check("§1.6 the pants chart's kernel is equally untouched",
    kernelOf(pantsOut) === pantsBefore, kernelOf(pantsOut));
  check("§1.7 ...and its waist/hips bands took the store's values",
    pantsOut.find((r) => r.size === "40").minWaist === 74 &&
    pantsOut.find((r) => r.size === "40").minHips === 98);

  /* Stated as an ABSENCE, the only form that catches a new well-meant line being added
     to the overlay later - the same discipline image-first.test.mjs uses on the prompt
     builders. If a future edit needs a height column, it has to delete this test first,
     which is exactly the conversation that should happen. */
  const fn = extract(LIB, "function applyStoreChartOverlay(baseChart, storeRows) {", "\n/**");
  check("§1.8 applyStoreChartOverlay()'s body never names a height or weight field",
    !/min(?:Height|Weight)|max(?:Height|Weight)/.test(fn),
    (fn.match(/(?:min|max)(?:Height|Weight)/g) || []).join(", "));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §2 IT REACHES THE RECOMMENDATION - the real fine-tune loop, not a replica
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §2 the overlay moves the size a real body resolves to ──");
{
  /* calculateSize() cannot run here (it is DOM-bound end to end), so the two halves it
     is built from are run separately, each extracted from the file rather than
     rewritten: the genuine-fit filter is coreHwPenalty() === 0, and the tie-break is
     the block below, lifted verbatim out of calculateSize().
     ⚠️ CLAUDE.md §2.6 - this start line is now an extract marker. */
  const fineTuneSrc = extract(
    LIB,
    'const candidates = currentSizeCategory === "child" ? childFits : adultFits;',
    "// SNAP TO THE PRODUCT'S OWN LIST.");
  const fineTune = new Function(
    "currentSizeCategory", "useNumericPantsChart", "childFits", "adultFits",
    "chest", "waist", "legs",
    fineTuneSrc + "\nreturn bestSize;");

  /* 171cm / 66kg sits in BOTH S (160-172 / 55-67) and M (170-180 / 65-76), which is
     exactly the overlap calculateSize()'s own comment names as the reason the
     fine-tune pass exists at all. With a 97cm chest our bands put them in M. */
  const H = 171, W = 66, CHEST = 97;
  const fits = (chart) => chart.filter((r) => coreHwPenalty(r, H, W) === 0);

  check("§2.1 the body genuinely fits two adjacent sizes (else this proves nothing)",
    fits(ZARA_SIZE_CHART).map((r) => r.size).join("/") === "S/M",
    fits(ZARA_SIZE_CHART).map((r) => r.size).join("/"));

  const ours = fineTune("adult", false, [], fits(ZARA_SIZE_CHART), CHEST, null, null);
  check("§2.2 on OUR vetted bands a 97cm chest resolves to M", ours === "M", ours);

  /* A store that runs small: its M starts at 99cm, so a 97cm chest is their S. */
  const storeChart = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "S", minChest: 92, maxChest: 98 },
    { size: "M", minChest: 99, maxChest: 104 },
    { size: "L", minChest: 105, maxChest: 110 },
  ));
  const theirs = fineTune("adult", false, [], fits(storeChart), CHEST, null, null);
  check("§2.3 with the store's own chart overlaid, the same body resolves to S",
    theirs === "S", theirs);

  check("§2.4 the candidate SET is unchanged - the overlay moved the tie-break, not the gate",
    fits(storeChart).map((r) => r.size).join("/") === "S/M",
    fits(storeChart).map((r) => r.size).join("/"));

  /* And the call site: the overlay has to sit between chart selection and the
     genuine-fit filter. Below the filter it would score rows the overlay never saw. */
  const calcHead = extract(LIB, "const useNumericPantsChart = product.chart",
    "const childFits =");
  const overlayIdx = calcHead.indexOf("applyStoreChartOverlay(");
  const filterIdx = calcHead.indexOf("const bodyAdultFits =");
  check("§2.5 computeSizeVerdict() overlays the chart BEFORE the genuine-fit filter",
    overlayIdx > 0 && filterIdx > overlayIdx, `overlay@${overlayIdx} filter@${filterIdx}`);
  check("§2.6 ...and feeds it from the evidence's store chart, not a literal",
    /applyStoreChartOverlay\([\s\S]{0,200}parseStoreSizeChart\(ev\.storeChart\)\)/.test(calcHead));
  check("§2.6b ...which calculateSize() fills from resolvedStoreSizeChart()",
    /storeChart: resolvedStoreSizeChart\(\),/.test(extract(APP, "function calculateSize() {", "\nfunction applySizeVerdict(")));
  /* CHILD_SIZE_CHART carries no measurement columns and the fine-tune pass is skipped
     outright on the child path, so an overlay there would be a clause that cannot reach
     the wire - CLAUDE.md RULE 0's spirit, asserted as an absence. */
  check("§2.7 the child chart is deliberately NOT overlaid",
    !/applyStoreChartOverlay\(\s*CHILD_SIZE_CHART/.test(LIB) &&
    /* ...and the browser runs no overlay at all (comments may still name it). */
    !/applyStoreChartOverlay\(/.test(APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §3 EVERY REFUSAL LANDS ON THE DEFAULT MATRIX
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §3 the fail-safe: anything unreadable keeps our own chart ──");
{
  const id = (v, label) =>
    check(label, applyStoreChartOverlay(ZARA_SIZE_CHART, v) === ZARA_SIZE_CHART);

  id(undefined, "§3.1 undefined -> the base chart, by identity");
  id(null, "§3.2 null -> the base chart");
  id([], "§3.3 an empty chart -> the base chart");
  id("cm;shopify;S:90-95:::", "§3.4 a raw string (never decoded) -> the base chart");
  id(rows({ size: "" }, { size: null }), "§3.5 rows with no usable size token");
  id(rows({ size: "XXXXL", minChest: 120, maxChest: 130 }),
    "§3.6 a size the base chart doesn't have is ignored");

  /* A getter that throws is the cheapest stand-in for every "something unexpected
     happened inside the loop" - the promise is that it costs the shopper nothing. */
  const boom = [{ get size() { throw new Error("boom"); } }];
  id(boom, "§3.7 a throwing row -> the base chart, not an exception");

  const clamped = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "M", minChest: 10, maxChest: 20 },                       // a price column
    { size: "L", minChest: 104, maxChest: 109 },                     // a real band
  ));
  check("§3.8 an out-of-clamp band is refused, and OUR band survives on that row",
    clamped.find((r) => r.size === "M").minChest === 96,
    String(clamped.find((r) => r.size === "M").minChest));
  check("§3.9 ...while the valid row beside it still took the store's band",
    clamped.find((r) => r.size === "L").minChest === 104,
    String(clamped.find((r) => r.size === "L").minChest));
  /* And when the out-of-clamp column is the ONLY thing on offer, nothing is written at
     all and the caller gets the base chart back by identity - no pointless clone. */
  id(rows({ size: "M", minChest: 10, maxChest: 20 }),
    "§3.9b a chart whose every column is refused -> the base chart, by identity");

  const inverted = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "M", minChest: 104, maxChest: 99 }));
  check("§3.10 an inverted band (min > max) is refused", inverted === ZARA_SIZE_CHART);

  /* PARTIAL IS NORMAL, not a failure: most charts publish chest and waist and nothing
     else. The columns the store did not publish keep OUR bands. */
  const partial = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "M", minChest: 99, maxChest: 104 }));
  const m = partial.find((r) => r.size === "M"), baseM = ZARA_SIZE_CHART.find((r) => r.size === "M");
  check("§3.11 a chest-only chart writes chest...", m.minChest === 99 && m.maxChest === 104);
  check("§3.12 ...and leaves waist on our bands",
    m.minWaist === baseM.minWaist && m.maxWaist === baseM.maxWaist);
  check("§3.13 ...and legs too", m.minLegs === baseM.minLegs && m.maxLegs === baseM.maxLegs);
  check("§3.14 ...and the rows it never named are passed through by reference",
    partial.find((r) => r.size === "L") === ZARA_SIZE_CHART.find((r) => r.size === "L"));

  /* REFINE, NEVER EXTEND. ZARA_SIZE_CHART carries no hips column; a store may not
     introduce a measurement dimension the vetted chart deliberately does not score. */
  const hips = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: "M", minHips: 96, maxHips: 103 }));
  check("§3.15 a column the base chart does not carry is not ADDED",
    hips === ZARA_SIZE_CHART && ZARA_SIZE_CHART.find((r) => r.size === "M").minHips === undefined);

  /* Size tokens are normalised, never compared raw - the same discipline CLAUDE.md §2.2
     imposes on image URLs, for the same reason: two spellings of one size that fail to
     compare equal would silently overlay nothing while looking like it worked. */
  const spelled = applyStoreChartOverlay(ZARA_SIZE_CHART, rows(
    { size: " m ", minChest: 99, maxChest: 104 }));
  check("§3.16 ' m ' matches the ladder's 'M'",
    spelled.find((r) => r.size === "M").minChest === 99,
    String(spelled.find((r) => r.size === "M").minChest));

  check("§3.17 the clamps are real numbers, and legs is tighter than the torso ones",
    STORE_CHART_CLAMPS.chest[0] === 50 && STORE_CHART_CLAMPS.chest[1] === 200 &&
    STORE_CHART_CLAMPS.legs[1] === 140);
}

/* ══════════════════════════════════════════════════════════════════════════════
   §4 THE WIRE FORMAT - one grammar, two files (CLAUDE.md §3)
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §4 the widget's raw tables <-> the server's reader and decoder ──");
{
  const chart = {
    unit: "cm", source: "shopify", rows: [
      { size: "S", minChest: 90, maxChest: 95, minWaist: 76, maxWaist: 81 },
      { size: "M", minChest: 96, maxChest: 101, minWaist: 82, maxWaist: 87 },
      { size: "L", minChest: 102, maxChest: 107, minWaist: 88, maxWaist: 93 },
    ],
  };
  const wire = encodeSizeChart(chart);
  check("§4.1 the encoder emits the documented grammar",
    wire === "cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::", wire);
  check("§4.2 it is compact (< 300 chars encoded) - an old widget still sends it on the URL",
    encodeURIComponent(wire).length < 300, `${encodeURIComponent(wire).length} chars`);

  const back = parseStoreSizeChart(wire);
  check("§4.3 the decoder round-trips every row",
    back.length === 3 && back.map((r) => r.size).join("/") === "S/M/L",
    JSON.stringify(back));
  check("§4.4 ...with the bands intact",
    back[1].minChest === 96 && back[1].maxChest === 101 &&
    back[1].minWaist === 82 && back[1].maxWaist === 87, JSON.stringify(back[1]));
  check("§4.5 ...and no phantom columns for the cells the chart left empty",
    back[1].minHips === undefined && back[1].minLegs === undefined);

  /* And the whole way through: the widget's string, decoded, overlaid, still safe. */
  const kernelBefore = kernelOf(ZARA_SIZE_CHART);
  const applied = applyStoreChartOverlay(ZARA_SIZE_CHART, parseStoreSizeChart(wire));
  check("§4.6 end to end - widget string -> decoded -> overlaid, kernel intact",
    kernelOf(applied) === kernelBefore);
  check("§4.7 ...and the store's waist band is what the calculator will score",
    applied.find((r) => r.size === "S").minWaist === 76);

  /* THE UNIT REFUSAL. The widget converts to centimetres before encoding, so "in" on
     the wire means one of the two sides drifted - and a chart converted twice (or not
     at all) is the one failure here that yields plausible, confident, WRONG bands
     instead of a visible absence. */
  check("§4.8 a non-cm unit on the wire is refused outright",
    parseStoreSizeChart("in;shopify;S:36-38:::").length === 0);
  check("§4.9 a headerless / truncated string is refused",
    parseStoreSizeChart("S:90-95:::").length === 0 && parseStoreSizeChart("cm;shopify").length === 0);
  check("§4.10 garbage is refused without throwing",
    parseStoreSizeChart("cm;x;;;;|||").length === 0 &&
    parseStoreSizeChart(" �").length === 0);
  check("§4.11 an empty / absent chart decodes to []",
    parseStoreSizeChart("").length === 0 && parseStoreSizeChart(undefined).length === 0 &&
    parseStoreSizeChart(null).length === 0 && parseStoreSizeChart(42).length === 0);
  check("§4.12 a row with a size but no measurement is dropped, not carried",
    parseStoreSizeChart("cm;generic;S:::|M:96-101:::").map((r) => r.size).join("/") === "M");
  check("§4.13 the decoder normalises size tokens the same way parseSizeList does",
    parseStoreSizeChart("cm;generic;s:90-95:::|m:96-101:::").map((r) => r.size).join("/") === "S/M");

  /* THE CLAMPS ARE TWO GATES, ONE DECISION. The reader clamps as it parses a raw table
     (refusing a column) and the overlay clamps again at the write point (refusing any
     sender's number). Both live in lib/sizing.js now, but they are still two tables that
     must agree about what a human body can measure. Compared by VALUE. */
  for (const key of ["chest", "waist", "hips", "legs"]) {
    check(`§4.${16 + ["chest", "waist", "hips", "legs"].indexOf(key)} ${key} clamp agrees between the reader and the overlay`,
      SIZE_CHART_CLAMPS[key].min === STORE_CHART_CLAMPS[key][0] &&
      SIZE_CHART_CLAMPS[key].max === STORE_CHART_CLAMPS[key][1],
      `reader ${JSON.stringify(SIZE_CHART_CLAMPS[key])} vs overlay ${JSON.stringify(STORE_CHART_CLAMPS[key])}`);
  }

  /* THE RAW WIRE, round-tripped: the widget's own encoder, run for real, into the
     server's own decoder - grids, units, bonus and order must come back exactly. */
  const { encodeRawSizeChart } = await load(
    extract(PW, "  var RAW_CHART_PREFIX = \"raw;\";", "\n  }\n") + "\n  }\n", ["encodeRawSizeChart"]);
  const cands = [
    { source: "shopify", bonus: 6, unit: "cm", grid: [["Size", "Chest (cm)", "Waist"], ["S", "90-95", "76-81"], ["M", "96-101", "82-87"], ["L", "102-107", ""]] },
    { source: "generic", bonus: 0, unit: null, grid: [["מידה", "היקף חזה"], ["M", "96"], ["L", "a\u001fb"]] },
  ];
  const raw = encodeRawSizeChart(cands, 0);
  const back2 = decodeRawSizeChart(raw);
  check("§4.20 the widget's raw encoder carries its prefix", raw.startsWith(RAW_CHART_PREFIX), raw.slice(0, 20));
  check("§4.21 ...and the server's decoder returns every candidate, in order, with its grid",
    back2.length === 2 && back2[0].source === "shopify" && back2[0].bonus === 6 && back2[0].unit === "cm" &&
    JSON.stringify(back2[0].grid) === JSON.stringify(cands[0].grid) &&
    back2[1].unit === null && back2[1].grid[2][1] === "a b",
    JSON.stringify(back2));
  check("§4.22 a raw chart reaches the overlay as the v1 string its reader produces",
    storeChartWire(raw) === encodeSizeChart(readStoreSizeChart(back2)) &&
    storeChartWire(raw).startsWith("cm;shopify;S:90-95:76-81::|M:96-101:82-87::"), storeChartWire(raw));
  check("§4.23 ...and the same rows parseStoreSizeChart() returns for that v1 string",
    JSON.stringify(parseStoreSizeChart(raw)) === JSON.stringify(parseStoreSizeChart(storeChartWire(raw))));
  const big = { source: "generic", bonus: 0, unit: null, grid: Array.from({ length: 40 }, (_, i) => ["row " + i, "x".repeat(200)]) };
  const budgeted = decodeRawSizeChart(encodeRawSizeChart([cands[0], big, cands[1]], 1500));
  check("§4.24 the URL budget skips a candidate that does not fit WHOLE - never cuts one - and keeps the ones after it",
    budgeted.length === 2 && budgeted[0].source === "shopify" && JSON.stringify(budgeted[1].grid) === JSON.stringify(back2[1].grid),
    JSON.stringify(budgeted.map((c) => [c.source, c.grid.length])));
  check("§4.25 a raw chart past the size cap is refused whole, not truncated",
    decodeRawSizeChart(RAW_CHART_PREFIX + "x".repeat(300000)).length === 0);

  /* The lockstep check the §3 table is really about: both halves of each pair exist, in
     their own files, and the READER is in exactly one of them. */
  check("§4.14 the raw encoder lives in the widget and names its counterpart",
    /function encodeRawSizeChart\(/.test(PW) && /decodeRawSizeChart\(\) in/.test(PW));
  check("§4.15 the decoder lives server-side (lib/sizing.js) and names its counterpart",
    /function decodeRawSizeChart\(/.test(LIB) && /encodeRawSizeChart\(\) in pear-widget\.js/.test(LIB) &&
    /function parseStoreSizeChart\(/.test(LIB));
  check("§4.15b ...and the browser no longer carries a copy of it",
    !/function parseStoreSizeChart\(/.test(APP));
  const pwCode = PW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["sizeChartFromGrid", "parseMeasurementCell", "sizeChartMeasureKey", "sizeChartOrient",
                      "sizeChartColumnToCm", "SIZE_CHART_MEASURE_KEYS", "SIZE_CHART_GARMENT_DIM_RE",
                      "SIZE_CHART_WORD_SIZES", "SIZE_CHART_CLAMPS", "encodeSizeChart", "extractSizeChart"]) {
    check(`§4.26 the widget no longer carries the reader's ${name}`, !new RegExp(`\\b${name}\\b`).test(pwCode));
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   §5 THE HANDOFF - both delivery paths, and the one that can CLEAR a bad chart
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §5 the chart reaches Screen 1, and a correction can retract it ──");
{
  const handoff = extract(APP, "sizeRunType: q.get(\"garment_size_type\")", "angle: readAngle(),");
  check("§5.1 parseHandoff() reads ?garment_size_chart= synchronously",
    /sizeChart: q\.get\("garment_size_chart"\)/.test(handoff), handoff.slice(0, 120));

  const seed = extract(APP, "if (pendingSizes === undefined && result.sizes !== undefined)",
    "// CHECK B instrumentation");
  check("§5.2 ...and seeds pendingSizeChart, never overwriting a later correction",
    /if \(pendingSizeChart === undefined && result\.sizeChart !== undefined\)/.test(seed));

  const listener = extract(APP, "const incomingChart = e.data.garment_size_chart;",
    "const incomingSizes = e.data.garment_sizes;");
  check("§5.3 the correction accepts a STRING as a real answer...",
    /typeof incomingChart === "string"/.test(listener));
  check("§5.4 ...so an empty string can CLEAR a chart the open-time scrape got wrong",
    !/if \(incomingChart &&/.test(listener) && /pendingSizeChart = incomingChart;/.test(listener),
    listener.slice(0, 200));
  check("§5.5 ...and it re-runs the calculator while the shopper is still on Screen 1",
    /calculateSize\(\)/.test(listener));
  check("§5.6 ...and stamps the active item too, so Screen 2 agrees with Screen 1",
    /activeItem\.sizeChart = incomingChart/.test(listener));

  /* resolvedStoreSizeChart() is executed inside slices that have no module scope
     (CLAUDE.md §2.7) - a bare reference to either binding is a ReferenceError there. */
  const resolver = extract(APP, "function resolvedStoreSizeChart() {", "\n/** @param {string|null|undefined} size");
  check("§5.7 the resolver typeof-guards both module globals",
    /typeof activeItem !== "undefined"/.test(resolver) &&
    /typeof pendingSizeChart !== "undefined"/.test(resolver), resolver);
  check("§5.8 the item outranks the pending value, mirroring resolvedSoldOutSizes()",
    resolver.indexOf("item.sizeChart") < resolver.indexOf("pendingSizeChart"));

  /* The widget side of the same contract: read LAZILY, at click time, never at load. */
  /* LAZY, AND ONLY LAZY. The whole zero-page-load-cost claim rests on there being no
     third call site - one added to the boot path or a DOMContentLoaded handler would
     walk every table on every PDP for every visitor who never clicks. Counted on the
     full `encodeRawSizeChart(collectSizeChartCandidates()` call, not the bare name, so
     the function's own definition and the comments that reference it don't inflate it. */
  const callSites = (PW.match(/encodeRawSizeChart\(collectSizeChartCandidates\(\)/g) || []).length;
  check("§5.9 exactly two call sites: openModal() and the PEAR_UPDATE_GARMENT correction",
    callSites === 2, callSites + " call sites");
  check("§5.9b ...and neither is on the page-load path",
    !/(?:DOMContentLoaded|"load")[\s\S]{0,400}collectSizeChartCandidates\(\)/.test(PW));
  const openModalSrc = extract(PW, "function openModal(garment) {", "var overlay = d.createElement");
  check("§5.10 ...and openModal() is one of them, inside the URL budget",
    /encodeRawSizeChart\(collectSizeChartCandidates\(\), SIZE_CHART_URL_BUDGET\)/.test(openModalSrc));
  check("§5.10b ...while the correction carries every candidate (no budget)",
    /garment_size_chart: encodeRawSizeChart\(collectSizeChartCandidates\(\), 0\)/.test(PW));
  check("§5.11 ...emitting the param only when something was readable",
    /hostSizeChart \? "&garment_size_chart=" \+ encodeURIComponent\(hostSizeChart\) : ""/.test(openModalSrc));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("size-chart-overlay: all checks passed.");
