/* THE STORE'S MODEL IS PAINTED OUT OF THE REAR REFERENCE - "in the first measurement it just added the
   guy who models the shirt, with his back to the camera" (FOX 1824346900 "חולצה עם הדפס", 2026-10-08;
   the store's rear photo is a man standing with his back to the camera). See lib/garment-box.js.
   ─────────────────────────────────────────────────────────────────────────────
   §1  THE GEOMETRY on the box the store's own photo calls for: the band starts just above the
       collar (the head is out) and ends just past the hem (the jeans are out).
   §2  IT ABSTAINS - the photo goes whole, today's behaviour - on no person (a packshot), an unsure or
       malformed box, a tiny box, and a band that would keep nearly the whole height.
   §3  BOTTOMS keep their waistband and hem.
   §4  THE MODEL CALL: the region reaches the prompt, only a real answer is a verdict, a 429 throws
       (so it is never cached), a non-image or a failed fetch is an error, no key is "unconfigured".
   §5  THE ENDPOINT: a public http(s) photo only, and only a verdict is cached (memory + CDN).
   What this cannot see: whether the model's box is GOOD on a given photo. That is checked by eye on
   the deployed endpoint for the store photo in the report before the room relies on it. */
import { readFileSync } from "node:fs";
import { garmentBandFromDetection, detectGarmentBand, garmentBoxPrompt } from "../lib/garment-box.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 a model-worn tee, from behind ──");
/* The box the store's rear photo calls for (fox.co.il 1824346900-3.jpg, 1000x1499, normalized
   0-1000), read by eye: the collar's back at ~0.35 with the head above it (hair from ~0.15), the hem
   at ~0.89, light jeans from there to the frame's bottom; sleeves from ~0.17 to ~0.81. */
const BACK = { worn_by_person: true, confidence: 0.95, box_2d: [350, 170, 890, 805] };
{
  const { band, reason } = garmentBandFromDetection(BACK, "top");
  check("a band is made", !!band && reason === "band", JSON.stringify({ band, reason }));
  if (band) {
    check("the collar is in (the band starts a sliver above the box's top)", band.y0 < 0.35 && band.y0 > 0.33, String(band.y0));
    check("the head is out (it ends at ~0.33; the hair starts at ~0.15)", band.y0 > 0.3, String(band.y0));
    check("the hem is in, and the jeans below it are out", band.y1 > 0.89 && band.y1 < 0.9, String(band.y1));
    check("the box's x travels for the record, unpadded", band.x0 === 0.17 && band.x1 === 0.805, `${band.x0}..${band.x1}`);
  }
}

console.log("\n── §2 it abstains rather than guess ──");
const none = (det, region = "top") => garmentBandFromDetection(det, region).band === null;
check("no answer at all", none(null) && none(undefined) && none("x"));
check("no person in the photo (a packshot / flat-lay: most of a catalog) - sent whole",
  none({ ...BACK, worn_by_person: false }) && garmentBandFromDetection({ ...BACK, worn_by_person: false }, "top").reason === "no-person");
check("worn_by_person missing is not a yes", none({ confidence: 0.9, box_2d: BACK.box_2d }));
check("an unsure box", none({ ...BACK, confidence: 0.4 }) && none({ ...BACK, confidence: NaN }) && none({ ...BACK, confidence: undefined }));
check("a malformed box", none({ ...BACK, box_2d: [1, 2, 3] }) && none({ ...BACK, box_2d: ["a", 1, 2, 3] }) &&
  none({ ...BACK, box_2d: null }) && none({ ...BACK, box_2d: [null, 100, 800, 900] }));
check("an inverted or tiny box (not the subject)", none({ ...BACK, box_2d: [800, 100, 300, 900] }) && none({ ...BACK, box_2d: [400, 400, 480, 460] }));
check("a garment that already fills the height (nothing above or below to paint)",
  none({ ...BACK, box_2d: [20, 300, 985, 700] }) && garmentBandFromDetection({ ...BACK, box_2d: [20, 300, 985, 700] }, "top").reason === "fills-photo");
check("...but a garment that reaches only ONE edge still has the other side painted",
  !none({ ...BACK, box_2d: [20, 170, 700, 805] }) && !none({ ...BACK, box_2d: [300, 170, 1000, 805] }));
check("out-of-range values are clamped, never extrapolated", (() => {
  const { band } = garmentBandFromDetection({ ...BACK, box_2d: [-50, -80, 700, 1600] }, "top");
  return !band || (band.y0 >= 0 && band.y1 <= 1 && band.x0 >= 0 && band.x1 <= 1);
})());

console.log("\n── §3 bottoms keep their waistband and hem ──");
{
  const det = { worn_by_person: true, confidence: 0.9, box_2d: [480, 250, 960, 750] };
  const { band } = garmentBandFromDetection(det, "bottom");
  check("trousers: a band from just above the waistband to past the hem", !!band && band.y0 < 0.48 && band.y0 > 0.465 && band.y1 > 0.96,
    JSON.stringify(band));
  check("...the top above it is out", !!band && band.y0 > 0.4);
}

console.log("\n── §4 the model call ──");
{
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const mk = ({ imgType = "image/jpeg", imgStatus = 200, modelStatus = 200, answer = BACK } = {}) => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      if (!String(url).includes("generativelanguage")) {
        return { ok: imgStatus === 200, status: imgStatus, headers: { get: () => imgType }, arrayBuffer: async () => JPEG.buffer };
      }
      return {
        ok: modelStatus === 200, status: modelStatus, text: async () => "slow down",
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }),
      };
    };
    return { fetchImpl, seen };
  };
  const ok = mk();
  const r = await detectGarmentBand("http://cdn.example.com/tee-3.jpg", "top", "k", { fetchImpl: ok.fetchImpl });
  check("a real answer is a verdict with a band, the model's raw box beside it", r.source === "ai" && !!r.band &&
    JSON.stringify(r.raw) === JSON.stringify(BACK.box_2d), JSON.stringify(r));
  check("the photo is fetched over https", ok.seen[0].url === "https://cdn.example.com/tee-3.jpg");
  const body = JSON.parse(ok.seen[1].init.body);
  check("the prompt names the region and asks for a normalized box, deterministically",
    /UPPER body/.test(body.systemInstruction.parts[0].text) && /box_2d/.test(body.systemInstruction.parts[0].text) &&
      /EXCLUDE the head/.test(body.systemInstruction.parts[0].text) &&
      body.generationConfig.temperature === 0 && body.contents[0].parts[1].inline_data.mime_type === "image/jpeg");
  check("a bottoms prompt asks for the lower body", /LOWER body/.test(garmentBoxPrompt("bottom")) && /waistband/.test(garmentBoxPrompt("bottom")));
  const packshot = await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ answer: { ...BACK, worn_by_person: false } }).fetchImpl });
  check("'no person' is still a verdict (cacheable) - just without a band", packshot.source === "ai" && packshot.band === null);
  let threw = null;
  try { await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ modelStatus: 429 }).fetchImpl }); } catch (e) { threw = e; }
  check("a rate limit THROWS - it must never be cached as an answer", threw && threw.rateLimited === true);
  const e500 = await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ modelStatus: 500 }).fetchImpl });
  check("a model error is an error, not a verdict", e500.source === "error" && e500.band === null);
  const html = await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ imgType: "text/html" }).fetchImpl });
  const gone = await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ imgStatus: 404 }).fetchImpl });
  check("a URL that is not an image, or will not load, is an error", html.source === "error" && gone.source === "error");
  const nokey = await detectGarmentBand("https://cdn.example.com/p.jpg", "top", "", { fetchImpl: ok.fetchImpl });
  check("no key: 'unconfigured', and nothing is fetched", nokey.source === "unconfigured" && nokey.band === null && ok.seen.length === 2);
}

console.log("\n── §5 the endpoint ──");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
{
  const a = SERVER.indexOf('app.get("/api/garment-box"');
  const route = a === -1 ? "" : SERVER.slice(a, SERVER.indexOf("\n});\n", a));
  check("GET /api/garment-box exists, rate-limited like the other model calls", /app\.get\("\/api\/garment-box", classifyLimiter,/.test(SERVER));
  check("only a public http(s) photo is fetched - the image proxy's own private-host guard",
    /\^https\?:\\\/\\\//.test(route) && /isProxyHostAllowed\(parsed\.hostname, parsed\.protocol\)/.test(route));
  check("only a verdict is cached - in memory and at the CDN; an error or a throttle is no-store",
    /if \(out\.source === "ai"\) \{[\s\S]*?_garmentBoxMemo\.set\(key[\s\S]*?s-maxage=[\s\S]*?\} else \{\s*\n\s*res\.setHeader\("Cache-Control", "no-store"\);/.test(route) &&
      /catch \(e\) \{[\s\S]*?no-store[\s\S]*?rate-limited/.test(route));
  check("the memo is keyed by the CANONICAL photo (CLAUDE.md §2.2) and the region",
    /const key = `\$\{canonicalImageUrl\(imageUrl\) \|\| imageUrl\}\|\$\{region\}`;/.test(route));
  check("the answer names no vendor (§2.24: source is \"ai\")", !/gemini/i.test(route.replace(/GEMINI_API_KEY/g, "")));
}

console.log(fails === 0 ? "\ngarment-box: OK" : `\ngarment-box: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
