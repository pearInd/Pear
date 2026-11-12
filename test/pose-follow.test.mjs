/* THE TICK WAITS FOR THE READING (fitting-room/app.js, 2026-10-09) - "the back wasn't right at the back, it took time to load".
   The orientation tick (250ms) and the live pose loop (240ms) run on their own timers; at their worst phase every decision
   was taken on a reading ~200ms old, and the outbound BACK went out a tick late, at the side. The tick now waits for the
   loop's next reading when its latest is stale - no inference of its own, the engine untouched.
   §1 the block itself, on a fake clock (sliced from app.js, run standalone)
   §2 the wiring: the tick awaits it in place of POSE_SYNC, the loop wakes it, teardown resets it
   §3 the room's cadence on thirteen recorded 360s through the real measurement and the real engine: the same readings,
      the outbound BACK sooner at a stale phase and never sooner than a fresh phase sends it, the return unchanged */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const POSES = JSON.parse(readFileSync(new URL("./torso-twist-poses.json", import.meta.url), "utf8"));
const E = await import("../lib/orient-engine.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ""}`); }
}
function between(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found: ${to}`);
  return src.slice(a, b);
}

/* A fake clock: timers fire in time order when the test advances it. */
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, seq: id }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && t.seq < next[1].seq))) next = [id, t];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
const BLOCK = between(APP, "/* ── THE TICK WAITS FOR THE READING (2026-10-09)", "/* ── end THE TICK WAITS FOR THE READING ── */");
function load({ search = "", loop = true } = {}) {
  const clock = fakeClock();
  const api = new Function("location", "setTimeout", "clearTimeout", "_poseInferNow",
    BLOCK + "\nreturn { notePoseStep, awaitFreshPose, POSE_FOLLOW_STALE_MS, POSE_FOLLOW_WAIT_MS, POSE_FOLLOW };")(
    { search }, clock.setTimeout, clock.clearTimeout, loop ? () => Promise.resolve() : null);
  return { clock, api };
}
const flush = () => new Promise((r) => setImmediate(r));

console.log("\n── §1 the wait, on a fake clock ──");
{
  const { clock, api } = load();
  check("§1.1 the bars: a reading over 100ms old is waited on, for at most 180ms",
    api.POSE_FOLLOW_STALE_MS === 100 && api.POSE_FOLLOW_WAIT_MS === 180 && api.POSE_FOLLOW === true);
  check("§1.2 no reading from the live loop yet: no wait", api.awaitFreshPose(clock.now) === null);
  clock.advance(1000); api.notePoseStep(clock.now);
  clock.advance(100);
  check("§1.3 a reading 100ms old is fresh enough: no wait", api.awaitFreshPose(clock.now) === null);
  clock.advance(10);
  const w = api.awaitFreshPose(clock.now);
  let woke = false; w.then(() => { woke = true; });
  check("§1.4 a reading 110ms old: the tick waits", w instanceof Promise);
  clock.advance(120); await flush();
  check("§1.5 ...through the loop's quiet spell", !woke);
  api.notePoseStep(clock.now); await flush();
  check("§1.6 the next reading does not resume it inside the inference's own task", !woke);
  clock.advance(0); await flush();
  check("§1.7 ...it resumes on a task of its own, right after", woke);
  /* a loop that never reads again: bounded */
  clock.advance(300);
  const t0 = clock.now; let at = null;
  api.awaitFreshPose(clock.now).then(() => { at = clock.now; });
  clock.advance(179); await flush();
  check("§1.8 a stalled loop holds the tick no longer than 180ms (not at 179)", at === null);
  clock.advance(1); await flush();
  check("§1.9 ...and releases it at 180", at === t0 + 180, String(at - t0));
  /* several waiters (a slow reply overlapping): every one is woken */
  clock.advance(500);
  let n = 0; api.awaitFreshPose(clock.now).then(() => n++); api.awaitFreshPose(clock.now).then(() => n++);
  clock.advance(20); api.notePoseStep(clock.now); clock.advance(0); await flush();
  check("§1.10 every waiting tick is woken by one reading", n === 2);
}
{
  const off = load({ search: "?pose_follow=0" });
  off.api.notePoseStep(0); off.clock.advance(500);
  check("§1.11 ?pose_follow=0: never waits (the free-running pair)", off.api.POSE_FOLLOW === false && off.api.awaitFreshPose(off.clock.now) === null);
  const none = load({ loop: false });
  none.api.notePoseStep(0); none.clock.advance(500);
  check("§1.12 no live pose loop (before the reveal, a replay harness): never waits", none.api.awaitFreshPose(none.clock.now) === null);
}

console.log("\n── §2 the wiring ──");
{
  const tick = between(APP, "  const timer = setInterval(async () => {", "}, ORIENT_SAMPLE_MS);");
  check("§2.1 the tick waits in place of POSE_SYNC (?pose_sync=1 keeps its own path), typeof-guarded, before it measures",
    /\} else if \(typeof awaitFreshPose === "function"\) \{[^]*?const fresh = awaitFreshPose\(\);\s*\n\s*if \(fresh\) await fresh;\s*\n\s*\}/.test(tick) &&
    tick.indexOf("POSE_SYNC_WAIT_MS") < tick.indexOf("awaitFreshPose()") && tick.indexOf("awaitFreshPose()") < tick.indexOf("await classify()"));
  check("§2.2 every finished inference of the live loop wakes it",
    /const runInference = \(\) => inFlightRun \|\| \(inFlightRun = poseLoopStep\(\)\.finally\(\(\) => \{\s*\n\s*inFlightRun = null;\s*\n\s*if \(typeof notePoseStep === "function"\) notePoseStep\(\);/.test(APP));
  const stop = between(APP, "function stopPresenceWatcher() {", "\n}\n");
  check("§2.3 teardown forgets the last reading, so the next session's first ticks wait on nothing", /_poseStepAt = 0;/.test(stop));
  check("§2.4 the block runs no inference and decides nothing",
    !/detectPoseFrame|detectForVideo|_poseInferNow\(\)|decide\.|maybeSwap/.test(BLOCK.replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log("\n── §3 the room's cadence on thirteen recorded 360s ──");
/* The measurement block the room runs on every reading (the learn, the guard, the order). */
const MEAS = between(APP, "const TWIST_SHOULDER_MAX", "let _poseTwist = makeTwistState();");
const R = new Function("location", "ORIENT_POSE_FACING_MARGIN",
  MEAS + "\nreturn { makeTwistState, torsoTwistStep, torsoYawGuard, torsoOrder };")({ search: "" }, 0.25);
const INFER_MS = 35, LOOP_MS = 240, TICK_MS = 250, STALE = 100, WAIT = 180;
/* The room reduced to what the engine sees, at its real cadence: the loop reads the latest camera frame every 240ms (phase
   `lp`), the reading published INFER_MS later; the tick every 250ms (phase `tp`). `follow`: a tick whose latest reading is
   over STALE old waits for the next one (at most WAIT). Returns the swaps with their send times and the readings' ages. */
function cadenceRun(rows, { lp, tp, follow, lat = 450 }) {
  const engine = E.createOrientEngine(E.sanitizeOrientKnobs({}));
  const st = R.makeTwistState();
  const end = rows[rows.length - 1][0];
  const reads = [];
  for (let r = lp; r <= end; r += LOOP_MS) {
    let k = -1; for (let i = 0; i < rows.length && rows[i][0] <= r; i++) k = i;
    if (k >= 0) reads.push({ fin: r + INFER_MS, row: rows[k] });
  }
  let lock = null, ri = 0, yawAbs = null, yawAt = 0, sep = null, sepAt = 0, ord = null, ordAt = 0, lostAt = 0, lastFin = 0;
  const lastRead = reads.length ? reads[reads.length - 1].fin : 0;
  const swaps = [], ages = [], used = [];
  for (let t0 = tp + TICK_MS; t0 <= end + 3 * TICK_MS; t0 += TICK_MS) {   // run on until every reading is in
    let t = t0;
    const judged = !!lastFin;   // the first tick has no reading to call stale - the room's too (_poseStepAt is 0)
    if (follow && lastFin && t - lastFin > STALE) {
      const next = ri < reads.length ? reads[ri].fin : Infinity;
      t = next <= t0 + WAIT ? next + 1 : t0 + WAIT;
    }
    for (; ri < reads.length && reads[ri].fin <= t; ri++) {
      const { fin, row: [, sh, hip, th, yaw] } = reads[ri];
      lastFin = fin; used.push(fin);
      if (sh === null) { lostAt = fin; continue; }
      const w = { sh, hip, th }, world = yaw === null ? null : Math.abs(yaw);
      const on = R.torsoTwistStep(st, w, world, fin);
      const o = R.torsoOrder(st, w);
      if (o !== null) { ord = o; ordAt = fin; }
      if (world !== null) { yawAbs = on ? Math.max(world, st.yawDeg) : R.torsoYawGuard(st, w, world); yawAt = fin; }
      sep = sh; sepAt = fin;
    }
    if (judged && t <= lastRead) ages.push(t - lastFin);   // past the clip's last reading every age grows - not a decision
    const vote = sep !== null && t - sepAt <= 600 ? (sep >= 0.25 ? "front" : sep <= -0.25 ? "back" : null) : null;
    const acts = engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0,
      yawAbs, yawAt, lostAt, ord, ordAt, lat, lock, profile: false, dualView: true }));
    for (const a of acts) if (a.do === "swap") {
      if (lock === null && a.next === "front") { lock = "front"; continue; }
      if (a.next !== lock) { swaps.push({ next: a.next, t: t + (a.delay || 0), on: lastFin }); lock = a.next; }
    }
  }
  return { swaps, ages, used: used.filter((x) => x <= lastRead) };
}
/* The body angle of a clip at time t from its own shoulder order: 0 facing the lens, 180 away, 360 round (return-side's). */
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
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
{
  const res = [];
  for (const [name, rows] of Object.entries(POSES.clips)) {
    if (!rows.some((r) => r[1] !== null && r[1] <= -0.25)) continue;   // a full 360 only
    const th = thetaOf(rows);
    for (const lp of [0, 60, 120, 180]) for (const tp of [0, 50, 100, 150, 200]) {
      const a = cadenceRun(rows, { lp, tp, follow: false }), b = cadenceRun(rows, { lp, tp, follow: true });
      const at = (sw, next, after = -Infinity) => { const x = sw.find((s) => s.next === next && s.t > after); return x ? x.t : null; };
      const ab = at(a.swaps, "back"), bb = at(b.swaps, "back");
      const onA = (a.swaps.find((s) => s.next === "back") || {}).on, onB = (b.swaps.find((s) => s.next === "back") || {}).on;
      const af = ab === null ? null : at(a.swaps, "front", ab), bf = bb === null ? null : at(b.swaps, "front", bb);
      res.push({ name, lp, tp, a, b, ab, bb, af, bf, onA, onB, thAB: ab === null ? null : th(ab), thBB: bb === null ? null : th(bb),
        thAF: af === null ? null : th(af), thBF: bf === null ? null : th(bf),
        sameReads: JSON.stringify(a.used) === JSON.stringify(b.used) });
    }
  }
  const allA = res.flatMap((r) => r.a.ages), allB = res.flatMap((r) => r.b.ages);
  console.log(`  ${res.length} runs (${new Set(res.map((r) => r.name)).size} clips x 4 loop phases x 5 tick phases)`);
  console.log(`  reading age at the decision: free-running median ${med(allA)}ms, p90 ${pct(allA, 0.9)}, max ${Math.max(...allA)} | waiting median ${med(allB)}ms, p90 ${pct(allB, 0.9)}, max ${Math.max(...allB)}`);
  const dB = res.filter((r) => r.thAB !== null && r.thBB !== null).map((r) => r.thAB - r.thBB);
  const dF = res.filter((r) => r.thAF !== null && r.thBF !== null).map((r) => r.thAF - r.thBF);
  console.log(`  outbound BACK sent on a body at: free-running median ${Math.round(med(res.map((r) => r.thAB).filter((x) => x !== null)))}°` +
    ` | waiting ${Math.round(med(res.map((r) => r.thBB).filter((x) => x !== null)))}°; sooner by median ${Math.round(med(dB))}°, p90 ${Math.round(pct(dB, 0.9))}°`);
  console.log(`  return FRONT sent on a body at: free-running median ${Math.round(med(res.map((r) => r.thAF).filter((x) => x !== null)))}°` +
    ` | waiting ${Math.round(med(res.map((r) => r.thBF).filter((x) => x !== null)))}°`);
  check("§3.0 the data is not vacuous: every run sends BACK and then FRONT both ways",
    res.length >= 200 && res.every((r) => r.ab !== null && r.bb !== null && r.af !== null && r.bf !== null),
    JSON.stringify(res.filter((r) => !(r.ab !== null && r.bb !== null && r.af !== null && r.bf !== null)).map((r) => [r.name, r.lp, r.tp])));
  check("§3.1 the engine sees the same readings in the same order (only sooner)", res.every((r) => r.sameReads));
  check("§3.2 the reported phase is real without the wait: decisions on readings over 200ms old", Math.max(...allA) > 200);
  check("§3.3 with the wait no decision is taken on a reading over 135ms old (the bar + one loop step's slack)",
    Math.max(...allB) <= 135, String(Math.max(...allB)));
  check("§3.4 the outbound BACK goes out no later on the body in any run (within 3 degrees)", dB.every((d) => d >= -3),
    JSON.stringify(res.filter((r) => r.thAB - r.thBB < -3).map((r) => [r.name, r.lp, r.tp, Math.round(r.thAB), Math.round(r.thBB)])));
  check("§3.5 ...and sooner where the phase was stale: at least a quarter of the runs by 15 degrees or more",
    dB.filter((d) => d >= 15).length >= dB.length / 4, JSON.stringify({ n: dB.length, ge15: dB.filter((d) => d >= 15).length }));
  /* Sooner, never too soon: BACK is decided on the very reading the free-running room decides it on (or, where that room's
     tick saw two readings at once, the one before it) - only the wait between the reading and the send shrinks. */
  const readOf = (r, fin) => r.b.used.indexOf(fin);
  check("§3.6 the outbound BACK is decided on the same reading as before - no new early fire, only no tick's delay",
    res.every((r) => r.onB === r.onA || readOf(r, r.onB) === readOf(r, r.onA) - 1),
    JSON.stringify(res.filter((r) => !(r.onB === r.onA || readOf(r, r.onB) === readOf(r, r.onA) - 1)).map((r) => [r.name, r.lp, r.tp, r.onA, r.onB])));
  const sendLag = (r, sw, on) => sw.find((s) => s.next === "back").t - on;
  console.log(`  reading -> BACK on the wire: free-running median ${med(res.map((r) => sendLag(r, r.a.swaps, r.onA)))}ms, max ${Math.max(...res.map((r) => sendLag(r, r.a.swaps, r.onA)))}` +
    ` | waiting median ${med(res.map((r) => sendLag(r, r.b.swaps, r.onB)))}ms, max ${Math.max(...res.map((r) => sendLag(r, r.b.swaps, r.onB)))}`);
  check("§3.6b ...and goes out within ~1ms of that reading, where it waited up to a tick", res.every((r) => sendLag(r, r.b.swaps, r.onB) <= 2),
    JSON.stringify(res.filter((r) => sendLag(r, r.b.swaps, r.onB) > 2).map((r) => [r.name, r.lp, r.tp, sendLag(r, r.b.swaps, r.onB)])));
  check("§3.7 the return FRONT is not moved: median within 5 degrees", Math.abs(med(dF)) <= 5, `median shift ${med(dF)}`);
  check("§3.8 no run swaps more", res.every((r) => r.b.swaps.length <= r.a.swaps.length),
    JSON.stringify(res.filter((r) => r.b.swaps.length > r.a.swaps.length).map((r) => [r.name, r.lp, r.tp, r.a.swaps.length, r.b.swaps.length])));
}

console.log(`\n${failed ? "✗" : "✓"} pose-follow: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
