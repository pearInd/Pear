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

console.log("\n── §2 each half cropped to its garment, in THE OUTFIT SHAPE ──");
{
  const src = between(APP, "const LOOK_BAND_TIMEOUT_MS = 3500;", "\n/**\n * Stitch a TOP + BOTTOM garment asset");
  const mk = (fetchImpl) => new Function("fetch", "location", "AbortSignal", "canonicalImageUrl",
    src + "\nreturn { lookGarmentBand, outfitLayout, OUTFIT_W, OUTFIT_H, OUTFIT_JPEG_Q };")(fetchImpl, { origin: "https://room.test" }, undefined, (u) => u);
  const G = mk(() => Promise.reject(new Error("unused")));
  /* the PEAK tee's band on its 1000x1499 photo (0.345-0.875 x 0.167-0.833) over the CHICAGO shorts' (2048x3072: 0.06-0.61 x 0.24-0.79) */
  const tw = 0.666 * 1000, th = 0.53 * 1499, bw = 0.555 * 2048, bh = 0.55 * 3072;
  const L = G.outfitLayout(tw, th, bw, bh);
  const W = G.OUTFIT_W, H = G.OUTFIT_H;
  check("§2.1 a portrait outfit frame, ~10x fewer pixels than the old 1024x2048 panels", W === 768 && H === 1152 && G.OUTFIT_JPEG_Q <= 0.9);
  check("§2.2 the top keeps its aspect, inside the frame, its hem on the seam at ~56% of the height",
    Math.abs(L.top.w / L.top.h - tw / th) < 1e-6 && L.top.x >= 0 && L.top.y >= 0 && L.top.x + L.top.w <= W + 1e-6 &&
    Math.abs(L.top.y + L.top.h - H * 0.56) < 1e-6, JSON.stringify(L.top));
  check("§2.3 the bottom keeps its aspect, under the hem (overlapping it a little, as worn), inside the frame, centred",
    Math.abs(L.bottom.w / L.bottom.h - bw / bh) < 1e-6 && L.bottom.y < L.top.y + L.top.h && L.bottom.y > L.top.y + L.top.h - 0.05 * L.top.h &&
    L.bottom.y + L.bottom.h <= H + 1e-6 && Math.abs(L.bottom.x + L.bottom.w / 2 - W / 2) < 1e-6, JSON.stringify(L.bottom));
  check("§2.4 ...no wider than ~3/4 of the top (a waist under a pair of sleeves)", L.bottom.w <= L.top.w * 0.74 + 1e-6);
  /* a bottom shown without its band: the top 65% of its photo, 16% of it tucked under the shirt's hem */
  const T = G.outfitLayout(tw, th, 2048, 0.65 * 3072, W, H, 0.16);
  check("§2.4b a bottom without a band is tucked under the hem (here 16%) of its height (what is above its waist goes under the top), still inside the frame",
    Math.abs((T.top.y + T.top.h) - T.bottom.y - 0.16 * T.bottom.h) < 1e-6 && T.bottom.y + T.bottom.h <= H - W * 0.04 + 1e-6 && T.bottom.w <= T.top.w * 0.74 + 1e-6, JSON.stringify(T));
  /* the fetch */
  const asked = [];
  const ok = mk(async (u) => { asked.push(u); return { ok: true, json: async () => ({ band: { y0: 0.07, y1: 0.61, x0: 0.24, x1: 0.79 }, reason: "band" }) }; });
  const b1 = await ok.lookGarmentBand(SHORTS.img, "bottom"), b2 = await ok.lookGarmentBand(SHORTS.img, "bottom");
  check("§2.5 the server's band for the region asked (v4), memoised per photo and region",
    b1 && b1.y0 === 0.07 && b1.x1 === 0.79 && b2 === b1 && asked.length === 1 && /region=bottom&v=4$/.test(asked[0]) && /\/api\/garment-box\?image_url=/.test(asked[0]), asked.join(" "));
  const noX = mk(async () => ({ ok: true, json: async () => ({ band: { y0: 0.2, y1: 0.6 } }) }));
  const b3 = await noX.lookGarmentBand(PEAK.img, "top");
  check("§2.6 a band without x keeps the full width", b3 && b3.x0 === 0 && b3.x1 === 1);
  const abstain = mk(async () => ({ ok: true, json: async () => ({ band: null, reason: "no-person" }) }));
  check("§2.7 an abstention or a thin band: none (the whole photo)", (await abstain.lookGarmentBand(PEAK.img, "top")) === null &&
    (await mk(async () => ({ ok: true, json: async () => ({ band: { y0: 0.4, y1: 0.45 } }) })).lookGarmentBand(PEAK.img, "top")) === null);
  let n = 0;
  const flaky = mk(async () => { n++; throw new Error("network"); });
  const f1 = await flaky.lookGarmentBand(PEAK.img, "top"), f2 = await flaky.lookGarmentBand(PEAK.img, "top");
  check("§2.8 a failure is not an answer - asked again next time, never thrown", f1 === null && f2 === null && n === 2);
  check("§2.9 an upload (data:/blob:) is never sent to the server", (await ok.lookGarmentBand("data:image/png;base64,AA", "top")) === null && asked.length === 1);
  const stitch = between(APP, "function stitchLookBlob(topUrl, bottomUrl) {", "\n}\n");
  check("§2.10 the stitch: both bands, the bottom drawn first and the top over it, one backdrop, no bar, no labels, its own cache key",
    /lookGarmentBand\(topUrl, "top"\), lookGarmentBand\(bottomUrl, "bottom"\)\]\);/.test(stitch) &&
    /const L = outfitLayout\(ts\.sw, ts\.sh, bs\.sw, bs\.sh, OUTFIT_W, OUTFIT_H, bottomBand \? 0 : OUTFIT_WHOLE_TUCK\);/.test(stitch) &&
    stitch.indexOf("L.bottom.x, L.bottom.y") < stitch.indexOf("L.top.x, L.top.y") && /ctx\.fillStyle = OUTFIT_BG;/.test(stitch) &&
    !/drawSectionLabel|LOOK_SEP|"#000000"/.test(stitch.replace(/\/\*[\s\S]*?\*\//g, "")) && /const key = `outfit2 \$\{topUrl\} \$\{bottomUrl\}`;/.test(stitch));
}

console.log("\n── §3 applyLook stitches in AI Auto ──");
{
  const look = between(APP, "async function applyLook(top, bottom) {", "\n}\n");
  check("§3.1 the halves are this side's, frozen before any await (§2.8)",
    /const lookAngle = currentAngle === AUTO_ANGLE && typeof effectiveAngle === "function" \? effectiveAngle\(\) : null;\s*\n\s*const topImg = lookHalfFor\(top, lookAngle\), bottomImg = lookHalfFor\(bottom, lookAngle\);/.test(look) &&
    (() => { const c = look.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); return c.indexOf("lookHalfFor(top, lookAngle)") < c.indexOf("await "); })());
  check("§3.2 the stitch is no longer skipped for AI Auto - only a missing half skips it",
    /const canStitchLook = !!\(topImg && bottomImg\);/.test(look) && !/currentAngle !== AUTO_ANGLE/.test(look.replace(/\/\*[\s\S]*?\*\//g, "")));
  /* THE LOOK'S NO-OP (2026-10-11): every re-anchor re-uploaded the composite - no reveal in session mv3hkkb2 (17 uploads). */
  check("§3.2b an unchanged look (the same side's composite + the same prompt) sends nothing, before the wire is taken",
    /if \(primaryImage === lastSentImageRef && prompt === lastSentPrompt\) \{[^}]*return;\s*\n\s*\}/.test(look) &&
    look.indexOf("primaryImage === lastSentImageRef") < look.indexOf('sendCondition("applyLook"'));
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
  const lis = between(APP, 'window.addEventListener("message", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;', "\n});\n");
  check("§5.1 any verdict - the bare ready signal too - validates the gallery, before the garment fields are read",
    lis.indexOf('if (typeof _galleryValidated !== "undefined") _galleryValidated = true;') !== -1 &&
    lis.indexOf('if (typeof _galleryValidated !== "undefined") _galleryValidated = true;') < lis.indexOf("if (!front) return;"));
  check("§5.1b ...and a full correction remembers the room's own garment, sandbox-safe",
    /if \(typeof rememberTriedGarment === "function"\) rememberTriedGarment\(target, front, back\);/.test(lis) &&
    lis.indexOf("rememberTriedGarment(target, front, back)") > lis.indexOf("if (!target) {"));
  /* THE VERDICT IS FOR THE ROOM'S OWN GARMENT (2026-10-11): "it measured the shorts twice, as the shorts and as the shirt". */
  check("§5.6 the correction is written to the room's OWN garment (enterRoom's), never to a garment added since",
    /const target = \(typeof _handoffItem !== "undefined" && _handoffItem\) \|\| \(typeof activeItem !== "undefined" \? activeItem : null\);/.test(lis) &&
    !/\bactiveItem\.(img|imgBack|pearImages|composite|colorHex|textOcr|backIsPlain|backSource)\s*=/.test(lis) &&
    /target\.img = front;/.test(lis) && /target\.imgBack = back;/.test(lis));
  check("§5.7 enterRoom() records which garment that is", /setActiveItem\(toItem\(handoff\), \{ silent: true \}\);\s*\n\s*_handoffItem = activeItem;/.test(APP));
  check("§5.8 a corrected half of a full look rebuilds the look's composites",
    /if \(typeof activeItem !== "undefined" && target !== activeItem && typeof prewarmLookComposites === "function"\) prewarmLookComposites\(\);/.test(lis));
  const bill = between(APP, "function startBillingWindow(gen) {", "\n}\n");
  check("§5.2 the reveal remembers a measured garment only when its gallery is validated (never the unclassified guess)",
    /typeof _galleryValidated !== "undefined" && _galleryValidated &&/.test(bill) && /rememberTriedGarment\(activeItem, g\.front \|\| activeItem\.img, distinctBackOf\(activeItem, g\)\);/.test(bill));
  const store = between(APP, "async function fetchStoreLookItems(currentItem) {", "\n}\n");
  check("§5.3 'Complete the Look' lists the garments you tried first, then the store's - and still the tried ones if the store's fail",
    /const tried = typeof triedComplementsFor === "function" \? triedComplementsFor\(currentItem\) : \[\];/.test(store) &&
    /\.reduce\(\(acc, it\) => acc\.concat\(it\), tried\.slice\(\)\)/.test(store) && /return tried\.slice\(0, 4\);/.test(store));
  check("§5.4 a tried card says so - in the shopper's language (clTried: מדדת / Tried), repainted by a language switch",
    /\$\{r\.tried \? ` · <span data-i18n="clTried">\$\{t\("clTried"\)\}<\/span>` : ""\}/.test(APP) &&
    /clTried:\s*\{ he: "מדדת", en: "Tried" \}/.test(readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8")));
  const rc = between(APP, "async function renderCompleteTheLook(item) {", "\n}\n");
  check("§5.5 a garment shown with an already-verified gallery is remembered too (the widget sends no correction then)",
    /_galleryValidated &&\s*\n\s*typeof activeItem !== "undefined" && item === activeItem && typeof resolveLook === "function" && !resolveLook\(\)\) \{\s*\n\s*const g = galleryOf\(item\);\s*\n\s*rememberTriedGarment\(item, g\.front \|\| item\.img, distinctBackOf\(item, g\)\);/.test(rc) &&
    rc.indexOf("rememberTriedGarment") < rc.indexOf("await "));
}

console.log("\n── §6 the early verdict - a correction before the room has a garment ──");
{
  const lis = between(APP, 'window.addEventListener("message", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;', "\n});\n");
  check("§6.1 with no garment yet the correction is HELD, not dropped",
    /if \(!target\) \{ if \(typeof _earlyGarmentUpdate !== "undefined"\) _earlyGarmentUpdate = e\.data; return; \}/.test(lis));
  const enter = between(APP, "function enterRoom() {", "\n}\n");
  check("§6.2 enterRoom() replays it right after the garment is set",
    /setActiveItem\(toItem\(handoff\), \{ silent: true \}\);\s*\n\s*_handoffItem = activeItem;[^\n]*\n\s*\/\*[^\n]*\*\/\s*\n\s*if \(typeof replayEarlyGarmentUpdate === "function"\) replayEarlyGarmentUpdate\(\);/.test(enter));
  const rp = between(APP, "let _earlyGarmentUpdate = null;", "\nwindow.addEventListener(\"message\", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== \"PEAR_UPDATE_GARMENT\")");
  const sent = [];
  const parent = { name: "parent" };
  class MessageEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const mk = (active) => new Function("window", "MessageEvent", "activeItem", rp + "\nreturn { hold: (d) => { _earlyGarmentUpdate = d; }, replayEarlyGarmentUpdate, get held() { return _earlyGarmentUpdate; } };")(
    { parent, dispatchEvent: (ev) => sent.push(ev) }, MessageEvent, active);
  const R = mk({ name: "PEAK" });
  const msg = { type: "PEAR_UPDATE_GARMENT", garment_url: PEAK.img, garment_back: PEAK.imgBack };
  R.hold(msg);
  check("§6.3 the replay goes through the listener itself - the same message, from the parent - once",
    R.replayEarlyGarmentUpdate() === true && sent.length === 1 && sent[0].data === msg && sent[0].source === parent && R.held === null &&
    R.replayEarlyGarmentUpdate() === false && sent.length === 1);
  const N = mk(null);
  N.hold(msg);
  check("§6.4 no garment yet, nothing replayed", N.replayEarlyGarmentUpdate() === false && sent.length === 1);
}

console.log("\n── §7 the card shows both views of both garments; a store item is not a custom upload ──");
{
  const render = between(APP, "function renderActiveGarment() {", "\n}\n");
  check("§7.1 a full look's card shows four views - each half's front and back", /<span class="ag-duo ag-duo--views">\$\{lookViewThumbs\(top\)\}\$\{lookViewThumbs\(bottom\)\}<\/span>/.test(render));
  const src = between(APP, "function lookViewThumbs(item) {", "\nfunction garmentThumb(item) {");
  const T = new Function("lookHalfFor", "distinctBackOf", "galleryOf", src + "\nreturn lookViewThumbs;")(
    (it, side) => (side === "front" ? it.img : it.imgBack), (it, g) => (g.back && g.back !== g.front ? g.back : undefined), galleryOf);
  const both = T(PEAK), noBack = T(PANTS_NO_BACK);
  check("§7.2 the shirt: its front labelled חזית and its back labelled גב",
    both.includes(PEAK.img) && both.includes(PEAK.imgBack) && />חזית</.test(both) && />גב</.test(both) && !/ag-view--missing/.test(both), both);
  check("§7.3 a half with no back of its own says so (אין גב), dimmed - never its front labelled as the back",
    /ag-view--missing/.test(noBack) && />אין גב</.test(noBack) && !/>גב</.test(noBack), noBack);
  check("§7.4 'Custom upload' only for an uploaded crop (data:/blob:); a store product reads 'Store item'",
    /const uploaded = item\.custom && \/\^\(data:\|blob:\)\/i\.test\(String\(item\.img \|\| ""\)\);/.test(render) &&
    /"חולצה מהחנות · Store item"/.test(render) && /"מכנסיים מהחנות · Store item"/.test(render));
  const css = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
  check("§7.5 the four views lay out two by two", /\.active-garment__media > span\.ag-duo--views \{ grid-template-columns: 1fr 1fr;/.test(css) && /\.ag-view \{[^}]*aspect-ratio: 1 \/ 1;/.test(css));
}

console.log("\n── §8 a full look's floor is its front outfit - the engine has seen it before go-live's first apply ──");
{
  /* MEASURED (2026-10-11): the full-look sessions revealed 7.0-14.2s after connect (s4, s5, mv3j8ba0) where the single garments
     revealed in 5.5-5.7s - the session was seeded with the TOP's packshot, so go-live's first applyLook() was a new image. */
  const src = between(APP, "const LOOK_FLOOR_WAIT_MS = ", "\n/* Read by buildRealtimeConnectOpts()");
  const guard = between(APP, "function usableImageRef(ref) {", "\n/**\n * The hard stop");
  const mk = ({ never = false, prompt = "LOOK" } = {}) => {
    const asked = [], blob = new Blob(["outfit"], { type: "image/jpeg" });
    const env = {
      lookHalfFor: (it, side) => (side === "back" ? it.imgBack || it.img : it.img),
      stitchLookBlob: (a, b) => { asked.push([a, b]); return never ? new Promise(() => {}) : Promise.resolve(blob); },
      wireLookPrompt: async () => prompt, setTimeout, clearTimeout, Blob, URL, console: { log() {}, warn() {} },
    };
    const f = new Function(...Object.keys(env), guard + "\n" + src.replace(/^const LOOK_FLOOR_WAIT_MS = \d+;/, "const LOOK_FLOOR_WAIT_MS = 30;") + "\nreturn resolveLookFloor;")(...Object.values(env));
    return { f, asked, blob };
  };
  {
    const m = mk(); const fl = await m.f({ top: PEAK, bottom: SHORTS });
    check("§8.1 the floor is the stitch of both halves' FRONTS - the cached Blob applyLook() asks for at go-live - with the look prompt",
      fl && fl.image === m.blob && fl.prompt.text === "LOOK" && fl.prompt.enhance === false &&
      m.asked.length === 1 && m.asked[0][0] === PEAK.img && m.asked[0][1] === SHORTS.img, JSON.stringify({ fl, asked: m.asked }));
  }
  {
    const m = mk({ never: true }); const t0 = Date.now(); const fl = await m.f({ top: PEAK, bottom: SHORTS });
    check("§8.2 a composite not ready within LOOK_FLOOR_WAIT_MS is not waited for - null, the top's packshot seeds as before", fl === null && Date.now() - t0 < 1000);
  }
  {
    const m = mk({ prompt: "" });
    check("§8.3 no look prompt, no look floor (a floor's prompt is never empty)", (await m.f({ top: PEAK, bottom: SHORTS })) === null);
  }
  const prime = between(APP, "async function primeInitialConditioning() {", "\n/* ── THE ACKNOWLEDGED FLOOR IS ON THE WIRE");
  check("§8.4 primeInitialConditioning seeds a look with resolveLookFloor() first, the top's packshot only as the fallback",
    /const lookFloor = look && collageFirst && typeof resolveLookFloor === "function" \? await resolveLookFloor\(look\) : null;\s*floorIsLook = !!lookFloor;\s*floor = lookFloor \|\| await resolveInitialConditioning\(item\);/.test(prime) &&
    /* (2026-10-12) a TEST session never opens on the collage - the top's packshot, the outfit right after the connect. */
    /const collageFirst = !\(typeof traceEnabled === "function" && traceEnabled\(\)\);/.test(prime));
  check("§8.5 ...and re-resolves when the look's bottom changed meanwhile (that composite is stale)",
    /\(!floorIsLook \|\| \(nowLook && nowLook\.bottom === look\.bottom\)\)/.test(prime));
  const adopt = between(APP, "function adoptInitialStateAsWire(why) {", "\n}\n");
  const apply = between(APP, "async function applyLook(top, bottom) {", "\n/* buildLookPrompt()");
  check("§8.6 the floor is recorded as on the wire, so go-live's first applyLook() is the no-op (same Blob, same prompt)",
    /lastSentImageRef = _sessionInitialState\.image;/.test(adopt) && /lastSentPrompt = _sessionInitialState\.prompt\.text;/.test(adopt) &&
    /if \(primaryImage === lastSentImageRef && prompt === lastSentPrompt\) \{/.test(apply) &&
    /const lookAngle = currentAngle === AUTO_ANGLE && typeof effectiveAngle === "function" \? effectiveAngle\(\) : null;/.test(apply));
}

console.log(`\n${failed ? "✗" : "✓"} full-look: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
