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
/* ── THE SPECIFIED WORDING, PER CATEGORY AGAIN ────────────────────────────────
   Byte-exact for the reason this suite has always given: a paraphrase that reads the same
   to a human is a different token sequence to a diffusion model. The previous revision
   collapsed these into one category-agnostic string and recorded the risk; this restores
   the scoping and adds two clauses aimed at the mid-session-revert report. */
/* ── REVISION: FRONT AND BACK ARE NOW TWO REAL, DIFFERENT STRINGS ────────────────
   Three reports in a row traced a back-render gap to the fact that no builder on the
   active prompt path ever read the detected orientation - imageOnlyPrompt() shipped one
   frozen string regardless of which side was showing. TOPS_SPEC/BOTTOMS_SPEC below are
   now specifically the FRONT wording; BACK_TOPS_SPEC/BACK_BOTTOMS_SPEC are new. See
   CATEGORY_ANCHOR/BACK_CATEGORY_ANCHOR in app.js for the full account. */
const TOPS_SPEC =
  "Fit the EXACT FRONT side of the target shirt onto the subject's chest/front." +
  " Maintain 1:1 body ratio without distortion. Strictly preserve the user's" +
  " natural proportions, face, lower body, and background.";
const BOTTOMS_SPEC =
  "Fit the EXACT FRONT side of the target pants onto the subject's waist/front." +
  " Maintain 1:1 body ratio without distortion. Strictly preserve the user's" +
  " natural proportions, face, upper body, and background.";
const BACK_TOPS_SPEC =
  "Fit the EXACT REAR/BACK side of the target shirt onto the subject's back." +
  " Precisely lock rear print, logos, and back-seams. Maintain 1:1 body ratio" +
  " without distortion. Strictly preserve the user's natural proportions, face," +
  " lower body, and background.";
const BACK_BOTTOMS_SPEC =
  "Fit the EXACT REAR/BACK side of the target pants onto the subject's back." +
  " Precisely lock rear print, logos, and back-seams. Maintain 1:1 body ratio" +
  " without distortion. Strictly preserve the user's natural proportions, face," +
  " upper body, and background.";
const SPEC = TOPS_SPEC;

/* ── REVISION: STRICT_REFERENCE_LOCK BOUGHT BACK - see imageOnlyPrompt()'s own comment ──
   REPORTED: a saturated reference rendering washed-out toward white/neutral, print faded
   - the "invented/altered detail on the correct garment" class, not the tuxedo class (a
   different garment entirely). The four SPEC constants above stay the pure ANCHOR wording
   (every sentence-count/prefix/suffix check on them below is still about the anchor
   itself); this is the second, appended part imageOnlyPrompt() now actually returns. */
const STRICT_REFERENCE_LOCK =
  " Exactly match color, pattern, logos, and cut." +
  " Do NOT invent, add, or alter any details.";
const withLock = (spec) => (spec + STRICT_REFERENCE_LOCK).replace(/\s+/g, " ").trim();

console.log("── §1 THE TWO ANCHORS × TWO SIDES: product-specified, and now real ──");
{
  check("FRONT/TOPS matches the specified wording byte for byte",
    api.imageOnlyPrompt(TEE) === withLock(TOPS_SPEC), JSON.stringify(api.imageOnlyPrompt(TEE)));
  check("FRONT/BOTTOMS matches the specified wording byte for byte",
    api.imageOnlyPrompt(JEANS) === withLock(BOTTOMS_SPEC), JSON.stringify(api.imageOnlyPrompt(JEANS)));
  check("BACK/TOPS matches the specified wording byte for byte",
    api.imageOnlyPrompt(TEE, "back") === withLock(BACK_TOPS_SPEC), JSON.stringify(api.imageOnlyPrompt(TEE, "back")));
  check("BACK/BOTTOMS matches the specified wording byte for byte",
    api.imageOnlyPrompt(JEANS, "back") === withLock(BACK_BOTTOMS_SPEC), JSON.stringify(api.imageOnlyPrompt(JEANS, "back")));
  check("all four are DIFFERENT strings - category AND angle both genuinely scope now",
    new Set([TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC]).size === 4,
    "a collapsed pair re-opens the shirt-replacement report; a collapsed front/back re-opens THIS one");

  const sentences = (s) => s.split(/(?<=\.)\s+/).filter(Boolean);
  check("FRONT branches are exactly three sentences: scope, ratio, preserve",
    sentences(TOPS_SPEC).length === 3 && sentences(BOTTOMS_SPEC).length === 3,
    `tops=${sentences(TOPS_SPEC).length} bottoms=${sentences(BOTTOMS_SPEC).length}`);
  check("BACK branches are exactly four sentences - the rear-lock is a real fourth clause",
    sentences(BACK_TOPS_SPEC).length === 4 && sentences(BACK_BOTTOMS_SPEC).length === 4,
    `back-tops=${sentences(BACK_TOPS_SPEC).length} back-bottoms=${sentences(BACK_BOTTOMS_SPEC).length}`);
  check("...and all four open on a scope binding naming the ACTUAL side showing",
    TOPS_SPEC.startsWith("Fit the EXACT FRONT side of the target ") &&
    BOTTOMS_SPEC.startsWith("Fit the EXACT FRONT side of the target ") &&
    BACK_TOPS_SPEC.startsWith("Fit the EXACT REAR/BACK side of the target ") &&
    BACK_BOTTOMS_SPEC.startsWith("Fit the EXACT REAR/BACK side of the target "),
    [TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC].join("\n        "));

  /* (1) THE SCOPE. "Fit the EXACT ... side" scopes the whole instruction from the first
     few words, where a leading-token model is most sensitive, AND names which side - the
     thing three reports established was missing entirely from every previous revision. */
  check("(1) each branch binds its OWN garment noun, never the other's, on both sides",
    /target shirt/.test(TOPS_SPEC) && !/target pants/.test(TOPS_SPEC) &&
    /target pants/.test(BOTTOMS_SPEC) && !/target shirt/.test(BOTTOMS_SPEC) &&
    /target shirt/.test(BACK_TOPS_SPEC) && !/target pants/.test(BACK_TOPS_SPEC) &&
    /target pants/.test(BACK_BOTTOMS_SPEC) && !/target shirt/.test(BACK_BOTTOMS_SPEC),
    [TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC].join("\n        "));

  /* (2) THE REAR-LOCK, adopted verbatim from spec, and it is what makes a BACK render
     different IN KIND from a front one rather than by one swapped word. */
  check("(2) the rear-lock sentence appears on BOTH back branches, and on neither front one",
    /Precisely lock rear print, logos, and back-seams\./.test(BACK_TOPS_SPEC) &&
    /Precisely lock rear print, logos, and back-seams\./.test(BACK_BOTTOMS_SPEC) &&
    !/Precisely lock rear print/.test(TOPS_SPEC) && !/Precisely lock rear print/.test(BOTTOMS_SPEC),
    "a rear-lock on the FRONT render (or its absence on the back) is this fix half-applied");

  /* (3) THE 1:1 CLAUSE, on all four - the specified proportions/distortion hedge is not a
     per-side concern, so it does not vary by angle. */
  check("(3) the 1:1/zero-distortion clause is on all four, unconditionally",
    [TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC].every((p) =>
      /Maintain 1:1 body ratio without distortion\./.test(p)));

  /* (4) THE OPPOSITE-LAYER PIN. This is the clause the invented-non-target-garment family
     turns on, and it matters more than it ever has: the compositing guard that used to
     enforce it in pixels is deleted, so this wording is now the ONLY thing answering that
     report - on EVERY side, front and back alike. */
  check("(4) it preserves the opposite layer, face, and background, on all four strings",
    /Strictly preserve the user's natural proportions, face, lower body, and background\.$/.test(TOPS_SPEC) &&
    /Strictly preserve the user's natural proportions, face, upper body, and background\.$/.test(BOTTOMS_SPEC) &&
    /Strictly preserve the user's natural proportions, face, lower body, and background\.$/.test(BACK_TOPS_SPEC) &&
    /Strictly preserve the user's natural proportions, face, upper body, and background\.$/.test(BACK_BOTTOMS_SPEC),
    [TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC].join("\n        "));
  check("...and none of the four preserves the very layer it is fitting",
    !/preserve[^.]*upper body/.test(TOPS_SPEC) && !/preserve[^.]*upper body/.test(BACK_TOPS_SPEC) &&
    !/preserve[^.]*lower body/.test(BOTTOMS_SPEC) && !/preserve[^.]*lower body/.test(BACK_BOTTOMS_SPEC),
    "a prompt that preserves the layer it is editing cancels itself");
  check("...with no pass-through the model has no second stream for, on any of the four",
    ![TOPS_SPEC, BOTTOMS_SPEC, BACK_TOPS_SPEC, BACK_BOTTOMS_SPEC].some((p) =>
      /pass through/.test(p) || /LIVE camera feed/.test(p)),
    "the guard that made pass-through real is deleted; the prompt must not still promise it");
}

console.log("\n── §1b THE FIX ITSELF: angle is threaded, frozen, and TOCTOU-safe ──");
{
  /* ── REVISION: THIS SECTION USED TO PROVE THE OPPOSITE ────────────────────────
     It used to assert that buildPrompt() discarded its angle argument - correctly, for
     three revisions, until three reports traced the resulting back-render gap to exactly
     that. What is proven now is the fix and its safety property together: the parameter
     is genuinely read (imageOnlyPrompt() branches on it), and it is READ AS A FROZEN
     SNAPSHOT rather than a live re-read - which is what stops this fix from reopening the
     TOCTOU "mixing bug" angle-race.test.mjs exists to catch (a prompt describing one side
     while the already-resolved image reference describes the other). */
  check("buildPrompt(item, angle, morph) genuinely threads its parameters into imageOnlyPrompt()",
    /function buildPrompt\(item, angle = "front", morph = null\) \{\s*\n\s*return imageOnlyPrompt\(item, angle, morph\);/.test(SRC),
    "a declared-but-discarded parameter is the exact regression three reports were filed against");
  check("...and imageOnlyPrompt() actually branches BACK_CATEGORY_ANCHOR vs CATEGORY_ANCHOR on it",
    /const table = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;/.test(SRC),
    "declaring a back anchor table nobody ever selects is the same bug with extra steps");
  check("applyGarment() passes the FROZEN angleAtStart, never a live effectiveAngle() read",
    /buildPrompt\(item, angleAtStart, morphAtStart\)/.test(SRC) && !/buildPrompt\(item, effectiveAngle\(\)/.test(SRC),
    "a live read here reopens the precise TOCTOU race angle-race.test.mjs already fixed once");
  check("...and the runtime half that actually performs the IMAGE swap is still wired underneath",
    /function createOrientationWatcher\(/.test(SRC) && /async function maybeSwap\(next\)/.test(SRC),
    "the prompt now agrees with the image; it does not replace what selects the image");
  /* THE HONEST LIMIT: for an item with no real, distinct back photo, AUTO_ANGLE never
     engages at all, so angle==="back" is never computed for it - BACK_CATEGORY_ANCHOR
     being correctly wired does not help an item that never reaches it. Recorded here so
     it is not discovered by surprise from a support ticket. */
  check("app.js names the gap that remains - no back photo means angle never reaches \"back\"",
    /THE ONE GAP THIS REVISION DOES NOT CLOSE/.test(SRC) &&
    /canCombineViews\(\) still gates AI Auto on/.test(SRC),
    "an honest limit belongs on file, not just in a chat reply");
}

console.log("\n── §1c THE GARMENT PIN: the mid-session revert, fixed in the payload ──");
{
  /* REPORTED: mid-session the render briefly reverts from the target garment to a generic
     one and then back. THE MECHANISM: applyGarment() built its payload with
     `...(imageRef ? { image: imageRef } : {})`, so a dispatch that resolved no reference
     shipped with NO image - and Decart, with nothing to condition on but its own prior,
     renders a generic garment. The next dispatch that resolves puts the real one back.

     WHY A MID-SESSION DISPATCH CAN RESOLVE NOTHING: reconditionForTopology() clears the
     wire-state fields on purpose to force a full re-upload when the body moves, so the
     reference is re-resolved several times per session and any miss was a chance to blank
     the conditioning. */
  /* Scoped to the payload literal, not the whole file: the old spelling survives in
     comments that explain WHY it was wrong, and a naive absence check would read those as
     the code still doing it. */
  const payloadBlock = SRC.slice(SRC.indexOf("  const payload = {", SRC.indexOf("async function applyGarment")),
                                 SRC.indexOf("console.group(\"[PEAR] applyGarment()"));
  check("the payload's image key is unconditional - the absence cannot be spelled",
    /image: imageRef,/.test(payloadBlock) &&
    !/\.\.\.\(imageRef \?/.test(payloadBlock),
    `an omitted key and an explicit null both blank the model's conditioning: ${payloadBlock}`);
  check("...because it re-pins the session's ACKNOWLEDGED reference first",
    /if \(!imageRef && lastAckedImageRef\) \{/.test(SRC),
    "lastAckedImageRef is stamped only after a set() resolves - it is the session lock");
  check("...and ABANDONS the dispatch when nothing is pinned, rather than blanking the model",
    /DISPATCH ABANDONED\./.test(SRC),
    "doing nothing keeps the conditioning Decart already holds - strictly better than none");
  /* THE PIN IS SESSION-SCOPED, and that is not a detail: carrying one session's garment
     into the next would pin the previous shopper's item onto a fresh try-on, which is a
     worse failure than the one being fixed. Cleared at exactly three session boundaries. */
  check("the pin is cleared at every session boundary - and only there",
    (SRC.match(/(?<!let )lastAckedImageRef = null;/g) || []).length === 3,
    "connectRealtime opening one, teardown() and stopBilling() ending one (the `let` is the declaration)");
  /* Sliced to the FUNCTION BODY. "invalidateWireState" also appears in the pin's own
     declaration comment - which explains that the pin survives it - and a proximity match
     reads that prose as the code doing the opposite of what it says. */
  const invalidateBody = SRC.slice(SRC.indexOf("function invalidateWireState(why) {"),
                                   SRC.indexOf("\n}", SRC.indexOf("function invalidateWireState(why) {")));
  check("...and NOT by invalidateWireState(), which is exactly when it must survive",
    !/lastAckedImageRef = null/.test(invalidateBody),
    `the transport changing is not the shopper changing garment: ${invalidateBody}`);
  check("...nor by the topology re-drape, which clears the wire fields on purpose",
    !/lastAckedImageRef = null/.test(
      SRC.slice(SRC.indexOf("async function reconditionForTopology("),
                SRC.indexOf("async function reconditionForTopology(") + 2000)),
    "the re-drape forces a full re-upload - the pin is what that re-upload falls back to");
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
  /* ── THE INVENT/ADD/ALTER CLAMP IS BACK ON THE WIRE - "shirt rendered white, not RED" ──
     Formerly listed in RETIRED above (still absent from the bare SPEC anchor constants,
     which is why it isn't there any more - that check is about the ANCHOR, not the full
     prompt). imageOnlyPrompt() now appends STRICT_REFERENCE_LOCK as a second fitPrompt()
     part on every branch, so a colour/print-fidelity report gets a real, targeted lever
     instead of a text description competing with the pixels. */
  check("STRICT_REFERENCE_LOCK is live on both categories and both angles",
    api.imageOnlyPrompt(TEE).includes(STRICT_REFERENCE_LOCK.trim()) &&
    api.imageOnlyPrompt(JEANS).includes(STRICT_REFERENCE_LOCK.trim()) &&
    api.imageOnlyPrompt(TEE, "back").includes(STRICT_REFERENCE_LOCK.trim()) &&
    api.imageOnlyPrompt(JEANS, "back").includes(STRICT_REFERENCE_LOCK.trim()));
  check("...appended AFTER the anchor, not before it - leading tokens dominate this model",
    api.imageOnlyPrompt(TEE).indexOf(STRICT_REFERENCE_LOCK.trim()) >
      api.imageOnlyPrompt(TEE).indexOf("Fit the EXACT FRONT"));
  check("...and it says nothing about what the garment IS - no colour word, no product noun",
    !/red|blue|black|white|crimson/i.test(STRICT_REFERENCE_LOCK),
    "a colour word here is the exact mechanism that caused the tuxedo report twice");
  /* ── THE OPPOSITE-LAYER LOCK IS BACK, ON BOTH BRANCHES ─────────────────────
     Its history is the whole argument for why it is now symmetric. It sat on BOTTOMS
     alone for three revisions under a one-branch-at-a-time-on-evidence rule; the
     dynamic-drape revision dropped it entirely and flagged that as the loss most likely to
     re-open a fixed report; it did exactly that, through a NEW trigger - a region entering
     frame mid-session with nothing said about it, rather than a mis-scoped anchor.

     WHAT SHIPS NOW IS STRONGER THAN WHAT WAS REMOVED. The old pin named a REGION ("keep
     the subject's upper body and background unmodified"); these name the shopper's actual
     CLOTHES and source them from the camera, which is the thing the model has to leave
     alone.

     ── AND THE REGION NAMING HAS SINCE MOVED OUT OF THE LEAD ──────────────────
     It used to sit in the first sentence ("onto the subject's lower body"), paired with a
     runtime guard that composited the other half back from the camera. The guard is off -
     it was painting a black rectangle over that half - so a lead that still divides the
     frame in two describes a pipeline that no longer exists, and the lead scopes to the
     FULL FRAME instead. The non-target region did not stop being named; it moved to the
     PRESERVE clause, which is where it now does its work. Both halves are still asserted
     separately, because they still fail separately: naming what to fit does not forbid an
     edit elsewhere, and forbidding one does not name the other. */
  /* THE REGION AND THE PRESERVE CLAUSE ARE BOTH BACK, which is what this revision
     restored. Asserted on the pair, because they came off together and a partial restore
     would leave one report closed and the other open. */
  check("both the region scope and the opposite-layer pin are on the wire again",
    /onto the subject's (chest\/front|back)\./.test(TOPS_SPEC) &&
    /Strictly preserve the user's natural proportions, face, lower body, and background/.test(TOPS_SPEC) &&
    /Strictly preserve the user's natural proportions, face, upper body, and background/.test(BOTTOMS_SPEC),
    "the collapse re-opened shirt-replacement and the invented-garment family at once");
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
    /\[P\.CORE, isBottomsGarment\(item\) \? table\.bottom : table\.top\]/.test(SRC) &&
    !/CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(SRC) && !/BACK_CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(SRC),
    "appending one clause is how the dozen came back last time");
  check("both sit far inside the 226-token ceiling, so the wire guard never clips them",
    TOPS_SPEC.length <= 650 && BOTTOMS_SPEC.length <= 650,
    "tops=" + TOPS_SPEC.length + " bottoms=" + BOTTOMS_SPEC.length);
}


console.log("\n── §2 EVERY SINGLE-ASSET BUILDER RETURNS IT, AND ASSEMBLES NOTHING ──");
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
  /* ── REVISION: EACH CASE NOW EXPECTS ITS OWN SIDE, NOT ONE GLOBAL CONSTANT ────
     This used to assert byte-identical output regardless of angle - that WAS the
     premise of strict image-only conditioning, until the collapse it protected against
     turned out to be a different, more expensive collapse: no builder ever varying by
     angle at all, which is what left a back-facing shopper rendered against front-facing
     words. What is asserted now is POSE-invariance (still real, still load-bearing - a
     shopper leaning or turning edge-on must not perturb the prompt) alongside genuine
     ANGLE-variance: front cases match the FRONT anchor for their region, back cases match
     the BACK anchor for their region, and pose never moves either.

     READ OFF imageOnlyPrompt() DIRECTLY, not buildCompositePrompt() - the two diverged
     when the composite path's panel contract was restored (see §4). This loop is about
     the category+angle SELECTION, which imageOnlyPrompt() owns and every single-asset
     builder (buildPrompt, buildCustomPrompt) delegates to unmodified; composite.test.mjs
     and side-profile.test.mjs own what buildCompositePrompt() layers on top of it. */
  for (const [name, item, angle, prof] of cases) {
    const isBottom = item.garmentType === "lower_body";
    const expected = withLock(angle === "back"
      ? (isBottom ? BACK_BOTTOMS_SPEC : BACK_TOPS_SPEC)
      : (isBottom ? BOTTOMS_SPEC : TOPS_SPEC));
    check(`${name}: byte-identical to its category+angle anchor plus the reference lock`,
      api.imageOnlyPrompt(item, angle) === expected,
      api.imageOnlyPrompt(item, angle));
  }
  /* THE AXES: category and angle both move the prompt now, by design - that IS the fix.
     Pose alone stays inert (a shopper turning edge-on must not perturb which of the four
     strings ships), and the four strings themselves are checked pairwise distinct so a
     future edit cannot quietly collapse any two of them back into one. */
  check("pose alone never moves the prompt - only category and angle do",
    api.imageOnlyPrompt(TEE, "front") === api.imageOnlyPrompt(TEE, "front") &&
    api.imageOnlyPrompt(TEE, "back") === api.imageOnlyPrompt(TEE, "back") &&
    api.imageOnlyPrompt(JEANS, "front") === api.imageOnlyPrompt(JEANS, "front") &&
    api.imageOnlyPrompt(JEANS, "back") === api.imageOnlyPrompt(JEANS, "back"),
    "imageOnlyPrompt() takes no pose parameter at all - there is nothing for pose to move");
  check("...but angle DOES move it - front and back are genuinely different per category",
    api.imageOnlyPrompt(TEE, "front") !== api.imageOnlyPrompt(TEE, "back") &&
    api.imageOnlyPrompt(JEANS, "front") !== api.imageOnlyPrompt(JEANS, "back"),
    "an angle-invariant prompt here is the exact bug three reports were filed against");
  check("...and all four category×angle combinations are pairwise distinct",
    new Set([
      api.imageOnlyPrompt(TEE, "front"), api.imageOnlyPrompt(TEE, "back"),
      api.imageOnlyPrompt(JEANS, "front"), api.imageOnlyPrompt(JEANS, "back"),
    ]).size === 4,
    "any two of these collapsing to the same string is a silent regression on one axis");

  /* Structural, across the builders this sandbox cannot execute. buildCompositePrompt is
     deliberately NOT in this list any more - see §4 for what it does instead and why. */
  const builders = [
    ["buildPrompt", /function buildPrompt\(item, angle[\s\S]*?\n}/],
    ["buildCustomPrompt", /function buildCustomPrompt\(item, angle[\s\S]*?\n}/],
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
       inside imageOnlyPrompt(), where it selects between the anchor TABLES and budgets
       the shared tail - it is not reachable from a builder, so a builder still cannot
       introduce a clause. What each builder does is DELEGATE - passing its angle straight
       through where it has one - and that is asserted, not merely "still returns SOME
       constant" (which would pass even if angle had quietly gone back to being dropped). */
    check(`${name}(): delegates to the category+angle resolver, assembles nothing itself`,
      /return (imageOnlyPrompt\(item(, angle(, morph)?)?\)|lookAnchorPrompt\(\));/.test(codeBody) &&
      !/fitPrompt\(/.test(codeBody) && !/DENSE\./.test(codeBody),
      codeBody.slice(-240) || "builder not found");
  }
  check("...and buildPrompt/buildCustomPrompt specifically THREAD angle and morph",
    (SRC.match(/return imageOnlyPrompt\(item, angle, morph\);/g) || []).length >= 2,
    "the two single-asset builders forward both - buildLookPrompt is exempt (top+bottom, not front/back)");
  /* buildCompositePrompt threads angle too, just not as a bare return - see §4. */
  const compositeBody = (SRC.match(/function buildCompositePrompt\(item, angle, inProfile, morph = null\)[\s\S]*?\n}/) || [""])[0];
  check("...and buildCompositePrompt still threads the SAME frozen angle into imageOnlyPrompt()",
    /imageOnlyPrompt\(item, angle\)/.test(compositeBody),
    "the composite path must select the same anchor the single-asset path would, for the same angle");

  /* THE INVARIANT, stated as an absence - the only form that catches the real regression,
     which is somebody adding one more well-meant clause. Every clause this file ever grew
     was individually justified; the sum is what produced the tuxedo. Scoped to exclude
     buildCompositePrompt's own body: §4 asserts THAT function's DENSE usage precisely
     (contract/select/pose only, never a garment description), so stripping it here avoids
     asserting the same fact twice with different intent. */
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const codeOnlyNoComposite = codeOnly.replace(compositeBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), "");
  check("no colour word or subtype noun reaches any prompt",
    !/colorName\(activeColorOf\(/.test(codeOnly) &&
    !/SHIRT_NOUN\[/.test(codeOnly) && !/SUBTYPE_PROMPT\[/.test(codeOnly));
  check("no DENSE clause is assembled by any builder EXCEPT buildCompositePrompt",
    !/\[P\.(CORE|HIGH|MED|LOW|TRIM),\s*DENSE\./.test(codeOnlyNoComposite),
    "the DENSE table is a restore library for every builder but the composite one, which now draws its panel contract from it");
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
  check("the builders keep their angle/pose/morphology parameters as the restore seam",
    /function buildCompositePrompt\(item, angle, inProfile, morph = null\)/.test(SRC) &&
    /buildCompositePrompt\(item, angleAtStart, profileAtStart, morphAtStart\)/.test(SRC),
    "the frozen snapshots must stay threaded even while unused");
}

console.log("\n── §4 THE COMPOSITE FLAG, AND THE PATH THAT MUST SURVIVE IT ──");
{
  /* ── REVISION: FIFTH FLIP - true → false → true → false → true ────────────────
     THE FLIP COUNT IS NOW THE POINT, so this section stopped asserting a direction and
     started asserting the two things that must hold whichever way it is set. The history:
     three independent live reports all trace to one mechanism - two mid-session (back
     graphic on a front-facing frame; rotation degrading to a generic shirt) and one at
     COLD START (3 identical go-live attempts on unchanged code producing 3 different
     outcomes). That variance across identical runs is model-conditioning reliability on a
     split reference, not a deterministic code race - which is why gating/retry work would
     not have fixed it, and all of that gating existed already anyway (§5, and the
     initial-apply recovery). Re-enabled anyway, by explicit instruction, holding that cost.

     WHAT THIS SUITE PINS NOW: (1) the reasoning stays on file whichever way the constant
     is set, so the next reader does not re-litigate a settled diagnosis, and (2) the
     single-asset path SURVIVES - its removal was explicitly requested and explicitly
     rejected, because it is the only path for a garment with no distinct back photo. */
  check("COMPOSITE_DEFAULT is a real boolean either way, and the flip history is on file",
    /const COMPOSITE_DEFAULT = (true|false);/.test(SRC) &&
    /FIFTH FLIP, BACK ON: true → false → true → false → true/.test(SRC),
    "the direction is the caller's call; the recorded history is what stops it being re-argued from scratch");
  check("...and app.js records the COLD-START variance as the decisive evidence",
    /3 identical go-live\s*\n?\s*attempts on unchanged code produced 3 different outcomes/.test(SRC) &&
    /signature of Decart's own/.test(SRC),
    "the 'why this is not a race' reasoning is what stops the next reader re-litigating it");
  check("...and records that the suspected cold-start gating ALREADY existed",
    /already built and\s*\n?\s*verified: canvas at opacity:0 until rtClient\.set\(\) RESOLVES/.test(SRC),
    "otherwise the next report gets 'fixed' by re-adding a gate that has always been there");
  check("the URL override works in BOTH directions, so either mode is one URL away",
    /const q = new URLSearchParams\(location\.search\)\.get\("composite"\)/.test(SRC) &&
    /if \(q === "1" \|\| q === "true"\)\s+return true;/.test(SRC) &&
    /if \(q === "0" \|\| q === "false"\)\s+return false;/.test(SRC));
  check("app.js tells a future editor NOT to chase a recurrence with more prompt text",
    /not a retry loop, not more prompt text,/.test(SRC),
    "the tuxedo history already proved that more text is not the fix for this failure class");
  check("...and names a recurrence as the SAME mechanism, with this constant as the response",
    /that is the SAME mechanism again, not\s*\n?\s*a new bug/.test(SRC),
    "a fourth report matching the three known patterns is not a new investigation");
  /* ── THE SINGLE-ASSET PATH IS LOAD-BEARING, NOT A FALLBACK ─────────────────
     Its deletion was requested as "remove the angle:auto downgrade path" and rejected.
     It is the ONLY reference path for a garment with no distinct back photo - most of the
     catalog - which cannot be composited at all, there being no second image to stitch;
     and it is where referenceImageFor() lands when a stitch legitimately fails. Asserted
     as CODE PRESENT rather than as a default, precisely because the composite flag moves
     and this must not move with it. */
  check("the per-orientation single-asset path is still what referenceImageFor() falls to",
    /if \(currentAngle === AUTO_ANGLE\) \{\s*\n\s*const blob = await garmentBlobCached\(activeImg\);/.test(SRC),
    "removing this does not force single-view items into combined mode - it breaks them");
  check("...and app.js says WHY it cannot be removed, so the next request to delete it is answered",
    /THE SINGLE-ASSET PATH STAYS, and deleting it was explicitly considered and rejected/.test(SRC) &&
    /it would break them/.test(SRC));
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
  /* ── SUPERSEDED BY A STRONGER CONTRACT ──────────────────────────────────────
     This pair used to assert that the image key was OMITTED rather than set to null when
     nothing resolved - a real distinction (an explicit empty value on a validated key
     looks, in a payload log, like a reference was delivered) but the wrong ceiling.

     THE REPORT THAT RAISED IT: mid-session the render reverts from the target garment to
     a generic one and then back. Both spellings produce that. An image-less set() -
     omitted key or explicit null - replaces the model's conditioning with its own prior,
     which IS the placeholder garment; the next dispatch that resolves puts the real one
     back. So the fix is not to spell the absence better, it is to never dispatch with an
     absence: fall back to the session's acknowledged reference, and abandon the dispatch
     if even that is empty. Doing nothing leaves the model conditioned on what it already
     holds, which is strictly better than blanking it. */
  check("applyLook sends the image key unconditionally - the absence cannot be spelled",
    /image: primaryImage,/.test(look) &&
    !/\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/.test(look));
  check("...on the minimal-retry path too, not just the enriched payload",
    (look.match(/image: primaryImage/g) || []).length >= 2);
  check("...because it re-pins the session's acknowledged reference first",
    /if \(!primaryImage && lastAckedImageRef\) \{/.test(look),
    "lastAckedImageRef is the immutable session lock - it survives invalidateWireState()");
  check("...and ABANDONS the dispatch when nothing is pinned, rather than blanking the model",
    /DISPATCH ABANDONED rather than sending an image-less payload/.test(look) &&
    /\n\s*return;\n\s*\}/.test(look.slice(look.indexOf("DISPATCH ABANDONED"))),
    "an image-less set() is worse than no set() - it destroys working conditioning");
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
  /* Comments stripped first, the same rule turn-hold and this file's own builder loop
     already follow: the re-apply is now a bounded retry, and the block comment explaining
     WHY it may not be fire-and-forget sits between the invalidate and the call. A distance
     budget measured across that explanation would force whoever reads it to delete the
     documentation to keep the check green - which is the wrong trade every time. The
     property being asserted is the ORDER, and stripping is what lets it stay about order. */
  const optsCode = opts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /* ORDER, ASSERTED AS ORDER. This used to be a 200-character proximity window, which read
     as "invalidate, then re-apply" only for as long as the re-apply stayed a one-liner. It
     is now a bounded retry loop, so the two are genuinely further apart and the budget was
     measuring the wrong thing - a check that fails when correct code grows is a check that
     will be deleted rather than understood. Two indices and a comparison say what was
     always meant, and keep saying it however the recovery is written. */
  const iInvalidate = optsCode.indexOf('invalidateWireState("SDK reconnect');
  const iReapply = optsCode.indexOf("applyActive()", iInvalidate);
  check("a post-reconnect re-apply invalidates the wire state FIRST",
    iInvalidate !== -1 && iReapply !== -1 && iInvalidate < iReapply,
    "without it the re-apply matches on both halves and dispatches nothing");
  /* ...AND IT RETRIES, which is a separate property from the ordering above and was the
     gap that made the ordering not quite enough. Nothing else re-asserts the garment after
     a reconnect - the re-anchor is a no-op under a frozen prompt and the re-drape only
     fires on movement - so a single rejected re-apply used to leave the session live,
     billing, and conditioned on whatever the SDK replayed. */
  check("...and retries rather than logging one rejection and giving up",
    /attempt <= 3/.test(optsCode) && /post-reconnect re-apply attempt/.test(opts),
    "a set() landing on a still-settling rebuilt transport is the likeliest outcome here");
  check("...abandoning the retry the moment the session is superseded",
    /const genAtReconnect = sessionGen;/.test(optsCode) &&
    /if \(sessionGen !== genAtReconnect\) return;/.test(optsCode),
    "a retry that outlives its session re-conditions someone else's try-on");
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
