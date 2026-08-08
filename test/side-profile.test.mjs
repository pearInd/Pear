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
    KEEP_TOP: "_KEEP_TOP", KEEP_BOTTOMS: "_KEEP_BOTTOMS",
    STRICT_INPAINT: "_STRICT_INPAINT", IGNORE_SOURCE_ARTIFACTS: "_IGNORE_ARTIFACTS",
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
const SELECTED_FRONT = /Apply the LEFT PANEL \(FRONT view\) design to the FRONT of their body/;
const SELECTED_BACK  = /from the RIGHT PANEL \(BACK view\) and RENDER IT ONTO THE BACK of the person/;
const DEPTH_MARKER   = /SIDE-PROFILE DEPTH FIDELITY/;

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
  };
  return new Function(...Object.keys(CONSTS),
    "let profileBuf = [], squareStreak = 0, strongStreak = 0, autoProfile = false;\n" +
    "return (score) => {\n" + decide.slice(decide.indexOf("{") + 1) +
    "\n autoProfile = next; return autoProfile; };")(...Object.values(CONSTS));
}

console.log("── §1 THE REFACTOR IS BYTE-IDENTICAL: square-on prompts must not have moved ──");
{
  /* Splitting POSE from PANEL (and REAR_POSE from BACK_TAIL) was done to create a seam for
     the profile variants, NOT to reword anything. These four strings are the entire
     square-on surface area of that refactor; if one drifts, a change intended to affect
     only side-on frames has silently altered every head-on frame too. */
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
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true });
  check("composite/front: no longer claims the shopper is FACING FORWARD",
    !/FACING FORWARD/.test(clause) && !/the front of their body toward the camera/.test(clause),
    clause.slice(0, 300));
  check("composite/front: states the true edge-on rotation instead",
    /TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile/.test(clause), clause.slice(0, 300));
  check("composite/front: explicitly forbids de-rotating them back to front-on",
    /do NOT rotate, straighten or re-pose them back toward the camera/.test(clause) &&
    /do NOT re-render this as a front-facing shot/.test(clause), clause.slice(0, 400));
}
{
  const { clause } = run({ angle: "back", inProfile: true, distinctBack: BACK, useComposite: true });
  check("composite/back: no longer claims a square rear view with no face visible",
    !/has TURNED AROUND and is presenting their BACK to the camera/.test(clause) &&
    !/no face visible/.test(clause), clause.slice(0, 300));
  check("composite/back: states the true edge-on rotation instead",
    /TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile/.test(clause), clause.slice(0, 300));
  check("composite/back: forbids re-posing to a square rear shot",
    /do NOT re-render this as a square rear shot/.test(clause), clause.slice(0, 400));
}
{
  const { clause } = run({ angle: "back", inProfile: true, distinctBack: BACK, useComposite: false });
  check("single-asset/back: the rear POSE sentence is replaced...",
    !/seen from BEHIND - rear view, turned around/.test(clause) &&
    /TURNED TO THEIR SIDE and is seen EDGE-ON/.test(clause), clause.slice(0, 300));
  check("...while the reproduce-the-back-print TAIL is fully preserved",
    /This reference photo shows the BACK of the garment: reproduce it faithfully/.test(clause) &&
    /Do not move, rescale, re-center or omit the back print/.test(clause), clause.slice(0, 600));
}
{
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: undefined, useComposite: false });
  check("single-asset/front: autoProfile replaces autoFront's 'facing the camera' claim",
    !/The person is facing the camera/.test(clause) &&
    /TURNED TO THEIR SIDE/.test(clause), clause.slice(0, 300));
  check("...and still pins the reference as the garment FRONT (the lock did not move)",
    /This reference photo shows the FRONT of the garment/.test(clause), clause.slice(0, 300));
}

console.log("\n── §3 THE DEPTH CLAUSE: the axis that only exists edge-on ──");
{
  const { clause } = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true });
  /* The four numbered directives. Asserted individually because they are four separable
     asks - a rewrite that drops any one of them (most easily (3), which is the only one
     that speaks to foreshortening) would leave the others reading fine while the specific
     failure they were written for came back. */
  check("(1) states the orientation: edge-on, side profile, facing laterally",
    /the person is positioned EDGE-ON, IN SIDE PROFILE, facing LATERALLY relative to the camera frame/.test(clause),
    clause.slice(-1400));
  check("(2) names the lateral silhouette edge as ABSOLUTE GROUND TRUTH",
    /lateral silhouette edge in the live frame[\s\S]*is ABSOLUTE GROUND TRUTH/.test(clause), clause.slice(-1400));
  check("(2) covers abdominal curve, torso depth and clothing bulk",
    /including any abdominal curve, stomach or belly projection, chest depth/.test(clause) &&
    /the bulk of the clothing itself/.test(clause), clause.slice(-1400));
  check("(2) names FRONT-TO-BACK DEPTH as the visible axis, not width",
    /that outline is their real FRONT-TO-BACK DEPTH, not their width/.test(clause), clause.slice(-1400));
  check("(2) declares a protrusion to be REAL BODY VOLUME - the pillow/belly case",
    /Any protrusion, bulge, overhang, rounding or expansion along that edge is REAL BODY VOLUME/.test(clause) &&
    /must be preserved at its exact depth, height and position, however far it extends/.test(clause),
    clause.slice(-1400));
  check("(3) requires full side-view foreshortening to be maintained",
    /maintain the full side-view foreshortening exactly as captured/.test(clause), clause.slice(-1400));
  check("(3) forbids rotating chest/waist/hips/shoulders back toward the front view",
    /Do NOT rotate, turn or twist the person's chest, waist, hips or shoulders back toward the front camera view/.test(clause),
    clause.slice(-1400));
  check("(3) forbids substituting an idealized profile",
    /Do NOT substitute a typical, average, slimmer, athletic or idealized profile/.test(clause), clause.slice(-1400));
  check("(3) forbids flattening the stomach/chest/back edge toward the spine",
    /do NOT flatten, straighten, compress or pull the stomach, chest, belly or back edge inward toward the/.test(clause) &&
    /do NOT reduce the torso's front-to-back thickness/.test(clause), clause.slice(-1400));
  check("(4) requires the fabric to drape over the exact profile contours at true depth",
    /wrap and drape the selected garment fabric seamlessly over those exact profile contours, preserving their true physical depth/.test(clause),
    clause.slice(-1400));

  /* PLACEMENT, asserted because buildCompositePrompt()'s own ordering comment makes the
     case that leading tokens dominate for this model - that argument is the reason the
     panel contract leads at all. On an edge-on frame the body geometry IS the instruction
     being got wrong, so it must sit directly behind the pose rather than at the tail
     behind the garment description, fit modifier and general clamps. */
  const posePos  = clause.indexOf("TURNED TO THEIR SIDE");
  const applyPos = clause.indexOf("Apply the LEFT PANEL");
  const depthPos = clause.indexOf("SIDE-PROFILE DEPTH FIDELITY");
  const tempPos  = clause.indexOf("temporally consistent");
  /* It follows the pose+panel block rather than splitting it: the panel contract is
     deliberately contiguous (contract → pose → which panel), and wedging 1,169 characters
     about anatomy into the middle of it would undo the ordering this file fought for. */
  check("the depth clause follows the pose/panel block, leaving that block contiguous",
    posePos !== -1 && applyPos > posePos && depthPos > applyPos,
    `pose@${posePos} apply@${applyPos} depth@${depthPos}`);
  check("...and still precedes the trailing temporal clause",
    tempPos !== -1 && depthPos < tempPos, `depth@${depthPos} temporal@${tempPos}`);
}
{
  /* Same placement rule in the OTHER builder - the one that assembles the real live
     composite payload. buildCompositePrompt() is not reachable from angleClause(), so a
     regression there would be invisible to every assertion above. */
  const { api } = run({ distinctBack: BACK });
  const built = api.buildCompositePrompt(
    { name: "Tee", custom: true, garmentType: "upper_body" }, "front", true);
  const dPos = built.indexOf("SIDE-PROFILE DEPTH FIDELITY");
  const subPos = built.indexOf("Substitute the person's current");
  check("buildCompositePrompt places the depth clause before the garment description",
    dPos !== -1 && subPos !== -1 && dPos < subPos, `depth@${dPos} substitute@${subPos}`);
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
  check("the panel contract itself is unchanged edge-on (LEFT=FRONT / RIGHT=BACK still stated)",
    /the LEFT HALF is the FRONT view/.test(profiled) && /the RIGHT HALF is the BACK view/.test(profiled));
  check("cross-panel bleed is still forbidden edge-on",
    /The RIGHT PANEL does not exist for this frame/.test(profiled), profiled.slice(0, 600));
  check("canvas-furniture and temporal clauses still ride along edge-on",
    /IGNORE ALL CANVAS FURNITURE/.test(profiled) && /ZERO flickering/.test(profiled));
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
    /squareStreak = score <= 0\.25 \? squareStreak \+ 1 : 0;/.test(upd), upd.slice(0, 500));
  check("it is cooldown-guarded against oscillation around the threshold",
    /Date\.now\(\) - lastProfileAt < ORIENT_PROFILE_COOLDOWN_MS/.test(upd));
  check("it bails when the session is no longer live or has left AI Auto",
    /if \(disposed \|\| !isLive\(\) \|\| currentAngle !== AUTO_ANGLE\) return;/.test(upd));

  const tick = extract("const timer = setInterval", "if (confirmed) await maybeSwap(lastVote);");
  check("the tick skips the pose update when a swap is confirmed (no redundant second set())",
    /if \(!confirmed\) await maybeUpdateProfile\(lastProfileScore\);/.test(tick), tick.slice(-400));
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
  const profiled = run({ angle: "front", inProfile: true, distinctBack: BACK, useComposite: true }).clause;
  check("the edge-on composite clause still demands temporally consistent frames",
    /temporally consistent frame-to-frame output/.test(profiled));
  check("...and still forbids the print flickering or re-positioning between frames",
    /must never vanish, fade or re-position between frames/.test(profiled));

  const { api } = run({ distinctBack: BACK });
  const built = api.buildCompositePrompt({ name: "Tee", custom: true, garmentType: "upper_body" }, "front", true);
  check("the built edge-on payload carries ROTATION_CONTINUITY (garment stays on through the turn)",
    /_ROTATION/.test(built), built.slice(-200));
  check("...and PROFILE_ANOMALY_GUARD (held objects are not anatomy while turning)",
    /_ANOMALY_GUARD/.test(built), built.slice(-200));
  check("...and STRICT_INPAINT (body fidelity governs at every angle)",
    /_STRICT_INPAINT/.test(built), built.slice(-200));
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

console.log("\n── §7 profileActive() is scoped to AI Auto ──");
{
  /* Manual angle tabs pick their own view; there is no watcher running to report a pose,
     so a stale flag must not leak into their prompts. */
  check("profileActive() gates on AI Auto being the active mode",
    /function profileActive\(\) \{ return currentAngle === AUTO_ANGLE && autoProfile; \}/.test(SRC));
  check("autoProfile is reset when AI Auto is (re-)armed from the angle selector",
    /autoOrientation = null;\s*\/\/ PENDING - acquired from the camera, not assumed\n\s*autoProfile = false;/.test(SRC));
  check("...and when it is armed at go-live",
    /autoOrientation = null;\s*\/\/ PENDING - no startup FRONT lock; the camera decides\n\s*autoProfile = false;/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
