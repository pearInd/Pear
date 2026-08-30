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

/* A top that is NOT a plain knit tee, and that matters now: imageOnlyPrompt() gained a
   CONSTRUCTION axis, so a fixture named "Tee" would take the tee branch and these
   assertions - which own the DEFAULT tops anchor plus its closure clause - would silently
   stop describing the string they were written for. The tee branch has its own byte-exact
   assertion below, and its own suite in plain-tee-fidelity.test.mjs. */
const TOP       = { name: "Oxford Button-Down Shirt", garmentType: "upper_body", color: "#fff", subType: "long_sleeve" };
const PLAIN_TEE = { name: "Ion Crew Tee",   garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };
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
                         STATIC, the body is CURRENT and per-frame (342 chars tops, 320
                         bottoms). The prompt is only half the fix - the other half is the
                         topology monitor in app.js, which is what makes a re-conditioning
                         dispatch happen at all; body-topology.test.mjs owns that side.
   See CATEGORY_ANCHOR in app.js for the full list of what came off the wire, what went
   back on, and the restore path for each. */
const TOPS_SPEC =
  "Drape and fit the EXACT static shirt from the reference image onto the live" +
  " subject's CURRENT body contour and volume in this frame. Dynamically adapt the" +
  " garment drape to the subject's exact silhouette, angle, depth, and belly volume" +
  " without stretching or warping the fabric. Strictly preserve the original shirt" +
  " texture, pattern, and color.";
const BOTTOMS_SPEC =
  "Drape and fit the EXACT static pants/shorts from the reference image onto the live" +
  " subject's CURRENT lower-body contour and volume in this frame. Dynamically adapt" +
  " the fit to the subject's exact waistline, leg profile, depth, and angle without" +
  " distorting the garment design. Strictly preserve original pattern and color.";
/* THE BACK COUNTERPARTS. The prompt is no longer byte-identical across ANGLE - and that is
   a deliberate reversal of what this suite used to pin, made once the orientation-blind
   render was reported: buildPrompt() and buildCompositePrompt() both took the frozen angle
   and discarded it, so a shopper turning around got the FRONT anchor and, with it, the
   chest print reproduced on their back.

   THE INVARIANT THIS SUITE ACTUALLY DEFENDS IS UNCHANGED, because it was never "one string
   for every case" for its own sake - it was TOTAL TEXT VOLUME competing with the reference
   image (see this file's header: FIX ONE kept the structural clauses and the tuxedo
   survived it). Selecting between two frozen anchors holds volume flat; exactly one anchor
   still ships, and \u00a71 asserts the back pair is frozen, hole-free and inside the same
   ceiling as the front pair. What would re-open the tuxedo is APPENDING a clause, and that
   is asserted absent for the back anchors too. */
const BACK_TOPS_SPEC =
  "Drape and fit the EXACT static shirt's REAR/BACK side from the reference image onto" +
  " the live subject's CURRENT back contour and volume in this frame. Precisely lock the" +
  " rear print, logos, and back seams. Dynamically adapt the garment drape to the" +
  " subject's exact silhouette, angle, depth, and back volume without stretching or" +
  " warping the fabric. Strictly preserve the original shirt texture, pattern, and color.";
const BACK_BOTTOMS_SPEC =
  "Drape and fit the EXACT static pants/shorts REAR/BACK side from the reference image" +
  " onto the live subject's CURRENT lower-body contour and volume in this frame." +
  " Precisely lock the rear print, logos, and back seams. Dynamically adapt the fit to" +
  " the subject's exact waistline, leg profile, depth, and angle without distorting the" +
  " garment design. Strictly preserve original pattern and color.";

/* THE ONE BOUGHT-BACK CLAUSE. Reported: a closed button-down rendered hanging open,
   exposing the shopper's chest - the invented-detail class (right garment, wrong state),
   which the anchor's restore note names as the class a clause may be spent on. Bought back
   per the procedure that note prescribes: ONE part, at P.HIGH so fitPrompt() sheds it
   before the anchor, tops + front only (a front placket is not in view from behind, and a
   closure is not a lower-body feature).

   IT IS STATED POSITIVELY ON PURPOSE. "Do not render open or unbuttoned" is the shape that
   produced the tuxedo: set() has no negative_prompt, so a negation ships inside the
   POSITIVE prompt where "open" and "unbuttoned" are tokens the sampler can steer toward -
   exactly how DENSE.assetLock failed when it enumerated "TUXEDO, BOWTIE". \u00a72 scans for
   those tokens and fails if any appear.

   IT IS ALSO PRODUCT-NEUTRAL, so it opens no third axis: it never claims this garment HAS
   buttons. On a tee there is no closure and it asks for nothing; on a button-down it pins
   the fastening. Wording it per-product would need a has-buttons axis, and the prompt is
   still a function of (category, angle) and nothing else. */
const CLOSURE_SPEC =
  "Reproduce the reference's front closure exactly: any buttons, zip or placket stay" +
  " fully fastened, sitting flat and closed across the chest as shown.";
/* What the tops+front branch actually ships: anchor, one space (fitPrompt's join), clause. */
const TOPS_FRONT_SPEC = TOPS_SPEC + " " + CLOSURE_SPEC;

/* ── THE PLAIN-TEE ANCHOR - the third axis, and the correction to the note above ──
   The comment on CLOSURE_SPEC calls it product-neutral: "on a tee there is no closure and
   it asks for nothing." That was wrong, and the report is the proof - a plain white
   crewneck rendered as a short-sleeve button-down with a pointed collar and a breast
   pocket. set() has no negative_prompt, so "buttons", "zip" and "placket" ship in the
   POSITIVE prompt, and on a tee they were the only construction words on the wire; the
   model rendered a garment that had them. The collar and pocket came with the concept,
   the way the tuxedo arrived wearing a bowtie.

   THE FIX IS A SELECTOR, NOT A CLAUSE, which is the only reason it belongs in this suite's
   world-view: a tee resolves to its own frozen anchor and the closure clause is not spent
   on it. Volume goes DOWN. A negation - "do NOT render buttons, collars, plackets" - is
   the DENSE.assetLock shape this file's header is the record of, and §1 checks that no such
   token rides here either. Byte-exact for the same reason the other three are: a paraphrase
   that reads the same to a human is a different token sequence to a diffusion model. */
const PLAIN_TEE_SPEC =
  "Drape and fit the EXACT static t-shirt from the reference image onto the live" +
  " subject's CURRENT body contour and volume in this frame. Keep the reference's plain" +
  " knit neckline and smooth unbroken front exactly as shown. Dynamically adapt the" +
  " garment drape to the subject's exact silhouette, angle, depth, and belly volume" +
  " without stretching or warping the fabric. Strictly preserve the original t-shirt" +
  " texture, pattern, and color.";

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
    api.imageOnlyPrompt(TOP) === TOPS_FRONT_SPEC, JSON.stringify(api.imageOnlyPrompt(TOP)));
  check("...and its anchor is still the front anchor, unaltered, with the clause appended whole",
    api.imageOnlyPrompt(TOP).startsWith(TOPS_SPEC + " ") &&
    api.imageOnlyPrompt(TOP).endsWith(CLOSURE_SPEC),
    "the clause must ride BESIDE the anchor, never be woven into it");
  check("no negative token rides with it - the tuxedo shipped through a positive prompt",
    !/\b(open|unbuttoned|undone|parted|exposed|never|avoid|don't|do not)\b/i.test(CLOSURE_SPEC),
    CLOSURE_SPEC);
  /* THE THIRD AXIS, held to every rule the other two are held to. */
  check("a plain knit tee matches its own specified wording byte for byte",
    api.imageOnlyPrompt(PLAIN_TEE) === PLAIN_TEE_SPEC, JSON.stringify(api.imageOnlyPrompt(PLAIN_TEE)));
  check("...and the closure clause is NOT spent on it - the reported cause, removed",
    !api.imageOnlyPrompt(PLAIN_TEE).includes(CLOSURE_SPEC) &&
    !/\b(button|buttons|zip|placket|collar|pocket)\b/i.test(api.imageOnlyPrompt(PLAIN_TEE)),
    "four construction tokens with no garment to attach to is how the placket got summoned");
  check("...and it was not replaced by a negation, which is the shape that made the tuxedo",
    !/\b(never|avoid|don't|do not|without buttons|no buttons)\b/i.test(PLAIN_TEE_SPEC),
    PLAIN_TEE_SPEC);
  /* The direction matters more than the ceiling. Every report in this file's header shares
     one mechanism - text volume competing with the reference image - so a fidelity fix that
     GREW the prompt would be that mechanism, reapplied. */
  check("...and it SHRINKS the wire: a tee now ships less text than the default branch",
    PLAIN_TEE_SPEC.length < TOPS_FRONT_SPEC.length,
    `tee=${PLAIN_TEE_SPEC.length} default=${TOPS_FRONT_SPEC.length}`);
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
  check("both branches are exactly three sentences: bind, adapt, preserve",
    sentences(TOPS_SPEC).length === 3 && sentences(BOTTOMS_SPEC).length === 3,
    `tops=${sentences(TOPS_SPEC).length} bottoms=${sentences(BOTTOMS_SPEC).length}`);
  check("...and both open on the SAME five words - the static/reference binding",
    TOPS_SPEC.startsWith("Drape and fit the EXACT static ") &&
    BOTTOMS_SPEC.startsWith("Drape and fit the EXACT static "),
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
  const LEAD = /^Drape and fit the EXACT static (shirt|pants\/shorts) from the reference image onto the live subject's CURRENT (body|lower-body) contour and volume in this frame\./;
  check("(1) it binds the STATIC garment to the reference and the fit to THIS frame",
    LEAD.test(TOPS_SPEC) && LEAD.test(BOTTOMS_SPEC),
    "a prompt with no tense gives the model no reason to re-read the body");
  check("...and each branch names the contour for the region it dresses",
    /CURRENT body contour/.test(TOPS_SPEC) && /CURRENT lower-body contour/.test(BOTTOMS_SPEC),
    "a lower-body garment fitted to 'the body contour' is report 1 through the new wording");
  /* (2) THE ADAPTATION, which is the sentence the stretched-garment report exists for. It
     must instruct a re-drape AND name the two ways of faking one, because "adapt to the
     silhouette" is satisfiable by warping - that is precisely what was happening. */
  check("(2) it demands a DYNAMIC adaptation to the live silhouette, angle and depth",
    /Dynamically adapt the (garment drape|fit) to the subject's exact/.test(TOPS_SPEC) &&
    /Dynamically adapt the (garment drape|fit) to the subject's exact/.test(BOTTOMS_SPEC) &&
    /silhouette, angle, depth, and belly volume/.test(TOPS_SPEC) &&
    /waistline, leg profile, depth, and angle/.test(BOTTOMS_SPEC));
  check("...and forbids reaching that fit by deforming the cloth",
    /without stretching or warping the fabric\./.test(TOPS_SPEC) &&
    /without distorting the garment design\./.test(BOTTOMS_SPEC),
    "an adaptation instruction with no ban on warping is satisfied by warping");
  /* (3) THE INVARIANT, restated last, on the attributes a re-drape is most likely to
     smear. This is what replaced STRICT_REFERENCE_LOCK on these two branches. */
  check("(3) it closes by pinning the garment's own attributes as unchanged",
    /Strictly preserve the original shirt texture, pattern, and color\.$/.test(TOPS_SPEC) &&
    /Strictly preserve original pattern and color\.$/.test(BOTTOMS_SPEC),
    `tops=${TOPS_SPEC}\n        bottoms=${BOTTOMS_SPEC}`);
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
    ["the opposite-layer pin",      /Keep the subject's upper body and background unmodified/,
                                    /const KEEP_OPPOSITE_LAYER = /],
  ];
  for (const [label, absent, constantRe] of RETIRED) {
    check(label + ": off the wire on BOTH branches",
      !absent.test(TOPS_SPEC) && !absent.test(BOTTOMS_SPEC));
    check("...but still on file, so its restore is genuinely one line",
      constantRe.test(SRC), String(constantRe) + " not found in app.js");
  }
  /* ── THE OPPOSITE-LAYER LOCK SPLIT IN TWO, and only half of it retired ──────
     It was never one clause. The half that NAMES THE REGION being dressed is alive and
     always has been on bottoms - it moved into the new lead ("the live subject's CURRENT
     lower-body contour"), and an anchor with no region at all is the exact configuration
     the shirt-replacement report was filed against. The half that PINS THE OPPOSITE LAYER
     came off with this revision and is in the table above, now as a real constant rather
     than the inline wording it used to be.

     Both are asserted, separately, because they fail separately: naming the region to
     edit does not forbid an edit elsewhere, and forbidding one does not name the other. */
  check("bottoms still scopes the fit to the LOWER BODY, in its lead",
    /onto the live subject's CURRENT lower-body contour/.test(BOTTOMS_SPEC),
    "an unscoped anchor is the exact configuration the shirt-replacement report was filed against");
  check("...and it never pins the very layer it is replacing",
    !/Keep the subject's lower body/.test(BOTTOMS_SPEC),
    "a bottoms prompt that preserves the lower body cancels itself");
  check("tops is still implicitly scoped - the documented, evidence-led asymmetry",
    !/unmodified/.test(TOPS_SPEC) && !/lower body/.test(TOPS_SPEC),
    "if this fails the branches re-converged - update the asymmetry note in app.js with it");
  check("app.js flags the opposite-layer lock as the FIRST thing to restore on tops",
    /IF SHIRT-REPLACEMENT\s*\n?\s*RETURNS, THIS IS THE CLAUSE TO RESTORE FIRST/.test(SRC),
    "the only removal here that re-opens a previously fixed report");
  check("...and records where each half of it ended up",
    /WHERE EACH HALF LIVES TODAY/.test(SRC) &&
    /on tops the restore is the bottoms sentence with the two regions swapped/.test(SRC),
    "a restore note that names no wording is not a restore path");
  check("...with the pre-collapse KEEP_TOP wording still on file as the fallback",
    /const KEEP_TOP\s+= " Keep the person's existing upper body exactly as it is in the live camera/.test(SRC),
    "the DENSE-era constant is the alternative to mirroring the bottoms sentence");

  /* CONSTANT, not merely short. A template literal here is how a description creeps back
     in one field at a time, which is the exact history this mode is reacting to. */
  check("declared with no interpolation hole",
    /const CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(SRC) &&
    !/CATEGORY_ANCHOR = Object\.freeze\(\{[\s\S]{0,900}?\$\{/.test(SRC),
    "no template hole anywhere in or adjacent to the declaration");
  /* THREE AXES NOW, ALL SELECTORS. Construction joined category and angle when the closure
     clause turned out to be summoning button-downs onto plain tees. The property this
     check defends is unchanged: every axis picks a whole frozen string, so the number of
     anchors on the wire stays exactly one no matter how many axes there are. */
  check("...and the resolver only SELECTS an anchor, never builds one",
    /const anchors = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;/.test(SRC) &&
    /const plainTee = !bottoms && angle !== "back" && isPlainKnitTop\(item\);/.test(SRC) &&
    /\[P\.CORE, plainTee \? PLAIN_TEE_ANCHOR : bottoms \? anchors\.bottom : anchors\.top\]/.test(SRC) &&
    !/(BACK_)?CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(SRC) &&
    !/anchors\.(top|bottom)\s*\+/.test(SRC) &&
    !/PLAIN_TEE_ANCHOR\s*\+/.test(SRC) && !/\+\s*PLAIN_TEE_ANCHOR/.test(SRC),
    "appending one clause is how the dozen came back last time");
  check("...and the tee anchor is a frozen literal too, with no interpolation hole",
    /const PLAIN_TEE_ANCHOR\s*=\s*\n?\s*"/.test(SRC) &&
    !/const PLAIN_TEE_ANCHOR[\s\S]{0,600}?\$\{/.test(SRC),
    "a template hole here is how a per-item description creeps back one field at a time");
  /* The closure lock is a SEPARATE PART handed to fitPrompt(), not text glued onto an
     anchor. That is the distinction this whole section is about: a part can be shed under
     budget pressure and can be counted; a concatenation can be neither. */
  check("...and the bought-back clause is a separate part, never concatenated on",
    /\.\.\.\(closure \? \[\[P\.HIGH, FRONT_CLOSURE_LOCK\]\] : \[\]\),/.test(SRC) &&
    /const closure = !bottoms && angle !== "back" && hasFrontClosure\(item\);/.test(SRC) &&
    !/FRONT_CLOSURE_LOCK\s*\+/.test(SRC) && !/\+\s*FRONT_CLOSURE_LOCK/.test(SRC),
    "a concatenated clause cannot shed, and that is how the dozen came back last time");
  /* The angle axis must stay a SELECTOR. A back render that ships the front anchor plus a
     rear clause is the volume increase this suite's header is about. */
  check("the back anchors are frozen literals, with no interpolation hole either",
    /const BACK_CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(SRC) &&
    !/BACK_CATEGORY_ANCHOR = Object\.freeze\(\{[\s\S]{0,1200}?\$\{/.test(SRC),
    "no template hole anywhere in or adjacent to the declaration");
  check("the back pair sits inside the same ceiling as the front pair",
    BACK_TOPS_SPEC.length <= 650 && BACK_BOTTOMS_SPEC.length <= 650,
    "back tops=" + BACK_TOPS_SPEC.length + " back bottoms=" + BACK_BOTTOMS_SPEC.length);
  check("both sit far inside the 226-token ceiling, so the wire guard never clips them",
    TOPS_SPEC.length <= 650 && BOTTOMS_SPEC.length <= 650,
    "tops=" + TOPS_SPEC.length + " bottoms=" + BOTTOMS_SPEC.length);
}


console.log("\n── §2 EVERY BUILDER RETURNS IT, AND ASSEMBLES NOTHING ──");
{
  const cases = [
    ["FRONT square-on", TOP, "front", false],
    ["FRONT edge-on", TOP, "front", true],
    ["BACK square-on", TOP, "back", false],
    ["BACK edge-on", TOP, "back", true],
    ["BOTTOMS edge-on", { ...TOP, garmentType: "lower_body" }, "front", true],
    ["custom upload", { ...TOP, custom: true }, "front", true],
    /* A 400-character garbage name names no closure, so it correctly lands on the
       no-proven-closure branch and ships the ANCHOR ALONE. That is not a weakening of this
       row: what it guards is "one frozen anchor, nothing assembled onto it", and that still
       holds exactly. The name axis is deliberate now - see hasFrontClosure() - so the row
       carries its own expected string rather than pretending the name is inert. */
    ["pathological name", { ...TOP, name: "x".repeat(400) }, "front", true, TOPS_SPEC],
  ];
  /* Each case names the branch it must land in - now REGION x ANGLE, four frozen anchors
     rather than two. The invariance is unchanged in strength on every axis that was ever
     the point: pose (edge-on vs square-on), colour, custom-upload and pathological name
     still move the prompt not one byte. Angle now selects, and only selects. */
  for (const [name, item, angle, prof, override] of cases) {
    const back = angle === "back";
    const expected = override || (item.garmentType === "lower_body"
      ? (back ? BACK_BOTTOMS_SPEC : BOTTOMS_SPEC)
      : (back ? BACK_TOPS_SPEC : TOPS_FRONT_SPEC));
    check(`${name}: byte-identical to its category anchor`,
      api.buildCompositePrompt(item, angle, prof) === expected,
      api.buildCompositePrompt(item, angle, prof));
  }
  /* THE AXES, asserted once: category and angle move the prompt, and NOTHING else does.
     Pose is the one that has to be nailed down explicitly - it is the axis FIX ONE let
     through, and an edge-on render must still resolve to its square-on anchor exactly. */
  check("all four anchors are genuinely different from one another",
    new Set([TOPS_FRONT_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC]).size === 4);
  check("angle SELECTS: front and back differ, and each is its own frozen anchor",
    api.buildCompositePrompt(TOP, "front", false) !== api.buildCompositePrompt(TOP, "back", false) &&
    api.buildCompositePrompt(TOP, "back", false) === BACK_TOPS_SPEC);
  check("pose is still NOT an axis - edge-on resolves to the same anchor as square-on",
    api.buildCompositePrompt(TOP, "front", false) === api.buildCompositePrompt(TOP, "front", true) &&
    api.buildCompositePrompt(TOP, "back", false) === api.buildCompositePrompt(TOP, "back", true) &&
    api.buildCompositePrompt(JEANS, "back", false) === api.buildCompositePrompt(JEANS, "back", true));
  check("an unrecognised angle falls to FRONT, never to a silent back-render",
    api.buildCompositePrompt(TOP, undefined, false) === TOPS_FRONT_SPEC &&
    api.buildCompositePrompt(TOP, "sideways", false) === TOPS_FRONT_SPEC &&
    api.buildCompositePrompt(TOP, "BACK", false) === TOPS_FRONT_SPEC);

  /* Structural, across the builders this sandbox cannot execute. The four together are
     every path that can reach rtClient.set() with a prompt. */
  const builders = [
    ["buildPrompt", /function buildPrompt\(item, angle[\s\S]*?\n}/],
    ["buildCustomPrompt", /function buildCustomPrompt\(item, angle[\s\S]*?\n}/],
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
      /return (imageOnlyPrompt\(item, angle\)|lookAnchorPrompt\(\));/.test(codeBody) &&
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
