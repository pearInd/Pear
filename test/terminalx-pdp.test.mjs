/* TERMINALX.COM - THE WIDGET ON A REACT/MAGENTO PDP (2026-11-06). widget/pear-widget.js in jsdom
   against the markup terminalx.com ships (read off the live page that day), no reimplementation.

   Three gaps, each found on the live page:
   §1 the cart button reads "הוספה לסל" (the noun form) in no cart <form> - the PEAR button fell
      back to sitting under the <h1>; it now sits right after the cart button.
   §2 photos are named <sku>-<n><asset id> (k042580001-11782915605.jpg, ...-21782915605.jpg): the
      LONGEST digit run is the per-photo id, so every photo but the primary was rejected as another
      product's and no back photo reached the room. Photos sharing the SKU run are one product now; a
      neighbouring product's photo (another SKU) is still rejected. The JSON-LD copy of the primary
      (?image_type_mobile=...) is the same photo as the gallery copy, not a second one.
   §3 the size picker is bare <div data-test-id="qa-size-item">s; jeans spell sizes "30W-32L". The
      sizes reach the room (waists for jeans, one size per waist, in stock if any length is).
   ============================================================================= */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const CDN = "https://media.terminalx.com/pub/media/catalog/product/cache/f112238e8de94b6d480bd02e7a9501b8";
let fails = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log("        " + detail);
}

async function run(name, html, assertions) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(`[${name}] jsdomError: ${e.message}`));
  vc.on("error", (...a) => errors.push(`[${name}] console.error: ${a.join(" ")}`));
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://www.terminalx.com/men/pants/k042580001?color=5082", virtualConsole: vc });
  const { window } = dom;
  let classified = null;
  window.fetch = (url, opts) => {
    if (String(url).includes("/api/classify-images")) {
      classified = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: classified.images.map(() => "front"),
        front_image_url: classified.front_image_url, back_image_url: "", back_source: "none" }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 40));
  const btn = window.document.querySelector(".pear-widget-btn");
  const prev = btn && btn.previousElementSibling;
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = new URLSearchParams(iframe ? (iframe.src.split("?")[1] || "") : "");
  console.log(`\n=== ${name} ===`);
  assertions({ btn, prev, params, classified, window });
  window.close();
}

const SKU = "k042580001";
const photo = (n, sku = SKU, id = "1782915605") => `${CDN}/k/0/${sku}-${n}${id}.jpg`;
const PAGE = (sizes) => `<html class="rtl" dir="rtl" lang="he"><head>
  <meta property="og:image" content="${photo(1)}?image_type_mobile=webp_jpeg_like_70">
  <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product",
    name: "שורט כדורגל REAL H SHO", image: [`${photo(1)}?image_type_mobile=webp_jpeg_like_70`, `${photo(2)}?image_type_mobile=webp_jpeg_like_70`] })}</script>
  </head><body><main>
  <div class="image-container_3NPt">${[1, 2, 3].map((n) => `<div class="slick-slide"><div class="image-div_3hfI"><img src="${photo(n)}" class="image_3k9y" alt="שורט"></div></div>`).join("")}</div>
  <div class="info-column_3TEX"><div class="name-and-brand_m2Cb"><div class="brand_2ltz">ADIDAS</div><h1 class="name_20R6" data-test-id="qa-pdp-name">שורט כדורגל REAL H SHO</h1></div>
  <div class="atc-wrap_1T-P"><div class="attribute-wrapper_1ON9"><div class="label-sizes_1dUf"><div>מידה</div></div><div class="size_1bXM">${sizes}</div></div>
  <button class="tx-link-a btn_nDwA btn-yellow_2tf3" data-test-id="qa-add-to-cart-button">הוספה לסל</button></div></div>
  <div class="similar-products slick-slide"><img class="image_3k9y" src="${photo(1, "r700450001", "1787804704")}" alt="other"></div>
  </main></body></html>`;
const item = (t, oos) => `<div data-test-id="qa-size-item" class="size-item_1Sai rtl_3a50${oos ? " out-of-stock_1yNg" : ""}" title="${t} : מידה">${t}</div>`;

await run("§1-§3 a letter-sized product", PAGE(["S", "M", "L", "XL", "2XL"].map((t) => item(t, t === "XL")).join("")), ({ btn, prev, params, classified }) => {
  check("§1.1 one PEAR button", !!btn);
  check("§1.2 ...right after the store's 'הוספה לסל' button", prev && prev.textContent.trim() === "הוספה לסל", prev && prev.outerHTML.slice(0, 80));
  const imgs = (classified && classified.images) || [];
  const has = (n) => imgs.some((u) => u.split("?")[0] === photo(n));
  check("§2.1 every photo of the product reaches the classifier (1, 2, 3)", has(1) && has(2) && has(3), JSON.stringify(imgs));
  check("§2.2 ...the primary once, not as two spellings", imgs.filter((u) => u.split("?")[0] === photo(1)).length === 1, JSON.stringify(imgs));
  check("§2.3 ...and no other product's photo", !imgs.some((u) => u.includes("r700450001")), JSON.stringify(imgs));
  check("§3.1 the product's own sizes reach the room", params.get("garment_sizes") === "S,M,L,XL,2XL", params.get("garment_sizes"));
  check("§3.2 ...and the sold-out one", params.get("garment_soldout") === "XL", String(params.get("garment_soldout")));
});

await run("§3 jeans in waist-by-length sizes", PAGE([["28W-30L", 1], ["30W-30L", 1], ["30W-32L", 0], ["32W-32L", 0], ["34W-32L", 0]].map(([t, o]) => item(t, o)).join("")), ({ params }) => {
  check("§3.3 read as waists, one per waist", params.get("garment_sizes") === "28,30,32,34", params.get("garment_sizes"));
  check("§3.4 a waist in stock in one length is in stock", params.get("garment_soldout") === "28", String(params.get("garment_soldout")));
});

console.log("\n── console / jsdom errors ──");
if (errors.length) { errors.forEach((e) => console.log("  !! " + e)); fails += errors.length; } else console.log("  none");
console.log(fails ? `\n${fails} FAILED` : "\nterminalx-pdp: all green");
process.exit(fails ? 1 : 0);
