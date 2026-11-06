/* THE FIT CLAUSE IS NEVER DROPPED SILENTLY (2026-11-06, Yair's decision - CLAUDE.md §0, lib/prompts.js fitPrompt()).
   Under budget pressure fitPrompt() sheds the least critical part first (the highest P number), so the size sentence
   (P.MED) goes only after every P.LOW/P.TRIM part is gone - and when it goes, it is logged: one [PEAR] line with the
   clause, the budget and the final length, and a {clause, budget, length} entry in promptWithShedForRequest().shedLog.
   §1 the real closure-lock path; §2 (a) the fit clause is kept when cutting less critical parts is enough; §3 (b) the
   fit clause goes after them, and is logged; §4 nothing fits-and-logs, the wire is unchanged, the relay's names too. */
import * as P from "../lib/prompts.js";
import { expandPromptToken, promptTokenForRequest } from "../lib/prompt-token.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
/* Every console.warn while fn runs, captured (the line is part of the decision, so it is asserted, not only seen). */
function warnsOf(fn) {
  const seen = [], orig = console.warn;
  console.warn = (...a) => { seen.push(a.join(" ")); };
  try { return { value: fn(), warns: seen }; } finally { console.warn = orig; }
}
const fitWarns = (warns) => warns.filter((w) => /the fit clause was shed/.test(w));

const CLOSURE_TOP = { name: "Oxford shirt", title: "button down oxford shirt", category: "top", garmentType: "upper_body",
  __bottoms: false, colorHex: "#111111", textOcr: "BE YOUR OWN Healer WORLDWIDE" };
const PLAIN_TEE = { name: "Basic tee", title: "basic cotton t-shirt", category: "top", garmentType: "upper_body", __bottoms: false };
const req = (item, angle, delta) => P.sanitizePromptRequest({ kind: "single", item, angle, delta });

console.log("\n── §1 the closure-lock path, as a shopper's request ships ──");
{
  const r = req(CLOSURE_TOP, "front", -2);
  const { value, warns } = warnsOf(() => P.promptWithShedForRequest(r));
  const budget = value.shedLog[0] && value.shedLog[0].budget;
  check("§1.1 a closure top with facts at -2 sheds the fit clause, and only it", value.shed.join() === "fit", value.shed.join());
  check("§1.2 the closure lock is kept (it outranks the fit clause - P.HIGH over P.MED)", /front closure exactly/.test(value.prompt));
  check("§1.3 the shed log names the clause, the budget and the length that ships",
    value.shedLog.length === 1 && value.shedLog[0].clause === "fit" && budget >= 600 && value.shedLog[0].length === value.prompt.length,
    JSON.stringify(value.shedLog));
  check("§1.4 ...within the budget", value.prompt.length <= budget, `${value.prompt.length} > ${budget}`);
  check("§1.5 one [PEAR] line says so, with the budget and the final length",
    fitWarns(warns).length === 1 && fitWarns(warns)[0].startsWith("[PEAR]") &&
    fitWarns(warns)[0].includes(`budget ${budget}`) && fitWarns(warns)[0].includes(`final ${value.prompt.length} chars`), warns.join(" | "));
  check("§1.6 the line carries no prompt words (§7.21)", !/closure exactly|Fabric:|Fit:|Healer/.test(warns.join(" ")));
  const plain = warnsOf(() => P.promptForRequest(r));
  check("§1.7 promptForRequest() logs it too - no path sheds it silently", fitWarns(plain.warns).length === 1, plain.warns.join(" | "));
}

console.log("\n── §2 (a) the fit clause is kept while cutting less critical parts is enough ──");
{
  const anchor = "A".repeat(200), closure = "C".repeat(100), fit = "F".repeat(100), low = "L".repeat(100), trim = "T".repeat(100);
  const parts = () => [[P.P.CORE, anchor], [P.P.HIGH, closure], [P.P.MED, fit], [P.P.LOW, low], [P.P.TRIM, trim]];
  // 200+100+100+100+100 + 4 spaces = 604. Dropping TRIM and LOW leaves 402.
  const { value: out, warns } = warnsOf(() => P.fitPrompt(parts(), 450));
  check("§2.1 TRIM and LOW go, the fit clause and the closure lock stay", out.includes(fit) && out.includes(closure) && !out.includes(low) && !out.includes(trim), out.length);
  check("§2.2 no fit line when the fit clause survives", fitWarns(warns).length === 0, warns.join(" | "));
  const one = warnsOf(() => P.fitPrompt(parts(), 503));
  check("§2.3 only TRIM needs to go: the fit clause and LOW both stay", one.value.includes(fit) && one.value.includes(low) && !one.value.includes(trim));
  check("§2.4 the same parts in another order shed the same way (priority, not position)",
    P.fitPrompt([[P.P.MED, fit], [P.P.LOW, low], [P.P.CORE, anchor], [P.P.HIGH, closure]], 402).includes(fit));
}

console.log("\n── §3 (b) at an extreme budget the fit clause goes after them, and is logged ──");
{
  const anchor = "A".repeat(200), closure = "C".repeat(100), fit = "F".repeat(100), low = "L".repeat(100), trim = "T".repeat(100);
  // 302 = anchor + closure: everything below the closure lock has to go.
  const { value: out, warns } = warnsOf(() => P.fitPrompt([[P.P.CORE, anchor], [P.P.MED, fit], [P.P.HIGH, closure], [P.P.TRIM, trim], [P.P.LOW, low]], 302));
  check("§3.1 the fit clause is dropped; the closure lock stays", !out.includes(fit) && out.includes(closure));
  check("§3.2 one [PEAR] line, the clause shed LAST of the less critical ones, budget and final length",
    fitWarns(warns).length === 1 && fitWarns(warns)[0].includes("budget 302") && fitWarns(warns)[0].includes(`final ${out.length} chars`) &&
    /shed in order: low, low, fit\)/.test(fitWarns(warns)[0]), warns.join(" | "));
  /* the request log, through a real request where the tightest budget holds: CORE alone over budget is clamped, and the
     fit clause - and the closure lock after it - are on the log in that order */
  const all = warnsOf(() => P.fitPrompt([[P.P.CORE, anchor], [P.P.HIGH, closure], [P.P.MED, fit]], 150));
  check("§3.3 when nothing but CORE is left, the fit line still comes, then the clamp", fitWarns(all.warns).length === 1 &&
    /shed in order: fit, closure\)/.test(fitWarns(all.warns)[0]) && all.value.length <= 150, all.warns.join(" | "));
}

console.log("\n── §4 nothing else moves ──");
{
  const fits = warnsOf(() => P.promptWithShedForRequest(req(PLAIN_TEE, "back", 0)));
  check("§4.1 a prompt that fits sheds nothing and logs nothing", fits.value.shed.length === 0 && fits.value.shedLog.length === 0 && fitWarns(fits.warns).length === 0);
  let diff = 0, shedRungs = 0, n = 0;
  warnsOf(() => {
    for (const item of [CLOSURE_TOP, PLAIN_TEE]) for (const angle of ["front", "back"]) for (const d of [-2, -1, 0, 1, 2]) {
      const r = req(item, angle, d), a = P.promptWithShedForRequest(r);
      n++;
      if (a.prompt !== P.promptForRequest(r)) diff++;
      if (a.shed.includes("fit")) shedRungs++;
      if (a.shed.length !== a.shedLog.length) diff++;
    }
  });
  check(`§4.2 the words are promptForRequest()'s on all ${n} rungs, one log entry per shed name (${shedRungs} rungs shed the fit clause)`, diff === 0 && shedRungs > 0);
  const t = warnsOf(() => expandPromptToken(promptTokenForRequest(req(CLOSURE_TOP, "front", -2)))).value;
  check("§4.3 the relay's record is unchanged: names only", t && t.shed.join() === "fit" && !("shedLog" in t));
}

console.log("\n── §5 the closure lock outranks the fit clause (Yair's decision, 2026-11-07) - the real engine at a squeezed budget ──");
{
  /* The real lib/prompts.js, its budget swapped: CONFIG is frozen and read once at load, so the engine is loaded again
     from its own source with only the config import replaced. Everything else - imageOnlyPrompt()'s parts and their
     priorities, fitPrompt() - is the shipped text. A shirt rendered hanging open is worse than an imprecise fit. */
  const { readFileSync } = await import("node:fs");
  const SRC = readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8");
  const IMPORT = 'import { CONFIG } from "../fitting-room/config.js";';
  check("§5.0 the engine's config import is where the harness expects it", SRC.split(IMPORT).length === 2);
  const engineAt = (budget) => import("data:text/javascript," + encodeURIComponent(
    SRC.replace(IMPORT, `const CONFIG = { PROMPT_MAX_CHARS: ${budget} };`) + `\n// budget ${budget}`));
  const r = { kind: "single", item: CLOSURE_TOP, angle: "front", delta: 0 };
  const E = await engineAt(300);
  const { value, warns } = warnsOf(() => E.promptWithShedForRequest(E.sanitizePromptRequest(r)));
  check("§5.1 at an extreme budget both go - the fit clause FIRST, then the closure lock", value.shed.join() === "fit,closure", value.shed.join());
  check("§5.2 the fit line names that order, the budget and what shipped",
    fitWarns(warns).length === 1 && /shed in order: fit, closure\)/.test(fitWarns(warns)[0]) && fitWarns(warns)[0].includes("budget 300"), warns.join(" | "));
  /* a budget the closure lock fits in but the fit sentence does not: only the fit clause goes */
  const noFacts = { ...CLOSURE_TOP, colorHex: undefined, textOcr: undefined };
  const kept = P.promptWithShedForRequest(P.sanitizePromptRequest({ ...r, item: noFacts }));
  check("§5.3 (a closure top without facts fits whole at the real budget)", kept.shed.length === 0 && /front closure exactly/.test(kept.prompt), kept.shed.join());
  const E2 = await engineAt(kept.prompt.length - 1);
  const mid = warnsOf(() => E2.promptWithShedForRequest(E2.sanitizePromptRequest({ ...r, item: noFacts }))).value;
  check("§5.4 one char short: the fit clause goes, the closure lock stays", mid.shed.join() === "fit" && /front closure exactly/.test(mid.prompt), mid.shed.join());
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
