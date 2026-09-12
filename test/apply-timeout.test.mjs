/* THE SILENT-UNDRESS HANG, and the recovery that was added on top of it.

   ROOT CAUSE (the original): goLive()'s initial `await applyActive()` had no timeout of
   its own, unlike the two stages either side of it - waitConnected(CONNECT_TIMEOUT_MS)
   before it, FIRST_FRAME_TIMEOUT_MS after it. If the transport that specific
   rtClient.set() was writing to got torn down and replaced by the SDK's OWN internal
   reconnect (media/signaling hiccups are most likely in exactly this first-second window)
   and the SDK never rejected the now-orphaned promise, the await could hang forever:
   "connected" was already showing (onConnectionChange fires independently of this call),
   the shopper's real camera was already live under it, and the garment simply never
   arrived - no error, no retry, nothing.

   FIX ONE: race applyActive() against APPLY_TIMEOUT_MS, and guard against a supersession
   (the session gets torn down/reconnected while this was waiting) via the same sessionGen
   pattern already used throughout this file for exactly this class of bug.

   FIX TWO - WHAT THIS SUITE NOW ALSO COVERS. The bound was right; ENDING THE SESSION on
   it was not. Shoppers hit "המדידה החיה נכשלה: timeout ממתין ליישום הבגד (rtClient.set
   לא הגיב)" in the modal, with the session torn down under it, for a stage whose likeliest
   cause is a signaling channel that had not finished settling - or, before the wire mutex
   landed, a SECOND set() colliding with this one (goLive arms the orientation watcher
   before it issues its own first apply, and a shopper already standing edge-on trips a
   pose transition inside ~500ms). So the timeout now buys ONE recovery: reset and
   re-initialise the client, re-send a lightweight payload carrying the pristine garment
   image, and tell the shopper in a toast. A second failure is a real one and still ends
   the session exactly as before.

   WHAT THIS SUITE PINS:
     §1  the shape of the guard - a rejecting timeout, no unhandled late settlement;
     §2  the happy path is untouched - no reconnect, no toast, no fallback;
     §3  the recovery fires ONCE on a timeout, in the right order, and reports success;
     §4  the recovery is scoped to TIMEOUTS - a definite failure still propagates
         unmodified rather than spending a second token to fail again;
     §5  supersession on either leg returns false instead of continuing go-live's success
         path against a session that no longer exists;
     §6  a second failure ends the session, so "a genuine hang is visible" still holds;
     §7  the COLD-START leash - the first apply gets 2.5s, not 10s, because the long bound
         is one a shopper answers by closing the widget - and the force flag without which
         the reconnect was a no-op for the very case it exists for.

   This drives the REAL extracted function from app.js - not a reimplementation - via a
   sandbox whose applyActive/connectRealtime/fallback timing the test controls directly. */
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
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

const block = extract("async function applyConditioningWithRecovery()",
                      "/**\n * The retry payload");

console.log("── §1 THE SHAPE OF THE GUARD ──");
{
  check("extracted the guarded apply function",
    /genBefore/.test(block) && /APPLY_TIMEOUT_MS/.test(block) && /Promise\.race/.test(block));
  check("the race includes a rejecting timeout, not just the apply promise",
    /timer = setTimeout\(\(\) => \{/.test(block) && /reject\(e\);/.test(block));
  check("a late resolution can never become an unhandled rejection",
    /promise\.catch\(\(\) => \{\}\);/.test(block),
    "a promise that settles after the race has moved on must already own a handler");
  /* The timer is cleared when the apply wins, so a resolved go-live does not leave an
     APPLY_TIMEOUT_MS-long timer holding the event loop (and, under a fake-timer harness,
     firing into a session that has long since finished). */
  check("...and the timeout timer is cleared once the apply settles first",
    /promise\.finally\(\(\) => clearTimeout\(timer\)\)/.test(block));
  check("goLive() delegates to it rather than racing inline",
    /if \(!await applyConditioningWithRecovery\(\)\) return;/.test(SRC),
    "two copies of this logic is how one of them stops recovering");
}

/* `applyActiveImpl(bump)` is supplied by each test; `bump` is a closure over the
   SANDBOX's own `sessionGen` (not the test's outer scope - there is no shared primitive
   to reach across the sandbox boundary otherwise), so a mock that wants to simulate "a
   reconnect superseded this session while we were waiting" calls it before settling.
   connectRealtime bumps it too, exactly as the real one does. */
async function run({
  applyActiveImpl,
  fallbackImpl = () => Promise.resolve(),
  connectImpl = () => Promise.resolve(),
  timeoutMs = 20,
  coldStartMs = timeoutMs,
  busy = true,
} = {}) {
  const calls = { connect: 0, fallback: 0, waits: 0, toasts: [], warns: 0 };
  const quiet = { log() {}, warn() { calls.warns++; }, error() {} };
  const fn = new Function(
    "applyActiveImpl", "fallbackImpl", "connectImpl", "APPLY_TIMEOUT_MS",
    "COLD_START_ACK_MS", "CONNECT_TIMEOUT_MS", "setTimeout", "clearTimeout", "calls",
    "startBusy", "console", "resetConditionWire",
    "return (async () => {\n" +
    "let sessionGen = 1;\n" +
    "let busy = startBusy;\n" +
    "const bump = () => { sessionGen++; };\n" +
    "const applyActive = () => applyActiveImpl(bump);\n" +
    "const applyFallbackConditioning = () => { calls.fallback++; return fallbackImpl(bump); };\n" +
    // The real one takes { force } and claims a fresh generation - which is why the
    // recovery re-reads sessionGen afterwards rather than comparing against genBefore.
    "const connectRealtime = async (opts) => { calls.connect++; calls.forced = !!(opts && opts.force); await connectImpl(); sessionGen++; };\n" +
    "const waitConnected = async () => { calls.waits++; };\n" +
    "const toast = (m) => calls.toasts.push(m);\n" +
    block +
    "\nreturn { result: await applyConditioningWithRecovery(), calls };\n" +
    "})();"
  );
  return fn(applyActiveImpl, fallbackImpl, connectImpl, timeoutMs, coldStartMs, timeoutMs,
            setTimeout, clearTimeout, calls, busy, quiet,
            () => { calls.flushes = (calls.flushes || 0) + 1; });
}

console.log("\n── §2 THE HAPPY PATH IS UNTOUCHED ──");
{
  const { result, calls } = await run({
    applyActiveImpl: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  check("an apply that lands in time reports success", result === true);
  check("...and costs no reconnect, no toast and no fallback send",
    calls.connect === 0 && calls.fallback === 0 && calls.toasts.length === 0,
    JSON.stringify(calls));
}

console.log("\n── §3 THE TIMEOUT BUYS ONE RECOVERY ──");
{
  const { result, calls } = await run({
    applyActiveImpl: () => new Promise(() => {}),    // never settles - the orphaned-promise case
    timeoutMs: 15,
  });
  check("a hung apply recovers instead of ending the session", result === true);
  check("...by resetting the realtime client EXACTLY once",
    calls.connect === 1, `connect called ${calls.connect}×`);
  check("...and waiting for the new session to report connected before sending",
    calls.waits === 1, `waitConnected called ${calls.waits}×`);
  check("...then sending the lightweight fallback payload",
    calls.fallback === 1, `fallback called ${calls.fallback}×`);
  /* The copy is product-specified, and bilingual like every other status string in this
     flow. It is a TOAST, not a modal: the point of the recovery is that the shopper is
     told what is happening without the session being thrown away around them. */
  check("...having told the shopper what is happening, in one inline toast",
    calls.toasts.length === 1 && /מרענן חיבור מדידה/.test(calls.toasts[0]),
    JSON.stringify(calls.toasts));
  check("...and it is a toast, never a modal error - showCamError stays out of this path",
    !/showCamError/.test(block),
    "ending up in the error modal is the outcome this recovery exists to avoid");
}

console.log("\n── §4 THE RECOVERY IS SCOPED TO TIMEOUTS ──");
{
  /* A definite failure - an expired token, a permission error, the signaling error
     signaling-retry already narrows on - is an ANSWER. Reconnecting to ask it again
     spends a shopper's time and a second token to arrive at the same place, so those
     rethrow unmodified exactly as they did before the recovery existed. */
  let threw = null;
  let calls = null;
  try {
    await run({
      applyActiveImpl: () => Promise.reject(new Error("set() failed: not open")),
      timeoutMs: 200,
    });
  } catch (e) { threw = e; }
  check("a real rejection reaches the caller, unmodified",
    threw && threw.message === "set() failed: not open", threw?.message);
  check("...and the timeout error is TAGGED, which is what separates the two",
    /e\.isApplyTimeout = true;/.test(block) &&
    /if \(!err \|\| !err\.isApplyTimeout\) throw err;/.test(block),
    "matching on the message text would break the first time the copy is reworded");
}

console.log("\n── §5 SUPERSESSION ON EITHER LEG ──");
{
  // Resolves successfully, but only AFTER bumping sessionGen - a reconnect/new-connect
  // landing mid-await. Execution must NOT continue as if this apply were still current.
  const { result, calls } = await run({
    applyActiveImpl: (bump) => new Promise((resolve) => { bump(); setTimeout(resolve, 5); }),
    timeoutMs: 200,
  });
  check("a superseded apply returns false instead of continuing go-live's success path",
    result === false, JSON.stringify(result));
  check("...and does not open a recovery on top of whatever superseded it",
    calls.connect === 0 && calls.fallback === 0, JSON.stringify(calls));

  // Superseded during the RECOVERY's own wait - a manual Stop while the retry is in
  // flight. Same rule, one leg later.
  const late = await run({
    applyActiveImpl: () => new Promise(() => {}),
    fallbackImpl: (bump) => new Promise((resolve) => { bump(); setTimeout(resolve, 5); }),
    timeoutMs: 15,
  });
  check("a supersession during the RECOVERY returns false too",
    late.result === false, JSON.stringify(late.result));

  // A teardown that cleared `busy` while the first apply was hanging: the flow that owns
  // this go-live is already gone, so there is nothing to recover FOR.
  const stopped = await run({
    applyActiveImpl: () => new Promise(() => {}),
    timeoutMs: 15,
    busy: false,
  });
  check("...and a go-live that was already abandoned never recovers at all",
    stopped.result === false && stopped.calls.connect === 0, JSON.stringify(stopped.calls));
}

console.log("\n── §6 A SECOND FAILURE STILL ENDS THE SESSION ──");
{
  /* The guarantee the original fix bought must survive the recovery: a genuinely broken
     transport becomes a VISIBLE failure, not a silently undressed session with a healthy
     badge. Two attempts, then it throws to goLive()'s handler - the same bound
     applyActive() itself uses, for the same reason. */
  let threw = null;
  try {
    await run({
      applyActiveImpl: () => new Promise(() => {}),
      fallbackImpl: () => new Promise(() => {}),     // the retry hangs too
      timeoutMs: 15,
    });
  } catch (e) { threw = e; }
  check("a recovery that also times out throws, ending the session visibly",
    threw instanceof Error && /יישום הבגד/.test(threw.message), threw?.message);
  check("...and the message names the leg that failed, so a trace is decidable",
    threw && /fallback/.test(threw.message), threw?.message);
}

console.log("\n── §7 THE COLD-START LEASH, AND A RECONNECT THAT ACTUALLY RECONNECTS ──");
{
  /* ── THE FIRST APPLY GETS A MUCH SHORTER BUDGET ─────────────────────────────
     REPORTED: the first attempt hangs and the shopper closes and reopens the widget.
     APPLY_TIMEOUT_MS (10s) is the right bound for "this session is dead" and the wrong
     one for the first thing a shopper ever sees - they give up long before it fires, so
     the manual reopen happened instead of the automatic reconnect. Driven here rather
     than pattern-matched: the mock resolves BETWEEN the two budgets, so a build that
     still used the long one would report success and this would fail. */
  const { result, calls } = await run({
    applyActiveImpl: () => new Promise((resolve) => setTimeout(resolve, 40)),
    coldStartMs: 10,        // the cold-start leash - expires first
    timeoutMs: 200,         // APPLY_TIMEOUT_MS - would have let the apply through
  });
  check("the FIRST apply is bounded by the cold-start leash, not the full budget",
    calls.connect === 1 && result === true,
    `connect=${calls.connect} result=${result} - a 40ms apply must not survive a 10ms leash`);
  check("...and the leash is the config value, not a literal",
    /await race\(applyActive\(\), "", COLD_START_ACK_MS\);/.test(block) &&
    CONFIG.COLD_START_ACK_MS >= 1500 && CONFIG.COLD_START_ACK_MS <= 4000,
    `${CONFIG.COLD_START_ACK_MS}ms - short enough to beat a shopper's patience, long enough to clear a healthy apply`);
  check("...while the RECOVERY leg keeps the full budget",
    /await race\(applyFallbackConditioning\(\), "fallback"\);/.test(block),
    "a second short leash would spend the recovery before it could land");

  /* ── THE RECONNECT HAS TO ACTUALLY RECONNECT ────────────────────────────────
     connectRealtime() early-returns when `rtClient && isLive()`, and the hang this
     recovers from is a set() that never answers on a session the SDK still reports as
     CONNECTED - so isLive() is true and the bare call reset nothing at all. The recovery
     was a no-op for the exact case it exists for. force:true is what makes it real. */
  check("the recovery forces a fresh session rather than early-returning on a live one",
    calls.forced === true,
    "connectRealtime() bails on a session that looks healthy - which is precisely this one");
  check("...and app.js says why the flag exists, where the next reader will look",
    /`force` EXISTS FOR THE COLD-START RECOVERY, and without it that recovery was a no-op/.test(SRC));
  /* THE QUEUE IS FLUSHED FIRST. The write that never came back may still be sitting in
     the wire queue, and a new session's first write must not be queued behind it. */
  check("...and the pending condition queue is flushed before the reconnect",
    calls.flushes === 1 && block.indexOf("resetConditionWire();") < block.indexOf("connectRealtime({ force: true })"),
    `flushes=${calls.flushes}`);
}

console.log("\n── §8 A LATE REJECTION AFTER THE RACE MUST NOT GO UNHANDLED ──");
{
  /* Node's own unhandledRejection listener is the actual observer: without the
     `promise.catch(() => {})` inside race(), a mock rejecting well after the race has
     already timed out would surface as an unhandledRejection on the process. */
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run({
      applyActiveImpl: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 40)),
      timeoutMs: 10,
    });
  } catch (_) { /* the recovery's own outcome is not what this section is about */ }
  await new Promise((r) => setTimeout(r, 80));      // outlive the late rejection
  process.off("unhandledRejection", onUnhandled);
  check("a late rejection is absorbed, never surfaced on the process",
    seen.length === 0, seen.map((e) => e?.message).join(", "));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
