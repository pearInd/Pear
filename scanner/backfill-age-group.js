#!/usr/bin/env node
/* =============================================================================
   PEAR - garment_cache age_group Backfill
   -----------------------------------------------------------------------------
   One-off utility. Finds every garment_cache row classified BEFORE age_group
   existed (age_group IS NULL) and re-classifies just those images, writing
   age_group/age_group_confidence back onto the SAME row (UPDATE by id - never
   inserts, never duplicates).

   Uses the exact same combined Gemini call as server.js/scan-store.js (view +
   age_group in one request) so this doesn't burn a second API call per image
   just to fill in the new columns. classification is also refreshed from that
   same call, since it's a free byproduct of the read.

   Write payload is intentionally narrow: id, image_url, classification,
   created_at, age_group, age_group_confidence are the ONLY columns confirmed
   (via information_schema against the live DB) to exist on garment_cache.
   confidence/cue/source/product_url exist in server.js/scan-store.js's writes
   but were never actually migrated onto this table - including them here made
   every UPDATE get rejected outright by PostgREST.

   Does NOT touch scan-store.js or server.js, and does not scan any new stores -
   this only revisits rows that already exist in garment_cache.

   Usage (from scanner/):
     node backfill-age-group.js
     node backfill-age-group.js --dry-run   # classify + log, skip the UPDATE
   ============================================================================= */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.argv.includes("--dry-run");

if (!GEMINI_API_KEY) {
  console.error("✗ GEMINI_API_KEY is not set - copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set - copy .env.example to .env and fill them in.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { enabled: false },
  global: { headers: {} },
  auth: { persistSession: false, autoRefreshToken: false },
});

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
const GEMINI_RATE_LIMIT_MS = 8000; // same pacing as scan-store.js - free tier is 15 req/min

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer.toString("base64");
}

/* MUST STAY IN LOCKSTEP with FRONT_BACK_SYSTEM_PROMPT in server.js and
   scan-store.js - see those files for why. Copied here rather than imported
   because scan-store.js runs its crawl as a side effect of being imported
   (top-level main().catch(...)), so importing it would kick off a live scan. */
const FRONT_BACK_SYSTEM_PROMPT = `You are a garment-orientation classifier for a virtual try-on pipeline. You decide which SIDE of a garment a product photograph shows.

Judge the GARMENT, not the photo's role in the gallery. Never reason about whether an image "looks like the main product shot" - primary/secondary ordering is a merchandising choice and carries no information about orientation.

If a person is wearing the garment, their body orientation is the strongest signal available:
- Face, eyes or front torso visible toward the camera -> the garment's FRONT.
- Back of the head, nape of the neck, or shoulder blades toward the camera -> the garment's BACK.

DECISIVE FRONT cues (each appears only on the front):
- Buttons, button placket, full-length zipper closure, snaps, tie closure
- Chest pocket, breast logo, front graphic or lettering read the right way round
- V-neck, scoop or crew neckline seen as an open curve (the neck opening faces you)
- Front fly, coin pocket, belt loops seen with the fly
- Bra cups, front cutouts, wrap-front overlap

DECISIVE BACK cues (each appears only on the back):
- Centre-back seam running vertically down the panel
- Back yoke (a horizontal seam across the upper back)
- Rear neckline as a shallow, closed curve with the collar standing away from you
- Sewn-in neck label / size tag visible on the inside of the rear collar
- Back graphic, player name/number, spine lettering
- Rear pockets on trousers, back darts, a back vent on a jacket or coat
- Back zipper on a dress (short, upper-centre) or a rear keyhole/cutout

TRICKY CASES - follow these exactly:
- Neck label visible = BACK. A sewn label sits at the rear collar; this cue outranks a partially visible neckline.
- Side or 3/4 profile: decide by which cues you can actually SEE. If decisive cues from one side are visible, answer that side. If neither is legible, answer "uncertain".
- Flat-lay / packshot with no model: use the seam and closure cues above.
- Close-up detail / fabric macro / accessory-only shot with no orientation cue: answer "uncertain".
- Folded garment, hanger shot from the side, or a photo where the garment is mostly occluded: answer "uncertain".
- Do NOT guess. "uncertain" is a correct, useful answer; a wrong "front" makes a real rear photo unusable, and a wrong "back" makes the try-on render the wrong side.

Report confidence honestly:
- 0.9-1.0  one or more decisive cues, clearly legible
- 0.7-0.89 one decisive cue, partially occluded or low resolution
- below 0.7 inference from weak cues only -> you must answer "uncertain"

SEPARATELY, also classify whether this is a KIDS' garment or an ADULT garment -
this is about the PRODUCT, not the photo's orientation, so judge it independently
of your front/back answer above.

DECISIVE KIDS cues:
- A child or infant is wearing the garment (judge by body/face proportions and
  height relative to any visible surroundings, not by clothing style alone -
  petite adult sizing exists and is NOT kids' clothing)
- A visible size label/tag using child sizing (e.g. "2T", "4Y", "Age 8", "110cm",
  "XS Kids", a EU/IL kids numeric size like 8-18 on a size chart)
- Snap-crotch or grow-with-me adjustable waistband construction (bodysuits,
  rompers) - these do not exist in adult sizing
- Character licensing, cartoon prints, or a garment scaled small enough that
  ordinary adult proportions (shoulder width, torso length, sleeve/inseam ratio)
  are visibly impossible

DECISIVE ADULT cues:
- An adult is wearing the garment (adult body/face proportions)
- A visible size label using adult sizing (S/M/L/XL/XXL, numeric waist/chest in
  cm or inches typical of adult garments, EU 36-52 etc.)
- Tailoring, cut, or proportions only found in adult clothing (structured
  blazers, adult-length trousers with a standard rise, underwire, adult-scale
  formalwear)

TRICKY CASES - follow these exactly:
- Flat-lay / packshot with NO model and NO visible size label: judge PURELY by
  the garment's own scale and cut cues above. If the garment could plausibly be
  either a petite adult's item or an older child's/teen's item with no other
  cue to separate them, answer "uncertain" - do not guess from styling alone.
- A youth/teen-cut garment that could span either chart (a typical concern
  around EU kids size 16-18 / adult XS-S): answer "uncertain" rather than
  picking one, unless a size label or a visibly child-proportioned wearer
  settles it.
- Do NOT infer age group from color, print style, or price positioning alone
  ("cute" prints and pastel colors exist in adult fashion too).

Report age_group confidence honestly using the SAME bands as view confidence
above; below 0.7 you must answer "uncertain".

Respond ONLY with JSON matching this schema:
{"view":"front"|"back"|"uncertain","confidence":0.0-1.0,"cue":"<the single cue that decided it, max 12 words>","age_group":"kids"|"adult"|"uncertain","age_group_confidence":0.0-1.0}`;

/** @returns {Promise<{view:"front"|"back"|"uncertain", confidence:number, cue:string, age_group:"kids"|"adult"|"uncertain", age_group_confidence:number}>} */
async function classifyFrontBackAndAge(imageUrl) {
  const base64 = await fetchImageAsBase64(imageUrl);
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: FRONT_BACK_SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
            { text: "Classify which side of the garment this photograph shows." },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            view:                 { type: "STRING", enum: ["front", "back", "uncertain"] },
            confidence:           { type: "NUMBER" },
            cue:                  { type: "STRING" },
            age_group:            { type: "STRING", enum: ["kids", "adult", "uncertain"] },
            age_group_confidence: { type: "NUMBER" },
          },
          required: ["view", "confidence", "age_group", "age_group_confidence"],
        },
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Gemini ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    err.rateLimited = resp.status === 429;
    throw err;
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { view: "uncertain", confidence: 0, cue: "unparseable response", age_group: "uncertain", age_group_confidence: 0 };
  }
  const view = ["front", "back", "uncertain"].includes(parsed?.view) ? parsed.view : "uncertain";
  const confidence = Number.isFinite(parsed?.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  const ageGroup = ["kids", "adult", "uncertain"].includes(parsed?.age_group) ? parsed.age_group : "uncertain";
  const ageGroupConfidence = Number.isFinite(parsed?.age_group_confidence)
    ? Math.max(0, Math.min(1, parsed.age_group_confidence)) : 0;
  return {
    view, confidence, cue: typeof parsed?.cue === "string" ? parsed.cue.slice(0, 120) : "",
    age_group: ageGroup, age_group_confidence: ageGroupConfidence,
  };
}

/* Same retry shape as scan-store.js's classifyWithRetry: one retry after a 60s
   wait on 429, otherwise the failure is returned as `fallback` so the caller
   never writes a fabricated verdict over a row that just hasn't been retried yet. */
async function classifyWithRetry(imageUrl, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      return await classifyFrontBackAndAge(imageUrl);
    } catch (e) {
      if (e.rateLimited && i < retries - 1) {
        console.log("  Rate limited - waiting 60s...");
        await sleep(60000);
      } else {
        console.warn(`  ⚠ classification ${e.rateLimited ? "RATE LIMITED" : "failed"}: ${e.message}`);
        return { view: "uncertain", confidence: 0, cue: e.message.slice(0, 120), age_group: "uncertain", age_group_confidence: 0, fallback: true };
      }
    }
  }
  return { view: "uncertain", confidence: 0, cue: "retries exhausted", age_group: "uncertain", age_group_confidence: 0, fallback: true };
}

/* Every garment_cache row with age_group still NULL, paginated (Supabase caps
   a single select at 1000 rows). */
async function fetchRowsMissingAgeGroup() {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("garment_cache")
      .select("id, image_url")
      .is("age_group", null)
      .range(from, from + pageSize - 1);
    if (error) {
      if (/column .* does not exist|Could not find the/i.test(error.message || "")) {
        console.error("✗ garment_cache has no age_group column - run archive/supabase_setup_v11.sql first.");
        process.exit(1);
      }
      throw error;
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  console.log(DRY_RUN ? "Backfilling age_group (DRY RUN - no writes)...\n" : "Backfilling age_group...\n");

  const rows = await fetchRowsMissingAgeGroup();
  console.log(`Found ${rows.length} row(s) with age_group IS NULL.\n`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const tally = { kids: 0, adult: 0, uncertain: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`[${i + 1}/${rows.length}] id=${row.id} ${row.image_url}`);

    const rec = await classifyWithRetry(row.image_url);

    if (rec.fallback) {
      tally.skipped++;
      console.log(`  SKIPPED (not written - will retry next run)`);
      await sleep(GEMINI_RATE_LIMIT_MS);
      continue;
    }

    const classification = rec.view === "back" ? "back" : "front";
    if (rec.age_group === "kids") tally.kids++;
    else if (rec.age_group === "adult") tally.adult++;
    else tally.uncertain++;

    console.log(`  view=${rec.view} (${classification}) age_group=${rec.age_group} confidence=${rec.confidence.toFixed(2)}/${rec.age_group_confidence.toFixed(2)}`);

    if (!DRY_RUN) {
      // Real garment_cache schema (confirmed via information_schema against the live
      // DB) is only: id, image_url, classification, created_at, age_group,
      // age_group_confidence. confidence/cue/source/product_url from the v8/v9
      // archive SQL were NEVER applied to this table - writing them made PostgREST
      // reject the WHOLE update ("Could not find the 'confidence' column ... in the
      // schema cache"), so classification/age_group/age_group_confidence never
      // persisted either, on every single row.
      try {
        // .select() forces PostgREST to return the row it touched instead of the
        // default `Prefer: return=minimal` empty body - so a request that succeeds
        // at the HTTP level but matches zero rows (wrong id, RLS, etc.) is still
        // caught below instead of silently counting as a success.
        const { data, error } = await supabase
          .from("garment_cache")
          .update({
            classification,
            age_group: rec.age_group,
            age_group_confidence: rec.age_group_confidence,
          })
          .eq("id", row.id)
          .select("id");
        if (error) {
          tally.failed++;
          console.warn(`  ⚠ update failed: ${JSON.stringify(error)}`);
        } else if (!data || data.length === 0) {
          tally.failed++;
          console.warn(`  ⚠ update matched 0 rows for id=${row.id} (no error returned, but nothing was written)`);
        }
      } catch (err) {
        // A thrown (not returned) error - e.g. a network failure - used to escape
        // this block entirely and abort the whole run via main().catch() without
        // ever reaching the failed-row count. Caught here so one bad request can't
        // silently end the backfill or hide behind a "0 failures" summary.
        tally.failed++;
        console.warn(`  ⚠ update threw: ${err?.message || err}`);
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(`Progress: ${i + 1}/${rows.length} processed`);
    }

    await sleep(GEMINI_RATE_LIMIT_MS);
  }

  console.log(
    `\nDone. ${rows.length} row(s) processed | ${tally.kids} kids | ${tally.adult} adult | ` +
    `${tally.uncertain} uncertain | ${tally.skipped} skipped (rate-limited/failed, will retry next run) | ` +
    `${tally.failed} DB update failure(s)`
  );
}

main().catch((err) => {
  console.error("✗ Backfill failed:", err?.message || err);
  process.exit(1);
});
