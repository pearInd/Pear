/* Geometry + layout tests for createGarmentComposite() (fitting-room/app.js).
   The function is browser-only (Canvas), so it runs here in jsdom with a recording
   canvas context - we assert the LAYOUT CONTRACT (panel order, spec geometry, divider,
   labels, size cap) rather than pixels, which is what the spec actually pins down. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

// Normalised to LF: the repo checks out CRLF on Windows, and the slice markers below
// are written with \n - a mismatch silently makes indexOf return -1 and drags in half
// the file, which fails in a very confusing way.
const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* Pull just the composite engine + the two helpers it calls out of app.js. The file is
   a 7k-line browser module with no exports, so slicing is how we get at it without
   reimplementing (which would test nothing). */
function extract(name, endMarker) {
  const start = SRC.indexOf(name);
  if (start === -1) throw new Error(`could not find "${name}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  // A missing end marker would slice to -1 and silently swallow the rest of the file,
  // so fail loudly instead - it means app.js was refactored and this test needs updating.
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${name}"`);
  return SRC.slice(start, end);
}
const code =
  extract("function drawImageCover", "/* In-canvas section label") +
  extract("function drawSectionLabel", "/* ── Full-Look compositor") +
  extract("const COMPOSITE_MAX_W", "/**\n * Stitch a TOP + BOTTOM garment");

const dom = new JSDOM("<html><body></body></html>", { url: "https://pear.test/fitting-room/" });
const { window } = dom;

// Recording 2D context - captures the draw calls the layout contract is expressed in.
const calls = [];
const ctxStub = new Proxy({}, {
  get(_, prop) {
    if (prop === "measureText") return (t) => ({ width: t.length * 10 });
    if (prop === "canvas") return undefined;
    return (...args) => { calls.push({ op: String(prop), args }); };
  },
  set(_, prop, value) { calls.push({ op: `set:${String(prop)}`, args: [value] }); return true; },
});

let canvasSize = null;
window.document.createElement = ((orig) => (tag) => {
  if (tag !== "canvas") return orig.call(window.document, tag);
  return {
    set width(v) { canvasSize = { ...(canvasSize || {}), w: v }; },
    set height(v) { canvasSize = { ...(canvasSize || {}), h: v }; },
    get width() { return canvasSize?.w; },
    get height() { return canvasSize?.h; },
    getContext: () => ctxStub,
    toBlob: (cb) => cb({ size: 123456, type: "image/jpeg" }),
  };
})(window.document.createElement);

const sandbox = {
  window, document: window.document, console, location: window.location, URLSearchParams,
  OffscreenCanvas: undefined, FileReader: window.FileReader, Promise, Math, Object, Map, Number,
  loadGarmentBitmap: async (url) => {
    // front 1000x1000 square packshot; back 500x1000 (a deliberately different aspect)
    if (url.includes("back")) return { width: 500, height: 1000, close() {} };
    return { width: 1000, height: 1000, close() {} };
  },
};
const fn = new Function(...Object.keys(sandbox), code + "\nreturn { createGarmentComposite, COMPOSITE_MAX_W, COMPOSITE_GUTTER };");
const { createGarmentComposite, COMPOSITE_GUTTER } = fn(...Object.values(sandbox));

const blob = await createGarmentComposite("https://cdn.test/tee-front.jpg", "https://cdn.test/tee-back.jpg");

check("returns a Blob by default", !!blob && blob.type === "image/jpeg", JSON.stringify(blob));

/* Spec: height = max(frontH, backH); width = frontW + backW + divider padding.
   Both panels are first scaled to the common height, so with a 1000x1000 front and a
   500x1000 back the drawn widths are 1000 and 500. */
check("canvas height = max(frontH, backH)", canvasSize.h === 1000, JSON.stringify(canvasSize));
check("canvas width = frontW + backW + gutter",
  canvasSize.w === 1000 + 500 + COMPOSITE_GUTTER, `${canvasSize.w} vs ${1500 + COMPOSITE_GUTTER}`);

const draws = calls.filter((c) => c.op === "drawImage");
check("both panels drawn", draws.length === 2, `${draws.length} drawImage calls`);
check("FRONT panel is on the LEFT (x < half)", draws[0] && draws[0].args[1] < canvasSize.w / 2,
  draws[0] && `x=${draws[0].args[1]}`);
check("BACK panel is on the RIGHT (x > half)", draws[1] && draws[1].args[1] > canvasSize.w / 2,
  draws[1] && `x=${draws[1].args[1]}`);

const rects = calls.filter((c) => c.op === "fillRect");
const divider = rects.find((r) => r.args[2] >= 2 && r.args[2] <= 8 && r.args[3] === 1000);
check("vertical divider drawn, 2-8px wide, full height", !!divider, JSON.stringify(rects.map(r => r.args)));
check("divider sits between the two panels",
  divider && Math.abs(divider.args[0] - 1000 - COMPOSITE_GUTTER / 2) < 6, divider && `x=${divider.args[0]}`);

const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
check("FRONT label drawn", texts.includes("FRONT"), JSON.stringify(texts));
check("BACK label drawn", texts.includes("BACK"), JSON.stringify(texts));
const frontLabel = calls.filter((c) => c.op === "fillText").find((c) => c.args[0] === "FRONT");
const backLabel  = calls.filter((c) => c.op === "fillText").find((c) => c.args[0] === "BACK");
check("FRONT label centred over the left panel",
  frontLabel && Math.abs(frontLabel.args[1] - 500) < 40, frontLabel && `x=${frontLabel.args[1]}`);
check("BACK label centred over the right panel",
  backLabel && Math.abs(backLabel.args[1] - (1000 + COMPOSITE_GUTTER + 250)) < 40,
  backLabel && `x=${backLabel.args[1]}`);
check("labels drawn AFTER the panels (not painted over)",
  calls.indexOf(frontLabel) > calls.indexOf(draws[1]));

/* Oversized input must be capped, keeping the aspect. */
calls.length = 0; canvasSize = null;
sandbox.loadGarmentBitmap = async () => ({ width: 3000, height: 4000, close() {} });
const fn2 = new Function(...Object.keys(sandbox), code + "\nreturn { createGarmentComposite };");
await fn2(...Object.values(sandbox)).createGarmentComposite("https://cdn.test/a.jpg", "https://cdn.test/b.jpg");
check("output capped at COMPOSITE_MAX_W", canvasSize.w <= 2048, `w=${canvasSize.w}`);
check("aspect preserved when capping", canvasSize.h < 4000 && canvasSize.h > 0, `h=${canvasSize.h}`);

/* A failed image load must yield null, never a half-drawn reference. */
const fn3 = new Function(...Object.keys({ ...sandbox, loadGarmentBitmap: null }),
  code + "\nreturn { createGarmentComposite };");
const failing = fn3(...Object.values({ ...sandbox, loadGarmentBitmap: async () => { throw new Error("404"); } }));
check("returns null when an image fails to load",
  (await failing.createGarmentComposite("https://cdn.test/a.jpg", "https://cdn.test/b.jpg")) === null);
check("returns null when either URL is missing",
  (await failing.createGarmentComposite("https://cdn.test/a.jpg", "")) === null);

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
