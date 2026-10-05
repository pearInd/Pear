/* THE ADIDAS FIXES, IN THE WIDGET - not just the scanner
   ─────────────────────────────────────────────────────────────────────────────
   Four generalizations were first made scanner-side only, while capturing
   adidas.co.il (5ca576e): ARIA div-grid charts, "86cm" with no space before the unit,
   CSS-Modules `___hash` class tokens read as audience words, and JSON envelopes whose
   markup field is either "html" or "content". The live widget had the same blind
   spots - and the no-space unit one is not cosmetic there: on a page with an
   "Inches" toggle label, a glued "62cm" waist cell fell through to the ancestor-text
   unit, read "inch", and shipped a 155.5-159.5cm waist band that passes every clamp.

   All four now live in the widget's @pear-shared:size-chart-parser block (and so,
   generated, in scanner/size-chart-parser.js). This suite proves each one AGAINST THE
   WIDGET'S OWN SOURCE:
     §1-§3 drive the REAL widget (injected into jsdom, button clicked, the iframe URL's
           garment_size_chart read back) - what a live store page would send the room;
     §4-§5 evaluate the widget's shared block standalone (sliced from pear-widget.js,
           not imported from the scanner copy) for the two pure helpers the widget's
           own PDP path has no live caller for yet.
   size-chart-parser-sync.test.mjs separately pins the scanner copy byte-identical.

   ON THE HIDDEN BUILD (CLAUDE.md §2.12) the widget only COLLECTS the page's grids (the DOM half
   of these fixes: ARIA div-grids, the inches/cm twin) and sends them raw; the server reads them
   (lib/sizing.js - the cell half: the glued "86cm"). So §1-§3 read the widget's raw wire through
   the server's own reader (storeChartWire(): decodeRawSizeChart -> readStoreSizeChart ->
   encodeSizeChart), which is what reaches the fit, and main's assertions run on that unchanged.
   The shared parser block lives in scanner/size-chart-reader.src.js now (the scanner's source);
   §3.2-§5 evaluate it there, and §0 pins the widget's grid finder to it, function for function.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { sharedBlock } from "../scripts/sync-size-chart-parser.mjs";
import { openWidget, PDP } from "./helpers/widget-jsdom.mjs";
import { storeChartWire } from "../lib/sizing.js";

const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const READER = readFileSync(new URL("../scanner/size-chart-reader.src.js", import.meta.url), "utf8");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
/* What the room's fit reads: the widget's raw grids through the server's reader. */
const chartOf = async (markup) => storeChartWire((await openWidget(PDP(markup))).params.get("garment_size_chart") || "");

console.log("\n── §0 the widget's grid finder IS the scanner reader's ──");
{
  /* A function's text from its declaration to the closing brace at its own indent. */
  const fnText = (src, name) => {
    const a = src.indexOf(`  function ${name}(`);
    if (a === -1) return null;
    const b = src.indexOf("\n  }\n", a);
    return b === -1 ? null : src.slice(a, b + 4);
  };
  const varText = (src, name) => { const m = new RegExp(`\\n  var ${name} = [^\\n]*`).exec(src); return m ? m[0] : null; };
  for (const name of ["sizeChartIsAriaGrid", "sizeChartIsGridEl", "sizeChartGrid", "sizeChartGridUnit", "sizeChartTwinKey",
    "sizeChartTables", "sizeChartUnitFromText", "sizeChartTableUnit"]) {
    const w = fnText(PW, name), r = fnText(READER, name);
    check(`§0 ${name}() is the same text in the widget and the reader`, !!w && w === r, w ? "differs" : "missing");
  }
  for (const name of ["SIZE_CHART_TABLE_SEL", "SIZE_CHART_ARIA_CELL_SEL", "SIZE_CHART_CM_RE", "SIZE_CHART_IN_RE", "SIZE_CHART_DECLARED_IN_RE"]) {
    const w = varText(PW, name), r = varText(READER, name);
    check(`§0 ${name} is the same in the widget and the reader`, !!w && w === r, `${w} | ${r}`);
  }
  /* ...and the cell/header tier on the server reads units with the same two regexes (CLAUDE.md §3). */
  const LIBSRC = readFileSync(new URL("../lib/sizing.js", import.meta.url), "utf8");
  for (const name of ["SIZE_CHART_CM_RE", "SIZE_CHART_IN_RE"]) {
    const l = (new RegExp(`\\nvar ${name} = [^\\n]*`).exec(LIBSRC) || [""])[0].trim(), w = (varText(PW, name) || "").trim();
    check(`§0 ${name} is the same in lib/sizing.js (the server's cell tier)`, !!l && l === w, `${l} | ${w}`);
  }
}
/* "cm;container;XS:83-86:71-74:82-85:|S:..." -> { XS: [chest, waist, hips, legs] } */
const decode = (wire) => {
  const out = {};
  for (const chunk of String(wire).split(";").slice(2).join(";").split("|").filter(Boolean)) {
    const [size, ...cells] = chunk.split(":");
    out[size] = cells;
  }
  return out;
};

/* adidas.co.il's markup, trimmed: an Inches grid, then a cm grid, same header and
   first column, each in a "kids-table___1-YOY" skin, cm cells glued to the unit. */
const ARIA_ROW = (head, cells) => `<div role="row"><div role="rowheader">${head}</div>${cells.map((c) => `<div role="cell">${c}</div>`).join("")}</div>`;
const ARIA_GRID = (rows) => `<div class="gl-table kids-table___1-YOY" role="table">
  <div role="row"><div role="columnheader">Product label</div><div role="columnheader">XS</div><div role="columnheader">S</div><div role="columnheader">M</div></div>
  ${rows.join("\n")}</div>`;
const INCH_GRID = ARIA_GRID([
  ARIA_ROW("Chest", ['32 - 34"', '34 - 36"', '36 - 39"']),
  ARIA_ROW("Waist", ['28 - 29"', '29 - 31"', '32 - 34"'])]);
const CM_GRID = ARIA_GRID([
  ARIA_ROW("Chest", ["83 - 86cm", "87 - 92cm", "93 - 100cm"]),
  ARIA_ROW("Waist", ["71 - 74cm", "75 - 80cm", "81 - 88cm"])]);

console.log("\n── §1 ARIA div-grids are read by the live widget ──");
{
  const wire = await chartOf(`<div class="size-chart"><h5>MEN'S TOPS</h5>${CM_GRID}</div>`);
  const c = decode(wire);
  check("§1.1 a role=table div-grid (no <table> anywhere) reaches the room", !!wire, wire);
  check("§1.2 ...transposed layout read the right way round (XS chest 83-86, waist 71-74)",
    c.XS && c.XS[0] === "83-86" && c.XS[1] === "71-74", wire);
  check("§1.3 ...from the platform container tier, not just the generic fallback", /^cm;shopify;/.test(wire), wire);

  const wrapped = await chartOf(`<div role="table" class="size-chart"><table>
    <tr><th>Size</th><th>Chest (cm)</th></tr><tr><td>S</td><td>88-94</td></tr><tr><td>M</td><td>95-101</td></tr></table></div>`);
  check("§1.4 a role=table WRAPPER around a real <table> is read once, as the table", decode(wrapped).M?.[0] === "95-101", wrapped);

  const flat = await chartOf(`<div class="size-chart"><div>Size S chest 90</div><div>Size M chest 96</div></div>`);
  check("§1.5 a container with neither <table> nor ARIA roles still yields nothing (no guessing)", flat === "", flat);
}

console.log("\n── §2 a glued \"86cm\" is centimetres, not inches ×2.54 ──");
{
  /* The live-widget bug: no unit in the cell (pre-fix), none in the header, and the
     container's own text says "Inches" (the toggle label adidas renders beside the
     grid) - pre-fix, a women's 62/68/74cm waist ladder shipped as 155.5-159.5 /
     170.7-174.7 / 186-190: inside every clamp, monotonic, and wrong by ×2.54. */
  const wire = await chartOf(`<div class="size-guide"><button>Inches</button> <table>
    <tr><th>Size</th><th>Waist</th><th>Hips</th></tr>
    <tr><td>S</td><td>62cm</td><td>94cm</td></tr><tr><td>M</td><td>68cm</td><td>100cm</td></tr>
    <tr><td>L</td><td>74cm</td><td>106cm</td></tr></table></div>`);
  const c = decode(wire);
  check("§2.1 a women's 62cm waist stays 60-64 (point ±2) - pre-fix it shipped 155.5-159.5", c.S && c.S[1] === "60-64", wire);
  check("§2.2 hips 94cm stays 92-96 - the column the ×2.54 would have refused outright", c.S && c.S[2] === "92-96", wire);
  check("§2.3 a spaced \"cm\" still reads as before", decode(await chartOf(`<table><tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>90 cm</td></tr><tr><td>M</td><td>96 cm</td></tr></table>`)).M?.[0] === "94-98");
  const inch = await chartOf(`<table><tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>36in</td></tr><tr><td>M</td><td>38in</td></tr></table>`);
  check("§2.4 the inch twin of the bug: a glued \"38in\" converts (96.5 ±2)", decode(inch).M?.[0] === "94.5-98.5", inch);
  const words = await chartOf(`<p>Our cms are approximate.</p><table><tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>36</td></tr><tr><td>M</td><td>38</td></tr></table>`);
  check("§2.5 the far-side boundary holds: \"cms\" in prose declares nothing (36/38 stay inches by magnitude)",
    decode(words).M?.[0] === "94.5-98.5", words);
}

console.log("\n── §3 an Inches | cm toggle pair keeps the cm grid ──");
{
  const wire = await chartOf(`<div class="size-chart">${INCH_GRID}<p>Scroll horizontally.</p>${CM_GRID}</div>`);
  const c = decode(wire);
  check("§3.1 inch grid rendered FIRST, cm grid wins (XS chest 83-86, not 81.3-86.4)",
    c.XS && c.XS[0] === "83-86", wire);
  /* Same header, same first column, both cm: two audiences' charts, never twins. */
  const MEN = CM_GRID, WOMEN = CM_GRID.replace("83 - 86cm", "78 - 81cm");
  const W = new JSDOM(`<div>${MEN}</div><div>${WOMEN}</div>`).window.document;
  const api = new Function("d", "console", sharedBlock(PW, "size-token") + sharedBlock(READER, "size-chart-parser") +
    "return { sizeChartTables: sizeChartTables };")(W, { log() {} });
  check("§3.2 two same-shaped cm grids are BOTH kept (a looser twin key would drop an audience)",
    api.sizeChartTables(W).length === 2, api.sizeChartTables(W).length);
  const T = new JSDOM(`<section><h5>MEN</h5>${INCH_GRID}${CM_GRID}</section>`).window.document;
  const kept = api.sizeChartTables(T);
  const grids = T.querySelectorAll('[role="table"]');
  check("§3.3 the collapsed pair keeps the cm element and anchors context at the first-rendered one",
    kept.length === 1 && kept[0].el === grids[1] && kept[0].anchor === grids[0]);
}

/* The widget's own shared block, evaluated standalone - the same isolation the scanner
   copy runs in (only `d` and console free), but sliced from pear-widget.js itself. */
const W = new Function("d", "console", sharedBlock(PW, "size-token") + sharedBlock(READER, "size-chart-parser") +
  "return { sizeChartContextClean: sizeChartContextClean, sizeChartUnwrapEnvelope: sizeChartUnwrapEnvelope };")(null, { log() {} });

console.log("\n── §4 CSS-Modules ___hash class tokens are not audience words ──");
{
  check("§4.1 \"kids-table___1-YOY\" is dropped, the semantic class kept",
    W.sizeChartContextClean("gl-table kids-table___1-YOY") === "gl-table");
  check("§4.2 a hand-authored audience class survives", W.sizeChartContextClean("size-chart-women  active") === "size-chart-women active");
  check("§4.3 null/empty are safe", W.sizeChartContextClean(null) === "" && W.sizeChartContextClean("") === "");
}

console.log("\n── §5 JSON envelopes: {html} and {content} ──");
{
  const html = W.sizeChartUnwrapEnvelope('{"success":true,"html":"<table></table>"}');
  check("§5.1 castro's {html} field", html && html.html === "<table></table>", JSON.stringify(html));
  const content = W.sizeChartUnwrapEnvelope('  {"action":"Product-SizeChart","success":true,"content":"<div role=\\"table\\"></div>"}');
  check("§5.2 adidas's {content} field (leading whitespace tolerated)", content && content.html === '<div role="table"></div>', JSON.stringify(content));
  check("§5.3 {success:false} is not a page", W.sizeChartUnwrapEnvelope('{"success":false,"html":""}')?.failed === true);
  check("§5.4 plain HTML, broken JSON and markup-less JSON are not envelopes",
    W.sizeChartUnwrapEnvelope("<html></html>") === null && W.sizeChartUnwrapEnvelope("{oops") === null &&
    W.sizeChartUnwrapEnvelope('{"a":1}') === null);
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("size-chart-shared-fixes: all checks passed.");
