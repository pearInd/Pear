/* THE GARMENT KIND (2026-11-07, CLAUDE.md §7.23) - a skirt and a dress get their own wording, and a dress its whole photos,
   on a TEST request / TEST session until the shipped build is measured on the real engine.
   §1 the two copies of the kind block (lib/prompts.js, fitting-room/app.js) are byte-identical and answer alike
   §2 the detector over a corpus: every kind, English and Hebrew, compounds, adjectives, sets, look-alikes, empty
   §3 the wire: what a TEST request gets, and that a shopper's request is untouched
   §4 the room: a dress's photos go whole on a TEST session only
   §5 mutations: each rule broken in a copy - every one must fail a check above */
import * as P from "../lib/prompts.js";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url);
const PROMPTS = readFileSync(new URL("lib/prompts.js", ROOT), "utf8");
const APP = readFileSync(new URL("fitting-room/app.js", ROOT), "utf8");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 600)}`);
}
const BEGIN = "/* @pear-shared:garment-kind BEGIN", END = "/* @pear-shared:garment-kind END */";
const blockOf = (src) => { const a = src.indexOf(BEGIN), b = src.indexOf(END); return a >= 0 && b > a ? src.slice(a, b + END.length) : ""; };
const load = (block) => new Function(block + "\nreturn garmentKindOf;")();

/* [title, expected] - the corpus §2 runs and §5's mutants must fail on. */
const CORPUS = [
  // dresses - Hebrew: stem forms, construct, prefixes, the three apostrophe spellings of ג'ינס
  ["שמלה", "dress"], ["שמלת מקסי", "dress"], ["שמלות קיץ", "dress"], ["השמלה הכחולה", "dress"], ["ושמלה", "dress"],
  ["שמלת חולצה", "dress"], ["שמלת טישרט אוברסייז", "dress"], ["שמלת ג'ינס", "dress"], ["שמלת ג׳ינס", "dress"], ["שמלת ג’ינס", "dress"],
  // dresses - English: head noun, compounds, plurals, case
  ["Maxi Dress Baby Blue", "dress"], ["MIDI DRESS", "dress"], ["Dresses", "dress"], ["Shirt Dress", "dress"], ["T-Shirt Dress", "dress"],
  ["Sundress", "dress"], ["Mini-Dress", "dress"], ["Slip dress in satin", "dress"], ["Denim Dress", "dress"], ["Sweater dress", "dress"],
  // skirts
  ["חצאית", "skirt"], ["חצאית מקסי סריג - FOX", "skirt"], ["חצאיות", "skirt"], ["חצאית ג'ינס", "skirt"], ["חצאית מכנס", "skirt"],
  ["Pencil Skirt", "skirt"], ["Denim Skirt", "skirt"], ["Jeans Skirt", "skirt"], ["Miniskirt", "skirt"], ["Pleated midi skirts", "skirt"],
  // English adjective "dress"
  ["Dress Shirt", null], ["Dress Pants", null], ["Dress Shoes", null], ["dress trousers", null],
  // two garments, sets
  ["Top and Skirt", null], ["Dress and Cardigan", null], ["Dress & Cardigan", null], ["Tennis Skirt with Shorts", null],
  ["חצאית וחולצה", null], ["שמלה עם ז'קט", null], ["מכנסי חצאית", null], ["Dress Set", null], ["Skirt Suit", null], ["Co-ord Skirt", null],
  ["Two Piece Dress", null], ["two-piece dress", null], ["סט חצאית וחולצה", null], ["חליפת ספורט", null], ["Shirt dress and skirt", null],
  // look-alikes: Hebrew inside other words, English inside other words
  ["חולצה כחול חשמל", null], ["קולקציה מחשמלת", null], ["שני חצאים", null], ["Address", null], ["Dressing Gown", null], ["Skort", null],
  // other garments, nothing, noise
  ["Jumpsuit", null], ["Overalls", null], ["PEAK", null], ["חולצת פולו", null], ["מכנס קצר רגל - FOX", null], ["", null], ["   ", null],
];

console.log("\n── §1 two copies, one detector ──");
const fromPrompts = blockOf(PROMPTS), fromApp = blockOf(APP);
check("§1.1 the block is in both files", fromPrompts.length > 2000 && fromApp.length > 2000);
check("§1.2 ...byte for byte", fromPrompts === fromApp, "edit both copies together (CLAUDE.md §3)");
const kindPrompts = load(fromPrompts), kindApp = load(fromApp);
check("§1.3 ...and runs alone (self-contained, CLAUDE.md §2.6) and answers like the exported one on the whole corpus",
  CORPUS.every(([t]) => kindPrompts({ name: t }) === P.garmentKindOf({ name: t }) && kindApp({ name: t }) === kindPrompts({ name: t })));

console.log("\n── §2 the detector ──");
function corpusMisses(fn) {
  return CORPUS.filter(([t, want]) => { try { return fn({ name: t }) !== want; } catch (_) { return true; } })
    .map(([t, want]) => `${JSON.stringify(t)} -> ${(() => { try { return fn({ name: t }); } catch (e) { return "throws"; } })()} (want ${want})`);
}
{
  const miss = corpusMisses(P.garmentKindOf);
  check(`§2.1 ${CORPUS.length} titles, each read as expected`, miss.length === 0, miss.join("; "));
  check("§2.2 the title is read from name and title alike", P.garmentKindOf({ title: "Maxi dress" }) === "dress" && P.garmentKindOf({ name: "x", title: "חצאית" }) === "skirt");
  check("§2.3 an explicit type decides only when the title names no garment",
    P.garmentKindOf({ name: "Summer", type: "dress" }) === "dress" && P.garmentKindOf({ name: "Summer", category: "Skirts" }) === "skirt" &&
    P.garmentKindOf({ name: "Linen shirt", type: "dress" }) === null && P.garmentKindOf({ name: "Summer", type: "dress", category: "skirt" }) === null);
  check("§2.4 the room's own type markers never make a kind (every widget item is typed shirt/pants)",
    P.garmentKindOf({ name: "Summer", type: "shirt" }) === null && P.garmentKindOf({ name: "Summer", type: "pants" }) === null);
  check("§2.5 nothing in, nothing out - never a throw", P.garmentKindOf(null) === null && P.garmentKindOf(undefined) === null && P.garmentKindOf({}) === null &&
    P.garmentKindOf({ name: 42, title: null }) === null);
}

console.log("\n── §3 the wire ──");
const ask = (item, angle, delta, test) => P.promptForRequest(P.sanitizePromptRequest({ kind: "single", item, angle, delta, ...(test ? { test: true } : {}) }));
const SKIRT = { name: "חצאית מקסי סריג", title: "חצאית מקסי סריג", __bottoms: true, backIsPlain: true, colorHex: "#000000" };
const DRESS = { name: "So Far So Good Maxi Dress Baby Blue", __bottoms: false, backIsPlain: true };
const DELTAS = [-2, -1, 0, 1, 2];
const TROUSER = /\b(pants|shorts|trousers?|leg profile|inseam|ankle|wide-leg)\b/i;
{
  /* What rig session s2 sent the engine (2026-11-07) - the wording under which the FOX maxi skirt rendered as a skirt. */
  const MEASURED_FRONT = "Drape and fit the EXACT static skirt from the reference image onto the live subject's CURRENT lower-body contour and volume in this frame. The skirt is one continuous closed tube of fabric from the waistband to the hem, falling as a single column around both legs together, its hem at the reference's length. Dynamically adapt the drape to the subject's waistline, hips, depth, and angle without distorting the garment design. Strictly preserve original pattern and color. Fabric: black. Fit: true-to-size, the fabric skims the hips and falls straight to the hem.";
  const MEASURED_BACK = "Drape and fit the EXACT static skirt's REAR/BACK side from the reference image onto the live subject's CURRENT lower-body contour and volume in this frame. The rear panel is smooth unbroken fabric, one continuous column from the waistband to the hem around both legs together. Dynamically adapt the drape to the subject's waistline, hips, depth, and angle without distorting the garment design. Strictly preserve original pattern and color. Fabric: black. Fit: true-to-size, the fabric skims the hips and falls straight to the hem.";
  check("§3.1 a TEST skirt's front and plain back are what was measured (rig s2), byte for byte",
    ask(SKIRT, "front", 0, true) === MEASURED_FRONT && ask(SKIRT, "back", 0, true) === MEASURED_BACK, ask(SKIRT, "front", 0, true));
  const skirtAll = DELTAS.flatMap((d) => ["front", "back"].map((a) => ask(SKIRT, a, d, true)));
  check("§3.2 ...and no TEST skirt prompt carries a trouser word, on any size rung", skirtAll.every((p) => !TROUSER.test(p)), skirtAll.find((p) => TROUSER.test(p)));
  check("§3.3 a printed-back skirt names no plain fabric", !/smooth unbroken/.test(ask({ ...SKIRT, backIsPlain: false }, "back", 0, true)) &&
    /Reproduce the rear panel exactly as shown/.test(ask({ ...SKIRT, backIsPlain: false }, "back", 0, true)));
  const dressFront = ask(DRESS, "front", 0, true), dressBack = ask(DRESS, "back", 0, true);
  check("§3.4 a TEST dress gets the dress anchor, front and back - not the top's \"keep the lower body unmodified\"",
    dressFront.startsWith("Drape and fit the EXACT static dress from") && dressBack.startsWith("Drape and fit the EXACT static dress's REAR/BACK") &&
    !/lower body/.test(dressFront + dressBack), dressFront);
  check("§3.5 ...with the upper-body fit sentence, as measured (d1)", /Fit: perfectly tailored true-to-size fit, flawless natural drape with no excess fabric\.$/.test(dressFront));
  check("§3.6 a denim dress the region calls a bottom (\"שמלת ג'ינס\") is still a dress on TEST",
    ask({ name: "שמלת ג'ינס", __bottoms: true }, "front", 0, true).startsWith("Drape and fit the EXACT static dress from"));
  check("§3.7 a skirt the region calls a top keeps the region's anchor (the kind narrows, never moves a region)",
    ask({ name: "Pencil skirt", __bottoms: false }, "front", 0, true) === ask({ name: "Pencil skirt", __bottoms: false }, "front", 0, false));
  /* The shopper's wire: for each kinded item, a shopper request equals the same request with the title's kind word removed. */
  const shopperSame = [SKIRT, DRESS, { name: "שמלת ג'ינס", __bottoms: true }].every((it) =>
    DELTAS.every((d) => ["front", "back"].every((a) => ask(it, a, d, false) === ask({ ...it, name: "Garment", title: undefined }, a, d, false))));
  check("§3.8 a SHOPPER's request never reads the kind - byte-identical to the same garment with no kind word", shopperSame);
  const all = [SKIRT, DRESS, { ...DRESS, name: "Button front midi dress", textOcr: "BE YOUR OWN Healer WORLDWIDE", colorHex: "#ffffff" }]
    .flatMap((it) => DELTAS.flatMap((d) => ["front", "back"].map((a) => ask(it, a, d, true))));
  check("§3.9 every TEST kind prompt stays inside the 650-char budget", all.every((p) => p.length <= 650), Math.max(...all.map((p) => p.length)));
  const shirtDress = { ...DRESS, name: "Button front midi dress", colorHex: "#ffffff" };
  check("§3.10 a shirt dress carries the closure lock on every rung (a colour fact, no print)",
    DELTAS.every((d) => /fastened/.test(ask(shirtDress, "front", d, true))));
  /* THE KNOWN LIMIT, pinned so a change to it is seen: the dress anchor is ~100 chars longer than the top's, so with a long
     print (28 chars) at -2 the closure lock no longer fits either. The order is still the rule's - the fit clause first, both
     on the record (CLAUDE.md §0). Recorded in CLAUDE.md §7.23; not reworded unmeasured. */
  const shed = P.promptWithShedForRequest(P.sanitizePromptRequest({ item: { ...shirtDress, textOcr: "BE YOUR OWN Healer WORLDWIDE" }, angle: "front", delta: -2, test: true }));
  check("§3.11 the worst case (long print, -2) sheds the fit clause FIRST, then the closure lock - both logged, never silent",
    shed.shedLog.map((e) => e.clause).join(",") === "fit,closure" && !/fastened|Fit: /.test(shed.prompt), JSON.stringify(shed.shedLog));
}

console.log("\n── §4 the room: a dress's photos go whole on a TEST session ──");
const hintSrc = APP.slice(APP.indexOf("function referenceBackHint(url) {"), APP.indexOf("/** The server's band for this rear photo"));
function room(item, test, src = hintSrc) {
  const notes = [];
  const env = {
    location: { search: test ? "?pear_key=TEST" : "" },
    traceEnabled: () => test, resolveLook: () => null, activeItem: item,
    distinctBackOf: (it) => it.imgBack, galleryOf: (it) => ({ front: it.img }), sameImage: (a, b) => a === b,
    isBottomsGarment: (it) => !!it.__bottoms, garmentKindOf: kindApp, refMaskNote: (o) => notes.push(o),
  };
  const fn = new Function(...Object.keys(env), src + "\nreturn { referenceBackHint, referenceFrontHint };")(...Object.values(env));
  return { back: fn.referenceBackHint(item.imgBack), front: fn.referenceFrontHint(item.img), notes };
}
{
  const dress = { name: "Maxi Dress", img: "https://cdn/x/front.jpg", imgBack: "https://cdn/x/back.jpg", __bottoms: false };
  const tee = { name: "PEAK tee", img: "https://cdn/t/front.jpg", imgBack: "https://cdn/t/back.jpg", __bottoms: false };
  const denim = { name: "שמלת ג'ינס", img: "https://cdn/d/front.jpg", imgBack: "https://cdn/d/back.jpg", __bottoms: true };
  const t = room(dress, true), s = room(dress, false);
  check("§4.1 TEST: a dress's rear and front photos get no band (sent whole), and the record says why",
    t.back === null && t.front === null && t.notes.some((n) => n.why === "dress") && t.notes.some((n) => n.why === "dress" && n.side === "front"), JSON.stringify(t));
  check("§4.2 a shopper's session masks a dress exactly as before (region top, front and back)",
    s.back && s.back.region === "top" && s.front && s.front.region === "top" && s.front.side === "front" && s.notes.length === 0, JSON.stringify(s));
  const tt = room(tee, true);
  check("§4.3 a tee is masked as before on a TEST session too", tt.back && tt.back.region === "top" && tt.front && tt.front.side === "front");
  check("§4.4 a denim dress (a bottom by region) goes whole on TEST, where its rear band would have painted the bodice out",
    room(denim, true).back === null && room(denim, false).back.region === "bottom");
}

console.log("\n── §5 mutations: every rule must be load-bearing ──");
{
  const M = [
    ["the English adjective rule (\"dress shirt\" read as a dress)", (b) => b.replace("tag[i] === \"dress\" && en(words[i]) && i + 1 < words.length && R.enAfterDress.test(words[i + 1])", "false")],
    ["the Hebrew word start (חשמל read as a dress)", (b) => b.replace("heDress: /^[והבלמשכ]?שמל", "heDress: /שמל")],
    ["the set rule", (b) => b.replace("if (R.setPhrase.test(text) || words.some((w) => R.enSet.test(w) || R.heSet.test(w))) return null;", "")],
    ["the second-garment rule", (b) => b.replace("if (tag.includes(\"noun\")) return null;", "")],
    ["the English modifier rule (\"shirt dress\" abstains)", (b) => b.replace("if (en(words[i]) && i > 0 && tag[i - 1] === \"noun\" && en(words[i - 1])) tag[i - 1] = \"\";", "")],
    ["the Hebrew construct rule (\"שמלת חולצה\" abstains)", (b) => b.replace("if (!en(words[i]) && /ת$/.test(words[i]) && i + 1 < words.length && tag[i + 1] === \"noun\" && R.heNounBare.test(words[i + 1])) tag[i + 1] = \"\";", "")],
    ["the bare-noun guard (\"חצאית וחולצה\" read as a skirt)", (b) => b.replace("R.heNounBare.test(words[i + 1])", "R.heNoun.test(words[i + 1])")],
    ["the skirt's endings (חצאים read as a skirt)", (b) => b.replace("heSkirt: /^[והבלמשכ]?חצאי(?:ת|ות)/", "heSkirt: /^[והבלמשכ]?חצאי/")],
  ];
  for (const [label, mutate] of M) {
    const mutated = mutate(fromPrompts);
    if (mutated === fromPrompts) { check(`§5 mutant applies: ${label}`, false, "the replacement found nothing - the rule moved"); continue; }
    let fn; try { fn = load(mutated); } catch (e) { check(`§5 mutant loads: ${label}`, false, e.message); continue; }
    check(`§5 caught by §2.1: ${label}`, corpusMisses(fn).length > 0);
  }
  /* Two mutants of the engine, loaded from a temporary copy of lib/prompts.js. */
  const dir = mkdtempSync(join(tmpdir(), "pear-kind-"));
  const cfg = new URL("fitting-room/config.js", ROOT).href;
  async function engineMutant(label, mutate, caught) {
    const src = mutate(PROMPTS);
    if (src === PROMPTS) { check(`§5 engine mutant applies: ${label}`, false); return; }
    const file = join(dir, `m${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, src.replace('from "../fitting-room/config.js"', `from ${JSON.stringify(cfg)}`));
    const m = await import(pathToFileURL(file).href);
    const askM = (item, angle, delta, test) => m.promptForRequest(m.sanitizePromptRequest({ kind: "single", item, angle, delta, ...(test ? { test: true } : {}) }));
    check(`§5 caught: ${label}`, caught(askM));
  }
  await engineMutant("the TEST gate removed (a shopper gets the kind's wording)",
    (s) => s.replace('const kind = typeof _requestTest !== "undefined" && _requestTest === true && typeof garmentKindOf === "function"', 'const kind = typeof garmentKindOf === "function"'),
    (askM) => askM(SKIRT, "front", 0, false) !== askM({ ...SKIRT, name: "Garment", title: undefined }, "front", 0, false));
  await engineMutant("the skirt's rung back on the trouser ladder",
    (s) => s.replace('const fitType = dress ? "upper_body" : skirt ? "skirt" : bottoms ? "lower_body" : "upper_body";', 'const fitType = dress ? "upper_body" : bottoms ? "lower_body" : "upper_body";'),
    (askM) => DELTAS.some((d) => TROUSER.test(askM(SKIRT, "front", d, true))));
  rmSync(dir, { recursive: true, force: true });
  const roomMutant = hintSrc.replace(/typeof traceEnabled === "function" && traceEnabled\(\) && /g, "");
  check("§5 caught: the room's TEST gate removed (a shopper's dress sent whole)", roomMutant !== hintSrc && room({ name: "Maxi Dress", img: "f", imgBack: "b" }, false, roomMutant).back === null);
}

console.log(fails === 0 ? "\ngarment-kind: OK" : `\ngarment-kind: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
