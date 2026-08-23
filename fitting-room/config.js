/**
 * config.js - Single source of truth for the PEAR fitting room.
 * ----------------------------------------------------------------------------
 * Every configurable timing and endpoint the client uses lives HERE and nowhere
 * else. `app.js` imports these derived constants; it must not redefine them.
 *
 * ⚠️ Endpoints are served by the secure proxy in `../server.js`. The browser
 *    only ever talks to these same-origin paths - it never holds the permanent
 *    `dct_` key; it receives short-lived `ek_` tokens from `TOKEN_ENDPOINT`.
 *
 * @typedef {Object} PearConfig
 * @property {number}   CONNECT_TIMEOUT_MS      Max wait for the realtime session to report "connected" (ms).
 * @property {number}   APPLY_TIMEOUT_MS        Max wait for the initial rtClient.set() (garment apply) at go-live to settle (ms).
 * @property {number}   HEALTH_PROBE_TIMEOUT_MS Abort window for the pre-use connectivity probe (ms).
 * @property {number}   TOAST_DURATION_MS       On-screen toast lifetime (ms).
 * @property {string}   TOKEN_ENDPOINT          Same-origin proxy route that mints the ephemeral ek_ token.
 * @property {string}   HEALTH_ENDPOINT         Same-origin proxy health route used by the pre-use check.
 * @property {string[]} SDK_URLS                Ordered Decart SDK CDN fallbacks.
 * @property {number}   PROMPT_MAX_CHARS        Hard cap on any assembled prompt (Decart rejects >226 tokens).
 * @property {boolean}  INPUT_GATE_ENABLED      Withhold camera frames from Decart until the garment reference is acknowledged, so its first rendered frame can never be a generic default.
 * @property {number}   INPUT_GATE_MAX_MS       Self-release ceiling for that gate (ms) - a caller that never reports success costs a late start, never a dead session.
 * @property {number}   COLD_START_ACK_MS       Ack window for the FIRST apply of a session (ms) before the automatic reconnect; later applies use APPLY_TIMEOUT_MS.
 * @property {boolean}  PASSTHROUGH_PROBE_ENABLED Hold the reveal until Decart's output measurably differs from the camera input - the ack cannot prove the render switched.
 * @property {number}   PASSTHROUGH_MAX_DELTA   Mean per-cell luma difference (0-255) below which the output is judged to be the input unchanged.
 * @property {number}   PASSTHROUGH_GATE_MAX_MS Ceiling on how long that gate may hold the reveal before showing the feed anyway (ms).
 * @property {number}   COLD_START_REDISPATCH_MS Gap between startup re-dispatches while the output still looks like a passthrough (ms).
 * @property {number}   COLD_START_REDISPATCH_MAX Maximum startup re-dispatches before the gate gives up and reveals.
 * @property {number}   ERROR_MODAL_THRESHOLD   Consecutive rtClient errors inside ERROR_WINDOW_MS before the shopper is shown a modal; below it they are logged and the SDK recovers.
 * @property {number}   ERROR_WINDOW_MS         Rolling window for that count (ms).
 * @property {boolean}  BODY_TOPOLOGY_ENABLED   Re-drape the garment on the live body contour whenever it changes, instead of holding the go-live silhouette.
 * @property {number}   BODY_TOPOLOGY_SAMPLE_MS Cadence of the live pose loop that feeds both the presence watcher and the topology monitor (ms).
 * @property {number}   BODY_TRACK_MIN_VISIBILITY Per-landmark visibility bar for TRACKING (below the gate's, so a half-occluded turn is still readable).
 * @property {number}   BODY_ROTATION_DELTA_DEG Yaw/pitch change from the conditioned pose that triggers a re-drape (degrees).
 * @property {number}   BODY_VOLUME_DELTA       Absolute torso-depth change that triggers a re-drape (0..1) - the front-to-back axis.
 * @property {number}   BODY_BUILD_DELTA        Relative shoulder-to-torso / hip-to-shoulder change that triggers a re-drape (0..1) - the narrow-vs-wide axis.
 * @property {number}   BODY_RECONDITION_COOLDOWN_MS Minimum gap between two re-conditioning dispatches (ms).
 * @property {number}   CONDITION_DEBOUNCE_MS   Trailing-edge coalescing window before a re-drape dispatches (ms); capped by the cooldown as a max-wait.
 * @property {number}   BODY_TRACK_HOLD_MS      How long a lost skeleton holds the last valid fit before the baseline is dropped (ms).
 * @property {boolean}  LOWER_BODY_GUARD_ENABLED Composite the shopper's own raw pixels back over Decart's output for the region NOT being fitted - the only hard guarantee against an invented non-target garment.
 * @property {number}   LOWER_BODY_GUARD_FRAC   Fraction of frame height, from the bottom, that the guard protects when no pose reading is available.
 * @property {boolean}  LOWER_BODY_GUARD_AUTO_CALIBRATE Derive LOWER_BODY_GUARD_FRAC per-session from a detected face box instead of the fixed fraction.
 * @property {number}   LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS Head-heights from crown to waist, used by the calibration above.
 * @property {number}   BODY_GUARD_MARGIN_FRAC  How far past the hip line the guard boundary sits, as a fraction of torso length, always away from the region being fitted.
 * @property {number}   BODY_GUARD_FEATHER_FRAC Height of the alpha ramp across the guard boundary, as a fraction of frame height - what stops it being a hard-edged composite.
 * @property {number}   MORPH_MIN_SAMPLES       EMA samples required before a body-geometry classification may steer the prompt.
 * @property {number}   MORPH_PROFILE_SWITCH_FRAMES Consecutive agreeing readings before a new body geometry is committed.
 * @property {number}   PLAYOUT_DELAY_HINT      Chromium RTCRtpReceiver.playoutDelayHint (seconds). 0 = render ASAP.
 * @property {boolean}  PREFER_LOW_LATENCY_CODEC Opt-in SDP codec-preference munge (default OFF - see note below).
 * @property {string[]} CODEC_PREFERENCE        Codec order tried when the munge flag is ON (reorder only, never remove).
 * @property {number}   VIDEO_TARGET_BITRATE_KBPS Max video bitrate forced into the m=video SDP (b=AS, kbps). 0 disables the munge.
 */

/** @type {Readonly<PearConfig>} */
export const CONFIG = Object.freeze({
  /* ── timings (milliseconds) ─────────────────────────────────────────────── */
  CONNECT_TIMEOUT_MS:      12000,  // max wait for the WebRTC session to reach "connected"
  /* Nothing previously bounded the FIRST rtClient.set() at go-live: waitConnected()
     covers reaching "connected", FIRST_FRAME_TIMEOUT_MS covers a rendered frame ever
     arriving, but the set() call itself sat in between, unguarded. If the underlying
     transport it was writing to got torn down and rebuilt by the SDK's OWN internal
     reconnect (media/signaling hiccups are most likely in exactly this first-second
     window) and the SDK never rejects the now-orphaned promise, this awaited forever -
     "connected" was already showing (onConnectionChange fires independently), the
     shopper's real camera feed was already live under it, and the garment simply never
     arrived, with no error and no retry. Bounded here the same way the two neighbouring
     stages already are. */
  APPLY_TIMEOUT_MS:        10000,  // max wait for the initial garment apply to settle
  HEALTH_PROBE_TIMEOUT_MS: 4000,   // pre-use /api/health probe abort window
  TOAST_DURATION_MS:       2600,   // toast visible duration
  /* Tier-2 garment classification (see resolveGarmentCategory). Deliberately short: it
     runs only for titles the keyword tier could not read, its answer only refines a
     category that is already usable, and it sits on the path to go-live. Expiring is a
     normal outcome here, not an error - the tier-1 default stands. */
  CATEGORY_LLM_TIMEOUT_MS: 2500,

  /* ── First-frame integrity + cold start ──────────────────────────────────
     REPORTED, from a screen recording: for the first second of a session Decart renders a
     generic grey long-sleeve sweater, and only at ~00:02 does the requested shirt appear.
     The reveal was already gated three ways (the apply resolved, the frame is non-black,
     and it held for 3 frames / 300ms) and a generic sweater passes all three - it is not
     black and it does not flicker. The frame existed at all because raw camera frames
     start flowing the moment the session opens, BEFORE the reference has been delivered,
     so Decart was asked to dress somebody using only its own prior.
     THE GATE WITHHOLDS FRAMES, NOT THE TRACK: captureStream(0) emits only on
     requestFrame(), so a gated throttle is a live video track with nothing on it - the
     handshake completes normally and there is simply nothing to generate from until the
     garment is acknowledged. See createThrottledInputStream(). */
  INPUT_GATE_ENABLED: true,
  /* Belt and braces on the gate: it self-releases after this long no matter what, so a
     path that never reports a successful apply costs a late start rather than a session
     that renders nothing at all. Sits comfortably under FIRST_FRAME_TIMEOUT_MS (the
     all-or-nothing teardown) so the self-release always gets a chance to save the session
     before that fires. Reaching it is a bug in the caller and logs as one. */
  INPUT_GATE_MAX_MS: 6000,
  /* THE COLD-START LEASH, and it is deliberately far shorter than APPLY_TIMEOUT_MS.
     REPORTED: the first attempt often hangs and the shopper has to close and reopen the
     widget. APPLY_TIMEOUT_MS (10s) is the right bound for "this session is dead", but as
     the FIRST thing a shopper experiences it is an eternity - they give up and reopen
     long before it fires, which is the reported behaviour rather than a separate bug.
     2.5s is past the p99 of a healthy first apply and well inside a shopper's patience,
     so the automatic reconnect happens instead of the manual one. Only the FIRST apply of
     a session uses it; everything after keeps the full budget. */
  COLD_START_ACK_MS: 2500,

  /* ── THE PASSTHROUGH GATE - what the ack cannot tell you ────────────────────
     REPORTED WITH A RECORDING: a Stitch hoodie try-on. For 00:00-00:03 the shopper's own
     black t-shirt renders completely unconditioned. At 00:04 they turn, the topology
     monitor force-dispatches a re-drape, and the hoodie snaps into place.

     THE DIAGNOSIS THAT LOOKS RIGHT AND IS NOT: "the first apply never fired". It fires.
     goLive() calls applyConditioningWithRecovery() immediately after waitConnected(),
     with no dependence on pose or movement whatsoever; applyActive() retries twice on its
     own; COLD_START_ACK_MS bounds the ack at 2.5s and reconnects if it does not land; and
     INPUT_GATE_ENABLED withholds camera frames from Decart entirely until the reference is
     acknowledged. Every one of those already worked.

     WHAT ACTUALLY FAILS IS THE REVEAL GATE. rtClient.set() resolves on `set_image_ack`,
     which acknowledges that the server RECEIVED the reference - not that the render
     pipeline has switched to it. armFirstFrameBilling() then decides the feed is ready
     from three signals, and its own comment already conceded the hole: isDressedFrame()
     "cannot distinguish 'the real garment' from Decart's generic/default output". It is a
     luma probe. It cannot distinguish an unconditioned PASSTHROUGH either - a frame of the
     shopper in their own clothes is non-black, perfectly stable, and arrives after the ack
     resolved, so it satisfies all three gates and the feed is revealed on it.

     THE FOURTH SIGNAL, and it needs no model and no dependency: compare Decart's OUTPUT
     against the INPUT this client is sending it. The input throttle already keeps that
     frame on a canvas. If the two are near-identical at 64x36, the pipeline is passing the
     camera through untouched - which is the reported defect, measured rather than inferred.

     IT CAN ONLY EVER SAY "DEFINITELY PASSTHROUGH". #aiVideo lags the input by roughly a
     second, so on a shopper who is moving at all the two frames disagree for ordinary
     reasons and the gate opens. Only a near-perfect match ACROSS that latency gap - which
     for a live human is essentially impossible unless nothing is being rendered - holds it
     shut. Every ambiguous case fails open, the same convention sampleVideoLuma() uses. */
  PASSTHROUGH_PROBE_ENABLED: true,
  /* Mean absolute per-cell luma difference (0-255) below which the output is judged to be
     the input unchanged. Two DIFFERENT frames of the same still scene, one of them a
     diffusion render, differ by far more than this; the same frame compared with itself
     differs by ~0. 4.0 sits well below the noise floor of a real render and well above the
     JPEG/scaling noise of a genuine passthrough, so it separates the two cleanly without
     needing to be tuned per camera. */
  PASSTHROUGH_MAX_DELTA: 4.0,
  /* How long the passthrough gate may hold the reveal before giving up and showing the
     feed anyway. A GATE THAT CAN HANG A SESSION IS WORSE THAN THE DEFECT IT PREVENTS:
     FIRST_FRAME_TIMEOUT_MS would eventually tear the session down and show the shopper a
     hard failure, which is a strictly worse outcome than an unconditioned render they can
     at least see. Past this, the feed is revealed and the console says why. */
  PASSTHROUGH_GATE_MAX_MS: 2600,
  /* ── THE STARTUP RE-DISPATCH, keyed on the gate above ───────────────────────
     While the output is still measurably a passthrough, re-assert the conditioning. This
     is deliberately NOT keyed on a missing ack - a missing ack already has two mechanisms
     behind it (applyActive's own retry and COLD_START_ACK_MS's reconnect), and the failure
     being fixed here is the one where the ack came back FINE and the render did not
     follow. Re-sending on the signal that actually indicates the failure is what makes
     this a fix rather than a fourth retry of something that already succeeded.

     THIS IS THE SAME THING THE TURN AT 00:04 DID, minus the turn. The report's own
     evidence is that a re-dispatch lands: reconditionForTopology() force-dispatches on
     movement and the garment appears immediately. That path stays exactly what it is - an
     ongoing motion-refinement loop - and the first drape stops depending on it. */
  COLD_START_REDISPATCH_MS: 500,
  COLD_START_REDISPATCH_MAX: 3,

  /* ── The transient-error boundary (see rtClient.on("error") in app.js) ──────
     REPORTED as "the session crashes after ~5 seconds". It did not crash: 5s is
     LIVE_DURATION_MS, the billed window, and the deliberate rtClient.disconnect() that
     closes it emits a parting "error" like any WebRTC transport being torn down. The
     handler was unconditional, so the normal, successful end of EVERY session painted a
     failure modal over the frozen result. The generation/isLive checks in that handler are
     what fix that specific case; these two numbers cover the other half - a real but
     TRANSIENT error mid-stream.

     WHY A COUNT AND NOT A BOOLEAN: the SDK already reconnects internally (5 attempts) and
     signals genuine death by driving the connection state to "disconnected", which
     app.js's onConnectionStateChange retires the session on. So one "error" event means a
     frame dropped and the recovery is already running - interrupting the shopper for it is
     strictly wrong. Three inside four seconds is a transport that is failing rather than
     hiccupping, and by then the SDK is most of the way through its own attempts anyway.
     The window is rolling and per-session (the counter lives in the connect closure), so
     three spread across a long session never accumulate into a false alarm. */
  ERROR_MODAL_THRESHOLD: 3,
  ERROR_WINDOW_MS: 4000,

  /* ── Body-presence gate (see awaitBodyPresence in app.js) ────────────────
     Decart conditions on the frame it is handed, and the session is hard-capped at
     LIVE_DURATION_MS. Going live while the shopper is still out of shot spends the whole
     billed window on a render fitted to an empty room. This gate refuses to open the
     session until a body is actually there - the same credit-saving shape as
     cameraLooksBlack(), which sits directly above it in goLive(). */
  POSE_GATE_ENABLED:       true,
  POSE_MIN_CONFIDENCE:     0.78,  // per-landmark visibility bar; spec floor is 0.75
  POSE_CONSECUTIVE_FRAMES: 4,     // spec range 3-5; one lucky frame is not presence
  POSE_SAMPLE_MS:          120,   // ~8/s - fast enough to feel instant, cheap enough to idle
  /* PROCEEDS on expiry, never refuses. A detector that cannot see the shopper must not
     veto a session they explicitly asked for - the gate is an optimisation, the try-on
     is the product. Sized to cover "walk back to where you were standing". */
  POSE_GATE_TIMEOUT_MS:    12000,
  /* MediaPipe Tasks Vision, pinned. PRELOADED during Screen 2 (see preloadPoseDetector)
     rather than fetched at go-live: this is a multi-MB WASM runtime, and putting that
     download on the critical path of the feature meant to fix first-try reliability
     would defeat the feature. Every failure to load degrades to the native
     FaceDetector engine the orientation watcher already runs. */
  POSE_WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  POSE_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/" +
                  "pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  POSE_TASKS_MODULE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",

  /* ── Continuous body-topology monitor (see startBodyTopologyTracking in app.js) ──
     THE PRINCIPLE THIS ENFORCES: the GARMENT is static and invariant - one reference
     image, one cut, one colour, for the whole session. The BODY is not. It rotates, it
     leans, it gains profile depth when the shopper turns side-on or puts a cushion under
     their shirt. The gate above is a one-shot question ("is anyone there?") asked once at
     go-live; everything after it used to treat that first silhouette as the shape the
     garment was fitted to for the rest of the window, so a shopper who turned 90 degrees
     got the 0-degree drape STRETCHED over a side-on body instead of a fresh drape over
     the side-on contour.
     This block turns the same detector into a continuous monitor: it re-reads the torso
     topology every tick and, when the live body has genuinely moved away from the shape
     the current render was conditioned on, asks Decart to re-drape against the CURRENT
     frame. It never touches the garment reference, which is exactly the invariant half.

     COSTS ARE REAL, so the thresholds are set to fire on events and not on fidgeting: a
     re-conditioning frame is a full rtClient.set() (the prompt is constant, so setPrompt()
     alone is provably a no-op - see applyGarment's skip), which re-uploads the packshot
     inside a billed window. BODY_RECONDITION_COOLDOWN_MS is what bounds that. */
  BODY_TOPOLOGY_ENABLED:   true,
  /* How often the topology is RE-EVALUATED - not how often the camera is sampled. The
     live pose loop runs on the presence cadence (POSE_SAMPLE_MS * 2) and feeds both
     consumers off ONE detectForVideo() call; this throttles the topology consumer on top
     of that, to ~3 evaluations per second.
     THE FLOOR IS THE WIRE, NOT THE CPU. A shift can dispatch a full rtClient.set() with
     the reference attached, and re-evaluating faster than the signaling channel can
     absorb is how a set() ends up with no response at all - the reported
     "rtClient.set לא הגיב" timeout. 350ms sits inside the 300-500ms band that keeps this
     to 2-3 evaluations/s, and BODY_RECONDITION_COOLDOWN_MS then bounds how many of those
     may actually reach the wire. An earlier revision drove the whole LOOP at 200ms for
     this consumer's benefit, which raised the cost of the expensive half (the WASM/GPU
     inference) to speed up the cheap half (arithmetic on four landmarks). */
  BODY_TOPOLOGY_SAMPLE_MS: 350,
  /* Per-landmark visibility bar for TRACKING, deliberately below POSE_MIN_CONFIDENCE
     (0.78, the bar for opening a billed session). A shoulder that is half-occluded
     mid-turn is exactly the frame this monitor most needs to read, and holding it to the
     gate's bar would blind the monitor during the rotation it exists to track. Below this
     the frame is treated as UNREADABLE rather than as a new shape - which is what drives
     the hold-and-resume fallback. */
  BODY_TRACK_MIN_VISIBILITY: 0.5,
  /* Rotation (yaw or pitch) away from the conditioned pose that counts as a new body.
     15 degrees is the spec'd figure and it is a sensible one: a shopper shifting weight
     moves the shoulder line by a few degrees, a deliberate turn clears this within a
     couple of samples. */
  BODY_ROTATION_DELTA_DEG: 15,
  /* Relative change in the torso's depth/aspect signature that counts as a volumetric
     change - the cushion-under-the-shirt case, and any other contour expansion the
     skeleton can actually see. 0.18 = 18%, comfortably above landmark jitter (a few
     percent between adjacent frames) and below a real change in profile. */
  BODY_VOLUME_DELTA:       0.18,
  /* Relative change in the subject's BUILD - shoulder-to-torso, or the hip-to-shoulder
     taper - that counts as a different body to drape for. This is the WIDTH axis, and it
     is the one a garment's cut actually has to track: a slender build needs the shirt
     scaled down cleanly rather than left hanging off the shoulders, a broader one needs it
     stretched along the outer torso rather than clipped. Nothing else this monitor
     measures can tell those apart - yaw and pitch are orientation, and depth is the
     front-to-back axis, so a narrow and a wide shopper at the same angle look identical
     on all three.
     15%, slightly tighter than the volume threshold, because these are ratios of two
     confidently-placed joints rather than an estimated depth: the landmark noise floor is
     lower, so the bar can be. It is comfortably above the frame-to-frame jitter of a
     shoulder landmark and well below the gap between two genuinely different builds. */
  BODY_BUILD_DELTA:        0.15,
  /* Floor between two re-conditioning dispatches. Each one is a full set() with the
     reference image attached, so this is the knob that decides how much of a 5s window
     a continuously-moving shopper can spend re-uploading a packshot. ~5 per session. */
  BODY_RECONDITION_COOLDOWN_MS: 900,

  /* ── Condition-sync debounce (see the topology sampler in app.js) ───────────
     A COALESCING WINDOW, not a rate limit - BODY_RECONDITION_COOLDOWN_MS above is the
     rate limit and it is the stricter of the two. The difference is WHICH EDGE fires.

     The cooldown fires on the LEADING edge: the first threshold crossing dispatches
     immediately, which lands mid-movement. applyGarment()'s own flicker-fix comment
     records what that costs - swapping the reference while the shopper is turning is
     exactly when a print flickers or smears - and re-conditioning against a transient
     half-turn pose asks the model to re-drape for a shape the body is already leaving.

     This waits for the movement to SETTLE and then dispatches once, against the pose the
     shopper actually came to rest in. 250ms is long enough to swallow the frames of a
     turn (the sampler ticks at BODY_TOPOLOGY_SAMPLE_MS = 350ms, so this is under one
     tick of extra latency) and short enough to feel immediate.

     IT HAS A MAX-WAIT, and without one this would be a bug rather than a feature: a
     shopper who never stops moving would reset the timer forever and get NO re-drape at
     all - the exact opposite of continuous re-fitting. The pending dispatch fires no
     later than BODY_RECONDITION_COOLDOWN_MS after the first shift that started it, so
     continuous rotation still re-conditions on the cooldown's own cadence. */
  CONDITION_DEBOUNCE_MS: 250,
  /* How long a lost skeleton is HELD before the monitor gives up on the last valid
     reading. Sharp rotations black out the landmarks for a few frames; holding the last
     good fit across that gap and resuming from it is the difference between "the garment
     rode the turn" and "the garment re-derived itself from a frame with no body in it".
     Past this, the baseline is dropped and the next clean read re-acquires from scratch. */
  BODY_TRACK_HOLD_MS:      1500,

  /* ── THE NON-TARGET REGION GUARD ────────────────────────────────────────────
     Composite the shopper's OWN untouched camera pixels back over the region that is NOT
     being fitted, in the browser, after Decart's frame comes back. Decart's realtime
     set() exposes { prompt, enhance, image } and NO mask channel, so a region cannot be
     protected on the server at all. Words can ask; only the client can guarantee.

     THE REPORT IT EXISTS FOR: trying on a SHIRT, the shopper lifts a leg into frame
     wearing light blue shorts, and Decart renders black long trousers over it.

     ── THIS FLAG HAS MOVED FOUR TIMES. READ THE ARC BEFORE MOVING IT AGAIN ──────
     1. OFF at birth, for a stated reason: "there is no body-part detector in this
        codebase to derive [the boundary] from the shopper's ACTUAL waist position, and
        adding one means a multi-MB WASM+model CDN dependency" - so the boundary was a
        fixed fraction of frame height, "a GUESS calibrated to nothing about the actual
        shopper" that could "clip into the bottom of a correctly-rendered SHIRT".
     2. ON, because that dependency arrived anyway: MediaPipe Pose was taken on for the
        presence gate and runs continuously for the topology monitor, and it reports
        LEFT_HIP/RIGHT_HIP - the exact landmark the objection said was unobtainable.
     3. OFF again after a recording showed the lower half of the canvas as a solid black
        rectangle with a hard seam across the middle.
     4. DELETED outright after a third report of the same split, with a condition
        attached to any restore: it "must not be a hard-edged rectangular composite over
        a diffusion output".

     ── WHY IT IS ON NOW, AND WHAT HAD TO BE TRUE FIRST ─────────────────────────
     Step 3 was diagnosed as the hip line sitting mid-frame. It was not. Restoring the
     code revealed that updateBodyGuardLine() - the function that reads the hip line -
     was called from inside armFirstFrameBilling()'s `if (frameTimingDebug)` block, on a
     `result` variable that does not exist in that scope. So in every session that was
     ever shipped or reported: the call never ran (debug off), and would have been handed
     `undefined` if it had. bodyGuardLine was ALWAYS null, guardBand() ALWAYS fell through
     to the static fraction, and what three reports were filed against was the
     fixed-fraction guess of step 1 - the one the original objection predicted would fail
     exactly this way. The hip-derived boundary that justified step 2 has never once run.
     It is wired into the real pose loop now, next to the `result` it needs.

     THE OTHER TWO DEFECTS ARE ANSWERED IN app.js, not here, and both are structural:
       · THE BLACK BAND. The source was drawImage(#webcam, ...), and #webcam is
         visibility:hidden for all of .show-live while the input throttle re-negotiates
         the shared camera source underneath it. The band now sources the throttle's OWN
         canvas - the frames actually being sent to Decart - which is painting by
         definition whenever there is a session to guard, and is already cover-fitted to
         the same geometry Decart returns. #webcam stays as the fallback.
       · THE HARD SEAM. BODY_GUARD_FEATHER_FRAC ramps alpha across the boundary instead
         of butting two sources together, so a disagreement in exposure or white balance
         reads as a gradient rather than an edge. That is the deletion's condition met.

     IF IT IS REPORTED A FOURTH TIME, this flag is not the fix - the mechanism is. */
  LOWER_BODY_GUARD_ENABLED: true,
  /* Fraction of the frame HEIGHT, measured from the bottom, that gets the shopper's own
     raw camera pixels composited back over Decart's output when NO pose reading is
     available (detector still loading, landmarks below the tracking bar, a browser with
     no WebAssembly). 0.34 is a rough midpoint for a torso-forward selfie framing.
     THIS IS THE FALLBACK, NOT THE BOUNDARY. It is the number the original objection was
     written about, and it is only ever reached on frames the hip line could not be read
     from. Guarding on a rough boundary beats not guarding at all now that the failure it
     prevents is reproduced - but the pose-derived line is what normally runs. */
  LOWER_BODY_GUARD_FRAC: 0.34,
  /* Auto-calibrates LOWER_BODY_GUARD_FRAC once per session from a detected face box
     (FaceDetector - the Shape Detection API primitive the orientation watcher already
     uses, not a new dependency). Refines only the FALLBACK above; the pose-derived hip
     line outranks it whenever one is available. Degrades silently to the static
     LOWER_BODY_GUARD_FRAC whenever no face is found or FaceDetector is unavailable, so
     this can stay on with no failure path of its own. Whether the guard runs at all is
     still governed entirely by LOWER_BODY_GUARD_ENABLED above. */
  LOWER_BODY_GUARD_AUTO_CALIBRATE: true,
  /* Head-heights from the crown to the waist, the figure-drawing proportion the
     calibration above multiplies a detected face box by. 3.8 is the standard adult
     figure ratio (~7.5 heads tall, waist at roughly half). A child or a heavily
     foreshortened close-up has a different ratio - not wired up here, so this stays the
     same class of change as the guard itself: one clear, testable mechanism. */
  LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS: 3.8,
  /* How far past the hip line the guard boundary is pushed, as a fraction of the measured
     TORSO LENGTH, always AWAY from the region being fitted. The hip line is where the two
     body halves meet, not where a garment ends: a shirt hem routinely falls a little below
     the hips, and trousers ride a little above them. Guarding right at the line would clip
     whichever garment overhangs it - the exact seam-across-a-hem defect the feature was
     held back for. A tenth of a torso is a few centimetres on a real body: enough to clear
     a normal hem, small enough that a hallucination cannot hide in it.
     Scaled by torso length rather than frame height so it means the same thing whether the
     shopper is standing close or far back. */
  BODY_GUARD_MARGIN_FRAC: 0.10,
  /* Height of the alpha ramp across the guard boundary, as a fraction of frame height.
     THIS IS THE DELETION'S CONDITION, expressed as a number: "anything that brings it
     back must not be a hard-edged rectangular composite over a diffusion output". Two
     sources that disagree on exposure, white balance or latency show that disagreement as
     a visible line when they are butted together, and as a gradient when they are ramped.
     0.06 is roughly a finger's width at typical framing - long enough to read as a blend
     rather than an edge, short enough that the guarded region is still genuinely the
     shopper's own pixels rather than a half-strength wash over Decart's invention.
     Set to 0 to composite with a hard edge; that is the configuration that was reported
     three times, so it is not the default. */
  BODY_GUARD_FEATHER_FRAC: 0.06,

  /* ── Morphological re-fitting (see the MORPHOLOGICAL RE-FITTING block in app.js) ──
     How many EMA samples must land before a body-geometry classification is allowed to
     steer the prompt. At the pose loop's 240ms cadence this is ~1s of tracking.

     THE WARM-UP IS THE WHOLE POINT. With alpha = 0.15 the filter's first sample IS the
     raw reading - there is nothing to average against yet - so dispatching on it would
     ship a drape instruction derived from exactly one frame of landmarks, which is the
     jitter the EMA exists to remove. Below this count snapshot() returns null and the
     anatomy clause is simply not injected: the prompt falls back to the category anchor
     it shipped before this feature existed, which is a safe default rather than a guess. */
  MORPH_MIN_SAMPLES:       6,
  /* Consecutive smoothed readings that must agree before a NEW body geometry replaces
     the committed one.

     THE EMA ALONE IS NOT ENOUGH, and this is the measured reason rather than a guess. At
     alpha = 0.15 one wild frame moves the estimate 15% of the way to it - which bounds
     the MAGNITUDE of the error but not its CONSEQUENCE, because a body already sitting
     near a classification threshold only needs a small push to cross it. A shopper
     measured at shoulder 1.0 / hip 1.1 (curve) reclassifies as broad off a SINGLE
     blown-out frame, even though the smoothed widths barely moved.

     Committing only after N consecutive agreeing readings makes that structurally
     impossible: the outlier has to persist to be believed, which is precisely the
     difference between a landmark glitch and a shopper who actually turned or swapped
     places with someone else. Three at the pose loop's 240ms cadence is ~0.7s of
     agreement - fast enough to feel live, long enough that no single frame decides. */
  MORPH_PROFILE_SWITCH_FRAMES: 3,

  /* ── secure proxy endpoints (same-origin; see ../server.js) ─────────────── */
  TOKEN_ENDPOINT:  "/api/realtime-token",
  HEALTH_ENDPOINT: "/api/health",

  /* ── Decart SDK CDN fallbacks (tried in order) ──────────────────────────── */
  SDK_URLS: Object.freeze([
    "https://esm.sh/@decartai/sdk@0.1.5",
    "https://cdn.jsdelivr.net/npm/@decartai/sdk@0.1.5/+esm",
  ]),

  /* ── prompt token budget - a HARD API limit, not a style preference ─────────
     Decart rejects an over-long prompt outright:
       "Prompt is too long: 1376 tokens (maximum 226, including the end-of-sequence
        token). Please shorten the prompt."
     set() fails, connectRealtime()'s caller surfaces it, and the shopper gets no garment
     at all. A blunter prompt that RUNS beats a perfectly-argued one that never reaches
     the model, so every builder in app.js assembles against this cap and sheds its
     lowest-priority clauses until it fits (see fitPrompt()).

     WHY 700 AND NOT 904. The limit is in TOKENS; this budget is in CHARACTERS, because
     the browser has no tokenizer and shipping one would cost more than it saves. English
     prose runs ~4 chars/token - which places that rejected 1376-token prompt at ~5,500
     characters, so 226 tokens is ~904. 700 keeps ~22% headroom for the two things that
     tokenize WORSE than prose and that these prompts are full of: ALL-CAPS words and
     heavy punctuation, both of which split into more tokens per character. Lower this if
     a real prompt is ever rejected again; raising it spends that margin. */
  PROMPT_MAX_CHARS: 650,


  /* ── realtime latency tuning (CLIENT-side only) ─────────────────────────────
     ⚠️ Scope reality check: the ~1s a user perceives in the Lucy-VTON feed is
     dominated by SERVER-SIDE neural inference + network RTT, neither of which is
     tunable from the browser. The knobs below only trim the CLIENT jitter buffer
     / decode path - a real but bounded win (tens of ms). They are applied via a
     native-RTCPeerConnection hook in app.js because the SDK (LiveKit) owns the
     peer connection; app.js never sees the receiver or SDP directly. */
  /* ── THE STUTTER KNOB. Was 0, and 0 is what produced the freeze report ───────
     "Plays fine for a second, freezes for 1-2s, resumes." That is textbook
     zero-jitter-buffer behaviour, and this file's own stats-monitor comment in
     app.js already named it before anyone connected the two: "High jitter +
     playoutDelayHint:0 = visible stutter."

     At 0 the receiver renders each frame the instant it is decodable and holds
     NOTHING in reserve. That is optimal only on a perfectly even arrival rate.
     Real transports are not even - a transient bitrate shift, a TURN relay hiccup,
     one late packet in a frame - and with no buffer to absorb it there is nothing
     to play while the receiver waits, so the picture holds on its last frame until
     the stream catches up. The stall is not a lost connection and never trips any
     connection-state handler; it is the buffer running dry.

     80ms is deliberately small: about one frame at the 10fps inference rate this
     app runs at, so it buys a full frame of slack while adding less latency than
     the neural inference varies by between two consecutive frames. The perceived
     ~1s in this feed is dominated by server-side inference and RTT (see the scope
     note above) - 80ms is inside the noise of that, and it is being traded for the
     difference between a smooth stream and a visible 1-2s freeze.

     Raise toward 0.15 if stutter persists on poor networks; drop back to 0 only to
     reproduce the original report. Also applied as jitterBufferTarget (the standard
     API, in ms) - see the track handler in app.js. */
  PLAYOUT_DELAY_HINT: 0.08,         // seconds of client-side anti-jitter buffering; 0 = render ASAP, and stall on any jitter
  PREFER_LOW_LATENCY_CODEC: true,   // SDP munge ON: codec reorder + b=AS / b=TIAS bandwidth injection.
  // H264 is hardware-decoded on virtually all modern devices (iOS, Android, Windows, Mac);
  // VP8 is software-decoded on most mobile - putting H264 first cuts decode CPU + latency.
  CODEC_PREFERENCE: Object.freeze(["H264", "VP8"]),

  /* Cap our OUTGOING camera bitrate to 2 Mbps (applied via b=AS / b=TIAS in
     setLocalDescription only). Lower encode bitrate → less data per frame → faster
     upload to Decart's servers → lower first-dressed-frame latency.
     768×440 @ 2 Mbps is still sharp; 4 Mbps was overshooting for this resolution.
     NOT applied to setRemoteDescription - Decart's send rate is determined server-side
     via RTCP feedback; the b= line in an answer SDP doesn't override it. */
  VIDEO_TARGET_BITRATE_KBPS: 2000,

  /* ── "Upload Your Own Garment" - client-side detection + crop tuning ─────────
     Every timing / threshold the upload → detect → crop flow uses lives HERE (per
     the project's "zero hardcoded timings" rule); app.js reads CONFIG.UPLOAD and
     never redefines these.

     DETECTOR CHOICE - vanilla canvas, not MediaPipe. MediaPipe's shipped Object
     Detector model (EfficientDet/COCO) has NO apparel classes ("clothing/top/
     bottom/dress" aren't in COCO), so it cannot reliably box garments, and it adds
     a multi-MB WASM+model CDN dependency that can 404 - against this codebase's
     "bulletproof, self-contained, no external path to break" ethos. Instead we use
     a dependency-free background-subtraction + connected-components pass
     (detectGarments() in app.js): estimate the background colour from the image
     border, mask the foreground, dilate to close gaps, then label blobs into
     garment bounding boxes. It runs fully offline and handles flat-lays, white
     backgrounds AND model-worn photos. Swap in MediaPipe later by adding its CDN
     URL here and replacing detectGarments()'s body - the rest of the flow is
     detector-agnostic (it only consumes {xmin,ymin,width,height} boxes). */
  UPLOAD: Object.freeze({
    MAX_BYTES:               12 * 1024 * 1024, // reject uploads larger than 12 MB
    ACCEPT:                  "image/*",        // native file-picker filter

    DETECT_MAX_DIM:          512,   // downscale the longest side to this before analysis (speed)
    BG_SAMPLE_BAND:          0.06,  // fraction of each edge sampled to estimate the background colour
    FG_DIFF_THRESHOLD:       46,    // Euclidean RGB distance from bg above which a pixel is "foreground"
    DILATE_RADIUS:           3,     // morphological dilation (downscaled px) - closes gaps so one garment = one blob
    MIN_BOX_AREA_FRAC:       0.015, // ignore foreground blobs smaller than this fraction of the image
    MAX_BOX_AREA_FRAC:       0.985, // ignore blobs that fill essentially the whole frame (bg-estimate failure)
    MIN_BOX_DIM_FRAC:        0.05,  // ignore slivers thinner than this fraction of the image in either axis
    MERGE_IOU:               0.18,  // merge two boxes overlapping more than this (or on strong containment)
    MAX_BOXES:               6,     // cap on how many detection boxes are drawn

    /* Expand the crop outward so seams/edges aren't clipped. RAISED 0.05 -> 0.12.
       5% was tuned to keep a flat-lay tight, but the detector's box hugs the FOREGROUND
       MASK, and a garment's lowest-contrast pixels - a white collar against a white
       backdrop, a sleeve hem, a dark seam in shadow - are exactly the ones that fall
       outside that mask. A crop that clips them hands Decart a garment whose collar or
       cuff simply ends, and the model completes the boundary itself: invented sleeve
       ends, a re-drawn neckline, a graphic re-flowed to fit the truncated shape.
       12% sits mid-range of the 10-15% asked for and is still well inside
       MAX_BOX_AREA_FRAC, so a padded box cannot grow into the "fills the frame" reject. */
    BOX_PAD_FRAC:            0.12,
    CROP_MAX_DIM:            1024,  // longest side of the exported cropped garment
    CROP_QUALITY:            0.92,  // JPEG quality of the exported crop (data URL handed to rtClient.set)
    SHARPEN_AMOUNT:          0.6,   // mild unsharp mask on the crop to improve graphic/logo legibility without halos (0 = off)

    DETECT_RENDER_DELAY_MS:  240,   // let the modal paint its loading state before the (synchronous) detect pass

    /* ── multi-garment separation + viewfinder labels ────────────────────────
       A person wearing an outfit is one foreground blob; to surface a Top AND a
       Bottom bracket (like the reference), a tall, person-shaped blob is split
       horizontally into two garment zones. Flat-lays with spatially separate
       garments stay separate and are classified by geometry. */
    PERSON_MIN_HEIGHT_FRAC:   0.55, // a blob taller than this fraction of the image = a worn outfit → split Top+Bottom
    PERSON_MAX_ASPECT:        0.85, // …and no wider than this (w/h) to read as a person rather than a wide flat-lay
    SPLIT_TOP_FRAC:           0.56, // the Top garment spans the upper N of the outfit blob
    SPLIT_BOTTOM_FRAC:        0.50, // the Bottom garment starts this far down (slight waist overlap → natural framing)
    FULLBODY_MIN_HEIGHT_FRAC: 0.86, // a single tall, narrow blob at least this tall = a full-body item (dress/jumpsuit)
    MIN_CONFIDENCE:           0.02, // if the best box's area-fraction score is below this → treat as "no clear garment"
    PICK_ANIM_MS:             260,  // crisp click-confirmation animation played before the modal closes
  }),
});
