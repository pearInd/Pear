/* ONE SIZE-GUIDE PARSER, TWO RUNTIMES - the widget and the store scanner
   ─────────────────────────────────────────────────────────────────────────────
   The scanner stores a store's size guide; the widget reads one live off a product
   page. If the two parsed the same table differently, the room would get one answer
   from a stored chart and another from the live one, for the same garment. So
   scanner/size-chart-parser.js is GENERATED from the widget's
   "@pear-shared:size-token" and "@pear-shared:size-chart-parser" blocks
   (scripts/sync-size-chart-parser.mjs), and this suite is what makes that true:

   §1 BYTE IDENTITY. Re-rendering the generated file from the current widget must
      reproduce the committed file exactly. An edit to the widget's parser without
      `npm run sync:size-chart-parser` fails here, not in production.
   §2 SELF-CONTAINED. The shared blocks may reference nothing from the widget outside
      them (only `d` and console) - otherwise the scanner copy dies on a ReferenceError
      the widget never sees (the CLAUDE.md §2.6 "helper above the marker" failure).
   §3 SAME ANSWER, SAME FIXTURES. One set of size-guide pages goes through the REAL
      widget (injected into jsdom, button clicked, iframe URL read) and through the
      scanner's parser; the encoded charts must be identical, including the silent
      pages where both must say nothing.
   §4 ALIASES. The EU/US/INT columns the shared parser now captures, read identically.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderScannerParser, sharedBlock, EXPORTS } from "../scripts/sync-size-chart-parser.mjs";
import { createSizeChartParser } from "../scanner/size-chart-parser.js";
import { openWidget, PDP } from "./helpers/widget-jsdom.mjs";

const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const GENERATED = readFileSync(new URL("../scanner/size-chart-parser.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("\n── §1 the scanner's copy is the widget's code, byte for byte ──");
{
  const expected = renderScannerParser(PW);
  check("§1.1 scanner/size-chart-parser.js == render(widget) - run `npm run sync:size-chart-parser` if this fails",
    GENERATED === expected,
    `first difference at char ${[...expected].findIndex((c, i) => c !== GENERATED[i])}`);
  const token = sharedBlock(PW, "size-token"), parser = sharedBlock(PW, "size-chart-parser");
  check("§1.2 both shared blocks appear verbatim in the generated file",
    GENERATED.includes(token) && GENERATED.includes(parser));
  check("§1.3 the parser block is the real thing (extractSizeChart + encodeSizeChart inside it)",
    /function extractSizeChart\(\)/.test(parser) && /function encodeSizeChart\(chart\)/.test(parser));
  check("§1.4 the token block carries isPlausibleSizeToken", /function isPlausibleSizeToken\(s\)/.test(token));
}

console.log("\n── §2 the shared blocks are self-contained ──");
{
  /* Evaluate the generated factory against a document and call every export that is a
     function. A free reference to widget-only code throws ReferenceError here. */
  const doc = new JSDOM("<table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>90</td></tr><tr><td>M</td><td>96</td></tr></table>").window.document;
  let api = null, err = null;
  try { api = createSizeChartParser(doc); api.extractSizeChart(); } catch (e) { err = e; }
  check("§2.1 the factory runs standalone", !!api && !err, err && err.message);
  check("§2.2 ...and exposes every documented export",
    !!api && EXPORTS.every((k) => api[k] !== undefined), EXPORTS.filter((k) => !api || api[k] === undefined).join(","));
}

/* Size-guide pages. The first five must be READ, the last three must be SILENT. */
const FIXTURES = [
  ["shopify modal, cm ranges", `<div class="size-guide"><table>
      <tr><th>Size</th><th>Chest (cm)</th><th>Waist (cm)</th></tr>
      <tr><td>S</td><td>88-94</td><td>74-80</td></tr><tr><td>M</td><td>95-101</td><td>81-87</td></tr>
      <tr><td>L</td><td>102-108</td><td>88-94</td></tr></table></div>`],
  ["transposed, inches", `<div id="size-chart-modal"><table>
      <tr><th>Size</th><th>S</th><th>M</th><th>L</th></tr>
      <tr><td>Chest (inches)</td><td>36</td><td>38</td><td>40</td></tr></table></div>`],
  ["hebrew, point values", `<div class="sizeguide"><table>
      <tr><th>מידה</th><th>היקף חזה</th><th>מותניים</th></tr>
      <tr><td>S</td><td>92</td><td>78</td></tr><tr><td>M</td><td>98</td><td>84</td></tr>
      <tr><td>L</td><td>104</td><td>90</td></tr></table></div>`],
  ["2XS/3XS spelling + word sizes", `<table>
      <tr><th>Size</th><th>Bust</th></tr><tr><td>2XS</td><td>76-80</td></tr>
      <tr><td>Extra Small</td><td>80-84</td></tr><tr><td>Small</td><td>84-88</td></tr></table>`],
  ["alias columns", `<div class="size-chart"><table>
      <tr><th>INT</th><th>EU</th><th>US</th><th>Chest</th></tr>
      <tr><td>S</td><td>46</td><td>S</td><td>88-94</td></tr><tr><td>M / 38</td><td>48</td><td>40</td><td>95-101</td></tr>
      <tr><td>L (EU 50)</td><td>50</td><td>42</td><td>102-108</td></tr></table></div>`],
  ["SILENT: price table", `<table><tr><th>Size</th><th>Price</th></tr>
      <tr><td>S</td><td>89.90</td></tr><tr><td>M</td><td>89.90</td></tr></table>`],
  ["SILENT: garment-dimension header", `<table><tr><th>Size</th><th>Half Chest</th></tr>
      <tr><td>S</td><td>48</td></tr><tr><td>M</td><td>51</td></tr></table>`],
  ["SILENT: non-monotonic column", `<table><tr><th>Size</th><th>Chest</th></tr>
      <tr><td>S</td><td>96</td></tr><tr><td>M</td><td>90</td></tr><tr><td>L</td><td>104</td></tr></table>`],
];

console.log("\n── §3 the widget and the scanner read the same page the same way ──");
for (const [name, markup] of FIXTURES) {
  const { params } = await openWidget(PDP(markup));
  const widgetChart = params.get("garment_size_chart") || "";
  const doc = new JSDOM(PDP(markup), { url: "https://shop.example.com/products/tee" }).window.document;
  const scanner = createSizeChartParser(doc);
  const scannerChart = scanner.encodeSizeChart(scanner.extractSizeChart());
  const silent = name.startsWith("SILENT");
  check(`§3 ${name}: widget and scanner agree`, widgetChart === scannerChart,
    `widget "${widgetChart}" vs scanner "${scannerChart}"`);
  check(`§3 ${name}: ${silent ? "both stay silent" : "and it was actually read"}`,
    silent ? scannerChart === "" : scannerChart !== "", scannerChart);
}

console.log("\n── §4 alias columns ──");
{
  const doc = new JSDOM(FIXTURES[4][1]).window.document;
  const rows = createSizeChartParser(doc).extractSizeChart().rows;
  const m = rows.find((r) => r.size === "M");
  check("§4.1 EU and US columns become row aliases", m && m.aliases && m.aliases.eu === "48" && m.aliases.us === "40",
    JSON.stringify(m));
  const sRow = rows.find((r) => r.size === "S");
  check("§4.1b an alias equal to the row's own size is not stored (US 'S' on the S row)",
    sRow && sRow.aliases && sRow.aliases.us === undefined && sRow.aliases.eu === "46", JSON.stringify(sRow));
  check("§4.2 an unlabelled second token in the size cell is kept as `alt`", m && m.aliases.alt === "38", JSON.stringify(m));
  const l = rows.find((r) => r.size === "L");
  check("§4.3 a LABELLED token in the size cell wins over the column", l && l.aliases.eu === "50", JSON.stringify(l));
  check("§4.4 aliases never reach the widget's wire format (encodeSizeChart drops them)",
    !/48|50/.test(createSizeChartParser(doc).encodeSizeChart({ unit: "cm", source: "x", rows })));
  const waist = new JSDOM(`<table><tr><th>Size</th><th>Waist (US)</th></tr><tr><td>S</td><td>70-76</td></tr><tr><td>M</td><td>77-83</td></tr></table>`).window.document;
  const w = createSizeChartParser(waist).extractSizeChart();
  check("§4.5 'Waist (US)' is still a waist column, not a US alias",
    w && w.rows[0].minWaist === 70 && !w.rows[0].aliases, JSON.stringify(w && w.rows[0]));
}

console.log("\n── §5 a caption that says \"inches\" declares the unit (the backspace-byte bug) ──");
{
  /* THE BUG: SIZE_CHART_DECLARED_IN_RE was written /inch(?:es)?<BS>/i - a literal U+0008
     where \b was meant. It compiled, and matched nothing a real page contains, so the
     caption tier never declared inches and every chart fell through to magnitude
     inference. Magnitude is right for most charts (a 38in chest is under the 60 cutoff),
     so nothing visibly broke - until a plus-size chart: chest 62/64/66 INCHES is above
     the cutoff and was read as 62/64/66 CENTIMETRES (a child's chest), clamp-legal and
     monotonic, i.e. a confident, plausible, WRONG chart. Only the caption can say
     otherwise, which makes this the one fixture that tells the two regexes apart. */
  const CAPTION = `<div class="size-guide"><p>All measurements in inches</p><table>
      <tr><th>Size</th><th>Chest</th></tr>
      <tr><td>XXL</td><td>62</td></tr><tr><td>3XL</td><td>64</td></tr><tr><td>4XL</td><td>66</td></tr></table></div>`;
  const doc = new JSDOM(PDP(CAPTION), { url: "https://shop.example.com/products/tee" }).window.document;
  const scanner = createSizeChartParser(doc);
  const chart = scanner.extractSizeChart();
  const xxl = chart && chart.rows.find((r) => r.size === "XXL");
  check("§5.1 the scanner reads a 62in chest as ~157cm, not 62cm",
    xxl && Math.abs(xxl.minChest - (62 * 2.54 - 2)) < 0.11 && Math.abs(xxl.maxChest - (62 * 2.54 + 2)) < 0.11,
    JSON.stringify(xxl));
  const { params } = await openWidget(PDP(CAPTION));
  const wire = params.get("garment_size_chart") || "";
  check("§5.2 the widget sends the same converted band",
    wire === scanner.encodeSizeChart(chart) && /XXL:155\.5-159\.5:/.test(wire), wire);
  check("§5.3 the declared-unit regex itself matches the word, and the cm test still wins first",
    scanner.sizeChartTableUnit(doc.querySelector("table")) === "in" &&
    scanner.sizeChartTableUnit(new JSDOM(`<div>Size guide (cm) - measurements in inches below</div><table></table>`)
      .window.document.querySelector("table")) === "cm");
  const prose = new JSDOM(`<div><p>Made in Portugal. Shown in blue.</p><table></table></div>`).window.document;
  check("§5.4 ...and free prose without the WORD still declares nothing",
    scanner.sizeChartTableUnit(prose.querySelector("table")) === null);
  /* A byte-level guard on both copies: no C0 control character (other than tab/CR/LF)
     anywhere in the shared blocks - the class of bug, not just this instance. */
  const ctrl = (s) => [...s].filter((c) => c.charCodeAt(0) < 32 && !"\t\r\n".includes(c)).length;
  check("§5.5 no control bytes in the widget's shared blocks or the scanner copy",
    ctrl(sharedBlock(PW, "size-token") + sharedBlock(PW, "size-chart-parser")) === 0 && ctrl(GENERATED) === 0);
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("size-chart-parser-sync: all checks passed.");
