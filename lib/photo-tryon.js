/* =============================================================================
   PEAR · Photo try-on (Gemini image model)
   -----------------------------------------------------------------------------
   The fitting room's "תמונה / photo" mode: the shopper takes or chooses ONE photo of
   themselves and gets back that photo with the garment on them. The live mode (the
   realtime engine, AI Auto, the 360) is untouched and stays the default - this is a
   second, still path beside it, never a fallback inside a live session (§2.9).

   WHAT GOES IN. The person photo (a ≤1024px JPEG the browser made) and the garment's
   FRONT reference - the same image the live session is conditioned on
   (galleryOf(item).front || item.img), fetched and downscaled by the browser so a
   custom upload and a CDN photo arrive the same way. A full look sends both pieces.

   WHAT COMES OUT. One image, or `ok: false` with a reason. NEVER THROWS, NEVER 5xx:
   the room shows "try another photo" and the shopper still has the live mode.

   PRIVACY. The person photo is forwarded to the model and dropped - never written to
   disk, the database or a log line. Logs carry the outcome and timings only.
   ============================================================================= */

/* The image model synthesizeBackView() in server.js already uses. */
export const PHOTO_TRYON_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

/* ~3 MB of base64 per image. The browser sends ≤1024px JPEGs of a few hundred KB; the cap
   keeps three images under the hosting platform's request-body limit. */
const MAX_IMAGE_CHARS = 3_000_000;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_GARMENTS = 2;

/* What the prompt may say about each garment - the room's own region verdict. */
const REGIONS = new Set(["upper_body", "lower_body"]);

function parseDataUrl(v) {
  const m = typeof v === "string" ? /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m || !IMAGE_MIME.has(m[1]) || !m[2].length || m[2].length > MAX_IMAGE_CHARS) return null;
  return { mimeType: m[1], base64: m[2] };
}

/**
 * The request body, field by field. A missing person photo or no usable garment makes
 * the request unusable (`person: null` / `garments: []`); everything else is optional.
 * @returns {{person: {mimeType: string, base64: string}|null,
 *            garments: Array<{image: {mimeType: string, base64: string}, region: string|null, name: string}>}}
 */
export function sanitizePhotoTryOnRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const garments = [];
  for (const g of Array.isArray(b.garments) ? b.garments.slice(0, MAX_GARMENTS) : []) {
    const image = parseDataUrl(g && g.image);
    if (!image) continue;
    garments.push({
      image,
      region: REGIONS.has(g.region) ? g.region : null,
      name: typeof g.name === "string" ? g.name.replace(/[\u0000-\u001f]/g, " ").slice(0, 80) : "",
    });
  }
  return { person: parseDataUrl(b.person), garments };
}

/* WRITTEN AGAINST THE TWO WAYS A TRY-ON EDIT FAILS:
   - it "improves" the shopper: slimmer, taller, a new face, a cleaner background. The
     whole point of a fitting is THIS body, so identity, build, pose and scene are locked
     first and by name (the body-fidelity lesson of CLAUDE.md §2.4: the garment wears the
     body, never the other way round).
   - it redraws the garment from a description: a different print, a moved logo, a
     changed colour. The reference image is the garment's authority, so it is named as
     such and its print/text/colour are to be reproduced, not re-imagined. */
export function photoTryOnPrompt(garments) {
  const pieces = garments.map((g, i) => {
    const where = g.region === "lower_body" ? "on the lower body (waist down)"
                : g.region === "upper_body" ? "on the upper body" : "where it is worn";
    return `- Image ${i + 2}${g.name ? ` ("${g.name}")` : ""}: the garment to put ${where}.`;
  });
  return [
    "Virtual fitting room. Image 1 is a photo of a shopper. Dress the shopper in the garment shown in the following image(s), so they can see how it looks on them.",
    ...pieces,
    "",
    "Keep EXACTLY: the person's face, hair, skin tone, body shape and proportions, height, pose, hands, the background, the lighting and the camera framing. Do not slim, reshape, beautify or re-pose the person. Do not crop or zoom.",
    "Replace only the clothing the new garment covers; leave everything else they wear as it is.",
    "Reproduce the garment from its image faithfully: the same colour, fabric, cut, print, logo and text, in the same place and orientation (text must read correctly). Do not invent or redesign any part of it.",
    "Fit it naturally to this body - realistic drape, folds and shadows for the person's pose and the scene's light.",
    "Return one photorealistic image only.",
  ].join("\n");
}

/**
 * Dress the person in the garment(s).
 * @param {ReturnType<typeof sanitizePhotoTryOnRequest>} req
 * @param {string} apiKey - GEMINI_API_KEY; empty answers `unconfigured`.
 * @param {typeof fetch} [fetchImpl] - injected by the tests.
 * @returns {Promise<{ok: true, image: string, ms: number}|{ok: false, reason: string}>} never rejects.
 */
export async function photoTryOn(req, apiKey, fetchImpl = fetch) {
  if (!req || !req.person) return { ok: false, reason: "bad_person" };
  if (!req.garments || !req.garments.length) return { ok: false, reason: "bad_garment" };
  if (!apiKey) return { ok: false, reason: "unconfigured" };

  const t0 = Date.now();
  const parts = [
    { text: photoTryOnPrompt(req.garments) },
    { inline_data: { mime_type: req.person.mimeType, data: req.person.base64 } },
    ...req.garments.map((g) => ({ inline_data: { mime_type: g.image.mimeType, data: g.image.base64 } })),
  ];

  let resp;
  try {
    resp = await fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/models/" + PHOTO_TRYON_MODEL + ":generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } }),
      },
    );
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!resp.ok) return { ok: false, reason: resp.status === 429 ? "rate_limited" : "error" };

  let inline = null;
  try {
    const data = await resp.json();
    const out = data?.candidates?.[0]?.content?.parts || [];
    const part = out.find((p) => p?.inline_data?.data || p?.inlineData?.data);
    inline = part ? (part.inline_data || part.inlineData) : null;
  } catch {
    return { ok: false, reason: "error" };
  }
  /* A text-only answer is the model declining (no person, an unsafe image, …) - an
     abstention, reported as one rather than as a server fault. */
  if (!inline || !inline.data) return { ok: false, reason: "no_image" };
  const mime = inline.mime_type || inline.mimeType || "image/png";
  if (!IMAGE_MIME.has(mime)) return { ok: false, reason: "no_image" };
  return { ok: true, image: `data:${mime};base64,${inline.data}`, ms: Date.now() - t0 };
}
