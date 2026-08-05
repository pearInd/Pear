/* =============================================================================
   PEAR - camera pre-flight quality gates + calibration harness
   -----------------------------------------------------------------------------
   Extracted from app.js while decomposing that monolith. This subsystem went
   first because it is a genuine LEAF: it reads pixels from a <video> and returns
   a verdict, touching none of app.js's shared session state (no localStream,
   connState, activeItem, rtClient) and nothing in the locked FRONT|BACK detection
   or composite path.

   BOTH pre-flight gates now live here:
     • the BLUR / OVER-EXPOSURE gate  - cameraQualityIssue(), 256×144 centre-crop
       Laplacian probe.
     • the BLACK-SCREEN gate          - cameraLooksBlack(), 64×36 luma probe.
   They were split across two files only by extraction order, which was not a
   design: goLive() races them together in one Promise.all, they share the same
   fail-open contract and the same best-of-N sampling shape, and they are the same
   decision ("is this feed worth billing for?"). Keeping them together is what
   makes that decision readable in one place; a second near-identical module would
   have been file sprawl, not modularity.

   Couplings parameterised rather than carried across:
     • the <video> element - passed in as a getVideo() thunk, so this module never
       reaches into app.js's DOM helper, and the per-sample re-read that the
       originals did is preserved exactly.
     • the debug flag - passed in as a boolean, so statsDebugEnabled() (which also
       drives the WebRTC stats monitor) stays in app.js where its other caller is.

   Everything else is self-contained: both probe canvases, the thresholds, the ring
   buffer and the calibration maths.
   ============================================================================= */
"use strict";

/* ── Blur / over-exposure gate (credit saver, sibling of the black-screen gate) ──
   A black feed is not the only way to burn CREDITS_PER_SESSION for nothing: an
   out-of-focus, smeared or blown-out frame produces a render the shopper will just
   discard. Both are cheap to detect locally, so both are checked BEFORE the token
   mint - see cameraQualityIssue().

   WHY A SEPARATE, LARGER PROBE THAN sampleVideoLuma():
   sampleVideoLuma() samples at 64×36, which is correct for a luma question (a mean
   survives any downscale) but USELESS for a sharpness question. Blur is defined by
   the loss of high-frequency detail, and downscaling to 64×36 is itself an aggressive
   low-pass filter - it destroys precisely the signal we want to measure, so a tack-sharp
   frame and a badly defocused one score nearly the same there. Sharpness therefore gets
   its own CAMERA_PROBE_W×CAMERA_PROBE_H probe. 256×144 is 16:9 (matching LIVE_W/LIVE_H,
   so the probe sees the same framing Decart will) and ~37k pixels, which a two-pass
   scan clears in well under a millisecond.

   WHY A CENTRE CROP:
   The gate cares whether THE SHOPPER is sharp, not the room. A flat painted wall has
   almost no high-frequency content, so including the full frame drags the variance
   toward the background and would fail a sharp user standing against a plain wall.
   The crop below keeps the central torso band - where the garment will be rendered -
   and discards the frame edges.

   METRIC - variance of the 3×3 Laplacian over the cropped grayscale probe. The
   Laplacian is a second-derivative (edge) operator: a sharp frame has many strong
   edges and therefore a wide spread of responses, a blurred one has weak responses
   clustered near zero. Variance of that response is the standard single-number
   summary and needs no reference frame to compare against.

   ON CAMERA_BLUR_VAR_MIN - this threshold is sensor- and scene-dependent and is
   deliberately set PERMISSIVE (it catches a smeared lens or a badly defocused frame,
   not a merely soft one). The cost asymmetry drives that choice: a false block costs
   a real customer their try-on, a false pass costs 10 credits. Tune it upward from
   real device data rather than by guessing - enable the stats debug flag (see
   statsDebugEnabled()) and cameraQualityIssue() will log the measured lapVar of every
   sample, plus leave the last reading on window.__pearFrameQuality. */
export const CAMERA_PROBE_W          = 256;    // sharpness probe width  (16:9, mirrors LIVE_W/LIVE_H framing)
export const CAMERA_PROBE_H          = 144;    // sharpness probe height
export const CAMERA_CROP_FRAC_W      = 0.56;   // centre crop width  as a fraction of the source frame
export const CAMERA_CROP_TOP_FRAC    = 0.22;   // crop starts below the head - the torso is what gets dressed
export const CAMERA_CROP_BOT_FRAC    = 0.86;   // ...and ends above the lower frame edge
export const CAMERA_BLUR_VAR_MIN     = 8;      // Laplacian variance below this ⇒ out of focus / smeared
export const CAMERA_CLIP_LUMA_CUT    = 250;    // a pixel counts as "blown out" at/above this luma
export const CAMERA_OVEREXPOSED_FRAC = 0.60;   // ≥ 60% blown-out pixels ⇒ unusable white-out
export const CAMERA_OVEREXPOSED_AVG  = 243;    // ...or a mean luma this high ⇒ same verdict
export const CAMERA_BLUR_SAMPLES     = 5;      // frames to sample before judging (keep the BEST one)
export const CAMERA_BLUR_SAMPLE_MS   = 70;     // gap between samples - spans ~280ms, enough for an autofocus sweep


/* Reusable backing canvas for the sharpness probe. cameraQualityIssue() samples
   CAMERA_BLUR_SAMPLES times per go-live, and a 256×144 canvas carries a ~147KB pixel
   buffer, so allocating one per sample would churn ~735KB of short-lived backing store
   on every attempt. One lazily-created canvas is reused instead - safe because each
   sample is fully synchronous from drawImage() to getImageData(), so two samples can
   never interleave on it. */
let _probeCanvas = null;
export function probeCtx() {
  if (!_probeCanvas) {
    _probeCanvas = document.createElement("canvas");
    _probeCanvas.width  = CAMERA_PROBE_W;
    _probeCanvas.height = CAMERA_PROBE_H;
  }
  return _probeCanvas.getContext("2d", { willReadFrequently: true });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Frame-quality CALIBRATION HARNESS
   ───────────────────────────────────────────────────────────────────────────────
   CAMERA_BLUR_VAR_MIN shipped as a deliberately permissive placeholder because a
   Laplacian-variance cutoff is sensor- and scene-dependent and cannot be derived from
   first principles. Picking the real number needs measurements from the actual target
   phones - and the logging that existed could not produce them: it console.logged each
   sample and kept only the LAST reading on window.__pearFrameQuality. Calibrating from
   that means scraping console text off a phone by hand, with no record of which readings
   were a genuinely sharp shopper and which were a deliberately blurred one.

   This is the missing half. A labelled ring buffer + a summary that reports whether the
   two classes actually SEPARATE, which is the real question - a threshold is only
   meaningful if sharp and blurry frames occupy non-overlapping ranges on the metric. If
   they overlap, the honest answer is "this metric does not discriminate on this device",
   and suggest() says so rather than inventing a cutoff that splits the difference.

   COST WHEN OFF: nothing. The buffer is allocated on first use and recording is gated on
   statsDebugEnabled(), so a production shopper allocates zero bytes here. When ON, the
   slots are pre-built once and overwritten in place - no per-sample allocation, matching
   the probe-canvas discipline.

   USE (on the device, with ?debugFrameStats=1 in the URL):
     __pearFrameStats.label("sharp")    → tag what follows; go live a few times, well lit
     __pearFrameStats.label("blurry")   → smear the lens / defocus; go live a few more
     __pearFrameStats.suggest()         → per-metric separation + a proposed threshold
     __pearFrameStats.export()          → JSON to copy off the device
   ═══════════════════════════════════════════════════════════════════════════════ */
export const FRAME_STATS_MAX = 240;         // ~48 go-live attempts at CAMERA_BLUR_SAMPLES each
let _frameStats = null;

export function frameStatsStore() {
  if (_frameStats) return _frameStats;
  const slots = new Array(FRAME_STATS_MAX);
  for (let i = 0; i < FRAME_STATS_MAX; i++) {
    slots[i] = { ts: 0, label: null, sample: 0, lapVar: 0, lapVarNorm: 0, avgLuma: 0, clipFrac: 0, issue: null };
  }
  _frameStats = { slots, len: 0, next: 0, label: null };
  return _frameStats;
}

/** Write one probe reading into the ring, overwriting the oldest slot in place. */
export function recordFrameStat(s, sampleIdx, issue) {
  const st = frameStatsStore();
  const slot = st.slots[st.next];
  slot.ts = Date.now();
  slot.label = st.label;
  slot.sample = sampleIdx;
  slot.lapVar = s.lapVar;
  slot.lapVarNorm = s.lapVarNorm;
  slot.avgLuma = s.avgLuma;
  slot.clipFrac = s.clipFrac;
  slot.issue = issue;
  st.next = (st.next + 1) % FRAME_STATS_MAX;
  if (st.len < FRAME_STATS_MAX) st.len++;
}

/** Readings oldest-first. Returns copies so a caller cannot mutate the live ring. */
export function frameStatsAll() {
  const st = _frameStats;
  if (!st || !st.len) return [];
  const start = st.len < FRAME_STATS_MAX ? 0 : st.next;
  const out = [];
  for (let i = 0; i < st.len; i++) out.push({ ...st.slots[(start + i) % FRAME_STATS_MAX] });
  return out;
}

/** Percentile of a numeric array, nearest-rank. */
export function pctl(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function frameStatsSummary() {
  const rows = frameStatsAll();
  const byLabel = new Map();
  for (const r of rows) {
    const k = r.label || "(unlabelled)";
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k).push(r);
  }
  const out = [];
  for (const [label, rs] of byLabel) {
    for (const metric of ["lapVar", "lapVarNorm"]) {
      const v = rs.map((r) => r[metric]).sort((a, b) => a - b);
      out.push({
        label, metric, n: v.length,
        min: +v[0].toFixed(3), p05: +pctl(v, 0.05).toFixed(3), median: +pctl(v, 0.5).toFixed(3),
        p95: +pctl(v, 0.95).toFixed(3), max: +v[v.length - 1].toFixed(3),
      });
    }
  }
  return out;
}

/* Propose a cutoff from labelled data - or refuse to.
   A usable threshold needs the SHARP class's low tail to sit above the BLURRY class's high
   tail. p05(sharp) vs p95(blurry) rather than min/max: one autofocus-sweep frame inside a
   "sharp" capture would otherwise veto an otherwise clean separation, and best-of-N sampling
   already tolerates a stray bad frame at runtime.
   The suggestion is the GEOMETRIC mean of the two tails, not the arithmetic one - Laplacian
   variance spans orders of magnitude, so the midpoint of 3 and 300 should be ~30, not ~150.
   Both metrics are reported so the more separable one can be chosen: raw lapVar tracks
   contrast (and so drifts with room lighting), lapVarNorm divides it out. */
export function frameStatsSuggest() {
  const rows = frameStatsAll();
  const sharp = rows.filter((r) => /sharp|good|ok/i.test(r.label || ""));
  const blurry = rows.filter((r) => /blur|soft|bad/i.test(r.label || ""));
  if (!sharp.length || !blurry.length) {
    return { ok: false, reason: `need BOTH labelled classes - have sharp=${sharp.length}, blurry=${blurry.length}. ` +
      `Use __pearFrameStats.label("sharp") / label("blurry") before capturing.` };
  }
  const out = { ok: true, current: { CAMERA_BLUR_VAR_MIN }, metrics: [] };
  for (const metric of ["lapVar", "lapVarNorm"]) {
    const s = sharp.map((r) => r[metric]).sort((a, b) => a - b);
    const b = blurry.map((r) => r[metric]).sort((a, b) => a - b);
    const sharpLow = pctl(s, 0.05), blurryHigh = pctl(b, 0.95);
    const separated = sharpLow > blurryHigh;
    out.metrics.push({
      metric, nSharp: s.length, nBlurry: b.length,
      sharpP05: +sharpLow.toFixed(3), blurryP95: +blurryHigh.toFixed(3),
      separated,
      /* Ratio, not difference - it is scale-free, so the two metrics can be compared
         against each other directly even though they live on different scales. */
      marginRatio: blurryHigh > 0 ? +(sharpLow / blurryHigh).toFixed(2) : Infinity,
      suggested: separated ? +Math.sqrt(Math.max(sharpLow * blurryHigh, 0)).toFixed(3) : null,
    });
  }
  const best = out.metrics.filter((m) => m.separated).sort((a, b) => b.marginRatio - a.marginRatio)[0];
  out.recommendation = best
    ? `Use ${best.metric} with a cutoff of ${best.suggested} (sharp p05 ${best.sharpP05} vs blurry p95 ` +
      `${best.blurryP95}, ${best.marginRatio}× margin).` +
      (best.metric === "lapVarNorm" ? " NOTE: gating currently reads lapVar - switching metrics is a code change, not just a constant." : "")
    : "NEITHER metric separates these two classes on this device. Do NOT set a threshold from this data - " +
      "collect more samples, or accept that blur gating is not reliable here and leave the gate permissive.";
  return out;
}

/* Installed unconditionally - it is a handful of closures, and the ring buffer behind them
   stays unallocated until something actually calls in. */
try {
  window.__pearFrameStats = {
    label: (t) => { frameStatsStore().label = t || null; return `labelling as: ${t || "(none)"}`; },
    all: frameStatsAll,
    summary: frameStatsSummary,
    suggest: frameStatsSuggest,
    export: () => JSON.stringify(frameStatsAll()),
    clear: () => { _frameStats = null; return "frame stats cleared"; },
  };
} catch (_) {}

/* Sample ONE frame of a <video> into the centre-crop probe and measure focus + exposure.
   Returns { ready, lapVar, lapVarNorm, avgLuma, clipFrac }:
     • ready=false  → no decoded frame yet (videoWidth 0 / not paintable), or the probe
                      threw - caller must treat this as "can't judge", never as a fault.
     • lapVar       → variance of the 3×3 Laplacian across the crop. THE focus metric.
     • lapVarNorm   → lapVar normalised by the crop's own luma variance. Not gated on,
                      but logged: it is far less sensitive to lighting and contrast than
                      raw lapVar, so it is the better signal to tune future thresholds
                      against once real device numbers exist.
     • avgLuma      → mean Rec.601 luma across the crop (0-255).
     • clipFrac     → fraction of pixels at/above CAMERA_CLIP_LUMA_CUT (blown out).
   Never throws: any unexpected error fails OPEN so a probe bug can never block a
   paying user out of a session. */
export function sampleVideoSharpness(v) {
  const FAILED = { ready: false, lapVar: 0, lapVarNorm: 0, avgLuma: 0, clipFrac: 0 };
  if (!v || !v.videoWidth || !v.videoHeight) return FAILED;
  try {
    const W = CAMERA_PROBE_W, H = CAMERA_PROBE_H;

    /* Centre crop in SOURCE pixels. The 9-argument drawImage does the crop and the
       downscale in one blit, so no intermediate full-size canvas is ever allocated. */
    const sw = Math.max(1, Math.round(v.videoWidth * CAMERA_CROP_FRAC_W));
    const sx = Math.round((v.videoWidth - sw) / 2);
    const sy = Math.round(v.videoHeight * CAMERA_CROP_TOP_FRAC);
    const sh = Math.max(1, Math.round(v.videoHeight * (CAMERA_CROP_BOT_FRAC - CAMERA_CROP_TOP_FRAC)));

    const ctx = probeCtx();
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    if (!data || data.length < W * H * 4) return FAILED;

    // Pass 1 - grayscale + exposure stats. Float32Array keeps the Laplacian pass
    // cache-friendly and avoids re-doing the Rec.601 weighting per neighbour.
    const gray = new Float32Array(W * H);
    let lumaSum = 0, lumaSqSum = 0, clipped = 0;
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
      const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      gray[p] = g;
      lumaSum += g;
      lumaSqSum += g * g;
      if (g >= CAMERA_CLIP_LUMA_CUT) clipped++;
    }
    const n = gray.length;
    const avgLuma = lumaSum / n;
    const lumaVar = Math.max(0, lumaSqSum / n - avgLuma * avgLuma);

    /* Pass 2 - 3×3 Laplacian  [0 1 0 / 1 -4 1 / 0 1 0]  over INTERIOR pixels only, so
       the frame border never contributes a phantom edge. Variance is computed from the
       running sum/sum-of-squares (E[x²] - E[x]²) in the same pass - the response mean
       is near zero but not exactly, so it is carried properly rather than assumed. */
    let lapSum = 0, lapSqSum = 0;
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const p = row + x;
        const r = gray[p - W] + gray[p + W] + gray[p - 1] + gray[p + 1] - 4 * gray[p];
        lapSum += r;
        lapSqSum += r * r;
      }
    }
    const m = (W - 2) * (H - 2);
    const lapMean = lapSum / m;
    const lapVar = Math.max(0, lapSqSum / m - lapMean * lapMean);

    return {
      ready: true,
      lapVar,
      lapVarNorm: lapVar / (lumaVar + 1),   // +1 guards a perfectly flat crop
      avgLuma,
      clipFrac: clipped / n,
    };
  } catch (_) {
    return FAILED;   // fail open - never block on a probe error
  }
}

/* Focus / exposure verdict for the CREDIT-SAVING gate in goLive(). Sends nothing to any
   API - it only inspects local webcam pixels. Returns null when the feed is fine, or
   "blurry" / "overexposed" naming the reason to show the shopper.

   Samples CAMERA_BLUR_SAMPLES frames spaced by CAMERA_BLUR_SAMPLE_MS and reduces each
   metric to its MOST FAVOURABLE value across the batch - sharpest lapVar, darkest
   avgLuma/clipFrac. A phone hunting for focus, or an auto-exposure sweep right after
   play(), routinely emits one bad frame; requiring EVERY sample to be bad means only a
   persistently bad feed is blocked. If no sample ever decoded we return null (fail open
   - the connect path's FIRST_FRAME_TIMEOUT_MS already guards a truly dead camera).

   @param {object}   opts
   @param {function} opts.getVideo  returns the <video> to sample. A thunk rather than the
     element itself so the per-sample re-read of the original is preserved exactly - the
     element is looked up fresh on every tick, not captured once at call time.
   @param {boolean}  opts.debug     whether to ring-buffer and log each sample. Passed in
     rather than read here so statsDebugEnabled() can stay in app.js with its other caller.
   @returns {Promise<null|"blurry"|"overexposed">} */
export async function cameraQualityIssue({ getVideo, debug = false } = {}) {
  let sawFrame = false;
  let bestLapVar = -1;      // sharpest sample seen
  let bestNorm = 0;         // ...and its normalised twin, for the debug log
  let lowestAvgLuma = 255;  // darkest sample seen (most favourable for over-exposure)
  let lowestClipFrac = 1;

  for (let i = 0; i < CAMERA_BLUR_SAMPLES; i++) {
    const s = sampleVideoSharpness(typeof getVideo === "function" ? getVideo() : null);
    if (s.ready) {
      sawFrame = true;
      if (s.lapVar > bestLapVar) { bestLapVar = s.lapVar; bestNorm = s.lapVarNorm; }
      if (s.avgLuma < lowestAvgLuma) lowestAvgLuma = s.avgLuma;
      if (s.clipFrac < lowestClipFrac) lowestClipFrac = s.clipFrac;
      if (debug) {
        // Ring-buffered for calibration; the log line stays for live watching.
        recordFrameStat(s, i + 1, null);
        console.log("[PEAR][frame-quality] sample " + (i + 1) + "/" + CAMERA_BLUR_SAMPLES +
          " lapVar=" + s.lapVar.toFixed(1) + " norm=" + s.lapVarNorm.toFixed(3) +
          " avgLuma=" + s.avgLuma.toFixed(1) + " clipFrac=" + s.clipFrac.toFixed(3));
      }
    }
    if (i < CAMERA_BLUR_SAMPLES - 1) {
      await new Promise((r) => setTimeout(r, CAMERA_BLUR_SAMPLE_MS));
    }
  }

  if (!sawFrame) return null;   // couldn't judge → don't block here

  const overexposed = lowestClipFrac >= CAMERA_OVEREXPOSED_FRAC || lowestAvgLuma >= CAMERA_OVEREXPOSED_AVG;
  const blurry = bestLapVar < CAMERA_BLUR_VAR_MIN;
  const issue = overexposed ? "overexposed" : (blurry ? "blurry" : null);

  /* Always parked on window for support/tuning - one object, overwritten per attempt,
     so it costs nothing and turns "it refused to start" into a one-line console answer. */
  try {
    window.__pearFrameQuality = { lapVar: bestLapVar, lapVarNorm: bestNorm, avgLuma: lowestAvgLuma,
                                  clipFrac: lowestClipFrac, issue, ts: Date.now() };
  } catch (_) {}

  if (issue) {
    console.warn("[PEAR] Frame-quality gate tripped (" + issue + ") - skipping billed session " +
      "(lapVar=" + bestLapVar.toFixed(1) + " vs min " + CAMERA_BLUR_VAR_MIN +
      ", avgLuma=" + lowestAvgLuma.toFixed(1) + ", clipFrac=" + lowestClipFrac.toFixed(3) + ")");
  }
  return issue;
}


/* ── Black-screen / camera-off gate (credit saver) ───────────────────────────
   Before we mint a token or open the billed Decart session, we sample the LOCAL
   webcam and refuse to go live if it's a black screen (lens covered, camera off,
   privacy shutter, or a stream that only ever produces black frames). Streaming a
   black feed to Decart still burns the full CREDITS_PER_SESSION for zero usable
   render, so this pays for itself the first time a user forgets to uncover the lens.

   Two independent signals, sampled from a tiny downscaled canvas (cheap, runs in a
   few ms). A frame is judged "black" if EITHER holds - both thresholds are extreme
   enough that even a dim, poorly-lit but genuinely open camera clears them, so we
   don't false-block a paying user:
     • CAMERA_BLACK_AVG_LUMA   - mean Rec.601 luma (0-255) at/below this ⇒ effectively black.
     • CAMERA_BLACK_PIXEL_FRAC - fraction of near-black pixels at/above this ⇒ covered/off.
   We take the BRIGHTEST of a few spaced samples (auto-exposure warm-up can emit a
   transient black frame right after play()), so only a persistently black feed blocks. */
export const CAMERA_BLACK_AVG_LUMA   = 12;     // mean luma ≤ 12/255 ⇒ black feed
export const CAMERA_BLACK_PIXEL_CUT  = 16;     // a pixel counts as "near-black" when its luma < this
export const CAMERA_BLACK_PIXEL_FRAC = 0.985;  // ≥ 98.5% near-black pixels ⇒ covered lens / camera off
export const CAMERA_BLACK_SAMPLES    = 5;      // frames to sample before judging (keep the brightest)
export const CAMERA_BLACK_SAMPLE_MS  = 60;     // gap between samples - spans ~300ms of exposure warm-up

/* Reusable backing canvas for the luma probe. The original created a fresh 64×36 canvas
   on EVERY call - ~9KB of backing store per sample, and cameraLooksBlack() takes
   CAMERA_BLACK_SAMPLES of them per go-live on top of armFirstFrameBilling()'s own polling
   of the remote track. Small individually, but it is the same needless-allocation pattern
   as the old full-size backdrop probe, so it gets the same treatment on the way across.
   Separate from _probeCanvas because the two probes are different sizes and a shared
   canvas would have to be resized per call - which reallocates the backing store anyway
   and would defeat the point. Safe to share across BOTH callers (#webcam and #aiVideo):
   each sample runs synchronously from drawImage() to getImageData(), so two can never
   interleave on it. */
const LUMA_PROBE_W = 64, LUMA_PROBE_H = 36;   // cheap, and a mean survives any downscale
let _lumaCanvas = null;
function lumaCtx() {
  if (!_lumaCanvas) {
    _lumaCanvas = document.createElement("canvas");
    _lumaCanvas.width  = LUMA_PROBE_W;
    _lumaCanvas.height = LUMA_PROBE_H;
  }
  return _lumaCanvas.getContext("2d", { willReadFrequently: true });
}

/* Sample ONE frame of ANY <video> element into a tiny downscaled canvas and measure
   how dark it is. Returns { ready, avgLuma, blackFrac }:
     • ready=false  → no decoded frame yet (videoWidth 0 / not paintable) - caller
                      must NOT treat this as black, only as "can't judge yet".
     • avgLuma      → mean Rec.601 luma across the frame (0-255).
     • blackFrac    → fraction of pixels below CAMERA_BLACK_PIXEL_CUT (near-black).
   Same-origin MediaStream pixels are not tainted, so getImageData never throws for
   security; any unexpected error still fails OPEN (ready=false) so we never wrongly
   block a paying user. 64×36 keeps this well under a millisecond.
   Shared by two callers: cameraLooksBlack() (local #webcam, the credit-saving gate)
   and armFirstFrameBilling() in app.js (remote #aiVideo, verifying the first real AI
   frame) - which is why it takes the element directly rather than a thunk. */
export function sampleVideoLuma(v) {
  if (!v || !v.videoWidth || !v.videoHeight) return { ready: false, avgLuma: 0, blackFrac: 1 };
  try {
    const cw = LUMA_PROBE_W, ch = LUMA_PROBE_H;
    const ctx = lumaCtx();
    ctx.drawImage(v, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const total = cw * ch;
    let sum = 0, black = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Rec.601 luma - matches how "brightness" reads to the human eye.
      const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      sum += luma;
      if (luma < CAMERA_BLACK_PIXEL_CUT) black++;
    }
    return { ready: true, avgLuma: sum / total, blackFrac: black / total };
  } catch (_) {
    return { ready: false, avgLuma: 0, blackFrac: 1 };   // fail open - never block on a probe error
  }
}

/* Black-screen / camera-off verdict for the CREDIT-SAVING gate in goLive().
   Sends nothing to any API - it only inspects local webcam pixels. Samples a few
   frames (CAMERA_BLACK_SAMPLES) spaced by CAMERA_BLACK_SAMPLE_MS and keeps the
   BRIGHTEST one, so a single transient black frame during auto-exposure warm-up
   doesn't trip the gate - only a persistently black feed does.
   Returns true ONLY when we have a real, paintable frame that is black; if we never
   get a decodable frame we return false (fail open - let the normal connect path and
   its FIRST_FRAME_TIMEOUT_MS safety net handle a truly dead camera).

   @param {object}   opts
   @param {function} opts.getVideo  returns the <video> to sample, re-read per sample -
     same thunk contract as cameraQualityIssue(), so goLive() passes both gates the
     same shape.
   @returns {Promise<boolean>} */
export async function cameraLooksBlack({ getVideo } = {}) {
  let sawFrame = false;
  let bestLuma = -1;          // brightest mean luma seen
  let bestBlackFrac = 1;      // lowest near-black fraction seen (from the brightest frame)
  for (let i = 0; i < CAMERA_BLACK_SAMPLES; i++) {
    const s = sampleVideoLuma(typeof getVideo === "function" ? getVideo() : null);
    if (s.ready) {
      sawFrame = true;
      if (s.avgLuma > bestLuma) { bestLuma = s.avgLuma; bestBlackFrac = s.blackFrac; }
    }
    if (i < CAMERA_BLACK_SAMPLES - 1) {
      await new Promise((r) => setTimeout(r, CAMERA_BLACK_SAMPLE_MS));
    }
  }
  if (!sawFrame) return false;   // couldn't judge → don't block here; connect path guards a dead camera
  const isBlack = bestLuma <= CAMERA_BLACK_AVG_LUMA || bestBlackFrac >= CAMERA_BLACK_PIXEL_FRAC;
  if (isBlack) {
    console.warn("[PEAR] Black-screen gate tripped - skipping billed session " +
      "(avgLuma=" + bestLuma.toFixed(1) + " ≤ " + CAMERA_BLACK_AVG_LUMA +
      " or blackFrac=" + bestBlackFrac.toFixed(3) + " ≥ " + CAMERA_BLACK_PIXEL_FRAC + ")");
  }
  return isBlack;
}
