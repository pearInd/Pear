/* THE PROMPT ENGINE, SERVER-SIDE - "it moved out of the browser; did the wire change?"
   ─────────────────────────────────────────────────────────────────────────────
   On 2026-09-26 every prompt word moved from fitting-room/app.js to lib/prompts.js
   (POST /api/prompt; CLAUDE.md §2.13). The browser now sends a garment's plain facts,
   the angle, the pose and the size delta, and receives the one clamped string a dispatch
   needs. The move was proven exact at the time over 351,779 prompts. This suite keeps
   that conclusion and the seams that make it hold:

     §1  THE WIRE IS PINNED. A corpus of garments × angles × poses × size deltas is run
         through the REAL browser path (promptFactsOf() from app.js -> JSON ->
         sanitizePromptRequest() -> promptForRequest()) and hashed. PINNED was computed
         from the PRE-MOVE in-browser engine over this exact corpus. A red run means some
         prompt changed; if intended, re-pin with `--print` in the same commit and say which
         branch moved (trace:prompt shows it). If not, it is a regression.
     §2  ONE CLASSIFIER, TWO COPIES, NEVER TWO ANSWERS. isBottomsGarment() stays in the
         browser (the size chart and go-live read it synchronously) and the server keeps a
         copy for callers that send no verdict. The browser's verdict must win, and the two
         bodies must stay textually identical (CLAUDE.md §3).
     §3  THE FACTS LIST IS ONE LIST. promptFactsOf() in app.js and sanitizePromptRequest()
         in lib/prompts.js must name the same fields - a field one side drops is a field the
         engine silently stops seeing.
     §4  THE SANITISER. The body is shopper-controlled.
     §5  THE BROWSER CARRIES NO PROMPT WORDING. Stated as an absence over app.js's code.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PINNED = "221a5b5835f450b0c12fe8d3037456af0ea1b62b1155c26476e97b24519d912c";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LIB_SRC = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LIB = await import("../lib/prompts.js");

function between(src, start, end) {
  const s = src.indexOf(start);
  if (s === -1) throw new Error(`could not find "${start}"`);
  const e = src.indexOf(end, s);
  if (e === -1) throw new Error(`could not find "${end}" after "${start}"`);
  return src.slice(s, e);
}

/* The browser's own classifier and facts function, executed for real. */
const CLIENT = new Function(
  between(APP, "const BOTTOMS_TOKENS =", "/* The garment facts the prompt engine reads") +
  between(APP, "const PROMPT_FACT_STRINGS = [", "\n/* Wire prompts by request") +
  "\nreturn { isBottomsGarment, promptFactsOf, PROMPT_FACT_STRINGS, PROMPT_FACT_BOOLS };")();

/* ── §1 the corpus ────────────────────────────────────────────────────────────── */
const catSrc = between(APP, "const PEAR_CATALOG = [", "\n];") + "\n];";
const PEAR_CATALOG = new Function(catSrc + "\nreturn PEAR_CATALOG;")();
const NAMES = ["Ion Crew Tee", "Oxford Button-Down Shirt", "Classic Polo", "Zip Hoodie", "Denim Jacket",
  "Glide Slim Jeans", "Cargo Shorts", "Pleated Skirt", "Wide Leg Trouser", "Midi Dress", "חולצת טי בסיסית",
  "ג'ינס סקיני", "חולצה מכופתרת", "Henley Longsleeve", "Plain Tank Top", "Crew Neck T-Shirt", "Joggers",
  "Overalls", "STRAIGHT BASIC", ""];
const GT = [undefined, "upper_body", "lower_body"];
const HEX = [undefined, "#ffffff", "#000000", "#1e3a8a", "#c0392b", "not-a-hex"];
const OCR = [undefined, "BE YOUR OWN Healer WORLDWIDE", "שלום עולם", "A".repeat(80)];
const BACK = [[undefined, undefined], [true, undefined], [false, undefined], [true, true]];
const TYPES = [undefined, "shirt", "pants", "tops", "jacket"];
const SUBTYPES = [undefined, "short_sleeve", "long_sleeve", "sleeveless", "slim"];
const FABRIC = [undefined, "cotton", "denim", "dry_fit"];

function* items() {
  for (const c of PEAR_CATALOG) yield c;
  let n = 0;
  for (const name of NAMES) for (const gt of GT) for (const hex of HEX) for (const ocr of OCR) for (const [bp, lp] of BACK) {
    n++;
    const it = { name, garmentType: gt, colorHex: hex, textOcr: ocr, backIsPlain: bp, _backLooksPrinted: lp,
                 type: TYPES[n % TYPES.length], subType: SUBTYPES[(n >> 1) % SUBTYPES.length],
                 fabric: FABRIC[(n >> 2) % FABRIC.length], custom: n % 11 === 0,
                 ...(n % 3 === 0 ? { title: name + " - store title" } : {}),
                 ...(n % 5 === 0 ? { category: ["pants", "tops", "shirts", "skirts"][n % 4] } : {}),
                 ...(n % 2 ? { description: "noise", price: 99, img: "https://cdn.test/a.jpg" } : {}) };
    for (const k of Object.keys(it)) if (it[k] === undefined) delete it[k];
    yield it;
  }
}

/* ── PROMPT UNDER TEST: the browser path, end to end ─────────────────────────────── */
function promptUnderTest(kind, item, angle, inProfile, delta) {
  const body = JSON.parse(JSON.stringify({ kind, item: kind === "look" ? {} : CLIENT.promptFactsOf(item), angle, inProfile, delta, where: "pin" }));
  return LIB.promptForRequest(LIB.sanitizePromptRequest(body));
}
/* ── end PROMPT UNDER TEST ───────────────────────────────────────────────────────── */

console.log("── §1 the wire, pinned to the pre-move engine ──");
const quiet = console.warn, quietErr = console.error;
console.warn = () => {}; console.error = () => {};
const hash = createHash("sha256");
let cases = 0;
try {
  for (const item of items()) {
    for (const angle of ["front", "back"]) for (const inProfile of [false, true]) for (let d = -3; d <= 3; d++) {
      hash.update(promptUnderTest("single", item, angle, inProfile, d) + "\n");
      cases++;
    }
  }
  hash.update(promptUnderTest("look", null, "front", false, 0) + "\n");
  cases++;
} finally {
  console.warn = quiet; console.error = quietErr;
}
const digest = hash.digest("hex");
if (process.argv.includes("--print")) { console.log(digest); process.exit(0); }
check(`every prompt over ${cases} cases matches the pre-move in-browser engine`, digest === PINNED,
  `expected ${PINNED}\n        got      ${digest}\n        (npm run trace:prompt shows which branch moved)`);

console.log("\n── §2 isBottomsGarment(): the browser's verdict wins, and the copies agree ──");
{
  const shirtNamedLikePants = { name: "Jeans Jacket", garmentType: "upper_body" };
  check("the server honours the browser's verdict over its own heuristic",
    LIB.isBottomsGarment({ ...shirtNamedLikePants, __bottoms: true }) === true &&
    LIB.isBottomsGarment({ name: "Slim Jeans", garmentType: "lower_body", __bottoms: false }) === false);
  check("...and falls back to the same heuristic when no verdict is sent",
    LIB.isBottomsGarment({ garmentType: "lower_body" }) === true &&
    LIB.isBottomsGarment({ garmentType: "upper_body" }) === false);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*if \(typeof item\.__bottoms === "boolean"\) return item\.__bottoms;\n/m, "")
    .split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
  const body = (src) => strip(between(src, "function isBottomsGarment(item) {", "\n}\n"));
  check("the two isBottomsGarment() bodies are identical apart from the verdict line",
    body(APP) === body(LIB_SRC), `app:\n${body(APP)}\n        lib:\n${body(LIB_SRC)}`);
  for (const name of ["BOTTOMS_TOKENS", "TOPS_TOKENS"]) {
    const tok = (src) => strip(between(src, `const ${name} =`, ";\n"));
    check(`${name} is identical in both files`, tok(APP) === tok(LIB_SRC));
  }
}

console.log("\n── §3 the facts the browser sends are exactly the facts the server accepts ──");
{
  const libStrings = new Function(between(LIB_SRC, "const PROMPT_ITEM_STRINGS = [", ";\n") + ";\nreturn PROMPT_ITEM_STRINGS;")();
  const libBools = new Function(between(LIB_SRC, "const PROMPT_ITEM_BOOLS = [", ";\n") + ";\nreturn PROMPT_ITEM_BOOLS;")();
  check("the string fields match", JSON.stringify(CLIENT.PROMPT_FACT_STRINGS) === JSON.stringify(libStrings),
    `${CLIENT.PROMPT_FACT_STRINGS} vs ${libStrings}`);
  check("the boolean fields match, plus the one verdict only the browser can supply (__bottoms)",
    JSON.stringify([...CLIENT.PROMPT_FACT_BOOLS, "__bottoms"].sort()) === JSON.stringify([...libBools].sort()),
    `${CLIENT.PROMPT_FACT_BOOLS} vs ${libBools}`);
  const f = CLIENT.promptFactsOf({ name: "Tee", img: "data:image/png;base64,AAAA", price: 5, garmentType: "upper_body" });
  check("promptFactsOf() sends no image, no URL and no unrelated field", !("img" in f) && !("price" in f) && f.__bottoms === false);
}

console.log("\n── §4 the sanitiser ──");
{
  const s = LIB.sanitizePromptRequest({ kind: "evil", angle: "left", delta: 99, inProfile: "yes", where: "<script>",
    item: { name: "x".repeat(5000), backIsPlain: "true", __bottoms: 1, secret: "nope", colorHex: 42 } });
  check("unknown kind/angle fall back to single/front", s.kind === "single" && s.angle === "front");
  check("the delta is clamped and non-booleans are dropped", s.delta === 12 && s.inProfile === false);
  check("strings are bounded, wrong types and unknown fields never reach the builders",
    s.item.name.length === 400 && !("backIsPlain" in s.item) && !("__bottoms" in s.item) &&
    !("secret" in s.item) && !("colorHex" in s.item));
  check("the log label is reduced to a safe token", /^[\w.-]+$/.test(s.where));
  check("a body that is not an object is a front, single, no-facts request",
    JSON.stringify(LIB.sanitizePromptRequest(null)) === JSON.stringify({ kind: "single", angle: "front", inProfile: false, delta: 0, where: "api", item: {} }));
}

console.log("\n── §5 the browser carries no prompt wording ──");
{
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const phrase of ["Drape and fit the EXACT", "Fit and replace BOTH the subject", "Reproduce the reference's front closure",
                        "rear view, turned around", "TURNED TO THEIR SIDE", "SIDE-PROFILE DEPTH FIDELITY", "clean break at the ankle"]) {
    check(`app.js code no longer contains "${phrase}"`, !code.includes(phrase));
  }
  for (const fn of ["imageOnlyPrompt", "lookAnchorPrompt", "fitPrompt", "clampPromptForWire", "fitSentence", "getFitModifier"]) {
    check(`app.js no longer defines ${fn}()`, !new RegExp(`^(?:async )?function ${fn}\\(`, "m").test(APP));
  }
}

console.log(fails === 0 ? "\nPrompt engine: OK" : `\nPrompt engine: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
