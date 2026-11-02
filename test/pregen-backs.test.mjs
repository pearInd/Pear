/* BACK PHOTOS BEFORE THE FIRST VISITOR (2026-11-02 - scanner/pregen-backs.js, CLAUDE.md §7.22). §1 who gets asked, in what order, how
   many; §2 the widget's own route, so the result lands where a visit reads it; §3 a failure costs nothing - the queue goes on, the
   product is asked again next run, and the on-demand path is what a visitor still has; §4 what the run remembers;
   §5 the scanner wiring: a plan unless told otherwise, and the scan's results are safe from this stage. */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as G from "../scanner/pregen-backs.js";
const read = (u) => readFileSync(new URL(u, import.meta.url), "utf8");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${String(detail).slice(0, 300)}`);
}
const prod = (id, ...imgs) => [`https://s/products/${id}`, imgs];
const IMAGES = new Map([prod("a", "a1", "a2"), prod("b", "b1", "b2"), prod("c", "c1"), prod("d", "d1", "d2"), prod("e", "e1")]);
const VIEWS = new Map([["a1", "front"], ["a2", "front"], ["b1", "front"], ["b2", "back"], ["c1", "front"], ["d1", "front"], ["d2", "skipped"], ["e1", "front"]]);
const urls = (r) => r.plan.map((p) => p.productUrl.split("/").pop()).join("");

console.log("\n── §1 who gets asked ──");
{
  check("§1.1 only products with every photo classified and none a back (b has a back; d has a photo the classifier did not reach)", urls(G.planPregen(IMAGES, VIEWS)) === "ace");
  check("§1.2 best sellers first, the rest in catalog order", urls(G.planPregen(IMAGES, VIEWS, ["https://s/products/e", "https://s/products/b"])) === "eac");
  const capped = G.planPregen(IMAGES, VIEWS, [], new Set(), 2);
  check("§1.3 the cap holds, and the report still knows how many are waiting", urls(capped) === "ac" && capped.eligible === 3);
  check("§1.4 a cap of 0 asks nobody", urls(G.planPregen(IMAGES, VIEWS, [], new Set(), 0)) === "");
  check("§1.5 what an earlier run did is not asked again - the cap reaches the next ones", urls(G.planPregen(IMAGES, VIEWS, [], new Set(["https://s/products/a"]), 2)) === "ce");
  check("§1.6 a default cap exists and is small", G.PREGEN_DEFAULTS.cap === 25 && G.PREGEN_DEFAULTS.concurrency === 2);
}

console.log("\n── §2 the widget's own route ──");
{
  const item = { productUrl: "https://s/products/a", images: ["a1", "a2"] };
  let seen = null;
  const answer = (body, ok = true, status = 200) => async (url, init) => { seen = { url, init }; return { ok, status, json: async () => body }; };
  const r = await G.askServerForBack(item, { apiBase: "https://x", fetchImpl: answer({ back_source: "synthetic", back: "https://b" }) });
  const sent = JSON.parse(seen.init.body);
  check("§2.1 POST /api/classify-images with synthesize_back, the gallery and the page", seen.url === "https://x/api/classify-images" && sent.synthesize_back === true && sent.images.join() === "a1,a2" && sent.page_url === item.productUrl);
  check("§2.2 a generated rear is reported as one", r.outcome === "generated");
  check("§2.3 a real rear the server found beats the scan's verdict: no generation happened", (await G.askServerForBack(item, { fetchImpl: answer({ back_source: "classifier" }) })).outcome === "real-back");
  const W = read("../widget/pear-widget.js");
  const call = W.slice(W.lastIndexOf("classify-images", W.indexOf("synthesize_back: !scrapedBack")) , W.indexOf("synthesize_back: !scrapedBack") + 40);
  check("§2.4 the widget asks the same route with the same permission (a visit lands on the same key)", /classify-images/.test(call) && /images/.test(call) && /synthesize_back: !scrapedBack/.test(call), call);
  const SERVER = read("../server.js");
  const fn = SERVER.slice(SERVER.indexOf("async function synthesizeBackView("), SERVER.indexOf("/* Resolve the pair the widget/fitting room actually consume"));
  check("§2.5 the server reads the durable store BEFORE it generates: a prepared rear costs a visitor no generation",
    fn.indexOf("fetchDurableSynthBack(frontUrl)") > 0 && fn.indexOf("fetchDurableSynthBack(frontUrl)") < fn.indexOf(":generateContent"));
  check("§2.6 ...and saves what it generates there", /saveDurableSynthBack\(frontUrl, inline\.data, mime\)/.test(fn));
}

console.log("\n── §3 a failure costs nothing ──");
{
  const item = { productUrl: "u", images: ["i"] };
  const failing = [
    ["HTTP 500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["network", async () => { throw new Error("offline"); }],
    ["not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } })],
  ];
  for (const [name, fetchImpl] of failing) check(`§3.1 ${name}: reported, never thrown`, (await G.askServerForBack(item, { fetchImpl })).outcome === "failed");
  const none = await G.askServerForBack(item, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ back_source: "none", back: "" }) }) });
  check("§3.2 the server could not generate: not remembered, asked again next run", none.outcome === "none" && !G.isDone(none));
  check("§3.3 a failure is not remembered either", !G.isDone({ outcome: "failed" }) && G.isDone({ outcome: "generated" }) && G.isDone({ outcome: "real-back" }));
  const plan = ["a", "b", "c", "d", "e"].map((productUrl) => ({ productUrl, images: [] }));
  let active = 0, peak = 0;
  const results = await G.runPregen(plan, async (it) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (it.productUrl === "b") throw new Error("boom");
    return { productUrl: it.productUrl, outcome: "generated" };
  }, { onResult: (r) => { if (r.productUrl === "c") throw new Error("report line"); } });
  check("§3.4 one failure and a failing report line stop nothing: every product answered", results.length === 5 && results.filter((r) => r.outcome === "failed").length === 1);
  check("§3.5 at most `concurrency` at a time", peak === 2, peak);
  check("§3.6 an empty plan resolves", (await G.runPregen([], async () => ({}))).length === 0);
  check("§3.7 no best-seller list is a preference lost, not an error", (await G.fetchBestSellers("https://s", { fetchImpl: async () => { throw new Error("x"); } })).length === 0 &&
    (await G.fetchBestSellers("https://s", { fetchImpl: async () => ({ ok: false }) })).length === 0);
  const best = await G.fetchBestSellers("https://s", { fetchImpl: async () => ({ ok: true, json: async () => ({ products: [{ handle: "z" }, {}] }) }) });
  check("§3.8 the list reads as product URLs", best.join() === "https://s/products/z");
  const SERVER = read("../server.js");
  check("§3.9 the on-demand path a visitor falls back to is unchanged: a failed generation is never cached", /job\.then\(\(r\) => \{ if \(!r\) synthBackCache\.delete\(frontUrl\); \}\);/.test(SERVER) && /if \(!views\.back && wantSynth && views\.front\)/.test(SERVER));
}

console.log("\n── §4 what a run remembers ──");
{
  const dir = mkdtempSync(join(tmpdir(), "pregen-"));
  try {
    check("§4.1 nothing yet: an empty set", G.loadDone(dir, "fox.co.il").size === 0);
    G.saveDone(dir, "fox.co.il", new Set(["a", "b"]));
    check("§4.2 saved per store", G.loadDone(dir, "fox.co.il").size === 2 && G.loadDone(dir, "other.com").size === 0);
    writeFileSync(join(dir, "bad.com.json"), "{not json");
    check("§4.3 a damaged file reads as empty (the durable lookup still prevents a second generation)", G.loadDone(dir, "bad.com").size === 0);
    G.saveDone(join(dir, "new", "sub"), "a/../b", new Set(["x"]));
    check("§4.4 a host cannot climb out of the directory", G.loadDone(join(dir, "new", "sub"), "a/../b").has("x"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("\n── §5 the scanner's wiring ──");
{
  const SCAN = read("../scanner/scan-store.js");
  const stage = SCAN.slice(SCAN.indexOf("async function pregenBacks("), SCAN.indexOf("/* ── size-guide mode"));
  check("§5.1 off unless asked: a plain scan never reaches it", /if \(PREGEN_MODE\) \{\s*\n\s*try \{\s*\n\s*await pregenBacks\(/.test(SCAN));
  check("§5.2 a plan unless --pregen-run: the paid call sits after that return", stage.indexOf("if (!PREGEN_RUN)") > 0 && stage.indexOf("if (!PREGEN_RUN)") < stage.indexOf("askServerForBack(item"));
  const summary = SCAN.indexOf("image(s) skipped (throttled/failed)"), call2 = SCAN.indexOf("await pregenBacks(counters.views");
  check("§5.3 it runs after the scan's own summary, and its failure is caught", summary > 0 && call2 > summary && /await pregenBacks\(counters\.views, productUrlByImage\);\s*\n\s*\} catch \(e\)/.test(SCAN));
  check("§5.4 a skipped photo is marked, so that product waits for a clean scan", /counters\.views\.set\(imageUrl, "skipped"\)/.test(SCAN));
  check("§5.5 progress is saved per result: a killed run does not pay twice", /if \(isDone\(r\)\) \{ done\.add\(r\.productUrl\); saveDone\(stateDir, host, done\); \}/.test(stage));
}

console.log(fails === 0 ? "\npregen-backs: OK" : `\npregen-backs: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
