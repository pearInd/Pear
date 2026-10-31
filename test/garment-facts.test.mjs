/* THE GARMENT'S FACTS ARE KEPT WHEN ITS PHOTOS DID NOT CHANGE (2026-10-31, TEST sessions only).
   The classifier's PEAR_UPDATE_GARMENT is the only delivery of the fabric colour, the printed text and the plain-rear verdict.
   The widget's ready signal carried none, and the room's `unchanged` return dropped them from a correction whose photos matched
   - so on the common path no prompt named the colour (FOX PEAK #4e3b38, CHICAGO #000000). §1 runs the room's block on its own,
   §2 the hold for a verdict that lands before the room has its garment, §3 the widget's ready signal, §4 where the block sits. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function between(src, a, b) {
  const i = src.indexOf(a); if (i === -1) throw new Error(`no "${a}"`);
  const j = src.indexOf(b, i); if (j === -1) throw new Error(`no "${b}"`);
  return src.slice(i, j);
}

const BLOCK = between(APP, "  /* ── THE GARMENT'S FACTS, KEPT WHEN ITS PHOTOS DID NOT CHANGE", "  const front = e.data.garment_url;");
const run = (test, data, target, held = null) => new Function("e", "target", "traceEnabled", "_earlyGarmentFacts",
  BLOCK + "\nreturn _earlyGarmentFacts;")({ data }, target, () => test, held);

console.log("\n── §1 the room's block ──");
{
  const ready = { type: "PEAR_UPDATE_GARMENT", garment_classify_done: true, garment_color_hex: "#4e3b38", garment_text_ocr: "PEAK", garment_back_is_plain: false };
  const t = {};
  run(true, ready, t);
  check("§1.1 a TEST session keeps the ready signal's colour, text and plain-rear verdict (no photos on it)",
    t.colorHex === "#4e3b38" && t.textOcr === "PEAK" && t.backIsPlain === false, JSON.stringify(t));
  const s = {};
  run(false, ready, s);
  check("§1.2 a shopper's session: nothing (the approved wire, until measured)", Object.keys(s).length === 0, JSON.stringify(s));
  const k = { colorHex: "#ffffff", textOcr: "OLD" };
  run(true, { garment_text_ocr: "" }, k);
  check("§1.3 an absent colour never clears a known one; an empty text is a real verdict (plain)",
    k.colorHex === "#ffffff" && k.textOcr === "", JSON.stringify(k));
  const n = { colorHex: "#111111" };
  run(true, { garment_color_hex: "", garment_back_is_plain: "yes" }, n);
  check("§1.4 an empty colour and a non-boolean plain-rear are no verdicts", n.colorHex === "#111111" && !("backIsPlain" in n), JSON.stringify(n));
}

console.log("\n── §2 a verdict before the room has its garment ──");
{
  const held = run(true, { garment_color_hex: "#000000", garment_back_is_plain: true }, null);
  check("§2.1 held while the room has no garment", held && held.colorHex === "#000000" && held.backIsPlain === true, JSON.stringify(held));
  const merged = run(true, { garment_text_ocr: "CHICAGO" }, null, held);
  check("§2.2 a later verdict adds to the hold", merged.colorHex === "#000000" && merged.textOcr === "CHICAGO", JSON.stringify(merged));
  check("§2.3 a shopper's session holds nothing", run(false, { garment_color_hex: "#000000" }, null) === null);
  const REPLAY = between(APP, "function replayEarlyGarmentUpdate() {", "\nwindow.addEventListener(\"message\"");
  const item = { name: "PEAK" };
  const out = new Function("_earlyGarmentFacts", "_handoffItem", "activeItem", "_earlyGarmentUpdate",
    REPLAY + "\nconst r = replayEarlyGarmentUpdate(); return { r, left: _earlyGarmentFacts };")(merged, item, item, null);
  check("§2.4 the room's entry applies the hold to its own garment and clears it",
    item.colorHex === "#000000" && item.textOcr === "CHICAGO" && item.backIsPlain === true && out.left === null, JSON.stringify({ item, out }));
}

console.log("\n── §3 the widget's ready signal ──");
{
  const sig = between(WIDGET, "{ type: \"PEAR_UPDATE_GARMENT\", garment_classify_done: true,", "productSignals(res)));");
  check("§3.1 the ready signal carries the colour, the text and the plain-rear verdict, omitted when unknown",
    /garment_color_hex: res\.colorHex \|\| undefined/.test(sig) &&
    /garment_text_ocr: typeof res\.textOcr === "string" \? res\.textOcr : undefined/.test(sig) &&
    /garment_back_is_plain: typeof res\.backIsPlain === "boolean" \? res\.backIsPlain : undefined/.test(sig), sig);
}

console.log("\n── §4 where it sits ──");
{
  const handler = between(APP, "if (typeof _galleryValidated !== \"undefined\") _galleryValidated = true;", "if (unchanged) {");
  const at = handler.indexOf("THE GARMENT'S FACTS, KEPT");
  check("§4.1 above the `!front` guard (the ready signal has no photos) and so above the unchanged return",
    at > 0 && at < handler.indexOf("if (!front) return;") && at < handler.indexOf("const unchanged ="));
  check("§4.2 the changed-photos path still stores the facts below, as before",
    /if \(typeof e\.data\.garment_color_hex === "string" && e\.data\.garment_color_hex\) \{\n\s*target\.colorHex = e\.data\.garment_color_hex;/.test(APP));
  check("§4.3 a TEST record says which facts the prompt could name (ctx.facts)", /facts: activeItem \? \{ color: activeItem\.colorHex/.test(APP));
}

console.log("\n── §5 the engine: a TEST request names a dark brown, a shopper's is unchanged ──");
{
  const P = await import("../lib/prompts.js");
  const item = { name: "PEAK tee", title: "PEAK oversized tee", category: "top", garmentType: "upper_body", __bottoms: false, textOcr: "PEAK", backIsPlain: false };
  const fabric = (hex, test, angle = "front") => (P.promptForRequest(P.sanitizePromptRequest({ kind: "single", item: { ...item, colorHex: hex }, angle, delta: 0,
    ...(test ? { test: true } : {}) })).match(/Fabric: ([^.]+)\./) || [, null])[1];
  check("§5.1 PEAK's #4e3b38: a shopper's request still says charcoal (the approved wire)", fabric("#4e3b38", false) === "charcoal");
  check("§5.2 ...a TEST request says dark brown, front and back", fabric("#4e3b38", true) === "dark brown" && fabric("#4e3b38", true, "back") === "dark brown");
  check("§5.3 near-black stays black under the floor (#0f0a05, #140f23); black and white unchanged",
    ["#0f0a05", "#140f23", "#000000"].every((h) => fabric(h, true) === "black") && fabric("#ffffff", true) === "white");
  check("§5.4 the flag only travels as a real boolean", !("test" in P.sanitizePromptRequest({ test: "1" })) && P.sanitizePromptRequest({ test: true }).test === true);
  const after = P.promptForRequest(P.sanitizePromptRequest({ kind: "single", item: { ...item, colorHex: "#4e3b38" }, angle: "front", delta: 0 }));
  check("§5.5 the request state resets - the next shopper request after a TEST one is the shopper's", /Fabric: charcoal\./.test(after));
  check("§5.6 the room asks with the flag in a TEST session only", /\.\.\.\(typeof traceEnabled === "function" && traceEnabled\(\) \? \{ test: true \} : \{\}\),/.test(APP));
}

console.log(fails === 0 ? "\ngarment-facts: OK" : `\ngarment-facts: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
