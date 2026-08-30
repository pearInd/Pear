#!/usr/bin/env node
/* THE RE-DRAPE CHURN WINDOW - "the BOSTON shorts render, then I move and they go plain
   black."
   =============================================================================
   THE REPORT: a lower-body garment with strong identity - green, printed text - renders
   correctly on the first frame, and the moment the shopper moves it collapses to a plain
   dark short with no text. It comes back, then goes again.

   THE MECHANISM IS NOT A LOST REFERENCE. reconditionForTopology() re-uploads the SAME
   bytes; nothing overwrites or flushes the active blob. What it does is clear
   lastSentImageRef / rtImageOnWire / lastSentPrompt to force past applyGarment's no-op
   skip, then issue a full rtClient.set({ image }). applyGarment's own flicker-fix comment
   records what that costs: while the re-upload is in flight Decart has nothing to condition
   on and renders from its own prior - a generic garment - until the new reference lands.

   AND IT FIRES ON MOVEMENT, WHICH IS WHY IT READS AS "MOTION BREAKS IT". The topology
   sampler runs every BODY_TOPOLOGY_SAMPLE_MS (350ms) and dispatches a re-drape whenever a
   shift clears the threshold, bounded by BODY_RECONDITION_COOLDOWN_MS (900ms). Sustained
   movement therefore re-uploads roughly once a second, and every one of those windows is
   currently UNCOVERED. On a plain white tee the churn frame looks similar enough to pass;
   on green shorts with BOSTON across them it is unmistakable, which is why this surfaced
   on a bottoms garment and reads as a bottoms bug. It is not - it is every garment.

   THE ORIENTATION SWAP ALREADY SOLVED THIS, for its own re-upload: orientHoldBegin()
   freezes the last good dressed frame onto an overlay, the swap runs underneath, and the
   overlay cross-fades out once the new reference has landed. The re-drape does the same
   kind of write and got none of that cover.

   WHY A SEPARATE COVER AND NOT THE ORIENTATION HOLD. app.js is explicit that the
   orientation hold is released by a 250ms sampler tick ("turn-abandoned") that knows
   nothing about a re-drape; sharing one flag would let that tick reveal the feed in the
   middle of an in-flight re-upload - the exact failure this is meant to hide. The two are
   separate mechanisms with a defined handoff, asserted in §3.
   ============================================================================= */

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
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find "${endMarker}"`);
  return SRC.slice(start, end);
}

const coverSrc = extract("const ORIENT_TURN_HOLD_MAX_MS", "function createOrientationWatcher");

function harness() {
  const events = [];
  const timers = [];
  const sandbox = {
    ORIENT_DEBUG: false,
    console: { log() {}, warn: (...a) => events.push({ op: "warn", a }) },
    orientFadeFreeze: () => events.push({ op: "freeze" }),
    orientFadeReveal: () => events.push({ op: "reveal" }),
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  const api = new Function(...Object.keys(sandbox),
    coverSrc + "\nreturn { orientHoldBegin, orientHoldEnd, redrapeCoverBegin, redrapeCoverEnd," +
    " holdActive: () => _orientHoldActive, coverActive: () => _redrapeCoverActive };"
  )(...Object.values(sandbox));
  return { api, events, timers, fire: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }) };
}

console.log("── §1 THE COVER: one frozen frame across the re-upload ──");
{
  const { api, events } = harness();
  api.redrapeCoverBegin("topology");
  check("raising the cover freezes the last good dressed frame",
    events.filter((e) => e.op === "freeze").length === 1 && api.coverActive() === true);
  check("...and raising it twice does NOT re-freeze mid-window",
    (api.redrapeCoverBegin("topology"), events.filter((e) => e.op === "freeze").length === 1),
    "a second snapshot would capture the churn frame this exists to hide");
  api.redrapeCoverEnd("done");
  check("releasing reveals the live feed exactly once",
    events.filter((e) => e.op === "reveal").length === 1 && api.coverActive() === false);
  api.redrapeCoverEnd("done again");
  check("...and releasing twice is a no-op",
    events.filter((e) => e.op === "reveal").length === 1);
}
{
  const { api, events, fire } = harness();
  api.redrapeCoverBegin("topology");
  fire();
  check("a stuck re-drape is bounded by a ceiling, like the turn hold",
    api.coverActive() === false && events.some((e) => e.op === "reveal"),
    "a cover whose release never arrives would freeze the session behind a still");
  check("...and says so, since a frozen feed re-appearing needs explaining",
    events.some((e) => e.op === "warn"));
}

console.log("\n── §2 THE CEILING IS SHORTER THAN THE TURN HOLD'S, and deliberately ──");
{
  /* A re-drape is one set() with bytes already resident - far shorter than a turn, which
     spends ~2500ms confirming before it even starts. Reusing the 4s turn ceiling would sit
     on a still frame for seconds after a re-drape that had already failed. */
  check("the re-drape ceiling is its own constant, shorter than the turn's",
    /const REDRAPE_COVER_MAX_MS\s*=\s*(\d+);/.test(SRC) &&
    Number(/const REDRAPE_COVER_MAX_MS\s*=\s*(\d+);/.exec(SRC)[1]) < 4000,
    "a re-drape that outruns its own ceiling is a different failure from a stuck turn");
}

console.log("\n── §3 HANDOFF: the two covers never fight over the overlay ──");
{
  /* A turn can begin while a re-drape cover is already up - the topology sampler (350ms)
     and the orientation sampler (250ms) are independent. The overlay is already showing a
     GOOD frame, so the turn must take ownership WITHOUT re-freezing: a fresh freeze here
     would capture whatever the churn is currently rendering. */
  const { api, events } = harness();
  api.redrapeCoverBegin("topology");
  api.orientHoldBegin("turn-detected");
  check("a turn starting during a re-drape does NOT re-freeze the overlay",
    events.filter((e) => e.op === "freeze").length === 1,
    "the frame already up is the good one; re-capturing takes the churn frame instead");
  check("...and the turn hold takes ownership",
    api.holdActive() === true);

  api.redrapeCoverEnd("done");
  check("...so the re-drape finishing does NOT reveal - the turn still wants the freeze",
    events.filter((e) => e.op === "reveal").length === 0,
    "revealing here drops the shopper into the middle of the turn's own window");
  check("...and the turn hold is still up, holding it",
    api.holdActive() === true);

  api.orientHoldEnd("swap-complete");
  check("the turn's own release is what finally reveals",
    events.filter((e) => e.op === "reveal").length === 1 && api.holdActive() === false);
}
{
  /* The reverse order is already handled in app.js - reconditionForTopology() bails when
     _orientHoldActive - but assert the primitive is safe on its own, since that early
     return is one edit away from being removed. */
  const { api, events } = harness();
  api.orientHoldBegin("turn-detected");
  api.redrapeCoverBegin("topology");
  check("a re-drape cover during a turn hold does not re-freeze either",
    events.filter((e) => e.op === "freeze").length === 1);
  api.redrapeCoverEnd("done");
  check("...and does not reveal out from under the turn",
    events.filter((e) => e.op === "reveal").length === 0 && api.holdActive() === true);
}

console.log("\n── §4 IT IS ACTUALLY WIRED INTO THE RE-DRAPE ──");
{
  /* The guard-dead-call-site rule: this file carries a report of a correct boundary
     function that was never reached. Assert the CALL SITE. */
  const fn = extract("async function reconditionForTopology(step)", "/* ── end body-presence gate ── */");
  check("reconditionForTopology raises the cover",
    /redrapeCoverBegin\(/.test(fn), "without this the churn window is visible on every move");
  check("...BEFORE the re-upload, not after it",
    fn.indexOf("redrapeCoverBegin(") < fn.indexOf("await applyActive()"),
    "a cover raised after the write covers nothing");
  check("...and releases it in a finally, so a throw cannot strand a frozen feed",
    /finally\s*\{[\s\S]*?redrapeCoverEnd\(/.test(fn),
    "an exception mid-re-drape would otherwise leave a still frame up until the ceiling");
  /* The wire-state clears are what make this a FULL re-upload rather than a no-op, and
     they are why the window exists at all. If they ever go away the cover is pointless -
     assert them so the two stay explained together. */
  check("the re-drape still forces a genuine re-upload - that is what needs covering",
    /lastSentImageRef = null;/.test(fn) && /rtImageOnWire = false;/.test(fn),
    "if this became a no-op dispatch the cover would be freezing the feed for nothing");
  check("and it still stands down during a front/back swap, which owns the frame itself",
    /if \(_orientHoldActive\) return;/.test(fn));
}

console.log("\n── §5 NOT A BOTTOMS FIX - the churn was never region-specific ──");
{
  /* The report arrived on shorts because green + printed text makes the churn frame
     obvious; a plain tee hides it. Nothing in the re-drape path branches on region, and
     asserting that stops a future "fix" from scoping the cover to bottoms and leaving tops
     with the bug that was never actually fixed for them either. */
  const fn = extract("async function reconditionForTopology(step)", "/* ── end body-presence gate ── */");
  check("the re-drape path does not branch on garment region",
    !/isBottomsGarment|garmentType/.test(fn),
    "scoping this to bottoms would leave the identical bug live on every top");
}

console.log("\n── §6 THE THIRD WRITE SITE: presence regain, after a 360 ──");
/* THE REPORT: "front and back both render correctly during the turn, but the moment I
   complete a full 360 and come back to face-forward, it hallucinates a completely
   different shirt - a Real Madrid jersey with sponsor logos."

   IT IS THIS FILE'S OWN MECHANISM, through the one write site that never got the cover.
   There are three mid-session re-uploads. The orientation swap has orientHoldBegin(). The
   re-drape has redrapeCoverBegin(), added by the report above. reconditionForPresence()
   has neither, and it issues the same full applyActive() dispatch.

   WHY A 360 FIRES IT, SPECIFICALLY. presenceFromPoseResult() requires LEFT_SHOULDER,
   RIGHT_SHOULDER, LEFT_HIP and RIGHT_HIP to each clear POSE_MIN_CONFIDENCE. Through the
   side-on quarters of a rotation one shoulder and one hip are occluded by the shopper's
   own torso, their visibility falls, and presence is LOST. Completing the turn brings all
   four back at once, the gate flips `present && !wasPresent`, and the re-condition fires -
   uncovered - exactly as the shopper arrives back at front. The churn window is then fully
   visible, and what is visible in it is Decart rendering from its own prior. On a plain tee
   that reads as a wobble; on a garment with a strong graphic it reads as a different shirt,
   which is why the report names a specific jersey.

   THE FIX IS THE SAME ONE, at the same distance from the write: raise before, release in a
   finally. Nothing about the presence path makes it a different kind of dispatch. */
{
  /* BRACE-BALANCED, not marker-delimited. The nearest end marker sits well past
     reconditionForTopology(), so a marker extract here would swallow the neighbour that
     ALREADY has the cover and report a pass for a function that has none - the assertion
     would be measuring the wrong body entirely. */
  const lift = (signature) => {
    const i = SRC.indexOf(signature);
    if (i < 0) throw new Error("not found in app.js: " + signature);
    let depth = 0;
    for (let k = SRC.indexOf("{", i); k < SRC.length; k++) {
      if (SRC[k] === "{") depth++;
      else if (SRC[k] === "}" && --depth === 0) return SRC.slice(i, k + 1);
    }
    throw new Error("unbalanced braces: " + signature);
  };
  const fn = lift("async function reconditionForPresence()");
  check("the extraction is the presence function alone, not its neighbour",
    /presenceReconditionInFlight/.test(fn) && !/reconditionForTopology/.test(fn),
    "a marker extract here reaches past into the function that already has the cover");
  check("reconditionForPresence raises the cover too - it is the same kind of write",
    /redrapeCoverBegin\(/.test(fn),
    "an uncovered presence regain is the 360-degree hallucination");
  check("...BEFORE its re-upload, not after it",
    fn.indexOf("redrapeCoverBegin(") < fn.indexOf("await applyActive()"),
    "a cover raised after the write covers nothing");
  check("...and releases it in a finally, so a throw cannot strand a frozen feed",
    /finally\s*\{[\s\S]*?redrapeCoverEnd\(/.test(fn),
    "a throw mid-re-condition would otherwise hold a still frame until the ceiling");
  /* The bails must stay AHEAD of the cover. Every one of them means "no write is going to
     happen", and raising a cover over a dispatch that never runs freezes the feed for
     nothing - the exact cost this suite exists to avoid spending. */
  check("the early bails still run before the cover is raised",
    fn.indexOf("if (presenceReconditionInFlight") < fn.indexOf("redrapeCoverBegin(") &&
    fn.indexOf("if (wireBusy()) return;") < fn.indexOf("redrapeCoverBegin("),
    "covering a dispatch that returns early would freeze the feed over nothing");
  /* All three write sites now cover their window. Asserted together so a fourth one added
     later has an obvious precedent to follow rather than a pattern to rediscover. */
  check("all three mid-session re-upload sites are now covered",
    /redrapeCoverBegin\(/.test(lift("async function reconditionForTopology(step)")) &&
    /redrapeCoverBegin\(/.test(fn) &&
    /orientHoldBegin\("swap"\)/.test(SRC),
    "topology, presence and the orientation swap - the complete set");
}

console.log(fails === 0 ? "\nredrape-cover: OK" : `\nredrape-cover: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
