/* =============================================================================
   PEAR · Reading the vision model's JSON reply - one reader for every call
   -----------------------------------------------------------------------------
   THE WHOLE REPLY (2026-10-31, server.js's classifier; shared here 2026-11-01 for the
   garment box, the garment category, the photo estimate and the title category).

   Every call read `candidates[0].content.parts[0].text` alone, and asked for an answer
   of unbounded length. Both failed on CHICAGO 3108650200's front photo: the model LOOPED
   inside a free-text field ("drawstring waistband and front-fa" then "23 23 23 ..." for
   65,656 chars, ~2 minutes, finishReason MAX_TOKENS), the cut body was "unparseable", and
   every visit to that product waited on the loop. The rules, for every caller:
     · read every non-thought text part, joined (geminiReplyText);
     · cap the answer (MODEL_REPLY_MAX_TOKENS) so a loop ends in seconds - a whole verdict
       is ~60-150 tokens; 4096 leaves room for a thinking model's own;
     · put free-text fields LAST (`propertyOrdering`), so the verdict is out before a loop;
     · a cut reply is a valid JSON PREFIX: keep every field that completed
       (salvageGeminiFields), but only when the caller's `required` fields all did - and a
       caller whose answer is an array (a box) asks for no salvage at all: a cut array is
       not a box, and an answer without its box must never be cached as "no box".
   Pure: no I/O, no globals. classify-reply.test.mjs runs it on every reply shape seen.
   ============================================================================= */

/** The cap every call asks for (generationConfig.maxOutputTokens). */
export const MODEL_REPLY_MAX_TOKENS = 4096;

/** Every non-thought text part of the first candidate, joined - "" when there is none. */
export function geminiReplyText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts)
    ? parts.filter((p) => p && !p.thought && typeof p.text === "string").map((p) => p.text).join("")
    : "";
}

/** Why a reply did not parse, for the log line: the finish reason and the part count. */
export function geminiReplyShape(data) {
  const c = data?.candidates?.[0];
  return { finish: c?.finishReason || "?", parts: Array.isArray(c?.content?.parts) ? c.content.parts.length : 0 };
}

/**
 * The reply as an object, or null. The whole text first, then its outermost {...}; then -
 * unless `salvage` is false - the fields that completed before a cut, but only when every
 * `required` field is among them (and at least one field came through).
 * @param {string} text
 * @param {{required?: string[], salvage?: boolean}} [opts]
 * @returns {object|null}
 */
export function parseGeminiJson(text, { required = [], salvage = true } = {}) {
  if (typeof text !== "string" || !text) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch (_) { /* fall through */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { const v = JSON.parse(text.slice(a, b + 1)); if (v && typeof v === "object") return v; } catch (_) { /* fall through */ }
  }
  if (!salvage) return null;
  const got = salvageGeminiFields(text);
  if (!got || !Object.keys(got).length) return null;
  return required.every((k) => got[k] !== undefined && got[k] !== null) ? got : null;
}

/* The scalar fields of a cut JSON object that completed - a string only when its closing quote arrived; arrays and nested
   objects are never salvaged. Exported for the tests. */
export function salvageGeminiFields(text) {
  if (typeof text !== "string" || text.indexOf("{") === -1) return null;
  const out = {};
  const re = /"([a-z_0-9]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)\s*(?=[,}])/g;
  let m;
  while ((m = re.exec(text))) {
    try { out[m[1]] = JSON.parse(m[2]); } catch (_) { /* a field that does not decode is not kept */ }
  }
  return out;
}
