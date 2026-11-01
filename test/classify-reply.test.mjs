/* THE WHOLE REPLY (2026-10-31; one reader for every model call since 2026-11-01, lib/model-reply.js). The classifier read
   parts[0] of Gemini's reply alone; CHICAGO 3108650200's front verdict was cut at `"cue":"drawstring waistband and front-fa`
   - the model LOOPING in its cue ("23 23 23 ..." for 65,656 chars, ~2 minutes, MAX_TOKENS) - logged "unparseable" and saved
   as an uncertain FRONT with no colour and no lettering AT THE CURRENT PROMPT VERSION, never asked again. The garment box,
   the garment category, the photo estimate and the title category read the reply the same way.
   §1 the shared reader on every reply shape, §1b the bounded answer, §2 a non-answer is asked again, §3 the version moved,
   §4 each of the other four callers through a fake fetch: a split reply, a cut loop, an empty reply. */
import { readFileSync } from "node:fs";
import { geminiReplyText, parseGeminiJson, salvageGeminiFields, MODEL_REPLY_MAX_TOKENS } from "../lib/model-reply.js";
import { detectGarmentBand } from "../lib/garment-box.js";
import { classifyGarmentFull } from "../lib/garment-category.js";
import { estimateBodyFromPhoto } from "../lib/body-estimate.js";
const SRV = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LIB = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const reply = (...parts) => ({ candidates: [{ content: { parts } }] });
const answer = { view: "front", confidence: 1, age_group: "kids", age_group_confidence: 0.95, cue: "drawstring waistband and front-facing logo",
  text_ocr: "CHICAGO", is_true_back_view: false, has_graphic: true, primary_color_hex: "#111111" };
const json = JSON.stringify(answer);
const V = { required: ["view"] };   // the classifier's own ask

console.log("\n── §1 the reply, whole ──");
{
  const cut = json.indexOf("front-fa") + 8;
  const split = parseGeminiJson(geminiReplyText(reply({ text: json.slice(0, cut) }, { text: json.slice(cut) })), V);
  check("§1.1 an answer split over two parts parses whole - the CHICAGO reply (colour and lettering kept)",
    split && split.primary_color_hex === "#111111" && split.text_ocr === "CHICAGO", JSON.stringify(split));
  let oldReader = null; try { oldReader = JSON.parse(json.slice(0, cut)); } catch (_) { /* the old reader's failure */ }
  check("§1.2 ...where the first part alone does not parse (the old reader: JSON.parse of parts[0])", oldReader === null);
  const thought = parseGeminiJson(geminiReplyText(reply({ text: "Looking at the waistband...", thought: true }, { text: json })), V);
  check("§1.3 a thinking part is skipped", thought && thought.view === "front");
  check("§1.4 one part, as before", parseGeminiJson(geminiReplyText(reply({ text: json })), V).view === "front");
  check("§1.5 a fenced or prefixed body is cut to its object", parseGeminiJson("```json\n" + json + "\n```", V).text_ocr === "CHICAGO");
  check("§1.6 nothing usable is null, never a throw",
    parseGeminiJson(geminiReplyText({}), V) === null && parseGeminiJson("not json", V) === null && geminiReplyText(reply()) === "" &&
    parseGeminiJson(undefined) === null && parseGeminiJson("null") === null);
}

console.log("\n── §1b A BOUNDED ANSWER - the loop the CHICAGO front really was ──");
{
  check("§1b.1 the classifier's reply is capped (it ran 65,656 chars / ~2 minutes, finish MAX_TOKENS)",
    /maxOutputTokens: MODEL_REPLY_MAX_TOKENS,/.test(SRV) && MODEL_REPLY_MAX_TOKENS >= 1024 && MODEL_REPLY_MAX_TOKENS <= 8192, String(MODEL_REPLY_MAX_TOKENS));
  const order = (SRV.match(/propertyOrdering: \[([^\]]+)\]/) || [])[1] || "";
  const names = order.match(/"([a-z_]+)"/g) || [];
  check("§1b.2 cue is the LAST field, the colour and lettering before it", names[names.length - 1] === '"cue"' &&
    names.indexOf('"primary_color_hex"') < names.indexOf('"cue"') && names.indexOf('"text_ocr"') < names.indexOf('"cue"'), order);
  const tpl = (SRV.match(/Respond ONLY with JSON matching this schema:\n(\{.*\})`;/) || [])[1] || "";
  check("§1b.3 ...and the prompt's template says the same order", /"text_ocr":[^}]*"cue":"[^"]*"\}$/.test(tpl) && tpl.indexOf("primary_color_hex") < tpl.indexOf('"cue"'), tpl);
  const loop = '{"view":"front","confidence":1.0,"age_group":"kids","age_group_confidence":0.95,"primary_color_hex":"#1b1b1d",' +
    '"has_graphic":true,"is_true_back_view":false,"text_ocr":"CHICAGO 23","cue":"drawstring waistband and front-fa 23 23 23 23 23';
  const got = parseGeminiJson(loop, V);
  check("§1b.4 a reply cut inside a looping cue keeps every completed field - the verdict, colour and lettering",
    got && got.view === "front" && got.primary_color_hex === "#1b1b1d" && got.text_ocr === "CHICAGO 23" && got.has_graphic === true && !("cue" in got),
    JSON.stringify(got));
  check("§1b.5 a string cut before its closing quote is not kept", !("text_ocr" in (parseGeminiJson('{"view":"back","text_ocr":"CHIC', V) || {})));
  check("§1b.6 no view, no answer", parseGeminiJson('{"confidence":1.0,"primary_color_hex":"#000000","cue":"x x', V) === null);
  const esc = parseGeminiJson('{"view":"front","text_ocr":"SAY \\"HI\\"","cue":"a', V);
  check("§1b.7 an escaped quote inside a completed string decodes", esc && esc.text_ocr === 'SAY "HI"', JSON.stringify(esc));
  check("§1b.8 salvage off is whole-or-nothing (a cut box is not a box)",
    parseGeminiJson('{"worn_by_person":true,"confidence":0.9,"upper_box_2d":[348,168,9', { salvage: false }) === null &&
    salvageGeminiFields('{"a":[1,2,3],"b":"x"').a === undefined);
  check("§1b.9 a required field that completed as null does not count", parseGeminiJson('{"view":null,"cue":"x', V) === null);
}

console.log("\n── §2 a non-answer is asked again ──");
{
  check("§2.1 the unparseable record says so", /cue: "unparseable response",[\s\S]{0,200}unparseable: true,/.test(SRV));
  const saves = SRV.match(/classifierVersion: (rec|detail)\.unparseable \? null : CLASSIFIER_PROMPT_VERSION,/g) || [];
  check("§2.2 both fresh-classification saves leave it un-versioned (stale -> re-classified)", saves.length === 2, String(saves.length));
  check("§2.3 no fresh save stamps a non-answer with the version",
    !/classifyFrontBackDetailed\(imageUrl\);[\s\S]{0,700}classifierVersion: CLASSIFIER_PROMPT_VERSION,/.test(SRV));
  check("§2.4 the classifier reads the whole reply and salvages only a completed view",
    /const text = geminiReplyText\(data\);\n\s*const parsed = parseGeminiJson\(text, \{ required: \["view"\] \}\);/.test(SRV));
}

console.log("\n── §3 the rows written before the fix ──");
{
  const v = Number((SRV.match(/const CLASSIFIER_PROMPT_VERSION = (\d+);/) || [])[1]);
  check("§3.1 the prompt version moved past 3 (the cut answers were stamped v3)", v >= 4, String(v));
}

console.log("\n── §4 every other model call reads the same way ──");
{
  check("§4.1 no runtime reader takes parts[0] alone any more (server.js, lib/)",
    ![SRV, LIB("garment-box.js"), LIB("garment-category.js"), LIB("body-estimate.js")].some((t) => /parts\?\.\[0\]\?\.text/.test(t)));
  check("§4.2 each of them asks for the bounded answer",
    ["garment-box.js", "garment-category.js", "body-estimate.js"].every((f) => /maxOutputTokens: MODEL_REPLY_MAX_TOKENS,/.test(LIB(f))) &&
    (SRV.match(/maxOutputTokens: MODEL_REPLY_MAX_TOKENS,/g) || []).length === 2);
  check("§4.3 free text last: the category's cue, the estimate's scale_cue",
    /propertyOrdering: \["garment_category", "confidence", "cue"\]/.test(LIB("garment-category.js")) &&
    /propertyOrdering: \[[^\]]*"scale_cue"\]/.test(LIB("body-estimate.js")));

  /* A fake fetch: the photo, then the model's reply in the given parts. */
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const fakeFetch = (parts) => async (url) => {
    if (!String(url).includes("generativelanguage")) {
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => JPEG.buffer };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({ candidates: [{ content: { parts }, finishReason: "MAX_TOKENS" }] }) };
  };
  const halves = (s, at) => [{ text: s.slice(0, at) }, { text: s.slice(at) }];

  /* the garment box */
  const BOX = JSON.stringify({ worn_by_person: true, upper_box_2d: [348, 168, 914, 802], lower_box_2d: null, confidence: 0.92 });
  const split = await detectGarmentBand("https://cdn.example.com/tee-3.jpg", "top", "k", { fetchImpl: fakeFetch(halves(BOX, 30)) });
  check("§4.4 the box: a split reply is a verdict with its band (was 'unparseable')", split.source === "ai" && !!split.band, JSON.stringify(split));
  const cutBox = await detectGarmentBand("https://cdn.example.com/tee-3.jpg", "top", "k", { fetchImpl: fakeFetch([{ text: BOX.slice(0, 45) }]) });
  check("§4.5 ...a box cut mid-array is an ERROR (never cached), not a verdict of 'no box'", cutBox.source === "error" && cutBox.band === null,
    JSON.stringify(cutBox));
  const emptyBox = await detectGarmentBand("https://cdn.example.com/tee-3.jpg", "top", "k", { fetchImpl: fakeFetch([]) });
  check("§4.6 ...an empty reply is an error too (it was parsed as null and cached as a verdict)", emptyBox.source === "error", JSON.stringify(emptyBox));

  /* the garment category (it fetches through the global fetch) */
  const realFetch = globalThis.fetch;
  try {
    const CAT = JSON.stringify({ garment_category: "pants", confidence: 0.9, cue: "waistband and two legs" });
    globalThis.fetch = fakeFetch(halves(CAT, 20));
    const c1 = await classifyGarmentFull("https://cdn.example.com/shorts.jpg", "k");
    check("§4.7 the category: a split reply is a verdict", c1.source === "gemini" && c1.garment_category === "pants", JSON.stringify(c1));
    globalThis.fetch = fakeFetch([{ text: '{"garment_category":"pants","confidence":0.9,"cue":"waistband 23 23 23 23' }]);
    const c2 = await classifyGarmentFull("https://cdn.example.com/shorts.jpg", "k");
    check("§4.8 ...a loop in its cue keeps the completed category", c2.source === "gemini" && c2.garment_category === "pants" && c2.confidence === 0.9,
      JSON.stringify(c2));
    globalThis.fetch = fakeFetch([{ text: '{"garment_category":"pa' }]);
    const c3 = await classifyGarmentFull("https://cdn.example.com/shorts.jpg", "k");
    check("§4.9 ...a cut category is an error (never cached as 'unknown')", c3.source === "error", JSON.stringify(c3));
    globalThis.fetch = fakeFetch([]);
    const c4 = await classifyGarmentFull("https://cdn.example.com/shorts.jpg", "k");
    check("§4.10 ...an empty reply is an error (it was parsed as {} and cached as 'unknown')", c4.source === "error", JSON.stringify(c4));
  } finally { globalThis.fetch = realFetch; }

  /* the photo estimate */
  const req = { image: { mimeType: "image/jpeg", base64: "AAAA" } };
  const EST = JSON.stringify({ person_visible: true, full_body_visible: true, height_cm: 178, weight_kg: 74, confidence: 0.8, scale_cue: "the door frame" });
  const e1 = await estimateBodyFromPhoto(req, "k", fakeFetch(halves(EST, 40)));
  check("§4.11 the estimate: a split reply gives its numbers", e1.ok === true && e1.height === 178 && e1.weight === 74, JSON.stringify(e1));
  const e2 = await estimateBodyFromPhoto(req, "k", fakeFetch([{ text: EST.slice(0, EST.indexOf("the door")) + "the door the door the door" }]));
  check("§4.12 ...a loop in its scale_cue keeps the completed numbers", e2.ok === true && e2.height === 178, JSON.stringify(e2));
  const e3 = await estimateBodyFromPhoto(req, "k", fakeFetch([{ text: '{"person_visible":true,"height_cm":17' }]));
  check("§4.13 ...a reply cut before its numbers is an error", e3.ok === false && e3.reason === "error", JSON.stringify(e3));

  check("§4.14 the title category (/api/classify-garment) reads the whole reply",
    /parseGeminiJson\(geminiReplyText\(data\), \{ required: \["category"\] \}\)\?\.category/.test(SRV));
}

console.log("\n── §5 no answer to the page names the vendor (§2.24, found by the rig's Network audit 2026-11-01) ──");
{
  const route = SRV.slice(SRV.indexOf('app.get("/api/garment-category"'), SRV.indexOf("/* GET /api/garment-box"));
  check("§5.1 /api/garment-category answers source \"ai\" for a model verdict (the cache row keeps its own provenance)",
    /source: verdict\.source === "gemini" \? "ai" : verdict\.source,/.test(route) && !/\bsource: verdict\.source,/.test(route));
}

console.log(fails === 0 ? "\nclassify-reply: OK" : `\nclassify-reply: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
