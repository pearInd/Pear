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

async function saveClassification(imageUrl, classification) {
  const { error } = await supabase
    .from("garment_cache")
    .upsert([{ image_url: imageUrl, classification }], { onConflict: "image_url" });
  if (error) console.warn(`  ⚠ garment_cache write failed: ${error.message}`);
}

/* ── Gemini classification ───────────────────────────────────────────────── */

async function fetchImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer.toString("base64");
}

async function classifyFrontBack(imageUrl) {
  const base64 = await fetchImageAsBase64(imageUrl);
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
            {
              text:
                "Look at this clothing/garment image carefully. Ignore any model or person. Focus only on the garment itself. Is the GARMENT showing its front side or its back side? Answer with exactly one word: front or back",
            },
          ],
        },
      ],
    }),
  });
  console.log('Gemini status:', resp.status);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  console.log('Gemini raw:', JSON.stringify(data));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const answer = text.trim().toLowerCase();
  return answer.includes("back") ? "back" : "front";
}

/* Gemini's free tier is 15 requests/minute - even the 5s inter-request delay
   below can trip a 429 occasionally. On a 429, wait 60s and retry once; if
   still rate-limited (or fails for any other reason), skip the image and
   default to "front" rather than blocking the scan. */
async function classifyWithRetry(imageUrl, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await classifyFrontBack(imageUrl);
      return result;
    } catch (e) {
      if (e.message.includes("429") && i < retries - 1) {
        console.log("Rate limited - waiting 60s...");
        await sleep(60000);
      } else {
        return "front";
      }
    }
  }
  return "front";
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
          allImages.push({ url: image.src, productTitle: product.title });
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

async function classifyAndTally(imageUrl, index, counters, total) {
  try {
    let classification = await getCachedClassification(imageUrl);
    let cached = !!classification;

    if (!classification) {
      console.log(`Classifying image ${index + 1}/${total}...`);
      classification = await classifyWithRetry(imageUrl);
      await saveClassification(imageUrl, classification);
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

  const counters = { total: 0, front: 0, back: 0, cached: 0 };
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
    await classifyAndTally(images[j], j, counters, images.length);
  }

  console.log(
    `\nDone. Total: ${counters.total} images | ${counters.front} front | ${counters.back} back | ${counters.cached} cached`
  );
}

main().catch((err) => {
  console.error("✗ Scan failed:", err?.message || err);
  process.exit(1);
});
