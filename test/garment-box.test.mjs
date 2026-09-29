/* A MODEL-WORN STORE PHOTO IS CUT DOWN TO ITS GARMENT - "the shorts turned grey on the half turn,
   then the shirt came out half tucked" (FOX 1823750100 "חולצה קצרה OASIS", 2026-09-29; the store's
   rear photo is a model in grey cargo trousers). See lib/garment-box.js and the block above
   referenceCropHint() in fitting-room/app.js.
   ─────────────────────────────────────────────────────────────────────────────
   §1  THE GEOMETRY on the box the store's own photos call for: the head goes, the collar, both
       sleeves and the hem stay, the trousers go - front and back alike.
   §2  IT ABSTAINS - the photo goes whole, main's behaviour - on no person (a packshot), an unsure or
       malformed box, a tiny box, and a cut that would keep nearly the whole photo.
   §3  BOTTOMS keep their waistband and hem.
   §4  THE MODEL CALL: the region reaches the prompt, only a real answer is a verdict, a 429 throws
       (so it is never cached), a non-image or a failed fetch is an error, no key is "unconfigured".
   §5  THE ENDPOINT: a public http(s) photo only, and only a verdict is cached (memory + CDN).
   §6  THE ROOM: the box is asked for BEFORE the download (they overlap), the cut sits between
       normalisation and the pre-encode, store URLs only, the owner is matched with sameImage()
       (never ===, never skipping custom:true store garments), a timeout or failure is "send whole"
       and is re-asked next time, and the cut is never much heavier than the photo.
   What this cannot see: whether the model's box is GOOD on a given photo. That was checked by eye on
   the deployed endpoint for the store photos in the report before the room relied on it. */
import { readFileSync } from "node:fs";
import { garmentCropFromDetection, detectGarmentCrop, garmentBoxPrompt } from "../lib/garment-box.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 a model-worn tee, front and back ──");
/* Boxes as the store photos call for them (1000x1499, normalized 0-1000): measured by eye on
   fox.co.il 1823750100-1.jpg (front: the tee from the collar at ~0.34 to the hem, the frame's
   bottom edge cuts the trousers at mid-thigh) and -3.jpg (back: collar ~0.34, hem ~0.86, grey
   cargo trousers from there down, the head above). */
const FRONT = { worn_by_person: true, confidence: 0.93, box_2d: [335, 170, 905, 850] };
const BACK = { worn_by_person: true, confidence: 0.95, box_2d: [344, 167, 856, 817] };
for (const [name, det, trouserTop, headBottom] of [["front", FRONT, 0.92, 0.33], ["back", BACK, 0.87, 0.34]]) {
  const { crop, reason } = garmentCropFromDetection(det, "top");
  check(`${name}: a cut is made`, !!crop && reason === "crop", JSON.stringify({ crop, reason }));
  if (!crop) continue;
  const [ymin, xmin, ymax, xmax] = det.box_2d.map((v) => v / 1000);
  check(`${name}: the collar is in (the cut starts above the box's top)`, crop.y0 < ymin && crop.y0 > headBottom - 0.05, String(crop.y0));
  check(`${name}: the hem is in, and the trousers below it are out`, crop.y1 > ymax && crop.y1 < trouserTop, String(crop.y1));
  check(`${name}: both sleeves are in (the cut is wider than the box on each side)`, crop.x0 < xmin && crop.x1 > xmax,
    `${crop.x0}..${crop.x1}`);
  const keep = (crop.x1 - crop.x0) * (crop.y1 - crop.y0);
  check(`${name}: most of the photo is dropped (kept ${Math.round(keep * 100)}%)`, keep > 0.2 && keep < 0.6);
}

console.log("\n── §2 it abstains rather than guess ──");
const none = (det, region = "top") => garmentCropFromDetection(det, region).crop === null;
check("no answer at all", none(null) && none(undefined) && none("x"));
check("no person in the photo (a packshot / flat-lay: most of a catalog) - sent whole",
  none({ ...BACK, worn_by_person: false }) && garmentCropFromDetection({ ...BACK, worn_by_person: false }, "top").reason === "no-person");
check("worn_by_person missing is not a yes", none({ confidence: 0.9, box_2d: BACK.box_2d }));
check("an unsure box", none({ ...BACK, confidence: 0.4 }) && none({ ...BACK, confidence: NaN }) && none({ ...BACK, confidence: undefined }));
check("a malformed box", none({ ...BACK, box_2d: [1, 2, 3] }) && none({ ...BACK, box_2d: ["a", 1, 2, 3] }) && none({ ...BACK, box_2d: null }));
check("an inverted or tiny box (not the subject)", none({ ...BACK, box_2d: [800, 100, 300, 900] }) && none({ ...BACK, box_2d: [400, 400, 480, 460] }));
check("a garment that already fills the photo (nothing worth a re-encode)",
  none({ ...BACK, box_2d: [20, 30, 985, 975] }) && garmentCropFromDetection({ ...BACK, box_2d: [20, 30, 985, 975] }, "top").reason === "fills-photo");
check("out-of-range values are clamped, never extrapolated", (() => {
  const { crop } = garmentCropFromDetection({ ...BACK, box_2d: [-50, -80, 700, 600] }, "top");
  return !crop || (crop.x0 >= 0 && crop.y0 >= 0 && crop.x1 <= 1 && crop.y1 <= 1);
})());

console.log("\n── §3 bottoms keep their waistband and hem ──");
{
  const det = { worn_by_person: true, confidence: 0.9, box_2d: [480, 250, 960, 750] };
  const { crop } = garmentCropFromDetection(det, "bottom");
  check("trousers: a cut from just above the waistband to past the hem", !!crop && crop.y0 < 0.48 && crop.y0 > 0.45 && crop.y1 > 0.96,
    JSON.stringify(crop));
  check("...the top above it is out", !!crop && crop.y0 > 0.4);
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
  const r = await detectGarmentCrop("http://cdn.example.com/tee-3.jpg", "top", "k", { fetchImpl: ok.fetchImpl });
  check("a real answer is a verdict with a cut", r.source === "gemini" && !!r.crop, JSON.stringify(r));
  check("the photo is fetched over https", ok.seen[0].url === "https://cdn.example.com/tee-3.jpg");
  const body = JSON.parse(ok.seen[1].init.body);
  check("the prompt names the region and asks for a normalized box, deterministically",
    /UPPER body/.test(body.systemInstruction.parts[0].text) && /box_2d/.test(body.systemInstruction.parts[0].text) &&
      body.generationConfig.temperature === 0 && body.contents[0].parts[1].inline_data.mime_type === "image/jpeg");
  check("a bottoms prompt asks for the lower body", /LOWER body/.test(garmentBoxPrompt("bottom")) && /waistband/.test(garmentBoxPrompt("bottom")));
  const packshot = await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ answer: { ...BACK, worn_by_person: false } }).fetchImpl });
  check("'no person' is still a verdict (cacheable) - just without a cut", packshot.source === "gemini" && packshot.crop === null);
  let threw = null;
  try { await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ modelStatus: 429 }).fetchImpl }); } catch (e) { threw = e; }
  check("a rate limit THROWS - it must never be cached as an answer", threw && threw.rateLimited === true);
  const e500 = await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ modelStatus: 500 }).fetchImpl });
  check("a model error is an error, not a verdict", e500.source === "error" && e500.crop === null);
  const html = await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ imgType: "text/html" }).fetchImpl });
  const gone = await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "k", { fetchImpl: mk({ imgStatus: 404 }).fetchImpl });
  check("a URL that is not an image, or will not load, is an error", html.source === "error" && gone.source === "error");
  const nokey = await detectGarmentCrop("https://cdn.example.com/p.jpg", "top", "", { fetchImpl: ok.fetchImpl });
  check("no key: 'unconfigured', and nothing is fetched", nokey.source === "unconfigured" && nokey.crop === null);
}

console.log("\n── §5 the endpoint ──");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
{
  const a = SERVER.indexOf('app.get("/api/garment-box"');
  const route = a === -1 ? "" : SERVER.slice(a, SERVER.indexOf("\n});\n", a));
  check("GET /api/garment-box exists, rate-limited like the other model calls", /app\.get\("\/api\/garment-box", classifyLimiter,/.test(SERVER));
  check("only a public http(s) photo is fetched (no localhost, private ranges or IPv6 literals)",
    /\^https\?:\\\/\\\//.test(route) && /localhost/.test(route) && /192\\\.168/.test(route) && /172\\\.\(1\[6-9\]\|2\\d\|3\[01\]\)/.test(route));
  check("only a verdict is cached - in memory and at the CDN; an error or a throttle is no-store",
    /if \(out\.source === "gemini"\) \{[\s\S]*?_garmentBoxMemo\.set\(key[\s\S]*?s-maxage=[\s\S]*?\} else \{\s*\n\s*res\.setHeader\("Cache-Control", "no-store"\);/.test(route) &&
      /catch \(e\) \{[\s\S]*?no-store[\s\S]*?rate-limited/.test(route));
  check("the memo is keyed by the CANONICAL photo (CLAUDE.md §2.2) and the region",
    /const key = `\$\{canonicalImageUrl\(imageUrl\) \|\| imageUrl\}\|\$\{region\}`;/.test(route));
}

console.log("\n── §6 the room ──");
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fnSrc = (open) => { const i = APP.indexOf(open); return i === -1 ? "" : APP.slice(i, APP.indexOf("\n}\n", i) + 3); };
{
  const blobFn = fnSrc("function garmentBlobCached(url) {");
  const iBox = blobFn.indexOf("referenceGarmentBox(url)"), iFetch = blobFn.indexOf("await fetchWithFallback(url)");
  const iNorm = blobFn.indexOf("normalizeToSupportedImage(raw)"), iCut = blobFn.indexOf("cropReferenceToBox(blob, url, await boxJob)");
  const iEnc = blobFn.indexOf("preEncodeReference(blob)");
  check("the box is asked for BEFORE the download starts, so the two overlap", iBox !== -1 && iBox < iFetch);
  check("the cut sits between normalisation and the pre-encode - what is encoded is what is sent",
    iNorm !== -1 && iNorm < iCut && iCut < iEnc);
  check("store URLs only (an upload's data:/blob: URL has its own garment crop), typeof-guarded (§2.7)",
    /const boxJob = !\/\^\(data:\|blob:\)\/i\.test\(url\) && typeof referenceGarmentBox === "function"/.test(blobFn) &&
      /typeof cropReferenceToBox === "function"/.test(blobFn));

  const hintFn = fnSrc("function referenceCropHint(url) {");
  check("the owner is matched with sameImage(), never === (§2.2)", /sameImage\(u, url\)/.test(hintFn) && !/===\s*url|url\s*===/.test(hintFn));
  check("a store-widget garment (custom:true) is NOT skipped", !/\.custom\b/.test(hintFn.replace(/\/\*[\s\S]*?\*\//g, "")));

  /* Run the box request for real, on a fake fetch and a fake room. */
  const boxBlock = APP.slice(APP.indexOf("const REF_BOX_TIMEOUT_MS"), APP.indexOf("/** The reference Blob cut to `crop`"));
  const make = (fetchImpl, item) => new Function("fetch", "location", "activeItem", "resolveLook", "galleryOf", "sameImage", "isBottomsGarment",
    "canonicalImageUrl", "abbrevImg", "AbortSignal", "console",
    boxBlock + "\nreturn { referenceGarmentBox, referenceCropHint, _refBoxJobs };")(
    fetchImpl, { origin: "https://app.example" }, item, () => null, (it) => ({ front: it.img, back: it.back }),
    (a, b) => String(a).split("?")[0] === String(b).split("?")[0], (it) => it.bottoms === true,
    (u) => String(u).split("?")[0], (u) => String(u).slice(0, 40), { timeout: () => undefined }, { log() {}, warn() {} });
  const item = { img: "https://cdn.example.com/tee-1.jpg", back: "https://cdn.example.com/tee-3.jpg" };
  let asked = [];
  const good = make(async (u) => { asked.push(u); return { ok: true, json: async () => ({ crop: { x0: 0.13, y0: 0.32, x1: 0.86, y1: 0.87 }, reason: "crop" }) }; }, item);
  const c1 = await good.referenceGarmentBox("https://cdn.example.com/tee-3.jpg?width=1000");
  const c2 = await good.referenceGarmentBox("https://cdn.example.com/tee-3.jpg");
  check("a good answer comes back as the cut, asked for with the photo and its region",
    c1 && c1.y1 === 0.87 && /\/api\/garment-box\?image_url=https%3A%2F%2Fcdn\.example\.com%2Ftee-3\.jpg%3Fwidth%3D1000&region=top&v=1$/.test(asked[0]),
    asked[0]);
  check("...once per photo: another spelling of the same photo is the memo (canonical key)", asked.length === 1 && c2 === c1);
  check("a photo the active garment does not own is not asked about", good.referenceGarmentBox("https://cdn.example.com/other.jpg") === null);
  const whole = make(async () => ({ ok: true, json: async () => ({ crop: null, reason: "no-person" }) }), item);
  check("'no cut' from the server means the photo goes whole", (await whole.referenceGarmentBox(item.img)) === null);
  const bad = make(async () => ({ ok: true, json: async () => ({ crop: { x0: -1, y0: 0, x1: 2, y1: 1 } }) }), item);
  check("a malformed cut is refused", (await bad.referenceGarmentBox(item.img)) === null);
  let n = 0;
  const flaky = make(async () => { n++; throw new Error("timeout"); }, item);
  const f1 = await flaky.referenceGarmentBox(item.img);
  const f2 = await flaky.referenceGarmentBox(item.img);
  check("a timeout or network failure is 'send whole' AND is re-asked next time (never memoised)", f1 === null && f2 === null && n === 2);
  const pants = make(async (u) => { asked.push(u); return { ok: true, json: async () => ({ crop: null }) }; }, { ...item, bottoms: true });
  asked = [];
  await pants.referenceGarmentBox(item.img);
  check("a bottoms garment asks for the lower body", /region=bottom/.test(asked[0]));

  const cutFn = fnSrc("async function cropReferenceToBox(blob, url, crop) {");
  check("every abstain and every failure returns the ORIGINAL Blob",
    (cutFn.match(/return blob;/g) || []).length >= 4 && /catch \(e\) \{[\s\S]*?return blob;/.test(cutFn));
  check("the cut is re-encoded down toward the photo's own weight, and sent whole if it stays over 1.25x",
    /out\.size > blob\.size\) out = await encode\(0\.85\)/.test(cutFn) && /out\.size > blob\.size \* 1\.25\) return blob;/.test(cutFn));
  check("a PNG stays a PNG with its alpha (a transparent cut-out must not turn black)",
    /const png = \/\^image\\\/png\$\/i\.test/.test(cutFn) && /getContext\("2d", \{ alpha: png \}\)/.test(cutFn));
  check("no second pose model in the browser (CLAUDE.md §2.15)",
    !/loadReferencePoseLandmarker|runningMode: "IMAGE"/.test(APP));
}

console.log(fails === 0 ? "\ngarment-box: OK" : `\ngarment-box: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
