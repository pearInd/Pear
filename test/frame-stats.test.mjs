/* Frame-quality calibration harness (fitting-room/frame-quality.js).
   This is the tooling that decides CAMERA_BLUR_VAR_MIN, so a bug here does not crash
   anything - it quietly proposes a WRONG threshold, which then either bills for unusable
   frames or blocks real shoppers. The two properties that matter are that the ring buffer
   preserves ordering across wrap-around (otherwise the corpus is silently scrambled) and
   that suggest() refuses to answer when the classes overlap instead of splitting the
   difference. Both are asserted below.

   Imports the real module (it now IS one) rather than slicing source out of app.js.
   statsDebugEnabled() stayed behind in app.js - it also drives the WebRTC stats monitor -
   so the URL-flag assertions at the end still read that file. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(name, endMarker) {
  const start = SRC.indexOf(name);
  if (start === -1) throw new Error(`could not find "${name}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${name}"`);
  return SRC.slice(start, end);
}

const dom = new JSDOM("<html><body></body></html>", { url: "https://pear.test/fitting-room/" });
// The module lazily creates a probe canvas on first sample; this test never samples, but
// the stub keeps an accidental call from throwing on a jsdom canvas without a 2D context.
dom.window.document.createElement = ((orig) => (tag) =>
  tag === "canvas"
    ? { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) }
    : orig.call(dom.window.document, tag))(dom.window.document.createElement);
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const M = await import("../fitting-room/frame-quality.js");

const reading = (lapVar, lapVarNorm = lapVar / 100) => ({ lapVar, lapVarNorm, avgLuma: 120, clipFrac: 0 });
const reset = () => { dom.window.__pearFrameStats.clear(); };

/* ── 1. Ring buffer ordering and wrap-around ────────────────────────────────── */
reset();
for (let i = 1; i <= 5; i++) M.recordFrameStat(reading(i), i, null);
let all = M.frameStatsAll();
check("records land in insertion order", all.map((r) => r.lapVar).join(",") === "1,2,3,4,5",
  all.map((r) => r.lapVar).join(","));
check("sample index is preserved", all[2].sample === 3);

reset();
const CAP = M.FRAME_STATS_MAX;
for (let i = 1; i <= CAP + 10; i++) M.recordFrameStat(reading(i), i, null);
all = M.frameStatsAll();
check("buffer is bounded at FRAME_STATS_MAX", all.length === CAP, `len=${all.length}`);
/* The failure this catches: a wrap-around that reads from index 0 instead of `next`
   returns the corpus rotated - oldest and newest interleaved - and every percentile
   computed from it is still plausible-looking but wrong. */
check("after wrap-around the OLDEST retained record is first",
  all[0].lapVar === 11, `first=${all[0].lapVar} (expected 11)`);
check("after wrap-around the NEWEST record is last",
  all[all.length - 1].lapVar === CAP + 10, `last=${all[all.length - 1].lapVar}`);
check("readings stay monotonic across the wrap point (not rotated)",
  all.every((r, i) => i === 0 || r.lapVar > all[i - 1].lapVar));

/* Zero per-sample allocation is the production contract: slots are built once and
   overwritten. Verify writes reuse the same slot objects rather than pushing new ones. */
reset();
M.recordFrameStat(reading(1), 1, null);
const store = M.frameStatsStore();
const slotRefs = store.slots.slice(0, 5);
for (let i = 0; i < 500; i++) M.recordFrameStat(reading(i), i, null);
check("slot objects are reused, never reallocated (flat memory under sampling)",
  store.slots.slice(0, 5).every((s, i) => s === slotRefs[i]));
check("returned readings are COPIES, so a caller cannot corrupt the live ring", (() => {
  const snap = M.frameStatsAll();
  const before = snap[0].lapVar;
  snap[0].lapVar = -999;
  return M.frameStatsAll()[0].lapVar === before;
})());

/* ── 2. Labelling ───────────────────────────────────────────────────────────── */
reset();
dom.window.__pearFrameStats.label("sharp");
M.recordFrameStat(reading(400), 1, null);
dom.window.__pearFrameStats.label("blurry");
M.recordFrameStat(reading(3), 1, null);
all = M.frameStatsAll();
check("labels attach to the readings captured after them",
  all[0].label === "sharp" && all[1].label === "blurry",
  JSON.stringify(all.map((r) => r.label)));

/* ── 3. suggest() - the calibration decision ────────────────────────────────── */
reset();
check("refuses to suggest with no labelled data", M.frameStatsSuggest().ok === false);

reset();
dom.window.__pearFrameStats.label("sharp");
for (const v of [380, 420, 450, 500, 610]) M.recordFrameStat(reading(v), 1, null);
check("refuses to suggest with only ONE class labelled", (() => {
  const r = M.frameStatsSuggest();
  return r.ok === false && /blurry=0/.test(r.reason);
})(), JSON.stringify(M.frameStatsSuggest()));

// Cleanly separated classes: blurry 2-9, sharp 380-610.
dom.window.__pearFrameStats.label("blurry");
for (const v of [2, 3, 4, 6, 9]) M.recordFrameStat(reading(v), 1, null);
let sug = M.frameStatsSuggest();
const lapVarMetric = sug.metrics.find((m) => m.metric === "lapVar");
check("separated classes → ok", sug.ok === true);
check("lapVar is reported as separated", lapVarMetric.separated === true, JSON.stringify(lapVarMetric));
check("suggested cutoff sits BETWEEN the two classes",
  lapVarMetric.suggested > lapVarMetric.blurryP95 && lapVarMetric.suggested < lapVarMetric.sharpP05,
  JSON.stringify(lapVarMetric));
/* Geometric, not arithmetic: variance spans orders of magnitude, so the midpoint of
   9 and 380 must land near 58, not near 195. An arithmetic mean would sit so close to
   the sharp class that normal variation starts tripping the gate. */
check("cutoff is the GEOMETRIC mean, not the arithmetic one", (() => {
  const geo = Math.sqrt(lapVarMetric.sharpP05 * lapVarMetric.blurryP95);
  const arith = (lapVarMetric.sharpP05 + lapVarMetric.blurryP95) / 2;
  return Math.abs(lapVarMetric.suggested - geo) < 0.01 && Math.abs(lapVarMetric.suggested - arith) > 1;
})(), `suggested=${lapVarMetric.suggested}`);
check("recommendation names a metric and a number", /cutoff of [\d.]+/.test(sug.recommendation), sug.recommendation);
check("current threshold is echoed for comparison", sug.current.CAMERA_BLUR_VAR_MIN === 8);

/* THE IMPORTANT ONE. Overlapping classes mean the metric does not discriminate on this
   device. Splitting the difference there produces a confident-looking threshold that is
   simply wrong - it must refuse instead. */
reset();
dom.window.__pearFrameStats.label("sharp");
for (const v of [40, 55, 60, 75, 90]) M.recordFrameStat(reading(v, 0.5), 1, null);
dom.window.__pearFrameStats.label("blurry");
for (const v of [35, 50, 65, 80, 95]) M.recordFrameStat(reading(v, 0.5), 1, null);
sug = M.frameStatsSuggest();
check("overlapping classes → no metric reports separation",
  sug.metrics.every((m) => m.separated === false), JSON.stringify(sug.metrics));
check("overlapping classes → suggested cutoff is null, not a midpoint",
  sug.metrics.every((m) => m.suggested === null), JSON.stringify(sug.metrics));
check("overlapping classes → recommendation explicitly says do NOT set a threshold",
  /Do NOT set a threshold/.test(sug.recommendation), sug.recommendation);

/* ── 4. summary() ───────────────────────────────────────────────────────────── */
reset();
dom.window.__pearFrameStats.label("sharp");
for (const v of [10, 20, 30, 40, 50]) M.recordFrameStat(reading(v), 1, null);
const sum = M.frameStatsSummary();
const row = sum.find((r) => r.label === "sharp" && r.metric === "lapVar");
check("summary reports both metrics per label", sum.filter((r) => r.label === "sharp").length === 2);
check("summary percentiles are ordered min ≤ median ≤ max",
  row.min <= row.median && row.median <= row.max, JSON.stringify(row));
check("summary counts every reading", row.n === 5, JSON.stringify(row));
check("unlabelled readings are bucketed, not dropped", (() => {
  reset();
  M.recordFrameStat(reading(7), 1, null);
  return M.frameStatsSummary().some((r) => r.label === "(unlabelled)");
})());

/* ── 5. Cost when disabled ──────────────────────────────────────────────────── */
check("clear() drops the buffer so a disabled session holds nothing", (() => {
  reset();
  return M.frameStatsAll().length === 0;
})());
check("export() is valid JSON", (() => {
  reset();
  M.recordFrameStat(reading(12), 1, null);
  const parsed = JSON.parse(dom.window.__pearFrameStats.export());
  return Array.isArray(parsed) && parsed[0].lapVar === 12;
})());

/* ── 6. The URL entry point the calibration workflow depends on ─────────────── */
const statsFn = extract("function statsDebugEnabled", "\nfunction startStatsMonitor");
check("?debugFrameStats=1 is honoured", /debugFrameStats/.test(statsFn), statsFn);
check("...and latches into localStorage so it survives navigation",
  /setItem\("pear_stats_debug", "1"\)/.test(statsFn), statsFn);
check("...and ?debugFrameStats=0 clears it again",
  /removeItem\("pear_stats_debug"\)/.test(statsFn), statsFn);

console.log("\n" + (fails ? `${fails} check(s) FAILED` : "All frame-stats checks passed."));
process.exit(fails ? 1 : 0);
