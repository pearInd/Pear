/* THE 90-DEGREE SIDE-PROFILE regression test - "it flattens me when I turn sideways".

   REPORTED FAILURE: a shopper with real torso depth (the reproduction case was a pillow
   under a shirt, simulating a belly) turns 90 degrees. The rendered body loses that
   volume: the garment drapes over a generic, slimmer torso instead of over their actual
   front-to-back projection.

   ROOT CAUSE, and it is a prompt-assembly bug rather than a detection one. Two facts
   about this pipeline combine badly:

     1. The orientation lock is BINARY (front | back) and deliberately HOLDS through a
        turn. skinRatioVote()'s dead band abstains on an ambiguous frame instead of
        voting - its own comment read "ambiguous (profile/transition) - abstain" - so at a
        true side-on pose autoOrientation simply stays wherever it last was. That is
        correct for choosing an ASSET: a profile frame is not evidence that the other side
        of the garment should now be showing.

     2. The POSE SENTENCE rode along with that lock. So at 90 degrees the prompt asserted
        "The person is FACING FORWARD, the front of their body toward the camera" (or,
        from the other lock, "has TURNED AROUND ... no face visible") while the pixels
        showed the shopper edge-on.

   Lucy regenerates every frame from the prompt plus that frame. A categorical pose claim
   contradicting the input is not inert: reconciling it means rotating the torso back to
   the asserted view, and a torso rendered as front-on has no profile depth left in it.
   Compounding it, STRICT_INPAINT's body-fidelity language is phrased for the head-on
   axis - it enumerates waist circumference and torso WIDTH - and edge-on, width is
   foreshortened to nearly nothing while the whole silhouette is DEPTH. Nothing in the
   prompt named that axis, so nothing defended it.

   THE FIX, in three separable parts, each asserted below:
     · POSE and PANEL are split, so an edge-on pose can replace the facing assertion
       without disturbing which half of the reference is the texture source.
     · SIDE_PROFILE_DEPTH names the front-to-back axis and pins it to the live frame's own
       silhouette edge - the only ground truth available in a pipeline with no depth
       sensor and no mesh.
     · The watcher reports edge-on on a SEPARATE channel from the front/back vote, so it
       can never perturb the asset lock.

   The last one is the property most worth protecting over time, and §4/§5 exist for it:
   if a future change routes profile into the vote, side-on frames start swapping the
   garment reference and the flapping the lock was built to prevent comes back. */
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

/* Same contiguous slice angle-race.test.mjs uses, and for the same reason: these clause
   constants and angleClause() sit back-to-back, so one extract cannot assemble mismatched
   fragments. Executed, not regex-matched, so the assertions below read the REAL rendered
   prompt rather than a hopeful pattern over source text. */
const code = extract("const REAR_POSE", "/**\n * Resolve the reference image handed to rtClient.set");

function run({ angle = "front", inProfile = false, distinctBack, custom = false, useComposite, auto = true }) {
  const sandbox = {
    COMPOSITE_MODE: true,
    currentAngle: auto ? "auto" : angle,
    AUTO_ANGLE: "auto",
    effectiveAngle: () => angle,
    resolveLook: () => null,
    distinctBackOf: () => distinctBack,
    galleryOf: () => ({ front: "https://cdn.test/front.jpg", back: distinctBack }),
    /* buildCompositePrompt() reaches for these; they live outside the extracted slice and
       are irrelevant to what is asserted here, so they are stubbed as identifiable markers
       rather than reproduced. The clauses under test are all real source. */
    /* The prompt budget the dense builders assemble against. Real value, not a stub:
       fitPrompt() SHEDS clauses to honour it, so a fake number here would test a
       different prompt than the one that ships. */
    PROMPT_MAX_CHARS: 650,
    console: { warn() {}, log() {} },
    KEEP_TOP: "_KEEP_TOP", KEEP_BOTTOMS: "_KEEP_BOTTOMS",
    STRICT_INPAINT: "_STRICT_INPAINT", IGNORE_SOURCE_ARTIFACTS: "_IGNORE_ARTIFACTS",
    MODEL_AGNOSTIC_EXTRACTION: "_MODEL_AGNOSTIC",
    ROTATION_CONTINUITY: "_ROTATION", PROFILE_ANOMALY_GUARD: "_ANOMALY_GUARD",
    SUBTYPE_PROMPT: {}, SHIRT_NOUN: {},
    colorName: () => "black",
    getAnatomicalAnchor: () => "_ANCHOR",
    getFitModifier: () => "_FIT",
    getSizeDelta: () => 0,
    getFabricModifier: () => "_FABRIC",
  };
  const fn = new Function(...Object.keys(sandbox),
    code + "\nreturn { angleClause, buildCompositePrompt, SIDE_PROFILE_DEPTH, COMPOSITE_SELECT, ANGLE_CLAUSE, CUSTOM_BACK_INFERRED };");
  const api = fn(...Object.values(sandbox));
  const item = { name: "Tee", custom, img: "https://cdn.test/front.jpg" };
  return { clause: api.angleClause(item, angle, useComposite, inProfile), api };
}

const BACK = "https://cdn.test/back.jpg";
// Read off the SELECTOR sentence, never the words FRONT/BACK - the panel contract names
// both panels by design, so only the selector says which one was actually chosen.
const SELECTED_FRONT = /Use the LEFT half only; ignore the RIGHT/;
const SELECTED_BACK  = /Use the RIGHT half only; ignore the LEFT/;
const DEPTH_MARKER   = /EDGE-ON: keep their full front-to-back depth/;
const LATERAL_MARKER = /continuing its front and back panels/;

/* A fresh pose state machine driven by the REAL enter/exit arithmetic lifted out of
   maybeUpdateProfile(). Only the decision half is taken - everything after it is cooldown,
   mutex and network - so the thresholds under test are the shipped constants, not a
   paraphrase of them. Returns a step(score) → autoProfile function; call it once per
   simulated 250ms sample. */
function poseMachine() {
  const upd = extract("async function maybeUpdateProfile(score)", "\n  const timer = setInterval");
  const decide = upd.slice(0, upd.indexOf("if (next === autoProfile) return;"));
  const CONSTS = {
    ORIENT_PROFILE_WINDOW: 5, ORIENT_PROFILE_ENTER: 2, ORIENT_PROFILE_ENTER_SCORE: 0.55,
    ORIENT_PROFILE_EXIT: 2, ORIENT_PROFILE_FAST_SCORE: 0.85, ORIENT_PROFILE_FAST_FRAMES: 2,
    ORIENT_PROFILE_EXIT_SCORE: 0.25,
  };
  return new Function(...Object.keys(CONSTS),
    "let profileBuf = [], squareStreak = 0, strongStreak = 0, autoProfile = false;\n" +
    "return (score) => {\n" + decide.slice(decide.indexOf("{") + 1) +
    "\n autoProfile = next; return autoProfile; };")(...Object.values(CONSTS));
}

console.log("── §1 THE RETIRED ARCHIVE IS INTACT (these no longer reach the model) ──");
{
  /* SCOPE CHANGED. These strings used to BE the shipped prompt, and this section pinned
     them so a profile-only change could not silently reword every head-on frame. They are
     now retired: Decart's 226-token ceiling forced the whole clause set into the DENSE
     table, and nothing assembles these any more (see the RETIRED banner in app.js).

     The section is kept, and still passes, because the archive is the written record of
     what each regression needed - and the one-sentence directives that replaced it carry
     the instruction without the reasoning. If a regression returns, this text is what
     someone will read to buy a directive back, so it is worth knowing it is unmodified.
     What it does NOT prove any more is anything about the live prompt; §2 onward do that. */
  const { api } = run({ distinctBack: BACK });
  check("COMPOSITE_SELECT.front still opens with the exact FACING FORWARD sentence",
    api.COMPOSITE_SELECT.front.startsWith(
      " The person is FACING FORWARD, the front of their body toward the camera. Apply the LEFT PANEL"),
    api.COMPOSITE_SELECT.front.slice(0, 140));
  check("COMPOSITE_SELECT.back still opens with the exact TURNED AROUND sentence",
    api.COMPOSITE_SELECT.back.startsWith(
      " The person has TURNED AROUND and is presenting their BACK to the camera - rear view, the back of" +
      " their body toward you, no face visible. Accurately EXTRACT"),
    api.COMPOSITE_SELECT.back.slice(0, 180));
  const REAR = " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera.";
  check("ANGLE_CLAUSE.backReal still opens with the rear pose sentence, then the reproduce-the-back tail",
    api.ANGLE_CLAUSE.backReal.startsWith(REAR + " This reference photo shows the BACK of the garment:"),
    api.ANGLE_CLAUSE.backReal.slice(0, 180));
  check("ANGLE_CLAUSE.backInferred still opens with it too, then the infer-a-plain-rear tail",
    api.ANGLE_CLAUSE.backInferred.startsWith(REAR + " Render the BACK of the garment:"),
    api.ANGLE_CLAUSE.backInferred.slice(0, 180));
  check("CUSTOM_BACK_INFERRED still opens with it, then the custom tail",
    api.CUSTOM_BACK_INFERRED.startsWith(REAR + " Render the BACK of this custom garment."),
    api.CUSTOM_BACK_INFERRED.slice(0, 180));
}

console.log("\n── §2 THE POSE LIE IS GONE: edge-on never asserts a facing ──");
{
  /* COMPRESSED to fit the 226-token ceiling (see config.js PROMPT_MAX_CHARS). The pose
     sentences lost their explicit "do NOT rotate / do NOT re-render as a front-facing
     shot" tails - there is no budget for enumerated negatives - but the LOAD-BEARING
     claim is unchanged and is what these assert: the prompt states the true edge-on
     rotation and never asserts a facing that contradicts the pixels. That contradiction
     is the entire bug this file exists for. */
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true });
  check("composite/front: no longer claims the shopper is FACING FORWARD",
    !/FACING FORWARD/.test(clause) && !/They face the camera/.test(clause),
    clause.slice(0, 300));
  check("composite/front: states the true edge-on rotation instead",
    /They are EDGE-ON in side profile; keep that rotation/.test(clause), clause.slice(0, 300));
}
{
  const { clause } = run({ angle: "back", inProfile: true, distinctBack: BACK, useComposite: true });
  check("composite/back: no longer claims a square rear view",
    !/turned around, back to camera/.test(clause), clause.slice(0, 300));
  check("composite/back: states the true edge-on rotation instead",
    /They are EDGE-ON, part-way turned away; keep that rotation/.test(clause), clause.slice(0, 300));
}
{
  const { clause } = run({ angle: "back", inProfile: true, distinctBack: BACK, useComposite: false });
  check("single-asset/back: the rear POSE sentence is replaced...",
    !/turned around, back to camera/.test(clause) &&
    /They are EDGE-ON, part-way turned away/.test(clause), clause.slice(0, 300));
  /* The back-print PLACEMENT pin survived compression, unlike most enumerated
     instructions - it is the difference between a back print rendered where it belongs
     and one that drifts frame to frame, and that was its own fix. */
  check("...while the reproduce-the-back-print instruction survives",
    /The reference photo shows the garment's BACK: reproduce its back print at the same size and position/.test(clause),
    clause.slice(0, 600));
}
{
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: undefined, useComposite: false });
  check("single-asset/front: the profile pose replaces the 'facing the camera' claim",
    !/They face the camera/.test(clause) &&
    /EDGE-ON in side profile/.test(clause), clause.slice(0, 300));
  check("...and still pins the reference as the garment FRONT (the lock did not move)",
    /The reference photo shows the garment's front/.test(clause), clause.slice(0, 300));
}

console.log("\n── §3 THE DEPTH CLAUSE: the axis that only exists edge-on ──");
{
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true });
  /* COMPRESSED, and this is the single biggest loss in the token-budget rewrite:
     SIDE_PROFILE_DEPTH was 1,816 characters (~454 tokens) of four numbered directives -
     TWICE the entire 226-token budget for one clause - and is now a single sentence.

     Gone: the enumerated protrusion/bulge/overhang language, the explicit foreshortening
     ban, the "do not substitute an idealized profile" negative, and the drape directive.
     Each was written against a reproduced failure, so this IS a weaker instrument. What
     survives is the load-bearing half - naming the front-to-back axis as ground truth and
     forbidding the flattening - because a model with a strong flat-profile prior needs
     the axis NAMED above all else. If the pillow-under-a-shirt case regresses, the fix is
     to buy a directive back out of TRIM, not to re-grow the clause. */
  check("names the front-to-back depth axis - the axis that only exists edge-on",
    /keep their full front-to-back depth/.test(clause), clause.slice(-400));
  /* "never flatten" and the words "ground truth" were dropped when the depth clause and
     the lateral clause MERGED. That merge was forced by the grey-shirt regression: each
     cost ~155 chars separately and the budget could only afford one, so an edge-on frame
     was getting the BODY directive with no GARMENT directive - leaving the side of the
     garment unreferenced, which is precisely where the model substituted a plain grey
     tee. One clause now carries both claims. The depth half is asserted above; the
     garment half is what these now assert, because it is the half that was missing. */
  check("...and now also tells the model how to BUILD the side, not just what body to keep",
    /build the side by continuing its front and back panels/.test(clause),
    clause.slice(-400));
  check("the clause is scoped to EDGE-ON so it cannot fire square-on",
    /EDGE-ON: keep their full front-to-back depth/.test(clause), clause.slice(-400));

  /* PLACEMENT still matters for the same reason it always did - leading tokens dominate
     for this model. Contract → pose → panel → substitution → edge-on directive. */
  const posePos  = clause.indexOf("EDGE-ON in side profile");
  const selPos   = clause.indexOf("Use the LEFT half only");
  const depthPos = clause.indexOf("EDGE-ON: keep their full front-to-back depth");
  check("the panel contract and pose lead, and the depth directive follows them",
    posePos !== -1 && selPos !== -1 && depthPos > posePos && depthPos > selPos,
    `pose@${posePos} select@${selPos} depth@${depthPos}`);
  check("...and the whole clause fits the token budget it was compressed for",
    clause.length <= 650, `${clause.length} chars`);
}
{
  /* Same placement rule in the OTHER builder - the one that assembles the real live
     composite payload. buildCompositePrompt() is not reachable from angleClause(), so a
     regression there would be invisible to every assertion above. */
  const { api } = run({ distinctBack: BACK });
  const built = api.buildCompositePrompt(
    { name: "Tee", custom: true, garmentType: "upper_body" }, "front", true);
  /* ORDER USED TO BE THE CLAIM HERE, and it moved twice: the depth directive led first
     (at 90 degrees the body is what is got wrong), then the reference binding took the
     lead (the grey-shirt regression - what was got wrong was the GARMENT, at every
     angle), then the image anchor did (the tuxedo report).

     STRICT IMAGE-ONLY ENDED THE ARGUMENT: buildCompositePrompt() no longer assembles
     anything, so there is no order to assert. Every clause is a token competing with the
     pixels, and ordering them only chooses which competitor goes first. What is asserted
     instead is that the LIVE composite payload carries the frozen prompt and nothing
     else - the same site, a different property.

     angleClause() above still assembles and is still tested at every branch: it is the
     restore path (its clauses are what a two-line edit plugs back in), and keeping it
     proven is what stops "retired" from decaying into "deleted". */
  /* STILL POSE-INVARIANT - that is this suite's property and it survives intact. What
     changed is that the payload now LEADS with the panel contract, because the reference
     it describes is a split image. The category anchor still ships whole, just behind it. */
  check("the live composite payload is pose-invariant, and leads with the panel contract",
    built === api.buildCompositePrompt(
      { name: "Tee", custom: true, garmentType: "upper_body" }, "front", false) &&
    /^The reference image is a split photo of one garment: LEFT half its front, RIGHT half its back\./.test(built) &&
    /Fit ONLY the reference shirt onto the subject's upper torso\./.test(built),
    built);
  check("...and omits it entirely on a square-on frame",
    !DEPTH_MARKER.test(api.buildCompositePrompt(
      { name: "Tee", custom: true, garmentType: "upper_body" }, "front", false)));
}
{
  /* Every branch, because a clause that reaches only the composite path leaves the
     single-asset, custom-upload and inferred-rear paths exposed - the exact "one more
     prompt-assembly site was missed" failure this repo's history keeps recording. */
  const branches = [
    ["composite/front", { angle: "front", distinctBack: BACK, useComposite: true }],
    ["composite/back", { angle: "back", distinctBack: BACK, useComposite: true }],
    ["single/back real", { angle: "back", distinctBack: BACK, useComposite: false }],
    ["single/back inferred", { angle: "back", distinctBack: undefined, useComposite: false }],
    ["single/back custom", { angle: "back", distinctBack: undefined, custom: true, useComposite: false }],
    ["single/auto front", { angle: "front", distinctBack: undefined, useComposite: false }],
  ];
  for (const [name, opts] of branches) {
    check(`${name}: carries the depth clause when edge-on`,
      DEPTH_MARKER.test(run({ ...opts, inProfile: true }).clause));
    check(`${name}: omits it when square-on (no wasted tokens head-on)`,
      !DEPTH_MARKER.test(run({ ...opts, inProfile: false }).clause));
  }
}

console.log("\n── §3b LATERAL SEAM SYNTHESIS: the band no reference view depicts ──");
{
  /* The side of the garment is photographed by NEITHER panel - the composite holds a front
     and a back, and the flank is the hinge between them. Unreferenced, the cheapest
     completion for that region is the pixels already there: the shopper's real shirt.
     Distinct from SIDE_PROFILE_DEPTH (body geometry) and from ROTATION_CONTINUITY (the
     turn as a temporal event); this is a spatial region being unreferenced at the angle
     where it is most exposed. */
  /* COMPRESSED from 1,543 characters to one sentence. Gone: the enumerated coverage
     language, the extrapolate-don't-relocate directive, and the explicit ban on dragging
     the reference's graphics round onto the flank. What survives is the geometry (wrap +
     side seam) and the SYMPTOM (their own shirt showing through), which is the half that
     names the actual failure. */
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true });
  check("still instructs the side be built from the two reference panels",
    /build the side by continuing its front and back panels/.test(clause),
    clause.slice(-400));
  /* The symptom moved clause. "their own shirt showing" lived in DENSE.assetLock, which
     was CORE and rode EVERY pose - not just edge-on - because the grey-shirt regression
     hit front-facing frames too.

     THE ASSET LOCK IS NOW THE FROZEN PROMPT'S OWN SECOND HALF. The tuxedo report retired
     the standalone enumeration ("never invent a garment, jacket, coat, suit, tuxedo, tie,
     bowtie or badge"): with no negative_prompt field on Decart's set(), every noun in a
     ban ships inside the POSITIVE prompt, where a named garment is a token the sampler
     can steer TOWARD. IMAGE_ONLY_PROMPT carries the one directive that mattered - render
     the provided asset, invent nothing - in the same breath as the instruction it guards,
     which is where the file always argued it belonged ("separating them by a shed-able
     clause is how the negative could go missing while the positive stayed"). Asserted at
     both poses, unchanged in property if not in wording. */
  const { api: lockApi } = run({ distinctBack: BACK });
  const lockItem = { name: "Tee", custom: false, garmentType: "upper_body" };
  for (const prof of [false, true]) {
    const out = lockApi.buildCompositePrompt(lockItem, "front", prof);
    /* THE VOLUME AND PROVENANCE CLAUSES ARE BOTH OFF THE WIRE NOW - the anchor was
       collapsed to a strict 1:1 reference lock after a third report (invented detail on
       the CORRECT garment), then rewritten again around the static-garment/dynamic-body
       split after a fourth (the 0-degree drape STRETCHED over a turned shopper). What
       this section is actually about survives every one of those and is what is asserted
       instead: the payload is pose-invariant, and the reference binding plus the fidelity
       clamp cannot shed at either pose.

       NOTE THE ONE THING THAT DID CHANGE HERE. The prompt is still byte-identical at both
       poses - but the model no longer has to infer the turn from text alone, because the
       topology monitor re-conditions the session on the live frame when the body actually
       rotates (body-topology.test.mjs). The prompt's pose-invariance is now a deliberate
       division of labour rather than a gap. */
    check(`the anchor carries its reference binding at inProfile=${prof}`,
      /the reference shirt onto the subject's upper torso/.test(out),
      out.slice(0, 400));
    check(`...and the non-target garment lock at inProfile=${prof}`,
      /pass through and strictly preserve the subject's LIVE camera feed clothing/.test(out),
      out.slice(0, 400));
  }

  /* THE REGRESSION GUARD survives compression, and had to: the shortest phrasing of this
     clause ("blend the front and back panels") is exactly the one that would contradict
     the impassable-wall contract and re-open the 23f5953 double-print bug. Brevity makes
     that trap MORE tempting, not less. */
  check("does NOT instruct the model to blend the two panels (the 23f5953 double-print trap)",
    !/blend/i.test(clause),
    "lateral continuity must stay geometric, never a cross-panel design blend");
  check("the panel-exclusion contract SURVIVES alongside it",
    /Use the LEFT half only; ignore the RIGHT/.test(clause), clause.slice(0, 400));
}
{
  /* Same every-branch sweep §3 runs for the depth clause, for the same reason: a clause
     that reaches only the composite path leaves single-asset, custom-upload and
     inferred-rear exposed. Single-view items have no back panel at all, which is why the
     wording says "the reference view named above" rather than naming a panel. */
  const branches = [
    ["composite/front", { angle: "front", distinctBack: BACK, useComposite: true }],
    ["composite/back", { angle: "back", distinctBack: BACK, useComposite: true }],
    ["single/back real", { angle: "back", distinctBack: BACK, useComposite: false }],
    ["single/back inferred", { angle: "back", distinctBack: undefined, useComposite: false }],
    ["single/back custom", { angle: "back", distinctBack: undefined, custom: true, useComposite: false }],
    ["single/auto front", { angle: "front", distinctBack: undefined, useComposite: false }],
  ];
  for (const [name, opts] of branches) {
    check(`${name}: carries the lateral synthesis clause when edge-on`,
      LATERAL_MARKER.test(run({ ...opts, inProfile: true }).clause));
    check(`${name}: omits it when square-on (the band is not in view head-on)`,
      !LATERAL_MARKER.test(run({ ...opts, inProfile: false }).clause));
  }
}
{
  /* The live payload builder, unreachable from angleClause() - §3 makes the same point
     for the depth clause. Ordering: body geometry, then the garment covering it, then the
     garment description. The second clause only means anything given the first. */
  const { api } = run({ distinctBack: BACK });
  const item = { name: "Tee", custom: true, garmentType: "upper_body" };
  const built = api.buildCompositePrompt(item, "front", true);
  /* THE ORDERING CLAIM IS RETIRED WITH THE ASSEMBLY - see §3's note. The edge-on
     directive is still built by angleClause() and still asserted at every branch above;
     what it no longer does is ride the live composite payload, because that payload is
     one frozen string. Pinned as an absence so the two facts cannot drift apart: if a
     clause ever reappears in this builder, the mode has been half-undone. */
  /* THE POSE CLAUSES STAY RETIRED - the absence this section owns is unchanged. The panel
     SELECTOR is the one thing that is now present, and it is not a pose clause: it names
     which half of the reference to read, which is the same at either pose. */
  check("the live composite payload carries the panel selector and NO pose clause",
    !LATERAL_MARKER.test(built) && !DEPTH_MARKER.test(built) &&
    /Use the LEFT half only/.test(built) &&
    !LATERAL_MARKER.test(api.buildCompositePrompt(item, "front", false)),
    built);
}

console.log("\n── §3c THE FROZEN PROMPT rides BOTH orientation states ──");
{
  /* WHAT THIS SECTION USED TO ASSERT, and why it changed twice. DENSE.modelAgnostic
     ("ignore the reference model's body; fit the cloth to THIS person") was pinned here
     as NOT profile-gated: the reference figure's anatomy bleeds at every angle, so it had
     to be present square-on and edge-on alike. It was demoted CORE → HIGH → MED as
     grounding clauses displaced it, and edge-on it already shed.

     The image-first refactor retired it from assembly; strict image-only then retired
     every other clause with it - see IMAGE_ONLY_PROMPT for the mechanism and the DENSE
     table for the restore list. The property this section exists to guard (the
     load-bearing directive must survive BOTH pose states, because a clause that quietly
     sheds at 90 degrees is indistinguishable from one that was never added) is unchanged;
     it now guards the frozen prompt, which is the only text left.

     THE LOSS, recorded rather than dropped: the reference model's build can bleed into a
     rendered frame again, at every angle now instead of only edge-on. That is the known
     cost of the trade, and model-agnostic.test.mjs §2 keeps the restore path asserted. */
  const { api } = run({ distinctBack: BACK });
  const item = { name: "Tee", custom: true, garmentType: "upper_body" };
  /* NOT ^-ANCHORED ANY MORE: the panel contract leads the composite payload (see the
     builder). The property here is that the anchor ships WHOLE and identically at both
     poses, which is unchanged - only its offset in the string moved. */
  const FROZEN = /Fit ONLY the reference shirt onto the subject's upper torso\./;
  for (const prof of [false, true]) {
    check(`the category anchor is what ships at inProfile=${prof} - never shed, never varied`,
      FROZEN.test(api.buildCompositePrompt(item, "front", prof)),
      api.buildCompositePrompt(item, "front", prof).slice(0, 300));
  }
  check("...and it is byte-identical across both poses, not merely present in both",
    api.buildCompositePrompt(item, "front", false) === api.buildCompositePrompt(item, "front", true));
  /* THE CATEGORY BRANCH MUST NOT BECOME A POSE BRANCH. The prompt now varies on exactly
     one axis - which body region is being replaced - and this suite owns the proof that
     POSE is not a second one. Checked on the bottoms branch too, because it is the newer
     of the two and the one whose anchor a future edit is likelier to reach for. */
  const jeans = { name: "Glide Slim", custom: true, garmentType: "lower_body" };
  check("the BOTTOMS anchor is equally pose-invariant, and is a different string",
    api.buildCompositePrompt(jeans, "front", false) === api.buildCompositePrompt(jeans, "front", true) &&
    /Fit ONLY the reference pants\/shorts onto the subject's lower body\./.test(
      api.buildCompositePrompt(jeans, "front", false)) &&
    api.buildCompositePrompt(jeans, "front", false) !== api.buildCompositePrompt(item, "front", false),
    api.buildCompositePrompt(jeans, "front", false).slice(0, 200));
  check("the retired isolation clause is no longer assembled at either pose",
    !/[Ii]gnore the reference model's body/.test(api.buildCompositePrompt(item, "front", false)) &&
    !/[Ii]gnore the reference model's body/.test(api.buildCompositePrompt(item, "front", true)),
    "retired deliberately by the image-first refactor - see DENSE's restore note");
}

console.log("\n── §4 DECOUPLING: profile changes the POSE, never the panel/asset ──");
{
  /* The load-bearing property. Which panel is the texture source is decided by the
     orientation lock; being edge-on must not touch it. If profile ever starts selecting a
     panel, a shopper turning through 90 degrees gets the wrong half of the garment. */
  for (const inProfile of [false, true]) {
    check(`front lock + inProfile=${inProfile}: still selects the LEFT/FRONT panel`,
      SELECTED_FRONT.test(run({ angle: "front", inProfile, distinctBack: BACK, useComposite: true }).clause));
    check(`back lock + inProfile=${inProfile}: still selects the RIGHT/BACK panel`,
      SELECTED_BACK.test(run({ angle: "back", inProfile, distinctBack: BACK, useComposite: true }).clause));
  }
  const profiled = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true }).clause;
  check("the panel contract itself is unchanged edge-on (LEFT=front / RIGHT=back still stated)",
    /LEFT half its front, RIGHT half its back/.test(profiled), profiled.slice(0, 300));
  check("cross-panel bleed is still forbidden edge-on",
    /ignore the RIGHT/.test(profiled), profiled.slice(0, 400));
  /* The canvas-furniture ban is LOW priority and lives only in the full builders now.
     It guards a cosmetic artifact - a panel divider painted onto the shirt - and after
     the grey-shirt regression it must never compete with the clauses that decide WHICH
     garment renders at all. Its absence here is the ranking working. */
  check("the canvas-furniture ban does NOT outrank grounding in the angle clause",
    !/Ignore the gap, the background/.test(profiled), profiled.slice(0, 300));
}

console.log("\n── §5 THE WATCHER: edge-on is a separate channel from the front/back vote ──");
{
  const watcher = extract("function createOrientationWatcher()", "\n/* Decode a garment URL into an ImageBitmap");

  /* The dead band was the discarded signal, and it must still ABSTAIN from the vote -
     returning a value here would feed the streak arithmetic and move the lock. The profile
     channel now reads that abstention in classify() rather than being set here. */
  check("the skin dead band still returns null, so the front/back lock is untouched by it",
    /\/\/ The dead band[\s\S]{0,400}if \(!vote\) \{ lastConfidence = 0; return null; \}/.test(watcher) ||
    /if \(!vote\) \{ lastConfidence = 0; return null; \}/.test(watcher));
  check("a low-confidence read also abstains rather than voting",
    /if \(lastConfidence < ORIENT_CONFIDENCE_MIN\) return null;/.test(watcher));
  check("ambiguity is derived from the withheld VOTE, not re-detected separately",
    /const skinAmbiguous = !faceSeen && vote === null;/.test(watcher));
  check("a DETECTED face is a hard veto on the profile score",
    /if \(faceSeen\) return 0;/.test(watcher));
  check("the chroma lighting guard only WITHHOLDS a vote, never creates or flips one",
    /if \(vote === "back" && chromaSkinRatio\([\s\S]{0,80}\) \{\s*lastConfidence = 0;\s*return null;\s*\}/.test(watcher),
    "the guard must return null, never assign vote = something else");
  check("the width baseline is learned ONLY from confident square-on votes",
    /if \(vote && !skinAmbiguous && width !== null\) \{/.test(watcher));

  const upd = extract("async function maybeUpdateProfile(score)", "\n  const timer = setInterval");
  check("maybeUpdateProfile NEVER assigns the orientation lock",
    !/autoOrientation\s*=/.test(upd), upd.slice(0, 300));
  check("...and never touches the frozen garment assets",
    !/GARMENT_FRONT|GARMENT_BACK/.test(upd));
  check("it shares the `applying` mutex, so a pose update and an asset swap cannot overlap",
    /applying = true;/.test(upd) && /applying = false;/.test(upd), upd.slice(0, 400));
  check("scores go into a bounded rolling window, not an unbounded array",
    /profileBuf\.push\(score\);/.test(upd) &&
    /if \(profileBuf\.length > ORIENT_PROFILE_WINDOW\) profileBuf\.shift\(\);/.test(upd), upd.slice(0, 400));
  check("ENTERING is decided on the windowed MEAN, not a single frame",
    /mean >= ORIENT_PROFILE_ENTER_SCORE/.test(upd), upd.slice(0, 900));
  check("...and requires the window to have filled to ORIENT_PROFILE_ENTER first",
    /profileBuf\.length >= ORIENT_PROFILE_ENTER/.test(upd), upd.slice(0, 900));
  check("LEAVING is decided on a consecutive square-on run, not the (slow-falling) mean",
    /squareStreak >= ORIENT_PROFILE_EXIT/.test(upd), upd.slice(0, 900));
  check("the exit test uses its own lower band, so the two thresholds do not sit on one boundary",
    /squareStreak = score <= ORIENT_PROFILE_EXIT_SCORE \? squareStreak \+ 1 : 0;/.test(upd), upd.slice(0, 500));
  check("it is cooldown-guarded against oscillation around the threshold",
    /Date\.now\(\) - lastProfileAt < ORIENT_PROFILE_COOLDOWN_MS/.test(upd));
  check("it bails when the session is no longer live (but NOT merely for leaving AI Auto - " +
    "this axis now runs for single-view items too, see profileActive()'s comment)",
    /if \(disposed \|\| !isLive\(\)\) return;/.test(upd) &&
    !/currentAngle !== AUTO_ANGLE\) return;\n\n {4}applying = true;/.test(upd));

  const tick = extract("const timer = setInterval", "if (dualView && confirmed) await maybeSwap(lastVote);");
  /* Fire-and-forget since the 90-degree freeze work: awaiting it held the sampler's
     `sampling` flag across a network round-trip, so the next orientation sample was
     skipped and the watcher went stale during the very turn it tracks. The GATE is what
     this asserts and it is unchanged; the `applying` mutex inside maybeUpdateProfile is
     what makes dropping the await safe. */
  check("the tick skips the pose update only for a PENDING DUAL-VIEW swap (no redundant second set())",
    /if \(!\(dualView && confirmed\)\) \{\s*\n(?:[^\n]*\n)*?\s*maybeUpdateProfile\(lastProfileScore\)\.catch\(\(\) => \{\}\);/.test(tick),
    tick.slice(-400));
}

console.log("\n── §5b THE PIXEL METRICS, EXECUTED against synthetic frames ──");
{
  /* chromaSkinRatio / torsoWidth / narrowness / profileScore are pure functions over a
     pixel buffer and a couple of constants, so they are RUN here rather than regex-matched.
     Regex can prove a threshold is mentioned; only execution proves it behaves - and the
     failure modes that matter for this feature (a low-contrast room, a cluttered backdrop,
     a silhouette that narrows) are all expressible as a 96x96 buffer. */
  const S = 96;
  const CONSTS = { ORIENT_SIZE: S, ORIENT_NARROW_RATIO: 0.78, ORIENT_NARROW_FLOOR: 0.55, ORIENT_BASELINE_MIN: 3 };
  const helpers = extract("  function chromaSkinRatio", "  /* One vote:");
  const mk = new Function(...Object.keys(CONSTS),
    "let baselineWidth = 0, baselineSamples = 0;\n" + helpers +
    "\nreturn { chromaSkinRatio, torsoWidth, narrowness, profileScore," +
    " setBaseline: (w, n) => { baselineWidth = w; baselineSamples = n; } };");
  const M = mk(...Object.values(CONSTS));

  /* A frame: uniform background, optional centred subject block spanning the torso band.
     `noise` perturbs the background per pixel, which is how a cluttered room is simulated. */
  function frame({ bg = [200, 200, 200], subj = null, widthFrac = 0, noise = 0 }) {
    const px = new Uint8ClampedArray(S * S * 4);
    const x0 = Math.round((S - widthFrac * S) / 2), x1 = x0 + Math.round(widthFrac * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const inSubj = subj && widthFrac > 0 && x >= x0 && x < x1 && y >= S * 0.40 && y < S * 0.90;
        const c = inSubj ? subj : bg;
        const j = noise ? (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1) * noise : 0;
        px[i] = c[0] + j; px[i + 1] = c[1] + j; px[i + 2] = c[2] + j; px[i + 3] = 255;
      }
    }
    return px;
  }

  // ── torsoWidth: measures the silhouette, and refuses when it cannot ──
  const wide = M.torsoWidth(frame({ subj: [40, 40, 40], widthFrac: 0.60 }));
  check("torsoWidth measures a wide (square-on) silhouette",
    wide !== null && Math.abs(wide - 0.60) < 0.05, `got ${wide}`);
  const narrow = M.torsoWidth(frame({ subj: [40, 40, 40], widthFrac: 0.34 }));
  check("torsoWidth measures a narrowed (edge-on) silhouette",
    narrow !== null && Math.abs(narrow - 0.34) < 0.05, `got ${narrow}`);
  check("torsoWidth ABSTAINS on a cluttered backdrop rather than reporting full width",
    M.torsoWidth(frame({ subj: [40, 40, 40], widthFrac: 0.60, noise: 190 })) === null,
    "a busy background makes 'differs from background' meaningless - it must return null");
  check("torsoWidth abstains on an empty frame (no subject at all)",
    M.torsoWidth(frame({ widthFrac: 0 })) === null);
  check("torsoWidth abstains when the subject fills the frame (too close to measure)",
    M.torsoWidth(frame({ subj: [40, 40, 40], widthFrac: 0.98 })) === null);

  // ── narrowness: relative to the shopper's OWN baseline, and gated on having one ──
  M.setBaseline(0, 0);
  check("narrowness refuses to answer before a baseline is established",
    M.narrowness(0.34) === null, "no baseline yet - must not guess");
  M.setBaseline(0.60, 5);
  const nNarrow = M.narrowness(0.34);          // ratio 0.57 - a real 90° turn
  check("a narrowed silhouette yields strong POSITIVE foreshortening evidence",
    nNarrow !== null && nNarrow > 0.7, `got ${nNarrow}`);
  const nSquare = M.narrowness(0.60);          // ratio 1.0 - standing square-on
  check("a baseline-width silhouette yields NEGATIVE evidence (the veto)",
    nSquare !== null && nSquare < -0.5, `got ${nSquare}`);
  check("narrowness passes through torsoWidth's abstention",
    M.narrowness(null) === null);

  // ── profileScore: the fusion table, including the case this pass exists for ──
  const ENTER = 0.55;
  check("a DETECTED face is an absolute veto, whatever else is true",
    M.profileScore(true, false, true, 1) === 0, "a visible frontal face cannot be edge-on");
  check("THE JITTER CASE: ambiguous skin (dim room) + NORMAL width is correctly REJECTED",
    M.profileScore(false, true, true, nSquare) < ENTER,
    `score ${M.profileScore(false, true, true, nSquare)} must stay under ${ENTER}`);
  check("a real 90° turn (ambiguous skin + narrowed silhouette) saturates well over the bar",
    M.profileScore(false, true, true, nNarrow) >= 0.9,
    `got ${M.profileScore(false, true, true, nNarrow)}`);
  check("GRACEFUL DEGRADATION: ambiguous skin alone still passes when width is unavailable",
    M.profileScore(false, false, true, null) >= ENTER,
    "a cluttered-room session must degrade to the previous behaviour, not lose the feature");
  check("a missed face ALONE is not enough - it is also every ordinary detection failure",
    M.profileScore(false, true, false, null) < ENTER,
    `got ${M.profileScore(false, true, false, null)}`);
  check("narrowing alone, with a confident skin read, is not enough either",
    M.profileScore(false, false, false, nNarrow) < ENTER,
    `got ${M.profileScore(false, false, false, nNarrow)}`);
  check("the score is always clamped to 0..1",
    M.profileScore(false, true, true, 1) <= 1 && M.profileScore(false, false, false, -1) >= 0);

  // ── chromaSkinRatio: the lighting-invariance claim, tested as such ──
  /* The RGB (Kovac) rule requires r>95 and max-min>15. A dim warm frame fails both while
     still being skin - that is the exact condition that used to become a confident BACK
     vote. Chroma keeps its Cb/Cr signature because it discards luminance. */
  const dimSkin = frame({ bg: [72, 52, 44] });            // dark skin-toned wash, r < 95
  const chroma = M.chromaSkinRatio(dimSkin, 24, 0, 48, 43);
  check("chroma still sees skin in a frame too dim for the RGB rule",
    chroma > 0.5, `chroma ratio ${chroma} - this is what withholds the false BACK vote`);
  const notSkin = frame({ bg: [60, 130, 190] });          // blue wall - must not read as skin
  check("...and does not fire on a plainly non-skin (blue) frame",
    M.chromaSkinRatio(notSkin, 24, 0, 48, 43) < 0.05);
}

console.log("\n── §5c THE ROLLING WINDOW: sustained hysteresis in both directions ──");
{
  const step = poseMachine();
  check("a single high frame does NOT flip the pose (one noisy sample is not a turn)",
    step(1) === false);
  check("two sustained high frames DO - a decisive turn is caught in ~500ms",
    step(1) === true, "the ORIENT_PROFILE_FAST_SCORE path: two unambiguous samples");
  check("one low frame mid-profile does NOT drop it (the anti-jitter ask)",
    step(0) === true, "exit requires ORIENT_PROFILE_EXIT consecutive square-on windows");
  check("...but two consecutive low frames DO release it",
    step(0) === false);

  /* Oscillating right at the boundary is the reported jitter symptom. These scores sit
     around the enter threshold but never reach ORIENT_PROFILE_FAST_SCORE, so the fast path
     cannot fire and the windowed mean is what answers - which is the whole point of it. */
  const osc = poseMachine();
  const seq = [0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5].map(osc);
  const flips = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
  check("an oscillating near-threshold stream settles instead of toggling every tick",
    flips <= 1, `${flips} transitions across 8 borderline samples: ${JSON.stringify(seq)}`);

  /* THE TWO ENTRY PATHS COVER DISJOINT CASES, which is what makes it safe to have both.
     The windowed mean is slow on purpose, and on a decisive turn that slowness is a defect:
     the window still holds pre-turn scores, so EDGE-ON landed a full sample late (~110°
     instead of 90° on §5d's spin). The fast path fixes exactly that, and cannot fire on the
     borderline stream above - so it buys responsiveness without spending any of the
     jitter protection. */
  /* Both machines are PRIMED with square-on history first - that history is the whole
     reason the two paths diverge. On an empty buffer the mean has nothing to drag it down
     and enters at two samples regardless, so priming is what makes the comparison real
     (and is also what actually happens: a shopper is always standing there before turning). */
  const prime = (m) => { [0.05, 0.05, 0.05, 0.05].forEach(m); return m; };

  const fast = prime(poseMachine());
  check("the fast path needs TWO strong samples, not one",
    fast(0.95) === false, "one unambiguous frame is still not a turn");
  check("...and then enters immediately, despite a window still full of square-on history",
    fast(0.95) === true, "mean here is only ~0.41 - the fast path is what carries it");

  const slow = prime(poseMachine());
  const belowFast = [0.8, 0.8, 0.8, 0.8].map(slow);
  check("scores just under ORIENT_PROFILE_FAST_SCORE do NOT take the fast path",
    belowFast[0] === false && belowFast[1] === false, JSON.stringify(belowFast));
  /* Four samples - a full second - because the square-on history has to age out of the
     window before the mean can clear. That latency is the measured cost the fast path is
     paid to avoid, and pinning it here is what stops the two paths being "tidied" into one. */
  check("...they wait for the windowed MEAN to clear, which takes the full window",
    belowFast[2] === false && belowFast[3] === true, JSON.stringify(belowFast));
}

console.log("\n── §5d THE 360 SPIN: pose pivots FRONT → PROFILE → BACK, lock follows separately ──");
{
  /* A continuous rotation, sample by sample, driving the REAL enter/exit arithmetic and
     the REAL lock arithmetic side by side - the two things this feature keeps apart.

     The ordering property being proved is not obvious and is worth stating: the pose
     RELEASES before the lock FLIPS, always. A lock flip needs ORIENT_LOCK_FRAMES (10)
     consecutive CONFIDENT agreeing votes, and a confident vote is by definition not
     ambiguous, so it scores low and feeds squareStreak. By the time the tenth arrives the
     exit threshold (2) has long since been met. That is why a completed turn does not sit
     asserting "edge-on" over a squarely-turned back. */
  const machine = poseMachine();

  /* One spin. Scores model what the fused metric reports through the rotation: square-on
     facing (confident, low), quarter/profile (ambiguous + narrowed, high), then square-on
     back (confident again, low). Votes model what the LOCK sees - it abstains through the
     ambiguous middle, which is exactly why it holds. */
  const spin = [
    { deg: 0,   score: 0.05, vote: "front" }, { deg: 0,   score: 0.05, vote: "front" },
    { deg: 20,  score: 0.10, vote: "front" }, { deg: 45,  score: 0.62, vote: null },
    { deg: 70,  score: 0.95, vote: null },    { deg: 90,  score: 1.00, vote: null },
    { deg: 110, score: 0.95, vote: null },    { deg: 135, score: 0.70, vote: null },
    { deg: 160, score: 0.20, vote: "back" },  { deg: 180, score: 0.05, vote: "back" },
    { deg: 180, score: 0.05, vote: "back" },  { deg: 180, score: 0.05, vote: "back" },
  ];
  const trace = spin.map((s) => ({ deg: s.deg, profile: machine(s.score), vote: s.vote }));
  const at = (deg) => trace.find((t) => t.deg === deg);

  check("0° facing the camera: square-on, no depth clause",
    at(0).profile === false);
  check("45° quarter turn: not yet asserted (one borderline sample is not a turn)",
    at(45).profile === false);
  check("90° full profile: EDGE-ON asserted",
    at(90).profile === true, JSON.stringify(trace.map((t) => `${t.deg}:${t.profile}`)));
  check("135° still turning: EDGE-ON held through the ambiguous middle",
    at(135).profile === true);
  check("180° squarely turned around: pose released again",
    at(180).profile === false, JSON.stringify(trace.map((t) => `${t.deg}:${t.profile}`)));

  /* The lock's own arithmetic over the same spin: it must NOT have moved during the
     profile window, because every sample there abstains. */
  const confidentVotes = spin.filter((s) => s.vote !== null).length;
  const abstainedDuringProfile = spin.filter((s) => s.deg >= 45 && s.deg <= 135 && s.vote === null).length;
  check("every sample through the profile window abstained from the front/back vote",
    abstainedDuringProfile === 5, `${abstainedDuringProfile} abstentions`);
  check("...so the garment reference lock had no confirmed evidence to act on mid-turn",
    confidentVotes === 7, "front×3 then back×4 - the lock only ever sees square-on frames");

  /* And the ordering claim itself. */
  const releaseIdx = trace.findIndex((t, i) => i > 0 && trace[i - 1].profile && !t.profile);
  const firstBackIdx = spin.findIndex((s) => s.vote === "back");
  check("THE ORDERING: the pose releases at or before the first confident BACK vote",
    releaseIdx !== -1 && releaseIdx <= firstBackIdx + 1,
    `release@${releaseIdx} firstBack@${firstBackIdx} - a lock flip needs 10 such votes, far later`);
}

console.log("\n── §5e TRANSITION CONTINUITY: the anti-snap clauses ride on profile prompts too ──");
{
  /* A pose change is prompt-only, so there is no blank-reference window to freeze (that is
     what orientHold covers for ASSET swaps). What keeps the rendered fabric from snapping
     across the change is the temporal/rotation language, and it must therefore be present
     on the edge-on prompt as well as the square-on one - if it rode only the square-on
     branch, every transition would drop the very clause that smooths it. */
  /* THE TRADE-OFF COMPRESSION FORCED, asserted rather than hoped for. The temporal and
     photorealism directives are TRIM: they survive square-on, where there is budget, and
     are deliberately shed edge-on, where the depth and lateral directives need the room.
     That is a real regression risk for flicker at 90 degrees - it is recorded here so it
     is a known, chosen trade rather than a silent one. */
  const { api } = run({ distinctBack: BACK });
  const item = { name: "Tee", custom: true, garmentType: "upper_body" };
  const square = api.buildCompositePrompt(item, "front", false);
  const built  = api.buildCompositePrompt(item, "front", true);
  /* THE SHED LADDER IS GONE, and that is the assertion now. It was re-pinned twice - by
     the grey-shirt regression (everything down a rung to make room for the reference
     binding) and by the first tuxedo fix (the non-structural tier retired wholesale) -
     and strict image-only removed the last rung with it. There is one frozen string and
     nothing to shed, at any pose.

     THE ANTI-SNAP LANGUAGE THIS SECTION WAS WRITTEN FOR IS THE REAL LOSS. A pose change
     is prompt-only, so nothing freezes the view across it (orientHold covers ASSET swaps
     only); what kept the rendered fabric from snapping was the temporal/rotation wording,
     and it is retired. In this mode a pose change sends NOTHING AT ALL - the prompt is
     identical, so applyGarment() skips the dispatch - which means the transition is now
     handled entirely by the model's own frame-to-frame coherence. That is a genuine bet,
     and DENSE.temporal is the clause to buy back first if fabric starts snapping at 90
     degrees. Stated explicitly so it is a known trade, not a silent one. */
  check("no polish, pose or depth clause is assembled at either pose",
    !/Stable print, no flicker/.test(square) && !/Stable print, no flicker/.test(built) &&
    !/keep their full front-to-back depth/.test(built) &&
    !/EDGE-ON/.test(built), built.slice(-260));
  check("body fidelity is retired at both poses too, not merely shed edge-on",
    !/never slim them/.test(square) && !/never slim them/.test(built), square.slice(-260));
  check("the passthrough clamp is retired with them - the largest loss, recorded",
    !/pass through untouched/.test(square) && !/pass through untouched/.test(built),
    "if this ever passes again, inpaintLock was restored - update app.js's restore list");
  /* CLOSED_BACK_HEM went off the wire with the 1:1 collapse, and the invent/add/alter
     clamp with the dynamic-drape revision after it - see CATEGORY_ANCHOR in app.js for
     the full list and the restore path for each. Byte-identity across poses is the
     property this section owns, and it is unaffected by either. */
  check("what survives at both poses is the category anchor, byte-identical",
    square === built &&
    /Fit ONLY the reference shirt onto the subject's upper torso\./.test(square) &&
    /without generating, replacing, or inventing any new pants or garments\./.test(square) &&
    /* NO LONGER THE TAIL: the panel contract leads this payload and the furniture-ignore
       clause closes it, so the anchor now sits whole in the middle. Asserted as "present
       intact" PLUS an explicit tail check, which is strictly more than the old $-anchor
       proved - it pins both ends rather than assuming the anchor owned one of them. */
    /Ignore the gap, the background and any FRONT\/BACK label\.$/.test(square));
  check("both payloads stay inside the token budget",
    square.length <= 650 && built.length <= 650, `square=${square.length} edge=${built.length}`);
}

console.log("\n── §6 NO TOCTOU: the pose is a frozen snapshot, like the angle ──");
{
  /* Same race angle-race.test.mjs was written for: the watcher samples on its own 250ms
     interval and can toggle the pose during applyGarment()'s await, which would leave the
     pose sentence describing a different moment than the resolved reference. */
  const apply = extract("async function applyGarment(item) {", "\n/**\n * Reads the Screen 1 physical inputs");
  check("applyGarment snapshots profileActive() ONCE, before any await",
    /const profileAtStart = profileActive\(\);/.test(apply));
  const snapAt = apply.indexOf("const profileAtStart");
  const awaitAt = apply.indexOf("await referenceImageFor");
  check("...and the snapshot is taken BEFORE the reference is resolved",
    snapAt !== -1 && awaitAt !== -1 && snapAt < awaitAt, `snapshot@${snapAt} await@${awaitAt}`);
  check("both prompt builders receive the frozen snapshot, never a fresh read",
    /buildCompositePrompt\(item, angleAtStart, profileAtStart\)/.test(apply) &&
    /angleClause\(item, angleAtStart, false, profileAtStart\)/.test(apply), apply.slice(-600));
  check("applyGarment never re-reads profileActive() after the await",
    apply.split("profileActive()").length - 1 === 1, "expected exactly one read");

  const look = extract("const canStitchLook = currentAngle !== AUTO_ANGLE;", "if (!primaryImage) {");
  const lookSnap = look.indexOf("const profileAtStart");
  const lookAwait = look.indexOf("await stitchLookBlob");
  check("applyLook snapshots it before the stitch await too",
    lookSnap !== -1 && lookAwait !== -1 && lookSnap < lookAwait, `snapshot@${lookSnap} await@${lookAwait}`);
  check("...and threads it into its angleClause() call",
    /angleClause\(undefined, undefined, undefined, profileAtStart\)/.test(look), look.slice(-300));
}

console.log("\n── §7 profileActive() is scoped to a LIVE watcher, not to AI Auto specifically ──");
{
  /* Used to gate on `currentAngle === AUTO_ANGLE` directly - back when only dual-view
     items (a real, distinct back photo) ever armed a watcher at all, the two were the same
     thing. Single-view items (custom uploads, single-photo catalog items) now arm a
     profile-only watcher too (see syncOrientationWatcher()'s dualView/singleView split),
     and for them currentAngle never becomes AUTO_ANGLE - so gating on it here would silently
     discard their profile reading and reintroduce the exact bug this section used to guard
     against, just for a different class of item. `!!orientWatcher` is the correct
     generalisation: true only while a watcher is live and computing autoProfile for the
     CURRENT item; no watcher (any manual tab, on an item with no camera stream, etc.) means
     no pose to report, same as before. */
  check("profileActive() gates on a live watcher, not on AUTO_ANGLE specifically",
    /function profileActive\(\) \{ return !!orientWatcher && autoProfile; \}/.test(SRC));
  check("autoProfile is reset when AI Auto is (re-)armed from the angle selector",
    /autoOrientation = null;\s*\/\/ PENDING - acquired from the camera, not assumed\n\s*autoProfile = false;/.test(SRC));
  check("...and when it is armed at go-live",
    /autoOrientation = null;\s*\/\/ PENDING - no startup FRONT lock; the camera decides\n\s*autoProfile = false;/.test(SRC));
  /* The single-view counterpart of the two resets above: every FRESH watcher instance -
     dual-view or single-view alike - clears autoProfile itself, so a stale EDGE-ON from
     whatever this watcher's predecessor last saw (a different item, a different session)
     can never leak through the `!!orientWatcher` check into a brand new one. */
  check("...and every fresh watcher instance resets it too (covers the single-view arm path)",
    /const GARMENT_BACK  = distinctBackOf\(activeItem, gInit\);[\s\S]*?autoProfile = false;/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
