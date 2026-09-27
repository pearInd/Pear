/* =============================================================================
   PEAR - store size-guide capture (Phase 0 dry run + Phase 1 capture)
   -----------------------------------------------------------------------------
   Finds a storefront's own size guide once per store, instead of per shopper, and
   (with --save) writes it to Supabase's `store_size_charts` table
   (archive/supabase_setup_v15.sql). The fitting room reads it back through
   GET /api/store-size-chart ONLY when the widget could not read a chart off the
   product page itself, and ONLY as the fine-tune tie-break - CLAUDE.md §2.5b is
   unchanged: a store chart never touches the height/weight kernel.

   THE PARSER IS THE WIDGET'S. scanner/size-chart-parser.js is generated from
   widget/pear-widget.js (npm run sync:size-chart-parser) and pinned byte-identical by
   test/size-chart-parser-sync.test.mjs, so a chart the scanner stores and a chart the
   widget reads live can never disagree about what a column means. What lives HERE is
   only what the widget never needs: finding pages, reading every table on a size-guide
   page (the widget keeps only the best one), and labelling each table with who and
   what it is for.

   CAPTURE PATHS, reported per store by the dry run:
     inline_table          a size table in the product page's server-rendered HTML
     product_description   a table inside a Shopify product's body_html
     linked_page           a same-site page the PDP links to as "size guide" (or a
                           well-known /pages/size-guide path) that carries a table
     image_chart_detected  the guide exists but as an IMAGE or PDF - Phase 3 (vision),
                           reported, never parsed here
     js_app_detected       a size-chart / fit app script, or a size-guide trigger with
                           no link - the content is rendered client-side, which only the
                           live widget can read
     blocked_by_bot_protection  the store answered with a bot challenge / 403 - the
                           answer is unknown, never reported as "none"
     none_found            nothing at all

   No browser: pages are parsed by jsdom with scripts DISABLED, i.e. the same passive
   view of the markup the widget has, minus anything client JS would add later.
   ============================================================================= */
import { createHash } from "node:crypto";
import { createSizeChartParser, SHARED_BLOCK_HASH } from "./size-chart-parser.js";

export const PARSER_VERSION = 1;
const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; PEAR-StoreScanner/1.0)";
const PRODUCT_LINK_PATTERNS = ["/products/", "/product/", "/item/", "/p/", "/shop/"];
const MAX_GUIDE_PAGES = 6;
const MAX_TABLES_PER_PAGE = 30;
const RAW_SNAPSHOT_MAX = 20000;
const WELL_KNOWN_GUIDE_PATHS = [
  "/pages/size-guide", "/pages/size-chart", "/pages/sizing", "/pages/size-guide-1",
  "/size-guide", "/size-chart",
];

export const SIZE_GUIDE_LINK_RE =
  /size[\s_-]*(?:guide|chart|table)|sizing|sizeguide|sizechart|fit[\s_-]*guide|מדריך\s*מידות|טבלת\s*מידות|מדריך\s*התאמה|טבלת\s*המידות/i;
const IMAGE_CHART_RE = /size[\s_-]*(?:guide|chart|table)|sizing|sizechart|sizeguide|measurement|מידות/i;
const JS_APP_RE =
  /kiwisizing|kiwi-sizing|size-chart-app|sizechart\.|esc-size|ks-chart|fitanalytics|truefit|virtusize|easysize|sizeandfit|fit-finder|sizeguide\.js/i;

/* A chart REFERENCED from the page's own embedded app state and fetched by client JS -
   terminalx.com ships `"size_chart":"sizechart_terminal_x_kids_5"` in its PDP state.
   The table is not in the HTML, but the store demonstrably has one: that is a
   js_app_detected finding, not none_found. */
const INLINE_STATE_CHART_RE = /["'](?:size_?chart|sizechart|size_?guide)(?:_id|_block|Id)?["']\s*:\s*["'][^"']{2,80}["']|\bsizechart_[a-z0-9_]{3,}/i;

/* A bot-protection interstitial (Akamai / Cloudflare / PerimeterX / Incapsula...)
   answers 200 with a small HTML page that is nothing but a challenge script. Parsing it
   finds no chart, and reporting that as "none_found" would be a false claim about the
   store - adidas.co.il serves exactly this to a plain HTTP client. */
export function looksLikeBotChallenge(r) {
  if (!r || !r.text) return false;
  const t = r.text;
  if (/_Incapsula_Resource|cf-chl|cf_chl_|challenge-platform|Just a moment\.\.\.|px-captcha|captcha-delivery/i.test(t.slice(0, 20000))) return true;
  if (!/html/i.test(r.contentType || "") && !/^\s*<(?:!doctype|html)/i.test(t)) return false;
  if (t.length > 8000) return false;
  const visible = t.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /* A real page - even a thin, client-rendered one - carries a <title> or an <h1>; the
     interstitial carries neither. Without this, a sparse PDP read as a challenge. */
  if (/<title[^>]*>\s*[^<\s][^<]*<\/title>/i.test(t) || /<h1[\s>]/i.test(t)) return false;
  return /<script[^>]+src=/i.test(t) && visible.length < 80;
}

/* CROSS-FILE LOCKSTEP (CLAUDE.md §3): widget/pear-widget.js, fitting-room/app.js and
   lib/store-size-charts.js carry the same function. It is the store_size_charts key -
   a drifted copy files a store's charts under a host the room never asks for. */
export function canonicalStoreHost(raw) {
  let h = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
  h = h.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  h = h.replace(/^(?:www\d*|m)\./, "");
  return /^[a-z0-9.-]+$/.test(h) && h.indexOf(".") > 0 ? h : "";
}

/* ── WHO AND WHAT A TABLE IS FOR ─────────────────────────────────────────────────
   Whole-token matching over the table's own surroundings (caption, nearest headings,
   tab label, container id/class) first, then the page's (title, h1, URL, breadcrumb,
   product audience). Hebrew takes one optional prefix letter. Apostrophes are REMOVED
   before tokenising so ג'ינס / ג׳ינס / גינס are one word. */
const WORDS = {
  men: ["men", "mens", "man", "male", "gents", "guys", "boy", "boys", "גברים", "גבר", "גברי", "בנים"],
  women: ["women", "womens", "woman", "female", "ladies", "lady", "girl", "girls", "נשים", "אישה", "נשי", "בנות"],
  unisex: ["unisex", "יוניסקס"],
  kids: ["kids", "kid", "children", "child", "junior", "juniors", "baby", "babies", "toddler",
    "toddlers", "infant", "infants", "youth", "teen", "teens", "boy", "boys", "girl", "girls",
    "ילדים", "ילדות", "ילד", "תינוקות", "תינוק", "נוער", "פעוטות", "בנים", "בנות"],
  jeans: ["jeans", "jean", "denim", "גינס"],
  bottoms: ["pants", "pant", "trousers", "trouser", "shorts", "short", "skirt", "skirts",
    "leggings", "joggers", "bottoms", "bottom", "chinos", "מכנסיים", "מכנס", "מכנסי", "חצאית",
    "חצאיות", "טייץ", "ברמודה", "תחתון", "תחתונות"],
  tops: ["tops", "top", "shirt", "shirts", "tee", "tees", "tshirt", "tshirts", "blouse", "blouses",
    "jacket", "jackets", "coat", "coats", "hoodie", "hoodies", "sweater", "sweaters",
    "sweatshirt", "sweatshirts", "knitwear", "polo", "polos", "outerwear", "חולצה", "חולצות",
    "עליון", "עליונים", "זקט", "זקטים", "מעיל", "מעילים", "סוודר", "סוודרים", "קפוצון", "קפוצונים", "טישרט"],
  dresses: ["dress", "dresses", "שמלה", "שמלות"],
};

export function contextTokens(text) {
  return String(text == null ? "" : text).toLowerCase()
    .replace(/['’‘`׳"״]/g, "")
    .split(/[^a-z֐-׿]+/)
    .filter(Boolean);
}
function hasWord(tokens, list) {
  for (const t of tokens) {
    if (list.includes(t)) return true;
    if (/^[להובמש][֐-׿]{2,}$/.test(t) && list.includes(t.slice(1))) return true;
  }
  return false;
}

/** @returns {{gender:string|null, kids:boolean, garmentType:string|null}} from free text */
export function classifyContextText(text) {
  const tokens = contextTokens(text);
  const men = hasWord(tokens, WORDS.men), women = hasWord(tokens, WORDS.women);
  let gender = null;
  if (men && !women) gender = "men";
  else if (women && !men) gender = "women";
  else if (!men && !women && hasWord(tokens, WORDS.unisex)) gender = "unisex";
  const types = ["jeans", "bottoms", "tops", "dresses"].filter((k) => hasWord(tokens, WORDS[k]));
  /* Jeans is a kind of bottoms: "Jeans & Trousers" is a jeans chart, not a conflict. */
  let garmentType = null;
  if (types.length === 1) garmentType = types[0];
  else if (types.length === 2 && types.includes("jeans") && types.includes("bottoms")) garmentType = "jeans";
  return { gender, kids: hasWord(tokens, WORDS.kids), garmentType };
}

const KIDS_NUMERIC = new Set(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "16", "18"]);
const ALPHA_RE = /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|[23]XS)$/i;

/* Local context decides; page context only fills what local left open. The column
   shape is the last resort for the TYPE only (a chest column means the chart is for
   tops; waist/hips and no chest means bottoms) - never for gender, which has no
   column-shaped evidence at all. */
export function classifyChart(rows, localText, pageText) {
  const local = classifyContextText(localText);
  const page = classifyContextText(pageText);
  let gender = local.gender || page.gender || "unknown";
  let garmentType = local.garmentType || page.garmentType || null;
  let typeFrom = garmentType ? (local.garmentType ? "context" : "page") : null;
  if (!garmentType) {
    const has = (k) => rows.some((r) => typeof r["min" + k] === "number");
    if (has("Chest")) garmentType = "tops";
    else if (has("Waist") || has("Hips")) garmentType = "bottoms";
    if (garmentType) typeFrom = "columns";
  }
  const sizes = rows.map((r) => String(r.size));
  const allKidsNumeric = sizes.length > 0 && sizes.every((s) => KIDS_NUMERIC.has(s));
  const kidsWords = local.kids || (!local.gender && page.kids);
  const ageGroup = kidsWords || allKidsNumeric ? "kids" : "adult";
  /* boys/girls words land in both kids and men/women - that is intended: a "Boys"
     chart is a kids chart cut for boys. */
  const allAlpha = sizes.every((s) => ALPHA_RE.test(s));
  const allNumeric = sizes.every((s) => /^\d{1,2}$/.test(s));
  const sizeSystem = allAlpha ? "alpha" : allNumeric ? "numeric" : "mixed";
  let confidence = 0.9;
  if (gender === "unknown") confidence -= 0.25;
  if (typeFrom === "columns") confidence -= 0.15;
  if (typeFrom === "page") confidence -= 0.05;
  return { gender, ageGroup, garmentType, sizeSystem, typeFrom, confidence: Math.round(confidence * 100) / 100 };
}

/* ── THE TABLE'S OWN SURROUNDINGS ─────────────────────────────────────────────── */
const HEADING_SEL = "h1,h2,h3,h4,h5,h6,strong,b,[role=tab],button,legend,summary,p";
function shortText(el) {
  const t = String(el && el.textContent || "").replace(/\s+/g, " ").trim();
  return t.length <= 120 ? t : "";
}
export function tableContextText(table) {
  const parts = [];
  try {
    const cap = table.querySelector("caption");
    if (cap) parts.push(shortText(cap));
    let node = table, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      const id = node.getAttribute && (node.getAttribute("id") || "");
      const cls = node.getAttribute && (node.getAttribute("class") || "");
      const label = node.getAttribute && (node.getAttribute("aria-label") || node.getAttribute("data-title") || "");
      parts.push(id.replace(/[-_]/g, " "), cls.replace(/[-_]/g, " "), label);
      const labelledBy = node.getAttribute && node.getAttribute("aria-labelledby");
      if (labelledBy && node.ownerDocument) {
        for (const ref of labelledBy.split(/\s+/)) {
          const el = node.ownerDocument.getElementById(ref);
          if (el) parts.push(shortText(el));
        }
      }
      /* The nearest preceding heading-like siblings - "Women" above the women's table. */
      let sib = node.previousElementSibling, seen = 0;
      while (sib && seen < 4) {
        /* The previous chart's territory: a sibling that IS or CONTAINS a table carries
           another chart's heading ("Men's tops" above the men's section must never label
           the women's table below it - the first cut of this walk did exactly that). */
        if (sib.tagName === "TABLE" || (sib.querySelector && sib.querySelector("table"))) break;
        if (sib.matches && sib.matches(HEADING_SEL)) parts.push(shortText(sib));
        else if (sib.querySelector) {
          const h = sib.querySelector("h1,h2,h3,h4,h5,h6");
          if (h) parts.push(shortText(h));
        }
        sib = sib.previousElementSibling; seen++;
      }
      node = node.parentElement; depth++;
    }
  } catch { /* context is best-effort; a missing label is "unknown", never a throw */ }
  return parts.filter(Boolean).join(" | ");
}

function pageContextText(doc, url) {
  const bits = [];
  try {
    bits.push(doc.title || "");
    const h1 = doc.querySelector("h1");
    if (h1) bits.push(shortText(h1));
    try { bits.push(decodeURIComponent(new URL(url).pathname)); } catch { bits.push(String(url || "")); }
    const crumb = doc.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]');
    if (crumb) bits.push(String(crumb.textContent || "").slice(0, 300));
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      const txt = s.textContent || "";
      const m = txt.match(/"suggestedGender"\s*:\s*"([^"]+)"/i);
      if (m) bits.push(m[1]);
    }
  } catch { /* best-effort */ }
  return bits.join(" | ");
}

/* Every size table on a document, each with its own labels. The widget keeps only
   the best-scoring table on a PDP; a size-guide PAGE is usually several charts
   (men / women / kids tabs) and every one of them is a row here. */
export function extractAllSizeCharts(doc, url) {
  const parser = createSizeChartParser(doc);
  const pageText = pageContextText(doc, url);
  const out = [];
  const tables = Array.from(doc.querySelectorAll("table")).slice(0, MAX_TABLES_PER_PAGE);
  for (const table of tables) {
    let rows = null;
    try {
      rows = parser.sizeChartFromGrid(parser.sizeChartOrient(parser.sizeChartGrid(table)),
        parser.sizeChartTableUnit(table));
    } catch { rows = null; }
    if (!rows) continue;
    const measured = rows.filter((r) =>
      ["Chest", "Waist", "Hips", "Legs"].some((k) => typeof r["min" + k] === "number"));
    if (measured.length < 2) continue;
    const localText = tableContextText(table);
    out.push({
      rows: measured,
      localText,
      classification: classifyChart(measured, localText, pageText),
      rawSnapshot: String(table.outerHTML || "").slice(0, RAW_SNAPSHOT_MAX),
    });
  }
  return out;
}

/* Parser rows -> the stored JSON shape (archive/supabase_setup_v15.sql):
     { size, aliases?, body: { chest:[min,max], waist, hips, outseam } }
   `legs` is the parser's OUTSEAM (see SIZE_CHART_MEASURE_KEYS in the widget) and is
   stored under that name so a future inseam column can never be confused with it. */
export function toStoredRows(rows) {
  const map = { Chest: "chest", Waist: "waist", Hips: "hips", Legs: "outseam" };
  return rows.map((r) => {
    const body = {};
    for (const [cap, key] of Object.entries(map)) {
      const lo = r["min" + cap], hi = r["max" + cap];
      if (typeof lo === "number" && typeof hi === "number") body[key] = [lo, hi];
    }
    const row = { size: String(r.size) };
    if (r.aliases && Object.keys(r.aliases).length) row.aliases = { ...r.aliases };
    row.body = body;
    return row;
  });
}

export function contentHash(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 32);
}

/* ── FETCHING ────────────────────────────────────────────────────────────────── */
export async function defaultFetchText(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": FETCH_USER_AGENT, Accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const contentType = resp.headers.get("content-type") || "";
  const isText = /text|json|xml|html/i.test(contentType) || !contentType;
  return { ok: resp.ok, status: resp.status, url: resp.url || url, contentType, text: isText ? await resp.text() : "" };
}

async function loadJsdom() {
  try {
    return (await import("jsdom")).JSDOM;
  } catch (e) {
    throw new Error("jsdom is required for --size-charts (npm install in the repo root, or `cd scanner && npm install`): " + e.message);
  }
}

function sameStore(a, b) {
  const ha = canonicalStoreHost(a), hb = canonicalStoreHost(b);
  return !!ha && !!hb && (ha === hb || ha.endsWith("." + hb) || hb.endsWith("." + ha));
}

function evenlySample(list, n) {
  if (list.length <= n) return list.slice();
  const out = [], step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/* Product pages to look at, spread across the catalog (evenly spaced, so a store whose
   first 200 products are all women's tees still gets a men's page in the sample). */
async function sampleProducts({ baseUrl, homeHtml, isShopify, fetchText, maxProducts, log }) {
  if (isShopify) {
    try {
      const r = await fetchText(`${baseUrl}/products.json?limit=250`);
      if (r.ok) {
        const data = JSON.parse(r.text);
        const products = (data.products || []).filter((p) => p && p.handle);
        return evenlySample(products, maxProducts).map((p) => ({
          url: `${baseUrl}/products/${p.handle}`,
          title: p.title || "",
          bodyHtml: p.body_html || "",
          context: [p.title, p.product_type, Array.isArray(p.tags) ? p.tags.join(" ") : p.tags].join(" | "),
        }));
      }
      log(`  products.json unavailable (HTTP ${r.status}) - falling back to the sitemap`);
    } catch (e) {
      log(`  products.json unreadable (${e.message}) - falling back to the sitemap`);
    }
  }
  const urls = [];
  try {
    let sitemaps = [];
    const robots = await fetchText(`${baseUrl}/robots.txt`).catch(() => null);
    if (robots && robots.ok) {
      sitemaps = (robots.text.match(/^\s*sitemap:\s*(\S+)/gim) || []).map((l) => l.replace(/^\s*sitemap:\s*/i, "").trim());
    }
    if (!sitemaps.length) sitemaps = [`${baseUrl}/sitemap.xml`];
    const locsOf = (xml) => (xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/gi) || []).map((l) => l.replace(/<\/?loc>/gi, "").trim());
    for (const sm of sitemaps.slice(0, 3)) {
      const r = await fetchText(sm).catch(() => null);
      if (!r || !r.ok) continue;
      if (/<sitemapindex/i.test(r.text)) {
        const children = locsOf(r.text);
        const productish = children.filter((u) => /product/i.test(u));
        for (const child of (productish.length ? productish : children).slice(0, 2)) {
          const c = await fetchText(child).catch(() => null);
          if (c && c.ok) urls.push(...locsOf(c.text));
        }
      } else {
        urls.push(...locsOf(r.text));
      }
      if (urls.length) break;
    }
  } catch (e) {
    log(`  sitemap unreadable (${e.message})`);
  }
  let candidates = urls.filter((u) => PRODUCT_LINK_PATTERNS.some((p) => u.toLowerCase().includes(p)));
  if (!candidates.length) candidates = urls.filter((u) => /\/[^/]*\d{4,}[^/]*(?:\.html)?$/i.test(u));
  if (!candidates.length && homeHtml) {
    const hrefs = (homeHtml.match(/href\s*=\s*["']([^"']+)["']/gi) || [])
      .map((h) => h.replace(/^href\s*=\s*["']/i, "").replace(/["']$/, ""));
    const seen = new Set();
    for (const h of hrefs) {
      if (!PRODUCT_LINK_PATTERNS.some((p) => h.toLowerCase().includes(p))) continue;
      try { const abs = new URL(h, baseUrl).href; if (!seen.has(abs)) { seen.add(abs); candidates.push(abs); } } catch { /* skip */ }
    }
  }
  candidates = candidates.filter((u) => sameStore(u, baseUrl));
  return evenlySample(Array.from(new Set(candidates)), maxProducts).map((url) => ({ url, title: "", bodyHtml: "", context: "" }));
}

/* Anything on a page that points at a size guide, and what kind of guide it is. */
function scanPageSignals(doc, pageUrl, baseUrl, parser) {
  const links = new Set(), images = [], apps = new Set();
  let triggers = 0;
  for (const el of doc.querySelectorAll("a,button,[data-href],[data-url],[role=button]")) {
    const label = [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"),
      el.getAttribute("href"), el.getAttribute("data-href"), el.getAttribute("data-url"),
      el.getAttribute("class"), el.getAttribute("id")].filter(Boolean).join(" ").slice(0, 400);
    if (!SIZE_GUIDE_LINK_RE.test(label)) continue;
    const href = el.getAttribute("href") || el.getAttribute("data-href") || el.getAttribute("data-url") || "";
    let abs = "";
    if (href && !/^(?:#|javascript:|mailto:|tel:)/i.test(href)) {
      try { abs = new URL(href, pageUrl).href.split("#")[0]; } catch { abs = ""; }
    }
    if (abs && sameStore(abs, baseUrl) && abs !== pageUrl.split("#")[0]) links.add(abs);
    else triggers++;
  }
  const containerSel = parser.SIZE_CHART_CONTAINERS.flatMap((c) => c[1]);
  const inContainer = (el) => containerSel.some((sel) => { try { return !!el.closest(sel); } catch { return false; } });
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    const label = [src, img.getAttribute("alt"), img.getAttribute("class"), img.getAttribute("id"), img.getAttribute("title")]
      .filter(Boolean).join(" ");
    if (IMAGE_CHART_RE.test(label) || inContainer(img)) {
      try { images.push(new URL(src, pageUrl).href); } catch { if (src) images.push(src); }
    }
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (/\.pdf(?:$|[?#])/i.test(href) && IMAGE_CHART_RE.test(href + " " + a.textContent)) {
      try { images.push(new URL(href, pageUrl).href); } catch { images.push(href); }
    }
  }
  for (const s of doc.querySelectorAll("script[src],link[href]")) {
    const src = s.getAttribute("src") || s.getAttribute("href") || "";
    const m = src.match(JS_APP_RE);
    if (m) apps.add(m[0].toLowerCase());
  }
  for (const s of doc.querySelectorAll("script:not([src])")) {
    const m = String(s.textContent || "").match(INLINE_STATE_CHART_RE);
    if (m) { apps.add("page-state:" + m[0].replace(/["'\s]/g, "").slice(0, 60)); break; }
  }
  return { links: [...links], images: [...new Set(images)], apps: [...apps], triggers };
}

/**
 * Discover a store's size guides. Pure over `fetchText` (injectable for tests).
 * @returns {Promise<{report:object, records:Array<object>}>}
 */
export async function discoverSizeCharts(storeUrl, {
  fetchText = defaultFetchText, maxProducts = 12, delayMs = 300, log = console.log, JSDOM = null,
} = {}) {
  const JSDOMCtor = JSDOM || await loadJsdom();
  const base = new URL(storeUrl);
  const baseUrl = `${base.protocol}//${base.host}`;
  const storeDomain = canonicalStoreHost(base.hostname);
  const pause = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  const report = {
    store: storeUrl, store_domain: storeDomain, platform: "unknown", parser_hash: SHARED_BLOCK_HASH,
    sampled_products: 0, pages_fetched: 0, pages_failed: 0,
    paths: {
      inline_table: { pages_checked: 0, pages_with_chart: 0 },
      product_description: { products_checked: 0, products_with_chart: 0 },
      linked_page: { links_found: 0, pages_fetched: 0, pages_with_chart: 0, urls: [] },
      image_chart_detected: { count: 0, examples: [] },
      js_app_detected: { apps: [], triggers_without_link: 0 },
    },
    blocked: { count: 0, examples: [] },
    outcome: "none_found", charts: [], conflicts: [], errors: [],
  };
  /* Every fetch goes through this, so a bot challenge is counted wherever it appears
     (home, robots/sitemap, PDPs, guide pages) and never parsed as a real page. */
  const rawFetch = fetchText;
  fetchText = async (url) => {
    const r = await rawFetch(url);
    if (r && r.ok && looksLikeBotChallenge(r)) {
      report.blocked.count++;
      if (report.blocked.examples.length < 3) report.blocked.examples.push(url);
      return { ...r, ok: false, status: r.status, error: "bot-protection challenge (HTTP " + r.status + ")" };
    }
    return r;
  };
  const found = [];     // { chart, source, sourceUrl, productUrl }

  const home = await fetchText(storeUrl).catch((e) => ({ ok: false, status: 0, text: "", error: e.message }));
  if (!home.ok) {
    report.errors.push(`home page: ${home.error || "HTTP " + home.status}`);
    /* 403/429 on a PUBLIC storefront's home page is bot management refusing a plain HTTP
       client (adidas.co.il escalates from a challenge page to a flat 403 after a few
       requests) - the store is up, we are refused. Anything else is unreachable. */
    report.outcome = report.blocked.count || home.status === 403 || home.status === 429
      ? "blocked_by_bot_protection" : "unreachable";
    return { report, records: [] };
  }
  const isShopify = /shopify/i.test(home.text);
  report.platform = isShopify ? "shopify" : "html";

  const products = await sampleProducts({ baseUrl, homeHtml: home.text, isShopify, fetchText, maxProducts, log });
  report.sampled_products = products.length;
  const guideLinks = new Set(), images = new Set(), apps = new Set();
  let triggers = 0;

  for (const p of products) {
    if (p.bodyHtml) {
      report.paths.product_description.products_checked++;
      const frag = new JSDOMCtor(`<!doctype html><body>${p.bodyHtml}</body>`, { url: p.url }).window.document;
      const charts = extractAllSizeCharts(frag, p.url);
      if (charts.length) report.paths.product_description.products_with_chart++;
      for (const c of charts) {
        c.classification = classifyChart(c.rows, c.localText, p.context + " | " + p.title);
        found.push({ chart: c, source: "product_description", sourceUrl: p.url, productUrl: p.url });
      }
    }
    await pause();
    const r = await fetchText(p.url).catch((e) => ({ ok: false, status: 0, text: "", error: e.message }));
    if (!r.ok || !r.text) {
      report.pages_failed++;
      if (report.errors.length < 10) report.errors.push(`${p.url}: ${r.error || "HTTP " + r.status}`);
      continue;
    }
    report.pages_fetched++;
    report.paths.inline_table.pages_checked++;
    const doc = new JSDOMCtor(r.text, { url: r.url || p.url }).window.document;
    const charts = extractAllSizeCharts(doc, p.url);
    if (charts.length) report.paths.inline_table.pages_with_chart++;
    for (const c of charts) found.push({ chart: c, source: "inline_table", sourceUrl: p.url, productUrl: p.url });
    const sig = scanPageSignals(doc, r.url || p.url, baseUrl, createSizeChartParser(doc));
    sig.links.forEach((l) => guideLinks.add(l));
    sig.images.forEach((i) => images.add(i));
    sig.apps.forEach((a) => apps.add(a));
    triggers += sig.triggers;
  }

  /* Linked guide pages first, then the well-known paths nobody linked. */
  const guideUrls = [...guideLinks];
  report.paths.linked_page.links_found = guideUrls.length;
  if (isShopify || !guideUrls.length) {
    for (const path of WELL_KNOWN_GUIDE_PATHS) {
      const u = baseUrl + path;
      if (!guideUrls.includes(u)) guideUrls.push(u);
    }
  }
  for (const gUrl of guideUrls.slice(0, MAX_GUIDE_PAGES + (guideLinks.size ? 0 : WELL_KNOWN_GUIDE_PATHS.length))) {
    if (/\.pdf(?:$|[?#])/i.test(gUrl)) { images.add(gUrl); continue; }
    await pause();
    const r = await fetchText(gUrl).catch((e) => ({ ok: false, status: 0, text: "", error: e.message }));
    if (!r.ok) continue;
    if (/pdf|image\//i.test(r.contentType || "")) { images.add(gUrl); continue; }
    if (!r.text) continue;
    report.paths.linked_page.pages_fetched++;
    const doc = new JSDOMCtor(r.text, { url: r.url || gUrl }).window.document;
    const charts = extractAllSizeCharts(doc, gUrl);
    if (charts.length) {
      report.paths.linked_page.pages_with_chart++;
      report.paths.linked_page.urls.push(gUrl);
    }
    for (const c of charts) found.push({ chart: c, source: "linked_page", sourceUrl: gUrl, productUrl: "" });
    const sig = scanPageSignals(doc, r.url || gUrl, baseUrl, createSizeChartParser(doc));
    sig.images.forEach((i) => images.add(i));
    sig.apps.forEach((a) => apps.add(a));
  }

  report.paths.image_chart_detected.count = images.size;
  report.paths.image_chart_detected.examples = [...images].slice(0, 5);
  report.paths.js_app_detected.apps = [...apps];
  report.paths.js_app_detected.triggers_without_link = triggers;

  const records = buildRecords(found, storeDomain, report);
  /* Strongest finding first. "blocked" outranks "none_found" whenever the challenge
     plausibly hid the answer: nothing sampled at all, or at least half the product
     pages we tried came back as a challenge. */
  const tried = report.pages_fetched + report.pages_failed;
  const blockedHidAnswer = report.blocked.count > 0 &&
    (report.sampled_products === 0 || report.pages_fetched === 0 || report.pages_failed * 2 >= tried);
  if (records.length) report.outcome = "captured";
  else if (images.size) report.outcome = "image_chart_detected";
  else if (apps.size || triggers) report.outcome = "js_app_detected";
  else if (blockedHidAnswer) report.outcome = "blocked_by_bot_protection";
  else report.outcome = "none_found";
  return { report, records };
}

/* Found charts -> store_size_charts rows, one per (gender, age, type, product_key,
   source). An inline PDP chart seen on 2+ product pages is the store's general chart
   (product_key ""); seen once, it is kept product-scoped (product_key = that URL) -
   the room's Phase 1 lookup reads store-wide rows only. Two DIFFERENT charts claiming
   the same key keep the more-sighted one and are reported as a conflict, never merged. */
export function buildRecords(found, storeDomain, report = { charts: [], conflicts: [] }) {
  const byHash = new Map();
  for (const f of found) {
    const rows = toStoredRows(f.chart.rows);
    const hash = contentHash(rows);
    const cls = f.chart.classification;
    if (!cls.garmentType) {
      report.conflicts.push({ reason: "no garment type from context or columns - not stored", source_url: f.sourceUrl });
      continue;
    }
    const key = `${hash}|${f.source}|${cls.gender}|${cls.ageGroup}|${cls.garmentType}`;
    const prev = byHash.get(key);
    if (prev) { prev.sightings++; if (f.productUrl && !prev.pages.includes(f.productUrl)) prev.pages.push(f.productUrl); continue; }
    byHash.set(key, { f, rows, hash, cls, sightings: 1, pages: f.productUrl ? [f.productUrl] : [] });
  }
  const byKey = new Map();
  for (const e of byHash.values()) {
    const productKey = e.f.source === "linked_page" || e.pages.length >= 2 ? "" : (e.pages[0] || "");
    const record = {
      store_domain: storeDomain,
      gender: e.cls.gender,
      age_group: e.cls.ageGroup,
      garment_type: e.cls.garmentType,
      size_system: e.cls.sizeSystem,
      product_key: productKey,
      rows: e.rows,
      source: e.f.source,
      source_url: e.f.sourceUrl,
      confidence: e.cls.confidence,
      status: "active",
      sightings: e.sightings,
      content_hash: e.hash,
      parser_version: PARSER_VERSION,
      raw_snapshot: e.f.chart.rawSnapshot || null,
    };
    const k = [record.gender, record.age_group, record.garment_type, record.product_key, record.source].join("|");
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, record); continue; }
    const better = record.sightings > prev.sightings ||
      (record.sightings === prev.sightings && record.rows.length > prev.rows.length);
    report.conflicts.push({
      reason: "two different charts for one key - kept the more-sighted", key: k,
      kept: (better ? record : prev).source_url, dropped: (better ? prev : record).source_url,
    });
    if (better) byKey.set(k, record);
  }
  const records = [...byKey.values()];
  report.charts = records.map((r) => ({
    gender: r.gender, age_group: r.age_group, garment_type: r.garment_type, size_system: r.size_system,
    scope: r.product_key ? "product" : "store", source: r.source, source_url: r.source_url,
    sizes: r.rows.map((x) => x.size).join("/"),
    columns: [...new Set(r.rows.flatMap((x) => Object.keys(x.body)))].join(","),
    aliases: r.rows.some((x) => x.aliases), sightings: r.sightings, confidence: r.confidence,
  }));
  return records;
}

/* supabase-js surfaces a missing table two ways depending on the path it took:
   Postgres 42P01 (undefined_table) or PostgREST PGRST205 ("Could not find the table
   ... in the schema cache"). Either one means "archive/supabase_setup_v15.sql has not
   been run" - a documented, degradable state, not a crash. */
export function isMissingTableError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || err);
  return code === "42P01" || code === "PGRST205" ||
    /store_size_charts/.test(msg) && /does not exist|schema cache|not find/i.test(msg);
}

export async function saveSizeChartRecords(supabase, records, log = console.log) {
  if (!supabase) return { saved: 0, skipped: "no_supabase" };
  if (!records.length) return { saved: 0 };
  const now = new Date().toISOString();
  const payload = records.map((r) => ({ ...r, updated_at: now, captured_at: now }));
  const { error } = await supabase.from("store_size_charts")
    .upsert(payload, { onConflict: "store_domain,gender,age_group,garment_type,product_key,source" });
  if (error) {
    if (isMissingTableError(error)) {
      log("  ⚠ store_size_charts does not exist - run archive/supabase_setup_v15.sql, then re-run with --save");
      return { saved: 0, skipped: "table_missing" };
    }
    throw new Error("store_size_charts upsert failed: " + (error.message || error));
  }
  return { saved: records.length };
}

/* Human-readable summary + one machine-readable line to paste back. */
export function formatReport(report) {
  const p = report.paths;
  const lines = [
    "",
    `═══ size-guide coverage: ${report.store_domain || report.store} (${report.platform}) ═══`,
    `outcome: ${report.outcome}`,
    `sampled products: ${report.sampled_products} | pages fetched: ${report.pages_fetched} | failed: ${report.pages_failed}`,
    `inline_table:        ${p.inline_table.pages_with_chart}/${p.inline_table.pages_checked} product pages carry a readable chart`,
    `product_description: ${p.product_description.products_with_chart}/${p.product_description.products_checked} Shopify descriptions carry one`,
    `linked_page:         ${p.linked_page.links_found} guide link(s) found, ${p.linked_page.pages_fetched} guide page(s) fetched, ${p.linked_page.pages_with_chart} with a chart`,
    `image_chart_detected: ${p.image_chart_detected.count}${p.image_chart_detected.examples.length ? " e.g. " + p.image_chart_detected.examples[0] : ""}`,
    `js_app_detected:     ${p.js_app_detected.apps.join(", ") || "(no known app)"}; ${p.js_app_detected.triggers_without_link} size-guide trigger(s) with no link`,
    `bot protection:      ${report.blocked.count ? report.blocked.count + " challenged request(s), e.g. " + report.blocked.examples[0] : "none seen"}`,
  ];
  if (report.charts.length) {
    lines.push("charts:");
    for (const c of report.charts) {
      lines.push(`  · ${c.gender}/${c.age_group}/${c.garment_type} [${c.scope}, ${c.source}] ${c.sizes} (${c.columns})${c.aliases ? " +aliases" : ""} conf ${c.confidence} - ${c.source_url}`);
    }
  }
  for (const c of report.conflicts) lines.push(`  ! ${c.reason}${c.key ? " [" + c.key + "]" : ""}${c.source_url ? " - " + c.source_url : ""}`);
  for (const e of report.errors) lines.push(`  ✗ ${e}`);
  lines.push("COVERAGE_JSON " + JSON.stringify({
    store: report.store_domain, platform: report.platform, outcome: report.outcome,
    sampled: report.sampled_products, fetched: report.pages_fetched, failed: report.pages_failed,
    inline: `${p.inline_table.pages_with_chart}/${p.inline_table.pages_checked}`,
    description: `${p.product_description.products_with_chart}/${p.product_description.products_checked}`,
    linked: { links: p.linked_page.links_found, fetched: p.linked_page.pages_fetched, with_chart: p.linked_page.pages_with_chart },
    images: p.image_chart_detected.count, apps: p.js_app_detected.apps, triggers: p.js_app_detected.triggers_without_link,
    blocked: report.blocked.count,
    charts: report.charts.map((c) => `${c.gender}/${c.age_group}/${c.garment_type}:${c.sizes}`),
    errors: report.errors.length,
  }));
  return lines.join("\n");
}
