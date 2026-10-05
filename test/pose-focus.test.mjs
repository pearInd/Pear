/* A SHOPPER STANDING FAR BACK IN A WIDE, BUSY FRAME - "it has to work whatever the lighting"
   (2026-09-29; see POSE FOCUS WINDOW above poseFocusWindow() in fitting-room/app.js). A backlit
   living-room session found no body in 24 seconds; replayed through the model, the whole 16:9
   frame shrinks the figure too small for the detector, and a square window around it finds it.
   ─────────────────────────────────────────────────────────────────────────────
   §1  WHILE THE WHOLE FRAME FINDS A BODY NOTHING CHANGES - the same result object, the video itself
       handed to the model, no window, ever.
   §2  TWO EMPTY WHOLE FRAMES OPEN A WINDOW - a square the frame's height, centred - and its
       landmarks come back in WHOLE-FRAME coordinates: y untouched, x and z scaled, worldLandmarks
       (metric) untouched.
   §3  THE WINDOW FOLLOWS THE HIPS, and gives the whole frame back after three empty windows.
   §4  NOT FOUND IN THE CENTRE: the sides are tried, then the whole frame again.
   §5  A PORTRAIT FRAME NEVER OPENS A WINDOW.
   §6  ONE inference per call, timestamps strictly increasing; the room loads the FULL model. */
import { readFileSync } from "node:fs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8");
const a = APP.indexOf("let _lastPoseTimestamp = 0;");
const b = APP.indexOf("/* The loaded PoseLandmarker, as a memoized PROMISE");
check("the pose block is where the test expects it", a !== -1 && b > a);
const BLOCK = APP.slice(a, b);

function load() {
  const drawn = [];
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (...args) => drawn.push(args) }) }) };
  let now = 1000;
  const performance = { now: () => now };
  const api = new Function("document", "performance", "ORIENT_DEBUG",
    BLOCK + "\nreturn { detectPoseFrame, state: () => ({ focus: _poseFocus, misses: _poseFullMisses }) };")(document, performance, false);
  return { ...api, drawn, tick: () => { now += 250; } };
}
const pose = (hipX = 0.5, vis = 0.99) => {
  const L = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0.1, visibility: vis }));
  L[11] = { x: hipX + 0.1, y: 0.3, z: -0.05, visibility: vis }; L[12] = { x: hipX - 0.1, y: 0.3, z: 0.05, visibility: vis };
  L[23] = { x: hipX + 0.06, y: 0.6, z: -0.02, visibility: vis }; L[24] = { x: hipX - 0.06, y: 0.6, z: 0.02, visibility: vis };
  return L;
};
const WORLD = [Array.from({ length: 33 }, () => ({ x: 0.01, y: 0.02, z: 0.03, visibility: 0.9 }))];
function detector(script) {
  const calls = [];
  return { calls, detectForVideo(src, ts) { calls.push({ src, ts }); const s = script(calls.length, src); return s ? { landmarks: [s], worldLandmarks: WORLD } : { landmarks: [], worldLandmarks: [] }; } };
}
const VIDEO = { videoWidth: 512, videoHeight: 288 };

console.log("── §1 the whole frame finds the body: nothing changes ──");
{
  const r = load();
  const det = detector(() => pose(0.5));
  const outs = [];
  for (let i = 0; i < 6; i++) { outs.push(r.detectPoseFrame(det, VIDEO)); r.tick(); }
  check("every inference is handed the video itself", det.calls.every((c) => c.src === VIDEO));
  check("...and the model's own result comes back untouched (same object)", outs.every((o) => o.landmarks[0][11].x === 0.6 && o.worldLandmarks === WORLD));
  check("...no window is ever opened, nothing is drawn", r.state().focus === null && r.drawn.length === 0);
}

console.log("\n── §2 two empty whole frames open a window; its landmarks come back whole-frame ──");
{
  const r = load();
  /* The model finds nobody in the whole frame; in a window it finds a body centred in it. */
  const det = detector((n, src) => (src === VIDEO ? null : pose(0.5)));
  const o1 = r.detectPoseFrame(det, VIDEO), o2 = r.detectPoseFrame(det, VIDEO);
  check("the first two empty whole frames are returned as they are (empty)", o1.landmarks.length === 0 && o2.landmarks.length === 0);
  check("...and after the second one a window is armed, centred", r.state().focus && r.state().focus.cx === 0.5);
  const o3 = r.detectPoseFrame(det, VIDEO);
  const last = det.calls[det.calls.length - 1];
  check("the next inference is handed the window, not the video", last.src !== VIDEO && last.src.width === 288 && last.src.height === 288);
  const d = r.drawn[r.drawn.length - 1];
  check("the window is a square the frame's height, centred on the frame (x 112..400)",
    d[0] === VIDEO && d[1] === 112 && d[2] === 0 && d[3] === 288 && d[4] === 288, JSON.stringify(d.slice(1)));
  const k = 288 / 512, off = 112 / 512;
  const L = o3.landmarks[0];
  check("x comes back in whole-frame coordinates (0.6 in the window -> off + 0.6 * side/width)", Math.abs(L[11].x - (off + 0.6 * k)) < 1e-9);
  check("y is untouched (the window is the frame's full height)", L[11].y === 0.3 && L[23].y === 0.6);
  check("the image-space z scales with x", Math.abs(L[11].z - -0.05 * k) < 1e-9);
  check("visibility and the metric worldLandmarks are untouched", L[11].visibility === 0.99 && o3.worldLandmarks === WORLD);
}

console.log("\n── §3 the window follows the hips, and hands back after three empty windows ──");
{
  const r = load();
  let bodyAt = 0.5, gone = false;
  /* The body sits at `bodyAt` in the WHOLE frame; a window sees it at its own coordinate. */
  const det = detector((n, src) => {
    if (src === VIDEO || gone) return null;
    const sx = r.drawn[r.drawn.length - 1][1];
    return pose((bodyAt * 512 - sx) / 288);
  });
  r.detectPoseFrame(det, VIDEO); r.detectPoseFrame(det, VIDEO);   // two empty whole frames
  r.detectPoseFrame(det, VIDEO);                                     // found, centred
  bodyAt = 0.62;
  const o = r.detectPoseFrame(det, VIDEO);
  check("a shopper who moved is still found, at their whole-frame place", Math.abs((o.landmarks[0][23].x + o.landmarks[0][24].x) / 2 - 0.62) < 1e-6);
  check("...and the window re-centres on their hips", Math.abs(r.state().focus.cx - 0.62) < 1e-6);
  r.detectPoseFrame(det, VIDEO);
  const sx = r.drawn[r.drawn.length - 1][1];
  check("...so the next window is drawn around them", sx === Math.round(0.62 * 512 - 144), String(sx));
  gone = true;
  r.detectPoseFrame(det, VIDEO); r.detectPoseFrame(det, VIDEO);
  check("two empty windows keep the window (a turn or a blink is not an absence)", r.state().focus !== null);
  r.detectPoseFrame(det, VIDEO);
  check("the third hands back to the whole frame", r.state().focus === null);
  const n = det.calls.length;
  r.detectPoseFrame(det, VIDEO);
  check("...which the next inference uses", det.calls[n].src === VIDEO);
}

console.log("\n── §4 not in the centre: the sides are tried, then the whole frame ──");
{
  const r = load();
  const det = detector(() => null);
  r.detectPoseFrame(det, VIDEO); r.detectPoseFrame(det, VIDEO);
  const centres = [];
  for (let i = 0; i < 3; i++) { r.detectPoseFrame(det, VIDEO); centres.push(r.drawn[r.drawn.length - 1][1]); }
  check("centre, then the left third, then the right third", JSON.stringify(centres) === JSON.stringify([112, 10, 214]), JSON.stringify(centres));
  check("...then back to the whole frame", r.state().focus === null);
}

console.log("\n── §5 a portrait frame never opens a window ──");
{
  const r = load();
  const PORTRAIT = { videoWidth: 720, videoHeight: 1280 };
  const det = detector(() => null);
  for (let i = 0; i < 6; i++) r.detectPoseFrame(det, PORTRAIT);
  check("six empty portrait frames: no window, the video every time", r.state().focus === null && det.calls.every((c) => c.src === PORTRAIT));
}

console.log("\n── §6 one inference per call, timestamps strictly increasing; the full model ──");
{
  const r = load();
  const det = detector((n, src) => (src === VIDEO ? null : pose(0.5)));
  for (let i = 0; i < 5; i++) r.detectPoseFrame(det, VIDEO);   // performance.now() never moves here
  check("exactly one detectForVideo() per detectPoseFrame()", det.calls.length === 5);
  check("...with strictly increasing timestamps even on the same millisecond", det.calls.every((c, i) => i === 0 || c.ts > det.calls[i - 1].ts));
  /* 2026-09-30: main's LITE model again - the full one changed the timing of full turns through
     the whole room (see POSE_MODEL_URL's note); the window is the lighting fix. */
  check("the room loads main's LITE pose model, not full", /pose_landmarker_lite\/float16\/1\/pose_landmarker_lite\.task/.test(CFG) && !/pose_landmarker_full/.test(CFG.replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log(fails === 0 ? "\npose-focus: OK" : `\npose-focus: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
