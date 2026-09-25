/* THE SIZE FIT, PINNED - "it moved server-side; did anything change?"
   ─────────────────────────────────────────────────────────────────────────────
   On 2026-09-26 the size charts and the fit moved out of the browser into
   lib/sizing.js (POST /api/size; CLAUDE.md §2.12). The move was proven exact at the
   time: the old in-browser calculateSize() and the new shell + server ran over
   1,458,028 cases and matched byte for byte. That proof needs the OLD code, which no
   longer exists - so this suite keeps its conclusion instead.

   It drives the REAL client shell (app.js's Screen 1 region: chart selection, evidence,
   applySizeVerdict()) with requestSizeVerdict() wired to the REAL lib/sizing.js through
   its sanitiser and a JSON round trip, over a reduced grid (every garment situation ×
   a height/weight grid that crosses every band edge × an optional-measurement grid), and
   compares a SHA-256 of every outcome - size, adult/child category, body category, the
   numeric-pants and women's-tops flags, the painted text, the result box and Continue -
   with PINNED below.

   PINNED WAS COMPUTED FROM THE PRE-MOVE BROWSER CODE (HEAD before the move) over this
   exact grid, and the new code reproduced it. So a red run here means the recommendation
   changed for SOME body on SOME garment. If that is the intent (a chart update, a new
   rule), re-derive the value with `node test/size-fit-pin.test.mjs --print` and replace
   PINNED in the same commit - and say in the commit message which sizes moved and why.
   If it is not the intent, it is a regression; the per-context counts below tell you
   where to look.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PINNED = "22645f11f7c584753a2902b0326266f22ca4df4e5d92ec6b989bf2636fa7e705";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SIZING = await import("../lib/sizing.js");
const requestSizeVerdict = (evidence) =>
  Promise.resolve(SIZING.computeSizeVerdict(SIZING.sanitizeSizeEvidence(JSON.parse(JSON.stringify(evidence)))));

function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}
const SLICE = extract(APP, "const CHILD_SIZE_SCALE = [", "\nfunction onMeasurementKeydown");

/* ── the grid ─────────────────────────────────────────────────────────────── */
const CONTEXTS = [
  { name: "no-garment-info" },
  { name: "eu-pants-full", pendingSizes: ["36", "38", "40", "42", "44", "46"] },
  { name: "eu-pants-snap", pendingSizes: ["36", "40", "44"] },
  { name: "jeans-waist", pendingSizes: ["28", "30", "32", "34", "36"] },
  { name: "jeans-waist-wide", pendingSizes: ["26", "27", "28", "29", "30", "31", "32", "33", "34", "36", "38", "40"] },
  { name: "kids-run", pendingSizes: ["8", "10", "12", "14", "16"] },
  { name: "kids-small", pendingSizes: ["2", "4", "6"] },
  { name: "alpha-run", pendingSizes: ["S", "M", "L", "XL"] },
  { name: "pants-by-title", pendingTitle: "ג'ינס סקיני לגברים" },
  { name: "pants-by-title-en", pendingTitle: "Slim Fit Chino Trousers" },
  { name: "denim-jacket-title", pendingTitle: "Denim Jacket" },
  { name: "women-alpha", pendingSizes: ["XS", "S", "M", "L", "XL"], gender: "women" },
  { name: "women-noinfo", gender: "women" },
  { name: "men-alpha", pendingSizes: ["S", "M", "L"], gender: "men" },
  { name: "women-jeans", pendingSizes: ["28", "30", "32"], gender: "women" },
  { name: "sweatpants-alpha", pendingSizes: ["S", "M", "L"], pendingTitle: "Sweatpants", pendingSizeRunType: "alpha" },
  { name: "agegroup-kids", pendingAgeGroup: "kids" },
  { name: "agegroup-adult", pendingAgeGroup: "adult" },
  { name: "category-pants", garmentCategory: "pants" },
  { name: "eu-numeric-top-item", pendingSizes: ["36", "38", "40", "42"], activeItem: { sizes: ["36", "38", "40", "42"], garmentType: "top" }, bottoms: false },
  { name: "item-bottoms-jeans", activeItem: { sizes: ["30", "32", "34"], garmentType: "pants", name: "Jeans" }, bottoms: true },
  { name: "store-chart-alpha", pendingSizes: ["S", "M", "L", "XL"],
    pendingSizeChart: "cm;table;S:86-91:70-75::|M:92-97:76-81::|L:98-103:82-87::|XL:104-109:88-93::" },
  { name: "store-chart-pants", pendingSizes: ["28", "30", "32", "34"],
    pendingSizeChart: "cm;table;28::70-72::|30::74-77::|32::79-82::|34::84-87::" },
  { name: "store-chart-garbage", pendingSizes: ["S", "M"], pendingSizeChart: "inch;x;S:1-2" },
  { name: "numeric-nonwaist", pendingSizes: ["1", "2", "3"] },
  { name: "one-size", pendingSizes: ["ONE SIZE"] },
];
/* Every band edge of every chart, ±1, plus a coarse sweep past both validation bounds. */
const EDGE_H = [122, 135, 145, 155, 160, 163, 165, 168, 170, 172, 174, 175, 176, 178, 180, 184, 185, 186, 190, 193, 195, 198, 200, 205];
const EDGE_W = [22, 27, 32, 38, 46, 48, 51, 54, 55, 58, 60, 62, 65, 67, 69, 70, 72, 73, 75, 76, 78, 81, 82, 83, 84, 85, 87, 88, 92, 93, 97, 102, 105, 112];
const around = (vals) => vals.flatMap((v) => [v - 1, v, v + 1]);
const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
const HEIGHTS = uniq([...Array.from({ length: 28 }, (_, i) => 104 + i * 5), ...around(EDGE_H), 109, 110, 240, 241]);
const WEIGHTS = uniq([...Array.from({ length: 44 }, (_, i) => 14 + i * 5), ...around(EDGE_W), 17, 18, 220, 221]);
const FINE_H = [164, 171, 179, 185, 192];
const FINE_W = [60, 66, 75, 82, 90];
const CHESTS = [null, 88, 97, 105, 112];
const WAISTS = [null, 70, 80, 86, 95];
const LEGS = [null, 96, 104];

function* cases() {
  for (const ctx of CONTEXTS) {
    yield { ctx, height: null, weight: null };
    yield { ctx, height: 175, weight: null };
    for (const h of HEIGHTS) for (const w of WEIGHTS) yield { ctx, height: h, weight: w };
    for (const h of FINE_H) for (const w of FINE_W) for (const c of CHESTS) for (const wa of WAISTS) for (const l of LEGS) {
      if (c === null && wa === null && l === null) continue;
      yield { ctx, height: h, weight: w, chest: c, waist: wa, legs: l };
    }
  }
}

/* ── the harness - the same shape numeric-pants-sizing.test.mjs uses ──────── */
function classList() {
  const set = new Set();
  return { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
           contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), _set: set };
}
function harness(ctx) {
  const els = {
    height: { value: "" }, weight: { value: "" }, chest: { value: "" }, waist: { value: "" }, legs: { value: "" },
    resultBox: { classList: classList() }, sizeResult: { innerText: "" }, resultLabel: { innerText: "" },
    "btn-next-screen": { disabled: true }, resultActions: { classList: classList() },
    optionalFields: { classList: classList() }, sizeMismatchView: { hidden: true },
    sizeMismatchText: { textContent: "" }, captureBtn: { disabled: false }, cameraCard: { classList: classList() },
    pearSizeSelector: { remove: () => {} }, progressFill: { style: {} }, progressPercent: { innerText: "" },
  };
  const $ = (id) => els[id] ?? null;
  const t = (k) => k;
  const isBottomsGarment = ctx.bottoms === undefined ? undefined : () => ctx.bottoms;
  const fn = new Function(
    "$", "t", "tf", "activeItem", "pendingSizes", "pendingAgeGroup", "pendingTitle", "pendingSizeRunType",
    "pendingSizeChart", "localStream", "__category", "isBottomsGarment", "__gender", "requestSizeVerdict",
    "let currentUserSize = null, currentSizeCategory = null, currentBodyCategory = null, currentUserGender = __gender;\n" +
    SLICE +
    "\ncurrentGarmentCategory = __category;" +
    "\nreturn { calculateSize, st: () => ({ size: currentUserSize, cat: currentSizeCategory, body: currentBodyCategory," +
    " np: currentSizeIsNumericPants, wt: currentSizeIsWomensTops }) };");
  const api = fn($, t, t, ctx.activeItem ?? null, ctx.pendingSizes, ctx.pendingAgeGroup, ctx.pendingTitle,
                 ctx.pendingSizeRunType, ctx.pendingSizeChart, {}, ctx.garmentCategory ?? null, isBottomsGarment,
                 ctx.gender ?? null, requestSizeVerdict);
  return { api, els };
}

/* ── run ──────────────────────────────────────────────────────────────────── */
const quietLog = console.log, quietWarn = console.warn;
console.log = () => {}; console.warn = () => {};
const hash = createHash("sha256");
const perContext = new Map();
let total = 0, cur = null, h = null;
try {
  for (const c of cases()) {
    if (c.ctx !== cur) { cur = c.ctx; h = harness(c.ctx); }
    const e = h.els;
    e.height.value = c.height == null ? "" : String(c.height);
    e.weight.value = c.weight == null ? "" : String(c.weight);
    e.chest.value = c.chest == null ? "" : String(c.chest);
    e.waist.value = c.waist == null ? "" : String(c.waist);
    e.legs.value = c.legs == null ? "" : String(c.legs);
    await h.api.calculateSize();
    const st = h.api.st();
    hash.update(JSON.stringify({ ...st, text: e.sizeResult.innerText, lbl: e.resultLabel.innerText,
      cls: [...e.resultBox.classList._set].sort().join(" "), next: e["btn-next-screen"].disabled,
      ready: [...e.resultActions.classList._set].sort().join(" ") }) + "\n");
    e.sizeResult.innerText = "";
    total++;
    if (st.size) perContext.set(c.ctx.name, (perContext.get(c.ctx.name) || 0) + 1);
  }
} finally {
  console.log = quietLog; console.warn = quietWarn;
}
const digest = hash.digest("hex");

if (process.argv.includes("--print")) {
  console.log(digest);
  process.exit(0);
}

const ok = digest === PINNED;
console.log(`${ok ? "PASS" : "FAIL"}  the size fit over ${total} cases matches the pinned pre-move behaviour`);
if (!ok) {
  console.log(`        expected ${PINNED}\n        got      ${digest}`);
  console.log("        sized cases per garment situation (compare against a green run):");
  for (const [name, n] of perContext) console.log(`          ${name.padEnd(22)} ${n}`);
}
console.log(ok ? "\nSize fit pin: OK" : "\nSize fit pin: FAILED");
process.exit(ok ? 0 : 1);
