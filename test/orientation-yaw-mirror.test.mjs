/* ── YAW CORROBORATION + THE UN-MIRRORING REFACTOR ──────────────────────────────────
   Two changes that share one property: both replace a hidden compensation with an
   explicit one, and both break SILENTLY if a single surface drifts out of step.

   §1-§3 pin the yaw corroboration. THREE REPORTS, ONE CAUSE: "the real shirt bleeds
   through when I turn", "the back graphic pops in late" and "the feed freezes during a
   turn" are all the same ORIENT_LOCK_FRAMES x ORIENT_SAMPLE_MS = 2.5s of confirmation
   latency. Confirming faster is the only lever that shrinks all three at once, and
   lowering ORIENT_LOCK_FRAMES was rejected in-file because it swaps the reference on a
   head-turn. So the bar is met with MORE evidence instead: the vote streak AND an
   independent 3D torso rotation, measured by a different instrument (MediaPipe torso
   landmarks vs a 96px skin-ratio canvas). What must never rot is that yaw only ever
   ACCELERATES a decision the vote already made - it must never pick a side, and it must
   never lower the bar on its own.

   §4 pins the un-mirroring lockstep. The selfie flip moved off the outgoing WebRTC canvas
   - so Decart is conditioned on reality and stops rendering chest text reversed - onto
   the display layer. Every surface consuming #aiVideo had to move with it. A surface left
   behind produces a silently reversed recording, or a cover that flips on screen the
   instant it appears. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
/* The orientation DECISION moved to lib/orient-engine.js on 2026-09-26 (CLAUDE.md §2.14): the
   window, the corroboration and their constants are read from there - dedented, so the
   "^const X =" reader below matches either file. The pose loop and the mirror policy stay in app.js. */
const ENGINE = readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  .split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");
const BOTH = APP + "\n" + ENGINE;
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const num = (name) => {
  const m = new RegExp(`^const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m").exec(BOTH);
  if (!m) throw new Error(`const ${name} not found in app.js or lib/orient-engine.js`);
  return Number(m[1]);
};

console.log("── §1 THE CONSTANTS ARE REAL BOUNDS, NOT DECORATION ──");
{
  const corroborated = num("ORIENT_CORROBORATED_FRAMES");
  const lock         = num("ORIENT_LOCK_FRAMES");
  const turnDeg      = num("ORIENT_YAW_TURN_DEG");
  const freshMs      = num("ORIENT_YAW_FRESH_MS");
  const sampleMs     = num("ORIENT_SAMPLE_MS");

  check("the corroborated bar is genuinely faster than the uncorroborated one",
    corroborated < lock, `corroborated=${corroborated} lock=${lock}`);
  /* A bar of 1 would be a hair trigger: one stray vote plus any torso movement would
     flip the reference. Corroboration buys speed, not recklessness. */
  check("...but still requires several agreeing votes, not a hair trigger",
    corroborated >= 3, `${corroborated} frames = ${corroborated * sampleMs}ms of agreement`);
  /* 45 degrees is a half-turn of the shoulder line. Below ~25 a shrug or a lean could
     clear it; above 90 is unreachable, since bodyYawDegrees() is an asin() form capped
     at +/-90 and the swing is measured down from an edge-on peak that is rarely a full 90. */
  check("the yaw threshold is above shrug/lean noise and inside the asin range",
    turnDeg >= 25 && turnDeg <= 90, `ORIENT_YAW_TURN_DEG=${turnDeg}`);
  /* Stale yaw describes a body position the shopper has already left. Freshness must
     cover a couple of topology samples but nothing like a whole turn. */
  check("freshness is short enough that stale yaw cannot accelerate anything",
    freshMs > 0 && freshMs <= 1500, `ORIENT_YAW_FRESH_MS=${freshMs}`);
}

console.log("\n── §2 ORIENT_LOCK_FRAMES IS UNTOUCHED, AND IS STILL THE FALLBACK ──");
{
  /* THE LOAD-BEARING PROPERTY OF THIS SUITE. Corroboration is an ADDITIONAL path. If it
     ever becomes a replacement - if the uncorroborated case stops using
     ORIENT_LOCK_FRAMES - the anti-flap defence is gone and a head-turn under a flickering
     light can swap the reference again, which is the regression that threshold exists to
     prevent and the reason lowering it was refused in the first place. */
  check("the flip bar falls back to ORIENT_LOCK_FRAMES without corroboration",
    /const flipBar = yawCorroborates\s*\n?\s*\? Math\.min\(ORIENT_LOCK_FRAMES, ORIENT_CORROBORATED_FRAMES\)\s*\n?\s*: ORIENT_LOCK_FRAMES;/.test(BOTH),
    "the uncorroborated path must be the original bar, byte for byte");
  /* Math.min, not a bare swap: if ORIENT_CORROBORATED_FRAMES were ever set ABOVE
     ORIENT_LOCK_FRAMES, corroboration must not RAISE the bar and make a real, measured
     turn slower to confirm than an unmeasured one. */
  check("...and corroboration can only ever lower the bar, never raise it",
    /Math\.min\(ORIENT_LOCK_FRAMES, ORIENT_CORROBORATED_FRAMES\)/.test(BOTH),
    "a bare swap would let a misconfigured constant make corroborated turns SLOWER");
  /* 2026-09-22 (ORIENT_POST_PEAK): both bars now read the streak and the held time CAPPED at the
     evidence cast after the turn's peak. A cap is Math.min over an input that defaults to Infinity,
     so it can only ever RAISE the bar, never lower it - which is the property this section exists
     to protect, now pinned directly rather than through the old variable names. */
  check("the time-based path (ORIENT_LOCK_MS) is unchanged and still ORs in",
    /votes >= flipBar \|\| dwell >= ORIENT_LOCK_MS/.test(BOTH) &&
    /const votes = Math\.min\(streak, postPeakVotes\);/.test(BOTH) &&
    /const dwell = Math\.min\(held, postPeakHeld\);/.test(BOTH) &&
    /postPeakVotes = Infinity, postPeakHeld = Infinity \}\)/.test(BOTH),
    "the post-peak caps must be Math.min over Infinity defaults - a cap that could add evidence would lower the anti-flap bar");
  /* Acquiring has no locked side to protect and already settles on two samples; pulling
     corroboration into it would be pure risk for no latency win. */
  check("acquiring is untouched - it never consults yaw",
    /acquiring\s*\n?\s*\? streak >= ORIENT_ACQUIRE_FRAMES/.test(BOTH));
}

console.log("\n── §3 YAW ATTESTS A TURN; IT NEVER PICKS A SIDE ──");
{
  /* bodyYawDegrees() is asin(out-of-plane / length), capped at +/-90, so facing the
     camera and facing away are indistinguishable to it. Code deriving front/back from yaw
     would be reading a signal that cannot carry that information - and would bypass the
     vote, which is the only thing that can. */
  const idx = ENGINE.indexOf("const yawCorroborates");
  const region = ENGINE.slice(Math.max(0, idx - 2400), idx + 200);
  const w0 = ENGINE.indexOf("function makeTurnYawWindow(");
  const windowSrc = ENGINE.slice(w0, ENGINE.indexOf("/* Edge-on detection thresholds.", w0));
  /* The swing is measured DOWN from the turn's edge-on peak rather than from where the vote
     streak began - a streak-start baseline is always taken after that peak, so the return
     leg of a 360 could never corroborate (turn-yaw-window.test.mjs). The reference is that
     peak, or 90 - the asin ceiling - once the torso was lost mid-turn past the angle the file
     already reads as turning. Either way it is a difference of published MAGNITUDES, taken
     against a real fresh reading. */
  check("corroboration is computed from a MAGNITUDE swing only",
    /yawWindow\.observe\(vote, s\.lock, yawFresh \? s\.yawAbs : null,/.test(region) &&
    /const reference = edgeLost \? 90 : peak;/.test(windowSrc) &&
    /const swing = usable \? Math\.max\(0, reference - yawAbs\) : 0;/.test(windowSrc), region.slice(-400));
  check("no branch derives front/back from yaw",
    !/(?:_torsoYawAbs|s\.yawAbs)[^\n]*\?[^\n]*("front"|"back")/.test(BOTH) &&
    !/yaw[A-Za-z]*\s*[<>]=?[^\n]*\?\s*"(front|back)"/.test(BOTH),
    "yaw cannot express facing direction - the asin form caps at +/-90");
  /* Every missing piece must abstain to the original bar rather than accelerate on
     incomplete evidence: no detector, an occluded torso, or a streak that began before
     any reading existed. */
  check("a missing or stale reading abstains rather than corroborating",
    /s\.yawAbs !== null && s\.t - s\.yawAt <= ORIENT_YAW_FRESH_MS/.test(ENGINE) &&
    /const usable = fresh && reference !== null;/.test(windowSrc) &&
    /const yawUsable = turnYaw\.usable;/.test(ENGINE),
    "an absent peak must not read as a zero swing that later clears the threshold");
  /* The reference point must not creep along with the shopper, or a slow turn never
     accumulates a swing. A running MAX cannot follow the body back down, and it restarts
     only on a vote that AGREES with the lock - i.e. when no turn is in progress. */
  check("the swing's reference is the turn's peak, restarted only by an agreeing vote",
    /if \(vote && vote === lock\) \{\s*\n\s*peak = fresh \? yawAbs : null;\s*\n\s*edgeLost = false;/.test(windowSrc) &&
    /if \(fresh\) \{\s*\n\s*peak = peak === null \? yawAbs : Math\.max\(peak, yawAbs\);/.test(windowSrc),
    "a creeping reference never accumulates a swing on a slow turn");
  /* The edge-on inference may only ever come from a LOSS, mid-turn, past the loss angle - never
     from a reading, never while the vote agrees. Otherwise it is a second way to invent a turn. */
  check("edge-on is inferred only from a torso lost mid-turn past the loss angle",
    /\} else if \(lastFresh !== null && lastFresh >= edgeLossDeg\) \{\s*\n\s*edgeLost = true;/.test(windowSrc) &&
    /edgeLossDeg = PRESENCE_PROMPT_YAW_SUPPRESS_DEG/.test(windowSrc));
  /* Per-watcher, like the streak it belongs to - an item swap must not inherit a pose. */
  check("the window is per-watcher state, not module scope",
    /const yawWindow = makeTurnYawWindow\(\);/.test(ENGINE) &&
    ENGINE.indexOf("const yawWindow = makeTurnYawWindow();") > ENGINE.indexOf("export function createOrientEngine") &&
    !/^let peak\b/m.test(APP) && !/^let peak\b/m.test(readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8")),
    "module scope would carry a stale pose across item swaps");
  /* One MediaPipe inference per tick is the entire point of the shared sampler. */
  check("yaw is published from the EXISTING pose signature, not a second inference",
    /_torsoYawAbs = Math\.abs\(sig\.yaw\);/.test(APP),
    "a second inference per tick is real battery and thermal cost on a phone");
}

console.log("\n── §4 THE UN-MIRRORING LOCKSTEP ──");
{
  /* THE SOURCE OF TRUTH. If this flip returns, Decart is conditioned on a mirrored world
     again and renders chest text reversed - and every compensation below becomes a double
     flip, so the failure is worse than the one before the refactor. */
  const draw = APP.slice(APP.indexOf("const drawFrame = () =>"), APP.indexOf("const tick = () =>"));
  check("the outgoing WebRTC canvas is NOT mirrored",
    !/setTransform\(-1/.test(draw) && /ctx\.drawImage\(video, dx, dy, dw, dh\);/.test(draw), draw);
  /* translateZ(0) is composed into the SAME declaration now. It used to be assigned
     inline from onRemoteStream as `aiVideo.style.transform = "translateZ(0)"` - and being
     inline it outranked this rule, so the flip never applied and the live feed rendered
     with no mirror at all. That is the bug this composition fixes: one declaration, no
     race, and `transform` on #aiVideo written nowhere else in JS. */
  check("the live display carries the selfie flip instead",
    /\.camera-card\.show-live #aiVideo \{ display: block; transform: scaleX\(-1\) translateZ\(0\); \}/.test(CSS));
  /* CODE ONLY. The removed assignments are QUOTED VERBATIM in onRemoteStream's comment,
     because CLAUDE.md §6 keeps the record of what failed rather than deleting it - so an
     absence check over raw source fails against its own documentation. This is the third
     assertion in this repo to learn that (see the save/restore balance count here and the
     resetAiFeedVisibility call-site count in first-frame-integrity): when a check asserts
     an ABSENCE, it has to strip comments first, or the fix and its explanation cannot
     coexist. */
  const APP_CODE = APP.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");
  check("...and NOTHING assigns #aiVideo an inline transform, which would outrank it",
    !/aiVideo\.style\.transform\s*=/.test(APP_CODE),
    "an inline transform silently owns the element and the stylesheet's mirror is ignored");
  check("...while resetAiFeedVisibility still clears any stray inline transform",
    /function resetAiFeedVisibility\(\)[\s\S]{0,900}?ai\.style\.transform = "";/.test(APP),
    "a leftover inline transform carries one surface's mirror convention into another");
  /* A recorded clip already has the flip baked into its pixels, so replay must NOT flip
     again. These two rules differing is the correct state, not an oversight. */
  /* !important, and the only rule in this file that has it. show-live and show-clip
     disagree about the mirror deliberately, and they have EQUAL specificity - so if both
     classes were ever set at once the replay's orientation would be decided by stylesheet
     SOURCE ORDER, which no reader would think to check and no future reorder would
     preserve. Belt and braces from both sides: playClipInMainPlayer() now removes
     show-live explicitly, and this refuses to lose even if it did not. */
  check("clip replay stays un-flipped - the clip pixels already carry it",
    /\.camera-card\.show-clip #aiVideo \{ display: block; transform: none !important; \}/.test(CSS),
    "mirroring a baked clip on replay plays it back reversed against the live view");
  check("...and entering replay drops show-live rather than relying on rule order",
    /card\(\)\.classList\.remove\("show-live"\);\s*\n\s*card\(\)\.classList\.add\("show-clip"\);/.test(APP),
    "two equal-specificity rules disagreeing about the mirror must not both be live");
  /* The self-check is the only instrument that can settle an orientation report, because
     nothing in this directory can open a camera. It must stay purely diagnostic - a
     self-correcting version would mask the drift it exists to surface. */
  check("every surface transition logs its computed orientation",
    (APP.match(/logSurfaceOrientation\("/g) || []).length >= 3 &&
    /function logSurfaceOrientation\(where\)/.test(APP),
    "go-live, post-countdown and clip-replay each need a reading to compare");

  /* ── #resultCanvas: THE POST-COUNTDOWN SURFACE, CHECKED BY CASCADE ORDER ─────────
     This is what the shopper actually sees from the moment the 5s window closes -
     stopBilling() removes show-live and adds show-result, so the frozen #resultCanvas
     replaces the live feed. It is therefore the surface a "the text went mirrored right
     after the countdown" report is most likely describing, and its orientation is decided
     by a CSS cascade rather than by anything greppable in app.js.

     freezeFinalFrame() bakes the flip (mirror is true on both branches), so the CSS must
     contribute NONE - one flip total, matching the live view's decoded+scaleX(-1).

     Two rules set `transform` on #resultCanvas at EQUAL specificity (0,1,1): the base
     group and the display:none rule after it. Equal specificity means SOURCE ORDER
     decides, so the invariant is positional and a future tidy-up that reorders them
     would silently double-mirror every saved result. Asserted as "the last transform
     wins and it is none", which is exactly the property the cascade evaluates. */
  const rcRules = [...CSS.matchAll(/^[^\n{]*#resultCanvas[^\n{]*\{[^}]*\}/gm)]
    .map((m) => ({ text: m[0], at: m.index }))
    .filter((r) => /transform\s*:/.test(r.text));
  const lastTransformRule = rcRules[rcRules.length - 1];
  check("#resultCanvas's LAST transform rule is none, so the baked flip is not doubled",
    !!lastTransformRule && /transform:\s*none/.test(lastTransformRule.text),
    `last transform rule for #resultCanvas: ${lastTransformRule && lastTransformRule.text}`);
  /* A rule with HIGHER specificity could win regardless of order. show-result adds a
     second class (0,2,1) and must therefore never set a transform - it governs display
     only. If it ever gains one, the positional reasoning above stops applying. */
  const showResultRule = /\.camera-card\.show-result #resultCanvas \{[^}]*\}/.exec(CSS);
  check("...and the higher-specificity show-result rule sets display only, never transform",
    !!showResultRule && !/transform/.test(showResultRule[0]),
    showResultRule && showResultRule[0]);
  /* ── THE POLICY INVERTED HERE, DELIBERATELY - see MIRROR_POLICY in app.js ──────────
     These four checks used to assert that every capture BAKED a flip, back when the aim
     was for captures to match the live selfie view. They now assert the opposite, and the
     reason is a product decision rather than a correction:

       live      MIRRORED     - motion matches the shopper's body while they move
       captures  NOT MIRRORED - the garment's text reads correctly in what they keep

     Those cannot both hold on one surface (garment and body are the same pixels), so the
     convention is split per surface and the visible flip at the countdown transition is
     the accepted cost. Asserted as an ABSENCE of any bake, because every video source in
     this file is reality-oriented - so "un-mirrored capture" means baking identity. */
  check("freezeFinalFrame bakes NO flip on either branch - captures keep readable text",
    /function freezeFinalFrame\(\)[\s\S]{0,1600}?src = ai;(?![^\n]*mirror = true)[\s\S]{0,400}?src = webcam;(?![^\n]*mirror = true)/.test(APP),
    "a baked flip here ships a reversed keepsake with backwards garment text");
  /* Overlays are drawn FROM #aiVideo and stacked OVER it, so they must share its
     transform or the held frame flips the instant a cover appears - a far more visible
     artifact than the one the cover exists to hide. */
  /* [\s\S]{0,200}? rather than [^"]*: these style strings are assembled by concatenation,
     so there are quote characters and newlines BETWEEN the selector and the transform. A
     quote-excluding class silently never matches and the check passes vacuously - which is
     worse than no check, because it reports the lockstep as verified. */
  check("both #aiVideo overlays share its transform",
    /#orientFadeCanvas\{[\s\S]{0,200}?transform:scaleX\(-1\)/.test(APP) &&
    /#redrapeCoverCanvas\{[\s\S]{0,200}?transform:scaleX\(-1\)/.test(APP),
    "an overlay left on transform:none flips against the video underneath it");
  /* drawImage reads DECODED frames and ignores CSS, so anything baking pixels has to
     apply the flip itself or it ships reversed. */
  check("the recorder bakes NO flip - the saved clip keeps readable garment text",
    /ctx\.setTransform\(1, 0, 0, 1, 0, 0\);\s*\n\s*ctx\.drawImage\(video, 0, 0, w, h\);/.test(APP),
    "a baked flip makes the downloaded file show the garment's text backwards");
  check("...and the frozen-hold branch matches it, so the clip's tail cannot disagree",
    /NO FLIP HERE[\s\S]{0,600}?ctx\.drawImage\(recordHoldSrc,/.test(APP),
    "recordHoldSrc comes from captureHoldFrame, which uses the same capture convention");
  /* NOT ONE capture helper may bake a flip. Asserted as a count of zero rather than per
     helper, so a fourth capture surface added later is caught by the same line. */
  const flipped = (APP_CODE.match(/mirror = true/g) || []).length;
  check("no capture helper bakes a flip - all three follow the capture convention",
    flipped === 0,
    `${flipped} helper(s) still flip; captures must stay un-mirrored (MIRROR_POLICY)`);
  /* The policy is a decision with a cost, so it has to be written down where the next
     person meets it - not inferred from four silent identity matrices. */
  check("...and the split-convention decision is documented, not just implemented",
    /MIRROR_POLICY/.test(APP) &&
    /readable garment text {2}<=> {2}zero net flips/.test(APP),
    "a per-surface mirror convention is indistinguishable from a bug without the rationale");
}

console.log("\n── §5 MATRIX DISCIPLINE: every flip is absolute, every pair is balanced ──");
{
  /* THE FAILURE THIS FORECLOSES: an "endless mirror" - the feed flipping back and forth
     on every tick. It happens when a RELATIVE flip (translate + scale(-1,1), which
     multiplies into the current matrix) runs in a per-frame loop on a persistent canvas
     and the save/restore pair around it is ever skipped. Each frame then inverts the
     last and the sign oscillates.
     Every flip in app.js is now written as an ABSOLUTE setTransform, which REPLACES the
     matrix, so a frame cannot inherit anything from its predecessor even if a restore
     were missed. That makes the oscillation unrepresentable rather than merely absent. */
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");

  check("no relative horizontal flip survives anywhere in app.js",
    !/\.scale\(\s*-1/.test(code),
    "translate+scale multiplies into the existing matrix - absolute setTransform does not");

  /* Balanced pairs, counted on CODE ONLY. An earlier version of this check counted the
     raw file and reported an imbalance that turned out to be the word "restore()" inside
     a comment - a false positive that would have sent the next reader hunting a bug that
     was not there. */
  const saves = (code.match(/\.save\(\)/g) || []).length;
  const restores = (code.match(/\.restore\(\)/g) || []).length;
  check(`save/restore pairs balance across the file (${saves}/${restores})`,
    saves === restores && saves > 0, `${saves} save() vs ${restores} restore()`);

  /* The two per-frame loops that write to a canvas. Both must pair structurally - in a
     finally - rather than on the happy path, or an exception mid-draw leaks a pushed
     state into every subsequent frame. */
  const guard = code.slice(code.indexOf("function startLowerBodyGuard"),
                           code.indexOf("function stopLowerBodyGuard"));
  check("the lower-body guard loop restores in a finally",
    /finally \{ ctx\.restore\(\); \}/.test(guard), guard.slice(-500));
  const rec = code.slice(code.indexOf("function startRecording"), code.indexOf("function stopRecording"));
  check("the recorder loop restores in a finally",
    /finally \{ ctx\.restore\(\); \}/.test(rec), rec.slice(-600));
  /* beginRecorder() is not a drawing call and must sit OUTSIDE the transform scope -
     having it inside was what made the original catch fire after the paired restore had
     already run, popping a state that was never pushed. */
  check("...and the recorder's non-drawing call sits outside the transform scope",
    /\} finally \{ ctx\.restore\(\); \}\s*\n\s*beginRecorder\(\);/.test(rec),
    "an unbalanced restore inside a per-frame loop is how a matrix bug starts");

  /* The outgoing WebRTC canvas is the one surface whose pixels Decart conditions on, so
     a stray matrix there is silent and total - it would flip every frame the model ever
     sees. It resets to identity explicitly even though it applies no transform itself. */
  const draw = code.slice(code.indexOf("const drawFrame = () =>"), code.indexOf("const tick = () =>"));
  check("the outgoing canvas asserts identity every frame",
    /ctx\.setTransform\(1, 0, 0, 1, 0, 0\);/.test(draw), draw);

  /* ── EXACTLY ONE LAYER MIRRORS, AND THE SDK IS NOT IT ───────────────────────────
     mirror:"auto" was previously relied upon to no-op because a canvas track carries no
     facingMode - a statement about SDK internals this repo neither controls nor version
     pins, re-decided per browser. It was survivable while the outgoing canvas pre-flipped
     (two flips cancel: wrong, but STABLE). Now that the canvas ships reality, an "auto"
     that fires flips the stream while CSS flips the display, and any SDK-side
     re-evaluation mid-session reads as the feed toggling horizontally.
     false is not a guess about SDK behaviour - it refuses the SDK an opinion. */
  check("the SDK is told mirror:false explicitly, never auto and never omitted",
    /mirror: false,/.test(code) && !/mirror: ?"auto"/.test(code),
    "an SDK-side mirror decision competing with the CSS flip is the endless-mirror failure");
  /* One options builder feeds the only connect() call, and SDK-internal reconnects reuse
     the object the SDK already holds - so this single value governs the whole session
     lifecycle. A second literal options object would break that guarantee silently. */
  check("...from the ONE factored options builder every connect path shares",
    (code.match(/mirror: false/g) || []).length === 1 &&
    /function buildRealtimeConnectOpts\(gen\)/.test(code) &&
    /client\.realtime\.connect\(realtimeInput, buildRealtimeConnectOpts\(gen\)\)/.test(code),
    "a second inline options object would let one connect path disagree about the mirror");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
