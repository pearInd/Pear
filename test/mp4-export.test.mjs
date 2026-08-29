/* Forced-MP4 export for the recorded try-on clip.

   The clip used to be recorded in whatever container the PLATFORM was guessed to
   prefer: MP4 first on mobile, WebM first on desktop. That split is what this suite
   removes and pins removed. WebM out of MediaRecorder carries no top-level duration,
   so players report a bogus length (the "broken 14-second clip"), and a .webm is a
   dead file in most desktop editors and phone galleries alike. MP4 is now asked for
   FIRST on every platform, and WebM survives only as the fallback for hosts that
   cannot record MP4 at all (Firefox, older Chromium) - because a .webm still beats
   no clip.

   The subtle part, and the reason pickRecorderMimes() returns an ORDERED LIST rather
   than a single pick: isTypeSupported() answers a codec question, NOT "will the
   constructor accept this type for THIS stream". The leading candidate names an audio
   codec (mp4a.40.2) while the recorded stream is a video-only canvas capture, so an
   engine may approve it and still throw on construction. The old code had a single
   try/catch around one pick and gave up recording entirely on a throw - which would
   have traded "MP4" for "no clip at all". §1 runs the REAL selection code and the REAL
   constructor loop, lifted out of app.js, against simulated engines to prove every
   rejection path still ends with a recorder.

   §3 covers the second half of "it downloads as .mp4": the extension is only correct
   if the Blob actually carries the negotiated container, and if a SAVED gallery clip
   remembers its OWN container. Reading the live session's recorderMime at gallery-
   download time is wrong - clearRecording() nulls it when the next session starts, so
   a clip recorded as MP4 downloaded .webm. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* Lift a whole function out of app.js by brace-matching, so these tests execute the
   SHIPPING code rather than a paraphrase of it that can drift away from it. */
function lift(signature) {
  const i = APP.indexOf(signature);
  if (i < 0) throw new Error("not found in app.js: " + signature);
  let depth = 0;
  for (let k = APP.indexOf("{", i); k < APP.length; k++) {
    if (APP[k] === "{") depth++;
    else if (APP[k] === "}" && --depth === 0) return APP.slice(i, k + 1);
  }
  throw new Error("unbalanced braces: " + signature);
}

const MP4_LEAD = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
const ALL_MP4  = [MP4_LEAD, "video/mp4", "video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=h264"];
const ALL_WEBM = ["video/webm;codecs=vp8", "video/webm", "video/webm;codecs=vp9"];

console.log("── §1 MP4 IS ASKED FOR FIRST, AND A REJECTION NEVER COSTS THE CLIP ──");
{
  const picker = lift("function pickRecorderMimes()");
  // The constructor loop lives inside startRecording()'s beginRecorder closure, so it
  // is sliced by its own landmarks rather than brace-matched.
  const loop = APP.slice(APP.indexOf("    let chosen = null;"),
                         APP.indexOf("    recorderMime = (mediaRecorder.mimeType"));
  check("the constructor loop drives pickRecorderMimes()", loop.includes("pickRecorderMimes()"), loop);

  /* env.supported → what isTypeSupported() approves; env.constructThrows → what the
     constructor rejects anyway. Returns the mimeType actually negotiated, or null if
     the loop gave up (which must never happen while a default constructor works). */
  function negotiate(env) {
    const FakeRecorder = function (stream, opts) {
      const m = opts && opts.mimeType;
      if (m && (env.constructThrows || []).includes(m)) {
        const e = new Error("NotSupportedError"); e.name = "NotSupportedError"; throw e;
      }
      this.mimeType = m || env.defaultMime || "video/webm";
    };
    FakeRecorder.isTypeSupported = (t) => env.supported.includes(t);
    return new Function("MediaRecorder", "console", "stopPaintLoop", `
      ${picker}
      let mediaRecorder = null;
      const captured = {};
${loop}
      return mediaRecorder ? (mediaRecorder.mimeType || chosen) : null;
    `)(FakeRecorder, { warn() {} }, () => {});
  }

  check("Chromium-like (records both): takes H.264+AAC MP4, not WebM",
    negotiate({ supported: [...ALL_MP4, ...ALL_WEBM] }) === MP4_LEAD);
  check("desktop is NOT special-cased back to WebM - the platform branch is gone",
    negotiate({ supported: [...ALL_MP4, ...ALL_WEBM] }) === MP4_LEAD);
  check("engine advertising only the bare container: takes video/mp4",
    negotiate({ supported: ["video/mp4", ...ALL_WEBM] }) === "video/mp4");
  check("Safari-like (MP4 only): stays on MP4",
    negotiate({ supported: ALL_MP4 }) === MP4_LEAD);
  check("Firefox-like (cannot record MP4): falls back to VP8/WebM rather than failing",
    negotiate({ supported: ALL_WEBM }) === "video/webm;codecs=vp8");

  check("approved-then-rejected AAC type on a video-only stream: walks on to video/mp4",
    negotiate({ supported: [...ALL_MP4, ...ALL_WEBM], constructThrows: [MP4_LEAD] }) === "video/mp4");
  check("every MP4 rejected at construction: still lands on WebM, not on nothing",
    negotiate({ supported: [...ALL_MP4, ...ALL_WEBM], constructThrows: ALL_MP4 }) === "video/webm;codecs=vp8");
  check("nothing advertised at all: constructs with the browser default, still records",
    negotiate({ supported: [], defaultMime: "video/webm" }) === "video/webm");
  check("every NAMED type rejected: the trailing null candidate is what saves the clip",
    negotiate({ supported: ALL_MP4, constructThrows: [...ALL_MP4, ...ALL_WEBM],
                defaultMime: "video/x-host-default" }) === "video/x-host-default");
}

console.log("\n── §2 THE SOURCE CONTRACT ──");
{
  const picker = lift("function pickRecorderMimes()");
  check("MP4 candidates are listed before any WebM candidate",
    picker.indexOf("video/mp4") < picker.indexOf("video/webm"), picker);
  check("the two spec'd MP4 types lead, in order (H.264+AAC, then bare video/mp4)",
    /"video\/mp4;codecs=avc1\.42E01E,mp4a\.40\.2",\s*\n\s*"video\/mp4",/.test(picker), picker);
  check("every candidate is still feature-tested via isTypeSupported",
    picker.includes("MediaRecorder.isTypeSupported"), picker);
  check("isTypeSupported stays try-wrapped - a throwing engine must not kill selection",
    /try \{ return MediaRecorder\.isTypeSupported\(t\); \} catch \(_\) \{ return false; \}/.test(picker), picker);
  check("IS_MOBILE no longer picks the container (the platform split is gone)",
    !picker.includes("IS_MOBILE"), picker);

  /* IS_MOBILE still legitimately drives the SAVE PATH (share sheet vs anchor); it must
     simply never reach the codec choice again. */
  check("IS_MOBILE is still used for the save path, so this is a narrowing not a deletion",
    /if \(IS_MOBILE\) a\.target = "_blank"/.test(APP));
}

console.log("\n── §3 THE BLOB, THE FILENAME, AND THE SAVED-CLIP EXTENSION ──");
{
  const finalize = lift("function finalizeRecording()");
  check("the recorder's OWN negotiated mimeType leads - chunk .type is only the fallback",
    /const raw = recorderMime \|\| \(recordedChunks\[0\] && recordedChunks\[0\]\.type\) \|\| "video\/webm";/.test(finalize),
    finalize);
  check("codec parameters are stripped, so the Blob carries a bare container type",
    /const type = raw\.split\(";"\)\[0\] \|\| "video\/webm";/.test(finalize), finalize);
  check("...and that type is what the Blob is built with",
    /new Blob\(recordedChunks, \{ type \}\)/.test(finalize), finalize);
  check(`an MP4 recording therefore yields exactly { type: "video/mp4" }`,
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2".split(";")[0] === "video/mp4");

  const dl = lift("async function downloadRecording()");
  check("the download extension follows the Blob's own type",
    /const ext = type\.indexOf\("mp4"\) > -1 \? "mp4" : "webm";/.test(dl), dl);
  check("the filename is the stamped pear-tryon form",
    /pear-tryon-\$\{base \? base \+ "-" : ""\}\$\{clipStamp\(\)\}\.\$\{ext\}/.test(dl), dl);
  check("the share-sheet File is given the same type as the anchor download",
    /new File\(\[recordedBlob\], filename, \{ type \}\)/.test(dl), dl);

  const clipStamp = new Function(`${lift("function clipStamp(d = new Date())")} return clipStamp;`)();
  const D = new Date(2026, 7, 29, 9, 4, 5);
  check("clipStamp() is zero-padded YYYYMMDD-HHMMSS in local time",
    clipStamp(D) === "20260829-090405", clipStamp(D));

  // The exact base-name derivation from downloadRecording(), applied to real names.
  const nameFor = (raw, ext) => {
    const base = (raw || "").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-");
    return `pear-tryon-${base ? base + "-" : ""}${clipStamp(D)}.${ext}`;
  };
  check("a garment name is kept, spaces hyphenated",
    nameFor("Blue Denim Jacket", "mp4") === "pear-tryon-Blue-Denim-Jacket-20260829-090405.mp4",
    nameFor("Blue Denim Jacket", "mp4"));
  check("no active garment: the stamp alone, with no dangling separator",
    nameFor("", "mp4") === "pear-tryon-20260829-090405.mp4", nameFor("", "mp4"));
  check("characters Windows/macOS reject in a filename are stripped",
    nameFor('A/B: "big" <one>', "mp4") === "pear-tryon-AB-big-one-20260829-090405.mp4",
    nameFor('A/B: "big" <one>', "mp4"));
  check("Hebrew garment names survive intact (the catalog is Hebrew-first)",
    nameFor("חולצה כחולה", "mp4") === "pear-tryon-חולצה-כחולה-20260829-090405.mp4",
    nameFor("חולצה כחולה", "mp4"));
  check("a WebM fallback recording is still labelled .webm, never mislabelled .mp4",
    nameFor("Tee", "webm").endsWith(".webm"), nameFor("Tee", "webm"));

  /* The gallery clip must carry its OWN container. recorderMime belongs to the LIVE
     session and clearRecording() nulls it, so reading it here mislabelled every clip
     downloaded after the next session had started. */
  const clipExt = new Function("clipTypes", `${lift("function clipExt(ts)")} return clipExt;`)(
    new Map([[1, "video/mp4"], [2, "video/webm"]]));
  check("clipExt(): a saved MP4 clip downloads .mp4", clipExt(1) === "mp4");
  check("clipExt(): a saved WebM clip downloads .webm", clipExt(2) === "webm");
  check("clipExt(): an unknown ts degrades to .webm rather than throwing", clipExt(99) === "webm");

  check("the lightbox download reads clipExt(), NOT the live session's recorderMime",
    /dlBtn\.download = `PEAR-fit-\$\{it\.ts\}\.\$\{clipExt\(it\.ts\)\}`;/.test(APP) &&
    !/dlBtn\.download = .*recorderMime/.test(APP));
  check("the container is recorded when the clip is attached to a fit",
    /clipTypes\.set\(lastFitTs, blob\.type \|\| ""\);/.test(APP));
  check("...and released with it, so clipTypes cannot outlive liveClips",
    /clipTypes\.delete\(ts\);/.test(APP) && /clipTypes\.clear\(\);/.test(APP));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
