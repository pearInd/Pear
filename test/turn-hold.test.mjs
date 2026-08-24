/* "When I turn around, my real shirt comes back for a moment."

   ROOT CAUSE: the cross-fade freeze used to be raised inside maybeSwap() - i.e. only once
   a flip was CONFIRMED, which is ORIENT_LOCK_FRAMES (5 samples ≈ 1.25s) after the shopper
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
    /* TRUE in the harness on purpose: the sections below test the hold MECHANISM - one
       snapshot, idempotency, the timer ceiling, every teardown path - and a mechanism
       that cannot be raised cannot be tested. The SHIPPED value is false (see
       UI_HOLD_OVERLAYS_ENABLED in config.js), and that is asserted separately below so
       the switch is pinned in both directions. */
    UI_HOLD_OVERLAYS_ENABLED: true,
    ORIENT_DEBUG: false,
    console: { log() {}, warn: (...a) => events.push({ op: "warn", a }) },
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
  /* 400 now: 4000 -> 1800 -> 400, the last step because the recorded stream proved there
     were no bad frames under the cover (the .mp4 draws #aiVideo with no overlay in its
     path and shows zero reversions across rotation). What this section owns is unchanged:
     a hold may never outlive its timer. The VALUE is pinned because every one of those
     steps was a deliberate trade against a report, not a tuning drift. */
  check("a safety timer is armed, at the lowered ceiling", api.MAX === 400, String(api.MAX));
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
  check("raised while a switch is pending but NOT yet confirmed (dual-view axis)",
    /const frontBackTurn = dualView && !acquiring && needsSwitch && !confirmed;/.test(watcher),
    watcher.slice(watcher.indexOf("frontBackTurn ="), watcher.indexOf("frontBackTurn =") + 200));
  check("...raised on that axis alone now - see the profile-axis section below",
    /if \(frontBackTurn\) orientHoldBegin\("turn-detected"\);/.test(watcher));
  check("released as soon as that evidence clears",
    /if \(frontBackTurn\) orientHoldBegin\("turn-detected"\);[\s\S]*?else if \(_orientHoldActive\) orientHoldEnd\("turn-abandoned"\);/.test(watcher));
  /* ACQUIRING is the first reading of a DUAL-VIEW session's front/back lock: nothing is
     confirmed, nothing dressed has been rendered yet, and freezing there would stall the
     opening frames behind a still. Meaningless without a lock, so single-view items use
     isGarmentApplied instead - see the next block. */
  check("dual-view: never raised while ACQUIRING the first orientation of the session",
    /const frontBackTurn = dualView && !acquiring && needsSwitch/.test(watcher));

  const stop = extract("    stop() {", "  };\n}");
  check("the watcher releases its hold when it stops (or the still sticks forever)",
    /orientHoldEnd\("watcher-stopped"\)/.test(stop), stop);
}

console.log("\n── wiring: the PROFILE hold is RETIRED - it was the 90-degree freeze ──");
{
  /* THIS SECTION INVERTED, and the report that inverted it is worth stating in full:
     "the feed freezes for a second or two, but ONLY when I turn sideways, and ONLY live -
     the recording of the same session is smooth."

     That asymmetry is the diagnosis. The recorder paints #aiVideo directly; the freeze was
     #orientFadeCanvas, the opaque still this very hold raises over it. The recorder cannot
     see that overlay, so live froze and replay did not. Nothing was wrong with WebRTC.

     WHAT MADE IT LAST. `enteringProfile` fired at lastProfileScore >
     ORIENT_PROFILE_EXIT_SCORE - the EXIT threshold (0.25), deliberately low because its
     real job is hysteresis on the way out. As an ENTRY trigger it fires the moment a
     shopper starts to turn, while release needed autoProfile to actually flip
     (ORIENT_PROFILE_ENTER samples at >= 0.55, ~500ms at best, plus a tick to notice). A
     clean turn froze ~750ms; a shopper lingering anywhere between 0.25 and 0.55 - most of
     a real rotation - held it up to the 4s ceiling.

     WHY RETIRED RATHER THAN RETUNED. What this hold covered was the window until the POSE
     SENTENCE landed. There is no pose sentence: under strict image-only conditioning the
     prompt is one frozen string, so maybeUpdateProfile()'s applyActive() finds image and
     prompt both unchanged and dispatches nothing (applyGarment's no-op skip). It was
     freezing the live view for up to four seconds to hide a transition that no longer
     transitions. Retuning the threshold would only shorten a freeze with no purpose left.

     THE FRONT/BACK HOLD STAYS - asserted in the section above - because it covers a real
     asset swap: with COMPOSITE_DEFAULT off, a confirmed flip changes the reference image
     and re-uploads it, so there genuinely is a window between garments.

     TO RESTORE: give it something to cover first (restore a pose clause to the prompt -
     see IMAGE_ONLY_PROMPT's restore list), then raise it on ORIENT_PROFILE_ENTER_SCORE,
     never on the EXIT floor. */
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  /* Comments stripped: the block comment at this exact site is the RECORD of the bug and
     names every symbol below by design. A check that trips over the explanation would
     force whoever reads it to delete the documentation - the same rule variant-sync and
     image-first already follow. */
  const code = watcher.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no profile-axis trigger raises the hold any more",
    !/enteringProfile/.test(code) && !/profile-turn-detected/.test(code),
    code.slice(code.indexOf("const dualView"), code.indexOf("const dualView") + 320));
  check("...and the EXIT floor is no longer used as an entry threshold anywhere",
    !/lastProfileScore > ORIENT_PROFILE_EXIT_SCORE/.test(code),
    "the exit threshold is hysteresis on the way OUT - as an entry trigger it fires far too early");
  check("the front/back hold is untouched - it covers a real asset swap",
    /if \(frontBackTurn\) orientHoldBegin\("turn-detected"\);/.test(watcher));
  /* The mechanism is deliberately left intact: orientHoldBegin/End and the fade overlay
     are still what the front/back swap uses, and are what a restored profile hold would
     plug back into. Retiring a trigger must not delete the machinery behind it. */
  check("the hold machinery itself survives, so restoring the trigger stays a one-liner",
    /function orientHoldBegin\(reason\)/.test(SRC) && /function orientHoldEnd\(reason\)/.test(SRC));
  check("...and app.js records why it went, next to the code that used to do it",
    /THE 90-DEGREE FREEZE\. This block WAS the bug/.test(SRC));
}

console.log("\n── wiring: single-view items get the SAME protection, with their own readiness gate ──");
{
  /* THE SECOND REGRESSION THIS COVERS: everything above only ever ran for garments with a
     real, distinct back photo (canCombineViews() true) - a custom upload or single-photo
     catalog item got NONE of it, no matter how the shopper turned, because the entire
     watcher was gated on `currentAngle === AUTO_ANGLE`, which those items never reach. */
  const watcher = extract("const timer = setInterval", "}, ORIENT_SAMPLE_MS);");
  check("dualView is read fresh from currentAngle, not assumed",
    /const dualView = currentAngle === AUTO_ANGLE;/.test(watcher));
  /* `acquiring` (autoOrientation === null) never resolves for a single-view item - there is
     no lock for it to leave PENDING, since maybeSwap() (the only place that sets
     autoOrientation) is permanently inert without AUTO_ANGLE. isGarmentApplied is the
     readiness signal that actually applies to them: once one frame has ever been dressed,
     a profile reading is worth protecting. */
  /* `holdReady` went with the profile hold - it existed only to gate that trigger for
     single-view sessions, which have no front/back lock to be "acquiring". The readiness
     concept still matters for the axis that survives, and frontBackTurn carries it via
     !acquiring; single-view items simply never reach that branch. */
  check("the retired readiness gate is gone with the trigger it gated",
    !/holdReady/.test(watcher.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    "a dangling gate for a trigger that no longer exists reads as a half-done removal");
  check("frontBackTurn is dual-view only - maybeSwap() stays inert for single-view items",
    /const frontBackTurn = dualView && /.test(watcher));
  /* The other half of the fix: `confirmed` can go permanently true for a single-view item
     the moment its front/back vote settles (acquiring is always true for them, and
     confirmed only needs a settled streak while acquiring) - with no swap ever pending
     behind it. Without gating the skip on dualView too, maybeUpdateProfile() would stop
     being called for the rest of the session the moment the shopper is first read as
     "front", silently undoing the whole fix. */
  /* Still per-tick and still gated the same way - but no longer AWAITED. Awaiting it held
     `sampling` true across a network round-trip, so the next orientation sample was
     skipped and the watcher's effective rate collapsed from 250ms to however long Decart
     took to answer - during the turn, which is exactly when the signal matters most. The
     mutex lives inside maybeUpdateProfile (`applying`), not here, so dropping the await
     cannot produce overlapping applies. */
  check("maybeUpdateProfile's per-tick call is skipped only for a PENDING DUAL-VIEW swap",
    /if \(!\(dualView && confirmed\)\) \{\s*\n(?:[^\n]*\n)*?\s*maybeUpdateProfile\(lastProfileScore\)\.catch\(\(\) => \{\}\);/.test(watcher));
  check("...and runs in the background, so a slow apply cannot stall the next sample",
    /maybeUpdateProfile\(lastProfileScore\)\.catch\(\(\) => \{\}\);/.test(watcher) &&
    !/await maybeUpdateProfile\(/.test(watcher));
  check("...while maybeSwap stays awaited - it owns the hold's lifecycle",
    /if \(dualView && confirmed\) await maybeSwap\(lastVote\);/.test(watcher));
  check("maybeSwap is only ever invoked for a dual-view session",
    /if \(dualView && confirmed\) await maybeSwap\(lastVote\);/.test(watcher));
}

console.log("\n── wiring: syncOrientationWatcher arms for single-view items too, without going stale ──");
{
  const sync = extract("function syncOrientationWatcher", "\n}\n");
  check("dual-view still requires a real, distinct back (canCombineViews)",
    /const dualView = currentAngle === AUTO_ANGLE && canCombineViews\(activeItem\);/.test(sync));
  check("single-view arms too - no canCombineViews requirement, just a live item",
    /const singleView = currentAngle !== AUTO_ANGLE && !!activeItem;/.test(sync));
  check("armed by either tier", /const want = \(dualView \|\| singleView\)/.test(sync));
  /* GARMENT_FRONT/GARMENT_BACK (and, now, which item the profile signal belongs to) are
     captured ONCE at watcher creation. Swapping between two items that are both dual-view,
     or both single-view, leaves `want` true throughout - so without this, the watcher
     would keep running against the OLD item's captured state forever. */
  check("a watcher running against a DIFFERENT item than the current one is torn down first",
    /orientWatcher && orientWatcherItem !== activeItem/.test(sync));

  const profileActiveSrc = extract("function profileActive()", "\n");
  check("profileActive() is gated on watcher liveness, not on AUTO_ANGLE",
    /function profileActive\(\) \{ return !!orientWatcher && autoProfile; \}/.test(profileActiveSrc));

  check("every fresh watcher instance resets autoProfile - no stale reading crosses an item swap",
    /autoProfile = false;/.test(extract("const GARMENT_BACK  = distinctBackOf(activeItem, gInit);", "// Private sampler")));
}

console.log("\n── wiring: a fresh watcher never inherits a stale lock from its predecessor ──");
{
  /* orientWatcherItem now forces a rebuild on EVERY item swap, not just a mode change - so
     the "same-tier swap" gap (dual-view garment A to dual-view garment B, both AUTO_ANGLE
     throughout, so none of renderPerspectiveSelector()/setAngle()/goLive()'s own
     `!wasAuto`-gated resets fire) is now a routine path, not a rare one. Without this
     reset, garment B's brand new watcher would start already "confirmed BACK" off of
     garment A's classification - skipping the acquire phase entirely for a side nobody
     has looked at yet. */
  const watcherInit = extract("const GARMENT_BACK  = distinctBackOf(activeItem, gInit);", "// Private sampler");
  check("autoOrientation is reset to PENDING on every fresh watcher instance",
    /autoOrientation = null;/.test(watcherInit), watcherInit);
  check("...right alongside the autoProfile reset, not just one of the two",
    /autoOrientation = null;[\s\S]*autoProfile = false;/.test(watcherInit));
}

console.log("\n── wiring: a torn-down watcher's in-flight maybeSwap() can't clobber a fresh one's state ──");
{
  /* orientWatcherItem also means teardown-mid-swap is routine now (a shopper can swap
     garments while an orientation flip's async work - a Blob fetch, a decode probe, the
     rtClient.set() round-trip - is still in flight). None of those awaits used to
     re-check `disposed` afterward, so a stale continuation could resume after stop() and
     mutate MODULE-level state (orientHoldEnd/toast/autoOrientation) that a brand new
     watcher instance may already be relying on - the exact "late callback from a
     superseded session" class of bug this file already guards against for the SDK
     reconnect path (see reconnect.test.mjs). Asserted structurally: a disposed check sits
     immediately after each of maybeSwap()'s three await points, before anything the await
     resolved to is used for anything. */
  const swap = extract("async function maybeSwap(next)", "\n  }\n\n  /* The edge-on counterpart");
  check("guarded immediately after the back-Blob fetch (before the null check uses it)",
    /const backBlob = await garmentBlobCached\(GARMENT_BACK\);[\s\S]*?\n {6}if \(disposed\) return;\n {6}if \(!backBlob\)/.test(swap),
    swap.slice(swap.indexOf("const backBlob"), swap.indexOf("const backBlob") + 120));
  check("guarded after the decode/flat-probe awaits (before the flat-image check uses the result)",
    /probe\.close\?\.\(\);\s*\n\s*\} catch \(_\)[^\n]*\n {6}if \(disposed\) return;[^\n]*\n {6}if \(backLooksFlat\)/.test(swap));
  check("guarded after the main apply + fade-hold awaits, before touching the hold/toast",
    /ORIENT_FADE_HOLD_MS\)\);[^\n]*\n[\s\S]*?\n {6}if \(disposed\) return;\n {6}orientHoldEnd\("swap-complete"\);/.test(swap));
  check("the failure path also respects it - a stale instance's catch can't release a fresh hold",
    /if \(!disposed\) orientHoldEnd\("swap-failed"\);/.test(swap));
}

console.log("\n── behaviour: the shared hold primitive treats a profile trigger exactly like a turn-detected one ──");
{
  /* Runs the REAL orientHoldBegin/orientHoldEnd (same extraction as the top of this file)
     to prove the new reason string exercises the identical freeze/reveal/ceiling machinery
     - i.e. this isn't a parallel, half-wired freeze path that could drift from the one
     already proven safe above. */
  const { api, events, fireTimers } = harness();
  api.orientHoldBegin("profile-turn-detected");
  check("entering profile freezes the live frame, same as a front/back turn-detected",
    events.filter((e) => e.op === "freeze").length === 1);
  check("the hold is active", api.active() === true);

  // A front/back vote disagreeing WHILE already frozen for profile must not re-freeze -
  // same "never re-freeze mid-turn" guard, now exercised across the two reasons.
  api.orientHoldBegin("turn-detected");
  check("a turn-detected begin while already frozen for profile does NOT re-freeze",
    events.filter((e) => e.op === "freeze").length === 1);

  api.orientHoldEnd("turn-abandoned");
  check("release reveals the live feed",
    events.filter((e) => e.op === "reveal").length === 1 && api.active() === false);
}


console.log("\n── SHIPPED OFF: the overlay is a complete no-op, not a paused one ──");
{
  /* The value the room actually runs with. Disabled by request: the fades and freezes were
     more objectionable than what they hid, and the recorded .mp4 - which draws #aiVideo
     with no overlay in its path - shows a clean stream across rotation. The harness above
     forces it TRUE so the mechanism stays testable; this pins the shipped direction, so
     the switch cannot be half-tested. */
  const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8");
  check("UI_HOLD_OVERLAYS_ENABLED is OFF in the shipped config",
    /UI_HOLD_OVERLAYS_ENABLED: false,/.test(CFG),
    "the harness enabling it must never be mistaken for the room enabling it");
  /* A KILL SWITCH, NOT A DELETION. The check sits ahead of every other early-return in
     orientHoldBegin, so a disabled overlay never sets its active flag, never snapshots and never
     arms a timer - which is also what stops it leaking one into a teardown path. */
  const start = SRC.indexOf("function orientHoldBegin(");
  const body = SRC.slice(start, start + 500);
  check("...and the switch is the FIRST thing orientHoldBegin() checks",
    /^function orientHoldBegin\([^)]*\) \{[\s\S]{0,400}?if \(!UI_HOLD_OVERLAYS_ENABLED\) return/.test(body),
    body.slice(0, 260));
}
console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
