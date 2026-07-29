#!/usr/bin/env node
/* =============================================================================
   PEAR - Store Scanner
   -----------------------------------------------------------------------------
   Standalone crawler (runs on Railway, independent of the main PEAR server).
   Crawls a storefront, finds every product page, collects garment images, and
   classifies each one as front/back via Gemini - caching results in Supabase's
   garment_cache table so repeat scans never re-classify the same image.

   No browser involved. Shopify stores (detected via a "Shopify"/"shopify"
   substring on the homepage) are scanned through the /products.json catalog
   API - every product and its full image list, paginated, no page-by-page
   scraping needed. Everything else falls back to fetching each product page
   as plain HTML and pulling image URLs out with regex (<img src>, <img
   data-src> for lazy-loaded images, <meta property="og:image" content>). This
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
  return EXCLUDE_IMG_SRC.some((needle) => s.includes(needle));
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

/* Every garment image referenced in a product page's raw HTML:
     - <img src="...">
     - <img data-src="..."> (lazy-loaded images - most themes swap this into
       src via JS on scroll, so the real image only lives here pre-render)
     - <meta property="og:image" content="...">
   De-duplicated and filtered against EXCLUDE_IMG_SRC. Note: without rendering
   the page there's no way to read naturalWidth/naturalHeight, so - unlike a
   browser-driven crawl - this can't filter by rendered image size; it relies
   entirely on the src/filename exclusion list to skip decorative chrome. */
function findProductImages(html, baseUrl) {
  const urls = [];

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const src = extractAttr(tag, "data-src") || extractAttr(tag, "src");
    if (src) urls.push(src);
  }

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (/property\s*=\s*["']og:image["']/i.test(tag)) {
      const content = extractAttr(tag, "content");
      if (content) urls.push(content);
    }
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
    if (seen.has(abs)) continue;
    seen.add(abs);
    images.push(abs);
  }
  return images;
}

/* ── Supabase cache ──────────────────────────────────────────────────────── */

async function getCachedClassification(imageUrl) {
  const { data, error } = await supabase
    .from("garment_cache")
    .select("classification")
    .eq("image_url", imageUrl)
    .maybeSingle();
  if (error) {
    console.warn(`  ⚠ garment_cache read failed: ${error.message}`);
    return null;
  }
  return data ? data.classification : null;
}

/* Writes the verdict WITH its provenance (see archive/supabase_setup_v8.sql for what
   each `source` value means and the diagnostic queries it unlocks). Degrades to the
   V5 column set when that migration hasn't been applied yet, so this scanner is safe
   to deploy before the SQL runs. */
async function saveClassification(imageUrl, classification, meta = {}) {
  const base = { image_url: imageUrl, classification };
  const enriched = {
    ...base,
    confidence: Number.isFinite(meta.confidence) ? meta.confidence : null,
    source: meta.source || "gemini",
    cue: meta.cue || null,
    product_url: meta.productUrl || null,
  };
  let { error } = await supabase.from("garment_cache").upsert([enriched], { onConflict: "image_url" });
  if (error && /column .* does not exist|Could not find the/i.test(error.message || "")) {
    console.warn("  ⚠ garment_cache V8 columns absent - run archive/supabase_setup_v8.sql");
    ({ error } = await supabase.from("garment_cache").upsert([base], { onConflict: "image_url" }));
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

/* ── Strict front/back system prompt ────────────────────────────────────────────
   MUST STAY IN LOCKSTEP with FRONT_BACK_SYSTEM_PROMPT in server.js. The scanner is
   a standalone package (own package.json, deployed separately to Railway) so it
   cannot import from the main server - but both write to the SAME garment_cache
   table, so a drift between the two prompts means the crawl and the live widget
   disagree about which photo is the back of the same product.

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

Respond ONLY with JSON matching this schema:
{"view":"front"|"back"|"uncertain","confidence":0.0-1.0,"cue":"<the single cue that decided it, max 12 words>"}`;

/** @returns {Promise<{view:"front"|"back"|"uncertain", confidence:number, cue:string}>} */
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
            view:       { type: "STRING", enum: ["front", "back", "uncertain"] },
            confidence: { type: "NUMBER" },
            cue:        { type: "STRING" },
          },
          required: ["view", "confidence"],
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
    return { view: "uncertain", confidence: 0, cue: "unparseable response" };
  }
  const view = ["front", "back", "uncertain"].includes(parsed?.view) ? parsed.view : "uncertain";
  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  return { view, confidence, cue: typeof parsed?.cue === "string" ? parsed.cue.slice(0, 120) : "" };
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
