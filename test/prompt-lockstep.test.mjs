/* SHED IN LOCKSTEP - "the shirt dropped and widened in the middle of the measurement" (2026-10-14)
   ─────────────────────────────────────────────────────────────────────────────
   The owner's clip (FOX V-neck tee 1919148300, sized up two): fitted, the hem on the shorts, while the
   FRONT reference was on the wire; wider, dropped shoulders and the hem down the shorts from the moment the
   BACK went out; fitted again when the front came back. The plain-tee front is the longest branch, so
   fitPrompt() shed its fit sentence there, while the shorter back kept "Fit: oversized ..., generously
   dropped shoulders, ... elongated hem" - the turn changed the garment's SIZE in words. Before the fix,
   47,783 of 99,911 front/back pairs in a corpus disagreed about the fit sentence or "Add nothing else".

   imageOnlyPrompt() now ships a clause BOTH angles carry only if both dispatches keep it. This suite runs the
   real engine (lib/prompts.js, the shared prompt slice) in a sandbox with the size delta as a dial:
     §1  every front/back pair carries the same fit sentence and the same "Add nothing else", or neither;
     §2  against the previous shedding (fitPrompt() over the whole part list), the only change anywhere is a
         shared clause removed - no other clause gained or lost, the closure lock (front only) untouched;
     §3  the reported product, by name;
     §4  the suite can fail: the previous shedding breaks §1 on this corpus.
   ============================================================================= */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function between(src, start, end) {
  const s = src.indexOf(start);
  if (s === -1) throw new Error(`could not find "${start}"`);
  const e = src.indexOf(end, s);
  if (e === -1) throw new Error(`could not find "${end}" after "${start}"`);
  return src.slice(s, e);
}

/* The shared prompt slice (CLAUDE.md §2.6) plus the real fit ladder, which sits after it. */
const code = between(SRC, "const P = Object.freeze({ CORE", "/* Full-Look composite clause") +
  "\n" + between(SRC, "function getFitModifier(", "\n}\n") + "\n}\n";
let DELTA = 0;
const sandbox = {
  PROMPT_MAX_CHARS: 650, console: { warn() {}, log() {} }, getSizeDelta: () => DELTA,
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" }, colorName: () => "white",
  activeColorOf: () => "#fff", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const E = new Function(...Object.keys(sandbox),
  code + "\nreturn { imageOnlyPrompt, fitPrompt, keptPromptParts, P, ADD_NOTHING_ELSE, FRONT_CLOSURE_LOCK };")(...Object.values(sandbox));
const AN = E.ADD_NOTHING_ELSE;

const fitOf = (s) => { const m = s.match(/Fit: .*?\.(?= [A-Z]|$)/); return m ? m[0] : null; };
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

/* ── the corpus ─────────────────────────────────────────────────────────────── */
const NAMES = ["Ion Crew Tee", "טישרט בייסיק צווארון V", "Oxford Button-Down Shirt", "Classic Polo", "Zip Hoodie",
  "PEAK Oversized", "חולצה מכופתרת", "Plain Tank Top", "Glide Slim Jeans", "מכנסי כדורסל", "Cargo Shorts", "Pleated Skirt", ""];
const GT = [undefined, "upper_body", "lower_body"];
const HEX = [undefined, "#ffffff", "#e8915a", "#ebe6e2", "#50392f", "#1e3a8a"];
const OCR = [undefined, "", "PEAK", "BE YOUR OWN Healer WORLDWIDE", "A".repeat(47)];
const BACK = [[undefined, undefined], [true, undefined], [false, undefined], [true, true]];
const DELTAS = [-3, -2, -1, 0, 1, 2, 3];
function* corpus() {
  for (const name of NAMES) for (const garmentType of GT) for (const colorHex of HEX) for (const textOcr of OCR) for (const [backIsPlain, lp] of BACK) {
    const it = { name, garmentType, colorHex, textOcr, backIsPlain, _backLooksPrinted: lp };
    for (const k of Object.keys(it)) if (it[k] === undefined) delete it[k];
    yield it;
  }
}

console.log("── §1 one garment through the turn: the shared clauses match on both angles ──");
let pairs = 0, asymNew = 0, asymOld = 0, changed = 0, prompts = 0, firstAsym = null, otherChange = null, closureMoved = 0, closureSeen = 0;
for (const item of corpus()) for (const d of DELTAS) {
  DELTA = d;
  const now = { front: E.imageOnlyPrompt(item, "front"), back: E.imageOnlyPrompt(item, "back") };
  const parts = { front: E.imageOnlyPrompt(item, "front", true), back: E.imageOnlyPrompt(item, "back", true) };
  const before = { front: E.fitPrompt(parts.front), back: E.fitPrompt(parts.back) };
  pairs++;
  const same = (p) => fitOf(p.front) === fitOf(p.back) && p.front.includes(AN) === p.back.includes(AN);
  if (!same(now)) { asymNew++; if (!firstAsym) firstAsym = { item, d, ...now }; }
  if (!same(before)) asymOld++;
  /* §2's measurement, on the same run: kept(now) is kept(before) minus clauses both angles carry. */
  for (const a of ["front", "back"]) {
    prompts++;
    if (now[a] !== before[a]) changed++;
    const other = a === "front" ? "back" : "front";
    const sharedTexts = new Set(parts[a].map(([, t]) => norm(t)).filter((t) => t && parts[other].some(([, u]) => norm(u) === t)));
    const keptBefore = E.keptPromptParts(parts[a]).map(([, t]) => norm(t));
    const keptNow = parts[a].map(([, t]) => norm(t)).filter((t) => t && now[a].includes(t));
    const lost = keptBefore.filter((t) => !keptNow.includes(t));
    const gained = keptNow.filter((t) => !keptBefore.includes(t));
    if ((gained.length || lost.some((t) => !sharedTexts.has(t))) && !otherChange) otherChange = { item, d, a, lost, gained };
    const lock = norm(E.FRONT_CLOSURE_LOCK);
    if (before[a].includes(lock)) closureSeen++;
    if (before[a].includes(lock) !== now[a].includes(lock)) closureMoved++;
  }
}
check(`every front/back pair carries the same fit sentence and "Add nothing else" (${pairs} pairs, ${DELTAS.length} size rungs)`,
  asymNew === 0, firstAsym && JSON.stringify(firstAsym).slice(0, 700));

console.log("\n── §2 nothing else moved ──");
check(`the only change is a shared clause removed (${changed} of ${prompts} prompts changed)`,
  !otherChange, otherChange && JSON.stringify(otherChange).slice(0, 700));
check(`the front-only closure lock ships exactly where it shipped before (${closureSeen} prompts carry it)`,
  closureMoved === 0 && closureSeen > 0, `${closureMoved} prompts moved`);
check("...and no prompt grew past the budget", (() => {
  for (const item of corpus()) for (const d of DELTAS) { DELTA = d; for (const a of ["front", "back"]) if (E.imageOnlyPrompt(item, a).length > 650) return false; }
  return true;
})());

console.log("\n── §3 the reported garment: FOX V-neck tee 1919148300, orange, plain both sides ──");
{
  const tee = { name: "טישרט בייסיק צווארון V", title: "טישרט בייסיק צווארון V", type: "shirt", category: "top",
    colorHex: "#e8915a", textOcr: "", backIsPlain: true, garmentType: "upper_body" };
  DELTA = 2;
  const f2 = E.imageOnlyPrompt(tee, "front"), b2 = E.imageOnlyPrompt(tee, "back");
  check("sized up two: the back no longer asks for an elongated hem the front does not",
    fitOf(f2) === fitOf(b2) && !/elongated hem/.test(b2), `front: ${fitOf(f2)}\n        back:  ${fitOf(b2)}`);
  check("...where the previous shedding did exactly that (the report)",
    !fitOf(E.fitPrompt(E.imageOnlyPrompt(tee, "front", true))) && /elongated hem/.test(E.fitPrompt(E.imageOnlyPrompt(tee, "back", true))));
  for (const d of [0, 1]) {
    DELTA = d;
    const f = E.imageOnlyPrompt(tee, "front"), b = E.imageOnlyPrompt(tee, "back");
    check(`${d === 0 ? "true to size" : "one up"}: the same size sentence on both angles, as before`,
      fitOf(f) && fitOf(f) === fitOf(b) && f === E.fitPrompt(E.imageOnlyPrompt(tee, "front", true)) &&
      b === E.fitPrompt(E.imageOnlyPrompt(tee, "back", true)), `front: ${fitOf(f)}\n        back:  ${fitOf(b)}`);
  }
  DELTA = 0;
}

console.log("\n── §4 the suite can fail ──");
check(`the previous shedding breaks §1 on this corpus (${asymOld} of ${pairs} pairs disagreed)`, asymOld > 1000);

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
