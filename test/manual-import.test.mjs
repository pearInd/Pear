/* PHASE 2 - MANUAL IMPORT, the guaranteed way in (scanner/import-chart.js)
   ─────────────────────────────────────────────────────────────────────────────
   §1 THE THREE SOURCES - a URL (page, JSON envelope, or an image URL), a saved HTML
      file, a screenshot - each through the shared parser and buildRecords(), tagged
      manual_url / manual_html / manual_image, store-wide.
   §2 OVERRIDES LABEL, THEY NEVER VALIDATE. --gender/--age/--type fill what the source
      does not say (and are checked against the table's enums); they cannot turn a
      price table or an implausible chart into a record.
   §3 INPUT ERRORS are errors (no host, two sources, an unknown enum), not guesses.
   ============================================================================= */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { importChart, validateOverrides, applyOverrides } from "../scanner/import-chart.js";

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
  check("§2.8 applyOverrides never touches the classification's rows-derived fields it was not asked to",
    applyOverrides({ gender: "men", ageGroup: "adult", garmentType: "tops", sizeSystem: "alpha", typeFrom: "context", confidence: 0.9 }, {}).sizeSystem === "alpha");
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
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("manual-import: all checks passed.");
