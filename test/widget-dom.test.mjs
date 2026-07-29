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

async function run(name, html, assertions) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error("!! JSDOM ERROR:", e.message, "\n", e.detail && e.detail.stack));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://shop.example.com/products/tee", virtualConsole: vc,
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

console.log("\n" + results.join("\n"));
console.log(failures ? `\n${failures} FAILING` : "\nALL GREEN");
process.exit(failures ? 1 : 0);
