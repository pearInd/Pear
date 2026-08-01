/* Background pre-stitch: the COMBINED pipeline runs at MOUNT, so the click is a cache
   read rather than a 1-7s (cache-warm) / ~27s (cold rear synthesis) round trip.

   What is actually asserted here is the thing that makes the optimisation real rather
   than merely earlier: the click must REUSE the prewarmed work. A prewarm that classifies
   one image list while the click derives a different one would look fine in a console
   trace - two successful pipelines - and be strictly slower than before, because the
   shopper still waits for a full round trip AND the store paid for an extra one. So the
   load-bearing check is "exactly one /api/classify-images call across mount + click".

   Same harness shape as widget-combined.test.mjs: the real widget file in jsdom, a
   recording canvas, a stubbed PEAR API and a stubbed /api/img-proxy. */
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
 * @param {string} o.html                      page markup
 * @param {string} [o.prewarmAttr]             value for data-pear-prewarm (omitted = default on)
 * @param {string} [o.serverBack]              back_image_url the API returns
 * @param {number} [o.classifyDelayMs]         make classification slow, to prove the click doesn't wait on it
 */
async function mount(o) {
  const dom = new JSDOM(o.html, {
    runScripts: "dangerously",
    url: "https://shop.example.com/products/tee",
    virtualConsole: new VirtualConsole(),
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
  window.createImageBitmap = async (blob) =>
    (blob && blob._kind === "back")
      ? { width: 500, height: 1000, close() {} }
      : { width: 1000, height: 1000, close() {} };

  const requests = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("/api/classify-images")) {
      const body = JSON.parse(opts.body);
      const respond = () => ({ ok: true, json: () => Promise.resolve({
        results: body.images.map((i) => (/back/i.test(i) ? "back" : "front")),
        front_image_url: body.front_image_url,
        back_image_url: o.serverBack ?? `${SHOP}-2_back.jpg`,
        back_source: "classifier",
      }) });
      return o.classifyDelayMs
        ? new Promise((r) => setTimeout(() => r(respond()), o.classifyDelayMs))
        : Promise.resolve(respond());
    }
    if (u.includes("/api/img-proxy")) {
      return Promise.resolve({ ok: true, blob: () => Promise.resolve({ _kind: /back/i.test(u) ? "back" : "front" }) });
    }
    if (u.endsWith(".js")) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      blob: () => Promise.resolve({ _kind: /back/i.test(u) ? "back" : "front" }),
      json: () => Promise.resolve({}),
    });
  };

  const posted = [];
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST");
  if (o.prewarmAttr !== undefined) s.setAttribute("data-pear-prewarm", o.prewarmAttr);
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));

  Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", {
    get() { return { postMessage: (m) => posted.push(m) }; },
    configurable: true,
  });

  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  return { window, requests, drawn, posted, settle, get canvasSize() { return canvasSize; } };
}

const classifyCalls = (reqs) => reqs.filter((u) => u.includes("/api/classify-images")).length;
/* DISTINCT proxied image URLs. prepareCombined() speculatively warms the bytes for the
   DOM-known pair while classification is still in flight, so the same URL is requested
   twice: once to warm, once for real. In a browser the second is an HTTP cache hit
   (/api/img-proxy sends max-age=3600) and never touches the network - the stub here has
   no cache, so count unique URLs rather than raw calls. */
const proxiedUrls = (reqs) => [...new Set(
  reqs.filter((u) => u.includes("/api/img-proxy"))
      .map((u) => decodeURIComponent(new URL(u, "https://x").searchParams.get("url") || ""))
)];

const PDP = `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg?v=9&width=800"></li>
    <li><img src="${PX}" data-src="${SHOP}-2_back.jpg?v=9&width=800" alt="back"></li>
  </ul>
  <form action="/cart/add"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

console.log("=== A. the composite is stitched at MOUNT, with no click ===");
{
  const r = await mount({ html: PDP });
  await r.settle();
  check("A1 classification ran without a click", classifyCalls(r.requests) === 1,
    JSON.stringify(r.requests.filter((u) => u.includes("classify"))));
  check("A2 both garment images fetched without a click", proxiedUrls(r.requests).length === 2,
    JSON.stringify(proxiedUrls(r.requests)));
  check("A3 the canvas was actually stitched before any click", !!r.canvasSize, JSON.stringify(r.canvasSize));
  const labels = r.drawn.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  check("A4 FRONT/BACK panels labelled, i.e. a real composite not a bare copy",
    labels.includes("FRONT") && labels.includes("BACK"), JSON.stringify(labels));
  check("A5 nothing handed over yet - there is no room open to hand it to",
    r.posted.length === 0, JSON.stringify(r.posted.length));
}

console.log("\n=== B. the click REUSES it - no second classify, composite posted ===");
{
  const r = await mount({ html: PDP });
  await r.settle();
  const beforeClick = r.requests.length;

  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await r.settle();

  check("B1 STILL exactly one classify call across mount + click", classifyCalls(r.requests) === 1,
    `${classifyCalls(r.requests)} calls: ${JSON.stringify(r.requests.filter((u) => u.includes("classify")))}`);
  check("B2 no image re-fetched on the click either",
    r.requests.length === beforeClick, JSON.stringify(r.requests.slice(beforeClick)));
  const msg = r.posted[r.posted.length - 1];
  check("B3 the prepared composite was handed to the try-on engine",
    msg && typeof msg.garment_composite === "string" && msg.garment_composite.startsWith("data:image/jpeg"),
    msg && String(msg.garment_composite).slice(0, 40));
}

console.log("\n=== C. a click that BEATS the prewarm still gets exactly one pipeline ===");
{
  // Classification deliberately slower than the gap before the click: the click lands
  // while the prewarmed job is still in flight and must join it, never start a rival one.
  const r = await mount({ html: PDP, classifyDelayMs: 40 });
  await r.settle(5);
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await r.settle(150);

  check("C1 the in-flight prewarm was joined, not duplicated", classifyCalls(r.requests) === 1,
    `${classifyCalls(r.requests)} calls`);
  const msg = r.posted[r.posted.length - 1];
  check("C2 composite still handed over once it resolved",
    msg && typeof msg.garment_composite === "string", msg && String(msg.garment_composite).slice(0, 40));
}

console.log("\n=== D. the modal opens SYNCHRONOUSLY - never gated on the pipeline ===");
{
  const r = await mount({ html: PDP, classifyDelayMs: 5000 });   // pipeline that will not finish
  await r.settle(5);
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));

  // No await: assert on the state the browser would paint in this very frame.
  check("D1 overlay is in the DOM immediately after the click returns",
    !!r.window.document.querySelector(".pear-widget-overlay"));
  check("D2 a loading affordance paints with it, not a bare black rectangle",
    !!r.window.document.querySelector(".pear-widget-loading"));
  check("D3 the fitting-room iframe is already sourced",
    /\/fitting-room\/\?/.test(r.window.document.querySelector(".pear-widget-frame")?.src || ""));
}

console.log("\n=== E. data-pear-prewarm=\"false\" restores click-only behaviour ===");
{
  const r = await mount({ html: PDP, prewarmAttr: "false" });
  await r.settle();
  check("E1 nothing classified on mount", classifyCalls(r.requests) === 0,
    JSON.stringify(r.requests.filter((u) => u.includes("classify"))));
  check("E2 no garment images prefetched on mount",
    r.requests.filter((u) => u.includes("/api/img-proxy")).length === 0);

  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await r.settle();
  check("E3 the click still runs the full pipeline", classifyCalls(r.requests) === 1);
  const msg = r.posted[r.posted.length - 1];
  check("E4 and still hands over a composite",
    msg && typeof msg.garment_composite === "string", msg && String(msg.garment_composite).slice(0, 40));
}

console.log("\n=== F. a collection grid does NOT prewarm once per product ===");
{
  /* THE COST GUARD. Prewarming every injected button on a page with many Add-to-Cart
     buttons would fire a classify call and two image fetches per card on page load -
     a self-inflicted load spike on both the store's CDN and our own API, for products
     the shopper will mostly never open. */
  const grid = `
  <html><head><meta property="og:image" content="${SHOP}-1.jpg"></head><body>
    <h1>Tees</h1>
    <ul class="product__media-list"><li><img src="${SHOP}-1.jpg"></li></ul>
    ${[1, 2, 3, 4, 5].map((i) => `<form action="/cart/add"><button type="submit" name="add">Add ${i}</button></form>`).join("")}
  </body></html>`;
  const r = await mount({ html: grid, serverBack: "" });
  await r.settle();
  check("F1 five buttons injected", r.window.document.querySelectorAll(".pear-widget-btn").length === 5,
    String(r.window.document.querySelectorAll(".pear-widget-btn").length));
  check("F2 but only ONE prewarm fired", classifyCalls(r.requests) <= 1,
    `${classifyCalls(r.requests)} classify calls`);
}

console.log("\n=== G. source images are fetched at a sane size, not as 4K masters ===");
{
  /* upgradeImageUrl() deliberately strips CDN size suffixes to reach the MASTER asset,
     because a 100px thumbnail has no legible print left to warp. That is right for
     IDENTITY but wrong for TRANSFER: each composite panel is ~1024px wide, so pulling a
     4000px multi-megabyte master is the dominant term in time-to-composite. The fetch
     (and only the fetch) asks Shopify for a right-sized rendition. */
  const r = await mount({ html: PDP });
  await r.settle();
  const proxied = proxiedUrls(r.requests);
  check("G1 both fetches carry a width hint", proxied.length === 2 && proxied.every((u) => /[?&]width=\d+/.test(u)),
    JSON.stringify(proxied));
  check("G2 the hint is well above the ~1024px panel width (never a thumbnail)",
    proxied.every((u) => Number(/[?&]width=(\d+)/.exec(u)?.[1] || 0) >= 1400), JSON.stringify(proxied));
  const msg = (() => { const b = r.window.document.querySelector(".pear-widget-btn"); b.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true })); return r; })();
  await r.settle();
  const posted = msg.posted[msg.posted.length - 1];
  check("G3 the resize hint never leaks into the handed-over garment URLs",
    posted && !/[?&]width=/.test(posted.garment_url) && !/[?&]width=/.test(posted.garment_back || ""),
    posted && `${posted.garment_url} | ${posted.garment_back}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
