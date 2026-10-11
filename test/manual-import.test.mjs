/* PHASE 2 - MANUAL IMPORT, the guaranteed way in (scanner/import-chart.js)
   ─────────────────────────────────────────────────────────────────────────────
   §1 THE THREE SOURCES - a URL (page, JSON envelope, or an image URL), a saved HTML
      file, a screenshot - each through the shared parser and buildRecords(), tagged
      manual_url / manual_html / manual_image, store-wide.
      A URL is routed by what it answered: image/*, an octet-stream download or an untyped
      image file to the image reader, a PDF to the "screenshot it" note, a page to the
      parser. A guide saved OPEN over a product page is typed by the guide, not the page -
      a real dialog always; a class-only popup unless the page's own <h1> names the guide.
      A saved page keeps the address it was saved from (§1.8), and a "Webpage, Single File"
      (.mhtml) save is decoded - quoted-printable, base64, in the charset its part header or
      (a Blink save) its own serialized <meta> names - or refused (§1.9).
   §2 OVERRIDES LABEL, THEY NEVER VALIDATE. --gender/--age/--type replace the labels of
      the charts --only picked (and are checked against the table's enums); they cannot
      turn a price table or an implausible chart into a record. Every table the parser
      accepted has ONE number, the same with or without flags (untyped tables too, named
      in a note); --only picks by it before the flags label; a collision is named.
   §3 INPUT ERRORS are errors (no host, a --host that is not a hostname, two sources, an
      unknown enum, a bad --only, an image URL with no --host), not guesses; a refusal
      (403/429, a challenge page) is BLOCKED with the manual way in, asked once. A source it
      cannot use - a missing or unreadable --image, GIF bytes, over 8 MB, no GEMINI_API_KEY, a
      --url answering a PDF - exits 2 with its message; a source that was read where no table
      passed is "Nothing importable.", exit 0 (§3.11-§3.13).
   §4 --DRY-RUN NEVER SAVES, even with --yes.
   ============================================================================= */
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  /* A REAL dialog carrying the page's only <h1> ("מדריך מידות") over a product page whose
     title is not an <h1>: "holds every <h1>" read the dialog as the page, and the product's
     title typed the guide's chest+waist chart as women's JEANS at 0.85. A real dialog is the
     guide whatever it holds - guideContainerOf()'s rule. */
  const H1_DIALOG = `<html><head><title>מכנסי ג'ינס סלים - נשים</title></head><body>
    <main><div class="product-name">מכנסי ג'ינס סלים</div></main>
    <div role="dialog" aria-modal="true" class="size-guide-modal"><h1>מדריך מידות</h1>${TABLE_HE}</div></body></html>`;
  const hdFile = join(dir, "h1-dialog.html"); writeFileSync(hdFile, H1_DIALOG);
  const hd = await importChart({ host: "terminalx.com", htmlFile: hdFile, JSDOM });
  const hdB = chartsFromHtml(H1_DIALOG, "https://terminalx.com/p/1", JSDOM, { source: "browser_modal" })[0].chart.classification;
  check("§1.7.9 a real dialog holding the page's only <h1> is still the guide: women's tops, as the browser path reads it",
    hd.records.length === 1 && hd.records[0].garment_type === "tops" && hd.records[0].gender === "women" &&
    hdB.garmentType === hd.records[0].garment_type && hdB.gender === hd.records[0].gender,
    JSON.stringify({ html: hd.records.map((r) => [r.gender, r.garment_type, r.confidence]), browser: [hdB.gender, hdB.garmentType] }));
  /* A guide PAGE of its own whose table sits in a class-only popup wrapper inside <main>,
     under the page's own <h1> naming the guide: that wrapper is not a dialog over another
     page, so the title types it - as Phase 1 reads the same page (men's jeans). */
  const POPUP_PAGE = `<html><head><title>Size guide</title></head><body><main><h1>Men's Jeans Size Guide</h1>
    <div class="size-chart-popup-content">${JEANS}</div></main></body></html>`;
  const ppFile = join(dir, "popup-page.html"); writeFileSync(ppFile, POPUP_PAGE);
  const pp = await importChart({ host: "shop.example.com", htmlFile: ppFile, JSDOM });
  const { extractAllSizeCharts: phase1 } = await import("../scanner/size-charts.js");
  const p1 = phase1(new JSDOM(POPUP_PAGE, { url: "https://shop.example.com/" }).window.document, "https://shop.example.com/")[0].classification;
  check("§1.7.10 a guide page whose table sits in a class-only popup wrapper under its own guide <h1>: men/jeans, as Phase 1 reads it",
    pp.records.length === 1 && pp.records[0].gender === "men" && pp.records[0].garment_type === "jeans" &&
    p1.gender === "men" && p1.garmentType === "jeans", JSON.stringify({ html: pp.records.map((r) => [r.gender, r.garment_type, r.confidence]), p1 }));
  /* ...while the same markup on a PRODUCT page (its <h1> is the product, not a guide) is a
     popup saved open: typed by the guide (tops), never by the product's title (jeans). */
  const POPUP_PDP = `<html><head><title>Women's Slim Jeans</title></head><body><main><h1>Women's Slim Jeans</h1>
    <div class="size-chart-popup-content">${UNLABELLED}</div></main></body></html>`;
  const pdFile = join(dir, "popup-pdp.html"); writeFileSync(pdFile, POPUP_PDP);
  const pd = await importChart({ host: "shop.example.com", htmlFile: pdFile, JSDOM });
  check("§1.7.11 ...the same class-only popup open on a PRODUCT page is still the guide: women's tops, not jeans",
    pd.records.length === 1 && pd.records[0].garment_type === "tops" && pd.records[0].gender === "women", JSON.stringify(pd.records.map((r) => [r.gender, r.garment_type])));
  /* The guide's OWN title is not the page's <h1>. Bootstrap 5.3's documented modal puts its
     title, an <h1 class="modal-title">, in .modal-header and the table in .modal-body, and
     adds role/aria-modal only when it opens - so --url and a save with the guide closed hold
     the class-only markup. The table's NEAREST boundary match is .modal-body; the "page <h1>
     names a size guide" rule tested the modal's title against that inner box, read "Size
     Guide" as the page's own heading, dropped the boundary, and the product's title typed
     the chest+waist chart as women's JEANS at 0.9 (0.85 with the product title a <div>).
     A class-only popup with its title in a header beside the body did the same in Hebrew. */
  const BS5 = (prod) => `<html><head><title>Women's Slim Jeans | Shop</title></head><body>
    <main>${prod}<button data-bs-toggle="modal" data-bs-target="#sg">Size guide</button></main>
    <div class="modal fade" id="sg" tabindex="-1" aria-labelledby="sgLabel" aria-hidden="true"><div class="modal-dialog"><div class="modal-content">
    <div class="modal-header"><h1 class="modal-title fs-5" id="sgLabel">Size Guide</h1><button type="button" class="btn-close"></button></div>
    <div class="modal-body">${UNLABELLED}</div></div></div></div></body></html>`;
  const HE_POPUP = `<html><head><title>מכנסי ג'ינס סלים - נשים</title></head><body><main><h1>מכנסי ג'ינס סלים - נשים</h1></main>
    <div class="size-chart-popup"><div class="popup-header"><h1>טבלת מידות</h1></div><div class="popup-body">${TABLE_HE}</div></div></body></html>`;
  for (const [label, html] of [
    ["a closed Bootstrap 5.3 modal (its title an <h1> in .modal-header), the product title an <h1>", BS5("<h1>Women's Slim Jeans</h1>")],
    ["...the product title a <div>", BS5("<div class=\"product-title\">Women's Slim Jeans</div>")],
    ["a Hebrew .size-chart-popup, its <h1> in .popup-header beside .popup-body", HE_POPUP],
  ]) {
    const f = join(dir, `guide-title-${label.length}.html`); writeFileSync(f, html);
    const r = await importChart({ host: "shop.example.com", htmlFile: f, JSDOM });
    const ru = await importChart({ url: "https://shop.example.com/products/womens-slim-jeans", fetchText: async (x) => ({ ok: true, status: 200, url: x, contentType: "text/html", text: html }), JSDOM });
    const br = chartsFromHtml(html, "https://shop.example.com/products/womens-slim-jeans", JSDOM, { source: "browser_modal" })[0].chart.classification;
    const lab = (o) => JSON.stringify(o.records.map((x) => [x.gender, x.garment_type, x.confidence]));
    check(`§1.7.12 ${label}: the guide's own title is not the page's <h1> - women's tops (--html and --url), as the browser path reads it`,
      r.records.length === 1 && r.records[0].garment_type === "tops" && r.records[0].gender === "women" && lab(r) === lab(ru) &&
      br.garmentType === "tops" && br.gender === "women",
      JSON.stringify({ html: lab(r), url: lab(ru), browser: [br.gender, br.garmentType] }));
  }
}

console.log("\n── §1.8 a saved page keeps the address it was saved from ──");
{
  /* Chrome's "Webpage, Complete" save writes the address it came from into the file. --html
     read every page as https://<host>/, so a guide titled just "Size Guide" at
     /pages/mens-jeans-size-guide was unknown/bottoms by file and men/jeans by URL. */
  const Q = `<table><tr><th>Size</th><th>Waist</th><th>Hips</th></tr><tr><td>S</td><td>74-80</td><td>90-96</td></tr>
    <tr><td>M</td><td>81-87</td><td>97-103</td></tr><tr><td>L</td><td>88-94</td><td>104-110</td></tr></table>`;
  const page = `<html><head><title>Size Guide</title></head><body>${Q}</body></html>`;
  const at = "https://www.shop.example.com/pages/mens-jeans-size-guide";
  const saved = `<!DOCTYPE html>\n<!-- saved from url=(${String(at.length).padStart(4, "0")})${at} -->\n${page}`;
  const sf = join(dir, "saved-from.html"); writeFileSync(sf, saved);
  const byFile = await importChart({ host: "shop.example.com", htmlFile: sf, JSDOM });
  const byUrl = await importChart({ url: at, fetchText: async (u) => ({ ok: true, status: 200, url: u, contentType: "text/html", text: page }), JSDOM });
  const lab = (o) => JSON.stringify(o.records.map((r) => [r.gender, r.age_group, r.garment_type, r.confidence]));
  check("§1.8.1 --html of a page saved from <store>/pages/mens-jeans-size-guide labels like --url of that address (men/jeans)",
    byFile.records.length === 1 && byFile.records[0].garment_type === "jeans" && byFile.records[0].gender === "men" && lab(byFile) === lab(byUrl),
    JSON.stringify({ file: lab(byFile), url: lab(byUrl) }));
  check("§1.8.2 ...the rows are the file's and its source_url is still the file",
    byFile.records[0] && byFile.records[0].source === "manual_html" && /^file:saved-from\.html$/.test(byFile.records[0].source_url) &&
    JSON.stringify(byFile.records[0].rows) === JSON.stringify(byUrl.records[0].rows), byFile.records[0] && byFile.records[0].source_url);
  const foreign = saved.replace(/www\.shop\.example\.com/, "other-store.example.org");
  const ff = join(dir, "saved-from-other.html"); writeFileSync(ff, foreign);
  const fo = await importChart({ host: "shop.example.com", htmlFile: ff, JSDOM });
  check("§1.8.3 an address on ANOTHER host lends nothing (read as the store's root, as before)",
    fo.records.length === 1 && fo.records[0].gender === "unknown" && fo.records[0].garment_type === "bottoms", lab(fo));
}

console.log("\n── §1.9 a \"Webpage, Single File\" (.mhtml) save ──");
{
  /* Chrome/Edge's Ctrl+S offers "Webpage, Single File" and remembers it. Blink writes the
     page as a MIME message, its HTML part quoted-printable: every "=" is =3D, every non-ASCII
     byte =XX, and a soft break "=\r\n" every 76 characters - inside a <td> or a <tr> as
     often as not. Parsed raw, the shared parser dropped whichever rows or columns a break
     landed in, and what was left still passed validation. */
  const qp = (html, pad = 0) => {
    const bytes = Buffer.from(" ".repeat(pad) + html, "utf8");
    let out = "", line = "";
    for (const b of bytes) {
      if (b === 0x0a) { out += line + "\r\n"; line = ""; continue; }
      const tok = (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : "=" + b.toString(16).toUpperCase().padStart(2, "0");
      if (line.length + tok.length > 75) { out += line + "=\r\n"; line = ""; }
      line += tok;
    }
    return out + line;
  };
  const B = "----MultipartBoundary--Xk3Lm9Qp----";
  const mhtml = (part, { loc = "https://shop.example.com/pages/size-guide", cte = "quoted-printable", type = "text/html" } = {}) =>
    `From: <Saved by Blink>\r\nSnapshot-Content-Location: ${loc}\r\nSubject: Size guide\r\nDate: Wed, 7 Oct 2026 09:00:00 -0000\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${B}"\r\n\r\n\r\n` +
    `--${B}\r\nContent-Type: ${type}\r\nContent-ID: <frame-1@mhtml.blink>\r\nContent-Transfer-Encoding: ${cte}\r\nContent-Location: ${loc}\r\n\r\n` +
    `${part}\r\n\r\n--${B}\r\nContent-Type: text/css\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: cid:css-1@mhtml.blink\r\n\r\n` +
    `body { color: red; }\r\n\r\n--${B}--\r\n`;
  const FOUR = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>Size guide</title></head><body><h2>Men</h2>` +
    `<table class="size-table"><tr><th>Size</th><th>Chest</th><th>Waist</th></tr><tr><td>S</td><td>88–94</td><td>74–80</td></tr>` +
    `<tr><td>M</td><td>95–101</td><td>81–87</td></tr><tr><td>L</td><td>102–108</td><td>88–94</td></tr><tr><td>XL</td><td>109–115</td><td>95–101</td></tr></table></body></html>`;
  const plainF = join(dir, "four.html"); writeFileSync(plainF, FOUR);
  const want = await importChart({ host: "shop.example.com", htmlFile: plainF, JSDOM });
  const sig = (o) => JSON.stringify(o.records.map((r) => [r.gender, r.age_group, r.garment_type, r.rows]));
  check("§1.9.0 control: the plain page is one men's tops chart, S-XL, chest+waist",
    want.records.length === 1 && want.records[0].rows.length === 4 && want.records[0].rows.every((r) => r.body.chest && r.body.waist), sig(want));

  /* By hand: a soft break INSIDE a <tr> (between two cells, and inside a cell's number),
     =3D in the attributes, =E2=80=93 for the en dash of every range, and a Hebrew heading. */
  const HAND = `<html><head><meta http-equiv=3D"Content-Type" content=3D"text/html; charset=3DUTF-8"><title>Size guide</title></he=\r\n` +
    `ad><body><h2>=D7=92=D7=91=D7=A8=D7=99=D7=9D</h2><table class=3D"size-table"><tr><th>Size</th><th>Chest</th><th>Waist</th></tr>=\r\n` +
    `<tr><td>S</td><td>88=E2=80=9394</td><td>74=E2=80=9380</td></tr><tr><td>M</td><td>95=E2=80=93=\r\n` +
    `101</td><td>81=E2=80=9387</td></tr><tr><td>L</td><td>102=E2=80=93108</td>=\r\n<td>88=E2=80=9394</td></tr><tr><td>XL</td><td>109=E2=80=93115</td><td>95=E2=80=93101</td></tr></table></body></html>`;
  const handF = join(dir, "hand.mhtml"); writeFileSync(handF, mhtml(HAND));
  const hand = await importChart({ host: "shop.example.com", htmlFile: handF, JSDOM });
  check("§1.9.1 a soft break inside a <tr> and a cell, =3D and =E2=80=93 escapes: decoded - four rows, chest+waist, the en-dash ranges read",
    hand.records.length === 1 && hand.records[0].rows.length === 4 && JSON.stringify(hand.records[0].rows) === JSON.stringify(want.records[0].rows),
    JSON.stringify({ recs: hand.records.map((r) => r.rows), notes: hand.notes }));
  check("§1.9.2 ...the Hebrew heading (=D7=92...) decodes to UTF-8: גברים -> men",
    hand.records[0] && hand.records[0].gender === "men", hand.records[0] && hand.records[0].gender);

  /* Where the 76-column breaks fall moves with every byte before the table: 0-39 bytes of
     padding put a break in every position of a row. Each must read exactly the plain page. */
  const off = [];
  for (let pad = 0; pad < 40; pad++) {
    const f = join(dir, `shift-${pad}.mhtml`); writeFileSync(f, mhtml(qp(FOUR, pad)));
    const r = await importChart({ host: "shop.example.com", htmlFile: f, JSDOM });
    if (sig(r) !== sig(want)) off.push(pad + ":" + sig(r).slice(0, 80));
  }
  check("§1.9.3 the same page quoted-printable at 40 break offsets: every one reads exactly the plain page (no row or column lost)",
    off.length === 0, off.join(" | "));

  const b64F = join(dir, "b64.mht");
  writeFileSync(b64F, mhtml(Buffer.from(FOUR, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"), { cte: "base64" }));
  const b64 = await importChart({ host: "shop.example.com", htmlFile: b64F, JSDOM });
  check("§1.9.4 a base64 HTML part (.mht) reads the same", sig(b64) === sig(want), sig(b64));

  /* The page's own address rides in the MIME header: a guide titled just "Size Guide" at
     /pages/mens-jeans-size-guide is labelled from it, as §1.8 does for "saved from url". */
  const Q = `<html><head><title>Size Guide</title></head><body><table><tr><th>Size</th><th>Waist</th><th>Hips</th></tr><tr><td>S</td><td>74-80</td><td>90-96</td></tr>` +
    `<tr><td>M</td><td>81-87</td><td>97-103</td></tr><tr><td>L</td><td>88-94</td><td>104-110</td></tr></table></body></html>`;
  const locF = join(dir, "loc.mhtml"); writeFileSync(locF, mhtml(qp(Q), { loc: "https://shop.example.com/pages/mens-jeans-size-guide" }));
  const loc = await importChart({ host: "shop.example.com", htmlFile: locF, JSDOM });
  check("§1.9.5 Snapshot-Content-Location on the store's host is the page's address (men/jeans)",
    loc.records.length === 1 && loc.records[0].gender === "men" && loc.records[0].garment_type === "jeans",
    JSON.stringify(loc.records.map((r) => [r.gender, r.garment_type])));

  /* What cannot be decoded is REFUSED, with the save that works - never parsed raw. */
  const noHtmlF = join(dir, "nohtml.mhtml"); writeFileSync(noHtmlF, mhtml("body{}", { type: "text/css" }));
  const m1 = await throwsMsg(() => importChart({ host: "shop.example.com", htmlFile: noHtmlF, JSDOM }));
  check("§1.9.6 an .mhtml with no HTML part is refused, naming the save that keeps an opened guide (\"Webpage, Complete\")",
    /Single File/.test(m1 || "") && /"Webpage, Complete"/.test(m1 || ""), m1);
  const oddF = join(dir, "odd.mhtml"); writeFileSync(oddF, mhtml(qp(FOUR), { cte: "x-uuencode" }));
  const m2 = await throwsMsg(() => importChart({ host: "shop.example.com", htmlFile: oddF, JSDOM }));
  check("§1.9.7 ...and so is an encoding it does not decode (x-uuencode)",
    /x-uuencode/.test(m2 || "") && /"Webpage, Complete"/.test(m2 || ""), m2);
  const notMime = join(dir, "renamed.mhtml"); writeFileSync(notMime, FOUR);
  const nm = await importChart({ host: "shop.example.com", htmlFile: notMime, JSDOM });
  check("§1.9.8 a plain HTML file that only carries an .mhtml name is read as HTML", sig(nm) === sig(want), sig(nm));

  /* A NON-UTF-8 PAGE. Blink's part header is just "Content-Type: text/html" (no charset), the
     multipart header names none either, and the bytes stay in the document's own encoding -
     the charset is only in the <meta http-equiv="Content-Type"> Blink serializes as <head>'s
     first child, with document.characterSet, even when the page declared it in its HTTP
     header alone. Decoded as UTF-8 regardless, a windows-1255 page's Hebrew became U+FFFD:
     Hebrew column headers found no table at all, a Hebrew heading lost its gender.
     REAL_1255 is a real Blink save, verbatim (Chromium Page.captureSnapshot of a windows-1255
     page whose charset came only from its HTTP header). */
  const REAL_1255 = [
    "From: <Saved by Blink>",
    "Snapshot-Content-Location: https://shop.example.com/pages/size-guide-header-only",
    "Subject: =?utf-8?Q?=D7=9E=D7=93=D7=A8=D7=99=D7=9A=20=D7=9E=D7=99=D7=93=D7=95=D7=AA?=",
    "Date: Sun, 11 Oct 2026 16:36:59 +0000",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    "\ttype=\"text/html\";",
    "\tboundary=\"----MultipartBoundary--IscNw7Ca4Bup6Ci3zat0eVf1nZvFpsX0Nf8xUE8MQY----\"",
    "", "",
    "------MultipartBoundary--IscNw7Ca4Bup6Ci3zat0eVf1nZvFpsX0Nf8xUE8MQY----",
    "Content-Type: text/html",
    "Content-ID: <frame-44398EA30606175B29629C6E432B59CB@mhtml.blink>",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: https://shop.example.com/pages/size-guide-header-only",
    "",
    "<!DOCTYPE html><html><head><meta http-equiv=3D\"Content-Type\" content=3D\"tex=",
    "t/html; charset=3Dwindows-1255\"><title>=EE=E3=F8=E9=EA =EE=E9=E3=E5=FA</tit=",
    "le></head><body><h2>=E2=E1=F8=E9=ED - =E7=E5=EC=F6=E5=FA</h2><table><tbody>=",
    "<tr><th>=EE=E9=E3=E4</th><th>=E7=E6=E4</th><th>=EE=E5=FA=F0=E9=E9=ED</th></=",
    "tr><tr><td>S</td><td>88=9694</td><td>74=9680</td></tr><tr><td>M</td><td>95=",
    "=96101</td><td>81=9687</td></tr><tr><td>L</td><td>102=96108</td><td>88=9694=",
    "</td></tr><tr><td>XL</td><td>109=96115</td><td>95=96101</td></tr></tbody></=",
    "table></body></html>",
    "------MultipartBoundary--IscNw7Ca4Bup6Ci3zat0eVf1nZvFpsX0Nf8xUE8MQY------",
    "",
  ].join("\r\n");
  const HE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>מדריך מידות</title></head><body><h2>גברים - חולצות</h2><table><tbody>` +
    `<tr><th>מידה</th><th>חזה</th><th>מותניים</th></tr><tr><td>S</td><td>88–94</td><td>74–80</td></tr><tr><td>M</td><td>95–101</td><td>81–87</td></tr>` +
    `<tr><td>L</td><td>102–108</td><td>88–94</td></tr><tr><td>XL</td><td>109–115</td><td>95–101</td></tr></tbody></table></body></html>`;
  const heF = join(dir, "he-utf8.html"); writeFileSync(heF, HE_PAGE);
  const heWant = await importChart({ host: "shop.example.com", htmlFile: heF, JSDOM });
  check("§1.9.9 control: the same Hebrew page as UTF-8 is one men's tops chart, S-XL, chest+waist",
    heWant.records.length === 1 && heWant.records[0].gender === "men" && heWant.records[0].garment_type === "tops" && heWant.records[0].rows.length === 4, sig(heWant));
  const realF = join(dir, "real-1255.mhtml"); writeFileSync(realF, REAL_1255, "latin1");
  const real = await importChart({ host: "shop.example.com", htmlFile: realF, JSDOM });
  check("§1.9.10 a REAL Blink save of a windows-1255 page (charset only in the serialized <meta>): read exactly as the UTF-8 page - men's tops, four rows",
    sig(real) === sig(heWant), JSON.stringify({ recs: sig(real), notes: real.notes }));

  /* Built the same way by hand, to vary what declares the charset. To windows-1255 bytes: */
  const to1255 = (s) => Buffer.from([...s].map((ch) => { const c = ch.codePointAt(0); return c < 128 ? c : c >= 0x5d0 && c <= 0x5ea ? 0xe0 + c - 0x5d0 : ch === "–" ? 0x96 : 0x3f; }));
  const qpBytes = (buf) => {
    let out = "", line = "";
    for (const b of buf) {
      const tok = (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : "=" + b.toString(16).toUpperCase().padStart(2, "0");
      if (line.length + tok.length > 75) { out += line + "=\r\n"; line = ""; }
      line += tok;
    }
    return out + line;
  };
  const EN_HEAD = HE_PAGE.replace("<th>מידה</th><th>חזה</th><th>מותניים</th>", "<th>Size</th><th>Chest</th><th>Waist</th>");
  const enWant = await importChart({ host: "shop.example.com", htmlFile: (() => { const f = join(dir, "en-utf8.html"); writeFileSync(f, EN_HEAD); return f; })(), JSDOM });
  for (const [label, page, opts, wantSig] of [
    ["English headers under a Hebrew heading, <meta http-equiv> windows-1255", EN_HEAD.replace('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1255">'), {}, sig(enWant)],
    ["<meta charset=windows-1255> (unquoted)", HE_PAGE.replace('<meta charset="utf-8">', "<meta charset=windows-1255>"), {}, sig(heWant)],
    ["a part header naming the charset (an IE/Word .mht), no <meta>", HE_PAGE.replace('<meta charset="utf-8">', ""), { type: 'text/html; charset="windows-1255"' }, sig(heWant)],
    ["iso-8859-8 in the <meta> (it has no en dash: plain hyphens)", HE_PAGE.replace('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-8">').replace(/–/g, "-"), {}, sig(heWant)],
  ]) {
    const f = join(dir, `cs-${label.length}.mhtml`); writeFileSync(f, mhtml(qpBytes(to1255(page)), opts));
    const r = await importChart({ host: "shop.example.com", htmlFile: f, JSDOM });
    check(`§1.9.11 ${label}: decoded in that charset, read as the UTF-8 page`, sig(r) === wantSig, JSON.stringify({ got: sig(r), want: wantSig, notes: r.notes }));
  }
  /* ...and what names no usable charset falls back to UTF-8 - a <meta> label no decoder
     knows is skipped (the HTML sniffing rule), never a refusal of a page that reads fine. */
  for (const [label, page] of [
    ["no charset anywhere (UTF-8 bytes)", HE_PAGE.replace('<meta charset="utf-8">', "")],
    ["a <meta> charset no decoder knows (UTF-8 bytes)", HE_PAGE.replace('<meta charset="utf-8">', '<meta charset="x-klingon">')],
  ]) {
    const f = join(dir, `fb-${label.length}.mhtml`); writeFileSync(f, mhtml(qp(page)));
    const r = await importChart({ host: "shop.example.com", htmlFile: f, JSDOM });
    check(`§1.9.12 ${label}: read as UTF-8`, sig(r) === sig(heWant), JSON.stringify({ got: sig(r), notes: r.notes }));
  }
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
  const fetchFail = async () => ({ ok: false, status: 404, text: "" });
  check("§3.5 a URL that fails (404) -> error with the status, nothing imported",
    /could not fetch https:\/\/a\.com\/g: HTTP 404/.test(await throwsMsg(() => importChart({ url: "https://a.com/g", fetchText: fetchFail, JSDOM })) || ""));
  /* A REFUSAL is not a failed fetch: Cloudflare's managed challenge and Akamai's "Access
     Denied" answer 403, a rate limit 429 (and Cloudflare now and then 503 with its
     challenge). Only a 200 challenge was reported BLOCKED; these read "could not fetch:
     HTTP 403" with no way in. Asked ONCE - a refusal is never retried. */
  const CF_BODY = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
  for (const [label, status, text] of [["403 (a challenge body)", 403, CF_BODY], ["403 (Access Denied)", 403, "<html><head><title>Access Denied</title></head><body>Reference #18</body></html>"],
    ["429 (rate limit)", 429, ""], ["503 carrying a Cloudflare challenge", 503, CF_BODY]]) {
    let asked = 0;
    const refuse = async (u) => { asked++; return { ok: false, status, url: u, contentType: "text/html", text }; };
    const m = await throwsMsg(() => importChart({ host: "adidas.co.il", url: "https://www.adidas.co.il/size-guide", fetchText: refuse, JSDOM }));
    check(`§3.5b a URL answering ${label} -> BLOCKED with the manual way in (--html / --image), asked once, never retried`,
      /^BLOCKED/.test(m || "") && /--html/.test(m) && /--image/.test(m) && /do not work around/.test(m) && asked === 1, JSON.stringify({ m, asked }));
  }
  const m429 = await throwsMsg(() => importChart({ host: "a.com", url: "https://a.com/g", fetchText: async (u) => ({ ok: false, status: 429, url: u, text: "" }), JSDOM }));
  check("§3.5c ...naming what refused it (HTTP 429)", /refused us \(HTTP 429\)/.test(m429 || ""), m429);

  /* A --host that IS given but is not a hostname was reported as "--host is required". */
  for (const bad of ["חנות.co.il", "localhost", "foxcoil"]) {
    const m = await throwsMsg(() => importChart({ host: bad, htmlFile, JSDOM }));
    check(`§3.3b --host ${JSON.stringify(bad)} -> "not a valid store hostname", never "--host is required"`,
      /is not a valid store hostname/.test(m || "") && m.includes(`"${bad}"`) && !/--host is required/.test(m || ""), m);
  }
  const idn = await throwsMsg(() => importChart({ host: "חנות.co.il", htmlFile, JSDOM }));
  check("§3.3c ...an IDN is shown in the xn-- form the store key uses", /--host xn--[a-z0-9-]+\.co\.il/.test(idn || ""), idn);
  const badWithUrl = await throwsMsg(() => importChart({ host: "foxcoil", url: "https://shop.example.com/size", fetchText: async () => { throw new Error("fetched"); }, JSDOM }));
  check("§3.3d ...and with --url as well, nothing is fetched under a host that was refused", /not a valid store hostname/.test(badWithUrl || ""), badWithUrl);

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
  /* "--only=2" (the equals form) was not "--only": no filter, every chart summarised - and
     with --yes saved unasked, the failure parseOnly exists to close. Every flag takes the
     equals form now, and a bad value there is refused the same way. */
  const T2 = (h, rows) => `<section><h2>${h}</h2><table><tr><th>Size</th><th>Chest</th></tr>${rows}</table></section>`;
  const eqFile = join(dir, "eq.html");
  writeFileSync(eqFile, `<html><head><title>Size guide</title></head><body>${T2("Women's tops", "<tr><td>XS</td><td>80-84</td></tr><tr><td>S</td><td>85-89</td></tr><tr><td>M</td><td>90-94</td></tr>")}` +
    `${T2("Men's tops", "<tr><td>M</td><td>95-99</td></tr><tr><td>L</td><td>100-104</td></tr><tr><td>XL</td><td>105-109</td></tr>")}</body></html>`);
  const eq = spawnSync(process.execPath, [cli, "--dry-run", "--host=shop.example.com", "--html", eqFile, "--only=2", "--type=outerwear"], { encoding: "utf8", timeout: 60000, env: noDb });
  check("§3.10 --only=2 --type=outerwear (equals form) picks #2 alone and labels it",
    eq.status === 0 && /1 chart\(s\) to import/.test(eq.stdout) && /#2 {2}men \/ adult \/ outerwear/.test(eq.stdout) && !/#1 /.test(eq.stdout),
    JSON.stringify({ status: eq.status, stdout: eq.stdout.slice(0, 400), stderr: eq.stderr.slice(0, 200) }));
  const eqBad = spawnSync(process.execPath, [cli, "--dry-run", "--host", "shop.example.com", "--html", eqFile, "--only=all", "--yes"], { encoding: "utf8", timeout: 60000, env: noDb });
  check("§3.10b --only=all -> exit 2 naming --only, nothing summarised",
    eqBad.status === 2 && /--only takes chart numbers/.test(eqBad.stderr) && !/chart\(s\) to import/.test(eqBad.stdout),
    JSON.stringify({ status: eqBad.status, stderr: eqBad.stderr.slice(0, 200) }));
  const eqEmpty = spawnSync(process.execPath, [cli, "--dry-run", "--host", "shop.example.com", "--html", eqFile, "--type="], { encoding: "utf8", timeout: 60000, env: noDb });
  check("§3.10c an empty --type= -> exit 2 naming --type, never an unlabelled import",
    eqEmpty.status === 2 && /--type needs a value/.test(eqEmpty.stderr) && !/chart\(s\) to import/.test(eqEmpty.stdout),
    JSON.stringify({ status: eqEmpty.status, stderr: eqEmpty.stderr.slice(0, 200) }));

  /* "Nothing importable" told the owner to add --gender/--age/--type - but every table the
     parser accepts is either a record or a "#n" note now, so that line only printed when NO
     table was accepted, where a label cannot help: a client-rendered guide saved closed. */
  const shellFile = join(dir, "js-shell.html");
  writeFileSync(shellFile, `<html><head><title>Size guide</title><script src="/apps/kiwi/sizing.js"></script></head><body><h1>Size guide</h1><div id="size-chart-root"></div></body></html>`);
  const sh = spawnSync(process.execPath, [cli, "--dry-run", "--host", "shop.example.com", "--html", shellFile], { encoding: "utf8", timeout: 60000, env: noDb });
  check("§3.11 nothing accepted -> the way in that can help (save the page with the guide OPEN / --image), never \"add --gender/--age/--type\"",
    sh.status === 0 && /Nothing importable\./.test(sh.stdout) && !/add --gender\/--age\/--type/.test(sh.stdout) &&
    /save the page with the guide open and use --html/.test(sh.stdout) && /screenshot the table and use --image/.test(sh.stdout),
    JSON.stringify({ status: sh.status, stdout: sh.stdout.slice(0, 600) }));

  /* A SOURCE IT CANNOT USE EXITS 2, whatever the source kind. --html already did (readFile
     throws), but the image reader hands its failures back as a note: a missing --image file,
     GIF bytes, a file over 8 MB, no GEMINI_API_KEY - and a --url that answered a PDF - printed
     the note, then "Nothing importable." and exited 0, which a wrapper reads as success. Each
     prints its own message and exits 2; nothing is summarised. "Nothing importable." (exit 0,
     §3.11) stays for a source that WAS read where no table passed. GEMINI_API_KEY is a dummy
     (every one of these fails before any request) or set EMPTY, which dotenv never fills. */
  const gifPng = join(dir, "really-gif.png"); writeFileSync(gifPng, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]));
  const bigPng = join(dir, "huge.png"); writeFileSync(bigPng, ""); truncateSync(bigPng, 9 * 1024 * 1024);
  const pngFile = join(dir, "chart.png"); writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  for (const [label, file, key, want] of [
    ["a missing --image file", join(dir, "does-not-exist.png"), "dummy-not-a-key", /image unreadable: ENOENT/],
    ["GIF bytes saved as .png", gifPng, "dummy-not-a-key", /GIF charts are not readable/],
    ["an --image file over 8 MB", bigPng, "dummy-not-a-key", /image larger than 8 MB/],
    ["no GEMINI_API_KEY for an image", pngFile, "", /GEMINI_API_KEY is not set/],
  ]) {
    const r = spawnSync(process.execPath, [cli, "--dry-run", "--host", "shop.example.com", "--image", file], { encoding: "utf8", timeout: 60000, env: { ...noDb, GEMINI_API_KEY: key } });
    check(`§3.12 CLI: ${label} -> its message, exit 2 (never "Nothing importable.", exit 0)`,
      r.status === 2 && want.test(r.stderr) && !/Nothing importable/.test(r.stdout) && !/chart\(s\) to import/.test(r.stdout),
      JSON.stringify({ status: r.status, stderr: r.stderr.slice(0, 300), stdout: r.stdout.slice(0, 300) }));
  }
  /* --url, against a local server (the CLI's own fetch): a PDF, and an image that is not one. */
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/guide.pdf")) { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF-1.4\n"); }
    res.writeHead(200, { "content-type": "image/png" }); res.end("<html>403 Forbidden</html>");
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const runAsync = (args, env) => new Promise((ok) => {
    const p = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
    const t = setTimeout(() => p.kill(), 60000);
    p.on("close", (status) => { clearTimeout(t); ok({ status, stdout, stderr }); });
  });
  const urlEnv = { ...noDb, GEMINI_API_KEY: "dummy-not-a-key", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  for (const [label, path, want] of [
    ["a --url that answers a PDF", "/guide.pdf", new RegExp(PDF_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["a --url image whose bytes are not an image", "/chart.png", /not a raster image/],
  ]) {
    const r = await runAsync(["--dry-run", "--host", "shop.example.com", "--url", base + path], urlEnv);
    check(`§3.12 CLI: ${label} -> its message, exit 2`,
      r.status === 2 && want.test(r.stderr) && !/Nothing importable/.test(r.stdout),
      JSON.stringify({ status: r.status, stderr: r.stderr.slice(0, 300), stdout: r.stdout.slice(0, 300) }));
  }
  srv.close();
  /* The library says which: `unusable` names a source that could not be used, and is null
     for one that was read - Gemini answering "not a size chart", or every table refused. */
  const reader = (outcome, detail) => async () => ({ outcome, detail, found: [] });
  const err = await importChart({ host: "shop.example.com", imageFile: "x.png", imageReader: reader("error", "image unreadable: ENOENT"), JSDOM });
  const notChart = await importChart({ host: "shop.example.com", imageFile: "x.png", imageReader: reader("not_a_chart", "Gemini: not a size chart"), JSDOM });
  const rejected = await importChart({ host: "shop.example.com", imageFile: "x.png", imageReader: reader("rejected", "the shared parser accepted none"), JSDOM });
  const pdf = await importChart({ url: "https://shop.example.com/g.pdf", fetchText: async (u) => ({ ok: true, status: 200, url: u, contentType: "application/pdf", text: "" }), JSDOM });
  check("§3.13 importChart: `unusable` is the image error's note and the PDF note; null for an image read as not a chart or refused",
    err.unusable === "image: error - image unreadable: ENOENT" && pdf.unusable === PDF_NOTE && notChart.unusable === null && rejected.unusable === null &&
    err.notes.includes(err.unusable) && pdf.notes.includes(PDF_NOTE),
    JSON.stringify({ err: err.unusable, pdf: pdf.unusable, notChart: notChart.unusable, rejected: rejected.unusable }));
}

console.log("\n── §4 --dry-run never saves ──");
{
  /* The CLI's save step is injectable (main(argv, { persist })), so the guard is tested
     where it stands: with --yes, nothing else stands between a summary and a write. */
  const { main } = await import("../scanner/import-chart.js");
  const run = async (args) => {
    const saves = [], lines = [], log = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await main(["node", "import-chart.js", "--host", "shop.example.com", "--html", htmlFile, ...args], { persist: async (out) => { saves.push(out); } }); }
    finally { console.log = log; }
    return { saves, out: lines.join("\n") };
  };
  const dry = await run(["--dry-run", "--yes"]);
  check("§4.1 --dry-run --yes: the summary prints, the save is never called",
    dry.saves.length === 0 && /1 chart\(s\) to import/.test(dry.out) && /Dry run - nothing written\./.test(dry.out), JSON.stringify(dry));
  const wet = await run(["--yes"]);
  check("§4.2 control: the same run without --dry-run reaches the save once, with the summarised records",
    wet.saves.length === 1 && wet.saves[0].records.length === 1 && wet.saves[0].host === "shop.example.com", JSON.stringify({ saves: wet.saves.length }));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("manual-import: all checks passed.");
