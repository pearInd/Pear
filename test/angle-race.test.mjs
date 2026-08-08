/* THE "MIXING" BUG regression test.

   Root cause: applyGarment() resolved the reference image via an AWAITED call
   (referenceImageFor), then computed the prompt clause via a SEPARATE, later call to
   angleClause() that internally re-read the live effectiveAngle(). The
   OrientationWatcher samples the camera on its own independent 250ms interval and can
   confirm a flip (mutating the live autoOrientation lock) at any moment - including
   during that await. If it did, angleClause() picked up the NEW angle while the
   already-resolved imageRef still reflected the OLD one: a FRONT reference paired
   with "reproduce the BACK, do NOT render the front" steering - the model then
   faithfully reproduces the only content it can see (the front chest print) as the
   back. Exactly the failure class this file has fixed once already for a URL-
   matching reason; this is the SAME failure, caused by a bare time-of-check-to-
   time-of-use race instead.

   Fix: angleClause(item, angleOverride) accepts a frozen angle snapshot, and
   applyGarment() takes that snapshot BEFORE its own await and threads it through -
   this test proves the override actually wins over a live, changed effectiveAngle(),
   using the REAL angleClause()/compositeActiveFor() extracted from app.js.

   SECOND BINDING, same function. angleClause() also used to decide FOR ITSELF whether a
   composite was in play, by calling compositeActiveFor() - which reports whether one is
   WANTED, not whether one was actually resolved. referenceImageFor() can want a composite
   and still return a single-view image (the handed-over data URL fails to decode AND the
   local stitch fails). The clause then described a left and a right panel to a model
   holding one photo, and the back instruction pointed at a right panel that did not
   exist - so nothing mapped onto the shopper's back. angleClause(item, angleOverride,
   useComposite) now takes what the caller ACTUALLY sent, and the last block below covers
   it. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

// One contiguous slice: REAR_POSE / BACK_TAIL / ANGLE_CLAUSE / SIDE_PROFILE_DEPTH /
// COMPOSITE_PANEL_CONTRACT / COMPOSITE_APPLY / COMPOSITE_POSE / COMPOSITE_SELECT /
// COMPOSITE_SELECT_PROFILE / buildCompositePrompt / CUSTOM_BACK_INFERRED /
// activeBackIsReal / compositeActiveFor / angleClause all sit back-to-back in app.js, so
// a single extract avoids assembling mismatched fragments.
// Starts at REAR_POSE rather than ANGLE_CLAUSE: the rear pose sentence and the three
// garment tails were factored out ABOVE ANGLE_CLAUSE (so an edge-on pose can replace the
// opener without touching the print instructions), and ANGLE_CLAUSE now references them.
const code = extract("const REAR_POSE", "/**\n * Resolve the reference image handed to rtClient.set");

check("extracted angleClause with the angleOverride + useComposite + inProfile parameters",
  /function angleClause\(item, angleOverride, useComposite, inProfile\)/.test(code));
check("extracted compositeActiveFor", /function compositeActiveFor/.test(code));

/* The composite clause always states the full panel contract, which NAMES BOTH panels -
   that is the point of it. So "which side did it select?" cannot be answered by looking
   for the word FRONT or BACK; it has to be read off the SELECTOR sentence, which names
   one panel as the source and declares the other absent for this frame. */
const SELECTED_FRONT = /Apply the LEFT PANEL \(FRONT view\) design to the FRONT of their body/;
const SELECTED_BACK  = /from the RIGHT PANEL \(BACK view\) and RENDER IT ONTO THE BACK of the person/;

function run({ effectiveAngleReturns, distinctBack, resolveLookReturns = null, custom = false, angleOverride, useComposite, inProfile, currentAngle = "auto" }) {
  const sandbox = {
    COMPOSITE_MODE: true,
    currentAngle,
    AUTO_ANGLE: "auto",
    effectiveAngle: () => effectiveAngleReturns,
    resolveLook: () => resolveLookReturns,
    distinctBackOf: () => distinctBack,
    galleryOf: () => ({ front: "https://cdn.test/front.jpg", back: distinctBack }),
  };
  const fn = new Function(...Object.keys(sandbox), code + "\nreturn { angleClause, compositeActiveFor };");
  const api = fn(...Object.values(sandbox));
  const item = { name: "Tee", custom, img: "https://cdn.test/front.jpg" };
  return api.angleClause(item, angleOverride, useComposite, inProfile);
}

console.log("── THE RACE: a live effectiveAngle() that changed AFTER the snapshot must NOT win ──");
{
  // Simulates: applyGarment() snapshotted "front" (angleAtStart), then the watcher
  // flipped autoOrientation to "back" DURING the await - effectiveAngle() now
  // returns "back" if re-read live, but the frozen snapshot must still govern.
  const clause = run({
    effectiveAngleReturns: "back",       // what a LIVE re-read would now return (the race)
    angleOverride: "front",              // what was actually snapshotted before the await
    distinctBack: "https://cdn.test/back.jpg",
  });
  check("the FRONT snapshot wins - clause selects the FRONT panel, not the back",
    SELECTED_FRONT.test(clause) && !SELECTED_BACK.test(clause),
    clause.slice(0, 200));
}
{
  // The mirror case: snapshotted "back", live re-read would (incorrectly) say "front".
  const clause = run({
    effectiveAngleReturns: "front",
    angleOverride: "back",
    distinctBack: "https://cdn.test/back.jpg",
  });
  check("the BACK snapshot wins - clause selects the BACK panel, not the front",
    SELECTED_BACK.test(clause) && !SELECTED_FRONT.test(clause),
    clause.slice(0, 200));
}

console.log("\n── no override supplied: falls back to a live read (applyLook(), unaffected) ──");
{
  const clause = run({ effectiveAngleReturns: "back", distinctBack: "https://cdn.test/back.jpg", angleOverride: undefined });
  check("omitting the override still reads effectiveAngle() live - existing callers unaffected",
    SELECTED_BACK.test(clause), clause.slice(0, 200));
}

console.log("\n── the override applies in NON-composite mode too (per-orientation single asset) ──");
{
  const clause = run({
    effectiveAngleReturns: "back",   // live value - must be ignored
    angleOverride: "front",          // frozen snapshot - must win
    distinctBack: undefined,         // no real back -> compositeActiveFor() is false, exercises the OTHER branch
  });
  check("non-composite branch also honours the frozen snapshot",
    !clause.toLowerCase().includes("behind") && !clause.toLowerCase().includes("rear view"),
    clause.slice(0, 160));
}

console.log("\n── useComposite: the clause must describe the reference that was ACTUALLY sent ──");
{
  /* The failing case this parameter exists for. A composite is WANTED - AI Auto is on and
     the item has a real, distinct back, so compositeActiveFor() is true - but
     referenceImageFor() fell through to a single-view photo because both the handed-over
     composite and the local stitch failed to produce one. Describing two panels here
     would point the back instruction at a right panel that isn't in the image. */
  const clause = run({
    effectiveAngleReturns: "back",
    angleOverride: "back",
    distinctBack: "https://cdn.test/back.jpg",   // compositeActiveFor() would say "yes"
    useComposite: false,                          // ...but no composite was actually resolved
  });
  check("composite WANTED but not resolved -> no panel contract in the clause",
    !/SPLIT COMPOSITE IMAGE/.test(clause) && !SELECTED_BACK.test(clause), clause.slice(0, 200));
  check("...and it falls back to the single-asset BACK steering instead",
    /This reference photo shows the BACK of the garment/.test(clause), clause.slice(0, 200));
}
{
  // The inverse must still hold: when the composite DID resolve, the contract is stated.
  const clause = run({
    effectiveAngleReturns: "back",
    angleOverride: "back",
    distinctBack: "https://cdn.test/back.jpg",
    useComposite: true,
  });
  check("composite actually resolved -> the panel contract IS stated",
    /SPLIT COMPOSITE IMAGE/.test(clause) && SELECTED_BACK.test(clause), clause.slice(0, 200));
}
{
  /* applyGarment() is the only caller that passes the flag; every other caller omits it
     and must keep the inferred behaviour. Guard against the parameter's default silently
     becoming falsy and turning composite mode off for them. */
  const clause = run({
    effectiveAngleReturns: "back",
    angleOverride: "back",
    distinctBack: "https://cdn.test/back.jpg",
    useComposite: undefined,
  });
  check("useComposite omitted -> still inferred from compositeActiveFor()",
    /SPLIT COMPOSITE IMAGE/.test(clause), clause.slice(0, 200));
}

console.log("\n── the panel contract states LEFT=FRONT / RIGHT=BACK, matching the stitcher ──");
{
  const clause = run({ effectiveAngleReturns: "back", angleOverride: "back", distinctBack: "https://cdn.test/back.jpg" });
  /* createGarmentComposite() draws FRONT at x=0 and BACK at x=fW+gutter, in BOTH
     fitting-room/app.js and pear-widget.js. The prompt asserts that ordering to Decart in
     words; if the stitcher's panel order is ever flipped without flipping this sentence,
     every back render silently reads the wrong half. */
  check("LEFT half is declared the FRONT view",
    /the LEFT HALF is the FRONT view/.test(clause), clause.slice(0, 260));
  check("RIGHT half is declared the BACK view",
    /the RIGHT HALF is the BACK view/.test(clause), clause.slice(0, 260));
  const drawsFrontLeft = /ctx\.rect\(0, 0, fW, pH\)[\s\S]{0,80}drawImageCover\(ctx, front/.test(SRC);
  const drawsBackRight = /const backX = fW \+ gut;[\s\S]{0,160}drawImageCover\(ctx, back, backX/.test(SRC);
  check("...and the stitcher actually draws FRONT left / BACK right", drawsFrontLeft && drawsBackRight,
    `frontLeft=${drawsFrontLeft} backRight=${drawsBackRight}`);
}

console.log("\n── artifact + temporal clauses ride on BOTH orientations ──");
{
  /* Two live bugs are addressed in words as well as pixels, and both are orientation-
     agnostic: a divider painted onto a shirt happens facing forward too, and flicker is
     not a back-only problem. If either clause ever ends up on one branch only, the bug
     comes back on the other half of every session. */
  for (const angle of ["front", "back"]) {
    const clause = run({ effectiveAngleReturns: angle, angleOverride: angle, distinctBack: "https://cdn.test/back.jpg" });
    check(`${angle}: tells the model to ignore canvas furniture`,
      /IGNORE ALL CANVAS FURNITURE/.test(clause) &&
      /Never reproduce a boundary, divider, seam, border, frame, band or letterform/.test(clause),
      clause.slice(0, 260));
    check(`${angle}: names the garment's own seams as the only legal lines`,
      /only lines you may render on the garment are its own real seams, stitching and hems/.test(clause));
    check(`${angle}: asks for temporally consistent output`,
      /temporally consistent frame-to-frame output/.test(clause) && /ZERO flickering/.test(clause),
      clause.slice(-260));
    check(`${angle}: forbids the print vanishing between frames`,
      /print must never vanish, fade or re-position between frames/.test(clause));
  }
}

console.log("\n── the inpainting + rotation clamps are present, and on EVERY prompt builder ──");
{
  /* These two address bugs that are not orientation- or mode-specific: the model
     regenerating the shopper's pants/background, and the virtual top dropping mid-turn.
     A clause that only reaches the composite path leaves the single-asset, custom-upload
     and full-look paths exposed, so assert against the SOURCE that every builder carries
     both - a regex on one rendered clause cannot see the other three builders. */
  const src = SRC.slice(SRC.indexOf("const STRICT_INPAINT"));
  const builders = [
    ["buildPrompt (catalog)", /function buildPrompt\(item\)[\s\S]*?\n}/],
    ["buildCustomPrompt (upload)", /function buildCustomPrompt\(item\)[\s\S]*?\n}/],
    ["buildLookPrompt (full look)", /function buildLookPrompt\(top, bottom\)[\s\S]*?\n}/],
    ["buildCompositePrompt", /function buildCompositePrompt\(item, angle, inProfile\)[\s\S]*?\n}/],
  ];
  for (const [name, re] of builders) {
    const body = (SRC.match(re) || [""])[0];
    check(`${name} applies STRICT_INPAINT`, body.includes("STRICT_INPAINT"), body.slice(-200));
    check(`${name} applies ROTATION_CONTINUITY`, body.includes("ROTATION_CONTINUITY"), body.slice(-200));
  }

  check("STRICT_INPAINT locks face, hair, skin and background as source footage",
    /face, hair, head, neck, hands, arms and skin/.test(src) &&
    /entire background, room and lighting/.test(src) &&
    /locked source footage that must pass through/.test(src));
  check("ROTATION_CONTINUITY forbids revealing the shopper's real garment mid-turn",
    /no frame in which it is dropped, faded, or replaced by the person's own real/.test(src) &&
    /side-on, partially occluded, or facing away/.test(src));
}

console.log("\n── single-view items (no AI Auto) now get a truthful side clause too ──");
{
  /* THE GAP: ANGLE_CLAUSE.front is "" - it never needed its own pose sentence, because
     there used to be no LIVE pose signal at all outside AI Auto. `inProfile` is that
     signal now (the watcher arms for single-view items too - see
     syncOrientationWatcher()'s dualView/singleView split and profileActive()'s
     !!orientWatcher gate) - so a shopper turning edge-on while a single-view item's
     `currentAngle` is still nominally "front" must get more than an empty string. */
  const clause = run({
    currentAngle: "front",           // NOT AUTO_ANGLE - the single-view case
    effectiveAngleReturns: "front",
    angleOverride: "front",
    distinctBack: undefined,         // no real back at all - a custom upload / single photo
    inProfile: true,
  });
  check("reaches for ANGLE_CLAUSE.side's garment-drape wording, not the empty front clause",
    /shoulder line, sleeve, side seam and the way the fabric drapes along the flank/.test(clause),
    clause.slice(0, 260));
  check("...and still carries SIDE_PROFILE_DEPTH (the body-volume fidelity clause)",
    /SIDE-PROFILE DEPTH FIDELITY/.test(clause), clause.slice(0, 120));
}
{
  // Square-on, same single-view session: must fall back to the plain (empty) front clause,
  // not leak ANGLE_CLAUSE.side or the depth clause when there is no live evidence of a turn.
  const clause = run({
    currentAngle: "front",
    effectiveAngleReturns: "front",
    angleOverride: "front",
    distinctBack: undefined,
    inProfile: false,
  });
  check("square-on single-view: no side wording and no depth clause leak in",
    !/shoulder line, sleeve, side seam/.test(clause) && !/SIDE-PROFILE DEPTH FIDELITY/.test(clause),
    JSON.stringify(clause));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
