/* THE WHOLE CAMERA, NOT A STRIP OF IT - and THE FABRIC'S OWN COLOUR (2026-10-14). See CLAUDE.md §2.47.
   "The camera is too close - zoom out, show as much as possible", measured in the source room on the FOX page: the widget's
   ~480px room frame on a desktop page counted as a PHONE, asked the webcam for 9:16 and got a crop (640x480 -> 270x480);
   drawFrame() then cover-fitted that portrait frame into the engine's 16:9 input - a strip of ~32% of its height - and the
   card cover-cropped the render again. This suite runs the REAL code, sliced (CLAUDE.md §2.6):
     §1 the engine input: contained, the camera's own edge columns in the bands, the rectangle published; ?wide=0 and a
        16:9 camera are the cover-fit they always were;
     §2 the camera request: a phone is a touch device, never a narrow window, and asks for its full 4:3 sensor;
     §3 the card and the clip take that rectangle;
     §4 the fabric colour measured from the rear photo, the classifier's colour first;
     §5 the classifier's facts kept when the photos did not change. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function extract(startMarker, endMarker) {
  const s = APP.indexOf(startMarker);
  if (s === -1) throw new Error(`marker not found: ${startMarker}`);
  const e = APP.indexOf(endMarker, s);
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`);
  return APP.slice(s, e);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ── §1 the engine input ─────────────────────────────────────────────────────────────── */
const throttleCode = extract("function createThrottledInputStream(", "\n/**\n * Open the input gate");
function drawOnce({ vw, vh, wide }) {
  const draws = [], noted = [];
  let interval = null;
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    INPUT_GATE_ENABLED: false, INPUT_GATE_MAX_MS: 5000, INPUT_GATE_SETTLE_MS: 0,
    console: { log() {}, warn() {} },
    setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
    MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } },
    liveWideView: () => wide,
    noteLiveContentRect: (...a) => noted.push(a),
    document: {
      createElement: () => ({
        muted: false, playsInline: false, autoplay: false, srcObject: null,
        videoWidth: vw, videoHeight: vh, width: 0, height: 0,
        play: () => Promise.resolve(), pause() {},
        getContext: () => ({ save() {}, restore() {}, setTransform() {}, drawImage: (...a) => draws.push(a) }),
        captureStream: () => ({ getVideoTracks: () => [{ contentHint: "", requestFrame() {}, stop() {} }] }),
      }),
    },
  };
  const fn = new Function(...Object.keys(sandbox), throttleCode + "\nreturn createThrottledInputStream;")(...Object.values(sandbox));
  fn({ getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }], getTracks: () => [] }, { gated: false });
  return new Promise((r) => setImmediate(() => { if (interval) interval(); r({ draws, noted }); }));
}

console.log("── §1 THE ENGINE GETS THE WHOLE CAMERA ──");
{
  /* The reported case: the 270x480 crop the narrow frame's 9:16 request produced (and a phone held upright). */
  const p = await drawOnce({ vw: 270, vh: 480, wide: true });
  const main = p.draws[p.draws.length - 1];
  const s = 288 / 480, dw = 270 * s, dx = (512 - dw) / 2;
  check("a portrait camera is CONTAINED: its full height, centred", main.length === 5 && near(main[1], dx) && near(main[2], 0) &&
    near(main[3], dw) && near(main[4], 288), JSON.stringify(main));
  check("...beside two bands drawn from its own first and last columns, stretched outward (no person duplicated)",
    p.draws.length === 3 && p.draws[0][1] === 0 && p.draws[0][3] === 1 && p.draws[1][1] === 269 && p.draws[1][3] === 1,
    JSON.stringify(p.draws.slice(0, 2)));
  check("...and the rectangle it fills is published, as fractions of the engine frame", p.noted.length === 1 &&
    near(p.noted[0][0], dx / 512) && near(p.noted[0][2], dw / 512) && p.noted[0][1] === 0 && p.noted[0][3] === 1,
    JSON.stringify(p.noted));

  const q = await drawOnce({ vw: 640, vh: 480, wide: true });
  check("a 4:3 webcam is contained too - 384 of the 512 columns", q.draws.length === 3 && near(q.draws[2][3], 384),
    JSON.stringify(q.draws[2]));

  const w = await drawOnce({ vw: 1280, vh: 720, wide: true });
  check("a 16:9 camera reaches the engine EXACTLY as before: one full-frame draw, no bands", w.draws.length === 1 &&
    near(w.draws[0][1], 0) && near(w.draws[0][3], 512) && near(w.draws[0][4], 288), JSON.stringify(w.draws));

  const old = await drawOnce({ vw: 270, vh: 480, wide: false });
  const oscale = Math.max(512 / 270, 288 / 480);
  check("?wide=0 is the cover-fit strip it always was (and publishes nothing)", old.draws.length === 1 &&
    near(old.draws[0][3], 270 * oscale) && near(old.draws[0][4], 480 * oscale) && old.noted.length === 0,
    JSON.stringify(old.draws));
}
{
  const knob = extract("function liveWideView() {", "\nlet _liveContentRect = null;");
  const at = (search) => new Function("location", knob + "\nreturn liveWideView();")({ search });
  check("the wide view is ON by default and ?wide=0 is the room before it", at("") === true && at("?wide=1") === true &&
    at("?wide=0") === false);
  const rectCode = extract("let _liveContentRect = null;", "\n/* Mobile detection");
  const r = new Function(rectCode + "\nreturn { noteLiveContentRect, liveContentRect };")();
  const whole = r.liveContentRect();
  r.noteLiveContentRect(0.25, 0, 0.5, 1);
  check("liveContentRect() is the whole frame until a frame is noted, then that rectangle", whole.w === 1 && whole.h === 1 &&
    r.liveContentRect().x === 0.25 && r.liveContentRect().w === 0.5);
}

console.log("\n── §2 THE CAMERA REQUEST: a phone is a touch device, never a narrow window ──");
{
  const code = extract("function buildVideoConstraints(facing) {", "\nasync function startCamera(");
  const run = ({ narrow, portrait, touch, coarse, wide }) => {
    const window = { matchMedia: (q) => ({ matches: q.includes("max-width") ? narrow : q.includes("orientation") ? portrait : q.includes("pointer") ? coarse : false }) };
    const navigator = { maxTouchPoints: touch ? 5 : 0 };
    return new Function("window", "navigator", "LIVE_FPS", "LIVE_W", "LIVE_H", "liveWideView",
      code + "\nreturn buildVideoConstraints('user');")(window, navigator, 30, 512, 288, () => wide);
  };
  const desk = run({ narrow: true, portrait: true, touch: false, coarse: false, wide: true });
  check("THE REPORT: the widget's narrow portrait frame on a desktop asks the webcam for its 16:9, never 9:16",
    !desk.aspectRatio && desk.width.ideal === 512 && !desk.height, JSON.stringify(desk));
  check("...the width alone, so a 4:3 webcam is not cropped to 16:9 (a 16:9 one is the 512x288 it always was)", !desk.height);
  const phone = run({ narrow: true, portrait: true, touch: true, coarse: true, wide: true });
  check("a phone held upright asks for its full 4:3 sensor, upright (3:4) - 9:16 cropped a quarter of its width",
    phone.aspectRatio && near(phone.aspectRatio.ideal, 3 / 4), JSON.stringify(phone));
  const land = run({ narrow: false, portrait: false, touch: true, coarse: true, wide: true });
  check("...and on its side 4:3 (the standing body needs the height)", land.aspectRatio && near(land.aspectRatio.ideal, 4 / 3));
  const before = run({ narrow: true, portrait: true, touch: false, coarse: false, wide: false });
  check("?wide=0 is the width test and 9:16, as before", before.aspectRatio && near(before.aspectRatio.ideal, 9 / 16));
  const deskOld = run({ narrow: false, portrait: false, touch: false, coarse: false, wide: false });
  check("...and a wide desktop window 512x288 ideal, as before", deskOld.width.ideal === 512 && deskOld.height.ideal === 288);
}

console.log("\n── §3 THE CARD AND THE CLIP TAKE THAT RECTANGLE ──");
{
  check("the card takes the camera's exact shape under the wide view (so the render's cover-fit crops only the bands)",
    /if \(typeof liveWideView === "function" && liveWideView\(\)\) card\(\)\.style\.aspectRatio = `\$\{vw\} \/ \$\{vh\}`;/.test(APP));
  const rec = extract("function startRecording()", "/** Halt the canvas paint loop");
  check("the clip records the camera's rectangle of the render, at even dimensions",
    /const cr = typeof liveContentRect === "function" \? liveContentRect\(\)/.test(rec) &&
    /ctx\.drawImage\(video, sx, sy, cr\.w \* vw0, cr\.h \* vh0, 0, 0, w, h\);/.test(rec) && /& ~1/.test(rec));
  check("...the frozen tail crops the same rectangle (centred, so the baked flip cannot move it)",
    /ctx\.drawImage\(recordHoldSrc, hr\.x \* HW, hr\.y \* HH, hr\.w \* HW, hr\.h \* HH, 0, 0, recordCanvas\.width, recordCanvas\.height\);/.test(rec));
  const cont = extract("function drawContinuityFrame", "function startStreamContinuity()");
  check("the camera layer is fitted with the throttle's own switch, so it lands on the render's body",
    /wide \? Math\.min\(W \/ vw, H \/ vh\) : Math\.max\(W \/ vw, H \/ vh\)/.test(cont) &&
    /wide \? Math\.min\(width \/ vw, height \/ vh\) : Math\.max\(width \/ vw, height \/ vh\)/.test(throttleCode));
}

console.log("\n── §4 THE FABRIC'S OWN COLOUR, measured from the rear photo ──");
{
  const code = extract("const _refFabricColors = new Map();", "\n/** The rows to paint on an image");
  const mk = () => new Function("location", "console", "abbrevImg", "canonicalImageUrl", "distinctBackOf",
    code + "\nreturn { noteReferenceFabricColor, measuredFabricColorOf };")(
    { search: "" }, { log() {}, warn() {} }, (u) => u, (u) => String(u).split("?")[0], (it) => it.imgBack);
  /* A 400x600 rear photo: a beige fabric (#dcc6b5), a big print square in the middle, the backdrop outside the box. */
  const W = 400, H = 600;
  const px = (x, y) => (x < 80 || x > 320 ? [240, 232, 226] : (x > 150 && x < 250 && y > 150 && y < 330) ? [20, 20, 20] : [220, 198, 181]);
  const ctx = { getImageData: (sx, sy, sw, sh) => { const d = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const [r, g, b] = px(sx + x, sy + y); const i = (y * sw + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
    return { data: d }; } };
  const band = { y0: 0.1, y1: 0.9, x0: 0.2, x1: 0.8 };
  const A = mk();
  check("a top's rear photo: the lower-back flanks give the fabric, the print in the middle does not",
    A.noteReferenceFabricColor("https://s/x-4.jpg?v=1", ctx, W, H, band, "top") === "#dcc6b5");
  check("...and it is the colour of the item whose rear photo it is", A.measuredFabricColorOf({ imgBack: "https://s/x-4.jpg?v=2" }) === "#dcc6b5" &&
    A.measuredFabricColorOf({ imgBack: "https://s/other.jpg" }) === null && A.measuredFabricColorOf({}) === null);
  /* Stripes across the patch: no colour holds 60% - abstain, a wrong colour named is worse than none. */
  const striped = { getImageData: (sx, sy, sw, sh) => { const d = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const c = ((sx + x) >> 3) % 2 ? [200, 30, 30] : [30, 30, 200]; const i = (y * sw + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    return { data: d }; } };
  check("a two-colour stripe abstains", mk().noteReferenceFabricColor("https://s/y.jpg", striped, W, H, band, "bottom") === null);
  const off = new Function("location", "console", "abbrevImg", "canonicalImageUrl", "distinctBackOf",
    code + "\nreturn noteReferenceFabricColor;")({ search: "?fabric_measure=0" }, { log() {} }, (u) => u, (u) => u, () => null);
  check("?fabric_measure=0 turns it off", off("https://s/x.jpg", ctx, W, H, band, "top") === null);

  const facts = extract("function promptFactsOf(item) {", "\n/* Wire prompts by request");
  const pf = (measured) => new Function("PROMPT_FACT_STRINGS", "PROMPT_FACT_BOOLS", "isBottomsGarment", "measuredFabricColorOf",
    facts + "\nreturn promptFactsOf;")(["colorHex", "name"], [], () => false, () => measured);
  check("the prompt gets the measured colour only when the classifier sent none", pf("#dcc6b5")({ name: "x" }).colorHex === "#dcc6b5" &&
    pf("#dcc6b5")({ name: "x", colorHex: "#4e3b38" }).colorHex === "#4e3b38" && !("colorHex" in pf(null)({ name: "x" })));
  const mask = extract("async function maskReferenceBand(blob, url, band) {", "\n/* Warm the cache");
  check("it is measured inside the mask, before anything is painted",
    mask.indexOf("ctx.drawImage(bmp, 0, 0);") < mask.indexOf("noteReferenceFabricColor(url, ctx, W, H, band") &&
    mask.indexOf("noteReferenceFabricColor(url, ctx, W, H, band") < mask.indexOf("paint(0, rows.top"));
}

console.log("\n── §5 THE GARMENT'S FACTS ARE KEPT EVEN WHEN ITS PHOTOS DID NOT CHANGE ──");
{
  const a = APP.indexOf("  /* THE GARMENT'S FACTS ARE KEPT EVEN WHEN ITS PHOTOS DID NOT CHANGE");
  const b = APP.indexOf("  const unchanged = target.img === front && target.imgBack === back &&", a);
  const block = APP.slice(a, b);
  const run = (data, target = {}) => { new Function("e", "target", block)({ data }, target); return target; };
  const t = run({ garment_color_hex: "#000000", garment_text_ocr: "CHICAGO", garment_back_is_plain: true });
  check("every session keeps the colour, the printed text and the plain-rear verdict before the unchanged return (CHICAGO)",
    a > 0 && b > a && t.colorHex === "#000000" && t.textOcr === "CHICAGO" && t.backIsPlain === true, JSON.stringify(t));
  const k = run({ garment_text_ocr: "" }, { colorHex: "#ffffff" });
  check("...an absent colour never clears a known one; an empty text is a real verdict", k.colorHex === "#ffffff" && k.textOcr === "");
  check("...and it sits before the unchanged early return", APP.indexOf("if (unchanged) {", b) > b);
}

console.log(fails ? `\n${fails} FAILING` : "\nwide-view: all green");
process.exit(fails ? 1 : 0);
