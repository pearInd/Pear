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
  code + "\nreturn { isBottomsGarment, bottomsLength, foldGeresh, imageOnlyPrompt, lookAnchorPrompt, fitPrompt, BOTTOMS_REFERENCE_BIND, P };")(...Object.values(sandbox));

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
  /* ── REVISION: DYNAMIC BODY, STATIC GARMENT ─────────────────────────────────
     THE HISTORY THIS BRANCH CARRIES, in order, because each revision answered a real
     screenshot and the current wording is the sum of them:
       · 616 characters across six sentences, four of them about body volume and layer
         preservation rather than about the garment;
       · cut to a bare reference lock after a white/cream basketball short rendered as
         generic BLACK shorts - the tuxedo failure through the lower-body branch, and the
         mechanism is this file's own: with no negative_prompt and no image-strength on
         Decart's set(), the ONLY lever over how hard the image is weighed against the
         text is HOW MUCH TEXT THERE IS;
       · cut again to the strict 1:1 form both branches shared, after invented detail
         appeared on the CORRECT garment;
       · re-scoped to the lower body after a trouser try-on repainted the shopper's live
         top - "onto the subject" names a garment but no region.

     THE CURRENT REVISION ANSWERS A DIFFERENT FAILURE ENTIRELY: the fit was right at
     0 degrees and then STRETCHED over the shopper as they turned. So the wording now
     states, in one sentence, that the garment is EXACT and STATIC while the body it is
     drawn on is CURRENT and per-frame - and it names the lower-body contour where the
     previous revision named the lower body, so the re-scoping above survives intact.
     320 characters against a 650 ceiling.

     WHAT IT DROPPED is asserted below rather than left to be discovered: the
     invent/add/alter clamp and the explicit "keep the upper body unmodified" pin. Both
     are retired-with-a-restore-path in app.js; image-first.test.mjs §1 owns that table. */
  /* ── THE LEAD CHANGED 2026-08-24, AND THE LEAD IS THE POINT ─────────────────
     The passthrough sentence now opens both branches; the substitution follows it. Same
     two sentences, same bytes, other order - see CATEGORY_ANCHOR's own note. What these
     checks pin is unchanged in KIND: each branch still opens on a fixed, known sentence
     and nothing may be inserted before it. Which sentence that is became the fix. */
  check("opens on the non-target passthrough, nothing before it",
    bottomsPrompt.indexOf("For any upper body parts, torso, or shirt that enter the camera frame") === 0,
    bottomsPrompt);
  /* The substitution moved, it did not go away - pinned so a future edit cannot drop it
     while still satisfying the lead check above. */
  check("...and still scopes to ONE garment and ONE region, just after it",
    bottomsPrompt.includes("Fit ONLY the reference pants/shorts onto the subject's lower body."),
    bottomsPrompt);
  /* THE SCOPING SURVIVED THE REWRITE, and that is what this pair of checks is for: the
     region naming moved INTO the lead rather than being dropped with the pin. */
  check("...scopes the fit to the LOWER BODY, keeping the shirt-replacement report closed",
    /onto the subject's lower body\./.test(bottomsPrompt),
    "an unscoped anchor is what let a trouser try-on claim the whole reference");
  check("...and never claims the upper garment as the thing to FIT",
    !/reference shirt/.test(bottomsPrompt) && !/onto the subject's upper torso/.test(bottomsPrompt),
    bottomsPrompt);
  /* THE PER-FRAME INSTRUCTION, which is the sentence this revision exists for. Both
     halves are asserted: adapt to the live shape, and do not fake it by deforming cloth. */
  /* THE NON-TARGET LOCK, aimed at the MOMENT it fails. Step back mid-session in a trouser
     try-on and the torso enters frame; the previous wording described the region but not
     its arrival, so at t=0 - when the torso was out of shot - it had nothing to point at. */
  check("...names the ENTRY of the upper body mid-video, not just the region",
    /For any upper body parts, torso, or shirt that enter the camera frame during the video/
      .test(bottomsPrompt), bottomsPrompt);
  check("...and routes it to the LIVE camera feed by name, with length among the attributes",
    /pass through and strictly preserve the subject's LIVE camera feed clothing \(color, pattern, length\)/
      .test(bottomsPrompt), bottomsPrompt);
  /* NOT $-ANCHORED: STRICT_REFERENCE_LOCK now closes both branches (colour-drift report). */
  check("...banning generation, replacement AND invention of a top",
    /without generating, replacing, or inventing any new top or garments\./
      .test(bottomsPrompt), bottomsPrompt);

  /* THE SIZE PROPERTY IS STILL A FIX, so it is asserted as a number rather than trusted
     to stay small because someone remembered why. It grew by 81 characters here, and that
     is the deliberate spend of this revision: the per-frame instruction is the only thing
     that was bought, and image-first.test.mjs §1 pins that it is exactly three sentences. */
  /* CEILING 360 → 420 → 480 → 620, each step for ONE named clause and only that clause:
     STRICT_REFERENCE_LOCK, then DENSE.inpaintLock, then BOTTOMS_REFERENCE_BIND (the hem
     and product-detail lock - see §7). The branch runs 581 unknown / 607 short, so this
     still fails on the next unbudgeted addition. "Minimal" stays a number somebody has to
     raise deliberately, and it is deliberately NOT the 700 budget: 700 is what Decart
     accepts, this is what the file is willing to spend. */
  check("the bottoms prompt stays minimal - seven instructions, not an assembly",
    bottomsPrompt.length <= 680,
    `${bottomsPrompt.length} chars - was 616 across six sentences four revisions ago`);
  check("...and carries NO body-volume or temporal clause - the deliberate trade",
    !/360-degree rotations/.test(bottomsPrompt) && !/as soon as visible/.test(bottomsPrompt),
    "dropped on purpose: a correct garment with imperfect volume beats a wrong garment");
}

console.log("\n── §3 THE TOPS PROMPT: the same split, whole-body contour ──");
{
  check("opens on the non-target passthrough, nothing before it",
    topsPrompt.indexOf("For any lower body parts, legs, or shorts that enter the camera frame") === 0,
    topsPrompt);
  check("...and still scopes to the reference shirt and the upper TORSO, just after it",
    topsPrompt.includes("Fit ONLY the reference shirt onto the subject's upper torso."),
    topsPrompt);
  check("...and carries the mirror of the bottoms non-target lock",
    /For any lower body parts, legs, or shorts that enter the camera frame during the video/.test(topsPrompt) &&
    /without generating, replacing, or inventing any new pants or garments\./.test(topsPrompt),
    topsPrompt);

  /* ── ONE SHAPE, ONE DELIBERATE DIVERGENCE ───────────────────────────────────
     The branches no longer normalise into one string - they are worded per region now (a
     waistline is not a belly; a leg profile is not a silhouette) - so what is asserted is
     the SHAPE they share and the axis they differ on. The divergence is still exactly the
     one this suite exists for: WHICH region the anchor claims. image-first.test.mjs §1
     owns the sentence-by-sentence contract. */
  check("both open on the same non-target passthrough",
    topsPrompt.startsWith("For any lower body parts") &&
    bottomsPrompt.startsWith("For any upper body parts"),
    `tops=${topsPrompt}\n        bottoms=${bottomsPrompt}`);
  /* ── EACH NAMES BOTH REGIONS NOW, AND THAT IS THE POINT ────────────────────
     The old rule was "each branch mentions its own garment and never the other's". It
     cannot hold any more, because the non-target lock has to NAME the layer it protects -
     a tops prompt that never says "pants" cannot tell the model to leave them alone. What
     replaces it is the stronger property: each branch FITS one region and PRESERVES the
     other, and never the reverse. */
  check("...and each FITS its own region while PASSING THROUGH the other",
    /Fit ONLY the reference shirt/.test(topsPrompt) &&
    /lower body parts, legs, or shorts/.test(topsPrompt) &&
    /Fit ONLY the reference pants\/shorts/.test(bottomsPrompt) &&
    /upper body parts, torso, or shirt/.test(bottomsPrompt),
    `tops=${topsPrompt}\n        bottoms=${bottomsPrompt}`);
  check("...and neither passes through the very layer it is fitting",
    !/upper body parts, torso, or shirt/.test(topsPrompt) &&
    !/lower body parts, legs, or shorts/.test(bottomsPrompt),
    "a prompt that passes through the layer it is editing cancels itself");

  /* ── THE ASYMMETRY ITSELF, asserted so it cannot drift by accident ───────────
     Tops does NOT carry the opposite-layer lock. That is the one-branch-at-a-time-on-
     evidence rule this file has followed throughout - no report has been filed of a top
     try-on repainting the shopper's live trousers - and it is a live bet, not an
     oversight. Two things therefore have to hold: tops stays implicitly scoped, and
     app.js keeps the restore path in the words a future debugger will search for when
     the mirror-image report finally does arrive. */
  /* ── THE ASYMMETRY IS DELIBERATELY OVER ────────────────────────────────────
     For three revisions the opposite-layer lock sat on bottoms alone, under a
     one-branch-at-a-time-on-evidence rule: no report had been filed of a TOP try-on
     repainting real trousers. One has now - step back mid-session in a shirt try-on and
     the model invents trousers - so both branches carry it, and app.js's asymmetry note
     is history rather than live policy. */
  check("tops DOES carry the opposite-layer lock now - the asymmetry is over",
    /lower body parts, legs, or shorts/.test(topsPrompt) &&
    /LIVE camera feed clothing/.test(topsPrompt),
    `the report that closed the asymmetry was a tops try-on inventing trousers: ${topsPrompt}`);
  check("the opposite-layer lock is recorded in app.js with a per-branch restore path",
    /IF SHIRT-REPLACEMENT\s*\n?\s*RETURNS, THIS IS THE CLAUSE TO RESTORE FIRST/.test(SRC) &&
    /WHERE EACH HALF LIVES TODAY/.test(SRC),
    "the only removal here that re-opens a previously fixed report");
  /* THE PIN ITSELF IS NOW RETIRED ON BOTTOMS TOO - the region naming survived into the
     new lead, the explicit pin did not. Named as a constant rather than left inline, so
     the restore is one line on either branch instead of a sentence to reconstruct. */
  check("...and the retired pin is on file as a constant, restorable on either branch",
    /const KEEP_OPPOSITE_LAYER = "Keep the subject's upper body and background unmodified\.";/.test(SRC),
    "an inline sentence that was deleted is not a restore path");
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
  /* Still routed through fitPrompt() at ~169 chars, which looks redundant and is not: it
     normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit that lengthens
     an anchor is clamped here rather than over-running into clampPromptForWire()'s hard
     slice - which cuts at the END, taking the "do NOT invent" sentence with it. */
  /* Now TWO parts - the anchor at CORE and STRICT_REFERENCE_LOCK at HIGH. What this pins
     is unchanged: the anchor is the CORE part and the call goes through fitPrompt(). */
  check("both branches are assembled through fitPrompt(), not returned raw",
    /return fitPrompt\(\[\s*\n\s*\[P\.CORE, isBottomsGarment\(item\) \? CATEGORY_ANCHOR\.bottom : CATEGORY_ANCHOR\.top\],/.test(SRC) &&
    /\[P\.HIGH, STRICT_REFERENCE_LOCK\],/.test(SRC) &&
    /\[P\.HIGH, DENSE\.inpaintLock\],/.test(SRC) &&
    /\[P\.HIGH, isBottomsGarment\(item\) \? BOTTOMS_REFERENCE_BIND\[bottomsLength\(item\)\] : ""\],/.test(SRC) &&
    /\[P\.HIGH, isBottomsGarment\(item\) \? DENSE\.modelAgnostic : ""\],\s*\n\s*\]\);/.test(SRC),
    "a raw return skips the budget clamp and the whitespace normaliser");
  /* P.HIGH, NOT P.CORE - the bind must be sheddable. It is the newest and least
     load-bearing clause on this branch, and the anchor it sits behind is the one thing
     that must never be dropped under budget pressure. */
  check("...and the bind is sheddable - P.HIGH, never P.CORE",
    !/\[P\.CORE, isBottomsGarment\(item\) \? BOTTOMS_REFERENCE_BIND/.test(SRC),
    "a P.CORE bind could push the anchor into fitPrompt()'s hard slice");
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

  for (const fn of ["buildPrompt", "buildCustomPrompt"]) {
    const start = SRC.indexOf(`function ${fn}(`);
    const body = SRC.slice(start, SRC.indexOf("\n}", start));
    check(`${fn}() resolves its prompt per garment category`,
      /imageOnlyPrompt\(/.test(body), body.slice(0, 300));
  }
  /* THE COMPOSITE BUILDER REACHES THE SAME TABLE BY A DIFFERENT ROUTE. It cannot delegate
     to imageOnlyPrompt() because it has to put the panel contract in FRONT of the anchor,
     and that resolver returns a finished string. The property this suite owns is that the
     prompt branches on CATEGORY - so what is asserted is the branch itself, on the same
     table, rather than the call that happens to carry it elsewhere. */
  {
    const start = SRC.indexOf("function buildCompositePrompt(");
    const body = SRC.slice(start, SRC.indexOf("\n}", start));
    check("buildCompositePrompt() resolves its prompt per garment category",
      /isBottomsGarment\(item\) \? CATEGORY_ANCHOR\.bottom : CATEGORY_ANCHOR\.top/.test(body),
      body.slice(0, 300));
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
  /* The two clauses this path keeps and the single-garment branches do not. No full-look
     report has been filed against clause count, so removing them here would be a change
     made on no evidence - and they are the two a both-layer render needs most. */
  check("...while the volume and hem clauses it never collapsed are still assembled",
    /360-degree rotations/.test(look) && /un-knotted hem/.test(look), look);
  check(`...and the whole thing fits the ${CONFIG.PROMPT_MAX_CHARS}-char budget with nothing shed`,
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

console.log("\n\u2500\u2500 \u00a77 HEM LENGTH AND THE PRODUCT BIND: the lower-garment report \u2500\u2500");
{
  /* REPORTED: trying on lower garments renders generic trousers - wrong colour, wrong cut,
     and knee-length shorts coming back full-length.

     WHAT WAS ALREADY ON THE WIRE, so this section is not confused with a restatement:
     "Exactly match color, pattern, logos, and cut" (the colour half, present and not
     holding) and the upper-body passthrough that LEADS the anchor. This file's last two
     revisions both concluded, against reproduced failures, that restating an instruction
     which did not hold is the one move the evidence rules out.

     WHAT WAS NOT ON THE WIRE AT ALL: the hem. The token "length" appears in the bottoms
     anchor exactly once, inside the attribute list for the LIVE clothing being PRESERVED
     - so the prompt spent its only length instruction on the garment it is not drawing,
     and the model was free to pick a hem. That is new information, not a louder repeat,
     which is the only kind of addition those revisions left open. */
  const { bottomsLength, BOTTOMS_REFERENCE_BIND } = api;
  const lower = (name) => ({ garmentType: "lower_body", name });

  console.log("   -- resolution: a token decides, silence does NOT guess --");
  check("English short tokens resolve SHORT",
    ["Cargo Shorts", "Bermuda Short", "Denim Cut-Offs", "Swim Trunks"]
      .every((n) => bottomsLength(lower(n)) === "short"),
    "shorts is the length the report actually turned on");
  check("Hebrew short tokens resolve SHORT - both spellings of the family",
    bottomsLength(lower("\u05e9\u05d5\u05e8\u05d8 \u05d3\u05e0\u05d9\u05dd")) === "short" &&
    bottomsLength(lower("\u05de\u05db\u05e0\u05e1\u05d9\u05d9\u05dd \u05e7\u05e6\u05e8\u05d9\u05dd")) === "short",
    "Hebrew is the storefront's primary language - a Hebrew-only title is the common case");
  check("long tokens resolve LONG, in both languages",
    ["Slim Fit Jeans", "Wool Trousers", "Ribbed Leggings", "Stone Chinos"]
      .every((n) => bottomsLength(lower(n)) === "long") &&
    bottomsLength(lower("\u05d2'\u05d9\u05e0\u05e1 \u05e1\u05e7\u05d9\u05e0\u05d9")) === "long",
    "a long hem stated explicitly is what stops a crop into shorts");

  /* THE THIRD BRANCH IS THE ONE THAT MATTERS MOST, and it is a hedge on purpose. The
     catalog's bottoms subTypes are "slim"/"regular"/"wide" - CUT, never LENGTH - so most
     real products carry no length token at all. Asserting "reaches the ankle" on an item
     that is actually shorts would be the reported bug, caused by us rather than by the
     model: a confident wrong instruction is strictly worse than a missing one. */
  check("an item with NO length token resolves UNKNOWN - never a guess",
    ["Glide Slim", "Vector Regular", "Drift Wide", "Mono Slim"]
      .every((n) => bottomsLength(lower(n)) === "unknown"),
    "these are the real catalog names; subType is cut, not length");
  check("...and null / empty never throws, resolving UNKNOWN",
    bottomsLength(null) === "unknown" && bottomsLength({}) === "unknown");

  /* THE REGEX TRAP, as its own case because it is the one a careless \bshorts?\b walks
     into - and this resolver reads subType, which is exactly where "short_sleeve" lives. */
  check("subType 'short_sleeve' does NOT read as SHORT",
    bottomsLength({ garmentType: "lower_body", subType: "short_sleeve", name: "Tee" }) === "unknown",
    "the classic false positive - 'short' is a substring of 'short_sleeve'");

  console.log("   -- the strings: positive only, no banned outcome named --");
  for (const [k, clause] of Object.entries(BOTTOMS_REFERENCE_BIND)) {
    check(`${k}: binds the reference's own pockets, seams and fabric`,
      /Reproduce the reference garment's own pockets, seams and fabric/.test(clause), clause);
    /* Decart's set() has no negative_prompt field, so every noun in a ban ships inside the
       POSITIVE prompt where the sampler can steer toward it - the mechanism behind this
       file's blue-jacket and tuxedo reports. Each branch must state only the hem it wants,
       never the hem it is avoiding. */
    check(`   ...and names no banned outcome - the tuxedo mechanism`,
      !/never |not |forbid|avoid/i.test(clause) || !/trousers|shorts/i.test(clause),
      clause);
  }
  check("short states the knee, long states the ankle, unknown states neither",
    /ends above the knee/.test(BOTTOMS_REFERENCE_BIND.short) &&
    /ends at the ankle/.test(BOTTOMS_REFERENCE_BIND.long) &&
    !/knee|ankle/.test(BOTTOMS_REFERENCE_BIND.unknown),
    "the unknown branch must bind the hem to the reference without claiming to know it");
  check("...and unknown still says the hem is not the model's to choose",
    /ends at its own photographed hem/.test(BOTTOMS_REFERENCE_BIND.unknown),
    "a hedge that says nothing at all would leave the reported gap exactly as it was");
  /* THE SPAN, added against the "no spatial region tagging" diagnosis. Both endpoints on
     every branch: the hem was already bound, the WAIST never was, and an unstated upper
     edge is what lets a lower garment ride up the torso. */
  check("every branch states BOTH endpoints - the waist as well as the hem",
    Object.values(BOTTOMS_REFERENCE_BIND).every((c) => /sits at the waist and ends/.test(c)),
    "a hem with no stated top edge leaves the upper boundary to the model");
  /* No "SPATIAL TARGET:" label. set() has no mask channel and no cross-attention control,
     so a label is prose the model reads, not a directive it can act on - and it costs the
     same budget as an instruction. The anatomical endpoints carry the information. */
  check("...stated as anatomy, not as a machine-readable region label",
    Object.values(BOTTOMS_REFERENCE_BIND).every((c) => !/SPATIAL TARGET|REGION:|BBOX|mask/i.test(c)),
    "a label set() cannot act on is ceremony at the price of an instruction");

  console.log("   -- wiring and budget --");
  check("TOPS never receives the bind - the report was filed on bottoms only",
    !/hem/.test(imageOnlyPrompt({ garmentType: "upper_body", name: "Tee" })),
    "a mirrored clause would spend budget on both branches for a one-branch failure");
  for (const [n, want] of [["Cargo Shorts", "short"], ["Slim Fit Jeans", "long"], ["Glide Slim", "unknown"]]) {
    const p = imageOnlyPrompt(lower(n));
    /* includes(), not endsWith(): DENSE.modelAgnostic now follows the bind on this branch.
       The ORDER is asserted separately below rather than inferred from position here, so
       that inserting a clause between them fails on the ordering check instead of silently
       passing a weaker containment test. */
    check(`"${n}" ships its ${want} bind and fits the ${CONFIG.PROMPT_MAX_CHARS}-char budget`,
      p.includes(BOTTOMS_REFERENCE_BIND[want].trim()) && p.length <= CONFIG.PROMPT_MAX_CHARS,
      `${p.length} chars`);
    check(`   ...with the bind ahead of the model-agnostic clause, and both last`,
      p.indexOf(BOTTOMS_REFERENCE_BIND[want].trim()) < p.indexOf("Ignore the reference model's body") &&
      p.trim().endsWith("Ignore the reference model's body; fit the cloth to THIS person."),
      p);
  }
}

console.log("\n\u2500\u2500 \u00a78 THE GERESH: one character that unclassified a real product \u2500\u2500");
{
  /* REPORTED, with a screenshot: the catalog item "\u05d2'\u05d9\u05e0\u05e1 WIDE - FOX" - long grey wide-leg
     denim - rendered as short black shorts cut at mid-thigh. Filed as "the prompt lacks
     length attributes". It does not: \u00a77 above pins that bottomsLength() resolves a hem and
     that the long branch says "ends at the ankle". The instruction never FIRED for this
     product, and one character is why.

     Every list in app.js spells "jeans" twice - ASCII U+0027 and Hebrew geresh U+05F3 -
     and both comments say storefronts use them interchangeably. Neither anticipated
     U+2019, the right single quote that every smart-quote substitution emits and that
     lands in any title pasted out of a word processor or typed in most storefront admins.

     THIS SECTION RUNS THE REAL FUNCTIONS OVER EVERY SPELLING, because the failure was
     invisible to every existing check: the two spellings that were listed both passed,
     and nothing exercised a third. */
  const { bottomsLength, foldGeresh } = api;
  /* U+0027 ' , U+05F3 Hebrew geresh, U+2019 right single quote (the reported one),
     U+02B9 modifier prime, U+2018 left single quote, U+00B4 acute, U+02BC apostrophe. */
  const GERESH = ["'", "\u05f3", "\u2019", "\u02b9", "\u2018", "\u00b4", "\u02bc"];
  const JEANS = (ch) => `\u05d2${ch}\u05d9\u05e0\u05e1 WIDE - FOX`;

  console.log("   -- the reported product, every spelling a storefront emits --");
  for (const ch of GERESH) {
    const cp = "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    /* WITH catalog metadata: `type` rescues the CATEGORY, but never the LENGTH - which is
       read from the same free text. This is the reported render: correctly identified as
       bottoms, then given no hem to honour. */
    check(`${cp} with type:"pants" resolves LONG, not unknown`,
      bottomsLength({ type: "pants", subType: "wide", name: JEANS(ch) }) === "long",
      "an unresolved hem is the mid-thigh truncation that was reported");
    /* WITHOUT metadata - the widget-handoff and custom-upload paths. Here the same
       character decided the CATEGORY too, and the failure is far worse than a wrong hem:
       a pair of jeans fitted with "Fit ONLY the reference shirt onto the subject's upper
       torso" is the original shirt-on-a-trouser-reference bug, reachable today. */
    check(`   ...and on name alone it is still BOTTOMS, never a top`,
      isBottomsGarment({ name: JEANS(ch) }) === true,
      "a jeans reference on the tops anchor is the bug this whole file exists for");
  }

  console.log("   -- the prompt that now reaches Decart for that item --");
  const reported = imageOnlyPrompt({ type: "pants", subType: "wide", name: JEANS("\u2019") });
  check("it states the ankle, which it did not before this fix",
    /ends at the ankle/.test(reported), reported);
  check("...and never the unresolved-hem hedge",
    !/its own photographed hem/.test(reported), reported);
  check("...and still fits the budget",
    reported.length <= CONFIG.PROMPT_MAX_CHARS, `${reported.length} chars`);

  console.log("   -- the fold itself --");
  check("foldGeresh() maps every variant to a plain ASCII quote",
    GERESH.every((ch) => foldGeresh(`\u05d2${ch}\u05d9\u05e0\u05e1`) === "\u05d2'\u05d9\u05e0\u05e1"),
    "one fold is what stops the next variant being discovered the same way");
  check("...and is null/undefined-safe, never throwing on a missing title",
    foldGeresh(null) === "" && foldGeresh(undefined) === "" && foldGeresh(0) === "0");
  /* The fold must not touch anything else. A regex that also folded, say, a hyphen would
     quietly change "T-SHIRT" and every other list that matches on punctuation. */
  check("...and leaves all other punctuation alone",
    foldGeresh("T-SHIRT / 100% cotton (slim)") === "T-SHIRT / 100% cotton (slim)");

  /* THE TWO CLASSIFIERS MUST FOLD ALIKE. pear-widget.js forwards an EXPLICIT category
     that outranks the room's own, so folding in one and not the other leaves the widget
     able to forward a wrong verdict the room cannot question - which its own
     FABRIC_AMBIGUOUS comment already names as the rule. */
  const WIDGET_SRC = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
  check("widget/pear-widget.js folds the same set before matching its own lists",
    /var GERESH_VARIANTS = \/\[\\u2018\\u2019\\u02B9\\u02BC\\u2032\\u00B4\\u0060\\u05F3\]\/g;/.test(WIDGET_SRC) &&
    /var haystack = foldGeresh\(/.test(WIDGET_SRC),
    "an explicit widget verdict outranks the room - the two have to fold alike");
  check("...and app.js's set is the same one, character for character",
    /const GERESH_VARIANTS = \/\[\\u2018\\u2019\\u02B9\\u02BC\\u2032\\u00B4\\u0060\\u05F3\]\/g;/.test(SRC),
    "two folds that drift are one classifier silently disagreeing with the other");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
