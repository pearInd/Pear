/* THE INPUT GATE'S LIFECYCLE - which path opens it, when, and what leaks if none does.

   WHY THIS EXISTS SEPARATELY FROM first-frame-integrity. That suite owns the gate's CONTRACT:
   it withholds frames and not the track, one call site owns the meaning of "a garment is on the
   wire", it cannot strand a session, and (§1c) the settle holds frames past the acknowledgement.
   This one owns the gate's TIMING against the rest of the cold start - the numbers that decide
   whether the ceiling can ever fire in a real session, which is a question about how
   INPUT_GATE_MAX_MS, COLD_START_ACK_MS and connectRealtime()'s dispose/mint cycle sit relative
   to each other, not about the gate's own API.

   THE REPORT IT CAME FROM: "frame 00:01 flashes a totally wrong white shirt", diagnosed as the
   gate's 6000ms ceiling auto-releasing before the garment payload landed. It is not that - the
   three paths below show why - and the value of pinning it is that the NEXT person to propose
   the same fix can read the reason in a test rather than re-deriving it. The white-shirt render
   is Decart's own prior for "person on a webcam", which is what the gate exists to starve.

   WHAT IT PINS:
     §1  the ordering invariant: the cold-start leash is strictly inside the ceiling, so a
         first apply is always decided - resolved or timed out - before the ceiling can fire;
     §2  the healthy path leaks nothing, and says so in one line;
     §3  the ceiling path leaks frames and WARNS - the one signature that identifies it in a
         live console, which is what makes the report diagnosable at all;
     §4  the recovery path disposes the first gate rather than racing it, so the ceiling is
         cancelled and the new session starts behind a fresh one;
     §5  the settle is what actually opens the gate on the healthy path, and both the ceiling
         and the settle are timers - so something always opens it (the anti-strand guarantee).

   Sibling suites: first-frame-integrity.test.mjs (the gate's contract and the display half),
   apply-timeout.test.mjs (the cold-start leash and its recovery). */
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

/* The REAL throttle, driven against a fake camera - the same extraction first-frame-integrity
   uses, so this observes the shipped state machine rather than pattern-matching its source. */
const code = extract("function createThrottledInputStream(", "\n/**\n * Open the input gate");

function makeGate({ gateMaxMs = CONFIG.INPUT_GATE_MAX_MS, settleMs = CONFIG.INPUT_GATE_SETTLE_MS } = {}) {
  const state = { emitted: 0, timers: new Set(), logs: [], warns: [], now: 0 };
  const outTrack = { contentHint: "", requestFrame() { state.emitted++; }, stop() {} };
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    INPUT_GATE_ENABLED: true, INPUT_GATE_MAX_MS: gateMaxMs, INPUT_GATE_SETTLE_MS: settleMs,
    console: {
      log: (...a) => state.logs.push(a.join(" ")),
      warn: (...a) => state.warns.push(a.join(" ")),
    },
    setInterval: (fn, ms) => { const id = { fn, ms }; state.timers.add(id); return id; },
    clearInterval: (id) => state.timers.delete(id),
    setTimeout: (fn, ms) => { const id = { fn, ms, isTimeout: true }; state.timers.add(id); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } },
    document: { createElement: () => ({
      srcObject: null, videoWidth: 640, videoHeight: 360, width: 0, height: 0,
      play: () => Promise.resolve(), pause() {},
      getContext: () => ({ save() {}, restore() {}, setTransform() {}, drawImage() {} }),
      captureStream: () => ({ getVideoTracks: () => [outTrack] }),
    }) },
  };
  const fn = new Function(...Object.keys(sandbox), code + "\nreturn createThrottledInputStream;")(...Object.values(sandbox));
  const srcStream = { getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }], getTracks: () => [] };
  const throttle = fn(srcStream, { fps: 10, gated: true, gateMaxMs, settleMs, clock: () => state.now });
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = (n = 1) => { for (const t of state.timers) if (!t.isTimeout) for (let i = 0; i < n; i++) t.fn(); };
  const fireTimeouts = () => { for (const t of [...state.timers]) if (t.isTimeout) { state.timers.delete(t); t.fn(); } };
  return { throttle, state, flush, tick, fireTimeouts };
}

console.log("── §1 THE ORDERING INVARIANT: the leash decides before the ceiling can fire ──");
{
  /* THIS IS THE WHOLE ANSWER to "did the ceiling cause the white shirt". applyConditioningWithRecovery()
     races the first apply against COLD_START_ACK_MS, so by that moment the apply has either resolved
     (release, §2) or timed out into the recovery (dispose + fresh gate, §4). Either way the ceiling
     has been cancelled. It can only fire if this ordering is ever inverted. */
  check("the cold-start leash is strictly inside the gate's ceiling",
    CONFIG.COLD_START_ACK_MS < CONFIG.INPUT_GATE_MAX_MS,
    `leash ${CONFIG.COLD_START_ACK_MS}ms vs ceiling ${CONFIG.INPUT_GATE_MAX_MS}ms - inverted, the ceiling fires first and the session streams undressed`);
  check("...and the first apply is actually raced against that leash, not the full budget",
    /await race\(applyActive\(\), "", COLD_START_ACK_MS\)/.test(SRC));
  check("...while the settle that follows a release still leaves the ceiling room",
    CONFIG.INPUT_GATE_SETTLE_MS < CONFIG.INPUT_GATE_MAX_MS - CONFIG.COLD_START_ACK_MS,
    `settle ${CONFIG.INPUT_GATE_SETTLE_MS}ms, leash ${CONFIG.COLD_START_ACK_MS}ms, ceiling ${CONFIG.INPUT_GATE_MAX_MS}ms`);
}

console.log("\n── §2 THE HEALTHY PATH LEAKS NOTHING ──");
{
  const h = makeGate(); await h.flush();
  h.tick(12);
  check("nothing reaches Decart while the reference is still in flight",
    h.state.emitted === 0, `${h.state.emitted} frames leaked pre-conditioning`);
  h.throttle.release("applyActive");
  h.fireTimeouts();          // the settle
  h.tick(3);
  check("frames flow only after the acknowledgement and its settle",
    h.state.emitted === 3, `${h.state.emitted}`);
  check("...and the console carries the release line that identifies this path",
    h.state.logs.some((l) => /input gate released \(applyActive\)/.test(l)),
    h.state.logs.join("\n        "));
  check("...with no warning, because nothing went wrong",
    h.state.warns.length === 0, h.state.warns.join("\n        "));
}

console.log("\n── §3 THE CEILING PATH IS THE ONE THAT LEAKS - AND IT IS LOUD ──");
{
  const h = makeGate(); await h.flush();
  h.tick(5);
  check("still shut while nothing has acknowledged", h.state.emitted === 0);
  h.fireTimeouts();
  h.tick(3);
  check("the ceiling opens the gate rather than stranding the session",
    h.state.emitted === 3, `${h.state.emitted}`);
  /* THE DIAGNOSTIC CONTRACT. This exact substring is what a live console is grepped for to tell
     "the ceiling fired" from "the reference simply lost the race to the first frame" - two causes
     of the same white-shirt symptom with completely different fixes. */
  check("...and it is the ONLY path that warns, naming the ceiling and its duration",
    h.state.warns.some((w) => /input gate: auto-released after \d+ms/.test(w)),
    h.state.warns.join("\n        "));
  check("...and it says the frames it is about to stream may not carry the garment",
    h.state.warns.some((w) => /may not carry the garment/.test(w)));
}

console.log("\n── §4 THE RECOVERY DISPOSES THE FIRST GATE, IT DOES NOT RACE IT ──");
{
  const first = makeGate(); await first.flush();
  first.tick(5);
  check("gate #1 held everything while the first apply was in flight", first.state.emitted === 0);
  first.throttle.dispose();
  check("disposing it clears the ceiling timer, so it can never fire into the new session",
    first.state.timers.size === 0, `${first.state.timers.size} timer(s) survived`);
  /* connectRealtime() disposes the old throttle at its top and mints a new one for the new peer
     connection - so the recovery's gate is a fresh one with a full ceiling, not the remains of
     the one the timed-out apply was behind. Asserted against the source because the ordering of
     those two statements is the whole guarantee. */
  const connect = extract("async function connectRealtime(", "\n/**");
  check("...and connectRealtime() disposes before it mints, so the two never coexist",
    connect.indexOf("inputThrottle.dispose()") !== -1 &&
    connect.indexOf("inputThrottle.dispose()") < connect.indexOf("inputThrottle = createThrottledInputStream("),
    "a mint before the dispose would leave the old gate's ceiling armed against the new session");
  const second = makeGate(); await second.flush();
  second.tick(6);
  check("gate #2 starts shut, with its own full ceiling", second.state.emitted === 0);
  second.throttle.release("fallback conditioning");
  second.fireTimeouts();
  second.tick(2);
  check("...and the recovery's own release opens it",
    second.state.emitted === 2 && second.state.logs.some((l) => /fallback conditioning/.test(l)),
    second.state.logs.join("\n        "));
}

console.log("\n── §5 SOMETHING ALWAYS OPENS IT ──");
{
  /* THE ANTI-STRAND GUARANTEE, restated after the settle was added. Before it, the ceiling was the
     only timer that could open a gate nobody released. Now the settle owns the opening on the
     acknowledged path - so the property to hold is that EVERY path out of "shut" ends at a timer
     or a synchronous open, never at nothing. */
  const acked = makeGate(); await acked.flush();
  acked.throttle.release("applyActive");
  check("after a release the gate is still shut, but a timer now owns its opening",
    acked.throttle.gateOpen === false && [...acked.state.timers].some((t) => t.isTimeout),
    "a shut gate with no pending timeout is a stranded session");
  acked.fireTimeouts();
  check("...and that timer opens it", acked.throttle.gateOpen === true);
  const never = makeGate(); await never.flush();
  check("with no release at all, the ceiling is still pending",
    [...never.state.timers].some((t) => t.isTimeout && t.ms === CONFIG.INPUT_GATE_MAX_MS));
  never.fireTimeouts();
  check("...and it opens it", never.throttle.gateOpen === true);
}

console.log(fails ? `\ninput-gate-lifecycle: ${fails} FAILED` : "\ninput-gate-lifecycle: OK");
process.exit(fails ? 1 : 0);
