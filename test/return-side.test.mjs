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
   §5 THE WIRING: the sample carries the order (typeof-guarded), both knob lists carry return_side, the
      sanitiser bounds it, the TEST record logs it.
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ENGINE_SRC = readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const POSES = JSON.parse(readFileSync(new URL("./torso-twist-poses.json", import.meta.url), "utf8"));
const S3 = JSON.parse(readFileSync(new URL("./return-side-s3.json", import.meta.url), "utf8"));
const U1 = JSON.parse(readFileSync(new URL("./return-side-u1.json", import.meta.url), "utf8"));
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
  check("§1.1 the return waits for the side: nothing at |yaw| 59 with the shoulders still well on the back side (order -0.51)",
    !out[0].fire && !out[1].fire && !out[2].fire, JSON.stringify(out));
  check("§1.2 ...and FRONT goes out AT THE SIDE - the order -0.12, coming from the back - via the order (2026-10-04)",
    out[3].fire === "front" && out[3].via === "order", JSON.stringify(out[3]));
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
  const w = run(t, [...ret.slice(0, 4), { vote: "back", lock: "front", yawAbs: 30, at: 960, ord: -0.8, ordAt: 960 }]);
  check("§1.8 withdrawn like the other paths: the shopper turns back to face away before any FRONT vote",
    w[4].withdraw === "back", JSON.stringify(w[4]));
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
function roomRun(rows, { knobs = {}, sendOrd = true, phase = 0 } = {}) {
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
      yawAbs, yawAt, lostAt, ord: sendOrd ? ord : null, ordAt: sendOrd ? ordAt : 0, lock, profile: false, dualView: true }));
    for (const a of acts) if (a.do === "swap") {
      if (lock === null && a.next === "front") { lock = "front"; continue; }
      if (a.next !== lock) { swaps.push({ next: a.next, t }); lock = a.next; }
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
  check("§3b.2 the new rule sends FRONT AT THE SIDE - the order -0.19 coming from -0.89",
    !!sf && sf.o >= -0.25 && sf.o < 0, JSON.stringify(side));
  check("§3b.3 ...a tick ahead of where the session sent it (~480ms)", !!sf && recFront && recFront[1] - sf.t >= 400, JSON.stringify({ side, recorded }));
  check("§3b.4 the outbound BACK is the same tick as the record's", side.find((x) => x.next === "back" && x.t > 0)?.t === recorded.find(([n, t]) => n === "back" && t > 0)?.[1], JSON.stringify(side));
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
}

console.log(`\n${fails ? `✗ ${fails} failed` : "✓ all passed"}`);
process.exit(fails ? 1 : 0);
