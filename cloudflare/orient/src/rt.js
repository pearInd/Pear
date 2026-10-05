/* =============================================================================
   PEAR · the render engine behind our edge - the Worker half of lib/rt-proxy.js (2026-10-03)
   -----------------------------------------------------------------------------
   The room never contacts the render engine, its media servers or its telemetry host by name:
     /v/s        the signalling socket, relayed frame by frame (the dialect translated)
     /k/<sealed> the media server's socket and HTTP checks, relayed byte for byte
     /m          the SDK's telemetry report, forwarded
     /a/<name>   the pose model's scrambled binaries (static assets, scripts/build-edge-assets.mjs)
   Same Origin allowlist as /orient. The upstream hosts and the model id are Worker vars
   (wrangler.jsonc), never in anything the page downloads.

   LATENCY: a relayed frame costs one hop inside Cloudflare's network (the colo nearest the
   shopper, measured ~7ms from Tel Aviv for /orient). The media itself (WebRTC) does not pass
   through here - only its signalling - so the video path is exactly as before.

   A REFUSED UPSTREAM IS CLOSED WITH ITS REASON, not dropped: the SDK reads a close reason for
   "not allowed" / "401" / "unauthorized" to stop retrying a permanent failure. A bare failed
   upgrade (1006, no reason) would make it retry five times with back-off before giving up.
   ============================================================================= */
import { engineSignalUrl, frameToEngine, frameToRoom, engineMediaUrl, openBearer, telemetryToEngine, roomErrorText, NO_CREDITS,
  openTicket, RT_UA } from "../../../lib/rt-proxy.js";

/* A close reason as the room reads it - scrubbed, and a credit refusal made final (rt-proxy roomErrorText). */
const scrubReason = (s) => String(roomErrorText(String(s || ""))).slice(0, 120);
/* close() accepts 1000 and 3000-4999 from script; everything else (1005/1006/1015…) becomes 1011 or 1000. */
const closeCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : c === 1001 ? 1000 : 1011);

function cors(origin, methods = "GET, POST, OPTIONS") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-KEY",
    "Access-Control-Max-Age": "7200",
    "Vary": "Origin",
  };
}

/** Accept the room's socket only once the upstream one is open; relay both ways, translating text. */
async function relay(upstreamUrl, headers, { toUp = (d) => d, toDown = (d) => d } = {}) {
  let up;
  try {
    up = await fetch(upstreamUrl, { headers: { ...headers, Upgrade: "websocket" } });
  } catch (e) {
    return refused(1011, "upstream unreachable");
  }
  const ws = up.webSocket;
  if (!ws) {
    let text = "";
    try { text = (await up.text()).slice(0, 200); } catch { /* none */ }
    /* 402 is "pay first": final, like a credit refusal in a frame (the SDK stops on "not allowed"). */
    return refused(up.status === 401 || up.status === 402 || up.status === 403 ? 4000 + up.status : 1011,
      `${up.status} ${up.status === 402 ? NO_CREDITS : scrubReason(text)}`);
  }
  ws.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (e) => { try { ws.send(typeof e.data === "string" ? toUp(e.data) : e.data); } catch { /* closing */ } });
  ws.addEventListener("message", (e) => { try { server.send(typeof e.data === "string" ? toDown(e.data) : e.data); } catch { /* closing */ } });
  server.addEventListener("close", (e) => { try { ws.close(closeCode(e.code), scrubReason(e.reason)); } catch { /* closed */ } });
  ws.addEventListener("close", (e) => { try { server.close(closeCode(e.code), scrubReason(e.reason)); } catch { /* closed */ } });
  server.addEventListener("error", () => { try { ws.close(1011, "error"); } catch { /* closed */ } });
  ws.addEventListener("error", () => { try { server.close(1011, "error"); } catch { /* closed */ } });
  return new Response(null, { status: 101, webSocket: client });
}
/* The room's socket opened and closed at once with the reason - what a direct refusal looked like. */
function refused(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  setTimeout(() => { try { server.close(code, scrubReason(reason)); } catch { /* closed */ } }, 0);
  return new Response(null, { status: 101, webSocket: client });
}

/** @returns {Promise<Response>|null} null when the path is not the render engine's */
export function handleRt(request, env, url, originOk) {
  const p = url.pathname;
  if (!(p === "/v/s" || p.startsWith("/k/") || p === "/m" || p.startsWith("/a/") || p.startsWith("/f/"))) return null;
  const origin = request.headers.get("Origin");
  if (p.startsWith("/a/")) return assets(request, env, origin, originOk);
  if (!originOk) return Promise.resolve(new Response("forbidden", { status: 403 }));
  const cfg = { signalUrl: env.RT_SIGNAL_URL, model: env.RT_MODEL };
  if (!cfg.signalUrl || !cfg.model) return Promise.resolve(new Response("not configured", { status: 503 }));

  if (p === "/v/s") {
    if (request.headers.get("Upgrade") !== "websocket") return Promise.resolve(new Response("expected a WebSocket upgrade", { status: 426 }));
    const target = engineSignalUrl(url, cfg);
    if (!target) return Promise.resolve(refused(4401, "401 invalid session"));
    /* The edge as the room reached it - RT_EDGE_WS overrides it for a local `wrangler dev` (which reports the
       production host in request.url). */
    const edgeWs = env.RT_EDGE_WS || `wss://${url.host}`;
    return relay(target, { Origin: origin }, { toUp: frameToEngine, toDown: (t) => frameToRoom(t, { edgeWs }) });
  }

  if (p.startsWith("/k/")) {
    const target = engineMediaUrl(url);
    if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: cors(origin, "GET, OPTIONS") }));
    if (!target) return Promise.resolve(new Response("not found", { status: 404, headers: cors(origin) }));
    const headers = { Origin: origin };
    const auth = request.headers.get("Authorization");
    if (auth) headers.Authorization = openBearer(auth);
    if (request.headers.get("Upgrade") === "websocket") return relay(target, headers);
    return (async () => {
      const r = await fetch(target, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
      const body = request.method === "HEAD" ? null : scrubReason(await r.text());
      return new Response(body, { status: r.status, headers: { ...cors(origin), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    })();
  }

  /* /f/v1/files - the render client's file upload (THE ENGINE-SPEED EXPERIMENT's "ref" mode, app.js - TEST sessions only):
     the multipart body passed as sent, the sealed key opened, the room's user agent mapped back; the answer (the file id)
     comes back with the engine's name scrubbed. Nothing else under /f/ is forwarded. */
  if (p.startsWith("/f/")) {
    if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: cors(origin, "POST, OPTIONS") }));
    if (request.method !== "POST" || p !== "/f/v1/files" || !env.RT_FILES_URL) return Promise.resolve(new Response("not found", { status: 404, headers: cors(origin) }));
    const key = openTicket(request.headers.get("X-API-KEY") || "");
    if (!key) return Promise.resolve(new Response("unauthorized", { status: 401, headers: cors(origin) }));
    return (async () => {
      const headers = { "X-API-KEY": key, "User-Agent": String(request.headers.get("User-Agent") || "").split(RT_UA.room).join(RT_UA.engine) };
      const ct = request.headers.get("Content-Type");
      if (ct) headers["Content-Type"] = ct;
      let r;
      try { r = await fetch(env.RT_FILES_URL, { method: "POST", headers, body: request.body }); }
      catch { return new Response("upstream unreachable", { status: 502, headers: cors(origin) }); }
      const text = await r.text();
      return new Response(text.replace(/decart/gi, "render engine").replace(/livekit/gi, "media"),
        { status: r.status, headers: { ...cors(origin, "POST, OPTIONS"), "Content-Type": "application/json", "Cache-Control": "no-store" } });
    })();
  }

  /* /m - the SDK's telemetry. Forwarded best-effort; the room never waits on it. */
  if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: cors(origin, "POST, OPTIONS") }));
  if (request.method !== "POST") return Promise.resolve(new Response("method not allowed", { status: 405, headers: cors(origin) }));
  return (async () => {
    const body = await request.text();
    if (body.length > 512 * 1024 || !env.RT_TELEMETRY_URL) return new Response(null, { status: 204, headers: cors(origin) });
    const fwd = telemetryToEngine(request.headers, body, cfg);
    if (!fwd) return new Response(null, { status: 204, headers: cors(origin) });
    try { await fetch(env.RT_TELEMETRY_URL, { method: "POST", headers: fwd.headers, body: fwd.body }); } catch { /* best effort */ }
    return new Response(null, { status: 204, headers: cors(origin) });
  })();
}

/* /a/<name> - the pose model's binaries, stored scrambled (scripts/build-edge-assets.mjs). Immutable
   by name (a content hash), cached a year; CORS for the room's origins (the room fetches and
   unscrambles them itself - see loadPoseLandmarker in app.js). */
async function assets(request, env, origin, originOk) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: originOk ? cors(origin, "GET, OPTIONS") : {} });
  if (!env.ASSETS || (request.method !== "GET" && request.method !== "HEAD")) return new Response("not found", { status: 404 });
  const r = await env.ASSETS.fetch(request);
  if (!r.ok) return new Response("not found", { status: 404 });
  const h = new Headers(r.headers);
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  h.set("Content-Type", "application/octet-stream");
  if (originOk) for (const [k, v] of Object.entries(cors(origin, "GET, OPTIONS"))) h.set(k, v);
  return new Response(r.body, { status: 200, headers: h });
}
