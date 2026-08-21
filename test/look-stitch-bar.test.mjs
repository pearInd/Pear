/* THE FULL-LOOK STITCHED REFERENCE - "the canvas is split into two blocks".

   THE REPORT: the live frame renders as two disconnected blocks, the lower one a solid
   black rectangle. It was read as canvas splitting in the RENDER path - dual-canvas
   layering, CSS viewport slicing, a ctx.clip() cutting the display surface. It is none of
   those. The display path is one <video> element mapped 1:1 to the WebRTC stream, and the
   only ctx.clip() calls in this file are in off-DOM REFERENCE-image builders.

   IT WAS THE REFERENCE IMAGE ITSELF. For a full look (top + bottom together),
   applyLook() sends stitchLookBlob() to rtClient.set({ image }), and that blob was:

       a pure-black 1024x2048 canvas
       a garment panel in the upper half
       a 200px SOLID BLACK bar across the middle
       a garment panel in the lower half

   A video-to-video diffusion model conditioned on an image whose single highest-contrast
   feature is a black horizontal band has every reason to put a black horizontal band in
   its output. That is not a hypothesis about this model - it is a lesson THIS FILE ALREADY
   LEARNED on the front/back stitcher, recorded verbatim in COMPOSITE_DIVIDER's comment:
   the old fixed #3a3a3a divider between two white packshots was "the highest-contrast
   feature in the whole reference, and the one that ended up painted on the shopper."
   That path was fixed by sampling the backdrop from the packshots. The look stitcher kept
   the old design, at far greater severity - pure black rather than dark grey, 200px rather
   than a hairline, plus a black surround and white markers drawn onto the garments.

   WHAT THIS SUITE DOES: extracts stitchLookBlob() and EXECUTES it against a recording 2D
   context, then asserts on the pixels it actually asked for. A source-grep suite would
   pass on a reworded black fill; this one does not. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = APP.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return APP.slice(start, end);
}

/* The REAL geometry constants and the REAL function, both verbatim. The constants come
   along because the assertions below are about WHERE things land, and re-declaring them
   here would let the test agree with itself while disagreeing with the app. */
const CONSTS = extract("const LOOK_W   = 1024", "const _lookStitchCache");
const FN     = extract("function stitchLookBlob(topUrl, bottomUrl) {",
                       "/**\n * Return an absolute URL that the Decart server can reliably fetch.");

/** Parse "rgb(r, g, b)" / "#rgb" / "#rrggbb" into [r,g,b], or null. */
function parseColor(c) {
  if (typeof c !== "string") return null;
  const m = c.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (m) return [+m[1], +m[2], +m[3]];
  const h = c.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(h)) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (/^[0-9a-f]{3}$/i.test(h)) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
  return null;
}
const luma = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

/* Run the real stitcher against stubs, recording every fill and every draw. BACKDROP is
   deliberately a LIGHT colour, the normal case for garment packshots on white - which is
   exactly the case where a black bar is the highest-contrast thing in the image. */
const BACKDROP = { fill: "rgb(244, 244, 246)", contrast: "#101010" };

async function runStitch({ labels = true } = {}) {
  const fills = [];    // { style, x, y, w, h }
  const covers = [];   // { dx, dy, dw, dh }
  const labelCalls = []; // { text, anchorX, top, fontPx, align }
  const ctx = {
    _fillStyle: null,
    set fillStyle(v) { this._fillStyle = v; },
    get fillStyle() { return this._fillStyle; },
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, clip() {},
    rect() {},
    fillRect(x, y, w, h) { fills.push({ style: this._fillStyle, alpha: this.globalAlpha, x, y, w, h }); },
    drawImage() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (cb) => cb({ fake: "blob" }) };

  const sandbox = new Function("deps", `
    "use strict";
    const { loadGarmentBitmap, sampleBackdrop, drawImageCover, drawSectionLabel,
            document, console, lruTouch, lruSet, canvas, LOOK_LABELS_OVERRIDE } = deps;
    const OffscreenCanvas = undefined;
    const _lookStitchCache = new Map();
    ${CONSTS}
    const LOOK_LABELS_EFFECTIVE = LOOK_LABELS_OVERRIDE;
    ${FN.replace(/\bLOOK_LABELS\b/g, "LOOK_LABELS_EFFECTIVE")}
    return stitchLookBlob;
  `)({
    loadGarmentBitmap: async () => ({ width: 800, height: 1200, close() {} }),
    sampleBackdrop: () => BACKDROP,
    drawImageCover: (c, img, dx, dy, dw, dh) => covers.push({ dx, dy, dw, dh }),
    drawSectionLabel: (c, text, anchorX, top, fontPx, align) =>
      labelCalls.push({ text, anchorX, top, fontPx, align }),
    document: { createElement: () => canvas },
    console,
    lruTouch: (m, k) => m.get(k),
    lruSet: (m, k, v) => m.set(k, v),
    canvas,
    LOOK_LABELS_OVERRIDE: labels,
  });

  const blob = await sandbox("top.jpg", "bottom.jpg");
  return { blob, fills, covers, labelCalls };
}

/* Geometry, read out of the app's own constants rather than restated. */
const geo = new Function(`${CONSTS} return { LOOK_W, LOOK_H, LOOK_SEP, LOOK_PAD, LOOK_BOX, LOOK_DIVIDER, LOOK_LABELS };`)();

const run = await runStitch();

console.log("── §1 THE REPORTED BAR IS GONE FROM THE REFERENCE ──");
{
  check("the stitch still produces a blob (the stub path runs end to end)",
    run.blob && typeof run.blob === "object", JSON.stringify(run.blob));

  /* THE CORE ASSERTION. Not "the string #000000 is absent from app.js" - that passes on a
     reworded constant. Every fill this function actually requested is inspected, and none
     of them may be a dark block. */
  const dark = run.fills.filter((f) => {
    const rgb = parseColor(f.style);
    return rgb && luma(rgb) < 0.2 && f.alpha >= 0.9 && f.w * f.h > 0;
  });
  check("NO opaque dark fill is painted anywhere in the reference",
    dark.length === 0,
    dark.map((f) => `${f.style} @ ${f.x},${f.y} ${f.w}x${f.h}`).join(" | "));

  /* THE SPECIFIC ONE THE REPORT IS ABOUT: a full-width band sitting in the gap between the
     two panels. Even a mid-grey band here would be the highest-contrast horizontal feature
     in the image, which is the mechanism regardless of exact darkness. */
  const bandY = geo.LOOK_BOX;
  const bandFills = run.fills.filter((f) =>
    f.w >= geo.LOOK_W * 0.9 && f.y >= bandY - 1 && f.y + f.h <= bandY + geo.LOOK_SEP + 1);
  const contrasty = bandFills.filter((f) => {
    const rgb = parseColor(f.style), bg = parseColor(BACKDROP.fill);
    return rgb && bg && Math.abs(luma(rgb) - luma(bg)) > 0.25 && f.alpha >= 0.9;
  });
  check("...and specifically NO high-contrast band across the panel gap",
    contrasty.length === 0,
    contrasty.map((f) => `${f.style} @ y=${f.y} h=${f.h}`).join(" | "));
}

console.log("\n── §2 THE BACKDROP IS SAMPLED, NOT HARD-CODED ──");
{
  /* The same fix the front/back stitcher already shipped: the surround and the gap are the
     packshots' OWN background colour, so the panels meet with no edge for the model to
     copy. Asserted against the value sampleBackdrop() returned, so a hard-coded light grey
     that merely LOOKS harmless would still fail. */
  const bg = run.fills.find((f) => f.w === geo.LOOK_W && f.h === geo.LOOK_H);
  check("the full-canvas ground is painted with the SAMPLED backdrop",
    !!bg && bg.style === BACKDROP.fill,
    bg ? `${bg.style} (expected ${BACKDROP.fill})` : "no full-canvas fill at all");
  check("...so the gap between the panels is that same colour - a seamless join",
    !!bg && !run.fills.some((f) =>
      f.y >= geo.LOOK_BOX - 1 && f.y + f.h <= geo.LOOK_BOX + geo.LOOK_SEP + 1 && f.alpha >= 0.9),
    "nothing opaque may be painted over the gap once the ground is down");
  check("LOOK_DIVIDER ships at 0 - seamless by default, a switch rather than a deletion",
    geo.LOOK_DIVIDER === 0, String(geo.LOOK_DIVIDER));
}

console.log("\n── §3 THE PANELS ARE STILL SEPARATED - contrast went, geometry did not ──");
{
  /* SEPARATION WAS NEVER THE PROBLEM; CONTRAST WAS. The two garments still occupy
     non-overlapping halves with a 200px gap between them, because letting them touch is
     the failure the panel layout exists to prevent (the two garments blending into one). */
  check("exactly two garment panels are drawn",
    run.covers.length === 2, `${run.covers.length} draws`);
  const [top, bottom] = run.covers;
  check("...the TOP panel sits entirely above the gap",
    top && top.dy + top.dh <= geo.LOOK_BOX, JSON.stringify(top));
  check("...the BOTTOM panel sits entirely below it",
    bottom && bottom.dy >= geo.LOOK_BOX + geo.LOOK_SEP, JSON.stringify(bottom));
  /* The PANEL BOXES are LOOK_SEP apart; the drawn GARMENT PIXELS are further apart still,
     because each is inset by LOOK_PAD inside its box. The pixel gap is the one that
     matters for bleed, so it is what is asserted - and it must be the full separator plus
     both insets, unchanged by the de-contrasting. */
  const pixelGap = bottom && top ? bottom.dy - (top.dy + top.dh) : NaN;
  check("...and the garment pixels stay LOOK_SEP + both insets apart, unchanged",
    pixelGap === geo.LOOK_SEP + geo.LOOK_PAD * 2,
    `gap=${pixelGap} expected=${geo.LOOK_SEP + geo.LOOK_PAD * 2}`);
  /* The clips are what keep a wide packshot inside its own half. They are the ctx.clip()
     calls the report pointed at - on an off-DOM reference builder, not the display surface -
     and removing them would make the two garments bleed together. Fenced so a future
     "remove all clip() calls" sweep has to read this first. */
  check("the panel clips are still in place - they prevent bleed, they do not split output",
    /ctx\.beginPath\(\); ctx\.rect\(0, 0, W, boxH\); ctx\.clip\(\);/.test(FN) &&
    /ctx\.beginPath\(\); ctx\.rect\(0, bottomY, W, boxH\); ctx\.clip\(\);/.test(FN),
    "these clip an off-DOM REFERENCE image; the display path has no clip at all");
}

console.log("\n── §4 THE MARKERS MOVED OFF THE GARMENTS ──");
{
  /* Text drawn ON a garment is text that can be composited onto the shopper - the exact
     artifact COMPOSITE_LABELS records for the front/back stitcher, which moved its markers
     into a dedicated band for this reason. The look stitcher still drew "TOP"/"BOTTOM"
     directly over the packshots. The gap is the one region of this reference with no
     garment pixels in it, so that is where they go. */
  check("both markers are still drawn - the identity signal is load-bearing",
    run.labelCalls.length === 2 &&
    run.labelCalls.map((l) => l.text).join(",") === "TOP,BOTTOM",
    JSON.stringify(run.labelCalls.map((l) => l.text)));
  const inGap = run.labelCalls.every((l) => {
    const h = l.fontPx + Math.round(l.fontPx * 0.32) * 2;
    return l.top >= geo.LOOK_BOX && l.top + h <= geo.LOOK_BOX + geo.LOOK_SEP;
  });
  check("...and BOTH sit inside the gap, over no garment pixels at all",
    inGap, JSON.stringify(run.labelCalls));
  check("...they no longer land on the panels, which is where they used to be drawn",
    !run.labelCalls.some((l) => l.top < geo.LOOK_BOX),
    "a label at y=inset is a label on the shirt");

  const off = await runStitch({ labels: false });
  check("LOOK_LABELS=false drops them entirely - a real switch, not decoration",
    off.labelCalls.length === 0, JSON.stringify(off.labelCalls));
  check("...and the reference still renders both panels without them",
    off.covers.length === 2, `${off.covers.length} draws`);
}

console.log("\n── §5 THE PROMPT HALF SHIPS WITH IT ──");
{
  /* The bar was doing TWO jobs: it was the defect, and it was the only signal that the
     reference held two separate garments rather than one photograph. Removing it without
     saying anything would trade a split frame for a blended one - so the clause that
     explains the layout goes on the wire in the same change. buildLookPrompt() takes an
     `angleText` argument that it never reads, which is why this was missing for so long. */
  check("the look prompt now carries a clause explaining the stacked layout",
    /const LOOK_PANEL_CLAUSE =/.test(APP) &&
    /The reference stacks two garments; render both at once in one continuous frame\./.test(APP),
    "removing the visual separator without a textual one trades a split for a blend");
  check("...and it is actually assembled, not passed to a function that ignores it",
    /\[P\.HIGH,\s*LOOK_PANEL_CLAUSE\.trim\(\)\]/.test(APP),
    "DENSE.lookPanels was passed into buildLookPrompt() and dropped on the floor for revisions");
  check("...banning reproduction of the layout in the same clause",
    /Never draw its panel gap or bars into the video\./.test(APP));
  check("app.js records the pixel/prompt pairing so neither half is removed alone",
    /straight swap of a VISUAL instruction the model copies/.test(APP),
    "the two halves are one fix and the file has to say so");
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
