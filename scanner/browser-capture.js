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
   403/429 or a challenge page is reported as BLOCKED and the run stops for that store -
   also when it answers the GUIDE's own request (the adidas Product-SizeChart pattern):
   no further guide is clicked there. The manual import (import-chart.js) is the way in.
   report.guide_refused says the guide's own request was refused, whatever was read (capture.js
   then fetches nothing more from the store's own site).

   report.status: "ok" | "blocked" (the store refused us) | "unreachable" (navigations
   failed with no HTTP answer at all - reset, protocol error, timeout - errors[0] says
   which; the home page too) | "no_products" (no product page to open, nothing refused) |
   "browser_unavailable".
   ============================================================================= */
import { createHash } from "node:crypto";
import { extractAllSizeCharts, SIZE_GUIDE_LINK_RE, isProductPathUrl, canonicalStoreHost,
  normalizePageUrl, looksLikeBotChallenge, classifyChart, pageContextText, referrerAudience, buildRecords } from "./size-charts.js";

/* One product, one spelling. THE BUG THIS CLOSES (review, 2026-10-07): the home-page
   fallback de-duplicated RAW hrefs, so a product linked as /collections/all/products/linen-tee,
   /products/linen-tee and /products/linen-tee?variant=2 (a collection grid, a swatch) was
   opened three times - and buildRecords, seeing its own inline chart on "3 pages", saved ONE
   product's chart as the store's (product_key ''). A product page is named by its PATH: the
   fragment, Shopify's /collections/<x>/ prefix and the query (variant, tracking) are dropped -
   the query only when the path alone NAMES the product, so /product.php?id=12 keeps the
   query that names it. Phase 1's sampler is not changed here; capture.js names every stage's
   pages with this same function before it merges them (one product, one page, in all stages).
   THE BUG THIS CLOSES (review, 2026-10-11): "product-shaped" (isProductPathUrl - any
   /products/<x> at the root, any hyphenated last segment) was taken for "names the product",
   so EC-CUBE's /products/detail.php?product_id=12, an ASP.NET /shop/product-details.aspx?
   productid=5 and /products/view?id=99 lost the id: every sampled product became ONE id-less
   page (a 404 there), opened once, nothing read. A path does not name the product when its last
   segment is a SCRIPT (.php/.aspx/.jsp...: the query is its argument) or when the query carries
   a key that identifies a product (id, pid, sku, product_id, handle...) - then the whole query is
   kept, as before the canonical form existed. variant, utm_ tracking, fbclid and ref still go. */
const ID_SHAPED_PATH_RE = /\/[^/]*\d{5,}[^/]*$/;
const SCRIPT_SEGMENT_RE = /\.(?:php\d?|aspx?|jspx?|cfm|cgi|pl|do|action)$/i;
const PRODUCT_ID_PARAM_RE = /^(?:id|pid|p|sku|handle|product|item|(?:product|prod|item|goods|style|article)s?[_-]?(?:id|code|no|num))$/i;
export function canonicalProductUrl(u) {
  const n = normalizePageUrl(u);
  let x;
  try { x = new URL(n); } catch { return n; }
  const segs = x.pathname.split("/");
  const c = segs.findIndex((s, i) => s.toLowerCase() === "collections" && (segs[i + 2] || "").toLowerCase() === "products" && !!segs[i + 3]);
  if (c > 0) { segs.splice(c, 2); x.pathname = segs.join("/"); }
  const productShaped = isProductPathUrl(x.origin + x.pathname) || ID_SHAPED_PATH_RE.test(x.pathname);
  const queryNamesIt = SCRIPT_SEGMENT_RE.test(x.pathname) || [...x.searchParams.keys()].some((k) => PRODUCT_ID_PARAM_RE.test(k));
  if (productShaped && !queryNamesIt) x.search = "";
  return x.href;
}

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
   least two size tokens or a table. Cheap pre-filter; the parser is the real judge.
   JSON \uXXXX escapes are decoded first: PHP's json_encode (WordPress's wp_send_json, every
   WooCommerce admin-ajax guide) escapes all non-ASCII by default, so a Hebrew-only guide
   arrived as "\u05d8\u05d1..." - no Hebrew word for the filter to see - and was dropped
   before the parser, which reads it fine after JSON.parse. */
const PAYLOAD_SIZE_WORD_RE = /size[\s_-]*(?:chart|guide|table)|sizechart|sizeguide|מדריך\s*מידות|טבלת\s*מידות|"size"\s*:|measurements?/i;
const PAYLOAD_MEASURE_RE = /chest|bust|waist|hips?|חזה|מותן|מותניים|אגן|ירכיים/i;
export function looksLikeSizePayload(text) {
  let t = String(text || "");
  if (t.length < 40 || t.length > 2_000_000) return false;
  if (t.includes("\\u")) t = t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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
   product's context, exactly like the static inline_table path.
   A browser_page chart that a shopper could NOT see at page read (MARK_HIDDEN_GRIDS left
   data-pear-hidden on it) and that sits inside a guide container (GUIDE_BOUNDARY, never
   <html>/<body> - Bootstrap's "modal-open") is marked `inGuide`: a guide pre-rendered hidden
   (Shopify Dawn's .product-popup-modal) is still read with the product's context here, as
   Phase 1 reads it, but once a click OPENS it the guide's own reading replaces this one
   (captureWithBrowser's add()). THE BUG THIS CLOSES (review, 2026-10-07): the container alone
   decided it, so a chart shown in the page inside <div class="product-info-drawer"> was
   replaced by the next click's whole-page re-read - typed off its columns, the product's
   "jeans" lost ("bottoms", or no type at all and dropped by buildRecords). The marker is
   removed before parsing, so it never reaches a saved snapshot.
   A guide container is not the PAGE (review, 2026-10-11 - the lines import-chart.js's readHtml
   draws for the same themes): a CLASS-only match ([class*=modal|drawer|popup]) is never a
   wrapper that is or holds <main>, nor one that holds every <h1>; a real dialog ([role=dialog],
   [aria-modal], <dialog>) is the guide whatever it holds. THE BUG THIS CLOSES: only <html>/
   <body> were excluded, and Debut wraps the whole page in #PageContainer.drawer-page-content
   (Timber/Brooklyn: .is-moved-by-drawer) - so a size chart in a product TAB, display:none until
   its tab is clicked, read as a hidden guide, and the first click's whole-page re-read replaced
   it: a "Slim Fit Jeans" chart saved as browser_modal "bottoms" where d2136b6 saved
   browser_page "jeans" (or, with no type in the columns, dropped). A hidden popup INSIDE that
   wrapper is still a guide container. */
export function chartsFromHtml(html, pageUrl, JSDOM, { source, productUrl = "", referrerText = null } = {}) {
  const doc = new JSDOM(stripStyles(html), { url: pageUrl || "https://example.invalid/" }).window.document;
  const hidden = [...doc.querySelectorAll("[data-pear-hidden]")];
  for (const el of hidden) el.removeAttribute("data-pear-hidden");
  const guide = source === "browser_modal" || source === "browser_network";
  const ref = guide ? referrerAudience([referrerText != null ? referrerText : pageContextText(doc, pageUrl)]) : null;
  const h1s = [...doc.querySelectorAll("h1")];
  const isThePage = (el) => el === doc.documentElement || el === doc.body ||
    (!el.matches("[role=dialog],[aria-modal=true],dialog") &&
      (el.matches("main,[role=main]") || !!el.querySelector("main,[role=main]") || (h1s.length > 0 && h1s.every((h) => el.contains(h)))));
  const guideRoots = source === "browser_page"
    ? [...doc.querySelectorAll(GUIDE_BOUNDARY)].filter((el) => !isThePage(el)) : [];
  const hiddenInGuide = hidden.filter((el) => guideRoots.some((r) => r.contains(el)));
  return extractAllSizeCharts(doc, pageUrl, null, guide ? { contextBoundary: GUIDE_BOUNDARY } : {}).map((chart) => {
    if (guide) chart.classification = classifyChart(chart.rows, chart.localText, "", ref);
    const entry = { chart, source, sourceUrl: pageUrl, productUrl };
    if (chart.rawSnapshot && hiddenInGuide.some((el) => el.outerHTML.includes(chart.rawSnapshot))) entry.inGuide = true;
    return entry;
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
   Node regexes are compiled into it, and the label test is re-done in Node with
   isSizeGuideTriggerLabel() before anything is clicked.
   THE BUG THIS CLOSES (review, 2026-10-05): the page kept anything merely size-ish
   (size / מידות / מידה) and only THEN kept the innermost - so in
   <button><span>Size</span> guide</button> the bare "Size" span evicted its button, Node
   refused "Size", and the guide was never opened (likewise <span>טבלת</span> <span>מידות</span>,
   or aria-label "Size chart" over a "Sizes" span). The full trigger test now runs BEFORE the
   innermost-only filter, so a child that is not a trigger by itself cannot evict a parent
   that is. */
const MARK_TRIGGERS = `(() => {
  const TRIG = [new RegExp(${JSON.stringify(SIZE_GUIDE_LINK_RE.source)}, ${JSON.stringify(SIZE_GUIDE_LINK_RE.flags)}),
    new RegExp(${JSON.stringify(EXTRA_TRIGGER_RE.source)}, ${JSON.stringify(EXTRA_TRIGGER_RE.flags)})];
  const NEVER = new RegExp(${JSON.stringify(NEVER_CLICK_RE.source)}, ${JSON.stringify(NEVER_CLICK_RE.flags)});
  const cands = [];
  const els = document.querySelectorAll('a,button,[role=button],[role=tab],summary,[data-toggle],[data-target],[onclick],span,div,li');
  for (const el of els) {
    if (cands.length >= 80) break;
    const label = [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').slice(0, 140)]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    if (!label || label.length > 120) continue;
    if (NEVER.test(label) || !TRIG.some((re) => re.test(label))) continue;
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

/* In-page helper: is this element SHOWN to a shopper - a real box, and not hidden by CSS?
   A box alone is not enough: Shopify Dawn's size-guide popup (.product-popup-modal) sits in
   the DOM from page load under visibility:hidden + opacity:0 and keeps its full layout box,
   so its table read as "visible before the click" (the guide that opened it never counted
   as opened) and its tabs were clicked into 3 s timeouts while it was still hidden.
   checkVisibility() covers display:none, visibility and an ancestor's opacity:0 (both the
   current option names and the older ones Chromium still reads); without it, the computed
   style of the element and its ancestors. */
const SHOWN_FN = `((el, minW, minH) => {
  const r = el.getBoundingClientRect();
  if (r.width <= minW || r.height <= minH) return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
  }
  for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
    const st = getComputedStyle(a);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || parseFloat(st.opacity) === 0) return false;
  }
  return true;
})`;

/* In-page script: tabs inside an open guide (dialog/modal/drawer) or, failing one, inside
   any visible container that holds a table / ARIA grid.
   THE BUGS THIS CLOSES (review, 2026-10-05):
   · Bootstrap marks <body> "modal-open" and Kiwi Sizing marks <html>
     "kiwi-sizing-modal-visible", so [class*=modal] took the WHOLE PAGE as a guide (the trap
     COLLECT_CHART_IMAGES already guards) - first in document order, so page controls filled
     the 10-tab cap before the guide's own men/women tabs, and an "add-to-cart hidden-tablet"
     button was clicked (the cart POSTed). <html>/<body> are never a guide root, "table" /
     "tablet" in a class name is not "tab", and Node holds every tab label to NEVER_CLICK_RE
     exactly like a trigger.
   · ids restarted at pb0 on every call and old marks stayed, so the SECOND guide's pb0
     resolved to the first guide's hidden tab (3 s timeout, skipped) and its charts were
     never read. Old marks are cleared first, and a tab already marked under an outer root
     (.modal > .modal-dialog > .modal-content) is not marked again. */
const MARK_TABS = `(() => {
  const shown = ${SHOWN_FN};
  for (const old of document.querySelectorAll('[data-pear-tab]')) old.removeAttribute('data-pear-tab');
  const roots = [...document.querySelectorAll('[role=dialog],[aria-modal=true],.modal.show,.modal.in,.modal[style*="block"],[class*=modal i],[class*=drawer i],[class*=popup i],[class*=size-guide i],[class*=sizeguide i],[class*=size-chart i]')]
    .filter((el) => {
      if (el === document.documentElement || el === document.body) return false;
      return shown(el, 50, 50);
    });
  const out = [];
  let i = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll('[role=tab],button,a,li,label')) {
      if (out.length >= 10) break;
      if (el.hasAttribute('data-pear-tab')) continue;
      const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (!label || label.length > 40) continue;
      const tabby = el.getAttribute('role') === 'tab' || /tab(?!le)/i.test(el.className || '') || /tab(?!le)/i.test((el.parentElement && el.parentElement.className) || '');
      if (!tabby) continue;
      if (!shown(el, 3, 3)) continue;
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
  const shown = ${SHOWN_FN};
  window.__pearImgsBefore = new Set([...document.querySelectorAll('img')]
    .filter((i) => shown(i, 20, 20))
    .map((i) => i.currentSrc || i.src));
  return window.__pearImgsBefore.size;
})()`;
const COLLECT_CHART_IMAGES = `(() => {
  const shown = ${SHOWN_FN};
  const out = new Set();
  const before = window.__pearImgsBefore || new Set();
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src || /\\.svg(?:$|[?#])/i.test(src) || src.startsWith('data:')) continue;
    if ((img.naturalWidth || 0) < 300 || (img.naturalHeight || 0) < 150) continue;
    if (!shown(img, 119, 59)) continue;
    const label = [src, img.alt, img.className, img.id].join(' ');
    const guide = img.closest('[role=dialog],[aria-modal=true],[class*=modal i],[class*=size-guide i],[class*=sizeguide i],[class*=size-chart i],[class*=sizechart i]');
    const newlyShown = !before.has(src) && !!guide && guide !== document.documentElement && guide !== document.body;
    if (newlyShown || /size[\\s_-]*(?:guide|chart|table)|sizing|sizechart|sizeguide|measurement|מידות/i.test(label)) out.add(src);
  }
  return [...out].slice(0, 6);
})()`;

/* In-page scripts: TABLES the click made visible. "A guide opened and holds only a table we
   cannot read" (unmeasured_guides) used to count ANY table in the document after a click -
   so a product-specs table (WooCommerce's "Material | Cotton") under a click that opened
   nothing, or under a guide rendered in an iframe, read as a size-CONVERSION guide, and the
   user was told the guide opened when it never had (no_measurements instead of
   js_unreadable). Only a table that was not visible before the click counts now; a guide
   pre-rendered hidden that the click shows still does (factory54) - also one hidden by CSS
   that keeps its layout box (Dawn), since "visible" is SHOWN_FN, not a box. */
const REMEMBER_VISIBLE_GRIDS = `(() => {
  const shown = ${SHOWN_FN};
  window.__pearGridsBefore = new Set([...document.querySelectorAll('table,[role=table]')].filter((t) => shown(t, 20, 20)));
  return window.__pearGridsBefore.size;
})()`;
const NEW_VISIBLE_GRIDS = `(() => {
  const shown = ${SHOWN_FN};
  const before = window.__pearGridsBefore || new Set();
  return [...document.querySelectorAll('table,[role=table]')].filter((t) => shown(t, 20, 20) && !before.has(t)).length;
})()`;
/* In-page script, run just before the product page is read: mark every table / ARIA grid a
   shopper cannot see yet, so chartsFromHtml() can tell a guide pre-rendered HIDDEN (its later
   opened reading wins) from a chart shown in the page (keeps the product's context). */
const MARK_HIDDEN_GRIDS = `(() => {
  const shown = ${SHOWN_FN};
  let n = 0;
  for (const t of document.querySelectorAll('table,[role=table],[role=grid]')) {
    if (shown(t, 20, 20)) t.removeAttribute('data-pear-hidden');
    else { t.setAttribute('data-pear-hidden', ''); n++; }
  }
  return n;
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

/* A trigger that LEAVES the page: a link to another document (a /pages/size-guide prose
   page), not a "#" anchor or a javascript: one. See the trigger loop for why it goes last. */
function leavesPage(t, pageUrl) {
  if (t.tag !== "A" || !t.href || /^\s*(?:#|javascript:)/i.test(t.href)) return false;
  try {
    const to = new URL(t.href, pageUrl), from = new URL(pageUrl);
    to.hash = ""; from.hash = "";
    return to.href !== from.href;
  } catch { return false; }
}

/**
 * Open product pages in headless Chromium and capture every size chart a shopper could
 * open there. Pure over `chromium` (injectable for tests, as is `loadChromium`, the
 * loader used when no `chromium` is passed).
 * @param {string} storeUrl
 * @param {{productUrls?: string[], maxPages?: number, delayMs?: number, log?: Function,
 *          JSDOM: Function, chromium?: object, loadChromium?: Function, maxTriggers?: number,
 *          navTimeoutMs?: number, pageOpTimeoutMs?: number}} opts
 * @returns {Promise<{found: Array<object>,
 *          images: Array<{url:string, productUrl:string, pages:string[], context:string}>,
 *          report: object}>}  images: one entry per chart image, `pages` = every product
 *          page it was seen on (productUrl = the first), so buildRecords' "2+ pages =
 *          the store's chart" rule can apply to an image too. report.status: see the header.
 */
export async function captureWithBrowser(storeUrl, {
  productUrls = [], maxPages = 6, delayMs = 1500, log = console.log, JSDOM, chromium = null,
  loadChromium = loadPlaywright,
  maxTriggers = 4, navTimeoutMs = 45000, pageOpTimeoutMs = 15000, verbose = !!process.env.PEAR_CAPTURE_VERBOSE,
} = {}) {
  const vlog = (m) => { if (verbose) log("    · " + m); };
  const errText = (e) => String((e && e.message) || e).split("\n")[0];
  const report = { status: "ok", guide_refused: false, pages_opened: 0, pages_failed: 0, triggers_clicked: 0, tabs_clicked: 0,
    unmeasured_guides: 0, unmeasured_examples: [],
    network_payloads: 0, blocked: { count: 0, examples: [] }, errors: [], methods: {} };
  const found = [], images = [];
  /* A browser that cannot be had is BROWSER_UNAVAILABLE, never a throw - the caller already
     holds the static stage's charts, and a throw discarded them with the whole run. That
     covers the playwright package itself (scanner/package.json does not carry it; only the
     repo root's @playwright/test does), Chromium not launching, and a context or page that
     will not open (which also left the launched Chromium running). */
  let ch;
  try {
    ch = chromium || await loadChromium();
  } catch (e) {
    report.status = "browser_unavailable";
    report.errors.push(errText(e));
    return { found, images, report };
  }
  const base = new URL(storeUrl);
  const host = canonicalStoreHost(base.hostname);
  const onStoreHost = (u) => {
    try { const h = canonicalStoreHost(new URL(u).hostname); return h === host || (!!host && h.endsWith("." + host)); } catch { return false; }
  };
  let browser;
  try {
    browser = await ch.launch({ headless: true });
  } catch (e) {
    report.status = "browser_unavailable";
    report.errors.push("could not launch Chromium: " + errText(e));
    return { found, images, report };
  }
  const payloads = [];
  /* The label of the guide button clicked last. terminalx's reads "טבלת מידות / VARLEY /
     נשים" - the store naming the chart's audience on the control that opens it - so it
     rides with every reading taken after that click (modal, tabs, network, images) as
     referrer evidence for gender/kids, never for the garment type. */
  let lastTrigger = "";
  /* Which product page a response belongs to: bumped before each navigation. The label and
     the generation are read when the response ARRIVES, not after its body lands. */
  let pageGen = 0;
  /* THE GUIDE'S OWN REQUEST REFUSED (review, 2026-10-07). A store can serve its product
     pages and refuse the size-guide request itself (adidas's Product-SizeChart, which STATUS
     records as bot-challenged). Only the product navigation was ever checked, so the refused
     endpoint was asked again on every trigger of every page (up to 24 times) and the run
     said "JS GUIDE NOT OPENED". A 403/429 or a challenge body answering an xhr/fetch on the
     store's host AFTER a guide click - or the navigation a guide link made - is a refusal:
     it is counted in report.blocked (and report.guide_refused), no further guide - nor tab of
     the open one - is clicked on this store, and with no chart KEPT the run ends BLOCKED. Only
     what answers inside the guide's own window counts - from a trigger or tab click to the read
     of what it opened (`guideWindow`): requests made while a page loads, or after the guide was
     read (a recommendations call, a lazy-load, a CSRF-refused POST on the same host), are not
     the guide's. */
  let guideRefused = false, guideWindow = false;
  const refuseGuide = (u, why) => {
    guideRefused = true;
    report.guide_refused = true;
    report.blocked.count++;
    if (report.blocked.examples.length < 3) report.blocked.examples.push(u + " (guide request: " + why + ")");
  };
  const listen = (pg) => pg.on("response", async (resp) => {
    const gen = pageGen, trigger = lastTrigger, asked = guideWindow;
    try {
      const req = resp.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch" && type !== "document") return;
      /* THE BUG THIS CLOSES (review, 2026-10-07): the product page's OWN document (and its
         goBack reload) was a "size payload" whenever its HTML held a dataLayer `"size":` and
         a word like "waist" or "shipping" - almost every apparel PDP - so a store with no
         guide at all reported network_payloads >= 1 and read as "JS GUIDE NOT OPENED". The
         main frame's document is read from page.content(); only its status matters here. */
      const mainNav = type === "document" && req.isNavigationRequest() && resp.frame() === pg.mainFrame();
      const guideReq = asked && (type !== "document" || mainNav) && onStoreHost(resp.url());
      const status = resp.status();
      if (guideReq && (status === 403 || status === 429)) { refuseGuide(resp.url(), `HTTP ${status}`); return; }
      if (mainNav) return;
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!/json|html|text/.test(ct)) return;
      if (payloads.length >= 60) return;
      const text = await resp.text();
      if (guideReq && looksLikeBotChallenge({ text, contentType: ct })) { refuseGuide(resp.url(), "bot challenge page"); return; }
      if (looksLikeSizePayload(text)) payloads.push({ url: resp.url(), text, pageUrl: pg.url(), trigger, gen });
    } catch { /* a body we cannot read is not evidence */ }
  });
  let context, page;
  const openPage = async () => {
    context = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 900 } });
    page = await context.newPage();
    listen(page);
  };
  try {
    await openPage();
  } catch (e) {
    await browser.close().catch(() => {});
    report.status = "browser_unavailable";
    report.errors.push("could not open a page: " + errText(e));
    return { found, images, report };
  }
  /* A PAGE THAT STOPS ANSWERING (review, 2026-10-07). goto, the load waits, click and goBack
     carry their own timeouts; content(), evaluate() and $$eval run INSIDE the page and carry
     none - a product page whose script spins the main thread (a broken third-party script)
     hung the whole capture: the next page never opened, Chromium was never closed, and the
     static stage's charts were never summarised or offered for save. Every in-page call
     races a deadline; on expiry the page is given up (a failed page when it had not been
     read yet), its context is closed without waiting for it, and the next URL opens in a
     fresh context - a fresh renderer.
     bounded() takes the call, not its promise (review, 2026-10-07): handed a promise, the call
     was already STARTED on a page known to be stuck; it settled only when the context closed,
     with a rejection nothing handled - Node exits on that (code 1), so the static charts and
     the y/n were lost after all. Once a page is stuck nothing more is started on it. */
  let stuck = "";
  const bounded = (call) => {
    if (stuck) return Promise.reject(new Error(stuck));   // the same page: nothing new is started on it
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!stuck) stuck = `the page stopped answering for ${Math.round(pageOpTimeoutMs / 100) / 10}s - given up`;
        reject(new Error(stuck));
      }, pageOpTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(call), deadline]).finally(() => clearTimeout(timer));
  };
  const freshPage = async () => {
    const old = context;
    Promise.resolve().then(() => old.close()).catch(() => {});   // never awaited: a spinning renderer may never confirm
    try { await openPage(); stuck = ""; return true; } catch (e) { report.errors.push("could not open a fresh page: " + errText(e)); return false; }
  };

  const seen = new Map();   // key -> index in found
  /* Returns how many readings the parser produced, BEFORE de-duplication: a guide re-opened
     on a later trigger adds nothing new to `found` but did hold a chart. */
  const add = (entries, pageUrl) => {
    for (const f of entries) {
      /* Per page, one reading per chart CONTENT, whichever method saw it first (the
         modal snapshot and the network response that filled it are one chart). */
      const key = pageUrl + "|" + rowsHash(f.chart.rows);
      if (seen.has(key)) {
        /* ...but the BETTER-LABELLED reading wins: terminalx's modal shows a bare table,
           while the CMS response that filled it carries the block title ("women").
           And a guide the click OPENED wins over the page's reading of the same guide while
           it sat pre-rendered and hidden (inGuide, Shopify Dawn): that reading took its type
           from the PRODUCT title - a chest+waist tops guide on a "Slim Fit Jeans" page read
           "jeans" at 0.65 - and the guide's own reading (tops, from its columns, 0.5) could
           never replace it on confidence: the terminalx mistyping the guide path exists to stop. */
        const i = seen.get(key), prev = found[i];
        const openedGuide = prev.source === "browser_page" && prev.inGuide && (f.source === "browser_modal" || f.source === "browser_network");
        if (openedGuide || f.chart.classification.confidence > prev.chart.classification.confidence) found[i] = f;
        continue;
      }
      seen.set(key, found.length);
      found.push(f);
      report.methods[f.source] = (report.methods[f.source] || 0) + 1;
    }
    return entries.length;
  };
  const isBlocked = async (resp) => {
    const status = resp ? resp.status() : 0;
    if (status === 403 || status === 429) return `HTTP ${status}`;
    const html = await bounded(() => page.content()).catch(() => "");
    if (looksLikeBotChallenge({ text: html, contentType: "text/html" })) return "bot challenge page";
    return null;
  };

  let noProducts = false, firstUnanswered = "";
  try {
    /* Which pages: the static run's sample when it had one; otherwise read product links
       off the rendered home page (a JS storefront's links exist only after render). */
    let urls = productUrls.slice();
    if (!urls.length) {
      /* A home page with no HTTP answer is UNREACHABLE, exactly like a product page (review,
         2026-10-07): on a JS storefront - the only one that gets here - an HTTP/2 reset of the
         home page read "no product page found" and sent the operator to --url / --html. */
      const resp = await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
        .catch((e) => { firstUnanswered = "home: " + e.message.split("\n")[0]; report.errors.push(firstUnanswered); return null; });
      const why = resp ? await isBlocked(resp) : "no response";
      if (why && why !== "no response") {
        report.status = "blocked"; report.blocked.count++; report.blocked.examples.push(storeUrl + " (" + why + ")");
        return { found, images, report };
      }
      if (stuck) report.errors.push("home: " + stuck);
      if (resp && !stuck) {
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        const hrefs = await bounded(() => page.$$eval("a[href]", (as) => as.map((a) => a.href))).catch(() => []);
        urls = hrefs.filter((h) => { try { return canonicalStoreHost(new URL(h).hostname) === host && isProductPathUrl(h); } catch { return false; } });
        if (!urls.length) {
          /* id-shaped product URLs (terminalx's /w414418263) carry no pattern word */
          urls = hrefs.filter((h) => { try { const u = new URL(h); return canonicalStoreHost(u.hostname) === host && ID_SHAPED_PATH_RE.test(u.pathname); } catch { return false; } });
        }
      }
    }
    /* De-duplicated on the canonical spelling, BEFORE the page cap (canonicalProductUrl). */
    urls = [...new Set(urls.map(canonicalProductUrl))].slice(0, maxPages);
    /* NO PRODUCT PAGE TO OPEN (review, 2026-10-07): an empty static sample and a rendered home
       page with no product link used to end "ok" with 0 pages opened, which the caller could
       only read as "JS GUIDE NOT OPENED ... (0 page(s))" and sent the operator after a
       client-side guide. It is its own status now (a home page that never answered at all is
       UNREACHABLE, below). */
    if (!urls.length) { noProducts = true; report.errors.push("no product pages to open"); }

    let refusedInARow = 0, unansweredInARow = 0;
    for (const url of urls) {
      if (stuck && !(await freshPage())) break;
      await sleep(delayMs);
      /* THE BUG THIS CLOSES (review, 2026-10-05): the label and the payloads were reset only
         AFTER the next page had loaded, so page B's own document response and every fetch it
         made while loading carried page A's guide label - and A's "נשים" won B's unlabelled
         inline chart (0.65 over 0.5): saved as women's. Reset before the navigation; a late
         response from A (an older generation) is dropped, never credited to B. */
      lastTrigger = "";
      pageGen++;
      payloads.length = 0;
      let navError = "";
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs })
        .catch((e) => { navError = url + ": " + e.message.split("\n")[0]; report.errors.push(navError); return null; });
      if (!resp) {
        report.pages_failed++;
        /* NO ANSWER AT ALL (review, 2026-10-07): a store that resets the stream on a headless
           client (Akamai's net::ERR_HTTP2_PROTOCOL_ERROR) or tarpits it into timeouts never
           sends a 403, so this used to ask every sampled page - 45s each on a tarpit - and
           end "ok", read as "JS GUIDE NOT OPENED". Two in a row with nothing opened stop the
           run, reported UNREACHABLE with the first error; after a page opened, one is a blip. */
        if (!firstUnanswered) firstUnanswered = navError || url + ": no response";
        if (++unansweredInARow >= 2 && !report.pages_opened) break;
        continue;
      }
      unansweredInARow = 0;
      const why = await isBlocked(resp);
      if (stuck) { report.pages_failed++; report.errors.push(url + ": " + stuck); continue; }
      if (why) {
        report.blocked.count++; if (report.blocked.examples.length < 3) report.blocked.examples.push(url + " (" + why + ")");
        report.pages_failed++;
        /* Two blocked pages in a row is the store saying no - stop, do not push on. Also
           after a page opened: the stop used to need pages_opened === 0, so a store that
           served one page and then answered 403/429 (bot management escalating - the adidas
           pattern) was asked for every remaining page and reported "ok", not BLOCKED. */
        if (++refusedInARow >= 2) { report.status = "blocked"; break; }
        continue;
      }
      refusedInARow = 0;
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      /* A page that navigates while it is read (a geo/locale redirect after load, a crashed
         renderer: Playwright's "Unable to retrieve content because the page is navigating")
         is a failed page, like a failed goto. It used to throw out of the whole run and take
         the static stage's charts with it. */
      await bounded(() => page.evaluate(MARK_HIDDEN_GRIDS)).catch(() => 0);   // see chartsFromHtml's inGuide
      const pdpHtml = await bounded(() => page.content()).catch((e) => { report.errors.push(url + ": " + errText(e)); return null; });
      if (pdpHtml == null) { report.pages_failed++; continue; }
      report.pages_opened++;
      const pdpContext = pageContextText(new JSDOM(stripStyles(pdpHtml), { url }).window.document, url);
      add(chartsFromHtml(pdpHtml, url, JSDOM, { source: "browser_page", productUrl: url }), url);

      /* A TRIGGER THAT NAVIGATES (review, 2026-10-07). The marks are attributes in the live
         document; a guide LINK (<a href="/pages/fit-guide">) navigates, and goBack() loads a
         NEW document (Chromium here keeps no back/forward cache) - every later trigger's
         [data-pear-trigger] matched nothing, timed out, and the real modal button after the
         link was never opened. Triggers that leave the page are clicked LAST, the marks are
         re-made after each goBack (a trigger found again by label, tag and position among
         its namesakes), and both navigations are paced like any other.
         THE WAY BACK IS A REQUEST TOO (review, 2026-10-11): goBack() reloads the product page
         from the store (a no-store page is asked again), and its answer was discarded - outside
         the guide's window, so the listener never saw it either. A 403/429 or a challenge there
         went uncounted: the page's next trigger was looked for on the refusal page ("not found
         again"), the next product was asked as if nothing had refused, and on the last product
         the run ended 'ok' - "JS GUIDE NOT OPENED". It is the guide refused now (counted, no
         further guide clicked) and a refusal in a row, like a refused product navigation: the
         next product refusing too stops the run. A goBack with no response (nothing re-asked)
         is not checked. */
      const backFromGuide = async () => {
        const back = await page.goBack({ timeout: navTimeoutMs }).catch(() => null);
        const why = back ? await isBlocked(back) : null;
        if (!why) return false;
        refuseGuide(url, why + ", reloading the product page after its guide link");
        refusedInARow++;
        return true;
      };
      const marked = await bounded(() => page.evaluate(MARK_TRIGGERS)).catch(() => []);
      const nthOf = (list, t) => list.filter((x) => x.label === t.label && x.tag === t.tag).indexOf(t);
      const triggers = marked.filter((t) => isSizeGuideTriggerLabel(t.label))
        .map((t) => ({ ...t, nth: nthOf(marked, t), away: leavesPage(t, url) }))
        .sort((a, b) => a.away - b.away)
        .slice(0, guideRefused ? 0 : maxTriggers);
      vlog(`${url}: ${marked.length} size-ish element(s), ${triggers.length} trigger(s): ${triggers.map((t) => t.tag + " " + JSON.stringify(t.label.slice(0, 40))).join(", ")}`);
      for (let k = 0; k < triggers.length; k++) {
        const t = triggers[k];
        if (guideRefused || stuck) break;
        if (!t.id) continue;   // not found again after a goBack
        const before = page.url();
        if (t.away) await sleep(delayMs);
        await bounded(() => page.evaluate(REMEMBER_VISIBLE_IMAGES)).catch(() => 0);
        await bounded(() => page.evaluate(REMEMBER_VISIBLE_GRIDS)).catch(() => 0);
        if (stuck) break;
        lastTrigger = t.label;
        const refText = pdpContext + " | " + t.label;
        let readings = 0, imagesShown = 0;
        guideWindow = true;
        try {
          await page.locator(`[data-pear-trigger="${t.id}"]`).first().click({ timeout: 4000 });
          report.triggers_clicked++;
        } catch (e) { guideWindow = false; vlog("click failed: " + String(e.message).split("\n")[0]); continue; }
        await page.waitForTimeout(1200).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        const modalHtml = await bounded(() => page.content()).catch(() => "");
        guideWindow = false;
        if (stuck) break;
        const navigated = page.url() !== before;
        /* A challenge page a guide LINK landed on is the store refusing us only on the store's
           own host - a third-party sizing page's challenge is not (the listener's rule). */
        if (navigated && onStoreHost(page.url()) && modalHtml && looksLikeBotChallenge({ text: modalHtml, contentType: "text/html" })) refuseGuide(page.url(), "bot challenge page");
        if (guideRefused) {
          if (navigated) await backFromGuide();
          break;
        }
        if (modalHtml) readings += add(chartsFromHtml(modalHtml, page.url(), JSDOM, { source: "browser_modal", productUrl: url, referrerText: refText }), url);
        const tabs = (await bounded(() => page.evaluate(MARK_TABS)).catch(() => [])).filter((tab) => !NEVER_CLICK_RE.test(tab.label));
        for (const tab of tabs) {
          /* A TAB's own request refused is the guide refused (review, 2026-10-11): the loop only
             stopped on a stuck page, so every remaining tab (up to 10) asked the refusing
             endpoint again - and was counted again. */
          if (stuck || guideRefused) break;
          guideWindow = true;
          try {
            await page.locator(`[data-pear-tab="${tab.id}"]`).first().click({ timeout: 3000 });
            report.tabs_clicked++;
            await page.waitForTimeout(700);
            readings += add(chartsFromHtml(await bounded(() => page.content()), page.url(), JSDOM, { source: "browser_modal", productUrl: url, referrerText: refText }), url);
          } catch { /* a tab that will not click is skipped */ } finally { guideWindow = false; }
        }
        for (const src of await bounded(() => page.evaluate(COLLECT_CHART_IMAGES)).catch(() => [])) {
          imagesShown++;
          /* Every product page an image was seen on is kept: a store's one guide image opened
             from six PDPs used to be tagged with the FIRST page only - product-scoped forever,
             so the room (which serves product_key '') never used it. */
          const prev = images.find((i) => i.url === src);
          if (prev) { if (!prev.pages.includes(url)) prev.pages.push(url); }
          else images.push({ url: src, productUrl: url, pages: [url], context: refText });
        }
        /* The guide OPENED (a table the click made visible), the parser read nothing from
           it and no chart image appeared: a size-CONVERSION table (factory54: SIZE | FR |
           IT | UK | US | JEANS) with no body measurement. Correctly not a chart - but it is
           a different answer from "could not open the guide", so it is counted. */
        if (readings === 0 && imagesShown === 0) {
          const grids = await bounded(() => page.evaluate(NEW_VISIBLE_GRIDS)).catch(() => 0);
          if (grids > 0) {
            report.unmeasured_guides++;
            if (report.unmeasured_examples.length < 2) report.unmeasured_examples.push(url);
          }
        }
        if (stuck) break;
        if (navigated) {
          await sleep(delayMs);
          if (await backFromGuide()) break;
          const again = await bounded(() => page.evaluate(MARK_TRIGGERS)).catch(() => []);
          for (const r of triggers.slice(k + 1)) {
            const m = again.filter((x) => x.label === r.label && x.tag === r.tag)[r.nth];
            r.id = m ? m.id : "";
          }
        } else {
          await bounded(() => page.keyboard.press("Escape")).catch(() => {});
          await page.waitForTimeout(300).catch(() => {});
        }
      }
      if (stuck) report.errors.push(url + ": " + stuck);
      await page.waitForTimeout(500).catch(() => {});   // let in-flight response bodies land
      vlog(`${payloads.length} size payload(s): ${payloads.map((p) => p.url.slice(0, 80)).join(" | ")}`);
      for (const p of payloads.splice(0)) {
        if (p.gen !== pageGen) continue;   // a late response from an earlier page
        report.network_payloads++;
        add(chartsFromNetworkBody(p.text, p.url, url, JSDOM, url, pdpContext + (p.trigger ? " | " + p.trigger : "")), url);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  /* One refusal with nothing opened (the in-a-row stop above needs two) is still BLOCKED -
     and so is a refused guide request when no chart was KEPT. A refusal outranks a page that
     never answered: "unreachable" means nothing refused us.
     THE BUG THIS CLOSES (review, 2026-10-11): "no chart read" was `!found.length` - RAW
     readings - so a lone untyped "Suits" table on the PDP (buildRecords never stores it) kept a
     refused guide 'ok', and the run said "JS GUIDE NOT OPENED ... open it yourself" (F35's
     symptom, the raw-vs-kept mistake capture.js had just fixed for the static stage). It is
     judged on what buildRecords would keep (a throwaway report, nothing counted twice). */
  if (report.status === "ok" && report.pages_opened === 0 && report.blocked.count) report.status = "blocked";
  if (report.status === "ok" && guideRefused && !buildRecords(found, host, { charts: [], conflicts: [] }).length) report.status = "blocked";
  if (report.status === "ok" && report.pages_opened === 0 && firstUnanswered) {
    report.status = "unreachable";
    report.errors = [firstUnanswered, ...report.errors.filter((e) => e !== firstUnanswered)];
  }
  if (report.status === "ok" && noProducts) report.status = "no_products";
  log(`  browser: ${report.pages_opened} page(s) opened, ${report.triggers_clicked} trigger(s) + ${report.tabs_clicked} tab(s) clicked, ` +
    `${report.network_payloads} size payload(s), ${found.length} chart reading(s), ${images.length} chart image(s)` +
    (report.blocked.count ? `, BLOCKED ${report.blocked.count}x` : "") +
    (report.status === "unreachable" ? `, UNREACHABLE - no answer: ${report.errors[0]}` : "") +
    (report.status === "no_products" ? `, no product page to open${report.errors[0] && report.errors[0].startsWith("home: ") ? " (" + report.errors[0] + ")" : ""}` : ""));
  return { found, images, report };
}
