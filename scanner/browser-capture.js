/* =============================================================================
   PEAR - size-guide capture, Phase 2: the REAL-BROWSER fallback (local scanner only)
   -----------------------------------------------------------------------------
   Static capture (size-charts.js) reads server HTML with scripts disabled. Many stores
   render their guide only in the browser: a modal built by client JS after a click
   (adidas's 50+ "size-guide triggers with no link"), a CMS block fetched over GraphQL
   (terminalx.com), a tab strip that swaps men's/women's tables. This opens the sampled
   product pages in headless Chromium and reads what a shopper would see:

     browser_page     tables / ARIA grids in the RENDERED product page
     browser_modal    the same, after clicking a size-guide trigger, and after each tab
                      inside the guide it opened (men / women / kids, tops / bottoms)
     browser_network  size tables inside JSON or HTML responses the page fetched
     (images)         large images inside an opened guide - handed to image-charts.js

   ONE PARSER, ONE VALIDATION. Every snapshot and every payload is turned into a DOM and
   read by extractAllSizeCharts() - the shared widget parser (clamps, monotonic ladders,
   unit rules) plus classifyChart() - and only those rows reach buildRecords() and the
   same save path as Phase 1. This file decides WHAT to look at, never what a chart says.

   POLITE AND HONEST, by rule (owner, 2026-10-03): a stock headless Chromium with its
   own user agent, one page at a time, a pause between navigations, a hard page cap.
   No stealth plugin, no fingerprint or UA spoofing, no CAPTCHA solving, no proxies. A
   403/429 or a challenge page is reported as BLOCKED and the run stops for that store;
   the manual import (import-chart.js) is the way in.
   ============================================================================= */
import { createHash } from "node:crypto";
import { extractAllSizeCharts, SIZE_GUIDE_LINK_RE, isProductPathUrl, canonicalStoreHost,
  normalizePageUrl, looksLikeBotChallenge, classifyChart, pageContextText, referrerAudience } from "./size-charts.js";

/* A size-guide trigger, by its visible label / aria-label / title. SIZE_GUIDE_LINK_RE is
   the static scanner's own list (size guide / chart / table, sizing, fit guide, מדריך
   מידות, טבלת מידות ...); the additions are labels that only ever appear on a BUTTON. */
const EXTRA_TRIGGER_RE = /size\s*(?:&|and)\s*fit|find\s+your\s+size|מדריך\s*גדלים|טבלת\s*גדלים|איזו\s*מידה|מידות\s*ומדריך/i;
/* Never clicked, whatever else the label says: buying, account, navigation away. */
const NEVER_CLICK_RE = /add\s*to\s*(?:cart|bag)|הוספה\s*ל?סל|הוסף\s*לסל|לקנייה|checkout|קופה|login|sign\s*in|התחבר|wishlist|share|שתף/i;

export function isSizeGuideTriggerLabel(text) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!t || t.length > 120) return false;
  if (NEVER_CLICK_RE.test(t)) return false;
  return SIZE_GUIDE_LINK_RE.test(t) || EXTRA_TRIGGER_RE.test(t);
}

/* A response worth parsing: it names a size chart AND carries a measurement word AND at
   least two size tokens or a table. Cheap pre-filter; the parser is the real judge. */
const PAYLOAD_SIZE_WORD_RE = /size[\s_-]*(?:chart|guide|table)|sizechart|sizeguide|מדריך\s*מידות|טבלת\s*מידות|"size"\s*:|measurements?/i;
const PAYLOAD_MEASURE_RE = /chest|bust|waist|hips?|חזה|מותן|מותניים|אגן|ירכיים/i;
export function looksLikeSizePayload(text) {
  const t = String(text || "");
  if (t.length < 40 || t.length > 2_000_000) return false;
  return PAYLOAD_SIZE_WORD_RE.test(t) && PAYLOAD_MEASURE_RE.test(t);
}

const htmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SIZE_KEY_RE = /^(?:size|size_?label|size_?name|label|name|מידה)$/i;

/* Every candidate chart markup inside a JSON value:
     · a string that IS markup with a table or an ARIA grid in it (a CMS block, castro's
       {html}, adidas's {content}, terminalx's GraphQL cmsBlocks content);
     · an array of 2+ row objects with a size-like key and at least one other key - a
       structured chart ([{size:"S", chest:"88-92"}, ...]) - rendered as a plain <table>
       whose header is the object keys, so the SHARED parser maps "chest" exactly as it
       would a printed header (and refuses what it would refuse).
   The `title` of the nearest enclosing object (title/name/identifier) rides along as a
   caption so classifyChart() can read "Women's tops" off it. Capped. */
export function htmlCandidatesFromJson(value, out = [], depth = 0, title = "") {
  if (out.length >= 20 || depth > 12 || value == null) return out;
  if (typeof value === "string") {
    if (/<table[\s>]|role=["']?table/i.test(value)) out.push(title ? `<section><h3>${htmlEsc(title)}</h3>${value}</section>` : value);
    return out;
  }
  if (Array.isArray(value)) {
    const objs = value.filter((v) => v && typeof v === "object" && !Array.isArray(v));
    if (objs.length >= 2 && objs.length === value.length) {
      const sizeKey = Object.keys(objs[0]).find((k) => SIZE_KEY_RE.test(k));
      if (sizeKey) {
        const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))]
          .filter((k) => k !== sizeKey && objs.some((o) => typeof o[k] === "string" || typeof o[k] === "number"));
        if (keys.length) {
          const head = `<tr><th>Size</th>${keys.map((k) => `<th>${htmlEsc(k)}</th>`).join("")}</tr>`;
          const body = objs.map((o) => `<tr><td>${htmlEsc(o[sizeKey])}</td>${keys.map((k) =>
            `<td>${typeof o[k] === "object" ? "" : htmlEsc(o[k])}</td>`).join("")}</tr>`).join("");
          out.push(`<section>${title ? `<h3>${htmlEsc(title)}</h3>` : ""}<table>${head}${body}</table></section>`);
        }
      }
    }
    for (const v of value) htmlCandidatesFromJson(v, out, depth + 1, title);
    return out;
  }
  if (typeof value === "object") {
    const own = ["title", "name", "identifier", "label", "heading"].map((k) => value[k]).find((v) => typeof v === "string" && v.length < 120);
    for (const v of Object.values(value)) htmlCandidatesFromJson(v, out, depth + 1, own || title);
  }
  return out;
}

/* Rendered pages carry hundreds of KB of CSS the parser never reads - and jsdom prints
   every stylesheet it cannot parse (renuar / hoodies flooded the log). Dropped before
   parsing; <script>s are inert under jsdom anyway. */
export function stripStyles(html) {
  return String(html || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<link[^>]+rel=["']?stylesheet[^>]*>/gi, "");
}

/* Where a guide's own context ends: the dialog / drawer / popup that holds it. */
export const GUIDE_BOUNDARY = '[role=dialog],[aria-modal=true],dialog,[class*="modal" i],[class*="drawer" i],[class*="popup" i]';

/** Rendered markup -> extractAllSizeCharts() entries, tagged for buildRecords().
   A GUIDE opened from a product page (browser_modal / browser_network) is the store's
   guide, shared by many products - so the product page may say WHO it is for (gender,
   kids: the referrer tier castro's guides already use) but never WHAT garment: on
   terminalx a women's chest+waist tops chart opened from a pair of trousers was typed
   "bottoms" off the trousers' title. Its own caption/heading/tab, then its columns,
   type it. A chart rendered IN the product page itself (browser_page) keeps the
   product's context, exactly like the static inline_table path. */
export function chartsFromHtml(html, pageUrl, JSDOM, { source, productUrl = "", referrerText = null } = {}) {
  const doc = new JSDOM(stripStyles(html), { url: pageUrl || "https://example.invalid/" }).window.document;
  const guide = source === "browser_modal" || source === "browser_network";
  const ref = guide ? referrerAudience([referrerText != null ? referrerText : pageContextText(doc, pageUrl)]) : null;
  return extractAllSizeCharts(doc, pageUrl, null, guide ? { contextBoundary: GUIDE_BOUNDARY } : {}).map((chart) => {
    if (guide) chart.classification = classifyChart(chart.rows, chart.localText, "", ref);
    return { chart, source, sourceUrl: pageUrl, productUrl };
  });
}

/** A captured network body (JSON or HTML) -> found entries. */
export function chartsFromNetworkBody(text, responseUrl, pageUrl, JSDOM, productUrl = "", referrerText = "") {
  const t = String(text || "").trim();
  let candidates = [];
  if (t[0] === "{" || t[0] === "[") {
    try { candidates = htmlCandidatesFromJson(JSON.parse(t)); } catch { candidates = []; }
  } else if (/<table[\s>]|role=["']?table/i.test(t)) {
    candidates = [t];
  }
  const out = [];
  for (const html of candidates) {
    for (const f of chartsFromHtml(html, pageUrl, JSDOM, { source: "browser_network", productUrl, referrerText })) {
      out.push({ ...f, sourceUrl: responseUrl });
    }
  }
  return out;
}

const rowsHash = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);

/* In-page script: mark every visible element whose label is a size-guide trigger and
   return their labels. Runs in the browser, so it is plain JS with no imports - the
   label test is re-done in Node with isSizeGuideTriggerLabel() before anything is
   clicked. */
const MARK_TRIGGERS = `(() => {
  const cands = [];
  const els = document.querySelectorAll('a,button,[role=button],[role=tab],summary,[data-toggle],[data-target],[onclick],span,div,li');
  for (const el of els) {
    if (cands.length >= 80) break;
    const label = [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').slice(0, 140)]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    if (!label || label.length > 140) continue;
    if (!/size|sizing|מידות|גדלים|מידה/i.test(label)) continue;
    // the innermost labelled element wins: skip a container whose child carries the same label
    if (el.children.length > 3) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || style.visibility === 'hidden' || style.display === 'none') continue;
    cands.push({ el, label });
  }
  /* INNERMOST ONLY: a wrapper whose text merely contains the trigger (terminalx's
     "מידה / טבלת מידות / XXS XS S ..." block) would be clicked in its centre - a size
     button - and spend the trigger budget. Keep a candidate only if no other candidate
     sits inside it; real controls (button/a) first. */
  const inner = cands.filter((c) => !cands.some((o) => o !== c && c.el.contains(o.el)));
  inner.sort((a, b) => (/^(BUTTON|A)$/.test(b.el.tagName) ? 1 : 0) - (/^(BUTTON|A)$/.test(a.el.tagName) ? 1 : 0));
  return inner.slice(0, 40).map((c, i) => {
    const id = 'pt' + i;
    c.el.setAttribute('data-pear-trigger', id);
    return { id, label: c.label, tag: c.el.tagName, href: c.el.getAttribute('href') || '' };
  });
})()`;

/* In-page script: tabs inside an open guide (dialog/modal/drawer) or, failing one, inside
   any visible container that holds a table / ARIA grid. */
const MARK_TABS = `(() => {
  const roots = [...document.querySelectorAll('[role=dialog],[aria-modal=true],.modal.show,.modal.in,.modal[style*="block"],[class*=modal i],[class*=drawer i],[class*=popup i],[class*=size-guide i],[class*=sizeguide i],[class*=size-chart i]')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 50; });
  const out = [];
  let i = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll('[role=tab],button,a,li,label')) {
      if (out.length >= 10) break;
      const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (!label || label.length > 40) continue;
      const tabby = el.getAttribute('role') === 'tab' || /tab/i.test(el.className || '') || /tab/i.test((el.parentElement && el.parentElement.className) || '');
      if (!tabby) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const id = 'pb' + (i++);
      el.setAttribute('data-pear-tab', id);
      out.push({ id, label });
    }
  }
  return out;
})()`;

/* In-page scripts: chart IMAGES. Before a click, remember every image already visible;
   after it, an image counts only if the click made it appear inside the guide that just
   opened, or its own name/alt says it is a chart. THE BUG THIS CLOSES: Kiwi Sizing
   (renuar.co.il) marks the <html> element "kiwi-sizing-modal-visible", so "inside an
   element whose class contains modal" matched the whole page and four product photos
   went to Gemini as size charts. */
const REMEMBER_VISIBLE_IMAGES = `(() => {
  window.__pearImgsBefore = new Set([...document.querySelectorAll('img')]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 20 && r.height > 20; })
    .map((i) => i.currentSrc || i.src));
  return window.__pearImgsBefore.size;
})()`;
const COLLECT_CHART_IMAGES = `(() => {
  const out = new Set();
  const before = window.__pearImgsBefore || new Set();
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src || /\\.svg(?:$|[?#])/i.test(src) || src.startsWith('data:')) continue;
    if ((img.naturalWidth || 0) < 300 || (img.naturalHeight || 0) < 150) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) continue;
    const label = [src, img.alt, img.className, img.id].join(' ');
    const guide = img.closest('[role=dialog],[aria-modal=true],[class*=modal i],[class*=size-guide i],[class*=sizeguide i],[class*=size-chart i],[class*=sizechart i]');
    const newlyShown = !before.has(src) && !!guide && guide !== document.documentElement && guide !== document.body;
    if (newlyShown || /size[\\s_-]*(?:guide|chart|table)|sizing|sizechart|sizeguide|measurement|מידות/i.test(label)) out.add(src);
  }
  return [...out].slice(0, 6);
})()`;

export async function loadPlaywright() {
  try {
    const pw = await import("playwright");
    return pw.chromium || (pw.default && pw.default.chromium);
  } catch (e) {
    throw new Error("Playwright is required for the browser fallback (npm install in the repo root, then " +
      "`npx playwright install chromium`): " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open product pages in headless Chromium and capture every size chart a shopper could
 * open there. Pure over `chromium` (injectable for tests).
 * @param {string} storeUrl
 * @param {{productUrls?: string[], maxPages?: number, delayMs?: number, log?: Function,
 *          JSDOM: Function, chromium?: object, maxTriggers?: number}} opts
 * @returns {Promise<{found: Array<object>, images: Array<{url:string, productUrl:string}>,
 *          report: object}>}
 */
export async function captureWithBrowser(storeUrl, {
  productUrls = [], maxPages = 6, delayMs = 1500, log = console.log, JSDOM, chromium = null,
  maxTriggers = 4, navTimeoutMs = 45000, verbose = !!process.env.PEAR_CAPTURE_VERBOSE,
} = {}) {
  const vlog = (m) => { if (verbose) log("    · " + m); };
  const report = { status: "ok", pages_opened: 0, pages_failed: 0, triggers_clicked: 0, tabs_clicked: 0,
    unmeasured_guides: 0, unmeasured_examples: [],
    network_payloads: 0, blocked: { count: 0, examples: [] }, errors: [], methods: {} };
  const found = [], images = [];
  const ch = chromium || await loadPlaywright();
  const base = new URL(storeUrl);
  const host = canonicalStoreHost(base.hostname);
  let browser;
  try {
    browser = await ch.launch({ headless: true });
  } catch (e) {
    report.status = "browser_unavailable";
    report.errors.push("could not launch Chromium: " + e.message.split("\n")[0]);
    return { found, images, report };
  }
  const context = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const payloads = [];
  /* The label of the guide button clicked last. terminalx's reads "טבלת מידות / VARLEY /
     נשים" - the store naming the chart's audience on the control that opens it - so it
     rides with every reading taken after that click (modal, tabs, network, images) as
     referrer evidence for gender/kids, never for the garment type. */
  let lastTrigger = "";
  page.on("response", async (resp) => {
    try {
      const type = resp.request().resourceType();
      if (type !== "xhr" && type !== "fetch" && type !== "document") return;
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!/json|html|text/.test(ct)) return;
      if (payloads.length >= 60) return;
      const text = await resp.text();
      if (looksLikeSizePayload(text)) payloads.push({ url: resp.url(), text, pageUrl: page.url(), trigger: lastTrigger });
    } catch { /* a body we cannot read is not evidence */ }
  });

  const seen = new Map();   // key -> index in found
  const add = (entries, pageUrl) => {
    for (const f of entries) {
      /* Per page, one reading per chart CONTENT, whichever method saw it first (the
         modal snapshot and the network response that filled it are one chart). */
      const key = pageUrl + "|" + rowsHash(f.chart.rows);
      if (seen.has(key)) {
        /* ...but the BETTER-LABELLED reading wins: terminalx's modal shows a bare table,
           while the CMS response that filled it carries the block title ("women"). */
        const i = seen.get(key);
        if (f.chart.classification.confidence > found[i].chart.classification.confidence) found[i] = f;
        continue;
      }
      seen.set(key, found.length);
      found.push(f);
      report.methods[f.source] = (report.methods[f.source] || 0) + 1;
    }
  };
  const isBlocked = async (resp) => {
    const status = resp ? resp.status() : 0;
    if (status === 403 || status === 429) return `HTTP ${status}`;
    const html = await page.content().catch(() => "");
    if (looksLikeBotChallenge({ text: html, contentType: "text/html" })) return "bot challenge page";
    return null;
  };

  try {
    /* Which pages: the static run's sample when it had one; otherwise read product links
       off the rendered home page (a JS storefront's links exist only after render). */
    let urls = productUrls.slice();
    if (!urls.length) {
      const resp = await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs }).catch((e) => { report.errors.push("home: " + e.message.split("\n")[0]); return null; });
      const why = resp ? await isBlocked(resp) : "no response";
      if (why && why !== "no response") {
        report.status = "blocked"; report.blocked.count++; report.blocked.examples.push(storeUrl + " (" + why + ")");
        return { found, images, report };
      }
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.href)).catch(() => []);
      urls = [...new Set(hrefs.filter((h) => { try { return canonicalStoreHost(new URL(h).hostname) === host && isProductPathUrl(h); } catch { return false; } }))];
      if (!urls.length) {
        /* id-shaped product URLs (terminalx's /w414418263) carry no pattern word */
        urls = [...new Set(hrefs.filter((h) => { try { const u = new URL(h); return canonicalStoreHost(u.hostname) === host && /\/[^/]*\d{5,}[^/]*$/.test(u.pathname); } catch { return false; } }))];
      }
    }
    urls = urls.slice(0, maxPages).map(normalizePageUrl);
    if (!urls.length) report.errors.push("no product pages to open");

    for (const url of urls) {
      await sleep(delayMs);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
        .catch((e) => { report.errors.push(url + ": " + e.message.split("\n")[0]); return null; });
      if (!resp) { report.pages_failed++; continue; }
      const why = await isBlocked(resp);
      if (why) {
        report.blocked.count++; if (report.blocked.examples.length < 3) report.blocked.examples.push(url + " (" + why + ")");
        report.pages_failed++;
        /* Two blocked pages in a row is the store saying no - stop, do not push on. */
        if (report.blocked.count >= 2 && report.pages_opened === 0) { report.status = "blocked"; break; }
        continue;
      }
      report.pages_opened++;
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      lastTrigger = "";
      const pdpHtml = await page.content();
      const pdpContext = pageContextText(new JSDOM(stripStyles(pdpHtml), { url }).window.document, url);
      add(chartsFromHtml(pdpHtml, url, JSDOM, { source: "browser_page", productUrl: url }), url);

      const marked = await page.evaluate(MARK_TRIGGERS).catch(() => []);
      const triggers = marked.filter((t) => isSizeGuideTriggerLabel(t.label)).slice(0, maxTriggers);
      vlog(`${url}: ${marked.length} size-ish element(s), ${triggers.length} trigger(s): ${triggers.map((t) => t.tag + " " + JSON.stringify(t.label.slice(0, 40))).join(", ")}`);
      for (const t of triggers) {
        const before = page.url();
        await page.evaluate(REMEMBER_VISIBLE_IMAGES).catch(() => 0);
        lastTrigger = t.label;
        const refText = pdpContext + " | " + t.label;
        const foundBefore = found.length;
        try {
          await page.locator(`[data-pear-trigger="${t.id}"]`).first().click({ timeout: 4000 });
          report.triggers_clicked++;
        } catch (e) { vlog("click failed: " + String(e.message).split("\n")[0]); continue; }
        await page.waitForTimeout(1200);
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        add(chartsFromHtml(await page.content(), page.url(), JSDOM, { source: "browser_modal", productUrl: url, referrerText: refText }), url);
        const tabs = await page.evaluate(MARK_TABS).catch(() => []);
        for (const tab of tabs) {
          try {
            await page.locator(`[data-pear-tab="${tab.id}"]`).first().click({ timeout: 3000 });
            report.tabs_clicked++;
            await page.waitForTimeout(700);
            add(chartsFromHtml(await page.content(), page.url(), JSDOM, { source: "browser_modal", productUrl: url, referrerText: refText }), url);
          } catch { /* a tab that will not click is skipped */ }
        }
        const imagesBefore = images.length;
        for (const src of await page.evaluate(COLLECT_CHART_IMAGES).catch(() => [])) {
          if (!images.some((i) => i.url === src)) images.push({ url: src, productUrl: url, context: refText });
        }
        /* The guide OPENED, it holds a table, and the parser kept nothing from it and no
           chart image appeared: a size-CONVERSION table (factory54: SIZE | FR | IT | UK |
           US | JEANS) with no body measurement. Correctly not a chart - but it is a
           different answer from "could not open the guide", so it is counted. */
        if (found.length === foundBefore && images.length === imagesBefore) {
          const grids = await page.evaluate(`document.querySelectorAll('table,[role=table]').length`).catch(() => 0);
          if (grids > 0) {
            report.unmeasured_guides++;
            if (report.unmeasured_examples.length < 2) report.unmeasured_examples.push(url);
          }
        }
        if (page.url() !== before) {
          await page.goBack({ timeout: navTimeoutMs }).catch(() => {});
        } else {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        }
      }
      await page.waitForTimeout(500);   // let in-flight response bodies land
      vlog(`${payloads.length} size payload(s): ${payloads.map((p) => p.url.slice(0, 80)).join(" | ")}`);
      for (const p of payloads.splice(0)) {
        report.network_payloads++;
        add(chartsFromNetworkBody(p.text, p.url, url, JSDOM, url, pdpContext + (p.trigger ? " | " + p.trigger : "")), url);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  if (report.status === "ok" && report.pages_opened === 0 && report.blocked.count) report.status = "blocked";
  log(`  browser: ${report.pages_opened} page(s) opened, ${report.triggers_clicked} trigger(s) + ${report.tabs_clicked} tab(s) clicked, ` +
    `${report.network_payloads} size payload(s), ${found.length} chart reading(s), ${images.length} chart image(s)` +
    (report.blocked.count ? `, BLOCKED ${report.blocked.count}x` : ""));
  return { found, images, report };
}
