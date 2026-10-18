/* THE ENGINE-SPEED EXPERIMENT (2026-10-04) - TEST sessions only
   ─────────────────────────────────────────────────────────────────────────────
   The PEAK tee's references are acknowledged in 323-1,582ms (the OASIS tee's in 130-250ms) and on a fast turn that is
   the back print on the chest. The owner approved 3-4 short real sessions to measure what makes the engine accept a
   reference faster: a lighter image ("small"), or an id the engine already holds ("ref" - both references uploaded once
   at connect, through our edge). What this suite pins:
   §1 ONLY A TEST SESSION: the mode is read from ?pear_exp= only when the session is recorded (store key TEST or
      ?pear_trace=1); a shopper's session runs none of it, whatever the URL says.
   §2 THE SEND: with an id for a reference, the client's set() sends the id in its place; without one, the pre-encoded
      data URL as before.
   §3 THE CLIENT: only the "ref" mode points the render client's REST base at our edge (/f) - never the engine's host.
   §4 THE EDGE ROUTE (cloudflare/orient/src/rt.js): only POST /f/v1/files is forwarded, to RT_FILES_URL (config, not
      code), with the sealed key opened and the room's user agent mapped back; a bad ticket opens nothing; the answer
      names no engine.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { sealTicket } from "../lib/rt-proxy.js";
import { VENDOR_WORDS } from "../scripts/cloak.mjs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`);
}
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const between = (src, a, b) => {
  const i = src.indexOf(a); if (i === -1) throw new Error(`no "${a}"`);
  const j = src.indexOf(b, i); if (j === -1) throw new Error(`no "${b}"`);
  return src.slice(i, j);
};
const EXP = between(APP, "const PEAR_EXP = (() => {", "\n/** The \"small\" mode:");

console.log("\n── §1 only a TEST session ──");
{
  const mode = (search, test) => new Function("location", "traceEnabled", EXP + "\nreturn [PEAR_EXP, EXP_SMALL, EXP_REF, EXP_NOTEL];")(
    { search }, () => test);
  /* EXP_REF is every session's since 2026-10-16 (THE REFERENCES GO UP BEFORE THE SESSION - r1/r2): the third slot is true
     without a mode, and ?ref_upload=0 turns it off in any session. The other experiments stay TEST-only. */
  check("§1.1 a TEST session reads the mode", JSON.stringify(mode("?pear_exp=small-ref", true)) === JSON.stringify(["small-ref", true, true, false]) &&
    JSON.stringify(mode("?pear_exp=notel", true)) === JSON.stringify(["notel", false, true, true]));
  check("§1.2 a shopper's session runs none of the EXPERIMENTS, whatever the URL says (the reference upload is everyone's)",
    JSON.stringify(mode("?pear_exp=small", false)) === JSON.stringify(["", false, true, false]) &&
    JSON.stringify(mode("?pear_exp=notel", false)) === JSON.stringify(["", false, true, false]));
  check("§1.5 the reference upload is every session's, and ?ref_upload=0 sends the bytes (TEST or not)",
    mode("", false)[2] === true && mode("?ref_upload=0", false)[2] === false && mode("?ref_upload=0&pear_exp=ref", true)[2] === true);
  check("§1.3 an unknown mode is no mode", mode("?pear_exp=fast", true)[0] === "");
  check("§1.4 ...and the TEST record carries it", /exp: typeof PEAR_EXP !== "undefined" && PEAR_EXP \? PEAR_EXP : undefined,/.test(APP));
  /* THE HEM LENGTH EXPERIMENT (2026-10-18, "the shirt went into the pants and got smaller"): TEST-only like the others. */
  check("§1.6 \"long\" and \"legs\" are a TEST session's modes, and no shopper's",
    mode("?pear_exp=long", true)[0] === "long" && mode("?pear_exp=legs", true)[0] === "legs" &&
    mode("?pear_exp=long", false)[0] === "" && mode("?pear_exp=legs", false)[0] === "");
}

console.log("\n── §1c the hem length experiment: one change per arm, only on request, front tops only ──");
{
  const { promptForRequest, sanitizePromptRequest } = await import("../lib/prompts.js");
  const CLAUSE = "Render the reference's full garment length, its hem hanging freely over the hips.";
  /* The reported product as the room describes it (FOX PEAK: "a shirt with a print"), the structured top anchor. */
  const req = (extra, item = { name: "חולצה עם הדפס", title: "חולצה עם הדפס", type: "shirt", garmentType: "upper_body", __bottoms: false }) => promptForRequest(sanitizePromptRequest({
    kind: "single", angle: "front", delta: 0, item, ...extra }));
  const plain = req({}), long = req({ exp: "long" }), legs = req({ exp: "legs" });
  check("§1c.1 the room sends that exp with every prompt request in those modes - nothing otherwise",
    /fetchWirePrompt\(\{ \.\.\.req, where: where \|\| "prompt",\s*\n\s*\.\.\.\(typeof PEAR_EXP !== "undefined" && \(PEAR_EXP === "long" \|\| PEAR_EXP === "legs"\) \? \{ exp: PEAR_EXP \} : \{\}\) \}\)/.test(APP));
  check("§1c.2 \"long\" adds exactly the length clause; the rest of the prompt is unchanged",
    !plain.includes(CLAUSE) && long.includes(CLAUSE) && long.replace(" " + CLAUSE, "") === plain, long);
  check("§1c.3 \"legs\" changes the lower-body lock's region and nothing else",
    plain.includes("Keep the subject's lower body, shoes,") && !legs.includes("lower body") &&
    legs.replace("Keep the subject's legs, shoes,", "Keep the subject's lower body, shoes,") === plain, legs);
  check("§1c.4 any other exp is main's wire, byte for byte", req({ exp: "pass" }) === plain && req({ exp: 1 }) === plain);
  check("§1c.5 ...and the request state is reset after each prompt (the next request is main's)", req({}) === plain);
  check("§1c.6 the back, a bottom and the full look are untouched by either arm",
    ["long", "legs"].every((exp) => req({ exp, angle: "back" }) === req({ angle: "back" }) &&
      req({ exp }, { name: "shorts", type: "shorts", __bottoms: true }) === req({}, { name: "shorts", type: "shorts", __bottoms: true }) &&
      promptForRequest(sanitizePromptRequest({ kind: "look", exp })) === promptForRequest(sanitizePromptRequest({ kind: "look" }))));
}

console.log("\n── §2 the send ──");
{
  const pe0 = APP.indexOf("const _preEncodedRefs = new WeakMap();"), pe1 = APP.indexOf("\nfunction garmentBlobIfWarm(", pe0);
  const ids = new WeakMap();
  const pe = new Function("FileReader", "Blob", "_expFileIds", APP.slice(pe0, pe1) + "\nreturn { withPreEncodedReferences };")(
    class { readAsDataURL() {} }, Blob, ids);
  const sent = [];
  const client = pe.withPreEncodedReferences({ set: (x) => { sent.push(x); return Promise.resolve(); } });
  const withId = new Blob(["a"]), without = new Blob(["b"]);
  ids.set(withId, "file_abc123");
  client.set({ image: withId, prompt: "p" }); client.set({ image: without, prompt: "q" });
  check("§2.1 a reference the engine holds is sent as its id", sent[0].image === "file_abc123" && sent[0].prompt === "p", JSON.stringify(sent[0]));
  check("§2.2 ...and one it does not is sent as before (the Blob, no pre-encoding yet)", sent[1].image === without);
}

console.log("\n── §3 the client ──");
{
  check("§3.1 only the \"ref\" mode points the render client's REST base at our edge",
    /\.\.\.\(typeof EXP_REF !== "undefined" && EXP_REF && typeof expFilesBase === "function" && expFilesBase\(\) \? \{ baseUrl: expFilesBase\(\) \} : \{\}\)/.test(APP));
  check("§3.1b only the \"notel\" mode turns the render SDK's telemetry off - a shopper's client is created as main's",
    /\.\.\.\(typeof EXP_NOTEL !== "undefined" && EXP_NOTEL \? \{ telemetry: !EXP_NOTEL \} : \{\}\) \}\);/.test(APP) &&
    (APP.match(/[{,]\s*telemetry:/g) || []).length === 1);
  const baseOf = (edge) => new Function("rtEdgeUrl", between(APP, "function expFilesBase() {", "\n/** Upload the session") + "\nreturn expFilesBase();")(() => edge);
  /* The built room's realtime URL carries its path (`${EDGE.ws}/v`, scripts/build.mjs) - the first real "ref" session
     posted to /v/f/... because this check only ever saw a bare origin. */
  const base = baseOf("wss://rt.example.io/v"), bare = baseOf("wss://rt.example.io"), local = baseOf("ws://127.0.0.1:8787/v");
  check("§3.2 ...which is our host's https /f (the edge's ORIGIN, whatever path the realtime URL carries), never the engine's",
    base === "https://rt.example.io/f" && bare === "https://rt.example.io/f" && local === "http://127.0.0.1:8787/f", `${base} ${bare} ${local}`);
  const expCode = between(APP, "/* ── THE ENGINE-SPEED EXPERIMENT (2026-10-04)", "\nfunction garmentBlobCached(url) {");
  check("§3.3 the experiment names no engine host - its uploads only ever go to our edge", !VENDOR_WORDS.test(expCode) && !/https?:\/\/[a-z]/i.test(expCode));
}

console.log("\n── §4 the edge route ──");
{
  const { handleRt } = await import("../cloudflare/orient/src/rt.js");
  const env = { RT_SIGNAL_URL: "https://engine.example/v1/stream", RT_MODEL: "m", RT_FILES_URL: "https://files.example/v1/files" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"id":"file_x1","note":"Decart files"}', { status: 200 }); };
  try {
    const req = (path, method, headers = {}) => new Request("https://rt.example.io" + path, { method, headers: { Origin: "https://app.example", ...headers },
      body: method === "POST" ? "--b\r\n\r\nx\r\n--b--" : undefined, duplex: "half" });
    const ok = await handleRt(req("/f/v1/files", "POST", { "X-API-KEY": sealTicket("ek_real"), "User-Agent": "rt-js/0.1.5 lang/js",
      "Content-Type": "multipart/form-data; boundary=b" }), env, new URL("https://rt.example.io/f/v1/files"), true);
    const body = await ok.text();
    const c = calls[0];
    check("§4.1 POST /f/v1/files goes to RT_FILES_URL with the key opened, the user agent mapped back and the multipart type kept",
      ok.status === 200 && c && c.url === env.RT_FILES_URL && c.init.headers["X-API-KEY"] === "ek_real" &&
      /decart-js-sdk\/0\.1\.5/.test(c.init.headers["User-Agent"]) && /multipart\/form-data; boundary=b/.test(c.init.headers["Content-Type"]),
      JSON.stringify(c && c.init.headers));
    check("§4.2 ...and the answer keeps the id, naming no engine", /file_x1/.test(body) && !VENDOR_WORDS.test(body), body);
    calls.length = 0;
    const bad = await handleRt(req("/f/v1/files", "POST", { "X-API-KEY": "nope" }), env, new URL("https://rt.example.io/f/v1/files"), true);
    const other = await handleRt(req("/f/v1/files/file_x1", "GET"), env, new URL("https://rt.example.io/f/v1/files/file_x1"), true);
    const foreign = await handleRt(req("/f/v1/files", "POST", { "X-API-KEY": sealTicket("ek_real") }), env, new URL("https://rt.example.io/f/v1/files"), false);
    check("§4.3 a bad ticket opens nothing, nothing but the upload is forwarded, and a foreign origin is refused",
      bad.status === 401 && other.status === 404 && foreign.status === 403 && calls.length === 0, `${bad.status} ${other.status} ${foreign.status} ${calls.length}`);
    const wr = readFileSync(new URL("../cloudflare/orient/wrangler.jsonc", import.meta.url), "utf8");
    const rt = readFileSync(new URL("../cloudflare/orient/src/rt.js", import.meta.url), "utf8");
    check("§4.4 the engine's file host is Worker config, not code", /"RT_FILES_URL":/.test(wr) && !/api\.decart\.ai/.test(rt));
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${fails ? `✗ ${fails} failed` : "✓ all passed"}`);
process.exit(fails ? 1 : 0);
