/* OTHER COLOURS OF THIS GARMENT (2026-11-25) - when the recommended size is gone in this
   colour, the room offers the colours that still have it (instead of "one size up/down"),
   and trying one re-opens the room on that product through the widget's own launch.

   §1 the widget: siblings come ONLY from the store's swatch markup, stock ONLY from each
      sibling's own product JSON; the page's own colour and an unreadable sibling are left
      out; a quick-shop card gets no colours.
   §2 the widget: PEAR_TRY_COLOR opens that product (its photos, its stock, the typed
      height/weight), refuses an unknown handle or a foreign window, and the cart then
      adds THAT product's variant.
   §3 the room: which colours are offered for a size, the sanitiser, and that
      renderStockNotice() keeps the old sentence when no colour has the size.
   §4 similar models (the store's own Shopify recommendations, same product type, never a
      colour of this model) and NO EXACT SIZE: between two rows the room says "no size" and
      offers the similar items instead of the suggested size; none -> the suggested size. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
const BASE = "https://pear-web-demo-sigma.vercel.app";

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : `\n        ${detail}`}`);
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const product = (title, sizes, soldOut, img, idBase) => ({
  title, options: [{ name: "Size", values: sizes }],
  images: [img, img.replace(".jpg", "_b.jpg")],
  variants: sizes.map((s, i) => ({ id: idBase + i, option1: s, available: !soldOut.includes(s), sku: "SKU" + (idBase + i) })),
});
const PRODUCTS = {
  "/products/1000100100.js": product("חולצת טי", ["S", "M", "L", "XL"], ["M"], "https://cdn.shopify.com/s/files/black.jpg", 100),
  "/products/1000100200.js": product("חולצת טי", ["S", "M", "L", "XL"], [], "https://cdn.shopify.com/s/files/brown.jpg", 200),
  "/products/1000100300.js": product("חולצת טי", ["S", "M", "L", "XL"], ["M", "L"], "https://cdn.shopify.com/s/files/white.jpg", 300),
};

let RECS = [];
const SWATCHES = `
  <div class="custom-color-swatch"><div class="swatch-colors-wrapper">
    <button type="button" data-product-handle="1000100200" class="product-color" style="--product-current-color:#6A4D4D;"></button>
    <button type="button" data-product-handle="1000100300" class="product-color" style="--product-current-color:#FFFFFF;"></button>
    <button type="button" data-product-handle="1000100999" class="product-color" style="--product-current-color:#123456;"></button>
    <button type="button" data-product-handle="1000100100" class="product-color current-product-color" style="--product-current-color:#000000;"></button>
  </div></div>`;
const PDP = (extra) => `<!doctype html><html><head><meta name="shopify-digital-wallet" content="/x"></head><body>
  <h1>חולצת טי</h1>
  <div class="product__media"><img src="https://cdn.shopify.com/s/files/black.jpg" width="800" height="1000"></div>
  ${extra}
  <form action="/cart/add"><button type="submit" class="product-form__submit">הוספה לסל</button></form>
</body></html>`;

async function boot(html, url) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error("!! JSDOM ERROR:", e.message));
  if (process.env.CA_DEBUG) vc.sendTo(console, { omitJSDOMErrors: true });
  const dom = new JSDOM(html, { runScripts: "dangerously", url, virtualConsole: vc });
  const { window } = dom;
  const fetched = [];
  const cartBodies = [];
  window.fetch = (u, opts) => {
    const path = String(u).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    fetched.push(path);
    if (/\/cart\/add/.test(path)) { cartBodies.push(String(opts && opts.body || "")); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }
    if (/\/cart\.js$/.test(path)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], item_count: 0 }) });
    if (path === "/recommendations/products.json") return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: RECS }) });
    if (PRODUCTS[path]) return Promise.resolve({ ok: true, json: () => Promise.resolve(PRODUCTS[path]) });
    if (/\/products\/.*\.js$/.test(path)) return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("404")) });
    if (path.includes("/api/classify-images")) {
      const b = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: b.images.map(() => "front"), front_image_url: b.images[0] }) });
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
  await tick(40);
  return { window, fetched, cartBodies };
}
/* The previous room stays in the DOM until it acknowledges its teardown - the newest is the open one. */
const frame = (w) => { const all = w.document.querySelectorAll(".pear-widget-frame"); return all[all.length - 1] || null; };
const params = (f) => new URLSearchParams(f.src.split("?")[1] || "");
const post = (w, data, source) =>
  w.dispatchEvent(new w.MessageEvent("message", { data, origin: BASE, source }));

/* ── §1 + §2: the widget ───────────────────────────────────────────────────── */
{
  const { window, fetched, cartBodies } = await boot(PDP(SWATCHES), "https://fox.co.il/products/1000100100");
  window.document.querySelector(".pear-widget-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  const f1 = frame(window);
  const msg = f1 && f1.__pearColors;
  console.log("\n── §1 the colours the widget reads ──");
  check("§1.1 the room is told the other colours", !!msg && msg.type === "PEAR_COLOR_OPTIONS", JSON.stringify(msg));
  const handles = msg ? msg.options.map((o) => o.handle) : [];
  check("§1.2 only the swatches' siblings, the page's own colour left out", handles.join() === "1000100200,1000100300", handles.join());
  check("§1.3 a sibling whose product JSON fails is left out, never guessed", !handles.includes("1000100999"));
  const white = msg && msg.options.find((o) => o.handle === "1000100300");
  check("§1.5 stock is the sibling's own (white: M and L gone)", white && white.soldOut.join() === "M,L", white && white.soldOut.join());
  check("§1.6 the colour and the photo come with it", white && white.hex === "#ffffff" && /white\.jpg/.test(white.image));
  check("§1.7 no variant ids travel to the room", msg && msg.options.every((o) => !("variants" in o) && !("variantId" in o)));

  console.log("\n── §2 trying a colour ──");
  post(window, { type: "PEAR_TRY_COLOR", handle: "1000100200", hw: "178x74" }, null);
  await tick(40);
  check("§2.1 a message that is not from the open room is ignored", frame(window) === f1);
  post(window, { type: "PEAR_TRY_COLOR", handle: "9999999999", hw: "178x74" }, f1.contentWindow);
  await tick(40);
  check("§2.2 a handle the page never listed is ignored", frame(window) === f1);
  post(window, { type: "PEAR_TRY_COLOR", handle: "1000100200", hw: "178x74" }, f1.contentWindow);
  await tick(60);
  const f2 = frame(window);
  const p2 = f2 ? params(f2) : new URLSearchParams();
  check("§2.3 the room re-opens on that colour's photo", f2 && f2 !== f1 && /brown\.jpg/.test(p2.get("garment_url") || ""), p2.get("garment_url"));
  check("§2.4 ...with that colour's stock (nothing sold out -> no param)", !p2.get("garment_soldout"), p2.get("garment_soldout"));
  check("§2.5 ...with the typed height/weight", p2.get("pear_hw") === "178x74", p2.get("pear_hw"));
  check("§2.6 ...through the classify gate like any product", p2.get("classify_pending") === "1");
  check("§2.7 ...and the room on that colour is told the remaining colours (not itself)",
    f2 && f2.__pearColors && f2.__pearColors.options.map((o) => o.handle).join() === "1000100300",
    f2 && f2.__pearColors && JSON.stringify(f2.__pearColors.options.map((o) => o.handle)));
  post(window, { type: "PEAR_ADD_TO_CART", payload: { size: "M", variantId: 200 } }, f2.contentWindow);
  await tick(60);
  check("§2.8 the cart adds THAT colour's M (variant 201)", cartBodies.some((b) => /201/.test(b)), cartBodies.join(" | "));
  post(window, { type: "PEAR_TRY_COLOR", handle: "1000100300", hw: "1;alert(1)" }, f2.contentWindow);
  await tick(60);
  check("§2.9 a malformed height/weight is dropped, not forwarded", frame(window) && !params(frame(window)).get("pear_hw"));
}
{
  const { window } = await boot(PDP(""), "https://shop.example.com/products/tee");
  window.document.querySelector(".pear-widget-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  const m = frame(window) && frame(window).__pearColors;
  check("§1.8 a page without the swatch markup offers no colours", !m || m.options.length === 0, JSON.stringify(m));
}

/* ── §3: the room ──────────────────────────────────────────────────────────── */
console.log("\n── §3 the room ──");
const start = APP.indexOf("let colorOptions = [];");
const end = APP.indexOf("async function tryColorOption(");
check("§3.0 the room block is where this test expects it", start > 0 && end > start);
const pslStart = APP.indexOf("function parseSizeList(raw) {");
const psl = APP.slice(pslStart, APP.indexOf("\n}\n", pslStart) + 3);
// eslint-disable-next-line no-new-func
const room = new Function(`${psl}\n${APP.slice(start, end)}\nreturn { sanitizeColorOptions, colorAltsFor, set: (l) => { colorOptions = l; } };`)();
const opts = room.sanitizeColorOptions([
  { handle: "a1", hex: "#6a4d4d", image: "https://cdn.shopify.com/a.jpg", sizes: ["s", "M", "L"], soldOut: [] },
  { handle: "b2", hex: "#fff", image: "https://cdn.shopify.com/b.jpg", sizes: ["S", "M", "L"], soldOut: ["m"] },
  { handle: "c3", image: "http://insecure/x.jpg", sizes: ["M"], soldOut: [] },
  { handle: "../x", image: "https://cdn.shopify.com/x.jpg", sizes: ["M"], soldOut: [] },
  { handle: "d4", hex: "red;background:url(x)", image: "https://cdn.shopify.com/d.jpg", sizes: ["L"], soldOut: [] },
]);
check("§3.1 a non-https photo and a bad handle are dropped", opts.map((o) => o.handle).join() === "a1,b2,d4", opts.map((o) => o.handle).join());
check("§3.2 a colour value that is not a hex never reaches the style", opts.find((o) => o.handle === "d4").hex === "");
room.set(opts);
check("§3.3 M: only the colour that sells M (case-insensitive, like isSizeSoldOut)", room.colorAltsFor("M").map((o) => o.handle).join() === "a1");
check("§3.4 L: every colour that lists L and has it", room.colorAltsFor("L").map((o) => o.handle).join() === "a1,b2,d4");
check("§3.5 XL: nobody lists it -> no colours (the size-up/down sentence stays)", room.colorAltsFor("XL").length === 0);
check("§3.6 renderStockNotice() falls back to the old sentence when no colour has the size",
  /const alts = typeof colorAltsFor === "function" \? colorAltsFor\(size\) : \[\];\s*if \(alts\.length && typeof renderColorAlts === "function"\)/.test(APP));
{
  const ls = APP.indexOf('e.data.type !== "PEAR_COLOR_OPTIONS"');
  const listener = APP.slice(ls, APP.indexOf("\n});", ls));
  check("§3.7 the size is never recomputed when the colours land (repaint only)",
    ls > 0 && /renderStockNotice\(currentUserSize, sizeResultApprox\)/.test(listener) && !/calculateSize\(/.test(listener));
}

/* ── §4: similar models + NO EXACT SIZE ──────────────────────────────────────── */
console.log("\n── §4 similar models and no exact size ──");
{
  PRODUCTS["/products/1000100100.js"] = { ...PRODUCTS["/products/1000100100.js"], id: 777, type: "חולצות" };
  const rec = (handle, type, title) => ({ ...product(title, ["S", "M", "L"], [], `https://cdn.shopify.com/s/files/${handle}.jpg`, 900), handle, type });
  RECS = [
    rec("2000200100", "חולצות", "חולצת פולו"),
    rec("3000300100", "מכנסיים", "מכנסי ג'ינס"),
    rec("1000100200", "חולצות", "חולצת טי"),           // a colour of this model - never twice
    { ...rec("4000400100", "חולצות", "חולצה"), variants: [] },   // nothing to sell - left out
  ];
  const { window } = await boot(PDP(SWATCHES), "https://fox.co.il/products/1000100100");
  window.document.querySelector(".pear-widget-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(80);
  const msg = frame(window) && frame(window).__pearColors;
  const list = msg ? msg.options : [];
  const models = list.filter((o) => o.kind === "model").map((o) => o.handle);
  check("§4.1 a recommendation of the same product type is offered as a similar model", models.join() === "2000200100", models.join());
  check("§4.2 the colours stay colours, listed first", list.slice(0, 2).every((o) => o.kind === "color"), JSON.stringify(list.map((o) => o.kind)));
  RECS = [];
}
{
  const dom = new JSDOM(`<div id="resultBox" class="show"><span id="resultLabel">L0</span><div id="sizeResult">M</div>
    <div id="resultActions"></div><p id="stockNotice" hidden></p><div id="colorAlts" hidden></div></div>`);
  const g = dom.window;
  const rsStart = APP.indexOf("function renderStockNotice(size, approx) {");
  const rsEnd = APP.indexOf("\n}\n", rsStart) + 3;
  const DICT = { resultLabelApprox: "APPROX", resultLabelNoSize: "NOSIZE", colorAltTry: "TRY", colorAltTryAria: "TRY" };
  // eslint-disable-next-line no-new-func
  const r = new Function("document", "DICT", `
    const $ = (id) => document.getElementById(id);
    const t = (k) => DICT[k] || k;
    const tf = (k, v) => k + ":" + (v && v.size);
    const formatSizeLabel = (s) => s;
    let SOLD = [];
    const isSizeSoldOut = (s) => SOLD.includes(s);
    const stockFallbacksFor = () => ({ down: null, up: null });
    ${psl}
    ${APP.slice(start, end)}
    ${APP.slice(rsStart, rsEnd)}
    return { renderStockNotice, set: (l) => { colorOptions = l; }, sold: (l) => { SOLD = l; } };`)(g.document, DICT);
  const el = (id) => g.document.getElementById(id);
  r.set([]);
  el("resultLabel").innerText = "APPROX";
  r.renderStockNotice("M", true);
  check("§4.3 no exact size, nothing similar: the suggested size stays, label untouched",
    el("resultLabel").innerText === "APPROX" && !el("sizeResult").classList.contains("is-alt-hidden") && el("stockNotice").hidden);
  r.set([{ handle: "m1", hex: "", title: "חולצת פולו", image: "https://cdn.shopify.com/m.jpg", sizes: ["M"], soldOut: [], kind: "model" }]);
  r.renderStockNotice("M", true);
  check("§4.4 no exact size + a similar item: 'no size', the size hidden, the item offered",
    el("resultLabel").innerText === "NOSIZE" && el("sizeResult").classList.contains("is-alt-hidden")
    && /^noSizeSimilar:M$/.test(el("stockNotice").textContent) && g.document.querySelectorAll(".color-alt.is-model").length === 1,
    el("resultLabel").innerText + " | " + el("stockNotice").textContent);
  check("§4.5 a model card carries its name", g.document.querySelector(".color-alt-name")?.textContent === "חולצת פולו");
  r.renderStockNotice("M", false);
  check("§4.6 an exact size in stock: nothing offered, the size shown again",
    !el("sizeResult").classList.contains("is-alt-hidden") && el("stockNotice").hidden && el("colorAlts").hidden);
  r.set([]);
  r.renderStockNotice("M", true);
  check("§4.7 the offer gone on a repaint: back to the suggested-size label", el("resultLabel").innerText === "APPROX");
  check("§4.8 the verdict tells the notice whether the size is only the nearest",
    /noteSizeApprox\(verdict\.approx\);\s*renderStockNotice\(bestSize, !!verdict\.approx\);/.test(APP));
}

console.log(failures ? `\ncolor-alternatives: ${failures} FAILING` : "\ncolor-alternatives: all green");
process.exit(failures ? 1 : 0);
