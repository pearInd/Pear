/* ── THE PLAIN-BACK ANCHOR - "it drew scrambled black graphics on my back" ──────────
   REPORTED against a white tee: front carries "BE YOUR OWN Healer WORLDWIDE", the rear
   reference is 100% blank white fabric, and turning around produced scrambled black
   graphics across the shopper's back.

   THE REFERENCE WAS CORRECT. THE PROMPT ASKED FOR IT. BACK_CATEGORY_ANCHOR ships
   "Precisely lock the rear print, logos, and back seams" on EVERY back render, and on a
   blank rear that asserts a print and logos which do not exist. Decart's set() takes no
   negative_prompt, so "print" and "logos" reach the sampler as POSITIVE tokens to steer
   toward - the prompt instructs the model to invent rear graphics and it obliges. No
   amount of reference fidelity overrides a direct instruction.

   THE FIX IS THE SHAPE PLAIN_TEE_ANCHOR ALREADY PROVED ON THE FRONT: describe the
   plainness POSITIVELY and SELECT the anchor on positive evidence, rather than negating
   the graphic nouns. This suite pins both halves - the wording, and the abstention. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}
/* Index-scanned rather than regex-matched. The sibling suites use a
   `^const NAME\s*=([\s\S]*?);\s*$` pattern, which is fragile for these two constants:
   they are multi-line Object.freeze({...}) literals, so the terminator is `});` on its
   own line and a non-greedy match has to cross ~1.2k characters of string concatenation
   and comment prose to reach it. Scanning for the declaration and then for the closing
   `\n});` is exact and cannot half-match. */
function constBlock(name) {
  const decl = `\nconst ${name} = Object.freeze({`;
  const i = APP.indexOf(decl);
  if (i === -1) throw new Error(`const ${name} not found in app.js (as an Object.freeze literal)`);
  const start = i + 1;
  const end = APP.indexOf("\n});", start);
  if (end === -1) throw new Error(`const ${name} is unterminated`);
  const block = APP.slice(start, end + "\n});".length);
  return block.slice(block.indexOf("=") + 1).replace(/;\s*$/, "");
}
const evalConst = (n) => new Function(`"use strict"; return (${constBlock(n)});`)();

const PLAIN = evalConst("PLAIN_BACK_ANCHOR");
const PRINTED = evalConst("BACK_CATEGORY_ANCHOR");

console.log("── §1 THE PLAIN VARIANT NAMES NO GRAPHIC NOUNS AT ALL ──");
{
  /* THE LOAD-BEARING ASSERTION OF THIS SUITE. The patch specified when this was reported
     was "the rear fabric is 100% PLAIN WHITE with ZERO text, zero logos, and zero black
     chest graphics; strictly forbid carrying over front chest text". Every one of those
     phrases puts a graphic noun on the wire - text, logos, graphics, chest text - and
     with no negative_prompt to attach them to, that wording is a RICHER instruction to
     draw graphics than the sentence it replaces. It would have made the report worse.
     "Smooth unbroken fabric" cannot be sampled into a logo. */
  for (const [region, s] of Object.entries(PLAIN)) {
    check(`${region}: no print/logo/graphic/text noun appears`,
      !/\b(print|logo|logos|graphic|graphics|lettering|text)\b/i.test(s), s);
    check(`${region}: describes the plainness POSITIVELY`,
      /smooth unbroken fabric/i.test(s), s);
    /* A negation is the tuxedo mechanism. "zero", "no", "without", "forbid" in front of a
       garment feature is the exact shape this file keeps re-learning not to ship. */
    check(`${region}: states no prohibition`,
      !/\b(zero|forbid|forbidden|must not|do not|never)\b/i.test(s), s);
  }
}

console.log("\n── §1b THE PRINTED-REAR ANCHOR NAMES NO GRAPHIC NOUNS EITHER ──");
{
  /* §1 guarded ONLY the plain variant, and that asymmetry is exactly how the printed one
     kept a sentence that did the same damage. BACK_CATEGORY_ANCHOR read "Precisely lock
     the rear print, logos, and back seams", and once the classifier fix routed real rear
     photos onto it, a turn rendered "PEAK PEAK", blank white boxes and generic lines -
     one hallucination per noun. A garment WITH rear artwork is not exempt from the
     positive-token mechanism; it is the case where the model has the most to invent.
     So the same absence is now asserted on both anchors. */
  for (const [region, s] of Object.entries(PRINTED)) {
    check(`${region}: printed-rear anchor names no print/logo/seam/graphic noun`,
      !/\b(print|prints|logo|logos|seam|seams|graphic|graphics|lettering|typography)\b/i.test(s), s);
    check(`${region}: printed-rear anchor grounds on the reference instead`,
      /exactly as shown in the reference/i.test(s), s);
  }
}

console.log("\n── §2 IT SHRINKS THE WIRE, like every fidelity fix in this file ──");
{
  /* plain-tee-fidelity §7.3's rule, applied here: a fidelity fix that ADDS text is the
     text-volume mechanism reapplied. The plain variant replaces a 52-char clause with a
     41-char one, so it is strictly cheaper than the branch it stands in for. */
  for (const region of Object.keys(PLAIN)) {
    check(`${region}: shorter than the printed-rear anchor (${PLAIN[region].length} < ${PRINTED[region].length})`,
      PLAIN[region].length < PRINTED[region].length,
      `plain=${PLAIN[region].length} printed=${PRINTED[region].length}`);
  }
}

console.log("\n── §3 OTHERWISE BYTE-IDENTICAL - one clause swapped, nothing else ──");
{
  /* If the two anchors drift apart anywhere BUT the rear-print clause, a back render
     silently changes behaviour on an axis nobody reviewed. Normalising the one known
     difference must make them equal. */
  for (const region of Object.keys(PLAIN)) {
    const a = PRINTED[region].replace("Reproduce the rear panel exactly as shown in the reference.", "§");
    const b = PLAIN[region].replace("The rear panel is smooth unbroken fabric.", "§");
    check(`${region}: identical apart from the swapped clause`, a === b,
      `printed=${a}\n        plain=${b}`);
  }
}

console.log("\n── §4 SELECTED ON POSITIVE EVIDENCE ONLY (the §2.1 discipline) ──");
{
  const resolver = (() => {
    const i = APP.indexOf("function imageOnlyPrompt");
    return APP.slice(i, APP.indexOf("\n}", i));
  })();
  /* `=== true`, not a truthy test. undefined means nobody looked (an older widget, a
     rate-limited classify, a pre-v12 cache row) and false means the garment has a REAL
     rear print. Both must keep BACK_CATEGORY_ANCHOR: guessing "plain" on a printed back
     would suppress the one graphic the shopper turned around to see - the print-less-back
     bug, inverted. */
  check("the plain anchor requires backIsPlain === true, never a truthy value",
    /item\.backIsPlain === true/.test(resolver) &&
    !/item\.backIsPlain\s*\)/.test(resolver) &&
    !/!!item\.backIsPlain/.test(resolver),
    resolver);
  check("...and it is scoped to the BACK angle, where a rear anchor is what ships",
    /const plainBack = angle === "back" && item && item\.backIsPlain === true;/.test(resolver),
    resolver);
  /* Still a SELECTOR. Concatenating the plain clause onto the printed anchor would put
     both wordings on the wire - the print nouns included - which is the bug plus a patch. */
  check("...and it SELECTS a frozen anchor rather than being appended",
    !/PLAIN_BACK_ANCHOR\s*\+/.test(APP) && !/\+\s*PLAIN_BACK_ANCHOR/.test(APP) &&
    /const PLAIN_BACK_ANCHOR = Object\.freeze\(\{/.test(APP) &&
    !/PLAIN_BACK_ANCHOR = Object\.freeze\(\{[\s\S]{0,1200}?\$\{/.test(APP),
    "a template hole or a concatenation re-opens what the selector prevents");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
