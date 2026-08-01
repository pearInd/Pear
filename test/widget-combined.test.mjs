/* The COMBINED pipeline as it runs on a store page: scan → classify → (synthesize) →
   stitch → hand ONE composite to the try-on engine.

   Runs the real pear-widget.js in jsdom with a recording canvas, a stubbed PEAR API and
   a stubbed /api/img-proxy, and asserts the contract that matters: the try-on engine is
   handed the composite and never a bare front image. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/**
 * @param {object} o
 * @param {string} o.html                page markup
 * @param {string} o.serverBack          back_image_url the API returns ("" = none)
 * @param {string} o.backSource          back_source the API reports
 * @param {boolean} [o.proxyFails]       make /api/img-proxy fail, to exercise fallback
 * @param {string[]} [o.shopifyImages]   product .js gallery, or undefined for a 404
 */
async function runPipeline(o) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(o.html, {
    runScripts: "dangerously", url: "https://shop.example.com/products/tee", virtualConsole: vc,
  });
  const { window } = dom;

  const drawn = [];
  let canvasSize = null;
  const ctxStub = new Proxy({}, {
    get(_, p) {
      if (p === "measureText") return (t) => ({ width: t.length * 10 });
      return (...args) => { drawn.push({ op: String(p), args }); };
    },
    set() { return true; },
  });
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => {
    if (tag !== "canvas") return origCreate(tag);
    return {
      set width(v) { canvasSize = { ...(canvasSize || {}), w: v }; },
      set height(v) { canvasSize = { ...(canvasSize || {}), h: v }; },
      get width() { return canvasSize?.w; },
      get height() { return canvasSize?.h; },
      getContext: () => ctxStub,
      toDataURL: () => "data:image/jpeg;base64,/9j/COMPOSITE",
    };
  };
  // Bitmap decode: the composite builder feeds blobs through createImageBitmap.
  window.createImageBitmap = async (blob) =>
    (blob && blob._kind === "back")
      ? { width: 500, height: 1000, close() {} }
      : { width: 1000, height: 1000, close() {} };

  const requests = [];
  let classifyBody = null;
  window.fetch = (url, opts) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("/api/classify-images")) {
      classifyBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        results: classifyBody.images.map((i) => (/back/i.test(i) ? "back" : "front")),
        front_image_url: classifyBody.front_image_url,
        back_image_url: o.serverBack,
        back_source: o.backSource,
      }) });
    }
    if (u.includes("/api/img-proxy")) {
      if (o.proxyFails) return Promise.reject(new Error("proxy 502"));
      return Promise.resolve({ ok: true, blob: () => Promise.resolve({ _kind: /back|COMPOSITE|synth/i.test(u) ? "back" : "front" }) });
    }
    if (u.endsWith(".js")) {
      return o.shopifyImages
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "Tee", images: o.shopifyImages }) })
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    // Direct CDN route - loadBitmapCORS falls back to this when the proxy fails.
    if (o.cdnFails) return Promise.reject(new Error("CDN CORS blocked"));
    return Promise.resolve({
      ok: true,
      blob: () => Promise.resolve({ _kind: /back/i.test(u) ? "back" : "front" }),
      json: () => Promise.resolve({}),
    });
  };

  const posted = [];
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 20));

  /* Recorder installed on the PROTOTYPE, before the click. Every stub here resolves in
     a microtask, so the whole classify → stitch → postMessage chain completes almost
     immediately after the click - patching the iframe instance afterwards missed it
     entirely and made it look like nothing was ever sent. */
  Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", {
    get() { return { postMessage: (m) => posted.push(m) }; },
    configurable: true,
  });

  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const result = { btn, posted, drawn, canvasSize, classifyBody, requests, window };
  return result;
}

const PDP = (extra = "") => `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg?v=9&width=800"></li>
    <li><img src="${PX}" data-src="${SHOP}-2_back.jpg?v=9&width=800" alt="back"></li>
  </ul>
  ${extra}
  <form action="/cart/add"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

console.log("=== A. front + back present -> single composite handed over ===");
{
  const r = await runPipeline({
    html: PDP(), serverBack: `${SHOP}-2_back.jpg`, backSource: "classifier",
  });
  const msg = r.posted[r.posted.length - 1];
  check("A1 composite was built", !!r.canvasSize, JSON.stringify(r.canvasSize));
  check("A2 FRONT panel drawn left, BACK panel right", (() => {
    const imgs = r.drawn.filter((c) => c.op === "drawImage");
    return imgs.length === 2 && imgs[0].args[1] < imgs[1].args[1];
  })(), JSON.stringify(r.drawn.filter((c) => c.op === "drawImage").map((c) => c.args.slice(1, 3))));
  const texts = r.drawn.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  check("A3 FRONT and BACK labels drawn", texts.includes("FRONT") && texts.includes("BACK"), JSON.stringify(texts));
  check("A4 composite handed to the try-on engine",
    msg && typeof msg.garment_composite === "string" && msg.garment_composite.startsWith("data:image/jpeg"),
    msg && String(msg.garment_composite).slice(0, 40));
  check("A5 images fetched through the CORS proxy (untainted canvas)",
    r.requests.some((u) => u.includes("/api/img-proxy")), JSON.stringify(r.requests.slice(0, 4)));
  /* The panel geometry travels WITH the composite. The fitting room turns this image into
     a Decart prompt asserting "LEFT PANEL = FRONT, RIGHT PANEL = BACK"; that claim is about
     pixels drawn here, by a copy of the stitcher living in a different bundle. Shipping the
     geometry lets the consumer check the contract instead of assuming it, so a panel-order
     drift surfaces in the console rather than as a back view that renders the front. */
  const L = msg && msg.garment_composite_layout;
  check("A6 panel layout reported alongside the composite", !!L, JSON.stringify(L));
  check("A7 layout agrees with the prompt's LEFT=FRONT / RIGHT=BACK contract",
    !!L && L.front_x < L.back_x && L.front_w > 0 && L.back_w > 0, JSON.stringify(L));
  check("A8 divider sits between the two panels",
    !!L && L.divider_x > L.front_x + L.front_w - 1 && L.divider_x <= L.back_x, JSON.stringify(L));
}

console.log("\n=== B. single-view product -> server synthesizes, then composite ===");
{
  const r = await runPipeline({
    html: `<html><head><meta property="og:image" content="${SHOP}-1.jpg"></head><body>
      <h1>Tee</h1><div class="product__media-list"><img src="${SHOP}-1.jpg"></div>
      <button class="add-to-cart">Add to cart</button></body></html>`,
    serverBack: "data:image/png;base64,SYNTHBACK", backSource: "synthetic",
  });
  check("B1 asked the server to synthesize a rear",
    r.classifyBody && r.classifyBody.synthesize_back === true);
  const msg = r.posted[r.posted.length - 1];
  check("B2 composite still produced from the generated rear",
    msg && typeof msg.garment_composite === "string" && msg.garment_composite.startsWith("data:image"),
    msg && String(msg.garment_composite).slice(0, 40));
  check("B3 back_source reported as synthetic", msg && msg.garment_back_source === "synthetic",
    msg && msg.garment_back_source);
}

console.log("\n=== C. no back at all -> front-only handover, never a fake composite ===");
{
  const r = await runPipeline({
    html: `<html><head><meta property="og:image" content="${SHOP}-1.jpg"></head><body>
      <h1>Tee</h1><div class="product__media-list"><img src="${SHOP}-1.jpg"></div>
      <button class="add-to-cart">Add to cart</button></body></html>`,
    serverBack: "", backSource: "none",
  });
  const msg = r.posted[r.posted.length - 1];
  check("C1 no composite fabricated from a single view",
    !msg || !msg.garment_composite, msg && String(msg.garment_composite).slice(0, 40));
  check("C2 no back claimed", !msg || !msg.garment_back, msg && msg.garment_back);
}

console.log("\n=== D. proxy down -> direct-CDN fallback still produces the composite ===");
{
  const r = await runPipeline({
    html: PDP(), serverBack: `${SHOP}-2_back.jpg`, backSource: "classifier", proxyFails: true,
  });
  const msg = r.posted[r.posted.length - 1];
  check("D1 composite still built via the direct CDN route",
    msg && typeof msg.garment_composite === "string" && msg.garment_composite.startsWith("data:image"),
    msg && String(msg.garment_composite).slice(0, 40));
  check("D2 front/back URLs still handed over alongside it",
    msg && msg.garment_url && msg.garment_back, msg && `${msg.garment_url} | ${msg.garment_back}`);
}

console.log("\n=== D2. BOTH routes down -> no composite, graceful front/back handover ===");
{
  const r = await runPipeline({
    html: PDP(), serverBack: `${SHOP}-2_back.jpg`, backSource: "classifier",
    proxyFails: true, cdnFails: true,
  });
  const msg = r.posted[r.posted.length - 1];
  check("D3 no composite when the images cannot be fetched at all",
    !msg || !msg.garment_composite, msg && String(msg.garment_composite).slice(0, 40));
  check("D4 falls back to handing over the two URLs, never a broken reference",
    msg && msg.garment_url && msg.garment_back, msg && `${msg.garment_url} | ${msg.garment_back}`);
}

console.log("\n=== E. Shopify product JSON merged into the gallery ===");
{
  const r = await runPipeline({
    html: PDP(), serverBack: `${SHOP}-9_back.jpg`, backSource: "classifier",
    shopifyImages: [`${SHOP}-1.jpg`, `${SHOP}-9_back.jpg`, `${SHOP}-7.jpg`],
  });
  check("E1 product .js fetched", r.requests.some((u) => u.endsWith(".js")), JSON.stringify(r.requests[0]));
  check("E2 JSON-only images reached the classifier",
    r.classifyBody && r.classifyBody.images.some((u) => u.includes("-7.jpg")),
    JSON.stringify(r.classifyBody && r.classifyBody.images));
  check("E3 duplicates across DOM and JSON collapsed (no -1.jpg twice)",
    r.classifyBody && r.classifyBody.images.filter((u) => /-1\.jpg/.test(u)).length === 1,
    JSON.stringify(r.classifyBody && r.classifyBody.images));
}

console.log("\n=== F. floating button when the page has no cart button and no h1 ===");
{
  const r = await runPipeline({
    html: `<html><head><meta property="og:image" content="${SHOP}-1.jpg"></head>
      <body><div class="product__media-list"><img src="${SHOP}-1.jpg"></div></body></html>`,
    serverBack: "", backSource: "none",
  });
  check("F1 button still injected", !!r.btn);
  check("F2 rendered as the floating variant",
    r.btn && r.btn.className.includes("pear-widget-btn-floating"), r.btn && r.btn.className);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
