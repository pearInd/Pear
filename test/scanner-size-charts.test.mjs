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
   §5 saving - the upsert shape, and the missing-table case degrading to a warning;
   §6 castro.com's shape - a `data_url` popup trigger, a JSON {html} envelope, guide
      blocks with no audience word (gender from the linking PDPs), a blazers table, and
      well-known guide paths that answer with the home page;
   §7 the product sampler - category URLs are not products (terminalx.com);
   §8 one spelling per product key (fox.co.il's raw Hebrew Shopify handle);
   §9 adidas.co.il's shape - Salesforce Commerce Cloud platform detection, an ARIA
      div-grid chart with no <table> at all, a JSON {content} envelope, a hidden icon
      riding an already-followed trigger, a reused 'kids-table' skin class, and a
      cm cell with no space before the unit.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  discoverSizeCharts, buildRecords, classifyContextText, classifyChart, canonicalStoreHost,
  saveSizeChartRecords, isMissingTableError, formatReport, toStoredRows, looksLikeBotChallenge,
  unwrapHtmlEnvelope, isHomeEcho, referrerAudience, normalizePageUrl, isProductPathUrl, detectPlatform,
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
  check("§5.2 ...on the v16 unique key, size_system included",
    opts.onConflict === "store_domain,gender,age_group,garment_type,size_system,product_key,source", opts.onConflict);
  /* archive/supabase_setup_v16.sql must declare exactly that index, and drop the v15 one
     (which would still reject a second chart per audience/type while it exists). */
  const V16 = readFileSync(new URL("../archive/supabase_setup_v16.sql", import.meta.url), "utf8");
  check("§5.2b v16 creates the same 7-column unique index and drops the v15 key",
    /CREATE UNIQUE INDEX IF NOT EXISTS store_size_charts_key_v16_idx\s+ON store_size_charts \(store_domain, gender, age_group, garment_type, size_system, product_key, source\)/.test(V16) &&
    /DROP INDEX IF EXISTS store_size_charts_key_idx;/.test(V16));
  const keyLogs = [];
  const oldKey = { from: () => ({ upsert: async () => ({ error: { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" } }) }) };
  const res42 = await saveSizeChartRecords(oldKey, records, (m) => keyLogs.push(m));
  check("§5.2c v16 not run (42P10) -> nothing written, a pointer to v16, no throw, no fallback to the old key",
    res42.saved === 0 && res42.skipped === "key_migration_missing" && keyLogs.some((l) => /supabase_setup_v16\.sql/.test(l)), JSON.stringify(res42));
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

console.log("\n── §6 castro.com's shape ──");
{
  /* What castro.com serves, trimmed: Hebrew department paths with no product pattern
     word, a popup trigger whose href is javascript: and whose address sits in a
     `data_url` attribute, and a static-block endpoint answering JSON with the markup in
     an `html` field - served as text/html. */
  const enc = (p) => encodeURI(p);
  const WOMEN_PDP = enc("/נשים/סריגים/סריג-במפתח-4910123");
  const WOMEN_PDP2 = enc("/נשים/חולצות/בגד-גוף-7b10281");
  const MEN_PDP = enc("/גברים/חולצות/פולו-בייסיק-7770379");
  const trigger = (id) => `<div class="size_chart"><a class="product_staticblock_popup_link" role="button"
    title="טבלת מידות" data_url="${BASE}/idus/staticblock/view?id=${id}" href="javascript: void(0)" onclick="return false;"></a></div>`;
  const WOMEN_BLOCK = `<p>טיפים למדידה</p><p>מצאי בקלות את מידת החזה, המותן והירכיים. התאימי את מידת הבגד לפי הטבלה.</p>
    <table><caption>פרטי הלבשה</caption>
      <tr><td>מידה</td><td>היקף חזה (ס"מ)</td><td>היקף מותן (ס"מ)</td><td>היקף ירכיים (ס"מ)</td></tr>
      <tr><td>32</td><td>74-78</td><td>56-60</td><td>84-88</td></tr><tr><td>34</td><td>78-82</td><td>60-64</td><td>88-92</td></tr>
      <tr><td>36</td><td>82-86</td><td>64-68</td><td>92-96</td></tr><tr><td>38</td><td>86-90</td><td>68-72</td><td>96-100</td></tr></table>
    <table><caption>פרטי הלבשה</caption>
      <tr><td>מידה</td><td>היקף חזה (ס"מ)</td><td>היקף מותן (ס"מ)</td><td>היקף ירכיים (ס"מ)</td></tr>
      <tr><td>XS</td><td>84-88</td><td>65-69</td><td>88-92</td></tr><tr><td>S</td><td>89-93</td><td>70-74</td><td>93-97</td></tr>
      <tr><td>M</td><td>94-98</td><td>75-79</td><td>98-102</td></tr></table>`;
  const MEN_BLOCK = `<table><caption>חולצות / טישרטים / סריגים / מעילים</caption>
      <tr><td>מידה</td><td>היקף חזה (ס"מ)</td><td>מידה אירופאית</td></tr>
      <tr><td>XS</td><td>88-92</td><td>36</td></tr><tr><td>S</td><td>93-97</td><td>38</td></tr><tr><td>M</td><td>98-103</td><td>40</td></tr></table>
    <table><caption>בלייזרים וחליפות</caption>
      <tr><td>מידה</td><td>היקף מותניים (ס"מ)</td></tr>
      <tr><td>48</td><td>96-100</td></tr><tr><td>50</td><td>100-104</td></tr><tr><td>52</td><td>104-108</td></tr></table>`;
  const envelope = (html) => ({ contentType: "text/html; charset=utf-8", text: JSON.stringify({ success: true, html }) });
  const HOME = pdp("<p>" + "castro home ".repeat(30) + "</p>", "קסטרו");
  const castro = fakeStore({
    "/": HOME,
    "/sitemap.xml": `<urlset>${[WOMEN_PDP, WOMEN_PDP2, MEN_PDP].map((p) => `<url><loc>${BASE}${p}</loc></url>`).join("")}</urlset>`,
    [WOMEN_PDP]: pdp(trigger(41), "סריג במפתח"),
    [WOMEN_PDP2]: pdp(trigger(41), "בגד גוף"),
    [MEN_PDP]: pdp(trigger(44), "פולו בייסיק"),
    "/idus/staticblock/view?id=41": envelope(WOMEN_BLOCK),
    "/idus/staticblock/view?id=44": envelope(MEN_BLOCK),
  });
  const { report: cr, records: crec } = await discoverSizeCharts(BASE, { fetchText: castro.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§6.1 the data_url (underscore) trigger is followed, not counted as a linkless JS trigger",
    cr.paths.linked_page.links_found === 2 && cr.paths.js_app_detected.triggers_without_link === 0 &&
    castro.calls.some((u) => /staticblock\/view\?id=41/.test(u)), JSON.stringify(cr.paths));
  check("§6.2 the JSON {html} envelope is unwrapped and its tables read -> captured",
    cr.outcome === "captured" && cr.paths.linked_page.pages_with_chart === 2, JSON.stringify([cr.outcome, cr.paths.linked_page]));
  const w = crec.find((r) => r.gender === "women"), m = crec.find((r) => r.gender === "men");
  check("§6.3 the women's block takes its gender from the /נשים/ PDPs that open it",
    !!w && w.age_group === "adult" && w.garment_type === "tops" && w.product_key === "", JSON.stringify(crec.map((r) => [r.gender, r.garment_type])));
  check("§6.4 the men's block takes 'men' from the /גברים/ PDP, type from its own caption",
    !!m && m.garment_type === "tops" && m.rows[0].size === "XS" && m.rows[0].aliases && m.rows[0].aliases.eu === "36", JSON.stringify(m));
  check("§6.5 a referrer-derived gender is less confident than a labelled one", w && m && w.confidence < 0.9 && m.confidence < 0.9);
  /* Under the v15 key these two collided and the EU one was DROPPED. Since v16
     size_system is in the key: both are records, nothing is reported as a conflict. */
  const wAlpha = crec.find((r) => r.gender === "women" && r.size_system === "alpha");
  const wNum = crec.find((r) => r.gender === "women" && r.size_system === "numeric");
  check("§6.6 two women's tops tables (EU numeric + XS-XL): BOTH are kept, one row per size system",
    wAlpha && wNum && wAlpha.rows.map((r) => r.size).join("/") === "XS/S/M" && wNum.rows[0].size === "32" &&
    wAlpha.garment_type === "tops" && wNum.garment_type === "tops",
    JSON.stringify(crec.map((r) => [r.gender, r.size_system, r.rows.map((x) => x.size).join("/")])));
  check("§6.6b ...and neither is reported as a dropped conflict",
    !cr.conflicts.some((c) => /two different charts/.test(c.reason)), JSON.stringify(cr.conflicts));
  check("§6.7 the blazers & suits table is NOT stored as bottoms (waist-only columns do not type it)",
    !crec.some((r) => r.garment_type === "bottoms") && cr.conflicts.some((c) => /no garment type/.test(c.reason)),
    JSON.stringify(crec.map((r) => [r.gender, r.garment_type, r.rows.map((x) => x.size).join("/")])));
  check("§6.8 no record carries a height or weight", !JSON.stringify(crec.map((r) => r.rows)).match(/height|weight/i));

  /* A PDP opened by a women's AND a men's page is nobody's in particular. */
  check("§6.9 referrerAudience: unanimous -> that gender", (referrerAudience(["/נשים/a", "/נשים/b"]) || {}).gender === "women");
  check("§6.10 referrerAudience: a dissenting referrer -> no gender", !(referrerAudience(["/נשים/a", "/גברים/b"]) || {}).gender);
  check("§6.11 referrerAudience: a labelled guide is never relabelled by its referrers",
    classifyChart([{ size: "S", minChest: 90 }, { size: "M", minChest: 95 }], "Men's tops", "", { gender: "women", kids: false }).gender === "men");
  const shared = fakeStore({
    "/": HOME,
    "/sitemap.xml": `<urlset>${[WOMEN_PDP, MEN_PDP].map((p) => `<url><loc>${BASE}${p}</loc></url>`).join("")}</urlset>`,
    [WOMEN_PDP]: pdp(trigger(41), "סריג"), [MEN_PDP]: pdp(trigger(41), "פולו"),
    "/idus/staticblock/view?id=41": envelope(WOMEN_BLOCK),
  });
  const sr = await discoverSizeCharts(BASE, { fetchText: shared.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§6.12 one block opened from men's AND women's PDPs stays gender unknown",
    sr.records.length > 0 && sr.records.every((r) => r.gender === "unknown"), JSON.stringify(sr.records.map((r) => r.gender)));

  check("§6.13 unwrapHtmlEnvelope: {success:false} is not a page",
    unwrapHtmlEnvelope({ ok: true, text: '{"success":false,"html":""}' }).ok === false);
  const plain = { ok: true, text: "<html><body>x</body></html>" };
  check("§6.14 unwrapHtmlEnvelope: HTML and html-less JSON pass through untouched",
    unwrapHtmlEnvelope(plain) === plain && unwrapHtmlEnvelope({ ok: true, text: '{"a":1}' }).text === '{"a":1}');

  /* castro's /size-guide and /size-chart: 200s carrying the home page. */
  const echo = fakeStore({
    "/": HOME,
    "/sitemap.xml": `<urlset><url><loc>${BASE}${WOMEN_PDP}</loc></url></urlset>`,
    [WOMEN_PDP]: pdp("<p>no guide here</p>", "סריג"),
    "/size-guide": HOME,
    "/size-chart": HOME.replace("castro home", "castro hone"),
  });
  const er = await discoverSizeCharts(BASE, { fetchText: echo.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§6.15 guide paths answering with the home page are missing, not fetched",
    er.report.paths.linked_page.home_echo === 2 && er.report.paths.linked_page.pages_fetched === 0 && er.report.outcome === "none_found",
    JSON.stringify(er.report.paths.linked_page));
  check("§6.16 ...and the report says so", /2 answered with the home page/.test(formatReport(er.report)) &&
    /"home_echo":2/.test(formatReport(er.report)));
  check("§6.17 isHomeEcho: a redirect to / is an echo", isHomeEcho({ text: "x", url: BASE + "/" }, { text: "y" }, BASE + "/size-guide"));
  check("§6.18 isHomeEcho: a real guide page with its own title is not",
    !isHomeEcho({ text: GUIDE, url: BASE + "/pages/size-guide" }, { text: HOME }, BASE + "/pages/size-guide"));
}

console.log("\n── §7 the product sampler ──");
{
  check("§7.1 /sports/products/tops is a category, not a product", !isProductPathUrl(BASE + "/sports/products/tops"));
  check("§7.2 Shopify shapes are products (/products/a, /he/products/x, /collections/c/products/x)",
    isProductPathUrl(BASE + "/products/a") && isProductPathUrl(BASE + "/he/products/x") && isProductPathUrl(BASE + "/collections/c/products/x"));
  check("§7.3 an id or a slug after a nested pattern is a product",
    isProductPathUrl(BASE + "/catalog/product/view/id/1246334") && isProductPathUrl(BASE + "/product/blue-cotton-tee"));
  check("§7.4 a bare /products/ is not a product", !isProductPathUrl(BASE + "/products/"));
  /* terminalx.com: 6 category URLs and 2 legacy product ids carry the pattern word; the
     real catalog is /w414418263-style SKU pages with no pattern word at all. */
  const cats = ["tops", "pants", "leggings", "accessories", "underwear", "swimwear"].map((c) => `${BASE}/sports/products/${c}`);
  const skus = Array.from({ length: 40 }, (_, i) => `${BASE}/w${414418000 + i}`);
  const tx = fakeStore({
    "/": pdp(""),
    "/sitemap.xml": `<urlset>${[...cats, `${BASE}/catalog/product/view/id/1246334`, `${BASE}/catalog/product/view/id/1858946`, ...skus]
      .map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`,
  });
  const tr = await discoverSizeCharts(BASE, { fetchText: tx.fetchText, delayMs: 0, maxProducts: 12, log: () => {}, JSDOM });
  const fetched = tx.calls.filter((u) => !/sitemap|robots|\/$|size-|sizing/.test(u));
  check("§7.5 no category page is sampled", !fetched.some((u) => /\/sports\/products\//.test(u)), JSON.stringify(fetched));
  check("§7.6 ...the sample is topped up with SKU pages to the full 12",
    tr.report.sampled_products === 12 && fetched.filter((u) => /\/w\d+$/.test(u)).length === 10, JSON.stringify([tr.report.sampled_products, fetched.length]));
}

console.log("\n── §8 one spelling per product key ──");
{
  const raw = BASE + "/products/חולצת-ניקי-חלקה";
  const encoded = BASE + "/products/" + encodeURIComponent("חולצת-ניקי-חלקה");
  check("§8.1 normalizePageUrl percent-encodes a raw Hebrew handle", normalizePageUrl(raw) === encoded, normalizePageUrl(raw));
  check("§8.2 ...and leaves an encoded one unchanged (idempotent)", normalizePageUrl(encoded) === encoded);
  const chart = { rows: [{ size: "S", minChest: 88, maxChest: 92 }, { size: "M", minChest: 93, maxChest: 97 }],
    classification: classifyChart([{ size: "S", minChest: 88 }], "", ""), rawSnapshot: "" };
  const [rec] = buildRecords([{ chart, source: "inline_table", sourceUrl: raw, productUrl: raw }], "teststore.example");
  check("§8.3 a product-scoped record is keyed by the encoded URL", rec && rec.product_key === encoded, rec && rec.product_key);
}

console.log("\n── §9 adidas.co.il's shape ──");
{
  /* What adidas.co.il (Salesforce Commerce Cloud) actually serves, trimmed:
       - a homepage that namedrops "Shopify" only inside an unrelated Global-e
         checkout-integration config key, and otherwise carries unambiguous SFCC/
         Demandware markers;
       - PDPs with NO inline chart at all - only a trigger <a> (already followed as a
         LINK by the existing loop) whose icon is a hidden, decoratively-classed <img>
         that must not be double-counted as an "image chart";
       - the guide itself behind a JSON envelope ({action,content,success}, not
         castro's {html}) whose content is an ARIA div-grid (role=table/row/
         columnheader/cell), never a <table> element, with the size ladder ACROSS the
         header and one row per measurement (chest/waist/hips DOWN the first column) -
         the transposed layout;
       - that same grid shipped TWICE, once per unit behind an Inches/cm toggle, with
         every cm cell written with NO space before the unit ("83 - 86cm");
       - a reused table-skin class, "kids-table___1-YOY", on BOTH the men's and
         women's ADULT charts - a CSS-Modules styling hook, not an audience claim. */
  const sizeChartJson = (content) => ({ contentType: "text/html; charset=utf-8",
    text: JSON.stringify({ action: "Product-SizeChart", success: true, content }) });
  const MENS_GRID = `<section class="size-guidance_container">
    <h5 class="gl-heading">MEN'S SHIRTS &amp; TOPS SIZING</h5>
    <div class="sizechart_header-links"><a href="#x">TALL/LONG &amp; SHORT SIZES</a></div>
    <div class="sizechart-toggles___Ssf6W"><button title="Inches">Inches</button></div>
    <div class="gl-table kids-table___1-YOY" role="table">
      <div role="row"><div role="columnheader">Product label</div><div role="columnheader">XS</div><div role="columnheader">S</div><div role="columnheader">M</div></div>
      <div role="row"><div role="rowheader">Chest</div><div role="cell">32 1/2 - 34"</div><div role="cell">34 1/2 - 36"</div><div role="cell">36 1/2 - 39"</div></div>
      <div role="row"><div role="rowheader">Waist</div><div role="cell">27 1/2 - 29"</div><div role="cell">29 1/2 - 31 1/2"</div><div role="cell">32 - 34 1/2"</div></div>
      <div role="row"><div role="rowheader">Hip</div><div role="cell">32 - 33 1/2"</div><div role="cell">34 - 36"</div><div role="cell">36 1/2 - 39"</div></div>
    </div>
    <p class="legend___3liGv">Scroll horizontally to see more.</p>
    <div class="sizechart-toggles___Ssf6W"><button title="cm">cm</button></div>
    <div class="gl-table kids-table___1-YOY" role="table">
      <div role="row"><div role="columnheader">Product label</div><div role="columnheader">XS</div><div role="columnheader">S</div><div role="columnheader">M</div></div>
      <div role="row"><div role="rowheader">Chest</div><div role="cell">83 - 86cm</div><div role="cell">87 - 92cm</div><div role="cell">93 - 100cm</div></div>
      <div role="row"><div role="rowheader">Waist</div><div role="cell">71 - 74cm</div><div role="cell">75 - 80cm</div><div role="cell">81 - 88cm</div></div>
      <div role="row"><div role="rowheader">Hip</div><div role="cell">82 - 85cm</div><div role="cell">86 - 91cm</div><div role="cell">92 - 99cm</div></div>
    </div>
  </section>`;
  const TRIGGER = `<div class="size-chart"><a class="sizechart" href="${BASE}/on/demandware.store/Sites-adidas-IL-Site/en_IL/Product-SizeChart?cid=size-m_tops" data-toggle="modal">
    <img class="sizeguide d-none" src="${BASE}/on/demandware.static/-/default/images/Union.png">Size Chart</a></div>`;
  const HOME = pdp(`<p>${"adidas home copy ".repeat(10)}</p>
    <script>var cfg={"UseShopifyCheckoutForPickUpDeliveryMethod":{"Value":"false"}};</script>
    <img src="${BASE}/on/demandware.static/Sites-adidas-IL-Site/-/default/dw1/images/hero.jpg">
    <a href="/on/demandware.store/Sites-adidas-IL-Site/en_IL">x</a>`, "adidas Israel");
  const adidas = fakeStore({
    "/": HOME,
    "/sitemap.xml": `<urlset><url><loc>${BASE}/en/primelift-3-stripes-tee/JE8239.html</loc></url></urlset>`,
    "/en/primelift-3-stripes-tee/JE8239.html": pdp(TRIGGER, "PRIMELIFT TEE"),
    "/on/demandware.store/Sites-adidas-IL-Site/en_IL/Product-SizeChart?cid=size-m_tops": sizeChartJson(MENS_GRID),
  });
  const { report: ar, records: arec } = await discoverSizeCharts(BASE, { fetchText: adidas.fetchText, delayMs: 0, log: () => {}, JSDOM });

  console.log("── §9.1 platform detection ──");
  check("§9.1a a Global-e config key namedropping \"Shopify\" is NOT read as the platform",
    detectPlatform(HOME) !== "shopify", detectPlatform(HOME));
  check("§9.1b adidas's own demandware.static/.store paths ARE read as the platform",
    detectPlatform(HOME) === "demandware", detectPlatform(HOME));
  check("§9.1c ...so products.json (Shopify-only) was never requested",
    !adidas.calls.some((u) => /products\.json/.test(u)), JSON.stringify(adidas.calls));
  check("§9.1d ...and the dry run reports it", ar.platform === "demandware", ar.platform);

  console.log("── §9.2-9.5 the captured chart ──");
  check("§9.2 Union.png (hidden icon riding the already-followed trigger) is not an image chart",
    ar.paths.image_chart_detected.count === 0, JSON.stringify(ar.paths.image_chart_detected));
  check("§9.3 the JSON {content} envelope (adidas's field name, not castro's {html}) is unwrapped",
    ar.outcome === "captured", ar.outcome);
  const men = arec.find((r) => r.gender === "men");
  check("§9.4 the ARIA div-grid (no <table> anywhere) is read, gender from the real heading - not 'kids-table'",
    !!men && men.age_group === "adult" && men.garment_type === "tops", JSON.stringify(arec.map((r) => [r.gender, r.age_group])));
  check("§9.5 the cm-declared grid wins the toggle pair - no space-before-unit means no silent ×2.54",
    men && men.rows[0].size === "XS" && men.rows[0].body.chest[0] === 83 && men.rows[0].body.chest[1] === 86,
    men && JSON.stringify(men.rows[0]));
  check("§9.6 ...all three measurements survived (chest/waist/hips), not just one",
    men && men.rows[0].body.waist && men.rows[0].body.hips, men && JSON.stringify(men.rows[0].body));
}

{
  /* A real image-chart-in-a-lightbox must still be found: an <a> whose OWN href is an
     image file (not a page/endpoint) is never an icon riding a followed link, even
     when SIZE_GUIDE_LINK_RE also matches its label. */
  const lightbox = fakeStore({
    "/": pdp("<a href='/products/a'>A</a>", "Home"),
    "/sitemap.xml": `<urlset><url><loc>${BASE}/products/a</loc></url></urlset>`,
    "/products/a": pdp(`<a class="size-guide-link" href="/img/size-chart-full.jpg"><img src="/img/size-chart-thumb.jpg" alt="size chart"></a>`, "Tee"),
  });
  const r = await discoverSizeCharts(BASE, { fetchText: lightbox.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§9.7 an image chart linked from a real lightbox (href IS an image file) is still found",
    r.report.paths.image_chart_detected.count >= 1, JSON.stringify(r.report.paths.image_chart_detected));
}

{
  /* A small icon with no "d-none"-style class, only explicit pixel dimensions. */
  const tiny = fakeStore({
    "/": pdp("<a href='/products/a'>A</a>", "Home"),
    "/sitemap.xml": `<urlset><url><loc>${BASE}/products/a</loc></url></urlset>`,
    "/products/a": pdp(`<div class="size-chart"><img class="sizeguide" width="16" height="16" src="/icons/ruler.png"></div>`, "Tee"),
  });
  const r = await discoverSizeCharts(BASE, { fetchText: tiny.fetchText, delayMs: 0, log: () => {}, JSDOM });
  check("§9.8 a bare 16x16 icon (no hidden class, just small dimensions) is not an image chart",
    r.report.paths.image_chart_detected.count === 0, JSON.stringify(r.report.paths.image_chart_detected));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("scanner-size-charts: all checks passed.");
