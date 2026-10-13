#!/usr/bin/env node
/* =============================================================================
   Mutation check for the Phase 2 size-guide capture rules.
   -----------------------------------------------------------------------------
   A test that cannot fail proves nothing. For each KEY RULE below this script breaks
   the rule in a scratch copy of the sources (never the working tree), runs the suite
   that is supposed to guard it, and expects it to go RED. A mutation that stays green
   is a rule nobody is actually checking.

       node scripts/mutation-check-capture.mjs                (exit 1 if any is SURVIVED, INVALID or ERROR)
       node scripts/mutation-check-capture.mjs --jobs 1       (one scratch copy; default: cores - 1, at most 3)
       node scripts/mutation-check-capture.mjs --only dry-run (only mutations whose name matches)
       node scripts/mutation-check-capture.mjs --list         (print the mutations, run nothing)

   The copies live in ./.mutation-tmp (gitignored) so `node_modules` still resolves from
   the repo root, and are deleted afterwards. Nothing under the repo root is ever written
   but that directory; the files the mutations and suites name are hashed before and after
   the run, and a difference fails it.

   WHAT COUNTS AS KILLED (review F23, 2026-10-08). The first cut read ANY non-zero exit as
   a kill: a misspelled suite (module not found), a timeout (status null), a suite already
   red before anything was mutated, a mutation that broke the file's syntax - each was
   reported "KILLED" and the run said "all N mutations killed", exit 0. A no-op mutation
   was shown KILLED against a red suite. Now:
     - BASELINE FIRST. Every suite is run once on the UNMUTATED scratch copy; a suite that
       is red (any FAIL line or a non-zero exit), times out or prints no PASS line aborts
       the whole run (exit 2) before any mutation - a red suite cannot tell a mutation from
       its own failure. A suite file that does not exist is caught with the anchors (exit 1).
     - KILLED only when the mutated run exits non-zero AND printed at least one assertion
       FAIL line (the suites' `FAIL  <label>` contract). The first failing check is shown.
     - INVALID (exit 1, never a kill): a timeout or a signal, a non-zero exit with no FAIL
       line (a crash before any check ran - the last stderr line is shown), a mutated file
       `node --check` rejects (a syntax error proves nothing about the rule).
     - ERROR (exit 1): an anchor that is missing or occurs more than once in its file, or
       an edit that changes nothing. An anchor that moved is a mutation that no longer
       mutates - fix the anchor, never skip it.
     - SURVIVED (exit 1): the suite stayed green - the rule is not tested.
     - SKIPPED: only a mutation marked "@chromium" whose suite SKIPPED its real-Chromium
       section and stayed green, and only when that suite's BASELINE skipped it too (no
       browser on this machine). A skip the baseline did not have - Chromium launched for
       the baseline but not under the parallel jobs - is INVALID (review D7, 2026-10-11).
       SKIPPED does not fail the run: it is listed, and never counted as killed.
   Suites run with a timeout of 3x their baseline time (at least 240s).
   ============================================================================= */
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cpus } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = join(ROOT, ".mutation-tmp");
const COPY_DIRS = ["scanner", "test", "widget", "lib", "fitting-room", "scripts", "archive"];

/* [name, file, from, to, suite] or [name, [[file, from, to], ...], suite].
   `from` must occur EXACTLY ONCE in its file. suite[@chromium] - see the header. */
const MUTATIONS = [
  ["image OCR never gets its confidence penalty", "scanner/size-charts.js",
    "SOURCE_CONFIDENCE_PENALTY = { image_ocr: 0.2,", "SOURCE_CONFIDENCE_PENALTY = { image_ocr: 0,", "image-chart-ocr"],
  ["the Gemini key travels in the URL", "scanner/image-charts.js",
    ":generateContent`, {", ":generateContent?key=${apiKey}`, {", "image-chart-ocr"],
  ["OCR values skip the shared clamps (chest max 2000)", "scanner/size-chart-parser.js",
    "chest: { min: 50, max: 200 },", "chest: { min: 50, max: 2000 },", "image-chart-ocr"],
  ["the browser may click 'add to bag'", "scanner/browser-capture.js",
    "  if (NEVER_CLICK_RE.test(t)) return false;\n", "", "browser-capture"],
  ["a guide is typed by the PRODUCT page's title", "scanner/browser-capture.js",
    "    if (guide) chart.classification = classifyChart(chart.rows, chart.localText, \"\", ref);", "", "browser-capture"],
  ["the guide's context walk escapes the dialog", "scanner/size-charts.js",
    "let sib = atBoundary ? null : node.previousElementSibling", "let sib = node.previousElementSibling", "browser-capture"],
  ["the browser never stops on a 403 wall", "scanner/browser-capture.js",
    "if (++refusedInARow >= 2) {", "if (++refusedInARow >= 2000) {", "browser-capture"],
  ["the static stage never stops on a 403 wall", "scanner/size-charts.js",
    "if (refusedInARow >= 3) {", "if (refusedInARow >= 3000) {", "capture-flow"],
  ["a manual override accepts any value", "scanner/import-chart.js",
    "if (!allowed.includes(s)) throw", "if (false) throw", "manual-import"],
  /* Manual charts are store-wide twice over (no product URL AND a store-wide source), so
     one guard alone is an equivalent mutant: both are broken together - the realistic
     regression of tagging a manual chart with its source URL. */
  ["manual imports are product-scoped, not store-wide", [
    ["scanner/size-charts.js", "\"linked_page\", \"manual_url\", \"manual_html\", \"manual_image\"", "\"linked_page\""],
    ["scanner/import-chart.js", "({ chart, source, sourceUrl: pageUrl, productUrl: \"\" })", "({ chart, source, sourceUrl: pageUrl, productUrl: pageUrl })"],
  ], "manual-import"],
  ["a chart with no garment type is saved anyway", "scanner/size-charts.js",
    "    if (!cls.garmentType) {", "    if (false) {", "scanner-size-charts"],
  ["static banner hits are always OCR'd", "scanner/capture.js",
    "...(nothingYet || forceImages ? staticImages", "...(true ? staticImages", "capture-flow"],
  ["a store that began refusing is re-asked by the browser", "scanner/capture.js",
    "st.report.outcome === \"blocked_by_bot_protection\" || !!st.report.polite_stop || everyProductRefused;", "st.report.outcome === \"blocked_by_bot_protection\" || everyProductRefused;", "capture-flow"],
  ["a store that refused every sampled product page is re-asked by the browser", "scanner/capture.js",
    " || !!st.report.polite_stop || everyProductRefused;", " || !!st.report.polite_stop;", "capture-flow"],
  ["a store that refused us is still asked for the images on its own host", "scanner/capture.js",
    "const staticImages = refused ? st.images.filter((u) => !onStoreHost(u)) : st.images;", "const staticImages = st.images;", "capture-flow"],
  ["a guessed guide path's 403 counts as the store refusing us", "scanner/size-charts.js",
    "if (!guessed.has(gUrl)) { noteRefusal(isRefusal(r), gUrl); continue; }", "{ noteRefusal(isRefusal(r), gUrl); continue; }", "scanner-size-charts"],
  ["--only=1 (the equals form) is read as no --only", "scanner/capture-cli.js",
    "const m = /^(--[\\w-]+)=([\\s\\S]*)$/.exec(a);", "const m = null;", "manual-import"],
  ["a conversion-only guide is reported as 'could not open'", "scanner/capture.js",
    "else if (browser && browser.report.unmeasured_guides) {", "else if (false) {", "capture-flow"],
  ["an untyped table (suits) gets no number - it cannot be imported alone", "scanner/import-chart.js",
    "n: twin ? twin.n : ++total,", "n: twin ? twin.n : (c.garmentType ? ++total : 0),", "manual-import"],
  /* Either guard alone catches Debut/Brooklyn (each wraps <main> AND the page's only h1), so
     one alone is an equivalent mutant: both go together - "any boundary match is a guide". */
  ["a theme's page wrapper (drawer-page-content) is taken for a guide dialog", [
    ["scanner/import-chart.js", "        !box.matches(\"main,[role=main]\") && !box.querySelector(\"main,[role=main]\") &&\n", ""],
    ["scanner/import-chart.js", "\n        !(h1s.length && h1s.every((h) => box.contains(h)));", " true;"],
  ], "manual-import"],
  /* In-page JavaScript: only a real Chromium runs it (browser-capture §5). "@chromium" -
     where none launches the suite SKIPs §5, and the mutation is reported SKIPPED, never
     counted as killed. */
  ["a guide hidden by CSS (it keeps its box) reads as already visible", "scanner/browser-capture.js",
    "  if (r.width <= minW || r.height <= minH) return false;\n", "  if (r.width <= minW || r.height <= minH) return false;\n  return true;\n", "browser-capture@chromium"],

  /* ── The review round of 2026-10-07/08: the guards its fixes added. ─────────────── */
  ["--dry-run saves anyway (capture)", "scanner/capture.js",
    "  if (flag(\"--dry-run\")) { console.log(\"\\nDry run - nothing written.\"); return; }\n", "", "capture-flow"],
  ["--dry-run saves anyway (import:chart)", "scanner/import-chart.js",
    "  if (flag(\"--dry-run\")) { console.log(\"\\nDry run - nothing written.\"); return; }\n", "", "manual-import"],
  ["--yes no (spaced) is read as --yes - saves without asking", "scanner/capture-cli.js",
    "    if (BOOLEAN_FLAGS.includes(a) && /^(?:y(?:es)?|no?|true|false|on|off|0|1)$/i.test(", "    if (false && /^(?:y(?:es)?|no?|true|false|on|off|0|1)$/i.test(", "capture-flow"],
  ["a store whose BROWSER refused us is still asked for the images on its own host", "scanner/capture.js",
    "const refused = staticRefused || browserRefused;", "const refused = staticRefused;", "capture-flow"],
  ["static banner hits use up the image reads before the guide's own image", "scanner/capture.js",
    "    ...browserImages,\n    ...(nothingYet || forceImages ? staticImages.map(staticImg) : []),\n",
    "    ...(nothingYet || forceImages ? staticImages.map(staticImg) : []),\n    ...browserImages,\n", "capture-flow"],
  ["a save the database skipped exits 0", "scanner/capture-cli.js",
    "    if (res.skipped) setExitCode(1);\n", "", "capture-flow"],
  ["a refused browser is BLOCKED only when static found nothing RAW (not: kept nothing)", "scanner/capture.js",
    "|| (browserBlocked && !st.records.length)", "|| (browserBlocked && !st.found.length)", "capture-flow"],
  ["with no GEMINI_API_KEY every image is still sent to the reader", "scanner/capture.js",
    "    const keyless = !apiKey && imageUrls.some((i) => !isPdf(i.url));", "    const keyless = false;", "capture-flow"],
  ["a lazy-loaded chart image is read as its URL placeholder (blank.gif, an LQIP thumbnail)", "scanner/size-charts.js",
    "    const src = lazySrc || ownSrc;", "    const src = (ownSrc && !/^data:/i.test(ownSrc) ? ownSrc : lazySrc) || ownSrc;", "scanner-size-charts"],
  ["a lazy-loaded chart image is read as its data: placeholder", "scanner/size-charts.js",
    "    const src = lazySrc || ownSrc;", "    const src = ownSrc || lazySrc;", "scanner-size-charts"],
  ["bounded() still starts in-page calls on a page known to be stuck", "scanner/browser-capture.js",
    "    if (stuck) return Promise.reject(new Error(stuck));   // the same page: nothing new is started on it\n", "", "browser-capture"],
  ["any 403 on the store's host is the guide refused, not only inside the guide's window", "scanner/browser-capture.js",
    "const guideReq = asked && (type !== \"document\" || mainNav)", "const guideReq = (type !== \"document\" || mainNav)", "browser-capture"],
  ["a challenge page on another host's sizing page is the store refusing us", "scanner/browser-capture.js",
    "if (navigated && onStoreHost(page.url()) && modalHtml && looksLikeBotChallenge(", "if (navigated && modalHtml && looksLikeBotChallenge(", "browser-capture"],
  ["product URLs are de-duplicated AFTER the page cap (one product fills it)", "scanner/browser-capture.js",
    "urls = [...new Set(urls.map(canonicalProductUrl))].slice(0, maxPages);", "urls = [...new Set(urls.slice(0, maxPages).map(canonicalProductUrl))];", "browser-capture"],
  ["navigations with no answer never stop the run (a tarpit is asked for every page)", "scanner/browser-capture.js",
    "if (++unansweredInARow >= 2 && !report.pages_opened) break;", "if (++unansweredInARow >= 2000 && !report.pages_opened) break;", "browser-capture"],
  ["a chart visible in a guide-ish container (a 'drawer') is taken for the hidden guide", "scanner/browser-capture.js",
    "if (chart.rawSnapshot && hiddenInGuide.some((el) => el.outerHTML.includes(chart.rawSnapshot))) entry.inGuide = true;",
    "if (chart.rawSnapshot && guideRoots.some((el) => el.outerHTML.includes(chart.rawSnapshot))) entry.inGuide = true;", "browser-capture"],
  ["a guide link that leaves the page is clicked without the store's pause", "scanner/browser-capture.js",
    "        if (t.away) await sleep(delayMs);\n", "", "browser-capture"],
];

/* ── command line ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
/* Default: one scratch copy per spare core, at most 3 - measured 2026-10-08 on 4 cores: the
   37 mutations ran green-baseline / all-killed in ~7 min with 3 (the Chromium suite alone is
   ~2 min, 13 of them), ~25 min with 1. Parallel copies load the machine: a suite that turns
   flaky under load could pass a timing FAIL off as a kill, so a doubtful KILLED is re-checked
   with --jobs 1 --only <its name>. */
const jobs = Math.max(1, Math.min(8, parseInt(opt("--jobs") || String(Math.min(3, Math.max(1, cpus().length - 1))), 10) || 1));
const only = opt("--only");
const selected = MUTATIONS.filter((m) => !only || m[0].toLowerCase().includes(only.toLowerCase()));
if (argv.includes("--list")) {
  selected.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. ${m[0]}  (${m[m.length - 1]})`));
  process.exit(0);
}
if (!selected.length) { console.error(`no mutation matches --only ${JSON.stringify(only)}`); process.exit(2); }

const editsOf = (m) => (Array.isArray(m[1]) ? m[1] : [[m[1], m[2], m[3]]]);
const suiteOf = (m) => { const [suite, needs] = m[m.length - 1].split("@"); return { suite, needs }; };
const suiteFile = (dir, suite) => join(dir, "test", suite + ".test.mjs");
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "(missing)");
const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
const failLines = (out) => (out || "").split("\n").filter((l) => /^FAIL\s/.test(l));
/* The line that names the failure: Node's crash output ends with its own version banner. */
const errLine = (s) => {
  const lines = (s || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(?:\w*Error|Uncaught)\b|^\w*Error:/.test(l)) || lines.filter((l) => !/^Node\.js v/.test(l)).pop() || "";
};
const secs = (ms) => (ms / 1000).toFixed(1) + "s";

/* The real files this run must leave alone: every file a mutation edits, every suite. */
const suites = [...new Set(selected.map((m) => suiteOf(m).suite))];
const guarded = [...new Set([...selected.flatMap((m) => editsOf(m).map((e) => e[0])), ...suites.map((s) => `test/${s}.test.mjs`)])];
const before = new Map(guarded.map((f) => [f, sha(join(ROOT, f))]));

function makeCopy(dir) {
  mkdirSync(dir, { recursive: true });
  for (const d of COPY_DIRS) {
    cpSync(join(ROOT, d), join(dir, d), { recursive: true, filter: (src) => !/[\\/]\.env/.test(src) && !/node_modules/.test(src) });
  }
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
}

/** Run one suite in a copy; resolves {status, signal, stdout, stderr, ms, timedOut}. */
function runSuite(dir, suite, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [suiteFile(dir, suite)], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, ms: Date.now() - t0, timedOut });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout, stderr: String(e), ms: Date.now() - t0, timedOut }); });
  });
}

/** A pool of `n` workers, each with its own scratch copy. */
async function pool(items, n, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async (_, w) => {
    const dir = join(TMP, "job-" + w);
    if (!existsSync(dir)) makeCopy(dir);   // the baseline's copies are reused: they were never mutated
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i], dir, i);
    }
  }));
  return out;
}

const t0 = Date.now();
let exitCode = 0;
const cleanup = () => rmSync(TMP, { recursive: true, force: true });
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  cleanup();

  /* ── 1. anchors: each must occur exactly once in the unmutated file ─────────── */
  const anchorErrors = [];
  for (const m of selected) {
    const byFile = new Map();
    for (const [file, from, to] of editsOf(m)) {
      const p = join(ROOT, file);
      if (!existsSync(p)) { anchorErrors.push(`${m[0]}: ${file} does not exist`); continue; }
      const src = byFile.has(file) ? byFile.get(file) : readFileSync(p, "utf8").replace(/\r\n/g, "\n");
      const n = count(src, from);
      if (from === to) anchorErrors.push(`${m[0]}: the edit in ${file} changes nothing`);
      else if (n !== 1) anchorErrors.push(`${m[0]}: anchor ${n ? `occurs ${n} times` : "is MISSING"} in ${file}: ${JSON.stringify(from.slice(0, 90))}`);
      else byFile.set(file, src.replace(from, to));
    }
  }
  for (const s of suites) if (!existsSync(suiteFile(ROOT, s))) anchorErrors.push(`suite test/${s}.test.mjs does not exist`);
  if (anchorErrors.length) {
    throw Object.assign(new Error(`ABORTED - ${anchorErrors.length} anchor error(s); a mutation that does not apply mutates nothing:\n` +
      anchorErrors.map((e) => "  " + e).join("\n")), { exitCode: 1 });
  }

  /* ── 2. baseline: every suite green on the UNMUTATED copy ───────────────────── */
  console.log(`baseline: ${suites.length} suite(s) on the unmutated copy (${jobs} job(s))...`);
  const base = await pool(suites, jobs, async (suite, dir) => ({ suite, ...(await runSuite(dir, suite, 600000)) }));
  const baseBad = [];
  const timeoutFor = new Map();
  const chromiumSkipped = new Set();
  for (const b of base) {
    const fails = failLines(b.stdout);
    const passes = (b.stdout.match(/^PASS\s/gm) || []).length;
    if (b.timedOut || b.status !== 0 || fails.length || !passes) {
      baseBad.push(`  ${b.suite}: ${b.timedOut ? "TIMED OUT" : `exit ${b.status}${b.signal ? " (" + b.signal + ")" : ""}`}, ` +
        `${fails.length} FAIL, ${passes} PASS${fails[0] ? " - first: " + fails[0].slice(0, 120) : ""}${!fails.length && errLine(b.stderr) ? " - " + errLine(b.stderr).slice(0, 160) : ""}`);
    }
    if (/^SKIP\s+§5 Chromium unavailable/m.test(b.stdout)) chromiumSkipped.add(b.suite);
    timeoutFor.set(b.suite, Math.max(240000, 3 * b.ms));
    console.log(`  ${b.suite}: ${passes} PASS, ${fails.length} FAIL in ${secs(b.ms)}${chromiumSkipped.has(b.suite) ? " (real-Chromium section SKIPPED - no browser here)" : ""}`);
  }
  if (baseBad.length) {
    console.error(`\nABORTED - the unmutated tree is not green, so no mutation result would mean anything:\n${baseBad.join("\n")}`);
    exitCode = 2;
  } else {
    /* ── 3. the mutations ────────────────────────────────────────────────────────── */
    console.log(`\n${selected.length} mutation(s)...`);
    const results = await pool(selected, jobs, async (m, dir, i) => {
      const { suite, needs } = suiteOf(m);
      const saved = [];
      const restore = () => { for (const [p, o] of [...saved].reverse()) writeFileSync(p, o); };
      try {
        for (const [file, from, to] of editsOf(m)) {
          const p = join(dir, file);
          const orig = readFileSync(p, "utf8");
          const src = orig.replace(/\r\n/g, "\n");
          const n = count(src, from);
          if (n !== 1) return { m, k: "ERROR   ", d: `anchor ${n ? `occurs ${n} times` : "missing"} in ${file} (after the earlier edits)` };
          saved.push([p, orig]);
          writeFileSync(p, src.replace(from, to));
        }
        /* A mutation the parser rejects is not a rule broken - it is a file that cannot load. */
        for (const p of new Set(saved.map(([q]) => q))) {
          if (!/\.m?js$/.test(p)) continue;
          const c = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
          if (c.status !== 0) return { m, k: "INVALID ", d: `the mutated file does not parse: ${errLine(c.stderr).slice(0, 160)}` };
        }
        const r = await runSuite(dir, suite, timeoutFor.get(suite));
        const fails = failLines(r.stdout);
        if (r.timedOut || r.status === null || r.signal) {
          return { m, k: "INVALID ", d: r.timedOut ? `timed out after ${secs(timeoutFor.get(suite))}` : `killed by ${r.signal || "an unknown cause"}` };
        }
        if (r.status !== 0 && fails.length) return { m, k: "KILLED  ", d: `${fails.length} FAIL - ${fails[0].replace(/^FAIL\s+/, "").slice(0, 100)}`, ms: r.ms };
        if (r.status !== 0) return { m, k: "INVALID ", d: `exit ${r.status} with no FAIL line (a crash before any check): ${errLine(r.stderr || r.stdout).slice(0, 160)}` };
        if (fails.length) return { m, k: "INVALID ", d: `${fails.length} FAIL line(s) but exit 0 - the suite's exit contract is broken` };
        if (needs === "chromium" && /^SKIP\s+§5 Chromium unavailable/m.test(r.stdout)) {
          if (!chromiumSkipped.has(suite)) {
            return { m, k: "INVALID ", d: `Chromium ran for the baseline but not for this run - re-check with --jobs 1 --only "${m[0]}"` };
          }
          return { m, k: "SKIPPED ", d: "needs Chromium: npx playwright install chromium" };
        }
        return { m, k: "SURVIVED", d: "the suite stayed green - this rule is not tested" };
      } finally {
        restore();
        process.stdout.write(`  [${i + 1}/${selected.length}] ${m[0]}\n`);
      }
    });
    console.log("");
    for (const r of results) console.log(`${r.k}  ${r.m[0]}  (${r.m[r.m.length - 1]})\n            ${r.d}`);
    const tally = (k) => results.filter((r) => r.k.trim() === k).length;
    const [killed, survived, invalid, errors, skipped] = ["KILLED", "SURVIVED", "INVALID", "ERROR", "SKIPPED"].map(tally);
    console.log(`\n${killed} killed, ${survived} survived, ${invalid} invalid, ${errors} error(s), ${skipped} skipped - of ${results.length} mutation(s)`);
    if (survived) console.log(`${survived} mutation(s) SURVIVED - a rule is not tested`);
    if (invalid || errors) console.log(`${invalid + errors} mutation(s) proved nothing (INVALID/ERROR) - fix them; they are not kills`);
    if (survived || invalid || errors) exitCode = 1;
  }
} catch (e) {
  if (!e.exitCode) throw e;
  console.error("\n" + e.message);
  exitCode = e.exitCode;
} finally {
  cleanup();
}

/* ── 4. the working tree was not touched ───────────────────────────────────────── */
const changed = guarded.filter((f) => sha(join(ROOT, f)) !== before.get(f));
if (changed.length) {
  console.error(`\nA REAL FILE CHANGED during the run (this script writes only under .mutation-tmp - another process edited it, and the results describe the tree as it was at the start): ${changed.join(", ")}`);
  if (!exitCode) exitCode = 1;
} else console.log(`working tree untouched: ${guarded.length} source/suite file(s) byte-identical before and after`);
console.log(`runtime ${secs(Date.now() - t0)}`);
process.exit(exitCode);
