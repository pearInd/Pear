/* End-to-end harness for widget/pear-widget.js against realistic storefront markup.
   Runs the REAL widget file in jsdom - no reimplementation - then clicks the injected
   button and inspects (a) the payload sent to /api/classify-images and (b) the
   fitting-room iframe URL. This is the surface that was previously untested. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let failures = 0;
const results = [];
function check(label, cond, detail) {
  if (!cond) failures++;
  results.push(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : `\n        ${detail}`}`);
}

/* opts.url        - the page URL (defaults to a Shopify-shaped PDP path)
   opts.setup      - (window) => void, runs BEFORE the widget boots - e.g. to stub the
                     decoded size of an <img>, which jsdom never loads
   opts.clickIndex - which injected PEAR button to click (grid pages have several) */
async function run(name, html, assertions, opts = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error("!! JSDOM ERROR:", e.message, "\n", e.detail && e.detail.stack));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: opts.url || "https://shop.example.com/products/tee", virtualConsole: vc,
  });
  const { window } = dom;

  let classifyBody = null;
  window.fetch = (url, opts) => {
    if (String(url).includes("/api/classify-images")) {
      classifyBody = JSON.parse(opts.body);
      // Echo a plausible server response so the correction path also executes.
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

  if (opts.setup) opts.setup(window);

  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);

  /* jsdom reports readyState "loading" until it finishes parsing, so the widget
     (correctly) defers boot to DOMContentLoaded. Wait for the real event rather than
     guessing a delay - this is the same path a real browser takes. */
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 20));      // let the rAF-coalesced inject pass run

  const btns = window.document.querySelectorAll(".pear-widget-btn");
  const btn = btns[opts.clickIndex || 0] || null;
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = iframe ? new URLSearchParams(iframe.src.split("?")[1] || "") : new URLSearchParams();

  console.log(`\n=== ${name} ===`);
  assertions({ btn, btns, classifyBody, params, window });
  dom.window.close();
}

const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

/* ── A. Shopify PDP, lazy gallery: only slide 1 has a usable src ─────────────── */
await run("A. Shopify lazy gallery (the fox.co.il shape)", `
<html lang="he" dir="rtl"><head>
  <meta property="og:image" content="${SHOP}-1.jpg?v=1699&width=1400">
</head><body>
  <h1>חולצת טי</h1>
  <ul class="product__media-list">
    <li class="product__media-item"><img src="${SHOP}-1.jpg?v=1699&width=800" alt="מבט חזית"></li>
    <li class="product__media-item"><img src="${PX}" data-src="${SHOP}-2_back.jpg?v=1699&width=800" alt="מבט גב"></li>
    <li class="product__media-item"><img src="${PX}" data-srcset="${SHOP}-3.jpg?width=400 400w, ${SHOP}-3.jpg?width=1200 1200w"></li>
  </ul>
  <form action="/cart/add" method="post">
    <input name="id" value="4409912345">
    <button type="submit" name="add">הוסף לסל</button>
  </form>
</body></html>`, ({ btn, classifyBody, params }) => {
  check("A1 button injected", !!btn);
  check("A2 Hebrew label on RTL page", btn && btn.textContent === "מדוד וירטואלית", btn && btn.textContent);
  check("A3 gallery found all 3 photos (lazy slides included)",
    classifyBody && classifyBody.images.length === 3, JSON.stringify(classifyBody && classifyBody.images));
  check("A4 back identified from DOM signals",
    classifyBody && /_back/.test(classifyBody.back_image_url), classifyBody && classifyBody.back_image_url);
  check("A5 did NOT ask to synthesize (a real back exists)",
    classifyBody && classifyBody.synthesize_back === false);
  check("A6 thumbnail size params stripped from front",
    classifyBody && !/width=/.test(classifyBody.front_image_url), classifyBody && classifyBody.front_image_url);
  check("A7 srcset largest candidate used",
    classifyBody && classifyBody.images.some((u) => u.includes("-3.jpg")),
    JSON.stringify(classifyBody && classifyBody.images));
  check("A8 iframe carries front_image_url + back_image_url",
    params.get("front_image_url") && params.get("back_image_url"),
    `front=${params.get("front_image_url")} back=${params.get("back_image_url")}`);
  check("A9 variant id read off the store's cart form",
    params.get("garment_variant_id") === "4409912345", params.get("garment_variant_id"));
});

/* ── B. Gallery that renders nothing without JS - <noscript> is the only source ── */
await run("B. noscript-only gallery", `
<html><head><meta property="og:image" content="${SHOP}-1.jpg"></head><body>
  <h1>Tee</h1>
  <div class="product__media-list">
    <img src="${PX}" class="lazy">
    <noscript><img src="${SHOP}-2-rear.jpg" alt="Back view"></noscript>
    <noscript><img srcset="${SHOP}-4.jpg 1200w" alt="Detail"></noscript>
  </div>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ btn, classifyBody }) => {
  check("B1 button injected", !!btn);
  check("B2 noscript images recovered",
    classifyBody && classifyBody.images.some((u) => u.includes("-2-rear.jpg")),
    JSON.stringify(classifyBody && classifyBody.images));
  check("B3 rear filename identified as the back",
    classifyBody && /-2-rear/.test(classifyBody.back_image_url), classifyBody && classifyBody.back_image_url);
});

/* ── C. THE REGRESSION GUARD: one photo under two spellings must never pair ───── */
await run("C. same photo, two URL spellings", `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>Tee</h1>
  <div class="product__media-list">
    <img src="${SHOP}-1.jpg?v=9&width=800">
    <img src="${SHOP}-1_800x.jpg">
    <img src="${SHOP}-1.jpg?v=11">
  </div>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ classifyBody }) => {
  check("C1 all spellings collapsed to ONE image",
    classifyBody && classifyBody.images.length === 1, JSON.stringify(classifyBody && classifyBody.images));
  check("C2 no false back claimed",
    classifyBody && !classifyBody.back_image_url, classifyBody && classifyBody.back_image_url);
  check("C3 asks the server to synthesize a rear (single-view product)",
    classifyBody && classifyBody.synthesize_back === true);
});

/* ── D. WooCommerce: thumbnails are -300x300, full size in data-large_image ───── */
await run("D. WooCommerce gallery", `
<html><head></head><body>
  <h1>Cotton Tee</h1>
  <div class="woocommerce-product-gallery">
    <img src="https://shop.example.com/wp/uploads/tee-300x300.jpg"
         data-large_image="https://shop.example.com/wp/uploads/tee.jpg">
  </div>
  <div class="thumbnails">
    <img src="https://shop.example.com/wp/uploads/tee-back-300x300.jpg">
  </div>
  <button class="single_add_to_cart_button">Add to cart</button>
</body></html>`, ({ btn, classifyBody }) => {
  check("D1 button injected", !!btn);
  check("D2 full-size asset preferred over the 300x300 thumbnail",
    classifyBody && classifyBody.images.some((u) => u.endsWith("/tee.jpg")),
    JSON.stringify(classifyBody && classifyBody.images));
  check("D3 thumbnail suffix stripped from the back candidate",
    classifyBody && /tee-back\.jpg/.test(classifyBody.back_image_url || ""),
    classifyBody && classifyBody.back_image_url);
});

/* ── E. Image-resizer URLs must survive untouched (Next.js / Cloudflare) ──────── */
await run("E. image-resizer URLs", `
<html><head><meta property="og:image" content="https://shop.example.com/_next/image?url=%2Fp%2Ftee.jpg&w=1920&q=75"></head><body>
  <h1>Tee</h1>
  <div class="product__media-list">
    <img src="https://shop.example.com/_next/image?url=%2Fp%2Ftee-back.jpg&w=1920&q=75" alt="back">
  </div>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ classifyBody }) => {
  const front = classifyBody && classifyBody.front_image_url;
  check("E1 resizer front URL kept intact (w/q not stripped)",
    front && front.includes("w=1920") && front.includes("url="), front);
  const back = classifyBody && classifyBody.back_image_url;
  check("E2 resizer back URL kept intact", back && back.includes("w=1920"), back);
});

/* ══ Storefronts the selectors did not know ══════════════════════════════════════
   THE BUG THESE CLOSE: on adidas.co.il (Salesforce Commerce Cloud) no product selector
   matched, and findGarmentForButton()'s walk-up returned the tightest ancestor of the
   cart button holding ANY <img> - the wishlist heart. The heart shipped as the garment
   to /api/classify-images (unclassifiable, so garment_cache never got a row) and to the
   fitting room (which opened on it), and try-on was blocked. */
const AD = "https://www.adidas.co.il";
const AD_STATIC = `${AD}/on/demandware.static/Sites-adidas-IL-Site/-/default/dw2225a8fd/images`;
const AD_DIS = `${AD}/dw/image/v2/BFNL_PRD/on/demandware.static/-/Sites-adidas-products/default`;
const adImg = (n, sw) => `${AD_DIS}/dw1a2b3c${n}0/zoom/HA6542_0${n}_laydown.jpg?sw=${sw}&sh=${sw}&sm=fit`;

/* Gallery markup is VERBATIM from the templates in adidas.co.il's own shipped main.js
   (its PDPs are Akamai-blocked to non-browsers, so the page itself could not be
   captured); the header/nav/footer chrome is from the live site. The wishlist heart is
   rendered here as an <img> SVG - the shape that reproduces the report. */
const adidasPdp = (extraBody = "") => `
<html lang="en" dir="ltr"><head><title>Fast Graphic Tee | adidas IL</title></head><body>
<header class="header">
  <img alt="Delivery" class="mr-1" src="${AD}/on/demandware.static/-/Sites/default/dw3095a1e5/uspbar/usp-delivery.svg">
  <nav class="navbar" role="navigation">
    <img class="hidden-md-down" src="${AD_STATIC}/adidas_logo.svg" alt="adidas">
    <div class="megamenu"><img src="/on/demandware.static/-/Sites-adidas-navigation-il/default/dwdfb58f3f/Training.png" alt=""></div>
  </nav>
</header>
<div class="container product-detail product-wrapper" data-pid="HA6542"><div class="row">
  <div class="col-12 col-sm-6 rtl-pdp-left-section"><div class="primary-images">
    <div class="main-image desktop">
      <div data-toggle="modal" data-target=".pdpzoommodal" class="main_image"><img src="${adImg(1, 600)}" data-index="0" data-src="${adImg(1, 2000)}" class="img-fluid" alt="Fast Graphic Tee" title="Fast Graphic Tee" itemprop="image" /></div>
      <div data-toggle="modal" data-target=".pdpzoommodal" class="main_image"><img src="${adImg(2, 600)}" data-index="1" data-src="${adImg(2, 2000)}" class="img-fluid" alt="Fast Graphic Tee" title="Fast Graphic Tee" itemprop="image" /></div>
    </div>
    <div class="slider_nav">
      <div class="thumb_image"><img src="${adImg(1, 100)}" class="img-fluid" alt="Fast Graphic Tee" itemprop="image"></div>
      <div class="thumb_image"><img src="${adImg(2, 100)}" class="img-fluid" alt="Fast Graphic Tee" itemprop="image"></div>
    </div>
  </div></div>
  <div class="col-12 col-sm-6">
    <h1 class="product-name">Fast Graphic Tee</h1>
    <div class="colorthumbnail-section"><div class="alternativeimage-list">
      <img src="${AD_DIS}/dw9e8d7c6b/zoom/HA6543_01_laydown.jpg?sw=100" alt="Fast Graphic Tee - Blue">
    </div></div>
    <div class="prices-add-to-cart-actions">
      <button class="add-to-cart btn btn-primary">Add to Bag</button>
      <a class="wishlistTile"><img class="js-heart heart-empty" src="${AD_STATIC}/heart-empty.svg" alt=""><img class="js-heart heart-full d-none" src="${AD_STATIC}/heart-full.svg" alt=""></a>
    </div>
  </div>
</div></div>
${extraBody}
<footer><img alt="" src="${AD}/on/demandware.static/-/Library-Sites-AdidasSharedLibrary/default/dw4e74e8f1/images/adidas/social-media-icons/instagram.svg"></footer>
</body></html>`;

/* ── F. adidas.co.il PDP - THE REPORTED BUG ─────────────────────────────────────── */
await run("F. adidas.co.il (SFCC/SFRA) - wishlist heart beside Add to Bag", adidasPdp(),
  ({ btn, classifyBody, params }) => {
    const imgs = (classifyBody && classifyBody.images) || [];
    const garment = params.get("garment_url") || "";
    check("F1 button injected beside Add to Bag", !!btn);
    check("F2 the garment is the product photo, not the wishlist heart",
      /HA6542_01_laydown\.jpg/.test(garment) && !/heart/.test(garment), garment);
    check("F3 no SVG reaches the classifier or the fitting room",
      !imgs.some((u) => /\.svg/i.test(u)) && !/\.svg/i.test(garment), JSON.stringify(imgs));
    check("F4 the back photo is a classifier candidate (the gallery was found)",
      imgs.some((u) => /HA6542_02_laydown/.test(u)), JSON.stringify(imgs));
    check("F5 thumbnail / slide / zoom spellings of a photo collapse to one entry",
      imgs.length === 2, JSON.stringify(imgs));
    check("F6 Dynamic Imaging sizing stripped - the original asset ships, not a 100px thumb",
      !/[?&](?:sw|sh|sm)=/.test((classifyBody && classifyBody.front_image_url) || ""),
      classifyBody && classifyBody.front_image_url);
    check("F7 site chrome never enters the gallery (nav wallpaper, logo, USP, social)",
      !imgs.some((u) => /Training\.png|adidas_logo|usp-delivery|instagram/.test(u)), JSON.stringify(imgs));
    check("F8 another colourway's swatch photo is not this garment's",
      !imgs.some((u) => /HA6543/.test(u)), JSON.stringify(imgs));
  }, { url: `${AD}/en/HA6542.html` });

/* ── G. same PDP + recommendation / recently-viewed carousels ─────────────────────
   The generic .slick-slide selector sweeps other products' tiles in, and SFCC file
   names carry no numeric id for extractProductId() to reject them with. A tile photo
   named "_back" was claimed as THIS garment's back view. */
await run("G. adidas.co.il - recommended products never become this garment's photos", adidasPdp(`
<div class="recommendations"><div class="slick-track">
  <div class="slick-slide"><div class="product-tile"><div class="image-container"><a href="/en/IX1234.html"><img class="tile-image" src="${AD_DIS}/dw5a6b7c8d/zoom/IX1234_01_laydown.jpg?sw=300" alt="Tiro Pants" itemprop="image"></a></div></div></div>
  <div class="slick-slide"><div class="product-tile"><div class="image-container"><a href="/en/IX5678.html"><img class="tile-image" src="${AD_DIS}/dw1f2e3d4c/zoom/IX5678_back.jpg?sw=300" alt="Club Tee back" itemprop="image"></a></div></div></div>
</div></div>
<div class="carousel-recently-viewed"><div class="slick-slide"><img src="${AD_DIS}/dw0a0b0c0d/zoom/GZ0001_01_laydown.jpg?sw=300" alt="Recently viewed"></div></div>`),
  ({ classifyBody, params }) => {
    const imgs = (classifyBody && classifyBody.images) || [];
    check("G1 garment still the product photo",
      /HA6542_01_laydown/.test(params.get("garment_url") || ""), params.get("garment_url"));
    check("G2 no recommended / recently-viewed product in the gallery",
      !imgs.some((u) => /IX1234|IX5678|GZ0001/.test(u)), JSON.stringify(imgs));
    check("G3 a recommended product's \"_back\" photo is not claimed as this garment's back",
      !/IX5678/.test((classifyBody && classifyBody.back_image_url) || ""), classifyBody && classifyBody.back_image_url);
  }, { url: `${AD}/en/HA6542.html` });

/* ── H. unknown platform: schema.org JSON-LD is the only product signal ──────────── */
await run("H. unknown platform - JSON-LD Product, PNG heart beside the cart button", `
<html><head>
  <script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Trail Hoodie","sku":"TH-1","image":"//img.cdn-x.com/catalog/trail-hoodie_front.jpg"}</script>
  <script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Trail Hoodie","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.5"}}</script>
</head><body>
  <h1>Trail Hoodie</h1>
  <div class="buy-box">
    <button class="add-to-cart">Add to cart</button>
    <a class="wishlist-toggle"><img src="/assets/ui/heart.png" alt="Save"></a>
  </div>
  <div class="media"><img src="//img.cdn-x.com/catalog/trail-hoodie_front.jpg"></div>
</body></html>`, ({ classifyBody, params }) => {
  const imgs = (classifyBody && classifyBody.images) || [];
  check("H1 garment resolved from JSON-LD (a review app's repeated Product block is still ONE product)",
    params.get("garment_url") === "https://img.cdn-x.com/catalog/trail-hoodie_front.jpg", params.get("garment_url"));
  check("H2 the heart is nowhere in the payload", !imgs.some((u) => /heart/.test(u)), JSON.stringify(imgs));
});

/* ── H2. no structured data at all: the walk-up itself must skip UI images ───────── */
await run("H2. no selectors, no structured data - PNG heart is the nearest <img>", `
<html><head></head><body>
  <h1>Trail Hoodie</h1>
  <div class="pdp">
    <div class="media"><img src="https://img.cdn-x.com/catalog/trail-hoodie_front.jpg"></div>
    <div class="buy-box">
      <button class="add-to-cart">Add to cart</button>
      <a class="wishlist-toggle"><img src="/assets/ui/heart.png" alt="Save"></a>
    </div>
  </div>
</body></html>`, ({ params }) => {
  check("H2.1 walk-up skips the wishlist control and finds the product photo",
    params.get("garment_url") === "https://img.cdn-x.com/catalog/trail-hoodie_front.jpg", params.get("garment_url"));
});

/* ── I. site-wide default og:image, contradicted by the page's own JSON-LD ───────── */
await run("I. default og:image vs JSON-LD Product", `
<html><head>
  <meta property="og:image" content="https://shop.example.com/static/share/brand-default.jpg">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"Organization","name":"Shop","logo":"https://shop.example.com/static/brand-mark.png","image":"https://shop.example.com/static/share/brand-default.jpg"},
    {"@type":"Product","name":"Runner Tee","image":["https://img.cdn-x.com/p/runner-tee-front.jpg","https://img.cdn-x.com/p/runner-tee-rear.jpg"]}
  ]}</script>
</head><body>
  <h1>Runner Tee</h1>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ classifyBody, params }) => {
  const imgs = (classifyBody && classifyBody.images) || [];
  check("I1 og:image the JSON-LD product does not list is not the garment",
    params.get("garment_url") === "https://img.cdn-x.com/p/runner-tee-front.jpg", params.get("garment_url"));
  check("I2 the JSON-LD rear photo reaches the classifier", imgs.some((u) => /runner-tee-rear/.test(u)), JSON.stringify(imgs));
  check("I3 the Organization node's image (the brand share image) is never read",
    !imgs.some((u) => /brand-/.test(u)), JSON.stringify(imgs));
});

/* ── J. logo og:image on a page with no cart button (the fallback path) ─────────────
   findProductImages() shipped the raw og:image as its first entry with no exclusion
   check - a logo og:image became the garment on every page that reached it. */
await run("J. logo og:image, no cart button", `
<html><head><meta property="og:image" content="https://shop.example.com/static/store-logo.png"></head><body>
  <h1>Linen Shirt</h1>
  <div class="product-image"><img src="https://img.cdn-x.com/p/linen-shirt.jpg"></div>
</body></html>`, ({ btn, params }) => {
  check("J1 fallback button injected", !!btn);
  check("J2 the logo og:image is not the garment",
    params.get("garment_url") === "https://img.cdn-x.com/p/linen-shirt.jpg", params.get("garment_url"));
});

/* ── K. collection grid: multi-product JSON-LD must not become a page-wide answer ─── */
const gridPage = `
<html><head>
  <script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product","name":"Tee One","image":"https://img.cdn-x.com/p/tee-one.jpg"},{"@context":"https://schema.org","@type":"Product","name":"Tee Two","image":"https://img.cdn-x.com/p/tee-two.jpg"}]</script>
</head><body><div class="grid">
  <div class="product-tile"><img class="tile-image" itemprop="image" src="https://img.cdn-x.com/p/tee-one.jpg"><div class="tile-body"><a>Tee One</a><button class="add-to-cart">Add to cart</button></div></div>
  <div class="product-tile"><img class="tile-image" itemprop="image" src="https://img.cdn-x.com/p/tee-two.jpg"><div class="tile-body"><a>Tee Two</a><button class="add-to-cart">Add to cart</button></div></div>
</div></body></html>`;
await run("K1. grid - first card", gridPage, ({ btns, params }) => {
  check("K1.1 one button per card", btns.length === 2, String(btns.length));
  check("K1.2 first card opens its own photo", params.get("garment_url") === "https://img.cdn-x.com/p/tee-one.jpg", params.get("garment_url"));
}, { clickIndex: 0 });
await run("K2. grid - second card", gridPage, ({ params }) => {
  check("K2.1 second card opens ITS photo - the tile is its own root, not a foreign scope",
    params.get("garment_url") === "https://img.cdn-x.com/p/tee-two.jpg", params.get("garment_url"));
}, { clickIndex: 1 });

/* ── L. a decoded glyph next to the cart button; a lazy slide is never judged tiny ── */
await run("L. 24px badge beside the cart button, lazy product photo", `
<html><head></head><body>
  <h1>Wool Coat</h1>
  <div class="pdp">
    <div class="media"><img class="photo" src="${PX}" data-src="https://img.cdn-x.com/p/wool-coat.jpg"></div>
    <div class="buy-box"><button class="add-to-cart">Add to cart</button><img class="badge" src="https://shop.example.com/assets/secure-checkout.png" alt="Secure"></div>
  </div>
</body></html>`, ({ params }) => {
  check("L1 the visibly 24px badge is skipped; the lazy photo (decoded 1x1 placeholder) is chosen",
    params.get("garment_url") === "https://img.cdn-x.com/p/wool-coat.jpg", params.get("garment_url"));
}, {
  setup(window) {
    const stub = (el, w, h) => {
      Object.defineProperty(el, "complete", { value: true, configurable: true });
      Object.defineProperty(el, "naturalWidth", { value: w, configurable: true });
      Object.defineProperty(el, "naturalHeight", { value: h, configurable: true });
    };
    stub(window.document.querySelector(".badge"), 24, 24);
    stub(window.document.querySelector(".photo"), 1, 1);
  },
});

/* ── M. an SVG lazy-load PLACEHOLDER must not hide the real photo behind it ──────────
   Lazy loaders commonly park an SVG spacer in src (an inline data:image/svg+xml, to hold
   the aspect ratio) while the photo waits in data-src. SVG rejection is about the URL
   that SHIPS - an element is judged by the photo it would send, never by the pixel it
   is currently showing. */
await run("M. SVG placeholder src, real photo in data-src, no cart button", `
<html><head></head><body>
  <h1>Silk Dress</h1>
  <div class="product-image"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 3 4'%3E%3C/svg%3E"
       data-src="https://img.cdn-x.com/p/silk-dress.jpg"></div>
</body></html>`, ({ btn, params }) => {
  check("M1 fallback button injected", !!btn);
  check("M2 the data-src photo is the garment",
    params.get("garment_url") === "https://img.cdn-x.com/p/silk-dress.jpg", params.get("garment_url"));
});

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILING` : "\nALL GREEN");
process.exit(failures ? 1 : 0);
