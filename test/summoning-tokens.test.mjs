/* NO LIVE PROMPT MAY NAME A GARMENT OR ACCESSORY THE SHOPPER DID NOT PICK.

   REPORTED 2026-09-21: Decart renders hallucinated artifacts on cold start and through
   turns - "random necklaces, garbled text, incorrect prints" - and the fix requested was to
   suppress them by naming them: "ensure negative artifacts (unrequested jewelry, neck
   accessories, floating text) are suppressed via explicit conditioning parameters and
   prompt structural constraints".

   THAT EDIT WOULD CAUSE THE BUG IT IS MEANT TO FIX, and this repo has the receipt.
   @decartai/sdk@0.1.5's setInputSchema is exactly { prompt, enhance, image }: there is no
   negative_prompt, no image-strength, no ControlNet weight. So "no necklace, no jewelry,
   no floating text" does not ship as a prohibition - it ships inside the POSITIVE prompt,
   where NECKLACE and JEWELRY are tokens the sampler can steer toward. That is not a
   theory. image-first.test.mjs's header records DENSE.assetLock spelling out "never invent
   a garment, jacket, coat, suit, TUXEDO, tie, BOWTIE or badge" - and Decart streaming back
   a full tuxedo with a bowtie, twice, from a Spider-Man tee whose reference it had.

   WHY THIS SUITE EXISTS RATHER THAN ANOTHER COMMENT. The rule is written down in app.js in
   eight places and enforced in two: image-first.test.mjs pins it for FRONT_CLOSURE_LOCK and
   for the plain-tee clause, as literal checks against those two strings. Every other live
   branch - both back anchors, bottoms, the printed/plain rear selector, the full look - is
   guarded by nothing but the next author having read the right comment block. This asserts
   it across the whole matrix, as an ABSENCE, which is the form that catches a new
   well-meant line being added (CLAUDE.md 2.5b).

   WHAT IT DOES NOT BAN, deliberately. Negation OPERATORS are fine and several ship today:
   "without stretching or warping the fabric", "with no excess fabric", "clean break at the
   ankle with no pooling", and the full look's "Do NOT invent, add, or alter any details"
   and "never flatten or reset body size". None of them names an object, and an operator
   cannot be sampled into a picture. The tuxedo was not caused by the word "never" - it was
   caused by the word "TUXEDO" sitting next to it. So the invariant is about NOUNS: a live
   prompt may say what to do with the garment in the reference, and may not name a
   different garment or an accessory at all.

   Extracts the REAL builder, not a reimplementation. */
import { readFileSync } from "node:fs";

/* The prompt engine moved server-side on 2026-09-26 (lib/prompts.js, CLAUDE.md §2.13). SRC
   reads it FIRST and app.js after it, so the prompt slice below and every check on the
   engine's own text find it where it lives now, while the checks on the browser's dispatch
   sites still read app.js. */
const SRC = [
  readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8"),
  readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8"),
].join("\n").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* Same slice and sandbox as image-first.test.mjs - if that extraction breaks, both suites
   say so together rather than one silently testing nothing. */
const code = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                       SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: 650, console: { warn() {}, log() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
  colorName: () => "white",
  activeColorOf: (it) => (it && it.color) || "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { imageOnlyPrompt, fitPrompt, P, DENSE };")(...Object.values(sandbox));

check("§0 extracted the real builder", typeof api.imageOnlyPrompt === "function");

/* ── the branch matrix ────────────────────────────────────────────────────────
   Every shape imageOnlyPrompt() can return, named the way trace:prompt names them, so a
   failure points at a branch rather than at "the prompt". */
const BRANCHES = [
  ["top / front / structured",    { name: "Oxford Button-Down Shirt", garmentType: "upper_body", color: "#fff", subType: "long_sleeve" }, "front"],
  ["top / front / plain knit tee", { name: "Ion Crew Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" }, "front"],
  ["top / back (rear print)",     { name: "Ion Crew Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve", backIsPlain: false }, "back"],
  ["top / back (PLAIN rear)",     { name: "Ion Crew Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve", backIsPlain: true }, "back"],
  ["bottoms / front",             { name: "Glide Slim", garmentType: "lower_body", color: "#222" }, "front"],
  ["bottoms / back (rear print)", { name: "Glide Slim", garmentType: "lower_body", color: "#222", backIsPlain: false }, "back"],
  ["bottoms / back (PLAIN rear)", { name: "Glide Slim", garmentType: "lower_body", color: "#222", backIsPlain: true }, "back"],
];

const built = BRANCHES.map(([label, item, angle]) => [label, api.imageOnlyPrompt(item, angle)]);
check("§0.1 every branch built a non-empty prompt",
  built.every(([, p]) => typeof p === "string" && p.length > 0),
  JSON.stringify(built.map(([l, p]) => [l, (p || "").length])));

/* ── §1 summoning NOUNS ───────────────────────────────────────────────────────
   Two families, both from this file's own report history:
     · GARMENT CLASSES the reference cannot be - the literal tuxedo list.
     · ACCESSORIES - the 2026-09-21 report. A packshot contains no jewellery, so naming
       any of it can only add something.
   Generic nouns the anchors legitimately use (t-shirt, top, shirt, pants/shorts, fabric,
   neckline, placket, print) are NOT here: the anchor has to name the region it dresses. */
const SUMMONED = [
  // the tuxedo list, verbatim from DENSE.assetLock's recorded failure
  "tuxedo", "bowtie", "bow tie", "suit", "blazer", "jacket", "coat", "badge",
  // the 2026-09-21 accessory report
  "necklace", "jewellery", "jewelry", "pendant", "choker", "earring", "bracelet",
  "wristwatch", "scarf", "sunglasses", "handbag", "backpack",
];

for (const [label, prompt] of built) {
  const hits = SUMMONED.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(prompt));
  check(`§1 ${label} names no garment or accessory the shopper did not pick`,
    hits.length === 0,
    `summoned: ${hits.join(", ")} — with no negative_prompt these ship as POSITIVE tokens ` +
    `(image-first.test.mjs: "never invent a ... TUXEDO ... BOWTIE" rendered a tuxedo, twice)`);
}

/* ── §2 THE TUXEDO STRING IS STILL IN THE FILE, AND THAT IS FINE ─────────────
   DENSE.assetLock still carries "Never invent a garment, jacket, coat, suit, tuxedo, tie,
   bowtie or badge" verbatim - the exact text that rendered a tuxedo, twice. It is retained
   on purpose: CLAUDE.md §0 keeps the dead DENSE clauses as a restore seam rather than
   deleting them, and deleting history is how a lesson gets re-learned.

   SO THE INVARIANT IS REACHABILITY, NOT EXISTENCE. The danger was never that the sentence
   sits in the source; it is that restoring a clause is a one-line edit in imageOnlyPrompt()
   (§0's documented restore path), and THIS is the one clause whose restore is already known
   to have cost a live session. Assert it stays off every builder. */
{
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("§2.0 the assetLock text is still on file as a restore seam (CLAUDE.md §0)",
    /Never invent a garment, jacket, coat, suit, tuxedo, tie, bowtie or badge/.test(SRC),
    "if this fails the constant was deleted - that is a doc loss, not a fix; see §0");
  check("§2.1 ...and NO builder references it - the restore that shipped the tuxedo stays unmade",
    !/DENSE\.assetLock/.test(codeOnly),
    "one line in imageOnlyPrompt() is all it takes; image-first.test.mjs records what it cost");
  check("§2.2 ...and it is absent from every branch this suite builds",
    built.every(([, prm]) => !/tuxedo|bowtie/i.test(prm)),
    JSON.stringify(built.filter(([, prm]) => /tuxedo|bowtie/i.test(prm)).map(([l]) => l)));
}

/* ── §3 negation OPERATORS stay legal, and this is asserted so nobody "fixes" §1
       by widening it into a ban that the shipped prompts already violate ────────
   "without stretching or warping the fabric" ships on every single-garment branch today.
   getFitModifier is stubbed to "" in this sandbox, so the fit sentence's own "with no
   excess fabric" / "no pooling" are not in `built` - do not add them here without
   un-stubbing it, or this check starts asserting the sandbox rather than the prompt. */
{
  const all = built.map(([, prm]) => prm).join(" ");
  check("§3.1 the live prompts DO use a negation operator - proof §1 is about nouns, not grammar",
    /\bwithout\b/i.test(all),
    "if this ever fails, re-read §1's header before assuming the operators were the bug");
}

/* ── §4 the protocol fact the whole suite rests on ───────────────────────────── */
{
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("§4.1 nothing in app.js passes a negative_prompt - setInputSchema would strip it anyway",
    !/negative_prompt\s*:/.test(codeOnly),
    "set() accepts exactly { prompt, enhance, image }; an invented key is dropped silently, " +
    "so a prohibition written there is not enforced - it is just more positive text");
}

console.log(fails ? `\n${fails} check(s) failed.` : "\nsummoning-tokens: all checks passed.");
process.exit(fails ? 1 : 0);
