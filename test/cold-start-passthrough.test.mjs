/* THE COLD-START PASSTHROUGH GATE - "my real shirt showed for three seconds".

   REPORTED WITH A RECORDING: a Stitch hoodie try-on. 00:00-00:03 renders the shopper's own
   black t-shirt completely unconditioned. At 00:04 they turn, reconditionForTopology()
   force-dispatches a re-drape, and the hoodie snaps into place.

   ── THE OBVIOUS DIAGNOSIS IS WRONG, AND THIS SUITE PINS THAT DOWN ───────────────
   "The first applyGarment() never fired / was dropped by a stale wireBusy / waited for
   movement" is what the symptom looks like from outside. §1 asserts, against the real
   source, that none of it is true: goLive() dispatches immediately after waitConnected(),
   unconditionally, with no pose or movement dependency; applyActive() retries twice on its
   own; COLD_START_ACK_MS bounds the ack and reconnects; and the input gate withholds
   frames from Decart entirely until the reference is acknowledged.

   ── WHAT IS ACTUALLY WRONG ──────────────────────────────────────────────────────
   rtClient.set() resolves on `set_image_ack` - the server RECEIVED the reference, not that
   the render pipeline switched to it. armFirstFrameBilling() then decided the feed was
   ready from three signals that CANNOT SEE THE DIFFERENCE: gate (1) is the ack, gates (2)
   and (3) are luma checks, and a frame of the shopper in their own clothes is non-black,
   perfectly stable, and arrives after the ack resolved. The feed was revealed on it.
   The function's own comment had already conceded half of this in prose.

   THE FOURTH GATE compares Decart's OUTPUT against the INPUT this client is sending it -
   the input throttle already keeps that frame on a canvas - and holds the reveal while
   they are the same picture. §2 executes that comparison for real. §3 executes the gate
   and its re-dispatch inside the REAL armFirstFrameBilling, extracted from app.js.

   ── THE TWO WAYS THIS FIX COULD ITSELF BE THE BUG, both fenced ─────────────────
   §4: a gate that never opens is worse than the defect - it turns a bad render into a
   torn-down session via FIRST_FRAME_TIMEOUT_MS. It must fail OPEN on anything it cannot
   judge, and expire on a ceiling even when it is sure.
   §5: the re-dispatch is a full image re-upload, which 0762bea banned for the periodic
   re-anchor because it caused a dropout. It is allowed here only because nothing is on
   screen yet - so the reveal must not have fired, and the count must be bounded. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
/* Comments carry the words this suite searches for, so anything asserting about CODE
   strips them first. Without this, a comment explaining a trap matches as the trap. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

console.log("── §1 THE STARTUP DISPATCH IS ALREADY IMMEDIATE AND UNCONDITIONAL ──");
{
  /* These are the claims the reported diagnosis rests on. Every one of them is false
     against the real source, and asserting that is the point: a fix aimed at "the apply
     never fires" would have been aimed at nothing, and would have left the actual defect
     in place while looking like a repair. */
  const goLive = decomment(extract("async function goLive() {", "function stopLive() {"));

  /* Asserted as an ORDER rather than a proximity match: what matters is that the dispatch
     is a step in this path and that it follows the connect, not how many lines of
     orientation-watcher plumbing sit between them. */
  const iConnect = goLive.indexOf("await connectRealtime()");
  const iWait    = goLive.indexOf("await waitConnected(CONNECT_TIMEOUT_MS)");
  const iApply   = goLive.indexOf("applyConditioningWithRecovery()");
  check("goLive() dispatches the conditioning itself, in order, after waitConnected()",
    iConnect !== -1 && iWait > iConnect && iApply > iWait,
    `connect@${iConnect} wait@${iWait} apply@${iApply}` +
    " - the first drape is a step in the go-live path, not a consequence of anything moving");

  /* NOT GATED ON POSE. awaitBodyPresence() runs EARLIER in goLive as a credit saver, and
     it never refuses - it proceeds on timeout. So no pose outcome can prevent the apply. */
  const applyIdx = goLive.indexOf("applyConditioningWithRecovery");
  const between = goLive.slice(goLive.indexOf("await waitConnected"), applyIdx);
  check("...with no pose/topology/movement condition between connect and dispatch",
    !/bodyTopology/.test(between) && !/reconditionForTopology/.test(between) &&
    !/awaitBodyPresence/.test(between),
    between.slice(0, 300));
  check("...and the presence gate that runs earlier proceeds rather than refusing",
    /presence !== "present"/.test(goLive) && /continuing/.test(APP),
    "a shopper the detector cannot see must still get their try-on");

  /* NOT BLOCKED BY THE WIRE. resetConditionWire() zeroes the QUEUE, and at cold start
     nothing else has ever written, so wireBusy() cannot be holding the first apply. */
  check("applyActive() carries its own bounded retry, independent of any of this",
    /for \(let attempt = 1; attempt <= APPLY_ATTEMPTS; attempt\+\+\)/.test(APP));
  check("...and the cold-start ack has its own leash plus a reconnect-and-retry",
    /await race\(applyActive\(\), "", COLD_START_ACK_MS\);/.test(APP) &&
    /await connectRealtime\(\{ force: true \}\);/.test(APP),
    "a missing ack was already covered twice over - it is not what this report is");

  /* THE INPUT GATE. Raw frames cannot even reach Decart before the ack, so the
     unconditioned render is not raw frames leaking upstream. */
  check("camera frames are withheld from Decart until the garment is acknowledged",
    CONFIG.INPUT_GATE_ENABLED === true &&
    /releaseInputGate\("applyActive"\);/.test(APP),
    "the model never sees an unconditioned frame to render from");

  /* AND THE REVEAL IS NOT PART OF GO-LIVE. .show-live is added by startBillingWindow,
     which is what the gates below govern - so holding those gates holds the reveal. */
  check("the feed is revealed only from startBillingWindow(), never from goLive()",
    !/classList\.add\("show-live"\)/.test(goLive) &&
    /card\(\)\.classList\.add\("show-live"\);/.test(APP),
    "directive: no raw frame may ever be shown - the overlay stays up until the gates pass");
}

console.log("\n── §2 THE PROBE: executed, not inspected ──");
{
  /* The real function, run against stub surfaces whose pixels this test controls. A grid
     comparison is arithmetic, so there is no reason to assert it in prose. */
  const code = extract("let _inputProbe = null;", '/* Flip between the front ("user")');

  /** Build a fake 2D context whose getImageData returns a chosen flat RGB value, or a
      per-cell pattern, so a delta can be predicted exactly. */
  function makeProbeSurface(valueFor) {
    return {
      ctx: {
        drawImage() {},
        getImageData(_x, _y, w, h) {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let p = 0; p < w * h; p++) {
            const v = valueFor(p);
            data[p * 4] = v; data[p * 4 + 1] = v; data[p * 4 + 2] = v; data[p * 4 + 3] = 255;
          }
          return { data };
        },
      },
    };
  }

  function run({ outValue, inValue, hasThrottle = true, aiReady = true, throw_ = false,
                 enabled = true } = {}) {
    let outSurface = makeProbeSurface(typeof outValue === "function" ? outValue : () => outValue);
    let inSurface  = makeProbeSurface(typeof inValue  === "function" ? inValue  : () => inValue);
    if (throw_) outSurface.ctx.getImageData = () => { throw new Error("tainted"); };
    const sandbox = {
      PASSTHROUGH_PROBE_ENABLED: enabled,
      PASSTHROUGH_MAX_DELTA: CONFIG.PASSTHROUGH_MAX_DELTA,
      inputThrottle: hasThrottle ? { canvas: { width: 512, height: 910 } } : null,
      lumaProbeContext: () => outSurface,
      OffscreenCanvas: undefined,
      document: { createElement: () => ({ getContext: () => inSurface.ctx }) },
    };
    /* THE TWO PROBES MUST BE DIFFERENT SURFACES, which is the entire reason
       inputProbeContext() exists alongside lumaProbeContext(). Seeding _inputProbe
       directly is how this test proves they stay independent: if the code were changed to
       share one context, the second drawImage would overwrite the first grid and the
       "identical" and "different" cases below would both collapse to delta 0. */
    const fn = new Function(...Object.keys(sandbox),
      code + "\nreturn { outputPassthroughDelta, setInProbe: (p) => { _inputProbe = p; } };");
    const api = fn(...Object.values(sandbox));
    api.setInProbe(inSurface);
    return api.outputPassthroughDelta(aiReady ? { videoWidth: 1000, videoHeight: 1800 } : null);
  }

  const identical = run({ outValue: 120, inValue: 120 });
  check("an output IDENTICAL to the input reads as a passthrough",
    identical.ready && identical.delta === 0 && identical.passthrough === true,
    JSON.stringify(identical));

  const shifted = run({ outValue: 160, inValue: 120 });
  check("an output that genuinely differs does NOT",
    shifted.ready && shifted.delta === 40 && shifted.passthrough === false,
    JSON.stringify(shifted));

  /* THE THRESHOLD IS A SEPARATOR, not a coin flip: scaling/JPEG noise on a true
     passthrough lands near zero, a real render lands far above it. Both sides checked. */
  const noisy = run({ outValue: (p) => 120 + (p % 3), inValue: 120 });
  check("scaling noise on a true passthrough still reads as a passthrough",
    noisy.passthrough === true && noisy.delta < CONFIG.PASSTHROUGH_MAX_DELTA,
    `delta ${noisy.delta}`);
  const render = run({ outValue: (p) => (p % 2 ? 90 : 150), inValue: 120 });
  check("...while a frame that differs by 30 per cell does not",
    render.passthrough === false, `delta ${render.delta}`);

  /* FAIL OPEN, four ways. Every one of these must read as "cannot judge", never as
     "passthrough" - a probe failure that holds the gate is the hang §4 fences. */
  for (const [label, opts] of [
    ["no input throttle (the frozen-frame path, ?demo=1)", { hasThrottle: false }],
    ["no decoded AI frame yet", { aiReady: false }],
    ["a readback that throws (tainted canvas)", { throw_: true }],
    ["the probe disabled by config", { enabled: false }],
  ]) {
    const r = run({ outValue: 120, inValue: 120, ...opts });
    check(`fails OPEN on ${label}`,
      r.ready === false && r.passthrough === false, JSON.stringify(r));
  }
}

console.log("\n── §3 THE GATE AND THE RE-DISPATCH, inside the REAL armFirstFrameBilling ──");
{
  const code = extract("function armFirstFrameBilling(video, gen) {",
                       "/* ═══════════════════════════════════════════════════════════════════════════\n   FRAME-FREEZE WATCHDOG");

  /** Drive the real function with a scripted sequence of probe verdicts. */
  function harness({ verdicts, garmentApplied = true, dressed = true, live = true,
                     maxRedispatch = CONFIG.COLD_START_REDISPATCH_MAX,
                     gateMaxMs = CONFIG.PASSTHROUGH_GATE_MAX_MS,
                     redispatchMs = 0, wireBusyVal = false, clock } = {}) {
    let i = 0;
    const applies = [];
    const cleared = [];
    let fired = false;
    let frameCb = null;
    const sandbox = {
      video: { videoWidth: 1000, videoHeight: 1800, requestVideoFrameCallback: (cb) => { frameCb = cb; } },
      gen: 1, sessionGen: 1, billingStarted: false,
      isGarmentApplied: garmentApplied,
      dressedFrameReady: false,
      sampleVideoLuma: () => ({ ready: dressed, avgLuma: dressed ? 120 : 1, blackFrac: dressed ? 0 : 1 }),
      CAMERA_BLACK_AVG_LUMA: 8, CAMERA_BLACK_PIXEL_FRAC: 0.9,
      outputPassthroughDelta: () => verdicts[Math.min(i++, verdicts.length - 1)],
      PASSTHROUGH_GATE_MAX_MS: gateMaxMs,
      PASSTHROUGH_MAX_DELTA: CONFIG.PASSTHROUGH_MAX_DELTA,
      COLD_START_REDISPATCH_MS: redispatchMs,
      COLD_START_REDISPATCH_MAX: maxRedispatch,
      MODEL_READY_STABLE_FRAMES: 1, MODEL_READY_STABLE_MS: 0,
      isLive: () => live,
      wireBusy: () => wireBusyVal,
      applyActive: () => { applies.push(Date.now()); return Promise.resolve(); },
      lastSentImageRef: "REF", rtImageOnWire: true, lastSentPrompt: "PROMPT",
      startBillingWindow: () => { fired = true; },
      watchPostFireLuma: () => {},
      requestAnimationFrame: (cb) => { frameCb = cb; return 1; },
      console: { log() {}, warn() {} },
      window: {},
      Date: clock || Date,
    };
    const fn = new Function(...Object.keys(sandbox),
      code +
      "\nconst __api = { arm: () => armFirstFrameBilling(video, gen) };" +
      "\nreturn Object.assign(__api, { wire: () => ({ lastSentImageRef, rtImageOnWire, lastSentPrompt }) });");
    const api = fn(...Object.values(sandbox));
    api.arm();
    return {
      tick: () => { const cb = frameCb; frameCb = null; if (cb) cb(); },
      applies, cleared, fired: () => fired, wire: api.wire,
    };
  }

  /* THE REPORTED FRAME: the ack has resolved, the frame is non-black and stable - the
     three original gates ALL pass - and it is the shopper's own t-shirt. */
  const raw = { ready: true, delta: 0.4, passthrough: true };
  const real = { ready: true, delta: 38, passthrough: false };

  {
    const h = harness({ verdicts: [raw, raw, raw, real] });
    h.tick();
    check("a passthrough frame does NOT reveal the feed, though gates 1-3 all pass",
      h.fired() === false, "this is the exact frame the report was filed against");
    h.tick(); h.tick();
    check("...and keeps holding while it stays a passthrough", h.fired() === false);
    h.tick();
    check("the first genuinely rendered frame reveals it",
      h.fired() === true, "the gate opens the moment the output stops being the input");
  }

  {
    /* THE RE-DISPATCH, which is what makes this a fix rather than a stall: without it the
       gate would just wait out its ceiling on a render that was never going to change. */
    const h = harness({ verdicts: [raw], redispatchMs: 0 });
    h.tick();
    check("a passthrough frame re-dispatches the garment",
      h.applies.length === 1, `${h.applies.length} applies`);
    check("...clearing ALL THREE wire fields, like reconditionForTopology does",
      h.wire().lastSentImageRef === null && h.wire().rtImageOnWire === false &&
      h.wire().lastSentPrompt === null,
      JSON.stringify(h.wire()) + " - clearing only the image ref is swallowed by the" +
      " 'prompt unchanged too' skip in front of it");

    h.tick(); h.tick(); h.tick(); h.tick();
    check("...and stops at COLD_START_REDISPATCH_MAX, never once per frame",
      h.applies.length === CONFIG.COLD_START_REDISPATCH_MAX,
      `${h.applies.length} applies, max is ${CONFIG.COLD_START_REDISPATCH_MAX}`);
  }

  {
    const h = harness({ verdicts: [raw], redispatchMs: 0, wireBusyVal: true });
    h.tick(); h.tick();
    check("a re-dispatch NEVER stacks on a write already in flight",
      h.applies.length === 0,
      "two concurrent writes make the SDK's shape-matched acks ambiguous - see wireInFlight");
  }

  {
    const h = harness({ verdicts: [raw], redispatchMs: 0, live: false });
    h.tick();
    check("...and never fires into a session that is no longer live",
      h.applies.length === 0);
  }

  {
    /* THE ORIGINAL THREE GATES ARE UNTOUCHED. The new one only ever ADDS a reason to
       hold; it must not be able to reveal a frame the old gates rejected. */
    const h = harness({ verdicts: [real], garmentApplied: false });
    h.tick(); h.tick();
    check("gate (1) still holds on its own - no ack, no reveal, whatever the probe says",
      h.fired() === false);
    const d = harness({ verdicts: [real], dressed: false });
    d.tick(); d.tick();
    check("gate (2) still holds on its own - a black frame is still a black frame",
      d.fired() === false);
  }
}

console.log("\n── §4 THE GATE CANNOT HANG THE SESSION ──");
{
  const code = extract("function armFirstFrameBilling(video, gen) {",
                       "/* ═══════════════════════════════════════════════════════════════════════════\n   FRAME-FREEZE WATCHDOG");
  /* A GATE THAT NEVER OPENS IS WORSE THAN THE DEFECT. FIRST_FRAME_TIMEOUT_MS would tear
     the session down and show a hard failure - strictly worse for the shopper than an
     unconditioned render they can see and re-run. */
  /* FIRST_FRAME_TIMEOUT_MS is an app.js const, not a CONFIG key, so it is read out of the
     source rather than imported - and reading it here is the point: if either number moves,
     this check is what notices that the gate has grown past the teardown it must stay
     inside of. */
  const ffTimeout = Number((APP.match(/const FIRST_FRAME_TIMEOUT_MS = (\d+);/) || [])[1]);
  check("PASSTHROUGH_GATE_MAX_MS is well inside FIRST_FRAME_TIMEOUT_MS",
    Number.isFinite(ffTimeout) && CONFIG.PASSTHROUGH_GATE_MAX_MS < ffTimeout,
    `${CONFIG.PASSTHROUGH_GATE_MAX_MS} vs ${ffTimeout}` +
    " - a gate that outlives the teardown timer turns a bad render into a dead session");
  check("...and leaves room for every re-dispatch to be attempted first",
    CONFIG.COLD_START_REDISPATCH_MAX * CONFIG.COLD_START_REDISPATCH_MS < CONFIG.PASSTHROUGH_GATE_MAX_MS,
    `${CONFIG.COLD_START_REDISPATCH_MAX} x ${CONFIG.COLD_START_REDISPATCH_MS}ms` +
    ` vs a ${CONFIG.PASSTHROUGH_GATE_MAX_MS}ms ceiling - a gate that expires before its own` +
    ` remedy has run is just a delay`);

  /* EXECUTED, not merely arithmetic: a fake clock walks past the ceiling and the reveal
     must happen even though the probe is still certain it is a passthrough. */
  let now = 1_000_000;
  const clock = { now: () => now };
  const raw = { ready: true, delta: 0.1, passthrough: true };
  let fired = false, frameCb = null;
  const sandbox = {
    video: { videoWidth: 1000, videoHeight: 1800, requestVideoFrameCallback: (cb) => { frameCb = cb; } },
    gen: 1, sessionGen: 1, billingStarted: false, isGarmentApplied: true, dressedFrameReady: false,
    sampleVideoLuma: () => ({ ready: true, avgLuma: 120, blackFrac: 0 }),
    CAMERA_BLACK_AVG_LUMA: 8, CAMERA_BLACK_PIXEL_FRAC: 0.9,
    outputPassthroughDelta: () => raw,
    PASSTHROUGH_GATE_MAX_MS: CONFIG.PASSTHROUGH_GATE_MAX_MS,
    PASSTHROUGH_MAX_DELTA: CONFIG.PASSTHROUGH_MAX_DELTA,
    COLD_START_REDISPATCH_MS: CONFIG.COLD_START_REDISPATCH_MS,
    COLD_START_REDISPATCH_MAX: CONFIG.COLD_START_REDISPATCH_MAX,
    MODEL_READY_STABLE_FRAMES: 1, MODEL_READY_STABLE_MS: 0,
    isLive: () => true, wireBusy: () => false,
    applyActive: () => Promise.resolve(),
    lastSentImageRef: "REF", rtImageOnWire: true, lastSentPrompt: "P",
    startBillingWindow: () => { fired = true; },
    watchPostFireLuma: () => {}, requestAnimationFrame: (cb) => { frameCb = cb; return 1; },
    console: { log() {}, warn() {} }, window: {}, Date: clock,
  };
  const api = new Function(...Object.keys(sandbox),
    code + "\nreturn { arm: () => armFirstFrameBilling(video, gen) };")(...Object.values(sandbox));
  api.arm();
  const tick = () => { const cb = frameCb; frameCb = null; if (cb) cb(); };
  tick();
  check("before the ceiling, a certain passthrough still holds the reveal", fired === false);
  now += CONFIG.PASSTHROUGH_GATE_MAX_MS + 1;
  tick();
  check("past the ceiling it reveals anyway, rather than letting the session be torn down",
    fired === true,
    "an honest bad render beats a hard failure the shopper cannot act on");
}

console.log("\n── §5 THE RE-UPLOAD RULE IS BENT KNOWINGLY, AND ONLY HERE ──");
{
  /* 0762bea reverted the periodic re-anchor's full re-upload because it caused the very
     dropout it was meant to prevent - see the RE-ANCHOR block in app.js. This path does
     re-upload, so the reasons it is allowed to have to be true, not assumed. */
  const arm = extract("function armFirstFrameBilling(video, gen) {",
                      "/* ═══════════════════════════════════════════════════════════════════════════\n   FRAME-FREEZE WATCHDOG");
  check("the re-dispatch says out loud that it is a full re-upload, and why that is safe",
    /THIS IS A FULL IMAGE RE-UPLOAD MID-SESSION/.test(arm) && /0762bea/.test(arm),
    "a rule bent without a written reason is a rule broken by the next reader");
  check("...it is bounded, unlike the re-anchor's ~8 sends per session",
    /if \(redispatches >= COLD_START_REDISPATCH_MAX\) return;/.test(arm));
  check("...and its state is per-session by construction, with no reset to forget",
    /let redispatches = 0;/.test(arm) &&
    !/^let redispatches/m.test(APP.replace(arm, "")),
    "module-level counters are how one session's spent attempts get charged to the next");

  /* THE PERIODIC RE-ANCHOR MUST STILL BE PROMPT-ONLY. This suite exists partly to make
     sure the exception did not quietly become the rule. */
  const reanchor = APP.slice(APP.indexOf("async function maybeReanchorPrompt"),
                             APP.indexOf("async function maybeReanchorPrompt") + 4000);
  check("the periodic re-anchor is untouched and still does NOT re-upload the image",
    reanchor.length > 0 && !/lastSentImageRef = null/.test(decomment(reanchor)),
    "the exception is the cold start, where nothing is on screen to drop out of");

  /* AND NOTHING IS ON SCREEN WHILE IT RUNS: the reveal is startBillingWindow's job and
     the gate is what defers it, so a dropout during these re-sends is invisible. */
  check("the re-dispatch can only run BEFORE the reveal, never after",
    /if \(stillRaw\) redispatchColdStart\(gen, probe\.delta\);/.test(arm) &&
    /const stillRaw = probe\.ready && probe\.passthrough && !passthroughGateExpired\(\);/.test(arm),
    "it is inside frameReady, which stops being called once fire() has run");
}

console.log("\n── §6 THE CONFIG RECORDS THE MISDIAGNOSIS ──");
{
  /* This file's convention: a constant that exists because of a specific report carries
     that report, so the next person does not re-derive it from a video. */
  check("config.js names the report and the timeline",
    /00:00-00:03/.test(CFG) && /00:04/.test(CFG));
  check("...and states plainly which diagnosis looked right and was not",
    /THE DIAGNOSIS THAT LOOKS RIGHT AND IS NOT/.test(CFG),
    "the next reader will arrive at 'the apply never fired' too");
  check("...and why the re-dispatch is keyed on the render, not on a missing ack",
    /NOT ON A MISSING ACK/.test(APP) || /not keyed on a missing ack/i.test(CFG));
  check("the topology re-drape is documented as refinement, never the first drape",
    /ongoing motion-refinement loop/.test(CFG),
    "the report's 00:04 recovery must not be load-bearing for the cold start");
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
