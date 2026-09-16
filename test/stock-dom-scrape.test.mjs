/* THE STOCK SCRAPE, RUN FOR REAL - widget/pear-widget.js in jsdom against storefront
   markup, no reimplementation.

   WHY THIS FILE EXISTS SEPARATELY FROM stock-fallback.test.mjs. That suite pins the
   pure halves (soldOutFromVariants, oosTokenSignal) and the structure of everything
   else, and it passed completely while the DOM tier was reporting EVERY size on a fully
   stocked product as sold out.

   THE BUG THIS CLOSES: nodeSaysOutOfStock() asked whether the element had a `disabled`
   attribute with `readAttr(node, "disabled") != null`. readAttr() returns "" for a
   MISSING attribute, never null - so that test was true for every element on the page,
   and a stocked S/M/L/XL ladder came back S/M/L/XL sold out. That is the one direction
   this feature is built never to fail in (CLAUDE.md §2.5: a wrong block stops a paying
   shopper; every OTHER failure mode here converges harmlessly on an empty list). A
   regex over the source cannot see it, because the line reads perfectly.

   So the tier that touches real nodes is exercised against real nodes: the four shapes
   storefronts actually ship (a <select> with disabled options, the Shopify
   <input disabled> + <label for> swatch, class/aria/text markers on buttons, and a
   Hebrew RTL picker), plus the two that must stay SILENT - a fully stocked product and
   a picker we cannot read at all.
   ============================================================================= */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

let fails = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log("        " + detail);
}

/* productJson: the body served at <path>.js, or null for a store with no Shopify API -
   which is how the DOM tier gets exercised at all (extractSoldOutSizes() prefers the
   variant tier whenever it yields sizes). */
async function run(name, html, productJson, assertions) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(`[${name}] jsdomError: ${e.message}`));
  vc.on("error", (...a) => errors.push(`[${name}] console.error: ${a.join(" ")}`));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://shop.example.com/products/tee", virtualConsole: vc,
  });
  const { window } = dom;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes("/api/classify-images")) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        results: body.images.map((x) => (/back|rear/i.test(x) ? "back" : "front")),
        front_image_url: body.front_image_url, back_image_url: "", back_source: "none",
      }) });
    }
    if (u.endsWith("/products/tee.js")) {
      if (!productJson) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productJson) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 40));       // the rAF-coalesced inject pass
  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = new URLSearchParams(iframe ? (iframe.src.split("?")[1] || "") : "");

  console.log(`\n=== ${name} ===`);
  assertions({ params, window });
  window.close();
}

const PAGE = (picker) => `<html lang="en"><head>
  <meta property="og:image" content="${SHOP}-1.jpg?width=1400"></head><body>
  <h1>Classic Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg?width=800" alt="front"></li>
    <li><img src="${PX}" data-src="${SHOP}-2_back.jpg?width=800" alt="back"></li>
  </ul>
  ${picker}
  <form action="/cart/add" method="post"><input name="id" value="99"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

/* ── §1 TIER 1: the store's own variant JSON ──────────────────────────────────── */
await run("§1 Shopify variants - L and XL genuinely gone", PAGE(""), {
  title: "Classic Tee", images: [`${SHOP}-1.jpg`, `${SHOP}-2_back.jpg`],
  options: [{ name: "Size" }],
  variants: [
    { id: 1, option1: "S", available: true },
    { id: 2, option1: "M", available: true },
    { id: 3, option1: "L", available: false },
    { id: 4, option1: "XL", available: false },
  ],
}, ({ params }) => {
  check("the size list reaches the room", params.get("garment_sizes") === "S,M,L,XL",
    params.get("garment_sizes"));
  check("...and so does the sold-out subset, in catalog order",
    params.get("garment_soldout") === "L,XL", params.get("garment_soldout"));
});

/* THE SILENT CASE, and the one that matters most: a fully stocked product must put
   NOTHING on the URL. An absent param is read by the room as "no stock evidence", which
   renders identically to "everything available" - that equivalence is what makes
   omitting it safe, and what makes every scrape failure harmless. */
await run("§2 nothing sold out - the param is absent, not empty", PAGE(""), {
  title: "Classic Tee", images: [`${SHOP}-1.jpg`], options: [{ name: "Size" }],
  variants: [{ id: 1, option1: "S", available: true }, { id: 2, option1: "M", available: true }],
}, ({ params }) => {
  check("no garment_soldout param at all", params.get("garment_soldout") === null,
    String(params.get("garment_soldout")));
});

/* Size x Colour: L gone in red but sitting in stock in blue is still a buyable L. */
await run("§3 two-option product - a size gone in ONE colour is not gone", PAGE(""), {
  title: "Classic Tee", images: [`${SHOP}-1.jpg`], options: [{ name: "Color" }, { name: "Size" }],
  variants: [
    { id: 1, option1: "Red", option2: "M", available: false },
    { id: 2, option1: "Blue", option2: "M", available: false },
    { id: 3, option1: "Red", option2: "L", available: false },
    { id: 4, option1: "Blue", option2: "L", available: true },
  ],
}, ({ params }) => {
  check("only the size unavailable in EVERY colour is reported",
    params.get("garment_soldout") === "M", params.get("garment_soldout"));
});

/* ── §4 TIER 2: the DOM, for every storefront that is not Shopify ─────────────── */
await run("§4 a <select> with disabled options", PAGE(`
  <select name="size-picker" id="size-select">
    <option value="">Choose a size</option>
    <option value="S">S</option>
    <option value="M">M</option>
    <option value="L" disabled>L</option>
    <option value="XL" disabled>XL</option>
  </select>`), null, ({ params }) => {
  check("the sizes are read off the control", params.get("garment_sizes") === "S,M,L,XL",
    params.get("garment_sizes"));
  /* THE REGRESSION. This read S,M,L,XL - the whole ladder - while `disabled` was tested
     with readAttr() != null. The in-stock sizes are the assertion that catches it. */
  check("ONLY the disabled options are sold out - S and M are untouched",
    params.get("garment_soldout") === "L,XL", params.get("garment_soldout"));
});

await run("§5 the Shopify swatch - value on the <label>, state on the <input>", PAGE(`
  <fieldset name="size-options" class="size-selector">
    <input type="radio" id="sz-s" name="Size" value="S">
    <label for="sz-s" data-value="S">S</label>
    <input type="radio" id="sz-m" name="Size" value="M" disabled>
    <label for="sz-m" data-value="M">M</label>
    <input type="radio" id="sz-l" name="Size" value="L">
    <label for="sz-l" data-value="L">L</label>
  </fieldset>`), null, ({ params }) => {
  check("sizes come off the labels", params.get("garment_sizes") === "S,M,L",
    params.get("garment_sizes"));
  /* Reading only the node the string came from misses this on a large share of real
     stores: the label is never disabled, the input it points at is. */
  check("the disabled INPUT behind the label is followed, and nothing else is claimed",
    params.get("garment_soldout") === "M", params.get("garment_soldout"));
});

await run("§6 class, aria and visually-hidden-text markers on buttons", PAGE(`
  <div class="size-swatch-list" data-option-name="Size">
    <button data-value="S">S</button>
    <button data-value="M" class="swatch sold-out">M</button>
    <button data-value="L" aria-disabled="true">L</button>
    <button data-value="XL">XL<span class="visually-hidden">Out of stock</span></button>
  </div>`), null, ({ params }) => {
  check("all three marker varieties are caught, and the unmarked S is not",
    params.get("garment_soldout") === "M,L,XL", params.get("garment_soldout"));
});

await run("§7 a Hebrew RTL picker", PAGE(`
  <select name="size" data-option-name="מידה">
    <option value="">בחר מידה</option>
    <option value="M">M</option>
    <option value="L" class="is-disabled">L</option>
  </select>`), null, ({ params }) => {
  check("the placeholder row is ignored and the marked size resolves",
    params.get("garment_sizes") === "M,L" && params.get("garment_soldout") === "L",
    params.get("garment_sizes") + " / " + params.get("garment_soldout"));
});

/* ── §8 FAIL-OPEN, end to end ─────────────────────────────────────────────────── */
await run("§8 a control we cannot read claims nothing, about anything", PAGE(`
  <select name="size-swatch-thing"><option>Red</option><option>Blue</option></select>`),
  null, ({ params }) => {
  check("no size list is claimed (a run of colours is not a size run)",
    params.get("garment_sizes") === null);
  check("...and no stock claim either - the documented safe state",
    params.get("garment_soldout") === null, String(params.get("garment_soldout")));
});

await run("§9 a store with no size control at all", PAGE(""), null, ({ params }) => {
  check("silent on both counts",
    params.get("garment_sizes") === null && params.get("garment_soldout") === null);
});

console.log("\n── console / jsdom errors raised while scraping ──");
if (errors.length) { errors.forEach((e) => console.log("  !! " + e)); fails += errors.length; }
else console.log("  none");

console.log(fails ? `\n${fails} FAILED` : "\nstock-dom-scrape: all green");
process.exit(fails ? 1 : 0);
