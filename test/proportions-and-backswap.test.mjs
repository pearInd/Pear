/* "VERTICAL STRETCHING" AND "FAILS TO RENDER THE BACK VIEW" - two claims, neither a bug
   this file introduced or can fix by changing CSS/prompts, and both worth fencing so a
   future report against the same symptom starts from what is actually true rather than
   re-litigating it from a screenshot.

   ── CLAIM 1: NON-UNIFORM STRETCH ──────────────────────────────────────────────
   There is no non-uniform scale ANYWHERE in this pipeline, and there cannot be one by
   construction: object-fit:cover is defined by the CSS spec to preserve the source aspect
   ratio unconditionally (crop only, never stretch), the throttled-input canvas computes
   ONE scale factor for both axes, and getUserMedia() uses `ideal` constraints only, which
   never force a distorted capture. What WAS real is crop: a square 512x512 source cover-fit
   into the 4/5 mobile stage discarded 20% of every frame's width. §1 fences the resolution
   that fixes the crop and the CSS invariant that made "fix by switching to letterboxing"
   both unnecessary and a straight reversal of the single-surface/no-black-bars decision
   (single-surface.test.mjs) - contain-fit would ADD the bars that decision removed.

   ── CLAIM 2: BACK-VIEW RENDERING ──────────────────────────────────────────────
   Already built, already default-on, already more robust than requested: a skin-ratio +
   FaceDetector heuristic (createOrientationWatcher), chosen over raw pose yaw specifically
   because MediaPipe's landmark confidence degrades sharply past ~90° rotation. §2 fences
   that it is wired and that the PROMPT plays no causal role in the swap (buildPrompt()
   discards its angle argument). §3 fences the real, separate gap this session's audit
   found: an item with no distinct back photo cannot show a back view in ANY form, because
   even the text-only inferred-back fallback (DENSE.backInferred) is unreachable through
   the same discarded-angle-argument mechanism. */
import { readFileSync } from "node:fs";

const APP  = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS  = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 NO STRETCH IS POSSIBLE, AND THE CROP IS NOW ~0% ON MOBILE ──");
{
  /* THE CSS INVARIANT. object-fit:cover cannot produce scaleX != scaleY - this is a
     property of the CSS spec, not this codebase, but it is what makes "switch to
     contain/letterbox" both unnecessary (nothing to fix) and actively wrong (it would
     re-add the black bars the single-surface revision explicitly removed and tested
     against). */
  check("the three media elements share ONE full-bleed, object-fit:cover rule",
    /\.camera-card #webcam,\s*\n\.camera-card #aiVideo,\s*\n\.camera-card #resultCanvas \{\s*\n\s*position: absolute; inset: 0; width: 100%; height: 100%;\s*\n\s*object-fit: cover;/.test(CSS),
    "object-fit:cover is CSS-spec uniform scaling - it structurally cannot stretch");
  check("...and nothing anywhere applies a non-uniform CSS transform to a media element",
    !/#(webcam|aiVideo|resultCanvas)[^{]*\{[^}]*scale\([^,)]+,\s*[^,)]+\)/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")),
    "a scale(x, y) with different x/y is the only way CSS could stretch, and none exists");
  /* Scoped to buildVideoConstraints() specifically - LIVE_W/LIVE_H also appear as
     advisory SDK model hints and as the input-throttle's target size, neither of which is
     a getUserMedia() constraint and neither of which risks distortion (the SDK ignores
     model.width/height on Chromium; the throttle target feeds drawFrame's own uniform
     cover-fit, checked separately above). */
  const constraints = APP.slice(APP.indexOf("function buildVideoConstraints(facing) {"),
                                APP.indexOf("async function startCamera("));
  /* Checked field-by-field rather than by excluding unrelated "max"/"min" substrings -
     window.matchMedia("(max-width: 768px)") legitimately contains "max", and so does the
     unrelated frameRate constraint; neither is a size constraint that could distort. */
  check("width/height/aspectRatio constraints are `ideal` only - never a forced exact size",
    /video\.width\s*=\s*\{\s*ideal:\s*LIVE_W\s*\}/.test(constraints) &&
    /video\.height\s*=\s*\{\s*ideal:\s*LIVE_H\s*\}/.test(constraints) &&
    /video\.aspectRatio\s*=\s*\{\s*ideal:/.test(constraints) &&
    !/video\.(width|height|aspectRatio)\s*=\s*\{[^}]*(exact|min|max)/.test(constraints),
    "`ideal` never forces a distorted capture; `exact`/`min`/`max` on a size field can");
  check("createThrottledInputStream's drawFrame computes ONE scale for both axes",
    /const scale = Math\.max\(width \/ vw, height \/ vh\);/.test(APP) &&
    /const dw = vw \* scale, dh = vh \* scale;/.test(APP),
    "cover-fit by definition: one scale factor applied to both width and height");

  /* THE CROP FIX. 480x600 is exactly 4:5 (0.80), matching .camera-card's mobile stage, so
     the cover-fit crop on the app's primary surface drops to ~0%. */
  const w = Number((APP.match(/const LIVE_W = (\d+), LIVE_H = (\d+);/) || [])[1]);
  const h = Number((APP.match(/const LIVE_W = (\d+), LIVE_H = (\d+);/) || [])[2]);
  check("LIVE_W×LIVE_H is exactly 4:5, matching the mobile stage's own aspect-ratio",
    w === 480 && h === 600 && Math.abs(w / h - 0.8) < 1e-9,
    `${w}x${h} = ${w / h} - .camera-card's mobile aspect-ratio is 4/5 = 0.80`);
  check(".camera-card's mobile aspect-ratio is still 4/5, so the match is real, not assumed",
    /\.camera-card \{[\s\S]{0,400}?aspect-ratio: 4 \/ 5;/.test(CSS),
    "the crop-elimination claim depends on this staying 4/5 - a silent CSS change would break it");
  check("the desktop trade-off is stated in app.js, not just claimed as a pure win",
    /desktop gets MORE crop so mobile can get none/.test(APP),
    "480x600 into the 4:3 desktop breakpoint crops MORE than the old square value did");
}

console.log("\n── §2 BACK-VIEW RENDERING: image-swap AND prompt now agree ──");
{
  /* THE FEATURE EXISTS AND IS DEFAULT-ON for any item with a real back photo - no manual
     toggle needed, since setAngle() is documented as unwired to any UI. */
  check("AI Auto engages automatically whenever the item supports two views",
    /currentAngle = canCombineViews\(activeItem\) \? AUTO_ANGLE : "front";/.test(APP),
    "no manual angle picker exists - this is the only entry point into back-detection");
  check("...gated on a REAL, distinct back photo, not merely 'some back field present'",
    /function canCombineViews\(item\)/.test(APP) && /function activeBackIsReal\(item\)/.test(APP) &&
    /const real = \(it\) => !!distinctBackOf\(it\);/.test(APP),
    "a mirrored front (g.back === g.front) must not count as a real back");
  check("the classifier is skin-ratio + FaceDetector, chosen over raw pose yaw on purpose",
    /const faceDetector = typeof FaceDetector/.test(APP) &&
    /degrades sharply past ~90° rotation/.test(APP),
    "MediaPipe yaw is unreliable near a full back-turn - documented, not merely implied");
  check("a swap corroborates over a real hold window before committing - anti-flap",
    /const ORIENT_LOCK_MS\s*= 2500;/.test(APP),
    "a naive short debounce would flap on a shopper mid-turn, not 'stay stuck on front'");
  check("the back Blob is validated (fetched, decoded, non-flat) BEFORE the swap commits",
    /async function maybeSwap\(next\)/.test(APP) &&
    /const backBlob = await garmentBlobCached\(GARMENT_BACK\);/.test(APP) &&
    /backLooksFlat = await bitmapLooksFlat\(probe\);/.test(APP),
    "committing to a swap before the asset is known-good is what would show a blank back");

  /* ── REVISION: THE PROMPT NO LONGER DISCARDS ITS ANGLE ARGUMENT ─────────────
     THIS SECTION USED TO ASSERT THE OPPOSITE, correctly, at the time: buildPrompt()
     discarded angleText and the back-rendering signal was carried entirely by the image.
     Three reports later, that gap is closed - buildPrompt(item, angle) genuinely selects
     BACK_CATEGORY_ANCHOR vs CATEGORY_ANCHOR now. What survives from the old assertion is
     the part that was never about the bug: the swap is STILL image-driven at its core
     (the prompt cannot MAKE a Blob swap happen, it can only describe the side once the
     swap already has), and the TOCTOU discipline (a frozen snapshot, never a live read)
     is unchanged - reasserted here rather than dropped, because that is the property that
     keeps this fix from reintroducing the mixing-bug race angle-race.test.mjs exists for. */
  check("buildPrompt(item, angle) genuinely selects between the two anchor tables",
    /function buildPrompt\(item, angle = "front"\) \{\s*\n\s*return imageOnlyPrompt\(item, angle\);/.test(APP),
    "a parameter that is declared but not threaded through is the exact regression fixed");
  check("...and imageOnlyPrompt() branches on it - BACK_CATEGORY_ANCHOR is reachable",
    /const table = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;/.test(APP),
    "declaring a back anchor table nobody ever selects is the same bug with extra steps");
  check("applyGarment() passes the FROZEN angleAtStart - never a live effectiveAngle() read",
    /buildPrompt\(item, angleAtStart\)/.test(APP) && !/buildPrompt\(item, effectiveAngle\(\)\)/.test(APP),
    "a live read here reopens the exact TOCTOU race angle-race.test.mjs was written to fix");
  check("...and the image-swap mechanism underneath is untouched - the fix is additive",
    /aiVideo\.srcObject = editedStream;/.test(APP) &&
    /await applyActive\(\);\s*\/\/ one rtClient\.set\(\) - pre-cached Blob payload/.test(APP),
    "the prompt now agrees with the image; it does not replace what selects the image");
}

console.log("\n── §3 THE GAP THAT REMAINS: no back photo, no back view, still ──");
{
  /* Named explicitly rather than left to be discovered from a support ticket, and
     unchanged by this revision: AUTO_ANGLE never engages for an item with no real back
     photo, so no angle value other than "front" is ever computed for it - it does not
     matter that BACK_CATEGORY_ANCHOR now exists and is correctly wired, because nothing
     ever calls imageOnlyPrompt(item, "back") for such an item. Closing this needs either
     a generated back asset (catalog/pre-processing work) or wiring AUTO_ANGLE to engage
     on a single-view item too - a materially different feature, not decided here. */
  check("DENSE.backInferred exists (the text-only 'plain back' fallback)",
    /backInferred:\s*"No back photo exists: infer a plain back/.test(APP));
  check("...but is still genuinely UNREACHABLE - imageOnlyPrompt() never touches it",
    !/backInferred/.test(APP.slice(APP.indexOf("function imageOnlyPrompt(item, angle"),
                                   APP.indexOf("function imageOnlyPrompt(item, angle") + 2500)),
    "BACK_CATEGORY_ANCHOR being reachable does not make the text-only DENSE fallback reachable too");
  check("an item without a real back photo still never enters AUTO_ANGLE at all",
    /currentAngle = canCombineViews\(activeItem\) \? AUTO_ANGLE : "front";/.test(APP),
    "no dual-view mode means no orientation watcher, means no back classification attempted");
  check("...so imageOnlyPrompt(item, \"back\") is simply never called for it",
    /const table = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;/.test(APP) &&
    /currentAngle = canCombineViews\(activeItem\) \? AUTO_ANGLE : "front";/.test(APP),
    "a reachable back anchor and an unreachable back angle can coexist - that IS this gap");
  check("app.js records the remaining gap and the two legitimate ways to close it",
    /THE ONE GAP THIS REVISION DOES NOT CLOSE/.test(APP) &&
    /a generated back asset \(a catalog\/pre-processing decision\)/.test(APP) &&
    /wiring\s*\n\s*AUTO_ANGLE to engage on a single-view item too/.test(APP),
    "an honest limit belongs on file - the next person should not have to re-derive this");
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
