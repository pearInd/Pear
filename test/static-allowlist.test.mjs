/* STATIC ALLOWLIST - "the server was handing out its own source"
   ─────────────────────────────────────────────────────────────────────────────
   THE REPORT THIS CLOSES: server.js served the whole repository as static files.
   `express.static(__dirname)` plus a page router rooted at the repo answered 200 for
   /server.js, /CLAUDE.md, /package.json, /scanner/scan-store.js, /test/run.mjs and
   /docs/… - every sizing table, prompt rule and classifier heuristic, comments
   included, one GET away. Verified 2026-09-25 with a probe running that exact config.

   This slices server.js's real static-hosting block (from "/* ── Static hosting" to
   the "/* ── Start (local only" banner), mounts it on a fresh express app with nothing
   else, and asserts both halves:
     §1  private paths 404 - stated as an ABSENCE, the only form that catches a new
         well-meant "just serve the root" line
     §2  public paths still load - an allowlist that 404s the fitting room is not a fix
     §3  traversal out of a public directory does not reach the repo
     §4  source-level: nothing in server.js serves the repo root any more
   ============================================================================= */
import { readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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

const BLOCK = extract(SERVER, "/* ── Static hosting", "/* ── Start (local only");

/* The block runs with ONLY these in scope - if it ever reaches for anything else it
   throws here, which is the self-containment rule of CLAUDE.md §2.6. The page router
   logs every hit; a silent console keeps this suite's output to PASS/FAIL lines. */
const quiet = { log() {}, warn() {}, error() {} };
const app = express();
new Function("app", "express", "path", "fs", "__dirname", "console", BLOCK)(app, express, path, fs, ROOT, quiet);

const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const port = server.address().port;

/* Raw http rather than fetch(): fetch normalises "../" out of a URL before it is sent,
   which would make the traversal checks in §3 test nothing. */
function request(method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: rawPath }, (res) => {
      let bytes = 0;
      res.on("data", (c) => { bytes += c.length; });
      res.on("end", () => resolve({ status: res.statusCode, bytes }));
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  console.log("── §1 private paths are not served ──");
  const PRIVATE = [
    "/server.js", "/CLAUDE.md", "/package.json", "/package-lock.json", "/vercel.json",
    "/scanner/scan-store.js", "/test/run.mjs", "/scripts/trace-prompt.mjs",
    "/lib/garment-category.js", "/archive/DESIGN.md", "/docs/", "/.env", "/.env.example",
    "/node_modules/express/package.json", "/", "/index.html",
  ];
  for (const p of PRIVATE) {
    const r = await request("GET", p);
    check(`§1 GET ${p} → 404`, r.status === 404, `got ${r.status} (${r.bytes} bytes)`);
  }

  console.log("\n── §2 public paths still load ──");
  const PUBLIC = [
    ["GET",  "/fitting-room/app.js"],
    ["GET",  "/fitting-room/config.js"],
    ["GET",  "/fitting-room/style.css"],
    ["GET",  "/widget/pear-widget.js"],
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
    check(`§3 GET ${p} → not 200`, r.status !== 200, `got ${r.status} (${r.bytes} bytes)`);
  }
} finally {
  server.close();
}

/* Comments are stripped first: the block's own THE BUG THIS CLOSES note quotes the old
   `express.static(__dirname)` line, and a record of the bug must not trip the check for it. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SERVER_CODE = stripComments(SERVER);
const BLOCK_CODE  = stripComments(BLOCK);

console.log("\n── §4 source-level: nothing serves the repo root ──");
check("§4.1 no express.static(__dirname …) anywhere in server.js",
      !/express\.static\(\s*__dirname\s*[,)]/.test(SERVER_CODE));
check("§4.2 no express.static(uiRoot …) anywhere in server.js",
      !/express\.static\(\s*uiRoot\s*[,)]/.test(SERVER_CODE));
check("§4.3 the page router has no root-level SPA fallback",
      !/path\.join\(\s*uiRoot\s*,\s*["']index\.html["']\s*\)/.test(BLOCK_CODE));

console.log(fails === 0 ? "\nStatic allowlist: OK" : `\nStatic allowlist: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
