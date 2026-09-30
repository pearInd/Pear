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
 * @property {number}   INPUT_GATE_SETTLE_MS    Extra hold after set() resolves, covering the transport gap between the reference (WebSocket) and the frames (WebRTC media). 0 disables.
 * @property {number}   COLD_START_ACK_MS       Ack window for the FIRST apply of a session (ms) before the automatic reconnect; later applies use APPLY_TIMEOUT_MS.
 * @property {boolean}  PASSTHROUGH_PROBE_ENABLED Hold the reveal until Decart's output measurably differs from the camera input - the ack cannot prove the render switched.
 * @property {number}   PASSTHROUGH_MAX_DELTA   Mean per-cell luma difference (0-255) below which the output is judged to be the input unchanged.
 * @property {number}   PASSTHROUGH_GATE_MAX_MS Ceiling on how long that gate may hold the reveal before showing the feed anyway (ms).
 * @property {number}   COLD_START_REDISPATCH_MS Gap between startup re-dispatches while the output still looks like a passthrough (ms).
 * @property {number}   COLD_START_REDISPATCH_MAX Maximum startup re-dispatches before the gate gives up and reveals.
 * @property {number}   COLD_START_MIN_HOLD_MS  Fixed hold on the reveal after the first otherwise-qualifying frame, covering a reference that was acknowledged but never rendered. 0 disables.
 * @property {number}   COLD_START_REASSERT_MS  How far into that hold the single unconditional re-assert is sent.
 * @property {number}   REFERENCE_RENDER_SETTLE_MS How long after an image ack the reveal still holds - Decart's render wait before it switches off its own prior (ms).
 * @property {number}   REVEAL_SETTLE_MAX_MS    Ceiling on that settle hold, measured from the remote track attaching (ms).
 * @property {number}   FLOOR_ASSET_WAIT_MS     How long connect waits for the garment bytes that seed the SDK's initialState before falling back to the URL (ms).
 * @property {boolean}  BODY_TOPOLOGY_ENABLED   Re-drape the garment on the live body contour whenever it changes, instead of holding the go-live silhouette.
 * @property {number}   BODY_TOPOLOGY_SAMPLE_MS Cadence of the live pose loop that feeds both the presence watcher and the topology monitor (ms).
 * @property {number}   BODY_TRACK_MIN_VISIBILITY Per-landmark visibility bar for TRACKING (below the gate's, so a half-occluded turn is still readable).
 * @property {number}   BODY_ROTATION_DELTA_DEG Yaw/pitch change from the conditioned pose that triggers a re-drape (degrees).
 * @property {number}   BODY_VOLUME_DELTA       Relative torso depth/aspect change that triggers a re-drape (0..1).
 * @property {number}   BODY_RECONDITION_COOLDOWN_MS Minimum gap between two re-conditioning dispatches (ms).
 * @property {number}   BODY_TRACK_HOLD_MS      How long a lost skeleton holds the last valid fit before the baseline is dropped (ms).
 * @property {boolean}  LOWER_BODY_GUARD_ENABLED Composite the shopper's own raw lower-body pixels back over Decart's output (default OFF - validate live first).
 * @property {number}   LOWER_BODY_GUARD_FRAC   Fraction of frame height, from the bottom, that the guard protects.
 * @property {boolean}  LOWER_BODY_GUARD_AUTO_CALIBRATE Derive LOWER_BODY_GUARD_FRAC per-session from a detected face box instead of the fixed fraction.
 * @property {number}   LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS Head-heights from crown to waist, used by the calibration above.
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
  /* ── THE SETTLE - the half of the window the gate above does NOT close (2026-09-16) ──
     THE GATE ABOVE closes the span from "session open" to "rtClient.set() resolved". That
     is not the same span as "Decart is conditioned on this reference", and the difference
     is a TRANSPORT one: @decartai/sdk@0.1.5 sends the reference as one message on the
     SIGNALING WEBSOCKET, while camera frames travel the WebRTC MEDIA path. Two transports,
     no ordering guarantee between them, and set() resolves when the SDK has sent - not
     when the server has ingested and swapped the reference in.

     WHY THE GATE CANNOT SIMPLY WAIT FOR THE REAL ANSWER: there is no acknowledgement to
     wait for. Verified against the installed SDK rather than assumed - RealTimeClient
     exposes connectionChange / queuePosition / error / generationTick / generationEnded /
     diagnostic / stats, and set() is Promise<void>. No "reference applied" event exists,
     so set() resolving is the strongest signal available and the gate already rides it.
     A fixed settle is therefore the only lever left on this window.

     ── 800ms IS A PRODUCT DECISION, NOT A MEASUREMENT, AND THAT IS THE POINT TO READ ──
     It was specified (2026-09-16) before ?cond_trace=1 had been run on a live session, so
     unlike every other number in this file it is NOT backed by a modelled or frame-by-frame
     figure. What IS measured and consistent with it: this file's own COND_TRACE_SETTLE_MS
     (1600ms) exists because "Decart takes ~1s to warm up and switch", so a sub-second hold
     is the right order of magnitude for the server-side half of that.

     WHAT IT COSTS, stated plainly: 800ms is added to EVERY cold start, unconditionally and
     whether or not the window it covers was actually open on that session. It buys nothing
     on a session where the reference already beat the first frame - it simply delays
     go-live. The shopper does not see a freeze (the feed is still at opacity 0 behind the
     reveal gate, so this is latency, not a frozen mirror - see §2.9), but it IS the first
     second of the experience.

     SCOPE: only the go-live gate. release() is a one-shot that a mid-session swap can never
     reach (hold()/unhold() own that path, and release() refuses while held), so this cannot
     put a hold on a turn - which is exactly the freeze §2.9 keeps off by default.

     HOW TO REPLACE THIS GUESS WITH A NUMBER: run one cold session with ?cond_trace=1 and
     read the verdict. "REFERENCE DID NOT REACH THE RENDER" with a settle of 0 and
     "reference reached the render" at 800 brackets the true value; tune from there, or set
     it to 0 if the window was never open. ?gate_settle=<ms> overrides it live for that A/B
     without a deploy. */
  INPUT_GATE_SETTLE_MS: 800,
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
     REPORTED TWICE, WITH A RECORDING BOTH TIMES. 2026-08-24, a hoodie try-on: 00:00-00:03
     renders the shopper's own black t-shirt, completely unconditioned, and the hoodie only
     snaps in at 00:04 when they turn and the topology monitor force-dispatches a re-drape.
     2026-09-16 (pear-tryon-...-FOX-20260916-135759.mp4, v143), the same shape with the
     shopper bare-chested: 0.00-2.82s renders their BARE TORSO - filed as "the engine
     stripped the user's upper body" - and at 2.856s, in one frame, a white/black raglan
     nobody selected appears, which is Decart's generic output, not the chosen garment.

     THE DIAGNOSIS THAT LOOKS RIGHT AND IS NOT: "the first apply never fired". It fires.
     goLive() calls applyConditioningWithRecovery() immediately after waitConnected(), with
     no dependence on pose or movement whatsoever; applyActive() retries twice on its own;
     COLD_START_ACK_MS bounds the ack at 2.5s and reconnects if it does not land; and
     INPUT_GATE_ENABLED withholds camera frames from Decart until the reference is
     acknowledged (INPUT_GATE_SETTLE_MS then holds them a beat longer). Every one of those
     already worked, and a fix aimed at them would have been aimed at nothing.

     WHAT ACTUALLY FAILS IS THE REVEAL GATE. rtClient.set() resolves on `set_image_ack`,
     which acknowledges that the server RECEIVED the reference - not that the render
     pipeline has switched to it. armFirstFrameBilling() then decides the feed is ready
     from three signals, and its own comment already conceded the hole: isDressedFrame()
     "cannot distinguish 'the real garment' from Decart's generic/default output". It is a
     luma probe. It cannot distinguish an unconditioned PASSTHROUGH either - a frame of the
     shopper in their own clothes (or in none) is non-black, perfectly stable, and arrives
     after the ack resolved, so it satisfies all three gates and the feed is revealed on it.

     THE FOURTH SIGNAL, and it needs no model and no dependency: compare Decart's OUTPUT
     against the INPUT this client is sending it. The input throttle already keeps that
     frame on a canvas. If the two are near-identical at 64x36, the pipeline is passing the
     camera through untouched - which is the reported defect, measured rather than inferred.

     AND ITS TWIN, added after the very next session (FOX-...-20260916-142132.mp4): 0.00-3.19s
     of a floral patterned TANK TOP, then the real garment in one frame at 3.254s. An invented
     garment is NOT a passthrough - the delta is large and the probe opens the gate at once -
     but the cause is identical: no pixels to condition on. That is directly observable as
     rtImageOnWire, so the gate holds on "no reference on the wire" as well, and the same
     bounded re-dispatch runs (it re-fetches the Blob, so a transient fetch failure at go-live
     recovers). Neither wait can cost the shopper their 5 seconds: this gate defers
     startBillingWindow(), so the billed window starts when the feed does.

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
     at least see. Past this, the feed is revealed and the console says why.

     ── 2600 -> 5000 (2026-09-21), A PRODUCT DECISION ON WHAT THE GATE IS PROTECTING ──────
     REPORTED: on a slow Decart initialisation the raw webcam feed reached the shopper before
     conditioning took effect - "exposing the user's unconditioned state (e.g. shirtless)
     before jumping to the garment overlay". The gate already existed for exactly this and
     already caught it; what it did not do was hold long enough. 2600 was set as a liveness
     number - comfortably clear of a healthy cold start - and the thing on the other side of
     it was assumed to be a cosmetically wrong render. On a shopper who is changing, it is
     their body. That is a different trade and it is re-taken here in that light.

     WHAT IT COSTS, stated rather than buried: on a genuinely slow init the shopper now waits
     up to 5s behind the loading overlay instead of 2.6s. Nothing is billed for that wait -
     startBillingWindow() fires on the reveal, not on connect - so the cost is perceived load
     time only, and a longer scan overlay is a cheaper failure than an unconditioned frame of
     someone getting dressed.

     WHY 5000 AND NOT "HOLD UNTIL A CONDITIONED FRAME ARRIVES". A gate with no ceiling does
     not degrade to "the shopper waits" - it degrades to FIRST_FRAME_TIMEOUT_MS (15000)
     tearing the session down into a hard error, which shows them nothing at all and bills
     nothing back. 5000 leaves 10s of headroom under that teardown and stays under
     REVEAL_SETTLE_MAX_MS (6000), so the render-settle hold remains the outer bound.
     cold-start-passthrough.test.mjs asserts both relationships from CONFIG rather than from
     a literal, so they are checked on every run rather than remembered.

     THE RESIDUAL IS REAL AND IS NOT CLOSED BY THIS. The gate still fails open at the
     ceiling: past 5000 an unconditioned frame can still be revealed. This buys margin, not a
     guarantee, and there is no guarantee available while a teardown is the alternative. */
  PASSTHROUGH_GATE_MAX_MS: 5000,
  /* ── THE STARTUP RE-DISPATCH, keyed on the gate above ───────────────────────
     While the output is still measurably a passthrough, re-assert the conditioning. This
     is deliberately NOT keyed on a missing ack - a missing ack already has two mechanisms
     behind it (applyActive's own retry and COLD_START_ACK_MS's reconnect), and the failure
     being fixed here is the one where the ack came back FINE and the render did not
     follow. Re-sending on the signal that actually indicates the failure is what makes
     this a fix rather than a fourth retry of something that already succeeded.

     THIS IS THE SAME THING THE TURN AT 00:04 DID, minus the turn. The 2026-08-24 report's
     own evidence is that a re-dispatch lands: reconditionForTopology() force-dispatches on
     movement and the garment appears immediately. That path stays exactly what it is - an
     ongoing motion-refinement loop - and the first drape stops depending on it. */
  COLD_START_REDISPATCH_MS: 500,
  COLD_START_REDISPATCH_MAX: 3,
  /* ── THE MINIMUM COLD-START HOLD, and why it is unconditional ───────────────
     THREE CONSECUTIVE RECORDED SESSIONS (2026-09-16, 13:57 / 14:21 / 17:14) show the same
     shape: the feed is revealed on a frame with no garment on it, the shopper watches that
     for 2.75-3.19s, and the garment lands the instant they start to turn - i.e. when
     reconditionForTopology() force-dispatches a re-drape. The 2026-08-24 report says the
     same thing in the same words. A second full set() lands what the first one did not.

     THE TWO DETECTORS ABOVE COULD NOT CATCH THOSE SESSIONS. The probe only fires when the
     output IS the camera, pixel for pixel; a model that re-renders the shopper undressed,
     or invents a garment, is not a passthrough. `referenceOnWire` only fires when the apply
     went out prompt-only. If Decart acknowledged a reference and simply did not render it,
     both read "conditioned" and the reveal fires on an undressed frame. Measured against
     the recordings: sampling the chest region and comparing it to the reference garment's
     colour does NOT separate the two states reliably (a fixed box tracks the background the
     moment the body turns, and Decart's own colour drift moves the garment away from the
     reference colour anyway), so there is no cheap detector to add here.

     SO THIS ONE DETECTS NOTHING. It holds the reveal for a fixed moment after the frame the
     old gate would have revealed on, and re-asserts the conditioning once inside it - doing
     deliberately, and before the shopper sees anything, what their turn was doing by
     accident three seconds later.

     WHAT IT COSTS, STATED: every cold start waits this long before the feed appears, whether
     or not it needed to, plus one extra reference send. It does NOT cost billed seconds -
     the reveal is what starts the billing window - and it is strictly smaller than the
     2600ms this gate may already hold when a detector does fire. ?cold_hold=<ms> tunes it
     live and ?cold_hold=0 restores the previous behaviour exactly. */
  COLD_START_MIN_HOLD_MS: 1500,
  /* How far into that hold the single re-assert goes out - late enough that the first
     apply's own render has had a chance, since a re-send that overtakes a reference already
     being applied buys nothing.
     IT USED TO SAY "early enough that its render can land before the hold ends", and that was
     the arithmetic of a send, not of a render: 700ms in, a 1500ms hold leaves 800ms, and the
     re-assert still needs its ack AND Decart's render wait after the ack (~1s, see
     REFERENCE_RENDER_SETTLE_MS). So the hold ended INSIDE the re-assert's own generic-garment
     window, and the reveal showed Decart's prior for up to a second before the real garment
     snapped in - reported 2026-09-19 as "a multicolor patterned long-sleeve at 00:00, the
     selected black tee at 00:01". The reveal now waits for that render (REFERENCE_RENDER_SETTLE_MS),
     so the timing here decides only WHEN the re-send goes out, never whether it is seen. */
  COLD_START_REASSERT_MS: 700,

  /* ── THE RENDER WAIT AFTER AN IMAGE ACK - what a reveal must never land inside ──────
     rtClient.set({ image }) resolves on set_image_ack: Decart RECEIVED the reference. The
     render switches to it later - 700-1000ms reported, 780-1100ms measured on the real
     watchdog (app.js, the FRAME_FREEZE_AFTER_SWAP_MS note) - and until it does, the model
     renders from its own prior: a generic garment nobody picked (a raglan, a floral tank, a
     grey sweater, a multicolor long-sleeve - four recordings, one mechanism). Every full
     image upload opens that window, the cold start's own re-assert included.
     So the reveal holds while an image write is in flight or was acknowledged less than this
     long ago. 1200ms covers the measured worst case (1100) with a frame of margin. It costs
     loading time only, never billed seconds: the reveal is what starts the billing window.
     ?settle_hold=0 disables it for a live A/B, exactly as ?cold_hold=0 does the fixed hold.

     ── 1200 -> 1400 (2026-09-22): THE RENDER IS ACKNOWLEDGED BEFORE IT IS FINISHED ──────
     REPORTED: at 00:00-00:01 the garment renders SLEEVELESS - a tank - and the sleeves pop
     in a beat later. The shopper had not picked a tank; PEAR_CATALOG[0] ("Halo Tank",
     subType sleeveless) is the only built-in one and is not on this path. This is the same
     mechanism 448abc6 recorded as "Decart's own prior", seen one stage further along: the
     reference IS acknowledged and the render IS switching to it, but a realtime diffusion
     model resolves a garment coarsely first and the fine geometry - sleeves, cuffs, hems -
     converges late. Reveal inside that and the first dressed frame is a half-built garment.

     1200 WAS SET AGAINST THE WRONG QUANTITY, and reveal-settle.test.mjs's own header says
     so: "NOT PROVEN HERE: that Decart's real render wait never exceeds
     REFERENCE_RENDER_SETTLE_MS." The 780-1100ms this number covers is the measured delay
     until the render STARTS carrying the new reference - the moment the prior stops. It was
     never a measurement of when that render is COMPLETE, and the sleeve report is the
     difference between the two.

     WHY ONLY 1400, WHICH IS LESS THAN THE SYMPTOM PROBABLY NEEDS. 1800 was tried first and
     reveal-settle.test.mjs refused it, for a reason worth writing down because it is not the
     obvious one. The arithmetic ceiling everyone looks at is §7's
     REVEAL_SETTLE_MAX_MS > PASSTHROUGH_GATE_MAX_MS + REFERENCE_RENDER_SETTLE_MS (7000 >
     5000 + this), which allows anything under 2000. The BINDING ceiling is tighter and
     sits elsewhere: the cold-start re-assert comes due at COLD_START_REASSERT_MS (700) and
     is DEFERRED while an upload is still rendering, so a settle longer than
     COLD_START_MIN_HOLD_MS (1500) outlives the hold that would retry it and the re-assert
     is never sent at all - 0 instead of 1, which is what the suite caught.

     AND COLD_START_MIN_HOLD_MS CANNOT SIMPLY FOLLOW IT. §7 also asserts
     COLD_START_MIN_HOLD_MS - COLD_START_REASSERT_MS < 1100 - that the fixed hold CANNOT
     cover a render wait, which is the arithmetic of the original bug and the reason this
     settle gate exists at all. Raising the hold to cover the settle would make the gate
     redundant and re-open that design. So three constants pin each other, and 1499 is the
     real ceiling on this one.

     COST: the loading overlay is up ~200ms longer on every session. No billed seconds -
     startBillingWindow() fires on the reveal, not on connect - so this is perceived load
     time traded against opening on a garment that is still growing its sleeves.

     NOT VERIFIED, AND LIKELY NOT SUFFICIENT ON ITS OWN. Nothing here has timed how long
     sleeve geometry takes to converge, so +200ms is what the constraints allow rather than
     what the symptom was measured to need. If the sleeveless first frame survives this, the
     fix is NOT to keep nudging this number - it is to measure the convergence
     (__pearDebugFrameTiming prints the per-frame trace; watchPostFireLuma() already samples
     past the reveal for exactly this question) and then decide whether the
     hold/re-assert/settle trio needs re-deriving together. ?settle_hold=0 A/Bs it. */
  REFERENCE_RENDER_SETTLE_MS: 1400,
  /* The ceiling on that hold, from the moment the remote track attaches - the same anchor
     PASSTHROUGH_GATE_MAX_MS uses. Bounded independently because it must be able to outlast
     that gate: a re-dispatch sent just before that ceiling still has a render to wait out.
     Every re-send is capped (COLD_START_REDISPATCH_MAX + one re-assert), so the hold is
     finite by construction; this is the backstop, kept far inside FIRST_FRAME_TIMEOUT_MS
     (15s) so a gate can never turn a slow render into a torn-down session.

     ── 6000 -> 7000 (2026-09-21), DRAGGED BY THE PASSTHROUGH CEILING ─────────────────────
     THESE TWO CONSTANTS ARE COUPLED, and the coupling is an assertion, not a convention:
     reveal-settle.test.mjs §7 requires

         REVEAL_SETTLE_MAX_MS > PASSTHROUGH_GATE_MAX_MS + REFERENCE_RENDER_SETTLE_MS

     because a re-dispatch fired in the last instant before the passthrough gate expires
     still needs its full render wait covered. Raising the passthrough ceiling 2600 -> 5000
     for the bare-body report made the old 6000 fail that (6000 > 6200 is false), and a
     settle ceiling that expires DURING a late re-dispatch's render is the 00:00 prior bug
     (448abc6) reached from the other side - the reveal would land inside the render it was
     built to wait out. So this moves with it rather than the test being relaxed.

     7000 is the smallest round value clearing 6200 while staying under the suite's other
     bound, REVEAL_SETTLE_MAX_MS < FIRST_FRAME_TIMEOUT_MS / 2 (7500). That leaves only 500ms
     of headroom there: if PASSTHROUGH_GATE_MAX_MS is ever raised again, this cannot simply
     follow it, and FIRST_FRAME_TIMEOUT_MS becomes the thing to reconsider first. */
  REVEAL_SETTLE_MAX_MS: 7000,
  /* How long connectRealtime() waits for the garment's BYTES before opening a session.
     The conditioning floor is sent inside the SDK's join and acknowledged before any video is
     published, so it has to exist before connect() is called at all. Waiting for the bytes
     rather than handing the SDK a URL means the floor is the SAME Blob applyGarment() sends
     (one prewarm cache), which is what lets the go-live apply recognise it as already on the
     wire instead of uploading it a second time. On timeout the proxied URL is used - the SDK
     fetches that itself before the join - so a slow CDN costs latency, never the garment. */
  FLOOR_ASSET_WAIT_MS: 6000,

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
  /* Floor between two re-conditioning dispatches. Each one is a full set() with the
     reference image attached, so this is the knob that decides how much of a 5s window
     a continuously-moving shopper can spend re-uploading a packshot. ~5 per session. */
  BODY_RECONDITION_COOLDOWN_MS: 900,
  /* How long a lost skeleton is HELD before the monitor gives up on the last valid
     reading. Sharp rotations black out the landmarks for a few frames; holding the last
     good fit across that gap and resuming from it is the difference between "the garment
     rode the turn" and "the garment re-derived itself from a frame with no body in it".
     Past this, the baseline is dropped and the next clean read re-acquires from scratch. */
  BODY_TRACK_HOLD_MS:      1500,

  /* ── secure proxy endpoints (same-origin; see ../server.js) ─────────────── */
  TOKEN_ENDPOINT:  "/api/realtime-token",
  HEALTH_ENDPOINT: "/api/health",

  /* ── Decart SDK sources (tried in order) ─────────────────────────────────
     Source / dev: the two CDN builds of the pinned version. The PRODUCTION bundle
     (scripts/build.mjs) defines PEAR_SDK_BUNDLE as the path of the same pinned
     version, bundled from node_modules and served from our own origin - so the
     shipped page never names a third-party CDN URL that spells out the vendor, and
     esbuild folds the CDN branch away entirely. Keep the version in lockstep with
     package.json's @decartai/sdk (the build refuses to run when they differ). */
  SDK_URLS: Object.freeze(typeof PEAR_SDK_BUNDLE === "string" ? [PEAR_SDK_BUNDLE] : [
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

  /* ── lower-body compositing guard - a CODE-level backstop, not a prompt ──────
     THE HONEST REASON THIS EXISTS. @decartai/sdk@0.1.5's realtime set()/setPrompt()
     accept exactly { prompt, enhance, image } (setInputSchema, z.core.$strip - unknown
     keys are DISCARDED, not forwarded, confirmed against the compiled SDK, not just its
     types). There is no mask, ROI, region or segmentation parameter on this API surface
     at all - "enforce strict regional masking" is not a config to turn on, because Decart
     never exposes one. A prompt can ASK the model not to touch the trousers; nothing in
     this SDK can make that a hard guarantee. This is the one lever that can: composite
     the shopper's OWN, unedited lower-body pixels back over whatever Decart rendered
     there, in the browser, after the fact - so even a full hallucinated tuxedo below the
     belt never reaches the screen.

     WHY IT DEFAULTS OFF, and this is load-bearing, not caution theatre. The boundary is a
     FIXED FRACTION of frame height (LOWER_BODY_GUARD_FRAC below) - there is no body-part
     detector in this codebase to derive it from the shopper's ACTUAL waist position, and
     adding one (MediaPipe/BodyPix or similar) means a multi-MB WASM+model CDN dependency,
     which this codebase has already rejected once for the same reason on the upload
     detector (see UPLOAD's own comment: "against this codebase's 'bulletproof,
     self-contained, no external path to break' ethos"). A fixed fraction is therefore a
     GUESS calibrated to nothing about the actual shopper: framed close to camera, it can
     clip into the bottom of a correctly-rendered SHIRT, restoring raw unedited pixels
     across a band of garment that was fine - trading an occasional hallucination for a
     guaranteed visible seam on every session. That trade is not obviously a win, and
     nobody has watched it happen on a real camera yet. Flip LOWER_BODY_GUARD_ENABLED to
     true only after a live check confirms the seam sits below real trousers, not across
     a shirt hem, for how this app is actually framed in practice. */
  LOWER_BODY_GUARD_ENABLED: false,
  /* Fraction of the camera-card's frame HEIGHT, measured from the bottom, that gets the
     shopper's own raw camera pixels composited back over Decart's output. 0.34 is a
     rough midpoint for a torso-forward selfie framing (roughly waist-down) - conservative
     on purpose: erring toward occasionally missing a sliver of upper trouser is a much
     smaller visible defect than erring toward clipping into the rendered shirt. Tune only
     against a live camera, never by reasoning about it in the abstract. */
  LOWER_BODY_GUARD_FRAC: 0.34,
  /* Auto-calibrates LOWER_BODY_GUARD_FRAC once per session from a detected face box
     (FaceDetector - the same browser API the orientation watcher already uses, no new
     dependency) instead of relying on the one fixed guess above for every shopper at
     every distance from the camera. See calibrateLowerBodyGuard()'s own comment in
     app.js for the method and its honest limits. Falls back to the static
     LOWER_BODY_GUARD_FRAC whenever no face is found or FaceDetector is unavailable, so
     turning this off just means "always use the fixed fraction" - the guard itself is
     still governed entirely by LOWER_BODY_GUARD_ENABLED above. */
  LOWER_BODY_GUARD_AUTO_CALIBRATE: true,
  /* Head-heights from crown to waist - the classic figure-drawing/anthropometric
     convention (~7.5 head-heights top to sole; waist sits roughly half that up from the
     ground, around 3.5-4 heads down from the crown). 3.8 is a reasonable adult default,
     not a measurement of any specific shopper. Assumes an adult, upright, roughly
     front-facing posture; children are proportioned differently (relatively larger
     heads) and this app already tracks a kids/adult signal elsewhere
     (resolvedGarmentAgeGroup() in app.js) that a future refinement could read to pick a
     different ratio - not wired up here, so this stays the same class of change as the
     guard itself: one clear, testable mechanism, not several unvalidated ones at once. */
  LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS: 3.8,

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
