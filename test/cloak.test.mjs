/* THE CLOAK - no engine name readable in a shipped file, same behaviour (2026-10-03)
   ─────────────────────────────────────────────────────────────────────────────
   scripts/cloak.mjs rewrites every syntax position a vendor word can occupy into an
   expression that yields the same value at runtime. What this suite pins:
   §1 SAME BEHAVIOUR: a program exercising every rewritten position (strings, templates, regexes,
      member names incl. optional chaining and assignment, object/pattern/class keys, shorthand,
      methods, getters, switch cases, a directive) runs to the identical result cloaked.
   §2 NOTHING READABLE: the cloaked text carries no vendor word; renamed protocol words become
      their alias and travel as the alias (that is the point - the edge translates them back).
   §3 WHAT IT REFUSES: a free identifier naming a vendor is reported, never silently left.
   §4 THE REAL BUNDLES: the render SDK bundle cloaks with nothing unhandled and still exports
      its factory.
   ============================================================================= */
import { cloak, vendorHits, VENDOR_WORDS } from "../scripts/cloak.mjs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 600)}`);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("\n── §1 same behaviour ──");
const PROGRAM = `"use strict";
const out = [];
const host = "wss://api3.decart.ai";
out.push(host, "plain", 'livekit_join');
const v = 3;
out.push(\`decart-js-sdk/\${v} lang/js\`, \`no match \${v}\`, \`\${v}\`);
out.push(/livekit\\.cloud$/i.test("x.LIVEKIT.cloud"), /plain/.test("plain"));
const msg = { livekit_url: "u", token: "t", "livekitUrl": 1, nested: { decartKey: 2 } };
out.push(msg.livekit_url, msg.livekitUrl, msg?.nested?.decartKey, msg["livekit_url"]);
msg.livekitUrl = 9; msg.nested.decartKey += 1;
out.push(msg.livekitUrl, msg.nested.decartKey);
const { livekit_url, livekitUrl: lk = 5, missingLivekit = 7 } = msg;
out.push(livekit_url, lk, missingLivekit);
const livekitShort = 4; const o2 = { livekitShort }; out.push(o2.livekitShort);
class LkCls { constructor() { this.name = "LiveKitError"; } livekitMethod() { return "m"; } get decartGetter() { return "g"; } static livekitStatic = 11; decartField = 12; }
const c = new LkCls();
out.push(c.name, c.livekitMethod(), c.decartGetter, LkCls.livekitStatic, c.decartField);
const obj = { livekitM() { return "om"; }, get decartG() { return "og"; }, async livekitA() { return 1; }, *livekitGen() { yield 2; } };
out.push(obj.livekitM(), obj.decartG, typeof obj.livekitA, [...obj.livekitGen()][0]);
function sw(t) { switch (t) { case "livekit_room_info": return "room"; case "error": return "err"; default: return "other"; } }
out.push(sw("livekit_room_info"), sw("error"), sw("x"));
out.push(Object.keys(msg).join(","), JSON.stringify({ livekitKey: 1 }));
out.push(\`\${"livekit"}-\${"x"}\`, ("mediapipe.tasks.vision.Graph").split(".")[0]);
out.push(new Date(0).toISOString().length, \`\${{ toString() { return "TS"; }, valueOf() { return 1; } }}\`);
out;`;
const run = (src) => JSON.stringify(new Function(`return (() => { ${src.replace(/^"use strict";/, "")} })()`.replace("out;`", "return out;"))());
const runProgram = (src) => {
  const body = src.replace('"use strict";', "").replace(/\nout;$/, "\nreturn out;");
  return JSON.stringify(new Function(body)());
};
const original = runProgram(PROGRAM);
/* The real pipeline: esbuild minifies (local bindings renamed), then the cloak runs. */
const { transform } = await import("esbuild");
const MIN = (await transform("(() => {" + PROGRAM.replace(/\nout;$/, "\nglobalThis.__out = out;") + "})();", { minify: true, loader: "js" })).code;
const c1 = cloak(MIN, { sourceType: "script", rename: { livekit_join: "j1" } });
let cloaked = null, err = null;
try { new Function(c1.code)(); cloaked = JSON.stringify(globalThis.__out); } catch (e) { err = e; }
check("§1.1 every rewritten position yields the identical result", cloaked !== null &&
  cloaked === original.replace('"livekit_join"', '"j1"'), err ? err.stack : `\n  orig ${original}\n  clk  ${cloaked}`);
check("§1.2 the directive stays a directive", c1.code.includes('"use strict"'));
check("§1.3 nothing in the minified program was left unhandled", c1.unhandled.length === 0, JSON.stringify(c1.unhandled));
const kw = cloak('function f(t){switch(t){case"livekit_x":return"decart";default:return typeof"lucy-a"}}globalThis.__kw=[f("livekit_x"),f(1)];', { sourceType: "script" });
let kwOut = null; try { new Function(kw.code)(); kwOut = JSON.stringify(globalThis.__kw); } catch (e) { kwOut = String(e); }
check("§1.4 a literal glued to a keyword (case\"x\", return\"x\", typeof\"x\") keeps its space", kwOut === '["decart","string"]', kwOut);

console.log("\n── §2 nothing readable ──");
check("§2.1 no vendor word left in the cloaked text", vendorHits(c1.code).length === 0, vendorHits(c1.code).join(" | "));
check("§2.2 a renamed protocol word travels as its alias", c1.code.includes('"j1"') && c1.renamed > 0);
check("§2.3 ...and encoded words are counted", c1.encoded > 20, c1.encoded);
const twice = cloak(PROGRAM, { sourceType: "script" });
check("§2.4 a fresh key per build: two cloaks of one program differ", twice.code !== cloak(PROGRAM, { sourceType: "script" }).code);

console.log("\n── §3 what it refuses ──");
const free = cloak("const a = LiveKitGlobal.x; let b = 1;", { sourceType: "script" });
check("§3.1 a free identifier naming a vendor is reported", free.unhandled.some((u) => /LiveKitGlobal/.test(u)), JSON.stringify(free.unhandled));
const tagged = cloak("const s = String.raw`decart${1}`;", { sourceType: "script" });
check("§3.2 a tagged template naming a vendor is reported", tagged.unhandled.length === 1, JSON.stringify(tagged.unhandled));
check("§3.3 the word list names every engine and library we run",
  ["decart", "LiveKit", "lucy-vton", "MediaPipe", "gemini", "pose_landmarker", "tasks-vision", "blaze_face", "tflite"].every((w) => VENDOR_WORDS.test(w)) &&
  !VENDOR_WORDS.test("blazer") && !VENDOR_WORDS.test("lucky"));

console.log("\n── §4 the real render SDK bundle ──");
{
  const r = await build({
    stdin: { contents: 'import { LoggerNames, getLogger } from "livekit-client";\nfor (const n of Object.values(LoggerNames)) getLogger(n).setLevel("silent", false);\nexport { createDecartClient as createClient } from "@decartai/sdk";', resolveDir: ROOT, loader: "js" },
    bundle: true, format: "esm", platform: "browser", minify: true, legalComments: "none", charset: "utf8", write: false, logLevel: "silent",
  });
  const sdk = r.outputFiles[0].text;
  const t0 = Date.now();
  const c = cloak(sdk);
  check("§4.1 the SDK bundle cloaks with nothing unhandled", c.unhandled.length === 0, c.unhandled.slice(0, 5).join(" | "));
  check("§4.2 ...and nothing readable left", vendorHits(c.code).length === 0, vendorHits(c.code).slice(0, 5).join(" | "));
  let mod = null, e2 = null;
  try { mod = await import("data:text/javascript;base64," + Buffer.from(c.code).toString("base64")); } catch (e) { e2 = e; }
  check("§4.3 ...it still evaluates and exports the factory", mod && typeof mod.createClient === "function", e2 && e2.stack);
  console.log(`        ${c.encoded} encoded, ${(sdk.length / 1024).toFixed(0)} KB -> ${(c.code.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
}

console.log(`\n${fails ? `✗ ${fails} failed` : "✓ all passed"}`);
process.exit(fails ? 1 : 0);
