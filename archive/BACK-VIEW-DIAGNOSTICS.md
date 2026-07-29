# Back view doesn't render — diagnostic runbook

Companion to `archive/supabase_setup_v8.sql` (SQL side). Run the migration first;
the `source` column is what makes most of this answerable.

**Read this first — where the back view actually comes from.** PEAR is a Decart Lucy
*realtime webcam* try-on. There is no 3D mesh, no UV map, and no orbit camera, so
there is no "back texture" to bind to rear UVs and no `0°–360°` rotation event to
listen to. The equivalent mechanism is the **OrientationWatcher** in
`fitting-room/app.js`: it samples the *local camera* and, when it confirms the shopper
has physically turned around, hot-swaps the garment *reference image* handed to Lucy
from the front asset to the back asset over the already-open WebRTC session. The
back view therefore fails for exactly one reason — **no distinct back asset existed**,
so `canCombineViews()` was false and AI Auto never armed.

Everything below chases that one asset through the four places it can go missing.

---

## The pipeline, and the four failure points

```
1. SCRAPE      pear-widget.js  → gallery URLs from the PDP DOM
2. CLASSIFY    /api/classify-images → Gemini → garment_cache (front|back)
3. RESOLVE     resolveGarmentViews() → { front_image_url, back_image_url, back_source }
4. SWAP        OrientationWatcher → rtClient.set({ image: <back blob> })
```

| # | Failure | Symptom in logs | Fix |
|---|---|---|---|
| 1 | Lazy gallery — back photo never scraped | `final imgs array: [1 url]` | fixed: lazy-attribute extraction |
| 2 | Gemini called a real back "front" | `back_source=none` with a rear photo in the gallery | fixed: strict V8 prompt |
| 3 | Rate limit defaulted to "front" | `RATE LIMITED for <url>` | fixed: recorded as `fallback`, never cached |
| 4 | Back existed but never reached the session | `GARMENT_BACK failed pre-load validation` | proxy/CDN — see §4 |

---

## 1. Is a back image in the catalog at all?

Run `D0`, `D1`, `D1b` from the SQL file. Or from Node:

```js
// scripts/diag-back-coverage.mjs — run with: node scripts/diag-back-coverage.mjs
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/** Group cached photos by the CDN's per-product numeric id — the same heuristic
 *  pear-widget.js uses (extractProductId) — and report products with zero backs. */
async function backCoverage() {
  const { data, error } = await supabase
    .from("garment_cache")
    .select("image_url, classification, confidence, source");
  if (error) throw error;

  const byProduct = new Map();
  for (const row of data) {
    const key = (row.image_url.split("?")[0].match(/\d{6,}/g) || ["ungrouped"]).at(-1);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(row);
  }

  const singleView = [];
  for (const [key, rows] of byProduct) {
    if (rows.length > 1 && !rows.some((r) => r.classification === "back")) {
      singleView.push({ key, images: rows.length, urls: rows.map((r) => r.image_url) });
    }
  }

  console.log(`products cached : ${byProduct.size}`);
  console.log(`zero-back        : ${singleView.length} (${((singleView.length / byProduct.size) * 100).toFixed(1)}%)`);
  console.table(singleView.slice(0, 20).map(({ key, images }) => ({ key, images })));
  return singleView;
}

await backCoverage();
```

**Reading it:** a healthy store lands near 40–50% back rows overall. Under ~10% means
the crawl isn't finding rear photos — check the *scraper*, not the classifier.

---

## 2. Did Gemini misclassify a back as front?

`D2`, `D2b`, `D2c` in SQL. The decisive one is `D2b`: the URL literally says
`_back.jpg` and the row says `front`. To re-check a specific image against the new
strict prompt without touching the cache:

```js
// scripts/diag-reclassify.mjs — node scripts/diag-reclassify.mjs <imageUrl>
const [, , imageUrl] = process.argv;
const res = await fetch("http://localhost:3000/api/classify-images", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ images: [imageUrl], front_image_url: imageUrl }),
});
const data = await res.json();
// back_source tells you how the pair was resolved; uncertain_count > 0 means the
// model declined to commit — that image is genuinely ambiguous, not misclassified.
console.log(JSON.stringify(data, null, 2));
```

Cached rows short-circuit the model, so **delete the row first** to force a real
re-classification (`D4` in the SQL file).

### What changed in the prompt, and why it mattered

The old prompt ended with:

> *"If this is a detail shot, side view, or lifestyle image (not clearly front or
> back) — answer 'front' as default."*

That single line converted every ambiguous **rear** photo into a `front` row. A back
shot at a slight angle, cropped at the shoulders, or worn by a model in a lifestyle
setting all came back `front` — so the product looked single-view and the back view
could never render. It also leaned on cues that exist on *both* sides (collar,
neckline, zipper), which is not evidence of anything.

`FRONT_BACK_SYSTEM_PROMPT` in `server.js` replaces it with:

* **Only one-sided cues.** Centre-back seam, back yoke, rear neck label, rear
  pockets, spine lettering → back. Button placket, fly, chest pocket, front graphic
  → front. A collar is not a cue.
* **An explicit `uncertain` verdict** with a confidence score, instead of rounding
  ambiguity to `front`. The *caller* decides what to do with it, and that decision is
  recorded in `garment_cache.source` where you can query it.
* **The neck-label tiebreak** — a sewn-in size label means back, and outranks a
  partially visible neckline. This is the single most common tricky case.
* **Strict JSON output** (`responseMimeType` + `responseSchema`, `temperature: 0`).
  The old code did `answer.includes("back")`, which also matched *"this is not the
  back"* — silently inverting the verdict. Determinism also matters because the
  scanner and the live widget write to the same cache; they must agree.

---

## 3. Did the rate-limit fallback fire?

`D3` and `D3b` in SQL. In the server logs the line is now explicit:

```
[classify-images] RATE LIMITED for https://cdn.shopify.com/... : Gemini 429: ...
```

Two behavioural changes back this: a throttled/failed classification is **never
written to the cache** (so it can't poison future visits), and it is recorded as
`source: 'fallback'` — a *default*, not a verdict — rather than being indistinguishable
from a real `front`.

The 60 RPM ceiling is why `/api/classify-images` sleeps 1100 ms between uncached
images, and why `pear-widget.js` now caps a gallery at `MAX_GALLERY_IMAGES = 8`. A
30-photo PDP would otherwise take ~33 s to classify — long after the shopper has gone
live on the DOM-order guess.

---

## 4. Is the widget actually fetching the back, and does the swap fire?

This is where "the data is fine but the back still doesn't render" gets resolved.
Open the PDP with the fitting room open and read the console in this order.

**a) Did the scrape find more than one image?** (host page console)

```
[PEAR] final imgs array: (5) ['…1823292409-1.jpg', '…-2.jpg', …]
[PEAR] back image identified from DOM signals: …_back.jpg | label: מבט גב
```
One URL here = failure point 1. The gallery is lazy and the extractor missed it —
check which attribute the theme uses and add it to `LAZY_SRC_ATTRS`.

**b) What did the server resolve?** (host page console)

```
[PEAR widget] resolved back : https://… | source: classifier
```
`source: none` = no rear asset anywhere; the run is front-only by design.
`source: synthetic` = one was generated from the front.

**c) Did the fitting room receive it?** (iframe console)

```
[PEAR] parseHandoff() - back-image resolution: { resolved_imgBack: '…', distinct_from_front: true }
[PEAR] PEAR_UPDATE_GARMENT applied - front: … | back: … | back source: classifier | mode: auto
```
`mode: auto` is the one that matters — it means `canCombineViews()` passed and AI Auto
armed. `mode: front` means the item is still single-view.

**d) Did the asset survive fetch + validation?**

```
[PEAR] prewarm back blob: ok (184,220 bytes) - turning around will render the real rear photo
```
or the failure path:
```
[PEAR] GARMENT_BACK failed pre-load validation - proceeding FRONT-ONLY - <label> <url>
```
That second line is failure point 4: the URL is correct but the bytes never arrived
(CDN hotlink block, 403 on the proxy) or arrived blank (`bitmapLooksFlat`). Check
`[img-proxy]` lines in the *server* log for the matching 502.

**e) Did the swap fire when you turned?**

```
[PEAR] AI Auto - orientation watcher armed (engine: FaceDetector)
[PEAR] AI Auto - orientation flip → BACK
[VTON Pipeline] Current Active State: BACK_MODE
```
No flip line means detection never confirmed — the watcher needs
`ORIENT_LOCK_FRAMES` (10) consecutive agreeing samples *and* `ORIENT_LOCK_MS`
(2500 ms) of sustained agreement before it moves the lock. That hysteresis is
deliberate: it is what stops the view flapping on a momentary head turn. Turn fully
and hold for ~3 s.

---

## 5. The single-image fallback

For a product that genuinely ships one photo, `/api/classify-images` generates the
rear view from the front (`synthesizeBackView`) and returns it as a `data:` URL.

Why a data URL rather than a stored asset: `garmentBlobCached()` in the fitting room
already decodes `data:`/`blob:` locally, and `garmentImageRef()` passes them through
verbatim — so no storage bucket, no `/api/img-proxy` hop, no CDN round trip. To the
rest of the pipeline it is simply a distinct image asset, which is all
`canCombineViews()` requires to arm AI Auto.

Guard rails, in order of how likely you are to need them:

| Control | Effect |
|---|---|
| `synthesize_back` (request field) | Widget sets it **only** when its DOM scrape found no rear photo — a real back is never overridden |
| `PEAR_SYNTH_BACK=0` | Global kill switch, no widget redeploy needed |
| `GEMINI_IMAGE_MODEL` | Override the image model (default `gemini-2.5-flash-image`) |
| In-process memo | One generation per front URL per process, not one per shopper |
| `preloadGarmentAssets()` | Client-side decode + `bitmapLooksFlat()` — a degenerate generation is rejected and the run proceeds front-only |

**Schema note.** No new table is needed. A generated rear is an *ephemeral derivative*
of the front, not a catalog fact, so it stays out of `garment_cache` — otherwise the
`image_url` unique index would be storing a multi-hundred-KB base64 blob as a key.
If you later want generated backs to persist across deploys, the clean pattern is a
separate `garment_derived (front_image_url PK, back_storage_path, model, created_at)`
table pointing at a Supabase Storage object, and returning that public URL instead of
the data URL — the rest of the pipeline needs no change, because it already accepts a
plain https URL there.
