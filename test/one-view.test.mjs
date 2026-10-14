/* ONE GARMENT, ONE REFERENCE - a top plain on both sides is sent once (2026-10-14, CLAUDE.md §2.48)
   ─────────────────────────────────────────────────────────────────────────────
   "It jumped - I want it to stay one shirt, not go up and down while I measure" (FOX V-neck tee 1919148300). The shirt
   changed cut when the BACK photo went out and again when the FRONT came back: the engine re-fits the garment to every new
   reference. A garment plain on both sides gains nothing from its back photo, so it goes as one reference - the front-only
   run every product without a back photo takes - and is not re-draped. On positive evidence only:
     §1  oneReferenceWillDo(), the real one: the reported garment qualifies, and every single missing count keeps the swap,
         by name;
     §2  the preload gate: a "yes" is a front-only run marked oneView; a "no" changes nothing;
     §3  go-live: no "back view unavailable" toast for a chosen front-only run, and the garment is remembered;
     §4  no re-drape for that garment - and the same re-drape as before for any other;
     §5  the plumbing: the classifier's front verdict (server -> widget -> room) and the engine's plainKnit verdict
         (promptAnswerFor, every /prompt answer), read by the room from the prompt reply.
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WORKER = readFileSync(new URL("../cloudflare/orient/src/worker.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function between(src, start, end) {
  const s = src.indexOf(start);
  if (s === -1) throw new Error(`could not find "${start}"`);
  const e = src.indexOf(end, s);
  if (e === -1) throw new Error(`could not find "${end}" after "${start}"`);
  return src.slice(s, e);
}

console.log("── §1 oneReferenceWillDo(): every count, on positive evidence ──");
const decideSrc = between(APP, "const ONE_VIEW_COLOUR_MAX_L1", "\n/* ── Context-Aware Asset Switching - pre-cached");
/* A Blob stand-in that carries its colour and whether it measures a graphic; the canvas stand-in paints that colour. */
const blob = (rgb, printed = false) => ({ rgb, printed });
function decide(item, front, back, { search = "", knit = true, look = null, bottoms = false, promptFails = false } = {}) {
  const verdicts = new Map();
  const sandbox = {
    location: { search },
    resolveLook: () => look,
    isBottomsGarment: () => bottoms,
    promptFactsOf: (it) => ({ name: it.name }),
    _plainKnitVerdicts: verdicts,
    wirePrompt: async (it) => {
      if (promptFails) throw new Error("no service");
      if (knit !== undefined) verdicts.set(JSON.stringify({ name: it.name }), knit);
      return "prompt";
    },
    blobLooksPrinted: async (b) => !!(b && b.printed),
    createImageBitmap: async (b) => ({ width: 100, height: 100, rgb: b.rgb, close() {} }),
    OffscreenCanvas: class {
      constructor(w, h) { this.w = w; this.h = h; }
      getContext() {
        const self = this;
        return {
          drawImage(bmp) { self.rgb = bmp.rgb; },
          getImageData() {
            const d = new Uint8ClampedArray(self.w * self.h * 4);
            for (let i = 0; i < d.length; i += 4) { d[i] = self.rgb[0]; d[i + 1] = self.rgb[1]; d[i + 2] = self.rgb[2]; d[i + 3] = 255; }
            return { data: d };
          },
        };
      }
    },
    document: undefined,
  };
  const fn = new Function(...Object.keys(sandbox), decideSrc + "\nreturn oneReferenceWillDo;")(...Object.values(sandbox));
  return fn(item, front, back);
}
const ORANGE = [232, 145, 90], ORANGE_BACK = [226, 140, 88], NAVY = [30, 58, 138];
const TEE = { name: "טישרט בייסיק צווארון V", frontIsPlain: true, backIsPlain: true, textOcr: "" };
{
  const r = await decide(TEE, blob(ORANGE), blob(ORANGE_BACK));
  check("the reported tee - plain both sides, a plain knit top, one fabric colour - goes as one reference",
    r.ok === true && r.why === "plain-both", JSON.stringify(r));
  const cases = [
    ["?one_view=0 keeps the swap", [TEE, blob(ORANGE), blob(ORANGE_BACK), { search: "?one_view=0" }], "off"],
    ["a full look keeps both halves' views", [TEE, blob(ORANGE), blob(ORANGE_BACK), { look: { top: {}, bottom: {} } }], "look"],
    ["a lower-body garment keeps its back (pockets, a waistband: what the front photo does not show)",
      [TEE, blob(ORANGE), blob(ORANGE_BACK), { bottoms: true }], "bottoms"],
    ["no classifier verdict on the front", [{ ...TEE, frontIsPlain: undefined }, blob(ORANGE), blob(ORANGE_BACK)], "front-unproven"],
    ["a front graphic", [{ ...TEE, frontIsPlain: false }, blob(ORANGE), blob(ORANGE_BACK)], "front-unproven"],
    ["no classifier verdict on the back", [{ ...TEE, backIsPlain: undefined }, blob(ORANGE), blob(ORANGE_BACK)], "back-unproven"],
    ["a rear print", [{ ...TEE, backIsPlain: false }, blob(ORANGE), blob(ORANGE_BACK)], "back-unproven"],
    ["lettering on the front", [{ ...TEE, textOcr: "PEAK" }, blob(ORANGE), blob(ORANGE_BACK)], "front-text"],
    ["the rear photo measures a graphic", [{ ...TEE, _backLooksPrinted: true }, blob(ORANGE), blob(ORANGE_BACK)], "back-pixels"],
    ["a closure or a hood (the engine's construction verdict says no)", [TEE, blob(ORANGE), blob(ORANGE_BACK), { knit: false }], "construction"],
    ["no construction verdict (an older edge, the service down)", [TEE, blob(ORANGE), blob(ORANGE_BACK), { promptFails: true }], "no-verdict"],
    ["the front photo measures a graphic", [TEE, blob(ORANGE, true), blob(ORANGE_BACK)], "front-pixels"],
    ["the two photos are different colours", [TEE, blob(ORANGE), blob(NAVY)], "colour-"],
    ["no back photo at all", [TEE, blob(ORANGE), null], "no-pair"],
  ];
  for (const [label, args, why] of cases) {
    const v = await decide(...args);
    check(`keeps the swap: ${label}`, v.ok === false && v.why.startsWith(why), JSON.stringify(v));
  }
  check("the colour bar is the fabric-colour agreement, not a guess",
    /const ONE_VIEW_COLOUR_MAX_L1 = 60;/.test(APP));
}

console.log("\n── §2 the preload gate ──");
const preloadSrc = between(APP, "async function preloadGarmentAssets", "/* ── Context-Aware Asset Switching - OrientationWatcher");
async function preload(verdict) {
  const traced = [];
  const sandbox = {
    activeItem: { name: "Tee", img: "https://cdn.test/front.jpg" },
    resolveLook: () => null,
    galleryOf: (item) => ({ front: item.img, back: "https://cdn.test/back.jpg" }),
    distinctBackOf: () => "https://cdn.test/back.jpg",
    $: () => null,
    garmentBlobCached: async (url) => (url.endsWith("front.jpg") ? "FRONT_BLOB" : "BACK_BLOB"),
    createImageBitmap: async () => ({ close() {} }),
    blobLooksFlat: async () => false,
    _assetBlobCache: { delete() {} },
    compositeActiveFor: () => false,
    createGarmentComposite: async () => null,
    oneReferenceWillDo: verdict === undefined ? undefined : async (item, f, b) => ({ ...verdict, args: [f, b] }),
    traceOrient: (k, v) => traced.push([k, v]),
    console: { log() {}, warn() {}, error() {} },
  };
  const r = await new Function(...Object.keys(sandbox), preloadSrc + "\nreturn preloadGarmentAssets();")(...Object.values(sandbox));
  return { r, traced };
}
{
  const yes = await preload({ ok: true, why: "plain-both" });
  check("a yes is a front-only run, marked as chosen", yes.r.ok === true && yes.r.hasBack === false && yes.r.oneView === true, JSON.stringify(yes.r));
  check("...and the TEST record says so, with the reason", JSON.stringify(yes.traced).includes('["one-view",{"on":true,"why":"plain-both"}]'),
    JSON.stringify(yes.traced));
  const no = await preload({ ok: false, why: "front-text" });
  check("a no changes nothing - both photos stay", no.r.ok === true && no.r.hasBack === true && no.r.oneView === false, JSON.stringify(no.r));
  check("...recorded with the count that failed", JSON.stringify(no.traced).includes('["one-view",{"on":false,"why":"front-text"}]'));
  const absent = await preload(undefined);
  check("run standalone (the helper absent) it is the old gate exactly", absent.r.hasBack === true && absent.r.oneView === false);
}

console.log("\n── §3 go-live ──");
{
  check("no 'back view unavailable' toast when the front-only run was chosen",
    /if \(wantedAutoView && !preload\.oneView\) toast\("תצוגת הגב אינה זמינה/.test(APP));
  check("...the garment is remembered for the session, and forgotten when the next run is not one-view",
    /_oneViewItem = preload\.oneView \? activeItem : null;/.test(APP));
  check("every go-live derives the mode afresh before the gate decides (a chosen front-only run never sticks)",
    APP.indexOf("currentAngle = canCombineViews(activeItem) ? AUTO_ANGLE : \"front\";", APP.indexOf("const wantedAutoView")) === -1 &&
    APP.lastIndexOf("currentAngle = canCombineViews(activeItem) ? AUTO_ANGLE : \"front\";", APP.indexOf("const wantedAutoView")) !== -1);
}

console.log("\n── §4 no re-drape for the one-reference garment ──");
{
  const redrapeSrc = between(APP, "async function reconditionForTopology(step) {", "\n}\n") + "\n}\n";
  async function redrape(oneViewItem, active) {
    const traced = [];
    const sandbox = {
      topologyReconditionInFlight: false, isLive: () => true, isGarmentApplied: true, _orientHoldActive: false,
      currentAngle: "front", AUTO_ANGLE: "auto", _oneViewItem: oneViewItem, activeItem: active,
      traceOrient: (k, v) => traced.push([k, v]),
      wireBusy: () => true,   // the first thing a real re-drape does after the guards: defers, so nothing is sent here
      console: { log() {}, warn() {} },
    };
    await new Function(...Object.keys(sandbox), redrapeSrc + "\nreturn reconditionForTopology;")(...Object.values(sandbox))({ reason: "rotation", delta: {} });
    return traced;
  }
  const tee = { name: "tee" };
  const skipped = await redrape(tee, tee);
  check("the one-reference garment is not re-uploaded on movement", JSON.stringify(skipped) === '[["redrape-skip",{"reason":"rotation","one":true}]]',
    JSON.stringify(skipped));
  const other = await redrape(tee, { name: "another garment" });
  check("any other single-view garment re-drapes as before", JSON.stringify(other) === '[["redrape",{"reason":"rotation"}]]', JSON.stringify(other));
  const none = await redrape(null, tee);
  check("...and so does a session that is not one-view", JSON.stringify(none) === '[["redrape",{"reason":"rotation"}]]', JSON.stringify(none));
}

console.log("\n── §5 the plumbing ──");
{
  check("server: front_is_plain from the resolved FRONT record's has_graphic - true only on an explicit false, null when nobody looked",
    /const front_is_plain = _frontRec && _frontRec\.has_graphic === false \? true\s*\n\s*: _frontRec && _frontRec\.has_graphic === true \? false : null;/.test(SERVER) &&
    /\n\s*front_is_plain,\n\s*\}\);/.test(SERVER));
  check("widget: forwarded only as a real boolean (an unknown is omitted, so the room abstains)",
    /frontIsPlain: \(data && typeof data\.front_is_plain === "boolean"\) \? data\.front_is_plain : null/.test(WIDGET) &&
    /garment_front_is_plain: typeof res\.frontIsPlain === "boolean" \? res\.frontIsPlain : undefined/.test(WIDGET));
  check("room: kept with the garment's other facts, whether or not its photos changed",
    /if \(typeof e\.data\.garment_front_is_plain === "boolean"\) target\.frontIsPlain = e\.data\.garment_front_is_plain;\s*\n\s*const unchanged =/.test(APP));
  check("...and it is not a prompt fact - only this mode reads it",
    !/frontIsPlain/.test(between(APP, "const PROMPT_FACT_STRINGS = [", "\n/* Wire prompts by request")));
  check("room: the construction verdict is read from the prompt reply, by the facts it was asked about",
    /_plainKnitVerdicts\.set\(JSON\.stringify\(body\.item\), data\.plainKnit\);/.test(APP));
  check("every /prompt answer is promptAnswerFor() - server and edge alike",
    /res\.json\(promptAnswerFor\(sanitizePromptRequest\(req\.body\)\)\);/.test(SERVER) &&
    /return json\(promptAnswerFor\(sanitizePromptRequest\(body\)\)\);/.test(WORKER));
  const PR = await import("../lib/prompts.js");
  const ans = (item, kind = "single") => PR.promptAnswerFor(PR.sanitizePromptRequest({ kind, item, angle: "front", delta: 0 }));
  const a = ans({ name: "טישרט בייסיק צווארון V", type: "shirt", __bottoms: false });
  check("promptAnswerFor: the reported tee is a plain knit top, and the prompt is the same string as before",
    a.plainKnit === true && a.prompt === PR.promptForRequest(PR.sanitizePromptRequest({ kind: "single", item: { name: "טישרט בייסיק צווארון V", type: "shirt", __bottoms: false }, angle: "front", delta: 0 })));
  check("...a button-down, a zip hoodie and a polo are not (their front closure would be drawn on the back)",
    [ "Oxford Button-Down Shirt", "Zip Hoodie Tee", "Classic Polo" ].every((name) => ans({ name, type: "shirt", __bottoms: false }).plainKnit === false));
  check("...nor a lower-body garment, nor the full look",
    ans({ name: "Basic Tee Shorts", __bottoms: true }).plainKnit === false && ans({}, "look").plainKnit === false);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
