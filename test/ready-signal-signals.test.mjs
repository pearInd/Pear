/* What every PEAR_UPDATE_GARMENT actually CARRIES - the ready signal included.

   THE BUG: the widget sends one of three messages once /api/classify-images settles -
   the full re-anchor correction, a bare ready signal when the classifier AGREED with the
   DOM-order guess, and a bare ready signal when the classify pipeline FAILED. Only the
   first carried the product signals. The agree path is the COMMON one on a well-marked-
   up store, so on most visits:
     · garment_age_group never reached the room - the kids/adult guard's classifier
       fallback read "uncertain" even when Gemini had said "kids";
     · a Shopify variant list that resolved after the click (and a JS-built size picker
       that hydrated late) was never delivered - the room kept the open-time reading.

   Runs the real pear-widget.js in jsdom (same harness shape as widget-combined), records
   every postMessage, and asserts the message CONTENTS - so a future edit that strips a
   field from any one of the three paths fails here, not in a shopper's session. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {object} o
 * @param {string} o.html
 * @param {"agree"|"reanchor"|"fail"} o.classify   how /api/classify-images answers
 * @param {number} [o.classifyDelay]               ms before it answers
 * @param {object} [o.shopifyJson]                 product .js body, or undefined for a 404
 * @param {number} [o.shopifyDelay]                ms before product .js answers
 */
async function run(o) {
  const dom = new JSDOM(o.html, {
    runScripts: "dangerously", url: "https://shop.example.com/products/tee",
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;

  // Recording canvas + bitmap stubs, so the re-anchor case can build its composite.
  const ctxStub = new Proxy({}, {
    get(_, p) { return p === "measureText" ? (t) => ({ width: t.length * 10 }) : () => {}; },
    set() { return true; },
  });
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => tag !== "canvas" ? origCreate(tag) : {
    width: 0, height: 0, getContext: () => ctxStub,
    toDataURL: () => "data:image/jpeg;base64,/9j/COMPOSITE",
  };
  window.createImageBitmap = async () => ({ width: 1000, height: 1000, close() {} });

  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes("/api/classify-images")) {
      const body = JSON.parse(opts.body);
      return sleep(o.classifyDelay || 0).then(() => {
        if (o.classify === "fail") throw new Error("classify 503");
        return { ok: true, json: () => Promise.resolve({
          results: body.images.map((i) => (/back/i.test(i) ? "back" : "front")),
          front_image_url: body.front_image_url,
          back_image_url: o.classify === "reanchor" ? `${SHOP}-2_back.jpg` : "",
          back_source: o.classify === "reanchor" ? "classifier" : "none",
          age_group: "kids", age_group_confidence: 0.91,
          size_run_type: null,
        }) };
      });
    }
    if (u.endsWith(".js")) {
      return sleep(o.shopifyDelay || 0).then(() => o.shopifyJson
        ? { ok: true, json: () => Promise.resolve(o.shopifyJson) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, blob: () => Promise.resolve({}), json: () => Promise.resolve({}) });
  };

  const posted = [];
  Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", {
    get() { return { postMessage: (m) => posted.push(m) }; },
    configurable: true,
  });

  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await sleep(20);

  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  // The open URL is captured AT CLICK TIME - it is what the room parsed on load.
  await sleep(0);
  const iframe = window.document.querySelector("iframe");
  const openParams = iframe ? new URL(iframe.src).searchParams : new URLSearchParams();
  await sleep((o.classifyDelay || 0) + (o.shopifyDelay || 0) + 150);

  const updates = posted.filter((m) => m && m.type === "PEAR_UPDATE_GARMENT");
  return { btn, updates, msg: updates[updates.length - 1], openParams };
}

/* A single-view product (no back anywhere) - the classifier's "front" verdict matches
   the DOM-order guess and no composite can be built, which is exactly the ready-signal
   branch. The size picker is plain DOM so the DOM tier reads it. */
const PDP = ({ picker = true, back = false } = {}) => `
<html><head><meta property="og:image" content="${SHOP}-1.jpg"></head><body>
  <h1>Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg"></li>
    ${back ? `<li><img src="${SHOP}-2_back.jpg" alt="back"></li>` : ""}
  </ul>
  ${picker ? `<select name="size"><option>Choose a size</option><option>S</option><option>M</option><option>L</option></select>` : ""}
  <form action="/cart/add"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

console.log("=== 1. classifier AGREED -> ready signal carries every product signal ===");
{
  const r = await run({ html: PDP(), classify: "agree" });
  const m = r.msg;
  check("1.1 exactly one PEAR_UPDATE_GARMENT was posted", r.updates.length === 1,
    JSON.stringify(r.updates.map((u) => Object.keys(u))));
  check("1.2 it is the ready signal (garment_classify_done)", !!m && m.garment_classify_done === true);
  check("1.3 ...and still NOT a re-anchor: no garment_url, no garment_back, no composite",
    !!m && !("garment_url" in m) && !("garment_back" in m) && !("garment_composite" in m),
    m && JSON.stringify(Object.keys(m)));
  check("1.4 garment_sizes = the picker's list", !!m && same(m.garment_sizes, ["S", "M", "L"]),
    m && JSON.stringify(m.garment_sizes));
  check("1.5 garment_age_group relayed from the classifier (the dead-fallback bug)",
    !!m && m.garment_age_group === "kids", m && m.garment_age_group);
  check("1.6 garment_age_group_confidence relayed", !!m && m.garment_age_group_confidence === 0.91,
    m && m.garment_age_group_confidence);
  check("1.7 garment_size_type = this page's own run verdict", !!m && m.garment_size_type === "alpha",
    m && m.garment_size_type);
  check("1.8 garment_soldout is ALWAYS an array (an empty one clears a stale strike-through)",
    !!m && Array.isArray(m.garment_soldout), m && JSON.stringify(m.garment_soldout));
  check("1.9 garment_size_chart is ALWAYS a string (\"\" clears a wrong chart)",
    !!m && typeof m.garment_size_chart === "string", m && typeof m.garment_size_chart);
  check("1.10 garment_title re-read off the PDP", !!m && m.garment_title === "Tee", m && m.garment_title);
}

console.log("\n=== 2. sizes are RE-READ at message time, not reused from the open URL ===");
{
  /* No DOM picker, and the Shopify product JSON resolves AFTER the click but BEFORE the
     classify answer - the timing gap the ready signal used to swallow. */
  const r = await run({
    html: PDP({ picker: false }), classify: "agree", classifyDelay: 120, shopifyDelay: 60,
    shopifyJson: {
      title: "Tee", images: [], options: [{ name: "Size" }],
      variants: [
        { id: 1, option1: "8", available: true },
        { id: 2, option1: "10", available: false },
        { id: 3, option1: "12", available: true },
      ],
    },
  });
  const m = r.msg;
  check("2.1 the open URL had no size list (JSON not in yet at click time)",
    r.openParams.get("garment_sizes") === null, r.openParams.get("garment_sizes"));
  check("2.2 the ready signal delivers the late Shopify list", !!m && same(m.garment_sizes, ["8", "10", "12"]),
    m && JSON.stringify(m.garment_sizes));
  check("2.3 ...with its stock re-read from the same variants", !!m && same(m.garment_soldout, ["10"]),
    m && JSON.stringify(m.garment_soldout));
  check("2.4 ...and still no garment_url", !!m && !("garment_url" in m));
}

console.log("\n=== 3. classify FAILED -> page re-reads still sent, no invented verdict ===");
{
  const r = await run({ html: PDP(), classify: "fail" });
  const m = r.msg;
  check("3.1 the ready signal is still sent (gate release)", !!m && m.garment_classify_done === true,
    JSON.stringify(r.updates));
  check("3.2 garment_sizes re-read", !!m && same(m.garment_sizes, ["S", "M", "L"]),
    m && JSON.stringify(m.garment_sizes));
  check("3.3 garment_soldout sent as an array", !!m && Array.isArray(m.garment_soldout));
  check("3.4 garment_size_chart sent as a string", !!m && typeof m.garment_size_chart === "string");
  check("3.5 NO garment_age_group - \"uncertain\" would claim the classifier looked",
    !!m && !("garment_age_group" in m) && !("garment_age_group_confidence" in m),
    m && JSON.stringify(Object.keys(m)));
  check("3.6 no garment_url", !!m && !("garment_url" in m));
}

console.log("\n=== 4. full re-anchor message keeps every product signal (shared builder) ===");
{
  const r = await run({ html: PDP({ back: true }), classify: "reanchor" });
  const m = r.msg;
  check("4.1 a re-anchor message was sent (garment_url present)", !!m && typeof m.garment_url === "string",
    m && JSON.stringify(Object.keys(m)));
  check("4.2 ...carrying garment_sizes", !!m && same(m.garment_sizes, ["S", "M", "L"]),
    m && JSON.stringify(m.garment_sizes));
  check("4.3 ...garment_age_group + confidence",
    !!m && m.garment_age_group === "kids" && m.garment_age_group_confidence === 0.91);
  check("4.4 ...garment_size_type, garment_soldout, garment_size_chart, garment_title",
    !!m && m.garment_size_type === "alpha" && Array.isArray(m.garment_soldout) &&
    typeof m.garment_size_chart === "string" && m.garment_title === "Tee",
    m && JSON.stringify({ t: m.garment_size_type, s: m.garment_soldout, c: m.garment_size_chart, n: m.garment_title }));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
