#!/usr/bin/env node
/* THE FRONT GRAPHIC CLAUSE - TRIED, AND WITHDRAWN
   =============================================================================
   THIS SUITE ASSERTS AN ABSENCE, which is the only form that catches a well-meant clause
   being added back. It used to assert the presence of FRONT_PRINT_LOCK; that clause is
   gone, and the reason it is gone is worth more than the clause was.

   THE REPORT IT ANSWERED WAS REAL. A chest logo rendered at go-live and was gone after a
   full 360, while the back graphic survived - because BACK_CATEGORY_ANCHOR.top carries
   "Precisely lock the rear print, logos, and back seams" and the front anchor names no
   print at all. That asymmetry still exists.

   THE FIX MADE IT WORSE. f543678 mirrored the back clause onto the front branch;
   c2fbc1a gated it to garments whose titles name a graphic. Reported immediately after:
   the front chest rendered a LARGE text graphic the reference never had, from go-live,
   before any rotation.

   IT WAS NOT CROSS-CONTAMINATION, and that was checked rather than assumed: the front
   prompt contained no rear vocabulary and the back prompt no chest vocabulary. §2 re-checks
   that separation, because it is a property worth keeping regardless.

   IT WAS THE THIRD TIME THIS FILE HAS WATCHED THE SAME MECHANISM. A garment feature named
   in a positive prompt, with no negative_prompt to balance it, comes back MORE prominent
   than the reference shows. DENSE.assetLock named garments and got a tuxedo.
   FRONT_CLOSURE_LOCK named buttons and plackets and got a placket on plain tees. This named
   prints and graphics and got a print.

   GATING DID NOT SAVE IT, which is the part most likely to be re-tried. The theory was that
   a garment whose title names a print can safely be told about its print. The reported
   garment is titled "חולצה חלקה עם הדפס" - it names its print - so the gate passed and the
   clause shipped anyway. The failure is not about WHICH garments receive the clause.

   THE COST OF THE WITHDRAWAL IS ACCEPTED AND RECORDED: the erosion report is re-opened. A
   small chest logo has no clause naming it and may fade again across the re-conditionings a
   360 forces. A faded logo is a degraded render of the RIGHT garment; an invented chest
   print is the wrong garment. If this is attempted a third time it needs a mechanism that
   does not put the words on the wire.
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
  code + "\nreturn { imageOnlyPrompt };")(...Object.values(sandbox));
const { imageOnlyPrompt } = api;

/* The reported garment, titled the way the storefront titles it - it NAMES its print, which
   is exactly why gating the clause did not save it. */
const COVE  = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve",
                name: "חולצה חלקה עם הדפס" };
const TEE   = { garmentType: "upper_body", name: "Graphic Print Tee" };
const PLAIN = { garmentType: "upper_body", name: "Boxy Heavyweight Top" };
const JEANS = { garmentType: "lower_body", name: "Glide Slim" };

console.log("── §1 NO FRONT-GRAPHIC VOCABULARY REACHES THE WIRE ──");
{
  /* Checked on the SHIPPED prompt for every shape that could plausibly re-acquire it,
     including the two whose titles name a print - the gate that was tried would have let
     both through. */
  for (const [label, item] of [["the reported garment", COVE], ["a titled graphic tee", TEE],
                               ["a plain top", PLAIN]]) {
    const p = imageOnlyPrompt(item);
    check(`${label} is told nothing about a front print, logo or graphic`,
      !/\b(front print|chest logo|graphics?)\b/i.test(p), p);
  }
  check("the constant itself is gone, not merely unreferenced",
    !/const FRONT_PRINT_LOCK\s*=/.test(SRC) && !/\[P\.HIGH, FRONT_PRINT_LOCK\]/.test(SRC),
    "a retired-but-present constant is one line from shipping again by accident");
  /* The withdrawal note is the load-bearing artifact here: without it the next reader sees
     an obvious gap (the back anchor locks its print, the front does not) and closes it. */
  check("...and the file records WHY, so the gap is not re-closed the same way",
    /TRIED AND WITHDRAWN/.test(SRC) &&
    /rendering a chest print the reference never had|LARGE text graphic the\n   reference never had/.test(SRC),
    "an absence with no explanation reads as an oversight");
}

console.log("\n── §2 THE TWO VIEW STATES STAY CLEANLY SEPARATED ──");
{
  /* This was the mechanism proposed for the regression, and it was NOT the cause - but it
     is a property worth pinning on its own, because a front prompt that mentioned the rear
     print really would paint the back graphic on the chest. */
  const front = imageOnlyPrompt(COVE, "front");
  const back  = imageOnlyPrompt(COVE, "back");
  check("the FRONT prompt carries no rear vocabulary at all",
    !/\b(rear|back print|back seams|REAR\/BACK)\b/i.test(front), front);
  check("the BACK prompt carries no chest vocabulary at all",
    !/\b(chest logo|front print|belly)\b/i.test(back), back);
  check("...and the back keeps its own rear-print lock, which has never misfired",
    /Precisely lock the rear print, logos, and back seams/.test(back),
    "evidence decides which side carries this, not symmetry");
  check("the two are different strings, each selected whole by the angle axis",
    front !== back &&
    front.startsWith("Drape and fit the EXACT static top from the reference image") &&
    back.startsWith("Drape and fit the EXACT static shirt's REAR/BACK side"));
  /* Returning to front must yield the front string EXACTLY - no residue of the back anchor
     can survive the round trip, because the anchors are selected rather than accumulated. */
  check("a 360 back to front resolves to the front string byte-for-byte",
    imageOnlyPrompt(COVE, "front") === front && !/rear/i.test(imageOnlyPrompt(COVE, "front")),
    "the angle axis SELECTS a frozen anchor; there is no state to leak across a turn");
}

console.log("\n── §3 THE BUDGET, with the clause gone ──");
{
  const worst = imageOnlyPrompt({ garmentType: "upper_body", subType: "long_sleeve",
                                  name: "Oxford Button-Down Shirt" });
  check("the worst case is anchor + closure + sleeve, all whole and inside the cap",
    worst.length <= CONFIG.PROMPT_MAX_CHARS &&
    /front closure/.test(worst) && /full length/.test(worst),
    `${worst.length} chars of ${CONFIG.PROMPT_MAX_CHARS}`);
  check("...and every shipped prompt is a complete string, never a mid-sentence cut",
    [COVE, TEE, PLAIN, JEANS].every((it) => /\.$/.test(imageOnlyPrompt(it))),
    "fitPrompt sheds whole parts; only a CORE anchor over the cap would ever be sliced");
  /* The cap is CHARACTERS and is this app's own. Decart's real limit is 226 TOKENS
     (~904 chars), so 650 characters is roughly 160 tokens - the two get conflated, and the
     conclusions differ. */
  check("the cap being measured is the character cap, well inside Decart's token limit",
    CONFIG.PROMPT_MAX_CHARS === 650 && /Decart rejects >226 tokens/.test(
      readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8")));
}

console.log(fails === 0 ? "\nfront-print-lock: OK" : `\nfront-print-lock: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
