/* KIDS/ADULT SIZE-CATEGORY GUARD - a deterministic go-live gate, not a guess.

   THE GAP THIS CLOSES: calculateSize() already refuses to RECOMMEND a kids size to a
   body sized against the adult chart (its adultFits/childFits split), but nothing
   previously stopped a shopper who already HAS an adult size resolved from hitting
   Go Live on a garment resolvedGarmentAgeGroup() reports as "kids" - itemBlockReason()/
   itemPendingReason() gate on image availability and in-flight classification, never
   on this. This guard closes that one gap, reusing the SAME ageGroup/currentSizeCategory
   state those already trust rather than adding a new sizes-array data source.

   Structured the same way lower-body-guard.test.mjs is: pure functions are extracted
   and executed for real against real inputs; the goLive() wiring is checked
   structurally (regex over the real source), matching that file's own §9 rationale for
   why lifecycle wiring isn't re-executed here. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = APP.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return APP.slice(start, end);
}

console.log("── §1 isKidsProduct() / isCompatibleSizeCategory(): pure, executed for real ──");
{
  const code = extract("function isKidsProduct(", "function sizeCategoryMismatchReason(");
  const mod = await import("data:text/javascript," + encodeURIComponent(
    code + "\nexport { isKidsProduct, isCompatibleSizeCategory };"
  ));
  const { isKidsProduct, isCompatibleSizeCategory } = mod;

  check("a kids-resolved garment reads as a kids product",
    isKidsProduct("kids") === true);
  check("an adult-resolved garment does NOT read as a kids product",
    isKidsProduct("adult") === false);
  check("an uncertain garment does NOT read as a kids product - fail open, never guess",
    isKidsProduct("uncertain") === false);

  check("REGRESSION TARGET: an adult-profile shopper is INCOMPATIBLE with a kids-only item",
    isCompatibleSizeCategory("adult", "kids") === false);
  check("an adult-profile shopper IS compatible with an adult item",
    isCompatibleSizeCategory("adult", "adult") === true);
  check("an adult-profile shopper IS compatible with an uncertain-category item\n" +
        "        (never block on a classifier that hasn't resolved yet)",
    isCompatibleSizeCategory("adult", "uncertain") === true);
  check("a child-profile shopper IS compatible with a kids item",
    isCompatibleSizeCategory("child", "kids") === true);
  check("no user size resolved yet (null) never blocks - nothing to compare against",
    isCompatibleSizeCategory(null, "kids") === true);
}

console.log("\n── §2 sizeCategoryMismatchReason(): reads real module state, real message ──");
{
  const code = extract("function resolvedGarmentAgeGroup(", "function refreshAgeFieldVisibility(");
  function harness({ activeItem = null, pendingAgeGroup = undefined, currentSizeCategory = null } = {}) {
    const fn = new Function("activeItem", "pendingAgeGroup", "currentSizeCategory",
      code + "\nreturn { sizeCategoryMismatchReason, isCompatibleSizeCategory, isKidsProduct };");
    return fn(activeItem, pendingAgeGroup, currentSizeCategory);
  }

  const blocked = harness({ activeItem: { ageGroup: "kids" }, currentSizeCategory: "adult" });
  const reason = blocked.sizeCategoryMismatchReason();
  check("adult shopper + kids item: returns a non-null reason", typeof reason === "string" && reason.length > 0);
  check("the reason carries the required Hebrew message verbatim",
    reason.includes("הפריט אינו בטווח המידות שלך (מידת ילדים)"), reason);
  check("the reason carries the required English fallback",
    reason.includes("This item is not within your size range (Kids item)"), reason);

  const allowedAdult = harness({ activeItem: { ageGroup: "adult" }, currentSizeCategory: "adult" });
  check("adult shopper + adult item: no reason (null)", allowedAdult.sizeCategoryMismatchReason() === null);

  const allowedChild = harness({ activeItem: { ageGroup: "kids" }, currentSizeCategory: "child" });
  check("child shopper + kids item: no reason (null)", allowedChild.sizeCategoryMismatchReason() === null);

  const allowedUncertain = harness({ activeItem: null, pendingAgeGroup: undefined, currentSizeCategory: "adult" });
  check("adult shopper + uncertain item (nothing resolved yet): no reason (null)",
    allowedUncertain.sizeCategoryMismatchReason() === null);
}

console.log("\n── §3 goLive() WIRING: the gate fires before any camera/token/billing work ──");
{
  const live = extract("async function goLive() {", "\nasync function ");
  check("goLive() calls the new gate", /sizeCategoryMismatchReason\(\)/.test(live), live.slice(0, 800));
  check("a hit aborts with toast(...) + return, same shape as blockReason/pendingReason above it",
    /const sizeReason = sizeCategoryMismatchReason\(\);\s*\n\s*if \(sizeReason\) \{ toast\(sizeReason\); return; \}/.test(live),
    live.slice(0, 1200));

  const pendingIdx = live.indexOf("livePendingReason()");
  const sizeIdx = live.indexOf("sizeCategoryMismatchReason()");
  const connectIdx = live.indexOf("connectRealtime()");
  check("the gate runs AFTER the existing pending-reason check...",
    pendingIdx !== -1 && sizeIdx !== -1 && pendingIdx < sizeIdx);
  check("...and BEFORE connectRealtime() - no token mint / WebRTC / billing for a blocked item",
    connectIdx !== -1 && sizeIdx < connectIdx);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
