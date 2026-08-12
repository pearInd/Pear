/* MODEL-AGNOSTIC GARMENT EXTRACTION - "it gave me the e-commerce model's shoulders".

   REPORTED FAILURE: the rendered body picks up physical features of the person wearing the
   garment in the REFERENCE photo - shoulder width, chest shape, overall proportions,
   sometimes posture - instead of keeping the live shopper's own frame.

   ROOT CAUSE, and it is the same class as every other clamp in app.js: an unstated region.
   Every body-shape defence in that file is aimed at the model's TRAINING PRIOR -
   STRICT_INPAINT's "do not slim or idealize", SIDE_PROFILE_DEPTH's flattened profile. None
   of them accounted for the second human actually present in the conditioning: a catalog
   reference is almost always model-worn, and Lucy sees that figure. IGNORE_SOURCE_ARTIFACTS
   is the closest existing clause and is deliberately scoped to non-human noise (badges,
   watermarks, "FRONT"/"BACK" labels), so a whole person in the reference was never named as
   off-limits. Anything the prompt does not pin is free to be reinterpreted.

   THE FIX: a provenance split stated explicitly - the reference image is the only source of
   CLOTH, the live camera feed is the only source of BODY - carried on every prompt builder.

   WHAT THIS SUITE PROTECTS, beyond the clause existing:
     §1 the three directives, individually, so a reword cannot quietly drop one.
     §2 the print-placement carve-out. "Re-proportion the garment to their body" and
        BACK_TAIL.real's "do not move, rescale or re-center the back print" are one bad
        reading apart from contradicting each other, and that alignment was its own fix.
     §3 EVERY builder carries it. app.js's own comment at buildLookPrompt records
        IGNORE_SOURCE_ARTIFACTS / PROFILE_ANOMALY_GUARD being "missed here in the pass that
        added them" - this asserts parity against STRICT_INPAINT so that cannot recur.
     §4 it is NOT profile-gated - the reference figure bleeds at 0 degrees too. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The constant is EVALUATED rather than regex-matched over source, so the assertions below
   read the real assembled string - concatenation bugs included. */
const start = SRC.indexOf("const MODEL_AGNOSTIC_EXTRACTION =");
if (start === -1) throw new Error("MODEL_AGNOSTIC_EXTRACTION not found in app.js");
const end = SRC.indexOf("\n\n", SRC.indexOf('lettering keeps the size', start));
const CLAUSE = new Function(
  SRC.slice(start, end) + "\nreturn MODEL_AGNOSTIC_EXTRACTION;")();

console.log("── §1 THE THREE DIRECTIVES ──");
{
  check("(1) ISOLATION: names the reference as a texture/clothing template and nothing more",
    /GARMENT ISOLATION MANDATE: the reference image is a TEXTURE AND CLOTHING TEMPLATE and nothing more/.test(CLAUSE),
    CLAUSE.slice(0, 200));
  check("(1) enumerates what MAY be extracted (fabric, pattern, print, seams, cut)",
    /Extract ONLY the garment from it - fabric, weave, colour, pattern, print, logos, seams, cut, collar, closure and hemline/.test(CLAUSE),
    CLAUSE.slice(0, 300));
  check("(1) names the reference's wearer explicitly - a person, model OR mannequin",
    /If a person, model or mannequin is wearing that garment in the reference/.test(CLAUSE),
    CLAUSE.slice(0, 400));
  check("(1) enumerates the specific attributes to ignore, incl. the reported ones",
    /ignore their body, physique, height, build, skin tone, shoulder width, chest, waist, limb positions and posture/.test(CLAUSE),
    CLAUSE.slice(0, 500));

  check("(2) ZERO MODEL BLEED: forbids transfer/copy/blend/average of the reference anatomy",
    /ZERO MODEL BLEED: do NOT transfer, copy, blend, average or impose ANY of that reference figure's anatomy, proportions, pose or body structure onto the live person/.test(CLAUSE),
    CLAUSE.slice(-900));
  check("(2) also forbids the INVERSE - reshaping the live person toward the reference figure",
    /never reshape the live person toward them/.test(CLAUSE), CLAUSE.slice(-900));
  /* The compact statement of the whole feature. Worth pinning on its own: it is the one
     sentence that survives if the clause is ever shortened under prompt-length pressure. */
  check("(2) states the PROVENANCE SPLIT - cloth from the reference, body from the live feed",
    /The live camera feed is the ONLY source of BODY; the reference image is the ONLY source of CLOTH/.test(CLAUSE),
    CLAUSE.slice(-900));

  check("(3) DYNAMIC USER FITTING: fit/stretch/drape/re-proportion onto the live body",
    /DYNAMIC USER FITTING: fit, stretch, drape and re-proportion the extracted garment onto the live person's own exact body shape and volume/.test(CLAUSE),
    CLAUSE.slice(-700));
  check("(3) names the abdominal/torso volume the verification case turns on",
    /their real torso, chest, stomach, waist and hips/.test(CLAUSE), CLAUSE.slice(-700));
  check("(3) requires fabric tension and folds to follow THEIR contours, not the model's",
    /with fabric tension, creases and folds following their contours rather than the reference figure's/.test(CLAUSE),
    CLAUSE.slice(-700));
}

console.log("\n── §2 THE CARVE-OUT: re-proportioning must not relocate artwork ──");
{
  /* Without this boundary the clause reads as licence to re-lay-out the garment's graphics
     for a different body, which is exactly what BACK_TAIL.real spent its own fix forbidding
     ("keeping each element at the SAME size, height and horizontal position ... Do not move,
     rescale, re-center or omit the back print"). Two clauses in one prompt disagreeing is
     how the back print started drifting in the first place. */
  check("scaling the garment is explicitly NOT licence to move its artwork",
    /Re-proportioning the garment to their body is NOT licence to move its artwork/.test(CLAUSE),
    CLAUSE.slice(-400));
  check("...and defers to the placement already specified upstream",
    /any print, graphic, logo or lettering keeps the size, height and position on the garment specified above/.test(CLAUSE),
    CLAUSE.slice(-400));
  check("the back-print pin it defers to is still present in app.js",
    /Do not move, rescale, re-center or omit the back print/.test(SRC),
    "BACK_TAIL.real's placement pin is the instruction the carve-out points at");
}

console.log("\n── §3 EVERY BUILDER CARRIES IT (the 'one site was missed' failure) ──");
{
  /* app.js's own comment at buildLookPrompt records IGNORE_SOURCE_ARTIFACTS and
     PROFILE_ANOMALY_GUARD being missed at that exact site when they were introduced. Parity
     against STRICT_INPAINT is the check that generalises: both belong on every prompt this
     app can emit, so any assembly site carrying one and not the other is the bug. */
  const inpaintSites = SRC.split(/\$\{STRICT_INPAINT\}|STRICT_INPAINT \+/).length - 1;
  const agnosticSites = SRC.split(/\$\{MODEL_AGNOSTIC_EXTRACTION\}|MODEL_AGNOSTIC_EXTRACTION \+/).length - 1;
  check("garment isolation is on exactly as many assembly sites as STRICT_INPAINT",
    inpaintSites === agnosticSites && inpaintSites >= 6,
    `STRICT_INPAINT@${inpaintSites} sites, MODEL_AGNOSTIC_EXTRACTION@${agnosticSites} sites`);

  /* Named individually too - the parity count above would still pass if BOTH were missing
     from the same builder, and these are the six distinct prompts a shopper can trigger. */
  const builders = [
    ["buildCompositePrompt (AI Auto, stitched front|back reference)", "MODEL_AGNOSTIC_EXTRACTION + STRICT_INPAINT"],
    ["buildPrompt - catalog lower body", "Substitute the current bottoms with ${colorWord}"],
    ["buildPrompt - catalog upper body", "Substitute the current top with a ${colorWord}"],
    ["buildCustomPrompt - uploaded lower body", "Substitute the current bottoms with ${ref}"],
    ["buildCustomPrompt - uploaded upper body", "Substitute the current top with ${ref}"],
  ];
  for (const [name, marker] of builders) {
    const i = SRC.indexOf(marker);
    const line = i === -1 ? "" : SRC.slice(i, SRC.indexOf("\n", i));
    check(`${name}: carries the isolation clause`,
      i !== -1 && /MODEL_AGNOSTIC_EXTRACTION/.test(line), line.slice(0, 200) || `marker not found: ${marker}`);
  }
  // The full-look builder assembles its tail on its own line, so it is matched separately.
  const lookTail = SRC.indexOf("${MODEL_AGNOSTIC_EXTRACTION}${STRICT_INPAINT}${IGNORE_SOURCE_ARTIFACTS}${ROTATION_CONTINUITY}${PROFILE_ANOMALY_GUARD}${suffix}`");
  check("buildLookPrompt (full look, TOP+BOTTOM): carries it too",
    lookTail !== -1, "the site app.js's own comment records as previously missed");
}

console.log("\n── §4 NOT PROFILE-GATED: the reference figure bleeds at every angle ──");
{
  /* SIDE_PROFILE_DEPTH and LATERAL_SEAM_SYNTHESIS are correctly gated behind `inProfile` -
     they describe a 90-degree frame. This one must NOT be: a square-on shopper is rendered
     against the same model-worn reference. Asserted structurally, because a future tidy that
     groups the three "body" clauses together would be an easy way to gate it by accident. */
  const compositeBody = SRC.slice(SRC.indexOf("function buildCompositePrompt(item, angle, inProfile)"),
                                  SRC.indexOf("/* Full-Look composite clause"));
  check("buildCompositePrompt does not put the isolation clause behind an inProfile ternary",
    !/inProfile \?[^:]*MODEL_AGNOSTIC_EXTRACTION/.test(compositeBody) &&
    !/MODEL_AGNOSTIC_EXTRACTION[^;]*: ""/.test(compositeBody),
    "it must be unconditional - the reference model is present at 0 degrees too");
  check("...while the two genuinely pose-specific clauses ARE still gated",
    /inProfile \? SIDE_PROFILE_DEPTH \+ LATERAL_SEAM_SYNTHESIS : ""/.test(compositeBody),
    compositeBody.slice(compositeBody.indexOf("inProfile ?"), compositeBody.indexOf("inProfile ?") + 120));
  /* The non-composite builders have no inProfile parameter at all, so their coverage is
     unconditional by construction - §3 already proves they carry it. */
  check("the catalog/custom builders take no pose parameter, so their coverage cannot be gated",
    /function buildPrompt\(item\) \{/.test(SRC) && /function buildCustomPrompt\(item\) \{/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
