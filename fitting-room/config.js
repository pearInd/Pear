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

  /* ── secure proxy endpoints (same-origin; see ../server.js) ─────────────── */
  TOKEN_ENDPOINT:  "/api/realtime-token",
  HEALTH_ENDPOINT: "/api/health",

  /* ── Decart SDK CDN fallbacks (tried in order) ──────────────────────────── */
  SDK_URLS: Object.freeze([
    "https://esm.sh/@decartai/sdk@0.1.5",
    "https://cdn.jsdelivr.net/npm/@decartai/sdk@0.1.5/+esm",
  ]),

  /* ── realtime latency tuning (CLIENT-side only) ─────────────────────────────
     ⚠️ Scope reality check: the ~1s a user perceives in the Lucy-VTON feed is
     dominated by SERVER-SIDE neural inference + network RTT, neither of which is
     tunable from the browser. The knobs below only trim the CLIENT jitter buffer
     / decode path - a real but bounded win (tens of ms). They are applied via a
     native-RTCPeerConnection hook in app.js because the SDK (LiveKit) owns the
     peer connection; app.js never sees the receiver or SDP directly. */
  PLAYOUT_DELAY_HINT: 0,            // seconds; 0 = decode+render immediately, no anti-jitter buffering (Chromium only)
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

    BOX_PAD_FRAC:            0.05,  // expand the crop outward by this fraction so seams/edges aren't clipped
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
