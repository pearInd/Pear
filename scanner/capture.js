#!/usr/bin/env node
/* =============================================================================
   PEAR - ONE COMMAND: capture every size chart a store publishes
   -----------------------------------------------------------------------------
       npm run capture -- <store-url> [--browser | --no-browser] [--images | --no-images]
                                      [--max-products N] [--dry-run] [--yes]

   1. STATIC     size-charts.js: server HTML, linked guide pages, JSON envelopes.
   2. BROWSER    browser-capture.js, headless Chromium - automatically when static found
                 no chart, found size-guide triggers with no link, or saw a JS size app;
                 always with --browser, never with --no-browser.
   3. IMAGES     image-charts.js (Gemini, up to 4): images that APPEARED when a guide was
                 clicked, always; the static stage's image hits only when nothing else was
                 captured (or with --images) - they are word matches (delta: a banner, a logo).
   Then: one summary of every chart, y/n, save (the Phase 1 save path), and a read-back
   of GET /api/store-size-chart. Nothing found -> one line saying why, plus the manual
   import command.

   EVERY STAGE FEEDS ONE LIST of extractAllSizeCharts() findings into buildRecords() -
   the same parser, plausibility checks, classification, keys and save as Phase 1.
   ============================================================================= */
import { pathToFileURL } from "node:url";
import { discoverSizeCharts, buildRecords, saveSizeChartRecords, formatReport, canonicalStoreHost } from "./size-charts.js";
import { loadScannerEnv, formatChartSummary, askYesNo, reasonLine, saveAndVerify } from "./capture-cli.js";

const MAX_IMAGES = 4;
const IMAGE_DELAY_MS = 5000;   // Gemini free tier is 15 req/min

/** Does the static result call for a real browser? Exported for tests. */
export function browserFallbackReason(staticResult) {
  const r = staticResult.report;
  if (r.outcome === "unreachable") return null;   // nothing a browser would fix
  if (!staticResult.records.length) return "static capture found no chart";
  if (r.paths.js_app_detected.triggers_without_link > 0) return `${r.paths.js_app_detected.triggers_without_link} size-guide trigger(s) with no link`;
  if (r.paths.js_app_detected.apps.length) return "JS size app detected: " + r.paths.js_app_detected.apps.join(", ");
  return null;
}

/**
 * The whole flow minus the y/n and the save. Every stage is injectable for tests.
 * @returns {Promise<{host, records, found, report, browser, imageResults, reason}>}
 *   reason: null when charts were captured, else {kind, extra} for reasonLine()
 */
export async function runCapture(storeUrl, {
  forceBrowser = false, noBrowser = false, noImages = false, forceImages = false, maxProducts = 12, log = console.log,
  discover = discoverSizeCharts, browserCapture = null, imageReader = null, JSDOM = null,
  apiKey = process.env.GEMINI_API_KEY || "", imageDelayMs = IMAGE_DELAY_MS,
} = {}) {
  const JSDOMCtor = JSDOM || (await import("jsdom")).JSDOM;
  const host = canonicalStoreHost(new URL(storeUrl).hostname);
  log(`── 1/3 static capture: ${storeUrl}`);
  const st = await discover(storeUrl, { maxProducts, log, JSDOM: JSDOMCtor });
  log(formatReport(st.report));
  const found = st.found.slice();

  let browser = null;
  const why = forceBrowser ? "forced with --browser" : noBrowser ? null : browserFallbackReason(st);
  if (why) {
    log(`\n── 2/3 browser fallback (${why})`);
    const run = browserCapture || (await import("./browser-capture.js")).captureWithBrowser;
    browser = await run(storeUrl, { productUrls: st.products, maxPages: Math.min(6, maxProducts), log, JSDOM: JSDOMCtor });
    found.push(...browser.found);
  } else {
    log(`\n── 2/3 browser fallback: not needed${noBrowser ? " (--no-browser)" : ""}`);
  }

  /* Images that APPEARED when a guide was clicked are high-precision and always read.
     The static stage's image hits are word/container matches (delta.co.il: a banner and a
     logo) - read only when nothing else was captured, so a store with real tables does
     not spend Gemini calls on its banners. */
  const nothingYet = !found.length;
  const imageResults = [];
  const imageUrls = [
    ...(nothingYet || forceImages ? st.images.map((url) => ({ url, productUrl: "" })) : []),
    ...(browser ? browser.images : []),
  ].filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i);
  if (imageUrls.length && !noImages) {
    log(`\n── 3/3 image charts: ${imageUrls.length} found, reading up to ${MAX_IMAGES} with Gemini`);
    const read = imageReader || (await import("./image-charts.js")).chartsFromImage;
    let n = 0;
    for (const img of imageUrls) {
      if (/\.pdf(?:$|[?#])/i.test(img.url)) {
        imageResults.push({ url: img.url, outcome: "error", detail: "PDF chart - not read automatically; screenshot it and use --image" });
        continue;
      }
      if (n++ >= MAX_IMAGES) break;
      if (n > 1 && imageDelayMs) await new Promise((r) => setTimeout(r, imageDelayMs));
      const res = await read({ url: img.url }, { apiKey, JSDOM: JSDOMCtor, source: "image_ocr", productUrl: img.productUrl,
        sourceUrl: img.url, context: img.productUrl ? "" : img.url,
        referrerText: img.productUrl ? (img.context || "") : null });
      imageResults.push({ url: img.url, outcome: res.outcome, detail: res.detail });
      log(`  ${res.outcome === "read" ? "✓" : "✗"} ${img.url} - ${res.detail}`);
      found.push(...res.found);
    }
  } else {
    const skippedStatic = st.images.length && !nothingYet && !forceImages
      ? ` (${st.images.length} static image hit(s) not read - charts already captured; --images to read them)` : "";
    log(`\n── 3/3 image charts: ${imageUrls.length ? "skipped (--no-images)" : "none found"}${skippedStatic}`);
  }

  const report = { ...st.report, charts: [], conflicts: [] };
  const records = buildRecords(found, host, report);

  let reason = null;
  if (!records.length) {
    const staticBlocked = st.report.outcome === "blocked_by_bot_protection";
    const browserBlocked = browser && browser.report.status === "blocked";
    const jsSignals = st.report.paths.js_app_detected.triggers_without_link || st.report.paths.js_app_detected.apps.length;
    if (st.report.outcome === "unreachable") reason = { kind: "unreachable", extra: st.report.errors[0] || "" };
    else if (browser && browser.report.status === "browser_unavailable") reason = { kind: "browser_unavailable", extra: browser.report.errors[0] };
    else if ((staticBlocked && (!browser || browserBlocked)) || (browserBlocked && !st.found.length)) {
      reason = { kind: "blocked", extra: [st.report.blocked.examples[0], browser && browser.report.blocked.examples[0]].filter(Boolean).join("; ") || st.report.errors[0] || "" };
    } else if (imageResults.length) reason = { kind: "image_unreadable", extra: imageResults.map((i) => i.detail).join("; ").slice(0, 200) };
    else if (browser && browser.report.unmeasured_guides) {
      reason = { kind: "no_measurements", extra: `${browser.report.unmeasured_guides} guide(s) opened, e.g. ${browser.report.unmeasured_examples[0]}` };
    } else if (browser && browser.report.pages_opened && !browser.report.triggers_clicked && !browser.report.network_payloads && !jsSignals) {
      /* yanga.co.il: rendered pages, no size-guide control anywhere - that is "no guide",
         not "a JS guide we failed to open". */
      reason = { kind: "none", extra: `static: ${st.report.sampled_products} product page(s); browser: ${browser.report.pages_opened} rendered page(s) with no size-guide control` };
    } else if (browser || jsSignals) {
      reason = { kind: "js_unreadable", extra: browser ? `${browser.report.pages_opened} page(s), ${browser.report.triggers_clicked} trigger(s) clicked` : "browser not run" };
    } else reason = { kind: "none", extra: `${st.report.sampled_products} product page(s) sampled` };
  }
  return { host, records, found, report, browser, imageResults, reason, staticReport: st.report };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────── */
async function main(argv) {
  loadScannerEnv();
  const args = argv.slice(2);
  const flag = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const storeUrl = args.find((a) => /^https?:\/\//i.test(a));
  if (!storeUrl) {
    console.error("Usage: npm run capture -- <store-url> [--browser|--no-browser] [--images|--no-images] [--max-products N] [--dry-run] [--yes]");
    process.exit(2);
  }
  const out = await runCapture(storeUrl, {
    forceBrowser: flag("--browser"), noBrowser: flag("--no-browser"), noImages: flag("--no-images"), forceImages: flag("--images"),
    maxProducts: Math.max(1, Math.min(50, parseInt(val("--max-products"), 10) || 12)),
  });
  console.log(`\n═══ ${out.host}: ${out.records.length} chart(s) found ═══`);
  console.log(formatChartSummary(out.records));
  for (const c of out.report.conflicts) console.log(`  ! ${c.reason}${c.source_url ? " - " + c.source_url : ""}`);
  console.log("CAPTURE_JSON " + JSON.stringify({
    host: out.host, platform: out.staticReport.platform, static: out.staticReport.outcome,
    browser: out.browser ? { status: out.browser.report.status, pages: out.browser.report.pages_opened,
      triggers: out.browser.report.triggers_clicked, tabs: out.browser.report.tabs_clicked,
      payloads: out.browser.report.network_payloads, methods: out.browser.report.methods, blocked: out.browser.report.blocked.count } : null,
    images: out.imageResults.map((i) => i.outcome),
    charts: out.records.map((r) => `${r.gender}/${r.age_group}/${r.garment_type}/${r.size_system}:${r.rows.map((x) => x.size).join("/")}@${r.source}${r.product_key ? "(product)" : ""}`),
    reason: out.reason ? out.reason.kind : null,
  }));
  if (!out.records.length) {
    console.log("\n" + reasonLine(out.reason.kind, out.host, out.reason.extra));
    return;
  }
  if (flag("--dry-run")) { console.log("\nDry run - nothing written."); return; }
  if (!(await askYesNo(`\nSave these ${out.records.length} chart(s) for ${out.host}?`, { assumeYes: flag("--yes") }))) {
    console.log("Not saved.");
    return;
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
  main(process.argv).catch((e) => { console.error("✗ capture failed:", e?.message || e); process.exit(1); });
}
