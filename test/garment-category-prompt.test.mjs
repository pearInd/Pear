/* "I tried on JEANS and it put the catalog model's SHIRT on me."

   ROOT CAUSE, and it is not a model hallucination. Under strict image-only conditioning
   (see image-first.test.mjs) every builder returned ONE frozen string, byte-identical for
   every garment in the catalog:

     "Fit a standard t-shirt from the reference image onto the subject ..."

   That sentence is a TOPS anchor. Sent against a trouser packshot it is a direct
   contradiction: the prompt names a t-shirt, the reference photographs a model wearing a
   shirt AND trousers, and nothing anywhere tells the model which half of that reference is
   the product. So Lucy took the whole visual - and the source model's shirt landed on the
   shopper, replacing the real one they were still wearing on camera.

   run.mjs's own suite index already named this gap before it was fixed: "an 'upper
   garment' anchor on a trouser reference is the same contradiction". This suite is that
   contradiction closed.

   THE FIX IS A BRANCH, NOT A NEW CLAUSE. The prompt now resolves per garment category:
   the anchor names the target layer and pins the OPPOSITE layer to the live camera. That
   restores, in the one channel this SDK exposes, what KEEP_TOP/KEEP_BOTTOMS used to do
   before the image-first retirement - but scoped to the anchor itself, where it cannot be
   shed, rather than as one more competing clause.

   WHAT THIS SUITE PINS, and why each is a distinct way for the fix to rot:
     §1  classification: garmentType is AUTHORITATIVE, keywords are the fallback, and
         "short_sleeve" must never read as "shorts" (the obvious regex trap);
     §2  the bottoms prompt isolates the lower garment and preserves the live top;
     §3  the tops prompt isolates the upper garment and preserves the live bottoms;
     §4  neither branch can ever name a t-shirt on a trouser reference again;
     §5  both branches fit PROMPT_MAX_CHARS - the budget is Decart's, not ours, and a
         rejected prompt is a dead session (see clampPromptForWire);
     §6  EVERY builder branches. A single builder left returning a constant is the whole
         bug, reintroduced at one call site - which this file's history records happening
         before, for STRICT_INPAINT.

   Sibling suites: image-first.test.mjs owns the retirement of the assembled clauses and
   the image-anchor contract; outfit-slot-isolation.test.mjs owns the SLOT state that
   decides which builder runs at all. This one owns only the text those two hand to Decart. */
import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real prompt layer, executed - same slice and same sandbox image-first.test.mjs
   uses, so the two suites can never drift onto different copies of the code. */
const code = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                       SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: CONFIG.PROMPT_MAX_CHARS, console: { warn() {}, log() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
  colorName: () => "white",
  activeColorOf: (it) => (it && it.color) || "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "regular fit", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { isBottomsGarment, imageOnlyPrompt, fitPrompt, P };")(...Object.values(sandbox));

const { isBottomsGarment, imageOnlyPrompt } = api;

console.log("── §1 CLASSIFICATION: garmentType wins, keywords are the fallback ──");
{
  /* garmentType is what toItem() sets and what slotOf() already routes on. When it is
     present it is GROUND TRUTH - a keyword sweep that can override it would let a product
     NAME re-categorise an item the catalog already classified, which is strictly worse
     than the metadata it would be second-guessing. */
  check("garmentType 'lower_body' classifies as bottoms",
    isBottomsGarment({ garmentType: "lower_body", name: "Glide Slim" }) === true);
  check("garmentType 'upper_body' classifies as tops",
    isBottomsGarment({ garmentType: "upper_body", name: "Ion Crew Tee" }) === false);
  /* THE OVERRIDE TEST. A tee legitimately named "Short Sleeve" carries the token
     "short" - if a keyword sweep outranked garmentType, this item becomes trousers and
     the shopper's real jeans get repainted. This is the exact inversion of the bug. */
  check("an explicit upper_body garmentType BEATS a bottoms-looking name",
    isBottomsGarment({ garmentType: "upper_body", name: "Cargo Pants Print Tee" }) === false,
    "metadata must outrank a keyword sweep, never the reverse");

  console.log("   -- the keyword fallback, for items with no garmentType --");
  check("item.type 'pants' classifies as bottoms",
    isBottomsGarment({ type: "pants" }) === true);
  check("item.category 'bottoms' classifies as bottoms",
    isBottomsGarment({ category: "Bottoms" }) === true);
  check("English title keywords: jeans / trousers / shorts / skirt / leggings",
    isBottomsGarment({ name: "Slim Fit Jeans" }) === true &&
    isBottomsGarment({ name: "Wool Trousers" }) === true &&
    isBottomsGarment({ name: "Cargo Shorts" }) === true &&
    isBottomsGarment({ title: "Pleated Skirt" }) === true &&
    isBottomsGarment({ name: "Ribbed Leggings" }) === true);
  /* Hebrew is the storefront's primary language (every user-facing string in this
     codebase is bilingual), so a Hebrew-only product title is the COMMON case here,
     not an edge case. Both geresh spellings, because storefronts use them
     interchangeably: U+05F3 (׳) and a plain ASCII apostrophe. */
  check("Hebrew title keywords: מכנס / ג'ינס / חצאית / שורט / טייץ",
    isBottomsGarment({ name: "מכנסיים קצרים" }) === true &&
    isBottomsGarment({ name: "ג'ינס סקיני" }) === true &&
    isBottomsGarment({ name: "ג׳ינס סקיני" }) === true &&
    isBottomsGarment({ name: "חצאית מידי" }) === true &&
    isBottomsGarment({ name: "שורט דנים" }) === true &&
    isBottomsGarment({ name: "טייץ ספורט" }) === true);

  console.log("   -- and what must NOT trip it --");
  /* THE REGEX TRAP, tested as its own case because it is the one a careless \bshorts?\b
     walks straight into: subType "short_sleeve" and the Hebrew "שרוול קצר" are TOPS. */
  check("'short_sleeve' subType does NOT read as 'shorts'",
    isBottomsGarment({ subType: "short_sleeve", name: "Ion Crew Tee" }) === false,
    "the classic false positive - 'short' is a substring of 'short_sleeve'");
  check("a plain shirt/jacket/dress classifies as tops",
    isBottomsGarment({ name: "Oxford Shirt" }) === false &&
    isBottomsGarment({ name: "Bomber Jacket" }) === false &&
    isBottomsGarment({ name: "חולצת פולו" }) === false);
  check("null / undefined / empty item defaults to TOPS, never throws",
    isBottomsGarment(null) === false && isBottomsGarment(undefined) === false &&
    isBottomsGarment({}) === false,
    "tops is the safe default: it is the overwhelming majority of the catalog");
}

const PANTS = { garmentType: "lower_body", name: "Glide Slim" };
const SHIRT = { garmentType: "upper_body", name: "Ion Crew Tee" };
const bottomsPrompt = imageOnlyPrompt(PANTS);
const topsPrompt    = imageOnlyPrompt(SHIRT);

console.log("\n── §2 THE BOTTOMS PROMPT: isolate the lower garment, preserve the live top ──");
{
  /* ── REVISION: ULTRA-MINIMAL, REFERENCE-LOCKED ──────────────────────────────
     REPORTED WITH A SCREENSHOT: a white/cream basketball short rendered as generic BLACK
     shorts. The reference was correct, delivered and in the payload - the model simply
     was not copying it. That is not a new failure, it is the tuxedo failure through the
     lower-body branch, and this file's own history already names the mechanism: with no
     negative_prompt and no image-strength on Decart's set(), the ONLY lever over how hard
     the image is weighed against the text is HOW MUCH TEXT THERE IS.

     The bottoms branch had grown back to 616 characters across six sentences - four of
     them about body volume, temporal tracking and layer preservation rather than about
     the garment. Reduced to ONE instruction that says only "copy this exact thing",
     stated three ways (fit it / copy its pattern, colour, stripes, design / do not invent
     one). 258 characters, a 58% cut, and the whole of it is now about the reference.

     WHAT THIS DELIBERATELY DROPS is asserted below rather than left to be discovered:
     the 360-degree volume clause and the "as soon as visible" temporal directive are both
     gone from BOTTOMS ONLY. A correct garment with imperfect volume beats a wrong garment
     with perfect volume, and the screenshot is of a wrong garment. */
  check("opens by locking onto the EXACT reference garment, nothing before it",
    bottomsPrompt.indexOf("Fit strictly the exact shorts/pants shown in the reference image onto the subject's lower body.") === 0,
    bottomsPrompt);
  check("...names the visual attributes to copy, so 'exact' has something to bind to",
    /Copy the exact pattern, color, stripes, and design from the reference image/.test(bottomsPrompt),
    "'exact garment' is abstract; pattern/colour/stripes/design are what the model matches on");
  check("...forbids substituting an invented pair - the reported failure, stated directly",
    /without inventing new shorts/.test(bottomsPrompt), bottomsPrompt);
  check("...and still pins the untouched layers",
    /Keep the subject's upper body and background unmodified\./.test(bottomsPrompt),
    bottomsPrompt);

  /* THE SIZE PROPERTY IS THE FIX, so it is asserted as a number rather than trusted to
     stay small because someone remembered why. Every clause added back here is weight
     against the reference pixels - which is the mechanism that produced both the tuxedo
     and the black shorts. */
  check("the bottoms prompt is ULTRA-MINIMAL - one instruction, not an assembly",
    bottomsPrompt.length <= 300,
    `${bottomsPrompt.length} chars - was 616 across six sentences before this revision`);
  check("...and carries NO body-volume or temporal clause - the deliberate trade",
    !/360-degree rotations/.test(bottomsPrompt) && !/as soon as visible/.test(bottomsPrompt),
    "dropped on purpose: a correct garment with imperfect volume beats a wrong garment");
}

console.log("\n── §3 THE TOPS PROMPT: isolate the upper garment, preserve the live bottoms ──");
{
  check("commands replacement of ONLY the upper garment",
    /Fit and replace ONLY the subject's upper garment \(shirt\/top\) using the exact upper garment from the reference image\./.test(topsPrompt),
    topsPrompt);
  check("strictly preserves the shopper's LIVE lower garment",
    /Strictly preserve the subject's live pants\/lower garment as seen on camera\./.test(topsPrompt),
    topsPrompt);
  /* THE BRANCHES ARE NO LONGER SYMMETRIC, deliberately - see CATEGORY_ANCHOR.bottom.
     Bottoms was collapsed to a single reference-lock instruction after the black-shorts
     report; tops keeps its assembly because nothing has been reported against it. Each
     branch still names the region it replaces, which is the property that matters. */
  check("...and each branch names the region it replaces",
    /upper garment \(shirt\/top\)/.test(topsPrompt) &&
    /shorts\/pants/.test(bottomsPrompt) && /lower body/.test(bottomsPrompt), topsPrompt);
  check("...and tops is the branch that still carries the full clause assembly",
    topsPrompt.length > bottomsPrompt.length * 2,
    `tops=${topsPrompt.length} bottoms=${bottomsPrompt.length} - collapse tops only on a report`);
}

console.log("\n── §4 THE CONTRADICTION IS GONE: no t-shirt anchor on a trouser reference ──");
{
  /* The single most important assertion in this file. The old frozen string opened by
     naming a t-shirt; on a bottoms item that is the bug, stated in the first six words. */
  check("the BOTTOMS prompt never names a t-shirt / shirt as the garment to fit",
    !/Fit a standard t-shirt/.test(bottomsPrompt) && !/fit a t-shirt/i.test(bottomsPrompt),
    bottomsPrompt);
  check("the two branches are genuinely DIFFERENT strings",
    bottomsPrompt !== topsPrompt);
  /* Symmetry: each branch must pin the layer the other one replaces, and neither may
     claim to preserve the layer it is itself editing. */
  check("neither prompt preserves the very layer it is replacing",
    !/preserve the subject's live lower garment/i.test(bottomsPrompt) &&
    !/preserve the subject's live upper garment/i.test(topsPrompt));
}

console.log("\n── §5 THE BUDGET: Decart's ceiling, not ours ──");
{
  /* app.js:5862 - "do not raise PROMPT_MAX_CHARS to make one fit - the ceiling is the
     API's, not ours." Decart hard-rejects >226 tokens and a rejected prompt is a session
     that dies before the first frame, so this is a hard gate, not a style preference. */
  check(`the bottoms prompt fits the ${CONFIG.PROMPT_MAX_CHARS}-char budget`,
    bottomsPrompt.length <= CONFIG.PROMPT_MAX_CHARS, `${bottomsPrompt.length} chars`);
  check(`the tops prompt fits the ${CONFIG.PROMPT_MAX_CHARS}-char budget`,
    topsPrompt.length <= CONFIG.PROMPT_MAX_CHARS, `${topsPrompt.length} chars`);
  /* Built through fitPrompt() rather than concatenated, so that if someone later
     lengthens the anchor the LOWEST-priority clause sheds automatically instead of the
     whole prompt silently overrunning into clampPromptForWire()'s hard slice - which
     would cut mid-sentence, at the end, where the extraction clause lives. */
  /* BOTH branches still route through fitPrompt(), even the single-clause bottoms one.
     That is not ceremony: fitPrompt() is what normalises whitespace and enforces the
     budget, so a future edit that lengthens the bottoms anchor is clamped rather than
     silently over-running into clampPromptForWire()'s hard slice. Asserted per branch,
     because "the function mentions fitPrompt somewhere" would pass even if one branch
     had been changed to return a bare literal. */
  check("the BOTTOMS branch is assembled through fitPrompt(), not returned raw",
    /if \(bottoms\) return fitPrompt\(\[\[P\.CORE, CATEGORY_ANCHOR\.bottom\]\]\);/.test(SRC),
    "a raw return skips the budget clamp and the whitespace normaliser");
  check("...and so is the TOPS branch",
    /return fitPrompt\(\[\s*\n\s*\[P\.CORE, CATEGORY_ANCHOR\.top\]/.test(SRC),
    "concatenation cannot shed a clause; fitPrompt() can");
  /* The category anchor is the one clause that must NEVER shed - it is the entire fix. */
  check("the category anchor is tagged P.CORE so it can never be shed",
    /\[P\.CORE,\s*(bottoms|isBottoms)[^\]]*ANCHOR|\[P\.CORE,\s*CATEGORY_ANCHOR/.test(SRC),
    "if the anchor can shed, the bug comes back under budget pressure");
}

console.log("\n── §6 EVERY BUILDER BRANCHES - one constant left is the bug, reintroduced ──");
{
  /* Stated as an ABSENCE, the only form that catches a NEW builder being added that
     forgets to branch. This file's own history records STRICT_INPAINT being missed at
     exactly one of six sites, which is why parity is asserted rather than assumed. */
  const bare = (SRC.match(/^\s*return IMAGE_ONLY_PROMPT;\s*$/gm) || []).length;
  check("NO builder returns a bare category-blind constant any more",
    bare === 0, `${bare} builder(s) still return the frozen tops-only string`);

  for (const fn of ["buildPrompt", "buildCustomPrompt", "buildCompositePrompt"]) {
    const start = SRC.indexOf(`function ${fn}(`);
    const body = SRC.slice(start, SRC.indexOf("\n}", start));
    check(`${fn}() resolves its prompt per garment category`,
      /imageOnlyPrompt\(/.test(body), body.slice(0, 300));
  }

  /* The full-look builder is the deliberate exception and is asserted as such: it
     replaces BOTH layers on purpose (addToLook()'s explicit two-garment payload), so a
     preserve-the-other-layer directive there would contradict the thing being asked for. */
  const lookStart = SRC.indexOf("function buildLookPrompt(");
  const lookBody = SRC.slice(lookStart, SRC.indexOf("\n}", lookStart));
  /* Asserted on the RETURN, not on the mere absence of the identifier: the body
     legitimately NAMES imageOnlyPrompt() in the comment explaining why it does not call
     it, and a test that cannot tell a call from an explanation would forbid documenting
     the decision - the opposite of what this suite is for. */
  check("buildLookPrompt() is EXEMPT - it substitutes both layers by design",
    /return lookAnchorPrompt\(\);/.test(lookBody) && !/return imageOnlyPrompt\(/.test(lookBody),
    "a full-look payload must not be told to preserve the layer it is replacing");
  check("...and the full-look anchor claims BOTH layers rather than isolating one",
    /Fit and replace BOTH the subject's upper garment and lower garment/.test(SRC));

  /* The keep-alive ping is a real dispatch on the live session (see composite.test.mjs
     §5). Sending a tops anchor there during a trouser session is the SAME contradiction
     through the recovery path, so it has to resolve per category too. */
  check("the freeze keep-alive ping is category-aware, not the frozen tops string",
    /clampPromptForWire\(imageOnlyPrompt\([^)]*\), "freezeKeepAlive"\)/.test(SRC),
    "recovery must not re-assert a t-shirt over a trouser session");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
