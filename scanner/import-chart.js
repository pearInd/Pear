#!/usr/bin/env node
/* =============================================================================
   PEAR - MANUAL size-chart import: the guaranteed way in for any store
   -----------------------------------------------------------------------------
       npm run import:chart -- --host <store-host> (--url <page-or-image-url> |
                                                     --html <saved-page.html> |
                                                     --image <screenshot.png|jpg|webp>)
                               [--gender men|women|unisex|unknown] [--age adult|kids]
                               [--type tops|bottoms|jeans|dresses|outerwear]
                               [--only 1,3] [--dry-run] [--yes]

   For a store the automatic capture cannot read (bot-protected, a guide only a logged-in
   or human session sees, an image the OCR could not settle): open the guide yourself,
   then hand over its URL, the page saved with Ctrl+S, or a screenshot of the table.

   SAME PARSER, SAME VALIDATION, SAME SAVE as every other path: HTML goes through
   extractAllSizeCharts() (the shared widget parser), an image through Gemini ->
   image-charts.js -> the same parser, and the result through buildRecords() and
   saveSizeChartRecords(). The flags only LABEL what the parser accepted - who the chart
   is for, when the source does not say. They cannot add a row, change a number or
   rescue a table the parser refused; a value outside the enums is an error, not a
   guess. Manual charts are store-wide (product_key '').
   ============================================================================= */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractAllSizeCharts, buildRecords, saveSizeChartRecords, canonicalStoreHost, defaultFetchText, unwrapHtmlEnvelope } from "./size-charts.js";
import { loadScannerEnv, formatChartSummary, askYesNo, saveAndVerify } from "./capture-cli.js";

export const OVERRIDE_VALUES = {
  gender: ["men", "women", "unisex", "unknown"],
  age_group: ["adult", "kids"],
  garment_type: ["tops", "bottoms", "jeans", "dresses", "outerwear"],
};

/** Throws on a value outside the table's CHECK constraints - never coerces. */
export function validateOverrides(ov = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(OVERRIDE_VALUES)) {
    const v = ov[key];
    if (v == null || v === "") continue;
    const s = String(v).trim().toLowerCase();
    if (!allowed.includes(s)) throw new Error(`--${key === "age_group" ? "age" : key === "garment_type" ? "type" : key} must be one of ${allowed.join("|")} (got "${v}")`);
    out[key] = s;
  }
  return out;
}

/* A label the owner typed is stronger evidence than any context word: it replaces the
   classifier's answer for that field and takes back the confidence that field's
   uncertainty cost (classifyChart's own penalties: -0.25 unknown gender, -0.15 type
   from columns, -0.05 type from page). The rows are untouched. */
export function applyOverrides(cls, ov) {
  const next = { ...cls };
  let conf = cls.confidence;
  if (ov.gender) { if (cls.gender === "unknown" && ov.gender !== "unknown") conf += 0.25; next.gender = ov.gender; }
  if (ov.age_group) next.ageGroup = ov.age_group;
  if (ov.garment_type) {
    if (cls.typeFrom === "columns") conf += 0.15; else if (cls.typeFrom === "page") conf += 0.05;
    next.garmentType = ov.garment_type; next.typeFrom = "manual";
  }
  next.confidence = Math.round(Math.min(0.95, conf) * 100) / 100;
  return next;
}

/**
 * Import one source for one host. Pure over its injectables (fetchText, imageReader).
 * @returns {Promise<{host:string, records:Array<object>, report:object, notes:string[]}>}
 */
export async function importChart({ host, url = "", htmlFile = "", imageFile = "", overrides = {}, only = null,
  fetchText = defaultFetchText, imageReader = null, JSDOM = null, apiKey = process.env.GEMINI_API_KEY || "" } = {}) {
  const JSDOMCtor = JSDOM || (await import("jsdom")).JSDOM;
  const storeHost = canonicalStoreHost(host || (url ? new URL(url).hostname : ""));
  if (!storeHost) throw new Error("--host is required (the store's hostname, e.g. fox.co.il)");
  const sources = [url, htmlFile, imageFile].filter(Boolean).length;
  if (sources !== 1) throw new Error("give exactly one of --url, --html, --image");
  const ov = validateOverrides(overrides);
  const notes = [];
  let found = [];
  const readImage = async (src, source, sourceUrl) => {
    const read = imageReader || (await import("./image-charts.js")).chartsFromImage;
    const res = await read(src, { apiKey, JSDOM: JSDOMCtor, source, sourceUrl, context: "" });
    notes.push(`image: ${res.outcome} - ${res.detail}`);
    return res.found;
  };
  const readHtml = (html, pageUrl, source) => {
    const doc = new JSDOMCtor(html, { url: pageUrl }).window.document;
    return extractAllSizeCharts(doc, pageUrl).map((chart) => ({ chart, source, sourceUrl: pageUrl, productUrl: "" }));
  };

  if (imageFile) {
    found = await readImage({ file: imageFile }, "manual_image", "file:" + imageFile.split(/[\\/]/).pop());
  } else if (url) {
    const r = unwrapHtmlEnvelope(await fetchText(url));
    if (!r.ok) throw new Error(`could not fetch ${url}: ${r.error || "HTTP " + r.status}`);
    if (/^image\//i.test(r.contentType || "")) found = await readImage({ url }, "manual_image", url);
    else found = readHtml(r.text, r.url || url, "manual_url");
  } else {
    let text = await readFile(htmlFile, "utf8");
    const env = unwrapHtmlEnvelope({ ok: true, text });
    if (env.envelope) text = env.text;
    found = readHtml(text, `https://${storeHost}/`, "manual_html");
    for (const f of found) f.sourceUrl = "file:" + htmlFile.split(/[\\/]/).pop();
  }
  if (!found.length && !notes.length) notes.push("no table the shared parser accepts was found in that source");

  for (const f of found) f.chart.classification = applyOverrides(f.chart.classification, ov);
  const report = { charts: [], conflicts: [] };
  let records = buildRecords(found, storeHost, report);
  if (only && only.length) records = records.filter((_, i) => only.includes(i + 1));
  for (const c of report.conflicts) notes.push(c.reason + (c.source_url ? " - " + c.source_url : ""));
  return { host: storeHost, records, report, notes };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────── */
async function main(argv) {
  loadScannerEnv();
  const args = argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const flag = (f) => args.includes(f);
  let out;
  try {
    out = await importChart({
      host: val("--host"), url: val("--url") || "", htmlFile: val("--html") || "", imageFile: val("--image") || "",
      overrides: { gender: val("--gender"), age_group: val("--age"), garment_type: val("--type") },
      only: val("--only") ? val("--only").split(",").map((n) => parseInt(n, 10)).filter(Number.isFinite) : null,
    });
  } catch (e) {
    console.error("✗ " + e.message);
    console.error("Usage: npm run import:chart -- --host <host> (--url <url> | --html <file> | --image <file>) [--gender ..] [--age ..] [--type ..] [--only 1,2] [--dry-run] [--yes]");
    process.exit(2);
  }
  console.log(`═══ ${out.host}: ${out.records.length} chart(s) to import ═══`);
  console.log(formatChartSummary(out.records));
  for (const n of out.notes) console.log("  ! " + n);
  if (!out.records.length) {
    console.log("\nNothing importable. If the table has no audience/garment words, add --gender/--age/--type; " +
      "if it was refused for its values, the source is not a body-measurement chart the room can use.");
    return;
  }
  if (flag("--dry-run")) { console.log("\nDry run - nothing written."); return; }
  if (!(await askYesNo(`\nSave these ${out.records.length} chart(s) for ${out.host}?`, { assumeYes: flag("--yes") }))) {
    console.log("Not saved."); return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (scanner/.env) - nothing saved.");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  await saveAndVerify({ supabase, records: out.records, host: out.host, saveSizeChartRecords });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => { console.error("✗ import failed:", e?.message || e); process.exit(1); });
}
