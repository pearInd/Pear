/* =============================================================================
   PEAR · Cloudflare probe - measurements only, never on the shopper's path
   -----------------------------------------------------------------------------
   Answers three questions before phase 5 (front/back decision in a Worker) and phase 6
   (render-engine signaling through our own domain) are designed. Nothing in the app
   points here; it is deployed on its own, measured, and deleted.

     1. /echo     How far is the edge? WebSocket echo - the client times each round trip.
     2. /cpu      Does a long-lived WebSocket in a PLAIN Worker survive a session of small
                  per-frame decisions on the FREE plan (10ms CPU per invocation)? If CPU is
                  counted across the whole connection, a 60-90s session of ~8 msgs/s dies;
                  if it is counted per message, it lives. The docs do not settle this.
        /cpu-do   The same load in a Durable Object (WebSocket hibernation API), whose limit
                  is documented to reset on every incoming message.
     3. /where    Which Cloudflare colo ran us, and how far the render engine's realtime host
                  is FROM that colo (it geo-routes by client IP, and behind a relay the client
                  is Cloudflare's egress, not the shopper).
        /relay    A byte-for-byte WebSocket relay to the render engine's realtime host - what
                  the SDK's realtimeBaseUrl would point at in phase 6. It forwards the path and
                  query untouched and reports nothing it carries.

   Every route sits behind a path key (/<PROBE_KEY>/…), set at deploy time with
   `--var PROBE_KEY:<value>` and never committed, so the relay is not an open proxy.
   A path key rather than a query key because the SDK builds `${realtimeBaseUrl}/v1/stream?…`
   and a query on the base URL would break that.
   ============================================================================= */

const UPSTREAM = "https://api3.decart.ai";

/* A stand-in for the per-frame orientation work: the watcher's inputs are the pose
   landmarks (33 points), and its decision is arithmetic over them. One unit is every
   pairwise distance between the 33 points (1,089 sqrt) plus a shoulder-yaw asin - several
   times what the real watcher does per frame, so a pass here is a pass with margin. */
function orientationUnit(points) {
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    for (let j = 0; j < points.length; j++) {
      const b = points[j];
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  const ls = points[11] || [0, 0, 0], rs = points[12] || [0, 0, 0];
  const width = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]) || 1;
  const yaw = Math.asin(Math.max(-1, Math.min(1, (ls[2] - rs[2]) / width))) * 180 / Math.PI;
  return { acc, yaw };
}

function runLoad(raw, units) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { error: "bad-json" }; }
  const points = Array.isArray(msg.p) ? msg.p.slice(0, 33) : [];
  let out = { acc: 0, yaw: 0 };
  for (let u = 0; u < units; u++) out = orientationUnit(points);
  return { seq: msg.seq, t: msg.t, yaw: Math.round(out.yaw * 10) / 10, side: out.yaw > 0 ? "front" : "back" };
}

/* Up to 50,000 units (~80ms on a laptop core) - the client's spike test asks for 20,000 to
   put a single message over the free plan's 10ms line on purpose. */
const clampUnits = (v) => Math.max(1, Math.min(50000, Number.parseInt(v || "1", 10) || 1));

function upgradeRequired() {
  return new Response("expected a WebSocket upgrade", { status: 426 });
}

/* ── /echo and /cpu - a plain Worker holding the socket ───────────────────────── */
function plainSocket(request, units) {
  if (request.headers.get("Upgrade") !== "websocket") return upgradeRequired();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (e) => {
    try {
      server.send(units === 0 ? e.data : JSON.stringify(runLoad(e.data, units)));
    } catch { /* the socket is closing */ }
  });
  return new Response(null, { status: 101, webSocket: client });
}

/* ── /cpu-do - the same load inside a Durable Object ──────────────────────────── */
export class ProbeRoom {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return upgradeRequired();
    const units = clampUnits(new URL(request.url).searchParams.get("n"));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [String(units)]);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, data) {
    const units = clampUnits(this.ctx.getTags(ws)[0]);
    ws.send(JSON.stringify(runLoad(typeof data === "string" ? data : new TextDecoder().decode(data), units)));
  }
  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch { /* already closed */ }
  }
}

/* ── /where - our colo, and the render engine's distance from it ──────────────── */
async function where(request) {
  const cf = request.cf || {};
  const timings = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();   // advances across I/O in a Worker, which is all this measures
    let status = 0;
    try { status = (await fetch(UPSTREAM + "/", { method: "GET", redirect: "manual" })).status; } catch { status = -1; }
    timings.push({ ms: Date.now() - t0, status });
  }
  return Response.json({
    colo: cf.colo || null, country: cf.country || null, city: cf.city || null,
    upstreamRoundTrips: timings,
    note: "the first round trip includes DNS + TLS; the later ones are the steady-state distance",
  });
}

/* ── /relay - the realtime signaling socket, forwarded untouched ──────────────── */
async function relay(request, path, search) {
  if (request.headers.get("Upgrade") !== "websocket") return upgradeRequired();
  let upstream;
  try {
    const resp = await fetch(UPSTREAM + path + search, { headers: { Upgrade: "websocket" } });
    upstream = resp.webSocket;
    if (!upstream) return new Response(`upstream refused the upgrade (${resp.status})`, { status: 502 });
  } catch (e) {
    return new Response("upstream unreachable", { status: 502 });
  }
  upstream.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const safeClose = (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } };
  const closeCode = (code) => (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1011);
  server.addEventListener("message", (e) => { try { upstream.send(e.data); } catch { /* closing */ } });
  upstream.addEventListener("message", (e) => { try { server.send(e.data); } catch { /* closing */ } });
  server.addEventListener("close", (e) => safeClose(upstream, closeCode(e.code), e.reason));
  upstream.addEventListener("close", (e) => safeClose(server, closeCode(e.code), e.reason));
  server.addEventListener("error", () => safeClose(upstream, 1011, "client error"));
  upstream.addEventListener("error", () => safeClose(server, 1011, "upstream error"));
  return new Response(null, { status: 101, webSocket: client });
}

function keyMatches(given, expected) {
  if (typeof expected !== "string" || expected.length < 16 || typeof given !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, key, route, ...rest] = url.pathname.split("/");
    if (!keyMatches(key, env.PROBE_KEY)) return new Response("not found", { status: 404 });
    const units = clampUnits(url.searchParams.get("n"));

    switch (route) {
      case "echo":   return plainSocket(request, 0);
      case "cpu":    return plainSocket(request, units);
      case "cpu-do": {
        const id = env.PROBE_ROOM.idFromName(`probe-${crypto.randomUUID()}`);
        return env.PROBE_ROOM.get(id).fetch(request);
      }
      case "where":  return where(request);
      case "relay":  return relay(request, "/" + rest.join("/"), url.search);
      default:       return new Response("not found", { status: 404 });
    }
  },
};
