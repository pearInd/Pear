/* IMAGE-FIRST CONDITIONING - "I picked a Spider-Man tee and it rendered a tuxedo".

   REPORTED FAILURE: a graphic t-shirt selected from the catalog, its reference image
   correctly resolved, correctly composited and correctly delivered to rtClient.set() -
   and Decart streaming back a full tuxedo with a bowtie. Not a wrong colour, not a
   drifted print: a different garment entirely, of a different class, from a reference the
   model demonstrably had.

   ROOT CAUSE - the prompt was competing with its own image. Decart's realtime set()
   accepts exactly { prompt, image, enhance } (verified against @decartai/sdk@0.1.5
   setInputSchema). There is no negative_prompt, no image-strength, no ControlNet weight -
   so the ONLY lever this app has over how hard the reference image is weighed against the
   text is how much text there is. app.js was sending a dozen clauses, and two of them
   were actively fighting the pixels:

     · THE GARMENT DESCRIPTION. Every builder opened by interpolating catalog metadata -
       "Replace their top with white t-shirt: exact colour, texture and print." That is a
       TEXT description of a garment, and a description is something a diffusion model can
       satisfy out of its own prior instead of out of the reference. Nothing in that
       sentence mentions Spider-Man; the pixels that did were losing to it.
     · THE ENUMERATED NEGATIVE. DENSE.assetLock spelled out "never invent a garment,
       jacket, coat, suit, TUXEDO, tie, BOWTIE or badge". With no negative_prompt field
       those nouns ship inside the POSITIVE prompt, where a named garment is a token the
       sampler can steer toward. The clause written to stop the tuxedo is a plausible
       reason one appeared.

   THE FIX: stop describing the garment. The reference image IS the description. The
   prompt's only job is garmentAnchor() - point at the asset, forbid inventing around it -
   plus clauses that are STRUCTURAL: how to read the reference (which half, which side),
   where the body is, and which regions of the frame pass through untouched.

   WHAT THIS SUITE PINS, and why each is a distinct way for the fix to rot:
     §1  the anchor's exact wording (product-specified) and its region variants, because
         "upper garment" is a lie for the trouser half of the catalog and for a full look;
     §2  it LEADS every builder and is never shed, at any pose or budget;
     §3  no builder describes a garment any more - the invariant, stated as an absence,
         which is the only form that catches a NEW clause being added later;
     §4  the payload actually carries an image, because an image-first prompt with no
         image on the wire is the same failure arriving through the other half of the
         call - and that path used to be silent.

   Sibling suites: model-agnostic.test.mjs holds the record of what this retired and how
   to restore it; composite.test.mjs owns the token budget; prompt-only-flip.test.mjs owns
   which dispatches re-upload the reference. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real builders, executed. */
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
  code + "\nreturn { buildCompositePrompt, garmentAnchor, fitPrompt, P, DENSE, ANCHOR_REGION };")(...Object.values(sandbox));

const TEE = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };
const SPEC_UPPER =
  "Fit and replace the user's current upper garment strictly using the exact provided image asset." +
  " Preserve all graphic details, colors, and textures from the reference image" +
  " without generating any tuxedos, suits, or unrequested garments.";

console.log("── §1 THE ANCHOR: product-specified wording, region-aware ──");
{
  /* Byte-exact, because the wording is a product decision rather than an implementation
     detail - a paraphrase that reads the same to a human is a different token sequence to
     a diffusion model, and this is the one string in the file whose exact form was
     specified from outside it. */
  check("the upper-body anchor matches the specified wording byte for byte",
    api.garmentAnchor("upper_body") === SPEC_UPPER,
    JSON.stringify(api.garmentAnchor("upper_body")));

  /* THE ONE THING THAT MAY VARY, and must. The spec sentence says "upper garment"; the
     catalog ships lower_body items (Nimbus) and full looks. Sending "replace the user's
     current upper garment" while the reference is a pair of trousers is precisely the
     text-vs-image contradiction this whole refactor exists to remove - reintroduced by
     the fix itself, on the half of the catalog nobody screenshots. */
  check("the lower-body variant names the lower garment, not the upper one",
    /current lower garment strictly/.test(api.garmentAnchor("lower_body")) &&
    !/upper/.test(api.garmentAnchor("lower_body")), api.garmentAnchor("lower_body"));
  check("the full-look variant names both, in one sentence (one pass, not two)",
    /current upper and lower garments strictly/.test(api.garmentAnchor("look")),
    api.garmentAnchor("look"));
  check("an unknown/absent garmentType falls back to upper - never to 'undefined garment'",
    api.garmentAnchor(undefined) === SPEC_UPPER && api.garmentAnchor("nonsense") === SPEC_UPPER,
    api.garmentAnchor("nonsense"));

  /* The two halves do different jobs and both must be present: the first binds the
     output to the asset, the second forbids the substitution that was reported. */
  check("it binds the render to the PROVIDED asset, not to a garment concept",
    /strictly using the exact provided image asset/.test(SPEC_UPPER));
  check("...and preserves the graphic detail that identifies the specific product",
    /Preserve all graphic details, colors, and textures from the reference image/.test(SPEC_UPPER));
}

console.log("\n── §2 IT LEADS, AND IT NEVER SHEDS ──");
{
  /* Position is load-bearing for this model - leading tokens dominate, which is why the
     panel contract was moved to the front in the first place. The anchor displaced it:
     "which half of the reference to read" only matters once the model is reading the
     reference at all. */
  const poses = [
    ["FRONT square-on", TEE, "front", false],
    ["FRONT edge-on", TEE, "front", true],
    ["BACK square-on", TEE, "back", false],
    ["BACK edge-on", TEE, "back", true],
    ["BOTTOMS edge-on", { ...TEE, garmentType: "lower_body" }, "front", true],
    ["custom upload", { ...TEE, custom: true }, "front", true],
  ];
  for (const [name, item, angle, prof] of poses) {
    const out = api.buildCompositePrompt(item, angle, prof);
    check(`${name}: the anchor is at character 0`,
      out.indexOf("Fit and replace the user's current") === 0, out.slice(0, 120));
    check(`${name}: ...and the panel contract follows it rather than leading`,
      out.indexOf("split photo of one garment") > 0);
  }

  /* THE SHED TEST. fitPrompt() drops the worst priority until the prompt fits, so
     "present today" is not the same claim as "cannot be dropped". A pathological garment
     name is the real-world shape of that pressure. */
  const pathological = { ...TEE, name: "x".repeat(400) };
  for (const prof of [false, true]) {
    check(`the anchor survives budget pressure (inProfile=${prof})`,
      /Fit and replace the user's current upper garment/.test(
        api.buildCompositePrompt(pathological, "front", prof)));
  }
  check("it is tagged CORE at every assembly site, which is what makes that true",
    (SRC.match(/\[P\.CORE, garmentAnchor\(/g) || []).length >= 3 &&
    !/\[P\.(HIGH|MED|LOW|TRIM),\s*garmentAnchor\(/.test(SRC),
    "a non-CORE anchor is one long product name away from being dropped");
}

console.log("\n── §3 NO BUILDER DESCRIBES A GARMENT (the invariant, as an absence) ──");
{
  /* Stated as an absence on purpose. Asserting that today's clauses are present cannot
     catch the actual regression, which is somebody ADDING one more well-meant sentence -
     every clause this file ever grew was individually justified, and the sum is what
     produced the tuxedo. */
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no colour word is interpolated into any prompt",
    !/colorName\(activeColorOf\(/.test(codeOnly) && !/colorName\(item\.color\)/.test(codeOnly),
    "the reference image states the colour more precisely than a catalog hex ever could");
  check("no subtype noun is interpolated into any prompt",
    !/SHIRT_NOUN\[/.test(codeOnly) && !/SUBTYPE_PROMPT\[/.test(codeOnly),
    "'t-shirt' is a concept the model can render without reading the reference");
  check("the enumerated anti-invention list is no longer assembled",
    !/DENSE\.assetLock/.test(codeOnly),
    "with no negative_prompt field, 'tuxedo' in a ban is 'tuxedo' in the positive prompt");

  /* The rendered prompts, not just the source: a description could arrive from a clause
     rather than an interpolation. These are the nouns the retired builders used. */
  for (const [name, item, angle, prof] of [
    ["front square-on", TEE, "front", false],
    ["back edge-on", TEE, "back", true],
    ["bottoms", { ...TEE, garmentType: "lower_body" }, "front", false],
  ]) {
    const out = api.buildCompositePrompt(item, angle, prof);
    check(`${name}: the shipped prompt names no garment noun or colour`,
      !/\bt-shirt\b|\btank top\b|\btrousers\b|\bwhite\b|\bshort-sleeve\b/i.test(out), out);
  }
  /* The anchor's own trailing negative is the ONE place these words may appear, and it is
     there because the wording is specified. Pinned so that a future widening of the list -
     the pattern that produced assetLock, one reported garment at a time - is a deliberate
     edit to a spec'd string rather than a drift. */
  const negatives = (api.buildCompositePrompt(TEE, "front", false)
    .match(/tuxedos?|suits?|jackets?|coats?|bowties?|badges?/gi) || []).map((w) => w.toLowerCase());
  check("exactly two banned nouns ship, both inside the spec'd anchor",
    negatives.join(",") === "tuxedo,suit" || negatives.join(",") === "tuxedos,suits",
    `found: ${JSON.stringify(negatives)} - assetLock's six-noun enumeration must not return`);
}

console.log("\n── §4 THE OTHER HALF OF THE CALL: an image must actually be on the wire ──");
{
  /* An image-first prompt with no image is the same failure through the other door: the
     prompt says "the exact provided image asset" and nothing was provided, so the model
     has only its prior. This used to be silent - `...(imageRef ? { image: imageRef } : {})`
     quietly omitted the key while the prompt still recited a catalog description, so
     SOMETHING garment-shaped rendered. That safety net is gone by design. */
  const apply = SRC.slice(SRC.indexOf("async function applyGarment(item) {"),
                          SRC.indexOf("\n/**\n * Reads the Screen 1 physical inputs"));
  check("applyGarment sweeps the item's remaining assets when nothing resolved",
    /for \(const candidate of \[g\.front, g\.back, item\.img, item\.composite\]\)/.test(apply),
    "referenceImageFor() failing must not end the search");
  check("...and a total failure is an ERROR, not a warning",
    /console\.error\("\[PEAR\] applyGarment\(\) - NO garment asset could be resolved/.test(apply),
    "an image-first prompt with no image is a broken render, not a degraded one");
  check("...that does not throw the live session away",
    !/throw new Error\("no garment asset/.test(apply),
    "a recoverable session beats a dead one - the next re-anchor gets another attempt");

  const look = SRC.slice(SRC.indexOf("async function applyLook(top, bottom) {"),
                         SRC.indexOf("function buildLookPrompt"));
  /* `image: null` is NOT the same as no image key: it is an explicit empty value on a key
     the SDK validates, and in a payload log it looks like a reference was delivered. */
  check("applyLook omits the image key rather than sending image: null",
    !/image: primaryImage,/.test(look) &&
    /\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/.test(look),
    "an explicit null is the 'empty/default image state' this exists to prevent");
  check("...on the minimal-retry path too, not just the enriched payload",
    (look.match(/\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/g) || []).length === 2,
    "the retry is a second send site and needs the same rule");
  check("applyLook falls back to a raw garment ref before giving up",
    /garmentImageRef\(topImg\) \|\| garmentImageRef\(bottomImg\)/.test(look));

  /* The pre-existing wire check still guards both send sites - it is what turns a missing
     asset into a console line somebody can act on. */
  check("verifyGarmentAsset still inspects the payload at both full-set sites",
    (SRC.match(/verifyGarmentAsset\(payload, "(applyGarment|applyLook)"\)/g) || []).length === 2);
  check("...and still says what a payload with no image will actually do",
    /Decart has no pixel reference and will render its default\/generic output/.test(SRC));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
