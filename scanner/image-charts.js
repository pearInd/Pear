/* =============================================================================
   PEAR - size-guide capture, Phase 2: IMAGE charts (Gemini reads the picture)
   -----------------------------------------------------------------------------
   Some stores publish their size guide as a picture or a screenshot. Gemini is asked to
   TRANSCRIBE it - header cells and row cells exactly as printed, nothing converted,
   nothing inferred - and the transcription is rendered back into a plain <table> and
   read by the SAME shared parser every other path uses (extractAllSizeCharts): units,
   clamps, monotonic ladders, the size-token rules, classifyChart(). A model reading
   digits off pixels is the one input here that can be confidently wrong, so:
     · Gemini never converts or normalises - the parser does that, identically to a
       printed table, and refuses what it would refuse;
     · the chart is tagged source "image_ocr" (or "manual_image") and buildRecords()
       lowers its confidence (SOURCE_CONFIDENCE_PENALTY);
     · a transcription the parser rejects is REPORTED, never saved.

   The key is GEMINI_API_KEY (the scanner's existing variable). It travels in the
   x-goog-api-key HEADER, never the URL, so no log line or error message can carry it.
   ============================================================================= */
import { readFile } from "node:fs/promises";
import { extractAllSizeCharts, classifyChart, referrerAudience } from "./size-charts.js";

export const IMAGE_OCR_MODEL = "gemini-3.1-flash-lite";   // same model the scanner's classifier uses
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const OCR_PROMPT = [
  "You transcribe clothing SIZE CHARTS from images. Output JSON only.",
  "If the image is not a garment size chart (a product photo, a logo, a shoe chart only, a care label), set is_size_chart=false and tables=[].",
  "Otherwise transcribe EVERY table in the image, exactly as printed:",
  "- header: the column headers, left to right, verbatim (keep words like 'Chest', 'חזה', 'Waist', units like 'cm'/'inch').",
  "- rows: one array per printed row, cells verbatim, same order as the header. Keep ranges as printed ('88-92').",
  "- title: the heading printed above that table (e.g. 'Women tops', 'גברים - חולצות'), or ''.",
  "- unit: 'cm' or 'inch' if the image states it, else ''.",
  "Do NOT convert units, do NOT fill gaps, do NOT invent rows or columns. A cell you cannot read is ''.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_size_chart: { type: "BOOLEAN" },
    tables: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          unit: { type: "STRING" },
          header: { type: "ARRAY", items: { type: "STRING" } },
          rows: { type: "ARRAY", items: { type: "ARRAY", items: { type: "STRING" } } },
        },
        required: ["header", "rows"],
      },
    },
  },
  required: ["is_size_chart", "tables"],
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* A transcription -> markup the shared parser reads like any printed table. The unit
   goes into the CAPTION ("All measurements in cm"), which is exactly the table-level
   tier sizeChartTableUnit() already reads - never stamped onto the cells. */
export function tablesToHtml(tables) {
  const parts = [];
  for (const t of Array.isArray(tables) ? tables : []) {
    if (!t || !Array.isArray(t.header) || !Array.isArray(t.rows) || !t.header.length || t.rows.length < 2) continue;
    const unit = /^(?:cm|inch|inches|in)$/i.test(String(t.unit || "").trim())
      ? (/^cm$/i.test(t.unit.trim()) ? "All measurements in cm" : "All measurements in inches") : "";
    const caption = [t.title, unit].filter(Boolean).map(esc).join(" - ");
    const head = `<tr>${t.header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
    const body = t.rows.filter(Array.isArray).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
    parts.push(`<section>${t.title ? `<h3>${esc(t.title)}</h3>` : ""}<table>${caption ? `<caption>${caption}</caption>` : ""}${head}${body}</table></section>`);
  }
  return `<!doctype html><html><body>${parts.join("\n")}</body></html>`;
}

export function sniffImageType(buf) {
  const b = buf || [];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function loadImage(src, fetchImpl) {
  if (src.bytes) return { base64: Buffer.from(src.bytes).toString("base64"), mimeType: src.mimeType || "image/png" };
  if (src.file) {
    const buf = await readFile(src.file);
    const ext = String(src.file).toLowerCase().split(".").pop();
    const mimeType = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext];
    if (!mimeType) throw new Error("unsupported image type ." + ext + " (png, jpg, webp, gif)");
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("image larger than 8 MB");
    return { base64: buf.toString("base64"), mimeType };
  }
  const resp = await fetchImpl(src.url, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error("image HTTP " + resp.status);
  let mimeType = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const declared = /^image\/(?:png|jpe?g|webp|gif)$/.test(mimeType);
  /* An UNTYPED download (cdn.kiwisizing.com serves its chart PNGs as
     application/octet-stream) is identified by its magic bytes; anything that declares
     another type (svg, html, json) is refused without a download. */
  if (!declared && mimeType && !/^(?:application\/octet-stream|binary\/octet-stream)$/.test(mimeType)) {
    throw new Error("not a raster image (" + mimeType + ")");
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("image larger than 8 MB");
  if (!declared) {
    mimeType = sniffImageType(buf);
    if (!mimeType) throw new Error("not a raster image (untyped bytes that are not png/jpeg/webp/gif)");
  }
  return { base64: buf.toString("base64"), mimeType };
}

/**
 * Ask Gemini to transcribe one image.
 * @param {{url?:string, file?:string, bytes?:Uint8Array, mimeType?:string}} src
 * @returns {Promise<{ok:boolean, isSizeChart:boolean, tables:Array<object>, error?:string}>}
 */
export async function transcribeChartImage(src, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, isSizeChart: false, tables: [], error: "GEMINI_API_KEY is not set" };
  let image;
  try { image = await loadImage(src, fetchImpl); } catch (e) { return { ok: false, isSizeChart: false, tables: [], error: "image unreadable: " + e.message }; }
  let resp;
  try {
    resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_OCR_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: OCR_PROMPT }] },
        contents: [{ parts: [{ text: "Transcribe the size chart(s) in this image." },
          { inline_data: { mime_type: image.mimeType, data: image.base64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return { ok: false, isSizeChart: false, tables: [], error: "Gemini request failed: " + e.message };
  }
  if (!resp.ok) {
    return { ok: false, isSizeChart: false, tables: [], error: `Gemini HTTP ${resp.status}${resp.status === 429 ? " (rate limited - retry later)" : ""}` };
  }
  try {
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = JSON.parse(text);
    return { ok: true, isSizeChart: !!parsed.is_size_chart, tables: Array.isArray(parsed.tables) ? parsed.tables : [] };
  } catch (e) {
    return { ok: false, isSizeChart: false, tables: [], error: "Gemini answer was not the expected JSON" };
  }
}

/**
 * One image -> found entries (for buildRecords) plus a one-line outcome.
 * @returns {Promise<{found:Array<object>, outcome:string, detail:string}>}
 *   outcome: "read" | "not_a_chart" | "rejected" (transcribed, but the parser refused
 *   every table) | "error"
 */
export async function chartsFromImage(src, { apiKey, fetchImpl = fetch, JSDOM, source = "image_ocr", productUrl = "", sourceUrl = "", context = "", referrerText = null } = {}) {
  const t = await transcribeChartImage(src, { apiKey, fetchImpl });
  if (!t.ok) return { found: [], outcome: "error", detail: t.error };
  if (!t.isSizeChart || !t.tables.length) return { found: [], outcome: "not_a_chart", detail: "Gemini: not a size chart" };
  const pageUrl = sourceUrl || src.url || "https://image.invalid/";
  /* The page the image came from (its title / URL words) is the chart's PAGE context, the
     same tier a guide page's own title is for a printed table - via <title>, which is
     what pageContextText() reads. */
  const html = tablesToHtml(t.tables).replace("<html>", `<html><head><title>${esc(context)}</title></head>`);
  const doc = new JSDOM(html, { url: /^https?:/.test(pageUrl) ? pageUrl : "https://image.invalid/" }).window.document;
  const charts = extractAllSizeCharts(doc, pageUrl);
  /* An image found inside a guide opened from a product page: like browser_modal, the
     product page and the trigger may say WHO (gender/kids), never the garment type. */
  if (referrerText != null) {
    const ref = referrerAudience([referrerText]);
    for (const c of charts) c.classification = classifyChart(c.rows, c.localText, "", ref);
  }
  if (!charts.length) {
    return { found: [], outcome: "rejected",
      detail: `Gemini transcribed ${t.tables.length} table(s), the shared parser accepted none (implausible values, no measurement column, or not a ladder) - not saved` };
  }
  return {
    found: charts.map((chart) => ({ chart, source, sourceUrl: pageUrl, productUrl })),
    outcome: "read",
    detail: `${charts.length} chart(s) from ${t.tables.length} transcribed table(s)`,
  };
}
