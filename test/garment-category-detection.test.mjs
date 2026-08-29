/* "מכנס קצר רגל - FOX" WAS FITTED AS A SHIRT, AND LABELLED "בגד עליון שהעלית".

   This is the tier BELOW garment-category-prompt.test.mjs. That suite proved the PROMPT
   branches correctly once the category is known; this one is about the category being
   wrong in the first place, which made the correct branch pick the wrong side.

   ── THE FIVE MISSES, all in widget/pear-widget.js's CATEGORY_KEYWORDS ────────────
   Every one is a real Hebrew title from the storefront, and every one landed on
   DEFAULT_CATEGORY = "tops":

     · "מכנס קצר רגל - FOX"  the list holds "מכנסיים" (plural). Hebrew inflects by
                             SUFFIX, so a substring test for the plural cannot match the
                             singular stem. This is the reported item.
     · "ברמודה" / "שורטס"    absent from the list entirely.
     · "ג'ינס"               the list spells it with the Hebrew geresh U+05F3 (ג׳ינס);
                             storefronts routinely type an ASCII apostrophe U+0027.
                             Two different codepoints, one visually identical word.
     · "חצאית"               present, but filed under `dress` - and app.js only ever
                             treated "pants"/"bottoms" as lower-body, so a skirt read
                             as a top.

   AND THE TOPS SIDE WAS BROKEN THE SAME WAY, merely masked: "חולצת פולו" does not match
   "חולצה" either (חולצה → חולצת is the construct state, another suffix change). It
   classified correctly only because the fallback happened to be "tops" - which means the
   fallback was hiding the bug it was also causing.

   ── WHY STEMS, AND WHY THAT IS THE WHOLE FIX ─────────────────────────────────────
   Hebrew marks plural, construct state and possessives by appending to the stem. Matching
   the fully-inflected surface form is guaranteed to miss; matching the STEM (מכנס, חולצ,
   חצאי) matches every inflection of it. The English side keeps word boundaries, because
   English compounds the other way and \bshort\b would swallow "short sleeve".

   WHAT THIS SUITE PINS:
     §1  the reported title, and every sibling that shares its failure;
     §2  the tops side, including the construct-state case the fallback was masking;
     §3  ambiguity is reported as ambiguity - null, not a coin flip toward "top";
     §4  the resolution chain's PRIORITY: explicit metadata outranks a title guess,
         which outranks an LLM, which outranks the default;
     §5  the Gemini tier is consulted ONLY when tier 1 abstains, is bounded, and
         degrades to a usable answer on every failure path;
     §6  the UI label is bound to the resolved category, not hardcoded;
     §7  the widget and the fitting room agree - a category resolved in one must not be
         re-derived differently in the other. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real engine, executed. */
const code = SRC.slice(SRC.indexOf("/* ── Garment category detection"),
                       SRC.indexOf("function toItem(raw)"));
/* categoryFromSizeRun() is tier 1.5 of the same chain but lives beside the size
   vocabulary it reads (KIDS_NUMERIC_SIZES / ADULT_ALPHA_SIZES / parseSizeList), which is
   a screen above this slice. Lifted REAL rather than stubbed - a stub here would let the
   thresholds drift without this suite noticing, and the thresholds are the whole point. */
const SIZE_END = '? "bottom" : null;\n}';
const sizeCode = SRC.slice(SRC.indexOf("const KIDS_NUMERIC_SIZES"),
                           SRC.indexOf(SIZE_END) + SIZE_END.length);
const mkApi = ({ geminiImpl } = {}) => {
  const calls = [];
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    CATEGORY_LLM_TIMEOUT_MS: 2500,
    // The network seam, stubbed. Default: nobody wired one up.
    classifyGarmentViaLLM: geminiImpl || (async (t) => { calls.push(t); return null; }),
  };
  const api = new Function(...Object.keys(sandbox),
    sizeCode + "\n" + code +
    "\nreturn { classifyGarmentTitle, resolveGarmentCategory, categoryToGarmentType," +
    " GARMENT_CATEGORY_KEYWORDS, categoryFromSizeRun };")(...Object.values(sandbox));
  return { ...api, calls };
};
const api = mkApi();
const { classifyGarmentTitle } = api;

console.log("── §1 THE REPORTED BUG, and every title that shares its failure ──");
{
  /* THE ITEM FROM THE SCREENSHOT. If only one assertion in this file survives, this. */
  check('"מכנס קצר רגל - FOX" classifies as BOTTOM',
    classifyGarmentTitle("מכנס קצר רגל - FOX") === "bottom",
    `got ${classifyGarmentTitle("מכנס קצר רגל - FOX")} - the stem is מכנס, not מכנסיים`);

  const bottoms = [
    ["מכנסיים ארוכים", "the plural still works - the stem covers both"],
    ["מכנסי דגמ\"ח", "construct state (מכנסי) - another suffix, same stem"],
    ["ברמודה כותנה", "was absent from the keyword list entirely"],
    ["שורטס ספורט", "likewise absent"],
    ["חצאית מידי", "was filed under `dress`, which read as a top"],
    ["חצאיות קיץ", "...and its plural"],
    ["ג'ינס סקיני", "ASCII apostrophe U+0027"],
    ["ג׳ינס סקיני", "Hebrew geresh U+05F3 - both spellings must work"],
    ["טייץ ריצה", "leggings"],
  ];
  for (const [title, why] of bottoms) {
    check(`"${title}" → bottom`, classifyGarmentTitle(title) === "bottom", why);
  }
}

console.log("\n── §2 THE TOPS SIDE - broken the same way, masked by the fallback ──");
{
  /* "חולצת פולו" never matched "חולצה"; it only came out right because the default was
     "tops". A default that hides a detection failure is worse than no default. */
  check('"חולצת פולו" → top BY DETECTION, not by falling through',
    classifyGarmentTitle("חולצת פולו") === "top",
    "חולצה → חולצת is the construct state; the stem חולצ matches both");
  const tops = ["חולצה מכופתרת", "טישרט הדפס", "סווטשירט קפוצ'ון", "גופייה לבנה",
                "ז'קט ג'ינס", "מעיל חורף", "Oxford Shirt", "Pullover Hoodie", "Bomber Jacket"];
  for (const t of tops) check(`"${t}" → top`, classifyGarmentTitle(t) === "top");
}

console.log("\n── §3 ENGLISH: word-boundaried, because English compounds the other way ──");
{
  for (const t of ["Cargo Shorts", "Slim Fit Jeans", "Wool Trousers", "Pleated Skirt",
                   "Wide Leg Pants", "Ribbed Leggings"]) {
    check(`"${t}" → bottom`, classifyGarmentTitle(t) === "bottom");
  }
  /* THE TRAP that a stem-based Hebrew matcher must NOT be allowed to import into
     English: "short" is a prefix of "short sleeve", and a tee is not a pair of shorts. */
  check('"Short Sleeve Tee" → top, NOT bottom',
    classifyGarmentTitle("Short Sleeve Tee") === "top",
    "English needs word boundaries - only the plural 'shorts' is a garment");
  check('"Long Sleeve Shirt" → top', classifyGarmentTitle("Long Sleeve Shirt") === "top");
}

console.log("\n── §4 AMBIGUITY IS REPORTED, NOT GUESSED ──");
{
  /* The old code's sin was resolving an unknown to "tops" silently. Tier 1 abstaining is
     what lets tier 2 exist at all - if it guessed, there would be nothing to escalate. */
  check("an unrecognisable title returns null, not a default",
    classifyGarmentTitle("FOX Essentials 2024") === null,
    "abstaining is what triggers the LLM tier");
  check("empty / null / undefined input returns null without throwing",
    classifyGarmentTitle("") === null && classifyGarmentTitle(null) === null &&
    classifyGarmentTitle(undefined) === null);
  /* A title naming BOTH regions is genuinely ambiguous from text alone. */
  check("a title matching BOTH sides returns null rather than picking by list order",
    classifyGarmentTitle("Cargo Pants Print Tee") === null,
    "list order is not evidence; escalate instead");

  console.log("   -- the fabric/garment collision: ג'ינס and denim are both --");
  /* "ג'ינס" names a lower-body garment AND a material, so a denim jacket matches both
     sides. It is a TOP: the garment noun is the subject, the fabric is a modifier of it.
     Asserted in BOTH directions, because a rule that just prefers "top" on collision
     would silently turn denim TROUSERS into a shirt - the original bug, re-armed. */
  check('"ז\'קט ג\'ינס" (denim jacket) → top - the garment noun beats the fabric',
    classifyGarmentTitle("ז'קט ג'ינס") === "top");
  check('"Denim Jacket" → top', classifyGarmentTitle("Denim Jacket") === "top");
  check('"מכנס ג\'ינס" (denim trousers) → bottom - real lower-body evidence survives',
    classifyGarmentTitle("מכנס ג'ינס") === "bottom");
  check('"Denim Shorts" → bottom', classifyGarmentTitle("Denim Shorts") === "bottom");
  check('"ג\'ינס סקיני" alone is still a garment, not a fabric → bottom',
    classifyGarmentTitle("ג'ינס סקיני") === "bottom",
    "stripping the fabric word must not fire when it IS the garment");
}

console.log("\n── §5 THE RESOLUTION CHAIN: explicit metadata outranks a guess ──");
{
  const { resolveGarmentCategory } = api;
  /* Ordering is the design. A title sweep that could override a catalog's own
     garmentType would let a product NAME re-categorise an item the catalog already
     classified - strictly worse than the metadata it second-guesses. */
  check("1. explicit garmentType wins over a contradicting title",
    await resolveGarmentCategory({ garmentType: "upper_body", name: "מכנס קצר" }) === "top" &&
    await resolveGarmentCategory({ garmentType: "lower_body", name: "חולצה" }) === "bottom");
  check("2. explicit type wins over a contradicting title",
    await resolveGarmentCategory({ type: "pants", name: "חולצה" }) === "bottom" &&
    await resolveGarmentCategory({ type: "shirt", name: "מכנס" }) === "top");
  /* The widget's own vocabulary must round-trip: it emits shirt/pants/dress/outerwear,
     and "dress"/"outerwear" previously fell through to top by accident of the isPants
     test. Skirts are lower-body; outerwear is upper-body. Both stated, not inferred. */
  check("...including the widget's full vocabulary, not just pants/shirt",
    await resolveGarmentCategory({ type: "shorts" }) === "bottom" &&
    await resolveGarmentCategory({ type: "bottoms" }) === "bottom" &&
    await resolveGarmentCategory({ type: "skirt" }) === "bottom" &&
    await resolveGarmentCategory({ type: "outerwear" }) === "top");
  check("3. the title decides when there is no explicit metadata",
    await resolveGarmentCategory({ name: "מכנס קצר רגל - FOX" }) === "bottom");
  check("4. and an unknowable item still resolves to something usable",
    await resolveGarmentCategory({ name: "FOX Essentials 2024" }) === "top",
    "tops is the majority of the catalog - but it is now the LAST resort, not the first");
}

console.log("\n── §5b TIER 1.5 - THE SIZE RUN, for titles that name a cut, not a garment ──");
{
  const { categoryFromSizeRun, resolveGarmentCategory } = api;
  /* REPORTED: "STRAIGHT BASIC" and "LOOSE" ran through the TOPS pipeline while the size
     selector correctly offered 26-38. Both halves matter. Those titles name a CUT and a
     FIT - no garment noun anywhere - so every keyword tier abstains, correctly, and the
     chain fell to its silent `return "top"`. But 26-38 is a WAIST run: the product was
     stating its own region in the one field that was never ambiguous. */
  check("the reported runs resolve as bottoms",
    categoryFromSizeRun(["26","28","30","32","34","36","38"]) === "bottom" &&
    categoryFromSizeRun("26,28,30,32,34,36,38") === "bottom" &&
    categoryFromSizeRun(["30","32","34"]) === "bottom");

  console.log("   -- and it ABSTAINS on everything that is not unambiguously a waist --");
  check("letter sizes say nothing about region",
    categoryFromSizeRun(["S","M","L"]) === null &&
    categoryFromSizeRun(["28","30","M"]) === null,
    "one letter size present is enough to disqualify the run");
  check("a kids numeric run (2-18) falls below the floor",
    categoryFromSizeRun(["8","10","12","14"]) === null &&
    categoryFromSizeRun(["2","4","6"]) === null,
    "this must never fight isKidsProduct for the same tokens");
  check("a shirt NECK run (14-18) also falls below the floor",
    categoryFromSizeRun(["14","15","16","17"]) === null);
  check("an EU womens TOP run opens too high to be a waist",
    categoryFromSizeRun(["34","36","38","40","42"]) === null &&
    categoryFromSizeRun(["36","38","40"]) === null,
    "34+ is where tops open; a waist run opens at 24-32");
  check("non-numeric or empty lists abstain rather than throw",
    categoryFromSizeRun(["ONE SIZE"]) === null && categoryFromSizeRun(["36R"]) === null &&
    categoryFromSizeRun([]) === null && categoryFromSizeRun(null) === null &&
    categoryFromSizeRun(undefined) === null);
  check("it can prove a BOTTOM and never a top - a size run cannot prove a top",
    ["S,M,L", "34,36,38", "8,10,12", ""].every((s) => categoryFromSizeRun(s) !== "top"));

  console.log("   -- placed in the chain as evidence, below metadata, above the guess --");
  check("explicit metadata still outranks the size run",
    await resolveGarmentCategory({ garmentType: "upper_body", sizes: ["28","30","32"] }) === "top",
    "a catalog that classified the item is not second-guessed by its ladder");
  check("a title that DOES name a garment still outranks it",
    await resolveGarmentCategory({ name: "Oxford Shirt", sizes: ["28","30","32"] }) === "top");
  check("the reported item resolves to BOTTOM instead of defaulting to top",
    await resolveGarmentCategory({ name: "STRAIGHT BASIC", sizes: ["26","28","30","32","34","36","38"] }) === "bottom" &&
    await resolveGarmentCategory({ name: "LOOSE", sizes: ["30","32","34"] }) === "bottom");
  check("...and with no sizes it still falls through to the old default",
    await resolveGarmentCategory({ name: "STRAIGHT BASIC" }) === "top",
    "the size run adds evidence; it does not invent any");
}
{
  /* THE COST CONTROL. A per-item network round trip on every catalog card would be both
     slow and billable; tier 1 already answers the overwhelming majority. */
  const seen = [];
  const a = mkApi({ geminiImpl: async (t) => { seen.push(t); return "bottom"; } });
  await a.resolveGarmentCategory({ name: "מכנס קצר רגל - FOX" });
  check("tier 1 answering means the LLM is never called",
    seen.length === 0, `called ${seen.length} time(s) - tier 1 already knew`);
  await a.resolveGarmentCategory({ garmentType: "upper_body", name: "???" });
  check("...nor when explicit metadata answered", seen.length === 0);

  const verdict = await a.resolveGarmentCategory({ name: "FOX Essentials 2024" });
  check("an ambiguous title DOES escalate, and the verdict is used",
    seen.length === 1 && verdict === "bottom", `${seen.length} call(s), verdict=${verdict}`);
  check("...and the title is what gets sent", seen[0].includes("FOX Essentials 2024"));

  /* Every failure path degrades to the tier-1 default rather than propagating. A
     classification call is an ENHANCEMENT; it must never be able to fail a try-on. */
  for (const [label, impl] of [
    ["throws", async () => { throw new Error("network down"); }],
    ["returns garbage", async () => "banana"],
    ["returns null (no API key configured)", async () => null],
    ["never resolves (timeout)", () => new Promise(() => {})],
  ]) {
    const b = mkApi({ geminiImpl: impl });
    let out, threw = false;
    try { out = await b.resolveGarmentCategory({ name: "FOX Essentials 2024" }); }
    catch (_) { threw = true; }
    check(`LLM ${label}: degrades to a usable category, never throws`,
      !threw && (out === "top" || out === "bottom"), `threw=${threw} out=${out}`);
  }

  check("the LLM tier is bounded by a timeout, not left to hang the go-live path",
    /CATEGORY_LLM_TIMEOUT_MS/.test(SRC) && /Promise\.race/.test(code),
    "an unbounded await here stalls the fitting room behind a third-party API");
}

console.log("\n── §7 THE UI LABEL is bound to the resolved category, not hardcoded ──");
{
  /* The reported symptom was the LABEL, so it gets its own assertion: "בגד עליון" must
     never be reachable except through an explicit top verdict. */
  check("the custom-upload label branches on the resolved category",
    /garmentType === "lower_body" \? "בגד תחתון שהעלית/.test(SRC),
    "the label must read the category, never assume one");
  check("...and the catalog label does too",
    /garmentType === "lower_body" \? "מכנסיים · " : "חולצה · "/.test(SRC));
  /* categoryToGarmentType() is the single adapter between the two vocabularies
     ("top"/"bottom" from the classifier, "upper_body"/"lower_body" in item state).
     Two spellings of the same fact is how they drift apart. */
  check("one adapter converts the classifier's vocabulary into item state",
    api.categoryToGarmentType("bottom") === "lower_body" &&
    api.categoryToGarmentType("top") === "upper_body");
}

console.log("\n── §8 THE WIDGET AND THE ROOM MUST AGREE ──");
{
  /* The widget classifies FIRST (it reads the host page), and forwards its verdict as
     ?garment_type=. If its keyword list is weaker than the room's, the room receives a
     confident-but-wrong "tops" and its own stronger classifier never runs. */
  check("the widget's bottoms keywords carry the STEM, not just the plural",
    /"מכנס"/.test(WIDGET), 'CATEGORY_KEYWORDS.pants must contain the stem "מכנס"');
  check("...and ברמודה / שורטס are present",
    /"ברמודה"/.test(WIDGET) && /"שורטס"/.test(WIDGET));
  check("...and both ג'ינס spellings (ASCII apostrophe and Hebrew geresh)",
    WIDGET.includes("ג'ינס") && WIDGET.includes("ג׳ינס"));
  check("...and חצאית is classified as a BOTTOM, not a dress",
    /pants:[^\]]*"חצאי/.test(WIDGET),
    "a skirt is lower-body; filing it under `dress` made it read as a top");
  check("the tops keywords carry stems too, so חולצת matches",
    /"חולצ"/.test(WIDGET), "חולצה never matched חולצת");

  /* The silent default is the bug's enabler: it made 'unknown' indistinguishable from
     'confidently a top'. The widget must say it does not know. */
  check("an unknown category is forwarded as UNKNOWN, not silently as tops",
    /DEFAULT_CATEGORY\s*=\s*"unknown"/.test(WIDGET),
    "'tops' as a fallback is what hid every miss above");
  check("...and the room treats an unknown handoff as unclassified, then classifies it",
    /garment_type"\)\s*\|\|\s*""/.test(SRC) || /wType\s*&&\s*wType\s*!==\s*"unknown"/.test(SRC),
    "the room must not inherit a guess as though it were a verdict");

  /* THE WIDGET'S VERDICT IS EXPLICIT, SO IT OUTRANKS THE ROOM'S CLASSIFIER - which makes
     a wrong widget verdict strictly worse than no verdict. The fabric collision is the
     case where that bites: "ז'קט ג'ינס" matches the pants list on the FABRIC, and would
     be forwarded as a confident garment_type=pants that the room then has no way to
     question. Executed against the REAL detectCategory, not asserted over source text. */
  const wsrc = WIDGET.slice(WIDGET.indexOf("var CATEGORY_KEYWORDS = {"),
                            WIDGET.indexOf("function isExcludedSrc"));
  const detectCategory = new Function('var d={title:""};' + wsrc + "\nreturn detectCategory;")();
  check("the widget resolves a denim JACKET to outerwear, not pants",
    detectCategory("ז'קט ג'ינס") === "outerwear" && detectCategory("Denim Jacket") === "outerwear",
    `got ${detectCategory("ז'קט ג'ינס")} - the fabric must not outvote the garment noun`);
  check("...while denim TROUSERS stay pants - real lower-body evidence survives",
    detectCategory("מכנס ג'ינס") === "pants" && detectCategory("Denim Shorts") === "pants");
  /* When the fabric word was the ONLY evidence, the widget abstains rather than guessing,
     and the room's stem classifier (which knows ג'ינס is a garment on its own) decides. */
  check('"ג\'ינס סקיני" - fabric-only evidence: the widget DEFERS and the room resolves it',
    detectCategory("ג'ינס סקיני") === "unknown" &&
    classifyGarmentTitle("ג'ינס סקיני") === "bottom",
    "deferring is correct here - abstention is what the room's tier exists to catch");
  check("the widget still classifies the reported item correctly end-to-end",
    detectCategory("מכנס קצר רגל - FOX") === "pants",
    "the original bug, at the layer it actually originated in");
}

console.log("\n── §9 THE SERVER TIER exists, is bounded, and fails soft ──");
{
  check("a text-classification endpoint is mounted",
    /app\.post\("\/api\/classify-garment"/.test(SERVER));
  check("...it answers exactly top|bottom|unknown via a constrained schema",
    /"top",\s*"bottom",\s*"unknown"/.test(SERVER),
    "a free-text answer is a parsing problem in the hot path");
  check("...and returns a soft verdict rather than a 5xx when Gemini is unconfigured",
    /classify-garment[\s\S]{0,1400}?GEMINI_API_KEY[\s\S]{0,400}?category: "unknown"/.test(SERVER),
    "an unconfigured key must degrade to tier 1, not fail the request");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
