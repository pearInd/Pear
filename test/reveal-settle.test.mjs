/* THE WRONG GARMENT AT 00:00 - the reveal must never land inside an upload's render wait.

   REPORTED 2026-09-19, from a video log: the stream opened on a multicolor patterned
   long-sleeve nobody picked, and at 00:01 jumped to the selected black tee.

   NOT A DEFAULT IN THIS REPO. The only built-in garment is PEAR_CATALOG[0] (a blue tank, and
   only in the standalone catalog room); nothing multicolor, nothing long-sleeve is ever sent.
   It is Decart's own prior - the fourth recording of it after a raglan, a floral tank and a
   grey sweater (config.js) - drawn in the ~1s between a set_image_ack (receipt) and the
   render switching to the reference.

   THE CAUSE, and it is arithmetic: the cold-start hold is 1500ms and sends a full re-upload
   ("re-assert") 700ms in. That upload's ack plus Decart's render wait (780-1100ms measured)
   runs past the hold, so the reveal landed inside its prior window. §1 replays that exact
   timeline on a fake clock, against the REAL gate, with ?settle_hold=0 as the negative
   control that shows the bug and the default as the proof that it is gone.

   THE REST FENCES WHAT THE FIX LEANS ON:
   §2 the settle clock itself, executed
   §3 the floor is strict: no garment, no session - and never the back photo
   §4 the refusal comes before a token is minted, and there is no bare-retry fallback
   §5 the acknowledged floor is recorded as on the wire...
   §6 ...so go-live's apply is a no-op instead of a second upload of the same garment
   §7 the numbers relate the way the fix needs them to
   §8 the mock models the SDK's initialState, so the visual harness can see all of this

   NOT PROVEN HERE: that Decart's real render wait never exceeds REFERENCE_RENDER_SETTLE_MS.
   1200ms covers the measured 780-1100ms; a live ?cond_trace=1 session is what would show a
   longer one. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const ARM = extract("function armFirstFrameBilling(video, gen) {",
  "/* ═══════════════════════════════════════════════════════════════════════════\n   FRAME-FREEZE WATCHDOG");
const SETTLE = extract("let lastImageUploadAckAt = 0;", "\n/* Set by an open ?orient_debug=1 swap trace");

/* A fake clock with a timer queue, so an ack can land "400ms later" between frames. */
function fakeTime(start = 10_000_000) {
  let now = start;
  const timers = [];
  return {
    Date: { now: () => now },
    now: () => now,
    setTimeout: (fn, ms) => { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > until) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = until;
    },
  };
}

/* The REAL armFirstFrameBilling, driven with the REAL settle block (§2's code) underneath it.
   applyActive() models a full upload: the wire is busy until the ack lands ackMs later, and the
   ack is stamped through the real noteImageUploadAcked() - exactly what applyGarment() does. */
function liveHarness({ search = "", ackMs = 400, holdMs = CONFIG.COLD_START_MIN_HOLD_MS,
                       selectedId = "G1", floorId = "G1", floorAckAgoMs = 3000 } = {}) {
  const T = fakeTime();
  let frameCb = null, firedAt = null, busy = false;
  const acks = [];
  const logs = [];
  const sandbox = {
    video: { videoWidth: 1000, videoHeight: 1800, requestVideoFrameCallback: (cb) => { frameCb = cb; } },
    gen: 1, sessionGen: 1, billingStarted: false, isGarmentApplied: true, dressedFrameReady: false,
    sampleVideoLuma: () => ({ ready: true, avgLuma: 120, blackFrac: 0 }),
    CAMERA_BLACK_AVG_LUMA: 8, CAMERA_BLACK_PIXEL_FRAC: 0.9,
    // Rendered and conditioned by both detectors: the prior garment is neither camera nor absent.
    outputPassthroughDelta: () => ({ ready: true, delta: 52, passthrough: false }),
    referenceOnWire: () => true,
    PASSTHROUGH_GATE_MAX_MS: CONFIG.PASSTHROUGH_GATE_MAX_MS,
    PASSTHROUGH_MAX_DELTA: CONFIG.PASSTHROUGH_MAX_DELTA,
    COLD_START_REDISPATCH_MS: CONFIG.COLD_START_REDISPATCH_MS,
    COLD_START_REDISPATCH_MAX: CONFIG.COLD_START_REDISPATCH_MAX,
    COLD_START_MIN_HOLD_MS: holdMs, COLD_START_REASSERT_MS: CONFIG.COLD_START_REASSERT_MS,
    REFERENCE_RENDER_SETTLE_MS: CONFIG.REFERENCE_RENDER_SETTLE_MS,
    REVEAL_SETTLE_MAX_MS: CONFIG.REVEAL_SETTLE_MAX_MS,
    location: { search },
    MODEL_READY_STABLE_FRAMES: 1, MODEL_READY_STABLE_MS: 0,
    isLive: () => true,
    wireBusy: () => busy,
    resolveLook: () => null,
    activeItem: { id: selectedId },
    garmentIdOf: (it) => (it ? String(it.id) : "(none)"),
    lastSentImageRef: "REF", rtImageOnWire: true, lastSentPrompt: "P",
    startBillingWindow: () => { firedAt = T.now(); },
    watchPostFireLuma: () => {},
    requestAnimationFrame: (cb) => { frameCb = cb; return 1; },
    console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) },
    window: {},
    Date: T.Date,
  };
  const body = SETTLE + "\n" + ARM +
    "\nreturn {" +
    " arm: () => armFirstFrameBilling(video, gen)," +
    " note: (w, id) => noteImageUploadAcked(w, id)," +
    " wireId: () => wireGarmentId };";
  let api;
  sandbox.applyActive = () => {
    busy = true;
    T.setTimeout(() => { busy = false; acks.push(T.now()); api.note("applyGarment", selectedId); }, ackMs);
    return Promise.resolve();
  };
  api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  // The floor, acknowledged at connect - long before the first frame, as on the real path.
  T.advance(0);
  const connectAt = T.now();
  api.note("connect", floorId);
  T.advance(floorAckAgoMs);
  const armedAt = T.now();
  api.arm();
  const tick = () => { const cb = frameCb; frameCb = null; if (cb) cb(); };
  /** Frames every `frameMs` until the reveal or `maxMs`. */
  const run = (maxMs = 8000, frameMs = 66) => {
    for (let t = 0; t <= maxMs && firedAt === null; t += frameMs) { tick(); T.advance(frameMs); }
  };
  return { run, tick, T, acks, logs, armedAt, connectAt, firedAt: () => firedAt, wireId: api.wireId };
}

console.log("── §1 THE REPORTED TIMELINE, replayed against the REAL gate ──");
{
  /* Decart's render wait after the re-assert's ack: the WORST measured case. The prior garment
     is what the shopper sees from the ack until ack + RENDER_WAIT. */
  const RENDER_WAIT = 1100;
  const insidePrior = (h) => h.acks.length > 0 &&
    h.firedAt() >= h.acks[h.acks.length - 1] && h.firedAt() < h.acks[h.acks.length - 1] + RENDER_WAIT;

  {
    /* NEGATIVE CONTROL - the gate exactly as it was: ?settle_hold=0. If this ever stops
       revealing inside the prior window, the replay no longer reproduces the report and the
       proof below proves nothing. */
    const h = liveHarness({ search: "?settle_hold=0" });
    h.run();
    const ack = h.acks[0];
    check("negative control: WITHOUT the settle hold the re-assert's upload goes out and is acked",
      h.acks.length === 1, `${h.acks.length} acks`);
    check("...and the reveal lands INSIDE that upload's render wait - the 00:00 wrong garment",
      insidePrior(h),
      `revealed ${h.firedAt() - ack}ms after the ack; Decart's prior shows until ${RENDER_WAIT}ms after it`);
  }
  {
    const h = liveHarness();
    h.run();
    const ack = h.acks[h.acks.length - 1];
    check("THE FIX: the same session still sends its re-assert",
      h.acks.length === 1, `${h.acks.length} acks`);
    check("...but reveals only after that upload's render wait is over",
      h.firedAt() !== null && !insidePrior(h) && h.firedAt() - ack >= CONFIG.REFERENCE_RENDER_SETTLE_MS,
      `revealed ${h.firedAt() - ack}ms after the last ack (settle ${CONFIG.REFERENCE_RENDER_SETTLE_MS}ms)`);
    check("...and says so in one line: the selected garment, what is on the wire, and the match",
      h.logs.some((l) => /\[VTO Pipeline\] first frame revealed/.test(l) && /selected Garment ID: G1/.test(l) &&
        /conditioning on the wire: G1 \(match\)/.test(l)), h.logs.filter((l) => /VTO/.test(l)).join(" | "));
    const cost = h.firedAt() - (h.armedAt);
    check("the cost is loading time, and it is bounded far inside the first-frame teardown",
      cost < CONFIG.REVEAL_SETTLE_MAX_MS, `${cost}ms to reveal`);
  }
  {
    /* A SLOW network: the ack itself takes 900ms. The reveal still waits for the render. */
    const h = liveHarness({ ackMs: 900 });
    h.run();
    check("with a slow 900ms ack the reveal still waits out the render",
      h.firedAt() !== null && h.firedAt() - h.acks[h.acks.length - 1] >= CONFIG.REFERENCE_RENDER_SETTLE_MS,
      `revealed ${h.firedAt() - h.acks[h.acks.length - 1]}ms after the ack`);
  }
}

console.log("\n── §1b THE OTHER HOLDS THE SETTLE GATE ADDS ──");
{
  {
    /* A re-assert that comes due while an upload is still rendering is DEFERRED, not spent: the
       hold would otherwise mark it sent while redispatchColdStart() declined it. */
    const h = liveHarness({ floorAckAgoMs: 0 });   // the floor's own render wait covers the re-assert moment
    h.run();
    check("a re-assert due inside a render wait is deferred and still sent once it settles",
      h.acks.length === 1 && h.acks[0] - h.connectAt >= CONFIG.REFERENCE_RENDER_SETTLE_MS && h.firedAt() !== null,
      `${h.acks.length} re-asserts, first ack ${h.acks[0] - h.connectAt}ms after the floor's, reveal ${h.firedAt()}`);
    check("...and the reveal is never inside the floor's own render wait either",
      h.firedAt() - h.connectAt >= CONFIG.REFERENCE_RENDER_SETTLE_MS,
      `revealed ${h.firedAt() - h.connectAt}ms after the floor's ack`);
  }
  {
    /* WRONG GARMENT ON THE WIRE: the floor is G0, the shopper selected G1 - a garment tapped
       while its predecessor was uploading. The reveal holds and re-dispatches the selection. */
    const h = liveHarness({ floorId: "G0", selectedId: "G1", holdMs: 0 });
    h.tick();
    check("a frame whose conditioning belongs to ANOTHER garment does not reveal",
      h.firedAt() === null);
    h.run();
    check("...a re-dispatch puts the selected garment on the wire",
      h.wireId() === "G1" && h.acks.length >= 1, `wire=${h.wireId()} acks=${h.acks.length}`);
    check("...and the reveal follows only once that upload has rendered",
      h.firedAt() !== null && h.firedAt() - h.acks[h.acks.length - 1] >= CONFIG.REFERENCE_RENDER_SETTLE_MS);
    check("...naming the mismatch while it held",
      h.logs.some((l) => /is not the selected one/.test(l)), h.logs.join(" | ").slice(0, 400));
  }
}

console.log("\n── §2 THE SETTLE CLOCK, executed ──");
{
  const T = fakeTime();
  let busy = false;
  const sandbox = {
    Date: T.Date, wireBusy: () => busy, REFERENCE_RENDER_SETTLE_MS: CONFIG.REFERENCE_RENDER_SETTLE_MS,
    window: {}, console: { log() {} }, resolveLook: () => null, activeItem: { id: 7 },
    garmentIdOf: (it) => String(it.id),
  };
  const api = new Function(...Object.keys(sandbox), SETTLE +
    "\nreturn { note: noteImageUploadAcked, settle: referenceRenderSettle, sel: selectedGarmentId," +
    " wire: () => wireGarmentId };")(...Object.values(sandbox));
  check("nothing uploaded yet: not settling (the floor or go-live's apply will stamp it)",
    api.settle().settling === false && api.settle().sinceAckMs === Infinity);
  busy = true;
  check("an image write on the wire IS settling, before any ack", api.settle().settling === true);
  busy = false;
  api.note("applyGarment", "7");
  check("an ack starts the render wait", api.settle().settling === true && api.wire() === "7");
  T.advance(CONFIG.REFERENCE_RENDER_SETTLE_MS - 1);
  check("...which holds until REFERENCE_RENDER_SETTLE_MS has passed", api.settle().settling === true);
  T.advance(1);
  check("...and ends exactly there", api.settle().settling === false);
  api.note("applyGarment", undefined);
  check("a re-pinned upload restarts the wait but keeps the garment identity it re-sent",
    api.settle().settling === true && api.wire() === "7");
  check("the selection is read from the single slot's garment", api.sel() === "7");
}

console.log("\n── §2b THE CEILING ──");
{
  /* Wire busy forever: the settle hold may never clear on its own. */
  const T = fakeTime();
  let frameCb = null, fired = false;
  const sandbox = {
    video: { videoWidth: 1000, videoHeight: 1800, requestVideoFrameCallback: (cb) => { frameCb = cb; } },
    gen: 1, sessionGen: 1, billingStarted: false, isGarmentApplied: true, dressedFrameReady: false,
    sampleVideoLuma: () => ({ ready: true, avgLuma: 120, blackFrac: 0 }),
    CAMERA_BLACK_AVG_LUMA: 8, CAMERA_BLACK_PIXEL_FRAC: 0.9,
    outputPassthroughDelta: () => ({ ready: true, delta: 52, passthrough: false }),
    referenceOnWire: () => true,
    PASSTHROUGH_GATE_MAX_MS: CONFIG.PASSTHROUGH_GATE_MAX_MS, PASSTHROUGH_MAX_DELTA: CONFIG.PASSTHROUGH_MAX_DELTA,
    COLD_START_REDISPATCH_MS: 0, COLD_START_REDISPATCH_MAX: CONFIG.COLD_START_REDISPATCH_MAX,
    COLD_START_MIN_HOLD_MS: 0, COLD_START_REASSERT_MS: CONFIG.COLD_START_REASSERT_MS,
    REFERENCE_RENDER_SETTLE_MS: CONFIG.REFERENCE_RENDER_SETTLE_MS, REVEAL_SETTLE_MAX_MS: CONFIG.REVEAL_SETTLE_MAX_MS,
    location: { search: "" }, MODEL_READY_STABLE_FRAMES: 1, MODEL_READY_STABLE_MS: 0,
    isLive: () => true, wireBusy: () => true, applyActive: () => Promise.resolve(),
    resolveLook: () => null, activeItem: { id: "G1" }, garmentIdOf: (it) => String(it.id),
    lastSentImageRef: "REF", rtImageOnWire: true, lastSentPrompt: "P",
    startBillingWindow: () => { fired = true; }, watchPostFireLuma: () => {},
    requestAnimationFrame: (cb) => { frameCb = cb; return 1; },
    console: { log() {}, warn() {} }, window: {}, Date: T.Date,
  };
  const api = new Function(...Object.keys(sandbox), SETTLE + "\n" + ARM +
    "\nreturn { arm: () => armFirstFrameBilling(video, gen) };")(...Object.values(sandbox));
  api.arm();
  const tick = () => { const cb = frameCb; frameCb = null; if (cb) cb(); };
  tick();
  check("a write that never settles holds the reveal...", fired === false);
  T.advance(CONFIG.REVEAL_SETTLE_MAX_MS - 10); tick();
  check("...up to the ceiling", fired === false);
  T.advance(20); tick();
  check("...and reveals past it rather than hanging the session", fired === true);
}

console.log("\n── §3 THE FLOOR IS STRICT - no garment, no session; never the back ──");
{
  const floorCode = extract("async function resolveInitialConditioning(item) {", "\n/* Read by buildRealtimeConnectOpts()");
  const guard = extract("function usableImageRef(ref) {", "\n/**\n * The hard stop");
  const mk = ({ gallery = {}, blob = null, never = false, ref = (u) => u }) => {
    const fetched = [];
    const sandbox = {
      galleryOf: () => gallery,
      garmentBlobCached: (u) => { fetched.push(u); return never ? new Promise(() => {}) : Promise.resolve(blob); },
      garmentImageRef: ref,
      clampPromptForWire: (p) => p,
      imageOnlyPrompt: (_it, angle = "front") => `ANCHOR_${angle}`,
      /* The prompt is a server answer since 2026-09-26 (wirePrompt(), lib/prompts.js) -
         the same marker the old in-browser imageOnlyPrompt() stub produced. */
      wirePrompt: async (_it, angle = "front") => `ANCHOR_${angle}`,
      FLOOR_ASSET_WAIT_MS: 25,
      setTimeout, clearTimeout, Blob, URL,
      console: { log() {}, warn() {}, error() {} },
    };
    const fn = new Function(...Object.keys(sandbox), guard + "\n" + floorCode + "\nreturn resolveInitialConditioning;")(
      ...Object.values(sandbox));
    return { resolve: fn, fetched };
  };
  const rejectsWith = async (p) => { try { await p; return null; } catch (e) { return e; } };

  {
    const e = await rejectsWith(mk({}).resolve(null));
    check("no garment selected: the session is REFUSED, not opened bare",
      e && e.isNoGarment === true, String(e));
    check("...with a message the shopper can read (goLive() prints it)",
      e && /לא ניתן לטעון את תמונת הבגד/.test(e.message) && /session was not started/.test(e.message));
  }
  {
    const m = mk({ gallery: { back: "https://cdn.test/back.jpg" } });
    const e = await rejectsWith(m.resolve({ name: "Tee" }));
    check("a garment with ONLY a back photo is refused - the back is never the floor (§2.1)",
      e && e.isNoGarment === true && m.fetched.length === 0,
      `fetched: ${JSON.stringify(m.fetched)} err: ${e}`);
  }
  {
    const B = new Blob(["front-bytes"], { type: "image/jpeg" });
    const m = mk({ gallery: { front: "https://cdn.test/front.jpg", back: "https://cdn.test/back.jpg" }, blob: B });
    const f = await m.resolve({ name: "Tee" });
    check("happy path: the floor is the front's BYTES - the same cached Blob applyGarment() sends",
      f.image === B && m.fetched[0] === "https://cdn.test/front.jpg");
    check("...with the FRONT anchor and enhance explicitly false",
      f.prompt.text === "ANCHOR_front" && f.prompt.enhance === false);
  }
  {
    const m = mk({ gallery: { front: "https://cdn.test/front.jpg" }, never: true });
    const f = await m.resolve({ name: "Tee" });
    check("bytes that never arrive fall back to the URL after FLOOR_ASSET_WAIT_MS - still this garment",
      f.image === "https://cdn.test/front.jpg");
  }
  {
    const m = mk({ gallery: { front: "blob:https://app.test/9f1c" } });
    const e = await rejectsWith(m.resolve({ name: "Tee" }));
    check("a reference the SDK cannot read as bytes is refused, never sent",
      e && e.isNoGarment === true && /not readable/.test(e.message), String(e));
  }
}

console.log("\n── §4 REFUSED BEFORE A TOKEN, AND NO BARE-RETRY FALLBACK ──");
{
  const connect = decomment(extract("async function connectRealtime({ force = false } = {}) {", "\n/**\n * Single teardown"));
  const iPrime = connect.indexOf("await primeInitialConditioning()");
  const iMint = connect.indexOf("mintEphemeralToken()");
  check("the floor is resolved (and may refuse) BEFORE a token is minted",
    iPrime !== -1 && iMint !== -1 && iPrime < iMint, `prime@${iPrime} mint@${iMint}`);
  check("a failed connect is retried only for the signaling race - never without the floor",
    /if \(!isSignalingRace \|\| attempt >= 2 \|\| gen !== sessionGen\) throw e;/.test(connect) &&
    !/dropInitialConditioning/.test(APP),
    "a bare retry opens a session with no acknowledged garment - the report's exact shape");

  const prime = extract("async function primeInitialConditioning() {", "\n/* ── THE ACKNOWLEDGED FLOOR IS ON THE WIRE");
  const run = async ({ resolveImpl, items }) => {
    const logs = [];
    let idx = 0;
    const sandbox = {
      resolveLook: () => null,
      garmentIdOf: (it) => (it ? String(it.id) : "(none)"),
      galleryOf: () => ({}), abbrevImg: (x) => String(x), describeFloorImage: () => "floor",
      console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")),
                 error: (...a) => logs.push("ERR " + a.join(" ")) },
    };
    const body = "let _sessionInitialState = 'STALE'; let _sessionInitialGarmentId = 'STALE';\n" +
      "let activeItem = __items[0];\n" +
      "const resolveInitialConditioning = (it) => __resolve(it, (n) => { activeItem = __items[n]; });\n" +
      prime + "\nreturn { prime: primeInitialConditioning, state: () => ({ s: _sessionInitialState, id: _sessionInitialGarmentId }) };";
    const api = new Function(...Object.keys(sandbox), "__items", "__resolve", body)(
      ...Object.values(sandbox), items, resolveImpl);
    let err = null;
    try { await api.prime(); } catch (e) { err = e; }
    return { err, state: api.state(), logs, idx };
  };
  {
    const r = await run({ items: [null], resolveImpl: async () => { const e = new Error("no garment"); e.isNoGarment = true; throw e; } });
    check("prime REFUSES (rethrows) when the floor cannot be built",
      r.err && r.err.isNoGarment === true);
    check("...leaving no floor behind from a previous session",
      r.state.s === null && r.state.id === null, JSON.stringify(r.state));
    check("...and logs the refusal under the pipeline tag",
      r.logs.some((l) => /ERR \[VTO Pipeline\] REFUSING to initialize/.test(l)));
  }
  {
    /* The shopper taps another garment while the first one's bytes load: the session must be
       seeded with the one they are now looking at. */
    const r = await run({
      items: [{ id: "A" }, { id: "B" }],
      resolveImpl: async (it, select) => { if (it.id === "A") select(1); return { image: `img-${it.id}`, prompt: { text: "P" } }; },
    });
    check("a selection that changes mid-load is re-resolved - the floor is the NEW garment",
      !r.err && r.state.id === "B" && r.state.s.image === "img-B", JSON.stringify(r.state));
    check("...and the Initializing line names that garment",
      r.logs.some((l) => /Initializing Decart session with Garment ID: B/.test(l)));
  }
}

console.log("\n── §5 THE ACKNOWLEDGED FLOOR IS RECORDED AS ON THE WIRE ──");
{
  const adopt = extract("function adoptInitialStateAsWire(why) {", "\nfunction buildRealtimeConnectOpts(gen)");
  const mk = (floor) => {
    const notes = [];
    const sandbox = { console: { log() {} }, noteImageUploadAcked: (w, id) => notes.push([w, id]) };
    const body = `let _sessionInitialState = __floor; let _sessionInitialGarmentId = "G9";\n` +
      "let lastSentImageRef = null, rtImageOnWire = false, lastSentPrompt = null, lastAckedImageRef = null;\n" +
      adopt + "\nreturn { adopt: adoptInitialStateAsWire, wire: () => ({ lastSentImageRef, rtImageOnWire, lastSentPrompt, lastAckedImageRef }) };";
    return { api: new Function(...Object.keys(sandbox), "__floor", body)(...Object.values(sandbox), floor), notes };
  };
  const B = new Blob(["f"]);
  {
    const { api, notes } = mk({ image: B, prompt: { text: "ANCHOR_front", enhance: false } });
    const ok = api.adopt("connect");
    const w = api.wire();
    check("the floor becomes the wire state: image, prompt, on-wire flag and the session pin",
      ok === true && w.lastSentImageRef === B && w.rtImageOnWire === true &&
      w.lastSentPrompt === "ANCHOR_front" && w.lastAckedImageRef === B, JSON.stringify({ ...w, lastSentImageRef: !!w.lastSentImageRef }));
    check("...and its ack starts a render wait, owned by the floor's garment",
      notes.length === 1 && notes[0][1] === "G9", JSON.stringify(notes));
  }
  {
    const { api } = mk(null);
    check("no floor: returns false so the caller invalidates instead", api.adopt("x") === false &&
      api.wire().rtImageOnWire === false);
  }
  const connect = decomment(extract("async function connectRealtime({ force = false } = {}) {", "\n/**\n * Single teardown"));
  check("connectRealtime() adopts the floor once connect() has resolved",
    connect.indexOf('adoptInitialStateAsWire("connect")') > connect.indexOf("await client.realtime.connect("));
  check("...and resets the render clock and garment identity for every new session",
    /lastImageUploadAckAt = 0; wireGarmentId = null;/.test(connect));
}

console.log("\n── §6 SO GO-LIVE'S APPLY IS A NO-OP, NOT A SECOND UPLOAD ──");
{
  const applyGarmentSrc = extract("async function applyGarment(item) {", "\n/* getAnatomicalAnchor() (restore seam");
  const FLOOR = new Blob(["front-packshot"], { type: "image/jpeg" });
  const run = ({ ref, prompt = "ANCHOR_front" }) => {
    const sent = [];
    const notes = [];
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
      Blob,
      clampPromptForWire: (p) => p,
      sendCondition: (_l, send) => send(),
      rtClient: {
        set: async (p) => { sent.push({ kind: "set", image: p.image }); },
        setPrompt: async (p) => { sent.push({ kind: "setPrompt", prompt: p }); },
      },
      currentAngle: "front", AUTO_ANGLE: "auto",
      effectiveAngle: () => "front", profileActive: () => false,
      activeImageOf: () => "https://cdn.test/front.jpg",
      referenceImageFor: async (_i, _a, out) => { out.composite = false; return ref; },
      compositeActiveFor: () => false,
      galleryOf: () => ({ front: "https://cdn.test/front.jpg" }),
      garmentImageRef: (u) => u,
      distinctBackOf: () => undefined, sameImage: (a, b) => a === b, activeBackIsReal: () => false,
      abbrevImg: (u) => String(u).slice(0, 20), vtonState: () => "FRONT_MODE", hasDedicatedAngle: () => false,
      describeCompositeLayout: () => "", buildCompositePrompt: () => "COMPOSITE",
      buildPrompt: () => prompt, angleClause: () => "",
      wirePrompt: async () => prompt,
      noteImageUploadAcked: (w, id) => notes.push([w, id]),
      garmentIdOf: (it) => String(it.id),
    };
    // State exactly as adoptInitialStateAsWire() leaves it after connect().
    const body = "let lastSentImageRef = __floor; let rtImageOnWire = true; let lastSentPrompt = 'ANCHOR_front';" +
      " let lastAckedImageRef = __floor;\n" + applyGarmentSrc + "\nreturn applyGarment;";
    const applyGarment = new Function(...Object.keys(sandbox), "__floor", body)(...Object.values(sandbox), FLOOR);
    return applyGarment({ name: "Tee", id: "G1", garmentType: "upper_body", subType: "tshirt" }).then(() => ({ sent, notes }));
  };
  {
    const { sent } = await run({ ref: FLOOR });
    check("the garment the floor delivered is NOT uploaded a second time at go-live",
      sent.length === 0, JSON.stringify(sent.map((s) => s.kind)));
  }
  {
    const { sent } = await run({ ref: FLOOR, prompt: "ANCHOR_front + fit" });
    check("same garment, new prompt: a setPrompt(), never an image re-upload",
      sent.length === 1 && sent[0].kind === "setPrompt", JSON.stringify(sent.map((s) => s.kind)));
  }
  {
    const BACK = new Blob(["back-packshot"], { type: "image/jpeg" });
    const { sent, notes } = await run({ ref: BACK });
    check("a genuinely different reference still uploads - the floor never blocks a real change",
      sent.length === 1 && sent[0].kind === "set" && sent[0].image === BACK);
    check("...and that acknowledged upload stamps its render wait with this garment's id",
      notes.length === 1 && notes[0][0] === "applyGarment" && notes[0][1] === "G1", JSON.stringify(notes));
  }
}

console.log("\n── §7 THE NUMBERS ──");
{
  const ffTimeout = Number((APP.match(/const FIRST_FRAME_TIMEOUT_MS = (\d+);/) || [])[1]);
  check("the settle covers the worst measured render wait after an ack (1100ms)",
    CONFIG.REFERENCE_RENDER_SETTLE_MS >= 1100, String(CONFIG.REFERENCE_RENDER_SETTLE_MS));
  check("the old fixed hold could NOT cover the re-assert's render - the arithmetic of the bug",
    CONFIG.COLD_START_MIN_HOLD_MS - CONFIG.COLD_START_REASSERT_MS < 1100,
    `${CONFIG.COLD_START_MIN_HOLD_MS - CONFIG.COLD_START_REASSERT_MS}ms left in the hold after the re-assert`);
  check("the settle ceiling outlasts the passthrough ceiling (a late re-dispatch still has a render to wait out)",
    CONFIG.REVEAL_SETTLE_MAX_MS > CONFIG.PASSTHROUGH_GATE_MAX_MS + CONFIG.REFERENCE_RENDER_SETTLE_MS);
  check("...and stays far inside FIRST_FRAME_TIMEOUT_MS, so no gate can become a teardown",
    Number.isFinite(ffTimeout) && CONFIG.REVEAL_SETTLE_MAX_MS < ffTimeout / 2, `${CONFIG.REVEAL_SETTLE_MAX_MS} vs ${ffTimeout}`);
}

console.log("\n── §8 THE MOCK SPEAKS THE SDK'S initialState ──");
{
  const mock = extract("async function mockRealtimeConnect(inputStream, opts) {", "\nif ((typeof PEAR_DEBUG_BUILD === \"undefined\" || PEAR_DEBUG_BUILD) && typeof window !== \"undefined\") window.__pearMockDecart");
  const iInit = mock.indexOf('record("initialState"');
  const iAwait = mock.indexOf("if (initAck) await initAck;");
  const iConnected = mock.indexOf('MOCK_DECART_STATE.connectionState = "connected";');
  check("the mock records the initialState and waits for its ack BEFORE reporting connected",
    iInit !== -1 && iAwait > iInit && iConnected > iAwait, `init@${iInit} await@${iAwait} connected@${iConnected}`);
  check("the simulated render wait is OFF unless asked for - the standard visual gate is unchanged",
    /return Number\.isFinite\(n\) && n > 0 && n <= 5000 \? n : 0;/.test(APP) && /\? n : 0;/.test(extract("function mockPriorMs()", "\n}")));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
