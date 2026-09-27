/* THE STORE SCANNER'S SIZE-GUIDE CAPTURE - scanner/size-charts.js against a fake store
   ─────────────────────────────────────────────────────────────────────────────
   Runs discoverSizeCharts() against an in-memory storefront (a fake fetch - no network,
   no Supabase) and pins:
   §1 coverage reporting - each capture path is counted, and the outcome names the
      strongest one that succeeded (captured > image_chart_detected > js_app_detected >
      none_found), plus "unreachable" for a store that never answered;
   §2 what gets STORED - one row per (gender, age, type, scope, source), labelled from
      the table's own surroundings (the "Men" heading above the men's table), aliases
      carried, body bands in cm, no height/weight anywhere;
   §3 scope - an inline PDP chart seen on 2+ products is store-wide (product_key ""),
      seen once it stays product-scoped; a linked guide page is always store-wide;
   §4 labelling rules (Hebrew, "women" never "men", jeans vs bottoms, kids);
   §5 saving - the upsert shape, and the missing-table case degrading to a warning.
   ============================================================================= */
import { JSDOM } from "jsdom";
import {
  discoverSizeCharts, buildRecords, classifyContextText, classifyChart, canonicalStoreHost,
  saveSizeChartRecords, isMissingTableError, formatReport, toStoredRows, looksLikeBotChallenge,
} from "../scanner/size-charts.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const BASE = "https://www.teststore.example";
const INLINE = `<div class="size-guide"><table>
  <tr><th>Size</th><th>Chest (cm)</th><th>Waist (cm)</th></tr>
  <tr><td>S</td><td>88-94</td><td>74-80</td></tr><tr><td>M</td><td>95-101</td><td>81-87</td></tr>
  <tr><td>L</td><td>102-108</td><td>88-94</td></tr></table></div>`;
const pdp = (body, title = "Tee") => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const GUIDE = `<html><head><title>Size guide</title></head><body><h1>Size guide</h1>
  <section><h3>Men's tops</h3><table>
    <tr><th>Size</th><th>EU</th><th>Chest</th></tr>
    <tr><td>S</td><td>46</td><td>90-95</td></tr><tr><td>M</td><td>48</td><td>96-101</td></tr><tr><td>L</td><td>50</td><td>102-107</td></tr>
  </table></section>
  <section><h3>Women's tops</h3><table>
    <tr><th>Size</th><th>Bust</th><th>Waist</th></tr>
    <tr><td>36</td><td>82-85</td><td>64-67</td></tr><tr><td>38</td><td>86-89</td><td>68-71</td></tr><tr><td>40</td><td>90-93</td><td>72-75</td></tr>
  </table></section>
  <section><h3>Men's jeans</h3><table>
    <tr><th>Waist size</th><th>Waist (cm)</th><th>Hips (cm)</th></tr>
    <tr><td>30</td><td>76-78</td><td>97-99</td></tr><tr><td>32</td><td>81-83</td><td>102-104</td></tr><tr><td>34</td><td>86-88</td><td>107-109</td></tr>
  </table></section>
  <section><h3>Kids</h3><table>
    <tr><th>Size</th><th>Chest</th></tr><tr><td>8</td><td>64-67</td></tr><tr><td>10</td><td>68-71</td></tr>
  </table></section>
</body></html>`;

function fakeStore(pages) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    const key = url.replace(BASE, "") || "/";
    if (!(key in pages)) return { ok: false, status: 404, url, contentType: "text/html", text: "" };
    const v = pages[key];
    if (v && typeof v === "object") return { ok: true, status: 200, url, contentType: v.contentType, text: v.text || "" };
    return { ok: true, status: 200, url, contentType: "text/html", text: v };
  };
  return { fetchText, calls };
}

const STORE = {
  "/": pdp("<a href='/products/a'>A</a>", "Home"),
  "/robots.txt": `User-agent: *\nSitemap: ${BASE}/sitemap.xml\n`,
  "/sitemap.xml": `<urlset><url><loc>${BASE}/products/a</loc></url><url><loc>${BASE}/products/b</loc></url>
    <url><loc>${BASE}/products/c</loc></url><url><loc>${BASE}/about</loc></url></urlset>`,
  "/products/a": pdp(INLINE + `<a href="/pages/size-guide">Size guide</a>`, "Men's Tee"),
  "/products/b": pdp(INLINE + `<button class="js-size-guide">Size chart</button>`, "Men's Tee 2"),
  "/products/c": pdp(`<img src="/files/size-chart-tops.jpg" alt="size chart"><script src="https://cdn.kiwisizing.com/x.js"></script>`, "Hoodie"),
  "/pages/size-guide": GUIDE,
};

console.log("\n── §1 coverage reporting ──");
const { fetchText, calls } = fakeStore(STORE);
const { report, records } = await discoverSizeCharts(BASE, { fetchText, delayMs: 0, log: () => {}, JSDOM });
{
  check("§1.1 store host is canonical", report.store_domain === "teststore.example", report.store_domain);
  check("§1.2 products sampled from the sitemap (the /about URL is not a product)",
    report.sampled_products === 3, String(report.sampled_products));
  check("§1.3 inline_table counted per page", report.paths.inline_table.pages_with_chart === 2 &&
    report.paths.inline_table.pages_checked === 3, JSON.stringify(report.paths.inline_table));
  check("§1.4 linked_page: the guide link was followed and read",
    report.paths.linked_page.links_found === 1 && report.paths.linked_page.pages_with_chart === 1,
    JSON.stringify(report.paths.linked_page));
  check("§1.5 image_chart_detected counts the size-chart image",
    report.paths.image_chart_detected.count >= 1 &&
    report.paths.image_chart_detected.examples.some((u) => /size-chart-tops\.jpg/.test(u)),
    JSON.stringify(report.paths.image_chart_detected));
  check("§1.6 js_app_detected names the app, and counts the linkless trigger",
    report.paths.js_app_detected.apps.includes("kiwisizing") && report.paths.js_app_detected.triggers_without_link >= 1,
    JSON.stringify(report.paths.js_app_detected));
  check("§1.7 outcome = captured", report.outcome === "captured", report.outcome);
  check("§1.8 the dry run never fetched anything off-store",
    calls.every((u) => u.startsWith(BASE)), calls.filter((u) => !u.startsWith(BASE)).join(","));
  const text = formatReport(report);
  check("§1.9 the report ends in one machine-readable COVERAGE_JSON line",
    /\nCOVERAGE_JSON \{.*"outcome":"captured".*\}$/.test(text), text.split("\n").pop());
}

console.log("\n── §2 what gets stored ──");
{
  const find = (g, a, t, src) => records.find((r) => r.gender === g && r.age_group === a && r.garment_type === t && (!src || r.source === src));
  const men = find("men", "adult", "tops", "linked_page");
  const women = find("women", "adult", "tops", "linked_page");
  const jeans = find("men", "adult", "jeans", "linked_page");
  const kids = records.find((r) => r.age_group === "kids");
  check("§2.1 the men's table is labelled men/adult/tops from its own heading", !!men,
    JSON.stringify(records.map((r) => [r.gender, r.age_group, r.garment_type, r.source])));
  check("§2.2 the women's table is labelled women/adult/tops", !!women);
  check("§2.3 the jeans table is men/adult/jeans (not bottoms, not tops)", !!jeans);
  check("§2.4 the kids table is kids", !!kids && kids.garment_type === "tops", JSON.stringify(kids && [kids.gender, kids.garment_type]));
  check("§2.5 stored rows carry body bands in cm", men && men.rows[1].size === "M" &&
    men.rows[1].body.chest[0] === 96 && men.rows[1].body.chest[1] === 101, JSON.stringify(men && men.rows[1]));
  check("§2.6 ...and the store's own EU column as an alias", men && men.rows[1].aliases && men.rows[1].aliases.eu === "48",
    JSON.stringify(men && men.rows[1]));
  check("§2.7 bust is stored as chest", women && women.rows[0].body.chest[0] === 82, JSON.stringify(women && women.rows[0]));
  check("§2.8 no row anywhere carries a height or weight", !JSON.stringify(records.map((r) => r.rows)).match(/height|weight/i));
  check("§2.9 every record has a content hash and the parser version",
    records.every((r) => /^[0-9a-f]{32}$/.test(r.content_hash) && r.parser_version === 1 && r.status === "active"));
  check("§2.10 the source table is snapshotted for audit", men && /<table/i.test(men.raw_snapshot || ""));
  check("§2.11 legs is stored as outseam, never as a bare 'legs'",
    JSON.stringify(toStoredRows([{ size: "M", minLegs: 98, maxLegs: 104 }])) === '[{"size":"M","body":{"outseam":[98,104]}}]');
}

console.log("\n── §3 scope ──");
{
  const inline = records.filter((r) => r.source === "inline_table");
  check("§3.1 the PDP chart seen on two products is store-wide", inline.length === 1 && inline[0].product_key === "",
    JSON.stringify(inline.map((r) => [r.product_key, r.sightings])));
  check("§3.2 ...with both sightings counted", inline[0] && inline[0].sightings === 2);
  check("§3.3 linked-page charts are always store-wide", records.filter((r) => r.source === "linked_page").every((r) => r.product_key === ""));

  const once = buildRecords([{
    chart: { rows: [{ size: "S", minChest: 88, maxChest: 94 }, { size: "M", minChest: 95, maxChest: 101 }],
      classification: classifyChart([{ size: "S", minChest: 88 }], "", ""), rawSnapshot: "" },
    source: "inline_table", sourceUrl: BASE + "/products/x", productUrl: BASE + "/products/x",
  }], "teststore.example");
  check("§3.4 a PDP chart seen ONCE stays product-scoped", once[0] && once[0].product_key === BASE + "/products/x",
    JSON.stringify(once[0] && once[0].product_key));
}

console.log("\n── §4 labelling ──");
{
  check("§4.1 'Women's tops' is women, never men", classifyContextText("Women's tops").gender === "women");
  check("§4.2 Hebrew men with a prefix letter", classifyContextText("טבלת מידות לגברים").gender === "men");
  check("§4.3 Hebrew jeans with a geresh", classifyContextText("ג׳ינס גברים").garmentType === "jeans");
  check("§4.4 'Jeans & Trousers' is a jeans chart", classifyContextText("Jeans & Trousers").garmentType === "jeans");
  check("§4.5 'Tops & Bottoms' is ambiguous - no type from context",
    classifyContextText("Tops & Bottoms").garmentType === null);
  check("§4.6 men AND women named -> no gender", classifyContextText("Men | Women").gender === null);
  check("§4.7 boys -> kids, cut for men", classifyContextText("Boys shirts").kids && classifyContextText("Boys shirts").gender === "men");
  const byColumns = classifyChart([{ size: "S", minWaist: 70, maxWaist: 74 }, { size: "M", minWaist: 75, maxWaist: 79 }], "", "");
  check("§4.8 no words at all -> type from columns (waist only = bottoms), gender unknown",
    byColumns.garmentType === "bottoms" && byColumns.gender === "unknown" && byColumns.typeFrom === "columns",
    JSON.stringify(byColumns));
  check("§4.9 an all-kids-numeric run is kids even unlabelled",
    classifyChart([{ size: "8", minChest: 64 }, { size: "10", minChest: 68 }], "", "").ageGroup === "kids");
  check("§4.10 canonicalStoreHost (the key) is the widget's rule",
    canonicalStoreHost("https://www.FOX.co.il/") === "fox.co.il" && canonicalStoreHost("m.castro.com") === "castro.com");
}

console.log("\n── §1b the other outcomes ──");
{
  const none = fakeStore({ "/": pdp("<p>hi</p>"), "/sitemap.xml": `<urlset><url><loc>${BASE}/products/z</loc></url></urlset>`,
    "/products/z": pdp("<p>no guide</p>") });
  const r1 = await discoverSizeCharts(BASE, { fetchText: none.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§1b.1 nothing anywhere -> none_found, no records", r1.report.outcome === "none_found" && r1.records.length === 0,
    r1.report.outcome);

  const img = fakeStore({ "/": pdp(""), "/sitemap.xml": `<urlset><url><loc>${BASE}/products/z</loc></url></urlset>`,
    "/products/z": pdp(`<a href="/files/guide.pdf">Size guide</a>`) });
  const r2 = await discoverSizeCharts(BASE, { fetchText: img.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§1b.2 a PDF guide -> image_chart_detected (Phase 3), never parsed",
    r2.report.outcome === "image_chart_detected" && r2.records.length === 0, r2.report.outcome);

  const down = await discoverSizeCharts(BASE, { fetchText: async () => ({ ok: false, status: 503, text: "" }), delayMs: 0, log: () => {}, JSDOM });
  check("§1b.3 a store that is down -> unreachable, with the status in errors",
    down.report.outcome === "unreachable" && /503/.test(down.report.errors[0] || ""), JSON.stringify(down.report.errors));
  const refused = await discoverSizeCharts(BASE, { fetchText: async () => ({ ok: false, status: 403, text: "" }), delayMs: 0, log: () => {}, JSDOM });
  check("§1b.3b a 403 on the home page -> blocked_by_bot_protection (the store is up, we are refused)",
    refused.report.outcome === "blocked_by_bot_protection" && /403/.test(refused.report.errors[0] || ""), refused.report.outcome);

  /* What adidas.co.il actually serves a plain HTTP client for /sitemap.xml: a 200 HTML
     page that is nothing but a challenge script. "none_found" would be a false claim. */
  const CHALLENGE = { contentType: "text/html", text: `<!DOCTYPE html>\n<html>\n<body><script type="text/javascript" src="/KuXdAWFc8Q0yU/-/i3doh8KG?v=1"></script></body></html>` };
  const blocked = fakeStore({ "/": pdp("<p>home</p>"), "/robots.txt": `Sitemap: ${BASE}/sitemap.xml`, "/sitemap.xml": CHALLENGE });
  const r3 = await discoverSizeCharts(BASE, { fetchText: blocked.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§1b.4 a bot-protection challenge is reported as blocked, not none_found",
    r3.report.outcome === "blocked_by_bot_protection" && r3.report.blocked.count >= 1, `${r3.report.outcome} / ${r3.report.blocked.count}`);
  check("§1b.5 ...and the report says so", /bot protection: +\d+ challenged/.test(formatReport(r3.report)) &&
    /"blocked":[1-9]/.test(formatReport(r3.report)));
  const homeBlocked = fakeStore({ "/": CHALLENGE });
  const r4 = await discoverSizeCharts(BASE, { fetchText: homeBlocked.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§1b.6 a challenged home page -> blocked_by_bot_protection", r4.report.outcome === "blocked_by_bot_protection", r4.report.outcome);
  const real = { ok: true, contentType: "text/html", text: pdp("<p>" + "real product copy ".repeat(20) + "</p><script src='/app.js'></script>") };
  check("§1b.7 a small but REAL page is not mistaken for a challenge", !looksLikeBotChallenge(real));

  /* What terminalx.com ships: the chart id in the PDP's embedded state, content loaded
     by client JS. The store has a chart; only the widget can see it. */
  const stateStore = fakeStore({ "/": pdp(""), "/sitemap.xml": `<urlset><url><loc>${BASE}/products/z</loc></url></urlset>`,
    "/products/z": pdp(`<script>window.__STATE__={"blocks":{"size_chart":"sizechart_terminal_x_kids_5","brand":"x"}}</script><p>${"copy ".repeat(40)}</p>`) });
  const r5 = await discoverSizeCharts(BASE, { fetchText: stateStore.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§1b.8 a chart referenced from page state -> js_app_detected, naming the reference",
    r5.report.outcome === "js_app_detected" && r5.report.paths.js_app_detected.apps.some((a) => /sizechart_terminal_x_kids_5/.test(a)),
    JSON.stringify(r5.report.paths.js_app_detected));
}

console.log("\n── §5 saving ──");
{
  let upserted = null, opts = null;
  const okClient = { from: (t) => ({ upsert: async (rows, o) => { upserted = { t, rows }; opts = o; return { error: null }; } }) };
  const res = await saveSizeChartRecords(okClient, records, () => {});
  check("§5.1 all records upserted into store_size_charts", res.saved === records.length && upserted.t === "store_size_charts");
  check("§5.2 ...on the table's unique key", opts.onConflict === "store_domain,gender,age_group,garment_type,product_key,source");
  check("§5.3 ...with timestamps", upserted.rows.every((r) => r.updated_at && r.captured_at));

  const logs = [];
  const missing = { from: () => ({ upsert: async () => ({ error: { code: "PGRST205", message: "Could not find the table 'public.store_size_charts' in the schema cache" } }) }) };
  const res2 = await saveSizeChartRecords(missing, records, (m) => logs.push(m));
  check("§5.4 migration not run -> skipped with a pointer to v15, no throw",
    res2.saved === 0 && res2.skipped === "table_missing" && logs.some((l) => /supabase_setup_v15\.sql/.test(l)), JSON.stringify(res2));
  check("§5.5 42P01 is recognised too", isMissingTableError({ code: "42P01", message: 'relation "store_size_charts" does not exist' }));
  const broken = { from: () => ({ upsert: async () => ({ error: { code: "23505", message: "boom" } }) }) };
  let threw = false;
  try { await saveSizeChartRecords(broken, records, () => {}); } catch { threw = true; }
  check("§5.6 any OTHER database error is loud (a real failure must not look like success)", threw);
  check("§5.7 no client -> nothing saved, no throw", (await saveSizeChartRecords(null, records)).skipped === "no_supabase");
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("scanner-size-charts: all checks passed.");
