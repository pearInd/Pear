/* Regression test for: the "Now fitting" chip showed the FRONT photo alone until the
   shopper pressed go-live, then switched to the FRONT|BACK composite.

   ROOT CAUSE: the only code that ever built a composite lived inside
   referenceImageFor(), which only runs from applyGarment(), which only runs as part
   of the LIVE session flow (goLive → connectRealtime → applyGarment). Nothing built
   one at the moment the garment was actually chosen (enterRoom/setActiveItem, or the
   widget's post-open PEAR_UPDATE_GARMENT correction) - so every paint of the chip
   before go-live was structurally front-only, regardless of whether a back existed.

   This tests ensureActiveGarmentComposite() - the REAL function extracted out of
   app.js, not a reimplementation - proving it builds and applies a composite WITHOUT
   any live-session machinery involved, i.e. exactly the gap that caused the bug. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

const code =
  extract("function releaseCompositePreview", "function setActiveItem") +
  extract("function drawImageCover", "/* In-canvas section label") +
  extract("function drawSectionLabel", "/* ── Full-Look compositor") +
  extract("const COMPOSITE_MAX_W", "/**\n * Stitch a TOP + BOTTOM garment") +
  extract("const PRESENTATION_PARAMS", "/* ── Multi-Image Product Gallery") +
  extract("/** Ordered list of variant/colour keys", "/** Ordered list of angles this item");

const dom = new JSDOM("<html><body></body></html>", { url: "https://pear.test/fitting-room/" });
const { window } = dom;

let canvasSize = null;
const ctxStub = new Proxy({}, {
  get(_, prop) {
    if (prop === "measureText") return (t) => ({ width: t.length * 10 });
    return () => {};
  },
  set() { return true; },
});
window.document.createElement = ((orig) => (tag) => {
  if (tag !== "canvas") return orig.call(window.document, tag);
  return {
    set width(v) { canvasSize = { ...(canvasSize || {}), w: v }; },
    set height(v) { canvasSize = { ...(canvasSize || {}), h: v }; },
    get width() { return canvasSize?.w; }, get height() { return canvasSize?.h; },
    getContext: () => ctxStub,
    toBlob: (cb) => cb({ size: 4096, type: "image/jpeg", _tag: "COMPOSITE_BLOB" }),
  };
})(window.document.createElement);

let objectUrlCounter = 0;
window.URL.createObjectURL = (blob) => `blob:mock-${++objectUrlCounter}:${blob && blob._tag}`;
window.URL.revokeObjectURL = () => {};

/* A deferred, controllable bitmap loader: lets a test hold createGarmentComposite's
   promise open to exercise the exact race the "never clobber a newer composite"
   guard exists for. */
function makeLoader() {
  const pending = [];
  const loadGarmentBitmap = (url) => new Promise((resolve, reject) => {
    pending.push({ url, resolve, reject });
  });
  const settleAll = (fn = () => ({ width: 1000, height: 1000, close() {} })) => {
    while (pending.length) { const p = pending.shift(); p.resolve(fn(p.url)); }
  };
  return { loadGarmentBitmap, settleAll, pending };
}

/* `with (scope) {...}` rather than named function parameters: ensureActiveGarmentComposite
   reads the module-level `activeItem` at CALL time (`if (activeItem === item)
   renderActiveGarment()`), well after this setup code runs and well after a test
   reassigns `sandbox.activeItem`. A plain function parameter is a snapshot taken once,
   when the closures are built - later mutating sandbox.activeItem would not be visible
   to a closure that already captured the parameter's ORIGINAL value. `with` resolves
   every bare identifier through the live scope object on each access, so a later
   `sandbox.activeItem = x` is exactly as visible to the extracted code as reassigning
   the real module-level `let activeItem` is in production. */
function buildSandbox(loader) {
  const renderCalls = [];
  const sandbox = {
    window, document: window.document, console, URL: window.URL,
    OffscreenCanvas: undefined, FileReader: window.FileReader, Promise, Math, Object, Map, Number, Set,
    location: window.location,
    loadGarmentBitmap: loader.loadGarmentBitmap,
    abbrevImg: (u) => (u ? String(u).slice(0, 20) : "(none)"),
    activeItem: null,
    activeColor: null,   // module-level global galleryOf()'s variantAssetsOf() reads
    renderActiveGarment: () => renderCalls.push(sandbox.activeItem),
  };
  const fn = new Function("scope",
    `with (scope) { ${code}
      scope.ensureActiveGarmentComposite = ensureActiveGarmentComposite;
      scope.distinctBackOf = distinctBackOf;
      scope.createGarmentComposite = createGarmentComposite;
    }`
  );
  fn(sandbox);
  return { sandbox, api: sandbox, renderCalls };
}

/* Flush every pending microtask (Promise .then chains), not a guessed tick count.
   createGarmentComposite has several await layers (bitmap decode, then a
   `new Promise` wrapper around canvas.toBlob, then its own memoizing IIFE, then this
   function's own .then()) - a fixed number of manual `await Promise.resolve()` calls
   is fragile against that depth. A macrotask boundary (setTimeout) is only reached
   after the ENTIRE microtask queue has drained, which is exactly "wait for every
   .then() in flight to finish" with no assumption about how many there are. */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const FRONT = "https://cdn.test/tee-front.jpg";
const BACK  = "https://cdn.test/tee-back.jpg";

console.log("── THE FIX: composite builds WITHOUT any live-session call ──");
{
  const loader = makeLoader();
  const { sandbox, api, renderCalls } = buildSandbox(loader);
  const item = { name: "Tee", img: FRONT, imgBack: BACK };
  sandbox.activeItem = item;

  // Exactly what setActiveItem()/enterRoom() now does - NOT applyGarment(), NOT
  // referenceImageFor(), NOT goLive(). If this alone produces a composite, the chip
  // no longer depends on the shopper pressing go-live.
  api.ensureActiveGarmentComposite(item);

  check("marked as building immediately (synchronous guard set)", item._compositeBuilding === true);
  loader.settleAll();
  await flushAsync();

  check("composite object URL applied to the item", typeof item._compositeObjectUrl === "string" &&
    item._compositeObjectUrl.startsWith("blob:"), item._compositeObjectUrl);
  check("building flag cleared", item._compositeBuilding === false);
  check("chip was told to repaint", renderCalls.length === 1 && renderCalls[0] === item,
    JSON.stringify(renderCalls));
}

console.log("\n── no distinct back yet: does nothing, no error, no stuck flag ──");
{
  const loader = makeLoader();
  const { api, renderCalls } = buildSandbox(loader);
  const item = { name: "Tee", img: FRONT };   // no imgBack at all
  api.ensureActiveGarmentComposite(item);
  check("no fetch attempted (nothing to compose)", loader.pending.length === 0);
  check("no repaint triggered", renderCalls.length === 0);
  check("no composite fields left dangling", !item._compositeObjectUrl && !item._compositeBuilding);
}

console.log("\n── a widget-handed composite already present: never rebuilt ──");
{
  const loader = makeLoader();
  const { api, renderCalls } = buildSandbox(loader);
  const item = { name: "Tee", img: FRONT, imgBack: BACK, composite: "data:image/jpeg;base64,ALREADY_HAVE_ONE" };
  api.ensureActiveGarmentComposite(item);
  check("no fetch attempted - the widget's composite already satisfies this item", loader.pending.length === 0);
  check("no repaint triggered (nothing changed)", renderCalls.length === 0);
}

console.log("\n── RACE GUARD: a real composite arrives from elsewhere while this one is still building ──");
{
  const loader = makeLoader();
  const { sandbox, api, renderCalls } = buildSandbox(loader);
  const item = { name: "Tee", img: FRONT, imgBack: BACK };
  sandbox.activeItem = item;
  api.ensureActiveGarmentComposite(item);

  // The widget's postMessage wins the race and lands WHILE the local build above is
  // still in flight - simulating PEAR_UPDATE_GARMENT arriving mid-build.
  item.composite = "data:image/jpeg;base64,WIDGET_WON_THE_RACE";

  loader.settleAll();
  await flushAsync();

  check("the widget's composite was NOT overwritten by the late local build",
    item.composite === "data:image/jpeg;base64,WIDGET_WON_THE_RACE", item.composite);
  check("no stray local object URL was attached on top of it", !item._compositeObjectUrl);
}

console.log("\n── SWAP GUARD: the shopper switches garments while a build is in flight ──");
{
  const loader = makeLoader();
  const { sandbox, api, renderCalls } = buildSandbox(loader);
  const oldItem = { name: "Old Tee", img: FRONT, imgBack: BACK };
  const newItem = { name: "New Hoodie", img: "https://cdn.test/hoodie.jpg" };
  sandbox.activeItem = oldItem;
  api.ensureActiveGarmentComposite(oldItem);

  sandbox.activeItem = newItem;   // shopper picked something else before the build finished

  loader.settleAll();
  await flushAsync();

  check("the stale item's composite still resolves (not wasted/discarded)",
    typeof oldItem._compositeObjectUrl === "string", oldItem._compositeObjectUrl);
  check("but the chip was NOT repainted for the item no longer on screen",
    renderCalls.length === 0, JSON.stringify(renderCalls));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
