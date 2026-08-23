/* ONE CONTINUOUS SURFACE - the architectural fence.

   THREE SEPARATE REPORTS of the same symptom got us here: the fitting frame rendering as
   two zones, Decart's AI output on top and a raw camera feed or black block underneath.
   Each time the fix was narrower than the problem:

     1st - the compositing guard was rendering a black band; it was turned OFF by config.
     2nd - the stitched full-look reference had a 200px black bar in it; that came out.
     3rd - the split was reported AGAIN, and the guard - still present, one flag away from
           painting a raw-camera band over half the frame - was deleted outright.

   ── AND THEN THE DIAGNOSIS TURNED OUT TO BE WRONG ──────────────────────────────
   The guard is back, because restoring it revealed what those three reports were actually
   filed against. updateBodyGuardLine() - the function that reads the shopper's hip line,
   the entire justification for the boundary - was called from inside a `if
   (frameTimingDebug)` block against a `result` that does not exist in that scope. It never
   ran. Every reported session used the fixed-fraction fallback that config.js had already
   predicted would fail in exactly this way, sourced from an element that is
   visibility:hidden while a session is live, composited with a hard edge. Three defects,
   none of them "the mechanism is wrong".

   SO THIS SUITE CHANGED SHAPE, from "no hybrid renderer may exist" to "a hybrid renderer
   may exist ONLY in the shape that answers all three defects". The weaker guarantee is
   deliberate and the stronger assertions moved rather than went away: what is fenced now is
   the source it reads, the boundary it derives, and the edge it draws. The absence checks
   they replaced were guarding a mechanism that had never actually been given a fair run.

   THE INVARIANT, restated for what it is now: the shopper's display shows ONE CONTINUOUS
   SCENE. Exactly one element carries a live stream, exactly one carries the frozen result,
   and any compositing over the live frame must be geometrically aligned to it, sourced from
   pixels that are guaranteed to exist, and blended rather than butted.

   WHY IT IS ASSERTED ACROSS THREE FILES: the invariant is not expressible in any one of
   them. app.js decides what gets drawn, index.html decides what elements exist, style.css
   decides which are visible. A split can be reintroduced through any of the three, so all
   three are checked here rather than trusting each file's own suite to notice. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

/* Read from the REAL config module, not a regex over its text: the feather is the
   deletion's one stated condition for this mechanism existing at all, so what matters is
   the value the browser will actually load. */
const CONFIG_FEATHER = CONFIG.BODY_GUARD_FEATHER_FRAC;

const APP  = readFileSync(new URL("../fitting-room/app.js",    import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS  = readFileSync(new URL("../fitting-room/style.css",  import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG  = readFileSync(new URL("../fitting-room/config.js",  import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The markup between the camera card's opening tag and its closing overlays. Sliced by the
   two elements that bracket the media stack, so a new <video>/<canvas> inserted anywhere
   among them is inside this window and gets counted. */
const cardStart = HTML.indexOf('<video id="webcam"');
const cardEnd   = HTML.indexOf('<div class="live-countdown"');
const CARD = HTML.slice(cardStart, cardEnd);

console.log("── §1 THE MEDIA STACK: four elements, four distinct roles ──");
{
  const videos  = CARD.match(/<video\b[^>]*id="([^"]+)"/g)  || [];
  const canvases = CARD.match(/<canvas\b[^>]*id="([^"]+)"/g) || [];
  const ids = [...videos, ...canvases].map((t) => t.match(/id="([^"]+)"/)[1]).sort();

  /* EXACTLY FOUR, AND EXACTLY THESE. The count is still fenced - a FIFTH element is how a
     second renderer would arrive - but the guard overlay is now one of the four by design
     rather than a violation. What makes it safe is not its absence; it is §3. */
  check("exactly four media elements in the card - no more, no fewer",
    ids.length === 4, JSON.stringify(ids));
  check("...and they are exactly #webcam, #aiVideo, #lowerBodyGuard, #resultCanvas",
    JSON.stringify(ids) === JSON.stringify(["aiVideo", "lowerBodyGuard", "resultCanvas", "webcam"]),
    JSON.stringify(ids));
  /* THE OVERLAY IS ADDITIVE AND MUST STAY THAT WAY: above #aiVideo in DOM order, never
     intercepting input, never visible outside a live session. */
  check("the guard overlay is stacked above #aiVideo and cannot take a gesture from it",
    HTML.indexOf('id="aiVideo"') < HTML.indexOf('id="lowerBodyGuard"') &&
    /#lowerBodyGuard\s*\{[^}]*pointer-events:\s*none/.test(CSS),
    "additive only - #aiVideo keeps its role untouched");

  /* EACH ROLE, asserted where it is actually established rather than assumed from the id.
     #webcam is the capture source and MUST stay - Decart cannot be fed without it - so the
     guarantee is not "no camera element" but "the camera element never shows". */
  check("#webcam exists as the CAPTURE source - it is required, not leftover",
    /localStream/.test(APP) && /v\.srcObject = localStream;/.test(APP),
    "removing it would leave nothing to feed Decart");
  check("#aiVideo is bound to Decart's remote stream, and is the only element that is",
    /aiVideo\.srcObject = editedStream;/.test(APP) &&
    (APP.match(/\.srcObject = editedStream/g) || []).length === 1,
    "two elements carrying the edited stream is two surfaces to disagree");
}

console.log("\n── §2 NEVER CONCURRENT: one visible source at a time ──");
{
  /* THE CSS IS HALF THE INVARIANT. Even with one source per element, two elements visible
     at once is a split - so the state classes have to hide the others, and that is checked
     here rather than left to a screenshot. */
  check("the three share ONE full-bleed rule: inset 0, 100% x 100%, object-fit cover",
    /\.camera-card #webcam,\s*\n\.camera-card #aiVideo,\s*\n\.camera-card #resultCanvas \{\s*\n\s*position: absolute; inset: 0; width: 100%; height: 100%;\s*\n\s*object-fit: cover;/.test(CSS),
    "a element that is not full-bleed leaves a band of something else showing");
  check("#aiVideo is display:block while live - the specified framing",
    /\.camera-card\.show-live #aiVideo \{ display: block;/.test(CSS));
  check("...and #webcam is hidden in that same state",
    /\.camera-card\.show-live #webcam \{ visibility: hidden; \}/.test(CSS),
    "the camera showing next to the AI feed IS the reported artifact");
  check("...and #aiVideo is display:none until then, so it cannot show unconditioned frames",
    /\.camera-card #aiVideo \{ display: none; \}/.test(CSS));
  check("#resultCanvas shows ONLY in .show-result, never during a live session",
    /\.camera-card #resultCanvas \{ display: none;/.test(CSS) &&
    /\.camera-card\.show-result #resultCanvas \{ display: block; \}/.test(CSS) &&
    /\.camera-card\.show-result #webcam \{ visibility: hidden; \}/.test(CSS));
  /* NO SURVIVING RULE MAY POSITION A MEDIA ELEMENT AS A PARTIAL BAND. Any top/bottom/height
     override on one of the three would carve the frame in two even with a single source. */
  /* Comments stripped first: this file's comments mention #aiVideo by name, and a naive
     selector match runs straight through one into whatever rule follows it. */
  const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const partial = (cssNoComments.match(/[^{}]*#(webcam|aiVideo|resultCanvas)[^{}]*\{[^}]*\}/g) || [])
    .filter((r) => /height:\s*(?!100%|auto)\d/.test(r) || /\btop:\s*\d?\d%/.test(r));
  check("no CSS rule gives any of the three a partial height or a mid-frame offset",
    partial.length === 0, partial.join(" | "));
}

console.log("\n── §3 THE COMPOSITE IS BOUNDED: source, boundary, edge ──");
{
  /* THE THREE DEFECTS, each fenced where it lives. These replaced a block of absence
     assertions ("no guard code may exist"), and the trade is deliberate: absence was
     protecting a mechanism that had never been given a fair run, because its boundary
     never once executed. What is fenced now is the shape, not the existence.
     lower-body-guard.test.mjs owns the behaviour; this owns the architecture. */

  /* DEFECT 1 - THE BOUNDARY. updateBodyGuardLine() fails SILENTLY on anything it cannot
     read, so a wrong call site produces no error anywhere: just a guard permanently on its
     fallback. That is precisely what shipped, through three bug reports. */
  const watcher = APP.slice(
    APP.indexOf("presenceWatcherTimer = setInterval"),
    APP.indexOf("function stopPresenceWatcher"));
  check("the guard boundary is read in the pose loop, where a real result exists",
    /updateBodyGuardLine\(result\)/.test(watcher) &&
    (APP.match(/^\s*updateBodyGuardLine\(/gm) || []).length === 1,
    "its previous call site was a debug block with no pose result in scope - it never ran");
  /* Comments stripped: the call site's own comment names the debug block it used to live
     in, so a raw scan matches the explanation rather than the code it warns about. */
  const watcherCode = watcher.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("...and not behind a debug flag, which is where it was lost",
    !/if \(frameTimingDebug\)[\s\S]*?updateBodyGuardLine/.test(watcherCode) &&
    !/if \(frameTimingDebug\)/.test(watcherCode.slice(0, watcherCode.indexOf("updateBodyGuardLine"))),
    "a boundary that only tracks while logging is on is not a boundary");

  /* DEFECT 2 - THE SOURCE. #webcam is visibility:hidden for all of .show-live while the
     input throttle re-negotiates the shared camera source underneath it, so a readback off
     it can return nothing - and nothing, composited over half a frame, is the reported
     black rectangle. */
  check("the guard sources the throttle's canvas first, not the hidden #webcam element",
    /function guardSource/.test(APP) &&
    /const cv = inputThrottle && inputThrottle\.canvas;/.test(APP),
    "those are the frames being sent to Decart - they cannot be blank while a session runs");
  check("...and #webcam survives only as the explicit fallback, mirror-corrected",
    /if \(cv && cv\.width > 0 && cv\.height > 0\) \{[\s\S]{0,200}mirror: false/.test(APP) &&
    /videoWidth > 0\) \{[\s\S]{0,120}mirror: true/.test(APP),
    "the throttle canvas is already mirrored; the webcam's decoded frame never is");

  /* DEFECT 3 - THE EDGE. The deletion's stated condition for any restore. */
  check("the boundary is feathered, and the ramp is configurable but non-zero by default",
    /BODY_GUARD_FEATHER_FRAC/.test(CFG) &&
    /GUARD_FEATHER_SLICES/.test(APP) &&
    CONFIG_FEATHER > 0,
    `BODY_GUARD_FEATHER_FRAC = ${CONFIG_FEATHER} - a hard edge is the reported defect`);
  check("...and the alpha ramp is actually applied, not merely declared",
    /ctx\.globalAlpha = alpha;/.test(APP),
    "a constant with no consumer is a comment, not a blend");

  /* GEOMETRY. The overlay bitmap and the video underneath must agree about which pixels are
     which, or a band painted at "the hip line" lands somewhere else entirely. */
  check("the overlay canvas is sized to #aiVideo, matching the frame it composites over",
    /const w = ai\.videoWidth, h = ai\.videoHeight;/.test(APP),
    "sizing it to the camera is how the two layers came to disagree");
  check("...and CSS gives it the same object-fit as the layers beneath it",
    /#lowerBodyGuard \{[\s\S]{0,200}object-fit: cover;/.test(CSS),
    "a stretched overlay over a centre-cropped video cannot align");

  /* THE RECORDER AND THE FROZEN FRAME must composite identically to the live view, or the
     saved clip is a second renderer disagreeing with the one the shopper watched. */
  const recorder = APP.slice(APP.indexOf("recordCanvas.width !== w"));
  check("the recorder draws #aiVideo then the SAME guard helper over it",
    /ctx\.drawImage\(video, 0, 0, w, h\);\s*\n\s*paintGuardBand\(ctx, w, h\);/.test(recorder),
    "a clip composited differently from the live view is a second renderer");
  check("...and all three consumers go through one helper, never their own arithmetic",
    (APP.match(/paintGuardBand\(ctx, w, h\);/g) || []).length === 3,
    "the band was written out twice once before, and the two copies drifted");

  /* EVERY REMAINING drawImage OF THE WEBCAM must be off-DOM or the guard's own fallback.
     Enumerated so a new one has to be justified here rather than slipped in. */
  const webcamDraws = (APP.match(/drawImage\(\s*(webcam|\$\("webcam"\)|v)\b/g) || []).length;
  check("the surviving direct webcam readbacks are the known off-DOM ones only",
    webcamDraws <= 3 &&
    /function sampleVideoLuma/.test(APP) &&      // 64x36 luma probe, off-DOM
    /async function renderMockDemo/.test(APP),   // ?demo=1 only, never a live session
    `${webcamDraws} drawImage(webcam|v) sites - expected the luma probe, the mock demo, and no more`);
}

console.log("\n── §4 THE INPUT PATH IS UNTOUCHED - camera in, Decart out ──");
{
  /* DELETING THE DISPLAY-SIDE HYBRID MUST NOT BREAK THE INPUT SIDE. The camera still has
     to reach Decart, cover-fitted to the model's frame, or there is nothing to render. */
  check("the camera is still cloned into the throttled input stream",
    /const camClone = new MediaStream\(localStream\.getVideoTracks\(\)\.map\(\(t\) => t\.clone\(\)\)\)/.test(APP),
    "the guard's removal must not touch what feeds the model");
  check("...cover-fitted to the model's frame, so no letterbox bar is ever sent",
    /const scale = Math\.max\(width \/ vw, height \/ vh\);/.test(APP),
    "contain-fit would letterbox - which is a black bar in the INPUT, the same defect upstream");
  check("...and Decart's returned stream is what reaches the element",
    /onRemoteStream: \(editedStream\) =>/.test(APP));
  /* THE PROMPT HALF OF THE SAME INVARIANT, so the two cannot drift apart. */
  /* The prompt half of the same invariant, so the two cannot drift apart. The wording is
     per-category again (see garment-category-prompt.test.mjs), so what is asserted here is
     the property both branches must share: the non-target region and the background are
     preserved rather than re-rendered, which is what keeps the frame one continuous scene. */
  /* Concatenated string literals wrap across lines in app.js (`"..." + "\n    "..."`),
     so a straight substring match on the assembled sentence would break on formatting
     alone. Collapsed once here rather than fought with an escalating regex. */
  const flat = APP.replace(/"\s*\+\s*\n\s*"/g, "");
  check("both anchors preserve the opposite layer AND the background, unchanged",
    /Strictly preserve the user's natural proportions, face, lower body, and background\./.test(flat) &&
    /Strictly preserve the user's natural proportions, face, upper body, and background\./.test(flat),
    "the client stopped compositing the frame; the prompt must not ask the model to either");
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
