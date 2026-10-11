/* PHASE 2 - IMAGE CHARTS READ BY GEMINI (scanner/image-charts.js)
   ─────────────────────────────────────────────────────────────────────────────
   Gemini is mocked at the HTTP layer (fetchImpl), so the REAL request builder, the real
   response handling and the real parser path run; only the model is canned.
   §1 THE REQUEST. The key travels in the x-goog-api-key header, never the URL; the
      image is sent inline; temperature 0, JSON schema.
   §2 A READABLE CHART. The transcription becomes a table the SHARED parser reads -
      identical rows to the same table printed in HTML - tagged image_ocr, with the
      confidence penalty applied in buildRecords(). A one-row transposed chart or a
      headerless answer reaches the parser too: accepting is the parser's call alone.
   §3 EVERY REFUSAL IS REPORTED, NOT SAVED: not a chart, implausible values (OCR noise
      outside the clamps), a non-monotonic ladder, an SVG / non-image, an HTTP 429, no
      key, garbage JSON.
   §4 THE BYTES DECIDE THE MIME TYPE Gemini is sent (never "image/jpg", never a wrong
      label), and a GIF - not a Gemini input type - is refused before any model call. A
      file is judged by its bytes, not its extension (a Windows .jfif save is a JPEG); a
      name we accept with the wrong bytes is "not a raster image", never "unsupported";
      the 8 MB cap holds for a file of any extension.
   §5 ONLY AN HTTP(S) URL IS DOWNLOADED: a data: image - most often a lazy-load placeholder -
      (or file:/blob:) is refused with no request, never reported as a GIF to convert, and
      the detail gives the --image way round an inline chart.
   §6 THE IMAGE'S OWN URL WORDS LABEL IT on the browser path as on the static path - one
      image, one label; the referrer still says WHO, never WHAT; rows never change.
   ============================================================================= */
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function fakeFetch({ gemini, geminiStatus = 200, imageType = "image/png", bytes = PNG } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (/generativelanguage/.test(url)) {
      if (geminiStatus !== 200) return { ok: false, status: geminiStatus, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: typeof gemini === "string" ? gemini : JSON.stringify(gemini) }] } }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => imageType }, arrayBuffer: async () => bytes.buffer };
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

  /* A TRANSPOSED chest-only chart is ONE body row; tablesToHtml used to drop any table
     under two rows (and any empty header) before the parser saw it, and report it as
     "the parser accepted none". The same table printed in HTML reads as four sizes. */
  const TRANSPOSED = { title: "", unit: "cm", header: ["Size", "S", "M", "L", "XL"], rows: [["Chest", "88-92", "93-97", "98-102", "103-107"]] };
  const tr = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ gemini: { is_size_chart: true, tables: [TRANSPOSED] } }), JSDOM });
  const printedT = extractAllSizeCharts(new JSDOM(`<table><caption>All measurements in cm</caption><tr><th>Size</th><th>S</th><th>M</th><th>L</th><th>XL</th></tr>
    <tr><td>Chest</td><td>88-92</td><td>93-97</td><td>98-102</td><td>103-107</td></tr></table>`).window.document, "https://x/");
  check("§2.6 a one-row TRANSPOSED chart is read on the image path: 4 sizes, the rows the printed table gives",
    tr.outcome === "read" && tr.found[0].chart.rows.length === 4 && printedT.length === 1 &&
    JSON.stringify(tr.found[0].chart.rows) === JSON.stringify(printedT[0].rows), JSON.stringify(tr));
  const headless = { ...TABLE, header: [], rows: [TABLE.header, ...TABLE.rows] };
  const hl = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ gemini: { is_size_chart: true, tables: [headless] } }), JSDOM });
  check("§2.7 an answer with header [] and the header line in rows reads like the same table with a header",
    hl.outcome === "read" && JSON.stringify(hl.found[0].chart.rows) === JSON.stringify(res.found[0].chart.rows), JSON.stringify(hl));
  check("§2.8 ...and a table with nothing to draw is still skipped (no rows)",
    !/<table/.test(tablesToHtml([{ header: ["Size", "Chest"], rows: [] }, { header: ["Size"] }, null])));
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
  /* The fetch double is KEPT so "no request made" is checked, not only claimed: a key check
     moved below the image download (or between the Gemini request and its answer) still
     returned this error, and the first cut of this check stayed green on it. */
  const fNokey = fakeFetch({ gemini: { is_size_chart: true, tables: [TABLE] } });
  const nokey = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: "", fetchImpl: fNokey, JSDOM });
  check("§3 no GEMINI_API_KEY -> error by variable NAME, no request made",
    nokey.outcome === "error" && nokey.detail === "GEMINI_API_KEY is not set" && fNokey.calls.length === 0,
    JSON.stringify({ nokey, calls: fNokey.calls.map((c) => c.url) }));
  const fails2 = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fakeFetch({ geminiStatus: 500 }), JSDOM });
  check("§3 an error message never carries the key", !JSON.stringify(fails2).includes(KEY));
  check("§3 tablesToHtml escapes markup in transcribed cells (no injection into the parser's DOM)",
    !/<script/.test(tablesToHtml([{ ...TABLE, title: "<script>x</script>" }])));
}

console.log("\n── §4 the bytes decide the mime type; a GIF never reaches the model ──");
{
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
  const sent = (f) => {
    const g = f.calls.find((c) => /generativelanguage/.test(c.url));
    return g ? JSON.parse(g.init.body).contents[0].parts[1].inline_data.mime_type : null;
  };
  const ok = { is_size_chart: true, tables: [TABLE] };
  for (const [label, imageType, bytes, want] of [
    ["a CDN that labels its JPEG 'image/jpg'", "image/jpg", JPEG, "image/jpeg"],
    ["a JPEG served as 'image/png'", "image/png", JPEG, "image/jpeg"],
    ["image/jpeg; charset=binary", "image/jpeg; charset=binary", JPEG, "image/jpeg"],
  ]) {
    const f = fakeFetch({ gemini: ok, imageType, bytes });
    const t = await transcribeChartImage({ url: "https://cdn.example.com/c.jpg" }, { apiKey: KEY, fetchImpl: f });
    check(`§4.1 ${label} -> sent as ${want}`, t.ok && sent(f) === want, JSON.stringify({ t, sent: sent(f) }));
  }
  const fb = fakeFetch({ gemini: ok });
  await transcribeChartImage({ bytes: JPEG, mimeType: "image/jpg" }, { apiKey: KEY, fetchImpl: fb });
  check("§4.2 raw bytes labelled 'image/jpg' -> sent as image/jpeg", sent(fb) === "image/jpeg", sent(fb));
  for (const [label, src, fetchOpts] of [
    ["a declared image/gif", { url: "https://cdn.example.com/c.gif" }, { imageType: "image/gif", bytes: GIF }],
    ["GIF bytes served as octet-stream", { url: "https://cdn.example.com/c" }, { imageType: "application/octet-stream", bytes: GIF }],
    ["GIF bytes behind a PNG label", { url: "https://cdn.example.com/c.png" }, { imageType: "image/png", bytes: GIF }],
    ["raw GIF bytes", { bytes: GIF, mimeType: "image/gif" }, {}],
  ]) {
    const f = fakeFetch({ gemini: ok, ...fetchOpts });
    const r = await chartsFromImage(src, { apiKey: KEY, fetchImpl: f, JSDOM });
    check(`§4.3 ${label} -> refused as GIF with the way round it, NO model call`,
      r.outcome === "error" && /GIF/.test(r.detail) && /PNG/.test(r.detail) && !f.calls.some((c) => /generativelanguage/.test(c.url)), JSON.stringify(r));
  }
  const fNo = fakeFetch({ gemini: ok, imageType: "image/png", bytes: new TextEncoder().encode("<html>not an image</html>") });
  const no = await chartsFromImage({ url: "https://cdn.example.com/c.png" }, { apiKey: KEY, fetchImpl: fNo, JSDOM });
  check("§4.4 a declared image/png whose bytes are not an image -> refused before any model call",
    no.outcome === "error" && /not a raster/.test(no.detail) && !fNo.calls.some((c) => /generativelanguage/.test(c.url)), no.detail);

  const dir = mkdtempSync(join(tmpdir(), "pear-ocr-"));
  const gifFile = join(dir, "chart.gif"); writeFileSync(gifFile, GIF);
  const jpgFile = join(dir, "chart.jpg"); writeFileSync(jpgFile, JPEG);
  const pngAsJpg = join(dir, "shot.jpeg"); writeFileSync(pngAsJpg, PNG);
  const bmpFile = join(dir, "chart.bmp"); writeFileSync(bmpFile, new Uint8Array([0x42, 0x4d, 0, 0]));
  const fg = fakeFetch({ gemini: ok });
  const g = await chartsFromImage({ file: gifFile }, { apiKey: KEY, fetchImpl: fg, JSDOM });
  check("§4.5 a .gif file -> refused as GIF, no model call", g.outcome === "error" && /GIF/.test(g.detail) && fg.calls.length === 0, JSON.stringify(g));
  const fj = fakeFetch({ gemini: ok });
  await transcribeChartImage({ file: jpgFile }, { apiKey: KEY, fetchImpl: fj });
  const fp = fakeFetch({ gemini: ok });
  await transcribeChartImage({ file: pngAsJpg }, { apiKey: KEY, fetchImpl: fp });
  check("§4.6 a file is sent by its BYTES' type (a .jpg -> image/jpeg, PNG bytes saved as .jpeg -> image/png)",
    sent(fj) === "image/jpeg" && sent(fp) === "image/png", `${sent(fj)} / ${sent(fp)}`);
  const fbm = fakeFetch({ gemini: ok });
  const bm = await transcribeChartImage({ file: bmpFile }, { apiKey: KEY, fetchImpl: fbm });
  check("§4.7 an unsupported file type names what IS accepted - png, jpg, webp (not gif)",
    !bm.ok && /\(png, jpg, webp\)/.test(bm.error) && !/gif/i.test(bm.error) && fbm.calls.length === 0, bm.error);
  /* Windows maps image/jpeg to .jfif, so Chrome/Edge "Save image as" on a store's JPEG chart
     writes size-chart.jfif. The first cut refused it by its NAME before the bytes were
     looked at - "unsupported image type .jfif" for an ordinary JPEG. */
  const jfifFile = join(dir, "size-chart.jfif"); writeFileSync(jfifFile, JPEG);
  const noExt = join(dir, "screenshot"); writeFileSync(noExt, PNG);
  const fjf = fakeFetch({ gemini: ok });
  const jf = await transcribeChartImage({ file: jfifFile }, { apiKey: KEY, fetchImpl: fjf });
  const fne = fakeFetch({ gemini: ok });
  await transcribeChartImage({ file: noExt }, { apiKey: KEY, fetchImpl: fne });
  check("§4.8 a .jfif file with JPEG bytes (a Windows browser's save) -> read, sent as image/jpeg",
    jf.ok && sent(fjf) === "image/jpeg", JSON.stringify({ jf, sent: sent(fjf) }));
  check("§4.9 ...a file with no extension is judged by its bytes too (PNG bytes -> image/png)", sent(fne) === "image/png", sent(fne));
  const gifAsPng = join(dir, "chart-really-gif.png"); writeFileSync(gifAsPng, GIF);
  const fgp = fakeFetch({ gemini: ok });
  const gp = await chartsFromImage({ file: gifAsPng }, { apiKey: KEY, fetchImpl: fgp, JSDOM });
  check("§4.10 ...and GIF bytes saved as .png are still refused as GIF, no model call",
    gp.outcome === "error" && /GIF/.test(gp.detail) && fgp.calls.length === 0, JSON.stringify(gp));
  /* A name we accept is never called "unsupported": `curl -o chart.png` on a 403 page is a
     .png whose BYTES are wrong, and the second cut answered "unsupported image type .png
     (png, jpg, webp)" - a refusal that contradicts itself. */
  const htmlAsPng = join(dir, "chart.png"); writeFileSync(htmlAsPng, new TextEncoder().encode("<html>403 Forbidden</html>"));
  const fhp = fakeFetch({ gemini: ok });
  const hp = await transcribeChartImage({ file: htmlAsPng }, { apiKey: KEY, fetchImpl: fhp });
  check("§4.11 a .png file whose bytes are not an image -> 'not a raster image (.png file: ...)', never 'unsupported .png', no request",
    !hp.ok && hp.error === "image unreadable: not a raster image (.png file: bytes that are not png/jpeg/webp)" && fhp.calls.length === 0, hp.error);
  /* The cap is checked on the file's size before it is read: a video or an archive passed
     to --image by mistake is refused by its size, never loaded whole. (A sparse 9 MB file -
     no 9 MB written to disk.) */
  const big = join(dir, "turn.mp4"); writeFileSync(big, ""); truncateSync(big, 9 * 1024 * 1024);
  const fbg = fakeFetch({ gemini: ok });
  const bg = await transcribeChartImage({ file: big }, { apiKey: KEY, fetchImpl: fbg });
  check("§4.12 a file over 8 MB (any extension) -> 'image larger than 8 MB', no request",
    !bg.ok && bg.error === "image unreadable: image larger than 8 MB" && fbg.calls.length === 0, bg.error);
}

console.log("\n── §5 only an http(s) URL is downloaded ──");
{
  /* A lazysizes image - <img class="lazyload" src="data:image/gif;base64,..." data-src=".../size-chart.png">
     - reaches the image stage as its data: PLACEHOLDER (the static scan reads src before
     data-src). Node's fetch decodes data: locally, so the 1x1 GIF was read and refused as
     "GIF charts are not readable - save it as PNG": the operator was told to convert a GIF
     that does not exist, and a data:image/png placeholder cost a Gemini call. Any scheme
     but http(s) is refused before any request, and the detail names the placeholder. */
  const ok = { is_size_chart: true, tables: [TABLE] };
  const GIF_1x1 = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  for (const [label, url] of [
    ["a data:image/gif lazy-load placeholder", GIF_1x1],
    ["a data:image/png lazy-load placeholder", PNG_1x1],
    ["a file: URL", "file:///etc/hostname"],
    ["a blob: URL", "blob:https://shop.example.com/0b7e"],
  ]) {
    const f = fakeFetch({ gemini: ok, imageType: "image/gif", bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]) });
    const r = await chartsFromImage({ url }, { apiKey: KEY, fetchImpl: f, JSDOM });
    check(`§5.1 ${label} -> error, NO request (no download, no model call)`,
      r.outcome === "error" && f.calls.length === 0 && /not an http\(s\) image URL/.test(r.detail), JSON.stringify({ r, calls: f.calls.length }));
    check(`§5.2 ...and it is never reported as a GIF to convert`, !/GIF/.test(r.detail), r.detail);
  }
  /* ...without claiming every data: image is one: a chart pasted into a rich-text
     description can be inline base64, so the detail hedges and gives the way round it. */
  const dd = (await chartsFromImage({ url: GIF_1x1 }, { apiKey: KEY, fetchImpl: fakeFetch({}), JSDOM })).detail;
  check("§5.3 a data: image is named as MOST OFTEN a lazy-load placeholder (the chart in data-src), with the --image way round an inline one",
    /most often a lazy-load placeholder/.test(dd) && /data-src/.test(dd) && /screenshot it and use --image/.test(dd), dd);
  const fh = fakeFetch({ gemini: ok });
  const h = await chartsFromImage({ url: "HTTPS://cdn.example.com/size-chart.png" }, { apiKey: KEY, fetchImpl: fh, JSDOM });
  check("§5.4 an https URL (any case) is still downloaded and read", h.outcome === "read" && fh.calls.length === 2, JSON.stringify(h));
}

console.log("\n── §6 the image's own URL words label it, whichever stage found it ──");
{
  /* capture.js reads a STATIC hit with context = the image URL and no referrer, and a
     BROWSER hit with context "" and the referrer (product page | trigger). The referrer
     branch reclassified with an empty page text - dropping the image URL's own words - so
     .../size-chart-women-tops.png was women/tops (0.85) found statically and unknown/tops
     off its columns (0.5) found in a guide modal: one image, two labels. */
  const COLS = { title: "", unit: "cm", header: ["Size", "Chest", "Waist"],
    rows: [["S", "88-92", "70-74"], ["M", "93-97", "75-79"], ["L", "98-102", "80-84"]] };
  const read = (url, opts) => chartsFromImage({ url }, { apiKey: KEY, fetchImpl: fakeFetch({ gemini: { is_size_chart: true, tables: [COLS] } }), JSDOM, sourceUrl: url, ...opts });
  const cls = (r) => r.found[0] && r.found[0].chart.classification;
  const url = "https://cdn.store.example/files/size-chart-women-tops.png";
  const st = await read(url, { context: url, referrerText: null });
  const br = await read(url, { context: "", referrerText: "Basic tee | Size guide" });
  const brEmpty = await read(url, { context: "", referrerText: "" });
  check("§6.1 static stage: women / tops from the filename", cls(st) && cls(st).gender === "women" && cls(st).garmentType === "tops", JSON.stringify(cls(st)));
  check("§6.2 browser stage, a gender-neutral referrer: the SAME label as the static stage",
    JSON.stringify(cls(br)) === JSON.stringify(cls(st)), `${JSON.stringify(cls(br))} vs ${JSON.stringify(cls(st))}`);
  check("§6.3 ...and with an empty referrer", JSON.stringify(cls(brEmpty)) === JSON.stringify(cls(st)), JSON.stringify(cls(brEmpty)));
  const plain = "https://cdn.store.example/files/chart-01.png";
  const ref = await read(plain, { context: "", referrerText: "Basic tee | Men | Size guide" });
  check("§6.4 a filename with no words: the referrer still says WHO (men, from the referrer)",
    cls(ref) && cls(ref).gender === "men", JSON.stringify(cls(ref)));
  const refType = await read(plain, { context: "", referrerText: "Women's dresses | Size guide" });
  check("§6.5 ...and never WHAT: the referrer's 'dresses' does not type the chart (columns say tops)",
    cls(refType) && cls(refType).gender === "women" && cls(refType).garmentType === "tops" && cls(refType).typeFrom === "columns", JSON.stringify(cls(refType)));
  const rows = (r) => JSON.stringify(r.found.map((x) => x.chart.rows));
  check("§6.6 labels only - the rows are identical on both stages", rows(st) === rows(br) && rows(st) === rows(ref), rows(br));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("image-chart-ocr: all checks passed.");
