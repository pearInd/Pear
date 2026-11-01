/* THE HEAVY REFERENCE (2026-11-01, every session since its measurement - fitting-room/app.js lightenHeavyReference, CLAUDE.md §7.20).
   The matrix's zip jacket has no rear photo; the generated one is a 1,594 KB PNG, and sent as it was the prime held the uplink
   4s and the render froze for the whole window. An opaque PNG over REF_HEAVY_BYTES goes as a JPEG of the same pixels.
   §1 the decision, run on the room's own block with a stub canvas; §2 where it sits in garmentBlobCached().
   Measured on the real image in Chromium (the block sliced the same way): 1,594 KB -> 116 KB, 832x1248 kept, mean pixel
   difference 1/255, 22 ms; on the real engine (y2): 92 KB on the wire, no stall, the jacket on the front. It shipped TEST-only
   and went to every session after y2 (the owner's call). */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function between(src, a, b) {
  const i = src.indexOf(a); if (i === -1) throw new Error(`no "${a}"`);
  const j = src.indexOf(b, i); if (j === -1) throw new Error(`no "${b}"`);
  return src.slice(i, j);
}
const BLOCK = between(APP, "const REF_HEAVY_BYTES", "/* Cheap \"is this basically a solid color?\"");

/* A stub canvas: `alpha` is every pixel's alpha, `jpegBytes` the size the encoder returns (or a throw). */
function load({ test = true, alpha = 255, jpegBytes = 120 * 1024, decodeThrows = false } = {}) {
  const events = [];
  const env = {
    traceEnabled: () => test,
    traceOrient: (k, o) => events.push([k, o]),
    createImageBitmap: async () => { if (decodeThrows) throw new Error("decode"); return { width: 832, height: 1248, close() {} }; },
    OffscreenCanvas: class {
      constructor(w, h) { this.w = w; this.h = h; }
      getContext() { const n = this.w * this.h * 4; return { drawImage() {}, getImageData: () => ({ data: { length: n, 3: alpha, [n - 1]: alpha, ...proxyAlpha(n, alpha) } }) }; }
      async convertToBlob({ type }) { if (jpegBytes instanceof Error) throw jpegBytes; return new Blob([new Uint8Array(jpegBytes)], { type }); }
    },
  };
  const fn = new Function(...Object.keys(env), BLOCK + "\nreturn { lightenHeavyReference, REF_HEAVY_BYTES };")(...Object.values(env));
  return { ...fn, events };
}
/* Every alpha byte the loop reads, without allocating the whole image. */
function proxyAlpha(n, alpha) { const o = {}; for (let i = 3; i < n; i += 4 * 7) o[i] = alpha; return o; }
const png = (kb) => new Blob([new Uint8Array(kb * 1024)], { type: "image/png" });

console.log("\n── §1 the decision ──");
{
  const r = load();
  const big = png(1594);
  const out = await r.lightenHeavyReference(big);
  check("§1.1 an opaque 1,594 KB PNG goes as a JPEG (the jacket's generated rear)", out !== big && out.type === "image/jpeg" && out.size === 120 * 1024, `${out.type} ${out.size}`);
  check("§1.2 ...and a TEST record says so: from, to, the same pixel size", r.events.length === 1 && r.events[0][0] === "ref-light" &&
    r.events[0][1].did === "jpeg" && r.events[0][1].from === 1594 && r.events[0][1].to === 120 && r.events[0][1].w === 832 && r.events[0][1].h === 1248,
    JSON.stringify(r.events));
}
{
  const r = load();
  const small = png(390), jpg = new Blob([new Uint8Array(900 * 1024)], { type: "image/jpeg" });
  check("§1.3 a PNG under REF_HEAVY_BYTES (400 KB) is untouched", (await r.lightenHeavyReference(small)) === small && r.REF_HEAVY_BYTES === 400 * 1024);
  check("§1.4 a heavy JPEG is untouched (a store photo: no evidence it needs it yet)", (await r.lightenHeavyReference(jpg)) === jpg);
  check("§1.5 nothing is null-unsafe", (await r.lightenHeavyReference(null)) === null);
  check("§1.6 none of those wrote a record", r.events.length === 0, JSON.stringify(r.events));
}
{
  const r = load({ test: false });
  const big = png(1594);
  const out = await r.lightenHeavyReference(big);
  check("§1.7 a shopper's session lightens it too - measured in y2, then every session (the owner's call)",
    out !== big && out.type === "image/jpeg" && out.size === 120 * 1024, `${out.type} ${out.size}`);
}
{
  const r = load({ alpha: 0 });
  const big = png(1594);
  check("§1.8 a PNG with a transparent pixel is a cut-out and keeps its PNG (a JPEG paints its background black)",
    (await r.lightenHeavyReference(big)) === big && r.events[0] && r.events[0][1].did === "cutout", JSON.stringify(r.events));
}
{
  const r = load({ jpegBytes: 1400 * 1024 });
  const big = png(1594);
  check("§1.9 a JPEG that saves under a fifth keeps the original", (await r.lightenHeavyReference(big)) === big && r.events[0] && r.events[0][1].did === "kept");
}
{
  const r1 = load({ decodeThrows: true }), r2 = load({ jpegBytes: new Error("encode") });
  const a = png(1594), b = png(1594);
  check("§1.10 never fails - a decode or encode error sends the original", (await r1.lightenHeavyReference(a)) === a && (await r2.lightenHeavyReference(b)) === b &&
    r1.events[0][1].did === "error" && r2.events[0][1].did === "error");
}

console.log("\n── §2 where it sits ──");
{
  const cached = between(APP, "function garmentBlobCached(url) {", "/* THE ENGINE-SPEED EXPERIMENT's \"small\" mode");
  const mask = cached.indexOf("normalized = await maskReferenceBand("), light = cached.indexOf("normalized = await lightenHeavyReference(normalized)");
  check("§2.1 garmentBlobCached() lightens AFTER the rear-photo mask (the mask keeps a PNG a PNG) - every send of that Blob is the light one",
    mask !== -1 && light > mask, `${mask} ${light}`);
  check("§2.2 ...typeof-guarded (suites run garmentBlobCached standalone, CLAUDE.md §2.7)",
    /if \(normalized && typeof lightenHeavyReference === "function"\) normalized = await lightenHeavyReference\(normalized\);/.test(cached));
  check("§2.3 no session gate: the decision reads the bytes alone (traceEnabled is not in the block)", !/traceEnabled/.test(BLOCK));
}

console.log(fails === 0 ? "\nheavy-reference: OK" : `\nheavy-reference: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
