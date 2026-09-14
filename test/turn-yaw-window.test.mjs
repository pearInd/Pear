#!/usr/bin/env node
/* THE RETURN LEG NEVER CORROBORATED - "after a full 360 the back garment stays on my
   front for seconds".
   =============================================================================
   THE REPORT: turn to the back and the rear asset lands; keep turning to face the camera
   again and GARMENT_BACK stays rendered on the shopper's FRONT for a long beat before the
   front asset returns. Filed alongside "there is a visible gap while it swaps sides".

   NOT A FETCH, NOT A LATCH. Both Blobs are pinned in RAM before connect (pinActiveGarmentBlobs,
   preloadGarmentAssets), and the return leg's set() is never skipped - a back Blob and a front
   Blob are different objects, so applyGarment()'s no-op test cannot match. The time is spent
   CONFIRMING the flip: ORIENT_LOCK_FRAMES x ORIENT_SAMPLE_MS = 2.5s of agreeing votes, which
   the yaw-corroborated path (ORIENT_CORROBORATED_FRAMES, ~1s) was added to shorten.

   WHY THAT PATH COULD NOT FIRE ON A FULL TURN. It measured the swing from the |yaw| captured
   when the NEW vote streak began. bodyYawDegrees() is an asin() form: |yaw| rises to ~90 at
   edge-on and falls back to ~0 whether the shopper ends up facing the lens or facing away.
   The edge-on peak - the one thing a head-turn cannot fake - happens in the ABSTAIN window
   BETWEEN the last vote for the old side and the first vote for the new one, so a baseline
   taken at streak start is always taken AFTER it. The return leg therefore always paid the
   full 2.5s, with the back reference on screen. makeTurnYawWindow() measures the swing from
   the PEAK |yaw| seen since the last vote that AGREED with the lock instead.

   SECOND PASS - "still falls back to 2.5s sometimes, and the swap says 'waiting for the wire'".
   Three ways the window could still be starved of the reading it needs:
     · THE POSE LOOP WENT BLIND DURING ITS OWN RE-DRAPE. startPresenceWatcher() awaited
       reconditionForTopology() inside its inFlight guard, so no inference ran - and no yaw was
       published - for a whole image upload. A re-drape fires on a 15-degree change, i.e. at the
       start of every turn, so the blind spot landed on the rise to edge-on.
     · YAW WAS PUBLISHED AT THE TOPOLOGY CADENCE (~480ms on a 240ms loop) against a 600ms
       freshness window: two samples across a fast half-turn, and one unreadable frame went stale.
     · MEDIAPIPE LOSES THE FAR SHOULDER NEAR EDGE-ON, so the readable peak can sit under the bar.
   And one way a confirmed swap still waited: a re-drape that started mid-turn, before any
   disagreeing vote had raised the hold, held the wire when the flip arrived.

   §1 exercises the REAL window and flip decision from app.js. §2 replays a modelled 360 through
   them. §3 is the edge-on keypoint loss. §4 is the mid-turn wire guard. §5 pins the wiring. The
   model is a model - it cannot stand in for a webcam; the live check is the ORIENT_DEBUG line
   (?orient_debug=1), which prints yawΔ, the peak it was measured from, and the face streak.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const numOr = (name, fallback = NaN) => {
  const m = new RegExp(`^const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m").exec(SRC);
  return m ? Number(m[1]) : fallback;
};

const TURN_DEG   = numOr("ORIENT_YAW_TURN_DEG");
const LOSS_DEG   = numOr("PRESENCE_PROMPT_YAW_SUPPRESS_DEG");
const LOCK_F     = numOr("ORIENT_LOCK_FRAMES");
const LOCK_MS    = numOr("ORIENT_LOCK_MS");
const CORR_F     = numOr("ORIENT_CORROBORATED_FRAMES");
const ACQ_F      = numOr("ORIENT_ACQUIRE_FRAMES");
const FACE_F     = numOr("ORIENT_FACE_RETURN_FRAMES");
const SAMPLE_MS  = numOr("ORIENT_SAMPLE_MS");
const COOLDOWN   = numOr("ORIENT_COOLDOWN_MS");
const FRESH_MS   = numOr("ORIENT_YAW_FRESH_MS");
const HOLD_MAX   = numOr("ORIENT_TURN_HOLD_MAX_MS");

check("ORIENT_FACE_RETURN_FRAMES exists, and sits between acquisition and the corroborated bar",
  Number.isFinite(FACE_F) && FACE_F >= ACQ_F && FACE_F >= 2 && FACE_F < CORR_F,
  `face=${FACE_F} acquire=${ACQ_F} corroborated=${CORR_F} - one detection is a hair trigger`);

const start = SRC.indexOf("function makeTurnYawWindow(");
const end   = SRC.indexOf("/* ── THE BEST FRONT-FACING FRAME");
let makeTurnYawWindow = null, orientFlipDecision = null;
if (start === -1 || end === -1 || end < start) {
  check("makeTurnYawWindow() exists in app.js", false, "the peak-since-agreement window is not implemented");
} else {
  const api = new Function("ORIENT_YAW_TURN_DEG", "PRESENCE_PROMPT_YAW_SUPPRESS_DEG", "ORIENT_ACQUIRE_FRAMES",
    "ORIENT_LOCK_FRAMES", "ORIENT_CORROBORATED_FRAMES", "ORIENT_LOCK_MS", "ORIENT_FACE_RETURN_FRAMES",
    SRC.slice(start, end) +
    "\nreturn { makeTurnYawWindow, orientFlipDecision: typeof orientFlipDecision === 'function' ? orientFlipDecision : null };")(
    TURN_DEG, LOSS_DEG, ACQ_F, LOCK_F, CORR_F, LOCK_MS, FACE_F);
  makeTurnYawWindow = api.makeTurnYawWindow;
  orientFlipDecision = api.orientFlipDecision;
  check("orientFlipDecision() exists beside the window, so the flip bar is real code under test",
    typeof orientFlipDecision === "function");
}

console.log("── §1 THE WINDOW AND THE FLIP DECISION ──");
if (makeTurnYawWindow) {
  {
    const w = makeTurnYawWindow();
    const r = w.observe("front", "front", 3);
    check("an agreeing vote opens no swing - nothing is turning",
      r.usable === true && r.swing === 0 && r.corroborates === false && w.open === false, JSON.stringify(r));
  }
  {
    const w = makeTurnYawWindow();
    w.observe("back", "back", 4);
    w.observe(null, "back", 40);
    w.observe(null, "back", 85);
    w.observe(null, "back", 50);
    const r = w.observe("front", "back", 20);
    check("a turn through edge-on corroborates on the FIRST vote for the new side",
      r.corroborates === true && r.swing === 65, JSON.stringify(r));
  }
  {
    const w = makeTurnYawWindow();
    w.observe("front", "front", 2);
    let any = false;
    for (const y of [6, 9, 4, 10, 7, 3, 8, 5, 9, 2, 6, 4]) any = w.observe("back", "front", y).corroborates || any;
    check("a head-turn (torso yaw <= 10 degrees) never corroborates, however long the misread lasts",
      any === false && w.turning === false, "ORIENT_LOCK_FRAMES must stay the only bar here");
  }
  {
    const w = makeTurnYawWindow();
    w.observe("front", "front", 0);
    w.observe(null, "front", 80);
    const r = w.observe("front", "front", 5);
    check("returning to the locked side closes the window - the old peak cannot linger",
      r.swing === 0 && r.corroborates === false && w.peak === 5 && w.open === false,
      JSON.stringify({ r, peak: w.peak }));
  }
  {
    const w = makeTurnYawWindow();
    w.observe("front", "front", 0);
    w.observe(null, "front", 80);
    const r = w.observe("back", "front", 78);
    check("holding edge-on is not a turn - the swing is measured DOWN from the peak",
      r.corroborates === false && r.swing === 2, JSON.stringify(r));
  }
  {
    const r2 = makeTurnYawWindow().observe(null, null, null);
    check("no reading at all is not usable", r2.usable === false, JSON.stringify(r2));
    const out = makeTurnYawWindow().observe(null, "front", 30);
    check("the result carries no side - yaw attests a turn, it never picks one",
      !Object.values(out).some((v) => v === "front" || v === "back"), JSON.stringify(out));
  }
}
if (orientFlipDecision) {
  const base = { acquiring: false, needsSwitch: true, held: 0, lock: "back", lastVote: "front" };
  /* TEST 1 OF THE BRIEF - "instant front-lock upon face recovery after high yaw". Instant is
     ORIENT_FACE_RETURN_FRAMES consecutive face DETECTIONS, not one: a single detection is the
     hair trigger the corroborated bar's own test refuses. */
  const lockOn = orientFlipDecision({ ...base, streak: FACE_F, faceStreak: FACE_F, yawCorroborates: true });
  check("face re-acquired after a corroborated turn locks FRONT at ORIENT_FACE_RETURN_FRAMES",
    lockOn.confirmed === true && lockOn.faceReturn === true && FACE_F < lockOn.flipBar, JSON.stringify(lockOn));
  const one = orientFlipDecision({ ...base, streak: 1, faceStreak: 1, yawCorroborates: true });
  check("...but ONE detection is not enough", one.confirmed === false, JSON.stringify(one));
  const noTorso = orientFlipDecision({ ...base, streak: FACE_F + 1, faceStreak: FACE_F + 1, yawCorroborates: false });
  check("...and a face WITHOUT a corroborated torso turn is the over-the-shoulder glance - full bar",
    noTorso.confirmed === false && noTorso.flipBar === LOCK_F, JSON.stringify(noTorso));
  const skin = orientFlipDecision({ ...base, streak: FACE_F, faceStreak: 0, yawCorroborates: true });
  check("...and skin-heuristic 'front' votes are not face detections - no early lock",
    skin.confirmed === false, JSON.stringify(skin));
  const toBack = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: FACE_F, faceStreak: FACE_F, yawCorroborates: true });
  check("the face path only ever returns to FRONT - a missing face is the WEAK direction",
    toBack.confirmed === false && toBack.faceReturn === false, JSON.stringify(toBack));
  const acq = orientFlipDecision({ ...base, acquiring: true, lock: null, streak: ACQ_F, faceStreak: 0, yawCorroborates: false });
  check("acquisition is untouched: ORIENT_ACQUIRE_FRAMES, no yaw", acq.confirmed === true, JSON.stringify(acq));
  const time = orientFlipDecision({ ...base, streak: 1, faceStreak: 0, yawCorroborates: false, held: LOCK_MS });
  check("the ORIENT_LOCK_MS path still ORs in", time.confirmed === true, JSON.stringify(time));
  const settled = orientFlipDecision({ ...base, needsSwitch: false, streak: 20, faceStreak: 20, yawCorroborates: true });
  check("nothing confirms without a pending switch", settled.confirmed === false);
}

console.log("\n── §2 A MODELLED 360: how long GARMENT_BACK stays on a front-facing shopper ──");
/* Facing angle phi in [0,180] (0 = lens, 180 = away). |yaw| folds at edge-on: 90 - |90 - phi|,
   scaled by k because MediaPipe's z is compressed relative to x. The pose loop publishes a
   reading every publishMs when the torso is readable; the watcher treats one older than
   ORIENT_YAW_FRESH_MS as absent, exactly as the tick does. Votes: a face inside faceDeg of
   square -> "front" (a FaceDetector detection); past backDeg -> "back"; otherwise abstain. */
function simulate({ speed, k, faceDeg, backDeg, occludeAbove = Infinity, rule, publishMs, swapMs = 600, script }) {
  const facing = (deg) => { const m = ((deg % 360) + 360) % 360; return m > 180 ? 360 - m : m; };
  const yawOf = (phi) => { const y = 90 - Math.abs(90 - phi); return y > occludeAbove ? null : k * y; };
  const seg = script || [[0, 1000], [180, (180 / speed) * 1000], [180, 3000], [360, (180 / speed) * 1000], [360, 4000]];
  const angleAt = (t) => {
    let from = 0, t0 = 0;
    for (const [to, dur] of seg) {
      if (t <= t0 + dur) return from + (to - from) * ((t - t0) / dur);
      from = to; t0 += dur;
    }
    return seg[seg.length - 1][0];
  };
  const total = seg.reduce((a, [, d]) => a + d, 0);
  let lock = "front", lastVote = null, streak = 0, streakSince = 0, faceStreak = 0, lastSwapAt = -Infinity, busyUntil = 0;
  let reading = null, nextPublish = 0, baseline = null;
  const win = rule === "new" ? makeTurnYawWindow() : null;
  let firstBackVoteAt = null, facedFrontAt = null, frontLockedAt = null, backLockedAt = null;
  for (let t = 0; t <= total; t += SAMPLE_MS) {
    while (nextPublish <= t) {                  // the pose loop runs on its own clock, even mid-swap
      const y = yawOf(facing(angleAt(nextPublish)));
      if (y !== null) reading = { yaw: y, at: nextPublish };
      nextPublish += publishMs;
    }
    if (t < busyUntil) continue;                // maybeSwap is awaited: the sampler is paused
    const phi = facing(angleAt(t));
    const vote = phi <= faceDeg ? "front" : phi >= backDeg ? "back" : null;
    const yaw = reading && t - reading.at <= FRESH_MS ? reading.yaw : null;
    if (lock === "front" && vote === "back" && firstBackVoteAt === null) firstBackVoteAt = t;
    if (backLockedAt !== null && facedFrontAt === null && vote === "front") facedFrontAt = t;
    if (vote) {
      if (vote === lastVote) streak++;
      else { lastVote = vote; streak = 1; streakSince = t; if (rule === "old") baseline = yaw; }
      faceStreak = vote === "front" ? faceStreak + 1 : 0;
    }
    const needsSwitch = !!lastVote && lastVote !== lock;
    const held = lastVote ? t - streakSince : 0;
    let confirmed;
    if (rule === "new") {
      const c = win.observe(vote, lock, yaw).corroborates;
      confirmed = orientFlipDecision({ acquiring: false, needsSwitch, streak, held, yawCorroborates: c, lock, lastVote, faceStreak }).confirmed;
    } else {
      const c = yaw !== null && baseline !== null && Math.abs(yaw - baseline) >= TURN_DEG;
      confirmed = needsSwitch && (streak >= (c ? Math.min(LOCK_F, CORR_F) : LOCK_F) || held >= LOCK_MS);
    }
    if (confirmed && t - lastSwapAt >= COOLDOWN) {
      lock = lastVote; lastSwapAt = t; busyUntil = t + swapMs;
      if (lock === "back" && backLockedAt === null) backLockedAt = t;
      if (lock === "front" && backLockedAt !== null && frontLockedAt === null) frontLockedAt = t;
    }
  }
  return { backLockedAt, frontLockedAt, facedFrontAt,
           backConfirmMs: backLockedAt !== null && firstBackVoteAt !== null ? backLockedAt - firstBackVoteAt : null,
           leakMs: frontLockedAt !== null && facedFrontAt !== null ? frontLockedAt - facedFrontAt : null };
}

if (makeTurnYawWindow && orientFlipDecision) {
  const profiles = [];
  for (const speed of [90, 120]) for (const k of [1, 0.75]) for (const faceDeg of [30, 40]) for (const backDeg of [140, 155])
    profiles.push({ speed, k, faceDeg, backDeg });
  const rows = profiles.map((p) => ({
    p,
    old: simulate({ ...p, rule: "old", publishMs: 480 }),
    neu: simulate({ ...p, rule: "new", publishMs: 240 }),
  }));
  const fmt = (ms) => ms === null ? "never" : `${ms}ms`;
  for (const { p, old, neu } of rows) {
    console.log(`        ${p.speed}°/s k=${p.k} face<=${p.faceDeg}° back>=${p.backDeg}°  ` +
      `back-on-front: ${fmt(old.leakMs)} -> ${fmt(neu.leakMs)}   (back confirm ${fmt(old.backConfirmMs)} -> ${fmt(neu.backConfirmMs)})`);
  }
  check("every profile completes both legs under both rules (the model is sane)",
    rows.every(({ old, neu }) => old.leakMs !== null && neu.leakMs !== null));
  check("streak-start baseline: the return leg never took the corroborated path",
    rows.every(({ old }) => old.leakMs >= (LOCK_F - 1) * SAMPLE_MS), rows.map(({ old }) => old.leakMs).join(","));
  check("now: FRONT locks within ORIENT_FACE_RETURN_FRAMES votes of the face coming back, every profile",
    rows.every(({ neu }) => neu.leakMs <= (FACE_F - 1) * SAMPLE_MS), rows.map(({ neu }) => neu.leakMs).join(","));
  check("...while the BACK flip (the weak, face-absent direction) still needs the corroborated bar",
    rows.every(({ neu }) => neu.backConfirmMs >= (CORR_F - 1) * SAMPLE_MS), rows.map(({ neu }) => neu.backConfirmMs).join(","));

  /* Over-the-shoulder glance: facing away, locked BACK, head turned so FaceDetector fires for
     three seconds. The torso never rotates, so nothing may accelerate. */
  {
    const w = makeTurnYawWindow();
    let lock = "back", streak = 0, faceStreak = 0, flippedAt = null;
    w.observe("back", "back", 3);
    for (let i = 1, t = 0; i <= 12; i++, t += SAMPLE_MS) {
      streak++; faceStreak++;
      const c = w.observe("front", lock, [4, 7, 2, 9, 5, 3][i % 6]).corroborates;
      const d = orientFlipDecision({ acquiring: false, needsSwitch: true, streak, held: t, yawCorroborates: c, lock, lastVote: "front", faceStreak });
      if (d.confirmed && flippedAt === null) flippedAt = i;
    }
    check("glancing over the shoulder while facing away waits the full ORIENT_LOCK_FRAMES",
      flippedAt === LOCK_F, `flipped on vote ${flippedAt}`);
  }
}

console.log("\n── §3 KEYPOINT LOSS AT EDGE-ON DOES NOT RESET THE TURN ──");
if (makeTurnYawWindow) {
  {
    /* TEST 3 OF THE BRIEF. Readable to ~60 degrees, then the far shoulder drops out for the
       whole edge-on band, then readable again near square on the other side. */
    const w = makeTurnYawWindow();
    w.observe("back", "back", 3);
    w.observe(null, "back", 30);
    w.observe(null, "back", 38);                 // last reading before the landmarks go
    const lost = [w.observe(null, "back", null), w.observe(null, "back", null), w.observe(null, "back", null)];
    check("losing the torso mid-turn keeps the window open and the peak intact",
      w.open === true && w.peak === 38 && lost.every((r) => r.corroborates === false && r.usable === false),
      JSON.stringify({ peak: w.peak, lost }));
    check("...and reads the loss itself as edge-on - past the angle where the file already calls it a turn",
      w.edgeLost === true && w.turning === true);
    const back = w.observe("front", "back", 30);
    check("...so the first fresh reading on the far side corroborates, though the readable peak was only 38",
      back.corroborates === true && back.swing === 60, JSON.stringify(back));
    w.observe("front", "front", 2);
    check("an agreeing vote clears the edge-on evidence with the rest of the window",
      w.edgeLost === false && w.open === false && w.turning === false);
  }
  {
    const w = makeTurnYawWindow();
    w.observe("front", "front", 4);
    w.observe(null, "front", 12);
    w.observe(null, "front", null);
    const r = w.observe("back", "front", 5);
    check("a torso lost while nearly square is NOT edge-on (a step toward the lens, a hand across the body)",
      w.edgeLost === false && r.corroborates === false, JSON.stringify({ r, lossDeg: LOSS_DEG }));
  }
  if (orientFlipDecision) {
    const deep = simulate({ speed: 90, k: 0.6, faceDeg: 30, backDeg: 150, occludeAbove: 60, rule: "new", publishMs: 240 });
    const deepOld = simulate({ speed: 90, k: 0.6, faceDeg: 30, backDeg: 150, occludeAbove: 60, rule: "old", publishMs: 480 });
    check("compressed depth AND landmarks gone above 60 degrees: the return still takes the fast path",
      deep.leakMs !== null && deep.leakMs <= (FACE_F - 1) * SAMPLE_MS, JSON.stringify({ deep, deepOld }));
  }
}

console.log("\n── §4 A TURN OWNS THE WIRE: body re-drapes wait until it settles ──");
{
  const a = SRC.indexOf("let _orientTurnSince = 0;");
  const b = SRC.indexOf("/* ── end turn-in-progress flag ── */");
  if (a === -1 || b === -1 || b < a) {
    check("the turn-in-progress flag exists in app.js", false, "not implemented");
  } else {
    let logs = [];
    const flag = new Function("ORIENT_TURN_HOLD_MAX_MS", "ORIENT_DEBUG", "console",
      SRC.slice(a, b) + "\nreturn { orientTurnMark, orientTurnInProgress };")(
      HOLD_MAX, false, { log: (...x) => logs.push(x.join(" ")) });
    check("no turn, no suppression", flag.orientTurnInProgress(1000) === false);
    flag.orientTurnMark(true, 1000);
    flag.orientTurnMark(true, 1900);
    check("a turn suppresses from its first tick, and a later tick does not restart the clock",
      flag.orientTurnInProgress(1900) === true && flag.orientTurnInProgress(1000 + HOLD_MAX) === true);
    check("...but never past ORIENT_TURN_HOLD_MAX_MS - a shopper parked edge-on still gets re-draped",
      flag.orientTurnInProgress(1001 + HOLD_MAX) === false);
    flag.orientTurnMark(false, 2000);
    check("settling releases it at once", flag.orientTurnInProgress(2000) === false);
    check("...and both edges are logged under the [PEAR] prefix",
      logs.length === 2 && logs.every((l) => l.startsWith("[PEAR]")), logs.join(" | "));
  }

  /* TEST 2 OF THE BRIEF, against the REAL dispatcher. */
  const r0 = SRC.indexOf("async function reconditionForTopology(");
  const r1 = SRC.indexOf("\n}\n/* ── end body-presence gate", r0);
  if (r0 === -1 || r1 === -1) {
    check("reconditionForTopology() extracted", false);
  } else {
    const calls = [];
    const run = (turning) => new Function("isLive", "isGarmentApplied", "_orientHoldActive", "orientTurnInProgress",
      "wireBusy", "redrapeCoverBegin", "redrapeCoverEnd", "applyActive", "sessionElapsedMs", "ORIENT_FADE_HOLD_MS",
      "setTimeout", "console",
      "let topologyReconditionInFlight = false, lastSentImageRef = 1, rtImageOnWire = true, lastSentPrompt = 'p';\n" +
      SRC.slice(r0, r1 + 2) + "\nreturn reconditionForTopology;")(
      () => true, true, false, () => turning, () => false,
      () => { calls.push("cover"); return false; }, () => {}, async () => { calls.push("apply"); },
      () => 0, 0, (f) => f(), { log: (...x) => calls.push("log:" + x.join(" ")), warn() {} });
    await run(true)({ reason: "rotation", delta: { yaw: 20 } });
    check("mid-turn, a body-contour shift sends NOTHING and raises no cover",
      !calls.includes("apply") && !calls.includes("cover"), calls.join(" | "));
    check("...and says why, so 'waiting for the wire' is no longer the only trace of a turn",
      calls.some((c) => /re-drape deferred/.test(c) && /turn/.test(c)), calls.join(" | "));
    calls.length = 0;
    await run(false)({ reason: "rotation", delta: { yaw: 20 } });
    check("once settled the same shift dispatches normally", calls.includes("apply"), calls.join(" | "));
  }
}

console.log("\n── §5 THE WIRING ──");
{
  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const w1 = SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0);
  const watcher = w0 !== -1 && w1 !== -1 ? SRC.slice(w0, w1) : "";
  check("one window per watcher instance, so an item swap cannot inherit a pose",
    /const yawWindow = makeTurnYawWindow\(\);/.test(watcher));
  check("fed the vote, the lock BEFORE this tick's swap, and a fresh-only reading",
    /yawWindow\.observe\(vote, autoOrientation, yawFresh \? _torsoYawAbs : null\)/.test(watcher));
  check("the streak-start baseline is gone - it cannot be measured after the peak it needs",
    !/yawAtStreakStart/.test(SRC));
  check("the tick confirms through orientFlipDecision(), fed the face streak",
    /orientFlipDecision\(\{[^}]*faceStreak[^}]*\}\)/.test(watcher));
  check("the face streak counts FaceDetector detections only, and a vote for the other side breaks it",
    /faceStreak = vote === "front" && lastFaceSeen \? faceStreak \+ 1 : 0;/.test(watcher) &&
    /lastFaceSeen = faceSeen;/.test(watcher));
  check("dual-view only, never while acquiring, raised on a pending switch OR a turn the window can see",
    /orientTurnMark\(dualView && !acquiring && \(needsSwitch \|\| yawWindow\.turning\)\);/.test(watcher));
  check("a stopped watcher releases the flag - a dead sampler cannot suppress re-drapes",
    /stop\(\) \{[\s\S]*?orientTurnMark\(false\);/.test(watcher));

  const p0 = SRC.indexOf("function startPresenceWatcher");
  const p1 = SRC.indexOf("/* ── end body-presence gate ── */", p0);
  const pose = SRC.slice(p0, p1);
  check("the topology gate refuses a dispatch mid-turn, so the shift is DEFERRED and re-offered",
    /bodyTopology\.feed\(sig, \{ canDispatch: !wireBusy\(\) && !orientTurnInProgress\(\) \}\)/.test(pose));
  check("the pose loop no longer waits on a re-drape - it keeps publishing yaw through the upload",
    /if \(step\.state === "shift"\) reconditionForTopology\(step\)\.catch\(/.test(pose) &&
    !/await reconditionForTopology\(/.test(pose));
  check("yaw is published on EVERY pose tick, not only on the topology cadence",
    pose.indexOf("_torsoYawAbs = Math.abs(sig.yaw);") !== -1 &&
    pose.indexOf("_torsoYawAbs = Math.abs(sig.yaw);") < pose.indexOf("now - lastTopologyAt >= BODY_TOPOLOGY_SAMPLE_MS"));
  const recon = SRC.slice(SRC.indexOf("async function reconditionForTopology("), SRC.indexOf("/* ── end body-presence gate ── */"));
  check("...and the dispatcher re-checks the flag itself (belt and braces, like its wireBusy check)",
    /if \(orientTurnInProgress\(\)\) \{/.test(recon));
}

console.log(fails === 0 ? "\nturn-yaw-window: OK" : `\nturn-yaw-window: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
