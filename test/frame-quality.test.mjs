/* Frame-quality credit gate - sampleVideoSharpness() + cameraQualityIssue()
   (fitting-room/frame-quality.js).

   These guard a BILLED action: a wrong "blurry" verdict costs a real customer their
   try-on, a missed one costs CREDITS_PER_SESSION. Both functions are browser-only
   (Canvas + <video>), so they run here against jsdom globals and synthetic pixel buffers
   whose sharpness we control exactly - which is what lets us assert the metric's
   DIRECTION and the fail-open contract rather than guessing at real camera numbers.

   Now imports the real module rather than regex-slicing app.js, which is the point of
   having extracted it: the code under test is the code that ships, including its export
   surface and module-level side effects. */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "https://pear.test/fitting-room/" });

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* ── Synthetic frames ────────────────────────────────────────────────────────────
   The probe reads RGBA bytes, so each generator returns a Uint8ClampedArray of the
   probe size. SHARP is a 2px checkerboard: maximum high-frequency content, so the
   Laplacian response is large everywhere. FLAT is uniform mid-grey: zero second
   derivative, so lapVar must be ~0 - that is a blurred/defocused frame's limit case. */
const PW = 256, PH = 144;
function buildFrame(fill) {
  const buf = new Uint8ClampedArray(PW * PH * 4);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const i = (y * PW + x) * 4;
      const v = fill(x, y);
      buf[i] = buf[i + 1] = buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}
const FRAMES = {
  sharp:      buildFrame((x, y) => ((x >> 1) + (y >> 1)) % 2 ? 235 : 20),
  flat:       buildFrame(() => 128),
  soft:       buildFrame((x, y) => 128 + 6 * Math.sin(x / 9) * Math.cos(y / 9)),  // low-contrast ripple
  white:      buildFrame(() => 255),
  darkSharp:  buildFrame((x, y) => ((x >> 1) + (y >> 1)) % 2 ? 60 : 10),
};

/* Canvas stub. Records the drawImage arguments so the centre-crop geometry can be
   asserted, and serves whichever synthetic frame the current test selected. */
let currentFrame = FRAMES.sharp;
let getImageDataThrows = false;
let drawCalls = [];
let createdCanvases = 0;
let getImageDataImpl = null;   // set by the autofocus-sweep cases
const ctxStub = {
  drawImage: (...args) => { drawCalls.push(args); },
  getImageData: () => {
    if (getImageDataThrows) throw new Error("probe boom");
    if (getImageDataImpl) return getImageDataImpl();
    return { data: currentFrame };
  },
};
dom.window.document.createElement = ((orig) => (tag) => {
  if (tag !== "canvas") return orig.call(dom.window.document, tag);
  createdCanvases++;
  return { width: 0, height: 0, getContext: () => ctxStub };
})(dom.window.document.createElement);

/* The module reads `document` and `window` off the global scope and installs
   window.__pearFrameStats at import time, so the globals must exist BEFORE it loads -
   hence the dynamic import below rather than a static one at the top of the file. */
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const M = await import("../fitting-room/frame-quality.js");

// A <video> the probe considers paintable. 1280x720 is a realistic capture size.
const videoEl = { videoWidth: 1280, videoHeight: 720 };
let webcamEl = videoEl;
const opts = () => ({ getVideo: () => webcamEl, debug: false });

/* ── 0. The module's public surface ──────────────────────────────────────────── */
check("module exports the gate entry points",
  typeof M.cameraQualityIssue === "function" && typeof M.sampleVideoSharpness === "function");
check("module exports its thresholds for callers/tests to reason about",
  typeof M.CAMERA_BLUR_VAR_MIN === "number" && typeof M.CAMERA_PROBE_W === "number");
check("importing installs the calibration harness on window",
  !!dom.window.__pearFrameStats && typeof dom.window.__pearFrameStats.suggest === "function");

/* ── 1. The metric points the right way ──────────────────────────────────────── */
currentFrame = FRAMES.sharp;
const sharp = M.sampleVideoSharpness(videoEl);
currentFrame = FRAMES.flat;
const flat = M.sampleVideoSharpness(videoEl);
currentFrame = FRAMES.soft;
const soft = M.sampleVideoSharpness(videoEl);

check("sharp frame reports ready", sharp.ready === true);
check("sharp frame scores far above the blur floor",
  sharp.lapVar > M.CAMERA_BLUR_VAR_MIN * 50, `lapVar=${sharp.lapVar}`);
check("uniform frame has ~zero Laplacian variance",
  flat.lapVar < 1e-6, `lapVar=${flat.lapVar}`);
check("uniform frame is below the blur floor",
  flat.lapVar < M.CAMERA_BLUR_VAR_MIN, `lapVar=${flat.lapVar}`);
check("sharp scores strictly above soft, soft strictly above flat",
  sharp.lapVar > soft.lapVar && soft.lapVar > flat.lapVar,
  `sharp=${sharp.lapVar} soft=${soft.lapVar} flat=${flat.lapVar}`);

/* The normalised metric is the one worth tuning against later, so pin that it actually
   divides out contrast: the same checkerboard at low contrast must score close to the
   bright one normalised, while its RAW lapVar is far lower. */
currentFrame = FRAMES.darkSharp;
const darkSharp = M.sampleVideoSharpness(videoEl);
check("low-contrast sharp frame has much lower RAW lapVar than the bright one",
  darkSharp.lapVar < sharp.lapVar / 4, `dark=${darkSharp.lapVar} bright=${sharp.lapVar}`);
check("...but its NORMALISED score stays within 20% of the bright one",
  Math.abs(darkSharp.lapVarNorm - sharp.lapVarNorm) / sharp.lapVarNorm < 0.2,
  `dark=${darkSharp.lapVarNorm} bright=${sharp.lapVarNorm}`);

/* ── 2. Exposure stats ───────────────────────────────────────────────────────── */
currentFrame = FRAMES.white;
const white = M.sampleVideoSharpness(videoEl);
check("blown-out frame reports clipFrac 1.0", white.clipFrac === 1, `clipFrac=${white.clipFrac}`);
check("blown-out frame reports avgLuma 255", Math.round(white.avgLuma) === 255, `avgLuma=${white.avgLuma}`);
check("mid-grey frame reports no clipping", flat.clipFrac === 0, `clipFrac=${flat.clipFrac}`);

/* ── 3. Centre-crop geometry ─────────────────────────────────────────────────── */
drawCalls = [];
currentFrame = FRAMES.sharp;
M.sampleVideoSharpness(videoEl);
const dc = drawCalls[0] || [];
check("drawImage uses the 9-arg crop form (no intermediate full-size canvas)", dc.length === 9,
  `argc=${dc.length}`);
const [, sx, sy, sw, sh, dx, dy, dw, dh] = dc;
check("crop width is CAMERA_CROP_FRAC_W of the source", sw === Math.round(1280 * M.CAMERA_CROP_FRAC_W),
  `sw=${sw}`);
check("crop is horizontally centred", sx === Math.round((1280 - sw) / 2), `sx=${sx}`);
check("crop starts at CAMERA_CROP_TOP_FRAC (below the head)", sy === Math.round(720 * M.CAMERA_CROP_TOP_FRAC),
  `sy=${sy}`);
check("crop height spans TOP→BOT fraction",
  sh === Math.round(720 * (M.CAMERA_CROP_BOT_FRAC - M.CAMERA_CROP_TOP_FRAC)), `sh=${sh}`);
check("crop stays inside the source frame", sy + sh <= 720 && sx + sw <= 1280, `sy+sh=${sy + sh}`);
check("destination is the full probe canvas", dx === 0 && dy === 0 && dw === M.CAMERA_PROBE_W && dh === M.CAMERA_PROBE_H,
  `dest=${dx},${dy},${dw},${dh}`);

/* ── 4. Probe canvas is reused, not reallocated per sample ───────────────────── */
const canvasesBefore = createdCanvases;
M.sampleVideoSharpness(videoEl);
M.sampleVideoSharpness(videoEl);
M.sampleVideoSharpness(videoEl);
check("repeat samples reuse one canvas (no per-sample backing-store churn)",
  createdCanvases === canvasesBefore, `created ${createdCanvases - canvasesBefore} more`);

/* ── 5. Fail-open contract - a probe that cannot judge must never block ──────── */
check("null video → not ready", M.sampleVideoSharpness(null).ready === false);
check("undecoded video (videoWidth 0) → not ready",
  M.sampleVideoSharpness({ videoWidth: 0, videoHeight: 0 }).ready === false);
getImageDataThrows = true;
const thrown = M.sampleVideoSharpness(videoEl);
getImageDataThrows = false;
check("getImageData throwing → not ready, no exception escapes", thrown.ready === false);

/* ── 6. The verdict, end to end ──────────────────────────────────────────────── */
currentFrame = FRAMES.sharp;
check("sharp feed → no issue, session proceeds", (await M.cameraQualityIssue(opts())) === null);

currentFrame = FRAMES.flat;
check("persistently flat feed → 'blurry'", (await M.cameraQualityIssue(opts())) === "blurry");

currentFrame = FRAMES.white;
check("blown-out feed → 'overexposed'", (await M.cameraQualityIssue(opts())) === "overexposed");

/* Over-exposure outranks blur: a white-out frame is ALSO featureless, so it would trip
   the blur test too. The shopper must be told the actionable thing ("too bright"),
   not sent to clean an already-clean lens. */
check("a white-out reports the exposure cause, not the blur symptom",
  (await M.cameraQualityIssue(opts())) === "overexposed");

/* The getVideo thunk is re-read per sample, not captured once - a camera that becomes
   available mid-batch must still be judged on the frames it did produce. */
check("missing getVideo → fails open rather than throwing",
  (await M.cameraQualityIssue({})) === null);

/* ── 7. best-of-N survives an autofocus sweep ───────────────────────────────── */
/* The real failure this prevents: a phone hunting for focus emits blurred frames and
   ONE sharp one. Requiring every sample to be bad is what keeps that user unblocked. */
let seq = 0;
const sweep = [FRAMES.flat, FRAMES.flat, FRAMES.sharp, FRAMES.flat, FRAMES.flat];
getImageDataImpl = () => ({ data: sweep[Math.min(seq++, sweep.length - 1)] });
seq = 0;
check("one sharp frame among four blurred ones → NOT blocked",
  (await M.cameraQualityIssue(opts())) === null, `sampled ${seq} frames`);
check("all CAMERA_BLUR_SAMPLES frames were actually sampled", seq === M.CAMERA_BLUR_SAMPLES, `seq=${seq}`);

/* Same shape for exposure - one correctly-exposed frame in a glare sweep must pass. */
const glare = [FRAMES.white, FRAMES.white, FRAMES.sharp, FRAMES.white, FRAMES.white];
seq = 0;
getImageDataImpl = () => ({ data: glare[Math.min(seq++, glare.length - 1)] });
check("one well-exposed frame among four blown-out ones → NOT blocked",
  (await M.cameraQualityIssue(opts())) === null);
getImageDataImpl = null;

/* ── 8. No decodable frame at all → fail open ───────────────────────────────── */
webcamEl = null;
check("no webcam element → null (fail open; connect path guards a dead camera)",
  (await M.cameraQualityIssue(opts())) === null);
webcamEl = { videoWidth: 0, videoHeight: 0 };
check("camera present but never decodes → null (fail open)",
  (await M.cameraQualityIssue(opts())) === null);
webcamEl = videoEl;

/* ── 9. Support surface ─────────────────────────────────────────────────────── */
currentFrame = FRAMES.flat;
await M.cameraQualityIssue(opts());
const q = dom.window.__pearFrameQuality;
check("last reading is parked on window.__pearFrameQuality for support", !!q && q.issue === "blurry",
  JSON.stringify(q));
check("...carrying both the raw and normalised metric",
  q && typeof q.lapVar === "number" && typeof q.lapVarNorm === "number", JSON.stringify(q));

/* debug:false must stay silent AND allocation-free - the ring buffer is a calibration
   tool, not something a production shopper pays for. */
dom.window.__pearFrameStats.clear();
await M.cameraQualityIssue({ getVideo: () => videoEl, debug: false });
check("debug:false records nothing into the calibration ring",
  M.frameStatsAll().length === 0, `${M.frameStatsAll().length} rows`);
await M.cameraQualityIssue({ getVideo: () => videoEl, debug: true });
check("debug:true records every sample", M.frameStatsAll().length === M.CAMERA_BLUR_SAMPLES,
  `${M.frameStatsAll().length} rows`);

/* ── 10. The BLACK-SCREEN gate (sampleVideoLuma / cameraLooksBlack) ──────────
   Moved into this module alongside the blur gate; it had no direct coverage before,
   despite guarding the same billed action. The luma probe reads a 64×36 canvas, so the
   synthetic frames above (sized for the 256×144 sharpness probe) are the wrong shape -
   these cases drive the stub with their own uniform buffers, which is all a MEAN needs. */
const lumaFrame = (v) => {
  const buf = new Uint8ClampedArray(64 * 36 * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255; }
  return buf;
};
const blackOpts = (el = videoEl) => ({ getVideo: () => el });

getImageDataImpl = () => ({ data: lumaFrame(0) });
check("a fully black feed trips the gate", (await M.cameraLooksBlack(blackOpts())) === true);

getImageDataImpl = () => ({ data: lumaFrame(140) });
check("a normally-lit feed does not trip the gate", (await M.cameraLooksBlack(blackOpts())) === false);

/* The threshold is deliberately extreme so a dim-but-genuinely-open camera still gets
   through - blocking a paying shopper costs more than a wasted session. */
getImageDataImpl = () => ({ data: lumaFrame(M.CAMERA_BLACK_AVG_LUMA + 8) });
check("a dim but open camera is NOT blocked", (await M.cameraLooksBlack(blackOpts())) === false);

/* Best-of-N keeps the BRIGHTEST sample: auto-exposure warm-up right after play() emits a
   transient black frame, and blocking on that would fail a shopper with a working camera. */
let lumaSeq = 0;
const warmup = [lumaFrame(0), lumaFrame(0), lumaFrame(150), lumaFrame(0), lumaFrame(0)];
getImageDataImpl = () => ({ data: warmup[Math.min(lumaSeq++, warmup.length - 1)] });
check("one lit frame during an exposure warm-up → NOT blocked",
  (await M.cameraLooksBlack(blackOpts())) === false);
check("all CAMERA_BLACK_SAMPLES frames were sampled", lumaSeq === M.CAMERA_BLACK_SAMPLES, `seq=${lumaSeq}`);

// Fail-open, same contract as the blur gate.
getImageDataImpl = null;
check("no video element → false (fail open)", (await M.cameraLooksBlack(blackOpts(null))) === false);
check("missing getVideo → false (fail open)", (await M.cameraLooksBlack({})) === false);
getImageDataThrows = true;
check("a throwing probe → false (fail open, never blocks on a bug)",
  (await M.cameraLooksBlack(blackOpts())) === false);
getImageDataThrows = false;

/* sampleVideoLuma is exported because armFirstFrameBilling() in app.js runs the same
   black test against the REMOTE track - it takes an element directly, not a thunk. */
getImageDataImpl = () => ({ data: lumaFrame(200) });
const lit = M.sampleVideoLuma(videoEl);
check("sampleVideoLuma reports a mean for a lit frame",
  lit.ready === true && Math.round(lit.avgLuma) === 200, JSON.stringify(lit));
check("...and no near-black pixels", lit.blackFrac === 0, String(lit.blackFrac));
getImageDataImpl = () => ({ data: lumaFrame(2) });
const dark = M.sampleVideoLuma(videoEl);
check("sampleVideoLuma reports blackFrac 1.0 for a black frame", dark.blackFrac === 1, String(dark.blackFrac));
check("sampleVideoLuma fails open on an undecoded element",
  M.sampleVideoLuma({ videoWidth: 0, videoHeight: 0 }).ready === false);

/* Same zero-churn discipline as the sharpness probe: the luma canvas is created once. */
getImageDataImpl = () => ({ data: lumaFrame(120) });
const beforeLuma = createdCanvases;
M.sampleVideoLuma(videoEl); M.sampleVideoLuma(videoEl); M.sampleVideoLuma(videoEl);
check("repeat luma samples reuse one canvas (no per-sample churn)",
  createdCanvases === beforeLuma, `created ${createdCanvases - beforeLuma} more`);
getImageDataImpl = null;

console.log("\n" + (fails ? `${fails} check(s) FAILED` : "All frame-quality checks passed."));
process.exit(fails ? 1 : 0);
