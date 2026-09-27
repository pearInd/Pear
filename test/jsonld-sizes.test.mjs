/* THE PRODUCT'S SIZE LIST FROM JSON-LD (proposal B) + THE PHASE 0 HANDOFF SIGNALS
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED: on adidas.it the DOM size scrape finds ZERO controls (the picker is built by
   client JS), while the page's own schema.org ProductGroup lists every variant's size:
       hasVariant[].size -> [undefined, "2XS", "XS", "S", "M", "L", "XL", "2XL", "3XL"]
   extractHostSizes() now reads that between the Shopify variant JSON and the DOM tier.

   WHAT THIS PINS
   §1 the pure parser (productFactsFromLd) on the adidas payload itself - the undefined
      entry is FILTERED before the plausibility check, never used to abstain - and on
      plain Product.offers[].size, SizeSpecification objects, @graph and mainEntity;
   §2 every refusal: two products on the page, a non-size value, one size only;
   §3 stock from schema.org availability, with the same "every offer must say gone" and
      "no availability anywhere means no claim" rules as the Shopify tier;
   §4 2XS / 3XS / XXXS are plausible size tokens (and an alpha run);
   §5 the tier ORDER, run for real in jsdom: Shopify variants > JSON-LD > DOM, and the
      stock reader follows the same tier as the size list;
   §6 the Phase 0 signals on the iframe URL: store_host, garment_gender (+ source).
   ============================================================================= */
import { readFileSync } from "node:fs";
import { openWidget, PDP, ldScript } from "./helpers/widget-jsdom.mjs";

const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function slice(src, start, end) {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`marker not found: ${start}`);
  const b = src.indexOf(end, a);
  if (b === -1) throw new Error(`end marker not found: ${end}`);
  return src.slice(a, b);
}

/* The pure halves, lifted out of the widget verbatim (no reimplementation). */
const code = [
  slice(PW, "var SIZE_TOKEN_ALPHA_RE", "/* @pear-shared:size-token END */"),
  slice(PW, "var PRODUCT_LD_TYPE_RE", "var _ldMemo"),
  slice(PW, "var LD_OUT_OF_STOCK_RE", "var _ldFactsMemo"),
  slice(PW, "function canonicalStoreHost(raw) {", "/* Strongest first: the store's own structured audience"),
  "function classifySizeRunType(sizes) {" + slice(PW, "function classifySizeRunType(sizes) {", "\n  }\n").slice("function classifySizeRunType(sizes) {".length) + "\n  }\n",
].join("\n");
const { productFactsFromLd, isPlausibleSizeToken, genderFromText, genderFromLdValue, canonicalStoreHost, classifySizeRunType } =
  await import("data:text/javascript," + encodeURIComponent(code +
    "\nexport { productFactsFromLd, isPlausibleSizeToken, genderFromText, genderFromLdValue, canonicalStoreHost, classifySizeRunType };"));

/* The adidas.it ProductGroup, reduced to the fields that matter. The first variant has
   NO size field - exactly what `hasVariant.map(v => v.size)` showed as undefined live. */
const ADIDAS_SIZES = [undefined, "2XS", "XS", "S", "M", "L", "XL", "2XL", "3XL"];
const adidas = (availability = () => "https://schema.org/InStock") => ({
  "@context": "https://schema.org",
  "@type": "ProductGroup",
  name: "T-shirt Adicolor Classics 3-Stripes",
  productGroupID: "IA4845",
  audience: { "@type": "PeopleAudience", suggestedGender: "https://schema.org/Male" },
  hasVariant: ADIDAS_SIZES.map((size, i) => {
    const v = { "@type": "Product", sku: "IA4845-" + i, offers: { "@type": "Offer", availability: availability(size, i) } };
    if (size !== undefined) v.size = size;
    return v;
  }),
});

console.log("\n── §1 the parser reads the declared size run ──");
{
  const f = productFactsFromLd([adidas()]);
  check("§1.1 adidas ProductGroup: the undefined entry is dropped, the run survives",
    f.sizes.join(",") === "2XS,XS,S,M,L,XL,2XL,3XL", f.sizes.join(","));
  check("§1.2 ...exactly one product was counted", f.productCount === 1, String(f.productCount));
  check("§1.3 ...and the audience reads as men", f.gender === "men", f.gender);

  /* The live payload literally contained an `undefined` in the mapped array; JSON cannot
     carry undefined, but a page can emit `"size": null` or `""` for the same parent
     offer - all three must be filtered, not treated as "a value that is not a size". */
  const withNulls = adidas();
  withNulls.hasVariant[0].size = null;
  withNulls.hasVariant.push({ "@type": "Product", size: "   ", offers: {} });
  check("§1.4 null and whitespace sizes are filtered before plausibility, never abstain",
    productFactsFromLd([withNulls]).sizes.join(",") === "2XS,XS,S,M,L,XL,2XL,3XL",
    productFactsFromLd([withNulls]).sizes.join(","));

  const offers = {
    "@type": "Product", name: "Plain Tee",
    offers: [
      { "@type": "Offer", size: "S", availability: "InStock" },
      { "@type": "Offer", size: "M", availability: "InStock" },
      { "@type": "Offer", itemOffered: { size: { "@type": "SizeSpecification", name: "L" } }, availability: "InStock" },
      { "@type": "Offer", price: "10" },                                  // no size at all
    ],
  };
  check("§1.5 plain Product.offers[].size (+ itemOffered.size as a SizeSpecification)",
    productFactsFromLd([offers]).sizes.join(",") === "S,M,L", productFactsFromLd([offers]).sizes.join(","));

  const graph = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", name: "Store", logo: "x.png" },
    { "@type": "WebPage", mainEntity: adidas() },
  ] };
  check("§1.6 @graph-wrapped (and mainEntity-nested) documents are read",
    productFactsFromLd([graph]).sizes.length === 8, productFactsFromLd([graph]).sizes.join(","));

  const aggregate = { "@type": "Product", name: "Tee", offers: { "@type": "AggregateOffer",
    offers: [{ size: "S" }, { size: "M" }, { size: "M" }] } };
  check("§1.7 AggregateOffer.offers[] are read, and a repeated size is kept once",
    productFactsFromLd([aggregate]).sizes.join(",") === "S,M", productFactsFromLd([aggregate]).sizes.join(","));

  const numeric = { "@type": "Product", name: "Jeans", offers: [{ size: 30 }, { size: 32 }, { size: 34 }] };
  check("§1.8 numeric sizes (a number, not a string) are read",
    productFactsFromLd([numeric]).sizes.join(",") === "30,32,34", productFactsFromLd([numeric]).sizes.join(","));
}

console.log("\n── §2 every refusal is a whole-list abstain ──");
{
  const two = [adidas(), { "@type": "Product", name: "Other Tee", offers: [{ size: "S" }, { size: "M" }] }];
  check("§2.1 two products on the page (a grid) -> no sizes", productFactsFromLd(two).sizes.length === 0);
  const junk = { "@type": "Product", name: "Tee", offers: [{ size: "S" }, { size: "M" }, { size: "One Size Fits All" }] };
  check("§2.2 one non-size value -> the whole list abstains", productFactsFromLd([junk]).sizes.length === 0);
  const one = { "@type": "Product", name: "Tee", offers: [{ size: "M" }] };
  check("§2.3 a single size is not a run", productFactsFromLd([one]).sizes.length === 0);
  const org = { "@type": "Organization", name: "Store" };
  check("§2.4 no product at all -> nothing", productFactsFromLd([org]).sizes.length === 0 &&
    productFactsFromLd([org]).productCount === 0);
  check("§2.5 garbage input never throws", productFactsFromLd([null, 42, "x", []]).sizes.length === 0 &&
    productFactsFromLd(undefined).sizes.length === 0);
}

console.log("\n── §3 stock from schema.org availability ──");
{
  const f = productFactsFromLd([adidas((size) =>
    size === "3XL" || size === "2XS" ? "https://schema.org/OutOfStock" : "https://schema.org/InStock")]);
  check("§3.1 sizes whose every offer is OutOfStock are sold out, in catalog order",
    f.soldOut.join(",") === "2XS,3XL", f.soldOut.join(","));

  const multi = { "@type": "ProductGroup", name: "Tee", hasVariant: [
    { size: "M", offers: { availability: "OutOfStock" } },   // M in red - gone
    { size: "M", offers: { availability: "InStock" } },      // M in blue - buyable
    { size: "L", offers: { availability: "SoldOut" } },
  ] };
  check("§3.2 a size gone in ONE colour but buyable in another is NOT sold out",
    productFactsFromLd([multi]).soldOut.join(",") === "L", productFactsFromLd([multi]).soldOut.join(","));

  const unstated = { "@type": "Product", name: "Tee", offers: [{ size: "S" }, { size: "M" }] };
  check("§3.3 no availability anywhere -> no sold-out claim at all",
    productFactsFromLd([unstated]).soldOut.length === 0);
  const partial = { "@type": "Product", name: "Tee", offers: [
    { size: "S", availability: "OutOfStock" }, { size: "S" }, { size: "M", availability: "InStock" }] };
  check("§3.4 an offer with no availability counts as NOT gone",
    productFactsFromLd([partial]).soldOut.length === 0, productFactsFromLd([partial]).soldOut.join(","));
}

console.log("\n── §4 the size-token vocabulary ──");
{
  for (const t of ["2XS", "3XS", "XXXS", "2xs", "XXS", "3XL", "5XL", "M", "38"]) {
    check(`§4 ${t} is a plausible size token`, isPlausibleSizeToken(t) === true);
  }
  for (const t of ["6XS", "1XS", "Small-ish", "One Size", "", "XXXXXXL"]) {
    check(`§4 "${t}" is not`, isPlausibleSizeToken(t) === false);
  }
  check("§4 the adidas run is an ALPHA run (the room's waist-chart veto needs this)",
    classifySizeRunType(["2XS", "XS", "S", "M", "L", "XL", "2XL", "3XL"]) === "alpha");
}

console.log("\n── §5 tier order, run for real ──");
{
  /* The adidas situation: JSON-LD present, NO DOM control at all. */
  let r = await openWidget(PDP("", ldScript(adidas((s) => (s === "3XL" ? "OutOfStock" : "InStock")))));
  check("§5.1 no DOM picker + JSON-LD run -> the JSON-LD run reaches the room",
    r.params.get("garment_sizes") === "2XS,XS,S,M,L,XL,2XL,3XL", String(r.params.get("garment_sizes")));
  check("§5.2 ...with its stock", r.params.get("garment_soldout") === "3XL", String(r.params.get("garment_soldout")));
  check("§5.3 ...and its run type", r.params.get("garment_size_type") === "alpha", String(r.params.get("garment_size_type")));
  check("§5.4 no widget errors", r.errors.length === 0, r.errors.join(" | "));

  /* JSON-LD outranks the DOM: a DOM picker that says something else loses. */
  const picker = `<select name="size"><option>Choose</option><option>S</option><option>M</option></select>`;
  r = await openWidget(PDP(picker, ldScript({ "@type": "Product", name: "Tee",
    offers: [{ size: "XS", availability: "InStock" }, { size: "S", availability: "InStock" }, { size: "M", availability: "OutOfStock" }] })));
  check("§5.5 JSON-LD sits ABOVE the DOM scrape", r.params.get("garment_sizes") === "XS,S,M",
    String(r.params.get("garment_sizes")));
  check("§5.6 ...and stock comes from the same tier as the list (M gone per JSON-LD)",
    r.params.get("garment_soldout") === "M", String(r.params.get("garment_soldout")));

  /* ...and Shopify's own variant JSON outranks JSON-LD. */
  r = await openWidget(PDP("", ldScript(adidas())), { productJson: {
    title: "Classic Tee", images: [], options: [{ name: "Size" }],
    variants: [{ id: 1, option1: "S", available: true }, { id: 2, option1: "M", available: false }],
  } });
  check("§5.7 Shopify variants sit ABOVE JSON-LD", r.params.get("garment_sizes") === "S,M",
    String(r.params.get("garment_sizes")));
  check("§5.8 ...and stock follows the Shopify tier", r.params.get("garment_soldout") === "M",
    String(r.params.get("garment_soldout")));

  /* No JSON-LD run -> the DOM tier still works exactly as before. */
  r = await openWidget(PDP(picker));
  check("§5.9 without JSON-LD the DOM tier is unchanged", r.params.get("garment_sizes") === "S,M",
    String(r.params.get("garment_sizes")));
  /* A JSON-LD block that abstains (two products) must fall through, not block the DOM. */
  r = await openWidget(PDP(picker, ldScript([{ "@type": "Product", name: "A", offers: [{ size: "S" }, { size: "M" }] },
    { "@type": "Product", name: "B", offers: [{ size: "L" }, { size: "XL" }] }])));
  check("§5.10 an abstaining JSON-LD tier falls through to the DOM",
    r.params.get("garment_sizes") === "S,M", String(r.params.get("garment_sizes")));
  r = await openWidget(PDP(picker, `<script type="application/ld+json">{ not json</script>`));
  check("§5.11 malformed JSON-LD falls through without an error",
    r.params.get("garment_sizes") === "S,M" && r.errors.length === 0, r.errors.join(" | "));
}

console.log("\n── §6 Phase 0 handoff signals ──");
{
  check("§6.1 canonicalStoreHost strips scheme, www., port, path and case",
    canonicalStoreHost("https://WWW.Fox.co.il:443/products/x?y=1") === "fox.co.il");
  check("§6.2 ...and m. and a trailing dot", canonicalStoreHost("m.terminalx.com.") === "terminalx.com");
  check("§6.3 ...keeps a real subdomain", canonicalStoreHost("shop.adidas.co.il") === "shop.adidas.co.il");
  check("§6.4 ...refuses what is not a host", canonicalStoreHost("localhost") === "" &&
    canonicalStoreHost("") === "" && canonicalStoreHost("a b.com") === "");

  check("§6.5 'women' never reads as men", genderFromText("/collections/women/tops") === "women");
  check("§6.6 men's path", genderFromText("/en/mens-t-shirts") === "men");
  check("§6.7 Hebrew with a prefix letter", genderFromText("/collections/לגברים") === "men" &&
    genderFromText("בית > נשים > חולצות") === "women");
  check("§6.8 both genders named -> abstain", genderFromText("Men | Women | Kids") === "");
  check("§6.9 unisex", genderFromText("unisex hoodie") === "unisex");
  check("§6.10 suggestedGender forms", genderFromLdValue("https://schema.org/Female") === "women" &&
    genderFromLdValue("male") === "men" && genderFromLdValue({ name: "Unisex" }) === "unisex" && genderFromLdValue("") === "");

  let r = await openWidget(PDP("", ldScript(adidas())), { url: "https://www.adidas.co.il/en/tee/IA4845.html" });
  check("§6.11 store_host is canonical", r.params.get("store_host") === "adidas.co.il", String(r.params.get("store_host")));
  check("§6.12 JSON-LD audience wins, and says so",
    r.params.get("garment_gender") === "men" && r.params.get("garment_gender_source") === "jsonld",
    `${r.params.get("garment_gender")} via ${r.params.get("garment_gender_source")}`);

  r = await openWidget(PDP(""), { url: "https://shop.example.com/women/products/tee" });
  check("§6.13 no audience -> the URL path", r.params.get("garment_gender") === "women" &&
    r.params.get("garment_gender_source") === "url",
    `${r.params.get("garment_gender")} via ${r.params.get("garment_gender_source")}`);

  r = await openWidget(PDP(`<nav aria-label="Breadcrumb"><a>Home</a> / <a>Men</a> / <a>Tees</a></nav>`));
  check("§6.14 no audience, no URL word -> the breadcrumb", r.params.get("garment_gender") === "men" &&
    r.params.get("garment_gender_source") === "breadcrumb",
    `${r.params.get("garment_gender")} via ${r.params.get("garment_gender_source")}`);

  r = await openWidget(PDP(""));
  check("§6.15 nothing -> 'unknown' is SENT (distinguishable from an old widget)",
    r.params.get("garment_gender") === "unknown" && r.params.get("garment_gender_source") === "none",
    `${r.params.get("garment_gender")} via ${r.params.get("garment_gender_source")}`);
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("jsonld-sizes: all checks passed.");
