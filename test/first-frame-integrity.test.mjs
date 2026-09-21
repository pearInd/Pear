/* THE FLASH OF THE WRONG GARMENT - "it renders a grey sweater for a second, then my shirt".

   REPORTED, from a screen recording: 00:00-00:01 shows a generic grey long-sleeve sweater;
   at ~00:02 it becomes the shirt that was actually selected. Not a drift, not a colour
   miss - a completely different garment, rendered first, on every cold session.

   ROOT CAUSE - THERE WAS NOTHING ELSE IT COULD HAVE RENDERED. Raw camera frames start
   flowing the moment the WebRTC session opens. rtClient.set() - the call that delivers the
   reference - lands strictly after that. So for the window between the two, Decart is being
   asked to render a dressed person while the only thing it has is its own prior, and its
   prior for "person on a webcam wearing something" is a plain grey top.

   WHY THE EXISTING GATES COULD NOT CATCH IT, which is the part worth reading: the reveal is
   already gated THREE ways in armFirstFrameBilling() - the apply resolved, the frame is
   verified non-black, and it held for MODEL_READY_STABLE_FRAMES/_MS. A generic sweater
   passes all three. It is not black, it does not flicker, and it arrives after the apply
   promise resolved. That function's own comment names the hole precisely: "isDressedFrame()
   cannot distinguish 'the real garment' from 'Decart's generic/default output'". No
   pixel-inspection gate can close it, because the wrong frame looks exactly like a right
   one to every measure available on the client.

   THE FIX IS UPSTREAM: don't hand Decart anything to generate from until the reference is
   acknowledged. captureStream(0) only emits on requestFrame(), so withholding frames leaves
   a LIVE video track carrying nothing - the handshake completes normally, and there is
   simply no window in which a default garment can be generated. The first frame Decart
   receives is one it can already condition; the first frame it emits carries the garment.

   WHAT THIS SUITE PINS:
     §1  the gate withholds FRAMES and never the track, so the handshake is unaffected;
     §2  it opens on the one event that means "a garment is on the wire", from the single
         call site that owns that meaning;
     §3  it cannot strand a session - a caller that never reports success costs a late
         start, loudly, never a black screen;
     §3b the DISPLAY half - the feed is held at opacity 0 (not display:none, which would
         stop the frames the reveal gate measures) until the one statement that adds
         .show-live, and the inline styles are handed back to the stylesheet afterwards;
     §4  the prefetch that makes the gated window short: every item, not just dual-view
         ones, and warm bytes only - never a fetch moved onto the go-live path;
     §5  the frame budget sent to Decart, asserted as a deliberate figure rather than a
         number nobody re-derived.

   Sibling suites: apply-timeout.test.mjs owns the cold-start leash and the recovery that
   fires when the acknowledgement never comes; body-topology.test.mjs owns the pose loop
   this shares a thread with. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}"`);
  return SRC.slice(start, end);
}

/* The REAL throttle, executed against a fake camera and a fake capture track, so the
   gate's behaviour is observed rather than pattern-matched: `emitted` counts the frames
   that actually reached the output track. */
const code = extract("function createThrottledInputStream(", "\n/**\n * Open the input gate");

/* settleMs defaults to 0 here - the pre-settle behaviour, which is still a supported config
   (?gate_settle=0) and is what the frame-flow baselines below are written against. §1c drives the
   REAL CONFIG value. The sandbox must supply INPUT_GATE_SETTLE_MS because the extracted block
   resolves it as a default parameter: a global the sandbox does not define is a ReferenceError in
   the extracted copy while the real file is fine, which is CLAUDE.md §2.6's standing trap. */
function makeThrottle({ gated = true, gateMaxMs = 5000, fps = 50, settleMs = 0, undressedCheck } = {}) {
  /* `now` is the throttle's clock (its `clock` option). Tests that never move it see no time pass. */
  const state = { emitted: 0, drawn: 0, trackStopped: false, timers: new Set(), logs: [], warns: [], now: 0 };
  const outTrack = {
    contentHint: "",
    requestFrame() { state.emitted++; },
    stop() { state.trackStopped = true; },
  };
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    INPUT_GATE_ENABLED: gated, INPUT_GATE_MAX_MS: gateMaxMs, INPUT_GATE_SETTLE_MS: settleMs,
    console: {
      log: (...a) => state.logs.push(a.join(" ")),
      warn: (...a) => state.warns.push(a.join(" ")),
    },
    setInterval: (fn, ms) => { const id = { fn, ms }; state.timers.add(id); return id; },
    clearInterval: (id) => state.timers.delete(id),
    setTimeout: (fn, ms) => { const id = { fn, ms, isTimeout: true }; state.timers.add(id); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } },
    ...(undressedCheck ? { warnIfStreamStartedUndressed: undressedCheck } : {}),
    document: {
      createElement: () => ({
        muted: false, playsInline: false, autoplay: false, srcObject: null,
        videoWidth: 640, videoHeight: 360,
        width: 0, height: 0,
        play: () => Promise.resolve(),
        pause() {},
        getContext: () => ({
          save() {}, restore() {}, setTransform() {},
          drawImage: () => { state.drawn++; },
        }),
        captureStream: () => ({ getVideoTracks: () => [outTrack] }),
      }),
    },
  };
  const fn = new Function(...Object.keys(sandbox),
    code + "\nreturn createThrottledInputStream;")(...Object.values(sandbox));
  const srcStream = { getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }], getTracks: () => [] };
  const throttle = fn(srcStream, { fps, gated, gateMaxMs, settleMs, clock: () => state.now });
  /* The real one starts its interval from video.play().then(start) - a microtask. Flush it
     so the timer is registered before a test drives ticks. */
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = (n = 1) => {
    for (const t of state.timers) if (!t.isTimeout) for (let i = 0; i < n; i++) t.fn();
  };
  const fireTimeouts = () => {
    for (const t of [...state.timers]) if (t.isTimeout) { state.timers.delete(t); t.fn(); }
  };
  return { throttle, state, flush, tick, fireTimeouts };
}

console.log("── §1 THE GATE WITHHOLDS FRAMES, NEVER THE TRACK ──");
{
  const h = makeThrottle({ gated: true });
  await h.flush();
  h.tick(10);
  check("a gated throttle emits NOTHING before the garment is acknowledged",
    h.state.emitted === 0, `${h.state.emitted} frames leaked to Decart pre-conditioning`);
  /* THE TRACK IS THE POINT OF THE DESIGN. Withholding the TRACK would break the handshake
     (no video sender to negotiate); withholding FRAMES leaves a live track with nothing on
     it, which is exactly what captureStream(0) is for. */
  check("...but the output track still exists, so the handshake is unaffected",
    !!h.throttle.stream && h.state.trackStopped === false);
  check("...and it does not even bother drawing while gated",
    h.state.drawn === 0, "a paint nobody can receive is wasted work on the render thread");

  h.throttle.release("test");
  h.tick(3);
  check("once released, frames flow exactly as before the gate existed",
    h.state.emitted === 3, `${h.state.emitted}`);
  check("...and the release is idempotent, so the ~8 re-anchors after it are no-ops",
    h.throttle.release("again") === false);
  check("...and it says so once, in a line that names why frames started",
    h.state.logs.filter((l) => /input gate released/.test(l)).length === 1,
    h.state.logs.join("\n        "));
}
{
  /* THE KILL SWITCH, both ways. A flag that cannot be turned off is not a flag, and this
     one gates the single most load-bearing behaviour of a session's first second. */
  const h = makeThrottle({ gated: false });
  await h.flush();
  h.tick(4);
  check("with the gate disabled the old behaviour is exactly restored",
    h.state.emitted === 4, `${h.state.emitted}`);
  check("...and the config flag is what drives it",
    /gated = INPUT_GATE_ENABLED/.test(SRC) && CONFIG.INPUT_GATE_ENABLED === true);
}

console.log("\n── §1c THE SETTLE: the transport gap the acknowledgement does NOT close ──");
{
  /* WHY THIS EXISTS. The gate above opens on rtClient.set() RESOLVING, which means the SDK has
     SENT the reference on the signaling WebSocket - not that Decart has ingested it. Frames go out
     over the WebRTC media path, so the two race with no ordering guarantee between them, and
     @decartai/sdk@0.1.5 exposes no acknowledgement to wait for instead (set() is Promise<void>;
     its events are connectionChange / queuePosition / error / generationTick / generationEnded /
     diagnostic / stats - none of them reports a reference being applied). So the only lever left
     on that window is to keep holding frames for a bounded moment after the send settles.
     THE 800ms ITSELF IS A PRODUCT DECISION, NOT A MEASUREMENT - see CONFIG.INPUT_GATE_SETTLE_MS,
     which says so plainly and records how to replace it with one (?cond_trace=1). */
  const h = makeThrottle({ gated: true, settleMs: 800 });
  await h.flush();
  h.tick(4);
  check("frames are withheld before the acknowledgement, as ever", h.state.emitted === 0);
  check("release() reports that it accepted the acknowledgement", h.throttle.release("applyActive") === true);
  h.tick(6);
  check("...but frames STAY withheld through the settle - this is the whole point",
    h.state.emitted === 0, `${h.state.emitted} frames reached Decart before the reference could settle`);
  check("...and the gate still reads as shut while it settles, so nothing downstream thinks it is live",
    h.throttle.gateOpen === false);
  /* IDEMPOTENT ACROSS THE WINDOW. release() fires on every successful apply and on the ~8
     re-anchors that follow it; if each one restarted the settle, a busy session would never
     stream. The FIRST acknowledgement owns the clock. */
  check("a second release inside the settle is a no-op, not a restart",
    h.throttle.release("re-anchor") === false);
  h.fireTimeouts();
  h.tick(3);
  check("once the settle elapses, frames flow exactly as before",
    h.state.emitted === 3, `${h.state.emitted}`);
  check("...and it says so once, naming the settle as what held them",
    h.state.logs.filter((l) => /input gate released/.test(l)).length === 1 &&
    h.state.logs.some((l) => /holding frames a further 800ms/.test(l)),
    h.state.logs.join("\n        "));
}
{
  /* 0 RESTORES THE PRE-SETTLE BEHAVIOUR EXACTLY. A hold that cannot be turned off is not a
     bounded experiment, and ?gate_settle=0 is how the A/B that sizes it is run at all. */
  const h = makeThrottle({ gated: true, settleMs: 0 });
  await h.flush();
  h.throttle.release("applyActive");
  h.tick(3);
  check("settle 0 opens the gate synchronously, as it did before the settle existed",
    h.state.emitted === 3, `${h.state.emitted}`);
}
{
  /* THE SETTLE OWNS THE OPENING ONCE RELEASE HAS RUN, so it must die with the throttle too - a
     timer outliving its session opens a gate belonging to a client that no longer exists. */
  const h = makeThrottle({ gated: true, settleMs: 800 });
  await h.flush();
  h.throttle.release("applyActive");
  h.throttle.dispose();
  check("disposing during the settle clears its timer with everything else",
    h.state.timers.size === 0, `${h.state.timers.size} timer(s) survived dispose()`);
  check("the configured default is a real, non-zero hold, and is bounded well under the ceiling",
    CONFIG.INPUT_GATE_SETTLE_MS > 0 && CONFIG.INPUT_GATE_SETTLE_MS < CONFIG.INPUT_GATE_MAX_MS,
    `settle ${CONFIG.INPUT_GATE_SETTLE_MS}ms vs ceiling ${CONFIG.INPUT_GATE_MAX_MS}ms`);
  /* SCOPED TO GO-LIVE. release() is the one-shot the cold start uses; a mid-session swap runs
     hold()/unhold(), which the settle must not touch - holding frames on a TURN is the freeze
     CLAUDE.md §2.9 keeps off by default (?swap_hold=1). */
  check("the settle rides release() only - hold()/unhold() are untouched, so a turn cannot freeze on it",
    /settleTimer = setTimeout\(open, settleHoldMs\)/.test(SRC) &&
    !/unhold[\s\S]{0,400}settleHoldMs/.test(SRC));
}

console.log("\n── §2 IT OPENS ON 'A GARMENT IS ON THE WIRE', FROM ONE PLACE ──");
{
  /* ONE CALL SITE OWNS THE MEANING. applyActive() setting isGarmentApplied IS the
     definition of "the reference is acknowledged", and every path that dresses a session
     goes through it - go-live's first apply, the cold-start recovery's fallback, an
     SDK-reconnect re-apply - so no individual path has to know this gate exists. */
  const applyActive = extract("async function applyActive()", "\n/**\n * Render BOTH garments");
  check("the release rides isGarmentApplied inside applyActive()",
    /isGarmentApplied = true;[\s\S]{0,120}releaseInputGate\("applyActive"\);/.test(applyActive),
    "any other trigger is a proxy for 'a garment is on the wire' rather than the thing itself");
  /* The recovery's fallback sets isGarmentApplied itself rather than going through
     applyActive(), so it carries its own release - asserted, because that is precisely the
     path a cold-start session ends up on, and a gate left shut there is a black screen. */
  const fallback = extract("async function applyFallbackConditioning()", "\n/**\n * Open ONE realtime session");
  check("...and the cold-start fallback releases it too, since it bypasses applyActive()",
    /releaseInputGate\("fallback conditioning"\)/.test(fallback),
    "the recovery path is exactly where a stuck gate would be least recoverable");
  check("the helper is a no-op when there is no throttle, never a throw",
    /if \(inputThrottle && typeof inputThrottle\.release === "function"\)/.test(SRC));
  /* NOT tied to the reveal. armFirstFrameBilling's three gates decide when the shopper
     SEES the stream; this decides when Decart RECEIVES one. Conflating them would put the
     gate downstream of the very frames it exists to prevent. */
  check("it is not wired to the reveal, which is a different question entirely",
    !/releaseInputGate/.test(extract("function armFirstFrameBilling", "\nfunction watchPostFireLuma")),
    "the reveal gates what is shown; this gates what is generated");
}

console.log("\n── §3 IT CANNOT STRAND A SESSION ──");
{
  const h = makeThrottle({ gated: true, gateMaxMs: 1234 });
  await h.flush();
  h.tick(2);
  check("still shut while nothing has acknowledged", h.state.emitted === 0);
  h.fireTimeouts();
  h.tick(2);
  check("the gate self-releases at its ceiling rather than holding forever",
    h.state.emitted === 2, `${h.state.emitted}`);
  /* LOUD, because reaching this is a bug in the caller - not a slow network - and a silent
     auto-release would hide exactly the regression this suite exists to catch. */
  check("...and warns, because reaching the ceiling means a caller never reported success",
    h.state.warns.some((w) => /input gate: auto-released/.test(w)),
    h.state.warns.join("\n        "));
  check("the ceiling sits under the no-first-frame teardown, so it can still save the run",
    CONFIG.INPUT_GATE_MAX_MS < 20000 &&
    /const FIRST_FRAME_TIMEOUT_MS = (\d+)/.test(SRC) &&
    CONFIG.INPUT_GATE_MAX_MS < Number(SRC.match(/const FIRST_FRAME_TIMEOUT_MS = (\d+)/)[1]),
    `gate ${CONFIG.INPUT_GATE_MAX_MS}ms vs first-frame ${(SRC.match(/const FIRST_FRAME_TIMEOUT_MS = (\d+)/) || [])[1]}ms`);
  check("...and disposing clears the ceiling timer with everything else",
    (() => { const d = makeThrottle({ gated: true }); d.throttle.dispose(); return d.state.timers.size === 0; })(),
    "a timer outliving its throttle fires into a session that no longer exists");
}

console.log("\n── §3b THE DISPLAY GATE: the second lock on the same door ──");
{
  /* THE INPUT GATE depends on Decart behaving as expected - no frames in, no frames out.
     This one depends on nothing: whatever arrives, the shopper does not see it until Model
     Ready. Both are wanted, and the second was ALSO its own bug, not merely belt-and-braces.

     THE BUG: style.css hides #aiVideo until .show-live (added only at Model Ready), but
     onRemoteStream set `aiVideo.style.display = "block"` the instant the remote stream
     arrived - and an inline style beats a stylesheet rule. So the feed was displayed from
     the first remote frame with the reveal class still absent, and the only thing between
     it and the shopper was #scanOverlay: rgba(8,8,10,.34) plus a 3px blur. A 34%-opaque
     scrim dims a garment; it does not hide one. */
  const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
  check("the scan overlay is a translucent scrim, so it was never hiding anything",
    /\.scan-overlay \{[\s\S]{0,220}background: rgba\(8,8,10,\.34\)/.test(CSS),
    "if this ever becomes opaque the gate is still right, but the diagnosis below changes");
  check("...and the stylesheet still expects .show-live to be what reveals the feed",
    /\.camera-card #aiVideo \{ display: none; \}/.test(CSS) &&
    /\.camera-card\.show-live #aiVideo \{ display: block;/.test(CSS));

  const onRemote = extract("onRemoteStream: (editedStream) => {", "onConnectionChange:");
  check("the feed is held at opacity 0 the moment a stream arrives",
    /gateAiFeed\(aiVideo\);/.test(onRemote),
    "an inline display:block with nothing over it is the reported flash");
  /* OPACITY, NOT display:none - and this is load-bearing rather than stylistic.
     armFirstFrameBilling() detects Model Ready by SAMPLING this element (rVFC + a luma
     read), so it has to keep decoding and presenting throughout the gated window. A
     display:none video is not composited and may stop firing rVFC entirely, which would
     deadlock the very gate this serves. */
  check("...by opacity, so it keeps decoding and can still be sampled for Model Ready",
    /aiVideo\.style\.display = "block";/.test(onRemote) &&
    /function gateAiFeed\(aiVideo\) \{[\s\S]{0,160}opacity = "0";/.test(SRC) &&
    !/function gateAiFeed\(aiVideo\) \{[\s\S]{0,160}display = "none"/.test(SRC),
    "display:none would stop the frames the reveal gate is waiting to measure");

  /* ONE REVEAL, in the same statement that flips the state class, so the pixels and the
     documented state can never disagree. */
  const reveal = extract("card().classList.add(\"show-live\");", "startLowerBodyGuard();");
  check("the ONLY reveal is the statement that adds .show-live",
    /revealAiFeed\(\);/.test(reveal) &&
    (SRC.match(/revealAiFeed\(\)/g) || []).length === 2,   // the definition + the one call
    "a second reveal site is a second way to show an unconditioned frame");
  check("...and it fades rather than cuts",
    /transition = `opacity \$\{AI_FEED_FADE_MS\}ms ease-out`/.test(SRC) &&
    /const AI_FEED_FADE_MS = 220;/.test(SRC));
  /* NO FIXED SLEEP. The "let the placeholder frames clear" pause already exists and is
     evidence-based rather than a guess: MODEL_READY_STABLE_FRAMES consecutive qualifying
     decodes spanning MODEL_READY_STABLE_MS. A fixed setTimeout on top would add dead time
     to every healthy session and still not prove anything about the content. */
  check("the settling window is measured, not slept through",
    /const MODEL_READY_STABLE_FRAMES = 3;/.test(SRC) &&
    /const MODEL_READY_STABLE_MS     = 300;/.test(SRC) &&
    !/await new Promise\(r => setTimeout\(r, 200\)\)/.test(SRC),
    "a fixed pause costs every session the same delay and proves nothing about the frame");

  /* THE INLINE STYLES MUST NOT OUTLIVE THE SESSION. This is where the pre-existing clip
     bug lived: teardown left an inline display:none that nothing ever cleared, so a
     history clip added .show-clip - whose entire job is to display #aiVideo - and lost to
     the leftover inline rule. Clearing hands the element back to the stylesheet. */
  check("retiring the feed hands display AND opacity back to the stylesheet",
    /function resetAiFeedVisibility\(\) \{[\s\S]{0,220}ai\.style\.opacity = "";[\s\S]{0,60}ai\.style\.display = "";/.test(SRC));
  /* COUNTED ON CODE ONLY. This used to count raw file text and broke the moment a comment
     elsewhere referred to resetAiFeedVisibility() by name - a phantom fifth "call site"
     that reads as a real regression and sends the next person looking for a call that does
     not exist. Prose naming a function is not a call; strip comments before counting.
     (The save/restore balance check in orientation-yaw-mirror learned the same lesson.) */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");
  const callSites = (CODE.match(/resetAiFeedVisibility\(\)/g) || []).length;
  check("...and every path that retires or re-uses the element calls it",
    callSites === 4,   // definition + 2 teardowns + clip replay
    `${callSites} sites - expected the definition, both teardowns and the clip player`);
  check("...including the history-clip player, which is different content in the same element",
    /resetAiFeedVisibility\(\);\s*\/\/ a clip is different content/.test(SRC),
    "a clip inheriting a dead session's opacity:0 renders nothing at all");
}

console.log("\n── §4 THE PREFETCH THAT KEEPS THE GATED WINDOW SHORT ──");
{
  /* THE GATE IS ONLY AS GOOD AS THE WAIT BEHIND IT. Holding frames until the reference is
     acknowledged is correct whether that takes 200ms or two seconds - but the shopper
     watches the difference, so the acknowledgement has to be fast. It was not: the
     reference prewarm was reachable ONLY from the two branches that set AUTO_ANGLE, so a
     front-only garment (most of the catalog) had nothing warmed at all, and the go-live
     apply shipped a URL for Decart to fetch server-side before it could condition. */
  const setActive = extract("function setActiveItem(item, opts = {})", "\n// Exposed for lux-interactions.js");
  check("EVERY garment selection warms its reference, not only dual-view ones",
    /prewarmOrientationAssets\(\);/.test(setActive),
    "a front-only item previously reached go-live with nothing fetched");
  check("...and it is fire-and-forget, so choosing a garment never blocks on a fetch",
    !/await prewarmOrientationAssets/.test(setActive));

  /* WARM ONLY. This is the half that makes the change safe: a hit hands Decart bytes and
     removes its server-side fetch entirely; a MISS must fall straight through to the URL,
     because awaiting the fetch here would move it onto the go-live path - later and more
     visible than the server-side one it replaced. */
  const ref = extract("async function referenceImageFor(", "\nasync function applyGarment(item)");
  check("a warm reference is sent as BYTES, so Decart has nothing to fetch first",
    /const warm = garmentBlobIfWarm\(activeImg\);/.test(ref) && /return warm;/.test(ref));
  check("...and a cold one falls through to the URL rather than awaiting a fetch",
    !/await garmentBlobCached\(activeImg\)[\s\S]{0,200}const warm/.test(ref) &&
    /return garmentImageRef\(activeImg\);/.test(ref),
    "moving the fetch onto the critical path trades a hidden delay for a visible one");
  check("garmentBlobIfWarm() never awaits and never fetches",
    /function garmentBlobIfWarm\(url\) \{[\s\S]{0,220}return \(job && job\.settled\) \|\| null;/.test(SRC) &&
    !/async function garmentBlobIfWarm/.test(SRC));
  /* The settled value hangs off the cached promise, so LRU eviction drops both together -
     a second map would be a second thing to keep honest. */
  check("...and the warm value cannot outlive the cache entry it came from",
    /job\.then\(\(blob\) => \{ job\.settled = blob \|\| null; \}/.test(SRC),
    "a separate map would drift from the LRU the first time an entry was evicted");

  /* The heavy assembly already runs on OffscreenCanvas where it exists - asserted so a
     later edit cannot quietly drop back to a DOM canvas on the composite path, which is
     the one that actually costs milliseconds. */
  check("reference assembly uses OffscreenCanvas where available, with a DOM fallback",
    (SRC.match(/typeof OffscreenCanvas !== "undefined"/g) || []).length >= 4,
    "the composite/stitch builders are the ones worth keeping off the DOM");
}

console.log("\n── §5 THE FRAME BUDGET ON THE WIRE ──");
{
  /* DELIBERATE, not inherited. 512x288 is 147k pixels; a square 512x512 is 262k - 78%
     MORE data per frame on the same channel, and it does not match the 16:9 the camera
     actually delivers, so it would have to letterbox or crop to get there. The constraint
     being optimised is bytes per second through the datachannel, and this is already the
     lighter of the two. Asserted with the arithmetic in the failure message so the next
     person to reach for a square doesn't have to re-derive it. */
  const w = Number((SRC.match(/const LIVE_W = (\d+), LIVE_H = (\d+);/) || [])[1]);
  const h = Number((SRC.match(/const LIVE_W = (\d+), LIVE_H = (\d+);/) || [])[2]);
  check("the frame sent to Decart is capped at 512 on its longest edge",
    w === 512 && h === 288,
    `${w}x${h} - a square 512x512 would be ${((512 * 512) / (w * h) - 1) * 100}% more pixels per frame`);
  /* LIVE_FPS went 15 -> 60 with LIVE CONTINUITY ("it has to feel like a mirror"): the preview
     and the stall bridge show the camera directly, and 15fps is visibly not a mirror. What
     must NOT move is the wire rate, and the throttle must not ask the shared camera for it -
     a clone's frameRate constraint can drag the preview down with it. */
  check("...and the rate is capped below the local capture rate",
    /const LIVE_FPS\s+= 60;/.test(SRC) && /const LIVE_INFERENCE_FPS\s+= 10;/.test(SRC),
    "the preview is mirror-smooth locally; only 10 frames/s ever leave the browser");
  const throttleSrc = extract("function createThrottledInputStream", "function releaseInputGate");
  /* STRENGTHENED (2026-09-20), not loosened: this used to assert that the clone's
     applyConstraints call carried no frameRate. The call is GONE now, so the shape it
     matched on no longer exists - and the replacement asserts strictly more, because
     "no applyConstraints at all" subsumes "an applyConstraints without frameRate".
     WHY THE REST OF THE CALL WENT TOO: a width/height constraint reconfigures the shared
     capture source exactly as a frameRate one does, and re-negotiating the capture format
     restarts auto-exposure / auto-white-balance with it - at session start, and again when
     dispose() stops the clone at the end of the billed window. That is the end-of-turn
     colour/exposure step. The canvas was always the real guarantee for both rate and size. */
  check("...and the throttle's clone never constrains the shared camera at all",
    !/srcTrack\.applyConstraints/.test(throttleSrc),
    "the canvas + requestFrame() pacing is the rate AND size guarantee; any constraint on a " +
    "clone of the preview's track can reconfigure the shared source under the shopper - and " +
    "restart AE/AWB with it");

  /* THE POSE LOOP SHARES THIS THREAD. detectForVideo() is a WASM/GPU pass on the main
     thread - the same one servicing the datachannel - so the cheapest available saving is
     not running it when nobody can see the result. */
  const watcher = extract("function startPresenceWatcher", "/* ── end body-presence gate ── */");
  check("no pose inference runs on a hidden tab",
    /if \(typeof document !== "undefined" && document\.hidden\) return;/.test(watcher),
    "a backgrounded session competing for the render thread is pure cost");
  check("...and the loop still runs at the presence cadence, one inference per tick",
    /const tickMs = POSE_SAMPLE_MS \* 2;/.test(watcher) &&
    (watcher.match(/detectPoseFrame\(/g) || []).length === 1);
}


/* ── THE CAMERA COLOUR PIN (2026-09-20) ────────────────────────────────────────────────
   REPORTED: "on completing the 360 the feed abruptly changes colour temperature/exposure".
   The sensor's AE/AWB loops re-converge across a turn because a turn sweeps a large
   differently-coloured surface through the frame; lockCameraColor() pins them to the values
   the camera itself converged on, before the token mint. These checks pin the two decisions
   that are easy to undo by accident and expensive to re-diagnose. */
{
  const goLiveSrc = extract("async function goLive", "/* ── Billed-window cap");
  /* The CALL, not any mention: goLive() names connectRealtime() in two comments above the
     call site, and matching those compared the pin against prose. */
  const mintAt = goLiveSrc.indexOf("await connectRealtime();");
  const lockAt = goLiveSrc.indexOf("lockCameraColor");
  check("goLive() pins the camera's AE/AWB before it opens a billed session",
    lockAt !== -1 && mintAt !== -1 && lockAt < mintAt,
    "the pin must land after the settle gates and BEFORE the mint, so a reconfiguration " +
    "hitch happens where nothing is billed, revealed or recorded");

  /* THE ONE THAT MATTERS. Releasing the pin when the billed window closes re-converges AWB
     at exactly the 00:04 boundary the report is about - the artifact moved a few frames, not
     removed. The pin is held through the frozen-result tail and released only where the
     camera itself goes away. Asserted as an ABSENCE, the form that catches a well-meant
     "tidy up at the end of the session" line being added later. */
  const billingSrc  = extract("function stopBilling", "/* Close out the frozen-hold");
  const teardownSrc = extract("function teardown()", "/* ── A NEW TRY-ON INHERITS NOTHING");
  check("...and neither stopBilling() nor teardown() releases it",
    !/releaseCameraColor/.test(billingSrc) && !/releaseCameraColor/.test(teardownSrc),
    "handing the auto loops back at the end of the billed window re-grades the feed at " +
    "exactly the boundary the pin exists to keep steady");

  const releasers = (SRC.match(/^\s*releaseCameraColor\(\);/gm) || []).length;
  check("...and it is released in exactly the two places the camera itself goes away",
    releasers === 2 && /function fullTeardown\(\) \{\n  teardown\(\);/.test(SRC),
    `fullTeardown() + reinitCameraForOrientation(); found ${releasers} call sites`);

  /* The pin must be the camera's OWN converged answer, never a hardcoded guess - a fixed
     colour temperature would correctly expose one room and wreck every other. */
  const lockSrc = extract("async function lockCameraColor", "function releaseCameraColor");
  check("...and it pins the converged values read back from the track, not a constant",
    /getSettings\(\)/.test(lockSrc) && /settled\.colorTemperature/.test(lockSrc) &&
      /settled\.exposureTime/.test(lockSrc),
    "lockCameraColor() must freeze the auto loops at their own answer");
  check("...and a device with no exposure/white-balance control is left untouched",
    /getCapabilities/.test(lockSrc) && /left on auto/.test(lockSrc),
    "AE/AWB control is optional in the spec; a session must never fail because a camera " +
    "would not be pinned");
}
console.log("\n── §6 THE 'STARTED RENDERING WITHOUT A GARMENT' WARNING TELLS THE TRUTH ──");
/* REPORTED AS A RACE: "[PEAR][DEBUG] Decart stream started rendering WITHOUT a garment
   asset on the wire" on every session, read as proof that the first frame beats the
   front reference. It was not a race - it was the warning asking too early. It ran from
   onRemoteStream, which fires when the remote TRACK attaches during the handshake, before
   go-live's first set() can have been sent - so rtImageOnWire was false by construction.
   But the gate above withholds every camera frame until that set() is acknowledged, so
   nothing had been rendered at all. The warning must stay silent while the gate is shut,
   and must still fire for the one path that genuinely streams undressed: the gate's own
   fail-open timeout. */
{
  const fnSrc = extract("function warnIfStreamStartedUndressed()", "\n/**\n * Console escape hatch");
  const run = ({ throttle, onWire }) => {
    const warns = [];
    const api = new Function("inputThrottle", "rtImageOnWire", "console",
      "let debugStreamCheckedThisGen = false, lastSentImageRef = null;\n" + fnSrc +
      "\nreturn { check: warnIfStreamStartedUndressed, latched: () => debugStreamCheckedThisGen };")(
      throttle, onWire, { warn: (...a) => warns.push(a.join(" ")), log() {} });
    api.check();
    return { warns, latched: api.latched() };
  };
  const shut = run({ throttle: { gateOpen: false }, onWire: false });
  check("remote track attached while the gate is shut: no warning - nothing has rendered",
    shut.warns.length === 0, shut.warns.join("\n        "));
  check("...and the one-shot check is NOT spent, so a later, decidable moment can still ask",
    shut.latched === false);
  const openBare = run({ throttle: { gateOpen: true }, onWire: false });
  check("frames flowing with nothing on the wire still warns - the real failure is kept",
    openBare.warns.length === 1 && /WITHOUT a garment asset/.test(openBare.warns[0]));
  const ungated = run({ throttle: null, onWire: false });
  check("...and with no throttle at all (gate unavailable) it warns exactly as it always did",
    ungated.warns.length === 1);
  const dressed = run({ throttle: { gateOpen: true }, onWire: true });
  check("frames flowing with the garment acknowledged: silent", dressed.warns.length === 0);

  let asked = 0;
  const h = makeThrottle({ gated: true, gateMaxMs: 6000, undressedCheck: () => { asked++; } });
  await h.flush();
  h.fireTimeouts();
  check("the gate's fail-open timeout asks the question at the moment frames really start",
    asked === 1, `asked=${asked}`);
  const h2 = makeThrottle({ gated: true, undressedCheck: () => { asked++; } });
  await h2.flush();
  h2.throttle.release("garment acknowledged");
  check("...but an ordinary release does not - the garment is on the wire by definition",
    asked === 1, `asked=${asked}`);
  check("the call inside the gate is typeof-guarded (CLAUDE.md 2.7 - this block runs sandboxed)",
    /if \(typeof warnIfStreamStartedUndressed === "function"\) warnIfStreamStartedUndressed\(\);/.test(code));
}

console.log("\n── §7 THE SAME GATE, HELD ACROSS AN ORIENTATION SWAP ──");
/* REPORTED from the exported clip: during FRONT -> BACK the shirt goes blank - untextured, plain
   brown - for a beat before the back graphic appears. That is the window this gate was built for
   at go-live, reopened mid-session: a full set({ image }) replaces the reference while camera
   frames keep flowing, and Decart renders those frames from its own prior until the new
   reference lands. The clip is Decart's raw output, so no display cover can hide it; the only
   fix is not to hand Decart those frames. hold() closes the gate from the dispatch until the
   swap's own set() resolves - its output simply stays on the last conditioned frame. */
{
  const h = makeThrottle({ gated: true });
  await h.flush();
  check("hold() refuses while the go-live gate has never opened - that gate belongs to go-live",
    typeof h.throttle.hold === "function" && h.throttle.hold("swap", 2000) === false && h.throttle.held === false);
  h.throttle.release("go-live");
  h.tick(2);
  const before = h.state.emitted;
  check("once open, hold() closes it for the swap", h.throttle.hold("swap", 2000) === true && h.throttle.held === true);
  h.tick(5);
  check("...and no frame reaches Decart while it is held", h.state.emitted === before, `${h.state.emitted - before} leaked`);
  check("...and applyActive()'s generic release() does NOT open a held gate - only the holder may",
    h.throttle.release("applyActive") === false && h.throttle.held === true,
    "a re-drape or re-anchor finishing mid-swap would otherwise uncover the churn window");
  check("...the holder's unhold() does", h.throttle.unhold("swap acknowledged") === true && h.throttle.held === false);
  h.tick(3);
  check("...and frames flow again at once", h.state.emitted === before + 3, `${h.state.emitted - before}`);
  check("unhold() on a gate that is not held is a no-op", h.throttle.unhold("again") === false);
}
{
  /* THE FIRST FRAME ON THE NEW REFERENCE GOES AT THE ACK. Decart can only render the new reference
     from a camera frame sent after it took it; reopening the gate used to send none, so that frame
     waited up to a whole interval (100ms at 10fps) for the next tick on every swap. */
  const h = makeThrottle({ gated: true, fps: 10 });
  await h.flush();
  h.throttle.release("go-live");
  h.tick(1);                                   // a frame at t=0
  h.throttle.hold("swap", 2000);
  h.state.now = 450;                           // the upload and ACK took 450ms
  const before = h.state.emitted;
  h.throttle.unhold("swap acknowledged");
  check("a frame reaches Decart AT the ACK, not on the next interval tick",
    h.state.emitted === before + 1, `${h.state.emitted - before} frames at unhold`);
  const intervals = [...h.state.timers].filter((t) => !t.isTimeout);
  check("...and restarting the interval from it leaves exactly one interval at the same rate - the billing cap is unchanged",
    intervals.length === 1 && intervals[0].ms === 100, JSON.stringify(intervals.map((t) => t.ms)));
  h.tick(2);
  check("...and frames keep flowing from it", h.state.emitted === before + 3, `${h.state.emitted - before}`);

  const quick = makeThrottle({ gated: true, fps: 10 });
  await quick.flush();
  quick.throttle.release("go-live");
  quick.state.now = 1000;
  quick.tick(1);                               // a frame at t=1000
  quick.throttle.hold("swap", 2000);
  quick.state.now = 1040;                      // ACK 40ms later - under one frame period
  const q0 = quick.state.emitted;
  quick.throttle.unhold("swap acknowledged");
  check("a hold shorter than one frame period sends nothing extra - frames never go closer than the rate allows",
    quick.state.emitted === q0, `${quick.state.emitted - q0} extra`);
}
{
  const h = makeThrottle({ gated: false });
  await h.flush();
  h.throttle.hold("swap", 1500);
  h.fireTimeouts();
  h.tick(2);
  check("a hold can never strand the session - it self-releases at its ceiling, loudly",
    h.throttle.held === false && h.state.emitted === 2 && h.state.warns.some((w) => /held.*ceiling|ceiling/i.test(w)),
    h.state.warns.join(" | "));
}
{
  const watcher = SRC.slice(SRC.indexOf("function createFrameFreezeWatcher(video, gen)"),
    SRC.indexOf("function startFrameFreezeWatch("));
  check("the freeze watchdog stands down while a swap holds the input - a deliberate freeze is not a stall",
    /if \(!isLive\(\) \|\| connState === "reconnecting" \|\|\s*\n\s*inputGateHeld\(\) \|\|/.test(watcher),
    "otherwise an 800ms upload trips a full re-anchor that queues ANOTHER upload behind the swap");
  check("inputGateHeld() reads the live throttle's own flag",
    /function inputGateHeld\(\) \{\s*\n\s*return !!\(inputThrottle && inputThrottle\.held\);/.test(SRC));
}

console.log("\n── §8 A SWAP'S RENDER WAIT IS NOT A FREEZE - no mid-turn re-upload ──");
/* REPORTED from a 360 (00:03): the back graphic on, then a plain untextured shirt mid-rotation, then the
   back again. The watchdog stood down only while the swap HELD the input; after the ACK, Decart still has
   to render its first frame from the new reference. Past FRAME_FREEZE_MS that read as a frozen transport,
   and the first freeze of a session re-anchors at once - invalidateWireState() + applyActive(), a full
   re-upload with the input not held: the generic-garment window, mid-turn. This runs the REAL watchdog
   on a controlled clock through a swap: output frames every 100ms, dispatch (input held) at 1000ms, the
   ACK at 1300ms, then silence for `renderMs` before Decart's first frame on the new reference. */
{
  const num = (name) => Number(new RegExp(`^const ${name}\\s*=\\s*(\\d+)`, "m").exec(SRC)[1]);
  const watcherSrc = extract("function createFrameFreezeWatcher(video, gen)", "function startFrameFreezeWatch(");
  const gateSrc = extract("let _swapAckedAt = -Infinity;", "let freezeWatcher = null;");
  function runSwap({ renderMs, markAck = true, framesStopForGood = false, noSwap = false, freezeAt = null, ack = 1300 }) {
    /* On an epoch-like base, as Date.now() is live: the watchdog's lastRecoverAt starts at 0, and a clock
       starting at 0 would hold its first re-anchor behind the recover cooldown - which it never is live. */
    const BASE = 1_700_000_000_000;
    const clock = { now: BASE };
    const calls = [];
    const state = { held: false, rvfc: null, poll: null };
    const video = { paused: false, readyState: 4, currentTime: 0, play: async () => {},
      requestVideoFrameCallback(cb) { state.rvfc = cb; } };
    const sandbox = {
      Date: { now: () => clock.now },
      FRAME_FREEZE_MS: num("FRAME_FREEZE_MS"), FRAME_FREEZE_POLL_MS: num("FRAME_FREEZE_POLL_MS"),
      FRAME_FREEZE_RECOVER_COOLDOWN_MS: num("FRAME_FREEZE_RECOVER_COOLDOWN_MS"), FRAME_FREEZE_PING_MS: num("FRAME_FREEZE_PING_MS"),
      FRAME_FREEZE_AFTER_SWAP_MS: num("FRAME_FREEZE_AFTER_SWAP_MS"),
      sessionGen: 1, isLive: () => true, connState: "live", inputGateHeld: () => state.held, document: { hidden: false },
      rtClient: {}, resolveLook: () => null, buildLookPrompt: () => "look", imageOnlyPrompt: () => "prompt", activeItem: {},
      clampPromptForWire: (p) => p, isGarmentApplied: true, lastAckedImageRef: "back-ref", abbrevImg: (x) => x,
      sendCondition: async (label) => { calls.push({ op: label, at: clock.now - BASE }); return true; },
      invalidateWireState: () => calls.push({ op: "invalidateWireState", at: clock.now - BASE }),
      applyActive: async () => { calls.push({ op: "applyActive (RE-UPLOAD)", at: clock.now - BASE }); },
      console: { log() {}, warn: (...a) => { if (/FROZEN/.test(a.join(" "))) calls.push({ op: "FROZEN", at: clock.now - BASE }); } },
      setInterval: (fn) => { state.poll = fn; return 1; }, clearInterval() {},
    };
    const api = new Function(...Object.keys(sandbox),
      gateSrc + "\n" + watcherSrc + "\nreturn { createFrameFreezeWatcher, noteSwapAcknowledged, freezeBarMs };")(...Object.values(sandbox));
    const w = api.createFrameFreezeWatcher(video, 1);
    const ACK = ack, DISPATCH = 1000, TAIL = 1200;
    const frameDue = (t) => {
      if (freezeAt !== null) return t < freezeAt;
      if (noSwap) return true;
      if (t < TAIL) return true;                              // frames from camera input sent before the hold
      if (framesStopForGood) return false;
      return t >= ACK + renderMs;                             // Decart's first frame on the new reference, then steady
    };
    return (async () => {
      for (let t = 0; t <= 6000; t += 10) {
        clock.now = BASE + t;
        if (!noSwap && t === DISPATCH) state.held = true;
        if (!noSwap && t === ACK) { state.held = false; if (markAck) api.noteSwapAcknowledged(); }
        if (t % 100 === 0 && frameDue(t) && state.rvfc) { const cb = state.rvfc; state.rvfc = null; cb(); }
        if (t % 250 === 0 && state.poll) { state.poll(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
      }
      w.stop();
      return calls;
    })();
  }
  const reuploads = (calls) => calls.filter((c) => c.op.startsWith("applyActive")).length;

  /* Whether a given render wait trips it depends on where the ACK falls against the 250ms poll: the freeze
     clock was last re-stamped by the last HELD poll, up to one poll before the ACK. Both ends, reported range. */
  const bug = [];
  for (const [ack, renderMs] of [[1240, 780], [1240, 850], [1300, 1100]]) bug.push({ ack, renderMs, calls: await runSwap({ ack, renderMs, markAck: false }) });
  check("THE BUG, reproduced on the real watchdog: a 780-1100ms render wait after the ACK is read as a freeze and RE-UPLOADS the reference",
    bug.every((b) => reuploads(b.calls) === 1 && b.calls.some((c) => c.op === "invalidateWireState")),
    JSON.stringify(bug.map((b) => ({ ack: b.ack, renderMs: b.renderMs, ops: b.calls.map((c) => c.op + "@" + c.at) }))));
  const fixed = [];
  for (const ack of [1240, 1300]) for (const renderMs of [500, 900, 1100, 1400, 1700]) fixed.push({ ack, renderMs, calls: await runSwap({ ack, renderMs }) });
  check("THE FIX: after a swap's ACK, a render wait of up to FRAME_FREEZE_AFTER_SWAP_MS less one poll sends nothing - no ping, no re-upload",
    fixed.every((f) => f.calls.length === 0), JSON.stringify(fixed.filter((f) => f.calls.length).map((f) => ({ ack: f.ack, renderMs: f.renderMs, ops: f.calls.map((c) => c.op + "@" + c.at) }))));
  const dead = await runSwap({ renderMs: 0, framesStopForGood: true });
  const firstFrozen = dead.find((c) => c.op === "FROZEN");
  check("...while a transport that really dies after a swap is still caught and re-anchored, within the longer bar",
    reuploads(dead) >= 1 && firstFrozen && firstFrozen.at >= 1300 + num("FRAME_FREEZE_AFTER_SWAP_MS") - 250 &&
    firstFrozen.at <= 1300 + num("FRAME_FREEZE_AFTER_SWAP_MS") + 250, JSON.stringify(dead.slice(0, 4)));
  const plain = await runSwap({ noSwap: true, freezeAt: 3000 });
  const plainFrozen = plain.find((c) => c.op === "FROZEN");
  check("...and a freeze with no swap anywhere near it is caught at FRAME_FREEZE_MS, exactly as before",
    plainFrozen && plainFrozen.at >= 3000 + num("FRAME_FREEZE_MS") - 100 && plainFrozen.at <= 3000 + num("FRAME_FREEZE_MS") + 250 && reuploads(plain) >= 1,
    JSON.stringify(plain.slice(0, 4)));
  check("maybeSwap() opens the window at the ACK, right after the trace's acknowledgement",
    /if \(trace\) trace\.acknowledged\(\);\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*if \(typeof noteSwapAcknowledged === "function"\) noteSwapAcknowledged\(\);/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
