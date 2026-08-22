/* VARIANT SYNC + HOST-BRIDGE GUARDS.

   Two reported failures, one shared shape: state that LOOKED synchronised because the
   visible half of it was.

   ── 1. THE SWATCH ONLY MOVED THE PICTURE ──────────────────────────────────────
   setColor() set `activeColor` and hot-swapped the stream. galleryOf() reads through
   variantAssetsOf(), so the reference PHOTO did change - which is exactly why this read
   as the model mutating the garment rather than as a state bug. Everything else still
   read the item's BASE fields:

     · the prompt said colorName(item.color)     -> "black t-shirt" under a red packshot
     · the cart said activeItem.sku / .variantId -> the base SKU, whatever was picked

   So Decart got a red photo with an instruction naming black (a contradiction it
   resolves by picking one), and a shopper could buy a colour they never selected.
   variantMetaOf() resolves all three from the selected variant, with per-field fallback.

   ── 2. THE CART POSTED AN UNIDENTIFIED GARMENT ────────────────────────────────
   app.js's pearGetActiveGarment() returns NULL when nothing is selected - correct. But
   lux-interactions.js did `|| {}` and then `sku: garment.sku || ""`, so a click with no
   active garment posted PEAR_ADD_TO_CART with sku:"" and variantId:"". The host cannot
   distinguish that from a real request for a SKU it doesn't stock, and the optimistic
   toast told the shopper it had worked. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LUX = readFileSync(new URL("../fitting-room/lux-interactions.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The REAL resolver, executed. colorsOf() sits directly above it, so one contiguous
   slice carries the dependency instead of a stub of it. */
const code = APP.slice(APP.indexOf("function colorsOf(item)"), APP.indexOf("/** Normalize any item"));
const mk = (activeColor) => new Function("activeColor",
  code + "\nreturn { variantMetaOf, activeColorOf, colorsOf };")(activeColor);

const ITEM = {
  id: 6, name: "Strata", color: "#2b2b30", sku: "STRATA-BASE", variantId: "gid://v/1",
  variants: {
    charcoal: { swatch: "#2b2b30", sku: "STRATA-CHR", variantId: "gid://v/1" },
    crimson:  { swatch: "#c2452f", sku: "STRATA-CRM", variantId: "gid://v/2" },
    // Imagery-only variant: no commerce identity at all, which a catalog item may
    // legitimately define. Each field must fall back independently.
    sand:     { swatch: "#d8d4cb" },
  },
};

console.log("── §1 THE SELECTED VARIANT OWNS THE IDENTITY ──");
{
  const red = mk("crimson").variantMetaOf(ITEM);
  check("picking a swatch moves the SKU", red.sku === "STRATA-CRM", red.sku);
  check("...and the variant id", red.variantId === "gid://v/2", red.variantId);
  check("...and the colour the prompt will name", red.color === "#c2452f", red.color);

  const base = mk("charcoal").variantMetaOf(ITEM);
  check("the default swatch resolves to its own variant, not the item's base fields",
    base.sku === "STRATA-CHR" && base.variantId === "gid://v/1", JSON.stringify(base));
}

console.log("\n── §2 PER-FIELD FALLBACK (a variant may carry imagery and no commerce data) ──");
{
  const sand = mk("sand").variantMetaOf(ITEM);
  check("a variant with no sku falls back to the item's", sand.sku === "STRATA-BASE", sand.sku);
  check("...and to the item's variantId", sand.variantId === "gid://v/1", sand.variantId);
  check("...but still reports its OWN swatch colour", sand.color === "#d8d4cb", sand.color);

  /* Single-colour catalog items are the overwhelming majority and must be byte-identical
     to the old behaviour - this change must not touch them at all. */
  const plain = { id: 3, name: "Ion", color: "#c2452f" };
  const meta = mk(null).variantMetaOf(plain);
  check("an item with NO variants is unchanged: colour, and sku from the id",
    meta.color === "#c2452f" && meta.sku === "3" && meta.variantId === undefined,
    JSON.stringify(meta));

  const unknown = mk("chartreuse").variantMetaOf(ITEM);
  check("an activeColor that is not a real variant falls to the first, never to undefined",
    unknown.sku === "STRATA-CHR", unknown.sku);
}

console.log("\n── §3 THE PROMPT READS THE SWATCH, NOT THE BASE COLOUR ──");
{
  check("activeColorOf resolves through the variant table",
    mk("crimson").activeColorOf(ITEM) === "#c2452f");
  /* The original regression: three builders interpolated colorName(item.color), so a
     swatch swap sent a contradicting colour word while the reference image showed the
     new variant. The first fix routed those interpolations through activeColorOf() so
     the WORD followed the swatch.

     ── STRICT IMAGE-ONLY SUPERSEDED THAT FIX ENTIRELY ─────────────────────────────
     The tuxedo report (a Spider-Man tee rendering as formalwear) traced to the same
     mechanism this section was written about, one step further along: a prompt that
     DESCRIBES a garment is a prompt the model can satisfy from its own prior instead of
     from the reference pixels. No builder names a colour, a subtype noun or any other
     garment adjective any more - every one of them returns IMAGE_ONLY_PROMPT, a frozen
     string with no interpolation in it at all.

     That makes the contradiction structurally impossible rather than merely synchronised,
     which is the stronger property and the one asserted here. activeColorOf() itself is
     unchanged and still load-bearing (the swatch UI, the "Now fitting" chip and the cart
     bridge all read it) - only its route into the PROMPT is gone. If a colour word ever
     returns to a builder, this is what catches it. */
  const promptColour = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no builder interpolates a colour word into a prompt at all",
    !/colorName\(activeColorOf\(/.test(promptColour),
    "the reference image states the colour; a word beside it can only contradict it");
  check("...nor a subtype noun (SHIRT_NOUN/SUBTYPE_PROMPT are prompt-free now)",
    !/SHIRT_NOUN\[|SUBTYPE_PROMPT\[/.test(promptColour),
    "a garment noun is a description the model can satisfy without reading the image");
  /* ── REVISION: A SECOND AXIS ARRIVED - ANGLE - AND COLOUR/VARIANT STILL IS NOT ONE ──
     THE PROMPT NOW BRANCHES ON GARMENT CATEGORY (garment-category-prompt.test.mjs) - a
     trouser reference used to receive a t-shirt anchor, which put the catalog model's
     shirt on the shopper - AND, as of this revision, on ANGLE too: three reports traced a
     back-render gap to buildPrompt()/buildCompositePrompt() discarding their angle
     argument, so the reference IMAGE swapped to the back Blob while the PROMPT kept
     describing the front. imageOnlyPrompt(item, angle) now selects BACK_CATEGORY_ANCHOR
     when angle==="back", CATEGORY_ANCHOR otherwise - see its own revision comment in
     app.js for why `angle` is safe: it is a FROZEN parameter, threaded from a snapshot
     taken before any await (applyGarment's angleAtStart), never a live re-read inside the
     resolver, so this is a second value the prompt selects on, not a second RACE.

     WHAT THIS SUITE OWNS IS UNCHANGED BY THAT: colour, variant and pose still do not
     reach the prompt in any form, category and angle are the only two axes now, and both
     are frozen snapshots rather than live reads. Asserted as "every builder routes
     through the resolver" rather than "every builder returns a constant", because a
     single frozen constant is what had to go for angle to work at all. */
  /* buildCompositePrompt() is a partial exception since COMPOSITE_MODE's restore note
     (app.js) brought its panel contract back: it still calls imageOnlyPrompt(item, angle)
     for the anchor half, but no longer as a bare `return` - the call is one part of a
     fitPrompt() assembly now, not the whole function body. So the bare-return count drops
     to the two purely-delegating builders, and buildCompositePrompt is checked separately
     for the same underlying property (it selects on angle, never re-reads it live). */
  check("every builder resolves its prompt through the category+angle resolver",
    (APP.match(/return imageOnlyPrompt\(item, angle\);/g) || []).length >= 2 &&
    /return lookAnchorPrompt\(\);/.test(APP) &&
    /function buildCompositePrompt\(item, angle, inProfile\) \{[\s\S]*?imageOnlyPrompt\(item, angle\)/.test(APP),
    "buildPrompt, buildCustomPrompt bare-return it; buildCompositePrompt calls it as part of its own assembly; buildLookPrompt is the full-look exemption");
  check("...and neither anchor TABLE has an interpolation hole to leak a variant into",
    /const CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(APP) &&
    /const BACK_CATEGORY_ANCHOR = Object\.freeze\(\{[^`]*?\}\);/s.test(APP) &&
    !/CATEGORY_ANCHOR = Object\.freeze\(\{[\s\S]{0,900}?\$\{/.test(APP),
    "a template hole here is how a colour word gets back onto the wire");
  /* The resolver may branch on CATEGORY and ANGLE, and nothing else. A third input
     threaded in from a variant/colour/pose is how a description creeps back onto the
     wire - the exact failure this suite was written to catch on the category axis, now
     checked against the wider (but still exactly two-axis) surface. */
  check("...and the resolver branches on category and angle alone - nothing else",
    /const table = angle === "back" \? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;\s*\n\s*return fitPrompt\(\[\s*\n\s*\[P\.CORE, isBottomsGarment\(item\) \? table\.bottom : table\.top\],/.test(APP),
    "any other input to this function is a new axis the prompt can vary on");
  /* Comments stripped first: variantMetaOf's own doc block QUOTES the old call as the
     thing it replaced, and a check that trips over the explanation of the fix is worse
     than no check - it would force whoever reads it to delete the documentation. */
  const codeOnly = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no builder still interpolates the raw base colour",
    !/colorName\(item\.color\)/.test(codeOnly) && !/colorName\(top\.color\)/.test(codeOnly) &&
    !/colorName\(bottom\.color\)/.test(codeOnly));
  check("the cart bridge resolves through variantMetaOf too",
    /const meta = variantMetaOf\(activeItem\);/.test(APP) && /sku: meta\.sku,/.test(APP));
}

console.log("\n── §4 THE HOST BRIDGE REFUSES AN UNIDENTIFIED GARMENT ──");
{
  /* The guard, executed against the same shapes pearGetActiveGarment() can actually
     return: null (nothing selected), a real garment, and the {} the old `|| {}` made. */
  const guard = LUX.slice(LUX.indexOf("function usableGarment()"), LUX.indexOf("const GARMENT_RETRIES"));
  const usable = (g) => new Function("window", "console",
    guard + "\nreturn usableGarment;")(
      { pearGetActiveGarment: () => g }, { warn() {} })();

  check("null (nothing selected) is refused", usable(null) === null);
  check("the empty object the old `|| {}` produced is refused", usable({}) === null);
  check("a garment with blank identity is refused",
    usable({ sku: "", variantId: "", name: "Tee" }) === null);
  check("a garment with a sku is accepted", usable({ sku: "STRATA-CRM" })?.sku === "STRATA-CRM");
  check("a variantId alone is enough (stores that key off it, with no sku)",
    usable({ variantId: "gid://v/2" })?.variantId === "gid://v/2");

  const throwing = new Function("window", "console",
    guard + "\nreturn usableGarment;")(
      { pearGetActiveGarment: () => { throw new Error("app not ready"); } }, { warn() {} });
  check("a throwing accessor is treated as 'not ready', not propagated into the click",
    throwing() === null);

  /* The dangerous edit is re-adding a `|| ""` default: it makes an unidentified garment
     look identified again, one field at a time. */
  check("the postMessage payload no longer blank-defaults sku/variantId",
    !/sku: garment\.sku \|\| ""/.test(LUX) && !/variantId: garment\.variantId \|\| ""/.test(LUX));
  check("...and the blocked path warns and toasts instead of posting silently",
    /add-to-cart blocked: no identifiable active garment/.test(LUX) &&
    /No active item - pick a garment and try again/.test(LUX));
  check("a late-arriving garment is retried before giving up (handoff is async)",
    /function resolveGarment\(tries, cb\)/.test(LUX) && /GARMENT_RETRIES/.test(LUX));
}

console.log("\n── §5 DETECTION: the aspect gate the area gates cannot express ──");
{
  /* MIN/MAX_BOX_AREA_FRAC and MIN_BOX_DIM_FRAC already reject boxes that are too small,
     too large or too thin. None can reject a plausible SIZE with an implausible SHAPE -
     a shadow band or a column of wall - which is the crop that survives every other
     check and reaches Decart as if it were a garment. */
  const det = APP.slice(APP.indexOf("natural = refineGarments(natural, iw, ih, U);"),
                        APP.indexOf("function refineGarments(boxes, iw, ih, U)"));
  check("an aspect-ratio gate exists with explicit bounds",
    /const ASPECT_MIN = 0\.35;/.test(det) && /const ASPECT_MAX = 4\.0;/.test(det), det.slice(0, 200));
  check("it filters the refined boxes", /const shaped = natural\.filter/.test(det));
  check("a rejection is logged with the measured ratio, so a bad crop is diagnosable",
    /rejected \$\{b\.label \|\| "box"\} on aspect ratio/.test(det));
  /* Ordering: scoring before the gate would let a rejected shadow band's area-score
     carry the whole detection over the confidence bar. */
  check("confidence is scored on the SURVIVING set, not the pre-gate one",
    /const best = shaped\.reduce/.test(det) && /return shaped\.slice\(0, U\.MAX_BOXES\)/.test(det),
    det.slice(-300));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
