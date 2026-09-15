#!/usr/bin/env node
/* =============================================================================
   PEAR - Store Scanner
   -----------------------------------------------------------------------------
   Standalone crawler (runs on Railway, independent of the main PEAR server).
   Crawls a storefront, finds every product page, collects garment images, and
   classifies each one as front/back AND kids/adult (age_group) via Gemini in a
   single call - caching results in Supabase's garment_cache table so repeat
   scans never re-classify the same image.

   No browser involved. Shopify stores (detected via a "Shopify"/"shopify"
   substring on the homepage) are scanned through the /products.json catalog
   API - every product and its full image list, paginated, no page-by-page
   scraping needed. Everything else falls back to fetching each product page
   as plain HTML and pulling image URLs out with regex (schema.org JSON-LD
   Product.image, <meta property="og:image" content>, and <img src> /
   data-src / data-lazy outside the page's <header>/<nav>/<footer> - see
   findProductImages()). This
   works on any host with no Chrome/Chromium install (Railway's Nix-based
   Chromium install proved unreliable) - the tradeoff on the HTML-scrape path
   is that images injected purely by client-side JavaScript after page load
   won't be found, since the HTML is never rendered.

   Usage:
     node scan-store.js https://fox.co.il
   ============================================================================= */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
// Node.js 20+ has built-in fetch - no node-fetch dependency needed.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!GEMINI_API_KEY) {
  console.error("✗ GEMINI_API_KEY is not set - copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set - copy .env.example to .env and fill them in.");
  process.exit(1);
}

const storeUrl = process.argv[2];
if (!storeUrl) {
  console.error("Usage: node scan-store.js <store-url>");
  console.error("Example: node scan-store.js https://fox.co.il");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { enabled: false },
  global: {
    headers: {},
  },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
const GEMINI_RATE_LIMIT_MS = 8000; // delay between sequential Gemini calls - free tier is 15 req/min

const PRODUCT_LINK_PATTERNS = ["/products/", "/product/", "/item/", "/p/", "/shop/"];
const EXCLUDE_IMG_SRC = ["logo", "icon", "sprite", "placeholder", "banner", "avatar"];
const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; PEAR-StoreScanner/1.0)";

/* ── helpers ─────────────────────────────────────────────────────────────── */

function isExcludedSrc(src) {
  const s = (src || "").toLowerCase();
  return isVectorSrc(s) || EXCLUDE_IMG_SRC.some((needle) => s.includes(needle));
}

/* SVG is UI - icons, arrows, wishlist hearts - never a garment photo, and Gemini cannot
   classify one. Path only, so a raster whose query string mentions ".svg" is kept.
   Mirrors isVectorSrc() in widget/pear-widget.js. */
function isVectorSrc(url) {
  const s = String(url || "");
  return /^data:image\/svg/i.test(s) || /\.svgz?$/i.test(s.split(/[?#]/)[0]);
}

function isProductLink(href) {
  if (!href) return false;
  const lower = href.toLowerCase();
  return PRODUCT_LINK_PATTERNS.some((p) => lower.includes(p));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const resp = await fetch(url, { headers: { "User-Agent": FETCH_USER_AGENT } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

/* Pull a single attribute's value out of a raw HTML tag string, e.g.
   extractAttr('<img src="a.jpg">', 'src') -> "a.jpg". */
function extractAttr(tag, attr) {
  const re = new RegExp(attr + "\\s*=\\s*[\"']([^\"']+)[\"']", "i");
  const m = tag.match(re);
  return m ? m[1] : "";
}

/* Highest-resolution entry out of a srcset. Lockstep with largestFromSrcset() in
   widget/pear-widget.js (CLAUDE.md §3) - same parse, same tie-breaking.

   THE GAP THIS CLOSES: the <img> sweep below read only data-src/data-lazy/src. On a
   lazy gallery - which is every storefront where the back photo lives on an off-screen
   slide - `src` is a 1x1 placeholder and the real URLs are in `srcset`, so the crawler
   walked away with the front photo (or nothing) and garment_cache was never populated
   for that product.

   Candidates are separated on WHITESPACE, not on commas: a URL may legally CONTAIN
   commas, and Cloudinary-style CDNs (assets.adidas.com) always do -
   "/images/w_1880,f_auto,q_auto/<hash>/tee.jpg". Splitting on "," tears each candidate
   into fragments and yields truncated or relative junk that 404s. */
function largestFromSrcset(value) {
  if (!value) return "";
  const s = String(value), n = s.length;
  let i = 0, bestUrl = "", bestWeight = -1;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;           // separators from the previous candidate
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(s[i])) i++;             // the URL - commas inside it are KEPT
    let url = s.slice(start, i), descriptor = "";
    if (/,$/.test(url)) {
      url = url.replace(/,+$/, "");                    // trailing comma = no descriptor
    } else {
      while (i < n && /\s/.test(s[i])) i++;
      const dStart = i;
      while (i < n && s[i] !== ",") i++;
      descriptor = s.slice(dStart, i).trim();
      i++;                                             // consume the separating comma
    }
    if (!url) continue;
    const d = descriptor.split(/\s+/)[0] || "";
    let weight = 0;
    if (/^[\d.]+w$/i.test(d))      weight = parseFloat(d);
    else if (/^[\d.]+x$/i.test(d)) weight = parseFloat(d) * 1000;
    if (weight > bestWeight) { bestWeight = weight; bestUrl = url; }
  }
  return bestUrl;
}

/* Every <a> tag's href that matches a product-page pattern, de-duplicated and
   normalized to absolute URLs. */
function findProductLinks(html, baseUrl) {
  const aTags = html.match(/<a\b[^>]*>/gi) || [];
  const seen = new Set();
  const links = [];
  for (const tag of aTags) {
    const href = extractAttr(tag, "href");
    if (!href || !isProductLink(href)) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
  }
  return links;
}

/* Every garment image a product page's raw HTML references, best-first:
     1. schema.org JSON-LD Product.image - the product's own photo list, emitted by
        every major platform for Google Shopping. Used only when the page describes
        exactly ONE product (see jsonLdProductImages()).
     2. <meta property="og:image" content="...">
     3. <img> tags OUTSIDE the site chrome (<header>/<nav>/<footer> blocks are cut from
        the HTML first - stripChrome()), reading data-src / data-lazy (Slick's lazy
        attribute) / src - lazy themes swap those into src via JS, so pre-render the
        real image only lives there.
   SVGs are dropped (isExcludedSrc -> isVectorSrc), and one photo under several URL
   spellings (?sw=100 thumbnail vs ?sw=600 slide) is kept once, by canonical identity.
   THE BUG THIS CLOSES: the sweep took EVERY <img> on the page - mega-menu wallpapers,
   payment badges, wishlist hearts, social icons - filtered only by a filename
   substring list, and each one went to Gemini and was cached into garment_cache as a
   "front"/"back" row. Same line the widget draws in the browser (pear-widget.js
   isChromeImage / isVectorSrc / jsonLdProductImages). Without rendering the page there
   is still no naturalWidth/naturalHeight to filter on. */
function findProductImages(html, baseUrl) {
  const urls = [...jsonLdProductImages(html)];

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (/property\s*=\s*["']og:image["']/i.test(tag)) {
      const content = extractAttr(tag, "content");
      if (content) urls.push(content);
    }
  }

  const imgTags = stripChrome(html).match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    /* Explicit full-size lazy attributes first, then srcset (the real URLs on a lazy
       gallery), and the rendered src LAST - it is the most likely to be a placeholder
       or a thumbnail. Mirrors imageUrlsFrom()'s ordering in pear-widget.js. */
    const src = extractAttr(tag, "data-src")
             || extractAttr(tag, "data-lazy")
             || largestFromSrcset(extractAttr(tag, "srcset"))
             || largestFromSrcset(extractAttr(tag, "data-srcset"))
             || extractAttr(tag, "src");
    if (src) urls.push(src);
  }

  const seen = new Set();
  const images = [];
  for (const raw of urls) {
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    if (isExcludedSrc(abs)) continue;
    const key = canonicalImageUrl(abs) || abs;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(abs);
  }
  return images;
}

/* The page with its site chrome cut out - HTML comments and <header>, <nav>, <footer>
   blocks - so the <img> sweep only sees the content area: a product photo never lives
   in the site header, navigation or footer (adidas.co.il ships 1200px mega-menu
   wallpapers inside <nav>). Non-greedy per block, so no nested quantifier to backtrack
   on. A <header> inside <article> goes too - the price of having no DOM; JSON-LD and
   og:image still cover that page's main photo. */
function stripChrome(html) {
  let out = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["header", "nav", "footer"]) {
    out = out.replace(new RegExp("<" + tag + "\\b[\\s\\S]*?<\\/" + tag + ">", "gi"), " ");
  }
  return out;
}

/* schema.org JSON-LD Product.image out of raw HTML. Only Product-typed nodes (an
   Organization/WebSite node's image is the store LOGO), never descending into a
   product's offers/variants (other colourways' photos), and [] unless the page
   describes exactly ONE product - counted by name/sku, so a review app repeating the
   theme's Product block is still one, while a listing page's per-card Products are
   not. Mirrors jsonLdProductImages() in widget/pear-widget.js. */
const PRODUCT_LD_TYPE_RE = /^(?:Product|ProductGroup|IndividualProduct|ProductModel)$/;
function jsonLdProductImages(html) {
  const blocks = String(html || "")
    .match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const ids = new Set();
  const images = [];
  let anon = 0;
  const isProduct = (n) => [].concat(n["@type"]).some(
    (t) => typeof t === "string" && PRODUCT_LD_TYPE_RE.test(t.replace(/^.*[/:#]/, "")));
  const addImage = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(addImage); return; }
    if (typeof v === "object") { addImage(v.contentUrl || v.url); return; }
    if (typeof v === "string") images.push(v);
  };
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 5) return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, depth + 1)); return; }
    if (isProduct(n)) {
      ids.add(String(n.name || n.sku || n.productID || n["@id"] || "").trim().toLowerCase() || ("#" + anon++));
      addImage(n.image);
      return;
    }
    if (n["@graph"]) walk(n["@graph"], depth + 1);
    if (n.mainEntity) walk(n.mainEntity, depth + 1);
  };
  for (const block of blocks) {
    const json = block.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    try { walk(JSON.parse(json), 0); } catch { /* malformed block - skip it */ }
  }
  return ids.size === 1 ? images : [];
}

/* ── Supabase cache ──────────────────────────────────────────────────────── */

/* Canonical cache key - MUST match canonicalImageUrl() in server.js and
   pear_canonical_url() in archive/supabase_setup_v9.sql. Keying on the raw image_url
   is what let one photograph occupy several rows under different URL spellings, which
   then disagreed about front vs back. */
const RESIZER_RE = /\/(?:_next\/image|cdn-cgi\/image|_vercel\/image|imgproxy|thumbor|resize)\b|[?&]url=/i;

/* ── CDN transforms encoded as a PATH SEGMENT ──────────────────────────────────
   Cloudinary-style CDNs put the rendered size in the PATH, not the query string.
   assets.adidas.com serves every gallery photo that way:
      /images/w_280,h_280,f_auto,q_auto:sensitive/<hash>/tee.jpg   ← thumbnail
      /images/w_1880,f_auto,q_auto/<hash>/tee.jpg                  ← zoom slide
   Those are ONE photograph, but PRESENTATION_PARAMS only strips QUERY params, so a
   crawl wrote the same photo to garment_cache several times under different
   canonical_urls - the duplicate-row problem this cache key exists to prevent, and the
   way one photo ends up classified BOTH front and back.

   Deliberately NARROW: a segment is dropped only when every comma-separated token is
   "<short alphabetic key>_<value>" and at least one key is a known sizing/format key,
   and never the LAST segment, which is the filename ("w_940.jpg" is a file, not a
   transform). Lockstep with upgradeImageUrl() in pear-widget.js and canonicalImageUrl()
   in fitting-room/app.js and server.js (CLAUDE.md §3).

   Defined INSIDE canonicalImageUrl so the block stays self-contained when a test
   slices it out of this file and runs it standalone (CLAUDE.md §2.6), and so all four
   copies of this logic stay structurally identical. */

const PRESENTATION_PARAMS = new Set([
  "width", "height", "w", "h", "size", "quality", "q", "dpr", "format", "fm",
  "crop", "fit", "scale", "v", "ver", "version", "t", "cache", "_",
  // Salesforce Commerce Cloud Dynamic Imaging (.../dw/image/v2/...): box, scale mode,
  // output format, letterbox colour - adidas.co.il's thumbnail and zoom slide of ONE
  // photo differ only in these. Lockstep with pear-widget.js PRESENTATION_PARAMS.
  "sw", "sh", "sm", "sfrm", "bgcolor",
]);

function canonicalImageUrl(url, depth = 0) {
  const CDN_TRANSFORM_KEY_RE = /^(?:w|h|c|q|f|dpr|ar|g|e|b|o|fl|bo|co|cs|r)$/;
  const isCdnTransformSegment = (seg) => {
    if (!seg || !seg.includes("_")) return false;
    const tokens = seg.split(",");
    let sizing = false;
    for (const token of tokens) {
      const m = /^([a-z]{1,3})_([a-z0-9:.%*+-]+)$/i.exec(token);
      if (!m) return false;
      const key = m[1].toLowerCase();
      if (!CDN_TRANSFORM_KEY_RE.test(key)) return false;
      if (/^(?:w|h|c|dpr)$/.test(key)) sizing = true;
    }
    return sizing || tokens.length > 1;
  };
  /* Accepts a full URL or a bare pathname; query/hash are split off untouched so a
     transform-looking token in a query string is never mistaken for a path segment. */
  const stripCdnTransformPath = (u2) => {
    const m = /^([^?#]*)([\s\S]*)$/.exec(String(u2 || ""));
    const parts = m[1].split("/");
    return parts.filter((seg, i) => !(i < parts.length - 1 && isCdnTransformSegment(seg))).join("/") + m[2];
  };
  if (!url || typeof url !== "string") return "";
  if (/^(data:|blob:)/i.test(url)) return url;
  if (RESIZER_RE.test(url) && depth < 3) {
    const m = /[?&]url=([^&]+)/i.exec(url);
    if (m) {
      let inner = m[1];
      try { inner = decodeURIComponent(inner); } catch {}
      try { inner = new URL(inner, url).toString(); } catch {}
      return canonicalImageUrl(inner, depth + 1);
    }
    return url.toLowerCase();
  }
  let u;
  try { u = new URL(url); } catch { return url.split("?")[0].toLowerCase(); }
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (PRESENTATION_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.pathname = stripCdnTransformPath(u.pathname)
    .replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d{1,4}x(?:\d{1,4})?)(?:_crop_[a-z]+)?(?=\.(?:jpe?g|png|webp|gif)$)/i, "")
    .replace(/-(\d{2,3})x(\d{2,3})(?=\.(?:jpe?g|png|webp|gif)$)/i, (m, a, b) =>
      (parseInt(a, 10) <= 600 && parseInt(b, 10) <= 600) ? "" : m);
  return u.toString().toLowerCase();
}

async function getCachedClassification(imageUrl) {
  let { data, error } = await supabase
    .from("garment_cache")
    .select("classification")
    .eq("canonical_url", canonicalImageUrl(imageUrl))
    .limit(1)
    .maybeSingle();
  if (error && /column .* does not exist|Could not find the/i.test(error.message || "")) {
    ({ data, error } = await supabase
      .from("garment_cache")
      .select("classification")
      .eq("image_url", imageUrl)
      .limit(1)
      .maybeSingle());
  }
  if (error) {
    console.warn(`  ⚠ garment_cache read failed: ${error.message}`);
    return null;
  }
  return data ? data.classification : null;
}

const MISSING_COLUMN_RE = /column .* does not exist|Could not find the/i;

/* Writes the verdict WITH its provenance (see archive/supabase_setup_v8.sql for what
   each `source` value means) and the kids/adult verdict added in v11
   (archive/supabase_setup_v11.sql). Degrades one migration tier at a time - v11
   columns missing falls back to the v8 shape, v8 columns missing falls back to the
   bare v5 shape - so this scanner is safe to deploy before either SQL has run. */
async function saveClassification(imageUrl, classification, meta = {}) {
  const base = { image_url: imageUrl, classification };
  const canonical = { canonical_url: canonicalImageUrl(imageUrl) };   // one row per PHOTOGRAPH, not per URL
  const v8Fields = {
    confidence: Number.isFinite(meta.confidence) ? meta.confidence : null,
    source: meta.source || "gemini",
    cue: meta.cue || null,
    product_url: meta.productUrl || null,
  };
  const v11Fields = {
    age_group: meta.ageGroup || null,
    age_group_confidence: Number.isFinite(meta.ageGroupConfidence) ? meta.ageGroupConfidence : null,
  };

  let { error } = await supabase.from("garment_cache")
    .upsert([{ ...base, ...canonical, ...v8Fields, ...v11Fields }], { onConflict: "canonical_url" });
  /* THE BUG THIS CLOSES (2026-09): production ran V9 (canonical_url) and V11
     (age_group/age_group_confidence) WITHOUT V8 (confidence/source/cue/product_url)
     ever having been migrated onto garment_cache - see the commit that added
     scanner/backfill-age-group.js, which had to hand-confirm the live column list
     via information_schema because v8Fields kept getting every UPDATE rejected.
     The old ladder dropped v11Fields FIRST and only tried dropping v8Fields as the
     last resort before the bare `base` row - on a table missing ONLY v8, that order
     means every tier fails and age_group is silently dropped from every scan write,
     not just until the next migration runs. Try the v8-less shape first, since
     that is production's actual state. */
  if (error && MISSING_COLUMN_RE.test(error.message || "")) {
    console.warn("  ⚠ garment_cache a column is absent - trying without v8 fields (confidence/source/cue/product_url)");
    ({ error } = await supabase.from("garment_cache")
      .upsert([{ ...base, ...canonical, ...v11Fields }], { onConflict: "canonical_url" }));
  }
  if (error && MISSING_COLUMN_RE.test(error.message || "")) {
    console.warn("  ⚠ garment_cache v11 columns absent - run archive/supabase_setup_v11.sql for kids/adult classification");
    ({ error } = await supabase.from("garment_cache")
      .upsert([{ ...base, ...canonical, ...v8Fields }], { onConflict: "canonical_url" }));
    if (error && MISSING_COLUMN_RE.test(error.message || "")) {
      console.warn("  ⚠ garment_cache V8 columns absent - run archive/supabase_setup_v8.sql");
      ({ error } = await supabase.from("garment_cache").upsert([base], { onConflict: "image_url" }));
    }
  }
  if (error) console.warn(`  ⚠ garment_cache write failed: ${error.message}`);
}

/* ── Gemini classification ───────────────────────────────────────────────── */

async function fetchImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer.toString("base64");
}

/* ── Strict front/back + kids/adult system prompt ───────────────────────────────
   MUST STAY IN LOCKSTEP with FRONT_BACK_SYSTEM_PROMPT in server.js (both the view
   cues AND the age_group cues below). The scanner is a standalone package (own
   package.json, deployed separately to Railway) so it cannot import from the main
   server - but both write to the SAME garment_cache table, so a drift between the
   two prompts means the crawl and the live widget disagree about which photo is
   the back of the same product, or about whether a garment is kids'/adult.

   The prompt this replaces ended with "answer with exactly one word: front or
   back" and no guidance at all, so every ambiguous rear shot - angled, cropped,
   lifestyle - resolved to whichever word the model reached for first. See
   archive/BACK-VIEW-DIAGNOSTICS.md §2 for why that reads downstream as a garment
   with no back view. */
const FRONT_BACK_SYSTEM_PROMPT = `You are a garment-orientation classifier for a virtual try-on pipeline. You decide which SIDE of a garment a product photograph shows.

Judge the GARMENT, not the photo's role in the gallery. Never reason about whether an image "looks like the main product shot" - primary/secondary ordering is a merchandising choice and carries no information about orientation.

If a person is wearing the garment, their body orientation is the strongest signal available:
- Face, eyes or front torso visible toward the camera -> the garment's FRONT.
- Back of the head, nape of the neck, or shoulder blades toward the camera -> the garment's BACK.

DECISIVE FRONT cues (each appears only on the front):
- Buttons, button placket, full-length zipper closure, snaps, tie closure
- Chest pocket, breast logo, front graphic or lettering read the right way round
- V-neck, scoop or crew neckline seen as an open curve (the neck opening faces you)
- Front fly, coin pocket, belt loops seen with the fly
- Bra cups, front cutouts, wrap-front overlap

DECISIVE BACK cues (each appears only on the back):
- Centre-back seam running vertically down the panel
- Back yoke (a horizontal seam across the upper back)
- Rear neckline as a shallow, closed curve with the collar standing away from you
- Sewn-in neck label / size tag visible on the inside of the rear collar
- Back graphic, player name/number, spine lettering
- Rear pockets on trousers, back darts, a back vent on a jacket or coat
- Back zipper on a dress (short, upper-centre) or a rear keyhole/cutout

TRICKY CASES - follow these exactly:
- Neck label visible = BACK. A sewn label sits at the rear collar; this cue outranks a partially visible neckline.
- Side or 3/4 profile: decide by which cues you can actually SEE. If decisive cues from one side are visible, answer that side. If neither is legible, answer "uncertain".
- Flat-lay / packshot with no model: use the seam and closure cues above.
- Close-up detail / fabric macro / accessory-only shot with no orientation cue: answer "uncertain".
- Folded garment, hanger shot from the side, or a photo where the garment is mostly occluded: answer "uncertain".
- Do NOT guess. "uncertain" is a correct, useful answer; a wrong "front" makes a real rear photo unusable, and a wrong "back" makes the try-on render the wrong side.

Report confidence honestly:
- 0.9-1.0  one or more decisive cues, clearly legible
- 0.7-0.89 one decisive cue, partially occluded or low resolution
- below 0.7 inference from weak cues only -> you must answer "uncertain"

SEPARATELY, also classify whether this is a KIDS' garment or an ADULT garment -
this is about the PRODUCT, not the photo's orientation, so judge it independently
of your front/back answer above.

DECISIVE KIDS cues:
- A child or infant is wearing the garment (judge by body/face proportions and
  height relative to any visible surroundings, not by clothing style alone -
  petite adult sizing exists and is NOT kids' clothing)
- A visible size label/tag using child sizing (e.g. "2T", "4Y", "Age 8", "110cm",
  "XS Kids", a EU/IL kids numeric size like 8-18 on a size chart)
- Snap-crotch or grow-with-me adjustable waistband construction (bodysuits,
  rompers) - these do not exist in adult sizing
- Character licensing, cartoon prints, or a garment scaled small enough that
  ordinary adult proportions (shoulder width, torso length, sleeve/inseam ratio)
  are visibly impossible

DECISIVE ADULT cues:
- An adult is wearing the garment (adult body/face proportions)
- A visible size label using adult sizing (S/M/L/XL/XXL, numeric waist/chest in
  cm or inches typical of adult garments, EU 36-52 etc.)
- Tailoring, cut, or proportions only found in adult clothing (structured
  blazers, adult-length trousers with a standard rise, underwire, adult-scale
  formalwear)

TRICKY CASES - follow these exactly:
- Flat-lay / packshot with NO model and NO visible size label: judge PURELY by
  the garment's own scale and cut cues above. If the garment could plausibly be
  either a petite adult's item or an older child's/teen's item with no other
  cue to separate them, answer "uncertain" - do not guess from styling alone.
- A youth/teen-cut garment that could span either chart (a typical concern
  around EU kids size 16-18 / adult XS-S): answer "uncertain" rather than
  picking one, unless a size label or a visibly child-proportioned wearer
  settles it.
- Do NOT infer age group from color, print style, or price positioning alone
  ("cute" prints and pastel colors exist in adult fashion too).

Report age_group confidence honestly using the SAME bands as view confidence
above; below 0.7 you must answer "uncertain".

Respond ONLY with JSON matching this schema:
{"view":"front"|"back"|"uncertain","confidence":0.0-1.0,"cue":"<the single cue that decided it, max 12 words>","age_group":"kids"|"adult"|"uncertain","age_group_confidence":0.0-1.0}`;

/** @returns {Promise<{view:"front"|"back"|"uncertain", confidence:number, cue:string, age_group:"kids"|"adult"|"uncertain", age_group_confidence:number}>} */
async function classifyFrontBack(imageUrl) {
  const base64 = await fetchImageAsBase64(imageUrl);
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: FRONT_BACK_SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
            { text: "Classify which side of the garment this photograph shows." },
          ],
        },
      ],
      // temperature 0 + a response schema: the crawl and the live widget must reach
      // the same verdict for the same photo, and JSON removes the old
      // answer.includes("back") trap (which also matched "not the back").
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            view:                 { type: "STRING", enum: ["front", "back", "uncertain"] },
            confidence:           { type: "NUMBER" },
            cue:                  { type: "STRING" },
            age_group:            { type: "STRING", enum: ["kids", "adult", "uncertain"] },
            age_group_confidence: { type: "NUMBER" },
          },
          required: ["view", "confidence", "age_group", "age_group_confidence"],
        },
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Gemini ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    err.rateLimited = resp.status === 429;
    throw err;
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { view: "uncertain", confidence: 0, cue: "unparseable response", age_group: "uncertain", age_group_confidence: 0 };
  }
  const view = ["front", "back", "uncertain"].includes(parsed?.view) ? parsed.view : "uncertain";
  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  const ageGroup = ["kids", "adult", "uncertain"].includes(parsed?.age_group) ? parsed.age_group : "uncertain";
  const ageGroupConfidence = Number.isFinite(parsed?.age_group_confidence)
    ? Math.max(0, Math.min(1, parsed.age_group_confidence)) : 0;
  return {
    view, confidence, cue: typeof parsed?.cue === "string" ? parsed.cue.slice(0, 120) : "",
    age_group: ageGroup, age_group_confidence: ageGroupConfidence,
  };
}

/* Gemini's free tier is 15 requests/minute - even the 8s inter-request delay
   below can trip a 429 occasionally. On a 429, wait 60s and retry once.

   THE CACHE-POISONING FIX: this used to `return "front"` on exhaustion, and the
   caller then WROTE that to garment_cache - permanently, and indistinguishably
   from a real verdict. Every subsequent scan and every live widget call read that
   row as "this photo is the front", so a genuine rear photo throttled out during
   one crawl became invisible to the whole product forever. The failure is now
   returned as a distinct `fallback` record which the caller refuses to cache. */
async function classifyWithRetry(imageUrl, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      return await classifyFrontBack(imageUrl);
    } catch (e) {
      if (e.rateLimited && i < retries - 1) {
        console.log("Rate limited - waiting 60s...");
        await sleep(60000);
      } else {
        console.warn(`  ⚠ classification ${e.rateLimited ? "RATE LIMITED" : "failed"} - not cached: ${e.message}`);
        return { view: "uncertain", confidence: 0, cue: e.message.slice(0, 120), fallback: true };
      }
    }
  }
  return { view: "uncertain", confidence: 0, cue: "retries exhausted", fallback: true };
}

/* ── Shopify JSON catalog ─────────────────────────────────────────────────────
   Shopify storefronts expose every product (with its full image list) at
   /products.json - paginated, 250/page - so a Shopify store never needs its
   product pages scraped at all. Detected via a plain substring check on the
   homepage HTML for "Shopify"/"shopify" (the theme's asset URLs, the
   Shopify.shop JS global, etc. reliably contain it). */
async function scanShopify(baseUrl) {
  const allImages = [];
  let productCount = 0;
  let page = 1;

  while (true) {
    const url = `${baseUrl}/products.json?limit=250&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) break;

    const data = await res.json();
    if (!data.products || data.products.length === 0) break;

    productCount += data.products.length;
    for (const product of data.products) {
      for (const image of product.images || []) {
        if (image.src) {
          allImages.push({
            url: image.src,
            productTitle: product.title,
            // Groups a product's photos in garment_cache so "which products have
            // ZERO back images" is a one-query answer (D1 in supabase_setup_v8.sql)
            // instead of a regex over CDN filenames.
            productUrl: product.handle ? `${baseUrl}/products/${product.handle}` : null,
          });
        }
      }
    }

    if (data.products.length < 250) break;
    page++;
    await new Promise((r) => setTimeout(r, 500));
  }

  return { images: allImages, productCount };
}

/* ── classification tally (shared by both crawl paths) ──────────────────── */

async function classifyAndTally(imageUrl, index, counters, total, productUrl) {
  try {
    let classification = await getCachedClassification(imageUrl);
    let cached = !!classification;

    if (!classification) {
      console.log(`Classifying image ${index + 1}/${total}...`);
      const rec = await classifyWithRetry(imageUrl);
      // A throttled/failed call is a DEFAULT, not a verdict - counted as skipped and
      // deliberately NOT cached, so the next scan retries it instead of inheriting a
      // fabricated "front" forever (see classifyWithRetry's comment).
      if (rec.fallback) {
        counters.total++;
        counters.skipped++;
        console.log(`Image ${index + 1}: SKIPPED (not cached - will retry next scan)`);
        await sleep(GEMINI_RATE_LIMIT_MS);
        return;
      }
      classification = rec.view === "back" ? "back" : "front";
      if (rec.view === "uncertain") counters.uncertain++;
      await saveClassification(imageUrl, classification, {
        confidence: rec.confidence,
        source: rec.view === "uncertain" ? "uncertain" : "gemini",
        cue: rec.cue,
        productUrl,
        ageGroup: rec.age_group,
        ageGroupConfidence: rec.age_group_confidence,
      });
      await sleep(GEMINI_RATE_LIMIT_MS);
    }

    counters.total++;
    if (cached) counters.cached++;
    if (classification === "back") counters.back++; else counters.front++;

    console.log(`Image ${index + 1}: ${classification}${cached ? " (cached)" : " (new)"}`);
  } catch (err) {
    counters.total++;
    console.warn(`Image ${index + 1}: classification failed - ${err.message}`);
  }

  if (counters.total % 10 === 0) {
    console.log(`Progress: ${counters.total}/${total} images classified`);
  }
}

/* ── main crawl ──────────────────────────────────────────────────────────── */

/* Crawl every product page's HTML and gather a single de-duplicated image
   list (mirrors scanShopify's shape) so classification below has a known
   total up front, for the every-10-images progress log. */
async function scanHtml(homeHtml, baseUrl) {
  const productLinks = findProductLinks(homeHtml, baseUrl);
  console.log(`Found ${productLinks.length} product page(s).\n`);

  const seen = new Set();
  const images = [];
  for (let i = 0; i < productLinks.length; i++) {
    const url = productLinks[i];
    console.log(`Scanning page ${i + 1}/${productLinks.length}: ${url}`);

    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠ failed to load page: ${err.message}`);
      continue;
    }

    const pageImages = findProductImages(html, url);
    console.log(`Found ${pageImages.length} image(s)`);
    for (const img of pageImages) {
      if (seen.has(img)) continue;
      seen.add(img);
      images.push(img);
    }
  }

  return { images, productCount: productLinks.length };
}

async function main() {
  console.log(`Scanning store: ${storeUrl}\n`);

  const counters = { total: 0, front: 0, back: 0, cached: 0, uncertain: 0, skipped: 0 };
  /* image URL → the product page it belongs to. Populated on the Shopify path (the
     catalog API hands us the product handle); the HTML-scrape path has no reliable
     product grouping, so those rows keep product_url NULL and fall back to the
     CDN-id grouping in D1b. */
  const productUrlByImage = new Map();
  const homeHtml = await fetchHtml(storeUrl);
  const isShopify = homeHtml.includes("Shopify") || homeHtml.includes("shopify");

  let images, productCount;
  if (isShopify) {
    console.log("Detected Shopify store - using /products.json catalog API\n");
    const { images: shopifyImages, productCount: count } = await scanShopify(storeUrl);
    productCount = count;

    const seen = new Set();
    images = [];
    for (const item of shopifyImages) {
      let abs;
      try {
        abs = new URL(item.url, storeUrl).href;
      } catch {
        continue;
      }
      if (isExcludedSrc(abs) || seen.has(abs)) continue;
      seen.add(abs);
      images.push(abs);
      if (item.productUrl) productUrlByImage.set(abs, item.productUrl);
    }
    console.log(`Found ${productCount} products with ${images.length} images`);
  } else {
    const result = await scanHtml(homeHtml, storeUrl);
    images = result.images;
    productCount = result.productCount;
    console.log(`\nFound ${productCount} products with ${images.length} images`);
  }

  console.log("Classifying...");
  for (let j = 0; j < images.length; j++) {
    await classifyAndTally(images[j], j, counters, images.length, productUrlByImage.get(images[j]));
  }

  console.log(
    `\nDone. Total: ${counters.total} images | ${counters.front} front | ${counters.back} back | ` +
    `${counters.cached} cached | ${counters.uncertain} uncertain | ${counters.skipped} skipped`
  );
  /* The number that predicts whether the live widget can render a back view at all.
     A crawl that finds almost no backs means the store's rear photos are not being
     collected or not being recognised - see archive/BACK-VIEW-DIAGNOSTICS.md. */
  const classified = counters.front + counters.back;
  if (classified) {
    const pct = ((counters.back / classified) * 100).toFixed(1);
    console.log(`Back-view coverage: ${pct}% (${counters.back}/${classified})`);
    if (counters.back / classified < 0.1) {
      console.warn(
        "⚠ Back-view coverage under 10% - most products will render front-only.\n" +
        "  Run the D0/D1 diagnostics in archive/supabase_setup_v8.sql to tell a catalog\n" +
        "  gap (no rear photos exist) from a classification failure."
      );
    }
  }
  if (counters.skipped) {
    console.warn(`⚠ ${counters.skipped} image(s) skipped (throttled/failed) - NOT cached; re-run to classify them.`);
  }
}

main().catch((err) => {
  console.error("✗ Scan failed:", err?.message || err);
  process.exit(1);
});
