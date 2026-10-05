/* THE TORSO-ONLY TURN - "the back, with my legs where they are" (2026-09-30)
   ─────────────────────────────────────────────────────────────────────────────
   app.js's THE TORSO-ONLY TURN reads a torso turned away over planted legs from the image widths
   of the shoulders and the hips, and - only while that holds - votes BACK where the shoulder order
   abstains and publishes the image angle as |yaw|. The engine (lib/orient-engine.js, main's) is
   untouched. What this suite pins:

   §1 THE RULE, on literals: it learns the shopper's square-on widths first, needs TWIST_READINGS
      in a row, refuses a degenerate torso and a whole-body side view, lets go at once, and is off
      under ?twist=0.
   §2 A WHOLE-BODY TURN NEVER ENGAGES IT: the frame-by-frame readings of twelve recorded full 360s
      (test/torso-twist-poses.json - the room's full model on the shopper's own clips) replayed
      through the real rule: zero activations. And the data is not vacuous: the same readings DO
      fire a rule with a loosened hip bar (negative control).
   §3 WHAT IT BUYS, through the REAL engine: a scripted torso-only turn, sampled the way the
      watcher samples it. With the rule, the engine sends BACK during the hold and FRONT after
      the release; with ?twist=0 (main's measurement) it sends nothing - the report.
   §4 WHERE IT IS WIRED: after the shoulder order, never before it; the yaw from the same
      inference; every call typeof-guarded (the pose loop runs standalone in body-presence-gate).
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DATA = JSON.parse(readFileSync(new URL("./torso-twist-poses.json", import.meta.url), "utf8"));
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

/* The rule, run standalone - the block from its constants to the page's state. */
const BLOCK = between(APP, "const TWIST_SHOULDER_MAX", "let _poseTwist = makeTwistState();");
function loadRule(patch = (s) => s, search = "") {
  return new Function("location", "ORIENT_POSE_FACING_MARGIN",
    patch(BLOCK) + "\nreturn { makeTwistState, torsoTwistStep, torsoYawGuard, TWIST_ENABLED, TWIST_SHOULDER_MAX, TWIST_HIP_MIN, YAW_IMAGE_MARGIN, YAW_GUARD_ENABLED };")(
    { search }, 0.25);
}
const R = loadRule();

console.log("\n── §1 the rule ──");
{
  const s = R.makeTwistState();
  const square = { sh: 0.33, hip: 0.22, th: 0.3 };
  const twist = { sh: 0.03, hip: 0.2, th: 0.3 };
  let t = 0;
  for (let i = 0; i < 4; i++) R.torsoTwistStep(s, square, 3, t += 240);
  check("§1.1 nothing fires before the square-on widths are learned", R.torsoTwistStep(s, twist, 30, t += 240) === false &&
    R.torsoTwistStep(s, twist, 30, t += 240) === false, JSON.stringify(s));
  for (let i = 0; i < 6; i++) R.torsoTwistStep(s, square, 3, t += 240);
  check("§1.2 ...after them, one twisted reading is not enough", R.torsoTwistStep(s, twist, 30, t += 240) === false);
  check("§1.3 ...two in a row are - shoulders at 9% of their width, hips at 91%", R.torsoTwistStep(s, twist, 30, t += 240) === true);
  check("§1.4 ...and the image angle is the shoulders' acos (~85°), well past the world one",
    s.yawDeg > 80 && s.yawDeg < 90, s.yawDeg);
  check("§1.5 one ordinary reading lets go at once", R.torsoTwistStep(s, square, 3, t += 240) === false && s.active === false);
  R.torsoTwistStep(s, twist, 30, t += 240);
  check("§1.6 a WHOLE-BODY side view (hips as narrow as the shoulders) is not a torso-only turn",
    R.torsoTwistStep(s, { sh: 0.03, hip: 0.03, th: 0.3 }, 85, t += 240) === false &&
    R.torsoTwistStep(s, { sh: 0.03, hip: 0.03, th: 0.3 }, 85, t += 240) === false);
  check("§1.7 a degenerate torso (height a fifth of the learned one) is not a pose",
    R.torsoTwistStep(s, { sh: 0.03, hip: 0.2, th: 0.06 }, 30, t += 240) === false &&
    R.torsoTwistStep(s, { sh: 0.03, hip: 0.2, th: 0.06 }, 30, t += 240) === false);
  check("§1.8 no torso reading at all clears it", (R.torsoTwistStep(s, twist, 30, t += 240), R.torsoTwistStep(s, twist, 30, t += 240), R.torsoTwistStep(s, null, null, t += 240)) === false);
  const off = loadRule((x) => x, "?twist=0");
  const s2 = off.makeTwistState();
  for (let i = 0; i < 8; i++) off.torsoTwistStep(s2, square, 3, i * 240);
  check("§1.9 ?twist=0 turns it off (main's measurement)", off.TWIST_ENABLED === false &&
    !off.torsoTwistStep(s2, twist, 30, 5000) && !off.torsoTwistStep(s2, twist, 30, 5240));
  check("§1.10 facing AWAY square-on teaches the same widths (magnitudes, not the labels)",
    (() => { const b = R.makeTwistState(); for (let i = 0; i < 6; i++) R.torsoTwistStep(b, { sh: -0.33, hip: -0.22, th: 0.3 }, 4, i * 240);
      return Math.abs(b.sh0 - 0.33) < 1e-9 && Math.abs(b.hip0 - 0.22) < 1e-9; })());
}

console.log("\n── §2 a whole-body turn never engages it (twelve recorded 360s) ──");
{
  const run = (rule) => {
    let fired = 0, tightest = { hipR: 0 };
    const perClip = {};
    for (const [clip, rows] of Object.entries(DATA.clips)) {
      const s = rule.makeTwistState();
      let n = 0;
      for (const [t, sh, hip, th, yaw] of rows) {
        const on = rule.torsoTwistStep(s, sh === null ? null : { sh, hip, th }, yaw === null ? null : Math.abs(yaw), t);
        if (on) n++;
        if (s.shR !== null && s.shR <= 0.2 && s.hipR > tightest.hipR) tightest = { clip, t, shR: +s.shR.toFixed(2), hipR: +s.hipR.toFixed(2) };
      }
      perClip[clip] = n; fired += n;
    }
    return { fired, tightest, perClip };
  };
  const real = run(R);
  const clips = Object.keys(DATA.clips).length, rows = Object.values(DATA.clips).reduce((a, r) => a + r.length, 0);
  check(`§2.1 ${clips} clips, ${rows} readings: the rule fires 0 times`, clips >= 12 && rows > 600 && real.fired === 0,
    JSON.stringify(real.perClip));
  check(`§2.2 ...with margin: where a whole turn's shoulders were down to 20%, its hips were at most ${Math.round(real.tightest.hipR * 100)}% (the rule needs 70)`,
    real.tightest.hipR > 0 && real.tightest.hipR < R.TWIST_HIP_MIN - 0.15, JSON.stringify(real.tightest));
  const loose = run(loadRule((x) => x.replace("const TWIST_HIP_MIN = 0.7;", "const TWIST_HIP_MIN = 0.3;")
    .replace("const TWIST_READINGS = 2;", "const TWIST_READINGS = 1;")));
  check("§2.3 NEGATIVE CONTROL: the same readings DO fire a rule with the hip bar at 30% and one reading - the data exercises it",
    loose.fired > 0, JSON.stringify(loose.perClip));
}

console.log("\n── §3 through the real engine ──");
{
  /* A torso-only turn as the watcher would sample it (one pose reading per 250ms tick): square on,
     then the shoulders turn away over hips that barely move while the WORLD yaw - compressed, and
     kept coherent with the legs - only reaches 35 degrees; held; released. */
  const at = (t) => {
    const k = t < 2000 ? 0 : t < 2750 ? (t - 2000) / 750 : t < 4750 ? 1 : t < 5500 ? 1 - (t - 4750) / 750 : 0;
    return { sh: 0.33 - 0.3 * k, hip: 0.22 - 0.03 * k, th: 0.3, world: 3 + 32 * k };
  };
  const session = (search) => {
    const rule = loadRule((x) => x, search);
    const st = rule.makeTwistState();
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs({}));
    let lock = null;
    const swaps = [];
    for (let t = 250; t <= 7000; t += 250) {
      const m = at(t);
      const twisting = rule.torsoTwistStep(st, { sh: m.sh, hip: m.hip, th: m.th }, m.world, t);
      const yawAbs = twisting ? Math.max(m.world, st.yawDeg) : m.world;
      const order = m.sh >= 0.25 ? "front" : m.sh <= -0.25 ? "back" : null;
      const vote = order || (twisting ? "back" : null);
      const acts = engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0,
        yawAbs, yawAt: t, lostAt: 0, lock, profile: false, dualView: true }));
      for (const a of acts) if (a.do === "swap") {
        if (lock === null && a.next === "front") { lock = "front"; continue; }   // the acquire: no swap on the wire
        if (a.next !== lock) { swaps.push(`${a.next}@${t}`); lock = a.next; }
      }
    }
    return swaps;
  };
  const withRule = session("");
  const main = session("?twist=0");
  check("§3.1 with the rule: BACK goes out during the torso-only turn", withRule.some((x) => /^back@(2[5-9]|3[0-9])\d\d$/.test(x)), withRule.join(" "));
  check("§3.2 ...and FRONT comes back after the release", /front@(4[89]|5\d|6\d)\d\d/.test(withRule.join(" ")) &&
    withRule[withRule.length - 1].startsWith("front"), withRule.join(" "));
  check("§3.3 with ?twist=0 (main's measurement) the same turn never shows the back - the report",
    !main.some((x) => x.startsWith("back")), main.join(" "));
}

console.log("\n── §5 THE YAW GUARD - a world-depth spike is not a turn ──");
{
  /* Every reading of the twelve recorded 360s, through the real learn + guard, in order. */
  const replay = (rule) => {
    let changed = 0, n = 0, firstMoves = 0;
    for (const rows of Object.values(DATA.clips)) {
      const s = rule.makeTwistState();
      let firstW = null, firstG = null;
      for (const [t, sh, hip, th, yaw] of rows) {
        const w = sh === null ? null : { sh, hip, th };
        const world = yaw === null ? null : Math.abs(yaw);
        rule.torsoTwistStep(s, w, world, t);
        const g = rule.torsoYawGuard(s, w, world);
        if (world !== null) { n++; if (g !== world) changed++; if (firstW === null && world >= 40) firstW = t; if (firstG === null && g >= 40) firstG = t; }
      }
      if (firstW !== firstG) firstMoves++;
    }
    return { n, changed, firstMoves };
  };
  const real = replay(R);
  check(`§5.1 the twelve recorded 360s (${real.n} readings): no turn's first 40-degree crossing moves`, real.n > 600 && real.firstMoves === 0, JSON.stringify(real));
  /* ...and no DECISION moves: every clip sampled as the watcher samples (a 250ms tick reading the
     latest pose reading, the shoulder order as the vote) through main's real engine, the world |yaw|
     vs the guarded one - the whole swap sequence must be the same. (The guard does lower a few
     readings: a noisy 30 at the square BACK, where the shoulders are at full width. That is below
     every threshold that reads it; this check is what says so.) */
  const decisions = (guard) => {
    const out = {};
    for (const [clip, rows] of Object.entries(DATA.clips)) {
      const st = R.makeTwistState(), engine = E.createOrientEngine(E.sanitizeOrientKnobs({}));
      let lock = null, i = 0, last = null; const swaps = [];
      const end = rows[rows.length - 1][0];
      for (let t = 250; t <= end; t += 250) {
        while (i < rows.length && rows[i][0] <= t) {
          const [rt, sh, hip, th, yaw] = rows[i++];
          const w = sh === null ? null : { sh, hip, th }, world = yaw === null ? null : Math.abs(yaw);
          R.torsoTwistStep(st, w, world, rt);
          last = { at: rt, sh, yaw: world === null ? null : (guard ? R.torsoYawGuard(st, w, world) : world) };
        }
        const fresh = last && t - last.at <= 600;
        const vote = fresh && last.sh !== null ? (last.sh >= 0.25 ? "front" : last.sh <= -0.25 ? "back" : null) : null;
        const acts = engine.step(E.sanitizeOrientSample({ t, vote, faceSeen: false, poseVoted: !!vote, profileScore: 0,
          yawAbs: fresh ? last.yaw : null, yawAt: last ? last.at : 0, lostAt: 0, lock, profile: false, dualView: true }));
        for (const a of acts) if (a.do === "swap") { if (lock === null && a.next === "front") { lock = "front"; continue; } if (a.next !== lock) { swaps.push(`${a.next}@${t}`); lock = a.next; } }
      }
      out[clip] = swaps.join(" ");
    }
    return out;
  };
  const dWorld = decisions(false), dGuard = decisions(true);
  const moved = Object.keys(dWorld).filter((k) => dWorld[k] !== dGuard[k]);
  check("§5.1b ...and through main's engine every clip's swap sequence is identical with the guard",
    moved.length === 0 && Object.values(dWorld).filter((v) => /back@/.test(v)).length >= 10,
    moved.map((k) => `${k}: ${dWorld[k]} | guarded ${dGuard[k]}`).join("; ") || JSON.stringify(dWorld));
  const tight = replay(loadRule((x) => x.replace("const YAW_IMAGE_MARGIN = 20;", "const YAW_IMAGE_MARGIN = 0;")));
  check("§5.2 NEGATIVE CONTROL: with no margin the same readings ARE changed - the data exercises the guard", tight.changed > 0, JSON.stringify(tight));
  /* The reported spike: shoulders at full width, world |yaw| 14 -> 41 in two readings. */
  const s = R.makeTwistState();
  for (let i = 0; i < 6; i++) R.torsoTwistStep(s, { sh: 0.37, hip: 0.2, th: 0.3 }, 1, i * 240);
  const spike = R.torsoYawGuard(s, { sh: 0.36, hip: 0.2, th: 0.3 }, 41);
  check("§5.3 the reported spike (41 with the shoulders at 97% width) is published under 40", spike < 40, spike);
  check("§5.4 ...while a real 60-degree turn (shoulders at half width) keeps its world value",
    R.torsoYawGuard(s, { sh: 0.185, hip: 0.1, th: 0.3 }, 60) === 60);
  check("§5.5 before a square-on width is learned, the world |yaw| goes out as is (main)", R.torsoYawGuard(R.makeTwistState(), { sh: 0.36, hip: 0.2, th: 0.3 }, 41) === 41);
  check("§5.6 ...and on a degenerate torso", R.torsoYawGuard(s, { sh: 0.36, hip: 0.2, th: 0.05 }, 41) === 41);
  const off = loadRule((x) => x, "?yaw_guard=0");
  const s2 = off.makeTwistState(); for (let i = 0; i < 6; i++) off.torsoTwistStep(s2, { sh: 0.37, hip: 0.2, th: 0.3 }, 1, i * 240);
  check("§5.7 ?yaw_guard=0 publishes the world |yaw| (main's measurement)", off.YAW_GUARD_ENABLED === false && off.torsoYawGuard(s2, { sh: 0.36, hip: 0.2, th: 0.3 }, 41) === 41);
  const s3 = loadRule((x) => x, "?twist=0"), st3 = s3.makeTwistState();
  for (let i = 0; i < 6; i++) s3.torsoTwistStep(st3, { sh: 0.37, hip: 0.2, th: 0.3 }, 1, i * 240);
  check("§5.8 ?twist=0 turns off only the torso-only rule - the baseline is still learned for the guard", st3.n >= 5 && s3.torsoYawGuard(st3, { sh: 0.36, hip: 0.2, th: 0.3 }, 41) < 40);
  /* Through main's REAL engine: the spike sampled as the watcher would, with and without the guard. */
  const run = (guard) => {
    const st = R.makeTwistState();
    const engine = E.createOrientEngine(E.sanitizeOrientKnobs({}));
    let lock = null; const swaps = [];
    /* The presence gate taught the square-on widths before the fitting (awaitBodyPresence feeds the
       same learner); then the reported spike, 14 -> 41, while the shoulders stay at full width. */
    for (let i = 0; i < 6; i++) R.torsoTwistStep(st, { sh: 0.37, hip: 0.2, th: 0.3 }, 2, -2000 + i * 120);
    const world = (t) => (t < 1000 ? 2 : t < 1250 ? 14 : t < 1500 ? 41 : t < 1750 ? 30 : 4);
    for (let t = 250; t <= 4000; t += 250) {
      const w = { sh: 0.37, hip: 0.2, th: 0.3 };
      R.torsoTwistStep(st, w, world(t), t);
      const yawAbs = guard ? R.torsoYawGuard(st, w, world(t)) : world(t);
      const acts = engine.step(E.sanitizeOrientSample({ t, vote: "front", faceSeen: false, poseVoted: true, profileScore: 0,
        yawAbs, yawAt: t, lostAt: 0, lock, profile: false, dualView: true }));
      for (const a of acts) if (a.do === "swap") { if (lock === null && a.next === "front") { lock = "front"; continue; } if (a.next !== lock) { swaps.push(`${a.next}@${t}`); lock = a.next; } }
    }
    return swaps;
  };
  const unguarded = run(false), guarded = run(true);
  check("§5.9 through main's engine, the reported spike DOES fire the early BACK without the guard (the report)", unguarded.some((x) => x.startsWith("back")), unguarded.join(" "));
  check("§5.10 ...and fires nothing with it", guarded.length === 0, guarded.join(" "));
}

console.log("\n── §4 where it is wired ──");
{
  const watcher = between(APP, "async function classify()", "function skinRatioVote(px)");
  check("§4.1 the shoulder ORDER votes first; the torso-only turn only where it abstains",
    /poseFacingVote\(\{ sep: _poseFacingSep, at: _poseFacingAt, now: Date\.now\(\) \}\) \|\|\s*\(typeof torsoTwistVote === "function"/.test(watcher));
  check("§4.2 ...and on the FaceDetector path only where no face was found",
    /else if \(typeof torsoTwistVote === "function" && torsoTwistVote\(Date\.now\(\)\)\) vote = "back";/.test(watcher) &&
    watcher.indexOf("torsoTwistVote(Date.now())) vote") > watcher.indexOf("faceMissed = true;"));
  const pose = between(APP, "function startPresenceWatcher", "/* ── end body-presence gate ── */");
  const gate = between(APP, "async function awaitBodyPresence(", "\n}\n");
  check("§4.3b the presence gate teaches the square-on widths from its own inferences (learning only, typeof-guarded)",
    /typeof torsoTwistObserve === "function" && typeof bodyContourSignature === "function"/.test(gate) &&
    /if \(sig && Number\.isFinite\(sig\.yaw\)\) torsoTwistObserve\(poseResult, Math\.abs\(sig\.yaw\), Date\.now\(\)\);/.test(gate));
  check("§4.3 the pose loop reads it from the SAME inference, typeof-guarded (body-presence-gate runs this standalone)",
    /typeof torsoTwistObserve === "function" \? torsoTwistObserve\(result, Math\.abs\(sig\.yaw\), now\)/.test(pose));
  check("§4.4 the engine was not touched for it (no twist rule in lib/orient-engine.js)",
    !/twist/i.test(readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("torso-twist: all checks passed.");
