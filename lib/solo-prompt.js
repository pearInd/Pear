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

   v2 (2026-09-30, the first measurement: "the smoothest turn yet, the front perfect - but the back
   was not the right drawing"). The real rear print is SMALL - one line, "10th & 11th Aug. 1996", over
   a small black "oasis" label - and the render drew a large black graphic block across the back. Two
   causes, two changes:
     · the words: v1's back read "Text ... above a black box containing the white text 'oasis'", with
       no size, and "a black box" was drawn big. The model is now asked for each print's SIZE relative
       to the garment and its PLACE, and to say "the rest ... is plain" - the reference's own proportions,
       in words (the vendor's guide: describe what it actually shows, explicitly);
     · the pixels: in a two-photo reference each print gets about a quarter fewer pixels than in one
       photo, and most of each photo is the model's head, legs and backdrop. The same call now returns
       each photo's garment box (box_2d) and garmentCropFrom() turns it into the crop the room makes
       before stitching - collar to hem, both sleeves, the garment still on the body (its length stays
       readable), roughly doubling each print's size in the reference.

   NEVER THROWS for a description it cannot make: a failure returns the frame with a generic
   garment phrase (source "fallback"), so the experiment still runs. Only a 429 throws, so the
   endpoint can tell "declined" from "never asked" and cache only the former.
   ============================================================================= */

export const SOLO_PROMPT_VERSION = 3;
const SOLO_PROMPT_MAX = 640;          // under the wire cap (PROMPT_MAX_CHARS 650)
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const DESCRIBE_INSTRUCTION = [
  "You write the text for a real-time virtual try-on model. You are shown two product photos of",
  "ONE garment: the first image is its FRONT, the second is its BACK. The garment may be worn by a",
  "model - describe the GARMENT only, never the model, the pose or the background.",
  "",
  "Return JSON:",
  "  garment   - 8 to 14 words: the garment type, colour, fabric, fit and silhouette, INCLUDING where",
  "              the hem falls on the body (e.g. cropped above the waist, hip-length, reaching the upper",
  "              thigh), the neckline and the sleeves. No brand names unless printed on it.",
  "  front     - at most 22 words: every print, graphic or embroidery on the FRONT - for EACH one its",
  "              SIZE relative to the garment (small, about a third of the width, large covering most of",
  "              the chest), its PLACE (centered on the chest, left chest, running down the center), its",
  "              colours, and any printed text quoted exactly. The word plain alone if there is nothing.",
  "  back      - at most 26 words: the same for the BACK, ending with what is plain (e.g. 'rest of the",
  "              back plain'). Be exact about size: a small label must never read as a large block.",
  "  front_box - the tight box around the garment in image 1, [ymin, xmin, ymax, xmax], 0-1000:",
  "              collar to hem, sleeve edge to sleeve edge; never the head, legs or other clothing.",
  "  back_box  - the same for the garment in image 2.",
  "Write in English. Do not start the garment phrase with 'a photo of'. Invent nothing.",
].join("\n");

const clean = (s, maxWords) => {
  const words = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/[.;,:\s]+$/, "").split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ").replace(/[.;,:\s]+$/, "");
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
  /* Word caps are only a runaway guard (the model is asked for 14/22/26): the budget loop below is
     what fits the frame, and it knows which part may give way. */
  let garment = clean(desc && desc.garment, 24) || "the garment exactly as shown in the reference image";
  let front = clean(desc && desc.front, 40);
  let back = clean(desc && desc.back, 48);
  const build = () => [
    `Substitute the ${bottom ? "lower" : "upper"} body garment with ${garment}.`,
    "The reference shows it from two sides: front on the left, back on the right.",
    `Facing the camera, show the front${isPlain(front) ? " (plain)" : `: ${front}`}.`,
    `Back to the camera, show the back exactly as in the reference${isPlain(back) ? ", plain" : `: ${back}`}.`,
    bottom ? "Keep the person's own top and shoes." : "Keep the person's own pants, legs and shoes.",
  ].join(" ");
  /* Over budget, in this order - the back is what this frame exists to get right, so it gives way
     LAST: whole clauses of the front (it is what the engine already draws well), the garment phrase's
     last clause, the front word by word down to 8, the garment down to 8 words, and only then the
     back, clause by clause, never its closing "... plain" clause while another one remains. Clauses,
     not words, wherever possible - a phrase cut mid-way ("and a small.") reads as a garment detail. */
  const clauses = (t) => t.split(/(?<=[;,])\s+/);
  const tidy = (t) => t.replace(/[.;,:\s]+$/, "");
  const dropLastClause = (t) => { const c = clauses(t); return c.length > 1 ? tidy(c.slice(0, -1).join(" ")) : null; };
  const dropBackClause = (t) => {
    const c = clauses(t);
    if (c.length < 2) return null;
    const last = c[c.length - 1];
    return tidy((/plain/i.test(last) && c.length > 2 ? [...c.slice(0, -2), last] : c.slice(0, -1)).join(" "));
  };
  let text = build();
  let guard = 200;
  while (text.length > SOLO_PROMPT_MAX && guard-- > 0) {
    let next;
    if ((next = dropLastClause(front))) front = next;
    else if (garment.split(" ").length > 8 && (next = dropLastClause(garment))) garment = next;
    else if (front.split(" ").length > 8) front = tidy(front.split(" ").slice(0, -1).join(" "));
    else if (garment.split(" ").length > 8) garment = tidy(garment.split(" ").slice(0, -1).join(" "));
    else if ((next = dropBackClause(back))) back = next;
    else if (back.split(" ").length > 6) back = tidy(back.split(" ").slice(0, -1).join(" "));
    else break;
    text = build();
  }
  return text.slice(0, SOLO_PROMPT_MAX);
}

/* The crop the room makes of one photo before stitching, from the model's garment box - or null
   (the photo goes whole). Margins as a share of the box: generous at the sleeves, thin at the collar
   and the hem, where the chin and the trousers' waistband begin. A box that is unsure, tiny, or would
   keep nearly the whole photo is not worth a crop. Pure. */
const PAD_SIDE = 0.06, PAD_TOP = 0.02, PAD_BOTTOM = 0.015, MIN_SIDE = 0.12, KEEP_MAX = 0.9;
export function garmentCropFrom(box, region) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(Number(v)))) return null;
  /* 0-1000 is what the model is asked for; a box it wrote on a 0-1 scale is read as that (v3: the
     first v2 answer for the OASIS rear photo came back with no usable box, and a 0-1 box would have
     read as a 1-pixel one and been refused as tiny). */
  const scale = box.every((v) => Number(v) >= 0 && Number(v) <= 1) ? 1 : 1000;
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.max(0, Math.min(scale, Number(v))) / scale);
  const bw = xmax - xmin, bh = ymax - ymin;
  if (!(bw >= MIN_SIDE) || !(bh >= MIN_SIDE)) return null;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const top = region === "bottom" ? PAD_BOTTOM : PAD_TOP, bottom = region === "bottom" ? PAD_TOP : PAD_BOTTOM;
  const c = { x0: clamp(xmin - PAD_SIDE * bw), y0: clamp(ymin - top * bh), x1: clamp(xmax + PAD_SIDE * bw), y1: clamp(ymax + bottom * bh) };
  if ((c.x1 - c.x0) * (c.y1 - c.y0) > KEEP_MAX) return null;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return { x0: r4(c.x0), y0: r4(c.y0), x1: r4(c.x1), y1: r4(c.y1) };
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
 * @returns {Promise<{prompt:string, desc:object|null, crops:{front:object|null, back:object|null}|null, source:"gemini"|"fallback"|"unconfigured"}>}
 * @throws only on HTTP 429.
 */
export async function soloPromptFor({ front, back, region }, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const reg = region === "bottom" ? "bottom" : "top";
  if (!apiKey) return { prompt: soloPromptFrom(null, reg), desc: null, crops: null, source: "unconfigured" };
  let parts;
  try {
    parts = await Promise.all([fetchImagePart(front, fetchImpl), fetchImagePart(back, fetchImpl)]);
  } catch (e) {
    console.warn("[solo-prompt] photos unreadable:", e?.message || e);
    return { prompt: soloPromptFrom(null, reg), desc: null, crops: null, source: "fallback" };
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
            properties: {
              garment: { type: "STRING" }, front: { type: "STRING" }, back: { type: "STRING" },
              front_box: { type: "ARRAY", items: { type: "NUMBER" } },
              back_box: { type: "ARRAY", items: { type: "NUMBER" } },
            },
            required: ["garment", "front", "back", "front_box", "back_box"],
          },
        },
      }),
    });
  } catch (e) {
    console.warn("[solo-prompt] model unreachable:", e?.message || e);
    return { prompt: soloPromptFrom(null, reg), desc: null, crops: null, source: "fallback" };
  }
  if (!resp.ok) {
    if (resp.status === 429) {
      const err = new Error("Gemini 429 (rate limited)");
      err.rateLimited = true;
      throw err;
    }
    console.warn("[solo-prompt] model HTTP " + resp.status);
    return { prompt: soloPromptFrom(null, reg), desc: null, crops: null, source: "fallback" };
  }
  let desc = null;
  try {
    const data = await resp.json();
    desc = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "null");
  } catch { desc = null; }
  if (!desc || typeof desc.garment !== "string" || !desc.garment.trim()) {
    return { prompt: soloPromptFrom(null, reg), desc: null, crops: null, source: "fallback" };
  }
  const d = { garment: clean(desc.garment, 18), front: clean(desc.front, 30), back: clean(desc.back, 30) };
  const crops = { front: garmentCropFrom(desc.front_box, reg), back: garmentCropFrom(desc.back_box, reg) };
  /* The raw boxes travel with the answer - four numbers each, nothing else - so a crop that comes back
     null can be read off the endpoint instead of guessed at. */
  const boxes = { front: Array.isArray(desc.front_box) ? desc.front_box.slice(0, 4) : null,
                  back: Array.isArray(desc.back_box) ? desc.back_box.slice(0, 4) : null };
  return { prompt: soloPromptFrom(d, reg), desc: d, crops, boxes, source: "gemini" };
}
