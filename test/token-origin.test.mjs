/* THE RENDER TOKEN NAMES THE PAGE THAT ASKED FOR IT, WHEN THAT PAGE IS OURS (2026-10-01)
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED on a new preview branch: "the live measurement failed: Origin not allowed". The token
   was minted (the CORS gate lets a page call its own host) but scoped to DECART_ALLOWED_ORIGINS
   alone, which named an older preview, so the render engine refused the connection. server.js now
   adds the requesting page's origin to the token's allowedOrigins only when it is this server's own
   host - the rule isOriginAllowed() already applies. Runs server.js's real ownPageOrigin() and
   trySDK() against a fake SDK client.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRV = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const a = SRV.indexOf("function ownPageOrigin(req) {"), b = SRV.indexOf("/* ── Tier 2 & 3");
const src = SRV.slice(a, b);
function load(allowed) {
  const seen = [];
  const decart = { tokens: { create: async (opts) => { seen.push(opts); return { apiKey: "ek_fake", expiresAt: null }; } } };
  const api = new Function("decart", "TOKEN_TTL", "VTON_MODEL", "ALLOWED_ORIGINS", "console",
    src + "\nreturn { ownPageOrigin, trySDK };")(decart, 60, "lucy-vton-3.5", allowed, { log() {}, warn() {}, error() {} });
  return { ...api, seen };
}
const req = (origin, host) => ({ headers: { origin, host } });

const L = ["https://app.pear-ai.io", "https://pear-git-old-branch-pear2.vercel.app"];
{
  const { ownPageOrigin } = load(L);
  check("a page on this server's own host is its own origin", ownPageOrigin(req("https://pear-git-hide-main-v2-pear2.vercel.app", "pear-git-hide-main-v2-pear2.vercel.app")) === "https://pear-git-hide-main-v2-pear2.vercel.app");
  check("a store page calling across origins is NOT (the widget never mints)", ownPageOrigin(req("https://www.fox.co.il", "app.pear-ai.io")) === null);
  check("no Origin header (a GET) adds nothing", ownPageOrigin(req(undefined, "app.pear-ai.io")) === null);
  check("a look-alike host is not ours", ownPageOrigin(req("https://pear-git-x-pear2.vercel.app.evil.com", "pear-git-x-pear2.vercel.app")) === null);
}
{
  const t = load(L);
  await t.trySDK(["https://pear-git-hide-main-v2-pear2.vercel.app"]);
  check("the token is scoped to the list PLUS the requesting preview", JSON.stringify(t.seen[0].allowedOrigins) ===
    JSON.stringify([...L, "https://pear-git-hide-main-v2-pear2.vercel.app"]), JSON.stringify(t.seen[0].allowedOrigins));
  await t.trySDK(["https://app.pear-ai.io"]);
  check("production, already listed, gets exactly the list (no duplicate)", JSON.stringify(t.seen[1].allowedOrigins) === JSON.stringify(L));
  await t.trySDK();
  check("no page origin - the list alone, as main", JSON.stringify(t.seen[2].allowedOrigins) === JSON.stringify(L));
  check("the model scope is unchanged", t.seen.every((o) => JSON.stringify(o.allowedModels) === '["lucy-vton-3.5"]'));
}
{
  const t = load([]);
  await t.trySDK(["https://pear-git-hide-main-v2-pear2.vercel.app"]);
  check("no DECART_ALLOWED_ORIGINS at all - still unscoped, as main (nothing is narrowed)", !("allowedOrigins" in t.seen[0]));
}
check("mintToken() passes the page's own origin into the waterfall",
  /const own = ownPageOrigin\(req\);\s*const token = await mintTokenWaterfall\(own \? \[own\] : \[\]\);/.test(SRV));
console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("token-origin: all checks passed.");
