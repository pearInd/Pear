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
    "if (++refusedInARow >= 2) {", "if (++refusedInARow >= 2000) {", "browser-capture"],
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
    "...(nothingYet || forceImages ? staticImages", "...(true ? staticImages", "capture-flow"],
  ["a store that began refusing is re-asked by the browser", "scanner/capture.js",
    "st.report.outcome === \"blocked_by_bot_protection\" || !!st.report.polite_stop || everyProductRefused;", "st.report.outcome === \"blocked_by_bot_protection\" || everyProductRefused;", "capture-flow"],
  ["a store that refused every sampled product page is re-asked by the browser", "scanner/capture.js",
    " || !!st.report.polite_stop || everyProductRefused;", " || !!st.report.polite_stop;", "capture-flow"],
  ["a store that refused us is still asked for the images on its own host", "scanner/capture.js",
    "const staticImages = staticRefused ? st.images.filter((u) => !onStoreHost(u)) : st.images;", "const staticImages = st.images;", "capture-flow"],
  ["a guessed guide path's 403 counts as the store refusing us", "scanner/size-charts.js",
    "if (!guessed.has(gUrl)) { noteRefusal(isRefusal(r), gUrl); continue; }", "{ noteRefusal(isRefusal(r), gUrl); continue; }", "scanner-size-charts"],
  ["--only=1 (the equals form) is read as no --only", "scanner/capture-cli.js",
    "const m = /^(--[\\w-]+)=([\\s\\S]*)$/.exec(a);", "const m = null;", "manual-import"],
  ["a conversion-only guide is reported as 'could not open'", "scanner/capture.js",
    "else if (browser && browser.report.unmeasured_guides) {", "else if (false) {", "capture-flow"],
  ["an untyped table (suits) gets no number - it cannot be imported alone", "scanner/import-chart.js",
    "n: twin ? twin.n : ++total,", "n: twin ? twin.n : (c.garmentType ? ++total : 0),", "manual-import"],
  /* Either guard alone catches Debut/Brooklyn (each wraps <main> AND the page's only h1), so
     one alone is an equivalent mutant: both go together - "any boundary match is a guide". */
  ["a theme's page wrapper (drawer-page-content) is taken for a guide dialog", [
    ["scanner/import-chart.js", "        !box.matches(\"main,[role=main]\") && !box.querySelector(\"main,[role=main]\") &&\n", ""],
    ["scanner/import-chart.js", "\n        !(h1s.length && h1s.every((h) => box.contains(h)));", " true;"],
  ], "manual-import"],
  /* In-page JavaScript: only a real Chromium runs it (browser-capture §5). "@chromium" -
     where none launches the suite SKIPs §5, and the mutation is reported SKIPPED, never
     counted as killed. */
  ["a guide hidden by CSS (it keeps its box) reads as already visible", "scanner/browser-capture.js",
    "  if (r.width <= minW || r.height <= minH) return false;\n", "  if (r.width <= minW || r.height <= minH) return false;\n  return true;\n", "browser-capture@chromium"],
];

rmSync(TMP, { recursive: true, force: true });
for (const d of ["scanner", "test", "widget", "lib", "fitting-room", "scripts", "archive"]) {
  cpSync(join(ROOT, d), join(TMP, d), { recursive: true, filter: (src) => !/[\\/]\.env/.test(src) && !/node_modules/.test(src) });
}
cpSync(join(ROOT, "package.json"), join(TMP, "package.json"));

let survived = 0;
const rows = [];
for (const m of MUTATIONS) {
  const [name, suiteSpec] = [m[0], m[m.length - 1]];
  const [suite, needs] = suiteSpec.split("@");
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
  /* Restored last edit first: two edits may share a file, and each saved copy is the file
     as it stood BEFORE that edit - forward order would leave the first edit in place. */
  const restore = () => { for (const [p, o] of [...saved].reverse()) writeFileSync(p, o); };
  if (missing) { restore(); rows.push(["?? anchor missing", name]); survived++; continue; }
  const r = spawnSync(process.execPath, [join(TMP, "test", suite + ".test.mjs")], { cwd: TMP, encoding: "utf8", timeout: 240000 });
  restore();
  const killed = r.status !== 0;
  if (!killed && needs === "chromium" && /SKIP\s+§5 Chromium unavailable/.test(r.stdout || "")) {
    rows.push(["SKIPPED ", `${name}  (${suite} - needs Chromium: npx playwright install chromium)`]);
    continue;
  }
  if (!killed) survived++;
  rows.push([killed ? "KILLED  " : "SURVIVED", `${name}  (${suite})`]);
}
rmSync(TMP, { recursive: true, force: true });
for (const [k, n] of rows) console.log(`${k}  ${n}`);
const skipped = rows.filter(([k]) => k.startsWith("SKIPPED")).length;
console.log(survived ? `\n${survived} mutation(s) SURVIVED - a rule is not tested`
  : `\nall ${rows.length - skipped} mutations killed` + (skipped ? ` (${skipped} skipped - no Chromium here)` : ""));
process.exit(survived ? 1 : 0);
