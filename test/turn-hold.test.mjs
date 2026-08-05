/* "When I turn around, my real shirt comes back for a moment."

   ROOT CAUSE: the cross-fade freeze used to be raised inside maybeSwap() - i.e. only once
   a flip was CONFIRMED, which is ORIENT_LOCK_FRAMES (10 samples ≈ 2.5s) after the shopper
   started turning. But the reversion does not happen during the swap. It happens in those
   2.5 seconds BEFORE it, while the shopper is side-on and the model is still being told
   "the person is FACING FORWARD". Lucy regenerates every frame, and for a half-turned,
   partly-occluded person the most probable completion is the person as actually
   photographed - in their own shirt. The freeze arrived far too late to hide any of it.

   FIX: the hold is raised on the FIRST disagreeing vote, so the frame it captures is still
   a good dressed one, and it is released when the swap lands, when the shopper turns back,
   or on a hard ceiling.

   A stuck hold hides the entire live feed behind a still image, so the release paths matter
   at least as much as the raise. This drives the REAL orientHoldBegin/orientHoldEnd pair
   extracted from app.js. */
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

const holdSrc = extract("const ORIENT_TURN_HOLD_MAX_MS", "function createOrientationWatcher");
check("extracted the turn-hold pair", /function orientHoldBegin/.test(holdSrc) && /function orientHoldEnd/.test(holdSrc));

function harness() {
  const events = [];
  let timers = [];
  const sandbox = {
    ORIENT_DEBUG: false,
    // orientHoldEnd reports the hold duration as a share of the billed window, so the
    // slice needs the window length. Captured as events so the log itself is assertable -
    // it is the only evidence of how much of a session a shopper spent on a still.
    LIVE_DURATION_MS: 5000,
    console: { log: (...a) => events.push({ op: "log", a }), warn: (...a) => events.push({ op: "warn", a }) },
    orientFadeFreeze: () => events.push({ op: "freeze" }),
    orientFadeReveal: () => events.push({ op: "reveal" }),
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  const api = new Function(...Object.keys(sandbox),
    holdSrc + "\nreturn { orientHoldBegin, orientHoldEnd, active: () => _orientHoldActive, MAX: ORIENT_TURN_HOLD_MAX_MS };"
  )(...Object.values(sandbox));
  return { api, events, fireTimers: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }), timers };
}

console.log("\n── the hold captures ONE frame, at the start of the turn ──");
{
  const { api, events } = harness();
  api.orientHoldBegin("turn-detected");
  check("first disagreeing vote freezes the live frame",
    events.filter((e) => e.op === "freeze").length === 1, JSON.stringify(events));
  check("the hold is active", api.active() === true);

  /* THE CRITICAL GUARD. maybeSwap() also calls orientHoldBegin(), ~2.5s later, when the
     flip confirms. If that re-froze, it would replace the good dressed frame with a
     mid-turn one - capturing exactly the reverted-to-real-shirt frame this hold exists to
     hide, and then displaying it. */
  api.orientHoldBegin("swap");
  check("a second begin during the same turn does NOT re-freeze",
    events.filter((e) => e.op === "freeze").length === 1, JSON.stringify(events.map((e) => e.op)));
}

console.log("\n── release paths ──");
{
  const { api, events } = harness();
  api.orientHoldBegin("turn-detected");
  api.orientHoldEnd("swap-complete");
  check("the swap completing reveals the live feed",
    events.filter((e) => e.op === "reveal").length === 1, JSON.stringify(events.map((e) => e.op)));
  check("the hold is no longer active", api.active() === false);

  // Idempotent: a stray second release must not fire another reveal.
  api.orientHoldEnd("watcher-stopped");
  check("releasing twice is a no-op", events.filter((e) => e.op === "reveal").length === 1);
}
{
  const { api, events } = harness();
  api.orientHoldBegin("turn-detected");
  api.orientHoldEnd("turn-abandoned");   // shopper turned back before the flip confirmed
  check("turning back mid-hold releases immediately",
    api.active() === false && events.some((e) => e.op === "reveal"));
}

console.log("\n── the ceiling: a hold can never outlive its own timer ──");
{
  const { api, events, fireTimers } = harness();
  api.orientHoldBegin("turn-detected");
  /* The ceiling must stay ABOVE ORIENT_LOCK_MS (2500) plus the swap budget, or it fires
     mid-confirmation on every ordinary turn and reveals the live feed during exactly the
     window the hold exists to cover - the shopper's own shirt coming back. Lowering this
     number is not the way to shorten the freeze; confirming faster is (ORIENT_FAST_LOCK_*). */
  check("a safety timer is armed", api.MAX === 3000, String(api.MAX));
  check("the ceiling still clears ORIENT_LOCK_MS + a swap budget", api.MAX > 2500, String(api.MAX));
  fireTimers();
  check("the ceiling reveals the feed rather than sitting on a still",
    api.active() === false && events.some((e) => e.op === "reveal"), JSON.stringify(events.map((e) => e.op)));
  check("...and says so, since a live feed re-appearing mid-turn needs explaining",
    events.some((e) => e.op === "warn"));
}
{
  /* The timer must be cancelled on a normal release, or it fires into the NEXT turn and
     tears down a hold that has only just been raised - the reversion would then be
     visible on every second rotation. */
  const { api, events, timers } = harness();
  api.orientHoldBegin("turn-detected");
  api.orientHoldEnd("swap-complete");
  check("a normal release disarms the ceiling timer", timers.every((t) => !t.live),
    JSON.stringify(timers.map((t) => t.live)));

  api.orientHoldBegin("turn-detected");            // the next turn
  timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
  check("the fresh turn still gets its own working ceiling",
    api.active() === false && events.filter((e) => e.op === "reveal").length === 2,
    JSON.stringify(events.map((e) => e.op)));
}

console.log("\n── wiring: the sampler raises the hold before confirmation, not after ──");
{
  /* The whole point is the 2.5s the old code left uncovered, so assert the call sits on
     the pre-confirmation branch rather than only inside maybeSwap(). */
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  check("raised while a switch is pending but NOT yet confirmed",
    /if \(!acquiring && needsSwitch && !confirmed\) orientHoldBegin\("turn-detected"\)/.test(watcher),
    watcher.slice(watcher.indexOf("orientHoldBegin") - 120, watcher.indexOf("orientHoldBegin") + 60));
  check("released when the turn is abandoned",
    /!needsSwitch && _orientHoldActive\) orientHoldEnd\("turn-abandoned"\)/.test(watcher));
  /* ACQUIRING is the first reading of a session: nothing is confirmed, nothing dressed has
     been rendered yet, and freezing there would stall the opening frames behind a still. */
  check("never raised while ACQUIRING the first orientation of the session",
    /!acquiring && needsSwitch/.test(watcher));

  const stop = extract("    stop() {", "  };\n}");
  check("the watcher releases its hold when it stops (or the still sticks forever)",
    /orientHoldEnd\("watcher-stopped"\)/.test(stop), stop);
}

console.log("\n── fast confirm: the actual lever on how long the freeze lasts ──");
{
  /* The hold lasts as long as CONFIRMATION does. At ORIENT_SAMPLE_MS=250 the slow bar
     (ORIENT_LOCK_FRAMES=10 / ORIENT_LOCK_MS=2500) is ~2.5s, so every ordinary turn froze
     half a 5s session. The fast path is a second, STRICTER route - it must never become a
     way for an ambiguous reading to confirm early. */
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  const consts = extract("const ORIENT_FAST_LOCK_FRAMES", "\n\n");

  check("fast confirm requires BOTH a frame count and a confidence floor",
    /streak >= ORIENT_FAST_LOCK_FRAMES && streakMinConf >= ORIENT_FAST_LOCK_CONF/.test(watcher), watcher);
  check("it is OR-ed with the slow bar, never replacing it",
    /fastConfirm \|\| streak >= ORIENT_LOCK_FRAMES \|\| held >= ORIENT_LOCK_MS/.test(watcher), watcher);
  check("the slow bar's own thresholds are untouched",
    /ORIENT_LOCK_FRAMES\s*=\s*10/.test(SRC) && /ORIENT_LOCK_MS\s*=\s*2500/.test(SRC));

  /* MINIMUM, not average: an average lets two strong samples carry a borderline one
     through, which is precisely the reading that must take the slow path. */
  check("the streak tracks its WEAKEST sample",
    /streakMinConf = Math\.min\(streakMinConf, lastConfidence\)/.test(watcher), watcher);
  check("a new streak reseeds the confidence floor rather than inheriting it",
    /streak = 1;.*streakMinConf = lastConfidence/.test(watcher), watcher);

  const fastFrames = Number(/ORIENT_FAST_LOCK_FRAMES\s*=\s*(\d+)/.exec(consts)?.[1]);
  const fastConf = Number(/ORIENT_FAST_LOCK_CONF\s*=\s*([\d.]+)/.exec(consts)?.[1]);
  check("fast path is strictly faster than the slow bar", fastFrames > 0 && fastFrames < 10,
    String(fastFrames));
  check("...but demands more than the per-sample minimum to get there",
    fastConf > 0.85, `${fastConf} vs ORIENT_CONFIDENCE_MIN 0.85`);
  /* Sanity on the resulting freeze: fast confirm has to actually buy back a meaningful
     share of a 5s session or the redesign did nothing. */
  check("a confident turn now confirms in about a second, not two and a half",
    fastFrames * 250 <= 1200, `${fastFrames * 250}ms`);
}

console.log("\n── the reveal waits for real frames, not a fixed guess ──");
{
  const reveal = extract("function waitForRemoteFrames", "/* @param {\"turn-detected\"");
  check("resolves on remote frames when rVFC is available",
    /requestVideoFrameCallback/.test(reveal), reveal);
  check("always arms a timeout so a stalled track cannot pin the overlay up",
    /setTimeout\(finish, timeoutMs\)/.test(reveal), reveal);
  check("resolves exactly once", /if \(!done\) \{ done = true; resolve\(\); \}/.test(reveal), reveal);
  check("falls back to the timer when rVFC is missing",
    /typeof ai\.requestVideoFrameCallback !== "function"\) return/.test(reveal), reveal);
  /* The swap path must use it - a fixed sleep there is the guess this replaced. */
  const swap = extract("async function maybeSwap", "const timer = setInterval");
  check("the swap awaits real frames before releasing the hold",
    /await waitForRemoteFrames\(ORIENT_REVEAL_FRAMES, ORIENT_REVEAL_MAX_MS\)/.test(swap), swap);
  check("the old fixed grace period is gone from the swap path",
    !/ORIENT_FADE_HOLD_MS/.test(swap), swap);
}

console.log("\n── release telemetry: how much of the session was actually frozen ──");
{
  const { api, events } = harness();
  api.orientHoldBegin("turn-detected");
  api.orientHoldEnd("swap-complete");
  const log = events.find((e) => e.op === "log" && /releasing hold/.test(String(e.a[0])));
  check("the release logs its duration", !!log && /after \d+ms/.test(String(log.a[0])), JSON.stringify(events));
  check("...and the share of the billed window it consumed",
    !!log && /% of the billed window/.test(String(log.a[0])), log && String(log.a[0]));
  check("...and which path released it",
    !!log && /swap-complete/.test(String(log.a[0])), log && String(log.a[0]));
  /* Not gated behind ORIENT_DEBUG (the harness sets it false): a release that only
     appears in debug builds cannot be used to tune the fast-confirm thresholds. */
  check("logged even with ORIENT_DEBUG off", !!log);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
