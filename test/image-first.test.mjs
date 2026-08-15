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
const TOPS_SPEC =
  "Fit and replace ONLY the subject's upper garment (shirt/top) using the exact upper" +
  " garment from the reference image. Strictly preserve the subject's live pants/lower" +
  " garment as seen on camera." +
  " Continuously track and strictly fit the reference top to the subject's torso as soon" +
  " as visible. Keep lower body and background natural and unmodified." +
  " Maintain the exact same abdomen/stomach depth, waist" +
  " volume, and torso thickness continuously through all 360-degree rotations\u2014never" +
  " flatten or reset body size mid-stream. Preserve a closed back and" +
  " normal un-knotted hem. Use only the reference image's graphics, fabric texture," +
  " and color.";
const BOTTOMS_SPEC =
  "Fit and replace ONLY the subject's lower garment (pants/shorts) using the exact" +
  " shorts/pants shown in the reference image. Strictly keep and preserve the subject's" +
  " live shirt/upper garment completely unchanged." +
  " Continuously track and strictly fit the reference shorts/pants to the subject's lower" +
  " body as soon as visible. Keep upper body and background natural and unmodified." +
  " Maintain the exact same abdomen/stomach depth, waist" +
  " volume, and torso thickness continuously through all 360-degree rotations\u2014never" +
  " flatten or reset body size mid-stream." +
  " Use only the reference image's graphics, fabric texture," +
  " and color.";
/* \u00a71's shared-tail assertions read this; the tail is identical in both branches except
   for the two top-specific construction clauses, which \u00a71 checks per branch. */
const SPEC = TOPS_SPEC;

console.log("── §1 THE FROZEN STRING: product-specified, and genuinely constant ──");
{
  /* Byte-exact, because the wording is a product decision rather than an implementation
     detail - a paraphrase that reads the same to a human is a different token sequence to
     a diffusion model, and this is the one string in the file whose exact form was
     specified from outside it. */
  check("the TOPS branch matches the specified wording byte for byte",
    api.imageOnlyPrompt(TEE) === TOPS_SPEC, JSON.stringify(api.imageOnlyPrompt(TEE)));
  check("the BOTTOMS branch matches the specified wording byte for byte",
    api.imageOnlyPrompt(JEANS) === BOTTOMS_SPEC, JSON.stringify(api.imageOnlyPrompt(JEANS)));

  /* THREE SENTENCES, THREE JOBS, each one a clause that used to be separate and
     shed-able. Asserted individually because the failure mode of a frozen string is a
     well-meant reword that quietly drops one - and there is no fitPrompt() shed log to
     notice it any more, because there is no assembly left to log. */
  /* SENTENCE ORDER IS PART OF THE SPEC, not incidental, and it has moved twice. Revision 3
     led with EXTRACTION, on the reasoning that a reference read as a photograph of a
     dressed person gets its geometry deformed rather than discarded. Revision 4 leads with
     STRUCTURE instead - "a standard, continuous t-shirt" - because the knot and the
     open-back flap are failures of CONSTRUCTION, and no amount of correct material
     provenance forecloses them. The reference is still bound in the first clause ("from
     the reference image"), so the asset anchor did not move; only the isolation half did.
     Both facts are pinned so a reorder is a deliberate act. */
  /* REVISION 5 CHANGES WHAT THE LEAD SENTENCE IS FOR. Revisions 3 and 4 argued over
     EXTRACTION-first vs STRUCTURE-first; both assumed one anchor served every garment.
     The lead now states REGION - which layer is being replaced and which is being kept -
     because a prompt that names the wrong layer cannot be rescued by anything after it.
     Structure and extraction both still ship; they just no longer lead. */
  check("(1) TOPS leads by naming the REGION it replaces and the one it preserves",
    TOPS_SPEC.indexOf("Fit and replace ONLY the subject's upper garment") === 0 &&
    /Strictly preserve the subject's live pants\/lower garment as seen on camera/.test(TOPS_SPEC),
    "naming the wrong layer is unrecoverable by any later clause");
  check("(1) BOTTOMS leads the same way, mirrored - the fix for the reported bug",
    BOTTOMS_SPEC.indexOf("Fit and replace ONLY the subject's lower garment (pants/shorts)") === 0 &&
    /Strictly keep and preserve the subject's live shirt\/upper garment completely unchanged/.test(BOTTOMS_SPEC));
  check("...and the reference is still bound in that same first sentence, both branches",
    /^Fit and replace ONLY the subject's upper garment \(shirt\/top\) using the exact upper garment from the reference image/.test(TOPS_SPEC) &&
    /^Fit and replace ONLY the subject's lower garment \(pants\/shorts\) using the exact shorts\/pants shown in the reference image/.test(BOTTOMS_SPEC),
    "the asset anchor must not depend on the extraction sentence that trails");
  /* THE BOTTOMS ANCHOR NAMES THE TARGET TWICE - "lower garment (pants/shorts)" and then
     "the exact shorts/pants shown in the reference image". That is deliberate rather than
     redundant: the second half is what points at WHICH REGION OF THE REFERENCE to read,
     on an image that almost always photographs a model wearing a shirt as well. */
  check("...and BOTTOMS names the garment again as the thing to read OUT of the reference",
    /using the exact shorts\/pants shown in the reference image/.test(BOTTOMS_SPEC),
    "the model wearing the product is packaging, not content");
  /* (2) PERSISTENCE. Three quantities named individually because "volume" alone is
     satisfiable by any one of them, and the transition named explicitly because the
     reported failure is progressive - volume present at the start of a turn, gone by the
     end - rather than static. */
  check("(2) it names the three quantities that must not change, not just 'volume'",
    /the exact same abdomen\/stomach depth, waist volume, and torso thickness/.test(SPEC),
    "one word is satisfiable by any one of the three");
  check("...and the transition they must survive, because the failure is progressive",
    /continuously through all 360-degree rotations/.test(SPEC) &&
    /never flatten or reset body size mid-stream/.test(SPEC));
  /* THE HONEST LIMIT, pinned in the test so nobody escalates the wording believing it is
     a state lock. Lucy regenerates every frame independently - no cross-frame state, no
     seed, no motion-guidance parameter in the SDK. This is a per-frame BIAS and cannot be
     made into a filter from here; if volume still decays mid-turn the answer is better
     evidence on the weak frames (a pipeline change), not stronger language. */
  check("...and app.js records that this is a per-frame bias, NOT a state lock",
    /NO PROMPT CAN CREATE PERSISTENCE THIS PIPELINE DOES NOT HAVE/.test(SRC),
    "escalating this sentence cannot work - the limit is architectural");

  /* (3) THE HEAD-ON GAP. Depth, contour and silhouette are all PROFILE-visible
     quantities: head-on the stomach projects toward the camera, along the axis with no
     extent in a 2D frame, so every previous revision's volume language simply did not
     apply and the model sized off shoulder width. These three cues are what frontal
     volume looks like in 2D, and the only ones available at 0 degrees. */
  /* ── (3) THE HEAD-ON CLAUSE NOW SHEDS ON TOPS. RECORDED, NOT GLOSSED ──────────
     This is the one substantive cost of the category branch and it is asserted as a
     LOSS so it cannot be discovered in a live session instead.

     THE ARITHMETIC: the tops branch assembles to 702 characters against a hard 650
     budget (app.js:5862 - "the ceiling is the API's, not ours"), so fitPrompt() sheds
     its worst-priority part. FRONTAL_VOLUME is tagged P.MED and is the largest single
     clause at 177 characters, so it goes and the prompt lands at 524.

     WHY THIS IS THE RIGHT CLAUSE TO LOSE, given something had to go: it is a refinement
     of a bias the surviving P.HIGH clause already asserts in general terms
     ("abdomen/stomach depth, waist volume, torso thickness ... never flatten"), whereas
     the anchor and the extraction clause are each the sole carrier of their guarantee.

     THE ONE-LINE RESTORE, if head-on volume regresses: the tops anchor's third sentence
     ("Do NOT replace or alter the subject's lower clothing.", 53 chars) restates what its
     second sentence already says. Dropping it frees 53 and FRONTAL_VOLUME returns on its
     own - fitPrompt() re-includes it the moment it fits, with no other edit. That trade
     is deliberately NOT made here: the anchor wording is a product decision. */
  check("(3) the frontal-volume clause is SHED on tops, and the budget explains why",
    !/In front-facing \(0-degree\) views/.test(TOPS_SPEC) && TOPS_SPEC.length <= 650,
    `tops = ${TOPS_SPEC.length} chars; unshed it would be 702 against a 650 ceiling`);
  check("...and app.js records the shed as a choice, with the restore path",
    /FRONTAL_VOLUME \(P\.MED\) drops first on tops/.test(SRC),
    "a silent shed is the failure mode this repo exists to make visible");
  check("...while the GENERAL volume guarantee survives in both branches, unshed",
    /abdomen\/stomach depth, waist volume, and torso thickness/.test(TOPS_SPEC) &&
    /abdomen\/stomach depth, waist volume, and torso thickness/.test(BOTTOMS_SPEC),
    "the P.HIGH clause is the one that must never shed");
  /* Bottoms never carried the frontal clause at all - it describes a shirt draping over a
     stomach, which is not what a trouser render is about. Its absence there is by design,
     not budget, and the two must not be confused by a future reader. */
  /* Asserted STRUCTURALLY rather than by measuring headroom. Both clauses describe a
     SHIRT's construction - a stomach draping under a hem, an open back flap - so the
     bottoms branch never assembles them at all; the source says `bottoms ? "" : ...`,
     which is the design decision itself rather than a consequence of the budget. The
     headroom that used to make this visible was spent on the temporal directive, so
     measuring it would now test the wrong thing. */
  check("...and BOTTOMS omits it BY DESIGN, not by shedding - it never applied",
    !/In front-facing \(0-degree\) views/.test(BOTTOMS_SPEC) &&
    /\[P\.MED,\s*bottoms \? "" : FRONTAL_VOLUME\]/.test(SRC) &&
    /\[P\.MED,\s*bottoms \? "" : CLOSED_BACK_HEM\]/.test(SRC),
    "both clauses are shirt-construction language; the bottoms branch never assembles them");
  /* (4) THE STRUCTURAL BOUNDARY - the positive half of revision 4's rule, now standing
     alone. Its four-artifact enumeration ("do NOT generate front knots, tied fabric, open
     slits, or floating back flaps") is gone, which is exactly the step revision 4's own
     risk note prescribed if the named negatives proved counterproductive. It works alone
     because it was deliberately written to lead that enumeration rather than depend on it. */
  check("(4) the structural boundary survives, and states the correct shape on its own",
    /Preserve a closed back and normal un-knotted hem/.test(SPEC));
  check("...with the artifact enumeration retired, as revision 4's risk note prescribed",
    !/do NOT generate front knots/.test(SPEC) && !/open slits/.test(SPEC),
    "a knot is more object-like than a stretch or a float - the list was the risk");

  /* THE KNOWING RISK OF THIS REVISION, asserted so it stays visible: drape-and-hem
     vocabulary is BACK, scoped to the frontal case. Revision 4 removed it because it is
     also how a designer describes a knotted or gathered hem, and that produced the knot.
     It returns because frontal convexity cannot be described without it. What makes it
     less exposed: it is scoped to front-facing views rather than stated as a general goal,
     and the structural boundary follows immediately after. */
  /* The scoping check moves to the SOURCE rather than the shipped string: FRONTAL_VOLUME
     sheds on tops, so the assembled prompt can no longer demonstrate the ordering. What
     the ordering protected still matters the moment the clause is restored (see the
     one-line restore above), so it is pinned where the clause actually lives. */
  check("the drape/hem language stays SCOPED to the frontal case in FRONTAL_VOLUME itself",
    /const FRONTAL_VOLUME =\s*\n?\s*"In front-facing \(0-degree\) views[\s\S]{0,200}?natural fabric drape/.test(SRC),
    "unscoped drape language is what produced the front knot in revision 3");
  check("...and no tension/gathering vocabulary came back with it",
    !/tension lines/.test(SPEC) && !/gather/i.test(SPEC));

  check("(5) the extraction directive closes it, reduced to its positive half",
    /Use only the reference image's graphics, fabric texture, and color\.$/.test(SPEC));
  /* RECORDED AS A LOSS, not glossed: revision 3 said "completely ignoring the original
     model's body size, chest, and waist dimensions" outright. "Preserve ONLY ..." implies
     it by exhaustion but never states it, which is a weaker instrument against the "it gave
     me the e-commerce model's shoulders" report. DENSE.modelAgnostic is still on file and
     appending it is a one-line edit - it is the first thing to restore if that returns. */
  check("...so the explicit body-discard is no longer on the wire - a known trade",
    !/ignoring the original model's body/.test(SPEC) &&
    /modelAgnostic:\s+"Ignore the reference model's body/.test(SRC),
    "implied by exhaustion, not stated - and DENSE.modelAgnostic is the one-line restore");

  /* BOTH SILHOUETTE AXES ARE NAMED, and this is the assertion the abdomen report earned.
     Head-on a body's outline is its WIDTH; edge-on, width foreshortens to nearly nothing
     and the entire outline is DEPTH. A clause naming only one leaves the other undefended
     at exactly the angle where it is the whole silhouette - which is the gap the retired
     SIDE_PROFILE_DEPTH was written against, and the reason "waistline" is named alongside
     the generic contour language. */
  check("...naming the stomach specifically, not a generic contour",
    /abdomen\/stomach depth/.test(TOPS_SPEC) && /abdomen\/stomach depth/.test(BOTTOMS_SPEC) &&
    /const FRONTAL_VOLUME =[\s\S]{0,160}the stomach's forward volume/.test(SRC),
    "the stomach is the region every report has actually been about");

  /* NOT POSE-GATED, and that is the substantive win over the clause it replaces.
     DENSE.profileLateral rode behind an `inProfile` ternary and shed edge-on under budget
     pressure - so the 90-degree frame, the one case it existed for, was the case most
     likely to lose it. "at all angles" needs no flag and cannot shed. */
  /* MORE THAN A CONVENIENCE NOW. The orientation watcher no longer dispatches anything on
     a profile transition - its hold and its prompt update were both retired when the
     90-degree freeze was traced to them - so a directive that needed a pose flag to arrive
     would simply never arrive. Stating it unconditionally is the only way it holds at 90
     degrees at all. */
  check("...and every angle is covered unconditionally, since no pose event delivers it",
    /all 360-degree rotations/.test(SPEC) && !/EDGE-ON/.test(SPEC),
    "no pose flag switches this on, and the watcher would not fire one if there were");

  /* THE NOUN LIST IS GONE ENTIRELY, and its absence is the assertion. Three versions of
     this prompt named the garment they were trying to prevent - assetLock enumerated six,
     the first frozen string kept two - and the tuxedo outlived all of them. With no
     negative_prompt field, a banned noun ships in the POSITIVE prompt where the sampler
     can steer toward it: at best neutral, plausibly the cause. What guards the
     substitution now is positive and unnamed, stated twice.
     If invented garments return, DO NOT re-add the list - that move has been tried. */
  check("no banned-garment noun ships at all",
    !/tuxedos?|suits?|jackets?|coats?|bowties?|badges?/i.test(SPEC),
    "naming the garment is what three earlier versions already tried");
  check("...the substitution is guarded positively instead - by what may be taken, not what may not",
    /Use only the reference image's graphics, fabric texture, and color/.test(SPEC),
    "an exhaustive list of what to take leaves nothing for an invented garment to be");

  /* CONSTANT, not merely short. A template literal here is how a description creeps back
     in one field at a time, which is the exact history this mode is reacting to. */
  check("declared with no interpolation hole",
    /const CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(SRC) &&
    !/CATEGORY_ANCHOR = Object\.freeze\(\{[\s\S]{0,900}?\$\{/.test(SRC),
    "no ${...} anywhere in or adjacent to the declaration");
  /* The resolver picks between two frozen literals; it must never BUILD one. A template
     hole in either anchor is how a colour word or a subtype noun gets back on the wire. */
  check("...and the resolver only SELECTS an anchor, never interpolates one",
    /bottoms \? CATEGORY_ANCHOR\.bottom : CATEGORY_ANCHOR\.top/.test(SRC) &&
    !/CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(SRC),
    "appending one clause is how the dozen came back last time");

  /* It has to survive the wire guard untouched: clampPromptForWire() truncates anything
     over budget, and a frozen prompt that gets clipped is no longer the spec'd string. */
  check("it is comfortably inside the 226-token ceiling, so the wire guard never clips it",
    SPEC.length <= 650, `${SPEC.length} chars (~${Math.ceil(SPEC.length / 4)} tokens)`);
}

console.log("\n── §2 EVERY BUILDER RETURNS IT, AND ASSEMBLES NOTHING ──");
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
  for (const [name, item, angle, prof] of cases) {
    const expected = item.garmentType === "lower_body" ? BOTTOMS_SPEC : TOPS_SPEC;
    check(`${name}: byte-identical to its category anchor`,
      api.buildCompositePrompt(item, angle, prof) === expected,
      api.buildCompositePrompt(item, angle, prof));
  }
  /* THE AXIS ITSELF, asserted once: category is the ONLY thing that moves the prompt. */
  check("the two branches are genuinely different, and category is the only axis",
    TOPS_SPEC !== BOTTOMS_SPEC &&
    api.buildCompositePrompt(TEE, "front", false) === api.buildCompositePrompt(TEE, "back", true) &&
    api.buildCompositePrompt(JEANS, "front", false) === api.buildCompositePrompt(JEANS, "back", true));

  /* Structural, across the builders this sandbox cannot execute. The four together are
     every path that can reach rtClient.set() with a prompt. */
  const builders = [
    ["buildPrompt", /function buildPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildCustomPrompt", /function buildCustomPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildLookPrompt", /function buildLookPrompt\(top, bottom, angleText[\s\S]*?\n}/],
    ["buildCompositePrompt", /function buildCompositePrompt\(item, angle, inProfile\)[\s\S]*?\n}/],
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
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no colour word or subtype noun reaches any prompt",
    !/colorName\(activeColorOf\(/.test(codeOnly) &&
    !/SHIRT_NOUN\[/.test(codeOnly) && !/SUBTYPE_PROMPT\[/.test(codeOnly));
  check("no DENSE clause is assembled by any builder",
    !/\[P\.(CORE|HIGH|MED|LOW|TRIM),\s*DENSE\./.test(codeOnly),
    "the DENSE table is a restore library now, not an assembly source");
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
  const setIdx = apply.indexOf("await rtClient.set(payload);");
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
    /await rtClient\.setPrompt\(keepAlive, \{ enhance: false \}\)/.test(watcher) &&
    !/rtClient\.set\(/.test(watcher),
    "setPrompt takes sendPrompt(), which never touches the image");
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
