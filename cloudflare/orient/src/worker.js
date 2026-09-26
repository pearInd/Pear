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

const MAX_MSGS_PER_SEC = 120;

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
