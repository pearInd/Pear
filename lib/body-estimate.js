/* =============================================================================
   PEAR · Height / weight estimate from one photo (Gemini Vision)
   -----------------------------------------------------------------------------
   Screen 1's "estimate from a photo" button: the shopper takes or uploads one photo
   of themselves and the measurement fields - height and weight, and the optional
   chest / waist / leg length - fill with an ESTIMATE they can edit.

   WHAT THIS IS NOT. It does not pick a size. The size stays lib/sizing.js's job,
   run on the numbers exactly as if the shopper had typed them - so the vetted
   kernel (CLAUDE.md §2.5b) is untouched and a bad estimate is visible, as numbers
   in fields, before anything is computed from it. The optional three feed only the
   fine-tune tie-break, as typed ones do.

   THE OPTIONAL THREE ARE EACH OPTIONAL HERE TOO. A reading of height and weight is
   useful on its own; a chest the model could not see (a coat) or a leg length on a
   body cropped at the knee comes back null and its field stays empty.

   A SUGGESTION, NEVER A VERDICT. The browser only fills a field the shopper left
   empty, marks it as an estimate, and the shopper confirms it by pressing Continue.
   A height they typed is sent along as KNOWN: the model then estimates the weight
   only, and that weight is better for it (a photo has no scale of its own - a known
   height is the scale).

   NEVER THROWS, NEVER 5xx. Every failure - no key, a throttle, an unreadable reply,
   a photo with no person in it, a low-confidence reading - answers `ok: false` and
   the form stays exactly as the shopper left it (CLAUDE.md §2.5: never block).

   PRIVACY. The photo is forwarded to the model and dropped. It is never written to
   disk, the database or a log line - logs carry the outcome only.
   ============================================================================= */

/* The model the other classifiers use (lib/garment-category.js, server.js). */
const GEMINI_MODEL = "gemini-3.1-flash-lite";

/* The form's own bounds (index.html #height min/max, #weight min/max) narrowed to
   adult-plausible: an estimate outside them is a misreading, not a body. */
export const ESTIMATE_BOUNDS = {
  height: [120, 220], weight: [30, 200],
  chest: [50, 150], waist: [40, 150], legs: [50, 120],   // index.html #chest/#waist/#legs
};
/* Leg length (the OUTSEAM, waist to floor - lib/sizing.js maps "inseam" elsewhere) over
   height. The size chart's own ratio is ~0.575; a reading outside this band is a
   misread body or a misread scale, and is dropped rather than shown. */
const LEGS_TO_HEIGHT = [0.48, 0.68];
const OPTIONAL_FIELDS = [["chest", "chest_cm"], ["waist", "waist_cm"], ["legs", "leg_length_cm"]];

/* Below this the reading is not shown. The shopper still has the empty form, which
   costs them nothing; a confident-looking wrong number costs them a size. */
export const MIN_CONFIDENCE = 0.4;

/* ~3 MB of base64 (≈2.2 MB of JPEG). The browser sends a ≤1024px JPEG of a few
   hundred KB; the cap keeps a raw upload under the hosting platform's body limit. */
const MAX_IMAGE_CHARS = 3_000_000;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export const BODY_ESTIMATE_PROMPT = [
  "You estimate a person's HEIGHT in centimetres and BODY WEIGHT in kilograms from one photograph,",
  "so an online clothing store can suggest a size. The shopper will see your numbers and can correct them.",
  "",
  "A photo has no scale of its own, so find one before estimating:",
  "- A phone held in a mirror selfie is about 15 cm tall.",
  "- A standard interior door is about 200 cm tall; a ceiling is about 250-270 cm.",
  "- Furniture, door handles (~100 cm), light switches (~120 cm), countertops (~90 cm).",
  "- Body proportions (head-to-body ratio, limb lengths) when nothing else is visible.",
  "If KNOWN_HEIGHT_CM is given, it is the person's real height: use it as the scale,",
  "return it unchanged as height_cm, and estimate the weight from the body's build against it.",
  "",
  "OPTIONAL measurements, each in centimetres - give one only if the body part is visible",
  "and not hidden by loose clothing, otherwise 0:",
  "- chest_cm: chest circumference around the fullest part of the chest, under the arms.",
  "- waist_cm: waist circumference at the natural waist (narrowest part of the torso).",
  "- leg_length_cm: OUTSIDE leg length, from the waist to the floor (not the inseam).",
  "  Only when the whole leg down to the feet is visible.",
  "If KNOWN_ values are given for any of these, return them unchanged.",
  "",
  "Estimate weight from the visible build - shoulder and hip width, waist, limb thickness -",
  "relative to the height. Clothing hides shape: loose clothing adds apparent bulk; do not",
  "read a loose garment as body mass.",
  "",
  "Set person_visible false if there is no person, more than one person of similar prominence,",
  "or the photo is not of a real person (a drawing, a mannequin, a screen).",
  "Set full_body_visible false if the person is cropped above the knees.",
  "confidence (0..1) is how sure you are of BOTH numbers together. A cropped body, a sitting",
  "pose, heavy layers or no scale cue all lower it. Be honest: a low confidence is useful.",
  "",
  "scale_cue: the one thing you used as the scale, under 10 words.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    person_visible:    { type: "BOOLEAN" },
    full_body_visible: { type: "BOOLEAN" },
    height_cm:         { type: "NUMBER" },
    weight_kg:         { type: "NUMBER" },
    chest_cm:          { type: "NUMBER" },
    waist_cm:          { type: "NUMBER" },
    leg_length_cm:     { type: "NUMBER" },
    confidence:        { type: "NUMBER" },
    scale_cue:         { type: "STRING" },
  },
  required: ["person_visible", "height_cm", "weight_kg", "confidence"],
};

function numIn(v, [lo, hi]) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/**
 * The request body, field by field. Anything malformed becomes null rather than an error:
 * only a missing or unusable image is refused (`image: null`).
 * @returns {{image: {mimeType: string, base64: string}|null, height: number|null,
 *            weight: number|null, chest: number|null, waist: number|null, legs: number|null,
 *            gender: "men"|"women"|null}}
 */
export function sanitizeBodyEstimateRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  let image = null;
  const m = typeof b.image === "string" ? /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(b.image) : null;
  if (m && IMAGE_MIME.has(m[1]) && m[2].length > 0 && m[2].length <= MAX_IMAGE_CHARS) {
    image = { mimeType: m[1], base64: m[2] };
  }
  return {
    image,
    height: numIn(b.height, ESTIMATE_BOUNDS.height),
    weight: numIn(b.weight, ESTIMATE_BOUNDS.weight),
    chest: numIn(b.chest, ESTIMATE_BOUNDS.chest),
    waist: numIn(b.waist, ESTIMATE_BOUNDS.waist),
    legs: numIn(b.legs, ESTIMATE_BOUNDS.legs),
    gender: b.gender === "men" || b.gender === "women" ? b.gender : null,
  };
}

/**
 * The model's reply → what the browser may show. A known height comes back as the known
 * height (the model is told to keep it; this makes sure). Numbers are rounded to whole
 * centimetres and kilograms - the precision the form takes and the most the photo supports.
 * The optional three come back as a number or null, never failing the answer: a known
 * value unchanged, else the reading if it is in bounds (and, for legs, in proportion to
 * the height and on a body seen down to the feet).
 * @returns {{ok: true, height: number, weight: number, chest: number|null,
 *            waist: number|null, legs: number|null, confidence: number}
 *          |{ok: false, reason: "no_person"|"low_confidence"|"out_of_range"}}
 */
export function normalizeBodyEstimate(raw, known = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  if (r.person_visible !== true) return { ok: false, reason: "no_person" };
  const confidence = Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : 0;
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: "low_confidence" };
  const height = known.height ?? numIn(r.height_cm, ESTIMATE_BOUNDS.height);
  const weight = known.weight ?? numIn(r.weight_kg, ESTIMATE_BOUNDS.weight);
  if (height == null || weight == null) return { ok: false, reason: "out_of_range" };
  const out = { ok: true, height: Math.round(height), weight: Math.round(weight) };
  for (const [key, field] of OPTIONAL_FIELDS) {
    let v = known[key] ?? numIn(r[field], ESTIMATE_BOUNDS[key]);
    if (v != null && key === "legs" && known.legs == null) {
      const ratio = v / height;
      if (r.full_body_visible !== true || ratio < LEGS_TO_HEIGHT[0] || ratio > LEGS_TO_HEIGHT[1]) v = null;
    }
    out[key] = v == null ? null : Math.round(v);
  }
  out.confidence = Math.round(confidence * 100) / 100;
  return out;
}

/**
 * Estimate height and weight from one photo.
 * @param {ReturnType<typeof sanitizeBodyEstimateRequest>} req
 * @param {string} apiKey - GEMINI_API_KEY; empty answers `unconfigured`.
 * @param {typeof fetch} [fetchImpl] - injected by the tests.
 * @returns {Promise<{ok: boolean, height?: number, weight?: number, confidence?: number,
 *                    reason?: string}>} never rejects.
 */
export async function estimateBodyFromPhoto(req, apiKey, fetchImpl = fetch) {
  if (!req || !req.image) return { ok: false, reason: "bad_image" };
  if (!apiKey) return { ok: false, reason: "unconfigured" };

  const facts = [];
  if (req.height != null) facts.push("KNOWN_HEIGHT_CM: " + req.height);
  if (req.weight != null) facts.push("KNOWN_WEIGHT_KG: " + req.weight);
  if (req.chest != null) facts.push("KNOWN_CHEST_CM: " + req.chest);
  if (req.waist != null) facts.push("KNOWN_WAIST_CM: " + req.waist);
  if (req.legs != null) facts.push("KNOWN_LEG_LENGTH_CM: " + req.legs);
  if (req.gender) facts.push("The shopper selected: " + (req.gender === "men" ? "men's" : "women's") + " clothing.");
  facts.push("Estimate this person's measurements.");

  let resp;
  try {
    resp = await fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: BODY_ESTIMATE_PROMPT }] },
          contents: [{
            parts: [
              { text: facts.join("\n") },
              { inline_data: { mime_type: req.image.mimeType, data: req.image.base64 } },
            ],
          }],
          generationConfig: {
            /* The same photo must give the same numbers if the shopper presses twice. */
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      },
    );
  } catch {
    return { ok: false, reason: "error" };
  }

  if (!resp.ok) return { ok: false, reason: resp.status === 429 ? "rate_limited" : "error" };

  let parsed;
  try {
    const data = await resp.json();
    parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  } catch {
    return { ok: false, reason: "error" };
  }
  /* Every known value is kept: the browser never overwrites a typed field, but the answer
     should not contradict what the shopper told us either. */
  return normalizeBodyEstimate(parsed, { height: req.height, weight: req.weight, chest: req.chest, waist: req.waist, legs: req.legs });
}
