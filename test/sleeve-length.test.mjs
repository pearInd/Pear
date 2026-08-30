#!/usr/bin/env node
/* SLEEVE LENGTH - "the long-sleeve shirt came back cut off at the elbows"
   =============================================================================
   THE REPORT: a white full-sleeve button-down renders as a short-sleeve shirt, fabric
   stopping around the elbow instead of reaching the wrist.

   TWO SEPARATE CAUSES, and only one of them was ever in the prompt.

   CAUSE 1 - THE NOUN, and it is a regression this suite's sibling introduced.
   PLAIN_TEE_ANCHOR opens "the EXACT static t-shirt", and "t-shirt" carries a sleeve length
   with it. PLAIN_TEE_TOKENS matches a bare \btees?\b, so "Long Sleeve Tee" resolved to that
   anchor and the prompt asserted short sleeves at a reference showing long ones. app.js
   already carries the warning verbatim - the retired SHIRT_NOUN note says a garment noun is
   "WRONG for lower_body items and long-sleeve tops, where it asserts what the reference
   contradicts" - and the tee anchor walked straight into it. It is the same mistake the
   sleeveless exclusion was written to avoid, in the other direction: calling a tank a
   t-shirt grows sleeves that were never there, calling a long-sleeve tee a t-shirt cuts off
   sleeves that were.

   CAUSE 2 - NOTHING BINDS SLEEVE LENGTH AT ALL for the reported garment. A button-down
   gets the neutral "shirt" anchor, which says nothing about sleeves, plus
   FRONT_CLOSURE_LOCK, which says nothing about sleeves either. The reference shows them;
   the model truncates them anyway. That is the FRONT_CLOSURE_LOCK class restated - the
   RIGHT garment in a state the reference never showed - which is precisely the class
   app.js's own restore note says a clause may be bought back for, by the procedure it
   prescribes: ONE part, at P.HIGH, on POSITIVE EVIDENCE only.

   STATED POSITIVELY, like every clause that survived. "Do NOT truncate or render short
   sleeves" names "short sleeves" inside a prompt that has no negative_prompt field to put
   it in, which is the DENSE.assetLock shape that produced the tuxedo. Naming the length we
   WANT costs the same budget and cannot be sampled backwards. §3 asserts it.

   FRONT AND BACK, UNLIKE THE CLOSURE LOCK, and the difference is physical rather than
   stylistic: a placket is a front-of-garment feature and is not in view from behind, while
   a sleeve is in view from every angle. Scoping this to the front would leave the reported
   truncation live on the back render. §4 pins the asymmetry so neither gets copied onto
   the other by symmetry-tidying.

   POSITIVE EVIDENCE ONLY, for the reason hasFrontClosure() documents at length: an
   unrecognised top must degrade to the OLD behaviour, never to a new assertion. toItem()
   already defaults an unknown top's subType to "short_sleeve", so silence correctly means
   "no long-sleeve claim" rather than "unknown".
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
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: {}, colorName: () => "white",
  activeColorOf: () => "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { imageOnlyPrompt, isPlainKnitTop, hasLongSleeves, SLEEVE_LENGTH_LOCK };"
)(...Object.values(sandbox));
const { imageOnlyPrompt, isPlainKnitTop, hasLongSleeves } = api;

const SLEEVE_RE  = /full length/i;
const CLOSURE_RE = /Reproduce the reference's front closure/;

const LS_SHIRT = { garmentType: "upper_body", type: "shirt", subType: "long_sleeve",  name: "White Long Sleeve Shirt" };
const LS_BD    = { garmentType: "upper_body", type: "shirt", subType: "long_sleeve",  name: "Oxford Button-Down Shirt" };
const LS_TEE   = { garmentType: "upper_body", type: "shirt", subType: "long_sleeve",  name: "Long Sleeve Tee" };
const SS_TEE   = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve", name: "Ion Crew Tee" };
const UNKNOWN  = { garmentType: "upper_body" };
const JEANS    = { garmentType: "lower_body", name: "Glide Slim" };

console.log("── §1 CLASSIFICATION: positive evidence of a full-length sleeve ──");
{
  check("catalog subType is ground truth, as it is for every other axis",
    hasLongSleeves({ garmentType: "upper_body", subType: "long_sleeve" }) === true &&
    hasLongSleeves({ garmentType: "upper_body", subType: "short_sleeve" }) === false &&
    hasLongSleeves({ garmentType: "upper_body", subType: "sleeveless" }) === false);
  check("English title vocabulary: long sleeve / long-sleeve / longsleeve",
    hasLongSleeves({ name: "Long Sleeve Shirt" }) === true &&
    hasLongSleeves({ name: "Long-Sleeve Oxford" }) === true &&
    hasLongSleeves({ name: "Strata Longsleeve" }) === true);
  check("Hebrew title vocabulary: שרוול ארוך",
    hasLongSleeves({ name: "חולצה שרוול ארוך" }) === true);
  check("a short-sleeve or sleeveless title is NOT a long sleeve",
    hasLongSleeves({ name: "Short Sleeve Shirt" }) === false &&
    hasLongSleeves({ name: "Halo Tank" }) === false &&
    hasLongSleeves({ name: "Ion Crew Tee" }) === false);
  /* The safe default, for the reason hasFrontClosure() spells out: an unrecognised top must
     land on the OLD behaviour. toItem() already defaults an unknown top to "short_sleeve",
     so silence here means "no claim", never "unknown". */
  check("an unrecognised or absent item makes NO long-sleeve claim",
    hasLongSleeves(UNKNOWN) === false && hasLongSleeves({}) === false &&
    hasLongSleeves(null) === false);
  check("a bottoms garment never claims sleeves, whatever its title says",
    hasLongSleeves(JEANS) === false &&
    hasLongSleeves({ garmentType: "lower_body", name: "Long Sleeve Print Joggers" }) === false);
}

console.log("\n── §2 THE REPORTED GARMENT: sleeve length reaches the wire ──");
{
  const p = imageOnlyPrompt(LS_SHIRT);
  check("a long-sleeve shirt binds full-length sleeves",
    SLEEVE_RE.test(p) && /wrist/i.test(p), p);
  check("...and a long-sleeve button-down carries BOTH locks - they are independent",
    SLEEVE_RE.test(imageOnlyPrompt(LS_BD)) && CLOSURE_RE.test(imageOnlyPrompt(LS_BD)),
    "a placket and a cuff are different features; one must not displace the other");
  check("...and both still fit the budget the anchors share",
    imageOnlyPrompt(LS_BD).length <= CONFIG.PROMPT_MAX_CHARS,
    `${imageOnlyPrompt(LS_BD).length} chars`);

  console.log("   -- and nothing else gains a sleeve claim --");
  check("a short-sleeve tee is untouched",
    !SLEEVE_RE.test(imageOnlyPrompt(SS_TEE)), imageOnlyPrompt(SS_TEE));
  check("an unrecognised top makes no claim either",
    !SLEEVE_RE.test(imageOnlyPrompt(UNKNOWN)));
  check("bottoms are untouched - a sleeve is not a lower-body feature",
    !SLEEVE_RE.test(imageOnlyPrompt(JEANS)) &&
    imageOnlyPrompt(JEANS) === imageOnlyPrompt({ garmentType: "lower_body", name: "Long Sleeve Joggers" }));
}

console.log("\n── §3 STATED POSITIVELY - a negation here is the tuxedo shape ──");
{
  const p = imageOnlyPrompt(LS_SHIRT);
  check("the clause never names the state it is preventing",
    !/\bshort\b/i.test(p) && !/truncat/i.test(p) && !/\bcut off\b/i.test(p), p);
  check("...and carries no negation at all",
    !/\b(do not|don't|never|avoid|no |not )\b/i.test(p.replace(/\bno\w/gi, "")), p);
}

console.log("\n── §4 FRONT AND BACK - a sleeve is in view from behind, a placket is not ──");
{
  check("the sleeve lock ships on the BACK render too",
    SLEEVE_RE.test(imageOnlyPrompt(LS_SHIRT, "back")),
    "scoping this to the front leaves the reported truncation live on the back view");
  check("...while the closure lock still does NOT, which is the deliberate asymmetry",
    !CLOSURE_RE.test(imageOnlyPrompt(LS_BD, "back")),
    "a front placket is not in view from behind; a sleeve is");
  check("a short-sleeve garment gains nothing on the back either",
    !SLEEVE_RE.test(imageOnlyPrompt(SS_TEE, "back")));
}

console.log("\n── §5 THE NOUN: a long-sleeve tee must not be called a t-shirt ──");
{
  /* app.js's retired SHIRT_NOUN note, verbatim: a garment noun is "WRONG for lower_body
     items and long-sleeve tops, where it asserts what the reference contradicts". The tee
     anchor names a t-shirt, which carries a sleeve length with it. */
  check("a LONG-sleeve tee does not take the t-shirt anchor",
    isPlainKnitTop(LS_TEE) === false &&
    !/EXACT static t-shirt/.test(imageOnlyPrompt(LS_TEE)),
    "'t-shirt' asserts a short sleeve at a reference showing a long one");
  check("...and it still gets the sleeve lock, so the length is stated rather than implied",
    SLEEVE_RE.test(imageOnlyPrompt(LS_TEE)));
  check("a SHORT-sleeve tee still takes the tee anchor - the tee fix is intact",
    isPlainKnitTop(SS_TEE) === true &&
    /EXACT static t-shirt/.test(imageOnlyPrompt(SS_TEE)));
  check("...and a sleeveless top still stays off it, as it always did",
    isPlainKnitTop({ garmentType: "upper_body", name: "Halo Tank" }) === false);
}

console.log("\n── §6 SELECTOR DISCIPLINE: a frozen part, never a built string ──");
{
  check("the lock is a frozen literal with no interpolation hole",
    /const SLEEVE_LENGTH_LOCK\s*=\s*\n?\s*"/.test(SRC) &&
    !/const SLEEVE_LENGTH_LOCK[\s\S]{0,400}?\$\{/.test(SRC));
  check("...handed to fitPrompt as its own part, never concatenated onto an anchor",
    !/SLEEVE_LENGTH_LOCK\s*\+/.test(SRC) && !/\+\s*SLEEVE_LENGTH_LOCK/.test(SRC) &&
    /\[P\.HIGH, SLEEVE_LENGTH_LOCK\]/.test(SRC),
    "a concatenated clause cannot shed and cannot be counted");
  check("...at P.HIGH, so it sheds before the anchor under budget pressure",
    /\[P\.HIGH, SLEEVE_LENGTH_LOCK\]/.test(SRC),
    "a garment with an unstated sleeve is a worse render; one with no anchor is a different garment");
}

console.log(fails === 0 ? "\nsleeve-length: OK" : `\nsleeve-length: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
