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

const PINNED = "4b2ead79da82f69520d245bf054d2e1353051f7ec2cf8e5fd2f14b2c0a65a706";

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
  check(`${r.scenarios} replayed sessions (${r.events} events) match the pre-move watcher`, r.hash === PINNED,
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
                   "ORIENT_POSE_FLIP_FRAMES", "ORIENT_POSE_PASS", "ORIENT_POST_PEAK", "ORIENT_EARLY_TURN_DEG", "ORIENT_EARLY_TURN_RETURN_DEG",
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
  check("the Worker runs the shared protocol session - no engine or protocol of its own",
    /from "\.\.\/\.\.\/\.\.\/lib\/orient-protocol\.js"/.test(WSRC) && /createOrientSession\(/.test(wcode) &&
    !/createOrientEngine|JSON\.parse/.test(wcode));
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

console.log(fails === 0 ? "\norient-engine: OK" : `\norient-engine: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
