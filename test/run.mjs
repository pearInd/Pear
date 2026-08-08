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
  ["turn-hold", "turn-hold.test.mjs"],
  ["prompt-reanchor", "prompt-reanchor.test.mjs"],
  ["signaling-retry", "signaling-retry.test.mjs"],
  ["reconnect", "reconnect.test.mjs"],
  ["apply-timeout", "apply-timeout.test.mjs"],
  ["outfit-slot-isolation", "outfit-slot-isolation.test.mjs"],
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
