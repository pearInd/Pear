/* A FULL LOOK'S BOTTOM, FROM THE FIRST FRAME (2026-10-15) - real session m4 (PEAK + CHICAGO): the shopper's own shorts for
   the first 2.4s, the CHICAGO shorts only after the turn's back composite. The reveal hold's one re-assert becomes, for a
   full look, a back->front cycle while the engine is generating. Pins: the order (back composite with the look prompt,
   then the front through applyActive with the no-op refs cleared), once per session, only a full look in AI Auto with a
   distinct back, ?look_cycle=0, and the single garment's re-assert untouched. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond && detail !== undefined) console.log(`        ${detail}`); }
const between = (a, b) => { const i = APP.indexOf(a); if (i < 0) throw new Error(a); return APP.slice(i, APP.indexOf(b, i)); };
const src = between("let _lookStartCycleGen = -1;", "\nfunction armFirstFrameBilling(video, gen) {");

async function run({ look = true, angle = "auto", search = "", backSame = false, gens = [1] } = {}) {
  const calls = [];
  const sb = {
    location: { search }, AUTO_ANGLE: "auto", currentAngle: angle, sessionGen: gens[gens.length - 1],
    rtClient: { set: (p) => { calls.push(["set", p.image, p.prompt]); return Promise.resolve(); } },
    isLive: () => true,
    resolveLook: () => (look ? { top: { n: "top" }, bottom: { n: "bottom" } } : null),
    lookHalfFor: (it, side) => (backSame ? `${it.n}:front` : `${it.n}:${side}`),
    stitchLookBlob: async (a, b) => `stitch(${a}|${b})`,
    wireLookPrompt: async () => "LOOK PROMPT",
    sendCondition: async (label, fn) => { calls.push(["send", label]); await fn(); return true; },
    noteImageUploadAcked: (w) => calls.push(["acked", w]),
    applyActive: async () => calls.push(["applyActive", refsNow()]),
    traceOrient: (k, v) => calls.push(["trace", k, v && v.phase]),
    console: { log() {}, warn() {} },
  };
  let refsNow = () => null;
  const fn = new Function(...Object.keys(sb), "let lastSentImageRef = 'X', rtImageOnWire = true, lastSentPrompt = 'Y';\n" + src +
    "\nreturn { start: lookStartCycle, refs: () => ({ lastSentImageRef, rtImageOnWire, lastSentPrompt }) };")(...Object.values(sb));
  refsNow = fn.refs;
  const started = gens.map((g) => fn.start(g));
  await new Promise((r) => setTimeout(r, 20));
  return { started, calls };
}

{
  const r = await run();
  check("a full look starts the cycle", r.started[0] === true);
  const sets = r.calls.filter((c) => c[0] === "set");
  check("...the BACK composite first, with the look's prompt", sets.length === 1 && sets[0][1] === "stitch(top:back|bottom:back)" && sets[0][2] === "LOOK PROMPT", JSON.stringify(r.calls));
  const ap = r.calls.find((c) => c[0] === "applyActive");
  check("...then the front through applyActive(), the no-op refs cleared so it is a real upload",
    ap && ap[1].lastSentImageRef === null && ap[1].rtImageOnWire === false && ap[1].lastSentPrompt === null &&
    r.calls.findIndex((c) => c[0] === "applyActive") > r.calls.findIndex((c) => c[0] === "set"), JSON.stringify(r.calls));
  check("...the back's acknowledgement counted by the settle hold, and the record says so",
    r.calls.some((c) => c[0] === "acked" && c[1] === "lookCycle") && r.calls.some((c) => c[0] === "trace" && c[1] === "look-cycle" && c[2] === "front"));
}
{
  const r = await run({ gens: [1, 1] });
  check("once per session", r.started[0] === true && r.started[1] === false && r.calls.filter((c) => c[0] === "set").length === 1);
  check("a single garment does not cycle (main's re-assert)", (await run({ look: false })).started[0] === false);
  check("nor a look outside AI Auto", (await run({ angle: "front" })).started[0] === false);
  check("nor a look whose back composite is its front", (await run({ backSame: true })).started[0] === false);
  check("?look_cycle=0 is the re-send as before", (await run({ search: "?look_cycle=0" })).started[0] === false);
}
check("the reveal hold's re-assert: the cycle for a look, else main's redispatch - unchanged for a single garment",
  /if \(!\(typeof lookStartCycle === "function" && !wireBusy\(\) && lookStartCycle\(gen\)\)\) redispatchColdStart\(gen, NaN, "cold-start re-assert"\);/.test(APP));
console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
