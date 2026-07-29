/* preloadGarmentAssets()'s composite-validation branch - the second half of the
   "mixing / inconsistent between runs" investigation.

   THE GAP THIS CLOSES: this gate's whole job is "block go-live until every asset
   THIS RUN NEEDS is ready", but until now it validated the plain front/back Blobs
   from the OLDER per-orientation path and had ZERO awareness that COMPOSITE_MODE
   (the default) actually feeds Lucy a DIFFERENT reference - the stitched image.
   Front and back validating fine individually says nothing about whether the
   composite built from them exists yet. A shopper who reached go-live before the
   background prewarm finished used to sail past this gate and pay the composite's
   build cost AFTER already connecting/billing - a materially different, less safe
   place for a multi-second build to happen for the first time.

   Extracts the REAL preloadGarmentAssets(), not a reimplementation. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

const code = extract("async function preloadGarmentAssets", "/* ── Context-Aware Asset Switching - OrientationWatcher");
check("extracted the composite-validation block", /compositeActiveFor\(item\)/.test(code) && /createGarmentComposite/.test(code));

function run({
  back = "https://cdn.test/back.jpg",
  frontOk = true,
  backOk = true,
  compositeActive = true,
  handedComposite = null,      // item.composite - decodes via garmentBlobCached too
  handedDecodeOk = true,       // whether that decode succeeds
  builtComposite = "BUILT_BLOB",  // what createGarmentComposite(front, back) resolves to
}) {
  const calls = [];
  const sandbox = {
    activeItem: { name: "Tee", img: "https://cdn.test/front.jpg", composite: handedComposite },
    resolveLook: () => null,
    galleryOf: (item) => ({ front: item.img, back }),
    distinctBackOf: () => back,
    $: () => null,   // #scanSub not present - setText() must be a no-op, not a throw
    garmentBlobCached: (url) => {
      calls.push(`garmentBlobCached:${url}`);
      if (url === "https://cdn.test/front.jpg") return Promise.resolve(frontOk ? "FRONT_BLOB" : null);
      if (url === back) return Promise.resolve(backOk ? "BACK_BLOB" : null);
      if (url === handedComposite) return Promise.resolve(handedDecodeOk ? "HANDED_BLOB" : null);
      return Promise.resolve(null);
    },
    createImageBitmap: () => Promise.resolve({ close() {} }),
    bitmapLooksFlat: () => Promise.resolve(false),
    _assetBlobCache: { delete() {} },
    compositeActiveFor: () => compositeActive,
    createGarmentComposite: (...args) => { calls.push(`createGarmentComposite:${args.join(",")}`); return Promise.resolve(builtComposite); },
    console,
  };
  const fn = new Function(...Object.keys(sandbox), code + "\nreturn preloadGarmentAssets();");
  return { result: fn(...Object.values(sandbox)), calls };
}

console.log("── composite mode active, no prior handover: builds and validates it ──");
{
  const { result, calls } = await run({ compositeActive: true, handedComposite: null });
  const r = await result;
  check("go-live allowed (front ok, back ok, composite built)", r.ok === true && r.hasBack === true, JSON.stringify(r));
  check("createGarmentComposite was actually called (the gate now waits on it)",
    calls.some((c) => c.startsWith("createGarmentComposite")), JSON.stringify(calls));
}

console.log("\n── composite mode active, widget already handed one over: reused, not rebuilt ──");
{
  const { result, calls } = await run({ compositeActive: true, handedComposite: "data:image/jpeg;base64,HANDED" });
  const r = await result;
  check("go-live allowed", r.ok === true && r.hasBack === true);
  check("decoded the HANDED composite via garmentBlobCached",
    calls.some((c) => c.includes("data:image/jpeg;base64,HANDED")), JSON.stringify(calls));
  check("did NOT rebuild locally when the handed one decoded fine",
    !calls.some((c) => c.startsWith("createGarmentComposite")), JSON.stringify(calls));
}

console.log("\n── THE ACTUAL FIX: composite build fails -> degrades to front-only, does not silently pass ──");
{
  const { result } = await run({ compositeActive: true, builtComposite: null });
  const r = await result;
  check("front asset alone is fine -> ok stays true", r.ok === true);
  check("but hasBack flips false - goLive() downgrades to front-only rather than going live on nothing",
    r.hasBack === false);
}

console.log("\n── handed composite fails to decode -> falls through to a local rebuild, not an immediate failure ──");
{
  const { result, calls } = await run({
    compositeActive: true, handedComposite: "data:image/jpeg;base64,BROKEN", handedDecodeOk: false,
  });
  const r = await result;
  check("still succeeds via the fallback build", r.ok === true && r.hasBack === true);
  check("attempted the handed decode before falling back",
    calls.some((c) => c.includes("BROKEN")), JSON.stringify(calls));
  check("fell back to a local build after the handed decode", calls.some((c) => c.startsWith("createGarmentComposite")));
}

console.log("\n── composite mode NOT active (e.g. currentAngle downgraded already): skipped entirely, no wasted work ──");
{
  const { result, calls } = await run({ compositeActive: false });
  const r = await result;
  check("go-live allowed on the plain front/back path alone", r.ok === true && r.hasBack === true);
  check("createGarmentComposite never called when composite mode isn't active",
    !calls.some((c) => c.startsWith("createGarmentComposite")), JSON.stringify(calls));
}

console.log("\n── a broken BACK blob is never composited at all (no point compositing garbage) ──");
{
  const { result, calls } = await run({ compositeActive: true, backOk: false });
  const r = await result;
  check("degrades to front-only on the back-blob failure itself", r.hasBack === false);
  check("never even attempted a composite build against a back already known to be bad",
    !calls.some((c) => c.startsWith("createGarmentComposite")), JSON.stringify(calls));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
