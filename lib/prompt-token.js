/* =============================================================================
   PEAR · the prompt the page never holds (2026-11-02)
   -----------------------------------------------------------------------------
   THE GAP THIS CLOSES. The wording moved server-side on 2026-09-26 (CLAUDE.md §2.13), but the
   ASSEMBLED prompt still came back to the page in the /prompt answer, travelled in the signalling
   frames and returned in the engine's prompt_ack - readable in DevTools (§7.18). Now /prompt answers
   an opaque token and the edge's relay (lib/rt-proxy.js, cloudflare/orient/src/rt.js) turns it into
   the words on the way to the engine, and back into the token on the way to the room.

     pt1.<hash of the words>.<base64url of the sanitised request - facts the page already sent>

   THE HASH IS WHAT KEEPS THE ROOM'S DECISIONS. The room compares prompts with `===` to skip a
   no-op send, and different requests can produce the same words (a pose that changes no text, a
   size whose sentence was shed). requestWirePrompt() keeps the first token per hash, so those
   comparisons answer exactly as they did on the words.

   EVERY SESSION IS RELAYED: the room only reaches the engine through the edge (rtEdgeUrl, §2.24),
   so there is no path where a token reaches the engine unexpanded - as long as the Worker is
   deployed BEFORE any room or origin that hands out tokens. A plain prompt still passes the relay,
   so rooms already open keep working through that deploy.
   ============================================================================= */
import { promptWithShedForRequest, sanitizePromptRequest } from "./prompts.js";

const PREFIX = "pt1";
const MAX_TOKEN_CHARS = 16 * 1024;

const b64u = {
  enc(text) {
    let s = "";
    for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  },
};

/* An identity within one session, not a secret: two FNV-1a passes, synchronous in Node and in a Worker alike. */
function wordsHash(text) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** The token for one sanitised request. `where` is a log label and is left out. @returns {string} */
export function promptTokenForRequest(req) {
  const { prompt } = promptWithShedForRequest(req);
  const { kind, angle, inProfile, delta, item, test } = req;
  return `${PREFIX}.${wordsHash(prompt)}.${b64u.enc(JSON.stringify({ kind, angle, inProfile, delta, item, ...(test ? { test } : {}) }))}`;
}

/**
 * The words for a token, or null when it is not one of ours. The request goes through the same
 * sanitiser as a /prompt body, because the page can write anything into it.
 * @returns {{prompt: string, shed: string[], kind: string, angle: string, delta: number, test: boolean}|null}
 */
export function expandPromptToken(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const req = sanitizePromptRequest({ ...JSON.parse(b64u.dec(parts[2])), where: "relay" });
    const { prompt, shed } = promptWithShedForRequest(req);
    return { prompt, shed, kind: req.kind, angle: req.angle, delta: req.delta, test: req.test === true };
  } catch {
    return null;
  }
}
