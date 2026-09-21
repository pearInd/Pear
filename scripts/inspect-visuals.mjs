#!/usr/bin/env node
/* =============================================================================
   PEAR - visual inspector: score the frames the agent captured
   -----------------------------------------------------------------------------
   The spec produces evidence; this decides whether the evidence is acceptable. The
   two are separate files on purpose - an assertion written next to the code that
   took the screenshot tends to drift until it describes whatever that code happens
   to produce.

   IT READS PIXELS, not the app's own opinion of itself. Every check below is
   computed from the PNG bytes in test-results/visual/, inside the exact torso
   rectangle the mock painted the wire's reference into (geometry comes from
   meta.json, written by the page). meta.json's dispatch log is used only to say
   WHICH failure a bad frame is - never to excuse one.

   THE FOUR CHECKS, each named for the report it closes:

     1. PLAIN-SHIRT GAP        the torso patch carries detail
        A flat, featureless patch is a garment rendered with no print on it. Scored
        as spatial variance inside the patch, against a floor calibrated on the
        fixture's own plain.png (see --self-test).

     2. MISSING BACK PRINT     at 180 the patch is the BACK photo, not the front
        The front and back fixtures use disjoint hue families, so "which photo is
        on the wire" is answerable from a single frame. This is CLAUDE.md §2.1's
        bug - a front photo bound as the back reference - made visible.

     3. WHITE SHIRT FLASH      no frame is near-white or near-uniform
        The mock never paints a near-white frame (by construction), so any that
        appears came from the app's own overlay layer: a snapshot cover or a reveal
        scrim pinned over the live feed. CLAUDE.md §2.9.

     4. FROZEN FEED            consecutive burst frames differ
        The mock's beacon alternates colour on every rendered frame. Two
        consecutive captures sharing a beacon colour mean the output stopped
        presenting - the freeze that shipped three times as a "fix".

   USAGE
     node scripts/inspect-visuals.mjs                 score test-results/visual
     node scripts/inspect-visuals.mjs --dir <path>    score somewhere else
     node scripts/inspect-visuals.mjs --self-test     prove the checks can FAIL

   --self-test is not decoration. A checker that cannot fail is worse than no
   checker, because it is trusted. It runs checks 1 and 2 against the fixture's
   plain.png and against the front photo standing in for the back, and exits
   non-zero unless BOTH are correctly rejected.
   ============================================================================= */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* ── PNG decode ──────────────────────────────────────────────────────────────
   Playwright writes 8-bit RGBA, non-interlaced; the repo's own fixtures are 8-bit
   RGB. Both are handled, nothing else is - an unexpected format is reported as a
   failure rather than guessed at. */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  }
  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);

  // Un-filter, per the PNG spec: each scanline carries a filter byte, and filters
  // 1-4 reference the pixel to the left and/or the scanline above.
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
  }
  return { w, h, channels, data: out };
}

/** RGB at (x,y). */
function px(img, x, y) {
  const i = y * img.w * img.channels + x * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/* ── measurements ─────────────────────────────────────────────────────────── */

/** Rect in fractional coordinates -> integer pixel bounds, clamped to the image. */
function rectOf(img, r) {
  return {
    x0: Math.max(0, Math.round(r.x * img.w)),
    y0: Math.max(0, Math.round(r.y * img.h)),
    x1: Math.min(img.w, Math.round((r.x + r.w) * img.w)),
    y1: Math.min(img.h, Math.round((r.y + r.h) * img.h)),
  };
}

/* Sample every region on a fixed GRID (this many cells across its shorter side) rather
   than every Nth pixel. A fixed pixel step measures a different thing at every
   resolution: the same print scores high in a 512px fixture and low in the ~235px torso
   patch a capture actually contains, purely because the blocks span more pixels. That is
   the difference between the inspector's own calibration and the frames it scores, and
   it is exactly the kind of mismatch that produces a threshold nobody can trust. */
const GRID = 48;

/**
 * Shrink a rect toward its own centre.
 *
 * WHY THE PLAIN CHECK USES THIS. The mock paints the reference into the torso rect with
 * a cover crop, so the rect's outer band contains the garment's CUT-OUT EDGE and the
 * studio backdrop either side of it. Those edges are high-contrast whatever the garment
 * is wearing, so scoring the full rect gives a completely plain shirt a respectable
 * detail score - measured at 4.3 against printed garments at 6.0, a separation too thin
 * to threshold safely. Scoring the middle of the garment instead measures the PRINT,
 * which is the thing the check is named after.
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {number} f fraction of the original size to keep
 */
function inset(r, f) {
  return { x: r.x + (r.w * (1 - f)) / 2, y: r.y + (r.h * (1 - f)) / 2, w: r.w * f, h: r.h * f };
}

/** Pixel step that samples `r` on a GRID x GRID lattice, at least 1. */
function gridStep(img, r) {
  const { x0, y0, x1, y1 } = rectOf(img, r);
  return Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / GRID));
}

/**
 * How much a region VARIES IN COLOUR: the mean channel-wise distance of each sampled
 * cell from the region's own mean colour, 0-255. A plain fill scores ~0; anything
 * carrying a print scores high.
 *
 * THIS REPLACED A NEIGHBOUR-DIFFERENCE MEASURE, and the reason matters if anyone is
 * tempted to put one back. Comparing each cell to its right/below neighbour measures
 * how FINELY a pattern alternates, not whether there is one: widen a print's bands and
 * its score collapses, because most neighbouring cells then land inside the same band.
 * That is a property of the fixture's pitch, not of the garment, and it produced the
 * absurd result of a bold three-colour back print scoring 2.55 - below a plain shirt's
 * own 4.3 - while a finer front print scored 9. Distance-from-the-mean asks the question
 * the check is actually named after: is more than one colour present here?
 */
function detail(img, r, step = gridStep(img, r)) {
  const { x0, y0, x1, y1 } = rectOf(img, r);
  const cells = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) cells.push(px(img, x, y));
  }
  if (!cells.length) return 0;
  const mean = [0, 1, 2].map((c) => cells.reduce((a, p) => a + p[c], 0) / cells.length);
  let sum = 0;
  for (const p of cells) {
    sum += (Math.abs(p[0] - mean[0]) + Math.abs(p[1] - mean[1]) + Math.abs(p[2] - mean[2])) / 3;
  }
  return sum / cells.length;
}

/** Mean luminance of a region, 0-255. */
function luma(img, r, step = gridStep(img, r)) {
  const { x0, y0, x1, y1 } = rectOf(img, r);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const [R, G, B] = px(img, x, y);
      sum += 0.299 * R + 0.587 * G + 0.114 * B;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * A region's colour signature: the share of sampled pixels falling in each of six
 * hue sectors, plus the grey share. Robust to the scale/compression a frame goes
 * through between the mock's canvas and a PNG on disk, which an exact-colour match
 * would not be - and enough to separate the fixtures' warm front print from their
 * cool back print.
 */
function hueProfile(img, r, step = gridStep(img, r)) {
  const { x0, y0, x1, y1 } = rectOf(img, r);
  const bins = new Array(6).fill(0);
  let grey = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const [R, G, B] = px(img, x, y);
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      n++;
      if (max - min < 40) { grey++; continue; }          // unsaturated: no hue opinion
      let hDeg;
      if (max === R) hDeg = 60 * (((G - B) / (max - min)) % 6);
      else if (max === G) hDeg = 60 * ((B - R) / (max - min) + 2);
      else hDeg = 60 * ((R - G) / (max - min) + 4);
      if (hDeg < 0) hDeg += 360;
      bins[Math.floor(hDeg / 60) % 6]++;
    }
  }
  return { bins: bins.map((b) => b / (n || 1)), grey: grey / (n || 1), n };
}

/** Distance between two hue profiles, 0 (identical) .. 1 (disjoint). */
function hueDistance(a, b) {
  let d = 0;
  for (let i = 0; i < 6; i++) d += Math.abs(a.bins[i] - b.bins[i]);
  return d / 2;
}

/** Average absolute pixel difference between two same-sized regions, 0-255. */
function regionDiff(imgA, imgB, r, step = gridStep(imgA, r)) {
  if (imgA.w !== imgB.w || imgA.h !== imgB.h) return 255;
  const { x0, y0, x1, y1 } = rectOf(imgA, r);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const a = px(imgA, x, y), b = px(imgB, x, y);
      sum += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/* ── thresholds ──────────────────────────────────────────────────────────────
   Calibrated against the generated fixtures, and every one of them is exercised
   from both sides by --self-test. They are deliberately generous: this gate is
   hunting garments that are ABSENT or WRONG, not grading render quality, and a
   tight threshold on a lossy video path produces exactly the flaky failure that
   gets a mandatory check disabled. */
const T = {
  DETAIL_FLOOR: 6.0,     // below this the torso patch is a flat fill - the plain-shirt gap
  WHITE_LUMA: 232,       // a frame this bright overall is an overlay, not a render
  UNIFORM_DETAIL: 1.5,   // ...and this flat with it means nothing is being shown at all
  HUE_SHIFT_MIN: 0.22,   // front vs back profiles must differ by at least this
  FROZEN_DIFF: 1.0,      // consecutive burst frames flatter than this = a frozen feed
  /* Fraction of the torso patch that must match the mock's prior palette before a frame is
     called "the prior". The prior is five FIXED saturated bands filling the whole patch, so
     a true hit scores near 1.0; a real garment fixture has no reason to be built from those
     five exact colours. Set well clear of both - see the revealed-on-prior check.
     MEASURED on this harness's own frames: prior-on-torso 0.93-0.99, front.png 0.00,
     back.png 0.00. Only ever read when ?mock_prior_ms is on. */
  PRIOR_MATCH_MIN: 0.55,
  PRIOR_RGB_TOL: 40,     // per-channel slack, for PNG/scaling softness at band edges
};

/* THE MOCK'S PRIOR, BY ITS PIXELS. These are the five colours mockDecart paints into the
   torso during a simulated render wait (fitting-room/app.js - keep in lockstep if they are
   ever changed). Chosen there to be saturated and never near-white so they cannot be
   confused with an overlay; that also makes them trivially identifiable here.
   WHY PIXELS AND NOT TIMESTAMPS. The first cut of this check compared the capture's clock
   time against the mock's per-frame prior paints. It separated the two controls once and
   then stopped: on the next run the nearest paint sat 192ms from the reveal against a
   150ms bar - a near-miss, because the mock paints only on frames it renders and a
   screenshot can land in the gap between two of them. That is a timing proxy for a
   question about what is ON SCREEN, and §8.2 already says why this gate looks at pixels. */
const PRIOR_PALETTE = [[0x39, 0xff, 0x14], [0xff, 0x6b, 0x00], [0x7b, 0x2c, 0xff],
                       [0xff, 0xd4, 0x00], [0x00, 0xb3, 0xff]];

/** Fraction of sampled cells in `r` that match one of the prior's five band colours, 0-1. */
function priorMatch(img, r, step = gridStep(img, r)) {
  const { x0, y0, x1, y1 } = rectOf(img, r);
  let hit = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const [R, G, B] = px(img, x, y);
      n++;
      if (PRIOR_PALETTE.some(([r0, g0, b0]) =>
        Math.abs(R - r0) <= T.PRIOR_RGB_TOL &&
        Math.abs(G - g0) <= T.PRIOR_RGB_TOL &&
        Math.abs(B - b0) <= T.PRIOR_RGB_TOL)) hit++;
    }
  }
  return n ? hit / n : 0;
}

/* ── the run ─────────────────────────────────────────────────────────────── */

const findings = [];
function fail(check, shot, detailText) { findings.push({ ok: false, check, shot, detail: detailText }); }
function pass(check, shot, detailText) { findings.push({ ok: true, check, shot, detail: detailText }); }

function loadShot(dir, file) {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  return decodePng(readFileSync(p));
}

function inspect(dir) {
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    console.error(`✖ no meta.json in ${dir}\n  Run the agent first:  npx playwright test test/e2e/visual-agent.spec.mjs`);
    process.exit(2);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const patch = meta.geometry.patch;
  /* The garment's middle, clear of its cut-out edge - see inset(). Used for both the
     plain check and the front/back hue comparison, so the two always score the same
     pixels and cannot disagree about what "the garment" is. */
  const print = inset(patch, 0.62);
  const whole = { x: 0, y: 0, w: 1, h: 1 };

  console.log(`🍐 inspecting ${meta.shots.length} captures in ${basename(dir)}/`);
  console.log(`   torso patch: x${patch.x} y${patch.y} w${patch.w} h${patch.h}` +
              `  (print region inset to ${(print.w).toFixed(3)}x${(print.h).toFixed(3)})` +
              `   |   mock frames rendered: ${meta.frames}   |   dispatches: ${meta.dispatches.length}`);

  const named = {};
  for (const s of meta.shots) {
    const img = loadShot(dir, s.file);
    if (!img) { fail("capture", s.name, "screenshot missing on disk"); continue; }
    named[s.name] = { img, shot: s };
  }

  /* ── 1. plain-shirt gap, and 3. white flash: every capture ─────────────── */
  for (const [name, { img }] of Object.entries(named)) {
    const d = detail(img, print);
    if (d < T.DETAIL_FLOOR) {
      fail("plain-shirt-gap", name,
        `torso detail ${d.toFixed(2)} < ${T.DETAIL_FLOOR} - the reference on the wire ` +
        `rendered as a flat fill (no print reached the garment)`);
    } else {
      pass("plain-shirt-gap", name, `torso detail ${d.toFixed(2)}`);
    }

    const L = luma(img, whole), dw = detail(img, whole);
    if (L > T.WHITE_LUMA && dw < T.UNIFORM_DETAIL) {
      fail("white-flash", name,
        `frame luma ${L.toFixed(0)} with detail ${dw.toFixed(2)} - a near-uniform bright ` +
        `frame is an overlay pinned over the live feed, never a mock render (CLAUDE.md §2.9)`);
    } else {
      pass("white-flash", name, `luma ${L.toFixed(0)}, detail ${dw.toFixed(2)}`);
    }
  }

  /* ── 2. missing back print ─────────────────────────────────────────────── */
  const front = named["00-front"], back = named["02-back"], ret = named["03-return-front"];
  if (!front || !back) {
    fail("missing-back-print", "02-back", "front and/or back capture missing - cannot compare");
  } else {
    const hf = hueProfile(front.img, print), hb = hueProfile(back.img, print);
    const dist = hueDistance(hf, hb);
    if (dist < T.HUE_SHIFT_MIN) {
      fail("missing-back-print", "02-back",
        `front/back hue distance ${dist.toFixed(3)} < ${T.HUE_SHIFT_MIN} - the 180-degree ` +
        `frame carries the SAME photo as the 0-degree frame. This is the print-less back ` +
        `bug: a front image bound as the back reference (CLAUDE.md §2.1/§2.2). ` +
        `Wire said front=${meta.keys.front} back=${meta.keys.back}.`);
    } else {
      pass("missing-back-print", "02-back", `front/back hue distance ${dist.toFixed(3)}`);
    }

    // ...and the front has to come home. A 360 that leaves the back asset rendered on
    // the shopper's chest is its own report ("after the 360 the front never comes back").
    if (ret) {
      const hr = hueProfile(ret.img, print);
      const backToReturn = hueDistance(hb, hr), frontToReturn = hueDistance(hf, hr);
      if (frontToReturn > backToReturn) {
        fail("front-not-restored", "03-return-front",
          `after a full 360 the patch still resembles the BACK photo ` +
          `(distance to back ${backToReturn.toFixed(3)} < to front ${frontToReturn.toFixed(3)})`);
      } else {
        pass("front-not-restored", "03-return-front",
          `restored to front (distance to front ${frontToReturn.toFixed(3)})`);
      }
    }
  }

  /* ── 4. frozen feed, across the burst ──────────────────────────────────── */
  const burst = meta.shots.filter((s) => s.name.startsWith("burst-"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 1; i < burst.length; i++) {
    const a = named[burst[i - 1].name], b = named[burst[i].name];
    if (!a || !b) continue;
    const d = regionDiff(a.img, b.img, whole);
    if (d < T.FROZEN_DIFF) {
      fail("frozen-feed", burst[i].name,
        `identical to ${burst[i - 1].name} (mean diff ${d.toFixed(3)}) - the feed stopped ` +
        `presenting frames through the turn. Never hold a still over a live session ` +
        `(CLAUDE.md §2.9).`);
    } else {
      pass("frozen-feed", burst[i].name, `mean diff vs previous ${d.toFixed(2)}`);
    }
  }

  /* ── 5. the reveal landed on Decart's own prior ────────────────────────────
     THE REPORT THIS CLOSES (448abc6, "wrong garment at 00:00" - the fifth recording):
     between set_image_ack and Decart's render switching to the new reference, the model
     keeps drawing from its own prior, 780-1100ms measured. Reveal inside that window and
     the shopper's first dressed frame is a garment nobody picked. It is not a local warp,
     gesture or overlay - nothing in the room draws on the body.

     WHY THE OTHER FOUR CHECKS CANNOT SEE IT, which is the reason this one exists: the
     prior is a MULTICOLOR pattern, so it is well clear of DETAIL_FLOOR (not a flat fill)
     and nowhere near WHITE_LUMA (not an overlay), and it is neither wire key, so the
     front/back hue test never looks at it. A run with the prior enabled scored a clean 40
     while the question it was enabled to answer went unasked.

     INERT ON A NORMAL RUN, and that is deliberate: ?mock_prior_ms is off by default, so
     priorPaintedAt is empty and this neither passes nor fails. It reports only when the
     harness was actually asked to paint a prior. */
  const priorAt = Array.isArray(meta.priorPaintedAt) ? meta.priorPaintedAt : [];
  const revealShot = meta.shots.find((sh) => sh.name === "00-front");
  const revealImg = revealShot ? named[revealShot.name] : null;
  if (priorAt.length && revealImg) {
    /* THE REVEAL ONLY, and the scoping is the whole correctness of this check. The mock
       repaints the prior after EVERY image ack, so each of a turn's swap dispatches opens
       its own window - and scoring those as failures was measured here first: with the
       shipped settle ON, 00-front was clean while 7 mid-turn captures sat inside windows
       opened by swap acks. That is Decart's ~1s render switch, which is known physics and
       the reason the early-turn trigger exists (app.js ORIENT_EARLY_TURN_DEFAULT_DEG) -
       not a regression anyone committed. A mandatory gate that fails for it is a gate that
       gets commented out (§8.1), so only the shopper's FIRST dressed frame is scored.

       CALIBRATION, measured here - and read the limit before trusting a green run.
         · SEPARATION IS DECISIVE. A reveal that lands on the prior scores 95%; a clean one
           scores 0%. The bar at 55% is not near either. Verified to fire:
             PEAR_VISUAL_PRIOR_MS=5000 PEAR_VISUAL_SETTLE_HOLD=0 npm run test:visual
         · THE ROOM'S GATE ENDS AT REFERENCE_RENDER_SETTLE_MS (1200). At a 5000ms prior the
           reveal lands on it WITH the settle on too - by construction, not by fault: the
           reveal waits 1200ms past the last ack and then goes. 780-1100ms is the measured
           real band (448abc6), so the shipped number covers it with ~100ms to spare and
           nothing beyond it. If a live capture ever shows a render switch past 1200ms,
           that constant is the thing to move, and this check is how you would know.
         · WHAT THIS DOES NOT PROVE. At a realistic 1100ms prior the reveal is clean with
           ?settle_hold=0 AS WELL, twice over - the spec's own reveal wait (.show-live plus
           the scan overlay coming down) and the cold-start hold already carry the capture
           past it. So this is a regression guard on the OUTCOME - the shopper's first
           dressed frame is never Decart's prior - and NOT an A/B that isolates which of
           those three mechanisms delivers it. Do not cite a green run as proof that
           REFERENCE_RENDER_SETTLE_MS specifically is load-bearing. */
    const m = priorMatch(revealImg.img, patch);
    if (m >= T.PRIOR_MATCH_MIN) {
      fail("revealed-on-prior", revealShot.name,
        `the first dressed frame IS Decart's prior - ${(m * 100).toFixed(0)}% of the torso ` +
        `patch is the prior's band palette (bar ${(T.PRIOR_MATCH_MIN * 100).toFixed(0)}%, ` +
        `${meta.priorFrames} prior frame(s) this run). The reveal did not wait out the render ` +
        `switch, so the shopper opens on a garment nobody picked ` +
        `(448abc6 / REFERENCE_RENDER_SETTLE_MS).`);
    } else {
      pass("revealed-on-prior", revealShot.name,
        `${meta.priorFrames} prior frame(s) painted this run; the reveal's torso is ` +
        `${(m * 100).toFixed(0)}% prior palette (bar ${(T.PRIOR_MATCH_MIN * 100).toFixed(0)}%) ` +
        `- it waited the render switch out`);
    }
  }

  /* ── the harness's own guarantees, restated from meta.json ─────────────── */
  if (meta.tokenMintAttempts > 0) {
    fail("cost", "session", `${meta.tokenMintAttempts} call(s) to /api/realtime-token - this run was not free`);
  } else {
    pass("cost", "session", "no token minted, no Decart session opened");
  }
  /* An uncaught exception or a [PEAR] CRITICAL line means the room itself broke, and a
     screenshot that still looks plausible afterwards is the worst kind of pass. Ordinary
     console errors (the stub server's 404s, a CDN's 429) are carried in meta.json for
     whoever reads a failure and gate nothing - see the spec's own note on why. */
  for (const e of (meta.pageErrors || [])) fail("page-error", "session", `uncaught: ${e}`);
  for (const e of (meta.criticalLogs || [])) fail("critical-log", "session", e);
  if (meta.consoleNoise?.length) {
    console.log(`   (${meta.consoleNoise.length} non-gating console error(s) recorded in meta.json)`);
  }

  return meta;
}

/* ── self-test: prove the checks can fail ─────────────────────────────────── */

function selfTest() {
  const gdir = join(ROOT, "test", "fixtures", "garment");
  if (!existsSync(join(gdir, "plain.png"))) {
    console.error("✖ fixtures missing - run: node test/e2e/fixtures.mjs");
    process.exit(2);
  }
  /* The same middle-of-the-garment region the real run scores, so the calibration
     numbers below are comparable to the ones a capture produces. */
  const whole = inset({ x: 0.20, y: 0.24, w: 0.60, h: 0.70 }, 0.62);
  const front = decodePng(readFileSync(join(gdir, "front.png")));
  const back = decodePng(readFileSync(join(gdir, "back.png")));
  const plain = decodePng(readFileSync(join(gdir, "plain.png")));

  const dPlain = detail(plain, whole), dFront = detail(front, whole);
  const dist = hueDistance(hueProfile(front, whole), hueProfile(back, whole));
  const same = hueDistance(hueProfile(front, whole), hueProfile(front, whole));

  const rows = [
    ["plain.png is REJECTED as plain", dPlain < T.DETAIL_FLOOR, `detail ${dPlain.toFixed(2)} (floor ${T.DETAIL_FLOOR})`],
    ["front.png is ACCEPTED as printed", dFront >= T.DETAIL_FLOOR, `detail ${dFront.toFixed(2)}`],
    ["front vs back is a REAL difference", dist >= T.HUE_SHIFT_MIN, `hue distance ${dist.toFixed(3)} (min ${T.HUE_SHIFT_MIN})`],
    ["front vs front is REJECTED as same", same < T.HUE_SHIFT_MIN, `hue distance ${same.toFixed(3)}`],
  ];
  let bad = 0;
  console.log("🍐 inspector self-test - can these checks actually fail?\n");
  for (const [label, ok, note] of rows) {
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✖"} ${label.padEnd(38)} ${note}`);
  }
  console.log();
  if (bad) {
    console.error(`✖ ${bad} calibration check(s) failed - the thresholds in T do not separate ` +
                  `a printed garment from a plain one, so a real failure could pass unnoticed.`);
    process.exit(1);
  }
  console.log("✅ thresholds separate printed from plain, and front from back.");
}

/* ── entry ────────────────────────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) { selfTest(); return; }

  const dirArg = argv.indexOf("--dir");
  const dir = dirArg >= 0 ? resolve(argv[dirArg + 1]) : join(ROOT, "test-results", "visual");

  inspect(dir);

  const failed = findings.filter((f) => !f.ok);
  const byCheck = {};
  for (const f of findings) (byCheck[f.check] ||= { pass: 0, fail: 0 })[f.ok ? "pass" : "fail"]++;

  /* --verbose prints every measurement, passes included. Anyone tempted to move a
     threshold needs the distribution, not just the one value that crossed it. */
  if (argv.includes("--verbose")) {
    console.log("");
    for (const f of findings) {
      console.log(`  ${f.ok ? "·" : "✖"} ${f.check.padEnd(20)} ${f.shot.padEnd(18)} ${f.detail}`);
    }
  }

  console.log("");
  for (const [check, c] of Object.entries(byCheck)) {
    console.log(`  ${c.fail ? "✖" : "✓"} ${check.padEnd(20)} ${c.pass} passed, ${c.fail} failed`);
  }

  if (failed.length) {
    console.log("\n──────────────────────────────────────────────────────────────");
    for (const f of failed) console.log(`  ✖ [${f.check}] ${f.shot}\n      ${f.detail}`);
    console.log("──────────────────────────────────────────────────────────────");
    console.log(`\n✖ ${failed.length} visual check(s) failed. The frames are in ${dir}/ - ` +
                `look at them before changing a threshold.`);
    process.exit(1);
  }
  console.log(`\n✅ all ${findings.length} visual checks passed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
