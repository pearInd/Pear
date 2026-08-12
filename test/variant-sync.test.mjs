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
  /* The actual regression: three builders interpolated colorName(item.color). If any
     reverts, a swatch swap silently sends a contradicting colour word again. */
  /* The composite builder deliberately names NO colour: in AI Combined there is always a
     reference image on the wire, and its pixels state the colour more precisely than a
     word from a catalog hex. Naming one there buys nothing and costs a whole class of
     text-vs-image contradiction. The other two builders CAN run with no usable reference,
     so for them the word is the only colour information there is - they keep it, and it
     must resolve through the variant. */
  check("the composite builder points at the image and names no colour",
    APP.includes("`the ${noun} in the reference image`") &&
    APP.includes('"the exact garment in the reference image"'),
    "AI Combined must not assert a colour word against its own reference");
  for (const site of [
    "with ${colorName(activeColorOf(item))} ${noun}:",
    "replace their top with ${colorName(activeColorOf(top))}",
  ]) {
    check(`text-only builder still reads the VARIANT colour: ${site.slice(0, 40)}…`,
      APP.includes(site), site);
  }
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
