#!/usr/bin/env node
/* =============================================================================
   PEAR - Clothes Front/Back Batch Scanner (one-time offline job)
   -----------------------------------------------------------------------------
   Reads every product image out of the real catalog (catalog.js - the same
   PRODUCTS array + productImages() normalizer the storefront and PDP render
   from), classifies each one as front/back/both/unknown via the Gemini Vision
   API, and persists the results into a static clothes_metadata.json at the
   repo root. The live app is meant to read that JSON directly - no Gemini
   calls, no latency, no per-request cost at runtime.

   Resumable: on startup it loads any existing clothes_metadata.json and skips
   image/item pairs already recorded there, so a run that dies partway through
   (rate limit, network blip, Ctrl+C) can just be re-run and it picks up where
   it left off. Every successful classification is flushed to disk immediately
   (atomic write via temp-file + rename) - a crash never loses more than the
   one in-flight item.

   Cost note: several catalog entries intentionally share the same placeholder
   imageUrl (see catalog.js comments). The same photo is never sent to Gemini
   twice - a per-imageUrl cache seeded from clothes_metadata.json (and kept
   warm during the run) reuses the first classification for every later item
   that points at the same URL.

   Git sync: on startup, `git pull --ff-only` so the scan runs against the
   latest catalog.js/clothes_metadata.json - it refuses to run over a dirty
   working tree (won't guess whether to stash/commit your in-progress edits)
   and refuses a non-fast-forward pull (won't auto-merge divergent history in
   an unattended script). When the run finishes, if clothes_metadata.json
   actually changed it's committed (that file only - never `git add -A`) and
   pushed. A push failure leaves the commit local and safe; it's never
   force-pushed and a git failure never discards the classification work
   already flushed to disk. Skip this whole layer with --no-git, or keep the
   commit local (no push) with --no-push.

   Test / dry-run mode: --test (alias --dry-run) classifies exactly ONE sample
   image by default - a known-good real "front" photo baked into this file, so
   you get a real answer without needing the catalog or a passing/failing
   guess - prints Gemini's exact JSON response plus a schema-validation
   checklist, and touches NOTHING else: clothes_metadata.json is never read or
   written, errors.log is never written, and git is never touched (no pull, no
   commit, no push). Use it to confirm your GEMINI_API_KEY and model are
   working before spending quota on the full catalog. Pass --test-limit=2 to
   also see the baked-in "back" sample.

   Usage:
     node scripts/batch-scan-clothes.js --test                       # 1 built-in known-front sample
     node scripts/batch-scan-clothes.js --test --test-url=<url>      # classify exactly one image, nothing else
     node scripts/batch-scan-clothes.js --test --test-limit=2        # both built-in samples (front + back)
     node scripts/batch-scan-clothes.js --test --test-limit=3        # sample first 3 real catalog images instead
     node scripts/batch-scan-clothes.js --test --test-expect=front   # assert against a known answer

     node scripts/batch-scan-clothes.js
     node scripts/batch-scan-clothes.js --limit=5        # smoke-test a few images first
     node scripts/batch-scan-clothes.js --force           # ignore cache, reclassify everything
     node scripts/batch-scan-clothes.js --rpm=6           # throttle harder (default 12 req/min)
     node scripts/batch-scan-clothes.js --no-git          # skip git pull/commit/push entirely
     node scripts/batch-scan-clothes.js --no-push         # pull + local commit, skip push
     node scripts/batch-scan-clothes.js --catalog=./catalog.js --out=./clothes_metadata.json

   Requires GEMINI_API_KEY in .env (see .env.example). Optional GEMINI_MODEL
   env var overrides the model (default: gemini-flash-lite-latest - the Flash
   LITE tier, for maximum speed/cost efficiency on a job that's just "front or
   back", plus Google's rolling "-latest" alias so it keeps working as pinned
   preview names get retired for new callers over time. On this project,
   gemini-2.5-flash-lite came back 404 "no longer available to new users" and
   gemini-2.0-flash-lite came back 429 with a 0 free-tier quota - both dead
   ends despite being named in Google's docs; gemini-flash-lite-latest is the
   one that actually resolves and serves requests today. Pin an explicit
   dated model instead if you need reproducible results across runs, but
   verify it against your own key first - model availability is clearly
   shifting under new keys/projects).
   ============================================================================= */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { GoogleGenAI, Type } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/* ── CLI args ── */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`Usage: node scripts/batch-scan-clothes.js [options]

  --catalog=<path>   Path to the catalog module to scan (default: ./catalog.js)
  --out=<path>       Output metadata file (default: ./clothes_metadata.json)
  --errors=<path>    Error log file (default: ./errors.log)
  --force            Ignore existing clothes_metadata.json and reclassify everything
  --limit=<n>        Only consider the first N images (useful for a smoke test)
  --rpm=<n>          Requests per minute throttle (default 12)
  --no-git           Skip git pull/commit/push entirely
  --no-push          Pull + commit locally, but don't push

  --test, --dry-run  Classify exactly 1 sample image (a known-good built-in
                      "front" photo): print Gemini's JSON response + a
                      schema-validation checklist. Never reads or writes
                      clothes_metadata.json/errors.log, never touches git.
                      Run this before a full scan.
  --test-url=<url>   In --test mode, classify exactly this one image instead
                      of the built-in sample (catalog.js not required)
  --test-limit=<n>   In --test mode, use N samples instead of 1: 2 uses both
                      built-in known samples (front + back); >2 falls through
                      to the first N real catalog images instead
  --test-expect=<a,b># In --test mode, comma-separated expected detectedView
                      per sample (in order) to assert against, e.g. front,back
  -h, --help         Show this help
`);
  process.exit(0);
}

const CATALOG_PATH = path.resolve(ROOT, args.catalog || "catalog.js");
const OUT_PATH = path.resolve(ROOT, args.out || "clothes_metadata.json");
const ERROR_LOG_PATH = path.resolve(ROOT, args.errors || "errors.log");
const FORCE = !!args.force;
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const RPM = args.rpm ? parseInt(args.rpm, 10) : 12;
const NO_GIT = !!args["no-git"];
const NO_PUSH = !!args["no-push"];
const TEST_MODE = !!(args.test || args["dry-run"]);
const TEST_URL = args["test-url"] || null;
const TEST_LIMIT = args["test-limit"] ? parseInt(args["test-limit"], 10) : 1;
const TEST_EXPECT = args["test-expect"]
  ? String(args["test-expect"]).split(",").map((s) => s.trim().toLowerCase())
  : null;
const DELAY_MS = Math.ceil(60000 / RPM);
const MAX_RETRIES = 3;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

/* Known-good defaults for --test with no other flags: one real front and one
   real back image from this catalog (confirmed by an earlier full scan), so
   the default smoke test exercises both branches with a real expected answer
   - no catalog.js load required, so it also works if catalog.js is broken. */
const DEFAULT_TEST_SAMPLES = [
  {
    itemId: "1",
    imageUrl: "https://live.staticflickr.com/8726/17084787712_8905988312_b.jpg",
    expectedView: "front",
  },
  {
    itemId: "6",
    imageUrl: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-3.jpg?v=1732626199&width=1024",
    expectedView: "back",
  },
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_API_KEY) {
  console.error("✗ GEMINI_API_KEY is not set - copy .env.example to .env and fill it in.");
  console.error("  Get / rotate a key at https://aistudio.google.com/apikey");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const VALID_VIEWS = ["front", "back", "both", "unknown"];

const CLASSIFICATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedView: {
      type: Type.STRING,
      enum: VALID_VIEWS,
      description: "Which side of the garment faces the camera, ignoring any human model.",
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: "Confidence in detectedView, from 0 (guessing) to 1 (certain).",
    },
    garmentType: {
      type: Type.STRING,
      description: "Short garment type, e.g. 't-shirt', 'jeans', 'hoodie', 'dress'.",
    },
    notes: {
      type: Type.STRING,
      description: "One short sentence explaining the call, or any ambiguity.",
    },
  },
  required: ["detectedView", "confidenceScore", "garmentType", "notes"],
  propertyOrdering: ["detectedView", "confidenceScore", "garmentType", "notes"],
};

const PROMPT = `You are a garment-photo classifier for an e-commerce catalog.
Look ONLY at the clothing item in this image - ignore any human model, mannequin, background, or watermark.
Decide which side of the GARMENT is facing the camera:

- "front": the garment's front (chest/waistband area, buttons, zipper, front pockets) faces the camera.
- "back": the garment's back (spine seam, back yoke, rear pockets) faces the camera.
- "both": a flat-lay or render clearly shows front and back at once (rare).
- "unknown": the image doesn't show a wearable garment clearly enough to tell (cropped, swatch, packaging, etc).

Respond with the requested JSON only.`;

/* ── helpers ── */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resumeKey(t) {
  return `${t.itemId}::${t.imageUrl}`;
}

/* catalog.js is a plain browser-global script (no import/export, no DOM
   access) - running it in a fresh vm context and pulling PRODUCTS +
   productImages() out the other side reuses the exact same gallery logic
   the storefront renders from, instead of re-deriving it here. */
function loadCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog file not found: ${catalogPath}`);
  }
  const code = fs.readFileSync(catalogPath, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${code}\nglobalThis.__catalogExports = { PRODUCTS, productImages };`,
    sandbox,
    { filename: catalogPath }
  );
  const exported = sandbox.__catalogExports;
  if (!exported || !Array.isArray(exported.PRODUCTS) || typeof exported.productImages !== "function") {
    throw new Error(`${catalogPath} did not expose PRODUCTS/productImages as expected`);
  }
  return exported;
}

function buildScanTargets(PRODUCTS, productImages) {
  const targets = [];
  for (const p of PRODUCTS) {
    const images = productImages(p) || [];
    for (const img of images) {
      if (img && img.url) targets.push({ itemId: String(p.id), imageUrl: img.url });
    }
  }
  return targets;
}

function loadExistingResults(outPath) {
  const map = new Map();
  if (!fs.existsSync(outPath)) return map;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    const backupPath = `${outPath}.corrupt-${Date.now()}.bak`;
    fs.copyFileSync(outPath, backupPath);
    console.warn(`⚠ ${outPath} was not valid JSON - backed up to ${backupPath} and starting fresh.`);
    return map;
  }
  for (const item of payload.items || []) {
    if (item && item.itemId != null && item.imageUrl) {
      map.set(`${item.itemId}::${item.imageUrl}`, item);
    }
  }
  return map;
}

function persistResults(outPath, model, resultsMap) {
  const payload = {
    generatedAt: new Date().toISOString(),
    model,
    itemCount: resultsMap.size,
    items: Array.from(resultsMap.values()),
  };
  const tmpPath = `${outPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, outPath);
}

function logError(errorLogPath, target, err) {
  const line = `[${new Date().toISOString()}] itemId=${target.itemId} imageUrl=${target.imageUrl} error=${(err && err.message) || err}\n`;
  fs.appendFileSync(errorLogPath, line, "utf8");
}

function guessMimeType(url, contentType) {
  if (contentType) {
    const clean = contentType.split(";")[0].trim().toLowerCase();
    if (clean.startsWith("image/")) return clean;
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

async function fetchImageAsBase64(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PEAR-ClothesScanner/1.0)" },
  });
  if (!resp.ok) throw new Error(`image download failed: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit)`
    );
  }
  const mimeType = guessMimeType(url, resp.headers.get("content-type"));
  return { base64: buffer.toString("base64"), mimeType };
}

async function classifyImage(base64, mimeType) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType, data: base64 } }, { text: PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: CLASSIFICATION_SCHEMA,
      temperature: 0,
    },
  });

  const raw = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned an empty response");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${String(raw).slice(0, 200)}`);
  }

  const view = String(parsed.detectedView || "").toLowerCase();
  if (!VALID_VIEWS.includes(view)) {
    throw new Error(`Unexpected detectedView value: ${parsed.detectedView}`);
  }

  return {
    detectedView: view,
    confidenceScore: typeof parsed.confidenceScore === "number" ? parsed.confidenceScore : 0,
    garmentType: String(parsed.garmentType || "unknown"),
    notes: String(parsed.notes || ""),
  };
}

/* Retries transient failures (network blips, 429s) with backoff. On final
   failure it throws - the caller logs to errors.log and leaves the item
   unrecorded so the next run retries it automatically.

   Backoff is tunable because test mode wants the opposite tradeoff from a
   full run: a full run can afford to patiently wait out a per-minute rate
   limit across a 20-minute job, but a "quick sanity check before spending
   quota" should fail in seconds, not minutes, if the key/quota is broken. */
async function classifyWithRetry(target, { maxRetries = MAX_RETRIES, rateLimitBackoffMs = 30000, otherBackoffMs = 3000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { base64, mimeType } = await fetchImageAsBase64(target.imageUrl);
      return await classifyImage(base64, mimeType);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isRateLimit = /429|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg);
      if (attempt < maxRetries) {
        const backoff = isRateLimit ? rateLimitBackoffMs * attempt : otherBackoffMs * attempt;
        console.warn(`  ⚠ attempt ${attempt} failed (${msg}) - retrying in ${Math.round(backoff / 1000)}s...`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

/* ── git sync ──
   execFileSync (argv array, no shell) rather than execSync(string) - avoids
   shell-quoting pitfalls entirely (commit messages, paths with spaces) since
   arguments go straight to the git process. */
function git(gitArgs) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isGitRepo() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

function isWorkingTreeClean() {
  return git(["status", "--porcelain"]).trim().length === 0;
}

function hasUncommittedChangesTo(relPath) {
  return git(["status", "--porcelain", "--", relPath]).trim().length > 0;
}

function hasUpstream() {
  try {
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

/* Pull first so the scan runs against the latest catalog.js/clothes_metadata.json.
   Deliberately conservative for an unattended script: refuses to run over a
   dirty tree (won't guess whether to stash or commit someone else's
   in-progress edits) and uses --ff-only (won't fabricate a merge commit if
   history has diverged - that needs a human). Either case aborts the whole
   run rather than scanning against a workspace that might not match origin. */
function gitPullLatest() {
  if (!isGitRepo()) {
    console.warn("⚠ Not inside a git repository - skipping git pull (--no-git to silence this).");
    return;
  }
  if (!hasUpstream()) {
    console.warn("⚠ Current branch has no upstream configured - skipping git pull.");
    return;
  }
  if (!isWorkingTreeClean()) {
    throw new Error(
      "Working tree has uncommitted changes - commit or stash them first.\n" +
        "  (auto-pull refuses to run over a dirty tree so it never clobbers in-progress work)\n" +
        git(["status", "--short"])
    );
  }
  console.log("→ git pull --ff-only");
  const out = git(["pull", "--ff-only"]);
  console.log(`  ${out.trim() || "(already up to date)"}`);
}

/* Commits + pushes ONLY clothes_metadata.json (never `git add -A`, so any
   other dirty files are left untouched) and only if that file actually
   changed - resumed runs where everything was already cached produce no
   commit. A push failure (e.g. someone else pushed in the meantime) is
   reported clearly but never force-pushed; the commit stays local and safe,
   and the classification data was already durable on disk regardless. */
function gitCommitAndPush(outPath) {
  if (!isGitRepo()) return;

  const relPath = path.relative(ROOT, outPath).split(path.sep).join("/");
  if (!hasUncommittedChangesTo(relPath)) {
    console.log(`\nNo changes to ${relPath} - nothing to commit.`);
    return;
  }

  console.log(`\n→ git add ${relPath}`);
  git(["add", "--", relPath]);

  const message = `chore: update clothing metadata [batch scan] (${new Date().toISOString()})`;
  console.log(`→ git commit -m "${message}"`);
  git(["commit", "-m", message]);

  if (NO_PUSH) {
    console.log("→ --no-push set - commit left local, not pushed.");
    return;
  }
  if (!hasUpstream()) {
    console.warn("⚠ No upstream configured - commit left local. Push manually once (e.g. git push -u origin <branch>).");
    return;
  }

  console.log("→ git push");
  try {
    const out = git(["push"]);
    console.log(`  ${out.trim() || "(pushed)"}`);
  } catch (err) {
    console.error("✗ git push failed - the commit is saved locally but NOT pushed.");
    console.error(`  ${err.stderr || err.message}`);
    console.error("  Resolve manually (e.g. git pull --rebase && git push) - the classification data is safe on disk either way.");
  }
}

/* ── test / dry-run mode ──
   Classifies 1-2 sample images and prints Gemini's exact response plus a
   validation checklist. Deliberately never touches clothes_metadata.json,
   errors.log, or git - safe to run any number of times while wiring up a
   new API key or model. */
async function runTestMode() {
  console.log(`PEAR clothes batch-scan - TEST MODE (model ${MODEL})`);
  console.log("Nothing will be saved: clothes_metadata.json/errors.log are not touched, and git is not touched.\n");

  let samples;
  if (TEST_URL) {
    samples = [{ itemId: "test", imageUrl: TEST_URL, expectedView: TEST_EXPECT?.[0] || null }];
  } else if (TEST_LIMIT > DEFAULT_TEST_SAMPLES.length) {
    // More samples requested than the built-in pair can cover - fall through
    // to real catalog images instead (requires catalog.js).
    const { PRODUCTS, productImages } = loadCatalog(CATALOG_PATH);
    const targets = buildScanTargets(PRODUCTS, productImages).slice(0, TEST_LIMIT);
    if (targets.length === 0) {
      throw new Error("No images found in the catalog to sample. Try --test-url=<image-url> instead.");
    }
    samples = targets.map((t, i) => ({ ...t, expectedView: TEST_EXPECT?.[i] || null }));
  } else {
    samples = DEFAULT_TEST_SAMPLES.slice(0, TEST_LIMIT).map((s, i) => ({ ...s, expectedView: TEST_EXPECT?.[i] || s.expectedView }));
  }

  console.log(`Sampling ${samples.length} image(s):\n`);

  let passed = 0;
  for (let i = 0; i < samples.length; i++) {
    const target = samples[i];
    console.log("─".repeat(70));
    console.log(`[${i + 1}/${samples.length}] item ${target.itemId}`);
    console.log(`imageUrl: ${target.imageUrl}`);

    try {
      const classification = await classifyWithRetry(target, {
        maxRetries: 2,
        rateLimitBackoffMs: 8000,
        otherBackoffMs: 2000,
      });
      const entry = { itemId: target.itemId, imageUrl: target.imageUrl, ...classification };

      console.log("\nGemini response:");
      console.log(JSON.stringify(entry, null, 2));

      const checks = [
        [typeof entry.itemId === "string", "itemId is a string"],
        [typeof entry.imageUrl === "string", "imageUrl is a string"],
        [VALID_VIEWS.includes(entry.detectedView), `detectedView is one of ${VALID_VIEWS.join("/")}`],
        [
          typeof entry.confidenceScore === "number" && entry.confidenceScore >= 0 && entry.confidenceScore <= 1,
          "confidenceScore is a number in [0, 1]",
        ],
        [typeof entry.garmentType === "string" && entry.garmentType.length > 0, "garmentType is a non-empty string"],
        [typeof entry.notes === "string", "notes is a string"],
      ];
      if (target.expectedView) {
        checks.push([entry.detectedView === target.expectedView, `detectedView matches expected "${target.expectedView}"`]);
      }

      console.log("\nValidation:");
      let samplePassed = true;
      for (const [passedCheck, label] of checks) {
        console.log(`  ${passedCheck ? "✓" : "✗"} ${label}`);
        if (!passedCheck) samplePassed = false;
      }
      if (samplePassed) passed++;
      console.log(`\nResult: ${entry.detectedView.toUpperCase()} (confidence ${entry.confidenceScore})`);
    } catch (err) {
      console.error(`\n✗ Classification failed: ${err.message}`);
    }
    console.log("");

    if (i < samples.length - 1) await sleep(DELAY_MS);
  }

  console.log("─".repeat(70));
  console.log(`Test mode done. ${passed}/${samples.length} sample(s) passed validation.`);
  console.log("clothes_metadata.json, errors.log, and git were not touched.");
  console.log(passed === samples.length ? "Looks good - run without --test to scan the full catalog." : "Investigate before running the full scan.");
}

/* ── main ── */
async function main() {
  console.log(`PEAR clothes batch-scan - model ${MODEL}, ~${RPM} req/min`);
  console.log(`Catalog: ${CATALOG_PATH}`);
  console.log(`Output:  ${OUT_PATH}`);
  console.log(`Errors:  ${ERROR_LOG_PATH}\n`);

  if (!NO_GIT) gitPullLatest();

  const { PRODUCTS, productImages } = loadCatalog(CATALOG_PATH);
  const targets = buildScanTargets(PRODUCTS, productImages).slice(0, LIMIT);
  console.log(`${PRODUCTS.length} product(s), ${targets.length} image(s) to consider.`);

  const resultsMap = FORCE ? new Map() : loadExistingResults(OUT_PATH);
  const urlCache = new Map();
  for (const item of resultsMap.values()) {
    if (!urlCache.has(item.imageUrl)) urlCache.set(item.imageUrl, item);
  }

  const pending = targets.filter((t) => !resultsMap.has(resumeKey(t)));
  console.log(`${targets.length - pending.length} already recorded - skipping.`);
  console.log(`${pending.length} to process this run.\n`);

  let ok = 0;
  let reused = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const target = pending[i];
    const label = `[${i + 1}/${pending.length}] item ${target.itemId}`;
    const cached = urlCache.get(target.imageUrl);

    if (cached) {
      const entry = {
        itemId: target.itemId,
        imageUrl: target.imageUrl,
        detectedView: cached.detectedView,
        confidenceScore: cached.confidenceScore,
        garmentType: cached.garmentType,
        notes: `${cached.notes} (reused - same image already classified for item ${cached.itemId})`,
      };
      resultsMap.set(resumeKey(target), entry);
      persistResults(OUT_PATH, MODEL, resultsMap);
      reused++;
      console.log(`${label} - reused "${entry.detectedView}" from cache, no API call`);
      continue;
    }

    console.log(`${label} - classifying ${target.imageUrl}`);
    try {
      const classification = await classifyWithRetry(target);
      const entry = { itemId: target.itemId, imageUrl: target.imageUrl, ...classification };
      resultsMap.set(resumeKey(target), entry);
      urlCache.set(target.imageUrl, entry);
      persistResults(OUT_PATH, MODEL, resultsMap);
      ok++;
      console.log(`  -> ${entry.detectedView} (confidence ${entry.confidenceScore})`);
    } catch (err) {
      failed++;
      logError(ERROR_LOG_PATH, target, err);
      console.warn(`  ✗ failed: ${err.message} - logged, will retry on next run`);
    }

    if (i < pending.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${ok} classified, ${reused} reused from cache, ${failed} failed.`);
  console.log(`${resultsMap.size}/${targets.length} image(s) recorded in ${OUT_PATH}.`);
  if (failed > 0) console.log(`Re-run the script to retry the ${failed} failed image(s).`);

  if (!NO_GIT) gitCommitAndPush(OUT_PATH);
}

(TEST_MODE ? runTestMode() : main()).catch((err) => {
  console.error("✗ Fatal error:", err?.message || err);
  process.exit(1);
});
