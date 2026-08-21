/* "THE FIRST TRY IS ALWAYS GLITCHY."

   Decart conditions on the frame it is handed. Press go-live while still reaching for the
   mouse, half out of shot, or mid-turn, and the garment is fitted to THAT frame - and the
   session is hard-capped at LIVE_DURATION_MS = 5000ms, so the shopper watches a broken
   render for the whole billed window and has to press again. The retry looks like it
   "fixed itself"; nothing was fixed, they simply happened to be standing still.

   THE GATE. Presence is now confirmed BEFORE the token is minted, following the exact
   precedent cameraLooksBlack() set in the same function: a local, pixel-only check that
   refuses to open a billed session it can already tell will be wasted. Nothing is sent
   anywhere to make this decision.

   ── WHY THE DETECTOR IS PLUGGABLE, AND WHY THAT IS NOT OVER-ENGINEERING ─────────
   MediaPipe Pose is the only thing here that can actually see HIPS AND KNEES, which is
   what a trousers try-on has to gate on - a face detector cannot. But it is also a
   multi-MB WASM runtime from a CDN, in a page that has zero external scripts today, and
   app.js:10474 records this file declining exactly that dependency once already.

   Loading it lazily at go-live would put a 3-6MB third-party download on the critical
   path of the feature whose entire purpose is making the first try work. So it is
   PRELOADED during Screen 2 and the gate degrades to the native FaceDetector engine the
   orientation watcher already runs. The rule this suite enforces is that no failure of
   that third party can ever block a shopper: not a dead CDN, not a slow one, not a
   browser without WebAssembly.

   WHAT THIS SUITE PINS:
     §1  the landmark requirements are CATEGORY-AWARE - shoulders for a top, hips and
         knees for trousers - because that is the whole reason for a pose model;
     §2  confidence AND consecutive frames, so one lucky frame cannot open the gate;
     §3  the gate degrades on every detector failure path, and never blocks go-live;
     §4  it sits before the token mint, after the camera - the credit-saving position;
     §5  late entry re-conditions WITHOUT re-billing, and cannot re-arm the 5s clock;
     §6  the prompt carries the temporal-persistence directive, per category, in budget;
     §7  the overlay is bilingual and is torn down on every exit path. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

/* The real gate logic, executed. */
const code = extract("/* ── Body-presence gate", "/* ── end body-presence gate ── */");
const mk = ({ detector = null, faceDetector = null } = {}) => {
  const sandbox = {
    POSE_MIN_CONFIDENCE: CONFIG.POSE_MIN_CONFIDENCE,
    POSE_CONSECUTIVE_FRAMES: CONFIG.POSE_CONSECUTIVE_FRAMES,
    POSE_GATE_TIMEOUT_MS: CONFIG.POSE_GATE_TIMEOUT_MS,
    POSE_SAMPLE_MS: CONFIG.POSE_SAMPLE_MS,
    POSE_MODEL_URL: "https://cdn.test/pose.task",
    POSE_WASM_BASE: "https://cdn.test/wasm",
    console: { warn() {}, log() {}, error() {} },
    _testDetector: detector,
    FaceDetector: faceDetector,
  };
  return new Function(...Object.keys(sandbox),
    code + "\nreturn { POSE_LANDMARK, requiredPoseLandmarks, poseFrameQualifies," +
    " makePresenceGate, presenceFromPoseResult };")(...Object.values(sandbox));
};
const api = mk();

/* A full 33-point BlazePose skeleton, all landmarks confidently visible. Individual
   tests knock out the specific joints they are about. */
const fullBody = (visibility = 0.95) =>
  Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }));
function hide(landmarks, indices) {
  const out = landmarks.map((l) => ({ ...l }));
  for (const i of indices) out[i].visibility = 0.1;
  return out;
}

console.log("── §1 CATEGORY-AWARE LANDMARKS - the reason a pose model is here at all ──");
{
  const L = api.POSE_LANDMARK;
  check("the BlazePose indices are the documented ones, not guessed",
    L.LEFT_SHOULDER === 11 && L.RIGHT_SHOULDER === 12 &&
    L.LEFT_HIP === 23 && L.RIGHT_HIP === 24 &&
    L.LEFT_KNEE === 25 && L.RIGHT_KNEE === 26,
    JSON.stringify(L));

  const top = api.requiredPoseLandmarks("top");
  const bottom = api.requiredPoseLandmarks("bottom");
  check("a TOP gates on both shoulders", top.includes(11) && top.includes(12));
  check("...and on the torso anchor (hips), so a floating head cannot pass",
    top.includes(23) && top.includes(24),
    "shoulders alone are satisfied by a head-and-neck crop with no torso in frame");
  check("...but NOT on knees - a shopper seated at a desk must still be able to fit a shirt",
    !top.includes(25) && !top.includes(26),
    "requiring legs for a top would block the most common webcam framing there is");

  check("BOTTOMS gate on both hips", bottom.includes(23) && bottom.includes(24));
  check("...and on the upper legs (knees), per the spec",
    bottom.includes(25) && bottom.includes(26),
    "hips alone do not prove the trousers will actually be in frame");
  check("the two requirement sets are genuinely different",
    JSON.stringify(top) !== JSON.stringify(bottom));
}

console.log("\n── §2 CONFIDENCE AND STREAK - one lucky frame is not presence ──");
{
  const MIN = CONFIG.POSE_MIN_CONFIDENCE;
  check(`the configured confidence bar is the spec'd ${MIN} (> 0.75)`,
    MIN >= 0.75, String(MIN));
  check("a fully-visible body qualifies for both categories",
    api.poseFrameQualifies(fullBody(), "top", MIN) === true &&
    api.poseFrameQualifies(fullBody(), "bottom", MIN) === true);

  /* THE CASE THE WHOLE FEATURE EXISTS FOR: someone framed head-and-shoulders only. A
     shirt can be fitted; trousers cannot, and gating both the same way is what produced
     "the first try is glitchy" for bottoms. */
  const noLegs = hide(fullBody(), [25, 26, 27, 28]);
  check("head-and-torso framing PASSES for a top but FAILS for trousers",
    api.poseFrameQualifies(noLegs, "top", MIN) === true &&
    api.poseFrameQualifies(noLegs, "bottom", MIN) === false);

  const noHips = hide(fullBody(), [23, 24]);
  check("hips out of frame fails BOTH - a top needs its torso anchor too",
    api.poseFrameQualifies(noHips, "top", MIN) === false &&
    api.poseFrameQualifies(noHips, "bottom", MIN) === false);

  check("a low-confidence skeleton fails even when every joint is present",
    api.poseFrameQualifies(fullBody(0.4), "top", MIN) === false,
    "a blurry/ambiguous detection is exactly the frame that produced a bad first render");
  check("empty / missing landmarks fail without throwing",
    api.poseFrameQualifies([], "top", MIN) === false &&
    api.poseFrameQualifies(null, "top", MIN) === false &&
    api.poseFrameQualifies(undefined, "bottom", MIN) === false);

  console.log("   -- the consecutive-frame streak --");
  const N = CONFIG.POSE_CONSECUTIVE_FRAMES;
  check(`the streak requirement is in the spec'd 3-5 range (${N})`, N >= 3 && N <= 5, String(N));
  {
    const gate = api.makePresenceGate();
    let present = false;
    for (let i = 0; i < N - 1; i++) present = gate.feed(true);
    check(`${N - 1} good frames is NOT yet presence`, present === false);
    present = gate.feed(true);
    check(`...the ${N}th consecutive good frame opens the gate`, present === true);
  }
  {
    /* A single dropped frame RESETS the streak. Without this, a shopper walking THROUGH
       the frame accumulates enough scattered hits to open the gate. */
    const gate = api.makePresenceGate();
    gate.feed(true); gate.feed(true);
    gate.feed(false);
    let present = false;
    for (let i = 0; i < N - 1; i++) present = gate.feed(true);
    check("one bad frame resets the streak - a person walking past cannot accumulate a pass",
      present === false);
  }
  {
    // Once open it STAYS open for as long as frames keep qualifying (no re-arming cost).
    const gate = api.makePresenceGate();
    for (let i = 0; i < N; i++) gate.feed(true);
    check("the gate stays open on continued good frames", gate.feed(true) === true);
    check("...and closes on a bad frame, so late-entry recovery can re-trigger",
      gate.feed(false) === false);
  }
}

console.log("\n── §3 DEGRADATION - no third party may ever block a shopper ──");
{
  /* Each of these is a real way a CDN-hosted WASM runtime fails, and NONE of them may
     end with a shopper unable to try a garment on. The gate is an optimisation; the
     try-on is the product. */
  check("presenceFromPoseResult() treats a null result (no detector) as 'unknown', not 'absent'",
    api.presenceFromPoseResult(null, "top") === null,
    "null must mean 'cannot judge' - only a real detection may report absence");
  check("...and an empty landmark list as a genuine ABSENCE",
    api.presenceFromPoseResult({ landmarks: [] }, "top") === false);
  check("...and a qualifying skeleton as PRESENT",
    api.presenceFromPoseResult({ landmarks: [fullBody()] }, "top") === true);

  check("the loader is wrapped so an import/CDN failure returns null instead of throwing",
    /catch[\s\S]{0,200}?POSE[\s\S]{0,200}?return null|loadPoseLandmarker[\s\S]{0,900}?catch/.test(SRC),
    "an unreachable CDN must not reject into the go-live path");
  check("the gate is bounded by a timeout, so a detector that never resolves cannot hang",
    /POSE_GATE_TIMEOUT_MS/.test(SRC) && CONFIG.POSE_GATE_TIMEOUT_MS > 0,
    "waiting forever for presence is indistinguishable from a broken button");
  check("...and the timeout PROCEEDS to go-live rather than refusing",
    /timed out[\s\S]{0,220}?proceed|proceed[\s\S]{0,220}?timed out/i.test(SRC),
    "a detector that cannot see the shopper must not veto a session they asked for");
  /* Asserted as ORDERING against warmupSDKAndToken(), already the established
     "pre-warm everything the go-live path needs" site. If the preload ever moves into
     goLive(), the adjacency breaks and this fires. */
  check("MediaPipe is PRELOADED at room entry, not fetched on the go-live path",
    /warmupSDKAndToken\(\);[\s\S]{0,900}?preloadPoseDetector\(\);/.test(SRC),
    "a 3-6MB download on the critical path is the opposite of this feature's purpose");
  check("a native FaceDetector fallback exists for browsers/CDNs where pose is unavailable",
    /nativePresenceFallback|FaceDetector/.test(extract("/* ── Body-presence gate", "/* ── end body-presence gate ── */")),
    "the orientation watcher already runs this engine - reuse, not a new dependency");
  check("the whole gate is behind a config kill switch",
    typeof CONFIG.POSE_GATE_ENABLED === "boolean",
    "a gate that can refuse sessions needs one switch that turns it off");
}

console.log("\n── §4 PLACEMENT - the credit-saving position, following cameraLooksBlack() ──");
{
  /* Comments stripped FIRST. cameraLooksBlack()'s own doc block explains itself by
     naming "/api/realtime-token, no connectRealtime(), no credits" - so a raw search
     finds the token mint inside the prose that describes not reaching it, and reports
     the gate as being in the wrong place while the code is entirely correct. */
  const live = extract("async function goLive()", "function stopLive()")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const blackIdx = live.indexOf("cameraLooksBlack()");
  const gateIdx  = live.indexOf("awaitBodyPresence(");
  const tokenIdx = live.search(/await connectRealtime\(\)/);
  check("the presence gate runs INSIDE goLive()", gateIdx !== -1, live.slice(0, 200));
  check("...after the camera is live (it needs pixels to judge)",
    blackIdx !== -1 && gateIdx > blackIdx,
    "gating before the camera exists would always fail");
  check("...and BEFORE the token mint / connect, so a wasted session is never billed",
    tokenIdx !== -1 && gateIdx < tokenIdx,
    `gate@${gateIdx} token@${tokenIdx} - this is the whole credit-saving property`);
  /* The gate must know WHICH garment is being fitted, or it applies the wrong
     landmark set - the §1 distinction would be decorative. */
  check("the gate is passed the active garment's category",
    /awaitBodyPresence\(\s*(isBottomsGarment\(activeItem\)|activeItem)/.test(SRC),
    "a category-blind gate cannot require hips for trousers");
}

console.log("\n── §5 LATE ENTRY - re-condition, never re-bill ──");
{
  /* THE HARD CONSTRAINT, and the reason this section is mostly about what must NOT
     happen: the billed window is LIVE_DURATION_MS and is armed by Decart's first frame.
     Re-arming it on a presence event would silently bill a second full session every
     time a shopper stepped out of shot and back. */
  const watcher = extract("function startPresenceWatcher", "/* ── end body-presence gate ── */");
  check("a presence watcher runs DURING the live session, not only at go-live",
    watcher.length > 0 && /setInterval|requestAnimationFrame/.test(watcher));
  check("an absent → present transition re-sends the conditioning",
    /applyActive\(\)|reconditionForPresence/.test(watcher),
    "the garment must re-fit the moment the shopper is actually visible");
  check("...and does NOT re-arm the billing clock",
    !/liveDurationTimer\s*=/.test(watcher) && !/startBillingWindow\(/.test(watcher),
    "re-arming the 5s cap on every re-entry double-bills the shopper");
  check("...nor restarts the countdown UI",
    !/liveCountdown/.test(watcher));
  /* Re-entry must not stack sends, and must not fire before anything has been dressed -
     the same three conditions maybeReanchorPrompt() checks. */
  check("the re-condition is guarded: in-flight, still live, and already dressed",
    /presenceReconditionInFlight/.test(watcher) && /isLive\(\)/.test(watcher) &&
    /isGarmentApplied/.test(watcher),
    "an unguarded send stacks on the swap/transition paths that own the wire");
  /* The shared-mutex limitation is real and is recorded in the source rather than
     discovered later: the watcher's own `applying` flag is a closure local. */
  check("...and the un-shared-mutex limitation is documented, not glossed",
    /ON THE MUTEX, honestly/.test(SRC),
    "a known benign race should be written down where the next reader will find it");
  check("the watcher is torn down on teardown, like every other session timer",
    /stopPresenceWatcher\(\)/.test(extract("function teardown()", "\n  sessionGen++;")),
    "a live sampling loop outliving its session is a battery and CPU leak");
}

console.log("\n── §6 THE PROMPT: temporal persistence, per category, inside budget ──");
{
  const pcode = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                          SRC.indexOf("/* Full-Look composite clause"));
  const sb = {
    PROMPT_MAX_CHARS: CONFIG.PROMPT_MAX_CHARS, console: { warn() {}, log() {} },
    SUBTYPE_PROMPT: {}, SHIRT_NOUN: {}, colorName: () => "", activeColorOf: () => "",
    getSizeDelta: () => 0, getFitModifier: () => "", getAnatomicalAnchor: () => "",
    getFabricModifier: () => "",
  };
  const p = new Function(...Object.keys(sb),
    pcode + "\nreturn { imageOnlyPrompt };")(...Object.values(sb));
  const top = p.imageOnlyPrompt({ garmentType: "upper_body" });
  const bot = p.imageOnlyPrompt({ garmentType: "lower_body" });

  /* ── THE DIRECTIVE IS NOW TOPS-ONLY, and this is a REGRESSION IN THIS FEATURE ──
     A later change collapsed the bottoms branch to a bare reference lock, after a
     screenshot of a white/cream basketball short rendering as generic BLACK shorts (see
     CATEGORY_ANCHOR.bottom). Everything went with it, this directive included.

     THE TRADE WAS MADE KNOWINGLY and is recorded here rather than quietly absorbed,
     because it is exactly the kind of cross-feature loss that otherwise gets rediscovered
     as a fresh bug report: on TROUSERS, the prompt no longer tells the model the subject
     may not be in frame yet. The GATE still covers the start of the session for both
     categories, and the presence WATCHER still re-conditions on late entry for both - so
     the mechanism survives; only the prompt's half of it is gone on bottoms.

     If late-entry trousers renders come back wrong, TEMPORAL_PERSISTENCE.bottom is
     already written and re-adding it is one line in imageOnlyPrompt(). */
  /* NOW GONE FROM BOTH BRANCHES. The tops branch followed bottoms in a later revision
     that collapsed everything to a strict 1:1 reference lock, after a third report -
     invented detail on the correct garment. So the prompt's half of the late-entry fix
     is fully retired, on both categories. */
  check("NEITHER branch carries the continuous-tracking directive any more",
    !/Continuously track/.test(top) && !/Continuously track/.test(bot),
    `tops=${top.length} bottoms=${bot.length} - both collapsed to a 1:1 reference lock`);
  /* Both stay minimal, which is what replaced the directive. They grew by ~80 characters
     in the dynamic-drape revision and that is NOT this clause creeping back: it is the
     per-frame adaptation sentence, which says nothing about the subject being absent (the
     bound below is per branch so that spend cannot be mistaken for room, and the "as soon
     as visible" absence is asserted separately, twice, right here and below). */
  check("...and both are still minimal, which is what replaced it",
    top.length <= 360 && bot.length <= 360 && !/as soon as visible/.test(bot),
    `tops=${top.length} bottoms=${bot.length}`);
  /* The clause itself must stay on file, or "one line to re-add" stops being true. */
  check("...but the clause is still ON FILE, so the restore really is one line",
    /TEMPORAL_PERSISTENCE = Object\.freeze\(\{[\s\S]{0,600}?bottom:/.test(SRC),
    "a restore path that requires rewriting the clause is not a restore path");
  /* "as soon as visible" is the half that does the late-entry work: it tells the model
     the subject may not be there yet, which is exactly the frame the old prompt had no
     language for. Asserted so a reword cannot quietly drop it from the branch that has it. */
  check("'as soon as visible' is gone from both - the prompt half is fully retired",
    !/as soon as visible/.test(top) && !/as soon as visible/.test(bot),
    "recorded as a loss; the runtime half below is what still covers late entry");
  /* THE NON-PROMPT HALF OF THE FEATURE COVERS BOTH CATEGORIES REGARDLESS, which is what
     keeps the bottoms loss survivable - asserted here so the two halves cannot both be
     removed on the assumption that the other one is holding. */
  check("...and the gate + watcher remain category-agnostic, covering bottoms either way",
    /awaitBodyPresence\(isBottomsGarment\(activeItem\)\)/.test(SRC) &&
    /startPresenceWatcher\(\);/.test(SRC),
    "the prompt lost its half on bottoms; the runtime half must still run for both");
  check(`both still fit the ${CONFIG.PROMPT_MAX_CHARS}-char budget`,
    top.length <= CONFIG.PROMPT_MAX_CHARS && bot.length <= CONFIG.PROMPT_MAX_CHARS,
    `tops=${top.length} bottoms=${bot.length}`);
  check("the category anchor still leads - persistence language must not displace it",
    /^Fit ONLY the exact reference shirt onto the subject's upper torso across this unified continuous frame\./.test(top) &&
    /^Fit ONLY the exact reference pants\/shorts onto the subject's lower body across this unified continuous frame\./.test(bot),
    "each branch must open on its own anchor, whatever else it carries");
}

console.log("\n── §7 THE OVERLAY: bilingual, and never left on screen ──");
{
  check("the overlay element exists in the markup",
    /id="presenceOverlay"/.test(HTML), "the gate needs something to say why it is waiting");
  check("...carrying the spec'd Hebrew and English copy",
    HTML.includes("נא להתייצב מול המצלמה") && /Please step into the frame/i.test(HTML),
    "every user-facing string in this app is bilingual");
  check("...and is hidden by default, so it cannot flash on load",
    /id="presenceOverlay"[^>]*hidden/.test(HTML));
  check("it is styled and does not intercept clicks over the video",
    /#presenceOverlay/.test(CSS) && /#presenceOverlay[\s\S]{0,400}?pointer-events:\s*none/.test(CSS));
  check("it is hidden again on every go-live exit path, not just the happy one",
    (SRC.match(/hidePresenceOverlay\(\)/g) || []).length >= 2,
    "an overlay stuck over a working session is worse than the bug it explains");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
