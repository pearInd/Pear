/* STATIC ALLOWLIST - "the server was handing out its own source"
   ─────────────────────────────────────────────────────────────────────────────
   THE REPORT THIS CLOSES: server.js served the whole repository as static files.
   `express.static(__dirname)` plus a page router rooted at the repo answered 200 for
   /server.js, /CLAUDE.md, /package.json, /scanner/scan-store.js, /test/run.mjs,
   /docs/… and /node_modules/… - every sizing table, prompt rule and classifier
   heuristic, comments included, one GET away. Verified 2026-09-25 with a probe
   running that exact config.

   AND THE SECOND HALF: even the files that SHOULD be public were served as source.
   Production now serves dist/ (scripts/build.mjs) - minified, comments and log
   narration stripped - with the source reachable only through the token-gated
   support view.

   This slices server.js's real public-roots + static block (from "/* ── Public roots"
   to the "/* ── Start (local only" banner), mounts it on a bare express app with only
   app/express/path/fs/crypto/__dirname/process in scope, and asserts:
     §1  private paths 404 - stated as an ABSENCE, the only form that catches a new
         well-meant "just serve the root" line
     §2  public paths still load - an allowlist that 404s the fitting room is not a fix
     §3  traversal out of a public directory does not reach the repo
     §4  source-level: nothing in server.js serves the repo root any more
     §5  with dist/ live: code comes ONLY from dist/, never falls back to source; the
         hashed SDK bundle is long-cached; the support view serves source only with
         the right token; a missing dist/ degrades to source, loudly
   ============================================================================= */
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

const BLOCK = extract(SERVER, "/* ── Public roots", "/* ── Start (local only");

/* Mount the block on a bare app. It runs with ONLY these in scope - if it ever reaches for
   anything else it throws here, which is the self-containment rule of CLAUDE.md §2.6.
   `process` is a stand-in carrying just the env under test; the page router logs every
   hit, so console is a recorder rather than the real one. */
async function mount(dirname, env = {}) {
  const logs = { error: [] };
  const recorder = { log() {}, warn() {}, error: (...a) => logs.error.push(a.join(" ")) };
  const app = express();
  new Function("app", "express", "path", "fs", "crypto", "__dirname", "process", "console", BLOCK)
    (app, express, path, fs, crypto, dirname, { env }, recorder);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const port = server.address().port;
  /* Raw http rather than fetch(): fetch normalises "../" out of a URL before it is sent,
     which would make the traversal checks test nothing. */
  const request = (method, rawPath) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  return { request, logs, close: () => new Promise((r) => server.close(r)) };
}

/* ══ §1-§3 the real repo, source mode ═════════════════════════════════════════ */
{
  const { request, close } = await mount(ROOT, {});
  try {
    console.log("── §1 private paths are not served ──");
    const PRIVATE = [
      "/server.js", "/CLAUDE.md", "/package.json", "/package-lock.json", "/vercel.json",
      "/scanner/scan-store.js", "/test/run.mjs", "/scripts/trace-prompt.mjs", "/scripts/build.mjs",
      "/lib/garment-category.js", "/archive/DESIGN.md", "/docs/", "/.env", "/.env.example",
      "/node_modules/express/package.json", "/index.html", "/dist/fitting-room/app.js",
    ];
    for (const p of PRIVATE) {
      const r = await request("GET", p);
      check(`§1 GET ${p} → 404`, r.status === 404, `got ${r.status} (${r.body.length} bytes)`);
    }
    const root = await request("GET", "/");
    check("§1 GET / → redirect to the fitting room, not a listing",
          root.status === 302 && root.headers.location === "/fitting-room/", `got ${root.status} → ${root.headers.location}`);

    console.log("\n── §2 public paths still load ──");
    const PUBLIC = [
      ["GET",  "/fitting-room/"],
      ["GET",  "/fitting-room/app.js"],
      ["GET",  "/fitting-room/config.js"],
      ["GET",  "/fitting-room/style.css"],
      ["GET",  "/widget/pear-widget.js"],
      ["GET",  "/widget/guide"],
      ["GET",  "/admin/"],
      ["GET",  "/admin/admin.js"],
      ["GET",  "/pear-logo.png"],
      ["HEAD", "/Commercial_video_for_a_tech_fa.mp4"],
    ];
    for (const [m, p] of PUBLIC) {
      const r = await request(m, p);
      check(`§2 ${m} ${p} → 200`, r.status === 200, `got ${r.status}`);
    }

    console.log("\n── §3 no traversal out of a public directory ──");
    for (const p of ["/admin/../server.js", "/fitting-room/../CLAUDE.md", "/widget/..%2fserver.js",
                     "/admin/../server", "/fitting-room/%2e%2e/package.json"]) {
      const r = await request("GET", p);
      check(`§3 GET ${p} → not 200`, r.status !== 200, `got ${r.status} (${r.body.length} bytes)`);
    }
    const noToken = await request("GET", "/__src/whatever-it-is-long-enough/fitting-room/app.js");
    check("§3 the support route is a 404 when no PEAR_DEBUG_TOKEN is configured", noToken.status === 404, `got ${noToken.status}`);
  } finally {
    await close();
  }
}

/* ══ §4 source-level ════════════════════════════════════════════════════════════
   Comments are stripped first: the block's own THE BUG THIS CLOSES note quotes the old
   `express.static(__dirname)` line, and a record of the bug must not trip the check for it. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SERVER_CODE = stripComments(SERVER);
const BLOCK_CODE  = stripComments(BLOCK);

console.log("\n── §4 source-level: nothing serves the repo root ──");
check("§4.1 no express.static(__dirname …) anywhere in server.js",
      !/express\.static\(\s*__dirname\s*[,)]/.test(SERVER_CODE));
check("§4.2 no express.static(<repo root>) - not even behind the support token (see §5.18)",
      !/express\.static\(\s*(uiRoot|SRC_ROOT|DIST_ROOT|CODE_ROOT)\s*[,)]/.test(BLOCK_CODE));
check("§4.3 the page router has no root-level SPA fallback",
      !/path\.join\(\s*(uiRoot|SRC_ROOT|CODE_ROOT|DIST_ROOT)\s*,\s*["']index\.html["']\s*\)/.test(BLOCK_CODE));
check("§4.4 server.js and scripts/build.mjs publish the same PUBLIC_DIRS",
      (() => {
        const list = (src) => (src.match(/const PUBLIC_DIRS\s*=\s*\[([^\]]*)\]/) || [])[1]?.replace(/\s/g, "");
        const build = readFileSync(path.join(ROOT, "scripts/build.mjs"), "utf8");
        return !!list(SERVER) && list(SERVER) === list(build);
      })());

/* ══ §5 production mode, on a synthetic tree ══════════════════════════════════════
   A throwaway directory with a source file and a DIFFERENT built file at each path, so
   every response says which root it came from. Independent of whether this checkout
   has run `npm run build`. */
console.log("\n── §5 dist/ live: built code only, cached SDK, token-gated source ──");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pear-allowlist-"));
const put = (rel, text) => { const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
put("server.js", "PRIVATE-SERVER");
put("pear-logo.png", "PNG");
put("Commercial_video_for_a_tech_fa.mp4", "MP4");
put("fitting-room/index.html", '<html><head></head><body>SOURCE-INDEX<link href="style.css?v=1"><script type="module" src="app.js?v=1"></script><a href="#x">x</a></body></html>');
put("fitting-room/app.js", "SOURCE-APP");
put("fitting-room/config.js", "SOURCE-CONFIG");
put("fitting-room/style.css", "SOURCE-CSS");
put("fitting-room/photo.png", "SOURCE-PHOTO");
put("widget/pear-widget.js", "SOURCE-WIDGET");
put("widget/pear-widget-guide.html", "SOURCE-GUIDE");
put("admin/index.html", "SOURCE-ADMIN");
put("dist/fitting-room/index.html", "<html><head></head><body>BUILT-INDEX</body></html>");
put("dist/fitting-room/app.js", "BUILT-APP");
put("dist/fitting-room/style.css", "BUILT-CSS");
put("dist/fitting-room/rt.0123456789ab.js", "BUILT-SDK");
put("dist/widget/pear-widget.js", "BUILT-WIDGET");
put("dist/widget/pear-widget-guide.html", "BUILT-GUIDE");
put("dist/admin/index.html", "BUILT-ADMIN");
const TOKEN = "t0k3n-for-the-support-view-only";

try {
  {
    const { request, logs, close } = await mount(TMP, { PEAR_SERVE_DIST: "1", PEAR_DEBUG_TOKEN: TOKEN });
    try {
      const body = async (p) => (await request("GET", p)).body;
      check("§5.1 the room page is the BUILT index",  (await body("/fitting-room/")).includes("BUILT-INDEX"));
      check("§5.2 app.js comes from dist/",           (await body("/fitting-room/app.js")) === "BUILT-APP");
      check("§5.3 style.css comes from dist/",        (await body("/fitting-room/style.css")) === "BUILT-CSS");
      check("§5.4 the widget comes from dist/",       (await body("/widget/pear-widget.js")) === "BUILT-WIDGET");
      check("§5.5 the guide comes from dist/",        (await body("/widget/guide")) === "BUILT-GUIDE");
      check("§5.6 the admin page comes from dist/",   (await body("/admin/")) === "BUILT-ADMIN");
      const cfg = await request("GET", "/fitting-room/config.js");
      check("§5.7 a code file the build did not emit is a 404 - never the readable source",
            cfg.status === 404 && !cfg.body.includes("SOURCE-CONFIG"), `got ${cfg.status} ${cfg.body.slice(0, 40)}`);
      check("§5.8 non-code assets still come from the source directory",
            (await body("/fitting-room/photo.png")) === "SOURCE-PHOTO");
      const sdk = await request("GET", "/fitting-room/rt.0123456789ab.js");
      check("§5.9 the hashed SDK bundle is served with a one-year immutable cache",
            sdk.body === "BUILT-SDK" && /immutable/.test(sdk.headers["cache-control"] || "") && /s-maxage=31536000/.test(sdk.headers["cache-control"] || ""),
            sdk.headers["cache-control"]);
      const app = await request("GET", "/fitting-room/app.js");
      check("§5.10 ...and nothing else is", !/immutable/.test(app.headers["cache-control"] || ""), app.headers["cache-control"]);

      const dbg = await body(`/fitting-room/?pear_debug=${TOKEN}`);
      check("§5.11 the support view serves the SOURCE index",   dbg.includes("SOURCE-INDEX"));
      check("§5.12 ...with its scripts and styles pointed at the token route",
            dbg.includes(`src="/__src/${TOKEN}/fitting-room/app.js?v=1"`) && dbg.includes(`href="/__src/${TOKEN}/fitting-room/style.css?v=1"`), dbg);
      check("§5.13 ...and in-page # links left alone",           dbg.includes('href="#x"'));
      check("§5.14 the token route serves source app.js",        (await body(`/__src/${TOKEN}/fitting-room/app.js`)) === "SOURCE-APP");
      check("§5.15 ...and the modules app.js imports relatively", (await body(`/__src/${TOKEN}/fitting-room/config.js`)) === "SOURCE-CONFIG");
      const wrong = await request("GET", `/__src/${TOKEN.replace(/.$/, "X")}/fitting-room/app.js`);
      check("§5.16 a wrong token is a plain 404", wrong.status === 404 && !wrong.body.includes("SOURCE"), `got ${wrong.status}`);
      check("§5.17 a wrong ?pear_debug gets the built room",
            (await body("/fitting-room/?pear_debug=nope")).includes("BUILT-INDEX"));
      for (const p of [`/__src/${TOKEN}/server.js`, `/__src/${TOKEN}/../server.js`, `/__src/${TOKEN}/fitting-room/../server.js`]) {
        const r = await request("GET", p);
        check(`§5.18 the token route stays inside the public dirs: ${p.replace(TOKEN, "<token>")} → not 200`,
              r.status !== 200 && !r.body.includes("PRIVATE"), `got ${r.status}`);
      }
      check("§5.19 no dist/ warning when dist/ is present", logs.error.length === 0, logs.error.join(" | "));
    } finally {
      await close();
    }
  }
  {
    const { request, close } = await mount(TMP, { PEAR_SERVE_DIST: "1", PEAR_DEBUG_TOKEN: "short" });
    try {
      const r = await request("GET", "/__src/short/fitting-room/app.js");
      check("§5.20 a token under 16 characters disables the support view", r.status === 404, `got ${r.status}`);
    } finally {
      await close();
    }
  }
  {
    fs.rmSync(path.join(TMP, "dist"), { recursive: true, force: true });
    const { request, logs, close } = await mount(TMP, { VERCEL: "1" });
    try {
      check("§5.21 a missing dist/ still serves the room (from source) rather than going down",
            (await request("GET", "/fitting-room/app.js")).body === "SOURCE-APP");
      check("§5.22 ...and says so on the error channel", logs.error.some((l) => /dist\/ is missing/.test(l)), logs.error.join(" | "));
    } finally {
      await close();
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nStatic allowlist: OK" : `\nStatic allowlist: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
