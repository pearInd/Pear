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

/* runOpts.url          page URL (default a /products/ PDP)
   runOpts.productJson  body for the widget's boot fetch of <path>.js; null = HTTP 404
   runOpts.beforeClick  (window) => void, run after injection and before the click - a shopper
                     changing colour between the button appearing and pressing it */
async function run(name, html, assertions, runOpts = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error("!! JSDOM ERROR:", e.message, "\n", e.detail && e.detail.stack));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: runOpts.url || "https://shop.example.com/products/tee", virtualConsole: vc,
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
    // runOpts, not opts: this mock's own second parameter is the fetch init and is named opts.
    if (runOpts.productJson !== undefined && /\/products\/[^/]+\.js$/.test(String(url).split("?")[0])) {
      return Promise.resolve(runOpts.productJson === null
        ? { ok: false, status: 404, json: () => Promise.resolve({}) }
        : { ok: true, json: () => Promise.resolve(runOpts.productJson) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

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

  if (runOpts.beforeClick) runOpts.beforeClick(window);
  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = iframe ? new URLSearchParams(iframe.src.split("?")[1] || "") : new URLSearchParams();

  console.log(`\n=== ${name} ===`);
  assertions({ btn, classifyBody, params, window });
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

/* ── F. data-pear-back as the merchant TYPED it: relative and protocol-relative ────
   The attribute used to reach /api/classify-images raw. Themes write "//cdn…" and
   "/files/…" constantly, and a non-absolute back URL can never match the gallery's
   absolute copy of the same photo on the server (canonicalImageUrl has no base to
   resolve it against), so the store's own markup silently lost to the classifier -
   and the fitting room could not fetch it either. C2 above already pins the other
   half: an ABSENT attribute must stay absent, never resolve to the page URL.

   CARD MARKUP ON PURPOSE - no og:image, no product-gallery container. The attribute is
   only read on the button's ancestor walk-up and the findProductImages() fallback;
   findGarmentForButton()'s og:image/gallery branch takes the back from
   findGalleryBack() and never reads data-pear-back at all. F0 is the control that this
   markup reaches a path that honours the attribute. */
for (const [id, attr, want] of [
  ["F0", "https://shop.example.com/cdn/shop/files/cove-back.jpg", "https://shop.example.com/cdn/shop/files/cove-back.jpg"],
  ["F1", "/cdn/shop/files/cove-back.jpg",                         "https://shop.example.com/cdn/shop/files/cove-back.jpg"],
  ["F2", "//cdn.shopify.com/s/files/1/cove-back.jpg",             "https://cdn.shopify.com/s/files/1/cove-back.jpg"],
]) {
  const kind = attr.startsWith("//") ? "protocol-relative" : attr.startsWith("/") ? "root-relative" : "absolute (control)";
  await run(`${id}. data-pear-back ${kind}`, `
<html><head></head><body>
  <h1>COVE Tee</h1>
  <div class="card">
    <img src="${SHOP}-1.jpg?v=9&width=800" data-pear-back="${attr}">
    <button class="add-to-cart">Add to cart</button>
  </div>
</body></html>`, ({ classifyBody }) => {
    const back = classifyBody && classifyBody.back_image_url;
    check(`${id} data-pear-back reaches the server as an absolute URL`, back === want,
      `got ${JSON.stringify(back)}, want ${JSON.stringify(want)}`);
    check(`${id} ...and the marked back suppresses rear synthesis`,
      classifyBody && classifyBody.synthesize_back === false);
  });
}

/* ── G. PRODUCT PAGE: explicit markers outrank og:image and the gallery heuristics ───
   THE BUG THIS CLOSES. On a page with og:image or a known gallery container,
   findGarmentForButton() took the back from findGalleryBack() and the front from
   og:image and never read data-pear-back / data-pear-front at all - so on nearly every
   real product page the highest-trust signal in the header's own discovery order did
   nothing. A merchant marking the rear photo to get past a wrong classifier verdict
   (the COVE tee) was ignored. */
await run("G1. PDP: data-pear-back outranks a filename-matched gallery back", `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>COVE Tee</h1>
  <ul class="product__media-list">
    <li class="product__media-item"><img src="${SHOP}-1.jpg?v=9&width=800" data-pear-back="/cdn/shop/files/1823292409-print-2.jpg"></li>
    <li class="product__media-item"><img src="${SHOP}-3_back.jpg?v=9&width=800" alt="back"></li>
  </ul>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ classifyBody }) => {
  const back = classifyBody && classifyBody.back_image_url;
  check("G1 the marked back wins over findGalleryBack()'s _back.jpg match",
    back === "https://shop.example.com/cdn/shop/files/1823292409-print-2.jpg", `got ${JSON.stringify(back)}`);
  check("G1 ...and the marked back suppresses rear synthesis",
    classifyBody && classifyBody.synthesize_back === false);
});

await run("G2. PDP: data-pear-front outranks og:image", `
<html><head><meta property="og:image" content="${SHOP}-lifestyle.jpg?v=9&width=1400"></head><body>
  <h1>COVE Tee</h1>
  <ul class="product__media-list">
    <li class="product__media-item"><img src="${SHOP}-lifestyle.jpg?v=9&width=800" data-pear-front="//cdn.shopify.com/s/files/1/0842/1823292409-front.jpg"></li>
  </ul>
  <button class="add-to-cart">Add to cart</button>
</body></html>`, ({ classifyBody }) => {
  const want = "https://cdn.shopify.com/s/files/1/0842/1823292409-front.jpg";
  check("G2 the marked front is sent as front_image_url, absolutized",
    classifyBody && classifyBody.front_image_url === want, classifyBody && classifyBody.front_image_url);
  check("G2 ...and leads the image list, so it opens as the loaded garment",
    classifyBody && classifyBody.images[0] === want, JSON.stringify(classifyBody && classifyBody.images));
});

/* THE OVER-REACH GUARD. THUMB_SELECTORS is effectively page-wide on Shopify
   (.swiper-slide img, img[src*="cdn.shopify.com/s/files"]), so a lookup that took the
   first marker it found would bind a related product's rear photo as this garment's
   back - a different garment on the shopper's back. */
await run("G3. PDP: a marker on a related-product card is not this product's back", `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>COVE Tee</h1>
  <ul class="product__media-list">
    <li class="product__media-item"><img src="${SHOP}-1.jpg?v=9&width=800"></li>
  </ul>
  <button class="add-to-cart">Add to cart</button>
  <div class="related-products"><div class="swiper-slide">
    <img src="https://cdn.shopify.com/s/files/1/0842/9999999999-1.jpg"
         data-pear-back="https://cdn.shopify.com/s/files/1/0842/9999999999-2.jpg">
  </div></div>
</body></html>`, ({ classifyBody }) => {
  const back = classifyBody && classifyBody.back_image_url;
  check("G3 a related card's data-pear-back is never bound as this garment's back",
    !back || back.indexOf("9999999999") === -1, `got ${JSON.stringify(back)}`);
});

/* ── H. COLOURWAY KEY for garment_cache back recovery ────────────────────────────────
   variant_key = "<product id>:<non-size option values>". It files and recovers rear
   photos, so a WRONG key puts one garment's back on another - every case below that
   cannot verify the variant must send NO key at all. */
const COVE = {
  id: 8123456789, title: "COVE Tee", images: [],
  options: [{ name: "Color" }, { name: "Size" }],
  variants: [
    { id: 111, option1: "Black", option2: "M" },
    { id: 112, option1: "Black", option2: "L" },
    { id: 211, option1: "Navy",  option2: "M" },
  ],
};
const pdp = (formId, extra = "") => `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>COVE Tee</h1>
  <ul class="product__media-list"><li class="product__media-item"><img src="${SHOP}-1.jpg?v=9&width=800"></li></ul>
  ${extra}
  <form action="/cart/add"><input type="hidden" name="id" value="${formId}"><button class="add-to-cart">Add to cart</button></form>
</body></html>`;
const keyOf = (b) => (b && Object.prototype.hasOwnProperty.call(b, "variant_key") ? b.variant_key : undefined);

for (const [id, formId, want, why] of [
  ["H1", 111, "8123456789:black", "black M"],
  ["H2", 112, "8123456789:black", "black L - the SAME colourway as black M"],
  ["H3", 211, "8123456789:navy",  "navy M - a different colourway"],
]) {
  await run(`${id}. PDP variant ${formId} (${why})`, pdp(formId), ({ classifyBody }) => {
    check(`${id} variant_key is the size-free colourway key`, keyOf(classifyBody) === want,
      `got ${JSON.stringify(keyOf(classifyBody))}, want ${JSON.stringify(want)}`);
  }, { productJson: COVE });
}

await run("H4. colour changed AFTER the button was injected", pdp(111), ({ classifyBody }) => {
  check("H4 the key reflects the colour at CLICK time, not at injection",
    keyOf(classifyBody) === "8123456789:navy", `got ${JSON.stringify(keyOf(classifyBody))}`);
}, { productJson: COVE, beforeClick: (win) => { win.document.querySelector('form input[name="id"]').value = "211"; } });

/* A related-products quick-add form on a PDP: its OWN form, a DIFFERENT product. The page
   also carries this product's variant input outside any form - the key must not fall back
   to it, because the button belongs to the other product. */
await run("H5. quick-add form for a different product on the PDP", pdp(999,
  '<input type="hidden" name="id" value="111">'), ({ classifyBody }) => {
  check("H5 a variant that is not one of THIS page product's variants sends no key",
    keyOf(classifyBody) === undefined, `got ${JSON.stringify(keyOf(classifyBody))}`);
}, { productJson: COVE });

await run("H6. product.js unavailable", pdp(111), ({ classifyBody }) => {
  check("H6 no product data, no key - membership cannot be verified",
    keyOf(classifyBody) === undefined, `got ${JSON.stringify(keyOf(classifyBody))}`);
}, { productJson: null });

await run("H7. collection page card", `
<html><head></head><body>
  <h1>Tees</h1>
  <div class="card">
    <img src="${SHOP}-1.jpg?v=9&width=800">
    <form action="/cart/add"><input type="hidden" name="id" value="111"><button class="add-to-cart">Add to cart</button></form>
  </div>
</body></html>`, ({ classifyBody }) => {
  check("H7 a collection page never sends a key - there is no page product to verify against",
    classifyBody && keyOf(classifyBody) === undefined, `got ${JSON.stringify(keyOf(classifyBody))}`);
}, { url: "https://shop.example.com/collections/tees", productJson: COVE });

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILING` : "\nALL GREEN");
process.exit(failures ? 1 : 0);
