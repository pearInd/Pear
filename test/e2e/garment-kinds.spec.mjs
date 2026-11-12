/* =============================================================================
   PEAR - the garment kinds, routed through the real room (CLAUDE.md §7.23)
   -----------------------------------------------------------------------------
   One room per garment type, opened the way the widget opens it (a store photo pair and the product's title), walked
   through the size screen like a shopper. The room prefetches its prompts the moment the garment is chosen; each answer
   is a token (CLAUDE.md §7.21) that this test expands with the REAL engine (lib/prompt-token.js), so every assertion is
   about the words the render engine would receive - from the title the room was handed, through the room's own facts
   and TEST flag, to the anchor the engine selected.

   WHAT IT DOES NOT PROVE: how a dress or a skirt looks on a body. The harness has no render engine (§8.4); only a
   billed rig session shows that (CLAUDE.md §7.23 lists the ones run). Nothing here is billed: no session is opened.
   Run: npm run test:kinds  (deliberately not named test:e2e - see CLAUDE.md §4).
   ============================================================================= */
import { test, expect } from "@playwright/test";
import { startStaticServer } from "./static-server.mjs";
import { expandPromptToken } from "../../lib/prompt-token.js";

let server;
test.beforeAll(async () => { server = await startStaticServer(); });
test.afterAll(async () => { await server?.close(); });

function roomUrl(base, name, testSession) {
  const q = new URLSearchParams({
    pear_demo: "1", mock_decart: "1",
    garment_url: `${base}/test/fixtures/garment/front.png`,
    garment_url_back: `${base}/test/fixtures/garment/back.png`,
    garment_name: name,
    ...(testSession ? { pear_key: "TEST" } : {}),
  });
  return `${base}/fitting-room/?${q}`;
}

/** Open the room for `name`, pass the size screen, and return the expanded prompts it prefetched, by angle. */
async function promptsFor(page, name, testSession) {
  const seen = [];
  await page.route((url) => url.origin !== server.url && url.protocol !== "data:" && url.protocol !== "blob:", (r) => r.abort());
  page.on("response", async (resp) => {
    if (new URL(resp.url()).pathname !== "/api/prompt") return;
    try {
      const body = JSON.parse(resp.request().postData() || "{}");
      const { prompt } = await resp.json();
      seen.push({ req: body, words: expandPromptToken(prompt) });
    } catch (_) { /* a page that closed mid-answer */ }
  });
  await page.goto(roomUrl(server.url, name, testSession), { waitUntil: "domcontentloaded" });
  await page.locator("#cookieAcceptAll").click();
  await page.locator("#height").fill("178");
  await page.locator("#weight").fill("74");
  await page.locator("#consentTerms").check();
  await page.locator("#btn-next-screen").click();
  await expect(page.locator("#screen-fitting")).toHaveClass(/active/, { timeout: 20_000 });
  await expect.poll(() => ["front", "back"].every((a) => seen.some((s) => s.req.kind === "single" && s.req.angle === a && s.words)),
    { timeout: 20_000, message: "the room prefetches a front and a back prompt" }).toBe(true);
  const byAngle = (a) => seen.filter((s) => s.req.kind === "single" && s.req.angle === a && s.words);
  return { front: byAngle("front"), back: byAngle("back") };
}

const CASES = [
  { type: "dress", name: "So Far So Good Maxi Dress", front: "Drape and fit the EXACT static dress from", back: "Drape and fit the EXACT static dress's REAR/BACK" },
  { type: "skirt", name: "חצאית מקסי סריג", front: "Drape and fit the EXACT static skirt from", back: "Drape and fit the EXACT static skirt's REAR/BACK" },
  { type: "jeans", name: "ג'ינס סקיני", front: "Drape and fit the EXACT static pants/shorts from", back: "Drape and fit the EXACT static pants/shorts REAR/BACK" },
  { type: "tank top", name: "Ribbed Tank Top", front: "Drape and fit the EXACT static top from", back: "Drape and fit the EXACT static shirt's REAR/BACK" },
  { type: "zip jacket", name: "Zip Jacket", front: "Drape and fit the EXACT static top from", back: "Drape and fit the EXACT static shirt's REAR/BACK", closure: true },
];

for (const c of CASES) {
  test(`a TEST session routes a ${c.type} to its wording`, async ({ page }) => {
    const p = await promptsFor(page, c.name, true);
    for (const s of [...p.front, ...p.back]) {
      expect(s.req.test, "a TEST session flags every prompt request").toBe(true);
      expect(s.words.prompt.length).toBeLessThanOrEqual(650);
    }
    for (const s of p.front) expect(s.words.prompt.startsWith(c.front), s.words.prompt).toBe(true);
    for (const s of p.back) expect(s.words.prompt.startsWith(c.back), s.words.prompt).toBe(true);
    if (c.closure) expect(p.front.some((s) => /fastened/.test(s.words.prompt))).toBe(true);
    if (c.type === "skirt") for (const s of [...p.front, ...p.back]) expect(/\b(pants|shorts|trousers?|leg profile|ankle)\b/i.test(s.words.prompt)).toBe(false);
    if (c.type === "dress") for (const s of p.front) expect(/lower body/.test(s.words.prompt), "no 'keep the lower body' on a dress").toBe(false);
  });
}

test("a SHOPPER's session keeps today's wording for the same dress (the kind is TEST-only until measured)", async ({ page }) => {
  const p = await promptsFor(page, "So Far So Good Maxi Dress", false);
  for (const s of [...p.front, ...p.back]) expect(s.req.test).toBeUndefined();
  for (const s of p.front) expect(s.words.prompt.startsWith("Drape and fit the EXACT static top from"), s.words.prompt).toBe(true);
  for (const s of p.back) expect(s.words.prompt.startsWith("Drape and fit the EXACT static shirt's REAR/BACK"), s.words.prompt).toBe(true);
});
