# PEAR Store Scanner

Standalone crawler that visits a storefront, finds every product page, collects
garment images, and classifies each one as front/back using Gemini. Results are
cached in the same Supabase `garment_cache` table the main PEAR server reads
from, so a garment scanned here is never re-classified by the widget later
(and vice versa).

This is a separate script from the main PEAR server - it has its own
`package.json` and `.env`, and is meant to be run standalone or deployed as
its own Railway service.

## Install

```
cd scanner
npm install
cp .env.example .env
```

Fill in `.env`:

- `GEMINI_API_KEY` - from https://aistudio.google.com/apikey
- `SUPABASE_URL` - Supabase Dashboard → Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase Dashboard → Settings → API (service role, not anon)

The `garment_cache` table must exist - see `supabase_setup_v5.sql` in the
project root.

No browser is involved. Shopify stores are detected from the homepage HTML
and scanned via the `/products.json` catalog API - every product and its
full image list, paginated 250 at a time, no page scraping needed. Every
other store falls back to fetching each product page as plain HTML (Node's
built-in `fetch`) and pulling image URLs out with regex (`<img src>`,
`<img data-src>` for lazy-loaded images, `<meta property="og:image" content>`).
Puppeteer/Chromium proved unreliable to install on Railway's Nix-based build,
so the HTML-scrape fallback trades away JavaScript-rendered content for a
crawler that runs anywhere with no browser dependency - a non-Shopify store
whose product images are injected purely by client-side JS after load won't
be picked up.

## Run

```
node scan-store.js https://store-url.com
```

Example:

```
node scan-store.js https://fox.co.il
```

Progress prints to the console as it crawls, then classifies once every
product page (or the Shopify catalog) has been gathered:

```
Found 45 products with 134 images
Classifying...
Image 1: front (cached)
Image 2: back (new)
Image 3: front (new)
...
Progress: 10/134 images classified
...
Done. Total: 134 images | 89 front | 45 back | 12 cached
```

Uncached images are classified via Gemini (free tier: 60 requests/minute) -
a 2s delay runs between calls, and a 429 (rate limited) response is retried
after a 30s wait, up to 3 attempts, before falling back to `front` so a
single stubborn image never stalls the whole scan.

## Deploy on Railway

1. Connect this GitHub repo on [railway.app](https://railway.app).
2. Set the environment variables above (`GEMINI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`) in the Railway service settings.
3. Set the run command:
   ```
   node scanner/scan-store.js https://store-url.com
   ```
   (swap in the store you want to scan - Railway runs this as a one-off /
   scheduled job rather than a long-lived server).
