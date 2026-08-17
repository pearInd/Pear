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

function makeThrottle({ gated = true, gateMaxMs = 5000, fps = 50 } = {}) {
  const state = { emitted: 0, drawn: 0, trackStopped: false, timers: new Set(), logs: [], warns: [] };
  const outTrack = {
    contentHint: "",
    requestFrame() { state.emitted++; },
    stop() { state.trackStopped = true; },
  };
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    INPUT_GATE_ENABLED: gated, INPUT_GATE_MAX_MS: gateMaxMs,
    console: {
      log: (...a) => state.logs.push(a.join(" ")),
      warn: (...a) => state.warns.push(a.join(" ")),
    },
    setInterval: (fn, ms) => { const id = { fn, ms }; state.timers.add(id); return id; },
    clearInterval: (id) => state.timers.delete(id),
    setTimeout: (fn, ms) => { const id = { fn, ms, isTimeout: true }; state.timers.add(id); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } },
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
  const throttle = fn(srcStream, { fps, gated, gateMaxMs });
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
  check("...and every path that retires or re-uses the element calls it",
    (SRC.match(/resetAiFeedVisibility\(\)/g) || []).length === 4,   // definition + 2 teardowns + clip replay
    `${(SRC.match(/resetAiFeedVisibility\(\)/g) || []).length} sites - expected the definition, both teardowns and the clip player`);
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
  check("...and the rate is capped below the local capture rate",
    /const LIVE_FPS\s+= 15;/.test(SRC) && /const LIVE_INFERENCE_FPS\s+= 10;/.test(SRC),
    "the preview stays smooth locally; only 10 frames/s ever leave the browser");

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

console.log("\n── §6 THE SAFETY MACHINERY IS UNTOUCHED BY LATER REVISIONS ──");
{
  /* Every prompt/morphology revision lands in the same file as the cold-start machinery,
     and the cheapest way to break a session is to edit one and disturb the other. These
     are the four locks that keep go-live reliable; asserted here as a single fence so a
     future change to the fitting logic cannot quietly remove one. */
  check("the input gate still exists and is still driven by config",
    /gated = INPUT_GATE_ENABLED/.test(SRC) && CONFIG.INPUT_GATE_ENABLED === true);
  check("the wire mutex still serialises every conditioning write",
    /function sendCondition\(label, send, \{ skipIfBusy = false \} = \{\}\)/.test(SRC) &&
    /const next = wireQueue\.then\(run, run\);/.test(SRC));
  check("the cold-start leash and its one recovery are still in place",
    /await race\(applyActive\(\), "", COLD_START_ACK_MS\);/.test(SRC) &&
    /await connectRealtime\(\{ force: true \}\);/.test(SRC));
  check("the loading overlay still gates the reveal, and the fade still rides it",
    /card\(\)\.classList\.add\("show-live"\);[\s\S]{0,600}revealAiFeed\(\);/.test(SRC) &&
    /\$\("scanOverlay"\)\.hidden = true;/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
