/* CONTINUOUS BODY TOPOLOGY - "I turned 90 degrees and my shirt stretched with me".

   REPORTED FAILURE: the garment fits correctly while the shopper faces the camera, and is
   then DEFORMED over whatever they do next. Turn side-on and the 0-degree drape is smeared
   across a profile silhouette; put a cushion under the shirt and the same drape inflates
   over it. The cut warps, the print skews, the fabric reads as painted on.

   ROOT CAUSE - the body was established ONCE and never re-asked. awaitBodyPresence() is a
   GATE: it answers "is anyone there?" at go-live and then it is finished. Nothing after it
   ever asked what SHAPE that body is, so the render stayed conditioned on the frame it was
   born in. A diffusion model handed a body that no longer matches its conditioning does the
   cheapest available thing - it deforms the result it already has.

   THE FIX IS TWO HALVES, AND NEITHER WORKS ALONE:
     · THE PROMPT states the split - the garment is EXACT and STATIC, the body is CURRENT
       and per-frame. image-first.test.mjs §1 owns that wording.
     · THE RUNTIME makes it true. A constant prompt with the reference already on the wire
       means applyGarment() dispatches NOTHING (its own no-op skip), so text alone could
       never have made the model re-read the body. This suite owns that half: a monitor
       that measures the live torso every tick and forces a real re-conditioning dispatch
       when the body has genuinely moved away from the shape the current render was drawn
       against.

   WHAT THIS SUITE PINS, and why each is a distinct way for the fix to rot:
     §1  the geometry - yaw, pitch, depth and the profile box, including the properties
         that make them usable at all (0 means square-on; everything is scale-invariant,
         so stepping toward the camera is not a change of shape);
     §2  the visibility bar - measurable is deliberately a LOWER bar than billable, or the
         monitor goes blind during the exact turn it exists to track;
     §3  the decision - what counts as a shift, on which axis, at what threshold, and the
         one place the reason string is honestly imprecise;
     §4  the tracker - baseline semantics (the CONDITIONED shape, never the previous
         frame), the cooldown, and that a suppressed shift is not a forgotten one;
     §5  the fallback - a body that goes unreadable mid-turn HOLDS the last valid fit and
         resumes from it, rather than re-deriving a fit from a frame with no body in it;
     §6  the wiring - one detector call per tick feeding both consumers, a dispatch that
         genuinely reaches the wire, the invariance of the garment half, and teardown;
     §7  the throttling - the rate limits that keep this monitor from flooding the
         signaling channel, and the gate that lets a shift be DEFERRED without being
         forgotten. Added after the monitor's first revision produced
         "rtClient.set לא הגיב" at go-live; apply-timeout.test.mjs owns the recovery.

   Sibling suites: body-presence-gate.test.mjs owns the go-live gate and the presence half
   of the same loop; side-profile.test.mjs owns the orientation watcher's own edge-on
   channel, which is a DIFFERENT signal (a 96px pixel heuristic, no landmarks) reaching a
   different decision (which garment ASSET to show). */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}"`);
  return SRC.slice(start, end);
}

/* The real geometry and the real tracker, executed - not a re-implementation. The slice
   runs from the section banner to the detector loader that follows it. */
const code = extract("/* The four joints that define the torso.", "/* The loaded PoseLandmarker");
const sandbox = {
  POSE_LANDMARK: Object.freeze({
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
  }),
  BODY_TRACK_MIN_VISIBILITY: CONFIG.BODY_TRACK_MIN_VISIBILITY,
  BODY_ROTATION_DELTA_DEG: CONFIG.BODY_ROTATION_DELTA_DEG,
  BODY_VOLUME_DELTA: CONFIG.BODY_VOLUME_DELTA,
  BODY_RECONDITION_COOLDOWN_MS: CONFIG.BODY_RECONDITION_COOLDOWN_MS,
  BODY_TRACK_HOLD_MS: CONFIG.BODY_TRACK_HOLD_MS,
  performance: { now: () => 0 },
  console: { warn() {}, log() {} },
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { TORSO_LANDMARKS, torsoReadable, planarAngleDeg, bodyYawDegrees," +
  " bodyPitchDegrees, bodyDepthRatio, bodyProfileBox, bodyContourSignature," +
  " relativeDelta, topologyDelta, topologyShift, makeBodyTopologyTracker };"
)(...Object.values(sandbox));

/* ── Skeleton fixtures ────────────────────────────────────────────────────────
   A 33-point BlazePose set posed by hand, so every number in an assertion below can be
   traced to a geometric fact rather than to a recorded output.
     yawDeg   rotates the shoulder line about the vertical axis - width collapses into
              depth, exactly as a real turn does;
     leanDeg  tilts the shoulder-to-hip axis toward the camera;
     depth    pushes the hips forward, which is how added waist volume shows up in a
              four-joint model (and why it reports as a lean - see topologyShift);
     width    broadens the torso without moving it in depth - a contour change with no
              rotation and no lean, which is the only way to exercise the aspect channel
              on its own;
     scale    moves the whole figure toward or away from the lens.
   The sign convention: with landmark 12 (the subject's RIGHT shoulder) on the image left,
   a positive yawDeg produces a NEGATIVE reported yaw. Only magnitudes are asserted, for
   exactly that reason - a future MediaPipe release could flip it. */
function skeleton({ yawDeg = 0, leanDeg = 0, depth = 0, width = 1, scale = 1, visibility = 0.95 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  const half = 0.2 * scale * width;               // half the square-on shoulder width
  const rad = (yawDeg * Math.PI) / 180;
  const set = (i, x, y, z) => { pts[i] = { x, y, z, visibility }; };
  set(12, 0.5 - half * Math.cos(rad), 0.30 * scale, -half * Math.sin(rad));   // RIGHT
  set(11, 0.5 + half * Math.cos(rad), 0.30 * scale, +half * Math.sin(rad));   // LEFT
  /* Hips keep a narrower span, and carry the lean plus any added forward volume. */
  const hipZ = depth + Math.sin((leanDeg * Math.PI) / 180) * 0.3 * scale;
  set(24, 0.5 - half * 0.7 * Math.cos(rad), 0.70 * scale, hipZ - half * 0.7 * Math.sin(rad));
  set(23, 0.5 + half * 0.7 * Math.cos(rad), 0.70 * scale, hipZ + half * 0.7 * Math.sin(rad));
  return pts;
}
const result = (pts) => ({ landmarks: [pts], worldLandmarks: [pts] });
const sig = (opts) => api.bodyContourSignature(result(skeleton(opts)));

console.log("── §1 THE GEOMETRY: angles that mean something, ratios that survive distance ──");
{
  /* ZERO MUST MEAN SQUARE-ON. This is the property the implementation is shaped around:
     the obvious atan2(z, x) form answers 0 OR 180 for a square-on subject depending on
     which landmark index sits on which side of the image, so a sign-convention change in
     a future MediaPipe release would silently invert the whole signal. */
  check("a square-on shoulder line reads as 0 degrees of yaw",
    Math.abs(api.bodyYawDegrees(skeleton({ yawDeg: 0 }))) < 0.01,
    String(api.bodyYawDegrees(skeleton({ yawDeg: 0 }))));
  check("...and a fully edge-on one reads as ±90",
    Math.abs(Math.abs(api.bodyYawDegrees(skeleton({ yawDeg: 90 }))) - 90) < 0.01,
    String(api.bodyYawDegrees(skeleton({ yawDeg: 90 }))));
  check("...with the reported turn tracking the real one through the middle",
    Math.abs(Math.abs(api.bodyYawDegrees(skeleton({ yawDeg: 30 }))) - 30) < 0.01 &&
    Math.abs(Math.abs(api.bodyYawDegrees(skeleton({ yawDeg: 60 }))) - 60) < 0.01,
    `${api.bodyYawDegrees(skeleton({ yawDeg: 30 }))} / ${api.bodyYawDegrees(skeleton({ yawDeg: 60 }))}`);
  /* SIGN CARRIES DIRECTION. Not used for a decision today (the thresholds are absolute),
     but a signal that cannot tell left from right is one that cannot be extended to. */
  check("...and the sign distinguishes turning one way from the other",
    Math.sign(api.bodyYawDegrees(skeleton({ yawDeg: 45 }))) ===
      -Math.sign(api.bodyYawDegrees(skeleton({ yawDeg: -45 }))));

  check("an upright torso reads as 0 degrees of pitch, a lean does not",
    Math.abs(api.bodyPitchDegrees(skeleton({ leanDeg: 0 }))) < 0.01 &&
    Math.abs(api.bodyPitchDegrees(skeleton({ leanDeg: 40 }))) > 20,
    `${api.bodyPitchDegrees(skeleton({ leanDeg: 0 }))} / ${api.bodyPitchDegrees(skeleton({ leanDeg: 40 }))}`);

  /* ── SCALE INVARIANCE, the property that keeps this from firing constantly ──
     A shopper stepping toward the camera changes every pixel coordinate on the skeleton.
     If any metric were absolute, that walk would read as a body that changed shape and
     would burn a re-conditioning dispatch (and its image re-upload) on nothing at all. */
  const near = sig({ scale: 1 }), far = sig({ scale: 0.6 });
  check("stepping toward the camera does NOT read as a change of shape",
    Math.abs(near.yaw - far.yaw) < 0.01 && Math.abs(near.aspect - far.aspect) < 0.01 &&
    Math.abs(near.depth - far.depth) < 0.01,
    JSON.stringify({ near, far }));
  check("...and the shift test agrees, which is what actually matters",
    api.topologyShift(api.topologyDelta(near, far)) === null);

  /* THE VOLUMETRIC CHANNEL. A cushion under a shirt has no landmark of its own - what it
     does have is a measurable effect on the skeleton, pushing the hips forward relative
     to the shoulders. That is what this reads, and the comment in app.js says so plainly
     rather than claiming a body scan. */
  check("added forward volume at the waist raises the torso depth ratio",
    sig({ depth: 0.14 }).depth > sig({ depth: 0 }).depth + 0.15,
    `${sig({ depth: 0 }).depth} → ${sig({ depth: 0.14 }).depth}`);

  check("the profile box spans the four torso joints, and is narrower edge-on",
    api.bodyProfileBox(skeleton({ yawDeg: 80 })).aspect <
      api.bodyProfileBox(skeleton({ yawDeg: 0 })).aspect,
    `${api.bodyProfileBox(skeleton({ yawDeg: 0 })).aspect} → ${api.bodyProfileBox(skeleton({ yawDeg: 80 })).aspect}`);

  /* DEGENERATE INPUT MUST ABSTAIN, NOT GUESS. Every one of these returns null, and null
     means "not measurable", which routes to the hold - never to a re-drape on a guess. */
  check("a missing landmark set abstains rather than returning a number",
    api.bodyYawDegrees(null) === null && api.bodyPitchDegrees(null) === null &&
    api.bodyDepthRatio(null) === null && api.bodyProfileBox(null) === null);
  check("...and a zero-length segment abstains too, instead of dividing by zero",
    api.planarAngleDeg(0, 0) === null);
  check("...and an empty result yields no signature at all",
    api.bodyContourSignature({ landmarks: [] }) === null &&
    api.bodyContourSignature(null) === null);
}

console.log("\n── §2 THE VISIBILITY BAR: measurable is a lower bar than billable ──");
{
  /* THE TWO BARS ANSWER DIFFERENT QUESTIONS, and collapsing them is the mistake this
     section exists to prevent. The gate's bar decides whether to spend a shopper's
     credits. This one decides whether a frame can be measured - and the frames it most
     needs are mid-rotation, with one shoulder half-occluded, which is exactly what a
     go-live-grade bar throws away. */
  check("the tracking bar is genuinely lower than the go-live presence bar",
    CONFIG.BODY_TRACK_MIN_VISIBILITY < CONFIG.POSE_MIN_CONFIDENCE,
    `${CONFIG.BODY_TRACK_MIN_VISIBILITY} vs ${CONFIG.POSE_MIN_CONFIDENCE}`);
  check("a half-occluded shoulder is still measurable, though not still billable",
    api.torsoReadable(skeleton({ visibility: 0.6 })) === true &&
    api.torsoReadable(skeleton({ visibility: 0.6 }), CONFIG.POSE_MIN_CONFIDENCE) === false,
    "if this fails the monitor goes blind during the exact turn it exists to track");
  check("...but a landmark below even the tracking bar makes the frame unreadable",
    api.torsoReadable(skeleton({ visibility: 0.2 })) === false);
  /* SHOULDERS AND HIPS ONLY. Knees and elbows were deliberately excluded: a shopper
     waving would otherwise read as a body that changed shape. */
  check("only the four torso joints are measured - not knees, not elbows",
    api.TORSO_LANDMARKS.length === 4 &&
    api.TORSO_LANDMARKS.every((i) => [11, 12, 23, 24].includes(i)),
    JSON.stringify(api.TORSO_LANDMARKS));
  check("a knee dropping out of frame does not disturb the reading",
    (() => {
      const pts = skeleton();
      pts[25] = { x: 0, y: 0, z: 0, visibility: 0 };
      return api.torsoReadable(pts) === true;
    })());
}

console.log("\n── §3 THE DECISION: what counts as a different body ──");
{
  const square = sig({ yawDeg: 0 });
  check(`a turn past ${CONFIG.BODY_ROTATION_DELTA_DEG} degrees reads as a rotation shift`,
    api.topologyShift(api.topologyDelta(square, sig({ yawDeg: 25 }))) === "rotation");
  check("...and a small weight-shift does not",
    api.topologyShift(api.topologyDelta(square, sig({ yawDeg: 5 }))) === null,
    "fidgeting must not spend a billed re-upload");
  check("a lean toward the camera reads as its own axis, not as a rotation",
    api.topologyShift(api.topologyDelta(square, sig({ leanDeg: 35 }))) === "lean");
  /* ── ADDED VOLUME FIRES, AND IS LABELLED "LEAN" - the honest limit ──────────
     A cushion under the shirt has no landmark of its own. What it does have is an effect
     on the four joints: the hips are estimated further forward, which tilts the
     shoulder-to-hip axis - so it trips the PITCH channel and is reported as a lean.
     That is a labelling limit, not a detection gap, and it is asserted rather than
     papered over because the next reader will otherwise take the reason string literally.
     What matters is the response, which is identical on every axis: re-drape against the
     live frame, where the volume is actually visible. */
  check("added waist volume trips the monitor, with no rotation involved",
    api.topologyShift(api.topologyDelta(square, sig({ depth: 0.14 }))) !== null &&
    api.topologyDelta(square, sig({ depth: 0.14 })).yaw < 1,
    JSON.stringify(api.topologyDelta(square, sig({ depth: 0.14 }))));
  check("...and app.js states that it will be labelled a lean, and why that is fine",
    /"LEAN" AND "VOLUME" ARE NOT CLEANLY SEPARABLE FROM FOUR JOINTS/.test(SRC) &&
    /added belly volume\s*\n?\s*\*? ?most often reports as "lean"/.test(SRC),
    "a reason string taken literally is worse than one explained");
  /* THE ASPECT CHANNEL ON ITS OWN: a torso that broadens without rotating or leaning.
     This is the one event only the volume channel can see, so it is what proves the
     channel is wired rather than dead weight behind the two angular ones. */
  check("a broadened torso with no rotation and no lean reads as a volume shift",
    api.topologyShift(api.topologyDelta(square, sig({ width: 1.35 }))) === "volume",
    JSON.stringify(api.topologyDelta(square, sig({ width: 1.35 }))));
  /* THE THRESHOLD IS THE SPEC'D ONE. Asserted against config rather than hardcoded, so
     the two cannot drift, and the spec'd figure is named in the label. */
  check("the rotation threshold is the spec'd 15 degrees, read from config",
    CONFIG.BODY_ROTATION_DELTA_DEG === 15 &&
    /delta\.yaw\s+>= rotationDeg/.test(SRC) && /delta\.pitch\s+>= rotationDeg/.test(SRC));
  /* THE FUSED VOLUME FIGURE TAKES THE MAX, not the mean: the two channels see different
     halves of the same event, and averaging would let a strong signal on one be diluted
     by a quiet one on the other. */
  check("the volume figure is the LARGER of the depth and aspect changes, never the mean",
    /volume: Math\.max\(Math\.abs\(next\.depth - prev\.depth\),\s*\n?\s*relativeDelta\(prev\.aspect, next\.aspect\)\)/.test(SRC),
    "an averaged signal is a signal one quiet channel can veto");
  /* ── DEPTH IS ABSOLUTE, ASPECT IS RELATIVE, AND THAT IS A BUG FIX ───────────
     The first build compared BOTH proportionally, and depth legitimately passes through
     zero (a flat, square-on torso reads 0.00). A two-degree weight shift took it to 0.03,
     which is a 100% relative change and a nothing of an absolute one - so standing still
     dispatched a full image re-upload on every other tick. Asserted as behaviour, on the
     real functions, because the mistake is a natural one to make again. */
  check("...so a two-degree weight shift is not a 100% change of body shape",
    api.topologyDelta(sig({ yawDeg: 0 }), sig({ yawDeg: 2 })).volume < CONFIG.BODY_VOLUME_DELTA,
    JSON.stringify(api.topologyDelta(sig({ yawDeg: 0 }), sig({ yawDeg: 2 }))));
  check("...while the aspect channel keeps a guarded denominator for the same reason",
    Number.isFinite(api.relativeDelta(0, 0)) && api.relativeDelta(0, 0) === 0 &&
    api.relativeDelta(0, 0.001) < 0.05,
    "aspect reaches ~0 at a full 90-degree turn");
}

console.log("\n── §4 THE TRACKER: the baseline is the CONDITIONED shape ──");
{
  /* THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE. Comparing each frame against the
     PREVIOUS one would mean a slow, continuous turn never trips anything - every step is
     tiny. Comparing against the shape the current render was conditioned on means drift
     accumulates until it matters, then fires once. Modelled here as a real 90-degree turn
     taken in 5-degree steps, which is the case the report was filed against. */
  let clock = 0;
  const tracker = api.makeBodyTopologyTracker({ now: () => clock });
  tracker.feed(sig({ yawDeg: 0 }));                       // acquire
  const states = [];
  for (let deg = 5; deg <= 90; deg += 5) {
    clock += 200;                                          // one sampler tick
    states.push(tracker.feed(sig({ yawDeg: deg })).state);
  }
  check("a slow 90-degree turn taken in 5-degree steps still fires",
    states.includes("shift"),
    "a per-frame baseline would let a gradual turn slip past every threshold");
  check("...and fires more than once across the whole rotation",
    states.filter((s) => s === "shift").length >= 2,
    `states: ${states.join(",")}`);
  check("...but not on every tick - the cooldown bounds the image re-uploads",
    states.filter((s) => s === "shift").length <= 5,
    `${states.filter((s) => s === "shift").length} dispatches across a 3.4s turn`);

  /* STANDING STILL COSTS NOTHING. The opposite failure: a monitor that fires on noise
     would re-upload the packshot repeatedly inside a 5s billed window. */
  let still = 0;
  const t2 = api.makeBodyTopologyTracker({ now: () => (still += 200) });
  t2.feed(sig({ yawDeg: 0 }));
  const stillStates = Array.from({ length: 20 }, (_, i) =>
    t2.feed(sig({ yawDeg: (i % 2 ? 1 : -1) * 2 })).state);
  check("a shopper standing still never dispatches, however long they stand",
    !stillStates.includes("shift"), `states: ${stillStates.join(",")}`);

  /* A SUPPRESSED SHIFT IS NOT A FORGOTTEN ONE. The cooldown lives inside the tracker
     precisely so it cannot advance the baseline: if it did, the movement it swallowed
     would be silently absorbed and the body would stay mis-fitted for the rest of the
     session. */
  let t = 0;
  const t3 = api.makeBodyTopologyTracker({ now: () => t });
  t3.feed(sig({ yawDeg: 0 }));
  t += 200; const first = t3.feed(sig({ yawDeg: 40 }));
  t += 100; const blocked = t3.feed(sig({ yawDeg: 80 }));
  t += CONFIG.BODY_RECONDITION_COOLDOWN_MS; const after = t3.feed(sig({ yawDeg: 80 }));
  check("a shift inside the cooldown is reported as suppressed, not as stable",
    first.state === "shift" && blocked.state === "cooldown" && blocked.reason === "rotation",
    `${first.state} / ${blocked.state}`);
  check("...and the movement it swallowed still fires once the cooldown expires",
    after.state === "shift",
    "a cooldown that advanced the baseline would lose the turn entirely");
}

console.log("\n── §5 THE FALLBACK: hold the last valid fit through a blind turn ──");
{
  /* THE SPEC'D BEHAVIOUR: "if pose tracking loses visibility during sharp rotations,
     briefly hold the last valid fit and seamlessly resume as soon as the landmarks
     re-align". Holding IS sending nothing - the last dispatched fit stays on screen - so
     what has to be asserted is that no dispatch happens while blind, and that the
     comparison on return is against the held baseline rather than against nothing. */
  let t = 0;
  const tracker = api.makeBodyTopologyTracker({ now: () => t });
  tracker.feed(sig({ yawDeg: 0 }));
  const blind = [];
  for (let i = 0; i < 4; i++) { t += 200; blind.push(tracker.feed(null)); }
  check("an unreadable body holds - it never dispatches on a frame it cannot measure",
    blind.every((s) => s.state === "hold"),
    blind.map((s) => s.state).join(","));
  /* The hold clock starts when the body is first SEEN to be missing, not at the last
     good frame - so four ticks at 200ms report 0/200/400/600. Asserted on the exact
     figure because it is what the console line prints, and an off-by-one-tick there is
     how "it held for two seconds" gets mis-diagnosed. */
  check("...and the hold reports how long it has lasted, for the log line",
    blind.map((s) => s.heldMs).join(",") === "0,200,400,600",
    blind.map((s) => s.heldMs).join(","));
  t += 200;
  const back = tracker.feed(sig({ yawDeg: 45 }));
  check("...and re-acquiring a MOVED body dispatches, tagged as coming out of a hold",
    back.state === "shift" && back.reason === "rotation-after-hold",
    `${back.state} / ${back.reason}`);

  /* THE OTHER HALF: coming back UNCHANGED must not dispatch. The fit that was held is
     still the correct one, and re-uploading the reference to re-assert it would spend a
     billed round-trip to produce the same frame. */
  let t2 = 0;
  const t2r = api.makeBodyTopologyTracker({ now: () => t2 });
  t2r.feed(sig({ yawDeg: 0 }));
  t2 += 200; t2r.feed(null);
  t2 += 200;
  check("a body that returns UNCHANGED resumes silently, with no dispatch",
    t2r.feed(sig({ yawDeg: 2 })).state === "resumed");

  /* THE HOLD IS BOUNDED. Past BODY_TRACK_HOLD_MS the shopper has been gone long enough
     that the presence watcher's own absent→present path owns the recovery, so the tracker
     drops its baseline and re-acquires rather than firing a second dispatch for the same
     event. */
  let t3 = 0;
  const t3r = api.makeBodyTopologyTracker({ now: () => t3 });
  t3r.feed(sig({ yawDeg: 0 }));
  t3 += 200; t3r.feed(null);                       // the hold clock starts HERE
  t3 += CONFIG.BODY_TRACK_HOLD_MS;
  check("a hold longer than the ceiling drops the baseline instead of holding forever",
    t3r.feed(null).state === "dropped" && t3r.baseline === null);
  t3 += 200;
  check("...and the next clean read re-acquires, deferring recovery to the presence path",
    t3r.feed(sig({ yawDeg: 70 })).state === "acquired",
    "two dispatches for one absence is one too many");
  check("...and app.js says which path owns that recovery",
    /startPresenceWatcher\(\)'s own absent→present path owns the recovery/.test(SRC),
    "an unexplained deferral reads as a missing case");
}

console.log("\n── §6 THE WIRING: one inference, a real dispatch, and a teardown ──");
{
  const watcher = extract("function startPresenceWatcher", "/* ── end body-presence gate ── */");

  /* ONE DETECTOR CALL PER TICK. Two loops would have doubled a WASM/GPU inference on a
     phone for a question the first inference already answered - and, worse, two callers
     racing the same landmarker can land on the same performance.now() millisecond, which
     MediaPipe rejects outright. */
  check("the live loop runs ONE pose inference per tick, feeding both consumers",
    (watcher.match(/detectPoseFrame\(/g) || []).length === 1 &&
    /presenceFromPoseResult\(result, category\)/.test(watcher) &&
    /bodyContourSignature\(result\)/.test(watcher),
    "a second sampler doubles the inference and races the timestamp contract");
  check("...and every detectForVideo() in the file goes through the monotonic guard",
    (SRC.match(/\.detectForVideo\(/g) || []).length === 1 &&
    /function detectPoseFrame\(detector, video\) \{[\s\S]{0,200}Math\.max\(performance\.now\(\), _lastPoseTimestamp \+ 1\)/.test(SRC),
    "MediaPipe throws on a repeated timestamp - one guarded call site is the whole fix");
  check("a null presence verdict no longer takes the topology half down with it",
    /if \(verdict !== null\) \{/.test(watcher) && !/if \(verdict === null\) return;/.test(watcher),
    "'cannot judge presence' and 'cannot measure shape' are different failures");

  /* THE DISPATCH HAS TO ACTUALLY REACH THE WIRE. This is the crux: with a constant prompt
     and the reference already sent, applyGarment() skips the send entirely. A monitor
     that fires into that skip would change nothing at all and would be indistinguishable
     from no monitor. */
  const recondition = extract("async function reconditionForTopology(", "\n}\n/* ── end body-presence gate");
  check("a topology shift forces a REAL dispatch, past the no-op skip",
    /lastSentImageRef = null;/.test(recondition) && /rtImageOnWire = false;/.test(recondition) &&
    /lastSentPrompt = null;/.test(recondition) && /await applyActive\(\);/.test(recondition),
    "clearing fewer than all three leaves the send to be skipped by one guard or the other");
  check("...and app.js explains why a prompt-only re-assert cannot work here",
    /The prompt is constant per\s*\n?\s*category, so applyGarment\(\)'s no-op skip is not an optimisation here/.test(SRC),
    "the next reader will otherwise try the cheaper send and see nothing happen");
  /* THE SAME BILLING CONSTRAINT THE PRESENCE PATH HAS. Re-arming the window on a turn
     would bill a fresh session every time the shopper moved. */
  check("re-draping never re-arms the billing clock or the countdown",
    !/liveDurationTimer\s*=/.test(recondition) && !/startBillingWindow\(/.test(recondition) &&
    !/liveCountdown/.test(recondition));
  check("...and is guarded on in-flight, still-live, and already-dressed",
    /topologyReconditionInFlight/.test(recondition) && /isLive\(\)/.test(recondition) &&
    /isGarmentApplied/.test(recondition));
  /* NEVER DURING A FRONT/BACK SWAP. That path is mid-replacement of the reference ITSELF
     and re-applies the whole payload when it lands, so firing into it would both collide
     and re-upload an asset about to be replaced. */
  check("...and never fires into an orientation swap that already owns the wire",
    /if \(_orientHoldActive\) return;/.test(recondition),
    "a re-upload during a front/back swap replaces an asset that is being replaced");

  /* THE GARMENT IS THE INVARIANT HALF. The monitor may re-condition; it may never choose
     a different asset, rewrite the prompt, or touch the reference. Stated as an absence,
     which is the only form that catches a well-meant addition. */
  /* Comments stripped first, for the reason image-first.test.mjs strips them: the code
     legitimately DISCUSSES setPrompt() and the garment reference in explaining why it
     touches neither, and a check that cannot tell a call from an explanation would force
     whoever reads it to delete the documentation. */
  const section = (extract("/* The four joints that define the torso.", "/* The loaded PoseLandmarker") +
                   watcher + recondition)
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("nothing in the monitor selects an asset, edits a prompt, or reads the garment",
    !/CATEGORY_ANCHOR/.test(section) && !/imageOnlyPrompt/.test(section) &&
    !/GARMENT_(FRONT|BACK)/.test(section) && !/setPrompt\(/.test(section) &&
    !/referenceImageFor/.test(section),
    "the garment is the static half - this module may only change WHEN, never WHAT");

  check("the tracker is per-session and dropped when the watcher stops",
    /bodyTopology = BODY_TOPOLOGY_ENABLED \? makeBodyTopologyTracker\(\) : null;/.test(SRC) &&
    /bodyTopology = null;/.test(extract("function stopPresenceWatcher", "\n}")),
    "a tracker outliving its session measures one shopper against another");
  check("...and a presence re-condition re-bases it, rather than leaving a stale baseline",
    /if \(bodyTopology\) bodyTopology\.reset\(\);/.test(watcher),
    "after something else re-conditions the render, the stored shape is no longer on screen");
  check("the loop is still torn down with the session, like every other timer",
    /stopPresenceWatcher\(\)/.test(extract("function teardown()", "\n  sessionGen++;")));

  /* THE FEATURE FLAG HAS TO WORK BOTH WAYS, and the detector preload has to follow it -
     warming for one consumer and not the other would put a multi-MB WASM download on the
     live path for whichever flag happened to be off. */
  check("either consumer arms the loop; neither one alone can disable the other",
    /if \(\(!POSE_GATE_ENABLED && !BODY_TOPOLOGY_ENABLED\) \|\| presenceWatcherTimer\) return;/.test(SRC) &&
    /if \(!POSE_GATE_ENABLED && !BODY_TOPOLOGY_ENABLED\) return;/
      .test(extract("function preloadPoseDetector", "\n}")),
    "the preload must cover whichever consumer is enabled");
  check("every threshold is config-driven, with nothing hardcoded at the call site",
    ["BODY_TOPOLOGY_ENABLED", "BODY_TOPOLOGY_SAMPLE_MS", "BODY_TRACK_MIN_VISIBILITY",
     "BODY_ROTATION_DELTA_DEG", "BODY_VOLUME_DELTA", "BODY_RECONDITION_COOLDOWN_MS",
     "BODY_TRACK_HOLD_MS"].every((k) => k in CONFIG && new RegExp(`\\b${k},`).test(SRC)),
    "a threshold tuned at the call site is one config.js cannot document");

  /* THE STREAM CONTRACT, asserted where it is easy to break: the body reaching Decart is
     the LIVE frame, always. Nothing may capture a body frame and re-send it - the only
     latched asset in this pipeline is the garment reference, which is the half that is
     supposed to be invariant. */
  check("app.js records that the spatial base is never latched",
    /THIS LOOP IS THE "SPATIAL BASE", AND IT IS NEVER LATCHED/.test(SRC) &&
    /The only latched asset in this pipeline is the GARMENT reference/.test(SRC),
    "the report reads like a frozen body keyframe; the file has to say why it is not one");
}

console.log("\n── §7 THROTTLING: the wire is the floor, not the CPU ──");
{
  /* THE REGRESSION THIS SECTION EXISTS FOR: "המדידה החיה נכשלה: timeout ממתין ליישום הבגד
     (rtClient.set לא הגיב)". A monitor that re-evaluates faster than the signaling channel
     can absorb turns every movement into a queued image re-upload, and a set() issued into
     that backlog is the one that never gets a response. Two independent limits keep this
     bounded, and they are asserted separately because they fail separately. */
  check(`the topology is re-evaluated at most ~3×/s (${CONFIG.BODY_TOPOLOGY_SAMPLE_MS}ms)`,
    CONFIG.BODY_TOPOLOGY_SAMPLE_MS >= 300 && CONFIG.BODY_TOPOLOGY_SAMPLE_MS <= 500,
    `${CONFIG.BODY_TOPOLOGY_SAMPLE_MS}ms - the spec'd band is 300-500ms`);
  check("...and at most one re-conditioning DISPATCH per cooldown on top of that",
    CONFIG.BODY_RECONDITION_COOLDOWN_MS >= CONFIG.BODY_TOPOLOGY_SAMPLE_MS,
    "a cooldown shorter than the evaluation interval bounds nothing");

  /* ── THE LOOP RATE IS THE PRESENCE RATE, AND THE THROTTLE IS SEPARATE ───────
     An earlier revision sped the whole LOOP up to the topology interval, which raised the
     rate of the expensive half (a WASM/GPU inference, on the thread that services the
     datachannel) to benefit the cheap half (arithmetic on four landmarks). The loop is
     back on the presence cadence and the topology consumer carries its own elapsed check,
     so the inference load is exactly what it was before this monitor existed. */
  const watcher = extract("function startPresenceWatcher", "/* ── end body-presence gate ── */");
  check("the sampler runs at the PRESENCE cadence, not the topology one",
    /const tickMs = POSE_SAMPLE_MS \* 2;/.test(watcher),
    "raising the inference rate for the consumer that does not need it is the wrong lever");
  check("...and the topology consumer throttles itself on top of that loop",
    /now - lastTopologyAt >= BODY_TOPOLOGY_SAMPLE_MS/.test(watcher) &&
    /lastTopologyAt = now;/.test(watcher),
    "without its own gate the consumer inherits whatever the loop happens to run at");

  /* ── A DEFERRED SHIFT IS NOT A FORGOTTEN ONE ───────────────────────────────
     The gate that skips a re-drape while the wire is busy lives INSIDE feed(), for the
     same reason the cooldown does: a baseline advanced for a dispatch that never happened
     absorbs the movement silently, and the body stays mis-fitted for the rest of the
     session. This is the exact bug that a naive `if (wireBusy()) return;` at the call site
     would have introduced, since feed() had already moved the baseline by then. */
  let t = 0;
  const tracker = api.makeBodyTopologyTracker({ now: () => t });
  tracker.feed(sig({ yawDeg: 0 }));
  t += 400;
  const blocked = tracker.feed(sig({ yawDeg: 40 }), { canDispatch: false });
  check("a shift found while the wire is busy is reported as deferred, not as a shift",
    blocked.state === "deferred" && blocked.reason === "rotation",
    JSON.stringify(blocked));
  t += 400;
  const retried = tracker.feed(sig({ yawDeg: 40 }), { canDispatch: true });
  check("...and the SAME movement still fires once the wire frees up",
    retried.state === "shift" && retried.reason === "rotation",
    "a deferred shift that advanced the baseline would leave the body mis-fitted for good");
  check("the watcher passes that gate from the live wire state",
    /bodyTopology\.feed\(bodyContourSignature\(result\), \{ canDispatch: !wireBusy\(\) \}\)/.test(watcher),
    "the gate is useless if the call site does not tell it what the wire is doing");

  /* THE LAST LINE OF DEFENCE, one level down: even with the gate above, the dispatcher
     re-checks. Cheap, and it covers any future caller that forgets to pass the gate. */
  const recondition = extract("async function reconditionForTopology(", "\n}\n/* ── end body-presence gate");
  check("...and the dispatcher itself declines a busy wire regardless",
    /if \(wireBusy\(\)\) \{/.test(recondition),
    "a defence that depends on every caller remembering is not a defence");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
