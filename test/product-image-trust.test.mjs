/* Trust-tiered image exclusion - the "Icon collection" block.

   THE BUG THIS CLOSES: isExcludedSrc() rejected any URL containing "logo", "icon",
   "sprite", "placeholder", "blank"/"pixel" (widget) or "banner"/"avatar" (scanner), as a
   bare substring, applied identically to EVERY source. That list exists for real
   reasons - a logo og:image became the garment once, and a wishlist heart shipped as the
   garment on adidas.co.il - but as a blanket URL test it also rejects PRODUCTS:

     icon-8-tee.jpg              adidas ships an "Icon" apparel line
     iconic-oversized-hoodie.jpg "iconic" is ordinary fashion copy
     adicolor-logo-tee.jpg       "Logo Tee" is an industry staple, not chrome
     avatar-graphic-tee.jpg      licensed merch (scanner list only)

   Worse, it applied to images the STORE ITSELF declared as the product: a PDP whose
   JSON-LD Product.image lists two "icon-8-tee" photos returned ZERO images from
   findProductImages(), so garment_cache never got a row and try-on was blocked - the
   same end state as the wishlist-heart bug, from the opposite direction.

   THE RULE NOW: a keyword is weak evidence, so it only decides where there is nothing
   better. Three tiers, in order:
     1. SVG is refused ALWAYS, at every tier. That is not a heuristic - Gemini cannot
        classify one and the try-on engine cannot read one, so it is a capability limit.
     2. DECLARED sources bypass the keyword list entirely: JSON-LD Product.image, the
        store's own product API (Shopify /products/x.js), the theme's product-gallery
        selectors, itemprop="image". The store named this image as the product; a
        substring in its filename does not outrank that.
     3. Everything else (generic DOM sweeps, the ancestor walk-up, thumbnails, an
        uncorroborated og:image) keeps the keyword list - AND gains a second escape: a
        token that also appears in the PRODUCT'S OWN NAME is explained by the product,
        not by chrome. "Icon 8 Tee" explains "icon"; "Fast Graphic Tee" does not.

   og:image deliberately does NOT get tier 2 on its own. It is page-level, and stores
   routinely leave it on a site-wide share image - that is the documented "logo og:image
   became the garment" bug (widget-dom J2, I1). It is promoted to declared only when the
   page's own single-product JSON-LD lists it too. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET_RAW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const WIDGET = WIDGET_RAW.replace(/\r\n/g, "\n");
const SCANNER = rd("../scanner/scan-store.js");

let fails = 0;
const check = (label, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
};

/* ── the two REAL predicates, executed (never re-implemented here) ─────────────── */
const widgetEx = new Function(
  WIDGET.slice(WIDGET.indexOf("var EXCLUDE_SRC"), WIDGET.indexOf("var MAX_GALLERY_IMAGES")) +
  WIDGET.slice(WIDGET.indexOf("function isExcludedSrc"), WIDGET.indexOf("/* ── back-image discovery helpers")) +
  "\nreturn isExcludedSrc;")();

const scannerPart = (a, b) => SCANNER.slice(SCANNER.indexOf(a), SCANNER.indexOf(b, SCANNER.indexOf(a)));
const scannerApi = new Function(
  scannerPart("const PRODUCT_LINK_PATTERNS", "/* ── Supabase cache") +
  scannerPart("const RESIZER_RE", "async function getCachedClassification") +
  "\nreturn { isExcludedSrc, findProductImages };")();
const scannerEx = scannerApi.isExcludedSrc;
const { findProductImages } = scannerApi;

const COPIES = [["pear-widget.js", widgetEx], ["scan-store.js", scannerEx]];
const bothAgree = (label, url, ctx, want) => {
  const got = COPIES.map(([n, fn]) => [n, fn(url, ctx)]);
  const agree = got.every(([, v]) => v === got[0][1]);
  check(label, agree && got[0][1] === want, `want=${want} got ${JSON.stringify(Object.fromEntries(got))}`);
};

const AD = "https://assets.adidas.com/images/w_1880,f_auto,q_auto/abc123_9366";

console.log("── §1 tier 3 (generic scraping): the keyword list still works, unchanged ──");
bothAgree("§1.1 a UI icon is still chrome", "https://s.com/assets/cart-icon.png", undefined, true);
bothAgree("§1.2 a site logo is still chrome", "https://s.com/assets/site-logo.png", undefined, true);
bothAgree("§1.3 a sprite sheet is still chrome", "https://s.com/assets/sprite.png", undefined, true);
bothAgree("§1.4 a placeholder is still chrome", "https://s.com/img/placeholder.jpg", undefined, true);
bothAgree("§1.5 an ordinary product photo passes", `${AD}/fast-graphic-tee.jpg`, undefined, false);
bothAgree("§1.6 a wishlist heart SVG is refused", "https://s.com/i/heart-empty.svg", undefined, true);

console.log("\n── §1b back-compat: a one-argument call behaves EXACTLY as before ──");
bothAgree("§1.7 icon-8-tee with no context is still refused (tier 3 default)",
  `${AD}/icon-8-tee.jpg`, undefined, true);
check("§1.8 an empty string is not 'excluded' (callers guard on falsiness themselves)",
  widgetEx("") === false && scannerEx("") === false);

console.log("\n── §2 tier 2: a DECLARED image bypasses the keyword list ──");
bothAgree("§2.1 adidas Icon line, declared by the store", `${AD}/icon-8-tee.jpg`, { declared: true }, false);
bothAgree("§2.2 a 'Logo Tee', declared", `${AD}/adicolor-logo-tee.jpg`, { declared: true }, false);
bothAgree("§2.3 'iconic' copy, declared", `${AD}/iconic-oversized-hoodie.jpg`, { declared: true }, false);
bothAgree("§2.4 licensed 'Avatar' merch, declared", `${AD}/avatar-graphic-tee.jpg`, { declared: true }, false);

console.log("\n── §2b tier 1 outranks tier 2: SVG is refused even when declared ──");
bothAgree("§2.5 a declared SVG is STILL refused - Gemini cannot read one",
  "https://s.com/i/heart-empty.svg", { declared: true }, true);
bothAgree("§2.6 ...including an inline SVG data URL",
  "data:image/svg+xml;base64,AAAA", { declared: true }, true);

console.log("\n── §3 tier 3 escape: the PRODUCT'S OWN NAME explains the token ──");
bothAgree("§3.1 'Icon 8 Tee' explains 'icon' in its own filename",
  `${AD}/icon-8-tee.jpg`, { name: "Icon 8 Tee" }, false);
bothAgree("§3.2 'Adicolor Logo Tee' explains 'logo'",
  `${AD}/adicolor-logo-tee.jpg`, { name: "Adicolor Logo Tee" }, false);
bothAgree("§3.3 the name is matched case-insensitively",
  `${AD}/icon-8-tee.jpg`, { name: "ICON 8 TEE" }, false);
bothAgree("§3.4 an UNRELATED product name rescues nothing - the cart icon stays chrome",
  "https://s.com/assets/cart-icon.png", { name: "Fast Graphic Tee" }, true);
bothAgree("§3.5 ...and neither does an empty name",
  "https://s.com/assets/site-logo.png", { name: "" }, true);
bothAgree("§3.6 a name mentioning 'icon' still cannot rescue an SVG",
  "https://s.com/i/heart.svg", { name: "Icon 8 Tee" }, true);

console.log("\n── §4 cross-file lockstep (CLAUDE.md §3): one token list, not two ──");
{
  const listOf = (src, decl) => {
    const m = new RegExp(decl + "\\s*=\\s*\\[([^\\]]*)\\]").exec(src);
    return m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean).sort() : null;
  };
  const w = listOf(WIDGET, "var EXCLUDE_SRC");
  const s = listOf(SCANNER, "const EXCLUDE_IMG_SRC");
  check("§4.1 the widget and the scanner block the SAME tokens",
    !!w && !!s && JSON.stringify(w) === JSON.stringify(s),
    `widget=${JSON.stringify(w)}\n        scanner=${JSON.stringify(s)}`);
}

/* ── §5 the crawler, end to end on real HTML ───────────────────────────────────── */
console.log("\n── §5 scan-store.js findProductImages() ──");
{
  const html = `<html><head><title>Icon 8 Tee</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Icon 8 Tee",
   "image":["${AD}/icon-8-tee.jpg","${AD}/icon-8-tee-back.jpg"]}</script>
  <meta property="og:image" content="${AD}/icon-8-tee.jpg"></head>
  <body><header><img src="https://s.com/assets/site-logo.png"></header>
  <main><img src="${AD}/icon-8-tee.jpg"><img src="https://s.com/assets/cart-icon.png"></main>
  </body></html>`;
  const got = findProductImages(html, "https://www.adidas.co.il/en/HA6542.html");
  check("§5.1 the DECLARED Icon photos are returned (were: zero images, try-on blocked)",
    got.length >= 2 && got.some((u) => /icon-8-tee\.jpg/.test(u)) && got.some((u) => /icon-8-tee-back\.jpg/.test(u)),
    JSON.stringify(got));
  check("§5.2 the header logo is still refused", !got.some((u) => /site-logo/.test(u)), JSON.stringify(got));
  check("§5.3 the cart icon is still refused - the product name does not explain it",
    !got.some((u) => /cart-icon/.test(u)), JSON.stringify(got));
}
{
  /* No JSON-LD at all: the ONLY evidence is the page's own name, and the <img> sweep is
     tier 3. This is the store that ships no structured data - the majority. */
  const html = `<html><head><title>Icon 8 Tee | adidas</title></head>
  <body><main><h1>Icon 8 Tee</h1><img src="${AD}/icon-8-tee.jpg"></main>
  <footer><img src="https://s.com/assets/site-logo.png"></footer></body></html>`;
  const got = findProductImages(html, "https://www.adidas.co.il/en/HA6542.html");
  check("§5.4 with no structured data, the product NAME still rescues its own photo",
    got.some((u) => /icon-8-tee/.test(u)), JSON.stringify(got));
  check("§5.5 ...and the footer logo is still refused", !got.some((u) => /site-logo/.test(u)), JSON.stringify(got));
}
{
  /* The documented og:image failure, from the scanner's side: a store-wide logo share
     image on a product page whose JSON-LD does not list it. */
  const html = `<html><head><title>Fast Graphic Tee</title>
  <meta property="og:image" content="https://s.com/brand/site-logo.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Fast Graphic Tee",
   "image":["${AD}/fast-graphic-tee.jpg"]}</script></head>
  <body><main><img src="${AD}/fast-graphic-tee.jpg"></main></body></html>`;
  const got = findProductImages(html, "https://s.com/p/tee");
  check("§5.6 a logo og:image the JSON-LD does not list is NOT promoted to declared",
    !got.some((u) => /site-logo/.test(u)), JSON.stringify(got));
  check("§5.7 ...while the real declared photo is kept",
    got.some((u) => /fast-graphic-tee/.test(u)), JSON.stringify(got));
}

/* ── §6 the widget, end to end in jsdom, on an adidas-shaped PDP ───────────────── */
const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
async function runWidget(name, html, assertions, opts = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error("!! JSDOM ERROR:", e.message));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: opts.url || "https://www.adidas.co.il/en/HA6542.html", virtualConsole: vc,
  });
  const { window } = dom;
  let classifyBody = null;
  window.fetch = (url, o) => {
    if (String(url).includes("/api/classify-images")) {
      classifyBody = JSON.parse(o.body);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: classifyBody.images.map((u) => (/back|rear/i.test(u) ? "back" : "front")),
          front_image_url: classifyBody.front_image_url,
          back_image_url: classifyBody.back_image_url ||
            classifyBody.images.find((u) => /back|rear/i.test(u)) || "",
          back_source: classifyBody.back_image_url ? "dom" : "classifier",
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET_RAW;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 20));
  const btn = window.document.querySelectorAll(".pear-widget-btn")[0] || null;
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = iframe ? new URLSearchParams(iframe.src.split("?")[1] || "") : new URLSearchParams();
  console.log(`\n── §6 ${name} ──`);
  assertions({ btn, classifyBody, params });
  dom.window.close();
}

await runWidget("adidas 'Icon 8 Tee' PDP - JSON-LD declares the gallery", `
<html><head><title>Icon 8 Tee</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Icon 8 Tee",
   "image":["${AD}/icon-8-tee.jpg","${AD}/icon-8-tee-back.jpg"]}</script>
</head><body>
  <header><nav><img class="logo" src="https://s.com/assets/site-logo.png"></nav></header>
  <h1>Icon 8 Tee</h1>
  <div class="main_image"><img itemprop="image" src="${AD}/icon-8-tee.jpg" alt="Icon 8 Tee front"></div>
  <div class="main_image"><img itemprop="image" src="${PX}" data-src="${AD}/icon-8-tee-back.jpg" alt="Icon 8 Tee back view"></div>
  <a class="wishlistTile"><img class="js-heart" src="https://s.com/i/heart-empty.svg"></a>
  <button class="add-to-bag">Add to Bag</button>
</body></html>`, ({ btn, classifyBody, params }) => {
  check("§6.1 the widget injected its button", !!btn);
  check("§6.2 the garment is the Icon photo, not nothing and not the heart",
    /icon-8-tee\.jpg/.test(params.get("garment_url") || ""), params.get("garment_url"));
  check("§6.3 both declared Icon photos reach the classifier",
    !!classifyBody && classifyBody.images.length >= 2 &&
    classifyBody.images.every((u) => /icon-8-tee/.test(u)),
    JSON.stringify(classifyBody && classifyBody.images));
  check("§6.4 the back view survived (it is an 'icon' URL too)",
    /icon-8-tee-back/.test((classifyBody && classifyBody.back_image_url) || ""),
    classifyBody && classifyBody.back_image_url);
  check("§6.5 the wishlist heart SVG is nowhere in the payload",
    !!classifyBody && !JSON.stringify(classifyBody).includes("heart-empty"),
    JSON.stringify(classifyBody && classifyBody.images));
  check("§6.6 the site logo is nowhere in the payload",
    !!classifyBody && !JSON.stringify(classifyBody).includes("site-logo"),
    JSON.stringify(classifyBody && classifyBody.images));
});

await runWidget("no structured data - the product NAME is the only evidence", `
<html><head><title>Icon 8 Tee | adidas</title></head><body>
  <header><img src="https://s.com/assets/site-logo.png"></header>
  <h1>Icon 8 Tee</h1>
  <div class="product-image"><img src="${AD}/icon-8-tee.jpg" alt="Icon 8 Tee"></div>
  <button class="add-to-bag">Add to Bag</button>
</body></html>`, ({ btn, params }) => {
  check("§6.7 button injected", !!btn);
  check("§6.8 the gallery-selector photo is the garment despite 'icon' in its URL",
    /icon-8-tee\.jpg/.test(params.get("garment_url") || ""), params.get("garment_url"));
});

/* ── §7 the button has to exist before any of this matters ────────────────────── */
await runWidget("'Add to Bag' - adidas/Nike/ASOS wording, matched by TEXT alone", `
<html><head><title>Icon 8 Tee</title></head><body>
  <h1>Icon 8 Tee</h1>
  <div class="main_image"><img itemprop="image" src="${AD}/icon-8-tee.jpg"></div>
  <div class="cart-row"><button type="button">Add to Bag</button></div>
</body></html>`, ({ btn, params }) => {
  const bag = btn && btn.parentNode && btn.parentNode.querySelector("button:not(.pear-widget-btn)");
  check("§7.1 a button is injected on an 'Add to Bag' PDP", !!btn);
  check("§7.2 ...beside the store's own control, not on the <h1> fallback",
    !!bag && bag.getAttribute("data-pear-injected") === "true",
    bag && bag.outerHTML);
  check("§7.3 and it opens the Icon photo", /icon-8-tee/.test(params.get("garment_url") || ""),
    params.get("garment_url"));
});

await runWidget("'Add to basket' - UK retail wording", `
<html><head><title>Fast Graphic Tee</title></head><body>
  <h1>Fast Graphic Tee</h1>
  <div class="product-image"><img src="${AD}/fast-graphic-tee.jpg"></div>
  <div class="cart-row"><button type="button">Add to basket</button></div>
</body></html>`, ({ btn }) => {
  const bag = btn && btn.parentNode && btn.parentNode.querySelector("button:not(.pear-widget-btn)");
  check("§7.4 'Add to basket' is recognised too",
    !!bag && bag.getAttribute("data-pear-injected") === "true", bag && bag.outerHTML);
});

/* ── §8 og:image keeps its own tier: corroborated is declared, bare is not ─────── */
await runWidget("a 'Logo Tee' og:image the JSON-LD lists IS the garment", `
<html><head><title>Adicolor Logo Tee</title>
  <meta property="og:image" content="${AD}/adicolor-logo-tee.jpg">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Adicolor Logo Tee",
   "image":["${AD}/adicolor-logo-tee.jpg"]}</script>
</head><body>
  <h1>Adicolor Logo Tee</h1>
  <div class="product-image"><img src="${AD}/adicolor-logo-tee.jpg"></div>
  <div class="cart-row"><button type="button">Add to Bag</button></div>
</body></html>`, ({ params }) => {
  check("§8.1 a corroborated og:image is promoted past the keyword list",
    /adicolor-logo-tee/.test(params.get("garment_url") || ""), params.get("garment_url"));
});

await runWidget("a site-wide logo og:image the JSON-LD does NOT list is still refused", `
<html><head><title>Fast Graphic Tee</title>
  <meta property="og:image" content="https://s.com/brand/site-logo.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Fast Graphic Tee",
   "image":["${AD}/fast-graphic-tee.jpg"]}</script>
</head><body>
  <h1>Fast Graphic Tee</h1>
  <div class="product-image"><img src="${AD}/fast-graphic-tee.jpg"></div>
  <div class="cart-row"><button type="button">Add to Bag</button></div>
</body></html>`, ({ params, classifyBody }) => {
  check("§8.2 the logo og:image is NOT the garment (the documented refusal still holds)",
    !/site-logo/.test(params.get("garment_url") || ""), params.get("garment_url"));
  check("§8.3 the real product photo is",
    /fast-graphic-tee/.test(params.get("garment_url") || ""), params.get("garment_url"));
  check("§8.4 ...and the logo never reaches the classifier",
    !!classifyBody && !JSON.stringify(classifyBody).includes("site-logo"),
    JSON.stringify(classifyBody && classifyBody.images));
});

/* ── §9 SFCC galleries: the main slides ARE the gallery ────────────────────────── */
await runWidget("SFCC main_image slides are collected as the gallery", `
<html><head><title>Fast Graphic Tee</title></head><body>
  <h1>Fast Graphic Tee</h1>
  <div class="main_image"><img itemprop="image" src="${AD}/fast-graphic-tee.jpg"></div>
  <div class="main_image"><img itemprop="image" src="${PX}" data-src="${AD}/fast-graphic-tee-back.jpg" alt="back view"></div>
  <div class="cart-row"><button type="button">Add to Bag</button></div>
</body></html>`, ({ classifyBody }) => {
  check("§9.1 both main slides reach the classifier, not just the primary",
    !!classifyBody && classifyBody.images.length >= 2, JSON.stringify(classifyBody && classifyBody.images));
  check("§9.2 the lazy second slide's data-src photo is the back",
    /fast-graphic-tee-back/.test((classifyBody && classifyBody.back_image_url) || ""),
    classifyBody && classifyBody.back_image_url);
});

console.log("\n" + (fails ? `${fails} FAILING` : "product-image-trust: all checks pass"));
process.exitCode = fails ? 1 : 0;
