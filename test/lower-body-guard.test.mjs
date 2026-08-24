/* LOWER-BODY COMPOSITING GUARD - the code-level containment layer.

   WHY THIS EXISTS: nothing in @decartai/sdk@0.1.5's realtime API can put a hard
   boundary on what Decart is allowed to touch (setInputSchema is exactly
   { prompt, enhance, image } - no mask/ROI/region parameter exists to configure,
   confirmed against the compiled SDK in decart-debug-log.test.mjs §2). A prompt can
   ASK the model not to alter the trousers; it cannot GUARANTEE it. This composites the
   shopper's own raw camera pixels back over Decart's output below a guard line, in the
   browser, where nothing the model does can override it - a real code-level backstop,
   not another sentence added to the prompt.

   WHY IT SHIPS OFF BY DEFAULT (LOWER_BODY_GUARD_ENABLED: false in config.js): the
   boundary is a FIXED FRACTION of frame height, not a real body-part detector - there is
   none in this codebase, and adding one means a multi-MB WASM+model CDN dependency this
   codebase has already rejected once, for the same reason, on the upload detector. A
   fixed fraction is a guess: framed close to the camera, it can clip into the bottom of
   a CORRECTLY rendered shirt, trading an occasional hallucination for a guaranteed
   visible seam on every session. That trade needs a live camera to validate, not
   reasoning about it in the abstract - so this suite proves the MECHANISM is correct
   (idempotent, torn down on every exit path, mirror-corrected, never fires while off),
   not that the fixed fraction is the right number for how this app is actually framed.

   ADDITIVE ONLY, matching lux-interactions.js's own stated design rule: #aiVideo is
   never touched, re-parented, or given a new role. This only ever paints on top of it
   via a separately stacked canvas (style.css), so every existing freeze-hold/cross-fade/
   teardown test that reads #aiVideo directly stays valid untouched. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

console.log("── §1 SHIPS OFF: the config default, and what that gives up ──");
{
  /* ── IT WAS OFF FOR ONE STATED REASON, AND THAT REASON IS GONE ──────────────
     config.js: "there is no body-part detector in this codebase to derive it from the
     shopper's ACTUAL waist position, and adding one means a multi-MB WASM+model CDN
     dependency". MediaPipe Pose was subsequently taken on for the body-presence gate and
     now runs CONTINUOUSLY for the topology monitor - it reports LEFT_HIP/RIGHT_HIP, the
     exact landmark that objection said was unobtainable. The boundary is the shopper's own
     hip line, re-read live, so the seam-across-a-shirt-hem failure the objection describes
     is one a hip-derived boundary structurally cannot have.

     AND THE FAILURE IT PREVENTS IS NOW REPRODUCED: trying on a SHIRT, the shopper lifts a
     leg into frame wearing light blue shorts and Decart renders black long trousers. The
     prompt forbids that in words; Decart's set() has no mask channel, so this is the only
     mechanism in the pipeline that can make it a guarantee rather than a request. */
  /* ── TURNED OFF 2026-08-24 BY REQUEST: 100% direct Decart stream ────────────
     The reasoning above is left standing because it is still true - it is the cost of
     this flag, not an argument that the flag is wrong. What the suite pins now is the
     OFF state, so that re-enabling is a deliberate edit here rather than a silent drift
     back. §2 below (a complete no-op, not a paused loop) is the SHIPPED path now, and
     §3-§11 keep exercising the enabled machinery against their own sandbox config so
     the mechanism cannot rot while it is switched off. */
  check("LOWER_BODY_GUARD_ENABLED is OFF in the REAL config module",
    CONFIG.LOWER_BODY_GUARD_ENABLED === false, String(CONFIG.LOWER_BODY_GUARD_ENABLED));
  check("...and config.js records that the objection was answered, not overruled",
    /THAT DEPENDENCY IS ALREADY HERE/.test(
      readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8")),
    "flipping a documented kill switch without answering its reason is how a fix regresses");
  check("LOWER_BODY_GUARD_FRAC is a sane fraction (0,1) - not a raw pixel count, not >1",
    typeof CONFIG.LOWER_BODY_GUARD_FRAC === "number" &&
    CONFIG.LOWER_BODY_GUARD_FRAC > 0 && CONFIG.LOWER_BODY_GUARD_FRAC < 1,
    String(CONFIG.LOWER_BODY_GUARD_FRAC));
}

/* Extract the two functions AND execute them against a hand-built sandbox - the same
   technique prompt-reanchor.test.mjs uses for setInterval-driven code: fake the
   scheduling primitive (requestAnimationFrame here, setInterval there), run the REAL
   guarded logic, and assert on what it actually did. */
const code = extract("let lowerBodyGuardRAF = null;", "/* Paint the final dressed frame");

/* `autoCalibrate` defaults to false here on purpose: §2-§6 below test the paint loop
   and lifecycle, not calibration, and calibrateLowerBodyGuard() is called fire-and-
   forget from inside startLowerBodyGuard() - if it were left enabled with no FaceDetector
   stub provided, its FIRST real statement past the disabled guard would throw a
   ReferenceError inside an async function, which becomes a REJECTED PROMISE nobody
   awaits. That used to pass silently here only because this file's own process.exit()
   at the bottom races ahead of Node's unhandled-rejection reporting - an accident of
   timing, not a real guarantee, and not how the calibration tests in §7-§8 are built. */
function harness({ enabled = true, frac = 0.34, isLiveVal = true,
                    webcamW = 1000, webcamH = 1800, autoCalibrate = false,
                    headToWaistUnits = 3.8, faceDetectorAvailable = false, faces = [],
                    bottomsActive = false, poseLine = null, poseTorso = 0.3 } = {}) {
  const rafCalls = [];
  let rafHandle = 0;
  const canvasCtx = { calls: [] };
  const ctxProxy = new Proxy({}, {
    get(_, prop) {
      if (prop === "canvas") return undefined;
      return (...args) => canvasCtx.calls.push({ op: String(prop), args });
    },
  });
  const canvasEl = {
    width: 0, height: 0,
    getContext: () => ctxProxy,
  };
  const webcamEl = { videoWidth: webcamW, videoHeight: webcamH };
  const classList = { added: [], removed: [],
    add(c) { this.added.push(c); }, remove(c) { this.removed.push(c); } };
  const cardEl = { classList };

  // A separate, minimal recorder for the CALIBRATION canvas (document.createElement),
  // distinct from #lowerBodyGuard's own canvasCtx above - the real code creates its own
  // scratch canvas for the face-detection pass, never reusing the guard canvas.
  const calibCtx = { calls: [] };
  const calibCanvasProxy = new Proxy({}, {
    get(_, prop) {
      if (prop === "canvas") return undefined;
      return (...args) => calibCtx.calls.push({ op: String(prop), args });
    },
  });
  const calibCanvasEl = { width: 0, height: 0, getContext: () => calibCanvasProxy };
  const documentStub = { createElement: (tag) => (tag === "canvas" ? calibCanvasEl : null) };

  let detectCalls = 0;
  const FaceDetectorStub = faceDetectorAvailable
    ? function FaceDetector(opts) {
        this.opts = opts;
        this.detect = async () => { detectCalls++; return faces; };
      }
    : undefined;

  const sandbox = {
    LOWER_BODY_GUARD_ENABLED: enabled,
    LOWER_BODY_GUARD_FRAC: frac,
    LOWER_BODY_GUARD_AUTO_CALIBRATE: autoCalibrate,
    LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS: headToWaistUnits,
    $: (id) => (id === "webcam" ? webcamEl : id === "lowerBodyGuard" ? canvasEl : null),
    /* The guard is category-aware now: it protects whichever region is NOT being fitted,
       so it has to know what is being fitted. §11 drives both categories. */
    isBottomsGarment: () => !!bottomsActive,
    activeItem: { id: "x" },
    BODY_GUARD_MARGIN_FRAC: CONFIG.BODY_GUARD_MARGIN_FRAC,
    POSE_LANDMARK: Object.freeze({
      LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_HIP: 23, RIGHT_HIP: 24,
    }),
    torsoReadable: () => poseLine !== null,
    BODY_TRACK_MIN_VISIBILITY: 0.5,
    poseLine, poseTorso,
    card: () => cardEl,
    isLive: () => isLiveVal,
    document: documentStub,
    FaceDetector: FaceDetectorStub,
    console: { log() {}, warn() {} },
    requestAnimationFrame: (cb) => { rafHandle++; rafCalls.push({ handle: rafHandle, cb }); return rafHandle; },
    cancelAnimationFrame: (h) => { rafCalls.push({ cancelled: h }); },
  };
  const fn = new Function(...Object.keys(sandbox),
    code +
    /* Seed the live hip line the way the pose loop would, so §11 can drive a pose-derived
       boundary without reproducing updateBodyGuardLine()'s landmark plumbing. */
    "\nif (poseLine !== null) { bodyGuardLine = poseLine; bodyGuardTorso = poseTorso; }" +
    "\nreturn { startLowerBodyGuard, stopLowerBodyGuard, calibrateLowerBodyGuard," +
    " guardedRegion, guardBand, paintGuardBand, updateBodyGuardLine," +
    " state: () => ({ lowerBodyGuardRAF, lowerBodyGuardFrac, bodyGuardLine }) };");
  return {
    api: fn(...Object.values(sandbox)), rafCalls, canvasCtx, canvasEl, classList, webcamEl,
    calibCtx, calibCanvasEl, detectCalls: () => detectCalls,
  };
}

console.log("\n── §2 DISABLED: a complete no-op, not a paused loop ──");
{
  const { api, rafCalls, classList } = harness({ enabled: false });
  api.startLowerBodyGuard();
  check("requestAnimationFrame is never called when the flag is off",
    rafCalls.length === 0, JSON.stringify(rafCalls));
  check("the CSS gate class is never added - CSS alone can't be relied on to hide a\n" +
        "        canvas nobody is painting into anyway, but the class is the tell that\n" +
        "        the loop THINKS it's running, and it must not think that",
    classList.added.length === 0, JSON.stringify(classList.added));
}

console.log("\n── §3 ENABLED: starts exactly one loop, never stacks a second ──");
{
  const { api, rafCalls, classList, state } = harness({ enabled: true });
  api.startLowerBodyGuard();
  check("requests exactly one animation frame on start",
    rafCalls.length === 1, JSON.stringify(rafCalls.map((c) => c.handle)));
  check("adds the CSS gate class", classList.added.includes("lower-body-guard-active"));

  api.startLowerBodyGuard();   // a second call while already running
  check("a second start() while already running requests NO additional frame - idempotent",
    rafCalls.length === 1, `expected still 1, got ${rafCalls.length}`);
  check("...and does not re-add the class a second time either",
    classList.added.length === 1, JSON.stringify(classList.added));
}

console.log("\n── §4 THE PAINT TICK: mirror-corrected, band geometry from the config fraction ──");
{
  const { api, rafCalls, canvasCtx, canvasEl, webcamEl } = harness({
    enabled: true, frac: 0.34, webcamW: 1000, webcamH: 1800, isLiveVal: true,
  });
  api.startLowerBodyGuard();
  check("one frame was scheduled to fire the first paint", rafCalls.length === 1);
  rafCalls[0].cb();   // run the paint tick synchronously

  check("the canvas is sized to the webcam's own resolution",
    canvasEl.width === 1000 && canvasEl.height === 1800,
    `${canvasEl.width}x${canvasEl.height}`);

  const ops = canvasCtx.calls.map((c) => c.op);
  check("clears before drawing (no stale band left from a previous tick)",
    ops.indexOf("clearRect") !== -1 && ops.indexOf("clearRect") < ops.indexOf("drawImage"));
  /* THE MIRROR CORRECTION, executed and checked against the ACTUAL numbers, not just
     "some transform happened". #webcam's decoded frame is never mirrored (only its CSS
     display is); #aiVideo comes back from Decart already correctly oriented. Compositing
     a raw, un-flipped webcam band under an already-correct one would land buttons/prints
     on the wrong side right at the seam - the same failure class flagged and fixed
     elsewhere in this file (see prompt-only-flip.test.mjs for the image-reupload
     flicker this SAME "get the orientation contract right" discipline exists for). */
  const translate = canvasCtx.calls.find((c) => c.op === "translate");
  const scale = canvasCtx.calls.find((c) => c.op === "scale");
  check("translates by the frame width before flipping (freezeFinalFrame()'s own technique)",
    translate && translate.args[0] === 1000 && translate.args[1] === 0, JSON.stringify(translate));
  check("...then applies a horizontal flip, never a vertical one",
    scale && scale.args[0] === -1 && scale.args[1] === 1, JSON.stringify(scale));

  const draw = canvasCtx.calls.find((c) => c.op === "drawImage");
  check("drawImage source is the webcam element itself", draw && draw.args[0] === webcamEl);
  // bandY = round(h * (1 - frac)) = round(1800 * 0.66) = 1188
  const expectedBandY = Math.round(1800 * (1 - 0.34));
  check(`the band starts at the fraction-derived Y (${expectedBandY}px), not a hardcoded pixel count`,
    draw && draw.args[2] === expectedBandY, JSON.stringify(draw && draw.args));
  check("the band covers the FULL remaining height down to the bottom of the frame",
    draw && draw.args[4] === (1800 - expectedBandY), JSON.stringify(draw && draw.args));

  check("re-schedules itself for the next frame (a loop, not a one-shot)",
    rafCalls.length === 2, `expected 2 scheduled frames, got ${rafCalls.length}`);
}

console.log("\n── §5 NEVER PAINTS OVER A NON-LIVE OR NOT-YET-READY FRAME ──");
{
  const { canvasCtx: notLiveCtx, rafCalls: notLiveRaf, api: notLiveApi } =
    harness({ enabled: true, isLiveVal: false });
  notLiveApi.startLowerBodyGuard();
  notLiveRaf[0].cb();
  check("isLive()===false: waits (reschedules) without ever calling drawImage",
    !notLiveCtx.calls.some((c) => c.op === "drawImage") && notLiveRaf.length === 2,
    JSON.stringify(notLiveCtx.calls.map((c) => c.op)));

  const { canvasCtx: noDimsCtx, rafCalls: noDimsRaf, api: noDimsApi } =
    harness({ enabled: true, webcamW: 0, webcamH: 0 });
  noDimsApi.startLowerBodyGuard();
  noDimsRaf[0].cb();
  check("webcam.videoWidth===0 (not yet decoding a frame): also waits, never draws",
    !noDimsCtx.calls.some((c) => c.op === "drawImage"), JSON.stringify(noDimsCtx.calls));
}

console.log("\n── §6 TEARDOWN: stops the loop, ungates the CSS, clears the canvas ──");
{
  const { api, rafCalls, classList, canvasCtx } = harness({ enabled: true });
  api.startLowerBodyGuard();
  check("running before stop", api.state().lowerBodyGuardRAF !== null);

  api.stopLowerBodyGuard();
  check("cancelAnimationFrame called with the exact handle that was scheduled",
    rafCalls.some((c) => c.cancelled === rafCalls[0].handle), JSON.stringify(rafCalls));
  check("the internal handle is cleared, so a later stop() call is a safe no-op",
    api.state().lowerBodyGuardRAF === null);
  check("the CSS gate class is removed", classList.removed.includes("lower-body-guard-active"));
  check("the canvas is cleared, not left showing the last painted band",
    canvasCtx.calls.some((c) => c.op === "clearRect"));

  // Idempotency the other direction: stopping twice must not throw or double-cancel.
  let threw = false;
  try { api.stopLowerBodyGuard(); } catch (_) { threw = true; }
  check("calling stop() again when already stopped does not throw", threw === false);
}

console.log("\n── §7 AUTO-CALIBRATION: graceful degradation, before anything about accuracy ──");
{
  /* THE GAP THIS FEATURE CLOSES: LOWER_BODY_GUARD_FRAC is one fixed number for every
     shopper at every distance from the camera - "if the user moves, the suit is still
     visible" is exactly that. calibrateLowerBodyGuard() derives a per-session estimate
     from a detected face box instead. Every assertion below is about the MECHANISM
     (does it degrade safely, does it clamp, does it use the right coordinate space) -
     none of them prove 3.8 head-heights is the right ratio for how this app is actually
     framed. That still needs a live camera, same as the guard fraction itself. */
  const { api, detectCalls } = harness({ autoCalibrate: false, enabled: true, faceDetectorAvailable: true });
  await api.calibrateLowerBodyGuard();
  check("LOWER_BODY_GUARD_AUTO_CALIBRATE:false short-circuits before ever touching FaceDetector",
    detectCalls() === 0, `detect() called ${detectCalls()} times`);
  check("...and the fraction stays at the static default, untouched",
    api.state().lowerBodyGuardFrac === 0.34);
}
{
  const { api, detectCalls } = harness({ autoCalibrate: true, enabled: true, faceDetectorAvailable: false });
  await api.calibrateLowerBodyGuard();
  check("no FaceDetector in this browser: degrades to the static fraction, no throw",
    api.state().lowerBodyGuardFrac === 0.34);
}
{
  const { api, detectCalls } = harness({ autoCalibrate: true, enabled: true,
    faceDetectorAvailable: true, faces: [] });
  await api.calibrateLowerBodyGuard();
  check("FaceDetector available but finds nothing: still degrades to the static fraction",
    detectCalls() === 1 && api.state().lowerBodyGuardFrac === 0.34);
}
{
  // enabled:false must short-circuit calibration too, not just the paint loop - the
  // guard being off means NOTHING about it should run, calibration included.
  const { api, detectCalls } = harness({ autoCalibrate: true, enabled: false, faceDetectorAvailable: true });
  await api.calibrateLowerBodyGuard();
  check("LOWER_BODY_GUARD_ENABLED:false short-circuits calibration too",
    detectCalls() === 0);
}

console.log("\n── §8 AUTO-CALIBRATION: the geometry, executed against real numbers ──");
{
  /* A face detected at 10% down the frame, 15% of the frame tall, in a canvas SCALED
     (not cropped) from a 1000x1800 webcam frame down to its 256px-longest-side form -
     since the canvas preserves the real aspect ratio, these fractions apply directly to
     the real webcam frame with no separate coordinate conversion needed (that property
     is the entire reason calibrateLowerBodyGuard() scales rather than crops - see its
     own comment). waistFrac = 0.10 + 0.15*3.8 = 0.67 -> guard = 1 - 0.67 = 0.33. */
  const { api } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true, headToWaistUnits: 3.8,
    webcamW: 1000, webcamH: 1800,
    faces: [{ boundingBox: { y: 0, height: 0 } }],   // placeholder, overwritten below
  });
  // The stub canvas is 256px on the LONGER side (1800 -> ch=256, cw=142); express the
  // face box in THAT canvas's own pixel space, matching what the real code hands to
  // FaceDetector.detect().
  const ch = 256;
  const faceTopFrac = 0.10, faceHeightFrac = 0.15;
  const { api: api2, calibCanvasEl } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true, headToWaistUnits: 3.8,
    webcamW: 1000, webcamH: 1800,
    faces: [{ boundingBox: { y: faceTopFrac * ch, height: faceHeightFrac * ch } }],
  });
  await api2.calibrateLowerBodyGuard();
  const expected = 1 - (faceTopFrac + faceHeightFrac * 3.8);
  check(`derives the expected guard fraction from face position + head-to-waist ratio (~${expected.toFixed(2)})`,
    Math.abs(api2.state().lowerBodyGuardFrac - expected) < 0.01,
    `got ${api2.state().lowerBodyGuardFrac}`);
  check("the calibration canvas is scaled to preserve aspect, not force-cropped to a square\n" +
        "        (a crop would make this exact fraction math wrong)",
    calibCanvasEl.width !== calibCanvasEl.height, `${calibCanvasEl.width}x${calibCanvasEl.height}`);
}
{
  // A spurious/tiny detection must not produce a guard that protects almost nothing
  // or almost the whole frame - clamped to [0.15, 0.55].
  const { api: lowApi } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true, headToWaistUnits: 3.8,
    faces: [{ boundingBox: { y: 0, height: 5 } }],   // face pinned at the very top - waist "high"
  });
  await lowApi.calibrateLowerBodyGuard();
  check("clamps to the floor (0.15) rather than an implausibly small guard",
    lowApi.state().lowerBodyGuardFrac >= 0.15, String(lowApi.state().lowerBodyGuardFrac));

  const { api: highApi } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true, headToWaistUnits: 3.8,
    webcamH: 1800,
    faces: [{ boundingBox: { y: 200, height: 200 } }],   // large face low in frame - waist "low"
  });
  await highApi.calibrateLowerBodyGuard();
  check("clamps to the ceiling (0.55) rather than guarding nearly the whole frame",
    highApi.state().lowerBodyGuardFrac <= 0.55, String(highApi.state().lowerBodyGuardFrac));
}
{
  // Fire-and-forget from startLowerBodyGuard() itself - not just directly callable.
  const { api, detectCalls } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true,
    faces: [{ boundingBox: { y: 25, height: 38 } }],
  });
  api.startLowerBodyGuard();
  await new Promise((r) => setTimeout(r, 0));   // let the fire-and-forget microtask settle
  check("startLowerBodyGuard() itself triggers calibration, without being asked to await it",
    detectCalls() === 1);
}
{
  // stopLowerBodyGuard() must reset the LIVE value, not just cancel the loop - otherwise
  // a second session inherits a stale calibration from a different shopper.
  const { api } = harness({
    autoCalibrate: true, enabled: true, faceDetectorAvailable: true,
    faces: [{ boundingBox: { y: 25, height: 38 } }],
  });
  await api.calibrateLowerBodyGuard();
  check("sanity: calibration actually moved the value away from the static default",
    api.state().lowerBodyGuardFrac !== 0.34);
  api.stopLowerBodyGuard();
  check("stop() resets lowerBodyGuardFrac back to the static config default",
    api.state().lowerBodyGuardFrac === 0.34);
}

console.log("\n── §9 LIFECYCLE WIRING: every real exit path stops it ──");
{
  /* Structural, not executed - re-running startBillingWindow()/stopLive()/
     beginFreezeHold()/teardown() in full would mean reconstructing this file's entire
     module state, which is what every OTHER lifecycle test in this repo already avoids
     (see prompt-reanchor.test.mjs §7's own "wiring" section for the same choice). */
  const billing = extract('card().classList.add("show-live");', "startRecording();");
  check("go-live starts the guard in the same place show-live is added",
    /startLowerBodyGuard\(\);/.test(billing), billing);

  const stop = extract("function stopLive()", "\n}");
  check("stopLive() stops the guard alongside removing show-live",
    /card\(\)\.classList\.remove\("show-live"\);\s*\n\s*stopLowerBodyGuard\(\);/.test(stop), stop);

  const hold = extract("function beginFreezeHold()", "\n}\n");
  check("beginFreezeHold() (the automatic 5s-cap exit path) stops it too - not just\n" +
        "        the manual Stop button path",
    /card\(\)\.classList\.remove\("show-live"\);\s*\n\s*stopLowerBodyGuard\(\);/.test(hold), hold);

  const teardown = extract("function teardown()", "\n  sessionGen++;");
  check("teardown() itself carries a backstop call - the authoritative catch-all every\n" +
        "        exit path eventually reaches",
    /stopLowerBodyGuard\(\);/.test(teardown), teardown);
}

console.log("\n── §10 freezeFinalFrame(): the KEPT snapshot gets the same protection ──");
{
  /* ── THREE CALLERS, ONE HELPER ─────────────────────────────────────────────
     The band, its boundary and the mirror correction used to be written out separately in
     the live guard and again in freezeFinalFrame. There are three consumers now - the live
     canvas, the RECORDER and the frozen frame - and three copies of this arithmetic is
     three chances for the saved artefact to disagree with what the shopper watched. They
     all call paintGuardBand(), so the properties below are asserted where they now live. */
  const ff = extract("function freezeFinalFrame()", "\n/* ── Live countdown overlay");
  const gb = extract("function paintGuardBand(ctx, webcam, w, h)", "\nfunction startLowerBodyGuard");
  check("bakes the guard only when the AI-edited stream was the primary source",
    /if \(!mirror\) paintGuardBand\(ctx, webcam, w, h\);/.test(ff), ff.slice(-500));
  check("gated on the same config flag as the live view - one on/off switch, not two",
    /if \(!LOWER_BODY_GUARD_ENABLED/.test(gb), gb.slice(0, 300));
  check("does NOT apply when the fallback branch (raw webcam, no AI edit at all) was used",
    !/mirror && LOWER_BODY_GUARD_ENABLED/.test(ff),
    "the webcam-fallback branch has nothing for the guard to protect against");
  check("source and destination band Y are computed independently (webcam and ai/canvas\n" +
        "        resolutions can legitimately differ - reusing one offset for both would\n" +
        "        silently misalign the composited band on any camera that doesn't happen\n" +
        "        to match the AI stream's exact resolution)",
    /const dst = guardBand\(h\);/.test(gb) &&
    /const src = guardBand\(webcam\.videoHeight\);/.test(gb), gb);
  check("a failed guard paint is caught and does not fail the whole snapshot",
    /catch \(_\) \{[\s\S]{0,160}best-effort/.test(gb), gb.slice(-400));
  /* THE RECORDER IS THE THIRD CONSUMER, and the one that was silently missing: its paint
     loop draws #aiVideo directly and has never seen the overlay canvases stacked over it,
     so without this the saved clip and poster would show the invented garment the live
     view was protecting the shopper from. */
  const rec = extract("const beginRecorder = () => {", "\n/** Halt the canvas paint loop");
  check("the RECORDER bakes it too, so the clip cannot disagree with the live view",
    /ctx\.drawImage\(video, 0, 0, w, h\);\s*\n\s*paintGuardBand\(ctx, \$\("webcam"\), w, h\);/.test(rec),
    rec.slice(-400));
}

console.log("\n── §10b CATEGORY-AWARE: it guards whichever region is NOT being fitted ──");
{
  /* THE NAMES SAY "LOWER BODY"; THE BEHAVIOUR IS "THE NON-TARGET REGION". The feature was
     built for tops, where the un-fitted half is always the lower body. A BOTTOMS try-on has
     the mirror failure - step back, the torso enters frame, and a shirt is invented - so
     the guard has to move to the other half. The DOM id and these function names were left
     alone deliberately (stable identifiers with history in three files); guardedRegion() is
     the thing to read. */
  const tops = harness({ bottomsActive: false, poseLine: 0.6, poseTorso: 0.3 });
  const bots = harness({ bottomsActive: true,  poseLine: 0.6, poseTorso: 0.3 });
  check("a TOPS try-on guards the LOWER body",
    tops.api.guardedRegion() === "lower");
  check("a BOTTOMS try-on guards the UPPER body - the mirror failure",
    bots.api.guardedRegion() === "upper",
    "a shopper stepping back during a trousers session gets an invented shirt otherwise");

  const H = 1000;
  const lower = tops.api.guardBand(H), upper = bots.api.guardBand(H);
  check("...and the two bands are on opposite sides of the hip line, never overlapping",
    lower.y1 === H && upper.y0 === 0 && upper.y1 < lower.y0,
    JSON.stringify({ lower, upper }));

  /* THE MARGIN ALWAYS PUSHES AWAY FROM THE GARMENT BEING FITTED. The hip line is where the
     body halves meet, not where a garment ends: a shirt hem falls a little below the hips
     and a waistband rides a little above. Guarding right at the line would clip whichever
     one overhangs - the seam-across-a-hem defect this feature was held back for. */
  const hipPx = Math.round(H * 0.6);
  check("the margin pushes the boundary DOWN for tops, clear of a long shirt hem",
    lower.y0 > hipPx, `band starts at ${lower.y0}, hips at ${hipPx}`);
  check("...and UP for bottoms, clear of a high waistband",
    upper.y1 < hipPx, `band ends at ${upper.y1}, hips at ${hipPx}`);
  check("...scaled by TORSO length, so it means the same close up and far back",
    /const margin = \(bodyGuardTorso \|\| 0\) \* BODY_GUARD_MARGIN_FRAC;/.test(APP) &&
    CONFIG.BODY_GUARD_MARGIN_FRAC > 0 && CONFIG.BODY_GUARD_MARGIN_FRAC < 0.5,
    String(CONFIG.BODY_GUARD_MARGIN_FRAC));
}

console.log("\n── §10c THE BOUNDARY IS THE SHOPPER'S OWN HIP LINE ──");
{
  /* This is the objection config.js documented as the reason to ship disabled - "a GUESS
     calibrated to nothing about the actual shopper" - answered rather than overruled. */
  const posed = harness({ poseLine: 0.62, poseTorso: 0.3 });
  const band = posed.api.guardBand(1000);
  check("with a pose reading the band is derived from the hips, not the fraction",
    band.source === "pose", JSON.stringify(band));
  check("...and it tracks the shopper: a higher hip line moves the band up with it",
    harness({ poseLine: 0.45, poseTorso: 0.3 }).api.guardBand(1000).y0 <
    harness({ poseLine: 0.75, poseTorso: 0.3 }).api.guardBand(1000).y0);
  /* THE FALLBACK SURVIVES, for frames before the detector has a reading - a browser with
     no WebAssembly, a dead CDN, landmarks below the tracking bar. Guarding on a rough
     boundary beats not guarding at all now that the failure it prevents is reproduced. */
  const cold = harness({ poseLine: null, frac: 0.34 });
  const coldBand = cold.api.guardBand(1000);
  check("with NO pose reading it falls back to the static/calibrated fraction",
    coldBand.source === "fraction" && coldBand.y0 === 660 && coldBand.y1 === 1000,
    JSON.stringify(coldBand));
  /* The static fraction only ever described a LOWER band. Re-using that number for an
     upper-body guard would be a guess about a guess, and the bottoms direction has no
     reproduced report yet - so it guards nothing rather than guessing. */
  check("...but a BOTTOMS session with no pose reading guards nothing, rather than guessing",
    harness({ bottomsActive: true, poseLine: null }).api.guardBand(1000) === null,
    "the static fraction describes a lower band; inverting it would be a guess about a guess");
  check("the live hip line is fed from the pose loop that is already running",
    /updateBodyGuardLine\(result\);/.test(APP) &&
    /function updateBodyGuardLine\(result\)/.test(APP),
    "a second detector pass for this would be a whole extra inference per tick");
  check("...and is cleared with the session, like the calibration beside it",
    /bodyGuardLine = null;\s*\n\s*bodyGuardTorso = null;/.test(
      extract("function stopLowerBodyGuard()", "\n/* Paint the final dressed frame")),
    "a hip line describes one specific body - it must not survive into another shopper's session");
}

console.log("\n── §11 ADDITIVE ONLY: the DOM/CSS layer, and that #aiVideo is untouched ──");
{
  check("index.html adds #lowerBodyGuard stacked AFTER #aiVideo (paints on top by DOM order)",
    HTML.indexOf('id="aiVideo"') < HTML.indexOf('id="lowerBodyGuard"') &&
    HTML.indexOf('id="lowerBodyGuard"') < HTML.indexOf('id="resultCanvas"'));

  const guardCss = CSS.slice(CSS.indexOf(".camera-card #lowerBodyGuard"),
                             CSS.indexOf(".camera-card.show-live.lower-body-guard-active") + 200);
  check("the canvas never intercepts pointer events (swatches/video beneath it must\n" +
        "        stay fully interactive)",
    /pointer-events:\s*none/.test(guardCss), guardCss);
  check("hidden by default - CSS-level, independent of the JS class toggle",
    /display:\s*none/.test(guardCss), guardCss);
  check("only shown when BOTH .show-live AND the JS-toggled gate class are present -\n" +
        "        never one alone, so a stray class from elsewhere can't reveal it",
    /\.show-live\.lower-body-guard-active #lowerBodyGuard \{ display: block; \}/.test(CSS));

  /* THE REGRESSION GUARD. If this ever fails, the compositing feature has stopped being
     additive and started being a rewrite - #aiVideo must keep exactly the role every
     OTHER test in this repo (turn-hold, reconnect, prompt-only-flip) already assumes. */
  check("#aiVideo's own base rule is completely unchanged by this feature",
    /\.camera-card #aiVideo \{ display: none; \}/.test(CSS));
  check("#aiVideo is still what onRemoteStream assigns srcObject to, untouched",
    /aiVideo\.srcObject = editedStream;/.test(APP));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
