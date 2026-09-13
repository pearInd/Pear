/* Tests resolveGarmentViews() from server.js - the function that decides which photo
   is the front, which is the back, and where the back came from.

   ALSO TESTS validateBackCandidate(), added alongside it: the PIXEL-level duplicate
   veto. The URL-identity cases below (§"REGRESSION" x2) were always covered here
   because canonicalImageUrl() could see them. The cases in §DUPLICATE PANELS could
   not: two genuinely different photographs of the SAME side, which sameImage()
   correctly reports as distinct and which therefore bound the front as the back.
   See archive/supabase_setup_v12.sql for the full report. */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = src.indexOf("/* Resizer endpoints keep the REAL asset");
const end = src.indexOf("/* POST /api/classify-images");
const mod = await import("data:text/javascript," + encodeURIComponent(
  "const PRESENTATION_PARAMS = new Set(['width','height','w','h','size','quality','q','dpr','format','fm','crop','fit','scale','v','ver','version','t','cache','_']);\n" +
  src.slice(start, end) + "\nexport { resolveGarmentViews, validateBackCandidate, normalizeOcr, BACK_INVALID_REASON, resolveBackIsPlain, isStaleClassification };"
));
const { resolveGarmentViews, validateBackCandidate, normalizeOcr, BACK_INVALID_REASON, resolveBackIsPlain, isStaleClassification } = mod;

let fails = 0;
function eq(got, want, label) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}
function is(got, want, label) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}
const rec = (...views) => views.map((v) => ({ view: v }));
const F = "https://cdn.shopify.com/s/files/tee-1.jpg";
const BK = "https://cdn.shopify.com/s/files/tee-2_back.jpg";

/* front_color_hex and front_text_ocr ride on every return, both read off the RESOLVED
   front's record and nobody else's.
     · front_color_hex goes to synthesizeBackView(), so a generated rear panel cannot
       drift off the front's colour.
     · front_text_ocr goes to the fitting room's P.CORE identity lock, which asserts it
       as the garment's chest print - so it MUST come from the front record. Taken from
       the back panel (or any other gallery image) it would name lettering that is not on
       the side being rendered, which is the double-print bug through the prompt.
   Both are null whenever the record carries no value, which is every case built by
   rec() below; the g()-built cases carry real values and assert them. */
eq(resolveGarmentViews({ images: [F, BK], records: rec("front", "back"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: BK, back_source: "classifier", front_color_hex: null, front_text_ocr: null }, "classifier finds the back");

eq(resolveGarmentViews({ images: [F, BK], records: rec("front", "front"), scrapedFront: F, scrapedBack: BK }),
   { front: F, back: BK, back_source: "dom", front_color_hex: null, front_text_ocr: null }, "DOM hint outranks the classifier");

eq(resolveGarmentViews({ images: [F], records: rec("front"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: null }, "single-view product -> no back, ready to synthesize");

eq(resolveGarmentViews({ images: [F, F + "?width=800"], records: rec("front", "back"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: null },
   "REGRESSION: a 'back' that is the front under another spelling is rejected");

eq(resolveGarmentViews({ images: [F], records: rec("front"), scrapedFront: F, scrapedBack: F + "?v=99" }),
   { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: null },
   "REGRESSION: a DOM hint equal to the front is rejected, not trusted");

eq(resolveGarmentViews({ images: [F, BK], records: rec("uncertain", "uncertain"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: null },
   "all-uncertain never fabricates a back from position");

eq(resolveGarmentViews({ images: [BK, F], records: rec("back", "front"), scrapedFront: BK, scrapedBack: "" }),
   { front: F, back: BK, back_source: "classifier", front_color_hex: null, front_text_ocr: null },
   "DOM order ignored: classifier's front wins even when it is second");

/* ── DUPLICATE PANELS - the case URL identity cannot see ───────────────────────── */
const LOGO = "BE YOUR OWN Healer WORLDWIDE";
const g = (view, source, extra = {}) => ({ view, source, ...extra });

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: LOGO, primary_color_hex: "#ffffff" }),
               g("back",  "gemini", { text_ocr: LOGO, is_true_back_view: true })],
     scrapedFront: F, scrapedBack: "",
   }),
   { front: F, back: "", back_source: "none", front_color_hex: "#ffffff", front_text_ocr: LOGO },
   "REGRESSION: two DIFFERENT photos whose OCR both read the chest logo -> back rejected");

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: LOGO }),
               g("back",  "gemini", { text_ocr: "", is_true_back_view: true })],
     scrapedFront: F, scrapedBack: "",
   }),
   { front: F, back: BK, back_source: "classifier", front_color_hex: null, front_text_ocr: LOGO },
   "a genuinely PLAIN back beside a printed front is kept - the normal graphic-tee case");

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: LOGO }),
               g("back",  "gemini", { text_ocr: LOGO, is_true_back_view: false })],
     scrapedFront: F, scrapedBack: BK,
   }),
   { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: LOGO },
   "the veto applies to a DOM-named back too, not only a classifier one");

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: LOGO }),
               g("back",  "gemini", { text_ocr: "TEAM 23", is_true_back_view: false })],
     scrapedFront: F, scrapedBack: "",
   }),
   { front: F, back: BK, back_source: "classifier_weak", front_color_hex: null, front_text_ocr: LOGO },
   "REGRESSION: is_true_back_view:false alone is HESITATION, not duplication - salvaged, not dropped");

/* ── ABSTENTION (CLAUDE.md §2.5) - a wrong veto costs a real rear view ─────────── */
eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: "" }), g("back", "gemini", { text_ocr: "" })],
     scrapedFront: F, scrapedBack: "",
   }),
   { front: F, back: BK, back_source: "classifier", front_color_hex: null, front_text_ocr: null },
   "REGRESSION: two PLAIN garments both transcribe to '' - that is not a duplicate");

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini"), g("back", "gemini")],
     scrapedFront: F, scrapedBack: "",
   }),
   { front: F, back: BK, back_source: "classifier", front_color_hex: null, front_text_ocr: null },
   "a pre-v12 cache row (no OCR, no is_true_back_view) abstains, it does not veto");

eq(resolveGarmentViews({
     images: [F, BK],
     records: [g("front", "gemini", { text_ocr: LOGO }),
               g("back", "dom_hint", { text_ocr: null })],
     scrapedFront: F, scrapedBack: BK,
   }),
   { front: F, back: BK, back_source: "dom", front_color_hex: null, front_text_ocr: LOGO },
   "a dom_hint row is never vetoed on evidence nobody collected");

/* ── validateBackCandidate() directly - the reason codes are the log contract ───── */
is(validateBackCandidate({ url: BK, record: g("back", "gemini", { text_ocr: LOGO }) },
                         g("front", "gemini", { text_ocr: LOGO }), F).reason,
   BACK_INVALID_REASON.OCR_MATCHES, "reason code: front_text_repeated");

is(validateBackCandidate({ url: BK, record: g("back", "gemini", { is_true_back_view: false }) },
                         g("front", "gemini"), F).reason,
   BACK_INVALID_REASON.NOT_TRUE_BACK, "reason code: not_a_true_back_view");

is(validateBackCandidate({ url: F + "?width=1400", record: g("back", "gemini") },
                         g("front", "gemini"), F).reason,
   BACK_INVALID_REASON.SAME_URL, "reason code: same_photo_as_front");

is(validateBackCandidate({ url: BK, record: g("back", "gemini", { text_ocr: "TEAM 23" }) },
                         g("front", "gemini", { text_ocr: LOGO }), F).valid,
   true, "a real back with its own rear print is valid");

/* is_true_back_view:false is honoured ONLY from a model-sourced row. Any other source
   never answered the question, and treating silence as denial would discard the
   storefront's own markup - the highest-trust signal in the pipeline. */
is(validateBackCandidate({ url: BK, record: g("back", "dom_hint", { is_true_back_view: false }) },
                         g("front", "gemini"), F).valid,
   true, "is_true_back_view is only honoured from a gemini-sourced record");

/* ── normalizeOcr() - compare the WORDS, not the shift key ─────────────────────── */
is(normalizeOcr("BE YOUR OWN Healer WORLDWIDE"), normalizeOcr("be your own healer worldwide"),
   "case-insensitive: the same graphic read twice is one graphic");
is(normalizeOcr("BE YOUR OWN, Healer -- WORLDWIDE!"), normalizeOcr("BE YOUR OWN Healer WORLDWIDE"),
   "punctuation and runs of whitespace are not evidence of a different print");
is(normalizeOcr(null), "", "a missing transcription normalises to '' and therefore abstains");
is(normalizeOcr("TEAM 23") === normalizeOcr("TEAM 32"), false, "genuinely different prints stay different");

console.log("\n── §PLAIN-REAR: the question is GRAPHICS, never lettering ──");
{
  /* THE BUG THIS SECTION EXISTS FOR, and it shipped with zero coverage - which is why it
     reached a live session. back_is_plain was computed as `text_ocr === ""`. text_ocr
     transcribes LETTERING; it says nothing about graphics. A rear panel carrying a large
     PHOTOGRAPHIC print and no legible words transcribes to "" - so the back was declared
     plain, the fitting room selected PLAIN_BACK_ANCHOR ("The rear panel is smooth
     unbroken fabric"), and Decart was instructed to render a blank back over a reference
     that had a mountain photo on it. The shopper turned 180 and got a generic plain back.

     has_graphic asks the question directly, and the two verdicts are EXPECTED to disagree
     on exactly that case. The first check below is the regression itself. */
  const photoRear = { has_graphic: true, text_ocr: "" };   // mountain print, no words
  is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier", backRecord: photoRear }),
     false,
     "REGRESSION: a photographic rear print with NO lettering is not plain");

  is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier",
                          backRecord: { has_graphic: false, text_ocr: "" } }),
     true, "a genuinely undecorated rear is plain");
  /* Lettering with no other decoration is still a graphic - and note text_ocr is not
     consulted at all any more; it is present here only to prove it does not leak back in. */
  is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier",
                          backRecord: { has_graphic: true, text_ocr: "TEAM 23" } }),
     false, "rear lettering is a graphic too");

  /* WE generated this rear, and the synthesis prompt reconstructs unbroken fabric and
     forbids carrying the front graphic over. Plain by construction, no verdict needed -
     and it must hold even when no record exists for a generated data: URL. */
  is(resolveBackIsPlain({ back: "data:image/png;base64,xx", back_source: "synthetic", backRecord: null }),
     true, "a generated rear is plain by construction");

  /* ── ABSTENTION, AND WHY IT IS ASYMMETRIC HERE ──────────────────────────────────
     Every other optional verdict in this file abstains to null and stays neutral. This
     one must abstain AWAY FROM "plain", because the two errors are not equal: a wrong
     "plain" erases the garment's artwork from the render, while a wrong "decorated" just
     keeps today's wording. So only an explicit false is licence to call a side plain. */
  is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier", backRecord: {} }),
     null, "an older build that never answered abstains - it does not read as plain");
  is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier", backRecord: null }),
     null, "a pre-v12 cache row abstains too");
  is(resolveBackIsPlain({ back: "", back_source: "none", backRecord: null }),
     null, "no back at all is not a plain back");

  /* The old implementation would have answered `true` for every one of these, because
     each has an empty transcription. Asserted as a group so the specific mistake cannot
     come back through a different route. */
  const emptyOcrButDecorated = [
    { has_graphic: true, text_ocr: "" },
    { has_graphic: true, text_ocr: "   " },
    { has_graphic: true },
  ];
  for (const r of emptyOcrButDecorated) {
    is(resolveBackIsPlain({ back: "b.jpg", back_source: "classifier", backRecord: r }) === true,
       false,
       `empty/absent lettering never implies plain (${JSON.stringify(r)})`);
  }
}

console.log("\n── §SALVAGE: hesitation is not duplication ──");
{
  /* THE BUG THIS SECTION EXISTS FOR, and it was caused by the veto two sections up.
     is_true_back_view:false means "the model would not stake the verdict on this photo".
     That is NOT evidence the photo is the FRONT. Treating it as such threw away the only
     rear photo a product had, dropping it to single-view: canCombineViews() goes false,
     the OrientationWatcher never arms, and a 180-degree turn leaves Decart inferring a
     rear from the front reference - the print-less-back bug, reintroduced by a guard
     written to prevent a different one. Reported live on a garment whose catalog rear
     carries a large mountain print. */
  const weakBack = g("back", "gemini", { is_true_back_view: false, text_ocr: "TEAM 23" });

  eq(resolveGarmentViews({
       images: [F, BK],
       records: [g("front", "gemini", { text_ocr: LOGO }), weakBack],
       scrapedFront: F, scrapedBack: "",
     }),
     { front: F, back: BK, back_source: "classifier_weak", front_color_hex: null, front_text_ocr: LOGO },
     "REGRESSION: a low-confidence rear is used rather than dropping to single-view");

  /* ── THE ORDERING THAT MAKES THE SALVAGE SAFE ──────────────────────────────────
     A candidate that is BOTH a duplicate AND low-confidence must report DUPLICATION, or
     the salvage would resurrect the front photo as the back and put the chest print on
     the shopper's spine. validateBackCandidate checks duplication evidence FIRST and
     hesitation LAST precisely so that reaching NOT_TRUE_BACK proves no duplication
     evidence was found. This check is what pins that order - it failed when the
     confidence test ran first. */
  const dupAndWeak = g("back", "gemini", { is_true_back_view: false, text_ocr: LOGO });
  is(validateBackCandidate({ url: BK, record: dupAndWeak },
                           g("front", "gemini", { text_ocr: LOGO }), F).reason,
     BACK_INVALID_REASON.OCR_MATCHES,
     "a duplicate that is ALSO low-confidence reports duplication, never hesitation");
  eq(resolveGarmentViews({
       images: [F, BK],
       records: [g("front", "gemini", { text_ocr: LOGO }), dupAndWeak],
       scrapedFront: F, scrapedBack: "",
     }),
     { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: LOGO },
     "...so it is NOT salvaged - a duplicate stays discarded even with no back left");

  /* A URL-spelling duplicate must not be salvaged either, by the same argument. */
  eq(resolveGarmentViews({
       images: [F, F + "?width=800"],
       records: [g("front", "gemini"), g("back", "gemini", { is_true_back_view: false })],
       scrapedFront: F, scrapedBack: "",
     }),
     { front: F, back: "", back_source: "none", front_color_hex: null, front_text_ocr: null },
     "a same-photo duplicate is never salvaged, however hesitant the verdict");

  /* The salvage is a LAST resort: a confidently valid candidate must still win, and the
     provenance must stay honest so a weak back is distinguishable in the logs. */
  eq(resolveGarmentViews({
       images: [F, BK, BK + "?v=2"],
       records: [g("front", "gemini"),
                 g("back", "gemini", { is_true_back_view: false }),
                 g("back", "gemini", { is_true_back_view: true })],
       scrapedFront: F, scrapedBack: "",
     }),
     { front: F, back: BK + "?v=2", back_source: "classifier", front_color_hex: null, front_text_ocr: null },
     "a confident back outranks a weak one, and keeps the plain `classifier` provenance");
}

console.log("\n── §CLASSIFIER: print prominence and lettering orientation are not front/back cues ──");
{
  /* THE BUG, reported three times before it was found. A brown PEAK tee whose catalog
     rear photo carries a large mountain photograph rendered SMOOTH BROWN FABRIC WITH NO
     ARTWORK on a 180-degree turn. That exact output is what synthesizeBackView() produces
     ("the back is PLAIN in that garment's fabric and colour", rendered "uniform"), and it
     only runs when NO real rear photo was resolved. So the real rear photo was never
     labelled back.

     Why: the classifier listed "front graphic or lettering read the right way round" as a
     DECISIVE FRONT cue. A flat-lay photo of the BACK satisfies that - the camera faces
     the rear panel squarely, so its lettering reads correctly too. Its counterweight,
     "Back graphic ... spine lettering", was circular. These checks read the prompt text
     itself, because that is where the defect lived. */
  const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = SERVER.indexOf("DECISIVE FRONT cues");
  const frontCues = SERVER.slice(start, SERVER.indexOf("DECISIVE BACK cues", start));

  is(/read the right way round/i.test(frontCues), false,
     "REGRESSION: lettering orientation is no longer a decisive FRONT cue");
  is(/front graphic/i.test(frontCues), false,
     "...and neither is an unqualified 'front graphic' - that is circular");
  is(/NOT CUES/.test(SERVER) && /PRINT SIZE, PROMINENCE OR PLACEMENT/.test(SERVER), true,
     "print size/prominence is explicitly named as NOT a cue");
  is(/LETTERING READ THE RIGHT WAY ROUND\. On a flat-lay/.test(SERVER), true,
     "...and so is lettering orientation, with the flat-lay reason stated");
  /* The genuinely decisive flat-lay signal. */
  is(/FLAT-LAY \/ PACKSHOT OF A T-SHIRT[\s\S]{0,120}NECKLINE is the decisive cue/.test(SERVER), true,
     "neckline depth is made the decisive cue for a flat-lay tee");
  /* Uncertain must beat letting the artwork decide - a wrong verdict here is what
     produced a synthetic back in the first place. */
  is(/cannot be judged, answer "uncertain" rather than\s*\n?\s*letting the artwork decide/.test(SERVER), true,
     "an unjudgeable neckline abstains rather than deferring to the print");
}

console.log("\n── §CACHE: a verdict from an older prompt is a miss ──");
{
  /* Without this, a classifier fix never reaches a photo already in garment_cache - the
     old verdict is served forever. That is how the PEAK tee's wrong verdict survived
     several rounds of fixes. */
  is(isStaleClassification({ classifier_version: 2 }, 3), true,
     "REGRESSION: a verdict from an older prompt is re-asked");
  is(isStaleClassification({ classifier_version: 3 }, 3), false,
     "a verdict from the current prompt is served from cache");
  is(isStaleClassification({ classifier_version: 4 }, 3), false,
     "a newer version (rolled-back deploy) is not thrashed");
  /* NULL: the column exists but the row predates versioning - produced by a prompt older
     than any stamped version, so it is stale. */
  is(isStaleClassification({ classifier_version: null }, 3), true,
     "a row that predates versioning (NULL) is stale");
  /* UNDEFINED: the column does not exist yet. Treating that as stale would re-ask Gemini
     for the whole catalog on every visit against a 60 RPM limit, triggered by nothing but
     a pending migration - so pre-migration behaviour must be unchanged. */
  is(isStaleClassification({}, 3), false,
     "a missing column (migration pending) is NOT stale - no Gemini storm");
  is(isStaleClassification(null, 3), false, "no cached row is not a stale row");
  const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  is(/classifierVersion: CLASSIFIER_PROMPT_VERSION/.test(SERVER), true,
     "every write stamps the current prompt version");
  is(/isStaleClassification\(cached, CLASSIFIER_PROMPT_VERSION\)/.test(SERVER), true,
     "the cache-hit path actually consults it");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
