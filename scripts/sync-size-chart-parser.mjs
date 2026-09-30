#!/usr/bin/env node
/* =============================================================================
   Generates scanner/size-chart-parser.js from widget/pear-widget.js (the size-token
   block) and scanner/size-chart-reader.src.js (the size-guide reader).
   -----------------------------------------------------------------------------
   THE READER LEFT THE WIDGET on 2026-09-30 (the code-hiding branch, CLAUDE.md §2.12):
   the widget now only collects the candidate tables and sends them raw, and the live
   chart is read server-side in lib/sizing.js. The scanner still reads a DOM, so the
   block it used to copy out of the widget moved - byte for byte - to
   scanner/size-chart-reader.src.js, which is its source now. The size-token block is
   still the widget's (the size-list scrape uses it) and is still copied from there.
   The rationale below is the original one; "the widget" in it now means the widget's
   token block plus the reader source file.
   WHY A GENERATED COPY, NOT A SHARED MODULE. The widget is one self-contained
   <script> served to arbitrary storefronts with no build step, so it cannot import
   anything; the scanner is a Node process on Railway. The two need the SAME size-guide
   parser (a chart the widget reads live and the one the scanner stores must never
   disagree about what a "Half Chest" column is). Three options were weighed:

     · hand-maintained lockstep copy (CLAUDE.md §3's usual pattern) - drifts silently
       until someone notices, which is exactly what §3's table keeps recording;
     · the scanner slicing pear-widget.js at RUNTIME and eval'ing it - no copy at all,
       but production code would depend on comment markers resolving on every deploy,
       and an eval'd blob is unreadable in a stack trace;
     · THIS: the widget stays the single source of truth, the scanner gets a readable,
       importable file that is mechanically copied from it, and
       test/size-chart-parser-sync.test.mjs fails the suite if the copy is not
       byte-identical to the widget blocks (plus runs one fixture set through both).

   Usage:  npm run sync:size-chart-parser        (writes the file)
           node scripts/sync-size-chart-parser.mjs --check   (exit 1 if stale)
   ============================================================================= */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const WIDGET_URL = new URL("../widget/pear-widget.js", import.meta.url);
const READER_URL = new URL("../scanner/size-chart-reader.src.js", import.meta.url);
const OUT_URL = new URL("../scanner/size-chart-parser.js", import.meta.url);

/* The text strictly between the comment carrying `<name> BEGIN` and the comment
   `/* @pear-shared:<name> END *\/`. Exported for the sync test. */
export function sharedBlock(src, name) {
  const text = src.replace(/\r\n/g, "\n");
  const begin = text.indexOf(`@pear-shared:${name} BEGIN`);
  if (begin === -1) throw new Error(`widget: no "@pear-shared:${name} BEGIN" marker`);
  const bodyStart = text.indexOf("*/", begin);
  if (bodyStart === -1) throw new Error(`widget: unterminated BEGIN comment for ${name}`);
  const endMarker = `/* @pear-shared:${name} END */`;
  const end = text.indexOf(endMarker, bodyStart);
  if (end === -1) throw new Error(`widget: no "${endMarker}" marker`);
  if (text.indexOf(`@pear-shared:${name} BEGIN`, begin + 1) !== -1) {
    throw new Error(`widget: "@pear-shared:${name} BEGIN" appears twice`);
  }
  // From the line after the BEGIN comment closes to the start of the END line.
  const from = text.indexOf("\n", bodyStart) + 1;
  const to = text.lastIndexOf("\n", end) + 1;
  return text.slice(from, to);
}

export const EXPORTS = [
  "isPlausibleSizeToken", "SIZE_CHART_CLAMPS", "SIZE_CHART_MAX_TABLES",
  "sizeChartUnitFromText", "sizeChartMeasureKey", "sizeChartSizeToken",
  "sizeChartAliasKey", "sizeChartCellAliases", "parseMeasurementCell",
  "sizeChartGrid", "sizeChartOrient", "sizeChartColumnToCm", "sizeChartFromGrid",
  "sizeChartTableUnit", "SIZE_CHART_CONTAINERS", "extractSizeChart", "encodeSizeChart",
];

export function renderScannerParser(widgetSrc, readerSrc = readFileSync(READER_URL, "utf8")) {
  const token = sharedBlock(widgetSrc, "size-token");
  const parser = sharedBlock(readerSrc, "size-chart-parser");
  const hash = createHash("sha256").update(token + "\u0000" + parser).digest("hex").slice(0, 16);
  return `/* =============================================================================
   GENERATED FILE - DO NOT EDIT BY HAND.
   Source: widget/pear-widget.js's "@pear-shared:size-token" block and
   scanner/size-chart-reader.src.js's "@pear-shared:size-chart-parser" block.
   Regenerate with:
       npm run sync:size-chart-parser
   test/size-chart-parser-sync.test.mjs fails the suite when this file and its sources
   disagree by a single byte. Why it is a generated copy rather than a shared module:
   see scripts/sync-size-chart-parser.mjs.
   ============================================================================= */

/* The widget's parser, bound to one document. \`d\` is the only free variable the
   shared blocks are allowed to reference (plus console). In the scanner it is a jsdom
   document built from fetched HTML with scripts DISABLED - the same passive, read-only
   view the widget has of a live page. */
export function createSizeChartParser(d) {
${token}
${parser}
  return { ${EXPORTS.join(", ")} };
}

export const SHARED_BLOCK_HASH = "${hash}";
`;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = renderScannerParser(readFileSync(WIDGET_URL, "utf8"));
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(OUT_URL, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing */ }
    if (current !== out) {
      console.error("✗ scanner/size-chart-parser.js is stale - run: npm run sync:size-chart-parser");
      process.exit(1);
    }
    console.log("✓ scanner/size-chart-parser.js matches its sources");
  } else {
    writeFileSync(OUT_URL, out);
    console.log("✓ wrote scanner/size-chart-parser.js from the widget's token block + scanner/size-chart-reader.src.js");
  }
}
