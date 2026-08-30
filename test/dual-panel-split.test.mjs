#!/usr/bin/env node
/* DUAL-PANEL REFERENCES - "the back text is on my chest before I even turn"
   =============================================================================
   THE TWO SYMPTOMS, and they have one cause:
     1. the large BACK graphic rendered on the FRONT chest from session start;
     2. turning around gives a plain garment with no detailing.

   NEITHER IS A PROMPT BUG, and that was checked before this was built. The front and back
   anchors are clean of each other (front-print-lock.test.mjs SS2), COMPOSITE_DEFAULT is
   false so buildCompositePrompt() reaches no live session, and the reference actually sent
   is whatever galleryOf() calls `front`.

   THE CAUSE IS THAT `front` IS SOMETIMES BOTH VIEWS IN ONE IMAGE. A storefront that
   publishes its product as a single front|back diptych gives this room one photo. galleryOf
   has no way to see two views inside it, so distinctBackOf() finds no back, canCombineViews
   returns false, and the session drops to front-only - with the DIPTYCH as its reference.
   The model is then handed two garments in one frame with no panel contract explaining
   them, which is exactly the ambiguous-reference condition app.js documents as sending a
   diffusion model back to its own prior. It resolves the ambiguity by painting both panels
   onto one torso: symptom 1. And because the session is front-only, turning around never
   swaps anything: symptom 2.

   THE FIX IS TO STOP HANDING IT AN AMBIGUOUS IMAGE - not to explain the ambiguity in words.
   Explaining it is COMBINED mode, which app.js documents as the blank-back bug (23f5953:
   both panels' designs rendered on one surface). Splitting the diptych into two clean
   single-view buffers feeds the architecture that already works: AI Auto swapping between
   two unambiguous photos, one side at a time.

   DETECTION IS DELIBERATELY CONSERVATIVE, because the cost of a false positive is cutting a
   legitimate photo in half. Explicit panel geometry from the widget is used when present.
   Without it, only an aspect ratio at or above DUAL_PANEL_MIN_RATIO qualifies - wide enough
   that a single garment packshot essentially never reaches it. A 16:9 lifestyle shot (1.78)
   is deliberately BELOW the bar, and so is a diptych of two 3:4 portraits (1.5); the second
   is a known miss, accepted so the first can never be destroyed.
   ============================================================================= */

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real geometry helpers, executed. Pure functions by design - the canvas work that
   uses them needs a DOM, but the DECISION and the RECTANGLES are what carry the risk, so
   they are split out where a test can drive them directly. */
const start = SRC.indexOf("const DUAL_PANEL_MIN_RATIO");
const end   = SRC.indexOf("async function deriveDualPanelViews");
if (start === -1 || end === -1) { console.log("FAIL  could not extract the dual-panel helpers"); process.exit(1); }
const sandbox = { console: { log() {}, warn() {} } };
const api = new Function(...Object.keys(sandbox),
  SRC.slice(start, end) +
  "\nreturn { DUAL_PANEL_MIN_RATIO, looksDualPanel, dualPanelRects };")(...Object.values(sandbox));
const { DUAL_PANEL_MIN_RATIO, looksDualPanel, dualPanelRects } = api;

console.log("── §1 DETECTION: wide enough to be two panels, or explicitly said to be ──");
{
  check("the app's own composite shape (2048x1024) reads as dual-panel",
    looksDualPanel(2048, 1024, null) === true);
  check("a square packshot does not",
    looksDualPanel(1000, 1000, null) === false);
  check("a portrait packshot does not",
    looksDualPanel(900, 1200, null) === false);
  /* THE FALSE-POSITIVE THAT MATTERS. Cutting a legitimate wide photo in half destroys the
     reference outright, which is worse than the bug being fixed. */
  check("a 16:9 lifestyle shot stays BELOW the bar - never split a real photo",
    looksDualPanel(1920, 1080, null) === false,
    `1.78 must be under DUAL_PANEL_MIN_RATIO (${DUAL_PANEL_MIN_RATIO})`);
  check("...and the threshold is high enough to mean it",
    DUAL_PANEL_MIN_RATIO > 1.78 && DUAL_PANEL_MIN_RATIO <= 2,
    String(DUAL_PANEL_MIN_RATIO));
  /* The known miss, asserted so it stays a decision rather than a surprise. */
  check("a diptych of two 3:4 portraits is a KNOWN miss, not a silent one",
    looksDualPanel(1200, 800, null) === false,
    "1.5 is below the bar on purpose - see the header");

  console.log("   -- explicit geometry outranks the guess --");
  const L = { w: 2048, h: 1024, front_x: 0, front_w: 976, back_x: 1072, back_w: 976 };
  check("widget-reported panel geometry qualifies whatever the ratio says",
    looksDualPanel(1000, 1000, L) === true,
    "a square image the widget says is two panels IS two panels");
  check("...and malformed geometry falls back to the ratio rather than trusting it",
    looksDualPanel(1000, 1000, { w: 0 }) === false &&
    looksDualPanel(2048, 1024, { w: 0 }) === true);
  check("no dimensions at all is never dual-panel",
    looksDualPanel(0, 0, null) === false && looksDualPanel(undefined, undefined, null) === false);
}

console.log("\n── §2 GEOMETRY: two disjoint halves, and the seam belongs to neither ──");
{
  const r = dualPanelRects(2048, 1024, null);
  check("the front rect is the LEFT half and the back rect is the RIGHT half",
    r.front.x === 0 && r.back.x > r.front.x && r.back.x + r.back.w <= 2048);
  check("...and they never overlap - a shared column is the seam bleeding into both",
    r.front.x + r.front.w <= r.back.x,
    JSON.stringify(r));
  check("...and neither is empty",
    r.front.w > 0 && r.front.h > 0 && r.back.w > 0 && r.back.h > 0);
  check("both halves are the full height when no layout says otherwise",
    r.front.h === 1024 && r.back.h === 1024);

  /* THE APP'S OWN COMPOSITES CARRY A LABEL BAND under the garments ("FRONT"/"BACK"), and
     text cropped into a reference is text that can be composited onto the shopper - the
     artifact composite.test.mjs was written against. Explicit geometry reports the panel
     height, and it must be honoured. */
  const L = { w: 2048, h: 900, front_x: 0, front_w: 976, back_x: 1072, back_w: 976 };
  const rl = dualPanelRects(2048, 1024, L);
  check("explicit geometry is used verbatim, including a height that excludes the label band",
    rl.front.x === 0 && rl.front.w === 976 && rl.back.x === 1072 && rl.back.w === 976 &&
    rl.front.h === 900 && rl.back.h === 900,
    JSON.stringify(rl));
  /* PANELS CAN BE REVERSED. describeCompositeLayout() already warns about it; a splitter
     that assumed LEFT=FRONT would bind the back photo as the front for those. */
  const rev = dualPanelRects(2048, 1024, { w: 2048, h: 1024, front_x: 1072, front_w: 976, back_x: 0, back_w: 976 });
  check("a REVERSED layout binds by role, not by position",
    rev.front.x === 1072 && rev.back.x === 0,
    "left is not front by definition - the layout says which is which");
}

console.log("\n── §3 IT ONLY RUNS WHERE THE BUG IS ──");
{
  const fn = SRC.slice(SRC.indexOf("async function deriveDualPanelViews"),
                       SRC.indexOf("async function deriveDualPanelViews") + 2600);
  check("a garment that already has a real distinct back is left completely alone",
    /distinctBackOf\(/.test(fn) && /return\b/.test(fn),
    "splitting a garment that already has two photos would replace good assets with crops");
  check("bottoms are never split",
    /isBottomsGarment\(/.test(fn));
  check("it runs at most once per item",
    /_panelsDerived/.test(fn),
    "re-splitting an already-split item would crop a crop");
  /* data:, never blob:. garmentImageRef() passes a blob: URL through verbatim and the SDK
     treats any non-data:, non-absolute-http string as raw base64 - it would render an
     arbitrary garment. A data: URL is handled correctly by both. */
  check("the derived panels are data: URLs, never blob:",
    /toDataURL|convertToBlob[\s\S]{0,200}readAsDataURL|FileReader/.test(fn) &&
    !/createObjectURL/.test(fn),
    "a blob: URL here is the silent SDK corruption path");
  check("...and a failure leaves the item untouched rather than half-split",
    /catch\b/.test(fn),
    "a garment with a front crop and no back is worse than an unsplit diptych");
}

console.log("\n── §4 IT IS ACTUALLY CALLED, before the mode is decided ──");
{
  /* The guard-dead-call-site rule. It must also run BEFORE canCombineViews() picks the
     mode, or the split lands too late to enable AI Auto for this session. */
  const goLive = SRC.slice(SRC.indexOf("async function goLive"),
                           SRC.indexOf("await connectRealtime()"));
  check("goLive awaits the split",
    /await deriveDualPanelViews\(/.test(goLive),
    "fire-and-forget here races the mode decision it exists to change");
  check("...BEFORE currentAngle is derived from canCombineViews()",
    goLive.indexOf("await deriveDualPanelViews(") <
      goLive.lastIndexOf("currentAngle = canCombineViews(activeItem)"),
    "split after the mode is chosen and the session still runs front-only");
  check("...and before the pre-load gate, so the derived panels are the ones validated",
    goLive.indexOf("await deriveDualPanelViews(") <
      goLive.indexOf("await preloadGarmentAssets()"));
}

console.log(fails === 0 ? "\ndual-panel-split: OK" : `\ndual-panel-split: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
