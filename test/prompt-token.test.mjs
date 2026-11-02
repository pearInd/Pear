/* THE PROMPT THE PAGE NEVER HOLDS (2026-11-02 - lib/prompt-token.js, lib/rt-proxy.js makePromptRelay, CLAUDE.md §7.21).
   /prompt answers a token; the edge's relay turns it into the words on the way to the engine and back on the way to the room.
   §1 the engine receives the same bytes as before over a grid of requests, in every frame shape the SDK writes;
   §2 no word reaches the page: the token, its decoded body, the acks, an error quoting the prompt;
   §3 the SDK's ack matching holds; §4 the room's "prompt unchanged" checks answer as on the words;
   §5 a token we did not issue never reaches the engine, and a plain prompt from an older room still passes;
   §6 the owner's decision: a shed part is recorded, by name only; §7 every route answers the token. */
import { readFileSync } from "node:fs";
import * as P from "../lib/prompts.js";
import { promptTokenForRequest, expandPromptToken } from "../lib/prompt-token.js";
import { makePromptRelay, frameToEngine, frameToRoom } from "../lib/rt-proxy.js";
import { shedRecorder } from "../cloudflare/orient/src/rt.js";
const read = (u) => readFileSync(new URL(u, import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`);
}
const ITEMS = [
  { title: "basic cotton t-shirt", category: "top", garmentType: "upper_body", __bottoms: false },
  { title: "PEAK", name: "חולצה עם הדפס", colorHex: "#4b3a36", textOcr: "PEAK", __bottoms: false, backIsPlain: false },
  { title: "button down oxford shirt", colorHex: "#111111", textOcr: "BE \"YOUR\" OWN \\ Healer", __bottoms: false },
  { title: "zip up jacket", fabric: "denim", __bottoms: false, _backLooksPrinted: true, backIsPlain: true },
  { title: "CHICAGO shorts", category: "bottom", garmentType: "lower_body", __bottoms: true, colorHex: "#000000", textOcr: "CHICAGO", backIsPlain: true },
  { title: "חצאית מקסי", __bottoms: true }, {},
];
const REQS = [];
for (const item of ITEMS) for (const angle of ["front", "back"]) for (const inProfile of [false, true]) for (const delta of [-2, -1, 0, 1, 2]) for (const test of [false, true]) {
  REQS.push(P.sanitizePromptRequest({ kind: "single", item, angle, inProfile, delta, ...(test ? { test } : {}) }));
}
REQS.push(P.sanitizePromptRequest({ kind: "look", item: {}, angle: "front", inProfile: false, delta: 0 }));
const relay = (onExpanded) => makePromptRelay(expandPromptToken, onExpanded);
const FRAMES = {
  prompt: (t) => JSON.stringify({ type: "prompt", prompt: t, enhance_prompt: false }),
  image: (t) => JSON.stringify({ type: "set_image", image_data: "QUJD".repeat(5000), prompt: t, enhance_prompt: false }),
  ref: (t) => JSON.stringify({ type: "set_image", image_ref: "file_abc", prompt: t, enhance_prompt: false }),
};
const PHRASES = ["Drape and fit", "REAR/BACK", "Strictly preserve", "Fit:", "smooth unbroken", "true-to-size", "Fabric:", "Fit and replace BOTH"];

console.log("\n── §1 the engine receives the same bytes ──");
{
  let wrong = 0, frames = 0, first = "";
  for (const req of REQS) for (const [name, make] of Object.entries(FRAMES)) {
    const words = P.promptForRequest(req);
    const m = JSON.parse(frameToEngine(make(promptTokenForRequest(req)), relay()));
    frames++;
    if (m.prompt !== words || m.enhance_prompt !== false || m.type !== JSON.parse(make("x")).type || (name === "image" && m.image_data !== "QUJD".repeat(5000))) { wrong++; first = first || `${name}: ${m.prompt}`; }
  }
  check(`§1.1 ${REQS.length} requests x 3 frame shapes (${frames} frames): every prompt the engine gets equals the old engine's, the rest of the frame untouched`, wrong === 0, first);
  const req = REQS[3];
  const a = frameToEngine(FRAMES.prompt(promptTokenForRequest(req)), relay());
  check("§1.2 ...byte for byte as the SDK would have written the words", a === FRAMES.prompt(P.promptForRequest(req)), a);
  const hard = P.sanitizePromptRequest({ kind: "single", item: ITEMS[2], angle: "front", delta: 0 });
  check("§1.3 words needing JSON escapes survive (a print with quotes and a backslash)", JSON.parse(frameToEngine(FRAMES.prompt(promptTokenForRequest(hard)), relay())).prompt === P.promptForRequest(hard));
}

console.log("\n── §2 no word reaches the page ──");
{
  const leaks = [];
  for (const req of REQS) {
    const t = promptTokenForRequest(req);
    const decoded = Buffer.from(t.split(".")[2], "base64url").toString("utf8");
    for (const ph of PHRASES) if (t.includes(ph) || decoded.includes(ph)) leaks.push(ph);
  }
  check("§2.1 neither a token nor its decoded body carries prompt wording", leaks.length === 0, leaks.join(","));
  const req = REQS[0], token = promptTokenForRequest(req), words = P.promptForRequest(req), r = relay();
  frameToEngine(FRAMES.prompt(token), r);
  const ack = JSON.parse(frameToRoom(JSON.stringify({ type: "prompt_ack", prompt: words, success: true }), { edgeWs: "wss://e", prompts: r }));
  check("§2.2 the engine's prompt_ack reaches the room with the token, not the words", ack.prompt === token && ack.success === true, JSON.stringify(ack));
  const err = frameToRoom(JSON.stringify({ type: "error", error: `rejected: ${words}` }), { edgeWs: "wss://e", prompts: r });
  check("§2.3 an engine error quoting the prompt has it taken out", !err.includes("Drape") && err.includes("[prompt]"), err);
  const raw = frameToRoom(`not json ${words}`, { edgeWs: "wss://e", prompts: r });
  check("§2.4 ...also in a frame that is not JSON", !raw.includes("Drape"), raw);
  const r2 = relay(); frameToEngine(FRAMES.image(token), r2);
  const imgAck = JSON.parse(frameToRoom(JSON.stringify({ type: "set_image_ack", success: true, prompt: words }), { edgeWs: "wss://e", prompts: r2 }));
  check("§2.5 a set_image_ack echoing the prompt carries the token too", imgAck.prompt === token && imgAck.success === true, JSON.stringify(imgAck));
  const r3 = relay(); frameToEngine(FRAMES.prompt(token), r3);
  const other = JSON.parse(frameToRoom(JSON.stringify({ type: "prompt_ack", prompt: "the engine rewrote it", success: true }), { edgeWs: "wss://e", prompts: r3 }));
  check("§2.6 an ack whose text the relay does not know still leaves no words: the oldest pending token answers it", other.prompt === token, JSON.stringify(other));
}

console.log("\n── §3 the SDK's ack matching ──");
{
  const sdk = readFileSync(new URL("../node_modules/@decartai/sdk/dist/realtime/signaling-channel.js", import.meta.url), "utf8");
  check("§3.1 the bundled SDK still writes the shapes this relay reads (a change here must fail)",
    /type: "prompt",\s*prompt: text,/.test(sdk) && /msg\.type === "prompt_ack" && msg\.prompt === text/.test(sdk) && /message\.prompt = opts\.prompt/.test(sdk));
  const a = P.sanitizePromptRequest({ kind: "single", item: ITEMS[0], angle: "front", inProfile: false, delta: 0 });
  const b = P.sanitizePromptRequest({ kind: "single", item: ITEMS[0], angle: "front", inProfile: true, delta: 0 });
  const ta = promptTokenForRequest(a), tb = promptTokenForRequest(b), words = P.promptForRequest(a), r = relay();
  check("§3.2 (two requests, one wording - the case below)", ta !== tb && words === P.promptForRequest(b));
  frameToEngine(FRAMES.prompt(ta), r); frameToEngine(FRAMES.prompt(tb), r);
  const ackOf = () => JSON.parse(frameToRoom(JSON.stringify({ type: "prompt_ack", prompt: words, success: true }), { edgeWs: "wss://e", prompts: r })).prompt;
  check("§3.3 two writes in flight with the same words are acknowledged in order, each with its own token", ackOf() === ta && ackOf() === tb);
  const plain = frameToRoom(JSON.stringify({ type: "prompt_ack", prompt: "plain", success: true }), { edgeWs: "wss://e", prompts: relay() });
  check("§3.4 a socket that never expanded anything passes acks as they came (a room opened before the deploy)", JSON.parse(plain).prompt === "plain");
}

console.log("\n── §4 the room's comparisons answer as on the words ──");
{
  const APP = read("../fitting-room/app.js");
  const i = APP.indexOf("const _promptTokenByHash = new Map();"), j = APP.indexOf("function requestWirePrompt(req, where) {");
  const same = new Function(APP.slice(i, j) + "\nreturn samePromptToken;")();
  const map = new Map();
  let differs = 0;
  for (const req of REQS) {
    const words = P.promptForRequest(req), t = same(promptTokenForRequest(req));
    if (map.has(words) && map.get(words) !== t) differs++;
    map.set(words, t);
  }
  const tokens = new Set(map.values());
  check(`§4.1 ${REQS.length} requests -> ${map.size} wordings -> ${tokens.size} tokens: same words, same token; different words, different token`, differs === 0 && tokens.size === map.size);
  check("§4.2 anything else the server answers passes untouched", same("plain words") === "plain words");
  check("§4.3 what the memo stores is the canonical token", /const text = samePromptToken\(answer\); _wirePrompts\.set\(key, text\); return text;/.test(APP));
}

console.log("\n── §5 what the relay refuses, what it lets through ──");
{
  const engineGot = (t) => frameToEngine(FRAMES.prompt(t), relay());
  const bad = ["pt1.", "pt1.aa.", "pt1.aa.%%%", "pt1.aa.bm90IGpzb24", "pt1.aa.b.c", "pt1." + "a".repeat(20000)];
  check("§5.1 a token we cannot read is dropped, never forwarded", bad.every((t) => engineGot(t) === null), bad.map(engineGot).join("|"));
  check("§5.2 a plain prompt passes as it came", JSON.parse(engineGot("plain words")).prompt === "plain words");
  check("§5.3 frames with no prompt pass untouched", frameToEngine('{"type":"j1"}', relay()) === '{"type":"livekit_join"}' && frameToEngine('{"type":"set_image","image_data":"x"}', relay()) === '{"type":"set_image","image_data":"x"}');
  const forged = expandPromptToken("pt1.00." + Buffer.from(JSON.stringify({ kind: "single", angle: "front", delta: 999, item: { title: "x".repeat(9000), evil: "y" } })).toString("base64url"));
  check("§5.4 a forged body goes through the /prompt sanitiser: only the engine's own wording comes out, the size clamped", forged && forged.delta === 12 && forged.prompt.length <= 650 && !forged.prompt.includes("evil"), JSON.stringify(forged).slice(0, 200));
  const WORKER = read("../cloudflare/orient/src/rt.js");
  check("§5.5 the Worker skips a dropped frame and hands each socket its own relay", /if \(frame !== null\) ws\.send\(frame\);/.test(WORKER) && /const prompts = makePromptRelay\(expandPromptToken, shedRecorder\(env\)\);/.test(WORKER));
}

console.log("\n── §6 a shed part is on the record, by name only ──");
{
  const closure = P.sanitizePromptRequest({ kind: "single", item: ITEMS[2], angle: "front", delta: 0 });
  const kept = P.sanitizePromptRequest({ kind: "single", item: ITEMS[4], angle: "front", delta: 0 });
  check("§6.1 a closure top with facts sheds the size sentence, and says so", expandPromptToken(promptTokenForRequest(closure)).shed.join() === "fit");
  check("§6.2 a prompt that fits sheds nothing", expandPromptToken(promptTokenForRequest(kept)).shed.length === 0);
  const compact = P.sanitizePromptRequest({ kind: "single", item: ITEMS[2], angle: "front", delta: 0, test: true });
  check("§6.3 a TEST request's compact form is told apart", expandPromptToken(promptTokenForRequest(compact)).shed.join() === "fit-compact");
  check("§6.4 recording does not change the words", P.promptWithShedForRequest(closure).prompt === P.promptForRequest(closure));
  const puts = [];
  const env = { TRACES: { put: async (k, v, o) => { puts.push([k, v, o]); } } };
  const r = relay(shedRecorder(env));
  frameToEngine(FRAMES.prompt(promptTokenForRequest(kept)), r);
  check("§6.5 nothing shed, nothing written", puts.length === 0);
  frameToEngine(FRAMES.prompt(promptTokenForRequest(closure)), r);
  frameToEngine(FRAMES.image(promptTokenForRequest(closure)), r);
  check("§6.6 one record per distinct shed per socket, kept 7 days", puts.length === 1 && puts[0][0].startsWith("shed:") && puts[0][2].expirationTtl === 604800, JSON.stringify(puts));
  const rec = JSON.parse(puts[0][1]);
  check("§6.7 names and numbers only: no words, no garment", rec.parts.join() === "fit" && rec.delta === 0 && rec.angle === "front" && !/Drape|oxford|Healer/.test(puts[0][1]), puts[0][1]);
  const r2 = relay(shedRecorder({ TRACES: { put: () => { throw new Error("kv down"); } } }));
  check("§6.8 a failing metric never costs the frame", JSON.parse(frameToEngine(FRAMES.prompt(promptTokenForRequest(closure)), r2)).prompt === P.promptForRequest(closure));
  const many = [];
  const r3 = relay(shedRecorder({ TRACES: { put: async (k) => { many.push(k); } } }));
  for (const delta of [-2, -1, 0, 1, 2]) for (const angle of ["front"]) for (const t of [false, true]) frameToEngine(FRAMES.prompt(promptTokenForRequest(P.sanitizePromptRequest({ kind: "single", item: ITEMS[2], angle, delta, ...(t ? { test: t } : {}) }))), r3);
  check("§6.9 bounded: at most 4 writes per socket", many.length === 4, many.length);
}

console.log("\n── §7 every route answers the token ──");
{
  const SERVER = read("../server.js"), WORKER = read("../cloudflare/orient/src/worker.js"), HARNESS = read("./e2e/static-server.mjs");
  check("§7.1 origin, edge and the visual harness mint tokens", [SERVER, WORKER, HARNESS].every((s) => /prompt(: | = )promptTokenForRequest\(sanitizePromptRequest\(/.test(s)), "");
  check("§7.2 none of them still answers the words", [SERVER, WORKER, HARNESS].every((s) => !/promptForRequest\(/.test(s)));
  check("§7.3 an error answer carries no words", /res\.status\(500\)\.json\(\{ error: "prompt_failed" \}\)/.test(SERVER));
}

console.log(fails === 0 ? "\nprompt-token: OK" : `\nprompt-token: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
