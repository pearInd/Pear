#!/usr/bin/env node
/* =============================================================================
   PEAR - garment_category backfill (one-time, resumable, safe to re-run)
   -----------------------------------------------------------------------------
   Finds every garment_cache row whose garment_category IS NULL, classifies its
   photograph with Gemini Vision, and writes the verdict back.

   WHY A BACKFILL EXISTS AT ALL, when GET /api/garment-category already fills the
   column lazily on live traffic
   ─────────────────────────────────────────────────────────────────────────────
   The lazy path only classifies a product on the visit where a shopper opens it,
   and it classifies it AFTER the size form has already rendered - applyGarmentCategoryHint()
   in fitting-room/app.js re-runs the calculator when the verdict lands, so the
   FIRST visitor to a jeans product can watch the recommendation change from "L" to
   "32" under them. Draining the NULLs ahead of traffic means the cache is already
   warm and that never happens to anyone.

   WHAT IT WILL NOT DO
   ───────────────────
   · It never touches a row that already HAS a category, including 'unknown'.
     'unknown' is a real verdict (the model looked and declined); re-asking it would
     spend quota to get the same answer. Use --redo-unknown after a prompt change.
   · It never writes a category for a request that was rate-limited or errored.
     lib/garment-category.js throws on 429 precisely so this script can stop rather
     than record a throttle as a verdict - archive/supabase_setup_v13.sql spells out
     why a wrong non-NULL here is permanent: NULL is the ONLY thing that makes the
     endpoint ask again.
   · It never touches `classification`. The front/back verdict and its provenance are
     a different question with its own migration; this writes ONE column.

   RESUMABLE BY CONSTRUCTION. The query IS the work queue - it selects on
   `garment_category IS NULL`, so every row it finishes leaves the queue. A run that
   dies to a rate limit, a network blip or Ctrl+C is resumed by running it again.

   Usage:
     node scripts/backfill-garment-categories.js               # classify every NULL row
     node scripts/backfill-garment-categories.js --dry-run     # list the work, ask nobody
     node scripts/backfill-garment-categories.js --limit=25    # stop after 25 rows
     node scripts/backfill-garment-categories.js --delay=500   # ms between calls (default 350)
     node scripts/backfill-garment-categories.js --redo-unknown  # also re-ask 'unknown' rows

   Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY in .env.
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { classifyGarmentFull } from "../lib/garment-category.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
};

const DRY_RUN = has("--dry-run") || has("--test");
const REDO_UNKNOWN = has("--redo-unknown");
const LIMIT = valOf("limit", Infinity);
/* Spacing between Gemini calls. The front/back scanner rate-spaces for the same
   reason: a 429 mid-run is recoverable but wasteful, and the free tier throttles
   well below what an unthrottled loop produces. */
const DELAY_MS = valOf("delay", 350);
/* Supabase caps a single select; the queue is drained a page at a time. Rows leave
   the queue as they are written, so paging is by repeated first-page reads rather
   than by offset - an offset would skip rows as the result set shrinks under it. */
const PAGE_SIZE = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (u) => (String(u || "").length > 90 ? String(u).slice(0, 87) + "..." : String(u || ""));

function preflight() {
  const problems = [];
  if (!supabase) {
    problems.push(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so there is no database to " +
      "read or write. lib/supabase.js exports null rather than throwing (see its header).",
    );
  }
  if (!process.env.GEMINI_API_KEY && !DRY_RUN) {
    problems.push(
      "GEMINI_API_KEY is not set. Every classification would resolve to " +
      "{ source: 'unconfigured' } and this script refuses to persist those - it would " +
      "write nothing while appearing to run. Use --dry-run to inspect the queue instead.",
    );
  }
  return problems;
}

/** One page of rows still needing a category. The query IS the work queue. */
async function fetchPending() {
  let q = supabase
    .from("garment_cache")
    .select("image_url, canonical_url, garment_category")
    .limit(PAGE_SIZE);
  q = REDO_UNKNOWN ? q.or("garment_category.is.null,garment_category.eq.unknown")
                   : q.is("garment_category", null);
  const { data, error } = await q;
  if (error) {
    if (/column .* does not exist|Could not find the/i.test(error.message || "")) {
      throw new Error(
        "garment_cache.garment_category does not exist yet. Run " +
        "archive/supabase_setup_v13.sql against this database first.",
      );
    }
    throw new Error(`garment_cache read failed: ${error.message}`);
  }
  return data || [];
}

/* Writes ONE column, addressed by the same canonical_url the rest of the pipeline
   keys on (CLAUDE.md §2.2 - a raw URL compare is how one photograph ended up as
   several rows disagreeing with each other). Falls back to image_url only when the
   row predates the v9 canonical_url migration. */
async function writeCategory(row, category) {
  const target = row.canonical_url
    ? { column: "canonical_url", value: row.canonical_url }
    : { column: "image_url", value: row.image_url };
  const { error } = await supabase
    .from("garment_cache")
    .update({ garment_category: category })
    .eq(target.column, target.value);
  if (error) throw new Error(`write failed (${target.column}): ${error.message}`);
}

async function main() {
  console.log("── PEAR garment_category backfill ──");
  console.log(`   mode        : ${DRY_RUN ? "DRY RUN (nothing is written)" : "LIVE"}`);
  console.log(`   scope       : ${REDO_UNKNOWN ? "NULL and 'unknown' rows" : "NULL rows only"}`);
  console.log(`   limit       : ${LIMIT === Infinity ? "no limit" : LIMIT}`);
  console.log(`   call spacing: ${DELAY_MS}ms\n`);

  const problems = preflight();
  if (problems.length) {
    console.error("Cannot run:\n");
    for (const p of problems) console.error("  · " + p + "\n");
    console.error("Nothing was read and nothing was written.");
    process.exit(1);
  }

  const stats = { seen: 0, pants: 0, top: 0, dress: 0, unknown: 0, skipped: 0, failed: 0 };
  let stop = false;

  while (!stop) {
    let page;
    try {
      page = await fetchPending();
    } catch (e) {
      console.error("\n" + e.message);
      process.exit(1);
    }
    if (!page.length) break;

    for (const row of page) {
      if (stats.seen >= LIMIT) { stop = true; break; }
      stats.seen++;

      if (DRY_RUN) {
        console.log(`  [${stats.seen}] would classify: ${short(row.image_url)}`);
        continue;
      }

      let verdict;
      try {
        verdict = await classifyGarmentFull(row.image_url, process.env.GEMINI_API_KEY);
      } catch (e) {
        if (e?.rateLimited) {
          /* STOP, do not record. A throttled request is not a verdict, and writing one
             would take this row out of the queue permanently - see this file's header
             and archive/supabase_setup_v13.sql. The run is resumed by re-running it. */
          console.error(
            `\n  Gemini is rate limiting (HTTP 429) after ${stats.seen - 1} rows.\n` +
            `  Nothing was written for this row, so it is still in the queue.\n` +
            `  Re-run this script later, or pass a larger --delay= to space the calls out.`,
          );
          stop = true;
          break;
        }
        stats.failed++;
        console.warn(`  [${stats.seen}] ERROR ${short(row.image_url)} - ${e?.message || e}`);
        continue;
      }

      if (verdict.source !== "gemini") {
        /* Unreadable image, HTTP error, unconfigured key: nobody looked, so the row
           stays NULL and stays in the queue for a later run. */
        stats.skipped++;
        console.warn(`  [${stats.seen}] SKIP  (${verdict.cue || verdict.source}) ${short(row.image_url)}`);
        await sleep(DELAY_MS);
        continue;
      }

      try {
        await writeCategory(row, verdict.garment_category);
        stats[verdict.garment_category]++;
        console.log(
          `  [${stats.seen}] ${verdict.garment_category.padEnd(7)} ` +
          `conf ${verdict.confidence.toFixed(2)}  ${short(row.image_url)}` +
          (verdict.cue ? `\n            cue: ${verdict.cue}` : ""),
        );
      } catch (e) {
        stats.failed++;
        console.warn(`  [${stats.seen}] WRITE FAILED ${short(row.image_url)} - ${e.message}`);
      }

      await sleep(DELAY_MS);
    }

    /* A dry run never writes, so the queue never shrinks and a second page read
       would return the same rows forever. One page is enough to show the shape. */
    if (DRY_RUN) break;
  }

  console.log("\n── done ──");
  console.log(`   rows seen : ${stats.seen}`);
  if (!DRY_RUN) {
    console.log(`   pants     : ${stats.pants}`);
    console.log(`   top       : ${stats.top}`);
    console.log(`   dress     : ${stats.dress}`);
    console.log(`   unknown   : ${stats.unknown}   (a real verdict - not re-asked without --redo-unknown)`);
    console.log(`   skipped   : ${stats.skipped}   (nobody looked - still queued)`);
    console.log(`   failed    : ${stats.failed}`);
  }
  if (stats.seen === 0) console.log("   Nothing to do - every row already has a category.");
}

main().catch((e) => {
  console.error("backfill aborted:", e?.message || e);
  process.exit(1);
});
