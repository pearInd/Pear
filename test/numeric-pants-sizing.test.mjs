/* NUMERIC PANTS SIZING - "the calculator recommends L for a pair of jeans".
   ─────────────────────────────────────────────────────────────────────────────
   THE REPORT: a 185cm/82kg shopper opened a pair of jeans sold 28/30/32/34/36 and was
   recommended "L" - a value that appears nowhere in that product's size picker and
   cannot be selected, let alone added to a cart.

   THREE SEPARATE FAULTS produced it, and fixing any one alone leaves the bug standing:

     1. NOTHING EVER SEEDED THE PRODUCT SIZE LIST ON SCREEN 1. pendingSizes was written
        only by the PEAR_UPDATE_GARMENT message listener. The widget has been sending
        ?garment_sizes= on the open URL since the kids-tee fix, and parseHandoff() read
        it into the handoff object - but never into pendingSizes, which is the ONLY
        thing calculateSize() can see before activeItem exists. So the calculator ran
        with no product evidence at all. Worse for a RETURNING shopper: routeUser()'s
        instant-skip path computes the size and leaves Screen 1 entirely, so the late
        correction arrives after the answer was already shown.
     2. THERE WAS NO WAIST CHART. ADULT_PANTS_SIZE_CHART is the EU ladder (36-46);
        a 28/30/32/34/36 run is waist INCHES, a different measurement system that
        happens to share four tokens with it. isAdultPantsProduct() correctly refused to
        claim it (adult-pants-sizing.test.mjs §1 pins that refusal), and the fallback
        was ZARA_SIZE_CHART - which bands on CHEST.
     3. THE TITLE TIER COULD NOT READ ITS OWN KEYWORD. "ג'ינס" is spelled in the keyword
        lists with U+0027 and U+05F3. A CMS with smart quotes substitutes U+2019, which
        is the same word to a reader and unequal to String.includes.

   WHAT THIS SUITE PINS. Structured like adult-pants-sizing.test.mjs, which it sits
   beside and must never contradict: pure functions are extracted and executed for real,
   and calculateSize() is run end to end against a mocked DOM so the chart selection, the
   numeric rendering and the ladder fallback are held together rather than separately.

   THE ONE THING TO BREAK CAREFULLY: §5 pins EU-before-waist precedence. The two ladders
   share 36-46, so reversing those two lines in pantsChartForSizes() silently re-sizes
   every EU store in the catalog while every test here still passes except that one. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SRV = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LIB = readFileSync(new URL("../lib/garment-category.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SQL = readFileSync(new URL("../archive/supabase_setup_v13.sql", import.meta.url), "utf8");
const SQL14 = readFileSync(new URL("../archive/supabase_setup_v14.sql", import.meta.url), "utf8");
const BACKFILL = readFileSync(new URL("../scripts/backfill-garment-categories.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

/* The SAME slice adult-pants-sizing.test.mjs and kids-product-sizes.test.mjs take. Every
   symbol this suite exercises has to live inside it - which is exactly why _normApos(),
   the waist chart and isPantsProduct() sit in the Screen 1 region rather than beside
   GARMENT_CATEGORY_KEYWORDS ~700 lines later (CLAUDE.md §2.6/§2.7). */
const SIZING_SLICE = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");

/* THE FIT RUNS SERVER-SIDE since 2026-09-26 (lib/sizing.js behind POST /api/size), and the
   slice's calculateSize() asks for it through requestSizeVerdict() - which app.js defines
   just OUTSIDE this slice so a harness can inject its own. This one runs the REAL module
   in-process, through the same sanitiser and a JSON round trip, so every end-to-end case
   below still exercises the real chart selection (client) and the real fit (server)
   together. calculateSize() returns a Promise now; every call below awaits it. */
const SIZING_LIB = await import("../lib/sizing.js");
const requestSizeVerdict = (evidence) =>
  Promise.resolve(SIZING_LIB.computeSizeVerdict(SIZING_LIB.sanitizeSizeEvidence(JSON.parse(JSON.stringify(evidence)))));

function classList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
  };
}
const input = (v) => ({ value: v == null ? "" : String(v) });

/* isBottomsGarment() lives ~8000 lines further down app.js (the garment-category-
   detection region), outside SIZING_SLICE - see PANTS_TITLE_STEMS_HE's own comment on
   why several harnesses in this file execute a slice that stops before it. In the REAL
   file this is a non-issue: function declarations hoist across the whole module, so by
   the time a shopper's click actually calls calculateSize(), isBottomsGarment already
   exists. adult-pants-sizing.test.mjs hits the identical gap for
   isAdultNumericPantsGarment() and solves it the same way this does: inject a stand-in
   as a real parameter, so the `typeof isBottomsGarment === "function"` guards inside
   the slice see a real binding rather than silently no-op'ing. */
function harness({ height, weight, chest, waist, legs,
                   pendingSizes, pendingTitle, pendingAgeGroup, pendingSizeRunType, gender = null,
                   activeItem = null, garmentCategory = null, isBottomsGarment } = {}) {
  const els = {
    height: input(height), weight: input(weight), chest: input(chest), waist: input(waist), legs: input(legs),
    resultBox: { classList: classList() },
    sizeResult: { innerText: "" },
    resultLabel: { innerText: "" },
    "btn-next-screen": { disabled: true },
    resultActions: { classList: classList() },
    optionalFields: { classList: classList() },
    sizeMismatchView: { hidden: true },
    sizeMismatchText: { textContent: "" },
    captureBtn: { disabled: false },
    cameraCard: { classList: classList() },
    pearSizeSelector: { remove: () => {} },
    progressFill: { style: {} },
    progressPercent: { innerText: "" },
  };
  const $ = (id) => els[id] ?? null;
  const t = (key) => key;   // identity - assertions check the KEY, not localized copy

  const fn = new Function(
    "$", "t", "activeItem", "pendingSizes", "pendingAgeGroup", "pendingTitle", "pendingSizeRunType", "localStream",
    "__category", "isBottomsGarment", "__gender", "requestSizeVerdict",
    // currentUserGender: same shim-not-slice reason as the other three - it is
    // declared well before "const CHILD_SIZE_SCALE = [" (SIZING_SLICE's start marker) in
    // app.js's top-of-file state block. See ADULT_PANTS_NUMERIC_SIZES's own comment
    // in app.js for the general "some harnesses extract a narrower slice" rule.
    // Seeded from __gender (rather than left null, like the other three) so this
    // harness can actually drive the gender-routing branch under test.
    "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null, currentUserGender = __gender;\n" +
    SIZING_SLICE +
    "\ncurrentGarmentCategory = __category;" +
    "\nreturn { calculateSize," +
    "  getUserSize: () => currentUserSize," +
    "  getSizeCategory: () => currentSizeCategory," +
    "  label: () => formatSizeLabel(currentUserSize)," +
    "  isNumericPants: () => currentSizeIsNumericPants," +
    "  isWomensTops: () => currentSizeIsWomensTops," +
    "  _normApos, isWaistInchSizeRun, titleNamesPants, isPantsProduct, pantsChartKindForSizes," +
    "  pantsLadderForSizes, isAdultPantsProduct, isAlphaSizeRun, ADULT_JEANS_WAIST_SIZES," +
    "  ADULT_PANTS_NUMERIC_SIZES, CHILD_SIZE_SCALE };",
  );
  const api = fn($, t, activeItem, pendingSizes, pendingAgeGroup, pendingTitle, pendingSizeRunType, {},
                 garmentCategory, isBottomsGarment, gender, requestSizeVerdict);
  /* The banded charts are server-side now - attached here from lib/sizing.js so the
     assertions below keep reading the real rows. */
  Object.assign(api, {
    ADULT_JEANS_WAIST_CHART: SIZING_LIB.ADULT_JEANS_WAIST_CHART,
    ADULT_PANTS_SIZE_CHART: SIZING_LIB.ADULT_PANTS_SIZE_CHART,
  });
  return { api, els };
}

const pure = harness({}).api;
const JEANS_RUN = ["28", "30", "32", "34", "36"];

console.log("── §1 _normApos(): one Hebrew word, four codepoints ──");
{
  const { _normApos } = pure;
  /* U+0027 apostrophe · U+05F3 Hebrew geresh · U+2018/U+2019 curly quotes. A CMS with
     smart quotes turned on emits the curly pair; the lists in app.js spell the first
     two. All four are the same word to a shopper. */
  const variants = ["ג'ינס", "ג׳ינס",
                    "ג‘ינס", "ג’ינס"];
  const normed = variants.map(_normApos);
  check("all four geresh spellings of ג'ינס fold to ONE string",
    new Set(normed).size === 1, JSON.stringify(normed));
  check("...and that string is the ASCII-apostrophe spelling the keyword lists use",
    normed[0] === "ג'ינס", JSON.stringify(normed[0]));
  check("the double geresh/gershayim variants fold too (דגמ\"ח and its curly twins)",
    new Set(['דגמ"ח', "דגמ״ח",
             "דגמ”ח"].map(_normApos)).size === 1);
  check("it lower-cases as well, so callers never need a second pass",
    _normApos("Slim Fit JEANS") === "slim fit jeans", _normApos("Slim Fit JEANS"));
  check("non-strings are '' rather than 'null'/'undefined' - never a haystack that\n" +
        "        accidentally contains a keyword",
    _normApos(null) === "" && _normApos(undefined) === "" && _normApos(0) === "0");
}

console.log("\n── §2 isWaistInchSizeRun(): 24-48 integers can only be a waist ──");
{
  const { isWaistInchSizeRun } = pure;
  check("THE REPORTED RUN: 28/30/32/34/36 is a waist run",
    isWaistInchSizeRun(JEANS_RUN) === true);
  check("comma-string form parses like the array (both spellings reach this)",
    isWaistInchSizeRun(" 28 ,30,32") === true);
  check("the full ladder 24-48 is accepted at both ends",
    isWaistInchSizeRun(["24", "48"]) === true);
  check("a kids run (2-18) falls below the floor and abstains - the range is disjoint\n" +
        "        from KIDS_NUMERIC_SIZES by construction",
    isWaistInchSizeRun(["8", "10", "12", "14"]) === false);
  check("a shirt NECK run (14-18) abstains for the same reason",
    isWaistInchSizeRun(["14", "15", "16"]) === false);
  check("anything above the ceiling abstains",
    isWaistInchSizeRun(["48", "50"]) === false);
  check("ANY adult letter present abstains - S/M/L says nothing about region",
    isWaistInchSizeRun(["30", "32", "M"]) === false && isWaistInchSizeRun(["S", "M"]) === false);
  check("a non-integer token abstains (one-size, '32R', a store's own labels)",
    isWaistInchSizeRun(["30", "32R"]) === false &&
    isWaistInchSizeRun(["ONE SIZE"]) === false &&
    isWaistInchSizeRun(["30.5"]) === false);
  check("no list at all abstains - never guess a chart from nothing",
    isWaistInchSizeRun([]) === false && isWaistInchSizeRun(null) === false &&
    isWaistInchSizeRun(undefined) === false);
}

console.log("\n── §3 titleNamesPants(): the garment noun, and the fabric collision ──");
{
  const { titleNamesPants } = pure;
  for (const title of [
    "ג'ינס סקיני",      // ג'ינס סקיני, U+0027
    "ג’ינס סקיני",  // U+2019 - the reported spelling
    "מכנס קצר",                    // מכנס קצר (stem, not מכנסיים)
    "Slim Fit Jeans", "Cargo Pants", "Wide Leg Trousers", "Denim Shorts",
  ]) check(`"${title}" → pants`, titleNamesPants(title) === true);

  for (const title of [
    "חולצת פולו",        // חולצת פולו
    "Short Sleeve Tee", "Oversized Hoodie", "FOX Essentials 2024", "",
  ]) check(`"${title}" → NOT pants`, titleNamesPants(title) === false);

  /* THE FABRIC COLLISION, the same one FABRIC_AMBIGUOUS exists for one region down:
     "ג'ינס"/"denim" name a lower-body garment AND a material. A denim JACKET fitted on
     a waist ladder is not a near miss - it is the wrong measurement system. */
  check("ז'קט ג'ינס (denim JACKET) is NOT pants - the fabric was the only evidence",
    titleNamesPants("ז'קט ג'ינס") === false);
  check('"Denim Jacket" likewise', titleNamesPants("Denim Jacket") === false);
  check('...and the curly-apostrophe spelling of that jacket is ALSO not pants -\n' +
        "        normalisation must not accidentally turn a jacket INTO trousers",
    titleNamesPants("ז’קט ג’ינס") === false);
  check("מכנס ג'ינס (denim TROUSERS) survives the strip - real lower-body evidence",
    titleNamesPants("מכנס ג'ינס") === true);
  check('"Denim Jeans" survives it too', titleNamesPants("Denim Jeans") === true);
  check("null/undefined abstain rather than throwing",
    titleNamesPants(null) === false && titleNamesPants(undefined) === false);
}

console.log("\n── §4 isPantsProduct(): four tiers, strongest evidence first ──");
{
  const { isPantsProduct } = pure;
  check("TIER 1 - the size run alone decides, with no title and no item",
    isPantsProduct(JEANS_RUN, "", null, null) === true);
  check("TIER 1 - the EU ladder is claimed here too",
    isPantsProduct(["36", "38", "40"], "", null, null) === true);
  check("TIER 2 - no size list (a JS-rendered picker), the title decides",
    isPantsProduct(null, "ג’ינס סקיני", null, null) === true);
  check("TIER 3 - a cut/fit-named title with nothing scraped: the cached Gemini\n" +
        "        VISION verdict decides. This is the 'STRAIGHT BASIC' / 'LOOSE' case",
    isPantsProduct(null, "STRAIGHT BASIC", "pants", null) === true);
  check("TIER 3 - 'unknown' is the model DECLINING and must abstain, not assert",
    isPantsProduct(null, "STRAIGHT BASIC", "unknown", null) === false);
  check("TIER 3 - 'top'/'dress' abstain too (only an explicit 'pants' counts)",
    isPantsProduct(null, "STRAIGHT BASIC", "top", null) === false &&
    isPantsProduct(null, "STRAIGHT BASIC", "dress", null) === false);
  check("TIER 4 - the catalog/handoff type marker, last",
    isPantsProduct(null, "", null, { type: "pants" }) === true &&
    isPantsProduct(null, "", null, { garmentType: "lower_body" }) === true &&
    isPantsProduct(null, "", null, { type: "skirt" }) === true);
  check("TIER 4 - the widget's 'unknown' marker is NOT a verdict",
    isPantsProduct(null, "", null, { type: "unknown" }) === false);
  check("EVERY TIER ABSTAINING is false, not a guess - the letter chart stands",
    isPantsProduct(null, "", null, null) === false &&
    isPantsProduct([], "FOX Essentials 2024", null, {}) === false);
  check("a letter-sized product with a TOP title is never pants",
    isPantsProduct(["S", "M", "L"], "Oversized Hoodie", null, { type: "shirt" }) === false);
}

console.log("\n── §5 pantsChartKindForSizes(): EU keeps first claim on its own ladder ──");
{
  const { pantsChartKindForSizes, pantsLadderForSizes, ADULT_PANTS_SIZE_CHART, ADULT_JEANS_WAIST_CHART,
          ADULT_JEANS_WAIST_SIZES, ADULT_PANTS_NUMERIC_SIZES, CHILD_SIZE_SCALE } = pure;
  check("the waist chart is the FOX ladder (28-38, updated 2026-09-14) - replaced\n" +
        "        wholesale, so 24/26/40/42/44/46/48 are deliberately gone (CLAUDE.md\n" +
        "        §2.5 handles those bodies via the overflow/no-match guard, not a guess)",
    JSON.stringify(ADULT_JEANS_WAIST_CHART.map((r) => r.size)) ===
    JSON.stringify(["28", "30", "31", "32", "33", "34", "36", "38"]));
  check("every waist row carries waist AND hip bands, matching ADULT_PANTS_SIZE_CHART's\n" +
        "        shape so coreHwPenalty() and the fine-tune pass work unmodified",
    ADULT_JEANS_WAIST_CHART.every((r) =>
      Number.isFinite(r.minWaist) && Number.isFinite(r.maxWaist) &&
      Number.isFinite(r.minHips) && Number.isFinite(r.maxHips) &&
      Number.isFinite(r.minHeight) && Number.isFinite(r.maxHeight) &&
      Number.isFinite(r.minWeight) && Number.isFinite(r.maxWeight)));
  /* THE LADDER LOCKSTEP. Since 2026-09-26 the banded charts live server-side and the
     browser keeps only their size LADDERS, as literal lists - so these three checks are
     the only thing tying each ladder to its chart. A drift would let the override
     selector or the stock fallbacks offer a size the fit can never return. */
  check("the browser's waist ladder is exactly the server chart's sizes, in chart order",
    JSON.stringify([...ADULT_JEANS_WAIST_SIZES]) === JSON.stringify(ADULT_JEANS_WAIST_CHART.map((r) => r.size)),
    JSON.stringify([...ADULT_JEANS_WAIST_SIZES]));
  check("...the EU ladder is exactly ADULT_PANTS_SIZE_CHART's sizes, in chart order",
    JSON.stringify([...ADULT_PANTS_NUMERIC_SIZES]) === JSON.stringify(ADULT_PANTS_SIZE_CHART.map((r) => r.size)),
    JSON.stringify([...ADULT_PANTS_NUMERIC_SIZES]));
  check("...and CHILD_SIZE_SCALE is exactly CHILD_SIZE_CHART's sizes, in chart order",
    JSON.stringify(CHILD_SIZE_SCALE) === JSON.stringify(SIZING_LIB.CHILD_SIZE_CHART.map((r) => r.size)),
    JSON.stringify(CHILD_SIZE_SCALE));
  check("rows run SMALLEST FIRST - calculateSize() keeps the first genuine fit when no\n" +
        "        waist measurement narrows it, so order is behaviour, not formatting",
    ADULT_JEANS_WAIST_CHART.every((r, i, a) => i === 0 || Number(r.size) > Number(a[i - 1].size)));
  check("adjacent weight bands OVERLAP - a shopper on a boundary is never in a gap",
    ADULT_JEANS_WAIST_CHART.every((r, i, a) => i === 0 || r.minWeight <= a[i - 1].maxWeight));

  check("THE PRECEDENCE: an EU run 36-46 resolves to the EU chart, unchanged",
    pantsChartKindForSizes(["36", "38", "40", "42", "44", "46"]) === "eu");
  check("...a waist-inch run resolves to the waist chart",
    pantsChartKindForSizes(JEANS_RUN) === "waist");
  check("...and a pants product with NO readable size list gets the waist chart, not a\n" +
        "        chest-banded fallback (this is the title/vision-tier path)",
    pantsChartKindForSizes(null) === "waist");
  check("...and its ladder is the waist ladder, which is what the selector walks then",
    JSON.stringify(pantsLadderForSizes(null)) === JSON.stringify(ADULT_JEANS_WAIST_CHART.map((r) => r.size)));
}

console.log("\n── §6 calculateSize() END TO END: the reported case, and what must not move ──");
{
  /* THE REPORTED CASE. */
  const jeans = harness({ height: 185, weight: 82, pendingSizes: JEANS_RUN });
  await jeans.api.calculateSize();
  check("185cm/82kg on a 28-36 jeans run → 32 (was: 'L')",
    jeans.api.getUserSize() === "32", jeans.api.getUserSize());
  check("...rendered as the BARE numeric token the store's picker shows",
    jeans.els.sizeResult.innerText === "32", jeans.els.sizeResult.innerText);
  check("...formatSizeLabel() is numeric-locked, so nothing downstream decorates it\n" +
        "        into a string no Shopify variant can match",
    jeans.api.label() === "32", jeans.api.label());
  check("...still categorised 'adult'", jeans.api.getSizeCategory() === "adult");
  check("...and Continue is enabled", jeans.els["btn-next-screen"].disabled === false);

  /* The same body, same garment, reached through each of the other three tiers. */
  const byTitle = harness({ height: 185, weight: 82,
    pendingTitle: "ג’ינס סקיני" });
  await byTitle.api.calculateSize();
  check("TIER 2 end to end: same body, curly-apostrophe Hebrew title, NO size list → 32",
    byTitle.api.getUserSize() === "32", byTitle.api.getUserSize());

  const byVision = harness({ height: 185, weight: 82, pendingTitle: "STRAIGHT BASIC", garmentCategory: "pants" });
  await byVision.api.calculateSize();
  check("TIER 3 end to end: cut-named title, Supabase garment_category='pants' → 32",
    byVision.api.getUserSize() === "32", byVision.api.getUserSize());

  const byType = harness({ height: 185, weight: 82, activeItem: { type: "pants", name: "STRAIGHT BASIC" } });
  await byType.api.calculateSize();
  check("TIER 4 end to end: the handoff type marker alone → 32",
    byType.api.getUserSize() === "32", byType.api.getUserSize());

  /* THE SAME TITLE WITH NO EVIDENCE AT ALL must fall back, or the tiers are decoration. */
  const noEvidence = harness({ height: 185, weight: 82, pendingTitle: "STRAIGHT BASIC" });
  await noEvidence.api.calculateSize();
  check("a cut-named title with NOTHING behind it stays on the letter chart - every\n" +
        "        tier abstained, and an abstention is not a verdict",
    /^(XS|S|M|L|XL|XXL|3XL)$/.test(noEvidence.api.getUserSize() || ""), noEvidence.api.getUserSize());
  check("...and is NOT numeric-locked", noEvidence.api.isNumericPants() === false);

  /* WHAT MUST NOT MOVE. */
  const letters = harness({ height: 179, weight: 80, pendingSizes: ["S", "M", "L", "XL"] });
  await letters.api.calculateSize();
  check("a letter-sized product is untouched → L", letters.api.getUserSize() === "L", letters.api.getUserSize());

  const eu = harness({ height: 185, weight: 82, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await eu.api.calculateSize();
  check("THE SAME BODY on an EU-laddered product still gets 44 - the two conventions\n" +
        "        share tokens, and the EU store must not be silently re-sized",
    eu.api.getUserSize() === "44", eu.api.getUserSize());

  const kidsTee = harness({ height: 140, weight: 30, pendingSizes: ["8", "10", "12", "14"] });
  await kidsTee.api.calculateSize();
  check("a kids-numeric product is still the CHILD chart, and still carries the kids\n" +
        "        suffix (the numeric lock must not swallow it) - 140cm/30kg fits\n" +
        "        size 10's 135-145cm/27-32kg band",
    kidsTee.api.getSizeCategory() === "child" &&
    kidsTee.api.isNumericPants() === false &&
    kidsTee.api.label() === "10 sizeLabelKidsSuffix",
    `${kidsTee.api.getUserSize()} / ${kidsTee.api.label()}`);

  /* THE ITEM NARROWS, NEVER WIDENS - an EU-numbered TOP run must not be pulled onto a
     waist ladder just because its tokens are integers in range. isBottomsGarment is
     injected (see harness()'s own note); a shirt/Blouse item makes it return false. */
  const notBottoms = (item) => {
    const fields = [item?.type, item?.name].filter(Boolean).join(" ").toLowerCase();
    return !/shirt|blouse/.test(fields);
  };
  const numberedTop = harness({ height: 179, weight: 80, pendingSizes: ["34", "36", "38"],
    activeItem: { type: "shirt", name: "Blouse" }, isBottomsGarment: notBottoms });
  await numberedTop.api.calculateSize();
  check("a numbered run on a KNOWN non-bottoms item stays on the letter chart",
    /^(XS|S|M|L|XL|XXL|3XL)$/.test(numberedTop.api.getUserSize() || ""), numberedTop.api.getUserSize());

  /* The waist fine-tune still narrows among several genuinely-fitting rows, same as on
     the EU chart - the FOX bands are tighter than the old chart's, so 185/82 now
     genuinely fits FOUR rows on height/weight alone (32: 65-88kg, 33: 69-93kg,
     34: 72-97kg, 36: 78-105kg all admit 82kg at 185cm) and waist is what picks among
     them: 87cm sits inside 34's 86-88cm band and outside every other candidate's
     (32 tops out at 83, 33 at 86, 36 opens at 91), so 34 wins even though it is
     neither the first nor the last row that matched on height/weight. */
  const wide = harness({ height: 185, weight: 82, waist: 87, pendingSizes: JEANS_RUN });
  await wide.api.calculateSize();
  check("an 87cm waist reading (inside 34's 86-88cm band only) pulls the recommendation\n" +
        "        to 34 out of the four rows that genuinely fit on height/weight alone",
    wide.api.getUserSize() === "34", wide.api.getUserSize());

  /* The chart-aware overflow guard must read the WAIST chart's own ceiling. */
  const overflow = harness({ height: 210, weight: 215, pendingSizes: JEANS_RUN });
  await overflow.api.calculateSize();
  check("a body above the waist chart's own ceiling gets the overflow copy and\n" +
        "        Continue stays LOCKED - never a silently wrong numeric guess",
    overflow.els.sizeResult.innerText === "sizeResultOverflow" &&
    overflow.els["btn-next-screen"].disabled === true &&
    overflow.api.getUserSize() === null, overflow.els.sizeResult.innerText);

  /* The flag must be cleared on the early-return paths, or a previous garment's chart
     description leaks into formatSizeLabel() on the next run. */
  const cleared = harness({ height: 185, weight: 82, pendingSizes: JEANS_RUN });
  await cleared.api.calculateSize();
  cleared.els.weight.value = "";
  await cleared.api.calculateSize();
  check("clearing a measurement resets the numeric-pants flag (no stale chart state)",
    cleared.api.isNumericPants() === false);
}

console.log("\n── §7 the handoff: sizes and title reach Screen 1 synchronously ──");
{
  check("parseHandoff() SEEDS pendingSizes from the URL - the fault that made every\n" +
        "        other tier unreachable on Screen 1",
    /if \(pendingSizes === undefined && result\.sizes !== undefined\) pendingSizes = result\.sizes;/.test(APP));
  check("...and seeds pendingTitle the same way",
    /if \(pendingTitle === undefined && result\.title !== undefined\) pendingTitle = result\.title;/.test(APP));
  check("...as a SEED, not an overwrite: the PEAR_UPDATE_GARMENT correction is the\n" +
        "        better reading and must survive a later re-parse",
    /parseHandoff\(\) is called several times per session/.test(APP));
  check("pendingTitle is actually declared at module scope beside pendingSizes",
    /let pendingTitle = undefined;/.test(APP));
  check("parseHandoff() accepts BOTH title spellings, so an older widget bundle still\n" +
        "        reaches the title tier",
    /q\.get\("garment_title"\) \|\| wName/.test(APP));
  check("the widget sends ?garment_title= on the open URL",
    /"&garment_title=" \+ encodeURIComponent\(garment\.name\)/.test(PW));
  check("...and re-sends it with the PEAR_UPDATE_GARMENT correction",
    /garment_title: getGarmentName\(\)/.test(PW));
  check("the room applies that late title and recalculates",
    /const incomingTitle = e\.data\.garment_title \|\| e\.data\.garment_name;/.test(APP));

  /* CLAUDE.md §3 - the widget's verdict is EXPLICIT and outranks the room's own
     classifier, so an apostrophe miss on the widget side cannot be fixed room-side. */
  check("LOCKSTEP: the widget carries its own normApos() copy",
    /function normApos\(s\) \{/.test(PW));
  /* Functional lockstep, not textual - app.js's _normApos() was authored with the
     literal Hebrew/curly characters in the class (the file already does this
     elsewhere: hasHebrewStem's stems are literal, not \uXXXX), while the widget's
     normApos() spells the same codepoints as escapes. Both are checked by running
     them, not by comparing source text, so a future edit is free to pick either
     spelling in either file without tripping this assertion for no reason. */
  const CURLY_QUOTE_VARIANTS = ["'", "׳", "‘", "’", "′"];
  check("...folding the SAME apostrophe/geresh codepoints as _normApos() in app.js",
    CURLY_QUOTE_VARIANTS.every((c) => pure._normApos("ג" + c + "ינס") === "ג'ינס"));
  const widgetNormApos = new Function(
    extract(PW, "function normApos(s) {", "\n  /* Already apostrophe-normalised") +
    "\nreturn normApos;",
  )();
  check("...and the WIDGET's own copy folds the identical set, executed for real",
    CURLY_QUOTE_VARIANTS.every((c) => widgetNormApos("ג" + c + "ינס") === "ג'ינס"));
  check("...and detectCategory() runs its haystack through it, not toLowerCase()",
    /var haystack = normApos\(\(name \|\| ""\) \+ " " \+ \(d\.title \|\| ""\)\);/.test(PW));

  /* The word-boundary regex is built with String.raw for a reason worth pinning: a
     shell heredoc collapsed the pair once during development, and /\bjeans\b/ quietly
     becoming /jeans/ still COMPILES and matches nothing. */
  check("the English word-boundary regex survives as a real \\b, not a backspace",
    pure.titleNamesPants("Cargo Pants") === true &&
    pure.titleNamesPants("Pantsuit Blazer") === false);
}

console.log("\n── §8 the vision tier: endpoint, classifier, migration, backfill ──");
{
  check("GET /api/garment-category is mounted",
    /app\.get\("\/api\/garment-category", classifyLimiter, async \(req, res\) => \{/.test(SRV));
  check("...it is CACHE-FIRST: a stored category short-circuits before Gemini",
    /cache HIT/.test(SRV) && /source: "cache", cached: true/.test(SRV));
  check("...an unconfigured key answers 200/unknown, never a 5xx - a size calculator\n" +
        "        must not fail over an enhancement (CLAUDE.md §2.5)",
    /source: "unconfigured", cached: false/.test(SRV));
  check("...a RATE LIMIT is never persisted: NULL is the only thing that makes the\n" +
        "        endpoint ask again, so a throttle written as 'unknown' is permanent",
    /rate limited - not caching/.test(SRV) && /source: "rate_limited"/.test(SRV));
  check("...only a real verdict is written",
    /if \(verdict\.source === "gemini" && supabase\)/.test(SRV));
  check("...a photo with NO cached row gets a genuine front/back verdict rather than a\n" +
        "        fabricated one - garment_cache.classification is NOT NULL",
    /const detail = await classifyFrontBackDetailed\(imageUrl\);/.test(SRV));
  check("...and a known photo keeps its EXISTING front/back verdict and provenance",
    /await saveClassification\(imageUrl, cached\.classification, \{/.test(SRV));

  check("saveClassification() only writes the column when a category was actually asked\n" +
        "        for - an unconditional write would stamp over a real verdict",
    /const v13Fields = typeof meta\.garmentCategory === "string" && meta\.garmentCategory/.test(SRV));
  check("the read path degrades v13 → v12 → v11 → v8 → bare v5, one tier at a time, so\n" +
        "        the code deploys safely BEFORE the SQL runs",
    /v13 column absent - run archive\/supabase_setup_v13\.sql/.test(SRV) &&
    /const V13_ONLY = ", garment_category";/.test(SRV));
  check("...and every shallower shape reports garment_category: null, so a pre-v13\n" +
        "        database is 'never asked' rather than undefined",
    (SRV.match(/garment_category: null/g) || []).length >= 3);

  check("CLASSIFIER_PROMPT_VERSION is NOT bumped - the category is its own call, so no\n" +
        "        catalog-wide front/back re-classification is triggered",
    /const CLASSIFIER_PROMPT_VERSION = 3;/.test(SRV));

  check("the classifier is a shared module, imported rather than copied",
    /import \{ classifyGarmentFull \} from "\.\/lib\/garment-category\.js";/.test(SRV) &&
    /from "\.\.\/lib\/garment-category\.js"/.test(BACKFILL));
  check("...its prompt names the flat-lay failure it was written against",
    /folded flat-lay is the single most misread case/.test(LIB));
  check("...and it abstains below 0.7 rather than guessing",
    /confidence is below 0\.7 you must answer/.test(LIB));
  check("...429 throws instead of resolving, so a throttle is distinguishable from a\n" +
        "        verdict at every call site",
    /err\.rateLimited = true;/.test(LIB));

  check("the migration adds exactly the nullable column, with a CHECK constraint",
    /ADD COLUMN IF NOT EXISTS garment_category TEXT DEFAULT NULL;/.test(SQL) &&
    /garment_category IN \('pants', 'top', 'dress', 'unknown'\)/.test(SQL));
  check("...and records why NULL must never be backfilled",
    /DO NOT BACKFILL NULL WITH A DEFAULT/.test(SQL));
  check("...and explains why it is v13 rather than the v8 the task named",
    /That file already exists and is a DIFFERENT migration/.test(SQL));

  check("the backfill selects on the NULL column, so the query IS the resumable queue",
    /\.is\("garment_category", null\)/.test(BACKFILL));
  check("...it refuses to run with no credentials instead of writing nothing quietly",
    /Nothing was read and nothing was written\./.test(BACKFILL));
  check("...it stops on 429 rather than recording the throttle",
    /if \(e\?\.rateLimited\)/.test(BACKFILL) && /still in the queue/.test(BACKFILL));
  check("...it only persists a real verdict",
    /if \(verdict\.source !== "gemini"\)/.test(BACKFILL));
  check("...and it addresses rows by canonical_url (CLAUDE.md §2.2), not raw URL",
    /canonical_url\s*\n?\s*\? \{ column: "canonical_url"/.test(BACKFILL));
}

console.log("\n── §9 isAlphaSizeRun(): sports pants sold S/M/L must NOT get a waist number ──");
{
  const { isAlphaSizeRun } = pure;
  check("a confident letter run is alpha, with no cache hint needed",
    isAlphaSizeRun(["S", "M", "L", "XL"], undefined) === true);
  check("a confident numeric run is NOT alpha",
    isAlphaSizeRun(JEANS_RUN, undefined) === false);
  check("an empty list with NO cached hint abstains (false) - never guess",
    isAlphaSizeRun([], undefined) === false && isAlphaSizeRun(null, undefined) === false);
  check("an empty list falls back to a cached 'alpha' verdict",
    isAlphaSizeRun([], "alpha") === true);
  check("an empty list with a cached 'numeric' verdict is NOT alpha (stays on the\n" +
        "        numeric-chart default, unchanged)",
    isAlphaSizeRun([], "numeric") === false);
  check("THIS VISIT'S OWN scraped list always wins over a stale cached hint",
    isAlphaSizeRun(["S", "M", "L"], "numeric") === true &&
    isAlphaSizeRun(JEANS_RUN, "alpha") === false);
  check("a mixed/unrecognised list is NON-EMPTY real evidence from THIS visit, so it\n" +
        "        does NOT fall through to the cache even though it isn't confidently\n" +
        "        alpha itself - only a genuinely EMPTY list consults the cache",
    isAlphaSizeRun(["S", "32"], "alpha") === false && isAlphaSizeRun(["S", "32"], undefined) === false);

  /* WHAT THE VETO DOES NOT (AND CANNOT) FIX: "Sweatpants" with NO size list scraped
     and NO cached hint at all. isPantsProduct() correctly calls this pants from the
     title alone (TIER 2), and with no positive alpha evidence anywhere the existing,
     deliberate "no confidently-numeric run" default (pantsChartForSizes()'s own
     §5 note: "a pants product with NO readable size list gets the waist chart, not a
     chest-banded fallback") still applies unchanged - there is nothing here to tell
     it otherwise. This is the exact gap archive/supabase_setup_v14.sql's cache
     exists to close for a RETURNING visit to the SAME product; a first-ever,
     never-cached visit with a fully JS-rendered picker is the one case this fix
     cannot reach, same as CLAUDE.md §2.5's "abstain rather than guess" already
     accepts elsewhere in this file. */
  const sweatpantsNoEvidence = harness({ height: 179, weight: 80, pendingTitle: "Sweatpants" });
  await sweatpantsNoEvidence.api.calculateSize();
  check("sweatpants with NO scraped sizes and NO cache hint: still the waist-chart\n" +
        "        default (unchanged, documented limitation - see comment above)",
    sweatpantsNoEvidence.api.isNumericPants() === true);

  /* THE REPORTED BUG, END TO END: sweatpants sold S/M/L. isPantsProduct() correctly
     calls this a lower-body garment from the title alone (TIER 2) - that part is not
     the bug. The bug was pantsChartForSizes()'s "no confidently-numeric run" default
     landing on ADULT_JEANS_WAIST_CHART instead of staying on the letter chart, once
     the product's OWN size list positively said "S/M/L". */
  const sportsPants = harness({ height: 179, weight: 80, pendingSizes: ["S", "M", "L"], pendingTitle: "Track Pants" });
  await sportsPants.api.calculateSize();
  check("THE EXACT REPORT: sports pants scraped S/M/L, title also names pants - the\n" +
        "        letter run is now POSITIVE evidence, not just an absence of numeric\n" +
        "        evidence, so it wins even though isPantsProduct() is confidently true",
    sportsPants.api.getUserSize() === "L", sportsPants.api.getUserSize());
  check("...rendered as the plain letter, never decorated as a waist size",
    sportsPants.api.label() === "L" && sportsPants.api.isNumericPants() === false);

  /* THE CACHE FALLBACK: this visit's own picker scraped nothing (a JS-rendered
     control that hasn't hydrated), but a PREVIOUS visit's scrape of the SAME product
     was cached and echoed back as pendingSizeRunType - see archive/supabase_setup_v14.sql. */
  const cachedAlpha = harness({ height: 179, weight: 80, pendingTitle: "Track Pants", pendingSizeRunType: "alpha" });
  await cachedAlpha.api.calculateSize();
  check("no size list THIS visit, but a cached 'alpha' verdict from a previous visit\n" +
        "        still keeps the product on the letter chart",
    /^(XS|S|M|L|XL|XXL|3XL)$/.test(cachedAlpha.api.getUserSize() || ""), cachedAlpha.api.getUserSize());

  /* WHAT MUST NOT MOVE: a genuinely numeric-run pants product, and one with no size
     evidence and no cache hint at all, are both untouched by this veto. */
  const stillJeans = harness({ height: 185, weight: 82, pendingSizes: JEANS_RUN });
  await stillJeans.api.calculateSize();
  check("28-36 jeans still resolve to the waist chart - the veto never fires on a\n" +
        "        confidently NUMERIC run",
    stillJeans.api.getUserSize() === "32", stillJeans.api.getUserSize());

  /* THE VETO REACHES EVERY TIER of isPantsProduct(), not just the title tier - a
     product identified as pants via the TIER 4 catalog/handoff marker with its own
     alpha size list must be caught exactly the same way. */
  const byTypeAlpha = harness({ height: 179, weight: 80, pendingSizes: ["S", "M", "L"],
    activeItem: { type: "pants", name: "Track Pants" } });
  await byTypeAlpha.api.calculateSize();
  check("TIER 4 (handoff type marker) + a scraped alpha run: still the letter chart",
    byTypeAlpha.api.getUserSize() === "L", byTypeAlpha.api.getUserSize());
}

console.log("\n── §10 the plumbing: widget scrape, cache write/read, and the room's use of it ──");
{
  check("the widget classifies numeric vs alphabetic size runs at scan time",
    /function classifySizeRunType\(sizes\)/.test(PW));
  check("...'every token or abstain', same confidence rule as the room's own",
    /return "unknown";/.test(PW) && /return "numeric";/.test(PW) && /return "alpha";/.test(PW));
  check("...sent on the OPEN url, synchronously, same as garment_sizes",
    /"&garment_size_type=" \+ hostSizeRunType/.test(PW));
  check("...and re-sent on the PEAR_UPDATE_GARMENT correction",
    /garment_size_type: res\.sizeRunType/.test(PW));
  check("...opportunistically cached server-side via the SAME classify-images call\n" +
        "        that already fetches this product's gallery (no extra round trip)",
    /size_run_type: hostSizeRunType !== "unknown" \? hostSizeRunType : undefined/.test(PW));

  check("the room reads garment_size_type off the open URL, synchronously (Screen 1)",
    /sizeRunType: q\.get\("garment_size_type"\) \|\| undefined/.test(APP));
  check("...seeds pendingSizeRunType from it, SEED-not-overwrite like pendingSizes",
    /if \(pendingSizeRunType === undefined && result\.sizeRunType !== undefined\)/.test(APP));
  check("...and the PEAR_UPDATE_GARMENT listener accepts a later correction",
    /e\.data\.garment_size_type === "numeric" \|\| e\.data\.garment_size_type === "alpha"/.test(APP));

  check("server.js persists the client's verdict, but ONLY numeric/alpha - never\n" +
        "        'unknown' (that would freeze a slow-hydrating picker on the wrong chart\n" +
        "        forever, see archive/supabase_setup_v14.sql)",
    /const v14Fields = meta\.sizeRunType === "numeric" \|\| meta\.sizeRunType === "alpha"/.test(SRV));
  check("...read back by PRODUCT url, not by photo, because the size run belongs to\n" +
        "        the product, not to whichever photo happens to be the reference image",
    /async function getCachedSizeRunType\(productUrl\)/.test(SRV) &&
    /\.eq\("product_url", productUrl\)/.test(SRV));
  check("...the classify-images response prefers THIS visit's scrape over the cache",
    /let sizeRunType = scrapedSizeRunType;/.test(SRV));

  check("the v14 migration adds exactly the nullable column, with a CHECK constraint",
    /ADD COLUMN IF NOT EXISTS size_run_type TEXT DEFAULT NULL;/.test(SQL14) &&
    /size_run_type IN \('numeric', 'alpha'\)/.test(SQL14));
  check("...and records why 'unknown' must never be written, unlike garment_category's",
    /"unknown" IS NEVER WRITTEN HERE/.test(SQL14));
}

console.log("\n── §11 gender routing: WOMEN_TOPS_EU_SIZE_CHART decorates the letter, never\n" +
            "        replaces the fit chart, and never touches a bottoms recommendation ──");
{
  /* THE CORE CASE: a woman shopper, an ordinary top, fitted exactly like everyone
     else - only the DISPLAYED label gains the EU token. */
  const womensTop = harness({ height: 170, weight: 68, gender: "women" });
  await womensTop.api.calculateSize();
  check("170cm/68kg, gender=women, no product evidence → still the same letter\n" +
        "        ZARA_SIZE_CHART would give a man (M)",
    womensTop.api.getUserSize() === "M", womensTop.api.getUserSize());
  check("...but the DISPLAYED label carries FOX's women's EU token alongside it",
    womensTop.api.label() === "M (EU 38)", womensTop.api.label());
  check("...and the flag formatSizeLabel() reads is set",
    womensTop.api.isWomensTops() === true);

  /* THE SAME BODY, NO GENDER PICKED - the pre-selector default, byte-for-byte. */
  const noGender = harness({ height: 170, weight: 68 });
  await noGender.api.calculateSize();
  check("the same body with NO gender selected gets the plain letter - an unmade\n" +
        "        choice must not change the recommendation (CLAUDE.md §2.5)",
    noGender.api.getUserSize() === "M" && noGender.api.label() === "M", noGender.api.label());
  check("...and the flag is false", noGender.api.isWomensTops() === false);

  /* THE SAME BODY, MEN EXPLICITLY PICKED - same as unset, the "Men's tops chart\n
     (ZARA_SIZE_CHART)" being what already runs for everyone. */
  const menPicked = harness({ height: 170, weight: 68, gender: "men" });
  await menPicked.api.calculateSize();
  check("gender=men renders identically to no gender at all - ZARA_SIZE_CHART was\n" +
        "        always the men's chart, nothing about it changes",
    menPicked.api.label() === "M" && menPicked.api.isWomensTops() === false);

  /* THE BOTTOMS EXCLUSION - the reason isConfidentlyPants gates this rather than
     useNumericPantsChart. A letter-sized sweatpants pair (alpha-vetoed off the waist
     chart, same product isAlphaSizeRun()'s own §9 covers) still fits on
     ZARA_SIZE_CHART, but must NOT be decorated with a TOPS dress-size token - "M (EU
     38)" would read as this app's OWN, differently-scaled pants EU convention
     (ADULT_PANTS_SIZE_CHART, 36-46). */
  const sweatpants = harness({ height: 170, weight: 68, gender: "women",
    pendingTitle: "מכנס ריצה", pendingSizes: ["S", "M", "L"] });
  await sweatpants.api.calculateSize();
  check("a letter-sized sweatpants pair (confidently pants by title) still resolves\n" +
        "        the same letter on ZARA_SIZE_CHART...",
    sweatpants.api.getUserSize() === "M", sweatpants.api.getUserSize());
  check("...but a woman shopper is NOT shown a tops EU token on it - it would collide\n" +
        "        with this app's own pants EU convention",
    sweatpants.api.label() === "M" && sweatpants.api.isWomensTops() === false,
    sweatpants.api.label());

  /* THE EU-PANTS AND WAIST-INCH BRANCHES - already numeric, so formatSizeLabel()'s\n
     numeric lock wins first, but the flag itself must also stay false. */
  const euPants = harness({ height: 170, weight: 78, gender: "women", pendingSizes: ["36", "38", "40", "42"] });
  await euPants.api.calculateSize();
  check("an EU-numeric pants product with a woman shopper stays on the bare numeric\n" +
        "        token, not a tops EU token wearing the same digits",
    euPants.api.isNumericPants() === true && euPants.api.isWomensTops() === false,
    euPants.api.label());

  /* THE CHILD EXCLUSION - WOMEN_TOPS_EU_SIZE_CHART has no child rows. */
  const girlsBody = harness({ height: 140, weight: 30, gender: "women", pendingSizes: ["8", "10", "12", "14"] });
  await girlsBody.api.calculateSize();
  check("a child-bodied shopper on a kids product keeps the kids suffix, gender or not",
    girlsBody.api.getSizeCategory() === "child" &&
    girlsBody.api.label() === "10 sizeLabelKidsSuffix" &&
    girlsBody.api.isWomensTops() === false,
    girlsBody.api.label());

  /* THE FLAG MUST BE CLEARED ON THE EARLY-RETURN PATHS, same reason isNumericPants()\n
     already gets this coverage above. */
  const clearedGender = harness({ height: 170, weight: 68, gender: "women" });
  await clearedGender.api.calculateSize();
  clearedGender.els.weight.value = "";
  await clearedGender.api.calculateSize();
  check("clearing a measurement resets the women's-tops flag too (no stale decoration)",
    clearedGender.api.isWomensTops() === false);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
