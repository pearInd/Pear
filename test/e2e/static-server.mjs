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
     · POST /api/size        -> the REAL lib/sizing.js (the size fit is server-side since
                                2026-09-26; shipped logic, so it runs here unstubbed)
     · POST /api/prompt      -> the REAL lib/prompts.js, for the same reason
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

/* PEAR_VISUAL_OVERLAY=<dir> (npm run qa:visual:dist) serves a BUILT client over the repo:
   scripts/build.mjs --qa writes the same minified bundle production ships, with the mock
   kept so the agent can still drive it. Mirrors server.js with dist/ live - a code file
   (.js/.css/.html) comes from the overlay or not at all, never falling back to source, so
   a file the build forgot to emit fails here the way it would for a shopper. Fixtures,
   images and video still come from the repo. */
const OVERLAY = process.env.PEAR_VISUAL_OVERLAY ? resolve(ROOT, process.env.PEAR_VISUAL_OVERLAY) : null;
const CODE_FILE = /\.(m?js|css|html)$/i;

function resolveUnder(base, rel) {
  const abs = resolve(join(base, normalize(rel)));
  if (abs !== base && !abs.startsWith(base + sep)) return null;   // traversal
  try { return statSync(abs).isFile() ? abs : null; } catch (_) { return null; }
}

/** Resolve a request path to a real file inside ROOT (or the overlay), or null if it escapes or is absent. */
function resolveInRoot(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split("?")[0]); } catch (_) { return null; }
  if (OVERLAY && CODE_FILE.test(rel) && !rel.startsWith("/test/")) return resolveUnder(OVERLAY, rel);
  return resolveUnder(ROOT, rel);
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

    /* The size service runs the REAL lib/sizing.js, exactly as server.js does - it is
       shipped logic, not a sensor or a transport, so the harness must not stub it
       (CLAUDE.md §8.6). */
    if (url.pathname === "/api/size" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
      req.on("end", async () => {
        try {
          const { computeSizeVerdict, sanitizeSizeEvidence } = await import("../../lib/sizing.js");
          const verdict = computeSizeVerdict(sanitizeSizeEvidence(JSON.parse(raw || "{}")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(verdict));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "size_failed", message: String(e?.message || e) }));
        }
      });
      return;
    }

    if (url.pathname === "/api/prompt" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
      req.on("end", async () => {
        try {
          const { promptForRequest, sanitizePromptRequest } = await import("../../lib/prompts.js");
          const prompt = promptForRequest(sanitizePromptRequest(JSON.parse(raw || "{}")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ prompt }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "prompt_failed", message: String(e?.message || e) }));
        }
      });
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
