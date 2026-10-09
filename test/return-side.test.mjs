/* THE CHEST COMES ROUND - "the back disappears too fast" (2026-10-01)
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED with a clip and its TEST record: the back print vanished with the back still three-quarters
   to the lens. The record: FRONT went out on the return leg's |yaw| 59 rising (main's 50-degree early
   return), and a swap lands on screen on about the body angle it was sent at - so the front landed on
   ~210 degrees. lib/orient-engine.js now sends the return FRONT when the CHEST comes round: the room's
   shoulder order, as a share of the shopper's square-on width (app.js torsoOrder), at or past
   ORIENT_RETURN_SIDE on the FRONT side. What this suite pins:

   §1 THE TRIGGER, on literals: it waits for the chest past the side, not |yaw| 50; a mirrored skeleton
      on a back-facing body (-1 straight to +1) never fires it; it is withdrawn like the other paths;
      the outbound leg ignores the order; ?return_side=0 and a room that never sends an order keep
      main's |yaw| return exactly.
   §2 THE MEASUREMENT (app.js, run standalone): torsoOrder is null until the baseline is learned, signed
      like the shoulder vote, bounded, and refuses a degenerate torso.
   §3 THE REPORTED SESSION (test/return-side-s3.json - the record's own ticks): main's rule reproduces the
      record's FRONT at the tick it went out; the new rule sends nothing while the shoulders still read
      the back.
   §4 THIRTEEN REAL 360s (test/torso-twist-poses.json + the reported clip), every reading through the real
      browser measurement and the real engine at four tick phases: the return FRONT never lands on a
      back-facing body (main's does), never lands with the chest square to the lens, is never lost, the
      outbound BACK goes out on the same tick as main's, and no 360 swaps more than main's.
   §4b THE ENGINE'S PACE (2026-10-04): with a slow engine (the PEAK tee's ~750ms acks) the return lands ~57 degrees later;
      the room's `lat` brings it ~26 degrees back without ever landing on a back-facing body; a fast engine is untouched.
   §5 THE WIRING: the sample carries the order (typeof-guarded), both knob lists carry return_side, the
      sanitiser bounds it, the TEST record logs it.
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ENGINE_SRC = readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const POSES = JSON.parse(readFileSync(new URL("./torso-twist-poses.json", import.meta.url), "utf8"));
const S3 = JSON.parse(readFileSync(new URL("./return-side-s3.json", import.meta.url), "utf8"));
const U1 = JSON.parse(readFileSync(new URL("./return-side-u1.json", import.meta.url), "utf8"));
const PACE = JSON.parse(readFileSync(new URL("./return-side-pace.json", import.meta.url), "utf8"));
const E = await import("../lib/orient-engine.js");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function between(src, a, b) {
  const i = src.indexOf(a); if (i === -1) throw new Error(`no "${a}"`);
  const j = src.indexOf(b, i); if (j === -1) throw new Error(`no "${b}"`);
  return src.slice(i, j);
}

const trig = (sideOrder, knobs = {}) => E.createOrientEngine(E.sanitizeOrientKnobs(knobs)).internals.makeEarlyTurnTrigger(
  40, 45, 50, 50, 10, [450, 960], 20, sideOrder);
const run = (t, obs) => obs.map((o) => t.observe(o));
const firstFire = (out) => out.findIndex((o) => o.fire);

console.log("\n── §1 the trigger ──");
{
  /* A real return: square on the back, the shoulders narrowing toward the side, the side, the chest round. */
  const ret = [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 30, at: 240, ord: -0.86, ordAt: 240 },
    { vote: null, lock: "back", yawAbs: 59, at: 480, ord: -0.51, ordAt: 480 },   // main fires here (|yaw| 50 rising)
    { vote: null, lock: "back", yawAbs: 82, at: 720, ord: -0.12, ordAt: 720 },
    { vote: null, lock: "back", yawAbs: 85, at: 960, ord: 0.1, ordAt: 960 },
    { vote: null, lock: "back", yawAbs: 72, at: 1200, ord: 0.32, ordAt: 1200 },
  ];
  const out = run(trig(0.2), ret);
  check("§1.1 the return waits for the side: nothing at |yaw| 59 (order -0.51) or just before the side (-0.12)",
    !out[0].fire && !out[1].fire && !out[2].fire && !out[3].fire, JSON.stringify(out));
  check("§1.2 ...and FRONT goes out AT THE SIDE - the first reading past it (0.1), coming from the back - via the order",
    out[4].fire === "front" && out[4].via === "order", JSON.stringify(out[4]));
  const skip = run(trig(0.2), [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: null, lock: "back", yawAbs: 55, at: 240, ord: -0.62, ordAt: 240 },
    { vote: null, lock: "back", yawAbs: 60, at: 480, ord: 0.48, ordAt: 480 },   // a fast pass: the side fell between readings
  ]);
  check("§1.2b a fast pass whose side fell between two readings fires on the chest instead",
    !skip[1].fire && skip[2].fire === "front", JSON.stringify(skip));
  const noOrd = run(trig(0.2), ret.map(({ ord, ordAt, ...o }) => o));
  check("§1.3 a room that never sends an order keeps main's return exactly: FRONT at |yaw| 59",
    firstFire(noOrd) === 2 && noOrd[2].fire === "front" && noOrd[2].via === "fast", JSON.stringify(noOrd));
  const off = run(trig(0), ret);
  check("§1.4 ?return_side=0 is main's return exactly, order or not", JSON.stringify(off) === JSON.stringify(noOrd), JSON.stringify(off));
  /* BlazePose can label a back-facing skeleton as facing the lens: the order jumps -1 -> +1 with no side between. */
  const mirror = run(trig(0.2), [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: null, lock: "back", yawAbs: 8, at: 240, ord: 0.9, ordAt: 240 },
    { vote: null, lock: "back", yawAbs: 6, at: 480, ord: 0.92, ordAt: 480 },
    { vote: null, lock: "back", yawAbs: 7, at: 720, ord: 0.88, ordAt: 720 },
  ]);
  check("§1.5 a mirrored skeleton on a back-facing body (order -1 straight to +0.9, no side seen) never fires",
    mirror.every((o) => !o.fire), JSON.stringify(mirror));
  const lost = run(trig(0.2), [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 25, at: 240, ord: -0.9, ordAt: 240 },
    { vote: null, lock: "back", yawAbs: 25, at: 240, ord: -0.9, ordAt: 240, lostAt: 480 },   // lost at the side view
    { vote: null, lock: "back", yawAbs: 30, at: 720, ord: 0.45, ordAt: 720 },
  ]);
  check("§1.6 a torso lost at the side counts as the side seen: the next reading with the chest round fires",
    !lost[2].fire && lost[3].fire === "front" && lost[3].via === "order", JSON.stringify(lost));
  check("§1.7 ...where main's loss path would have fired FRONT at the loss itself",
    run(trig(0), [
      { vote: "back", lock: "back", yawAbs: 5, at: 0 }, { vote: "back", lock: "back", yawAbs: 25, at: 240 },
      { vote: null, lock: "back", yawAbs: 25, at: 240, lostAt: 480 }])[2].fire === "front");
  const t = trig(0.2);
  const w = run(t, [...ret.slice(0, 5), { vote: "back", lock: "front", yawAbs: 30, at: 1200, ord: -0.8, ordAt: 1200 }]);
  check("§1.8 withdrawn like the other paths: the shopper turns back to face away before any FRONT vote",
    w[5].withdraw === "back", JSON.stringify(w[5]));
  const outbound = [
    { vote: "front", lock: "front", yawAbs: 5, at: 0, ord: 1, ordAt: 0 },
    { vote: "front", lock: "front", yawAbs: 20, at: 240, ord: 0.93, ordAt: 240 },
    { vote: null, lock: "front", yawAbs: 45, at: 480, ord: 0.66, ordAt: 480 },
  ];
  check("§1.9 the outbound leg ignores the order: BACK at |yaw| 45 exactly as main",
    JSON.stringify(run(trig(0.2), outbound)) === JSON.stringify(run(trig(0), outbound.map(({ ord, ordAt, ...o }) => o))) &&
    run(trig(0.2), outbound)[2].fire === "back");
  const sticky = run(trig(0.2), [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 30, at: 240 },
    { vote: null, lock: "back", yawAbs: 59, at: 480 },
  ]);
  check("§1.10 once a session has measured the order, a reading without one never falls back to |yaw| 50",
    sticky.every((o) => !o.fire), JSON.stringify(sticky));
  const back = run(trig(0.2), [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: null, lock: "back", yawAbs: 59, at: 240, ord: -0.5, ordAt: 240 },
    { vote: "back", lock: "back", yawAbs: 10, at: 480, ord: -0.98, ordAt: 480 },   // square away again
    { vote: null, lock: "back", yawAbs: 12, at: 720, ord: 0.9, ordAt: 720 },       // ...then a mirrored reading
  ]);
  check("§1.11 square on the back again, the side must be seen afresh: a mirrored reading after it does not fire",
    back.every((o) => !o.fire), JSON.stringify(back));
  /* THE FOLD, read by the order (2026-10-04): an early BACK, then on the way INTO the back |yaw| falls under 40 again and a
     skin vote says FRONT - main's withdrawal sent FRONT onto a body at ~140 degrees (twin harness, n2 at 0.7x). */
  const fold = trig(0.2);
  const into = run(fold, [
    { vote: "front", lock: "front", yawAbs: 5, at: 0, ord: 1, ordAt: 0 },
    { vote: null, lock: "front", yawAbs: 49, at: 240, ord: 0.67, ordAt: 240 },            // the early BACK
    { vote: "front", lock: "back", yawAbs: 36, at: 480, ord: -0.69, ordAt: 480 },        // folded |yaw|, a skin vote for FRONT
  ]);
  check("§1.14 an early BACK is NOT withdrawn while the order reads the back side (the fold), whatever the vote says",
    into[1].fire === "back" && !into[2].withdraw, JSON.stringify(into));
  const look = run(trig(0.2), [
    { vote: "front", lock: "front", yawAbs: 5, at: 0, ord: 1, ordAt: 0 },
    { vote: null, lock: "front", yawAbs: 49, at: 240, ord: 0.67, ordAt: 240 },
    { vote: "front", lock: "back", yawAbs: 20, at: 480, ord: 0.93, ordAt: 480 },          // a look that came back
    { vote: "front", lock: "back", yawAbs: 12, at: 720, ord: 0.98, ordAt: 720 },          // ...and still reads the front
  ]);
  /* Withdrawn on the SECOND such reading since 2026-10-07 (the 07:31 session - one mirrored +1.0 on a back-facing body). */
  check("§1.15 ...and a look that really came back (the order back on the front) is withdrawn - on its second reading",
    !look[2].withdraw && look[3].withdraw === "front", JSON.stringify(look));
  /* THE 07:31 SESSION, on literals: the early BACK at the side, then the pose model reads the BACK as a full-width FRONT once
     (+1.0, |yaw| 7, the shoulders voting FRONT) and the same reading again on the next tick, then the back half (-0.52, the
     vote abstaining), the side, the chest. */
  const m0731 = run(trig(0.2), [
    { vote: "front", lock: "front", yawAbs: 5, at: 0, ord: 1, ordAt: 0 },
    { vote: null, lock: "front", yawAbs: 84, at: 240, ord: 0.1, ordAt: 240 },             // the early BACK, at the side
    { vote: "front", lock: "back", yawAbs: 7, at: 480, ord: 1, ordAt: 480 },              // the mirrored skeleton
    { vote: "front", lock: "back", yawAbs: 7, at: 730, ord: 1, ordAt: 480 },              // ...the same reading again
    { vote: null, lock: "back", yawAbs: 57, at: 980, ord: -0.52, ordAt: 980 },            // the back half, no vote
    { vote: "front", lock: "back", yawAbs: 85, at: 1230, ord: 0.03, ordAt: 1230 },        // the side, on the way back
  ]);
  check("§1.15b one mirrored reading (the same one voted twice) never withdraws the early BACK",
    m0731[1].fire === "back" && !m0731[2].withdraw && !m0731[3].withdraw, JSON.stringify(m0731));
  check("§1.15c ...the back half confirms the turn though no vote did, and the FRONT goes out AT THE SIDE",
    !m0731[4].fire && !m0731[4].withdraw && m0731[5].fire === "front" && m0731[5].via === "order", JSON.stringify(m0731));
  const m0731NoOrd = run(trig(0.2), m0731.length ? [
    { vote: "front", lock: "front", yawAbs: 5, at: 0 }, { vote: null, lock: "front", yawAbs: 84, at: 240 },
    { vote: "front", lock: "back", yawAbs: 7, at: 480 }] : []);
  check("§1.15d a room that sends no order withdraws on the first reading, as main does", m0731NoOrd[2].withdraw === "front", JSON.stringify(m0731NoOrd));
  const noOrdFold = run(trig(0.2), [
    { vote: "front", lock: "front", yawAbs: 5, at: 0 }, { vote: null, lock: "front", yawAbs: 49, at: 240 },
    { vote: "front", lock: "back", yawAbs: 36, at: 480 }]);
  check("§1.16 a room that sends no order keeps main's withdrawal exactly", noOrdFold[2].withdraw === "front", JSON.stringify(noOrdFold));
  /* THE ENGINE'S PACE (2026-10-04): the room's median image ack (`lat`). A slow engine's return fires a reading early when
     the turn's own order speed reaches the side within the extra ack time; a fast one, none, a snap or a floor never. */
  const paceTrig = (latLead = true) => E.createOrientEngine(E.sanitizeOrientKnobs({})).internals.makeEarlyTurnTrigger(
    40, 45, 50, 50, 10, [450, 960], 20, 0.2, latLead);
  /* Every case starts square to the lens 1.2s before - where the turn's average speed is measured from. */
  const START = { vote: "front", lock: "front", yawAbs: 3, at: -1200, ord: 1, ordAt: -1200 };
  const paced = (lat, latLead, steps = ret) => run(paceTrig(latLead), [START, ...steps].map((o) => ({ ...o, lat }))).slice(1);
  const slow = paced(750, true);
  /* The turn averaged ~142 deg/s from the front (0 at -1.2s) to -0.51 (239 degrees at 0.48s): the 550ms a 750ms engine adds
     covers ~78 degrees, past the side - so the return goes out there. The reading before it (-0.86) is past the floor. */
  check("§1.17 a slow engine (750ms) fires the return when the turn's average speed reaches the side within its extra ack time - -0.51 here - via the lead",
    firstFire(slow) === 2 && slow[2].fire === "front" && slow[2].via === "lead", JSON.stringify(slow));
  check("§1.18 a fast engine (200ms), no pace, or ?lat_lead=0 fires exactly where the side rule does",
    [paced(200, true), paced(null, true), paced(750, false)].every((o) => firstFire(o) === 4 && o[4].via === "order"));
  const snapSteps = [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 6, at: 240, ord: -0.99, ordAt: 240 },   // still at the back
    { vote: null, lock: "back", yawAbs: 40, at: 480, ord: -0.05, ordAt: 480 },   // +0.94 in one reading, |yaw| 40: a snap, not a speed
  ];
  check("§1.19 a snap (more than 0.8 in one reading) is not a speed: nothing fires early", !paced(750, true, snapSteps).some((o) => o.fire));
  const deep = [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 20, at: 240, ord: -0.95, ordAt: 240 },
    { vote: null, lock: "back", yawAbs: 30, at: 480, ord: -0.88, ordAt: 480 },   // rising and fast, but past the floor (-0.85)
  ];
  check("§1.20 ...and the 2026-10-04 rule never fires from deeper than its floor (-0.85), however fast", !paced(750, true, deep).some((o) => o.fire));
  /* THE PROJECTION (its floor is -1.0): a shopper STANDING at the back - the order wobbling around -1 (the recorded 360s:
     +-0.05-0.07) - is kept from firing by the projection's own step speed: a wobble projects nowhere near the side. */
  const projTrig = () => E.createOrientEngine(E.sanitizeOrientKnobs({})).internals.makeEarlyTurnTrigger(
    40, 45, 50, 50, 10, [450, 960], 20, 0.2, true, true);
  const projected = (lat, steps) => run(projTrig(), [START, ...steps].map((o) => ({ ...o, lat }))).slice(1);
  const still = [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -1.02, ordAt: 0 },
    { vote: "back", lock: "back", yawAbs: 4, at: 250, ord: -0.97, ordAt: 250 },
    { vote: "back", lock: "back", yawAbs: 6, at: 500, ord: -1.04, ordAt: 500 },
    { vote: "back", lock: "back", yawAbs: 3, at: 750, ord: -0.96, ordAt: 750 },
    { vote: "back", lock: "back", yawAbs: 5, at: 1000, ord: -0.99, ordAt: 1000 },
    { vote: "back", lock: "back", yawAbs: 7, at: 1250, ord: -0.93, ordAt: 1250 },
  ];
  check("§1.20b the projection: a shopper standing at the back (the order wobbling at -1) never fires, however slow the engine",
    !projected(750, still).some((o) => o.fire) && !projected(1200, still).some((o) => o.fire), JSON.stringify(projected(1200, still)));
  check("§1.20c ...while a real return from the same depth does - and a reading earlier than the 2026-10-04 rule",
    firstFire(projected(750, ret)) >= 0 && firstFire(projected(750, ret)) < firstFire(slow), JSON.stringify(projected(750, ret)));
  const falling = [
    { vote: "back", lock: "back", yawAbs: 5, at: 0, ord: -0.55, ordAt: 0 },
    { vote: null, lock: "back", yawAbs: 20, at: 240, ord: -0.62, ordAt: 240 },   // turning back toward the back
    { vote: null, lock: "back", yawAbs: 20, at: 480, ord: -0.7, ordAt: 480 },    // ...and further
  ];
  check("§1.21 an order falling back toward the back never fires", !paced(750, true, falling).some((o) => o.fire));
  /* PREDICTIVE BACK, gated on the order: a FRONT lock whose |yaw| passed the side and is falling is either a body
     passing to the back (the order on the back side) or one coming round to the lens (the order on the front). */
  const I = E.createOrientEngine(E.sanitizeOrientKnobs({})).internals;
  const win = { open: true, turning: true, edgeAt: 900, edgeLost: false, peak: 80 };
  const why = (ord, sideOrder = 0.2) => I.orientPredictBackReason({ enabled: true, acquiring: false, lock: "front", win, yawAbs: 55, now: 1200, ord, sideOrder });
  check("§1.12 predictive BACK still fires on a pass to the back (the order on the back side) and without an order",
    why(-0.4) === "fire" && why(null) === "fire" && why(0.1) === "fire", `${why(-0.4)} | ${why(null)} | ${why(0.1)}`);
  check("§1.13 ...never with the chest round to the lens (order 0.2+), and ?return_side=0 is main's gate",
    why(0.6) !== "fire" && /chest faces the lens/.test(why(0.6)) && why(0.6, 0) === "fire", `${why(0.6)} | ${why(0.6, 0)}`);
}

console.log("\n── §2 the measurement ──");
const BLOCK = between(APP, "const TWIST_SHOULDER_MAX", "let _poseTwist = makeTwistState();");
const R = new Function("location", "ORIENT_POSE_FACING_MARGIN",
  BLOCK + "\nreturn { makeTwistState, torsoTwistStep, torsoYawGuard, torsoOrder };")({ search: "" }, 0.25);
{
  const s = R.makeTwistState();
  const sq = { sh: 0.4, hip: 0.22, th: 0.31 };
  check("§2.1 null until the square-on width is learned", R.torsoOrder(s, sq) === null);
  for (let i = 0; i < 6; i++) R.torsoTwistStep(s, sq, 3, i * 240);
  check("§2.2 +1 square to the lens once learned", Math.abs(R.torsoOrder(s, sq) - 1) < 1e-9, R.torsoOrder(s, sq));
  check("§2.3 signed like the shoulder vote: facing away reads negative, the side ~0",
    R.torsoOrder(s, { sh: -0.36, hip: -0.2, th: 0.31 }) < -0.85 && Math.abs(R.torsoOrder(s, { sh: 0.02, hip: 0.01, th: 0.31 })) < 0.1);
  check("§2.4 bounded", R.torsoOrder(s, { sh: 3, hip: 0.2, th: 0.31 }) === 1.5);
  check("§2.5 a degenerate torso (a fifth of the learned height) reads nothing",
    R.torsoOrder(s, { sh: 0.02, hip: 0.01, th: 0.06 }) === null);
  check("§2.6 no torso, nothing", R.torsoOrder(s, null) === null);
}

/* The room, reduced to what the engine sees: the pose readings in order (the real learn, guard and order),
   the shoulder vote, and a tick every 250ms at a given phase. The lock moves as the room's maybeSwap does. */
function roomRun(rows, { knobs = {}, sendOrd = true, phase = 0, lat = null } = {}) {
  const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
  const st = R.makeTwistState();
  let lock = null, i = 0, yawAbs = null, yawAt = 0, sep = null, sepAt = 0, ord = null, ordAt = 0, lostAt = 0;
  const swaps = [];
  const end = rows[rows.length - 1][0];
  for (let t = phase + 250; t <= end + 250; t += 250) {
    for (; i < rows.length && rows[i][0] <= t; i++) {
      const [rt, sh, hip, th, yaw] = rows[i];
      if (sh === null) { lostAt = rt; continue; }
      const w = { sh, hip, th }, world = yaw === null ? null : Math.abs(yaw);
      const on = R.torsoTwistStep(st, w, world, rt);
      const o = R.torsoOrder(st, w);
      if (o !== null) { ord = o; ordAt = rt; }
      if (world !== null) { yawAbs = on ? Math.max(world, st.yawDeg) : R.torsoYawGuard(st, w, world); yawAt = rt; }
      sep = sh; sepAt = rt;
    }
    const vote = sep !== null && t - sepAt <= 600 ? (sep >= 0.25 ? "front" : sep <= -0.25 ? "back" : null) : null;
    const acts = engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0,
      yawAbs, yawAt, lostAt, ord: sendOrd ? ord : null, ordAt: sendOrd ? ordAt : 0, lat, lock, profile: false, dualView: true }));
    for (const a of acts) if (a.do === "swap") {
      if (lock === null && a.next === "front") { lock = "front"; continue; }
      if (a.next !== lock) { swaps.push({ next: a.next, t: t + (a.delay || 0) }); lock = a.next; }   // a scheduled send goes out then
    }
  }
  return swaps;
}
/* The body angle of a clip at time t, from its own shoulder order: 0 facing the lens, 180 away, 360 round. */
function thetaOf(rows) {
  const pts0 = rows.filter((r) => r[1] !== null);
  const abs = pts0.map((r) => Math.abs(r[1])).sort((a, b) => b - a);
  const sh0 = abs[Math.floor(abs.length * 0.1)] || abs[0];
  let mn = Infinity, tmn = 0;
  for (const r of pts0) if (r[1] < mn) { mn = r[1]; tmn = r[0]; }
  const pts = pts0.map((r) => { const raw = Math.acos(Math.max(-1, Math.min(1, r[1] / sh0))) * 180 / Math.PI; return [r[0], r[0] <= tmn ? raw : 360 - raw]; });
  return (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) if (pts[k][0] >= t) { const [ta, a] = pts[k - 1], [tb, b] = pts[k]; return a + (b - a) * (t - ta) / (tb - ta); }
    return pts[pts.length - 1][1];
  };
}
/* A swap lands on screen on about the body angle ~110ms before it was sent (the reported clip, read frame by
   frame: sent on ~240 at a 323ms ack, landed on ~212; the outbound sent ~88, landed ~72). */
const LAND_MS = 110;

console.log("\n── §3 the reported session, from its own record ──");
{
  const ticks = S3.ticks;
  let lock = ticks[0].l;
  const replay = (knobs) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
    let l = lock; const sent = [];
    for (const k of ticks) {
      const ord = k.shR === null || k.sep === null ? null : Math.sign(k.sep) * k.shR;
      const acts = engine.step(E.sanitizeOrientSample({ t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - k.ya, lostAt: k.la === null ? 0 : k.t - k.la,
        ord, ordAt: ord === null ? 0 : k.t - (k.ya ?? 0), lock: l, profile: !!k.p, dualView: !!k.d }));
      for (const a of acts) if (a.do === "swap" && a.next !== l) { sent.push({ next: a.next, t: k.t - S3.reveal, sh: k.shR, sep: k.sep }); l = a.next; }
    }
    return sent;
  };
  const recorded = ticks.filter((k) => k.sw.length).map((k) => ({ next: k.sw[0], t: k.t - S3.reveal }));
  const main = replay({ return_side: "0" });
  check("§3.1 main's rule on the record's ticks sends what the session sent: BACK, then FRONT at 2.48s",
    JSON.stringify(main.map((x) => [x.next, x.t])) === JSON.stringify(recorded.map((x) => [x.next, x.t])),
    JSON.stringify({ main, recorded }));
  const chest = replay({});
  const early = chest.find((x) => x.next === "front");
  check("§3.2 the new rule sends the same BACK, and no FRONT while the shoulders still read the back (sep < 0)",
    chest[0].next === "back" && chest[0].t === main[0].t && (!early || early.sep > 0), JSON.stringify(chest));
}

console.log("\n── §3b the second report: the back stayed on the chest (2026-10-04), from its own record ──");
{
  /* The record's ticks, replayed with the lock following the engine's swaps. The session's acks were slow (back 723ms,
     front 505ms) and the turn fast: the chest rule fired on the tick the order read 0.74 (3.96s) - the reading before
     it was 0.12, just under 0.2 - and the front became visible after the 5s window ended. */
  const replay = (knobs) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
    let l = U1.ticks[0].l; const sent = [];
    for (const k of U1.ticks) {
      const acts = engine.step(E.sanitizeOrientSample({ t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - k.ya, lostAt: k.la === null ? 0 : k.t - k.la,
        ord: k.o, ordAt: k.o === null ? 0 : k.t - (k.oa ?? 0), lock: l, profile: !!k.p, dualView: !!k.d }));
      for (const a of acts) if (a.do === "swap" && a.next !== l) { sent.push({ next: a.next, t: k.t - U1.reveal, o: k.o }); l = a.next; }
    }
    return sent;
  };
  const recorded = U1.ticks.filter((k) => k.sw.length).map((k) => [k.sw[0], k.t - U1.reveal]);
  const side = replay({}), main = replay({ return_side: "0" });
  const front = (sw) => sw.find((x) => x.next === "front" && x.t > 0);
  const recFront = recorded.find(([n, t]) => n === "front" && t > 0), recBack = recorded.find(([n, t]) => n === "back" && t > 0);
  check("§3b.1 the record's own decisions: BACK early on the turn, then FRONT on the order 0.74 ~4s in",
    recBack && recFront && recFront[1] > 3800 && recFront[1] < 4100, JSON.stringify(recorded));
  const sf = front(side);
  check("§3b.2 the new rule sends FRONT AT THE SIDE - the first reading past it (0.12), coming from the back",
    !!sf && sf.o >= 0 && sf.o < 0.2, JSON.stringify(side));
  check("§3b.3 ...a tick ahead of where the session sent it (~240ms)", !!sf && recFront && recFront[1] - sf.t >= 200, JSON.stringify({ side, recorded }));
  check("§3b.4 the outbound BACK is the same tick as the record's", side.find((x) => x.next === "back" && x.t > 0)?.t === recorded.find(([n, t]) => n === "back" && t > 0)?.[1], JSON.stringify(side));
}

console.log("\n── §3c the two PEAK sessions of 2026-10-04, from their own records: the back on the chest at the end ──");
{
  /* Both: a fast full turn (~2.5s) on a slow engine (acks 501-807ms). The first (04:55) predates `lat` in the record - its
     room's estimate is taken from its own acks (734, 807: 770). The second (05:55) carries `lt` per tick. Each record's
     FRONT went out on the first reading past the side; the clip showed the back print on the chest for ~0.3s after it. */
  const replay = (rec, knobs, latFor) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
    let l = rec.ticks[0].l; const sent = [];
    for (const k of rec.ticks) {
      const acts = engine.step(E.sanitizeOrientSample({ t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - k.ya, lostAt: k.la === null ? 0 : k.t - k.la,
        ord: k.o, ordAt: k.o === null ? 0 : k.t - (k.oa ?? 0), lat: latFor(k), lock: l, profile: !!k.p, dualView: !!k.d }));
      for (const a of acts) if (a.do === "swap" && a.next !== l) { sent.push({ next: a.next, t: k.t - rec.reveal, o: k.o }); l = a.next; }
    }
    return sent;
  };
  for (const [name, rec, latFor] of [["04:55", PACE["m1-0455"], () => 770], ["05:55", PACE["m2-0555"], (k) => k.lt]]) {
    const recorded = rec.ticks.filter((k) => k.sw.length).map((k) => ({ next: k.sw[0], t: k.t - rec.reveal, o: k.o }));
    const off = replay(rec, { lat_lead: "0", back_gate: "0" }, latFor), on = replay(rec, { back_gate: "0" }, latFor);
    const ret = (sw) => sw.find((x, i) => x.next === "front" && sw.slice(0, i).some((y) => y.next === "back"));
    const recF = ret(recorded), offF = ret(off), onF = ret(on);
    check(`§3c ${name}: the replay without the pace is the record's own decisions (the return on the side reading, o=${recF && recF.o})`,
      !!recF && !!offF && offF.t === recF.t && offF.o === recF.o, JSON.stringify({ recorded, off }));
    check(`§3c ${name}: with the pace the return goes out a reading earlier - ${onF && onF.o} instead of ${recF && recF.o}, ${recF && onF ? recF.t - onF.t : "?"}ms sooner`,
      !!onF && !!recF && recF.t - onF.t >= 200 && onF.o < 0 && onF.o >= -0.85, JSON.stringify(on));
    check(`§3c ${name}: the outbound BACK and every swap before the return are the record's`,
      JSON.stringify(on.slice(0, on.indexOf(onF))) === JSON.stringify(off.slice(0, off.indexOf(offF))), JSON.stringify({ on, off }));
  }
}

console.log("\n── §3e THE LANDING, PROJECTED - two fast 360s and a slow one of 2026-10-05, from their own records ──");
{
  /* "It only fails when I turn fast." 06:09 (a ~2.1s 360) and 05:55 (2026-10-04): the clips show the front reaching the
     body 0.25-0.35s after it passed the side - the print on the chest - and the reading the return should have gone out on
     had already arrived in both. 06:11 is the same shopper turning slowly, reported as working. Each replay feeds the
     record's own samples (the browser's clock - t, the reading ages oa/ya, the engine's pace lt) to a fresh engine, the
     lock following the replay's own swaps; `delay` is kept, as the room would honour it. */
  const replay = (rec, knobs) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs({ back_gate: "0", ...knobs }));
    let l = rec.ticks[0].l; const sent = [];
    for (const k of rec.ticks) {
      const acts = engine.step(E.sanitizeOrientSample({ t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - k.ya, lostAt: k.la === null ? 0 : k.t - k.la,
        ord: k.o, ordAt: k.o === null ? 0 : k.t - (k.oa ?? 0), lat: k.lt, lock: l, profile: !!k.p, dualView: !!k.d }));
      for (const a of acts) if (a.do === "swap" && a.next !== l) { sent.push({ next: a.next, t: k.t - rec.reveal + (a.delay || 0), at: k.t - rec.reveal, o: k.o, delay: a.delay || 0 }); l = a.next; }
    }
    return sent;
  };
  const ret = (sw) => sw.find((x, i) => x.next === "front" && sw.slice(0, i).some((y) => y.next === "back"));
  const recorded = (rec) => ret(rec.ticks.filter((k) => k.sw.length).map((k) => ({ next: k.sw[0], t: k.t - rec.reveal, o: k.o })));
  {
    const rec = PACE["f-0609"], R = recorded(rec), on = ret(replay(rec, {})), off = ret(replay(rec, { lead_project: "0" }));
    check(`§3e.1 06:09 (fast): the record's return went out on the side reading (o=${R && R.o}, ${R && R.t}ms)`, !!R && R.o === 0.04 && R.t === 2617, JSON.stringify(R));
    /* THE LANDING, MEASURED ON THE CLIPS (2026-10-07): this clip, read again with the pose model, has the record's send land at
       ~294 (the back print on the chest); the reading before is still the one, now scheduled - it lands ~282 (§3f). */
    check(`§3e.1 ...the projected rule sends it on the reading before - o=${on && on.o}, ${R && on ? R.t - on.t : "?"}ms sooner`,
      !!on && on.o === -0.72 && on.delay <= 260 && R.t - on.t >= 80, JSON.stringify(on));
    /* The 2026-10-04 rule sat ON the line there: 224 + 0.157 x 297 = 270.7 in this replay, 269.x on the Worker (the record's
       ages are rounded) - it did not fire live. The projection clears it by ~30 degrees: with every reading 40ms younger it
       still fires on that reading. */
    const younger = { ...rec, ticks: rec.ticks.map((k) => ({ ...k, oa: k.oa === null ? null : Math.max(0, k.oa - 40) })) };
    const y40 = ret(replay(younger, {}));
    check("§3e.1 ...with a margin, not on the line: readings 40ms younger fire on the same one", !!y40 && y40.o === -0.72, JSON.stringify(y40));
    check("§3e.1 ...and ?lead_project=0 is the 2026-10-04 rule (on its line: here or one reading later)", !!off && (off.o === -0.72 || off.o === 0.04), JSON.stringify(off));
  }
  {
    const rec = PACE["m2-0555"], R = recorded(rec), on = ret(replay(rec, {})), off = ret(replay(rec, { lead_project: "0" }));
    check(`§3e.2 05:55 (fast): the projection sends the return at ${on && on.t}ms (o=${on && on.o}) - the 2026-10-04 rule ${off && off.t}ms, the record ${R && R.t}ms`,
      /* 2519ms since THE DEEPEST IS THE BACK (2026-10-05 evening; 2379 before it) - the clip put the right moment near 2530. */
      /* 2588ms since RETURN_TARGET 290 (2026-10-05 night, "a tiny bit more"). 2792ms since THE LANDING, MEASURED ON THE CLIPS
         (2026-10-07): the clip read again with the pose model has the record's send (2837) land at ~300 - the back print on the
         chest - and this one at ~292 (§3f); "near 2530" was the old delay's estimate. A reading before the side, sooner. */
      !!on && !!off && !!R && off.t - on.t >= 30 && R.t - on.t >= 30 && on.o >= -0.85 && on.o < 0, JSON.stringify({ on, off, R }));
  }
  {
    const rec = PACE["s-0611"], on = ret(replay(rec, {})), off = ret(replay(rec, { lead_project: "0" }));
    check(`§3e.3 06:11 (slow - reported as working): the return within 150ms of the 2026-10-04 rule (${on && on.t} vs ${off && off.t}ms)`,
      !!on && !!off && Math.abs(on.t - off.t) <= 150, JSON.stringify({ on, off }));
    /* Since the landing delay was recalibrated (LEAD_BASE_MS 350, 2026-10-05 evening) this one lands on a reading - no delay. */
    check("§3e.3 ...and a scheduled send, when there is one, is never longer than a tick", !!on && on.delay >= 0 && on.delay <= 260, JSON.stringify(on));
  }
  {
    /* A ~300 deg/s return (a real production session, the user's recorded 360 at 1.3x, 2026-10-05 06:48): the order went
       -0.98 -> -0.04 between two readings, and the 0.8 snap filter threw the step away - the FRONT waited for the chest
       (0.53, 267ms later) and the back print rode it ~0.4s. A jump from the back that lands short of the chest is a turn. */
    const rec = PACE["x-0648"], R = recorded(rec), on = ret(replay(rec, {}));
    check(`§3e.2b a back-to-side jump in one reading is a step: the return on the side reading (${on && on.o}), ${R && on ? R.t - on.t : "?"}ms before the record's chest one (${R && R.o})`,
      !!on && !!R && on.o === -0.04 && R.o === 0.53 && R.t - on.t >= 200, JSON.stringify({ on, R }));
  }
  {
    /* 17:25 (2026-10-05, "the back disappears too fast, in the middle"): the shoulder scale was learned 2x too wide, the back
       read -0.71 at its deepest, and the projection took the next reading (-0.60) for one coming round past the deepest
       point - the FRONT went out on a body still at ~200 degrees. A projection now needs the back seen DEEP (-0.85). */
    const rec = PACE["b-1725"], R = recorded(rec), on = ret(replay(rec, {}));
    check(`§3e.2c a back never seen deep is left to the side rule: the record sent the return at o=${R && R.o}; now at o=${on && on.o}`,
      !!R && R.o === -0.6 && !!on && on.o >= -0.25 && on.t > R.t, JSON.stringify({ R, on }));
  }
  {
    /* 18:21 / 18:22 (2026-10-05 evening): "the first time it vanished too fast, the second time it was perfect". 18:21's back
       read -0.87 at its deepest; on the order's own scale -0.87 (150, on the way in) -> -0.84 (213, on the way out) was a
       63-degree step at 285 deg/s, and the FRONT was scheduled at the back. Measured against the deepest the leg read
       (THE DEEPEST IS THE BACK), the return goes out at the side - and 18:22, the perfect one, keeps its reading. */
    const bad = PACE["p-1821"], good = PACE["g-1822"];
    const Rb = recorded(bad), onB = ret(replay(bad, {})), Rg = recorded(good), onG = ret(replay(good, {}));
    check(`§3e.2d 18:21: the return no longer goes out at the deepest back (record o=${Rb && Rb.o}) - now at o=${onB && onB.o}`,
      !!Rb && Rb.o <= -0.8 && !!onB && onB.o > -0.5 && onB.t > Rb.t, JSON.stringify({ Rb, onB }));
    /* "Almost perfect, it goes a little before - add a tiny bit" (three sessions, 2026-10-05 night): RETURN_TARGET 290 sends
       18:22's return on the same reading, 85ms later. */
    /* THE LANDING, MEASURED ON THE CLIPS (2026-10-07) sends it ~0.2s later: 18:22's engine held the FEWEST frames of the eight
       measured (its front reached the body ~10ms after the send, the median -0.10s), so on its own clip it lands ~287 instead
       of ~270 (§3f) - the other side of the spread a fixed rule cannot take out, stated. */
    check(`§3e.2e 18:22 (reported perfect): the same reading as the record (o=${Rg && Rg.o}), later (${onG && Rg ? onG.t - Rg.t : "?"}ms)`,
      !!Rg && !!onG && onG.o === Rg.o && onG.t - Rg.t >= 0 && onG.t - Rg.t <= 260, JSON.stringify({ Rg, onG }));
  }
  {
    /* Every outbound BACK is untouched: the projection only reads the BACK leg. */
    for (const name of ["f-0609", "m2-0555", "s-0611", "m1-0455", "m3-1702"]) {
      const on = replay(PACE[name], {}), off = replay(PACE[name], { lead_project: "0" });
      const back = (sw) => JSON.stringify(sw.filter((x) => x.next === "back").slice(0, 1));
      check(`§3e.4 ${name}: the outbound BACK is the same with the projection`, back(on) === back(off), JSON.stringify({ on, off }));
    }
  }
  check("§3e.5 both knob lists carry lead_project", E.ORIENT_KNOB_KEYS.includes("lead_project") && /const ORIENT_KNOB_KEYS = \[[^\]]*"lead_project"/.test(APP));
  check("§3e.6 the room honours a delay only with the swap flow; a newer swap supersedes it; stop() clears it",
    /const sw = SWAP_FLOW && a\.delay > 0 \? delayedSwap\(a\) : maybeSwap\(a\.next, a\.predictive === true\);/.test(APP) &&
    /if \(delayedSwapTimer\) \{ clearTimeout\(delayedSwapTimer\); delayedSwapTimer = null; \}\s*\n\s*const sw = /.test(APP) &&
    /clearInterval\(timer\);\s*\n\s*if \(delayedSwapTimer\) \{ clearTimeout\(delayedSwapTimer\); delayedSwapTimer = null; \}/.test(APP) &&
    /Math\.max\(0, Math\.min\(400, Number\(a\.delay\) \|\| 0\)\)/.test(APP));
}

console.log("\n── §3f THE LANDING, MEASURED ON THE CLIPS - nine of the user's sessions, each against its own clip (2026-10-07, 07:31 added 10-08) ──");
{
  /* "Now the angles are not accurate, it disappears too fast." Each clip (the rendered output) went through the room's own
     pose model frame by frame (test/return-side-clips.json): its shoulder-order curve, and the moment the back print left the
     body. A session's record replayed through the engine gives its FRONT send; moving the observed moment by the same amount
     keeps that session's own engine delay, and the clip's curve says on what body angle the front would have landed. The
     lock follows the replay's own swaps, a scheduled send at its time (THE SWAP FLOW). */
  const CLIPS = JSON.parse(readFileSync(new URL("./return-side-clips.json", import.meta.url), "utf8")).sessions;
  const angleAt = (curve, t, deep) => {
    let a = null, b = null;
    for (const r of curve) { if (r[0] < deep) continue; if (r[0] <= t) a = r; else { b = r; break; } }
    const deg = (o) => (Math.acos(Math.max(-1, Math.min(1, o))) * 180) / Math.PI;
    if (!a) return null;
    const o = b ? a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]) : a[1];
    return 360 - deg(o);
  };
  const frontSend = (rec, knobs = {}) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
    let lock = "front", next = null, back = null;
    for (const k of rec.ticks) {
      const rt = k.t - rec.reveal;
      if (next && rt >= next.at) { lock = next.to; next = null; }
      const acts = engine.step(E.sanitizeOrientSample({ t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - k.ya, lostAt: k.la === null ? 0 : k.t - k.la,
        ord: k.o, ordAt: k.o === null ? 0 : k.t - (k.oa ?? 0), lat: k.lt, lock, profile: !!k.p, dualView: true }));
      for (const a of acts) if (a.do === "swap") {
        const at = rt + (a.delay || 0) + 15;
        if (a.next === "back" && back === null) back = at;
        else if (a.next === "front" && back !== null && rt > back) return at;
        next = { at, to: a.next };
      }
    }
    return null;
  };
  const rows = CLIPS.map((c) => {
    const rec = PACE[c.key], R = c.sent, on = frontSend(rec);
    const was = angleAt(c.curve, c.vanish, c.deep), now = on === null ? null : angleAt(c.curve, c.vanish + (on - R) / 1000, c.deep);
    return { key: c.key, was: Math.round(was), now: now === null ? null : Math.round(now), shift: on === null ? null : on - R };
  });
  console.log("        " + rows.map((r) => `${r.key}: ${r.was} -> ${r.now} (${r.shift >= 0 ? "+" : ""}${r.shift}ms)`).join(", "));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
  const was = rows.map((r) => r.was), now = rows.map((r) => r.now);
  check(`§3f.1 the measurement: as the user saw them, the sessions landed median ${med(was)} - the reports ("too fast", "a little before")`,
    med(was) <= 266 && was.filter((x) => x < 265).length >= 4, JSON.stringify(rows));
  check(`§3f.2 every session's return is still sent, once`, now.every((x) => x !== null), JSON.stringify(rows));
  /* "None past 310" (was 300 for the first eight): the 07:31 session's return can only go out on the first order reading past
     the side, and it was 144ms old with its engine putting the swap ~0.07s AFTER the send - ~308 (§3f.6). */
  check(`§3f.3 the landing now: median ${med(now)} (the side view and just past it), none before 250, at most three past 288 and none past 310`,
    med(now) >= 270 && med(now) <= 285 && now.every((x) => x >= 250 && x <= 310) && now.filter((x) => x > 288).length <= 3, JSON.stringify(rows));
  /* The 13:53 report itself lands only a little later (251 -> ~253): that session's engine held the most frames of the eight
     (~0.21s) and its output stood still for ~0.15s right at ~255 degrees - the spread a fixed rule cannot take out. */
  const d = rows.find((r) => r.key === "d-1353");
  check(`§3f.4 the reported session's return goes out later than it did (+${d.shift}ms), never earlier`, d.shift >= 100 && d.now >= d.was, JSON.stringify(d));
  const fast = rows.filter((r) => r.key === "f-0609" || r.key === "m2-0555");
  check(`§3f.5 the two fast turns that put the back on the chest land earlier than they did (${fast.map((r) => r.was + " -> " + r.now).join(", ")})`,
    fast.every((r) => r.now < r.was), JSON.stringify(fast));
  /* 07:31 (2026-10-08): "almost perfect - the back disappears too early, many frames with nothing on the back". The pose model
     read the shopper's BACK as a full-width FRONT once (+1.0, |yaw| 7, voted twice on the same reading); the early BACK was
     withdrawn on it and the back print was gone at ~210. ONE READING, ONE VOTE and the two-reading withdrawal keep the BACK;
     THE BACK HALF CONFIRMS THE TURN (-0.52, no vote) arms the return, and the FRONT goes out at the side reading. */
  const k = rows.find((r) => r.key === "k-0731");
  check(`§3f.6 the 07:31 mirrored back: the back print stays through the back view - the front lands ${k.was} -> ${k.now}`, k.now >= 270, JSON.stringify(k));
}

console.log("\n── §3d THE BACK WAITS FOR AN ENGINE THAT CAN KEEP UP - the three PEAK sessions of 2026-10-04 ──");
{
  /* The 17:02 session: the return FRONT went out as early as the readings allowed (~245 degrees) and the engine took 1,582ms
     to accept it - the back print on both sides in profile, then on the chest to the end. Each session's gate sees what its
     room knew at the outbound BACK: the median (`lt`, or 734 for 04:55 before it was recorded) and the slowest ack so far. */
  const run3 = (rec, knobs, lat, latHi, stretch = 1) => {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs(knobs));
    let l = rec.ticks[0].l; const sent = [], held = [];
    const t0 = rec.ticks[0].t;
    for (const k of rec.ticks) {
      const t = t0 + (k.t - t0) * stretch, age = (x) => (x ?? 0) * stretch;
      const acts = engine.step(E.sanitizeOrientSample({ t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
        yawAbs: k.y, yawAt: k.y === null ? 0 : t - age(k.ya), lostAt: k.la === null ? 0 : t - age(k.la),
        ord: k.o, ordAt: k.o === null ? 0 : t - age(k.oa), lat: lat(k), latHi, lock: l, profile: !!k.p, dualView: !!k.d }));
      for (const a of acts) {
        if (a.do === "backHeld") held.push(a);
        if (a.do === "swap" && a.next !== l) { sent.push(a.next); l = a.next; }
      }
    }
    return { sent: sent.slice(1), held };   // the first FRONT is the session's acquire
  };
  const SESS = [["04:55", PACE["m1-0455"], () => 734, 734], ["05:55", PACE["m2-0555"], (k) => k.lt, 521], ["17:02", PACE["m3-1702"], (k) => k.lt, 715]];
  for (const [name, rec, lat, latHi] of SESS) {
    const gated = run3(rec, { back_gate: "1" }, lat, latHi), open = run3(rec, { back_gate: "0" }, lat, latHi);
    check(`§3d ${name}: the gate is OFF by default (2026-10-04, the front print on the back) - the default is the open path`,
      JSON.stringify(run3(rec, {}, lat, latHi)) === JSON.stringify(open));
    check(`§3d ${name}: without the gate the session sends BACK then FRONT (what the clip showed)`,
      open.sent[0] === "back" && open.sent.includes("front"), JSON.stringify(open));
    check(`§3d ${name}: with it the BACK is HELD - no back print on the wire for the chest to wear, the front stays on`,
      !gated.sent.includes("back") && gated.held.length >= 1 && gated.held[0].lands > 295, JSON.stringify(gated));
  }
  const rec = PACE["m3-1702"];
  const fast = run3(rec, { back_gate: "1" }, () => 150, 190);
  check("§3d.1 a fast engine (acks ~150ms) sends the BACK on the same turn - the gate only holds what cannot land in time",
    fast.sent[0] === "back" && fast.held.length === 0, JSON.stringify(fast));
  const slowTurn = run3(rec, { back_gate: "1" }, (k) => k.lt, 715, 3);
  check("§3d.2 the same turn three times slower (a ~7.5s 360) gets its BACK on the slow engine",
    slowTurn.sent[0] === "back", JSON.stringify(slowTurn));
  /* THE LATCH: a turn once held stays held until the shopper is square to the lens again - a later BACK on the way round
     (a vote-confirmed one, its average speed decayed) must not land the back print on the chest. */
  {
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs({ back_gate: "1" }));
    const tick = (t, o, vote, lock, yaw = 30) => engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0,
      yawAbs: yaw, yawAt: t, lostAt: 0, ord: o, ordAt: t, lat: 540, latHi: 680, lock, profile: false, dualView: true }));
    const swapsOf = (acts) => acts.filter((a) => a.do === "swap").map((a) => a.next);
    const heldOf = (acts) => acts.filter((a) => a.do === "backHeld");
    tick(0, 1, "front", null, 3); tick(250, 1, "front", "front", 3);
    let held = 0, backs = 0, t = 500;
    for (const [o, v] of [[0.8, "front"], [0.4, null], [-0.3, "back"], [-0.8, "back"], [-1, "back"], [-1, "back"], [-1, "back"]]) {
      const a = tick(t, o, v, "front", 60); held += heldOf(a).length; backs += swapsOf(a).filter((x) => x === "back").length; t += 250;
    }
    /* ...the shopper holds the back 3s (the average speed decays below the bar), then comes round */
    for (let k = 0; k < 12; k++, t += 250) { const a = tick(t, -1, "back", "front", 5); held += heldOf(a).length; backs += swapsOf(a).filter((x) => x === "back").length; }
    for (const o of [-0.5, 0, 0.5]) { const a = tick(t, o, null, "front", 70); held += heldOf(a).length; backs += swapsOf(a).filter((x) => x === "back").length; t += 250; }
    check("§3d.4 a turn once held stays held to the end of the turn - no BACK reaches the wire on the way round", held >= 1 && backs === 0, JSON.stringify({ held, backs }));
    tick(t, 1, "front", "front", 3); t += 250; tick(t, 1, "front", "front", 3); t += 6000;
    /* square on the lens again: a fresh, SLOW turn (~0.7s a reading - a ~7s 360) gets its back on this engine */
    let sent = false;
    for (const [o, v, y] of [[1, "front", 3], [0.9, "front", 20], [0.7, "front", 40], [0.4, null, 60], [0.1, null, 80], [-0.3, "back", 70],
      [-0.7, "back", 40], [-1, "back", 10], [-1, "back", 5], [-1, "back", 5]]) {
      sent = sent || swapsOf(tick(t, o, v, "front", y)).includes("back"); t += 700;
    }
    check("§3d.5 ...and the next turn starts afresh: a slow one gets its BACK", sent);
  }
  const blind = run3(rec, { back_gate: "1" }, () => null, null);
  check("§3d.3 a room that measures no engine is the rule exactly (the back as before)", JSON.stringify(blind) === JSON.stringify(run3(rec, { back_gate: "0" }, () => null, null)));
}

console.log("\n── §4 thirteen real 360s, at four tick phases ──");
{
  const clips = { ...POSES.clips, "s3.mp4 (reported)": S3.rows };
  const res = [];
  for (const [name, rows] of Object.entries(clips)) {
    if (!rows.some((r) => r[1] !== null && r[1] <= -0.25)) continue;   // not a full 360 (no back-facing reading)
    const th = thetaOf(rows);
    for (const phase of [0, 60, 125, 190]) {
      const main = roomRun(rows, { knobs: { return_side: "0" }, phase });
      const chest = roomRun(rows, { phase });
      const noOrd = roomRun(rows, { sendOrd: false, phase });
      const land = (sw) => { const b = sw.find((x) => x.next === "back"); const f = b && sw.find((x) => x.next === "front" && x.t > b.t);
        /* A BACK after the return FRONT, with the chest already round: the back graphic on the chest. */
        const flash = f ? sw.filter((x) => x.next === "back" && x.t > f.t).map((x) => Math.round(th(x.t - LAND_MS))) : [];
        return { back: b ? b.t : null, front: f ? Math.round(th(f.t - LAND_MS)) : null, n: sw.length, flash }; };
      res.push({ name, phase, main: land(main), chest: land(chest), same: JSON.stringify(main) === JSON.stringify(noOrd) });
    }
  }
  const lines = res.map((r) => `${r.name} φ${r.phase}: main FRONT lands ${r.main.front}°, chest ${r.chest.front}° (swaps ${r.main.n}/${r.chest.n}` +
    `${r.main.flash.length || r.chest.flash.length ? `; BACK again after it at ${r.main.flash.join(",") || "-"} / ${r.chest.flash.join(",") || "-"}` : ""})`);
  console.log("        " + lines.join("\n        "));
  check("§4.0 the data is not vacuous: every clip returns FRONT under main's rule", res.every((r) => r.main.front !== null));
  check("§4.1 a room that sends no order is main, swap for swap, on every clip and phase", res.every((r) => r.same));
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mainF = res.map((r) => r.main.front), chestF = res.map((r) => r.chest.front);
  check("§4.2 main's rule lands the return FRONT on a back-facing body: median under 255° - the report",
    med(mainF) < 255 && mainF.filter((x) => x < 255).length > res.length / 2, mainF.join(","));
  /* The few below 255 are the pose model's own snaps: the shoulder order jumps 40-60 degrees between two readings
     tens of ms apart (n2 at 3.39 -> 3.43s: -0.79 -> +0.17), so the angle 110ms before a decision reads a stale
     plateau. The bar is the distribution, not a clip-by-clip minimum the tracker itself does not keep. */
  /* AT THE SIDE since 2026-10-04 (the chest rule alone landed the front on a chest already round - the second report):
     this replay reads every frame, so it catches the side band at its first edge; the room, reading ~240ms apart and
     ~150-200ms old, decides later than this (twin harness, CLAUDE.md §2.25). */
  check("§4.3 the new rule lands it at the side view: median 255° or later, and 85% of runs at 245° or later",
    med(chestF) >= 255 && chestF.filter((x) => x >= 245).length >= res.length * 0.85, chestF.join(","));
  check("§4.4 ...and never with the chest square to the lens (at most 335°)",
    res.every((r) => r.chest.front <= 335), chestF.join(","));
  check("§4.5 the return is never lost: every 360 still sends FRONT", res.every((r) => r.chest.front !== null));
  check("§4.6 the outbound BACK goes out on the same tick as main's", res.every((r) => r.main.back === r.chest.back),
    JSON.stringify(res.filter((r) => r.main.back !== r.chest.back)));
  check("§4.7 no 360 swaps more than it does under main's rule", res.every((r) => r.chest.n <= r.main.n),
    JSON.stringify(res.filter((r) => r.chest.n > r.main.n)));
  /* THE BACK ON THE CHEST: under main's rule, after the return FRONT the |yaw| descent toward the lens reads as a
     pass to the back and predicts BACK for ~1s on a chest facing the camera. The order says which side it is.
     Stated honestly: this replay reads every frame; the whole room reads every ~240ms and did not show it in 20 runs
     of main (CLAUDE.md §2.23). The gate makes it impossible either way. */
  check("§4.8 main's rule sends BACK again after the return FRONT in most runs (the chest shows the back print)",
    res.filter((r) => r.main.flash.length).length > res.length / 2, String(res.filter((r) => r.main.flash.length).length));
  check("§4.9 the new rule never does", res.every((r) => r.chest.flash.length === 0),
    JSON.stringify(res.filter((r) => r.chest.flash.length).map((r) => [r.name, r.phase, r.chest.flash])));
  console.log(`        median landing: main ${med(res.map((r) => r.main.front))}°, chest ${med(res.map((r) => r.chest.front))}° (270 = the side view)`);
}

console.log("\n── §4b the engine's pace: a slow engine's return goes out earlier, and lands where a fast one's does ──");
{
  /* THE LANDING MODEL, per engine. A swap shows on frames the engine renders after ack + switch, which the shopper sees an
     output delay later - so it lands on the body angle at decision + ack - (output delay - switch). LAND_MS (110ms BEFORE
     the decision) is the fast engine's (repeat ack ~190ms); a slower ack moves the landing later by its difference. The
     PEAK tee's acks (TEST records 2026-10-01..04): 323, 505, 743ms - 750 is the slow case. */
  const FAST = 190, SLOW = 750;
  const landAt = (ack) => LAND_MS - (ack - FAST);   // ms BEFORE the decision the swap lands on
  const clips = { ...POSES.clips, "s3.mp4 (reported)": S3.rows };
  const res = [];
  for (const [name, rows] of Object.entries(clips)) {
    if (!rows.some((r) => r[1] !== null && r[1] <= -0.25)) continue;
    const th = thetaOf(rows);
    for (const phase of [0, 60, 125, 190]) {
      const ret = (sw, ack) => { const b = sw.find((x) => x.next === "back"); const f = b && sw.find((x) => x.next === "front" && x.t > b.t);
        return { back: b ? b.t : null, front: f ? Math.round(th(f.t - landAt(ack))) : null, n: sw.length }; };
      const none = roomRun(rows, { phase });
      const fast = roomRun(rows, { phase, lat: FAST });
      const slowOff = roomRun(rows, { phase, lat: SLOW, knobs: { lat_lead: "0", back_gate: "0" } });
      const slowOn = roomRun(rows, { phase, lat: SLOW, knobs: { back_gate: "0" } });
      const fr = (sw) => { const b = sw.find((x) => x.next === "back"); const f = b && sw.find((x) => x.next === "front" && x.t > b.t); return f ? f.t : null; };
      res.push({ name, phase, same: JSON.stringify(none) === JSON.stringify(fast), noLater: fr(fast) !== null && fr(none) !== null && fr(fast) >= fr(none) - 25,   // m5 φ0: scheduled 10ms ahead of the side rule's next tick
        backSame: JSON.stringify(none.filter((x) => x.next === "back").slice(0, 1)) === JSON.stringify(fast.filter((x) => x.next === "back").slice(0, 1)),
        fast: ret(fast, FAST), off: ret(slowOff, SLOW), on: ret(slowOn, SLOW) });
    }
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const F = res.map((r) => r.fast.front), OFF = res.map((r) => r.off.front), ON = res.map((r) => r.on.front);
  console.log(`        landing medians: fast engine ${med(F)}°, slow engine ${med(OFF)}° without the lead, ${med(ON)}° with it (270 = the side)`);
  console.log("        slow, without: " + OFF.join(",") + "\n        slow, with:    " + ON.join(","));
  /* Until 2026-10-07 a fast engine was the side rule exactly. THE LANDING, MEASURED ON THE CLIPS: an engine's swap reaches the
     body on frames from BEFORE the send, the more so the faster it acks (the 2026-09-27 sessions, acks ~200ms: 0.31-0.36s
     before), so the projection now holds a fast engine's return too - never sooner than the side rule, the outbound untouched. */
  check("§4b.1 a fast engine (ack <= 250ms): the return never goes out sooner than a room that sends no pace (within 25ms), the outbound BACK the same",
    res.every((r) => r.noLater && r.backSame), JSON.stringify(res.filter((r) => !(r.noLater && r.backSame)).map((r) => [r.name, r.phase])));
  check("§4b.2 the problem, reproduced: a slow engine lands the return well past the side (median >= 15 degrees later)",
    med(OFF) >= med(F) + 15, `${med(OFF)} vs ${med(F)}`);
  /* Not all the way back to the fast engine's 276: the earliest a return can fire is the first order reading after the
     turn's deepest back point, and on a fast turn the order jumps from the back to the side in one ~250ms reading
     (m3: -0.87 -> -0.16 -> +0.34) - the lead fires on the middle one, a reading ahead of the side rule. Measured
     2026-10-04: 333 -> 307 median. */
  check("§4b.3 with the lead the slow engine's median lands at least 20 degrees back toward the side",
    med(ON) <= med(OFF) - 20 && med(ON) > med(F) - 5, `${med(ON)} vs ${med(OFF)} without, ${med(F)} fast`);
  check("§4b.4 ...never on a back-facing body: 85% of runs at 245 degrees or later, none before 225",
    ON.filter((x) => x >= 245).length >= res.length * 0.85 && ON.every((x) => x >= 225), ON.join(","));
  check("§4b.5 the return is never lost and no run swaps more", res.every((r) => r.on.front !== null && r.on.n <= r.off.n),
    JSON.stringify(res.filter((r) => !(r.on.front !== null && r.on.n <= r.off.n)).map((r) => [r.name, r.phase])));
  check("§4b.6 the outbound BACK is untouched (the same tick with and without the lead)", res.every((r) => r.on.back === r.off.back));
}

console.log("\n── §4c THE LANDING MODEL - where the back and the front land, slow to fast (2026-10-05; the delay measured 2026-10-07) ──");
{
  /* "Make it work well and consistently." The thirteen recorded 360s x 4 tick phases through the real measurement and
     engine, each played at 0.8x, 1x and 1.3x (1.3x is the user's own fast turn: a ~2.1s 360). Counted per speed: where the
     front lands, how long the back print sat on a chest past 300 degrees, front landings before 235 (the front print on the
     back), and any session with more than one BACK and one FRONT (the shirt jumping). */
  const clips = { ...POSES.clips, "s3.mp4 (reported)": S3.rows };
  /* THE DELAY A SWAP LANDS WITH, measured 2026-10-07 (THE LANDING, MEASURED ON THE CLIPS, lib/orient-engine.js): each of eight
     of the user's sessions, its clip through the room's pose model and lined up with its record - [the session's ack median
     (lat), where the front reached the body relative to its send, ms]. Until then this model assumed (lat - 350ms), ~0.2s
     later than any of them but one, and every aim tuned on it landed early on the body ("it disappears too fast"). Each
     turn is counted once per session's delay, so the spread the engine itself adds is in every number below. */
  const DELAYS = [[442, -206], [454, -141], [413, -101], [417, -32], [391, 10], [434, -315], [497, -16], [501, 20]];
  const model = (knobs, speed) => {
    const r = { n: 0, chestMs: [], early: 0, flaps: 0, lands: [] };
    for (const rows0 of Object.values(clips)) {
      const rows = rows0.map((x) => [x[0] / speed, ...x.slice(1)]);
      if (!rows.some((x) => x[1] !== null && x[1] <= -0.25)) continue;
      const th = thetaOf(rows);
      for (const phase of [0, 62, 125, 187]) for (const [lat, L] of DELAYS) {
        const sw = roomRun(rows, { knobs, phase, lat });
        r.n++;
        const B = sw.find((x) => x.next === "back"), F = B && sw.find((x) => x.next === "front" && x.t > B.t);
        if (sw.length > 2) r.flaps++;
        if (!F) continue;
        if (th(F.t + L) < 235) r.early++;
        r.lands.push(th(F.t + L));
        let t300 = null; for (let tt = B.t; tt <= F.t + L; tt += 10) if (th(tt) >= 300) { t300 = tt; break; }
        r.chestMs.push(t300 === null ? 0 : Math.max(0, F.t + L - t300));
      }
    }
    const sum = r.chestMs.reduce((x, y) => x + y, 0), sorted = [...r.chestMs].sort((x, y) => x - y);
    const ls = [...r.lands].sort((x, y) => x - y), pct = (f) => Math.round((100 * ls.filter(f).length) / ls.length);
    return { n: r.n, chestPerTurn: Math.round(sum / r.n), chestP90: sorted[Math.floor(sorted.length * 0.9)] || 0, early: r.early, flaps: r.flaps,
      landMed: Math.round(ls[Math.floor(ls.length / 2)]), landP10: Math.round(ls[Math.floor(ls.length * 0.1)]), landP90: Math.round(ls[Math.floor(ls.length * 0.9)]),
      before255: pct((x) => x < 255), past295: pct((x) => x > 295) };
  };
  const now = { 0.8: model({}, 0.8), 1: model({}, 1), 1.3: model({}, 1.3) };
  const was = { 0.8: model({ lead_project: "0" }, 0.8), 1: model({ lead_project: "0" }, 1), 1.3: model({ lead_project: "0" }, 1.3) };
  console.log(`        now:    0.8x ${JSON.stringify(now[0.8])}\n                1x ${JSON.stringify(now[1])}\n                1.3x ${JSON.stringify(now[1.3])}`);
  console.log(`        2026-10-04 rule: 1x ${JSON.stringify(was[1])}  1.3x ${JSON.stringify(was[1.3])}`);
  check(`§4c.1 the front lands at the side view, at every speed: median ${now[0.8].landMed} / ${now[1].landMed} / ${now[1.3].landMed} degrees`,
    [0.8, 1, 1.3].every((k) => now[k].landMed >= 265 && now[k].landMed <= 285), JSON.stringify(now));
  /* The engine's own spread (+-0.1s between sessions) is in every turn here, so neither tail is zero: what is pinned is that
     both stay small and neither grows - the back still to the lens (before 255) and the back print on a chest (past 295). */
  check(`§4c.2 early and late both rare: before 255 in ${now[0.8].before255} / ${now[1].before255} / ${now[1.3].before255}% of turns, past 295 in ${now[0.8].past295} / ${now[1].past295} / ${now[1.3].past295}%`,
    [0.8, 1, 1.3].every((k) => now[k].before255 <= 30 && now[k].past295 <= 15), JSON.stringify(now));
  check(`§4c.3 never the front print on the back from it: a front landing before 235 in at most 1 turn in 10, at any speed (${now[0.8].early} / ${now[1].early} / ${now[1.3].early} of ${now[1].n})`,
    [0.8, 1, 1.3].every((k) => now[k].early * 10 <= now[k].n), JSON.stringify(now));
  check("§4c.4 the shirt never jumps: one BACK and one FRONT per turn, at every speed", now[0.8].flaps + now[1].flaps + now[1.3].flaps === 0, JSON.stringify(now));
  check(`§4c.5 the back print on a chest past 300: ${now[0.8].chestPerTurn} / ${now[1].chestPerTurn} / ${now[1.3].chestPerTurn}ms a turn, p90 ${now[1.3].chestP90}ms at 1.3x - no more than the 2026-10-04 rule's at the user's fast turn (${was[1.3].chestPerTurn}ms)`,
    now[0.8].chestPerTurn <= 25 && now[1].chestPerTurn <= 25 && now[1.3].chestPerTurn <= was[1.3].chestPerTurn, JSON.stringify({ now, was }));
}

console.log("\n── §4d the room's side of the 18:21 / 18:22 fixes ──");
{
  /* 18:21: the BACK waited 418ms behind a rotation re-drape (a full FRONT re-upload) fired by the turn's first 15 degrees. */
  check("§4d.1 no re-drape in AI Auto dual view - the swaps re-condition (a single-view garment re-drapes as before)",
    /if \(step && typeof currentAngle !== "undefined" && typeof AUTO_ANGLE !== "undefined" && currentAngle === AUTO_ANGLE\) \{\s*\n[^\n]*traceOrient\("redrape-skip"/.test(APP) &&
    /traceOrient\("redrape", \{ reason: step && step\.reason \}\)/.test(APP));
  /* 18:22: the camera went 9:16 -> 512x288 at go-live; the gate's baseline described another picture. */
  check("§4d.2 a frame of another shape starts the shoulder baseline afresh, and drops the stale order",
    /if \(_poseTwist\.aspect && Math\.abs\(_poseTwist\.aspect - aspect\) \/ _poseTwist\.aspect > 0\.02\) \{\s*\n\s*_poseTwist = makeTwistState\(\);\s*\n\s*_poseOrd = null; _poseOrdAt = 0;/.test(APP));
}

console.log("\n── §5 the wiring ──");
{
  check("§5.1 the tick sends the order and its time, typeof-guarded (the replay harnesses run it standalone)",
    /ord: typeof _poseOrd === "number" \? _poseOrd : null, ordAt: typeof _poseOrdAt === "number" \? _poseOrdAt : 0,/.test(APP));
  check("§5.2 the order is published from the same inference as the twist state, only when readable",
    /const ord = torsoOrder\(_poseTwist, widths\);\s*\n\s*if \(ord !== null\) \{ _poseOrd = ord; _poseOrdAt = now; \}/.test(APP));
  check("§5.3 ...and cleared with the pose loop's other readings at a session reset",
    /_poseFacingSep = null; _poseFacingAt = 0; _poseTorsoLostAt = 0;\s*\n\s*_poseOrd = null; _poseOrdAt = 0;/.test(APP));
  check("§5.4 both knob lists carry return_side", E.ORIENT_KNOB_KEYS.includes("return_side") &&
    /const ORIENT_KNOB_KEYS = \[[^\]]*"return_side"/.test(APP));
  const junk = E.sanitizeOrientSample({ ord: "x", ordAt: "y" }), big = E.sanitizeOrientSample({ ord: 9, ordAt: 5 });
  check("§5.5 the sanitiser: junk is 'not measured', a large value is bounded", junk.ord === null && junk.ordAt === 0 && big.ord === 2 && big.ordAt === 5);
  check("§5.6 the TEST record logs the order and its age every tick", /o: typeof s\.ord === "number" \? Math\.round\(s\.ord \* 100\) \/ 100 : null/.test(APP));
  check("§5.7 the engine's constants the trigger reads live inside it (turn-yaw-window runs it standalone)",
    /function makeEarlyTurnTrigger\([\s\S]*?const SIDE_BAND = -0\.7;[\s\S]*?const SIDE_YAW_DEG = 40;/.test(ENGINE_SRC));
  /* THE ENGINE'S PACE. */
  /* ...of the image the next swap sends (EACH IMAGE ITS OWN PACE, 2026-10-09): the front on the back leg. */
  check("§5.8 the tick sends the engine's pace for the image the next swap sends, typeof-guarded",
    /lat: typeof engineAckEstimate === "function" \? engineAckEstimate\(autoOrientation === "back" \? "front" : autoOrientation === "front" \? "back" : undefined\) : null,/.test(APP));
  check("§5.9 ...measured on every REPEAT image write (never a prompt-only write, nor the back's first send), reset with the wire",
    /const ENGINE_PACE_LABELS = new Set\(\["applyGarment", "applyLook"\]\);/.test(APP) &&
    /await send\(\);\s*\n\s*if \(ENGINE_PACE_LABELS\.has\(label\)\) noteEngineAck\(Date\.now\(\) - sentAt, paceKey\);/.test(APP) &&
    /function resetConditionWire\(\) \{\s*\n\s*wireEpoch\+\+;\s*\n\s*_engineAckMs = \[\];[^\n]*\n\s*_engineAckByKey = new Map\(\);/.test(APP));
  check("§5.9b applyGarment keys its ack by the reference's side (its frozen angle)",
    /sendCondition\("applyGarment", \(\) => rtClient\.set\(payload\), \{ paceKey: angleAtStart === "back" \? "back" : "front" \}\);/.test(APP));
  {
    /* THE REPORT (10:53 shorts, record mv0o42ul): the front's own acks 684-709 at connect, the back's swap 597 - the session's
       median read 592 on the back leg, and the FRONT it timed took 721. */
    const ctx = new Function(between(APP, "const ENGINE_PACE_LABELS", "\nfunction sendCondition(") +
      "\nreturn { noteEngineAck, engineAckEstimate };")();
    ctx.noteEngineAck(684, "front"); ctx.noteEngineAck(709, "front"); ctx.noteEngineAck(560, "front"); ctx.noteEngineAck(597, "back"); ctx.noteEngineAck(540, "back");
    const front = ctx.engineAckEstimate("front"), back = ctx.engineAckEstimate("back"), all = ctx.engineAckEstimate(), none = ctx.engineAckEstimate("look");
    check("§5.9c each image its own pace: the front's own median, the back's own, the session's for an image with none yet",
      front === 684 && back === 597 && all === 560 && none === 560, JSON.stringify({ front, back, all, none }));
    const ctx2 = new Function(between(APP, "const ENGINE_PACE_LABELS", "\nfunction sendCondition(") +
      "\nreturn { noteEngineAck, engineAckEstimate };")();
    ctx2.noteEngineAck(430); ctx2.noteEngineAck(450);
    check("§5.9d ...an unkeyed write counts toward the session's alone (the look, a caller without a key)",
      ctx2.engineAckEstimate("front") === 450 && ctx2.engineAckEstimate() === 450);
  }
  {
    const ctx = new Function(between(APP, "const ENGINE_PACE_LABELS", "\nfunction sendCondition(") +
      "\nreturn { noteEngineAck, engineAckEstimate };")();
    const a = ctx.engineAckEstimate(); ctx.noteEngineAck(2058); const b = ctx.engineAckEstimate();
    ctx.noteEngineAck(160); ctx.noteEngineAck(150); const c = ctx.engineAckEstimate(); ctx.noteEngineAck(170); const d = ctx.engineAckEstimate();
    check("§5.10 the estimate: null before any ack, the median of the last three - one slow first send does not hold it up",
      a === null && b === 2058 && c === 160 && d === 160, JSON.stringify([a, b, c, d]));
  }
  const lj = E.sanitizeOrientSample({ lat: "x" }), lb = E.sanitizeOrientSample({ lat: 99999 }), ln = E.sanitizeOrientSample({ lat: -5 });
  check("§5.11 the sanitiser bounds the pace (0-5000ms); junk is 'not measured'", lj.lat === null && lb.lat === 5000 && ln.lat === 0);
  check("§5.12 both knob lists carry lat_lead, and the TEST record logs the pace", E.ORIENT_KNOB_KEYS.includes("lat_lead") &&
    /const ORIENT_KNOB_KEYS = \[[^\]]*"lat_lead"/.test(APP) && /lt: typeof s\.lat === "number" \? s\.lat : null,/.test(APP));
  /* THE BACK GATE. */
  check("§5.13 the tick sends the slowest recent ack too, typeof-guarded, and the record logs it",
    /latHi: typeof engineAckHigh === "function" \? engineAckHigh\(\) : null,/.test(APP) && /lh: typeof s\.latHi === "number" \? s\.latHi : null/.test(APP));
  {
    const ctx = new Function(between(APP, "const ENGINE_PACE_LABELS", "\nfunction sendCondition(") +
      "\nreturn { noteEngineAck, engineAckHigh };")();
    const a = ctx.engineAckHigh(); ctx.noteEngineAck(715); ctx.noteEngineAck(527); const b = ctx.engineAckHigh();
    ctx.noteEngineAck(300); ctx.noteEngineAck(280); const c = ctx.engineAckHigh();
    check("§5.14 engineAckHigh: null before any ack, the slowest of the last three", a === null && b === 715 && c === 527, JSON.stringify([a, b, c]));
  }
  const hj = E.sanitizeOrientSample({ latHi: "x" }), hb = E.sanitizeOrientSample({ latHi: 99999 });
  check("§5.15 the sanitiser bounds latHi like lat; both knob lists carry back_gate", hj.latHi === null && hb.latHi === 5000 &&
    E.ORIENT_KNOB_KEYS.includes("back_gate") && /const ORIENT_KNOB_KEYS = \[[^\]]*"back_gate"/.test(APP));
  check("§5.16 the gate wraps step() from outside (the suites slice step() by text) and is what the engine exports",
    /const gatedStep = \(s\) => gateBack\(s, step\(s\)\);/.test(ENGINE_SRC) && /return \{\s*\n\s*step: gatedStep,/.test(ENGINE_SRC) &&
    ENGINE_SRC.indexOf("function gateBack(") > ENGINE_SRC.indexOf("function armLine()"));
}

console.log(`\n${fails ? `✗ ${fails} failed` : "✓ all passed"}`);
process.exit(fails ? 1 : 0);
