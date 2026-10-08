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
export const GARMENT_BOX_VERSION = 1;

const GEMINI_MODEL = "gemini-3.1-flash-lite";   // the classifier's model (server.js, lib/garment-category.js)
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const REGION_TEXT = {
  top: "a garment worn on the UPPER body (t-shirt, shirt, polo, sweater, hoodie, jacket, coat, dress, jumpsuit)",
  bottom: "a garment worn on the LOWER body (trousers, jeans, shorts, skirt, leggings)",
};

export function garmentBoxPrompt(region) {
  const top = region !== "bottom";
  return [
    "You locate the garment being sold in one clothing product photograph.",
    "",
    "The garment is " + (top ? REGION_TEXT.top : REGION_TEXT.bottom) + ".",
    "If several garments are visible, it is the one worn on that body region that the photo is about.",
    "",
    "Return JSON:",
    "  worn_by_person - true if a person or model is wearing it (any part of a human body is visible);",
    "                   false for a flat-lay, a hanger, a ghost mannequin or a packshot with no person.",
    "  box_2d         - the tight box around THAT garment only, as [ymin, xmin, ymax, xmax],",
    "                   each value normalized to 0-1000 of the image height/width.",
    top
      ? "                   From the highest point of the collar or neckline to the lowest point of the hem;" +
        "\n                   from the outer edge of one sleeve to the outer edge of the other (the body's side if" +
        "\n                   sleeveless). Include the whole garment even where an arm or hand covers part of it." +
        "\n                   EXCLUDE the head and face, and every other item: trousers, shorts, skirts, shoes, bags."
      : "                   From the top edge of the waistband (even where a top hangs over it) to the lowest hem;" +
        "\n                   the full width of both legs. EXCLUDE the torso's top, the head, shoes and bags.",
    "  confidence     - 0..1, how sure you are of the box.",
    "If the photo does not clearly show that garment (a detail close-up, a fabric swatch, a label, a",
    "different kind of garment), set confidence to 0.",
  ].join("\n");
}

/* Margins around the garment's box, as a share of the box's own height: thin, because what lies
   just past the collar and the hem - the chin, the trousers' waistband - is exactly what this
   exists to remove (30a7710's crop, checked by eye on the OASIS rear photo: 4% / 2.5% kept the chin
   and a grey band of waistband with its belt loops). */
const PAD_TOP = 0.015;
const PAD_BOTTOM = 0.01;
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
export function garmentBandFromDetection(det, region) {
  if (!det || typeof det !== "object") return { band: null, reason: "no-answer" };
  const conf = Number(det.confidence);
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return { band: null, reason: "unsure" };
  if (det.worn_by_person !== true) return { band: null, reason: "no-person" };
  const b = det.box_2d;
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => v !== null && v !== "" && Number.isFinite(Number(v)))) {
    return { band: null, reason: "no-box" };
  }
  const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, Number(v))) / 1000);
  const bw = xmax - xmin, bh = ymax - ymin;
  if (!(bw >= MIN_BOX_SIDE) || !(bh >= MIN_BOX_SIDE)) return { band: null, reason: "tiny-box" };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  /* Bottoms keep a little more above the waistband (a top hanging over it is part of how the
     waistband reads) and a little more at the hem (a trouser hem sits on the shoe). */
  const padTop = region === "bottom" ? PAD_BOTTOM : PAD_TOP;
  const padBottom = region === "bottom" ? PAD_TOP : PAD_BOTTOM;
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
    image = await fetchImageAsBase64(url, fetchImpl);
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
              box_2d: { type: "ARRAY", items: { type: "NUMBER" } },
              confidence: { type: "NUMBER" },
            },
            required: ["worn_by_person", "box_2d", "confidence"],
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
  return { band, reason, source: "ai", raw: Array.isArray(det && det.box_2d) ? det.box_2d.slice(0, 4).map(Number) : null };
}
