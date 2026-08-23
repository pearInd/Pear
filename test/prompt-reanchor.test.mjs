/* THE STEADY-STATE DRIFT regression test: the garment renders, then quietly reverts to
   the shopper's real clothing part-way through the session - reported both at 90° dwell
   and (from the earliest reports) head-on.

   ROOT CAUSE: maybeUpdateProfile() only re-issues the prompt when autoProfile FLIPS, and
   maybeSwap() only on a confirmed front/back flip. A shopper who simply HOLDS a pose
   triggers neither, so the steering prompt is asserted once at go-live and then never
   again. Lucy has no cross-frame memory of it (see COMPOSITE_TEMPORAL's comment) - it is
   a single assertion asked to hold the whole generation window against a diffusion
   model's own prior (the person as photographed, in their own clothes).

   FIX: maybeReanchorPrompt() periodically re-asserts the conditioning on a cadence
   derived from the billed window.

   WHAT IT RE-ASSERTS CHANGED, AND THIS SUITE CHANGED WITH IT. The first version re-issued
   the CURRENT prompt through applyGarment()'s prompt-only setPrompt() fast path. Strict
   image-only conditioning then removed the thing it was re-issuing - every builder returns
   one frozen IMAGE_ONLY_PROMPT, so the payload became byte-identical to what Decart
   already held and applyGarment() skipped it as a no-op. The re-anchor had silently
   degraded into eight scheduled no-ops per session, and the drift came back as "the
   garment turns into a random shirt mid-session". It now nulls lastSentImageRef first, so
   the dispatch takes the full set({ image }) path and the model is handed the packshot
   again.

   THAT DOES NOT REOPEN THE FLICKER. prompt-only-flip.test.mjs guards the TURN - and
   applyGarment() re-stamps lastSentImageRef when the send resolves, so a turn right after
   a re-anchor is still prompt-only. The re-anchor additionally refuses to fire while
   _orientHoldActive (mid front/back swap), which is the exact window in which swapping the
   reference is what makes a print flicker. §7 below pins both halves.

   TWO DEFECTS IN THE FIRST VERSION OF THIS, both covered below:
     1. CADENCE. It was hardcoded 4000ms against a LIVE_DURATION_MS of 5000ms, so it could
        fire at most ONCE per session - and only for a shopper holding one pose for 4 of
        their 5 seconds. Reversion was being observed ~2s in, which it could never reach.
        Now derived from LIVE_DURATION_MS so "several times WITHIN a session" holds by
        construction if the billed window is ever retuned.
     2. SCOPE. It was gated on autoProfile (edge-on only), which was arbitrary - the drift
        mechanism is pose-independent, and a shopper standing still square-on goes just as
        long without a re-assertion. */
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

const fnSrc = extract("async function maybeReanchorPrompt()", "\n\n  const timer = setInterval");
check("extracted maybeReanchorPrompt",
  /applyActive\(\)/.test(fnSrc) && /REANCHOR_MS/.test(fnSrc) && /lastReanchorAt/.test(fnSrc));

console.log("\n── §1 THE CADENCE IS DERIVED, so it can never silently outlive the session again ──");
{
  /* THE BUG THIS SECTION EXISTS FOR: a hardcoded 4000ms re-anchor inside a 5000ms billed
     window fires at most once, far too late to matter. Asserting the DERIVATION (not the
     resulting number) is what keeps the real invariant enforced if either value moves. */
  const decl = extract("const REANCHOR_MS", ";");
  check("REANCHOR_MS is derived from LIVE_DURATION_MS, not hardcoded",
    /LIVE_DURATION_MS/.test(decl), decl);
  check("...with a floor, so a hypothetical tiny session can't produce a chatter loop",
    /Math\.max\(/.test(decl), decl);

  // Execute the real declaration against the real LIVE_DURATION_MS to pin actual behaviour.
  const liveMs = Number((extract("const LIVE_DURATION_MS", ";").match(/=\s*(\d+)/) || [])[1]);
  check("LIVE_DURATION_MS parsed for the arithmetic below", Number.isFinite(liveMs) && liveMs > 0, String(liveMs));
  const reanchorMs = new Function("LIVE_DURATION_MS", decl + ";\nreturn REANCHOR_MS;")(liveMs);
  check(`the cadence fits several re-anchors inside one session (${reanchorMs}ms into ${liveMs}ms)`,
    reanchorMs > 0 && liveMs / reanchorMs >= 3, `ratio=${liveMs / reanchorMs}`);
  check("...and the FIRST one lands before the ~2s mark where reversion was observed",
    reanchorMs < 2000, `${reanchorMs}ms`);
}

/* Runs the REAL function body against sandboxed state. Every closure variable it touches
   is seeded per-test and readable back afterward via state(). */
function harness({
  autoProfile = false, applying = false, lastReanchorAt = 0, disposed = false,
  isLiveVal = true, garmentApplied = true, reanchorMs = 100, wireBusyVal = false,
  applyActiveImpl = () => Promise.resolve(), debug = false,
  orientHold = false, sentImageRef = "REF",
}) {
  const events = [];
  const sandbox = {
    autoProfileInit: autoProfile, applyingInit: applying, lastReanchorAtInit: lastReanchorAt,
    disposedInit: disposed,
    REANCHOR_MS: reanchorMs,
    isLive: () => isLiveVal,
    /* The CROSS-SITE half of the mutex. `applying` is a closure local this function shares
       with maybeUpdateProfile/maybeSwap only; wireBusy() is what it uses to see the send
       sites it cannot - goLive's first apply, the presence re-condition, the body-topology
       re-drape. §3 drives both states. */
    wireBusy: () => wireBusyVal,
    isGarmentApplied: garmentApplied,
    applyActive: applyActiveImpl,
    sessionElapsedMs: () => 1234,
    ORIENT_DEBUG: debug,
    _orientHoldActive: orientHold,
    sentImageRefInit: sentImageRef,
    console: { log: (...a) => events.push({ op: "log", a }), warn: (...a) => events.push({ op: "warn", a }) },
  };
  const fn = new Function(...Object.keys(sandbox),
    "let autoProfile = autoProfileInit, applying = applyingInit, " +
    "lastReanchorAt = lastReanchorAtInit, disposed = disposedInit;\n" +
    /* The module-level reference pin the function now clears to force a full re-upload.
       Declared here for the same reason prompt-only-flip.test.mjs declares its own: an
       undeclared assignment inside new Function() is sloppy-mode global creation, so one
       harness's pin would leak onto globalThis and be read by the next. */
    "let lastSentImageRef = sentImageRefInit;\n" +
    fnSrc +
    "\nreturn { maybeReanchorPrompt," +
    " state: () => ({ autoProfile, applying, lastReanchorAt, disposed, lastSentImageRef }) };"
  );
  return { api: fn(...Object.values(sandbox)), events };
}

console.log("\n── §2 SCOPE: it re-anchors at EVERY pose, not only edge-on ──");
{
  /* The first version gated this on autoProfile, so a shopper standing still facing the
     camera - the case the very first bug reports described - got no re-anchoring at all. */
  for (const [label, autoProfile] of [["square-on", false], ["edge-on", true]]) {
    let calls = 0;
    const { api } = harness({ autoProfile, lastReanchorAt: 0, reanchorMs: 50,
      applyActiveImpl: () => { calls++; return Promise.resolve(); } });
    await api.maybeReanchorPrompt();
    check(`${label}: re-anchors on cadence`, calls === 1, `calls=${calls}`);
  }
}

console.log("\n── §3 the guards: cadence, mutex, liveness, and nothing-yet-rendered ──");
{
  let calls = 0;
  const { api } = harness({ lastReanchorAt: Date.now(), reanchorMs: 60000,
    applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorPrompt();
  check("no redundant re-anchor before the cadence has elapsed", calls === 0);
}
{
  let calls = 0;
  const { api } = harness({ applying: true, lastReanchorAt: 0,
    applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorPrompt();
  check("never overlaps an in-flight swap/transition (respects the shared applying mutex)", calls === 0);
}
{
  /* ── AND THE MUTEX IT CANNOT SEE FROM ITS OWN CLOSURE ──────────────────────
     `applying` is shared with maybeUpdateProfile/maybeSwap and with nothing else. Every
     other write to this wire - goLive's first apply, the presence re-condition, the
     body-topology re-drape - happens outside this watcher entirely, so `applying` is
     false while they are in flight and this function would happily add a concurrent
     set() on top. Two set() calls on one session is the reported
     "rtClient.set לא הגיב" go-live timeout; wireBusy() is what closes it.

     SKIPPED, NOT QUEUED, and deliberately: a re-anchor re-asserts an UNCHANGED state on a
     cadence, so the cheapest correct response to a busy wire is to do nothing and come
     back on the next tick - queueing it would build the backlog the mutex exists to
     prevent. It must also not stamp its clock, or one deferred turn would cost the
     session a full REANCHOR_MS of steering. */
  let calls = 0;
  const { api } = harness({ wireBusyVal: true, lastReanchorAt: 0,
    applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorPrompt();
  check("never stacks on a write from ANOTHER send site (the cross-site wire mutex)",
    calls === 0, `calls=${calls}`);
  check("...and a deferred re-anchor does not consume its cadence slot",
    api.state().lastReanchorAt === 0,
    "stamping the clock for a send that never happened costs a whole REANCHOR_MS of steering");
}
{
  let calls = 0;
  for (const opts of [{ disposed: true }, { isLiveVal: false }]) {
    const { api } = harness({ ...opts, lastReanchorAt: 0,
      applyActiveImpl: () => { calls++; return Promise.resolve(); } });
    await api.maybeReanchorPrompt();
  }
  check("never fires on a disposed watcher or a non-live session", calls === 0);
}
{
  /* THE GO-LIVE RACE: before the first frame is dressed there is no steering to
     re-assert, and firing here would race the very applyActive() goLive() is awaiting -
     which is now itself timeout-guarded (see apply-timeout.test.mjs), so an extra
     concurrent apply landing in that window is exactly what must not happen. */
  let calls = 0;
  const { api } = harness({ garmentApplied: false, lastReanchorAt: 0,
    applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorPrompt();
  check("never fires before the first frame has ever been dressed (isGarmentApplied)", calls === 0);
}

console.log("\n── §4 bookkeeping and failure handling ──");
{
  const { api } = harness({ lastReanchorAt: 0, reanchorMs: 50 });
  await api.maybeReanchorPrompt();
  check("lastReanchorAt is stamped fresh on success",
    api.state().lastReanchorAt > 0 && Date.now() - api.state().lastReanchorAt < 1000);
  check("applying is released back to false", api.state().applying === false);
}
{
  const { api, events } = harness({ lastReanchorAt: 0,
    applyActiveImpl: () => Promise.reject(new Error("set() failed")) });
  let threw = false;
  try { await api.maybeReanchorPrompt(); } catch (_) { threw = true; }
  check("a failed re-anchor is caught, not propagated - one bad tick can't kill the loop", threw === false);
  check("applying is still released after a failure", api.state().applying === false);
  check("...and warns, so a real failure isn't silently invisible either",
    events.some((e) => e.op === "warn" && /re-anchor/.test(e.a[0])));
}

console.log("\n── §5 TELEMETRY: session-relative, so it maps onto a screen recording ──");
{
  /* The diagnosis this keeps being needed for is "the video shows it reverting ~2s in" vs
     "what did the code do at 2s". A wall-clock log line cannot answer that; t= measured
     from the same first-dressed-frame event that starts the recorder can. */
  const { api, events } = harness({ lastReanchorAt: 0, reanchorMs: 50, debug: true });
  await api.maybeReanchorPrompt();
  const line = events.find((e) => e.op === "log")?.a[0] || "";
  check("logs a session-relative timestamp", /t=1234ms/.test(line), line);
  check("...and the pose it re-anchored at", /pose=square-on/.test(line), line);
  check("...and states it DID re-assert the reference", /reference re-asserted/.test(line), line);
}
{
  const { events } = harness({ lastReanchorAt: 0, reanchorMs: 50, debug: false });
  // Not awaited on purpose: assert only that debug-off produces no log on construction.
  check("silent unless ORIENT_DEBUG is on", events.length === 0);
}

console.log("\n── §6 the diagnostics clock itself ──");
{
  const helper = extract("const sessionElapsedMs", ";\n");
  check("sessionElapsedMs measures from billingStartedAt", /billingStartedAt/.test(helper), helper);
  check("...and reports -1 (not 0) before the window opens, so 'not started' is distinguishable",
    /: -1/.test(helper), helper);
  check("billingStartedAt is stamped where billing actually arms (the first DRESSED frame)",
    /billingStarted = true;\n\s*billingStartedAt = Date\.now\(\);/.test(SRC));
  /* Both teardown paths must clear it, or the NEXT session's t= values are measured from
     the previous session's start - silently wrong by exactly the gap between them. */
  const resets = SRC.match(/billingStarted = false;\n\s*billingStartedAt = 0;/g) || [];
  check("...and cleared on BOTH teardown paths, so t= never carries across sessions",
    resets.length === 2, `found ${resets.length}`);
}

console.log("\n── §7 wiring: called from the tick, clock shared with maybeUpdateProfile ──");
{
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  /* Both calls are now fire-and-forget: awaiting them held the sampler's `sampling` flag
     across a network round-trip, dropping the orientation sample rate to whatever Decart's
     latency happened to be. The ORDER and the GATE are what this asserts, and both are
     unchanged; the mutex that makes it safe (`applying`) is inside the functions. */
  check("called from the tick, after maybeUpdateProfile, gated the same way (no pending dual-view swap)",
    /if \(!\(dualView && confirmed\)\) \{[\s\S]*?maybeUpdateProfile\(lastProfileScore\)\.catch[\s\S]*?maybeReanchorPrompt\(\)\.catch\(\(\) => \{\}\);/.test(watcher));
  check("...in the background, so a slow re-anchor cannot stall the next orientation sample",
    !/await maybeReanchorPrompt\(\);/.test(watcher));
  check("the call is NOT gated on pose - square-on sessions get it too",
    !/autoProfile[^\n]*maybeReanchorPrompt/.test(watcher));

  const upd = extract("async function maybeUpdateProfile(score)", "\n  }\n\n  /* THE STEADY-STATE COUNTERPART");
  check("maybeUpdateProfile() stamps lastReanchorAt too - a transition IS a fresh anchor",
    /lastProfileAt = Date\.now\(\);[\s\S]*?lastReanchorAt = Date\.now\(\);/.test(upd), upd.slice(0, 600));
}

console.log("\n── §8 THE RE-UPLOAD: what the re-anchor actually re-asserts ──");
{
  /* THE REGRESSION THIS SECTION EXISTS FOR. Under strict image-only conditioning the
     prompt is one frozen string, so re-issuing it is provably a no-op - applyGarment()
     skips it by design. A re-anchor that does not clear the reference pin is therefore
     not "a cheaper re-anchor", it is no re-anchor at all, and the drift it was built to
     counter comes back with nothing in the logs to show for it. */
  const { api } = harness({ lastReanchorAt: 0, reanchorMs: 50, sentImageRef: "REF" });
  await api.maybeReanchorPrompt();
  check("the reference pin is cleared, so the dispatch takes the full set({ image }) path",
    api.state().lastSentImageRef === null,
    "a re-anchor that leaves the pin set is a no-op under strict image-only conditioning");
}
{
  /* Swapping the reference mid-rotation is the documented cause of a print flickering,
     and _orientHoldActive is precisely "the watcher has frozen the view and is mid-swap
     of the reference itself". reconditionForTopology() - the other full-re-upload send
     site - carries the same guard. */
  let calls = 0;
  const { api } = harness({ lastReanchorAt: 0, reanchorMs: 50, orientHold: true,
    applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorPrompt();
  check("never re-uploads mid front/back swap (_orientHoldActive)", calls === 0, `calls=${calls}`);
  check("...and leaves the pin alone, so the swap's own payload is not disturbed",
    api.state().lastSentImageRef === "REF", String(api.state().lastSentImageRef));
  check("...without consuming its cadence slot, so the next tick re-offers it",
    api.state().lastReanchorAt === 0, String(api.state().lastReanchorAt));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
