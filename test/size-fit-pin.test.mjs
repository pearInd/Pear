/* THE SIZE FIT AND THE PRODUCT RULES, PINNED - "they moved server-side; did anything change?"
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

   §2 does the same for the PRODUCT rules, which followed the charts server-side the
   same day (kids-only / adult-only, is it pants, EU or waist chart, the alpha veto -
   lib/sizing.js productVerdict()). A corpus of product situations is run through the
   REAL browser path (app.js sizeProductEvidence() -> JSON -> sanitizeProductEvidence()
   -> productVerdict()) and hashed; PRODUCT_PINNED was computed from the PRE-MOVE
   in-browser functions over the same corpus (the move itself was proven over 1,092,000
   situations). Re-pin with `--print` only for an intended rule change, and say which.
   §3 keeps the two ends of that wire naming the same fields, and §4 states the move as
   an absence: the browser no longer carries the rules.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PINNED = "22645f11f7c584753a2902b0326266f22ca4df4e5d92ec6b989bf2636fa7e705";
const PRODUCT_PINNED = "b2d6cf0b9403b742a60787c397097125ca23cb062cdd2e22fd6a2c9d805a16a4";

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

/* ── §2 the product rules ─────────────────────────────────────────────────── */
const between = (src, a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i)); };
/* The browser's own isBottomsGarment() - it stays in app.js; its verdict rides as item.bottoms. */
const realBottoms = new Function(between(APP, "const BOTTOMS_TOKENS =", "/* The garment facts the prompt engine reads") +
  "\nreturn isBottomsGarment;")();

/* ── PRODUCT CORPUS ─────────────────────────────────────────────────────── */
const P_SIZES = [undefined, [], ["S", "M", "L"], ["XS", "S", "M", "L", "XL"], ["8", "10", "12"], ["2", "4", "6"],
  ["36", "38", "40", "42", "44", "46"], ["36", "40", "44"], ["28", "30", "32", "34", "36"],
  ["26", "27", "28", "29", "30", "31", "32", "33", "34", "36", "38", "40"], ["24", "48"], ["23", "24"], ["49"],
  ["30", "M"], ["ONE SIZE"], ["1", "2", "3"], ["34", "36", "38"], ["14", "15", "16", "17", "18"], ["2XL", "3XL"],
  ["S", "M", "8"], [" l ", "m"], "S,M,L", "28,30,32", ["36R", "38R"], ["10", "12", "14", "16", "18"], ["46", "48"]];
const P_TITLES = [undefined, "", "ג'ינס סקיני לגברים", "ג׳ינס סקיני", "ג’ינס", "ז'קט ג'ינס", "ז׳קט ג׳ינס", "מכנס ג'ינס",
  "Denim Jacket", "Slim Fit Chino Trousers", "Sweatpants", "Short Sleeve Tee", "Cargo Shorts", "Bermuda shorts",
  "LOOSE", "STRAIGHT BASIC", "חצאית מיני", "טייץ ספורט", "Jeans Jacket", "Palazzo pants", "Pantsuit", "חולצה מכופתרת",
  "Denim skirt", "Tee & shorts set", "SWEATPANTS JOGGER"];
const P_AGE = [undefined, "kids", "adult", "uncertain"];
const P_CATS = [null, "pants", " PANTS ", "top", "unknown"];
const P_RUNS = [undefined, "alpha", "numeric", "unknown"];
const P_ITEMS = [null, { garmentType: "lower_body" }, { garmentType: "upper_body" }, { type: "pants" },
  { category: "bottoms" }, { garmentType: "top" }, { type: "jeans", name: "Jeans" }, { garmentType: "", type: "pants" },
  { name: "Wide Leg Trouser" }, { title: "Denim Jacket", type: "jacket" }, { garmentType: 0, category: "skirt" }];
const P_BOTTOMS = ["real", "absent", "yes", "no"];
function* productCorpus() {
  let n = 0;
  for (const bk of P_BOTTOMS) for (const it of P_ITEMS) for (const sz of P_SIZES) for (const title of P_TITLES)
  for (const ag of P_AGE) for (const cat of P_CATS) for (const run of P_RUNS) {
    n++;
    if (n % 23) continue;                                  // a fixed 1-in-23 sample of the full grid
    if (bk !== "real" && it === null) continue;            // no item -> the classifier is never consulted
    const onItem = it && n % 2 === 0;
    yield { bk, cat,
      activeItem: it ? { ...it, ...(onItem ? { sizes: sz, ageGroup: ag, sizeRunType: run } : {}) } : null,
      pendingSizes: onItem ? undefined : sz, pendingAgeGroup: onItem ? undefined : ag,
      pendingTitle: title, pendingSizeRunType: onItem ? undefined : run };
  }
}
/* ── end PRODUCT CORPUS ─────────────────────────────────────────────────── */

function productHarness(isBottomsGarment) {
  return new Function("isBottomsGarment",
    "let activeItem = null, pendingSizes, pendingAgeGroup, pendingTitle, pendingSizeRunType, currentBodyCategory = null;\n" +
    SLICE +
    "\nreturn { sizeProductEvidence, set(o) { activeItem = o.activeItem; pendingSizes = o.pendingSizes;" +
    " pendingAgeGroup = o.pendingAgeGroup; pendingTitle = o.pendingTitle; pendingSizeRunType = o.pendingSizeRunType;" +
    " currentGarmentCategory = o.cat; } };")(isBottomsGarment);
}
const clients = { real: productHarness(realBottoms), absent: productHarness(undefined),
                  yes: productHarness(() => true), no: productHarness(() => false) };
const productHash = createHash("sha256");
let productCases = 0;
for (const c of productCorpus()) {
  const client = clients[c.bk];
  client.set(c);
  const wire = JSON.parse(JSON.stringify(client.sizeProductEvidence()));
  const v = SIZING.productVerdict(SIZING.sanitizeProductEvidence(wire));
  productHash.update(JSON.stringify({ chart: v.chart, kidsOnly: v.kidsOnly, adultOnly: v.adultOnly,
    lowerBody: v.lowerBody, adultNumericPants: v.adultNumericPants }) + "\n");
  productCases++;
}
const productDigest = productHash.digest("hex");

if (process.argv.includes("--print")) {
  console.log(digest);
  console.log(productDigest);
  process.exit(0);
}

let fails = 0;
const report = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok && detail) console.log(`        ${detail}`); };

console.log("── §1 the size fit ──");
const ok = digest === PINNED;
report(ok, `the size fit over ${total} cases matches the pinned pre-move behaviour`);
if (!ok) {
  console.log(`        expected ${PINNED}\n        got      ${digest}`);
  console.log("        sized cases per garment situation (compare against a green run):");
  for (const [name, n] of perContext) console.log(`          ${name.padEnd(22)} ${n}`);
}

console.log("\n── §2 the product rules ──");
report(productDigest === PRODUCT_PINNED,
  `every product verdict over ${productCases} situations matches the pre-move in-browser rules`,
  `expected ${PRODUCT_PINNED}\n        got      ${productDigest}`);

console.log("\n── §3 the evidence the browser sends is the evidence the server reads ──");
{
  const sent = clients.real;
  sent.set({ activeItem: { garmentType: "lower_body", sizes: ["30"], ageGroup: "adult", sizeRunType: "numeric" },
             pendingTitle: "Jeans", cat: "pants" });
  const ev = sent.sizeProductEvidence();
  const read = SIZING.sanitizeProductEvidence(JSON.parse(JSON.stringify(ev)));
  report(JSON.stringify(Object.keys(ev).sort()) === JSON.stringify(Object.keys(read).sort()) &&
         JSON.stringify(Object.keys(ev.item).sort()) === JSON.stringify(Object.keys(read.item).sort()),
    "sizeProductEvidence() and sanitizeProductEvidence() name the same fields, item included",
    `${Object.keys(ev)} / ${Object.keys(ev.item)} vs ${Object.keys(read)} / ${Object.keys(read.item)}`);
  report(JSON.stringify(read) === JSON.stringify(ev),
    "...and a real evidence object survives the sanitiser unchanged", `${JSON.stringify(ev)}\n        ${JSON.stringify(read)}`);
  clients.absent.set({ activeItem: null });
  const noItem = clients.absent.sizeProductEvidence().item;
  clients.absent.set({ activeItem: { type: "shirt" } });
  const noVerdict = clients.absent.sizeProductEvidence().item.bottoms;
  report(ev.item.bottoms === true && noItem === null && noVerdict === null,
    "the bottoms verdict is a real boolean where isBottomsGarment() exists, and null where it does not",
    `${ev.item.bottoms} / ${JSON.stringify(noItem)} / ${noVerdict}`);
  const junk = SIZING.sanitizeProductEvidence({ sizes: "S", title: 5, ageGroup: "teen", cachedCategory: {},
    item: { garmentType: ["x"], bottoms: "yes", secret: 1 }, extra: true });
  report(JSON.stringify(junk) === JSON.stringify({ sizes: [], ageGroup: "uncertain", title: "", cachedCategory: null,
    sizeRunType: null, item: { garmentType: null, type: null, category: null, bottoms: null } }),
    "wrong types and unknown fields never reach the rules", JSON.stringify(junk));
  const empty = SIZING.computeSizeVerdict(SIZING.sanitizeSizeEvidence(null));
  report(empty.status === "empty" && JSON.stringify(empty.product) ===
    JSON.stringify({ chart: "letters", kidsOnly: false, adultOnly: false, adultNumericPants: false }),
    "no evidence at all is the letters chart, neither kids- nor adult-only (CLAUDE.md §2.5)", JSON.stringify(empty));
  report(!("lowerBody" in empty.product),
    "the browser is sent only what it acts on - lowerBody stays server-side");
}

console.log("\n── §4 the browser no longer carries the product rules ──");
{
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const fn of ["isKidsProduct", "isAdultProduct", "isAdultPantsProduct", "isAlphaSizeRun",
                    "isAdultNumericPantsGarment", "isWaistInchSizeRun", "titleNamesPants", "isPantsProduct",
                    "pantsChartKindForSizes"]) {
    report(!new RegExp(`\\b${fn}\\b`).test(code), `app.js code no longer defines or calls ${fn}()`);
  }
  for (const id of ["KIDS_NUMERIC_SIZES", "PANTS_TITLE_STEMS_HE", "PANTS_TITLE_WORDS_EN", "PANTS_FABRIC_WORDS",
                    "PANTS_EXPLICIT_TYPES", "WAIST_INCH_FLOOR"]) {
    report(!code.includes(id), `app.js code no longer carries ${id}`);
  }
}

console.log(fails ? `\nSize fit pin: ${fails} FAILED` : "\nSize fit pin: OK");
process.exit(fails ? 1 : 0);
