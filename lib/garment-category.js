/* =============================================================================
   PEAR · Garment category classification (Gemini Vision)
   -----------------------------------------------------------------------------
   "Which body region is this garment worn on?", answered from the PHOTOGRAPH.

   WHY THIS IS A SEPARATE CALL, AND NOT ANOTHER FIELD ON THE FRONT/BACK ONE
   ────────────────────────────────────────────────────────────────────────
   classifyFrontBackDetailed() in server.js already asks Gemini five questions about
   the same photo, so a sixth looks free. It is not. That call is stamped with
   CLASSIFIER_PROMPT_VERSION, and server.js treats every row carrying an older stamp
   as a cache miss - so widening its prompt means bumping the version and forcing a
   ONE-TIME RE-CLASSIFICATION OF THE ENTIRE CATALOG, spread across live traffic and
   rate-spaced per call. A garment-category feature is not worth re-deriving every
   front/back verdict in the database, and re-deriving them risks moving a verdict
   that is currently correct - see archive/supabase_setup_v12.sql on how expensive a
   single wrong front/back verdict turned out to be. Its own prompt, its own column,
   no version bump.

   WHY IT IS A MODULE RATHER THAN A FUNCTION INSIDE server.js
   ──────────────────────────────────────────────────────────
   scripts/backfill-garment-categories.js needs exactly this classifier, and server.js
   starts an HTTP listener on import - so importing it from a CLI script is not an
   option. This repo already has a standing problem with logic that had to be copied
   instead (CLAUDE.md §3 lists six such pairs, each with a "whichever is wrong is the
   one that wins" note). One module imported twice is strictly better than a seventh
   pair to keep in lockstep.

   NEVER THROWS FOR A CLASSIFICATION IT CANNOT MAKE. A missing key, an HTTP error, an
   unreadable image or a malformed body all resolve to "unknown" with the reason in
   `source`. Only a rate limit (429) throws, because the caller MUST be able to tell
   "the model declined" from "we never got to ask" - a backfill that recorded a
   throttled request as a verdict would burn that row permanently, which is precisely
   the mistake archive/supabase_setup_v8.sql was written to make visible.
   ============================================================================= */

/* ── THE PROMPT ────────────────────────────────────────────────────────────────
   THE FAILURE IT IS WRITTEN AGAINST: a first pass that simply asked "top or bottom?"
   answered "top" for a flat-lay of folded jeans shot from above. A rectangle of fabric
   with one horizontal crease reads as a folded shirt unless something tells the model
   what to look for, so the decisive cues are named explicitly and the model is told to
   read the GARMENT rather than the styling, the background or the model's pose.

   "unknown" IS A FIRST-CLASS ANSWER and the prompt says so twice. This verdict routes a
   shopper onto a different SIZE CHART, so a confident wrong answer costs them a size
   they cannot buy, while an abstention costs nothing - the fitting room's text tiers
   (the size run, then the title) are still in play behind it. That is CLAUDE.md §2.5 in
   its original form: never block on ambiguity, and never let a guess outrank a verdict. */
export const GARMENT_CATEGORY_PROMPT = [
  "You classify a single clothing product photograph by the BODY REGION the garment is worn on.",
  "",
  "Answer with exactly one of:",
  "",
  '  "pants"   - worn on the LOWER body. Trousers, jeans, chinos, cargo trousers, shorts,',
  "              bermudas, skirts, leggings, tights, joggers, sweatpants, culottes.",
  "              DECISIVE CUES: two separate leg openings; a waistband with belt loops,",
  "              a fly, a zip or a drawstring along the TOP edge; back pockets; an inseam",
  "              running from crotch to hem; for a skirt, a single tube hanging from a",
  "              waistband with no sleeves and no neckline anywhere in the photo.",
  '  "top"     - worn on the UPPER body. T-shirts, shirts, blouses, polos, sweaters,',
  "              hoodies, sweatshirts, jackets, coats, blazers, cardigans, vests, tanks.",
  "              DECISIVE CUES: a neckline or collar; sleeves or armholes; a shoulder seam.",
  '  "dress"   - a SINGLE garment covering BOTH regions: dresses, jumpsuits, rompers,',
  "              overalls, playsuits. If it has a neckline AND continues past the hip as",
  '              one piece, it is "dress" - not "top" and not "pants".',
  '  "unknown" - you cannot tell from this photograph.',
  "",
  "HOW TO DECIDE",
  "- Read the GARMENT, not the scene. Ignore the background, the pose, the styling, the",
  "  colour, the print, and any other clothing the model is also wearing.",
  "- A worn photo usually shows several garments. Classify the one that is the SUBJECT of",
  "  the photograph - the item in focus, centred, or shown in full while others are",
  "  cropped. If two garments are equally prominent and you cannot tell which one is being",
  '  sold, answer "unknown".',
  "- A folded flat-lay is the single most misread case. Folded trousers make a rectangle",
  "  with a horizontal crease that resembles a folded shirt. Before answering \"top\" on a",
  "  flat-lay, look for a NECKLINE or a SLEEVE. If there is no neckline and no sleeve",
  "  anywhere in the frame, it is not a top.",
  "- A close-up detail shot (a pocket, a button, a fabric swatch, a care label) usually",
  '  cannot support any answer. Answer "unknown" rather than inferring from the fabric.',
  "",
  'ABSTAIN RATHER THAN GUESS. "unknown" is a correct and useful answer. Downstream code',
  "falls back to evidence it already holds when you abstain, but treats a stated category",
  "as a verdict and acts on it. If your confidence is below 0.7 you must answer \"unknown\".",
  "",
  "Also return:",
  "  confidence - 0..1, your confidence in the category above.",
  "  cue        - the ONE visual feature that decided it, under 12 words",
  '               (e.g. "two leg openings and a belt-looped waistband").',
].join("\n");

/* The four values garment_cache.garment_category accepts - the CHECK constraint in
   archive/supabase_setup_v13.sql carries the same list. Anything else the model invents
   is coerced to "unknown" HERE rather than reaching the database and failing the write. */
const VALID_CATEGORIES = new Set(["pants", "top", "dress", "unknown"]);

/** @param {unknown} raw @returns {"pants"|"top"|"dress"|"unknown"} */
export function normalizeGarmentCategory(raw) {
  const v = String(raw == null ? "" : raw).toLowerCase().trim();
  if (VALID_CATEGORIES.has(v)) return v;
  /* The synonyms the model reaches for when it drifts off the enum. Mapped rather than
     dropped: "bottom" is unambiguously the same answer as "pants", and discarding it
     would spend a whole Gemini call to record "unknown". */
  if (v === "bottom" || v === "bottoms" || v === "lower_body" || v === "trousers") return "pants";
  if (v === "tops" || v === "upper_body" || v === "shirt") return "top";
  if (v === "jumpsuit" || v === "romper" || v === "overall") return "dress";
  return "unknown";
}

/* Same model the front/back classifier uses (GEMINI_CLASSIFY_URL in server.js). Kept
   here as its own constant rather than imported, because importing it would mean
   importing server.js - see this file's header. */
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

async function fetchImageAsBase64(imageUrl) {
  /* https, always. A mixed-content http:// URL is refused by some CDNs when fetched
     from a TLS origin, and the scanner and the widget have each produced both spellings
     of the same photo - which is why URL spelling is never trusted for identity either
     (canonicalImageUrl, CLAUDE.md §2.2). */
  const secure = String(imageUrl).replace(/^http:\/\//i, "https://");
  const resp = await fetch(secure);
  if (!resp.ok) throw new Error("image fetch failed: HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("image too large: " + buf.byteLength + " bytes");
  }
  return {
    base64: buf.toString("base64"),
    mimeType: resp.headers.get("content-type") || "image/jpeg",
  };
}

/**
 * Classify one product photograph by the body region its garment is worn on.
 *
 * @param {string} imageUrl
 * @param {string} apiKey - GEMINI_API_KEY. Empty/absent resolves to "unconfigured".
 * @returns {Promise<{garment_category: "pants"|"top"|"dress"|"unknown", confidence: number,
 *                    cue: string, source: "gemini"|"unconfigured"|"error"}>}
 *   `source` separates a real verdict from a default - exactly the distinction
 *   archive/supabase_setup_v8.sql exists to make. Only source === "gemini" is a verdict.
 * @throws only on HTTP 429 - see this module's header on why a throttle must never be
 *   recorded as an answer.
 */
export async function classifyGarmentFull(imageUrl, apiKey) {
  const url = String(imageUrl || "").trim();
  if (!url) return { garment_category: "unknown", confidence: 0, cue: "no image url", source: "error" };
  if (!apiKey) return { garment_category: "unknown", confidence: 0, cue: "no API key", source: "unconfigured" };

  let image;
  try {
    image = await fetchImageAsBase64(url);
  } catch (e) {
    console.warn("[garment-category] image unreadable (" + url.slice(0, 120) + "):", e?.message || e);
    return { garment_category: "unknown", confidence: 0, cue: "image unreadable", source: "error" };
  }

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL + ":generateContent?key=" + apiKey;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: GARMENT_CATEGORY_PROMPT }] },
      contents: [{
        parts: [
          { text: "Which body region is this garment worn on?" },
          { inline_data: { mime_type: image.mimeType, data: image.base64 } },
        ],
      }],
      generationConfig: {
        /* Deterministic, for the reason classifyFrontBackDetailed() records: the same
           photograph must not classify differently between the backfill script's run
           and the live endpoint, or the cache and the live session disagree about it. */
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            garment_category: { type: "STRING", enum: ["pants", "top", "dress", "unknown"] },
            confidence: { type: "NUMBER" },
            cue: { type: "STRING" },
          },
          required: ["garment_category", "confidence"],
        },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 429) {
      /* THROWS, alone among the failure modes. A throttled request is not a verdict, and
         a backfill that wrote "unknown" here would permanently stop the endpoint ever
         re-asking for that photo: the row would read as "the model looked and declined"
         forever. The caller retries or stops - it must not persist this. */
      const err = new Error("Gemini 429 (rate limited): " + body.slice(0, 200));
      err.status = 429;
      err.rateLimited = true;
      throw err;
    }
    console.warn("[garment-category] Gemini HTTP " + resp.status + " for " + url.slice(0, 120));
    return { garment_category: "unknown", confidence: 0, cue: "HTTP " + resp.status, source: "error" };
  }

  let parsed;
  try {
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    parsed = JSON.parse(text);
  } catch {
    /* responseMimeType should make this unreachable. Treated as an abstention rather
       than string-matched: server.js records what happened the last time a model body
       was probed with .includes() - "not the back" was read as a back. */
    console.warn("[garment-category] unparseable body for " + url.slice(0, 120));
    return { garment_category: "unknown", confidence: 0, cue: "unparseable response", source: "error" };
  }

  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  return {
    garment_category: normalizeGarmentCategory(parsed?.garment_category),
    confidence,
    cue: typeof parsed?.cue === "string" ? parsed.cue.slice(0, 120) : "",
    source: "gemini",
  };
}
