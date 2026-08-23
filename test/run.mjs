#!/usr/bin/env node
/* =============================================================================
   PEAR - back-view regression suite.   Run with:  npm test
   -----------------------------------------------------------------------------
   These cover the failure modes that made the back of a garment render blank, or
   render the FRONT print, and that were previously only verifiable by loading a
   real storefront in a browser:

     url-identity     One photo served under many URLs (?width=, ?v=, _800x
                      suffixes, image resizers) must compare EQUAL, and genuinely
                      different photos must not. A false "distinct" pair is what
                      bound the front image as the back reference - and the model
                      was then told "reproduce the BACK", so it reproduced the
                      chest print on the back.
     view-resolution  Which photo becomes the front, which becomes the back, and
                      where the back came from - including the guards that refuse
                      a "back" that is really the front.
     composite        The Stitched Garment Composite layout contract: FRONT panel
                      left, BACK panel right, spec geometry, size cap, and null
                      (never a half-drawn reference) on failure. Also the ARTIFACT
                      contract - a seamless sampled gutter with NO divider drawn, and
                      markers in a band below the garments - because a hard edge or
                      text inside the reference comes back painted on the shopper.
     prompt-only-flip A turn re-sends the prompt, never the reference image. Re-
                      uploading the composite mid-rotation is what made the back print
                      flicker and vanish inside the 5s billed window.
     side-profile     The 90-degree turn: at a side-on pose the orientation lock rightly
                      HOLDS, but the pose sentence used to hold with it - so the prompt
                      asserted "FACING FORWARD" over pixels showing the shopper edge-on,
                      and reconciling that flattened their real torso depth (the pillow-
                      under-a-shirt case). Asserts the pose/panel split, the depth clause
                      on every builder, and - most importantly - that the edge-on signal
                      stays on its own channel and can never move the asset lock.
                      Also the LATERAL band: at 90 degrees the flank/side seam/underarm is
                      photographed by NEITHER panel, and an unreferenced region gets filled
                      with the cheapest completion available - the shopper's own shirt. The
                      synthesis clause is asserted to be geometric (wrap + extrapolate the
                      cloth) and NOT a cross-panel blend, which would contradict the
                      impassable-wall contract and re-open the 23f5953 double-print bug.
     image-first      "I picked a Spider-Man tee and it rendered a tuxedo." The reference
                      image was resolved, composited and delivered correctly; the model
                      simply was not using it. Decart's set() takes { prompt, image,
                      enhance } and nothing else - no negative_prompt, no image-strength -
                      so the only lever over how hard the image is weighed against the
                      text is HOW MUCH TEXT there is, and every builder was opening with a
                      garment DESCRIPTION assembled from catalog fields ("white t-shirt:
                      exact colour, texture and print") that the model could satisfy from
                      its own prior instead. The enumerated ban meant to stop it ("never
                      invent a ... suit, TUXEDO, tie, BOWTIE") shipped inside the POSITIVE
                      prompt, where a named garment is a token the sampler can steer
                      toward. Asserts the spec'd anchor's exact wording and its per-region
                      variants (an "upper garment" anchor on a trouser reference is the
                      same contradiction, reintroduced by the fix), that it leads every
                      builder and never sheds, that NO builder describes a garment any
                      more - stated as an absence, the only form that catches a new
                      well-meant clause being added - and that the payload actually
                      carries an image, since an image-first prompt with nothing on the
                      wire is the same failure through the other half of the call.
     garment-category-prompt
                      "I tried on JEANS and it put the catalog model's SHIRT on me."
                      The image-first fix froze the prompt into ONE string for the whole
                      catalog - and that string opened "Fit a standard t-shirt from the
                      reference image". On a trouser product it is a flat contradiction:
                      the prompt names a t-shirt, the reference photographs a model wearing
                      a shirt AND trousers, and nothing said which half was the product, so
                      the source model's shirt replaced the shopper's real one. The prompt
                      now branches on garment category - the anchor names the layer being
                      replaced AND pins the opposite layer to the live camera, which is what
                      the retired KEEP_TOP/KEEP_BOTTOMS used to do, folded into the one
                      sentence that cannot be shed. Asserts the classification (garmentType
                      outranks the Hebrew/English keyword fallback, and "short_sleeve" never
                      reads as "shorts"), both anchors' exact wording, that neither branch
                      preserves the layer it is itself replacing, that both fit the token
                      budget, and that EVERY builder branches - with the full-look builder
                      asserted as the deliberate exception, since it substitutes both layers
                      on purpose.
     model-agnostic   "It gave me the e-commerce model's shoulders." Every body-shape
                      defence in app.js aims at the model's TRAINING prior; none accounted
                      for the second human in the conditioning - a catalog reference is
                      almost always model-worn. IGNORE_SOURCE_ARTIFACTS is scoped to
                      non-human noise, so that figure was never named as off-limits.
                      Asserts the provenance split (cloth from the reference, body from the
                      live feed), that re-proportioning the garment is NOT licence to move
                      its print (which would fight BACK_TAIL.real's placement pin), that
                      ALL SIX builders carry it - parity with STRICT_INPAINT, since this
                      file already records a clause being missed at one site - and that it
                      is NOT pose-gated, unlike the two genuinely edge-on clauses.
     body-topology    "I turned 90 degrees and my shirt stretched with me." The body was
                      established ONCE, by the go-live presence gate, and never re-asked -
                      so the render stayed conditioned on the frame it was born in, and a
                      model handed a body that no longer matches its conditioning does the
                      cheapest thing available and DEFORMS the drape it already has. The
                      fix splits the two halves that were being fused: the GARMENT is
                      static and invariant, the BODY is dynamic and lives only in the
                      current frame. A continuous monitor re-measures the torso every tick
                      (yaw, pitch, depth, profile box - all scale-invariant, so walking
                      toward the lens is not a change of shape) and forces a REAL
                      re-conditioning dispatch when the live body has moved away from the
                      shape the current render was drawn against. Asserts the geometry,
                      the thresholds, the baseline semantics that make a slow turn fire at
                      all (it compares against the CONDITIONED shape, never the previous
                      frame), the hold-and-resume fallback for a body that goes unreadable
                      mid-rotation, that the dispatch actually reaches the wire past
                      applyGarment's no-op skip - and, most importantly, that the monitor
                      can never touch the garment half: no asset selection, no prompt edit,
                      no reference read.
     first-frame-integrity
                      "It renders a grey sweater for a second, then my shirt." Raw camera
                      frames start flowing the instant the WebRTC session opens, and
                      rtClient.set() - the call that delivers the reference - lands strictly
                      after that. In the window between the two, Decart is asked to render a
                      dressed person with nothing but its own prior, and its prior is a plain
                      grey top. The three existing reveal gates cannot catch it: a generic
                      sweater is not black, does not flicker, and arrives after the apply
                      resolved - armFirstFrameBilling's own comment names the hole. The fix is
                      upstream: withhold FRAMES (never the track - captureStream(0) emits only
                      on requestFrame, so the handshake is unaffected) until the garment is
                      acknowledged, so there is no window in which a default can be generated.
                      Asserts the gate on the REAL throttle driven against a fake camera, that
                      it opens from the single call site that means "a garment is on the wire",
                      that it self-releases loudly rather than stranding a session, the
                      prefetch that keeps the gated window short (every item now, not only
                      dual-view ones - and warm bytes ONLY, never a fetch moved onto the
                      go-live path), and the frame budget on the wire.
     turn-hold        The last dressed frame is held from the FIRST sign of a turn, not
                      from the confirmed flip 2.5s later - the uncovered window is where
                      the shopper's real shirt came back. Plus every release path,
                      because a stuck hold hides the live feed entirely.
     prompt-reanchor  The garment renders, then quietly reverts part-way through the
                      session. Transitions re-issue the prompt (maybeUpdateProfile on an
                      autoProfile flip, maybeSwap on a front/back flip) but a shopper who
                      simply HOLDS a pose triggers neither, so the steering prompt is
                      asserted once at go-live and never again - against a diffusion
                      prior pulling toward "the person as photographed" the whole time.
                      Asserts the periodic re-anchor fires on cadence at EVERY pose (not
                      just edge-on), that the cadence is DERIVED from LIVE_DURATION_MS
                      rather than hardcoded (a hardcoded 4000ms inside a 5000ms billed
                      window could fire at most once, far too late for a reversion seen
                      ~2s in), that it respects the applying mutex / disposed / isLive /
                      isGarmentApplied guards, swallows a failed attempt instead of
                      throwing, shares timestamp bookkeeping with maybeUpdateProfile so a
                      transition and a scheduled re-anchor never double-fire, and that
                      its telemetry is session-relative so console output can actually be
                      lined up against a screen recording.
     signaling-retry  "WebSocket is not open" thrown from the SDK's signaling channel
                      during go-live (openAndJoin's join-frame race, see the SDK's
                      signaling-channel.js) used to fail the whole session with zero
                      retry. One bounded, narrowly-matched retry now covers it -
                      asserted here, including that a REAL auth/permission failure
                      still fails on the first attempt.
     reconnect        The SDK already retries a dropped mid-session connection
                      internally ("reconnecting", 5 attempts, 1-10s backoff) - but its
                      own recovery resends only the garment/pose that was live at the
                      ORIGINAL go-live moment, silently discarding every later swap or
                      rotation. Asserts the re-apply that fixes it fires only on a
                      genuine recovery (never the first connect), that a permanently
                      exhausted reconnect retires the session instead of leaving
                      billing/watcher timers running against nothing, and that a
                      normal user-initiated Stop can never re-enter that same path.
     apply-timeout    The initial rtClient.set() at go-live had no timeout of its own,
                      unlike the connect and first-frame stages either side of it. An
                      SDK-internal reconnect tearing down that call's transport in the
                      first second (and never rejecting the orphaned promise) could hang
                      it forever - "connected" already showing, the shopper's real
                      camera already live under it, the garment never arriving, no
                      error. Then the bound started firing for real, and ENDING the
                      session on it turned out to be the wrong response: shoppers got
                      "המדידה החיה נכשלה: timeout ממתין ליישום הבגד" in a modal for a
                      stage whose likeliest cause is a transport still settling - or, before
                      the wire mutex landed, a SECOND set() colliding with this one (goLive
                      arms the orientation watcher before its own first apply, so a shopper
                      already standing edge-on trips a pose transition inside ~500ms). The
                      timeout now buys ONE recovery: reset the client, re-send a lightweight
                      payload carrying the pristine garment image, and say so in a toast.
                      Asserts the race against APPLY_TIMEOUT_MS, that the recovery fires
                      exactly once and in order, that it is scoped to TIMEOUTS (a definite
                      failure still propagates unmodified rather than spending a second
                      token to fail again), that a session superseded on either leg bails
                      instead of continuing go-live's success path, that a SECOND failure
                      still ends the session visibly, and that a late settlement after the
                      timeout already won never surfaces as an unhandled rejection.
     variant-sync     A colour swatch moved the reference PHOTO and nothing else: the
                      prompt still named the item's BASE colour and the cart still sent
                      the base SKU, so Decart got a red packshot told it was black and a
                      shopper could buy a colour they never picked. Also the host bridge -
                      pearGetActiveGarment() correctly returns null with nothing selected,
                      but lux-interactions.js did `|| {}` and posted sku:"" to the store,
                      under an optimistic toast claiming success. Plus the detection
                      aspect-ratio gate, which rejects the plausible-SIZE/implausible-SHAPE
                      crops (shadow bands, wall columns) that every existing area gate
                      passes straight through to the VTON backend.
     widget-dom       The REAL widget file, executed in jsdom against realistic
                      Shopify / WooCommerce / noscript / image-resizer markup.
                      Asserts the gallery is actually discovered on a lazy-loaded
                      gallery, which is the bug that started all of this.

   No network, no API keys, no camera - everything here is deterministic and runs
   in about a second. What it CANNOT cover is called out in the summary.
   ============================================================================= */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUITES = [
  ["url-identity", "url-identity.test.mjs"],
  ["view-resolution", "view-resolution.test.mjs"],
  ["composite", "composite.test.mjs"],
  ["widget-dom", "widget-dom.test.mjs"],
  ["widget-combined", "widget-combined.test.mjs"],
  ["thumbnail", "thumbnail.test.mjs"],
  ["composite-handoff", "composite-handoff.test.mjs"],
  ["eager-composite", "eager-composite.test.mjs"],
  ["pending-flag", "pending-flag.test.mjs"],
  ["pending-gate", "pending-gate.test.mjs"],
  ["image-bytes-cache", "image-bytes-cache.test.mjs"],
  ["angle-race", "angle-race.test.mjs"],
  ["preload-composite", "preload-composite.test.mjs"],
  ["prompt-only-flip", "prompt-only-flip.test.mjs"],
  ["side-profile", "side-profile.test.mjs"],
  ["image-first", "image-first.test.mjs"],
  ["garment-category-prompt", "garment-category-prompt.test.mjs"],
  ["garment-category-detection", "garment-category-detection.test.mjs"],
  ["body-presence-gate", "body-presence-gate.test.mjs"],
  ["model-agnostic", "model-agnostic.test.mjs"],
  ["body-topology", "body-topology.test.mjs"],
  ["morphology-refit", "morphology-refit.test.mjs"],
  ["hot-path-perf", "hot-path-perf.test.mjs"],
  ["first-frame-integrity", "first-frame-integrity.test.mjs"],
  ["turn-hold", "turn-hold.test.mjs"],
  ["prompt-reanchor", "prompt-reanchor.test.mjs"],
  ["signaling-retry", "signaling-retry.test.mjs"],
  ["reconnect", "reconnect.test.mjs"],
  ["rtc-error-boundary", "rtc-error-boundary.test.mjs"],
  ["look-stitch-bar", "look-stitch-bar.test.mjs"],
  ["single-surface", "single-surface.test.mjs"],
  ["cold-start-and-pin", "cold-start-and-pin.test.mjs"],
  ["proportions-and-backswap", "proportions-and-backswap.test.mjs"],
  ["apply-timeout", "apply-timeout.test.mjs"],
  ["outfit-slot-isolation", "outfit-slot-isolation.test.mjs"],
  ["variant-sync", "variant-sync.test.mjs"],
  ["decart-debug-log", "decart-debug-log.test.mjs"],
  ["kids-adult-size-guard", "kids-adult-size-guard.test.mjs"],
  ["size-mismatch-view", "size-mismatch-view.test.mjs"],
  ["cart-size-variant", "cart-size-variant.test.mjs"],
  ["kids-product-sizes", "kids-product-sizes.test.mjs"],
  ["camera-lifecycle", "camera-lifecycle.test.mjs"],
];

let failed = 0;
for (const [name, file] of SUITES) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  process.stdout.write(`\n─── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}\n`);
  const r = spawnSync(process.execPath, [path], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");

  if (/ERR_MODULE_NOT_FOUND/.test(out) && /jsdom/.test(out)) {
    console.log("SKIPPED - jsdom not installed. Run: npm install");
    continue;
  }
  // Only the verdict lines, so the suite output stays readable; the widget file
  // logs heavily by design and that noise belongs in a browser console, not here.
  const lines = out.split("\n").filter((l) => /^(PASS|FAIL|SKIP)/.test(l) || /^\s{8}\S/.test(l));
  console.log(lines.join("\n") || out.trim());
  if (r.status !== 0) failed++;
}

console.log("\n" + "═".repeat(64));
if (failed) {
  console.log(`${failed} suite(s) FAILING`);
  process.exit(1);
}
console.log("All suites passing.");
console.log(
  "\nNot covered here (needs a live environment):\n" +
  "  · Gemini classification accuracy and the generated rear view (needs GEMINI_API_KEY)\n" +
  "  · The Decart realtime session and the actual garment warp\n" +
  "  · Camera orientation detection - see archive/BACK-VIEW-DIAGNOSTICS.md §4 for the\n" +
  "    console trace that verifies it against a real webcam."
);
