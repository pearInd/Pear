/* A MODEL-WORN STORE PHOTO IS CUT DOWN TO THE GARMENT - "it put jeans on me, then pasted a giant
   back into the room" (FOX 1823925817, 2026-09-27; see the block above loadReferencePoseLandmarker()
   in fitting-room/app.js).
   ─────────────────────────────────────────────────────────────────────────────
   §1  THE GEOMETRY, on the REAL landmarks MediaPipe's pose model (lite, IMAGE mode, the room's own
       CDN version) returned for the store's photos: the head goes, the collar stays, the sleeves
       stay, the legs go - and the back photo (landmarks mirrored) crops the same way.
   §2  IT ABSTAINS: no body, shoulders not confidently seen, a body too small to matter.
   §3  LONG GARMENTS and BOTTOMS keep their length.
   §4  THE WIRING: only store URLs are cropped (an upload's data:/blob: URL has its own crop) - and a
       store-widget garment, which is custom:true, IS cropped; the owner is found
       with sameImage() - never === (CLAUDE.md §2.2) - and every failure sends the original photo.
   The pixels were checked in a real browser on eight model-worn photos (two products: 13-38% of the
   frame kept, prints and sleeves intact) and three packshots (no body found - untouched). */
import { readFileSync } from "node:fs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const a = APP.indexOf("function garmentCropRect(");
const garmentCropRect = new Function(APP.slice(a, APP.indexOf("\n}\n", a) + 3) + "\nreturn garmentCropRect;")();

/* MediaPipe's answer for the store's photos (x, y normalized; visibility), indices as MediaPipe
   numbers them: 0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26 knees,
   27/28 ankles. Measured 2026-09-27 on fox.co.il 1823925817-1.jpg (front) and -3.jpg (back). */
function pose(pts) {
  const L = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  for (const [i, [x, y, v]] of Object.entries(pts)) L[i] = { x, y, visibility: v };
  return L;
}
const FRONT = pose({ 0: [0.557, 0.261, 1], 11: [0.683, 0.403, 1], 12: [0.309, 0.407, 1], 13: [0.75, 0.606, 0.99], 14: [0.237, 0.608, 0.99],
  15: [0.744, 0.786, 0.97], 16: [0.25, 0.78, 0.98], 23: [0.607, 0.769, 1], 24: [0.389, 0.767, 1], 25: [0.625, 1.02, 0.96], 26: [0.356, 1.015, 0.96],
  27: [0.589, 1.222, 0.59], 28: [0.377, 1.205, 0.54] });
const BACK = pose({ 0: [0.584, 0.242, 0.99], 11: [0.298, 0.409, 1], 12: [0.693, 0.408, 1], 13: [0.225, 0.623, 0.99], 14: [0.78, 0.626, 0.99],
  15: [0.252, 0.799, 0.96], 16: [0.789, 0.811, 0.96], 23: [0.439, 0.806, 1], 24: [0.602, 0.81, 1], 25: [0.467, 1.097, 0.36], 26: [0.587, 1.073, 0.57],
  27: [0.511, 1.38, 0.16], 28: [0.539, 1.344, 0.14] });
const TOP = { region: "top", long: false };
const H = 1499;

console.log("── §1 a model-worn tee, front and back ──");
for (const [name, L] of [["front", FRONT], ["back (landmarks mirrored)", BACK]]) {
  const r = garmentCropRect(L, TOP, H);
  const shY = Math.min(L[11].y, L[12].y), hipY = (L[23].y + L[24].y) / 2;
  check(`${name}: a crop is made`, !!r, JSON.stringify(r));
  if (!r) continue;
  check(`${name}: the face is out (the crop starts below the nose, past the chin)`, r.y0 > L[0].y + 0.5 * (shY - L[0].y), `y0 ${r.y0.toFixed(3)}`);
  check(`${name}: the collar is in (the crop starts above the shoulder line)`, r.y0 < shY, `y0 ${r.y0.toFixed(3)} vs shoulders ${shY}`);
  check(`${name}: the hem is in (below the hips) and the legs are out (above the knees)`,
    r.y1 > hipY && r.y1 < Math.min(L[25].y, L[26].y), `y1 ${r.y1.toFixed(3)}`);
  check(`${name}: both sleeves are in (past each elbow)`, r.x0 < Math.min(L[13].x, L[14].x) && r.x1 > Math.max(L[13].x, L[14].x),
    `x ${r.x0.toFixed(3)}..${r.x1.toFixed(3)}`);
  const keep = (r.x1 - r.x0) * (r.y1 - r.y0);
  check(`${name}: most of the photo is dropped (kept ${Math.round(keep * 100)}%)`, keep > 0.2 && keep < 0.5);
}

console.log("\n── §2 it abstains rather than guess ──");
check("no landmarks (a packshot / flat-lay: no body) - no crop", garmentCropRect(undefined, TOP, H) === null && garmentCropRect([], TOP, H) === null);
const dim = FRONT.map((p, i) => (i === 11 || i === 12 ? { ...p, visibility: 0.2 } : p));
check("shoulders not confidently seen - no crop", garmentCropRect(dim, TOP, H) === null);
check("a body too small to matter (a 300px photo) - no crop", garmentCropRect(FRONT, TOP, 300) === null);
check("no hint (an owner the room does not know) - no crop", garmentCropRect(FRONT, null, H) === null);

console.log("\n── §3 long garments and bottoms keep their length ──");
const long = garmentCropRect(FRONT, { region: "top", long: true }, H);
check("a coat/dress: only the head goes - the crop runs to the bottom of the photo", long && long.y1 === 1 && long.y0 > FRONT[0].y, JSON.stringify(long));
const bottom = garmentCropRect(FRONT, { region: "bottom", long: false }, H);
check("trousers: from above the hips (the waistband) to the bottom of the photo",
  bottom && bottom.y0 < (FRONT[23].y + FRONT[24].y) / 2 && bottom.y0 > FRONT[11].y && bottom.y1 === 1, JSON.stringify(bottom));

console.log("\n── §4 the wiring ──");
{
  const blobFn = APP.slice(APP.indexOf("function garmentBlobCached(url) {"), APP.indexOf("\n}\n", APP.indexOf("function garmentBlobCached(url) {")));
  check("garmentBlobCached crops only store URLs, after normalisation, typeof-guarded (§2.7)",
    /!\/\^\(data:\|blob:\)\/i\.test\(url\) && typeof cropReferenceToGarment === "function"/.test(blobFn) &&
    blobFn.indexOf("normalizeToSupportedImage(raw)") < blobFn.indexOf("cropReferenceToGarment(blob, url)"));
  const hintFn = APP.slice(APP.indexOf("function referenceCropHint(url) {"), APP.indexOf("\n}\n", APP.indexOf("function referenceCropHint(url) {")));
  check("the owner is matched with sameImage(), never === (§2.2)",
    /sameImage\(u, url\)/.test(hintFn) && !/===\s*url|url\s*===/.test(hintFn));
  /* The first cut skipped `it.custom` - and every store-widget garment is custom:true (parseHandoff
     marks an embed that way), so the crop never ran for a single store product. Caught by opening
     the room on the real FOX photos before shipping. Uploads are excluded by URL instead. */
  check("a store-widget garment (custom:true) is NOT skipped - only data:/blob: uploads are, by URL",
    !/\.custom\b/.test(hintFn.replace(/\/\*[\s\S]*?\*\//g, "")));
  const cropFn = APP.slice(APP.indexOf("async function cropReferenceToGarment("), APP.indexOf("\n}\n", APP.indexOf("async function cropReferenceToGarment(")));
  check("every abstain and every failure returns the ORIGINAL photo", (cropFn.match(/return blob;/g) || []).length >= 5 &&
    /catch \(e\) \{[\s\S]*?return blob;/.test(cropFn));
  check("the reference landmarker is its own IMAGE-mode instance, never the live VIDEO one",
    /runningMode: "IMAGE"/.test(APP.slice(APP.indexOf("function loadReferencePoseLandmarker()"), APP.indexOf("function referenceCropHint(url)"))));
}

console.log(fails === 0 ? "\nreference-crop: OK" : `\nreference-crop: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
