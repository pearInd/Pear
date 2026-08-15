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
                      error. Asserts the race against APPLY_TIMEOUT_MS, that a real
                      rejection still propagates unmodified, that a session superseded
                      mid-wait bails instead of continuing go-live's success path, and
                      that a late settlement after the timeout already won never surfaces
                      as an unhandled rejection.
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
  ["model-agnostic", "model-agnostic.test.mjs"],
  ["turn-hold", "turn-hold.test.mjs"],
  ["prompt-reanchor", "prompt-reanchor.test.mjs"],
  ["signaling-retry", "signaling-retry.test.mjs"],
  ["reconnect", "reconnect.test.mjs"],
  ["apply-timeout", "apply-timeout.test.mjs"],
  ["outfit-slot-isolation", "outfit-slot-isolation.test.mjs"],
  ["variant-sync", "variant-sync.test.mjs"],
  ["decart-debug-log", "decart-debug-log.test.mjs"],
  ["lower-body-guard", "lower-body-guard.test.mjs"],
  ["kids-adult-size-guard", "kids-adult-size-guard.test.mjs"],
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
