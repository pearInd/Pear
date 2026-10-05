#!/usr/bin/env node
/* =============================================================================
   PEAR - MANUAL size-chart import: the guaranteed way in for any store
   -----------------------------------------------------------------------------
       npm run import:chart -- --host <store-host> (--url <page-or-image-url> |
                                                     --html <saved-page.html> |
                                                     --image <screenshot.png|jpg|webp>)
                               [--gender men|women|unisex|unknown] [--age adult|kids]
                               [--type tops|bottoms|jeans|dresses|outerwear]
                               [--only 1,3] [--dry-run] [--yes]

   For a store the automatic capture cannot read (bot-protected, a guide only a logged-in
   or human session sees, an image the OCR could not settle): open the guide yourself,
   then hand over its URL, the page saved with Ctrl+S, or a screenshot of the table.

   SAME PARSER, SAME VALIDATION, SAME SAVE as every other path: HTML goes through
   extractAllSizeCharts() (the shared widget parser), an image through Gemini ->
   image-charts.js -> the same parser, and the result through buildRecords() and
   saveSizeChartRecords(). The flags only LABEL what the parser accepted - who the chart
   is for. They cannot add a row, change a number or rescue a table the parser refused;
   a value outside the enums is an error, not a guess. Manual charts are store-wide
   (product_key '').

   --only PICKS FIRST, THE FLAGS LABEL WHAT WAS PICKED. Every table the parser accepted has
   one number, the same with or without flags (THE NUMBERING, below); the summary prints it,
   --only picks by it, and the flags then replace the labels of the picked charts alone - of
   every chart when there is no --only. A table the source leaves untyped (suits) is listed
   by its number with how to import it. Two picked charts the flags push onto one key
   cannot both be stored - that is reported, naming both, never dropped quietly.
   ============================================================================= */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractAllSizeCharts, buildRecords, saveSizeChartRecords, canonicalStoreHost, defaultFetchText, unwrapHtmlEnvelope,
  looksLikeBotChallenge, classifyChart, pageContextText, referrerAudience, toStoredRows, contentHash } from "./size-charts.js";
import { GUIDE_BOUNDARY } from "./browser-capture.js";
import { loadScannerEnv, parseCliArgs, formatChartSummary, askYesNo, saveAndVerify } from "./capture-cli.js";

export const OVERRIDE_VALUES = {
  gender: ["men", "women", "unisex", "unknown"],
  age_group: ["adult", "kids"],
  garment_type: ["tops", "bottoms", "jeans", "dresses", "outerwear"],
};

/** Throws on a value outside the table's CHECK constraints - never coerces. */
export function validateOverrides(ov = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(OVERRIDE_VALUES)) {
    const v = ov[key];
    if (v == null || v === "") continue;
    const s = String(v).trim().toLowerCase();
    if (!allowed.includes(s)) throw new Error(`--${key === "age_group" ? "age" : key === "garment_type" ? "type" : key} must be one of ${allowed.join("|")} (got "${v}")`);
    out[key] = s;
  }
  return out;
}

/* --only's value: chart numbers as the summary prints them ("1,3"). Anything
   else is an ERROR. The first cut parsed "--only all", "#2" or a forgotten number
   ("--only --yes" - the next flag read as the value) to an EMPTY list, which importChart()
   read as "no filter": every chart kept, and with --yes upserted over the store's rows
   without a prompt. "1-3" quietly became [1]. */
export function parseOnly(raw) {
  const s = raw == null ? "" : String(raw).trim();
  const toks = s.split(",").map((t) => t.trim());
  if (!s || s.startsWith("--") || !toks.every((t) => /^[1-9]\d*$/.test(t))) {
    throw new Error(`--only takes chart numbers from the summary, comma-separated, e.g. --only 1,3 (got "${s || "nothing"}")`);
  }
  return [...new Set(toks.map(Number))];
}

/* A label the owner typed is stronger evidence than any context word: it replaces the
   classifier's answer for that field and takes back the confidence that field's
   uncertainty cost (classifyChart's own penalties: -0.25 unknown gender, -0.15 type
   from columns, -0.05 type from page). The rows are untouched. importChart() applies it
   to the charts --only picked, and only to those (see THE NUMBERING there). */
export function applyOverrides(cls, ov) {
  const next = { ...cls };
  let conf = cls.confidence;
  if (ov.gender) { if (cls.gender === "unknown" && ov.gender !== "unknown") conf += 0.25; next.gender = ov.gender; }
  if (ov.age_group) next.ageGroup = ov.age_group;
  if (ov.garment_type) {
    if (cls.typeFrom === "columns") conf += 0.15; else if (cls.typeFrom === "page") conf += 0.05;
    next.garmentType = ov.garment_type; next.typeFrom = "manual";
  }
  next.confidence = Math.round(Math.min(0.95, conf) * 100) / 100;
  return next;
}

/**
 * Import one source for one host. Pure over its injectables (fetchText, imageReader).
 * @returns {Promise<{host:string, records:Array<object>, numbers:string[], total:number, report:object, notes:string[]}>}
 *   numbers[i] is records[i]'s chart number (THE NUMBERING); total is how many tables the source has.
 */
export const NO_TABLE_NOTE = "no table the shared parser accepts was found in that source";
export const PDF_NOTE = "PDF chart - not read automatically; screenshot it and use --image";   // capture.js's words

export async function importChart({ host, url = "", htmlFile = "", imageFile = "", overrides = {}, only = null,
  fetchText = defaultFetchText, imageReader = null, JSDOM = null, apiKey = process.env.GEMINI_API_KEY || "" } = {}) {
  const JSDOMCtor = JSDOM || (await import("jsdom")).JSDOM;
  const storeHost = canonicalStoreHost(host || (url ? new URL(url).hostname : ""));
  if (!storeHost) throw new Error("--host is required (the store's hostname, e.g. fox.co.il)");
  const sources = [url, htmlFile, imageFile].filter(Boolean).length;
  if (sources !== 1) throw new Error("give exactly one of --url, --html, --image");
  const ov = validateOverrides(overrides);
  const notes = [];
  let found = [];
  const readImage = async (src, source, sourceUrl) => {
    const read = imageReader || (await import("./image-charts.js")).chartsFromImage;
    const res = await read(src, { apiKey, JSDOM: JSDOMCtor, source, sourceUrl, context: "" });
    notes.push(`image: ${res.outcome} - ${res.detail}`);
    return res.found;
  };
  /* A GUIDE SAVED OPEN OVER A PRODUCT PAGE - what the JS_UNREADABLE reason tells the owner
     to do ("save the page with the guide open, then --html") - gets the browser path's
     handling (chartsFromHtml, browser_modal): the context walk stops at the guide's own
     container (GUIDE_BOUNDARY), and the product page may say WHO the chart is for
     (referrerAudience) but never WHAT garment. The first cut read the whole page: on a
     terminalx page titled "מכנסי ג'ינס סלים - נשים" a dialog's chest+waist TOPS chart was
     stored as women's JEANS, store-wide at confidence 0.9, where the browser path read the
     same markup as women's tops. A page with no table inside a dialog/drawer/popup (a
     guide page of its own) keeps its title and headings, as Phase 1 reads it.
     The nearest boundary match is a guide only if it is not the PAGE: never <body>/<html>
     (Bootstrap marks <body> "modal-open"), never a wrapper that is or holds <main>, and
     never one that holds every <h1> on the page - the same line guideContainerOf() draws.
     Older Shopify themes wrap the whole page in a class the selector matches (Debut's
     #PageContainer.drawer-page-content, Brooklyn's is-moved-by-drawer): the first cut took
     that for a dialog, and a men's jeans guide page saved on Debut lost its title and was
     stored as men's bottoms at 0.65 where "page-container" alone gave jeans at 0.85. */
  const readHtml = (html, pageUrl, source) => {
    const doc = new JSDOMCtor(html, { url: pageUrl }).window.document;
    const h1s = [...doc.querySelectorAll("h1")];
    const guide = [...doc.querySelectorAll('table,[role="table"]')].some((t) => {
      const box = t.closest(GUIDE_BOUNDARY);
      return !!box && box.tagName !== "BODY" && box.tagName !== "HTML" &&
        !box.matches("main,[role=main]") && !box.querySelector("main,[role=main]") &&
        !(h1s.length && h1s.every((h) => box.contains(h)));
    });
    const charts = extractAllSizeCharts(doc, pageUrl, null, guide ? { contextBoundary: GUIDE_BOUNDARY } : {});
    if (guide) {
      const ref = referrerAudience([pageContextText(doc, pageUrl)]);
      for (const c of charts) c.classification = classifyChart(c.rows, c.localText, "", ref);
    }
    return charts.map((chart) => ({ chart, source, sourceUrl: pageUrl, productUrl: "" }));
  };

  if (imageFile) {
    found = await readImage({ file: imageFile }, "manual_image", "file:" + imageFile.split(/[\\/]/).pop());
  } else if (url) {
    const r = unwrapHtmlEnvelope(await fetchText(url));
    if (!r.ok) throw new Error(`could not fetch ${url}: ${r.error || "HTTP " + r.status}`);
    /* A 200 that is a bot-protection CHALLENGE, not the guide (adidas.co.il answers a plain
       HTTP client exactly so - see looksLikeBotChallenge). Parsed, it found nothing and the
       owner was told to add --gender/--age/--type, which cannot help. It is BLOCKED, with
       the manual way in, as the static and browser stages report it - never worked around. */
    if (!r.envelope && looksLikeBotChallenge(r)) {
      throw new Error(`BLOCKED - ${url} answered with a bot-protection challenge page, not the guide. We do not work around ` +
        "bot protection: open the guide in your own browser, save it (Ctrl+S) or screenshot it, then use --html <saved page> or --image <screenshot>");
    }
    /* WHAT the URL answered decides the reader. The first cut sent only image/* to the image
       reader, so an image served as application/octet-stream (cdn.kiwisizing.com's chart
       PNGs - the case image-charts.js sniffs the magic bytes for) or with no type at all went
       to the HTML parser as "no table found". The image reader refuses bytes that are not a
       raster image itself, with an accurate note. A PDF gets the automatic path's note. */
    const ct = String(r.contentType || "").split(";")[0].trim().toLowerCase();
    const octet = /^(?:application|binary)\/octet-stream$/.test(ct);
    const ext = (re) => [url, r.url || ""].some((u) => re.test(u));
    if (/pdf/.test(ct) || ((!ct || octet) && ext(/\.pdf(?:$|[?#])/i))) {
      notes.push(PDF_NOTE);
    } else if (/^image\//.test(ct) || octet || (!ct && ext(/\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i))) {
      /* No --host: the store key would be the IMAGE's host - usually a CDN
         (cdn.shopify.com), a key the room never asks for and the next store imported the
         same way would overwrite. A page URL on the store itself still names the store. */
      if (!host) throw new Error("--host is required for an image URL - an image is usually served from a CDN, not the store's own host (e.g. --host fox.co.il)");
      found = await readImage({ url }, "manual_image", url);
    } else found = readHtml(r.text, r.url || url, "manual_url");
  } else {
    let text = await readFile(htmlFile, "utf8");
    const env = unwrapHtmlEnvelope({ ok: true, text });
    if (env.envelope) text = env.text;
    found = readHtml(text, `https://${storeHost}/`, "manual_html");
    for (const f of found) f.sourceUrl = "file:" + htmlFile.split(/[\\/]/).pop();
  }
  if (!found.length && !notes.length) notes.push(NO_TABLE_NOTE);

  /* THE NUMBERING. Every table the shared parser accepted has ONE number, in the order the
     source shows them, fixed before any flag: the summary prints it beside each chart, a
     note names a table that is not imported by it, and --only picks by it - BEFORE the
     flags label, which then relabel the picked charts alone. The same table twice (a
     desktop and a mobile copy) is one number.
     THE BUGS THIS CLOSES. The first cut labelled every chart first and filtered the merged
     records after: "--gender women" meant for the one unlabelled table also relabelled the
     table under "Men", the two collided, and "--only 2" counted the MERGED list. The second
     numbered a plain run's RECORDS: a run with flags printed other numbers than --only
     picked by ("--type outerwear --only 2" saved the men's chart the summary had shown as
     #3, with --yes unasked), and a table the classifier leaves untyped on purpose (suits)
     had no number - it could not be imported at all. */
  const numbered = [];
  let total = 0;
  for (const f of found) {
    const stored = toStoredRows(f.chart.rows), hash = contentHash(stored), c = f.chart.classification;
    const twin = numbered.find((x) => x.hash === hash && x.f.source === f.source && x.c0.gender === c.gender &&
      x.c0.ageGroup === c.ageGroup && x.c0.garmentType === c.garmentType);
    const cols = [...new Set(stored.flatMap((r) => Object.keys(r.body)))].join("+");
    numbered.push({ f, n: twin ? twin.n : ++total, hash, c0: c, label: `${stored.map((r) => r.size).join("/")}, ${cols}` });
  }
  let picked = numbered;
  if (Array.isArray(only)) {   // an empty list picks nothing - never "no filter"
    picked = numbered.filter((x) => only.includes(x.n));
    const missing = only.filter((n) => n > total);
    if (missing.length) notes.push(`--only ${missing.join(",")}: no such chart - this source has ${total} chart(s)`);
  }
  for (const x of picked) x.f.chart.classification = applyOverrides(x.f.chart.classification, ov);
  /* A picked table with no garment type - the source does not say, and no --type was given -
     is not stored (buildRecords' rule); it is named here by its number, with the one way in. */
  const typed = picked.filter((x) => x.f.chart.classification.garmentType);
  const untypedNs = new Set();
  for (const x of picked) {
    if (x.f.chart.classification.garmentType || untypedNs.has(x.n)) continue;
    untypedNs.add(x.n);
    notes.push(`#${x.n} (${x.label}): the source does not say which garment it is for - not imported. ` +
      `To import it alone: --only ${x.n} --type <${OVERRIDE_VALUES.garment_type.join("|")}>`);
  }
  const report = { charts: [], conflicts: [] };
  const records = buildRecords(typed.map((x) => x.f), storeHost, report);
  const sameKey = (c, r) => r.gender === c.gender && r.age_group === c.ageGroup && r.garment_type === c.garmentType;
  const numbers = records.map((r) => [...new Set(typed.filter((x) => x.hash === r.content_hash && x.f.source === r.source &&
    sameKey(x.f.chart.classification, r)).map((x) => x.n))].join(","));

  /* One key holds one chart. Two different picked charts on one key (the flags pushed
     them there, or the source labels them alike) keep one - buildRecords' rule - and the
     note names BOTH by their numbers and sizes: every source_url of a manual import is the
     same file, so the generic conflict line could not say which table was lost. */
  const keyOf = (c, source) => [c.gender, c.ageGroup, c.garmentType, c.sizeSystem, "", source].join("|");
  const byKey = new Map();
  for (const x of typed) {
    const k = keyOf(x.f.chart.classification, x.f.source);
    if (!byKey.has(k)) byKey.set(k, []);
    if (!byKey.get(k).some((y) => y.hash === x.hash)) byKey.get(k).push(x);
  }
  const named = new Set();
  const nameOf = (x) => `#${x.n} (${x.label})`;
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    named.add(k);
    const rec = records.find((r) => keyOf({ gender: r.gender, ageGroup: r.age_group, garmentType: r.garment_type, sizeSystem: r.size_system }, r.source) === k);
    const kept = list.find((x) => rec && x.hash === rec.content_hash);
    notes.push(`${list.map(nameOf).join(" and ")} land on one key (${k.split("|").slice(0, 4).join(" / ")}) and one key holds one chart: ` +
      `saving ${kept ? nameOf(kept) : "one"}, NOT saving ${list.filter((x) => x !== kept).map(nameOf).join(", ")}. ` +
      "Import them one at a time: --only <n> with that chart's own --gender/--age/--type.");
  }
  for (const c of report.conflicts) {
    if (c.key && named.has(c.key)) continue;
    notes.push(c.reason + (c.source_url ? " - " + c.source_url : ""));
  }
  return { host: storeHost, records, numbers, total, report, notes };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────── */
async function main(argv) {
  loadScannerEnv();
  const { val, flag } = parseCliArgs(argv);
  /* A label flag given with nothing after it (`--type=`, or `--type` last) is a typo, not
     "no label": silently importing unlabelled is the failure --only=1 once had. */
  const label = (f) => {
    if (!flag(f)) return undefined;
    const v = val(f);
    if (v == null || !String(v).trim()) throw new Error(`${f} needs a value`);
    return v;
  };
  let out;
  try {
    out = await importChart({
      host: val("--host"), url: val("--url") || "", htmlFile: val("--html") || "", imageFile: val("--image") || "",
      overrides: { gender: label("--gender"), age_group: label("--age"), garment_type: label("--type") },
      only: flag("--only") ? parseOnly(val("--only")) : null,
    });
  } catch (e) {
    console.error("✗ " + e.message);
    console.error("Usage: npm run import:chart -- --host <host> (--url <url> | --html <file> | --image <file>) [--gender ..] [--age ..] [--type ..] [--only 1,2] [--dry-run] [--yes]");
    process.exit(2);
  }
  console.log(`═══ ${out.host}: ${out.records.length} chart(s) to import ═══`);
  console.log(formatChartSummary(out.records, out.numbers));
  for (const n of out.notes) console.log("  ! " + n);
  if (!out.records.length) {
    /* The label hint only where labels could help - not after a note that already says
       what went wrong (a PDF, an unreadable image, a number --only does not have, an untyped
       table already named with its --type line). */
    const told = out.notes.some((n) => n === PDF_NOTE || /^image: (?:error|not_a_chart)|^--only |^#\d+ \(/.test(n));
    console.log("\nNothing importable." + (told ? "" : " If the table has no audience/garment words, add --gender/--age/--type; " +
      "if it was refused for its values, the source is not a body-measurement chart the room can use."));
    return;
  }
  if (flag("--dry-run")) { console.log("\nDry run - nothing written."); return; }
  if (!(await askYesNo(`\nSave these ${out.records.length} chart(s) for ${out.host}?`, { assumeYes: flag("--yes") }))) {
    console.log("Not saved."); return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (scanner/.env) - nothing saved.");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  await saveAndVerify({ supabase, records: out.records, host: out.host, saveSizeChartRecords });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => { console.error("✗ import failed:", e?.message || e); process.exit(1); });
}
