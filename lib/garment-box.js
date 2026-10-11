/* =============================================================================
   PEAR · Where is the garment in a store photo? (the reference mask's band)
   -----------------------------------------------------------------------------
   REPORTED 2026-10-08 ("in the first measurement it just added the guy who models the shirt,
   with his back to the camera, in the middle of the measurement; the second was fine"). Two
   PEAK sessions 40s apart (TEST records muzadbir / muzae5mn). In the first, the render-lag probe
   (§2.16's recorder) shows the output LEAVING the camera for ~1.4s of the back view - lag
   1.76s, 1.43s, 2.0s on matches of 0.05-0.06 where every clean session reads ~1.0-1.1s on
   0.1-0.4 - then a 0.37s stall, until the FRONT reference landed. The back reference was the
   store's rear photo whole: a model standing with his back to the camera, head, arms and jeans.
   The engine drew that man instead of the shopper. Same mechanism, same "the next session was
   clean", as the 2026-09-27 report (479cdfd: "the giant back is photo 3 itself pasted into the
   room") and the 2026-09-29 one (the rear photo's grey trousers on the shopper, 30a7710).

   WHAT WAS TRIED, so it is not re-tried blind:
     · 479cdfd: the room CROPPED each store photo with a second pose model in the browser -
       reverted for lag (GPU doubled, go-live 12.8s vs 4.0s, CLAUDE.md §2.15).
     · 30a7710: the crop's box from THIS server (the classifier's model), the browser only cut -
       reverted the same day, bundled with a render-input change (512x288 -> 896x504), after
       "now it is bad". Which of the two made it worse was never separated.
   THIS ONE asks for the same box but the room does not CROP: it paints the photo above the
   collar and below the hem with the photo's own backdrop (see maskReferenceBand() in app.js).
   The picture keeps its size and the garment its exact place and scale - the engine sees the
   same back print it renders well today, minus the person. And only the REAR photo: the front,
   which works, is not touched.

   WHAT IT ANSWERS: for one photo and the body region its garment is worn on, the vertical band
   to keep (0-1 of the height) - or null, which means "send the photo as it is" (today's bytes).
     · a photo with no person in it (a packshot, flat-lay, hanger) -> null. Nothing to remove.
     · an unsure or malformed answer -> null.
     · a band that would keep nearly the whole height anyway -> null.
   The margins keep the collar and the hem: cutting into the garment is worse than leaving a
   sliver of neck or waistband in.

   NEVER THROWS for an answer it cannot make - only a rate limit (429) throws, so the caller can
   tell "declined" from "never asked" and cache only the former (garment-category.js's rule).
   ============================================================================= */

/* Bump when the prompt or the geometry changes: it is part of the endpoint's cache key, so a
   CDN-cached answer from an older rule is never served against a newer one. */
/* 2 (2026-10-11): the photo is analysed at ANALYSIS_WIDTH where the CDN can resize it, and a bottom's band keeps more below its
   hem - every v1 answer for a large photo is suspect, so none is served again (the room asks with v=2; the memo keys on it).
   3 (the same day): v2 still boxed the white tee for "the lower-body garment" on both CHICAGO photos ([0, 0.14] / [0, 0.17], at
   768 wide and temperature 0) - the model's LABEL is what fails, not its boxes. So it is asked for BOTH garments at once and the
   region is taken by POSITION: the lower-body garment is the lower box, the upper-body garment the upper one (pickRegionBox). */
export const GARMENT_BOX_VERSION = 3;

const GEMINI_MODEL = "gemini-3.1-flash-lite";   // the classifier's model (server.js, lib/garment-category.js)
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const REGION_TEXT = {
  top: "a garment worn on the UPPER body (t-shirt, shirt, polo, sweater, hoodie, jacket, coat, dress, jumpsuit)",
  bottom: "a garment worn on the LOWER body (trousers, jeans, shorts, skirt, leggings)",
};

export function garmentBoxPrompt(region) {
  const top = region !== "bottom";
  return [
    "You locate the garments worn in one clothing product photograph.",
    "",
    "The product being sold is " + (top ? REGION_TEXT.top : REGION_TEXT.bottom) + ".",
    "",
    "Return JSON:",
    "  worn_by_person - true if a person or model is wearing it (any part of a human body is visible);",
    "                   false for a flat-lay, a hanger, a ghost mannequin or a packshot with no person.",
    "  upper_box_2d   - the tight box around the garment on the UPPER body, as [ymin, xmin, ymax, xmax], each value",
    "                   normalized to 0-1000 of the image height/width: from the highest point of the collar or neckline",
    "                   to the lowest point of its hem, from the outer edge of one sleeve to the other. EXCLUDE the head.",
    "                   null if no upper-body garment is visible.",
    "  lower_box_2d   - the tight box around the garment on the LOWER body, the same format: from the top edge of the",
    "                   waistband (even where a top hangs over it) to its lowest hem, the full width of both legs.",
    "                   EXCLUDE shoes. null if no lower-body garment is visible.",
    "  confidence     - 0..1, how sure you are of the box around the product being sold.",
    "If the photo does not clearly show that product (a detail close-up, a fabric swatch, a label, a",
    "different kind of garment), set confidence to 0.",
  ].join("\n");
}

/* Margins around the garment's box, as a share of the box's own height: thin, because what lies
   just past the collar and the hem - the chin, the trousers' waistband - is exactly what this
   exists to remove (30a7710's crop, checked by eye on the OASIS rear photo: 4% / 2.5% kept the chin
   and a grey band of waistband with its belt loops). */
const PAD_TOP = 0.015;
const PAD_BOTTOM = 0.01;
/* A BOTTOM'S HEM, MEASURED (2026-10-11): on the FOX CHICAGO shorts' back photo the model's box stopped ~0.09 of the photo above
   the hem (0.38 for ~0.47) - the trim the shorts are recognised by. A bottom keeps this share of its box below it (the legs
   under a hem cost nothing; a hem cut off is the garment cut off) and a little more above the waistband. */
const BOTTOM_PAD_ABOVE = 0.03;
const BOTTOM_PAD_BELOW = 0.25;
/* THE PHOTO THE MODEL SEES (2026-10-11): the CHICAGO photos are 2048x3072, and at that size the model boxed the white tee
   above the waistband for "the lower-body garment" on both ([0, 0.15]); the same photos at 600px wide came back right
   (front 0.07-0.50). The PEAK photos (1000x1499) were right at full size. So a photo on a CDN that resizes by query (Shopify:
   cdn.shopify.com and a store's own /cdn/shop/) is analysed at this width; the band is in fractions, so it applies to every
   size of the photo. Any other host is fetched as it is. */
const ANALYSIS_WIDTH = 768;
/** The URL to analyse: a Shopify CDN photo asked at ANALYSIS_WIDTH (crop/height dropped), anything else as given. Pure. */
export function analysisUrl(imageUrl) {
  let u;
  try { u = new URL(String(imageUrl)); } catch (_) { return imageUrl; }
  const shopify = /(^|\.)cdn\.shopify\.com$/i.test(u.hostname) || /\/cdn\/shop\//i.test(u.pathname);
  if (!shopify) return imageUrl;
  for (const k of ["width", "height", "crop"]) u.searchParams.delete(k);
  u.searchParams.set("width", String(ANALYSIS_WIDTH));
  return u.toString();
}
const MIN_CONFIDENCE = 0.6;
const MIN_BOX_SIDE = 0.12;   // a box narrower/shorter than this share of the photo is not the subject
const MIN_MASK = 0.04;       // less than this share of the height above AND below the band: nothing to remove

/**
 * The band to keep, from the model's answer - or null (send the photo as it is). Pure; the
 * endpoint's tests drive it directly. The box's x is returned for the record, never used to cut.
 * @param {{worn_by_person?: boolean, box_2d?: number[], confidence?: number}|null} det
 * @param {"top"|"bottom"} region
 * @returns {{band: {y0:number,y1:number,x0:number,x1:number}|null, reason: string}}
 */
/** The box for the region, from an answer with both garments' boxes (v3) - or the single box_2d of a v1/v2 answer. The region
 *  is decided by POSITION when both are found: the lower box is the lower-body garment, whatever the model labelled it. Pure. */
export function pickRegionBox(det, region) {
  if (!det || typeof det !== "object") return null;
  if (Array.isArray(det.box_2d)) return det.box_2d;
  const ok = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => v !== null && v !== "" && Number.isFinite(Number(v)));
  const up = ok(det.upper_box_2d) ? det.upper_box_2d.map(Number) : null;
  const lo = ok(det.lower_box_2d) ? det.lower_box_2d.map(Number) : null;
  if (up && lo) {
    const cy = (b) => (b[0] + b[2]) / 2;
    const [higher, lower] = cy(up) <= cy(lo) ? [up, lo] : [lo, up];
    return region === "bottom" ? lower : higher;
  }
  return region === "bottom" ? lo : up;   // one garment found: it counts only for its own region
}

export function garmentBandFromDetection(det, region) {
  if (!det || typeof det !== "object") return { band: null, reason: "no-answer" };
  const conf = Number(det.confidence);
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return { band: null, reason: "unsure" };
  if (det.worn_by_person !== true) return { band: null, reason: "no-person" };
  const b = pickRegionBox(det, region);
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => v !== null && v !== "" && Number.isFinite(Number(v)))) {
    return { band: null, reason: "no-box" };
  }
  const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, Number(v))) / 1000);
  const bw = xmax - xmin, bh = ymax - ymin;
  if (!(bw >= MIN_BOX_SIDE) || !(bh >= MIN_BOX_SIDE)) return { band: null, reason: "tiny-box" };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  /* Bottoms keep a little more above the waistband (a top hanging over it is part of how the
     waistband reads) and a little more at the hem (a trouser hem sits on the shoe). */
  const padTop = region === "bottom" ? BOTTOM_PAD_ABOVE : PAD_TOP;
  const padBottom = region === "bottom" ? BOTTOM_PAD_BELOW : PAD_BOTTOM;
  const y0 = clamp(ymin - padTop * bh), y1 = clamp(ymax + padBottom * bh);
  if (y0 < MIN_MASK && y1 > 1 - MIN_MASK) return { band: null, reason: "fills-photo" };
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return { band: { y0: r4(y0), y1: r4(y1), x0: r4(xmin), x1: r4(xmax) }, reason: "band" };
}

async function fetchImageAsBase64(imageUrl, fetchImpl) {
  const secure = String(imageUrl).replace(/^http:\/\//i, "https://");
  const resp = await fetchImpl(secure, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error("image fetch failed: HTTP " + resp.status);
  const type = resp.headers.get("content-type") || "image/jpeg";
  if (!/^image\//i.test(type)) throw new Error("not an image: " + type);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large: " + buf.byteLength + " bytes");
  return { base64: buf.toString("base64"), mimeType: type };
}

/**
 * Ask the vision model where the garment is, and turn the answer into a band.
 * @param {string} imageUrl
 * @param {"top"|"bottom"} region
 * @param {string} apiKey
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{band: object|null, reason: string, source: "ai"|"unconfigured"|"error"}>}
 *   Only source === "ai" is a verdict worth caching.
 * @throws only on HTTP 429.
 */
export async function detectGarmentBand(imageUrl, region, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = String(imageUrl || "").trim();
  const reg = region === "bottom" ? "bottom" : "top";
  if (!url) return { band: null, reason: "no-url", source: "error" };
  if (!apiKey) return { band: null, reason: "no-key", source: "unconfigured" };

  let image;
  try {
    image = await fetchImageAsBase64(analysisUrl(url), fetchImpl);   // THE PHOTO THE MODEL SEES
  } catch (e) {
    console.warn("[garment-box] image unreadable (" + url.slice(0, 120) + "):", e?.message || e);
    return { band: null, reason: "image-unreadable", source: "error" };
  }

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL + ":generateContent?key=" + apiKey;
  let resp;
  try {
    resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: garmentBoxPrompt(reg) }] },
        contents: [{
          parts: [
            { text: "Where is the garment in this photo?" },
            { inline_data: { mime_type: image.mimeType, data: image.base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0,   // the same photo must be masked the same way on every visit
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              worn_by_person: { type: "BOOLEAN" },
              upper_box_2d: { type: "ARRAY", items: { type: "NUMBER" }, nullable: true },
              lower_box_2d: { type: "ARRAY", items: { type: "NUMBER" }, nullable: true },
              confidence: { type: "NUMBER" },
            },
            required: ["worn_by_person", "confidence"],
          },
        },
      }),
    });
  } catch (e) {
    console.warn("[garment-box] model request failed for " + url.slice(0, 120) + ":", e?.message || e);
    return { band: null, reason: "model-unreachable", source: "error" };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    if (resp.status === 429) {
      const err = new Error("classifier 429 (rate limited): " + body.slice(0, 200));
      err.status = 429;
      err.rateLimited = true;
      throw err;
    }
    console.warn("[garment-box] model HTTP " + resp.status + " for " + url.slice(0, 120));
    return { band: null, reason: "HTTP " + resp.status, source: "error" };
  }
  let det;
  try {
    const data = await resp.json();
    det = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "null");
  } catch {
    return { band: null, reason: "unparseable", source: "error" };
  }
  const { band, reason } = garmentBandFromDetection(det, reg);
  const picked = pickRegionBox(det, reg);
  return { band, reason, source: "ai", raw: Array.isArray(picked) ? picked.slice(0, 4).map(Number) : null,
    both: det && typeof det === "object" ? { upper: det.upper_box_2d ?? null, lower: det.lower_box_2d ?? null } : null };
}
