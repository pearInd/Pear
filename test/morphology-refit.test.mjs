/* MORPHOLOGICAL RE-FITTING - the anatomy axis, and the budget it is not allowed to break.

   WHAT THIS FEATURE IS. The garment now adapts to the shopper's own proportions: the pose
   loop measures shoulder and hip breadth off BlazePose, smooths both with an EMA, and
   classifies the result as a hip-dominant ("curve") or shoulder-dominant ("broad") body
   geometry. That classification selects one short draping clause which rides along with
   the prompt already being sent.

   WHY THIS SUITE IS MOSTLY ABOUT THE BUDGET. app.js's whole prompt history is one lesson
   repeated - text volume competes with the reference image, and the composite path has
   almost no room left. The worst-case combined prompt measures 638 of a 650 ceiling that
   is DECART'S, not ours (>226 tokens is a hard reject). Every part of that builder is
   P.CORE, which fitPrompt() cannot shed, so an over-long addition does not degrade
   gracefully: it reaches the hard slice, which cuts at the END and takes DENSE.select -
   the panel contract - off the wire. That is the 23f5953 double-print bug.

   So the load-bearing property is not "the clause ships". It is "the clause SHEDS rather
   than truncating, and the combined prompt is byte-identical to today's when it does".

   §1  the classifier - the spec's thresholds, and the dead band between them
   §2  the WHR estimate, and its honest limit
   §3  the EMA - smoothing, warm-up, and hold-don't-reset on an unreadable frame
   §4  THE SHED LADDER: every builder x angle x pose, measured, never truncating
   §5  the wiring - one sampler, frozen snapshots, no live reads inside builders
   §6  it is additive: the topology monitor's own decisions are untouched               */

import { readFileSync } from "node:fs";
import { CONFIG } from "../fitting-room/config.js";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

/* ── The real morphology code, executed ──────────────────────────────────────── */
const morphCode = SRC.slice(
  SRC.indexOf("/* Smoothing factor for the morphology EMA."),
  SRC.indexOf("/**\n * One frame's body topology"));
const morphApi = new Function(
  "MORPH_MIN_SAMPLES", "MORPH_PROFILE_SWITCH_FRAMES",
  morphCode + "\nreturn { geometryProfileFrom, waistHipRatio, makeMorphologyFilter, MORPH_EMA_ALPHA };"
)(CONFIG.MORPH_MIN_SAMPLES, CONFIG.MORPH_PROFILE_SWITCH_FRAMES);
const { geometryProfileFrom, waistHipRatio, makeMorphologyFilter, MORPH_EMA_ALPHA } = morphApi;

/* ── The real prompt builders, executed (same slice image-first.test.mjs uses) ── */
const promptCode = SRC.slice(SRC.indexOf("const P = Object.freeze({ CORE"),
                             SRC.indexOf("/* Full-Look composite clause"));
const sandbox = {
  PROMPT_MAX_CHARS: CONFIG.PROMPT_MAX_CHARS, console: { warn() {}, log() {}, error() {} },
  SUBTYPE_PROMPT: {}, SHIRT_NOUN: { short_sleeve: "t-shirt" },
  colorName: () => "white", activeColorOf: (it) => (it && it.color) || "#fff",
  getSizeDelta: () => 0, getFitModifier: () => "regular fit",
  getAnatomicalAnchor: () => "", getFabricModifier: () => "",
};
const P_API = new Function(...Object.keys(sandbox),
  promptCode + "\nreturn { buildCompositePrompt, imageOnlyPrompt, ANATOMY_LOCK, ANATOMY_GUARDRAIL, DENSE };"
)(...Object.values(sandbox));
const { buildCompositePrompt, imageOnlyPrompt, ANATOMY_LOCK, ANATOMY_GUARDRAIL, DENSE } = P_API;

const SHIRT = { garmentType: "upper_body", name: "Ion Crew Tee" };
const PANTS = { garmentType: "lower_body", name: "Glide Slim" };

console.log("\n── §1 THE CLASSIFIER: the spec's thresholds, and the band between them ──");
{
  /* hip >= shoulder * 0.9 -> curve. Checked ON the boundary, not merely past it: an
     off-by-one from > to >= here silently reclassifies every body sitting exactly at the
     threshold, which is the most populated part of the range. */
  check("hip at exactly 0.9x shoulder classifies curve (the boundary is inclusive)",
    geometryProfileFrom(1.0, 0.9) === "curve", geometryProfileFrom(1.0, 0.9));
  check("a hip-dominant body classifies curve",
    geometryProfileFrom(1.0, 1.05) === "curve");
  check("equal widths classify curve", geometryProfileFrom(1.0, 1.0) === "curve");

  /* shoulder > hip * 1.2 -> broad. EXCLUSIVE, per spec: exactly 1.2x is NOT broad. */
  check("shoulder at exactly 1.2x hip is NOT broad (the boundary is exclusive)",
    geometryProfileFrom(1.2, 1.0) === null, geometryProfileFrom(1.2, 1.0));
  check("a shoulder-dominant body classifies broad",
    geometryProfileFrom(1.3, 1.0) === "broad");

  /* ── THE DEAD BAND IS THE HYSTERESIS, and it is why this feature needs no timer ──
     1/1.2 = 0.8333..., so hip/shoulder in [0.8333, 0.9) matches NEITHER rule. A body
     there gets no anatomy clause at all rather than being forced into one of two
     contradictory draping instructions - which is what would flap frame to frame. */
  check("the band between the two rules classifies as neither",
    geometryProfileFrom(1.0, 0.87) === null, geometryProfileFrom(1.0, 0.87));
  check("...and the band is bounded on both sides, exactly where the two rules meet",
    geometryProfileFrom(1.0, 0.8334) === null && geometryProfileFrom(1.0, 0.8332) === "broad" &&
    geometryProfileFrom(1.0, 0.8999) === null && geometryProfileFrom(1.0, 0.9000) === "curve");

  /* Degenerate input must classify as "no opinion", never as a profile. A zero width is
     what an unreadable or half-occluded skeleton produces. */
  check("zero / negative / non-finite widths classify as null, never a profile",
    geometryProfileFrom(0, 1) === null && geometryProfileFrom(1, 0) === null &&
    geometryProfileFrom(-1, 1) === null && geometryProfileFrom(NaN, 1) === null);
}

console.log("\n── §2 THE WHR ESTIMATE, AND ITS STATED LIMIT ──");
{
  check("WHR is computed and finite for a real body", Number.isFinite(waistHipRatio(1.0, 0.9)));
  check("a hip-dominant body reads a lower WHR than a shoulder-dominant one",
    waistHipRatio(1.0, 1.1) < waistHipRatio(1.3, 1.0));
  check("degenerate widths return null rather than Infinity",
    waistHipRatio(1, 0) === null && waistHipRatio(0, 1) === null);
  /* THE LIMIT IS DOCUMENTED, NOT HIDDEN. BlazePose has no waist landmark - 11/12 jump
     straight to 23/24 - so this is a linear-taper approximation and the file must say so.
     A future reader who believes it is measured would trust it to separate two bodies it
     structurally cannot. */
  check("app.js states that BlazePose has no waist landmark and this is an estimate",
    /NO WAIST LANDMARK/.test(SRC) && /linear/.test(SRC.slice(SRC.indexOf("NO WAIST LANDMARK"),
      SRC.indexOf("NO WAIST LANDMARK") + 700)),
    "an estimate presented as a measurement is worse than no figure");
  check("...and records why the profile branch therefore does NOT read it",
    /geometryProfileFrom\(\) does NOT branch on it/.test(SRC));
}

console.log("\n── §3 THE EMA: smoothing, warm-up, and hold-don't-reset ──");
{
  check("alpha is the spec'd 0.15", MORPH_EMA_ALPHA === 0.15, MORPH_EMA_ALPHA);

  /* WARM-UP. The first sample IS the raw reading (nothing to average against yet), so
     dispatching on it would ship a drape derived from one frame of landmarks. */
  const f = makeMorphologyFilter();
  f.feed({ shoulderW: 1.0, hipW: 1.1 });
  check("one sample is not enough to steer a prompt", f.snapshot() === null);
  for (let i = 1; i < CONFIG.MORPH_MIN_SAMPLES; i++) f.feed({ shoulderW: 1.0, hipW: 1.1 });
  check(`...and MORPH_MIN_SAMPLES (${CONFIG.MORPH_MIN_SAMPLES}) is`, f.snapshot() !== null);
  check("a warmed filter classifies the body it actually saw",
    f.snapshot().profile === "curve", JSON.stringify(f.snapshot()));

  /* ── THE JITTER TEST, and the reason Phase 2 needed a second mechanism ──────────
     A mis-placed hip landmark mid-turn must not move the classification. The EMA alone
     does NOT give this: at alpha 0.15 one blown-out frame takes a body measured at
     shoulder 1.0 / hip 1.1 to 1.3 / 0.965, which reads BROAD - the smoothed widths barely
     moved, but they moved ACROSS A THRESHOLD, which is all it takes when the body sits
     near one. Commit hysteresis is what actually closes it. */
  const before = f.snapshot().profile;
  f.feed({ shoulderW: 3.0, hipW: 0.2 });          // a violently broad single frame
  check("one outlier frame cannot flip the classification",
    f.snapshot().profile === before, `${before} -> ${f.snapshot().profile}`);
  check("...and the EMA still bounds the width error to ~alpha of the way",
    Math.abs(f.snapshot().shoulderWidth - 1.3) < 0.01, f.snapshot().shoulderWidth);
  /* NOR CAN A RUN SHORTER THAN THE THRESHOLD. Checked one frame below the limit, because
     an off-by-one here is the difference between hysteresis and decoration. */
  const nearMiss = makeMorphologyFilter();
  for (let i = 0; i < 20; i++) nearMiss.feed({ shoulderW: 1.0, hipW: 1.1 });
  for (let i = 0; i < CONFIG.MORPH_PROFILE_SWITCH_FRAMES - 1; i++) {
    nearMiss.feed({ shoulderW: 3.0, hipW: 0.2 });
  }
  check(`${CONFIG.MORPH_PROFILE_SWITCH_FRAMES - 1} bad frames still cannot flip it`,
    nearMiss.snapshot().profile === "curve", nearMiss.snapshot().profile);
  nearMiss.feed({ shoulderW: 3.0, hipW: 0.2 });
  check(`...and the ${CONFIG.MORPH_PROFILE_SWITCH_FRAMES}th consecutive one does commit`,
    nearMiss.snapshot().profile === "broad", nearMiss.snapshot().profile);

  /* ── THE BOUNDARY-FLICKER CASE, which is the one that actually happens ──────────
     A body parked exactly ON the curve threshold (hip = 0.9 x shoulder) with ordinary
     landmark jitter either side of it. The EMA converges the smoothed hip onto the
     boundary and leaves a residual wobble of about alpha x the jitter, so the RAW
     classification genuinely alternates curve/null every frame - and it is the committed
     value, not the reading, that a prompt is allowed to see.

     NOTE WHAT THIS IS NOT. Alternating between two EXTREME widths is not this case: that
     is a real, sustained change in the average and the EMA is right to converge on it
     (asserted above). Flicker is a reading that alternates while the body has not moved,
     which is exactly what a threshold-parked build produces. A naive "N of the last M"
     rule would pass the consecutive-run check above and still flicker here. */
  const osc = makeMorphologyFilter();
  for (let i = 0; i < 40; i++) osc.feed({ shoulderW: 1.0, hipW: 0.90 });
  const settled = osc.snapshot().profile;
  let flickered = false;
  for (let i = 0; i < 60; i++) {
    osc.feed({ shoulderW: 1.0, hipW: i % 2 ? 0.92 : 0.88 });   // +/-2% either side
    if (osc.snapshot().profile !== settled) flickered = true;
  }
  check("a body parked on a threshold does not flicker - the committed profile holds",
    !flickered && osc.snapshot().profile === settled,
    `${settled} -> ${osc.snapshot().profile}`);

  /* A SUSTAINED change must still get through - smoothing that never converges is just
     a broken sensor. */
  const g = makeMorphologyFilter();
  for (let i = 0; i < 60; i++) g.feed({ shoulderW: 1.4, hipW: 1.0 });
  check("a sustained change does converge and re-classifies",
    g.snapshot().profile === "broad", JSON.stringify(g.snapshot()));

  /* HOLD, DON'T RESET. An unreadable frame is no information, not a new body - the same
     rule makeBodyTopologyTracker() applies to its baseline. */
  const held = g.snapshot().profile;
  g.feed(null); g.feed({ shoulderW: 0, hipW: 0 }); g.feed(undefined);
  check("unreadable frames HOLD the last good reading rather than clearing it",
    g.snapshot() !== null && g.snapshot().profile === held);

  /* reset() is the session boundary - a new shopper must not inherit the last one's
     proportions. */
  g.reset();
  check("reset() drops the reading entirely (a new session measures a new body)",
    g.snapshot() === null);

  /* NO PER-FRAME ALLOCATION: feed() returns one shared, mutated object, and snapshot()
     is the only thing that copies. Asserted because the perf pass depends on it. */
  const h = makeMorphologyFilter();
  const r1 = h.feed({ shoulderW: 1, hipW: 1 });
  const r2 = h.feed({ shoulderW: 1, hipW: 1 });
  check("feed() mutates one pre-allocated reading instead of allocating per frame",
    r1 === r2, "a fresh object per tick is exactly the GC churn that shows as stutter");
  for (let i = 2; i < CONFIG.MORPH_MIN_SAMPLES; i++) h.feed({ shoulderW: 1, hipW: 1 });
  check("...but snapshot() hands out a COPY, so a frozen dispatch cannot be mutated later",
    h.snapshot() !== h.snapshot() && h.snapshot() !== r1);
}

console.log("\n── §4 THE SHED LADDER - the property combined mode depends on ──");
{
  /* THE BASELINE. Every combined prompt with NO morphology must be byte-identical to what
     shipped before this feature - that is what makes every degraded path a no-op. */
  for (const angle of ["front", "back"]) {
    for (const inProfile of [false, true]) {
      const bare = buildCompositePrompt(SHIRT, angle, inProfile);
      const nulled = buildCompositePrompt(SHIRT, angle, inProfile, null);
      check(`combined ${angle}${inProfile ? "+profile" : ""}: no reading -> byte-identical to pre-feature`,
        bare === nulled && !/Fit to (curved|broad-shoulder) geometry/.test(nulled));
    }
  }

  /* THE LADDER ITSELF. Measured on the real builders, for every combination that ships.
     The invariant is TWO-part and both halves matter:
       (a) nothing ever exceeds the budget, and
       (b) when a clause cannot fit it is SHED WHOLE - so the prompt either contains a
           complete clause or none of it, and the panel contract always survives. */
  let laddered = 0, sheds = 0;
  for (const item of [SHIRT, PANTS]) {
    for (const angle of ["front", "back"]) {
      for (const inProfile of [false, true]) {
        for (const profile of ["curve", "broad"]) {
          const bare = buildCompositePrompt(item, angle, inProfile);
          const out  = buildCompositePrompt(item, angle, inProfile, { profile });
          const tag = `${item === SHIRT ? "top" : "bottom"}/${angle}${inProfile ? "+profile" : ""}/${profile}`;
          laddered++;
          if (out.length > CONFIG.PROMPT_MAX_CHARS) {
            check(`${tag}: OVER BUDGET`, false, `${out.length} chars`);
            continue;
          }
          /* THE PANEL CONTRACT SURVIVES, always. This is the 23f5953 guard: a split
             FRONT|BACK reference with no clause naming which half is in play gets both
             panels painted onto the shopper. */
          if (!out.includes(DENSE.select[angle]) || !out.includes(DENSE.contract)) {
            check(`${tag}: panel contract intact`, false, out);
            continue;
          }
          /* SHED WHOLE, NEVER SLICED. Whatever is present must be present in full. */
          const anat = ANATOMY_LOCK[profile];
          const partialAnat = !out.includes(anat) && out.includes(anat.slice(0, 30));
          const partialGuard = !out.includes(ANATOMY_GUARDRAIL) &&
                               out.includes(ANATOMY_GUARDRAIL.slice(0, 30));
          if (partialAnat || partialGuard) {
            check(`${tag}: clause shed whole, never mid-sentence`, false, out.slice(-160));
            continue;
          }
          if (!out.includes(anat)) sheds++;
          /* And when a clause sheds, the REST of the prompt is untouched - not shortened,
             not re-ordered. A shed that also disturbed the base prompt would be a
             regression wearing the shape of a graceful degrade. */
          if (!out.includes(anat) && out !== bare) {
            check(`${tag}: full shed leaves the base prompt byte-identical`, false,
              `${out.length} vs ${bare.length}`);
            continue;
          }
        }
      }
    }
  }
  check(`all ${laddered} combined permutations fit the budget with the contract intact`, true);
  /* The ladder must actually EXERCISE its shed path. If every permutation happened to
     fit, this suite would be proving nothing about the case it was written for - and a
     future anchor edit could silently push one over without anyone noticing. */
  check("...and the shed path is genuinely reached (not a vacuous pass)",
    sheds > 0, `${sheds} of ${laddered} permutations shed the anatomy clause`);

  /* THE SINGLE-ASSET PATH has room, so it must actually SHIP the clause - otherwise the
     feature is wired but inert, which is the "declared but discarded" failure this file's
     history keeps recording. */
  for (const profile of ["curve", "broad"]) {
    for (const angle of ["front", "back"]) {
      const out = imageOnlyPrompt(SHIRT, angle, { profile });
      check(`single-asset ${angle}/${profile}: the clause actually ships`,
        out.includes(ANATOMY_LOCK[profile]) && out.length <= CONFIG.PROMPT_MAX_CHARS,
        `${out.length} chars: ${out.slice(-120)}`);
    }
  }
  check("the guardrail rides along on the single-asset path too",
    imageOnlyPrompt(SHIRT, "front", { profile: "curve" }).includes(ANATOMY_GUARDRAIL));
  check("...and never appears without an anatomy clause to qualify",
    !imageOnlyPrompt(SHIRT, "front", null).includes(ANATOMY_GUARDRAIL) &&
    !imageOnlyPrompt(SHIRT, "front", { profile: null }).includes(ANATOMY_GUARDRAIL));
}

console.log("\n── §5 THE WIRING: one sampler, frozen snapshots, no live reads ──");
{
  /* ONE INFERENCE PER TICK. The topology block's own comment records why two samplers
     were rejected: double the WASM/GPU cost on a phone, plus MediaPipe's monotonic
     timestamp contract throwing when two callers land on the same millisecond. The
     morphology consumer must therefore read the SAME result, never detect its own. */
  const watcher = SRC.slice(SRC.indexOf("function startPresenceWatcher"),
                            SRC.indexOf("function stopPresenceWatcher"));
  check("the morphology consumer reuses the existing pose result",
    /bodyMorphology\.feed\(bodyScaleMatrix\(sets\.world, sets\.image\)\)/.test(watcher));
  check("...and adds NO second detectForVideo()/detectPoseFrame() call",
    (watcher.match(/detectPoseFrame\(/g) || []).length === 1,
    "a second sampler doubles the inference and can throw on a duplicate timestamp");
  check("...and both consumers extract landmarks through the SAME helper",
    /function torsoLandmarkSets\(/.test(SRC) &&
    /const sets = torsoLandmarkSets\(result\)/.test(watcher) &&
    /const sets = torsoLandmarkSets\(result, minVisibility\)/.test(SRC),
    "two copies of the extraction can drift on the visibility bar and describe different bodies");

  /* THE THIRD FREEZE. angle and profile are snapshotted before applyGarment()'s awaits;
     morphology must be too, or a re-classification mid-await pairs a drape instruction
     with a reference resolved for a different reading. */
  const apply = SRC.slice(SRC.indexOf("async function applyGarment(item) {"),
                          SRC.indexOf("console.group(\"[PEAR] applyGarment() - VTON payload debug\")"));
  check("applyGarment() freezes the morphology beside the angle and the pose",
    /const morphAtStart = activeMorphology\(\);/.test(apply) &&
    apply.indexOf("const morphAtStart") < apply.indexOf("await referenceImageFor"),
    "a read after the await is the mixing bug this file already paid to fix twice");
  check("...and both builders receive the FROZEN snapshot",
    /buildCompositePrompt\(item, angleAtStart, profileAtStart, morphAtStart\)/.test(SRC) &&
    /buildPrompt\(item, angleAtStart, morphAtStart\)/.test(SRC));

  /* NO BUILDER MAY READ THE LIVE FILTER - the structural half of the same guarantee. */
  const builders = SRC.slice(SRC.indexOf("function imageOnlyPrompt("),
                             SRC.indexOf("/* Full-Look composite clause"));
  check("no prompt builder calls activeMorphology() itself",
    !/activeMorphology\(/.test(builders),
    "a live read inside a builder reopens the TOCTOU race on a third axis");

  /* SESSION LIFECYCLE. A new shopper must never inherit the previous one's proportions. */
  check("the filter is built per session and dropped on teardown",
    /bodyMorphology = BODY_TOPOLOGY_ENABLED \? makeMorphologyFilter\(\) : null;/.test(SRC) &&
    /bodyMorphology = null;/.test(SRC.slice(SRC.indexOf("function stopPresenceWatcher"))));
  check("activeMorphology() returns null when there is no filter at all",
    /return bodyMorphology \? bodyMorphology\.snapshot\(\) : null;/.test(SRC),
    "no detector / no session must degrade to the pre-feature prompt, not throw");

  /* The debug group is where a bad drape gets diagnosed; the anatomy line must report
     what the PAYLOAD used, not a fresh read - same discipline as the angle line. */
  check("the payload debug group reports the morphology actually used",
    /console\.log\("anatomy  :", morphAtStart/.test(SRC));
}

console.log("\n── §6 ADDITIVE: the topology monitor's own decisions are untouched ──");
{
  /* THE CRITICAL NON-REGRESSION. This feature may not change WHEN a re-drape fires - that
     is the topology monitor's job and it has its own suite. Morphology must not appear in
     the delta, the shift test, or the tracker. */
  const delta = SRC.slice(SRC.indexOf("function topologyDelta("), SRC.indexOf("function topologyShift("));
  const shift = SRC.slice(SRC.indexOf("function topologyShift("), SRC.indexOf("function makeBodyTopologyTracker("));
  const tracker = SRC.slice(SRC.indexOf("function makeBodyTopologyTracker("),
                            SRC.indexOf("/* MediaPipe's VIDEO running mode rejects"));
  for (const [name, body] of [["topologyDelta", delta], ["topologyShift", shift],
                              ["makeBodyTopologyTracker", tracker]]) {
    check(`${name}() never reads the morphology filter`,
      !/morph/i.test(body), "re-drape timing is not this feature's to change");
  }
  check("bodyContourSignature() still reports exactly its four original channels",
    /return \{ yaw, pitch, depth, build: scale\.build, taper: scale\.taper \};/.test(SRC),
    "adding a channel here would move the tracker's thresholds silently");
  /* The filter is gated on the SAME flag as the tracker - a morphology reading with the
     topology monitor off would measure a body nothing re-conditions against. */
  check("the filter is gated on BODY_TOPOLOGY_ENABLED, like the tracker",
    /bodyMorphology = BODY_TOPOLOGY_ENABLED \?/.test(SRC));
}

console.log(fails ? `\n${fails} check(s) FAILING` : "\nAll morphology checks passing.");
process.exit(fails ? 1 : 0);
