/* Geometry + layout tests for createGarmentComposite() (fitting-room/app.js).
   The function is browser-only (Canvas), so it runs here in jsdom with a recording
   canvas context - we assert the LAYOUT CONTRACT (panel order, spec geometry, divider,
   labels, size cap) rather than pixels, which is what the spec actually pins down. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
/* The bounded-LRU helpers now live in their own module, so they come in as a real import
   and get injected into the sandbox below rather than being sliced out of app.js as text.
   createGarmentComposite() itself is LOCKED and still lives in app.js, so the slicing
   below stays - but its dependency no longer has to be re-parsed from source. */
import { lruTouch, lruSet, BLOB_CACHE_MAX } from "../fitting-room/lru-cache.js";

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
  // Starts at the probe-canvas helper, not at sampleBackdrop itself: the corner sampler
  // now leans on backdropProbeCtx/medianRgb/rgbLuma, which sit just above it.
  extract("let _backdropProbe", "/* object-fit: cover") +
  extract("function drawImageCover", "/* In-canvas section label") +
  extract("function drawSectionLabel", "/* ── Full-Look compositor") +
  extract("const COMPOSITE_MAX_W", "/**\n * Stitch a TOP + BOTTOM garment");

const dom = new JSDOM("<html><body></body></html>", { url: "https://pear.test/fitting-room/" });
const { window } = dom;

// Recording 2D context - captures the draw calls the layout contract is expressed in.
const calls = [];
/* Near-white studio backdrop (#f7f7f7). sampleBackdrop() reads four corners per source
   image, so this is what the median lands on - i.e. the tests below exercise the REAL
   sampling path, not its "couldn't read the pixels" fallback. */
const BACKDROP_PIXEL = [247, 247, 247, 255];

/* Corner-pixel override for the sampleBackdrop cases further down. sampleBackdrop now
   reuses ONE lazily-created 1×1 probe canvas across every call (the whole point of the
   change - it used to allocate one at the source image's full size), so a test can no
   longer feed it different pixels by swapping document.createElement per case: the cached
   canvas outlives the swap. Driving the pixels through this mutable hook instead works
   regardless of caching, and is what the corner-sampling cases set. */
let probeSeq = null;     // null → serve BACKDROP_PIXEL | array → serve in order | "throw" → simulate tainted
let probeIdx = 0;
const ctxStub = new Proxy({}, {
  get(_, prop) {
    if (prop === "measureText") return (t) => ({ width: t.length * 10 });
    if (prop === "getImageData") return () => {
      if (probeSeq === "throw") throw new Error("tainted");
      if (Array.isArray(probeSeq)) {
        const rgb = probeSeq[Math.min(probeIdx++, probeSeq.length - 1)];
        return { data: [...rgb, 255] };
      }
      return { data: BACKDROP_PIXEL };
    };
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
  // Real implementations from lru-cache.js - createGarmentComposite memoises through
  // lruSet()/lruTouch(), so without these the sliced code hits a ReferenceError the
  // moment it finishes building its first composite.
  lruTouch, lruSet, BLOB_CACHE_MAX,
  loadGarmentBitmap: async (url) => {
    // front 1000x1000 square packshot; back 500x1000 (a deliberately different aspect)
    if (url.includes("back")) return { width: 500, height: 1000, close() {} };
    return { width: 1000, height: 1000, close() {} };
  },
};
const fn = new Function(...Object.keys(sandbox),
  code + "\nreturn { createGarmentComposite, COMPOSITE_MAX_W, COMPOSITE_GUTTER, COMPOSITE_DIVIDER, COMPOSITE_LABEL_BAND, sampleBackdrop };");
const { createGarmentComposite, COMPOSITE_GUTTER, COMPOSITE_DIVIDER, COMPOSITE_LABEL_BAND, sampleBackdrop } =
  fn(...Object.values(sandbox));

check("divider is off by default (COMPOSITE_DIVIDER === 0)", COMPOSITE_DIVIDER === 0, String(COMPOSITE_DIVIDER));

const blob = await createGarmentComposite("https://cdn.test/tee-front.jpg", "https://cdn.test/tee-back.jpg");

check("returns a Blob by default", !!blob && blob.type === "image/jpeg", JSON.stringify(blob));

/* Geometry: width = frontW + backW + gutter; height = max(frontH, backH) PLUS the label
   band. Both panels are first scaled to the common height, so with a 1000x1000 front and
   a 500x1000 back the drawn widths are 1000 and 500, the panel region is 1000 tall, and
   the band adds COMPOSITE_LABEL_BAND (11%) on top. */
const PANEL_H = 1000;
const BAND    = Math.round(PANEL_H * COMPOSITE_LABEL_BAND);
check("canvas height = max(frontH, backH) + label band",
  canvasSize.h === PANEL_H + BAND, `${canvasSize.h} vs ${PANEL_H + BAND}`);
check("canvas width = frontW + backW + gutter",
  canvasSize.w === 1000 + 500 + COMPOSITE_GUTTER, `${canvasSize.w} vs ${1500 + COMPOSITE_GUTTER}`);

/* Only the PANEL draws. sampleBackdrop() shares this recording context and blits each
   source onto a scratch canvas with the 3-arg drawImage(img, 0, 0) to read its corners;
   drawImageCover() always uses the 5-arg destination-rect form. Filtering on arity keeps
   the layout assertions about layout. */
const draws = calls.filter((c) => c.op === "drawImage" && c.args.length === 5);
check("both panels drawn", draws.length === 2, `${draws.length} panel drawImage calls`);
check("FRONT panel is on the LEFT (x < half)", draws[0] && draws[0].args[1] < canvasSize.w / 2,
  draws[0] && `x=${draws[0].args[1]}`);
check("BACK panel is on the RIGHT (x > half)", draws[1] && draws[1].args[1] > canvasSize.w / 2,
  draws[1] && `x=${draws[1].args[1]}`);
/* Panels occupy only the panel region, never the label band - that separation is the
   whole point of the band, and a panel drawn to full canvas height would put garment
   pixels under the marker text again. */
check("panels are drawn to the panel height, not into the label band",
  draws.every((dr) => dr.args[4] === PANEL_H), JSON.stringify(draws.map((dr) => dr.args.slice(1))));

/* ── THE ARTIFACT FIX ───────────────────────────────────────────────────────
   The old build painted a hard #e8e8e8 line down a #3a3a3a gutter: a full-height,
   high-contrast vertical edge in the middle of a texture source, which Lucy reproduced
   as a dark seam on the shopper's clothing. There must now be exactly ONE fillRect - the
   backdrop flood - and no full-height sliver anywhere between the panels. */
const rects = calls.filter((c) => c.op === "fillRect");
const dividerish = rects.filter((r) => r.args[2] > 0 && r.args[2] <= 12 && r.args[3] >= PANEL_H * 0.9);
check("NO divider line is drawn (seamless gutter)", dividerish.length === 0,
  JSON.stringify(dividerish.map((r) => r.args)));
check("exactly one fillRect - the full-canvas backdrop flood",
  rects.length === 1 && rects[0].args[2] === canvasSize.w && rects[0].args[3] === canvasSize.h,
  JSON.stringify(rects.map((r) => r.args)));

/* The gutter is filled with the packshots' OWN sampled backdrop, so the join between the
   panels has no edge in it at all. #f7f7f7 is what BACKDROP_PIXEL medians to. */
const fills = calls.filter((c) => c.op === "set:fillStyle").map((c) => c.args[0]);
check("backdrop is sampled from the packshots, not a hard-coded grey",
  fills[0] === "rgb(247, 247, 247)", JSON.stringify(fills.slice(0, 3)));
check("the old #3a3a3a field is gone", !fills.includes("#3a3a3a"), JSON.stringify(fills));

/* Labels: still drawn (the marker technique is load-bearing), still centred over their
   own panel, but BELOW every garment pixel so no text can be composited onto the body. */
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
check("labels sit BELOW the garment panels, not over them",
  frontLabel && backLabel && frontLabel.args[2] >= PANEL_H && backLabel.args[2] >= PANEL_H,
  `FRONT y=${frontLabel && frontLabel.args[2]} BACK y=${backLabel && backLabel.args[2]} panelH=${PANEL_H}`);
check("labels drawn AFTER the panels (not painted over)",
  calls.indexOf(frontLabel) > calls.indexOf(draws[1]));

/* ── sampleBackdrop() directly ────────────────────────────────────────────────
   It decides the colour of the gutter, which is the whole seam fix, and it has to stay
   sane on the inputs real storefronts actually serve. */
console.log("\n── backdrop sampling ──");
{
  const withPixels = (seq) => {
    probeSeq = seq; probeIdx = 0;
    const out = sampleBackdrop([{ width: 100, height: 100 }, { width: 100, height: 100 }]);
    probeSeq = null;
    return out;
  };

  check("white packshots → white gutter (invisible join)",
    withPixels([[255, 255, 255]]).fill === "rgb(255, 255, 255)", JSON.stringify(withPixels([[255, 255, 255]])));
  check("...and dark ink chosen for the label band on it",
    withPixels([[255, 255, 255]]).contrast === "#101010");
  check("dark shoot → dark gutter, light ink",
    withPixels([[18, 18, 20]]).fill === "rgb(18, 18, 20)" && withPixels([[18, 18, 20]]).contrast === "#f5f5f5",
    JSON.stringify(withPixels([[18, 18, 20]])));
  /* One corner landing on a shadow, watermark or the model's elbow must not drag the
     backdrop off-white - which is exactly what a mean would do and a median will not.
     7 white corners + 1 black outlier across the 8 samples. */
  check("a single outlier corner cannot skew the result (median, not mean)",
    withPixels([[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255],
                [255, 255, 255], [255, 255, 255], [255, 255, 255], [0, 0, 0]]).fill === "rgb(255, 255, 255)");

  /* ── THE MID-GREY GUTTER ────────────────────────────────────────────────────
     A white packshot paired with a dark lifestyle shot. The doc comment has always
     promised the brighter backdrop wins here, but the implementation took a plain
     median across all 8 corners - which lands exactly BETWEEN the two, i.e. a mid-grey
     band down the middle of the reference. That is the same seam artifact the sampled
     backdrop exists to remove, and Lucy reproduces a dark band as a shadow on the
     shopper's clothing. */
  const mixed = withPixels([[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255],
                            [20, 20, 22], [20, 20, 22], [20, 20, 22], [20, 20, 22]]);
  check("white + dark sources → the BRIGHT backdrop wins, not a mid-grey average",
    mixed.fill === "rgb(255, 255, 255)", mixed.fill);
  check("...so the gutter never lands between the two panels' backdrops", (() => {
    const m = /rgb\((\d+)/.exec(mixed.fill);
    return m && Number(m[1]) > 200;
  })(), mixed.fill);
  /* The override must stay narrow: sources that merely differ in shade still average,
     because a median between two near-white sweeps IS the invisible join. */
  const nearMatch = withPixels([[250, 250, 250], [250, 250, 250], [250, 250, 250], [250, 250, 250],
                                [230, 230, 230], [230, 230, 230], [230, 230, 230], [230, 230, 230]]);
  check("sources within normal shoot variation still median together",
    nearMatch.fill === "rgb(240, 240, 240)", nearMatch.fill);

  check("unreadable pixels fall back to a light neutral, never the old dark grey", (() => {
    probeSeq = "throw";
    const out = sampleBackdrop([{ width: 10, height: 10 }]);
    probeSeq = null;
    return out.fill === "#f2f2f2";
  })());
}

/* The probe canvas is the memory fix: sampling used to allocate a canvas at the SOURCE
   image's full size (≈4MB per 1000×1000 packshot) to read four corners. It must now read
   through the 9-arg source-rect drawImage into a 1×1 buffer, and must not scale with the
   source. */
{
  calls.length = 0;
  probeSeq = null;
  sampleBackdrop([{ width: 4000, height: 4000 }]);
  const probeDraws = calls.filter((c) => c.op === "drawImage");
  check("corner sampling uses the 9-arg source-rect form", probeDraws.length === 4 &&
    probeDraws.every((d) => d.args.length === 9), JSON.stringify(probeDraws.map((d) => d.args.length)));
  check("every corner read is a 1×1 blit regardless of source size",
    probeDraws.every((d) => d.args[3] === 1 && d.args[4] === 1 && d.args[7] === 1 && d.args[8] === 1),
    JSON.stringify(probeDraws.map((d) => d.args.slice(3))));
  check("corners are read inset from the edge, not at (0,0)",
    probeDraws.every((d) => d.args[1] > 0 && d.args[2] > 0),
    JSON.stringify(probeDraws.map((d) => [d.args[1], d.args[2]])));
}

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
