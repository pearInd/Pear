#!/usr/bin/env node
/* =============================================================================
   Mutation check for the Phase 2 size-guide capture rules.
   -----------------------------------------------------------------------------
   A test that cannot fail proves nothing. For each KEY RULE below this script breaks
   the rule in a scratch copy of the sources (never the working tree), runs the suite
   that is supposed to guard it, and expects it to go RED. A mutation that stays green
   is a rule nobody is actually checking.

       node scripts/mutation-check-capture.mjs          (exit 1 if any mutation survives)

   The copy lives in ./.mutation-tmp (gitignored) so `node_modules` still resolves from
   the repo root, and is deleted afterwards.
   ============================================================================= */
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = join(ROOT, ".mutation-tmp");

const MUTATIONS = [
  ["image OCR never gets its confidence penalty", "scanner/size-charts.js",
    "SOURCE_CONFIDENCE_PENALTY = { image_ocr: 0.2,", "SOURCE_CONFIDENCE_PENALTY = { image_ocr: 0,", "image-chart-ocr"],
  ["the Gemini key travels in the URL", "scanner/image-charts.js",
    ":generateContent`, {", ":generateContent?key=${apiKey}`, {", "image-chart-ocr"],
  ["OCR values skip the shared clamps (chest max 2000)", "scanner/size-chart-parser.js",
    "chest: { min: 50, max: 200 },", "chest: { min: 50, max: 2000 },", "image-chart-ocr"],
  ["the browser may click 'add to bag'", "scanner/browser-capture.js",
    "  if (NEVER_CLICK_RE.test(t)) return false;\n", "", "browser-capture"],
  ["a guide is typed by the PRODUCT page's title", "scanner/browser-capture.js",
    "    if (guide) chart.classification = classifyChart(chart.rows, chart.localText, \"\", ref);", "", "browser-capture"],
  ["the guide's context walk escapes the dialog", "scanner/size-charts.js",
    "let sib = atBoundary ? null : node.previousElementSibling", "let sib = node.previousElementSibling", "browser-capture"],
  ["the browser never stops on a 403 wall", "scanner/browser-capture.js",
    "if (report.blocked.count >= 2 && report.pages_opened === 0) { report.status = \"blocked\"; break; }", "", "browser-capture"],
  ["the static stage never stops on a 403 wall", "scanner/size-charts.js",
    "if (refusedInARow >= 3) {", "if (refusedInARow >= 3000) {", "capture-flow"],
  ["a manual override accepts any value", "scanner/import-chart.js",
    "if (!allowed.includes(s)) throw", "if (false) throw", "manual-import"],
  /* Manual charts are store-wide twice over (no product URL AND a store-wide source), so
     one guard alone is an equivalent mutant: both are broken together - the realistic
     regression of tagging a manual chart with its source URL. */
  ["manual imports are product-scoped, not store-wide", [
    ["scanner/size-charts.js", "\"linked_page\", \"manual_url\", \"manual_html\", \"manual_image\"", "\"linked_page\""],
    ["scanner/import-chart.js", "({ chart, source, sourceUrl: pageUrl, productUrl: \"\" })", "({ chart, source, sourceUrl: pageUrl, productUrl: pageUrl })"],
  ], "manual-import"],
  ["a chart with no garment type is saved anyway", "scanner/size-charts.js",
    "    if (!cls.garmentType) {", "    if (false) {", "scanner-size-charts"],
  ["static banner hits are always OCR'd", "scanner/capture.js",
    "...(nothingYet || forceImages ? st.images", "...(true ? st.images", "capture-flow"],
  ["a conversion-only guide is reported as 'could not open'", "scanner/capture.js",
    "else if (browser && browser.report.unmeasured_guides) {", "else if (false) {", "capture-flow"],
];

rmSync(TMP, { recursive: true, force: true });
for (const d of ["scanner", "test", "widget", "lib", "fitting-room", "scripts", "archive"]) {
  cpSync(join(ROOT, d), join(TMP, d), { recursive: true, filter: (src) => !/[\\/]\.env/.test(src) && !/node_modules/.test(src) });
}
cpSync(join(ROOT, "package.json"), join(TMP, "package.json"));

let survived = 0;
const rows = [];
for (const m of MUTATIONS) {
  const [name, suite] = [m[0], m[m.length - 1]];
  const edits = Array.isArray(m[1]) ? m[1] : [[m[1], m[2], m[3]]];
  const saved = [];
  let missing = false;
  for (const [file, from, to] of edits) {
    const path = join(TMP, file);
    const orig = readFileSync(path, "utf8");
    const src = orig.replace(/\r\n/g, "\n");
    if (!src.includes(from)) { missing = true; break; }
    saved.push([path, orig]);
    writeFileSync(path, src.replace(from, to));
  }
  if (missing) { for (const [p, o] of saved) writeFileSync(p, o); rows.push(["?? anchor missing", name]); survived++; continue; }
  const r = spawnSync(process.execPath, [join(TMP, "test", suite + ".test.mjs")], { cwd: TMP, encoding: "utf8", timeout: 240000 });
  for (const [p, o] of saved) writeFileSync(p, o);
  const killed = r.status !== 0;
  if (!killed) survived++;
  rows.push([killed ? "KILLED  " : "SURVIVED", `${name}  (${suite})`]);
}
rmSync(TMP, { recursive: true, force: true });
for (const [k, n] of rows) console.log(`${k}  ${n}`);
console.log(survived ? `\n${survived} mutation(s) SURVIVED - a rule is not tested` : `\nall ${rows.length} mutations killed`);
process.exit(survived ? 1 : 0);
