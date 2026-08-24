/* EVERY SAVED CLIP LEAVES AS .mp4 - and the ways that could quietly stop being true.

   This path had no coverage at all, which is how the extension came to be DERIVED in
   three separate places from whatever MediaRecorder happened to negotiate. Three
   derivations meant three chances to hand a shopper a .webm, and the gallery's copy read
   a module variable that can describe a different recording by the time it runs.

   Two of the checks here are about a hazard rather than a preference, and they are the
   reason this file exists:
     · isTypeSupported() answers about a TYPE STRING, not about the stream. The preferred
       MP4 rung names an AAC audio codec and the recorded stream is a video-only canvas
       capture, so "supported" and "constructible" genuinely diverge - and under a
       single-pick shape that divergence killed the clip outright.
     · the .mp4 guarantee is a PACKAGING guarantee, not a transcode. The replay path must
       stay truthfully typed or the preview breaks on the one browser that needs the
       re-label. */
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

/* ═══════════════════════ §1 the codec ladder, executed ═══════════════════════ */
console.log("── §1 codec preference, MP4 first on every platform ──");
{
  const src = extract("function recorderMimeCandidates() {", "\n/**\n * Start recording the REMOTE");
  const build = (supported) => {
    const sandbox = {
      MediaRecorder: supported === null ? undefined
        : { isTypeSupported: (t) => supported.includes(t) },
    };
    return new Function(...Object.keys(sandbox),
      src + "\nreturn recorderMimeCandidates;")(...Object.values(sandbox));
  };

  const AVC_AAC = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
  const H264    = "video/mp4;codecs=h264";
  const MP4     = "video/mp4";

  const everything = build([AVC_AAC, H264, MP4, "video/webm;codecs=vp8", "video/webm", "video/webm;codecs=vp9"])();
  check("the first choice is the avc1 + aac MP4 rung", everything[0] === AVC_AAC, everything.join(" | "));
  check("...then h264 MP4", everything[1] === H264, everything.join(" | "));
  check("...then bare video/mp4", everything[2] === MP4, everything.join(" | "));
  check("every MP4 rung precedes every WebM rung",
    everything.findIndex((t) => t.includes("webm")) === 3, everything.join(" | "));
  check("...and the WebM rungs are still there as the fallback",
    everything.filter((t) => t.includes("webm")).length === 3,
    "deleting them would turn 'no MP4 support' into 'no clip'");

  /* THE ORDER IS PLATFORM-INDEPENDENT NOW. It used to branch on IS_MOBILE, putting WebM
     first on desktop; a re-introduced branch would silently restore .webm downloads for
     every desktop shopper, which is exactly what this change removed. */
  check("the ladder does not branch on platform any more",
    !/IS_MOBILE/.test(src), "desktop used to get WebM first - that is the regression to catch");

  /* UNSUPPORTED RUNGS ARE FILTERED, not offered. */
  const firefoxish = build(["video/webm;codecs=vp8", "video/webm"])();
  check("a browser with no MP4 support gets only its real options",
    firefoxish.length === 2 && firefoxish.every((t) => t.includes("webm")), firefoxish.join(" | "));
  check("...and MP4 is never offered to it", !firefoxish.some((t) => t.includes("mp4")));

  const onlyMp4 = build([MP4])();
  check("a browser supporting exactly one rung gets exactly that rung",
    onlyMp4.length === 1 && onlyMp4[0] === MP4, onlyMp4.join(" | "));

  check("no MediaRecorder at all yields an empty list, never a throw",
    build(null)().length === 0);

  /* isTypeSupported itself may throw (it has, on old WebViews) - a throw on one rung must
     not take the whole ladder down. */
  const throwy = new Function("MediaRecorder",
    src + "\nreturn recorderMimeCandidates;")({
    isTypeSupported: (t) => { if (t.includes("avc1")) throw new Error("boom"); return t === "video/webm"; },
  });
  check("a throwing isTypeSupported skips that rung rather than failing the ladder",
    throwy().join(" | ") === "video/webm", throwy().join(" | "));
}

/* ═══════════════════ §2 the export contract, executed ════════════════════════ */
console.log("\n── §2 packaging and naming ──");
{
  const src = extract("function exportClipBlob() {", "\n/**\n * Save the recorded clip locally");
  const mk = (blob) => new Function("recordedBlob", "EXPORT_MIME", "EXPORT_EXT", "Blob", "Date",
    src + "\nreturn { exportClipBlob, exportClipName };")(blob, "video/mp4", "mp4", Blob, Date);

  check("no clip yet -> null, never a throw", mk(null).exportClipBlob() === null);

  /* THE COMMON CASE: the recorder produced MP4, so nothing is re-wrapped. Identity, not
     just an equal type - re-wrapping a multi-MB blob on every download click for no
     reason is the cost this branch exists to avoid. */
  const realMp4 = new Blob(["mp4-bytes"], { type: "video/mp4" });
  check("an MP4 recording is passed through UNCHANGED (same object, no re-wrap)",
    mk(realMp4).exportClipBlob() === realMp4);

  /* THE FALLBACK CASE: WebM bytes, re-labelled. */
  const webm = new Blob(["webm-bytes"], { type: "video/webm;codecs=vp8" });
  const relabelled = mk(webm).exportClipBlob();
  check("a WebM recording comes back typed video/mp4", relabelled.type === "video/mp4");
  check("...and is a DIFFERENT object, leaving the original untouched",
    relabelled !== webm && webm.type === "video/webm;codecs=vp8",
    "the replay path holds that original and must keep its true container");
  check("...carrying the same bytes - this re-labels, it does not transcode",
    relabelled.size === webm.size,
    "if this ever changes size, someone added a conversion and the comment is now wrong");

  const name = mk(realMp4).exportClipName();
  check("the filename is pear-tryon-<timestamp>.mp4",
    /^pear-tryon-\d{8}-\d{6}\.mp4$/.test(name), name);
  check("...and it always ends in .mp4", name.endsWith(".mp4"), name);
}

/* ═════════════ §3 wiring: one contract, no derived extensions left ═══════════ */
console.log("\n── §3 every save path reads the contract ──");
{
  check("EXPORT_MIME is video/mp4", /const EXPORT_MIME = "video\/mp4";/.test(SRC));
  check("EXPORT_EXT is mp4", /const EXPORT_EXT  = "mp4";/.test(SRC));

  const dl = extract("async function downloadRecording()", "\n/** Drop the current clip");
  check("the download derives nothing from the negotiated codec",
    !/recorderMime/.test(dl),
    "deriving the extension from what the recorder negotiated is what produced .webm files");
  check("...it takes its type from EXPORT_MIME", /const type = EXPORT_MIME;/.test(dl));
  check("...its name from exportClipName()", /const filename = exportClipName\(\);/.test(dl));
  check("...and its bytes from exportClipBlob()", /const blob = exportClipBlob\(\);/.test(dl));
  check("the share-sheet File is built from the .mp4-typed blob, not the raw recording",
    /new File\(\[blob\], filename, \{ type \}\)/.test(dl),
    "iOS saves what the File claims to be - a mismatched type is a failed gallery save");
  check("the anchor href prefers the .mp4-typed object URL",
    /a\.href = exportUrl \|\| recordedUrl;/.test(dl));
  check("...and the download attribute is the .mp4 filename",
    /a\.download = filename;/.test(dl));

  /* NO .webm EXTENSION MAY BE PRODUCED ANYWHERE. Stated as an absence, which is the only
     form that catches a well-meant addition. */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no code path builds a .webm filename any more",
    !/\.\$\{[^}]*\}?webm|["'`]webm["'`]/.test(code),
    "the three derived extensions were the whole bug");
  check("the gallery lightbox uses the shared constant too",
    /dlBtn\.download = `PEAR-fit-\$\{it\.ts\}\.\$\{EXPORT_EXT\}`;/.test(SRC),
    "its old form read recorderMime, which can describe a different session by then");

  /* THE REPLAY STAYS TRUTHFUL - the other half of the trade, and the easier half to
     undo by accident while "making everything mp4". */
  const finalize = extract("function finalizeRecording()", "\n/* ── THE .mp4 EXPORT");
  check("finalizeRecording keeps the recording's REAL container for replay",
    /const blob = new Blob\(recordedChunks, \{ type \}\);/.test(finalize) &&
    !/EXPORT_MIME/.test(finalize),
    "Firefox trusts a blob's declared type for playback - re-labelling here breaks the preview");
  check("...and revokes the export URL alongside the replay one",
    /if \(exportUrl\) \{ try \{ URL\.revokeObjectURL\(exportUrl\); \} catch \(_\) \{\} exportUrl = null; \}/.test(finalize));

  const clear = extract("function clearRecording()", "\n  // Reset and hide the dedicated Replay Zone");
  check("clearRecording revokes it too, so a session cannot leak one",
    /exportUrl = null;/.test(clear));
}

/* ═══════════ §4 the ladder is WALKED, not bet on ═══════════════════════════ */
console.log("\n── §4 a rung that will not build must not cost the clip ──");
{
  const begin = extract("const beginRecorder = () => {", "mediaRecorder.ondataavailable");
  check("construction loops over the candidates",
    /for \(const mime of recorderMimeCandidates\(\)\) \{/.test(begin),
    "a single pick made one NotSupportedError fatal to the whole recording");
  check("...catching a rung that reports supported but will not build",
    /catch \(e\) \{[\s\S]{0,240}trying the next candidate/.test(begin),
    "isTypeSupported() answers about a type string, not about this video-only stream");
  check("...and falling back to the browser default rather than giving up",
    /mediaRecorder = new MediaRecorder\(captured\);/.test(begin),
    "a clip in an unasked-for container still exports as .mp4 and beats no clip");
  check("only a total failure stops the paint loop",
    /stopPaintLoop\(\);\s*\n\s*return;/.test(begin));
  check("recorderMime records what was ACTUALLY negotiated",
    /recorderMime = \(mediaRecorder\.mimeType \|\| ""\)\.toLowerCase\(\) \|\| null;/.test(begin),
    "it drives replay and diagnostics - never the exported name");
  check("...and says so loudly when that is not MP4",
    /indexOf\("mp4"\) === -1/.test(begin),
    "the one line that explains a desktop file QuickTime refuses to open");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
