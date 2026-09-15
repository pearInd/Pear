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
const EDGE_DEG   = numOr("ORIENT_EDGE_ON_DEG");
const DESCENT    = numOr("ORIENT_PREDICT_DESCENT_DEG");
const DWELL_MS   = numOr("ORIENT_PREDICT_DWELL_MS");

check("ORIENT_FACE_RETURN_FRAMES exists, and sits between acquisition and the corroborated bar",
  Number.isFinite(FACE_F) && FACE_F >= ACQ_F && FACE_F >= 2 && FACE_F < CORR_F,
  `face=${FACE_F} acquire=${ACQ_F} corroborated=${CORR_F} - one detection is a hair trigger`);

const start = SRC.indexOf("function makeTurnYawWindow(");
const end   = SRC.indexOf("/* ── THE BEST FRONT-FACING FRAME");
let makeTurnYawWindow = null, orientFlipDecision = null, orientPredictBack = null, makeEarlyTurnTrigger = null;
if (start === -1 || end === -1 || end < start) {
  check("makeTurnYawWindow() exists in app.js", false, "the peak-since-agreement window is not implemented");
} else {
  const api = new Function("ORIENT_YAW_TURN_DEG", "PRESENCE_PROMPT_YAW_SUPPRESS_DEG", "ORIENT_ACQUIRE_FRAMES",
    "ORIENT_LOCK_FRAMES", "ORIENT_CORROBORATED_FRAMES", "ORIENT_LOCK_MS", "ORIENT_FACE_RETURN_FRAMES",
    "ORIENT_EDGE_ON_DEG", "ORIENT_PREDICT_DESCENT_DEG", "ORIENT_PREDICT_DWELL_MS", "ORIENT_PREDICTIVE_BACK", "ORIENT_POSE_FLIP_FRAMES",
    SRC.slice(start, end) +
    "\nreturn { makeTurnYawWindow," +
    " orientFlipDecision: typeof orientFlipDecision === 'function' ? orientFlipDecision : null," +
    " orientPredictBack: typeof orientPredictBack === 'function' ? orientPredictBack : null," +
    " makeEarlyTurnTrigger: typeof makeEarlyTurnTrigger === 'function' ? makeEarlyTurnTrigger : null };")(
    TURN_DEG, LOSS_DEG, ACQ_F, LOCK_F, CORR_F, LOCK_MS, FACE_F, EDGE_DEG, DESCENT, DWELL_MS, true, numOr("ORIENT_POSE_FLIP_FRAMES"));
  makeTurnYawWindow = api.makeTurnYawWindow;
  orientFlipDecision = api.orientFlipDecision;
  orientPredictBack = api.orientPredictBack;
  makeEarlyTurnTrigger = api.makeEarlyTurnTrigger;
  check("orientFlipDecision() exists beside the window, so the flip bar is real code under test",
    typeof orientFlipDecision === "function");
  check("orientPredictBack() exists beside them", typeof orientPredictBack === "function");
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
function simulate({ speed, k, faceDeg, backDeg, occludeAbove = Infinity, rule, publishMs, swapMs = 600, script, source = "face" }) {
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
  let lock = "front", lastVote = null, streak = 0, streakSince = 0, faceStreak = 0, poseStreak = 0, lastSwapAt = -Infinity, busyUntil = 0;
  let lastSwapPredictive = false, predictiveUsed = false, backVisibleAt = null, wrongSideMs = 0, everBack = false;
  let reading = null, nextPublish = 0, baseline = null;
  const win = rule !== "old" ? makeTurnYawWindow() : null;
  let firstBackVoteAt = null, facedFrontAt = null, frontLockedAt = null, backLockedAt = null;
  for (let t = 0; t <= total; t += SAMPLE_MS) {
    while (nextPublish <= t) {                  // the pose loop runs on its own clock, even mid-swap
      const y = yawOf(facing(angleAt(nextPublish)));
      if (y !== null) reading = { yaw: y, at: nextPublish };
      nextPublish += publishMs;
    }
    const phi = facing(angleAt(t));
    if (backVisibleAt === null && phi >= 120) backVisibleAt = t;
    if (lock === "back" && phi < 90) wrongSideMs += SAMPLE_MS;   // back reference on a front-facing body
    if (t < busyUntil) continue;                // maybeSwap is awaited: the sampler is paused
    const vote = phi <= faceDeg ? "front" : phi >= backDeg ? "back" : null;
    const fresh = reading && t - reading.at <= FRESH_MS;
    const yaw = fresh ? reading.yaw : null;
    if (lock === "front" && vote === "back" && firstBackVoteAt === null) firstBackVoteAt = t;
    if (backLockedAt !== null && facedFrontAt === null && vote === "front") facedFrontAt = t;
    if (vote) {
      if (vote === lastVote) streak++;
      else { lastVote = vote; streak = 1; streakSince = t; if (rule === "old") baseline = yaw; }
      /* source "face": the front vote is a detection. source "pose": BOTH votes are the pose model's
         shoulder order, which counts toward the pose flip in either direction instead. */
      faceStreak = source === "face" && vote === "front" ? faceStreak + 1 : 0;
      poseStreak = source === "pose" ? (vote === lastVote && streak > 1 ? poseStreak + 1 : 1) : 0;
    }
    const needsSwitch = !!lastVote && lastVote !== lock;
    const held = lastVote ? t - streakSince : 0;
    let confirmed, predict = false;
    if (rule !== "old") {
      const c = win.observe(vote, lock, yaw, fresh ? reading.at : t).corroborates;
      confirmed = orientFlipDecision({ acquiring: false, needsSwitch, streak, held, yawCorroborates: c, lock, lastVote, faceStreak, poseStreak }).confirmed;
      predict = rule === "predictive" && !confirmed &&
        orientPredictBack({ acquiring: false, lock, win, yawAbs: yaw, now: t });
    } else {
      const c = yaw !== null && baseline !== null && Math.abs(yaw - baseline) >= TURN_DEG;
      confirmed = needsSwitch && (streak >= (c ? Math.min(LOCK_F, CORR_F) : LOCK_F) || held >= LOCK_MS);
    }
    /* Mirrors maybeSwap(): the cooldown holds every swap EXCEPT withdrawing a predictive BACK. */
    const withdrawal = confirmed && lastVote === "front" && lastSwapPredictive;
    if (confirmed && (t - lastSwapAt >= COOLDOWN || withdrawal)) {
      lock = lastVote; lastSwapAt = t; busyUntil = t + swapMs; lastSwapPredictive = false;
      if (lock === "back" && backLockedAt === null) backLockedAt = t;
      if (lock === "front" && backLockedAt !== null && frontLockedAt === null) frontLockedAt = t;
    } else if (predict && t - lastSwapAt >= COOLDOWN) {
      lock = "back"; lastSwapAt = t; busyUntil = t + swapMs; lastSwapPredictive = true; predictiveUsed = true;
      lastVote = null; streak = 0; faceStreak = 0; poseStreak = 0;   // the pre-turn front streak must not count
      if (backLockedAt === null) backLockedAt = t;
    }
    if (lock === "back") everBack = true;
  }
  return { backLockedAt, frontLockedAt, facedFrontAt, predictiveUsed, backVisibleAt, wrongSideMs, everBack, finalLock: lock,
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
    /yawWindow\.observe\(vote, autoOrientation, yawFresh \? _torsoYawAbs : null,/.test(watcher));
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
    /bodyTopology\.feed\(sig, \{ canDispatch: !wireBusy\(\) && !orientTurnInProgress\(\) && !turnStarting \}\)/.test(pose));
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

console.log("\n── §6 PREDICTIVE BACK: dispatch while the torso is still passing through ──");
/* THE REPORT: on FRONT -> BACK the exported clip shows the back artwork rendered over the
   front's "PEAK" for about a second before the back settles. The clip records #aiVideo - the
   raw Decart output - so no cover can be in it. BACK used to be dispatched only after four
   corroborated back votes, and a back vote needs the back of the head (~150 degrees): the back
   was already facing the lens, Decart rendered the FRONT reference on it, and then blended from
   that into the back. There is no client call that flushes Decart's temporal state, so the one
   lever is WHEN the back reference arrives. */
if (orientPredictBack && makeTurnYawWindow) {
  const mk = (steps) => {
    const w = makeTurnYawWindow();
    for (const [vote, lock, yaw, at] of steps) w.observe(vote, lock, yaw, at);
    return w;
  };
  const through = mk([["front", "front", 5, 0], [null, "front", 40, 240], [null, "front", 66, 480], [null, "front", 86, 720]]);
  check("rising through edge-on is not yet a prediction - still-rising is also what a profile check looks like",
    orientPredictBack({ acquiring: false, lock: "front", win: through, yawAbs: 86, now: 740 }) === false);
  const passed = mk([["front", "front", 5, 0], [null, "front", 40, 240], [null, "front", 66, 480], [null, "front", 86, 720], [null, "front", 50, 960]]);
  check("descending past edge-on inside the dwell, no face since the turn began: predict BACK",
    orientPredictBack({ acquiring: false, lock: "front", win: passed, yawAbs: 50, now: 980 }) === true);
  check("...never when the lock is already BACK, never while acquiring, never with the kill switch off",
    orientPredictBack({ acquiring: false, lock: "back", win: passed, yawAbs: 50, now: 980 }) === false &&
    orientPredictBack({ acquiring: true, lock: "front", win: passed, yawAbs: 50, now: 980 }) === false &&
    orientPredictBack({ enabled: false, acquiring: false, lock: "front", win: passed, yawAbs: 50, now: 980 }) === false);
  check("...never on a stale reading",
    orientPredictBack({ acquiring: false, lock: "front", win: passed, yawAbs: null, now: 980 }) === false);
  check("...and never once the torso has DWELT at edge-on past ORIENT_PREDICT_DWELL_MS - that is a pose being held",
    orientPredictBack({ acquiring: false, lock: "front", win: passed, yawAbs: 50, now: 480 + DWELL_MS + 1 }) === false);
  const shallow = mk([["front", "front", 5, 0], [null, "front", 30, 240], [null, "front", 44, 480], [null, "front", 20, 720]]);
  check("a turn that never reached edge-on predicts nothing, however far it comes back",
    orientPredictBack({ acquiring: false, lock: "front", win: shallow, yawAbs: 20, now: 740 }) === false);
  const face = mk([["front", "front", 5, 0], [null, "front", 66, 240], [null, "front", 86, 480], ["front", "front", 50, 720]]);
  check("a face in between closes the window - a shopper who looked back at the screen is not turning away",
    orientPredictBack({ acquiring: false, lock: "front", win: face, yawAbs: 50, now: 740 }) === false);
}

if (orientPredictBack && orientFlipDecision) {
  const profiles = [];
  for (const speed of [90, 120]) for (const k of [1, 0.75]) for (const faceDeg of [30, 40]) for (const backDeg of [140, 155])
    profiles.push({ speed, k, faceDeg, backDeg });
  const rows = profiles.map((p) => ({
    p,
    vote: simulate({ ...p, rule: "new", publishMs: 240 }),
    pred: simulate({ ...p, rule: "predictive", publishMs: 240 }),
  }));
  for (const { p, vote, pred } of rows) {
    console.log(`        ${p.speed}°/s k=${p.k} face<=${p.faceDeg}° back>=${p.backDeg}°  BACK sent at ` +
      `${vote.backLockedAt}ms -> ${pred.backLockedAt}ms${pred.predictiveUsed ? " (predictive)" : " (vote path)"}` +
      ` | back faces the lens at ${pred.backVisibleAt}ms | return leak ${pred.leakMs}ms`);
  }
  const used = rows.filter(({ pred }) => pred.predictiveUsed);
  check("the prediction engages on every profile of a continuous turn",
    used.length === rows.length, `${used.length}/${rows.length}`);
  check("...and sends BACK earlier than the vote path by at least its whole corroborated bar",
    used.every(({ vote, pred }) => vote.backLockedAt - pred.backLockedAt >= (CORR_F - 1) * SAMPLE_MS),
    used.map(({ vote, pred }) => vote.backLockedAt - pred.backLockedAt).join(","));
  check("...while the torso is still rotating - before the turn has finished",
    used.every(({ p, pred }) => pred.backLockedAt < 1000 + (180 / p.speed) * 1000));
  check("the return leg is unchanged by it",
    rows.every(({ pred }) => pred.leakMs !== null && pred.leakMs <= (FACE_F - 1) * SAMPLE_MS),
    rows.map(({ pred }) => pred.leakMs).join(","));

  /* THE CASE THE DWELL EXISTS FOR - checking the side view. Turn to edge-on, hold it, come back.
     Yaw alone cannot tell this from a turn that kept going (it folds at 90), so the prediction
     must not fire on it. */
  const holds = [];
  for (const k of [1, 0.75]) for (const faceDeg of [30, 40]) for (const holdMs of [1000, 1500]) {
    holds.push({ k, faceDeg, holdMs, r: simulate({ speed: 90, k, faceDeg, backDeg: 150, rule: "predictive", publishMs: 240,
      script: [[0, 1000], [90, 1000], [90, holdMs], [0, 1000], [0, 2000]] }) });
  }
  check("a held profile check (1s+ at edge-on) never puts GARMENT_BACK on the wire",
    holds.every(({ r }) => !r.everBack), JSON.stringify(holds.map(({ k, faceDeg, holdMs, r }) => ({ k, faceDeg, holdMs, back: r.everBack }))));

  /* THE RESIDUAL COST, stated rather than hidden: a glance to edge-on that reverses at once is
     geometrically identical to a turn that kept going, until the face comes back. When it
     predicts, the face return must take the BACK off within the swap cooldown - not after it. */
  const glances = [];
  for (const [peakDeg, legMs] of [[85, 750], [90, 900], [100, 900], [110, 1000]]) for (const faceDeg of [30, 40]) {
    const r = simulate({ speed: 90, k: 1, faceDeg, backDeg: 150, rule: "predictive", publishMs: 240,
      script: [[0, 1000], [peakDeg, legMs], [0, legMs], [0, 2500]] });
    glances.push({ peakDeg, legMs, faceDeg, r });
    console.log(`        glance to ${peakDeg}° and straight back (${legMs}ms legs, face<=${faceDeg}°): ` +
      `predictive=${r.predictiveUsed} back-on-front=${r.wrongSideMs}ms final=${r.finalLock}`);
  }
  check("every glance that DID predict is withdrawn to FRONT, faster than ORIENT_COOLDOWN_MS would have allowed",
    glances.every(({ r }) => !r.predictiveUsed || (r.finalLock === "front" && r.wrongSideMs < COOLDOWN)),
    JSON.stringify(glances.map(({ peakDeg, faceDeg, r }) => ({ peakDeg, faceDeg, p: r.predictiveUsed, ms: r.wrongSideMs, f: r.finalLock }))));
}

{
  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const w1 = SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0);
  const watcher = w0 !== -1 && w1 !== -1 ? SRC.slice(w0, w1) : "";
  check("the kill switch is a constant with a ?predict_back=0 override for A/B",
    /const ORIENT_PREDICTIVE_BACK = /.test(SRC) && /get\("predict_back"\) !== "0"/.test(SRC));
  check("the tick feeds the window the READING's timestamp, so dwell is measured on the pose clock",
    /yawWindow\.observe\(vote, autoOrientation, yawFresh \? _torsoYawAbs : null, yawFresh \? _torsoYawAt : Date\.now\(\), _poseTorsoLostAt\)/.test(watcher));
  check("a predictive dispatch clears the pre-turn front streak first, so it cannot count toward withdrawing itself",
    /else if \(predictBack\) \{[\s\S]*?lastVote = null; streak = 0; faceStreak = 0;[\s\S]*?await maybeSwap\("back", true\);/.test(watcher));
  check("...and the pose/re-anchor updates stand aside for it exactly as for a confirmed swap",
    /if \(!\(dualView && \(confirmed \|\| predictBack\)\)\) \{/.test(watcher));
  check("maybeSwap() lets a face return withdraw a predictive BACK inside the cooldown - and only that",
    /async function maybeSwap\(next, predictive = false\)/.test(watcher) &&
    /const withdrawing = next === "front" && lastSwapPredictive;/.test(watcher) &&
    /if \(applying \|\| \(Date\.now\(\) - lastSwapAt < ORIENT_COOLDOWN_MS && !withdrawing\)\) return;/.test(watcher));
}

console.log("\n── §7 DETECTION IS LOCAL; THE SWAP TIMELINE IS MEASURED ──");
/* REQUESTED: "move orientation off Decart's processed output onto the raw local webcam, to get
   rid of the 300-600ms pipeline delay". It was never on the output. Pinned as an ABSENCE and a
   presence, so a well-meant refactor cannot move detection behind the network after all: the
   watcher samples localStream's own track, the pose loop reads #webcam, and neither touches
   #aiVideo. */
{
  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const w1 = SRC.indexOf("\n  // Private sampler onto the SAME track", w0);
  const watcherHead = SRC.slice(w0, w1 === -1 ? w0 + 400 : w1);
  const sampler = SRC.slice(SRC.indexOf("  const video = document.createElement(\"video\");", w0),
    SRC.indexOf("  const canvas = document.createElement(\"canvas\");", w0));
  check("the orientation watcher samples the LOCAL camera track",
    /const track = localStream && localStream\.getVideoTracks\(\)\[0\];/.test(watcherHead) &&
    /video\.srcObject = new MediaStream\(\[track\]\);/.test(sampler));
  const p0 = SRC.indexOf("function startPresenceWatcher");
  const pose = SRC.slice(p0, SRC.indexOf("/* ── end body-presence gate ── */", p0));
  check("the pose loop (yaw, topology, presence) runs on #webcam",
    /const video = \$\("webcam"\);/.test(pose) && /detectPoseFrame\(detector, video\)/.test(pose));
  const wEnd = SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0);
  const code = (SRC.slice(w0, wEnd) + pose).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("...and neither ever reads Decart's output (#aiVideo)",
    !/aiVideo/.test(code), (code.match(/[^\n]*aiVideo[^\n]*/) || [""])[0]);

  const t0 = SRC.indexOf("function traceSwapTimeline(");
  const trace = t0 === -1 ? "" : SRC.slice(t0, SRC.indexOf("\n}\n", t0));
  check("the swap timeline exists, and costs nothing unless ?orient_debug=1",
    /if \(!ORIENT_DEBUG\) return null;/.test(trace));
  check("...it stamps dispatch, the ack and the first Decart frame presented after it, each with the LOCAL yaw",
    /set\(\) acked/.test(trace) && /requestVideoFrameCallback/.test(trace) &&
    /first Decart frame presented after the ack/.test(trace) && /local \|yaw\|/.test(trace));
  check("...and maybeSwap() drives it around the one set() it times",
    /const trace = typeof traceSwapTimeline === "function"/.test(SRC) &&
    /await applyActive\(\);[^\n]*\n\s*if \(heldGate\) heldGate\.unhold\("swap acknowledged"\);\s*\n\s*if \(trace\) trace\.acknowledged\(\);/.test(SRC));
}

console.log("\n── §8 A LIVE LOG MUST SAY WHY THE PREDICTION DID OR DID NOT FIRE ──");
/* REPORTED AGAIN: "PEAK on the back while turning, the back graphic a second late". That is
   exactly what a turn looks like when the predictive BACK does NOT engage and the vote path
   carries the flip - so the first question is whether it engaged. The debug tick line could not
   answer it: its peak/descent detail printed only while a vote DISAGREED with the lock, and the
   outbound abstain stretch - where orientPredictBack() is evaluated - has none. Nor could a log
   be tied to a build. */
{
  const r0 = SRC.indexOf("function orientPredictBackReason(");
  const end = SRC.indexOf("/* ── THE BEST FRONT-FACING FRAME");
  let reasonFn = null;
  if (r0 === -1 || end < r0) {
    check("orientPredictBackReason() exists", false, "not implemented");
  } else {
    reasonFn = new Function("ORIENT_PREDICTIVE_BACK", "ORIENT_PREDICT_DESCENT_DEG", "ORIENT_PREDICT_DWELL_MS",
      "ORIENT_EDGE_ON_DEG", SRC.slice(r0, SRC.indexOf("\n}\n", r0) + 2) + "\nreturn orientPredictBackReason;")(
      true, DESCENT, DWELL_MS, EDGE_DEG);
  }
  if (reasonFn && makeTurnYawWindow) {
    const mk = (steps) => { const w = makeTurnYawWindow(); for (const s of steps) w.observe(...s); return w; };
    const base = { acquiring: false, lock: "front" };
    check("reasons name each gate: kill switch, lock, window, edge, descent, dwell, fire",
      /disabled/.test(reasonFn({ ...base, enabled: false, win: mk([]), yawAbs: 10, now: 0 })) &&
      /lock/.test(reasonFn({ ...base, lock: "back", win: mk([]), yawAbs: 10, now: 0 })) &&
      /closed/.test(reasonFn({ ...base, win: mk([["front", "front", 5, 0]]), yawAbs: 5, now: 0 })) &&
      /edge/.test(reasonFn({ ...base, win: mk([["front", "front", 5, 0], [null, "front", 30, 240], [null, "front", 50, 480]]), yawAbs: 50, now: 500 })) &&
      /descent/.test(reasonFn({ ...base, win: mk([["front", "front", 5, 0], [null, "front", 66, 240], [null, "front", 80, 480]]), yawAbs: 80, now: 500 })) &&
      /dwell/.test(reasonFn({ ...base, win: mk([["front", "front", 5, 0], [null, "front", 66, 240], [null, "front", 86, 480], [null, "front", 50, 720]]), yawAbs: 50, now: 240 + DWELL_MS + 50 })) &&
      reasonFn({ ...base, win: mk([["front", "front", 5, 0], [null, "front", 66, 240], [null, "front", 86, 480], [null, "front", 50, 720]]), yawAbs: 50, now: 740 }) === "fire");
    const edge = reasonFn({ ...base, win: mk([["front", "front", 5, 0], [null, "front", 30, 240], [null, "front", 50, 480]]), yawAbs: 50, now: 500 });
    check("...with the numbers the thresholds are tuned from, not just the gate's name",
      /50/.test(edge) && new RegExp(String(EDGE_DEG)).test(edge), edge);
  }
  check("orientPredictBack() is exactly 'the reason is fire' - one gate, not two that can drift",
    /function orientPredictBack\(args\) \{\s*\n\s*return orientPredictBackReason\(args\) === "fire";/.test(SRC));
  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const watcher = SRC.slice(w0, SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0));
  check("the debug tick line reports the prediction on every tick of an open turn from a FRONT lock",
    /predict: \$\{orientPredictBackReason\(/.test(watcher));
  check("every session logs the build it is running, so a log or a clip can be tied to the code",
    /console\.log\("\[PEAR\] fitting-room build", PEAR_BUILD/.test(SRC) &&
    /new URL\(import\.meta\.url\)\.searchParams\.get\("v"\)/.test(SRC));
  const trace = SRC.slice(SRC.indexOf("function traceSwapTimeline("), SRC.indexOf("\n}\n", SRC.indexOf("function traceSwapTimeline(")));
  check("the swap timeline names the build, the reference size it uploads, and how far into the turn it fired",
    /PEAR_BUILD/.test(trace) && /garmentBlobIfWarm/.test(trace) && /_orientTurnSince/.test(trace));
}

console.log("\n── §9 BACK HAS TO COME ON WHERE FaceDetector DOES NOT EXIST - AND FRONT HAS TO COME BACK ──");
/* THE HISTORY, because it is the point. FaceDetector is undefined by default in Chrome and Edge,
   so the watcher ran a 96px skin-ratio fallback that almost never voted FRONT - after a 360 the
   BACK graphic latched on the chest. Build 128 took the FRONT vote from the pose model's face
   (min visibility of nose and eyes), and FRONT came back. Then BACK stopped triggering at all.
   MEASURED (pose_landmarker_lite, tasks-vision 0.10.14, the catalog's own front/back photos of one
   model): nose and eye visibility are 1.00 facing the lens AND 1.00 facing away. BlazePose predicts
   a face on the back of the head, so the build-128 vote said FRONT while the shopper faced away -
   the lock never left FRONT and the predictive window never opened. A "face visibility below 0.2
   means BACK" trigger can therefore never fire either.
   WHAT DOES SEPARATE THEM, measured on the same photos: the image-space ORDER of the shoulders,
   normalised by torso height. (L.x - R.x) / torsoHeight = +0.76 facing the lens, -0.68 facing
   away; unchanged at 40% size (+0.76 / -0.68); and unchanged when the image is MIRRORED
   (+0.78 / -0.63) - BlazePose labels the shoulders by the way the subject faces, so a mirrored
   camera cannot invert it. It is ~0 edge-on, where the vote must abstain anyway. */
const MEASURED = { front: 0.76, back: -0.68, frontMirrored: 0.78, backMirrored: -0.63 };
{
  check("POSE_LANDMARK no longer carries the face - nothing may vote on BlazePose face visibility again",
    !/NOSE: 0/.test((SRC.match(/const POSE_LANDMARK = Object\.freeze\(\{[\s\S]*?\}\);/) || [""])[0]) &&
    !/function poseFaceVote\(/.test(SRC) && !/_poseFaceVis/.test(SRC));

  const f0 = SRC.indexOf("function poseShoulderFacing(");
  const v0 = SRC.indexOf("function poseFacingVote(");
  const MARGIN = numOr("ORIENT_POSE_FACING_MARGIN");
  check("ORIENT_POSE_FACING_MARGIN sits well inside what was measured, and well clear of edge-on noise",
    MARGIN >= 0.15 && MARGIN <= 0.4 &&
    MARGIN < Math.min(MEASURED.front, -MEASURED.back, MEASURED.frontMirrored, -MEASURED.backMirrored) / 2,
    String(MARGIN));
  if (f0 === -1 || v0 === -1) {
    check("poseShoulderFacing() and poseFacingVote() exist", false, "not implemented");
  } else {
    const grab = (i) => SRC.slice(i, SRC.indexOf("\n}\n", i) + 2);
    const L = { LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_HIP: 23, RIGHT_HIP: 24 };
    const api = new Function("POSE_LANDMARK", "primaryPoseIndex", "torsoReadable", "BODY_TRACK_MIN_VISIBILITY",
      "ORIENT_POSE_FACING", "ORIENT_POSE_FACING_MARGIN", "ORIENT_YAW_FRESH_MS",
      grab(f0) + grab(v0) + "\nreturn { poseShoulderFacing, poseFacingVote };")(
      L, (sets) => (sets.length ? sets.length - 1 : -1),
      (lm, min) => [11, 12, 23, 24].every((i) => lm[i] && lm[i].visibility >= min), 0.5,
      true, MARGIN, FRESH_MS);
    /* A skeleton whose shoulder order reproduces a measured value: torso 0.4 tall, shoulders
       centred on x = 0.5 with (L.x - R.x) = sep * 0.4. */
    const body = (sep, vis = 1) => {
      const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: vis }));
      lm[11] = { x: 0.5 + (sep * 0.4) / 2, y: 0.3, visibility: vis };
      lm[12] = { x: 0.5 - (sep * 0.4) / 2, y: 0.3, visibility: vis };
      lm[23] = { x: 0.55, y: 0.7, visibility: vis }; lm[24] = { x: 0.45, y: 0.7, visibility: vis };
      return lm;
    };
    const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
    check("the signed shoulder order is (L.x - R.x) over torso height: + facing the lens, - facing away",
      near(api.poseShoulderFacing({ landmarks: [body(MEASURED.front)] }), MEASURED.front) &&
      near(api.poseShoulderFacing({ landmarks: [body(MEASURED.back)] }), MEASURED.back));
    check("...from the primary subject, and null with no readable torso",
      near(api.poseShoulderFacing({ landmarks: [body(MEASURED.back), body(MEASURED.front)] }), MEASURED.front) &&
      api.poseShoulderFacing({ landmarks: [body(MEASURED.front, 0.2)] }) === null &&
      api.poseShoulderFacing({ landmarks: [] }) === null && api.poseShoulderFacing(null) === null);
    const vote = (sep, at = 1000, now = 1100, enabled) => api.poseFacingVote({ enabled, sep, at, now });
    check("every measured FRONT reading - as shot and mirrored - votes FRONT",
      vote(MEASURED.front) === "front" && vote(MEASURED.frontMirrored) === "front");
    check("every measured BACK reading - as shot and mirrored - votes BACK",
      vote(MEASURED.back) === "back" && vote(MEASURED.backMirrored) === "back");
    check("edge-on (shoulders overlapping) abstains in both directions",
      vote(0) === null && vote(MARGIN * 0.9) === null && vote(-MARGIN * 0.9) === null);
    check("...a stale reading abstains, and ?pose_facing=0 turns the vote off",
      vote(MEASURED.back, 0, FRESH_MS + 1) === null && vote(MEASURED.back, 1000, 1100, false) === null);
  }

  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const watcher = SRC.slice(w0, SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0));
  check("with no FaceDetector, classify() takes the shoulder order BEFORE the skin heuristic, in BOTH directions",
    /const poseVote = poseFacingVote\(\{ sep: _poseFacingSep, at: _poseFacingAt, now: Date\.now\(\) \}\);/.test(watcher) &&
    /if \(poseVote\) \{[^}]*vote = poseVote;[^}]*posed = true;/.test(watcher) &&
    /else vote = skinRatioVote\(px\);/.test(watcher));
  check("...and a shoulder vote is NOT dressed up as a face - faceSeen stays false for it",
    !/if \(poseVote\) \{[^}]*faceSeen = true/.test(watcher));
  check("the tick counts consecutive shoulder votes per side into poseStreak",
    /lastPoseVoted = posed;/.test(watcher) &&
    /if \(lastPoseVoted\) \{ poseStreak = vote === poseSide \? poseStreak \+ 1 : 1; poseSide = vote; \}/.test(watcher));
  check("...and hands it to orientFlipDecision()", /orientFlipDecision\(\{[^}]*poseStreak[^}]*\}\)/.test(watcher));
  check("the watcher names the engine it armed", /MediaPipe shoulder order/.test(watcher));
  const p0 = SRC.indexOf("function startPresenceWatcher");
  const pose = SRC.slice(p0, SRC.indexOf("/* ── end body-presence gate ── */", p0));
  check("the pose loop publishes the shoulder order on every tick, beside the yaw",
    /const facingSep = poseShoulderFacing\(result\);/.test(pose) && /_poseFacingSep = facingSep;/.test(pose) &&
    pose.indexOf("_poseFacingSep = facingSep;") < pose.indexOf("now - lastTopologyAt >= BODY_TOPOLOGY_SAMPLE_MS"));

  if (orientFlipDecision) {
    const POSE_F = numOr("ORIENT_POSE_FLIP_FRAMES");
    check("ORIENT_POSE_FLIP_FRAMES is two - one reading is a hair trigger, and it is still under the corroborated bar",
      POSE_F === 2 && POSE_F < CORR_F);
    const base = { acquiring: false, needsSwitch: true, held: 0, faceStreak: 0, yawCorroborates: true };
    const toBack = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: POSE_F, poseStreak: POSE_F });
    const toFront = orientFlipDecision({ ...base, lock: "back", lastVote: "front", streak: POSE_F, poseStreak: POSE_F });
    check("the pose flip is SYMMETRIC: two shoulder votes after a corroborated turn confirm BACK...",
      toBack.confirmed === true && toBack.poseFlip === true, JSON.stringify(toBack));
    check("...and FRONT, on the same bar", toFront.confirmed === true && toFront.poseFlip === true, JSON.stringify(toFront));
    const noTurn = orientFlipDecision({ ...base, yawCorroborates: false, lock: "front", lastVote: "back", streak: POSE_F + 1, poseStreak: POSE_F + 1 });
    check("...but not without a corroborated torso turn (a head over the shoulder moves no shoulders)",
      noTurn.confirmed === false, JSON.stringify(noTurn));
    const skinVotes = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: POSE_F, poseStreak: 0 });
    check("...and skin votes do not ride the pose bar", skinVotes.confirmed === false, JSON.stringify(skinVotes));
  }

  if (orientFlipDecision && orientPredictBack) {
    /* The model's vote channel, by source. build 128: the face vote said FRONT at every angle.
       Now: shoulder order votes FRONT within ~70 degrees of the lens and BACK within ~70 of away. */
    const b128 = simulate({ speed: 90, k: 1, faceDeg: 181, backDeg: 999, rule: "predictive", publishMs: 240 });
    const now = simulate({ speed: 90, k: 1, faceDeg: 70, backDeg: 110, rule: "predictive", publishMs: 240, source: "pose" });
    const skin = simulate({ speed: 90, k: 1, faceDeg: -1, backDeg: 150, rule: "predictive", publishMs: 240 });
    console.log(`        build 128 (pose face votes FRONT everywhere): everBack=${b128.everBack}`);
    console.log(`        shoulder order: BACK at ${now.backLockedAt}ms (back faces the lens at ${now.backVisibleAt}ms), final=${now.finalLock}, return leak ${now.leakMs}ms`);
    console.log(`        skin-only fallback: final=${skin.finalLock}`);
    check("THE BACK BUG, modelled: a face vote that fires facing away never lets BACK on at all",
      b128.everBack === false);
    check("THE FIX: shoulder order locks BACK by the time the back faces the lens...",
      now.backLockedAt !== null && now.backLockedAt <= now.backVisibleAt + SAMPLE_MS, JSON.stringify(now));
    /* Measured against the face engine on the same turn, by the time BACK sits on a body that is facing
       the lens (phi < 90). Shoulder votes for FRONT begin far earlier than a face is detectable, and the
       flip then waits only for yaw corroboration - so FRONT returns at an earlier body angle, and
       "ms after the first front vote" would be the wrong yardstick. */
    const faceEngine = simulate({ speed: 90, k: 1, faceDeg: 35, backDeg: 150, rule: "predictive", publishMs: 240 });
    check("...and the same 360 returns to FRONT, the back on a front-facing body no longer than with a face detector",
      now.finalLock === "front" && now.wrongSideMs <= faceEngine.wrongSideMs,
      JSON.stringify({ shoulders: now.wrongSideMs, faceDetector: faceEngine.wrongSideMs }));
    check("(and the skin-only fallback still latches, which is why the pose vote exists)",
      skin.finalLock === "back");
    const glance = simulate({ speed: 90, k: 1, faceDeg: 70, backDeg: 110, rule: "predictive", publishMs: 240, source: "pose",
      script: [[0, 1000], [90, 1000], [90, 1200], [0, 1000], [0, 2000]] });
    check("a held profile check still never puts GARMENT_BACK on the wire with the shoulder vote in play",
      glance.everBack === false, JSON.stringify(glance));
  }
}

console.log("\n── §10 THE SHOULDER VOTE READS ACROSS THE EDGE-ON GAP - AND THE SIDE-VIEW PASS ──");
/* THE REPORT (build 129): turning away, the back graphic lands about a second late with the front's
   "PEAK" under it; completing the 360, the front does not come back in time, or at all. §2 and §9
   modelled the shoulder vote from the true angle on every tick, with the torso readable straight
   through edge-on. The pose loop does not publish that: an unreadable torso publishes NOTHING, so
   the shoulder order and the yaw keep their last readable value and count as fresh for
   ORIENT_YAW_FRESH_MS. Across the band where MediaPipe loses the far shoulder (§3), the stale order
   votes for the locked side, closing the window with its peak pinned at the last readable |yaw|,
   and the loss is never inferred because the stale yaw is still "fresh". This section models THAT
   coupling, through the real window and decision. See ORIENT_POSE_PASS. */
{
  const v0 = SRC.indexOf("function poseFacingVote(");
  const poseFacingVote = v0 === -1 ? null : new Function("ORIENT_POSE_FACING", "ORIENT_POSE_FACING_MARGIN", "ORIENT_YAW_FRESH_MS",
    SRC.slice(v0, SRC.indexOf("\n}\n", v0) + 2) + "\nreturn poseFacingVote;")(true, numOr("ORIENT_POSE_FACING_MARGIN"), FRESH_MS);
  const POSE_F = numOr("ORIENT_POSE_FLIP_FRAMES");

  if (makeTurnYawWindow) {
    const mk = (steps) => { const w = makeTurnYawWindow(); let r; for (const s of steps) r = w.observe(...s); return { w, r }; };
    const turned = mk([["front", "front", 5, 0], [null, "front", 40, 240], [null, "front", 70, 480], ["back", "front", 50, 720]]);
    check("a readable turn past ORIENT_YAW_TURN_DEG that has fallen ORIENT_PREDICT_DESCENT_DEG has passed the side view",
      turned.r.passed === true && turned.r.corroborates === false, JSON.stringify(turned.r));
    const parked = mk([["front", "front", 5, 0], [null, "front", 70, 240], [null, "front", 72, 480], ["back", "front", 70, 720]]);
    check("...but parked at edge-on it has not - no descent, whatever the shoulders misread",
      parked.r.passed === false, JSON.stringify(parked.r));
    const head = mk([["back", "back", 3, 0], ["front", "back", 8, 240], ["front", "back", 10, 480]]);
    check("...and a head turned over the shoulder never raises the torso to a turn",
      head.r.passed === false, JSON.stringify(head.r));
    const gap = mk([["front", "front", 38, 0, 0], ["front", "front", 38, 0, 240], ["front", "front", 38, 0, 480], ["back", "front", 20, 720, 480]]);
    check("THE GAP: stale agreeing votes pinned the readable peak at 38 - an unreadable torso since then plus the descent is the pass",
      gap.r.passed === true && gap.w.lostInTurn === true && gap.r.corroborates === false, JSON.stringify({ r: gap.r, lost: gap.w.lostInTurn }));
    const twist = mk([["front", "front", 35, 0, 0], [null, "front", 35, 0, 240], ["front", "front", 36, 480, 240], ["back", "front", 20, 720, 240]]);
    check("...while a dropped frame during a twist is erased by the next readable agreeing reading",
      twist.r.passed === false && twist.w.lostInTurn === false, JSON.stringify({ r: twist.r, lost: twist.w.lostInTurn }));
    const lost90 = mk([["front", "front", 5, 0], [null, "front", 60, 240], [null, "front", null, 900, 900], ["back", "front", 60, 1000, 900]]);
    check("...and the descent is measured from the READABLE peak, never from edgeLost's 90 (a compressed edge-on reads under 90)",
      lost90.w.edgeLost === true && lost90.r.swing === 30 && lost90.r.passed === false, JSON.stringify({ r: lost90.r, lost: lost90.w.edgeLost }));
  }

  if (orientFlipDecision) {
    const base = { acquiring: false, needsSwitch: true, held: 0, faceStreak: 0, yawCorroborates: false, turnPassed: true };
    const toBack = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: POSE_F, poseStreak: POSE_F });
    const toFront = orientFlipDecision({ ...base, lock: "back", lastVote: "front", streak: POSE_F, poseStreak: POSE_F });
    check("the pass corroborates the pose flip both ways on ORIENT_POSE_FLIP_FRAMES shoulder votes, and marks it early",
      toBack.confirmed && toBack.poseFlip && toBack.early && toFront.confirmed && toFront.early, JSON.stringify({ toBack, toFront }));
    const one = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: 1, poseStreak: 1 });
    check("...not on one shoulder vote", one.confirmed === false);
    const skin = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: CORR_F, poseStreak: 0 });
    check("...and never for the corroborated bar or skin votes - that bar keeps the 45-degree swing",
      skin.confirmed === false && skin.flipBar === LOCK_F, JSON.stringify(skin));
    const face = orientFlipDecision({ ...base, lock: "back", lastVote: "front", streak: FACE_F, faceStreak: FACE_F, poseStreak: 0 });
    check("...nor for the face return", face.confirmed === false && face.faceReturn === false, JSON.stringify(face));
    const swung = orientFlipDecision({ ...base, yawCorroborates: true, lock: "front", lastVote: "back", streak: POSE_F, poseStreak: POSE_F });
    const barred = orientFlipDecision({ ...base, lock: "front", lastVote: "back", streak: LOCK_F, poseStreak: LOCK_F });
    check("a flip the 45-degree swing or the full bar would have confirmed anyway is not early",
      swung.confirmed && !swung.early && barred.confirmed && !barred.early, JSON.stringify({ swung, barred }));
  }

  if (makeTurnYawWindow && orientFlipDecision && orientPredictBack && poseFacingVote) {
    /* The tick, as createOrientationWatcher() runs it on a browser with no FaceDetector: the pose loop
       every 240ms publishes the shoulder order and yaw from a readable torso and only RECORDS an
       unreadable one; the watcher votes every ORIENT_SAMPLE_MS (skin abstains); maybeSwap() is awaited
       and holds every swap to the cooldown except withdrawing a predictive/early BACK. `readableTo` is
       the |yaw| past which the torso is unreadable; `noise` perturbs the shoulder order past 70 degrees,
       where BlazePose's labels are weakest; `dropout` loses random frames at any angle. */
    function simulateGap({ speed = 90, k = 0.75, readableTo = 60, pass = true, script, dropout = 0, noise = 0, seed = 7, swapMs = 700, earlyDeg = 0, measureFrom = 0, minSpeed = 0, yawNoise = 0, returnDeg = null, slowDeg = 0 }) {
      let s = seed; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const facing = (deg) => { const m = ((deg % 360) + 360) % 360; return m > 180 ? 360 - m : m; };
      const seg = script || [[0, 1000], [360, (360 / speed) * 1000], [360, 3000]];
      const angleAt = (t) => { let from = 0, t0 = 0; for (const [to, dur] of seg) { if (t <= t0 + dur) return from + (to - from) * ((t - t0) / dur); from = to; t0 += dur; } return seg[seg.length - 1][0]; };
      const total = seg.reduce((a, [, d]) => a + d, 0);
      const win = makeTurnYawWindow();
      const early = earlyDeg > 0 && makeEarlyTurnTrigger ? makeEarlyTurnTrigger(earlyDeg, minSpeed, returnDeg === null ? earlyDeg : returnDeg, slowDeg, numOr("ORIENT_EARLY_TURN_SLOW_RISE_DEG"), [450, 960]) : null;   // §11 - null by default
      let lock = "front", lastVote = null, streak = 0, streakSince = 0, poseStreak = 0, poseSide = null;
      let lastSwapAt = -Infinity, lastSwapPredictive = false, busyUntil = 0;
      let sep = null, sepAt = 0, yaw = null, yawAt = 0, lostAt = 0, nextPub = 0, landed = "front";
      const sent = [], pending = []; let backOnFront = 0, frontOnBack = 0, returnPlainMs = 0;
      for (let t = 0; t <= total; t += 10) {
        while (nextPub <= t) {
          const phi = facing(angleAt(nextPub)), y = 90 - Math.abs(90 - phi);
          if (y <= readableTo && !(dropout && rand() < dropout)) {
            sep = 0.72 * Math.cos((phi * Math.PI) / 180) + (noise && y > 70 ? (rand() * 2 - 1) * noise : 0);
            sepAt = nextPub; yaw = Math.max(0, k * y + (yawNoise ? (rand() * 2 - 1) * yawNoise : 0)); yawAt = nextPub;
          } else lostAt = nextPub;
          nextPub += 240;
        }
        while (pending.length && pending[0].at <= t) landed = pending.shift().side;
        /* §11: FRONT on the wire while the body, on its way BACK round, still shows its back - the plain back of the live clip. 10ms resolution. */
        if (landed === "front" && angleAt(t) >= 180 && facing(angleAt(t)) > 90) returnPlainMs += 10;
        if (t % SAMPLE_MS !== 0) continue;
        const phiNow = facing(angleAt(t));
        if (t >= measureFrom && landed === "back" && phiNow < 90) backOnFront += SAMPLE_MS;
        if (t >= measureFrom && landed === "front" && phiNow > 90) frontOnBack += SAMPLE_MS;
        if (t < busyUntil) continue;
        const vote = poseFacingVote({ sep, at: sepAt, now: t });
        if (vote) {
          if (vote === lastVote) streak++; else { lastVote = vote; streak = 1; streakSince = t; }
          poseStreak = vote === poseSide ? poseStreak + 1 : 1; poseSide = vote;
        }
        const fresh = yaw !== null && t - yawAt <= FRESH_MS;
        const tw = win.observe(vote, lock, fresh ? yaw : null, fresh ? yawAt : t, lostAt);
        const d = orientFlipDecision({ acquiring: false, needsSwitch: !!lastVote && lastVote !== lock, streak,
          held: lastVote ? t - streakSince : 0, yawCorroborates: tw.corroborates, lock, lastVote, faceStreak: 0, poseStreak,
          turnPassed: pass && tw.passed });
        const predict = !d.confirmed && orientPredictBack({ acquiring: false, lock, win, yawAbs: fresh ? yaw : null, now: t });
        const swap = (side, predictive) => {
          if (t - lastSwapAt < COOLDOWN && !(side === "front" && lastSwapPredictive)) return;
          lock = side; lastSwapAt = t; lastSwapPredictive = predictive; busyUntil = t + swapMs;
          pending.push({ at: t + swapMs, side }); sent.push({ side, body: Math.round(angleAt(t)) });
        };
        /* §11: the tick's early-turn block - only with ?early_turn, only when nothing confirmed or predictive is due. */
        const ea = early && !d.confirmed && !predict ? early.observe({ vote, lock, yawAbs: fresh ? yaw : null, at: fresh ? yawAt : null }) : null;
        if (ea && ea.fire) { lastVote = null; streak = 0; poseStreak = 0; poseSide = null; swap(ea.fire, ea.fire === "back"); continue; }
        if (ea && ea.withdraw) { if (ea.withdraw === "back") lastSwapAt = -Infinity; swap(ea.withdraw, false); continue; }
        if (d.confirmed && d.early && lastVote === "back") swap("back", true);
        else if (d.confirmed) swap(lastVote, false);
        else if (predict) { lastVote = null; streak = 0; poseStreak = 0; poseSide = null; swap("back", true); }
      }
      const at = (side) => { const e = sent.find((x, i) => x.side === side && (side === "back" || i > 0)); return e ? e.body : null; };
      return { sent, backAt: at("back"), frontAt: at("front"), backOnFront, frontOnBack, returnPlainMs, final: lock,
               completed: sent.some((x) => x.side === "back") && lock === "front" && sent[sent.length - 1].side === "front" };
    }

    const grid = [];
    for (const speed of [60, 90, 120, 150]) for (const k of [1, 0.75, 0.6]) for (const readableTo of [90, 70, 60, 50]) {
      grid.push({ p: { speed, k, readableTo }, off: simulateGap({ speed, k, readableTo, pass: false }), on: simulateGap({ speed, k, readableTo, pass: true }) });
    }
    const brokeOff = grid.filter(({ off }) => !off.completed), brokeOn = grid.filter(({ on }) => !on.completed);
    for (const { p, off, on } of brokeOff) {
      console.log(`        ${p.speed}°/s k=${p.k} torso readable to ${p.readableTo}°: ` +
        `build 129 ${off.sent.map((x) => `${x.side.toUpperCase()}@${x.body}°`).join(" -> ") || "NO SWAP"}  |  now ${on.sent.map((x) => `${x.side.toUpperCase()}@${x.body}°`).join(" -> ")}`);
    }
    check("THE BUG, modelled: with the stale shoulder order across the gap, some full 360s never swap or never come back to FRONT",
      brokeOff.length > 0, `${brokeOff.length}/${grid.length}`);
    check("THE FIX: with the side-view pass every modelled 360 sends BACK and ends on FRONT",
      brokeOn.length === 0, brokeOn.map(({ p, on }) => JSON.stringify({ p, sent: on.sent })).join(" "));
    const both = grid.filter(({ off }) => off.completed);
    const later = both.filter(({ off, on }) => on.backAt > off.backAt || on.frontAt > off.frontAt);
    const earlier = both.filter(({ off, on }) => on.backAt < off.backAt || on.frontAt < off.frontAt);
    console.log(`        ${brokeOff.length}/${grid.length} profiles fixed; of the ${both.length} that already completed, ${earlier.length} dispatch earlier, ${later.length} later`);
    check("...and no turn that already completed dispatches either side at a later body angle",
      later.length === 0, later.map(({ p, off, on }) => JSON.stringify({ p, off: off.sent, on: on.sent })).join(" "));

    /* MUST NOT REGRESS - motions that are not a turn. BACK must never go on the wire for them (a glance
       past 120 is the documented residual cost of predictive BACK, so it may - but no longer than
       before); from a BACK lock, a side check of the back must never put FRONT on. */
    const motions = {
      "held profile 1.2s": [[0, 1000], [90, 1000], [90, 1200], [0, 1000], [0, 2000]],
      "profile 0.5s": [[0, 1000], [90, 1000], [90, 500], [0, 1000], [0, 2000]],
      "glance to 100°": [[0, 1000], [100, 900], [0, 900], [0, 2500]],
      "twist to 38°": [[0, 1000], [38, 500], [0, 500], [0, 2500]],
      "three twists to 60°": [[0, 1000], [60, 400], [0, 400], [60, 400], [0, 400], [60, 400], [0, 400], [0, 2000]],
    };
    const backCheck = [[0, 1000], [180, 2000], [180, 1500], [270, 1000], [270, 600], [180, 1000], [180, 2000]];
    const glance120 = [[0, 1000], [120, 900], [0, 900], [0, 2500]];
    const badMotion = [], badBackCheck = [], glances = [];
    for (const [dropout, noise] of [[0, 0], [0.15, 0], [0, 0.4], [0.15, 0.4], [0.3, 0.6]]) for (const readableTo of [90, 60]) for (const k of [1, 0.75]) {
      let worstOff = 0, worstOn = 0;
      for (let rep = 0; rep < 10; rep++) {
        const o = { readableTo, k, dropout, noise, seed: 7 + rep * 101 };
        for (const [name, script] of Object.entries(motions)) {
          const r = simulateGap({ ...o, script });
          if (r.sent.length) badMotion.push({ name, ...o, sent: r.sent });
        }
        const bc = simulateGap({ ...o, script: backCheck });
        if (bc.sent.some((x, i) => i > 0 && x.side === "front")) badBackCheck.push({ ...o, sent: bc.sent });
        worstOff = Math.max(worstOff, simulateGap({ ...o, script: glance120, pass: false }).backOnFront);
        worstOn = Math.max(worstOn, simulateGap({ ...o, script: glance120 }).backOnFront);
      }
      glances.push({ readableTo, k, dropout, noise, worstOff, worstOn });
    }
    check("a held or brief profile check, a glance to 100 degrees and posing twists never put BACK on the wire - dropped frames and edge-on label noise included",
      badMotion.length === 0, JSON.stringify(badMotion.slice(0, 3)));
    check("facing away, checking the back from the side never puts FRONT on the wire",
      badBackCheck.length === 0, JSON.stringify(badBackCheck.slice(0, 3)));
    /* A glance to 120 degrees crosses edge-on into the back hemisphere, so BACK going on for it is
       predictive BACK's documented residual cost, not a new one. What the pass must not do is make that
       BACK STICK: sent as an ordinary confirmed flip it waits out ORIENT_COOLDOWN_MS on the chest
       (modelled 1500-1750ms). Sent withdrawable it matches build 129 in every setting but the harshest
       (30% dropped frames, +/-0.6 edge-on label noise), where two noisy back readings qualified on one
       seed that predictive BACK did not fire on - one sample tick longer, stated rather than hidden. */
    const worse = glances.filter((g) => g.worstOn > g.worstOff);
    for (const g of worse) console.log(`        glance to 120°, torso readable to ${g.readableTo}° k=${g.k} dropout ${g.dropout} noise ±${g.noise}: BACK on the chest ${g.worstOff}ms -> ${g.worstOn}ms`);
    check("an early BACK is withdrawable: a glance to 120 degrees never leaves BACK on the chest for the cooldown",
      glances.every((g) => g.worstOn < COOLDOWN), JSON.stringify(glances.filter((g) => g.worstOn >= COOLDOWN)));
    check("...and never more than one sample tick longer than build 129, whatever the noise",
      worse.every((g) => g.worstOn - g.worstOff <= SAMPLE_MS), JSON.stringify(worse));

    console.log("\n── §11 THE OPT-IN EARLY TURN TRIGGER (?early_turn=<deg>), through the same tick model ──");
    /* What the flag buys and what it costs, printed rather than tuned. `latency` is dispatch-to-render;
       the wrong-garment time is the back reference on a front-facing body plus the front reference on a
       back-facing one. */
    const EARLY = [20, 25];
    const wrongMs = (r) => r.backOnFront + r.frontOnBack;
    const turns = [];
    for (const speed of [60, 90, 120]) for (const k of [1, 0.75]) for (const readableTo of [90, 60]) for (const swapMs of [700, 1000]) {
      const base = simulateGap({ speed, k, readableTo, swapMs });
      for (const earlyDeg of EARLY) turns.push({ speed, k, readableTo, swapMs, earlyDeg, base, on: simulateGap({ speed, k, readableTo, swapMs, earlyDeg }) });
    }
    const off0 = grid.every(({ p, on }) => JSON.stringify(simulateGap({ ...p, pass: true, earlyDeg: 0 }).sent) === JSON.stringify(on.sent));
    check("?early_turn=0: the tick model sends exactly what build 130 sends, profile for profile", off0);
    const incomplete = turns.filter((x) => !x.on.completed);
    check("with ?early_turn=20 or 25 every modelled full 360 still sends BACK and ends on FRONT",
      incomplete.length === 0, JSON.stringify(incomplete.slice(0, 2).map((x) => ({ ...x, base: x.base.sent, on: x.on.sent }))));
    const slower = turns.filter((x) => wrongMs(x.on) > wrongMs(x.base));
    const mean = (deg, key) => {
      const xs = turns.filter((x) => x.earlyDeg === deg);
      return Math.round(xs.reduce((a, x) => a + wrongMs(x[key]), 0) / xs.length);
    };
    for (const deg of EARLY) console.log(`        full 360s, early_turn=${deg}: wrong garment on screen ${mean(deg, "base")}ms by default -> ${mean(deg, "on")}ms (mean of ${turns.length / EARLY.length} profiles)`);
    check("...and none shows the wrong garment longer than the default does",
      slower.length === 0, JSON.stringify(slower.slice(0, 2).map((x) => ({ p: [x.speed, x.k, x.readableTo, x.swapMs, x.earlyDeg], base: [x.base.sent, wrongMs(x.base)], on: [x.on.sent, wrongMs(x.on)] }))));

    /* THE COST - motions that are not a turn. The default puts nothing on the wire for any of them. With the
       flag, a motion that stays under the threshold must stay untouched, and one that crosses it and comes
       back must be WITHDRAWN - end on the side it started - rather than wait out the vote bar. */
    const poses = {
      "twist to 15°": [[0, 1000], [15, 400], [0, 400], [0, 3500]],
      "twist to 38°": [[0, 1000], [38, 500], [0, 500], [0, 3500]],
      "side view in the mirror, 45° held 1s": [[0, 1000], [45, 600], [45, 1000], [0, 600], [0, 3500]],
      "held profile check, 90° for 1.2s": [[0, 1000], [90, 1000], [90, 1200], [0, 1000], [0, 3000]],
      "facing away, 30° twist to look back": [[0, 1000], [180, 2000], [180, 1500], [150, 500], [180, 500], [180, 3500]],
      "facing away, 45° held": [[0, 1000], [180, 2000], [180, 1500], [135, 600], [135, 800], [180, 600], [180, 3500]],
    };
    const poseRows = [];
    for (const [name, script] of Object.entries(poses)) for (const earlyDeg of EARLY) for (const swapMs of [700, 1000]) {
      /* Facing away, the cost is counted from 4.5s - settled on BACK, just before the twist - so the turn to the back is not in it. */
      const away = name.startsWith("facing away"), measureFrom = away ? 4500 : 0;
      const base = simulateGap({ script, swapMs, measureFrom }), on = simulateGap({ script, swapMs, earlyDeg, measureFrom });
      poseRows.push({ name, earlyDeg, swapMs, away, base, on, wrong: away ? on.frontOnBack : on.backOnFront });
    }
    for (const earlyDeg of EARLY) {
      const rows = poseRows.filter((r) => r.earlyDeg === earlyDeg && r.swapMs === 1000);
      console.log(`        early_turn=${earlyDeg}, 1000ms render latency: ` +
        rows.map((r) => `${r.name}: ${r.on.sent.map((x) => x.side[0].toUpperCase() + "@" + x.body + "°").join(">") || "nothing sent"} (+${r.wrong}ms wrong)`).join(" | "));
    }
    check("with the trigger off (?early_turn=0) none of these poses sends anything (the away poses keep only their own turn to the back), and none shows a wrong garment",
      poseRows.every((r) => r.base.sent.length === (r.away ? 1 : 0) && (r.away ? r.base.frontOnBack : r.base.backOnFront) === 0));
    check("with the flag, a twist that stays under the threshold sends nothing",
      poseRows.filter((r) => r.name === "twist to 15°").every((r) => r.on.sent.length === 0));
    const stuck = poseRows.filter((r) => r.on.final !== (r.away ? "back" : "front"));
    check("...and every pose that crosses it and comes back is withdrawn to the side it started on",
      stuck.length === 0, JSON.stringify(stuck.map((r) => ({ name: r.name, deg: r.earlyDeg, sent: r.on.sent }))));
    const worstPose = Math.max(...poseRows.map((r) => r.wrong));
    console.log(`        worst pose cost with the flag: ${worstPose}ms of the other side's graphic (the default: 0)`);
    check("...inside ORIENT_COOLDOWN_MS plus one render latency - the withdrawal skips the cooldown, it does not wait it out",
      poseRows.every((r) => r.wrong <= COOLDOWN + r.swapMs), JSON.stringify(poseRows.filter((r) => r.wrong > COOLDOWN + r.swapMs).map((r) => [r.name, r.earlyDeg, r.swapMs, r.wrong])));

    /* THE SPEED GATE (?early_turn_speed). A 15-degree crossing that is gated on |yaw| rising at 60 deg/s,
       against the same poses plus the slow ones a low threshold catches, with and without +/-4 degrees of
       yaw jitter (differencing readings 240ms apart amplifies it). 1000ms render latency. */
    const slowPoses = {
      "stand still": [[0, 6000]],
      "sway to 14° three times": [[0, 1000], [14, 400], [0, 400], [14, 400], [0, 400], [14, 400], [0, 400], [0, 3000]],
      "weight shift to 18°, held 1.5s": [[0, 1000], [18, 400], [18, 1500], [0, 400], [0, 3000]],
    };
    const fastPoses = {
      "reach, 22° for 300ms": [[0, 1000], [22, 250], [22, 300], [0, 250], [0, 3000]],
      "twist to 38°": [[0, 1000], [38, 500], [0, 500], [0, 3500]],
      "side view in the mirror, 45° held 1s": [[0, 1000], [45, 600], [45, 1000], [0, 600], [0, 3500]],
    };
    const fires = (script, opts) => {
      let n = 0, stuck = 0;
      for (let rep = 0; rep < 10; rep++) {
        const r = simulateGap({ script, swapMs: 1000, k: 1, readableTo: 90, seed: 7 + rep * 97, ...opts });
        if (r.sent.length) n++;
        if (r.final !== "front") stuck++;
      }
      return { n, stuck };
    };
    const gateRows = [];
    for (const yawNoise of [0, 4]) for (const [label, poses] of [["slow", slowPoses], ["fast", fastPoses]]) {
      for (const [name, script] of Object.entries(poses)) {
        gateRows.push({ label, name, yawNoise, ungated: fires(script, { earlyDeg: 15, yawNoise }), gated: fires(script, { earlyDeg: 15, minSpeed: 60, yawNoise }) });
      }
    }
    for (const r of gateRows) {
      console.log(`        ±${r.yawNoise}° jitter, ${r.name}: early_turn=15 fires ${r.ungated.n}/10 -> with early_turn_speed=60 ${r.gated.n}/10`);
    }
    check("ungated at 15 degrees, slow posing fires - the false positive the gate is for",
      gateRows.some((r) => r.label === "slow" && r.ungated.n > 0), JSON.stringify(gateRows.filter((r) => r.label === "slow")));
    check("gated at 60 deg/s, standing still, swaying and a held weight shift never fire - with or without yaw jitter",
      gateRows.filter((r) => r.label === "slow").every((r) => r.gated.n === 0),
      JSON.stringify(gateRows.filter((r) => r.label === "slow" && r.gated.n > 0)));
    check("THE LIMIT, stated: a fast pose starts like a turn - the gate does not stop a quick twist or a look at the side view...",
      gateRows.some((r) => r.label === "fast" && r.gated.n > 0));
    check("...and every one it lets through is still withdrawn to FRONT",
      gateRows.every((r) => r.gated.stuck === 0 && r.ungated.stuck === 0), JSON.stringify(gateRows.filter((r) => r.gated.stuck || r.ungated.stuck)));
    const gatedTurns = [];
    for (const speed of [60, 90, 120]) for (const k of [1, 0.75]) for (const readableTo of [90, 60]) {
      const base = simulateGap({ speed, k, readableTo, swapMs: 1000 });
      gatedTurns.push({ speed, k, readableTo, base, on: simulateGap({ speed, k, readableTo, swapMs: 1000, earlyDeg: 15, minSpeed: 60 }) });
    }
    const gMean = (key) => Math.round(gatedTurns.reduce((a, x) => a + wrongMs(x[key]), 0) / gatedTurns.length);
    console.log(`        full 360s, early_turn=15 + early_turn_speed=60: wrong garment ${gMean("base")}ms by default -> ${gMean("on")}ms (mean of ${gatedTurns.length})`);
    check("gated, every full 360 still completes, none is worse than the default, and the mean is under half of it",
      gatedTurns.every((x) => x.on.completed && wrongMs(x.on) <= wrongMs(x.base)) && gMean("on") * 2 < gMean("base"),
      JSON.stringify(gatedTurns.filter((x) => !x.on.completed || wrongMs(x.on) > wrongMs(x.base)).map((x) => [x.speed, x.k, x.readableTo, x.on.sent])));

    console.log("\n── §11 THE PRODUCTION DEFAULT - ?early_turn=" + numOr("ORIENT_EARLY_TURN_DEFAULT_DEG") + " gated at " + numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED") + " deg/s, a product decision on these numbers ──");
    const PD = numOr("ORIENT_EARLY_TURN_DEFAULT_DEG"), PS = numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED"), PR = numOr("ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG"), PSL = numOr("ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG");
    const prodTurns = [];
    for (const speed of [60, 90, 120]) for (const k of [1, 0.75]) for (const readableTo of [90, 60]) for (const swapMs of [700, 1000]) {
      const off = simulateGap({ speed, k, readableTo, swapMs });
      prodTurns.push({ speed, k, readableTo, swapMs, off, on: simulateGap({ speed, k, readableTo, swapMs, earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL }) });
    }
    const pMean = (key, lat) => { const xs = prodTurns.filter((x) => x.swapMs === lat); return Math.round(xs.reduce((a, x) => a + wrongMs(x[key]), 0) / xs.length); };
    for (const lat of [700, 1000]) console.log(`        full 360s at ${lat}ms render latency: wrong garment ${pMean("off", lat)}ms with the trigger off -> ${pMean("on", lat)}ms by default`);
    check("every modelled full 360 completes under the default, none is worse than with the trigger off, and the mean is under half",
      prodTurns.every((x) => x.on.completed && wrongMs(x.on) <= wrongMs(x.off)) && [700, 1000].every((lat) => pMean("on", lat) * 2 < pMean("off", lat)),
      JSON.stringify(prodTurns.filter((x) => !x.on.completed || wrongMs(x.on) > wrongMs(x.off)).map((x) => [x.speed, x.k, x.readableTo, x.swapMs, x.on.sent])));
    const prodSlow = [], prodFast = [];
    for (const yawNoise of [0, 4]) {
      for (const [name, script] of Object.entries(slowPoses)) prodSlow.push({ name, yawNoise, ...fires(script, { earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL, yawNoise }) });
      for (const [name, script] of Object.entries(fastPoses)) prodFast.push({ name, yawNoise, ...fires(script, { earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL, yawNoise }) });
    }
    for (const r of prodFast) console.log(`        default, ±${r.yawNoise}° jitter, ${r.name}: fires ${r.n}/10, every one withdrawn to FRONT: ${r.stuck === 0}`);
    /* THE GATE WENT 60 -> 45 (2026-09-15) - see ORIENT_EARLY_TURN_DEFAULT_SPEED. Gated at 60 the default never swapped
       for any slow pose; every gate under 60 gives up part of that, and these checks pin exactly how much 45 gives up,
       so a further drop has to restate the cost rather than slip past a loosened "never". */
    const slowLook = { "slow look to 30°, held 1s": [[0, 1000], [30, 900], [30, 1000], [0, 900], [0, 3000]] };
    for (const yawNoise of [0, 4]) for (const [name, script] of Object.entries(slowLook)) prodSlow.push({ name, yawNoise, ...fires(script, { earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL, yawNoise }) });
    for (const r of prodSlow) console.log(`        default, ±${r.yawNoise}° jitter, ${r.name}: fires ${r.n}/10, every one withdrawn to FRONT: ${r.stuck === 0}`);
    const slowRow = (name, yawNoise) => prodSlow.find((r) => r.name === name && r.yawNoise === yawNoise);
    check("under the default, standing still and swaying never swap - with or without yaw jitter",
      prodSlow.filter((r) => r.name === "stand still" || r.name.startsWith("sway")).every((r) => r.n === 0),
      JSON.stringify(prodSlow.filter((r) => (r.name === "stand still" || r.name.startsWith("sway")) && r.n)));
    check("...and without yaw jitter, neither a held weight shift nor a slow look to 30 degrees swaps",
      prodSlow.filter((r) => r.yawNoise === 0).every((r) => r.n === 0), JSON.stringify(prodSlow.filter((r) => r.yawNoise === 0 && r.n)));
    check("THE STATED COST OF 45: with ±4° jitter a held 18-degree weight shift swaps at most 1 time in 10, a slow look to 30 at most 2",
      slowRow("weight shift to 18°, held 1.5s", 4).n <= 1 && slowRow("slow look to 30°, held 1s", 4).n <= 2,
      JSON.stringify(prodSlow.filter((r) => r.yawNoise === 4)));
    check("...and every slow pose that does swap is withdrawn to FRONT",
      prodSlow.every((r) => r.stuck === 0), JSON.stringify(prodSlow.filter((r) => r.stuck)));

    /* THE REASON FOR 45. The gate is in the pose model's |yaw| units, and depth compression (k=0.75) turns a real
       60 deg/s turn into a ~45 rise - under the old gate the early trigger never fired on it, and BACK came from the
       vote path after the back already faced the lens. */
    const slowTurns = [];
    for (const k of [1, 0.75]) for (const readableTo of [90, 60]) for (const swapMs of [700, 1000]) {
      const script = [[0, 1000], [360, 6000], [360, 3000]];
      const firstBack = (r) => { const e = r.sent.find((x) => x.side === "back"); return e ? e.body : null; };
      const old = simulateGap({ script, k, readableTo, swapMs, earlyDeg: PD, minSpeed: 60, returnDeg: PR });
      const now = simulateGap({ script, k, readableTo, swapMs, earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL });
      slowTurns.push({ k, readableTo, swapMs, oldBack: firstBack(old), nowBack: firstBack(now), oldWrong: wrongMs(old), nowWrong: wrongMs(now), completed: now.completed });
    }
    for (const r of slowTurns) console.log(`        60°/s 360, k=${r.k} readable to ${r.readableTo}°, ${r.swapMs}ms: BACK sent at ${r.oldBack}° gated at 60 -> ${r.nowBack}° at ${PS} | wrong garment ${r.oldWrong} -> ${r.nowWrong}ms`);
    check("a 60 deg/s turn whose compressed |yaw| rose under the old gate now sends BACK in the front half of the turn",
      slowTurns.filter((r) => r.k === 0.75).every((r) => r.oldBack >= 90 && r.nowBack !== null && r.nowBack < 90),
      JSON.stringify(slowTurns.filter((r) => r.k === 0.75)));
    check("...and no 60 deg/s turn completes worse than under the old gate",
      slowTurns.every((r) => r.completed && r.nowWrong <= r.oldWrong), JSON.stringify(slowTurns.filter((r) => !r.completed || r.nowWrong > r.oldWrong)));
    check("...and every fast pose it does fire on ends back on FRONT (the stated cost: the other side's graphic until the withdrawal lands)",
      prodFast.every((r) => r.stuck === 0), JSON.stringify(prodFast.filter((r) => r.stuck)));

    /* THE RETURN LEG - the live clip (pear-tryon-...-FOX-20260914-225423.mp4): the shirt went plain while the back was
       still to the lens on the way back round, and that session's swaps were fast (234-333ms output stalls). Full 360s at
       90-140 deg/s against 250-1000ms dispatch-to-render: FRONT on a back-facing body during the return, per profile. */
    const legRuns = [];
    for (const swapMs of [250, 400, 700, 1000]) for (const speed of [90, 120, 140]) for (const k of [1, 0.75]) for (const readableTo of [90, 60]) {
      const script = [[0, 1000], [360, (360 / speed) * 1000], [360, 3000]];
      legRuns.push({ swapMs, speed, k, readableTo,
        v134: simulateGap({ script, k, readableTo, swapMs, earlyDeg: PD, minSpeed: PS }),
        now: simulateGap({ script, k, readableTo, swapMs, earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL }),
        off: simulateGap({ script, k, readableTo, swapMs }) });
    }
    const plainV134 = legRuns.filter((r) => r.v134.returnPlainMs > 0);
    for (const lat of [250, 400, 700, 1000]) {
      const xs = legRuns.filter((r) => r.swapMs === lat);
      const m = (key) => Math.round(xs.reduce((a, r) => a + r[key].returnPlainMs, 0) / xs.length);
      const tot = (key) => Math.round(xs.reduce((a, r) => a + wrongMs(r[key]), 0) / xs.length);
      console.log(`        ${lat}ms: plain back on the return ${m("v134")}ms with the return at ${PD}° -> ${m("now")}ms at ${PR}° | total wrong garment ${tot("v134")} -> ${tot("now")}ms (off: ${tot("off")}ms)`);
    }
    check("THE CLIP'S GAP, modelled: sending FRONT at the outbound threshold on the return leg puts it on a back-facing body",
      plainV134.length > 0, String(plainV134.length));
    check("THE FIX: with the return leg at ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG no modelled 360 puts FRONT on a back-facing body, at any latency",
      legRuns.every((r) => r.now.returnPlainMs === 0), JSON.stringify(legRuns.filter((r) => r.now.returnPlainMs).map((r) => [r.swapMs, r.speed, r.k, r.readableTo, r.now.returnPlainMs])));
    check("...and every one still completes, none showing more wrong garment than with the trigger off",
      legRuns.every((r) => r.now.completed && wrongMs(r.now) <= wrongMs(r.off)),
      JSON.stringify(legRuns.filter((r) => !r.now.completed || wrongMs(r.now) > wrongMs(r.off)).map((r) => [r.swapMs, r.speed, r.k, r.readableTo, wrongMs(r.now), wrongMs(r.off)])));


    /* THE SLOW PATH, through the same tick (see ORIENT_EARLY_TURN_SLOW_DEG). A slow deliberate turn never
       clears the speed gate between two readings, so before it the early trigger sat out and BACK came from
       the vote path once the back was already square. */
    const slowRuns = [];
    for (const speed of [30, 45, 60, 90, 120]) for (const k of [1, 0.75]) for (const readableTo of [90, 60]) {
      const script = [[0, 1000], [360, (360 / speed) * 1000], [360, 3000]];
      const o = { script, k, readableTo, swapMs: 700, earlyDeg: PD, minSpeed: PS, returnDeg: PR };
      const gateOnly = simulateGap({ ...o, slowDeg: 0 }), withSlow = simulateGap({ ...o, slowDeg: PSL });
      const backAt = (r) => { const b = r.sent.find((x) => x.side === "back"); return b ? b.body : null; };
      slowRuns.push({ speed, k, readableTo, gateOnly, withSlow, gBack: backAt(gateOnly), sBack: backAt(withSlow) });
    }
    for (const speed of [30, 45, 60, 90, 120]) {
      const xs = slowRuns.filter((r) => r.speed === speed);
      const mean = (key) => Math.round(xs.reduce((a, r) => a + wrongMs(r[key]), 0) / xs.length);
      console.log(`        ${String(speed).padStart(3)} deg/s turn: BACK sent at ${xs.map((r) => (r.gBack === null ? "never" : r.gBack + "°")).join("/")} with the gate alone -> ${xs.map((r) => (r.sBack === null ? "never" : r.sBack + "°")).join("/")} with the slow path | wrong garment ${mean("gateOnly")} -> ${mean("withSlow")}ms`);
    }
    const slowPathTurns = slowRuns.filter((r) => r.speed <= 45);
    check("THE SLOW TURN, modelled: with the gate alone a 30-45 deg/s turn sends BACK only once the back is round (past 90 degrees)",
      slowPathTurns.some((r) => r.gBack === null || r.gBack > 90), JSON.stringify(slowPathTurns.map((r) => [r.speed, r.k, r.readableTo, r.gBack])));
    check("THE FIX: with the slow path every modelled turn sends BACK in the FRONT half, and never later than the gate alone did",
      slowRuns.every((r) => r.sBack !== null && r.sBack <= 90 && (r.gBack === null || r.sBack <= r.gBack)),
      JSON.stringify(slowRuns.filter((r) => r.sBack === null || r.sBack > 90 || (r.gBack !== null && r.sBack > r.gBack)).map((r) => [r.speed, r.k, r.readableTo, r.gBack, r.sBack])));
    check("...and no turn shows the wrong garment longer than it did",
      slowRuns.every((r) => wrongMs(r.withSlow) <= wrongMs(r.gateOnly)),
      JSON.stringify(slowRuns.filter((r) => wrongMs(r.withSlow) > wrongMs(r.gateOnly)).map((r) => [r.speed, r.k, r.readableTo, wrongMs(r.gateOnly), wrongMs(r.withSlow)])));

    /* AND THE POSES ARE UNTOUCHED - the whole point of putting the slow path ABOVE where a pose settles.
       The request's own shape (a dwell at 22 degrees, any speed) fires on every one of these 10/10. */
    const poseSame = [];
    for (const [name, script] of Object.entries({ ...slowPoses, ...fastPoses,
      "weight shift to 25°, held 1s": [[0, 1000], [25, 500], [25, 1000], [0, 500], [0, 3000]],
      "slow look to 30°, held 1s": [[0, 1000], [30, 700], [30, 1000], [0, 700], [0, 3000]] })) {
      for (const yawNoise of [0, 4]) {
        const gateOnly = fires(script, { earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: 0, yawNoise });
        const withSlow = fires(script, { earlyDeg: PD, minSpeed: PS, returnDeg: PR, slowDeg: PSL, yawNoise });
        poseSame.push({ name, yawNoise, gateOnly, withSlow });
      }
    }
    for (const r of poseSame.filter((r) => r.yawNoise === 4)) console.log(`        ±4° jitter, ${r.name}: ${r.gateOnly.n}/10 with the gate alone -> ${r.withSlow.n}/10 with the slow path`);
    check("the slow path adds no pose it did not already fire on - every one identical, with and without yaw jitter",
      poseSame.every((r) => r.withSlow.n === r.gateOnly.n && r.withSlow.stuck === 0),
      JSON.stringify(poseSame.filter((r) => r.withSlow.n !== r.gateOnly.n || r.withSlow.stuck).map((r) => [r.name, r.yawNoise, r.gateOnly.n, r.withSlow.n])));

  }

  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const watcher = SRC.slice(w0, SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0));
  const p0 = SRC.indexOf("function startPresenceWatcher");
  const pose = SRC.slice(p0, SRC.indexOf("/* ── end body-presence gate ── */", p0));
  check("the pose loop records an inference that could not read the torso, beside the shoulder-order publish",
    /if \(facingSep !== null\) \{ _poseFacingSep = facingSep; _poseFacingAt = now; \}\s*\n\s*else _poseTorsoLostAt = now;/.test(pose));
  check("the tick hands that time to the window, and the window's pass to the decision behind the ?pose_pass=0 kill switch",
    /yawWindow\.observe\([^;]*, _poseTorsoLostAt\);/.test(watcher) &&
    /turnPassed: ORIENT_POSE_PASS && turnYaw\.passed,/.test(watcher) &&
    /const ORIENT_POSE_PASS = /.test(SRC) && /get\("pose_pass"\) !== "0"/.test(SRC));
  check("an early BACK is sent as a withdrawable one, ahead of the unchanged confirmed-swap line",
    /if \(dualView && confirmed && early && lastVote === "back"\) await maybeSwap\("back", true\);\s*\n\s*else if \(dualView && confirmed\) await maybeSwap\(lastVote\);/.test(watcher));
  check("the debug line says whether the torso was lost in the turn and whether it passed the side view",
    /torso lost \$\{yawWindow\.lostInTurn/.test(watcher) && /passed \$\{turnYaw\.passed/.test(watcher) && /POSE-FLIP\(pass\)/.test(watcher));
}

console.log("\n── §11 THE EARLY TURN TRIGGER AND THE SWAP PROFILE - units and wiring ──");
{
  if (makeEarlyTurnTrigger) {
    const run = (deg, steps) => { const e = makeEarlyTurnTrigger(deg); return { e, out: steps.map((s) => e.observe(s)) }; };
    const fired = (o) => o.fire, withdrew = (o) => o.withdraw;
    const off = run(0, [{ vote: "front", lock: "front", yawAbs: 5 }, { vote: null, lock: "front", yawAbs: 40 }]);
    check("deg 0 (the default) never arms, fires or withdraws", off.out.every((o) => !o.fire && !o.withdraw) && off.e.armed === null);
    const unsettled = run(20, [{ vote: "front", lock: "front", yawAbs: 30 }, { vote: null, lock: "front", yawAbs: 45 }]);
    check("it is not armed until a vote agrees with the lock UNDER the threshold - no settled pose, no early swap",
      unsettled.out.every((o) => !o.fire) && unsettled.e.armed === null);
    const turn = run(20, [
      { vote: "front", lock: "front", yawAbs: 6 },     // settled square on FRONT - armed
      { vote: "front", lock: "front", yawAbs: 24 },    // crosses 20 - fire BACK
      { vote: "front", lock: "back", yawAbs: 45 },     // the BACK swap landed; still rotating
      { vote: null, lock: "back", yawAbs: 88 },        // edge-on, against the NEW lock - must not fire back
      { vote: "back", lock: "back", yawAbs: 55 },      // a BACK vote - the turn is real
      { vote: "back", lock: "back", yawAbs: 8 },       // square facing away - re-armed on BACK
      { vote: "back", lock: "back", yawAbs: 23 },      // and a crossing from there sends FRONT
    ]);
    check("a settled pose crossing the threshold fires the other side exactly once",
      turn.out[1].fire === "back" && turn.out.slice(2, 6).every((o) => !o.fire && !o.withdraw), JSON.stringify(turn.out));
    check("...the edge-on stretch against the new lock does not fire it back, a vote for the new side confirms it, and it re-arms square on that side",
      turn.out[6].fire === "front" && turn.e.pending && turn.e.pending.from === "back", JSON.stringify({ out: turn.out, pending: turn.e.pending }));
    const twist = run(20, [
      { vote: "front", lock: "front", yawAbs: 5 }, { vote: "front", lock: "front", yawAbs: 30 },
      { vote: "front", lock: "back", yawAbs: 36 }, { vote: "front", lock: "back", yawAbs: 12 },
      { vote: "front", lock: "back", yawAbs: 6 },  { vote: "front", lock: "front", yawAbs: 4 },
    ]);
    check("a twist that comes back is withdrawn: the old side's vote under the threshold asks for it back...",
      twist.out[1].fire === "back" && !withdrew(twist.out[2]) && twist.out[3].withdraw === "front", JSON.stringify(twist.out));
    check("...on every tick until the lock is back, then the watch ends and it re-arms",
      twist.out[4].withdraw === "front" && !twist.out[5].withdraw && twist.e.pending === null && twist.e.armed === "front",
      JSON.stringify({ out: twist.out, pending: twist.e.pending, armed: twist.e.armed }));
    const refused = run(20, [{ vote: "front", lock: "front", yawAbs: 5 }, { vote: "front", lock: "front", yawAbs: 25 },
      { vote: "front", lock: "front", yawAbs: 30 }]);
    check("a fire the swap refused (the lock never moved) ends the watch without a withdrawal or a second fire",
      refused.out[1].fire === "back" && !fired(refused.out[2]) && !withdrew(refused.out[2]) && refused.e.pending === null);
    const stale = run(20, [{ vote: "front", lock: "front", yawAbs: 5 }, { vote: null, lock: "front", yawAbs: null }, { vote: "front", lock: "front", yawAbs: null }]);
    check("no fresh yaw, no early swap", stale.out.every((o) => !o.fire));

    const gated = (steps) => { const e = makeEarlyTurnTrigger(15, 60); return { e, out: steps.map((s) => e.observe(s)) }; };
    const slow = gated([
      { vote: "front", lock: "front", yawAbs: 5, at: 0 },
      { vote: "front", lock: "front", yawAbs: 12, at: 240 },      // 29 deg/s
      { vote: "front", lock: "front", yawAbs: 18, at: 480 },      // past 15, rising 25 deg/s - no fire
      { vote: "front", lock: "front", yawAbs: 18, at: 480 },      // the same reading on the next tick - counted once
    ]);
    check("SPEED GATE: a slow crossing does not fire, and one reading seen twice is not re-counted",
      slow.out.every((o) => !o.fire) && slow.e.armed === "front" && Math.round(slow.e.speed) === 25, JSON.stringify({ out: slow.out, speed: slow.e.speed }));
    const sped = gated([
      { vote: "front", lock: "front", yawAbs: 5, at: 0 }, { vote: "front", lock: "front", yawAbs: 18, at: 480 },
      { vote: "front", lock: "front", yawAbs: 40, at: 720 },      // still past 15, now rising 92 deg/s - fires
    ]);
    check("...but it stays armed, and fires if the motion speeds up while past the threshold",
      !sped.out[1].fire && sped.out[2].fire === "back", JSON.stringify(sped.out));
    const back = gated([
      { vote: "front", lock: "front", yawAbs: 5, at: 0 }, { vote: "front", lock: "front", yawAbs: 30, at: 480 },
      { vote: "front", lock: "front", yawAbs: 16, at: 600 },      // FALLING 117 deg/s, still past 15
    ]);
    check("...and only a RISING |yaw| counts - a fast return from past the threshold is not a turn starting",
      back.out.every((o) => !o.fire), JSON.stringify({ out: back.out, speed: back.e.speed }));
    const fast = gated([{ vote: "front", lock: "front", yawAbs: 3, at: 0 }, { vote: "front", lock: "front", yawAbs: 20, at: 240 }]);
    check("...while a fast crossing fires on the reading that makes it", fast.out[1].fire === "back", JSON.stringify(fast.out));
    const noAt = run(15, [{ vote: "front", lock: "front", yawAbs: 3 }, { vote: "front", lock: "front", yawAbs: 20 }]);
    check("with no gate, reading times are not needed - ?early_turn alone behaves as before", noAt.out[1].fire === "back");

    /* THE RETURN LEG'S OWN THRESHOLD (the live clip's plain back). */
    const split = (steps) => { const e = makeEarlyTurnTrigger(20, 0, 35); return { e, out: steps.map((s) => e.observe(s)) }; };
    const ret = split([
      { vote: "back", lock: "back", yawAbs: 6 },     // settled facing away - armed on BACK
      { vote: "back", lock: "back", yawAbs: 25 },    // past the outbound 20, under the return 35 - no FRONT yet
      { vote: null, lock: "back", yawAbs: 36 },      // past 35 - FRONT
    ]);
    check("RETURN LEG: from a BACK lock the early FRONT waits for returnDeg, not the outbound threshold",
      ret.e.pending && ret.e.pending.to === "front" && !ret.out[1].fire && ret.out[2].fire === "front", JSON.stringify(ret.out));
    const out = split([{ vote: "front", lock: "front", yawAbs: 4 }, { vote: "front", lock: "front", yawAbs: 21 }]);
    check("...while the outbound leg still fires BACK at deg", out.out[1].fire === "back", JSON.stringify(out.out));
    const noRet = (() => { const e = makeEarlyTurnTrigger(20, 0, 0); return [e.observe({ vote: "back", lock: "back", yawAbs: 5 }), e.observe({ vote: null, lock: "back", yawAbs: 60 })]; })();
    check("...and returnDeg 0 never sends FRONT early (the vote path carries the return)", noRet.every((o) => !o.fire), JSON.stringify(noRet));
    const same = run(20, [{ vote: "back", lock: "back", yawAbs: 5 }, { vote: null, lock: "back", yawAbs: 22 }]);
    check("...and with no returnDeg given the trigger is symmetric, as before", same.out[1].fire === "front", JSON.stringify(same.out));

    /* THE SLOW PATH (?early_turn_slow): above it, a |yaw| still RISING across the window fires even though the
       between-reading speed never clears the gate. Readings 240ms apart, as the pose loop publishes them. */
    const SLOW = numOr("ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG"), RISE = numOr("ORIENT_EARLY_TURN_SLOW_RISE_DEG");
    const slowRun = (yaws, slowOn = true) => {
      const e = makeEarlyTurnTrigger(20, 45, 35, slowOn ? SLOW : 0, RISE, [450, 960]);
      return yaws.map((y, i) => e.observe({ vote: i === 0 ? "front" : null, lock: "front", yawAbs: y, at: i * 240 }));
    };
    // a 30 deg/s turn under depth compression: ~7 degrees per 240ms reading - the gate (45/s) never sees it
    const slowTurn = slowRun([4, 11, 18, 25, 32, 39]);
    check("SLOW PATH: a steady slow rise fires once it is past the slow threshold, though the speed gate never clears",
      slowTurn.slice(0, 4).every((o) => !o.fire) && slowTurn.some((o) => o.fire === "back"),
      JSON.stringify(slowTurn.map((o) => o.fire)));
    const plateau = slowRun([4, 12, 20, 28, 36, 37, 37, 38, 37]);
    const firedAt = plateau.findIndex((o) => o.fire);
    check("...a pose that RISES to the same angle and then settles fires only while it was still rising, never from the plateau",
      firedAt === -1 || firedAt <= 5, JSON.stringify(plateau.map((o) => o.fire)));
    const settled = (() => {
      const e = makeEarlyTurnTrigger(20, 45, 35, SLOW, RISE, [450, 960]);
      const out = [];
      out.push(e.observe({ vote: "front", lock: "front", yawAbs: 5, at: 0 }));
      for (let i = 1; i <= 8; i++) out.push(e.observe({ vote: null, lock: "front", yawAbs: 38 + (i % 2), at: i * 240 }));
      return out;
    })();
    check("...and a body already parked past the slow threshold never fires from it - the rise is what says turn",
      settled.slice(2).every((o) => !o.fire), JSON.stringify(settled.map((o) => o.fire)));
    const under = slowRun([2, 9, 16, 23, 30, 33]);
    check("...nothing fires below the slow threshold, however steady the rise",
      under.every((o) => !o.fire), JSON.stringify(under.map((o) => o.fire)));
    check("...and slowDeg 0 turns the slow path off entirely (?early_turn_slow=0)",
      slowRun([4, 11, 18, 25, 32, 39, 46], false).every((o) => !o.fire));
  } else check("makeEarlyTurnTrigger() exists beside the window", false);

  const c0 = SRC.indexOf("const ORIENT_EARLY_TURN_DEG = (() => {");
  if (c0 === -1) check("ORIENT_EARLY_TURN_DEG reads ?early_turn", false, "not found");
  else {
    const iife = SRC.slice(c0, SRC.indexOf("})();", c0) + 5).replace("const ORIENT_EARLY_TURN_DEG = ", "return ");
    const parse = (search) => new Function("location", "ORIENT_EARLY_TURN_MIN_DEG", "ORIENT_EARLY_TURN_MAX_DEG", "ORIENT_EARLY_TURN_DEFAULT_DEG", iife)(
      { search }, numOr("ORIENT_EARLY_TURN_MIN_DEG"), numOr("ORIENT_EARLY_TURN_MAX_DEG"), numOr("ORIENT_EARLY_TURN_DEFAULT_DEG"));
    const got = ["", "?early_turn=", "?early_turn=0", "?early_turn=abc", "?early_turn=-5", "?early_turn=20", "?early_turn=25", "?early_turn=3", "?early_turn=90", "?orient_debug=1"].map((q) => [q, parse(q)]);
    check("ON BY DEFAULT: ?early_turn omitted, empty or unparseable is ORIENT_EARLY_TURN_DEFAULT_DEG (20); 0 or negative turns it OFF; a value is clamped to [10, 60]",
      numOr("ORIENT_EARLY_TURN_DEFAULT_DEG") === 20 &&
      JSON.stringify(got.map(([, v]) => v)) === JSON.stringify([20, 20, 0, 20, 0, 20, 25, 10, 60, 20]), JSON.stringify(got));
  }
  const sl0 = SRC.indexOf("const ORIENT_EARLY_TURN_SLOW_DEG = (() => {");
  if (sl0 === -1) check("ORIENT_EARLY_TURN_SLOW_DEG reads ?early_turn_slow", false, "not found");
  else {
    const iife = SRC.slice(sl0, SRC.indexOf("})();", sl0) + 5).replace("const ORIENT_EARLY_TURN_SLOW_DEG = ", "return ");
    const parse = (search) => new Function("location", "ORIENT_EARLY_TURN_MIN_DEG", "ORIENT_EARLY_TURN_MAX_DEG", "ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG", iife)(
      { search }, numOr("ORIENT_EARLY_TURN_MIN_DEG"), numOr("ORIENT_EARLY_TURN_MAX_DEG"), numOr("ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG"));
    const got = ["", "?early_turn_slow=", "?early_turn_slow=0", "?early_turn_slow=x", "?early_turn_slow=45", "?early_turn_slow=5", "?early_turn_slow=90"].map((q) => [q, parse(q)]);
    check("?early_turn_slow: default ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG (35), 0 turns the slow path off, clamped to [10, 60]",
      numOr("ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG") === 35 &&
      JSON.stringify(got.map(([, v]) => v)) === JSON.stringify([35, 35, 0, 35, 45, 10, 60]), JSON.stringify(got));
    check("...and it sits above where a pose settles, and above the outbound threshold it widens",
      numOr("ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG") > numOr("ORIENT_EARLY_TURN_DEFAULT_DEG") && numOr("ORIENT_EARLY_TURN_SLOW_RISE_DEG") >= 8);
  }
  const rt0 = SRC.indexOf("const ORIENT_EARLY_TURN_RETURN_DEG = (() => {");
  if (rt0 === -1) check("ORIENT_EARLY_TURN_RETURN_DEG reads ?early_turn_return", false, "not found");
  else {
    const iife = SRC.slice(rt0, SRC.indexOf("})();", rt0) + 5).replace("const ORIENT_EARLY_TURN_RETURN_DEG = ", "return ");
    const parse = (search) => new Function("location", "ORIENT_EARLY_TURN_MIN_DEG", "ORIENT_EARLY_TURN_MAX_DEG", "ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG", iife)(
      { search }, numOr("ORIENT_EARLY_TURN_MIN_DEG"), numOr("ORIENT_EARLY_TURN_MAX_DEG"), numOr("ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG"));
    const got = ["", "?early_turn_return=", "?early_turn_return=0", "?early_turn_return=x", "?early_turn_return=20", "?early_turn_return=5", "?early_turn_return=90"].map((q) => [q, parse(q)]);
    check("?early_turn_return: default ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG (35), 0 turns the early FRONT off, clamped to [10, 60]",
      numOr("ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG") === 35 && numOr("ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG") > numOr("ORIENT_EARLY_TURN_DEFAULT_DEG") &&
      JSON.stringify(got.map(([, v]) => v)) === JSON.stringify([35, 35, 0, 35, 20, 10, 60]), JSON.stringify(got));
  }
  const sp0 = SRC.indexOf("const ORIENT_EARLY_TURN_MIN_SPEED = (() => {");
  if (sp0 === -1) check("ORIENT_EARLY_TURN_MIN_SPEED reads ?early_turn_speed", false, "not found");
  else {
    const iife = SRC.slice(sp0, SRC.indexOf("})();", sp0) + 5).replace("const ORIENT_EARLY_TURN_MIN_SPEED = ", "return ");
    const parse = (search) => new Function("location", "ORIENT_EARLY_TURN_DEFAULT_SPEED", iife)({ search }, numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED"));
    const got = ["", "?early_turn_speed=", "?early_turn_speed=0", "?early_turn_speed=x", "?early_turn_speed=-1", "?early_turn_speed=60", "?early_turn_speed=5000"].map((q) => [q, parse(q)]);
    check("GATED BY DEFAULT: ?early_turn_speed omitted, empty or unparseable is ORIENT_EARLY_TURN_DEFAULT_SPEED (45); 0 or negative removes the gate; capped at 1000; =60 restores the old gate",
      numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED") === 45 &&
      JSON.stringify(got.map(([, v]) => v)) === JSON.stringify([45, 45, 0, 45, 0, 60, 1000]), JSON.stringify(got));
  }

  /* PRE-ENCODED REFERENCES - the wrapper and the encoder, run against a fake SDK client and FileReader. */
  const pe0 = SRC.indexOf("const _preEncodedRefs = new WeakMap();");
  const pe1 = SRC.indexOf("\nfunction garmentBlobIfWarm(", pe0);
  if (pe0 === -1 || pe1 === -1) check("preEncodeReference() / withPreEncodedReferences() exist", false);
  else {
    let reads = 0;
    class FakeReader {
      readAsDataURL(blob) { reads++; blob.arrayBuffer().then((buf) => { this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`; this.onloadend(); }); }
    }
    const pe = new Function("FileReader", "Blob", SRC.slice(pe0, pe1) + "\nreturn { preEncodeReference, withPreEncodedReferences };")(FakeReader, Blob);
    const blob = new Blob([Buffer.from("fake-jpeg-bytes")], { type: "image/jpeg" });
    const other = new Blob([Buffer.from("not-encoded-yet")], { type: "image/jpeg" });
    const sent = [];
    const client = { set: (input) => { sent.push(input); return Promise.resolve(); }, get sessionId() { return "live-session"; } };
    const wrapped = pe.withPreEncodedReferences(client);
    const first = await pe.preEncodeReference(blob);
    const again = await pe.preEncodeReference(blob);
    check("a Blob is encoded ONCE, into the data: URL the SDK's own readAsDataURL would make",
      first === `data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}` && again === first && reads === 1, JSON.stringify({ first, reads }));
    const payload = { prompt: "p", enhance: false, image: blob };
    await wrapped.set(payload);
    await wrapped.set({ prompt: "p", enhance: false, image: other });
    await wrapped.set({ prompt: "only a prompt" });
    check("set() hands the SDK the pre-encoded data: URL for that Blob - the base64 after its comma is the bytes the SDK would send",
      sent[0].image === first && sent[0].prompt === "p" && sent[0].enhance === false && first.split(",", 2)[1] === Buffer.from("fake-jpeg-bytes").toString("base64"),
      JSON.stringify(sent[0]));
    check("...leaves the caller's payload holding the Blob, so every identity check in app.js still sees the Blob",
      payload.image === blob);
    check("...and passes a Blob with no encoding yet, or no image at all, through untouched",
      sent[1].image === other && !("image" in sent[2]));
    check("the client is wrapped IN PLACE - its getters (sessionId) keep working - and only once",
      wrapped === client && client.sessionId === "live-session" && pe.withPreEncodedReferences(client) === client && pe.withPreEncodedReferences(null) === null);
  }
  check("every fetched garment Blob is pre-encoded as it lands, and the live client is wrapped at connect",
    /const blob = await normalizeToSupportedImage\(raw\);[\s\S]{0,300}preEncodeReference\(blob\);\s*\n\s*return blob;/.test(SRC) &&
    /rtClient = await client\.realtime\.connect\(realtimeInput, buildRealtimeConnectOpts\(gen\)\);[^\n]*\n[^\n]*\n\s*if \(typeof withPreEncodedReferences === "function"\) rtClient = withPreEncodedReferences\(rtClient\);/.test(SRC));

  const r0 = SRC.indexOf("function makeRenderResumeDetector(");
  if (r0 === -1) check("makeRenderResumeDetector() exists", false);
  else {
    const make = new Function("SWAP_RENDER_STALL_MIN_MS", "SWAP_RENDER_TRACE_MAX_MS",
      SRC.slice(r0, SRC.indexOf("\n}\n", r0) + 2) + "\nreturn makeRenderResumeDetector;")(numOr("SWAP_RENDER_STALL_MIN_MS"), numOr("SWAP_RENDER_TRACE_MAX_MS"));
    const feed = (held, frames, ackAt, maxMs) => {
      const d = make({ held, ...(maxMs ? { maxMs } : {}) }); let hit = null;
      for (const f of frames) { if (f === "ack") { d.ack(ackAt); continue; } hit = hit || d.frame(f); }
      return hit;
    };
    const normal = [0, 100, 200, 300, 400, 500];
    const heldHit = feed(true, [...normal, "ack", 600, 1050, 1150], 560);
    check("RENDER_APPLIED on a held swap is the frame that ends the output stall after the ACK - not the tail frames before it",
      heldHit && heldHit.at === 1050 && /stall/.test(heldHit.how), JSON.stringify(heldHit));
    const stallBeforeAck = feed(true, [...normal, "ack", 900, 1000], 850);
    check("...including a stall that began before the ACK arrived", stallBeforeAck && stallBeforeAck.at === 900, JSON.stringify(stallBeforeAck));
    const unheld = feed(false, [...normal, "ack", 600], 550);
    check("a swap that held nothing reports the first frame after the ACK, and says it is not proof",
      unheld && unheld.at === 600 && /not proof/.test(unheld.how), JSON.stringify(unheld));
    const never = feed(true, [...normal, "ack", 600, 700, 800, 900], 550, 300);
    check("no stall within the window falls back to the first frame after the ACK, and says it may still be the old reference",
      never && never.at === 600 && /old reference/.test(never.how), JSON.stringify(never));
    check("frames before the ACK are never RENDER_APPLIED", feed(true, [...normal, 1000, 2000], 0) === null);
  }

  const w0 = SRC.indexOf("function createOrientationWatcher()");
  const watcher = SRC.slice(w0, SRC.indexOf("\n/* Decode a garment URL into an ImageBitmap", w0));
  check("the trigger is built from the parsed setting - and ?early_turn=0 makes it null, with every use inert",
    /const earlyTurn = ORIENT_EARLY_TURN_DEG > 0\s*\n\s*\? makeEarlyTurnTrigger\(ORIENT_EARLY_TURN_DEG, ORIENT_EARLY_TURN_MIN_SPEED, ORIENT_EARLY_TURN_RETURN_DEG,\s*\n\s*ORIENT_EARLY_TURN_SLOW_DEG, ORIENT_EARLY_TURN_SLOW_RISE_DEG, ORIENT_EARLY_TURN_SLOW_WINDOW_MS\) : null;/.test(watcher) &&
    /const earlyAct = earlyTurn && dualView && !acquiring && !confirmed && !predictBack\s*\n\s*\? earlyTurn\.observe\(/.test(watcher));
  const skipAt = watcher.indexOf("if (!(dualView && (confirmed || predictBack))) {");
  const fireAt = watcher.indexOf('await maybeSwap(earlyAct.fire, earlyAct.fire === "back");');
  const withdrawAt = watcher.indexOf("await maybeSwap(earlyAct.withdraw);");
  check("the early block dispatches ahead of the pose/re-anchor updates and ends the tick (they would take the mutex and drop it)",
    fireAt !== -1 && withdrawAt !== -1 && fireAt < skipAt && withdrawAt < skipAt &&
    /await maybeSwap\(earlyAct\.fire, earlyAct\.fire === "back"\);[^\n]*\n\s*return;/.test(watcher) &&
    /await maybeSwap\(earlyAct\.withdraw\);\s*\n\s*return;/.test(watcher));
  check("...clears the pre-turn streak before an early fire, and only a BACK withdrawal resets the cooldown",
    /if \(earlyAct && earlyAct\.fire\) \{[\s\S]*?lastVote = null; streak = 0; faceStreak = 0; poseStreak = 0; poseSide = null;/.test(watcher) &&
    /if \(earlyAct\.withdraw === "back"\) lastSwapAt = 0;/.test(watcher) && (watcher.match(/lastSwapAt = 0;/g) || []).length === 1);

  const t0 = SRC.indexOf("function traceSwapTimeline(");
  const trace = SRC.slice(t0, SRC.indexOf("\n}\n", t0));
  check("the ?orient_debug=1 profile prints DISPATCH_SENT, SERVER_CONFIRMED and RENDER_APPLIED, then Client-to-ACK and ACK-to-Render",
    /\[PEAR\]\[ORIENT\] DISPATCH_SENT/.test(trace) && /\[PEAR\]\[ORIENT\] SERVER_CONFIRMED/.test(trace) &&
    /\[PEAR\]\[ORIENT\] RENDER_APPLIED/.test(trace) && /Client-to-ACK/.test(trace) && /ACK-to-Render/.test(trace) &&
    /performance\.now\(\)/.test(trace) && /makeRenderResumeDetector\(\{ held \}\)/.test(trace));
  const s0 = SRC.indexOf("function sendCondition(");
  const send = SRC.slice(s0, SRC.indexOf("\n}\n", s0));
  check("DISPATCH_SENT is marked by sendCondition() when a REFERENCE write takes the wire, and the hook is declared before it",
    /if \(typeof _orientSendMark === "function" && \(label === "applyGarment" \|\| label === "applyLook"\)\) \{/.test(send) &&
    send.indexOf("_orientSendMark") < send.indexOf("await send();") &&
    SRC.indexOf("let _orientSendMark = null;") !== -1 && SRC.indexOf("let _orientSendMark = null;") < s0);
}

console.log("\n── §12 A TURN THAT IS STARTING OWNS THE WIRE - the late BACK on the way out ──");
/* pear-tryon-...-FOX-20260915-072153.mp4 (v137): on the way OUT the back panel is to the lens and plain
   for ~230ms (2.82-3.02s) before COVE lands; the return leg is on time. A body re-drape dispatches on the
   first topology evaluation past 15 degrees, and the "turn owns the wire" flag only rises at a disagreeing
   vote or 45 - so between them a re-drape can take the wire just before the early trigger sends BACK at
   20, and the swap waits a round-trip behind it. Replayed here on the REAL tracker, old gate and new. */
{
  const fnSrc = (name) => { const a = SRC.indexOf(`function ${name}(`); return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2); };
  const constLine = (name) => (SRC.match(new RegExp(`const ${name}\\s*=[^\\n]*`)) || [""])[0];
  const g = new Function(
    "BODY_ROTATION_DELTA_DEG", "BODY_VOLUME_DELTA", "BODY_RECONDITION_COOLDOWN_MS", "BODY_TRACK_HOLD_MS",
    "ORIENT_EARLY_TURN_MIN_SPEED", "ORIENT_EARLY_TURN_DEFAULT_SPEED",
    [constLine("ORIENT_YAW_FRESH_MS"), constLine("ORIENT_TURN_START_SPEED"),
     "let _torsoYawAbs = null, _torsoYawAt = 0, _torsoYawRise = 0, currentAngle = 'auto'; const AUTO_ANGLE = 'auto';",
     fnSrc("relativeDelta"), fnSrc("topologyDelta"), fnSrc("topologyShift"), fnSrc("makeBodyTopologyTracker"),
     fnSrc("orientYawRise"), fnSrc("orientTurnStarting"),
     "return { makeBodyTopologyTracker, orientYawRise, orientTurnStarting, SPEED: ORIENT_TURN_START_SPEED," +
     " publish(abs, at) { _torsoYawRise = orientYawRise(_torsoYawAbs, _torsoYawAt, abs, at); _torsoYawAbs = abs; _torsoYawAt = at; }," +
     " reset() { _torsoYawAbs = null; _torsoYawAt = 0; _torsoYawRise = 0; }, setAngle(a) { currentAngle = a; } };"].join("\n")
  )(15, 0.18, 900, 1200, numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED"), numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED"));

  check("the turn speed is the early trigger's own gate (45 deg/s by default)",
    g.SPEED === numOr("ORIENT_EARLY_TURN_DEFAULT_SPEED") && g.SPEED === 45, String(g.SPEED));
  check("rise is deg/s between two fresh readings", g.orientYawRise(10, 1000, 46, 1240) === 150);
  check("...and 0 with no previous reading, a stale one, or the same instant",
    g.orientYawRise(null, 0, 30, 1000) === 0 && g.orientYawRise(10, 0, 30, 5000) === 0 && g.orientYawRise(10, 1000, 30, 1000) === 0);
  g.reset(); g.publish(0, 1000); g.publish(36, 1240);
  check("a torso rising at turn speed in AI Auto is a turn starting", g.orientTurnStarting(1300) === true);
  check("...but not once the reading is stale", g.orientTurnStarting(1240 + 601) === false);
  g.setAngle("front");
  check("...and never outside AI Auto - a single-view item has no swap to protect", g.orientTurnStarting(1300) === false);
  g.setAngle("auto");
  g.reset(); g.publish(10, 1000); g.publish(14, 1240);
  check("a slow sway (17 deg/s) is not a turn starting", g.orientTurnStarting(1300) === false);
  g.reset(); g.publish(40, 1000); g.publish(10, 1240);
  check("a fast return toward square (falling |yaw|) is not a turn starting", g.orientTurnStarting(1300) === false);

  /* The race. Pose ticks every 240ms publish |yaw| and evaluate the tracker on the topology cadence
     (350ms); the orientation tick every 250ms fires BACK on the first fresh |yaw| >= 20 rising at the
     gate, and raises the old turn flag at 45 or once BACK is out. A write holds the wire UPLOAD_MS. */
  const UPLOAD_MS = 300;
  const simulate = ({ newGate, turnAt, degPerSec = 150, peak = 90, orientPhase = 0 }) => {
    g.reset();
    let t = 0; const tracker = g.makeBodyTopologyTracker({ now: () => t });
    let lastTopologyAt = 0, wireFreeAt = 0, turnFlag = false, firedAt = null, dispatchedAt = null, redrapes = 0;
    let prevYaw = null, prevAt = 0, lastRise = 0;   // the trigger's own speed, independent of the gate under test
    const yawAt = (ms) => Math.min(peak, Math.max(0, (ms - turnAt) * degPerSec / 1000));
    for (t = 0; t <= turnAt + 2000; t += 10) {
      if (t % 240 === 0) {
        const yaw = yawAt(t); g.publish(yaw, t);
        lastRise = g.orientYawRise(prevYaw, prevAt, yaw, t); prevYaw = yaw; prevAt = t;
        if (t - lastTopologyAt >= 350) {
          lastTopologyAt = t;
          const busy = t < wireFreeAt;
          const starting = newGate && g.orientTurnStarting(t);
          const step = tracker.feed({ yaw, pitch: 0, depth: 0.3, aspect: 1 }, { canDispatch: !busy && !turnFlag && !starting });
          if (step.state === "shift") { redrapes++; wireFreeAt = Math.max(wireFreeAt, t) + UPLOAD_MS; }
        }
      }
      if ((t + orientPhase) % 250 === 0 && firedAt === null) {
        const yaw = yawAt(Math.floor(t / 240) * 240);       // the watcher reads the latest published reading
        const rise = t - prevAt <= 600 ? lastRise : 0;
        if (yaw >= 45) turnFlag = true;
        if (yaw >= 20 && rise >= g.SPEED) { firedAt = t; turnFlag = true; dispatchedAt = Math.max(t, wireFreeAt); wireFreeAt = dispatchedAt + UPLOAD_MS; }
      }
    }
    return { waitMs: firedAt === null ? null : dispatchedAt - firedAt, redrapes };
  };
  const sweep = (newGate) => {
    const out = [];
    for (let turnAt = 1000; turnAt < 1480; turnAt += 20) for (const orientPhase of [0, 80, 160]) out.push(simulate({ newGate, turnAt, orientPhase }));
    return out;
  };
  const before = sweep(false), after = sweep(true);
  const waited = (runs) => runs.filter((r) => r.waitMs > 0);
  check(`OLD GATE reproduces the hole: BACK waited behind a re-drape in ${waited(before).length}/${before.length} turn phasings, up to ${Math.max(0, ...before.map((r) => r.waitMs || 0))}ms`,
    waited(before).length > 0 && before.every((r) => r.waitMs !== null));
  check("NEW GATE: BACK never waits behind a re-drape, in any phasing",
    after.every((r) => r.waitMs === 0), JSON.stringify(waited(after).slice(0, 3)));

  /* NOTHING IS LOST for a shopper who is not turning. */
  const sway = simulate({ newGate: true, turnAt: 1000, degPerSec: 20, peak: 18 });
  check("a slow sway past 15 still re-drapes under the new gate", sway.redrapes >= 1 && sway.waitMs === null, JSON.stringify(sway));
  const twist = simulate({ newGate: true, turnAt: 1000, degPerSec: 150, peak: 18 });
  check("a fast twist that stops short of the trigger is deferred while rising, then re-drapes once it holds",
    twist.redrapes >= 1 && twist.waitMs === null, JSON.stringify(twist));

  const p0 = SRC.indexOf("function startPresenceWatcher");
  const pose = SRC.slice(p0, SRC.indexOf("/* ── end body-presence gate ── */", p0));
  check("the pose tick publishes the rise from the SAME reading, before the publish overwrites the previous one",
    /_torsoYawRise = orientYawRise\(_torsoYawAbs, _torsoYawAt, Math\.abs\(sig\.yaw\), now\);[^\n]*\n\s*_torsoYawAbs = Math\.abs\(sig\.yaw\);/.test(pose));
  check("...and the re-drape gate is evaluated on that tick, not the orientation tick's",
    /const turnStarting = orientTurnStarting\(now\);\s*\n\s*const step = bodyTopology\.feed\(/.test(pose));
}

console.log(fails === 0 ? "\nturn-yaw-window: OK" : `\nturn-yaw-window: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
