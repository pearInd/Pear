/* PHASE 2 - MANUAL IMPORT, the guaranteed way in (scanner/import-chart.js)
   ─────────────────────────────────────────────────────────────────────────────
   §1 THE THREE SOURCES - a URL (page, JSON envelope, or an image URL), a saved HTML
      file, a screenshot - each through the shared parser and buildRecords(), tagged
      manual_url / manual_html / manual_image, store-wide.
      A URL is routed by what it answered: image/*, an octet-stream download or an untyped
      image file to the image reader, a PDF to the "screenshot it" note, a page to the
      parser. A guide saved OPEN over a product page is typed by the guide, not the page.
   §2 OVERRIDES LABEL, THEY NEVER VALIDATE. --gender/--age/--type replace the labels of
      the charts --only picked (and are checked against the table's enums); they cannot
      turn a price table or an implausible chart into a record. Every table the parser
      accepted has ONE number, the same with or without flags (untyped tables too, named
      in a note); --only picks by it before the flags label; a collision is named.
   §3 INPUT ERRORS are errors (no host, two sources, an unknown enum, a bad --only, an
      image URL with no --host, a bot-protection challenge page), not guesses.
   ============================================================================= */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { importChart, validateOverrides, applyOverrides, parseOnly, PDF_NOTE } from "../scanner/import-chart.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const throwsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

const dir = mkdtempSync(join(tmpdir(), "pear-import-"));
const UNLABELLED = `<table><tr><th>Size</th><th>Chest</th><th>Waist</th></tr>
  <tr><td>S</td><td>88-94</td><td>74-80</td></tr><tr><td>M</td><td>95-101</td><td>81-87</td></tr><tr><td>L</td><td>102-108</td><td>88-94</td></tr></table>`;
const WOMEN_PAGE = `<html><head><title>Size guide</title></head><body><h2>Women</h2>${UNLABELLED}</body></html>`;
const PRICES = `<table><tr><th>Size</th><th>Price</th></tr><tr><td>S</td><td>89.90</td></tr><tr><td>M</td><td>99.90</td></tr></table>`;
const WILD = UNLABELLED.replace(/88-94/, "880-940").replace(/95-101/, "950-1010").replace(/102-108/, "1020-1080")
  .replace(/74-80/, "740-800").replace(/81-87/, "810-870").replace(/88-94<\/td><\/tr><\/table>/, "880-940</td></tr></table>");

const htmlFile = join(dir, "guide.html"); writeFileSync(htmlFile, WOMEN_PAGE);
const bareFile = join(dir, "bare.html"); writeFileSync(bareFile, UNLABELLED);
const priceFile = join(dir, "prices.html"); writeFileSync(priceFile, PRICES);
const wildFile = join(dir, "wild.html"); writeFileSync(wildFile, WILD);
const envFile = join(dir, "envelope.json"); writeFileSync(envFile, JSON.stringify({ success: true, content: WOMEN_PAGE }));

console.log("\n── §1 the three sources ──");
{
  const a = await importChart({ host: "https://www.Shop.example.com/x", htmlFile, JSDOM });
  check("§1.1 saved HTML: one store-wide women/tops record, source manual_html, canonical host",
    a.host === "shop.example.com" && a.records.length === 1 && a.records[0].gender === "women" &&
    a.records[0].garment_type === "tops" && a.records[0].source === "manual_html" && a.records[0].product_key === "",
    JSON.stringify(a.records.map((r) => [r.gender, r.garment_type, r.source, r.product_key])));
  const e = await importChart({ host: "shop.example.com", htmlFile: envFile, JSDOM });
  check("§1.2 a saved JSON envelope ({content}) is unwrapped like the scanner does", e.records.length === 1);
  const fetchText = async (u) => ({ ok: true, status: 200, url: u, contentType: "text/html", text: JSON.stringify({ success: true, html: WOMEN_PAGE }) });
  const u = await importChart({ url: "https://shop.example.com/size-guide", fetchText, JSDOM });
  check("§1.3 a URL (host taken from it), envelope unwrapped, source manual_url",
    u.host === "shop.example.com" && u.records.length === 1 && u.records[0].source === "manual_url" && u.records[0].source_url === "https://shop.example.com/size-guide",
    JSON.stringify(u.records.map((r) => [r.source, r.source_url])));
  let seen = null;
  const imageReader = async (src, opts) => {
    seen = { src, opts };
    const doc = new JSDOM(`<h2>Men</h2>${UNLABELLED}`).window.document;
    const { extractAllSizeCharts } = await import("../scanner/size-charts.js");
    return { outcome: "read", detail: "1 chart", found: extractAllSizeCharts(doc, "https://x/").map((chart) => ({ chart, source: opts.source, sourceUrl: opts.sourceUrl, productUrl: "" })) };
  };
  const img = await importChart({ host: "shop.example.com", imageFile: join(dir, "shot.png"), imageReader, JSDOM });
  check("§1.4 a screenshot goes to the image reader as a FILE, source manual_image, store-wide",
    seen && seen.src.file && seen.opts.source === "manual_image" && img.records[0].source === "manual_image" && img.records[0].product_key === "",
    JSON.stringify({ src: seen && seen.src, recs: img.records.map((r) => r.source) }));
  /* 0.9 base - 0.15 (type read off the columns: the fixture says "Men", no garment word)
     - 0.1 (manual_image penalty) = 0.65 */
  check("§1.5 a manual image chart carries the image confidence penalty (0.1 below the same chart printed)",
    Math.abs(img.records[0].confidence - 0.65) < 1e-9, img.records[0].confidence);
  const imgUrlFetch = async (u) => ({ ok: true, status: 200, url: u, contentType: "image/png", text: "" });
  seen = null;
  await importChart({ url: "https://cdn.example.com/chart.png", host: "shop.example.com", fetchText: imgUrlFetch, imageReader, JSDOM });
  check("§1.6 a URL that serves an IMAGE is read as an image", seen && seen.src.url === "https://cdn.example.com/chart.png");

  /* What defaultFetchText returns for each: an octet-stream body is not read as text
     (text ""), an UNTYPED one is (the PNG bytes decoded as a string). */
  const answering = (contentType, text = "") => async (u) => ({ ok: true, status: 200, url: u, contentType, text });
  const PNG_AS_TEXT = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR";
  for (const [label, contentType, text, u] of [
    ["application/octet-stream (cdn.kiwisizing.com's chart PNGs)", "application/octet-stream", "", "https://cdn.kiwisizing.com/chart-123.png"],
    ["binary/octet-stream", "binary/octet-stream", "", "https://cdn.example.com/c?id=9"],
    ["no Content-Type, an image file name", "", PNG_AS_TEXT, "https://cdn.example.com/guide.webp?v=2"],
    ["image/jpg (a misconfigured label - the reader's bytes decide)", "image/jpg", "", "https://cdn.example.com/c.jpg"],
  ]) {
    seen = null;
    const r = await importChart({ url: u, host: "shop.example.com", fetchText: answering(contentType, text), imageReader, JSDOM });
    check(`§1.6b ${label} -> the image reader, not the HTML parser`,
      seen && seen.src.url === u && r.records.length === 1 && r.records[0].source === "manual_image", JSON.stringify({ seen: !!seen, notes: r.notes }));
  }
  seen = null;
  const untypedPage = await importChart({ url: "https://shop.example.com/size-guide", fetchText: answering("", WOMEN_PAGE), imageReader, JSDOM });
  check("§1.6c ...an untyped PAGE (no image file name) is still parsed as HTML",
    !seen && untypedPage.records.length === 1 && untypedPage.records[0].source === "manual_url", JSON.stringify(untypedPage.notes));
  for (const [label, contentType, u] of [
    ["application/pdf", "application/pdf", "https://shop.example.com/files/guide"],
    ["a .pdf served as octet-stream", "application/octet-stream", "https://cdn.example.com/size-guide.pdf?v=3"],
  ]) {
    seen = null;
    const r = await importChart({ url: u, host: "shop.example.com", fetchText: answering(contentType), imageReader, JSDOM });
    check(`§1.6d a PDF (${label}) gets capture.js's "screenshot it and use --image" note, no model call`,
      !seen && r.records.length === 0 && r.notes.includes(PDF_NOTE), JSON.stringify(r.notes));
  }
}

console.log("\n── §1.7 a guide saved OPEN over a product page ──");
{
  /* terminalx: the size guide is a dialog over a pair of women's jeans. Its chart is a
     chest+waist TOPS chart; the page's title / h1 / breadcrumb say jeans. */
  const TABLE_HE = `<table><tr><th>מידה</th><th>חזה</th><th>מותן</th></tr><tr><td>XS</td><td>80-84</td><td>62-66</td></tr>
    <tr><td>S</td><td>85-89</td><td>67-71</td></tr><tr><td>M</td><td>90-94</td><td>72-76</td></tr><tr><td>L</td><td>95-99</td><td>77-81</td></tr></table>`;
  const OVER_PDP = `<html><head><title>מכנסי ג'ינס סלים - נשים</title></head><body>
    <nav aria-label="breadcrumb">ראשי / נשים / מכנסיים</nav><main><h1>מכנסי ג'ינס סלים</h1><p>product</p></main>
    <div role="dialog" aria-modal="true" class="size-guide-modal">${TABLE_HE}</div></body></html>`;
  const overFile = join(dir, "guide-over-pdp.html"); writeFileSync(overFile, OVER_PDP);
  const h = await importChart({ host: "terminalx.com", htmlFile: overFile, JSDOM });
  check("§1.7.1 --html: typed by the GUIDE (tops, off its columns), not the product's title (jeans)",
    h.records.length === 1 && h.records[0].garment_type === "tops", JSON.stringify(h.records.map((r) => [r.gender, r.garment_type, r.confidence])));
  check("§1.7.2 ...the product page still says WHO it is for (women - the referrer tier)", h.records[0] && h.records[0].gender === "women");
  const { chartsFromHtml } = await import("../scanner/browser-capture.js");
  const b = chartsFromHtml(OVER_PDP, "https://terminalx.com/p/1", JSDOM, { source: "browser_modal" })[0].chart.classification;
  check("§1.7.3 ...the same labels the browser path gives the same markup",
    h.records[0] && b.gender === h.records[0].gender && b.garmentType === h.records[0].garment_type, JSON.stringify(b));
  const u = await importChart({ url: "https://terminalx.com/p/1", fetchText: async (x) => ({ ok: true, status: 200, url: x, contentType: "text/html", text: OVER_PDP }), JSDOM });
  check("§1.7.4 --url of the same page: the same", u.records.length === 1 && u.records[0].garment_type === "tops", JSON.stringify(u.records.map((r) => r.garment_type)));
  /* A guide PAGE of its own (no dialog) keeps its title as context - even with Bootstrap's
     "modal-open" on <body>, which matches the boundary selector. */
  const OWN = `<html><head><title>Women's jeans size guide</title></head><body class="modal-open"><table><tr><th>Size</th><th>Waist</th><th>Hips</th></tr>
    <tr><td>S</td><td>74-80</td><td>90-96</td></tr><tr><td>M</td><td>81-87</td><td>97-103</td></tr><tr><td>L</td><td>88-94</td><td>104-110</td></tr></table></body></html>`;
  const ownFile = join(dir, "own-guide.html"); writeFileSync(ownFile, OWN);
  const o = await importChart({ host: "shop.example.com", htmlFile: ownFile, JSDOM });
  check("§1.7.5 a guide page of its own is still typed by its title (women's jeans)",
    o.records.length === 1 && o.records[0].garment_type === "jeans" && o.records[0].gender === "women", JSON.stringify(o.records.map((r) => [r.gender, r.garment_type])));
  /* Older Shopify themes wrap the WHOLE page in a class the boundary selector matches -
     Debut's #PageContainer.page-container.drawer-page-content, Brooklyn's
     is-moved-by-drawer - around <main>. That wrapper is the page, not a guide: a guide page
     saved on one of these themes keeps its title as context, exactly like "page-container". */
  const JEANS = `<table><tr><th>Size</th><th>Waist</th><th>Hips</th></tr><tr><td>S</td><td>74-80</td><td>90-96</td></tr>
    <tr><td>M</td><td>81-87</td><td>97-103</td></tr><tr><td>L</td><td>88-94</td><td>104-110</td></tr></table>`;
  const THEME = (cls, mainTag) => `<html><head><title>Men's Jeans Size Chart</title></head><body>
    <div id="PageContainer" class="${cls}">${mainTag}<div class="page-width"><h1>Size Chart</h1><div class="rte">${JEANS}</div></div></main></div></body></html>`;
  const typed = [];
  for (const [label, cls, mainTag] of [
    ["page-container (no boundary word)", "page-container", '<main role="main" id="MainContent">'],
    ["Debut: drawer-page-content around <main>", "page-container drawer-page-content", '<main role="main" id="MainContent">'],
    ["Brooklyn: is-moved-by-drawer around <main>", "is-moved-by-drawer", '<main class="main-content">'],
  ]) {
    const f = join(dir, "theme-" + typed.length + ".html"); writeFileSync(f, THEME(cls, mainTag));
    const t = await importChart({ host: "shop.example.com", htmlFile: f, JSDOM });
    typed.push(t.records.map((r) => `${r.gender}/${r.age_group}/${r.garment_type}@${r.confidence}`).join(","));
    check(`§1.7.6 a guide page on a theme wrapper (${label}) is typed by its title: men/adult/jeans`,
      t.records.length === 1 && t.records[0].gender === "men" && t.records[0].garment_type === "jeans", typed[typed.length - 1]);
  }
  check("§1.7.7 ...with the same confidence on all three wrappers", new Set(typed).size === 1, JSON.stringify(typed));
  /* A guide saved open over a product page on such a theme: the dialog is the guide. */
  const DEBUT_PDP = `<html><head><title>מכנסי ג'ינס סלים - נשים</title></head><body><div id="PageContainer" class="page-container drawer-page-content">
    <main role="main"><h1>מכנסי ג'ינס סלים</h1></main></div><div role="dialog" aria-modal="true" class="size-guide-modal">${TABLE_HE}</div></body></html>`;
  const dpFile = join(dir, "debut-pdp.html"); writeFileSync(dpFile, DEBUT_PDP);
  const dp = await importChart({ host: "terminalx.com", htmlFile: dpFile, JSDOM });
  check("§1.7.8 ...and a guide dialog over a product page on that theme is still the guide (tops, not the page's jeans)",
    dp.records.length === 1 && dp.records[0].garment_type === "tops" && dp.records[0].gender === "women", JSON.stringify(dp.records.map((r) => [r.gender, r.garment_type])));
}

console.log("\n── §2 overrides label, they never validate ──");
{
  const none = await importChart({ host: "shop.example.com", htmlFile: bareFile, JSDOM });
  check("§2.1 an unlabelled chart imports with gender unknown (typed tops by its columns, lower confidence)",
    none.records.length === 1 && none.records[0].gender === "unknown" && none.records[0].confidence < 0.6, JSON.stringify(none.records[0]));
  const labelled = await importChart({ host: "shop.example.com", htmlFile: bareFile, overrides: { gender: "MEN", garment_type: "outerwear" }, JSDOM });
  check("§2.2 --gender men --type outerwear label it, and win back the uncertainty penalties",
    labelled.records[0].gender === "men" && labelled.records[0].garment_type === "outerwear" && labelled.records[0].confidence === 0.9,
    JSON.stringify(labelled.records[0]));
  check("§2.3 ...the ROWS are byte-identical to the unlabelled import (labels only)",
    JSON.stringify(labelled.records[0].rows) === JSON.stringify(none.records[0].rows));
  const kids = await importChart({ host: "shop.example.com", htmlFile: bareFile, overrides: { age_group: "kids", gender: "women" }, JSDOM });
  check("§2.4 --age kids files it as a kids chart", kids.records[0].age_group === "kids");
  const p = await importChart({ host: "shop.example.com", htmlFile: priceFile, overrides: { gender: "men", garment_type: "tops" }, JSDOM });
  check("§2.5 overrides cannot make a PRICE table a chart", p.records.length === 0 && p.notes.length > 0, JSON.stringify(p));
  const w = await importChart({ host: "shop.example.com", htmlFile: wildFile, overrides: { gender: "men", garment_type: "tops" }, JSDOM });
  check("§2.6 ...nor rescue values outside the plausibility clamps", w.records.length === 0, JSON.stringify(w.records));
  const two = await importChart({ host: "shop.example.com", htmlFile, only: [2], JSDOM });
  check("§2.7 --only filters by the summary's numbering", two.records.length === 0);
  check("§2.7b ...and says when a number is not there", two.notes.some((n) => /--only 2: no such chart - this source has 1/.test(n)), JSON.stringify(two.notes));
  const none2 = await importChart({ host: "shop.example.com", htmlFile, only: [], JSDOM });
  check("§2.7c an EMPTY --only list picks nothing (it is never 'no filter')", none2.records.length === 0, JSON.stringify(none2.records.length));
  check("§2.8 applyOverrides never touches the classification's rows-derived fields it was not asked to",
    applyOverrides({ gender: "men", ageGroup: "adult", garmentType: "tops", sizeSystem: "alpha", typeFrom: "context", confidence: 0.9 }, {}).sizeSystem === "alpha");
}

console.log("\n── §2.9 --only picks first, by the chart's own number; the flags label only what it picked ──");
{
  /* A guide page: a table under "Men" (chest 88-108) and an unlabelled one (chest 80-94).
     The owner wants the second one as women's. */
  const T = (rows) => `<table><tr><th>Size</th><th>Chest</th></tr>${rows}</table>`;
  const MEN = T(`<tr><td>S</td><td>88-94</td></tr><tr><td>M</td><td>95-101</td></tr><tr><td>L</td><td>102-108</td></tr>`);
  const BARE = T(`<tr><td>XS</td><td>80-84</td></tr><tr><td>S</td><td>85-89</td></tr><tr><td>M</td><td>90-94</td></tr>`);
  const twoFile = join(dir, "two.html");
  writeFileSync(twoFile, `<html><head><title>Size guide</title></head><body><h2>Men</h2>${MEN}${BARE}</body></html>`);
  const plain = await importChart({ host: "shop.example.com", htmlFile: twoFile, JSDOM });
  const nBare = Number(plain.numbers[plain.records.findIndex((r) => r.gender === "unknown")]);
  const nMen = Number(plain.numbers[plain.records.findIndex((r) => r.gender === "men")]);
  check("§2.9.1 a plain run lists both: men/tops and unknown/tops", plain.records.length === 2 && nBare > 0 && nMen > 0,
    JSON.stringify(plain.records.map((r) => [r.gender, r.garment_type])));
  const picked = await importChart({ host: "shop.example.com", htmlFile: twoFile, only: [nBare], overrides: { gender: "women" }, JSDOM });
  check("§2.9.2 --only <the unlabelled one's number> --gender women: ONE record, women/tops, with ITS rows (chest 80-94)",
    picked.records.length === 1 && picked.records[0].gender === "women" &&
    JSON.stringify(picked.records[0].rows) === JSON.stringify(plain.records[plain.numbers.indexOf(String(nBare))].rows),
    JSON.stringify(picked.records.map((r) => [r.gender, r.rows[0].body])));
  const menOnly = await importChart({ host: "shop.example.com", htmlFile: twoFile, only: [nMen], JSDOM });
  check("§2.9.3 --only <the men's number> keeps the men's chart as the source labels it",
    menOnly.records.length === 1 && menOnly.records[0].gender === "men", JSON.stringify(menOnly.records.map((r) => r.gender)));
  const both = await importChart({ host: "shop.example.com", htmlFile: twoFile, overrides: { gender: "women" }, JSDOM });
  const note = both.notes.find((n) => /one key holds one chart/.test(n)) || "";
  check("§2.9.4 --gender women on BOTH (no --only): the explicit label wins, and the collision is NAMED - both numbers, what is not saved",
    both.records.length === 1 && both.records[0].gender === "women" && new RegExp(`#${nMen}\\b`).test(note) && new RegExp(`#${nBare}\\b`).test(note) &&
    /NOT saving/.test(note) && /--only/.test(note), JSON.stringify(both.notes));
  /* "Men shirts" (chest+waist) and a men's pants table (waist+hips, typed bottoms by its
     columns). A blanket --type bottoms would file the shirt chart under bottoms. */
  const SHIRT = `<table><tr><th>Size</th><th>Chest</th><th>Waist</th></tr><tr><td>S</td><td>88-94</td><td>74-80</td></tr><tr><td>M</td><td>95-101</td><td>81-87</td></tr><tr><td>L</td><td>102-108</td><td>88-94</td></tr></table>`;
  const PANTS = `<table><tr><th>Size</th><th>Waist</th><th>Hips</th></tr><tr><td>S</td><td>74-80</td><td>90-96</td></tr><tr><td>M</td><td>81-87</td><td>97-103</td></tr><tr><td>L</td><td>88-94</td><td>104-110</td></tr></table>`;
  const spFile = join(dir, "shirt-pants.html");
  writeFileSync(spFile, `<html><head><title>Size guide</title></head><body><section><h2>Men shirts</h2>${SHIRT}</section><section><h2>Men</h2>${PANTS}</section></body></html>`);
  const sp = await importChart({ host: "shop.example.com", htmlFile: spFile, JSDOM });
  const nPants = Number(sp.numbers[sp.records.findIndex((r) => r.garment_type === "bottoms")]);
  const pantsOnly = await importChart({ host: "shop.example.com", htmlFile: spFile, only: [nPants], overrides: { garment_type: "jeans" }, JSDOM });
  check("§2.9.5 --only <pants> --type jeans relabels the PANTS chart alone - the shirt chart is not touched or saved",
    pantsOnly.records.length === 1 && pantsOnly.records[0].garment_type === "jeans" && pantsOnly.records[0].rows[0].body.hips &&
    !pantsOnly.records[0].rows[0].body.chest, JSON.stringify(pantsOnly.records.map((r) => [r.garment_type, r.rows[0].body])));
  const blanket = await importChart({ host: "shop.example.com", htmlFile: spFile, overrides: { garment_type: "bottoms" }, JSDOM });
  check("§2.9.6 a blanket --type bottoms that pushes the shirt chart onto the pants' key is REPORTED, naming both (chest+waist / waist+hips)",
    blanket.notes.some((n) => /one key holds one chart/.test(n) && /chest\+waist/.test(n) && /waist\+hips/.test(n)), JSON.stringify(blanket.notes));
}

console.log("\n── §2.10 ONE number per table, the same with or without flags - untyped tables included ──");
{
  /* The second cut numbered a plain run's RECORDS: a run with flags printed other numbers
     than --only picked by ("--type outerwear" printed women's tops as #2; "--type outerwear
     --only 2" then saved the MEN's), and a table the classifier leaves untyped on purpose
     (suits) had no number at all - it could not be imported alone. */
  const T = (rows) => `<table><tr><th>Size</th><th>Chest</th></tr>${rows}</table>`;
  const SUITS = T(`<tr><td>48</td><td>90-94</td></tr><tr><td>50</td><td>95-99</td></tr><tr><td>52</td><td>100-104</td></tr>`);
  const WOMEN = T(`<tr><td>XS</td><td>80-84</td></tr><tr><td>S</td><td>85-89</td></tr><tr><td>M</td><td>90-94</td></tr>`);
  const MEN = T(`<tr><td>M</td><td>95-99</td></tr><tr><td>L</td><td>100-104</td></tr><tr><td>XL</td><td>105-109</td></tr>`);
  const sec = (h, t) => `<section><h2>${h}</h2>${t}</section>`;
  const f3 = join(dir, "suits-women-men.html");
  writeFileSync(f3, `<html><head><title>Size guide</title></head><body>${sec("Suits", SUITS)}${sec("Women's tops", WOMEN)}${sec("Men's tops", MEN)}</body></html>`);
  const chest = (r) => r && r.rows[0].body.chest;
  const plain = await importChart({ host: "shop.example.com", htmlFile: f3, JSDOM });
  check("§2.10.1 a plain run: the suits table is #1 (not imported - no garment type), women's tops #2, men's tops #3",
    plain.total === 3 && JSON.stringify(plain.numbers) === JSON.stringify(["2", "3"]) &&
    plain.records[0].gender === "women" && plain.records[1].gender === "men",
    JSON.stringify({ total: plain.total, numbers: plain.numbers, recs: plain.records.map((r) => r.gender) }));
  const suitsNote = plain.notes.find((n) => /^#1 /.test(n)) || "";
  check("§2.10.2 ...and the untyped table is NAMED by its number, with how to import it alone (--only 1 --type ...)",
    /not imported/.test(suitsNote) && /--only 1 --type/.test(suitsNote) && !plain.notes.some((n) => /^no garment type/.test(n)), JSON.stringify(plain.notes));
  const flagged = await importChart({ host: "shop.example.com", htmlFile: f3, overrides: { garment_type: "outerwear" }, JSDOM });
  check("§2.10.3 with --type outerwear every table is printed under the SAME number it has without flags",
    JSON.stringify(flagged.numbers) === JSON.stringify(["1", "2", "3"]) &&
    chest(flagged.records[flagged.numbers.indexOf("2")])[0] === 80 && chest(flagged.records[flagged.numbers.indexOf("3")])[0] === 95,
    JSON.stringify(flagged.records.map((r, i) => [flagged.numbers[i], r.gender, r.garment_type, chest(r)])));
  const two = await importChart({ host: "shop.example.com", htmlFile: f3, overrides: { garment_type: "outerwear" }, only: [2], JSDOM });
  check("§2.10.4 --type outerwear --only 2 saves the table shown as #2 - women's, chest 80-94 - and only it",
    two.records.length === 1 && two.records[0].gender === "women" && two.records[0].garment_type === "outerwear" && chest(two.records[0])[0] === 80,
    JSON.stringify(two.records.map((r) => [r.gender, r.garment_type, chest(r)])));
  const suits = await importChart({ host: "shop.example.com", htmlFile: f3, overrides: { garment_type: "outerwear", gender: "men" }, only: [1], JSDOM });
  check("§2.10.5 --only 1 --type outerwear --gender men imports the SUITS table alone (EU 48-52)",
    suits.records.length === 1 && suits.records[0].rows[0].size === "48" && suits.records[0].garment_type === "outerwear" && suits.records[0].gender === "men",
    JSON.stringify(suits.records.map((r) => [r.gender, r.garment_type, r.rows.map((x) => x.size).join("/")])));
  const bare = await importChart({ host: "shop.example.com", htmlFile: f3, only: [1], JSDOM });
  check("§2.10.6 --only 1 without --type: nothing imported, and the note says to add --type",
    bare.records.length === 0 && bare.notes.some((n) => /^#1 /.test(n) && /--type/.test(n)), JSON.stringify(bare.notes));
  /* The same table twice on one page (a desktop and a mobile copy) is ONE number. */
  const f4 = join(dir, "twice.html");
  writeFileSync(f4, `<html><head><title>Size guide</title></head><body>${sec("Women's tops", WOMEN)}${sec("Women's tops", WOMEN)}${sec("Men's tops", MEN)}</body></html>`);
  const tw = await importChart({ host: "shop.example.com", htmlFile: f4, JSDOM });
  check("§2.10.7 the same table twice on one page is one number (#1), the next table is #2",
    tw.total === 2 && JSON.stringify(tw.numbers) === JSON.stringify(["1", "2"]), JSON.stringify({ total: tw.total, numbers: tw.numbers }));
  const { formatChartSummary } = await import("../scanner/capture-cli.js");
  const printed = formatChartSummary(flagged.records, flagged.numbers);
  check("§2.10.8 the summary prints those numbers (#1 #2 #3), not the records' positions",
    /#1 {2}/.test(printed) && /#2 {2}women/.test(printed) && /#3 {2}men/.test(printed), printed);
}

console.log("\n── §3 input errors are errors ──");
{
  check("§3.1 an unknown --gender is refused, naming the allowed values",
    /must be one of men\|women\|unisex\|unknown/.test(await throwsMsg(() => validateOverrides({ gender: "female" }))));
  check("§3.2 an unknown --type is refused", /--type must be one of/.test(await throwsMsg(() => validateOverrides({ garment_type: "shoes" }))));
  check("§3.3 no host and no URL -> error", /--host is required/.test(await throwsMsg(() => importChart({ htmlFile, JSDOM }))));
  check("§3.4 two sources at once -> error", /exactly one/.test(await throwsMsg(() => importChart({ host: "a.com", htmlFile, imageFile: "x.png", JSDOM }))));
  const fetchFail = async () => ({ ok: false, status: 403, text: "" });
  check("§3.5 a URL that refuses us -> error with the status, nothing imported",
    /HTTP 403/.test(await throwsMsg(() => importChart({ url: "https://a.com/g", fetchText: fetchFail, JSDOM }))));

  let read = 0;
  const countingReader = async () => { read++; return { outcome: "read", detail: "", found: [] }; };
  const cdnPng = async (u) => ({ ok: true, status: 200, url: u, contentType: "image/png", text: "" });
  const noHost = await throwsMsg(() => importChart({ url: "https://cdn.shopify.com/s/files/1/0001/size-chart.png", fetchText: cdnPng, imageReader: countingReader, JSDOM }));
  check("§3.6 an image URL with no --host -> error asking for --host (never filed under the CDN's host), no model call",
    /--host is required for an image URL/.test(noHost || "") && read === 0, noHost);

  /* A 200 that is a bot-protection interstitial, not the guide. */
  const AKAMAI = `<!DOCTYPE html><html><head><script src="/akam/13/abc123"></script></head><body><noscript>Please enable JS</noscript></body></html>`;
  const CLOUDFLARE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>`;
  for (const [label, text] of [["an Akamai-style script-only page", AKAMAI], ["a Cloudflare 'Just a moment...' page", CLOUDFLARE]]) {
    const challenge = async (u) => ({ ok: true, status: 200, url: u, contentType: "text/html", text });
    const m = await throwsMsg(() => importChart({ host: "adidas.co.il", url: "https://www.adidas.co.il/size-guide", fetchText: challenge, JSDOM }));
    check(`§3.7 ${label} answering 200 -> BLOCKED with the manual way in (--html / --image), not "nothing importable"`,
      /^BLOCKED/.test(m || "") && /--html/.test(m) && /--image/.test(m) && /do not work around/.test(m), m);
  }

  check("§3.8 parseOnly reads a plain list", JSON.stringify(parseOnly("1,3")) === "[1,3]" && JSON.stringify(parseOnly(" 2 , 2 ")) === "[2]");
  for (const bad of ["#2", "all", "--yes", "1-3", "0", "", undefined, "1,,2"]) {
    check(`§3.8 parseOnly refuses ${JSON.stringify(bad)} (never an empty list that keeps everything)`,
      /--only takes chart numbers/.test(await throwsMsg(() => parseOnly(bad)) || ""));
  }
  /* The CLI itself: "--only --yes" (a forgotten number) used to read "--yes" as the value,
     parse it to [], keep every chart and save them without a prompt. This run can never
     write, even if the parse regresses: --dry-run, and the Supabase variables set EMPTY
     (dotenv never overrides a variable that is set, so scanner/.env cannot fill them). */
  const cli = fileURLToPath(new URL("../scanner/import-chart.js", import.meta.url));
  const noDb = { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
  for (const args of [["--only", "--yes"], ["--only", "all", "--yes"], ["--yes", "--only"]]) {
    const r = spawnSync(process.execPath, [cli, "--dry-run", "--host", "shop.example.com", "--html", htmlFile, ...args],
      { encoding: "utf8", timeout: 60000, env: noDb });
    check(`§3.9 CLI ${args.join(" ")} -> exit 2 naming --only, nothing summarised or saved`,
      r.status === 2 && /--only takes chart numbers/.test(r.stderr) && !/chart\(s\) to import/.test(r.stdout),
      JSON.stringify({ status: r.status, stderr: r.stderr.slice(0, 200), stdout: r.stdout.slice(0, 200) }));
  }
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("manual-import: all checks passed.");
