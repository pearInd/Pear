/* COLD-START RELIABILITY, THE GARMENT PIN, AND THE CONDITION DEBOUNCE.

   Three reports, three mechanisms, one suite - they are grouped because all three are
   about a session that LOOKS connected doing the wrong thing rather than failing outright.

     1. "On the first widget load the stream fails, times out, or needs the modal
        reopened." connectRealtime() retried exactly ONE failure shape and only once, and
        did not bound the handshake at all - so a connect() that HUNG sat until the
        caller's 12s ceiling, long past the point a shopper has closed the modal.
        "Reopening the modal" was the shopper manually performing the retry.

     2. "Mid-session the render reverts from the target garment to a generic one and back."
        applyGarment() built its payload with `...(imageRef ? { image: imageRef } : {})`,
        so a dispatch that resolved no reference shipped with NO image - and a model with
        nothing to condition on renders its own prior, which is a generic garment.

     3. Re-drapes fired on the LEADING edge of a movement - mid-turn, which is exactly when
        applyGarment()'s flicker-fix comment says swapping the reference smears a print.

   WHAT IS EXECUTED vs GREPPED: the debounce is executed against an injected clock, because
   its whole contract is timing. The handshake and the pin are asserted structurally - they
   live inside connectRealtime()/applyGarment(), which signaling-retry.test.mjs and
   prompt-only-flip.test.mjs already execute in their own sandboxes; duplicating those
   harnesses here would be two copies of the same stub drifting apart. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const connect = SRC.slice(SRC.indexOf("async function connectRealtime("),
                          SRC.indexOf("function teardown() {"));

console.log("── §1 COLD START: every attempt is bounded, and failures retry ──");
{
  /* THE HANG IS THE IMPORTANT HALF. A connect() that rejects was at least visible; one
     that never settles was not bounded here at all. Each attempt now races its own
     ceiling, so a stall is caught while the shopper is still watching. */
  check("each handshake attempt races an explicit ceiling",
    /isHandshakeTimeout = true;/.test(connect) &&
    /Promise\.race\(\[/.test(connect) &&
    /connectP\.finally\(\(\) => clearTimeout\(ceilingTimer\)\)/.test(connect),
    "an unbounded await is how a stalled handshake reached the caller's 12s ceiling");
  /* THE CEILINGS GROW. A fixed 3s would cut off a slow-but-alive network and make cold
     starts fail MORE, which is the opposite of the requirement. */
  check("...and the ceiling doubles per attempt rather than staying fixed",
    /HANDSHAKE_CEILING_MS \* Math\.pow\(2, attempt - 1\)/.test(connect),
    "a fixed short ceiling aborts healthy handshakes on a slow uplink");
  check("...starting at 3s, which is past the p99 of a healthy handshake",
    /const HANDSHAKE_CEILING_MS = 3000;/.test(connect));
  check("...and never exceeding the total CONNECT_TIMEOUT_MS budget",
    /Math\.min\(HANDSHAKE_CEILING_MS \* Math\.pow\(2, attempt - 1\), remaining\)/.test(connect) &&
    /const remaining = Math\.max\(0, CONNECT_TIMEOUT_MS - spent\)/.test(connect),
    "per-attempt ceilings that sum past the budget would just move the timeout");

  /* BACKOFF BETWEEN ATTEMPTS, bounded and short - the gap is for a momentarily overloaded
     signaling server, not for waiting out a real outage. */
  check("retries back off exponentially between attempts",
    /const backoffMs = 250 \* Math\.pow\(2, attempt - 1\);/.test(connect) &&
    /await new Promise\(\(r\) => setTimeout\(r, backoffMs\)\)/.test(connect));
  check("...and the attempt count is bounded - a retry loop, not an infinite one",
    /const HANDSHAKE_MAX_ATTEMPTS = 3;/.test(connect) &&
    /attempt >= HANDSHAKE_MAX_ATTEMPTS/.test(connect));
  check("...and a teardown during the backoff abandons the whole connect",
    /await new Promise\(\(r\) => setTimeout\(r, backoffMs\)\);\s*\n\s*if \(gen !== sessionGen\) return;/.test(connect),
    "backing off into a session the shopper already closed opens a billed one behind them");
}

console.log("\n── §2 AN ABANDONED HANDSHAKE MUST NOT LEAK A BILLED SESSION ──");
{
  /* THE HAZARD THE CEILING CREATES. Abandoning a connect() does not cancel it - the SDK
     may still complete the handshake and open a server-side session with nobody holding
     the handle, which bills until its token expires. Leaking one to save a slow handshake
     would be strictly worse than the bug being fixed, so the disposer is not optional. */
  check("an abandoned attempt disconnects whatever it eventually produces",
    /if \(abandoned\) \{[\s\S]{0,200}?c\.disconnect\(\)/.test(connect),
    "a late-connecting orphan is a billed session with no owner");
  check("...and the disposer is attached unconditionally, before the race",
    connect.indexOf("connectP.then(") < connect.indexOf("Promise.race(["),
    "attaching it only on timeout leaves the success path an unhandled rejection risk");
  check("...with a rejection handler too, so a late failure is not an unhandled rejection",
    /connectP\.then\(\s*\n\s*\(c\) =>[\s\S]{0,260}?\n\s*\(\) => \{\},\s*\n\s*\);/.test(connect),
    "the abandoned promise still settles - both outcomes need an owner");
  check("...and each failed attempt disposes its own throttle/clone",
    /if \(inputThrottle\) \{ try \{ inputThrottle\.dispose\(\); \} catch \(_\) \{\} inputThrottle = null; \}/.test(connect),
    "a dangling throttle holds a cloned camera track open");
}

console.log("\n── §3 AUTH FAILURES STILL FAIL FAST ──");
{
  /* Now that retries are general, the carve-out is what is load-bearing: a bad key or a
     denied camera is a DEFINITE answer, and retrying it three times with backoff spends
     the shopper's time to arrive at the same place while burying a real misconfiguration. */
  check("a fatal-error predicate exists and gates the retry",
    /const isFatalConnectError = \(e\) =>/.test(connect) &&
    /const retriable = !isFatalConnectError\(e\);/.test(connect) &&
    /if \(!retriable \|\|/.test(connect));
  for (const term of ["401", "403", "invalid api key", "unauthorized", "forbidden",
                      "not permitted", "permission denied", "NotAllowedError"]) {
    check(`...covering "${term}"`, connect.includes(term));
  }
}

console.log("\n── §4 THE GARMENT PIN: never blank a working conditioning ──");
{
  const apply = SRC.slice(SRC.indexOf("async function applyGarment(item) {"),
                          SRC.indexOf("function getAnatomicalAnchor()"));
  const look  = SRC.slice(SRC.indexOf("async function applyLook(top, bottom) {"),
                          SRC.indexOf("function buildLookPrompt"));

  /* BOTH DISPATCH PATHS, because a look re-conditions on every re-drape exactly as a
     single garment does and therefore has exactly as many chances to resolve nothing. */
  for (const [name, body, ref] of [["applyGarment", apply, "imageRef"],
                                   ["applyLook", look, "primaryImage"]]) {
    check(`${name}: falls back to the session's acknowledged reference`,
      new RegExp(`if \\(!${ref} && lastAckedImageRef\\) \\{`).test(body),
      "the pin is stamped only after a set() resolves - it is what Decart confirmed holding");
    check(`${name}: ...and ABANDONS the dispatch when nothing is pinned`,
      /DISPATCH ABANDONED/.test(body) && /\n    return;\n/.test(body),
      "an image-less set() replaces working conditioning with the model's own prior");
    check(`${name}: ...so the image key is unconditional in the payload`,
      new RegExp(`image: ${ref},`).test(body) &&
      !new RegExp(`\\.\\.\\.\\(${ref} \\? \\{ image: ${ref} \\}`).test(
        body.slice(body.indexOf("const payload = {"))),
      "an omitted key and an explicit null blank the model identically");
  }

  /* SESSION-SCOPED, and this is the half that could have made the fix worse than the bug:
     carrying one session's garment into the next pins the previous shopper's item onto a
     fresh try-on. Cleared at exactly the three session boundaries, and at none of the
     mid-session invalidations - which is precisely when it has to survive. */
  check("the pin is cleared at exactly three places, all session boundaries",
    (SRC.match(/(?<!let )lastAckedImageRef = null;/g) || []).length === 3,
    "connectRealtime opening one, teardown() and stopBilling() ending one");
  const invalidate = SRC.slice(SRC.indexOf("function invalidateWireState(why) {"),
                               SRC.indexOf("\n}", SRC.indexOf("function invalidateWireState(why) {")));
  /* It READS the pin - the log line reports which garment is still held, which is the
     most useful thing to know when a transport is rebuilt. What it must never do is
     ASSIGN it, so only assignment is forbidden here. */
  check("...and NOT by invalidateWireState() - a rebuilt transport is not a new garment",
    !/lastAckedImageRef\s*=/.test(invalidate) && /abbrevImg\(lastAckedImageRef\)/.test(invalidate),
    invalidate);
}

console.log("\n── §5 THE CONDITION DEBOUNCE: executed, on an injected clock ──");
{
  /* The scheduler's whole contract is timing, so it is RUN rather than grepped - with a
     fake clock and a fake setTimeout, the same technique the rAF-driven suites use. */
  const sched = SRC.slice(SRC.indexOf("let conditionDebounceTimer = null;"),
                          SRC.indexOf("let topologyReconditionInFlight = false;"));

  function harness() {
    const fired = [];
    let now = 0, timers = [], nextId = 1;
    const api = new Function("deps", `
      "use strict";
      const { CONDITION_DEBOUNCE_MS, BODY_RECONDITION_COOLDOWN_MS, Date,
              setTimeout, clearTimeout, isLive, isGarmentApplied,
              reconditionForTopology, console } = deps;
      ${sched}
      return { scheduleRecondition, cancelPendingRecondition,
               pending: () => pendingTopologyStep, timerId: () => conditionDebounceTimer };
    `)({
      CONDITION_DEBOUNCE_MS: CONFIG.CONDITION_DEBOUNCE_MS,
      BODY_RECONDITION_COOLDOWN_MS: CONFIG.BODY_RECONDITION_COOLDOWN_MS,
      Date: { now: () => now },
      setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; },
      clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
      isLive: () => true,
      isGarmentApplied: true,
      reconditionForTopology: async (step) => { fired.push({ step, at: now }); },
      console: { warn() {}, log() {} },
    });
    const advance = (ms) => {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = target;
    };
    return { api, fired, advance, setNow: (v) => { now = v; } };
  }

  const D = CONFIG.CONDITION_DEBOUNCE_MS, C = CONFIG.BODY_RECONDITION_COOLDOWN_MS;

  /* A SETTLED MOVEMENT dispatches once, on the trailing edge - not on the first crossing. */
  {
    const { api, fired, advance } = harness();
    api.scheduleRecondition({ id: "a" });
    advance(D - 1);
    check("nothing dispatches while the movement is still settling",
      fired.length === 0, JSON.stringify(fired));
    advance(2);
    check(`...and exactly one dispatch lands after ${D}ms of quiet`,
      fired.length === 1 && fired[0].step.id === "a", JSON.stringify(fired));
  }

  /* A BURST COALESCES, and the LATEST step wins - the dispatch should describe where the
     body ended up, not where it was when the burst began. */
  {
    const { api, fired, advance } = harness();
    for (const id of ["a", "b", "c", "d"]) { api.scheduleRecondition({ id }); advance(50); }
    check("a burst of shifts has not dispatched yet - they coalesce",
      fired.length === 0, JSON.stringify(fired));
    advance(D);
    check("...into exactly ONE dispatch",
      fired.length === 1, JSON.stringify(fired.map((f) => f.step.id)));
    check("...carrying the LATEST step, not the first",
      fired[0].step.id === "d", fired[0].step.id);
  }

  /* THE MAX-WAIT. Without it a shopper who never stops moving would reset the timer
     forever and get NO re-drape - the exact opposite of continuous re-fitting. */
  {
    const { api, fired, advance } = harness();
    for (let i = 0; i < 40; i++) { api.scheduleRecondition({ id: `m${i}` }); advance(60); }
    check(`continuous movement still dispatches - the max-wait fires it`,
      fired.length >= 1, `fired ${fired.length} times under uninterrupted motion`);
    check(`...no later than the ${C}ms cooldown after the burst began`,
      fired[0].at <= C, `first dispatch at ${fired[0].at}ms, cooldown ${C}ms`);
  }

  /* TEARDOWN CANCELS. A 250ms window is long enough for a session to end inside it. */
  {
    const { api, fired, advance } = harness();
    api.scheduleRecondition({ id: "x" });
    api.cancelPendingRecondition();
    advance(C * 2);
    check("a cancelled debounce never fires", fired.length === 0, JSON.stringify(fired));
    check("...and clears its pending step", api.pending() === null, String(api.pending()));
  }

  check("both session-ending paths cancel it",
    (SRC.match(/cancelPendingRecondition\(\);/g) || []).length >= 2,
    "a pending re-drape must not fire into a torn-down or superseded session");
  check("the debounce window is in the 200-300ms band",
    CONFIG.CONDITION_DEBOUNCE_MS >= 200 && CONFIG.CONDITION_DEBOUNCE_MS <= 300,
    String(CONFIG.CONDITION_DEBOUNCE_MS));
  check("...and is shorter than the cooldown it is capped by",
    CONFIG.CONDITION_DEBOUNCE_MS < CONFIG.BODY_RECONDITION_COOLDOWN_MS,
    `${CONFIG.CONDITION_DEBOUNCE_MS} vs ${CONFIG.BODY_RECONDITION_COOLDOWN_MS}`);
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
