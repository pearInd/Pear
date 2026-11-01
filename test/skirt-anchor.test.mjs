/* THE SKIRT (2026-11-01, TEST requests only until measured - lib/prompts.js SKIRT_CATEGORY_ANCHOR, CLAUDE.md §7.20).
   The matrix's maxi skirt (FOX 2501940200) rendered as wide-leg trousers: every lower-body garment shipped "the EXACT static
   pants/shorts" and a fit to the "leg profile". §1 a TEST request names the skirt on every angle; §2 it differs from a
   shopper's request by exactly those two words, and a shopper's request is untouched; §3 the selector is positive evidence
   only - a garment with legs keeps the pants/shorts anchor; §4 the selection is still one frozen anchor per prompt. */
import * as P from "../lib/prompts.js";
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const ask = (item, angle, test, delta = 0) =>
  P.promptForRequest(P.sanitizePromptRequest({ kind: "single", item, angle, delta, ...(test ? { test: true } : {}) }));
const SKIRT = { name: "חצאית מקסי", title: "חצאית מקסי", __bottoms: true };
const SKIRT_PLAIN = { ...SKIRT, colorHex: "#000000", textOcr: "", backIsPlain: true };
const TROUSER_WORDS = /pants|shorts|trouser|leg profile|\blegs?\b/i;

console.log("\n── §1 a TEST skirt is named a skirt, front and back ──");
{
  const front = ask(SKIRT, "front", true), back = ask(SKIRT, "back", true), plain = ask(SKIRT_PLAIN, "back", true);
  check("§1.1 front: the EXACT static skirt, fitted to the hips", /^Drape and fit the EXACT static skirt from the reference image/.test(front) && /waistline, hips, depth/.test(front), front);
  check("§1.2 back: the skirt's rear panel as shown", /^Drape and fit the EXACT static skirt's REAR\/BACK side/.test(back) && /Reproduce the rear panel exactly as shown/.test(back), back);
  check("§1.3 a plain rear: the skirt's smooth rear panel", /^Drape and fit the EXACT static skirt's REAR\/BACK side/.test(plain) && /The rear panel is smooth unbroken fabric\./.test(plain), plain);
  const anchors = [front, back, plain].map((p) => p.split(" Fit: ")[0]);
  check("§1.4 no anchor carries a trouser word (the fit sentence is the size ladder's, unchanged - the next suspect, not this change)",
    anchors.every((a) => !TROUSER_WORDS.test(a)), anchors.filter((a) => TROUSER_WORDS.test(a)).join(" | "));
  check("§1.5 every size on a TEST skirt names the skirt and stays inside the budget",
    [-2, -1, 0, 1, 2].every((d) => ["front", "back"].every((a) => { const p = ask(SKIRT_PLAIN, a, true, d); return /static skirt/.test(p) && p.length <= 650; })));
}

console.log("\n── §2 the only difference is the two words; a shopper's skirt is untouched ──");
{
  const pairs = [["front", SKIRT], ["back", SKIRT], ["back", SKIRT_PLAIN], ["front", SKIRT_PLAIN]];
  const bad = [];
  for (const [angle, item] of pairs) for (const d of [-2, 0, 2]) {
    const shop = ask(item, angle, false, d), test = ask(item, angle, true, d);
    const expect = shop.replace("pants/shorts REAR/BACK side", "skirt's REAR/BACK side").replace("pants/shorts from", "skirt from")
      .replace("leg profile", "hips");
    if (test !== expect) bad.push(`${angle} ${d}: ${test}`);
  }
  check("§2.1 a TEST skirt prompt is the shopper's with the noun and 'leg profile' replaced - nothing else moves", bad.length === 0, bad.join("\n        "));
  check("§2.2 a shopper's skirt still ships the pants/shorts anchor (measure first - CLAUDE.md §7.1; prompt-engine §1 pins the bytes)",
    ask(SKIRT, "front", false).startsWith("Drape and fit the EXACT static pants/shorts from") &&
    ask(SKIRT_PLAIN, "back", false).startsWith("Drape and fit the EXACT static pants/shorts REAR/BACK side"));
  const before = ask(SKIRT, "front", true); ask(SKIRT, "front", false);
  check("§2.3 the request state resets: a shopper request after a TEST one is the shopper's", !/static skirt/.test(ask(SKIRT, "front", false)) && /static skirt/.test(before));
  const a = SRC.slice(SRC.indexOf("const SKIRT_CATEGORY_ANCHOR"), SRC.indexOf("const SKIRT_PLAIN_BACK_ANCHOR"));
  check("§2.4 each skirt anchor is shorter than the anchor it replaces",
    ask(SKIRT, "front", true).length < ask(SKIRT, "front", false).length && ask(SKIRT_PLAIN, "back", true).length < ask(SKIRT_PLAIN, "back", false).length &&
    ask(SKIRT, "back", true).length < ask(SKIRT, "back", false).length && a.length > 0);
}

console.log("\n── §3 positive evidence only ──");
{
  const isSkirt = (item) => /static skirt/.test(ask(item, "front", true));
  const yes = [{ title: "Denim skirt", __bottoms: true }, { name: "Pleated Midi Skirt", __bottoms: true }, { title: "חצאית ג'ינס", __bottoms: true },
    { category: "skirts", __bottoms: true }, { type: "skirt", __bottoms: true }];
  const no = [{ title: "מכנסי חצאית", __bottoms: true }, { title: "skirt shorts", __bottoms: true }, { title: "Tennis skort", __bottoms: true },
    { title: "culottes skirt", __bottoms: true }, { title: "Chino pants", __bottoms: true }, { title: "CHICAGO shorts", __bottoms: true },
    { title: "Top & skirt set", __bottoms: false }, { title: "skirt", __bottoms: false }, {}];
  check("§3.1 a skirt by name, title, category or type - English or Hebrew", yes.every(isSkirt), JSON.stringify(yes.filter((i) => !isSkirt(i))));
  check("§3.2 culottes, a skort, 'skirt shorts', pants, shorts, a top, an unknown garment keep their anchor", no.every((i) => !isSkirt(i)),
    JSON.stringify(no.filter(isSkirt)));
  check("§3.3 pants and shorts on a TEST request are the shopper's prompt (nothing but the skirt moves)",
    ["front", "back"].every((a) => [{ title: "Chino pants", __bottoms: true }, { title: "CHICAGO shorts", __bottoms: true, backIsPlain: true }]
      .every((i) => ask(i, a, true) === ask(i, a, false))));
}

console.log("\n── §4 still one frozen anchor per prompt ──");
{
  const fn = SRC.slice(SRC.indexOf("function imageOnlyPrompt("), SRC.indexOf("const LOOK_ANCHOR"));
  check("§4.1 the skirt is a TEST request's selector (typeof-guarded request state)",
    /const skirt = typeof _requestTest !== "undefined" && _requestTest === true && isSkirtGarment\(item\);/.test(fn));
  check("§4.2 ...between frozen literals: the angle and the skirt SELECT, nothing is appended",
    /\? \(skirt \? \(plainBack \? SKIRT_PLAIN_BACK_ANCHOR : SKIRT_BACK_ANCHOR\) : \(plainBack \? PLAIN_BACK_ANCHOR : BACK_CATEGORY_ANCHOR\)\)\s*\n\s*: skirt \? SKIRT_CATEGORY_ANCHOR : CATEGORY_ANCHOR;/.test(fn));
  check("§4.3 the three skirt anchors are frozen", ["SKIRT_CATEGORY_ANCHOR", "SKIRT_BACK_ANCHOR", "SKIRT_PLAIN_BACK_ANCHOR"]
    .every((n) => new RegExp(`const ${n} = Object\\.freeze\\(\\{`).test(SRC)));
}

console.log(fails === 0 ? "\nskirt-anchor: OK" : `\nskirt-anchor: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
