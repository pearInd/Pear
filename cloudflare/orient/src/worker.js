/* =============================================================================
   PEAR · The orientation engine on Cloudflare - what production's room talks to
   -----------------------------------------------------------------------------
   The front/back DECISION (lib/orient-engine.js, CLAUDE.md §2.14) runs here so it never
   ships to a shopper's browser. This file is only the transport: a WebSocket at /orient
   that feeds each message to the SAME protocol session the local server uses
   (lib/orient-protocol.js), so the Worker and `npm start` cannot disagree about anything
   but the socket. Wrangler bundles the engine in at deploy.

   A PLAIN Worker, not a Durable Object: the probe (cloudflare/probe/README.md) measured
   ~7ms from Tel Aviv and a free-plan plain Worker holding a session of this size of work;
   a Durable Object added ~55ms and buys nothing here - every engine is per-connection
   state that dies with the socket, and the browser re-opens its channels (a clean engine)
   when it reconnects.

   WHO MAY CONNECT
     - Origin must match ALLOWED_ORIGINS (a comma list; `*` stands for one run of
       [a-z0-9-], never a dot, slash or colon - so a Vercel preview pattern cannot be
       satisfied by someone else's domain). Empty list = nobody: fail closed. This stops
       another site's page from using the engine through its shoppers' browsers; it does
       not stop a scripted client that forges the header. Nothing secret is served - the
       engine answers "swap now" to samples, it never returns its thresholds - so the
       Origin gate is a fence, not a lock.
     - The per-tick tuning line (every threshold, by name) is sent only to a channel whose
       `dk` equals PEAR_DEBUG_TOKEN (≥16 chars, a Worker secret - the same token as the
       support view's ?pear_debug=, CLAUDE.md §2.11). Unset = never.
     - At most MAX_MSGS_PER_SEC messages per connection per second; the room sends ~4 per
       watcher. Past it the socket is closed and the room's retry takes over.

   Nothing is logged: observability is off in wrangler.jsonc and this file prints nothing.
   ============================================================================= */
import { createOrientSession } from "../../../lib/orient-protocol.js";
import { computeSizeVerdict, sanitizeSizeEvidence } from "../../../lib/sizing.js";
import { promptForRequest, sanitizePromptRequest } from "../../../lib/prompts.js";
/* The fingerprint of the two modules above - stamped on every /size and /prompt answer so the room
   can tell an edge running an older deploy from one running its own code (scripts/sync-api-version.mjs). */
import { API_VERSION } from "../../../lib/api-version.js";
/* The render engine behind this edge (2026-10-03) - signalling, media, telemetry, pose assets. See rt.js. */
import { handleRt } from "./rt.js";

const MAX_MSGS_PER_SEC = 120;
const MAX_BODY_CHARS = 65536;
const MAX_TRACE_CHARS = 262144;
const TRACE_TTL_S = 7 * 24 * 3600;

/* ── THE SIZE FIT AND THE WIRE PROMPT, ALSO HERE (2026-09-27) ─────────────────────────────
   REPORTED: "the whole interface is laggy" after the logic moved server-side. Measured: every
   /api/size and /api/prompt call went to Vercel's iad1 (Washington) - ~350ms a round trip from
   Israel, 620ms cold - where the in-browser original answered in 0ms. Continue sat locked for two
   of those in a row (~720ms) and go-live waited two more. The same two pure modules answer here,
   at the edge nearest the shopper (~10-20ms), with the SAME sanitisers and the SAME code as
   server.js's routes - the room falls back to those if this is unreachable, so an answer never
   depends on which one it came from. computeSizeVerdict costs ~0.02ms, promptForRequest ~0.01ms.
   Same Origin allowlist as /orient; the reply carries CORS for that origin only. */
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Pear-Api",
    "Access-Control-Max-Age": "7200",
    "Vary": "Origin",
  };
}

/* ── A TEST SESSION'S FLIGHT RECORD (2026-09-27) ──────────────────────────────────────────
   POST /trace: the room's flight recorder (fitting-room/app.js, "FLIGHT RECORDER") posts one
   record when a TEST session ends - each orientation tick's measurements and the engine's reply,
   every swap from request to first frame, the output stalls. Kept in KV (binding TRACES) for
   TRACE_TTL_S and read back with `wrangler kv key list/get --binding TRACES`. The room sends it
   only for the TEST store key or ?pear_trace=1; this end checks the shape, bounds the size and
   names the key itself. No TRACES binding = the route answers 404 and stores nothing. */
async function storeTrace(env, body, json) {
  if (!env.TRACES || typeof env.TRACES.put !== "function") return json({ error: "off" }, 404);
  if (!body || typeof body !== "object" || body.v !== 1 || typeof body.id !== "string" || !Array.isArray(body.ev)) {
    return json({ error: "bad_trace" }, 400);
  }
  const id = body.id.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "x";
  await env.TRACES.put(`trace:${new Date().toISOString()}:${id}`, JSON.stringify(body), { expirationTtl: TRACE_TTL_S });
  return json({ ok: true });
}

/** POST /size, /prompt and /trace - exported for the unit test. */
export async function handleApi(request, env, route) {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return new Response("forbidden", { status: 403 });
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Pear-Api": API_VERSION } });
  let body;
  try {
    const text = await request.text();
    if (text.length > (route === "/trace" ? MAX_TRACE_CHARS : MAX_BODY_CHARS)) return json({ error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: "bad_json" }, 400); }
  try {
    if (route === "/trace") return await storeTrace(env, body, json);
    if (route === "/size") {
      return json(computeSizeVerdict(sanitizeSizeEvidence(body), { diag: keyMatches(body && body.dk, env.PEAR_DEBUG_TOKEN) }));
    }
    return json({ prompt: promptForRequest(sanitizePromptRequest(body)) });
  } catch {
    return json({ error: route === "/size" ? "size_failed" : route === "/trace" ? "trace_failed" : "prompt_failed" }, 500);
  }
}

/** @param {string|null} origin @param {string|undefined} list  comma-separated patterns */
export function originAllowed(origin, list) {
  if (typeof origin !== "string" || !origin || typeof list !== "string") return false;
  const o = origin.trim().toLowerCase();
  for (const raw of list.split(",")) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$");
    if (re.test(o)) return true;
  }
  return false;
}

/** Constant-time equality against a secret that must be set and long enough. */
export function keyMatches(given, expected) {
  if (typeof expected !== "string" || expected.length < 16 || typeof given !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/size" || url.pathname === "/prompt" || url.pathname === "/trace") return handleApi(request, env, url.pathname);
    const rt = handleRt(request, env, url, originAllowed(request.headers.get("Origin"), env.ALLOWED_ORIGINS));
    if (rt) return rt;
    if (url.pathname !== "/orient") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    if (!originAllowed(request.headers.get("Origin"), env.ALLOWED_ORIGINS)) return new Response("forbidden", { status: 403 });

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const session = createOrientSession({ allowDebug: (dk) => keyMatches(dk, env.PEAR_DEBUG_TOKEN) });
    let windowStart = 0, inWindow = 0;
    const safeClose = (code, reason) => { try { server.close(code, reason); } catch { /* already closed */ } };

    server.addEventListener("message", (e) => {
      const now = Date.now();   // advances between messages (each is an I/O event)
      if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
      if (++inWindow > MAX_MSGS_PER_SEC) { safeClose(1008, "rate"); return; }
      if (typeof e.data !== "string") return;
      const reply = session.handle(e.data);
      if (reply !== null) { try { server.send(reply); } catch { /* closing */ } }
    });
    server.addEventListener("close", () => safeClose(1000, "bye"));
    server.addEventListener("error", () => safeClose(1011, "error"));
    return new Response(null, { status: 101, webSocket: client });
  },
};
