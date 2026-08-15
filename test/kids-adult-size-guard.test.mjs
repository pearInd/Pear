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

/* NOTE ON SCOPE: the CATEGORY logic itself (isKidsProduct / userBodyCategory /
   isCompatibleSizeCategory, and the product-size-list signal that now drives them)
   is owned by kids-product-sizes.test.mjs, which was written against the production
   failure that proved the classifier-only version of this guard wrong. This file
   stays focused on the GO-LIVE GATE: that a mismatch produces a reason, that the
   reason carries the required copy, and that goLive() consults it before spending
   anything. Splitting them keeps each suite pinned to one claim. */

console.log("── §1 sizeCategoryMismatchReason(): reads real module state, real message ──");
{
  const code = extract("function resolvedGarmentAgeGroup(", "function calculateSize()");
  function harness({ activeItem = null, pendingAgeGroup = undefined, pendingSizes = undefined,
                      currentBodyCategory = null } = {}) {
    const fn = new Function("activeItem", "pendingAgeGroup", "pendingSizes", "currentBodyCategory",
      code + "\nreturn { sizeCategoryMismatchReason, hasSizeCategoryMismatch };");
    return fn(activeItem, pendingAgeGroup, pendingSizes, currentBodyCategory);
  }

  const blocked = harness({
    activeItem: { ageGroup: "uncertain", sizes: ["8", "10", "12", "14", "16"] },
    currentBodyCategory: "adult",
  });
  const reason = blocked.sizeCategoryMismatchReason();
  check("adult body + kids-only product: returns a non-null reason",
    typeof reason === "string" && reason.length > 0);
  check("the reason carries the required Hebrew message verbatim",
    reason.includes("הפריט אינו בטווח המידות שלך (פריט במידות ילדים). אינך יכול למדוד פריט זה במידה הנוכחית."),
    reason);
  check("the reason carries the required English fallback",
    reason.includes("This item is not within your size range (Kids item)"), reason);

  /* The classifier-only fallback path, unchanged: still works when NO size list ever
     reached us, which is the only situation it is still trusted for. */
  const blockedByClassifier = harness({ activeItem: { ageGroup: "kids" }, currentBodyCategory: "adult" });
  check("no size list at all + a confident 'kids' verdict still blocks (fallback intact)",
    blockedByClassifier.sizeCategoryMismatchReason() !== null);

  const allowedAdult = harness({
    activeItem: { ageGroup: "uncertain", sizes: ["S", "M", "L"] }, currentBodyCategory: "adult",
  });
  check("adult body + adult product: no reason (null)", allowedAdult.sizeCategoryMismatchReason() === null);

  const allowedChild = harness({
    activeItem: { ageGroup: "kids", sizes: ["8", "10"] }, currentBodyCategory: "child",
  });
  check("child body + kids product: no reason (null)", allowedChild.sizeCategoryMismatchReason() === null);

  const allowedUnknown = harness({ activeItem: null, currentBodyCategory: "adult" });
  check("adult body + nothing resolved about the product yet: no reason (null)",
    allowedUnknown.sizeCategoryMismatchReason() === null);

  const noMeasurements = harness({
    activeItem: { sizes: ["8", "10"] }, currentBodyCategory: null,
  });
  check("kids product but no measurements entered yet: no reason (null)",
    noMeasurements.sizeCategoryMismatchReason() === null);
}

console.log("\n── §2 goLive() WIRING: the gate fires before any camera/token/billing work ──");
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
