/* THE PACE OF THE PICTURE (fitting-room/app.js) and the jitter buffer (config.js PLAYOUT_DELAY_HINT), 2026-10-09 - "the
   shirt works well, but it doesn't feel smooth". The owner's clips present the ~10 fps render in bursts (two frames 25-45ms
   apart, then 170-230ms). The receiver's buffer goes 80 -> 150ms; a TEST record now says where the unevenness is made.
   §1 the summaries, standalone (sliced from app.js)
   §2 the wiring: every frame we send and every frame we show, a TEST session only, into out-stats
   §3 the buffer: 150ms, through both APIs from one number */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ""}`); }
}
function between(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found: ${to}`);
  return src.slice(a, b);
}
const BLOCK = between(APP, "/* ── THE PACE OF THE PICTURE (2026-10-09)", "/* ── end THE PACE OF THE PICTURE ── */");

console.log("\n── §1 the summaries ──");
{
  const P = new Function(BLOCK + "\nreturn { notePaceInput, paceSummary, paceRtpMs, PACE_MAX_SAMPLES, get paceIn() { return _paceIn; }, set paceIn(v) { _paceIn = v; } };")();
  /* The 10:53 shorts clip's presented intervals, as read frame by frame. */
  const iv = [33, 42, 92, 100, 108, 104, 29, 168, 224, 206, 200, 97, 196, 33, 47, 129, 33, 73, 94, 24, 75, 101, 32, 93, 99, 100];
  const times = [0]; for (const d of iv) times.push(times[times.length - 1] + d);
  const s = P.paceSummary(times);
  check("§1.1 [p10, p50, p90, max] of the intervals - the reported clip reads bursty (p90 >= 150, max 224)",
    Array.isArray(s) && s.length === 4 && s[2] >= 150 && s[3] === 224 && s[0] <= 35, JSON.stringify(s));
  const even = P.paceSummary(Array.from({ length: 30 }, (_, i) => i * 100));
  check("§1.2 an even 10 fps reads 100 at every percentile", JSON.stringify(even) === "[100,100,100,100]", JSON.stringify(even));
  check("§1.3 fewer than three times, or junk: nothing", P.paceSummary([1, 2]) === null && P.paceSummary(null) === null);
  /* 90 kHz, 100ms apart, across the 2^32 wrap. */
  const W = 2 ** 32, rtp = [W - 18000, W - 9000, 0, 9000, 18000];
  const ms = P.paceRtpMs(rtp);
  check("§1.4 RTP timestamps to ms, across a wrap: 100ms apart throughout",
    ms.slice(1).every((t, i) => Math.abs(t - ms[i] - 100) < 1e-6), JSON.stringify(ms.map((x, i) => i ? Math.round(x - ms[i - 1]) : 0)));
  check("§1.5 no collector, nothing collected (a shopper's session)", (P.notePaceInput(5), P.paceIn === null));
  P.paceIn = [];
  for (let i = 0; i < P.PACE_MAX_SAMPLES + 50; i++) P.notePaceInput(i);
  check("§1.6 a collector is bounded", P.paceIn.length === P.PACE_MAX_SAMPLES);
}

console.log("\n── §2 the wiring ──");
{
  check("§2.1 every frame the throttle sends is noted, typeof-guarded, right after it goes out",
    /outTrack\.requestFrame\(\);\s*\n\s*lastFrameAt = clock\(\);\s*\n\s*if \(typeof traceInputFrame === "function"\) traceInputFrame\(canvas\);[^\n]*\n\s*if \(typeof notePaceInput === "function"\) notePaceInput\(performance\.now\(\)\);/.test(APP));
  const cont = between(APP, "function startStreamContinuity() {", "\nfunction stopStreamContinuity() {");
  check("§2.2 a TEST session only: the collectors exist only when traceEnabled()",
    /const pace = typeof traceEnabled === "function" && traceEnabled\(\) \? \{ show: \[\], recv: \[\], rtp: \[\] \} : null;\s*\n\s*_paceIn = pace \? \[\] : null;/.test(cont));
  check("§2.3 every frame shown: its presentation, arrival and RTP time (the rVFC metadata), bounded",
    /const onAi = \(now, md\) => \{/.test(cont) && /pace\.show\.push\(now\);/.test(cont) &&
    /md\.receiveTime/.test(cont) && /md\.rtpTimestamp/.test(cont) && /pace\.show\.length < PACE_MAX_SAMPLES/.test(cont));
  check("§2.4 out-stats carries pace (in / rtp / recv / show and the buffer) only when collected, and the input stops after",
    /\.\.\.\(pace \? \{ pace: \{ in: paceSummary\(_paceIn\), rtp: paceSummary\(paceRtpMs\(pace\.rtp\)\), recv: paceSummary\(pace\.recv\),\s*\n\s*show: paceSummary\(pace\.show\), jb: Math\.round\(PLAYOUT_DELAY_HINT \* 1000\) \} \} : \{\}\)/.test(cont) &&
    cont.indexOf("_paceIn = null;") > cont.indexOf('traceOrient("out-stats"'));
  check("§2.5 the lag probe's hooks keep their place (orient-link pins them)",
    /aiFrames\+\+; model\.frame\(now\);\s*\n\s*if \(typeof traceOutputFrame === "function"\) traceOutputFrame\(ai\);/.test(cont));
  check("§2.6 the block decides nothing - no swap, no apply, no wire",
    !/maybeSwap|applyActive|sendCondition|rtClient|decide\./.test(BLOCK.replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log("\n── §3 the buffer ──");
{
  check("§3.1 PLAYOUT_DELAY_HINT is 0.15s (was 0.08) - the p90 burst gap of the clips",
    /PLAYOUT_DELAY_HINT: 0\.15,/.test(CFG));
  check("§3.2 ...applied through both the legacy and the standard API, from that one number",
    /r\.playoutDelayHint = PLAYOUT_DELAY_HINT;/.test(APP) && /r\.jitterBufferTarget = PLAYOUT_DELAY_HINT \* 1000;/.test(APP));
}

console.log(`\n${failed ? "✗" : "✓"} picture-pace: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
