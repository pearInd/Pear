#!/usr/bin/env node
/* REFERENCE DETERMINISM - "the same product gives me a different shirt every time"
   =============================================================================
   THE REPORT: re-running the SAME catalog product across attempts returns a pink open
   button-down, then a plain white tee, then a black shirt, then a white striped tee. Not a
   drifted colour - four different garments from one unchanged input.

   FOUR DIFFERENT GARMENTS FROM ONE INPUT MEANS THE REFERENCE IS NOT ON THE WIRE. With a
   real image conditioning it, Decart is stable; with nothing, it samples its own prior, and
   a stochastic sampler with no anchor produces a different plausible shirt every run. That
   is what "randomised across attempts" is - not a caching bug, an absent reference.

   THE GAP IS ONE `if`. goLive() calls its "Mandatory Pre-load & Validation Gate" - the
   block that blocks before any token mint, WebRTC connect or billing until every garment
   asset is fetched, decoded and content-validated - inside `if (currentAngle ===
   AUTO_ANGLE)`. AI Auto runs are therefore guaranteed resident bytes. FRONT-ONLY runs skip
   the gate entirely, and app.js's own comment calls front-only "most of the catalog".

   WHAT A SKIPPED GATE COSTS, following referenceImageFor() down the front-only path: it is
   not AUTO_ANGLE, so it reaches garmentBlobIfWarm() - WARM ONLY, deliberately never
   fetching - and on a miss falls through to garmentImageRef(), a proxied URL string. A URL
   means DECART fetches the image before it can condition on anything, and app.js puts that
   at up to 20-25s against a ~5s billed window. The reference can simply never arrive, and
   the entire session renders from the model's prior.

   WHICH IS WHY IT SURFACES ON RETAKES. setActiveItem()'s prewarm is fire-and-forget, so the
   first run of a session often has time to warm the cache and looks fine. A retake, a
   history restore, or any run after _assetBlobCache (LRU, 10 entries) has evicted the entry
   hits the cold path - and the cold path has no floor under it.

   THE FIX IS TO STOP GATING THE GATE. preloadGarmentAssets() already handles a front-only
   item correctly - it validates the front and returns hasBack:false - so the block only has
   to run unconditionally. The DOWNGRADE it can trigger stays scoped to AI Auto, because
   "back view unavailable" is meaningless for a run that was never going to use one.
   ============================================================================= */

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const FRONT = "https://cdn.test/cove-front.jpg";
const BACK  = "https://cdn.test/cove-back.jpg";

/* The REAL preloadGarmentAssets(), executed. Sliced on its own declaration and the
   top-level `}` that closes it, so the suite drives the shipped function rather than a
   paraphrase of it. `activeItem` is injected per case, which is how the front-only and
   dual-view shapes are exercised without a DOM. */
const PRELOAD_SRC = (() => {
  const start = SRC.indexOf("async function preloadGarmentAssets() {");
  const end = SRC.indexOf("\n  return { ok, hasBack };\n}\n", start);
  if (start === -1 || end === -1) throw new Error("could not extract preloadGarmentAssets()");
  return SRC.slice(start, end + "\n  return { ok, hasBack };\n}\n".length);
})();

function harness(item, { blobs = { [FRONT]: { size: 9 }, [BACK]: { size: 9 } }, look = null, flat = false } = {}) {
  const fetched = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    resolveLook: () => look,
    galleryOf: (it) => {
      const g = {};
      if (it && it.img) g.front = it.img;
      if (it && it.imgBack) g.back = it.imgBack;
      return g;
    },
    distinctBackOf: (it, g) => (g && g.back) || undefined,
    $: () => null,
    garmentBlobCached: async (u) => { fetched.push(u); return blobs[u] || null; },
    createImageBitmap: async () => ({ close() {} }),
    bitmapLooksFlat: async () => flat,
    _assetBlobCache: new Map(),
    compositeActiveFor: () => false,
    createGarmentComposite: async () => null,
    activeItem: item,
  };
  const fn = new Function(...Object.keys(sandbox),
    PRELOAD_SRC + "\nreturn preloadGarmentAssets;")(...Object.values(sandbox));
  return { fn, fetched };
}

console.log("── §1 THE GATE VALIDATES A FRONT-ONLY ITEM, which is most of the catalog ──");
{
  const mk = (item, opts) => harness(item, opts);

  const single = mk({ name: "COVE", img: FRONT });
  const r1 = await single.fn();
  check("a front-only item is fetched and validated, not skipped",
    single.fetched.includes(FRONT),
    "no fetch here means go-live proceeds with nothing resident - the reported failure");
  check("...and reports ok with no back, rather than failing the run",
    r1.ok === true && r1.hasBack === false, JSON.stringify(r1));

  const broken = mk({ name: "COVE", img: FRONT }, { blobs: {} });
  const r2 = await broken.fn();
  check("an unfetchable front is reported as NOT ok, so go-live can refuse",
    r2.ok === false,
    "running blind is what renders a different garment every attempt");

  const dual = mk({ name: "COVE", img: FRONT, imgBack: BACK });
  const r3 = await dual.fn();
  check("a dual-view item still validates both halves, unchanged",
    r3.ok === true && r3.hasBack === true &&
    dual.fetched.includes(FRONT) && dual.fetched.includes(BACK));
}

console.log("\n── §2 THE GATE IS NO LONGER GATED ──");
{
  const goLive = SRC.slice(SRC.indexOf("Mandatory Pre-load & Validation Gate"),
                           SRC.indexOf("await connectRealtime()"));
  check("preloadGarmentAssets() is awaited on EVERY run, not only AI Auto ones",
    !/if \(currentAngle === AUTO_ANGLE\) \{\s*\n\s*\$\("scanOverlay"\)\.hidden = false;\s*\n\s*const preload = await preloadGarmentAssets\(\);/.test(goLive) &&
    /const preload = await preloadGarmentAssets\(\);/.test(goLive),
    "front-only is most of the catalog, and it was the half with no floor under it");
  check("...and it still blocks BEFORE the realtime connect, so nothing is billed blind",
    SRC.indexOf("const preload = await preloadGarmentAssets();") < SRC.indexOf("await connectRealtime()"),
    "a gate after the connect is a gate that spends the session it was meant to protect");
  check("an unfetchable front still aborts the run rather than going live blind",
    /if \(!preload\.ok\)/.test(goLive) && /return;/.test(goLive));
  /* The DOWNGRADE stays scoped: "back view unavailable" is meaningless on a run that was
     never going to use a back, and toasting it at every single-view shopper would be a new
     defect introduced by the fix. */
  check("the hasBack downgrade is still scoped to AI Auto runs only",
    /currentAngle === AUTO_ANGLE && !preload\.hasBack/.test(goLive) ||
    /if \(currentAngle === AUTO_ANGLE\) \{[\s\S]{0,400}?!preload\.hasBack/.test(goLive),
    "a front-only run must not be told its back view is unavailable");
}

console.log("\n── §3 THE POINT OF ALL OF IT: bytes, not a URL, reach the wire ──");
{
  /* referenceImageFor()'s front-only path is WARM-ONLY by design - it never fetches, so it
     is only as good as whatever filled the cache before it. The gate above is what fills
     it. Asserted as the pairing, because either half alone is the bug. */
  const ref = SRC.slice(SRC.indexOf("async function referenceImageFor"),
                        SRC.indexOf("async function referenceImageFor") + 4600);
  check("the front-only path still prefers warm BYTES over a URL",
    /garmentBlobIfWarm\(activeImg\)/.test(ref) && /return warm;/.test(ref));
  check("...and the URL fallback is still there as the last resort, not the first choice",
    ref.indexOf("garmentBlobIfWarm(activeImg)") < ref.lastIndexOf("garmentImageRef(activeImg)"),
    "a URL costs Decart a fetch it may not finish inside the billed window");
}

console.log(fails === 0 ? "\nreference-determinism: OK" : `\nreference-determinism: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
