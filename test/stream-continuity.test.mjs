/* =============================================================================
   LIVE CONTINUITY - the live view never holds a still
   -----------------------------------------------------------------------------
   REPORTED, with three v136 clips (PEAR-fit-1789417907145/-925378/-953496): "the whole
   app and the camera freeze for 1-2 seconds on every garment or orientation swap".
   Measured: the recorder's samples stay ~33ms apart (the page never stalled), while
   Decart's output repeats one frame pixel-identical for 2.1s / 1.4s / 0.7s at each turn.

   Two local freezes were switched off (front-reference-guard §9, turn-hold DEFAULT). This
   suite pins what replaced them: the live camera cross-fades in over a silent Decart output
   and back out when frames return - and the recorder blends it at the same opacity, so the
   clip moves wherever the view did.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

const constSrc = extract("const LIVE_STALL_REVEAL_MS", "/* Restore seams");
const factorySrc = extract("function makeStreamContinuity(", "let _continuityCanvas = null;");
const K = new Function(constSrc + "\nreturn { LIVE_STALL_REVEAL_MS, LIVE_CONTINUITY_FADE_MS, LIVE_RESUME_FRAMES };")();
const make = (opts) => new Function(constSrc + factorySrc + "\nreturn makeStreamContinuity;")()(opts);

/* Drive the model the way the page does: output frames at their times, a display step every
   ~16.7ms. Returns per-step samples plus every event. */
function run(frameTimes, endMs, { live = () => true, stepMs = 1000 / 60, start = 0 } = {}) {
  const m = make();
  const frames = [...frameTimes].sort((a, b) => a - b);
  const samples = [], events = [];
  let fi = 0;
  for (let t = start; t <= endMs; t += stepMs) {
    while (fi < frames.length && frames[fi] <= t) m.frame(frames[fi++]);
    const { alpha, event } = m.step(t, live(t));
    samples.push({ t, alpha });
    if (event) events.push({ t, ...event });
  }
  return { m, samples, events };
}
const cadence = (from, to, periodMs, jitter = () => 0) => {
  const out = [];
  for (let t = from; t < to; t += periodMs) out.push(t + jitter(t));
  return out;
};
/* The longest stretch a shopper looks at an UNCHANGING picture: time between output frames
   while the camera layer is not at least half up. This is the number the report is about. */
function longestStillOnScreen(frames, samples) {
  const fr = [...frames].sort((a, b) => a - b);
  let worst = 0, since = null, fi = 0;
  for (const s of samples) {
    let fresh = false;
    while (fi < fr.length && fr[fi] <= s.t) { fi++; fresh = true; }
    const camera = s.alpha >= 0.5;
    if (fresh || camera) { since = camera ? null : s.t; continue; }
    if (since === null) since = s.t;
    worst = Math.max(worst, s.t - since);
  }
  return worst;
}

console.log("── §1 NORMAL CADENCE NEVER BRINGS THE CAMERA IN ──");
{
  check("the bar clears the output's own frame period with margin (10fps, ~200ms measured gaps)",
    K.LIVE_STALL_REVEAL_MS >= 300 && K.LIVE_STALL_REVEAL_MS <= 400, String(K.LIVE_STALL_REVEAL_MS));
  /* 10fps with deterministic jitter up to +/-100ms: consecutive gaps reach ~300ms at worst. */
  const jit = (t) => (((t * 7919) % 200) - 100) * 0.95;
  const frames = cadence(0, 5000, 100, jit).filter((t, i, a) => i === 0 || t > a[i - 1]);
  const { samples, events } = run(frames, 5000);
  check("5s of jittery 10fps output: the camera layer never rises",
    samples.every((s) => s.alpha === 0), `max alpha ${Math.max(...samples.map((s) => s.alpha))}`);
  check("...and nothing is logged", events.length === 0, JSON.stringify(events));
}

console.log("\n── §2 A SILENT OUTPUT IS BRIDGED WITH THE LIVE CAMERA, AND FADES BACK ──");
{
  const frames = [...cadence(0, 1000, 100), ...cadence(1700, 3000, 100)];   // clip 3: a 700ms hole
  const { samples, events } = run(frames, 3000);
  const at = (t) => samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best)).alpha;
  check("still invisible just under the bar", at(900 + K.LIVE_STALL_REVEAL_MS - 20) === 0);
  const stall = events.find((e) => e.type === "stall");
  check("the stall is declared once the output has been silent past the bar",
    !!stall && stall.t >= 900 + K.LIVE_STALL_REVEAL_MS && stall.t < 900 + K.LIVE_STALL_REVEAL_MS + 20, JSON.stringify(events));
  check("...and the camera is fully up one fade later",
    at(900 + K.LIVE_STALL_REVEAL_MS + K.LIVE_CONTINUITY_FADE_MS + 20) === 1);
  const resume = events.find((e) => e.type === "resume");
  check("the render is faded back only after LIVE_RESUME_FRAMES consecutive frames (1700, 1800)",
    !!resume && resume.t >= 1800 && resume.t < 1820, JSON.stringify(events));
  check("...one straggler is not enough", at(1750) === 1);
  check("...and the camera is gone one fade after the resume", at(1800 + K.LIVE_CONTINUITY_FADE_MS + 20) === 0);
  check("the fade is a ramp, not a cut", samples.some((s) => s.alpha > 0.2 && s.alpha < 0.8));
}
{
  /* A lone frame in the middle of a stall must not flip the view twice. */
  const frames = [...cadence(0, 1000, 100), 1500, ...cadence(2200, 3000, 100)];
  const { events } = run(frames, 3000);
  const resume = events.find((e) => e.type === "resume");
  check("a straggler followed by another long gap keeps the camera up - no second stall, no flap",
    events.filter((e) => e.type === "stall").length === 1 && events.filter((e) => e.type === "resume").length === 1,
    JSON.stringify(events));
  /* The straggler (1500) must not count toward the resume: the late frame at 2200 starts the run
     over, so the render returns on 2300, not on 2200. */
  check("...and the straggler does not count toward the resume - the long gap starts the run over",
    !!resume && resume.t >= 2300 && resume.t < 2320, JSON.stringify(events));
}

console.log("\n── §3 THE CLIPS' STALLS, REPLAYED: NO STILL LONGER THAN THE BAR ──");
for (const [name, hole] of [["clip 1", 2100], ["clip 2", 1433], ["clip 3", 667]]) {
  const frames = [...cadence(0, 2000, 100), ...cadence(2000 + hole, 5000 + hole, 100)];
  const { samples } = run(frames, 5000 + hole);
  const still = longestStillOnScreen(frames, samples);
  const unbridged = hole + 100;
  check(`${name} (${hole}ms without an output frame): the longest still on screen is ${Math.round(still)}ms, was ${unbridged}ms`,
    still <= K.LIVE_STALL_REVEAL_MS + K.LIVE_CONTINUITY_FADE_MS / 2 + 17, `${Math.round(still)}ms`);
}

console.log("\n── §4 NOT LIVE, OR A BACKGROUNDED TAB, NEVER SHOWS THE CAMERA ──");
{
  const frames = cadence(0, 1000, 100);
  const { samples, events } = run(frames, 3000, { live: (t) => t < 1200 });
  check("once the session is no longer live (result, clip, teardown) the layer is 0 at once",
    samples.filter((s) => s.t >= 1200).every((s) => s.alpha === 0) && events.length === 0, JSON.stringify(events));
}
{
  const m = make();
  for (let t = 0; t <= 1000; t += 100) { m.frame(t); m.step(t, true); }
  const back = m.step(6000, true);       // rAF and rVFC both slept for 5s
  check("a tab returning from the background does not flash the camera over the render",
    back.alpha === 0 && back.event === null, JSON.stringify(back));
  m.frame(6050); m.frame(6150);
  check("...and the output gets a fresh bar from the return", m.step(6200, true).alpha === 0);
}
{
  const frames = [...cadence(0, 1000, 100), ...cadence(1900, 2500, 100)];
  const { m } = run(frames, 2500);
  check("stats record the stall and the longest output gap, for the session summary line",
    m.stats.stalls === 1 && Math.round(m.stats.longestGapMs) === 1000 && m.stats.cameraMs > 0, JSON.stringify(m.stats));
}

console.log("\n── §5 WIRING ──");
{
  const billing = extract("function startBillingWindow(gen)", "\n}\n");
  check("started at the reveal, right where .show-live goes on",
    /card\(\)\.classList\.add\("show-live"\);\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*if \(typeof startStreamContinuity === "function"\) startStreamContinuity\(\);/.test(billing));
  const td = extract("function teardown()", "\n}\n");
  /* Not "the path every exit reaches" any more - that was the premise §6 found false. */
  check("retired in teardown(), the manual-exit path", /stopStreamContinuity\(\)/.test(td));

  const layer = extract("function startStreamContinuity()", "function stopStreamContinuity()");
  check("the tick reads live AND revealed, so a result or clip on the stage is never covered",
    /isLive\(\) && cardEl\.classList\.contains\("show-live"\)/.test(layer));
  check("the output is timed by requestVideoFrameCallback, and the layer stays off (and says so) without it",
    /ai\.requestVideoFrameCallback\(onAi\)/.test(layer) && /no requestVideoFrameCallback/.test(layer));
  check("the camera is only ever READ - no pause, no gate, no hold anywhere in the layer",
    !/\.pause\(|\.hold\(|holdInputGate|srcObject\s*=/.test(layer));
  check("the frame is drawn before the opacity rises, so the first visible camera frame is current",
    layer.indexOf("drawContinuityFrame(c, continuitySource(cam), ai)") < layer.indexOf("c.style.opacity = String(a)"));

  /* GEOMETRY IN LOCKSTEP WITH #aiVideo. The canvas must carry #aiVideo's live transform, or the
     body jumps sideways when the camera fades in. Read off both files, not restated. */
  const aiRule = (CSS.match(/\.camera-card\.show-live #aiVideo \{[^}]*transform:\s*([^;]+);/) || [])[1];
  const layerCss = (extract("function continuityEl()", "function drawContinuityFrame").match(/#liveContinuityCanvas\{[^"]*"\s*\+\s*"[^"]*/) || [""])[0];
  check("the layer carries #aiVideo's live transform verbatim",
    !!aiRule && layerCss.includes(`transform:${aiRule.trim()}`), `aiVideo: ${aiRule} | layer: ${layerCss}`);
  check("...and its object-fit", /object-fit:cover/.test(layerCss));
  const draw = extract("function drawContinuityFrame", "function startStreamContinuity()");
  const throttleDraw = extract("  const drawFrame = () => {", "  const tick = () => {");
  check("the camera is cover-cropped with the throttle's own math - the crop Decart renders from",
    /Math\.max\(W \/ vw, H \/ vh\)/.test(draw) && /Math\.max\(width \/ vw, height \/ vh\)/.test(throttleDraw));
  check("...drawn un-mirrored, like every video surface the recorder reads", /g\.setTransform\(1, 0, 0, 1, 0, 0\);/.test(draw));

  /* THE SAME SOURCE, NOT JUST THE SAME MATH (reported 2026-09-26: "a zoom-in between the first
     and second second"). The crop above was always identical; the picture was not - the bridge
     drew #webcam while Decart is sent a clone track carrying its own resolution constraint, and
     on the shopper's device the two came back framed ~2.2x apart. The bridge must draw the
     element drawFrame() itself reads. */
  const throttleSrc = extract("function createThrottledInputStream(", "\n}\n");
  check("the input throttle exposes the element drawFrame() crops for Decart",
    /sourceVideo: video,/.test(throttleSrc) && /ctx\.drawImage\(video, dx, dy, dw, dh\);/.test(throttleDraw));
  check("the bridge is drawn through continuitySource(), never straight from #webcam",
    /drawContinuityFrame\(c, continuitySource\(cam\), ai\)/.test(layer) && !/drawContinuityFrame\(c, cam,/.test(SRC));
  const continuitySource = (throttle) => new Function("inputThrottle",
    extract("function continuitySource(cam)", "\n}\n") + "\n}\nreturn continuitySource;")(throttle);
  const webcam = { id: "webcam", videoWidth: 1280, videoHeight: 720 };
  const clone = { id: "clone", videoWidth: 512, videoHeight: 288 };
  check("...which returns the clone's element while a session streams",
    continuitySource({ sourceVideo: clone })(webcam) === clone);
  check("...and #webcam only with no input stream, or before the clone has a frame",
    continuitySource(null)(webcam) === webcam &&
    continuitySource({ sourceVideo: { videoWidth: 0, videoHeight: 0 } })(webcam) === webcam &&
    continuitySource({})(webcam) === webcam);

  /* THE CLIP. Blended in the LIVE branch at the layer's own opacity - never in the frozen-hold
     tail, which paints a captured end frame after the session has left .show-live. */
  const rec = extract("function startRecording()", "/** Halt the canvas paint loop");
  const liveBranch = rec.slice(rec.indexOf("} else {", rec.indexOf("if (recordHold && recordHoldSrc)")));
  check("the recorder blends the camera layer at exactly liveContinuityAlpha",
    /ctx\.globalAlpha = liveContinuityAlpha;\s*\n\s*ctx\.drawImage\(_continuityCanvas, 0, 0, w, h\);/.test(liveBranch));
  check("...after #aiVideo, inside the save/restore that resets globalAlpha",
    liveBranch.indexOf("ctx.drawImage(video, 0, 0, w, h)") < liveBranch.indexOf("ctx.drawImage(_continuityCanvas") &&
      liveBranch.indexOf("ctx.drawImage(_continuityCanvas") < liveBranch.indexOf("} finally { ctx.restore(); }"));
  check("...and not in the frozen-hold branch",
    !/_continuityCanvas/.test(rec.slice(rec.indexOf("if (recordHold && recordHoldSrc)"), rec.indexOf("} else {", rec.indexOf("if (recordHold && recordHoldSrc)")))));

  check("both restore seams are URL-only and default OFF",
    /get\("swap_hold"\) === "1"/.test(SRC) && /get\("still_covers"\) === "1"/.test(SRC));
}

console.log("\n── §6 A SECOND TRY-ON INHERITS NOTHING - the window that simply runs out ──");
/* REPORTED: "the second Try On on the same page glitches". A window that runs out ends in
   beginFreezeHold() -> stopBilling() -> finalizeVideoClip(), not teardown() - and that chain
   skipped the bridge and the orientation watcher. startStreamContinuity() is idempotent, so
   the next session REUSED this bridge with the old stall clock. See resetTryOnSession(). */
{
  /* THE FAILURE, on the real model: session one's output ends at 5s, the page idles (steps
     keep running, not live), session two is revealed at 20s with its first output frames a
     beat behind the reveal. */
  const s1 = cadence(0, 5000, 100), s2 = cadence(20200, 21500, 100);
  const liveAt = (t) => t < 5000 || t >= 20000;
  const reused = run([...s1, ...s2], 21500, { live: liveAt });
  const reveal = reused.events.find((e) => e.t >= 20000);
  check("a bridge REUSED from the previous session reads the idle gap as a stall at the reveal - the camera over the new garment",
    !!reveal && reveal.type === "stall" && reveal.gapMs > 10000 && reused.samples.some((x) => x.t >= 20000 && x.t < 20600 && x.alpha > 0.5),
    JSON.stringify(reveal));
  const fresh = run(s2, 21500, { live: (t) => t >= 20000, start: 20000 });
  check("...while a bridge built fresh for that session never shows the camera at all",
    fresh.events.length === 0 && fresh.samples.every((x) => x.alpha === 0), JSON.stringify(fresh.events));

  /* THE WIRING - each exit of the run-out chain, and the backstop at the next entry. */
  const billingStop = extract("function stopBilling()", "\n}\n");
  check("stopBilling() retires the bridge - the window that runs out no longer leaves it running",
    /stopStreamContinuity\(\)/.test(billingStop));
  const finalize = extract("function finalizeVideoClip()", "\n}\n");
  check("finalizeVideoClip() retires the orientation watcher once the frozen tail it was kept for is over",
    /orientWatcher\.stop\(\)/.test(finalize) && /orientWatcher = null;/.test(finalize) && /orientWatcherItem = null;/.test(finalize));
  /* "Before its first await" means the first await of the NEW SESSION'S setup - everything
     after `busy` is claimed. Since 2026-09-26 goLive() has one await BEFORE the claim: the
     size re-check (calculateSize(), now a server verdict - usually a same-tick memo hit).
     It cannot move below the claim - adult-pants-sizing §7 pins that a recompute never
     holds busy/billing state, so a blocked go-live leaves the previous session (and its
     clip) untouched - and it has its own re-entry guard (goLiveResolvingSize). Nothing
     this suite retires is started by that wait; the page was idle before the click and
     stays idle through it. So the invariant is measured from the claim, and the size
     await is asserted separately to be the ONLY await ahead of it. */
  const live = extract("async function goLive()", "function stopLive()");
  const busyIdx = live.indexOf("busy = true;");
  const resetIdx = live.indexOf("resetTryOnSession();"), awaitIdx = live.indexOf("await ", busyIdx);
  check("goLive() runs resetTryOnSession() after claiming `busy` and before the session's first await",
    resetIdx > busyIdx && resetIdx !== -1 && resetIdx < awaitIdx);
  const beforeClaim = live.slice(0, busyIdx).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("...and the only await ahead of the claim is the guarded size re-check",
    (beforeClaim.match(/\bawait\b/g) || []).length === 1 &&
    /goLiveResolvingSize = true;\s*\n\s*try \{ await calculateSize\(\); \} finally \{ goLiveResolvingSize = false; \}/.test(beforeClaim),
    beforeClaim.slice(-400));

  /* THE BACKSTOP, executed: whatever it finds is retired, the pose readings are cleared, and
     it says so once - and it is silent when the previous session exited cleanly. */
  const resetSrc = extract("function resetTryOnSession()", "\n}\n") + "\n}\n";
  const logs = [];
  const sandbox = new Function("console", `
    let orientWatcher = null, orientWatcherItem = null, _continuity = null, turnMarked = null, watcherStopped = 0, bridgeStopped = 0;
    let _torsoYawAbs = 0, _torsoYawAt = 0, _torsoYawRise = 0, _poseFacingSep = 0, _poseFacingAt = 0, _poseTorsoLostAt = 0;
    function stopStreamContinuity() { if (_continuity) { _continuity = null; bridgeStopped++; } }
    function orientTurnMark(turning) { turnMarked = turning; }
    ${resetSrc}
    return {
      leave() {
        orientWatcher = { stop() { watcherStopped++; } }; orientWatcherItem = { id: "A" }; _continuity = { stop() {} };
        _torsoYawAbs = 72; _torsoYawAt = 123; _torsoYawRise = 140; _poseFacingSep = -0.6; _poseFacingAt = 123; _poseTorsoLostAt = 99;
      },
      reset: () => resetTryOnSession(),
      get state() { return { orientWatcher, orientWatcherItem, _continuity, turnMarked, watcherStopped, bridgeStopped,
        pose: [_torsoYawAbs, _torsoYawAt, _torsoYawRise, _poseFacingSep, _poseFacingAt, _poseTorsoLostAt] }; },
    };`)({ warn: (m) => logs.push(m), log() {}, error() {} });
  sandbox.leave();
  sandbox.reset();
  const st = sandbox.state;
  check("resetTryOnSession() stops a leftover watcher and bridge and drops both handles",
    st.watcherStopped === 1 && st.bridgeStopped === 1 && st.orientWatcher === null && st.orientWatcherItem === null && st._continuity === null,
    JSON.stringify(st));
  check("...clears the turn mark and every pose reading the previous session published",
    st.turnMarked === false && JSON.stringify(st.pose) === JSON.stringify([null, 0, 0, null, 0, 0]), JSON.stringify(st.pose));
  check("...and logs one findable [PEAR] line naming what it retired",
    logs.length === 1 && /^\[PEAR\] try-on reset:.*orientation watcher.*live-camera bridge/.test(logs[0]), JSON.stringify(logs));
  sandbox.reset();
  check("after a clean exit it retires nothing and stays silent", logs.length === 1 && sandbox.state.watcherStopped === 1);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
