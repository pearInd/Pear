/* =============================================================================
   PEAR - shared CLI plumbing for `npm run capture` and `npm run import:chart`
   -----------------------------------------------------------------------------
   The human end of Phase 2: a readable summary of every chart about to be saved, a
   y/n, the save (saveSizeChartRecords - the Phase 1 path, unchanged), and a read-back
   of GET /api/store-size-chart so "saved" is confirmed against what the room will
   actually receive. Nothing here parses or validates a chart.

   SECRETS: this file reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY by
   name from scanner/.env and never prints a value.
   ============================================================================= */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export function loadScannerEnv() {
  /* scanner/.env first (where the scanner's keys live), then the working directory's -
     so `npm run capture` works from the repo root as well as from scanner/. dotenv never
     overrides a variable that is already set, and prints nothing. */
  dotenv.config({ path: fileURLToPath(new URL("./.env", import.meta.url)), quiet: true });
  dotenv.config({ quiet: true });
}

/* The yes/no flags of both CLIs. They take no value: `--yes=no` used to split into `--yes`
   and a stray "no", and flag("--yes") is only "is it there" - so it SAVED WITHOUT ASKING,
   the opposite of what it says. An empty / true / 1 value is the bare flag; any other value
   is a usage error (thrown before anything runs), never a set flag. The spaced form
   (`--yes no`, `--dry-run off`) did the same and is refused the same way: a yes/no word
   right after a yes/no flag can only be meant as its value. */
export const BOOLEAN_FLAGS = ["--yes", "--dry-run", "--browser", "--no-browser", "--images", "--no-images"];

/** The command line both CLIs read. `--only=1` and `--only 1` are the same flag: the
    equals form was once silently ignored, so `--only=1` imported every chart. */
export function parseCliArgs(argv) {
  const args = argv.slice(2).flatMap((a) => {
    const m = /^(--[\w-]+)=([\s\S]*)$/.exec(a);
    if (m && BOOLEAN_FLAGS.includes(m[1])) {
      if (/^(?:|true|1)$/i.test(m[2])) return [m[1]];
      throw new Error(`${m[1]} takes no value (got ${a}) - pass ${m[1]} alone, or leave it out`);
    }
    return m ? [m[1], m[2]] : [a];
  });
  args.forEach((a, i) => {
    if (BOOLEAN_FLAGS.includes(a) && /^(?:y(?:es)?|no?|true|false|on|off|0|1)$/i.test(args[i + 1] || ""))
      throw new Error(`${a} takes no value (got ${a} ${args[i + 1]}) - pass ${a} alone, or leave it out`);
  });
  const flag = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  return { args, flag, val };
}

export const DEFAULT_API_BASE = "https://app.pear-ai.io";

const band = (rows, key) => {
  const vals = rows.map((r) => r.body && r.body[key]).filter(Boolean);
  if (!vals.length) return null;
  return `${key} ${Math.min(...vals.map((v) => v[0]))}-${Math.max(...vals.map((v) => v[1]))}cm`;
};

/** One readable block per record - what a human needs to decide y/n. */
export function formatChartSummary(records, numbers = null) {
  if (!records.length) return "  (no charts)";
  return records.map((r, i) => {
    const n = numbers && numbers[i] ? numbers[i] : i + 1;   // import-chart's own chart numbers, when given
    const sizes = r.rows.map((x) => x.size).join(" ");
    const measures = ["chest", "waist", "hips", "outseam"].map((k) => band(r.rows, k)).filter(Boolean).join(", ");
    const aliases = r.rows.some((x) => x.aliases) ? " +EU/US aliases" : "";
    return [
      `  #${n}  ${r.gender} / ${r.age_group} / ${r.garment_type}  [${r.size_system}]  ${r.product_key ? "this product only" : "store-wide"}`,
      `       sizes: ${sizes}${aliases}`,
      `       measurements: ${measures || "(none)"}`,
      `       confidence ${r.confidence} · via ${r.source} · ${r.source_url || "(file)"}`,
    ].join("\n");
  }).join("\n");
}

/** y/n on a TTY; a non-interactive run never saves unless --yes was given. */
export async function askYesNo(question, { assumeYes = false, input = process.stdin, output = process.stdout } = {}) {
  if (assumeYes) return true;
  if (!input.isTTY) {
    output.write(question + " [y/N] - not an interactive terminal, answering NO (pass --yes to save non-interactively)\n");
    return false;
  }
  const rl = createInterface({ input, output });
  const answer = await new Promise((res) => rl.question(question + " [y/N] ", res));
  rl.close();
  return /^y(?:es)?$/i.test(String(answer).trim());
}

/** What the room will actually receive for this host, per the live endpoint. */
export async function fetchLiveCharts(host, { apiBase = process.env.PEAR_API_BASE || DEFAULT_API_BASE, fetchImpl = fetch } = {}) {
  const url = `${apiBase.replace(/\/$/, "")}/api/store-size-chart?host=${encodeURIComponent(host)}`;
  try {
    const resp = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return { ok: false, url, error: "HTTP " + resp.status, charts: [] };
    const body = await resp.json();
    return { ok: true, url, note: body.note || null, charts: Array.isArray(body.charts) ? body.charts : [] };
  } catch (e) {
    return { ok: false, url, error: e.message, charts: [] };
  }
}

export function formatLive(live) {
  if (!live.ok) return `  live check failed (${live.error}) - ${live.url}`;
  if (!live.charts.length) return `  live: no charts served${live.note ? " (" + live.note + ")" : ""} - ${live.url}`;
  return `  live (${live.url}) serves ${live.charts.length} chart(s):\n` + live.charts.map((c) =>
    `    · ${c.gender}/${c.age_group}/${c.garment_type} [${c.size_system}] ${c.rows.map((r) => r.size).join("/")} via ${c.source}`).join("\n");
}

/* Live serving is cached for 5 minutes (Cache-Control on the endpoint) and is
   store-wide only; a product-scoped row is stored but not served in Phase 1.
   A chart is LIVE when a served chart has its labels AND its numbers. Labels alone were
   the first cut: a re-capture upserts onto the same key, the cache still serves the OLD
   rows under those labels, and the run said "✓ all ... are live". `stale` counts a chart
   served under its labels with different numbers - the old version still cached, or rows
   the endpoint drops at serve time (toRoomChart() in lib/store-size-charts.js: a size
   token it refuses, a band outside its clamps). The served shape is that function's:
   { size, minChest/maxChest, minWaist/..., minHips/..., minLegs/maxLegs (the outseam) }. */
const SERVED_BANDS = { chest: "Chest", waist: "Waist", hips: "Hips", outseam: "Legs" };
const savedNumbers = (rows) => JSON.stringify(rows.map((x) => [String(x.size).trim().toUpperCase(),
  ...Object.keys(SERVED_BANDS).map((k) => (x.body && x.body[k] ? x.body[k].map(Number) : null))]));
const servedNumbers = (rows) => JSON.stringify((rows || []).map((x) => [x.size,
  ...Object.values(SERVED_BANDS).map((k) => (x["min" + k] != null ? [Number(x["min" + k]), Number(x["max" + k])] : null))]));
export function liveCoverage(records, live) {
  const want = records.filter((r) => !r.product_key && r.status === "active");
  const labelled = (r) => live.charts.filter((c) => c.gender === r.gender && c.age_group === r.age_group &&
    c.garment_type === r.garment_type && (c.size_system || "unknown") === r.size_system && c.source === r.source);
  const same = (r) => labelled(r).some((c) => servedNumbers(c.rows) === savedNumbers(r.rows));
  return { expected: want.length, live: want.filter(same).length, stale: want.filter((r) => !same(r) && labelled(r).length).length,
    productScoped: records.filter((r) => r.product_key).length };
}

/** The one-line reason when nothing was captured, with the manual way in. */
export function reasonLine(kind, host, extra = "") {
  const manual = `npm run import:chart -- --host ${host}`;
  const lines = {
    blocked: `BLOCKED - ${host} refused our requests${extra ? " (" + extra + ")" : ""}. We do not work around bot protection. ` +
      `Manual way in: open the size guide in your own browser, save it (Ctrl+S, "Webpage, Complete") or screenshot it, then\n    ${manual} --html <saved-page.html>   (or --image <screenshot.png>)`,
    image_unreadable: `IMAGE UNREADABLE - the guide is an image and it could not be turned into a valid chart${extra ? " (" + extra + ")" : ""}. ` +
      `Manual way in: a sharper screenshot of just the table:\n    ${manual} --image <screenshot.png> --gender <men|women|unisex> --type <tops|bottoms|jeans|dresses|outerwear>`,
    /* Neither of these is the image's fault, and the --image way in needs the same reader -
       "a sharper screenshot" sent the operator to a path that fails the same way. */
    no_ocr_key: `IMAGE NOT READ - the guide looks like an image${extra ? " (" + extra + ")" : ""}, and GEMINI_API_KEY is not set, so nothing could read it. ` +
      `Set GEMINI_API_KEY in scanner/.env and run the same command again.`,
    image_rate_limited: `IMAGE READER RATE-LIMITED - the guide looks like an image, and Gemini answered HTTP 429 (too many requests)${extra ? " (" + extra + ")" : ""}. ` +
      `Nothing is wrong with the store or the image: retry later - wait a minute or two and run the same command again.`,
    images_not_read: `IMAGE GUIDE NOT READ - image(s) that look like a size chart were found${extra ? " (" + extra + ")" : ""} but not read (--no-images). ` +
      `Run again without --no-images, or screenshot the table:\n    ${manual} --image <screenshot.png> --gender <men|women|unisex> --type <tops|bottoms|jeans|dresses|outerwear>`,
    js_unreadable: `JS GUIDE NOT OPENED - the store renders its guide client-side and the browser fallback did not find a readable table${extra ? " (" + extra + ")" : ""}. ` +
      `Manual way in: open it yourself, save the page with the guide open (Ctrl+S, "Webpage, Complete"), then\n    ${manual} --html <saved-page.html>`,
    browser_unavailable: `BROWSER UNAVAILABLE - ${extra || "Chromium could not start"}. Run \`npx playwright install chromium\` in the repo root, or:\n    ${manual} --url <size-guide-page-url>`,
    no_measurements: `GUIDE HAS NO BODY MEASUREMENTS - ${host}'s size guide opened, but it is a size-CONVERSION table ` +
      `(EU/IT/UK/US...) with no chest/waist/hip columns, so there is nothing to fit a body against${extra ? " (" + extra + ")" : ""}. ` +
      `If the store publishes a measurement chart elsewhere:\n    ${manual} --url <that-page>   (or --html / --image)`,
    none: `NO SIZE GUIDE FOUND on the sampled pages${extra ? " (" + extra + ")" : ""}. If the store has one, point at it:\n    ${manual} --url <size-guide-page-url>   (or --html / --image)`,
    unreachable: `UNREACHABLE - ${host} did not answer${extra ? " (" + extra + ")" : ""}. Check the URL, or:\n    ${manual} --html <saved-page.html>`,
  };
  return lines[kind] || lines.none;
}

/* Save (the Phase 1 path), then confirm against the live endpoint - and say only what is known:
   - A SKIPPED save (no client, the v15 table or the v16 key missing) is a FAILED run: exit
     code 1. It exited 0, so `npm run capture -- <url> --yes && echo captured` said captured
     with nothing written. Set here, so both CLIs that save through this get it. (Phase 1's
     scan-store.js --size-charts --save keeps its own clean exit.)
     It covers THAT case only (review, 2026-10-11 - this comment once read as the whole
     guarantee): a capture run that captured nothing (BLOCKED, UNREACHABLE, NO SIZE GUIDE
     FOUND... - main() prints the reason and returns before any save), a --dry-run and a "no"
     at the y/n all still exit 0. So `&& echo captured` is not a test that something was saved
     - the "✓ saved N chart(s)" line is.
   - The migration hint names THIS command: saveSizeChartRecords()'s own says "re-run with
     --save", Phase 1's flag, which neither Phase 2 command has.
   - A live check that FAILED verified nothing: it used to go on to "0/N visible yet - the
     endpoint caches", sending the operator to wait for a cache when the check itself broke.
   - Nothing store-wide saved (every chart product-scoped) is not "✓ all 0 ... are live":
     the room serves none of those rows.
   - "Live" means the numbers just saved, not just the labels (liveCoverage()). */
export async function saveAndVerify({ supabase, records, host, saveSizeChartRecords, log = console.log, fetchImpl = fetch,
  setExitCode = (c) => { process.exitCode = c; } }) {
  const res = await saveSizeChartRecords(supabase, records, log, { rerunHint: "then run the same command again to save" });
  if (!res.saved) {
    log(`Nothing saved (${res.skipped || "no charts"}).`);
    if (res.skipped) setExitCode(1);
    return { saved: 0, skipped: res.skipped || "no charts" };
  }
  log(`✓ saved ${res.saved} chart(s) to store_size_charts`);
  const live = await fetchLiveCharts(host, { fetchImpl });
  log(formatLive(live));
  const cov = liveCoverage(records, live);
  const scoped = cov.productScoped ? `; ${cov.productScoped} product-scoped chart(s) saved are stored but not served (the room serves store-wide charts only)` : "";
  if (!cov.expected) log(`… no store-wide chart saved: ${cov.productScoped || res.saved} product-scoped chart(s) stored, not served - the room serves store-wide charts only`);
  /* A 200 carrying the endpoint's own failure note (its storage failed, or it reads another
     database) verified nothing either - it is not a cache to wait out. */
  else if (!live.ok || /^(?:query_failed|table_missing|storage_unavailable)$/.test(live.note || ""))
    log(`? could not verify what the room receives - the live check ${live.ok ? "answered " + live.note : "failed"}; re-check with curl ${live.url}${scoped}`);
  else if (cov.live === cov.expected) log(`✓ all ${cov.expected} store-wide chart(s) just saved are live${scoped}`);
  else {
    log(`… ${cov.live}/${cov.expected} store-wide chart(s) live with the numbers just saved` +
      (cov.stale ? `; ${cov.stale} served with different numbers (the previous version, cached for up to 5 minutes - or rows the endpoint drops)` : "") +
      (cov.expected - cov.live - cov.stale ? `; ${cov.expected - cov.live - cov.stale} not served yet (the endpoint caches for up to 5 minutes)` : "") +
      `; re-check with curl ${live.url}${scoped}`);
  }
  return { saved: res.saved, live, coverage: cov };
}
