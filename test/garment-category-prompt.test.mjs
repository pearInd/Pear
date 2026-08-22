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
  code + "\nreturn { isBottomsGarment, imageOnlyPrompt, lookAnchorPrompt, fitPrompt, P };")(...Object.values(sandbox));

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
const bottomsPrompt     = imageOnlyPrompt(PANTS);           // angle defaults to "front"
const topsPrompt        = imageOnlyPrompt(SHIRT);
const bottomsBackPrompt = imageOnlyPrompt(PANTS, "back");
const topsBackPrompt    = imageOnlyPrompt(SHIRT, "back");

console.log("\n── §2 THE BOTTOMS ANCHOR: FRONT and BACK, both real strings now ──");
{
  /* ── REVISION: BACK_CATEGORY_ANCHOR IS REACHABLE - THREE REPORTS CLOSED THIS ────
     Every previous revision here left angle undifferentiated: the prompt described the
     front regardless of which side the image-swap had put on the wire. Three reports in a
     row traced back-render failures to exactly that - the back Blob was correctly on the
     wire while the prompt kept saying "front". imageOnlyPrompt(item, angle) now genuinely
     branches; this section proves both halves for bottoms. */
  check("FRONT opens by scoping to the reference, sourced as the active target",
    bottomsPrompt.indexOf("Fit the EXACT FRONT side of the target pants onto the subject's waist/front.") === 0,
    bottomsPrompt);
  check("BACK opens with its own distinct lead - not the front string reused",
    bottomsBackPrompt.indexOf("Fit the EXACT REAR/BACK side of the target pants onto the subject's back.") === 0 &&
    bottomsBackPrompt !== bottomsPrompt,
    bottomsBackPrompt);
  check("...and BACK locks rear print, logos and back-seams - the spec's own emphasis",
    /Precisely lock rear print, logos, and back-seams\./.test(bottomsBackPrompt), bottomsBackPrompt);
  check("both carry the 1:1/zero-distortion clause, adopted verbatim from spec",
    /Maintain 1:1 body ratio without distortion\./.test(bottomsPrompt) &&
    /Maintain 1:1 body ratio without distortion\./.test(bottomsBackPrompt),
    `front=${bottomsPrompt}\n        back=${bottomsBackPrompt}`);
  check("both preserve the opposite layer AND the background, unchanged",
    /Strictly preserve the user's natural proportions, face, upper body, and background\./.test(bottomsPrompt) &&
    /Strictly preserve the user's natural proportions, face, upper body, and background\./.test(bottomsBackPrompt),
    `front=${bottomsPrompt}\n        back=${bottomsBackPrompt}`);
  check("...and never claims the upper garment as the thing to FIT, on either side",
    !/target shirt/.test(bottomsPrompt) && !/target shirt/.test(bottomsBackPrompt),
    `front=${bottomsPrompt}\n        back=${bottomsBackPrompt}`);
  check("both prompts stay minimal - three sentences, not an assembly",
    bottomsPrompt.length <= 420 && bottomsBackPrompt.length <= 420,
    `front=${bottomsPrompt.length} back=${bottomsBackPrompt.length} chars`);
}

console.log("\n── §3 THE TOPS ANCHOR: the exact mirror, per region AND per side ──");
{
  check("FRONT opens by scoping to the reference shirt",
    topsPrompt.indexOf("Fit the EXACT FRONT side of the target shirt onto the subject's chest/front.") === 0,
    topsPrompt);
  check("BACK opens with its own distinct lead",
    topsBackPrompt.indexOf("Fit the EXACT REAR/BACK side of the target shirt onto the subject's back.") === 0 &&
    topsBackPrompt !== topsPrompt,
    topsBackPrompt);
  check("...and carries the same rear-lock sentence as the bottoms BACK anchor",
    /Precisely lock rear print, logos, and back-seams\./.test(topsBackPrompt), topsBackPrompt);
  check("...and pins the LOWER clothing plus background - the mirror of bottoms",
    /Strictly preserve the user's natural proportions, face, lower body, and background\./.test(topsPrompt) &&
    /Strictly preserve the user's natural proportions, face, lower body, and background\./.test(topsBackPrompt),
    `front=${topsPrompt}\n        back=${topsBackPrompt}`);

  /* ── SYMMETRY, asserted on all four strings at once ────────────────────────
     A fix applied to one branch/side and forgotten on another is this file's recurring
     regression, so the shared shape is checked once here rather than inferred. */
  check("all four (tops/bottoms × front/back) open on the same exclusive-scope binding",
    topsPrompt.startsWith("Fit the EXACT FRONT side of the target ") &&
    bottomsPrompt.startsWith("Fit the EXACT FRONT side of the target ") &&
    topsBackPrompt.startsWith("Fit the EXACT REAR/BACK side of the target ") &&
    bottomsBackPrompt.startsWith("Fit the EXACT REAR/BACK side of the target "),
    [topsPrompt, bottomsPrompt, topsBackPrompt, bottomsBackPrompt].join("\n        "));
  check("...all four carry the 1:1 clause; only the two BACK strings carry the rear-lock",
    [topsPrompt, bottomsPrompt, topsBackPrompt, bottomsBackPrompt].every((p) =>
      /Maintain 1:1 body ratio without distortion\./.test(p)) &&
    /Precisely lock rear print/.test(topsBackPrompt) && /Precisely lock rear print/.test(bottomsBackPrompt) &&
    !/Precisely lock rear print/.test(topsPrompt) && !/Precisely lock rear print/.test(bottomsPrompt),
    "the rear-lock sentence is what makes a BACK render different in kind, not just in one word");
  check("...and neither preserves the very layer it is fitting, on any of the four",
    !/preserve[^.]*upper body/.test(topsPrompt) && !/preserve[^.]*upper body/.test(topsBackPrompt) &&
    !/preserve[^.]*lower body/.test(bottomsPrompt) && !/preserve[^.]*lower body/.test(bottomsBackPrompt),
    "a prompt that preserves the layer it is editing cancels itself");

  /* ── WHAT THE PROMPT ALONE CANNOT DO, AND WHAT STILL CANNOT BE HELPED ─────────
     Named here rather than left to be discovered: the prompt describes a side, it does
     not select one. buildPrompt() discarding its angle argument WAS the reported bug;
     the fix threads a frozen snapshot through, never a live re-read. And the honest
     limit from the previous revision survives unchanged: an item with no real back photo
     still never computes angle==="back" at all, so BACK_CATEGORY_ANCHOR being reachable
     here does not mean every item can reach it. */
  check("app.js records that buildPrompt() now threads angle rather than discarding it",
    /buildPrompt\(item, angle = "front"\) \{\s*\n\s*return imageOnlyPrompt\(item, angle\);/.test(SRC),
    "a declared-but-unused parameter is the exact regression three reports were filed against");
  check("...and that the selection is a frozen snapshot, never a live re-read",
    /buildPrompt\(item, angleAtStart\)/.test(SRC) && !/buildPrompt\(item, effectiveAngle\(\)\)/.test(SRC),
    "a live read here would reopen the TOCTOU race angle-race.test.mjs was written to close");
  check("...and names the gap that remains: no back photo means no back angle, ever",
    /THE ONE GAP THIS REVISION DOES NOT CLOSE/.test(SRC) &&
    /canCombineViews\(\) still gates AI Auto on/.test(SRC),
    "an honest limit belongs on file, not just in a chat reply");
}

console.log("\n── §4 THE CONTRADICTION IS GONE: no t-shirt anchor on a trouser reference ──");
{
  /* The single most important assertion in this file. The old frozen string opened by
     naming a t-shirt; on a bottoms item that is the bug, stated in the first six words. */
  check("the BOTTOMS prompt never names a t-shirt / shirt as the garment to fit",
    !/Fit a standard t-shirt/.test(bottomsPrompt) && !/fit a t-shirt/i.test(bottomsPrompt),
    bottomsPrompt);
  /* This used to assert the two branches were different strings. They are the same string
     now - deliberately, see §3 - so what survives is the half that still means something:
     whichever route is taken, the anchor never names the WRONG garment, because it names
     no garment type at all. */
  check("neither route can name the wrong garment - the anchor names no garment type",
    !/t-shirt/i.test(bottomsPrompt) && !/\bshirt\b/i.test(bottomsPrompt) &&
    !/\bpants\b/i.test(topsPrompt),
    `tops=${topsPrompt}\n        bottoms=${bottomsPrompt}`);
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
  /* Still routed through fitPrompt() at ~169 chars, which looks redundant and is not: it
     normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit that lengthens
     an anchor is clamped here rather than over-running into clampPromptForWire()'s hard
     slice - which cuts at the END, taking the "do NOT invent" sentence with it. */
  check("both branches are assembled through fitPrompt(), not returned raw",
    /const table = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;\s*\n\s*return fitPrompt\(\[\s*\n\s*\[P\.CORE, isBottomsGarment\(item\) \? table\.bottom : table\.top\],\s*\n\s*\[P\.HIGH, STRICT_REFERENCE_LOCK\],\s*\n\s*\]\);/.test(SRC),
    "a raw return skips the budget clamp and the whitespace normaliser");
  /* The selected anchor is the one clause that must NEVER shed - it is the entire fix,
     for BOTH the category axis and (now) the front/back axis: whichever table `angle`
     selected, the P.CORE tag is what stops it being dropped under budget pressure. */
  check("the selected anchor is tagged P.CORE so it can never be shed",
    /\[P\.CORE, isBottomsGarment\(item\) \? table\.bottom : table\.top\]/.test(SRC),
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

  /* ── THE EXEMPTION IS FROM THE SCOPING, NOT FROM THE STRICT LOCK ────────────
     For one revision it was from both, and that was the gap: the 1:1 collapse rewrote the
     two category anchors around the invent/add/alter clamp and left this path on its old
     four-clause assembly, so the INVENTED-DETAIL report - the right garment rendered with
     textures the reference never had - stayed reproducible through Full Look while being
     fixed everywhere else. Nothing about that failure depends on how many garments are
     being replaced. Asserted on the RENDERED prompt, because a constant that is assembled
     out of the assembly is not the thing that ships. */
  const look = api.lookAnchorPrompt();
  check("the full-look prompt carries the same match clause as the two branches",
    /Exactly match color, pattern, logos, and cut\./.test(look), look);
  check("...and the same invent/add/alter hallucination clamp",
    /Do NOT invent, add, or alter any details\./.test(look), look);
  check("...stated ONCE - the superseded extraction sentence went with it, not beside it",
    !/Use only the reference image's graphics/.test(look) &&
    (look.match(/Exactly match color/g) || []).length === 1,
    "two provenance sentences spend budget restating one instruction - the mechanism itself");
  /* ── THE PANEL CLAUSE, AND WHAT IT COST ────────────────────────────────────
     THE HOLE IT CLOSES: this path ships a STITCHED reference - two garment panels
     stacked vertically - and for several revisions the prompt said nothing at all about
     that layout. buildLookPrompt() takes an `angleText` argument and applyLook() passes
     DENSE.lookPanels into it, but the function returns lookAnchorPrompt() without ever
     reading it, so the explaining clause was never on the wire.

     IT BECAME LOAD-BEARING when the stitcher's black separator bar came out (see
     LOOK_DIVIDER in app.js - the bar was being reproduced onto the shopper as a split
     frame). That bar was doing two jobs: it was the defect, and it was also the only
     signal that the reference held two separate garments. So this is a straight swap of a
     VISUAL instruction the model copies into its output for a TEXTUAL one it can follow
     without copying, and the two halves must ship together - hence both asserted here. */
  check("the stacked-panel layout is EXPLAINED on the wire, not left to be inferred",
    /The reference stacks two garments; render both at once in one continuous frame\./.test(look),
    look);
  check("...and reproducing that layout into the video is banned in the same breath",
    /Never draw its panel gap or bars into the video\./.test(look), look);
  check("...paired with the stitcher no longer PAINTING a bar to be copied",
    /const LOOK_DIVIDER = 0;/.test(SRC) && !/High-contrast 200px SOLID BLACK separator bar/.test(SRC),
    "the prompt half and the pixel half are one fix - neither works alone");

  /* THE VOLUME CLAUSE SURVIVES; THE HEM CLAUSE IS THE PRICE. The assembly runs past the
     budget with the panel clause in, so fitPrompt() sheds the lowest-priority part - which
     is what the P tiers exist for. CLOSED_BACK_HEM is P.MED precisely because it was
     always meant to go first. Asserted as a PAIR (one kept, one shed) rather than left to
     be discovered, because a silent shed is how this file's budget notes went stale
     before: if a knotted hem or open back is reported on the FULL-LOOK path specifically,
     this is the trade that did it. */
  check("...the 360-degree volume clause is kept - it is what a both-layer render needs most",
    /360-degree rotations/.test(look), look);
  check("...and CLOSED_BACK_HEM is the documented shed, not a silent one",
    !/un-knotted hem/.test(look) && /CLOSED_BACK_HEM \("closed back and normal un-knotted hem"\) is/.test(SRC),
    "the loss has to be on file in app.js next to the clause that caused it");
  check(`...and the whole thing lands inside the ${CONFIG.PROMPT_MAX_CHARS}-char budget`,
    look.length <= CONFIG.PROMPT_MAX_CHARS, `${look.length} chars`);

  /* ── THE KEEP-ALIVE PING RESOLVES THE SAME TWO WAYS THE APPLY PATH DOES ─────
     It is a real dispatch on the live session (see composite.test.mjs §5), fired from the
     frame-freeze watchdog and deliberately bypassing applyGarment() - which also means it
     never updates lastSentPrompt, so anything wrong it sends STAYS on the wire until the
     next explicit apply. Two resolutions therefore have to hold, not one:

       PER CATEGORY - re-asserting a tops anchor over a live trouser session is the bug
       this whole file exists for, arriving through the recovery path.
       PER LOOK - this one was missing. applyActive() branches on resolveLook() before
       choosing applyLook() vs applyGarment(); the ping did not, so an 800ms stall during
       an "Add to Look" session pushed a SINGLE-garment prompt over a two-garment payload.
       Harmless while both anchors were bare; not harmless once bottoms carried lower-body
       scoping, because a single-garment bottoms anchor tells the model the upper body is
       not its business - which, mid-look, means the look's top stops being rendered.

     Asserted on the shape of the ping itself rather than on one flat regex, so neither
     branch can be dropped without failing here. */
  const ping = (SRC.match(/const keepAliveLook = resolveLook\(\);[\s\S]{0,400}?"freezeKeepAlive"\);/) || [""])[0];
  check("the freeze keep-alive ping branches on resolveLook() like applyActive() does",
    /buildLookPrompt\(keepAliveLook\.top, keepAliveLook\.bottom\)/.test(ping),
    ping || "no resolveLook()-guarded keep-alive found - a look session gets a single-garment prompt");
  check("...and falls back to the category resolver for a single garment",
    /imageOnlyPrompt\(activeItem\)/.test(ping),
    "recovery must not re-assert a t-shirt over a trouser session");
  check("...and both branches go through the wire clamp, not around it",
    /clampPromptForWire\(/.test(ping) && ping.trim().endsWith('"freezeKeepAlive");'),
    ping);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
