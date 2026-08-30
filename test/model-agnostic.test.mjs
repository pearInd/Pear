/* MODEL-AGNOSTIC GARMENT EXTRACTION - "it gave me the e-commerce model's shoulders".

   REPORTED FAILURE: the rendered body picks up physical features of the person wearing
   the garment in the REFERENCE photo - shoulder width, chest shape, proportions, posture -
   instead of keeping the live shopper's own frame.

   ROOT CAUSE, the same class as every other clamp in app.js: an unstated region. Every
   body-shape defence in that file aims at the diffusion model's TRAINING prior. None
   accounted for the second human actually present in the conditioning - a catalog
   reference is almost always model-worn - and the nearest existing clause was scoped to
   non-human noise (badges, watermarks, orientation labels). Anything the prompt does not
   pin is free to be reinterpreted.

   THE FIX: a provenance split stated explicitly - the reference image is the only source
   of CLOTH, the live camera feed is the only source of BODY - carried on every builder.

   ── COMPRESSED, THEN RETIRED. WHY THIS SUITE NOW ASSERTS AN ABSENCE ───────────
   Two pressures, in order.

   FIRST, LENGTH. Decart rejects any prompt over 226 tokens ("Prompt is too long: 1376
   tokens"), so the 1,253-character clause this suite was originally written against
   became DENSE.modelAgnostic, one sentence, assembled through fitPrompt(). It was then
   demoted CORE → HIGH → MED as grounding clauses displaced it, and at 90 degrees the
   budget already shed it.

   SECOND, AND DECISIVE: the tuxedo report. A Spider-Man graphic tee, selected in the
   catalog and correctly delivered to the wire as a reference image, came back from Decart
   as a full tuxedo with a bowtie. Decart's realtime set() takes { prompt, image, enhance }
   and nothing else - no negative_prompt, no image-strength, no ControlNet weight - so the
   only lever over how hard the reference is weighed against the text is HOW MUCH TEXT
   THERE IS. app.js was sending a dozen clauses.

   The first cut kept an image anchor plus the structural directives and dropped this one
   for describing a BODY rather than a structure. The tuxedo survived it, so the second
   cut dropped the structural directives too: the prompt became one frozen string
   (IMAGE_ONLY_PROMPT), identical on every dispatch.

   ── THIRD REVISION: THE DIRECTIVE IS BACK, INSIDE THE FROZEN STRING ───────────
   Freezing the prompt fixed the garment and exposed the body - which is this suite's own
   bug, returning exactly as its §3 predicted it would. A shopper with a real waistline got
   the catalog model's slim proportions and a shirt that hovered instead of draping.

   So the provenance split went back on the wire - but its strength has moved twice since.
   Revision 3 stated it outright and led with it: "Extract strictly the garment's fabric
   texture, color, and design pattern from the reference image, completely ignoring the
   original model's body size, chest, and waist dimensions." Revision 4, chasing a knotted
   hem and an open back, restructured the whole prompt around garment CONSTRUCTION and
   reduced this to its positive half alone - "Preserve only the reference image's graphics,
   fabric texture, and color" - which now closes the reference at the END of the prompt
   rather than opening it.

   That implies the discard by exhaustion but never states it, and it is the weakest this
   directive has been since it was first written. It is a deliberate trade against two
   visible artifacts, not an oversight - but it means THIS suite's own bug is the one most
   likely to return next, and DENSE.modelAgnostic is the one retired clause whose restore
   would be an improvement rather than a duplication. Appending it is a one-line edit; §2
   keeps that path exercised so it stays one line.

   WHAT THIS SUITE ASSERTS NOW is therefore both halves: that the DIRECTIVE ships (§1),
   and that the CONSTANT it used to ship as is still on file and still restorable (§2),
   because "superseded" decays into "deleted" the moment nothing checks.

   Concretely:
     · §1 the DIRECTIVE ships, in the rendered prompt, at both poses - and the constants
       it used to ship as are still on file, because a supersede that deletes the wording
       is a deletion and the next report would be rewritten from scratch;
     · §2 the restore path in app.js is ACCURATE - the DENSE table names real symbols,
       fitPrompt() still assembles them, and the table distinguishes SUPERSEDED clauses
       (restoring one would duplicate the frozen string) from genuinely lost ones;
     · §3 the retired CONSTANTS are off the wire, so the file cannot claim a retirement it
       did not perform - the directive is carried by the frozen string, not by them.
   The wider contract - everything the prompt says now - is asserted in
   image-first.test.mjs. Asserted against the SHIPPED prompt, never a retired constant. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real builders, executed - not regex-matched over source. */
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

/* Deliberately NOT a tee: imageOnlyPrompt() gained a construction axis, and a plain knit
   tee now resolves to its own anchor with no closure clause (see PLAIN_TEE_ANCHOR in
   app.js). The measurements below are written against the DEFAULT tops anchor plus that
   clause, so the fixture has to be a top that still takes that branch. */
const TEE   = { name: "Oxford Button-Down Shirt", garmentType: "upper_body", color: "#fff", subType: "long_sleeve" };
const JEANS = { name: "Glide Slim", garmentType: "lower_body", color: "#222" };

console.log("── §1 THE DIRECTIVE SHIPS, in the prompt that actually goes out ──");
{
  /* Asserted on the RENDERED prompt, not on the constant - a suite that passes by reading
     a retired string is worse than one that fails. This is the provenance split itself:
     the reference is the only source of CLOTH, the live feed the only source of BODY. */
  const out = api.buildCompositePrompt(TEE, "front", false);
  /* THE PROVENANCE SENTENCE IS SUPERSEDED, NOT LOST. "Use only the reference image's
     graphics, fabric texture, and color" was replaced by "Exactly match color, pattern,
     logos, and cut", which states the same rule inside the anchor where it cannot shed -
     and adds logos and cut, which the old wording did not name. */
  check("the shipped prompt names the reference as the only source of cloth",
    /the EXACT static top from the reference image/.test(out) &&
    /Strictly preserve the original top texture, pattern, and color\./.test(out), out);
  check("...the discard is still carried by exhaustion, not stated outright",
    !/ignoring the original model's body/.test(out), out);
  /* ── THE BODY-VOLUME GUARANTEE IS OFF THE WIRE, and this suite is where that has to
     be visible, because this suite is the record of the body clauses.
     VOLUME_PERSISTENCE went with the 1:1 collapse after a third report - invented detail
     on the correct garment. It remains on file as a constant, so the restore is one line
     in imageOnlyPrompt(), and there is now ~480 characters of budget to put it back into.
     Asserted as an ABSENCE plus a live restore path, which is the only shape that keeps
     a deliberate removal from decaying into a forgotten one. */
  check("...the LIVE-subject volume clause is OFF the wire - a recorded trade",
    !/abdomen\/stomach depth, waist volume, and torso thickness/.test(out), out);
  check("...but VOLUME_PERSISTENCE is still on file, so the restore is genuinely one line",
    /const VOLUME_PERSISTENCE =\s*\n?\s*"Maintain the exact same abdomen\/stomach depth/.test(SRC),
    "a restore path that requires rewriting the clause is not a restore path");
  check("...and app.js lists it among what the 1:1 collapse removed",
    /VOLUME_PERSISTENCE \/ FRONTAL_VOLUME - "it slimmed me down"/.test(SRC),
    "the removal must be findable from the file, not only from this test");

  /* NOT POSE-GATED, which is the property §4 of the original suite existed for: the
     reference figure's anatomy bleeds at every angle, so this must hold edge-on too.
     It used to be a ranking argument (MED, shed under pressure); it is now structural. */
  for (const prof of [false, true]) {
    check(`carried at inProfile=${prof} - a sentence in a constant cannot shed`,
      /Strictly preserve the original top texture, pattern, and color\./
        .test(api.buildCompositePrompt(TEE, "front", prof)));
  }

  /* The constants it used to ship as, still on file. A "supersede" that also deletes the
     wording is a deletion, and the next person to see "it gave me the model's shoulders"
     would be rewriting it from scratch. */
  check("the retired constant is still on file, verbatim",
    /modelAgnostic:\s+"Ignore the reference model's body; fit the cloth to THIS person\."/.test(SRC),
    "DENSE.modelAgnostic must survive its own retirement from assembly");
  check("its positive half - the body-fidelity clamp - is on file too",
    /bodyFidelity:\s+"Keep their real body volume; never slim them\."/.test(SRC));

  /* COMPRESSED AWAY LONG BEFORE THE RETIREMENT, recorded so the loss stays deliberate:
     the enumerated attribute list (height, build, skin tone, shoulder width, limb
     positions, posture), the explicit "never reshape the live person toward them"
     inverse, and the print-placement carve-out. The carve-out mattered because
     "re-proportion the garment" and the back-print placement pin can be read as
     contradictory - that pin is asserted directly below instead, which is the property
     the carve-out was protecting, and it is still assembled. */
  check("the back-print placement pin survives independently of the retired carve-out",
    /reproduce its back print at the same size and position/.test(SRC),
    "compression must not have taken the print-alignment fix with it");
}

console.log("\n── §2 THE RESTORE PATH IN app.js IS ACCURATE, not aspirational ──");
{
  /* A one-line restore is only one line if the instructions name real symbols. This
     executes the restore against the REAL fitPrompt() and the REAL DENSE table, so a
     rename that silently invalidates the comment fails here rather than in whatever
     session someone actually needs the clause back. */
  check("the DENSE table documents itself as a restore library, not an assembly source",
    /NOTHING HERE IS ASSEMBLED ANY MORE/.test(SRC) &&
    /RESTORE LIBRARY, not an assembly source/.test(SRC));
  check("...and records this clause as SUPERSEDED, with the sentence that replaced it",
    /THREE OF THEM ARE SUPERSEDED rather than merely retired/.test(SRC) &&
    /modelAgnostic  \u2192 ONLY IMPLIED, by "Preserve only the reference image's graphics,/.test(SRC),
    "restoring a superseded clause would DUPLICATE what is already on the wire");
  check("...and names the clauses that are genuinely gone, ranked, with a real restore line",
    /inpaintLock    face\/skin\/hands\/background passthrough\. THE LARGEST LOSS/.test(SRC) &&
    /Restore: add \[P\.HIGH, DENSE\.inpaintLock\]/.test(SRC));

  /* ── THE BUDGET IS NOT THE CONSTRAINT. THE EDITORIAL RULE IS. ──────────────
     Tops runs 342 characters and bottoms 320 against a 650 ceiling, so every retired
     clause would fit, on either side, with room to spare. That makes this section's job
     the opposite of what it used to be: it no longer warns that a restore will silently
     shed, it warns that a restore will silently SUCCEED.

     Text volume competing with the reference image is the mechanism behind all three
     fidelity reports in this sequence - wrong region, wrong garment, invented detail - so
     budget headroom is not permission. Anything added back is a deliberate bet against
     that mechanism and needs a live session to justify it, not a character count.

     TWO SPENDS HAVE BEEN MADE ON THAT BET, both against REPRODUCED reports rather than
     against spare capacity: the lower-body scoping on bottoms (a trouser try-on
     repainting the live top), and the per-frame adaptation sentence on both branches (the
     0-degree drape stretched over a turned shopper). The second is the larger, and it is
     why the branches now sit within ~20 characters of each other instead of 69 apart -
     the tops anchor grew more, because the tops wording carries the belly-volume clause.
     garment-category-prompt.test.mjs §2-§3 and image-first.test.mjs §1 own the wording.
     Bounded on both sides here, so neither branch can creep back toward the assembly this
     whole sequence undid. */
  const tops = api.imageOnlyPrompt(TEE);
  const bottoms = api.imageOnlyPrompt(JEANS);
  /* The tops branch now carries a SECOND part - FRONT_CLOSURE_LOCK, bought back against
     the button-down-rendered-open report - so a flat "both branches are within 40 of each
     other" no longer describes the code. Loosening the constant to fit would give up the
     property; instead the lock is measured separately, so the original invariant still
     holds where it always applied (the ANCHORS stay minimal and comparable) and the total
     is bounded on top of it. A second clause creeping in would fail the total; an anchor
     growing back toward the 634-character assembly would fail the anchor bound. */
  const closure = (/Reproduce the reference's front closure[\s\S]*?as shown\./.exec(tops) || [""])[0];
  const topsAnchor = tops.replace(closure, "").trim();
  check("the ANCHORS stay minimal and comparable, as they always had to",
    topsAnchor.length <= 360 && bottoms.length <= 360 &&
    Math.abs(bottoms.length - topsAnchor.length) <= 40,
    `tops anchor=${topsAnchor.length} bottoms=${bottoms.length} gap=${bottoms.length - topsAnchor.length}`);
  check("...and the one bought-back clause is the ONLY thing on top of the tops anchor",
    closure.length > 0 && tops.length === topsAnchor.length + 1 + closure.length &&
    tops.length <= 500,
    `tops=${tops.length} anchor=${topsAnchor.length} closure=${closure.length}`);

  const both = api.fitPrompt([
    [api.P.CORE, bottoms],
    [api.P.HIGH, api.DENSE.bodyFidelity],
    [api.P.MED,  api.DENSE.modelAgnostic],
  ]);
  check("every retired clause would now FIT - so nothing but judgement stops a restore",
    /never slim them/.test(both) && /Ignore the reference model's body/.test(both) &&
    both.length <= 650,
    `${both.length} chars - fits, which is exactly why the rule has to be written down`);
  check("...and app.js states that the budget is no longer the constraint",
    /The budget is not\s*\n?\s*the constraint/.test(SRC),
    "a reader who checks only the character count will draw the wrong conclusion");
  /* \u2500\u2500 THE TABLE IN app.js MUST BE THE ARITHMETIC, NOT A MEMORY OF IT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
     It has been wrong before - it survived two collapses describing a 634-character tops
     assembly with "ZERO HEADROOM" while the branch actually ran 170 characters with 480
     free, which is advice pointing the opposite way from the truth. So each printed row
     is recomputed here against the REAL fitPrompt() and the REAL DENSE table, and the
     text is required to match the number. A stale row now fails this suite. */
  const row = (base, clause) => api.fitPrompt([[api.P.CORE, base], [api.P.HIGH, clause]]).length;
  const arithmetic = [
    ["bodyFidelity ", api.DENSE.bodyFidelity,  533, 366],
    ["modelAgnostic", api.DENSE.modelAgnostic, 552, 385],
  ];
  for (const [name, clause, expTop, expBottom] of arithmetic) {
    check(`the ${name.trim()} row is the arithmetic this code actually produces`,
      row(tops, clause) === expTop && row(bottoms, clause) === expBottom,
      `tops=${row(tops, clause)} (doc ${expTop}) bottoms=${row(bottoms, clause)} (doc ${expBottom})`);
  }
  check("...and app.js prints that arithmetic, per branch, with both branches fitting",
    /THE RESTORE BUDGET: BOTH BRANCHES NOW HAVE ROOM, AND THAT IS THE TRAP/.test(SRC) &&
    /TOPS FRONT \(487 = 338 anchor \+ 148 closure lock\)  BOTTOMS \(320 chars - anchor, lower-body scoped\)/.test(SRC) &&
    /\+ DENSE\.bodyFidelity  \(45\) \u2192 533  fits              \u2192 366  fits/.test(SRC) &&
    /\+ DENSE\.modelAgnostic \(64\) \u2192 552  fits              \u2192 385  fits/.test(SRC),
    "the printed table and the executed arithmetic have to agree, or the table is advice against the code");
  check("...and it no longer claims a headroom that stopped being true two revisions ago",
    !/TOPS HAS ZERO HEADROOM/.test(SRC) && !/BOTTOMS HAS 392 CHARACTERS FREE/.test(SRC) &&
    /159 characters are free on tops and 330 on\s*\n?\s*bottoms/.test(SRC),
    "nothing sheds on either branch any more - the old table said the opposite");
}

console.log("\n── §3 THE CONSTANTS ARE OFF THE WIRE (the directive is not) ──");
{
  /* The distinction §1 and this section split between them. The DIRECTIVE ships, inside
     the frozen string. The CONSTANTS do not, and must not: assembling DENSE.modelAgnostic
     beside a frozen string that already says the same thing would spend budget restating
     it, which is the exact failure mode - text volume drowning the image - that this whole
     sequence of changes is about. A half-done supersede (comment says superseded, one
     builder still assembles it) is what this catches. */
  for (const prof of [false, true]) {
    check(`buildCompositePrompt does not assemble it (inProfile=${prof})`,
      !/[Ii]gnore the reference model's body/.test(api.buildCompositePrompt(TEE, "front", prof)));
    check(`...nor the body-fidelity clamp (inProfile=${prof})`,
      !/never slim them/.test(api.buildCompositePrompt(TEE, "front", prof)));
  }
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no builder anywhere in app.js still references either clause",
    !/DENSE\.modelAgnostic/.test(codeOnly) && !/DENSE\.bodyFidelity/.test(codeOnly),
    "found a live reference - the retirement is half-done");

  /* What must survive unconditionally is the grounding the retired clause was
     progressively demoted behind. A pathological garment name is the case where shedding
     turns into truncation, so it is checked here. */
  const pathological = { ...TEE, name: "x".repeat(400) };
  for (const prof of [false, true]) {
    const out = api.buildCompositePrompt(pathological, "front", prof);
    check(`the category anchor survives a pathologically long name (inProfile=${prof})`,
      /Drape and fit the EXACT static top from the reference image/.test(out),
      `${out.length} chars: ${out.slice(-160)}`);
  }
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
