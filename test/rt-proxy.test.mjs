/* THE RENDER ENGINE BEHIND OUR EDGE - lib/rt-proxy.js (2026-10-03)
   ─────────────────────────────────────────────────────────────────────────────
   The room speaks a neutral dialect to our edge; the edge translates to the engine. Proven end to end
   with the real minified room, the real SDK (cloaked), a REAL LiveKit server and a stand-in signalling
   server through `wrangler dev` (CLAUDE.md §2.24). What this suite pins, on the pure translation:
   §1 THE SEAL: round-trips any key, is opaque (no readable fragment), refuses tampering and junk.
   §2 THE DIALECT: the room's aliases are exactly what scripts/build.mjs renames in the SDK, and every alias
      maps to the engine's word and back.
   §3 SIGNALLING: the room's URL becomes the engine's - real key, model, codec key, user agent - and a bad
      ticket or path opens nothing; frames translate both ways; the media URL and token come back sealed
      behind the edge; prose is scrubbed; an image frame is passed untouched.
   §4 MEDIA: /k/<sealed>/… opens back to the real host, path and token; a trailing slash does not double.
   §5 TELEMETRY: the sealed key opens in X-API-KEY, the model and user agent map back; no key, no forward.
   §6 WIRING: the Worker routes /v/s, /k/, /m and /a/ through rt.js behind the Origin gate; the token route
      answers a sealed ticket and names no engine; the room builds its client against the edge.
   ============================================================================= */
import { readFileSync } from "node:fs";
import * as P from "../lib/rt-proxy.js";
import { VENDOR_WORDS } from "../scripts/cloak.mjs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 500)}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

console.log("\n── §1 the seal ──");
{
  const keys = ["ek_live_a1B2c3D4e5F6g7H8", "x", "שלום-מפתח", "a".repeat(2000), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig"];
  check("§1.1 round-trips every key", keys.every((k) => P.openTicket(P.sealTicket(k)) === k));
  const t = P.sealTicket("ek_live_a1B2c3D4e5F6g7H8");
  check("§1.2 opaque: URL-safe, and no fragment of the key or its prefix readable", /^p[A-Za-z0-9_-]+$/.test(t) && !/ek_|live|a1B2/.test(t), t);
  const flipped = t.slice(0, 5) + (t[5] === "A" ? "B" : "A") + t.slice(6);
  check("§1.3 a tampered ticket opens nothing", P.openTicket(flipped) === null);
  check("§1.4 junk opens nothing", [null, "", "p", "x" + t.slice(1), "p!!!", 42].every((j) => P.openTicket(j) === null));
}

console.log("\n── §2 the dialect ──");
{
  const build = read("../scripts/build.mjs");
  check("§2.1 the build renames the SDK's protocol words from RT_WORDS itself (one table, no drift)",
    /const RT_RENAME = Object\.fromEntries\(Object\.entries\(RT_WORDS\)/.test(build) && /cloak\(sdkText, \{ rename: RT_RENAME/.test(build));
  check("§2.2 every room alias is neutral and every engine word is the engine's",
    Object.keys(P.RT_WORDS).every((a) => !VENDOR_WORDS.test(a) && /^[a-z][a-z0-9]{0,3}$/.test(a)) &&
    Object.values(P.RT_WORDS).every((w) => /livekit/.test(w)));
  check("§2.3 the room's model and user agent are neutral", !VENDOR_WORDS.test(JSON.stringify(P.RT_ROOM_MODEL)) && !VENDOR_WORDS.test(P.RT_UA.room));
}

console.log("\n── §3 signalling ──");
const cfg = { signalUrl: "https://engine.example/v1/stream", model: "real-model-3.5" };
{
  const t = P.sealTicket("ek_real");
  const room = new URL(`wss://edge.example/v/s?c1=vp8&api_key=${t}&model=v&user_agent=${encodeURIComponent("rt-js/0.1.5 lang/js")}`);
  const up = new URL(P.engineSignalUrl(room, cfg));
  check("§3.1 the engine gets its own URL, key, model, codec key and user agent",
    up.origin + up.pathname === "https://engine.example/v1/stream" && up.searchParams.get("api_key") === "ek_real" &&
    up.searchParams.get("model") === "real-model-3.5" && up.searchParams.get("livekit_server_codec") === "vp8" &&
    up.searchParams.get("user_agent") === "decart-js-sdk/0.1.5 lang/js" && !up.searchParams.has("c1"), up.toString());
  check("§3.2 a bad ticket, a missing one, or another path opens nothing",
    P.engineSignalUrl(new URL("wss://edge.example/v/s?api_key=nope&model=v"), cfg) === null &&
    P.engineSignalUrl(new URL("wss://edge.example/v/s?model=v"), cfg) === null &&
    P.engineSignalUrl(new URL(`wss://edge.example/v/x?api_key=${t}`), cfg) === null);
  check("§3.3 the room's join goes out as the engine's word", JSON.parse(P.frameToEngine('{"type":"j1"}')).type === "livekit_join");
  const img = JSON.stringify({ type: "set_image", image_data: "A".repeat(150000), prompt: "x" });
  check("§3.4 an image frame passes untouched (no parse on the hot path)", P.frameToEngine(img) === img);
  const info = P.frameToRoom(JSON.stringify({ type: "livekit_room_info", livekit_url: "wss://media.example/", token: "jwt.tok.en", room_name: "r", session_id: "s1" }), { edgeWs: "wss://edge.example" });
  const ri = JSON.parse(info);
  check("§3.5 the room info comes back in the room's words, the media URL behind our edge, the token sealed",
    ri.type === "r1" && /^wss:\/\/edge\.example\/k\/p[A-Za-z0-9_-]+$/.test(ri.u1) && P.openTicket(ri.u1.split("/k/")[1]) === "wss://media.example/" &&
    P.openTicket(ri.token) === "jwt.tok.en" && ri.session_id === "s1" && !("livekit_url" in ri), info);
  check("§3.6 nothing the room receives names the engine", !VENDOR_WORDS.test(info) && !/media\.example|jwt/.test(info));
  const err = JSON.parse(P.frameToRoom('{"type":"error","error":"Decart: LiveKit room lucy-vton-3 not allowed"}', { edgeWs: "wss://e" }));
  check("§3.7 engine prose is scrubbed, its meaning kept", !VENDOR_WORDS.test(err.error) && /not allowed/.test(err.error), err.error);
  const ack = '{"type":"set_image_ack","success":true}';
  check("§3.8 every other message passes as it came", P.frameToRoom(ack, { edgeWs: "wss://e" }) === ack);
}

console.log("\n── §4 media ──");
{
  const host = P.sealTicket("wss://media.example/"), tok = P.sealTicket("jwt.tok.en");
  const u = P.engineMediaUrl(new URL(`wss://edge.example/k/${host}/rtc/v1?access_token=${tok}&join_request=abc`));
  check("§4.1 the media socket opens back to the real host and path, token unsealed, other params kept",
    u === "https://media.example/rtc/v1?access_token=jwt.tok.en&join_request=abc", u);
  check("§4.2 the HTTP check path too", P.engineMediaUrl(new URL(`https://edge.example/k/${host}/rtc/v1/validate?access_token=${tok}`)) ===
    "https://media.example/rtc/v1/validate?access_token=jwt.tok.en");
  check("§4.3 a sealed non-URL or junk opens nothing",
    P.engineMediaUrl(new URL(`wss://edge.example/k/${P.sealTicket("javascript:alert(1)")}/rtc`)) === null &&
    P.engineMediaUrl(new URL("wss://edge.example/k/zzz/rtc")) === null);
  check("§4.4 a sealed bearer opens; anything else passes as sent", P.openBearer(`Bearer ${tok}`) === "Bearer jwt.tok.en" && P.openBearer("Bearer abc") === "Bearer abc");
}

console.log("\n── §5 telemetry ──");
{
  const h = new Headers({ "X-API-KEY": P.sealTicket("ek_real"), "User-Agent": "rt-js/0.1.5 lang/js", "Content-Type": "application/json" });
  const f = P.telemetryToEngine(h, JSON.stringify({ model: "v", tags: { model: "v" }, stats: [1] }), cfg);
  check("§5.1 the key opens, the model and user agent map back", f && f.headers["x-api-key"] === "ek_real" &&
    /decart-js-sdk\/0\.1\.5/.test(f.headers["user-agent"]) && JSON.parse(f.body).model === "real-model-3.5" && JSON.parse(f.body).tags.model === "real-model-3.5",
    JSON.stringify(f));
  check("§5.2 no key that opens, no forward", P.telemetryToEngine(new Headers({ "X-API-KEY": "nope" }), "{}", cfg) === null);
}

console.log("\n── §6 wiring ──");
{
  const worker = read("../cloudflare/orient/src/worker.js"), rt = read("../cloudflare/orient/src/rt.js");
  const server = read("../server.js"), app = read("../fitting-room/app.js"), wr = read("../cloudflare/orient/wrangler.jsonc");
  check("§6.1 the Worker hands /v/s, /k/, /m and /a/ to rt.js, with the Origin verdict",
    /const rt = handleRt\(request, env, url, originAllowed\(request\.headers\.get\("Origin"\), env\.ALLOWED_ORIGINS\)\);/.test(worker) &&
    /p === "\/v\/s" \|\| p\.startsWith\("\/k\/"\) \|\| p === "\/m" \|\| p\.startsWith\("\/a\/"\)/.test(rt) &&
    /if \(!originOk\) return Promise\.resolve\(new Response\("forbidden", \{ status: 403 \}\)\);/.test(rt));
  check("§6.2 the engine's hosts and model are Worker config, not code", /"RT_SIGNAL_URL":/.test(wr) && /"RT_MODEL":/.test(wr) &&
    !/decart\.ai|lucy-/.test(rt + read("../lib/rt-proxy.js").replace(/RT_UA = Object\.freeze\(\{ room: "rt-js", engine: "decart-js-sdk" \}\)/, "")));
  check("§6.3 the token route answers a sealed ticket and names no engine",
    /return res\.json\(\{ t: sealTicket\(token\.apiKey\), exp: token\.expiresAt \?\? null \}\);/.test(server) &&
    !/error:\s*"decart_|message:\s*"[^"]*Decart/.test(server.slice(server.indexOf("async function mintToken"), server.indexOf("/* ── Routes"))));
  check("§6.4 the room builds its render client against the edge, with the neutral model",
    /realtimeBaseUrl: typeof rtEdgeUrl === "function" \? rtEdgeUrl\(\) : undefined/.test(app) && /name: "v",\s*\n\s*urlPath: "\/s",/.test(app));
  check("§6.5 a refused upstream is closed with its reason, so the SDK stops retrying a permanent failure",
    /return refused\(up\.status === 401 \|\| up\.status === 403 \? 4000 \+ up\.status : 1011/.test(rt));
}

console.log(`\n${fails ? `✗ ${fails} failed` : "✓ all passed"}`);
process.exit(fails ? 1 : 0);
