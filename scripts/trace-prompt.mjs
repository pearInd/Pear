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
const APP = resolve(args.find((a) => !a.startsWith("--")) ?? "fitting-room/app.js");

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

  const configPath = joinPath(dirname(APP), "config.js");
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
  "CATEGORY_ANCHOR", "BACK_CATEGORY_ANCHOR", "LOOK_ANCHOR",
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

/* ── the wire branches, mirroring imageOnlyPrompt()'s selector logic ───────── */
const A = scope.CATEGORY_ANCHOR ?? {};
const B = scope.BACK_CATEGORY_ANCHOR ?? {};
const closure = scope.FRONT_CLOSURE_LOCK ?? "";

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const join = (...parts) => norm(parts.filter(Boolean).join(" "));

const branches = [
  { id: "top / front / plain knit tee",       wire: join(scope.PLAIN_TEE_ANCHOR) },
  { id: "top / front / plain tee + closure",  wire: join(scope.PLAIN_TEE_ANCHOR, closure) },
  { id: "top / front / structured",           wire: join(A.top) },
  { id: "top / front / structured + closure", wire: join(A.top, closure) },
  { id: "top / back",                         wire: join(B.top) },
  { id: "bottoms / front",                    wire: join(A.bottom) },
  { id: "bottoms / back",                     wire: join(B.bottom) },
  { id: "full look",                          wire: join(scope.LOOK_ANCHOR, scope.STRICT_REFERENCE_LOCK,
                                                          scope.VOLUME_PERSISTENCE, scope.CLOSED_BACK_HEM) },
];

/* ── dead-clause audit — REACHABILITY, not a reference count ──────────────────
   A plain "how many times is this name mentioned" count gets the important case
   backwards. getFitModifier() has a real call site, so it counts as referenced —
   but its only caller is fitSentence(), which nothing calls. Editing it still
   changes nothing on the wire. That transitive case is exactly the trap this
   tool exists to catch, so the audit walks the call graph from the two builders
   that genuinely reach Decart and reports what is NOT reachable from them.

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
for (const b of branches) {
  if (!b.wire) { console.log(`\n▸ ${b.id}\n  ⚠ could not resolve — check the constant names in NEEDED`); continue; }
  const n = b.wire.length;
  const flag = n > PROMPT_MAX_CHARS ? "  ✖ OVER BUDGET" : "";
  if (n > PROMPT_MAX_CHARS) over++;
  console.log(`\n▸ ${b.id}  [${n}/${PROMPT_MAX_CHARS}, ${PROMPT_MAX_CHARS - n} free]${flag}`);
  console.log(`  ${b.wire}`);
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
