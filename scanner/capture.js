#!/usr/bin/env node
/* =============================================================================
   PEAR - ONE COMMAND: capture every size chart a store publishes
   -----------------------------------------------------------------------------
       npm run capture -- <store-url> [--browser | --no-browser] [--images | --no-images]
                                      [--max-products N] [--dry-run] [--yes]

   1. STATIC     size-charts.js: server HTML, linked guide pages, JSON envelopes.
   2. BROWSER    browser-capture.js, headless Chromium - automatically when static found
                 no chart, found size-guide triggers with no link, or saw a JS size app;
                 always with --browser, never with --no-browser - and never, not even with
                 --browser, at a store that refused the static stage (that is BLOCKED).
                 A browser stage that throws is browser_unavailable; static's charts stay.
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
  /* REFUSED is an answer, not a gap a browser fills. The first cut returned "static found no
     chart" here (a refusal never has records), so headless Chromium - another client, no
     longer named PEAR-StoreScanner, running the challenge page's own JS - went back to the
     very home page / product pages that had just answered 403, against browser-capture.js's
     "reported as BLOCKED and the run stops for that store". runCapture() holds it against
     --browser too. */
  if (r.outcome === "blocked_by_bot_protection" || r.polite_stop) return null;
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
  /* REFUSED also covers a store that answered some pages and then said no: the static
     stage's POLITE STOP (three refusals in a row) leaves an outcome like js_app_detected
     when it saw a trigger first, and the browser used to receive every sampled URL - the
     ones that had just answered 429 included. A store that began refusing is not asked
     again by another client; isolated refusals only drop those URLs from the browser's list. */
  const staticRefused = st.report.outcome === "blocked_by_bot_protection" || !!st.report.polite_stop;
  const refusedUrls = new Set(st.report.refused_urls || []);
  const why = staticRefused ? null : forceBrowser ? "forced with --browser" : noBrowser ? null : browserFallbackReason(st);
  if (why) {
    log(`\n── 2/3 browser fallback (${why})`);
    /* A THROW HERE IS A FAILED BROWSER STAGE, NOT A FAILED RUN. Uncaught, it reached main()'s
       "capture failed" exit and took the static stage's charts and the image stage with it -
       a page.content() caught mid-navigation after a trigger click, or a missing playwright
       package, discarded two valid linked-page charts. It is reported as browser_unavailable
       with its message; whatever static captured is still summarised and offered for save. */
    try {
      const run = browserCapture || (await import("./browser-capture.js")).captureWithBrowser;
      browser = await run(storeUrl, { productUrls: st.products.filter((u) => !refusedUrls.has(u)), maxPages: Math.min(6, maxProducts), log, JSDOM: JSDOMCtor });
    } catch (e) {
      const msg = "browser fallback failed: " + String((e && e.message) || e).split("\n")[0];
      log(`  ✗ ${msg}`);
      browser = { found: [], images: [], report: { status: "browser_unavailable", pages_opened: 0, pages_failed: 0,
        triggers_clicked: 0, tabs_clicked: 0, unmeasured_guides: 0, unmeasured_examples: [], network_payloads: 0,
        blocked: { count: 0, examples: [] }, errors: [msg], methods: {} } };
    }
    found.push(...browser.found);
  } else if (staticRefused) {
    log(`\n── 2/3 browser fallback: not run - the store refused the static capture${st.report.polite_stop ? " (it began refusing mid-run)" : ""}${forceBrowser ? " (--browser ignored)" : ""}; ` +
      "a refusal is reported as BLOCKED, never retried with a browser");
  } else {
    log(`\n── 2/3 browser fallback: not needed${noBrowser ? " (--no-browser)" : ""}`);
  }

  /* Images that APPEARED when a guide was clicked are high-precision and always read.
     The static stage's image hits are word/container matches (delta.co.il: a banner and a
     logo) - read only when nothing else was captured, so a store with real tables does
     not spend Gemini calls on its banners.
     "Captured" means a RECORD buildRecords would keep, not a raw finding: a lone "Suits"
     table (no garment type - never stored) used to count, so the store's real image chart
     was skipped and the run said "NO SIZE GUIDE FOUND". A throwaway report, so the real
     one below does not count its conflicts twice. */
  const nothingYet = !buildRecords(found, host, { charts: [], conflicts: [] }).length;
  const imageResults = [];
  /* WHERE each image was seen decides its scope, as for a table (size-charts.js, STORE-WIDE
     vs PRODUCT-SCOPED). Every hit carries `pages`: the browser's are every product page the
     image appeared on (one entry per image, so a guide image opened from all six PDPs used
     to reach buildRecords tagged with the first PDP alone - product-scoped, never served);
     a static hit is its single PDP when the static stage saw it on exactly one, else ""
     (a guide page, a linked PDF/image, or 2+ PDPs - the store's chart). A static result
     without `imagePages` keeps the old store-wide "". `static` keeps the read's context as
     before: the image URL's own words for a static hit, the referrer text for a browser one. */
  const staticImg = (url) => {
    const pg = st.imagePages ? (st.imagePages[url] || []).filter((p, i, a) => a.indexOf(p) === i) : [];
    const productUrl = pg.length === 1 && pg[0] ? pg[0] : "";
    return { url, productUrl, pages: [productUrl], static: true };
  };
  const imageUrls = [];
  for (const img of [
    ...(nothingYet || forceImages ? st.images.map(staticImg) : []),
    ...(browser ? browser.images : []),
  ]) {
    const pages = img.pages && img.pages.length ? img.pages : [img.productUrl || ""];
    const prev = imageUrls.find((x) => x.url === img.url);
    if (!prev) imageUrls.push({ ...img, pages: pages.slice() });
    else for (const p of pages) if (!prev.pages.includes(p)) prev.pages.push(p);
  }
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
        sourceUrl: img.url, context: img.static ? img.url : "",
        referrerText: img.static ? null : (img.context || "") });
      imageResults.push({ url: img.url, outcome: res.outcome, detail: res.detail });
      log(`  ${res.outcome === "read" ? "✓" : "✗"} ${img.url} - ${res.detail}`);
      /* Read once, sighted once per page: buildRecords counts the pages and makes 2+ the
         store's chart. A "" page is store-wide evidence on its own (a guide page). */
      const pages = img.pages.includes("") ? [""] : img.pages;
      for (const f of res.found) for (const p of pages) found.push({ ...f, productUrl: p });
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
    const staticBlocked = staticRefused;
    const browserBlocked = browser && browser.report.status === "blocked";
    const jsSignals = st.report.paths.js_app_detected.triggers_without_link || st.report.paths.js_app_detected.apps.length;
    const browserUnavailable = browser && browser.report.status === "browser_unavailable";
    /* BLOCKED BEFORE BROWSER_UNAVAILABLE: a browser that never launched has not contradicted
       the static refusal. The other order told the owner of a store that had just answered
       403 to "install Chromium" - and the --url manual path that line offers goes through the
       same plain fetch the store refused. */
    if (st.report.outcome === "unreachable") reason = { kind: "unreachable", extra: st.report.errors[0] || "" };
    else if ((staticBlocked && (!browser || browserBlocked || browserUnavailable)) || (browserBlocked && !st.found.length)) {
      reason = { kind: "blocked", extra: [st.report.blocked.examples[0], browser && browser.report.blocked.examples[0]].filter(Boolean).join("; ") || st.report.errors[0] || "" };
    } else if (browserUnavailable) reason = { kind: "browser_unavailable", extra: browser.report.errors[0] };
    else if (imageResults.length) reason = { kind: "image_unreadable", extra: imageResults.map((i) => i.detail).join("; ").slice(0, 200) };
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
