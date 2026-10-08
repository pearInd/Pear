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
   §6  THE ROOM: only the distinct REAR photo is asked about (the front goes as before), before the
       download; the mask sits between normalisation and the pre-encode; the picture keeps its size
       (a mask, never a crop); every abstain and failure sends the photo whole; ?ref_mask=0 is off.
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

console.log("\n── §6 the room ──");
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fnSrc = (open) => { const i = APP.indexOf(open); return i === -1 ? "" : APP.slice(i, APP.indexOf("\n}\n", i) + 3); };
{
  const blobFn = fnSrc("function garmentBlobCached(url) {");
  const iBand = blobFn.indexOf("referenceBackBand(url)"), iFetch = blobFn.indexOf("await fetchWithFallback(url)");
  const iNorm = blobFn.indexOf("normalizeToSupportedImage(raw)"), iMask = blobFn.indexOf("maskReferenceBand(normalized, url, await bandJob)");
  const iEnc = blobFn.indexOf("preEncodeReference(blob)");
  check("the band is asked for BEFORE the download starts, so the two overlap", iBand !== -1 && iBand < iFetch);
  check("the mask sits between normalisation and the pre-encode - what is encoded is what is sent (the prime too)",
    iNorm !== -1 && iNorm < iMask && iMask < iEnc);
  check("typeof-guarded (§2.7)", /typeof referenceBackBand === "function"/.test(blobFn) && /typeof maskReferenceBand === "function"/.test(blobFn));

  const hintFn = fnSrc("function referenceBackHint(url) {");
  check("only the garment's DISTINCT REAR photo, matched with sameImage(), never === (§2.2)",
    /distinctBackOf\(it\)/.test(hintFn) && /sameImage\(back, url\)/.test(hintFn) && !/===\s*url|url\s*===/.test(hintFn));
  check("a store-widget garment (custom:true) is NOT skipped", !/\.custom\b/.test(hintFn.replace(/\/\*[\s\S]*?\*\//g, "")));

  /* Run the band request for real, on a fake fetch and a fake room. */
  const bandBlock = APP.slice(APP.indexOf("const REF_BAND_TIMEOUT_MS"), APP.indexOf("/** The rows to paint on an image"));
  const make = (fetchImpl, item, search = "") => new Function("fetch", "location", "activeItem", "resolveLook", "distinctBackOf", "sameImage",
    "isBottomsGarment", "canonicalImageUrl", "abbrevImg", "AbortSignal", "console",
    bandBlock + "\nreturn { referenceBackBand, referenceBackHint, _refMaskLog };")(
    fetchImpl, { origin: "https://app.example", search }, item, () => null, (it) => it.back || null,
    (a, b) => String(a).split("?")[0] === String(b).split("?")[0], (it) => it.bottoms === true,
    (u) => String(u).split("?")[0], (u) => String(u).slice(0, 40), { timeout: () => undefined }, { log() {}, warn() {} });
  const item = { img: "https://cdn.example.com/tee-1.jpg", back: "https://cdn.example.com/tee-3.jpg" };
  let asked = [];
  const ANSWER = { band: { y0: 0.3419, y1: 0.8954, x0: 0.17, x1: 0.805 }, reason: "band" };
  const good = make(async (u) => { asked.push(u); return { ok: true, json: async () => ANSWER }; }, item);
  const c1 = await good.referenceBackBand("https://cdn.example.com/tee-3.jpg?width=1000");
  const c2 = await good.referenceBackBand("https://cdn.example.com/tee-3.jpg");
  check("a good answer comes back as the band, asked for with the photo and its region",
    c1 && c1.y0 === 0.3419 && c1.y1 === 0.8954 && c1.x0 === 0.17 &&
      /\/api\/garment-box\?image_url=https%3A%2F%2Fcdn\.example\.com%2Ftee-3\.jpg%3Fwidth%3D1000&region=top&v=1$/.test(asked[0]),
    asked[0]);
  check("...once per photo: another spelling of the same photo is the memo (canonical key)", asked.length === 1 && c2 === c1);
  check("THE FRONT IS NEVER ASKED ABOUT - it is sent exactly as before", good.referenceBackBand(item.img) === null && asked.length === 1);
  check("a photo the active garment does not own is not asked about", good.referenceBackBand("https://cdn.example.com/other.jpg") === null);
  check("an upload (data:/blob:) is not asked about", good.referenceBackBand("data:image/png;base64,AAAA") === null &&
    good.referenceBackBand("blob:https://app.example/1") === null);
  const off = make(async (u) => { asked.push(u); return { ok: true, json: async () => ANSWER }; }, item, "?ref_mask=0");
  check("?ref_mask=0 is the old behaviour - nothing is asked", off.referenceBackBand(item.back) === null);
  const whole = make(async () => ({ ok: true, json: async () => ({ band: null, reason: "no-person" }) }), item);
  check("'no band' from the server means the photo goes whole, and the record says why",
    (await whole.referenceBackBand(item.back)) === null && whole._refMaskLog.at(-1).why === "no-person");
  const bad = make(async () => ({ ok: true, json: async () => ({ band: { y0: -1, y1: 2 } }) }), item);
  check("a malformed band is refused", (await bad.referenceBackBand(item.back)) === null);
  const noX = make(async () => ({ ok: true, json: async () => ({ band: { y0: 0.3, y1: 0.9, x0: "a" } }) }), item);
  const nx = await noX.referenceBackBand(item.back);
  check("a band without a usable x still paints (edge colours only)", nx && nx.y0 === 0.3 && !("x0" in nx));
  let n = 0;
  const flaky = make(async () => { n++; throw new Error("timeout"); }, item);
  const f1 = await flaky.referenceBackBand(item.back);
  const f2 = await flaky.referenceBackBand(item.back);
  check("a timeout or network failure is 'send whole' AND is re-asked next time (never memoised)", f1 === null && f2 === null && n === 2);
  const e500 = make(async () => { n++; return { ok: false, status: 500 }; }, item);
  n = 0; await e500.referenceBackBand(item.back); await e500.referenceBackBand(item.back);
  check("...an HTTP error too", n === 2);
  asked = [];
  const pants = make(async (u) => { asked.push(u); return { ok: true, json: async () => ({ band: null }) }; }, { ...item, bottoms: true });
  await pants.referenceBackBand(item.back);
  check("a bottoms garment asks for the lower body", /region=bottom/.test(asked[0]));

  const rowsFn = new Function(fnSrc("function refMaskRows(band, h) {") + "\nreturn refMaskRows;")();
  const r = rowsFn({ y0: 0.3419, y1: 0.8954 }, 1499);
  check("the PEAK rear photo: rows 0-512 (the head) and 1342-1499 (the jeans) are painted", r && r.top === 513 && r.bottom === 1342, JSON.stringify(r));
  check("nothing worth painting -> null (the photo goes whole)", rowsFn({ y0: 0.001, y1: 0.999 }, 1499) === null &&
    rowsFn({ y0: 0.5, y1: 0.55 }, 1499) === null && rowsFn(null, 1499) === null && rowsFn({ y0: 0.3, y1: 0.9 }, 0) === null);
  check("one side only is still painted", !!rowsFn({ y0: 0.3, y1: 1 }, 1499) && !!rowsFn({ y0: 0, y1: 0.8 }, 1499));

  const maskFn = fnSrc("async function maskReferenceBand(blob, url, band) {");
  check("every abstain and every failure returns the ORIGINAL Blob",
    (maskFn.match(/return blob;/g) || []).length >= 3 && /catch \(e\) \{[\s\S]*?return blob;/.test(maskFn));
  check("the picture keeps its size - a mask, never a crop (new canvas W x H, drawn at 0,0)",
    /new OffscreenCanvas\(W, H\)/.test(maskFn) && /ctx\.drawImage\(bmp, 0, 0\);/.test(maskFn) && !/drawImage\(bmp, s?x/.test(maskFn));
  check("the painted rows are cleared first, so a PNG's alpha cannot show the model through the fill",
    /ctx\.clearRect\(0, y0, W, y1 - y0\); ctx\.fillStyle = fill; ctx\.fillRect\(0, y0, W, y1 - y0\);/.test(maskFn));
  check("a re-encode heavier than 1.25x the photo is not sent", /out\.size > blob\.size \* 1\.25\) \{ refMaskNote\(\{ did: "whole", why: "heavy" \}\); return blob; \}/.test(maskFn));
  check("a PNG stays a PNG with its alpha", /const png = \/\^image\\\/png\$\/i\.test/.test(maskFn) && /alpha: png/.test(maskFn));
  check("a TEST record carries what the mask did (ctx.ref)", /ref: typeof _refMaskLog !== "undefined" && _refMaskLog\.length \? _refMaskLog\.slice\(-3\) : undefined,/.test(APP));
  check("no second pose model in the browser (CLAUDE.md §2.15)", !/runningMode: "IMAGE"/.test(APP));
}

console.log(fails === 0 ? "\ngarment-box: OK" : `\ngarment-box: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
