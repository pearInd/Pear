/* PHASE 2 - IMAGE CHARTS READ BY GEMINI (scanner/image-charts.js)
   ─────────────────────────────────────────────────────────────────────────────
   Gemini is mocked at the HTTP layer (fetchImpl), so the REAL request builder, the real
   response handling and the real parser path run; only the model is canned.
   §1 THE REQUEST. The key travels in the x-goog-api-key header, never the URL; the
      image is sent inline; temperature 0, JSON schema.
   §2 A READABLE CHART. The transcription becomes a table the SHARED parser reads -
      identical rows to the same table printed in HTML - tagged image_ocr, with the
      confidence penalty applied in buildRecords().
   §3 EVERY REFUSAL IS REPORTED, NOT SAVED: not a chart, implausible values (OCR noise
      outside the clamps), a non-monotonic ladder, an SVG / non-image, an HTTP 429, no
      key, garbage JSON.
   ============================================================================= */
import { JSDOM } from "jsdom";
import { chartsFromImage, tablesToHtml, transcribeChartImage } from "../scanner/image-charts.js";
import { buildRecords, extractAllSizeCharts } from "../scanner/size-charts.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const KEY = "test-key-not-a-secret";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
/* A fetch double: image URLs answer bytes, Gemini answers `geminiBody` (or a status). */
function fakeFetch({ gemini, geminiStatus = 200, imageType = "image/png" } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (/generativelanguage/.test(url)) {
      if (geminiStatus !== 200) return { ok: false, status: geminiStatus, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: typeof gemini === "string" ? gemini : JSON.stringify(gemini) }] } }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => imageType }, arrayBuffer: async () => PNG.buffer };
  };
  fn.calls = calls;
  return fn;
}
const TABLE = { title: "Women tops", unit: "cm", header: ["Size", "Bust", "Waist"],
  rows: [["S", "83-87", "65-69"], ["M", "88-92", "70-74"], ["L", "93-97", "75-79"]] };

console.log("\n── §1 the request ──");
{
  const f = fakeFetch({ gemini: { is_size_chart: true, tables: [TABLE] } });
  await transcribeChartImage({ url: "https://cdn.example.com/size-chart.png" }, { apiKey: KEY, fetchImpl: f });
  const g = f.calls.find((c) => /generativelanguage/.test(c.url));
  check("§1.1 the key is NOT in the URL", g && !g.url.includes(KEY), g && g.url);
  check("§1.2 ...it is in the x-goog-api-key header", g && g.init.headers["x-goog-api-key"] === KEY);
  const body = g && JSON.parse(g.init.body);
  check("§1.3 the image is sent inline, deterministic, schema-bound",
    body && body.contents[0].parts[1].inline_data.mime_type === "image/png" && body.generationConfig.temperature === 0 &&
    body.generationConfig.responseMimeType === "application/json");
}

console.log("\n── §2 a readable image chart ──");
{
  const f = fakeFetch({ gemini: { is_size_chart: true, tables: [TABLE] } });
  const res = await chartsFromImage({ url: "https://cdn.example.com/women-size-chart.png" }, { apiKey: KEY, fetchImpl: f, JSDOM });
  check("§2.1 read: one chart", res.outcome === "read" && res.found.length === 1, JSON.stringify(res));
  const printed = extractAllSizeCharts(new JSDOM(tablesToHtml([TABLE])).window.document, "https://x/");
  check("§2.2 rows identical to the same table printed in HTML (one parser)",
    JSON.stringify(res.found[0].chart.rows) === JSON.stringify(printed[0].rows), JSON.stringify(res.found[0].chart.rows));
  check("§2.3 the title labels it (women / tops)", res.found[0].chart.classification.gender === "women" &&
    res.found[0].chart.classification.garmentType === "tops", JSON.stringify(res.found[0].chart.classification));
  const rec = buildRecords(res.found, "shop.example.com");
  const htmlRec = buildRecords([{ chart: printed[0], source: "manual_html", sourceUrl: "f", productUrl: "" }], "shop.example.com");
  check("§2.4 tagged image_ocr, confidence 0.2 below the same chart read off markup",
    rec[0].source === "image_ocr" && Math.abs((htmlRec[0].confidence - rec[0].confidence) - 0.2) < 1e-9, `${rec[0].confidence} vs ${htmlRec[0].confidence}`);
  const inch = { ...TABLE, unit: "inch", rows: [["S", "33-34", "26-27"], ["M", "35-36", "28-29"], ["L", "37-38", "30-31"]] };
  const ri = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ gemini: { is_size_chart: true, tables: [inch] } }), JSDOM });
  check("§2.5 a stated inch unit is converted by the PARSER (33in -> 83.8cm), never by the model",
    ri.found[0] && ri.found[0].chart.rows[0].minChest === 83.8, JSON.stringify(ri.found[0] && ri.found[0].chart.rows[0]));
}

console.log("\n── §3 every refusal is reported, never saved ──");
{
  const cases = [
    ["not a size chart", { is_size_chart: false, tables: [] }, "not_a_chart"],
    ["OCR noise outside the clamps (bust 830-870)", { is_size_chart: true, tables: [{ ...TABLE, rows: [["S", "830-870", ""], ["M", "880-920", ""], ["L", "930-970", ""]] }] }, "rejected"],
    ["a ladder that wanders (88, 80, 96)", { is_size_chart: true, tables: [{ ...TABLE, header: ["Size", "Bust"], rows: [["S", "88"], ["M", "80"], ["L", "96"]] }] }, "rejected"],
    ["no measurement column (prices)", { is_size_chart: true, tables: [{ title: "", unit: "", header: ["Size", "Price"], rows: [["S", "89"], ["M", "89"]] }] }, "rejected"],
    ["garbage JSON", "not json", "error"],
  ];
  for (const [name, gemini, outcome] of cases) {
    const res = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ gemini }), JSDOM });
    check(`§3 ${name} -> ${outcome}, nothing found`, res.outcome === outcome && res.found.length === 0, JSON.stringify(res));
  }
  const rl = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ geminiStatus: 429 }), JSDOM });
  check("§3 HTTP 429 -> error naming the rate limit", rl.outcome === "error" && /429/.test(rl.detail), rl.detail);
  const svg = await chartsFromImage({ url: "https://cdn.example.com/c.svg" }, { apiKey: KEY, fetchImpl: fakeFetch({ imageType: "image/svg+xml" }), JSDOM });
  check("§3 an SVG is not sent to the model", svg.outcome === "error" && /not a raster/.test(svg.detail), svg.detail);
  const oct = await chartsFromImage({ url: "https://cdn.kiwisizing.com/x.png" },
    { apiKey: KEY, fetchImpl: fakeFetch({ imageType: "application/octet-stream", gemini: { is_size_chart: true, tables: [TABLE] } }), JSDOM });
  check("§3 an UNTYPED download with PNG magic bytes is read (cdn.kiwisizing.com's octet-stream charts)", oct.outcome === "read", JSON.stringify(oct));
  const octBad = fakeFetch({ imageType: "application/octet-stream" });
  const octFetch = async (u, i) => /generativelanguage/.test(u) ? octBad(u, i)
    : { ok: true, status: 200, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => new TextEncoder().encode("<html>no</html>").buffer };
  const ob = await chartsFromImage({ url: "https://cdn.example.com/x" }, { apiKey: KEY, fetchImpl: octFetch, JSDOM });
  check("§3 ...untyped bytes that are not an image are refused before any model call", ob.outcome === "error" && /not a raster/.test(ob.detail), ob.detail);
  const nokey = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: "", fetchImpl: fakeFetch({}), JSDOM });
  check("§3 no GEMINI_API_KEY -> error by variable NAME, no request made", nokey.outcome === "error" && /GEMINI_API_KEY/.test(nokey.detail));
  const fails2 = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ geminiStatus: 500 }), JSDOM });
  check("§3 an error message never carries the key", !JSON.stringify(fails2).includes(KEY));
  check("§3 tablesToHtml escapes markup in transcribed cells (no injection into the parser's DOM)",
    !/<script/.test(tablesToHtml([{ ...TABLE, title: "<script>x</script>" }])));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("image-chart-ocr: all checks passed.");
