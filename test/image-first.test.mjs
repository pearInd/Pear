/* STRICT IMAGE-ONLY CONDITIONING - "I picked a Spider-Man tee and it rendered a tuxedo".

   REPORTED FAILURE: a graphic t-shirt selected from the catalog, its reference image
   correctly resolved, correctly composited and correctly delivered to rtClient.set() -
   and Decart streaming back a full tuxedo with a bowtie. Not a wrong colour, not a
   drifted print: a different garment entirely, of a different class, from a reference the
   model demonstrably had. Reported TWICE - the first fix did not stop it.

   ROOT CAUSE - the prompt was competing with its own image. Decart's realtime set()
   accepts exactly { prompt, image, enhance } (verified against @decartai/sdk@0.1.5
   setInputSchema). There is no negative_prompt, no image-strength, no ControlNet weight -
   so the ONLY lever this app has over how hard the reference image is weighed against the
   text is how much text there is.

   FIX ONE removed the two clauses that were most obviously fighting the pixels:
     · THE GARMENT DESCRIPTION. Every builder opened by interpolating catalog metadata -
       "Replace their top with white t-shirt: exact colour, texture and print." A text
       description is something a diffusion model can satisfy out of its own prior instead
       of out of the reference. Nothing in that sentence mentions Spider-Man.
     · THE ENUMERATED NEGATIVE. DENSE.assetLock spelled out "never invent a garment,
       jacket, coat, suit, TUXEDO, tie, BOWTIE or badge". With no negative_prompt field
       those nouns ship inside the POSITIVE prompt, where a named garment is a token the
       sampler can steer toward.
   It kept an image anchor plus the STRUCTURAL clauses (panel contract, pose, passthrough
   locks) on the theory that a clause which describes no garment cannot summon one.

   THE TUXEDO SURVIVED IT, so FIX TWO drops the theory: every clause is text, structural
   ones included, and the axis that mattered was total volume rather than kind. The prompt
   is now ONE FROZEN STRING - IMAGE_ONLY_PROMPT - byte-identical for every garment, angle,
   pose and shopper. It cannot contradict the reference because it says nothing the
   reference could contradict, and it cannot dilute it because there is nothing to shed.

   THE COMPOSITE STANDS DOWN WITH IT (COMPOSITE_DEFAULT = false), and that is the one
   non-prompt change in this mode. A split FRONT|BACK reference is only legible alongside
   the panel contract that explains it; strip the contract and the model is handed a
   collage with no key, which is both the 23f5953 double-print bug and exactly the kind of
   ambiguous reference that sends a diffusion model back to its prior.

   WHAT THIS SUITE PINS, and why each is a distinct way for the fix to rot:
     §1  the frozen string's exact wording (product-specified) and that it is genuinely
         constant - no interpolation, no per-item branch, no concatenation;
     §2  every builder returns it and assembles nothing, at every angle and pose;
     §3  the retirement is REVERSIBLE - the clauses and the assembly machinery are all
         still on file, because a mode this aggressive will need pieces bought back;
     §4  the composite stands down, with its kill switch still working both ways;
     §5  the payload actually carries an image on every update and retry, because an
         image-only prompt with no image is the same failure through the other half of
         the call - and that path used to be silent.

   Sibling suites: model-agnostic.test.mjs holds the record of the body clauses and their
   restore path; side-profile.test.mjs still proves angleClause() assembles correctly (it
   is the restore path, kept live); composite.test.mjs owns the stitch geometry. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real builder, executed. */
const code = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                       SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: 650, console: { warn() {}, log() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
  colorName: () => "white",
  activeColorOf: (it) => (it && it.color) || "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "regular fit", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { buildCompositePrompt, imageOnlyPrompt, fitPrompt, P, DENSE };")(...Object.values(sandbox));

const TEE   = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };
const JEANS = { name: "Glide Slim", garmentType: "lower_body", color: "#222" };

/* \u2500\u2500 ONE STRING BECAME TWO, AND THAT IS THE ONLY THING THAT CHANGED \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   The frozen string opened "Fit a standard t-shirt from the reference image" for EVERY
   product in the catalog. On a trouser packshot that is a contradiction the model resolves
   by taking the whole reference - so the catalog model's shirt replaced the shopper's real
   one. run.mjs's suite index had already named the gap ("an 'upper garment' anchor on a
   trouser reference is the same contradiction"); garment-category-prompt.test.mjs owns the
   fix. This suite keeps everything it already guaranteed, now per branch.

   THE MODE IS INTACT. The prompt is still constant per dispatch, still assembles no
   garment description, still has no interpolation hole. It varies on exactly ONE axis -
   which body region is being replaced - and NOT on colour, variant, angle or pose. */
/* BOTH BRANCHES NOW STATE THE STATIC-GARMENT / DYNAMIC-BODY SPLIT, and that is the fifth
   report in this sequence. Four preceded it, each a different failure:
     1. WRONG REGION   - a t-shirt anchor on a trouser reference (the category branch).
     2. WRONG GARMENT  - generic black shorts instead of the photographed white ones
                         (bottoms collapsed).
     3. INVENTED DETAIL- the right garment with textures the reference never had
                         (both collapsed, and "invent/add/alter" all banned).
     4. SHIRT REPLACEMENT - report 1's failure, re-opened by the collapse that fixed 3:
                         with the scoping implicit, a trouser try-on could take the
                         reference model's top too. Bottoms named its region again.
     5. STRETCHED GARMENT - the shopper turns 90 degrees, or gains real profile volume,
                         and the 0-degree drape is DEFORMED over the new shape instead of
                         the garment being re-draped on it. Both anchors were rewritten
                         around the split that answers it: the garment is EXACT and
                         STATIC, the body is CURRENT and per-frame. The prompt is only half
                         that fix - the other half is the topology monitor in app.js, which
                         is what makes a re-conditioning dispatch happen at all;
                         body-topology.test.mjs owns that side.
     6. BUILD + THE NON-TARGET GARMENT - two at once, and the current wording. The drape
                         ignored how WIDE the subject is (the previous pair named the depth
                         axis three times and the width axis not once), and stepping back
                         to reveal the OTHER half of the body made the model invent a
                         garment there. So these name the width axis per region
                         ("narrow or wide") and lock the opposite layer to the camera - on
                         BOTH branches this time, which is the symmetric restoration of the
                         clause revision 5 dropped and was warned about. 343 chars tops,
                         334 bottoms.
   See CATEGORY_ANCHOR in app.js for the full list of what came off the wire, what went
   back on, and the restore path for each. */
const TOPS_SPEC =
  "Fit ONLY the reference shirt onto the subject's upper torso. For any lower body" +
  " parts, legs, or shorts that enter the camera frame during the video, pass through" +
  " and strictly preserve the subject's LIVE camera feed clothing (color, pattern," +
  " length) without generating, replacing, or inventing any new pants or garments.";
const BOTTOMS_SPEC =
  "Fit ONLY the reference pants/shorts onto the subject's lower body. For any upper" +
  " body parts, torso, or shirt that enter the camera frame during the video, pass" +
  " through and strictly preserve the subject's LIVE camera feed clothing (color," +
  " pattern, length) without generating, replacing, or inventing any new top or" +
  " garments.";
/* \u00a71's shared-tail assertions read this; the tail is identical in both branches except
   for the two top-specific construction clauses, which \u00a71 checks per branch. */
const SPEC = TOPS_SPEC;

console.log("── §1 THE TWO ANCHORS: product-specified, and genuinely constant ──");
{
  /* Byte-exact, because the wording is a product decision rather than an implementation
     detail - a paraphrase that reads the same to a human is a different token sequence to
     a diffusion model, and these are the strings whose exact form was specified from
     outside this file. */
  check("the TOPS branch matches the specified wording byte for byte",
    api.imageOnlyPrompt(TEE) === TOPS_SPEC, JSON.stringify(api.imageOnlyPrompt(TEE)));
  check("the BOTTOMS branch matches the specified wording byte for byte",
    api.imageOnlyPrompt(JEANS) === BOTTOMS_SPEC, JSON.stringify(api.imageOnlyPrompt(JEANS)));
  /* ONE SHAPE, THREE SENTENCES, SAME ORDER. The old pair could be normalised into one
     string because they differed by two substitutions; these two are worded per region
     (a waistline is not a belly, a leg profile is not a silhouette), so the invariant
     that actually holds is STRUCTURAL: bind-and-scope, then adapt, then preserve - in
     that order, with nothing appended. Asserted as an exact sentence count so a fourth
     clause cannot be slipped onto either branch, which is the regression this whole
     suite exists to catch. §1 then checks each of the three per branch, below. */
  const sentences = (s) => s.split(/(?<=\.)\s+/).filter(Boolean);
  check("both branches are exactly two sentences: scope, then pass-through",
    sentences(TOPS_SPEC).length === 2 && sentences(BOTTOMS_SPEC).length === 2,
    `tops=${sentences(TOPS_SPEC).length} bottoms=${sentences(BOTTOMS_SPEC).length}`);
  check("...and both open on the SAME three words - the exclusive-scope binding",
    TOPS_SPEC.startsWith("Fit ONLY the reference ") &&
    BOTTOMS_SPEC.startsWith("Fit ONLY the reference "),
    `tops=${TOPS_SPEC}\n        bottoms=${BOTTOMS_SPEC}`);

  /* THREE SENTENCES, THREE JOBS. Asserted individually because the failure mode of a
     minimal prompt is a well-meant reword that quietly drops one - and there is no
     fitPrompt() shed log to catch it, because there is no assembly left to log. */
  /* (1) THE SPLIT ITSELF, in one sentence: the garment is bound to the reference AND
     declared STATIC; the target is the subject's CURRENT contour IN THIS FRAME. Both
     halves are load-bearing and both are asserted - "EXACT ... from the reference image"
     without "static" invites a re-cut, and "onto the subject" without "current ... in
     this frame" is the tense-less wording every previous revision shipped, which is what
     let the model deform a drape it had already produced. */
  /* "Fit ONLY" scopes the whole instruction in the first two words - before any noun is
     introduced - which is where a leading-token model is most sensitive. */
  const LEAD = /^Fit ONLY the reference (shirt|pants\/shorts) onto the subject's (upper torso|lower body)\./;
  check("(1) it scopes to ONE garment and ONE region, in the first sentence",
    LEAD.test(TOPS_SPEC) && LEAD.test(BOTTOMS_SPEC),
    "an unscoped anchor is what let a try-on claim the whole reference");
  check("...and each branch FITS one region only",
    /onto the subject's upper torso\./.test(TOPS_SPEC) &&
    /onto the subject's lower body\./.test(BOTTOMS_SPEC),
    "a lower-body garment fitted to 'the body' is report 1 through the new wording");
  /* (2) THE ADAPTATION, which is the sentence the stretched-garment report exists for. It
     must instruct a re-drape AND name the two ways of faking one, because "adapt to the
     silhouette" is satisfiable by warping - that is precisely what was happening. */
  /* (2) THE WIDTH AXIS, which is what this revision exists for. The previous pair asked
     for adaptation to "silhouette, angle, depth, and belly volume" - the DEPTH axis named
     three times and WIDTH not once - so a slender build got a shirt that hung off the
     shoulders and a broad one got a clipped, warped drape. Both directions are named
     explicitly, so it cannot be read as "make it bigger". */
  /* (2) THE EVENT, NOT JUST THE REGION - and this is what the previous lock was missing.
     It said "preserve the subject's actual live lower clothing", which a model can read as
     describing what was in frame WHEN THE SESSION STARTED. In the report, nothing was: the
     legs entered at 00:03, so that sentence had no referent at 00:00 and the region was
     effectively unstated by the time it mattered. This names the entry itself. */
  check("(2) it names the ENTRY of the non-target region mid-video, not just the region",
    /that enter the camera frame during the video/.test(TOPS_SPEC) &&
    /that enter the camera frame during the video/.test(BOTTOMS_SPEC),
    "a region that is out of frame at t=0 has no referent unless its arrival is named");
  check("...enumerating what actually enters, so 'legs' cannot be read as 'not clothing'",
    /lower body parts, legs, or shorts/.test(TOPS_SPEC) &&
    /upper body parts, torso, or shirt/.test(BOTTOMS_SPEC),
    `tops=${TOPS_SPEC}\n        bottoms=${BOTTOMS_SPEC}`);
  /* (3) THE NON-TARGET LOCK - the second report, and the sentence that closes it. Try on a
     shirt, step back so your legs enter frame, and the model invented trousers nobody
     asked for. This names the shopper's OWN clothes as the thing to preserve, sources them
     from the camera, and bans all three edits on them. */
  check("(3) it routes that region to the LIVE CAMERA FEED, by name",
    /pass through and strictly preserve the subject's LIVE camera feed clothing/.test(TOPS_SPEC) &&
    /pass through and strictly preserve the subject's LIVE camera feed clothing/.test(BOTTOMS_SPEC),
    "'preserve' without a source still leaves the model to decide what it is preserving");
  /* LENGTH is the attribute the report turned on: light blue SHORTS came back as long
     black trousers, so colour and pattern alone would not have described the failure. */
  check("...naming colour, pattern AND length - length is what the report turned on",
    /\(color, pattern, length\)/.test(TOPS_SPEC) && /\(color, pattern, length\)/.test(BOTTOMS_SPEC),
    "shorts rendered as long trousers is a LENGTH failure before it is a colour one");
  check("...and banning all three edits - generating, replacing AND inventing",
    /without generating, replacing, or inventing any new pants or garments\.$/.test(TOPS_SPEC) &&
    /without generating, replacing, or inventing any new top or garments\.$/.test(BOTTOMS_SPEC),
    "forbidding invention alone still permits altering what is already there");
  /* THE PROMPT IS THE ASK; THE GUARD IS THE GUARANTEE. Decart's set() has no mask channel,
     so this wording is a probabilistic bias and nothing more. Asserted together so the
     pair cannot be separated by a later edit that trusts the text alone. */
  check("...and the guarantee MECHANISM is still on file, one flag from restoration",
    /function paintGuardBand\(ctx, webcam, w, h\)/.test(SRC) &&
    /LOWER_BODY_GUARD_ENABLED: false/.test(CFG),
    "the compositing guard was disabled 2026-08-24 by request (100% direct Decart " +
    "stream). The clause above is therefore an ASK with nothing enforcing it - which " +
    "is the known cost, recorded in config.js. This check pins that the mechanism " +
    "still exists and that the flag is the only thing off.");
  /* SYMMETRIC, and that is new. The lock sat on bottoms alone for three revisions on a
     one-branch-at-a-time-on-evidence rule, then came off entirely. Both branches carry it
     now: no report has been filed of a tops try-on repainting real trousers, but the
     mechanism is identical and the evidence for one direction is evidence for the other. */
  check("...on BOTH branches - the asymmetry is deliberately over",
    /LIVE camera feed clothing/.test(TOPS_SPEC) && /LIVE camera feed clothing/.test(BOTTOMS_SPEC));
  check("...and neither passes through the very layer it is fitting",
    !/upper body parts, torso, or shirt/.test(TOPS_SPEC) &&
    !/lower body parts, legs, or shorts/.test(BOTTOMS_SPEC),
    "a prompt that passes through the layer it is editing cancels itself");
  /* THE RUNTIME HALF. This wording promises a per-frame fit, and text alone cannot keep
     that promise: with a constant prompt and the reference already on the wire,
     applyGarment() dispatches nothing at all. Asserted here, in the suite that owns the
     wording, so the two halves can never be separated by a later edit. */
  check("...and the per-frame promise is backed by a real re-conditioning dispatch",
    /function reconditionForTopology\(/.test(SRC) &&
    /lastSentImageRef = null;/.test(SRC.slice(SRC.indexOf("async function reconditionForTopology("))),
    "a prompt that says 'this frame' with no dispatch behind it is a claim, not a fix");

  /* ── WHAT CAME OFF THE WIRE, asserted as ABSENCE + a live restore path ──────
     Every one of these is a reproduced regression. They are RETIRED, not deleted: each
     constant is still on file, so a restore is one line in imageOnlyPrompt(). Asserting
     both halves is what stops a deliberate removal decaying into a forgotten one. */
  const RETIRED = [
    ["body-volume persistence",     /abdomen\/stomach depth/,                /const VOLUME_PERSISTENCE =/],
    ["frontal volume",              /In front-facing \(0-degree\) views/,    /const FRONTAL_VOLUME =/],
    ["closed back / un-knotted hem",/closed back and normal un-knotted hem/, /const CLOSED_BACK_HEM =/],
    ["temporal persistence",        /as soon as visible/,                    /const TEMPORAL_PERSISTENCE = /],
    /* NEW IN THE DYNAMIC-DRAPE REVISION, and the more expensive of its two losses. The
       fidelity sentence that replaced it forbids CHANGING the garment but not ADDING to
       it, so the invented-detail report (report 3) is the one to watch. The constant is
       still live on the full-look path, so this restore is genuinely one line. */
    ["the invent/add/alter clamp",  /Do NOT invent, add, or alter any details/,
                                    /const STRICT_REFERENCE_LOCK =/],
    /* KEEP_OPPOSITE_LAYER's WORDING is retired - the live lock is phrased around the
       shopper's clothes and the camera rather than around a region - but the PROTECTION it
       provided is back on both branches (asserted below). The constant stays on file
       because it is the record of the earlier phrasing, and the absence test still holds:
       that exact sentence is not what ships. */
    ["the region-shaped opposite-layer pin",
                                    /Keep the subject's upper body and background unmodified/,
                                    /const KEEP_OPPOSITE_LAYER = /],
    /* NEW IN THIS REVISION. The garment-fidelity sentence was REPURPOSED to the opposite
       layer, so the garment's own provenance now rests on "the exact reference shirt"
       alone. Report 3 (invented detail) and the black-shorts report (wrong colour) are
       the two to watch; the restore is one line, and the constant is right there. */
    ["the garment's own texture/pattern/colour clamp",
                                    /Strictly preserve the original shirt texture/,
                                    /const STRICT_REFERENCE_LOCK =/],
    /* NEW: the build/width sentence. The morphology monitor that decides WHEN to
       re-condition is untouched, so what is retired is the prompt's half of the width
       axis - watch for a loose drape on a slender build. */
    ["the build/width adjustment sentence",
                                    /Dynamically adjust the shirt cut, shoulder width/,
                                    /the build\/width adjustment sentence \("Dynamically adjust the shirt cut,/],
  ];
  for (const [label, absent, constantRe] of RETIRED) {
    check(label + ": off the wire on BOTH branches",
      !absent.test(TOPS_SPEC) && !absent.test(BOTTOMS_SPEC));
    check("...but still on file, so its restore is genuinely one line",
      constantRe.test(SRC), String(constantRe) + " not found in app.js");
  }
  /* ── THE OPPOSITE-LAYER LOCK IS BACK, ON BOTH BRANCHES ─────────────────────
     Its history is the whole argument for why it is now symmetric. It sat on BOTTOMS
     alone for three revisions under a one-branch-at-a-time-on-evidence rule; the
     dynamic-drape revision dropped it entirely and flagged that as the loss most likely to
     re-open a fixed report; it did exactly that, through a NEW trigger - a region entering
     frame mid-session with nothing said about it, rather than a mis-scoped anchor.

     WHAT SHIPS NOW IS STRONGER THAN WHAT WAS REMOVED. The old pin named a REGION ("keep
     the subject's upper body and background unmodified"); these name the shopper's actual
     CLOTHES and source them from the camera, which is the thing the model has to leave
     alone. The region naming survives too, in the lead. Both halves asserted separately,
     because they fail separately: naming the region to edit does not forbid an edit
     elsewhere, and forbidding one does not name the other. */
  check("bottoms still scopes the fit to the LOWER BODY, in its lead",
    /onto the subject's lower body\./.test(BOTTOMS_SPEC),
    "an unscoped anchor is the exact configuration the shirt-replacement report was filed against");
  check("...and tops scopes to the UPPER TORSO in exactly the same place",
    /onto the subject's upper torso\./.test(TOPS_SPEC));
  check("app.js flags the opposite-layer lock as the FIRST thing to restore on tops",
    /IF SHIRT-REPLACEMENT\s*\n?\s*RETURNS, THIS IS THE CLAUSE TO RESTORE FIRST/.test(SRC),
    "the note stays even though the clause is back - it is the record of why");
  check("...and app.js records that the restore actually happened, symmetrically",
    /THE OPPOSITE-LAYER LOCK IS BACK, AND THIS TIME ON BOTH BRANCHES/.test(SRC),
    "a restore note that still reads as a pending TODO is worse than none");
  check("...with the pre-collapse KEEP_TOP wording still on file as the fallback",
    /const KEEP_TOP\s+= " Keep the person's existing upper body exactly as it is in the live camera/.test(SRC),
    "the DENSE-era constant is the alternative to mirroring the bottoms sentence");

  /* CONSTANT, not merely short. A template literal here is how a description creeps back
     in one field at a time, which is the exact history this mode is reacting to. */
  check("declared with no interpolation hole",
    /const CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(SRC) &&
    !/CATEGORY_ANCHOR = Object\.freeze\(\{[\s\S]{0,900}?\$\{/.test(SRC),
    "no template hole anywhere in or adjacent to the declaration");
  check("...and the resolver only SELECTS an anchor, never builds one",
    /\[P\.CORE, isBottomsGarment\(item\) \? CATEGORY_ANCHOR\.bottom : CATEGORY_ANCHOR\.top\]/.test(SRC) &&
    !/CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(SRC),
    "appending one clause is how the dozen came back last time");
  check("both sit far inside the 226-token ceiling, so the wire guard never clips them",
    TOPS_SPEC.length <= 650 && BOTTOMS_SPEC.length <= 650,
    "tops=" + TOPS_SPEC.length + " bottoms=" + BOTTOMS_SPEC.length);
}


console.log("\n── §2 EVERY SINGLE-VIEW BUILDER RETURNS IT, AND ASSEMBLES NOTHING ──");
{
  const cases = [
    ["FRONT square-on", TEE, "front", false],
    ["FRONT edge-on", TEE, "front", true],
    ["BACK square-on", TEE, "back", false],
    ["BACK edge-on", TEE, "back", true],
    ["BOTTOMS edge-on", { ...TEE, garmentType: "lower_body" }, "front", true],
    ["custom upload", { ...TEE, custom: true }, "front", true],
    ["pathological name", { ...TEE, name: "x".repeat(400) }, "front", true],
  ];
  /* Each case now names the branch it must land in. The invariance being asserted is
     unchanged in strength - byte-identical output across angle, pose, colour, custom-upload
     and pathological-name - it is just measured against the anchor for that garment's
     REGION rather than one global constant. */
  /* MEASURED ON THE RESOLVER ITSELF, not through buildCompositePrompt(). That builder used
     to be a pure pass-through, which made it a convenient probe; it is not one any more
     (see the exemption below), and probing the doctrine through the one path that is
     exempt from it would assert nothing. imageOnlyPrompt() IS what every single-view
     builder returns, so it is the honest place to measure invariance. */
  for (const [name, item, angle, prof] of cases) {   // eslint-disable-line no-unused-vars
    const expected = item.garmentType === "lower_body" ? BOTTOMS_SPEC : TOPS_SPEC;
    check(`${name}: byte-identical to its category anchor`,
      api.imageOnlyPrompt(item) === expected,
      api.imageOnlyPrompt(item));
  }
  /* THE AXIS ITSELF, asserted once: category is the ONLY thing that moves the prompt. */
  check("the two branches are genuinely different, and category is the only axis",
    TOPS_SPEC !== BOTTOMS_SPEC &&
    api.imageOnlyPrompt(TEE) === api.imageOnlyPrompt(TEE) &&
    api.imageOnlyPrompt(JEANS) === api.imageOnlyPrompt(JEANS) &&
    api.imageOnlyPrompt(TEE) !== api.imageOnlyPrompt(JEANS));

  /* Structural, across the builders this sandbox cannot execute. The four together are
     every path that can reach rtClient.set() with a prompt. */
  const builders = [
    ["buildPrompt", /function buildPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildCustomPrompt", /function buildCustomPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildLookPrompt", /function buildLookPrompt\(top, bottom, angleText[\s\S]*?\n}/],
  ];
  for (const [name, re] of builders) {
    const body = (SRC.match(re) || [""])[0];
    /* Comments stripped first: buildLookPrompt()'s body carries the restore note naming
       DENSE.lookPanels, and a check that trips over the explanation of the retirement is
       worse than no check - it would force whoever reads it to delete the documentation. */
    const codeBody = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* "Calls no assembler" is still the property, and it still means the same thing: no
       builder may assemble a garment DESCRIPTION. The single fitPrompt() call now lives
       inside imageOnlyPrompt(), where it selects between two frozen literals and budgets
       the shared tail - it is not reachable from a builder, so a builder still cannot
       introduce a clause. What each builder does is DELEGATE, and that is asserted. */
    check(`${name}(): delegates to the category resolver, assembles nothing itself`,
      /return (imageOnlyPrompt\(item\)|lookAnchorPrompt\(\));/.test(codeBody) &&
      !/fitPrompt\(/.test(codeBody) && !/DENSE\./.test(codeBody),
      codeBody.slice(-240) || "builder not found");
  }

  /* THE INVARIANT, stated as an absence - the only form that catches the real regression,
     which is somebody adding one more well-meant clause. Every clause this file ever grew
     was individually justified; the sum is what produced the tuxedo. */
  /* ── THE ONE EXEMPTION, AND WHY IT IS NARROW ────────────────────────────────
     buildCompositePrompt() assembles again, alone among the builders. It is the only one
     whose reference is a SPLIT image, and this file's own argument for standing the
     composite path down said why that is different: "a split FRONT|BACK reference is only
     legible alongside the panel contract that explains it". The composite is no longer
     hypothetical - the widget hands one over and referenceImageFor() sends it - so the
     contract has to ride with it or the model sees an unexplained seam and renders the
     LEFT panel onto a turned-around body. The single-view doctrine is untouched and is
     what every check above still pins. */
  {
    const body = (SRC.match(/function buildCompositePrompt\(item, angle, inProfile\)[\s\S]*?\n}/) || [""])[0];
    const codeBody = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* Pinned as an EXACT membership list, not "contains DENSE": the failure mode this
       whole section exists to catch is one more well-meant clause, and an exemption with
       no ceiling is how that comes back through the side door. */
    check("buildCompositePrompt() assembles the panel contract, the selector and the anchor",
      /\[P\.CORE, DENSE\.contract\]/.test(codeBody) &&
      /\[P\.CORE, DENSE\.select\[side\]\]/.test(codeBody) &&
      /CATEGORY_ANCHOR\.bottom : CATEGORY_ANCHOR\.top\]/.test(codeBody),
      codeBody.slice(-300));
    check("...and nothing else - no pose, depth, polish or fidelity clause rides with it",
      !/DENSE\.(pose|poseProfile|lateral|depth|polish|fidelity)/.test(codeBody),
      codeBody.slice(-300));
  }

  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /* Every builder EXCEPT the split-reference one - see the exemption above. */
  const codeNoComposite = codeOnly.replace(/function buildCompositePrompt\([\s\S]*?\n}/, "");
  check("no colour word or subtype noun reaches any prompt",
    !/colorName\(activeColorOf\(/.test(codeOnly) &&
    !/SHIRT_NOUN\[/.test(codeOnly) && !/SUBTYPE_PROMPT\[/.test(codeOnly));
  check("no DENSE clause is assembled by any SINGLE-VIEW builder",
    !/\[P\.(CORE|HIGH|MED|LOW|TRIM),\s*DENSE\./.test(codeNoComposite),
    "the DENSE table is a restore library for every path except the split reference");
  check("the size-override modifier no longer reaches the wire either",
    !/\[P\.\w+,\s*fitSentence\(/.test(codeOnly),
    "documented in IMAGE_ONLY_PROMPT's retirement list - the UI still works, the render ignores it");
}

console.log("\n── §3 THE RETIREMENT IS REVERSIBLE (this mode will need pieces back) ──");
{
  /* A mode this aggressive is a starting point, not an endpoint: it establishes whether
     text volume was the problem, and the answer is only useful if clauses can be added
     back ONE at a time. That requires three things to still exist. */
  check("the assembly machinery survives - fitPrompt() and the priority tiers",
    /function fitPrompt\(parts, max = PROMPT_MAX_CHARS\)/.test(SRC) &&
    /const P = Object\.freeze\(\{ CORE: 0, HIGH: 1, MED: 2, LOW: 3, TRIM: 4 \}\)/.test(SRC));
  check("...the DENSE table survives, with every retired clause verbatim",
    /inpaintLock:\s+"Face, skin, hands and background pass through untouched\."/.test(SRC) &&
    /contract:\s+"The reference image is a split photo of one garment/.test(SRC) &&
    /lookPanels:\s+"The reference stacks two garments/.test(SRC));
  check("...and angleClause() survives, so the orientation clauses stay proven",
    /function angleClause\(item, angleOverride, useComposite, inProfile\)/.test(SRC),
    "side-profile.test.mjs still executes every branch of it");

  /* The restore list itself, ranked. inpaintLock is the largest loss - nothing else
     stands between this prompt and a regenerated face or room - and lookPanels is the
     only one whose absence costs a whole feature rather than a degree of fidelity. */
  check("app.js ranks the losses, naming the passthrough clamp as first to restore",
    /THE LARGEST[\s\S]{0,90}LOSS and the one to restore first/.test(SRC));
  check("...and flags the full-look panel clause as the one that costs a FEATURE",
    /lookPanels is\s*\n?\s*the first clause to buy back/.test(SRC) ||
    /DENSE\.lookPanels is[\s\S]{0,120}first clause to buy back/.test(SRC),
    "buildLookPrompt() must carry that warning - a look has no other layout signal");

  /* The builders keep their parameters so a restore is a two-line edit rather than a
     re-derivation of applyGarment()'s TOCTOU freeze. */
  check("the builders keep their angle/pose parameters as the restore seam",
    /function buildCompositePrompt\(item, angle, inProfile\)/.test(SRC) &&
    /buildCompositePrompt\(item, angleAtStart, profileAtStart\)/.test(SRC),
    "the frozen snapshots must stay threaded even while unused");
}

console.log("\n── §4 THE COMPOSITE STANDS DOWN, and its switch still works ──");
{
  /* Not a prompt change, and the only behavioural one in this mode - so it is asserted
     separately and with its reasoning attached. */
  check("COMPOSITE_DEFAULT is off",
    /const COMPOSITE_DEFAULT = false;/.test(SRC),
    "a split reference with no panel contract is the 23f5953 double-print bug");
  check("...for the stated reason, not silently",
    /THE KILL SWITCH, NOW THROWN/.test(SRC) &&
    /a reference the model has to interpret unaided/.test(SRC));
  check("the URL override still forces it back on for an A/B against a live session",
    /const q = new URLSearchParams\(location\.search\)\.get\("composite"\)/.test(SRC) &&
    /if \(q === "1" \|\| q === "true"\)\s+return true;/.test(SRC));
  check("...and re-enabling is documented as requiring the panel contract back with it",
    /restore\s*\n?\s*DENSE\.contract \+ DENSE\.select in buildCompositePrompt\(\) in the same commit/.test(SRC),
    "the worst of both modes is a split image with no key");
  /* The single-asset path it falls back to is the pre-composite behaviour, still the
     fallback whenever a stitch fails - so this is a switch, not a new code path. */
  check("the per-orientation single-asset path is still what referenceImageFor() falls to",
    /if \(currentAngle === AUTO_ANGLE\) \{\s*\n\s*const blob = await garmentBlobCached\(activeImg\);/.test(SRC));
}

console.log("\n── §5 AN IMAGE ON EVERY UPDATE AND EVERY RETRY ──");
{
  /* An image-only prompt with no image is the same failure through the other door: the
     prompt says "the reference image" and nothing was provided, so the model has only its
     prior. This used to be survivable - the prompt still recited a catalog description,
     so SOMETHING garment-shaped rendered. That safety net is gone by design. */
  const apply = SRC.slice(SRC.indexOf("async function applyGarment(item) {"),
                          SRC.indexOf("\n/**\n * Reads the Screen 1 physical inputs"));
  check("applyGarment sweeps the item's remaining assets when nothing resolved",
    /for \(const candidate of \[g\.front, g\.back, item\.img, item\.composite\]\)/.test(apply));
  check("...and a total failure is an ERROR, not a warning",
    /console\.error\("\[PEAR\] applyGarment\(\) - NO garment asset could be resolved/.test(apply));
  check("...that does not throw the live session away",
    !/throw new Error\("no garment asset/.test(apply),
    "a recoverable session beats a dead one - the next apply gets another attempt");

  /* THE RETRY PROPERTY. applyActive() re-enters applyGarment() on a rejected set(), and
     the wire bookkeeping must not have been written optimistically - otherwise attempt
     two sees its own reference "already on the wire" and retries a failed image upload
     by not uploading the image. */
  const setIdx = apply.indexOf('sendCondition("applyGarment", () => rtClient.set(payload));');
  const stampIdx = apply.indexOf("lastSentImageRef = imageRef || null;");
  check("the wire bookkeeping is stamped only AFTER set() resolves, so a retry re-uploads",
    setIdx !== -1 && stampIdx > setIdx, `set@${setIdx} stamp@${stampIdx}`);

  /* THE NO-OP SKIP, new in this mode. With a frozen prompt, "same image + same prompt" is
     a dispatch that provably changes nothing - which the re-anchor cadence would
     otherwise fire ~8 times a session. Skipping it is right; pretending the re-anchor
     still works would not be, so the code says so. */
  check("a dispatch with nothing new is skipped rather than sent",
    /if \(payload\.prompt === lastSentPrompt\) \{/.test(apply) &&
    /no-op update skipped - reference AND prompt both unchanged/.test(apply));
  check("...and the dead re-anchor is documented, not left to be discovered",
    /THE RE-ANCHOR IS A NO-OP IN THIS MODE/.test(apply),
    "there is nothing left in the prompt to re-assert");
  check("lastSentPrompt is cleared everywhere the image bookkeeping is",
    (SRC.match(/lastSentPrompt = null;/g) || []).length >= 4,
    "a stale 'already sent' belief across a session boundary skips the first real dispatch");

  const look = SRC.slice(SRC.indexOf("async function applyLook(top, bottom) {"),
                         SRC.indexOf("function buildLookPrompt"));
  /* `image: null` is NOT the same as no image key: it is an explicit empty value on a key
     the SDK validates, and in a payload log it looks like a reference was delivered. */
  check("applyLook omits the image key rather than sending image: null",
    !/image: primaryImage,/.test(look) &&
    /\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/.test(look));
  check("...on the minimal-retry path too, not just the enriched payload",
    (look.match(/\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/g) || []).length === 2);
  check("applyLook falls back to a raw garment ref before giving up",
    /garmentImageRef\(topImg\) \|\| garmentImageRef\(bottomImg\)/.test(look));

  check("verifyGarmentAsset still inspects the payload at both full-set sites",
    (SRC.match(/verifyGarmentAsset\(payload, "(applyGarment|applyLook)"\)/g) || []).length === 2);
  check("...and still says what a payload with no image will actually do",
    /Decart has no pixel reference and will render its default\/generic output/.test(SRC));
}

console.log("\n── §6 A FREEZE MUST NOT RESUME UNCONDITIONED ──");
{
  /* THE FAILURE: the feed stalls for a beat and comes back - dressed in the wrong thing.
     Two different things can be wrong when frames stop (a stalled <video>, or a transport
     rebuilt under us so Decart is generating from the SDK's replayed initial state), and
     only the first is fixed by a nudge. The second is invisible from the outside: the
     picture returns, every existing signal in the file reports success, and the garment
     is whatever was live at the original go-live moment.

     This is asserted HERE rather than in a stream suite because it is the same invariant
     the rest of this file is about, arriving through the transport instead of the text: a
     prompt that says "the reference image" and no reference on the wire. */
  const watcher = SRC.slice(SRC.indexOf("function createFrameFreezeWatcher(video, gen)"),
                            SRC.indexOf("function startFrameFreezeWatch"));
  check("the freeze threshold is the specified 800ms",
    /const FRAME_FREEZE_MS = 800;/.test(SRC));
  check("...checked often enough to catch it near its START, not its end",
    /const FRAME_FREEZE_POLL_MS = 250;/.test(SRC));
  /* THE PRIMARY FIX IS NOT HERE. A receiver with no jitter buffer stalls on any transient
     bitrate shift - this file's own stats-monitor comment named it years before the
     report ("High jitter + playoutDelayHint:0 = visible stutter"). The watchdog catches
     what still slips through; the buffer is what stops most of them happening. */
  check("the receiver is given a real jitter buffer, not zero",
    /PLAYOUT_DELAY_HINT: 0\.0[5-9]|PLAYOUT_DELAY_HINT: 0\.1[0-5]/.test(CFG),
    "0 means render-ASAP with nothing in reserve - the stall the report describes");
  check("...applied through BOTH the legacy and the standard API, from one number",
    /r\.playoutDelayHint = PLAYOUT_DELAY_HINT;/.test(SRC) &&
    /r\.jitterBufferTarget = PLAYOUT_DELAY_HINT \* 1000;/.test(SRC),
    "support is split; setting one lets a browser upgrade silently change buffering");
  check("frames are detected via rVFC, with a currentTime fallback where it is missing",
    /video\.requestVideoFrameCallback\(onFrame\)/.test(watcher) &&
    /if \(!hasRVFC\) \{[\s\S]{0,160}video\.currentTime/.test(watcher),
    "rVFC stops firing exactly when the stream stops - that IS the signal");
  check("the watchdog reads no pixels - it must stay cheap enough to poll",
    !/sampleVideoLuma/.test(watcher),
    "a canvas readback every 500ms would cost more than the stall it detects");

  /* THE THREE FALSE-POSITIVE GUARDS. Each of these legitimately stops frame decoding, and
     "recovering" any of them would fire a set() that is at best wasted and at worst
     throws (the SDK's assertConnected rejects every send while reconnecting). */
  check("it stands down when not live, on a hidden tab, and during an SDK reconnect",
    /if \(!isLive\(\) \|\| connState === "reconnecting" \|\|/.test(watcher) &&
    /document\.hidden/.test(watcher));
  check("...and re-stamps the clock rather than returning, so the outage is not one freeze",
    /lastFrameAt = Date\.now\(\);\s*\n\s*frozenSince = null;\s*\n\s*return;/.test(watcher),
    "otherwise the tab coming back reads as a multi-second stall");

  /* STAGED RECOVERY, CHEAPEST FIRST: element ping, then an SDK keep-alive that sends no
     image, then the full re-anchor. Ordering by cost is what lets the threshold sit at
     800ms - the first two are safe to fire during a stall that may resolve on its own,
     because neither adds meaningful traffic to a transport already struggling. */
  check("stage 1a is a frame ping on the element itself",
    /if \(video\.paused \|\| video\.readyState < 2\)[\s\S]{0,120}video\.play\(\)/.test(watcher));
  check("stage 1b is an SDK keep-alive that carries NO image and no teardown",
    /rtClient\.setPrompt\(keepAlive, \{ enhance: false \}\)/.test(watcher) &&
    !/rtClient\.set\(/.test(watcher),
    "setPrompt takes sendPrompt(), which never touches the image");
  /* ...and it SKIPS rather than queues when the wire is busy. This ping exists to poke a
     session that appears to be doing nothing, so a write already in flight is itself the
     evidence that the poke is unnecessary - and queueing a liveness nudge behind a stalled
     write is how a recovery mechanism becomes part of the stall. */
  check("...and it is skipped, not queued, while another write holds the wire",
    /sendCondition\("freezeKeepAlive",[\s\S]{0,160}\{ skipIfBusy: true \}\)/.test(watcher),
    watcher.slice(watcher.indexOf("STAGE 1b"), watcher.indexOf("STAGE 1b") + 900));
  check("...rate-limited separately from the re-anchor, and cheaply",
    /const FRAME_FREEZE_PING_MS = 600;/.test(SRC) &&
    /Date\.now\(\) - lastPingAt >= FRAME_FREEZE_PING_MS/.test(watcher));
  check("...and a failed ping is swallowed, never surfaced as an error UI",
    /catch \(e\) \{\s*\n\s*console\.warn\("\[PEAR\] freeze keep-alive ping failed/.test(watcher),
    "a freeze must be absorbed, not shown to the shopper");
  check("stage 2 forces the garment back onto the wire, not merely a prompt nudge",
    /invalidateWireState\(`frame freeze/.test(watcher) && /await applyActive\(\)/.test(watcher),
    "a frozen prompt + memoized blob would otherwise match on both halves and skip");
  check("...rate-limited on its OWN clock, so a long freeze is not a re-upload storm",
    /const FRAME_FREEZE_RECOVER_COOLDOWN_MS = 2500;/.test(SRC) &&
    /Date\.now\(\) - lastRecoverAt < FRAME_FREEZE_RECOVER_COOLDOWN_MS/.test(watcher));
  check("...and never runs before the first garment was acknowledged",
    /if \(!isGarmentApplied\) return;/.test(watcher),
    "go-live's own apply still owns the wire until then");
  check("re-anchoring verifies it landed on the same asset Decart last acknowledged",
    /const before = lastAckedImageRef;/.test(watcher) &&
    /lastAckedImageRef !== before/.test(watcher));

  /* THE RECONNECT GUARD - the same fix at the other entry point. An SDK-internal
     reconnect never re-enters connectRealtime(), so this file's wire bookkeeping sails
     through a rebuilt transport still claiming the blob is on it. */
  const opts = SRC.slice(SRC.indexOf("function buildRealtimeConnectOpts(gen)"),
                         SRC.indexOf("async function connectRealtime"));
  check("a post-reconnect re-apply invalidates the wire state FIRST",
    /invalidateWireState\("SDK reconnect[\s\S]{0,200}applyActive\(\)/.test(opts),
    "without it the re-apply matches on both halves and dispatches nothing");
  const invalidate = (SRC.match(/function invalidateWireState\(why\) \{[\s\S]*?\n\}/) || [""])[0];
  check("invalidateWireState clears all three wire flags",
    /lastSentImageRef = null;/.test(invalidate) && /rtImageOnWire = false;/.test(invalidate) &&
    /lastSentPrompt = null;/.test(invalidate), invalidate);
  check("...and preserves the last ACKNOWLEDGED reference, which a recovery re-anchors to",
    !/lastAckedImageRef\s*=/.test(invalidate),
    "it is a statement about the connection, not about what Decart last accepted");
  check("...and touches neither billing, the recorder nor isGarmentApplied",
    !/isGarmentApplied|billingStarted|stopRecording|dressedFrameReady/.test(invalidate),
    "conflating the two re-arms the reveal on a session that never stopped");

  /* NO TEARDOWN AND NO ERROR UI AT ANY STAGE - a freeze is a transient the app absorbs.
     A session torn down or a banner shown mid-window is strictly worse than a stream that
     stutters once and continues, and the watchdog is the one component with both the
     motive and the reach to do it. */
  check("recovery never tears the session down or shows the shopper an error",
    !/stopLive\(\)|teardown\(\)|toast\(/.test(watcher),
    "the only visible trace of a recovery is in the console");

  /* Lifecycle: it can fire applyActive(), so it must never outlive the session. */
  check("armed on the remote stream, so a warm-up stall is covered too",
    /startFrameFreezeWatch\(aiVideo, gen\)/.test(SRC));
  check("...and retired in teardown(), the path every exit eventually reaches",
    /stopFrameFreezeWatch\(\);/.test(SRC.slice(SRC.indexOf("function teardown()"),
                                               SRC.indexOf("function teardown()") + 2600)));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
