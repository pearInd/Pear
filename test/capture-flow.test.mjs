/* PHASE 2 - THE ONE-COMMAND FLOW (scanner/capture.js + capture-cli.js)
   ─────────────────────────────────────────────────────────────────────────────
   §1 WHEN THE BROWSER RUNS: static found nothing / triggers with no link / a JS size
      app -> yes; static captured cleanly -> no; --browser / --no-browser win.
   §2 ONE LIST, ONE buildRecords: static, browser and image findings merge into the same
      records (same keys, same validation); a chart the parser refused never appears.
   §3 NOTHING FOUND -> ONE REASON + THE MANUAL COMMAND: blocked / image unreadable / JS
      guide not opened / no guide / unreachable.
   §4 THE HUMAN END: summary text, y/n never auto-saves off a TTY, the live read-back.
   §5 POLITE STATIC STOP: three refusals in a row and the static stage stops asking.
   §6 A BROWSER STAGE THAT THROWS is browser_unavailable - the static charts survive.
   ============================================================================= */
import { JSDOM } from "jsdom";
import { runCapture, browserFallbackReason } from "../scanner/capture.js";
import { formatChartSummary, askYesNo, reasonLine, fetchLiveCharts, liveCoverage } from "../scanner/capture-cli.js";
import { extractAllSizeCharts, discoverSizeCharts } from "../scanner/size-charts.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const TABLE = (head) => `<h3>${head}</h3><table><tr><th>Size</th><th>Chest</th></tr>
  <tr><td>S</td><td>88-94</td></tr><tr><td>M</td><td>95-101</td></tr><tr><td>L</td><td>102-108</td></tr></table>`;
const finding = (head, source, productUrl = "") => extractAllSizeCharts(new JSDOM(TABLE(head)).window.document, "https://shop.example.com/g")
  .map((chart) => ({ chart, source, sourceUrl: "https://shop.example.com/g", productUrl }));
const staticResult = ({ found = [], triggers = 0, apps = [], outcome = null, images = [], imagePages, blocked = 0, errors = [], records } = {}) => ({
  report: { outcome: outcome || (found.length ? "captured" : "none_found"), platform: "html", sampled_products: 4, errors,
    blocked: { count: blocked, examples: blocked ? ["https://shop.example.com/p (challenge)"] : [] },
    paths: { js_app_detected: { triggers_without_link: triggers, apps }, image_chart_detected: { count: images.length, examples: images },
      linked_page: {}, inline_table: {}, product_description: {} }, charts: [], conflicts: [] },
  records: records || (found.length ? [{}] : []), found, products: ["https://shop.example.com/products/a"], images,
  ...(imagePages ? { imagePages } : {}),
});
const quiet = () => {};
const runWith = (st, extra = {}) => {
  const calls = { browser: 0, images: 0 };
  return runCapture("https://www.shop.example.com", {
    log: quiet, JSDOM, imageDelayMs: 0, apiKey: "k",
    discover: async () => st,
    browserCapture: async () => { calls.browser++; return extra.browser || { found: [], images: [], report: { status: "ok", pages_opened: 2, triggers_clicked: 1, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 0, examples: [] }, errors: [] } }; },
    /* Tags its findings with the productUrl it was asked for, as chartsFromImage() does. */
    imageReader: async (src, o = {}) => {
      calls.images++;
      const r = extra.image || { found: [], outcome: "not_a_chart", detail: "Gemini: not a size chart" };
      return { ...r, found: r.found.map((f) => ({ ...f, productUrl: o.productUrl || "" })) };
    },
    ...extra.opts,
  }).then((out) => ({ ...out, calls }));
};

console.log("\n── §1 when the browser runs ──");
{
  check("§1.1 static captured, no triggers, no app -> no browser", browserFallbackReason(staticResult({ found: finding("Men", "linked_page") })) === null);
  check("§1.2 static found nothing -> browser", /no chart/.test(browserFallbackReason(staticResult())));
  check("§1.3 triggers with no link -> browser even with a chart", /trigger/.test(browserFallbackReason(staticResult({ found: finding("Men", "linked_page"), triggers: 5 }))));
  check("§1.4 a JS size app -> browser", /JS size app/.test(browserFallbackReason(staticResult({ found: finding("Men", "linked_page"), apps: ["kiwisizing"] }))));
  check("§1.5 unreachable -> no browser (nothing it could fix)", browserFallbackReason(staticResult({ outcome: "unreachable" })) === null);
  const a = await runWith(staticResult({ found: finding("Men", "linked_page") }), { opts: { forceBrowser: true } });
  check("§1.6 --browser forces it", a.calls.browser === 1);
  const b = await runWith(staticResult(), { opts: { noBrowser: true } });
  check("§1.7 --no-browser suppresses it", b.calls.browser === 0);
  /* A refusal is an answer: Chromium (another client, running the challenge's JS) used to be
     sent back at the very pages that had just answered 403. */
  check("§1.8 static refused (blocked_by_bot_protection) -> no browser",
    browserFallbackReason(staticResult({ outcome: "blocked_by_bot_protection", blocked: 3 })) === null);
  const said = [];
  const c = await runWith(staticResult({ outcome: "blocked_by_bot_protection", blocked: 3 }), { opts: { forceBrowser: true, log: (m) => said.push(m) } });
  check("§1.9 ...not even with --browser, and the run says why", c.calls.browser === 0 && c.browser === null &&
    said.some((m) => /not run - the store refused the static capture \(--browser ignored\)/.test(m)), JSON.stringify(said.filter((m) => /2\/3/.test(m))));
  /* The static POLITE STOP after a trigger: outcome js_app_detected, but the store began
     refusing - the browser used to get every sampled URL, the 429s included. */
  const stopped = staticResult({ outcome: "js_app_detected", triggers: 2, blocked: 3 });
  stopped.report.polite_stop = true;
  check("§1.10 the static stage's polite stop (store began refusing) -> no browser", browserFallbackReason(stopped) === null);
  const d = await runWith(stopped, { opts: { forceBrowser: true } });
  check("§1.11 ...not even with --browser, and nothing found reads BLOCKED", d.calls.browser === 0 && d.reason && d.reason.kind === "blocked",
    JSON.stringify({ browser: d.calls.browser, reason: d.reason }));
  /* Isolated refusals (no stop): the browser is not sent back to the URLs that refused. */
  const partial = staticResult({ outcome: "js_app_detected", triggers: 2, blocked: 1 });
  partial.products = ["https://shop.example.com/products/a", "https://shop.example.com/products/b", "https://shop.example.com/products/c"];
  partial.report.refused_urls = ["https://shop.example.com/products/b"];
  let asked = null;
  await runWith(partial, { opts: { browserCapture: async (_u, o) => { asked = o.productUrls; return { found: [], images: [], report: { status: "ok", pages_opened: 2, triggers_clicked: 0, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 0, examples: [] }, errors: [] } }; } } });
  check("§1.12 a URL that refused the static stage is not handed to the browser", JSON.stringify(asked) ===
    JSON.stringify(["https://shop.example.com/products/a", "https://shop.example.com/products/c"]), JSON.stringify(asked));
}

console.log("\n── §2 one list, one buildRecords ──");
{
  const br = { found: finding("Women", "browser_modal", "https://shop.example.com/products/a"), images: [{ url: "https://cdn/x.png", productUrl: "https://shop.example.com/products/a" }],
    report: { status: "ok", pages_opened: 1, triggers_clicked: 1, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 0, examples: [] }, errors: [] } };
  const img = { found: finding("Kids", "image_ocr"), outcome: "read", detail: "1 chart" };
  const out = await runWith(staticResult({ found: finding("Men", "linked_page"), triggers: 3 }), { browser: br, image: img });
  const by = Object.fromEntries(out.records.map((r) => [r.source, r]));
  check("§2.1 static + browser + image -> three records through the same buildRecords",
    out.records.length === 3 && by.linked_page && by.browser_modal && by.image_ocr, JSON.stringify(out.records.map((r) => [r.source, r.gender, r.age_group])));
  check("§2.2 each keeps Phase 1's keys (gender/age/type/system) and the method as `source`",
    by.linked_page.gender === "men" && by.browser_modal.gender === "women" && by.image_ocr.age_group === "kids" &&
    out.records.every((r) => r.garment_type === "tops" && r.size_system === "alpha"));
  check("§2.3 a single-PDP browser chart is product-scoped; a guide page chart is store-wide",
    by.browser_modal.product_key === "https://shop.example.com/products/a" && by.linked_page.product_key === "");
  check("§2.4 image OCR is lower confidence than the same chart from markup", by.image_ocr.confidence < by.linked_page.confidence);
  check("§2.5 no reason when something was captured", out.reason === null);
  const banners = await runWith(staticResult({ found: finding("Men", "linked_page"), images: ["https://shop.example.com/banner.jpg"] }));
  check("§2.7 static image hits are NOT sent to Gemini when charts were already captured (delta's banner/logo)",
    banners.calls.images === 0 && banners.records.length === 1);
  const forced = await runWith(staticResult({ found: finding("Men", "linked_page"), images: ["https://shop.example.com/chart.jpg"] }), { opts: { forceImages: true } });
  check("§2.8 ...unless --images", forced.calls.images === 1);
  const onlyImg = await runWith(staticResult({ images: ["https://shop.example.com/chart.jpg"] }), { opts: { noBrowser: true } });
  check("§2.9 ...and always when nothing else was captured", onlyImg.calls.images === 1);
  const pdf = await runWith(staticResult({ images: ["https://shop.example.com/size.pdf"] }));
  check("§2.6 a PDF chart is not sent to the model (reported instead)", pdf.calls.images === 0 && pdf.imageResults[0] && /PDF/.test(pdf.imageResults[0].detail));

  /* WHERE an image was seen scopes it, as for a table: the browser's one entry per image used
     to carry its first PDP alone (a guide image opened from every PDP stayed product-scoped,
     never served), and every static hit was store-wide (a one-PDP chart became the store's). */
  const PA = "https://shop.example.com/products/a", PB = "https://shop.example.com/products/b";
  const kids = { found: finding("Kids", "image_ocr"), outcome: "read", detail: "1 chart" };
  const brImg = (img) => ({ found: [], images: [img], report: { status: "ok", pages_opened: 2, triggers_clicked: 2, tabs_clicked: 0,
    network_payloads: 0, methods: {}, blocked: { count: 0, examples: [] }, errors: [] } });
  const two = await runWith(staticResult(), { browser: brImg({ url: "https://cdn/guide.png", productUrl: PA, pages: [PA, PB], context: "Size guide" }), image: kids });
  check("§2.10 a browser image seen on 2 product pages -> OCR'd once, ONE store-wide record (2 sightings)",
    two.calls.images === 1 && two.records.length === 1 && two.records[0].product_key === "" && two.records[0].sightings === 2,
    JSON.stringify(two.records.map((r) => [r.product_key, r.sightings])));
  const one = await runWith(staticResult(), { browser: brImg({ url: "https://cdn/guide.png", productUrl: PA, pages: [PA], context: "Size guide" }), image: kids });
  check("§2.11 ...seen on 1 product page -> product-scoped", one.records.length === 1 && one.records[0].product_key === PA,
    JSON.stringify(one.records.map((r) => r.product_key)));
  const old = await runWith(staticResult(), { browser: brImg({ url: "https://cdn/guide.png", productUrl: PA, context: "Size guide" }), image: kids });
  check("§2.12 ...an entry without `pages` falls back to its productUrl", old.records.length === 1 && old.records[0].product_key === PA);
  const asked = [];
  const reader = async (src, o) => { asked.push({ url: src.url, productUrl: o.productUrl, context: o.context, referrerText: o.referrerText }); return kids; };
  const onePdp = await runWith(staticResult({ images: ["https://shop.example.com/img/size-chart.png"], imagePages: { "https://shop.example.com/img/size-chart.png": [PA] } }),
    { opts: { noBrowser: true, imageReader: reader } });
  check("§2.13 a static image seen on exactly ONE product page stays product-scoped (and is still read with its URL as context)",
    onePdp.records.length === 1 && onePdp.records[0].product_key === PA && asked[0] && asked[0].context === "https://shop.example.com/img/size-chart.png" &&
    asked[0].referrerText === null, JSON.stringify([onePdp.records.map((r) => r.product_key), asked]));
  const guideImg = await runWith(staticResult({ images: ["https://shop.example.com/g.png"], imagePages: { "https://shop.example.com/g.png": [""] } }), { opts: { noBrowser: true }, image: kids });
  const twoPdp = await runWith(staticResult({ images: ["https://shop.example.com/g.png"], imagePages: { "https://shop.example.com/g.png": [PA, PB] } }), { opts: { noBrowser: true }, image: kids });
  const mixed = await runWith(staticResult({ images: ["https://shop.example.com/g.png"], imagePages: { "https://shop.example.com/g.png": [PA, ""] } }), { opts: { noBrowser: true }, image: kids });
  check("§2.14 ...seen on a guide page, on 2+ product pages, or on both -> store-wide",
    [guideImg, twoPdp, mixed].every((o) => o.records.length === 1 && o.records[0].product_key === ""),
    JSON.stringify([guideImg, twoPdp, mixed].map((o) => o.records.map((r) => r.product_key))));
  const noMap = await runWith(staticResult({ images: ["https://shop.example.com/g.png"] }), { opts: { noBrowser: true }, image: kids });
  check("§2.15 ...a static result without imagePages keeps the old store-wide scope", noMap.records.length === 1 && noMap.records[0].product_key === "");
  const merged = await runWith(staticResult({ images: ["https://cdn/guide.png"], imagePages: { "https://cdn/guide.png": [PA] } }),
    { browser: brImg({ url: "https://cdn/guide.png", productUrl: PB, pages: [PB], context: "Size guide" }), image: kids });
  check("§2.16 the same image from static (PDP a) and the browser (PDP b) -> read once, store-wide",
    merged.calls.images === 1 && merged.records.length === 1 && merged.records[0].product_key === "",
    JSON.stringify([merged.calls.images, merged.records.map((r) => r.product_key)]));
  const guidePlus = await runWith(staticResult({ images: ["https://cdn/guide.png"], imagePages: { "https://cdn/guide.png": [""] } }),
    { browser: brImg({ url: "https://cdn/guide.png", productUrl: PB, pages: [PB], context: "Size guide" }), image: kids });
  check("§2.16b ...a guide-page sighting stays store-wide when the browser also saw it on one PDP",
    guidePlus.calls.images === 1 && guidePlus.records.length === 1 && guidePlus.records[0].product_key === "",
    JSON.stringify(guidePlus.records.map((r) => r.product_key)));

  /* "Captured" is a record buildRecords keeps: a lone "Suits" table (no garment type, never
     stored) used to count, so the real image chart was skipped and the run said "none". */
  const suits = finding("Suits", "linked_page");
  const untyped = await runWith(staticResult({ found: suits, records: [], images: ["https://shop.example.com/size-chart-women.png"] }),
    { opts: { noBrowser: true }, image: kids });
  check("§2.17 only an untyped chart (never stored) + an image hit -> the image IS read and its chart captured",
    suits.length === 1 && suits[0].chart.classification.garmentType === null && untyped.calls.images === 1 &&
    untyped.records.length === 1 && untyped.records[0].source === "image_ocr" && untyped.reason === null,
    JSON.stringify([untyped.calls.images, untyped.records.map((r) => r.source), untyped.reason]));
}

console.log("\n── §3 nothing found -> one reason + the manual command ──");
{
  /* §3.1 used to stub a browser that came back blocked too - which only passed because the
     browser was sent at the store after it refused us (the bug). The refusal alone is BLOCKED. */
  const blocked = await runWith(staticResult({ outcome: "blocked_by_bot_protection", blocked: 3 }), {
    browser: { found: [], images: [], report: { status: "blocked", pages_opened: 0, triggers_clicked: 0, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 2, examples: ["https://shop.example.com/p (HTTP 403)"] }, errors: [] } } });
  check("§3.1 static refused -> blocked, and the browser is never sent after it",
    blocked.reason && blocked.reason.kind === "blocked" && blocked.calls.browser === 0 && blocked.browser === null,
    JSON.stringify([blocked.reason, blocked.calls]));
  const line = reasonLine("blocked", "shop.example.com", blocked.reason.extra);
  check("§3.2 the blocked line says we do not work around it and gives the manual import",
    /BLOCKED/.test(line) && /do not work around/.test(line) && /npm run import:chart -- --host shop\.example\.com --html/.test(line), line);
  const img = await runWith(staticResult({ images: ["https://cdn/c.png"] }), { image: { found: [], outcome: "rejected", detail: "parser accepted none" } });
  check("§3.3 only an image, OCR rejected -> image_unreadable (suggests --image)", img.reason.kind === "image_unreadable" &&
    /--image/.test(reasonLine(img.reason.kind, "shop.example.com")));
  const js = await runWith(staticResult({ triggers: 4 }));
  check("§3.4 triggers, browser opened pages, nothing readable -> js_unreadable", js.reason.kind === "js_unreadable", JSON.stringify(js.reason));
  const none = await runWith(staticResult(), { opts: { noBrowser: true } });
  check("§3.5 nothing anywhere -> none (suggests --url)", none.reason.kind === "none" && /--url/.test(reasonLine("none", "shop.example.com")));
  const unr = await runWith(staticResult({ outcome: "unreachable", errors: ["home page: HTTP 0"] }));
  check("§3.6 unreachable -> unreachable", unr.reason.kind === "unreachable" && unr.calls.browser === 0);
  const conv = await runWith(staticResult({ triggers: 2 }), { browser: { found: [], images: [], report: { status: "ok", pages_opened: 3, triggers_clicked: 3, tabs_clicked: 0,
    network_payloads: 0, methods: {}, unmeasured_guides: 3, unmeasured_examples: ["https://shop.example.com/products/a"], blocked: { count: 0, examples: [] }, errors: [] } } });
  check("§3.8 the guide opened but holds only a conversion table (factory54) -> no_measurements, not 'could not open'",
    conv.reason.kind === "no_measurements" && /CONVERSION table/.test(reasonLine("no_measurements", "shop.example.com")), JSON.stringify(conv.reason));
  const noCtl = await runWith(staticResult(), { browser: { found: [], images: [], report: { status: "ok", pages_opened: 5, triggers_clicked: 0, tabs_clicked: 0,
    network_payloads: 0, methods: {}, unmeasured_guides: 0, unmeasured_examples: [], blocked: { count: 0, examples: [] }, errors: [] } } });
  check("§3.9 rendered pages with no size-guide control anywhere (yanga) -> none, saying so", noCtl.reason.kind === "none" &&
    /no size-guide control/.test(noCtl.reason.extra), JSON.stringify(noCtl.reason));
  const nochrome = await runWith(staticResult(), { browser: { found: [], images: [], report: { status: "browser_unavailable", errors: ["could not launch Chromium"], blocked: { count: 0, examples: [] } } } });
  check("§3.7 Chromium missing -> browser_unavailable with the install hint", nochrome.reason.kind === "browser_unavailable" &&
    /playwright install chromium/.test(reasonLine("browser_unavailable", "x.com")));
  const refusedNoChrome = await runWith(staticResult({ outcome: "blocked_by_bot_protection", blocked: 1, errors: ["home page: HTTP 403"] }), {
    opts: { forceBrowser: true },
    browser: { found: [], images: [], report: { status: "browser_unavailable", errors: ["could not launch Chromium"], blocked: { count: 0, examples: [] } } } });
  check("§3.10 a store that refused us is BLOCKED, never 'install Chromium' (blocked outranks browser_unavailable)",
    refusedNoChrome.reason.kind === "blocked" && refusedNoChrome.calls.browser === 0, JSON.stringify(refusedNoChrome.reason));
}

console.log("\n── §4 the human end ──");
{
  const out = await runWith(staticResult({ found: finding("Men", "linked_page") }));
  const txt = formatChartSummary(out.records);
  check("§4.1 the summary names audience, type, system, scope, sizes, measurements, confidence, source",
    /men \/ adult \/ tops/.test(txt) && /\[alpha\]/.test(txt) && /store-wide/.test(txt) && /sizes: S M L/.test(txt) &&
    /chest 88-108cm/.test(txt) && /confidence 0\.\d+/.test(txt) && /via linked_page/.test(txt), txt);
  const written = [];
  const yes = await askYesNo("Save?", { input: { isTTY: false }, output: { write: (s) => written.push(s) } });
  check("§4.2 not a TTY -> answers NO and says how to save (--yes)", yes === false && /--yes/.test(written.join("")));
  check("§4.3 --yes saves without a prompt", (await askYesNo("Save?", { assumeYes: true })) === true);
  let asked = "";
  const live = await fetchLiveCharts("shop.example.com", { apiBase: "https://api.example.com/", fetchImpl: async (u) => {
    asked = u; return { ok: true, json: async () => ({ host: "shop.example.com", charts: [{ gender: "men", age_group: "adult", garment_type: "tops", size_system: "alpha", source: "linked_page", rows: [{ size: "S" }] }] }) };
  } });
  check("§4.4 the live check asks GET /api/store-size-chart for the canonical host", asked === "https://api.example.com/api/store-size-chart?host=shop.example.com" && live.ok, asked);
  const cov = liveCoverage(out.records, live);
  check("§4.5 ...and matches what was saved against what is served", cov.expected === 1 && cov.live === 1, JSON.stringify(cov));
}

console.log("\n── §5 the static stage stops after three refusals ──");
{
  const asked = [];
  const urls = Array.from({ length: 10 }, (_, i) => `https://shop.example.com/products/p${i}`);
  const fetchText = async (u) => {
    asked.push(u);
    if (u === "https://shop.example.com" || u === "https://shop.example.com/") return { ok: true, status: 200, url: u, contentType: "text/html", text: "<html><head><title>Shop</title></head><body><h1>Shop</h1>" + "x".repeat(9000) + "</body></html>" };
    if (/sitemap/.test(u)) return { ok: true, status: 200, url: u, contentType: "application/xml", text: `<urlset>${urls.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>` };
    if (/robots/.test(u)) return { ok: false, status: 404, url: u, text: "" };
    return { ok: false, status: 403, url: u, text: "" };
  };
  const r = await discoverSizeCharts("https://shop.example.com", { fetchText, delayMs: 0, log: () => {}, JSDOM, maxProducts: 10 });
  const pdpAsks = asked.filter((u) => /\/products\//.test(u)).length;
  check("§5.1 three 403s in a row -> no fourth product page requested", pdpAsks === 3, `${pdpAsks} product requests`);
  check("§5.2 ...reported as BLOCKED (not none_found), with the stop recorded",
    r.report.outcome === "blocked_by_bot_protection" && r.report.errors.some((e) => /stopped after 3 refusals/.test(e)),
    JSON.stringify([r.report.outcome, r.report.errors.slice(-1)]));
  /* The whole flow over the same store: the browser used to be handed all ten sampled URLs,
     the three refused ones included, and opened them again. */
  asked.length = 0;
  let browserRuns = 0;
  const flow = await runCapture("https://shop.example.com", { log: () => {}, JSDOM, maxProducts: 10,
    discover: (u, o) => discoverSizeCharts(u, { ...o, fetchText, delayMs: 0 }),
    browserCapture: async () => { browserRuns++; return { found: [], images: [], report: { status: "ok", pages_opened: 0, blocked: { count: 0, examples: [] }, errors: [] } }; } });
  check("§5.3 ...and the one-command flow reports BLOCKED without sending the browser after it",
    flow.reason.kind === "blocked" && browserRuns === 0 && asked.filter((u) => /\/products\//.test(u)).length === 3,
    JSON.stringify([flow.reason, browserRuns]));
}

console.log("\n── §6 a browser stage that throws ──");
{
  /* Uncaught, a throw (page.content() mid-navigation, a missing playwright package) reached
     main()'s "capture failed" exit and discarded the static charts and the image stage. */
  const navigating = new Error("Unable to retrieve content because the page is navigating and changing the content.\n  at ...");
  const runThrow = (st, opts = {}) => runWith(st, { opts: { browserCapture: async () => { throw navigating; }, ...opts } });
  let threw = null, kept = null;
  try { kept = await runThrow(staticResult({ found: finding("Men", "linked_page"), triggers: 2 })); } catch (e) { threw = e; }
  check("§6.1 static charts + a browser that throws -> the run completes and keeps the static chart",
    !threw && kept.records.length === 1 && kept.records[0].source === "linked_page" && kept.reason === null &&
    kept.browser.report.status === "browser_unavailable" && /page is navigating/.test(kept.browser.report.errors[0]),
    threw ? threw.message : JSON.stringify([kept.records.length, kept.browser && kept.browser.report]));
  let threw2 = null, bare = null;
  try { bare = await runThrow(staticResult({ images: ["https://shop.example.com/c.png"] })); } catch (e) { threw2 = e; }
  check("§6.2 nothing else captured -> browser_unavailable with the message, and the image stage still runs",
    !threw2 && bare.reason.kind === "browser_unavailable" && /browser fallback failed: Unable to retrieve content/.test(bare.reason.extra) &&
    !/\n/.test(bare.reason.extra) && bare.calls.images === 1,
    threw2 ? threw2.message : JSON.stringify([bare.reason, bare.calls]));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("capture-flow: all checks passed.");
