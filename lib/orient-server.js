/* =============================================================================
   PEAR · The orientation link over Node - local development and the visual harness
   -----------------------------------------------------------------------------
   Production runs the decision engine in a Cloudflare Worker (cloudflare/orient/), because
   Vercel's functions cannot hold a WebSocket. Locally - `npm start`, and the visual
   harness's own server (test/e2e/static-server.mjs) - the SAME protocol
   (lib/orient-protocol.js) and the SAME engine are served at /orient on the page's own
   origin, which is where the room connects when no PEAR_ORIENT_URL was built in. The
   harness depending on it is deliberate: the mocked pose sensor then drives the real
   engine over a real socket, exactly as a shopper's browser drives the Worker.
   ============================================================================= */
import { WebSocketServer } from "ws";
import { createOrientSession } from "./orient-protocol.js";

/** Serve the orientation link on `path` of an existing http.Server.
 *  @param {import("node:http").Server} server
 *  @param {{path?: string, allowDebug?: (key: unknown) => boolean}} [opts] */
export function attachOrientServer(server, { path = "/orient", allowDebug = () => true } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try { pathname = new URL(req.url, "http://x").pathname; } catch { /* malformed - not ours */ }
    if (pathname !== path) {                  // another upgrade handler's route - or nobody's, then close it
      if (server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = createOrientSession({ allowDebug });
      ws.on("message", (data) => {
        const reply = session.handle(String(data));
        if (reply !== null && ws.readyState === 1) ws.send(reply);
      });
    });
  });
  return wss;
}
