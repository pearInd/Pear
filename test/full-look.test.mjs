/* THE FULL LOOK IN AI AUTO (fitting-room/app.js, 2026-10-10) - "make both work well at the same time": the shirt and the
   shorts together. A look of two garments with back photos sent the TOP's photo alone (the stitch was skipped for AI Auto),
   the halves were cover-fitted (the models' middles, not the garments), and a FOX shopper had no way to put two products
   together ("Complete the Look" typed the store catalog by words FOX's file names never carry).
   §1 one half per side (lookHalfFor) and both composites built ahead (prewarmLookComposites)
   §2 each half cropped to its garment's band (lookGarmentBand, drawBandContain) - geometry and the fetch
   §3 applyLook stitches in AI Auto, from a snapshot taken before any await
   §4 the garments you tried: remembered with a verified gallery, offered as the other region's complement
   §5 the wiring: the classifier's verdict and the reveal remember; "Complete the Look" lists them first */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ""}`); }
}
function between(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found: ${to}`);
  return src.slice(a, b);
}

const PEAK = { name: "חולצה עם הדפס", img: "https://fox.co.il/cdn/shop/files/1824346900-1.jpg", imgBack: "https://fox.co.il/cdn/shop/files/1824346900-3.jpg", garmentType: "upper_body" };
const SHORTS = { name: "מכנסי כדורסל", img: "https://fox.co.il/cdn/shop/files/3108650200-1.jpg", imgBack: "https://fox.co.il/cdn/shop/files/3108650200-4.jpg", garmentType: "lower_body" };
const PANTS_NO_BACK = { name: "פריט מהחנות", img: "https://fox.co.il/cdn/shop/files/9999-1.jpg", garmentType: "lower_body" };
const galleryOf = (it) => ({ front: it.img, ...(it.imgBack ? { back: it.imgBack } : {}) });
const distinctBackOf = (it, g = galleryOf(it)) => (g.back && g.back !== g.front ? g.back : undefined);

console.log("\n── §1 one half per side, both composites ahead ──");
{
  const src = between(APP, "function lookHalfFor(item, angle) {", "\n/* =============================================================================\n   Camera + engine bootstrap");
  const stitched = [];
  let look = { top: PEAK, bottom: SHORTS };
  const H = new Function("galleryOf", "distinctBackOf", "activeImageOf", "resolveLook", "stitchLookBlob",
    src + "\nreturn { lookHalfFor, prewarmLookComposites };")(galleryOf, distinctBackOf, (it) => "ACTIVE:" + it.img, () => look,
    (a, b) => { stitched.push([a, b]); return Promise.resolve(null); });
  check("§1.1 the back: each half's own distinct back", H.lookHalfFor(PEAK, "back") === PEAK.imgBack && H.lookHalfFor(SHORTS, "back") === SHORTS.imgBack);
  check("§1.2 the front: each half's front", H.lookHalfFor(PEAK, "front") === PEAK.img && H.lookHalfFor(SHORTS, "front") === SHORTS.img);
  check("§1.3 a half with no back of its own lends its front to the back (as a single garment without one)",
    H.lookHalfFor(PANTS_NO_BACK, "back") === PANTS_NO_BACK.img);
  check("§1.4 not AI Auto (no side): the active angle's image, exactly as before", H.lookHalfFor(PEAK, null) === "ACTIVE:" + PEAK.img);
  H.prewarmLookComposites();
  check("§1.5 a full look builds BOTH composites ahead: the fronts together, the backs together",
    JSON.stringify(stitched) === JSON.stringify([[PEAK.img, SHORTS.img], [PEAK.imgBack, SHORTS.imgBack]]), JSON.stringify(stitched));
  look = null; stitched.length = 0; H.prewarmLookComposites();
  check("§1.6 no look, nothing built", stitched.length === 0);
}

console.log("\n── §2 each half cropped to its garment ──");
{
  const src = between(APP, "const LOOK_BAND_TIMEOUT_MS = 3500;", "\n/**\n * Stitch a TOP + BOTTOM garment asset");
  const mk = (fetchImpl) => new Function("fetch", "location", "AbortSignal", "canonicalImageUrl",
    src + "\nreturn { lookGarmentBand, drawBandContain };")(fetchImpl, { origin: "https://room.test" }, undefined, (u) => u);
  /* geometry: the PEAK tee photo 600x899, its band collar-hem 0.21-0.62 over x 0.11-0.89, into the 936x836 box */
  const calls = [];
  const ctx = { drawImage: (...a) => calls.push(a) };
  const G = mk(() => Promise.reject(new Error("unused")));
  const r = G.drawBandContain(ctx, { width: 600, height: 899 }, { y0: 0.21, y1: 0.62, x0: 0.11, x1: 0.89 }, 44, 44, 936, 836);
  const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
  check("§2.1 the source is the band - collar to hem, never the model's head or the jeans",
    Math.abs(sx - 66) < 1e-6 && Math.abs(sy - 0.21 * 899) < 1e-6 && Math.abs(sw - 468) < 1e-6 && Math.abs(sh - 0.41 * 899) < 1e-6);
  check("§2.2 ...CONTAINED in the box (the whole garment, aspect kept, centred)",
    dw <= 936 + 1e-6 && dh <= 836 + 1e-6 && Math.abs(dw / dh - sw / sh) < 1e-6 && (Math.abs(dw - 936) < 1e-6 || Math.abs(dh - 836) < 1e-6) &&
    Math.abs(dx - (44 + (936 - dw) / 2)) < 1e-6 && Math.abs(dy - (44 + (836 - dh) / 2)) < 1e-6 && r.dw === dw, JSON.stringify({ dx, dy, dw, dh }));
  /* the fetch */
  const asked = [];
  const ok = mk(async (u) => { asked.push(u); return { ok: true, json: async () => ({ band: { y0: 0.1, y1: 0.45, x0: 0.15, x1: 0.85 }, reason: "ok" }) }; });
  const b1 = await ok.lookGarmentBand(SHORTS.img, "bottom"), b2 = await ok.lookGarmentBand(SHORTS.img, "bottom");
  check("§2.3 the server's band for the region asked, memoised per photo and region",
    b1 && b1.y0 === 0.1 && b1.x1 === 0.85 && b2 === b1 && asked.length === 1 && /region=bottom/.test(asked[0]) && /\/api\/garment-box\?image_url=/.test(asked[0]), asked.join(" "));
  const noX = mk(async () => ({ ok: true, json: async () => ({ band: { y0: 0.2, y1: 0.6 } }) }));
  const b3 = await noX.lookGarmentBand(PEAK.img, "top");
  check("§2.4 a band without x keeps the full width", b3 && b3.x0 === 0 && b3.x1 === 1);
  const abstain = mk(async () => ({ ok: true, json: async () => ({ band: null, reason: "no-person" }) }));
  check("§2.5 an abstention or a thin band: none (the cover fit as before)", (await abstain.lookGarmentBand(PEAK.img, "top")) === null &&
    (await mk(async () => ({ ok: true, json: async () => ({ band: { y0: 0.4, y1: 0.45 } }) })).lookGarmentBand(PEAK.img, "top")) === null);
  let n = 0;
  const flaky = mk(async () => { n++; throw new Error("network"); });
  const f1 = await flaky.lookGarmentBand(PEAK.img, "top"), f2 = await flaky.lookGarmentBand(PEAK.img, "top");
  check("§2.6 a failure is not an answer - asked again next time, never thrown", f1 === null && f2 === null && n === 2);
  check("§2.7 an upload (data:/blob:) is never sent to the server", (await ok.lookGarmentBand("data:image/png;base64,AA", "top")) === null && asked.length === 1);
  const stitch = between(APP, "function stitchLookBlob(topUrl, bottomUrl) {", "\n}\n");
  check("§2.8 the stitch cuts the TOP to its band and shows the BOTTOM whole (its band measured wrong on FOX), contained",
    /lookGarmentBand\(topUrl, "top"\)\]\);/.test(stitch) && !/lookGarmentBand\(bottomUrl/.test(stitch) &&
    /const bottomBand = \{ y0: 0, y1: 1, x0: 0, x1: 1 \};/.test(stitch) &&
    /if \(topBand\) drawBandContain\(ctx, top, topBand, pad, pad, innerW, innerH\);\s*\n\s*else drawImageCover\(ctx, top, pad, pad, innerW, innerH\);/.test(stitch) &&
    /if \(bottomBand\) drawBandContain\(ctx, bottom, bottomBand, pad, bottomY \+ pad, innerW, innerH\);\s*\n\s*else drawImageCover\(ctx, bottom, pad, bottomY \+ pad, innerW, innerH\);/.test(stitch));
}

console.log("\n── §3 applyLook stitches in AI Auto ──");
{
  const look = between(APP, "async function applyLook(top, bottom) {", "\n}\n");
  check("§3.1 the halves are this side's, frozen before any await (§2.8)",
    /const lookAngle = currentAngle === AUTO_ANGLE && typeof effectiveAngle === "function" \? effectiveAngle\(\) : null;\s*\n\s*const topImg = lookHalfFor\(top, lookAngle\), bottomImg = lookHalfFor\(bottom, lookAngle\);/.test(look) &&
    (() => { const c = look.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); return c.indexOf("lookHalfFor(top, lookAngle)") < c.indexOf("await "); })());
  check("§3.2 the stitch is no longer skipped for AI Auto - only a missing half skips it",
    /const canStitchLook = !!\(topImg && bottomImg\);/.test(look) && !/currentAngle !== AUTO_ANGLE/.test(look.replace(/\/\*[\s\S]*?\*\//g, "")));
  const add = between(APP, "function addToLook(piece) {", "\n}\n");
  check("§3.3 a completed look builds both composites at once", /if \(outfitComplete\(\)\) \{\s*\n\s*prewarmLookComposites\(\);/.test(add));
}

console.log("\n── §4 the garments you tried ──");
{
  const src = between(APP, "/* ── THE GARMENTS YOU TRIED", "/* ── end THE GARMENTS YOU TRIED ── */");
  const mk = (store, search = "?classify_pending=1") => {
    const ls = new Map();
    const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
    const window = { __pearStoreDomain: store };
    const T = new Function("localStorage", "window", "location", "sameImage", "isBottomsGarment",
      src + "\nreturn { rememberTriedGarment, triedComplementsFor, readTriedGarments, get validated() { return _galleryValidated; } };")(
      localStorage, window, { search }, (a, b) => a === b, (it) => it.garmentType === "lower_body");
    return { T, window, ls };
  };
  const { T, window } = mk("fox.co.il");
  check("§4.0 a room opened before the classifier's verdict starts unvalidated", T.validated === false && mk("fox.co.il", "").T.validated === true);
  T.rememberTriedGarment(PEAK, PEAK.img, PEAK.imgBack);
  const cards = T.triedComplementsFor(SHORTS);
  check("§4.1 the shirt you tried is offered on the shorts' page - with its BACK, marked as tried",
    cards.length === 1 && cards[0].img === PEAK.img && cards[0].imgBack === PEAK.imgBack && cards[0].type === "shirt" && cards[0].tried === true &&
    cards[0].name === PEAK.name, JSON.stringify(cards));
  check("§4.2 ...never the same region (no shirt offered next to a shirt)", T.triedComplementsFor(PEAK).length === 0);
  T.rememberTriedGarment(SHORTS, SHORTS.img, SHORTS.imgBack);
  check("§4.3 ...and the shorts on the shirt's page", T.triedComplementsFor(PEAK).length === 1 && T.triedComplementsFor(PEAK)[0].imgBack === SHORTS.imgBack);
  T.rememberTriedGarment(PEAK, PEAK.img, PEAK.imgBack);
  check("§4.4 one entry per photo, the newest first", T.readTriedGarments().length === 2 && T.readTriedGarments()[0].img === PEAK.img);
  T.rememberTriedGarment({ ...SHORTS, img: "https://fox.co.il/x-1.jpg" }, "https://fox.co.il/x-1.jpg", "https://fox.co.il/x-1.jpg");
  check("§4.5 a 'back' that is the front photo is not remembered as a back", !("imgBack" in T.readTriedGarments()[0]));
  for (let i = 0; i < 10; i++) T.rememberTriedGarment(PEAK, `https://fox.co.il/p${i}-1.jpg`, null);
  check("§4.6 bounded (6)", T.readTriedGarments().length === 6);
  window.__pearStoreDomain = "castro.com";
  check("§4.7 another store's room sees none of them", T.triedComplementsFor(SHORTS).length === 0);
  const off = mk(null);
  off.T.rememberTriedGarment(PEAK, PEAK.img, PEAK.imgBack);
  check("§4.8 outside a store (the demo catalog) nothing is remembered", off.T.readTriedGarments().length === 0);
  const bad = mk("fox.co.il");
  bad.ls.set("pear_tried_garments", "{not json");
  check("§4.9 a broken memory reads as none, never throws", bad.T.readTriedGarments().length === 0 && bad.T.triedComplementsFor(SHORTS).length === 0);
}

console.log("\n── §5 the wiring ──");
{
  check("§5.1 the classifier's verdict validates the gallery and remembers the garment (single garments only), sandbox-safe",
    /if \(!activeItem \|\| !front\) return;\s*\n\s*\/\*[^\n]*\*\/\s*\n\s*if \(typeof _galleryValidated !== "undefined"\) _galleryValidated = true;[^\n]*\n\s*if \(typeof rememberTriedGarment === "function" && typeof resolveLook === "function" && !resolveLook\(\)\) rememberTriedGarment\(activeItem, front, back\);/.test(APP));
  const bill = between(APP, "function startBillingWindow(gen) {", "\n}\n");
  check("§5.2 the reveal remembers a measured garment only when its gallery is validated (never the unclassified guess)",
    /typeof _galleryValidated !== "undefined" && _galleryValidated &&/.test(bill) && /rememberTriedGarment\(activeItem, g\.front \|\| activeItem\.img, distinctBackOf\(activeItem, g\)\);/.test(bill));
  const store = between(APP, "async function fetchStoreLookItems(currentItem) {", "\n}\n");
  check("§5.3 'Complete the Look' lists the garments you tried first, then the store's - and still the tried ones if the store's fail",
    /const tried = typeof triedComplementsFor === "function" \? triedComplementsFor\(currentItem\) : \[\];/.test(store) &&
    /\.reduce\(\(acc, it\) => acc\.concat\(it\), tried\.slice\(\)\)/.test(store) && /return tried\.slice\(0, 4\);/.test(store));
  check("§5.4 a tried card says so", /\$\{r\.tried \? " · מדדת" : ""\}/.test(APP));
}

console.log(`\n${failed ? "✗" : "✓"} full-look: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
