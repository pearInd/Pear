/* scanner/scan-store.js - findProductImages(), the HTML-scrape path every non-Shopify
   store goes through, and the only writer besides the server that fills garment_cache.

   THE BUG THIS CLOSES: the sweep took EVERY <img> on a product page - mega-menu
   wallpapers, payment badges, wishlist hearts, social icons - filtered only by a
   filename substring list, and each one was sent to Gemini and cached into
   garment_cache as a "front"/"back" row. Same failure the widget had in the browser on
   adidas.co.il (widget-dom fixture F), through the crawler's door.

   The scanner calls main() at load and exits without env vars, so the pure extraction
   functions are sliced out by marker and run standalone - no network, no Supabase. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scanner/scan-store.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function part(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return SRC.slice(start, end);
}
const code = part("const PRODUCT_LINK_PATTERNS", "/* ── Supabase cache") +
             part("const RESIZER_RE", "async function getCachedClassification");
const { findProductImages, jsonLdProductImages, stripChrome, isExcludedSrc } = new Function(
  code + "\nreturn { findProductImages, jsonLdProductImages, stripChrome, isExcludedSrc };")();

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* ── adidas.co.il PDP shape (gallery markup verbatim from its shipped main.js; chrome
   from the live page) - raw HTML, the way the crawler sees it ─────────────────────── */
const AD = "https://www.adidas.co.il";
const DIS = `${AD}/dw/image/v2/BFNL_PRD/on/demandware.static/-/Sites-adidas-products/default`;
const img = (n, sw) => `${DIS}/dw1a2b3c${n}0/zoom/HA6542_0${n}_laydown.jpg?sw=${sw}&sh=${sw}&sm=fit`;
const adidas = `<html><head><title>Fast Graphic Tee</title></head><body>
<header><img src="${AD}/on/demandware.static/-/Sites/default/dw3095a1e5/uspbar/usp-delivery.svg">
  <nav role="navigation"><img src="/on/demandware.static/Sites-adidas-IL-Site/-/default/dw2225a8fd/images/adidas_logo.svg">
    <div class="megamenu"><img src="/on/demandware.static/-/Sites-adidas-navigation-il/default/dwdfb58f3f/Training.png"></div></nav></header>
<!-- <img src="${AD}/old/commented-out-banner.jpg"> -->
<div class="primary-images">
  <div class="main_image"><img src="${img(1, 600)}" data-src="${img(1, 2000)}" itemprop="image"></div>
  <div class="main_image"><img src="${img(2, 600)}" data-src="${img(2, 2000)}" itemprop="image"></div>
  <div class="thumb_image"><img src="${img(1, 100)}" itemprop="image"></div>
  <div class="slick-slide"><img data-lazy="${img(2, 300)}"></div>
</div>
<a class="wishlistTile"><img class="js-heart heart-empty" src="/on/demandware.static/Sites-adidas-IL-Site/-/default/dw2225a8fd/images/heart-empty.svg"></a>
<footer><img src="${AD}/on/demandware.static/-/Library-Sites-AdidasSharedLibrary/default/dw4e74e8f1/images/adidas/social-media-icons/instagram.svg"></footer>
</body></html>`;

console.log("── adidas.co.il product page ──");
{
  const got = findProductImages(adidas, `${AD}/en/HA6542.html`);
  check("A1 no SVG is sent to Gemini (heart, logo, USP, social icons)", !got.some((u) => /\.svg/i.test(u)), JSON.stringify(got));
  check("A2 the nav mega-menu wallpaper (a 1200px raster) is not a garment photo", !got.some((u) => /Training\.png/.test(u)), JSON.stringify(got));
  check("A3 both product photos found", got.some((u) => /HA6542_01/.test(u)) && got.some((u) => /HA6542_02/.test(u)), JSON.stringify(got));
  check("A4 one entry per PHOTO - the ?sw=100/600/2000 spellings are one Gemini call, not four",
    got.length === 2, JSON.stringify(got));
  check("A5 commented-out markup is not scanned", !got.some((u) => /commented-out/.test(u)), JSON.stringify(got));
}

console.log("\n── schema.org JSON-LD ──");
{
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Shop","logo":"https://s.com/brand-mark.png","image":"https://s.com/share-default.jpg"},
      {"@type":"Product","name":"Runner Tee","image":[{"@type":"ImageObject","contentUrl":"https://cdn.s.com/p/runner-front.jpg"},"https://cdn.s.com/p/runner-rear.jpg"],
       "offers":{"@type":"Offer","image":"https://cdn.s.com/p/runner-OTHER-COLOUR.jpg"}}]}</script>
  </head><body><main><img src="https://cdn.s.com/p/runner-front.jpg?width=800"></main></body></html>`;
  const got = findProductImages(html, "https://s.com/p/runner-tee");
  check("B1 JSON-LD Product photos come first", got[0] === "https://cdn.s.com/p/runner-front.jpg", JSON.stringify(got));
  check("B2 ImageObject.contentUrl and plain strings both read", got.includes("https://cdn.s.com/p/runner-rear.jpg"), JSON.stringify(got));
  check("B3 the Organization node's logo/image is never read", !got.some((u) => /brand-mark|share-default/.test(u)), JSON.stringify(got));
  check("B4 a product's offers (other colourways) are not descended into", !got.some((u) => /OTHER-COLOUR/.test(u)), JSON.stringify(got));
  check("B5 the gallery's ?width=800 spelling of the front photo is not a second entry",
    got.filter((u) => /runner-front/.test(u)).length === 1, JSON.stringify(got));

  const grid = `<script type="application/ld+json">[{"@type":"Product","name":"Tee One","image":"https://c.com/1.jpg"},
    {"@type":"Product","name":"Tee Two","image":"https://c.com/2.jpg"}]</script>`;
  check("B6 a listing page's per-card Products are NOT one product's photos", jsonLdProductImages(grid).length === 0,
    JSON.stringify(jsonLdProductImages(grid)));
  const reviewApp = `<script type="application/ld+json">{"@type":"Product","name":"Tee","image":"https://c.com/tee.jpg"}</script>
    <script type="application/ld+json">{"@type":"https://schema.org/Product","name":"Tee","aggregateRating":{"ratingValue":4}}</script>`;
  check("B7 a review app repeating the Product block (full-IRI @type) is still ONE product",
    jsonLdProductImages(reviewApp).length === 1, JSON.stringify(jsonLdProductImages(reviewApp)));
  check("B8 a malformed JSON-LD block is skipped, not fatal",
    jsonLdProductImages(`<script type="application/ld+json">{not json</script>`).length === 0);
}

console.log("\n── exclusion rules ──");
check("C1 SVG rejected even with a query string", isExcludedSrc("https://s.com/i/heart.svg?v=3"));
check("C2 a raster whose QUERY mentions .svg is kept", !isExcludedSrc("https://s.com/p/tee.jpg?fallback=x.svg"));
check("C3 inline SVG data URL rejected", isExcludedSrc("data:image/svg+xml;base64,AAAA"));
check("C4 stripChrome keeps the content area and drops header/nav/footer",
  (() => {
    const out = stripChrome(`<header><img src=a.jpg></header><nav><img src=b.jpg></nav><div><img src=c.jpg></div><footer><img src=d.jpg></footer>`);
    return /c\.jpg/.test(out) && !/a\.jpg|b\.jpg|d\.jpg/.test(out);
  })());

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
