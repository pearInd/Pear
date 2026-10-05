/* ADULT NUMERIC PANTS SIZING - a second adult chart, chosen by the product's own
   evidence, not a guess.

   WHAT THIS ADDS: until now every adult body was sized against ONE chart
   (ZARA_SIZE_CHART, letters S-XL) regardless of whether the garment was a top or a
   pair of trousers. A store that sells pants in the EU numeric convention (36-46)
   has no letter sizes at all, so a shopper trying those on was being fitted against
   a chart that describes a completely different measurement system.

   ADULT_PANTS_SIZE_CHART is a second adult chart, keyed by the EU numbers
   themselves, with waist/hip bands in place of ZARA_SIZE_CHART's chest/legs.
   calculateSize() picks it over ZARA_SIZE_CHART only when isAdultNumericPantsGarment()
   says so - same "the product's own size list decides" precedent isKidsProduct()/
   isAdultProduct() already established for kids-vs-adult, applied here for one more
   question: not just kids-vs-adult, but WHICH adult chart. Never a guess: a letter
   scale, a mixed/foreign list, or no list at all stays on ZARA_SIZE_CHART.

   Structured like kids-product-sizes.test.mjs: pure functions are extracted and
   executed for real against real inputs, and calculateSize() itself is executed
   end-to-end against a mocked DOM to pin the chart-selection, the numeric display,
   and the chart-aware overflow guard together. */
import { readFileSync } from "node:fs";

/* THE FIT RUNS SERVER-SIDE since 2026-09-26 (lib/sizing.js behind POST /api/size), and
   so do the product rules that pick its chart (isAdultPantsProduct(), isWaistInchSizeRun(),
   isAdultNumericPantsGarment()…) - both are imported from there. calculateSize() asks for
   the fit through requestSizeVerdict(), defined just outside the Screen 1 slice - every
   harness below injects this stand-in, which runs the REAL module in-process through the
   same sanitiser and a JSON round trip. calculateSize() returns a Promise now; calls await it. */
const SIZING_LIB = await import("../lib/sizing.js");
const requestSizeVerdict = (evidence) =>
  Promise.resolve(SIZING_LIB.computeSizeVerdict(SIZING_LIB.sanitizeSizeEvidence(JSON.parse(JSON.stringify(evidence)))));

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

console.log("── §1 ADULT_PANTS_SIZE_CHART / isAdultPantsProduct(): the chart and its own confidence rule ──");
{
  const { isAdultPantsProduct, isWaistInchSizeRun, isAdultProduct, isKidsProduct } = SIZING_LIB;
  const { ADULT_PANTS_SIZE_CHART, coreHwPenalty } = SIZING_LIB;

  check("the chart carries the EU ladder 36-46, one row per even size",
    JSON.stringify(ADULT_PANTS_SIZE_CHART.map((r) => r.size)) ===
    JSON.stringify(["36", "38", "40", "42", "44", "46"]));

  check("every row carries waist AND hip bands (fitted on those, not chest)",
    ADULT_PANTS_SIZE_CHART.every((r) =>
      Number.isFinite(r.minWaist) && Number.isFinite(r.maxWaist) &&
      Number.isFinite(r.minHips) && Number.isFinite(r.maxHips)));

  check("coreHwPenalty() (the shared scorer) works against this chart unmodified - a\n" +
        "        170cm/78kg body genuinely fits EU 42 (170-180cm/70-82kg)",
    coreHwPenalty(ADULT_PANTS_SIZE_CHART.find((r) => r.size === "42"), 170, 78) === 0);

  check("a real EU pants size list is confidently pants-numeric",
    isAdultPantsProduct(["36", "38", "40", "42", "44"]) === true);

  check("case/whitespace-insensitive, comma-string form parses like an array",
    isAdultPantsProduct(" 38 ,40,42") === true);

  check("a letter scale is never pants-numeric, even mixed with a pants number",
    isAdultPantsProduct(["S", "M", "L"]) === false &&
    isAdultPantsProduct(["36", "38", "M"]) === false);

  check("the kids numeric ladder is never pants-numeric (disjoint ranges)",
    isAdultPantsProduct(["8", "10", "12"]) === false);

  check("no size list at all - never guess pants-numeric",
    isAdultPantsProduct([]) === false && isAdultPantsProduct(null) === false && isAdultPantsProduct(undefined) === false);

  check("THE 26-40 REPORT, RESOLVED A DIFFERENT WAY: a realistic US/UK jeans run that\n" +
        "        shares only SOME values with the EU chart's own six (36/38/40/42/44/46)\n" +
        "        is correctly NOT EU-numeric - ADULT_JEANS_WAIST_CHART (a genuine second\n" +
        "        chart, added after this test was first written) now owns runs like this\n" +
        "        one instead of EU force-fitting them via snap-to-list; see\n" +
        "        isWaistInchSizeRun() below and test/numeric-pants-sizing.test.mjs for the\n" +
        "        chart-precise end-to-end coverage. The original bug this closed - this\n" +
        "        run falling all the way back to LETTERS - stays fixed either way",
    isAdultPantsProduct(["26", "28", "30", "32", "34", "36", "38", "40"]) === false &&
    isWaistInchSizeRun(["26", "28", "30", "32", "34", "36", "38", "40"]) === true);

  check("a numeric run entirely below the EU chart's values (e.g. a waist-inch run) is\n" +
        "        NOT EU-numeric either, for the same reason - it belongs to the waist-inch\n" +
        "        chart, not a snap-fit onto the EU one",
    isAdultPantsProduct(["30", "32", "34"]) === false &&
    isWaistInchSizeRun(["30", "32", "34"]) === true);

  check("...but a run below the waist floor (24) is NOT a waist-inch run either -\n" +
        "        indistinguishable from a kids numeric ladder or a shirt neck size, so it\n" +
        "        correctly abstains on BOTH numeric-pants checks",
    isAdultPantsProduct(["14", "16", "18"]) === false &&
    isWaistInchSizeRun(["14", "16", "18"]) === false);

  check("...and a run above the ceiling (48) is NOT either - outside any plausible\n" +
        "        adult waist measurement",
    isAdultPantsProduct(["50", "52", "54"]) === false &&
    isWaistInchSizeRun(["50", "52", "54"]) === false);

  check("a 3-digit token (never a plausible waist size) is rejected, not coerced",
    isAdultPantsProduct(["100", "36", "38"]) === false);

  check("BOUNDARY, ON THE WAIST-INCH CHECK NOW (isAdultPantsProduct is EU-exact-\n" +
        "        membership only, so 24/48 were never its boundary to begin with): the\n" +
        "        floor (24) and ceiling (48) are themselves INCLUSIVE for a waist run",
    isWaistInchSizeRun(["24"]) === true && isWaistInchSizeRun(["48"]) === true);
  check("BOUNDARY: one below the floor (23) or one above the ceiling (49) is NOT a\n" +
        "        waist-inch run either",
    isWaistInchSizeRun(["23"]) === false && isWaistInchSizeRun(["49"]) === false);
  check("...and neither boundary is ever EU-numeric - 24 and 48 are not among the\n" +
        "        chart's own six values",
    isAdultPantsProduct(["24"]) === false && isAdultPantsProduct(["48"]) === false);

  check("isAdultProduct() still calls an EU pants list adult (not kids) - unaffected\n" +
        "        by the new chart, since pants numerics were already outside\n" +
        "        KIDS_NUMERIC_SIZES before this feature existed",
    isAdultProduct(["36", "38", "40"], "uncertain") === true);

  check("...and isKidsProduct() still calls it not-kids",
    isKidsProduct(["36", "38", "40"], "uncertain") === false);
}

console.log("\n── §2 isAdultNumericPantsGarment(): sizing evidence, narrowed by a known item ──");
{
  /* The REAL rule, server-side since 2026-09-26. isBottomsGarment() - the garment-region
     classifier the browser shares with the prompt pipeline - stayed in app.js, so its
     verdict now travels as item.bottoms: true, false, or null when the browser had none.
     null keeps the old "typeof isBottomsGarment" guard's meaning - no verdict, no veto. */
  const { isAdultNumericPantsGarment } = SIZING_LIB;

  check("Screen 1, no item known yet (the common case - see resolvedGarmentSizes()'s\n" +
        "        two-stage comment): sizing evidence alone decides",
    isAdultNumericPantsGarment(["36", "38", "40"], null) === true);
  check("...and a non-pants size list alone decides false, with no item either",
    isAdultNumericPantsGarment(["S", "M", "L"], null) === false);

  check("a known BOTTOMS item does not override a genuine pants-numeric list",
    isAdultNumericPantsGarment(["36", "38", "40"], { type: "pants", bottoms: true }) === true);

  check("THE NARROWING CASE: a numeric list that reads as pants-numeric, but the item\n" +
        "        is CONFIDENTLY NOT bottoms (e.g. an EU-numbered top run - see\n" +
        "        categoryFromSizeRun()'s own note that an EU run is genuinely ambiguous\n" +
        "        with tops) - the known category wins, ZARA_SIZE_CHART stays in play",
    isAdultNumericPantsGarment(["36", "38", "40"], { type: "shirt", bottoms: false }) === false);
  check("...and a non-pants list with a known non-bottoms item is still false",
    isAdultNumericPantsGarment(["S", "M", "L"], { type: "shirt", bottoms: false }) === false);
  check("an item the browser had NO bottoms verdict for (null) vetoes nothing - the old\n" +
        "        missing-classifier behaviour, not a silent 'false'",
    isAdultNumericPantsGarment(["36", "38", "40"], { type: "shirt", bottoms: null }) === true);
}

console.log("\n── §3 calculateSize() END TO END: chart selection, numeric display, overflow ──");
{
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

  function harness({ height, weight, chest, waist, legs, pendingSizes = undefined, pendingAgeGroup = undefined, activeItem = null } = {}) {
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
    const t = (key) => key;   // identity - assertions below check the KEY, not localized copy

    const code = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");
    const fn = new Function("$", "t", "activeItem", "pendingSizes", "pendingAgeGroup", "localStream", "requestSizeVerdict",
      // currentUserGender lives with the rest of the top-of-file state (declared
      // well before "const CHILD_SIZE_SCALE = [", this slice's start marker), same
      // reason currentUserSize/currentSizeCategory/currentBodyCategory are shadowed
      // here rather than read off app.js's own declaration (CLAUDE.md §2.6/§2.7).
      "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null, currentUserGender = null;\n" +
      code +
      "\nreturn { calculateSize, isCompatibleSizeCategory, getUserSize: () => currentUserSize, " +
      "getSizeCategory: () => currentSizeCategory, getBodyCategory: () => currentBodyCategory };"
    );
    // updateSizeMismatchUI() (called at the end of calculateSize()) reads localStream
    // to gate captureBtn - a live camera stream is irrelevant to this suite's
    // assertions, so a truthy stand-in keeps that gate out of the way.
    const api = fn($, t, activeItem, pendingSizes, pendingAgeGroup, {}, requestSizeVerdict);
    return { api, els };
  }

  /* THE CORE CASE: a product whose real size list is the EU pants ladder. */
  const pants = harness({ height: 170, weight: 78, waist: 79, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await pants.api.calculateSize();
  check("a pants-numeric product recommends a NUMERIC EU size (42: 170-180cm/70-82kg)",
    pants.api.getUserSize() === "42", pants.api.getUserSize());
  check("...displayed CLEANLY - no letter code, no kids-style suffix",
    pants.els.sizeResult.innerText === "42", pants.els.sizeResult.innerText);
  check("...still categorised 'adult' (the kids/adult guard is unaffected by which\n" +
        "        adult chart was used)",
    pants.api.getSizeCategory() === "adult");
  check("...and Continue is enabled",
    pants.els["btn-next-screen"].disabled === false);

  /* Waist fine-tunes WHICH pants row wins, same overlap logic ZARA_SIZE_CHART uses -
     168cm/63kg genuinely fits BOTH 38 (160-170cm/55-65kg) and 40 (165-175cm/62-73kg). */
  const pantsWaistLow = harness({ height: 168, weight: 63, waist: 69, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await pantsWaistLow.api.calculateSize();
  check("a low waist reading (69cm, inside 38's 68-74cm band but below 40's 72-79cm)\n" +
        "        pulls the recommendation to the smaller of two genuinely-fitting rows",
    pantsWaistLow.api.getUserSize() === "38", pantsWaistLow.api.getUserSize());

  /* A plain letter-sized product is completely unaffected - 179cm/80kg genuinely
     fits ZARA_SIZE_CHART's L row (178-186cm/75-87kg) and no other. */
  const letters = harness({ height: 179, weight: 80, pendingSizes: ["S", "M", "L", "XL"] });
  await letters.api.calculateSize();
  check("a letter-sized product still recommends a LETTER size, unaffected by the new chart",
    letters.api.getUserSize() === "L", letters.api.getUserSize());

  /* No product size list at all: never guess pants, ZARA_SIZE_CHART stays the default. */
  const noList = harness({ height: 179, weight: 80 });
  await noList.api.calculateSize();
  check("no product size list at all: falls back to ZARA_SIZE_CHART's letters, never\n" +
        "        a numeric guess",
    /^(XS|S|M|L|XL|XXL|3XL)$/.test(noList.api.getUserSize()), noList.api.getUserSize());

  /* THE OVERFLOW GUARD, CHART-AWARE. Updated 2026-09-14: the FOX top update added an
     XXL row to ZARA_SIZE_CHART (190-205cm/93-112kg), which now reaches HIGHER than
     ADULT_PANTS_SIZE_CHART's own ceiling (195cm/102kg) - the polarity is the opposite
     of what it was before that update (the letter chart used to be the lower ceiling
     of the two), but the thing being proven is the same: the guard reads the
     RESOLVED chart's own ceiling, not a hardcoded one, so a body can overflow one
     chart while genuinely fitting the other depending on which garment it's on. */
  const overflowsLettersOnly = harness({ height: 198, weight: 105, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await overflowsLettersOnly.api.calculateSize();
  check("198cm/105kg on a PANTS product: ABOVE the EU pants chart's own ceiling\n" +
        "        (195cm/102kg) - overflow, not a silent guess",
    overflowsLettersOnly.els.sizeResult.innerText === "sizeResultOverflow",
    overflowsLettersOnly.els.sizeResult.innerText);
  check("...Continue stays LOCKED",
    overflowsLettersOnly.els["btn-next-screen"].disabled === true);
  check("...and no size is recommended",
    overflowsLettersOnly.api.getUserSize() === null);

  const overflowsLettersProduct = harness({ height: 198, weight: 105, pendingSizes: ["S", "M", "L", "XL"] });
  await overflowsLettersProduct.api.calculateSize();
  check("THE SAME 198cm/105kg body on a LETTER product: within ZARA_SIZE_CHART's own\n" +
        "        (post-FOX, XXL-extended) ceiling - resolves to XXL, not an overflow",
    overflowsLettersProduct.api.getUserSize() === "XXL", overflowsLettersProduct.api.getUserSize());
  check("...Continue is enabled",
    overflowsLettersProduct.els["btn-next-screen"].disabled === false);

  /* Genuinely out of BOTH charts. */
  const overflowsBoth = harness({ height: 205, weight: 115, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await overflowsBoth.api.calculateSize();
  check("a body above EVERY chart's ceiling still gets the overflow copy on the pants\n" +
        "        chart too, and Continue stays locked",
    overflowsBoth.els.sizeResult.innerText === "sizeResultOverflow" &&
    overflowsBoth.els["btn-next-screen"].disabled === true);

  /* The real GAP-BETWEEN-CHARTS case (not an overflow) must still say the GENERIC
     no-match copy, distinguishing "no bigger size exists" from "this body sits in
     neither chart's band". */
  const genuineGap = harness({ height: 176, weight: 62, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  await genuineGap.api.calculateSize();
  check("a body in the genuine gap between chart rows (not above the ceiling) gets the\n" +
        "        GENERIC no-match copy, not the overflow copy",
    genuineGap.els.sizeResult.innerText === "sizeResultNoMatch", genuineGap.els.sizeResult.innerText);

  /* SNAP TO THE PRODUCT'S OWN LIST, EU chart, end to end. NOTE: this used to run against
     a "26-40" style list, back when isAdultPantsProduct() was widened to treat ANY
     24-48 numeric run as EU-pants. Now that ADULT_JEANS_WAIST_CHART exists and owns runs
     like that (see §1's "THE 26-40 REPORT, RESOLVED A DIFFERENT WAY" and
     pantsChartForSizes()'s own comment), a "26-40" list is no longer EU at all - it's a
     waist-inch product, and calculateSize() correctly stops applying this EU-specific
     snap step to it (isAdultPantsProduct(["26",...,"40"]) is now false, so
     useAdultPantsChart - the gate this snap step reads - is false too). This section is
     rewritten with a genuinely EU-shaped list instead, so it still exercises the real
     snap mechanism rather than a scenario the chart-selection layer no longer routes
     here. The 170cm/78kg body below genuinely fits EU 42 (170-180cm/70-82kg, per §1's
     coreHwPenalty check) - a size this specific product does not stock - so the snap
     step must move the recommendation to 40, the closest EU size actually on the shelf,
     never inventing 42 and never falling back to a letter. */
  const snapDown = harness({ height: 170, weight: 78, waist: 79, pendingSizes: ["36", "38", "40"] });
  await snapDown.api.calculateSize();
  check("THE FIX: a body whose genuine EU chart fit (42) isn't in the product's own\n" +
        "        list snaps to 40 - the closest EU size this product actually sells",
    snapDown.api.getUserSize() === "40", snapDown.api.getUserSize());
  check("...displayed cleanly as a plain number, no letter, no fabricated size",
    snapDown.els.sizeResult.innerText === "40", snapDown.els.sizeResult.innerText);
  check("...still categorised 'adult' and Continue enabled - a product-list gap is\n" +
        "        never a block",
    snapDown.api.getSizeCategory() === "adult" && snapDown.els["btn-next-screen"].disabled === false);

  /* The mirror case: the genuine chart fit (38 for a smaller body) IS already in a
     product's own EU list - no snap needed, and snapping must never move a
     recommendation that was already correct. */
  const noSnapNeeded = harness({ height: 162, weight: 60, pendingSizes: ["36", "38", "40"] });
  await noSnapNeeded.api.calculateSize();
  check("a genuine chart fit that IS already in the product's own list is left alone\n" +
        "        (162cm/60kg fits EU 38: 160-170cm/55-65kg, and 38 is in this list)",
    noSnapNeeded.api.getUserSize() === "38", noSnapNeeded.api.getUserSize());

  /* TIE-BREAK: the chart anchor (42) sits EXACTLY equidistant (4) from both 38 and 46
     in this product's own list. Pinning this deterministically rather than leaving it
     to whichever order Array.reduce happens to visit - the snap must always resolve
     to ONE size, never throw, never alternate between runs.

     ORDER-INDEPENDENCE, SPECIFICALLY: a plain `reduce` with no initial value seeds its
     accumulator from ownNumericSizes[0] - i.e. whichever size the STORE'S OWN DOM
     happened to list first - and a strict `<` comparison never dislodges that seed on
     an exact tie. Every list elsewhere in this file happens to be written ascending, so
     that bug would have read as "prefers the lower size" and passed unnoticed. Testing
     the SAME two candidates in BOTH orders is what actually proves the code prefers the
     smaller VALUE, not merely the first-scraped one - see calculateSize()'s own
     "TIE-BREAK IS AN EXPLICIT 'prefer smaller' RULE" comment for the fix. */
  const snapTieAscending = harness({ height: 170, weight: 78, waist: 79, pendingSizes: ["38", "46"] });
  await snapTieAscending.api.calculateSize();
  check("TIE-BREAK (ascending list order): equidistant candidates (38 and 46, both 4\n" +
        "        away from the 42 anchor) resolve to the lower of the two",
    snapTieAscending.api.getUserSize() === "38", snapTieAscending.api.getUserSize());

  const snapTieDescending = harness({ height: 170, weight: 78, waist: 79, pendingSizes: ["46", "38"] });
  await snapTieDescending.api.calculateSize();
  check("TIE-BREAK (DESCENDING list order - the store scraped its sizes in the\n" +
        "        opposite order): the SAME two equidistant candidates still resolve to\n" +
        "        38, proving the rule is 'prefer the smaller value', not 'prefer\n" +
        "        whichever the store happened to list first'",
    snapTieDescending.api.getUserSize() === "38", snapTieDescending.api.getUserSize());
}

console.log("\n── §4 activeSizeLadder() / getSizeDelta(): THE 26-40 REPORT'S OTHER HALF ──");
{
  /* getSizeDelta() used to index into the fixed SIZE_SCALE (letters) no matter what -
     so a numeric pants override always scored -1/-1 and silently returned 0, meaning
     getFitModifier() (LIVE on the wire, CLAUDE.md §0) always described a numeric-pants
     size-up/down as "true to size". activeSizeLadder() is the fix: SIZE_SCALE for a
     letter product, the product's own ascending numeric list for an adult-pants one.
     Extracted narrowly with its real dependencies (resolvedGarmentSizes,
     productVerdictNow, SIZE_SCALE, activeItem) INJECTED as parameters - this is the real
     function body, not a re-implementation. Since 2026-09-26 the "is this product's own
     list a numeric pants ladder" answer is lib/sizing.js's (adultNumericPants on the
     product verdict), read through productVerdictNow(); the stand-in below answers it
     with a deliberately WIDE rule so the ladder mechanics are exercised on a 26-40 run. */
  const code = extract(APP, "function activeSizeLadder() {", "/* getFitModifier(), FABRIC_PHYSICS");
  function harness({ sizes, currentSizeCategory = "adult", currentUserSize = null, activeTryOnSize = null,
                     verdictUnknown = false } = {}) {
    const wideNumeric = (list) => {
      const l = (Array.isArray(list) ? list : []).map((s) => String(s).trim().toUpperCase());
      return l.length > 0 && l.every((s) => /^\d{1,2}$/.test(s) && Number(s) >= 24 && Number(s) <= 48);
    };
    const productVerdictNow = verdictUnknown ? () => null
      : () => ({ adultNumericPants: wideNumeric(sizes ?? []) });
    const fn = new Function(
      "resolvedGarmentSizes", "productVerdictNow", "SIZE_SCALE", "activeItem",
      "currentSizeCategory", "currentUserSize", "activeTryOnSize",
      code + "\nreturn { activeSizeLadder, getSizeDelta };"
    );
    return fn(
      () => sizes ?? [], productVerdictNow, ["XS", "S", "M", "L", "XL", "XXL", "3XL"], null,
      currentSizeCategory, currentUserSize, activeTryOnSize
    );
  }

  const lettersApi = harness({ sizes: [], currentUserSize: "M", activeTryOnSize: "L" });
  check("a letter product's ladder IS SIZE_SCALE",
    JSON.stringify(lettersApi.activeSizeLadder()) === JSON.stringify(["XS", "S", "M", "L", "XL", "XXL", "3XL"]));
  check("...and its delta still works exactly as before (M -> L is +1)",
    lettersApi.getSizeDelta() === 1);

  const pantsApi = harness({
    sizes: ["26", "28", "30", "32", "34", "36", "38", "40"], currentUserSize: "34", activeTryOnSize: "38",
  });
  check("THE FIX: a pants product's ladder is its OWN sizes, ascending",
    JSON.stringify(pantsApi.activeSizeLadder()) ===
    JSON.stringify(["26", "28", "30", "32", "34", "36", "38", "40"]));
  check("THE BUG THIS CLOSES: 34 -> 38 on a numeric pants product is +2 steps, not the\n" +
        "        silent 0 SIZE_SCALE.indexOf('34') used to return",
    pantsApi.getSizeDelta() === 2, pantsApi.getSizeDelta());

  const pantsDownApi = harness({
    sizes: ["26", "28", "30", "32", "34", "36", "38", "40"], currentUserSize: "36", activeTryOnSize: "30",
  });
  check("...and sizing DOWN on the same ladder is correctly negative (36 -> 30 is -3)",
    pantsDownApi.getSizeDelta() === -3, pantsDownApi.getSizeDelta());

  const childApi = harness({ sizes: [], currentSizeCategory: "child", currentUserSize: "10", activeTryOnSize: "14" });
  check("a child size still unconditionally returns 0, unaffected by the ladder change",
    childApi.getSizeDelta() === 0);

  const missingApi = harness({ sizes: ["36", "38", "40"], currentUserSize: null, activeTryOnSize: "38" });
  check("no currentUserSize yet -> 0, not a throw",
    missingApi.getSizeDelta() === 0);

  const unknownApi = harness({ sizes: ["36", "38", "40"], verdictUnknown: true, currentUserSize: "36", activeTryOnSize: "40" });
  check("while the server's product verdict is still in flight, the ladder is SIZE_SCALE -\n" +
        "        the letter answer, never a guess (and the delta abstains to 0, not a throw)",
    JSON.stringify(unknownApi.activeSizeLadder()) === JSON.stringify(["XS", "S", "M", "L", "XL", "XXL", "3XL"]) &&
    unknownApi.getSizeDelta() === 0);
}

console.log("\n── §5 setSizeOverride()'s onLadder check reads the same ladder ──");
{
  // Structural check, same convention kids-adult-size-guard.test.mjs §2 uses for
  // goLive() wiring: setSizeOverride() is DOM-heavy (querySelectorAll, applyActive(),
  // toast()) and not worth mocking a whole DOM for - what actually matters is that its
  // "is this a meaningful delta" gate reads activeSizeLadder() and not the old
  // hardcoded SIZE_SCALE, which is a one-line, greppable fact about the real source.
  const ov = extract(APP, "function setSizeOverride(size) {", "\nfunction ");
  check("setSizeOverride() derives onLadder from activeSizeLadder(), not a hardcoded SIZE_SCALE",
    /const ladder = activeSizeLadder\(\);/.test(ov) &&
    /ladder\.includes\(currentUserSize\) && ladder\.includes\(size\)/.test(ov),
    ov);
  check("...and no longer references SIZE_SCALE directly for that gate",
    !/SIZE_SCALE\.includes/.test(ov), ov);
}

console.log("\n── §6 init(): pendingSizes seeded from the SYNCHRONOUS URL handoff, not left to the async postMessage ──");
{
  /* THE LIVE BUG THIS CLOSES: "185cm/82kg on a numeric jeans product still shows 'L'."
     Every check above (§1-§5) proves isAdultPantsProduct()/calculateSize()'s chart
     selection and snap-to-list logic are correct ONCE THEY RECEIVE A REAL SIZE LIST.
     They were never the problem. The actual defect was one level up: pear-widget.js
     scrapes the host product's real size list off the store page's own DOM and appends
     it to the iframe URL SYNCHRONOUSLY (?garment_sizes=...) before this room even
     opens - no classifier round trip needed. parseHandoff() reads that param into
     `handoff.sizes` inside init() - but until this fix, NOTHING ever copied it into
     `pendingSizes`, the only place resolvedGarmentSizes() can find it before activeItem
     exists (activeItem is built later, in enterRoom(), which is Screen 2 - see that
     function's own two-stage comment). The ONLY prior writer of pendingSizes was the
     late, async PEAR_UPDATE_GARMENT postMessage - a real signal, but not what the
     shopper's FIRST keystroke on Screen 1 (or routeUser()'s returning-user instant-skip
     fast path, which calls calculateSize() directly with no Screen 1 at all) has to
     work with. Concretely: every #sizeForm keystroke evaluated
     isAdultNumericPantsGarment([], null) against an empty list - always false, no
     matter how the product was actually sized - so EVERY numeric jeans/pants product
     scored the shopper's body against ZARA_SIZE_CHART's letters. By the time
     enterRoom() parses the handoff a SECOND time and finally builds a real
     activeItem.sizes, the wrong letter is already sitting in currentUserSize, and
     nothing downstream recomputes it (setActiveItem() never calls calculateSize() -
     see that function's own comment from the currentBodyCategory staleness fix). */

  console.log("   · wiring: the seed happens before ANYTHING can call calculateSize()");
  const initSrc = extract(APP, "function init() {",
    '\nif (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);');
  const handoffIdx = initSrc.indexOf("const handoff = parseHandoff();");
  const seedIdx = initSrc.indexOf("if (handoff && handoff.sizes) pendingSizes = handoff.sizes;");
  const inputWireIdx = initSrc.indexOf('addEventListener("input", calculateSize)');
  const identityGateIdx = initSrc.indexOf("setupIdentityGate();");
  check("init() reads the handoff, then seeds pendingSizes from it",
    handoffIdx !== -1 && seedIdx !== -1 && handoffIdx < seedIdx);
  check("...BEFORE #sizeForm's own inputs are wired to calculateSize() (every\n" +
        "        keystroke on Screen 1 reaches it through this listener)",
    seedIdx !== -1 && inputWireIdx !== -1 && seedIdx < inputWireIdx);
  check("...and BEFORE setupIdentityGate() - routeUser()'s returning-user instant-skip\n" +
        "        fast path calls calculateSize() directly, with Screen 1 never shown at all",
    seedIdx !== -1 && identityGateIdx !== -1 && seedIdx < identityGateIdx);

  console.log("\n   · the seed line itself: real handoff shapes in, real pendingSizes out");
  // Sliced out of initSrc (already isolated to init()'s own body above), NOT out of APP
  // directly - "const handoff = parseHandoff();" is not unique across the file
  // (enterRoom() declares the same local name for its own, later, handoff read), and
  // extract()'s first-occurrence rule would otherwise grab THAT one instead - see
  // CLAUDE.md §2.6 on why extract markers must never collide.
  const seedSnippet = extract(initSrc, "const handoff = parseHandoff();",
    'console.group("[PEAR] init() - fitting room startup");');
  function runSeed(fakeHandoff) {
    const fn = new Function("parseHandoff", "let pendingSizes;\n" + seedSnippet + "\nreturn pendingSizes;");
    return fn(() => fakeHandoff);
  }
  check("a real widget handoff's raw comma-string size list lands in pendingSizes\n" +
        "        byte-for-byte (never re-parsed here - every reader normalises via\n" +
        "        parseSizeList() downstream)",
    runSeed({ name: "Jeans", sizes: "26,28,30,32,34,36,38,40" }) === "26,28,30,32,34,36,38,40");
  check("no handoff at all (catalog/demo mode, no garment in the URL): pendingSizes\n" +
        "        stays undefined, never a crash on `handoff.sizes`",
    runSeed(null) === undefined);
  check("a handoff with no sizes field at all leaves pendingSizes undefined too -\n" +
        "        distinguishable from 'the product genuinely lists no sizes'",
    runSeed({ name: "Something" }) === undefined);

  console.log("\n   · END TO END, THE EXACT REPORTED SCENARIO: 185cm/82kg on a real jeans handoff");
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
  async function endToEnd({ handoffSizes, height, weight }) {
    // Stage 1: the REAL init() seed snippet, fed a REAL widget-shaped handoff -
    // exactly the object parseHandoff() returns for a live ?garment_sizes= embed.
    const pendingSizes = runSeed({ name: "Jeans", sizes: handoffSizes });

    // Stage 2: the REAL calculateSize(), fed EXACTLY what stage 1 produced - not a
    // hand-picked array like §3 above, but the literal output of the seed line, so a
    // regression in EITHER stage breaks this check.
    const els = {
      height: input(height), weight: input(weight), chest: input(undefined),
      waist: input(undefined), legs: input(undefined),
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
    const t = (key) => key;
    const code = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");
    const fn = new Function("$", "t", "activeItem", "pendingSizes", "pendingAgeGroup", "localStream", "requestSizeVerdict",
      "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null, currentUserGender = null;\n" +
      code +
      "\nreturn { calculateSize, getUserSize: () => currentUserSize };"
    );
    const api = fn($, t, null, pendingSizes, undefined, {}, requestSizeVerdict);
    await api.calculateSize();
    return { api, els };
  }

  /* THIS SCENARIO'S EXPECTED VALUE CHANGED FROM "40" TO "32" - not a re-litigation of
     the fix, but a NARROWER, MORE ACCURATE downstream fix. When this test was first
     written, "26-40" was treated as EU-numeric (isAdultPantsProduct() was widened to
     accept it) and snapped to the nearest EU chart value (44 -> 40). Since then,
     ADULT_JEANS_WAIST_CHART shipped as a genuine second chart with real FOX waist-inch
     data, isAdultPantsProduct() was narrowed back to exact EU membership (see §1's "THE
     26-40 REPORT, RESOLVED A DIFFERENT WAY"), and a "26-40" run now correctly resolves
     through isWaistInchSizeRun()/pantsChartForSizes() to that chart instead - where
     185cm/82kg genuinely fits row 32 (165-190cm/65-88kg) with no snapping needed at all,
     because it's a REAL chart row, not an approximation. "32" is also what
     test/numeric-pants-sizing.test.mjs independently pins for this exact body. The
     headline claim this section exists to prove - a number, never "L" - is unchanged. */
  const jeans = await endToEnd({ handoffSizes: "26,28,30,32,34,36,38,40", height: 185, weight: 82 });
  check("THE FIX, END TO END: 185cm/82kg on a real jeans handoff recommends a NUMBER,\n" +
        "        never a letter like 'L'",
    /^\d+$/.test(jeans.api.getUserSize()), jeans.api.getUserSize());
  check("...specifically 32: a genuine, non-approximated fit on the waist-inch chart's\n" +
        "        own row 32 (165-190cm/65-88kg) - the chart this run actually belongs to",
    jeans.api.getUserSize() === "32", jeans.api.getUserSize());
  check("...and the exact DOM text the shopper reads matches",
    jeans.els.sizeResult.innerText === "32", jeans.els.sizeResult.innerText);

  // Run it again, and once more with a different body/product pair, precisely because
  // the request asked this be verified "flawlessly multiple times" rather than once -
  // a `new Function` re-parse and re-execution each time, not a cached result.
  const jeansRepeat = await endToEnd({ handoffSizes: "26,28,30,32,34,36,38,40", height: 185, weight: 82 });
  check("REPEATED RUN (fresh parse + execution): identical result, no hidden state\n" +
        "        leaking between calls",
    jeansRepeat.api.getUserSize() === "32", jeansRepeat.api.getUserSize());

  const secondBody = await endToEnd({ handoffSizes: "36,38,40,42,44,46", height: 172, weight: 78 });
  check("A DIFFERENT body/product pair (172cm/78kg, a genuinely EU-shaped run - all six\n" +
        "        of the chart's own values): still numeric, still correct (fits EU 42:\n" +
        "        170-180cm/70-82kg, already sold by this product)",
    secondBody.api.getUserSize() === "42", secondBody.api.getUserSize());

  /* This one's own rationale changed too, for the same reason as `jeans` above: "28-36"
     is a waist-inch run, not an EU one to snap down from 46. Worked out on
     ADULT_JEANS_WAIST_CHART directly: 195cm/100kg clears BOTH the height and weight
     bands of row 36 (172-198cm/78-105kg) and row 38 (174-200cm/83-112kg) with zero
     penalty and no waist measurement to break the tie, so the first of the two in chart
     order wins - "36", which this product happens to sell anyway. */
  const thirdBody = await endToEnd({ handoffSizes: "28,30,32,34,36", height: 195, weight: 100 });
  check("A THIRD body/product pair (195cm/100kg, a waist-inch run): still numeric,\n" +
        "        resolves to the waist-inch chart's own row 36 (172-198cm/78-105kg)",
    thirdBody.api.getUserSize() === "36", thirdBody.api.getUserSize());
}

console.log("\n── §7 THE STALE-currentBodyCategory RACE: closed at goLive(), not by chart juggling ──");
{
  /* TWO REAL, REPRODUCED BUGS SHIPPED BEFORE THIS SHAPE WAS REACHED:
       1. UNION-ALWAYS: checking both ZARA_SIZE_CHART and ADULT_PANTS_SIZE_CHART
          unconditionally wrongly promoted a 164cm/50kg body to "adult" on a
          GENUINELY kids-numeric product, purely because that height/weight also
          clears an irrelevant adult-pants band - blocking a legitimate child
          shopper on their own correctly-recommended kids size.
       2. UNION-WHEN-EMPTY: falling back to the union only when garmentSizes was
          empty still broke on a DIFFERENT garment later in the SAME session: a
          172cm/60kg body has a genuine ADULT_PANTS_SIZE_CHART coverage GAP (fits
          no pants row at all, though it fits ZARA-S and CHILD-18) - viewing a
          pants product first cached "child", and switching to an unrelated,
          genuinely adult LETTER product never re-ran calculateSize() (setActiveItem()
          doesn't call it, and PEAR_UPDATE_GARMENT's listener doesn't either once
          Screen 1 is hidden), so the stale "child" wrongly blocked a legitimate
          adult shopper from a completely unrelated product.
     THE ACTUAL FIX lives in goLive() (fitting-room/app.js), not here: it re-runs
     calculateSize() - cheap, synchronous, no network - immediately before its gate
     checks, so currentBodyCategory is ALWAYS freshly computed against whichever
     garment is ACTUALLY active at the moment that matters, using the SAME simple,
     single-resolved-chart rule calculateSize() has always used. This section pins
     that wiring, then reproduces both original failure scenarios as a two-call
     sequence (matching what goLive() actually does: calculateSize() ran once for
     garment A, then again for garment B, exactly as clicking Go Live on B would). */

  console.log("   · wiring: goLive() re-runs calculateSize() before its gate checks");
  const live = extract(APP, "async function goLive() {", "\nasync function ");
  check("goLive() calls calculateSize()",
    /calculateSize\(\);/.test(live), live.slice(0, 600));
  const calcIdx = live.indexOf("calculateSize();");
  const sizeIdx = live.indexOf("sizeCategoryMismatchReason()");
  const busyIdx = live.indexOf("busy = true");
  check("...BEFORE sizeCategoryMismatchReason() is read",
    calcIdx !== -1 && sizeIdx !== -1 && calcIdx < sizeIdx);
  check("...and BEFORE busy/billing state is claimed - a recompute can never itself\n" +
        "        spend anything",
    calcIdx !== -1 && busyIdx !== -1 && calcIdx < busyIdx);

  // Self-contained harness, same shape §3's own (block-scoped, not shared across
  // sections) - see that section for why each DOM stand-in is there. pendingSizes/
  // pendingAgeGroup are exposed as SETTERS on a shared `let`, so the SAME calculateSize()
  // closure can be invoked twice with different garment evidence in between - exactly
  // what a mid-session garment swap or a late correction does in the real app, and
  // exactly what going stale REQUIRES to be reproducible at all.
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
  function harness(height, weight) {
    const els = {
      height: input(height), weight: input(weight), chest: input(undefined),
      waist: input(undefined), legs: input(undefined),
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
    const t = (key) => key;
    const code = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");
    const fn = new Function("$", "t", "localStream", "requestSizeVerdict",
      "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null, currentUserGender = null;\n" +
      "let activeItem = null, pendingSizes = undefined, pendingAgeGroup = undefined;\n" +
      code +
      "\nreturn { calculateSize, isCompatibleSizeCategory, hasSizeCategoryMismatch, " +
      "getUserSize: () => currentUserSize, getSizeCategory: () => currentSizeCategory, " +
      "getBodyCategory: () => currentBodyCategory, " +
      "setGarment: (sizes, ageGroup) => { pendingSizes = sizes; pendingAgeGroup = ageGroup; } };"
    );
    const api = fn($, t, {}, requestSizeVerdict);
    return { api, els };
  }

  console.log("\n   · SCENARIO 1 (the union-always regression): a genuinely kids product");
  {
    const h = harness(164, 50);
    h.api.setGarment(["8", "10", "12", "14", "16", "18"], "kids");
    await h.api.calculateSize();   // one call is enough here - no swap involved
    check("body category reads 'child' for a genuinely kids-numeric product",
      h.api.getBodyCategory() === "child", h.api.getBodyCategory());
    check("...the recommendation is a correct kids size (16)",
      h.api.getUserSize() === "16", h.api.getUserSize());
    check("...and NO mismatch is wrongly raised against the shopper's own correct fit",
      h.api.hasSizeCategoryMismatch() === false);
  }

  console.log("\n   · SCENARIO 2 (the original stale race): no sizes yet, THEN corrected to pants");
  {
    const h = harness(164, 50);
    h.api.setGarment(undefined, "uncertain");   // Screen 1: no product evidence has arrived yet
    await h.api.calculateSize();
    check("first pass (no evidence): resolves via ZARA alone, reads 'child'\n" +
          "        (this is the CACHE going stale, exactly as it did in production)",
      h.api.getBodyCategory() === "child", h.api.getBodyCategory());

    // The correction arrives; setActiveItem()/the PEAR_UPDATE_GARMENT listener update
    // the garment's real sizes WITHOUT calling calculateSize() again. Simulated here by
    // mutating the evidence and NOT calling calculateSize() - matching the real gap.
    h.api.setGarment(["36", "38", "40", "42", "44", "46"], "uncertain");
    check("...the STALE cache still says 'child' right after the correction, before\n" +
          "        anything re-runs calculateSize() - proving the staleness is real",
      h.api.getBodyCategory() === "child");

    // goLive()'s fix: re-run calculateSize() right before checking. This is that call.
    await h.api.calculateSize();
    check("THE FIX: once calculateSize() re-runs (as goLive() now does) against the\n" +
          "        CORRECTED evidence, body category flips to the true 'adult'",
      h.api.getBodyCategory() === "adult", h.api.getBodyCategory());
    check("...and the guard now correctly reports NO mismatch",
      h.api.hasSizeCategoryMismatch() === false);
  }

  console.log("\n   · SCENARIO 3 (the union-when-empty regression): swap AWAY from a pants");
  console.log("     product with its own genuine chart-coverage gap, to an unrelated adult top");
  {
    const h = harness(172, 60);   // fits ZARA-S and CHILD-18, but NO ADULT_PANTS_SIZE_CHART row
    h.api.setGarment(["36", "38", "40", "42", "44", "46"], "uncertain");   // product A: pants, genuine gap for this body
    await h.api.calculateSize();
    check("product A (pants, genuine chart gap for 172/60): resolves 'child' and a\n" +
          "        real 'no match' on ITS OWN candidate search - not itself a bug",
      h.api.getBodyCategory() === "child" && h.api.getSizeCategory() === null,
      { bodyCategory: h.api.getBodyCategory(), sizeCategory: h.api.getSizeCategory() });

    // Shopper switches, mid-session, to an unrelated genuinely-adult letter product.
    // setActiveItem() does not call calculateSize() - simulated by NOT calling it here.
    h.api.setGarment(["S", "M"], "adult");
    check("...(stale) body category from product A leaks in: still 'child' right after\n" +
          "        the swap, before anything recomputes - the second reported failure",
      h.api.getBodyCategory() === "child");

    // goLive()'s fix, again: re-run calculateSize() right before checking.
    await h.api.calculateSize();
    check("THE FIX: re-running calculateSize() for product B alone correctly finds\n" +
          "        'adult' (172cm/60kg genuinely fits ZARA-S: 160-172cm/55-65kg)",
      h.api.getBodyCategory() === "adult", h.api.getBodyCategory());
    check("...and the guard correctly reports NO mismatch for this legitimate adult\n" +
          "        shopper on a genuinely adult product",
      h.api.hasSizeCategoryMismatch() === false);
  }

  console.log("\n   · a genuinely incompatible case is still caught");
  {
    const h = harness(179, 80);   // genuinely fits ZARA-L (178-186cm/75-87kg)
    h.api.setGarment(["8", "10", "12", "14", "16"], "kids");
    await h.api.calculateSize();
    check("a genuinely adult-only body (179cm/80kg, fits ZARA-L) against a genuinely\n" +
          "        kids-only product is correctly flagged incompatible",
      h.api.hasSizeCategoryMismatch() === true);
  }
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
