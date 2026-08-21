/* THE RTC TRANSIENT-ERROR BOUNDARY - "the session crashes after 5 seconds".

   THE REPORT: roughly five seconds into every stream, a Decart error modal appears over
   the fitting room. It reads as a crash and it is not one. Five seconds is
   LIVE_DURATION_MS - the BILLED window - landing exactly on schedule:

     armFirstFrameBilling() -> setTimeout(LIVE_DURATION_MS) -> beginFreezeHold()
       -> stopBilling() -> rtClient.disconnect()

   A WebRTC transport being torn down ON PURPOSE routinely emits one last "error" on its
   way out. The handler that received it was unconditional:

     rtClient.on("error", (err) => { showCamError("שגיאת Decart: " + err.message); });

   so the NORMAL, SUCCESSFUL end of every single session painted a failure modal over the
   frozen result the shopper was meant to be looking at. Nothing had failed; only the
   reporting had.

   THREE SEPARATE DEFECTS IN ONE LINE, and this suite owns all three:

     1. NO GENERATION CHECK. Every other callback in connectRealtime() closes over `gen`
        and bails once sessionGen has moved on (onRemoteStream and onConnectionStateChange
        both do). This one did not, so a dead session's dying error could surface over
        whatever the NEXT session was doing.
     2. NO LIVENESS CHECK. stopBilling() bumps sessionGen, so (1) happens to cover the
        deliberate teardown too - but only as a side effect, which is exactly the kind of
        coupling that stops being true quietly. isLive() is asserted on its own merits.
     3. NO TRANSIENT TOLERANCE. The SDK reconnects internally (5 attempts) and signals
        genuine death by driving the connection state to "disconnected", which
        onConnectionStateChange already retires the session on. One "error" event means a
        frame dropped and the recovery is ALREADY RUNNING - interrupting the shopper for
        it is strictly wrong.

   HOW THIS SUITE WORKS: it EXTRACTS the real handler out of app.js and EXECUTES it
   against a hand-built sandbox - the same technique lower-body-guard.test.mjs and
   prompt-reanchor.test.mjs use. Asserting the behaviour rather than the source text is
   what makes this a regression fence: a reworded handler that reintroduces the modal
   fails here, and a source-grep suite would not notice. */
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

/* The REAL registration block, verbatim from app.js - counter declaration included,
   because "the counter is per-session" is one of the properties under test and it is the
   PLACEMENT of that declaration (inside the connect closure) that makes it true. */
const HANDLER_SRC = extract(
  "let transientErrors = 0, transientWindowAt = 0;",
  "connState = (rtClient.getConnectionState");

/* Build one isolated "session": run the extracted code with every free identifier bound
   to a controllable stub. `sessionGen` is a real `let` in the generated scope so a test
   can move it the way stopBilling() does, and Date is shadowed so the rolling window can
   be driven without sleeping. */
function makeSession({ gen = 1, sessionGen = 1, live = true } = {}) {
  const modals = [], warns = [], errors = [];
  let now = 1_000_000;
  const deps = {
    gen, sessionGen,
    isLive: () => live,
    showCamError: (m) => modals.push(m),
    console: { warn: (...a) => warns.push(a.join(" ")), error: (...a) => errors.push(a.join(" ")) },
    Date: { now: () => now },
    ERROR_WINDOW_MS: CONFIG.ERROR_WINDOW_MS,
    ERROR_MODAL_THRESHOLD: CONFIG.ERROR_MODAL_THRESHOLD,
  };
  const factory = new Function("deps", `
    "use strict";
    const { gen, isLive, showCamError, console, Date,
            ERROR_WINDOW_MS, ERROR_MODAL_THRESHOLD } = deps;
    let sessionGen = deps.sessionGen;
    let handler = null;
    const rtClient = { on: (evt, fn) => { if (evt === "error") handler = fn; } };
    ${HANDLER_SRC}
    return {
      fire: (e) => handler(e),
      registered: () => typeof handler === "function",
      setSessionGen: (v) => { sessionGen = v; },
    };
  `)(deps);
  return {
    ...factory,
    modals, warns, errors,
    setLive: (v) => { live = v; },
    advance: (ms) => { now += ms; },
  };
}

console.log("── §1 THE REPORTED BUG: the billed window's own disconnect is not a crash ──");
{
  /* THE EXACT SEQUENCE FROM THE REPORT. beginFreezeHold() fires at LIVE_DURATION_MS and
     calls stopBilling(), which does two things this handler must respect: it bumps
     sessionGen, and it tears the connection down so isLive() goes false. The parting
     "error" from the transport arrives AFTER both. */
  const s = makeSession({ gen: 7, sessionGen: 7, live: true });
  check("the handler is actually registered on the 'error' event", s.registered());

  s.setSessionGen(8);          // stopBilling(): sessionGen++
  s.setLive(false);            // ...and the connection is gone
  s.fire(new Error("PeerConnection closed"));
  check("THE BUG: the end-of-window disconnect shows the shopper NOTHING",
    s.modals.length === 0,
    `a successful session must not end in a modal - got: ${JSON.stringify(s.modals)}`);
  check("...and it is still recorded, so the console keeps every one of them",
    s.warns.some((w) => /after the session closed/.test(w)),
    "swallowed is not the same as hidden - a dropped error must still be traceable");
  check("...and it is NOT logged as an error, which is what made this read as a crash",
    s.errors.length === 0, JSON.stringify(s.errors));
}

console.log("\n── §2 THE THREE GUARDS, each failing on its own merits ──");
{
  /* (1) STALE GENERATION - a previous session's error arriving after a new one opened. */
  const stale = makeSession({ gen: 3, sessionGen: 9, live: true });
  for (let i = 0; i < 10; i++) stale.fire(new Error("late failure from a dead session"));
  check("a superseded session's errors never reach the screen, at any volume",
    stale.modals.length === 0,
    "gen !== sessionGen is the same bail every other callback in connectRealtime() uses");

  /* (2) NOT LIVE - the connection is already retired, but the generation happens to
     match. This is the case that fails if the isLive() half is ever dropped as
     redundant: it is only redundant while stopBilling() keeps bumping the counter. */
  const dead = makeSession({ gen: 4, sessionGen: 4, live: false });
  for (let i = 0; i < 10; i++) dead.fire(new Error("error on a retired connection"));
  check("an error against a retired connection is dropped on its OWN check, not by luck",
    dead.modals.length === 0,
    "this is the assertion that survives someone 'simplifying' stopBilling()");

  /* (3) TRANSIENT - live, current, and genuinely mid-stream. Below the threshold this is
     a dropped frame with the SDK's own reconnect already running. */
  const live = makeSession({ gen: 5, sessionGen: 5, live: true });
  for (let i = 0; i < CONFIG.ERROR_MODAL_THRESHOLD - 1; i++) live.fire(new Error("frame drop"));
  check(`${CONFIG.ERROR_MODAL_THRESHOLD - 1} transient errors mid-stream stay silent - the SDK is recovering`,
    live.modals.length === 0, JSON.stringify(live.modals));
  check("...and each one names its own position in the count, so a trace is readable",
    live.warns.some((w) => /1\/3 in 4000ms - transient/.test(w)),
    JSON.stringify(live.warns));
}

console.log("\n── §3 A GENUINELY FAILING TRANSPORT STILL REACHES THE SHOPPER ──");
{
  /* THE BOUNDARY IS NOT A MUTE BUTTON. Swallowing everything would trade a false alarm
     for a silent failure, which is the worse of the two. At the threshold - a transport
     erroring repeatedly inside one window rather than hiccupping once - the modal is
     exactly the right output. */
  const s = makeSession({ gen: 2, sessionGen: 2, live: true });
  for (let i = 0; i < CONFIG.ERROR_MODAL_THRESHOLD; i++) s.fire(new Error("ICE failed"));
  check(`${CONFIG.ERROR_MODAL_THRESHOLD} errors inside one window DOES surface a modal`,
    s.modals.length === 1, `${s.modals.length} modal(s): ${JSON.stringify(s.modals)}`);
  check("...carrying the underlying message, not a generic string",
    /ICE failed/.test(s.modals[0] || ""), s.modals[0]);
  check("...and logged at error level, unlike the transient ones",
    s.errors.length === 1 && /ICE failed/.test(s.errors[0]), JSON.stringify(s.errors));

  /* THE WINDOW IS ROLLING, which is what stops three unrelated hiccups spread across a
     long session from accumulating into a false alarm. Two errors, a gap longer than the
     window, then two more: four errors total, never three inside one window. */
  const spread = makeSession({ gen: 6, sessionGen: 6, live: true });
  spread.fire(new Error("a"));
  spread.fire(new Error("b"));
  spread.advance(CONFIG.ERROR_WINDOW_MS + 1);
  spread.fire(new Error("c"));
  spread.fire(new Error("d"));
  check("four errors spread across two windows never accumulate into an alarm",
    spread.modals.length === 0,
    `the window is rolling, not a lifetime tally - got ${JSON.stringify(spread.modals)}`);
  check("...but the counter genuinely resets rather than merely slowing down",
    spread.warns.filter((w) => /1\/3 in/.test(w)).length === 2,
    "two windows opened, so position 1 must be reported twice");
}

console.log("\n── §4 THE COUNTER IS PER-SESSION BY CONSTRUCTION ──");
{
  /* NOT BY A RESET SOMEONE HAS TO REMEMBER TO CALL. The declaration lives inside the
     connectRealtime() closure, so a new session gets a new counter and there is no reset
     path that can be forgotten - which is the failure mode of every module-scope counter
     this file has ever carried. Asserted structurally AND behaviourally. */
  check("the counter is declared inside connectRealtime(), not at module scope",
    !/^let transientErrors/m.test(APP) && /\n    let transientErrors = 0, transientWindowAt = 0;/.test(APP),
    "a module-scope counter would carry one session's hiccups into the next");

  const first = makeSession({ gen: 1, sessionGen: 1, live: true });
  for (let i = 0; i < CONFIG.ERROR_MODAL_THRESHOLD - 1; i++) first.fire(new Error("x"));
  const second = makeSession({ gen: 2, sessionGen: 2, live: true });
  second.fire(new Error("first error of a brand-new session"));
  check("a fresh session starts the count at zero, with no reset call involved",
    second.modals.length === 0 && second.warns.some((w) => /1\/3 in/.test(w)),
    JSON.stringify(second.warns));
}

console.log("\n── §5 THE TERMINAL PATH IS UNTOUCHED - this is a boundary, not a bypass ──");
{
  /* WHAT THIS FIX MUST NOT DO IS SWALLOW A REAL DEATH. The SDK signals a permanent
     failure by driving the connection state to "disconnected" after "reconnecting", and
     connectRealtime()'s onConnectionStateChange retires the session there - a path this
     handler does not touch and must not need to. Fenced here because the two are easy to
     conflate: if someone later decides the error handler should own terminal failure too,
     these assertions are what tell them the other half already exists. */
  check("onConnectionStateChange still retires the session on an exhausted reconnect",
    /if \(state === "disconnected" && prevState === "reconnecting"\) \{[\s\S]{0,200}?stopLive\(\);/.test(APP),
    "the terminal path is the state machine's, not the error event's");
  check("...and the billed window still ends through beginFreezeHold(), on a timer",
    /liveDurationTimer = setTimeout\(\(\) => \{[\s\S]{0,400}?beginFreezeHold\(\);/.test(APP),
    "5 seconds is a scheduled, successful ending - the thing the modal was misreporting");
  check("...and that ending still disconnects, which is what emits the parting error",
    /function stopBilling\(\) \{[\s\S]{0,600}?rtClient\.disconnect\(\)/.test(APP),
    "if this ever stops being true, §1's premise needs re-checking rather than deleting");
}

console.log("\n── §6 THE TUNING CONSTANTS ARE CONFIG, not literals in the handler ──");
{
  check("ERROR_MODAL_THRESHOLD is a small positive integer",
    Number.isInteger(CONFIG.ERROR_MODAL_THRESHOLD) &&
    CONFIG.ERROR_MODAL_THRESHOLD >= 2 && CONFIG.ERROR_MODAL_THRESHOLD <= 10,
    String(CONFIG.ERROR_MODAL_THRESHOLD));
  check("...and 1 is explicitly NOT allowed - that is the unconditional handler again",
    CONFIG.ERROR_MODAL_THRESHOLD > 1, String(CONFIG.ERROR_MODAL_THRESHOLD));
  /* LIVE_DURATION_MS lives in app.js, not config.js (it is a billing constant, not a
     tuning one), so it is read out of the source rather than imported. The relationship
     is the point: a window longer than the billed session could never fill, which would
     make the threshold unreachable and the boundary a permanent mute. */
  const billedMs = Number((APP.match(/const LIVE_DURATION_MS\s*=\s*(\d+);/) || [])[1]);
  check("ERROR_WINDOW_MS is shorter than the billed window it has to fit inside",
    Number.isFinite(billedMs) && CONFIG.ERROR_WINDOW_MS > 0 && CONFIG.ERROR_WINDOW_MS <= billedMs,
    `window=${CONFIG.ERROR_WINDOW_MS} billed=${billedMs}`);
  check("the handler reads both from config rather than hardcoding them",
    /ERROR_WINDOW_MS/.test(HANDLER_SRC) && /ERROR_MODAL_THRESHOLD/.test(HANDLER_SRC) &&
    /\n  ERROR_MODAL_THRESHOLD,\n  ERROR_WINDOW_MS,/.test(APP),
    "tuning a live-stream threshold should not mean editing the handler");
  check("config.js records WHY the count is a count and not a boolean",
    /WHY A COUNT AND NOT A BOOLEAN/.test(
      readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8")),
    "the SDK's own 5-attempt reconnect is the reason - it belongs next to the number");
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
