/* ORIENTATION REPLAY - the watcher, run for real on a simulated clock (used by
   test/orient-engine.test.mjs; not a suite on its own - no .test in the name).
   ─────────────────────────────────────────────────────────────────────────────
   Runs createOrientationWatcher() from an app.js SOURCE in a sandbox, driven by a
   discrete-event simulation: a fake clock, the 250ms setInterval, setTimeout, an
   applyActive() that takes simulated time (so a swap skips ticks the way a real upload
   does), and a scripted body rotation - full 360s at 45-260 deg/s, there-and-back,
   partial turns, a held side view, starting turned away, noise, dropped votes and
   edge-on torso loss - under the URL knobs. classify() is replaced by the scripted
   measurement; everything downstream of it is the shipped code. Every externally
   visible effect is recorded in order: each apply with the lock and pose it carried,
   the hold, the turn flag, toasts, the selector repaint, and the state after each event.

   The SAME harness runs the pre-move app.js (the decision inline) and the current one
   (the decision behind openOrientChannel(), wired here to the REAL lib/orient-engine.js
   through its sanitisers and a JSON round trip), so a byte-identical log is the proof
   that moving the decision changed nothing. `linkMs` delays each reply on the simulated
   clock, like a real round trip. */
import { createHash } from "node:crypto";

/* ── the scripted world ───────────────────────────────────────────────────── */
function prng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* A trajectory is a list of segments over body angle θ (0 = facing the lens, 180 = back). */
export const TRAJECTORIES = (() => {
  const T = [];
  const full = (speed, holdStart = 1500, holdBack = 1200) => [
    { hold: 0, ms: holdStart }, { from: 0, to: 180, speed }, { hold: 180, ms: holdBack },
    { from: 180, to: 360, speed }, { hold: 360, ms: 1500 }];
  for (const sp of [45, 72, 90, 120, 180, 260]) T.push({ name: `360@${sp}`, segs: full(sp) });
  for (const sp of [60, 90, 150]) T.push({ name: `there-and-back@${sp}`, segs: [
    { hold: 0, ms: 1200 }, { from: 0, to: 180, speed: sp }, { hold: 180, ms: 2000 }, { from: 180, to: 0, speed: sp }, { hold: 0, ms: 1500 }] });
  for (const peak of [45, 60, 75, 90, 105, 135]) T.push({ name: `partial-${peak}`, segs: [
    { hold: 0, ms: 1000 }, { from: 0, to: peak, speed: 90 }, { hold: peak, ms: 1500 }, { from: peak, to: 0, speed: 90 }, { hold: 0, ms: 1500 }] });
  T.push({ name: "side-hold-long", segs: [{ hold: 0, ms: 800 }, { from: 0, to: 90, speed: 80 }, { hold: 90, ms: 4000 }, { from: 90, to: 0, speed: 80 }, { hold: 0, ms: 1200 }] });
  T.push({ name: "starts-back", segs: [{ hold: 180, ms: 2500 }, { from: 180, to: 360, speed: 90 }, { hold: 360, ms: 2000 }] });
  T.push({ name: "wiggle-45-80", segs: [{ hold: 0, ms: 600 },
    ...Array.from({ length: 6 }, (_, i) => ({ from: i % 2 ? 80 : 45, to: i % 2 ? 45 : 80, speed: 70 })), { hold: 45, ms: 800 }, { from: 45, to: 0, speed: 60 }, { hold: 0, ms: 1000 }] });
  T.push({ name: "double-360", segs: [...full(120, 800, 600), { from: 360, to: 540, speed: 120 }, { hold: 540, ms: 900 }, { from: 540, to: 720, speed: 120 }, { hold: 720, ms: 1500 }] });
  T.push({ name: "slow-creep", segs: [{ hold: 0, ms: 500 }, { from: 0, to: 180, speed: 25 }, { hold: 180, ms: 1500 }, { from: 180, to: 0, speed: 25 }, { hold: 0, ms: 1000 }] });
  T.push({ name: "abort-at-120", segs: [{ hold: 0, ms: 900 }, { from: 0, to: 120, speed: 110 }, { from: 120, to: 0, speed: 110 }, { hold: 0, ms: 2000 }] });
  return T;
})();

function thetaAt(segs, t) {
  let t0 = 0, last = 0;
  for (const s of segs) {
    const dur = s.ms ?? (Math.abs(s.to - s.from) / s.speed) * 1000;
    if (t < t0 + dur) {
      if (s.ms !== undefined) return s.hold;
      return s.from + (s.to - s.from) * ((t - t0) / dur);
    }
    t0 += dur; last = s.ms !== undefined ? s.hold : s.to;
  }
  return last;
}
function durationOf(segs) { return segs.reduce((a, s) => a + (s.ms ?? (Math.abs(s.to - s.from) / s.speed) * 1000), 0); }

/* Measurements from θ. `face` picks the FaceDetector path; otherwise the shoulder-order
   path (poseVoted). Noise, misses and edge-on dropout are PRNG-driven. */
function measure(theta, rnd, env) {
  const a = ((theta % 360) + 360) % 360;
  const facing = Math.cos(a * Math.PI / 180);            // +1 facing, -1 away
  const side = Math.abs(Math.sin(a * Math.PI / 180));    // 1 at edge-on
  let vote = null, faceSeen = false, poseVoted = false;
  const noisy = rnd() < env.noise;
  if (env.face) {
    if (facing > 0.55 && rnd() > env.miss) { vote = "front"; faceSeen = true; }
    else if (facing < -0.65) vote = rnd() < 0.85 ? "back" : null;
  } else {
    const sep = facing * 0.9 + (rnd() - 0.5) * 0.2;
    if (Math.abs(sep) >= 0.25) { vote = sep > 0 ? "front" : "back"; poseVoted = true; }
    else if (facing > 0.9) vote = "front";
    else if (facing < -0.9) vote = "back";
  }
  if (noisy) vote = rnd() < 0.5 ? null : (vote === "front" ? "back" : "front");
  const profileScore = faceSeen ? 0 : Math.max(0, Math.min(1, side * 1.1 + (rnd() - 0.5) * 0.3));
  const yawAbs = Math.asin(Math.min(1, side)) * 180 / Math.PI + (rnd() - 0.5) * env.yawJitter;
  const lost = side > env.lossAt && rnd() < 0.8;
  return { vote, faceSeen, poseVoted, profileScore, yawAbs: Math.max(0, Math.min(90, yawAbs)), lost, sep: facing };
}

/* ── the sandbox ──────────────────────────────────────────────────────────── */
function between(src, a, b, inclusiveEnd = false) {
  const i = src.indexOf(a); if (i === -1) throw new Error("marker not found: " + a);
  const j = src.indexOf(b, i); if (j === -1) throw new Error("end marker not found: " + b);
  return src.slice(i, inclusiveEnd ? j + b.length : j);
}
function sliceWatcher(app) {
  const start = app.indexOf("const ORIENT_SAMPLE_MS");
  const w = app.indexOf("function createOrientationWatcher() {");
  const end = app.indexOf("\n}\n", w) + 3;
  if (start < 0 || w < 0) throw new Error("watcher markers");
  let s = app.slice(start, end);
  /* Record the effects the tick causes, keeping the real functions. */
  const wrap = (sig, rec) => {
    if (s.indexOf(sig) === -1) throw new Error("wrap target missing: " + sig);
    s = s.replace(sig, sig + " " + rec);
  };
  wrap("function orientHoldBegin(reason) {", "__rec('holdBegin', reason);");
  wrap("function orientHoldPromote(reason) {", "__rec('holdPromote', reason);");
  wrap("function orientHoldEnd(reason) {", "__rec('holdEnd', reason);");
  wrap("function orientTurnMark(turning, now = Date.now()) {", "__rec('turnMark', !!turning);");
  /* classify() -> the scripted measurement (it is unchanged by the move; see the header). */
  const cls = "async function classify() {";
  if (s.indexOf(cls) === -1) throw new Error("classify missing");
  s = s.replace(cls, `async function classify() {
    const m = __measure();
    lastFaceSeen = m.faceSeen; lastPoseVoted = m.poseVoted; lastProfileScore = m.profileScore;
    lastSkinRatio = null; lastConfidence = m.vote ? 1 : 0;
    return m.vote;
  }
  async function __unused_classify() {`);
  return s;
}

const GLOBAL_NAMES = ["location", "document", "MediaStream", "localStream", "activeItem", "galleryOf", "distinctBackOf",
  "pinActiveGarmentBlobs", "garmentBlobIfWarm", "garmentBlobCached", "blobLooksFlat", "_assetBlobCache", "applyActive",
  "toast", "renderPerspectiveSelector", "abbrevImg", "isLive", "wireBusy", "vtonState", "sessionElapsedMs",
  "LIVE_DURATION_MS", "AUTO_ANGLE", "PENDING_MODE", "FaceDetector", "stillCoversEnabled", "orientFadeCapture",
  "orientFadeShow", "orientFadeReveal", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "console",
  "__rec", "__measure", "Date", "requestAnimationFrame", "cancelAnimationFrame", "performance", "window", "__env", "__extra",
  "openOrientChannel"];

export function makeWorld(appSource, extraSource = "") {
  const body = sliceWatcher(appSource) + "\n" + extraSource + `
    return {
      createOrientationWatcher,
      get autoOrientation() { return __env.autoOrientation; },
      setPose(p) {
        if (p.yawAbs !== undefined) { _torsoYawAbs = p.yawAbs; _torsoYawAt = p.yawAt; }
        if (p.lostAt !== undefined) _poseTorsoLostAt = p.lostAt;
        if (p.sep !== undefined) { _poseFacingSep = p.sep; _poseFacingAt = p.sepAt; }
      },
      holdActive: () => _orientHoldActive,
      turnSince: () => _orientTurnSince,
    };`;
  /* autoOrientation / autoProfile / currentAngle / isGarmentApplied / lastSentImageRef are
     module lets in app.js; here they live on __env and are exposed as sloppy-mode globals
     via a with() scope. */
  return new Function(...GLOBAL_NAMES, "with (__env) {\n" + body + "\n}");
}

/* Run ONE scenario. Returns the event lines. */
export async function runScenario(factory, scen, engine) {
  const rnd = prng(scen.seed);
  const lines = [];
  let now = 1_000_000;
  const timers = [];               // { at, fn, id, interval }
  let timerId = 1;
  const FakeDate = class extends Date { static now() { return now; } };
  const env = {
    autoOrientation: null, autoProfile: false, currentAngle: scen.dualView ? "auto" : "front",
    isGarmentApplied: true, lastSentImageRef: null,
  };
  const rec = (op, arg) => lines.push(`${now - 1_000_000} ${op} ${arg === undefined ? "" : JSON.stringify(arg)}`);
  const pendingApplies = [];
  const blob = { size: 1 };
  const api = factory(
    { search: scen.search },                                   // location
    { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
        play: () => Promise.resolve(), pause() {}, srcObject: null, width: 0, height: 0 }) },
    class { constructor() {} },                                 // MediaStream
    { getVideoTracks: () => [{}] },                             // localStream
    { img: "https://cdn.test/front.jpg" },                      // activeItem
    () => ({ front: "https://cdn.test/front.jpg" }),            // galleryOf
    () => (scen.hasBack ? "https://cdn.test/back.jpg" : undefined),
    () => {},                                                    // pinActiveGarmentBlobs
    () => blob,                                                  // garmentBlobIfWarm
    async (url) => (scen.brokenBack && /back/.test(url) ? null : blob),   // garmentBlobCached
    async () => !!scen.flatBack,                                 // blobLooksFlat
    new Map(),                                                   // _assetBlobCache
    () => {                                                      // applyActive: takes simulated time
      rec("apply", { o: env.autoOrientation, p: env.autoProfile });
      return new Promise((res) => pendingApplies.push({ at: now + scen.applyMs, res }));
    },
    (msg) => rec("toast", msg),
    () => rec("renderSelector"),
    (u) => u,                                                    // abbrevImg
    () => scen.live,                                             // isLive
    () => ((Math.imul(Math.floor(now / 50) ^ scen.seed, 2654435761) >>> 0) % 1000) < scen.wireBusy * 1000,   // wireBusy: a function of TIME, never of call count
    () => (env.autoOrientation === null ? "PENDING_MODE" : env.autoOrientation === "back" ? "BACK_MODE" : "FRONT_MODE"),
    () => now - 1_000_000,                                       // sessionElapsedMs
    5000, "auto", "PENDING_MODE",
    scen.face ? class { constructor() {} detect() { return Promise.resolve([]); } } : undefined,
    () => false, () => {}, () => {}, () => {},                  // stillCovers, orientFade*
    (fn, ms) => { const id = timerId++; timers.push({ at: now + (ms || 0), fn, id }); return id; },
    (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    (fn, ms) => { const id = timerId++; timers.push({ at: now + ms, fn, id, interval: ms }); return id; },
    (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    { log() {}, warn() {}, error() {}, info() {}, debug() {}, group() {}, groupEnd() {} },
    rec,
    () => scen.nextMeasure,
    FakeDate, () => 0, () => {}, { now: () => now }, {}, env, scen.extra || {},
    engine ? () => {                      // the orientation link, in-process: the REAL engine behind a JSON round trip
      const q = new URLSearchParams(scen.search), knobs = {};
      for (const k of engine.ORIENT_KNOB_KEYS) if (q.get(k) !== null) knobs[k] = q.get(k);
      const e = engine.createOrientEngine(engine.sanitizeOrientKnobs(knobs));
      return { step: (smp) => {
        const out = JSON.parse(JSON.stringify(e.step(engine.sanitizeOrientSample(JSON.parse(JSON.stringify(smp))))));
        if (!scen.linkMs) return Promise.resolve(out);
        /* A round trip on the simulated clock: the reply lands linkMs later, like the real link's. */
        return new Promise((res) => pendingApplies.push({ at: now + scen.linkMs, res: () => res(out) }));
      }, close() {} };
    } : undefined,
  );
  const watcher = api.createOrientationWatcher();
  rec("armed", env.autoOrientation);
  const total = durationOf(scen.traj.segs);
  let lastPoseAt = -Infinity;
  const flush = () => new Promise((r) => setImmediate(r));   // drains every microtask chain
  let prevState = "";
  while (now - 1_000_000 < total) {
    /* next event: the earliest live timer, or the next pose-loop publication (every 240ms) */
    const t = now - 1_000_000;
    const nextPose = lastPoseAt + scen.poseMs;
    const live = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at || a.id - b.id);
    const nextApply = pendingApplies.length ? Math.min(...pendingApplies.map((p) => p.at)) : Infinity;
    const cand = Math.min(live.length ? live[0].at : Infinity, 1_000_000 + Math.max(nextPose, t), nextApply);
    now = Math.max(now, cand);
    const tt = now - 1_000_000;
    /* 1. applies that finished */
    for (let i = pendingApplies.length - 1; i >= 0; i--) {
      if (pendingApplies[i].at <= now) { const p = pendingApplies.splice(i, 1)[0]; p.res(); }
    }
    await flush();
    /* 2. the pose loop publishes a reading */
    if (tt >= nextPose) {
      lastPoseAt = tt;
      const m = measure(thetaAt(scen.traj.segs, tt), rnd, scen);
      if (m.lost) api.setPose({ lostAt: now, sep: null, sepAt: now });
      else api.setPose({ yawAbs: m.yawAbs, yawAt: now, sep: m.sep, sepAt: now });
    }
    /* 3. due timers */
    const due = timers.filter((x) => !x.dead && x.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
    for (const d of due) {
      if (d.interval) d.at += d.interval; else d.dead = true;
      if (d.interval) scen.nextMeasure = measure(thetaAt(scen.traj.segs, tt), rnd, scen);
      d.fn();
      await flush();
    }
    const state = `${env.autoOrientation}|${env.autoProfile}|${api.holdActive()}|${api.turnSince() > 0}`;
    if (state !== prevState) { rec("state", state); prevState = state; }
  }
  watcher && watcher.stop && watcher.stop();
  await flush();
  rec("stopped", `${env.autoOrientation}|${api.holdActive()}|${api.turnSince() > 0}`);
  return lines;
}

/* ── the corpus: trajectories × environments × URL knobs × seeds ───────────── */
export const KNOBS = ["", "?early_turn=0", "?early_turn=30", "?early_turn=50&early_turn_return=0", "?early_turn_speed=0",
  "?early_turn_slow=0", "?early_turn_loss=0", "?pose_pass=0", "?post_peak=0", "?predict_back=0", "?predict_back=1",
  "?pose_facing=0", "?early_turn_loss=35&early_turn_speed=90", "?early_turn=0&predict_back=1&post_peak=0"];
export function* corpus({ seeds = [1, 2] } = {}) {
  const ENVS = [
    { name: "pose", face: false, noise: 0.03, miss: 0, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 450, wireBusy: 0.05, live: true, dualView: true, hasBack: true },
    { name: "face", face: true, noise: 0.03, miss: 0.1, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 450, wireBusy: 0.05, live: true, dualView: true, hasBack: true },
    { name: "noisy-slowapply", face: false, noise: 0.12, miss: 0, yawJitter: 10, lossAt: 0.85, poseMs: 120, applyMs: 1400, wireBusy: 0.2, live: true, dualView: true, hasBack: true },
    { name: "single-view", face: false, noise: 0.03, miss: 0, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 450, wireBusy: 0.05, live: true, dualView: false, hasBack: false },
    { name: "broken-back", face: false, noise: 0.03, miss: 0, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 450, wireBusy: 0.05, live: true, dualView: true, hasBack: true, brokenBack: true },
    { name: "flat-back", face: true, noise: 0.03, miss: 0.05, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 300, wireBusy: 0, live: true, dualView: true, hasBack: true, flatBack: true },
    { name: "not-live", face: false, noise: 0.03, miss: 0, yawJitter: 4, lossAt: 0.93, poseMs: 240, applyMs: 450, wireBusy: 0, live: false, dualView: true, hasBack: true },
  ];
  for (const traj of TRAJECTORIES) for (const env of ENVS) for (const search of KNOBS) for (const seed of seeds) {
    yield { ...env, traj, search, seed: seed * 7919 + traj.name.length * 31 + search.length, key: `${traj.name}|${env.name}|${search}|${seed}` };
  }
}

export async function runCorpus(appSource, { extraSource = "", seeds, filter, engine, linkMs = 0 } = {}) {
  const factories = new Map();
  const hash = createHash("sha256");
  const perScenario = new Map();
  let n = 0, events = 0;
  for (const scen of corpus({ seeds })) {
    if (filter && !filter(scen)) continue;
    let f = factories.get(scen.search);
    if (!f) { f = makeWorld(appSource, extraSource); factories.set(scen.search, f); }
    const lines = await runScenario(f, { ...scen, linkMs }, engine);
    const text = lines.join("\n");
    perScenario.set(scen.key, text);
    hash.update(scen.key + "\n" + text + "\n");
    n++; events += lines.length;
  }
  return { hash: hash.digest("hex"), scenarios: n, events, perScenario };
}
