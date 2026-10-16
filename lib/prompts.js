/* =============================================================================
   PEAR · The prompt engine - every word Decart is told, server-side
   -----------------------------------------------------------------------------
   WHY THIS LIVES HERE AND NOT IN THE BROWSER. Until 2026-09-26 the whole engine
   shipped inside fitting-room/app.js: the category anchors and their construction
   variants, the closure lock, the identity/colour/print sentence, the size-delta
   ladder, the clause priorities and the budget that sheds them - and, around it, the
   restore seam (DENSE, the composite contract, the side-profile and lateral-seam
   clauses) that records every wording that was tried and why it lost. The browser
   now asks POST /api/prompt for the ONE string a dispatch needs and receives only
   that string - which Decart then sees on the wire anyway. Everything else stays
   here (CLAUDE.md §2.13; lib/ is not a public directory).

   MOVED, NOT REWRITTEN. The blocks below are the browser's text verbatim, comments
   included, in their original order: REAR_POSE … COMPOSITE_QUALITY, then the shared
   prompt slice (from the priority table P to the full-look composite clause - most
   prompt suites extract and execute exactly that span, by its opening and closing
   lines, so this header must never quote either of them: CLAUDE.md §2.6), then
   LOOK_CLAUSE/CUSTOM_BACK_INFERRED,
   angleClause(), getAnatomicalAnchor(), getFitModifier() … buildCustomPrompt(), and
   buildLookPrompt(). The old in-browser engine and this one were run over the same
   corpus of garments × angles × size deltas and produced byte-identical strings
   (see the commit that moved them); `npm run trace:prompt` now traces this file.

   WHAT THE BROWSER STILL DECIDES, AND SENDS: isBottomsGarment() (it also drives the
   size chart and the go-live gate - see the server copy below), and the size delta
   (getSizeDelta() reads the shopper's ladder). Everything the builders read off the
   garment is plain data (name/type/category/subType/garmentType/colorHex/textOcr/
   backIsPlain/_backLooksPrinted/fabric) - see sanitizePromptRequest().

   DEAD CODE IS STILL DEAD. getAnatomicalAnchor() reads DOM inputs and angleClause()
   reads live orientation state; neither is reachable from imageOnlyPrompt() or
   lookAnchorPrompt() (trace:prompt's audit), and both would need their inputs passed
   in before any restore. They are here because they are wording, and wording is what
   this file keeps out of the browser.
   ============================================================================= */
import { CONFIG } from "../fitting-room/config.js";

/* The Decart budget, from the same config the browser reads (CLAUDE.md §0). */
const { PROMPT_MAX_CHARS } = CONFIG;

/* The size delta for the prompt being built - set per request by promptForRequest()
   (the browser resolves it from the shopper's ladder, getSizeDelta() in app.js). The
   builders below are synchronous, so a request can never observe another's value. */
let _requestSizeDelta = 0;
function getSizeDelta() { return _requestSizeDelta; }

/* RETIRED FROM THE PROMPT PATH, and now read by nothing - kept for the record.
   These two built the garment description every builder used to open with ("white
   short-sleeve t-shirt"). The image-first refactor deleted that sentence: a text
   description is something a diffusion model can satisfy out of its own prior instead
   of out of the reference pixels, which is how a Spider-Man tee came back as a tuxedo.
   See garmentAnchor(). Left in place because a subType→English map is the obvious thing
   to reach for the next time something needs to NAME a garment (a share caption, an alt
   attribute, an analytics label) - just never a VTON prompt. */
const SUBTYPE_PROMPT = {
  sleeveless: "sleeveless", short_sleeve: "short-sleeve", long_sleeve: "long-sleeve",
  slim: "slim-fit", regular: "regular-fit", wide: "wide-leg",
};
const SHIRT_NOUN = { sleeveless: "tank top", short_sleeve: "t-shirt", long_sleeve: "long-sleeve shirt" };

/* The rear POSE sentence, factored out of the three back clauses below for the same
   reason COMPOSITE_POSE is split from COMPOSITE_APPLY: all three opened with this exact
   sentence, and it is the one part of them that stops being true mid-turn. The garment
   instructions that follow it (reproduce the back print / infer a plain rear / the custom
   variant) stay correct at every angle, because the orientation lock that selected them
   has not moved. Concatenation below is byte-identical to the previous strings. */
const REAR_POSE =
  " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera.";
/* Its edge-on replacement. Same locked side, truthful rotation, plus the explicit ban on
   de-rotating - see COMPOSITE_POSE's comment for why asserting a square rear view while
   the shopper is side-on is what flattens their real profile volume. */
const REAR_POSE_PROFILE =
  " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right" +
  " angle to the camera - part-way through turning away, so the back of the garment faces off to" +
  " one side rather than squarely toward you. Render them at the exact rotation shown in the live" +
  " frame: do NOT rotate, straighten or re-pose them back to a square rear view.";
/* The garment half of each back clause, kept separate so either pose above can lead it. */
const BACK_TAIL = {
  real:
    " This reference photo shows the BACK of the garment: reproduce it faithfully - its back panel, rear yoke, back collar, rear hemline and especially any back graphics, prints, logos or lettering - keeping each element at the SAME size, height and horizontal position on the garment as in the reference, wrapping naturally around the body. Do not move, rescale, re-center or omit the back print, and do NOT render the front of the garment.",
  inferred:
    " Render the BACK of the garment: its back panel, rear yoke, back collar, rear hemline and the seams the cut implies, wrapping naturally around the body from the rear. This reference photo shows the FRONT of the garment, so you must INFER the corresponding rear from it. The back is a clean, plain expression of the same fabric, colour and texture: do NOT copy, mirror, repeat or relocate the front chest print, front logo, front lettering, buttons, placket, zipper or front pockets onto the back. Unless the garment's cut clearly implies a back panel print, the back carries NO graphic at all. Do NOT render the front of the garment.",
  custom:
    " Render the BACK of this custom garment. The back of the garment must be a clean, plain version of the" +
    " front's fabric and color, strictly without the front graphics or logos. Maintain the same seams," +
    " material texture, and drape as the front view. Do not mirror front-specific details to the back." +
    " Negative constraint - avoid printing, logos, or graphic motifs on the back side.",
};

const ANGLE_CLAUSE = {
  front: "",
  // Back, REAL rear reference: the active image IS a dedicated back photo. Tell Lucy to
  // REPRODUCE it - and pin the print's size/position to the reference so the graphic
  // doesn't drift, rescale or re-center between frames (the back-alignment ask).
  backReal: REAR_POSE + BACK_TAIL.real,
  /* Back, INFERRED rear: no dedicated back photo - the active image IS the front, so
     Lucy must infer a plausible rear from it (graceful fallback; placement can't be
     pinned). THE PRINT-DUPLICATION FIX: the previous wording asked for "any back
     graphics, prints or seams" while the only graphic in view was the FRONT chest
     print - so the model dutifully reproduced that print on the back. The reference
     is now named as the front explicitly, front-only elements are enumerated as
     forbidden (the model cannot avoid what it hasn't been told to avoid), and the
     default rear is stated as PLAIN. Mirrors CUSTOM_BACK_INFERRED, which already
     carried this constraint and did not exhibit the bug. */
  backInferred: REAR_POSE + BACK_TAIL.inferred,
  side:  " The person is viewed from the SIDE in profile: render the garment's side profile - shoulder line, sleeve, side seam and the way the fabric drapes along the flank - in an accurate three-quarter/profile perspective.",
  // AI Auto, facing camera: the reference is ONE clean front asset (no composite), so the
  // clause pins it explicitly as the front and forbids inventing rear details - the
  // orientation contract that makes Context-Aware Asset Switching bleed-proof.
  autoFront:
    " This reference photo shows the FRONT of the garment. The person is facing the camera:" +
    " reproduce the garment's front faithfully - its front panel, collar, closure, hemline and" +
    " any front graphics, prints, logos or lettering - keeping each element at the SAME size," +
    " height and horizontal position as in the reference. Do NOT render the back of the garment.",
  /* Single-asset counterpart of COMPOSITE_POSE.profileFront - same reasoning, same fix,
     for the path where the reference is one photo rather than a stitched pair. autoFront
     above opens by asserting "The person is facing the camera", which is the sentence
     that has to go when they are edge-on; the garment side it names is still correct,
     because the orientation lock did not move. */
  autoProfile:
    " This reference photo shows the FRONT of the garment. The person is TURNED TO THEIR SIDE," +
    " seen EDGE-ON in side profile at roughly a right angle to the camera, so the garment's front" +
    " faces off to one side rather than toward you: render the garment in that true side-on" +
    " perspective - the shoulder line, sleeve, side seam and the way the fabric drapes along the" +
    " flank - keeping its colour, texture and any visible front graphics faithful to the reference." +
    " Do NOT rotate, straighten or re-pose the person back toward the camera, and do NOT re-render" +
    " this as a front-facing shot.",
};

/* ── Side-profile depth fidelity - the volume that only exists edge-on ────────
   THE BUG THIS EXISTS FOR: a shopper with real torso depth (the test case was a pillow
   under a shirt) turns 90 degrees and the rendered body comes back flat - the garment
   drapes over a generic torso instead of over their actual projection.

   The mechanism is a blind spot in the prompt, not in the detector. Head-on, the body's
   width carries its shape and STRICT_INPAINT's "do not slim, flatten or idealize" is
   phrased for exactly that: it enumerates waist circumference and torso WIDTH. Edge-on,
   width is foreshortened to nearly nothing and the entire silhouette is DEPTH - how far
   the chest and stomach project forward, how the back curves behind. No clause in the
   prompt named that axis, so nothing defended it, and a diffusion model with a strong
   prior toward flat profiles had no instruction standing against that prior at precisely
   the angle where it is most exposed. This names the axis and pins it to the live frame's
   own silhouette edge, which is the only ground truth available in a pipeline with no
   depth sensor and no mesh.

   Complements rather than repeats its neighbours: PROFILE_ANOMALY_GUARD scopes out what
   is NOT body (held objects, lens distortion) while turned; this asserts what IS body and
   must survive. STRICT_INPAINT's ABSOLUTE BODY FIDELITY still governs at every angle -
   this is its profile-axis form, not a replacement. */
/* Structured as four numbered directives rather than one paragraph. Position and framing
   both matter for this model: the clause leads with WHERE THE BODY IS, because every
   instruction after it is relative to that, and the numbering keeps the four asks
   individually addressable instead of dissolving into a wall of qualifiers. */
const SIDE_PROFILE_DEPTH =
  " SIDE-PROFILE DEPTH FIDELITY - four requirements for this frame." +
  " (1) ORIENTATION: the person is positioned EDGE-ON, IN SIDE PROFILE, facing LATERALLY" +
  " relative to the camera frame - turned roughly a right angle away from the lens, so you" +
  " see the side of their body rather than its front or its back." +
  " (2) GROUND TRUTH: the lateral silhouette edge in the live frame - including any abdominal" +
  " curve, stomach or belly projection, chest depth, curve of the lower back and seat, and the" +
  " bulk of the clothing itself - is ABSOLUTE GROUND TRUTH and overrides any assumption you" +
  " hold about how a body is shaped. Because they are edge-on, that outline is their real" +
  " FRONT-TO-BACK DEPTH, not their width. Trace it exactly as it is. Any protrusion, bulge," +
  " overhang, rounding or expansion along that edge is REAL BODY VOLUME and must be preserved" +
  " at its exact depth, height and position, however far it extends." +
  " (3) FORESHORTENING: maintain the full side-view foreshortening exactly as captured. Do NOT" +
  " rotate, turn or twist the person's chest, waist, hips or shoulders back toward the front" +
  " camera view, and do NOT widen the torso back toward a front-facing silhouette. Do NOT" +
  " substitute a typical, average, slimmer, athletic or idealized profile; do NOT flatten," +
  " straighten, compress or pull the stomach, chest, belly or back edge inward toward the" +
  " spine; do NOT reduce the torso's front-to-back thickness." +
  " (4) DRAPE: wrap and drape the selected garment fabric seamlessly over those exact profile" +
  " contours, preserving their true physical depth - the side seam following their real side" +
  " contour, the fabric projecting outward wherever their body does, falling from the point of" +
  " greatest protrusion with natural tension, creases and fold shadows beneath it." +
  " Fit the garment to the body's true volume; never the body to the garment.";

/* ── Lateral seam synthesis - the band that NO reference view depicts ─────────
   THE GAP THIS FILLS, and why it is not the same gap SIDE_PROFILE_DEPTH fills. That
   clause is about the BODY: it pins the silhouette edge as ground truth so the shopper's
   real front-to-back volume survives. This one is about the GARMENT covering that edge.

   At 90 degrees the camera sees a band of the garment that neither reference view
   contains - the flank, the side seam, the underarm, the outer face of the sleeve. The
   composite holds a FRONT panel and a BACK panel; the side is the hinge between them and
   is photographed by neither. With nothing in the prompt naming that band, the model is
   inpainting a region it has no reference for, and the cheapest completion available to
   it is the pixels already there: the shopper's own real shirt. That is the "it drops the
   garment when I turn" report, and it is a DIFFERENT mechanism from the reversion
   ROTATION_CONTINUITY covers (that one is about the turn as a temporal event; this is
   about a spatial region being unreferenced at the moment of peak exposure).

   WHY THIS DOES NOT SAY "BLEND THE TWO PANELS", which is the obvious phrasing and the
   wrong one. COMPOSITE_PANEL_CONTRACT opens the prompt by calling the boundary between
   the panels an impassable wall, and COMPOSITE_APPLY then retires the unselected panel
   outright ("does not exist for this frame"). Instructing a blend here would contradict
   the two strongest, earliest instructions in the prompt, and the way that contradiction
   resolves in practice is already on the record: rendering both panels' designs on one
   surface is the double-print regression that got the previous stitcher removed in
   23f5953. So the synthesis is specified GEOMETRICALLY - the garment wraps, the side seam
   is where the wrap turns - while the locked panel remains the only texture source and
   the unreferenced band is filled by EXTRAPOLATING its cloth, never by dragging the
   opposite panel's graphics around the body. Continuity of fabric, not of print.

   Prompt-only, so it costs nothing at runtime: it rides the same assembly path every
   other clause does and is re-asserted by the existing re-anchor cadence. */
const LATERAL_SEAM_SYNTHESIS =
  " LATERAL SEAM SYNTHESIS - the side of the garment must be PREDICTED, not skipped." +
  " No reference view depicts the narrow lateral band now facing the camera: the flank," +
  " the side seam, the underarm and the outer face of the sleeve. Synthesize it." +
  " (1) CONTINUITY MANDATE: hold 100% garment replacement coverage across the entire" +
  " visible torso for every frame of the turn. There must be no frame, and no region of" +
  " any frame, in which the target garment thins, breaks, fades, turns transparent or lets" +
  " the person's own original shirt - its colour, collar, sleeves or hem - show through" +
  " anywhere, least of all along the flank, the shoulder line or the underarm." +
  " (2) WRAP: render how this garment continues around the torso's lateral depth - the" +
  " side seam running down their real side contour, the shoulder seam and sleeve head" +
  " turning with the shoulder, the hem closing unbroken around the flank, and the fabric" +
  " folding and gathering where the arm meets the body." +
  " (3) EXTRAPOLATE, NEVER RELOCATE: carry the colour, weave, sheen, material thickness" +
  " and fold behaviour of the reference view named above outward across that band, so the" +
  " side reads as the same garment in the same cloth and the transition into it is smooth" +
  " and gradual, with no hard edge, colour step, seam artifact or texture break. Where the" +
  " reference depicts no lateral detail, infer PLAIN fabric in that same colour and" +
  " texture. Do NOT drag, mirror, wrap or repeat the reference's graphics, prints, logos" +
  " or lettering around onto the side to fill it, and do NOT invent new ones there.";

/* ── Stitched Garment Composite - orientation clauses ────────────────────────────
   Deliberately modelled on LOOK_CLAUSE below, which is the in-repo proof that a
   labelled two-panel reference works with this model: name the panels, forbid
   cross-panel sampling in absolute terms, and state that the markers are guides that
   must never be painted onto the garment.

   The critical difference from the composite that was removed in 23f5953: that one
   left the model to decide which half applied. Here the OrientationWatcher has
   already resolved that, so exactly ONE panel is ever named as the source, and the
   other is explicitly excluded. The model is never asked to choose. */
/* The panel contract. States WHAT the reference image is, before anything else in the
   prompt describes the garment or the body. Everything downstream (COMPOSITE_SELECT,
   buildCompositePrompt) assumes this has already been said. */
const COMPOSITE_PANEL_CONTRACT =
  "High-quality, realistic virtual try-on." +
  " The garment reference is a SPLIT COMPOSITE IMAGE containing two views of the SAME garment," +
  " side by side: the LEFT HALF is the FRONT view, the RIGHT HALF is the BACK view." +
  " Treat the boundary between them as an impassable wall - never blend, mirror or copy any" +
  " detail from one half into the other, and never render both halves' designs on the same" +
  " surface of the garment." +
  /* The artifact clause. Everything that is not garment in this reference - the gap between
     the panels, the studio backdrop, the canvas edges, the marker band along the bottom -
     is layout, and Lucy has no way to know that unless it is said. It samples texture from
     the whole reference, which is how a divider became a seam painted down a shirt. The
     canvas fix (seamless sampled gutter, markers moved off the garment) removes most of
     the opportunity; this removes the rest. */
  " IGNORE ALL CANVAS FURNITURE. The gap between the two halves, the background field, the" +
  " outer canvas edges and the 'FRONT'/'BACK' text markers below the panels are layout" +
  " scaffolding, NOT part of the garment. Never reproduce a boundary, divider, seam, border," +
  " frame, band or letterform from this reference onto the clothing, the body or the scene." +
  " The only lines you may render on the garment are its own real seams, stitching and hems.";

/* Temporal contract. Appended LAST so it is the final instruction in the prompt, and
   carried on BOTH orientations - flicker is not a back-view-only problem.

   Read the honest limits here before tuning it. Lucy regenerates every frame independently;
   there is no cross-frame state, no seed and no motion-guidance parameter exposed by
   @decartai/sdk@0.1.5 (realtime connect takes model/fps/width/height/mirror/resolution/
   codec, and set() takes exactly { prompt, enhance, image } - see connectRealtime()). So
   this wording is a per-frame bias toward the same result, not a temporal filter, and it
   cannot be one. The mechanical half of the flicker fix is in applyGarment(): a confirmed
   turn now re-issues the PROMPT alone instead of re-uploading the reference image, so the
   model is never briefly without a garment reference at the exact moment the shopper
   turns. That is what actually stops the print vanishing mid-rotation. */
/* Trimmed once ROTATION_CONTINUITY landed: that clause now carries the "garment stays on
   through the turn" half, so repeating it here only spent tokens against the panel
   contract. What is left is the part specific to a two-panel reference - the PRINT's
   stability, frame to frame. */
const COMPOSITE_TEMPORAL =
  " Render with smooth, temporally consistent frame-to-frame output: the garment keeps the" +
  " same colour, print placement and scale in every frame, with ZERO flickering, popping," +
  " strobing or drifting. The print must never vanish, fade or re-position between frames.";

/* Orientation selector. The OrientationWatcher has ALREADY resolved which way the shopper
   is facing, so exactly one panel is ever named as the source and the other is excluded in
   absolute terms ("does not exist for this frame") rather than merely deprioritised - the
   model is never asked to choose. The back clause is phrased as an EXTRACT-and-APPLY
   instruction, not a "reproduce the reference" one: the task is a texture transfer from a
   named region of the reference onto a named region of the body, and naming both ends of
   that transfer is what the previous wording left implicit. */
/* Split into POSE + APPLY so the two can vary independently.

   They answer different questions and only one of them depends on how far the shopper
   has turned. APPLY is a texture-transfer instruction - WHICH panel of the reference is
   the legal source - and it stays correct at every rotation, because the orientation
   lock that picked the panel is unchanged. POSE is a claim about the body in the live
   frame, and it is the half that goes WRONG the moment the shopper is edge-on: see
   COMPOSITE_POSE.profileFront for the failure it caused. The concatenation below
   reproduces the previous strings byte for byte - this is a refactor to create a seam,
   not a rewording. */
const COMPOSITE_APPLY = {
  front:
    " Apply the LEFT PANEL (FRONT view) design to the FRONT of their body: extract that panel's" +
    " exact texture, print, graphic, logo, lettering and colour and render it on the front of the" +
    " garment they are wearing - its front panel, collar, closure and hemline - keeping every element" +
    " at the SAME size, height and horizontal position it has in that panel." +
    " The RIGHT PANEL does not exist for this frame: none of its content may appear anywhere in the output.",
  back:
    " Accurately EXTRACT the exact garment texture and print from the RIGHT PANEL (BACK view) and RENDER" +
    " IT ONTO THE BACK of the person: its back print, graphic, logo, lettering, colour blocking, rear yoke," +
    " back collar and rear hemline, each kept at the SAME size, height and horizontal position it has in" +
    " that panel, wrapping naturally around the torso and following the fabric as they move." +
    " The LEFT PANEL (FRONT view) does not exist for this frame: its chest print, front logo, front" +
    " lettering, buttons, placket, zipper and front pockets must NOT appear anywhere on the back you render.",
};

/* THE 90-DEGREE POSE LIE, and why the profile variants exist.

   The orientation lock is BINARY (front | back) and, by design, it holds through a turn:
   skinRatioVote()'s dead band abstains on an ambiguous frame rather than voting, so at a
   true side-on pose the lock simply stays wherever it last was. Everything about that is
   correct for choosing an ASSET - a profile frame genuinely does not justify flipping the
   reference.

   What was not correct is that the pose sentence rode along with it. At 90 degrees the
   prompt asserted "The person is FACING FORWARD, the front of their body toward the
   camera" (or, from the other lock, "has TURNED AROUND ... no face visible") while the
   pixels showed the shopper edge-on. Lucy regenerates every frame from the prompt plus
   that frame, so a categorical pose claim that contradicts the input is not a harmless
   inaccuracy: reconciling it means rotating the torso back to the asserted view, and a
   torso rendered as front-on has no profile depth left in it. The shopper's real
   front-to-back volume - which is ONLY visible edge-on, and is exactly what a pillow
   under a shirt is testing - is what gets normalised away. That is the "it falls back to
   a default body" report.

   So the profile poses do two things the front/back poses cannot: they describe the
   rotation truthfully instead of asserting a facing, and they explicitly forbid the
   de-rotation. They still name the locked side, because which half of the garment is
   toward the camera is still known and still steers the panel that APPLY selects. */
const COMPOSITE_POSE = {
  front: " The person is FACING FORWARD, the front of their body toward the camera.",
  back:
    " The person has TURNED AROUND and is presenting their BACK to the camera - rear view, the back of" +
    " their body toward you, no face visible.",
  profileFront:
    " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right angle" +
    " to the camera - you are seeing the side of their body, with the front of the garment facing off to" +
    " one side rather than toward you. Render them at the exact rotation shown in the live frame:" +
    " do NOT rotate, straighten or re-pose them back toward the camera, and do NOT re-render this as a" +
    " front-facing shot.",
  profileBack:
    " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right angle" +
    " to the camera - you are seeing the side of their body, part-way through turning away, with the back" +
    " of the garment facing off to one side rather than squarely away from you. Render them at the exact" +
    " rotation shown in the live frame: do NOT rotate, straighten or re-pose them, and do NOT re-render" +
    " this as a square rear shot.",
};

const COMPOSITE_SELECT = {
  front: COMPOSITE_POSE.front + COMPOSITE_APPLY.front,
  back:  COMPOSITE_POSE.back  + COMPOSITE_APPLY.back,
};

/* Same panel contract, same texture source, truthful pose - selected when the watcher
   reports the shopper is edge-on. Pairs with SIDE_PROFILE_DEPTH, which supplies the
   positive instruction about what the silhouette edge means; this one only stops the
   prompt from asserting a facing that is not there. */
const COMPOSITE_SELECT_PROFILE = {
  front: COMPOSITE_POSE.profileFront + COMPOSITE_APPLY.front,
  back:  COMPOSITE_POSE.profileBack  + COMPOSITE_APPLY.back,
};

/* Trimmed photorealism tail for composite mode, replacing QUALITY_SUFFIX + HEM_DETAIL.
   Two reasons, both specific to a two-panel reference:
     • LENGTH. Those two constants alone run ~660 characters of boilerplate that competes
       with the panel contract for the model's attention (see buildCompositePrompt).
     • CONTRADICTION. HEM_DETAIL says "preserve the garment's printed graphics, logos and
       text at their original scale, proportion and relative position" without naming a
       panel. Against a reference holding TWO sets of graphics that reads as "render both"
       - the double-logo symptom that got the previous stitcher removed in 23f5953. The
       per-panel form of that same instruction already lives inside COMPOSITE_SELECT,
       scoped to the one panel actually in play. */
const COMPOSITE_QUALITY =
  ", photorealistic real-world fabric texture with visible seams and stitching, natural" +
  " lighting matching the user's room, and natural material physics - no glitching, banding," +
  " tearing or unnatural structural folds";

/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN BUDGET - why every clause above this line was rewritten into a phrase
   ───────────────────────────────────────────────────────────────────────────
   Decart rejects an over-long prompt outright:

     "Prompt is too long: 1376 tokens (maximum 226, including the end-of-sequence
      token). Please shorten the prompt."

   That is not a soft quality signal - set() fails and the shopper gets NO garment.
   Measured against that 226-token ceiling (~904 characters at English prose's ~4
   chars/token), what this file had been assembling was:

       composite square-on   6,718 chars  ~1,680 tok    7.4x over
       composite edge-on    10,077 chars  ~2,520 tok   11.2x over

   SIDE_PROFILE_DEPTH alone was 454 tokens - twice the entire budget for a single
   clause. So this could not be a trim. Every long constant this file spent its
   history growing (each one written against a real, reproduced regression) had to
   collapse into one short directive, and several had to go entirely.

   WHAT WAS KEPT, and the order is the triage. The budget buys roughly a dozen short
   directives, so they are ranked by what breaks without them and dropped from the
   bottom when a particular garment's description runs long:

     CORE  panel contract, panel selection, pose, the substitution itself, and -
           edge-on only - body depth. Without any of these the render is simply
           wrong (wrong half of the garment, wrong rotation, flattened body).
     HIGH  body fidelity and model-agnostic extraction: the two most-reported
           failures ("it slimmed me", "it gave me the model's shoulders").
     MED   opposite-layer lock, background/person lock, lateral wrap.
     LOW   rotation continuity, fit modifier.
     TRIM  temporal stability and photorealism - the model's own priors already
           favour both, so these are the cheapest to lose.

   WHAT WAS LOST, stated plainly because it is real: the enumerated negatives are
   gone. STRICT_INPAINT's per-item list, BACK_TAIL's explicit "do not copy the front
   print onto the back", IGNORE_SOURCE_ARTIFACTS' watermark/badge list, and
   PROFILE_ANOMALY_GUARD entirely. Each was written because naming a failure
   explicitly is what stopped it. At 226 tokens there is no room to name them, so
   these prompts are a weaker instrument than what they replace - they are simply the
   strongest instrument that FITS. If a specific regression returns, the fix is to buy
   its directive back by dropping something in TRIM, not to grow the prompt.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Drop order. CORE is never shed - if a prompt cannot fit with CORE alone, it is
   truncated instead (see fitPrompt), because a slightly clipped prompt still renders
   while a rejected one renders nothing. */
const P = Object.freeze({ CORE: 0, HIGH: 1, MED: 2, LOW: 3, TRIM: 4 });

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  STRICT IMAGE-ONLY CONDITIONING - one static string, for every dispatch.  ║
   ╚══════════════════════════════════════════════════════════════════════════╝
   THE REPORTED FAILURE: a Spider-Man graphic tee, selected in the catalog and
   correctly delivered to the wire, rendering as a tuxedo with a bowtie. Twice - the
   first fix (an image-first anchor, with the garment description removed but the
   structural clauses kept) did not stop it.

   THE MECHANISM. Decart's realtime set() takes { prompt, image, enhance } and NOTHING
   else - no negative_prompt, no image-strength, no ControlNet weight (verified against
   @decartai/sdk@0.1.5 setInputSchema). The ONLY lever this app has over how hard the
   reference image is weighed against the text is HOW MUCH TEXT THERE IS. Every
   remaining clause, however structural, is another token competing with the pixels for
   the model's attention, and the first fix left roughly a dozen of them.

   THE MODE THIS IMPLEMENTS: the prompt stops being generated at all. It is one frozen
   string, byte-identical on every dispatch, for every garment, every angle, every pose
   and every shopper. It cannot contradict the reference because it says nothing the
   reference could contradict, and it cannot dilute it because there is nothing left to
   shed. The SDK requires a non-empty prompt, so this is the smallest thing that
   satisfies that requirement while pointing at the asset.

   WORDING IS PRODUCT-SPECIFIED - do not paraphrase, do not interpolate, do not append.
   `${...}` inside this string is how a description gets back in, one field at a time.

   ── REVISION 5: VOLUME PERSISTENCE, AND THE HEAD-ON CASE ─────────────────────
   TWO REPORTS, from video rather than stills, which is why they are new:

     · A session that starts side-on with correct stomach volume LOSES it part-way
       through a 360-degree turn, ending flat and slim.
     · A session that starts head-on renders flat from the first frame - no frontal
       convexity at all, the garment sized off shoulder width alone.

   ── READ THIS BEFORE TUNING THE PERSISTENCE SENTENCE ─────────────────────────
   The reported root cause is "Decart's model state is resetting its 3D depth memory
   across frames". That is close, but it is not a reset: THERE IS NO MEMORY TO RESET.
   Lucy regenerates every frame independently. There is no cross-frame state, no seed and
   no motion-guidance parameter exposed by @decartai/sdk@0.1.5 - realtime connect takes
   model/fps/width/height/mirror/resolution/codec, and set() takes exactly
   { prompt, enhance, image }. This file has that written down already, in
   COMPOSITE_TEMPORAL's comment, and it is the single most important limit to hold in mind
   here: NO PROMPT CAN CREATE PERSISTENCE THIS PIPELINE DOES NOT HAVE.

   What the sentence CAN do, and does, is bias each independently-generated frame toward
   the same interpretation - which is exactly why the failure looks progressive. Every
   frame re-derives the body from the live pixels; a square-on frame carries strong volume
   evidence, and a mid-turn frame is foreshortened and partly occluded, so the evidence
   weakens and the model falls toward its prior, which is slim. Naming the quantities that
   must not change (abdomen depth, waist volume, torso thickness) and the transition they
   must survive (360-degree rotation, mid-stream) raises the floor on those weak-evidence
   frames. It is a per-frame bias, not a temporal filter, and it cannot be one - so if
   volume still decays mid-turn, the answer is NOT stronger persistence language. It is
   that the weak-evidence frames need better evidence, which is a pipeline change (the
   reference, the crop, the input resolution), not a prompt change.

   THE HEAD-ON SENTENCE is the more tractable of the two, and it fills a real gap. Every
   revision since the abdomen reports began has described volume in terms a PROFILE makes
   visible - depth, contour, silhouette. Head-on, none of those are measurable from the
   frame: the stomach's projection is toward the camera, along the axis with no extent in
   a 2D image, so a model with nothing else to go on sizes the garment off shoulder width
   and renders flat. That is not the model failing to follow an instruction; it is the
   instruction not applying. The fix names what frontal volume actually looks like -
   convexity, forward hem extension, lighting falloff - which are the 2D cues a viewer
   reads as depth, and the only ones available at 0 degrees.

   ── WHAT THIS REVISION REINTRODUCES, and it is a knowing risk ────────────────
   "Natural fabric drape" and "forward hem extension" are the vocabulary revision 4
   removed, because drape-and-hem language is also how a designer describes a knotted or
   gathered hem - and that produced the front-knot artifact. They are back because the
   head-on case cannot be described without them: convexity has to be rendered as
   something, and drape and hem projection are what it is rendered as.
   Two things make this less exposed than revision 3 was: the language is SCOPED to
   front-facing views rather than stated as a general physics goal, and the structural
   boundary ("a closed back and normal un-knotted hem") is still on the wire immediately
   after it. If the knot returns, that scoping is the first thing to tighten - not the
   boundary, which is already as explicit as it can be.

   NOTE ALSO: revision 4's four-artifact enumeration ("do NOT generate front knots, tied
   fabric, open slits, or floating back flaps") is gone, leaving only the positive
   boundary. That is exactly the step revision 4's own risk note said to take if the named
   negatives proved counterproductive, and it happens to be the right shape for a prompt
   that has otherwise grown - the boundary sentence still states the correct structure
   completely on its own, which is why it was written to lead its own enumeration.

   ── REVISION 4: THE PHYSICS LANGUAGE STARTED STYLING THE GARMENT ─────────────
   THREE REPORTS, and the first two are the same mechanism seen from two sides.

     · A KNOT tied into the front hem, over the abdomen.
     · The BACK flaring open into loose floating fabric on a turn.

   Revision 3's third sentence asked for "realistic textile drape, natural tension lines,
   and proper 3D volume wrapping". Every one of those words is also the vocabulary of
   GARMENT STYLING - drape, gathering, tension are what a designer says about a knotted
   hem or an open-backed cut - and a diffusion model has no way to know we meant physics
   rather than construction. Asked for drape over a protruding stomach with no statement
   of what the garment's STRUCTURE is, the most probable way to produce visible drape is
   to give the garment somewhere to drape FROM: a knot, a gather, an open back. It was
   doing exactly what it was told, and what it was told was ambiguous.

   So this revision states the STRUCTURE first and asks for the physics only as a smooth
   wrap. "Standard, continuous t-shirt" is the frame; "normal, flat, un-knotted hem and a
   completely closed back" is the boundary; the four named artifacts are the enumeration.
   The physics vocabulary that invited the styling reading is gone entirely - what
   survives is "smoothly wrap ... around the subject's true body volume and stomach",
   which asks for the same outcome without ever naming a construction technique.

     · THE THIRD REPORT: the fit only came out right when the session STARTED at 90
       degrees; face-on it flattened. Revision 3 said "from all angles", which is true and
       useless - a model has no reason to treat an unenumerated range as including the
       case it is currently getting wrong. Both angles are now named explicitly, 0-degree
       front alongside 90-degree side, so neither is the default the other is measured
       against.

   ── TWO THINGS THIS REVISION TRADES AWAY, recorded because they are real ──────
     1. THE EXPLICIT BODY-DISCARD IS GONE. Revision 3 led with "completely ignoring the
        original model's body size, chest, and waist dimensions" - DENSE.modelAgnostic,
        stated outright. What replaces it is "Preserve ONLY the reference image's graphics,
        fabric texture, and color", which implies the same thing by exhaustion but never
        says it. That is a weaker instrument against the "it gave me the e-commerce
        model's shoulders" report, and it is the FIRST thing to restore if that returns:
        DENSE.modelAgnostic is still on file, and appending its sentence is a one-line
        edit. Recorded here rather than discovered later.
     2. THE EXTRACTION DIRECTIVE NO LONGER LEADS. Revision 3 moved it to the front
        deliberately, on this file's oldest lesson - leading tokens dominate - and it is
        now the closing sentence. The lead is still a reference-bound instruction ("a
        standard, continuous t-shirt FROM the reference image"), so the asset is anchored
        in the first clause either way; what moved is the isolation half. If the garment
        itself starts drifting again (wrong colour, wrong print), this ordering is the
        first thing to look at, before adding any words.

   ONE MORE, AND IT IS THE RISKIEST PART OF THIS STRING: "knots", "tied fabric", "open
   slits" and "floating back flaps" are NAMED NEGATIVES. This file's record is that naming
   a rendering FAULT is safe (a stretch, a float - there is no object to steer toward)
   while naming a GARMENT is not (the tuxedo outlived two prompts that banned it by name).
   These sit between: a knot is not a garment type, but it is more object-like than any
   negative shipped since the tuxedo list. They are named because the artifacts are already
   appearing and naming the failure is what has historically stopped it - but if knots
   persist or spread, deleting the enumeration and keeping only the positive boundary
   ("Maintain a normal, flat, un-knotted hem and a completely closed back") is the next
   thing to try, NOT a longer list.

   ── REVISION 3: THE REFERENCE IS A 2D MATERIAL, NOT A DRESSED PERSON ─────────
   THE SYMPTOM THAT SEPARATES THIS FROM THE REVISION BELOW: the previous wording asked
   the garment to conform to the shopper's real abdomen and it did - by STRETCHING. A
   flat 2D projection pulled forward over a torso that was still rendered thin, rather
   than cloth wrapping a volume. The shirt looked painted onto a protrusion, or floating
   in front of one.

   WHY THE PREVIOUS WORDING PERMITTED IT. It said "conform to the user's abdomen depth"
   without ever saying what the reference IS, so the model kept reading the packshot as a
   photograph of a dressed person - complete with that person's 3D geometry - and then
   deformed the whole assembly to fit. Deforming a thin body to cover a wide one is a
   stretch. There was no instruction to discard the source geometry and treat what remains
   as material, so the strongest available reading was the literal one.

   THE FIX IS AN ORDERING CHANGE AS MUCH AS A WORDING ONE. The extraction sentence now
   LEADS, and this file's whole record says leading tokens dominate: the first thing the
   model is told is that the reference is fabric texture, colour and pattern - a 2D
   material sample - and that the original model's size, chest and waist are to be ignored
   outright. Only once that is established does the drape instruction follow, so what gets
   draped is cloth rather than a re-proportioned photograph.

   THE THIRD SENTENCE IS NEW and is the physics the first two only imply: textile drape,
   natural tension lines, 3D volume wrapping, "whether large or small" (which removes the
   assumption rather than arguing with it), and the two reported artifacts named directly -
   2D stretching and floating. Naming the specific wrong output is this file's oldest
   working mechanism and it is safe here for the same reason "flat torso" was: these are
   RENDERING FAULTS, not garments, so there is no object for the sampler to steer toward.

   ── REVISION 2: BODY CONFORMATION FOLDED IN ──────────────────────────────────
   The first version of this string said only "render the provided asset, invent nothing".
   That fixed the garment but exposed the BODY: a shopper with a real waistline (the test
   case is a pillow under a shirt) got the slim proportions of the e-commerce model
   wearing the shirt in the catalog photo, and the fabric hovered off their actual
   silhouette instead of draping over it. The cause is the same unstated-region mechanism
   this file documents everywhere - a catalog reference is almost always model-worn, so
   there are TWO bodies in the conditioning and nothing said which one to fit.

   The three directives that used to cover this were separate, shed-able clauses -
   DENSE.bodyFidelity, DENSE.modelAgnostic and DENSE.profileLateral - and all three were
   retired when the prompt froze. They are back, but INSIDE the frozen string rather than
   beside it, which is the whole point: they cannot be shed, cannot be reordered, and
   cannot be separated from the instruction they qualify.

   ── THE FIVE SENTENCES ON THE WIRE TODAY ──────────────────────────────
     1. STRUCTURE + THE VOLUME CLAIM: "a standard t-shirt from the reference image ... with
        strictly persistent 3D body volume". Structure still leads (revision 4's fix for
        the knot and the open back), and the persistence claim is attached to it rather
        than left for a later sentence, so the very first thing stated about this render is
        that it has a body with volume in it.
        THE ONE COMPROMISE, unchanged from revision 4: "t-shirt" is a garment NOUN, of
        exactly the kind SHIRT_NOUN/SUBTYPE_PROMPT were retired for naming. Correct for the
        upper-body catalog and every case reported so far; WRONG for lower_body items
        (Nimbus) and long-sleeve tops, where it asserts what the reference contradicts. If
        trousers render as a shirt, this noun is the cause and "garment" is the one-word
        fix - see SUBTYPE_PROMPT's retired-noun note for the mechanism.
     2. PERSISTENCE: the exact same abdomen/stomach depth, waist volume and torso thickness
        through all 360-degree rotations, never flattening or resetting mid-stream. Three
        quantities named individually because "volume" alone is satisfiable by any one of
        them, and the transition named explicitly because the failure is progressive rather
        than static. Read the limit above before touching this: it is a per-frame bias, not
        a state lock, and it cannot be made into one from here.
     3. FRONTAL CONVEXITY: at 0 degrees, render the stomach's forward volume through fabric
        drape, forward hem extension and lighting falloff. The gap every previous revision
        left - depth, contour and silhouette are all profile-visible quantities, and none of
        them is measurable head-on, where the projection points at the camera. These three
        are the 2D cues that read as depth, and the only ones available at that angle.
     4. BOUNDARY: a closed back and a normal un-knotted hem. Revision 4's four-artifact
        enumeration is gone; this is the positive half it was deliberately written to lead,
        and it states the correct structure completely on its own.
     5. EXTRACTION: use ONLY the reference's graphics, fabric texture and colour. The
        provenance split, still reduced to its positive half - it implies the body-discard
        by exhaustion but does not state it. See "two things this revision trades away"
        under revision 4; that trade is unchanged and DENSE.modelAgnostic is still the
        one-line restore.

   NOTE WHAT LEFT, across revisions: the enumerated "without inventing any tuxedos, suits,
   or unrequested garments" tail, revision 2's "do NOT copy the source model's body frame or
   force a flat torso", and revision 3's physics vocabulary ("realistic textile drape,
   natural tension lines") - the last because it was read as STYLING and produced the knot.
   The tuxedo tail is deliberate and is this file's own recorded next step: with no
   negative_prompt field a named garment ships in the POSITIVE prompt where the sampler can
   steer toward it, and the tuxedo outlived two versions that named it. If invented garments
   return, do not re-add that noun list; re-read the DENSE table's assetLock comment for why
   it made things worse.

   ── WHAT WENT WITH IT, and how to get any of it back ─────────────────────────
   Every clause the builders assembled is retired from the prompt path. They are all
   still on file (see the DENSE table below, and the RETIRED block above it) with the
   reasoning that produced them, because each one is a reproduced regression:

     · the garment description  colour word + subtype noun, interpolated from catalog
                                metadata. The original tuxedo cause - a text
                                description is something a diffusion model can satisfy
                                from its own prior instead of from the reference.
     · assetLock                the enumerated ban ("never invent a ... suit, TUXEDO,
                                tie, BOWTIE"). With no negative_prompt field those
                                nouns shipped in the POSITIVE prompt, where a named
                                garment is a token the sampler can steer toward.
     · contract + select        the FRONT|BACK panel contract. Retiring this is what
                                forces COMPOSITE_DEFAULT to false - see its comment; a
                                split reference is unreadable without the text that
                                explains it, and shipping one anyway is how the
                                23f5953 double-print bug comes back.
     · pose / poseProfile       front/back/edge-on. The reference asset itself now
                                carries the orientation (the watcher swaps the photo),
                                so the pose sentence is the model's job to read off
                                the live frame, which is where it always came from.
     · profileLateral           the 90-degree flank/depth directive. SUPERSEDED, not
                                simply lost: the frozen string's "from all angles,
                                including 0-degree front and 90-degree side views" states
                                the same coverage with no pose flag to gate it - which
                                matters more than it reads, since nothing dispatches on a
                                profile transition any more. Same for bodyFidelity
                                ("the subject's true body volume and stomach"). NOT the
                                same for modelAgnostic - revision 4 reduced that one to an
                                IMPLICATION ("Preserve only ... graphics, fabric texture,
                                and color"), which is the weakest it has been. See the
                                revision notes above; it is first on the restore list.
     · inpaintLock              face/skin/hands/background passthrough. THE LARGEST
                                LOSS and the one to restore first if the model starts
                                repainting the shopper's room or face: nothing else
                                stands between this prompt and a regenerated scene.
     · keepTop / keepBottoms    the opposite-layer lock.
     · ignoreFurniture          the "don't paint the panel divider onto the shirt" ban.
     · fitSentence              RESTORED - see imageOnlyPrompt()'s SIZE-OVERRIDE RESTORE
                                comment. Was the size-override selector's only route into
                                the render; the chosen size now reaches Decart again, at
                                P.MED, via getFitModifier()'s garment/fabric-only wording.

   TO RESTORE ONE: it is a two-line change - reinstate fitPrompt() in the builder that
   needs it and add [P.CORE, DENSE.<clause>] beside IMAGE_ONLY_PROMPT. fitPrompt(),
   clampPromptForWire() and the whole DENSE table are deliberately left intact for
   exactly that. Restore ONE at a time and re-test: the entire premise of this mode is
   that clause count is what was drowning the image. */
/* ── THE CATEGORY BRANCH - "I tried on jeans and it put the model's shirt on me" ──
   The frozen string above was ONE anchor for the whole catalog, and it opened by naming
   a t-shirt. On a trouser product that first sentence is a direct contradiction: the
   prompt says t-shirt, the reference photographs a model wearing a shirt AND trousers,
   and NOTHING told the model which half of that reference was the product. Lucy took the
   whole visual, so the source model's shirt replaced the shirt the shopper was still
   wearing on camera. run.mjs's suite index already named this gap before it was closed
   ("an 'upper garment' anchor on a trouser reference is the same contradiction").

   WHY THE ANCHOR AND NOT A RESTORED CLAUSE. KEEP_TOP/KEEP_BOTTOMS still exist in the
   DENSE table and would say much of this - but they were retired because clause COUNT was
   drowning the image, and adding one back re-enters that competition. Folding the
   opposite-layer lock INTO the anchor costs no extra clause: the sentence that has to
   name the target garment anyway is the same sentence that names what not to touch. It
   also cannot be shed, because it is the anchor.

   THE PROVENANCE HALF IS LOAD-BEARING, not a restatement. "Preserve the live upper
   garment" alone still leaves the reference's shirt as unclaimed territory, and an
   unstated region is precisely what this file's history keeps recording as the thing that
   gets reinterpreted (see STRICT_INPAINT's comment). So the bottoms branch names the
   REFERENCE as the thing not to copy an upper garment from, not just the live frame as
   the thing to keep.

   READ THE LAST BLOCK IN THIS RUN FOR THE CURRENT WORDING. The paragraph above is the
   record of WHY the lock lives inside the anchor rather than beside it, and that
   reasoning still holds. The sentences it describes do not - two revisions have rewritten
   both anchors since. What bottoms carries today is region naming inside its lead ("the
   live subject's CURRENT lower-body contour"); the explicit pin on the opposite layer
   came off with the dynamic-drape revision and is retired as KEEP_OPPOSITE_LAYER. */
/* ── REVISION: STRICT 1:1, BOTH BRANCHES (SUPERSEDED - see DYNAMIC BODY below) ────
   HISTORY, NOT THE LIVE WORDING. This block is the record of the three reports that
   collapsed both anchors to a 1:1 reference lock, and of the fourth that put the
   lower-body scoping back on bottoms. The dynamic-drape revision further down replaced
   both strings; what survives from here is the scoping (folded into the new bottoms lead)
   and the retirement list below, which is still accurate about what is off the wire.
   THE THIRD REPORT IN THIS SEQUENCE, and a different failure from the first two. The
   first was the WRONG REGION (a t-shirt anchor on a trouser reference). The second was
   the WRONG GARMENT (generic black shorts instead of the photographed white ones). This
   one is the RIGHT garment with INVENTED DETAIL - textures and design elements the
   reference never contained.

   So the clamp changed shape. "without inventing new shorts" only forbade SUBSTITUTION;
   it said nothing about embellishing the correct garment. The replacement bans all three
   operations explicitly - invent, add, alter - because adding a stripe and altering a
   stripe are different edits and only the first was previously excluded.

   BOTH BRANCHES ARE COLLAPSED, AND THE CLAMP IS SYMMETRIC. The previous revision cut
   bottoms only, on the principle of one branch at a time on evidence; tops kept its
   seven-sentence assembly. This finishes the job at the product owner's direction: every
   word either string says about the GARMENT is now the same word.

   THE SCOPING IS NOT SYMMETRIC, and that is the one asymmetry left. The collapse also
   took the opposite-layer lock, which re-opened the shirt-replacement report through the
   bottoms branch - the one it was filed against - so 69 characters of lower-body scoping
   went back on THERE and nowhere else. Same rule as every revision before it: one branch
   at a time, on evidence. Full detail in the first bullet below.

   ── WHAT THIS REMOVES, AND WHY IT IS WRITTEN DOWN HERE ──────────────────────────
   Every clause below is a reproduced regression, and all of them came off the wire in
   this revision. ONE OF THEM IS BACK - read the first bullet before the rest:

     · the OPPOSITE-LAYER LOCK - SPLIT IN TWO by the revisions since. Its job was the fix
       for the FIRST report in this sequence: trying on trousers putting the catalog
       model's shirt on the shopper. Collapsing it away left the scoping implicit - "the
       EXACT shorts/pants ... onto the subject" names a garment but no region - and the
       bottoms branch is the exact configuration that report was filed against, so the
       scoping went back on there and nowhere else.
       WHERE EACH HALF LIVES TODAY: the REGION NAMING survives, folded into the new
       bottoms lead ("the live subject's CURRENT lower-body contour"). The explicit PIN on
       the opposite layer does not - it came off with the dynamic-drape revision and is
       retired as KEEP_OPPOSITE_LAYER, one line from being back.
       THE TOPS BRANCH IS STILL IMPLICITLY SCOPED. No shirt-replacement report has been
       filed through it - the reported failure is a trouser try-on repainting the top,
       not the inverse - so tops keeps the shorter string on the same one-branch-at-a-
       time-on-evidence principle the bottoms collapse itself was made under.
       IF SHIRT-REPLACEMENT RETURNS, THIS IS THE CLAUSE TO RESTORE FIRST - it is the only
       loss here that re-opens a previously fixed report rather than degrading fidelity,
       and on tops the restore is the bottoms sentence with the two regions swapped
       (or KEEP_TOP, declared further down this file).
     · VOLUME_PERSISTENCE / FRONTAL_VOLUME - "it slimmed me down", and the head-on
       stomach-projection gap.
     · TEMPORAL_PERSISTENCE - the prompt's half of the late-entry presence fix. The gate
       and the watcher still run for both categories, so the mechanism survives.
     · CLOSED_BACK_HEM - the knotted-hem and open-back-flap artifacts. Still assembled on
       the full-look path, which was never collapsed; off the wire on both single-garment
       branches.
     · REFERENCE_EXTRACTION - superseded rather than lost: the anchor's own fidelity
       sentence states the same provenance rule ("Strictly preserve the original ...
       texture, pattern, and color" today; "Exactly match color, pattern, logos, and cut"
       under the 1:1 revision this block was written for).

   THE RESTORE PATHS ARE NOW UNIFORM, which they were not when this block was written.
   VOLUME_PERSISTENCE, FRONTAL_VOLUME, TEMPORAL_PERSISTENCE, CLOSED_BACK_HEM,
   REFERENCE_EXTRACTION and - since the dynamic-drape revision named it - KEEP_OPPOSITE_
   LAYER are each on file as a constant, so every restore here is one line in
   imageOnlyPrompt(). The budget is not the constraint: tops runs 338 characters and
   bottoms 320 against a 650 ceiling. Anything bought back is a deliberate choice about
   TEXT VOLUME COMPETING WITH THE REFERENCE, which is the mechanism every fidelity report
   in this sequence shares. Add one at a time, and re-test against a live session. */

/* The strict lock. STILL LIVE - lookAnchorPrompt() carries it - but no longer on the two
   single-garment branches, which the dynamic-drape revision below rewrote around a
   different fidelity sentence. Kept in one constant because more than one anchor uses it
   and two copies of a product-specified sentence are two places for it to drift. The
   first sentence supersedes REFERENCE_EXTRACTION (same provenance rule, and it names
   logos and cut); the second is the hallucination clamp, banning all three edits -
   invent, add, alter - because adding a stripe and altering a stripe are different
   operations. Leading space: it is appended to an anchor, never used alone. */
const STRICT_REFERENCE_LOCK =
  " Exactly match color, pattern, logos, and cut." +
  " Do NOT invent, add, or alter any details.";

/* ── REVISION: DYNAMIC BODY, STATIC GARMENT ──────────────────────────────────────
   THE REPORT: a shopper who is fitted at 0 degrees and then turns 90, or who adds real
   profile volume (a cushion under the shirt, a belly the front view does not show), gets
   the ORIGINAL drape stretched and warped over the new shape instead of a garment
   re-draped over it. The fabric smears; the cut distorts.

   THE DIAGNOSIS IS A SPLIT THIS FILE HAD NEVER STATED. Two things are being fused every
   frame, and they have opposite requirements:
     · THE GARMENT is STATIC and INVARIANT. One reference image, one cut, one colour, one
       print, for the whole session. Nothing about the shopper may change it.
     · THE BODY is DYNAMIC and VARIABLE. Its contour, depth, volume and orientation are
       different in every single frame, and the frame is the only place they exist.
   Every previous revision of these anchors said "overlay and fit ... onto the subject" -
   a subject with no tense. A model reading that has no instruction to re-derive anything
   per frame, so the cheapest completion is to keep the drape it already produced and
   deform it to the new outline. That is the reported artifact, restated.

   WHAT THE NEW WORDING DOES, sentence by sentence, on both branches:
     1. binds to the EXACT STATIC garment from the reference (the invariant half), and
        names the target as the subject's CURRENT contour IN THIS FRAME (the variable
        half). "Static" and "current" in one sentence is the whole split;
     2. instructs an ADAPTATION rather than a transform - silhouette, angle, depth and
        volume - and names the two failure modes it must not use to get there
        (stretching, warping / distorting);
     3. re-asserts the invariant on the attributes a re-drape is most likely to smear.

   IT IS PAIRED WITH RUNTIME MACHINERY, and neither half works alone. Text cannot make a
   model re-read a body it is never re-conditioned on: under strict image-only prompting
   the payload is byte-identical from one dispatch to the next, so applyGarment()'s no-op
   skip means a re-anchor sends nothing at all. The CONTINUOUS BODY TOPOLOGY monitor -
   makeBodyTopologyTracker(), sampled by startPresenceWatcher(), dispatched by
   reconditionForTopology() - is what makes this sentence true: it watches the live
   skeleton and forces a real re-conditioning dispatch when the body has actually moved
   away from the shape the current render was drawn against. Read the two together;
   deleting either leaves the other lying.

   ── WHAT THE NEW WORDING GAVE UP, both branches ─────────────────────────────────
   Written down because both are reproduced regressions and this is the file that has to
   admit it if either returns:
     · THE HALLUCINATION CLAMP ("Do NOT invent, add, or alter any details.") is off the
       single-garment branches. What replaces it is weaker by construction: "Strictly
       preserve the original texture, pattern, and color" forbids CHANGING the garment
       but does not forbid ADDING to it. If invented detail comes back, the restore is one
       line - append STRICT_REFERENCE_LOCK to the anchor - and the constant is right above
       so it never has to be rewritten from memory.
     · THE OPPOSITE-LAYER PIN on bottoms ("Keep the subject's upper body and background
       unmodified.") is off with it. The primary half of that fix SURVIVES - the bottoms
       lead still names the region ("the live subject's CURRENT lower-body contour"), and
       an unscoped anchor was the actual configuration the shirt-replacement report was
       filed against - but the explicit pin on the opposite layer is gone. Retired as
       KEEP_OPPOSITE_LAYER below rather than deleted, so that restore is one line too.
   Budget is not the constraint for either: tops runs 338 characters and bottoms 320
   against a 650 ceiling. The constraint is the one every report in this sequence shares -
   TEXT VOLUME COMPETING WITH THE REFERENCE IMAGE. Add one at a time, re-tested live. */

/* Retired with the dynamic-drape revision, kept verbatim so its restore is genuinely one
   line (`[P.HIGH, KEEP_OPPOSITE_LAYER]` in imageOnlyPrompt's bottoms branch) rather than
   a re-derivation. Bottoms only: no report has ever been filed of a TOP try-on repainting
   the shopper's live trousers, so there has never been a tops equivalent to retire. */
const KEEP_OPPOSITE_LAYER = "Keep the subject's upper body and background unmodified.";

/* ── FRONT CLOSURE - "the button-down rendered wide open" ────────────────────────
   REPORTED: a closed button-down shirt rendered hanging open, exposing the shopper's
   chest. This is the invented-detail class, not the tuxedo class - the right garment,
   rendered in a state the reference never showed - so it is the class the anchor's own
   restore note says a clause may be bought back for. Bought back per the procedure that
   note prescribes: ONE part, added at P.HIGH, re-tested live.

   STATED POSITIVELY, AND THAT IS NOT A STYLE CHOICE. The obvious wording - "do not
   render open or unbuttoned" - is the exact shape that produced the tuxedo: Decart's
   set() has no negative_prompt field (only { prompt, image, enhance }), so a negation
   ships inside the POSITIVE prompt, where "open" and "unbuttoned" are tokens the sampler
   can steer toward. image-first.test.mjs's header records DENSE.assetLock failing this
   way when it spelled out "never invent a ... TUXEDO, BOWTIE". Naming the state we WANT
   costs the same budget and cannot be sampled backwards.

   PRODUCT-NEUTRAL, so it does not open a third prompt axis. It says nothing about
   whether this garment HAS buttons: on a tee there is no closure and the sentence asks
   for nothing, while on a button-down or a zip-through it pins the fastening. Wording it
   per-product would need a has-buttons axis, which would break the frozen-anchor design
   the category/angle axes are pinned to - and an "unbutton the placket" instruction on a
   t-shirt reference is the same contradiction as an "upper garment" anchor on a trouser
   reference, which this file already carries a bug report for.

   TOPS + FRONT ONLY. A closure is a front-of-garment feature, so it is not spent on the
   bottoms branch, and not on the back anchor where it is not in view. Both remain fully
   determined by (category, angle) - no new axis. */
const FRONT_CLOSURE_LOCK =
  "Reproduce the reference's front closure exactly: any buttons, zip or placket stay" +
  " fully fastened, sitting flat and closed across the chest as shown.";

/* ── PLAIN KNIT TEE - "a plain white crewneck rendered as a button-down" ─────────
   REPORTED: a plain white crewneck/V-neck t-shirt came back as a short-sleeve white
   WOVEN BUTTON-DOWN - pointed collar, front placket, breast pocket. Not a garment from
   another category (the tuxedo class) and not a wrong state of the right garment (the
   open-placket class): the right garment in the WRONG CONSTRUCTION. Knit read as woven.

   THE CAUSE IS THE CLAUSE DIRECTLY ABOVE, and this is the correction to its own comment.
   FRONT_CLOSURE_LOCK calls itself PRODUCT-NEUTRAL - "on a tee there is no closure and the
   sentence asks for nothing" - and that is the one assumption this file's whole history
   says you may not make. set() has no negative_prompt, so everything ships in the POSITIVE
   prompt, where "buttons", "zip", "placket" and "closed across the chest" are tokens the
   sampler steers TOWARD. On a button-down they describe a garment the reference already
   shows. On a plain tee they were, until this revision, the ONLY construction words on the
   wire - so the model reconciled them the one way it could, by rendering a garment that
   HAS a placket. The collar and the breast pocket are not in the sentence; they arrive
   with the concept once it has been summoned, which is exactly how the tuxedo arrived
   wearing a bowtie nobody asked for.

   THE ANCHOR NOUN IS THE SECOND HALF OF IT. CATEGORY_ANCHOR.top says "the EXACT static
   SHIRT", and in English an unqualified "shirt" leans woven-and-buttoned. That was
   survivable while it was the only signal; paired with four closure tokens it stops being
   survivable. The tee branch names a t-shirt instead, in both the bind sentence and the
   preserve sentence.

   WHY THIS IS NOT THE has-buttons AXIS FRONT_CLOSURE_LOCK REFUSED TO OPEN. That note
   rejected WORDING THE CLAUSE PER PRODUCT - interpolating a garment's features into a
   string, which is how a per-item DESCRIPTION creeps back one field at a time. This adds
   no interpolation and no new text shape: it is a THIRD SELECTOR over frozen literals,
   the same move the angle axis already makes. The prompt remains a pure function of
   (category, angle, construction) onto a fixed set of constant strings, and exactly one
   anchor plus at most one clause ever ships.

   IT SPENDS NO BUDGET - IT RETURNS SOME. A tee ships ~431 characters where it used to ship
   ~493, because dropping the closure clause buys more than the neckline sentence costs.
   Every fidelity report in this file shares one mechanism - text volume competing with the
   reference image - so a fidelity fix that GREW the prompt would be that mechanism applied
   again. plain-tee-fidelity.test.mjs §4 pins the direction.

   STATED POSITIVELY, for the reason FRONT_CLOSURE_LOCK states and this revision takes
   further: the obvious patch here is "do NOT render buttons, collars, plackets, or chest
   pockets", and that is the DENSE.assetLock shape that produced the tuxedo - a negation
   that ships inside the positive prompt and names four more garment features on its way
   through. Naming the construction we WANT costs the same budget and cannot be sampled
   backwards.

   FRONT + TOPS ONLY, like the clause it displaces. The summoning tokens were never on the
   back branch, and no back-view report exists, so BACK_CATEGORY_ANCHOR is left byte-
   identical on this file's one-branch-at-a-time-on-evidence rule. If a tee ever renders a
   woven BACK YOKE, the restore is the same shape as this one: a tee entry in the back
   pair, selected by the same predicate. */
/* ── THE LOWER-BODY ISOLATION LOCK - "it repainted my green trousers" ──────────────
   REPORTED: fitting a TOP altered the shopper's shorts/trousers - colour, shape and
   texture - along with shoes and background, on a branch that only ever asked for the
   torso garment to change.

   THIS IS keepTop, RESTORED - the clause IMAGE_ONLY_PROMPT's restore list names as
   "the opposite-layer lock, TOPS ONLY".

   ⚠ THE RESTORE NOTE THAT SENT YOU HERE WAS WRONG ON A FACT, AND IT IS NOW CORRECTED
   IN PLACE (see IMAGE_ONLY_PROMPT's keepTop bullet). It said: "The bottoms half of it
   is back on the wire - written INTO CATEGORY_ANCHOR.bottom ('Keep the subject's upper
   body and background unmodified.')". It is NOT. Read CATEGORY_ANCHOR.bottom: it ends
   at "Strictly preserve original pattern and color." and contains no opposite-layer
   sentence at all. KEEP_OPPOSITE_LAYER still sits above as a retired constant with no
   call site, exactly as the dynamic-drape revision left it, and `npm run trace:prompt`
   prints the bottoms branch without it. So there was never a shipping mirror to copy;
   this clause is the FIRST time either branch has carried an explicit opposite-layer
   lock since that revision retired the bottoms one.

   That does not change the shape chosen here - a region-named sentence inside the
   anchor literal is still right, for the reasons below - but it does mean the bottoms
   branch is STILL UNPROTECTED, and nothing here fixes that. Restoring it there is a
   separate one-line change ([P.HIGH, KEEP_OPPOSITE_LAYER] on the bottoms branch, or
   the same sentence written into the anchor) and a separate decision: no report has
   been filed against bottoms, the bottoms branch has 100+ free chars at every rung, and
   this file's rule is one clause at a time on evidence.

   INSIDE THE ANCHOR LITERAL, NOT A NEW PART, for two independent reasons.
   (a) Inside the anchor it CANNOT SHED. This clause exists to survive budget pressure -
   a lock that disappears exactly when the prompt gets long is not a lock - and P.CORE
   is the only tier that guarantees that. (b) conditioning-trace §4 asserts
   imageOnlyPrompt() contains EXACTLY ONE P.CORE and EXACTLY ONE P.HIGH
   (FRONT_CLOSURE_LOCK), so a second undroppable part is not structurally available even
   if it were preferable.

   A REGION, NOT GARMENT NOUNS - the single most important wording decision here, and
   the reason this says "lower body" where the report said "pants/shorts/green trousers".
   set() has no negative_prompt: every noun in this string ships in the POSITIVE prompt
   as a token the sampler steers TOWARD. "Strictly preserve the subject's pants/shorts/
   trousers" therefore hands a trouser token to a session whose shopper is wearing a
   skirt, a dress or a kilt, and the documented consequence of naming a garment this way
   is the tuxedo: CATEGORY_ANCHOR.top's own note records dropping the word "shirt" for
   precisely this reason ("NOT A NEGATION, for the reason this file keeps re-learning").
   A body REGION cannot be sampled into a garment. "shoes" is kept because it is a
   distinct object rather than alternative leg-wear.

   64 CHARACTERS, AND THE LENGTH WAS CHOSEN BY MEASUREMENT, NOT BY TASTE.
   Do not lengthen this sentence without re-running `npm run trace:prompt` and reading
   the size ladder. The first draft also named the waistline, at 75 chars, and those
   extra 11 characters put tops+front+closure at 651 against a 650 budget - one
   character over, which shed fitSentence() on ALL FIVE rungs of that branch and
   effectively un-did the 2026-09-03 size restore for every button-front top. At 64 the
   same branch lands on 640 and keeps its fit clause. The shed pattern is IDENTICAL at
   64 and at the 56-char exact mirror of the bottoms sentence, so "shoes" is free and
   "waistline" costs a whole ladder; that is the entire reason for this wording.

   THE COST THAT REMAINS, measured - trace:prompt's size ladder is the record:
     · plain tee, sizing DOWN 1-2 -> fitSentence sheds (663 and 709 needed vs 650).
     · structured + closure, sizing UP 2 -> fitSentence sheds (699 vs 650).
     · every other branch and rung keeps it, including all of bottoms and back.
   That is the same trade CLAUDE.md §0 already documents for the closure branch,
   widened by two rungs. It is the right way round - a lower body repainted on every
   frame is a worse failure than a missing tension phrase at one end of the ladder -
   but it IS a partial regression of the size feature restored on 2026-09-03, and it is
   not free. To buy those rungs back, the text to reclaim is getFitModifier()'s
   delta<=-2 phrasings (213 and 219 chars, the longest strings in the builder), NOT
   this lock's priority: dropping it below P.CORE would let it shed under exactly the
   budget pressure it exists to survive.

   FRONT TOPS ONLY, on this file's one-branch-at-a-time-on-evidence rule.
   BACK_CATEGORY_ANCHOR.top is deliberately left byte-identical (plain-tee-fidelity
   §7.4 pins it), so a shopper who turns around loses this lock for as long as the rear
   asset is on the wire. That is a KNOWN GAP, not an oversight - the report is against
   the front view, the back branch has 25 free chars at its tightest rung, and adding
   it there would shed the back branch's fit clause. If a rear-view lower-body leak is
   ever reported, that is the moment to spend those characters. */
const PLAIN_TEE_ANCHOR =
  "Drape and fit the EXACT static t-shirt from the reference image onto the live" +
  " subject's CURRENT body contour and volume in this frame. Keep the reference's plain" +
  " knit neckline and smooth unbroken front exactly as shown. Dynamically adapt the" +
  " garment drape to the subject's exact silhouette, angle, depth, and belly volume" +
  " without stretching or warping the fabric. Strictly preserve the original t-shirt" +
  " texture, pattern, and color. Keep the subject's lower body, shoes, and background" +
  " unmodified.";

/* The tee vocabulary. Hebrew first, both geresh spellings, for the reason BOTTOMS_TOKENS
   spells out: a Hebrew-only product title is the storefront's COMMON case, not an edge
   case. English is \b-anchored and carries the bare singular as well as the plural,
   because a storefront writes whichever reads better in its own layout.

   SLEEVELESS IS DELIBERATELY ABSENT - no גופי, no tank, no singlet. A tank top has no
   closure either, so it looks like it belongs here, but the anchor this predicate selects
   NAMES A T-SHIRT, and handing a model the word "t-shirt" over a sleeveless reference
   invites it to grow sleeves the reference never had. That trades a reported failure for
   an unreported one. Tanks keep today's behaviour until either a report or a third anchor
   justifies moving them. */
const PLAIN_TEE_TOKENS =
  /(טי[- ]?שירט|טישרט|חולצת טי|\bt-?shirts?\b|\btees?\b|\bcrew ?necks?\b|\bv-?necks?\b)/i;

/* The tops that DO fasten, and therefore must keep FRONT_CLOSURE_LOCK. This list outranks
   the tee list above, exactly as TOPS_TOKENS outranks BOTTOMS_TOKENS in isBottomsGarment()
   and for the same reason: when a title names both, the STRUCTURED noun is the garment and
   the other word is a modifier of it ("Tee Shirt Cardigan" is a cardigan).

   A BARE "shirt" IS NOT IN THIS LIST, AND THAT IS THE LOAD-BEARING OMISSION. Every top in
   this catalog ships with `type: "shirt"` (see the ITEMS table), and isPlainKnitTop() reads
   the type field. A \bshirts?\b here would match every tee that ever reaches this function,
   the predicate would return false for the entire catalog, and the fix above would be dead
   code that still passes a unit test written against `name` alone. Only nouns that
   genuinely imply a placket, a zip or an outer layer belong here.

   POLO AND HENLEY ARE ON THE LIST ON PURPOSE: both are knitwear, both read as "basically a
   tee" to a shopper, and both have a buttoned placket that daabb47's report is about. */
const STRUCTURED_TOP_TOKENS =
  /(מכופתר|כפתור|פולו|קרדיגן|בלייזר|ז['׳]קט|מעיל|קפוצ|\bbutton|\bzip|\bplackets?\b|\bpolos?\b|\bhenley\b|\boxford\b|\bchambray\b|\bflannels?\b|\bcardigans?\b|\bblazers?\b|\bjackets?\b|\bcoats?\b|\bhoodies?\b|\bshacket\b|\bblouses?\b)/i;

/**
 * Whether this garment is a PLAIN KNIT TOP - a tee with no closure and no collar.
 *
 * THE DEFAULT IS FALSE, and that is the whole safety property. An item we cannot classify
 * keeps the behaviour that shipped before this predicate existed (the "shirt" anchor plus
 * the closure lock), so an unrecognised title degrades to the OLD render rather than to a
 * new one - the same reasoning isBottomsGarment() defaults to tops on.
 *
 * ORDER: bottoms first (a trouser title carrying a tee token must never reach the tops
 * branch at all), then structured nouns, then the tee vocabulary. Reads the same metadata
 * fields isBottomsGarment() reads, so one catalog shape feeds both predicates.
 *
 * subType "short_sleeve" IS NOT EVIDENCE, and the report is the proof: the hallucinated
 * garment was itself a SHORT-SLEEVE button-down. Sleeve length says nothing about
 * construction, so only an explicit garment noun counts here.
 *
 * @param {{garmentType?:string, type?:string, category?:string, subType?:string,
 *          name?:string, title?:string}|null|undefined} item
 * @returns {boolean} true only for a top whose construction has no front closure.
 */
function isPlainKnitTop(item) {
  if (!item || isBottomsGarment(item)) return false;
  const fields = [item.type, item.category, item.subType, item.name, item.title]
    .filter(Boolean).join(" ");
  if (STRUCTURED_TOP_TOKENS.test(fields)) return false;
  return PLAIN_TEE_TOKENS.test(fields);
}

/* ── THE BURDEN OF PROOF, INVERTED - "the tee still has a slit down the front" ────
   THE SECOND REPORT, after the tee anchor above supposedly fixed the first: a plain
   crewneck rendering with a vertical centre-front seam, split as though it buttoned.

   WHY THE FIRST FIX MISSED IT. isPlainKnitTop() demands POSITIVE PROOF of a tee - an
   explicit tee noun in the title - before it will withhold the closure clause. Real
   storefronts do not oblige. "PEAK", "PEAK Oversized", "חולצה אוברסייז" and a bare widget
   handover with no title at all are all plain jersey tees, and every one of them fell to
   the default branch and was handed "buttons, zip or placket" anyway. The fix only ever
   worked for products whose titles already said what they were, which is the minority.

   SO THE DEFAULT WAS THE BUG, not the vocabulary. FRONT_CLOSURE_LOCK exists for garments
   that HAVE a front closure; on anything else its four nouns are free-floating tokens in a
   positive prompt, which is the whole mechanism this file keeps re-learning. Asking "can I
   prove this is a tee?" puts the cost of every unrecognised title on the wrong side.
   Asking "can I prove this FASTENS?" puts it on the side where being wrong is cheap.

   THE TRADE, STATED PLAINLY BECAUSE IT IS A REAL ONE. A button-down whose title names no
   closure now loses the lock and could render open again - daabb47's report. That is the
   INVENTED-DETAIL class: the right garment in a wrong state. What it buys is the
   WRONG-GARMENT class, on a catalog where tees vastly outnumber button-downs. This file
   has ranked those twice already and both times the answer was the same - a garment fitted
   with an unstated closure is a worse render, a garment fitted as a different garment is a
   different garment.

   IT SPENDS NO BUDGET. This removes a clause from most tops and adds nothing, which is the
   direction every fidelity report in this file has wanted.

   @param {object|null|undefined} item
   @returns {boolean} true only when the title gives positive evidence of a front closure. */
function hasFrontClosure(item) {
  if (!item || isBottomsGarment(item)) return false;
  const fields = [item.type, item.category, item.subType, item.name, item.title]
    .filter(Boolean).join(" ");
  return STRUCTURED_TOP_TOKENS.test(fields);
}

const CATEGORY_ANCHOR = Object.freeze({
  /* The two strings share one spine - bind the static garment, adapt to the current
     contour, preserve the original - and differ in exactly two places: the garment noun,
     and WHICH contour is named (whole-body on tops, lower-body on bottoms). The
     lower-body naming is what keeps the shirt-replacement fix alive on the branch it was
     reported against; see the bullet list above for the half of it that came off. */
  /* ── THE ANCHOR NOUN - "every casual top still renders with a collar and buttons" ──
     THE THIRD REPORT in this sequence, after FRONT_CLOSURE_LOCK was gated (8d89805) and
     the tee branch was split off (734b4b3). Casual tops and graphic tees were STILL
     coming back as button-downs, and neither earlier fix was wrong - by then a plain top
     reached the wire with zero closure TOKENS. The remaining lean was this noun.

     PLAIN_TEE_ANCHOR's comment diagnosed it and fixed only half: "CATEGORY_ANCHOR.top
     says 'the EXACT static SHIRT', and in English an unqualified 'shirt' leans
     woven-and-buttoned. That was survivable while it was the only signal." It judged the
     noun survivable alone and moved only the PROVEN tees off it. But this is the DEFAULT
     branch, and isPlainKnitTop() demands positive proof - so every brand-named,
     Hebrew-titled and untitled casual top in a real storefront (the majority) stayed on
     the one word this file had already named as leaning toward a placket.

     "top" IS CONSTRUCTION-NEUTRAL. It still commits to the upper body - the one thing
     this anchor must keep saying, and the half that keeps the shirt-replacement fix alive
     on the bottoms branch below - while saying nothing about weave, collar or closure in
     either direction. A garment that genuinely fastens is now described by
     FRONT_CLOSURE_LOCK, which states its closure explicitly and has evidence behind it,
     rather than by a default noun that never did.

     NOT A NEGATION, for the reason this file keeps re-learning. The obvious patch is "no
     buttons, no collar, no placket"; set() has no negative_prompt, so those nouns would
     ship in the POSITIVE prompt as tokens the sampler steers toward - the shape that
     produced the tuxedo and daabb47's button-down. Removing the leaning word costs
     nothing, cannot be sampled backwards, and RETURNS budget: 342 -> 338 chars.

     FRONT + TOPS ONLY, on the one-branch-at-a-time-on-evidence rule. The report names
     collars, plackets and buttons - all front features. BACK_CATEGORY_ANCHOR keeps
     "shirt" byte-identical, exactly as PLAIN_TEE_ANCHOR left it; plain-tee-fidelity §7.4
     pins that, and §7.1-§7.8 pin the rest of this note. */
  /* ── THE LOWER-BODY ISOLATION LOCK ──
     keepTop, restored, after the "it repainted my green trousers" report. The last
     sentence is the region-flipped counterpart of the retired KEEP_OPPOSITE_LAYER
     constant above - NOT a copy of a clause the bottoms anchor ships, because it does
     not ship one (that claim in the old restore note was false and is corrected at both
     ends; bottoms remains unprotected). Full rationale - including why it names a REGION
     rather than "pants/shorts/trousers" (those are positive tokens a sampler steers
     toward; see this anchor's NOT A NEGATION note above), why it lives inside the anchor
     literal, and the measured cost to fitSentence() on the tightest size rungs - is in
     the comment block above PLAIN_TEE_ANCHOR, which carries the identical sentence. */
  top:
    "Drape and fit the EXACT static top from the reference image onto the live" +
    " subject's CURRENT body contour and volume in this frame. Dynamically adapt the" +
    " garment drape to the subject's exact silhouette, angle, depth, and belly volume" +
    " without stretching or warping the fabric. Strictly preserve the original top" +
    " texture, pattern, and color. Keep the subject's lower body, shoes, and" +
    " background unmodified.",
  bottom:
    "Drape and fit the EXACT static pants/shorts from the reference image onto the live" +
    " subject's CURRENT lower-body contour and volume in this frame. Dynamically adapt" +
    " the fit to the subject's exact waistline, leg profile, depth, and angle without" +
    " distorting the garment design. Strictly preserve original pattern and color.",
});

/* THE BACK COUNTERPART - the single-asset rear render.
   ────────────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS AT ALL. applyGarment() resolves the orientation, freezes it as
   `angleAtStart`, and used to hand it to buildPrompt() - which discarded it. Every
   single-asset render therefore shipped the FRONT anchor no matter which way the shopper
   was facing, so turning around re-rendered the chest print on their back. COMPOSITE mode
   never had this bug (buildCompositePrompt() takes the angle and names the panel), which
   is why it only ever reproduced with a front-only reference.

   WHY A SECOND FROZEN ANCHOR AND NOT A CLAUSE APPENDED TO THE FIRST. This is the whole
   constraint, and image-first.test.mjs's header is the record of it: the tuxedo regression
   was reported TWICE, and the fix that finally held was reducing the TOTAL VOLUME of text
   competing with the reference image - not removing text of any particular kind. FIX ONE
   kept the structural clauses (panel contract, pose, passthrough locks) on the theory that
   a clause describing no garment cannot summon one; the tuxedo survived it. So appending
   angleClause()'s output here - contract + pose + selector + depth, the shape the call site
   used to build - would re-open that failure through the front door. SELECTING between two
   frozen strings holds volume flat instead: one anchor ships, exactly as before, and only
   which one changes.

   The front anchor above is deliberately left BYTE-IDENTICAL. Nothing about the
   front-facing render changes with this pair; the only new behaviour is on the back. */
const BACK_CATEGORY_ANCHOR = Object.freeze({
  /* Same spine as the front anchors - bind the static garment, adapt to the current
     contour, preserve the original - with the region re-pointed at the back and ONE
     clause added. That clause's WORDING was the bug below; its PURPOSE stands.

     ── "IT DREW 'PEAK PEAK', BLANK WHITE BOXES AND GENERIC LINES ON MY BACK" ─────────
     The clause used to read: "Precisely lock the rear print, logos, and back seams."
     It was meant to stop a back render reproducing the front graphic. What it actually
     did, once the printed-back path started shipping, is visible in the report item by
     item - each hallucination maps onto one noun in that single sentence:
         "logos"       -> "PEAK PEAK"         the garment's brand text, drawn repeatedly
         "print"       -> blank white boxes   a print-shaped placeholder with nothing in it
         "back seams"  -> generic lines       seam strokes the reference never had
     Decart's set() has no negative_prompt, so every noun in this string is a POSITIVE
     token the sampler steers toward. Telling the model to "lock the logos" does not
     make it copy the reference's logos; it makes it produce logos. This is the tuxedo
     mechanism again - CATEGORY_ANCHOR.top, PLAIN_TEE_ANCHOR and PLAIN_BACK_ANCHOR each
     record a version of it - reached through the one back sentence nobody had touched.

     It surfaced only now because this anchor only recently started shipping for this
     garment: while the classifier mislabelled the rear photo the product got a synthetic
     back and PLAIN_BACK_ANCHOR instead. Fixing that exposed this.

     THE REPLACEMENT NAMES NO GRAPHIC AT ALL. It points at the reference image and says
     to reproduce the rear panel as shown - which is the original intent, expressed as
     grounding rather than as a list of things to draw. Whatever artwork is on the
     reference (a photograph, lettering, nothing) is what "as shown" means, so the same
     sentence is correct for every garment and asserts nothing the pixels do not.
     plain-back-anchor.test.mjs now pins the ABSENCE of graphic nouns on this anchor
     too, not only on the plain one. */
  top:
    "Drape and fit the EXACT static shirt's REAR/BACK side from the reference image onto" +
    " the live subject's CURRENT back contour and volume in this frame. Reproduce the rear" +
    " panel exactly as shown in the reference. Dynamically adapt the garment drape to the" +
    " subject's exact silhouette, angle, depth, and back volume without stretching or" +
    " warping the fabric. Strictly preserve the original shirt texture, pattern, and color.",
  bottom:
    "Drape and fit the EXACT static pants/shorts REAR/BACK side from the reference image" +
    " onto the live subject's CURRENT lower-body contour and volume in this frame." +
    " Reproduce the rear panel exactly as shown in the reference. Dynamically adapt the fit to" +
    " the subject's exact waistline, leg profile, depth, and angle without distorting the" +
    " garment design. Strictly preserve original pattern and color.",
});

/* ── THE PLAIN-BACK ANCHOR - "it drew scrambled black graphics on my back" ─────────
   ────────────────────────────────────────────────────────────────────────────────
   REPORTED against a white tee whose front carries "BE YOUR OWN Healer WORLDWIDE" and
   whose rear reference is 100% blank white fabric. Turning around produced scrambled
   black graphics across the shopper's back. The reference was correct; the PROMPT asked
   for it.

   THE ROOT CAUSE IS ONE SENTENCE IN THE PAIR ABOVE: "Precisely lock the rear print,
   logos, and back seams." It ships on EVERY back render, and on a blank back it asserts
   a print and logos that do not exist. Decart's set() has no negative_prompt, so "print"
   and "logos" reach the sampler as POSITIVE tokens to steer toward - the prompt is
   instructing the model to invent rear graphics, and it obliges. Nothing about the
   reference image was wrong and no amount of reference fidelity could have overridden a
   direct instruction.

   THIS IS THE SAME BUG PLAIN_TEE_ANCHOR ALREADY FIXED ON THE FRONT, and the fix is the
   same shape. That anchor exists because CATEGORY_ANCHOR.top's word "shirt" kept
   summoning collars and plackets onto plain tees, and its note records the resolution in
   full: the fix was NOT a negation ("no buttons, no collar, no placket"), because those
   nouns would ship in the positive prompt as tokens the sampler steers toward - "the
   shape that produced the tuxedo". The fix was to DESCRIBE THE PLAINNESS POSITIVELY
   ("Keep the reference's plain knit neckline and smooth unbroken front exactly as
   shown") and to SELECT that anchor on positive evidence. This does exactly that, on the
   back.

   SO IT NAMES NO GRAPHIC NOUNS AT ALL. The obvious patch - and the one specified when
   this was reported - is "the rear fabric is 100% PLAIN WHITE with ZERO text, zero
   logos, and zero black chest graphics; strictly forbid carrying over front chest text".
   Every one of those phrases puts a graphic noun on the wire: text, logos, black chest
   graphics, front chest text. With no negative_prompt to attach them to, that wording is
   a RICHER instruction to draw graphics than the sentence it replaces. It would make the
   reported bug worse, and it is 290 characters against 135 free on this branch, so it
   would also hard-slice. "Smooth unbroken fabric" cannot be sampled into a logo.

   IT SHRINKS THE WIRE: 41 characters replacing 52, so the back anchor drops 412 -> 401.
   Every fidelity fix in this file has to shrink it (plain-tee-fidelity §7.3) for the same
   text-volume reason, and this one does.

   SELECTED ON POSITIVE EVIDENCE ONLY, never assumed - the §2.1 discipline, applied to a
   different question. `item.backIsPlain === true` means the server positively established
   a blank rear: either it GENERATED the rear (synthesizeBackView explicitly reconstructs
   unbroken fabric and forbids carrying the front graphic over), or the classifier
   transcribed the real rear photo and found no lettering. Undefined or false keeps the
   pair above byte-identical. Guessing "plain" on a garment with a genuine back print
   would suppress the one graphic the shopper turned around to see - the print-less-back
   bug, inverted - so abstention is the safe direction here too. */
const PLAIN_BACK_ANCHOR = Object.freeze({
  /* Byte-identical to BACK_CATEGORY_ANCHOR except for the one clause. Kept as a full
     frozen literal rather than assembled from the pair above, because the angle/
     construction axes in this file SELECT between frozen strings and never concatenate -
     see BACK_CATEGORY_ANCHOR's own note on why appending re-opens the tuxedo. */
  top:
    "Drape and fit the EXACT static shirt's REAR/BACK side from the reference image onto" +
    " the live subject's CURRENT back contour and volume in this frame. The rear panel is" +
    " smooth unbroken fabric. Dynamically adapt the garment drape to the" +
    " subject's exact silhouette, angle, depth, and back volume without stretching or" +
    " warping the fabric. Strictly preserve the original shirt texture, pattern, and color.",
  bottom:
    "Drape and fit the EXACT static pants/shorts REAR/BACK side from the reference image" +
    " onto the live subject's CURRENT lower-body contour and volume in this frame." +
    " The rear panel is smooth unbroken fabric. Dynamically adapt the fit to" +
    " the subject's exact waistline, leg profile, depth, and angle without distorting the" +
    " garment design. Strictly preserve original pattern and color.",
});

/* The surviving halves of the old frozen string, split into individually priority-taggable
   parts. Every one of these is a reproduced regression and the wording is deliberately
   unchanged from the string it came out of - only the t-shirt ANCHOR was replaced.

   WHAT IS STILL ASSEMBLED, so nothing here reads as dead code by accident:
   VOLUME_PERSISTENCE and CLOSED_BACK_HEM ship on the FULL-LOOK path (lookAnchorPrompt),
   which was never collapsed. FRONTAL_VOLUME and REFERENCE_EXTRACTION are referenced by no
   builder at all - retired, not deleted, and kept verbatim because a restore that starts
   by rewriting the clause is not a restore. REFERENCE_EXTRACTION is the newer of the two
   retirements: STRICT_REFERENCE_LOCK's first sentence states the same provenance rule and
   also names logos and cut, so shipping both would spend budget restating one
   instruction. Deleting either constant breaks image-first.test.mjs §1 on purpose. */
const VOLUME_PERSISTENCE =
  "Maintain the exact same abdomen/stomach depth, waist volume, and torso thickness" +
  " continuously through all 360-degree rotations—never flatten or reset body size" +
  " mid-stream.";
const FRONTAL_VOLUME =
  "In front-facing (0-degree) views, realistically render the stomach's forward volume and" +
  " convexity using natural fabric drape, forward hem extension, and subtle lighting falloff.";
/* Both of these describe a SHIRT's construction - the knotted hem and the open back flap
   were top-specific failures - so they are simply not part of a trousers prompt rather
   than being reworded into a lower-body equivalent nobody has reproduced a bug for. */
const CLOSED_BACK_HEM = "Preserve a closed back and normal un-knotted hem.";
const REFERENCE_EXTRACTION = "Use only the reference image's graphics, fabric texture, and color.";

/* ── Temporal persistence - the prompt half of the presence fix ───────────────────
   The presence GATE stops a session opening on an empty frame. This covers what the gate
   cannot: the shopper who is briefly occluded, half out of shot, or steps back in
   mid-window. Every previous revision of this prompt described a subject who was assumed
   to be THERE, so a frame where they are not yet visible had no language attached to it
   at all - and an unstated state is what this file's history keeps recording as the thing
   the model reinterprets.

   "AS SOON AS VISIBLE" IS THE LOAD-BEARING PHRASE, not filler. It tells the model the
   subject may be absent RIGHT NOW and that the correct response is to wait and then fit -
   rather than to fit something to whatever is currently in frame, which is exactly how a
   garment ends up rendered onto a wall or a chair.

   The second sentence is scoped to the OPPOSITE region plus the background, so it
   reinforces the anchor's own isolation rule rather than competing with it. */
const TEMPORAL_PERSISTENCE = Object.freeze({
  top:
    "Continuously track and strictly fit the reference top to the subject's torso as soon" +
    " as visible. Keep lower body and background natural and unmodified.",
  bottom:
    "Continuously track and strictly fit the reference shorts/pants to the subject's lower" +
    " body as soon as visible. Keep upper body and background natural and unmodified.",
});

/* Lower-body tokens. Hebrew FIRST because it is the storefront's primary language, so a
   Hebrew-only product title is the common case here rather than an edge case; both geresh
   spellings are listed (U+05F3 ׳ and a plain ASCII apostrophe) because storefronts use
   them interchangeably. "מכנס" is left unanchored on purpose - Hebrew inflects by suffix
   (מכנסיים/מכנסי) and a prefix match covers the whole family.

   THE ENGLISH SIDE IS \b-ANCHORED AND USES "shorts" PLURAL, DELIBERATELY. A bare /short/
   matches "short_sleeve" - the subType this very file sets on tees - which would classify
   a t-shirt as trousers and repaint the shopper's real jeans: the reported bug, inverted.
   Same reason "sweatpants"/"tracksuit" are listed in full rather than relying on \bpants\b
   to find them inside a compound. */
/* SINGULARS ARE NOT OPTIONAL HERE. "Wool Trousers" matched and "Wide Leg Trouser" did
   not; "Chinos" matched and "Chino" did not. A storefront writes whichever reads better
   in its own layout, and a miss falls through to the tops default silently - the same
   silent-default failure the Hebrew stem work above was filed against, in English.
   `s?` everywhere a garment noun has a bare singular in real product titles.

   STILL DELIBERATELY ABSENT, because each would cost more than it buys:
     · "denim" / bare "jean" - a fabric, not a garment. "Denim Jacket" and "jean jacket"
       are common real products and are TOPS; see FABRIC_AMBIGUOUS, which exists because
       ג'ינס collides the same way.
     · "cargo" - "Cargo Pants Print Tee" is the counter-example this file already
       carries, and cargo names a POCKET STYLE that appears on jackets and shorts alike.
     · "טרנינג" / "tracksuit" - names a two-piece set; the top half is as common a
       product as the bottom. ("tracksuit" is grandfathered in below rather than added.)
     · "overalls" / "dungarees" - genuinely full-body, so neither branch is right.
   Each of these needs the title's OTHER nouns to disambiguate, which is tier 2's job -
   and abstaining into tier 2 beats guessing here. */
const BOTTOMS_TOKENS =
  /(מכנס|ג['׳]ינס|חצאי|שורט|טייץ|טייצ|לגינ|סווטפנט|דגמ["״'׳]?ח|\bpants\b|\btrousers?\b|\bshorts\b|\bjeans\b|\bskirts?\b|\bleggings\b|\bchinos?\b|\bjoggers?\b|\bsweatpants?\b|\btracksuit\b|\bslacks\b|\bculottes\b|\bbermudas?\b|\bcapris?\b|\bpalazzo\b|\bbottoms?\b)/i;

/* The tops half of the same vocabulary, and it exists for ONE job: to outrank a bottoms
   token when a title names an actual upper-body garment. See isBottomsGarment() for the
   collision it resolves (denim jacket / ז'קט ג'ינס). Hebrew entries are STEMS and English
   entries are word-bounded, for the reason GARMENT_CATEGORY_KEYWORDS spells out: Hebrew
   inflects by suffix, while an English stem match on "short" would swallow "short sleeve".
   Kept beside BOTTOMS_TOKENS rather than reusing GARMENT_CATEGORY_KEYWORDS because the
   prompt-layer sandboxes slice this file from `const P = ...` and would not have it. */
const TOPS_TOKENS =
  /(חולצ|טישרט|טי-שירט|סווטשירט|סוודר|גופי|ז['׳]קט|מעיל|קפוצ|בלייזר|קרדיגן|\bshirts?\b|\bt-?shirts?\b|\btees?\b|\bjackets?\b|\bcoats?\b|\bhoodies?\b|\bsweaters?\b|\bsweatshirts?\b|\bblazers?\b|\bcardigans?\b|\bblouses?\b|\bpolos?\b|\btanks?\b|\bpullovers?\b|\btops?\b)/i;

/**
 * Which body region a garment belongs to.
 *
 * ORDER IS THE WHOLE DESIGN: garmentType is GROUND TRUTH when present. It is what
 * toItem() sets and what slotOf() already routes the outfit slots on, so a keyword sweep
 * that could override it would let a product NAME re-categorise an item the catalog had
 * already classified correctly - strictly worse than the metadata it second-guesses, and
 * the "Cargo Pants Print Tee" case is not hypothetical. Keywords are consulted ONLY for
 * items that arrived without a category at all (a bare widget handoff, a custom upload).
 *
 * DEFAULTS TO TOPS on absent/unknown input, matching the pre-existing bias of every
 * predicate around it (slotOf() returns "top" for anything not explicitly lower_body):
 * tops are the overwhelming majority of the catalog, so an unknown item guessed as tops
 * is wrong far less often - and its failure mode is the OLD behaviour, not a new one.
 *
 * @param {{garmentType?:string, type?:string, category?:string, subType?:string,
 *          name?:string, title?:string}|null|undefined} item
 * @returns {boolean} true only for a lower-body garment.
 */
function isBottomsGarment(item) {
  if (!item) return false;
  /* SERVER COPY - the browser's verdict wins. fitting-room/app.js keeps the original of
     this function (sizing, go-live and the presence gate read it synchronously) and sends
     its answer as item.__bottoms, so the prompt and the size chart can never disagree
     about which body region a garment covers. The body below is the same text as the
     browser's (test/prompt-engine.test.mjs asserts it) and only runs for callers that
     supply no verdict - the prompt suites, and the tracer. */
  if (typeof item.__bottoms === "boolean") return item.__bottoms;
  if (item.garmentType === "lower_body") return true;
  if (item.garmentType === "upper_body") return false;
  const fields = [item.type, item.category, item.subType, item.name, item.title]
    .filter(Boolean).join(" ");
  /* AN EXPLICIT TOP NOUN OUTRANKS A BOTTOMS TOKEN, and this is the same collision
     classifyGarmentTitle() resolves with FABRIC_AMBIGUOUS one tier up - it just never
     reached here. "ז'קט ג'ינס" and "denim jacket" match ג'ינס/jeans while naming a JACKET:
     the garment noun is the subject and the fabric is a modifier of it, so the fabric must
     not decide the region. Left unresolved, a denim-jacket try-on routes to the bottoms
     branch and repaints the shopper's real trousers - the exact mirror of the long-trouser
     report this pass was filed against.

     RESOLVED TOWARD TOPS RATHER THAN BY REGEX ORDER, which also matches this function's
     own documented default: when a title genuinely names both regions there is no evidence
     to prefer one, and tops is the answer every predicate around it already gives. */
  if (TOPS_TOKENS.test(fields)) return false;
  return BOTTOMS_TOKENS.test(fields);
}

/**
 * The image-only prompt, resolved for THIS garment's category.
 *
 * ONE P.CORE PART, ON BOTH BRANCHES. There is no assembly left here: the function SELECTS
 * a frozen anchor (338 chars on tops, 320 on bottoms) and hands it to fitPrompt() as a
 * single part. The seven-clause assembly this used to run - and the priority tags that
 * decided what shed out of it - is described in CATEGORY_ANCHOR's comment above, together
 * with what came off the wire and how to put any of it back.
 *
 * FROZEN PER CATEGORY, NOT PER FRAME - and that is deliberate even though the anchor now
 * talks about "this frame". The per-frame half of the fix is not text: it is
 * the topology monitor (see reconditionForTopology) forcing a genuine re-conditioning
 * dispatch when the live body has moved, so the model re-reads a CURRENT frame rather
 * than being handed a description of one. Interpolating live measurements into the prompt would put this
 * function straight back into the text-volume competition every report in this sequence
 * was caused by, and would make the string non-constant for no gain.
 *
 * STILL ROUTED THROUGH fitPrompt() rather than returned raw, and that is not ceremony at
 * this length: it normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit
 * that lengthens an anchor - or adds the second part the restore notes describe - is
 * clamped HERE instead of over-running into clampPromptForWire()'s hard slice, which cuts
 * at the END and would take the fidelity sentence with it. The budget itself is
 * Decart's and app.js:5862 explicitly forbids raising it ("the ceiling is the API's, not
 * ours").
 *
 * @param {object|null} item - the garment being fitted; null resolves to the tops branch.
 * @returns {string}
 */
function imageOnlyPrompt(item, angle = "front") {
  /* ONE PART, BOTH BRANCHES. There is no assembly left on either side - see
     CATEGORY_ANCHOR above for the reports that drove it there, for the full list of what
     came off the wire, and for why bottoms names the lower body where tops names the
     whole contour.

     STILL ROUTED THROUGH fitPrompt() rather than returned raw, even at 338/320 chars:
     it normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit that
     lengthens an anchor is clamped here instead of over-running into
     clampPromptForWire()'s hard slice, which cuts at the END and would take the
     fidelity sentence with it.

     TO BUY A CLAUSE BACK, add it as a second part here - `[P.HIGH, STRICT_REFERENCE_LOCK]`
     for the hallucination clamp, `[P.HIGH, KEEP_OPPOSITE_LAYER]` on the bottoms branch for
     the opposite-layer pin; both are the retirements this revision made. The budget is not
     the constraint - 308 characters are free on tops and 330 on bottoms - so the only
     question is whether that text is worth the weight it takes away from the reference
     image, which is the mechanism every report in this sequence shares. One at a time,
     re-tested live. */
  /* `angle` SELECTS a frozen anchor, and only that - it is never interpolated, appended to,
     or used to build a string. Anything other than the literal "back" resolves to FRONT:
     an unrecognised value must land on the side every caller rendered before this parameter
     existed, not on a silent back-render nobody asked for.

     It is a PARAMETER rather than a live effectiveAngle() read for the TOCTOU reason
     applyGarment() documents at length: the prompt and the reference image must be resolved
     against the SAME orientation reading. A prompt built from a fresh read while the image
     was resolved from the frozen one is the mixing bug that comment records. */
  /* ── THE FOURTH FROZEN AXIS: rear construction ────────────────────────────────────
     A back render on a garment PROVEN to have a blank rear selects PLAIN_BACK_ANCHOR,
     which is byte-identical to BACK_CATEGORY_ANCHOR except that it does not claim a
     "rear print, logos" the garment does not have. That claim is what drew scrambled
     graphics on a blank back: with no negative_prompt, those nouns are positive tokens.
     See PLAIN_BACK_ANCHOR for the report and for why the fix is a positive description
     rather than the specified "ZERO text, zero logos" negation.

     STILL A SELECTOR, so the volume-flatness this file guards stays intact: exactly one
     anchor ships, nothing is concatenated, and the plain variant is SHORTER than the one
     it replaces. `=== true` and not a truthy test - undefined (nobody looked) and false
     (a real rear print) must both keep the existing wording. */
  /* ── AND THE PIXELS GET A VETO ────────────────────────────────────────────────────
     The verdict above is a claim ABOUT the rear photo, so a measurement OF that photo can refuse
     it: `_backLooksPrinted` is set once, at pre-load, when the rear measurably carries a graphic
     (blobLooksPrinted - measured at 6.6x plain fabric on the garment this was reported against).
     A rear that measures flat is untouched, so the scrambled-graphics fix PLAIN_BACK_ANCHOR
     exists for is intact; a rear that measurably has a print can no longer be described as
     smooth unbroken fabric by a classifier that got it wrong. `!== true` keeps the veto itself on
     positive evidence: unprobed (undefined) changes nothing. */
  const plainBack = angle === "back" && item && item.backIsPlain === true && item._backLooksPrinted !== true;
  const anchors = angle === "back"
    ? (plainBack ? PLAIN_BACK_ANCHOR : BACK_CATEGORY_ANCHOR)
    : CATEGORY_ANCHOR;
  const bottoms = isBottomsGarment(item);
  /* THE SECOND PART the restore notes describe, and the first one actually bought back.
     P.HIGH, not P.CORE: under budget pressure fitPrompt() sheds it before it will touch
     the anchor, which is the correct order - a garment fitted with an unstated closure is
     a worse render, but a garment fitted with no anchor at all is a different garment.
     Tops + front only; see FRONT_CLOSURE_LOCK for why it is not spent elsewhere. */
  /* THE THIRD SELECTOR - construction. Scoped to the FRONT TOPS branch, which is the only
     place FRONT_CLOSURE_LOCK ever shipped and therefore the only place the button-down
     hallucination could be summoned from; see PLAIN_TEE_ANCHOR for the report and for why
     the back pair is deliberately left alone. It SELECTS between frozen literals like the
     other two axes - still exactly one anchor on the wire, still nothing concatenated. */
  const plainTee = !bottoms && angle !== "back" && isPlainKnitTop(item);
  /* POSITIVE EVIDENCE ONLY - see hasFrontClosure(). This used to be `!plainTee`, i.e. every
     top we could not prove was a tee, which handed placket tokens to every brand-named,
     Hebrew-titled and untitled tee in the catalog. The two predicates are mutually
     exclusive by construction (isPlainKnitTop bails on the same structured tokens this
     one requires), so a prompt can never name a seamless front and a fastened placket
     together. */
  const closure = !bottoms && angle !== "back" && hasFrontClosure(item);
  /* ── SIZE-OVERRIDE RESTORE - "I tried on a size down and it fit exactly like true-to-size" ──
     REPORTED: shoppers who deliberately size up or down see no difference in how the
     garment drapes - the size picker still works and still re-applies (setSizeOverride()),
     but nothing about that choice ever reached Decart. This was the retirement
     IMAGE_ONLY_PROMPT's comment names as fitSentence - "the size-override selector's only
     route into the render" - cut along with everything else when this file went strict
     image-only. It is being bought back alone, per that comment's restore procedure.

     WHY THIS ONE IS SAFE TO BUY BACK: getFitModifier() (below) was rewritten after the
     "it compressed me into a thinner frame" report specifically so every string attributes
     tightness to the GARMENT and the FABRIC over a body whose dimensions are fixed, never
     to the body's outline - see that function's header comment. Restoring it does not
     reintroduce the mechanism that produced that bug; it only reconnects a clause that was
     already rewritten to be safe.

     P.MED, one tier BELOW the closure lock, ON PURPOSE - NOT AN OVERSIGHT TO "FIX" LATER.
     A garment rendered at the wrong tension is a worse fit, but a button-down rendered
     hanging open (FRONT_CLOSURE_LOCK's own report) is the worse failure, so under budget
     pressure this sheds first. delta === 0 (no size override) returns a short "true-to-size"
     phrase, so the common case costs little.

     THE CONCRETE COST: on tops + front + closure (487/650 base, 163 free), the size-down
     phrasings run 167 chars (delta -1) and 213 chars (delta -2) - both over the 163 free,
     so fitPrompt() sheds them and a shopper who sizes DOWN on a button-front top sees no
     tension text at all. True-to-size and sizing UP (88/89/147 chars) always fit. Every
     other branch (plain tee, structured-no-closure, back, bottoms) has 219-330 free chars
     and the fit sentence always survives, worst case ~230 chars (lower_body delta -2).

     DO NOT "FIX" THIS BY RAISING TO P.HIGH. Priority ties are broken by array position in
     fitPrompt(), not by severity - FRONT_CLOSURE_LOCK is added before this clause, so an
     equal-priority tie is not guaranteed to protect it, and a shirt rendered wide open
     (the report FRONT_CLOSURE_LOCK exists for) is worse than missing tension text. If the
     size-down-on-a-closure-top gap ever gets its own report, the fix is to shrink something
     ELSE on that branch to free the 4-50 chars needed, not to reorder these two tiers.
     Documented in CLAUDE.md §0 as a known, deliberate limitation.

     image-first.test.mjs's "size-override modifier no longer reaches the wire" check is
     updated in the same commit - this clause is what it now asserts IS wired. */
  /* ── THE GARMENT IDENTITY LOCK - P.CORE, and PROMOTED FROM P.LOW ON PURPOSE ──────
     "Decart rendered a random t-shirt instead of the garment Gemini prepared."

     Names the garment's MEASURED colour and its transcribed print - the two facts the
     prompt could not state before, because they are per-product measurements rather than
     anything an anchor could hold. Threaded server -> widget -> item, never baked into a
     constant, so one product's identity cannot leak into another's prompt.

     THE PROMOTION IS THE CHANGE, and it reverses a deliberate earlier decision, so the
     earlier reasoning is worth stating: at P.LOW this clause sheds FIRST, which made it
     purely additive and guaranteed it could never displace fitSentence. That was the
     right call while it was a colour HINT. It is the wrong call for an identity LOCK -
     a clause whose entire job is to stop the model substituting a different garment
     cannot be the first thing dropped when the prompt gets long, because a long prompt is
     exactly when the reference image is losing the argument. So it moves to P.CORE, where
     fitPrompt() cannot shed it.

     THE COST, measured (trace:prompt size ladder): on tops + front + closure the base is
     552 of 650, so after fit(0)'s 88 chars only 9 remain - ANY lock larger than that
     evicts fitSentence (P.MED) on that one branch. Accepted, and specified: a garment
     rendered as the WRONG GARMENT is a worse failure than one rendered at the wrong
     tension. Every other branch keeps both clauses.

     A SECOND P.CORE PART, which conditioning-trace §4 previously pinned as impossible
     ("exactly ONE anchor ships"). That assertion is updated in the same commit rather
     than loosened: the invariant it protected - volume stays FLAT across the ANGLE axis,
     because the angle SELECTS a frozen anchor rather than appending to one - is still
     true and still asserted. This part is not an angle variant; it is per-product data,
     it is length-capped at IDENTITY_LOCK_MAX_CHARS, and it is angle-AWARE only in that
     the print half is withheld on the back (see identityLockSentence: asserting front
     lettering over a back reference is the double-print bug through the prompt). */
  return fitPrompt([
    [P.CORE, plainTee ? PLAIN_TEE_ANCHOR : bottoms ? anchors.bottom : anchors.top],
    [P.CORE, identityLockSentence(item, angle)],
    ...(closure ? [[P.HIGH, FRONT_CLOSURE_LOCK]] : []),
    [P.MED, fitSentence(bottoms ? "lower_body" : "upper_body")],
  ]);
}

const LOOK_ANCHOR =
  "Fit and replace BOTH the subject's upper garment and lower garment using the exact" +
  " garments from the reference image, which shows the top above the bottom as two" +
  " separate products. Render both simultaneously on the subject.";

/**
 * The full-look prompt - the THIRD case, and the one that must claim both layers rather
 * than isolate one. See buildLookPrompt() for why it cannot route through
 * imageOnlyPrompt(). Assembled the same way so it inherits the same budget guarantee.
 *
 * IT CARRIES THE STRICT LOCK TOO, and that is what this revision added here. The 1:1
 * collapse rewrote both category anchors around STRICT_REFERENCE_LOCK and left this path
 * on its old four-clause assembly, so the INVENTED-DETAIL report - the right garment
 * rendered with textures the reference never had - stayed reproducible through Full Look
 * while being fixed everywhere else. Nothing about that failure is specific to how many
 * garments are being replaced, so the clamp belongs on every path that reaches Decart.
 *
 * REFERENCE_EXTRACTION CAME OFF IN THE SAME EDIT rather than sitting beside it: the lock's
 * first sentence IS the provenance rule ("Exactly match color, pattern, logos, and cut"),
 * which this file already documents as superseding it, and shipping both would spend ~67
 * characters restating one instruction - the text-volume-against-the-reference mechanism
 * every report in this sequence shares. Net change: +20 characters, 533 of 650.
 *
 * VOLUME_PERSISTENCE and CLOSED_BACK_HEM STAY, unlike on the single-garment branches. This
 * path was never collapsed, no full-look report has been filed against clause count, and
 * removing them here would be a change made on no evidence. They are also the two clauses
 * a full-look render needs most, since it replaces the torso garment and the hem with it.
 *
 * A FUNCTION, not a module constant, and deliberately so: a `const X = fitPrompt(...)` at
 * module scope runs at LOAD time, which makes PROMPT_MAX_CHARS a load-order dependency for
 * every consumer - including the test harnesses that slice this file into a sandbox and
 * only stub the globals their own section needs. One of them (angle-race) does not, and a
 * load-time call turns that into a ReferenceError before a single assertion runs. Resolved
 * on demand it costs nothing measurable and cannot fail at import.
 * @returns {string}
 */
function lookAnchorPrompt() {
  return fitPrompt([
    [P.CORE, LOOK_ANCHOR + STRICT_REFERENCE_LOCK],
    [P.HIGH, VOLUME_PERSISTENCE],
    [P.MED,  CLOSED_BACK_HEM],
  ]);
}

/* The dense clause table. Deliberately lower-case and lightly punctuated wherever the
   meaning survives it: ALL-CAPS and heavy punctuation both tokenize worse than prose,
   so the few capitals left (EDGE-ON, LEFT/RIGHT) are spent only where the emphasis is
   doing real steering work.

   ── NOTHING HERE IS ASSEMBLED ANY MORE ───────────────────────────────────────
   Under strict image-only conditioning every builder returns IMAGE_ONLY_PROMPT, so this
   table is a RESTORE LIBRARY, not an assembly source. It is kept whole - and kept next
   to fitPrompt() and the P tiers, which are also intact - because a mode this aggressive
   is a starting point: each clause is a real, reproduced regression, and getting one
   back must be a two-line edit rather than an archaeology exercise. Restore ONE at a
   time and re-test; the premise of the mode is that clause COUNT was drowning the image.

   THREE OF THEM ARE SUPERSEDED rather than merely retired - the frozen string now
   carries their instruction inline, where it cannot be shed or reordered. Restoring
   these would DUPLICATE what is already on the wire, which is the one thing this mode
   is least able to afford:
     · assetLock      its directive is the frozen string's "the EXACT garment FROM the
                      reference image"; its enumerated noun list is deliberately NOT
                      reproduced (see this table's own assetLock comment).
     · bodyFidelity   → "the subject's true body volume and stomach".
     · profileLateral → "from all angles, including 0-degree front and 90-degree side
                      views" - both angles enumerated, neither gated on a pose event.
     · modelAgnostic  → ONLY IMPLIED, by "Preserve only the reference image's graphics,
                      fabric texture, and color". Revision 3 stated the discard outright
                      and revision 4 dropped that wording; the implication is weaker than
                      the statement. This is the one clause on this list whose restore is
                      an IMPROVEMENT rather than a duplication - append DENSE.modelAgnostic
                      the moment "it gave me the model's shoulders" is reported again.

   ── THE RESTORE BUDGET: BOTH BRANCHES NOW HAVE ROOM, AND THAT IS THE TRAP ────
   The number has moved six times, so read the CURRENT row rather than remembering an
   older one. Against PROMPT_MAX_CHARS = 650, one space per part as fitPrompt() joins:

     TOPS FRONT (552 = 403 anchor + 148 closure lock)  BOTTOMS (320 chars - anchor, lower-body scoped)
     + DENSE.bodyFidelity  (45) → 598  fits              → 366  fits
     + DENSE.modelAgnostic (64) → 617  fits              → 385  fits
     + both of them        (110)→ 663  OVER - sheds      → 431  fits

   TOPS FRONT IS THE WORST CASE and the only row worth budgeting against: it is the one
   branch carrying a second part (FRONT_CLOSURE_LOCK, the button-down closure report).
   Tops BACK runs 412 - the back anchor is longer than the front one but carries no
   closure lock, since a front placket is not in view - and bottoms carries one part on
   both angles.

   THE TOPS ANCHOR IS 403, NOT 338, since the lower-body isolation lock (64 chars) was
   written into it - keepTop restored, after the green-trousers report. That is what put
   the both-clauses row over budget on tops, so the last row above is no longer a free
   choice.

   ⚠ AND THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, in the way this file keeps
   re-learning. It said: "NOTHING SHEDS ANY MORE, on either branch. 159 characters are
   free on tops and 330 on bottoms." Both halves were computed from the ANCHOR ALONE, as
   if the anchor were the whole dispatch. It has not been since 2026-09-03, when
   fitSentence() was restored at P.MED - so the figures omitted a live clause worth up to
   213 characters and the "nothing sheds" claim was false on the day it was written.
   `npm run trace:prompt` had the identical bug in its branch table and printed the same
   flattering numbers, which is why the two agreed with each other and not with reality.
   Both are fixed; the tracer now prints a per-branch SIZE LADDER, and it is the source
   of truth for anything below.

   WHAT ACTUALLY SHEDS TODAY (trace:prompt, size ladder, worst rung per branch):
     · tops front, plain tee, sizing DOWN 1-2      → fitSentence sheds
     · tops front, structured + closure, UP 2      → fitSentence sheds
     · tops front, structured + closure, DOWN 1-2  → fitSentence sheds (pre-existing)
     · everything else, every rung                 → nothing sheds
   Free space on the DEFAULT dispatch (delta 0, the shopper who never touches the
   picker): 159 on tops structured, 10 on tops structured+closure, 246 on bottoms front.
   The 10 is the number to budget against, and it is why the colour lock rides at P.LOW.

   So the warning this note carries is now the ORIGINAL one again, not its inverse: a
   restore on the tops+closure branch does not have room, and will silently take the
   size feature with it unless it is priced against the ladder first.

   HEADROOM IS NOT PERMISSION. Tops was collapsed from 634 characters and bottoms from
   616 precisely BECAUSE text volume was outweighing the reference pixels - the tuxedo,
   the generic black shorts and the invented stripe are one mechanism seen three times.
   Two spends have been made since, both against REPRODUCED reports rather than to fill
   space: the lower-body scoping on bottoms (the shirt-replacement report), and the
   per-frame adaptation sentence on both branches (the stretched-garment report). The
   second is why the two anchors are ~170 characters longer than the 1:1 collapse left
   them, and it is also why the branches are now within 22 characters of each other
   rather than 69 apart. Size every further restore the same way: evidence first, then
   the character count.

   IF A RESTORE EVER DOES OVERRUN, the cheapest text to reclaim, in order:
     · CLOSED_BACK_HEM (49) - a P.MED, and now only on the full-look path.
     · VOLUME_PERSISTENCE (171) - P.HIGH on the full-look path; read model-agnostic
       .test.mjs first, it is the record of the body clauses.
     · TEMPORAL_PERSISTENCE (~150 per branch) is already off both single-garment
       branches - see the presence-gate suite before putting it back, not after.
     · The anchors are product-specified wording - change them deliberately or not at all.
   The order to restore in is below.

   THE REST ARE GENUINELY GONE from the wire, and are the ones worth buying back first:
     · inpaintLock    face/skin/hands/background passthrough. THE LARGEST LOSS.
                      Restore: add [P.HIGH, DENSE.inpaintLock].
     · contract, select, ignoreFurniture   the split-reference contract. Restore these
                      TOGETHER with COMPOSITE_DEFAULT, never one without the other.
     · lookPanels     the full-look TOP/BOTTOM layout. The only clause whose absence
                      costs a whole feature. Restore: add [P.CORE, DENSE.lookPanels].
     · pose, poseProfile, frontRef, backReal, backInferred, side
                      orientation steering, now carried by the ASSET the watcher swaps
                      to rather than by a sentence.
     · keepTop         the opposite-layer lock. NOW RESTORED ON TOPS - written INTO
                      CATEGORY_ANCHOR.top and PLAIN_TEE_ANCHOR as "Keep the subject's
                      lower body, shoes, and background unmodified." after the
                      "it repainted my green trousers" report. Inside the anchor because
                      there it cannot shed and costs no extra clause; region-named, never
                      "pants/shorts/trousers", because those would ship as positive
                      tokens (the tuxedo mechanism). See PLAIN_TEE_ANCHOR's comment block
                      for the measured cost - it is paid for by fitSentence shedding on
                      three size rungs.
                      ⚠ CORRECTION, and the reason this bullet is worth re-reading: it
                      used to claim "the bottoms half of it is back on the wire - written
                      INTO CATEGORY_ANCHOR.bottom". THAT WAS FALSE. CATEGORY_ANCHOR.bottom
                      ends at "Strictly preserve original pattern and color."; it has no
                      opposite-layer sentence, KEEP_OPPOSITE_LAYER has no call site, and
                      trace:prompt has always printed the bottoms branch without it.
                      Anyone who restored the tops half by "mirroring that sentence" was
                      copying a clause that did not exist. BOTTOMS IS STILL UNPROTECTED:
                      restoring it there is a separate one-line change on separate
                      evidence (none filed yet, 100+ free chars available on that branch).
     · rotation       "the garment dropped mid-turn". The mechanical half of that fix
                      (the prompt-only flip in applyGarment, and the OrientationWatcher's
                      turn hold) is code, not prompt, and is untouched by this.
     · temporal, quality  the file's own TRIM tier - the model's priors already favour
                      both, which is why they were always the first to shed. */
const DENSE = Object.freeze({
  /* NAMES THE REFERENCE AS A PHOTO OF THE GARMENT, in prose. The previous wording -
     "Try-on. Reference: split image, LEFT = garment front, RIGHT = back." - was
     telegraphic notation, and notation is a weak way to tell a diffusion model that an
     attached image is the thing it must copy. Costs ~65 characters more and buys the
     grounding back. */
  /* The "Virtual try-on." preamble that used to open this was dropped by the image-first
     refactor: garmentAnchor() now leads every prompt and states the task in its first six
     words, so the label was pure duplication sitting between the anchor and the layout
     fact it exists to state. What is left is only the layout fact. */
  contract:      "The reference image is a split photo of one garment: LEFT half its front, RIGHT half its back.",
  /* Split out of the contract so it can shed on its own. It guards a cosmetic artifact -
     a panel divider painted onto the shirt - which must never outrank grounding. */
  ignoreFurniture: "Ignore the gap, the background and any FRONT/BACK label.",
  select: {
    front:       "Use the LEFT half only; ignore the RIGHT.",
    back:        "Use the RIGHT half only; ignore the LEFT.",
  },
  pose: {
    front:       "They face the camera.",
    back:        "They are turned around, back to camera.",
  },
  poseProfile: {
    front:       "They are EDGE-ON in side profile; keep that rotation.",
    back:        "They are EDGE-ON, part-way turned away; keep that rotation.",
  },
  /* THE ANTI-MUTATION NEGATIVE. Compression removed every enumerated "do not" from this
     prompt, and this is the one that had to come back: with a weakly-bound reference and
     nothing forbidding invention, a diffusion model falls to its own prior, which for
     "shirt" is a plain mid-grey tee. Naming the failure is what suppresses it - the same
     mechanism as backInferred's front-print ban. */
  /* THE ANTI-INVENTION NEGATIVE. Widened twice against two separate reports of the same
     mechanism producing different specific outputs - first a blue JACKET, then a full
     TUXEDO with a bowtie and badge - which is the pattern that argues for naming the
     CLASS (formalwear/outerwear/accessories) rather than chasing individual garment
     words one report at a time; the next drift is not guaranteed to invent a jacket
     either. The underlying failure is unchanged from the first widening: the model kept
     a garment-shaped region and rendered something else into it - a layer, a type and
     now an ACCESSORY change, none of which the previous wording forbade.

     Naming the specific wrong output is deliberate and is the mechanism this file relies
     on everywhere (the same reason backInferred names the front print it must not copy),
     but the list cannot grow without bound inside a 226-token prompt - so it is pitched
     at garment CLASSES wide enough to cover what has actually been observed (jacket/coat/
     suit/tuxedo covers "outerwear or formalwear invented instead of a tee"; tie/bowtie/
     badge covers "accessories invented that were never in the reference") rather than an
     ever-growing enumeration of exact nouns. What is still NOT named is any particular
     garment's print text - that belongs to one product, and hardcoding it would state a
     falsehood about every other catalog item. The substitution sentence already binds the
     print generically ("every graphic, logo and lettering on it"). */
  /* RETIRED FROM ASSEMBLY - folded into garmentAnchor(). Kept verbatim because the
     comment above is the record of two live reports, and because it is the enumeration
     the anchor deliberately does NOT reproduce: with no negative_prompt field on
     Decart's set(), every noun here ships inside the POSITIVE prompt, where "tuxedo"
     is a token the sampler can steer toward rather than away from. See the anchor's
     own reservation note. */
  assetLock:     "Never invent a garment, jacket, coat, suit, tuxedo, tie, bowtie or badge, or change the garment type, and never leave their own top showing.",
  /* Depth and lateral wrap MERGED. Separately they cost ~155 characters and the budget
     could only afford one, so a 90-degree frame got the BODY clause and no GARMENT clause -
     leaving the side of the garment unreferenced, which is exactly where the model
     substitutes its own prior. One instruction about one region, ~175 chars. */
  profileLateral: "EDGE-ON: keep their full front-to-back depth; build the side by continuing its front and back panels.",
  bodyFidelity:  "Keep their real body volume; never slim them.",
  modelAgnostic: "Ignore the reference model's body; fit the cloth to THIS person.",
  keepBottoms:   "Bottoms unchanged.",
  keepTop:       "Top unchanged.",
  /* CONSIDERED AND REJECTED: adding "arms" here, after the tuxedo/blazer report - a
     blazer's sleeve is structurally different from a t-shirt's, so naming the arm/sleeve
     region alongside face/hands looked like a targeted fix. It is wrong for this shared
     table: PEAR_CATALOG ships long-sleeve items (Strata, Nimbus, Echo), and for those a
     correct render DOES cover the arm in sleeve fabric - "arms pass through untouched"
     would contradict the substitution itself on every one of them, the exact class of
     internal prompt contradiction this session has spent several commits removing, not
     one to reintroduce. The noun already carries this signal correctly ("t-shirt" implies
     short sleeves, "tank top" sleeveless, "long-sleeve shirt" full coverage) without a
     separate, subType-blind passthrough clause fighting it. */
  inpaintLock:   "Face, skin, hands and background pass through untouched.",
  rotation:      "The garment stays on through any turn.",
  temporal:      "Stable print, no flicker.",
  quality:       "Photoreal fabric, natural light.",

  /* Single-asset (non-composite) counterparts. The reference is ONE photo, so these say
     which side of the garment it shows instead of which half of a split image. */
  frontRef:      "The reference photo shows the garment's front; reproduce it, not the back.",
  backReal:      "The reference photo shows the garment's BACK: reproduce its back print at the same size and position; do not render the front.",
  /* The one enumerated negative the budget still pays for. With only a front photo the
     model's likeliest completion for a back is the front print repeated - the documented
     double-print bug - and nothing else in this compressed prompt forbids it. */
  backInferred:  "No back photo exists: infer a plain back in the same fabric and colour. Never copy the front print, logo or buttons onto it.",
  side:          "Show the garment's side: shoulder line, sleeve and side seam, draping along the flank.",
  /* Full-look stitched reference: two garments stacked in one image. Same job the
     composite contract does for front|back, for the top|bottom axis instead. */
  lookPanels:    "The reference stacks two garments: the TOP panel is the upper-body garment, the BOTTOM panel the lower. Render both at once; never mix them or draw the panel frames.",
});

/**
 * Assemble a prompt from priority-tagged parts, guaranteeing it fits PROMPT_MAX_CHARS.
 *
 * THE GUARANTEE IS THE POINT. Writing short clauses is necessary but not sufficient:
 * the garment description is interpolated from catalog data (or a shopper's own upload),
 * so its length is not known at authoring time and a long one could push a
 * hand-tuned-to-fit prompt back over the ceiling - reintroducing exactly the crash this
 * exists to prevent, for one unlucky product. Clauses are therefore SHED, worst-priority
 * first, until the result fits.
 *
 * The final clamp is a hard slice. It only triggers if CORE alone exceeds the budget
 * (a pathologically long garment name), and it is deliberate: a clipped prompt still
 * produces a garment, while a rejected one produces a failed session.
 *
 * @param {Array<[number, string]>} parts  [priority, text]; empty text is skipped.
 * @param {number} [max]  budget override, for tests.
 * @returns {string}
 */
/* getFitModifier() returns a bare noun phrase ("regular fit", "slightly oversized fit")
   because every previous caller embedded it mid-sentence as "Render a ${fitMod}". The
   dense builders join their parts as standalone sentences, where a bare phrase reads as
   a fragment - so it gets its own sentence here rather than being reworded at three
   separate call sites. */
function fitSentence(garmentType) {
  const mod = getFitModifier(getSizeDelta(), garmentType);
  return mod ? `Fit: ${String(mod).trim()}.` : "";
}

/* ── THE COLOUR LOCK - "the white tee rendered black" / "it came back yellow" ──────
   ────────────────────────────────────────────────────────────────────────────────
   THE BUG THIS CLOSES. The anchors end with "Strictly preserve the original <noun>
   texture, pattern, and color" - a clause that tells the model to preserve a colour
   without ever NAMING one. That is a pointer, not a value: it only works while the
   model is actually reading the colour off the reference, which is precisely what
   fails in the reported case. A garment whose colour drifts has nothing in the prompt
   contradicting the drift.

   This names the measured value. The hex is sampled from the FRONT product photo's own
   main fabric by the same Gemini call that classifies front/back (server.js
   primary_color_hex -> widget garment_color_hex -> activeItem.colorHex), so it is
   per-product data threaded through the payload, NOT text baked into a global anchor -
   the distinction that keeps one product's colour out of every other product's prompt.

   A NAME, NOT THE HEX, and this is the whole reason the mapping below exists. Decart's
   set() takes a natural-language prompt into a text encoder; "#f8f8f5" is three bytes of
   hex trivia to a tokenizer, while "white" is a word it has strong priors for. Shipping
   the raw hex would spend characters to say almost nothing.

   IT ABSTAINS RATHER THAN GUESSES - §6, and it matters more here than usual. A WRONG
   colour name is strictly worse than no colour name: the anchor's generic "preserve the
   original color" at least defers to the pixels, whereas "The garment is yellow" states
   a value with full authority and will actively repaint a cream garment. So:
     · an unparseable / absent hex -> "" (nothing ships; today's behaviour exactly).
     · a hex that is not confidently near any named colour -> "" as well. This is the
       important one: a muddy mid-tone is what a MULTICOLOUR OR PATTERNED garment's
       "dominant colour" averages out to, and naming that average would flatten the
       pattern the anchor is simultaneously trying to preserve.

   P.LOW, WHICH IS LOWER THAN THE FIT SENTENCE, AND THAT IS DELIBERATE.
   fitPrompt() sheds the highest priority NUMBER first, so at P.LOW (3) this is the
   FIRST thing off the wire under pressure - before fitSentence (P.MED, 2), before
   FRONT_CLOSURE_LOCK (P.HIGH, 1), before the anchor (P.CORE, 0). That ordering is the
   condition on which this clause was allowed to exist at all: the tops branches have
   7-10 free characters at their tightest rungs after the lower-body isolation lock, so
   anything at P.MED or above would have displaced an already-shipping feature. At P.LOW
   it is purely additive - it ships where there is room and silently stands down where
   there is not. Check `npm run trace:prompt`'s size ladder before promoting it.

   NOT the OCR text. text_ocr is threaded as far as the server response and deliberately
   stops there: a partial or mis-read transcription ("BE YOUR OWN Healer" for "BE YOUR
   OWN Healer WORLDWIDE") would be asserted to Decart as the garment's lettering and
   render wrong text confidently, which is worse than the anchor's generic "preserve the
   pattern". Its job is the duplicate-panel veto (server.js validateBackCandidate), where
   a wrong value costs a rejected back rather than a wrong render. */
/* ⚠ NOT the same table as COLOR_NAMES further down this file, and the duplication is
   deliberate rather than an oversight. That one backs colorName() and is a HUMAN-FACING
   label palette ("royal blue", "off-white", "light grey", "tan") which falls back to
   "neutral" and therefore always answers. This one backs a PROMPT clause and must be
   able to answer NOTHING - see the three gates below. Reusing the label palette here
   would import its no-abstention contract, which is the one property this clause cannot
   have; naming these FABRIC_* keeps the two from colliding at module scope, which they
   originally did (a duplicate `const COLOR_NAMES` is a load-time SyntaxError that the
   sandbox-extracting test suites cannot see, because they slice fragments rather than
   loading the file). */
const FABRIC_COLOR_NAMES = Object.freeze([
  ["white",  0xff, 0xff, 0xff], ["black",  0x14, 0x14, 0x14],
  ["grey",   0x80, 0x80, 0x80], ["silver", 0xc0, 0xc0, 0xc0],
  ["charcoal", 0x36, 0x36, 0x3a],
  ["red",    0xd0, 0x21, 0x21], ["burgundy", 0x6d, 0x10, 0x28],
  ["orange", 0xe8, 0x7d, 0x1e], ["yellow", 0xf2, 0xd0, 0x2c],
  ["green",  0x2e, 0x8b, 0x3f], ["olive",  0x6b, 0x6b, 0x2a],
  ["blue",   0x2a, 0x5c, 0xc8], ["navy",   0x1b, 0x25, 0x50],
  ["teal",   0x1d, 0x8a, 0x8a],
  ["purple", 0x6f, 0x36, 0xa5], ["pink",   0xe8, 0x8f, 0xb0],
  ["brown",  0x7a, 0x4b, 0x28], ["beige",  0xd8, 0xc4, 0xa0],
  ["cream",  0xf3, 0xea, 0xd6],
]);

/* ── THREE GATES, AND EACH ONE CLOSES A DIFFERENT WAY OF BEING WRONG ──────────────
   A single nearest-neighbour lookup with one distance threshold was the first version of
   this, and measurement killed it: with a palette dense enough to name ordinary garment
   colours, almost every input lands within any threshold loose enough to be useful. The
   gates below were each added against a specific mis-naming found by computing the actual
   distances, not by intuition.

   (1) ABSOLUTE DISTANCE - the backstop. A colour far from every name gets none.

   (2) MARGIN over the runner-up - the "which of these two is it" case. #7a6a55 sits at
       olive=46, grey=49, brown=55: three names inside 9 units, so the nearest is not a
       verdict, it is a coin toss. Gated at 12.

   (3) NEUTRAL CONSISTENCY - THE IMPORTANT ONE, and the one a distance metric cannot
       express. RGB Euclidean distance collapses every DESATURATED colour onto the grey
       axis, and grey then wins by a LARGE margin, so gates (1) and (2) both wave it
       through. Measured examples: a sage green #6b8f7a reads grey=26 (margin 53), and a
       dusty mauve #9b7fa8 reads grey=48 (margin 30). Both would have shipped "The garment
       fabric is grey" for a garment that is plainly not grey - actively repainting it,
       which is the exact failure this clause exists to prevent, caused by the clause
       itself. So the colour's own chroma must AGREE with the matched name's: a chromatic
       colour may not take a neutral name, and a neutral one may not take a chromatic name.
       Where they disagree, abstain.

   Net effect on the taupe case #8a7f6d (grey=21, margin 55, chroma 29): abstains, because
   a warm taupe is not grey even though RGB says it nearly is. That is the correct answer
   and it is only reachable through gate (3). */
const FABRIC_COLOR_MAX_DIST = 96;
const FABRIC_COLOR_MIN_MARGIN = 12;
/* max(r,g,b) - min(r,g,b). 25/255 (~10%) is the neutral band: #f8f8f5 (chroma 3) is an
   off-white and takes "white"; #8a7f6d (chroma 29) is a taupe and takes nothing. */
const FABRIC_NEUTRAL_CHROMA_MAX = 25;
const FABRIC_NEUTRAL_NAMES = new Set(["white", "black", "grey", "silver", "charcoal", "beige", "cream"]);

function colorNameFromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;

  const ranked = FABRIC_COLOR_NAMES
    .map(([name, nr, ng, nb]) => [name, Math.sqrt((r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2)])
    .sort((a, z) => a[1] - z[1]);
  const [best, bestD] = ranked[0];
  const runnerUpD = ranked[1] ? ranked[1][1] : Infinity;

  if (bestD > FABRIC_COLOR_MAX_DIST) return "";                          // (1)
  if (runnerUpD - bestD < FABRIC_COLOR_MIN_MARGIN) return "";            // (2)
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);                  // (3)
  if ((chroma <= FABRIC_NEUTRAL_CHROMA_MAX) !== FABRIC_NEUTRAL_NAMES.has(best)) return "";
  return best;
}

/* ── THE GARMENT IDENTITY LOCK - "Decart rendered a random t-shirt" ────────────────
   ────────────────────────────────────────────────────────────────────────────────
   Promoted from a P.LOW colour hint to a P.CORE identity lock, and widened to carry the
   garment's transcribed lettering alongside its colour. Both values are MEASURED by the
   same Gemini call that classifies front/back (server primary_color_hex / front_text_ocr
   -> widget -> item.colorHex / item.textOcr), so this is per-product data threaded
   through the payload and never text baked into an anchor.

   WHY IT IS VALUES-ONLY, and not the 290-character "FIT LOCK" paragraph it was specified
   as. The anchors already open with "Drape and fit the EXACT static <noun> from the
   reference image" and close with "Strictly preserve the original <noun> texture,
   pattern, and color". A lock that restates "fit the exact garment shown in the
   reference, do not invent or substitute the design" spends ~230 characters repeating
   instructions ALREADY ON THE WIRE, and text volume competing with the reference image is
   the one mechanism every report in this file's history shares - it is how the tuxedo got
   rendered. What the prompt genuinely could not say before is WHICH colour and WHICH
   text, because those are per-product measurements. So this clause supplies exactly the
   two values and nothing else; the imperative half is the anchor's job and already done.

   ── THE BUDGET, WHICH IS THE HARD CONSTRAINT HERE ──
   P.CORE cannot shed. Anything put here is spent on every dispatch, and if the CORE total
   exceeds PROMPT_MAX_CHARS then fitPrompt() falls through to clampPromptForWire()'s hard
   slice, which cuts at the END - mid-word, taking this clause's own quoted text with it
   and asserting a garment print that reads half a slogan. So:

     · The tightest REAL branch is tops + front + closure: 552 chars of anchor + closure
       lock, 98 free. IDENTITY_LOCK_MAX_CHARS is therefore 96, and this function can never
       return more than that - measured, not assumed (npm run trace:prompt prints it).
     · The print half is included ONLY IF THE WHOLE TRANSCRIPTION FITS. It is never
       truncated. Half a slogan asserted as the garment's text is worse than no text at
       all - it is a confident wrong answer, the same failure mode colorNameFromHex()'s
       three gates exist to avoid.
     · IT COSTS THE FIT SENTENCE ON ONE BRANCH, and that is a deliberate, specified
       trade: on tops + front + closure only 9 characters remain after fit(0)'s 88, so ANY
       lock bigger than 9 chars evicts fitSentence (P.MED) there. The spec is explicit
       that visual identity outranks tension under pressure, and a garment rendered as the
       wrong garment is plainly worse than one rendered at the wrong tension. Every other
       branch keeps both. See trace:prompt's size ladder for the per-rung truth.

   ── FRONT-ONLY FOR THE PRINT HALF, and this is the correctness point, not a nicety ──
   text_ocr is transcribed from the FRONT photograph. Asserting "the print reads X" while
   the BACK asset is the reference tells the model to put the chest graphic on the
   shopper's spine - which IS the print-less-back / double-print bug (23f5953), reached
   through the prompt instead of through the reference image. The colour half is safe on
   both angles because a garment is one colour from every side. So the angle SELECTS which
   halves apply, in the same spirit as the frozen anchor pair. */
const IDENTITY_LOCK_MAX_CHARS = 96;
/* A transcription longer than this is not a chest graphic - it is a care label, a size
   chart or a paragraph of marketing copy that happened to be in frame. Naming it as the
   garment's print would be wrong even if it fit the budget. */
const PRINT_TEXT_MAX_CHARS = 48;

/* The garment's lettering, or "" to abstain. Abstains on absent (never transcribed),
   empty (genuinely plain - nothing to assert), and over-long (see above). Quotes are
   stripped because the value is about to be wrapped in them, and a nested quote would
   read to the model as the end of the print text. */
function garmentPrintText(item) {
  const raw = item && item.textOcr;
  if (typeof raw !== "string") return "";
  const text = raw.replace(/["""'']/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > PRINT_TEXT_MAX_CHARS) return "";
  return text;
}

/* ── THE REAR VERDICT, IN WORDS - the one way a BACK prompt stops asserting a print ──────
   REPORTED 2026-09-16: "during the turn to the back the mountain print rendered for a split
   second and then vanished, degrading into a plain brown shirt", filed as the prompt builder
   dropping a graphic descriptor mid-turn. It cannot do that: `angle` SELECTS one frozen anchor
   and nothing is ever assembled or stripped per frame (see imageOnlyPrompt's frozen-axis note),
   and the back anchor is 521/650 chars with every size rung fitting, so it cannot shed either.

   THERE IS EXACTLY ONE MECHANISM that changes what a BACK dispatch asserts about the rear, and
   it is this verdict: `item.backIsPlain === true` selects PLAIN_BACK_ANCHOR, which says "The
   rear panel is smooth unbroken fabric" in place of "Reproduce the rear panel exactly as shown
   in the reference". On a garment whose rear IS blank that is the fix for invented graphics
   (see PLAIN_BACK_ANCHOR). On a garment with a real rear print it would suppress the one
   graphic the shopper turned around to see - which is exactly the reported shape.

   IT ARRIVES SILENTLY AND CAN ARRIVE MID-SESSION. The widget opens the room on a DOM-order
   guess and posts PEAR_UPDATE_GARMENT when the classifier resolves, seconds later, which is
   after go-live. Until now the verdict was never logged anywhere: not when it landed, not when
   it changed what the wire says. So the next report of this shape can be answered from one
   console line instead of inferred from pixels. Pure diagnostics - nothing here selects
   anything. */
function describeRearConstruction(item) {
  if (!item) return "no item";
  if (item.backIsPlain === true) {
    return 'PLAIN asserted (backIsPlain=true → "the rear panel is smooth unbroken fabric") -' +
      " if this garment HAS a rear print, this is what suppresses it";
  }
  if (item.backIsPlain === false) return 'rear print asserted (backIsPlain=false → "reproduce the rear panel exactly as shown")';
  return 'rear print asserted (backIsPlain not established → "reproduce the rear panel exactly as shown")';
}

function identityLockSentence(item, angle = "front") {
  /* THE WRAPPERS ARE TERSE BECAUSE EVERY CHARACTER HERE IS SPENT AT P.CORE, on every
     dispatch, and is taken straight out of fitSentence's headroom. "Fabric: white."
     rather than "The fabric color is white." costs 14 instead of 27 and says the same
     thing to a text encoder; the 18 characters that buys back are two whole size rungs
     on the plain-tee branch (measured - see the trace ladder). "Fabric:" and not
     "Color:" is deliberate: an unqualified colour label could be read as the
     background's, which the anchor is simultaneously telling the model to preserve. */
  const parts = [];
  const name = colorNameFromHex(item && item.colorHex);
  if (name) parts.push(`Fabric: ${name}.`);
  if (angle !== "back") {
    const text = garmentPrintText(item);
    if (text) parts.push(`Print: "${text}".`);
  }
  const out = parts.join(" ");
  /* THE CEILING IS ENFORCED, not documented and hoped for. Dropping the whole clause is
     the correct overflow behaviour: every part of it is an assertion about the garment,
     and a partial assertion is a wrong one. Logged because a clause silently vanishing is
     exactly the class of bug this file keeps a tracer for. */
  if (out.length > IDENTITY_LOCK_MAX_CHARS) {
    console.warn(`[PEAR] identityLockSentence() - ${out.length} chars exceeds the ` +
      `${IDENTITY_LOCK_MAX_CHARS} budget; dropping it rather than shipping a truncated ` +
      `garment assertion. Colour+print for this item cannot both be named.`);
    return name && `Fabric: ${name}.`.length <= IDENTITY_LOCK_MAX_CHARS
      ? `Fabric: ${name}.`   // keep the half that still fits, angle-safe
      : "";
  }
  return out;
}

/* ── THE WIRE GUARD - last line of defence, and the one that generalises ──────
   fitPrompt() budgets the prompts this file BUILDS. That is not the same guarantee as
   "nothing over-long reaches Decart": a future builder, a hot-fix that concatenates one
   more clause onto a returned string, or any path that skips the builders entirely would
   sail straight past it and fail the session with the same opaque Hebrew banner.

   This clamps at the wire instead, so the guarantee holds no matter who produced the
   string. It should never fire - every builder already fits - so firing is itself the
   signal, and it logs loudly with the offending prefix rather than silently truncating.
   Truncation is the correct failure mode here: a clipped prompt still dresses the
   shopper, while a rejected one ends the session before the first frame. */
function clampPromptForWire(prompt, where) {
  const s = String(prompt ?? "");
  if (s.length <= PROMPT_MAX_CHARS) return s;
  console.error(
    `[PEAR] ${where}: prompt is ${s.length} chars, over the ${PROMPT_MAX_CHARS} budget ` +
    `(the engine hard-rejects >226 tokens). Truncating to keep the session alive - a builder ` +
    `is bypassing fitPrompt(). Prefix: ${s.slice(0, 120)}…`
  );
  return s.slice(0, PROMPT_MAX_CHARS).trim();
}

function fitPrompt(parts, max = PROMPT_MAX_CHARS) {
  let keep = parts.filter(([, text]) => text && String(text).trim());
  const render = (list) => list.map(([, t]) => String(t).trim()).join(" ").replace(/\s+/g, " ").trim();

  let out = render(keep);
  while (out.length > max) {
    const worst = Math.max(...keep.map(([p]) => p));
    if (worst === P.CORE) break;                       // nothing droppable left
    keep.splice(keep.findIndex(([p]) => p === worst), 1);
    out = render(keep);
  }
  if (out.length > max) {
    console.warn(`[PEAR] fitPrompt() - CORE alone is ${out.length} chars (budget ${max}); clamping.`);
    out = out.slice(0, max).trim();
  }
  return out;
}

/**
 * The prompt for a composite reference. Returns IMAGE_ONLY_PROMPT.
 *
 * ORDER USED TO BE THE POINT, and it moved twice before it stopped mattering. The
 * original shape was `buildPrompt(item) + angleClause(item)`: 1,403 characters of colour /
 * anatomy / fit / quality / hem / hard-negative boilerplate AHEAD of the panel contract,
 * pushing the single most important instruction in composite mode past the halfway mark of
 * a 2,636 character prompt. Lucy regenerates every frame from that prompt and the leading
 * tokens dominate, so that boilerplate was not merely wasteful - it was outranking the
 * contract. Fix one: put the panel contract first. Fix two (the tuxedo report): put the
 * image anchor first, because "which half of the reference to read" only matters once the
 * model is reading the reference at all.
 *
 * FIX THREE - the tuxedo survived both - IS THAT THERE IS NOTHING TO ORDER. Every clause
 * is a token competing with the pixels, and ordering them only chooses which competitor
 * goes first. See IMAGE_ONLY_PROMPT for the mechanism and the full list of what this gave
 * up. The composite path itself is standing down with it (COMPOSITE_DEFAULT = false): a
 * split FRONT|BACK reference is only legible alongside the panel contract that explains
 * it, and that contract is exactly the text this mode removes.
 *
 * THE PARAMETERS ARE RETAINED AND DELIBERATELY UNUSED. They are the seam: applyGarment()
 * still freezes `angleAtStart`/`profileAtStart` before its awaits and still threads them
 * here, so the TOCTOU plumbing that keeps the reference and the prompt describing the same
 * moment stays live and stays tested (angle-race, side-profile §6). Restoring any clause
 * is then a two-line edit here, not a re-derivation of that plumbing.
 *
 * @param {object} item   the active garment (catalog or custom upload)
 * @param {"front"|"back"} angle  retained; see above
 * @param {boolean} inProfile     retained; see above
 * @returns {string}
 */
function buildCompositePrompt(item, angle, inProfile) {   // eslint-disable-line no-unused-vars
  return imageOnlyPrompt(item, angle);
}

/* Full-Look composite clause, for stitchLookBlob() (TOP/BOTTOM, unrelated to front/back
   orientation). The reference image is TWO stacked, isolated garment photos
   (TOP over BOTTOM) rather than one image + a text-only description of the second
   garment, so the model has an actual pixel reference for BOTH the shirt and the
   pants and can render them together instead of favoring only the visually-referenced
   one. */
const LOOK_CLAUSE =
  " This image is two completely separate garment photographs stacked vertically, each isolated inside its own black-framed panel and divided by a WIDE solid-black separator band that is a strict no-man's-land." +
  " The two panels are distinct, mutually exclusive garment views. The panel marked 'TOP' is the ONLY valid source for the upper-body garment. The panel marked 'BOTTOM' is the ONLY valid source for the lower-body garment. Treat the black band and black frames as an impassable wall: you are strictly forbidden from sampling, blending, copying or bleeding ANY pixel from one panel into the other." +
  " Reproduce EACH panel's garment with 100% fidelity to its color, fabric and graphics - rendering the 'TOP' panel's garment on the person's upper body AND the 'BOTTOM' panel's garment on the person's lower body AT THE SAME TIME, in a single photorealistic pass. Neither garment replaces the other; both must be visible simultaneously." +
  " The 'TOP' and 'BOTTOM' text markers and the black frames/band are architectural guides only - never render that text, the frames or the band onto the clothing or the person.";

/* Custom upload, BACK angle, NO back photo supplied → a stronger inferred-rear than the
   generic backInferred. Product-approved wording: a clean, plain rear (front graphics
   stripped) that keeps the front's fabric/colour/seams/drape. The "negative prompt" is
   folded IN as an inline clause because Decart's realtime set() accepts only
   { prompt, image, enhance } - there is NO separate negative_prompt field to pass. */
const CUSTOM_BACK_INFERRED = REAR_POSE + BACK_TAIL.custom;

/* `inProfile` is the OrientationWatcher's edge-on reading, and it is a frozen snapshot for
   exactly the same reason `angleOverride` is: the watcher samples on its own 250ms
   interval and can change it during applyGarment()'s await, which would let the pose
   sentence and the already-resolved reference describe different moments. applyGarment()
   snapshots it beside angleAtStart and threads it through.

   It is deliberately a SEPARATE axis from `angleOverride`, not a third value of it. The
   angle decides WHICH GARMENT ASSET/panel is the source and is a hysteresis-protected
   lock; profile decides only WHAT POSE THE PROMPT ASSERTS about the body. Collapsing them
   would mean a side-on frame could change the reference image, which is precisely the
   flapping the lock exists to prevent - a profile frame is not evidence the shopper's
   other side is now showing. Keeping them independent is what lets this fix the pose
   without touching any asset-selection behaviour. */
function angleClause(item, angleOverride, useComposite, inProfile) {
  /* Edge-on: append BOTH profile clauses on every branch below - the body's depth axis,
     then the garment's lateral wrap over it. Both are orientation-independent (they
     describe the frame, not which panel was locked), so they ride on front, back and side
     alike. Order is deliberate and matches buildCompositePrompt(): what the body IS, then
     how the garment covers it - the second only means anything given the first. */
  /* One merged edge-on directive now, not two. Referencing the retired profileDepth /
     lateralWrap here would interpolate the string "undefined" straight into a live
     prompt - silent, and exactly the kind of thing the model would try to render. */
  const depth = inProfile ? " " + DENSE.profileLateral : "";

  // Composite mode: the reference carries BOTH views, so the clause names the panel
  // matching the detected orientation and excludes the other outright. Only the pose
  // sentence varies with profile; the panel contract and selection are unchanged.
  if (useComposite === undefined ? compositeActiveFor(item) : useComposite) {
    const a = (angleOverride || effectiveAngle()) === "back" ? "back" : "front";
    const pose = inProfile ? DENSE.poseProfile[a] : DENSE.pose[a];
    // depth rides DIRECTLY behind the pose, not at the tail - see buildCompositePrompt()'s
    // placement comment for why position is load-bearing for this model.
    return " " + DENSE.contract + " " + pose + " " + DENSE.select[a] + depth;
  }
  const angle = angleOverride || effectiveAngle();      // AI Auto resolves to the DETECTED orientation
  if (angle === "back") {
    // Which POSE leads the clause depends on whether they are square-on or mid-turn; which
    // GARMENT TAIL follows it depends on what reference we actually hold. Independent
    // choices, so they are resolved independently rather than as four hand-written strings.
    const pose = " " + (inProfile ? DENSE.poseProfile.back : DENSE.pose.back);
    // Dual asset (front + a REAL back photo, incl. a user's uploaded back) → reproduce it.
    // AI Auto always lands here with a real back (canCombineViews gates the mode on one).
    if (activeBackIsReal(item)) return pose + depth + " " + DENSE.backReal;
    // Only a front reference → the rear must be INFERRED, and the front print must not be
    // copied onto it. That negative is the one enumerated ban the budget still pays for:
    // it is the difference between a plain back and the chest logo printed twice.
    return pose + depth + " " + DENSE.backInferred;
  }
  // AI Auto: pin the reference explicitly as the garment FRONT - the mode's whole contract
  // is one unambiguous side - but state the shopper's real rotation, not an assumed facing.
  if (currentAngle === AUTO_ANGLE) {
    return " " + (inProfile ? DENSE.poseProfile.front : DENSE.pose.front) + " " + DENSE.frontRef + depth;
  }
  /* Single-view items (see profileActive()'s comment - the watcher now runs for these
     too): `angle` here is a GALLERY tab choice (which product photo to reference), not a
     claim about how the shopper is physically standing, and ANGLE_CLAUSE.front is "" - it
     never needed its own pose sentence because there used to be no live pose signal for
     this mode at all. `inProfile` is that signal now. When it's true, reach for
     DENSE.side - the garment-specific side-seam/flank wording - instead of whatever the
     selected tab's (possibly empty) clause says, same as AUTO_ANGLE substituting the
     profile pose for the square-on one above. */
  if (inProfile) return " " + DENSE.side + depth;
  return angle === "back" ? " " + DENSE.pose.back : "";
}

/**
 * Reads the Screen 1 physical inputs and returns a forceful anatomical anchor
 * sentence. This pins the AI's body model to real measurements so it cannot
 * hallucinate a generic body shape.
 * @returns {string}
 */
function getAnatomicalAnchor() {
  const num = (id) => { const el = $(id); return el && el.value ? parseFloat(el.value) : null; };
  const height = num("height"), weight = num("weight");
  const chest  = num("chest"),  waist  = num("waist"),  legs = num("legs");

  if (!height && !weight) {
    return "Fit the garment to a realistic human body with accurate anatomical proportions and photorealistic fabric physics.";
  }

  let sentence = "The person has ";
  if (height && weight) sentence += `an exact height of ${height}cm and weighs ${weight}kg`;
  else if (height)      sentence += `an exact height of ${height}cm`;
  else                  sentence += `a weight of ${weight}kg`;
  sentence += ".";

  const details = [];
  if (chest) details.push(`chest ${chest}cm`);
  if (waist) details.push(`waist ${waist}cm`);
  if (legs)  details.push(`inseam ${legs}cm`);
  if (details.length) sentence += ` Exact body measurements: ${details.join(", ")}.`;

  sentence += " Fit the garment strictly to these specific anatomical proportions - zero generic guessing, maximum physical fidelity.";
  return sentence;
}

/* ── Why the size-down wording is phrased the way it is ──────────────────────────
   These strings used to describe a SILHOUETTE - "sleek athletic compression fit,
   form-fitting tailored silhouette", "high-compression slim silhouette". A silhouette
   is the outline of the BODY, so on a shopper who sized down, the earliest and most
   concrete instruction in the prompt was read as "make this person's outline slim",
   and STRICT_INPAINT's "do not flatten, slim or reshape their physique" arrived ~1,200
   characters later to contradict it. Leading tokens dominate a realtime diffusion
   prompt (see buildCompositePrompt), so the contradiction resolved the wrong way -
   which is the "it compressed me into a thinner frame" report.
   Every clause below now attributes tightness to the GARMENT and to what the FABRIC
   does over a body whose dimensions are fixed: a smaller size stretches, pulls and
   tensions across the shopper's real contours rather than shrinking them. Same fit
   information, no instruction the body-fidelity clause has to fight. */
function getFitModifier(delta, garmentType) {
  if (garmentType === "upper_body") {
    if (delta <= -2) return "deliberately undersized garment stretched taut over the body's unchanged contours, fabric under visible tension with stretch lines radiating from the shoulders and chest, hem riding at the natural waistline";
    if (delta === -1) return "snug garment cut close to the body, fabric pulled smooth and slightly tensioned across the torso, following the shopper's real contours without compressing them";
    if (delta === 0)  return "perfectly tailored true-to-size fit, flawless natural drape with no excess fabric";
    if (delta === 1)  return "relaxed fit, slightly loose drape, comfortable room across the shoulders and chest";
    /* delta >= 2 */  return "oversized fashion-forward fit, generously dropped shoulders, easy relaxed volume through the torso, elongated hem with natural gravity drape";
  }
  /* lower_body */
  if (delta <= -2) return "deliberately undersized trousers stretched taut over the legs and hips as they actually are, fabric under visible tension at the thigh and seat with stretch lines at the waistband, full-length inseam with a tight ankle cuff";
  if (delta === -1) return "snug trousers cut close through the thigh and knee, fabric pulled smooth and slightly tensioned over the shopper's real leg shape, tapering to a narrow ankle opening";
  if (delta === 0)  return "perfectly tailored true-to-size fit, clean break at the ankle with no pooling";
  if (delta === 1)  return "relaxed wide fit, comfortable room through the thighs, natural break at the ankle";
  /* delta >= 2 */  return "wide-leg garment with generous volume through the thigh and a sweeping leg that breaks softly over the shoe, clean continuous fabric geometry";
}

/* ── Fabric-Aware Tension & Physics Conditioning ──────────────────────────────
   getFitModifier() above describes FIT - how loose or tight the cut is. This
   describes MATERIAL - how that specific fabric physically behaves once fit is
   accounted for: a dry-fit tee clings and shows compression lines under tension,
   raw denim holds a stiff, angular shape almost independent of the body inside
   it. The two compose (fit + material), they never overlap or contradict.
   Keyed by item.fabric - catalog metadata (PEAR_CATALOG), a custom upload's
   declared material, or a store handoff's fabric field - so the clause tracks
   whatever garment/colour is ACTIVE rather than being fixed per garment type. */
const FABRIC_PHYSICS = {
  dry_fit:  "a synthetic athletic dry-fit stretch material: sleek, body-conforming tension with the fabric hugging the body's real contours, subtle athletic stretch lines radiating across the chest, shoulders and back where the material tensions over muscle and bone, and a smooth skin-tight elasticity - without artificially slimming, compressing or reshaping the body underneath",
  cotton:   "medium-weight woven cotton: a natural, semi-structured drape with soft, rounded fold lines, moderate stiffness that holds its shape at the seams while relaxing over the body's contours, and a matte, breathable weave texture",
  denim:    "rigid, heavyweight denim: a structured, semi-stiff drape that holds its own shape largely independent of the body, thick angular fold lines at the hips, knees and elbows, visible top-stitching, and rigid shape retention over the body's mass - the fabric resists the body rather than clinging to it",
  silk:     "lightweight, fluid silk: a soft, liquid drape that skims the body with minimal resistance, fine cascading folds rather than sharp creases, and a subtle natural sheen that shifts with the fabric's movement",
  knitwear: "a soft knit weave: visible ribbed knit texture lines, a close, slightly elastic cling that follows the body's contours with gentle stretch recovery, and soft rolled edges at the hem, cuffs and collar rather than crisp woven seams",
};
const DEFAULT_FABRIC = "cotton";   // legacy/custom items with no declared fabric read as this, never with no physics clause at all

/**
 * Fabric-physics clause for one garment. `subject` lets a two-garment prompt
 * (buildLookPrompt) name which layer the clause is about; single-garment
 * builders leave it at the generic default.
 * @param {object} item - reads item.fabric; anything unset/unrecognized falls back to DEFAULT_FABRIC
 * @param {string} [subject]
 * @returns {string}
 */
function getFabricModifier(item, subject = "This garment's fabric") {
  const key = item && Object.prototype.hasOwnProperty.call(FABRIC_PHYSICS, item.fabric) ? item.fabric : DEFAULT_FABRIC;
  return ` ${subject} is ${FABRIC_PHYSICS[key]}.`;
}

/* Appended to every VTON prompt to lock the engine into photorealistic output.
   Kept as a module constant so changing it in one place affects all call sites. */
const QUALITY_SUFFIX = ", photorealistic real-world fabric texture, visible seams and stitching, micro-detailed weave, natural environmental lighting matching the user's room, cinematic shading, ultra-realistic physical garment appearance, strictly maintain flawless fabric integrity, continuous realistic 3D mesh, and natural material physics without any glitching, strange horizontal bands, tearing, or unnatural structural folds";

/* Bias the model toward keeping graphics/logos/text and the bottom-hem edge details in
   their original scale, proportion and relative position, and to render the full hem in
   frame. Lucy regenerates every frame, so this is a probabilistic bias, not a guarantee. */
const HEM_DETAIL = " Preserve the garment's printed graphics, logos, and text, and its bottom-hem edge details (including any small corner monogram or brand mark), at their original scale, proportion, and relative position on the garment; render the complete hem in-frame without cropping, stretching, or drifting details toward the center.";

/* Layer-isolation clauses. Lucy VTON regenerates the WHOLE frame every pass, so a
   single-garment prompt that never mentions the opposite layer lets that layer
   drift (e.g. trying a shirt silently restyles the user's real pants). These hard
   "do not touch" instructions pin the untouched layer to the live camera so a
   top swap edits ONLY the top, and a bottom swap edits ONLY the bottom. */
const KEEP_BOTTOMS = " Keep the person's existing lower body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the trousers, shorts, skirt, shoes, belt, or anything below the waist, and do not add, invent or restyle any accessories that were not already present.";
const KEEP_TOP     = " Keep the person's existing upper body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the shirt, top, jacket, hat, scarf, jewelry, or anything above the waist, and do not add, invent or restyle any accessories that were not already present.";

/* ── Model-agnostic extraction - the OTHER body in the pipeline ───────────────
   THE GAP: every clause in this file that defends body shape defends it against the
   model's own training prior (STRICT_INPAINT's "it slimmed me down", SIDE_PROFILE_DEPTH's
   flattened profile). None of them account for the fact that the reference image usually
   contains A SECOND HUMAN - the e-commerce model wearing the product - and that Lucy sees
   that figure as part of its conditioning. IGNORE_SOURCE_ARTIFACTS is the nearest thing
   and it is deliberately scoped to non-human noise: badges, watermarks, orientation
   labels. A whole person in the reference asset was never named, so their shoulder line,
   chest, build and posture sat in the conditioning with nothing marking them as
   off-limits - and an unstated region is exactly what this file's history keeps recording
   as the thing that gets reinterpreted. That is the "it gave me the model's shoulders"
   report: not a detection failure, an unstated constraint, same class as every other bug
   these constants exist for.

   DELIBERATELY NOT A RESTATEMENT of ABSOLUTE BODY FIDELITY below. That clause already
   says the live person's shape is 1:1 ground truth and that the garment fits the body
   rather than the reverse; repeating it here would spend several hundred characters
   re-asserting it ~200 characters before it actually appears, against a prompt this file
   already argues is competing for the model's attention. What is genuinely new is the
   PROVENANCE SPLIT - the reference is the only source of cloth, the live feed is the only
   source of body - so that is what this carries, and it hands off to STRICT_INPAINT for
   the positive fidelity language it is placed directly ahead of.

   THE PRINT-PLACEMENT CARVE-OUT at the end is load-bearing, not padding. "Re-proportion
   the garment to their body" and BACK_TAIL.real's "keep each element at the SAME size,
   height and horizontal position, do not move, rescale or re-center the back print" are
   one bad reading apart from contradicting each other, and that print alignment was its
   own fix. Scaling the garment to a different body must not become licence to relocate
   its artwork on the garment, so the boundary is stated rather than left to inference. */
const MODEL_AGNOSTIC_EXTRACTION =
  " GARMENT ISOLATION MANDATE: the reference image is a TEXTURE AND CLOTHING TEMPLATE and" +
  " nothing more. Extract ONLY the garment from it - fabric, weave, colour, pattern, print," +
  " logos, seams, cut, collar, closure and hemline. If a person, model or mannequin is" +
  " wearing that garment in the reference, they are packaging: completely ignore their" +
  " body, physique, height, build, skin tone, shoulder width, chest, waist, limb positions" +
  " and posture." +
  " ZERO MODEL BLEED: do NOT transfer, copy, blend, average or impose ANY of that reference" +
  " figure's anatomy, proportions, pose or body structure onto the live person, and never" +
  " reshape the live person toward them. The live camera feed is the ONLY source of BODY;" +
  " the reference image is the ONLY source of CLOTH." +
  " DYNAMIC USER FITTING: fit, stretch, drape and re-proportion the extracted garment onto" +
  " the live person's own exact body shape and volume - their real torso, chest, stomach," +
  " waist and hips - so it reads as cut for THEM, with fabric tension, creases and folds" +
  " following their contours rather than the reference figure's. Re-proportioning the" +
  " garment to their body is NOT licence to move its artwork: any print, graphic, logo or" +
  " lettering keeps the size, height and position on the garment specified above.";

/* ── Strict garment inpainting - the hallucination clamp ──────────────────────
   KEEP_BOTTOMS/KEEP_TOP only ever pinned the OPPOSITE GARMENT layer. Everything else in
   frame - face, hair, hands, skin, the room behind the shopper, AND the shopper's own
   body shape/volume under the new garment - was simply never mentioned, and Lucy
   regenerates the WHOLE frame on every pass. Anything the prompt does not pin is a
   region the model is free to reinterpret, which is what "it changed my pants / my
   background" - and separately, "it slimmed me down" - actually is: not a bug in the
   model so much as an unstated constraint. The body-fidelity clause below exists
   because the model's training prior skews toward idealized/slim proportions, so a
   fuller torso, belly or wider waist gets quietly flattened toward that prior unless
   the prompt explicitly forbids it every single frame.

   READ THIS BEFORE REACHING FOR A MASK OR A CONDITIONING WEIGHT. There is no mask, ROI,
   DensePose/depth input, ControlNet conditioning scale, or inpainting-region parameter on
   Lucy realtime - set() takes exactly { prompt, enhance, image } (verified against
   @decartai/sdk@0.1.5 setInputSchema, which strips everything else). The prompt text is
   the ONLY channel this SDK exposes; there is no "mask config" or "conditioning scale" to
   turn up. A true pixel-locked boundary would have to be enforced OUTSIDE the model:
   segment the torso locally per frame (DensePose/SAM or similar) and composite Decart's
   output over the untouched camera frame everywhere else. That is a real, separate
   feature - a segmentation model in the hot path at LIVE_INFERENCE_FPS - not a parameter
   this file can set, and it is deliberately NOT what this constant is. This is the
   strongest available lever through the one channel the API actually exposes, and it is a
   probabilistic bias on every generated frame, not a guarantee. */
const STRICT_INPAINT =
  " STRICT GARMENT INPAINTING MODE: edit ONLY the target garment(s) named above. Every" +
  " other pixel is locked source footage that must pass through EXACTLY as it appears in" +
  " the live video frame - the person's face, hair, head, neck, hands, arms and skin, and" +
  " the entire background, room and lighting. Do NOT generate, replace, restyle, recolor" +
  " or re-render the background, or any part of the person outside the target garment(s)." +
  " ABSOLUTE BODY FIDELITY: 1:1 adherence to the person's exact detected body shape," +
  " weight, volume and silhouette exactly as captured in the live frame, including their" +
  " chest, stomach/belly shape, hips, waist circumference and torso width. Do NOT flatten," +
  " slim, smooth, thin, reshape or idealize their physique in any way, and do NOT shrink" +
  " the chest, torso, waist, hips or belly boundary inward toward a thinner baseline. If" +
  " the person has a fuller figure, belly, wider hips or wider torso, drape and stretch the" +
  " garment realistically OVER their actual chest, stomach, hips and body volume - with" +
  " natural fabric tension, creases and shadow folds where it meets their real contours," +
  " not a flat model-cut fit. Map the garment onto that exact physical volume: fit the" +
  " garment to the body; never the body to the garment." +
  " STRICT GARMENT ISOLATION: replace and fit only the target garment named above - this is" +
  " a single-item substitution, not a full-outfit restyling. Preserve the shopper's" +
  " existing pants, shorts, skirt, belt and every other accessory exactly as seen in the" +
  " live camera frame: no added belts, no unrequested pants, no added accessories, and no" +
  " invented clothing items of any kind outside the one garment specified.";

/* ── Source-frame hygiene - camera/UI artifacts are not garment content ───────
   STRICT_INPAINT above says the live frame outside the target garment is "locked
   source footage" to pass through untouched - but it never said what to do with
   pixels that were never real footage of the person or garment in the first
   place: a product photo's price sticker or hangtag, a watermark, a capture
   timestamp, or any app/browser chrome that leaks into a frame. Nothing upstream
   filters these out before the prompt runs, and an unstated pixel is exactly the
   kind of region the model is free to reinterpret (the same class of gap
   STRICT_INPAINT's own comment documents for body shape) - so a stray badge or
   label sitting on a reference image reads as "content on the garment" with
   nothing telling the model otherwise, risking a rendered logo/print that never
   belonged to the actual product. Named explicitly as noise to discard. */
const IGNORE_SOURCE_ARTIFACTS =
  " Ignore any incidental on-screen text, UI overlays, badges, orientation labels" +
  " (e.g. \"FRONT\"/\"BACK\"), timestamps, watermarks or frame borders present in the" +
  " source image or live video feed - these are capture artifacts, not part of the" +
  " garment or the person, and must never be rendered, reproduced or interpreted as" +
  " clothing design, print or texture.";

/* ── Side-profile anomaly guard - what the garment drapes OVER while turned ───
   Paired with ROTATION_CONTINUITY below, which keeps the garment ON through a
   turn; this addresses a different failure in the same window. In profile the
   body's silhouette foreshortens, and whatever the shopper happens to be
   holding (a phone, a bag, any held object) or brief lens/motion distortion
   during the turn can sit right where torso volume would otherwise read. With
   nothing telling the model these aren't anatomy, they get treated as body the
   garment must fit around - an anomalous bulge or shape at exactly the moment
   the pose is already hardest to read.
   NOT the same claim as, and does NOT relax, STRICT_INPAINT's ABSOLUTE BODY
   FIDELITY guarantee above - that clause exists specifically because this
   model's training prior skews toward slimming real bodies, and was written
   after that exact complaint. This one is scoped ONLY to non-anatomical
   objects and transient capture artifacts; the person's actual body, at any
   angle including side-on, is still rendered with the same fidelity as head-on -
   never thinned, flattened or idealized. */
const PROFILE_ANOMALY_GUARD =
  " While the person is side-on or turning, do not mistake held objects, props," +
  " clothing caught by motion, or transient camera/lens distortion for part of" +
  " their body - these must never distort the rendered garment's fit or shape." +
  " Drape the garment following the person's actual, undistorted anatomical body" +
  " contour only, at exactly the same body-shape fidelity required at every other" +
  " angle - never as license to slim, smooth or idealize their real silhouette.";

/* ── Rotation continuity - the "my real shirt came back" clamp ────────────────
   Paired with the freeze-through-the-turn hold in the OrientationWatcher (see
   ORIENT_TURN_HOLD_MS). The hold covers the window visually; this tells the model what
   the window is FOR, so the frames it generates during the rotation are still dressed.

   The failure it addresses: mid-turn the shopper is in profile, the torso is foreshortened
   and the face is leaving frame. With nothing in the prompt about rotation, the most
   probable continuation for a partially-occluded person is the person as photographed -
   i.e. their real shirt. Naming the turn as an expected, continuous state makes staying
   dressed the likelier completion. */
const ROTATION_CONTINUITY =
  " The person may rotate to any angle, including turning fully away from the camera." +
  " Throughout the rotation the virtual garment stays ON the body, continuously fitted," +
  " with no frame in which it is dropped, faded, or replaced by the person's own real" +
  " clothing - even while they are side-on, partially occluded, or facing away with no" +
  " face visible. Carry it through the turn and transition smoothly to the correct side" +
  " of the reference as the body comes around.";

/* Universal hard negative appended to EVERY prompt (per product spec). Bars the opposite
   view's signature details from leaking in when the back is being rendered - a belt-and-
   suspenders backstop alongside ANGLE_CLAUSE.backReal/backInferred's own "do NOT render
   the front" instruction. */
const HARD_NEGATIVE = " Strictly prevent the rendering of FRONT details (like logos or front-pockets) when the BACK view is requested.";

/* THE MAIN ENTRY POINT for a single-garment dispatch, and the function the dynamic-drape
   contract is stated through: it resolves to CATEGORY_ANCHOR.top or .bottom, which are the
   two strings that tell the model the GARMENT is static and the BODY is per-frame. See
   CATEGORY_ANCHOR for the wording, the failure it answers, and the two clamps it gave up.

   `angleText` is angleClause()'s output, passed IN rather than concatenated on by the
   caller. That is what makes the budget enforceable: the old shape was
   `buildPrompt(item) + angleClause(...)`, two independently-sized strings glued together
   downstream, so neither half could know the total and nothing could shed a clause when
   the pair overran. Threaded through here, the orientation clause becomes one more
   priority-tagged part in a single fitPrompt() call - and it ranks CORE, because a prompt
   that has lost its orientation clause renders the wrong side of the garment. It is
   retained-and-unused today (see buildCompositePrompt's note on the same seam). */
function buildPrompt(item, angle = "front") {
  return imageOnlyPrompt(item, angle);
}

/**
 * Prompt for a user-uploaded ("custom") garment. Returns IMAGE_ONLY_PROMPT.
 *
 * IDENTICAL TO buildPrompt(), and has been since the image-first refactor rather than by
 * oversight. These two diverged for exactly one reason: a catalog item had metadata to
 * describe ("white t-shirt") and an upload did not, so the custom path pointed at the
 * reference image while the catalog path recited catalog fields. Neither describes
 * anything now, so there is nothing left to differ about - a shopper's uploaded photo and
 * a catalog packshot are the same kind of asset and get the same treatment.
 *
 * Kept as its own function because it is the documented entry point for the upload flow
 * and because the dispatch is a seam worth keeping: if the two ever need to diverge again
 * (a crop-confidence hint, say), it is already here. buildPrompt() no longer branches to
 * it - a branch between two identical returns is a false signal that they differ.
 * @param {object} item - a custom item ({ custom:true, garmentType, img, color })
 * @returns {string}
 */
function buildCustomPrompt(item, angle = "front") {
  return imageOnlyPrompt(item, angle);
}

/**
 * Build ONE prompt that instructs the model to overlay the shirt AND the pants
 * simultaneously (a single pass), so a full outfit is rendered together rather
 * than as two separate substitutions.
 */
function buildLookPrompt(top, bottom, angleText = "") {   // eslint-disable-line no-unused-vars
  /* THE ONE PLACE THIS MODE IS A REAL BET RATHER THAN A CLEAN WIN, recorded so it is not
     discovered by surprise. A full look ships ONE stitched reference holding two garments
     (TOP over BOTTOM), and DENSE.lookPanels is what told the model that image was two
     garments to render simultaneously rather than one to choose between. Strict image-only
     removes it, so the layout now has to carry that entirely on its own - which the
     stitcher is built for (isolated panels, wide separator band; see stitchLookBlob) but
     which was never tested without the sentence.

     If a look starts rendering only the shirt, or blending the two, DENSE.lookPanels is
     the first clause to buy back - and it is the one clause in this file whose absence
     costs a whole FEATURE rather than a degree of fidelity. */
  /* DELIBERATELY NOT imageOnlyPrompt(). The BOTTOMS branch there pins the opposite layer
     to the live camera - "Keep the subject's upper body and background unmodified." -
     which is exactly the instruction a full look must not carry: addToLook() ships a
     two-garment payload precisely because the shopper asked for both layers to be
     substituted, and telling the model to preserve the live top while handing it a
     stitched TOP+BOTTOM reference is a contradiction that resolves however the sampler
     feels like resolving it.

     THE TOPS BRANCH IS NOT SAFE HERE EITHER, and it is worth saying why, because it no
     longer carries that sentence: it still names ONE region ("the EXACT upper garment
     ... onto the subject") against a reference holding two garments, which is the
     wrong-region contradiction that opened this whole sequence. Neither branch is a
     substitute for this one. This anchor claims both layers instead, and carries the same
     STRICT_REFERENCE_LOCK the two single-garment branches do. */
  return lookAnchorPrompt();
}


/* ══ THE WIRE ═════════════════════════════════════════════════════════════════
   POST /api/prompt. Two kinds, because in strict image-only mode exactly two builders
   reach Decart: the single-garment prompt (imageOnlyPrompt - what buildPrompt() and
   buildCompositePrompt() return) and the full-look prompt (lookAnchorPrompt - what
   buildLookPrompt() returns). The answer is already clamped for the wire, logged under
   the dispatch site's own name (`where`), exactly as the browser did. */
const PROMPT_ITEM_STRINGS = ["name", "title", "type", "category", "subType", "garmentType",
                             "colorHex", "textOcr", "fabric"];
const PROMPT_ITEM_BOOLS = ["backIsPlain", "_backLooksPrinted", "__bottoms", "custom"];

export function sanitizePromptRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const src = b.item && typeof b.item === "object" && !Array.isArray(b.item) ? b.item : {};
  const item = {};
  for (const k of PROMPT_ITEM_STRINGS) {
    if (typeof src[k] === "string") item[k] = src[k].slice(0, 400);
  }
  for (const k of PROMPT_ITEM_BOOLS) {
    if (typeof src[k] === "boolean") item[k] = src[k];
  }
  const delta = Number.isInteger(b.delta) ? Math.max(-12, Math.min(12, b.delta)) : 0;
  return {
    kind: b.kind === "look" ? "look" : "single",
    angle: b.angle === "back" ? "back" : "front",
    inProfile: b.inProfile === true,
    delta,
    where: typeof b.where === "string" ? b.where.replace(/[^\w.-]/g, "").slice(0, 40) || "api" : "api",
    item,
  };
}

/** @returns {string} the clamped wire prompt for one sanitised request */
export function promptForRequest(req) {
  _requestSizeDelta = req.delta;
  try {
    /* buildCompositePrompt(), not imageOnlyPrompt() directly: it is the builder that takes
       the pose (applyGarment()'s frozen edge-on reading) - the restore seam. In strict
       image-only mode it returns imageOnlyPrompt(item, angle), as buildPrompt() does. */
    const raw = req.kind === "look" ? lookAnchorPrompt() : buildCompositePrompt(req.item, req.angle, req.inProfile);
    return clampPromptForWire(raw, req.where);
  } finally {
    _requestSizeDelta = 0;
  }
}

export { imageOnlyPrompt, lookAnchorPrompt, fitPrompt, clampPromptForWire, isBottomsGarment, P };
