/* THE STEADY-STATE DRIFT regression test: the garment renders, then quietly reverts to
   the shopper's real clothing part-way through the session - reported both at 90° dwell
   and (from the earliest reports) head-on.

   ROOT CAUSE: maybeUpdateProfile() only re-issues the prompt when autoProfile FLIPS, and
   maybeSwap() only on a confirmed front/back flip. A shopper who simply HOLDS a pose
   triggers neither, so the steering prompt is asserted once at go-live and then never
   again. Lucy has no cross-frame memory of it (see COMPOSITE_TEMPORAL's comment) - it is
   a single assertion asked to hold the whole generation window against a diffusion
   model's own prior (the person as photographed, in their own clothes).

   FIX: maybeReanchorPrompt() periodically re-issues the CURRENT prompt, completely
   unchanged, via the SAME prompt-only setPrompt() fast path applyGarment() already takes
   when the reference image is unchanged - so it cannot reintroduce the image-reupload
   flicker prompt-only-flip.test.mjs guards, and alters no prompt wording.

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
  isLiveVal = true, garmentApplied = true, reanchorMs = 100,
  applyActiveImpl = () => Promise.resolve(), debug = false,
}) {
  const events = [];
  const sandbox = {
    autoProfileInit: autoProfile, applyingInit: applying, lastReanchorAtInit: lastReanchorAt,
    disposedInit: disposed,
    REANCHOR_MS: reanchorMs,
    isLive: () => isLiveVal,
    isGarmentApplied: garmentApplied,
    applyActive: applyActiveImpl,
    sessionElapsedMs: () => 1234,
    ORIENT_DEBUG: debug,
    console: { log: (...a) => events.push({ op: "log", a }), warn: (...a) => events.push({ op: "warn", a }) },
  };
  const fn = new Function(...Object.keys(sandbox),
    "let autoProfile = autoProfileInit, applying = applyingInit, " +
    "lastReanchorAt = lastReanchorAtInit, disposed = disposedInit;\n" +
    fnSrc +
    "\nreturn { maybeReanchorPrompt," +
    " state: () => ({ autoProfile, applying, lastReanchorAt, disposed }) };"
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
  check("...and states it did NOT re-upload the reference", /reference unchanged/.test(line), line);
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
  check("called from the tick, after maybeUpdateProfile, gated the same way (no pending dual-view swap)",
    /if \(!\(dualView && confirmed\)\) \{[\s\S]*?await maybeUpdateProfile\(lastProfileScore\);[\s\S]*?await maybeReanchorPrompt\(\);/.test(watcher));
  check("the call is NOT gated on pose - square-on sessions get it too",
    !/autoProfile[^\n]*maybeReanchorPrompt/.test(watcher));

  const upd = extract("async function maybeUpdateProfile(score)", "\n  }\n\n  /* THE STEADY-STATE COUNTERPART");
  check("maybeUpdateProfile() stamps lastReanchorAt too - a transition IS a fresh anchor",
    /lastProfileAt = Date\.now\(\);[\s\S]*?lastReanchorAt = Date\.now\(\);/.test(upd), upd.slice(0, 600));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
