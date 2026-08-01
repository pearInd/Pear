/* SINGLE-IMAGE FAST PATH: a product that ships exactly one photo must reach a usable,
   UNBLOCKED try-on immediately, with no classification wait, no stitch, and no "still
   finding a back view" spinner counting down its 35s give-up timeout.

   The two things asserted here pull in opposite directions and both matter:

     · SPEED - the pipeline resolves front-only without waiting on anything, and the
       room is told ?single_image=1 so it never arms the pending-back gate that
       livePendingReason() blocks go-live on.

     · CORRECTNESS - the single photo is NEVER duplicated into the composite's BACK
       panel. A composite whose panels are the same image still reaches the model with
       "this reference shows the BACK - reproduce it faithfully, do NOT render the
       front", so it reproduces the chest print on the shopper's back. That is the
       exact reported failure resolveFrontBack(), canonicalPhoto() and
       distinctBackOf()/sameImage() were all written to prevent, and a fast path is not
       a reason to reintroduce it. Front-only + the room's inferred-rear clause is the
       supported way to render a back for these products; a GENERATED rear (which is a
       real, distinct image) is the way to get a photographic one.

   Same jsdom harness shape as widget-combined.test.mjs. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/**
 * @param {object} o
 * @param {string} o.html
 * @param {string} [o.synthAttr]    value for data-pear-synthesize-back
 * @param {string} [o.serverBack]   back_image_url the classifier returns (synthesis result)
 * @param {number} [o.classifyDelayMs]
 */
async function run(o) {
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
  let classifyBody = null;
  window.fetch = (url, opts) => {
    const u = String(url);
    requests.push(u);
    if (u.includes("/api/classify-images")) {
      classifyBody = JSON.parse(opts.body);
      const respond = () => ({ ok: true, json: () => Promise.resolve({
        results: classifyBody.images.map(() => "front"),
        front_image_url: classifyBody.front_image_url,
        back_image_url: o.serverBack ?? "",
        back_source: o.serverBack ? "synthetic" : "none",
      }) });
      return o.classifyDelayMs
        ? new Promise((r) => setTimeout(() => r(respond()), o.classifyDelayMs))
        : Promise.resolve(respond());
    }
    if (u.includes("/api/img-proxy")) {
      return Promise.resolve({ ok: true, blob: () => Promise.resolve({ _kind: /synth|back/i.test(u) ? "back" : "front" }) });
    }
    if (u.endsWith(".js")) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      blob: () => Promise.resolve({ _kind: "front" }),
      json: () => Promise.resolve({}),
    });
  };

  const posted = [];
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST");
  if (o.synthAttr !== undefined) s.setAttribute("data-pear-synthesize-back", o.synthAttr);
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
  return { window, requests, drawn, posted, settle, get classifyBody() { return classifyBody; }, get canvasSize() { return canvasSize; } };
}

const classifyCalls = (r) => r.requests.filter((u) => u.includes("/api/classify-images")).length;
const frameSrc = (r) => r.window.document.querySelector(".pear-widget-frame")?.src || "";

/* Exactly one photo, reached through THREE URL spellings - the og:image with a width
   param, a resized gallery src, and a cache-busted one. Counting raw strings would call
   this a three-image product; canonical identity correctly calls it one. */
const SINGLE = `
<html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
  <h1>Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1_800x.jpg"></li>
    <li><img src="${SHOP}-1.jpg?v=77"></li>
  </ul>
  <form action="/cart/add"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

console.log("=== A. one photo under three URLs is detected as a SINGLE-image product ===");
{
  const r = await run({ html: SINGLE, synthAttr: "false" });   // isolate the fast path
  await r.settle();
  check("A1 no classification round trip at all", classifyCalls(r) === 0,
    JSON.stringify(r.requests.filter((u) => u.includes("classify"))));
  check("A2 nothing stitched - there is no pair to stitch", !r.canvasSize, JSON.stringify(r.canvasSize));
  check("A3 no garment images fetched for a composite that will not exist",
    r.requests.filter((u) => u.includes("/api/img-proxy")).length === 0,
    JSON.stringify(r.requests));
}

console.log("\n=== B. the room is told, so it never arms the pending-back gate ===");
{
  const r = await run({ html: SINGLE, synthAttr: "false" });
  await r.settle();
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  check("B1 modal opened with the single_image marker", /[?&]single_image=1/.test(frameSrc(r)), frameSrc(r));
  check("B2 and claims no back image", !/garment_url_back=|back_image_url=/.test(frameSrc(r)), frameSrc(r));
  await r.settle();
  check("B3 no correction posted - the room already opened in its final state",
    r.posted.length === 0, JSON.stringify(r.posted));
}

console.log("\n=== C. THE INVARIANT: the single photo is never duplicated into a BACK panel ===");
{
  const r = await run({ html: SINGLE, synthAttr: "false" });
  await r.settle();
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await r.settle();
  const labels = r.drawn.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  check("C1 no BACK panel was ever drawn from the front photo", !labels.includes("BACK"),
    JSON.stringify(labels));
  const msg = r.posted[r.posted.length - 1];
  check("C2 no composite fabricated from one image",
    !msg || (!msg.garment_composite && !msg.garment_composite_blob),
    msg && String(msg.garment_composite).slice(0, 40));
  check("C3 no back URL claimed", !msg || !msg.garment_back, msg && msg.garment_back);
}

console.log("\n=== D. a GENERATED rear still upgrades the session - off the critical path ===");
{
  /* Generation is the one legitimate way a single-image product gets a real back: the
     server returns a genuinely different image, so the composite has two distinct
     panels and none of the duplication hazard above applies. It must never be waited on. */
  const r = await run({ html: SINGLE, serverBack: "data:image/png;base64,SYNTHBACK", classifyDelayMs: 30 });
  await r.settle(10);
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));

  // Synchronously after the click, before the slow generation could possibly resolve:
  check("D1 the room opens immediately, marked single-image", /[?&]single_image=1/.test(frameSrc(r)));

  await r.settle(200);
  check("D2 synthesis WAS requested in the background", r.classifyBody?.synthesize_back === true,
    JSON.stringify(r.classifyBody));
  const msg = r.posted[r.posted.length - 1];
  check("D3 the generated rear arrived as a correction", msg && !!msg.garment_back,
    msg && String(msg.garment_back).slice(0, 40));
  check("D4 and produced a real two-panel composite",
    msg && (!!msg.garment_composite || !!msg.garment_composite_blob),
    msg && String(msg.garment_composite).slice(0, 40));
  const labels = r.drawn.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  check("D5 that composite has BOTH panels - front photo + the DISTINCT generated rear",
    labels.includes("FRONT") && labels.includes("BACK"), JSON.stringify(labels));
}

console.log("\n=== E. data-pear-synthesize-back=\"false\" skips generation entirely ===");
{
  const r = await run({ html: SINGLE, synthAttr: "false", serverBack: "data:image/png;base64,SYNTHBACK" });
  await r.settle();
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await r.settle();
  check("E1 no generation call was made", classifyCalls(r) === 0,
    JSON.stringify(r.requests.filter((u) => u.includes("classify"))));
  check("E2 still a working front-only try-on", /\/fitting-room\/\?/.test(frameSrc(r)));
}

console.log("\n=== F. a genuine TWO-image product is untouched by any of this ===");
{
  const two = `
  <html><head><meta property="og:image" content="${SHOP}-1.jpg?v=9&width=1400"></head><body>
    <h1>Tee</h1>
    <ul class="product__media-list">
      <li><img src="${SHOP}-1.jpg?v=9&width=800"></li>
      <li><img src="${SHOP}-2_back.jpg?v=9&width=800" alt="back"></li>
    </ul>
    <form action="/cart/add"><button type="submit" name="add">Add to cart</button></form>
  </body></html>`;
  const r = await run({ html: two, serverBack: `${SHOP}-2_back.jpg` });
  await r.settle();
  check("F1 NOT flagged single-image", classifyCalls(r) === 1, `${classifyCalls(r)} classify calls`);
  const btn = r.window.document.querySelector(".pear-widget-btn");
  btn.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  check("F2 no single_image marker on the modal", !/single_image=1/.test(frameSrc(r)), frameSrc(r));
  await r.settle();
  const labels = r.drawn.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  check("F3 the normal two-panel composite is still built",
    labels.includes("FRONT") && labels.includes("BACK"), JSON.stringify(labels));
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
