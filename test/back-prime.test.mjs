/* THE BACK IS SENT ONCE BEFORE THE REVEAL (2026-10-01) - fitting-room/app.js primeBackReference()
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED: the back view came out plain; its TEST record had the BACK reference acknowledged 2,058ms
   after it was sent. Every TEST record says the render engine is slow on an image the session has not
   sent yet (the back, first time: 400-900ms typically, 1.3-2.9s one session in seven) and fast on a
   repeat (the front, 130-250ms; a second back 141ms vs 912 the first). So the cold-start re-assert -
   already a hidden re-send inside the reveal hold - sends the back first, once, then the front.
   Runs the real primeBackReference() against fakes, and pins the wiring in armFirstFrameBilling().
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const between = (a, b) => { const i = APP.indexOf(a); if (i < 0) throw new Error("no " + a); return APP.slice(i, APP.indexOf(b, i)); };
const SRC = between("let _primedBackGen = -1;", "function armFirstFrameBilling(video, gen) {");

function world({ search = "", angle = "auto", look = null, back = "https://cdn.test/back.jpg", live = true, busySkip = false } = {}) {
  const sent = [], acked = [], blobs = {};
  const env = {
    location: { search }, activeItem: { img: "https://cdn.test/front.jpg" }, currentAngle: angle, AUTO_ANGLE: "auto",
    resolveLook: () => look, galleryOf: () => ({ front: "https://cdn.test/front.jpg" }), distinctBackOf: () => back,
    garmentBlobCached: async (u) => (blobs[u] ||= { size: 86000, url: u }),
    sessionGen: 3, rtClient: { set: async (p) => { sent.push(p); } }, isLive: () => live,
    wirePrompt: async (item, angle) => `PROMPT(${angle})`,
    sendCondition: async (label, send) => { if (busySkip) return false; await send(); return true; },
    noteImageUploadAcked: (w) => acked.push(w), lastSentImageRef: "front-blob", lastSentPrompt: "front-prompt",
    traceOrient: () => {}, console: { log() {}, warn() {} },
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${SRC}\nreturn { primeBackReference, state: () => ({ lastSentImageRef, lastSentPrompt }) };`)(...names.map((k) => env[k]));
  return { api, sent, acked, blobs };
}

{
  const w = world();
  const ok = await w.api.primeBackReference(3);
  check("§1 the back goes out: ONE set(), the back's cached Blob, the back's wire prompt, enhance off",
    ok === true && w.sent.length === 1 && w.sent[0].image === w.blobs["https://cdn.test/back.jpg"] &&
    w.sent[0].prompt === "PROMPT(back)" && w.sent[0].enhance === false, JSON.stringify(w.sent));
  check("§2 ...acknowledged like any upload (the reveal's settle hold counts it)", w.acked.join() === "primeBack");
  check("§3 ...and the no-op refs are cleared, so the re-assert re-uploads the FRONT",
    w.api.state().lastSentImageRef === null && w.api.state().lastSentPrompt === null);
  check("§4 once per session: a second call for the same session sends nothing", (await w.api.primeBackReference(3)) === false && w.sent.length === 1);
}
{
  const cases = [
    ["?prime_back=0 (main's hold)", world({ search: "?prime_back=0" })],
    ["a single-view garment (not AI Auto)", world({ angle: "front" })],
    ["a full look", world({ look: { top: {}, bottom: {} } })],
    ["no real back photo", world({ back: null })],
    ["a session that ended meanwhile", world({ live: false })],
  ];
  for (const [name, w] of cases) check(`§5 nothing is sent for ${name}`, (await w.api.primeBackReference(3)) === false && w.sent.length === 0);
  const busy = world({ busySkip: true });
  check("§6 a wire that declines the write sends nothing and claims nothing", (await busy.api.primeBackReference(3)) === false && busy.acked.length === 0);
}
{
  const redispatch = between("const redispatchColdStart = (myGen, delta, why) => {", "\n  const fire = () => {");
  check("§7 only the cold-start re-assert primes, and the front re-assert follows it",
    /const primed = why === "cold-start re-assert" && typeof primeBackReference === "function" \? primeBackReference\(myGen\) : null;/.test(redispatch) &&
    /primed\.catch\(\(\) => false\)\s*\.then\(\(\) => \{ if \(myGen === sessionGen && isLive\(\)\) return reassert\(\); \}\)/.test(redispatch));
  check("§8 with no prime the re-assert is synchronous, exactly as before (cold-start-passthrough runs this standalone)",
    /if \(!primed\) \{\s*reassert\(\)\.catch/.test(redispatch));
  check("§9 the re-assert still clears all three no-op refs before applyActive()",
    /const reassert = \(\) => \{\s*lastSentImageRef = null;\s*rtImageOnWire = false;\s*lastSentPrompt = null;\s*return applyActive\(\);/.test(redispatch));
}
console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("back-prime: all checks passed.");
