/* =============================================================================
   PEAR · Size recommendation - the fit, server-side
   -----------------------------------------------------------------------------
   WHY THIS LIVES HERE AND NOT IN THE BROWSER. Until 2026-09-26 every table below,
   with the derivation of every band, shipped to every shopper inside
   fitting-room/app.js: FOX's own men's/women's/waist ladders, the BMI regressions
   the height/weight columns were derived from, the kernel, the fine-tune and the
   rules for laying a storefront's chart over ours. That is the most directly
   copyable thing PEAR owns - a competitor could lift the numbers in one paste.
   The browser now sends the EVIDENCE (the shopper's measurements plus the
   garment-type verdicts it already computes) to POST /api/size and receives a
   VERDICT; none of this file reaches a client (CLAUDE.md §2.10 - lib/ is not a
   public directory).

   THE SPLIT, AND WHY IT IS HERE. What moved is everything that holds a body
   measurement: the five charts, coreHwPenalty(), the store-chart decode/overlay,
   and the fit itself (genuine-fit filter, adult/child resolution, overflow, the
   ×0.5 fine-tune tie-break, the snap to the product's own list) - and, in a second
   pass the same day, the PRODUCT rules that pick a chart: is this garment kids-only,
   adult-only, lower-body, EU-numbered or waist-numbered (isKidsProduct(),
   isPantsProduct(), isAlphaSizeRun(), pantsChartKindForSizes()… - "THE PRODUCT"
   below). The browser sends raw product evidence - its own size list, the title, the
   classifier's age group and category, the cached size-run type, the active item's
   type fields and bottoms verdict - and reads back only what it acts on: the chart
   kind, kids-only / adult-only for the go-live guard, and whether the product's own
   numeric list is the override ladder. What stays in app.js is the size LADDERS
   (labels only), stock, labels and the DOM.

   BEHAVIOUR IS BYTE-FOR-BYTE THE OLD calculateSize(). The code below is moved,
   not rewritten: the old in-browser function and this one were run over the same
   1,458,028 input cases (26 garment situations × the full height/weight grid ×
   the optional chest/waist/legs grid) and every size, category, label and button
   state matched. The product rules got the same proof when they followed:
   1,092,000 product situations through the browser's evidence builder, JSON
   and sanitizeProductEvidence() against the in-browser functions, every verdict
   equal - and the 1,458,028-case grid re-run through the new shell, unchanged.
   Tests import this module directly - see numeric-pants-sizing, adult-pants-sizing,
   kids-product-sizes, size-chart-overlay and size-fit-pin.

   MARKERS (CLAUDE.md §2.6): size-chart-overlay slices the fine-tune loop out of
   THIS file, from `const candidates = currentSizeCategory === "child" ? …` to
   `// SNAP TO THE PRODUCT'S OWN LIST.`, and runs it standalone - so the local
   names inside computeSizeVerdict() (currentSizeCategory, childFits, adultFits,
   useNumericPantsChart, chest/waist/legs, bestSize) are an interface, not style.
   ============================================================================= */

/* Size-token normaliser for the rows below - trim + upper-case, the same rule as
   parseSizeList() in fitting-room/app.js, which normalises the product's own size
   list before it is sent here (so the two sides compare the same spelling). Kept as
   a private copy because the store-chart decode below was moved verbatim and calls
   it by this name. */
function parseSizeList(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  return list.map((s) => String(s == null ? "" : s).trim().toUpperCase()).filter(Boolean);
}

/* FOX MEN'S TOPS STANDARD (updated 2026-09-14). The chest-cm bands below are FOX's own
   published ladder: S 90-95, M 96-101, L 102-107, XL 108-113, XXL 114-119. FOX gives no
   height/weight bands - the form's MANDATORY inputs are height+weight, chest is only an
   optional fine-tune field - so those columns are derived, not copied from FOX.

   HOW THEY WERE DERIVED. The chart already had a working, shipped chest<->BMI
   relationship (this is what let a 185cm/82kg shopper land on the pre-FOX "L" row) - the
   four old center points (chest 91/98/106/114 -> BMI 21.8/23.0/24.4/25.8) fit a line
   BMI = 0.174*chest + 5.96 (R^2 > 0.999). That fitted line, not the waist-inch formula
   ADULT_JEANS_WAIST_CHART uses (chest and waist scale differently at the same BMI - do
   not reuse that formula here, it was tried and put a lean 90cm chest at BMI 26), maps
   each new FOX chest band to a BMI band. Height ranges reuse the old chart's own ladder
   (real "sold into" ranges, not re-derived) with a new XXL tier extending the existing
   step pattern. Weight bounds are the corner of each row's box: BMI_min at minHeight,
   BMI_max at maxHeight - so a row's weight band is exactly what its own chest band
   implies at its own height extremes.
     S:   BMI 21.6-22.5 over 160-172cm -> weight 55-67
     M:   BMI 22.7-23.5 over 170-180cm -> weight 65-76
     L:   BMI 23.7-24.6 over 178-186cm -> weight 75-85
     XL:  BMI 24.8-25.6 over 184-195cm -> weight 84-97
     XXL: BMI 25.8-26.7 over 190-205cm -> weight 93-112 (new tier - FOX's ladder had no
          XXL row to restore; this is the first time this chart has had one)
   Benchmark this must hold (see CLAUDE.md §1 Layer D): 185cm/82kg -> BMI 23.96, inside
   L's 23.71-24.58 band, and neither S nor M's height band reaches 185cm - so L wins as
   the first (and only) genuine match in chart order, same as before this update.

   waist/legs columns have no FOX spec at all (FOX publishes chest only for tops) and are
   not covered by any test assertion (test/numeric-pants-sizing.test.mjs and
   test/adult-pants-sizing.test.mjs only check these are finite numbers) - waist keeps
   the old chart's own chest-14cm offset (91->77, 98->84, 106->92, 114->101, i.e. a
   near-constant 14cm gap), legs keeps the old chart's own ~0.575x-height ratio.

   THE CONSTANT NAME IS UNCHANGED ON PURPOSE. "ZARA_SIZE_CHART" is a load-bearing extract
   marker (CLAUDE.md §2.6) matched as a literal opening-line string by
   test/numeric-pants-sizing.test.mjs, test/adult-pants-sizing.test.mjs and
   test/kids-product-sizes.test.mjs. Renaming it to something FOX-flavored would steal
   every one of those matches for no behavioral gain - the data is FOX's, the identifier
   is legacy plumbing. */
const ZARA_SIZE_CHART = [
  { size: "S",   minHeight: 160, maxHeight: 172, minWeight: 55, maxWeight: 67,  minChest: 90,  maxChest: 95,  minWaist: 76,  maxWaist: 81,  minLegs: 92,  maxLegs: 99  },
  { size: "M",   minHeight: 170, maxHeight: 180, minWeight: 65, maxWeight: 76,  minChest: 96,  maxChest: 101, minWaist: 82,  maxWaist: 87,  minLegs: 98,  maxLegs: 104 },
  { size: "L",   minHeight: 178, maxHeight: 186, minWeight: 75, maxWeight: 85,  minChest: 102, maxChest: 107, minWaist: 88,  maxWaist: 93,  minLegs: 102, maxLegs: 107 },
  { size: "XL",  minHeight: 184, maxHeight: 195, minWeight: 84, maxWeight: 97,  minChest: 108, maxChest: 113, minWaist: 94,  maxWaist: 99,  minLegs: 106, maxLegs: 112 },
  { size: "XXL", minHeight: 190, maxHeight: 205, minWeight: 93, maxWeight: 112, minChest: 114, maxChest: 119, minWaist: 100, maxWaist: 105, minLegs: 109, maxLegs: 118 },
];

/* FOX WOMEN'S TOPS STANDARD - data received 2026-09-14.
   WIRED 2026-09-15: a gender selector now exists on Screen 1 (#genderToggle in
   index.html -> currentUserGender in app.js) and calculateSize() reads it, via
   currentSizeIsWomensTops (see that flag's own comment) and formatSizeLabel().

   FOX's women's ladder is a EU dress-size token (XS 34 / S 36 / M 38 / L 40 / XL 42 /
   XXL 44), not a chest-cm band, so it does NOT replace ZARA_SIZE_CHART's rows as the
   fit-matching chart - it never grew height/weight columns and coreHwPenalty() cannot
   score a row that has none. What actually happens: EVERY shopper, regardless of
   gender, is still fitted against ZARA_SIZE_CHART's vetted height/weight/chest bands
   (a garment fits the same body no matter which token is printed on the label) - this
   chart is consulted AFTER that match, purely to relabel the resolved letter with its
   EU dress-size token for a shopper who selected "women". Same reason
   ADULT_JEANS_WAIST_CHART is a second chart rather than an edit to ADULT_PANTS_SIZE_CHART
   (see that chart's own comment): a different convention for the same body, not a
   replacement. Letters here are intentionally identical to ZARA_SIZE_CHART's (minus
   3XL, which FOX did not publish a women's token for - see currentSizeIsWomensTops's
   euRow-miss fallback in formatSizeLabel(), which keeps the plain letter rather than
   guessing one). */
const WOMEN_TOPS_EU_SIZE_CHART = [
  { size: "XS",  euSize: 34 },
  { size: "S",   euSize: 36 },
  { size: "M",   euSize: 38 },
  { size: "L",   euSize: 40 },
  { size: "XL",  euSize: 42 },
  { size: "XXL", euSize: 44 },
];

/* Children's numeric sizing (EU/IL kids convention, sizes 8-18).
   Height/weight bands only - unlike ZARA_SIZE_CHART there are no chest/waist/legs
   columns, so the optional fine-tune inputs contribute no penalty against these
   rows - calculateSize() skips them outright on the child path.

   Size 20+ is deliberately absent: the ladder connects into the adult chart on its
   own, since adult S starts at 160cm/55kg and already overlaps size 18's upper end
   (170-176cm / 54-60kg). */
const CHILD_SIZE_CHART = [
  { size: "8",  minHeight: 122, maxHeight: 135, minWeight: 22, maxWeight: 27 },
  { size: "10", minHeight: 135, maxHeight: 145, minWeight: 27, maxWeight: 32 },
  { size: "12", minHeight: 145, maxHeight: 155, minWeight: 32, maxWeight: 38 },
  { size: "14", minHeight: 155, maxHeight: 163, minWeight: 38, maxWeight: 46 },
  { size: "16", minHeight: 163, maxHeight: 170, minWeight: 46, maxWeight: 54 },
  { size: "18", minHeight: 170, maxHeight: 176, minWeight: 54, maxWeight: 60 },
];

/* Adult PANTS numeric sizing (EU convention: 36-46 even sizes). A bottoms garment is
   fitted on waist and hip, not chest - so this chart swaps ZARA_SIZE_CHART's
   minChest/maxChest and minLegs/maxLegs columns for minHips/maxHips, and keeps
   waist. calculateSize() only has a "waist" optional input today (no separate hip
   measurement field), so the fine-tune pass below scores waist alone; minHips/
   maxHips still ride on each row for a standards-comparable chart and for any
   future hip input, they just contribute no penalty yet.
   Ceiling matches ZARA_SIZE_CHART's XL row (195cm/100kg → here 195cm/102kg) so the
   "genuinely out of catalog" overflow guard in calculateSize() means the same thing
   on either chart - see isAdultPantsProduct() below for when this chart is chosen
   over ZARA_SIZE_CHART. */
const ADULT_PANTS_SIZE_CHART = [
  { size: "36", minHeight: 155, maxHeight: 165, minWeight: 48, maxWeight: 58,  minWaist: 64, maxWaist: 70,  minHips: 88,  maxHips: 94  },
  { size: "38", minHeight: 160, maxHeight: 170, minWeight: 55, maxWeight: 65,  minWaist: 68, maxWaist: 74,  minHips: 92,  maxHips: 98  },
  { size: "40", minHeight: 165, maxHeight: 175, minWeight: 62, maxWeight: 73,  minWaist: 72, maxWaist: 79,  minHips: 96,  maxHips: 103 },
  { size: "42", minHeight: 170, maxHeight: 180, minWeight: 70, maxWeight: 82,  minWaist: 77, maxWaist: 85,  minHips: 101, maxHips: 109 },
  { size: "44", minHeight: 175, maxHeight: 186, minWeight: 78, maxWeight: 92,  minWaist: 83, maxWaist: 92,  minHips: 107, maxHips: 116 },
  { size: "46", minHeight: 180, maxHeight: 195, minWeight: 87, maxWeight: 102, minWaist: 90, maxWaist: 100, minHips: 114, maxHips: 124 },
];

/* ── ADULT_JEANS_WAIST_CHART - the FOX WAIST-CM ladder (28-38, updated 2026-09-14) ──
   THE BUG THIS CLOSES (history - keep reading past the FOX update below): "the
   calculator says L for a pair of jeans." A 185cm/82kg shopper on a product sold
   28/30/32/34/36 was sized against ZARA_SIZE_CHART - the adult LETTER chart, which
   bands on CHEST - and handed back "L", a value that does not appear anywhere in
   that product's size picker and cannot be selected.

   WHY THIS IS A SECOND CHART AND NOT AN EDIT TO ADULT_PANTS_SIZE_CHART.
   ────────────────────────────────────────────────────────────────────
   ADULT_PANTS_SIZE_CHART above is the EU ladder (36-46). This is the WAIST ladder.
   They are two different measurement systems that happen to share the tokens 36-46,
   and a store lists one or the other, never both. Collapsing them into one chart
   would have to pick a single meaning for "38" - either a 97cm EU hip size or a
   38-size waist - and would be wrong for every store on the other convention.
   adult-pants-sizing.test.mjs pins the EU behaviour precisely because it was itself
   a fix for a real report; this chart is additive and leaves every one of those
   assertions untouched.

   WHICH CHART A PRODUCT GETS is decided in calculateSize() from the product's OWN
   size run, EU first (see pantsChartForSizes below) - never from a guess.

   THE 2026-09-14 FOX UPDATE - ROW LIST REPLACED, METHOD KEPT. FOX's own men's waist
   ladder is exactly 8 sizes - 28 (71-73cm), 30 (76-78cm), 31 (79-81cm), 32 (81-83cm),
   33 (84-86cm), 34 (86-88cm), 36 (91-93cm), 38 (96-98cm) - narrower bands than the
   old 24-48-even chart this replaces, and it does NOT cover 24, 26, 40, 42, 44, 46,
   48. Those bodies now genuinely fall outside every row (the overflow/no-match guard
   below handles that the same way it already handles any out-of-catalog body -
   CLAUDE.md §2.5, never a guess) rather than getting an old chart's extrapolated
   size. This was a deliberate scope call, not an oversight - see the PR description
   for the decision to replace rather than merge/extend.

   HOW THE BANDS WERE DERIVED (method unchanged from the original fix, only the input
   waist values changed). Waist circumference tracks BMI far more closely than it
   tracks weight alone, which is the whole reason the original reported case was
   wrong in the first place: at 82kg the shopper reads as "large" on a weight-only
   view, and as a lean 24.0 BMI once height is accounted for. Each row's centre is
   BMI = (waist_cm + 14) / 4, the same male waist/BMI regression the original fix
   used (waist_in * 2.54 IS waist_cm, so this chart plugs FOX's cm values in
   directly - do not re-multiply by 2.54, that was only ever a units conversion for
   an inch input). Height/weight bounds are the corner of each row's box: BMI at
   minWaist paired with minHeight, BMI at maxWaist paired with maxHeight - so a row's
   weight band is exactly what its own FOX waist band implies at its own height
   extremes. Height ranges below 32 reuse the old chart's ladder for those same
   numeric sizes (already a real "sold into" range, not re-derived); 31 and 33 are
   new rows and interpolate their height range from the neighbours either side.
   Benchmark this must hold (CLAUDE.md §1 Layer D): 185cm/82kg -> BMI 23.96, which
   sits in row 32's 23.75-24.25 band (82cm waist center = BMI 24.0 almost exactly) -
   row 31 also reaches height 185 but its weight band tops out at 81kg, so 32 is the
   first genuine match in chart order, same "32" this benchmark got before the
   FOX update.

   ROW ORDER IS LOAD-BEARING. calculateSize() keeps the FIRST genuinely-fitting row
   when no optional waist measurement narrows it (every candidate scores penalty 0,
   and the first 0 wins), so rows run smallest-first. A shopper on a boundary is
   offered the SMALLER size, matching how denim is actually bought - jeans stretch
   out, they do not shrink in.

   Columns mirror ADULT_PANTS_SIZE_CHART exactly (waist + hips, no chest/legs) so
   coreHwPenalty() and calculateSize()'s fine-tune pass work against it unmodified.
   minHips/maxHips ride along for a standards-comparable chart and for a future hip
   input; there is no hips field on the form today, so they contribute no penalty -
   FOX did not publish a hip figure either, so these keep the old chart's own
   waist+21cm offset, same as every prior row here. */
const ADULT_JEANS_WAIST_CHART = [
  { size: "28", minHeight: 155, maxHeight: 178, minWeight: 51, maxWeight: 69,  minWaist: 71, maxWaist: 73, minHips: 92,  maxHips: 94  },
  { size: "30", minHeight: 160, maxHeight: 180, minWeight: 58, maxWeight: 75,  minWaist: 76, maxWaist: 78, minHips: 97,  maxHips: 99  },
  { size: "31", minHeight: 163, maxHeight: 185, minWeight: 62, maxWeight: 81,  minWaist: 79, maxWaist: 81, minHips: 100, maxHips: 102 },
  { size: "32", minHeight: 165, maxHeight: 190, minWeight: 65, maxWeight: 88,  minWaist: 81, maxWaist: 83, minHips: 102, maxHips: 104 },
  { size: "33", minHeight: 168, maxHeight: 193, minWeight: 69, maxWeight: 93,  minWaist: 84, maxWaist: 86, minHips: 105, maxHips: 107 },
  { size: "34", minHeight: 170, maxHeight: 195, minWeight: 72, maxWeight: 97,  minWaist: 86, maxWaist: 88, minHips: 107, maxHips: 109 },
  { size: "36", minHeight: 172, maxHeight: 198, minWeight: 78, maxWeight: 105, minWaist: 91, maxWaist: 93, minHips: 112, maxHips: 114 },
  { size: "38", minHeight: 174, maxHeight: 200, minWeight: 83, maxWeight: 112, minWaist: 96, maxWaist: 98, minHips: 117, maxHips: 119 },
];

/**
 * Height/weight penalty for one chart row - the scoring kernel behind
 * calculateSize()'s match pass, shared by every chart (ZARA_SIZE_CHART,
 * CHILD_SIZE_CHART, and ADULT_PANTS_SIZE_CHART all carry the same four
 * min/maxHeight/min/maxWeight fields). Same ×2 per-cm/kg weighting as the
 * original adult matcher.
 * @returns {number}
 */
function coreHwPenalty(row, height, weight) {
  let pen = 0;
  if (height < row.minHeight) pen += (row.minHeight - height) * 2;
  if (height > row.maxHeight) pen += (height - row.maxHeight) * 2;
  if (weight < row.minWeight) pen += (row.minWeight - weight) * 2;
  if (weight > row.maxWeight) pen += (weight - row.maxWeight) * 2;
  return pen;
}

/* ══ THE STORE'S OWN SIZE CHART - decode, then overlay ══════════════════════════════
   WHAT ARRIVES: pear-widget.js reads the "Size guide" / "מדריך מידות" table off the PDP
   the shopper is standing on (extractSizeChart there) and encodes it compactly
   (encodeSizeChart there). It reaches us on ?garment_size_chart= at open and again on
   the PEAR_UPDATE_GARMENT correction.

   ── WHAT IT IS ALLOWED TO DO, AND THE LINE IT MUST NOT CROSS ─────────────────────────
   calculateSize() computes in two stages. The KERNEL is height + weight, scored by
   coreHwPenalty(), and it decides three things that all matter enormously:
     · which rows are candidates at all (the genuine-fit filter, penalty === 0),
     · currentBodyCategory / currentSizeCategory, and so the kids/adult go-live guard,
     · the overflow ceiling behind the "no size available" copy.
   The FINE-TUNE is the ×0.5 chest/waist/legs pass that only ever breaks a tie BETWEEN
   rows that already passed the kernel.

   A merchant's chart publishes body circumferences. It never publishes a height or a
   weight band. So applyStoreChartOverlay() writes the fine-tune columns and NOTHING
   ELSE - it does not even name minHeight/maxHeight/minWeight/maxWeight - and the blast
   radius of a bad scrape is bounded to "which of two adjacent sizes that both genuinely
   fit this body is shown", and only for a shopper who filled in an optional
   measurement. It cannot invent a candidate, remove one, flip adult↔child, or turn a
   match into a no-match. That bound is the entire reason reading merchant HTML is an
   acceptable input to this file at all. Do not widen it to the kernel "so the store's
   chart really counts" - the store's chart is evidence about CLOTH, ours is vetted
   evidence about BODIES, and the kernel is the half we vetted.

   Spec: docs/superpowers/specs/2026-09-17-storefront-size-chart-scraper.md */

/* The same limits as SIZE_CHART_CLAMPS in the reader above - which now lives in this file
   too, so the two can no longer drift across a file boundary, but both stay: that one
   refuses a COLUMN while reading a raw table, this one is the last gate before any
   sender's number (a raw chart, an old widget's v1 string, the message listener's
   correction) becomes a band the calculator scores against. Centimetres, post-conversion. */
const STORE_CHART_CLAMPS = {
  chest: [50, 200], waist: [40, 200], hips: [50, 200], legs: [40, 140],
};

/* ══ THE STORE'S CHART, READ - moved from widget/pear-widget.js on 2026-09-26 ══════════
   The widget used to READ the storefront's size-guide table itself and send the result;
   now it only COLLECTS (finds the candidate tables, reads each into a capped grid of
   trimmed strings, notes the unit its caption/container declares) and sends the grids
   raw. Everything that decides what a table means lives here, moved verbatim with the
   reasoning that shaped each rule: which header is a body measurement (and which only
   looks like one), word sizes, cell parsing, units, the clamps, monotonicity, orientation
   and which candidate wins. Proven identical to the in-widget reader - see this file's
   header. See parseStoreSizeChart() below for where it joins the old path.

   isPlausibleSizeToken() is a COPY: the widget keeps its own for the size-list scrape
   (CLAUDE.md §3 - edit together). */
function isPlausibleSizeToken(s) {
  var t = String(s == null ? "" : s).trim();
  if (!t || t.length > 5) return false;
  return /^\d{1,2}$/.test(t) || /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL)$/i.test(t);
}

/* Absolute sanity clamps, in CENTIMETRES, applied AFTER any inch conversion. These
   are not "typical" bands - they are the outer edge of humanly-possible, sized to
   catch a column that is really prices, weights, or a mis-read grid, while never
   refusing a real chart. A value outside these drops its COLUMN, not the chart. */
var SIZE_CHART_CLAMPS = {
  chest: { min: 50, max: 200 },
  waist: { min: 40, max: 200 },
  hips:  { min: 50, max: 200 },
  legs:  { min: 40, max: 140 }
};
/* A band wider than this is a mis-read: two adjacent cells parsed as one range. */
var SIZE_CHART_MAX_BAND_CM = 40;
/* Point-value charts ("M = 96cm") get a symmetric band, since the fine-tune pass
   scores DISTANCE OUTSIDE a band and a zero-width band would penalise every shopper
   whose chest isn't exactly the published number. 2cm each way is the half-step
   between adjacent sizes on every chart in this file. */
var SIZE_CHART_POINT_TOL_CM = 2;
/* Below this, a measurement column is inches, above it centimetres. A 38in chest and
   a 38cm chest are not both plausible garments - no adult chest chart is under 60cm
   and no inch chart is over 60in. Applied per COLUMN off that column's median, never
   per cell, so one mis-typed value cannot flip a whole column's units. */
var SIZE_CHART_INCH_MAX = 60;

/* Units. CM IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING: the Hebrew ס"מ contains
   a double-quote, which is also the inch mark, so an inch-first test reads every
   Hebrew centimetre chart as inches and divides the whole store by 2.54. */
var SIZE_CHART_CM_RE = /(?:\bcm\b|centimet|ס\s*["'״]?\s*מ|סנטימטר)/i;
var SIZE_CHART_IN_RE = /(?:inch(?:es)?|\bins?\b|["”″])/i;
function sizeChartUnitFromText(s) {
  var t = String(s == null ? "" : s);
  if (SIZE_CHART_CM_RE.test(t)) return "cm";
  if (SIZE_CHART_IN_RE.test(t)) return "in";
  return null;
}

/* Header cell -> the column key app.js's chart rows already use. English + Hebrew.
   DELIBERATELY NARROW. An unmapped column contributes nothing, which is safe; a
   WRONGLY mapped one silently re-bands a real measurement, which is not. Two
   specific exclusions worth their own line:
     · bare "length" / "אורך" is NOT mapped - on almost every chart that is the
       GARMENT's length (shoulder to hem), a property of the cloth, not of the body,
       and the fine-tune pass scores body measurements.
     · "inseam" is NOT mapped to legs. app.js's minLegs/maxLegs is the OUTSEAM
       convention (~0.575x height - see ZARA_SIZE_CHART's own comment); an inseam is
       ~0.45x and would read as a shopper 25cm outside every band. A different
       convention for the same body is a second column, never a substitute - the same
       call ADULT_JEANS_WAIST_CHART's comment records for waist-inch vs EU. */
var SIZE_CHART_MEASURE_KEYS = [
  ["chest", /(?:\bchest\b|\bbust\b|היקף\s*חזה|חזה)/i],
  ["waist", /(?:\bwaist\b|היקף\s*מותן|מותניים|מותן)/i],
  ["hips",  /(?:\bhips?\b|\bseat\b|היקף\s*אגן|ירכיים|אגן)/i],
  ["legs",  /(?:\boutseam\b|\boutside\s*leg\b|\bleg\s*length\b|\btrouser\s*length\b|אורך\s*רגל|אורך\s*מכנס)/i]
];
/* ⚠️ THE \b ON THE ENGLISH ALTERNATIVES IS LOAD-BEARING, AND THE HEBREW ONES
   DELIBERATELY LACK IT. JavaScript's \b is defined on [A-Za-z0-9_], so a Hebrew
   letter is never a word character and \bמותן\b can never match anything - adding it
   "for consistency" silently unmaps every Hebrew chart in the catalog. On the English
   side the opposite is true: without \b, `hips?` matches "Ship Weight" and a column
   of shipping weights is read as a hip ladder.

   AND A BODY WORD IS NOT ENOUGH ON ITS OWN. Real spec sheets carry columns like
   "Waist to Hem", "Half Chest" and "Chest Width" - garment geometry (a length, or a
   FLAT half-circumference) that happens to name a body part. Scoring a shopper's
   94cm waist against a 63cm hem drop, or against a half-chest that is half the number
   it looks like, is the expensive failure this whole file is built to avoid: a
   confident, plausible, WRONG chart rather than a visible absence. So a header that
   also names a garment dimension is refused outright, which costs nothing (the room
   keeps its vetted band for that column).

   NOT APPLIED TO `legs`, whose own patterns are garment-length-shaped by construction
   ("leg length", "trouser length", "אורך רגל") - vetoing them would unmap the key
   entirely. They are narrowly anchored instead. */
var SIZE_CHART_GARMENT_DIM_RE = new RegExp(
  "\\bto\\s+(?:hem|waist|chest|hip|cuff|knee)\\b|\\blength\\b|\\bdrop\\b|\\bopening\\b" +
  "|\\bhem\\b|\\bsleeve\\b|\\bshoulder\\b|\\binseam\\b|\\brise\\b|\\bacross\\b" +
  "|\\bhalf\\b|\\bflat\\b|\\bwidth\\b|\\bpit\\s*to\\s*pit\\b|\\bp2p\\b|1/2" +
  "|אורך|שרוול|כתף", "i");
function sizeChartMeasureKey(text) {
  var t = String(text == null ? "" : text);
  if (!t.trim()) return null;
  for (var i = 0; i < SIZE_CHART_MEASURE_KEYS.length; i++) {
    if (!SIZE_CHART_MEASURE_KEYS[i][1].test(t)) continue;
    var key = SIZE_CHART_MEASURE_KEYS[i][0];
    if (key !== "legs" && SIZE_CHART_GARMENT_DIM_RE.test(t)) return null;
    return key;
  }
  return null;
}

/* Word sizes -> the tokens app.js's ladders are spelled in. Without this, a chart
   headed "Small / Medium / Large" (which is most of them outside fast fashion)
   yields a size column isPlausibleSizeToken() rejects wholesale, and the chart is
   discarded for a spelling. */
var SIZE_CHART_WORD_SIZES = [
  [/^(?:xx[\s-]*small|2x[\s-]*small)$/i, "XXS"],
  [/^(?:x[\s-]*small|extra[\s-]*small)$/i, "XS"],
  [/^small$/i, "S"], [/^medium$/i, "M"], [/^large$/i, "L"],
  [/^(?:x[\s-]*large|extra[\s-]*large)$/i, "XL"],
  [/^(?:xx[\s-]*large|2x[\s-]*large)$/i, "XXL"],
  [/^(?:xxx[\s-]*large|3x[\s-]*large)$/i, "XXXL"]
];

/* The size CELL, which is messier than the picker values isPlausibleSizeToken() was
   written for: "M / 38", "L (EU 40)", "Medium". Takes the leading token, maps the
   word forms, and then hands the result to the SAME plausibility test the size
   scrape already uses - so the two can never disagree about what a size looks like.
   @returns {string} the uppercased token, or "" when this is not a size cell */
function sizeChartSizeToken(raw) {
  var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
  if (!t) return "";
  t = t.split(/[\/|(,]/)[0].trim();          // "L (EU 40)" -> "L", "M / 38" -> "M"
  for (var i = 0; i < SIZE_CHART_WORD_SIZES.length; i++) {
    if (SIZE_CHART_WORD_SIZES[i][0].test(t)) return SIZE_CHART_WORD_SIZES[i][1];
  }
  t = t.toUpperCase();
  return isPlausibleSizeToken(t) ? t : "";
}

/* One measurement cell -> { min, max, unit } in the cell's OWN units, or null.
   Handles the four forms that actually ship: a point value ("96"), a range
   ("92-96", "92 - 96", "92 to 96", "92/96"), a unit-suffixed value ("96 cm", 37.5in)
   and a dash/blank placeholder ("-", "", ""). Decimal comma ("96,5") is accepted;
   a thousands separator is not a thing in a chart of body centimetres.
   PURE - no DOM, no globals - so the suite can exercise it directly. */
function parseMeasurementCell(raw) {
  var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
  if (!t) return null;
  var unit = sizeChartUnitFromText(t);
  /* Numbers are pulled AFTER the unit test, and the inch mark is stripped first, so
     the quote in 37.5" cannot be mistaken for part of the number. */
  var nums = t.replace(/[”″"']/g, " ").match(/\d+(?:[.,]\d+)?/g);
  if (!nums || !nums.length) return null;
  var a = parseFloat(String(nums[0]).replace(",", "."));
  var b = nums.length > 1 ? parseFloat(String(nums[1]).replace(",", ".")) : a;
  if (!isFinite(a) || !isFinite(b)) return null;
  /* Stored min-first. A chart printed "96-92" is a typo, not a reason to drop a row. */
  return { min: Math.min(a, b), max: Math.max(a, b), unit: unit };
}

/* ORIENTATION. Charts ship both ways round: sizes down the first column with
   measurement names across the header (the common case), or sizes across the header
   with measurement names down the first column. Decided by COUNTING plausible size
   tokens on each axis rather than by guessing from the header text - a chart with
   neither axis full of sizes reads as "not a size chart" instead of as a transposed
   one, which is what keeps a price table from being read sideways. */
function sizeChartOrient(grid) {
  if (!grid.length) return grid;
  var down = 0, across = 0, i;
  for (i = 1; i < grid.length; i++) if (sizeChartSizeToken(grid[i][0])) down++;
  for (i = 1; i < (grid[0] || []).length; i++) if (sizeChartSizeToken(grid[0][i])) across++;
  if (across <= down) return grid;
  var width = 0;
  for (i = 0; i < grid.length; i++) width = Math.max(width, grid[i].length);
  var out = [];
  for (var c = 0; c < width; c++) {
    var line = [];
    for (var r = 0; r < grid.length; r++) line.push(grid[r][c] == null ? "" : grid[r][c]);
    out.push(line);
  }
  return out;
}

function sizeChartCap(key) { return key.charAt(0).toUpperCase() + key.slice(1); }

/* One column of parsed cells -> centimetre bands, or null to DROP THE COLUMN.
   Column-level, never cell-level, because units, monotonicity and the clamp are all
   properties of the ladder rather than of any one value - and dropping a column
   leaves the rest of the chart (and app.js's own bands for that measurement) intact,
   which is the whole reason this refuses a column instead of the chart. */
function sizeChartColumnToCm(col, tableUnit) {
  var i, v, mids = [], explicit = null;
  for (i = 0; i < col.vals.length; i++) {
    v = col.vals[i];
    if (!v) continue;
    if (v.unit) explicit = explicit || v.unit;
    mids.push((v.min + v.max) / 2);
  }
  if (mids.length < 2) return null;                 // a column of one value is noise

  /* Unit, strongest evidence first: a cell said so, the header said so, the table's
     caption/container said so, and only then the magnitude tier. */
  var unit = explicit || col.unit || tableUnit;
  if (!unit) {
    var sorted = mids.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    unit = median < SIZE_CHART_INCH_MAX ? "in" : "cm";
  }
  var factor = unit === "in" ? 2.54 : 1;
  var clamp = SIZE_CHART_CLAMPS[col.key];

  var out = [], seen = [];
  for (i = 0; i < col.vals.length; i++) {
    v = col.vals[i];
    if (!v) { out.push(null); continue; }
    var min = v.min * factor, max = v.max * factor;
    if (min === max) { min -= SIZE_CHART_POINT_TOL_CM; max += SIZE_CHART_POINT_TOL_CM; }
    if (!(min >= clamp.min && max <= clamp.max)) return null;   // out of human range
    if (max - min > SIZE_CHART_MAX_BAND_CM) return null;        // two cells read as one
    out.push({ min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 });
    seen.push((min + max) / 2);
  }

  /* MONOTONICITY IS THE REAL FILTER, and it is direction-agnostic on purpose: a
     chart may be printed largest-first, and the room keys rows by TOKEN so print
     order is irrelevant to it. What a real ladder can never do is wander - a chest
     that grows, shrinks and grows again across S/M/L is a column of prices, stock
     counts or garment lengths that happened to sit under a "chest" header. Ties are
     allowed (adjacent sizes really do share a band on some charts). */
  var up = true, downward = true;
  for (i = 1; i < seen.length; i++) {
    if (seen[i] < seen[i - 1]) up = false;
    if (seen[i] > seen[i - 1]) downward = false;
  }
  if (!up && !downward) return null;
  return out;
}

/* Grid (already oriented sizes-as-rows) -> the validated rows, or null.
   tableUnit is the unit named by the table's caption/container, used only when
   neither the cells nor the header say.
   PURE apart from the grid it is handed, so the suite drives it with literals. */
function sizeChartFromGrid(grid, tableUnit) {
  if (!grid || grid.length < 3) return null;      // header + at least two size rows
  var header = grid[0], cols = [], i, r;
  for (i = 1; i < header.length; i++) {
    var key = sizeChartMeasureKey(header[i]);
    /* FIRST HEADER WINS on a duplicate key. A chart with two "waist" columns is
       usually body-waist followed by garment-waist; the body one is printed first by
       every convention this codebase has seen, and picking the later one silently
       re-bands the shopper against the cloth. */
    if (key && !sizeChartHasKey(cols, key)) {
      cols.push({ key: key, idx: i, unit: sizeChartUnitFromText(header[i]), vals: [] });
    }
  }
  if (!cols.length) return null;

  var sizes = [];
  for (r = 1; r < grid.length; r++) {
    var token = sizeChartSizeToken(grid[r][0]);
    if (!token) continue;                          // a notes row, a unit toggle row
    if (sizes.indexOf(token) !== -1) continue;     // duplicate size row - first wins
    sizes.push(token);
    for (i = 0; i < cols.length; i++) {
      cols[i].vals.push(parseMeasurementCell(grid[r][cols[i].idx]));
    }
  }
  if (sizes.length < 2) return null;

  var rowsOut = [];
  for (i = 0; i < sizes.length; i++) rowsOut.push({ size: sizes[i] });
  var kept = 0;

  for (i = 0; i < cols.length; i++) {
    var col = cols[i], band = sizeChartColumnToCm(col, tableUnit);
    if (!band) continue;
    for (r = 0; r < rowsOut.length; r++) {
      if (!band[r]) continue;
      rowsOut[r]["min" + sizeChartCap(col.key)] = band[r].min;
      rowsOut[r]["max" + sizeChartCap(col.key)] = band[r].max;
    }
    kept++;
  }
  return kept ? rowsOut : null;
}

function sizeChartHasKey(cols, key) {
  for (var i = 0; i < cols.length; i++) if (cols[i].key === key) return true;
  return false;
}

/* ── THE RAW WIRE - what a current widget sends ──────────────────────────────────
       raw;<candidate>␞<candidate>…
       candidate ::= <source>␟<bonus>␟<unit: "cm" | "in" | "">␟<grid>
       grid      ::= rows joined by ␝, each row's cells joined by ␜
   (␜␝␞␟ are U+001C-U+001F; the widget replaces any in a cell with a space.) Candidates
   arrive in the widget's own order - platform containers first (bonus 6), then every
   other table (bonus 0) - and are bounded again here with the widget's own caps, because
   this body is shopper-controlled. encodeRawSizeChart() in pear-widget.js is the encoder
   (CLAUDE.md §3). */
const RAW_CHART_PREFIX = "raw;";
const RAW_CHART_MAX_CHARS = 262144;
const RAW_CHART_MAX_TABLES = 8, RAW_CHART_MAX_ROWS = 40, RAW_CHART_MAX_COLS = 12;
function decodeRawSizeChart(s) {
  const out = [];
  if (typeof s !== "string" || !s.startsWith(RAW_CHART_PREFIX) || s.length > RAW_CHART_MAX_CHARS) return out;
  for (const part of s.slice(RAW_CHART_PREFIX.length).split("\u001e")) {
    if (out.length >= RAW_CHART_MAX_TABLES) break;
    const f = part.split("\u001f");
    if (f.length !== 4) continue;
    const bonus = Number(f[1]);
    const grid = [];
    for (const row of f[3].split("\u001d")) {
      if (grid.length >= RAW_CHART_MAX_ROWS) break;
      grid.push(row.split("\u001c").slice(0, RAW_CHART_MAX_COLS));
    }
    out.push({
      source: /^[a-z]{1,16}$/.test(f[0]) ? f[0] : "generic",
      bonus: Number.isFinite(bonus) ? Math.max(0, Math.min(6, bonus)) : 0,
      unit: f[2] === "cm" || f[2] === "in" ? f[2] : null,
      grid,
    });
  }
  return out;
}

/* THE PAGE'S OWN SIZE CHART, or null - the reading half of the widget's old
   extractSizeChart(), unchanged: every candidate is read, scored by how many rows carry a
   measurement plus its container bonus, and the strictly best one wins.
   @returns {{unit:"cm", source:string, rows:Array<object>}|null} */
function readStoreSizeChart(candidates) {
  var best = null, bestScore = 0, i, j;
  for (i = 0; i < candidates.length; i++) {
    var cand = candidates[i], rows;
    try {
      rows = sizeChartFromGrid(sizeChartOrient(cand.grid), cand.unit);
    } catch (e) { continue; }
    if (!rows) continue;
    var measured = 0;
    for (j = 0; j < rows.length; j++) {
      if (rows[j].minChest != null || rows[j].minWaist != null ||
          rows[j].minHips != null || rows[j].minLegs != null) measured++;
    }
    var score = cand.bonus + measured;
    if (score > bestScore) { bestScore = score; best = { source: cand.source, rows: rows }; }
  }
  return best ? { unit: "cm", source: best.source, rows: best.rows } : null;
}

/* ── THE V1 WIRE FORMAT, now internal ────────────────────────────────────────────
       <unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:...
       each measurement ::= "min-max", or "" when this chart doesn't publish it
   e.g. cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::

   This was the widget's wire format until the reader moved here; widget builds from
   before that (cached on storefronts) still send it, so parseStoreSizeChart() below keeps
   decoding it. A raw chart from a current widget is read by readStoreSizeChart() and
   encoded HERE, then takes exactly the same decode - so both senders share one path to
   the overlay, and the reader's output is byte-for-byte what the widget used to send.
   @returns {string} "" when there is nothing to send */
function encodeSizeChart(chart) {
  if (!chart || !chart.rows || !chart.rows.length) return "";
  function band(row, key) {
    var lo = row["min" + key], hi = row["max" + key];
    return (typeof lo === "number" && typeof hi === "number" && isFinite(lo) && isFinite(hi))
      ? lo + "-" + hi : "";
  }
  var parts = [];
  for (var i = 0; i < chart.rows.length; i++) {
    var r = chart.rows[i];
    /* A size token with no measurement at all is dropped rather than shipped as
       "M:::" - the room would index it, find nothing to overlay, and clone a row for
       no reason. */
    var cells = [band(r, "Chest"), band(r, "Waist"), band(r, "Hips"), band(r, "Legs")];
    if (!cells.join("")) continue;
    parts.push(r.size + ":" + cells.join(":"));
  }
  if (!parts.length) return "";
  return (chart.unit || "cm") + ";" + (chart.source || "generic") + ";" + parts.join("|");
}

/* The v1 string any sender's chart comes down to: a raw chart is read and encoded, a v1
   string passes through. "" when a raw chart holds nothing readable. */
function storeChartWire(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s.startsWith(RAW_CHART_PREFIX)) return s;
  try { return encodeSizeChart(readStoreSizeChart(decodeRawSizeChart(s))); } catch { return ""; }
}

/* The wire format, decoded:
       <unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:...
       each measurement ::= "min-max", or "" when the chart doesn't publish it
   e.g. cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::

   The encoder is encodeSizeChart() above (it moved here with the reader); a raw chart
   from a current widget is converted to this format first by storeChartWire(), so there
   is one decode for every sender. test/size-chart-overlay.test.mjs round-trips both.

   REFUSES A NON-"cm" UNIT OUTRIGHT rather than converting. The widget converts to
   centimetres before encoding, so "in" on the wire means one of the two sides has
   drifted - and a chart converted twice (or not at all) is the one failure mode here
   that produces plausible, confident, WRONG bands instead of a visible absence.
   @param {string|Array|null|undefined} raw
   @returns {Array<object>} rows, or [] for anything unreadable */
function parseStoreSizeChart(raw) {
  try {
    /* An already-parsed array is accepted so a future sender (a server-side cache, a
       test) can hand rows straight over without a round trip through the string. */
    if (Array.isArray(raw)) return raw.filter((r) => r && typeof r === "object" && r.size);
    if (typeof raw !== "string") return [];
    const s = storeChartWire(raw);   // a raw chart is read and encoded first - one decode for all senders
    if (!s) return [];
    const head = s.split(";");
    if (head.length < 3) return [];
    if (head[0].trim().toLowerCase() !== "cm") return [];
    const body = head.slice(2).join(";");

    const band = (tok) => {
      const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(tok || "").trim());
      if (!m) return null;
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
      return { min: lo, max: hi };
    };

    const out = [], seen = new Set();
    for (const chunk of body.split("|")) {
      const cells = chunk.split(":");
      /* parseSizeList() normalises exactly as every other size reader in this file does
         (trim + uppercase) - CLAUDE.md §2.2's discipline applied to size tokens: "l",
         " L " and "L" are one size, and a raw compare would silently overlay nothing. */
      const size = parseSizeList([cells[0]])[0];
      if (!size || seen.has(size)) continue;
      const row = { size };
      const keys = ["Chest", "Waist", "Hips", "Legs"];
      let any = false;
      for (let i = 0; i < keys.length; i++) {
        const b = band(cells[i + 1]);
        if (!b) continue;
        row["min" + keys[i]] = b.min;
        row["max" + keys[i]] = b.max;
        any = true;
      }
      if (!any) continue;          // a size with no measurement overlays nothing
      seen.add(size);
      out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}

/* THE OVERLAY. Returns a NEW array with the store's fine-tune bands written over the
   matching rows of `baseChart`; `baseChart` itself is never mutated, and is returned
   BY REFERENCE (not a copy) whenever there is nothing to apply.

   FOUR RULES, each of which is a refusal:
     1. Rows are matched by normalised size TOKEN. A store row naming a size the base
        chart doesn't have is ignored - bestSize can only ever be one of the base
        chart's own rows, so a row nothing can select is not worth carrying.
     2. A column is written only when the store supplied BOTH bounds, both are finite,
        min <= max, and both survive STORE_CHART_CLAMPS. A partial chart (chest only)
        leaves waist and legs on ours.
     3. A column is written only when the BASE ROW ALREADY HAS IT. This is "refine",
        not "extend": the store may not introduce a measurement dimension the vetted
        chart deliberately does not score. ZARA_SIZE_CHART has chest/waist/legs and no
        hips; ADULT_PANTS_SIZE_CHART has waist/hips and no chest - each keeps its own
        shape, and the overlay can only ever CHANGE a band, never add or remove one.
     4. Height and weight are not writable. They are not read, not copied field by
        field, not named anywhere below - the row is spread wholesale and only the four
        fine-tune keys are overwritten, so there is no path by which a future edit
        "accidentally" reaches the kernel.
   Anything unexpected - a non-array, an empty match, a throw - returns `baseChart`.
   @param {Array<object>} baseChart   ZARA_SIZE_CHART / a pants chart, untouched
   @param {Array<object>} storeRows   parseStoreSizeChart() output
   @returns {Array<object>} */
function applyStoreChartOverlay(baseChart, storeRows) {
  try {
    if (!Array.isArray(baseChart) || !baseChart.length) return baseChart;
    if (!Array.isArray(storeRows) || !storeRows.length) return baseChart;

    const byToken = new Map();
    for (const r of storeRows) {
      const token = parseSizeList([r && r.size])[0];
      if (!token || byToken.has(token)) continue;   // first spelling of a size wins
      byToken.set(token, r);
    }
    if (!byToken.size) return baseChart;

    let touched = 0;
    const out = baseChart.map((row) => {
      const token = parseSizeList([row && row.size])[0];
      const store = token ? byToken.get(token) : undefined;
      if (!store) return row;                        // pass through BY REFERENCE
      let next = null;
      for (const cap of ["Chest", "Waist", "Hips", "Legs"]) {
        if (typeof row["min" + cap] !== "number" || typeof row["max" + cap] !== "number") continue;
        const lo = store["min" + cap], hi = store["max" + cap];
        if (typeof lo !== "number" || typeof hi !== "number") continue;
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) continue;
        const clamp = STORE_CHART_CLAMPS[cap.toLowerCase()];
        if (!clamp || lo < clamp[0] || hi > clamp[1]) continue;
        if (!next) next = { ...row };
        next["min" + cap] = lo;
        next["max" + cap] = hi;
      }
      if (next) touched++;
      return next || row;
    });
    if (!touched) return baseChart;
    console.log("[PEAR] store size chart overlaid on", touched, "of", baseChart.length,
      "chart row(s) - fine-tune bands only, height/weight kernel untouched");
    return out;
  } catch (e) {
    /* CLAUDE.md §2.5 - the default global matrix is the documented safe state, and it
       is exactly what shipped before this feature existed. */
    console.warn("[PEAR] store size-chart overlay failed, keeping the default matrix:",
      e?.message || e);
    return baseChart;
  }
}

/**
 * The shopper's OWN scale, derived with NO garment constraint applied.
 *
 * WHY THIS IS NOT currentSizeCategory. calculateSize() deliberately forces
 * `adultFits = []` once the garment resolves to kids, so a kids garment can never
 * recommend an adult size. For the 180cm/80kg shopper in the bug report that leaves no
 * candidate in EITHER chart (the child chart ends at 176cm/60kg), so currentSizeCategory
 * lands on null - meaning a guard keyed on `currentSizeCategory === "adult"` would go
 * quiet again the moment the product-size fix made the garment resolve correctly. The
 * guard has to read a category that the garment cannot influence. This is that value.
 *
 * NOTE ON THE METHOD: chart-fit, never a raw height/weight threshold. pickSizeCategory()
 * previously recorded why - a threshold guess "routed petite adults (150cm/50kg -> kids
 * 14) and slim tall adults (174cm/56kg -> kids 18) into children's sizing with no way
 * for them to correct it". The mirror of that mistake here would block a 13-year-old
 * off the kids items they actually need. Adult wins genuine ties, matching the same
 * convention calculateSize() already uses for the overlap zone.
 * @returns {"adult"|"child"|null}
 */
function userBodyCategory(height, weight) {
  if (!height || !weight) return null;
  if (ZARA_SIZE_CHART.some((row) => coreHwPenalty(row, height, weight) === 0)) return "adult";
  if (CHILD_SIZE_CHART.some((row) => coreHwPenalty(row, height, weight) === 0)) return "child";
  return null;
}

/* ══ THE PRODUCT - which chart, and who it is for ═══════════════════════════════════
   Moved from fitting-room/app.js on 2026-09-26 (the second pass, after the charts): every
   rule that reads the PRODUCT rather than the body - kids-only / adult-only, is it worn
   on the lower body, is its own size list the EU ladder or a waist run, does a letter run
   veto a waist chart. The browser sends the raw evidence (sanitizeProductEvidence() below;
   app.js sizeProductEvidence() builds it) and productVerdict() decides.

   MOVED, NOT REWRITTEN, with two deliberate edits. isBottomsGarment() - the browser's
   garment-region classifier, shared with the prompt pipeline - stays in the browser, and
   its verdict arrives as item.bottoms (true / false / null). The three places the rules
   below consulted it now read that field, with the old "typeof isBottomsGarment" guard's
   meaning intact: null is "no verdict", which vetoes nothing and proves nothing. Proven
   against the in-browser functions over the corpus recorded in this file's header. */

/* ── APOSTROPHE NORMALISATION - one Hebrew word, four codepoints ─────────────────
   THE BUG THIS CLOSES: a jeans product titled "ג'ינס סקיני" was fitted against the
   adult LETTER chart, because the keyword lists in this file spell the geresh two
   ways (U+0027 ASCII apostrophe, U+05F3 Hebrew geresh) and the storefront's CMS had
   typed a third - U+2019 RIGHT SINGLE QUOTATION MARK, which is what every "smart
   quotes" editor substitutes automatically as you type. The word is identical to a
   reader and unequal to `String.prototype.includes`, so every pants tier abstained
   and the shopper was offered "L" on a product whose picker only shows numbers.

   Adding the two curly variants to each list was the obvious fix and the wrong one:
   the geresh appears in ג'ינס, ז'קט, קפוצ'ון, דגמ"ח and more, so it multiplies every
   list by four and a later contributor adding one word has to remember all four
   spellings. Normalising the HAYSTACK once, at the door, means each list keeps ONE
   spelling of each word.

   U+05F4 / U+201C-D (the double geresh/gershayim, as in דגמ"ח) are folded too, for
   exactly the same reason and by the same editors.

   Kept in lockstep with normApos() in widget/pear-widget.js and _normApos() in
   fitting-room/app.js (which still classifies garment titles) - see CLAUDE.md §3.
   Whichever copy is wrong is the one that wins, because the widget's category
   verdict is explicit and therefore outranks this file's own classifier.
 * @param {unknown} s
 * @returns {string} the same text with every apostrophe/quote variant folded to
 *   ASCII ' and ", lower-cased. Never throws; non-strings become "".
 */
function _normApos(s) {
  return String(s == null ? "" : s)
    .replace(/[ʼ׳‘’′]/g, "'")
    .replace(/[״“”″]/g, '"')
    .toLowerCase();
}

/* Adult letter scales, incl. the 2XL/3XL spellings storefronts use interchangeably
   with XXL/XXXL. Presence of ANY of these is proof the product is not kids-only.
   Copy of ADULT_ALPHA_SIZES in fitting-room/app.js, which categoryFromSizeRun() still
   reads - CLAUDE.md §3. */
const ADULT_ALPHA_SIZES = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL", "2XL", "3XL", "4XL", "5XL",
]);

/* The EU adult pants ladder - ADULT_PANTS_SIZE_CHART's own six sizes. */
const ADULT_PANTS_NUMERIC_SIZES = new Set(ADULT_PANTS_SIZE_CHART.map((row) => row.size));

/* KIDS/ADULT SIZE-CATEGORY GUARD.

   ── WHY THIS READS THE PRODUCT'S REAL SIZE LIST, AND NOT JUST THE CLASSIFIER ──────
   The first version of this guard keyed entirely on resolvedGarmentAgeGroup() - the
   per-product kids/adult verdict from Gemini's image classification - and it FAILED IN
   PRODUCTION on a FOX Spiderman tee sold only in kids 8/10/12/14/16: an adult
   180cm/80kg profile sailed straight into the fitting room, with an adult XS-3XL size
   selector rendered over a product that has no adult size at all.

   That failure was not a coding slip, it was the wrong source of truth. server.js's own
   classifier prompt INSTRUCTS the model to abstain on exactly this kind of item:
     · "Flat-lay / packshot with NO model and NO visible size label ... answer
        'uncertain' - do not guess from styling alone."
     · "Do NOT infer age group from color, PRINT STYLE, or price positioning alone"
     · "below 0.7 you must answer 'uncertain'"
   A character-print packshot hits all three, so "uncertain" is the CORRECT answer from
   that model - and "uncertain" can never block. Meanwhile the storefront was displaying
   8/10/12/14/16 the entire time: deterministic ground truth, sitting unread.

   So the ordering below is deliberate and load-bearing: when the host page gives us a
   real size list, THAT decides, in both directions (it can also clear a wrong "kids"
   verdict). The classifier is consulted only when no size list reached us at all - a
   probabilistic signal designed to abstain must never outrank a deterministic one. */

/* The kids numeric ladder, per the retail convention this codebase already encodes in
   CHILD_SIZE_CHART (which runs 8-18; 2-6 are included here because a product can list
   them even though we don't size-match against those rows). Adult numeric systems -
   waist/chest 28-44 - deliberately fall OUTSIDE this set, so "32" never reads as kids. */
const KIDS_NUMERIC_SIZES = new Set(["2", "4", "6", "8", "10", "12", "14", "16", "18"]);

/**
 * @param {string[]|string|null} sizes - the host product's OWN size list, when known
 * @param {"kids"|"adult"|"uncertain"|undefined} garmentAgeGroup - classifier fallback only
 * @returns {boolean} true only when the product is CONFIDENTLY kids-only.
 */
function isKidsProduct(sizes, garmentAgeGroup) {
  const list = parseSizeList(sizes);
  if (list.length) {
    // Any adult letter size present -> the product serves adults, whatever else it lists.
    if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return false;
    // Otherwise: kids only if EVERY token is a kids numeric. A mixed or unrecognised
    // list (an adult 28-44 waist run, a one-size product, a store's own odd labels)
    // is NOT confidently kids - and an unconfident verdict must never block a sale.
    return list.every((s) => KIDS_NUMERIC_SIZES.has(s));
  }
  return garmentAgeGroup === "kids";
}

/**
 * Mirror of isKidsProduct - true only when the product is CONFIDENTLY adult.
 * Needed because the childFits guard was zeroing only on garmentAgeGroup ===
 * "adult" (the classifier verdict), never on the real size list - so an adult
 * product with a real S/M/L list but an "uncertain" classifier read (common:
 * the classifier is instructed to abstain on packshots with no model) let a
 * child-bodied shopper through to a genuine CHILD_SIZE_CHART match instead of
 * being blocked, same class of bug isKidsProduct itself was written to fix.
 * @param {string[]|string|null} sizes
 * @param {"kids"|"adult"|"uncertain"|undefined} garmentAgeGroup
 * @returns {boolean}
 */
function isAdultProduct(sizes, garmentAgeGroup) {
  const list = parseSizeList(sizes);
  if (list.length) {
    if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return true;
    // Not every token kids-numeric -> an adult numeric run (e.g. 28-44 waist)
    // or unrecognised labels, treated as adult, mirroring isKidsProduct's
    // "not confidently kids" default for a deterministic size list.
    return !list.every((s) => KIDS_NUMERIC_SIZES.has(s));
  }
  return garmentAgeGroup === "adult";
}

/**
 * Whether the product's OWN size list is confidently the EU pants ladder
 * (ADULT_PANTS_SIZE_CHART's own six values: 36/38/40/42/44/46) - same "every token or
 * abstain" confidence rule isKidsProduct()/isAdultProduct() use for their own charts.
 * A letter scale, a kids numeric run, anything outside those six values, or no list at
 * all is NOT confidently EU-numeric, and defers to pantsChartForSizes()'s waist-inch
 * branch (or ZARA_SIZE_CHART, if the run isn't pants-numeric at all) - never a guess,
 * matching this file's "an unconfident verdict must not outrank" rule (CLAUDE.md §2.5).
 *
 * NARROWED BACK TO EXACT EU MEMBERSHIP - it was briefly widened to accept ANY plausible
 * all-numeric adult-bottoms run (24-48), which is what "THE 26-40 REPORT" below used to
 * describe. That widening shipped its own real bug once ADULT_JEANS_WAIST_CHART
 * (pantsChartForSizes()'s other branch) existed: a genuine US/UK waist-inch run like
 * 28-36 also sits inside 24-48, so the widened check claimed it for the EU chart too -
 * and pantsChartForSizes()'s own EU-first precedence then handed a real FOX waist-inch
 * product a chest-banded EU size (a 185cm/82kg shopper got EU "36" off a snap-to-list
 * guess instead of the FOX chart's genuine "32"). isWaistInchSizeRun() below already
 * covers the SAME 24-48 window this function used to - narrowing this one back to exact
 * EU membership is what lets pantsChartForSizes()'s "EU claims its own run, waist-inch
 * takes everything else" precedence actually mean something. THE 26-40 REPORT ITSELF
 * STAYS FIXED: that run no longer falls back to letters, it now resolves through
 * isWaistInchSizeRun() to the waist-inch chart instead of being force-fit to EU - see
 * test/numeric-pants-sizing.test.mjs for the current, chart-precise coverage of that
 * exact scenario.
 * @param {string[]|string|null} sizes
 * @returns {boolean}
 */
function isAdultPantsProduct(sizes) {
  const list = parseSizeList(sizes);
  if (!list.length) return false;
  // A letter size proves the product ships in the alpha scale - never treat it as
  // numeric-pants no matter what else the list contains (same precedent
  // isKidsProduct()/isAdultProduct() use for ADULT_ALPHA_SIZES).
  if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return false;
  return list.every((s) => ADULT_PANTS_NUMERIC_SIZES.has(s));
}

/**
 * THE VETO that stops a letter-sized garment being pulled onto a numeric pants
 * chart - the counterpart to isAdultPantsProduct()/isWaistInchSizeRun() above, which
 * establish POSITIVE numeric evidence. This establishes positive ALPHA evidence, and
 * outranks it: isPantsProduct() correctly calls a pair of sweatpants sold S/M/L a
 * lower-body garment from its TITLE alone (no numeric evidence needed), and without
 * this veto that verdict fed straight into pantsChartForSizes()'s "no confidently-
 * numeric run" default - ADULT_JEANS_WAIST_CHART, the ladder written for 28/30/32
 * jeans whose picker scrapes to nothing. A sports-pants shopper was quoted a bare
 * waist-inch number for a product whose picker only ever offers S/M/L.
 *
 * TWO TIERS, SAME "every token or abstain" confidence rule as isAdultPantsProduct():
 *   1. the product's OWN size run   free, synchronous, THIS visit's own scrape -
 *                                    checked first because live evidence always
 *                                    outranks a remembered one.
 *   2. the cached size-run-type     a PREVIOUS visit's scrape of the SAME product,
 *                                    consulted only when this visit's list is empty
 *                                    (a JS-rendered picker that hasn't hydrated yet) -
 *                                    see pendingSizeRunType's own comment for the
 *                                    full round trip.
 *
 * NEVER GUESSES: an empty/mixed size list with no cached hint returns false, which
 * simply leaves the existing numeric-chart default in place for products this can't
 * yet speak to (CLAUDE.md §2.5).
 * @param {string[]|string|null} sizes - the host product's OWN size list, THIS visit
 * @param {"numeric"|"alpha"|"unknown"|undefined} sizeRunType - cached fallback
 * @returns {boolean}
 */
function isAlphaSizeRun(sizes, sizeRunType) {
  const list = parseSizeList(sizes);
  if (list.length) return list.every((s) => ADULT_ALPHA_SIZES.has(s));
  return sizeRunType === "alpha";
}

/**
 * The chart-selection gate calculateSize() reads: true only when the product is
 * confidently adult-pants-numeric AND (whenever a real item is already known) it is
 * confidently a bottoms garment. The `item` check only ever narrows a numeric match
 * that turns out to belong to a known non-bottoms item (e.g. an EU-numbered top run -
 * see categoryFromSizeRun()'s own note that an EU run opening at 34/36 is genuinely
 * ambiguous with tops) - it can never widen a list that isn't pants-numeric in the
 * first place. `item` is usually unavailable here (calculateSize() runs on Screen 1,
 * before activeItem exists - see resolvedGarmentSizes()'s comment), so the sizing
 * evidence alone decides in the common case, exactly like isKidsProduct()/
 * isAdultProduct() already do with no item at all.
 * @param {string[]|string|null} sizes
 * @param {object|null|undefined} item - the active item's facts, when one exists (see
 *   sanitizeProductEvidence()). item.bottoms is the browser's isBottomsGarment() verdict,
 *   null when it had none - which vetoes nothing, exactly as a missing classifier did.
 * @returns {boolean}
 */
function isAdultNumericPantsGarment(sizes, item) {
  if (!isAdultPantsProduct(sizes)) return false;
  if (item && item.bottoms === false) return false;
  return true;
}
/* ── TIER 1 of isPantsProduct(): the size run as a WAIST measurement ─────────────
   A run of plain integers in 24-48 is a waist in inches. Nothing else in apparel is
   numbered that way: a kids run is 2-18, a shirt NECK run is 14-18, and both fall
   below the floor; a shoe run and an EU dress run overshoot or carry letters.

   SEPARATE FROM categoryFromSizeRun() (fitting-room/app.js), DELIBERATELY, and they are not
   interchangeable. That one answers "can this run PROVE a bottom?" for the prompt
   pipeline and therefore also demands the run OPEN at 32 or lower, because an EU
   women's top run opening at 34/36 is genuinely ambiguous with tops. This one
   answers the narrower question "which adult CHART does this run belong to?", and
   it is reached only after the EU ladder has already claimed its own runs
   (pantsChartForSizes below), so the ambiguous 34/36-opening case has been taken
   off the table before this ever sees it. Folding the two together would either
   re-open that ambiguity or reject legitimate large-waist runs (34/36/38).

   ABSTAINS RATHER THAN GUESSES, on the same "every token or nothing" rule
   isKidsProduct()/isAdultPantsProduct() use: any adult letter, any non-integer
   token (one-size, "36R", a store's own labels) or any token outside the ladder
   and the whole run yields nothing, which simply leaves the letter chart in place.
   @param {string[]|string|null|undefined} sizes
   @returns {boolean} */
const WAIST_INCH_FLOOR = 24, WAIST_INCH_CEIL = 48;
function isWaistInchSizeRun(sizes) {
  const list = parseSizeList(sizes);
  if (!list.length) return false;
  if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return false;
  if (!list.every((s) => /^\d{1,2}$/.test(s))) return false;
  return list.every((s) => {
    const n = Number(s);
    return n >= WAIST_INCH_FLOOR && n <= WAIST_INCH_CEIL;
  });
}

/* ── TIER 2 vocabulary: the garment noun, in both languages ──────────────────────
   Kept in step with GARMENT_CATEGORY_KEYWORDS.bottom and BOTTOMS_TOKENS in
   fitting-room/app.js - three separate mechanisms over one vocabulary, which is the
   convention app.js already records for the other two ("a word added to only one of
   them is a miss on whichever path the item happens to take").

   IT IS A SEPARATE COPY ON PURPOSE, not an oversight: those two classify garments in the
   browser, and this list is the server's. (It was a separate copy even while it lived in
   app.js, where test harnesses executed the sizing region as a standalone slice that
   stopped before the garment-category region - CLAUDE.md §2.6/§2.7.)

   Hebrew entries are STEMS (Hebrew inflects by suffix - מכנס covers מכנסי/מכנסיים);
   English entries are word-bounded, because English compounds the other way and a
   stem match on "short" swallows "short sleeve" and turns every tee into shorts.

   ALREADY APOSTROPHE-NORMALISED: every entry here is matched only against _normApos()
   output, so each Hebrew word carries ONE spelling of its geresh (ASCII U+0027) and
   the U+05F3/U+2018/U+2019 variants fold onto it at the door. */
const PANTS_TITLE_STEMS_HE = [
  "מכנס", "ג'ינס", "ברמודה", "שורטס", "שורט", "חצאי", "טייץ", "טייצ", "לגינ", "סווטפנט",
];
const PANTS_TITLE_WORDS_EN = [
  "pants", "pant", "jeans", "jean", "denim", "trouser", "trousers", "shorts", "skirt", "skirts",
  "leggings", "chino", "chinos", "jogger", "joggers", "sweatpant", "sweatpants", "slacks",
  "culottes", "bermuda", "bermudas", "capri", "capris", "palazzo", "bottoms",
];
/* "ג'ינס"/"denim" name a lower-body garment AND a material, so "ז'קט ג'ינס" (a denim
   JACKET) matches the pants list on the fabric alone - and a denim jacket fitted on a
   waist ladder is not a near miss, it is the wrong chart entirely. Mirrors
   FABRIC_AMBIGUOUS / classifyGarmentTitle()'s strip-and-rescan pass in app.js. */
const PANTS_FABRIC_WORDS = ["ג'ינס", "jeans", "jean", "denim"];
const PANTS_TOP_STEMS_HE = [
  "חולצ", "טישרט", "טי-שירט", "סווטשירט", "סוודר", "גופי", "ז'קט", "מעיל", "קפוצ'ון",
  "בלייזר", "קרדיגן", "טופ", "שמלה",
];
const PANTS_TOP_WORDS_EN = [
  "shirt", "tshirt", "t-shirt", "tee", "top", "tops", "hoodie", "jacket", "blazer", "sweater",
  "sweatshirt", "cardigan", "blouse", "polo", "tank", "pullover", "coat", "dress",
];
const _stemHit = (text, stems) => stems.some((s) => text.includes(s));
/* Word-boundary match, mirroring hasEnglishWord() in app.js's garment-category region (see
   PANTS_TITLE_STEMS_HE on why that is a separate copy rather than a shared reference).
   String.raw so the two backslashes of a \\b are unmistakable in review - this pair
   has been silently collapsed to a backspace escape by a shell heredoc once already, and
   /\bjeans\b/ quietly becoming /\u0008jeans\u0008/ matches NOTHING while still compiling. */
const _RE_WORD_BOUND = String.raw`\b`;
const _wordHit = (text, words) =>
  words.some((w) => new RegExp(_RE_WORD_BOUND + w + _RE_WORD_BOUND, "i").test(text));

/* TIER 2 proper. True only when the title names a lower-body garment AND that evidence
   survives the fabric strip.
   @param {string|null|undefined} title
   @returns {boolean} */
function titleNamesPants(title) {
  const text = _normApos(title);
  if (!text.trim()) return false;
  const bottom = _stemHit(text, PANTS_TITLE_STEMS_HE) || _wordHit(text, PANTS_TITLE_WORDS_EN);
  if (!bottom) return false;
  const top = _stemHit(text, PANTS_TOP_STEMS_HE) || _wordHit(text, PANTS_TOP_WORDS_EN);
  if (!top) return true;
  /* Both sides matched. Strip the fabric words and re-test: if the lower-body evidence
     was ONLY the fabric ("ז'קט ג'ינס" → "ז'קט "), the top noun stands alone and this is
     NOT pants. If real lower-body evidence survives ("מכנס ג'ינס" → "מכנס "), it is. */
  const stripped = PANTS_FABRIC_WORDS.reduce((s, w) => s.split(w).join(" "), text);
  const reBottom = _stemHit(stripped, PANTS_TITLE_STEMS_HE) || _wordHit(stripped, PANTS_TITLE_WORDS_EN);
  const reTop = _stemHit(stripped, PANTS_TOP_STEMS_HE) || _wordHit(stripped, PANTS_TOP_WORDS_EN);
  return reBottom && !reTop;
}

/* Explicit lower-body type markers for tier 4. Deliberately the same vocabulary as
   EXPLICIT_BOTTOM_TYPES in fitting-room/app.js (a separate copy - see
   PANTS_TITLE_STEMS_HE's note). "dress" is absent for the reason that set records: a
   dress covers both regions and has no correct answer on a waist-vs-chest question. */
const PANTS_EXPLICIT_TYPES = new Set([
  "pants", "bottoms", "bottom", "shorts", "skirt", "lower_body", "jeans", "trousers",
]);

/**
 * IS THIS PRODUCT WORN ON THE LOWER BODY? - the gate that routes a shopper onto a
 * WAIST chart instead of the chest-banded letter chart.
 *
 * THE BUG THIS CLOSES: a 185cm/82kg shopper on a pair of jeans sold 28/30/32/34/36 was
 * recommended "L" - a value that appears nowhere in that product's size picker, because
 * ZARA_SIZE_CHART bands on CHEST and the product is sold by WAIST.
 *
 * FOUR TIERS, STRONGEST EVIDENCE FIRST, each consulted only when every tier above it
 * abstained. The ordering is the same principle isKidsProduct() established and had to
 * learn the hard way: a DETERMINISTIC signal the storefront actually rendered outranks a
 * PROBABILISTIC one a model produced, because the model is explicitly instructed to
 * abstain on the flat-lay packshots this catalog is full of.
 *
 *   1. the product's own size run   free, synchronous and unambiguous - 24-48 integers
 *                                   can only be a waist (isWaistInchSizeRun), and the EU
 *                                   ladder is claimed here too (isAdultPantsProduct).
 *   2. the title                    free and synchronous, and the tier that answers a
 *                                   store whose size picker is rendered in JS and
 *                                   scrapes to nothing. Fabric ambiguity resolved
 *                                   (titleNamesPants) so a denim JACKET is not pants.
 *   3. the cached Gemini verdict    a network round trip, already cached per photo - the
 *                                   tier that answers "STRAIGHT BASIC" and "LOOSE",
 *                                   titles that name a CUT and a FIT with no garment
 *                                   noun for tier 2 to find.
 *   4. the catalog/handoff type     last, NOT first: the widget forwards "unknown" for a
 *                                   product it could not classify, and an older widget
 *                                   forwards nothing at all. Treating a marker that weak
 *                                   as a verdict is the documented shape of the bug in
 *                                   parseHandoff()'s "HARDCODED DEFAULT" note.
 *
 * NEVER BLOCKS, NEVER GUESSES. Every tier abstains rather than defaulting, and false
 * simply leaves ZARA_SIZE_CHART in place - the behaviour that shipped before this
 * existed. Per CLAUDE.md §2.5 a wrong confident answer here costs a paying shopper a
 * size they cannot select; an abstention costs nothing.
 *
 * @param {string[]|string|null|undefined} sizes - the host product's OWN size list
 * @param {string|null|undefined} title - the product title (tier 2)
 * @param {string|null|undefined} cachedCategory - garment_cache.garment_category (tier 3)
 * @param {object|null|undefined} item - the active item's facts, when one exists (tier 4;
 *   see isAdultNumericPantsGarment() on item.bottoms)
 * @returns {boolean}
 */
function isPantsProduct(sizes, title, cachedCategory, item) {
  // TIER 1 - the size run.
  if (isWaistInchSizeRun(sizes)) return true;
  if (isAdultPantsProduct(sizes)) return true;

  // TIER 2 - the title.
  if (titleNamesPants(title)) return true;

  // TIER 3 - the cached Gemini Vision verdict. Only an explicit "pants" counts:
  // "unknown" is the model declining, and null is nobody ever having asked.
  if (String(cachedCategory == null ? "" : cachedCategory).toLowerCase().trim() === "pants") return true;

  // TIER 4 - the catalog/handoff type marker.
  const type = String(item?.garmentType ?? item?.type ?? item?.category ?? "").toLowerCase().trim();
  if (PANTS_EXPLICIT_TYPES.has(type)) return true;
  if (type && item.bottoms === true) return true;

  return false;
}

/**
 * WHICH adult chart a confidently-pants product is fitted against.
 *
 * EU IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING. The two ladders share the tokens
 * 36-46, so ["36","38","40","42","44","46"] is a valid reading on either convention. It
 * has meant EU since ADULT_PANTS_SIZE_CHART shipped, adult-pants-sizing.test.mjs pins
 * that, and a store on one convention never lists the other - so the EU ladder keeps
 * first claim on its own run and the waist-inch chart takes everything else. Reversing
 * these two lines silently re-sizes every EU store in the catalog.
 *
 * Returns the chart's KIND; computeSizeVerdict() maps it to the banded chart. The
 * precedence lives in exactly one place - here.
 *
 * @param {string[]|string|null|undefined} sizes
 * @returns {"eu"|"waist"} ADULT_PANTS_SIZE_CHART (EU) or ADULT_JEANS_WAIST_CHART
 *   (waist inches). Never null: callers reach this only once isPantsProduct() has
 *   confirmed a lower-body garment, and a pants product whose size list scraped to
 *   nothing still belongs on a waist ladder rather than back on a chest-banded chart.
 */
function pantsChartKindForSizes(sizes) {
  if (isAdultPantsProduct(sizes)) return "eu";
  return "waist";
}

/* THE PRODUCT VERDICT - what calculateSize() in app.js used to resolve before asking for
   a fit, from the same evidence, in the same order.
   @param {object} p - sanitizeProductEvidence() output
   @returns {{chart: "letters"|"eu"|"waist", kidsOnly: boolean, adultOnly: boolean,
              lowerBody: boolean, adultNumericPants: boolean}} */
function productVerdict(p) {
  const garmentSizes = p.sizes;
  const item = p.item;
  /* WHICH ADULT CHART APPLIES TO THIS GARMENT. Three of them now, resolved
     strongest-evidence-first:

       EU numeric   isAdultNumericPantsGarment() - the product's own size list IS the EU
                    ladder (36-46). Unchanged and tested FIRST, so every store already on
                    that convention keeps the behaviour adult-pants-sizing.test.mjs pins.
       waist inch   isPantsProduct() - a confidently lower-body garment by any of its four
                    tiers. THE FIX for "the calculator recommends L for a pair of jeans":
                    185cm/82kg now resolves to "32" instead of a letter that appears
                    nowhere in that product's own size picker.
       letters      everything else - including every garment we are NOT confident about,
                    which is the whole point (CLAUDE.md §2.5: never block, never guess).

     THE ITEM NARROWS, IT NEVER WIDENS, mirroring isAdultNumericPantsGarment()'s own
     rule: a known non-bottoms item vetoes the waist chart (an EU-numbered TOP run must
     not be pulled onto a waist ladder), but no item marker can put a letter-sized
     product onto one. The item is usually absent anyway - calculateSize() runs on Screen 1,
     before the room has an active item - so the sizing/title evidence decides in the
     common case, exactly as the kids/adult guard already does with no item at all.

     ALPHA EVIDENCE VETOES THE WAIST CHART TOO, same as the item check above - see
     isAlphaSizeRun()'s own comment for the bug this closes (sweatpants sold S/M/L,
     confidently pants by title, quoted a waist-inch number that appears on no picker
     anywhere). Checked ALONGSIDE itemContradictsPants rather than folded into
     isPantsProduct() itself: isPantsProduct() answers "is this worn on the lower
     body", which a letter-sized pair of sweatpants still genuinely is - the veto
     belongs at the CHART-selection step, not at the body-region step. */
  const useAdultPantsChart = isAdultNumericPantsGarment(garmentSizes, item);
  const itemContradictsPants = !!item && item.bottoms === false;
  /* Named separately from useWaistInchChart below - per THAT flag's own comment,
     isPantsProduct() answers "is this worn on the lower body" independently of which
     literal CHART ends up handling the fit (a letter-sized sweatpants pair still
     answers true here even though isAlphaSizeRun() vetoes it off the waist chart).
     Read a second time below, by currentSizeIsWomensTops, for exactly that
     independence: WOMEN_TOPS_EU_SIZE_CHART must never decorate a bottoms
     recommendation just because it happens to share ZARA_SIZE_CHART's letters. */
  const isConfidentlyPants =
    isPantsProduct(garmentSizes, p.title, p.cachedCategory, item);
  const useWaistInchChart = !useAdultPantsChart && !itemContradictsPants &&
    !isAlphaSizeRun(garmentSizes, p.sizeRunType) &&
    isConfidentlyPants;
  /* Both numeric branches route through pantsChartKindForSizes() rather than naming a
     chart here, so the EU-before-waist precedence lives in exactly ONE place - see that
     function on why reversing those two lines re-sizes every EU store in the catalog. */
  const useNumericPantsChart = useAdultPantsChart || useWaistInchChart;
  return {
    chart: useNumericPantsChart ? pantsChartKindForSizes(garmentSizes) : "letters",
    kidsOnly: isKidsProduct(garmentSizes, p.ageGroup),
    adultOnly: isAdultProduct(garmentSizes, p.ageGroup),
    lowerBody: isConfidentlyPants,
    adultNumericPants: useAdultPantsChart,
  };
}

/* ══ THE FIT ══════════════════════════════════════════════════════════════════
   The computational half of what used to be calculateSize() in app.js, moved.
   Everything that function did to the DOM stays there (applySizeVerdict()); this
   returns what it used to compute.

   @param {object} ev - see sanitizeSizeEvidence() for every field and its default
   @returns {{
     status: "empty"|"invalid"|"nomatch"|"overflow"|"ok",
     size: string|null,                 // the recommended size (status "ok" only)
     sizeCategory: "adult"|"child"|null,// currentSizeCategory
     bodyCategory: "adult"|"child"|null,// currentBodyCategory - garment-independent
     womensTops: boolean,               // currentSizeIsWomensTops
     euTokens: object|null,             // letter -> FOX women's EU token, only when womensTops
     product: {chart, kidsOnly, adultOnly, adultNumericPants}, // productVerdict(), on EVERY status
   }} */
export function computeSizeVerdict(ev) {
  const { height, weight, chest, waist, legs } = ev;
  /* THE PRODUCT FIRST, and returned on every path - including "empty", which is how the
     browser asks about a garment before (or without) any measurements: the in-room size
     ladder and the kids/adult card after a garment swap read it with no body to fit.
     lowerBody stays here; nothing in the browser acts on it. */
  const product = productVerdict(ev.product);
  const forBrowser = { chart: product.chart, kidsOnly: product.kidsOnly, adultOnly: product.adultOnly,
                       adultNumericPants: product.adultNumericPants };
  const none = { size: null, sizeCategory: null, bodyCategory: null, womensTops: false, euTokens: null,
                 product: forBrowser };
  if (!height || !weight) return { status: "empty", ...none };
  if (height > 240 || height < 110 || weight > 220 || weight < 18) return { status: "invalid", ...none };

  // "Genuine fit" candidates per chart: rows where BOTH height AND weight land
  // inside the band. coreHwPenalty() is exactly 0 in that case (it only ever
  // adds penalty for being OUTSIDE a bound), so filtering on that gives exactly
  // the genuine-fit set - a chart with no such row contributes NOTHING below,
  // rather than still "winning" via whichever row happened to score lowest.
  //
  // A CONFIDENT garment classification restricts the search to a single
  // chart from the start - the other chart's array is left empty rather than
  // filtered, so it can never contribute a candidate below, even if the body
  // would technically fit a row there.

  /* WHICH ADULT CHART: productVerdict() above (see it and pantsChartKindForSizes() for
     the full EU-before-waist and alpha-veto reasoning). The store's own chart is laid over it here, AFTER selection and
     BEFORE the genuine-fit filter - see applyStoreChartOverlay() above for why that
     position is safe (it cannot write a height or weight column). */
  const useNumericPantsChart = product.chart === "eu" || product.chart === "waist";
  const useAdultPantsChart = product.adultNumericPants;
  const garmentSizes = ev.product.sizes;
  const adultChart = applyStoreChartOverlay(
    product.chart === "eu" ? ADULT_PANTS_SIZE_CHART
      : product.chart === "waist" ? ADULT_JEANS_WAIST_CHART
      : ZARA_SIZE_CHART,
    parseStoreSizeChart(ev.storeChart));

  const bodyChildFits = CHILD_SIZE_CHART.filter((row) => coreHwPenalty(row, height, weight) === 0);
  const bodyAdultFits = adultChart.filter((row) => coreHwPenalty(row, height, weight) === 0);
  const bodyCategory = bodyAdultFits.length ? "adult" : (bodyChildFits.length ? "child" : null);

  const childFits = product.adultOnly ? [] : bodyChildFits;
  const adultFits = product.kidsOnly ? [] : bodyAdultFits;

  // Overlap zone (genuinely fits BOTH charts, e.g. ~170-172cm/54-60kg) defaults
  // to adult - same tie-break convention used elsewhere in this codebase
  // (userBodyCategory's adult-first rule, resolveAgeGroup's server-side tie rule).
  // Adult winning whenever it has ANY candidate covers "adult-only" and
  // "fits both" in the same branch. This only actually applies in the
  // "uncertain" case above - a confident garment already has the other
  // chart's array forced empty, so there's nothing left for it to tie with.
  const currentSizeCategory = adultFits.length ? "adult" : (childFits.length ? "child" : null);

  /* GENDER ROUTING - display only, never the fit chart: a shopper who picked "women",
     on a garment that is not confidently lower-body (product.lowerBody, isPantsProduct()'s
     verdict), landed on the adult chart. See WOMEN_TOPS_EU_SIZE_CHART. */
  const womensTops = ev.gender === "women" && !product.lowerBody && currentSizeCategory === "adult";
  const euTokens = womensTops
    ? Object.fromEntries(WOMEN_TOPS_EU_SIZE_CHART.map((r) => [r.size, r.euSize]))
    : null;

  if (!currentSizeCategory) {
    // Fits NEITHER chart - no closest-match guess. A real gap between the two
    // charts, or genuinely out-of-catalog proportions, is now a visible "no
    // size found" result instead of a silently wrong recommendation.
    // Blocking, same severity as the sane-range validation error above -
    // Continue stays disabled until the visitor's measurements resolve to a
    // real chart match.
    //
    // A body ABOVE the resolved adult chart's own ceiling (currently 195cm/100kg on
    // ZARA_SIZE_CHART, 195cm/102kg on ADULT_PANTS_SIZE_CHART) can never match any row
    // in either chart - unlike a gap between the two charts, there is no bigger size
    // to suggest. That case gets its own explicit "no size available" copy instead of
    // the generic no-match text, so it doesn't read as a fixable input mistake.
    // Column-wise max, NOT the chart's last row - the charts happen to be ordered
    // smallest..largest today so the two coincide, but height's ceiling and weight's
    // ceiling aren't guaranteed to live on the same row, so each bound is taken
    // independently. Read off adultChart (whichever one this garment resolved to),
    // so a numeric-pants product is judged against ITS OWN ceiling, not the letter
    // chart's.
    const maxAdultHeight = Math.max(...adultChart.map((row) => row.maxHeight));
    const maxAdultWeight = Math.max(...adultChart.map((row) => row.maxWeight));
    const overflowsMaxSize = height > maxAdultHeight || weight > maxAdultWeight;
    return { status: overflowsMaxSize ? "overflow" : "nomatch", size: null,
             sizeCategory: null, bodyCategory, womensTops, euTokens, product: forBrowser };
  }

  // Among the genuinely-fitting rows only, chest/waist/legs still refine WHICH
  // one is shown when more than one qualifies (adjacent adult sizes' bands
  // really do overlap, e.g. S and M both fit 170-172cm/64-65kg) - same scoring
  // as before, just scoped to candidates that already passed the height/weight
  // gate, never to a row that didn't.
  const candidates = currentSizeCategory === "child" ? childFits : adultFits;
  let bestSize = candidates[0].size, minPenalty = Infinity;
  candidates.forEach((row) => {
    let pen = 0;   // height/weight are already an exact fit for every candidate here
    if (currentSizeCategory === "adult" && useNumericPantsChart) {
      // Pants rows carry minWaist/maxWaist same as ZARA_SIZE_CHART, but chest/legs
      // are swapped for minHips/maxHips (see ADULT_PANTS_SIZE_CHART's comment) -
      // there is no "hips" optional input on the form yet, so only waist fine-tunes.
      if (waist) { if (waist < row.minWaist) pen += (row.minWaist - waist) * 0.5; if (waist > row.maxWaist) pen += (waist - row.maxWaist) * 0.5; }
    } else if (currentSizeCategory === "adult") {
      if (chest) { if (chest < row.minChest) pen += (row.minChest - chest) * 0.5; if (chest > row.maxChest) pen += (chest - row.maxChest) * 0.5; }
      if (waist) { if (waist < row.minWaist) pen += (row.minWaist - waist) * 0.5; if (waist > row.maxWaist) pen += (waist - row.maxWaist) * 0.5; }
      if (legs)  { if (legs  < row.minLegs)  pen += (row.minLegs  - legs)  * 0.5; if (legs  > row.maxLegs)  pen += (legs  - row.maxLegs)  * 0.5; }
    }
    if (pen < minPenalty) { minPenalty = pen; bestSize = row.size; }
  });

  // SNAP TO THE PRODUCT'S OWN LIST. isAdultPantsProduct() now recognizes numeric runs
  // that don't literally match ADULT_PANTS_SIZE_CHART's own six EU rows (e.g. a real
  // US/UK jeans run of 26-40 - see that chart's "THE 26-40 REPORT" comment). bestSize
  // above is still only ever one of those six chart values, since it comes from a
  // genuine height/weight fit against the one chart with VERIFIED bands. When the
  // product doesn't actually sell that exact number, recommending it anyway would be a
  // real SKU the shopper can't buy - so snap to whichever size the product's OWN list
  // actually has that sits closest to it. Pure numeric distance, never a fabricated
  // cm/kg claim about the sizes this chart has no data for, and always a size that
  // exists on this specific product - never a letter, matching this file's "the
  // product's own list wins" precedent (see isKidsProduct()'s comment).
  //
  // TIE-BREAK IS AN EXPLICIT "prefer smaller" RULE, NOT ARRAY ORDER. A bare
  // `reduce((closest, n) => dist(n) < dist(closest) ? n : closest)` looks like it picks
  // the closest value, but on an exact tie its strict `<` keeps whichever candidate the
  // reduce happened to visit first - which for a no-initial-value reduce is
  // ownNumericSizes[0], i.e. WHICHEVER SIZE THE STORE HAPPENED TO SCRAPE FIRST. Every
  // list in this file's own tests is written in ascending order, so that accidentally
  // read as "prefers the lower size" - but nothing about a store's DOM guarantees
  // ascending order, and a differently-ordered size list would have silently flipped
  // which of two equidistant sizes got recommended. The `n < closest` clause below
  // makes "prefer the smaller size" a real, order-independent rule instead of an
  // artifact of whatever order the product happened to list its sizes in.
  if (currentSizeCategory === "adult" && useAdultPantsChart && garmentSizes.length) {
    const ownNumericSizes = garmentSizes.map(Number).filter(Number.isFinite);
    if (ownNumericSizes.length && !garmentSizes.includes(bestSize)) {
      const target = Number(bestSize);
      bestSize = String(ownNumericSizes.reduce((closest, n) => {
        const dn = Math.abs(n - target), dc = Math.abs(closest - target);
        return dn < dc || (dn === dc && n < closest) ? n : closest;
      }));
    }
  }

  return { status: "ok", size: bestSize, sizeCategory: currentSizeCategory, bodyCategory, womensTops, euTokens,
           product: forBrowser };
}

/* ══ THE WIRE ═════════════════════════════════════════════════════════════════
   POST /api/size's body is shopper-controlled, so nothing reaches computeSizeVerdict()
   unchecked: numbers or null, enums from a closed set, booleans only when literally
   true, and bounded lists/strings. An unknown or missing field takes the value that
   means "no evidence" - no sizes, no title, an uncertain age group - which the product
   rules answer with the letters chart, neither kids-only nor adult-only: what the old
   in-browser code did with no product signal (CLAUDE.md §2.5). */

/* The product evidence - built by sizeProductEvidence() in fitting-room/app.js. Strings
   are bounded, enums closed, and item.bottoms is the browser's isBottomsGarment()
   verdict: true / false, or null when it had none. */
export function sanitizeProductEvidence(p) {
  const o = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const it = o.item && typeof o.item === "object" && !Array.isArray(o.item) ? o.item : null;
  return {
    sizes: Array.isArray(o.sizes) ? parseSizeList(o.sizes.slice(0, 60).map((s) => String(s).slice(0, 16))) : [],
    ageGroup: o.ageGroup === "kids" || o.ageGroup === "adult" ? o.ageGroup : "uncertain",
    title: str(o.title, 2000) || "",
    cachedCategory: str(o.cachedCategory, 64),
    sizeRunType: str(o.sizeRunType, 16),
    item: it ? {
      garmentType: str(it.garmentType, 64), type: str(it.type, 64), category: str(it.category, 64),
      bottoms: typeof it.bottoms === "boolean" ? it.bottoms : null,
    } : null,
  };
}

export function sanitizeSizeEvidence(body) {
  const b = body && typeof body === "object" ? body : {};
  const num = (v) => {
    const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
    return Number.isFinite(n) ? n : null;
  };
  let storeChart = null;
  /* A raw chart (the widget's collected tables) is taken whole or not at all - cutting it
     would hand the reader a half-table - and bounded again by decodeRawSizeChart(). A v1
     string keeps its old cut. */
  if (typeof b.storeChart === "string") {
    storeChart = b.storeChart.startsWith(RAW_CHART_PREFIX)
      ? (b.storeChart.length <= RAW_CHART_MAX_CHARS ? b.storeChart : null)
      : b.storeChart.slice(0, 8000);
  }
  else if (Array.isArray(b.storeChart)) {
    storeChart = b.storeChart.slice(0, 60).filter((r) => r && typeof r === "object" && !Array.isArray(r));
  }
  return {
    height: num(b.height), weight: num(b.weight),
    chest: num(b.chest), waist: num(b.waist), legs: num(b.legs),
    gender: b.gender === "men" || b.gender === "women" ? b.gender : null,
    storeChart,
    product: sanitizeProductEvidence(b.product),
  };
}

export {
  ZARA_SIZE_CHART, WOMEN_TOPS_EU_SIZE_CHART, CHILD_SIZE_CHART, ADULT_PANTS_SIZE_CHART,
  ADULT_JEANS_WAIST_CHART, STORE_CHART_CLAMPS, coreHwPenalty, parseStoreSizeChart,
  applyStoreChartOverlay, userBodyCategory, parseSizeList,
  _normApos, ADULT_ALPHA_SIZES, ADULT_PANTS_NUMERIC_SIZES, KIDS_NUMERIC_SIZES,
  RAW_CHART_PREFIX, decodeRawSizeChart, readStoreSizeChart, encodeSizeChart, storeChartWire,
  sizeChartFromGrid, parseMeasurementCell, sizeChartMeasureKey, isPlausibleSizeToken, SIZE_CHART_CLAMPS,
  isKidsProduct, isAdultProduct, isAdultPantsProduct, isAlphaSizeRun, isAdultNumericPantsGarment,
  isWaistInchSizeRun, titleNamesPants, isPantsProduct, pantsChartKindForSizes, productVerdict,
};
