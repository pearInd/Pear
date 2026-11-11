/* =============================================================================
   PEAR · How does the garment sit on the store's model? (the fit read from the photo)
   -----------------------------------------------------------------------------
   REPORTED 2026-11-11 (the owner, a pink football jersey on terminalx, three TEST clips): "the belly looks too big at
   the start, as if I had a paunch" - and his direction: "it has to be done by the model's photo". Until now the fit
   sentence a top's prompt carries came from a fixed table keyed on the size delta alone (lib/prompts.js
   getFitModifier()): every true-to-size top was "perfectly tailored", whatever its cut, and nothing said where the
   hem ends. The store's own photo of the garment WORN shows both.

   WHAT IT ANSWERS: for one product photo of an UPPER-body garment, how it sits on the person wearing it -
     cut: "fitted" | "regular" | "relaxed" | "oversized"      hem: "waist" | "hip" | "below-hip" | "thigh"
   - or null: no person in the photo (a packshot), the garment not whole in it, an unsure or malformed answer.
   The room asks for the product's gallery photos (GET /api/garment-fit) in a TEST session and hands the first read
   to the prompt engine as two facts (fitCut / fitHem); lib/prompts.js builds the fit sentence from them.

   NEVER THROWS for an answer it cannot make - only a rate limit (429) throws (lib/garment-box.js's rule), so the
   endpoint caches verdicts and never a throttle.
   ============================================================================= */
import { geminiReplyText, geminiReplyShape, parseGeminiJson, MODEL_REPLY_MAX_TOKENS } from "./model-reply.js";
import { analysisUrl, fetchImageAsBase64 } from "./garment-box.js";

/* Bump when the question or the rule changes: it is part of the endpoint's cache key. */
export const GARMENT_FIT_VERSION = 1;

const GEMINI_MODEL = "gemini-3.1-flash-lite";   // the classifier's model (lib/garment-box.js)
export const FIT_CUTS = ["fitted", "regular", "relaxed", "oversized"];
export const FIT_HEMS = ["waist", "hip", "below-hip", "thigh"];
const MIN_CONFIDENCE = 0.6;

export function garmentFitPrompt() {
  return [
    "You describe how one garment sits on the person wearing it in a clothing product photograph.",
    "",
    "The product being sold is a garment worn on the UPPER body (t-shirt, shirt, polo, jersey, sweater, hoodie, jacket).",
    "",
    "Return JSON:",
    "  worn_by_person - true if a person or model is wearing it; false for a flat-lay, a hanger, a ghost mannequin",
    "                   or a packshot with no person.",
    "  view           - which side of the person faces the camera: \"front\", \"back\", \"side\" or \"other\".",
    "  whole_garment  - true if the garment is visible from its collar to its lowest hem (not cropped, not a close-up).",
    "  cut            - how the garment fits THIS person, judged from the fabric, not from the person's build:",
    "                   \"fitted\"    - the fabric follows the torso closely, almost no slack;",
    "                   \"regular\"   - a little ease, the fabric hangs straight from the chest;",
    "                   \"relaxed\"   - clearly loose, visible slack around the torso and sleeves;",
    "                   \"oversized\" - very loose, dropped shoulder seams, wide body.",
    "  hem            - where the garment's lowest hem ends on this person:",
    "                   \"waist\"     - at the trouser waistband or above it;",
    "                   \"hip\"       - it covers the waistband and ends around the hip bone;",
    "                   \"below-hip\" - it covers the hips and ends at the level of the crotch;",
    "                   \"thigh\"     - it ends at mid-thigh or lower.",
    "  confidence     - 0..1, how sure you are of cut and hem.",
    "If no person wears the garment, or it is not whole in the photo, set confidence to 0.",
  ].join("\n");
}

/**
 * The fit to hand the prompt engine, from the model's answer - or null. Pure; the endpoint and the unit test share it.
 * @param {{worn_by_person?: boolean, view?: string, whole_garment?: boolean, cut?: string, hem?: string, confidence?: number}|null} det
 * @returns {{fit: {cut: string, hem: string|null}|null, reason: string, view: string|null}}
 */
export function garmentFitFromDetection(det) {
  if (!det || typeof det !== "object") return { fit: null, reason: "no-answer", view: null };
  const view = ["front", "back", "side"].includes(det.view) ? det.view : null;
  if (det.worn_by_person !== true) return { fit: null, reason: "no-person", view };
  const conf = Number(det.confidence);
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return { fit: null, reason: "unsure", view };
  if (det.whole_garment !== true) return { fit: null, reason: "cropped", view };
  /* A side view shows the drape, not the cut across the chest and shoulders - the two views the reference has. */
  if (view !== "front" && view !== "back") return { fit: null, reason: "side-view", view };
  if (!FIT_CUTS.includes(det.cut)) return { fit: null, reason: "no-cut", view };
  return { fit: { cut: det.cut, hem: FIT_HEMS.includes(det.hem) ? det.hem : null }, reason: "fit", view };
}

/**
 * Ask the model how the garment sits on the person in one photo.
 * @param {string} imageUrl  a public product photo
 * @param {string} apiKey
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{fit: object|null, reason: string, view: string|null, source: "ai"|"error"}>}
 */
export async function detectGarmentFit(imageUrl, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = String(imageUrl || "");
  if (!apiKey) return { fit: null, reason: "no-key", view: null, source: "error" };
  let image;
  try {
    image = await fetchImageAsBase64(analysisUrl(url), fetchImpl);
  } catch (e) {
    console.warn("[garment-fit] image unreadable (" + url.slice(0, 120) + "):", e?.message || e);
    return { fit: null, reason: "image-unreadable", view: null, source: "error" };
  }
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + apiKey;
  let resp;
  try {
    resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: garmentFitPrompt() }] },
        contents: [{ parts: [
          { text: "How does the garment sit on the person in this photo?" },
          { inline_data: { mime_type: image.mimeType, data: image.base64 } },
        ] }],
        generationConfig: {
          temperature: 0,   // the same photo must read the same on every visit
          maxOutputTokens: MODEL_REPLY_MAX_TOKENS,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              worn_by_person: { type: "BOOLEAN" },
              view: { type: "STRING", enum: ["front", "back", "side", "other"] },
              whole_garment: { type: "BOOLEAN" },
              cut: { type: "STRING", enum: FIT_CUTS },
              hem: { type: "STRING", enum: FIT_HEMS },
              confidence: { type: "NUMBER" },
            },
            required: ["worn_by_person", "confidence"],
          },
        },
      }),
    });
  } catch (e) {
    console.warn("[garment-fit] model request failed for " + url.slice(0, 120) + ":", e?.message || e);
    return { fit: null, reason: "model-unreachable", view: null, source: "error" };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    if (resp.status === 429) {
      const err = new Error("classifier 429 (rate limited): " + body.slice(0, 200));
      err.status = 429;
      err.rateLimited = true;
      throw err;
    }
    console.warn("[garment-fit] model HTTP " + resp.status + " for " + url.slice(0, 120));
    return { fit: null, reason: "HTTP " + resp.status, view: null, source: "error" };
  }
  let data;
  try { data = await resp.json(); } catch { data = null; }
  const det = parseGeminiJson(geminiReplyText(data), { salvage: false });
  if (!det) {
    const { finish, parts } = geminiReplyShape(data);
    console.warn("[garment-fit] unparseable reply (finish=" + finish + ", parts=" + parts + ") for " + url.slice(0, 120));
    return { fit: null, reason: "unparseable", view: null, source: "error" };
  }
  return { ...garmentFitFromDetection(det), source: "ai" };
}
