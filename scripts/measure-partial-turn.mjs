#!/usr/bin/env node
/* Measure the partial turn ("look to the side and come back") on the recorded 360s - CLAUDE.md §7.23.
   Plays each recorded clip up to PEAK degrees and then backwards to square, through the real browser measurement and the real
   orientation engine, and compares the engine in a git ref (the rule BEFORE) with the working tree (the rule NOW).

     node scripts/measure-partial-turn.mjs                       summary at 100 degrees
     node scripts/measure-partial-turn.mjs --peak 90 --hold 800  a look held 0.8s at the side
     node scripts/measure-partial-turn.mjs --clip p1.mp4 --trace every tick of one clip (phase 0)
     node scripts/measure-partial-turn.mjs --base 189a9ce        compare against another commit (default: HEAD)

   Exit 1 when a full 360 decides differently from the base, or when the partial turn got worse. Models the DECISION on recorded
   pose readings - it does not render anything and spends no credits (CLAUDE.md §7.1 still wants a real-engine session). */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1] ?? true; };
const PEAK = +arg("peak", 100), HOLD = +arg("hold", 0), BASE = arg("base", "HEAD"), CLIP = arg("clip", null), TRACE = process.argv.includes("--trace");
const KNOBS = { early_turn: "50", early_turn_slow: "50" };   // the room's own defaults (app.js ORIENT_KNOB_DEFAULTS)
const PHASES = [0, 60, 125, 190];                            // where the 250ms tick falls against the pose readings

const POSES = JSON.parse(readFileSync(join(ROOT, "test/torso-twist-poses.json"), "utf8"));
const APP = readFileSync(join(ROOT, "fitting-room/app.js"), "utf8").replace(/\r\n/g, "\n");
const i0 = APP.indexOf("const TWIST_SHOULDER_MAX"), j0 = APP.indexOf("let _poseTwist = makeTwistState();", i0);
const R = new Function("location", "ORIENT_POSE_FACING_MARGIN", APP.slice(i0, j0) +
  "\nreturn { makeTwistState, torsoTwistStep, torsoYawGuard, torsoOrder };")({ search: "" }, 0.25);

const tmp = mkdtempSync(join(tmpdir(), "pear-measure-"));
const baseFile = join(tmp, "orient-engine.base.mjs");
writeFileSync(baseFile, execFileSync("git", ["show", `${BASE}:lib/orient-engine.js`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }));
const BASE_E = await import(pathToFileURL(baseFile).href);
const NOW_E = await import(pathToFileURL(join(ROOT, "lib/orient-engine.js")).href);
if (readFileSync(baseFile, "utf8").replace(/\r\n/g, "\n") === readFileSync(join(ROOT, "lib/orient-engine.js"), "utf8").replace(/\r\n/g, "\n"))
  console.log(`! the engine in ${BASE} is the same as the working tree - nothing to compare. Use --base <older commit>.\n`);

/* The clip played to PEAK degrees (the first reading whose shoulder order is at or under cos PEAK), held, then the same readings backwards. */
function lookAndBack(rows) {
  const abs = rows.filter((r) => r[1] !== null).map((r) => Math.abs(r[1])).sort((a, b) => b - a), sq = abs[Math.floor(abs.length * 0.1)];
  const k = rows.findIndex((r) => r[1] !== null && r[1] / sq <= Math.cos(PEAK * Math.PI / 180));
  if (k < 2) return null;
  const fwd = rows.slice(0, k + 1), out = fwd.map((r) => r.slice());
  let t = fwd[k][0];
  for (let h = 66; h <= HOLD; h += 66) out.push([t + h, ...fwd[k].slice(1)]);
  t = out[out.length - 1][0];
  for (let j = k - 1; j >= 0; j--) { t += fwd[j + 1][0] - fwd[j][0]; out.push([t, ...fwd[j].slice(1)]); }
  for (let h = 66; h <= 1500; h += 66) out.push([t + h, ...fwd[0].slice(1)]);
  return out;
}

/* One session: the pose readings in order, a tick every 250ms, the lock moving as the room's maybeSwap does (1.5s cooldown). */
function run(E, rows, phase) {
  const engine = E.createOrientEngine(E.sanitizeOrientKnobs(KNOBS));
  const st = R.makeTwistState();
  let lock = null, i = 0, yawAbs = null, yawAt = 0, sep = null, sepAt = 0, ord = null, ordAt = 0, lostAt = 0, lastSwapAt = -1e9, lastPred = false;
  const ticks = [];
  for (let t = phase + 250; t <= rows[rows.length - 1][0] + 250; t += 250) {
    for (; i < rows.length && rows[i][0] <= t; i++) {
      const [rt, sh, hip, th, yaw] = rows[i];
      if (sh === null) { lostAt = rt; continue; }
      const w = { sh, hip, th }, world = yaw === null ? null : Math.abs(yaw);
      const on = R.torsoTwistStep(st, w, world, rt), o = R.torsoOrder(st, w);
      if (o !== null) { ord = o; ordAt = rt; }
      if (world !== null) { yawAbs = on ? Math.max(world, st.yawDeg) : R.torsoYawGuard(st, w, world); yawAt = rt; }
      sep = sh; sepAt = rt;
    }
    const vote = sep !== null && t - sepAt <= 600 ? (sep >= 0.25 ? "front" : sep <= -0.25 ? "back" : null) : null;
    const acts = engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0, yawAbs, yawAt, lostAt, ord, ordAt, lat: 430, lock, profile: false, dualView: true }));
    for (const a of acts) {
      if (a.do === "resetSwapCooldown") lastSwapAt = -1e9;
      if (a.do !== "swap") continue;
      if (lock === null && a.next === "front") { lock = "front"; continue; }
      if (a.next === lock) continue;
      if (t - lastSwapAt < 1500 && !(a.next === "front" && lastPred)) continue;
      lock = a.next; lastSwapAt = t; lastPred = a.predictive === true;
    }
    ticks.push({ t, ord, lock });
  }
  return ticks;
}
const angle = (o) => (o === null ? null : Math.round(Math.acos(Math.max(-1, Math.min(1, o))) * 180 / Math.PI));
/* Milliseconds the BACK stays on the wire while the chest faces the lens (order 0.5+) after the look went to the side (order under 0.3). */
function backOnChest(ticks) { let low = false, ms = 0; for (const x of ticks) { if (x.ord !== null && x.ord < 0.3) low = true; if (low && x.ord >= 0.5 && x.lock === "back") ms += 250; } return ms; }
const had360 = (rows) => rows.some((r) => r[1] !== null && r[1] <= -0.25);

if (TRACE) {
  const name = CLIP || "m1.mp4", rows = POSES.clips[name];
  if (!rows) { console.error("no such clip. Clips: " + Object.keys(POSES.clips).join(", ")); process.exit(2); }
  const p = lookAndBack(rows), a = run(BASE_E, p, 0), b = run(NOW_E, p, 0);
  console.log(`${name}: to ${PEAK}° and back, hold ${HOLD}ms, phase 0 - one row per 250ms tick\n`);
  console.log(" time   angle   before   now");
  a.forEach((x, i) => { if (x.ord === null) return; const flag = x.ord >= 0.5 && x.lock === "back" ? "  <- before: BACK on a chest facing the lens" : ""; console.log(`${String(x.t).padStart(5)}   ${String(angle(x.ord)).padStart(4)}°   ${String(x.lock).padEnd(6)}   ${b[i].lock}${flag}`); });
  process.exit(0);
}

const names = Object.keys(POSES.clips).filter((n) => !CLIP || n === CLIP);
let runs = 0, bad = 0, worse = 0, same360 = 0, n360 = 0; const before = [], now = [];
console.log(`partial turn: to ${PEAK}° and back, hold ${HOLD}ms - ${names.length} recorded clips x ${PHASES.length} tick phases, before = ${BASE}, now = working tree\n`);
console.log("BACK on a chest facing the lens, ms - the four tick phases 0/60/125/190\n\nclip        before             now");
for (const name of names) {
  const p = lookAndBack(POSES.clips[name]); if (!p) continue;
  const a = PHASES.map((ph) => backOnChest(run(BASE_E, p, ph))), b = PHASES.map((ph) => backOnChest(run(NOW_E, p, ph)));
  a.forEach((x, i) => { runs++; before.push(x); now.push(b[i]); if (b[i] > x) worse++; });
  console.log(`${name.padEnd(10)}  ${a.join("/").padEnd(18)} ${b.join("/")}`);
}
for (const name of Object.keys(POSES.clips)) {
  const rows = POSES.clips[name]; if (!had360(rows)) continue;
  for (const ph of PHASES) { n360++; if (JSON.stringify(run(BASE_E, rows, ph).map((x) => x.lock)) === JSON.stringify(run(NOW_E, rows, ph).map((x) => x.lock))) same360++; }
}
const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / (a.length || 1));
console.log(`\n${runs} runs. BACK on a chest facing the lens: before avg ${avg(before)}ms (max ${Math.max(...before)}), now avg ${avg(now)}ms (max ${Math.max(...now)})`);
console.log(`runs with none: before ${before.filter((x) => !x).length}, now ${now.filter((x) => !x).length} | runs where now is worse than before: ${worse}`);
console.log(`full 360s: ${same360}/${n360} decide tick by tick exactly as before`);
if (same360 !== n360 || worse) { console.log("\nFAIL"); process.exit(1); }
console.log("\nOK");
