/* THE FIT READ FROM THE PHOTO - "the belly looks too big at the start, as if I had a paunch ... it has to be done by
   the model's photo" (the owner, a football jersey on terminalx, 2026-11-11). See lib/garment-fit.js, CLAUDE.md §7.28.
   ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   §1  THE READ: a worn, whole, front or back photo with a confident answer gives { cut, hem }; a packshot, a close-up,
       a side view, an unsure or malformed answer gives nothing (the prompt keeps the table's sentence).
   §2  THE MODEL CALL: only a real answer is a verdict, a 429 throws (never cached), no key is an error.
   §3  THE SENTENCE (lib/prompts.js): a TEST request for a top with the two facts starts from the photo's cut, moves one
       step per size, names the hem at true-to-size only, and never describes the body; a shopper's request, a bottom,
       a request without the facts and a fact outside the vocabulary are byte-identical to the table's prompt.
   §4  THE ROOM AND THE ENDPOINT: TEST sessions only, a single top, the forwarded gallery, a bounded number of asks;
       the two facts travel to the engine on both sides of the request (CLAUDE.md §3).
   What this cannot see: whether the model reads a given photo WELL, or what the engine draws from the sentence -
   both are measured on a TEST session (CLAUDE.md §7.1). */
import { readFileSync } from "node:fs";
import { garmentFitFromDetection, detectGarmentFit, garmentFitPrompt, FIT_CUTS, FIT_HEMS } from "../lib/garment-fit.js";
import { sanitizePromptRequest, promptWithShedForRequest } from "../lib/prompts.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 the read ──");
const WORN = { worn_by_person: true, view: "front", whole_garment: true, cut: "regular", hem: "hip", confidence: 0.9 };
{
  const r = garmentFitFromDetection(WORN);
  check("a worn front photo gives the cut and the hem", r.reason === "fit" && r.fit && r.fit.cut === "regular" && r.fit.hem === "hip", JSON.stringify(r));
  check("a back view is read too", garmentFitFromDetection({ ...WORN, view: "back" }).reason === "fit");
  check("a packshot says nothing", garmentFitFromDetection({ ...WORN, worn_by_person: false }).fit === null);
  check("a close-up says nothing", garmentFitFromDetection({ ...WORN, whole_garment: false }).reason === "cropped");
  check("a side view says nothing", garmentFitFromDetection({ ...WORN, view: "side" }).reason === "side-view");
  check("an unsure answer says nothing", garmentFitFromDetection({ ...WORN, confidence: 0.4 }).reason === "unsure");
  check("a cut outside the vocabulary says nothing", garmentFitFromDetection({ ...WORN, cut: "baggy" }).reason === "no-cut");
  check("a hem outside the vocabulary keeps the cut", (() => { const x = garmentFitFromDetection({ ...WORN, hem: "knee" }); return x.fit && x.fit.cut === "regular" && x.fit.hem === null; })());
  check("no answer says nothing", garmentFitFromDetection(null).fit === null && garmentFitFromDetection("x").fit === null);
  const p = garmentFitPrompt();
  check("the question names every cut and every hem", FIT_CUTS.every((c) => p.includes(`"${c}"`)) && FIT_HEMS.every((h) => p.includes(`"${h}"`)));
  check("the question asks about the fabric, not the person's build", /judged from the fabric, not from the person's build/.test(p));
}

console.log("── §2 the model call ──");
{
  const img = { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const reply = (obj) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] }) });
  const make = (model) => async (u) => (String(u).includes("generativelanguage") ? model : img);
  const ok = await detectGarmentFit("https://cdn.example.com/a.jpg", "k", { fetchImpl: make(reply(WORN)) });
  check("a real answer is a verdict", ok.source === "ai" && ok.fit && ok.fit.cut === "regular" && ok.view === "front", JSON.stringify(ok));
  const none = await detectGarmentFit("https://cdn.example.com/a.jpg", "k", { fetchImpl: make(reply({ worn_by_person: false, confidence: 0 })) });
  check("a packshot is a verdict too (cached as 'nothing')", none.source === "ai" && none.fit === null && none.reason === "no-person");
  let threw = false;
  try { await detectGarmentFit("https://cdn.example.com/a.jpg", "k", { fetchImpl: make({ ok: false, status: 429, text: async () => "slow down" }) }); } catch (e) { threw = e.rateLimited === true; }
  check("a 429 throws, so it is never cached", threw);
  const down = await detectGarmentFit("https://cdn.example.com/a.jpg", "k", { fetchImpl: make({ ok: false, status: 500, text: async () => "" }) });
  check("a model error is an error, not a verdict", down.source === "error" && down.fit === null);
  const nokey = await detectGarmentFit("https://cdn.example.com/a.jpg", "", {});
  check("no key is an error", nokey.source === "error" && nokey.reason === "no-key");
}

console.log("── §3 the sentence ──");
{
  const base = { name: "Football jersey", garmentType: "upper_body", __bottoms: false, colorHex: "#f8c8d8", textOcr: "Jeep" };
  const ask = (item, delta, test, angle = "front") => promptWithShedForRequest(sanitizePromptRequest({ kind: "single", item, angle, inProfile: false, delta, test })).prompt;
  const fitOf = (p) => p.slice(p.indexOf("Fit:"));
  const read = { ...base, fitCut: "regular", fitHem: "hip" };
  const t0 = ask(read, 0, true);
  check("true-to-size starts from the photo's cut and names its hem",
    fitOf(t0) === "Fit: regular straight-cut garment, fabric hanging straight from the chest to the hem with a little ease, hem at the hip.", fitOf(t0));
  check("one size up is one step looser, the hem not named", /^Fit: relaxed straight-cut garment/.test(fitOf(ask(read, 1, true))) && !/hem at/.test(fitOf(ask(read, 1, true))));
  check("one size down is one step closer", /^Fit: close-cut garment/.test(fitOf(ask(read, -1, true))));
  check("past the ends of the scale", /^Fit: undersized garment/.test(fitOf(ask(read, -2, true))) && /^Fit: very oversized garment/.test(fitOf(ask({ ...read, fitCut: "oversized" }, 2, true))));
  check("an oversized garment at true-to-size is drawn oversized", /^Fit: oversized garment, dropped shoulder seams/.test(fitOf(ask({ ...read, fitCut: "oversized" }, 0, true))));
  check("the back carries the same sentence", fitOf(ask(read, 0, true, "back")) === fitOf(t0));
  const all = [];
  for (const cut of FIT_CUTS) for (const hem of [...FIT_HEMS, undefined]) for (const d of [-3, -2, -1, 0, 1, 2, 3]) all.push(fitOf(ask({ ...base, fitCut: cut, ...(hem ? { fitHem: hem } : {}) }, d, true)));
  check("no rung describes the body (CLAUDE.md §2.4)", all.every((s) => !/\b(belly|stomach|waistline|slim|thin|figure|silhouette|body)\b/i.test(s)), all.find((s) => /\b(belly|stomach|waistline|slim|thin|figure|silhouette|body)\b/i.test(s)));
  check("no rung asks for volume (the report)", all.every((s) => !/volume|room across|balloon/i.test(s)));
  check("every rung fits the budget whole (nothing shed)", [-3, -2, -1, 0, 1, 2, 3].every((d) => promptWithShedForRequest(sanitizePromptRequest({ kind: "single", item: read, angle: "front", inProfile: false, delta: d, test: true })).shed.length === 0));
  check("A SHOPPER'S REQUEST IS THE TABLE'S, byte for byte", [-2, -1, 0, 1, 2].every((d) => ask(read, d, false) === ask(base, d, false)));
  check("a TEST request without the facts is the table's", [-2, -1, 0, 1, 2].every((d) => ask(base, d, true) === ask({ ...base }, d, true) && /true-to-size|snug|relaxed fit|oversized fashion|undersized garment stretched/.test(fitOf(ask(base, d, true)))));
  check("a cut outside the vocabulary is the table's", ask({ ...base, fitCut: "baggy", fitHem: "hip" }, 0, true) === ask({ ...base, fitCut: "baggy", fitHem: "hip" }, 0, false));
  const pants = { name: "Jeans", garmentType: "lower_body", __bottoms: true };
  check("a bottom never reads it", ask({ ...pants, fitCut: "regular", fitHem: "hip" }, 0, true) === ask(pants, 0, true));
}

console.log("── §4 the room and the endpoint ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const LIB = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8");
  check("the room sends the two facts", /const PROMPT_FACT_STRINGS = \[[^\]]*"fitCut", "fitHem"\]/.test(APP));
  check("the engine accepts the two facts", /const PROMPT_ITEM_STRINGS = \[[^\]]*"fitCut", "fitHem"\]/.test(LIB));
  check("the engine reads them for a TEST request only", /_requestFitRead = req\.test === true && req\.kind !== "look" && req\.item && req\.item\.__bottoms !== true \? fitReadOf\(req\.item\) : null;/.test(LIB));
  check("the request state is cleared", /_requestTest = false;\n    _requestFitRead = null;/.test(LIB));
  const on = APP.slice(APP.indexOf("function fitReadOn()"), APP.indexOf("function fitReadCandidates"));
  check("the room's gate: TEST sessions; ?fit_read=0 off, =1 on", /v === "0"\) return false/.test(on) && /v === "1"\) return true/.test(on) && /traceEnabled\(\)/.test(on));
  const job = APP.slice(APP.indexOf("function readGarmentFit(item)"), APP.indexOf("function prewarmOrientationAssets()"));
  check("a bottom is never asked about", /isBottomsGarment\(item\)\) return Promise\.resolve\(false\)/.test(job));
  check("one job per garment", /if \(item\._fitReadJob\) return item\._fitReadJob;/.test(job));
  check("...asked again when the classifier brings another gallery and nothing had landed",
    /if \(!target\.fitCut && galleryBefore !== target\.pearImages\.join\("\|"\)\) target\._fitReadJob = null;/.test(APP));
  check("the asks are bounded", /const FIT_READ_MAX_PHOTOS = 4;/.test(APP) && /out\.length >= FIT_READ_MAX_PHOTOS/.test(APP));
  check("a failed ask never throws into the room", /catch \(e\) \{ why = "no-answer"; \}/.test(job));
  check("the prompts are re-asked once the read lands, for the garment still on", /readGarmentFit\(it\)\.then\(\(landed\) => \{\n\s+if \(!landed \|\| it !== activeItem\) return;\n\s+for \(const \[angle, inProfile\] of combos\) wirePrompt\(it, angle, "prefetch", \{ inProfile \}\)/.test(APP));
  check("a full look is not read (the look's prompt has no fit sentence)", /if \(look\) \{\n    if \(typeof wireLookPrompt === "function"\) wireLookPrompt\("prefetch"\)/.test(APP));
  check("the record carries the read and the size step", /fit: typeof _fitReadLog !== "undefined" && _fitReadLog \? _fitReadLog : undefined,\n\s+delta: typeof getSizeDelta === "function" \? getSizeDelta\(\) : undefined,/.test(APP));
  const route = SERVER.slice(SERVER.indexOf('app.get("/api/garment-fit"'), SERVER.indexOf('app.post("/api/classify-garment"'));
  check("the endpoint takes a public http(s) photo only", /isProxyHostAllowed\(parsed\.hostname, parsed\.protocol\)/.test(route) && /\^https\?:/.test(route));
  check("only a verdict is cached", /if \(out\.source === "ai"\) \{\n    _garmentFitMemo\.set/.test(route) && /"no-store"/.test(route));
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
