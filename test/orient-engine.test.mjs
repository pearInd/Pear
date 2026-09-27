/* THE ORIENTATION DECISION, SERVER-SIDE - "it moved to Cloudflare; does the shopper's turn
   still do exactly what it did?"
   ─────────────────────────────────────────────────────────────────────────────
   On 2026-09-26 Layer C's DECISION moved out of fitting-room/app.js into
   lib/orient-engine.js (CLAUDE.md §2.14): the browser measures and executes, the engine
   decides, over the orientation link. The move was proven exact at the time by replaying
   4,116 scripted sessions (239,223 events) through the old watcher and through the new
   shell + engine - byte-identical logs, and four mutated thresholds each caught
   (a 1-degree early-turn change moved 185 sessions). This suite keeps that conclusion and
   the seams that make it hold:

     §1  THE BEHAVIOUR IS PINNED. A 504-session slice of that corpus is replayed through the
         REAL watcher from app.js with the REAL engine behind a JSON round trip
         (test/orient-replay.mjs), and hashed. PINNED was computed from the PRE-MOVE app.js
         over this exact slice. Red means some turn now swaps differently; if intended,
         re-pin with --print in the same commit and say which behaviour moved.
     §2  THE COPIES AGREE (CLAUDE.md §3): the values both files still need, and the list of
         URL knobs the browser forwards vs the list the engine reads.
     §3  THE WIRE: the protocol session and the sample sanitiser - shopper-controlled input.
     §4  THE BROWSER NO LONGER DECIDES: the moved logic is absent from app.js's code, and the
         tick is the shell it is meant to be (measure, send, execute; no decision → no swap).
     §5  THE WORKER (cloudflare/orient/) wraps the same protocol session and fails closed: its
         Origin allowlist, the debug token and its config. Its byte-equivalence with the
         in-process engine was checked against `wrangler dev` (33,122 steps, 0 differences).
   ============================================================================= */
import { readFileSync } from "node:fs";
import { runCorpus } from "./orient-replay.mjs";

/* RE-PINNED 2026-09-27 for ONE intended move, in the BROWSER's half: maybeSwap() now waits a bounded
   ORIENT_SWAP_WAIT_MS for an in-flight pose/re-anchor apply to clear instead of dropping the swap the
   engine decided (the early turn fires once per turn - a dropped one left the front on a turned-away
   body). Proven to be the only move: the current app.js with that wait removed reproduces the
   previous pin (4b2ead79…a65a706) exactly. Over the full 4,116-session corpus, 2,737 logs changed:
   the first back view came earlier in 442 sessions, later in 31, appeared in 127 that never had one
   and vanished from 7 (all 7 in noisy-slowapply, each a back that had landed on the FRONT); FRONT on
   a turned-away body fell 47% (pose) / 49% (face), BACK on a facing body 20% / 21%. See
   front-reference-guard §11. */
/* RE-PINNED AGAIN 2026-09-27 for ONE intended move, in the ENGINE: the return from BACK no longer fires on the yaw
   (ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG 50 -> 0) and is confirmed by the first shoulder vote for FRONT with the torso's
   swing corroborated (ORIENT_POSE_RETURN_FRAMES) - two real sessions measured the render applying a new reference to
   the body as it was 0.27-0.43s BEFORE the send, so a FRONT fired ahead of the side view landed on the back (the
   print on the shopper's back, frame by frame). Over the full 4,116-session corpus 775 logs changed and not one
   session's first BACK dispatch moved: the outbound is untouched. The previous pin (10ef2eae…359c49) is this file with
   the old engine. See turn-yaw-window §15 for the measured-timing model and its bars. */
/* RE-PINNED A THIRD TIME 2026-09-27 (sessions 4-5: the BACK print on the chest on the way round to the front): a
   crossing at the side view is SCHEDULED for its reading + the measured render offset (ORIENT_SIDE_DEG; the return
   ORIENT_SIDE_RET_DELAY_MS = 330, the outbound ORIENT_SIDE_OUT_DELAY_MS = 200 when its crossing reading is itself at
   the side) and handed to the browser up to a tick and a half early with the exact `waitMs`; the return fires at the
   side again (ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG 0 -> 70), with a backstop for a side view no reading caught. Over the
   4,116-session corpus 690 logs changed: the returns, and 13 first BACK dispatches that moved ~120ms later because
   their crossing reading was already at the side. §7 replays the five real sessions. Previous pin: 7610452e…791d92. */
/* ...AND A FOURTH TIME, 2026-09-27 (sessions 6-7): ORIENT_SIDE_SURE_DEG 85 -> 80 (their outbound side readings were
   84 and 80 with the skin vote still "front", so the outbound fired 0.3s early and put the back label on the front
   edge) and ORIENT_SIDE_OUT_DELAY_MS 200 -> 280 (the outbound offset angle-matched at -0.28/-0.27/-0.26s in sessions
   4/6/7). 32 of 4,116 replays changed, 12 of them a first BACK dispatch. Previous pin: 661afc9d…a4227d. */
const PINNED = "7338fe2449cf81a43e39cc362c4eb507fd758d3f50d7e3470bec4a4052224a42";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ENGINE_SRC = readFileSync(new URL("../lib/orient-engine.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const E = await import("../lib/orient-engine.js");
const P = await import("../lib/orient-protocol.js");

/* ── §1 the behaviour, pinned to the pre-move watcher ──────────────────────────── */
console.log("── §1 every scripted turn behaves as it did before the move ──");
{
  const PIN_ENVS = new Set(["pose", "face", "noisy-slowapply", "broken-back"]);
  const PIN_KNOBS = new Set(["", "?early_turn=0", "?pose_pass=0", "?post_peak=0", "?predict_back=1", "?early_turn=30"]);
  const quiet = [console.log, console.warn, console.error];
  let r;
  console.log = console.warn = console.error = () => {};
  try {
    r = await runCorpus(APP, { seeds: [1], engine: E,
      filter: (s) => PIN_ENVS.has(s.key.split("|")[1]) && PIN_KNOBS.has(s.search) });
  } finally { [console.log, console.warn, console.error] = quiet; }
  if (process.argv.includes("--print")) { console.log(r.hash); process.exit(0); }
  check(`${r.scenarios} replayed sessions (${r.events} events) match the pre-move watcher (+ the 2026-09-27 swap wait)`, r.hash === PINNED,
    `expected ${PINNED}\n        got      ${r.hash}`);
  check("...and the replay is not vacuous (it swaps, holds and re-anchors)",
    r.events > 20000 && [...r.perScenario.values()].some((v) => /apply \{"o":"back"/.test(v)) &&
    [...r.perScenario.values()].some((v) => /holdBegin "swap"/.test(v)));
}

/* ── §2 the copies ─────────────────────────────────────────────────────────────── */
console.log("\n── §2 the values both files need agree, and so do the knob lists ──");
{
  const I = E.createOrientEngine({}).internals;
  const appNum = (name) => { const m = new RegExp(`^const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, "m").exec(APP); return m ? Number(m[1]) : NaN; };
  for (const [name, engineValue] of [["ORIENT_YAW_FRESH_MS", I.ORIENT_YAW_FRESH_MS],
    ["PRESENCE_PROMPT_YAW_SUPPRESS_DEG", I.PRESENCE_PROMPT_YAW_SUPPRESS_DEG],
    ["ORIENT_EARLY_TURN_DEFAULT_SPEED", I.ORIENT_EARLY_TURN_DEFAULT_SPEED]]) {
    check(`${name} is the same number in app.js and the engine`, appNum(name) === engineValue, `${appNum(name)} vs ${engineValue}`);
  }
  /* The turn-start gate the pose loop uses follows ?early_turn_speed exactly as the engine's does. */
  const appSpeed = (search) => new Function("location", "ORIENT_EARLY_TURN_DEFAULT_SPEED",
    APP.slice(APP.indexOf("const ORIENT_EARLY_TURN_MIN_SPEED = (() => {"), APP.indexOf("})();", APP.indexOf("const ORIENT_EARLY_TURN_MIN_SPEED = (() => {")) + 5)
      .replace("const ORIENT_EARLY_TURN_MIN_SPEED = ", "return "))({ search }, 45);
  check("...and ?early_turn_speed parses identically on both sides",
    ["", "?early_turn_speed=0", "?early_turn_speed=90", "?early_turn_speed=abc", "?early_turn_speed=5000"].every((q) =>
      appSpeed(q) === E.createOrientEngine(Object.fromEntries(new URLSearchParams(q))).internals.ORIENT_EARLY_TURN_MIN_SPEED));
  const appKeys = new Function(APP.slice(APP.indexOf("const ORIENT_KNOB_KEYS = ["), APP.indexOf(";\n", APP.indexOf("const ORIENT_KNOB_KEYS = ["))) + ";\nreturn ORIENT_KNOB_KEYS;")();
  check("the browser forwards exactly the knobs the engine reads",
    JSON.stringify([...appKeys].sort()) === JSON.stringify([...E.ORIENT_KNOB_KEYS].sort()), `${appKeys} vs ${E.ORIENT_KNOB_KEYS}`);
  const read = new Set([...ENGINE_SRC.matchAll(/\.get\("([a-z_]+)"\)/g)].map((m) => m[1]));
  check("...and every knob the engine's parsers read is on that list",
    [...read].every((k) => E.ORIENT_KNOB_KEYS.includes(k)), [...read].join(","));
}

/* ── §3 the wire ───────────────────────────────────────────────────────────────── */
console.log("\n── §3 the protocol and the sanitiser ──");
{
  const s = P.createOrientSession();
  check("a step on a channel nobody opened answers with no actions (never a default engine)",
    s.handle(JSON.stringify({ c: 1, k: "step", q: 1, s: { t: 1 } })) === JSON.stringify({ c: 1, q: 1, a: [] }));
  s.handle(JSON.stringify({ c: 2, k: "open", knobs: { early_turn: "0", garment_url: "https://evil" } }));
  const r = JSON.parse(s.handle(JSON.stringify({ c: 2, k: "step", q: 7, s: { t: 1000, vote: "front", lock: null, dualView: true } })));
  check("an opened channel steps and answers with its sequence number",
    r.c === 2 && r.q === 7 && Array.isArray(r.a) && r.a.some((a) => a.do === "turnMark"), JSON.stringify(r));
  check("malformed, oversized and unknown messages are dropped without throwing",
    s.handle("not json") === null && s.handle("x".repeat(20000)) === null &&
    s.handle(JSON.stringify({ c: -1, k: "open" })) === null && s.handle(JSON.stringify({ c: 3, k: "boom" })) === null);
  /* 2026-09-27: the room's keepalive - answered for the connection, no channel, no engine. */
  check("a ping is answered with its own number and needs no channel",
    s.handle(JSON.stringify({ k: "ping", q: 42 })) === JSON.stringify({ k: "pong", q: 42 }) &&
    s.handle(JSON.stringify({ k: "ping", q: "x" })) === JSON.stringify({ k: "pong", q: 0 }) &&
    s.handle(JSON.stringify({ k: "ping", q: 1e12 })) === JSON.stringify({ k: "pong", q: 0 }) && s.channelCount === 1);
  s.handle(JSON.stringify({ c: 2, k: "close" }));
  check("close frees the channel", s.channelCount === 0);
  for (let c = 1; c <= 40; c++) s.handle(JSON.stringify({ c, k: "open", knobs: {} }));
  check("channels per connection are bounded", s.channelCount <= 16, String(s.channelCount));

  const junk = E.sanitizeOrientSample({ t: "soon", vote: "sideways", faceSeen: 1, yawAbs: NaN, lock: "left", dualView: "yes",
    dbg: { state: "x" }, extra: 1 });
  check("every sample field is coerced to what the tick reads, with 'no evidence' for the rest",
    junk.t === 0 && junk.vote === null && junk.faceSeen === false && junk.yawAbs === null && junk.lock === null &&
    junk.dualView === false && !("dbg" in junk) && !("extra" in junk), JSON.stringify(junk));
  check("knobs are reduced to the engine's own list - nothing else from the page URL survives",
    JSON.stringify(E.sanitizeOrientKnobs({ early_turn: "30", pear_key: "k", garment_url: "u", post_peak: 5 })) === JSON.stringify({ early_turn: "30" }));

  /* THE TUNING LINE PRINTS EVERY THRESHOLD, so it is the server's to allow. */
  const quiet = E.createOrientEngine({}, { debug: false });
  const loud = E.createOrientEngine({}, { debug: true });
  const smp = { t: 1000, vote: "back", lock: "front", dualView: true, yawAbs: 70, yawAt: 990 };
  check("no debug line unless the server allowed debugging for this channel",
    !quiet.step(E.sanitizeOrientSample(smp)).some((a) => a.do === "log") &&
    loud.step(E.sanitizeOrientSample(smp, { debug: true })).some((a) => a.do === "log"));
  const gated = P.createOrientSession({ allowDebug: (k) => k === "the-support-token-x" });
  gated.handle(JSON.stringify({ c: 1, k: "open", knobs: {}, dk: "guess" }));
  const noLog = JSON.parse(gated.handle(JSON.stringify({ c: 1, k: "step", q: 1, s: smp })));
  check("...and ?orient_debug=1 without the support token prints nothing", !noLog.a.some((a) => a.do === "log"));
}

/* ── §4 the browser no longer decides ─────────────────────────────────────────── */
console.log("\n── §4 the decision is absent from the browser, and the tick is a shell ──");
{
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const fn of ["makeTurnYawWindow", "orientFlipDecision", "orientPredictBack", "orientPredictBackReason", "makeEarlyTurnTrigger", "profileNext"]) {
    check(`app.js code no longer carries ${fn}()`, !new RegExp(`\\b${fn}\\b`).test(code));
  }
  for (const k of ["ORIENT_LOCK_FRAMES", "ORIENT_LOCK_MS", "ORIENT_ACQUIRE_FRAMES", "ORIENT_CORROBORATED_FRAMES", "ORIENT_FACE_RETURN_FRAMES",
                   "ORIENT_POSE_FLIP_FRAMES", "ORIENT_POSE_RETURN_FRAMES", "ORIENT_POSE_PASS", "ORIENT_POST_PEAK", "ORIENT_EARLY_TURN_DEG", "ORIENT_EARLY_TURN_RETURN_DEG",
                   "ORIENT_EDGE_ON_DEG", "ORIENT_PREDICTIVE_BACK", "ORIENT_YAW_TURN_DEG", "ORIENT_PROFILE_ENTER_SCORE", "ORIENT_PROFILE_EXIT"]) {
    check(`app.js code no longer carries ${k}`, !new RegExp(`\\b${k}\\b`).test(code));
  }
  const tick = APP.slice(APP.indexOf("  const timer = setInterval(async () => {"), APP.indexOf("}, ORIENT_SAMPLE_MS);"));
  check("the tick sends one sample carrying the browser's own clock readings",
    /decide\.step\(\{\s*\n\s*t: Date\.now\(\), vote,/.test(tick) && /yawAbs: _torsoYawAbs, yawAt: _torsoYawAt, lostAt: _poseTorsoLostAt,/.test(tick));
  check("a reply after stop() is dropped", /if \(disposed\) return;/.test(tick));
  check("no decision means no swap - only the pose-independent re-anchor keeps its cadence",
    /if \(!acts\) \{ maybeReanchorPrompt\(\)\.catch\(\(\) => \{\}\); return; \}/.test(tick));
  check("the swap is the only awaited action, as it was", (tick.match(/await /g) || []).length === 3 &&
    /a\.do === "swap"\) await maybeSwap\(/.test(tick), (tick.match(/[^\n]*await [^\n]*/g) || []).join(" | "));
}

/* ── §5 the Worker ────────────────────────────────────────────────────────────── */
console.log("\n── §5 the Cloudflare Worker is a transport around the same session, and fails closed ──");
{
  const WSRC = readFileSync(new URL("../cloudflare/orient/src/worker.js", import.meta.url), "utf8");
  const W = await import("../cloudflare/orient/src/worker.js");
  const wcode = WSRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /* Since 2026-09-27 the Worker also answers POST /size and /prompt (handleApi), which parse a JSON
     body - so JSON.parse is allowed THERE and nowhere else: the orientation messages still go only
     through the shared session's own parser. */
  const apiFn = wcode.slice(wcode.indexOf("export async function handleApi("), wcode.indexOf("\n}\n", wcode.indexOf("export async function handleApi(")));
  check("the Worker runs the shared protocol session - no engine or protocol of its own",
    /from "\.\.\/\.\.\/\.\.\/lib\/orient-protocol\.js"/.test(WSRC) && /createOrientSession\(/.test(wcode) &&
    !/createOrientEngine/.test(wcode) && !/JSON\.parse/.test(wcode.replace(apiFn, "")));
  const LIST = "https://pear.example.com, https://pear-interface-*-team.vercel.app";
  check("an allowed origin passes; `*` stands for one [a-z0-9-] run and nothing more",
    W.originAllowed("https://pear.example.com", LIST) && W.originAllowed("https://pear-interface-git-x-team.vercel.app", LIST) &&
    !W.originAllowed("https://pear-interface-x.evil.com-team.vercel.app", LIST) && !W.originAllowed("https://pear-interface-a.b-team.vercel.app", LIST) &&
    !W.originAllowed("https://pear.example.com.evil.com", LIST) && !W.originAllowed("http://pear.example.com", LIST));
  check("no list, no origin, or an empty list refuses everyone (fail closed)",
    !W.originAllowed("https://pear.example.com", "") && !W.originAllowed("https://pear.example.com", undefined) &&
    !W.originAllowed(null, LIST) && !W.originAllowed("", LIST) && !W.originAllowed("https://x", " , "));
  check("the debug token must be set, >= 16 chars, and equal",
    W.keyMatches("0123456789abcdef", "0123456789abcdef") && !W.keyMatches("short", "short") &&
    !W.keyMatches(undefined, "0123456789abcdef") && !W.keyMatches("0123456789abcdeX", "0123456789abcdef") &&
    !W.keyMatches("0123456789abcdef", undefined));
  const CONF = readFileSync(new URL("../cloudflare/orient/wrangler.jsonc", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("wrangler.jsonc: no workers.dev hostname, no logs, and no committed origin wildcard",
    /"workers_dev":\s*false/.test(CONF) && /"observability":\s*\{\s*"enabled":\s*false/.test(CONF) &&
    !/"ALLOWED_ORIGINS":\s*"[^"]*(^|,)\s*\*/.test(CONF) && !/PEAR_DEBUG_TOKEN"\s*:/.test(CONF));
}

/* ── §6 the Worker's /size and /prompt (2026-09-27) ──────────────────────────────────── */
console.log("\n── §6 the edge answers /size and /prompt with the SAME modules, and only to the room ──");
{
  const W = await import("../cloudflare/orient/src/worker.js");
  const S = await import("../lib/sizing.js");
  const PR = await import("../lib/prompts.js");
  const env = { ALLOWED_ORIGINS: "https://app.pear-ai.io,https://pear-*-pear2.vercel.app" };
  const call = (route, { method = "POST", origin = "https://app.pear-ai.io", body } = {}) =>
    W.handleApi(new Request("https://rt.pear-ai.io" + route, { method, headers: origin ? { Origin: origin, "Content-Type": "application/json" } : {},
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined }), env, route);
  const ev = { height: 178, weight: 74, chest: null, waist: null, legs: null, gender: null, storeChart: null,
    product: { sizes: ["XS", "S", "M", "L", "XL"], title: "חולצה חלקה עם הדפס", bottoms: false } };
  const pr = { kind: "single", item: { name: "חולצה חלקה עם הדפס", type: "shirt", __bottoms: false }, angle: "back", inProfile: true, delta: -1 };
  const r1 = await call("/size", { body: ev });
  check("POST /size answers exactly what the server's computeSizeVerdict answers",
    r1.status === 200 && (await r1.text()) === JSON.stringify(S.computeSizeVerdict(S.sanitizeSizeEvidence(JSON.parse(JSON.stringify(ev))))));
  check("...with CORS for that origin only, never *", r1.headers.get("Access-Control-Allow-Origin") === "https://app.pear-ai.io" &&
    r1.headers.get("Cache-Control") === "no-store");
  const r2 = await call("/prompt", { body: pr });
  check("POST /prompt answers exactly what the server's promptForRequest answers",
    r2.status === 200 && (await r2.text()) === JSON.stringify({ prompt: PR.promptForRequest(PR.sanitizePromptRequest(JSON.parse(JSON.stringify(pr)))) }));
  check("a preview origin is allowed; a foreign one, a look-alike and a missing Origin are refused",
    (await call("/size", { origin: "https://pear-git-x-pear2.vercel.app", body: ev })).status === 200 &&
    (await call("/size", { origin: "https://evil.example", body: ev })).status === 403 &&
    (await call("/size", { origin: "https://app.pear-ai.io.evil.example", body: ev })).status === 403 &&
    (await call("/size", { origin: null, body: ev })).status === 403);
  const pre = await call("/size", { method: "OPTIONS" });
  check("the preflight is answered (204) and cached", pre.status === 204 && pre.headers.get("Access-Control-Max-Age") === "7200");
  check("a GET is refused, bad JSON is a 400, an oversized body a 413",
    (await call("/size", { method: "GET" })).status === 405 &&
    (await call("/size", { body: "{not json" })).status === 400 &&
    (await call("/prompt", { body: "x".repeat(70000) })).status === 413);
  check("no ALLOWED_ORIGINS refuses everyone (fail closed)",
    (await W.handleApi(new Request("https://rt.pear-ai.io/size", { method: "POST", headers: { Origin: "https://app.pear-ai.io" }, body: "{}" }), {}, "/size")).status === 403);

  /* POST /trace - a TEST session's flight record (fitting-room/app.js "FLIGHT RECORDER"). */
  const puts = [];
  const kv = { put: async (k, v, o) => { puts.push({ k, v, o }); } };
  const tcall = (body, { origin = "https://app.pear-ai.io", withKv = true } = {}) =>
    W.handleApi(new Request("https://rt.pear-ai.io/trace", { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" },
      body: typeof body === "string" ? body : JSON.stringify(body) }), withKv ? { ...env, TRACES: kv } : env, "/trace");
  const rec = { v: 1, id: "abc-12/../x", n: 1, ev: [[0, "reveal"], [250, "s", { v: "front" }]] };
  const t1 = await tcall(rec);
  check("a well-formed record is stored under a key the Worker names, for 7 days",
    t1.status === 200 && puts.length === 1 && /^trace:\d{4}-\d\d-\d\dT[^:]+:\d\d:[\d.]+Z:abc-12x$/.test(puts[0].k) &&
    puts[0].o.expirationTtl === 7 * 24 * 3600 && JSON.parse(puts[0].v).ev.length === 2, JSON.stringify(puts[0] && { k: puts[0].k, o: puts[0].o }));
  check("a wrong shape is a 400, an oversized record a 413 - nothing stored",
    (await tcall({ v: 2, id: "x", ev: [] })).status === 400 && (await tcall({ v: 1, ev: [] })).status === 400 &&
    (await tcall({ v: 1, id: "x", ev: "no" })).status === 400 && (await tcall("x".repeat(300000))).status === 413 && puts.length === 1);
  check("a foreign origin is refused, and no TRACES binding stores nothing (404)",
    (await tcall(rec, { origin: "https://evil.example" })).status === 403 && (await tcall(rec, { withKv: false })).status === 404 && puts.length === 1);
}

/* ── §7 five real 360s, replayed (2026-09-27) ───────────────────────────────────────────── */
console.log("\n── §7 on seven real sessions each side goes out at the side view + the measured offset ──");
{
  /* The flight records of five real turns (test/real-turns-2026-09-27.json - numbers only), each tick replayed
     through the engine with the lock following its own swaps. The render paints a swap on the body as it was ~0.3s
     before the send; the return must therefore go out ~0.33s after the camera saw the side view - never before it
     (the FRONT print on the back, session 2) and not ~0.6s after (the BACK print on the chest, sessions 4-5). */
  const data = JSON.parse(readFileSync(new URL("./real-turns-2026-09-27.json", import.meta.url), "utf8"));
  const retDelay = Number((/const ORIENT_SIDE_RET_DELAY_MS = (\d+);/.exec(ENGINE_SRC) || [])[1]);
  const outDelay = Number((/const ORIENT_SIDE_OUT_DELAY_MS = (\d+);/.exec(ENGINE_SRC) || [])[1]);
  const rows = data.sessions.map((sess) => {
    const eng = E.createOrientEngine(E.sanitizeOrientKnobs({}));
    let lock = null, profile = false, front = null, back = null;
    for (const [t0, v, f, pv, ps, y, ya, la, d, rtt] of sess.samples) {
      const t = 1_000_000 + t0 - (rtt || 0);
      const acts = eng.step(E.sanitizeOrientSample({ t, vote: v, faceSeen: !!f, poseVoted: !!pv, profileScore: ps ?? 0, yawAbs: y,
        yawAt: ya == null ? 0 : t - ya, lostAt: la == null ? 0 : t - la, lock, profile, dualView: !!d }));
      for (const a of acts) {
        if (a.do === "profile") profile = a.next;
        if (a.do !== "swap" || a.next === lock) continue;
        if (a.next === "front" && lock === "back" && front === null) front = (t0 + (a.waitMs || 0) - sess.reveal) / 1000;
        if (a.next === "back" && back === null) back = (t0 + (a.waitMs || 0) - sess.reveal) / 1000;
        lock = a.next;
      }
    }
    return { name: sess.name, side: sess.retSide, off: sess.retOffset, front, after: front === null ? null : Math.round((front - sess.retSide) * 1000),
      outSide: sess.outSide, outOff: sess.outOffset, back, outAfter: back === null || sess.outSide === null ? null : Math.round((back - sess.outSide) * 1000) };
  });
  for (const r of rows) console.log(`        ${r.name}: side view ${r.side}s, FRONT out at ${r.front}s (+${r.after}ms)` +
    (r.off !== null ? `, lands on the body at ${(r.front + r.off - r.side).toFixed(2)}s from the side` : ""));
  check("every real return goes out after the camera saw the side view, at the measured offset (within 50ms of it)",
    rows.every((r) => r.after !== null && Math.abs(r.after - retDelay) <= 50), JSON.stringify(rows));
  check("...so where the switch was measurable it lands on the body within 0.1s of the side view - never the FRONT print on the back, never the BACK print on the chest",
    rows.filter((r) => r.off !== null).every((r) => Math.abs(r.front + r.off - r.side) <= 0.1), JSON.stringify(rows));
  /* The outbound, where a reading was taken at the side view (sessions 5-7): scheduled the same way, for its own offset. */
  const outs = rows.filter((r) => r.outSide !== null);
  for (const r of outs) console.log(`        ${r.name}: side view out ${r.outSide}s, BACK out at ${r.back}s (+${r.outAfter}ms)` +
    (r.outOff !== null ? `, lands on the body at ${(r.back + r.outOff - r.outSide).toFixed(2)}s from the side` : ""));
  check("every real outbound with a side-view reading goes out at its measured offset after it, and lands within 0.1s of the side where measurable",
    outs.length >= 3 && outs.every((r) => r.outAfter !== null && Math.abs(r.outAfter - outDelay) <= 50) &&
    outs.filter((r) => r.outOff !== null).every((r) => Math.abs(r.back + r.outOff - r.outSide) <= 0.1), JSON.stringify(outs));
}

console.log(fails === 0 ? "\norient-engine: OK" : `\norient-engine: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
