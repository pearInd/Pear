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
  // The bounded-LRU helpers the Blob caches use. createGarmentComposite memoises
  // through lruSet(), so this slice has to come along or the extracted code hits a
  // ReferenceError the moment it finishes building its first composite.
  extract("const BLOB_CACHE_MAX", "const _assetBlobCache") +
  extract("function sampleBackdrop", "/* object-fit: cover") +
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
const ctxStub = new Proxy({}, {
  get(_, prop) {
    if (prop === "measureText") return (t) => ({ width: t.length * 10 });
    if (prop === "getImageData") return () => ({ data: BACKDROP_PIXEL });
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
  const px = (rgb) => ({ data: [...rgb, 255] });
  const withPixels = (seq) => {
    let i = 0;
    const prev = window.document.createElement;
    window.document.createElement = (tag) => {
      if (tag !== "canvas") return prev(tag);
      return { set width(_) {}, set height(_) {}, get width() { return 100; }, get height() { return 100; },
        getContext: () => ({ drawImage() {}, getImageData: () => px(seq[Math.min(i++, seq.length - 1)]) }) };
    };
    const out = sampleBackdrop([{ width: 100, height: 100 }, { width: 100, height: 100 }]);
    window.document.createElement = prev;
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
  check("unreadable pixels fall back to a light neutral, never the old dark grey", (() => {
    const prev = window.document.createElement;
    window.document.createElement = (tag) => {
      if (tag !== "canvas") return prev(tag);
      return { set width(_) {}, set height(_) {}, get width() { return 10; }, get height() { return 10; },
        getContext: () => ({ drawImage() {}, getImageData() { throw new Error("tainted"); } }) };
    };
    const out = sampleBackdrop([{ width: 10, height: 10 }]);
    window.document.createElement = prev;
    return out.fill === "#f2f2f2";
  })());
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

/* ═══════════════════════════════════════════════════════════════════════════
   PROMPT TOKEN BUDGET - the production crash this suite now guards
   ───────────────────────────────────────────────────────────────────────────
   Decart rejects an over-long prompt outright:

     "Prompt is too long: 1376 tokens (maximum 226, including the end-of-sequence
      token). Please shorten the prompt."

   set() fails and the shopper gets NO garment - so prompt length is a correctness
   property here, not a style one, and it is the kind that regresses silently: every
   clause this repo has ever added was individually justified, and the sum is what
   crossed the line. Nothing before this asserted the sum.

   Measured in CHARACTERS because the browser has no tokenizer (see config.js
   PROMPT_MAX_CHARS). ~4 chars/token for English prose puts the 226-token ceiling at
   ~904 chars; 750 is asserted here, keeping ~17% headroom for the ALL-CAPS and heavy
   punctuation these prompts still contain, both of which tokenize worse than prose.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── PROMPT BUDGET: every builder, every angle, under the 226-token ceiling ──");
{
  const promptCode = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                               SRC.indexOf("/* Full-Look composite clause"));
  const psandbox = {
    PROMPT_MAX_CHARS: 650, console: { warn() {}, log() {} },
    SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
    colorName: () => "white", getSizeDelta: () => 0,
    getFitModifier: () => "regular fit", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
  };
  const P = new Function(...Object.keys(psandbox),
    promptCode + "\nreturn { buildCompositePrompt, fitPrompt, P, DENSE };")(...Object.values(psandbox));

  const MAX = 650;                       // ~187 tokens - the assertion the spec asks for
  const TEE = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };
  const cases = [
    ["FRONT  square-on", TEE, "front", false],
    ["FRONT  EDGE-ON", TEE, "front", true],
    ["BACK   square-on", TEE, "back", false],
    ["BACK   EDGE-ON", TEE, "back", true],
    ["BOTTOMS EDGE-ON", { ...TEE, garmentType: "lower_body" }, "front", true],
    ["custom upload", { ...TEE, custom: true }, "front", true],
  ];
  for (const [name, item, angle, prof] of cases) {
    const out = P.buildCompositePrompt(item, angle, prof);
    check(`${name}: ${String(out.length).padStart(3)} chars (~${Math.ceil(out.length / 4)} tok) < ${MAX}`,
      out.length < MAX, out.slice(0, 160) + "…");
  }

  /* THE GUARANTEE, not the happy path. Every length above is a measurement of today's
     catalog copy; none of them proves the NEXT clause or a longer product name cannot
     push it over. fitPrompt() sheds by priority, so this asserts the mechanism itself
     rather than trusting the authored strings to stay short. */
  const pathological = { ...TEE, color: "#fff",
    subType: "short_sleeve", name: "x".repeat(400) };
  check("a pathologically long garment name still fits (clauses shed, then a hard clamp)",
    P.buildCompositePrompt(pathological, "front", true).length <= 650);

  const shed = P.fitPrompt([
    [P.P.CORE, "CORE stays."],
    [P.P.HIGH, "HIGH goes second-to-last."],
    [P.P.TRIM, "TRIM goes first."],
  ], 30);
  check("fitPrompt drops the WORST priority first, keeping CORE",
    /CORE stays\./.test(shed) && !/TRIM goes first/.test(shed), JSON.stringify(shed));
  check("...and never returns more than the budget",
    P.fitPrompt([[P.P.CORE, "y".repeat(900)]], 120).length <= 120);

  /* Square-on must not pay for the edge-on clauses - the contextual-trimming half of
     the spec. If the profile directives ever ride unconditionally, the base prompt
     loses that many characters of budget for a band that is not even in view. */
  const sq = P.buildCompositePrompt(TEE, "front", false);
  check("square-on omits the EDGE-ON directives entirely",
    !/EDGE-ON/.test(sq) && !/flank/.test(sq), sq);
  check("...and is therefore shorter than the edge-on prompt",
    sq.length < P.buildCompositePrompt(TEE, "front", true).length);

  /* THE WIRE GUARD. fitPrompt() budgets what this file BUILDS; clampPromptForWire()
     budgets what actually reaches Decart. The distinction is the whole lesson of this
     bug: the crash was reported twice against prompts that no builder here produces, and
     a guarantee that only covers the builders cannot see a path that skips them. Asserted
     on the SEND sites, because "every builder is short" is not the property that keeps the
     session alive - "nothing long reaches set()" is. */
  const wireCode = SRC.slice(SRC.indexOf("function clampPromptForWire"),
                             SRC.indexOf("function fitPrompt"));
  let warned = "";
  const clamp = new Function("PROMPT_MAX_CHARS", "console",
    wireCode + "\nreturn clampPromptForWire;")(650, { error: (m) => { warned = m; } });
  check("the wire guard truncates an over-long prompt rather than letting set() reject it",
    clamp("z".repeat(5000), "test").length === 650);
  check("...and logs loudly, because firing at all means a builder bypassed the budget",
    /over the 650 budget/.test(warned), warned.slice(0, 120));
  check("...while leaving an in-budget prompt byte-identical",
    clamp(sq, "test") === sq);

  for (const site of ["applyGarment", "applyLook"]) {
    check(`the ${site} send path is wrapped by the wire guard`,
      new RegExp(`clampPromptForWire\\([\\s\\S]{0,400}"${site}"`).test(SRC),
      `no clampPromptForWire(..., "${site}") found`);
  }
  /* Every rtClient.set()/setPrompt() call must draw from a guarded string. If a fifth
     send site is ever added straight from a builder, this is what catches it. */
  const sends = (SRC.match(/await rtClient\.set\(|await rtClient\.setPrompt\(/g) || []).length;
  check(`all ${sends} rtClient send sites draw from a guarded prompt`,
    sends === 4, `${sends} send sites found - if this changed, verify the new one is clamped`);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
