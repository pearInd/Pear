/* THE GARMENT'S FACTS ARE KEPT EVEN WHEN ITS PHOTOS DID NOT CHANGE (2026-10-12, TEST sessions only).
   The classifier's PEAR_UPDATE_GARMENT is the only delivery of the fabric colour, the printed text and the plain-rear verdict;
   the room's "unchanged" early return dropped all three whenever it had opened on the right photos already (FOX PEAK #4e3b38,
   CHICAGO #000000 - no "Fabric:" in any prompt). §1 runs the block on its own; §2 pins where it sits. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const a = APP.indexOf("  /* THE GARMENT'S FACTS ARE KEPT EVEN WHEN ITS PHOTOS DID NOT CHANGE");
const b = APP.indexOf("  const unchanged = target.img === front && target.imgBack === back &&", a);
const BLOCK = APP.slice(a, b);
const run = (test, data, target = {}) => { const ev = [];
  new Function("e", "target", "traceEnabled", "traceOrient", BLOCK)({ data }, target, () => test, (k, v) => ev.push([k, v])); return { target, ev }; };
console.log("\n── §1 the block ──");
const msg = { garment_color_hex: "#000000", garment_text_ocr: "CHICAGO", garment_back_is_plain: true };
const t = run(true, msg);
check("§1.1 a TEST session keeps the colour, the printed text and the plain-rear verdict before the unchanged return",
  t.target.colorHex === "#000000" && t.target.textOcr === "CHICAGO" && t.target.backIsPlain === true, JSON.stringify(t.target));
check("§1.2 ...and records them (facts)", t.ev.length === 1 && t.ev[0][0] === "facts" && t.ev[0][1].color === "#000000" && t.ev[0][1].ocr === 7);
const s = run(false, msg);
check("§1.3 a shopper's session: nothing here (main's behaviour - the unchanged return decides)", !("colorHex" in s.target) && s.ev.length === 0);
const none = run(true, { garment_text_ocr: "" }, { colorHex: "#ffffff" });
check("§1.4 an absent colour never clears a known one; an empty text is a real verdict (plain)", none.target.colorHex === "#ffffff" && none.target.textOcr === "");
console.log("\n── §2 where it sits ──");
check("§2.1 before the unchanged early return, after the awaiting-back bookkeeping", a > 0 && b > a &&
  APP.indexOf("const wasAwaitingBack = !!target?._awaitingBackCorrection;") < a && APP.indexOf("if (unchanged) {", b) > b);
check("§2.2 the facts are still stored below as well (a changed photo path is untouched)",
  /if \(typeof e\.data\.garment_color_hex === "string" && e\.data\.garment_color_hex\) \{\n\s*target\.colorHex = e\.data\.garment_color_hex;/.test(APP.slice(b)));
console.log(fails === 0 ? "\ngarment-facts: OK" : `\ngarment-facts: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
