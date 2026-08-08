/* THE SILENT-UNDRESS HANG regression test.

   ROOT CAUSE: goLive()'s initial `await applyActive()` had no timeout of its own,
   unlike the two stages either side of it - waitConnected(CONNECT_TIMEOUT_MS) before it,
   FIRST_FRAME_TIMEOUT_MS after it. If the transport that specific rtClient.set() was
   writing to got torn down and replaced by the SDK's OWN internal reconnect (media/
   signaling hiccups are most likely in exactly this first-second window) and the SDK
   never rejected the now-orphaned promise, the await could hang forever: "connected"
   was already showing (onConnectionChange fires independently of this call), the
   shopper's real camera was already live under it, and the garment simply never
   arrived - no error, no retry, nothing.

   FIX: race applyActive() against APPLY_TIMEOUT_MS, and guard against a supersession
   (the session gets torn down/reconnected while this was waiting) via the same
   sessionGen pattern already used throughout this file for exactly this class of bug.

   This drives the REAL extracted block from goLive() - not a reimplementation - via a
   sandboxed applyActive() whose timing and behaviour the test controls directly. */
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

const block = extract("    // 2) apply on the live stream", "    // Log every garment being worn");
check("extracted the guarded apply block",
  /guardGen/.test(block) && /APPLY_TIMEOUT_MS/.test(block) && /Promise\.race/.test(block));
check("the race includes a rejecting timeout, not just the apply promise",
  /setTimeout\(\s*\n?\s*\(\)\s*=>\s*reject/.test(block));
check("a late resolution can never become an unhandled rejection",
  /applyPromise\.catch\(\(\) => \{\}\);/.test(block));

/* `applyActiveImpl(bump)` is supplied by each test below; `bump` is a closure over the
   SANDBOX's own local `sessionGen` (not the test's outer scope - there is no shared
   primitive to reach across the sandbox boundary otherwise), so a mock that wants to
   simulate "a reconnect superseded this session while we were waiting" calls it before
   resolving/rejecting. */
async function run({ applyActiveImpl, timeoutMs = 20 }) {
  const fn = new Function("applyActiveImpl", "APPLY_TIMEOUT_MS", "setTimeout",
    "return (async () => {\n" +
    "let sessionGen = 1;\n" +
    "const applyActive = () => applyActiveImpl(() => { sessionGen++; });\n" +
    block +
    "\nreturn 'reached-end';\n" +
    "})();"
  );
  return fn(applyActiveImpl, timeoutMs, setTimeout);
}

console.log("── the normal case: apply resolves well within the timeout ──");
{
  const result = await run({
    applyActiveImpl: (bump) => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  check("execution continues past the guarded block", result === "reached-end");
}

console.log("\n── the hang: apply never settles, so the timeout must win the race ──");
{
  let threw = null;
  try {
    await run({
      applyActiveImpl: () => new Promise(() => {}),   // never resolves or rejects - the orphaned-promise case
      timeoutMs: 15,
    });
  } catch (e) { threw = e; }
  check("the guarded block throws instead of hanging forever",
    threw instanceof Error, threw);
  check("...with a message identifying what timed out",
    threw && /יישום הבגד/.test(threw.message), threw?.message);
}

console.log("\n── a real rejection from applyActive() still propagates (not swallowed) ──");
{
  let threw = null;
  try {
    await run({
      applyActiveImpl: () => Promise.reject(new Error("set() failed: not open")),
      timeoutMs: 50,
    });
  } catch (e) { threw = e; }
  check("the original error reaches the caller, unmodified",
    threw && threw.message === "set() failed: not open", threw?.message);
}

console.log("\n── supersession: the session moved on while this was still waiting ──");
{
  // The mock resolves successfully, but only AFTER bumping sessionGen first - simulating
  // a reconnect/new-connect landing mid-await. THE CRITICAL ASSERTION: execution must
  // NOT continue past the guard as if this apply were still for the live session.
  const result = await run({
    applyActiveImpl: (bump) => new Promise((resolve) => {
      bump();
      setTimeout(resolve, 5);
    }),
    timeoutMs: 200,
  });
  check("a superseded apply returns early instead of continuing go-live's success path",
    result === undefined, JSON.stringify(result));
}

console.log("\n── a late resolution after the timeout already fired must not throw unhandled ──");
{
  // Node's own unhandledRejection listener is the actual observer here: if applyPromise
  // were NOT given its own .catch(), letting the mock's promise reject well after the
  // race has already timed out (and this async IIFE has already returned/thrown) would
  // surface as an unhandledRejection on the process - exactly the failure mode the
  // `applyPromise.catch(() => {})` line exists to prevent.
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    try {
      await run({
        applyActiveImpl: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 30)),
        timeoutMs: 5,
      });
    } catch (_) { /* the timeout is expected to win and throw here - not what's under test */ }
    await new Promise((r) => setTimeout(r, 60));   // let the mock's late rejection actually land
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  check("a late rejection, after the timeout already won, never reaches the process as unhandled",
    unhandled === false);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
