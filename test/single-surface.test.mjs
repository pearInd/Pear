/* ONE DISPLAY SURFACE - the architectural fence.

   THREE SEPARATE REPORTS of the same symptom got us here: the fitting frame rendering as
   two zones, Decart's AI output on top and a raw camera feed or black block underneath.
   Each time the fix was narrower than the problem:

     1st - the compositing guard was rendering a black band; it was turned OFF by config.
     2nd - the stitched full-look reference had a 200px black bar in it; that came out.
     3rd - the split was reported AGAIN, and the guard - still present, one flag away from
           painting a raw-camera band over half the frame - was deleted outright.

   A FLAG IS NOT AN ARCHITECTURE. The lesson this suite encodes is that "the hybrid
   renderer is disabled" is a weaker guarantee than "there is no hybrid renderer", and the
   difference is one config edit made by someone who has not read three bug reports.

   THE INVARIANT, stated once: the shopper's display shows exactly ONE source at a time,
   and while a session is live that source is Decart's WebRTC stream and nothing else. The
   camera feeds Decart as INPUT; it never reaches the screen as output.

   WHY IT IS ASSERTED ACROSS THREE FILES: the invariant is not expressible in any one of
   them. app.js decides what gets drawn, index.html decides what elements exist, style.css
   decides which are visible. A split can be reintroduced through any of the three, so all
   three are checked here rather than trusting each file's own suite to notice. */
import { readFileSync } from "node:fs";

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

console.log("── §1 THE MEDIA STACK: three elements, three distinct roles ──");
{
  const videos  = CARD.match(/<video\b[^>]*id="([^"]+)"/g)  || [];
  const canvases = CARD.match(/<canvas\b[^>]*id="([^"]+)"/g) || [];
  const ids = [...videos, ...canvases].map((t) => t.match(/id="([^"]+)"/)[1]).sort();

  /* EXACTLY THREE, AND EXACTLY THESE. A fourth is how the overlay guard got here the first
     time - it was added as an "additive only" layer stacked above #aiVideo, which is
     precisely the shape of the reported artifact. */
  check("exactly three media elements in the card - no more, no fewer",
    ids.length === 3, JSON.stringify(ids));
  check("...and they are exactly #webcam, #aiVideo, #resultCanvas",
    JSON.stringify(ids) === JSON.stringify(["aiVideo", "resultCanvas", "webcam"]),
    JSON.stringify(ids));
  /* THE DELETED OVERLAY, named so a revert is loud rather than quiet. */
  check("the #lowerBodyGuard overlay canvas is gone from the markup",
    !/lowerBodyGuard/.test(HTML),
    "an overlay canvas stacked over #aiVideo is the reported split, by construction");

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

console.log("\n── §3 NOTHING DRAWS THE CAMERA ONTO THE DISPLAY ──");
{
  /* THE JS HALF. The guard painted raw #webcam pixels over Decart's output on three
     surfaces at once - the live overlay canvas, the recorder, and the frozen frame - so
     all three are checked. These are absence assertions on purpose: the failure mode is
     something being ADDED back, not something changing shape. */
  check("no compositing-guard function survives",
    !/paintGuardBand/.test(APP) && !/function guardBand/.test(APP) &&
    !/guardedRegion/.test(APP) && !/startLowerBodyGuard/.test(APP) &&
    !/stopLowerBodyGuard/.test(APP) && !/lowerBodyGuardRAF/.test(APP),
    "flag-off left the mechanism one config edit away from painting a split again");
  check("...no guard state variables either",
    !/bodyGuardLine/.test(APP) && !/bodyGuardTorso/.test(APP) &&
    !/lowerBodyGuardFrac/.test(APP) && !/calibrateLowerBodyGuard/.test(APP));
  check("...and no config constant can turn one back on",
    !/LOWER_BODY_GUARD/.test(CFG) && !/BODY_GUARD_MARGIN_FRAC/.test(CFG),
    "a constant with no consumer reads as a promise that the consumer is coming back");

  /* THE RECORDER draws #aiVideo and only #aiVideo, so the saved clip is the same single
     surface the shopper watched rather than a differently-composited one. */
  const recorder = APP.slice(APP.indexOf("recordCanvas.width !== w"));
  check("the recorder paints #aiVideo alone - the clip matches what was on screen",
    /ctx\.drawImage\(video, 0, 0, w, h\);\s*\n\s*beginRecorder\(\);/.test(recorder),
    "a clip composited differently from the live view is a second renderer");

  /* EVERY REMAINING drawImage OF THE WEBCAM must be off-DOM. Enumerated by name so a new
     one has to be justified here rather than slipped in. */
  const webcamDraws = (APP.match(/drawImage\(\s*(webcam|\$\("webcam"\)|v)\b/g) || []).length;
  check("the surviving webcam readbacks are the known off-DOM ones only",
    webcamDraws <= 3 &&
    /function sampleVideoLuma/.test(APP) &&      // 64x36 luma probe, off-DOM
    /async function renderMockDemo/.test(APP),   // ?demo=1 only, never a live session
    `${webcamDraws} drawImage(webcam|v) sites - expected the luma probe, the mock demo, and no more`);
  check("...and freezeFinalFrame composites nothing over the AI frame it captures",
    !/if \(!mirror\) paintGuardBand/.test(APP),
    "the saved masterpiece must be the same surface the shopper watched");
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
