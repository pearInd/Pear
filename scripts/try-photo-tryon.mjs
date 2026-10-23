#!/usr/bin/env node
/* =============================================================================
   Try the photo try-on from the terminal - one real call, one image back.

     node scripts/try-photo-tryon.mjs <person photo> <garment photo or URL> [options]

     --bottom            the garment is worn on the lower body (default: upper body)
     --name "PEAK Tee"   the garment's name, as the room would send it
     --out result.png    where to save the result (default: photo-tryon-<time>.png)
     --server <origin>   go through a running server's POST /api/photo-tryon
                         (e.g. http://localhost:3000) instead of calling the module directly

   Needs GEMINI_API_KEY in .env (or the environment) unless --server is used - then the
   SERVER's key is the one that counts. Each run is one billed image generation.

   WHAT THIS SKIPS: the room's full-body check (photoShowsFullBody() in app.js) runs the
   pose model in the browser, so it is not here. Use a photo with the whole body in frame,
   head to feet, or the result is what the room would never have sent.

   Large photos are shrunk to 1024px with macOS `sips` (also turns HEIC into JPEG), the
   same size the room sends; elsewhere they are sent as they are if small enough.
   ============================================================================= */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sanitizePhotoTryOnRequest, photoTryOn, PHOTO_TRYON_MODEL } from "../lib/photo-tryon.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const bottom = bool("--bottom");
const name = flag("--name") || "";
const server = flag("--server");
const out = path.resolve(flag("--out") || `photo-tryon-${Date.now()}.png`);
const [personPath, garmentArg] = args;

if (!personPath || !garmentArg) {
  console.error("usage: node scripts/try-photo-tryon.mjs <person photo> <garment photo or URL> [--bottom] [--name \"...\"] [--out result.png] [--server http://localhost:3000]");
  process.exit(2);
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/* A local file → a data: URL the room would send: ≤1024px JPEG when sips can make one. */
function fileToDataUrl(file) {
  if (!fs.existsSync(file)) { console.error(`✖ not found: ${file}`); process.exit(2); }
  let src = file;
  try {
    const tmp = path.join(os.tmpdir(), `pear-try-${process.pid}-${path.basename(file)}.jpg`);
    execFileSync("sips", ["-Z", "1024", "-s", "format", "jpeg", file, "--out", tmp], { stdio: "ignore" });
    src = tmp;
  } catch { /* no sips (not macOS) - send the file as it is */ }
  const mime = src === file ? MIME[path.extname(file).toLowerCase()] : "image/jpeg";
  if (!mime) { console.error(`✖ ${file}: use a .jpg, .png or .webp (or run on macOS, where sips converts it)`); process.exit(2); }
  return `data:${mime};base64,${fs.readFileSync(src).toString("base64")}`;
}

async function garmentDataUrl(arg) {
  if (!/^https?:\/\//i.test(arg)) return fileToDataUrl(arg);
  const resp = await fetch(arg);
  if (!resp.ok) { console.error(`✖ garment URL answered HTTP ${resp.status}`); process.exit(1); }
  const tmp = path.join(os.tmpdir(), `pear-try-garment-${process.pid}${path.extname(new URL(arg).pathname) || ".jpg"}`);
  fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
  return fileToDataUrl(tmp);
}

const body = {
  person: fileToDataUrl(personPath),
  garments: [{ image: await garmentDataUrl(garmentArg), region: bottom ? "lower_body" : "upper_body", name }],
};
const req = sanitizePhotoTryOnRequest(body);
if (!req.person || !req.garments.length) {
  console.error("✖ a photo was refused (over ~2.2 MB after resizing, or not jpg/png/webp)");
  process.exit(1);
}

console.log(`→ ${server ? `${server}/api/photo-tryon` : PHOTO_TRYON_MODEL}: 1 person photo + 1 garment (${bottom ? "lower" : "upper"} body)…`);
const t0 = Date.now();
let answer;
if (server) {
  const resp = await fetch(`${server.replace(/\/$/, "")}/api/photo-tryon`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  answer = await resp.json().catch(() => ({ ok: false, reason: `HTTP ${resp.status}` }));
} else {
  if (!process.env.GEMINI_API_KEY) { console.error("✖ GEMINI_API_KEY is not set (.env or the environment)"); process.exit(1); }
  answer = await photoTryOn(req, process.env.GEMINI_API_KEY);
}

if (!answer.ok) {
  console.error(`✖ no image: ${answer.reason}  (${Date.now() - t0}ms)`);
  process.exit(1);
}
const m = /^data:image\/(\w+);base64,(.+)$/.exec(answer.image);
const file = m && m[1] !== "png" ? out.replace(/\.png$/i, "." + m[1]) : out;
fs.writeFileSync(file, Buffer.from(m ? m[2] : "", "base64"));
console.log(`✓ saved ${file}  (${Date.now() - t0}ms)`);
