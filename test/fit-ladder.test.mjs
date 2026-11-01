/* THE SIZE ALWAYS REACHES THE WIRE (2026-11-01, TEST requests only until measured - lib/prompts.js, CLAUDE.md §7.17).
   The fit sentence (P.MED) is the first part fitPrompt() sheds; on the FRONT of a top it no longer fit - sizing down on any
   top shipped no size at all, a closure top or a coat lost +2 as well, and with colour facts a closure top lost every rung.
   A compact form (~40 chars) is tried before the sentence is shed. §1 every rung of every garment carries a size on a TEST
   request; §2 the compact form only fills the gap - a shopper's request is untouched, and a TEST request differs from it only
   by that sentence; §3 the compact wording keeps tightness on the garment (CLAUDE.md §2.4); §4 the mechanism. */
import * as P from "../lib/prompts.js";
import { readFileSync } from "node:fs";
const SRC = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const ITEMS = {
  "plain tee": { name: "Basic tee", title: "basic cotton t-shirt", category: "top", garmentType: "upper_body", __bottoms: false, backIsPlain: true },
  "printed tee": { name: "PEAK tee", title: "PEAK oversized tee", category: "top", garmentType: "upper_body", __bottoms: false },
  "button shirt": { name: "Oxford shirt", title: "button down oxford shirt", category: "top", garmentType: "upper_body", __bottoms: false },
  "zip jacket": { name: "Zip jacket", title: "zip up jacket", category: "top", garmentType: "upper_body", __bottoms: false },
  "coat": { name: "Wool coat", title: "long wool coat with buttons", category: "top", garmentType: "upper_body", __bottoms: false },
  "dress": { name: "Midi dress", title: "summer midi dress", category: "dress", garmentType: "upper_body", __bottoms: false },
  "pants": { name: "Chino pants", title: "chino pants", category: "bottom", garmentType: "lower_body", __bottoms: true },
  "shorts": { name: "CHICAGO shorts", title: "basketball shorts", category: "bottom", garmentType: "lower_body", __bottoms: true },
};
const FACTS = { colorHex: "#111111", textOcr: "BE YOUR OWN Healer WORLDWIDE" };
const ask = (item, angle, delta, test) => P.promptForRequest(P.sanitizePromptRequest({ kind: "single", item, angle, delta, ...(test ? { test: true } : {}) }));
const DELTAS = [-2, -1, 0, 1, 2];

console.log("\n── §1 every rung carries its size on a TEST request ──");
{
  const missing = [];
  let rungs = 0, shopperShed = 0;
  for (const [label, base] of Object.entries(ITEMS)) for (const facts of [false, true]) for (const angle of ["front", "back"]) for (const d of DELTAS) {
    const item = facts ? { ...base, ...FACTS } : base;
    rungs++;
    if (!/ Fit: [^.]+\.$/.test(ask(item, angle, d, true))) missing.push(`${label}${facts ? "+facts" : ""} ${angle} ${d}`);
    if (!/Fit: /.test(ask(item, angle, d, false))) shopperShed++;
  }
  check(`§1.1 all ${rungs} rungs (8 garments x facts x front/back x 5 sizes) end with a size sentence`, missing.length === 0, missing.join(", "));
  check(`§1.2 ...where a shopper's request still sheds it on ${shopperShed} of them (the gap this closes, unchanged until measured)`, shopperShed > 0);
  const p = ask(ITEMS["printed tee"], "front", -1, true);
  check("§1.3 the reported case: a printed tee one size down, front - the size is there, compact", /Fit: snug garment, fabric slightly taut\.$/.test(p), p);
  check("§1.4 every prompt stays inside the budget", Object.values(ITEMS).every((it) => DELTAS.every((d) => ["front", "back"].every((a) =>
    ask({ ...it, ...FACTS }, a, d, true).length <= 650))));
}

console.log("\n── §2 the compact form only fills the gap ──");
{
  let same = 0, filled = 0;
  const other = [];
  for (const [label, item] of Object.entries(ITEMS)) for (const angle of ["front", "back"]) for (const d of DELTAS) {
    const shopper = ask(item, angle, d, false), test = ask(item, angle, d, true);   // no colour: the dark-brown naming cannot differ
    if (test === shopper) { same++; continue; }
    if (/Fit: /.test(shopper) === false && test.startsWith(shopper + " Fit: ") && test.length - shopper.length < 50) { filled++; continue; }
    other.push(`${label} ${angle} ${d}`);
  }
  check(`§2.1 without colour facts a TEST prompt is the shopper's (${same}) or the shopper's plus the compact size alone (${filled}) - nothing else moves`,
    other.length === 0 && filled > 0, other.join(", "));
  check("§2.2 a rung whose full sentence fits keeps it, word for word", ask(ITEMS["printed tee"], "front", 0, true) === ask(ITEMS["printed tee"], "front", 0, false));
}

console.log("\n── §3 the compact wording keeps tightness on the garment (§2.4) ──");
{
  const block = SRC.slice(SRC.indexOf("function getCompactFitModifier("), SRC.indexOf("function compactFitSentence("));
  const phrases = [...block.matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
  check("§3.1 ten phrasings, five per garment type", phrases.length === 10, phrases.join(" | "));
  check("§3.2 each names the garment (or trousers), never the body's outline",
    phrases.every((t) => /garment|trousers/.test(t) && !/silhouette|slim|thin|outline|figure|waistline|body/i.test(t)), phrases.join(" | "));
  check("§3.3 each is short enough to fit where the full sentence did not (<= 41 chars with its 'Fit: ...' frame - a long print on a closure top leaves 43)",
    phrases.every((t) => `Fit: ${t}.`.length <= 41), phrases.map((t) => `Fit: ${t}.`.length).join(","));
}

console.log("\n── §4 the mechanism ──");
{
  const fp = SRC.slice(SRC.indexOf("function fitPrompt(parts"), SRC.indexOf("\n}\n", SRC.indexOf("function fitPrompt(parts")));
  check("§4.1 fitPrompt tries a part's compact third element once, before shedding it", /const compact = keep\[at\]\[2\];/.test(fp) && /keep\.splice\(at, 1\);/.test(fp));
  check("§4.2 only a TEST request carries the compact form (typeof-guarded request state)",
    /\.\.\.\(typeof _requestTest !== "undefined" && _requestTest === true \? \[compactFitSentence\(/.test(SRC));
  check("§4.3 the request state resets - a shopper request after a TEST one sheds as before",
    (() => { ask(ITEMS["printed tee"], "front", -1, true); return !/Fit: /.test(ask(ITEMS["printed tee"], "front", -1, false)); })());
}

console.log(fails === 0 ? "\nfit-ladder: OK" : `\nfit-ladder: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
