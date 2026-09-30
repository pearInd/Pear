/* THE SOLO EXPERIMENT (?exp=solo, 2026-09-30) - "send ONE picture with the front and the back, say
   which is which, and let the engine switch by itself when I turn". See SOLO EXPERIMENT near LIVE_W
   in fitting-room/app.js and lib/solo-prompt.js.
   ─────────────────────────────────────────────────────────────────────────────
   §1  WITHOUT THE FLAG NOTHING CHANGES: the flag is off, the frame is the room's 512x288 at 10fps,
       the pinned SDK is loaded, and no hook takes a branch.
   §2  WITH IT: 1280x720 at 15fps and the vendor's current SDK by default; ?exp_hd=0, ?exp_fps=N and
       ?exp_sdk=old move one thing each; nonsense is ignored.
   §3  THE PROMPT FRAME (server): the vendor's "Substitute the ... garment with ..." form, the two
       halves named (front LEFT, back RIGHT), both prints, a plain back said as plain, bottoms,
       the 640-char cap (details give way, the frame never), and the no-description fallback.
   §4  THE DESCRIPTION CALL: front photo then back photo, deterministic; a 429 throws (never cached),
       an unreadable photo or a model error falls back, no key is "unconfigured".
   §5  THE WIRING: every dispatch path gets the one image and the one prompt, the orientation watcher
       is never armed, the endpoint caches only a real description, and the widget forwards only a
       short lowercase name.
   What no test here can see: whether the engine actually picks the right side. That is the
   experiment, and only a real session answers it. */
import { readFileSync } from "node:fs";
import { soloPromptFrom, soloPromptFor, garmentCropFrom, DESCRIBE_INSTRUCTION } from "../lib/solo-prompt.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CONFIG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8");
const fnSrc = (open) => { const i = APP.indexOf(open); return i === -1 ? "" : APP.slice(i, APP.indexOf("\n}\n", i) + 3); };

/* The flag block, run against a fake URL. */
const a = APP.indexOf("const PEAR_EXP_SOLO = (() => {");
const b = APP.indexOf("\n}\n", APP.indexOf("function liveFrameSpec()")) + 3;
const FLAGS = APP.slice(a, b);
const flags = (search) => new Function("location", "LIVE_W", "LIVE_H", "LIVE_INFERENCE_FPS",
  FLAGS + "\nreturn { PEAR_EXP_SOLO, SOLO_FRAME, SOLO_NEXT_SDK, spec: liveFrameSpec() };")({ search }, 512, 288, 10);

console.log("── §1 without the flag nothing changes ──");
{
  const f = flags("?pear_key=TEST");
  check("the flag is off without ?exp=solo", f.PEAR_EXP_SOLO === false && f.SOLO_NEXT_SDK === false);
  check("...the engine gets the room's own frame: 512x288 at 10fps", f.spec.w === 512 && f.spec.h === 288 && f.spec.fps === 10);
  check("...another experiment name is not this one", flags("?exp=other").PEAR_EXP_SOLO === false);
  check("the room's own resolution line is untouched", /const LIVE_W = 512, LIVE_H = 288;/.test(APP) && /const LIVE_INFERENCE_FPS\s+= 10;/.test(APP));
  check("the pinned SDK is still 0.1.5 and is what loads without the flag",
    /"https:\/\/esm\.sh\/@decartai\/sdk@0\.1\.5"/.test(CONFIG) &&
    /const nextOk = typeof SOLO_NEXT_SDK !== "undefined" && SOLO_NEXT_SDK && Array\.isArray\(SDK_NEXT_URLS\) &&/.test(APP) &&
    /const sdkUrls = nextOk \? SDK_NEXT_URLS : SDK_URLS;/.test(APP));
}

console.log("\n── §2 with the flag ──");
{
  const f = flags("?exp=solo");
  check("?exp=solo: 1280x720 at 15fps through the vendor's current SDK",
    f.PEAR_EXP_SOLO && f.spec.w === 1280 && f.spec.h === 720 && f.spec.fps === 15 && f.SOLO_NEXT_SDK === true);
  const lo = flags("?exp=solo&exp_hd=0");
  check("?exp_hd=0 keeps the room's 512x288 at 10fps", lo.spec.w === 512 && lo.spec.h === 288 && lo.spec.fps === 10);
  check("?exp_fps=20 moves only the rate", flags("?exp=solo&exp_fps=20").spec.fps === 20 && flags("?exp=solo&exp_fps=20").spec.w === 1280);
  check("...and a rate outside 5-30 is ignored", flags("?exp=solo&exp_fps=99").spec.fps === 15 && flags("?exp=solo&exp_fps=abc").spec.fps === 15);
  check("?exp_sdk=old keeps the pinned SDK", flags("?exp=solo&exp_sdk=old").SOLO_NEXT_SDK === false);
  check("the next SDK is 0.2.3 in config, and the build pins it against node_modules/decart-sdk-next",
    /SDK_NEXT_URLS:[\s\S]{0,300}"https:\/\/esm\.sh\/@decartai\/sdk@0\.2\.3"/.test(CONFIG) &&
    /node_modules\/decart-sdk-next\/package\.json/.test(readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8")));
}

console.log("\n── §3 the prompt frame ──");
{
  /* v2 (2026-09-30): the first measurement drew a LARGE black block for a SMALL rear print - so the
     description carries each print's size and place, and the back is the part that never gives way. */
  const OASIS = {
    garment: "oversized white cotton crew-neck t-shirt with dropped shoulders, short sleeves, boxy relaxed fit, hip-length hem",
    front: "a vertical red and blue stripe running down the center front, a black-outlined oval \"Knebworth\" logo across the chest, a small boxed \"oasis\" logo above it, the rest of the front is plain",
    back: "small print centered on the upper back, about a third of the width: \"10th & 11th Aug. 1996\" in black letters, below it a small black rectangular label with white \"oasis\" text, rest of the back plain",
  };
  const p = soloPromptFrom(OASIS, "top");
  console.log(`        (${p.length} chars) ${p}`);
  check("the vendor's form: \"Substitute the upper body garment with <what the photos show>\"",
    p.startsWith("Substitute the upper body garment with oversized white cotton crew-neck"));
  check("...the two halves are named: the front on the left, the back on the right",
    /The reference shows it from two sides: front on the left, back on the right\./.test(p));
  check("...and which side to show when",
    /Facing the camera, show the front: a vertical red and blue stripe/.test(p) &&
    /Back to the camera, show the back exactly as in the reference: small print centered on the upper back/.test(p));
  check("...the BACK survives the budget whole - its size, its text and its closing 'plain' clause",
    p.includes('small print centered on the upper back, about a third of the width: "10th & 11th Aug. 1996" in black letters, below it a small black rectangular label with white "oasis" text, rest of the back plain.'));
  check("...the FRONT gave way first, by whole clauses - never a phrase cut mid-way",
    /show the front: a vertical red and blue stripe running down the center front\. Back/.test(p));
  check("...the shopper's own lower body is kept", /Keep the person's own pants, legs and shoes\.$/.test(p));
  check("...within the wire cap (650), with no stray punctuation", p.length <= 640 && !/[,;:]\./.test(p), String(p.length));
  const plain = soloPromptFrom({ ...OASIS, back: "plain" }, "top");
  check("a plain back is said as plain, not as a print", /show the back exactly as in the reference, plain\./.test(plain));
  const pants = soloPromptFrom({ garment: "light blue wide-leg denim jeans, high waist, ankle-length", front: "plain", back: "two patch pockets" }, "bottom");
  check("bottoms: the lower body garment, and the shopper's own top is kept",
    pants.startsWith("Substitute the lower body garment with light blue") && /Keep the person's own top and shoes\.$/.test(pants));
  const long = soloPromptFrom({ garment: "w ".repeat(40), front: "front detail, ".repeat(20), back: "back detail, ".repeat(20) + "rest plain" }, "top");
  check("an over-long description is cut to fit - details give way, the frame and the back's 'plain' survive",
    long.length <= 640 && /front on the left, back on the right/.test(long) && /rest plain\. Keep the person's own pants, legs and shoes\.$/.test(long), `${long.length} ${long}`);
  const none = soloPromptFrom(null, "top");
  check("no description: the frame with a generic garment phrase",
    /Substitute the upper body garment with the garment exactly as shown in the reference image\./.test(none) && /front on the left/.test(none));

  /* The crop each side gets before stitching (v2): the OASIS rear photo's garment box. */
  const c = garmentCropFrom([344, 167, 856, 817], "top");
  check("a garment box becomes a crop: collar and hem in (thin margins), both sleeves in (wider)",
    c && c.y0 < 0.344 && c.y0 > 0.33 && c.y1 > 0.856 && c.y1 < 0.87 && c.x0 < 0.167 && c.x1 > 0.817, JSON.stringify(c));
  const c01 = garmentCropFrom([0.344, 0.167, 0.856, 0.817], "top");
  check("...a box on a 0-1 scale is read as one, not refused as tiny",
    c01 && Math.abs(c01.x0 - c.x0) < 1e-3 && Math.abs(c01.y1 - c.y1) < 1e-3, JSON.stringify(c01));
  check("...an unusable box is no crop: malformed, tiny, or keeping nearly the whole photo",
    garmentCropFrom(null, "top") === null && garmentCropFrom([1, 2, 3], "top") === null &&
    garmentCropFrom([400, 400, 450, 450], "top") === null && garmentCropFrom([0, 0, 1000, 1000], "top") === null);
}

console.log("\n── §4 the description call ──");
{
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const mk = ({ modelStatus = 200, imgType = "image/jpeg", answer = { garment: "white tee, hip-length", front: "a logo", back: "plain" } } = {}) => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), init });
      if (!String(url).includes("generativelanguage")) return { ok: true, status: 200, headers: { get: () => imgType }, arrayBuffer: async () => JPEG.buffer };
      return { ok: modelStatus === 200, status: modelStatus,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) };
    };
    return { fetchImpl, seen };
  };
  const ok = mk();
  const r = await soloPromptFor({ front: "http://cdn.example.com/1.jpg", back: "https://cdn.example.com/3.jpg", region: "top" }, "k", { fetchImpl: ok.fetchImpl });
  check("a description comes back as a prompt, marked as the model's", r.source === "gemini" && /white tee, hip-length/.test(r.prompt));
  const withBoxes = await soloPromptFor({ front: "https://a/1.jpg", back: "https://a/3.jpg", region: "top" }, "k",
    { fetchImpl: mk({ answer: { garment: "white tee", front: "logo", back: "plain", front_box: [335, 170, 905, 850], back_box: [344, 167, 856, 817] } }).fetchImpl });
  check("...with each photo's garment crop from the same call, and the raw boxes beside them",
    withBoxes.crops && withBoxes.crops.front && withBoxes.crops.back && withBoxes.crops.back.y1 > 0.856 &&
    withBoxes.boxes && withBoxes.boxes.back.join() === "344,167,856,817");
  const sentSchema = JSON.parse(ok.seen[2].init.body).generationConfig.responseSchema;
  check("...and both boxes are REQUIRED in the answer's schema",
    ["front_box", "back_box"].every((k) => sentSchema.required.includes(k)));
  check("...and the model is asked for each print's SIZE and PLACE, and for both garment boxes",
    /SIZE relative to the garment/.test(DESCRIBE_INSTRUCTION) && /PLACE/.test(DESCRIBE_INSTRUCTION) &&
    /front_box/.test(DESCRIBE_INSTRUCTION) && /back_box/.test(DESCRIBE_INSTRUCTION) && /small label must never read as a large block/.test(DESCRIBE_INSTRUCTION) &&
    /from TOP to BOTTOM/.test(DESCRIBE_INSTRUCTION) && /which text sits inside which shape/.test(DESCRIBE_INSTRUCTION));
  check("the FRONT photo is fetched first (over https), then the BACK", ok.seen[0].url === "https://cdn.example.com/1.jpg" && ok.seen[1].url === "https://cdn.example.com/3.jpg");
  const body = JSON.parse(ok.seen[2].init.body);
  check("the model is told image 1 is the front and image 2 the back, deterministically",
    /Image 1 is the FRONT, image 2 is the BACK/.test(body.contents[0].parts[0].text) && body.generationConfig.temperature === 0 &&
    body.systemInstruction.parts[0].text === DESCRIBE_INSTRUCTION && /where\s+the hem falls on the body/.test(DESCRIBE_INSTRUCTION));
  let threw = null;
  try { await soloPromptFor({ front: "https://a/1.jpg", back: "https://a/3.jpg" }, "k", { fetchImpl: mk({ modelStatus: 429 }).fetchImpl }); } catch (e) { threw = e; }
  check("a rate limit THROWS (never cached as an answer)", threw && threw.rateLimited === true);
  const e500 = await soloPromptFor({ front: "https://a/1.jpg", back: "https://a/3.jpg" }, "k", { fetchImpl: mk({ modelStatus: 500 }).fetchImpl });
  const html = await soloPromptFor({ front: "https://a/1.jpg", back: "https://a/3.jpg" }, "k", { fetchImpl: mk({ imgType: "text/html" }).fetchImpl });
  check("a model error or a photo that is not an image falls back to the frame", e500.source === "fallback" && html.source === "fallback" && /exactly as shown/.test(e500.prompt));
  const nokey = await soloPromptFor({ front: "https://a/1.jpg", back: "https://a/3.jpg" }, "", { fetchImpl: ok.fetchImpl });
  check("no key: 'unconfigured', the frame, nothing fetched", nokey.source === "unconfigured" && ok.seen.length === 3);
}

console.log("\n── §5 the wiring ──");
{
  check("wirePrompt(): the experiment's one prompt for every angle and pose, before anything else",
    /function wirePrompt\(item, angle, where, opts = \{\}\) \{\n[^\n]*\n\s*if \(typeof soloActiveFor === "function" && soloActiveFor\(item\)\) return soloPrompt\(item\);/.test(APP));
  const ref = fnSrc("async function referenceImageFor(");
  check("referenceImageFor(): the one front|back image, ahead of every other reference",
    ref.indexOf("soloComposite(item)") !== -1 && ref.indexOf("soloComposite(item)") < ref.indexOf("compositeActiveFor(item)"));
  const init = fnSrc("async function resolveInitialConditioning(item) {");
  check("the session's first image (and every reconnect's) is the front|back image",
    /const soloJob = typeof soloActiveFor === "function" && soloActiveFor\(item\) \? soloComposite\(item\) : null;/.test(init) &&
    /Promise\.resolve\(soloJob \|\| garmentBlobCached\(primary\)\)/.test(init));
  const fb = fnSrc("async function applyFallbackConditioning() {");
  check("...and so is the recovery path's", /soloActiveFor\(item\)\) \{\s*\n\s*const solo = await soloComposite\(item\)/.test(fb));
  const sync = fnSrc("function syncOrientationWatcher() {");
  check("the orientation watcher is never armed in the experiment - no swap, no profile, no re-anchor",
    /const want = \(dualView \|\| singleView\) && isLive\(\) && !!localStream && !solo;/.test(sync));
  const active = fnSrc("function soloActiveFor(item) {");
  check("the experiment runs only for a single garment with a real distinct back",
    /PEAR_EXP_SOLO/.test(active) && /resolveLook\(\)/.test(active) && /!!distinctBackOf\(item\)/.test(active));
  const comp = fnSrc("function soloComposite(item) {");
  check("the image: front LEFT, back RIGHT, white between, nothing written on it, memoised per item",
    /ctx\.drawImage\(front, rf\.sx, rf\.sy, rf\.sw, rf\.sh, 0, 0, wf, H\);/.test(comp) &&
    /ctx\.drawImage\(back, rb\.sx, rb\.sy, rb\.sw, rb\.sh, wf \+ SOLO_GAP, 0, wb, H\);/.test(comp) &&
    !/fillText|strokeText/.test(comp) && /_soloComposites\.set\(item, job\)/.test(comp));
  check("...a missing box on one side of a same-size pair borrows the other side's crop",
    /const samePair = front\.width === back\.width && front\.height === back\.height;/.test(comp) &&
    /const cf = crops\.front \|\| \(samePair \? crops\.back : null\), cb = crops\.back \|\| \(samePair \? crops\.front : null\);/.test(comp));
  check("...each side cut to its garment when the server sent a crop, whole when it did not",
    /soloAnswer\(item\)/.test(comp) && /const crops = \(answer && answer\.crops\) \|\| \{\};/.test(comp) &&
    /: \{ sx: 0, sy: 0, sw: bmp\.width, sh: bmp\.height, cut: false \}/.test(comp));
  const sa = fnSrc("function soloAnswer(item) {");
  const sp = fnSrc("async function soloPrompt(item) {");
  check("the prompt never rejects: no answer falls back to the room's own front prompt",
    /return requestWirePrompt\(\{ kind: "single"/.test(sp) && /catch \(e\) \{[\s\S]*?return null;/.test(sa));
  check("...a failure is re-asked at most every SOLO_PROMPT_RETRY_MS, never on every dispatch; v2 of the answer",
    /job\.fallbackAt = Date\.now\(\);/.test(sa) && /known\.fallbackAt && Date\.now\(\) - known\.fallbackAt > SOLO_PROMPT_RETRY_MS/.test(sa) &&
    /&v=4`/.test(sa));
  const route = SERVER.slice(SERVER.indexOf('app.get("/api/solo-prompt"'), SERVER.indexOf("\n});\n", SERVER.indexOf('app.get("/api/solo-prompt"')));
  check("the endpoint takes public photos only and caches only a real description",
    /publicImageUrl\(front\)/.test(route) && /if \(out\.source === "gemini"\) \{[\s\S]*?s-maxage[\s\S]*?\} else \{\s*\n\s*res\.setHeader\("Cache-Control", "no-store"\);/.test(route));
  check("the widget forwards data-pear-exp - a short lowercase name only",
    /var EXP = \/\^\[a-z0-9-\]\{1,24\}\$\/\.test\(EXP_RAW\) \? EXP_RAW : "";/.test(WIDGET) && /\(EXP \? "&exp=" \+ EXP : ""\)/.test(WIDGET));
  const re = /^[a-z0-9-]{1,24}$/;
  check("...so a crafted value cannot inject parameters", !re.test("solo&pear_key=x") && !re.test("SOLO") && re.test("solo"));
}

console.log("\n── §6 the next SDK renders in the bundle, and a failure never repeats ──");
{
  /* REPORTED 2026-09-30, the first ?exp=solo session: "the connection produced no image". 0.2.x wraps
     every frame in a transform run by a Worker loaded from ./frame-metadata-worker.js next to the SDK
     module - a file the bundle does not ship (404), so no frame reached the engine. The CDN build
     never takes that path (its worker URL is cross-origin); the bundle is patched to answer the same. */
  const BUILD = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  check("the build switches the next SDK's frame-metadata worker off, and fails if the patch stops applying",
    /plugins: \[noFrameMetadataWorker\]/.test(BUILD) &&
    /"function isFrameMetadataRuntimeSupported\(\) \{\\n\\treturn false;"/.test(BUILD) &&
    /if \(!frameMetadataPatched\) fail\(/.test(BUILD) && /if \(patched === src\) fail\(/.test(BUILD));
  const guard = APP.slice(APP.indexOf('console.warn("[PEAR] No first frame within "'), APP.indexOf('showCamError("החיבור לא הניב תמונה - נסה שוב.");'));
  check("a next-SDK session that never renders switches this page to the pinned SDK for the retry",
    /_sdkInUse === "next" && typeof markSoloNextSdkFailed === "function"\) \{\s*\n\s*markSoloNextSdkFailed\(\);/.test(guard) &&
    /!\(typeof soloNextSdkFailed === "function" && soloNextSdkFailed\(\)\)/.test(APP));
  /* Run the switch for real. */
  const blk = APP.slice(APP.indexOf('let _sdkInUse = "pinned";'), APP.indexOf("\n}\n", APP.indexOf("function markSoloNextSdkFailed()")) + 3);
  const store = new Map();
  const sw = new Function("sessionStorage", blk + "\nreturn { soloNextSdkFailed, markSoloNextSdkFailed };")(
    { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
  const before = sw.soloNextSdkFailed();
  sw.markSoloNextSdkFailed();
  check("...the switch starts off, flips once, and survives a reload of the room (sessionStorage)",
    before === false && sw.soloNextSdkFailed() === true && store.get("pear_solo_next_sdk_failed") === "1");
}

console.log(fails === 0 ? "\nsolo-experiment: OK" : `\nsolo-experiment: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
