/* THE REPORTED PRODUCTION FAILURE, and its root cause.

   WHAT HAPPENED: a shopper with a saved 180cm/80kg (adult L) profile opened a FOX
   Spiderman t-shirt sold ONLY in kids sizes 8/10/12/14/16, and was let straight into
   the fitting room - with an ADULT XS-3XL size selector rendered over a product that
   has no adult sizes at all.

   ROOT CAUSE: the guard added earlier keyed entirely on activeItem.ageGroup - the
   per-product kids/adult verdict from Gemini's image classification. server.js's own
   classifier prompt instructs that model to answer "uncertain" for exactly this kind
   of item:

     · "Flat-lay / packshot with NO model and NO visible size label ... answer
        'uncertain' - do not guess from styling alone."
     · "Do NOT infer age group from color, PRINT STYLE, or price positioning alone"
     · "below 0.7 you must answer 'uncertain'"

   A Spiderman tee packshot hits all three, so age_group came back "uncertain",
   isKidsProduct() returned false, and the guard never fired. The size selector fell
   through to SIZE_SCALE (XS-3XL) for the same reason.

   Meanwhile the host PDP was displaying 8/10/12/14/16 the whole time - deterministic
   ground truth about the product's category that this codebase never ingested. That
   is what the original spec asked for (isKidsProduct(productSizes) reading item.sizes
   / Shopify variant options) and what these tests now pin: the real size list is the
   PRIMARY signal, and the image classifier is only the fallback for when no size list
   is available. A probabilistic signal that is DESIGNED to abstain must never
   outrank a deterministic one that is sitting right there. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

/* The category logic, executed for real. CHILD_SIZE_CHART/ZARA_SIZE_CHART/
   coreHwPenalty sit just above it, so one contiguous slice carries the real charts
   rather than a stub of them - the exact numbers are what this bug turned on. */
const catCode = extract(APP, "const ZARA_SIZE_CHART", "function calculateSize()");
const cat = await import("data:text/javascript," + encodeURIComponent(
  catCode + "\nexport { isKidsProduct, isCompatibleSizeCategory, userBodyCategory, parseSizeList };"
));

console.log("── §1 isKidsProduct(): the REAL size list decides, not the image classifier ──");
{
  const { isKidsProduct } = cat;

  check("THE REGRESSION: kids-only numeric sizes are kids EVEN WHEN the classifier\n" +
        "        abstained with 'uncertain' - the exact combination that shipped the bug",
    isKidsProduct(["8", "10", "12", "14", "16"], "uncertain") === true);

  check("...and the same list still reads kids when no classifier verdict exists at all",
    isKidsProduct(["8", "10", "12", "14", "16"], undefined) === true);

  check("adult letter scales are never kids",
    isKidsProduct(["S", "M", "L", "XL"], "uncertain") === false);

  check("a REAL adult size list outranks a wrong 'kids' classifier verdict - the\n" +
        "        deterministic signal wins in BOTH directions, not just the blocking one",
    isKidsProduct(["S", "M", "L", "XL"], "kids") === false);

  check("adult numeric waist/chest sizes (28-44) are NOT kids numerics",
    isKidsProduct(["28", "30", "32", "34"], "uncertain") === false);

  check("a mixed kids+adult range is not confidently kids (a product genuinely\n" +
        "        spanning both must stay open, not be blocked on a guess)",
    isKidsProduct(["14", "16", "S", "M"], "uncertain") === false);

  check("full kids ladder 2-18 is recognised, not just the 8-16 subset reported",
    isKidsProduct(["2", "4", "6", "8", "10", "12", "14", "16", "18"], "uncertain") === true);

  check("case/whitespace-insensitive (' l ' is still adult L)",
    isKidsProduct([" l ", "xl"], "uncertain") === false);

  check("comma-string form (the URL-param spelling) parses like an array",
    isKidsProduct("8,10,12,14,16", "uncertain") === true);

  console.log("   · fallback to the classifier ONLY when there is no size list at all:");
  check("no sizes + 'kids' verdict  -> kids (old behaviour preserved)",
    isKidsProduct([], "kids") === true);
  check("no sizes + 'uncertain'     -> not kids (never block on a double-unknown)",
    isKidsProduct([], "uncertain") === false);
  check("no sizes + 'adult'         -> not kids",
    isKidsProduct(null, "adult") === false);
}

console.log("\n── §2 userBodyCategory(): the shopper's OWN scale, independent of the garment ──");
{
  const { userBodyCategory } = cat;

  /* WHY THIS EXISTS AND WHY IT IS NOT currentSizeCategory. Once the garment resolves
     to "kids", calculateSize() deliberately forces adultFits=[] so a kids garment can
     never recommend an adult size. For the 180cm/80kg shopper in this report that
     leaves NO candidate in either chart (the child chart tops out at 176cm/60kg), so
     currentSizeCategory becomes null - and a guard keyed on
     currentSizeCategory === "adult" would go quiet again the moment the product-size
     fix made the garment resolve correctly. The guard therefore has to read a category
     derived with NO garment constraint applied. This is that value. */
  check("THE REPORTED SHOPPER: 180cm/80kg is an adult body (fits adult L, fits no\n" +
        "        child row - the child chart ends at 176cm/60kg)",
    userBodyCategory(180, 80) === "adult");

  check("a genuine child body is 'child' (140cm/30kg -> kids 10)",
    userBodyCategory(140, 30) === "child");

  check("out-of-both-charts proportions are null, never a guess",
    userBodyCategory(120, 90) === null);

  /* GUARDING THE REGRESSION THE CODEBASE ALREADY FIXED ONCE. pickSizeCategory()'s own
     comment records that a height/weight THRESHOLD guess was removed because it
     "routed petite adults (150cm/50kg -> kids 14) and slim tall adults (174cm/56kg ->
     kids 18)" into the wrong chart. A naive "height > 150 OR weight > 45 = adult" rule
     would re-introduce exactly that, and would block a 13-year-old from the kids items
     they actually need. Chart-fit is the signal, not a threshold. */
  check("a 155cm/50kg teenager is NOT force-labelled adult by a raw height threshold\n" +
        "        (fits kids 14: 155-163cm/38-46kg is weight-out, so this lands null,\n" +
        "        NOT 'adult' - it must never block them off a kids product)",
    userBodyCategory(155, 50) !== "adult");

  check("a 165cm/48kg body fits kids 16 (163-170cm/46-54kg) -> child, not adult",
    userBodyCategory(165, 48) === "child");
}

console.log("\n── §3 isCompatibleSizeCategory(): the end-to-end reported scenario ──");
{
  const { isCompatibleSizeCategory } = cat;
  const KIDS_TEE = ["8", "10", "12", "14", "16"];

  check("THE BUG, END TO END: adult body + kids-only product + 'uncertain' classifier\n" +
        "        is now INCOMPATIBLE (this returned true before the fix)",
    isCompatibleSizeCategory("adult", KIDS_TEE, "uncertain") === false);

  check("a child body on the same product is fine",
    isCompatibleSizeCategory("child", KIDS_TEE, "uncertain") === true);

  check("an adult body on an adult product is fine",
    isCompatibleSizeCategory("adult", ["S", "M", "L"], "uncertain") === true);

  check("an unresolved body category never blocks",
    isCompatibleSizeCategory(null, KIDS_TEE, "uncertain") === true);

  check("no size list + uncertain classifier still never blocks (unchanged)",
    isCompatibleSizeCategory("adult", [], "uncertain") === true);
}

console.log("\n── §4 THE SIZE SELECTOR renders the HOST PRODUCT's real variants ──");
{
  const sel = extract(APP, "function injectSizeSelector()", "function setSizeOverride(");
  check("the selector reads the product's own size list before falling back to a\n" +
        "        generic scale - rendering XS-3XL over an 8-16 product is the bug",
    /parseSizeList\(/.test(sel), sel.slice(0, 600));
  check("...and only falls back to CHILD_SIZE_SCALE/SIZE_SCALE when the product\n" +
        "        genuinely ships no size list",
    /productSizes\.length\s*\?\s*productSizes/.test(sel), sel);
}

console.log("\n── §5 THE HANDOFF: sizes actually travel from the host page into the room ──");
{
  check("parseHandoff() reads the forwarded size list off the URL",
    /sizes:\s*q\.get\("garment_sizes"\)/.test(APP));
  check("the widget forwards them when opening the room",
    /garment_sizes=/.test(PW), "buildRoomUrl must carry the list the PDP is showing");
  check("...and on the late PEAR_UPDATE_GARMENT correction too",
    /garment_sizes:/.test(PW));
  check("the room applies a late size-list correction to the active item",
    /activeItem\.sizes/.test(APP));
}

console.log("\n── §6 THE WIDGET reads sizes off the host page (Shopify variants first) ──");
{
  const code = extract(PW, "function normalizeSizeToken(", "/* ── COMBINED composite");
  const mod = await import("data:text/javascript," + encodeURIComponent(
    code + "\nexport { sizesFromVariants, isPlausibleSizeToken };"
  ));
  const { sizesFromVariants, isPlausibleSizeToken } = mod;

  const variants = [
    { id: 1, option1: "8" }, { id: 2, option1: "10" }, { id: 3, option1: "12" },
    { id: 4, option1: "14" }, { id: 5, option1: "16" },
  ];
  check("distinct size values are read off the declared Size option, in order",
    JSON.stringify(sizesFromVariants(variants, 0)) === JSON.stringify(["8", "10", "12", "14", "16"]),
    JSON.stringify(sizesFromVariants(variants, 0)));

  const dupes = [
    { id: 1, option1: "Red", option2: "M" }, { id: 2, option1: "Blue", option2: "M" },
    { id: 3, option1: "Red", option2: "L" },
  ];
  check("duplicates across the OTHER option (colour) collapse to one entry per size",
    JSON.stringify(sizesFromVariants(dupes, 1)) === JSON.stringify(["M", "L"]),
    JSON.stringify(sizesFromVariants(dupes, 1)));

  check("no declared Size option (-1): returns nothing rather than guessing option1",
    sizesFromVariants(variants, -1).length === 0);

  /* The DOM fallback can only ever ADD a size list, and a WRONG list blocks a paying
     shopper - so the token filter has to be strict about what counts as a size. */
  check("plausible size tokens are accepted", ["8", "16", "XS", "L", "XXL", "3XL"].every(isPlausibleSizeToken));
  check("free text is rejected (a stray <select> must not become a size list)",
    !["Choose an option", "Add to bag", "Blue", "2026", ""].some(isPlausibleSizeToken));
}

console.log("\n── §7 THE PHANTOM AGE FIELD is gone from every layer it lived in ──");
{
  /* The popover rendered "גיל: 5" for a visitor who was never asked. It had already
     rotted into dead weight before the report: refreshAgeFieldVisibility() had no
     callers, so the input was never revealed, and pickSizeCategory() - the only thing
     that ever turned an age into a chart choice - had no callers either. All that was
     left was a stored value from an older build still being painted. */
  const HTML_FR = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8");
  const I18N = readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8");
  const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");

  // Comments legitimately still explain WHY it was removed - strip them before asserting,
  // exactly as variant-sync.test.mjs does, so documenting the fix can't fail the check.
  const appCode = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const htmlCode = HTML_FR.replace(/<!--[\s\S]*?-->/g, "");

  check("the #age input is gone from the measurement form",
    !/id="age"/.test(htmlCode));
  check("the #ageFieldGroup wrapper is gone with it",
    !/ageFieldGroup/.test(htmlCode));
  check("the profile popover no longer renders an age row",
    !/profileAge/.test(htmlCode) && !/profileAge/.test(appCode));
  check("the i18n keys are gone (labelAge / placeholderAge / profileLabelAge)",
    !/labelAge:|placeholderAge:|profileLabelAge:/.test(I18N));

  check("the dead chart-picker that age fed is gone (pickSizeCategory / CHILD_AGE_MAX)",
    !/function pickSizeCategory|CHILD_AGE_MAX/.test(appCode));
  check("refreshAgeFieldVisibility() - which nothing ever called - is gone",
    !/function refreshAgeFieldVisibility/.test(appCode));
  check("age is no longer read out of the DOM anywhere",
    !/\$\("age"\)/.test(appCode) && !/num\("age"\)/.test(appCode));
  check("age is no longer carried on the cached PEAR_USER profile",
    !/PEAR_USER\.age/.test(appCode));

  check("the client no longer PATCHes an age to the server",
    !/JSON\.stringify\(\{ height, weight, age \}\)/.test(appCode));
  const serverCode = SERVER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the server no longer writes an age column on a measurements update",
    !/update\.age\s*=/.test(serverCode));
  check("...and no longer hands an age back to any client",
    !/age: u\.age/.test(serverCode) && !/age: user\.age/.test(serverCode));

  /* The column itself is deliberately NOT dropped here - that is a destructive
     migration, not an app deploy - so this only pins that nothing reads or writes it. */
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
