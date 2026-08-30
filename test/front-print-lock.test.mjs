#!/usr/bin/env node
/* THE FRONT GRAPHIC - "the back text survives the turn, the chest logo does not"
   =============================================================================
   THE REPORT: a black tee with a small centred chest logo and a large back graphic. Both
   render correctly at first. After a full 360 back to the front, the chest logo is gone and
   the front reads as a plain black tee. The back graphic is unaffected throughout.

   THE ASYMMETRY IS IN THE ANCHORS, and it is one clause wide. BACK_CATEGORY_ANCHOR.top
   carries "Precisely lock the rear print, logos, and back seams." CATEGORY_ANCHOR.top
   carries no equivalent - its strongest statement about the garment's surface is "Strictly
   preserve the original shirt texture, pattern, and color", which never names a print, a
   logo or a graphic at all.

   app.js SAYS SO ITSELF, in the back pair's own comment: the rear print lock is "the only
   thing this pair says which the front pair does not". It was added for a back-specific
   failure (the FRONT graphic reproduced on the reverse) and the front side was never given
   the mirror of it, because no front-side report had been filed. This is that report.

   WHY IT SURVIVES THE FIRST RENDER AND NOT THE ROUND TRIP. At go-live the model conditions
   fresh on the front photo and reproduces it faithfully. A 360 puts several genuine
   re-conditionings between then and the return - the two orientation swaps plus every
   topology re-drape the movement triggers - and each one re-derives the garment from the
   reference under the prompt it is given. A small high-frequency mark that no clause names
   is the first thing to erode across successive re-derivations. The back graphic does not
   erode because its anchor names it explicitly.

   IT IS A SHED-ABLE PART, NOT AN EDIT TO THE ANCHOR. The anchors are P.CORE and byte-pinned
   by image-first.test.mjs; growing one puts unshed-able text on the wire forever. The
   established pattern for a bought-back clause - FRONT_CLOSURE_LOCK, SLEEVE_LENGTH_LOCK -
   is a separate P.HIGH part, which fitPrompt() can drop under budget pressure before it
   will touch the anchor. This follows it.

   THE RISK, STATED. FRONT_CLOSURE_LOCK called itself product-neutral and was not: "buttons"
   and "placket" are garment FEATURES a sampler can steer toward, and they summoned a
   placket onto plain tees. "print", "logo" and "graphic" are surface marks rather than
   garment classes, and the identical wording has ridden the BACK anchor unconditionally
   with no invented-print report on file - which is the in-repo evidence this is the safer
   half of that distinction. §3 pins that it names no garment class, which is the property
   that actually made the tuxedo.
   ============================================================================= */

import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const code = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                       SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: CONFIG.PROMPT_MAX_CHARS, console: { warn() {}, log() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: {}, colorName: () => "black",
  activeColorOf: () => "#000", getSizeDelta: () => 0,
  getFitModifier: () => "", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { imageOnlyPrompt, FRONT_PRINT_LOCK, CATEGORY_ANCHOR };")(...Object.values(sandbox));
const { imageOnlyPrompt } = api;

const PRINT_RE = /front print/i;
const COVE     = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve",
                   name: "חולצה חלקה עם הדפס" };
const JEANS    = { garmentType: "lower_body", name: "Glide Slim" };

console.log("── §1 THE FRONT RENDER NAMES ITS GRAPHIC, as the back one already does ──");
{
  const front = imageOnlyPrompt(COVE);
  check("the front prompt locks the chest print and logo",
    PRINT_RE.test(front) && /logo/i.test(front), front);
  check("...and still leads with the unchanged frozen anchor",
    front.indexOf("Drape and fit the EXACT static shirt from the reference image") === 0,
    "the anchor is P.CORE and byte-pinned - this rides beside it, never inside it");
  check("...and stays inside the budget every anchor shares",
    front.length <= CONFIG.PROMPT_MAX_CHARS, `${front.length} chars`);
}

console.log("\n── §2 SCOPE: tops + front, where the back already has its own ──");
{
  check("the BACK render is untouched - its anchor already locks the rear print",
    !PRINT_RE.test(imageOnlyPrompt(COVE, "back")) &&
    /Precisely lock the rear print, logos, and back seams/.test(imageOnlyPrompt(COVE, "back")),
    "shipping both would spend budget restating one instruction on the same render");
  check("bottoms gain nothing - a chest logo is not a lower-body feature",
    !PRINT_RE.test(imageOnlyPrompt(JEANS)) &&
    imageOnlyPrompt(JEANS) === imageOnlyPrompt({ garmentType: "lower_body", name: "Print Joggers" }));
  check("a plain-knit tee gets it too - the tee anchor names no print either",
    PRINT_RE.test(imageOnlyPrompt({ garmentType: "upper_body", name: "Ion Crew Tee" })),
    "the tee branch has the same gap as the default one");
}

console.log("\n── §3 IT NAMES A SURFACE MARK, NEVER A GARMENT CLASS ──");
{
  /* THE DISTINCTION THAT MATTERS. The tuxedo came from naming GARMENTS (jacket, suit,
     tuxedo, bowtie) and the placket came from naming CONSTRUCTION (buttons, zip, placket) -
     both are things a sampler can render INSTEAD of the reference. A print or a logo is a
     property OF whatever garment the reference shows, not an alternative to it. */
  const lock = (/const FRONT_PRINT_LOCK\s*=\s*\n?\s*"([\s\S]*?)";/.exec(SRC) || [, ""])[1];
  check("the clause exists and is a frozen literal with no interpolation hole",
    lock.length > 0 && !/\$\{/.test(lock), lock);
  check("...and names no garment class the sampler could render instead",
    !/\b(shirt|t-?shirt|tee|jacket|coat|suit|tuxedo|bowtie|dress|hoodie|sweater|blouse)\b/i.test(lock),
    lock);
  check("...and carries no negation - there is no negative_prompt field to put one in",
    !/\b(do not|don't|never|avoid|without|no )\b/i.test(lock), lock);
}

console.log("\n── §4 SHED-ABLE, and the anchor never is ──");
{
  check("it is handed to fitPrompt as its own P.HIGH part, never concatenated on",
    /\[P\.HIGH, FRONT_PRINT_LOCK\]/.test(SRC) &&
    !/FRONT_PRINT_LOCK\s*\+/.test(SRC) && !/\+\s*FRONT_PRINT_LOCK/.test(SRC),
    "a clause welded into a P.CORE anchor can never shed");
  /* THE WORST CASE, spelled out because three optional parts can now coincide: a
     long-sleeve fastening top that also has a print. fitPrompt() drops the FIRST part at
     the worst surviving priority, so array order is the shed order - and this one is last,
     so the two earlier-reported failures shed before the one reported now. Whatever sheds,
     the anchor must survive and the total must be clamped. */
  const worst = imageOnlyPrompt({ garmentType: "upper_body", subType: "long_sleeve",
                                  name: "Oxford Button-Down Shirt" });
  check("the worst case - closure + sleeve + print - is still clamped to the budget",
    worst.length <= CONFIG.PROMPT_MAX_CHARS, `${worst.length} chars`);
  check("...and the P.CORE anchor survives it intact",
    worst.indexOf("Drape and fit the EXACT static shirt from the reference image") === 0,
    "a garment with an unstated print is a worse render; one with no anchor is a different garment");
}

console.log(fails === 0 ? "\nfront-print-lock: OK" : `\nfront-print-lock: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
