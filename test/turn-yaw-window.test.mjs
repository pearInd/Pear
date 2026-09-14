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
   taken at streak start is always taken AFTER it. On the return leg the first "front" vote
   is FaceDetector re-acquiring a face, which a frontal detector does inside ~30-40 degrees of
   square - so the swing left to measure is at most that, under ORIENT_YAW_TURN_DEG (45). The
   return leg therefore always paid the full 2.5s, with the back reference on screen.

   THE FIX: measure the swing from the PEAK |yaw| seen since the last vote that AGREED with
   the lock (makeTurnYawWindow). A real turn passes through edge-on and comes back down; a
   head-turn never raises the torso's yaw at all, so the defence ORIENT_LOCK_FRAMES exists
   for is untouched.

   §1 exercises the REAL makeTurnYawWindow() from app.js. §2 replays a modelled 360 through
   the flip-bar arithmetic with the old baseline and the new window side by side. The model
   is a model - it cannot stand in for a webcam, and the live check is the ORIENT_DEBUG line
   (?orient_debug=1), which prints yawΔ and the peak it was measured from.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const num = (name) => {
  const m = new RegExp(`^const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m").exec(SRC);
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return Number(m[1]);
};

const TURN_DEG   = num("ORIENT_YAW_TURN_DEG");
const LOCK_F     = num("ORIENT_LOCK_FRAMES");
const LOCK_MS    = num("ORIENT_LOCK_MS");
const CORR_F     = num("ORIENT_CORROBORATED_FRAMES");
const SAMPLE_MS  = num("ORIENT_SAMPLE_MS");
const COOLDOWN   = num("ORIENT_COOLDOWN_MS");

const start = SRC.indexOf("function makeTurnYawWindow(");
const end   = SRC.indexOf("/* ── THE BEST FRONT-FACING FRAME");
let makeTurnYawWindow = null;
if (start === -1 || end === -1 || end < start) {
  check("makeTurnYawWindow() exists in app.js", false, "the peak-since-agreement window is not implemented");
} else {
  makeTurnYawWindow = new Function("ORIENT_YAW_TURN_DEG",
    SRC.slice(start, end) + "\nreturn makeTurnYawWindow;")(TURN_DEG);
}

console.log("── §1 THE WINDOW ITSELF ──");
if (makeTurnYawWindow) {
  {
    const w = makeTurnYawWindow();
    const r = w.observe("front", "front", 3);
    check("an agreeing vote opens no swing - nothing is turning",
      r.usable === true && r.swing === 0 && r.corroborates === false, JSON.stringify(r));
  }
  {
    /* The return leg, in the order the sampler sees it. */
    const w = makeTurnYawWindow();
    w.observe("back", "back", 4);            // squarely away, lock agrees - window restarts here
    w.observe(null, "back", 40);             // turning, no confident vote
    w.observe(null, "back", 85);             // edge-on: the peak
    w.observe(null, "back", 50);
    const r = w.observe("front", "back", 20); // face re-acquired ~20 degrees off square
    check("a turn through edge-on corroborates on the FIRST vote for the new side",
      r.corroborates === true && r.swing === 65, JSON.stringify(r));
  }
  {
    /* Head-turn under a flickering light: the vote misreads, the shoulders never move. */
    const w = makeTurnYawWindow();
    w.observe("front", "front", 2);
    let any = false;
    for (const y of [6, 9, 4, 10, 7, 3, 8, 5, 9, 2, 6, 4]) any = w.observe("back", "front", y).corroborates || any;
    check("a head-turn (torso yaw <= 10 degrees) never corroborates, however long the misread lasts",
      any === false, "ORIENT_LOCK_FRAMES must stay the only bar here");
  }
  {
    /* Edge-on to check a profile, then back to the SAME side. */
    const w = makeTurnYawWindow();
    w.observe("front", "front", 0);
    w.observe(null, "front", 80);
    const r = w.observe("front", "front", 5);
    check("returning to the locked side closes the window - the old peak cannot linger",
      r.swing === 0 && r.corroborates === false && w.peak === 5, JSON.stringify({ r, peak: w.peak }));
  }
  {
    /* Still edge-on: a peak with no descent is not a completed turn. */
    const w = makeTurnYawWindow();
    w.observe("front", "front", 0);
    w.observe(null, "front", 80);
    const r = w.observe("back", "front", 78);
    check("holding edge-on is not a turn - the swing is measured DOWN from the peak",
      r.corroborates === false && r.swing === 2, JSON.stringify(r));
  }
  {
    const w = makeTurnYawWindow();
    w.observe("front", "front", 0);
    w.observe(null, "front", 80);
    const r = w.observe("back", "front", null);
    check("a stale or missing reading abstains - it is not a zero that clears the bar",
      r.usable === false && r.swing === 0 && r.corroborates === false, JSON.stringify(r));
    const r2 = w.observe("back", "front", 4);
    check("...and the peak banked before the gap still counts once a fresh reading returns",
      r2.corroborates === true, JSON.stringify(r2));
  }
  {
    const w = makeTurnYawWindow();
    const r = w.observe("back", null, 3);
    check("no peak yet (fresh session, first reading) is usable but cannot corroborate",
      r.usable === true && r.swing === 0 && r.corroborates === false, JSON.stringify(r));
    const r2 = makeTurnYawWindow().observe(null, null, null);
    check("...and no reading at all is not usable", r2.usable === false, JSON.stringify(r2));
  }
  {
    const out = makeTurnYawWindow().observe(null, "front", 30);
    check("the result carries no side - yaw attests a turn, it never picks one",
      !Object.values(out).some((v) => v === "front" || v === "back"), JSON.stringify(out));
  }
}

console.log("\n── §2 A MODELLED 360: how long GARMENT_BACK stays on a front-facing shopper ──");
/* Facing angle phi in [0,180] (0 = lens, 180 = away). |yaw| folds at edge-on: 90 - |90 - phi|,
   scaled by k because MediaPipe's z is compressed relative to x. Votes: a face inside
   faceDeg of square -> "front"; past backDeg -> "back"; otherwise abstain. */
function simulate({ speed, k, faceDeg, backDeg, occludeAbove = Infinity, rule, swapMs = 600 }) {
  const facing = (deg) => { const m = ((deg % 360) + 360) % 360; return m > 180 ? 360 - m : m; };
  const yawOf = (phi) => { const y = 90 - Math.abs(90 - phi); return y > occludeAbove ? null : k * y; };
  // Script: hold front 1s, turn 180, hold back 3s, turn 180 more, hold front 4s.
  const seg = [[0, 1000], [180, (180 / speed) * 1000], [180, 3000], [360, (180 / speed) * 1000], [360, 4000]];
  const angleAt = (t) => {
    let from = 0, t0 = 0;
    for (const [to, dur] of seg) {
      if (t <= t0 + dur) return from + (to - from) * ((t - t0) / dur);
      from = to; t0 += dur;
    }
    return 360;
  };
  const total = seg.reduce((a, [, d]) => a + d, 0);
  let lock = "front", lastVote = null, streak = 0, streakSince = 0, lastSwapAt = -Infinity, busyUntil = 0;
  let baseline = null;                       // old rule
  const win = rule === "peak" ? makeTurnYawWindow() : null;
  let facedFrontAt = null, frontLockedAt = null, backLockedAt = null;
  for (let t = 0; t <= total; t += SAMPLE_MS) {
    if (t < busyUntil) continue;             // maybeSwap is awaited: the sampler is paused
    const phi = facing(angleAt(t));
    const vote = phi <= faceDeg ? "front" : phi >= backDeg ? "back" : null;
    const yaw = yawOf(phi);
    if (backLockedAt !== null && facedFrontAt === null && vote === "front") facedFrontAt = t;
    if (vote) {
      if (vote === lastVote) streak++;
      else { lastVote = vote; streak = 1; streakSince = t; if (rule === "streak-start") baseline = yaw; }
    }
    let corroborates;
    if (rule === "peak") corroborates = win.observe(vote, lock, yaw).corroborates;
    else corroborates = yaw !== null && baseline !== null && Math.abs(yaw - baseline) >= TURN_DEG;
    const needsSwitch = !!lastVote && lastVote !== lock;
    const flipBar = corroborates ? Math.min(LOCK_F, CORR_F) : LOCK_F;
    const held = lastVote ? t - streakSince : 0;
    if (needsSwitch && (streak >= flipBar || held >= LOCK_MS) && t - lastSwapAt >= COOLDOWN) {
      lock = lastVote; lastSwapAt = t; busyUntil = t + swapMs;
      if (lock === "back" && backLockedAt === null) backLockedAt = t;
      if (lock === "front" && backLockedAt !== null && frontLockedAt === null) frontLockedAt = t;
    }
  }
  return { backLockedAt, facedFrontAt, frontLockedAt,
           leakMs: frontLockedAt !== null && facedFrontAt !== null ? frontLockedAt - facedFrontAt : null };
}

if (makeTurnYawWindow) {
  const profiles = [];
  for (const speed of [90, 120]) for (const k of [1, 0.75]) for (const faceDeg of [30, 40]) for (const backDeg of [140, 155])
    profiles.push({ speed, k, faceDeg, backDeg });

  const rows = profiles.map((p) => ({ p, old: simulate({ ...p, rule: "streak-start" }), neu: simulate({ ...p, rule: "peak" }) }));
  const fmt = (r) => r.leakMs === null ? "never" : `${r.leakMs}ms`;
  for (const { p, old, neu } of rows) {
    console.log(`        ${p.speed}°/s k=${p.k} face<=${p.faceDeg}° back>=${p.backDeg}°  ` +
      `back-on-front: streak-start ${fmt(old)} -> peak ${fmt(neu)}`);
  }
  check("every profile completes both legs under both rules (the model is sane)",
    rows.every(({ old, neu }) => old.leakMs !== null && neu.leakMs !== null));
  /* Documents the defect rather than app.js: with the face re-acquired inside 45 degrees of
     square, a streak-start baseline has no swing left to measure on the return leg. */
  check("OLD baseline: the return leg never takes the corroborated path (pays the full bar)",
    rows.every(({ old }) => old.leakMs >= (LOCK_F - 1) * SAMPLE_MS),
    rows.map(({ old }) => old.leakMs).join(","));
  check("NEW window: the return leg takes the corroborated path on every profile",
    rows.every(({ neu }) => neu.leakMs <= CORR_F * SAMPLE_MS),
    rows.map(({ neu }) => neu.leakMs).join(","));
  check("...and is strictly faster than the old baseline on every profile",
    rows.every(({ old, neu }) => neu.leakMs < old.leakMs));

  /* Occlusion near edge-on drops readings exactly where the peak lives. With an accurate z
     the shoulders still read ~60 degrees before landmarks give out, which clears 45; this
     pins that the window degrades to the old bar rather than to something worse. */
  const occl = simulate({ speed: 90, k: 1, faceDeg: 30, backDeg: 150, occludeAbove: 60, rule: "peak" });
  const occlOld = simulate({ speed: 90, k: 1, faceDeg: 30, backDeg: 150, occludeAbove: 60, rule: "streak-start" });
  check("landmarks lost above 60 degrees: still corroborates from the last readable peak",
    occl.leakMs !== null && occl.leakMs <= CORR_F * SAMPLE_MS, JSON.stringify(occl));
  const deep = simulate({ speed: 90, k: 0.6, faceDeg: 30, backDeg: 150, occludeAbove: 60, rule: "peak" });
  check("...and when the readable peak cannot clear the bar, it is no slower than the old baseline",
    deep.leakMs !== null && deep.leakMs <= occlOld.leakMs, JSON.stringify({ deep, occlOld }));
}

console.log("\n── §3 THE SAMPLER USES THE WINDOW ──");
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
}

console.log(fails === 0 ? "\nturn-yaw-window: OK" : `\nturn-yaw-window: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
