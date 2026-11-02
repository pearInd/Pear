/* =============================================================================
   PEAR · back photos prepared before the first visitor (2026-11-02, CLAUDE.md §7.22)
   -----------------------------------------------------------------------------
   A product with no rear photo waits on its first visit for the server to generate one: 94s from
   the page to the render on FOX's zip jacket (§7.20), ~27s of it the generation. This stage asks
   for that rear ahead of time, through the SAME route the widget uses (POST /api/classify-images
   with synthesize_back) - so it lands in the same durable store under the same key, and a first
   visitor reads it like a second one. Nothing here generates anything itself.

   THE COST IS REAL AND BOUNDED: each generation is one image-model call (GEMINI_IMAGE_MODEL in
   server.js, billed at that model's rate - not the render engine). So:
     · a plan unless --pregen-run is given;
     · a cap per run, per store (PREGEN_DEFAULTS.cap) - counting products ASKED, the upper bound on generations;
     · best sellers first, where the store exposes that order;
     · what is done is remembered per store (state file), and the server's durable lookup comes first
       in synthesizeBackView() anyway, so losing the state file costs requests, not generations.

   A FAILURE COSTS NOTHING BUT THE HEAD START. It is logged and not remembered, so the next run asks
   again; the visitor falls back to today's on-demand path, which this stage does not touch.
   ============================================================================= */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const PREGEN_DEFAULTS = Object.freeze({
  cap: 25,               // products per run, per store
  concurrency: 2,        // the route also serves shoppers; a generation holds a request ~30s
  timeoutMs: 180_000,    // classification plus a generation
  apiBase: "https://app.pear-ai.io",
});

/** Which products to ask about: every image classified, none of them a back, not done before - best sellers first.
 *  A product with a skipped image is left out: its rear photo may be the one the classifier did not get to.
 *  @param {Map<string,string[]>} imagesByProduct  product URL -> its photos, in the store's order
 *  @param {Map<string,string>} views  photo -> "front" | "back" | "skipped"
 *  @param {string[]} popular  product URLs, best first; may be empty
 *  @returns {{plan: {productUrl: string, images: string[]}[], eligible: number}} */
export function planPregen(imagesByProduct, views, popular = [], done = new Set(), cap = PREGEN_DEFAULTS.cap) {
  const rank = new Map(popular.map((u, i) => [u, i]));
  const eligible = [];
  let order = 0;
  for (const [productUrl, images] of imagesByProduct) {
    const at = order++;
    if (done.has(productUrl) || !images.length) continue;
    if (images.some((u) => views.get(u) !== "front")) continue;
    eligible.push({ productUrl, images, r: rank.has(productUrl) ? rank.get(productUrl) : Infinity, at });
  }
  eligible.sort((a, b) => a.r - b.r || a.at - b.at);
  return {
    plan: eligible.slice(0, Math.max(0, cap)).map(({ productUrl, images }) => ({ productUrl, images })),
    eligible: eligible.length,
  };
}

/** One product through the widget's own route. Never rejects.
 *  @returns {Promise<{productUrl: string, outcome: "generated"|"real-back"|"none"|"failed", detail?: string}>} */
export async function askServerForBack(item, { apiBase = PREGEN_DEFAULTS.apiBase, timeoutMs = PREGEN_DEFAULTS.timeoutMs, fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(`${apiBase}/api/classify-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: item.images, synthesize_back: true, page_url: item.productUrl }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { productUrl: item.productUrl, outcome: "failed", detail: `HTTP ${resp.status}` };
    const data = await resp.json();
    const source = data && data.back_source;
    if (source === "synthetic") return { productUrl: item.productUrl, outcome: "generated" };
    if (source && source !== "none") return { productUrl: item.productUrl, outcome: "real-back", detail: source };
    return { productUrl: item.productUrl, outcome: "none" };
  } catch (e) {
    return { productUrl: item.productUrl, outcome: "failed", detail: String(e?.message || e).slice(0, 120) };
  }
}

/** The plan, a few at a time. Resolves when all have answered; a failure never stops the rest. `ask` is injected for the tests. */
export async function runPregen(plan, ask, { concurrency = PREGEN_DEFAULTS.concurrency, onResult = () => {} } = {}) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      const item = plan[next++];
      let r;
      try { r = await ask(item); } catch (e) { r = { productUrl: item.productUrl, outcome: "failed", detail: String(e?.message || e) }; }
      results.push(r);
      try { onResult(r); } catch { /* a report line never stops the queue */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.length || 1)) }, worker));
  return results;
}

/** A result worth not asking again. "none" is not: the server may have failed to generate it, or been switched off. */
export const isDone = (r) => r.outcome === "generated" || r.outcome === "real-back";

/** The store's best sellers as product URLs, or [] - priority is a preference; the scan never depends on it. */
export async function fetchBestSellers(baseUrl, { limit = 250, fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(`${baseUrl}/collections/all/products.json?sort_by=best-selling&limit=${limit}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.products || []).filter((p) => p && p.handle).map((p) => `${baseUrl}/products/${p.handle}`);
  } catch {
    return [];
  }
}

/* ── what was done, per store ──────────────────────────────────────────────────────────────────── */
const stateFile = (dir, host) => `${dir}/${String(host).replace(/[^a-z0-9.-]/gi, "_")}.json`;
export function loadDone(dir, host) {
  try {
    const list = JSON.parse(readFileSync(stateFile(dir, host), "utf8"));
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();   // no file, or a damaged one: the server's durable lookup still prevents a second generation
  }
}
export function saveDone(dir, host, done) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir, host), JSON.stringify([...done], null, 1));
}
