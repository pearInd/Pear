#!/usr/bin/env node
/* ============================================================================
   build-edge-assets.mjs — the pose model's binaries, scrambled, for our edge (2026-10-03)
   ----------------------------------------------------------------------------
   The pose runtime (.wasm, ~9 MB) and model (~6 MB) carry the library's name hundreds of
   times inside them, and a binary cannot be cloaked the way JS is (scripts/cloak.mjs). So
   they are served from our edge (the Worker's static assets: Cloudflare, free and cached)
   XOR-scrambled under content-hash names - a download is noise - and the room unscrambles
   them in memory (app.js loadPoseLandmarker). Too large for the Vercel function anyway
   (its responses stop at ~4.5 MB).

   DETERMINISTIC: the key and the name derive from the content, so the room's build
   (scripts/build.mjs, which only reads lib/edge-assets.json) and the Worker's assets agree
   without either seeing the other. Run this, commit lib/edge-assets.json, then
   `cd cloudflare/orient && npx wrangler deploy` (the assets go up with the Worker).
   scripts/build.mjs refuses a node_modules whose runtime no longer matches the manifest.

   Usage: node scripts/build-edge-assets.mjs        (npm run build:edge-assets)
   ============================================================================ */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "cloudflare/orient/assets/a");
const CACHE = join(ROOT, "node_modules/.cache/pear-edge");
const MANIFEST = join(ROOT, "lib/edge-assets.json");
const RUNTIME = join(ROOT, "node_modules/@mediapipe/tasks-vision/wasm");
/* The model the room has always run (CLAUDE.md §2.19 - main's lite model), pinned by content. */
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export function edgeKey(contentSha) {
  return Buffer.concat([createHash("sha256").update("pear-edge:k1:" + contentSha).digest(), createHash("sha256").update("pear-edge:k2:" + contentSha).digest()]);
}
export function scramble(bytes, key) {
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  return out;
}

async function model() {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, "pose-model.bin");
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`model download ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(f, b);
  return b;
}

const items = {
  wasm: readFileSync(join(RUNTIME, "vision_wasm_internal.wasm")),
  wasmNosimd: readFileSync(join(RUNTIME, "vision_wasm_nosimd_internal.wasm")),
  model: await model(),
};
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const manifest = { v: 1, items: {} };
for (const [k, bytes] of Object.entries(items)) {
  const s = sha(bytes);
  const key = edgeKey(s);
  const scrambled = scramble(bytes, key);
  const name = sha(scrambled).slice(0, 20);
  writeFileSync(join(OUT, name), scrambled);
  manifest.items[k] = { name, key: key.toString("base64"), sha256: s, bytes: bytes.length };
  console.log(`   ${k.padEnd(11)} ${(bytes.length / 1048576).toFixed(1)} MB -> a/${name}`);
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ ${Object.keys(items).length} edge assets in cloudflare/orient/assets/a, manifest lib/edge-assets.json`);
