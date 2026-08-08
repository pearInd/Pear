/* THE DWELL-DRIFT regression test: "the garment holds through the turn, then quietly
   reverts after sitting at 90 degrees for a while" - confirmed live via console trace
   (orient_debug=1) to happen during SUSTAINED dwelling, not the turn itself (the turn
   is what the freeze-hold in turn-hold.test.mjs already covers).

   ROOT CAUSE: maybeUpdateProfile() only ever re-issues the prompt on a TRANSITION -
   autoProfile flipping true or false. Once it settles true, nothing re-asserts the
   steering prompt for as long as the shopper stays edge-on, and Lucy has no cross-frame
   memory of what it was told once (see COMPOSITE_TEMPORAL's comment) - the model drifts
   toward its own strong prior (a person on camera, in their own clothes) over a long
   enough uninterrupted generation window.

   FIX: maybeReanchorProfile() periodically re-issues the CURRENT prompt (completely
   unchanged) via the SAME prompt-only setPrompt() fast path applyGarment() already
   takes whenever the reference image is unchanged - so this cannot reintroduce the
   flicker prompt-only-flip.test.mjs guards against, and changes no wording, so nothing
   already-tuned is at risk. Runs on its own ORIENT_PROFILE_REANCHOR_MS cadence,
   independent of and coordinated with maybeUpdateProfile()'s transition-triggered
   updates (see the shared lastReanchorAt bookkeeping asserted below). */
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

const fnSrc = extract("async function maybeReanchorProfile()", "\n\n  const timer = setInterval");
check("extracted maybeReanchorProfile",
  /applyActive\(\)/.test(fnSrc) && /ORIENT_PROFILE_REANCHOR_MS/.test(fnSrc) && /lastReanchorAt/.test(fnSrc));

/* Runs the REAL function body against sandboxed state. `autoProfile`/`applying`/
   `lastReanchorAt`/`disposed` are all closure variables shared with the rest of the
   REAL watcher; here each test owns its own private copies, seeded to whatever
   scenario it wants to exercise, and can read them back afterward via `state()`. */
function harness({
  autoProfile = true, applying = false, lastReanchorAt = 0, disposed = false,
  isLiveVal = true, reanchorMs = 100, applyActiveImpl = () => Promise.resolve(),
  debug = false,
}) {
  const sandbox = {
    autoProfileInit: autoProfile, applyingInit: applying, lastReanchorAtInit: lastReanchorAt,
    disposedInit: disposed,
    ORIENT_PROFILE_REANCHOR_MS: reanchorMs,
    isLive: () => isLiveVal,
    applyActive: applyActiveImpl,
    ORIENT_DEBUG: debug,
  };
  const events = [];
  sandbox.console = { log: (...a) => events.push({ op: "log", a }), warn: (...a) => events.push({ op: "warn", a }) };
  const fn = new Function(...Object.keys(sandbox),
    "let autoProfile = autoProfileInit, applying = applyingInit, " +
    "lastReanchorAt = lastReanchorAtInit, disposed = disposedInit;\n" +
    fnSrc +
    "\nreturn { maybeReanchorProfile," +
    " state: () => ({ autoProfile, applying, lastReanchorAt, disposed }) };"
  );
  return { api: fn(...Object.values(sandbox)), events };
}

console.log("── fires when edge-on, idle, and the cadence has elapsed ──");
{
  let calls = 0;
  const { api } = harness({ lastReanchorAt: 0, reanchorMs: 50, applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorProfile();
  check("applyActive() was called - a stale lastReanchorAt is well past the cadence", calls === 1);
  check("lastReanchorAt is stamped with a fresh timestamp on success",
    api.state().lastReanchorAt > 0 && Date.now() - api.state().lastReanchorAt < 1000);
  check("applying is released back to false afterward", api.state().applying === false);
}

console.log("\n── does not fire before its own cadence has elapsed ──");
{
  let calls = 0;
  const { api } = harness({
    lastReanchorAt: Date.now(), reanchorMs: 60000,   // "just anchored a minute ago, minimum gap is a minute"
    applyActiveImpl: () => { calls++; return Promise.resolve(); },
  });
  await api.maybeReanchorProfile();
  check("no redundant re-anchor when the cadence has not elapsed", calls === 0);
}

console.log("\n── never fires while square-on (autoProfile false) ──");
{
  let calls = 0;
  const { api } = harness({ autoProfile: false, lastReanchorAt: 0, applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorProfile();
  check("no re-anchor for a pose the depth clause isn't even engaged for", calls === 0);
}

console.log("\n── respects the shared `applying` mutex (never overlaps a swap or a transition update) ──");
{
  let calls = 0;
  const { api } = harness({ applying: true, lastReanchorAt: 0, applyActiveImpl: () => { calls++; return Promise.resolve(); } });
  await api.maybeReanchorProfile();
  check("no re-anchor while another apply is already in flight", calls === 0);
}

console.log("\n── never fires on a torn-down or non-live session ──");
{
  let calls = 0;
  {
    const { api } = harness({ disposed: true, lastReanchorAt: 0, applyActiveImpl: () => { calls++; return Promise.resolve(); } });
    await api.maybeReanchorProfile();
  }
  {
    const { api } = harness({ isLiveVal: false, lastReanchorAt: 0, applyActiveImpl: () => { calls++; return Promise.resolve(); } });
    await api.maybeReanchorProfile();
  }
  check("neither a disposed watcher nor a non-live session ever re-anchors", calls === 0);
}

console.log("\n── a failed re-anchor is swallowed, not thrown - one bad tick must not break the next one ──");
{
  const { api, events } = harness({ lastReanchorAt: 0, applyActiveImpl: () => Promise.reject(new Error("set() failed")) });
  let threw = false;
  try { await api.maybeReanchorProfile(); } catch (_) { threw = true; }
  check("the rejection is caught inside the function, not propagated to the caller", threw === false);
  check("applying is still released back to false after a failure", api.state().applying === false);
  check("...and a warning is logged so a real failure isn't silently invisible either",
    events.some((e) => e.op === "warn" && /profile re-anchor/.test(e.a[0])));
}

console.log("\n── wiring: the tick calls it, and lastReanchorAt is shared with maybeUpdateProfile ──");
{
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  check("called from the tick, after maybeUpdateProfile, gated the same way as it (no pending dual-view swap)",
    /if \(!\(dualView && confirmed\)\) \{[\s\S]*?await maybeUpdateProfile\(lastProfileScore\);[\s\S]*?await maybeReanchorProfile\(\);/.test(watcher));

  const upd = extract("async function maybeUpdateProfile(score)", "\n  }\n\n  /* THE DWELL-DRIFT COUNTERPART");
  check("maybeUpdateProfile() stamps lastReanchorAt too on a real transition - a transition IS a fresh anchor",
    /lastProfileAt = Date\.now\(\);[\s\S]*?lastReanchorAt = Date\.now\(\);/.test(upd), upd.slice(0, 600));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
