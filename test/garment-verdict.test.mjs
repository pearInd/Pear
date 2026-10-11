/* THE WIDGET'S VERDICT REACHES THE RIGHT GARMENT (fitting-room/app.js, 2026-10-10/11) - two bugs found driving a full look
   through the engine (the full look itself was tried and reverted - CLAUDE.md §2.42):
   §1 THE VERDICT IS FOR THE ROOM'S OWN GARMENT - the PEAR_UPDATE_GARMENT listener wrote the correction onto activeItem, which in
      a full look was the garment just added ("it measured the shorts twice, as the shorts and as the shirt")
   §2 THE EARLY VERDICT - a correction that landed on the size screen (no garment yet) was dropped, and the room went live on
      its unclassified opening guess: the gallery's second photo as the back (§2.1) */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ""}`); }
}
function between(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found: ${to}`);
  return src.slice(a, b);
}
const PEAK = { name: "חולצה עם הדפס", img: "https://fox.co.il/cdn/shop/files/1824346900-1.jpg", imgBack: "https://fox.co.il/cdn/shop/files/1824346900-3.jpg", garmentType: "upper_body" };

console.log("\n── §1 the verdict is for the room's own garment ──");
{
  const lis = between(APP, 'window.addEventListener("message", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;', "\n});\n");
  /* THE VERDICT IS FOR THE ROOM'S OWN GARMENT (2026-10-11): "it measured the shorts twice, as the shorts and as the shirt". */
  check("§1.1 the correction is written to the room's OWN garment (enterRoom's), never to a garment added since",
    /const target = \(typeof _handoffItem !== "undefined" && _handoffItem\) \|\| \(typeof activeItem !== "undefined" \? activeItem : null\);/.test(lis) &&
    !/\bactiveItem\.(img|imgBack|pearImages|composite|colorHex|textOcr|backIsPlain|backSource)\s*=/.test(lis) &&
    /target\.img = front;/.test(lis) && /target\.imgBack = back;/.test(lis));
  check("§1.2 enterRoom() records which garment that is", /setActiveItem\(toItem\(handoff\), \{ silent: true \}\);\s*\n\s*_handoffItem = activeItem;/.test(APP));
}

console.log("\n── §2 the early verdict - a correction before the room has a garment ──");
{
  const lis = between(APP, 'window.addEventListener("message", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;', "\n});\n");
  check("§2.1 with no garment yet the correction is HELD, not dropped",
    /if \(!target\) \{ if \(typeof _earlyGarmentUpdate !== "undefined"\) _earlyGarmentUpdate = e\.data; return; \}/.test(lis));
  const enter = between(APP, "function enterRoom() {", "\n}\n");
  check("§2.2 enterRoom() replays it right after the garment is set",
    /setActiveItem\(toItem\(handoff\), \{ silent: true \}\);\s*\n\s*_handoffItem = activeItem;[^\n]*\n\s*\/\*[^\n]*\*\/\s*\n\s*if \(typeof replayEarlyGarmentUpdate === "function"\) replayEarlyGarmentUpdate\(\);/.test(enter));
  const rp = between(APP, "let _earlyGarmentUpdate = null;", "\nwindow.addEventListener(\"message\", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== \"PEAR_UPDATE_GARMENT\")");
  const sent = [];
  const parent = { name: "parent" };
  class MessageEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const mk = (active) => new Function("window", "MessageEvent", "activeItem", rp + "\nreturn { hold: (d) => { _earlyGarmentUpdate = d; }, replayEarlyGarmentUpdate, get held() { return _earlyGarmentUpdate; } };")(
    { parent, dispatchEvent: (ev) => sent.push(ev) }, MessageEvent, active);
  const R = mk({ name: "PEAK" });
  const msg = { type: "PEAR_UPDATE_GARMENT", garment_url: PEAK.img, garment_back: PEAK.imgBack };
  R.hold(msg);
  check("§2.3 the replay goes through the listener itself - the same message, from the parent - once",
    R.replayEarlyGarmentUpdate() === true && sent.length === 1 && sent[0].data === msg && sent[0].source === parent && R.held === null &&
    R.replayEarlyGarmentUpdate() === false && sent.length === 1);
  const N = mk(null);
  N.hold(msg);
  check("§2.4 no garment yet, nothing replayed", N.replayEarlyGarmentUpdate() === false && sent.length === 1);
}


console.log(`\n${failed ? "✗" : "✓"} garment-verdict: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
