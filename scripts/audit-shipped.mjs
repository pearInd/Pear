#!/usr/bin/env node
/* =============================================================================
   What a shopper's browser can read - an audit of the DEPLOYED room and widget (2026-11-01)
   -----------------------------------------------------------------------------
   Fetches the production widget and the fitting room the way a browser does (the page, every
   script and stylesheet it names, every module a script imports by a relative path) and reports:
     · secrets: anything shaped like an API key, a JWT, a private key or a token (by PATTERN -
       this script never reads a real key, so it can run anywhere);
     · source maps: a `sourceMappingURL` comment, or a `<file>.map` that the server answers 200;
     · engine words: a vendor, model or library name (CLAUDE.md §2.24 - the build refuses them);
     · prompt wording: phrases of lib/prompts.js's anchors (§2.13 - the browser carries none).
   usage: node scripts/audit-shipped.mjs [origin=https://app.pear-ai.io]
   Exit 1 on any secret, served map, engine word or prompt wording - in a file, or in the /prompt answer of the
   origin or the edge (2026-11-02: the page holds a token, never the words - lib/prompt-token.js).
   ============================================================================= */
const ORIGIN = (process.argv[2] || "https://app.pear-ai.io").replace(/\/$/, "");
const ROOTS = [`${ORIGIN}/widget/pear-widget.js`, `${ORIGIN}/fitting-room/`];

const SECRETS = [
  ["google api key", /AIza[0-9A-Za-z\-_]{35}/g],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["secret key (sk-/sk_)", /\bsk[-_](?:live_|test_|proj-)?[A-Za-z0-9]{20,}/g],
  ["ephemeral token (ek_)", /\bek_[A-Za-z0-9]{12,}/g],
  ["supabase key", /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g],
  ["service role", /service_role/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer literal", /Bearer\s+[A-Za-z0-9._-]{20,}/g],
  ["api key query", /[?&](?:api_key|apikey|key)=[A-Za-z0-9._-]{16,}/g],
];
const ENGINE_WORDS = /\b(decart|lucy|gemini|generativelanguage|mediapipe|tasks-vision|livekit|openai|anthropic)\b|(?<!fonts\.)googleapis/gi;
const PROMPT_PHRASES = ["Drape and fit the EXACT", "Strictly preserve", "REAR/BACK", "body contour and volume", "flawless natural drape",
  "Keep the subject's lower body", "Reproduce the rear panel"];

const seen = new Map();
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (pear-audit)" } });
  return { status: r.status, type: r.headers.get("content-type") || "", text: r.ok ? await r.text() : "" };
}
function linksOf(base, text, type) {
  const out = new Set();
  const add = (u) => { try { const x = new URL(u, base); if (x.origin === ORIGIN) out.add(x.href.split("#")[0]); } catch (_) {} };
  if (/html/.test(type)) for (const m of text.matchAll(/(?:src|href)="([^"]+\.(?:js|mjs|css)(?:\?[^"]*)?)"/g)) add(m[1]);
  if (/javascript|ecmascript/.test(type) || /\.m?js(\?|$)/.test(base)) {
    for (const m of text.matchAll(/(?:import\(|from\s*|import\s*)["'`](\.{1,2}\/[^"'`]+?\.m?js)["'`]/g)) add(m[1]);
    for (const m of text.matchAll(/["'`](\.{0,2}\/?(?:[a-z]{1,3}\/)?[a-z]{1,3}\.[0-9a-f]{6,}\.m?js)["'`]/g)) add(m[1]);
    for (const m of text.matchAll(/["'`](\/[a-z0-9_\/-]+\/[a-z]{1,3}\.[0-9a-f]{6,}\.m?js)["'`]/g)) add(m[1]);   // absolute (the pose modules)
  }
  return [...out];
}

const findings = { secret: [], map: [], engine: [], prompt: [] };
const queue = [...ROOTS];
while (queue.length) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  const res = await get(url);
  seen.set(url, res.status);
  if (!res.text) continue;
  for (const [name, re] of SECRETS) for (const m of res.text.matchAll(re)) findings.secret.push(`${name}: ${m[0].slice(0, 12)}… in ${url}`);
  if (/sourceMappingURL=/.test(res.text)) findings.map.push(`sourceMappingURL comment in ${url}`);
  if (/\.(m?js|css)(\?|$)/.test(new URL(url).pathname + "?")) {
    const mapUrl = url.split("?")[0] + ".map";
    const mr = await fetch(mapUrl, { method: "GET" });
    if (mr.status === 200) findings.map.push(`${mapUrl} answers 200`);
  }
  const words = [...new Set([...res.text.matchAll(ENGINE_WORDS)].map((m) => m[0].toLowerCase()))];
  if (words.length) findings.engine.push(`${words.join(", ")} in ${url}`);
  for (const ph of PROMPT_PHRASES) if (res.text.includes(ph)) findings.prompt.push(`"${ph}" in ${url}`);
  for (const l of linksOf(url, res.text, res.type)) if (!seen.has(l)) queue.push(l);
}

/* The edge's static assets the room loads (the pose runtime and model, XOR-scrambled - §2.24): scanned as bytes. */
const appText = [...seen.keys()].filter((u) => /\/app\.js/.test(u)).length ? (await get([...seen.keys()].find((u) => /\/app\.js/.test(u)))).text : "";
for (const m of new Set([...appText.matchAll(/rt\.pear-ai\.io\/a\/[0-9a-f]{12,}/g)].map((x) => x[0]))) {
  const url = "https://" + m;
  const r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer());
  seen.set(url, r.status);
  const words = [...new Set([...buf.toString("latin1").matchAll(ENGINE_WORDS)].map((x) => x[0].toLowerCase()))];
  if (words.length) findings.engine.push(`${words.join(", ")} in ${url} (${buf.length} bytes)`);
  for (const [name, re] of SECRETS) if (re.test(buf.toString("latin1"))) findings.secret.push(`${name} in ${url}`);
}

/* The answers themselves: what a page really receives from /prompt, at the origin and at the edge. */
const PROBE = JSON.stringify({ kind: "single", item: { title: "basic cotton t-shirt", __bottoms: false }, angle: "back", inProfile: false, delta: 0 });
for (const url of [`${ORIGIN}/api/prompt`, process.env.PEAR_EDGE_PROMPT_URL || "https://rt.pear-ai.io/prompt"]) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: PROBE });
    const text = await r.text();
    for (const ph of PROMPT_PHRASES) if (text.includes(ph)) findings.prompt.push(`"${ph}" in the answer of ${url}`);
    console.log(`/prompt ${r.status} ${url}: ${/"prompt":"pt1\./.test(text) ? "a token" : "NOT a token"}`);
    if (!/"prompt":"pt1\./.test(text)) findings.prompt.push(`${url} did not answer a token`);
  } catch (e) { console.log(`/prompt unreachable ${url}: ${e?.message || e}`); }
}

console.log(`audited ${seen.size} files from ${ORIGIN}:`);
for (const [u, s] of seen) console.log(`  ${s}  ${u.replace(ORIGIN, "")}`);
for (const [k, label] of [["secret", "SECRETS"], ["map", "SOURCE MAPS"], ["engine", "ENGINE WORDS"], ["prompt", "PROMPT WORDING"]]) {
  console.log(`\n${label}: ${findings[k].length ? "" : "none"}`);
  for (const f of findings[k]) console.log("  " + f);
}
process.exit(findings.secret.length || findings.map.length || findings.engine.length || findings.prompt.length ? 1 : 0);
