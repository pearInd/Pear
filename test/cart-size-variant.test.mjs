/* ADD-TO-CART SIZE→VARIANT MAPPING.

   THE GAP: pearGetActiveGarment() (fitting-room/app.js) already returns the LATEST
   tried-on size (activeTryOnSize || currentUserSize) on every click - that part was
   already correct. But addToShopifyCart() (widget/pear-widget.js) posts
   `{ id: payload.variantId, quantity }` to /cart/add.js, and payload.variantId is
   whatever extractVariantId() captured off the HOST PAGE's own Add-to-Cart button at
   handoff time - i.e. whatever size was selected on the PDP BEFORE the fitting room
   ever opened. Switching sizes in the room's own selector (setSizeOverride) changes
   the SIZE STRING sent along, but never re-resolved which Shopify variant id that
   corresponds to - so a shopper who tried on M, saw L recommended, and switched to L
   in-room, had M silently added to their real cart while the UI claimed success.

   findVariantForSize() closes that gap: given the product's own variants (Shopify
   product JSON, cached via loadShopifyProductJSON()) and the option index Shopify
   itself labels "Size" (never guessed positionally), it resolves the exact variant id
   for the shopper's current in-room size - disambiguating by the OTHER option
   (colour, etc.) using whichever variant was already captured, so a size change never
   silently changes the colour too. */
import { readFileSync } from "node:fs";

const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LUX = readFileSync(new URL("../fitting-room/lux-interactions.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

console.log("── §1 findVariantForSize(): pure, executed against realistic Shopify variant shapes ──");
{
  const code = extract(PW, "function normalizeSizeToken(", "/* ── COMBINED composite");
  const mod = await import("data:text/javascript," + encodeURIComponent(
    code + "\nexport { normalizeSizeToken, findVariantForSize };"
  ));
  const { findVariantForSize } = mod;

  // A real Shopify product.js shape: Size is option index 1 (position 2), Colour is
  // option index 0 (position 1) - deliberately NOT option1=size, to prove the option
  // INDEX is read from the product's own declared option name, never assumed to be
  // option1.
  const SIZE_IDX = 1;
  const variants = [
    { id: 100, option1: "Charcoal", option2: "M", sku: "TEE-CHR-M" },
    { id: 101, option1: "Charcoal", option2: "L", sku: "TEE-CHR-L" },
    { id: 102, option1: "Red",      option2: "M", sku: "TEE-RED-M" },
    { id: 103, option1: "Red",      option2: "L", sku: "TEE-RED-L" },
  ];

  check("REGRESSION TARGET: switching to a NEW size resolves the variant for that\n" +
        "        size while PRESERVING the colour of the currently-known variant",
    findVariantForSize(variants, SIZE_IDX, "L", 100)?.id === 101,
    JSON.stringify(findVariantForSize(variants, SIZE_IDX, "L", 100)));

  check("...and going the other direction (L -> M) does the same",
    findVariantForSize(variants, SIZE_IDX, "M", 103)?.id === 102);

  check("case/whitespace-insensitive size matching (' l ' matches 'L')",
    findVariantForSize(variants, SIZE_IDX, " l ", 100)?.id === 101);

  check("no fallback variant id known (e.g. a custom garment never captured off the\n" +
        "        DOM): still resolves by size alone rather than refusing outright",
    findVariantForSize(variants, SIZE_IDX, "L", null) != null);

  check("size option index unknown (-1, product has no declared 'Size' option):\n" +
        "        refuses to guess a positional index - returns null",
    findVariantForSize(variants, -1, "L", 100) === null);

  check("no variants loaded yet (fire-and-forget fetch hasn't resolved): returns null,\n" +
        "        never throws",
    findVariantForSize([], SIZE_IDX, "L", 100) === null);

  check("an unmatched size (kids numeric on an adult-only product): returns null\n" +
        "        rather than falling back to a wrong variant",
    findVariantForSize(variants, SIZE_IDX, "16", 100) === null);

  // Kids numeric scale - the same function, no special-casing needed, since it never
  // interprets the size string itself, only compares it against the option's own text.
  const kidsVariants = [
    { id: 200, option1: "12" }, { id: 201, option1: "14" }, { id: 202, option1: "16" },
  ];
  check("kids numeric sizes resolve exactly like adult alpha sizes",
    findVariantForSize(kidsVariants, 0, "16", 200)?.id === 202);
}

console.log("\n── §2 WIRING: the PEAR_ADD_TO_CART handler prefers the size-resolved variant ──");
{
  const handler = extract(PW, 'e.data.type !== "PEAR_ADD_TO_CART"', "addToHostCart(payload, platform)");
  check("the handler calls findVariantForSize() before deciding platform eligibility",
    /findVariantForSize\(/.test(handler), handler);
  check("a resolved match overrides payload.variantId - the whole point is that the\n" +
        "        DOM-captured id must NOT win once a size-matched variant exists",
    /variantId:\s*\w+\.id/.test(handler), handler);
}

console.log("\n── §3 SUCCESS MESSAGE: the in-modal toast names the size that was added ──");
{
  const land = extract(LUX, "function landWithGarment(garment) {", "function initMagnetic()");
  check("the iframe-embedded success toast includes the garment's size when known",
    /garment\.size/.test(land) && /springToast\(/.test(land), land);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
