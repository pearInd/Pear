/* THE EDGE ANSWERS WITH THE ROOM'S OWN ENGINES, OR NOT AT ALL (2026-09-30)
   ─────────────────────────────────────────────────────────────────────────────
   The Worker answers /size and /prompt from whatever copy of lib/sizing.js and lib/prompts.js was
   last deployed; measured on 2026-09-30 it still said "top" on every back view where the room's
   engine says "shirt". lib/api-version.js is the fingerprint of those two modules
   (scripts/sync-api-version.mjs): the Worker stamps it on every answer (X-Pear-Api), the build
   stamps it into the room (PEAR_API_VERSION), and postPearApi() takes an edge answer only when they
   agree (room-latency §2 drives that). Pinned here:
   §1 the committed fingerprint is the modules' - a module edit without `npm run sync:api-version`
      fails the suite;
   §2 the Worker stamps every JSON answer with it, and exposes the header to the page;
   §3 the build defines it for the room and refuses a stale one.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { apiFingerprint, renderApiVersion } from "../scripts/sync-api-version.mjs";
import { API_VERSION } from "../lib/api-version.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 the fingerprint is current ──");
{
  const fp = apiFingerprint();
  check("§1.1 lib/api-version.js is the fingerprint of lib/prompts.js + lib/sizing.js - run `npm run sync:api-version` if this fails",
    API_VERSION === fp && readFileSync(new URL("../lib/api-version.js", import.meta.url), "utf8").replace(/\r\n/g, "\n") === renderApiVersion(fp),
    `committed ${API_VERSION} vs ${fp}`);
  const P = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8"), S = readFileSync(new URL("../lib/sizing.js", import.meta.url), "utf8");
  check("§1.2 one character in either module moves it", apiFingerprint([P + " ", S]) !== fp && apiFingerprint([P, S.replace("shirt", "shirT")]) !== fp);
}

console.log("\n── §2 the Worker stamps its answers ──");
{
  const W = await import("../cloudflare/orient/src/worker.js");
  const env = { ALLOWED_ORIGINS: "https://app.pear-ai.io" };
  const req = (route, body) => new Request("https://rt.pear-ai.io" + route, { method: "POST", headers: { Origin: "https://app.pear-ai.io", "Content-Type": "application/json" }, body });
  const quiet = console.log; console.log = () => {};
  let size, prompt, bad;
  try {
    size = await W.handleApi(req("/size", JSON.stringify({ height: 178, weight: 74, product: {} })), env, "/size");
    prompt = await W.handleApi(req("/prompt", JSON.stringify({ item: { name: "tee", __bottoms: false }, angle: "back" })), env, "/prompt");
    bad = await W.handleApi(req("/size", "{not json"), env, "/size");
  } finally { console.log = quiet; }
  check("§2.1 /size carries X-Pear-Api = the fingerprint", size.status === 200 && size.headers.get("X-Pear-Api") === API_VERSION, size.headers.get("X-Pear-Api"));
  check("§2.2 /prompt too", prompt.status === 200 && prompt.headers.get("X-Pear-Api") === API_VERSION);
  check("§2.3 ...and so does an error answer (the stamp says which engines refused it)", bad.status === 400 && bad.headers.get("X-Pear-Api") === API_VERSION);
  check("§2.4 the page may read it (Access-Control-Expose-Headers)", /X-Pear-Api/.test(size.headers.get("Access-Control-Expose-Headers") || ""));
}

console.log("\n── §3 the build ──");
{
  const B = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  check("§3.1 the room is built with PEAR_API_VERSION = lib/api-version.js", /PEAR_API_VERSION: JSON\.stringify\(API_VERSION\)/.test(B) &&
    /import \{ API_VERSION \} from "\.\.\/lib\/api-version\.js";/.test(B));
  check("§3.2 ...and a stale fingerprint fails the build", /if \(API_VERSION !== apiFingerprint\(\)\) fail\(/.test(B));
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  check("§3.3 postPearApi() takes an edge answer only with the matching stamp",
    /const sameEngine = !want \|\| \(resp\.headers && typeof resp\.headers\.get === "function" && resp\.headers\.get\("X-Pear-Api"\) === want\);/.test(APP) &&
    /if \(resp\.ok && sameEngine\) return resp;/.test(APP));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("api-version: all checks passed.");
