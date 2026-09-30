/* =============================================================================
   PEAR · The SOLO EXPERIMENT's prompt (?exp=solo, 2026-09-30)
   -----------------------------------------------------------------------------
   THE QUESTION THE EXPERIMENT ASKS: can the render engine itself tell the front of a garment
   from its back, if it is handed ONE reference that shows both sides and told in words which is
   which - with no front/back swapping by the room at all? Asked by the shopper after reading the
   vendor's own guidance, which the room's normal prompt does not follow:
     · "Substitute the [region] with [description]" - a concrete description of the garment the
       reference shows (colour, fabric, fit, silhouette, neckline, print), not instructions;
     · "The reference image is the source of truth... describe what it actually shows";
     · roughly 750 characters at most (our wire cap is PROMPT_MAX_CHARS, 650).
   This module writes that prompt: the classifier's vision model describes the garment from the
   store's own front and back photos (once per product, cached by the endpoint), and
   soloPromptFrom() puts the description into a fixed sentence frame that names the two halves of
   the stitched reference (front LEFT, back RIGHT - the room's createSoloComposite()).

   WHAT IS ALREADY KNOWN AND NOT HIDDEN HERE: a stitched FRONT|BACK reference was tried in July on
   an older model and rendered fragments of both sides (23f5953); the 2026-09-16 re-evaluation
   found it held only with a panel contract in the prompt AND the room naming the half in play.
   This experiment removes the room's half-naming on purpose - it is the thing being measured,
   on lucy-vton-3.5, which was never tried.

   NEVER THROWS for a description it cannot make: a failure returns the frame with a generic
   garment phrase (source "fallback"), so the experiment still runs. Only a 429 throws, so the
   endpoint can tell "declined" from "never asked" and cache only the former.
   ============================================================================= */

export const SOLO_PROMPT_VERSION = 1;
const SOLO_PROMPT_MAX = 640;          // under the wire cap (PROMPT_MAX_CHARS 650)
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const DESCRIBE_INSTRUCTION = [
  "You write the text for a real-time virtual try-on model. You are shown two product photos of",
  "ONE garment: the first image is its FRONT, the second is its BACK. The garment may be worn by a",
  "model - describe the GARMENT only, never the model, the pose or the background.",
  "",
  "Return JSON:",
  "  garment - 12 to 25 words: the garment type, colour, fabric, fit and silhouette, INCLUDING where",
  "            the hem falls on the body (for example cropped above the waist, hip-length, reaching",
  "            the upper thigh, ankle-length), the neckline and the sleeves. No brand names unless",
  "            they are printed on the garment. Nothing that is not visible.",
  "  front   - at most 18 words: only what is printed, embroidered or placed on the FRONT, with any",
  "            printed text quoted exactly as written; the word plain if there is nothing.",
  "  back    - at most 18 words: the same for the BACK; the word plain if there is nothing.",
  "Write in English. Do not start the garment phrase with 'a photo of'.",
].join("\n");

const clean = (s, maxWords) => {
  const words = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/[.;,\s]+$/, "").split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
};
const isPlain = (s) => !s || /^(plain|none|nothing|n\/a|no print|blank)$/i.test(String(s).trim());

/**
 * The wire prompt from a description (or from nothing: the fallback frame). Pure.
 * @param {{garment?:string, front?:string, back?:string}|null} desc
 * @param {"top"|"bottom"} region
 * @returns {string} at most SOLO_PROMPT_MAX characters
 */
export function soloPromptFrom(desc, region) {
  const bottom = region === "bottom";
  let garment = clean(desc && desc.garment, 25) || "the garment exactly as shown in the reference image";
  let front = clean(desc && desc.front, 18);
  let back = clean(desc && desc.back, 18);
  const build = () => [
    `Substitute the ${bottom ? "lower" : "upper"} body garment with ${garment}.`,
    "The reference image shows this same garment from two sides: its front on the left, its back on the right.",
    `When the person faces the camera, show the front${isPlain(front) ? "" : `: ${front}`}.`,
    `When the person turns their back to the camera, show the back${isPlain(back) ? ", which is plain" : `: ${back}`}.`,
    bottom ? "Keep the person's own top and shoes." : "Keep the person's own pants, legs and shoes.",
  ].join(" ");
  let text = build();
  /* Over budget: the print details give way first, one word at a time, then the garment phrase -
     the two-sided frame itself is never cut. */
  while (text.length > SOLO_PROMPT_MAX) {
    const f = front.split(" "), b = back.split(" "), g = garment.split(" ");
    if (b.length > 4 && b.length >= f.length) back = b.slice(0, -1).join(" ");
    else if (f.length > 4) front = f.slice(0, -1).join(" ");
    else if (g.length > 6) garment = g.slice(0, -1).join(" ");
    else break;
    text = build();
  }
  return text.slice(0, SOLO_PROMPT_MAX);
}

async function fetchImagePart(url, fetchImpl) {
  const secure = String(url).replace(/^http:\/\//i, "https://");
  const resp = await fetchImpl(secure, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error("image fetch failed: HTTP " + resp.status);
  const type = resp.headers.get("content-type") || "image/jpeg";
  if (!/^image\//i.test(type)) throw new Error("not an image: " + type);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large: " + buf.byteLength + " bytes");
  return { inline_data: { mime_type: type, data: buf.toString("base64") } };
}

/**
 * Describe the garment from its front and back photos and return the wire prompt.
 * @returns {Promise<{prompt:string, desc:object|null, source:"gemini"|"fallback"|"unconfigured"}>}
 * @throws only on HTTP 429.
 */
export async function soloPromptFor({ front, back, region }, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const reg = region === "bottom" ? "bottom" : "top";
  if (!apiKey) return { prompt: soloPromptFrom(null, reg), desc: null, source: "unconfigured" };
  let parts;
  try {
    parts = await Promise.all([fetchImagePart(front, fetchImpl), fetchImagePart(back, fetchImpl)]);
  } catch (e) {
    console.warn("[solo-prompt] photos unreadable:", e?.message || e);
    return { prompt: soloPromptFrom(null, reg), desc: null, source: "fallback" };
  }
  let resp;
  try {
    resp = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL +
      ":generateContent?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: DESCRIBE_INSTRUCTION }] },
        contents: [{ parts: [{ text: "Image 1 is the FRONT, image 2 is the BACK." }, parts[0], parts[1]] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { garment: { type: "STRING" }, front: { type: "STRING" }, back: { type: "STRING" } },
            required: ["garment", "front", "back"],
          },
        },
      }),
    });
  } catch (e) {
    console.warn("[solo-prompt] model unreachable:", e?.message || e);
    return { prompt: soloPromptFrom(null, reg), desc: null, source: "fallback" };
  }
  if (!resp.ok) {
    if (resp.status === 429) {
      const err = new Error("Gemini 429 (rate limited)");
      err.rateLimited = true;
      throw err;
    }
    console.warn("[solo-prompt] model HTTP " + resp.status);
    return { prompt: soloPromptFrom(null, reg), desc: null, source: "fallback" };
  }
  let desc = null;
  try {
    const data = await resp.json();
    desc = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "null");
  } catch { desc = null; }
  if (!desc || typeof desc.garment !== "string" || !desc.garment.trim()) {
    return { prompt: soloPromptFrom(null, reg), desc: null, source: "fallback" };
  }
  const d = { garment: clean(desc.garment, 25), front: clean(desc.front, 18), back: clean(desc.back, 18) };
  return { prompt: soloPromptFrom(d, reg), desc: d, source: "gemini" };
}
