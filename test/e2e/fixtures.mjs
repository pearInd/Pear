#!/usr/bin/env node
/* =============================================================================
   Visual-QA fixtures - generated, never committed
   -----------------------------------------------------------------------------
   Two kinds of input the visual harness needs, both built here from arithmetic so
   the repo carries no binaries and the checked-out tree is byte-identical for
   everyone:

     1. GARMENT REFERENCES  test/fixtures/garment/{front,back,plain}.png
        The photos the room treats as a product's front and back. They are
        DELIBERATELY unmistakable from each other - disjoint hue families, a
        different print geometry - because the single failure this whole harness
        exists to catch is a BACK dispatch carrying the FRONT photo (CLAUDE.md
        §2.1). Two tasteful, similar garment photos would make that bug invisible
        to a pixel check, which is the one thing we cannot allow the fixture to do.
        `plain.png` is the NEGATIVE CONTROL: a flat, featureless fill. Running the
        inspector against it must FAIL, or the inspector is not actually measuring
        anything - see `npm run inspect:visuals -- --self-test`.

     2. FAKE CAMERA        test/fixtures/user-turn-360.y4m
        What Chromium plays into getUserMedia via
        --use-file-for-fake-video-capture. Its job is narrower than it looks: the
        ORIENTATION is driven by the scripted pose sensor (?mock_decart=1), not by
        this clip, because no landmark model reads a reliable yaw off a synthetic
        figure. What the clip must do is be genuinely live and genuinely non-black
        - goLive()'s cameraLooksBlack() gate refuses a session otherwise, and a
        still feed would make the frozen-feed check (CLAUDE.md §2.9) vacuous. So it
        is a bright, moving scene whose figure turns in step with the same angle
        the sensor reports, purely so a human reviewing the screenshots later sees
        a coherent picture rather than a mismatch.

   Y4M is chosen over an encoded format for the same reason the PNGs are hand-
   rolled: it is uncompressed and fully specified, so writing it needs no ffmpeg,
   no codec and no dependency. It is also large, which is why the whole directory
   is gitignored and regenerated on demand.

   Run directly (`node test/e2e/fixtures.mjs`) or let the spec call ensureFixtures().
   ============================================================================= */
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "..", "fixtures");
export const GARMENT_DIR = join(FIXTURE_DIR, "garment");
export const VIDEO_PATH = join(FIXTURE_DIR, "user-turn-360.y4m");

/* ── PNG ────────────────────────────────────────────────────────────────────
   Minimal encoder: one IHDR, one IDAT of filter-0 scanlines, one IEND. Enough
   for opaque RGB, which is all a garment reference needs. */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} w
 * @param {number} h
 * @param {(x:number,y:number)=>[number,number,number]} shade RGB per pixel, 0-255
 * @returns {Buffer} a complete PNG file
 */
function encodePng(w, h, shade) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = shade(x, y);
      raw[o++] = r & 255; raw[o++] = g & 255; raw[o++] = b & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── the three garment references ───────────────────────────────────────────
   Each is a garment-shaped silhouette on a light studio backdrop, carrying a
   print built from a hue family the other one never uses. The inspector scores
   the torso patch's dominant hue, so "which photo is on the wire" is answerable
   from the pixels of a single screenshot. */

const BACKDROP = [238, 238, 242];

/** Is (x,y) inside the garment body? A crude tee silhouette - shoulders, sleeves, hem. */
function insideTee(x, y, w, h) {
  const nx = x / w, ny = y / h;
  if (ny < 0.08 || ny > 0.94) return false;
  if (ny < 0.24) return nx > 0.08 && nx < 0.92;                    // shoulders + sleeves
  return nx > 0.20 && nx < 0.80;                                    // body
}

/** Front print: concentric rings. Back print: bold diagonal bars. Different GEOMETRY as
 *  well as different hue, so a check that lost colour entirely could still tell them apart.
 *
 *  THE PRINT COVERS THE WHOLE GARMENT, and its blocks are deliberately CHUNKY rather
 *  than fine. Both facts are calibration, not taste. The reference is scaled down into a
 *  ~235x127 torso patch, VP8-encoded through the mock's captureStream and screenshotted -
 *  a path that erases high-frequency texture. A delicate print would arrive at the
 *  inspector as a flat fill and be reported as the plain-shirt gap on a session that was
 *  working perfectly. `npm run inspect:visuals -- --self-test` is what keeps this honest:
 *  it measures this shader's own output against the same floor a real capture is held to,
 *  and fails if the margin disappears. */
function teeShader(kind) {
  const cloth = kind === "back" ? [26, 34, 74] : [30, 30, 38];
  return (x, y, w, h) => {
    if (!insideTee(x, y, w, h)) return BACKDROP;
    if (kind === "plain") return cloth;
    const nx = x / w, ny = y / h;
    if (kind === "front" || kind === "front_variant") {
      const d = Math.hypot(nx - 0.5, (ny - 0.5) * 1.15);
      /* front_variant is a SECOND front-view crop, not a copy: a different ring pitch
         makes it a genuinely different file (so the room accepts it as a distinct photo
         and the swap really happens) while it stays unmistakably the FRONT print. That
         is the shape of the real bug - a storefront gallery of front crops, one of them
         labelled back - and it is what forces the pixel check to be the thing that
         catches it rather than a byte comparison. */
      const ring = Math.floor(d * (kind === "front" ? 18 : 15)) % 3;
      // warm family: amber / vermilion / cream - never used by the back print
      return ring === 0 ? [247, 178, 41] : ring === 1 ? [222, 74, 42] : [252, 240, 214];
    }
    /* Same pitch as the front's rings, for the same reason (see above): a finer bar
       spacing survives the downscale-and-encode far worse, and the back print was
       arriving at the inspector scoring barely above a plain shirt. */
    const bar = Math.floor(nx * 5 + ny * 4) % 3;
    // cool family: cyan / violet / mint
    return bar === 0 ? [46, 214, 224] : bar === 1 ? [138, 92, 246] : [172, 250, 208];
  };
}

/* ── Y4M ────────────────────────────────────────────────────────────────────
   YUV4MPEG2 header, then FRAME + I420 planes, repeated. Chromium loops the file
   for as long as the fake device is open, so a few seconds is plenty. */

const VID_W = 320, VID_H = 240, VID_FPS = 15, VID_SECONDS = 4;

function rgbToYuv(r, g, b) {
  return [
    Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16),
    Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128),
    Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128),
  ];
}

/** One frame of the scene at turn angle `deg`. Bright by construction - a dim frame
 *  would trip goLive()'s black-screen gate and the session would never open. */
function scenePixel(x, y, deg) {
  const nx = x / VID_W, ny = y / VID_H;
  // studio backdrop: a moving vertical gradient, so no two frames are identical
  const wash = 150 + 40 * Math.sin(ny * 3 + (deg * Math.PI) / 180);
  let r = wash, g = wash * 0.96, b = wash * 1.05;

  // the figure: torso narrows toward edge-on exactly as the pose sensor reports it
  const cos = Math.abs(Math.cos((deg * Math.PI) / 180));
  const halfW = 0.10 + 0.11 * cos;
  const inTorso = ny > 0.34 && ny < 0.86 && Math.abs(nx - 0.5) < halfW;
  const inHead = Math.hypot((nx - 0.5) * 1.6, ny - 0.22) < 0.11;
  if (inHead) { r = 226; g = 184; b = 152; }
  else if (inTorso) {
    // facing the camera the figure reads warm, turned away it reads cool - a human
    // scrubbing the screenshots can see the turn without reading any log
    const facing = Math.cos((deg * Math.PI) / 180) * 0.5 + 0.5;
    r = 60 + 120 * facing; g = 70 + 40 * facing; b = 150 - 60 * facing;
  }
  return [r | 0, g | 0, b | 0];
}

function buildY4m() {
  const frames = VID_FPS * VID_SECONDS;
  const header = Buffer.from(`YUV4MPEG2 W${VID_W} H${VID_H} F${VID_FPS}:1 Ip A1:1 C420mpeg2\n`, "latin1");
  const parts = [header];
  const ySize = VID_W * VID_H;
  const cSize = (VID_W / 2) * (VID_H / 2);

  for (let f = 0; f < frames; f++) {
    const deg = (f / frames) * 360;      // one full revolution per loop of the clip
    const Y = Buffer.alloc(ySize), U = Buffer.alloc(cSize), V = Buffer.alloc(cSize);
    // Y at full resolution; U/V subsampled by averaging each 2x2 block.
    for (let y = 0; y < VID_H; y++) {
      for (let x = 0; x < VID_W; x++) {
        const [r, g, b] = scenePixel(x, y, deg);
        Y[y * VID_W + x] = rgbToYuv(r, g, b)[0];
      }
    }
    for (let cy = 0; cy < VID_H / 2; cy++) {
      for (let cx = 0; cx < VID_W / 2; cx++) {
        let su = 0, sv = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const [r, g, b] = scenePixel(cx * 2 + dx, cy * 2 + dy, deg);
            const [, u, v] = rgbToYuv(r, g, b);
            su += u; sv += v;
          }
        }
        U[cy * (VID_W / 2) + cx] = Math.round(su / 4);
        V[cy * (VID_W / 2) + cx] = Math.round(sv / 4);
      }
    }
    parts.push(Buffer.from("FRAME\n", "latin1"), Y, U, V);
  }
  return Buffer.concat(parts);
}

/* ── entry point ────────────────────────────────────────────────────────────── */

/** Regenerate anything missing (or, with force, everything). Cheap and idempotent:
 *  the spec calls it on every run so a fresh clone needs no extra setup step. */
export function ensureFixtures({ force = false, log = () => {} } = {}) {
  mkdirSync(GARMENT_DIR, { recursive: true });

  const pngs = [
    ["front.png", 512, 640, teeShader("front")],
    ["back.png", 512, 640, teeShader("back")],
    ["plain.png", 512, 640, teeShader("plain")],
    /* NEGATIVE CONTROL for the print-less back bug (CLAUDE.md §2.1). A storefront gallery
       of front-view crops, one of which the scrape labelled "back": the filename says
       back, the pixels are the front print. canonicalImageUrl() cannot save us here - the
       two URLs are genuinely different photos as far as any URL rule can tell - so this is
       the case that has to be caught by looking at the RENDER. Point the harness at it
       (PEAR_VISUAL_BACK=front-mislabelled-as-back.png) and missing-back-print must fire. */
    ["front-mislabelled-as-back.png", 512, 640, teeShader("front_variant")],
  ];
  for (const [name, w, h, shader] of pngs) {
    const p = join(GARMENT_DIR, name);
    if (!force && existsSync(p)) { log(`  = ${name} (exists)`); continue; }
    writeFileSync(p, encodePng(w, h, (x, y) => shader(x, y, w, h)));
    log(`  + ${name} (${(statSync(p).size / 1024).toFixed(0)}KB)`);
  }

  if (force || !existsSync(VIDEO_PATH)) {
    writeFileSync(VIDEO_PATH, buildY4m());
    log(`  + user-turn-360.y4m (${(statSync(VIDEO_PATH).size / 1024 / 1024).toFixed(1)}MB, ` +
        `${VID_W}x${VID_H} @ ${VID_FPS}fps x ${VID_SECONDS}s, looped by Chromium)`);
  } else {
    log("  = user-turn-360.y4m (exists)");
  }

  return { garmentDir: GARMENT_DIR, video: VIDEO_PATH };
}

/* pathToFileURL, not a template literal: this repo lives under a path with a space in
   it, and file://${argv[1]} does not percent-encode - the guard silently never fired. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("🍐 generating visual-QA fixtures");
  ensureFixtures({ force: process.argv.includes("--force"), log: (s) => console.log(s) });
  console.log("done.");
}
