/* THE NON-TARGET REGION GUARD - the code-level containment layer, restored.

   WHY IT EXISTS: nothing in @decartai/sdk@0.1.5's realtime API can put a hard boundary on
   what Decart is allowed to touch (setInputSchema is exactly { prompt, enhance, image } -
   no mask/ROI/region parameter exists to configure, confirmed against the compiled SDK in
   decart-debug-log.test.mjs §2). A prompt can ASK the model not to alter the trousers; it
   cannot GUARANTEE it. This composites the shopper's own raw camera pixels back over
   Decart's output past a guard line, in the browser, where nothing the model does can
   override it - a real code-level backstop, not another sentence added to the prompt.

   ── THIS SUITE WAS DELETED ONCE, WITH THE FEATURE. READ WHY ────────────────────
   The mechanism was reverted three times and then removed outright, against a symptom that
   never changed: the fitting frame rendering as two zones, Decart on top, a raw camera feed
   or a black block underneath. THREE DISTINCT DEFECTS produced that one symptom, and this
   suite's job is now to make each of them impossible to reintroduce quietly:

     DEFECT 1 - THE BOUNDARY WAS NEVER THE HIP LINE (§9). updateBodyGuardLine()'s only call
       site was inside armFirstFrameBilling()'s `if (frameTimingDebug)` block, against a
       `result` that does not exist in that scope. It never ran. bodyGuardLine was always
       null, guardBand() always fell through to the static fraction, and all three reports
       were filed against the fixed-fraction guess that config.js had already predicted
       would fail exactly that way. The pose-derived boundary has never once run in a
       shipped session. §9 asserts the call site, because this function fails SILENTLY.
     DEFECT 2 - THE BAND COULD PAINT BLACK (§5). Its source was drawImage(#webcam, ...),
       and #webcam is visibility:hidden for all of .show-live while the input throttle
       re-negotiates the shared camera source underneath it.
     DEFECT 3 - THE EDGE WAS HARD (§6). The deletion's stated condition for any restore was
       that it "must not be a hard-edged rectangular composite over a diffusion output".

   ADDITIVE ONLY, matching lux-interactions.js's own stated design rule: #aiVideo is never
   touched, re-parented, or given a new role. This only ever paints on top of it via a
   separately stacked canvas (style.css), so every existing freeze-hold/cross-fade/teardown
   test that reads #aiVideo directly stays valid untouched. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

console.log("── §1 THE FLAG, AND THE FOUR MOVES BEHIND IT ──");
{
  check("LOWER_BODY_GUARD_ENABLED is ON in the REAL config module",
    CONFIG.LOWER_BODY_GUARD_ENABLED === true, String(CONFIG.LOWER_BODY_GUARD_ENABLED));
  /* A flag that has moved four times is worth nothing without its history attached - the
     next person to flip it has to be able to read what each move cost. */
  check("...and config.js carries the full arc, all four moves",
    /THIS FLAG HAS MOVED FOUR TIMES/.test(CFG) &&
    /DELETED outright after a third report/.test(CFG),
    "a flag whose history is only in the commit log gets flipped by someone who hasn't read it");
  /* Whitespace-collapsed: these are prose blocks wrapped to the file's comment width, so a
     straight substring match would break on a re-wrap rather than on a deletion. */
  const cfgFlat = CFG.replace(/\s+/g, " ");
  check("...including the original fixed-fraction objection, kept verbatim",
    /a GUESS calibrated to nothing about the actual shopper/.test(cfgFlat),
    "the objection was answered, not overruled - deleting it loses why the answer matters");
  check("...and names the dead call site as the reason the reports were misdiagnosed",
    /frameTimingDebug/.test(CFG) && /never ran/.test(CFG),
    "three reports were filed against a boundary that was never the one in the design");

  check("LOWER_BODY_GUARD_FRAC is a sane fraction (0,1) - not a raw pixel count, not >1",
    typeof CONFIG.LOWER_BODY_GUARD_FRAC === "number" &&
    CONFIG.LOWER_BODY_GUARD_FRAC > 0 && CONFIG.LOWER_BODY_GUARD_FRAC < 1,
    String(CONFIG.LOWER_BODY_GUARD_FRAC));
  check("BODY_GUARD_FEATHER_FRAC is non-zero - a hard edge is the reported defect",
    typeof CONFIG.BODY_GUARD_FEATHER_FRAC === "number" &&
    CONFIG.BODY_GUARD_FEATHER_FRAC > 0 && CONFIG.BODY_GUARD_FEATHER_FRAC < 0.5,
    String(CONFIG.BODY_GUARD_FEATHER_FRAC));
  /* THE ALIGNMENT BUG, fenced so a restore cannot inherit it. The canvas BITMAP is sized to
     the AI stream's native resolution while the videos beneath it are object-fit:cover
     inside a routinely-portrait card. Without a matching fit the overlay is stretched where
     the feed is centre-cropped, so a band painted at "the hip line" lands somewhere else
     entirely on the frame below. */
  check("#lowerBodyGuard is object-fit:cover, matching the video layers it composites over",
    /#lowerBodyGuard\s*\{[^}]*object-fit:\s*cover/.test(CSS),
    "a stretched overlay over a centre-cropped video cannot agree about which pixels are which");
  check("...and it exists in the markup, stacked above #aiVideo, pointer-events off",
    /<canvas id="lowerBodyGuard"/.test(HTML) &&
    HTML.indexOf('id="aiVideo"') < HTML.indexOf('id="lowerBodyGuard"') &&
    /#lowerBodyGuard\s*\{[^}]*pointer-events:\s*none/.test(CSS),
    "it must never intercept a gesture meant for the video beneath it");
  check("...and it is hidden unless BOTH .show-live and the active class are set",
    /\.camera-card\.show-live\.lower-body-guard-active #lowerBodyGuard \{ display: block; \}/.test(CSS),
    "a guard canvas visible outside a live session is a split with no session to justify it");
}

/* Extract the whole mechanism AND execute it against a hand-built sandbox - the same
   technique prompt-reanchor.test.mjs uses for setInterval-driven code: fake the scheduling
   primitive, run the REAL guarded logic, and assert on what it actually did. */
const code = extract("let lowerBodyGuardRAF = null;", "/* Paint the final dressed frame");

/* `autoCalibrate` defaults to false here on purpose: the paint/lifecycle sections test the
   loop, not calibration, and calibrateLowerBodyGuard() is called fire-and-forget from
   inside startLowerBodyGuard() - if it were left enabled with no FaceDetector stub, its
   first real statement past the disabled guard would throw a ReferenceError inside an async
   function, which becomes a REJECTED PROMISE nobody awaits. That would pass silently here
   only because this file's process.exit() races ahead of Node's unhandled-rejection
   reporting - an accident of timing, not a guarantee. §12 stubs it properly instead. */
function harness({ enabled = true, frac = 0.34, isLiveVal = true,
                   aiW = 1000, aiH = 1800, webcamW = 1280, webcamH = 720,
                   throttleW = 512, throttleH = 910, hasThrottle = true,
                   feather = CONFIG.BODY_GUARD_FEATHER_FRAC,
                   autoCalibrate = false, headToWaistUnits = 3.8,
                   faceDetectorAvailable = false, faces = [],
                   bottomsActive = false, poseLine = null, poseTorso = 0.3 } = {}) {
  const rafCalls = [];
  let rafHandle = 0;
  const canvasCtx = { calls: [] };
  /* Records SETS as well as calls - unlike the pre-deletion harness, which only had a `get`
     trap and so could not see globalAlpha at all. The feathered ramp IS a sequence of
     globalAlpha values, so a proxy blind to assignment cannot test defect 3. */
  const ctxProxy = new Proxy({}, {
    get(_, prop) {
      if (prop === "canvas") return undefined;
      return (...args) => canvasCtx.calls.push({ op: String(prop), args });
    },
    set(_, prop, value) {
      canvasCtx.calls.push({ op: `set:${String(prop)}`, args: [value] });
      return true;
    },
  });
  const canvasEl = { width: 0, height: 0, getContext: () => ctxProxy };
  const aiEl = { videoWidth: aiW, videoHeight: aiH };
  const webcamEl = { videoWidth: webcamW, videoHeight: webcamH, __tag: "webcam" };
  const throttleCanvas = { width: throttleW, height: throttleH, __tag: "throttle" };
  const classList = { added: [], removed: [],
    add(c) { this.added.push(c); }, remove(c) { this.removed.push(c); } };
  const cardEl = { classList };

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
    BODY_GUARD_MARGIN_FRAC: CONFIG.BODY_GUARD_MARGIN_FRAC,
    BODY_GUARD_FEATHER_FRAC: feather,
    $: (id) => (id === "webcam" ? webcamEl
              : id === "aiVideo" ? aiEl
              : id === "lowerBodyGuard" ? canvasEl : null),
    inputThrottle: hasThrottle ? { canvas: throttleCanvas } : null,
    /* The guard is category-aware: it protects whichever region is NOT being fitted, so it
       has to know what is being fitted. §7 drives both categories. */
    isBottomsGarment: () => !!bottomsActive,
    activeItem: { id: "x" },
    POSE_LANDMARK: Object.freeze({
      LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_HIP: 23, RIGHT_HIP: 24,
    }),
    torsoReadable: (lm) => Array.isArray(lm) && lm.length > 0,
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
    /* Seed the live hip line the way the pose loop would, so the boundary sections can drive
       a pose-derived band without reproducing updateBodyGuardLine()'s landmark plumbing.
       §9 exercises that function directly instead. */
    "\nif (poseLine !== null) { bodyGuardLine = poseLine; bodyGuardTorso = poseTorso; }" +
    "\nreturn { startLowerBodyGuard, stopLowerBodyGuard, calibrateLowerBodyGuard," +
    " guardedRegion, guardBand, guardSource, paintGuardBand, updateBodyGuardLine," +
    " state: () => ({ lowerBodyGuardRAF, lowerBodyGuardFrac, bodyGuardLine, bodyGuardTorso }) };");
  return {
    api: fn(...Object.values(sandbox)), rafCalls, canvasCtx, canvasEl, classList,
    webcamEl, aiEl, throttleCanvas, calibCtx, calibCanvasEl, detectCalls: () => detectCalls,
  };
}

/** Every drawImage the guard issued, in order. */
const draws = (h) => h.canvasCtx.calls.filter((c) => c.op === "drawImage");
/** Every globalAlpha the guard set, in order. */
const alphas = (h) => h.canvasCtx.calls.filter((c) => c.op === "set:globalAlpha").map((c) => c.args[0]);

console.log("\n── §2 DISABLED: a complete no-op, not a paused loop ──");
{
  const h = harness({ enabled: false });
  h.api.startLowerBodyGuard();
  check("requestAnimationFrame is never called when the flag is off",
    h.rafCalls.length === 0, JSON.stringify(h.rafCalls));
  check("the CSS gate class is never added",
    h.classList.added.length === 0, JSON.stringify(h.classList.added));
  check("...and paintGuardBand paints NOTHING even if called directly",
    h.api.paintGuardBand({}, 100, 100) === false && draws(h).length === 0,
    "off must mean no pixels, not merely no loop");
}

console.log("\n── §3 ENABLED: starts exactly one loop, never stacks a second ──");
{
  const h = harness({ enabled: true });
  h.api.startLowerBodyGuard();
  check("requests exactly one animation frame on start",
    h.rafCalls.length === 1, JSON.stringify(h.rafCalls.map((c) => c.handle)));
  check("adds the CSS gate class", h.classList.added.includes("lower-body-guard-active"));

  h.api.startLowerBodyGuard();   // a second call while already running
  check("a second start() while already running requests NO additional frame - idempotent",
    h.rafCalls.length === 1, `expected still 1, got ${h.rafCalls.length}`);
  check("...and does not re-add the class a second time either",
    h.classList.added.length === 1, JSON.stringify(h.classList.added));
}

console.log("\n── §4 THE PAINT TICK: sized to #aiVideo, cleared before drawn ──");
{
  const h = harness({ enabled: true, aiW: 1000, aiH: 1800 });
  h.api.startLowerBodyGuard();
  h.rafCalls[0].cb();   // run the paint tick synchronously

  /* SIZED TO #aiVideo, NOT THE CAMERA. This canvas is stacked directly over that element,
     both object-fit:cover in the same box, so matching its intrinsic size is what makes a
     Y-fraction here mean the same thing as a Y-fraction of the frame underneath. The
     pre-deletion loop sized to the webcam, leaving the two layers disagreeing about which
     pixels were which on any camera whose resolution differs from the AI stream's. */
  check("the canvas is sized to #aiVideo's resolution, not the webcam's",
    h.canvasEl.width === 1000 && h.canvasEl.height === 1800,
    `${h.canvasEl.width}x${h.canvasEl.height} (webcam is 1280x720 in this harness)`);

  const ops = h.canvasCtx.calls.map((c) => c.op);
  check("clears before drawing (no stale band left from a previous tick)",
    ops.indexOf("clearRect") !== -1 && ops.indexOf("clearRect") < ops.indexOf("drawImage"));
  check("...and schedules the next frame",
    h.rafCalls.length === 2, `${h.rafCalls.length} frames scheduled`);
}

console.log("\n── §5 DEFECT 2: THE SOURCE IS THE THROTTLE CANVAS, NOT #webcam ──");
{
  /* THE BLACK BAND, fenced. #webcam is visibility:hidden for all of .show-live while the
     input throttle re-negotiates the shared camera source underneath it via
     applyConstraints() on a clone of the same device track - so a readback off it at the
     wrong moment returns nothing, and "nothing" composited over half a frame is the solid
     black rectangle that was reported. The throttle's own canvas cannot be blank while a
     session is running: those are the frames the session is made of. */
  const h = harness({ enabled: true, hasThrottle: true });
  const src = h.api.guardSource();
  check("guardSource() prefers the throttle canvas - the frames actually sent to Decart",
    src && src.src === h.throttleCanvas, JSON.stringify(src && src.src && src.src.__tag));
  check("...and reports it as ALREADY mirrored, so no second flip is applied",
    src && src.mirror === false,
    "drawFrame() mirrors when it paints; flipping again would put prints on the wrong side");

  h.api.startLowerBodyGuard();
  h.rafCalls[0].cb();
  const d = draws(h);
  check("every drawImage in the tick reads from the throttle canvas",
    d.length > 0 && d.every((c) => c.args[0] === h.throttleCanvas),
    JSON.stringify(d.map((c) => c.args[0] && c.args[0].__tag)));
  check("...and no ctx.scale(-1,1) is applied for that source",
    !h.canvasCtx.calls.some((c) => c.op === "scale"),
    "the throttle canvas is already in Decart's orientation");

  /* THE FALLBACK still exists, for the paths that run with no throttle (the frozen frame
     after teardown, ?demo=1) - and THERE the mirror correction is required. */
  const w = harness({ enabled: true, hasThrottle: false });
  const wsrc = w.api.guardSource();
  check("with no throttle it falls back to #webcam",
    wsrc && wsrc.src === w.webcamEl, JSON.stringify(wsrc && wsrc.src && wsrc.src.__tag));
  check("...and THAT source is mirror-corrected, because its decoded frame never is",
    wsrc && wsrc.mirror === true);
  w.api.startLowerBodyGuard();
  w.rafCalls[0].cb();
  const translate = w.canvasCtx.calls.find((c) => c.op === "translate");
  const scale = w.canvasCtx.calls.find((c) => c.op === "scale");
  check("...applied as translate(w,0) then scale(-1,1) - freezeFinalFrame()'s own technique",
    translate && translate.args[0] === 1000 && translate.args[1] === 0 &&
    scale && scale.args[0] === -1 && scale.args[1] === 1,
    JSON.stringify({ translate, scale }));

  const n = harness({ enabled: true, hasThrottle: false, webcamW: 0, webcamH: 0 });
  check("with neither source available the guard paints nothing rather than a blank band",
    n.api.guardSource() === null && n.api.paintGuardBand({}, 100, 100) === false,
    "a band with no source IS the black rectangle");
}

console.log("\n── §6 DEFECT 3: THE EDGE IS FEATHERED, NEVER BUTTED ──");
{
  /* THE DELETION'S CONDITION, as an executable assertion: "anything that brings it back
     must not be a hard-edged rectangular composite over a diffusion output". Two sources
     that disagree on exposure, white balance or latency show that disagreement as a LINE
     when butted together and as a gradient when ramped. */
  const h = harness({ enabled: true, aiH: 1000, feather: 0.06 });
  h.api.startLowerBodyGuard();
  h.rafCalls[0].cb();
  const a = alphas(h);
  check("the band is drawn in many slices, not one rectangle",
    draws(h).length > 5, `${draws(h).length} drawImage calls`);
  check("...at a RANGE of alphas, not all at 1",
    new Set(a).size > 5 && a.some((v) => v > 0 && v < 1),
    JSON.stringify(a));
  check("...spanning from near-transparent at the boundary to fully opaque in the core",
    Math.min(...a) < 0.2 && Math.max(...a) === 1,
    `min ${Math.min(...a)} max ${Math.max(...a)}`);
  check("...and rising monotonically inward - a ramp, not noise",
    (() => {
      const ramp = a.filter((v) => v < 1);
      return ramp.every((v, i) => i === 0 || v >= ramp[i - 1]);
    })(), JSON.stringify(a));

  /* THE GEOMETRY OF THE RAMP: for a LOWER guard the boundary is the band's TOP edge, so
     the most transparent slice must be the highest one on the canvas. */
  const partial = h.canvasCtx.calls
    .reduce((acc, c) => {
      if (c.op === "set:globalAlpha") acc.alpha = c.args[0];
      if (c.op === "drawImage" && acc.alpha < 1) acc.rows.push({ y: c.args[6], alpha: acc.alpha });
      return acc;
    }, { alpha: 1, rows: [] }).rows;
  check("the faintest slice sits at the boundary and opacity climbs away from it",
    partial.length > 1 &&
    partial[0].y < partial[partial.length - 1].y &&
    partial[0].alpha < partial[partial.length - 1].alpha,
    JSON.stringify(partial.slice(0, 3)));

  /* A ZERO FEATHER IS STILL REACHABLE - config documents it as the configuration that was
     reported three times, so it must be genuinely reachable rather than clamped away. */
  const hard = harness({ enabled: true, feather: 0 });
  hard.api.startLowerBodyGuard();
  hard.rafCalls[0].cb();
  check("BODY_GUARD_FEATHER_FRAC=0 degrades to a single full-strength band",
    draws(hard).length === 1 && alphas(hard).every((v) => v === 1),
    `${draws(hard).length} draws, alphas ${JSON.stringify(alphas(hard))}`);

  /* AND THE FEATHER NEVER EATS THE WHOLE BAND. A ramp longer than the band it is ramping
     would leave the guarded region partly transparent - Decart's invention showing through
     the thing that exists to hide it. */
  const tiny = harness({ enabled: true, aiH: 1000, feather: 0.9, poseLine: 0.95, poseTorso: 0 });
  tiny.api.startLowerBodyGuard();
  tiny.rafCalls[0].cb();
  const tinyDraws = draws(tiny);
  check("a feather longer than the band is clamped to the band, never past it",
    tinyDraws.every((c) => c.args[6] >= 950 - 1 && c.args[6] + c.args[8] <= 1000 + 1),
    JSON.stringify(tinyDraws.map((c) => [c.args[6], c.args[8]])));
}

console.log("\n── §7 CATEGORY AWARENESS: it guards whichever region is NOT being fitted ──");
{
  const top = harness({ enabled: true, aiH: 1000, bottomsActive: false, poseLine: 0.5, poseTorso: 0.3 });
  const bot = harness({ enabled: true, aiH: 1000, bottomsActive: true, poseLine: 0.5, poseTorso: 0.3 });
  check("a TOPS try-on guards the lower body", top.api.guardedRegion() === "lower");
  check("a BOTTOMS try-on guards the upper body", bot.api.guardedRegion() === "upper");

  const tb = top.api.guardBand(1000), bb = bot.api.guardBand(1000);
  check("the tops band runs from the boundary to the BOTTOM of the frame",
    tb.y1 === 1000 && tb.y0 > 0, JSON.stringify(tb));
  check("the bottoms band runs from the TOP of the frame to the boundary",
    bb.y0 === 0 && bb.y1 < 1000, JSON.stringify(bb));

  /* THE MARGIN ALWAYS PUSHES AWAY FROM WHAT IS BEING FITTED: down for tops so a long shirt
     hem is never clipped, up for bottoms so a high waistband is not. Same hip line, margins
     in opposite directions - which is the whole reason it is signed rather than absolute. */
  const margin = 0.3 * CONFIG.BODY_GUARD_MARGIN_FRAC;
  check("...pushed BELOW the hips for tops",
    tb.y0 === Math.round(1000 * (0.5 + margin)), `${tb.y0} vs ${Math.round(1000 * (0.5 + margin))}`);
  check("...and ABOVE the hips for bottoms",
    bb.y1 === Math.round(1000 * (0.5 - margin)), `${bb.y1} vs ${Math.round(1000 * (0.5 - margin))}`);
}

console.log("\n── §8 THE BOUNDARY: pose first, documented fallback second ──");
{
  const posed = harness({ enabled: true, poseLine: 0.62, poseTorso: 0.25 });
  check("with a hip line available the band is sourced from POSE",
    posed.api.guardBand(1000).source === "pose");

  const fell = harness({ enabled: true, frac: 0.34, poseLine: null });
  const fb = fell.api.guardBand(1000);
  check("with no hip line it falls back to the static fraction",
    fb.source === "fraction" && fb.y0 === 660 && fb.y1 === 1000, JSON.stringify(fb));

  /* THE FALLBACK IS LOWER-BODY ONLY. It only ever described one band; inverting that number
     for an upper-body guard would be a guess about a guess, so a bottoms session with no
     pose reading guards NOTHING rather than guessing. */
  const botFell = harness({ enabled: true, bottomsActive: true, poseLine: null });
  check("a BOTTOMS session with no pose reading guards nothing rather than guessing",
    botFell.api.guardBand(1000) === null,
    "inverting a number calibrated for the other half of the body is a guess about a guess");

  /* SOURCE AND DESTINATION BANDS ARE COMPUTED FROM THEIR OWN SURFACE'S HEIGHT. The recorder
     sizes to #aiVideo and the frozen frame to whatever Decart returned, so reusing one
     offset misaligns the band on any surface whose resolution differs from the other's. */
  const mixed = harness({ enabled: true, aiH: 1000, throttleH: 500, poseLine: 0.5, poseTorso: 0 });
  mixed.api.startLowerBodyGuard();
  mixed.rafCalls[0].cb();
  const d = draws(mixed);
  check("the SOURCE rectangle is a fraction of the source's height, not the destination's",
    d.length > 0 && d.every((c) => c.args[2] + c.args[4] <= 500 + 1),
    JSON.stringify(d.map((c) => [c.args[2], c.args[4]])));
  check("...while the DESTINATION rectangle is a fraction of the destination's",
    d.length > 0 && d.every((c) => c.args[6] + c.args[8] <= 1000 + 1) &&
    d.some((c) => c.args[6] + c.args[8] > 500 + 1),
    JSON.stringify(d.map((c) => [c.args[6], c.args[8]])));
}

console.log("\n── §9 DEFECT 1: THE CALL SITE IS THE FEATURE ──");
{
  /* THIS IS THE SECTION THE WHOLE RESTORE TURNS ON. updateBodyGuardLine() returns silently
     on anything it cannot read - correct behaviour (hold the last good line rather than
     guess), and the reason its misplacement was invisible for three bug reports. It was
     called from armFirstFrameBilling()'s `if (frameTimingDebug)` block against a `result`
     that does not exist there, so it never ran and the guard silently spent every one of
     those reports on the fallback fraction. A unit test of the function alone would have
     passed the entire time. Only the CALL SITE proves the feature. */
  const calls = (APP.match(/^\s*updateBodyGuardLine\(/gm) || []).length;
  check("updateBodyGuardLine has exactly one call site",
    calls === 1, `${calls} call sites`);

  const watcher = APP.slice(
    APP.indexOf("presenceWatcherTimer = setInterval"),
    APP.indexOf("function stopPresenceWatcher"));
  check("...and it is inside the presence watcher's tick, where a real pose result lives",
    /updateBodyGuardLine\(result\)/.test(watcher),
    "the pose loop is the only place `result` exists");

  const billing = APP.slice(
    APP.indexOf("function armFirstFrameBilling"),
    APP.indexOf("FRAME-FREEZE WATCHDOG"));
  check("...and NOT inside armFirstFrameBilling, where it silently did nothing",
    !/updateBodyGuardLine/.test(billing),
    "its old home - a debug block in a function with no pose result in scope");

  /* NOT BEHIND A DEBUG GATE, and not inside either consumer's `if`. The guard must keep
     tracking the body whether or not presence and topology happen to be enabled.
     COMMENTS STRIPPED FIRST: the call site's own comment names the debug block it used to
     live in, so a raw text scan matches the explanation rather than the code. */
  const code_ = watcher.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const before = code_.slice(0, code_.indexOf("updateBodyGuardLine"));
  check("...and it is not nested inside a debug or consumer conditional",
    before.indexOf("updateBodyGuardLine") === -1 &&
    !/if \(frameTimingDebug\)/.test(before) &&
    !/if \(POSE_GATE_ENABLED\)/.test(before) &&
    !/if \(bodyTopology/.test(before),
    "a guard that only tracks when another feature is on is a guard that silently stops");

  /* AND IT ACTUALLY READS THE HIPS when it is handed a real result. */
  const h = harness({ enabled: true });
  const lm = [];
  lm[11] = { x: 0.4, y: 0.30 }; lm[12] = { x: 0.6, y: 0.30 };   // shoulders
  lm[23] = { x: 0.42, y: 0.62 }; lm[24] = { x: 0.58, y: 0.64 }; // hips
  h.api.updateBodyGuardLine({ landmarks: [lm] });
  const s = h.api.state();
  check("a real landmark set sets the hip line to the mean hip Y",
    Math.abs(s.bodyGuardLine - 0.63) < 1e-9, String(s.bodyGuardLine));
  check("...and the torso length to the shoulder-to-hip span",
    Math.abs(s.bodyGuardTorso - 0.33) < 1e-9, String(s.bodyGuardTorso));

  h.api.updateBodyGuardLine(null);
  check("an unreadable frame HOLDS the last good line rather than dropping it",
    Math.abs(h.api.state().bodyGuardLine - 0.63) < 1e-9,
    "dropping to the fraction mid-session would move the seam on a frame the body is still in");
}

console.log("\n── §10 THREE CONSUMERS, ONE HELPER ──");
{
  /* The band arithmetic must not be written out per consumer: the live canvas, the recorder
     and the frozen frame have to agree about which pixels were the shopper's own, or the
     saved clip shows the invented garment the live view was protecting them from. */
  /* The trailing semicolon is what separates the three CALL sites from the one DEFINITION,
     which opens with `{` instead. */
  const sites = (APP.match(/paintGuardBand\(ctx, w, h\);/g) || []).length;
  check("all three consumers call the shared helper with the same signature",
    sites === 3, `${sites} call sites`);
  check("the RECORDER draws the AI frame first, then the guard over it",
    /ctx\.drawImage\(video, 0, 0, w, h\);\s*\n\s*paintGuardBand\(ctx, w, h\);/.test(APP),
    "the feather ramps against whatever is underneath - the AI frame has to be there first");
  check("freezeFinalFrame guards the AI branch only, never the webcam fallback",
    /if \(!mirror\) paintGuardBand\(ctx, w, h\);/.test(APP),
    "the fallback branch is already the raw camera - there is nothing of Decart's to protect from");
  check("...and it does so AFTER the frame is on the canvas",
    APP.indexOf("if (!mirror) paintGuardBand") >
    APP.indexOf("try { ctx.drawImage(src, 0, 0, w, h); }"),
    "a guard painted before the frame would be overwritten by it");
}

console.log("\n── §11 TEARDOWN: stopped on every exit path ──");
{
  const h = harness({ enabled: true });
  h.api.startLowerBodyGuard();
  const handle = h.rafCalls[0].handle;
  h.api.stopLowerBodyGuard();
  check("cancels the scheduled frame by its real handle",
    h.rafCalls.some((c) => c.cancelled === handle), JSON.stringify(h.rafCalls));
  check("removes the CSS gate class",
    h.classList.removed.includes("lower-body-guard-active"));
  check("clears the canvas so no band is left frozen on screen",
    h.canvasCtx.calls.some((c) => c.op === "clearRect"));
  check("resets the calibrated fraction AND the live hip line - a new session, a new body",
    h.api.state().lowerBodyGuardFrac === CONFIG.LOWER_BODY_GUARD_FRAC &&
    h.api.state().bodyGuardLine === null,
    JSON.stringify(h.api.state()));

  h.api.stopLowerBodyGuard();   // idempotent - called from three teardown paths
  check("a second stop() is a safe no-op",
    h.api.state().lowerBodyGuardRAF === null);

  /* EVERY EXIT PATH, asserted in the source: stopLive() and beginFreezeHold() call it at
     their own sites, and teardown() is the authoritative backstop that every path reaches. */
  const stops = (APP.match(/^\s*stopLowerBodyGuard\(\);/gm) || []).length;
  check("three call sites in app.js - the two session ends plus teardown's backstop",
    stops === 3, `${stops} call sites`);
  const teardown = APP.slice(APP.indexOf("function teardown"), APP.indexOf("function teardown") + 3000);
  check("...and teardown() is one of them, so a future exit path is covered by default",
    /stopLowerBodyGuard\(\);/.test(teardown));

  /* THE LOOP CHECKS LIVENESS EVERY FRAME, not just at start - it must stop painting the
     instant the session ends, not ride one more rAF tick into a torn-down state. */
  const dead = harness({ enabled: true, isLiveVal: false });
  dead.api.startLowerBodyGuard();
  dead.rafCalls[0].cb();
  check("a tick that runs after the session died paints nothing but re-arms",
    draws(dead).length === 0 && dead.rafCalls.length === 2,
    JSON.stringify(dead.canvasCtx.calls.map((c) => c.op)));
}

console.log("\n── §12 CALIBRATION: refines the FALLBACK, never the pose line ──");
{
  const faces = [{ boundingBox: { y: 20, height: 40 } }];   // on a 256-tall scratch canvas
  const h = harness({
    enabled: true, autoCalibrate: true, faceDetectorAvailable: true, faces,
    webcamW: 1000, webcamH: 1000, headToWaistUnits: 3.8,
  });
  await h.api.calibrateLowerBodyGuard();
  /* faceTop 20/256 = 0.078, faceHeight 40/256 = 0.156, waist = 0.078 + 0.156*3.8 = 0.672,
     so the guarded fraction from the bottom is 1 - 0.672 = 0.328. */
  check("a detected face moves the fallback fraction to the derived waist line",
    Math.abs(h.api.state().lowerBodyGuardFrac - 0.328) < 0.005,
    String(h.api.state().lowerBodyGuardFrac));
  check("...and it ran exactly one detection, not one per frame",
    h.detectCalls() === 1, String(h.detectCalls()));

  const none = harness({ enabled: true, autoCalibrate: true, faceDetectorAvailable: true, faces: [] });
  await none.api.calibrateLowerBodyGuard();
  check("no face found leaves the static fraction untouched",
    none.api.state().lowerBodyGuardFrac === CONFIG.LOWER_BODY_GUARD_FRAC);

  const absent = harness({ enabled: true, autoCalibrate: true, faceDetectorAvailable: false });
  await absent.api.calibrateLowerBodyGuard();
  check("no FaceDetector in the browser degrades silently to the static fraction",
    absent.api.state().lowerBodyGuardFrac === CONFIG.LOWER_BODY_GUARD_FRAC);

  const wild = harness({
    enabled: true, autoCalibrate: true, faceDetectorAvailable: true,
    faces: [{ boundingBox: { y: 2, height: 3 } }],   // a face in a photo on the wall
  });
  await wild.api.calibrateLowerBodyGuard();
  const f = wild.api.state().lowerBodyGuardFrac;
  check("a spurious tiny detection is clamped, never trusted outright",
    f >= 0.15 && f <= 0.55, String(f));

  /* THE POSE LINE OUTRANKS IT. Calibration only ever refines the fallback - if it could
     move the pose-derived boundary, a stale face reading would drag the seam off the body
     it was measured from. */
  const both = harness({
    enabled: true, autoCalibrate: true, faceDetectorAvailable: true, faces,
    poseLine: 0.5, poseTorso: 0,
  });
  await both.api.calibrateLowerBodyGuard();
  check("with a hip line present, the band still comes from POSE after calibration",
    both.api.guardBand(1000).source === "pose" && both.api.guardBand(1000).y0 === 500,
    JSON.stringify(both.api.guardBand(1000)));
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
