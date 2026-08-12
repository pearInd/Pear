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

   ── COMPRESSED, AND WHY THIS SUITE CHANGED SHAPE ──────────────────────────────
   Decart rejects any prompt over 226 tokens ("Prompt is too long: 1376 tokens"), so the
   1,253-character clause this suite was originally written against no longer exists. It
   is now DENSE.modelAgnostic, one sentence, assembled through fitPrompt().

   That makes HOW it is asserted matter more than before. The old suite could check nine
   separate enumerated phrases; there is only one sentence to check now. So the weight
   moves to the two properties compression actually put at risk:
     · it must be on EVERY builder (§2) - unchanged from before, and
     · it must rank high enough that the BUDGET never sheds it (§3) - entirely new. A
       clause that silently drops out on a long garment name is indistinguishable from
       one that was never added.
   Asserted against the SHIPPED prompt, never the retired constant - a test that passes by
   reading dead source is worse than one that fails. */
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
  /* Resolves the SELECTED variant's colour so a swatch swap reaches the prompt.
     Lives outside this slice (next to the variant table), so it is stubbed to the
     item's own colour - the single-variant path, which is what these cases use. */
  activeColorOf: (it) => (it && it.color) || "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "regular fit", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { buildCompositePrompt, fitPrompt, P, DENSE };")(...Object.values(sandbox));

const TEE = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };

console.log("── §1 THE DIRECTIVE, in the prompt that actually ships ──");
{
  const out = api.buildCompositePrompt(TEE, "front", false);
  check("names the reference as cloth-only, not a body",
    /Cloth only: ignore the reference model's body/.test(out), out);
  /* The compact statement of the whole feature, and the one phrase that must survive any
     future shortening: it is what distinguishes this clause from ordinary body fidelity. */
  check("...and drapes to THIS person, the live subject",
    /drape to THIS person/.test(out), out);
  check("its positive half - the body-fidelity clamp - rides alongside it",
    /Keep their real volume, belly and hips; never slim or idealize/.test(out), out);

  /* COMPRESSED AWAY, recorded so the loss is deliberate rather than forgotten: the
     enumerated attribute list (height, build, skin tone, shoulder width, limb positions,
     posture), the explicit "never reshape the live person toward them" inverse, and the
     print-placement carve-out. The carve-out mattered because "re-proportion the garment"
     and the back-print placement pin can be read as contradictory - that pin is asserted
     directly below instead, which is the property the carve-out was protecting. */
  check("the back-print placement pin survives independently of the retired carve-out",
    /reproduce its back print at the same size and position/.test(SRC),
    "compression must not have taken the print-alignment fix with it");
}

console.log("\n── §2 EVERY BUILDER CARRIES IT (the 'one site was missed' failure) ──");
{
  /* app.js's buildLookPrompt comment records IGNORE_SOURCE_ARTIFACTS being missed at that
     exact site when it was introduced. Parity against the body-fidelity clamp generalises:
     both belong on every prompt this app can emit, so a site carrying one and not the
     other is the bug. */
  const builders = [
    ["buildCompositePrompt", /function buildCompositePrompt\(item, angle, inProfile\)[\s\S]*?\n}/],
    ["buildPrompt (catalog)", /function buildPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildCustomPrompt (upload)", /function buildCustomPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildLookPrompt (full look)", /function buildLookPrompt\(top, bottom, angleText[\s\S]*?\n}/],
  ];
  for (const [name, re] of builders) {
    const body = (SRC.match(re) || [""])[0];
    check(`${name}: carries the isolation clause`,
      body.includes("DENSE.modelAgnostic"), body.slice(-300) || "builder not found");
    check(`${name}: ...paired with the body-fidelity clamp`,
      body.includes("DENSE.bodyFidelity"), body.slice(-300) || "builder not found");
  }
}

console.log("\n── §3 THE BUDGET MUST NOT SHED IT (new risk, created by compression) ──");
{
  /* fitPrompt() drops the worst-priority clauses until the prompt fits. If garment
     isolation were tagged TRIM, a long product name would silently remove it - the
     original bug returning with no code change and nothing to point at. It is HIGH,
     one step below never-drop, and that ranking is the assertion. */
  const isolationIsHigh = /\[P\.HIGH,\s*DENSE\.modelAgnostic\]/.test(SRC);
  check("tagged HIGH, so only CORE outranks it",
    isolationIsHigh, "must not be MED/LOW/TRIM - those are shed under budget pressure");

  const pathological = { ...TEE, name: "x".repeat(400) };
  for (const prof of [false, true]) {
    const out = api.buildCompositePrompt(pathological, "front", prof);
    check(`survives a pathologically long garment name (inProfile=${prof})`,
      /ignore the reference model's body/.test(out), `${out.length} chars: ${out.slice(-160)}`);
  }
  check("survives at BOTH poses on ordinary input",
    /ignore the reference model's body/.test(api.buildCompositePrompt(TEE, "front", false)) &&
    /ignore the reference model's body/.test(api.buildCompositePrompt(TEE, "front", true)));
}

console.log("\n── §4 NOT POSE-GATED: the reference figure bleeds at every angle ──");
{
  /* The depth and lateral directives are correctly gated behind `inProfile` - they
     describe a 90-degree frame. This one must NOT be: a square-on shopper is rendered
     against the same model-worn reference. Asserted structurally, because grouping the
     three "body" clauses together in a future tidy is an easy way to gate it by accident. */
  const composite = SRC.slice(SRC.indexOf("function buildCompositePrompt(item, angle, inProfile)"),
                              SRC.indexOf("/* Full-Look composite clause"));
  check("not placed behind an inProfile ternary",
    !/inProfile \?[^\n]*modelAgnostic/.test(composite),
    "the reference model is present at 0 degrees too");
  check("...while the genuinely pose-specific clauses ARE still gated",
    /inProfile \? DENSE\.profileDepth : ""/.test(composite) &&
    /inProfile \? DENSE\.lateralWrap : ""/.test(composite),
    composite.slice(composite.indexOf("inProfile ?"), composite.indexOf("inProfile ?") + 160));
  check("the catalog/custom builders take no pose parameter, so they cannot be gated at all",
    /function buildPrompt\(item, angleText = ""\)/.test(SRC) &&
    /function buildCustomPrompt\(item, angleText = ""\)/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
