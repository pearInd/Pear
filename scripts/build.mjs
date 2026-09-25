#!/usr/bin/env node
/* ============================================================================
   build.mjs — the client a shopper actually downloads
   ----------------------------------------------------------------------------
   WHY THIS EXISTS. Until 2026-09-25 the browser was served the SOURCE: 23k lines
   of app.js with every comment block that records why a decision was made ("THE
   BUG THIS CLOSES", the sizing tables' provenance, the prompt budget), readable
   names, 340 console lines narrating the pipeline, window.__pearDebug* hooks, the
   ?mock_decart=1 harness, and an SDK import whose CDN URL names the vendor. All of
   it was copyable from DevTools. This emits the same code with none of that:

     · every .js in the public dirs minified, comments dropped (legalComments:none),
       no source maps
     · fitting-room/app.js BUNDLED with the modules it imports (config.js, i18n.js),
       so those are not served as separate readable files either
     · console.log/info/debug/warn/group removed (pure) - console.error is kept, it is
       what a real failure leaves behind; the full narration is still one link away
       for support via ?pear_debug=<token> (server.js serves source there)
     · PEAR_DEBUG_BUILD=false: the mock seams and window.__pearDebug* registrations
       fold away, and the mock block is tree-shaken out (see app.js, above
       mockDecartEnabled())
     · PEAR_SDK_BUNDLE: @decartai/sdk bundled from node_modules into rt.js and
       loaded same-origin, so the page carries no vendor-named CDN URL
     · .css minified; .html has its comments stripped and inline scripts minified

   WHAT IT DOES NOT DO: hide what goes over the wire at runtime, or the bundled
   SDK's own internals (its default endpoint URLs live inside rt.js). Minified code
   is harder to read, not impossible - the real protection is moving logic to the
   server, which is the next phase of the same plan.

   THE SOURCE STAYS THE SOURCE. Tests, trace:prompt and qa:visual all run on the
   unbuilt files (tests slice app.js by literal markers - CLAUDE.md §2.6), so this
   never rewrites a source file; it only writes OUT.

   Usage:
     node scripts/build.mjs          → dist/                   production
     node scripts/build.mjs --qa     → dist-qa/                identical minification,
                                       but PEAR_DEBUG_BUILD=true so ?mock_decart=1 still
                                       exists - lets qa:visual drive the MINIFIED room
     node scripts/build.mjs --out <dir>
   ============================================================================ */
import { build, transform } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const QA = args.includes("--qa");
const outAt = args.indexOf("--out");
/* NOT under test-results/: Playwright empties that directory at the start of every run,
   which deleted the QA bundle between building it and serving it. */
const OUT = resolve(ROOT, outAt !== -1 ? args[outAt + 1] : QA ? "dist-qa" : "dist");

/* Lockstep with server.js PUBLIC_DIRS (CLAUDE.md §2.10): a directory the server does not
   publish has nothing to build, and one it does publish must never ship unbuilt. */
const PUBLIC_DIRS = ["fitting-room", "widget"];
const APP_ENTRY = "fitting-room/app.js";
/* rt.<content-hash>.js - a neutral name, and a hashed one: server.js serves exactly this
   pattern with a one-year immutable Cache-Control (the room itself is no-store), so the
   ~800 KB SDK is fetched once per browser rather than on every visit. A new SDK version
   is a new hash, so a stale copy can never be served against new code. */
const SDK_NAME_RE = /^rt\.[0-9a-f]{12}\.js$/;

const fail = (msg) => { console.error(`✖ build: ${msg}`); process.exit(1); };
const rel = (p) => relative(ROOT, p);

/* ── 0. the SDK pin must be one version everywhere ──────────────────────────────
   config.js names the version in its CDN URLs (source/dev path); rt.js is built from
   node_modules (production path). If they drift, dev and production run different SDKs
   and every "verified against @decartai/sdk@x" comment in app.js is wrong for one of them. */
const installed = JSON.parse(readFileSync(join(ROOT, "node_modules/@decartai/sdk/package.json"), "utf8")).version;
const pinned = [...readFileSync(join(ROOT, "fitting-room/config.js"), "utf8").matchAll(/@decartai\/sdk@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
if (!pinned.length) fail("could not find the @decartai/sdk@x.y.z pin in fitting-room/config.js");
for (const v of pinned) if (v !== installed) fail(`config.js pins @decartai/sdk@${v} but node_modules has ${installed} - align them first`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function write(relPath, code) {
  const dest = join(OUT, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, code);
}

const report = [];

/* ── 1. the SDK, same-origin ──────────────────────────────────────────────────
   Re-exported under a neutral name: app.js's loadSDK() reads `createClient` from this
   bundle (PEAR_SDK_BUNDLE folds its CDN branch away), so the vendor's export name never
   appears in the room's own code. The SDK's internals are third-party and ship as-is. */
const sdkResult = await build({
  stdin: { contents: 'export { createDecartClient as createClient } from "@decartai/sdk";', resolveDir: ROOT, loader: "js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  legalComments: "none",
  charset: "utf8",
  write: false,
  logLevel: "warning",
});
const sdkHash = createHash("sha256").update(sdkResult.outputFiles[0].contents).digest("hex").slice(0, 12);
const SDK_OUT = `fitting-room/rt.${sdkHash}.js`;
if (!SDK_NAME_RE.test(SDK_OUT.split("/").pop())) fail(`SDK file name ${SDK_OUT} does not match server.js's cache pattern`);
write(SDK_OUT, sdkResult.outputFiles[0].text);

const JS_OPTS = {
  minify: true,
  legalComments: "none",
  charset: "utf8",
  drop: ["debugger"],
  /* Every narrating console method - group/groupEnd included: app.js opens its startup
     traces with console.group("[PEAR] init() …"), and a group header is a log line. */
  pure: ["console.log", "console.info", "console.debug", "console.warn", "console.group",
         "console.groupCollapsed", "console.groupEnd", "console.table", "console.dir", "console.trace"],
  define: {
    PEAR_DEBUG_BUILD: QA ? "true" : "false",
    PEAR_SDK_BUNDLE: JSON.stringify("./" + SDK_OUT.split("/").pop()),
  },
};

/* ── 2. the room: one bundle, its imports folded in ─────────────────────────── */
const appResult = await build({
  ...JS_OPTS,
  entryPoints: [join(ROOT, APP_ENTRY)],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  metafile: true,
  logLevel: "warning",
});
write(APP_ENTRY, appResult.outputFiles[0].text);
report.push([APP_ENTRY, statSync(join(ROOT, APP_ENTRY)).size, appResult.outputFiles[0].contents.length]);
/* Everything the bundle absorbed is not emitted on its own - so config.js and i18n.js
   404 in production instead of being served as readable side files. */
const bundled = new Set(Object.keys(appResult.metafile.inputs).map((p) => resolve(ROOT, p)));

report.push([`${SDK_OUT} (@decartai/sdk@${installed})`, 0, sdkResult.outputFiles[0].contents.length]);

/* ── 3. every other public file that carries code or commentary ─────────────── */
const INLINE_SCRIPT = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
async function minifyInlineScripts(html) {
  const parts = [];
  let last = 0;
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const attrs = m[1] || "";
    const body = m[2];
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
    const isJs = !/\bsrc\s*=/i.test(attrs) && body.trim() && (!type || /^(module|text\/javascript)$/i.test(type));
    parts.push(html.slice(last, m.index));
    if (isJs) {
      const { code } = await transform(body, { ...JS_OPTS, loader: "js" });
      parts.push(`<script${attrs}>${code.trim()}</script>`);
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

for (const dir of PUBLIC_DIRS) {
  for (const abs of walk(join(ROOT, dir))) {
    const r = rel(abs);
    const ext = extname(abs).toLowerCase();
    if (r === APP_ENTRY || bundled.has(abs)) continue;
    const src = readFileSync(abs, "utf8");
    let code;
    if (ext === ".js" || ext === ".mjs") {
      /* Classic scripts here are all IIFE-wrapped (so minify renames only their locals);
         no `format`, so a script stays a script and a module stays a module. */
      code = (await transform(src, { ...JS_OPTS, loader: "js" })).code;
    } else if (ext === ".css") {
      code = (await transform(src, { minify: true, loader: "css", legalComments: "none", charset: "utf8" })).code;
    } else if (ext === ".html") {
      /* Comments only, never whitespace or tags: server.js rewrites the room's <head>
         by string match, and a collapsed document is not worth that risk. */
      code = await minifyInlineScripts(src.replace(/<!--[\s\S]*?-->/g, ""));
    } else {
      continue;   // images, video, svg: not code - server.js serves those from source
    }
    write(r, code);
    report.push([r, Buffer.byteLength(src), Buffer.byteLength(code)]);
  }
}

/* ── 4. prove it: what must never reach a shopper ───────────────────────────────
   A guard that fails the BUILD, so a future source edit that re-exposes one of these
   (an unguarded debug hook, an unconditional mock seam) cannot deploy quietly. The QA
   build keeps the mock and debug hooks on purpose, so only the universal checks apply. */
const FORBIDDEN = [
  ["a source comment block", /THE BUG THIS CLOSES|THE ROOT CAUSE/],
  ["a vendor CDN URL", /esm\.sh|cdn\.jsdelivr\.net\/npm\/@decartai/],
  ["the vendor's SDK export name", /createDecartClient/],
  ["a source map reference", /sourceMappingURL/],
];
if (!QA) {
  FORBIDDEN.push(
    ["a developer key hint", /DECART_API_KEY/],
    /* Which engines PEAR runs on is not public information - not in code, not in a log
       line, not in the merchant guide's marketing copy (which named both until
       2026-09-26). The model id the SDK is handed ("lucy-…") is the one exception: it
       travels to the engine on every connect regardless, so it is reported below
       rather than refused here until the connection itself is proxied. */
    ["a vendor or engine name", /decart|nano ?banana|gemini|livekit/i],
    /* The prompt engine is server-side (lib/prompts.js, since 2026-09-26): the room bundle
       must carry none of its wording - these are fragments of its anchors and of the
       restore seam that only the engine has. */
    ["prompt-engine wording", /Drape and fit the EXACT|Fit and replace BOTH the subject|Reproduce the reference's front closure|rear view, turned around|TURNED TO THEIR SIDE|clean break at the ankle/],
    ["the mock harness", /mock_decart|createMockDecartClient|__pearMock/],
    /* An ASSIGNMENT, not a mention: console.error hints may still name a hook ("run
       window.__pearDebugReinjectGarment()"), which is harmless when nothing registers it. */
    ["a debug hook registration", /__pearDebug[A-Za-z]*\s*=(?!=)/],
  );
}
let violations = 0;
for (const abs of walk(OUT)) {
  if (relative(OUT, abs) === SDK_OUT) continue;   // third-party code, shipped as-is
  const text = readFileSync(abs, "utf8");
  for (const [what, re] of FORBIDDEN) {
    const m = text.match(re);
    if (m) { violations++; console.error(`✖ ${relative(OUT, abs)} still contains ${what}: "${m[0]}"`); }
  }
}

const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";
console.log(`\n🍐 PEAR build → ${rel(OUT)}${QA ? "   (QA: debug + mock kept)" : ""}`);
for (const [name, before, after] of report) {
  console.log(`   ${name.padEnd(44)} ${before ? kb(before) + " →" : "".padStart(13)} ${kb(after)}`);
}
/* The size charts and the fit are server-side (lib/sizing.js, POST /api/size, since
   2026-09-26). A body-measurement band key in the room bundle means a chart - or a copy of
   the fit - found its way back into the browser. Room bundle only: the widget legitimately
   builds band rows when it scrapes a store's own chart. */
{
  const room = readFileSync(join(OUT, APP_ENTRY), "utf8");
  const band = room.match(/\b(?:min|max)(?:Chest|Waist|Hips|Legs|Height|Weight)\b/);
  if (band) {
    violations++;
    console.error(`✖ ${APP_ENTRY} carries a size-chart band key ("${band[0]}") - the charts live in lib/sizing.js`);
  }
}

/* Reported, not enforced: the model id (see the FORBIDDEN note above). Anything else
   listed here in a production build is worth a look. */
for (const abs of walk(OUT)) {
  const f = relative(OUT, abs);
  if (f === SDK_OUT) continue;
  const hits = readFileSync(abs, "utf8").match(/lucy[\w.-]*/gi) || [];
  if (hits.length) console.log(`   engine model id in ${f}: ${[...new Set(hits)].join(", ")} (goes on the wire regardless)`);
}
if (violations) fail(`${violations} forbidden string(s) in the output - see above`);
console.log("   ✓ no forbidden strings in the output\n");
