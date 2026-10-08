/* THE HEAD OUT OF FRAME - "I measured the shorts and the front and back of the shorts got mixed up" (2026-10-08).
   The 11:45 shorts session was framed from the neck down; the pose model reads front from back by the face, and without one
   it read the shopper's back as a full-width front three readings in a row - the early BACK was withdrawn and the FRONT sent
   with the back to the camera. The room now measures whether the head is in the frame (headRoomStep, app.js) and the engine
   counts the side instead of reading the order's sign while it is not (lib/orient-engine.js, THE HEAD OUT OF FRAME).
   ─────────────────────────────────────────────────────────────────────────────
   §1  THE MEASUREMENT: headroom thresholds on literals - sticky in, sticky out.
   §2  TEN RECORDED CLIPS through the room's lite model (test/head-frame.json): the nine with the head in view are never
       marked out; the shorts clip is, from its second reading, to the end.
   §3  THE REPORTED SESSION, from its own record: as sent, the engine withdraws the BACK on the mirrored readings (the
       report); marked headOut, the BACK holds through the back and the FRONT goes out on the way round, at the side.
   §4  SCRIPTED TURNS, headless: a full 360 (mirrored at the back), a look that comes back (bounded by
       HEADLESS_BACK_MAX_MS), a reading without a side |yaw| does not count as a side view, a head-in reading sets the side.
   §5  UNTOUCHED WITHOUT THE FLAG: the sanitiser drops a headOut that is not true; a session with no headOut sends the same
       swaps with or without the new code path; the room sends the flag only when true and records it (ho). */
import { readFileSync } from "node:fs";
const E = await import("../lib/orient-engine.js");
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ENG = readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const FX = JSON.parse(readFileSync(new URL("./head-frame.json", import.meta.url), "utf8"));

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i === -1 || j === -1) throw new Error(`no ${a}`); return src.slice(i, j); };
const headRoomStep = new Function(between(APP, "const HEAD_ROOM_OUT", "let _poseTwist = makeTwistState();") + "\nreturn headRoomStep;")();

console.log("── §1 the measurement ──");
{
  const s = {};
  const w = (top, th = 0.3) => ({ sh: 0.4, hip: 0.3, th, top });
  check("§1.1 one reading under 0.30 is not enough", headRoomStep(s, w(0.06)) === false);
  check("§1.2 ...two in a row mark the head out", headRoomStep(s, w(0.06)) === true);
  check("§1.3 a side view that reads 0.5 keeps it out (the model drops the shoulders when it cannot see above them)",
    headRoomStep(s, w(0.15)) === true && headRoomStep(s, w(0.15)) === true);
  check("§1.4 ...three over 0.60 in a row bring it back in (a shopper who stepped back)",
    headRoomStep(s, w(0.2)) === true && headRoomStep(s, w(0.2)) === true && headRoomStep(s, w(0.2)) === false);
  const t = {};
  check("§1.5 the head at the top edge of a full-body frame (0.35) is never out",
    [0.105, 0.105, 0.105, 0.105].every((y) => headRoomStep(t, w(y)) === false));
  check("§1.6 no reading leaves it as it was", headRoomStep(s, null) === false && headRoomStep({ headOut: true }, null) === true);
}

console.log("\n── §2 ten recorded clips ──");
for (const [clip, rows] of Object.entries(FX.headroom)) {
  const st = {}; const seq = rows.map(([top, th]) => headRoomStep(st, { th, top }) ? 1 : 0);
  if (/^shorts/.test(clip)) {
    check(`§2 ${clip} (neck down): out from the second reading to the end`, seq[0] === 0 && seq.slice(1).every(Boolean), seq.join(""));
  } else {
    check(`§2 ${clip} (head in view): never out`, seq.every((x) => x === 0), seq.join(""));
  }
}

/* A record's ticks through the engine, the lock following its swaps at the send (as the room does). */
function replay(rec, { headOut = false, from = 0 } = {}) {
  const eng = E.createOrientEngine(E.sanitizeOrientKnobs({}));
  let lock = "front"; const sent = [];
  for (const k of rec.ticks) {
    const smp = { t: k.t, vote: k.v, faceSeen: !!k.f, poseVoted: !!k.pv, profileScore: k.ps || 0,
      yawAbs: k.y, yawAt: k.y === null ? 0 : k.t - (k.ya ?? 0), lostAt: k.la === null ? 0 : k.t - k.la,
      ord: k.o, ordAt: k.o === null ? 0 : k.t - (k.oa ?? 0), lat: k.lt, latHi: k.lh, lock, profile: !!k.p, dualView: true,
      headOut: headOut && k.t - rec.reveal >= from };
    for (const a of eng.step(E.sanitizeOrientSample(smp))) {
      if (a.do === "swap" && a.next !== lock) { sent.push({ next: a.next, t: k.t - rec.reveal, o: k.o, y: k.y }); lock = a.next; }
    }
  }
  return sent;
}

console.log("\n── §3 the reported session, from its own record ──");
{
  const rec = FX.record;
  const asSent = replay(rec), hl = replay(rec, { headOut: true });
  check("§3.1 as sent: BACK at the side (1.72s), then FRONT on the mirrored 'front' readings (2.23s, the back to the camera) - the report",
    asSent[0] && asSent[0].next === "back" && asSent[0].t === 1718 && asSent[1] && asSent[1].next === "front" && asSent[1].t === 2231,
    JSON.stringify(asSent));
  check("§3.2 marked headOut: the same BACK at 1.72s",
    hl[0] && hl[0].next === "back" && hl[0].t === 1718, JSON.stringify(hl));
  const front = hl.find((x) => x.next === "front");
  check("§3.3 ...no FRONT while the back faces the camera (the readings 0.87, 1.05, 1.19 at 1.98-2.50s)",
    !front || front.t > 2500, JSON.stringify(hl));
  check("§3.4 ...the FRONT goes out on the way round, at the side view (|order| 0.17, |yaw| 83 at 2.69s)",
    front && front.t === 2690 && Math.abs(front.o) <= 0.25 && front.y >= 45, JSON.stringify(front));
  check("§3.5 ...and nothing after it: two swaps for the whole turn", hl.length === 2, JSON.stringify(hl));
}

console.log("\n── §4 scripted turns, headless ──");
const run = (readings) => {
  const eng = E.createOrientEngine(E.sanitizeOrientKnobs({}));
  let lock = "front"; const sent = [];
  for (const r of readings) {
    const smp = { t: r.t, vote: Math.abs(r.o) >= 0.25 ? (r.o > 0 ? "front" : "back") : null, poseVoted: Math.abs(r.o) >= 0.25,
      faceSeen: false, profileScore: 0, yawAbs: r.y, yawAt: r.t - 20, lostAt: 0, ord: r.o, ordAt: r.t - 20, lat: 600, latHi: 700,
      lock, profile: false, dualView: true, headOut: r.ho !== false };
    for (const a of eng.step(E.sanitizeOrientSample(smp))) if (a.do === "swap" && a.next !== lock) { sent.push({ next: a.next, t: r.t }); lock = a.next; }
  }
  return sent;
};
const seq = (pairs, t0 = 1000, dt = 250) => pairs.map(([o, y], i) => ({ t: t0 + i * dt, o, y }));
{
  /* A full 360 with the head out: the model reads the BACK as the front (+) and, on the way round, the front as the back (-). */
  const turn = seq([[1, 3], [0.9, 10], [0.6, 40], [0.15, 78], [-0.1, 86], [0.85, 25], [1.05, 12], [1.1, 8], [0.9, 15], [0.4, 60],
    [0.1, 85], [-0.6, 40], [-0.9, 15], [-1, 5], [-1, 4], [-1, 3]]);
  const s = run(turn);
  const back = s.find((x) => x.next === "back"), front = s.find((x) => x.next === "front");
  check("§4.1 a headless 360: BACK on the way out, held through the mirrored back, FRONT at the second side view",
    back && back.t <= 2000 && front && front.t >= 3250 && front.t <= 3500 && s.length === 2, JSON.stringify(s));
  /* A look to the side that comes back and stays: headless, it reads like a turn - bounded by HEADLESS_BACK_MAX_MS. */
  const look = seq([[1, 3], [0.9, 10], [0.5, 45], [0.12, 80], [0.6, 40], [0.95, 10], [1, 5], [1, 4], [1, 4], [1, 3], [1, 3], [1, 3],
    [1, 3], [1, 3], [1, 3], [1, 3], [1, 3], [1, 3], [1, 3], [1, 3], [1, 3], [1, 3]]);
  const l = run(look);
  const lf = l.find((x) => x.next === "front"), lb = l.find((x) => x.next === "back");
  check("§4.2 a headless look that comes back: the FRONT is back within HEADLESS_BACK_MAX_MS (2.5s) of leaving the side",
    !lb || (lf && lf.t - 2000 <= 2500 + 300), JSON.stringify(l));
  /* A reading near zero without a side |yaw| (a noisy frame, square to the lens) is not a side view. */
  const noisy = run(seq([[1, 3], [0.9, 5], [0.1, 8], [0.9, 6], [1, 4], [1, 3], [1, 3], [1, 3]]));
  check("§4.3 an order near zero on a |yaw| of 8 does not count as a side view - nothing is sent", noisy.length === 0, JSON.stringify(noisy));
  /* The head comes into view at the back: its own sign sets the side, the count follows it. */
  const stepIn = [...seq([[1, 3], [0.9, 10], [0.5, 45], [0.12, 80]]),
    ...seq([[-0.9, 15], [-1, 5], [-1, 4]], 2000).map((r) => ({ ...r, ho: false })),
    ...seq([[0.1, 85], [-0.9, 20], [-1, 6], [-1, 4], [-1, 3]], 2750)];
  const si = run(stepIn);
  const sif = si.find((x) => x.next === "front");
  check("§4.4 a head-in reading at the back sets the side; the next side view headless brings the FRONT",
    si[0] && si[0].next === "back" && sif && sif.t >= 2750, JSON.stringify(si));
}

console.log("\n── §5 untouched without the flag ──");
{
  check("§5.1 the sanitiser keeps headOut only when it is true",
    E.sanitizeOrientSample({ headOut: true }).headOut === true && !("headOut" in E.sanitizeOrientSample({ headOut: "true" })) &&
      !("headOut" in E.sanitizeOrientSample({ headOut: false })) && !("headOut" in E.sanitizeOrientSample({})));
  const rec = FX.record;
  const a = replay(rec), b = replay(rec, { headOut: false });
  check("§5.2 a session that never sends it swaps exactly as before", JSON.stringify(a) === JSON.stringify(b));
  check("§5.3 step() calls the rule typeof-guarded (suites slice it out alone - CLAUDE.md §2.6/§2.7)",
    /function step\(s\) \{\n\s*\/\*[^*]*\*\/\n\s*if \(typeof headlessReading === "function"\) s = headlessReading\(s\);/.test(ENG));
  check("§5.4 the room sends it only when true, and a TEST record carries it (ho)",
    /\.\.\.\(typeof _poseHeadOut !== "undefined" && _poseHeadOut === true \? \{ headOut: true \} : \{\}\),/.test(APP) &&
      /ho: s\.headOut === true \? 1 : undefined,/.test(APP));
  check("§5.5 a new session starts with the head in view (the reset clears it)",
    /_poseOrd = null; _poseOrdAt = 0;\n\s*if \(typeof _poseHeadOut !== "undefined"\) _poseHeadOut = false;/.test(APP));
}

console.log(fails === 0 ? "\nhead-frame: OK" : `\nhead-frame: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
