/* THE ROOM MUST NOT WAIT WHERE THE IN-BROWSER ORIGINAL DID NOT - "the whole interface is laggy"
   (2026-09-27, measured against origin/main on the same machine).
   ─────────────────────────────────────────────────────────────────────────────
   After the fit and the prompt moved server-side, every /api/size and /api/prompt went to Vercel's
   iad1 (~350ms from Israel, 620ms cold) - Continue sat locked for two of them (+~720ms) and go-live
   waited on two more (+~750ms). Fixed by asking the Cloudflare Worker behind the orientation link
   first (~10-20ms, same modules) with the origin as the fallback, and by prefetching the wire
   prompts when the room warms its assets. This suite keeps both:
     §1  edgeApiUrl(): derived from PEAR_ORIENT_URL (wss://host -> https://host; a local wrangler
         dev ws://localhost -> http://localhost), nothing for anything else.
     §2  postPearApi(): the edge first; ANY non-OK, throw or timeout falls back to /api/<route>,
         and a failed edge is skipped for EDGE_API_RETRY_MS instead of taxing every call.
     §3  the size and prompt fetchers go through it - no direct "/api/size" / "/api/prompt" left.
     §4  the room prefetches the four wire-prompt variants when it warms its assets, under the same
         memo key go-live and the turn use (the call site is NOT part of the key). */
import { readFileSync } from "node:fs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = (start) => { const a = APP.indexOf(start); if (a < 0) throw new Error("marker not found: " + start); return APP.slice(a, APP.indexOf("\n}\n", a) + 3); };

console.log("── §1 where the edge is ──");
{
  const src = fn("function edgeApiUrl(route)");
  const url = (v) => new Function("PEAR_ORIENT_URL", src + "\nreturn edgeApiUrl('size');")(v);
  check("wss://rt.pear-ai.io/orient -> https://rt.pear-ai.io/size", url("wss://rt.pear-ai.io/orient") === "https://rt.pear-ai.io/size");
  check("a local wrangler dev (ws://127.0.0.1:8787/orient) -> http://127.0.0.1:8787/size", url("ws://127.0.0.1:8787/orient") === "http://127.0.0.1:8787/size");
  check("no URL, a plain ws:// to a real host, an https URL -> no edge (the origin, as before)",
    url(undefined) === null && url("") === null && url("ws://evil.example/orient") === null && url("https://rt.pear-ai.io/orient") === null);
}

console.log("\n── §2 the edge first, the origin on any doubt ──");
{
  const src = APP.slice(APP.indexOf("const EDGE_API_TIMEOUT_MS"), APP.indexOf("async function requestSizeVerdict(evidence) {"));
  async function scenario(edgeBehaviour, calls = 1, orient = "wss://rt.pear-ai.io/orient", { built = undefined, stamp = undefined } = {}) {
    const log = [];
    const fetch = async (u, init) => {
      log.push(u);
      if (u.startsWith("https://rt.pear-ai.io/")) {
        if (edgeBehaviour === "throw") throw new Error("offline");
        if (edgeBehaviour === "hang") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
        return { ok: edgeBehaviour === "ok", status: edgeBehaviour === "ok" ? 200 : 503, from: "edge",
          headers: { get: (h) => (h === "X-Pear-Api" ? stamp ?? null : null) } };
      }
      return { ok: true, status: 200, from: "origin" };
    };
    const api = new Function("fetch", "PEAR_ORIENT_URL", "setTimeout", "clearTimeout", "PEAR_API_VERSION", src + "\nreturn { postPearApi, EDGE_API_TIMEOUT_MS };")(
      fetch, orient, (f, ms) => setTimeout(f, Math.min(ms, 30)), clearTimeout, built);
    const out = [];
    for (let i = 0; i < calls; i++) out.push((await api.postPearApi("size", "{}")).from);
    return { log, out };
  }
  const ok = await scenario("ok", 2);
  check("a healthy edge answers, and the origin is never asked", ok.out.join() === "edge,edge" && ok.log.every((u) => u.startsWith("https://rt.")), ok.log.join(" "));
  const bad = await scenario("503", 3);
  check("an edge 5xx falls back to /api/size - and the next calls skip the edge for a while",
    bad.out.join() === "origin,origin,origin" && bad.log.filter((u) => u.startsWith("https://rt.")).length === 1 && bad.log.includes("/api/size"), bad.log.join(" "));
  const off = await scenario("throw");
  check("an unreachable edge falls back", off.out.join() === "origin", off.log.join(" "));
  const hang = await scenario("hang");
  check("a hanging edge is abandoned at the timeout and falls back", hang.out.join() === "origin", hang.log.join(" "));
  const none = await scenario("ok", 1, null);   // null, not undefined: undefined would take the default
  check("no PEAR_ORIENT_URL: the origin only, exactly as before", none.out.join() === "origin" && none.log.join() === "/api/size", none.log.join(" "));
  /* 2026-09-30: a built room takes an edge answer only from the engines it was built with. */
  const stale = await scenario("ok", 2, undefined, { built: "aaaa1111bbbb2222" });
  check("a BUILT room and an edge with no X-Pear-Api stamp (an older deploy) -> the origin, and the edge is skipped after",
    stale.out.join() === "origin,origin" && stale.log.filter((u) => u.startsWith("https://rt.")).length === 1, stale.log.join(" "));
  const other = await scenario("ok", 1, undefined, { built: "aaaa1111bbbb2222", stamp: "cccc3333dddd4444" });
  check("...and one stamped with DIFFERENT engines -> the origin", other.out.join() === "origin", other.log.join(" "));
  const same = await scenario("ok", 2, undefined, { built: "aaaa1111bbbb2222", stamp: "aaaa1111bbbb2222" });
  check("...one stamped with the SAME engines is used, and the origin never asked", same.out.join() === "edge,edge" && same.log.every((u) => u.startsWith("https://rt.")), same.log.join(" "));
}

console.log("\n── §3 the fetchers use it ──");
{
  const size = fn("async function requestSizeVerdict(evidence) {"), prompt = fn("async function fetchWirePrompt(body) {");
  check("requestSizeVerdict asks postPearApi('size') - no direct /api/size", /postPearApi\("size"/.test(size) && !/fetch\("\/api\/size"/.test(size));
  check("fetchWirePrompt asks postPearApi('prompt') - no direct /api/prompt", /postPearApi\("prompt"/.test(prompt) && !/fetch\("\/api\/prompt"/.test(prompt));
  check("...and nothing else in the room fetches those routes directly", !/fetch\(["'`]\/api\/(size|prompt)/.test(APP));
}

console.log("\n── §4 the prompts are warm before go-live ──");
{
  const warm = fn("function prewarmOrientationAssets() {");
  check("the room prefetches front/back x square/edge-on when it warms its assets (and the look prompt for a look)",
    /\["front", false\], \["back", false\], \["front", true\], \["back", true\]/.test(warm) && /wirePrompt\(activeItem, angle, "prefetch", \{ inProfile \}\)/.test(warm) &&
    /wireLookPrompt\("prefetch"\)/.test(warm));
  const req = fn("function requestWirePrompt(req, where) {");
  check("...under the SAME memo key go-live and the turn use - the call site is not part of it",
    /const key = JSON\.stringify\(req\);/.test(req) && /fetchWirePrompt\(\{ \.\.\.req, where/.test(req));
}

console.log(fails === 0 ? "\nroom-latency: OK" : `\nroom-latency: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
