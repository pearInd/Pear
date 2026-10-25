/* PHOTO TRY-ON - the still path beside the live one.

   lib/photo-tryon.js dresses ONE shopper photo in the garment's front reference; the
   room's live/photo switch (setupFitMode() in app.js) decides which path the capture
   button takes. The contract:
     §1 the request: only data: URL images go anywhere; at most two garments; a region
        the room did not name is dropped.
     §2 the prompt: identity, body and scene are locked; the garment is reproduced from
        its image, not redesigned.
     §3 the call: never rejects - no key, a throttle, a network error, a text-only answer
        all come back ok:false; a good answer is a data: URL image.
     §4 the room: live is the default and untouched; the mode is locked while a session
        runs; the still is cleared on the way back to live (§2.9); the gallery button
        shows only in photo mode with the camera open; the garment sent is the FRONT
        reference; no shipped word names the model (§2.24). */

import { readFileSync } from "node:fs";
import { sanitizePhotoTryOnRequest, photoTryOnPrompt, photoTryOn } from "../lib/photo-tryon.js";

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log("  ✓ " + label);
  else { fails++; console.log("  ✗ " + label + (detail !== undefined ? "  → " + JSON.stringify(detail) : "")); }
}

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

console.log("\n── §1 the request ──");
{
  const r = sanitizePhotoTryOnRequest({
    person: IMG,
    garments: [{ image: IMG, region: "upper_body", name: "PEAK tee" }, { image: IMG, region: "lower_body", name: "Jeans" }, { image: IMG }],
  });
  check("§1.1 the person photo is accepted", r.person && r.person.mimeType === "image/jpeg");
  check("§1.2 at most two garments", r.garments.length === 2, r.garments.length);
  check("§1.3 region and name pass through", r.garments[0].region === "upper_body" && r.garments[1].name === "Jeans");
  check("§1.4 a URL is not an image", sanitizePhotoTryOnRequest({ person: "https://x/y.jpg" }).person === null);
  check("§1.5 a garment without a usable image is dropped",
    sanitizePhotoTryOnRequest({ person: IMG, garments: [{ image: "data:text/html;base64,PGI+" }] }).garments.length === 0);
  check("§1.6 an unknown region is dropped, the garment kept",
    sanitizePhotoTryOnRequest({ person: IMG, garments: [{ image: IMG, region: "head" }] }).garments[0].region === null);
  check("§1.7 an oversize photo is refused",
    sanitizePhotoTryOnRequest({ person: "data:image/jpeg;base64," + "A".repeat(3_000_001) }).person === null);
  check("§1.8 no body at all is safe", sanitizePhotoTryOnRequest(undefined).person === null);
}

console.log("\n── §2 the prompt ──");
{
  const p = photoTryOnPrompt([{ region: "lower_body", name: "Jeans" }]);
  check("§2.1 identity, body and scene are locked", /face/.test(p) && /body shape/.test(p) && /background/.test(p) && /Do not slim/.test(p));
  check("§2.2 the garment is reproduced from its image", /Reproduce the garment from its image faithfully/.test(p) && /text must read correctly/.test(p));
  check("§2.3 the region the room named reaches it", /lower body/.test(p) && /"Jeans"/.test(p));
}

console.log("\n── §3 the call ──");
{
  const req = sanitizePhotoTryOnRequest({ person: IMG, garments: [{ image: IMG, region: "upper_body" }] });
  const reply = (parts, status = 200) => async () => ({
    ok: status === 200, status, json: async () => ({ candidates: [{ content: { parts } }] }),
  });
  check("§3.1 no key → unconfigured, no call", (await photoTryOn(req, "", () => { throw new Error("called"); })).reason === "unconfigured");
  check("§3.2 no person → bad_person", (await photoTryOn({ person: null, garments: req.garments }, "k")).reason === "bad_person");
  check("§3.3 no garment → bad_garment", (await photoTryOn({ person: req.person, garments: [] }, "k")).reason === "bad_garment");
  check("§3.4 a throttle → rate_limited", (await photoTryOn(req, "k", reply([], 429))).reason === "rate_limited");
  check("§3.5 a network failure → error, not a rejection",
    (await photoTryOn(req, "k", async () => { throw new Error("offline"); })).reason === "error");
  check("§3.6 a text-only answer is an abstention", (await photoTryOn(req, "k", reply([{ text: "I can't" }]))).reason === "no_image");
  let sent = null;
  const ok = await photoTryOn(req, "k", async (url, init) => {
    sent = JSON.parse(init.body);
    return reply([{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }])();
  });
  check("§3.7 a good answer is a data: URL image", ok.ok && ok.image === "data:image/png;base64,iVBORw0KGgo=", ok);
  const parts = sent?.contents?.[0]?.parts || [];
  check("§3.8 the prompt, then the person, then the garment", parts.length === 3 && typeof parts[0].text === "string" &&
    parts[1].inline_data?.mime_type === "image/jpeg" && parts[2].inline_data?.mime_type === "image/jpeg");
}

console.log("\n── §4 the room ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8");
  const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
  const I18N = readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8");
  const slice = (from, to) => { const a = APP.indexOf(from); return a < 0 ? "" : APP.slice(a, APP.indexOf(to, a)); };
  const setMode = slice("function setFitMode(mode) {", "\n}\n");
  const run = slice("async function runPhotoFit(source) {", "\nfunction setupFitMode()");

  check("§4.1 live is the default", /let fitMode = "live";/.test(APP) && /id="fitModeToggle"[^>]*data-active="live"/.test(HTML));
  check("§4.2 the mode is locked while a session runs", /if \(photoFitBusy \|\| isLive\(\)\) return;/.test(setMode));
  check("§4.3 the still is cleared on the way back to live", /if \(mode === "live"\) clearPhotoFit\(\);/.test(setMode));
  check("§4.4 a late still never lands on live", /if \(fitMode !== "photo" \|\| isLive\(\)\) return;/.test(run));
  check("§4.5 the capture button only branches outside a session",
    /if \(typeof fitMode !== "undefined" && fitMode === "photo" && !isLive\(\)\) \{ takeFitPhoto\(\); return; \}/.test(APP));
  check("§4.6 the garment sent is the FRONT reference", /galleryOf\(it\)\.front \|\| it\.img/.test(run));
  check("§4.7 the gallery button needs photo mode AND an open camera",
    /\.camera-card\.is-photo-mode\.live \.photo-gallery-btn \{ display: flex; \}/.test(CSS) && /\.photo-gallery-btn \{[^}]*display: none;/.test(CSS));
  check("§4.8 the switch is the gender switch's glass and gesture layer",
    /class="gender-toggle liquid-glass-track fit-mode-toggle"/.test(HTML) &&
    /setupGenderSwitch\(track, \{ tab: "\.fit-mode-tab", key: "mode", get: \(\) => fitMode, set: setFitMode \}\);/.test(APP));
  check("§4.9 the gender switch is still wired as before", /\n  setupGenderSwitch\(\$\("genderToggle"\)\);/.test(APP));
  const shipped = setMode + run + slice("function setupFitMode() {", "\n}\n") +
    (I18N.match(/(fitMode|photoFit|photoGallery)\w*:[^\n]*/g) || []).join("\n") +
    HTML.slice(HTML.indexOf('id="photoFit"'), HTML.indexOf('<div class="cam-controls">'));
  check("§4.10 no shipped word names the model (CLAUDE.md §2.24)", !/gemini|google/i.test(shipped));
  check("§4.11 the photo is never logged", !/console\.\w+\([^;]*(\$\{\s*person|\$\{\s*source|answer\.image|,\s*(person|source|garments)\b)/.test(run));
  check("§4.12 the live layers are untouched: no new rule on #webcam / #aiVideo",
    !/photo[^{]*#(webcam|aiVideo)|#(webcam|aiVideo)[^{]*photo/.test(CSS));
}

console.log("\n── §5 full body or nothing ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const code = APP.slice(APP.indexOf("const PHOTO_FULL_BODY = Object.freeze({"), APP.indexOf("async function photoShowsFullBody("));
  const verdict = new Function(code + "\nreturn photoFullBodyVerdict;")();
  const body = (over = {}) => {
    const lms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.95 }));
    for (const [i, v] of Object.entries(over)) lms[i] = { ...lms[i], ...v };
    return { landmarks: [lms] };
  };
  check("§5.1 head to ankles in frame passes", verdict(body()).ok === true);
  check("§5.2 a hidden ankle fails, and is named", (() => { const v = verdict(body({ 28: { visibility: 0.2 } })); return !v.ok && v.missing.includes("RIGHT_ANKLE"); })());
  check("§5.3 a knee below the frame fails", verdict(body({ 25: { y: 1.08 } })).ok === false);
  check("§5.4 a head above the frame fails", verdict(body({ 0: { y: -0.05 } })).ok === false);
  check("§5.5 no person fails", verdict({ landmarks: [] }).ok === false);
  check("§5.6 no detector answer is 'cannot judge', not a pass", verdict(null) === null);

  const run = APP.slice(APP.indexOf("async function runPhotoFit(source) {"), APP.indexOf("\nfunction setupFitMode()"));
  check("§5.7 the check runs before the request is built", run.indexOf("photoShowsFullBody(") > 0 &&
    run.indexOf("photoShowsFullBody(") < run.indexOf("/api/photo-tryon") && run.indexOf("photoShowsFullBody(") < run.indexOf("garments.push("));
  check("§5.8 it fails closed: no verdict or a partial body never sends",
    /if \(!body \|\| !body\.ok\) \{[\s\S]*?throw new Error\("not a full-body photo"\);/.test(run));
  check("§5.9 the photo sent is the very canvas that was checked", /const person = personCanvas\.toDataURL\("image\/jpeg", 0\.85\);/.test(run));
}

console.log("\n── §6 one timer, a body guide, a far-back body ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8");
  const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
  const slice = (from, to) => { const a = APP.indexOf(from); return a < 0 ? "" : APP.slice(a, APP.indexOf(to, a)); };
  const setModeOf = () => slice("function setFitMode(mode) {", "\n}\n");
  const take = slice("async function takeFitPhoto() {", "\n}\n");
  check("§6.1 the photo uses the room's self-timer and its countdown - no timer of its own",
    /typeof liveTimerSec === "number" \? liveTimerSec : 0/.test(take) && /runGoCountdown\(seconds, "during"\)/.test(take) &&
    !/PHOTO_FIT_TIMER_S/.test(APP) && !/photoFitCount/.test(HTML));
  check("§6.2 a cancelled countdown takes no photo", /if \(!go\) \{ photoFitBusy = false; return; \}/.test(take));
  /* The lines on the body belong to the SIZE ESTIMATE's camera only (reported 2026-10-24: "the
     lines only in the find-my-size part, not while measuring with a photo"). */
  const guide = slice("function createBodyGuide({", "\n}\n");
  const draw = slice("function drawBodyGuide(", "\n}\n");
  const cam = slice("function openPhotoCamera() {", "\nfunction setupPhotoEstimate()");
  check("§6.3 the guide reads the body through the one guarded call site", /detectPoseFrame\(detector, video\)/.test(guide) && !/detectForVideo/.test(guide + draw));
  check("§6.4 the guide never runs during a live session", /video\.videoWidth && !isLive\(\)/.test(guide));
  check("§6.5 stopping it hands the next reader a clean focus window", /function stopGuide\(\) \{[\s\S]*?_poseFocus = null; _poseFullMisses = 0;/.test(guide));
  check("§6.6 the guide is the photo check's own verdict", /const verdict = photoFullBodyVerdict\(result\);/.test(draw));
  check("§6.7 the guide canvas is mirrored like the video", /\.photo-cam__guide \{[^}]*transform: scaleX\(-1\)/.test(CSS));
  check("§6.8 the size estimate's camera starts it and stops it on close",
    /const guide = createBodyGuide\(\{\s*video,\s*canvas: sheet\.querySelector\("\.photo-cam__guide"\)/.test(cam) && /guide\.start\(\);/.test(cam) && /guide\.stop\(\);/.test(cam));
  check("§6.8b the photo try-on draws no lines", !/createBodyGuide|drawBodyGuide/.test(setModeOf(APP) + slice("async function runPhotoFit(source) {", "\nfunction setupFitMode()")) &&
    !/photoBodyGuide|photo-fit__guide/.test(HTML + CSS));
  const full = slice("async function photoShowsFullBody(canvas) {", "\n}\n");
  check("§6.9 a wide frame is also read in squares around the body (POSE FOCUS WINDOW)",
    /if \(w > h \* 1\.2\)/.test(full) && /for \(const cx of POSE_FOCUS_SCAN\)/.test(full));
}

console.log("\n── §7 the size estimate's camera: no timer, it shoots once the whole body holds ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
  const a = APP.indexOf("function openPhotoCamera() {");
  const cam = APP.slice(a, APP.indexOf("\nfunction setupPhotoEstimate()", a));
  check("§7.1 no countdown in the size estimate", !/PHOTO_CAM_TIMER_S|setInterval/.test(cam));
  check("§7.2 it captures only after the body has held in frame",
    /if \(v && v\.ok\) \{[\s\S]*?Date\.now\(\) - holdSince >= PHOTO_CAM_HOLD_MS\) capture\(\);/.test(cam));
  check("§7.3 any miss restarts the hold", /holdSince = null;\s*setState\("searching"\);/.test(cam));
  check("§7.4 a guide that cannot see falls back to a plain button (§2.5)",
    /setTimeout\(\(\) => \{\s*if \(done \|\| answered\) return;\s*shoot\.hidden = false;/.test(cam));
  check("§7.5 it tells the shopper to step back", /say\(hint, "photoCamHint"\)/.test(cam));
  check("§7.6 the animations are there and respect reduced motion",
    /@keyframes pc-step-back/.test(CSS) && /@keyframes pc-hold/.test(CSS) && /@keyframes pc-flash/.test(CSS) &&
    /prefers-reduced-motion: reduce\) \{\s*\.photo-cam__ghost \{ animation: none;/.test(CSS));
  check("§7.7 the camera stream stops on close", /guide\.stop\(\);\s*stream\.getTracks\(\)\.forEach\(\(tr\) => tr\.stop\(\)\);/.test(cam));
}

console.log("\n── §8 a result stays until the garment changes ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const rag = APP.slice(APP.indexOf("function renderActiveGarment() {"), APP.indexOf("function renderActiveGarment() {") + 900);
  check("§8.1 a repaint clears only a stale result", /clearPhotoFitIfStale\(\)/.test(rag) && !/typeof clearPhotoFit === "function"\) clearPhotoFit\(\)/.test(rag));
  check("§8.2 stale means made for a different garment",
    /function clearPhotoFitIfStale\(\) \{\s*if \(_photoFitFor !== null && _photoFitFor !== photoFitLookKey\(\)\) clearPhotoFit\(\);/.test(APP));
  check("§8.3 the result remembers the garment it was made for, read before the wait", /const forLook = photoFitLookKey\(\);/.test(APP) && /_photoFitFor = forLook;/.test(APP));
}

console.log("\n── §9 a slow line still gets its photo checked ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const ms = Number((/const PHOTO_FULL_BODY_LOAD_MS = ([\d_]+);/.exec(APP) || [])[1]?.replace(/_/g, ""));
  check("§9.1 the check waits long enough for a ~15 MB model on a ~1 MB/s line", ms >= 30000, ms);
  const setMode = APP.slice(APP.indexOf("function setFitMode(mode) {"), APP.indexOf("\n}\n", APP.indexOf("function setFitMode(mode) {")));
  check("§9.2 photo mode starts the model's load", /else if \(typeof loadPoseLandmarker === "function"\) loadPoseLandmarker\(\);/.test(setMode));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("photo-tryon: all checks passed.");
