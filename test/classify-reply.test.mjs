/* THE WHOLE REPLY (2026-10-31). The classifier read parts[0] of Gemini's reply alone; CHICAGO 3108650200's front verdict was
   cut at `"cue":"drawstring waistband and front-fa`, logged "unparseable" and saved as an uncertain FRONT with no colour and no
   lettering AT THE CURRENT PROMPT VERSION - never asked again. §1 runs server.js's reader on replies of every shape, §2 pins that a
   non-answer is saved un-versioned (so it is re-asked), §3 that the version moved past the rows written before the fix. */
import { readFileSync } from "node:fs";
const SRV = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const a = SRV.indexOf("/* ── THE WHOLE REPLY (2026-10-31)");
const b = SRV.indexOf("/* Classify one image. Returns the full record", a);  // the reader, the parser and salvageGeminiFields()
const { geminiReplyText, parseGeminiJson } = new Function(SRV.slice(a, b) + "\nreturn { geminiReplyText, parseGeminiJson };")();
const reply = (...parts) => ({ candidates: [{ content: { parts } }] });
const answer = { view: "front", confidence: 1, age_group: "kids", age_group_confidence: 0.95, cue: "drawstring waistband and front-facing logo",
  text_ocr: "CHICAGO", is_true_back_view: false, has_graphic: true, primary_color_hex: "#111111" };
const json = JSON.stringify(answer);

console.log("\n── §1 the reply, whole ──");
{
  const cut = json.indexOf("front-fa") + 8;
  const split = parseGeminiJson(geminiReplyText(reply({ text: json.slice(0, cut) }, { text: json.slice(cut) })));
  check("§1.1 an answer split over two parts parses whole - the CHICAGO reply (colour and lettering kept)",
    split && split.primary_color_hex === "#111111" && split.text_ocr === "CHICAGO", JSON.stringify(split));
  let oldReader = null; try { oldReader = JSON.parse(json.slice(0, cut)); } catch (_) { /* the old reader's failure */ }
  check("§1.2 ...where the first part alone does not parse (the old reader: JSON.parse of parts[0])", oldReader === null);
  const thought = parseGeminiJson(geminiReplyText(reply({ text: "Looking at the waistband...", thought: true }, { text: json })));
  check("§1.3 a thinking part is skipped", thought && thought.view === "front");
  check("§1.4 one part, as before", parseGeminiJson(geminiReplyText(reply({ text: json }))).view === "front");
  check("§1.5 a fenced or prefixed body is cut to its object", parseGeminiJson("```json\n" + json + "\n```").text_ocr === "CHICAGO");
  check("§1.6 nothing usable is null, never a throw",
    parseGeminiJson(geminiReplyText({})) === null && parseGeminiJson("not json") === null && geminiReplyText(reply()) === "");
}

console.log("\n── §1b A BOUNDED ANSWER - the loop the CHICAGO front really was ──");
{
  check("§1b.1 the reply is capped (it ran 65,656 chars / ~2 minutes, finish MAX_TOKENS)", /maxOutputTokens: \d{3,4},/.test(SRV));
  const order = (SRV.match(/propertyOrdering: \[([^\]]+)\]/) || [])[1] || "";
  const names = order.match(/"([a-z_]+)"/g) || [];
  check("§1b.2 cue is the LAST field, the colour and lettering before it", names[names.length - 1] === '"cue"' &&
    names.indexOf('"primary_color_hex"') < names.indexOf('"cue"') && names.indexOf('"text_ocr"') < names.indexOf('"cue"'), order);
  const tpl = (SRV.match(/Respond ONLY with JSON matching this schema:\n(\{.*\})`;/) || [])[1] || "";
  check("§1b.3 ...and the prompt's template says the same order", /"text_ocr":[^}]*"cue":"[^"]*"\}$/.test(tpl) && tpl.indexOf("primary_color_hex") < tpl.indexOf('"cue"'), tpl);
  const loop = '{"view":"front","confidence":1.0,"age_group":"kids","age_group_confidence":0.95,"primary_color_hex":"#1b1b1d",' +
    '"has_graphic":true,"is_true_back_view":false,"text_ocr":"CHICAGO 23","cue":"drawstring waistband and front-fa 23 23 23 23 23';
  const got = parseGeminiJson(loop);
  check("§1b.4 a reply cut inside a looping cue keeps every completed field - the verdict, colour and lettering",
    got && got.view === "front" && got.primary_color_hex === "#1b1b1d" && got.text_ocr === "CHICAGO 23" && got.has_graphic === true && !("cue" in got),
    JSON.stringify(got));
  check("§1b.5 a string cut before its closing quote is not kept", !("text_ocr" in (parseGeminiJson('{"view":"back","text_ocr":"CHIC') || {})));
  check("§1b.6 no view, no answer", parseGeminiJson('{"confidence":1.0,"primary_color_hex":"#000000","cue":"x x') === null);
  const esc = parseGeminiJson('{"view":"front","text_ocr":"SAY \\"HI\\"","cue":"a');
  check("§1b.7 an escaped quote inside a completed string decodes", esc && esc.text_ocr === 'SAY "HI"', JSON.stringify(esc));
}

console.log("\n── §2 a non-answer is asked again ──");
{
  check("§2.1 the unparseable record says so", /cue: "unparseable response",[\s\S]{0,200}unparseable: true,/.test(SRV));
  const saves = SRV.match(/classifierVersion: (rec|detail)\.unparseable \? null : CLASSIFIER_PROMPT_VERSION,/g) || [];
  check("§2.2 both fresh-classification saves leave it un-versioned (stale -> re-classified)", saves.length === 2, String(saves.length));
  check("§2.3 no fresh save stamps a non-answer with the version",
    !/classifyFrontBackDetailed\(imageUrl\);[\s\S]{0,700}classifierVersion: CLASSIFIER_PROMPT_VERSION,/.test(SRV));
  check("§2.4 the reader is the whole reply, not parts[0]", /const text = geminiReplyText\(data\);/.test(SRV));
}

console.log("\n── §3 the rows written before the fix ──");
{
  const v = Number((SRV.match(/const CLASSIFIER_PROMPT_VERSION = (\d+);/) || [])[1]);
  check("§3.1 the prompt version moved past 3 (the cut answers were stamped v3)", v >= 4, String(v));
}

console.log(fails === 0 ? "\nclassify-reply: OK" : `\nclassify-reply: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
