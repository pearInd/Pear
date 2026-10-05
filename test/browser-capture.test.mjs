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
   §5 REAL CHROMIUM against a local fixture store: click the trigger, click each tab,
      catch the JSON the guide fetched, and stop on a 403 - reported as BLOCKED.
      Skipped (not failed) only when Chromium cannot launch on this machine.
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

console.log("\n── §5 real Chromium against a local fixture store ──");
{
  let hits403 = 0;
  const PDP = (title) => `<!doctype html><html lang="he"><head><title>${title}</title></head><body><h1>${title}</h1>
    <button id="add">הוספה לסל</button>
    <button id="sg" type="button">מדריך מידות</button>
    <script>
      document.getElementById('add').onclick = () => { document.title = 'ADDED-TO-CART'; };
      document.getElementById('sg').onclick = async () => {
        const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.className = 'size-guide-modal';
        d.innerHTML = '<h2>מדריך מידות</h2><div class="tabs"><button role="tab" id="tm">גברים</button><button role="tab" id="tw">נשים</button></div><div id="panel"></div>';
        document.body.appendChild(d);
        const show = (html) => { document.getElementById('panel').innerHTML = html; };
        document.getElementById('tm').onclick = () => show(${JSON.stringify(`<h3>גברים</h3>${MEN_TABLE}`)});
        document.getElementById('tw').onclick = () => show(${JSON.stringify(`<h3>נשים</h3>${WOMEN_TABLE}`)});
        await fetch('/api/size-guide.json').then((r) => r.json());
      };
    </script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/blocked")) { hits403++; res.writeHead(403, { "content-type": "text/html" }); return res.end("<html><head><title>Forbidden</title></head><body>no</body></html>"); }
    if (req.url === "/api/size-guide.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ title: "Kids size chart", sizes: [{ size: "S", chest: "60-64", waist: "55-58" }, { size: "M", chest: "65-69", waist: "59-62" }, { size: "L", chest: "70-74", waist: "63-66" }] }));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PDP(req.url.includes("b") ? "חולצה B" : "חולצה A"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let run = null, launchError = null;
  try {
    run = await captureWithBrowser(base, { productUrls: [`${base}/products/a`, `${base}/products/b`], delayMs: 0, log: () => {}, JSDOM });
    if (run.report.status === "browser_unavailable") { launchError = run.report.errors[0]; run = null; }
  } catch (e) { launchError = e.message; }
  if (!run) {
    console.log(`SKIP  §5 Chromium unavailable here (${String(launchError).split("\n")[0]}) - run \`npx playwright install chromium\``);
  } else {
    const genders = new Set(run.found.filter((f) => f.source === "browser_modal").map((f) => f.chart.classification.gender));
    check("§5.1 the trigger was clicked on both pages, the cart button never", run.report.triggers_clicked === 2, JSON.stringify(run.report));
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
  }
  server.close();
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("browser-capture: all checks passed.");
