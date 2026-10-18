#!/usr/bin/env node
/* ============================================================================
   trace-prompt.mjs — what ACTUALLY reaches Decart
   ----------------------------------------------------------------------------
   The repo is in strict image-only conditioning mode: buildPrompt(),
   buildCustomPrompt() and buildCompositePrompt() all return imageOnlyPrompt(),
   and a large family of clause builders (fitSentence, getFabricModifier,
   getAnatomicalAnchor, QUALITY_SUFFIX, HEM_DETAIL, most of DENSE) is retained
   as a restore seam but has no path to the wire.

   That is invisible when reading app.js top-down, and it is the single most
   expensive thing to get wrong: editing a dead clause looks exactly like
   fixing the render, right up until nothing changes on screen.

   This prints the real wire strings for every branch, plus a dead-clause
   audit. Run it BEFORE and AFTER any prompt edit. Byte-identical output means
   the edit changed nothing Decart will ever see.

   Usage:  node trace-prompt.mjs [path/to/app.js]
           node trace-prompt.mjs --json      (machine-readable, for CI diffing)
   ============================================================================ */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join as joinPath } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
/* The prompt engine lives in lib/prompts.js since 2026-09-26 (server-side - CLAUDE.md
   §2.13). An app.js path still works: the pre-commit hook traces HEAD's app.js for the
   commit that moved the engine, and any older checkout traces the same way it always did. */
const APP = resolve(args.find((a) => !a.startsWith("--")) ?? "lib/prompts.js");

if (!existsSync(APP)) {
  console.error(`✖ app.js not found at: ${APP}`);
  console.error(`  Pass an explicit path:  node trace-prompt.mjs path/to/app.js`);
  process.exit(2);
}
const src = readFileSync(APP, "utf8");

/* ── extract a top-level `const NAME = ...;` / `function NAME(...)` body ──────
   Deliberately regex-based rather than importing app.js: app.js is a browser
   script with ~15k lines of DOM-coupled module scope, and executing it here
   would need a full jsdom + WebRTC + Decart SDK stub. We only need the frozen
   string literals and the small pure selectors around them. */
function constBlock(name) {
  const re = new RegExp(`^const ${name}\\s*=([\\s\\S]*?);\\s*$`, "m");
  const m = re.exec(src);
  return m ? m[1] : null;
}

/* Source text of a top-level `function NAME(...) {...}`, by brace matching, from the
   RAW source. Comment-stripped `code` (built further down for the reachability walk)
   is not usable here: this text gets EVALUATED, and stripping comments out of a body
   containing regex literals can desynchronise and corrupt the code being run. */
function functionSource(name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function ${name}\\s*\\(`, "");
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index + m[0].length);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
  }
  return null;
}

/* Evaluate a literal-only expression (string concat / Object.freeze of strings).
   Anything referencing an identifier we haven't resolved throws, and we report
   that rather than guessing. */
function evalLiteral(expr, scope = {}) {
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `"use strict"; return (${expr});`);
  return fn(...keys.map((k) => scope[k]));
}

/* ── resolve PROMPT_MAX_CHARS — no silent numeric default ──────────────────
   app.js does not declare this as a top-level const; it destructures it from
   CONFIG in config.js (same directory as app.js). If a future edit promotes
   it back to a module const, path 1 below picks that up automatically and
   path 2 is never consulted. If neither source can be found, this is a hard
   failure, not a guess — a budget checker that can't find the budget must
   not report headroom against a number it made up. */
function resolvePromptMaxChars() {
  const searched = [];

  const b = constBlock("PROMPT_MAX_CHARS");
  if (b) {
    searched.push(`${APP} (top-level const)`);
    // "kind" is deliberately path-free: --json is diffed HEAD-vs-staged from
    // two different filesystem locations (a /tmp snapshot vs the real repo),
    // and an absolute path here would make every commit touching app.js look
    // like it changed the wire, even when only a comment moved.
    return { value: Number(evalLiteral(b)), source: `${APP} (const)`, kind: "app.js const" };
  }
  searched.push(`${APP} (no top-level const PROMPT_MAX_CHARS)`);

  /* Beside app.js (the old layout), or ../fitting-room/config.js beside lib/prompts.js
     (which imports it from there). First one that exists wins. */
  const configPath = [joinPath(dirname(APP), "config.js"), joinPath(dirname(APP), "..", "fitting-room", "config.js")]
    .find((p) => existsSync(p)) || joinPath(dirname(APP), "config.js");
  searched.push(configPath);
  if (existsSync(configPath)) {
    const configSrc = readFileSync(configPath, "utf8");
    const m = /\bPROMPT_MAX_CHARS\s*:\s*(\d+)/.exec(configSrc);
    if (m) return { value: Number(m[1]), source: configPath, kind: "config.js property" };
    searched[searched.length - 1] += " (found, but no PROMPT_MAX_CHARS: <n> property)";
  } else {
    searched[searched.length - 1] += " (not found)";
  }

  console.error(`✖ could not resolve PROMPT_MAX_CHARS. Searched:`);
  for (const s of searched) console.error(`  - ${s}`);
  console.error(`  This tracer refuses to guess a budget — a wrong guess would report`);
  console.error(`  headroom on an over-budget prompt and green-light a bad commit.`);
  process.exit(2);
}

const { value: PROMPT_MAX_CHARS, source: PROMPT_MAX_CHARS_SOURCE, kind: PROMPT_MAX_CHARS_KIND } = resolvePromptMaxChars();

/* ── resolve the anchors ──────────────────────────────────────────────────── */
const NEEDED = [
  "STRICT_REFERENCE_LOCK", "PLAIN_TEE_ANCHOR", "FRONT_CLOSURE_LOCK",
  "CATEGORY_ANCHOR", "BACK_CATEGORY_ANCHOR", "PLAIN_BACK_ANCHOR", "LOOK_ANCHOR",
  "VOLUME_PERSISTENCE", "CLOSED_BACK_HEM",
];

const scope = {};
const unresolved = [];
// Two passes: later constants concatenate earlier ones (e.g. anchors embed
// STRICT_REFERENCE_LOCK), so a single ordered pass can miss forward refs.
for (let pass = 0; pass < 2; pass++) {
  for (const name of NEEDED) {
    if (name in scope) continue;
    const body = constBlock(name);
    if (!body) { if (pass) unresolved.push(`${name} (not found)`); continue; }
    try { scope[name] = evalLiteral(body, scope); }
    catch (e) { if (pass) unresolved.push(`${name} (${e.message})`); }
  }
}

/* ── the wire branches, mirroring imageOnlyPrompt()'s selector logic ─────────
   THE BUG THIS CLOSES - and it was a bug in the VERIFIER, which is worse than a
   bug in the code it checks, because it reports success either way.

   This array used to hold flat, pre-joined strings: one per branch, anchor plus
   closure lock, and nothing else. That was accurate when the file went strict
   image-only and every branch really was a single frozen anchor. It stopped being
   accurate on 2026-09-03, when fitSentence() was restored into imageOnlyPrompt()
   as `[P.MED, fitSentence(...)]` (see that function's SIZE-OVERRIDE RESTORE note).
   The reachability audit below picked the restore up immediately - it walks the
   call graph, so it correctly flipped fitSentence to "live" - but the PRINTED WIRE
   STRINGS did not, because they are a hand-maintained mirror and nobody updated
   the mirror.

   The consequence is the exact failure this tool exists to prevent, inverted: it
   under-reported every single-garment branch by up to ~230 characters and printed
   generous "free" figures against a budget that was actually much tighter. Anyone
   sizing a restore off "312 free chars on tops" was sizing it off a number that
   omitted a live clause. CLAUDE.md §0's hand-computed "338-644 chars on tops"
   range was right; this tool's output was not, and the two disagreeing is what
   made the discrepancy visible at all.

   SO THE BRANCHES ARE NOW PRIORITY-TAGGED PARTS, not strings, and the renderer
   below reimplements fitPrompt()'s shedding. A tracer that models the budget has
   to model the shedding too: the whole question "does this clause reach Decart"
   has a DIFFERENT ANSWER per size delta on a branch that also carries the closure
   lock, and a single number cannot express that. */
const A = scope.CATEGORY_ANCHOR ?? {};
const B = scope.BACK_CATEGORY_ANCHOR ?? {};
/* The plain-rear variant, selected when the server positively established a blank back
   (generated rear, or a real rear photo the classifier transcribed as empty). Traced as
   its own rows because it is a DIFFERENT string on the wire, and because the whole point
   of the change is that it is SHORTER than the pair it replaces - a claim this table is
   the only honest place to check. */
const PB = scope.PLAIN_BACK_ANCHOR ?? {};
const closure = scope.FRONT_CLOSURE_LOCK ?? "";

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/* P tiers, mirroring app.js. CORE is undroppable; fitPrompt() sheds the highest
   NUMBER first, one whole clause at a time. */
const P = { CORE: 0, HIGH: 1, MED: 2, LOW: 3, TRIM: 4 };

/* getFitModifier(), lifted from app.js and RUN rather than re-tabulated here.
   A copied table is a second source of truth that goes stale exactly the way the
   branch strings above did - and the wording of these strings is load-bearing
   (CLAUDE.md §2.4: tightness attributes to the fabric, never the body outline),
   so a paraphrase in the verifier would be worse than no verifier. */
const fitModSrc = functionSource("getFitModifier");
let getFitModifier = null;
if (fitModSrc) {
  try { getFitModifier = evalLiteral(`(${fitModSrc})`); }
  catch (e) { unresolved.push(`getFitModifier (${e.message})`); }
} else {
  unresolved.push("getFitModifier (not found)");
}

/* fitSentence() minus its getSizeDelta() UI read - the delta is supplied here so
   every rung of the size ladder can be traced, not just whichever one the browser
   happens to be showing. */
const fitSentence = (garmentType, delta) => {
  if (!getFitModifier) return "";
  const mod = getFitModifier(delta, garmentType);
  return mod ? `Fit: ${String(mod).trim()}.` : "";
};

/* colorLockSentence(), lifted and run like getFitModifier above. Traced with a
   REPRESENTATIVE sampled colour rather than omitted: this clause is live, its value
   arrives per product (server primary_color_hex -> widget -> item.colorHex), and the
   branch table's entire purpose is to not under-report a live clause - which is the
   bug this file's `branches` comment documents. A product whose colour could not be
   sampled ships the branch without it, so the ladder below is the WORST case of the
   two, which is the one worth budgeting against. */
const colorSrc = functionSource("identityLockSentence");
const printSrc = functionSource("garmentPrintText");
const colorNameSrc = functionSource("colorNameFromHex");
/* FABRIC_COLOR_NAMES, not COLOR_NAMES: app.js has a separate human-facing label palette
   under the latter name (backing colorName(), which always answers and falls back to
   "neutral"). Resolving the wrong one here would trace this clause against a table it
   does not use - and the two names collided at module scope until the fabric one was
   prefixed, which is a load-time SyntaxError the sandboxed suites cannot see. */
const colorNamesBlock = constBlock("FABRIC_COLOR_NAMES");
/* A REPRESENTATIVE product, chosen to be the realistic WORST case rather than a
   convenient one: a sampled white fabric plus a 28-character chest slogan, which is the
   garment from the report this lock was built for. Both halves present is the longest
   this clause ever gets on the front branch, and the front branch is where it is
   longest - so the ladder below budgets against the real ceiling. */
const TRACE_ITEM = { colorHex: "#ffffff", textOcr: "BE YOUR OWN Healer WORLDWIDE" };
let identityLockFront = "", identityLockBack = "";
if (colorSrc && printSrc && colorNameSrc && colorNamesBlock) {
  try {
    /* Every gate constant colorNameFromHex() reads has to come along, or the eval throws
       a ReferenceError and this clause silently drops out of the trace - which is the
       exact class of omission the `branches` comment above is a post-mortem of. Listed
       explicitly rather than regex-swept so a NEW gate constant fails loudly here
       instead of quietly disabling the row. */
    const deps = ["FABRIC_COLOR_MAX_DIST", "FABRIC_COLOR_MIN_MARGIN",
                  "FABRIC_NEUTRAL_CHROMA_MAX", "FABRIC_NEUTRAL_NAMES",
                  "IDENTITY_LOCK_MAX_CHARS", "PRINT_TEXT_MAX_CHARS"];
    const decls = deps.map((n) => {
      const b = constBlock(n);
      if (!b) throw new Error(`${n} not found (a colour gate constant was renamed?)`);
      return `const ${n} = ${b};`;
    }).join("\n");
    const mk = new Function(
      `"use strict";
       const FABRIC_COLOR_NAMES = ${colorNamesBlock};
       ${decls}
       ${colorNameSrc}
       ${printSrc}
       ${colorSrc}
       return identityLockSentence;`
    )();
    identityLockFront = mk(TRACE_ITEM, "front") || "";
    identityLockBack  = mk(TRACE_ITEM, "back") || "";
    if (!identityLockFront) unresolved.push("identityLockSentence (returned empty for the trace item)");
  } catch (e) { unresolved.push(`identityLockSentence (${e.message})`); }
} else {
  unresolved.push("identityLockSentence (not found)");
}

/* The size ladder, worst case first. -2 is the longest phrasing on both garment
   types and therefore the one that sheds first; 0 is what a shopper who never
   touches the picker gets. */
const DELTAS = [-2, -1, 0, 1, 2];
const deltaLabel = (d) => (d === 0 ? "true-to-size" : d < 0 ? `size down ${-d}` : `size up ${d}`);

/* fitPrompt()'s shedding, reimplemented. Keep this byte-faithful to app.js:
   render → while over budget, drop one whole clause at the highest priority
   number → stop when only CORE remains → hard-clamp. */
function fitPromptTrace(parts, max = PROMPT_MAX_CHARS) {
  let keep = parts.filter(([, text]) => text && String(text).trim());
  const render = (list) => list.map(([, t]) => String(t).trim()).join(" ").replace(/\s+/g, " ").trim();
  const shed = [];
  let out = render(keep);
  while (out.length > max) {
    const worst = Math.max(...keep.map(([p]) => p));
    if (worst === P.CORE) break;
    const i = keep.findIndex(([p]) => p === worst);
    shed.push(keep[i][2] ?? `P${worst}`);
    keep.splice(i, 1);
    out = render(keep);
  }
  const clamped = out.length > max;
  if (clamped) out = out.slice(0, max).trim();
  return { wire: out, shed, clamped };
}

/* Each branch is the part list imageOnlyPrompt() assembles for it, as
   [priority, text, name]. `fit` names the garment type for fitSentence(); a branch
   with fit:null has no size clause (the full-look path does not route through
   imageOnlyPrompt - see buildLookPrompt). */
const branches = [
  { id: "top / front / plain knit tee",       fit: "upper_body",
    parts: [[P.CORE, scope.PLAIN_TEE_ANCHOR, "PLAIN_TEE_ANCHOR"]] },
  /* KEPT, and it is NOT REACHABLE IN PRODUCTION - see the note in the printout.
     isPlainKnitTop() and hasFrontClosure() are mutually exclusive by construction,
     so this row is a synthetic worst case, retained because it is the tightest
     arithmetic in the file and a future edit to either predicate could make it real. */
  { id: "top / front / plain tee + closure",  fit: "upper_body", synthetic: true,
    parts: [[P.CORE, scope.PLAIN_TEE_ANCHOR, "PLAIN_TEE_ANCHOR"],
            [P.HIGH, closure, "FRONT_CLOSURE_LOCK"]] },
  { id: "top / front / structured",           fit: "upper_body",
    parts: [[P.CORE, A.top, "CATEGORY_ANCHOR.top"]] },
  { id: "top / front / structured + closure", fit: "upper_body",
    parts: [[P.CORE, A.top, "CATEGORY_ANCHOR.top"],
            [P.HIGH, closure, "FRONT_CLOSURE_LOCK"]] },
  { id: "top / back (rear print)",             fit: "upper_body",
    parts: [[P.CORE, B.top, "BACK_CATEGORY_ANCHOR.top"]] },
  { id: "top / back (PLAIN rear)",             fit: "upper_body",
    parts: [[P.CORE, PB.top, "PLAIN_BACK_ANCHOR.top"]] },
  { id: "bottoms / front",                    fit: "lower_body",
    parts: [[P.CORE, A.bottom, "CATEGORY_ANCHOR.bottom"]] },
  { id: "bottoms / back (rear print)",         fit: "lower_body",
    parts: [[P.CORE, B.bottom, "BACK_CATEGORY_ANCHOR.bottom"]] },
  { id: "bottoms / back (PLAIN rear)",         fit: "lower_body",
    parts: [[P.CORE, PB.bottom, "PLAIN_BACK_ANCHOR.bottom"]] },
  { id: "full look",                          fit: null,
    parts: [[P.CORE, scope.LOOK_ANCHOR, "LOOK_ANCHOR"],
            [P.HIGH, scope.STRICT_REFERENCE_LOCK, "STRICT_REFERENCE_LOCK"],
            [P.HIGH, scope.VOLUME_PERSISTENCE, "VOLUME_PERSISTENCE"],
            [P.MED,  scope.CLOSED_BACK_HEM, "CLOSED_BACK_HEM"]] },
];

/* Render every branch across the whole size ladder. `rows` is the per-delta detail;
   `wire`/`base` keep the old single-string shape so the --json consumers and the
   before/after diff habit still work. */
/* The identity lock is a SECOND P.CORE part on every single-garment branch, inserted
   right after the anchor exactly as imageOnlyPrompt() orders it - order matters because
   fitPrompt() breaks priority ties by array position, and because a CORE overflow is
   hard-sliced from the END. The BACK branches get the back variant, which withholds the
   print half (front lettering asserted over a back reference is the double-print bug).
   The full-look path does not route through imageOnlyPrompt() and gets none. */
for (const b of branches) {
  if (b.fit) {
    const lock = /\bback\b/.test(b.id) ? identityLockBack : identityLockFront;
    if (lock) b.parts = [b.parts[0], [P.CORE, lock, "identityLock"], ...b.parts.slice(1)];
  }
  b.base = norm(b.parts.map(([, t]) => t).filter(Boolean).join(" "));
  b.rows = (b.fit ? DELTAS : [0]).map((d) => {
    const parts = b.fit
      ? [...b.parts,
         [P.MED, fitSentence(b.fit, d), "fitSentence"],
         ]
      : b.parts;
    const r = fitPromptTrace(parts);
    return { delta: d, label: b.fit ? deltaLabel(d) : "n/a", ...r, len: r.wire.length };
  });
  /* The headline string is the DEFAULT dispatch: the shopper who never touches the
     size picker. Deliberately not the worst case - the worst case is in the table. */
  const def = b.rows.find((r) => r.delta === 0) ?? b.rows[0];
  b.wire = def.wire;
}

/* ── dead-clause audit — REACHABILITY, not a reference count ──────────────────
   A plain "how many times is this name mentioned" count gets the important case
   backwards. A clause can have a real call site and still never reach the wire,
   because its only CALLER is itself unreachable. getFabricModifier() is the live
   example today: it is called, but only from builders nothing dispatches.

   (getFitModifier() used to be the example named here, via fitSentence(). Both are
   reachable as of the 2026-09-03 restore and the audit reports them live — the
   comment is updated rather than deleted because the transitive SHAPE it describes
   is what this walk exists to catch, whichever clause currently occupies it.)

   So the audit walks the call graph from the builders that genuinely reach Decart
   and reports what is NOT reachable from them.

   Comments are stripped (a name discussed in prose is not a call site). String
   literals are deliberately NOT stripped: app.js contains regex literals holding
   unbalanced quotes, and a naive string-stripper desynchronises on them and eats
   live code — which silently reports live clauses as dead, the worst possible
   failure for this tool. Identifier names colliding with string contents is the
   far cheaper risk. */
const LIVE_ROOTS = ["imageOnlyPrompt", "lookAnchorPrompt"];

const AUDIT = [
  "fitSentence", "getFitModifier", "getFabricModifier", "getAnatomicalAnchor",
  "QUALITY_SUFFIX", "HEM_DETAIL", "KEEP_TOP", "KEEP_BOTTOMS",
  "MODEL_AGNOSTIC_EXTRACTION", "STRICT_REFERENCE_LOCK", "FRONT_CLOSURE_LOCK",
  /* The colour lock, audited like every other clause: it is threaded from per-product
     classifier data through three files, so "is it actually reachable from a builder"
     is a real question rather than a formality. KEEP_OPPOSITE_LAYER is here too because
     app.js's restore notes claimed for several revisions that it was on the wire when it
     never was - the kind of false belief this audit exists to make unmaintainable. */
  "identityLockSentence", "garmentPrintText", "colorNameFromHex", "KEEP_OPPOSITE_LAYER",
];

const code = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\r\n]*/g, " ");

/* Body of a top-level `function NAME(...) { ... }`, by brace matching. */
function functionBody(name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function ${name}\\s*\\(`, "");
  const m = re.exec(code);
  if (!m) return null;
  let i = code.indexOf("{", m.index + m[0].length);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}" && --depth === 0) return code.slice(i, j + 1);
  }
  return null;
}

/* BFS the call graph from the live builders. */
const reachable = new Set();
const queue = [...LIVE_ROOTS];
const CANDIDATES = [...new Set([...AUDIT, ...LIVE_ROOTS, "fitPrompt"])];
while (queue.length) {
  const fn = queue.shift();
  if (reachable.has(fn)) continue;
  reachable.add(fn);
  const body = functionBody(fn);
  if (!body) continue;
  for (const name of CANDIDATES) {
    if (!reachable.has(name) && new RegExp(`\\b${name}\\b`).test(body)) queue.push(name);
  }
}

const audit = AUDIT.map((name) => {
  const refs = (code.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  const live = reachable.has(name);
  // Referenced somewhere, but not from a live builder → the transitive trap.
  const orphaned = !live && refs > 1;
  return { name, refs, dead: !live, orphaned };
});

/* ── output ───────────────────────────────────────────────────────────────── */
if (asJson) {
  console.log(JSON.stringify({ promptMaxChars: PROMPT_MAX_CHARS, promptMaxCharsKind: PROMPT_MAX_CHARS_KIND, branches, audit, unresolved }, null, 2));
  process.exit(0);
}

const bar = "─".repeat(74);
console.log(`\n🍐 PEAR — strings that actually reach Decart`);
console.log(`   source: ${APP}`);
console.log(`   budget: ${PROMPT_MAX_CHARS} chars (${PROMPT_MAX_CHARS_SOURCE})\n${bar}`);

let over = 0;
let shedding = 0;
for (const b of branches) {
  if (!b.base) { console.log(`\n▸ ${b.id}\n  ⚠ could not resolve — check the constant names in NEEDED`); continue; }
  const n = b.wire.length;
  const flag = n > PROMPT_MAX_CHARS ? "  ✖ OVER BUDGET" : "";
  if (n > PROMPT_MAX_CHARS) over++;
  console.log(`\n▸ ${b.id}  [${n}/${PROMPT_MAX_CHARS}, ${PROMPT_MAX_CHARS - n} free]${flag}` +
    (b.synthetic ? "   (synthetic — predicates are mutually exclusive)" : ""));
  console.log(`  ${b.wire}`);

  /* THE SIZE LADDER. A single number per branch cannot express this: the fit clause
     is P.MED, so whether it reaches Decart depends on the delta AND on what else the
     branch carries. Every SHED row is a size the shopper can select and see no change
     from - the limitation CLAUDE.md §0 documents, made measurable instead of asserted. */
  if (b.rows.length > 1) {
    const anyShed = b.rows.some((r) => r.shed.length);
    console.log(`  ── size ladder (fitSentence @ P.MED) ${anyShed ? "──  ⚠ sheds on some rungs" : "──  all rungs fit"}`);
    for (const r of b.rows) {
      const mark = r.shed.length ? `✖ SHED ${r.shed.join(",")}` : "✓";
      if (r.shed.length) shedding++;
      console.log(`     ${String(r.label).padEnd(13)} ${String(r.len).padStart(3)}/${PROMPT_MAX_CHARS}` +
        `  ${String(PROMPT_MAX_CHARS - r.len).padStart(3)} free  ${mark}`);
    }
  }
}

console.log(`\n${bar}\n⚰️  REACHABILITY AUDIT — from ${LIVE_ROOTS.join(" / ")}\n`);
for (const a of audit) {
  const mark = a.dead ? "✖ DEAD" : "✓ live";
  const note = a.orphaned
    ? `${a.refs} refs, but no caller reaches the wire`
    : a.dead ? `definition only` : `reachable`;
  console.log(`  ${mark}  ${a.name.padEnd(28)} ${note}`);
}
if (audit.some((a) => a.orphaned)) {
  console.log(`\n  ↑ "no caller reaches the wire" is the trap: the call site is real,`);
  console.log(`    the caller is not. Editing these changes nothing on screen.`);
}

if (unresolved.length) {
  console.log(`\n⚠ unresolved constants: ${unresolved.join(", ")}`);
}

console.log(`\n${bar}`);
console.log(`Run this before AND after any prompt edit.`);
console.log(`Identical output = the edit changed nothing Decart will ever see.\n`);

process.exit(over > 0 ? 1 : 0);
