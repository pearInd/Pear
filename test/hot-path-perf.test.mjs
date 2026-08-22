/* HOT-PATH COST - the invariants a well-meant "optimization" would quietly undo.

   This suite exists because the three easiest ways to make this app stutter all look
   like improvements in a diff:

     1. ALLOCATING A SURFACE PER FRAME. sampleVideoLuma() is called per decoded frame by
        armFirstFrameBilling()'s frameReady(), off requestVideoFrameCallback, for the whole
        reveal gate. It used to build a fresh <canvas> and a fresh 2D context every call -
        a DOM element and a GPU context churned at frame rate, on the one moment the
        shopper is watching most closely. The surface is a fixed 64x36 probe, so there was
        never anything per-call about it.

     2. APPLYING willReadFrequently EVERYWHERE. The flag requests a CPU-backed surface:
        it makes getImageData cheap and drawImage DEARER. That is correct for a canvas
        whose job is to be read back, and actively harmful on one that only draws. The
        two live paint paths in this file - createThrottledInputStream()'s 10fps billing
        loop and the recorder's rAF loop - only draw, and must never carry it. A blanket
        "add willReadFrequently to every context" pass is a pessimization wearing the
        costume of a fix, and it is the single likeliest edit to arrive here.

     3. RAISING RESAMPLING QUALITY ON A PER-FRAME CANVAS. imageSmoothingQuality "high"
        genuinely improves the stitched reference - it is built once per garment pair,
        memoized, and it is the image Decart reproduces onto the shopper. On a canvas that
        redraws every frame it is a per-frame cost for no visible gain.

   Each asserts a PROPERTY, not a line, so the check survives reformatting but fails on a
   real behaviour change.                                                                */

import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

console.log("\n── §1 THE LUMA PROBE: one surface, not one per frame ──");
{
  const fn = slice("function sampleVideoLuma(v) {", "/* Black-screen / camera-off verdict");
  check("sampleVideoLuma() allocates no canvas of its own",
    !/document\.createElement\("canvas"\)/.test(fn) && !/new OffscreenCanvas/.test(fn),
    "a per-call surface here is a DOM element churned at frame rate");
  check("...it draws on a memoized probe instead",
    /const probe = lumaProbeContext\(cw, ch\);/.test(fn));
  check("the probe is cached across calls",
    /let _lumaProbe = null;/.test(SRC) &&
    /if \(_lumaProbe\) return _lumaProbe;/.test(SRC));
  check("...and prefers OffscreenCanvas, with a DOM fallback that still works",
    /typeof OffscreenCanvas !== "undefined"\s*\n?\s*\? new OffscreenCanvas\(cw, ch\)/.test(SRC) &&
    /Object\.assign\(document\.createElement\("canvas"\), \{ width: cw, height: ch \}\)/.test(SRC));
  /* FAIL OPEN is the pre-existing contract and the refactor must not have dropped it: a
     probe error must never block a paying shopper. A null context is a new way to fail
     that the old per-call form did not have. */
  check("a context that cannot be created still fails OPEN, never throws",
    /if \(!probe\) return \{ ready: false, avgLuma: 0, blackFrac: 1 \};/.test(fn),
    "a probe failure must read as 'cannot judge', never as 'black'");
  check("...and the surrounding try/catch fail-open is intact",
    /catch \(_\) \{\s*\n\s*return \{ ready: false, avgLuma: 0, blackFrac: 1 \};/.test(fn));
}

console.log("\n── §2 willReadFrequently IS ASYMMETRIC, and must stay that way ──");
{
  /* THE READERS keep it - their whole job is getImageData. */
  const readers = [
    ["the luma probe", slice("let _lumaProbe = null;", "function sampleVideoLuma(v) {")],
    ["the orientation analysis canvas",
      slice("const canvas = document.createElement(\"canvas\");\n  canvas.width = ORIENT_SIZE;", "/* SKIN-RATIO + FACE VISIBILITY")],
  ];
  for (const [name, body] of readers) {
    check(`${name} keeps willReadFrequently`, /willReadFrequently: true/.test(body), body.slice(0, 200));
  }

  /* THE DRAWERS must not gain it. Both are live loops; a CPU-backed surface would make
     every drawImage slower for a getImageData that never happens. */
  const billing = slice("function createThrottledInputStream(srcStream, {", "const drawFrame = () => {");
  check("the 10fps billing canvas does NOT set willReadFrequently",
    /const ctx = canvas\.getContext\("2d", \{ alpha: false \}\);/.test(billing) &&
    !/willReadFrequently/.test(billing),
    "this canvas only ever draws - a CPU-backed surface would slow every billed frame");
  const recorder = slice("recordCanvas = document.createElement(\"canvas\");", "const paint = () => {");
  check("the recorder canvas does NOT set willReadFrequently either",
    /getContext\("2d", \{ alpha: false \}\)/.test(recorder) && !/willReadFrequently/.test(recorder));

  /* Neither live loop may read pixels back at all - that is the property the flag would
     otherwise be excused by. */
  const paint = slice("const paint = () => {", "/** Halt the canvas paint loop");
  const draw  = slice("const drawFrame = () => {", "const tick = () => {");
  check("neither live paint loop calls getImageData",
    !/getImageData/.test(paint) && !/getImageData/.test(draw),
    "a GPU->CPU sync inside a per-frame loop is the classic stall");
  check("...and neither allocates per frame",
    !/document\.createElement/.test(paint) && !/document\.createElement/.test(draw) &&
    !/new OffscreenCanvas/.test(paint) && !/new OffscreenCanvas/.test(draw));
}

console.log("\n── §3 RESAMPLING QUALITY: on the built-once reference, not the live loops ──");
{
  check("the stitched reference asks for high-quality resampling",
    (SRC.match(/ctx\.imageSmoothingQuality = "high";/g) || []).length >= 2,
    "the reference IS what Decart reproduces - detail lost here is lost every frame");
  const paint = slice("const paint = () => {", "/** Halt the canvas paint loop");
  const draw  = slice("const drawFrame = () => {", "const tick = () => {");
  check("...and the live paint loops do NOT",
    !/imageSmoothing/.test(paint) && !/imageSmoothing/.test(draw),
    "per-frame filter taps are a cost against exactly the lag this is meant to remove");
}

console.log("\n── §4 THE POSE LOOP: bounded, interruptible, and off the render path ──");
{
  const watcher = slice("function startPresenceWatcher", "function stopPresenceWatcher");
  /* NOT requestAnimationFrame. A pose sampler on rAF competes with the compositor for
     every frame; on a fixed interval it cannot, and the WASM inference it runs is far too
     coarse to belong on a paint cadence anyway. */
  check("the pose sampler runs on a fixed interval, never requestAnimationFrame",
    /setInterval\(async \(\) => \{/.test(watcher) && !/requestAnimationFrame/.test(watcher),
    "rAF would tie a multi-millisecond WASM pass to the compositor's cadence");
  check(`...at ${CONFIG.POSE_SAMPLE_MS * 2}ms per tick, from POSE_SAMPLE_MS`,
    /const tickMs = POSE_SAMPLE_MS \* 2;/.test(watcher));
  /* RE-ENTRANCY. A tick that overruns its interval must not stack a second inference on
     top of the first - that is how a slow phone turns a 4/s sampler into a queue. */
  check("an overrunning tick cannot stack a second inference",
    /if \(inFlight \|\| !isLive\(\)\) return;/.test(watcher) && /inFlight = true;/.test(watcher) &&
    /finally \{\s*\n\s*inFlight = false;/.test(watcher));
  /* NO INFERENCE THE SHOPPER CANNOT SEE. A backgrounded tab must not compete with the
     foreground page for the thread servicing the datachannel. */
  check("a hidden tab runs no inference at all",
    /if \(typeof document !== "undefined" && document\.hidden\) return;/.test(watcher));
  check("...and there is still exactly ONE detect call per tick",
    (watcher.match(/detectPoseFrame\(/g) || []).length === 1,
    "two samplers double the GPU cost and can throw on a duplicate timestamp");
}

console.log("\n── §5 THE NETWORK THROTTLE: a re-drape is delta-gated, not per-frame ──");
{
  /* The brief for this pass asked for delta-thresholded dispatch with a 150-200ms floor.
     Both already exist and are STRICTER than asked, so this pins them rather than
     re-implementing them - a second throttle layered on the first would only make the two
     able to disagree. */
  check(`the dispatch cooldown (${CONFIG.BODY_RECONDITION_COOLDOWN_MS}ms) exceeds the 200ms floor`,
    CONFIG.BODY_RECONDITION_COOLDOWN_MS >= 200);
  check("a re-drape needs a real delta on one of the four channels",
    CONFIG.BODY_ROTATION_DELTA_DEG > 0 && CONFIG.BODY_BUILD_DELTA > 0 && CONFIG.BODY_VOLUME_DELTA > 0);
  check(`...and the width gate (${CONFIG.BODY_BUILD_DELTA * 100}%) is stricter than the 3% asked for`,
    CONFIG.BODY_BUILD_DELTA >= 0.03);
  /* THE COOLDOWN LIVES INSIDE THE TRACKER, so "did it move?" and "may we send?" cannot
     drift apart - and a suppressed shift must NOT advance the baseline, or the movement
     is silently forgotten and the drape stays stale forever. */
  const tracker = slice("function makeBodyTopologyTracker(opts = {})", "/* MediaPipe's VIDEO running mode rejects");
  check("a cooled-down shift does not advance the baseline",
    /if \(t - lastSignalAt < cooldownMs\) return \{ state: "cooldown", reason, delta, heldMs \};/.test(tracker),
    "advancing it here forgets the movement, and the garment never catches up");
  check("...nor does one deferred because the wire is busy",
    /if \(!canDispatch\) return \{ state: "deferred", reason, delta, heldMs \};/.test(tracker));
  /* Standing still must cost nothing at all: no reason -> no dispatch, no baseline move. */
  check("a body that has not moved dispatches nothing",
    /if \(!reason\) return \{ state: heldMs \? "resumed" : "stable", delta, heldMs \};/.test(tracker));
  /* The morphology filter must not have added a SECOND dispatch trigger behind the
     tracker's back - re-drape timing is the tracker's alone. */
  check("the morphology filter triggers no dispatch of its own",
    !/bodyMorphology[\s\S]{0,200}?(scheduleRecondition|rtClient\.set)/.test(SRC),
    "a second trigger would bypass the cooldown the first one enforces");
}

console.log(fails ? `\n${fails} check(s) FAILING` : "\nAll hot-path checks passing.");
process.exit(fails ? 1 : 0);
