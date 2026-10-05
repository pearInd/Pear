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
const staticResult = ({ found = [], triggers = 0, apps = [], outcome = null, images = [], blocked = 0, errors = [] } = {}) => ({
  report: { outcome: outcome || (found.length ? "captured" : "none_found"), platform: "html", sampled_products: 4, errors,
    blocked: { count: blocked, examples: blocked ? ["https://shop.example.com/p (challenge)"] : [] },
    paths: { js_app_detected: { triggers_without_link: triggers, apps }, image_chart_detected: { count: images.length, examples: images },
      linked_page: {}, inline_table: {}, product_description: {} }, charts: [], conflicts: [] },
  records: found.length ? [{}] : [], found, products: ["https://shop.example.com/products/a"], images,
});
const quiet = () => {};
const runWith = (st, extra = {}) => {
  const calls = { browser: 0, images: 0 };
  return runCapture("https://www.shop.example.com", {
    log: quiet, JSDOM, imageDelayMs: 0, apiKey: "k",
    discover: async () => st,
    browserCapture: async () => { calls.browser++; return extra.browser || { found: [], images: [], report: { status: "ok", pages_opened: 2, triggers_clicked: 1, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 0, examples: [] }, errors: [] } }; },
    imageReader: async () => { calls.images++; return extra.image || { found: [], outcome: "not_a_chart", detail: "Gemini: not a size chart" }; },
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
}

console.log("\n── §3 nothing found -> one reason + the manual command ──");
{
  const blocked = await runWith(staticResult({ outcome: "blocked_by_bot_protection", blocked: 3 }), {
    browser: { found: [], images: [], report: { status: "blocked", pages_opened: 0, triggers_clicked: 0, tabs_clicked: 0, network_payloads: 0, methods: {}, blocked: { count: 2, examples: ["https://shop.example.com/p (HTTP 403)"] }, errors: [] } } });
  check("§3.1 static AND browser refused -> blocked", blocked.reason && blocked.reason.kind === "blocked", JSON.stringify(blocked.reason));
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
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("capture-flow: all checks passed.");
