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
   cut dropped the structural directives too: the prompt is now one frozen string
   (IMAGE_ONLY_PROMPT), identical on every dispatch. This clause is retired either way,
   kept verbatim in DENSE, restorable in two lines - the difference is that restoring it
   now also means reinstating fitPrompt() at the builder, which §2 exercises directly.

   SO THE ASSERTIONS INVERTED, deliberately and with the loss stated. The reference
   figure's build can bleed into a rendered frame again - at every angle now, not just
   edge-on. What this suite still owes is the part that makes that reversible:
     · §1 the clause still EXISTS, verbatim, so restoring it is one line and not an
       archaeology exercise (a "removal" that deletes the wording is not reversible), and
     · §2 the restore instructions in app.js are ACCURATE - the names they tell you to
       add are the names actually on the DENSE table, and fitPrompt() would carry them,
     · §3 nothing quietly re-added it under a different name, which would leave the file
       claiming a retirement it did not perform.
   The successor contract - what the prompt now says INSTEAD - is asserted in
   image-first.test.mjs. Asserted against the SHIPPED prompt, never the retired constant. */
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
  code + "\nreturn { buildCompositePrompt, IMAGE_ONLY_PROMPT, fitPrompt, P, DENSE };")(...Object.values(sandbox));

const TEE = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };

console.log("── §1 THE DIRECTIVE SURVIVES AS TEXT, so the retirement is reversible ──");
{
  /* The two halves of the provenance split, checked on the constant rather than on a
     rendered prompt - which is the whole point of this section now. A retirement that
     also deletes the wording is not a retirement, it is a deletion, and the next person
     to see "it gave me the model's shoulders" would be rewriting it from scratch. */
  check("the isolation clause is still on file, verbatim",
    /modelAgnostic:\s+"Ignore the reference model's body; fit the cloth to THIS person\."/.test(SRC),
    "DENSE.modelAgnostic must survive its own retirement from assembly");
  /* The compact statement of the whole feature, and the one phrase that would have to
     survive any future shortening: it is what distinguishes this clause from ordinary
     body fidelity. */
  check("...including the phrase that distinguishes it from plain body fidelity",
    /fit the cloth to THIS person/.test(SRC), "the provenance split, not a slimming ban");
  check("its positive half - the body-fidelity clamp - is on file too",
    /bodyFidelity:\s+"Keep their real body volume; never slim them\."/.test(SRC), SRC.slice(0, 0));

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
  check("app.js documents the retirement and how to undo it",
    /RETIRED FROM ASSEMBLY, kept here so they can be bought back in one line/.test(SRC),
    "the DENSE table must carry its own restore note");
  check("...naming DENSE.bodyFidelity and DENSE.modelAgnostic as the symbols to re-add",
    /Restore: add \[P\.HIGH, DENSE\.bodyFidelity\]/.test(SRC) &&
    /Restore: add \[P\.MED, DENSE\.modelAgnostic\]/.test(SRC));

  const restored = api.fitPrompt([
    [api.P.CORE, api.IMAGE_ONLY_PROMPT],
    [api.P.HIGH, api.DENSE.bodyFidelity],
    [api.P.MED,  api.DENSE.modelAgnostic],
  ]);
  check("the documented restore actually assembles, and fits the budget",
    /Ignore the reference model's body/.test(restored) &&
    /never slim them/.test(restored) && restored.length <= 650,
    `${restored.length} chars: ${restored}`);
}

console.log("\n── §3 IT IS GENUINELY OFF THE WIRE, at every pose and every builder ──");
{
  /* The failure mode this catches is a half-done retirement: the comment says retired,
     one builder still carries it, and the prompt-length problem the retirement was for is
     only partly solved. Checked on the SHIPPED prompt at both poses, and structurally
     across the other three builders (which this sandbox cannot execute). */
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
    check(`the frozen prompt survives a pathologically long name (inProfile=${prof})`,
      /Fit and render the exact garment provided in the reference image/.test(out),
      `${out.length} chars: ${out.slice(-160)}`);
  }
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
