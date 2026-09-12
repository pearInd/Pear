/* ── THE COLOUR LOCK - "the white tee rendered black" / "it came back yellow" ────────
   Tests colorNameFromHex() / colorLockSentence() and the priority they ride at.

   WHAT THIS CLAUSE IS. The category anchors end with "Strictly preserve the original
   <noun> texture, pattern, and color" - an instruction to preserve a colour that never
   NAMES one. That is a pointer, not a value: it works only while the model is reading
   the colour off the reference, which is exactly what fails in the reported case. This
   clause names the measured value instead, sampled per product from the front photo's
   own main fabric (server.js primary_color_hex -> widget garment_color_hex ->
   item.colorHex).

   THE TWO PROPERTIES WORTH PINNING, and they pull in opposite directions:
     1. It ABSTAINS rather than guesses. A wrong colour name is worse than none - the
        anchor's generic clause at least defers to the pixels, while "The garment fabric
        is yellow" states a value with full authority and will repaint a cream garment.
     2. It rides at P.LOW, BELOW fitSentence (P.MED). That is the condition on which it
        was allowed to exist: the tops branches have 7-10 free characters at their
        tightest rungs after the lower-body isolation lock, so anything at P.MED or above
        would have displaced an already-shipping feature. At P.LOW it sheds FIRST and is
        purely additive. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");

/* Lifted by brace matching rather than imported: app.js is a 15k-line browser script with
   DOM-coupled module scope. Same technique the sibling suites use. */
function functionSource(name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function ${name}\\s*\\(`, "");
  const m = re.exec(SRC);
  if (!m) throw new Error(`${name} not found in app.js`);
  let i = SRC.indexOf("{", m.index + m[0].length);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(m.index, j + 1);
  }
  throw new Error(`${name} is unbalanced`);
}
function constBlock(name) {
  const m = new RegExp(`^const ${name}\\s*=([\\s\\S]*?);\\s*$`, "m").exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return m[1];
}

const api = new Function(
  `"use strict";
   /* FABRIC_*, not COLOR_NAMES: app.js also has a human-facing label palette called
      COLOR_NAMES (backing colorName(), which always answers). The two collided at module
      scope until the fabric one was prefixed - a duplicate top-level const is a load-time
      SyntaxError, and NO suite in this directory could see it, because they all slice
      fragments into a sandbox rather than loading app.js. run.mjs's parse preflight
      (node --check on the whole file) is what catches that class now.
      NOTE: no backticks in this comment - it lives inside a template literal, and a
      stray one terminates the literal with a confusing "missing ) after argument list". */
   const FABRIC_COLOR_NAMES = ${constBlock("FABRIC_COLOR_NAMES")};
   const FABRIC_COLOR_MAX_DIST = ${constBlock("FABRIC_COLOR_MAX_DIST")};
   const FABRIC_COLOR_MIN_MARGIN = ${constBlock("FABRIC_COLOR_MIN_MARGIN")};
   const FABRIC_NEUTRAL_CHROMA_MAX = ${constBlock("FABRIC_NEUTRAL_CHROMA_MAX")};
   const FABRIC_NEUTRAL_NAMES = ${constBlock("FABRIC_NEUTRAL_NAMES")};
   ${functionSource("colorNameFromHex")}
   ${functionSource("colorLockSentence")}
   return { colorNameFromHex, colorLockSentence, FABRIC_COLOR_MAX_DIST,
            FABRIC_COLOR_MIN_MARGIN, FABRIC_NEUTRAL_CHROMA_MAX };`
)();

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}
const is = (got, want, label) => check(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("── §1 IT NAMES A COLOUR, NOT A HEX TRIPLET ──");
{
  /* Decart's set() feeds a natural-language text encoder. "#f8f8f5" is hex trivia to a
     tokenizer; "white" is a word it has strong priors for. Shipping the raw hex would
     spend characters to say almost nothing, which is the whole reason for the mapping. */
  is(api.colorNameFromHex("#ffffff"), "white", "pure white maps to white");
  is(api.colorNameFromHex("#000000"), "black", "pure black maps to black");
  is(api.colorNameFromHex("#1b2550"), "navy",  "navy is distinguished from blue");
  is(api.colorNameFromHex("#2a5cc8"), "blue",  "...and blue from navy");
  check("the sentence carries the NAME and never the hex",
    api.colorLockSentence({ colorHex: "#ffffff" }) === "The garment fabric is white." &&
    !/#/.test(api.colorLockSentence({ colorHex: "#ffffff" })),
    api.colorLockSentence({ colorHex: "#ffffff" }));
}

console.log("\n── §2 TOLERANT OF SPELLING, because the model's output drifts ──");
{
  is(api.colorNameFromHex("ffffff"),  "white", "a missing # still parses");
  is(api.colorNameFromHex("#FFFFFF"), "white", "uppercase still parses");
  is(api.colorNameFromHex("  #ffffff  "), "white", "surrounding whitespace is trimmed");
}

console.log("\n── §3 IT ABSTAINS RATHER THAN GUESSES - the load-bearing property ──");
{
  /* A WRONG colour name is strictly worse than no colour name. These all have to yield
     "" so the branch ships exactly the text it shipped before this clause existed. */
  is(api.colorLockSentence({ colorHex: "" }),        "", "unsampled colour -> no clause");
  is(api.colorLockSentence({}),                      "", "absent field -> no clause");
  is(api.colorLockSentence(null),                    "", "no item at all -> no clause");
  is(api.colorLockSentence(undefined),               "", "undefined item -> no clause");
  is(api.colorLockSentence({ colorHex: "not-a-hex" }), "", "unparseable -> no clause");
  is(api.colorLockSentence({ colorHex: "#ff" }),     "", "truncated hex -> no clause");
  /* 3-digit shorthand is NOT accepted by the sentence builder's parser: normalizeHexColor
     on the SERVER expands it before it is ever stored, so a 3-digit value arriving here
     means something upstream bypassed that path. Abstaining is the safe reading. */
  is(api.colorLockSentence({ colorHex: "#fff" }),    "", "3-digit shorthand -> no clause (server expands it first)");

  /* ── THE THREE GATES, each with the measured case that put it there ─────────────
     EVERY HEX BELOW WAS CHOSEN BY COMPUTING ITS ACTUAL PALETTE DISTANCES, not by eye.
     That matters: the first draft of this suite asserted that #5d6b4a abstains, and it
     was the TEST that was wrong - #5d6b4a really is olive (olive=35, runner-up 55), and
     an implementation that abstained on it would have been withholding a correct answer.
     Pick new cases the same way or they pin nothing. */

  /* (2) MARGIN. Three names inside 9 units - olive=46, grey=49, brown=55 - so "nearest"
     is a coin toss rather than a verdict. */
  is(api.colorLockSentence({ colorHex: "#7a6a55" }), "",
    "a colour sitting BETWEEN names abstains (olive 46 / grey 49 / brown 55)");

  /* (3) NEUTRAL CONSISTENCY - the gate a distance metric cannot express, and the one
     that was actually shipping wrong answers. RGB distance collapses desaturated colours
     onto the grey axis and grey then wins by a LARGE margin, so the distance and margin
     gates both pass it. Each of these would have shipped "The garment fabric is grey"
     for a garment that is visibly not grey - the clause repainting the garment it exists
     to protect. */
  const desaturatedButChromatic = [
    ["#6b8f7a", "a sage green (grey=26, margin 53)"],
    ["#9b7fa8", "a dusty mauve (grey=48, margin 30)"],
    ["#8a7f6d", "a warm taupe (grey=21, margin 55)"],
  ];
  for (const [hex, why] of desaturatedButChromatic) {
    is(api.colorLockSentence({ colorHex: hex }), "",
      `${why} must NOT be named grey - chroma disagrees with the neutral name`);
  }

  /* The gate must not over-fire in the other direction: a genuinely near-neutral colour
     still gets its neutral name, or every off-white tee loses the clause. */
  is(api.colorNameFromHex("#f8f8f5"), "white", "an off-white (chroma 3) still reads white");
  is(api.colorNameFromHex("#5d6b4a"), "olive", "a genuinely olive garment still reads olive");

  check("all three gates are real bounds, not effectively infinite",
    api.FABRIC_COLOR_MAX_DIST > 0 && api.FABRIC_COLOR_MAX_DIST < 200 &&
    api.FABRIC_COLOR_MIN_MARGIN > 0 &&
    api.FABRIC_NEUTRAL_CHROMA_MAX > 0 && api.FABRIC_NEUTRAL_CHROMA_MAX < 128,
    `dist=${api.FABRIC_COLOR_MAX_DIST} margin=${api.FABRIC_COLOR_MIN_MARGIN} chroma=${api.FABRIC_NEUTRAL_CHROMA_MAX}` +
    " - at ~441 (the cube diagonal) nothing would ever abstain");
}

console.log("\n── §4 IT RIDES AT P.LOW, BELOW THE FIT SENTENCE ──");
{
  const resolver = functionSource("imageOnlyPrompt").replace(/\/\*[\s\S]*?\*\//g, "");
  /* P.LOW (3) sheds before P.MED (2) in fitPrompt(), which is what makes this clause
     additive rather than a displacement of the size feature restored on 2026-09-03.
     Promoting it to P.MED or above silently trades that feature for this one on the
     branches with 7-10 free characters, so the tier is asserted literally. */
  check("the colour lock is tagged P.LOW",
    /\[P\.LOW, colorLockSentence\(item\)\],/.test(resolver), resolver);
  check("...and the fit sentence still rides ABOVE it, at P.MED",
    /\[P\.MED, fitSentence\(/.test(resolver) &&
    resolver.indexOf("P.MED, fitSentence") < resolver.indexOf("P.LOW, colorLockSentence"),
    "fitPrompt() breaks priority ties by array position, so the order is part of the guarantee");
  check("...and it is the LOWEST-priority part on the branch",
    !/\[P\.TRIM,/.test(resolver),
    "a P.TRIM part would shed before the colour lock and change what this suite proves");
}

console.log("\n── §5 THE VALUE IS PER-PRODUCT, NEVER BAKED INTO AN ANCHOR ──");
{
  /* The whole point of threading it: one product's measured colour must never become a
     literal inside a constant every other product also ships. */
  check("no colour name is hardcoded into either tops anchor",
    !/(PLAIN_TEE_ANCHOR|CATEGORY_ANCHOR)[\s\S]{0,700}?fabric is (white|black|navy|blue)/.test(SRC),
    "a colour in an anchor applies it to the entire catalog");
  check("the room reads the colour off the item, from the widget payload",
    /activeItem\.colorHex = e\.data\.garment_color_hex;/.test(SRC) &&
    /typeof e\.data\.garment_color_hex === "string"/.test(SRC),
    "a `||` here would collapse 'absent' and 'empty' into one case and lose the abstention");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
