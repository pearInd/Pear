/* THE MOVEMENT DROPOUT regression test - the frame cover over a body re-drape.

   REPORTED, on video: the correct white graphic tee at 00:00; at 00:01-00:02 it is gone,
   replaced by a plain generic tee; at 00:03 it is back. During body movement.

   ROOT CAUSE, and it is the one the ATOMIC CONDITIONING GATE already spells out in
   createThrottledInputStream(): Decart renders every frame it is handed, and a full
   set({ image }) needs a datachannel round-trip to land. Frames arriving inside that
   round-trip get rendered against conditioning that is mid-replacement, so the most
   probable completion is the model's own prior - a generic garment. That gate closes the
   window at session START and is one-shot (release() returns false once open and never
   re-closes), so nothing covered the same window when reconditionForTopology() re-uploads
   on movement.

   FIX: cover it the way a confirmed front/back swap is already covered - snapshot the last
   good dressed frame, hold it over #aiVideo for the round-trip, cross-fade back once the
   new conditioning has landed.

   WHY A SEPARATE COVER FROM THE ORIENTATION HOLD, which is the part most likely to be
   "simplified" later: the orientation watcher calls orientHoldEnd("turn-abandoned") from
   its own 250ms tick whenever no front/back turn is in progress - which is nearly always,
   during a plain re-drape. Sharing _orientHoldActive would let that tick tear this cover
   down mid-re-upload, within one tick of it going up. §4 pins the separation.

   This drives the REAL redrapeCoverBegin/redrapeCoverEnd pair against a stubbed DOM. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

const coverSrc = extract("const REDRAPE_HOLD_MAX_MS", "/* ── Freeze THROUGH the turn");
check("extracted the re-drape cover pair",
  /function redrapeCoverBegin/.test(coverSrc) && /function redrapeCoverEnd/.test(coverSrc));

/* A DOM thin enough to be obviously faithful: the cover only ever needs one <video> to
   read pixels from, one container to append to, and one canvas to paint on. */
function harness({ videoWidth = 640, videoHeight = 480, hasCard = true } = {}) {
  const events = [];
  const timers = [];
  const canvas = {
    id: "", width: 0, height: 0, offsetWidth: 1,
    style: {},
    getContext: () => ({ drawImage: (src) => events.push({ op: "draw", src: src && src.tag }) }),
  };
  const card = { tag: "cameraCard", children: [], appendChild: (c) => card.children.push(c) };
  const ai = { tag: "aiVideo", videoWidth, videoHeight };
  const styles = {};
  const sandbox = {
    ORIENT_DEBUG: false,
    ORIENT_FADE_MS: 260,
    console: { log() {}, warn: (...a) => events.push({ op: "warn", a }) },
    $: (id) => (id === "aiVideo" ? ai : id === "cameraCard" ? (hasCard ? card : null) : null),
    document: {
      getElementById: (id) => styles[id] || null,
      createElement: (tag) => (tag === "canvas" ? canvas : { set id(v) { styles[v] = this; }, textContent: "" }),
      head: { appendChild() {} },
    },
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  const api = new Function(...Object.keys(sandbox),
    coverSrc +
    "\nreturn { redrapeCoverBegin, redrapeCoverEnd, active: () => _redrapeHoldActive," +
    " MAX: REDRAPE_HOLD_MAX_MS };"
  )(...Object.values(sandbox));
  return {
    api, events, canvas, card, timers,
    liveTimers: () => timers.filter((t) => t.live),
    fireTimers: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }),
  };
}

console.log("\n── §1 the cover goes up on a frame that is still GOOD ──");
{
  const { api, events, canvas } = harness();
  const raised = api.redrapeCoverBegin();
  check("a cover is raised", raised === true && api.active() === true);
  /* The snapshot must come from #aiVideo - Decart's own output, the only display source a
     live session has. Reading the camera here would put a raw un-dressed frame on screen,
     which is the single-surface invariant's whole subject. */
  check("...snapshotting #aiVideo, not the camera",
    events.some((e) => e.op === "draw" && e.src === "aiVideo"),
    JSON.stringify(events));
  check("...sized to the video's real dimensions", canvas.width === 640 && canvas.height === 480);
  /* An instant cut onto a frame identical to what is already on screen is invisible; a
     transition here would fade the cover IN, which is a visible dip to the live feed
     underneath at exactly the wrong moment. */
  check("...shown with no fade-in (an instant cut onto an identical frame is invisible)",
    canvas.style.opacity === "1");
  check("...and re-arms the fade for the reveal", /260ms/.test(canvas.style.transition || ""));
}

console.log("\n── §2 it never re-snapshots, for the reason the turn hold never does ──");
{
  /* A second snapshot part-way through the re-upload would capture the generic-garment
     frame the cover exists to hide, and then hold THAT up. */
  const { api, events } = harness();
  api.redrapeCoverBegin();
  const drawsAfterFirst = events.filter((e) => e.op === "draw").length;
  const second = api.redrapeCoverBegin();
  check("a second begin() is refused", second === false);
  check("...and takes no second snapshot",
    events.filter((e) => e.op === "draw").length === drawsAfterFirst);
}

console.log("\n── §3 the reveal, the ceiling, and the failure paths ──");
{
  const { api, canvas, liveTimers } = harness();
  api.redrapeCoverBegin();
  check("a ceiling timer is armed", liveTimers().length === 1);
  check("...at REDRAPE_HOLD_MAX_MS", liveTimers()[0].ms === api.MAX, String(liveTimers()[0].ms));
  api.redrapeCoverEnd("re-drape settled");
  check("end() fades the cover out", canvas.style.opacity === "0");
  check("...clears the hold flag", api.active() === false);
  /* A surviving ceiling would fire into the NEXT re-drape and reveal it early. */
  check("...and disarms the ceiling so it cannot fire into a later cover",
    liveTimers().length === 0);
}
{
  const { api, canvas, events, fireTimers } = harness();
  api.redrapeCoverBegin();
  fireTimers();
  check("the ceiling reveals the live feed rather than leaving a still up",
    api.active() === false && canvas.style.opacity === "0");
  check("...and says so, because reaching it means an apply hung",
    events.some((e) => e.op === "warn"), JSON.stringify(events));
}
{
  /* Every session-ending path calls end() unconditionally, so it must be safe when no
     cover is up - otherwise teardown throws on the common case. */
  const { api } = harness();
  let threw = false;
  try { api.redrapeCoverEnd("session-torn-down"); } catch (_) { threw = true; }
  check("end() with no cover up is a safe no-op", threw === false && api.active() === false);
}
{
  /* THE ONE CASE WHERE COVERING WOULD CREATE THE ARTIFACT. With no decoded frame there is
     nothing good to snapshot, and holding a blank canvas over a live feed is strictly
     worse than showing the feed. */
  const { api, liveTimers } = harness({ videoWidth: 0 });
  const raised = api.redrapeCoverBegin();
  check("no decoded frame yet -> no cover, and it says so to the caller",
    raised === false && api.active() === false);
  check("...and arms no ceiling for a cover that never went up", liveTimers().length === 0);
}

console.log("\n── §4 wiring: raised before the send, released in a finally, never shared ──");
{
  const recondition = extract("async function reconditionForTopology(step) {",
    "\n/* ── end body-presence gate ── */");

  /* ORDER IS THE WHOLE POINT. At entry #aiVideo still carries a dressed frame; once the
     three wire-state fields are cleared and applyActive() is away, it does not. A cover
     raised after the send would snapshot the very frame it exists to hide - which is the
     mistake the front/back hold made before it was moved to the first disagreeing vote. */
  const coverAt = recondition.indexOf("redrapeCoverBegin()");
  const clearAt = recondition.indexOf("lastSentImageRef = null;");
  const applyAt = recondition.indexOf("await applyActive();");
  check("the cover is raised BEFORE the wire state is cleared",
    coverAt !== -1 && clearAt !== -1 && coverAt < clearAt, `cover@${coverAt} clear@${clearAt}`);
  check("...and before the re-upload is dispatched",
    coverAt !== -1 && applyAt !== -1 && coverAt < applyAt, `cover@${coverAt} apply@${applyAt}`);

  /* Acknowledgement is not arrival: applyActive() resolving means Decart accepted the new
     conditioning, not that a frame rendered from it has decoded. Revealing on the
     acknowledgement alone uncovers the last frames of the OLD conditioning. */
  check("a grace period separates the acknowledgement from the reveal",
    /if \(covered\) await new Promise\(\(r\) => setTimeout\(r, ORIENT_FADE_HOLD_MS\)\);/.test(recondition),
    "revealing on resolve alone flashes the frame the cover was raised to hide");

  /* A rejected applyActive() must still reveal. A still frame held over a failed re-drape
     freezes the shopper out of their own session with nothing to recover it but the
     ceiling. */
  const finallyIdx = recondition.indexOf("} finally {");
  const endIdx = recondition.indexOf('redrapeCoverEnd("re-drape settled")');
  check("the cover is released in the finally, so a failed re-drape still reveals",
    finallyIdx !== -1 && endIdx > finallyIdx, `finally@${finallyIdx} end@${endIdx}`);

  /* THE COLLISION THIS SUITE EXISTS FOR. orientHoldEnd("turn-abandoned") runs from the
     orientation watcher's 250ms tick whenever no front/back turn is in progress. If this
     cover rode on _orientHoldActive, that tick would release it within one tick of it
     going up - mid-re-upload, which is exactly the window being covered. */
  check("the re-drape cover does NOT ride on the orientation hold's flag",
    !/_orientHoldActive\s*=/.test(coverSrc),
    "orientHoldEnd(\"turn-abandoned\") fires from a 250ms tick and would release this early");
  check("...while reconditionForTopology still declines to run during a real swap",
    /if \(_orientHoldActive\) return;/.test(recondition));

  /* A cover outliving its session sits on top of whatever renders next - the frozen-hold
     tail, or the next session's first frame. */
  const teardown = extract("function teardown() {", "\n/**\n * Full exit teardown");
  check("teardown() releases any cover that is still up",
    /redrapeCoverEnd\("session-torn-down"\)/.test(teardown));
  check("...and so does the billing stop, which leaves the paint loop alive",
    /redrapeCoverEnd\("billing-stopped"\)/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
