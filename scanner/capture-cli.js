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

export const DEFAULT_API_BASE = "https://app.pear-ai.io";

const band = (rows, key) => {
  const vals = rows.map((r) => r.body && r.body[key]).filter(Boolean);
  if (!vals.length) return null;
  return `${key} ${Math.min(...vals.map((v) => v[0]))}-${Math.max(...vals.map((v) => v[1]))}cm`;
};

/** One readable block per record - what a human needs to decide y/n. */
export function formatChartSummary(records) {
  if (!records.length) return "  (no charts)";
  return records.map((r, i) => {
    const sizes = r.rows.map((x) => x.size).join(" ");
    const measures = ["chest", "waist", "hips", "outseam"].map((k) => band(r.rows, k)).filter(Boolean).join(", ");
    const aliases = r.rows.some((x) => x.aliases) ? " +EU/US aliases" : "";
    return [
      `  #${i + 1}  ${r.gender} / ${r.age_group} / ${r.garment_type}  [${r.size_system}]  ${r.product_key ? "this product only" : "store-wide"}`,
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
   store-wide only; a product-scoped row is stored but not served in Phase 1. */
export function liveCoverage(records, live) {
  const want = records.filter((r) => !r.product_key && r.status === "active");
  const has = (r) => live.charts.some((c) => c.gender === r.gender && c.age_group === r.age_group &&
    c.garment_type === r.garment_type && (c.size_system || "unknown") === r.size_system && c.source === r.source);
  return { expected: want.length, live: want.filter(has).length };
}

/** The one-line reason when nothing was captured, with the manual way in. */
export function reasonLine(kind, host, extra = "") {
  const manual = `npm run import:chart -- --host ${host}`;
  const lines = {
    blocked: `BLOCKED - ${host} refused our requests${extra ? " (" + extra + ")" : ""}. We do not work around bot protection. ` +
      `Manual way in: open the size guide in your own browser, save it (Ctrl+S) or screenshot it, then\n    ${manual} --html <saved-page.html>   (or --image <screenshot.png>)`,
    image_unreadable: `IMAGE UNREADABLE - the guide is an image and it could not be turned into a valid chart${extra ? " (" + extra + ")" : ""}. ` +
      `Manual way in: a sharper screenshot of just the table:\n    ${manual} --image <screenshot.png> --gender <men|women|unisex> --type <tops|bottoms|jeans|dresses|outerwear>`,
    js_unreadable: `JS GUIDE NOT OPENED - the store renders its guide client-side and the browser fallback did not find a readable table${extra ? " (" + extra + ")" : ""}. ` +
      `Manual way in: open it yourself, save the page with the guide open, then\n    ${manual} --html <saved-page.html>`,
    browser_unavailable: `BROWSER UNAVAILABLE - ${extra || "Chromium could not start"}. Run \`npx playwright install chromium\` in the repo root, or:\n    ${manual} --url <size-guide-page-url>`,
    no_measurements: `GUIDE HAS NO BODY MEASUREMENTS - ${host}'s size guide opened, but it is a size-CONVERSION table ` +
      `(EU/IT/UK/US...) with no chest/waist/hip columns, so there is nothing to fit a body against${extra ? " (" + extra + ")" : ""}. ` +
      `If the store publishes a measurement chart elsewhere:\n    ${manual} --url <that-page>   (or --html / --image)`,
    none: `NO SIZE GUIDE FOUND on the sampled pages${extra ? " (" + extra + ")" : ""}. If the store has one, point at it:\n    ${manual} --url <size-guide-page-url>   (or --html / --image)`,
    unreachable: `UNREACHABLE - ${host} did not answer${extra ? " (" + extra + ")" : ""}. Check the URL, or:\n    ${manual} --html <saved-page.html>`,
  };
  return lines[kind] || lines.none;
}

/** Save (the Phase 1 path), then confirm against the live endpoint. */
export async function saveAndVerify({ supabase, records, host, saveSizeChartRecords, log = console.log, fetchImpl = fetch }) {
  const res = await saveSizeChartRecords(supabase, records, log);
  if (!res.saved) {
    log(`Nothing saved (${res.skipped || "no charts"}).`);
    return { saved: 0, skipped: res.skipped || "no charts" };
  }
  log(`✓ saved ${res.saved} chart(s) to store_size_charts`);
  const live = await fetchLiveCharts(host, { fetchImpl });
  log(formatLive(live));
  const cov = liveCoverage(records, live);
  log(cov.live === cov.expected
    ? `✓ all ${cov.expected} store-wide chart(s) just saved are live`
    : `… ${cov.live}/${cov.expected} store-wide chart(s) visible yet - the endpoint caches for up to 5 minutes; re-check with curl ${live.url}`);
  return { saved: res.saved, live, coverage: cov };
}
