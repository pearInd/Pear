/* THE ACK WATCHDOG (2026-10-12, TEST sessions only) - "the front print on my back".
   b3 and b5 that day: the turn's BACK - the very image primed at connect and acknowledged in ~270ms - was never
   acknowledged. The engine kept rendering the FRONT through the back view, and the SDK held the wire for its 30s ack
   timeout, so the FRONT return, every re-anchor and any re-send waited behind it. 2 of 4 sessions that day, 0 of the 7
   before; nothing on the room's side differed around the send.
   §1 sendCondition's releaseAfterMs: a write the engine ignores stops holding the queue after that long.
   §2 maybeSwap's watchdog, run on its own: no ack in the first window -> sent again at once; no ack after that -> the
      swap fails (the lock rolls back in maybeSwap's catch); a late ack re-sends the side the lock then holds.
   §3 the wiring: TEST sessions only (?ack_watch=0 off), both image writes honour it, read before their first await. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const between = (a, b) => { const i = APP.indexOf(a); if (i === -1) throw new Error(`no "${a}"`); const j = APP.indexOf(b, i); if (j === -1) throw new Error(`no "${b}"`); return APP.slice(i, j + b.length); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n── §1 the wire is not held by a write the engine ignored ──");
{
  const SEND = between("let _swapWireReleaseMs = 0;", "\n  return next;\n}");
  const make = () => new Function("traceOrient", "console", "location",
    "let wireQueue = Promise.resolve(), wireEpoch = 0, wireWrites = 0, wireInFlight = 0, isSettingCondition = false, _orientSendMark = null;\n" +
    "const ENGINE_PACE_LABELS = new Set(); function noteEngineAck() {} function wireBusy() { return wireInFlight > 0; }\n" +
    SEND + "\nreturn { sendCondition, busy: () => wireInFlight };")((k, v) => trace.push([k, v]), { log() {}, warn() {} }, { search: "" });
  let trace = [];
  const S = make();
  const order = [];
  S.sendCondition("applyGarment", () => new Promise(() => {}), { releaseAfterMs: 40 });   // never acknowledged
  const t0 = Date.now();
  await S.sendCondition("applyGarment", async () => { order.push(Date.now() - t0); });
  check("§1.1 with releaseAfterMs, the next write goes out after that long - not behind the dropped one",
    order.length === 1 && order[0] >= 35 && order[0] < 400, JSON.stringify(order));
  check("§1.2 ...and the release is in the TEST record (wire-release)", trace.some(([k, v]) => k === "wire-release" && v.ms === 40), JSON.stringify(trace));
  trace = [];
  const T = make();
  T.sendCondition("applyGarment", () => new Promise(() => {}));
  let ran = false;
  T.sendCondition("applyGarment", async () => { ran = true; });
  await wait(150);
  check("§1.3 without it (every shopper's write): the queue waits for the write, exactly as before", ran === false);
  const U = make();
  let doneAt = null;
  const tu = Date.now();
  await U.sendCondition("applyGarment", () => wait(10), { releaseAfterMs: 500 });
  await U.sendCondition("applyGarment", async () => { doneAt = Date.now() - tu; });
  check("§1.4 an acknowledged write releases at its ack, not at the timer", doneAt !== null && doneAt < 200, String(doneAt));
}

console.log("\n── §2 the watchdog, on its own ──");
{
  const BLOCK = between("const ackWatchMs = typeof swapAckWatchMs === \"function\" ? swapAckWatchMs() : 0;",
    "} else if (got === \"fail\") await first;   // its own error, for the catch below\n      }");
  const run = async ({ acks, watch = 30, giveup = 40, lockAfter = null }) => {
    const calls = [], trace = [], releases = [];
    let _swapWireReleaseMs = 0, n = 0;
    const st = { autoOrientation: "back", disposed: false };
    const applyActive = () => { releases.push(_swapWireReleaseMs); const a = acks[n++] ?? "never"; calls.push(a);
      if (a === "never") return new Promise(() => {});
      if (typeof a === "number") return wait(a);
      if (a === "fail") return Promise.reject(new Error("set failed"));
      if (a && a.late) return wait(a.late);
      return Promise.resolve(); };
    const fn = new Function("swapAckWatchMs", "SWAP_ACK_GIVEUP_MS", "applyActive", "traceOrient", "st", "next", "setRel", "getRel",
      `return (async () => { let disposed = false;
         const _g = { get autoOrientation() { return st.autoOrientation; } };
         ${BLOCK.replace(/_swapWireReleaseMs = ackWatchMs/g, "setRel(ackWatchMs)").replace(/_swapWireReleaseMs = 0/g, "setRel(0)").replace(/autoOrientation/g, "st.autoOrientation")}
       })();`);
    let err = null;
    try { await fn(() => watch, giveup, applyActive, (k, v) => trace.push(k), st, "back", (v) => { _swapWireReleaseMs = v; }, () => _swapWireReleaseMs); }
    catch (e) { err = e; }
    if (lockAfter) st.autoOrientation = lockAfter;
    return { calls, trace, releases, err, st };
  };
  const ok = await run({ acks: [5] });
  check("§2.1 an ack inside the first window: one send, nothing more", ok.calls.length === 1 && !ok.err && ok.trace.length === 0, JSON.stringify(ok));
  check("§2.2 ...and that send carried the wire release (the swap's write)", ok.releases[0] === 30, JSON.stringify(ok.releases));
  const re = await run({ acks: ["never", 5] });
  check("§2.3 the first never acknowledged: sent again at once, and the re-send's ack completes the swap",
    re.calls.length === 2 && !re.err && re.trace.join() === "swap-resend", JSON.stringify(re));
  const gone = await run({ acks: ["never", "never"] });
  check("§2.4 neither acknowledged: the swap fails (maybeSwap's catch rolls the lock back), traced as a give-up",
    gone.err && /did not acknowledge/.test(gone.err.message) && gone.trace.join() === "swap-resend,swap-giveup", JSON.stringify({ ...gone, err: String(gone.err) }));
  const late = await run({ acks: [{ late: 120 }, "never", 3], lockAfter: "front" });
  await wait(200);
  check("§2.5 an acknowledgement that arrives after the give-up re-sends the side the lock now holds (a late back never stays)",
    late.err && late.calls.length === 3 && late.trace.includes("swap-late-ack"), JSON.stringify({ calls: late.calls, trace: late.trace }));
  const bad = await run({ acks: ["fail"] });
  check("§2.6 a send that fails is its own error, not a re-send", bad.err && bad.err.message === "set failed" && bad.calls.length === 1, String(bad.err));
}

console.log("\n── §3 the wiring ──");
{
  check("§3.1 TEST sessions only, and ?ack_watch=0 turns it off",
    /function swapAckWatchMs\(\) \{[\s\S]*?get\("ack_watch"\) === "0"\) return 0;[\s\S]*?return typeof traceEnabled === "function" && traceEnabled\(\) \? SWAP_ACK_RESEND_MS : 0;/.test(APP));
  const ag = between("async function applyGarment(item) {", "await sendCondition(\"applyGarment\"");
  const al = between("async function applyLook(top, bottom) {", "await sendCondition(\"applyLook\"");
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const head = (src) => code(src).indexOf("const wireRelease = typeof _swapWireReleaseMs === \"number\" ? _swapWireReleaseMs : 0;");
  const firstAwait = (src) => code(src).search(/\bawait\b/);
  check("§3.2 both image writes read the release before their first await",
    head(ag) > 0 && head(ag) < firstAwait(ag) && head(al) > 0 && head(al) < firstAwait(al), `${head(ag)} ${firstAwait(ag)} ${head(al)} ${firstAwait(al)}`);
  check("§3.3 ...and pass it to their write", /sendCondition\("applyGarment", \(\) => rtClient\.set\(payload\), wireRelease > 0 \? \{ releaseAfterMs: wireRelease \} : undefined\);/.test(APP) &&
    /\}, wireRelease > 0 \? \{ releaseAfterMs: wireRelease \} : undefined\);/.test(APP));
  const ms = APP.slice(APP.indexOf("async function maybeSwap(next, predictive = false) {"), APP.indexOf("async function maybeSwap(next, predictive = false) {") + 30000);
  check("§3.4 maybeSwap takes the watchdog only when it is on; otherwise one await applyActive(), as before",
    /if \(ackWatchMs > 0\) \{[\s\S]*?\} else \{\n\s*await applyActive\(\);/.test(ms));
}

console.log(fails === 0 ? "\nack-watchdog: OK" : `\nack-watchdog: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
