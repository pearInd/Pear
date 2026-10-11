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
   then hand over its URL, the page saved with Ctrl+S ("Webpage, Complete" keeps a guide you
   opened; a "Single File" .mhtml is decoded too), or a screenshot of the table. A URL that
   refuses us (403/429, a challenge page) is BLOCKED with this way in - asked once, never retried.

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
  looksLikeBotChallenge, classifyChart, pageContextText, referrerAudience, toStoredRows, contentHash, SIZE_GUIDE_LINK_RE } from "./size-charts.js";
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

/* A "WEBPAGE, SINGLE FILE" SAVE. Chrome/Edge's Ctrl+S offers .mhtml and remembers the last
   type used, and every manual way in says "save it (Ctrl+S)". Blink writes a MIME message
   whose HTML part is quoted-printable: "=" is =3D, every non-ASCII byte =XX (Hebrew is
   =D7=..), and a soft break "=\r\n" every 76 characters - inside a <td> or a <tr> as often as
   not. The first cut handed that raw to the parser, which dropped whichever rows or columns a
   break landed in, and the rows left over (S/L/XL, no M; the waist column alone) still passed
   validation - one y/n from a store-wide chart with sizes missing. The HTML part is DECODED
   here (quoted-printable or base64, in its charset) and read as the page it is; anything this
   cannot decode is refused with the save that works - "Webpage, Complete", which serializes
   the page as shown, guide open; "HTML only" saves the page as first served, without it -
   never parsed raw. `raw` is the file as latin1 (one char per byte), so a part's bytes
   survive to its own charset.
   @returns {{html:string, location:string}|null} null when the file is not MHTML. */
const MHTML_RESAVE = 'save the page again as "Webpage, Complete" and use its .html ("HTML only" saves the page as first served, without the guide you opened)';
export function decodeMhtml(raw, name = "the file") {
  const top = raw.slice(0, 8192), end = top.search(/\r?\n\r?\n/);
  const head = (end < 0 ? top : top.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  if (!/^MIME-Version:/im.test(head) || !/^Content-Type:\s*multipart\/related/im.test(head)) {
    if (/\.mht(?:ml)?$/i.test(name) && /^MIME-Version:/im.test(raw.slice(0, 2048))) {
      throw new Error(`${name} is a "Webpage, Single File" (.mhtml) save this cannot read (no multipart/related header) - ${MHTML_RESAVE}`);
    }
    return null;
  }
  const refuse = (why) => new Error(`${name} is a "Webpage, Single File" (.mhtml) save and its page could not be read (${why}) - ${MHTML_RESAVE}`);
  const boundary = (/boundary="?([^";\s]+)"?/i.exec(head) || [])[1];
  if (!boundary) throw refuse("no MIME boundary");
  const location = (/^Snapshot-Content-Location:\s*(\S+)/im.exec(head) || [])[1] || "";
  for (const part of raw.split("--" + boundary).slice(1)) {
    const cut = part.search(/\r?\n\r?\n/);
    if (cut < 0) continue;
    const hdr = part.slice(0, cut).replace(/\r?\n[ \t]+/g, " ");
    if (!/^Content-Type:\s*text\/html/im.test(hdr)) continue;   // the first HTML part is the page; later ones are its frames
    const cte = ((/^Content-Transfer-Encoding:\s*([^\s;]+)/im.exec(hdr) || [])[1] || "7bit").toLowerCase();
    const charset = ((/charset="?([^";\s]+)"?/i.exec(hdr) || [])[1] || "utf-8").toLowerCase();
    const body = part.slice(cut).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    let bytes;
    if (cte === "quoted-printable") {
      bytes = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    } else if (cte === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
    else if (/^(?:7bit|8bit|binary)$/.test(cte)) bytes = Buffer.from(body, "latin1");
    else throw refuse(`its HTML is ${cte}-encoded`);
    let html;
    try { html = new TextDecoder(charset).decode(bytes); } catch { throw refuse(`unknown charset "${charset}"`); }
    return { html, location: location || (/^Content-Location:\s*(\S+)/im.exec(hdr) || [])[1] || "" };
  }
  throw refuse("no HTML part");
}

/* THE ADDRESS A SAVED PAGE CAME FROM. Read as https://<host>/, a guide titled just "Size
   Guide" at /pages/mens-jeans-size-guide lost what its URL says (pageContextText reads the
   path): unknown/bottoms at 0.5 by file, men/jeans at 0.85 by --url and Phase 1. Chrome
   writes the address into the save - `<!-- saved from url=(NNNN)https://... -->` in a
   "Webpage, Complete" save, Snapshot-Content-Location in an .mhtml. It is CONTEXT only (no
   row changes), and it is used only on the store's own host: another store's address lends
   nothing. */
export function savedPageUrl(html, storeHost, location = "") {
  const at = location || (/<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s>]+?)\s*-->/i.exec(String(html).slice(0, 4096)) || [])[1] || "";
  try { if (at && canonicalStoreHost(new URL(at).hostname) === storeHost) return new URL(at).href; } catch { /* not a URL */ }
  return `https://${storeHost}/`;
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
  /* A --host that is GIVEN but is not a hostname (a Hebrew IDN, "localhost", a dropped dot)
     was reported as "--host is required" - and kept --url's own host from being used. It is
     named as refused, with the xn-- form the store key takes when it is an IDN. */
  const storeHost = canonicalStoreHost(host || (url ? new URL(url).hostname : ""));
  if (!storeHost && host) {
    let ascii = "";
    try { ascii = canonicalStoreHost(new URL("https://" + String(host).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")).hostname); } catch { /* not a host at all */ }
    throw new Error(`--host "${host}" is not a valid store hostname (letters, digits, dots and dashes, e.g. fox.co.il)` +
      (ascii && ascii !== String(host).trim().toLowerCase() ? ` - an internationalised name is keyed in its xn-- form: --host ${ascii}` : ""));
  }
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
     A REAL dialog ([role=dialog], [aria-modal], <dialog>) around the table is the guide,
     whatever it holds - guideContainerOf()'s first rule. The second cut put it through the
     page-wrapper tests below too, and a terminalx-style dialog carrying the page's only <h1>
     ("מדריך מידות", the product's title a <div>) "held every <h1>", read as the page, and its
     chest+waist chart was stored as women's JEANS at 0.85 again.
     A CLASS-ONLY match ([class*=modal|drawer|popup]) is a guide only if it is not the PAGE:
     never <body>/<html> (Bootstrap marks <body> "modal-open"), never a wrapper that is or holds
     <main>, never one that holds every <h1> on the page - the lines guideContainerOf() draws -
     and never one under the page's own <h1> when that <h1> names a size guide: that page IS
     the guide (a /pages/mens-jeans-size-guide whose table sits in a .size-chart-popup-content
     inside <main> lost its title and was stored men's bottoms at 0.65 where Phase 1 reads
     jeans). A product's <h1> names the product, so the same popup saved open on a product page
     is still the guide. Older Shopify themes wrap the whole page in a class the selector
     matches (Debut's #PageContainer.drawer-page-content, Brooklyn's is-moved-by-drawer): the
     first cut took that for a dialog, and a men's jeans guide page saved on Debut lost its
     title and was stored as men's bottoms at 0.65 where "page-container" alone gave jeans at
     0.85. */
  const readHtml = (html, pageUrl, source) => {
    const doc = new JSDOMCtor(html, { url: pageUrl }).window.document;
    const h1s = [...doc.querySelectorAll("h1")];
    const guide = [...doc.querySelectorAll('table,[role="table"]')].some((t) => {
      if (t.closest("[role=dialog],[aria-modal=true],dialog")) return true;
      const box = t.closest(GUIDE_BOUNDARY);
      return !!box && box.tagName !== "BODY" && box.tagName !== "HTML" &&
        !h1s.some((h) => !box.contains(h) && SIZE_GUIDE_LINK_RE.test(h.textContent || "")) &&
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
    /* A REFUSAL - 403/429, or a bot-protection CHALLENGE page, not the guide (adidas.co.il
       answers a plain HTTP client with a 200 one - see looksLikeBotChallenge). Parsed, the
       200 found nothing and the owner was told to add --gender/--age/--type, which cannot
       help. It is BLOCKED, with the manual way in, as the static and browser stages report
       it - asked once, never retried, never worked around. The second cut tested only a 200:
       Cloudflare's managed challenge and Akamai's "Access Denied" answer 403 (a rate limit
       429, Cloudflare at times 503 with its challenge) and read "could not fetch: HTTP 403"
       with no way in at all. */
    const refused = !r.ok && (r.status === 403 || r.status === 429);
    if (refused || (!r.envelope && looksLikeBotChallenge(r))) {
      throw new Error(`BLOCKED - ${url} ${refused ? `refused us (HTTP ${r.status})` : "answered with a bot-protection challenge page, not the guide"}. ` +
        "We do not work around bot protection: open the guide in your own browser, save it (Ctrl+S, \"Webpage, Complete\") or screenshot it, " +
        "then use --html <saved page> or --image <screenshot>");
    }
    if (!r.ok) throw new Error(`could not fetch ${url}: ${r.error || "HTTP " + r.status}`);
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
    const name = htmlFile.split(/[\\/]/).pop();
    const buf = await readFile(htmlFile);
    const mhtml = decodeMhtml(buf.toString("latin1"), name);   // a "Webpage, Single File" save, decoded (or refused)
    let text = mhtml ? mhtml.html : buf.toString("utf8");
    const env = unwrapHtmlEnvelope({ ok: true, text });
    if (env.envelope) text = env.text;
    found = readHtml(text, savedPageUrl(text, storeHost, mhtml ? mhtml.location : ""), "manual_html");
    for (const f of found) f.sourceUrl = "file:" + name;
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
/* The write: Supabase from scanner/.env, then saveAndVerify(). */
async function persistToSupabase(out) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (scanner/.env) - nothing saved.");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  await saveAndVerify({ supabase, records: out.records, host: out.host, saveSizeChartRecords });
}

/* `persist` is injectable so the --dry-run guard is tested where it stands (manual-import
   §4): with --yes nothing else stands between the summary and a write. */
export async function main(argv, { persist = persistToSupabase } = {}) {
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
    /* A hint only where no note already says what went wrong (a PDF, an unreadable image, a
       number --only does not have, an untyped table already named with its --type line).
       It used to say "add --gender/--age/--type" - but every table the parser accepts is a
       record or a "#n" note now, and an unlabelled chart is stored as gender "unknown", so
       the line only printed when NO table was accepted, where a label changes nothing. What
       helps there: a guide rendered client-side is not in the page as served or saved closed. */
    const told = out.notes.some((n) => n === PDF_NOTE || /^image: (?:error|not_a_chart)|^--only |^#\d+ \(/.test(n));
    console.log("\nNothing importable." + (told ? "" : (out.notes.includes(NO_TABLE_NOTE)
      ? " If the guide opens client-side (behind a button or a tab), open it in your own browser, save the page with the guide open " +
        "and use --html, or screenshot the table and use --image. If the table is there, "
      : " If ") + "it was refused for its values: the source is not a body-measurement chart the room can use."));
    return;
  }
  if (flag("--dry-run")) { console.log("\nDry run - nothing written."); return; }
  if (!(await askYesNo(`\nSave these ${out.records.length} chart(s) for ${out.host}?`, { assumeYes: flag("--yes") }))) {
    console.log("Not saved."); return;
  }
  await persist(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => { console.error("✗ import failed:", e?.message || e); process.exit(1); });
}
