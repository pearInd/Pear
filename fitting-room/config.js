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
