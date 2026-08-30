#!/usr/bin/env node
/* BACK-VIEW READINESS - why "I turned around and the back was plain" is not readable
   =============================================================================
   THE REPORT: a garment with a real back print renders a plain back when the shopper
   turns around, and it looks like the room "defaulted to single-front mode".

   WHAT THE MODE LOGIC ACTUALLY DOES, because the obvious fix is the original bug.
   Forcing the COMBINED front|back composite is what renderPerspectiveSelector() calls
   THE BLANK-BACK BUG: one stitched 2048x1024 reference asks Lucy - which has no notion
   of "panels" and no state for "the shopper turned" - to pick a half every frame, and it
   renders fragments of both (23f5953: double-logo / duplicated garment). COMPOSITE_DEFAULT
   is false for that reason and app.js documents the restore procedure at length. The
   architecture that actually renders a rear view is AI Auto: the OrientationWatcher swaps
   the live reference between two CLEAN single-view assets, so the model only ever sees one
   unambiguous side.

   SO THE REAL QUESTION IS ALWAYS "why did this item not qualify for AI Auto", and that is
   what this suite is about. canCombineViews() answers it as a bare boolean, and the
   reasons it can be false are spread across four functions:
     - the item shipped no back asset at all (classifier found no rear photo);
     - the back is the FRONT under a different URL spelling, which distinctBackOf()
       rejects on purpose - binding the front as a back reference is what made the model
       suppress the graphic it could see - and it warns only ONCE per pair, so on a second
       item the reason is invisible;
     - there is no front asset;
     - one half of a full look qualifies and the other does not.
   From the outside all four look identical: a plain back. describeBackViewReadiness()
   collapses them into one fact that names which one happened.

   THE PROPERTY THAT MAKES IT WORTH HAVING is that it cannot lie: SS3 asserts its verdict
   agrees with canCombineViews() on every input, so it explains the decision that was
   actually taken rather than a parallel guess that can drift from it. A diagnostic that
   disagrees with the code it describes is worse than no diagnostic.
   ============================================================================= */

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real resolution layer, executed. Sliced rather than re-implemented so this suite can
   never drift onto its own copy of the rules - the same technique
   garment-category-prompt.test.mjs uses on the prompt layer. The slice starts at the URL
   canonicaliser so sameImage(), galleryOf() and variantAssetsOf() are the REAL ones too:
   the duplicate-back case below turns entirely on the spelling rules, and a hand-rolled
   approximation of them would be testing the approximation. */
const code = SRC.slice(SRC.indexOf("function canonicalImageUrl"),
                       SRC.indexOf("/* Pick the angle clause"));

let look = null;                      // the full-look fixture, swapped per case
const sandbox = {
  console: { warn() {}, log() {} },
  abbrevImg: (s) => String(s || ""),
  resolveLook: () => look,
  activeColor: "default",
  location: { href: "https://shop.test/fitting-room/", search: "" },
  PRESENTATION_PARAMS: new Set([
    "width", "height", "w", "h", "size", "quality", "q", "dpr", "format", "fm",
    "crop", "fit", "scale", "v", "ver", "version", "t", "cache", "_",
  ]),
  RESIZER_RE: /\/(?:_next\/image|cdn-cgi\/image|_vercel\/image|imgproxy|thumbor|resize)\b|[?&]url=/i,
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { distinctBackOf, canCombineViews, describeBackViewReadiness, BACK_VIEW_REASON };"
)(...Object.values(sandbox));

const { canCombineViews, describeBackViewReadiness, BACK_VIEW_REASON: R } = api;

const F  = "https://cdn.shopify.com/s/files/peak-tee-front.jpg";
const BK = "https://cdn.shopify.com/s/files/peak-tee-back.jpg";

console.log("── §1 THE FOUR WAYS A BACK VIEW GOES MISSING, each named ──");
{
  look = null;
  check("a real, distinct back photo is READY - the PEAK shirt's happy path",
    describeBackViewReadiness({ img: F, imgBack: BK }).reason === R.READY &&
    describeBackViewReadiness({ img: F, imgBack: BK }).ready === true);

  /* The common case, and the one that is NOT a defect: the classifier genuinely found no
     rear photo in the gallery. app.js stopped falling back to "the gallery's second
     photo" on purpose - a second FRONT mislabelled as the back passes every fetch/decode/
     flatness check and then gets prompted as "this is the BACK, do NOT render the front",
     so the model suppresses the graphic it can actually see. */
  check("no back asset at all is reported as such, not as a failure",
    describeBackViewReadiness({ img: F }).reason === R.NO_BACK_ASSET &&
    describeBackViewReadiness({ img: F }).ready === false);

  /* THE INVISIBLE ONE. distinctBackOf() warns once per pair and then stays silent, so on
     any later item this rejection leaves no trace at all in the console - and it looks
     exactly like the case above from the outside. */
  check("a back that is the FRONT under another URL spelling is named as a duplicate",
    describeBackViewReadiness({ img: F, imgBack: F + "?width=800" }).reason === R.BACK_DUPLICATES_FRONT &&
    describeBackViewReadiness({ img: F, imgBack: F + "?v=99" }).reason === R.BACK_DUPLICATES_FRONT,
    "the reason a real-looking back URL still yields a plain back");
  check("...and a genuinely different photo is NOT mistaken for a duplicate",
    describeBackViewReadiness({ img: F, imgBack: BK }).reason === R.READY,
    "a false duplicate here would silently disable every back view");

  check("no front asset is its own reason, not lumped in with a missing back",
    describeBackViewReadiness({ imgBack: BK }).reason === R.NO_FRONT_ASSET);
  check("no item at all is reported rather than throwing",
    describeBackViewReadiness(null).reason === R.NO_ITEM &&
    describeBackViewReadiness(undefined).ready === false);

  check("the nested colour gallery is read, not just the legacy img/imgBack pair",
    describeBackViewReadiness({ images: { front: F, back: BK } }).reason === R.READY &&
    describeBackViewReadiness({ images: { front: F } }).reason === R.NO_BACK_ASSET);
}

console.log("\n── §2 A FULL LOOK NAMES THE HALF THAT DISQUALIFIED IT ──");
{
  /* A look needs BOTH halves to ship a real back. "The back is plain" on a two-piece look
     is otherwise a hunt through two items to find which one lacks the asset. */
  look = { top: { img: F, imgBack: BK }, bottom: { img: F + "?x=1", imgBack: BK + "?x=1" } };
  check("both halves ready reports ready, with no half singled out",
    describeBackViewReadiness(null).ready === true &&
    describeBackViewReadiness(null).half === null);

  look = { top: { img: F, imgBack: BK }, bottom: { img: F + "?x=1" } };
  check("a bottom with no back names the BOTTOM",
    describeBackViewReadiness(null).ready === false &&
    describeBackViewReadiness(null).half === "bottom" &&
    describeBackViewReadiness(null).reason === R.NO_BACK_ASSET);

  look = { top: { img: F }, bottom: { img: F + "?x=1", imgBack: BK + "?x=1" } };
  check("a top with no back names the TOP",
    describeBackViewReadiness(null).half === "top" &&
    describeBackViewReadiness(null).reason === R.NO_BACK_ASSET);
  look = null;
}

console.log("\n── §3 IT CANNOT DISAGREE WITH THE DECISION IT EXPLAINS ──");
{
  /* THE LOAD-BEARING PROPERTY. A diagnostic that reports "ready" where canCombineViews()
     returns false would send the next reader hunting in the wrong place - strictly worse
     than no diagnostic. Asserted across every shape §1 and §2 cover, single and look. */
  const singles = [
    null, undefined, {}, { img: F }, { imgBack: BK }, { img: F, imgBack: BK },
    { img: F, imgBack: F }, { img: F, imgBack: F + "?width=800" },
    { images: { front: F, back: BK } }, { images: { front: F } },
  ];
  let agree = true, where = "";
  for (const it of singles) {
    if (describeBackViewReadiness(it).ready !== canCombineViews(it)) {
      agree = false; where = JSON.stringify(it); break;
    }
  }
  check("every single-garment shape agrees with canCombineViews()", agree, where);

  const looks = [
    { top: { img: F, imgBack: BK }, bottom: { img: F + "?x=1", imgBack: BK + "?x=1" } },
    { top: { img: F, imgBack: BK }, bottom: { img: F + "?x=1" } },
    { top: { img: F }, bottom: { img: F + "?x=1", imgBack: BK + "?x=1" } },
    { top: { img: F }, bottom: { img: F + "?x=1" } },
  ];
  let lookAgree = true, lookWhere = "";
  for (const l of looks) {
    look = l;
    if (describeBackViewReadiness(null).ready !== canCombineViews(null)) {
      lookAgree = false; lookWhere = JSON.stringify(l); break;
    }
  }
  look = null;
  check("every full-look shape agrees with canCombineViews() too", lookAgree, lookWhere);
}

console.log("\n── §4 IT IS ACTUALLY WIRED UP - a diagnostic nobody calls is dead code ──");
{
  /* The guard-dead-call-site rule: this file already carries a bug report for a boundary
     function that was correct and never reached. Assert the CALL SITE, not just that the
     function parses. */
  check("renderPerspectiveSelector() reports the reason when it settles on front-only",
    /describeBackViewReadiness\(/.test(
      SRC.slice(SRC.indexOf("function renderPerspectiveSelector"),
                SRC.indexOf("function renderColorSwatches"))),
    "the mode is derived there; the reason has to be logged there or it is never seen");
  check("...and it is reachable from the console for a live session",
    /__pearDebugBackView/.test(SRC),
    "a shopper-reported plain back has to be answerable without a redeploy");
  /* COMPOSITE_DEFAULT stays off. If a later pass flips it, this suite's header and
     renderPerspectiveSelector()'s BLANK-BACK FIX comment are the record of what that
     costs - and app.js:5863 names the clauses that must be restored in the same commit. */
  check("the combined-composite kill switch is still thrown - forcing it IS the blank-back bug",
    /const COMPOSITE_DEFAULT = false;/.test(SRC),
    "COMBINED asks a panel-blind model to pick a half every frame; that is 23f5953");
}

console.log(fails === 0 ? "\nback-view-readiness: OK" : `\nback-view-readiness: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
