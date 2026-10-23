/* ESTIMATE FROM A PHOTO - height and weight, never the size, never a block.

   lib/body-estimate.js turns one photo into editable numbers for Screen 1 - height and
   weight, and the optional chest / waist / leg length. The
   contract this suite holds it to:
     §1 the request: only a usable data: URL image goes anywhere; typed numbers are KNOWN.
     §2 the answer: no person / low confidence / out of range fills nothing; a known
        height comes back unchanged; whole numbers.
     §3 the call: never rejects - no key, a throttle, a network error, an unreadable body
        all answer ok:false; a known height reaches the model as the scale.
     §4 the room: fills only empty fields, never picks the size itself, never names the
        model in shipped text, and the file inputs are not wired as measurements; the
        menu offers camera / photo / file and the camera stream is stopped on close. */

import { readFileSync } from "node:fs";
import {
  sanitizeBodyEstimateRequest, normalizeBodyEstimate, estimateBodyFromPhoto, MIN_CONFIDENCE,
} from "../lib/body-estimate.js";

let fails = 0;
function check(label, cond, detail) {
  if (cond) console.log("  ✓ " + label);
  else { fails++; console.log("  ✗ " + label + (detail !== undefined ? "  → " + JSON.stringify(detail) : "")); }
}

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

console.log("\n── §1 the request ──");
{
  const r = sanitizeBodyEstimateRequest({ image: IMG, height: "178", weight: 74, gender: "men" });
  check("§1.1 a jpeg data URL is accepted", r.image && r.image.mimeType === "image/jpeg" && r.image.base64 === "/9j/4AAQSkZJRg==", r.image);
  check("§1.2 typed numbers are kept as known", r.height === 178 && r.weight === 74, r);
  check("§1.3 gender passes through", r.gender === "men");
  check("§1.4 a URL is not an image", sanitizeBodyEstimateRequest({ image: "https://x/y.jpg" }).image === null);
  check("§1.5 a non-image type is refused", sanitizeBodyEstimateRequest({ image: "data:text/html;base64,PGI+" }).image === null);
  check("§1.6 an oversize image is refused",
    sanitizeBodyEstimateRequest({ image: "data:image/jpeg;base64," + "A".repeat(3_000_001) }).image === null);
  const bad = sanitizeBodyEstimateRequest({ image: IMG, height: 999, weight: "x", gender: "other" });
  check("§1.7 out-of-range / junk fields become null", bad.height === null && bad.weight === null && bad.gender === null, bad);
  check("§1.8 no body at all is safe", sanitizeBodyEstimateRequest(undefined).image === null);
}

console.log("\n── §2 the answer ──");
{
  const good = { person_visible: true, height_cm: 177.6, weight_kg: 73.4, confidence: 0.8 };
  const r = normalizeBodyEstimate(good);
  check("§2.1 a confident reading rounds to whole cm / kg", r.ok && r.height === 178 && r.weight === 73, r);
  check("§2.2 no person fills nothing", normalizeBodyEstimate({ ...good, person_visible: false }).reason === "no_person");
  check("§2.3 a missing person flag fills nothing", normalizeBodyEstimate({ height_cm: 170, weight_kg: 70, confidence: 1 }).ok === false);
  check("§2.4 low confidence fills nothing",
    normalizeBodyEstimate({ ...good, confidence: MIN_CONFIDENCE - 0.01 }).reason === "low_confidence");
  check("§2.5 an implausible height fills nothing", normalizeBodyEstimate({ ...good, height_cm: 300 }).reason === "out_of_range");
  check("§2.6 an implausible weight fills nothing", normalizeBodyEstimate({ ...good, weight_kg: 5 }).reason === "out_of_range");
  const k = normalizeBodyEstimate({ ...good, height_cm: 160 }, { height: 182 });
  check("§2.7 a known height comes back unchanged", k.ok && k.height === 182, k);
  check("§2.8 junk is no person", normalizeBodyEstimate(null).ok === false);
  const full = { ...good, full_body_visible: true, chest_cm: 98.4, waist_cm: 84, leg_length_cm: 103 };
  const o = normalizeBodyEstimate(full);
  check("§2.9 the optional three come back rounded", o.chest === 98 && o.waist === 84 && o.legs === 103, o);
  const none = normalizeBodyEstimate({ ...good, chest_cm: 0, waist_cm: 300 });
  check("§2.10 an unseen / implausible optional is null, the answer still ok",
    none.ok && none.chest === null && none.waist === null && none.legs === null, none);
  check("§2.11 leg length needs the whole body in frame",
    normalizeBodyEstimate({ ...full, full_body_visible: false }).legs === null);
  check("§2.12 a leg length out of proportion to the height is dropped",
    normalizeBodyEstimate({ ...full, leg_length_cm: 60 }).legs === null);
  const kept = normalizeBodyEstimate(full, { chest: 110, legs: 95 });
  check("§2.13 known optional values come back unchanged", kept.chest === 110 && kept.legs === 95, kept);
}

console.log("\n── §3 the call ──");
{
  const req = sanitizeBodyEstimateRequest({ image: IMG, height: 182, waist: 80, gender: "women" });
  const reply = (obj, status = 200) => async () => ({
    ok: status === 200, status,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
  });

  check("§3.1 no key → unconfigured, no call", (await estimateBodyFromPhoto(req, "", () => { throw new Error("called"); })).reason === "unconfigured");
  check("§3.2 no image → bad_image", (await estimateBodyFromPhoto({ image: null }, "k")).reason === "bad_image");
  check("§3.3 a throttle → rate_limited", (await estimateBodyFromPhoto(req, "k", reply({}, 429))).reason === "rate_limited");
  check("§3.4 an HTTP error → error", (await estimateBodyFromPhoto(req, "k", reply({}, 500))).reason === "error");
  check("§3.5 a network failure → error, not a rejection",
    (await estimateBodyFromPhoto(req, "k", async () => { throw new Error("offline"); })).reason === "error");
  check("§3.6 an unreadable body → error",
    (await estimateBodyFromPhoto(req, "k", async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }))).reason === "error");

  let sent = null;
  const ok = await estimateBodyFromPhoto(req, "k", async (url, init) => {
    sent = JSON.parse(init.body);
    return reply({ person_visible: true, height_cm: 170, weight_kg: 66, confidence: 0.7 })();
  });
  check("§3.7 a good reply fills, with the known height kept", ok.ok && ok.height === 182 && ok.weight === 66, ok);
  const text = sent?.contents?.[0]?.parts?.[0]?.text || "";
  check("§3.8 the known height reaches the model as the scale", /KNOWN_HEIGHT_CM: 182/.test(text), text);
  check("§3.8b a known optional value reaches it too, and comes back", /KNOWN_WAIST_CM: 80/.test(text) && ok.waist === 80, ok);
  check("§3.9 the photo is sent inline, as its own type", sent?.contents?.[0]?.parts?.[1]?.inline_data?.mime_type === "image/jpeg");
  check("§3.10 deterministic", sent?.generationConfig?.temperature === 0);
}

console.log("\n── §4 the room ──");
{
  const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8");
  const I18N = readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8");
  const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8");
  const start = APP.indexOf("function setupPhotoEstimate() {");
  const block = APP.slice(start, APP.indexOf("\n}\n", start));
  check("§4.1 setupPhotoEstimate() exists and is wired", start > 0 && /\n  setupPhotoEstimate\(\);/.test(APP));
  check("§4.2 it fills only a field that is still empty", /String\(el\.value \|\| ""\)\.trim\(\)/.test(block));
  check("§4.3 the size comes from calculateSize(), not from the estimate", /calculateSize\(\)/.test(block) && !/sizeResult/.test(block));
  check("§4.4 the file input is not wired as a measurement",
    APP.includes(`querySelectorAll('#sizeForm input:not([type="checkbox"]):not([type="file"])')`));
  const shipped = (I18N.match(/photoEstimate\w*:[^\n]*|estimateTag:[^\n]*/g) || []).join("\n") + block + HTML.slice(HTML.indexOf('id="photoEstimate"'), HTML.indexOf('id="photoEstimate"') + 1200);
  check("§4.5 no shipped word names the model (CLAUDE.md §2.24)", !/gemini|google/i.test(shipped));
  check("§4.6 the photo is never logged", !/console\.\w+\([^)]*\bimage\b/.test(block));
  check("§4.7 all five fields are estimated",
    /const PHOTO_ESTIMATE_FIELDS = \["height", "weight", "chest", "waist", "legs"\];/.test(APP) &&
    ["height", "weight", "chest", "waist", "legs"].every((id) => HTML.includes(`id="${id}EstimateTag"`)));
  check("§4.8 the menu offers camera, photo and file",
    ["camera", "photo", "file"].every((src) => HTML.includes(`data-source="${src}"`)));
  const cam = APP.slice(APP.indexOf("function openPhotoCamera() {"), APP.indexOf("function setupPhotoEstimate() {"));
  check("§4.9 the camera sheet stops its own stream and never touches the live camera",
    /stream\.getTracks\(\)\.forEach\(\(tr\) => tr\.stop\(\)\)/.test(cam) && !/localStream|#webcam|\$\("webcam"\)/.test(cam));
}

console.log("");
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("body-estimate: all checks passed.");
