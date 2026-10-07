/* PHASE 2 - THE REAL-BROWSER FALLBACK (scanner/browser-capture.js)
   ─────────────────────────────────────────────────────────────────────────────
   §1 TRIGGERS. Which labels are clicked (Hebrew + English size-guide words) and which
      never are (add to cart, checkout, login) - the browser only ever clicks a guide.
   §2 A RENDERED GUIDE. A modal snapshot with men's/women's tabs is read by the SHARED
      parser; the product page may say WHO a guide is for, never WHAT garment (the
      terminalx bug: a women's chest chart typed "bottoms" off a pair of leggings).
   §3 NETWORK PAYLOADS. Markup inside JSON ({content}/{html}/CMS blocks) and structured
      row arrays are read; a price list or a translation file is not.
   §4 SAME VALIDATION, SAME RECORDS. Browser findings go through buildRecords(): a
      chart the parser refuses never becomes a record; one PDP = product-scoped, two =
      store-wide; the capture method is the `source`.
      §4.4+ THE RUN'S OWN RULES on a SCRIPTED browser (no Chromium needed, so they guard
      in every environment - mutation:capture included): two refusals in a row stop the
      run, also after a page opened; a page that navigates while it is read, a missing
      playwright package or a page that will not open never throws away the run; one
      page's guide label and late responses never reach the next page; a guide image
      keeps every product page it was seen on.
   §5 REAL CHROMIUM against a local fixture store: click the trigger (also one whose
      words sit in child spans), click each tab (also a second guide's), never the cart
      (not even with <body class="modal-open">), catch the JSON the guide fetched, count
      a conversion-only guide but not a click that opened nothing, and stop on a 403 -
      reported as BLOCKED. Skipped (not failed) only when Chromium cannot launch on this
      machine; any other throw is a FAIL.
   ============================================================================= */
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import {
  isSizeGuideTriggerLabel, looksLikeSizePayload, htmlCandidatesFromJson, chartsFromHtml,
  chartsFromNetworkBody, captureWithBrowser,
} from "../scanner/browser-capture.js";
import { buildRecords } from "../scanner/size-charts.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const MEN_TABLE = `<table><tr><th>Size</th><th>Chest (cm)</th><th>Waist (cm)</th></tr>
  <tr><td>S</td><td>88-94</td><td>74-80</td></tr><tr><td>M</td><td>95-101</td><td>81-87</td></tr><tr><td>L</td><td>102-108</td><td>88-94</td></tr></table>`;
const WOMEN_TABLE = `<table><tr><th>מידה</th><th>חזה</th><th>מותניים</th></tr>
  <tr><td>XS</td><td>78-82</td><td>60-64</td></tr><tr><td>S</td><td>83-87</td><td>65-69</td></tr><tr><td>M</td><td>88-92</td><td>70-74</td></tr></table>`;
const PRICE_TABLE = `<table><tr><th>Size</th><th>Price</th></tr><tr><td>S</td><td>89.90</td></tr><tr><td>M</td><td>89.90</td></tr></table>`;

console.log("\n── §1 which controls are size-guide triggers ──");
{
  for (const l of ["מדריך מידות", "טבלת מידות", "Size Guide", "size chart", "SIZE & FIT", "Find your size", "טבלת מידות / VARLEY / נשים"]) {
    check(`§1 "${l}" is a trigger`, isSizeGuideTriggerLabel(l));
  }
  for (const l of ["הוספה לסל", "Add to bag", "Size", "Checkout - size guide", "Login", ""]) {
    check(`§1 "${l}" is NOT clicked`, !isSizeGuideTriggerLabel(l));
  }
  check("§1 a 200-char wrapper label is not a trigger (a container, not a control)", !isSizeGuideTriggerLabel("size guide " + "x".repeat(200)));
}

console.log("\n── §2 a rendered guide, read by the shared parser ──");
{
  const snap = `<html><head><title>Slim Fit Jeans - Store</title></head><body><h1>Slim Fit Jeans</h1>
    <div role="dialog"><h2>Size guide</h2>
      <div role="tablist"><button role="tab">Men</button><button role="tab">Women</button></div>
      <section><h3>Men</h3>${MEN_TABLE}</section><section><h3>נשים</h3>${WOMEN_TABLE}</section>${PRICE_TABLE}</div></body></html>`;
  const found = chartsFromHtml(snap, "https://shop.example.com/products/jeans", JSDOM, { source: "browser_modal", productUrl: "https://shop.example.com/products/jeans" });
  const men = found.find((f) => f.chart.classification.gender === "men");
  const women = found.find((f) => f.chart.classification.gender === "women");
  check("§2.1 both tab tables are read (the price table is not)", found.length === 2, found.map((f) => f.chart.rows.map((r) => r.size).join("/")).join(" | "));
  check("§2.2 each takes its gender from its own heading", !!men && !!women);
  check("§2.3 a guide opened from a JEANS page is typed by its columns (tops), not by the product title",
    men && women && men.chart.classification.garmentType === "tops" && women.chart.classification.garmentType === "tops",
    JSON.stringify(found.map((f) => f.chart.classification.garmentType)));
  const inline = chartsFromHtml(snap, "https://shop.example.com/products/jeans", JSDOM, { source: "browser_page" });
  check("§2.4 ...while a chart rendered IN the product page keeps the product's context (same as static inline_table)",
    inline.every((f) => f.chart.classification.garmentType === "jeans"), JSON.stringify(inline.map((f) => f.chart.classification.garmentType)));
  const bare = chartsFromHtml(`<div role="dialog">${MEN_TABLE.replace("<th>Size</th>", "<th>Size</th>")}</div>`, "https://shop.example.com/p/1", JSDOM,
    { source: "browser_modal", referrerText: "טבלת מידות / VARLEY / נשים" });
  check("§2.5 the trigger's label is referrer evidence for gender (terminalx: 'טבלת מידות / VARLEY / נשים')",
    bare[0] && bare[0].chart.classification.gender === "women", bare[0] && JSON.stringify(bare[0].chart.classification));
}

console.log("\n── §3 network payloads ──");
{
  check("§3.1 a CMS response with a size table is a candidate payload",
    looksLikeSizePayload(JSON.stringify({ data: { cmsBlocks: { items: [{ title: "Size chart women", content: WOMEN_TABLE }] } } })));
  check("§3.2 a translation file that only says 'size' is not", !looksLikeSizePayload('{"size":"מידה","add_to_cart":"הוספה לסל"}'));
  const cms = { data: { cmsBlocks: { items: [{ identifier: "sizechart_women_1", title: "טבלת מידות נשים", content: WOMEN_TABLE }] } } };
  const c1 = chartsFromNetworkBody(JSON.stringify(cms), "https://shop.example.com/graphql", "https://shop.example.com/p/2", JSDOM, "https://shop.example.com/p/2");
  check("§3.3 markup inside a JSON string field is read, titled by its block", c1.length === 1 &&
    c1[0].source === "browser_network" && c1[0].chart.classification.gender === "women" && c1[0].sourceUrl === "https://shop.example.com/graphql",
    JSON.stringify(c1.map((f) => [f.source, f.chart.classification])));
  const rows = { sizes: [{ size: "S", chest: "88-94", waist: "74-80" }, { size: "M", chest: "95-101", waist: "81-87" }, { size: "L", chest: "102-108", waist: "88-94" }] };
  const c2 = chartsFromNetworkBody(JSON.stringify(rows), "https://x/api", "https://shop.example.com/p/3", JSDOM);
  check("§3.4 a structured row array becomes a table the parser reads (S chest 88-94)",
    c2.length === 1 && c2[0].chart.rows[0].minChest === 88 && c2[0].chart.rows[0].maxWaist === 80, JSON.stringify(c2[0] && c2[0].chart.rows[0]));
  const prices = { items: [{ size: "S", price: "89.90", stock: 3 }, { size: "M", price: "89.90", stock: 0 }] };
  check("§3.5 a row array of prices/stock yields nothing (the parser maps no column)",
    chartsFromNetworkBody(JSON.stringify(prices), "https://x/api", "https://shop.example.com/p/3", JSDOM).length === 0);
  const wild = { sizes: [{ size: "S", chest: "300-320" }, { size: "M", chest: "330-350" }] };
  check("§3.6 implausible values are refused by the shared clamps, as on any page",
    chartsFromNetworkBody(JSON.stringify(wild), "https://x/api", "https://shop.example.com/p/3", JSDOM).length === 0);
  check("§3.7 broken JSON is not a throw", chartsFromNetworkBody("{nope", "u", "https://shop.example.com/p", JSDOM).length === 0);
  check("§3.8 htmlCandidatesFromJson caps its walk (no runaway on a huge payload)",
    htmlCandidatesFromJson(Array.from({ length: 100 }, () => ({ content: MEN_TABLE }))).length <= 20);
  /* PHP's json_encode escapes every non-ASCII char (WordPress/WooCommerce admin-ajax): the
     pre-filter saw no Hebrew word and dropped a body the parser reads fine. */
  const escaped = JSON.stringify({ success: true, html: `<h3>טבלת מידות נשים</h3>${WOMEN_TABLE}` })
    .replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).replace(/\//g, "\\/");
  check("§3.9 a \\u-escaped Hebrew JSON guide (json_encode's default) passes the pre-filter, and the parser reads it",
    !/[\u0590-\u05ff]/.test(escaped) && looksLikeSizePayload(escaped) &&
    chartsFromNetworkBody(escaped, "https://x/wp-admin/admin-ajax.php", "https://shop.example.com/p/9", JSDOM).some((f) => f.chart.classification.gender === "women"),
    escaped.slice(0, 80));
  check("§3.10 ...and an escaped translation file is still not a payload",
    !looksLikeSizePayload('{"size":"\\u05de\\u05d9\\u05d3\\u05d4","add_to_cart":"\\u05d4\\u05d5\\u05e1\\u05e4\\u05d4 \\u05dc\\u05e1\\u05dc"}'));
}

console.log("\n── §4 the same records path as Phase 1 ──");
{
  const p1 = "https://shop.example.com/products/a", p2 = "https://shop.example.com/products/b";
  const f1 = chartsFromHtml(`<div role="dialog"><h3>Men</h3>${MEN_TABLE}</div>`, p1, JSDOM, { source: "browser_modal", productUrl: p1 });
  const one = buildRecords(f1, "shop.example.com");
  check("§4.1 seen on ONE product page -> product-scoped, source browser_modal",
    one.length === 1 && one[0].product_key === p1 && one[0].source === "browser_modal", JSON.stringify(one.map((r) => [r.product_key, r.source])));
  const f2 = chartsFromHtml(`<div role="dialog"><h3>Men</h3>${MEN_TABLE}</div>`, p2, JSDOM, { source: "browser_modal", productUrl: p2 });
  const two = buildRecords([...f1, ...f2], "shop.example.com");
  check("§4.2 the same guide on TWO product pages -> the store's chart (product_key '')", two.length === 1 && two[0].product_key === "");
  check("§4.3 the record carries the Phase 1 keys and no height/weight",
    two[0].gender === "men" && two[0].age_group === "adult" && two[0].garment_type === "tops" && two[0].size_system === "alpha" &&
    !/height|weight/i.test(JSON.stringify(two[0].rows)));
}

console.log("\n── §4 (cont.) the run's own rules, on a scripted browser - no Chromium needed ──");
/* A stand-in for Playwright's chromium, so the rules that live in captureWithBrowser()'s
   loop are guarded on every machine (the real-Chromium §5 SKIPs where none launches, and a
   rule guarded only there is a rule mutation:capture cannot see). `site(url)` answers a
   navigation: {status, html, read(n), responses, late}; read(n) replaces html for the n-th
   content() call since that navigation (1 = the block check, 2 = the page read, 3 = the
   first guide snapshot); `responses` are delivered to the page's response listener during
   the navigation, `late` during the page's final wait with bodies that land only after the
   NEXT navigation. `evaluate(kind, url)` answers the in-page scripts by kind. */
const scriptKind = (s) => s.includes("data-pear-trigger") ? "triggers" : s.includes("data-pear-tab") ? "tabs"
  : s.includes("naturalWidth") ? "images" : s.includes("__pearGridsBefore ||") ? "newGrids" : "remember";
function scriptedChromium({ site = () => ({}), evaluate = () => undefined, newPage = null } = {}) {
  const rec = { gotos: [], closed: false };
  let current = "about:blank", reads = 0, listener = null;
  const landLate = [];
  const response = (r) => ({
    request: () => ({ resourceType: () => r.type || "document" }),
    headers: () => ({ "content-type": r.contentType || "text/html; charset=utf-8" }),
    text: r.text || (async () => r.html), url: () => r.url,
  });
  const page = {
    on(ev, fn) { if (ev === "response") listener = fn; },
    async goto(url) {
      rec.gotos.push(url); current = url; reads = 0;
      for (const land of landLate.splice(0)) land();
      const s = site(url) || {};
      for (const r of s.responses || []) if (listener) await listener(response(r));
      await new Promise((r) => setTimeout(r, 0));
      return { status: () => s.status || 200 };
    },
    async content() {
      const s = site(current) || {};
      reads++;
      return s.read ? s.read(reads) : (s.html || "<html><head><title>x</title></head><body></body></html>");
    },
    async waitForLoadState() {},
    async waitForTimeout(ms) {
      const s = site(current) || {};
      if (ms === 500 && listener) {
        for (const r of s.late || []) {
          let land; const body = new Promise((res) => { land = () => res(r.html); });
          landLate.push(land);
          listener(response({ ...r, text: () => body }));
        }
      }
    },
    async evaluate(script) {
      const kind = scriptKind(String(script));
      const v = evaluate(kind, current);
      return v !== undefined ? v : (kind === "newGrids" || kind === "remember" ? 0 : []);
    },
    async $$eval() { return []; },
    url() { return current; },
    keyboard: { async press() {} },
    locator() { return { first: () => ({ async click() {} }) }; },
    async goBack() {},
  };
  const chromium = {
    async launch() {
      return {
        async newContext() { return { async newPage() { if (newPage) return newPage(); return page; } }; },
        async close() { rec.closed = true; },
      };
    },
  };
  return { chromium, rec };
}
{
  const S = "https://shop.example.com";
  const opts = (extra) => ({ delayMs: 0, log: () => {}, JSDOM, ...extra });
  const INLINE = (title, extra = "") => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${extra}<h2>Size guide</h2>${MEN_TABLE}</body></html>`;

  const wall = scriptedChromium({ site: () => ({ status: 403, html: "<html><head><title>Forbidden</title></head><body>no</body></html>" }) });
  const r1 = await captureWithBrowser(S, opts({ chromium: wall.chromium, productUrls: [`${S}/p/1`, `${S}/p/2`, `${S}/p/3`] }));
  check("§4.4 two 403s in a row stop the browser - BLOCKED, no third request",
    r1.report.status === "blocked" && wall.rec.gotos.length === 2, JSON.stringify({ status: r1.report.status, gotos: wall.rec.gotos }));

  const escalating = scriptedChromium({ site: (u) => u.endsWith("/p/1") ? { html: INLINE("Tee") } : { status: 429, html: "<html><body>slow down</body></html>" } });
  const r2 = await captureWithBrowser(S, opts({ chromium: escalating.chromium, productUrls: [1, 2, 3, 4, 5, 6].map((i) => `${S}/p/${i}`) }));
  check("§4.5 a store that serves one page and then refuses is stopped after two refusals in a row and reported BLOCKED (was: all 6 requested, 'ok')",
    r2.report.status === "blocked" && escalating.rec.gotos.length === 3 && r2.report.pages_opened === 1 && r2.found.length === 1,
    JSON.stringify({ status: r2.report.status, gotos: escalating.rec.gotos.length, opened: r2.report.pages_opened, found: r2.found.length }));

  const one = scriptedChromium({ site: () => ({ status: 403, html: "<html><body>no</body></html>" }) });
  const r3 = await captureWithBrowser(S, opts({ chromium: one.chromium, productUrls: [`${S}/p/1`] }));
  const gaps = scriptedChromium({ site: (u) => /\/p\/[13]$/.test(u) ? { status: 403, html: "<html><body>no</body></html>" } : { html: INLINE("Tee") } });
  const r3b = await captureWithBrowser(S, opts({ chromium: gaps.chromium, productUrls: [1, 2, 3, 4].map((i) => `${S}/p/${i}`) }));
  check("§4.6 a single refusal with nothing opened is still BLOCKED; refusals that are not in a row do not stop the run",
    r3.report.status === "blocked" && r3b.report.status === "ok" && gaps.rec.gotos.length === 4,
    JSON.stringify({ single: r3.report.status, gaps: r3b.report.status, gotos: gaps.rec.gotos.length }));

  const NAVIGATING = "page.content: Unable to retrieve content because the page is navigating and changing the content.";
  const racy = scriptedChromium({
    site: (u) => u.endsWith("/good") ? { html: INLINE("Good tee") }
      : u.endsWith("/redirecting") ? { read: (n) => { if (n >= 2) throw new Error(NAVIGATING); return "<html><body>moving</body></html>"; } }
      : { read: (n) => { if (n === 3) throw new Error(NAVIGATING); return INLINE("Flaky tee", '<button>Size guide</button>'); } },
    evaluate: (kind, u) => kind === "triggers" && u.endsWith("/flaky") ? [{ id: "pt0", label: "Size guide", tag: "BUTTON", href: "" }] : undefined,
  });
  let r4 = null, threw = null;
  try { r4 = await captureWithBrowser(S, opts({ chromium: racy.chromium, productUrls: [`${S}/good`, `${S}/redirecting`, `${S}/flaky`] })); } catch (e) { threw = e; }
  check("§4.7 a page that navigates while it is read is a failed page, not a throw - the other pages' charts survive",
    !threw && r4.found.length === 2 && r4.report.pages_failed === 1 && r4.report.triggers_clicked === 1 && racy.rec.closed &&
    r4.report.errors.some((e) => /redirecting: .*navigating/.test(e)),
    threw ? threw.stack : JSON.stringify({ found: r4.found.length, report: r4.report }));

  const noPage = scriptedChromium({ newPage: () => { throw new Error("Target page, context or browser has been closed"); } });
  let r5 = null; threw = null;
  try { r5 = await captureWithBrowser(S, opts({ chromium: noPage.chromium, productUrls: [`${S}/p/1`] })); } catch (e) { threw = e; }
  check("§4.8 a page that will not open closes the launched browser and reports browser_unavailable (no throw, no leaked Chromium)",
    !threw && noPage.rec.closed && r5.report.status === "browser_unavailable" && /could not open a page/.test(r5.report.errors[0]),
    threw ? threw.stack : JSON.stringify({ closed: noPage.rec.closed, report: r5 && r5.report }));

  let r6 = null; threw = null;
  try {
    r6 = await captureWithBrowser(S, opts({ productUrls: [`${S}/p/1`],
      loadChromium: async () => { throw new Error("Playwright is required for the browser fallback (npm install in the repo root, then `npx playwright install chromium`): Cannot find package 'playwright'"); } }));
  } catch (e) { threw = e; }
  check("§4.9 a missing playwright package is browser_unavailable with the install hint, not a throw that discards the static charts",
    !threw && r6.report.status === "browser_unavailable" && /^Playwright is required/.test(r6.report.errors[0]) && r6.found.length === 0,
    threw ? threw.stack : JSON.stringify(r6 && r6.report));

  const GUIDE_PNG = "https://cdn.shop.example.com/files/size-guide-women.png";
  const imgs = scriptedChromium({
    site: () => ({ html: INLINE("Tee").replace(MEN_TABLE, "") }),
    evaluate: (kind, u) => kind === "triggers" ? [{ id: "pt0", label: "Size guide", tag: "BUTTON", href: "" }]
      : kind === "images" ? (u.endsWith("/c") ? [`${S}/files/c-only-chart.png`] : [GUIDE_PNG]) : undefined,
  });
  const r7 = await captureWithBrowser(S, opts({ chromium: imgs.chromium, productUrls: [`${S}/products/a`, `${S}/products/b`, `${S}/products/c`] }));
  const shared = r7.images.find((i) => i.url === GUIDE_PNG), only = r7.images.find((i) => /c-only/.test(i.url));
  check("§4.10 a guide image keeps EVERY product page it was seen on (productUrl = the first) - one entry, read once",
    r7.images.length === 2 && shared && shared.productUrl === `${S}/products/a` &&
    JSON.stringify(shared.pages) === JSON.stringify([`${S}/products/a`, `${S}/products/b`]) &&
    only && JSON.stringify(only.pages) === JSON.stringify([`${S}/products/c`]),
    JSON.stringify(r7.images));

  /* terminalx: page A's guide button names the audience ("נשים"); page B has an unlabelled
     inline chart whose own document response passes the payload pre-filter. */
  const B_HTML = `<html><head><title>Basic tee</title></head><body><h1>Basic tee</h1><p>Free shipping</p><h2>Size guide</h2>${MEN_TABLE}</body></html>`;
  const LATE_URL = `${S}/api/late-guide.json`;
  const carry = (withA) => scriptedChromium({
    site: (u) => u.endsWith("/a") ? { html: "<html><head><title>Jeans</title></head><body><h1>Jeans</h1></body></html>",
        late: [{ url: LATE_URL, type: "fetch", contentType: "application/json", html: JSON.stringify({ title: "Size chart", content: WOMEN_TABLE }) }] }
      : { html: B_HTML, responses: [{ url: u, html: B_HTML }] },
    evaluate: (kind, u) => kind === "triggers" && u.endsWith("/a") && withA ? [{ id: "pt0", label: "טבלת מידות / VARLEY / נשים", tag: "BUTTON", href: "" }] : undefined,
  });
  const alone = await captureWithBrowser(S, opts({ chromium: carry(false).chromium, productUrls: [`${S}/products/b`] }));
  const after = await captureWithBrowser(S, opts({ chromium: carry(true).chromium, productUrls: [`${S}/products/a`, `${S}/products/b`] }));
  const bAlone = alone.found.filter((f) => f.productUrl === `${S}/products/b`);
  const bAfter = after.found.filter((f) => f.productUrl === `${S}/products/b`);
  check("§4.11 page A's guide label never reaches page B: B's chart has the same gender after A as alone (was: A's 'women' at 0.65)",
    bAlone.length === 1 && bAfter.length === 1 && bAfter[0].chart.classification.gender === bAlone[0].chart.classification.gender &&
    bAfter[0].chart.classification.gender !== "women",
    JSON.stringify({ alone: bAlone.map((f) => [f.source, f.chart.classification.gender]), after: bAfter.map((f) => [f.source, f.chart.classification.gender]) }));
  check("§4.12 a response page A fetched that lands after B's navigation is not credited to B",
    !after.found.some((f) => f.sourceUrl === LATE_URL), JSON.stringify(after.found.map((f) => [f.productUrl, f.sourceUrl])));
}

console.log("\n── §5 real Chromium against a local fixture store ──");
{
  let hits403 = 0, cartHits = 0, pageTabHits = 0;
  /* <body class="modal-open"> is what Bootstrap sets while any modal is open, and the cart
     button's "hidden-tablet" class contains "tab": the page-wide trap MARK_TABS once fell
     into (the cart POSTed). The cart is a fetch the SERVER counts - the page's own title
     could never be seen from here. The guide itself carries an "add to bag" CTA (size
     recommenders do) under a "tab-footer": a tab by class, never clicked by policy. The
     page's own description/reviews strip (ul.nav-tabs) is not the guide's, and the
     guide's close button ("hidden-tablet") is not a tab - clicked, it removes the guide
     before its men/women tabs are read. Page B's trigger keeps its words in child spans. */
  const PDP = (title, trigger) => `<!doctype html><html lang="he"><head><title>${title}</title></head><body class="modal-open"><h1>${title}</h1>
    <button id="add" class="btn add-to-cart hidden-tablet" type="button">הוספה לסל</button>
    <button id="sg" type="button">${trigger}</button>
    <ul class="nav-tabs product-tabs"><li><a href="#reviews" id="rv">ביקורות</a></li></ul>
    <script>
      document.getElementById('add').onclick = () => { fetch('/cart/add', { method: 'POST' }); };
      document.getElementById('rv').onclick = (e) => { e.preventDefault(); fetch('/page-tab'); };
      document.getElementById('sg').onclick = async () => {
        const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.className = 'size-guide-modal';
        d.innerHTML = '<button class="sg-close hidden-tablet" id="gx" aria-label="סגירה">✕</button><h2>מדריך מידות</h2><div class="tabs"><button role="tab" id="tm">גברים</button><button role="tab" id="tw">נשים</button></div><div id="panel"></div><div class="tab-footer"><button id="gadd">הוספה לסל</button></div>';
        document.body.appendChild(d);
        document.getElementById('gadd').onclick = () => { fetch('/cart/add', { method: 'POST' }); };
        document.getElementById('gx').onclick = () => d.remove();
        const show = (html) => { document.getElementById('panel').innerHTML = html; };
        document.getElementById('tm').onclick = () => show(${JSON.stringify(`<h3>גברים</h3>${MEN_TABLE}`)});
        document.getElementById('tw').onclick = () => show(${JSON.stringify(`<h3>נשים</h3>${WOMEN_TABLE}`)});
        await fetch('/api/size-guide.json').then((r) => r.json());
      };
    </script></body></html>`;
  /* Two guides that Escape HIDES (not removes), the first one first in the DOM, each with
     men/women tabs that fill an empty panel - and both triggers keep their words in child
     spans / an aria-label over a bare "Sizes". */
  const MEN_PANTS = `<table><tr><th>Size</th><th>Waist (cm)</th><th>Hips (cm)</th></tr><tr><td>S</td><td>76-81</td><td>94-99</td></tr><tr><td>M</td><td>82-87</td><td>100-105</td></tr><tr><td>L</td><td>88-93</td><td>106-111</td></tr></table>`;
  const WOMEN_PANTS = `<table><tr><th>Size</th><th>Waist (cm)</th><th>Hips (cm)</th></tr><tr><td>XS</td><td>60-64</td><td>86-90</td></tr><tr><td>S</td><td>65-69</td><td>91-95</td></tr><tr><td>M</td><td>70-74</td><td>96-100</td></tr></table>`;
  const dialog = (n, title) => `<div role="dialog" class="dlg" id="d${n}"><h2>${title}</h2><div class="tabs"><button role="tab" id="m${n}">Men</button><button role="tab" id="w${n}">Women</button></div><div id="p${n}"></div></div>`;
  const TWO_GUIDES = `<!doctype html><html lang="en"><head><title>Wide Leg Trousers</title><style>.dlg{display:none}.dlg.open{display:block}</style></head><body>
    <h1>Wide Leg Trousers</h1>
    <button id="g1" type="button"><span>Size</span> guide</button>
    <button id="g2" type="button" aria-label="Size chart"><span>Sizes</span></button>
    ${dialog(1, "Tops")}${dialog(2, "Bottoms")}
    <script>
      const $ = (id) => document.getElementById(id);
      $('g1').onclick = () => $('d1').classList.add('open');
      $('g2').onclick = () => $('d2').classList.add('open');
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.dlg').forEach((d) => d.classList.remove('open')); });
      $('m1').onclick = () => { $('p1').innerHTML = ${JSON.stringify(`<h3>Men</h3>${MEN_TABLE}`)}; };
      $('w1').onclick = () => { $('p1').innerHTML = ${JSON.stringify(`<h3>Women</h3>${WOMEN_TABLE}`)}; };
      $('m2').onclick = () => { $('p2').innerHTML = ${JSON.stringify(`<h3>Men</h3>${MEN_PANTS}`)}; };
      $('w2').onclick = () => { $('p2').innerHTML = ${JSON.stringify(`<h3>Women</h3>${WOMEN_PANTS}`)}; };
    </script></body></html>`;
  /* A WooCommerce-style specs table under a guide button that does nothing, and a guide
     that opens a size-CONVERSION table (factory54) - only the second is "opened, unmeasured". */
  const SPECS = `<table class="woocommerce-product-attributes"><tr><th>Material</th><td>Cotton</td></tr><tr><th>Color</th><td>Blue</td></tr></table>`;
  const CONVERSION = `<table><tr><th>SIZE</th><th>FR</th><th>IT</th><th>UK</th><th>US</th></tr><tr><td>XS</td><td>34</td><td>38</td><td>6</td><td>2</td></tr><tr><td>S</td><td>36</td><td>40</td><td>8</td><td>4</td></tr><tr><td>M</td><td>38</td><td>42</td><td>10</td><td>6</td></tr></table>`;
  const NOOP = `<!doctype html><html lang="en"><head><title>Linen Shirt</title></head><body><h1>Linen Shirt</h1>${SPECS}
    <button id="sg" type="button">Size guide</button></body></html>`;
  const CONV_PAGE = `<!doctype html><html lang="en"><head><title>Silk Blouse</title></head><body><h1>Silk Blouse</h1>
    <button id="sg" type="button">Size guide</button>
    <script>document.getElementById('sg').onclick = () => { const d = document.createElement('div'); d.setAttribute('role', 'dialog');
      d.innerHTML = ${JSON.stringify(`<h2>Size guide</h2>${CONVERSION}`)}; document.body.appendChild(d); };</script></body></html>`;
  /* Two triggers that open the SAME guide (pre-rendered, hidden again by Escape): the
     second opening re-reads a chart already found - it held measurements, so it is not
     "unmeasured" just because de-duplication added nothing new. */
  const REOPEN = `<!doctype html><html lang="en"><head><title>Crew Tee</title><style>.dlg{display:none}.dlg.open{display:block}</style></head><body>
    <h1>Crew Tee</h1><button id="o1" type="button">Size guide</button><button id="o2" type="button">Size chart</button>
    <div role="dialog" class="dlg" id="d"><h2>Size guide</h2><h3>Men</h3>${MEN_TABLE}</div>
    <script>
      for (const id of ['o1', 'o2']) document.getElementById(id).onclick = () => document.getElementById('d').classList.add('open');
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('d').classList.remove('open'); });
    </script></body></html>`;
  /* Shopify Dawn's size-guide popup (.product-popup-modal) is in the DOM from the start,
     hidden by visibility:hidden + opacity:0 - it keeps its layout box. Measured by box alone
     its conversion table was "visible before the click", so the guide that opened it was
     never counted (js_unreadable instead of no_measurements), and its hidden tabs were
     clicked into 3 s timeouts before it ever opened. */
  const DAWN = `<!doctype html><html lang="en"><head><title>Oxford Shirt</title><style>
    .product-popup-modal{position:fixed;inset:0;opacity:0;visibility:hidden;background:#fff}
    .product-popup-modal[open]{opacity:1;visibility:visible}</style></head><body><h1>Oxford Shirt</h1>
    <button id="sg" type="button">Size guide</button>
    <div class="product-popup-modal" id="pm" role="dialog"><h2>Size guide</h2>${CONVERSION}</div>
    <script>document.getElementById('sg').onclick = () => document.getElementById('pm').setAttribute('open', '');
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('pm').removeAttribute('open'); });</script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/blocked")) { hits403++; res.writeHead(403, { "content-type": "text/html" }); return res.end("<html><head><title>Forbidden</title></head><body>no</body></html>"); }
    if (req.url.startsWith("/cart/")) { cartHits++; res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    if (req.url === "/page-tab") { pageTabHits++; res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    if (req.url === "/api/size-guide.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ title: "Kids size chart", sizes: [{ size: "S", chest: "60-64", waist: "55-58" }, { size: "M", chest: "65-69", waist: "59-62" }, { size: "L", chest: "70-74", waist: "63-66" }] }));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/products/two-guides") return res.end(TWO_GUIDES);
    if (req.url === "/products/noop") return res.end(NOOP);
    if (req.url === "/products/conversion") return res.end(CONV_PAGE);
    if (req.url === "/products/reopen") return res.end(REOPEN);
    if (req.url === "/products/dawn") return res.end(DAWN);
    res.end(req.url === "/products/b" ? PDP("חולצה B", "<span>טבלת</span> <span>מידות</span>") : PDP("חולצה A", "מדריך מידות"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let run = null, launchError = null;
  try {
    run = await captureWithBrowser(base, { productUrls: [`${base}/products/a`, `${base}/products/b`], delayMs: 0, log: () => {}, JSDOM });
    if (run.report.status === "browser_unavailable") { launchError = run.report.errors[0]; run = null; }
  } catch (e) {
    /* Only a browser that cannot be had is a SKIP - captureWithBrowser reports that as
       browser_unavailable. Anything thrown is a crash in the real-browser path. */
    check("§5.0 captureWithBrowser runs without throwing", false, e && e.stack);
  }
  if (!run && launchError) {
    console.log(`SKIP  §5 Chromium unavailable here (${String(launchError).split("\n")[0]}) - run \`npx playwright install chromium\``);
  } else if (run) {
    const genders = new Set(run.found.filter((f) => f.source === "browser_modal").map((f) => f.chart.classification.gender));
    check("§5.1 the trigger was clicked on both pages - also B's, whose words sit in child spans (<span>טבלת</span> <span>מידות</span>)",
      run.report.triggers_clicked === 2, JSON.stringify(run.report));
    check("§5.1b ...and the cart never - not the page's button (<body class=\"modal-open\">, a class containing 'tab'), not the guide's own CTA",
      cartHits === 0, JSON.stringify({ cartHits, tabs: run.report.tabs_clicked }));
    check("§5.1c <body class=\"modal-open\"> is not a guide: the page's own nav-tabs are never clicked, only the guide's two tabs per page",
      pageTabHits === 0 && run.report.tabs_clicked === 4, JSON.stringify({ pageTabHits, tabs: run.report.tabs_clicked }));
    check("§5.2 both tabs were clicked and BOTH tab tables captured (men + women)", genders.has("men") && genders.has("women"),
      JSON.stringify(run.found.map((f) => [f.source, f.chart.classification.gender])));
    check("§5.3 the JSON the guide fetched was captured as browser_network", run.found.some((f) => f.source === "browser_network" && f.chart.rows[0].minChest === 60),
      JSON.stringify(run.report.methods));
    const recs = buildRecords(run.found, "127.0.0.1.example");
    check("§5.4 the same guide on 2 pages -> store-wide records", recs.some((r) => r.product_key === "" && r.gender === "men"),
      JSON.stringify(recs.map((r) => [r.gender, r.source, r.product_key])));
    const blocked = await captureWithBrowser(base, { productUrls: [`${base}/blocked/1`, `${base}/blocked/2`, `${base}/blocked/3`], delayMs: 0, log: () => {}, JSDOM });
    check("§5.5 a 403 is reported as BLOCKED and the run stops after two refusals (no third request)",
      blocked.report.status === "blocked" && hits403 === 2 && blocked.found.length === 0, JSON.stringify({ status: blocked.report.status, hits403 }));

    const two = await captureWithBrowser(base, { productUrls: [`${base}/products/two-guides`], delayMs: 0, log: () => {}, JSDOM });
    check("§5.6 triggers whose label is split (<span>Size</span> guide; aria-label 'Size chart' over 'Sizes') are both clicked",
      two.report.triggers_clicked === 2, JSON.stringify(two.report));
    const modal = two.found.filter((f) => f.source === "browser_modal");
    const has = (gender, field) => modal.some((f) => f.chart.classification.gender === gender && f.chart.rows[0][field] != null);
    check("§5.7 the SECOND guide's tabs are clicked too (no stale tab id from the first, hidden guide) - all four charts read",
      two.report.tabs_clicked === 4 && has("men", "minChest") && has("women", "minChest") && has("men", "minHips") && has("women", "minHips") &&
      two.report.unmeasured_guides === 0,
      JSON.stringify({ tabs: two.report.tabs_clicked, unmeasured: two.report.unmeasured_guides, found: modal.map((f) => [f.chart.classification.gender, Object.keys(f.chart.rows[0]).join(",")]) }));

    const um = await captureWithBrowser(base, { productUrls: [`${base}/products/noop`, `${base}/products/conversion`, `${base}/products/reopen`], delayMs: 0, log: () => {}, JSDOM });
    check("§5.8 a click that opened nothing over a product-specs table is NOT an unmeasured guide; a guide that opened a conversion table is",
      um.report.triggers_clicked >= 2 && um.report.unmeasured_examples.includes(`${base}/products/conversion`) &&
      !um.report.unmeasured_examples.includes(`${base}/products/noop`), JSON.stringify(um.report));
    check("§5.9 a guide opened twice (its chart already found) is not counted as unmeasured - only the conversion guide is",
      um.report.triggers_clicked === 4 && um.report.unmeasured_guides === 1 &&
      um.found.length === 1 && um.found[0].productUrl === `${base}/products/reopen`, JSON.stringify({ report: um.report, found: um.found.map((f) => [f.source, f.productUrl]) }));

    const dawn = await captureWithBrowser(base, { productUrls: [`${base}/products/dawn`], delayMs: 0, log: () => {}, JSDOM });
    check("§5.10 a guide hidden by visibility:hidden + opacity:0 (Dawn's popup - it keeps its box) that the click shows IS an opened guide",
      dawn.report.triggers_clicked === 1 && dawn.report.unmeasured_guides === 1 && dawn.report.unmeasured_examples.includes(`${base}/products/dawn`),
      JSON.stringify(dawn.report));
  }
  server.close();
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("browser-capture: all checks passed.");
