#!/usr/bin/env node
/* PLAIN-TEE FIDELITY - "I picked a plain white crewneck tee and it rendered a
   short-sleeve button-down with a pointed collar and a breast pocket."
   =============================================================================
   THE REPORT is the tuxedo's smaller cousin: not a garment from another category,
   but the WRONG CONSTRUCTION of the right one. A knit tee came back as a woven
   button-down. Same class, same mechanism, one notch narrower.

   THE CAUSE IS ON THE WIRE, and it was added by daabb47 (FRONT_CLOSURE_LOCK).
   That commit fixed a real report - a button-down rendering hung open - by shipping
   one sentence on EVERY tops+front render:

     "Reproduce the reference's front closure exactly: any buttons, zip or placket
      stay fully fastened, sitting flat and closed across the chest as shown."

   Its comment calls this PRODUCT-NEUTRAL: "on a tee there is no closure and the
   sentence asks for nothing." That is the assumption this suite exists to reject.
   Decart's set() takes { prompt, image, enhance } and has no negative_prompt, which
   is why this file's whole history insists a garment noun in the prompt is a token
   the sampler can steer TOWARD. "buttons", "zip", "placket" and "closed across the
   chest" are four such tokens, and on a plain tee they are the only construction
   words on the wire. The model reconciles them the only way it can: it renders a
   garment that HAS a placket. The reported collar and breast pocket are what comes
   along with that concept once it has been summoned.

   WHY THE FIX IS NOT A NEGATION. The obvious patch - "Do NOT render buttons,
   collars, plackets, or chest pockets" - is the exact shape image-first.test.mjs's
   header records as having PRODUCED the tuxedo, because a negation ships inside the
   positive prompt and names four more garment features while it is there. §2 below
   asserts no such token ever reaches the wire.

   WHAT THE FIX IS. A third SELECTOR, alongside category and angle. The prompt stays
   a function of frozen strings and nothing else: a top that the catalog identifies
   as a plain knit tee resolves to a tee anchor that names a t-shirt and states the
   plain neckline POSITIVELY, and the closure clause - which is for garments that
   have a closure - is simply not spent on it. Volume goes DOWN, not up, which is the
   direction every fidelity report in this file has wanted.

   WHAT IT DELIBERATELY DOES NOT DO, so a later reader does not read these as
   oversights:
     - The BACK anchors are untouched. The summoning tokens are front-only
       (FRONT_CLOSURE_LOCK never shipped on the back branch), no back-view report
       exists, and this file's stated discipline is one branch at a time on evidence.
     - Tanks/sleeveless stay on the default branch. Calling a sleeveless top a
       "t-shirt" invites the model to add sleeves - a NEW failure traded for an old
       one. §5 pins that scoping so it stays a decision rather than a gap.
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

/* The real prompt layer, executed - the same slice and sandbox image-first.test.mjs and
   garment-category-prompt.test.mjs use, so the three suites can never drift onto
   different copies of the code. */
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
  code + "\nreturn { isBottomsGarment, isPlainKnitTop, imageOnlyPrompt, fitPrompt, P };")(...Object.values(sandbox));

const { isPlainKnitTop, imageOnlyPrompt } = api;

/* The reported product, in the shape the catalog actually delivers it. `type: "shirt"`
   is NOT incidental - every top in this catalog carries it (see the ITEMS table in
   app.js), which is precisely why the classifier may not treat a bare "shirt" token as
   evidence of a woven button-down. §1's last case pins that. */
const TEE        = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve", name: "Ion Crew Tee" };
const BUTTONDOWN = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve", name: "Oxford Button-Down Shirt" };
const UNKNOWN_TOP = { garmentType: "upper_body" };
const JEANS      = { garmentType: "lower_body", name: "Glide Slim" };

const CLOSURE_RE = /Reproduce the reference's front closure/;

console.log("── §1 CLASSIFICATION: which tops are plain knit tees ──");
{
  check("the reported product - an explicitly named crew tee - is a plain knit tee",
    isPlainKnitTop(TEE) === true);
  check("English tee vocabulary: t-shirt / tshirt / tee / crewneck / v-neck",
    isPlainKnitTop({ name: "Plain White T-Shirt" }) === true &&
    isPlainKnitTop({ name: "Basic Tshirt" }) === true &&
    isPlainKnitTop({ name: "Pulse Tee" }) === true &&
    isPlainKnitTop({ name: "Crewneck Cotton Top" }) === true &&
    isPlainKnitTop({ name: "V-Neck Cotton Top" }) === true);
  /* Hebrew is the storefront's primary language, so a Hebrew-only title is the common
     case here rather than an edge case - the same reasoning BOTTOMS_TOKENS is built on.
     Both geresh spellings, because storefronts use them interchangeably. */
  check("Hebrew tee vocabulary: טי שירט / טישרט / חולצת טי / גופיה is NOT included",
    isPlainKnitTop({ name: "טי שירט לבן" }) === true &&
    isPlainKnitTop({ name: "טישרט בייסיק" }) === true &&
    isPlainKnitTop({ name: "חולצת טי" }) === true);

  console.log("   -- and the tops that must KEEP the closure clause --");
  /* daabb47's report is still live. Every one of these genuinely has a placket, and
     losing the closure lock on them re-opens "the button-down rendered wide open". */
  check("a button-down / oxford is NOT a plain knit tee",
    isPlainKnitTop(BUTTONDOWN) === false &&
    isPlainKnitTop({ name: "Chambray Shirt" }) === false);
  check("a polo and a henley are NOT plain tees - both have a buttoned placket",
    isPlainKnitTop({ name: "Pique Polo" }) === false &&
    isPlainKnitTop({ name: "Nimbus Henley" }) === false,
    "these are the two that LOOK like knitwear and still fasten");
  check("an outer layer is NOT a plain tee, even when the title also says tee",
    isPlainKnitTop({ name: "Denim Jacket" }) === false &&
    isPlainKnitTop({ name: "Zip-Through Hoodie" }) === false &&
    isPlainKnitTop({ name: "Tee Shirt Cardigan" }) === false,
    "a structured noun outranks a tee token, as it does in isBottomsGarment()");
  check("Hebrew structured tops outrank a tee token too",
    isPlainKnitTop({ name: "חולצה מכופתרת" }) === false &&
    isPlainKnitTop({ name: "ז'קט ג'ינס" }) === false);

  console.log("   -- the defaults, and the trap that would make this dead code --");
  check("a top with no usable title is NOT assumed to be a tee",
    isPlainKnitTop(UNKNOWN_TOP) === false && isPlainKnitTop({}) === false &&
    isPlainKnitTop(null) === false,
    "an unknown item must keep the OLD behaviour, never a new one");
  check("a bottoms garment is never a plain knit top, whatever its title says",
    isPlainKnitTop(JEANS) === false &&
    isPlainKnitTop({ garmentType: "lower_body", name: "Tee Print Joggers" }) === false);
  /* THE DEAD-CALL-SITE TRAP, as its own case. Every top in this catalog carries
     type: "shirt". A structured-top pattern that matched a bare "shirt" would classify
     EVERY tee as a button-down, and the fix would be dead code that still passes a
     function-level test written against name alone. */
  check("catalog `type: \"shirt\"` does not disqualify a tee - every top carries it",
    isPlainKnitTop({ type: "shirt", subType: "short_sleeve", name: "Ion Crew Tee" }) === true,
    "if this fails the whole fix never runs on a real catalog item");
  /* subType "short_sleeve" is NOT evidence of a tee, and the report is the proof: the
     hallucinated garment was itself a SHORT-SLEEVE button-down. */
  check("subType 'short_sleeve' alone does not make a tee - the bug wore one",
    isPlainKnitTop({ subType: "short_sleeve" }) === false);
}

console.log("\n── §2 THE TEE PROMPT: no closure tokens, and no negation either ──");
{
  const tee = imageOnlyPrompt(TEE);
  check("the closure clause is OFF the wire for a plain tee - the reported cause",
    !CLOSURE_RE.test(tee), tee);
  check("...so none of the four summoning tokens ship at all",
    !/\b(button|buttons|buttoned|zip|placket|collar|collared|pocket)\b/i.test(tee), tee);
  /* The whole point of the fix. A negation would name those same features while
     forbidding them, and set() has no negative_prompt to put it in. */
  check("and the fix is NOT a negation - no banned-feature list rides in its place",
    !/\b(do not|don't|never|avoid|without buttons|no buttons|not render)\b/i.test(tee), tee);
  check("the anchor names a T-SHIRT, not a bare 'shirt' - the woven prior",
    /EXACT static t-shirt from the reference image/.test(tee), tee);
  check("...and states the plain neckline POSITIVELY, as FRONT_CLOSURE_LOCK's own note requires",
    /plain knit neckline/i.test(tee) && /unbroken front/i.test(tee), tee);
  check("it keeps the shared spine: bind, adapt per frame, preserve",
    tee.indexOf("Drape and fit the EXACT static t-shirt from the reference image") === 0 &&
    /Dynamically adapt the garment drape to the subject's exact/.test(tee) &&
    /Strictly preserve the original t-shirt texture, pattern, and color\./.test(tee),
    tee);
}

console.log("\n── §3 NO REGRESSION: the garments that DO fasten still get the lock ──");
{
  const bd = imageOnlyPrompt(BUTTONDOWN);
  check("a button-down still ships the closure lock - daabb47's report stays fixed",
    CLOSURE_RE.test(bd), bd);
  check("...and still opens on the unchanged 'EXACT static shirt' anchor",
    bd.indexOf("Drape and fit the EXACT static shirt from the reference image") === 0, bd);
  /* CHANGED DELIBERATELY BY §6, which is why this reads as a reversal. It used to assert
     "anchor plus lock" - an unrecognised top got the closure clause by default. That
     default WAS the second bug: brand-named, Hebrew-titled and untitled tees are all
     unrecognisable to the tee vocabulary and all got handed placket tokens. The anchor is
     unchanged; only the clause is gone, and only where nothing proves it belongs. */
  check("an unclassifiable top keeps the default ANCHOR, but no longer the closure clause",
    imageOnlyPrompt(UNKNOWN_TOP).indexOf("Drape and fit the EXACT static shirt") === 0 &&
    !CLOSURE_RE.test(imageOnlyPrompt(UNKNOWN_TOP)),
    "an unproven top must not be handed closure tokens - see §6");
  check("the bottoms branch is untouched by the new axis",
    imageOnlyPrompt(JEANS) === imageOnlyPrompt({ garmentType: "lower_body", name: "Tee Joggers" }) &&
    !CLOSURE_RE.test(imageOnlyPrompt(JEANS)),
    "a tee token in a trouser title must not reach the tops branch at all");
}

console.log("\n── §4 VOLUME: the fix must SHRINK the prompt, never grow it ──");
{
  const tee = imageOnlyPrompt(TEE);
  /* THE BASELINE IS A FASTENING TOP, not an unrecognised one, and §6 is why: an
     unrecognised top no longer carries the closure clause either, so it is no longer the
     "what a tee used to ship" comparison this assertion was written to make. A garment
     that genuinely fastens still ships anchor + clause - exactly what every tee used to
     get - so it is the honest baseline for the same question. */
  const wasShipped = imageOnlyPrompt(BUTTONDOWN);
  check("the tee prompt is inside the budget every anchor shares",
    tee.length <= CONFIG.PROMPT_MAX_CHARS, `${tee.length} chars`);
  /* THE LOAD-BEARING ASSERTION OF THIS SUITE. Every report in app.js's prompt history
     shares one mechanism - text volume competing with the reference image - so a fix for
     a fidelity bug that ADDS text is the mechanism, reapplied. Dropping the closure
     clause buys more than the tee wording spends, and this pins that it stays true. */
  check("...and is SHORTER than the anchor-plus-clause every tee used to ship",
    tee.length < wasShipped.length,
    `tee=${tee.length} was=${wasShipped.length} - a fidelity fix that grows the prompt is the bug`);
  /* And the branch most tops now land on is shorter still - the fix's real reach is the
     unrecognised title, not the one that says "tee" on the tin. */
  check("...and an unrecognised top ships less than it did before §6",
    imageOnlyPrompt(UNKNOWN_TOP).length < wasShipped.length,
    `unknown=${imageOnlyPrompt(UNKNOWN_TOP).length} was=${wasShipped.length}`);
  /* FOUR SENTENCES OF ANCHOR, plus the front graphic lock that every tops+front render now
     carries (FRONT_PRINT_LOCK - the chest logo eroding across a 360). Counted against the
     anchor rather than the whole string, so the property this owns - the tee branch is one
     frozen anchor, not a re-grown assembly - still holds exactly. */
  const teeAnchorOnly = tee.replace(/\s*Precisely lock the front print[\s\S]*$/, "");
  check("it is still ONE anchor - the tee branch did not become an assembly",
    teeAnchorOnly.split(/(?<=\.)\s+/).filter(Boolean).length <= 4 &&
    tee.length - teeAnchorOnly.length < 110,
    teeAnchorOnly);
}

console.log("\n── §5 THE AXIS IS A SELECTOR, and its scope is deliberate ──");
{
  /* The frozen-anchor contract, stated the way image-first.test.mjs states it for the
     other two axes: a template hole here is how a per-item DESCRIPTION creeps back one
     field at a time, which is the history this whole mode reacts to. */
  check("the tee anchor is a frozen literal with no interpolation hole",
    /const PLAIN_TEE_ANCHOR\s*=\s*\n?\s*"/.test(SRC) &&
    !/const PLAIN_TEE_ANCHOR[\s\S]{0,600}?\$\{/.test(SRC),
    "no template hole in or adjacent to the declaration");
  check("...and the resolver SELECTS it, never concatenates onto an anchor",
    !/PLAIN_TEE_ANCHOR\s*\+/.test(SRC) && !/\+\s*PLAIN_TEE_ANCHOR/.test(SRC),
    "appending one clause is how the dozen came back last time");
  /* SCOPED TO FRONT, on purpose and on the record. The closure tokens never shipped on
     the back branch, and no back-view report exists - so the back pair stays byte-for-byte
     what it was, per this file's one-branch-at-a-time-on-evidence rule. */
  check("the BACK branch is untouched: a tee and a button-down render identically behind",
    imageOnlyPrompt(TEE, "back") === imageOnlyPrompt(BUTTONDOWN, "back") &&
    /EXACT static shirt's REAR\/BACK side/.test(imageOnlyPrompt(TEE, "back")),
    "the tee axis is front-only until a back-view report says otherwise");
  /* SLEEVELESS STAYS ON THE DEFAULT BRANCH. Naming a tank a "t-shirt" invites the model
     to add sleeves, which trades a reported failure for an unreported one. */
  check("sleeveless tops stay on the default branch - a tank is not a t-shirt",
    isPlainKnitTop({ name: "Halo Tank" }) === false &&
    isPlainKnitTop({ name: "Vapor Sleeveless" }) === false &&
    isPlainKnitTop({ name: "גופיה" }) === false,
    "calling a tank a t-shirt is how you grow sleeves that were never in the reference");
}

console.log("\n── §6 THE BURDEN OF PROOF WAS ON THE WRONG SIDE ──");
/* THE SECOND REPORT: "a vertical slit down the centre front - it looks split or buttoned
   instead of a continuous knit tee." Same placket, after §1-§5 supposedly fixed it.

   WHY THE FIRST FIX MISSED IT. isPlainKnitTop() demands POSITIVE PROOF of a tee before it
   will withhold the closure clause, and that proof is an explicit tee noun in the title.
   Real storefronts do not oblige: "PEAK", "PEAK Oversized", "חולצה אוברסייז" and a bare
   widget handover with no title at all are all plain jersey tees, and every one of them
   fell to the default branch and shipped "buttons, zip or placket" anyway. The fix worked
   only for products whose titles already said what they were.

   THE BURDEN IS INVERTED HERE. FRONT_CLOSURE_LOCK exists for garments that HAVE a front
   closure; on anything else its four nouns are free-floating tokens the sampler can steer
   toward, which is the entire mechanism. So it now ships only on POSITIVE evidence of a
   closure (STRUCTURED_TOP_TOKENS - button/zip/placket/polo/henley/oxford/cardigan/jacket),
   and an unrecognised top gets no closure tokens rather than getting them by default.

   THE TRADE, STATED. A button-down whose title names no closure loses the lock and could
   render open again (daabb47's report). That is the invented-detail class - the right
   garment in a wrong state - and it is strictly less bad than the wrong-garment class this
   is fixing, on a catalog where tees vastly outnumber button-downs. §6 pins that every
   garment which DOES name a closure keeps it.

   NOTE IT SPENDS NO TEXT. The fix removes a clause from most tops; it adds nothing. */
{
  const PEAK      = { garmentType: "upper_body", type: "shirt", subType: "short_sleeve", name: "PEAK Oversized" };
  const HEB_OVER  = { garmentType: "upper_body", type: "shirt", name: "חולצה אוברסייז" };
  const UNTITLED  = { garmentType: "upper_body" };

  check("the reported garment - a brand-named oversized tee - ships NO closure tokens",
    !CLOSURE_RE.test(imageOnlyPrompt(PEAK)) &&
    !/\b(button|zip|placket|collar|pocket)\b/i.test(imageOnlyPrompt(PEAK)),
    imageOnlyPrompt(PEAK));
  check("...and neither does a Hebrew-titled one, the storefront's primary language",
    !CLOSURE_RE.test(imageOnlyPrompt(HEB_OVER)));
  check("...nor an untitled widget handover, which names nothing at all",
    !CLOSURE_RE.test(imageOnlyPrompt(UNTITLED)),
    "an unrecognised top must not be handed placket tokens by default");

  console.log("   -- and every top that DOES fasten still keeps the lock --");
  const fastened = ["Oxford Button-Down Shirt", "Pique Polo", "Nimbus Henley",
                    "Zip-Through Hoodie", "Tee Shirt Cardigan", "חולצה מכופתרת"];
  let allKept = true, missing = "";
  for (const name of fastened) {
    if (!CLOSURE_RE.test(imageOnlyPrompt({ garmentType: "upper_body", name }))) { allKept = false; missing = name; break; }
  }
  check("daabb47's report stays fixed for every garment that names a closure", allKept, missing);

  /* The two branches are mutually exclusive by construction - a garment cannot be both a
     plain knit tee and a fastening one - and asserting it stops a future edit producing a
     prompt that names a placket and a seamless front in the same breath. */
  check("no top ever gets the tee anchor AND the closure clause together",
    ["PEAK Oversized", "Ion Crew Tee", "Oxford Button-Down Shirt", "Pique Polo", "", "Boxy Top"]
      .every((name) => {
        const p = imageOnlyPrompt({ garmentType: "upper_body", name });
        return !(/EXACT static t-shirt/.test(p) && CLOSURE_RE.test(p));
      }),
    "a seamless front and a fastened placket in one prompt is a contradiction on the wire");

  check("bottoms are untouched by the inverted burden",
    !CLOSURE_RE.test(imageOnlyPrompt(JEANS)) &&
    imageOnlyPrompt(JEANS) === imageOnlyPrompt({ garmentType: "lower_body", name: "Button Fly Jeans" }),
    "a closure token in a TROUSER title must not reach the tops-only clause");
  check("the back branch is still closure-free, as it always was",
    !CLOSURE_RE.test(imageOnlyPrompt(BUTTONDOWN, "back")));
}

console.log(fails === 0 ? "\nplain-tee-fidelity: OK" : `\nplain-tee-fidelity: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
