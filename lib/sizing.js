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
   ×0.5 fine-tune tie-break, the snap to the product's own list). What stayed in
   app.js is the PRODUCT side - is this garment kids-only, lower-body, EU-numbered
   (isKidsProduct(), isPantsProduct(), pantsChartKindForSizes()…) - because the
   garment-understanding code shares those verdicts, and they move with it in the
   next phase. The client resolves them and sends them as `chart`, `kidsOnly`,
   `adultOnly`, `lowerBody` and `snap`; this file never re-derives them, so there
   is exactly one copy of each rule.

   BEHAVIOUR IS BYTE-FOR-BYTE THE OLD calculateSize(). The code below is moved,
   not rewritten: the old in-browser function and this one were run over the same
   1,458,028 input cases (26 garment situations × the full height/weight grid ×
   the optional chest/waist/legs grid) and every size, category, label and button
   state matched. Tests import this module directly - see numeric-pants-sizing,
   adult-pants-sizing, kids-product-sizes and size-chart-overlay.

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

/* Mirrors SIZE_CHART_CLAMPS in pear-widget.js (CLAUDE.md §3 - edit together). Re-checked
   HERE rather than trusted from the wire because this is the last gate before a number
   from a stranger's HTML becomes a band the calculator scores against, and the widget is
   not the only possible sender (the message listener accepts a correction, and a
   server-side chart cache is an obvious next step). Centimetres, post-conversion. */
const STORE_CHART_CLAMPS = {
  chest: [50, 200], waist: [40, 200], hips: [50, 200], legs: [40, 140],
};

/* The wire format, decoded:
       <unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:...
       each measurement ::= "min-max", or "" when the chart doesn't publish it
   e.g. cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::

   ⚠️ CROSS-FILE LOCKSTEP (CLAUDE.md §3): the encoder is encodeSizeChart() in
   pear-widget.js. One format, two files, same commit - test/size-chart-overlay.test.mjs
   round-trips the widget's own encoder output through this decoder for that reason.

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
    const s = raw.trim();
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
   }} */
export function computeSizeVerdict(ev) {
  const { height, weight, chest, waist, legs } = ev;
  const none = { size: null, sizeCategory: null, bodyCategory: null, womensTops: false, euTokens: null };
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

  /* WHICH ADULT CHART: resolved in the browser (see app.js calculateSize() and
     pantsChartKindForSizes() for the full EU-before-waist and alpha-veto reasoning) and
     received as ev.chart. The store's own chart is laid over it here, AFTER selection and
     BEFORE the genuine-fit filter - see applyStoreChartOverlay() above for why that
     position is safe (it cannot write a height or weight column). */
  const useNumericPantsChart = ev.chart === "eu" || ev.chart === "waist";
  const useAdultPantsChart = ev.snap === true;
  const garmentSizes = Array.isArray(ev.sizes) ? ev.sizes : [];
  const adultChart = applyStoreChartOverlay(
    ev.chart === "eu" ? ADULT_PANTS_SIZE_CHART
      : ev.chart === "waist" ? ADULT_JEANS_WAIST_CHART
      : ZARA_SIZE_CHART,
    parseStoreSizeChart(ev.storeChart));

  const bodyChildFits = CHILD_SIZE_CHART.filter((row) => coreHwPenalty(row, height, weight) === 0);
  const bodyAdultFits = adultChart.filter((row) => coreHwPenalty(row, height, weight) === 0);
  const bodyCategory = bodyAdultFits.length ? "adult" : (bodyChildFits.length ? "child" : null);

  const childFits = ev.adultOnly ? [] : bodyChildFits;
  const adultFits = ev.kidsOnly ? [] : bodyAdultFits;

  // Overlap zone (genuinely fits BOTH charts, e.g. ~170-172cm/54-60kg) defaults
  // to adult - same tie-break convention used elsewhere in this codebase
  // (userBodyCategory's adult-first rule, resolveAgeGroup's server-side tie rule).
  // Adult winning whenever it has ANY candidate covers "adult-only" and
  // "fits both" in the same branch. This only actually applies in the
  // "uncertain" case above - a confident garment already has the other
  // chart's array forced empty, so there's nothing left for it to tie with.
  const currentSizeCategory = adultFits.length ? "adult" : (childFits.length ? "child" : null);

  /* GENDER ROUTING - display only, never the fit chart: a shopper who picked "women",
     on a garment that is not confidently lower-body (ev.lowerBody, isPantsProduct()'s
     verdict in the browser), landed on the adult chart. See WOMEN_TOPS_EU_SIZE_CHART. */
  const womensTops = ev.gender === "women" && !ev.lowerBody && currentSizeCategory === "adult";
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
             sizeCategory: null, bodyCategory, womensTops, euTokens };
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

  return { status: "ok", size: bestSize, sizeCategory: currentSizeCategory, bodyCategory, womensTops, euTokens };
}

/* ══ THE WIRE ═════════════════════════════════════════════════════════════════
   POST /api/size's body is shopper-controlled, so nothing reaches computeSizeVerdict()
   unchecked: numbers or null, enums from a closed set, booleans only when literally
   true, and bounded lists/strings. An unknown or missing field takes the value that
   means "no evidence" - letters chart, not kids-only, not adult-only - which is what
   the old in-browser code did with no product signal (CLAUDE.md §2.5). */
const CHART_KINDS = new Set(["letters", "eu", "waist"]);
export function sanitizeSizeEvidence(body) {
  const b = body && typeof body === "object" ? body : {};
  const num = (v) => {
    const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
    return Number.isFinite(n) ? n : null;
  };
  let storeChart = null;
  if (typeof b.storeChart === "string") storeChart = b.storeChart.slice(0, 8000);
  else if (Array.isArray(b.storeChart)) {
    storeChart = b.storeChart.slice(0, 60).filter((r) => r && typeof r === "object" && !Array.isArray(r));
  }
  return {
    height: num(b.height), weight: num(b.weight),
    chest: num(b.chest), waist: num(b.waist), legs: num(b.legs),
    chart: CHART_KINDS.has(b.chart) ? b.chart : "letters",
    kidsOnly: b.kidsOnly === true,
    adultOnly: b.adultOnly === true,
    lowerBody: b.lowerBody === true,
    snap: b.snap === true,
    gender: b.gender === "men" || b.gender === "women" ? b.gender : null,
    sizes: Array.isArray(b.sizes) ? parseSizeList(b.sizes.slice(0, 60).map((s) => String(s).slice(0, 16))) : [],
    storeChart,
  };
}

export {
  ZARA_SIZE_CHART, WOMEN_TOPS_EU_SIZE_CHART, CHILD_SIZE_CHART, ADULT_PANTS_SIZE_CHART,
  ADULT_JEANS_WAIST_CHART, STORE_CHART_CLAMPS, coreHwPenalty, parseStoreSizeChart,
  applyStoreChartOverlay, userBodyCategory, parseSizeList,
};
