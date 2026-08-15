/* STRICT IMAGE-ONLY CONDITIONING - "I picked a Spider-Man tee and it rendered a tuxedo".

   REPORTED FAILURE: a graphic t-shirt selected from the catalog, its reference image
   correctly resolved, correctly composited and correctly delivered to rtClient.set() -
   and Decart streaming back a full tuxedo with a bowtie. Not a wrong colour, not a
   drifted print: a different garment entirely, of a different class, from a reference the
   model demonstrably had. Reported TWICE - the first fix did not stop it.

   ROOT CAUSE - the prompt was competing with its own image. Decart's realtime set()
   accepts exactly { prompt, image, enhance } (verified against @decartai/sdk@0.1.5
   setInputSchema). There is no negative_prompt, no image-strength, no ControlNet weight -
   so the ONLY lever this app has over how hard the reference image is weighed against the
   text is how much text there is.

   FIX ONE removed the two clauses that were most obviously fighting the pixels:
     · THE GARMENT DESCRIPTION. Every builder opened by interpolating catalog metadata -
       "Replace their top with white t-shirt: exact colour, texture and print." A text
       description is something a diffusion model can satisfy out of its own prior instead
       of out of the reference. Nothing in that sentence mentions Spider-Man.
     · THE ENUMERATED NEGATIVE. DENSE.assetLock spelled out "never invent a garment,
       jacket, coat, suit, TUXEDO, tie, BOWTIE or badge". With no negative_prompt field
       those nouns ship inside the POSITIVE prompt, where a named garment is a token the
       sampler can steer toward.
   It kept an image anchor plus the STRUCTURAL clauses (panel contract, pose, passthrough
   locks) on the theory that a clause which describes no garment cannot summon one.

   THE TUXEDO SURVIVED IT, so FIX TWO drops the theory: every clause is text, structural
   ones included, and the axis that mattered was total volume rather than kind. The prompt
   is now ONE FROZEN STRING - IMAGE_ONLY_PROMPT - byte-identical for every garment, angle,
   pose and shopper. It cannot contradict the reference because it says nothing the
   reference could contradict, and it cannot dilute it because there is nothing to shed.

   THE COMPOSITE STANDS DOWN WITH IT (COMPOSITE_DEFAULT = false), and that is the one
   non-prompt change in this mode. A split FRONT|BACK reference is only legible alongside
   the panel contract that explains it; strip the contract and the model is handed a
   collage with no key, which is both the 23f5953 double-print bug and exactly the kind of
   ambiguous reference that sends a diffusion model back to its prior.

   WHAT THIS SUITE PINS, and why each is a distinct way for the fix to rot:
     §1  the frozen string's exact wording (product-specified) and that it is genuinely
         constant - no interpolation, no per-item branch, no concatenation;
     §2  every builder returns it and assembles nothing, at every angle and pose;
     §3  the retirement is REVERSIBLE - the clauses and the assembly machinery are all
         still on file, because a mode this aggressive will need pieces bought back;
     §4  the composite stands down, with its kill switch still working both ways;
     §5  the payload actually carries an image on every update and retry, because an
         image-only prompt with no image is the same failure through the other half of
         the call - and that path used to be silent.

   Sibling suites: model-agnostic.test.mjs holds the record of the body clauses and their
   restore path; side-profile.test.mjs still proves angleClause() assembles correctly (it
   is the restore path, kept live); composite.test.mjs owns the stitch geometry. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CFG = readFileSync(new URL("../fitting-room/config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* The real builder, executed. */
const code = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                       SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: 650, console: { warn() {}, log() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
  colorName: () => "white",
  activeColorOf: (it) => (it && it.color) || "#fff", getSizeDelta: () => 0,
  getFitModifier: () => "regular fit", getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { buildCompositePrompt, IMAGE_ONLY_PROMPT, fitPrompt, P, DENSE };")(...Object.values(sandbox));

const TEE = { name: "Tee", garmentType: "upper_body", color: "#fff", subType: "short_sleeve" };
const SPEC =
  "Extract strictly the garment's fabric texture, color, and design pattern from the" +
  " reference image, completely ignoring the original model's body size, chest, and waist" +
  " dimensions. Wrap and drape the fabric dynamically onto the target subject's true live" +
  " body volume, abdomen depth, and physical contours from all angles. Render realistic" +
  " textile drape, natural tension lines, and proper 3D volume wrapping over the subject's" +
  " stomach and waist, whether large or small, without 2D stretching or floating artifacts.";

console.log("── §1 THE FROZEN STRING: product-specified, and genuinely constant ──");
{
  /* Byte-exact, because the wording is a product decision rather than an implementation
     detail - a paraphrase that reads the same to a human is a different token sequence to
     a diffusion model, and this is the one string in the file whose exact form was
     specified from outside it. */
  check("IMAGE_ONLY_PROMPT matches the specified wording byte for byte",
    api.IMAGE_ONLY_PROMPT === SPEC, JSON.stringify(api.IMAGE_ONLY_PROMPT));

  /* THREE SENTENCES, THREE JOBS, each one a clause that used to be separate and
     shed-able. Asserted individually because the failure mode of a frozen string is a
     well-meant reword that quietly drops one - and there is no fitPrompt() shed log to
     notice it any more, because there is no assembly left to log. */
  /* SENTENCE ORDER IS PART OF THE SPEC, not incidental. The EXTRACTION directive leads,
     and revision 3 moved it there deliberately: until the reference is understood as
     MATERIAL rather than as a photograph of a dressed person, every later instruction gets
     applied to that person's geometry - which is the 2D-stretch report (a thin torso
     deformed to cover a wide one, instead of cloth wrapping a volume). This file's whole
     record says leading tokens dominate; this is that lesson applied once more. */
  check("(1) it leads by reducing the reference to a 2D MATERIAL - texture, colour, pattern",
    SPEC.indexOf("Extract strictly the garment's fabric texture, color, and design pattern") === 0);
  check("...and discards the source body outright, naming chest and waist individually",
    /completely ignoring the original model's body size, chest, and waist dimensions/.test(SPEC),
    "a general word like 'proportions' invites a general reading");
  check("(2) it drapes onto live VOLUME, not a shape - the word the stretch report earned",
    /Wrap and drape the fabric dynamically onto the target subject's true live body volume/.test(SPEC) &&
    /abdomen depth, and physical contours from all angles/.test(SPEC),
    "a shape is satisfiable by an outline; a volume is not");
  check("(3) it states the TEXTILE PHYSICS the first two sentences only imply",
    /Render realistic textile drape, natural tension lines, and proper 3D volume wrapping/.test(SPEC) &&
    /over the subject's stomach and waist/.test(SPEC),
    "drape, tension and 3D wrapping are what distinguish cloth from a decal");
  check("...removing the size assumption rather than arguing with it",
    /whether large or small/.test(SPEC));
  /* THE TWO NAMED ARTIFACTS, and why naming these is safe when naming "tuxedo" was not.
     Both are the reported failure stated directly - the shirt painted flat across a
     protrusion, or hovering in front of one - and naming a specific wrong output is this
     file's oldest working mechanism (backInferred). The tuxedo list backfired because a
     garment noun in a positive prompt is an OBJECT the sampler can steer toward. A stretch
     and a float are rendering FAULTS; there is nothing to steer toward. */
  check("...and names the two reported artifacts directly",
    /without 2D stretching or floating artifacts/.test(SPEC),
    "a rendering fault has no object for the sampler to reach for, unlike a garment noun");

  /* BOTH SILHOUETTE AXES ARE NAMED, and this is the assertion the abdomen report earned.
     Head-on a body's outline is its WIDTH; edge-on, width foreshortens to nearly nothing
     and the entire outline is DEPTH. A clause naming only one leaves the other undefended
     at exactly the angle where it is the whole silhouette - which is the gap the retired
     SIDE_PROFILE_DEPTH was written against, and the reason "waistline" is named alongside
     the generic contour language. */
  check("...naming depth, volume AND contour, so no axis is undefended at 90 degrees",
    /abdomen depth/.test(SPEC) && /body volume/.test(SPEC) && /physical contours/.test(SPEC),
    "one axis alone is undefended at 90 degrees, where the other IS the outline");

  /* NOT POSE-GATED, and that is the substantive win over the clause it replaces.
     DENSE.profileLateral rode behind an `inProfile` ternary and shed edge-on under budget
     pressure - so the 90-degree frame, the one case it existed for, was the case most
     likely to lose it. "at all angles" needs no flag and cannot shed. */
  /* MORE THAN A CONVENIENCE NOW. The orientation watcher no longer dispatches anything on
     a profile transition - its hold and its prompt update were both retired when the
     90-degree freeze was traced to them - so a directive that needed a pose flag to arrive
     would simply never arrive. Stating it unconditionally is the only way it holds at 90
     degrees at all. */
  check("...and every angle is covered unconditionally, since no pose event delivers it",
    /from all angles/.test(SPEC) && !/EDGE-ON/.test(SPEC),
    "no pose flag switches this on, and nothing would fire one if it did");

  /* THE NOUN LIST IS GONE ENTIRELY, and its absence is the assertion. Three versions of
     this prompt named the garment they were trying to prevent - assetLock enumerated six,
     the first frozen string kept two - and the tuxedo outlived all of them. With no
     negative_prompt field, a banned noun ships in the POSITIVE prompt where the sampler
     can steer toward it: at best neutral, plausibly the cause. What guards the
     substitution now is positive and unnamed, stated twice.
     If invented garments return, DO NOT re-add the list - that move has been tried. */
  check("no banned-garment noun ships at all",
    !/tuxedos?|suits?|jackets?|coats?|bowties?|badges?/i.test(SPEC),
    "naming the garment is what three earlier versions already tried");
  check("...the substitution is guarded positively instead - by what may be taken, not what may not",
    /Extract strictly the garment's fabric texture, color, and design pattern from the reference image/.test(SPEC),
    "an exhaustive list of what to take leaves nothing for an invented garment to be");

  /* CONSTANT, not merely short. A template literal here is how a description creeps back
     in one field at a time, which is the exact history this mode is reacting to. */
  check("declared with no interpolation hole",
    /const IMAGE_ONLY_PROMPT =\s*\n?\s*"[^`]*";/s.test(SRC) &&
    !/IMAGE_ONLY_PROMPT[^\n]*\$\{/.test(SRC),
    "no ${...} anywhere in or adjacent to the declaration");
  check("...and it is never concatenated onto at any call site",
    !/IMAGE_ONLY_PROMPT\s*\+/.test(SRC) && !/\+\s*IMAGE_ONLY_PROMPT/.test(SRC),
    "appending one clause is how the dozen came back last time");

  /* It has to survive the wire guard untouched: clampPromptForWire() truncates anything
     over budget, and a frozen prompt that gets clipped is no longer the spec'd string. */
  check("it is comfortably inside the 226-token ceiling, so the wire guard never clips it",
    SPEC.length <= 650, `${SPEC.length} chars (~${Math.ceil(SPEC.length / 4)} tokens)`);
}

console.log("\n── §2 EVERY BUILDER RETURNS IT, AND ASSEMBLES NOTHING ──");
{
  const cases = [
    ["FRONT square-on", TEE, "front", false],
    ["FRONT edge-on", TEE, "front", true],
    ["BACK square-on", TEE, "back", false],
    ["BACK edge-on", TEE, "back", true],
    ["BOTTOMS edge-on", { ...TEE, garmentType: "lower_body" }, "front", true],
    ["custom upload", { ...TEE, custom: true }, "front", true],
    ["pathological name", { ...TEE, name: "x".repeat(400) }, "front", true],
  ];
  for (const [name, item, angle, prof] of cases) {
    check(`${name}: byte-identical to the frozen string`,
      api.buildCompositePrompt(item, angle, prof) === SPEC,
      api.buildCompositePrompt(item, angle, prof));
  }

  /* Structural, across the builders this sandbox cannot execute. The four together are
     every path that can reach rtClient.set() with a prompt. */
  const builders = [
    ["buildPrompt", /function buildPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildCustomPrompt", /function buildCustomPrompt\(item, angleText[\s\S]*?\n}/],
    ["buildLookPrompt", /function buildLookPrompt\(top, bottom, angleText[\s\S]*?\n}/],
    ["buildCompositePrompt", /function buildCompositePrompt\(item, angle, inProfile\)[\s\S]*?\n}/],
  ];
  for (const [name, re] of builders) {
    const body = (SRC.match(re) || [""])[0];
    /* Comments stripped first: buildLookPrompt()'s body carries the restore note naming
       DENSE.lookPanels, and a check that trips over the explanation of the retirement is
       worse than no check - it would force whoever reads it to delete the documentation. */
    const codeBody = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check(`${name}(): returns the constant, calls no assembler`,
      /return IMAGE_ONLY_PROMPT;/.test(codeBody) && !/fitPrompt\(/.test(codeBody) &&
      !/DENSE\./.test(codeBody), codeBody.slice(-240) || "builder not found");
  }

  /* THE INVARIANT, stated as an absence - the only form that catches the real regression,
     which is somebody adding one more well-meant clause. Every clause this file ever grew
     was individually justified; the sum is what produced the tuxedo. */
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no colour word or subtype noun reaches any prompt",
    !/colorName\(activeColorOf\(/.test(codeOnly) &&
    !/SHIRT_NOUN\[/.test(codeOnly) && !/SUBTYPE_PROMPT\[/.test(codeOnly));
  check("no DENSE clause is assembled by any builder",
    !/\[P\.(CORE|HIGH|MED|LOW|TRIM),\s*DENSE\./.test(codeOnly),
    "the DENSE table is a restore library now, not an assembly source");
  check("the size-override modifier no longer reaches the wire either",
    !/\[P\.\w+,\s*fitSentence\(/.test(codeOnly),
    "documented in IMAGE_ONLY_PROMPT's retirement list - the UI still works, the render ignores it");
}

console.log("\n── §3 THE RETIREMENT IS REVERSIBLE (this mode will need pieces back) ──");
{
  /* A mode this aggressive is a starting point, not an endpoint: it establishes whether
     text volume was the problem, and the answer is only useful if clauses can be added
     back ONE at a time. That requires three things to still exist. */
  check("the assembly machinery survives - fitPrompt() and the priority tiers",
    /function fitPrompt\(parts, max = PROMPT_MAX_CHARS\)/.test(SRC) &&
    /const P = Object\.freeze\(\{ CORE: 0, HIGH: 1, MED: 2, LOW: 3, TRIM: 4 \}\)/.test(SRC));
  check("...the DENSE table survives, with every retired clause verbatim",
    /inpaintLock:\s+"Face, skin, hands and background pass through untouched\."/.test(SRC) &&
    /contract:\s+"The reference image is a split photo of one garment/.test(SRC) &&
    /lookPanels:\s+"The reference stacks two garments/.test(SRC));
  check("...and angleClause() survives, so the orientation clauses stay proven",
    /function angleClause\(item, angleOverride, useComposite, inProfile\)/.test(SRC),
    "side-profile.test.mjs still executes every branch of it");

  /* The restore list itself, ranked. inpaintLock is the largest loss - nothing else
     stands between this prompt and a regenerated face or room - and lookPanels is the
     only one whose absence costs a whole feature rather than a degree of fidelity. */
  check("app.js ranks the losses, naming the passthrough clamp as first to restore",
    /THE LARGEST[\s\S]{0,90}LOSS and the one to restore first/.test(SRC));
  check("...and flags the full-look panel clause as the one that costs a FEATURE",
    /lookPanels is\s*\n?\s*the first clause to buy back/.test(SRC) ||
    /DENSE\.lookPanels is[\s\S]{0,120}first clause to buy back/.test(SRC),
    "buildLookPrompt() must carry that warning - a look has no other layout signal");

  /* The builders keep their parameters so a restore is a two-line edit rather than a
     re-derivation of applyGarment()'s TOCTOU freeze. */
  check("the builders keep their angle/pose parameters as the restore seam",
    /function buildCompositePrompt\(item, angle, inProfile\)/.test(SRC) &&
    /buildCompositePrompt\(item, angleAtStart, profileAtStart\)/.test(SRC),
    "the frozen snapshots must stay threaded even while unused");
}

console.log("\n── §4 THE COMPOSITE STANDS DOWN, and its switch still works ──");
{
  /* Not a prompt change, and the only behavioural one in this mode - so it is asserted
     separately and with its reasoning attached. */
  check("COMPOSITE_DEFAULT is off",
    /const COMPOSITE_DEFAULT = false;/.test(SRC),
    "a split reference with no panel contract is the 23f5953 double-print bug");
  check("...for the stated reason, not silently",
    /THE KILL SWITCH, NOW THROWN/.test(SRC) &&
    /a reference the model has to interpret unaided/.test(SRC));
  check("the URL override still forces it back on for an A/B against a live session",
    /const q = new URLSearchParams\(location\.search\)\.get\("composite"\)/.test(SRC) &&
    /if \(q === "1" \|\| q === "true"\)\s+return true;/.test(SRC));
  check("...and re-enabling is documented as requiring the panel contract back with it",
    /restore\s*\n?\s*DENSE\.contract \+ DENSE\.select in buildCompositePrompt\(\) in the same commit/.test(SRC),
    "the worst of both modes is a split image with no key");
  /* The single-asset path it falls back to is the pre-composite behaviour, still the
     fallback whenever a stitch fails - so this is a switch, not a new code path. */
  check("the per-orientation single-asset path is still what referenceImageFor() falls to",
    /if \(currentAngle === AUTO_ANGLE\) \{\s*\n\s*const blob = await garmentBlobCached\(activeImg\);/.test(SRC));
}

console.log("\n── §5 AN IMAGE ON EVERY UPDATE AND EVERY RETRY ──");
{
  /* An image-only prompt with no image is the same failure through the other door: the
     prompt says "the reference image" and nothing was provided, so the model has only its
     prior. This used to be survivable - the prompt still recited a catalog description,
     so SOMETHING garment-shaped rendered. That safety net is gone by design. */
  const apply = SRC.slice(SRC.indexOf("async function applyGarment(item) {"),
                          SRC.indexOf("\n/**\n * Reads the Screen 1 physical inputs"));
  check("applyGarment sweeps the item's remaining assets when nothing resolved",
    /for \(const candidate of \[g\.front, g\.back, item\.img, item\.composite\]\)/.test(apply));
  check("...and a total failure is an ERROR, not a warning",
    /console\.error\("\[PEAR\] applyGarment\(\) - NO garment asset could be resolved/.test(apply));
  check("...that does not throw the live session away",
    !/throw new Error\("no garment asset/.test(apply),
    "a recoverable session beats a dead one - the next apply gets another attempt");

  /* THE RETRY PROPERTY. applyActive() re-enters applyGarment() on a rejected set(), and
     the wire bookkeeping must not have been written optimistically - otherwise attempt
     two sees its own reference "already on the wire" and retries a failed image upload
     by not uploading the image. */
  const setIdx = apply.indexOf("await rtClient.set(payload);");
  const stampIdx = apply.indexOf("lastSentImageRef = imageRef || null;");
  check("the wire bookkeeping is stamped only AFTER set() resolves, so a retry re-uploads",
    setIdx !== -1 && stampIdx > setIdx, `set@${setIdx} stamp@${stampIdx}`);

  /* THE NO-OP SKIP, new in this mode. With a frozen prompt, "same image + same prompt" is
     a dispatch that provably changes nothing - which the re-anchor cadence would
     otherwise fire ~8 times a session. Skipping it is right; pretending the re-anchor
     still works would not be, so the code says so. */
  check("a dispatch with nothing new is skipped rather than sent",
    /if \(payload\.prompt === lastSentPrompt\) \{/.test(apply) &&
    /no-op update skipped - reference AND prompt both unchanged/.test(apply));
  check("...and the dead re-anchor is documented, not left to be discovered",
    /THE RE-ANCHOR IS A NO-OP IN THIS MODE/.test(apply),
    "there is nothing left in the prompt to re-assert");
  check("lastSentPrompt is cleared everywhere the image bookkeeping is",
    (SRC.match(/lastSentPrompt = null;/g) || []).length >= 4,
    "a stale 'already sent' belief across a session boundary skips the first real dispatch");

  const look = SRC.slice(SRC.indexOf("async function applyLook(top, bottom) {"),
                         SRC.indexOf("function buildLookPrompt"));
  /* `image: null` is NOT the same as no image key: it is an explicit empty value on a key
     the SDK validates, and in a payload log it looks like a reference was delivered. */
  check("applyLook omits the image key rather than sending image: null",
    !/image: primaryImage,/.test(look) &&
    /\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/.test(look));
  check("...on the minimal-retry path too, not just the enriched payload",
    (look.match(/\.\.\.\(primaryImage \? \{ image: primaryImage \} : \{\}\)/g) || []).length === 2);
  check("applyLook falls back to a raw garment ref before giving up",
    /garmentImageRef\(topImg\) \|\| garmentImageRef\(bottomImg\)/.test(look));

  check("verifyGarmentAsset still inspects the payload at both full-set sites",
    (SRC.match(/verifyGarmentAsset\(payload, "(applyGarment|applyLook)"\)/g) || []).length === 2);
  check("...and still says what a payload with no image will actually do",
    /Decart has no pixel reference and will render its default\/generic output/.test(SRC));
}

console.log("\n── §6 A FREEZE MUST NOT RESUME UNCONDITIONED ──");
{
  /* THE FAILURE: the feed stalls for a beat and comes back - dressed in the wrong thing.
     Two different things can be wrong when frames stop (a stalled <video>, or a transport
     rebuilt under us so Decart is generating from the SDK's replayed initial state), and
     only the first is fixed by a nudge. The second is invisible from the outside: the
     picture returns, every existing signal in the file reports success, and the garment
     is whatever was live at the original go-live moment.

     This is asserted HERE rather than in a stream suite because it is the same invariant
     the rest of this file is about, arriving through the transport instead of the text: a
     prompt that says "the reference image" and no reference on the wire. */
  const watcher = SRC.slice(SRC.indexOf("function createFrameFreezeWatcher(video, gen)"),
                            SRC.indexOf("function startFrameFreezeWatch"));
  check("the freeze threshold is the specified 800ms",
    /const FRAME_FREEZE_MS = 800;/.test(SRC));
  check("...checked often enough to catch it near its START, not its end",
    /const FRAME_FREEZE_POLL_MS = 250;/.test(SRC));
  /* THE PRIMARY FIX IS NOT HERE. A receiver with no jitter buffer stalls on any transient
     bitrate shift - this file's own stats-monitor comment named it years before the
     report ("High jitter + playoutDelayHint:0 = visible stutter"). The watchdog catches
     what still slips through; the buffer is what stops most of them happening. */
  check("the receiver is given a real jitter buffer, not zero",
    /PLAYOUT_DELAY_HINT: 0\.0[5-9]|PLAYOUT_DELAY_HINT: 0\.1[0-5]/.test(CFG),
    "0 means render-ASAP with nothing in reserve - the stall the report describes");
  check("...applied through BOTH the legacy and the standard API, from one number",
    /r\.playoutDelayHint = PLAYOUT_DELAY_HINT;/.test(SRC) &&
    /r\.jitterBufferTarget = PLAYOUT_DELAY_HINT \* 1000;/.test(SRC),
    "support is split; setting one lets a browser upgrade silently change buffering");
  check("frames are detected via rVFC, with a currentTime fallback where it is missing",
    /video\.requestVideoFrameCallback\(onFrame\)/.test(watcher) &&
    /if \(!hasRVFC\) \{[\s\S]{0,160}video\.currentTime/.test(watcher),
    "rVFC stops firing exactly when the stream stops - that IS the signal");
  check("the watchdog reads no pixels - it must stay cheap enough to poll",
    !/sampleVideoLuma/.test(watcher),
    "a canvas readback every 500ms would cost more than the stall it detects");

  /* THE THREE FALSE-POSITIVE GUARDS. Each of these legitimately stops frame decoding, and
     "recovering" any of them would fire a set() that is at best wasted and at worst
     throws (the SDK's assertConnected rejects every send while reconnecting). */
  check("it stands down when not live, on a hidden tab, and during an SDK reconnect",
    /if \(!isLive\(\) \|\| connState === "reconnecting" \|\|/.test(watcher) &&
    /document\.hidden/.test(watcher));
  check("...and re-stamps the clock rather than returning, so the outage is not one freeze",
    /lastFrameAt = Date\.now\(\);\s*\n\s*frozenSince = null;\s*\n\s*return;/.test(watcher),
    "otherwise the tab coming back reads as a multi-second stall");

  /* STAGED RECOVERY, CHEAPEST FIRST: element ping, then an SDK keep-alive that sends no
     image, then the full re-anchor. Ordering by cost is what lets the threshold sit at
     800ms - the first two are safe to fire during a stall that may resolve on its own,
     because neither adds meaningful traffic to a transport already struggling. */
  check("stage 1a is a frame ping on the element itself",
    /if \(video\.paused \|\| video\.readyState < 2\)[\s\S]{0,120}video\.play\(\)/.test(watcher));
  check("stage 1b is an SDK keep-alive that carries NO image and no teardown",
    /await rtClient\.setPrompt\(keepAlive, \{ enhance: false \}\)/.test(watcher) &&
    !/rtClient\.set\(/.test(watcher),
    "setPrompt takes sendPrompt(), which never touches the image");
  check("...rate-limited separately from the re-anchor, and cheaply",
    /const FRAME_FREEZE_PING_MS = 600;/.test(SRC) &&
    /Date\.now\(\) - lastPingAt >= FRAME_FREEZE_PING_MS/.test(watcher));
  check("...and a failed ping is swallowed, never surfaced as an error UI",
    /catch \(e\) \{\s*\n\s*console\.warn\("\[PEAR\] freeze keep-alive ping failed/.test(watcher),
    "a freeze must be absorbed, not shown to the shopper");
  check("stage 2 forces the garment back onto the wire, not merely a prompt nudge",
    /invalidateWireState\(`frame freeze/.test(watcher) && /await applyActive\(\)/.test(watcher),
    "a frozen prompt + memoized blob would otherwise match on both halves and skip");
  check("...rate-limited on its OWN clock, so a long freeze is not a re-upload storm",
    /const FRAME_FREEZE_RECOVER_COOLDOWN_MS = 2500;/.test(SRC) &&
    /Date\.now\(\) - lastRecoverAt < FRAME_FREEZE_RECOVER_COOLDOWN_MS/.test(watcher));
  check("...and never runs before the first garment was acknowledged",
    /if \(!isGarmentApplied\) return;/.test(watcher),
    "go-live's own apply still owns the wire until then");
  check("re-anchoring verifies it landed on the same asset Decart last acknowledged",
    /const before = lastAckedImageRef;/.test(watcher) &&
    /lastAckedImageRef !== before/.test(watcher));

  /* THE RECONNECT GUARD - the same fix at the other entry point. An SDK-internal
     reconnect never re-enters connectRealtime(), so this file's wire bookkeeping sails
     through a rebuilt transport still claiming the blob is on it. */
  const opts = SRC.slice(SRC.indexOf("function buildRealtimeConnectOpts(gen)"),
                         SRC.indexOf("async function connectRealtime"));
  check("a post-reconnect re-apply invalidates the wire state FIRST",
    /invalidateWireState\("SDK reconnect[\s\S]{0,200}applyActive\(\)/.test(opts),
    "without it the re-apply matches on both halves and dispatches nothing");
  const invalidate = (SRC.match(/function invalidateWireState\(why\) \{[\s\S]*?\n\}/) || [""])[0];
  check("invalidateWireState clears all three wire flags",
    /lastSentImageRef = null;/.test(invalidate) && /rtImageOnWire = false;/.test(invalidate) &&
    /lastSentPrompt = null;/.test(invalidate), invalidate);
  check("...and preserves the last ACKNOWLEDGED reference, which a recovery re-anchors to",
    !/lastAckedImageRef\s*=/.test(invalidate),
    "it is a statement about the connection, not about what Decart last accepted");
  check("...and touches neither billing, the recorder nor isGarmentApplied",
    !/isGarmentApplied|billingStarted|stopRecording|dressedFrameReady/.test(invalidate),
    "conflating the two re-arms the reveal on a session that never stopped");

  /* NO TEARDOWN AND NO ERROR UI AT ANY STAGE - a freeze is a transient the app absorbs.
     A session torn down or a banner shown mid-window is strictly worse than a stream that
     stutters once and continues, and the watchdog is the one component with both the
     motive and the reach to do it. */
  check("recovery never tears the session down or shows the shopper an error",
    !/stopLive\(\)|teardown\(\)|toast\(/.test(watcher),
    "the only visible trace of a recovery is in the console");

  /* Lifecycle: it can fire applyActive(), so it must never outlive the session. */
  check("armed on the remote stream, so a warm-up stall is covered too",
    /startFrameFreezeWatch\(aiVideo, gen\)/.test(SRC));
  check("...and retired in teardown(), the path every exit eventually reaches",
    /stopFrameFreezeWatch\(\);/.test(SRC.slice(SRC.indexOf("function teardown()"),
                                               SRC.indexOf("function teardown()") + 2600)));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
