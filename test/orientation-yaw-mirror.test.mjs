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
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const num = (name) => {
  const m = new RegExp(`^const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m").exec(APP);
  if (!m) throw new Error(`const ${name} not found in app.js`);
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
     at +/-90 and the swing is measured from a baseline that is rarely zero. */
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
    /const flipBar = yawCorroborates\s*\n?\s*\? Math\.min\(ORIENT_LOCK_FRAMES, ORIENT_CORROBORATED_FRAMES\)\s*\n?\s*: ORIENT_LOCK_FRAMES;/.test(APP),
    "the uncorroborated path must be the original bar, byte for byte");
  /* Math.min, not a bare swap: if ORIENT_CORROBORATED_FRAMES were ever set ABOVE
     ORIENT_LOCK_FRAMES, corroboration must not RAISE the bar and make a real, measured
     turn slower to confirm than an unmeasured one. */
  check("...and corroboration can only ever lower the bar, never raise it",
    /Math\.min\(ORIENT_LOCK_FRAMES, ORIENT_CORROBORATED_FRAMES\)/.test(APP),
    "a bare swap would let a misconfigured constant make corroborated turns SLOWER");
  check("the time-based path (ORIENT_LOCK_MS) is unchanged and still ORs in",
    /streak >= flipBar \|\| held >= ORIENT_LOCK_MS/.test(APP));
  /* Acquiring has no locked side to protect and already settles on two samples; pulling
     corroboration into it would be pure risk for no latency win. */
  check("acquiring is untouched - it never consults yaw",
    /acquiring\s*\n?\s*\? streak >= ORIENT_ACQUIRE_FRAMES/.test(APP));
}

console.log("\n── §3 YAW ATTESTS A TURN; IT NEVER PICKS A SIDE ──");
{
  /* bodyYawDegrees() is asin(out-of-plane / length), capped at +/-90, so facing the
     camera and facing away are indistinguishable to it. Code deriving front/back from yaw
     would be reading a signal that cannot carry that information - and would bypass the
     vote, which is the only thing that can. */
  const idx = APP.indexOf("const yawCorroborates");
  const region = APP.slice(Math.max(0, idx - 1400), idx + 200);
  check("corroboration is computed from a MAGNITUDE swing only",
    /Math\.abs\(_torsoYawAbs - yawAtStreakStart\)/.test(region), region.slice(-400));
  check("no branch derives front/back from yaw",
    !/_torsoYawAbs[^\n]*\?[^\n]*("front"|"back")/.test(APP) &&
    !/yaw[A-Za-z]*\s*[<>]=?[^\n]*\?\s*"(front|back)"/.test(APP),
    "yaw cannot express facing direction - the asin form caps at +/-90");
  /* Every missing piece must abstain to the original bar rather than accelerate on
     incomplete evidence: no detector, an occluded torso, or a streak that began before
     any reading existed. */
  check("a missing or stale reading abstains rather than corroborating",
    /_torsoYawAbs !== null && Date\.now\(\) - _torsoYawAt <= ORIENT_YAW_FRESH_MS/.test(APP) &&
    /yawFresh && yawAtStreakStart !== null/.test(APP),
    "an absent baseline must not read as a zero swing that later clears the threshold");
  /* The baseline is captured when the streak RESETS. Re-reading it every tick would let
     it creep along with the shopper, so a slow turn would never accumulate a swing. */
  check("the baseline is snapshotted at streak start, not re-read every tick",
    /yawAtStreakStart = \(_torsoYawAt && Date\.now\(\) - _torsoYawAt <= ORIENT_YAW_FRESH_MS\)/.test(APP),
    "a creeping baseline never accumulates a swing on a slow turn");
  /* Per-watcher, like the streak it belongs to - an item swap must not inherit a pose. */
  check("the baseline is per-watcher state, not module scope",
    /let yawAtStreakStart = null;/.test(APP) &&
    APP.indexOf("let yawAtStreakStart") > APP.indexOf("function createOrientationWatcher"),
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
  check("the live display carries the selfie flip instead",
    /\.camera-card\.show-live #aiVideo \{ display: block; transform: scaleX\(-1\); \}/.test(CSS));
  /* A recorded clip already has the flip baked into its pixels, so replay must NOT flip
     again. These two rules differing is the correct state, not an oversight. */
  check("clip replay stays un-flipped - the clip pixels already carry it",
    /\.camera-card\.show-clip #aiVideo \{ display: block; transform: none; \}/.test(CSS),
    "mirroring a baked clip on replay plays it back reversed against the live view");
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
  check("the recorder bakes the selfie flip into the clip",
    /ctx\.setTransform\(-1, 0, 0, 1, w, 0\);\s*\n\s*ctx\.drawImage\(video, 0, 0, w, h\);/.test(APP),
    "without this the downloaded clip plays back reversed against the live view");
  check("...and the frozen-hold branch does NOT double-flip it",
    /NO FLIP HERE[\s\S]{0,600}?ctx\.drawImage\(recordHoldSrc,/.test(APP),
    "recordHoldSrc comes from captureHoldFrame, which already baked the flip in");
  /* All three still-capture helpers: #aiVideo is no longer exempt from the flip. */
  const aiExempt = (APP.match(/src = ai; w = ai\.videoWidth; h = ai\.videoHeight;(?! mirror = true)/g) || []).length;
  check("no capture helper still treats #aiVideo as pre-oriented",
    aiExempt === 0,
    `${aiExempt} helper(s) still skip the flip for #aiVideo - their output would be reversed`);
  check("...and all three set mirror on the #aiVideo branch",
    (APP.match(/src = ai; w = ai\.videoWidth; h = ai\.videoHeight; mirror = true;/g) || []).length === 3,
    "captureHoldFrame, freezeFinalFrame and captureLiveFrame must all flip now");
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
