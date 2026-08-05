/* Fabric-realism prompt fragments (fitting-room/app.js).
   Decart's realtime set() accepts only { prompt, enhance, image } - there is no
   negative_prompt field on this SDK - so every "negative" guardrail in this codebase is
   an inline clause inside the positive prompt. That makes these strings, and the fact
   that EVERY builder actually includes them, the whole enforcement mechanism. There is
   nothing else downstream to catch a fragment that silently stopped being appended.

   Two things are pinned here:
     1. CONTENT - the clauses say what they must, and contain no vocabulary that pulls
        the model toward CG renders or retouched stock imagery.
     2. WIRING - all four prompt builders include them. Checked against the source text
        because the builders depend on most of the module (catalog tables, colour naming,
        composite constants, live DOM reads) and extracting them whole would test a
        reimplementation rather than the shipped code. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(name, endMarker) {
  const start = SRC.indexOf(name);
  if (start === -1) throw new Error(`could not find "${name}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${name}"`);
  return SRC.slice(start, end);
}

const sandbox = { console };
const fn = new Function(...Object.keys(sandbox),
  extract("const QUALITY_SUFFIX", "/* Bias the model toward keeping graphics") +
  "\nreturn { QUALITY_SUFFIX, FABRIC_CONTACT };");
const { QUALITY_SUFFIX, FABRIC_CONTACT } = fn(...Object.values(sandbox));

/* ── 1. No CGI / rendering vocabulary in the quality clause ─────────────────────
   The clause asks for photorealism. Naming a rendering technique in the same sentence
   conditions against that: "3D mesh" sits in training data beside CG cloth sims and game
   assets, "cinematic" beside colour-graded film stills. Both were present and both were
   fighting the goal. */
const CGI_VOCAB = /\b(3d mesh|mesh|cinematic|render(ed|ing)?|cgi|octane|unreal engine|raytrac\w*|shader)\b/i;
check("QUALITY_SUFFIX names no rendering technique", !CGI_VOCAB.test(QUALITY_SUFFIX),
  (QUALITY_SUFFIX.match(CGI_VOCAB) || []).join(","));
check("QUALITY_SUFFIX keeps its photorealism anchor", /photorealistic real-world fabric texture/.test(QUALITY_SUFFIX));

/* The two replacements must preserve the ORIGINAL intent, not just delete the words:
   "3D mesh" was the anti-tearing instruction and "cinematic shading" the lighting one. */
check("anti-tearing intent survives the 3D-mesh removal",
  /continuous unbroken fabric surface/.test(QUALITY_SUFFIX) && /tearing/.test(QUALITY_SUFFIX), QUALITY_SUFFIX);
check("shading intent survives the cinematic removal", /soft natural shading/.test(QUALITY_SUFFIX));
check("...and no longer contradicts the room-lighting clause beside it",
  /natural environmental lighting matching the user's room/.test(QUALITY_SUFFIX));

/* ── 2. The contact-shadow clause ──────────────────────────────────────────────
   This is the depth cue that separates "garment on a person" from "garment on the frame".
   A fit can be perfectly sized and still read as fake without it. */
check("contact shadow is instructed", /soft contact shadow/.test(FABRIC_CONTACT), FABRIC_CONTACT);
check("depth transition at the skin boundary is instructed", /depth transition/.test(FABRIC_CONTACT));
check("self-overlap at folds is shaded", /fold\s+overlaps/.test(FABRIC_CONTACT));
check("the cloth is placed ON the body, not above it", /sits ON the body/.test(FABRIC_CONTACT));

/* Inline negatives - the only kind this SDK supports. */
for (const [label, re] of [
  ["pasted-on / sticker look", /sticker|pasted onto/i],
  ["CGI / 3D render", /CGI or 3D render/i],
  ["airbrushed / retouched figure", /airbrushed or retouched/i],
  ["smoothed figure", /smoothed/i],
]) {
  check(`negative guardrail present: ${label}`, re.test(FABRIC_CONTACT), FABRIC_CONTACT);
}

/* It frames the output as a photograph rather than only forbidding the alternatives -
   a positive target the model can move toward, which a bare negative does not give it. */
check("states the positive target (a photograph of real cloth on a real person)",
  /photograph of real cloth on a real person/.test(FABRIC_CONTACT));

/* ── 3. Clinical vocabulary stays out of the fabric clauses too ────────────────── */
const BANNED = /\b(obese|obesity|overweight|fat|chubby|plus-size)\b/i;
check("no clinical body vocabulary in the fabric clauses",
  !BANNED.test(QUALITY_SUFFIX) && !BANNED.test(FABRIC_CONTACT));

/* ── 4. Wiring - every builder must actually append it ─────────────────────────
   The real regression risk. A fragment that exists but is referenced by three of four
   builders fails silently for whichever path lost it: a shopper trying a full look, or a
   custom upload, would get a measurably worse render with nothing in the logs. */
const BUILDERS = [
  ["buildCompositePrompt", "function buildCompositePrompt", "\n/* Full-Look composite clause"],
  ["buildPrompt",          "function buildPrompt",          "\n/**"],
  ["buildCustomPrompt",    "function buildCustomPrompt",    "\nconst APPLY_ATTEMPTS"],
  ["buildLookPrompt",      "function buildLookPrompt",      "\n/* ====="],
];
for (const [name, startMarker, endMarker] of BUILDERS) {
  const body = extract(startMarker, endMarker);
  check(`${name}() appends FABRIC_CONTACT`, /FABRIC_CONTACT/.test(body),
    `${name} body has no FABRIC_CONTACT reference`);
  check(`${name}() still appends STRICT_INPAINT`, /STRICT_INPAINT/.test(body));
  /* Order matters in a realtime diffusion prompt and this file has documented that twice.
     FABRIC_CONTACT is a tail clause: it must never be inserted ahead of STRICT_INPAINT,
     and in the composite builder it must stay behind the panel contract, which is locked. */
  check(`${name}() keeps FABRIC_CONTACT behind STRICT_INPAINT`,
    body.indexOf("FABRIC_CONTACT") > body.indexOf("STRICT_INPAINT"));
}

/* The locked front/back contract must be exactly where it was: leading the composite
   prompt, ahead of every fabric clause added here. */
const composite = extract("function buildCompositePrompt", "\n/* Full-Look composite clause");
/* Order must be read from the RETURN EXPRESSION, not the function body: locals like
   `const anchor = ...` are declared above the return, so a body-wide indexOf compares
   declaration order and silently answers a different question than the one being asked. */
const returnExpr = composite.slice(composite.indexOf("return ("));
check("the return expression was isolated (guards a misleading comparison)",
  returnExpr.includes("COMPOSITE_PANEL_CONTRACT") && returnExpr.includes("${anchor}"), returnExpr);
check("composite builder still LEADS with the panel contract (locked pipeline untouched)",
  returnExpr.indexOf("COMPOSITE_PANEL_CONTRACT") < returnExpr.indexOf("${anchor}") &&
  returnExpr.indexOf("COMPOSITE_PANEL_CONTRACT") < returnExpr.indexOf("FABRIC_CONTACT"), returnExpr);
check("panel selector still sits immediately after the contract, ahead of all fabric clauses",
  returnExpr.indexOf("select") < returnExpr.indexOf("${anchor}") &&
  returnExpr.indexOf("select") < returnExpr.indexOf("FABRIC_CONTACT"), returnExpr);
check("composite builder still selects the panel by angle (view switching untouched)",
  /COMPOSITE_SELECT\.back\s*:\s*COMPOSITE_SELECT\.front/.test(composite));

/* ── 5. Budget ─────────────────────────────────────────────────────────────────
   Every fragment here ships on EVERY frame's prompt. The composite path is the longest;
   keep the added clause proportionate so it cannot crowd the lead instruction. */
check("FABRIC_CONTACT stays under 400 chars", FABRIC_CONTACT.length < 400, `len=${FABRIC_CONTACT.length}`);
check("QUALITY_SUFFIX did not grow past its original size", QUALITY_SUFFIX.length < 420,
  `len=${QUALITY_SUFFIX.length}`);

console.log("\n" + (fails ? `${fails} check(s) FAILED` : "All fabric-realism checks passed."));
process.exit(fails ? 1 : 0);
