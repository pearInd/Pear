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
  const catCode = extract(APP, "const ZARA_SIZE_CHART", "function calculateSize()");
  const cat = await import("data:text/javascript," + encodeURIComponent(
    catCode + "\nexport { ADULT_PANTS_SIZE_CHART, isAdultPantsProduct, isAdultProduct, isKidsProduct, coreHwPenalty };"
  ));
  const { ADULT_PANTS_SIZE_CHART, isAdultPantsProduct, isAdultProduct, isKidsProduct, coreHwPenalty } = cat;

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

  check("an out-of-ladder numeric run (e.g. a waist-inch run) is NOT confidently\n" +
        "        pants-numeric either - only the EU chart's own sizes count",
    isAdultPantsProduct(["30", "32", "34"]) === false);

  check("isAdultProduct() still calls an EU pants list adult (not kids) - unaffected\n" +
        "        by the new chart, since pants numerics were already outside\n" +
        "        KIDS_NUMERIC_SIZES before this feature existed",
    isAdultProduct(["36", "38", "40"], "uncertain") === true);

  check("...and isKidsProduct() still calls it not-kids",
    isKidsProduct(["36", "38", "40"], "uncertain") === false);
}

console.log("\n── §2 isAdultNumericPantsGarment(): sizing evidence, narrowed by a known item ──");
{
  // Wide slice (from the chart definitions, not just resolvedGarmentAgeGroup()) so
  // ADULT_PANTS_NUMERIC_SIZES - built right beside ADULT_PANTS_SIZE_CHART, see that
  // const's own comment on why - is actually in scope for isAdultPantsProduct() below.
  const code = extract(APP, "const ZARA_SIZE_CHART", "function calculateSize()");
  // isBottomsGarment lives much later in app.js (the garment-category-detection
  // region) and is genuinely out of scope for this narrower slice - the real
  // function guards its call with `typeof isBottomsGarment === "function"` for
  // exactly this reason (see the comment above it). Injecting it here as an
  // ordinary parameter gives the extracted code a real binding to call, the same
  // way `$`/`t` are injected elsewhere in this suite - it does not change app.js.
  function harness(isBottomsGarment) {
    const fn = new Function("isBottomsGarment", code + "\nreturn { isAdultNumericPantsGarment };");
    return fn(isBottomsGarment);
  }

  const noItemKnown = harness(undefined);
  check("Screen 1, no item known yet (the common case - see resolvedGarmentSizes()'s\n" +
        "        two-stage comment): sizing evidence alone decides",
    noItemKnown.isAdultNumericPantsGarment(["36", "38", "40"], null) === true);
  check("...and a non-pants size list alone decides false, with no item either",
    noItemKnown.isAdultNumericPantsGarment(["S", "M", "L"], null) === false);

  const bottomsTrue = harness(() => true);
  check("a known BOTTOMS item does not override a genuine pants-numeric list",
    bottomsTrue.isAdultNumericPantsGarment(["36", "38", "40"], { type: "pants" }) === true);

  const bottomsFalse = harness(() => false);
  check("THE NARROWING CASE: a numeric list that reads as pants-numeric, but the item\n" +
        "        is CONFIDENTLY NOT bottoms (e.g. an EU-numbered top run - see\n" +
        "        categoryFromSizeRun()'s own note that an EU run is genuinely ambiguous\n" +
        "        with tops) - the known category wins, ZARA_SIZE_CHART stays in play",
    bottomsFalse.isAdultNumericPantsGarment(["36", "38", "40"], { type: "shirt" }) === false);
  check("...and a non-pants list with a known non-bottoms item is still false",
    bottomsFalse.isAdultNumericPantsGarment(["S", "M", "L"], { type: "shirt" }) === false);
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

    const code = extract(APP, "const ZARA_SIZE_CHART", "\nfunction onMeasurementKeydown");
    const fn = new Function("$", "t", "activeItem", "pendingSizes", "pendingAgeGroup", "localStream",
      "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null;\n" +
      code +
      "\nreturn { calculateSize, getUserSize: () => currentUserSize, getSizeCategory: () => currentSizeCategory };"
    );
    // updateSizeMismatchUI() (called at the end of calculateSize()) reads localStream
    // to gate captureBtn - a live camera stream is irrelevant to this suite's
    // assertions, so a truthy stand-in keeps that gate out of the way.
    const api = fn($, t, activeItem, pendingSizes, pendingAgeGroup, {});
    return { api, els };
  }

  /* THE CORE CASE: a product whose real size list is the EU pants ladder. */
  const pants = harness({ height: 170, weight: 78, waist: 79, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  pants.api.calculateSize();
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
  pantsWaistLow.api.calculateSize();
  check("a low waist reading (69cm, inside 38's 68-74cm band but below 40's 72-79cm)\n" +
        "        pulls the recommendation to the smaller of two genuinely-fitting rows",
    pantsWaistLow.api.getUserSize() === "38", pantsWaistLow.api.getUserSize());

  /* A plain letter-sized product is completely unaffected - 179cm/80kg genuinely
     fits ZARA_SIZE_CHART's L row (178-186cm/75-87kg) and no other. */
  const letters = harness({ height: 179, weight: 80, pendingSizes: ["S", "M", "L", "XL"] });
  letters.api.calculateSize();
  check("a letter-sized product still recommends a LETTER size, unaffected by the new chart",
    letters.api.getUserSize() === "L", letters.api.getUserSize());

  /* No product size list at all: never guess pants, ZARA_SIZE_CHART stays the default. */
  const noList = harness({ height: 179, weight: 80 });
  noList.api.calculateSize();
  check("no product size list at all: falls back to ZARA_SIZE_CHART's letters, never\n" +
        "        a numeric guess",
    /^(XS|S|M|L|XL|XXL|3XL)$/.test(noList.api.getUserSize()), noList.api.getUserSize());

  /* THE OVERFLOW GUARD, CHART-AWARE. ADULT_PANTS_SIZE_CHART's ceiling (195cm/102kg) is
     slightly ABOVE ZARA_SIZE_CHART's (195cm/100kg) - a body at 195cm/101kg overflows
     the letter chart but is still a genuine fit on the pants chart, which is exactly
     what proves the guard reads the RESOLVED chart's own ceiling, not a hardcoded one. */
  const overflowsLettersOnly = harness({ height: 195, weight: 101, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  overflowsLettersOnly.api.calculateSize();
  check("195cm/101kg on a PANTS product: within the pants chart's own ceiling (102kg)\n" +
        "        - resolves to 46, not an overflow",
    overflowsLettersOnly.api.getUserSize() === "46", overflowsLettersOnly.api.getUserSize());
  check("...Continue is enabled",
    overflowsLettersOnly.els["btn-next-screen"].disabled === false);

  const overflowsLettersProduct = harness({ height: 195, weight: 101, pendingSizes: ["S", "M", "L", "XL"] });
  overflowsLettersProduct.api.calculateSize();
  check("THE SAME 195cm/101kg body on a LETTER product: overflows ZARA_SIZE_CHART's\n" +
        "        own ceiling (100kg) - 'no size available', not a silent guess",
    overflowsLettersProduct.els.sizeResult.innerText === "sizeResultOverflow",
    overflowsLettersProduct.els.sizeResult.innerText);
  check("...Continue stays LOCKED",
    overflowsLettersProduct.els["btn-next-screen"].disabled === true);
  check("...and no size is recommended",
    overflowsLettersProduct.api.getUserSize() === null);

  /* Genuinely out of BOTH charts. */
  const overflowsBoth = harness({ height: 205, weight: 115, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  overflowsBoth.api.calculateSize();
  check("a body above EVERY chart's ceiling still gets the overflow copy on the pants\n" +
        "        chart too, and Continue stays locked",
    overflowsBoth.els.sizeResult.innerText === "sizeResultOverflow" &&
    overflowsBoth.els["btn-next-screen"].disabled === true);

  /* The real GAP-BETWEEN-CHARTS case (not an overflow) must still say the GENERIC
     no-match copy, distinguishing "no bigger size exists" from "this body sits in
     neither chart's band". */
  const genuineGap = harness({ height: 176, weight: 62, pendingSizes: ["36", "38", "40", "42", "44", "46"] });
  genuineGap.api.calculateSize();
  check("a body in the genuine gap between chart rows (not above the ceiling) gets the\n" +
        "        GENERIC no-match copy, not the overflow copy",
    genuineGap.els.sizeResult.innerText === "sizeResultNoMatch", genuineGap.els.sizeResult.innerText);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
