/* ============================================================================
   rt-proxy.js — the render engine behind our own edge (2026-10-03)
   ----------------------------------------------------------------------------
   ASKED: "nobody should see anything related to the render engine or any AI we use -
   put it on Cloudflare's servers." Until now the room opened the engine's signalling
   socket itself (its host, its model id and its key format in the URL), the engine
   handed back a media-server URL the room connected to by name, and the engine's SDK
   posted telemetry to the engine's own host. All of it was readable in the Network tab.

   NOW THE ROOM SPEAKS A NEUTRAL DIALECT TO OUR EDGE (the orientation Worker, rt.<ours>),
   and this module is the translation, pure functions shared by the Worker and the tests:
     · signalling   wss://<edge>/v/s?api_key=<ticket>&model=v&c1=…&user_agent=rt-js/…
                    -> the engine's URL, real key, real model, real query names
                    frames: the room's aliases (scripts/build.mjs RT_RENAME) <-> real words
     · media        the engine's media URL and token come back SEALED as wss://<edge>/k/<sealed>,
                    and /k/<sealed>/… is opened back to the real host with the token unsealed
     · telemetry    POST /m -> the engine's telemetry endpoint, key unsealed, model mapped back
   The ticket is SEALED (sealTicket): the engine's key never reaches the page in readable
   form - the token route (server.js) seals what it mints, only the edge opens it.

   WHAT THIS IS NOT: a lock. A ticket is as usable through our edge as the key it seals
   was directly (same lifetime, same origin scoping); what changed is that nothing the
   page can read names the engine. The seal key lives in this file, server-side.
   ============================================================================ */

/* ── THE SEAL: XOR + base64url with a check byte. Obfuscation for names and keys in transit to
   OUR edge - never a credential of its own (the ticket IS the short-lived key). ─────────────── */
const SEAL = new TextEncoder().encode("pear:rt:seal:v1:8c4f0b2e9d7a61f35e0c94b2a7d8136f");
const b64u = {
  enc(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};
/** @param {string} text @returns {string} an opaque, URL-safe token for `text` */
export function sealTicket(text) {
  const raw = new TextEncoder().encode(String(text));
  const out = new Uint8Array(raw.length + 1);
  let sum = 0x5a;
  for (let i = 0; i < raw.length; i++) { out[i] = raw[i] ^ SEAL[i % SEAL.length]; sum = (sum + raw[i] * (i + 1)) & 0xff; }
  out[raw.length] = sum;
  return "p" + b64u.enc(out);
}
/** @param {string} token @returns {string|null} what sealTicket() sealed, or null for anything else */
export function openTicket(token) {
  if (typeof token !== "string" || token[0] !== "p" || token.length < 3 || token.length > 8192) return null;
  let bytes;
  try { bytes = b64u.dec(token.slice(1)); } catch { return null; }
  if (bytes.length < 2) return null;
  const raw = new Uint8Array(bytes.length - 1);
  let sum = 0x5a;
  for (let i = 0; i < raw.length; i++) { raw[i] = bytes[i] ^ SEAL[i % SEAL.length]; sum = (sum + raw[i] * (i + 1)) & 0xff; }
  if (sum !== bytes[raw.length]) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return null; }
}

/* ── THE DIALECT. The room's words (left) and the engine's (right). The room-side names are what
   scripts/build.mjs renames in the engine SDK (RT_RENAME is built from this table), so the two
   can never drift: change one, the build and rt-proxy §2 both follow. ─────────────────────────── */
export const RT_WORDS = Object.freeze({
  /* message types, room -> engine */
  j1: "livekit_join",
  /* message types and keys, engine -> room */
  r1: "livekit_room_info",
  u1: "livekit_url",
  /* the signalling URL's query keys */
  c1: "livekit_server_codec",
});
/** The SDK's user-agent prefix as the room sends it, and as the engine expects it. */
export const RT_UA = Object.freeze({ room: "rt-js", engine: "decart-js-sdk" });
/** The model the room names, and the path it opens - neutral; the edge maps both. */
export const RT_ROOM_MODEL = Object.freeze({ name: "v", urlPath: "/s" });

const toEngineWord = (w) => (Object.prototype.hasOwnProperty.call(RT_WORDS, w) ? RT_WORDS[w] : w);
const ENGINE_TO_ROOM = Object.fromEntries(Object.entries(RT_WORDS).map(([a, b]) => [b, a]));
const toRoomWord = (w) => (Object.prototype.hasOwnProperty.call(ENGINE_TO_ROOM, w) ? ENGINE_TO_ROOM[w] : w);
/* What an engine message may say in prose (an error) - never the vendor's name in the room. */
const scrub = (s) => (typeof s === "string" ? s.replace(/decart/gi, "render engine").replace(/livekit/gi, "media").replace(/lucy[\w.-]*/gi, "model") : s);

/**
 * The engine's signalling URL for a room's connect URL, or null when the ticket does not open.
 * @param {URL} url  the room's request, wss://<edge>/v/s?…
 * @param {{ signalUrl: string, model: string }} cfg  the engine's https:// stream URL and model id
 */
export function engineSignalUrl(url, cfg) {
  if (url.pathname !== "/v" + RT_ROOM_MODEL.urlPath) return null;
  const key = openTicket(url.searchParams.get("api_key") || "");
  if (!key) return null;
  const out = new URL(cfg.signalUrl);
  for (const [k, v] of url.searchParams) {
    if (k === "api_key") out.searchParams.set("api_key", key);
    else if (k === "model") out.searchParams.set("model", v === RT_ROOM_MODEL.name ? cfg.model : v);
    else if (k === "user_agent") out.searchParams.set("user_agent", v.split(RT_UA.room).join(RT_UA.engine));
    else out.searchParams.set(toEngineWord(k), v);
  }
  return out.toString();
}

/** A room frame on its way to the engine: the message type back to the engine's word. */
export function frameToEngine(text) {
  if (typeof text !== "string" || text.length > 4 * 1024 * 1024) return text;
  /* Only the small control messages carry a dialect word; an image frame is passed untouched. */
  if (!text.includes('"j1"') || text.length > 4096) return text;
  try {
    const m = JSON.parse(text);
    if (m && typeof m === "object" && typeof m.type === "string") { m.type = toEngineWord(m.type); return JSON.stringify(m); }
  } catch { /* not ours to fix */ }
  return text;
}

/**
 * An engine frame on its way to the room: its words to the room's, the media URL and token sealed
 * behind our edge, prose scrubbed.
 * @param {string} text
 * @param {{ edgeWs: string }} ctx  wss://<edge> as the room reached it
 */
export function frameToRoom(text, ctx) {
  if (typeof text !== "string" || text.length > 64 * 1024) return text;
  let m;
  try { m = JSON.parse(text); } catch { return text; }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return text;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "type") out.type = toRoomWord(v);
    else if (k === "livekit_url" && typeof v === "string") out[toRoomWord(k)] = `${ctx.edgeWs}/k/${sealTicket(v)}`;
    else if (k === "token" && m.type === "livekit_room_info" && typeof v === "string") out.token = sealTicket(v);
    else if (k === "error" || k === "message" || k === "reason") out[k] = scrub(v);
    else out[toRoomWord(k)] = v;
  }
  return JSON.stringify(out);
}

/**
 * The media server URL for a room's /k/<sealed>/… request, with the sealed token opened.
 * @param {URL} url  the room's request
 * @returns {string|null} the https:// URL to open (the Worker upgrades it), or null
 */
export function engineMediaUrl(url) {
  const m = /^\/k\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  const base = openTicket(m[1]);
  if (!base || !/^wss?:\/\/[^\s/?#]+/.test(base)) return null;
  const target = new URL(base.replace(/^ws/, "http").replace(/\/+$/, "") + (m[2] || ""));
  for (const [k, v] of url.searchParams) target.searchParams.set(k, k === "access_token" ? (openTicket(v) || v) : v);
  return target.toString();
}

/** An Authorization header the media client sent with a sealed token, opened. */
export function openBearer(h) {
  const m = /^Bearer (\S+)$/.exec(h || "");
  if (!m) return h;
  const t = openTicket(m[1]);
  return t ? `Bearer ${t}` : h;
}

/**
 * A telemetry report on its way to the engine: the sealed key opened in whichever header carries
 * it, the room's model name mapped back.
 * @param {Headers} headers  the room's request headers
 * @param {string} body
 * @param {{ model: string }} cfg
 * @returns {{ headers: Record<string,string>, body: string }|null} null when no key opens
 */
export function telemetryToEngine(headers, body, cfg) {
  const out = { "Content-Type": "application/json" };
  let opened = false;
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (lk === "authorization") { const o = openBearer(v); opened = opened || o !== v; out.Authorization = o; }
    else if (lk === "x-api-key") { const o = openTicket(v); if (o) { out[k] = o; opened = true; } }
    else if (lk === "user-agent" || (lk.startsWith("x-") && lk !== "x-forwarded-for")) out[k] = String(v).split(RT_UA.room).join(RT_UA.engine);
  }
  if (!opened) return null;
  let text = body;
  try {
    const j = JSON.parse(body);
    const fix = (o) => { if (o && typeof o === "object" && o.model === RT_ROOM_MODEL.name) o.model = cfg.model; };
    fix(j); fix(j && j.tags);
    text = JSON.stringify(j);
  } catch { /* forwarded as sent */ }
  return { headers: out, body: text };
}
