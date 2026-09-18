#!/usr/bin/env node
/* =============================================================================
   The visual harness's own server - deliberately NOT server.js
   -----------------------------------------------------------------------------
   The real server needs DECART_API_KEY, Supabase credentials, a Gemini key and a
   mail path just to boot. None of that is under test here, and requiring it would
   make the visual gate refuse to run on a laptop without production secrets -
   which is the fastest way to get a mandatory gate switched off.

   So this serves exactly what the fitting room needs to come up, and nothing else:

     · the repo as static files, so /fitting-room/ and the generated fixtures load
     · GET  /api/health      -> {ok:true}    (ensureOnline()'s soft probe)
     · GET  /api/img-proxy   -> same-origin  (fetchWithFallback's route 1; without
                                it every garment fetch spends a failed round-trip
                                before falling through to the direct fetch)
     · POST /api/realtime-token -> 402, AND COUNTED

   THAT LAST ONE IS A TEST, not a stub. ?mock_decart=1 is supposed to short-circuit
   above the token mint, so a run that reaches this route has lost its cost
   guarantee - the whole premise of the harness. It answers with an error the app
   will surface loudly rather than a plausible token, and the count is asserted to
   be zero at the end of every spec.

   It is SSRF-free by construction: img-proxy only ever resolves paths inside this
   repo, and refuses anything that escapes it.
   ============================================================================= */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".y4m": "video/x-yuv4mpeg",
};

/** Resolve a request path to a real file inside ROOT, or null if it escapes or is absent. */
function resolveInRoot(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split("?")[0]); } catch (_) { return null; }
  const abs = resolve(join(ROOT, normalize(rel)));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;   // traversal
  try { return statSync(abs).isFile() ? abs : null; } catch (_) { return null; }
}

/**
 * Start the harness server.
 * @param {number} port 0 picks a free port - the spec reads the real one back
 * @returns {Promise<{url:string, tokenMintAttempts:()=>number, close:()=>Promise<void>}>}
 */
export function startStaticServer(port = 0) {
  let tokenMints = 0;

  const server = createServer((req, res) => {
    /* The request's OWN host, not a placeholder. img-proxy below compares the url it is
       asked to fetch against this origin, and the room addresses the harness as
       127.0.0.1:<ephemeral port> - so a hardcoded "http://localhost" made every
       same-origin garment fetch fail the origin check and 404. It still worked, because
       fetchWithFallback() drops through to a direct fetch, but it spent a wasted
       round-trip per asset and filled the transcript with 404s that look like a fault. */
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mock: true }));
      return;
    }

    if (url.pathname === "/api/realtime-token") {
      tokenMints++;
      console.error("[harness] ✖ /api/realtime-token was called - ?mock_decart=1 did NOT " +
                    "short-circuit the mint. A real run would have spent credits here.");
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock_decart_bypassed", message: "the harness mints no tokens" }));
      return;
    }

    if (url.pathname === "/api/img-proxy") {
      const target = url.searchParams.get("url") || "";
      // Only ever a same-origin path back into this repo; anything else is refused
      // rather than fetched, so the harness can never become an open relay.
      let inner;
      try { inner = new URL(target, url.origin); } catch (_) { inner = null; }
      const file = inner && inner.origin === url.origin ? resolveInRoot(inner.pathname) : null;
      if (!file) { res.writeHead(404).end("no"); return; }
      res.writeHead(200, {
        "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      });
      createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname.startsWith("/api/")) { res.writeHead(404).end("{}"); return; }

    const file = resolveInRoot(url.pathname) ||
                 resolveInRoot(join(url.pathname, "index.html"));
    if (!file) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok) => {
    server.listen(port, "127.0.0.1", () => {
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        tokenMintAttempts: () => tokenMints,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
