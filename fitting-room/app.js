/* ============================================================================
   PEAR - Virtual fitting room (Lucy VTON realtime, LIVE-first)
   ----------------------------------------------------------------------------
   Screen 1  Size calculator (required) ─► Screen 2  Isolated try-on room.

   Engine: Decart Lucy VTON realtime ("lucy-vton-latest") over WebRTC (LiveKit).
   Verified against @decartai/sdk@0.1.5:
     • createDecartClient({ apiKey })  - apiKey is a short-lived ek_ token minted
       by the backend (/api/realtime-token); the permanent dct_ key never reaches
       the browser.
     • client.realtime.connect(stream, { model, mirror, onRemoteStream,
                                         onConnectionChange })
     • ConnectionState: connecting|connected|generating|disconnected|reconnecting
     • rtClient.set({ prompt, image, enhance })  - image may be an http(s) URL
     • rtClient.on("error", …)

   Flow: enter room → start camera → connect realtime (badge turns green when the
   session reports "connected"). "Capture & Try On" applies the garment via
   set() and freezes a frame of the AI-dressed output stream onto the canvas.

   A labelled mock remains ONLY behind ?demo=1 for offline dev.
   ============================================================================ */
"use strict";

/* ── configuration (Task 8/9) ─────────────────────────────────────────────────
   All timings and endpoints come from config.js - the single source of truth.
   The browser NEVER holds the permanent dct_ key: the secure proxy (server.js)
   mints a short-lived, scoped, origin-locked ek_ token on demand via
   TOKEN_ENDPOINT, fetched the instant the user goes live (see mintEphemeralToken).
   We destructure the derived constants so existing call sites read naturally.   */
import { CONFIG } from "./config.js";
import { t, setupLangToggle } from "./i18n.js";
const {
  CONNECT_TIMEOUT_MS,
  APPLY_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  TOAST_DURATION_MS,
  CATEGORY_LLM_TIMEOUT_MS,
  POSE_GATE_ENABLED,
  POSE_MIN_CONFIDENCE,
  POSE_CONSECUTIVE_FRAMES,
  POSE_SAMPLE_MS,
  POSE_GATE_TIMEOUT_MS,
  POSE_WASM_BASE,
  POSE_MODEL_URL,
  POSE_TASKS_MODULE,
  INPUT_GATE_ENABLED,
  INPUT_GATE_MAX_MS,
  COLD_START_ACK_MS,
  BODY_TOPOLOGY_ENABLED,
  BODY_TOPOLOGY_SAMPLE_MS,
  BODY_TRACK_MIN_VISIBILITY,
  BODY_ROTATION_DELTA_DEG,
  BODY_VOLUME_DELTA,
  BODY_BUILD_DELTA,
  BODY_RECONDITION_COOLDOWN_MS,
  BODY_SETTLE_DELTA_DEG,
  BODY_SETTLE_MS,
  BODY_TRACK_HOLD_MS,
  TOKEN_ENDPOINT,
  HEALTH_ENDPOINT,
  SDK_URLS,
  PROMPT_MAX_CHARS,
  LOWER_BODY_GUARD_ENABLED,
  LOWER_BODY_GUARD_FRAC,
  LOWER_BODY_GUARD_AUTO_CALIBRATE,
  LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS,
  UI_HOLD_OVERLAYS_ENABLED,
  BODY_GUARD_FEATHER_FRAC,
  BODY_GUARD_MARGIN_FRAC,
  PLAYOUT_DELAY_HINT,
  PREFER_LOW_LATENCY_CODEC,
  CODEC_PREFERENCE,
  VIDEO_TARGET_BITRATE_KBPS,
} = CONFIG;

const DEMO_FLAG = new URLSearchParams(location.search).get("demo") === "1";

/* ── Public demo-widget one-time gate (opt-in, isolated from the main app) ───
   Config-driven via ?demo_gate=1, forwarded by widget/pear-widget.js only when
   the embed sets data-pear-demo-gate - never a hostname/domain check, so this
   can never misfire for a real store's own embed. When DEMO_GATE is false
   (every normal visit - direct app use, or a widget embed without the demo
   attribute) every branch below is skipped entirely and existing behavior is
   unchanged. */
const DEMO_GATE = new URLSearchParams(location.search).get("demo_gate") === "1";
const DEMO_GATE_KEY = "pear_demo_gated_measured";

/* ── Language (i18n.js) ───────────────────────────────────────────────────
   Geo-IP detection, applyLanguage()/setLanguage(), the I18N dictionary, and
   the EN/עב toggle wiring all live in ./i18n.js (imported above) and self-
   init on module load. Only t() and setupLangToggle() are used from here. */
function isDemoGateLocked() {
  if (!DEMO_GATE) return false;
  try { return localStorage.getItem(DEMO_GATE_KEY) === "true"; } catch { return false; }
}

/* Spends this browser's one free demo measurement, then tells the parent page
   (widget/pear-widget.js) so it can lock its on-page button immediately. A
   postMessage (not shared localStorage) is required here because the iframe
   (PEAR_BASE) and the host marketing/store page are generally different
   origins - the message carries no sensitive data, just a lock signal. */
function lockDemoGate() {
  if (!DEMO_GATE) return;
  try { localStorage.setItem(DEMO_GATE_KEY, "true"); } catch {}
  try { window.parent.postMessage({ type: "pear-demo-gate-locked" }, "*"); } catch {}
}

/* Friendly one-time-used screen for demo mode - injected on demand so shipping
   this needs no index.html/style.css changes. Only ever reachable when
   DEMO_GATE is true; the main app never calls this. */
function showDemoGateLockedMessage() {
  hideAllScreen1Forms();
  $("screen-calculator")?.classList.add("active");
  $("screen-fitting")?.classList.remove("active");
  syncEditorialVideo();

  let el = document.getElementById("demoGateLocked");
  if (!el) {
    el = document.createElement("div");
    el.id = "demoGateLocked";
    el.setAttribute("role", "status");
    el.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "text-align:center;gap:12px;padding:48px 24px;";
    el.innerHTML =
      '<div style="font-size:40px;">👗</div>' +
      `<p style="font-size:16px;font-weight:600;margin:0;">${t("demoAlreadyUsed")}</p>`;
    const host = $("sizeForm")?.parentElement;
    if (host) host.appendChild(el);
  }
  el.hidden = false;
}

/* ── Strict live-session lifecycle (credit spend lives here) ─────────────────
   Two windows, set EQUAL so the whole clip is genuine live motion:
     • LIVE_DURATION_MS - the BILLED Decart inference window. Credits accrue here.
     • VIDEO_LENGTH_MS  - the on-screen experience + saved clip length.

   When VIDEO_LENGTH_MS == LIVE_DURATION_MS the frozen-frame hold collapses to zero,
   so the recorded video is the FULL live take - no freeze, no loop, no slow-mo. (To
   bring the freeze tail back, set VIDEO_LENGTH_MS > LIVE_DURATION_MS; the recorder
   then holds the final dressed frame for the difference at no extra billing.)

   BILLING MODEL - Decart charges CREDITS_PER_SECOND credits for every second of
   video generation. The session is HARD-CAPPED at LIVE_DURATION_MS by a setTimeout
   (goLive → liveDurationTimer) that disconnects Decart the instant the window closes,
   so the credits consumed per session are deterministic:

      credits/session = CREDITS_PER_SECOND × (LIVE_DURATION_MS / 1000)
                      = 2 × (5000 / 1000) = 10 credits per 5-second session.

   ⚠️ CRITICAL - the SDK does NOT honour model.fps / model.width / model.height on
   Chromium. Its mirror path uses MediaStreamTrackProcessor (passes every frame
   through, ignoring fps) and its LiveKit publisher hardcodes maxFramerate:30. So
   the ONLY reliable throttle is OUR OWN: createThrottledInputStream() repaints the
   camera onto a canvas at EXACTLY LIVE_INFERENCE_FPS / LIVE_W×LIVE_H and hands the
   SDK that capture stream. The numbers below are therefore actually enforced.

   LIVE_FPS is the LOCAL camera-capture rate (kept higher for a smooth preview);
   LIVE_INFERENCE_FPS is what the throttler downsamples to before the SDK sees it -
   it trims per-frame upload/encode work but does NOT change the per-second credit
   bill, which is governed solely by LIVE_DURATION_MS. */
const LIVE_DURATION_MS    = 5000;   // BILLED Decart window = 5s → hard-capped session; 2 credits/s × 5s = 10 credits
const VIDEO_LENGTH_MS     = 5000;   // == LIVE_DURATION_MS → frozen-hold tail is zero; the 5s clip is all real live motion
const LIVE_FPS            = 15;     // local getUserMedia capture rate (smooth preview; throttled to LIVE_INFERENCE_FPS)
const LIVE_INFERENCE_FPS  = 10;     // frames/s handed to Decart - trims per-frame upload/encode; credits are per-SECOND, not per-frame
                                    //   ENFORCED client-side by createThrottledInputStream() - the SDK's own fps cap is a no-op on Chromium.

/* ── Credit model (Decart bills per second of generation) ────────────────────
   CREDITS_PER_SECOND is the Decart rate; CREDITS_PER_SESSION is DERIVED from the
   hard-capped LIVE_DURATION_MS so the two can never drift - change the duration and
   the per-session cost recomputes automatically. A 5-second session = exactly 10. */
const CREDITS_PER_SECOND  = 2;
const CREDITS_PER_SESSION = CREDITS_PER_SECOND * (LIVE_DURATION_MS / 1000);   // 2 × 5 = 10 credits

/* Safety cap on the wait for Decart's FIRST generated frame. The billed window
   (LIVE_DURATION_MS) is now armed BY that first frame, not by connect - so if a frame
   never arrives (dead session / server stall) nothing else would cap the open session.
   This bounds how long the WebRTC session may stay open with no frame before we tear it
   down, so it can never bill indefinitely. Generous - real warm-up is ~1s. */
const FIRST_FRAME_TIMEOUT_MS = 15000;

/* ── Black-screen / camera-off gate (credit saver) ───────────────────────────
   Before we mint a token or open the billed Decart session, we sample the LOCAL
   webcam and refuse to go live if it's a black screen (lens covered, camera off,
   privacy shutter, or a stream that only ever produces black frames). Streaming a
   black feed to Decart still burns the full CREDITS_PER_SESSION for zero usable
   render, so this pays for itself the first time a user forgets to uncover the lens.

   Two independent signals, sampled from a tiny downscaled canvas (cheap, runs in a
   few ms). A frame is judged "black" if EITHER holds - both thresholds are extreme
   enough that even a dim, poorly-lit but genuinely open camera clears them, so we
   don't false-block a paying user:
     • CAMERA_BLACK_AVG_LUMA   - mean Rec.601 luma (0-255) at/below this ⇒ effectively black.
     • CAMERA_BLACK_PIXEL_FRAC - fraction of near-black pixels at/above this ⇒ covered/off.
   We take the BRIGHTEST of a few spaced samples (auto-exposure warm-up can emit a
   transient black frame right after play()), so only a persistently black feed blocks. */
const CAMERA_BLACK_AVG_LUMA   = 12;     // mean luma ≤ 12/255 ⇒ black feed
const CAMERA_BLACK_PIXEL_CUT  = 16;     // a pixel counts as "near-black" when its luma < this
const CAMERA_BLACK_PIXEL_FRAC = 0.985;  // ≥ 98.5% near-black pixels ⇒ covered lens / camera off
const CAMERA_BLACK_SAMPLES    = 5;      // frames to sample before judging (keep the brightest)
const CAMERA_BLACK_SAMPLE_MS  = 60;     // gap between samples - spans ~300ms of exposure warm-up
// NOTE: the four thresholds above are also reused by armFirstFrameBilling() below to
// verify the FIRST REMOTE (AI-rendered) frame isn't a black warm-up placeholder - same
// "is this frame black" test, just pointed at a different <video> element.

/* Capture + inference resolution. The SDK never forwards model.width/height to the
   session, so resolution MUST be enforced at the track level too - the throttler
   downscales the canvas to LIVE_W×LIVE_H before capture, so Decart receives this
   size rather than the camera's native frame. LOWERED to 512×288 (16:9) to cut
   quality/upload/encode overhead per the cost trade. Tokens scale with FRAMES, not
   pixels, so this lowers visual quality + pipeline cost, not the token count itself. */
const LIVE_W = 512, LIVE_H = 288;

/* Mobile detection (Feature 2 / mobile download fix). Drives two choices:
   (1) the MediaRecorder container - phone galleries reliably ingest H.264 MP4 but
       frequently reject WebM; (2) the save path - iOS Safari ignores <a download>,
       so on mobile we hand the clip to the native share sheet ("Save Video" → gallery).
   iPadOS reports its platform as "Mac", so a touch-capable Mac counts as mobile too. */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);

/* ──────────────────────────────────────────────────────────────────────────
   REAL-TIME LATENCY HOOK - client jitter-buffer trim (best-effort)
   ----------------------------------------------------------------------------
   WHY A HOOK: the Decart SDK (LiveKit under the hood) owns the RTCPeerConnection,
   its receivers, and the SDP. app.js only ever receives the finished MediaStream
   via onRemoteStream - a MediaStream exposes tracks, NOT RTCRtpReceivers or SDP.
   So the only way to reach the remote receiver (for playoutDelayHint) and the
   SDP (for the optional codec munge) is to wrap the *native* RTCPeerConnection
   ONCE, here at module load, BEFORE the SDK is dynamically imported in
   connectRealtime(). Every pc the SDK then creates is our patched instance.

   ⚠️ SCOPE: this only shrinks the CLIENT jitter buffer / decode latency (tens of
   ms). The ~1s a user perceives is dominated by server-side Lucy-VTON inference
   + network RTT, which is NOT addressable from the browser. Every step below is
   feature-detected and try-wrapped so it can never break the realtime session.
   ────────────────────────────────────────────────────────────────────────── */
(function installRealtimeLatencyHook() {
  const Native = typeof window !== "undefined" && window.RTCPeerConnection;
  if (!Native || Native.__pearLowLatencyPatched) return;

  // Move preferred (low-latency / hw-friendly) codecs to the front of the
  // m=video payload list. Conservative: codecs are only REORDERED, never
  // removed, so if the server ignores the hint the session still negotiates.
  // Inject b=AS:<kbps> (RFC 4566) + b=TIAS:<bps> (RFC 3890) into the m=video
  // section, replacing any existing b= lines, to CAP our outgoing camera
  // bitrate at VIDEO_TARGET_BITRATE_KBPS. Applied to setLocalDescription only.
  function mungeSdpBandwidth(sdp) {
    try {
      if (typeof sdp !== "string") return sdp;
      // 0 (or falsy) disables the bandwidth munge entirely - leave SDP untouched.
      if (!VIDEO_TARGET_BITRATE_KBPS) return sdp;
      const kbps = VIDEO_TARGET_BITRATE_KBPS;
      const bps  = kbps * 1000;
      const lines = sdp.split(/\r\n|\n/);
      const mIdx = lines.findIndex((l) => l.startsWith("m=video"));
      if (mIdx === -1) return sdp;

      // Remove any pre-existing b= lines in the video section to avoid duplicates.
      const secEnd = (() => { const i = lines.findIndex((l, j) => j > mIdx && l.startsWith("m=")); return i === -1 ? lines.length : i; })();
      for (let i = mIdx + 1; i < secEnd; ) {
        if (lines[i].startsWith("b=")) lines.splice(i, 1);
        else i++;
      }

      // Insert after m=video and any immediately following c= line.
      let at = mIdx + 1;
      if (at < lines.length && lines[at].startsWith("c=")) at++;
      lines.splice(at, 0, `b=AS:${kbps}`, `b=TIAS:${bps}`);
      return lines.join("\r\n");
    } catch (_) {
      return sdp;
    }
  }

  function mungeSdpPreferCodec(sdp) {
    try {
      if (typeof sdp !== "string") return sdp;
      const lines = sdp.split(/\r\n|\n/);
      const mIdx = lines.findIndex((l) => l.startsWith("m=video"));
      if (mIdx === -1) return sdp;

      const wanted = [];
      for (const name of CODEC_PREFERENCE) {
        const re = new RegExp(`^a=rtpmap:(\\d+)\\s+${name}/`, "i");
        for (const l of lines) {
          const m = l.match(re);
          if (m && !wanted.includes(m[1])) wanted.push(m[1]);
        }
      }
      if (!wanted.length) return sdp;

      const parts = lines[mIdx].split(" ");           // m=video PORT PROTO pt pt …
      const header = parts.slice(0, 3);
      const pts = parts.slice(3);
      const reordered = [
        ...wanted.filter((p) => pts.includes(p)),
        ...pts.filter((p) => !wanted.includes(p)),
      ];
      lines[mIdx] = [...header, ...reordered].join(" ");
      return lines.join("\r\n");
    } catch (_) {
      return sdp;                                     // never let a munge error break negotiation
    }
  }

  function Patched(...args) {
    const pc = new Native(...args);

    // Register every peer connection the SDK creates so the live stats monitor
    // (startStatsMonitor) can read inbound-rtp video stats off the receiving pc.
    // Auto-evict on close so the registry never leaks dead connections.
    try {
      (window.__pearPCs || (window.__pearPCs = new Set())).add(pc);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed") window.__pearPCs.delete(pc);
      });
    } catch (_) {}

    /* (1) CLIENT JITTER BUFFER, on every incoming video track.
       This used to force the buffer to zero ("render ASAP"), which is what produced the
       freeze report - see PLAYOUT_DELAY_HINT's own comment in config.js for why a buffer
       of nothing stalls the picture on any transient bitrate shift rather than absorbing
       it. The value is now a small non-zero target and this hook just applies it.

       BOTH APIs are set from the SAME number, because browser support is split and which
       one wins is not ours to decide: playoutDelayHint is the legacy Chromium property
       (seconds), jitterBufferTarget is the standard replacement (milliseconds) and is what
       current Chrome actually honours. Setting one and not the other means a browser
       upgrade silently changes this app's buffering behaviour. Each is feature-detected
       independently - an `in` guard rather than a UA check - so a browser with neither
       simply keeps its own default, which is the correct fallback: every implementation's
       default is a NON-zero adaptive buffer, and the only way to get the stall back is to
       explicitly ask for zero. */
    pc.addEventListener("track", (e) => {
      try {
        const r = e.receiver;
        if (!r || !e.track || e.track.kind !== "video") return;
        if ("playoutDelayHint" in r) r.playoutDelayHint = PLAYOUT_DELAY_HINT;
        if ("jitterBufferTarget" in r) r.jitterBufferTarget = PLAYOUT_DELAY_HINT * 1000;
      } catch (_) {}
    });

    // (2) SDP munge - applied to setLocalDescription ONLY (our offer / our camera bitrate cap).
    //     The remote description is NOT munged: b=AS in an answer SDP doesn't override
    //     Decart's send rate (the server determines that via RTCP feedback) and could
    //     confuse SDP parsing. Codec-preference reorder is optional (PREFER_LOW_LATENCY_CODEC).
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = function (desc) {
      if (desc && desc.sdp) {
        try {
          let sdp = mungeSdpBandwidth(desc.sdp);
          if (PREFER_LOW_LATENCY_CODEC) sdp = mungeSdpPreferCodec(sdp);
          desc = { type: desc.type, sdp };
        } catch (_) {}
      }
      return origSetLocal(desc);
    };

    return pc;
  }

  Patched.prototype = Native.prototype;     // preserve instanceof + all instance methods
  Object.setPrototypeOf(Patched, Native);   // inherit statics (e.g. generateCertificate)
  Patched.__pearLowLatencyPatched = true;

  try {
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
  } catch (_) {}
})();

/* =============================================================================
   WebRTC live-stats monitor - diagnostic ONLY (zero effect on the session/billing)
   ─────────────────────────────────────────────────────────────────────────────
   Polls getStats() once a second on every active peer connection while a session
   is live and logs the inbound-rtp VIDEO numbers that reveal WHERE lag comes from:

     • framesPerSecond / framesDecoded → is the EDITED feed actually arriving at
       the inference fps, or stalling? (low = Decart stream or network bound)
     • framesDropped                  → client CPU can't keep up decoding (raise
       hw-decode: H264-first already does this)
     • packetsLost / jitter           → network loss between us and Decart (TURN /
       congestion). High jitter + playoutDelayHint:0 = visible stutter.
     • bytesReceived (Δ → kbps)       → actual inbound bitrate of the edited stream

   Read it in DevTools → Console while trying on. It is started in goLive() and
   cleared in teardown(), so it can never run against a torn-down session.

   ⚠️ OFF BY DEFAULT (production). This poller is diagnostics only - it has zero
   effect on the session, the video, or billing - but leaving it on costs a
   getStats() call per peer connection every second, and each call allocates a
   full RTCStatsReport (a Map of stat objects) that is then walked and formatted
   into a console.log. Console entries additionally retain references, which
   keeps that garbage alive for the life of the tab. Enable it on demand:

     • DevTools console:  window.__pearStatsDebug = true   (then go live)
     • Persist across reloads:  localStorage.pear_stats_debug = "1"

   Both are read at start time, so flipping the flag mid-session takes effect on
   the next goLive() without a reload.
   ============================================================================= */
let statsMonitorTimer = null;
let _lastStatsSample = null;   // { ts, bytes, frames } from the previous tick, for deltas

/** True only when a developer has explicitly opted in - see the block comment above. */
function statsDebugEnabled() {
  try {
    if (typeof window !== "undefined" && window.__pearStatsDebug) return true;
    return localStorage.getItem("pear_stats_debug") === "1";
  } catch (_) { return false; }
}

function startStatsMonitor() {
  stopStatsMonitor();          // never stack two pollers
  _lastStatsSample = null;
  if (!statsDebugEnabled()) return;   // production: no poller, no getStats(), no logging
  if (typeof window === "undefined" || !window.__pearPCs) return;

  statsMonitorTimer = setInterval(async () => {
    const pcs = window.__pearPCs ? Array.from(window.__pearPCs) : [];
    for (const pc of pcs) {
      if (!pc || typeof pc.getStats !== "function") continue;
      // Only the receiving (subscriber) pc carries inbound video - others skip silently.
      try {
        const report = await pc.getStats();
        report.forEach((s) => {
          if (s.type !== "inbound-rtp" || s.kind !== "video") return;
          const now   = { bytes: s.bytesReceived || 0, frames: s.framesDecoded || 0 };
          let kbps = "-", fpsDelta = "-";
          if (_lastStatsSample) {
            kbps     = Math.round(((now.bytes  - _lastStatsSample.bytes)  * 8) / 1000);  // ~1s window
            fpsDelta = now.frames - _lastStatsSample.frames;
          }
          _lastStatsSample = now;
          console.log(
            `[PEAR webrtc] in-video · ${kbps}kbps · decoded/s:${fpsDelta} · ` +
            `fps:${s.framesPerSecond ?? "-"} · dropped:${s.framesDropped ?? 0} · ` +
            `lost:${s.packetsLost ?? 0} · jitter:${s.jitter != null ? (s.jitter * 1000).toFixed(0) + "ms" : "-"} · ` +
            `decode:${s.totalDecodeTime != null ? s.totalDecodeTime.toFixed(2) + "s" : "-"}`
          );
        });
      } catch (_) {}
    }
  }, 1000);
}

function stopStatsMonitor() {
  if (statsMonitorTimer) { clearInterval(statsMonitorTimer); statsMonitorTimer = null; }
  _lastStatsSample = null;
}

/* ── embedded catalog ──────────────────────────────────────────────────────── */
/* Catalog item shape: { id, name, price, type, subType, color, fabric?, img, imgBack?, images?, variants? }.
   `fabric` drives Fabric-Aware Tension & Physics Conditioning (see FABRIC_PHYSICS /
   getFabricModifier() below) - one of FABRIC_PHYSICS's keys ("dry_fit", "cotton",
   "denim", "silk", "knitwear"). Optional: absent, unset, or unrecognized falls back to
   DEFAULT_FABRIC, so legacy items (and item 99 below, left unset on purpose) still get
   a physics clause instead of none.
   `img` is the FRONT asset (required - every legacy consumer reads it: catalog cards,
   thumbnails, store handoff). Product angles can be supplied THREE ways, all merged by
   galleryOf() into one { front, back?, side?, detail? } map (highest priority first):
     1. variants:{ <colour>: { swatch?, front, back?, side?, detail? }, … }
        - the full nested per-colour gallery (real store schema). The active colour is
          chosen via the swatch strip; 2+ colours light up the swatches automatically.
     2. images:{ front?, back?, side?, detail? } - a single flat gallery object.
     3. legacy `img` (front) + `imgBack` (back).
   The angle rail renders for EVERY item and EVERY colour: an angle with no dedicated
   photo falls back to the front image (+ a prompt clause) rather than disappearing, so
   the multi-angle workflow is universal. Example nested item:
     { id: "strata", name: "Strata", prompt: "premium long-sleeve",
       variants: { black: { swatch:"#111", front:"…", back:"…", side:"…" },
                   white: { swatch:"#eee", front:"…" } } }   // white's back/side auto-fall back */
const PEAR_CATALOG = [
  /* ── Shirts ── */
  { id: 1,  name: "Halo Tank",         price: 88,  type: "shirt", subType: "sleeveless",   color: "#3f5a8a", fabric: "dry_fit",
    img: "https://images.unsplash.com/photo-1556821840-3a63f15732ce?w=1600&q=90&auto=format&fit=crop&crop=top,center" },
  { id: 2,  name: "Vapor Sleeveless",  price: 72,  type: "shirt", subType: "sleeveless",   color: "#b8c0cc", fabric: "dry_fit",
    img: "https://burst.shopifycdn.com/photos/grey-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 3,  name: "Ion Crew Tee",      price: 96,  type: "shirt", subType: "short_sleeve", color: "#c2452f", fabric: "cotton",
    img: "https://burst.shopifycdn.com/photos/red-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 4,  name: "Pulse Tee",         price: 84,  type: "shirt", subType: "short_sleeve", color: "#1f6feb", fabric: "cotton",
    img: "https://burst.shopifycdn.com/photos/cobalt-blue-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 5,  name: "Circuit Tee",       price: 90,  type: "shirt", subType: "short_sleeve", color: "#149c7a", fabric: "dry_fit",
    img: "https://burst.shopifycdn.com/photos/teal-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 6,  name: "Strata Longsleeve", price: 128, type: "shirt", subType: "long_sleeve",  color: "#2b2b30", fabric: "cotton",
    // Multi-angle hero - assets VISUALLY verified (not just HTTP 200): -1 = front
    // packshot (clean white bg → best VTON reference), -3 = back on model, -4 = fabric/
    // logo detail macro. NOTE: -2 is a front-on-model shot (NOT a back) and this item has
    // no true side profile - so neither `back` nor `side` may claim them. galleryOf()
    // merges img (front) + imgBack (back) + images{} → { front, back, detail }. `detail`
    // is inspection-only (a macro, never a warp target - see WEARABLE_ANGLES).
    // requireBothViews: opt into the STRICT two-view gate (front+back mandatory).
    // Strata is the one catalog item that ships a real back photo, so it satisfies
    // the gate and stays fully try-on-able - this is the demonstrable "valid" path.
    // Remove the flag to fall back to graceful (front-fallback) behavior.
    requireBothViews: true,
    img:     "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-1.jpg?v=1732626199&width=2048",
    imgBack: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-3.jpg?v=1732626199&width=2048",
    images:  { detail: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-4.jpg?v=1732626199&width=2048" } },
  { id: 7,  name: "Nimbus Henley",     price: 134, type: "shirt", subType: "long_sleeve",  color: "#8e7bd0", fabric: "knitwear",
    img: "https://cdn.shopify.com/s/files/1/0831/9103/products/DK_LS_Henley_Dark_Purple-Final-Web.jpg?v=1665703111" },
  { id: 8,  name: "Echo Longsleeve",   price: 118, type: "shirt", subType: "long_sleeve",  color: "#d8d4cb", fabric: "cotton",
    img: "https://img.magnific.com/premium-photo/beige-long-sleeve-shirt-isolated-white-background_1166140-13287.jpg" },
  /* ── Pants ── */
  { id: 9,  name: "Glide Slim",        price: 142, type: "pants", subType: "slim",    color: "#2a2d34", fabric: "cotton",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6905_28.jpg" },
  { id: 10, name: "Mono Slim",         price: 118, type: "pants", subType: "slim",    color: "#6e7681", fabric: "cotton",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6906_28.jpg" },
  { id: 11, name: "Vector Regular",    price: 132, type: "pants", subType: "regular", color: "#3b5bdb", fabric: "cotton",
    img: "https://image.hm.com/assets/hm/54/71/5471b01a9ccf7562c74cf7d8f0102228465f30b5.jpg?imwidth=2160" },
  { id: 12, name: "Apex Regular",      price: 124, type: "pants", subType: "regular", color: "#8a8f98", fabric: "cotton",
    img: "https://image.hm.com/assets/hm/72/56/7256f227cb82ac834363dfb140f245652797d841.jpg?imwidth=2160" },
  { id: 13, name: "Drift Wide",        price: 156, type: "pants", subType: "wide",    color: "#1a1a1d", fabric: "denim",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_300px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_768,h_922,f_auto,q_auto,fl_progressive/products/Trousers/default/B25209_28.jpg" },
  { id: 14, name: "Terra Wide",        price: 148, type: "pants", subType: "wide",    color: "#a8794f", fabric: "denim",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B25212_28.jpg" },
  { id: 15, name: "Null Slim",         price: 138, type: "pants", subType: "slim",    color: "#22324f", fabric: "denim",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B9449_28.jpg" },
  { id: 16, name: "Cargo Wide",        price: 162, type: "pants", subType: "wide",    color: "#566b3e", fabric: "denim",
    img: "https://image.hm.com/assets/hm/31/ab/31ab5b52cc238aaad4d95fa3a79d2af741bf7192.jpg?imwidth=2160" },
  /* ── Gatekeeper TEST item (intentionally incomplete) ──────────────────────────
     Proves the two-view gate end-to-end: it OPTS INTO strict (requireBothViews) but
     ships NO back image, so liveBlockReason() rejects it, renderCatalogPanel() adds
     .cat-item--blocked, and viewBadge() renders the 🔒 state. `img` reuses a verified
     catalog packshot purely as a thumbnail placeholder - this item is never actually
     warped (go-live is blocked, so no VTON reference is ever sent). Delete this one
     object to hide the test. */
  { id: 99, name: "Urban Bomber Jacket (Incomplete Test)", price: 168, type: "shirt", subType: "long_sleeve",
    color: "#3a3f47", requireBothViews: true,
    img: "https://burst.shopifycdn.com/photos/cobalt-blue-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
];

/* ── Back-view auto-fill (mirror front → imgBack) ─────────────────────────────
   Product decision: every REAL garment must expose a clickable, populated Back view
   in the live rail without a per-item rear photo shoot. For any item that ships no
   dedicated rear asset we MIRROR its own front image into imgBack. This is a UI/label
   change, NOT a downgrade to the try-on: the live engine already received this exact
   front image as the Back reference under the previous graceful fallback - mirroring
   just (a) flips the Back tab from "AI-inferred fallback" to a populated view and
   (b) satisfies any requireBothViews gate. angleClause()/ANGLE_CLAUSE.back still steers
   Lucy to render the rear from it. EXCLUSIONS: the mock test item (id 99) is left
   front-only so it stays the ONE blocked Gatekeeper demo; Strata (id 6) keeps its
   REAL back photo because we only fill when imgBack is absent. */
for (const _g of PEAR_CATALOG) {
  if (_g.id !== 99 && !_g.imgBack && _g.img) _g.imgBack = _g.img;   // AI-inferred rear from the real front
}

const SUBTYPE_LABEL_HE = {
  sleeveless: "גופייה", short_sleeve: "שרוול קצר", long_sleeve: "שרוול ארוך",
  slim: "גזרה צמודה", regular: "גזרה רגילה", wide: "גזרה רחבה",
};
/* RETIRED FROM THE PROMPT PATH, and now read by nothing - kept for the record.
   These two built the garment description every builder used to open with ("white
   short-sleeve t-shirt"). The image-first refactor deleted that sentence: a text
   description is something a diffusion model can satisfy out of its own prior instead
   of out of the reference pixels, which is how a Spider-Man tee came back as a tuxedo.
   See garmentAnchor(). Left in place because a subType→English map is the obvious thing
   to reach for the next time something needs to NAME a garment (a share caption, an alt
   attribute, an analytics label) - just never a VTON prompt. */
const SUBTYPE_PROMPT = {
  sleeveless: "sleeveless", short_sleeve: "short-sleeve", long_sleeve: "long-sleeve",
  slim: "slim-fit", regular: "regular-fit", wide: "wide-leg",
};
const SHIRT_NOUN = { sleeveless: "tank top", short_sleeve: "t-shirt", long_sleeve: "long-sleeve shirt" };

const $ = (s) => document.getElementById(s);

/* ── state ───────────────────────────────────────────────────────────────── */
let currentUserSize = null;
let currentSizeCategory = null;  // "child" | "adult" - which chart produced currentUserSize.
                                 // Drives the override selector's scale and suppresses
                                 // the SIZE_SCALE fit-delta math for child sizes.
/* The shopper's own scale with NO garment constraint applied - deliberately distinct
   from currentSizeCategory above, which a kids garment forces onto the child chart (or
   onto null) by design. See userBodyCategory()'s comment for why the mismatch guard has
   to read this one and not that one. */
let currentBodyCategory = null;  // "child" | "adult" | null
let activeTryOnSize = null;   // size the user has selected in the Screen 2 override selector
let activeItem = null;
/* The widget's classify-images verdict on the CURRENT garment (see resolveAgeGroup
   in server.js), captured BEFORE activeItem exists. activeItem is only created in
   setActiveItem() (Screen 2), but the widget's PEAR_UPDATE_GARMENT correction can
   arrive while the shopper is still on Screen 1 filling in the measurement form -
   the classify+synthesize round trip on the store page runs in parallel with that,
   and often finishes first. Without this, an early correction would be silently
   dropped (the message listener used to require activeItem to exist) and Screen 1
   would have no way to know the garment's category until Screen 2. Synced onto
   activeItem.ageGroup the moment activeItem is created, so Screen 2 never has to
   care which of the two arrived first. */
let pendingAgeGroup = undefined;             // "kids" | "adult" | "uncertain" | undefined (none arrived yet)
let pendingAgeGroupConfidence = undefined;
/* The host product's REAL size list, same two-stage handoff as pendingAgeGroup above.
   This is the signal that actually decides kids-vs-adult (see isKidsProduct) - the
   classifier verdict beside it is only the fallback for products we never got a list
   for. Arrives on the deep-link URL at open, and/or on a PEAR_UPDATE_GARMENT message. */
let pendingSizes = undefined;                // string[] | undefined (none arrived yet)
let focusMode = false;

/* Multi-Image Product Gallery Sync - which product angle the live engine is warping.
   The SINGLE rtClient session is reused across switches: changing the angle only
   re-issues rtClient.set() with the matching gallery image + an angle-oriented prompt
   clause. It NEVER reconnects, re-mints a token, or touches the strict live window. */
let currentAngle = "front";   // "front" | "back" | "side" (extensible - see ANGLES) - spec's activeAngle
let activeColor  = null;      // active variant/colour key, or null when the item ships no named variants

/* "Complete the Look" - incremental outfit state (the SINGLE source of truth).
   activeOutfit holds at most ONE upper-body garment (top) and ONE lower-body
   garment (bottom). Selecting/adding a garment fills its OWN slot and NEVER clears
   the opposite one, so "Add to Look" (הוסף ללוק) is purely additive: adding pants
   keeps the shirt, and vice-versa. When BOTH slots are filled, goLive bundles them
   into ONE realtime payload so the shirt and the pants render together in the same
   strict 5-second stream (see applyActive / applyLook). */
const activeOutfit = { top: null, bottom: null };
const slotOf = (item) => (item && item.garmentType === "lower_body" ? "bottom" : "top");
const outfitComplete = () => !!(activeOutfit.top && activeOutfit.bottom);
let localStream = null;
let cameraFacing = "user";           // active camera: "user" (front) | "environment" (rear)
let cameraOrientation = "portrait";  // detected preview orientation: "portrait" | "landscape"
let rtClient = null;
let connState = "idle";
let connecting = false;
let busy = false;

/* ── Reference-image state for the CURRENT realtime session ───────────────────
   What the model is holding right now, so applyGarment() can tell a genuine reference
   change from an orientation flip that only needs new wording. In composite mode the
   stitched FRONT|BACK image is identical across a turn, and re-uploading it mid-rotation
   is what made the back print flicker - see the flicker-fix comment in applyGarment().

   Identity, not equality: these hold the exact Blob/string that was passed to
   rtClient.set({ image }). The composite Blob is memoized by createGarmentComposite() and
   garmentBlobCached(), so the SAME object comes back on the next call and `===` is the
   right test. A rebuilt or different asset is a different object and correctly forces a
   full set(). MUST be cleared whenever a session ends or a new one opens - a stale "the
   image is already on the wire" belief against a fresh session would leave Decart with no
   reference at all. */
let lastSentImageRef = null;   // the exact object last handed to set({ image })
let rtImageOnWire = false;     // has THIS session received an image yet?
/* The prompt half of the same bookkeeping. Under strict image-only conditioning the
   prompt is one frozen string, so "same image + same prompt" is a dispatch that provably
   changes nothing on the wire - see the skip in applyGarment(). Reset alongside the two
   above, for the same reason: believing a fresh session already holds this prompt would
   let the first apply skip its own set(). */
let lastSentPrompt = null;
/* The last reference a set() actually RESOLVED with, kept across every invalidation
   below. lastSentImageRef answers "what does the wire hold?" and must be cleared the
   moment that stops being knowable; this answers "what did Decart last acknowledge?" and
   stays true regardless - it is what a recovery re-anchors TO, and what lets the recovery
   verify it re-sent the same asset rather than silently substituting another. */
let lastAckedImageRef = null;

/**
 * Forget what the wire is believed to hold, so the next apply is a full set({ image })
 * rather than a prompt-only update or (with a frozen prompt) no dispatch at all.
 *
 * Call this whenever the TRANSPORT may have changed under us without this file opening
 * the session itself - an SDK-internal reconnect, or a freeze whose cause is unknown.
 * It deliberately does NOT touch lastAckedImageRef, isGarmentApplied, billing or the
 * recorder: this is a statement about the connection, not about whether the shopper was
 * ever dressed, and conflating the two is how a recovery ends up re-arming the reveal or
 * re-billing a session that never stopped.
 * @param {string} why  short reason, logged - these are rare and always worth a line
 * @returns {void}
 */
function invalidateWireState(why) {
  console.log("[PEAR] wire state invalidated -", why,
    "| last acknowledged reference:", typeof abbrevImg === "function" ? abbrevImg(lastAckedImageRef) : lastAckedImageRef);
  lastSentImageRef = null;
  rtImageOnWire = false;
  lastSentPrompt = null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE CONDITIONING WIRE, SERIALISED - one write at a time, from every send site
   ══════════════════════════════════════════════════════════════════════════════
   REPORTED: "timeout ממתין ליישום הבגד (rtClient.set לא הגיב)" at go-live - the initial
   apply never resolving, the session dying before the first dressed frame.

   THE RACE, precisely. goLive() arms the orientation watcher (syncOrientationWatcher)
   BEFORE it issues its own first applyActive(), and that watcher samples every
   ORIENT_SAMPLE_MS. maybeUpdateProfile() fires on a pose TRANSITION and is guarded on
   `applying`, a cooldown, `disposed` and isLive() - but NOT on isGarmentApplied. So a
   shopper who is already edge-on when they press go-live trips a profile transition
   inside ~500ms, and its applyActive() lands ON TOP of the one goLive() is still
   awaiting: two rtClient.set() calls in flight on one session, each with an image
   attached, during the exact second the WebRTC transport is still settling. One of them
   never gets a response, and the one that hangs is as likely to be go-live's as not.

   THIS FILE ALREADY KNEW. reconditionForPresence()'s comment says it outright: "Hoisting
   one real mutex for all three send sites is the right fix and is deliberately NOT
   bundled into this change." The topology monitor made it four send sites, which is what
   turned a narrow window into a reproducible one. This is that mutex.

   TWO DISCIPLINES, AND THE DIFFERENCE MATTERS:
     · QUEUE (the default) for anything a person asked for - go-live, a garment swap, a
       colour change, a confirmed front/back flip. These must never be dropped, so they
       serialise: each waits for the wire to be free, then writes.
     · SKIP (wireBusy() at the call site) for the CONTINUOUS background re-conditioning -
       the re-anchor cadence, the presence re-entry, the body-topology re-drape. These
       re-assert a state that is about to be re-derived anyway, so a skipped one costs
       nothing and the next tick offers it again. Queueing them instead would build
       exactly the backlog this exists to prevent.

   IT IS NOT A TIMEOUT. A send that genuinely hangs holds this queue, which is why the
   go-live path races it against APPLY_TIMEOUT_MS and recovers (see
   applyConditioningWithRecovery). The mutex stops writes from COLLIDING; the timeout is
   what stops one from stalling the session forever. Both are needed. */
let isSettingCondition = false;   // true only while a write is actually on the wire
let wireWrites = 0;               // queued + in flight - what wireBusy() reports
let wireQueue = Promise.resolve();
/* Bumped by resetConditionWire(). A write that was in flight against a client we have
   since disconnected can still settle - or reject - long after the reset, and its
   `finally` would otherwise decrement a counter that no longer describes it: straight to
   -1 if nothing else was running, or to a false "the wire is free" while a NEW write is
   genuinely in flight, which is precisely the concurrent-set() collision this mutex
   exists to prevent. Each write remembers the epoch it belongs to and only touches the
   shared state while that epoch is still current. */
let wireEpoch = 0;

/** @returns {boolean} true when a conditioning write is queued or in flight. */
function wireBusy() { return wireWrites > 0; }

/**
 * Run ONE conditioning write with exclusive access to the wire.
 *
 * Rejections propagate to the caller unchanged - applyActive()'s bounded retry depends on
 * seeing them - but they never break the queue: the next write runs whether its
 * predecessor resolved or threw.
 *
 * @param {string} label   send site, for the skip/serialise log lines
 * @param {() => Promise<any>} send  performs the actual rtClient.set()/setPrompt()
 * @returns {Promise<boolean>} false only when a skipIfBusy call declined to send
 */
function sendCondition(label, send, { skipIfBusy = false } = {}) {
  if (skipIfBusy && wireBusy()) {
    console.log(`[PEAR] ${label}: a conditioning write is already in flight - skipped`,
      "(background re-conditioning is re-offered on the next tick)");
    return Promise.resolve(false);
  }
  if (wireBusy()) {
    console.log(`[PEAR] ${label}: waiting for the wire - ${wireWrites} write(s) ahead of it`);
  }
  const epoch = wireEpoch;
  wireWrites++;
  const run = async () => {
    if (epoch !== wireEpoch) return false;   // the session this write was for is gone
    isSettingCondition = true;
    try {
      await send();
      return true;
    } finally {
      if (epoch === wireEpoch) { isSettingCondition = false; wireWrites--; }
    }
  };
  /* Both handlers, so a REJECTED predecessor still releases the queue - a single failed
     set() must not wedge every later write for the life of the session. */
  const next = wireQueue.then(run, run);
  wireQueue = next.then(() => {}, () => {});
  return next;
}

/* Cleared with the session: a queue entry from a torn-down client must not make the next
   session's first apply believe the wire is busy. The promise chain itself is replaced
   rather than cancelled - an in-flight send against a dead rtClient will settle or reject
   on its own, and either way its `finally` has already stopped mattering by then. */
function resetConditionWire() {
  wireEpoch++;
  isSettingCondition = false;
  wireWrites = 0;
  wireQueue = Promise.resolve();
}

/* Pre-minted ek_ token cache - populated by warmupSDKAndToken() on room entry so
   mintEphemeralToken() can skip the network round-trip at go-live time. */
let _tokenCache = null; // { apiKey: string, expiresAt: number } | null

/* Bug 3 - consecutive-session state.
   `sessionGen` is a monotonic generation counter bumped on every connect and
   every teardown. The realtime SDK fires callbacks (onConnectionChange /
   onRemoteStream) asynchronously, so a torn-down client can still emit a late
   "disconnected" that would poison the NEXT session's connState. Each set of
   callbacks captures the generation it was born in and no-ops once it's stale -
   this is what lets the room be re-entered infinitely without a page refresh.
   `realtimeInput` holds the per-session CLONE of the camera tracks handed to the
   SDK, so when the SDK stops ITS tracks on disconnect our persistent preview
   stream (localStream) survives for the next try-on. */
let sessionGen = 0;
let realtimeInput = null;
/* Active client-side FPS/resolution throttle wrapping the camera before the SDK.
   { stream, dispose }; dispose() is called in teardown() so its paint loop, hidden
   <video> and cloned source track are released with the session (see
   createThrottledInputStream - this is what actually enforces the token budget). */
let inputThrottle = null;

/* Feature 2 - MediaRecorder capture of the REMOTE Lucy-VTON output.
   We do NOT record the raw remote WebRTC track directly (Chromium often encodes
   a remote track as a black frame) nor the local camera. Instead we mirror the
   on-screen remote frames (#aiVideo) onto a canvas and record canvas.captureStream
   - guaranteeing real, encoded pixels in the downloaded clip. Video-only. */
let mediaRecorder = null;
let recordedChunks = [];
let recordedUrl = null;
let recordedBlob = null;     // the finalized clip Blob - kept so we can build a File for the share sheet
let recorderMime = null;     // the container/codec MediaRecorder actually negotiated (mp4 vs webm)
/* The .mp4-typed view of recordedBlob, minted only when the two genuinely differ - i.e.
   only on a browser that could not record MP4 at all. Held separately so its object URL
   has an owner to revoke; see exportClipBlob() for why the export and the replay are
   allowed to disagree about the container in the first place. */
let exportUrl = null;
let recordCanvas = null;     // off-DOM canvas mirroring the remote VTON frames
let recordRaf = 0;           // requestAnimationFrame handle for the paint loop
let recordingActive = false; // guards the paint loop + single-start per session
let replayActive = false;   // true while the user is watching the cached local replay
let liveDurationTimer = null;  // BILLING cap handle - fires at LIVE_DURATION_MS to disconnect Decart + freeze
let liveCountdownInterval = null;  // 1s tick handle driving the on-screen countdown overlay
let videoFinalizeTimer = null; // fires at VIDEO_LENGTH_MS to stop the recorder + finalize the frozen-hold clip
let recordHold = false;        // true once billing stopped & the recorder is holding the frozen final frame
let recordHoldSrc = null;      // off-DOM canvas holding the frozen final dressed frame the recorder repaints during the hold
let firstFrameGuardTimer = null; // safety timeout - tears the session down if Decart's first frame never arrives (no billing cap otherwise)
let billingStarted = false;      // guards startBillingWindow() so it arms the billed window ONCE per session, on the first rendered frame
/* Wall-clock instant billingStarted flipped true. Diagnostics only - never a control
   input, so it can never affect what is rendered. Its value is that it is stamped on the
   SAME first-dressed-frame event that starts the recorder, so a "t=NNNNms" in the console
   maps 1:1 onto the timestamp in a screen recording of that session - which is the only
   way a report like "it reverted around 2 seconds in" can be checked against what the
   code actually did at that moment. */
let billingStartedAt = 0;
let dressedFrameReady = false;   // true once #aiVideo has shown a VERIFIED non-black AI-rendered frame this
                                  // session - the single "model ready" signal shared by billing/countdown
                                  // (armFirstFrameBilling/startBillingWindow) AND the recorder (startRecording)
let isGarmentApplied = false;    // true once rtClient.set() has resolved - gates billing/recording to the first DRESSED frame, not raw passthrough

/* ── DEBUG WRAPPER: garment-asset verification ────────────────────────────────
   Diagnostic-only instrumentation for tracing "generated image never reaches
   Decart" reports. Verifies a payload actually carries a garment asset right
   before it goes on the wire, flags a stream that starts rendering with none
   attached (the "generic/default output" symptom), and exposes a console
   escape hatch to force a fresh re-upload without a page reload. Reads only
   state applyGarment()/applyLook() already maintain (rtImageOnWire,
   lastSentImageRef) - it adds no new state to the live/billing flow itself.
   Verbose per-payload logging (every VALID send, not just failures):
     DevTools console:  window.__pearDebugGarment = true
   Force every dispatch through a full image re-upload, bypassing the flicker-fix
   fast path in applyGarment() (see sameImageOnWire), for ONE diagnostic session -
   ⚠️ intentionally reintroduces the regression prompt-only-flip.test.mjs guards
   against; OFF by default, never flip the default:
     DevTools console:  window.__pearDebugForceFullReupload = true
   Trace the isGarmentApplied/isDressedFrame race in armFirstFrameBilling() - verbose,
   throttled per-frame logging up to the reveal, then a short post-fire luma watch
   (see watchPostFireLuma). OFF by default (noisy - 20-30+ ticks/session):
     DevTools console:  window.__pearDebugFrameTiming = true                */
let debugStreamCheckedThisGen = false;   // reset per session in connectRealtime, alongside billingStarted etc.

/**
 * Inspect a { prompt, enhance, image } payload right before rtClient.set() and
 * report whether it actually carries a usable garment asset.
 * @param {{image?: Blob|string}} payload
 * @param {string} source  caller name, for the log line ("applyGarment" | "applyLook")
 * @returns {boolean} true if payload.image looks like a real asset
 */
function verifyGarmentAsset(payload, source) {
  const asset = payload && payload.image;
  let valid = false, detail = "MISSING - no image key on the payload";
  if (typeof Blob !== "undefined" && asset instanceof Blob) {
    valid = asset.size > 0;
    detail = valid ? `Blob, ${asset.size} bytes, type=${asset.type || "?"}`
                    : "Blob is 0 bytes - decode/composite likely failed silently";
  } else if (typeof asset === "string" && asset.length > 0) {
    valid = /^(https?:|data:|blob:)/i.test(asset);
    detail = valid ? `string ref (${asset.slice(0, 40)}…)`
                    : `string but not a recognizable URL: "${asset.slice(0, 60)}"`;
  }
  if (!valid) {
    console.warn(`[PEAR][DEBUG] ${source}() - garmentAsset NOT valid before rtClient.set(): ${detail}`,
      "\n  → this set() will run PROMPT-ONLY; Decart has no pixel reference and will render its default/generic output.");
  } else if (typeof window !== "undefined" && window.__pearDebugGarment) {
    console.log(`[PEAR][DEBUG] ${source}() - garmentAsset OK:`, detail);
  }
  return valid;
}

/**
 * Fires once per session, the moment Decart's first remote frame is wired to
 * #aiVideo (see onRemoteStream in connectRealtime). If the stream is already
 * rendering while no image was ever confirmed on the wire, that render is
 * necessarily prompt-only / default output - warn loudly so it's obvious in
 * DevTools without correlating it against the payload-debug log by hand.
 * @returns {void}
 */
function warnIfStreamStartedUndressed() {
  if (debugStreamCheckedThisGen) return;
  debugStreamCheckedThisGen = true;
  if (!rtImageOnWire) {
    console.warn("[PEAR][DEBUG] Decart stream started rendering WITHOUT a garment asset on the wire.",
      "\n  lastSentImageRef:", lastSentImageRef,
      "\n  → the model has nothing to condition on and will render its generic/default output.",
      "\n  → run window.__pearDebugReinjectGarment() in the console to force a fresh set() with the current item's image.");
  }
}

/**
 * Console escape hatch: force a full re-upload of the CURRENT garment/look,
 * bypassing the "image already on the wire" fast path (setPrompt-only) that
 * applyGarment()/applyLook() normally take when the reference hasn't changed.
 * Use this when the render looks like the generic default even though the
 * payload-debug log claims an asset was sent - it rules out "stale/corrupted
 * cached Blob" as the cause by forcing a genuinely fresh set(), and optionally
 * clearing the caches first so a bad cached asset can't be re-sent as-is.
 * Lets us tell apart "failure to send the data" (this either fixes it or the
 * warning above still fires) from "Decart not recognizing sent data" (this
 * re-sends the identical bytes and the render still doesn't change).
 * @param {{bustCache?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
async function debugReinjectGarment(opts = {}) {
  if (!rtClient || !isLive()) {
    console.warn("[PEAR][DEBUG] reinject: no live Decart session - go live first.");
    return false;
  }
  if (opts.bustCache) {
    _assetBlobCache.clear();
    _compositeCache.clear();
    _lookStitchCache.clear();
    console.log("[PEAR][DEBUG] reinject: Blob/composite caches cleared.");
  }
  lastSentImageRef = null;   // bypass applyGarment()/applyLook()'s "sameImageOnWire" shortcut -
  rtImageOnWire = false;     // this must land on the full rtClient.set({ image }) path, not setPrompt()
  lastSentPrompt = null;     // ...and past the "prompt unchanged too" no-op skip in front of it
  console.log("[PEAR][DEBUG] reinject: forcing a fresh rtClient.set() for the active garment/look…");
  try {
    await applyActive();
    console.log("[PEAR][DEBUG] reinject: rtClient.set() resolved. rtImageOnWire =", rtImageOnWire,
      "| lastSentImageRef =", abbrevImg(lastSentImageRef));
    return true;
  } catch (e) {
    console.error("[PEAR][DEBUG] reinject: applyActive() failed -", e?.message || e);
    return false;
  }
}
if (typeof window !== "undefined") window.__pearDebugReinjectGarment = debugReinjectGarment;

/** @returns {boolean} true while a billable realtime session is active. */
const isLive = () => connState === "connected" || connState === "generating";

/** Milliseconds since the first DRESSED frame (== recording start), or -1 before it.
 *  Diagnostics only - see billingStartedAt. -1 rather than 0 so "before the window
 *  opened" is visibly distinct in a log from "at the very start of it".
 *  @returns {number} */
const sessionElapsedMs = () => (billingStartedAt ? Date.now() - billingStartedAt : -1);

/* =============================================================================
   SCREEN 1 - Size / measurement calculator
   ============================================================================= */
const ZARA_SIZE_CHART = [
  { size: "S",  minHeight: 160, maxHeight: 172, minWeight: 55, maxWeight: 65,  minChest: 88,  maxChest: 94,  minWaist: 74, maxWaist: 80,  minLegs: 94,  maxLegs: 98  },
  { size: "M",  minHeight: 170, maxHeight: 180, minWeight: 65, maxWeight: 76,  minChest: 94,  maxChest: 102, minWaist: 80, maxWaist: 88,  minLegs: 98,  maxLegs: 102 },
  { size: "L",  minHeight: 178, maxHeight: 186, minWeight: 75, maxWeight: 87,  minChest: 102, maxChest: 110, minWaist: 88, maxWaist: 96,  minLegs: 102, maxLegs: 106 },
  { size: "XL", minHeight: 184, maxHeight: 195, minWeight: 85, maxWeight: 100, minChest: 110, maxChest: 118, minWaist: 96, maxWaist: 106, minLegs: 106, maxLegs: 112 },
];

/* Children's numeric sizing (EU/IL kids convention, sizes 8-18).
   Height/weight bands only - unlike ZARA_SIZE_CHART there are no chest/waist/legs
   columns, so the optional fine-tune inputs contribute no penalty against these
   rows - calculateSize() skips them outright on the child path.

   Size 20+ is deliberately absent: the ladder connects into the adult chart on its
   own, since adult S starts at 160cm/55kg and already overlaps size 18's upper end
   (170-176cm / 54-60kg). */
const CHILD_SIZE_CHART = [
  { size: "8",  minHeight: 122, maxHeight: 135, minWeight: 22, maxWeight: 27 },
  { size: "10", minHeight: 135, maxHeight: 145, minWeight: 27, maxWeight: 32 },
  { size: "12", minHeight: 145, maxHeight: 155, minWeight: 32, maxWeight: 38 },
  { size: "14", minHeight: 155, maxHeight: 163, minWeight: 38, maxWeight: 46 },
  { size: "16", minHeight: 163, maxHeight: 170, minWeight: 46, maxWeight: 54 },
  { size: "18", minHeight: 170, maxHeight: 176, minWeight: 54, maxWeight: 60 },
];

/* Ordered child scale, derived from the chart so the two can never drift apart.
   → ["8","10","12","14","16","18"] */
const CHILD_SIZE_SCALE = CHILD_SIZE_CHART.map((r) => r.size);

/* Ordered size scale - full range used by the override selector and delta math. */
const SIZE_SCALE = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];

/**
 * Height/weight penalty for one chart row - the scoring kernel behind
 * calculateSize()'s match pass, shared by both charts. Same ×2 per-cm/kg
 * weighting as the original adult matcher.
 * @returns {number}
 */
function coreHwPenalty(row, height, weight) {
  let pen = 0;
  if (height < row.minHeight) pen += (row.minHeight - height) * 2;
  if (height > row.maxHeight) pen += (height - row.maxHeight) * 2;
  if (weight < row.minWeight) pen += (row.minWeight - weight) * 2;
  if (weight > row.maxWeight) pen += (weight - row.maxWeight) * 2;
  return pen;
}

/* CHILD_AGE_MAX / pickSizeCategory() lived here and are GONE - see the "AGE -
   REMOVED" note further down. Both were already unreachable: nothing called
   pickSizeCategory(), so no visitor's age ever chose a chart. The chart is chosen
   from the product's own size list and the shopper's height/weight instead. */

/* The garment's own kids/adult signal, wherever it currently lives - activeItem
   once Screen 2 exists, pendingAgeGroup before that. "uncertain" covers three
   cases identically, by design (never guess a default): the classifier genuinely
   couldn't tell, no correction has arrived yet, or the field is simply absent
   (an older cached correction from before this feature existed).

   ⚠️ This is the WEAKER of the two category signals and is consulted only as a
   fallback - see isKidsProduct() below for why the product's own size list outranks
   it, and what shipped to production when it didn't.
 * @returns {"kids"|"adult"|"uncertain"}
 */
function resolvedGarmentAgeGroup() {
  const ag = activeItem?.ageGroup ?? pendingAgeGroup;
  return (ag === "kids" || ag === "adult") ? ag : "uncertain";
}

/* KIDS/ADULT SIZE-CATEGORY GUARD.

   ── WHY THIS READS THE PRODUCT'S REAL SIZE LIST, AND NOT JUST THE CLASSIFIER ──────
   The first version of this guard keyed entirely on resolvedGarmentAgeGroup() - the
   per-product kids/adult verdict from Gemini's image classification - and it FAILED IN
   PRODUCTION on a FOX Spiderman tee sold only in kids 8/10/12/14/16: an adult
   180cm/80kg profile sailed straight into the fitting room, with an adult XS-3XL size
   selector rendered over a product that has no adult size at all.

   That failure was not a coding slip, it was the wrong source of truth. server.js's own
   classifier prompt INSTRUCTS the model to abstain on exactly this kind of item:
     · "Flat-lay / packshot with NO model and NO visible size label ... answer
        'uncertain' - do not guess from styling alone."
     · "Do NOT infer age group from color, PRINT STYLE, or price positioning alone"
     · "below 0.7 you must answer 'uncertain'"
   A character-print packshot hits all three, so "uncertain" is the CORRECT answer from
   that model - and "uncertain" can never block. Meanwhile the storefront was displaying
   8/10/12/14/16 the entire time: deterministic ground truth, sitting unread.

   So the ordering below is deliberate and load-bearing: when the host page gives us a
   real size list, THAT decides, in both directions (it can also clear a wrong "kids"
   verdict). The classifier is consulted only when no size list reached us at all - a
   probabilistic signal designed to abstain must never outrank a deterministic one. */

/* The kids numeric ladder, per the retail convention this codebase already encodes in
   CHILD_SIZE_CHART (which runs 8-18; 2-6 are included here because a product can list
   them even though we don't size-match against those rows). Adult numeric systems -
   waist/chest 28-44 - deliberately fall OUTSIDE this set, so "32" never reads as kids. */
const KIDS_NUMERIC_SIZES = new Set(["2", "4", "6", "8", "10", "12", "14", "16", "18"]);
/* Adult letter scales, incl. the 2XL/3XL spellings storefronts use interchangeably
   with XXL/XXXL. Presence of ANY of these is proof the product is not kids-only. */
const ADULT_ALPHA_SIZES = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL", "2XL", "3XL", "4XL", "5XL",
]);

/** Accepts the array form (`item.sizes`) or the comma-joined URL-param form, and
 *  normalises to trimmed upper-case tokens. Junk/empties are dropped, order kept.
 * @param {string[]|string|null|undefined} raw
 * @returns {string[]} */
function parseSizeList(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  return list.map((s) => String(s == null ? "" : s).trim().toUpperCase()).filter(Boolean);
}

/**
 * @param {string[]|string|null} sizes - the host product's OWN size list, when known
 * @param {"kids"|"adult"|"uncertain"|undefined} garmentAgeGroup - classifier fallback only
 * @returns {boolean} true only when the product is CONFIDENTLY kids-only.
 */
function isKidsProduct(sizes, garmentAgeGroup) {
  const list = parseSizeList(sizes);
  if (list.length) {
    // Any adult letter size present -> the product serves adults, whatever else it lists.
    if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return false;
    // Otherwise: kids only if EVERY token is a kids numeric. A mixed or unrecognised
    // list (an adult 28-44 waist run, a one-size product, a store's own odd labels)
    // is NOT confidently kids - and an unconfident verdict must never block a sale.
    return list.every((s) => KIDS_NUMERIC_SIZES.has(s));
  }
  return garmentAgeGroup === "kids";
}

/**
 * Mirror of isKidsProduct - true only when the product is CONFIDENTLY adult.
 * Needed because the childFits guard was zeroing only on garmentAgeGroup ===
 * "adult" (the classifier verdict), never on the real size list - so an adult
 * product with a real S/M/L list but an "uncertain" classifier read (common:
 * the classifier is instructed to abstain on packshots with no model) let a
 * child-bodied shopper through to a genuine CHILD_SIZE_CHART match instead of
 * being blocked, same class of bug isKidsProduct itself was written to fix.
 * @param {string[]|string|null} sizes
 * @param {"kids"|"adult"|"uncertain"|undefined} garmentAgeGroup
 * @returns {boolean}
 */
function isAdultProduct(sizes, garmentAgeGroup) {
  const list = parseSizeList(sizes);
  if (list.length) {
    if (list.some((s) => ADULT_ALPHA_SIZES.has(s))) return true;
    // Not every token kids-numeric -> an adult numeric run (e.g. 28-44 waist)
    // or unrecognised labels, treated as adult, mirroring isKidsProduct's
    // "not confidently kids" default for a deterministic size list.
    return !list.every((s) => KIDS_NUMERIC_SIZES.has(s));
  }
  return garmentAgeGroup === "adult";
}

/**
 * The shopper's OWN scale, derived with NO garment constraint applied.
 *
 * WHY THIS IS NOT currentSizeCategory. calculateSize() deliberately forces
 * `adultFits = []` once the garment resolves to kids, so a kids garment can never
 * recommend an adult size. For the 180cm/80kg shopper in the bug report that leaves no
 * candidate in EITHER chart (the child chart ends at 176cm/60kg), so currentSizeCategory
 * lands on null - meaning a guard keyed on `currentSizeCategory === "adult"` would go
 * quiet again the moment the product-size fix made the garment resolve correctly. The
 * guard has to read a category that the garment cannot influence. This is that value.
 *
 * NOTE ON THE METHOD: chart-fit, never a raw height/weight threshold. pickSizeCategory()
 * previously recorded why - a threshold guess "routed petite adults (150cm/50kg -> kids
 * 14) and slim tall adults (174cm/56kg -> kids 18) into children's sizing with no way
 * for them to correct it". The mirror of that mistake here would block a 13-year-old
 * off the kids items they actually need. Adult wins genuine ties, matching the same
 * convention calculateSize() already uses for the overlap zone.
 * @returns {"adult"|"child"|null}
 */
function userBodyCategory(height, weight) {
  if (!height || !weight) return null;
  if (ZARA_SIZE_CHART.some((row) => coreHwPenalty(row, height, weight) === 0)) return "adult";
  if (CHILD_SIZE_CHART.some((row) => coreHwPenalty(row, height, weight) === 0)) return "child";
  return null;
}

/**
 * @param {"child"|"adult"|null} userCategory - userBodyCategory()'s garment-independent verdict
 * @param {string[]|string|null} sizes - the host product's own size list, when known
 * @param {"kids"|"adult"|"uncertain"|undefined} garmentAgeGroup - classifier fallback only
 * @returns {boolean} false for a confidently-kids product against a confidently-adult
 *   body, OR a confidently-adult product against a child body; every other combination
 *   (unknown product category, no measurements yet) passes - never block on ambiguity,
 *   matching liveBlockReason()/livePendingReason().
 */
function isCompatibleSizeCategory(userCategory, sizes, garmentAgeGroup) {
  if (isKidsProduct(sizes, garmentAgeGroup) && userCategory === "adult") return false;
  if (isAdultProduct(sizes, garmentAgeGroup) && userCategory === "child") return false;
  return true;
}

/* go-live gate paralleling liveBlockReason()/livePendingReason() just below - returns
   the localized message when an adult-sized shopper is about to launch a kids-only
   garment, else null. Bilingual inline string, matching itemBlockReason()/
   itemPendingReason()'s own convention rather than routing through i18n.js, since this
   sits in the same gate family and neither of those go through t() either. */
/* The active product's own size list, wherever it currently lives - activeItem once
   Screen 2 exists, pendingSizes before that (same two-stage pattern
   resolvedGarmentAgeGroup() already uses, and for the same reason: the widget's
   correction can land while the visitor is still on the measurement form). */
function resolvedGarmentSizes() {
  return parseSizeList(activeItem?.sizes ?? pendingSizes);
}

/* The ONE mismatch predicate every surface reads - the go-live gate, the modal card,
   and the size selector alike - so they can never disagree about what is blocked. */
function hasSizeCategoryMismatch() {
  return !isCompatibleSizeCategory(currentBodyCategory, resolvedGarmentSizes(), resolvedGarmentAgeGroup());
}

const SIZE_MISMATCH_MESSAGE =
  "הפריט אינו בטווח המידות שלך (פריט במידות ילדים). אינך יכול למדוד פריט זה במידה הנוכחית. " +
  "כדי למדוד, יש לעדכן/לשנות את המידות בפרופיל. · " +
  "This item is not within your size range (Kids item). You cannot try on this item with " +
  "your current profile size. Please update your profile sizes to proceed.";

/* go-live gate paralleling liveBlockReason()/livePendingReason() just below - returns
   the localized message when an adult-sized shopper is about to launch a kids-only
   garment, else null. */
function sizeCategoryMismatchReason() {
  return hasSizeCategoryMismatch() ? SIZE_MISMATCH_MESSAGE : null;
}

/* PROACTIVE counterpart to sizeCategoryMismatchReason() above. That gate only fires
   the moment goLive() is actually called - fine for a fresh visitor who clicks
   through Screen 1, but a RETURNING shopper with a saved adult profile never sees
   Screen 1 at all (routeUser()'s instant-skip fast path lands them straight in the
   camera room), so nothing ever painted a warning until the one click that would
   have opened a billed session anyway. This keeps a persistent card in the camera
   modal honest the whole time a mismatch is active - and disables Start Fitting so
   there's nothing to click through in the first place - called from every point
   currentSizeCategory or the garment's resolved age group can change while the room
   is open: calculateSize() (covers the returning-user fast path too), enterRoom(),
   setSizeOverride(), and the PEAR_UPDATE_GARMENT late-classification listener.
   goLive()'s own gate stays as the authoritative backstop regardless of whether this
   UI happened to run - this is only ever a courtesy, never the enforcement. */
function updateSizeMismatchUI() {
  const view = $("sizeMismatchView");
  if (!view) return;
  const mismatched = hasSizeCategoryMismatch();
  view.hidden = !mismatched;
  if (mismatched) {
    const textEl = $("sizeMismatchText");
    if (textEl) textEl.textContent = SIZE_MISMATCH_MESSAGE;
  }
  /* Blocked means BLOCKED, not "blocked once you click": the live stage and the size
     selector are both suppressed while a mismatch stands, so there is no camera feed
     to start and - the second half of the reported bug - no adult XS-3XL selector
     rendered over a product that ships none of those sizes. The class drives the CSS
     (see .camera-card.size-mismatched in style.css); the selector is removed outright
     because injectSizeSelector() rebuilds it from scratch on every item swap anyway. */
  const cardEl = $("cameraCard");
  if (cardEl) cardEl.classList.toggle("size-mismatched", mismatched);
  if (mismatched) $("pearSizeSelector")?.remove();

  const captureBtn = $("captureBtn");
  if (captureBtn) captureBtn.disabled = mismatched || !localStream;
}

/* AGE - REMOVED, deliberately and completely.

   It had already decayed into dead weight before this: refreshAgeFieldVisibility()
   had no callers, so the #age input was never revealed and no visitor was ever asked
   for one, and pickSizeCategory() - the only function that ever used age to pick a
   chart - had no callers either. What survived was a stored value from an older build
   still being PAINTED into the profile popover ("גיל: 5" in the bug report): a field
   the UI no longer collects, no longer updates, and no longer reads for anything.

   The chart is chosen from the product's own size list (isKidsProduct) plus the
   shopper's height/weight against the two charts (userBodyCategory) - both stronger
   signals than a self-reported age, and neither of them needs it. So the field, its
   markup, its i18n keys, its profile row, and its persistence are all gone rather
   than left dormant for someone to rediscover and re-wire. */

/**
 * Human-readable label for a size VALUE, for display/logging only - never for
 * matching logic. currentUserSize/activeTryOnSize themselves stay raw chart
 * codes everywhere else (SIZE_SCALE.indexOf, CHILD_SIZE_SCALE lookups, the
 * override-selector buttons, getSizeDelta) - only the text shown or sent here
 * goes through this.
 * Adult sizes are returned UNCHANGED - "M" stays "M", byte-for-byte identical to
 * every surface's pre-existing text. A bare child size ("12") is otherwise
 * indistinguishable from a quantity, a shoe size, or an adult numeric system, so
 * it gets an explicit "(Kids)" qualifier appended.
 * @param {string|null} size
 * @returns {string|null}
 */
function formatSizeLabel(size) {
  if (!size) return size;
  return currentSizeCategory === "child" ? `${size} ${t("sizeLabelKidsSuffix")}` : size;
}

/* Task 6 - conditional input flow: the optional fields stay hidden until ALL
   mandatory fields (age + height + weight) hold sane, in-range values. */
function setOptionalVisible(show) {
  const box = $("optionalFields");
  if (!box) return;
  const expanded = box.classList.contains("is-expanded");
  if (show === expanded) return;              // no-op if already in desired state
  // Pure CSS-driven expansion (see .optional-fields / .is-expanded in style.css):
  // toggling the class lets the panel stretch open / collapse fluidly rather than
  // snapping via a display toggle - no layout jump.
  if (show) {
    box.classList.add("is-expanded");
  } else {
    box.classList.remove("is-expanded");
    // collapsing → clear any optional values so a stale entry can't skew the result
    ["chest", "waist", "legs"].forEach((id) => { if ($(id)) $(id).value = ""; });
  }
}

/**
 * Recompute the recommended size from height+weight ALONE - a genuine-fit
 * lookup against both charts, not a closest-match guess. A chart row only
 * counts if BOTH height AND weight land inside its band; there is no longer a
 * fallback that recommends the nearest row when nothing genuinely fits (see
 * the "fits neither" branch below).
 *
 * The garment's own classification (resolvedGarmentAgeGroup(), via
 * activeItem.ageGroup) is consulted first: a CONFIDENT "kids" or "adult"
 * verdict restricts the genuine-fit search to that single chart only - a
 * kids garment never falls back to the adult chart even if the body would
 * technically fit there, and vice versa. Only when the garment is
 * "uncertain" (genuinely unclassified, not yet arrived, or an older cached
 * item predating this feature) does the dual-chart search below run, with
 * its usual overlap-defaults-to-adult tie-break.
 *
 * The visitor is never asked for an age - the field and all its plumbing are
 * gone (see the "AGE - REMOVED" note). The product's own size list, then its
 * classification, then the visitor's height/weight decide the chart.
 *
 * Drives the result box and the "continue" button enabled-state, and - via
 * setOptionalVisible - the conditional reveal of the optional measurement
 * fields. Re-run on every input event. Pure UI/state; no network.
 * @returns {void}
 */
function calculateSize() {
  const num = (id) => ($(id).value ? parseFloat($(id).value) : null);
  const height = num("height"), weight = num("weight");

  // Reveal optional fields only once both mandatory values are present and sane.
  // Height floor is 110cm/18kg to admit children's sizing (size 8 and below).
  // Bounds mirrored in PROFILE_* below and in updateUserMeasurements() server-side.
  const mandatoryReady = !!height && !!weight &&
    height >= 110 && height <= 240 && weight >= 18 && weight <= 220;
  setOptionalVisible(mandatoryReady);

  const chest = num("chest"), waist = num("waist"), legs = num("legs");

  const resultBox = $("resultBox"), sizeResult = $("sizeResult"), resultLabel = $("resultLabel");
  const nextBtn = $("btn-next-screen");
  const resultActions = $("resultActions");

  resultBox.classList.remove("show", "error-result", "no-match-result");
  if (resultActions) resultActions.classList.remove("is-ready");   // collapse the tray
  resultLabel.innerText = t("resultLabelDefault");
  nextBtn.disabled = true;
  currentUserSize = null;
  // Cleared alongside the size so the two never disagree; both early-return paths
  // below (missing input / out of range) therefore leave the category null.
  currentSizeCategory = null;
  currentBodyCategory = null;   // ...and the garment-independent one with it
  updateProgress();

  if (!height || !weight) return;

  if (height > 240 || height < 110 || weight > 220 || weight < 18) {
    resultLabel.innerText = t("resultLabelError");
    sizeResult.innerText = t("sizeResultInvalid");
    resultBox.classList.add("show", "error-result");
    if (resultActions) resultActions.classList.add("is-ready");
    return;
  }

  // "Genuine fit" candidates per chart: rows where BOTH height AND weight land
  // inside the band. coreHwPenalty() is exactly 0 in that case (it only ever
  // adds penalty for being OUTSIDE a bound), so filtering on that gives exactly
  // the genuine-fit set - a chart with no such row contributes NOTHING below,
  // rather than still "winning" via whichever row happened to score lowest.
  //
  // A CONFIDENT garment classification restricts the search to a single
  // chart from the start - the other chart's array is left empty rather than
  // filtered, so it can never contribute a candidate below, even if the body
  // would technically fit a row there.
  const garmentAgeGroup = resolvedGarmentAgeGroup();
  /* Computed BEFORE the garment constraint below, and kept: this is the shopper's own
     scale, which the mismatch guard needs precisely because the constrained result
     cannot express "an adult body looking at a kids-only product" (it collapses to
     null). See userBodyCategory()'s comment. */
  const bodyChildFits = CHILD_SIZE_CHART.filter((row) => coreHwPenalty(row, height, weight) === 0);
  const bodyAdultFits = ZARA_SIZE_CHART.filter((row) => coreHwPenalty(row, height, weight) === 0);
  currentBodyCategory = bodyAdultFits.length ? "adult" : (bodyChildFits.length ? "child" : null);

  const childFits = isAdultProduct(resolvedGarmentSizes(), garmentAgeGroup) ? [] : bodyChildFits;
  const adultFits = isKidsProduct(resolvedGarmentSizes(), garmentAgeGroup) ? [] : bodyAdultFits;

  // Overlap zone (genuinely fits BOTH charts, e.g. ~170-172cm/54-60kg) defaults
  // to adult - same tie-break convention used elsewhere in this codebase
  // (userBodyCategory's adult-first rule, resolveAgeGroup's server-side tie rule).
  // Adult winning whenever it has ANY candidate covers "adult-only" and
  // "fits both" in the same branch. This only actually applies in the
  // "uncertain" case above - a confident garment already has the other
  // chart's array forced empty, so there's nothing left for it to tie with.
  currentSizeCategory = adultFits.length ? "adult" : (childFits.length ? "child" : null);

  if (!currentSizeCategory) {
    // Fits NEITHER chart - no closest-match guess. A real gap between the two
    // charts, or genuinely out-of-catalog proportions, is now a visible "no
    // size found" result instead of a silently wrong recommendation.
    // Blocking, same severity as the sane-range validation error above -
    // Continue stays disabled until the visitor's measurements resolve to a
    // real chart match.
    resultLabel.innerText = t("resultLabelNoMatch");
    sizeResult.innerText = t("sizeResultNoMatch");
    resultBox.classList.add("show", "no-match-result");
    if (resultActions) resultActions.classList.add("is-ready");
    updateProgress();
    return;
  }

  // Among the genuinely-fitting rows only, chest/waist/legs still refine WHICH
  // one is shown when more than one qualifies (adjacent adult sizes' bands
  // really do overlap, e.g. S and M both fit 170-172cm/64-65kg) - same scoring
  // as before, just scoped to candidates that already passed the height/weight
  // gate, never to a row that didn't.
  const candidates = currentSizeCategory === "child" ? childFits : adultFits;
  let bestSize = candidates[0].size, minPenalty = Infinity;
  candidates.forEach((row) => {
    let pen = 0;   // height/weight are already an exact fit for every candidate here
    if (currentSizeCategory === "adult") {
      if (chest) { if (chest < row.minChest) pen += (row.minChest - chest) * 0.5; if (chest > row.maxChest) pen += (chest - row.maxChest) * 0.5; }
      if (waist) { if (waist < row.minWaist) pen += (row.minWaist - waist) * 0.5; if (waist > row.maxWaist) pen += (waist - row.maxWaist) * 0.5; }
      if (legs)  { if (legs  < row.minLegs)  pen += (row.minLegs  - legs)  * 0.5; if (legs  > row.maxLegs)  pen += (legs  - row.maxLegs)  * 0.5; }
    }
    if (pen < minPenalty) { minPenalty = pen; bestSize = row.size; }
  });

  sizeResult.innerText = formatSizeLabel(bestSize);
  resultBox.classList.add("show");
  if (resultActions) resultActions.classList.add("is-ready");
  currentUserSize = bestSize;
  nextBtn.disabled = false;
  updateProgress();
  // Covers the RETURNING-USER fast path too: routeUser()'s instant-skip branch calls
  // calculateSize() directly and, on a hasProfile match, goes straight to goToFitting()
  // with Screen 1 never shown - so this is the only place that path's resolved
  // currentSizeCategory ever gets checked against the room's mismatch UI before the
  // shopper lands in it. See updateSizeMismatchUI()'s own comment.
  updateSizeMismatchUI();
}

function updateProgress() {
  const fields = ["height", "weight", "chest", "waist", "legs"];
  const filled = fields.filter((f) => $(f) && $(f).value).length;
  let pct = Math.round((filled / fields.length) * 70);
  if (currentUserSize) pct = 100;
  const fill = $("progressFill"), label = $("progressPercent");
  if (fill) fill.style.width = pct + "%";
  if (label) label.innerText = pct + "%";
}

/* Task 5 - Enter on any measurement input: if a size is ready, proceed straight to
   the virtual fitting room; otherwise advance focus to the next field so the user
   can keep filling the form naturally with the keyboard. */
function onMeasurementKeydown(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  calculateSize();

  const nextBtn = $("btn-next-screen");
  if (nextBtn && !nextBtn.disabled) { onSizeFormContinue(); return; }

  const inputs = [...document.querySelectorAll("#sizeForm input")]
    // visible inputs only - and skip the optional panel while it's collapsed
    // (visibility:hidden keeps offsetParent set, so check the panel state too).
    .filter((el) => el.offsetParent !== null && !el.closest(".optional-fields:not(.is-expanded)"));
  const idx = inputs.indexOf(e.target);
  const next = inputs.slice(idx + 1).find((el) => !el.value) || inputs[idx + 1];
  if (next) next.focus();
  else e.target.blur();
}

/* =============================================================================
   URL handoff + focus mode
   ============================================================================= */
function parseHandoff() {
  const q = new URLSearchParams(location.search);

  // Which garment side the shopper was inspecting on the storefront PDP gallery.
  // Normalized to a WEARABLE angle (a `detail` close-up can't be a warp target, so
  // it collapses to front); the room opens on this angle instead of always front.
  const readAngle = () => {
    const a = (q.get("angle") || "").toLowerCase();
    return WEARABLE_ANGLES.includes(a) ? a : "front";
  };

  // "Upload Your Own Garment" handoff from the storefront. The cropped garment is a
  // data URL - far too large for a query param - so the storefront stashes it in
  // localStorage ("pear_custom_garment") and flags the deep-link with ?custom=1.
  // We reconstruct it here as a "custom" focus-mode item (Screen 2 Active Item),
  // handled downstream exactly like a catalog garment (buildCustomPrompt, the
  // data-URL passthrough in garmentImageRef, the custom chip label). Left in
  // localStorage (not cleared) because parseHandoff() runs several times per
  // session; a later upload simply overwrites it.
  if (q.get("custom") === "1") {
    try {
      const raw = JSON.parse(localStorage.getItem("pear_custom_garment") || "null");
      if (raw && raw.img) {
        const lower = raw.garmentType === "lower_body";
        const result = {
          id: null, custom: true,
          name: raw.name || "Your garment",
          type: lower ? "pants" : "shirt",   // toItem() → garmentType (lower_body|upper_body)
          subType: "",                       // no catalog subType → generic custom prompt
          color: raw.color || "#0B3C95",
          img: raw.img,                      // cropped garment data URL (rtClient image)
        };
        console.log("[PEAR] parseHandoff() - custom uploaded garment:", { ...result, img: "data:… (custom crop)" });
        return result;
      }
      console.warn("[PEAR] parseHandoff() - ?custom=1 but no stored garment; falling through");
    } catch (e) { console.warn("[PEAR] parseHandoff() - custom garment parse failed:", e && e.message); }
  }

  // PEAR widget embed handoff (widget/pear-widget.js on a third-party store):
  // ?garment_url=…&garment_type=…&garment_name=…  The widget knows only the
  // product image URL, a keyword-detected category and the page's product name,
  // so we map those onto a standard focus-mode item. Returning a handoff here
  // hides the catalog entirely (enterRoom → focus mode), shows the garment name
  // in the focus bar above the camera, and loads the garment image directly
  // through the normal applyGarment → rtClient.set() pipeline. custom:true makes
  // buildCustomPrompt() point the model at the reference image itself instead of
  // a catalog color/subType we don't have.
  const widgetUrl = q.get("garment_url") || q.get("front_image_url");
  if (widgetUrl) {
    // Real-store session marker: "Complete the Look" must never recommend the
    // hardcoded demo PEAR_CATALOG when the fitting room is embedded on an actual
    // store (see fetchStoreLookItems). The garment's own CDN host IS the store's
    // domain, so stash it globally the moment we know we're in a widget embed.
    try { window.__pearStoreDomain = new URL(widgetUrl).hostname; }
    catch (e) { console.warn("[PEAR] parseHandoff() - could not derive store domain from garment_url:", e?.message || e); }

    /* THE HARDCODED DEFAULT THAT SHIPPED THE BUG. This used to read
         (q.get("garment_type") || "tops")
       so a widget that could not classify the product - or an older widget that never
       sent the param - handed the room a confident "tops" it had no basis for, and the
       room's own classifier never ran because the value looked like a verdict.

       "unknown" is now forwarded explicitly by the widget and treated as ABSENT here, so
       the room falls through to its own title classifier (which knows the Hebrew stems
       the widget's list was missing) and, failing that, the LLM tier. The old
       `isPants = wType === "pants" || wType === "bottoms"` also silently dropped
       "shorts" and "skirt" onto the upper body; EXPLICIT_BOTTOM_TYPES covers the whole
       vocabulary in one place now. */
    const wTypeRaw = (q.get("garment_type") || "").toLowerCase().trim();
    const wType    = wTypeRaw === "unknown" ? "" : wTypeRaw;
    const wName    = q.get("garment_name") || q.get("name") || "";
    const isPants  = EXPLICIT_BOTTOM_TYPES.has(wType) ||
                     (!EXPLICIT_TOP_TYPES.has(wType) && classifyGarmentTitle(wName) === "bottom");
    // Multi-image gallery: the widget forwards ALL product photos as a comma-joined
    // list of individually-encoded URLs (?garment_images=), ALREADY sorted front-first
    // (pear-widget.js classifies them through /api/classify-images). Photo 1 is the
    // primary garment (kept in sync with garment_url), photo 2 is its rear view. Both
    // are resolved automatically below — the user never picks a photo (the thumbnail
    // switcher this list used to drive was removed).
    const imagesRaw = q.get("garment_images");
    let pearImages;
    if (imagesRaw) {
      pearImages = imagesRaw.split(",")
        .map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } })
        .filter((u) => /^https?:\/\//i.test(u));
      if (!pearImages.length) pearImages = undefined;
    }
    // The gallery's own back view: photo 2, as long as it's a DISTINCT URL from the
    // front (an identical pair is a mirrored front — pointless to stitch, and
    // canCombineViews() would reject it anyway). Undefined for a single-image handoff.
    /* Canonical comparison (sameImage), not string equality. The gallery routinely
       carries one photo under two spellings - ?width=800 vs ?width=1400, ?v= cache
       busters, a _800x filename suffix - and a raw !== call let that pair through as
       "front + back". The session then went live with the FRONT photo bound as the
       back reference and the "reproduce the BACK, do NOT render the front" clause
       attached to it, which is what duplicated the chest print onto the back. */
    const galleryBack = (pearImages && pearImages[1] && !sameImage(pearImages[1], pearImages[0]))
      ? pearImages[1] : undefined;
    const result = {
      id: null, custom: true,
      name: q.get("garment_name") || "Garment",
      type: isPants ? "pants" : "shirt",   // toItem() → garmentType (lower_body|upper_body)
      subType: "",                          // no catalog subType → generic custom prompt
      color: "#8a8f98",                     // neutral placeholder; the image is the reference
      img: (pearImages && pearImages[0]) || widgetUrl,   // first gallery photo = primary
      pearImages,                           // full gallery list (undefined when single-image)
      // Dual-View back asset, resolved with ZERO user input (there is no photo picker):
      // an explicit ?garment_url_back= / ?imgBack= wins, else the gallery's second photo.
      // A real, DISTINCT back is exactly what makes canCombineViews() true, which is what
      // flips renderPerspectiveSelector() into AI Auto automatically. When neither
      // exists the item stays single-view (front image + prompt steering) — never blocked.
      // `back_image_url` is the v2 spelling pear-widget.js now sends alongside the
      // original name; both carry the same value, so either build of the widget works.
      imgBack: q.get("garment_url_back") || q.get("back_image_url") || q.get("imgBack") || galleryBack,
      // Opt-in strict gate: the widget forwards ?require_both_views=1 when the embed
      // sets data-pear-require-both-views. Hard-blocks go-live unless a real back
      // image arrived (custom garments are otherwise ungated - see liveBlockReason).
      requireBothViews: q.get("require_both_views") === "1",
      // Shopify variant id (widget reads it off the store's own Add-to-Cart form) -
      // carried through so the "הוסף לסל" button here can hand it back to the
      // storefront's own /cart/add.js call (see pear-widget.js's PEAR_ADD_TO_CART listener).
      variantId: q.get("garment_variant_id") || undefined,
      /* The host product's REAL size list, comma-joined by the widget. THE signal that
         decides kids-vs-adult (see isKidsProduct) - a Gemini packshot verdict is only
         the fallback when this is absent, which is exactly how the FOX kids-tee bug
         got through. Carried through RAW (the comma string) rather than parsed here:
         every reader already normalises via parseSizeList(), which accepts both forms,
         so this stays a pure param read with no dependency on code defined elsewhere
         in the module. Absent leaves it undefined, never "", so "no list arrived" stays
         distinguishable from "the product genuinely lists no sizes". */
      sizes: q.get("garment_sizes") || undefined,
      angle: readAngle(),
    };
    // CHECK B instrumentation - the exact point imgBack is resolved, showing which of
    // the three sources won, so a blank back can be traced to its origin immediately.
    console.log("[PEAR] parseHandoff() - back-image resolution:", {
      garment_url_back: q.get("garment_url_back") || "(absent)",
      back_image_url:   q.get("back_image_url") || "(absent)",
      imgBack_param:    q.get("imgBack") || "(absent)",
      galleryBack:      galleryBack || "(absent)",
      resolved_imgBack: abbrevImg(result.imgBack) || "(NONE - back view will be unavailable)",
      // Canonical comparison, not string equality: ?width=/?v=/_800x spellings of the
      // SAME photo must report as NOT distinct, or the front gets bound as the back.
      distinct_from_front: !!(result.imgBack && !sameImage(result.imgBack, result.img)),
    });
    if (!result.imgBack) {
      console.error("[PEAR] CRITICAL: no back image in handoff - the garment is single-view, " +
                    "so turning around cannot render a real rear photo.");
    }
    console.log("[PEAR] parseHandoff() - widget embed garment:", result);
    return result;
  }

  const id = parseInt(q.get("id"), 10);
  const fromCatalog = !isNaN(id) ? PEAR_CATALOG.find((p) => p.id === id) : null;

  const type = (q.get("type") || q.get("itemType") || (fromCatalog && fromCatalog.type) || "").toLowerCase();

  console.group("[PEAR] parseHandoff() - URL params debug");
  console.log("full URL     :", location.href);
  console.log("id param     :", q.get("id"), "→ parsed:", id);
  console.log("type param   :", q.get("type") || "(none)");
  console.log("itemType     :", q.get("itemType") || "(none)", "→ resolved type:", type || "(EMPTY - focus mode disabled)");
  console.log("subType      :", q.get("subType") || "(none)");
  console.log("angle        :", q.get("angle") || "(none)", "→ resolved:", readAngle());
  console.log("color        :", q.get("color") || "(none)");
  console.log("name         :", q.get("name") || "(none)");
  console.log("img          :", q.get("img") ? q.get("img").slice(0, 80) + "…" : "(none)");
  console.log("fromCatalog  :", fromCatalog ? fromCatalog.name : "(not found in PEAR_CATALOG)");
  if (!type) console.warn("[PEAR] parseHandoff() - no type resolved; focus mode OFF (catalog view will show)");
  console.groupEnd();

  if (!type) return null;

  const color = q.get("color") ? "#" + q.get("color").replace(/^#/, "") : (fromCatalog ? fromCatalog.color : "#0B3C95");
  const result = {
    id: isNaN(id) ? null : id,
    name: q.get("name") || (fromCatalog ? fromCatalog.name : "Garment"),
    type,
    subType: q.get("subType") || (fromCatalog ? fromCatalog.subType : (type === "pants" ? "regular" : "short_sleeve")),
    color,
    img: q.get("img") || (fromCatalog ? fromCatalog.img : ""),
    // Dual-View back asset: explicit ?imgBack= wins, else the catalog entry's imgBack.
    imgBack: q.get("imgBack") || (fromCatalog ? fromCatalog.imgBack : undefined) || undefined,
    // The PDP gallery angle to open on (front|back|side) - see enterRoom().
    angle: readAngle(),
  };
  console.log("[PEAR] parseHandoff() - resolved handoff:", result);
  return result;
}

/* ── Garment category detection - "my shorts were fitted as a shirt" ─────────────
   THE BUG: "מכנס קצר רגל - FOX" was labelled "בגד עליון שהעלית" and sent through the
   upper-body prompt branch. The branch was right; the CATEGORY handed to it was wrong.

   FIVE SEPARATE MISSES produced it, all in the same keyword sweep, and all landing on a
   silent `DEFAULT_CATEGORY = "tops"`:

     · the list held "מכנסיים" (plural) and the title says "מכנס" (singular stem).
       Hebrew inflects by SUFFIX, so a substring test for a fully-inflected form cannot
       match its own stem - מכנס / מכנסי / מכנסיים are three surface forms of one word.
     · "ברמודה" and "שורטס" were not in the list at all.
     · "ג'ינס" was listed with the Hebrew geresh (U+05F3) only; storefronts type an
       ASCII apostrophe (U+0027) just as often. Same word, different codepoint.
     · "חצאית" was filed under `dress`, and the only lower-body test anywhere was
       `type === "pants" || type === "bottoms"` - so every skirt read as a top.

   AND THE TOPS SIDE WAS BROKEN IDENTICALLY, just invisibly: "חולצת פולו" never matched
   "חולצה" either (construct state). It came out right only because the fallback was
   "tops" - a default that hides the failure it is also causing.

   SO THE FIX IS STEMS, not a longer list of surface forms. Matching מכנס / חולצ / חצאי
   matches every inflection; matching מכנסיים matches exactly one. English keeps word
   boundaries instead, because it compounds in the other direction - a stem match on
   "short" would swallow "short sleeve" and turn every tee into a pair of shorts.

   AND ABSTENTION IS A REAL ANSWER. Tier 1 returns null when it does not know, which is
   what makes a tier 2 possible at all: a sweep that silently guesses "top" has nothing
   left to escalate, and that guess is exactly what shipped the bug. */
const GARMENT_CATEGORY_KEYWORDS = Object.freeze({
  /* Hebrew entries are STEMS, matched as substrings so every inflection follows.
     English entries are matched with word boundaries - see WORD_BOUNDED below. */
  bottom: Object.freeze({
    he: ["מכנס", "ג'ינס", "ג׳ינס", "ברמודה", "שורטס", "שורט", "חצאי", "טייץ", "טייצ", "לגינ"],
    en: ["pants", "shorts", "trousers", "jeans", "skirt", "skirts", "bottoms", "bottom",
         "leggings", "chinos", "joggers", "sweatpants", "slacks", "culottes", "bermuda"],
  }),
  top: Object.freeze({
    he: ["חולצ", "טישרט", "טי-שירט", "סווטשירט", "סוודר", "גופי", "ז'קט", "ז׳קט",
         "מעיל", "קפוצ'ון", "קפוצ׳ון", "בלייזר", "קרדיגן", "טופ"],
    en: ["shirt", "tshirt", "t-shirt", "tee", "top", "tops", "hoodie", "jacket", "blazer",
         "sweater", "sweatshirt", "cardigan", "blouse", "polo", "tank", "pullover", "coat"],
  }),
});

/* Hebrew has no case and no word boundary that \b understands (it is non-ASCII, so \b
   sits at every Hebrew/Latin transition and nowhere useful inside a Hebrew phrase), which
   is the other half of why the two languages are matched differently rather than merged
   into one list. */
const hasHebrewStem = (text, stems) => stems.some((s) => text.includes(s));
const hasEnglishWord = (text, words) =>
  words.some((w) => new RegExp(`\\b${w.replace(/[-]/g, "\\-")}\\b`, "i").test(text));

/**
 * TIER 1 - keyword/stem classification of a garment from its free text.
 *
 * @param {...(string|null|undefined)} texts - title, name, category; joined and scanned.
 * @returns {"top"|"bottom"|null} null means ABSTAIN - either nothing matched, or both
 *   sides did. Both are escalated to tier 2 rather than resolved by list order, because
 *   list order is not evidence and picking by it is how the original bug read as a
 *   confident verdict.
 */
/* THE FABRIC/GARMENT COLLISION. "ג'ינס" and "denim" name a lower-body garment AND a
   material, so "ז'קט ג'ינס" (denim jacket) matches both sides at once. A denim jacket is
   a common real product, and it is a TOP - the garment noun is the subject and the fabric
   is a modifier of it. Stripping the fabric words and re-testing resolves the collision
   in the direction that is right by grammar rather than by list order; anything still
   ambiguous afterwards is genuinely ambiguous and abstains properly. */
const FABRIC_AMBIGUOUS = ["ג'ינס", "ג׳ינס", "jeans", "denim"];

function classifyGarmentTitle(...texts) {
  const raw = texts.filter((t) => typeof t === "string" && t.trim()).join(" ");
  if (!raw) return null;
  const text = raw.toLowerCase();
  const scan = (t) => ({
    bottom: hasHebrewStem(t, GARMENT_CATEGORY_KEYWORDS.bottom.he) ||
            hasEnglishWord(t, GARMENT_CATEGORY_KEYWORDS.bottom.en),
    top:    hasHebrewStem(t, GARMENT_CATEGORY_KEYWORDS.top.he) ||
            hasEnglishWord(t, GARMENT_CATEGORY_KEYWORDS.top.en),
  });

  let { bottom, top } = scan(text);
  if (bottom && top) {
    /* Re-scan with the fabric words removed. If the lower-body evidence was ONLY the
       fabric ("ז'קט ג'ינס" → "ז'קט "), the top noun stands alone and wins. If real
       lower-body evidence survives ("מכנס ג'ינס" → "מכנס "), nothing changes and the
       title is still genuinely two-sided. */
    const stripped = FABRIC_AMBIGUOUS.reduce((s, w) => s.split(w).join(" "), text);
    const re = scan(stripped);
    if (re.top && !re.bottom) return "top";
    if (re.bottom && !re.top) return "bottom";
  }
  if (bottom === top) return null;              // neither, or still both - abstain
  return bottom ? "bottom" : "top";
}

/* The two vocabularies in this codebase - "top"/"bottom" from the classifier, and
   "upper_body"/"lower_body" in item state (what slotOf() and isBottomsGarment() read) -
   converted in exactly one place. Two spellings of one fact is how they drift apart. */
const categoryToGarmentType = (cat) => (cat === "bottom" ? "lower_body" : "upper_body");

/* Explicit type markers, from the widget's own vocabulary AND the catalog's. "dress" is
   deliberately absent: a dress covers both regions and has no correct answer here, so it
   falls through to the title/LLM tiers rather than being forced onto a side. */
const EXPLICIT_BOTTOM_TYPES = new Set(["pants", "bottoms", "bottom", "shorts", "skirt", "lower_body"]);
const EXPLICIT_TOP_TYPES    = new Set(["shirt", "top", "tops", "outerwear", "upper_body"]);

/**
 * The full resolution chain, in priority order. Each tier only runs when every tier
 * above it abstained.
 *
 *   1. garmentType   the catalog's own classification - ground truth, never overridden
 *   2. type          the widget/catalog type marker, incl. shorts/skirt/outerwear which
 *                    the old `type === "pants"` test dropped on the floor
 *   3. title         tier 1 stems, above
 *   4. LLM           tier 2, for genuinely ambiguous titles and bare custom uploads
 *   5. "top"         the majority of the catalog - now the LAST resort rather than the
 *                    FIRST, which is the actual difference between this and the bug
 *
 * @param {object|null} item
 * @returns {Promise<"top"|"bottom">} always resolves; never throws.
 */
async function resolveGarmentCategory(item) {
  if (!item) return "top";
  if (item.garmentType === "lower_body") return "bottom";
  if (item.garmentType === "upper_body") return "top";

  const type = String(item.type ?? item.category ?? "").toLowerCase().trim();
  if (EXPLICIT_BOTTOM_TYPES.has(type)) return "bottom";
  if (EXPLICIT_TOP_TYPES.has(type)) return "top";

  const byTitle = classifyGarmentTitle(item.name, item.title, item.category);
  if (byTitle) return byTitle;

  /* TIER 2. Bounded and swallowed: a classification call is an ENHANCEMENT, and it must
     never be able to stall or fail a try-on. Promise.race against a timer rather than an
     AbortController because the seam is a plain async function - callers may implement it
     over fetch, over a worker, or (in tests) not at all, and the bound has to hold for
     all three. Everything that is not a clean "top"/"bottom" falls through to the
     default, including a hang, a throw, an unconfigured API key and a garbage string. */
  try {
    const verdict = await Promise.race([
      classifyGarmentViaLLM(item.name || item.title || ""),
      new Promise((resolve) => setTimeout(() => resolve(null), CATEGORY_LLM_TIMEOUT_MS)),
    ]);
    if (verdict === "top" || verdict === "bottom") return verdict;
  } catch (e) {
    console.warn("[PEAR] resolveGarmentCategory() - LLM tier failed, using default:", e?.message || e);
  }
  return "top";
}

function toItem(raw) {
  /* Tier 1 only - toItem() is synchronous and runs while building the catalog grid, where
     a per-card network round trip would be both slow and billable. The LLM tier runs later
     and only for the ONE item the shopper actually selects (see refineActiveItemCategory).
     The old body was `raw.type === "pants" ? "lower_body" : "upper_body"`, which silently
     dropped shorts, skirts and every Hebrew title onto the upper body. */
  const explicit = String(raw?.type ?? "").toLowerCase().trim();
  let category = null;
  if (EXPLICIT_BOTTOM_TYPES.has(explicit)) category = "bottom";
  else if (EXPLICIT_TOP_TYPES.has(explicit)) category = "top";
  else category = classifyGarmentTitle(raw?.name, raw?.title, raw?.category);
  return { ...raw, garmentType: categoryToGarmentType(category ?? "top"), categoryResolved: !!category };
}

/* Memoized per title: the same product is re-resolved on every swatch change, every
   replay and every re-entry into the room, and none of those are new information. */
const _categoryLLMCache = new Map();

/**
 * TIER 2 - the network seam. Kept as its own function (rather than inlined into
 * resolveGarmentCategory) because it is the only part that touches the network, and
 * keeping it separate is what lets the resolver be tested without one.
 *
 * NEVER THROWS AND NEVER REJECTS. Returns null for every failure - no key configured,
 * HTTP error, malformed body, unknown verdict - because the caller's contract is that a
 * classification miss degrades to tier 1 rather than surfacing to the shopper.
 * @param {string} title
 * @returns {Promise<"top"|"bottom"|null>}
 */
async function classifyGarmentViaLLM(title) {
  const key = String(title || "").trim();
  if (!key) return null;
  if (_categoryLLMCache.has(key)) return _categoryLLMCache.get(key);
  let verdict = null;
  try {
    const resp = await fetch(`${location.origin}/api/classify-garment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: key }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.category === "top" || data?.category === "bottom") verdict = data.category;
    }
  } catch (e) {
    console.warn("[PEAR] classifyGarmentViaLLM() - unavailable, tier 1 stands:", e?.message || e);
  }
  _categoryLLMCache.set(key, verdict);
  return verdict;
}

/**
 * Re-resolve the ACTIVE item's category through every tier, including the LLM, and apply
 * the correction if it disagrees with the synchronous tier-1 guess toItem() made.
 *
 * WHY THIS EXISTS AS A SECOND PASS. toItem() runs while building the catalog grid, once
 * per card; the LLM tier cannot run there without a network round trip per card. It also
 * cannot run at go-live, because by then the prompt is already on the wire. So it runs on
 * SELECTION - one item, one call, cached - which is the only point where the cost is one
 * request and the answer still arrives before it matters.
 *
 * DELIBERATELY A NO-OP WHEN TIER 1 WAS CONFIDENT (`categoryResolved`), so the common path
 * never touches the network at all. Mirrors the late-correction pattern
 * PEAR_UPDATE_GARMENT already uses for the product size list.
 */
async function refineActiveItemCategory(item) {
  if (!item || item.categoryResolved) return;
  const gen = sessionGen;
  const category = await resolveGarmentCategory(item);
  const garmentType = categoryToGarmentType(category);
  /* The shopper may have swapped items (or left) during the round trip - applying a
     verdict for a garment that is no longer active is the same class of bug as the
     reconnect path re-applying a stale garment. */
  if (gen !== sessionGen || activeItem !== item) return;
  if (item.garmentType === garmentType) return;
  console.log(`[PEAR] category refined: ${item.name} → ${category} (was ${item.garmentType})`);
  item.garmentType = garmentType;
  item.categoryResolved = true;
  /* Both surfaces the wrong category was visible on: the slot state that decides which
     prompt builder runs, and the chip that said "בגד עליון" over a pair of shorts.

     THE LOCAL IS NAMED `refinedSlot` ON PURPOSE, and this comment deliberately does not
     spell out the name it avoids. setActiveItem()'s slot write is the canonical one, and
     outfit-slot-isolation.test.mjs extracts that block out of app.js by matching its
     opening line as a literal string, then executes it. The match takes the FIRST
     occurrence in the file - so an identically-shaped statement ABOVE setActiveItem()
     silently becomes the code under test, and the suite starts asserting against the
     wrong function. A comment quoting the marker does it too, which is why this one
     describes it instead. Extract markers in this repo are an interface: don't collide
     with them, in code or in prose. */
  const refinedSlot = slotOf(item);
  activeOutfit[refinedSlot] = item;
  activeOutfit[refinedSlot === "top" ? "bottom" : "top"] = null;
  renderActiveGarment();
  updateSizeMismatchUI();   // the size ladder is category-scoped too
}

/* =============================================================================
   Screen transition
   ============================================================================= */
/* The actual Screen 1 → Screen 2 transition. Height/weight persistence (server
 * PATCH for a logged-in user + the pear_last_measurements_date stamp) happens
 * BEFORE this is called - see onSizeFormContinue()/updateMeasurementsNow() -
 * and routeUser() calls this directly for a returning visitor whose profile
 * is still within the 30-day window (nothing new to persist). */
/**
 * @param {{instant?: boolean}} [opts] - instant:true skips the branded Bitten-
 *   Pear transition entirely (straight commitSwap(), no ~1.2s animation). Used
 *   ONLY by routeUser()'s silent fast-path re-login (a known device with a
 *   fresh profile): that visitor never saw Screen 1 at all, so playing the
 *   full "Screen 1 → Screen 2" transition would show a multi-second animated
 *   detour to someone who should just land straight on the camera. The
 *   manual Continue-button path (onSizeFormContinue) always omits this, so it
 *   keeps the normal animated transition.
 */
function goToFitting(opts) {
  if (isDemoLocked()) { showDemoLockedScreen(); return; }
  // Demo-gate re-entry guard: this browser already spent its one measurement
  // (set by lockDemoGate() below on a prior call). Without this check, the
  // in-room "back" button (backToCalculator()) lets the visitor return to the
  // size form and call goToFitting() again in the SAME session, re-entering
  // the camera indefinitely - the lock was being set but never read back.
  if (DEMO_GATE && isDemoGateLocked()) {
    showDemoGateLockedMessage();
    return;
  }

  // NOTE: declared but not yet read anywhere below - looks like the other half of
  // this change (an opts.skipProfileSave gate on whatever it was meant to guard)
  // didn't survive a stash conflict. Kept rather than dropped since deleting it
  // risks discarding intended-but-incomplete work; flagging for a follow-up rather
  // than guessing at the missing behavior.
  const skipProfileSave = !!(opts && opts.skipProfileSave);
  // Log to Sheets the moment the user presses the button - always fire, even without handoff
  const _handoff = parseHandoff();
  const _payload = {
    garmentId:   _handoff?.id      ?? "",
    garmentName: _handoff?.name    ?? "",
    garmentType: _handoff?.type    ?? "",
    subType:     _handoff?.subType ?? "",
    // "-" (not "") when unresolved - unreachable in normal flow now that
    // calculateSize()'s "fits neither chart" state blocks Continue, but keeps
    // this an intentional "no match" marker rather than a blank spreadsheet
    // cell if it's ever hit some other way.
    size:        formatSizeLabel(currentUserSize) || "-",
  };
  fetch("/api/track-tryon", {
    method:    "POST",
    headers:   { "Content-Type": "application/json" },
    body:      JSON.stringify(_payload),
    keepalive: true,
  })
    .then(r => r.json())
    .then(data => { if (!data.ok) console.error("[analytics] sheet write failed:", data.error); })
    .catch(err  => console.error("[analytics] fetch failed:", err));

  // Admin dashboard - capture measurements + intent HERE, at the size-calculator
  // submit, BEFORE the camera ever starts. This records users who size up even if
  // they never go live. Garment comes from the store handoff; size is the
  // calculated recommendation.
  // Deliberately RAW here, not formatSizeLabel() - unlike the Sheets-bound payload
  // above, this lands in Supabase's sessions.size column, which server.js hard-
  // truncates to 8 chars (str(b.size, 8)). "12 (Kids)"/Hebrew "12 (ילדים)" would
  // get silently clipped to "12 (Kid"/similar garbage - corrupting exactly the
  // child-size rows this feature exists to make clearer. The admin dashboard can
  // derive "kids" from the raw numeric value itself if it ever needs to display it.
  // currentUserSize itself (not formatSizeLabel's output) is passed through
  // unmodified below - null when unresolved, handled by logSessionMeasurements()'s
  // own "-" fallback rather than here.
  logSessionMeasurements(
    { id: _handoff?.id ?? "", name: _handoff?.name ?? "" },
    currentUserSize
  );

  // Demo-gate mode: this is the visitor's one measurement - spend it now, right
  // as they commit to entering the try-on room.
  lockDemoGate();


  // The actual screen swap - deferred to the mid-point of the Bitten-Pear
  // transition so the change happens fully behind the opaque pear mask.
  const commitSwap = () => {
    try {
      // "-" (not "") when unresolved - unreachable in normal flow (Continue is
      // disabled whenever calculateSize() found no genuine match), but keeps
      // the headline sentence readable rather than showing a bare double-space
      // gap if this is ever reached some other way.
      $("final-size-text").innerText = formatSizeLabel(currentUserSize) || "-";
      $("screen-calculator").classList.remove("active");
      $("screen-fitting").classList.add("active");
      syncEditorialVideo();
      window.scrollTo(0, 0);
      enterRoom();
    } catch (err) {
      console.error("[goToFitting] screen transition failed:", err?.message || String(err), err);
      // Force the screen switch even if enterRoom() threw so the user isn't left on Screen 1
      try {
        $("screen-calculator").classList.remove("active");
        $("screen-fitting").classList.add("active");
        syncEditorialVideo();
      } catch (_) {}
      toast(t("errRoomLoad") + (err?.message || t("errRoomLoadRetry")));
    }
  };

  if (opts && opts.instant) { commitSwap(); return; }
  playPearTransition(commitSwap);
}

/* ─────────────────────────────────────────────────────────────────────────
   Bitten-Pear transition orchestrator - rAF-driven, promise-sequenced lifecycle.
   Single source of truth for BOTH the Continue-button click and the Enter-key
   path. All motion is GPU-composited (transform/opacity, see style.css); JS only
   arms the overlay and decouples the heavy DOM screen-swap into the HOLD window,
   executed on a real frame boundary so it never janks the 60/120fps run.

     frame 0       ── arm overlay (next frame, after a clean style flush)
     0–400ms       ── Phase 1 INTRO    (logo scales up + fades in)
     400–700ms     ── Phase 2 FLOOD    (pear-green ellipse seals the viewport)
       ↳ ~700ms    ──   commitSwap(): hide Screen 1 / show Screen 2 (100% covered)
     700–1200ms    ── Phase 3 APERTURE (flood scales ×3.5 + fades → reveal room)
     ~1200ms       ── sequence complete → resolve + tear the overlay down

   Returns a Promise that resolves once the overlay has been torn down.
   Honours prefers-reduced-motion (instant, correct swap, no theatre).
   ───────────────────────────────────────────────────────────────────────── */
function playPearTransition(commitSwap) {
  const overlay = document.getElementById("pearTransition");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!overlay || reduceMotion) { commitSwap(); return Promise.resolve(); }

  const SWAP_AT_MS = 700;    // the flood has fully sealed the viewport by here
  const END_MS     = 1200;   // total sequence length (matches the CSS keyframes)

  overlay.hidden = false;
  overlay.classList.remove("is-playing");

  return new Promise((resolve) => {
    // Double-rAF: flush the reset style on one frame, then start the keyframes on
    // the next - guarantees a clean restart with no first-frame flash, and anchors
    // our JS timeline to the same frame the animation begins.
    requestAnimationFrame(() => {
      requestAnimationFrame((startTs) => {
        overlay.classList.add("is-playing");
        let swapped = false;

        const tick = (now) => {
          const elapsed = now - startTs;

          // Swap during the HOLD - never while the GPU is mid-render on the exit.
          if (!swapped && elapsed >= SWAP_AT_MS) {
            swapped = true;
            commitSwap();
          }

          if (elapsed < END_MS) {
            requestAnimationFrame(tick);
          } else {
            // Exit keyframes have finished at full opacity-0; tear down on the
            // next frame so there is no visible cut between anim-end and hide.
            requestAnimationFrame(() => {
              overlay.classList.remove("is-playing");
              overlay.hidden = true;
              resolve();
            });
          }
        };
        requestAnimationFrame(tick);
      });
    });
  });
}

/* ── Screen-1 editorial video: pause whenever it is off-screen ────────────────
   #screen-calculator is hidden with `display: none` (.screen in style.css), but
   that does NOT pause a playing <video> - the element stays in its playing state
   and keeps its decoder, network buffer and frame queue alive. For a looping
   15MB clip that meant the whole fitting-room session paid for a decode pipeline
   nobody could see.

   This derives the desired state from the DOM rather than tracking it, so it is
   idempotent and safe to call from any transition (including the error-fallback
   paths): calling it twice, or from a screen that never touches the video, is a
   no-op. A missed call can only leave the previous state in place - never a
   wrong-and-sticky one - and the next transition corrects it.

   play() is only issued when the element is actually paused, and its promise is
   swallowed: autoplay can legitimately be rejected (low-power mode, no user
   gesture) and that must never surface as an unhandled rejection. The video is
   decorative (aria-hidden) - if the browser declines to resume it, nothing else
   in the flow is affected. */
function syncEditorialVideo() {
  const vid = document.querySelector("#screen-calculator .calc-editorial__video");
  if (!vid) return;
  const onCalculator = !!$("screen-calculator")?.classList.contains("active");
  try {
    if (onCalculator) {
      if (vid.paused) vid.play()?.catch(() => {});
    } else if (!vid.paused) {
      vid.pause();
    }
  } catch (_) {}
}

function backToCalculator() {
  $("screen-fitting").classList.remove("active");
  $("screen-calculator").classList.add("active");
  syncEditorialVideo();
  window.scrollTo(0, 0);
}

/* =============================================================================
   Fitting-room setup
   ============================================================================= */
function enterRoom() {
  const handoff = parseHandoff();

  if (handoff) {
    focusMode = true;
    document.body.classList.add("focus-mode");
    setActiveItem(toItem(handoff), { silent: true });
    const params = new URLSearchParams(location.search);
    console.log('[PEAR] garment_back param:', params.get('garment_url_back'));
    console.log('[PEAR] activeItem.imgBack set to:', activeItem?.imgBack);
    $("focusBar").hidden = false;
    $("catalogPanel").hidden = true;
    // Always set (never leave stale text): unreachable with a null size in
    // normal flow, but this only sets once per enterRoom() call, so a lingering
    // "if" guard would leave a PREVIOUS garment's size badge showing if this
    // path were ever reached with no size for the current one.
    $("focusSizeBadge").innerText = currentUserSize ? "מידה " + formatSizeLabel(currentUserSize) : "";
  } else {
    focusMode = false;
    $("focusBar").hidden = true;
    renderCatalogPanel();
    $("catalogPanel").hidden = false;
    setActiveItem(toItem(PEAR_CATALOG[0]), { silent: true });
  }

  // #completeLook visibility is owned by renderCompleteTheLook() (invoked from
  // setActiveItem above): it un-hides ONLY when real catalog complements exist, and
  // hides otherwise - so we never force an empty section visible here.
  // renderPerspectiveSelector() hardcodes currentAngle itself (AI Auto when a real back
  // exists, else front), so the storefront's front/back/side deep-link angle no longer
  // matters. (No photo switcher to render either: the front/back pair comes straight
  // from the handoff gallery, so the mode is selected without any user input.)
  renderPerspectiveSelector();
  setConn("idle");

  // Reset the size override to the Screen-1 recommendation and rebuild the selector UI.
  activeTryOnSize = currentUserSize;
  injectSizeSelector();
  // The garment just became active (possibly a NEW item/ageGroup) and the room is
  // about to be shown - re-check the mismatch card/button before the shopper sees it,
  // not only on the next calculateSize()/size-override change.
  updateSizeMismatchUI();

  // Pre-warm SDK + token so the go-live path skips both round-trips.
  warmupSDKAndToken();
  /* Fetch the pose model NOW, on Screen 2 entry, not when go-live is pressed. It is a
     multi-MB WASM runtime, and the whole point of the presence gate is to make the FIRST
     try work - putting that download on the critical path would trade one first-try
     failure for another. Fire-and-forget and failure-tolerant: by the time the shopper
     presses the button it is either resident or the gate quietly runs without it. */
  preloadPoseDetector();
}

/* Release a composite preview object URL. Called on every item swap so the blob backing
   the "Now fitting" thumbnail is freed rather than pinned for the page's lifetime. Safe
   to call on an item that never had one. */
function releaseCompositePreview(item) {
  if (!item || !item._compositeObjectUrl) return;
  try { URL.revokeObjectURL(item._compositeObjectUrl); } catch (_) {}
  item._compositeObjectUrl = null;
}

/* ── EAGER composite for the "Now fitting" chip ───────────────────────────────
   THE BUG THIS FIXES: the chip showed the front photo alone until the shopper
   pressed go-live, then switched to the FRONT|BACK composite - because the ONLY
   code that ever built one lived inside referenceImageFor(), which only runs from
   applyGarment(), which only runs as part of the live-session flow. Nothing built
   a composite at the moment the item was actually chosen (enterRoom → setActiveItem,
   or the widget's post-open correction) - so the chip's first paint, and every paint
   before go-live, was structurally front-only regardless of whether a back existed.

   This decouples the CHIP from the live-session machinery entirely: the instant a
   distinct back is known - whichever of the two ways it arrives - build the
   composite and repaint, with no dependency on whether the shopper has gone live.
     1. The widget hands over a ready-made composite (garment_composite in the
        PEAR_UPDATE_GARMENT listener) - already applied there directly, no work here.
     2. Only imgBack is known (an inline ?garment_url_back= at enterRoom() time, or a
        classifier verdict that arrived without a composite) - THIS function builds
        one locally, same code path applyGarment() already trusted for the live
        reference, just no longer gated behind pressing go-live.
   Guarded so it never fires twice for the same item and never clobbers a composite
   that has since arrived through the other path while this one was still building. */
function ensureActiveGarmentComposite(item) {
  if (!item || item.composite || item._compositeObjectUrl || item._compositeBuilding) return;
  const g = galleryOf(item);
  const back = distinctBackOf(item, g);
  if (!back) return;   // no distinct back yet - nothing to compose (not an error; may arrive later)

  item._compositeBuilding = true;
  createGarmentComposite(g.front || item.img, back).then((composite) => {
    item._compositeBuilding = false;
    if (!composite) return;   // createGarmentComposite already logs its own failure reason
    // Stale by the time it resolved: something else populated a composite on this
    // SAME item object in the meantime (e.g. the widget's postMessage won the race) -
    // never overwrite a real one with a redundant local rebuild.
    if (item.composite || item._compositeObjectUrl) return;
    try {
      item._compositeObjectUrl = URL.createObjectURL(composite);
    } catch (e) {
      console.warn("[PEAR] ensureActiveGarmentComposite: createObjectURL failed:", e?.message || e);
      return;
    }
    // Only repaint if this item is STILL the one on screen - the shopper may have
    // swapped garments while this was building.
    if (activeItem === item) renderActiveGarment();
  });
}

function setActiveItem(item, opts = {}) {
  // Swapping away from a garment: free its preview blob unless it IS the incoming one.
  if (activeItem && activeItem !== item) releaseCompositePreview(activeItem);
  activeItem = item;
  // Reset the active colour to the new item's first variant (null when it has none) so
  // the swatch strip + gallery always resolve to a valid colour for THIS product.
  activeColor = colorsOf(item)[0] || null;

  /* ── Outfit slot write: REPLACE by default, ADDITIVE only on request ─────────
     THE CROSS-ITEM MUTATION BUG ("I tried on a shirt and it changed my trousers").
     This write used to be additive unconditionally, but its two entry points mean
     opposite things to the shopper:
       · "Try this on" - a catalog card, a store handoff, a custom upload, a replay.
         ONE garment. The opposite slot must be cleared so applyActive() sends the
         SINGLE-garment prompt, which is scoped to the layer being replaced rather
         than to the whole subject.
       · "Add to Look" (הוסף ללוק) - the shopper is explicitly assembling an outfit,
         so the opposite slot survives and both garments render in one pass.
     Additively, a shopper who had EVER selected trousers left activeOutfit.bottom
     populated for the rest of the session. Picking a shirt afterwards therefore made
     resolveLook() return a complete look, and applyLook() substituted BOTH layers -
     replacing real trousers the shopper never asked to try on. That is deterministic
     state leakage, not a model hallucination: the single-garment prompt - the only one
     that pins the untouched layer - was simply never the one on the wire. It surfaces on
     stepping back because that is when the lower body enters frame and the substitution
     becomes visible. (The clause it used to name, KEEP_BOTTOMS, is retired: no builder
     assembles the DENSE table any more, and the pin now lives inside
     CATEGORY_ANCHOR.bottom. The state bug and its fix are unaffected either way.) */
  const slot = slotOf(item);
  activeOutfit[slot] = item;
  if (!opts.additive) {
    activeOutfit[slot === "top" ? "bottom" : "top"] = null;
    const cl = $("completeLook");
    if (cl) cl.classList.remove("is-complete");
  }

  $("focusItemName").innerText = item.name;
  /* Widget handoff (custom:true) that opened with NO back yet: the widget's own
     classify+synthesize round trip is still running on the STORE page (measured in
     production: ~2.5s when a durable/warm cache answers it, ~27s on a genuine cold
     generation) and will correct this via PEAR_UPDATE_GARMENT whenever it finishes.
     Flag it so renderActiveGarment() can show that something is actively happening
     instead of a bare front photo that is indistinguishable from "no back exists".
     A bounded timeout clears it if nothing ever arrives (a failed round trip, or a
     genuinely single-view product with no widget correction coming at all) so the
     indicator cannot spin forever. */
  if (item._awaitingBackTimer) { clearTimeout(item._awaitingBackTimer); item._awaitingBackTimer = null; }
  item._awaitingBackCorrection = !!(item.custom && !item.composite && !distinctBackOf(item));
  if (item._awaitingBackCorrection) {
    item._awaitingBackTimer = setTimeout(() => {
      item._awaitingBackTimer = null;
      if (!item._awaitingBackCorrection) return;   // already resolved by the time this fired
      item._awaitingBackCorrection = false;
      console.log("[PEAR] gave up waiting for a back-view correction after 35s -", item.name);
      if (activeItem === item) renderActiveGarment();
    }, 35000);
  }
  renderActiveGarment();             // shows either the single item or the full look
  /* Fire-and-forget tier-2 category refinement. A no-op unless toItem()'s keyword pass
     ABSTAINED on this item, so the common path never touches the network; when it did
     abstain, this is the one point where the cost is a single request and the verdict
     still lands before go-live. It re-renders the chip itself if the answer moves. */
  refineActiveItemCategory(item).catch((e) =>
    console.warn("[PEAR] refineActiveItemCategory() failed, tier-1 category stands:", e?.message || e));
  /* ── PREFETCH THE REFERENCE THE MOMENT A GARMENT IS CHOSEN ──────────────────
     Not at go-live, and no longer only for dual-view items. prewarmOrientationAssets()
     was reachable ONLY from the two branches that set currentAngle = AUTO_ANGLE, so a
     front-only garment - most of the catalog - had NOTHING warmed: the first time its
     image was touched was inside the go-live apply, which then shipped a URL for Decart
     to fetch server-side before it could condition on anything. That is the "assembling
     the reference takes too long" delay and the first second of generic output, from the
     same cause.
     Fire-and-forget by design: it fetches the front (and the back and the stitched
     composite when those exist), and every one of those is a cache fill nothing waits on.
     By the time the shopper presses the button the bytes are resident and
     referenceImageFor() hands them over directly - see garmentBlobIfWarm(). */
  prewarmOrientationAssets();
  // Fire-and-forget: builds the FRONT|BACK composite the instant a distinct back is
  // already known (e.g. an inline ?garment_url_back=), instead of waiting for go-live.
  ensureActiveGarmentComposite(item);
  renderCompleteTheLook(item);
  highlightCatalog(item.id);
  renderPerspectiveSelector();       // rebuild angle tabs + source preview for the new selection

  if (!opts.silent) {
    toast(`עכשיו מודדים: <b>${item.name}</b>`);
    resetToLive();
    // applyActive() re-applies the FULL look when both slots are filled (so a mid-
    // session shirt/pants swap restyles the whole outfit), else just this garment.
    if (isLive()) applyActive().catch((e) => console.warn("pre-apply garment:", e?.message || e));
  }
}

// Exposed for lux-interactions.js (a plain, non-module script that can't import
// app.js's module-scoped `activeItem`/size state) so the "הוסף לסל" click handler
// knows which exact garment/variant/size to hand the host store's cart (see
// PEAR_ADD_TO_CART in lux-interactions.js -> pear-widget.js's Host Cart
// Integration). sku falls back to variantId, then the catalog id, since not
// every catalog entry carries a dedicated sku field; quantity is always 1 -
// there is no quantity picker anywhere in this UI to read a real value from.
window.pearGetActiveGarment = function () {
  if (!activeItem) return null;
  /* Variant-resolved, not base-resolved. Reading activeItem.sku directly meant a shopper
     who picked the red swatch added the BASE colour to their cart - the swatch moved the
     photo and nothing else. variantMetaOf() falls back to exactly the old values when the
     item has no variant table, so single-colour items are unaffected. */
  const meta = variantMetaOf(activeItem);
  return {
    url: activeImageOf(activeItem) || activeItem.img,   // the variant's own packshot
    name: activeItem.name,
    color: activeColor || undefined,                    // which swatch, for the host's UI
    variantId: meta.variantId,
    sku: meta.sku,
    size: activeTryOnSize || currentUserSize || "",
    quantity: 1,
  };
};

/* =============================================================================
   Multi-Image Product Gallery Sync - colour swatches + perspective rail
   ─────────────────────────────────────────────────────────────────────────
   Switching a COLOUR or an ANGLE never reconnects: while a billable session is live
   we re-issue the garment through the existing applyActive() pipeline (one
   rtClient.set(), same session, same ek_ token, same strict window); otherwise we
   just remember the choice so the next go-live opens on it. The rail renders for
   EVERY garment and EVERY colour - angles with no dedicated photo fall back to the
   front image + a prompt clause, so the UI can never empty out (the bug this fixes).
   ============================================================================= */
function setAngle(angle) {
  // Every wearable angle is always selectable (a missing photo falls back to the front
  // image + prompt steering); `detail` is inspection-only and never a live warp target.
  // "auto" (Context-Aware Asset Switching) is selectable only while the item ships a
  // real, distinct back (canCombineViews).
  const isSynthetic = angle === AUTO_ANGLE && canCombineViews(activeItem);
  const next = (WEARABLE_ANGLES.includes(angle) || isSynthetic) ? angle : "front";
  if (next === currentAngle) return;
  currentAngle = next;
  if (next === AUTO_ANGLE) {
    autoOrientation = null;                  // PENDING - acquired from the camera, not assumed
    autoProfile = false;                     // ...and no stale edge-on reading from a previous session
    prewarmOrientationAssets();              // fire-and-forget: both Blobs cached before the first turn
  }
  syncOrientationWatcher();                  // start/stop the webcam orientation monitor
  renderPerspectiveSelector();
  hotSwapIfLive(`מציג ${ANGLE_LABEL_HE[next]} · ${ANGLE_LABEL_EN[next]} view`);
}

/* Colour/variant swap. Re-renders the swatch strip against the NEW colour's own gallery,
   then hot-swaps the live stream in place. AI Auto mode is preserved across the swap. */
function setColor(color) {
  if (!colorsOf(activeItem).includes(color) || color === activeColor) return;
  activeColor = color;
  renderPerspectiveSelector();
  hotSwapIfLive(`צבע · ${color}`);
}

/* Shared live hot-swap: re-issue the active garment through the existing applyActive()
   pipeline (one rtClient.set() - no reconnect, no extra handshake/token, no layout shift).
   No-op when not live. */
function hotSwapIfLive(toastMsg) {
  if (!isLive()) return;
  applyActive().catch((e) => console.warn("gallery hot-swap apply:", e?.message || e));
  if (toastMsg) toast(toastMsg);
}

/* ── Widget multi-image switcher — REMOVED ───────────────────────────────────
   There used to be a row of product-photo thumbnails (חזית / גב / תמונה N) pinned above
   the camera, letting the user hand-pick which forwarded gallery photo (?garment_images=)
   became the FRONT reference. Picking views is not the shopper's job: the front/back pair
   is now resolved automatically at handoff time (parseHandoff → img = photo 1,
   imgBack = photo 2, already classified front-first by pear-widget.js) and
   renderPerspectiveSelector() then turns that pair into AI Auto on its own. So the row,
   its injected CSS, its caption helper and selectPearImage() are all gone — no photo
   picker, no front/back toggle, nothing for the user to get wrong. `pearImages` survives
   on the item purely as the source those two assets are derived from. */

/* Widget → fitting-room, post-open correction: pear-widget.js now opens this room
   immediately on its DOM-order guess (see openModal()'s click handler) instead of
   waiting ~1-7s on /api/classify-images first. When that classification resolves and
   disagrees with the guess already showing, the widget posts this message so the
   room can silently swap to the real front/back - no reconnect, no reopening the
   modal. Trusted only from the embedding parent frame (we don't know the host's
   origin ahead of time, so e.source is the check, same as any iframe↔parent bridge). */
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;

  /* Kids/adult verdict, captured BEFORE the activeItem check below - Screen 1 (no
     activeItem yet) needs this every bit as much as Screen 2 does, and the widget
     sends it on the SAME message that would otherwise be dropped entirely by the
     early return below while the visitor is still on the measurement form. Synced
     onto activeItem too when it already exists, so nothing downstream needs to
     know which of the two variables to read - resolvedGarmentAgeGroup() checks
     activeItem first and falls back to this. "uncertain" is a real, meaningful
     value here (the classifier ran and found no confident answer) - distinct from
     undefined (no correction has arrived, or an older widget build never sent one). */
  /* The host product's REAL size list, handled BEFORE (and independently of) the
     classifier verdict below - it outranks it, and it can arrive on a message that the
     age-group branch would otherwise be the only reader of. Same Screen-1-safe
     treatment: recorded on pendingSizes, and synced onto activeItem when one exists.
     Stored RAW, exactly as parseHandoff() does - every reader normalises through
     parseSizeList() - so this listener stays free of module-level dependencies. */
  const incomingSizes = e.data.garment_sizes;
  if (incomingSizes && incomingSizes.length) {
    pendingSizes = incomingSizes;
    if (activeItem) activeItem.sizes = incomingSizes;
    const sizeFormEl = $("sizeForm");
    if (sizeFormEl && !sizeFormEl.hidden) { try { calculateSize(); } catch {} }
    // The room may already be open - rebuild the ladder against the real variants and
    // re-check the block, rather than waiting for the next item swap.
    try { injectSizeSelector(); updateSizeMismatchUI(); } catch {}
  }

  if (typeof e.data.garment_age_group === "string") {
    pendingAgeGroup = e.data.garment_age_group;
    pendingAgeGroupConfidence = Number.isFinite(e.data.garment_age_group_confidence)
      ? e.data.garment_age_group_confidence : undefined;
    if (activeItem) {
      activeItem.ageGroup = pendingAgeGroup;
      activeItem.ageGroupConfidence = pendingAgeGroupConfidence;
    }
    // Screen 1 may still be showing (the classify round trip can resolve WHILE the
    // visitor is filling in height/weight) - if so, re-derive the age field's
    // visibility and the recommendation immediately rather than waiting for the
    // next keystroke, which may never come if the field just became hidden.
    const sizeForm = $("sizeForm");
    if (sizeForm && !sizeForm.hidden) { try { calculateSize(); } catch {} }
    // The room may ALREADY be open (a returning shopper's instant-skip fast path, or
    // simply a slow classify round trip that resolves after go-to-fitting): a late
    // "kids" verdict landing here is exactly as capable of creating a mismatch as an
    // initial one, so re-check regardless of which screen is currently showing.
    try { updateSizeMismatchUI(); } catch {}
  }

  const front = e.data.garment_url;
  const back = e.data.garment_back;
  if (!activeItem || !front) return;
  const composite = typeof e.data.garment_composite === "string" && e.data.garment_composite
    ? e.data.garment_composite : undefined;
  /* The widget's classify+synthesize round trip has now FINISHED, whatever it found -
     stop showing "waiting for a back view" regardless of the unchanged early-return
     below (a message confirming "no back exists" still means the wait is over; the
     chip should stop looking like something is in progress). Read BEFORE clearing, so
     the unchanged branch below knows whether it owes a repaint purely for the spinner. */
  const wasAwaitingBack = !!activeItem?._awaitingBackCorrection;
  if (activeItem) {
    if (activeItem._awaitingBackTimer) { clearTimeout(activeItem._awaitingBackTimer); activeItem._awaitingBackTimer = null; }
    activeItem._awaitingBackCorrection = false;
  }
  /* THE "BANNER STILL SHOWS FRONT" BUG. This used to bail out here whenever front/back
     matched what activeItem already held, WITHOUT looking at whether a composite had
     arrived. pear-widget.js builds the composite AFTER /api/classify-images resolves -
     strictly later than the initial DOM-order guess this room opens on - so on any
     store where the DOM back-detection already agrees with the classifier (increasingly
     the common case; see findGalleryBack in pear-widget.js), img/imgBack never change
     between the initial open and this message. That message is nonetheless the ONLY
     delivery of garment_composite - and the old guard discarded it, unread, before this
     line. The chip (and the model's actual reference) then stayed on the single front
     photo for the entire session, every time DOM detection happened to be right. */
  const unchanged = activeItem.img === front && activeItem.imgBack === back &&
    (composite === undefined || activeItem.composite === composite);
  if (unchanged) {
    // Nothing about the garment itself changed, but if the chip was showing the
    // "waiting" indicator it still needs one repaint to clear it.
    if (wasAwaitingBack) renderActiveGarment();
    return;
  }
  activeItem.img = front;
  if (Array.isArray(e.data.garment_images) && e.data.garment_images.length) {
    activeItem.pearImages = e.data.garment_images;
  }
  // Back asset: TRUST the classifier's verdict completely now, including when it's
  // undefined - that means Gemini genuinely found no back-view photo in this item's
  // gallery (e.g. every photo is a front-view crop/angle, which is common for a
  // front-only print). This used to fall back to the gallery's second photo when
  // `back` was empty - the actual root cause of "back view renders print-less": a
  // second FRONT photo would get silently mislabeled as the back, pass every
  // fetch/decode/flatness check (it's a perfectly valid image, just the wrong
  // content), and reach Lucy prompted as "this is the BACK, do NOT render the front"
  // - so the model suppressed the graphic it could actually see. No fallback here
  // anymore; resolveFrontBack() in pear-widget.js is the single source of truth.
  activeItem.imgBack = back;
  /* Provenance of that back, straight from /api/classify-images (dom | classifier |
     synthetic | none). Purely diagnostic - a generated rear is treated exactly like a
     photographed one downstream, because by the time it gets here it IS a real,
     distinct image asset that preloadGarmentAssets() will validate like any other. */
  activeItem.backSource = e.data.garment_back_source || "unknown";
  /* Unified COMBINED reference, stitched by the widget on the store page (see
     createGarmentComposite in pear-widget.js). When present it IS the model
     reference - referenceImageFor() uses it verbatim and skips stitching again, so
     the composite the shopper gets is the exact image the widget produced rather
     than a second, independently built one. A data: URL, so every downstream path
     (garmentBlobCached, garmentImageRef) already handles it without a proxy hop. */
  if (composite) {
    activeItem.composite = composite;
    /* Panel geometry the widget actually drew. Diagnostic only - the composite is used
       verbatim either way - but it is what turns "the back renders as the front" from a
       guess into a readable fact, because it is the one signal that can contradict the
       LEFT=FRONT / RIGHT=BACK contract the prompt asserts. Optional: an older widget
       build sends no layout and describeCompositeLayout() just reports that. */
    const layout = e.data.garment_composite_layout;
    activeItem._compositeLayout = (layout && typeof layout === "object") ? layout : null;
    console.log("[PEAR] COMBINED composite received from the widget:",
      abbrevImg(activeItem.composite), "·", describeCompositeLayout(activeItem._compositeLayout));
  }
  // currentAngle is deliberately NOT set here: renderPerspectiveSelector() re-derives
  // it (AI Auto when the corrected pair qualifies, else front) with no user input.
  renderActiveGarment();
  // The widget's own composite (if it sent one) is already applied above. When it
  // didn't - imgBack alone arrived, e.g. a classifier verdict without a stitched
  // asset - build one locally right now rather than waiting for go-live. No-ops
  // instantly if activeItem.composite is already set.
  ensureActiveGarmentComposite(activeItem);
  renderPerspectiveSelector();
  console.log("[PEAR] PEAR_UPDATE_GARMENT applied - front:", abbrevImg(activeItem.img),
    "| back:", abbrevImg(activeItem.imgBack) || "(none)",
    "| back source:", activeItem.backSource, "| mode:", currentAngle);

  /* Race guard (FIX 4). The widget opens this room immediately on a DOM-order guess
     and only posts the classifier's real front/back 1-7s later, so the corrected back
     URL can land AFTER goLive() already pre-warmed the Blob cache (or after a stitch
     was memoized against the OLD pair). Both caches are keyed by URL, so the corrected
     pair is simply a different key - nothing stale is reused - but the NEW back would
     otherwise not be fetched until the first turn, adding a visible stall exactly when
     the user turns around. Re-warming here makes the corrected rear photo resident
     before it is needed. hotSwapIfLive() below then re-issues the reference in place. */
  prewarmOrientationAssets();
  hotSwapIfLive("מעדכן תמונת בגד · updating garment view");
});

/* Sync the live product gallery for the active item + colour. There is NO on-screen
   angle/mode picker and NO photo switcher (the perspective rail with its
   #perspectiveSelector element and the #pearImageSwitcher thumbnail row were both
   removed) — the try-on mode is derived here with no user input:
     • AI Auto (AUTO_ANGLE)  — the item ships a real, DISTINCT back photo. The
       OrientationWatcher swaps the live reference between the front and back assets
       as the shopper turns. This is the mode that makes a rear view actually render.
     • "front"               — single-view item, OR the item's OrientationWatcher
       couldn't arm this run (goLive()'s mode-settling block downgrades to this after
       a retry - see there; there is no stitched-composite fallback anymore).
   setAngle() remains in the file but is not wired to any UI.

   Also (re)syncs the OrientationWatcher on every call, not just at go-live: without
   this, switching to a different garment mid-session (setColor()/item swap) could
   leave the watcher armed for the OLD item's combine-eligibility (or not armed for a
   newly-eligible one) until the next full go-live, since nothing else re-checks it.
   (Name kept as-is: still called from every item/colour swap.) */
function renderPerspectiveSelector() {
  /* ── THE BLANK-BACK FIX (mode selection) ──────────────────────────────────────
     This used to hardcode COMBINED_ANGLE, which is why the back view rendered
     blank/garbled. COMBINED feeds Lucy ONE stitched 2048×1024 image (front | black
     bar | back) and *asks the prompt* to pick the correct half as the user turns.
     Lucy VTON regenerates every frame from that single reference and has no notion
     of "panels" and no state for "the user turned around" - so on a turn it is left
     interpreting a reference that is half front, half back and part solid black bar,
     and renders nothing usable. No amount of prompt wording fixes that, because the
     mechanism it depends on does not exist in the model.

     AUTO_ANGLE is the architecture this file already documents as the replacement
     ("Context-Aware Asset Switching... the model only ever sees ONE orientation at a
     time, so front/back cross-contamination is impossible BY CONSTRUCTION"). It was
     fully implemented but unreachable: nothing ever set it, so the whole
     OrientationWatcher / prewarm path was dead code. Selecting it here is what makes
     a turn actually swap in the real rear photo: the watcher reads the local camera,
     and on a confirmed flip applyActive() re-issues rtClient.set() with the CLEAN
     back Blob plus ANGLE_CLAUSE.backReal ("reproduce the BACK... do NOT render the
     front"). One unambiguous side, one unambiguous instruction.

     Degradation is safe in both directions: if the watcher cannot arm (after a
     retry - see goLive()'s mode-settling block), currentAngle downgrades to plain
     "front" - never a stitched composite, which was tried and removed after it
     produced double-logo/duplicated-garment renders (see the AUTO_ANGLE doc comment
     above ANGLES for why). If detection simply never fires, effectiveAngle() stays
     "front" too - identical to the front-only behaviour that already worked. */
  if (activeItem) {
    const wasAuto = currentAngle === AUTO_ANGLE;
    currentAngle = canCombineViews(activeItem) ? AUTO_ANGLE : "front";
    if (currentAngle === AUTO_ANGLE && !wasAuto) {
      autoOrientation = null;                  // PENDING - no startup FRONT lock; the camera decides
      autoProfile = false;                     // ...and no stale edge-on reading carried in
      prewarmOrientationAssets();              // fire-and-forget: both Blobs cached before the first turn
    }
  }
  syncOrientationWatcher();                    // idempotent - keeps the watcher in sync on every state change
  renderColorSwatches();
}

/* Colour swatch strip - shown only when the active item defines 2+ named variants.
   Clicking a bubble re-renders the whole gallery against that colour's own angle images. */
function renderColorSwatches() {
  const wrap = $("productSwatches");
  if (!wrap) return;
  const colors = colorsOf(activeItem);
  if (colors.length < 2) { wrap.hidden = true; wrap.innerHTML = ""; return; }

  if (!colors.includes(activeColor)) activeColor = colors[0];
  wrap.hidden = false;
  wrap.innerHTML = colors.map((key) => {
    const on = key === activeColor;
    return `<button type="button" class="pg-swatch${on ? " is-active" : ""}" data-color="${key}" ` +
           `role="radio" aria-checked="${on}" aria-label="${key}" title="${key}" ` +
           `style="--sw:${swatchColor(activeItem, key)}"></button>`;
  }).join("");
}


/**
 * Paint the "active garment" chip. With a single garment it shows that piece; once
 * the outfit is complete (top + bottom) it shows BOTH halves so the user can SEE
 * that adding a piece kept the other one - the additive look is never hidden.
 * @returns {void}
 */
function renderActiveGarment() {
  const { top, bottom } = activeOutfit;
  const chip = $("activeGarment");
  chip.hidden = false;
  const eyebrow = chip.querySelector(".active-garment__eyebrow");

  if (top && bottom) {
    $("activeGarmentMedia").innerHTML = `<span class="ag-duo">${garmentThumb(top)}${garmentThumb(bottom)}</span>`;
    $("activeGarmentName").innerText = `${top.name} + ${bottom.name}`;
    $("activeGarmentType").innerText = "לוק מלא · חולצה + מכנסיים";
    if (eyebrow) eyebrow.innerText = "לוק מלא · Full look";
    chip.classList.add("is-duo");
    chip.classList.remove("is-composite");   // duo owns the wide layout in this branch
  } else {
    const item = activeItem;
    $("activeGarmentMedia").innerHTML = garmentThumb(item);
    $("activeGarmentName").innerText = item.name;
    $("activeGarmentType").innerText = item.custom
      ? (item.garmentType === "lower_body" ? "בגד תחתון שהעלית · Custom upload" : "בגד עליון שהעלית · Custom upload")
      : (item.garmentType === "lower_body" ? "מכנסיים · " : "חולצה · ") + (SUBTYPE_LABEL_HE[item.subType] || "");
    if (eyebrow) eyebrow.innerText = "פריט נמדד · Now fitting";
    chip.classList.remove("is-duo");
    /* A composite is ~2:1, so the 60px square + object-fit:cover the chip normally uses
       would crop it down to a slice of the FRONT panel - the back would be invisible,
       which is the opposite of the point. `is-composite` widens the box and switches
       the image to object-fit:contain so both panels read clearly. */
    chip.classList.toggle("is-composite", thumbIsComposite(item));
    /* THE "LOOKS BROKEN" FIX: a fresh synthesis measured ~27s in production (Gemini
       image generation is genuinely slow) - long enough that a bare front photo with
       no indication anything is happening reads as "this doesn't work", not "still
       loading". `is-pending` shows a visible spinner over the thumbnail for exactly
       that window; thumbIsPending() is structurally false the instant a real
       composite exists, so this can never fight with is-composite above. */
    chip.classList.toggle("is-pending", thumbIsPending(item));
  }
  syncCaptureButtonPendingState();
}

/* Visual half of the go-live gate (the FUNCTIONAL half is livePendingReason() inside
   goLive() itself, which is the actual authority - this only has to look right).
   Deliberately does NOT touch captureBtn.disabled: that property already has several
   independent, carefully-ordered owners elsewhere (camera availability, the Task 10
   busy re-entrancy guard, the live/not-live toggle) and this function does not know
   -and should not need to know- the current state of any of them. A separate CSS
   class + pointer-events:none achieves the same "can't be clicked" result as a purely
   ADDITIVE layer on top, so it can never clobber or race with those other owners -
   whichever of them last touched .disabled keeps winning once this class clears. */
function syncCaptureButtonPendingState() {
  const btn = $("captureBtn");
  if (!btn) return;
  const pending = !!livePendingReason();
  btn.classList.toggle("is-pending-back", pending);
  btn.setAttribute("aria-busy", pending ? "true" : "false");
}

/* =============================================================================
   "Complete the Look" - incremental "Add to Look" (הוסף ללוק)
   ─────────────────────────────────────────────────────────────────────────
   addToLook() is fired from a recommendation card. It drops the chosen complement
   into ITS slot (top|bottom) beside whatever is already on, WITHOUT clearing the
   opposite slot, then - if a session is already live - restyles the whole outfit
   in place. The strict 5s window, countdown, recording and reset logic are all
   untouched; this only changes WHICH garments the existing goLive flow applies.
   ============================================================================= */
function addToLook(piece) {
  if (!piece) return;

  // The ONE additive caller: this is the shopper explicitly assembling an outfit, so
  // the opposite slot must survive. Every other setActiveItem() caller replaces the
  // outfit - see the slot-write comment there. silent so we own the toast/apply below.
  setActiveItem(piece, { silent: true, additive: true });
  resetToLive();

  if (outfitComplete()) {
    $("completeLook").classList.add("is-complete");
    toast(`לוק מלא: <b>${activeOutfit.top.name}</b> + <b>${activeOutfit.bottom.name}</b>`);
  } else {
    $("completeLook").classList.remove("is-complete");
    toast(`נוסף ללוק: <b>${piece.name}</b> - הוסף/י פריט מהקטגוריה המשלימה ללוק מלא`);
  }

  // Mid-session: restyle the live feed in place - the FULL look (both garments in
  // ONE payload) when complete, else just the updated garment. Same 5s session.
  if (isLive()) applyActive().catch((e) => console.warn("add to look:", e?.message || e));
}

/**
 * Validate the two outfit halves and return the verified {top, bottom} pair, or
 * null if the look is incomplete or mismatched (e.g. two tops, a missing half).
 * Reads activeOutfit directly so it is the single guard every full-look payload
 * passes through.
 * @returns {{top: object, bottom: object} | null}
 */
function resolveLook() {
  const { top, bottom } = activeOutfit;
  if (!top || !bottom) return null;
  if (top.garmentType !== "upper_body" || bottom.garmentType !== "lower_body") return null;
  return { top, bottom };
}

/* =============================================================================
   Camera + engine bootstrap
   ============================================================================= */
const card = () => $("cameraCard");

/* Task 10 - re-entrancy guard: getUserMedia is async, so two quick callers
   (e.g. the "enable camera" button AND Go Live) could each open a separate
   camera stream before localStream is assigned. We cache the in-flight promise
   so concurrent callers share ONE permission prompt and ONE MediaStream. */
let cameraStartPromise = null;

/**
 * Open the front camera exactly once and bind it to the #webcam element.
 * Idempotent and re-entrancy-safe: concurrent/repeat calls reuse the same
 * stream (or the same pending request) instead of prompting twice.
 * @returns {Promise<boolean>} true once the camera is live, false on failure/denial.
 */
/* 🍐 Pear loader - a juicy bouncing pear shown over the camera card whenever the
   app is busy loading (opening the camera, etc). Purely a visual cue; additive
   DOM, removed as soon as the load resolves. The go-live render reuses the pear
   baked into #scanOverlay. */
function showPearLoader(label) {
  const cc = $("cameraCard");
  if (!cc || document.getElementById("pearCamLoader")) return;
  const el = document.createElement("div");
  el.id = "pearCamLoader";
  el.className = "pear-cam-loader";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    `<div class="pear-loader">` +
      `<img class="pear-loader__fruit" src="/pear-logo.png" alt="" width="46">` +
      `<div class="pear-loader__shadow"></div>` +
      (label ? `<div class="pear-loader__label">${label}</div>` : "") +
    `</div>`;
  cc.appendChild(el);
}
function hidePearLoader() {
  const el = document.getElementById("pearCamLoader");
  if (el) el.remove();
}

/* Build getUserMedia video constraints for the CURRENT device + physical orientation.
   - Phones: request an orientation-matched aspect (portrait 9:16 / landscape 16:9) so the
     selfie preview fills the viewport without stretch, squish, or heavy crop.
   - Desktop: keep the compact landscape hint (512×288) - desktop webcams are landscape.
   `aspectRatio` is an *ideal* (best-effort); whatever the browser actually returns is then
   measured in loadedmetadata and the stage adapts. createThrottledInputStream() still
   downscales to LIVE_W×LIVE_H before Decart, so the billed input is never affected. */
function buildVideoConstraints(facing) {
  const isPhone  = window.matchMedia("(max-width: 768px)").matches;
  const portrait = window.matchMedia("(orientation: portrait)").matches;
  const video = {
    facingMode: facing,
    frameRate: { ideal: LIVE_FPS, max: LIVE_FPS },
  };
  if (isPhone) {
    video.aspectRatio = { ideal: portrait ? 9 / 16 : 16 / 9 };
  } else {
    video.width  = { ideal: LIVE_W };
    video.height = { ideal: LIVE_H };
  }
  return video;
}

async function startCamera(facing = cameraFacing) {
  if (isDemoLocked()) {
    toast(t("demoAlreadyUsed"));
    showDemoLockedScreen();
    return false;
  }
  if (localStream) return true;
  if (cameraStartPromise) return cameraStartPromise;   // a request is already in flight

  cameraStartPromise = (async () => {
    showPearLoader(t("camStarting"));        // 🍐 loading cue while permission/stream opens
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: buildVideoConstraints(facing),
        audio: false,
      });
      cameraFacing = facing;
      localStream.getVideoTracks().forEach((t) => {
        if ("contentHint" in t) t.contentHint = "motion";
      });
      const v = $("webcam");
      v.srcObject = localStream;
      // Reflect the active camera so CSS mirrors ONLY the front ("user") feed -
      // the rear camera must not mirror, or background text would read backwards.
      card().dataset.facing = facing;
      // Detect portrait vs landscape from the real stream once metadata arrives and
      // adapt the on-screen stage. Display only - Decart's 512×288 input is untouched.
      v.onloadedmetadata = () => {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return;
        cameraOrientation = vw < vh ? "portrait" : "landscape";
        card().dataset.orientation = cameraOrientation;
        console.log(`Camera orientation: ${cameraOrientation} (${vw}×${vh}) · facing: ${facing}`);
      };
      await v.play().catch(() => {});
      card().classList.add("live");
      $("camError").hidden = true;
      $("captureBtn").disabled = false;
      return true;
    } catch (err) {
      showCamError(t("camDenied") + " " + (err && err.message ? err.message : err) +
        t("camDeniedHint"));
      return false;
    } finally {
      hidePearLoader();
    }
  })();

  try { return await cameraStartPromise; }
  finally { cameraStartPromise = null; }
}

/* Sample ONE frame of ANY <video> element into a tiny downscaled canvas and measure
   how dark it is. Returns { ready, avgLuma, blackFrac }:
     • ready=false  → no decoded frame yet (videoWidth 0 / not paintable) - caller
                      must NOT treat this as black, only as "can't judge yet".
     • avgLuma      → mean Rec.601 luma across the frame (0-255).
     • blackFrac    → fraction of pixels below CAMERA_BLACK_PIXEL_CUT (near-black).
   Same-origin MediaStream pixels are not tainted, so getImageData never throws for
   security; any unexpected error still fails OPEN (ready=false) so we never wrongly
   block a paying user. 64×36 keeps this well under a millisecond.
   Shared by two callers: cameraLooksBlack() (local #webcam, the credit-saving gate)
   and armFirstFrameBilling() (remote #aiVideo, verifying the first real AI frame). */
function sampleVideoLuma(v) {
  if (!v || !v.videoWidth || !v.videoHeight) return { ready: false, avgLuma: 0, blackFrac: 1 };
  try {
    const cw = 64, ch = 36;                       // downscaled probe - cheap, enough for a luma verdict
    const cnv = document.createElement("canvas");
    cnv.width = cw; cnv.height = ch;
    const ctx = cnv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const total = cw * ch;
    let sum = 0, black = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Rec.601 luma - matches how "brightness" reads to the human eye.
      const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      sum += luma;
      if (luma < CAMERA_BLACK_PIXEL_CUT) black++;
    }
    return { ready: true, avgLuma: sum / total, blackFrac: black / total };
  } catch (_) {
    return { ready: false, avgLuma: 0, blackFrac: 1 };   // fail open - never block on a probe error
  }
}

/* Black-screen / camera-off verdict for the CREDIT-SAVING gate in goLive().
   Sends nothing to any API - it only inspects local webcam pixels. Samples a few
   frames (CAMERA_BLACK_SAMPLES) spaced by CAMERA_BLACK_SAMPLE_MS and keeps the
   BRIGHTEST one, so a single transient black frame during auto-exposure warm-up
   doesn't trip the gate - only a persistently black feed does.
   Returns true ONLY when we have a real, paintable frame that is black; if we never
   get a decodable frame we return false (fail open - let the normal connect path and
   its FIRST_FRAME_TIMEOUT_MS safety net handle a truly dead camera). */
async function cameraLooksBlack() {
  let sawFrame = false;
  let bestLuma = -1;          // brightest mean luma seen
  let bestBlackFrac = 1;      // lowest near-black fraction seen (from the brightest frame)
  for (let i = 0; i < CAMERA_BLACK_SAMPLES; i++) {
    const s = sampleVideoLuma($("webcam"));
    if (s.ready) {
      sawFrame = true;
      if (s.avgLuma > bestLuma) { bestLuma = s.avgLuma; bestBlackFrac = s.blackFrac; }
    }
    if (i < CAMERA_BLACK_SAMPLES - 1) {
      await new Promise((r) => setTimeout(r, CAMERA_BLACK_SAMPLE_MS));
    }
  }
  if (!sawFrame) return false;   // couldn't judge → don't block here; connect path guards a dead camera
  const isBlack = bestLuma <= CAMERA_BLACK_AVG_LUMA || bestBlackFrac >= CAMERA_BLACK_PIXEL_FRAC;
  if (isBlack) {
    console.warn("[PEAR] Black-screen gate tripped - skipping billed session " +
      "(avgLuma=" + bestLuma.toFixed(1) + " ≤ " + CAMERA_BLACK_AVG_LUMA +
      " or blackFrac=" + bestBlackFrac.toFixed(3) + " ≥ " + CAMERA_BLACK_PIXEL_FRAC + ")");
  }
  return isBlack;
}

/* Flip between the front ("user") and rear ("environment") camera. Stops ALL current
   preview tracks before requesting the new device so single-camera machines don't
   throw "device in use". Disabled while a billed session is live - we never swap the
   camera mid-generation, so the Decart throttler/connect are left completely untouched. */
async function flipCamera() {
  if (isLive()) return;                        // never flip during a billed session
  const btn = $("flipCamBtn");
  if (btn && btn.disabled) return;             // ignore double-taps while a switch is in flight
  const next = cameraFacing === "user" ? "environment" : "user";
  if (btn) btn.disabled = true;
  try {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());   // release the device first
      localStream = null;
    }
    // Keep .live on (the pear loader covers the card) so the placeholder doesn't flash.
    $("captureBtn").disabled = true;
    const ok = await startCamera(next);
    if (!ok) await startCamera(next === "user" ? "environment" : "user");  // roll back if the new camera fails
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Rotate handling - when the device flips between portrait and landscape, re-request the
   PREVIEW stream so its capture aspect follows the new orientation (no stretch on rotate).
   Guards: only when the camera is open, never during a billed session (would break the
   Decart stream), and never mid-flip. Fires only on a real portrait↔landscape flip, so it
   ignores plain resizes (mobile URL-bar show/hide).

   RACE FIX (Portrait→Landscape→Portrait, fast): the old version fired startCamera(facing)
   without awaiting it, relying on the localStream-null check alone for idempotency. A
   getUserMedia() re-request takes real time (the camera has to physically reconfigure for
   the new aspect ratio), and most devices only allow ONE open capture session per camera -
   so if the user rotated back again before that call resolved, startCamera()'s own shared
   cameraStartPromise guard (`if (cameraStartPromise) return cameraStartPromise;`) made the
   second reinit call just return the FIRST (still-pending, now-stale) request instead of
   ever issuing a fresh one - leaving the stream permanently mismatched with the device's
   actual final orientation (e.g. a landscape-shaped stream squeezed via object-fit:cover
   into the portrait-aspect .camera-card box → heavily cropped on the sides, exactly the
   "narrows into an unwanted tall format" symptom).

   Fix: this is now async and properly sequential - each startCamera() call is fully
   awaited before another can start, so cameraStartPromise is always settled (and thus
   never short-circuits a new call) by the time we'd issue one. reinitInFlight/reinitPending
   coalesce any rotations that happen WHILE a re-request is in flight (including the two
   listeners below both firing for one physical rotation) into a single trailing re-run
   instead of trying to overlap getUserMedia() calls on the same camera hardware - so the
   stream always converges on whatever orientation the device is ACTUALLY in once things
   settle, no matter how many times it flipped in between. */
let reinitInFlight = false;   // a stop+reopen sequence is actively running
let reinitPending  = false;   // another rotation arrived while one was already running
async function reinitCameraForOrientation() {
  if (!localStream) return;                 // camera not open - nothing to re-init
  if (isLive()) return;                     // never swap the stream mid-generation
  if ($("flipCamBtn")?.disabled) return;    // a flip is already switching cameras

  if (reinitInFlight) { reinitPending = true; return; }
  reinitInFlight = true;
  try {
    do {
      reinitPending = false;
      const facing = cameraFacing;
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      await startCamera(facing);   // re-open with orientation-matched constraints, fully awaited
    } while (reinitPending && localStream && !isLive());
  } finally {
    reinitInFlight = false;
  }
}

/* Smoothly bring the camera stage into a comfortable reading position after the user
   opens the camera - replaces the old `cameraCard.scrollIntoView({ block: "start" })`,
   which glued the card to the very top edge (and on mobile, partly UNDER the sticky
   header) and over-scrolled past the Go-Live button below it.

   Uses getBoundingClientRect() + window.scrollTo() instead of scrollIntoView so we can
   compute an exact offset rather than a hardcoded edge alignment, and can additionally
   check where the "Start Virtual Measurement" button (#captureBtn) lands and adjust.

   Two constraints, both measured live (no hardcoded pixel guesses):
     A) the camera top should sit just below whatever sticky chrome is on screen right
        now (the mobile sticky .app-header, or .focus-bar in a focused/deep-link entry)
        plus a bit of breathing room - the "offset" this fix introduces.
     B) the Go-Live button's bottom edge should stay above the viewport's bottom edge.
   When both fit on screen (the common case), (A) alone already satisfies (B), so the
   camera top lands just under the header exactly as requested. On a very short
   viewport where the two can't both fit, we favour (B) - showing the actionable
   button - over glueing the camera to the exact offset. */
function scrollToCamera() {
  const stage = $("cameraCard");
  if (!stage) return;
  const cta = $("captureBtn");

  // Whichever sticky bar is actually rendered right now (only one ever is: the mobile
  // sticky .app-header, or .focus-bar for a focused/deep-link product entry) reserves
  // real space at the viewport top, so the camera must not scroll to underneath it.
  const stickyBar = [document.querySelector(".focus-bar"), document.querySelector(".app-header")]
    .find((el) => el && !el.hidden && getComputedStyle(el).position === "sticky");
  const stickyH = stickyBar ? stickyBar.getBoundingClientRect().height : 0;

  const BREATHING_ROOM = 56;   // px of air below the sticky chrome - the comfortable offset
  const BOTTOM_PAD     = 24;   // px of air above the viewport's bottom edge for the button
  const topOffset = stickyH + BREATHING_ROOM;

  const stageRect = stage.getBoundingClientRect();
  const scrollA = window.scrollY + stageRect.top - topOffset;          // (A) camera top → offset

  let target = scrollA;
  if (cta) {
    const ctaRect = cta.getBoundingClientRect();
    const scrollB = window.scrollY + ctaRect.bottom - window.innerHeight + BOTTOM_PAD;  // (B) button bottom → on-screen
    target = Math.max(scrollA, scrollB);   // whichever needs MORE scroll wins - see constraints above
  }

  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo({ top: Math.max(0, Math.min(target, maxScroll)), behavior: "smooth" });
}

/* ── Loading-state elapsed timer + progressive onboarding steps
   (#scanOverlay / #scanSub / #scanStepText) ─────────────────────────────────
   LOADING (w/ timer) → Model Ready → Start 5s capture. Ticks a live mm:ss counter
   for as long as the loading overlay is up (goLive() start → startBillingWindow()'s
   Model Ready reveal, or an earlier failure/timeout - see those call sites for
   start/stop wiring). Alongside the counter, #scanStepText cycles through
   SCAN_STEPS on the same interval - guiding the shopper into frame, then
   explaining what's happening next - so the wait never feels silent or stalled.
   Copy is deliberately generic: never names the underlying AI vendor/model. */
const SCAN_STEPS = ["scanStepFrame", "scanStepCalibrate", "scanStepFitting"];
const SCAN_STEP_INTERVAL_SEC = 3;   // how long each onboarding message stays up before advancing
let scanTimerInterval = null;
let scanTimerStartMs = 0;
let scanStepIndex = -1;
function startScanTimer() {
  stopScanTimer();                 // clear any stale interval before arming a fresh one
  scanTimerStartMs = Date.now();
  updateScanTimer();
  scanTimerInterval = setInterval(updateScanTimer, 1000);
}
function updateScanTimer() {
  const timeEl = $("scanSub");
  const stepEl = $("scanStepText");
  const elapsedSec = Math.floor((Date.now() - scanTimerStartMs) / 1000);
  if (timeEl) {
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const ss = String(elapsedSec % 60).padStart(2, "0");
    timeEl.textContent = `${mm}:${ss}`;
  }
  if (stepEl) {
    const nextIndex = Math.min(Math.floor(elapsedSec / SCAN_STEP_INTERVAL_SEC), SCAN_STEPS.length - 1);
    if (nextIndex !== scanStepIndex) {
      scanStepIndex = nextIndex;
      // Crossfade rather than swap in place - opacity-only, no height change
      // (see .scan-overlay__text's reserved min-height), so the loader beneath
      // it never jumps between a short and a long onboarding message.
      stepEl.classList.add("is-fading");
      setTimeout(() => {
        stepEl.textContent = t(SCAN_STEPS[scanStepIndex]);
        stepEl.classList.remove("is-fading");
      }, 180);
    }
  }
}
function stopScanTimer() {
  if (scanTimerInterval) { clearInterval(scanTimerInterval); scanTimerInterval = null; }
  scanStepIndex = -1;
}

function showCamError(msg) {
  const el = $("camError");
  el.textContent = msg;
  el.hidden = false;
}

function resetToLive() {
  if (!isLive()) clearRecording();   // revoke replay URL + hide post-session buttons when no active API session
  exitClipReplay();                  // drop any history-clip playing in #aiVideo
  card().classList.remove("show-result");
  stopScanTimer();                   // defensive - never leave the loading counter ticking in the background
  $("scanOverlay").hidden = true;
  // #retakeBtn now lives in the .pear-interaction-pod; its visibility is governed
  // by the pod (shown once history exists), so it's no longer toggled here.
  $("captureBtn").disabled = !localStream;
}

/* =============================================================================
   Decart Lucy VTON realtime - connection
   ─────────────────────────────────────
   SECURITY: the browser never holds the permanent dct_ key. At the moment the
        user goes live we fetch a short-lived, scoped ek_ token from the secure
        proxy (/api/realtime-token) and hand THAT to createDecartClient().

   NOTE: models.realtime() does not exist in @decartai/sdk@0.1.5 - the model is
        passed as the plain object below (name "lucy-vton-latest" + stream opts).
   ============================================================================= */
async function loadSDK() {
  let lastErr;
  for (const url of SDK_URLS) {
    console.log("[PEAR] loadSDK() - importing", url);
    try {
      const mod = await import(/* @vite-ignore */ url);
      console.log("[PEAR] loadSDK() - loaded OK from", url);
      return mod;
    }
    catch (e) { lastErr = e; console.warn("SDK load failed from", url, e?.message || e); }
  }
  throw new Error("SDK load failed: " + (lastErr?.message || lastErr));
}

/**
 * Fire-and-forget pre-warm: loads the Decart SDK into the JS engine's import
 * cache AND pre-mints an ek_ token so connectRealtime() skips both round-trips
 * at go-live time. Saves ~0.5–1 s from the user-perceived click-to-live latency.
 * Called once when the user enters the fitting room (enterRoom).
 */
function warmupSDKAndToken() {
  loadSDK().catch(() => {}); // primes the browser's dynamic-import cache
  mintEphemeralToken().catch(() => {}); // pre-mints ek_ token into _tokenCache
}

/**
 * Normalize whatever the proxy reports as the token expiry into an epoch-ms number.
 * Decart may send it as ISO string, epoch milliseconds, OR epoch SECONDS. The old
 * `new Date(raw).getTime()` read a seconds value as milliseconds → a 1970 date →
 * the cache evaluated as permanently stale and re-minted on every go-live.
 * @param {string|number|null|undefined} raw
 * @returns {number} epoch ms; falls back to now + 5 min when absent/unparseable.
 */
function parseExpiry(raw) {
  const FALLBACK = Date.now() + 5 * 60 * 1000;   // 5-min safety margin
  if (raw == null) return FALLBACK;
  // Numeric or all-digit string → epoch. Values below 1e12 are seconds (1e12 ms ≈
  // year 2001), so scale them up to milliseconds.
  if (typeof raw === "number" || /^\d+$/.test(String(raw).trim())) {
    let n = Number(raw);
    if (!Number.isFinite(n)) return FALLBACK;
    if (n < 1e12) n *= 1000;                      // seconds → ms
    return n;
  }
  // ISO / RFC date string.
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : FALLBACK;
}

/**
 * Mint a short-lived ek_ token from the secure proxy (TOKEN_ENDPOINT).
 * Called ONLY at go-live (never on page load) so no token is minted/wasted while
 * the user is just browsing. The permanent dct_ key stays server-side.
 * @returns {Promise<string>} the ephemeral ek_ token string.
 * @throws {Error} if the proxy is unreachable or returns no valid token.
 */
async function mintEphemeralToken() {
  // Fast path: reuse cached token if still valid (30s safety margin before expiry).
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 30_000) {
    console.log("[PEAR] mintEphemeralToken() - cached ek_ token reused (expires in",
      Math.round((_tokenCache.expiresAt - now) / 1000), "s)");
    return _tokenCache.apiKey;
  }
  _tokenCache = null; // stale or absent - fetch fresh

  console.log("[PEAR] mintEphemeralToken() - POST", TOKEN_ENDPOINT);
  let resp;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[PEAR] mintEphemeralToken() - network error (server unreachable?):", e?.message || e);
    throw new Error("לא ניתן להגיע לשרת הטוקנים (" + (e?.message || e) + ")");
  }

  let data = {};
  try { data = await resp.json(); } catch (_) {}

  if (resp.status === 405) {
    const port = window.location.port;
    const where = port && port !== "3000"
      ? `port ${port} - open the fitting room at http://localhost:3000/fitting-room/ instead`
      : "a separate file server - open the fitting room via the Express server on port 3000";
    throw new Error(`HTTP 405: fitting room is served by ${where}.`);
  }

  console.log("[PEAR] mintEphemeralToken() - server responded HTTP", resp.status, "|",
    resp.ok ? "OK" : "FAILED",
    "| body keys:", Object.keys(data).join(", ") || "(empty)");

  if (!resp.ok || data.error) {
    const detail = data.message || data.error || `HTTP ${resp.status}`;
    console.error("[PEAR] mintEphemeralToken() - token mint failed:", detail,
      "\n  Full server response:", data,
      resp.status !== 405
        ? "\n  → Check that DECART_API_KEY in .env is set to a valid dct_… key from platform.decart.ai"
        : "\n  → Open the fitting room via http://localhost:3000/fitting-room/ (the Express server)");
    throw new Error("מינטינג טוקן נכשל: " + detail);
  }
  if (!data.apiKey) {
    console.error("[PEAR] mintEphemeralToken() - response OK but no apiKey field:", data);
    throw new Error("השרת לא החזיר טוקן ek_ תקין.");
  }
  const preview = data.apiKey.slice(0, 8);
  console.log("[PEAR] mintEphemeralToken() - token received, starts with:", preview + "…",
    "| model:", data.model || "(not in response)",
    "| expiresAt:", data.expiresAt || "(not in response)");

  // Cache the fresh token for reuse within its TTL. parseExpiry handles ISO strings,
  // epoch-ms AND epoch-seconds (5-min fallback if expiresAt is absent/unparseable).
  _tokenCache = {
    apiKey: data.apiKey,
    expiresAt: parseExpiry(data.expiresAt),
  };

  return data.apiKey;
}

/**
 * Task 2 - graceful pre-use connectivity check.
 * Lucy VTON is realtime/online-only. Before the user initiates a live fitting we
 * confirm the network path to our own server is up (a fast, same-origin probe of
 * HEALTH_ENDPOINT, bounded by HEALTH_PROBE_TIMEOUT_MS). This turns a cryptic
 * mid-connect SDK/WebRTC failure into a calm, actionable message. It does NOT
 * touch the proxy, token, or 5s teardown logic.
 * @returns {Promise<boolean>} true if the server is reachable, false if offline/timed-out.
 */
async function ensureOnline() {
  if (!navigator.onLine) { console.log("[PEAR] ensureOnline() - navigator.onLine is false, skipping probe"); return false; }
  console.log("[PEAR] ensureOnline() - GET", HEALTH_ENDPOINT);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
    const resp = await fetch(HEALTH_ENDPOINT, { method: "GET", cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    console.log("[PEAR] ensureOnline() - response", resp.status, resp.ok ? "OK" : "FAILED");
    return resp.ok;
  } catch (e) {
    console.warn("[PEAR] ensureOnline() - probe failed:", e?.message || e);
    return false;                               // unreachable / timed out → treat as offline
  }
}

/* =============================================================================
   Client-side FPS + resolution throttle - THE token-budget enforcer
   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS: @decartai/sdk@0.1.5 silently ignores model.fps and
   model.width/height on Chromium:
     • its mirror path (MediaStreamTrackProcessor → TransformStream) forwards EVERY
       camera frame, never reading the fps we pass;
     • its LiveKit publisher hardcodes maxFramerate:30 (defaultPublishFps);
     • model.width/height are never wired into the published track at all.
   Result: users were billed at the camera's native ~15–30fps instead of our cap.

   THE FIX: don't hand the SDK the raw camera. Paint the camera onto an off-DOM
   canvas at EXACTLY `fps` and `width`×`height`, and give the SDK canvas.captureStream
   instead. captureStream(0) + manual requestFrame() gives precise, source-rate-
   independent pacing, so Decart processes (and bills) at our rate, not the camera's.
   We also flip horizontally here so the SDK's mirror:"auto" no-ops on the canvas
   track (it has no facingMode) and the edited feed stays a correct selfie view.

   Returns { stream, dispose }. dispose() MUST run in teardown() - it clears the
   paint timer, stops the canvas track, and stops the cloned source track it owns.
   ============================================================================= */
/* ── Resource/token-usage optimization ────────────────────────────────────────
   This is the ONE place raw camera frames become the payload Decart bills on, so
   it's where "minimal frame/token usage" is actually enforced, not a place that
   needed new code - it already does exactly that:
     • fps capped to LIVE_INFERENCE_FPS (10) - the camera can capture faster (LIVE_FPS
       =15 for a smooth local preview), but only 10 frames/sec ever leave the browser.
     • resolution capped to LIVE_W×LIVE_H (512×288) - every frame is downscaled before
       it's sent, regardless of the camera's native resolution.
     • captureStream(0) + a single requestFrame() per tick - the output track emits
       EXACTLY fps frames/sec, never more; there is no separate/duplicate capture path
       sending additional raw frames anywhere.
   NOTE on "keypoints/pose data instead of frames": this app streams live video to
   Decart's Lucy VTON realtime diffusion model over WebRTC - there is no pose/landmark
   API in this pipeline to swap frames for (that would be a different, MediaPipe-style
   architecture; see project history). The real lever here is exactly what's already
   enforced above: fewer frames/sec, smaller frames, no redundant capture.
   MediaPipe landmarks ARE read now (see CONTINUOUS BODY TOPOLOGY), but strictly as a
   local MONITOR - they never go on the wire and never replace a frame. They only decide
   WHEN to re-condition the session against the live feed.

   ── THIS LOOP IS THE "SPATIAL BASE", AND IT IS NEVER LATCHED ──────────────────
   Worth stating plainly, because the stretched-garment report reads like a frozen body
   keyframe and is not one: what goes to Decart from here is the CURRENT camera frame,
   ten times a second, for the entire session. Nothing anywhere captures a body frame and
   re-sends it. The only latched asset in this pipeline is the GARMENT reference passed to
   rtClient.set({ image }) - which is exactly the half that is supposed to be invariant.
   So the body was always live; what was missing was any signal telling the model to
   re-read it once its conditioning had gone stale, which is what the topology monitor
   supplies. */
function createThrottledInputStream(srcStream, {
  fps = LIVE_INFERENCE_FPS, width = LIVE_W, height = LIVE_H,
  gated = INPUT_GATE_ENABLED, gateMaxMs = INPUT_GATE_MAX_MS,
} = {}) {
  const srcTrack = srcStream.getVideoTracks()[0];
  // No video track (camera failed) - hand the stream back untouched; nothing to throttle.
  if (!srcTrack) return { stream: srcStream, dispose: () => {} };

  // Best-effort native constraint first - some devices honour it and trim work
  // upstream. The canvas throttle below is the guarantee regardless of the result.
  try {
    srcTrack.applyConstraints({
      frameRate: { ideal: fps, max: fps },
      width:  { ideal: width },
      height: { ideal: height },
    }).catch(() => {});
  } catch (_) {}

  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.srcObject = new MediaStream([srcTrack]);

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  // captureStream(0) → no automatic capture; each frame is emitted only when we call
  // requestFrame(), so the output rate is EXACTLY our setInterval cadence.
  const out = canvas.captureStream(0);
  const outTrack = out.getVideoTracks()[0];
  if (outTrack && "contentHint" in outTrack) outTrack.contentHint = "motion";

  let disposed = false;
  let timer = null;
  const frameMs = 1000 / fps;
  /* ── THE ATOMIC CONDITIONING GATE ─────────────────────────────────────────────
     REPORTED: for the first second of a session Decart renders a generic grey
     long-sleeve sweater, and only then switches to the garment that was actually asked
     for. The reveal is already gated three ways (armFirstFrameBilling: the apply
     resolved, the frame is non-black, and it stayed that way for 3 frames / 300ms) - and
     that function's own comment names the hole those three cannot close: "isDressedFrame()
     cannot distinguish 'the real garment' from 'Decart's generic/default output'". A
     generic sweater is not black and does not flicker, so it satisfies every gate there is.

     THE ONLY WAY TO WIN IS NOT TO GIVE IT ANYTHING TO GENERATE FROM. The generic frame
     exists because raw camera frames start flowing the instant the WebRTC session opens,
     which is BEFORE rtClient.set() has delivered the reference - so Decart is asked to
     render a dressed person while the only thing it has is its own prior. Hold the frames
     until the conditioning is acknowledged and there is no such window: the first frame it
     ever receives is one it can already condition correctly, so the first frame it ever
     emits carries the real garment. Nothing to hide, nothing to fade over.

     THE TRACK STAYS LIVE THROUGHOUT - this withholds FRAMES, not the track. captureStream(0)
     emits only on requestFrame(), so simply not calling it produces a live video track with
     no frames on it, which is what the WebRTC handshake needs to complete normally.

     IT CANNOT STRAND A SESSION. The gate self-releases after gateMaxMs no matter what, so a
     path that forgets to call release() costs a late start rather than a dead session - and
     says so loudly, because reaching that timer is a bug in the caller, not a slow network. */
  let gateOpen = !gated;
  let gateTimer = null;
  if (gated) {
    gateTimer = setTimeout(() => {
      gateTimer = null;
      if (disposed || gateOpen) return;
      console.warn(`[PEAR] input gate: auto-released after ${gateMaxMs}ms without an explicit`,
        "release - the garment apply never reported success. Streaming raw frames now so the",
        "session is not stranded; the first rendered frames may not carry the garment.");
      gateOpen = true;
    }, gateMaxMs);
  }

  // Cover-fit + horizontal mirror: fill width×height (preserve aspect, center-crop)
  // and flip X so the canvas track already carries the selfie orientation.
  const drawFrame = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = (width - dw) / 2, dy = (height - dh) / 2;
    ctx.save();
    ctx.setTransform(-1, 0, 0, 1, width, 0);   // mirror horizontally
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
  };

  const tick = () => {
    if (disposed || !gateOpen) return;   // gated: a live track carrying no frames yet
    try {
      drawFrame();
      if (outTrack && typeof outTrack.requestFrame === "function") outTrack.requestFrame();
    } catch (_) {}
  };

  const start = () => { if (!disposed && !timer) timer = setInterval(tick, frameMs); };
  video.play().then(start).catch(start);

  return {
    stream: out,
    /* THE FRAMES ACTUALLY BEING SENT TO DECART. Exposed for guardSource(): #webcam is
       visibility:hidden for all of .show-live while applyConstraints() re-negotiates the
       shared device track underneath it, which is the black-band defect. This canvas
       cannot be blank while there is a session to guard, and it is already cover-fitted
       and mirrored into the geometry Decart returns - so the guard needs no flip for it. */
    canvas,
    get gateOpen() { return gateOpen; },
    /* Idempotent, and called from applyActive() the moment a garment is genuinely on the
       wire - which is every path that can dress a session (go-live, the cold-start
       recovery's fallback, an SDK-reconnect re-apply), so no single call site has to
       remember. Returns whether THIS call was the one that opened it, for the log line. */
    release: (why = "garment acknowledged") => {
      if (gateOpen) return false;
      gateOpen = true;
      if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
      console.log(`[PEAR] input gate released (${why}) - streaming to Decart now;`,
        "its first frame is conditioned on the real reference");
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
      try { outTrack && outTrack.stop(); } catch (_) {}
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
      // We OWN srcStream (always a clone passed by connectRealtime), so stop it here.
      // The real preview camera (localStream) is a different stream and stays alive.
      try { srcStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    },
  };
}

/**
 * Open the input gate for the CURRENT session - see createThrottledInputStream's own
 * "atomic conditioning gate" comment for what is being withheld and why.
 *
 * ONE CALL SITE OWNS THE MEANING: applyActive(), immediately after isGarmentApplied
 * becomes true. That is the exact definition of "a garment is on the wire", and it covers
 * every path that can reach it - go-live's first apply, the cold-start recovery's
 * lightweight fallback, an SDK-reconnect re-apply - without any of them having to know
 * this gate exists. Idempotent, so the ~8 re-anchors per session that follow are no-ops.
 * @param {string} why  short reason, for the one log line the release prints
 * @returns {void}
 */
function releaseInputGate(why) {
  if (inputThrottle && typeof inputThrottle.release === "function") inputThrottle.release(why);
}

/**
 * Mint an ephemeral ek_ token and open ONE Decart Lucy VTON realtime session
 * over WebRTC. Any stale/dropped client is disconnected first so no orphaned
 * server-side session keeps billing. SECURITY: the permanent dct_ key never
 * reaches the browser - only the short-lived ek_ token from the proxy does.
 * @returns {Promise<void>}
 */
/* The realtime.connect() options object, factored out of connectRealtime() so a
   retried connect attempt (see the signaling-race retry below) can rebuild it
   identically for each attempt without duplicating the callback bodies. `gen` is the
   session generation captured by connectRealtime() at the top of that call - every
   callback below closes over it and bails the instant a teardown/new-connect has
   moved sessionGen on, exactly as before this was extracted. */
function buildRealtimeConnectOpts(gen) {
  return {
    model: {
      name: "lucy-vton-latest",
      urlPath: "/v1/stream",
      // NOTE: these are advisory only - the SDK ignores model.fps/width/height on
      // Chromium. The REAL cap is enforced upstream by createThrottledInputStream()
      // (canvas pinned to LIVE_INFERENCE_FPS / LIVE_W×LIVE_H). Kept in sync so any
      // SDK build that DOES honour them agrees with the throttle.
      fps: { ideal: LIVE_INFERENCE_FPS, max: LIVE_INFERENCE_FPS },
      width: LIVE_W,
      height: LIVE_H,
    },
    mirror: "auto",
    onRemoteStream: (editedStream) => {
      if (gen !== sessionGen) return;    // stale callback from a torn-down session
      // DEBUG WRAPPER: flag a stream rendering with no garment on the wire. typeof-guarded,
      // not a bare call - this callback is extracted/sandboxed by some tests without the
      // debug-wrapper globals in scope, and a bare undeclared reference would throw there.
      if (typeof warnIfStreamStartedUndressed === "function") warnIfStreamStartedUndressed();
      // Official pattern: map the live edited WebRTC stream straight to the
      // video element so the garment warps/tracks the user in realtime.
      const aiVideo = document.querySelector("#aiVideo");
      aiVideo.srcObject = editedStream;
      /* display:block keeps it laid out, decoding and firing rVFC - which
         armFirstFrameBilling() below depends on to detect Model Ready at all. What it does
         NOT do any more is make it VISIBLE: gateAiFeed() holds it at opacity 0 until the
         reveal, because an inline display:block was overriding the stylesheet rule that
         was supposed to keep this hidden until .show-live, leaving only a 34%-opaque
         scrim between the shopper and whatever Decart rendered first. See gateAiFeed(). */
      aiVideo.style.display = "block";
      gateAiFeed(aiVideo);
      aiVideo.style.transform = "none";  // edited feed is already correctly oriented
      // Force the video onto its own GPU compositing layer so the browser doesn't
      // re-rasterize it in software on every frame repaint. translateZ(0) is the
      // universal trigger; will-change is the spec-correct version.
      aiVideo.style.willChange = "transform";
      aiVideo.style.transform = "translateZ(0)";
      aiVideo.play().catch(() => {});
      // BILLING START: the 5s / 10-credit window begins at the FIRST DRESSED frame
      // Decart actually renders to #aiVideo here - NOT at connect and NOT merely at
      // set() being called, but once it has resolved AND a frame reflecting it has
      // decoded - so the handshake + server warm-up + styling round-trip is never
      // billed. Idempotent + sessionGen-guarded inside startBillingWindow, so a
      // stale/duplicate stream can't re-arm it. Recording (Feature 2) is armed from
      // the same call, inside startBillingWindow, so both cover the identical span.
      armFirstFrameBilling(aiVideo, gen);
      /* Armed HERE, not at the reveal: armFirstFrameBilling() is a one-shot gate that
         stops watching the moment it fires, so a stall during warm-up - before any frame
         has qualified - would otherwise be covered by nothing but firstFrameGuardTimer's
         all-or-nothing teardown. typeof-guarded for the same reason the line above is:
         this callback is extracted and sandboxed by tests without these globals in scope. */
      if (typeof startFrameFreezeWatch === "function") startFrameFreezeWatch(aiVideo, gen);
    },
    onConnectionChange: (state) => {
      if (gen !== sessionGen) return;    // stale callback from a torn-down session
      const prevState = connState;
      connState = state;
      setConn(state);

      /* setState() (stream-session.js) already drops a same-state re-emission before
         this callback ever fires, so every call here IS a real transition - no extra
         "did this already fire" gating needed for a just-once toast. The badge (setConn
         above) is the persistent indicator; this is the attention-catching one, matching
         the existing pattern for other state changes (e.g. the orientation flip toast). */
      if (state === "reconnecting") toast("מתחבר מחדש…");
      else if ((state === "connected" || state === "generating") && prevState === "reconnecting") {
        toast("✓ החיבור חזר");
      }

      /* ── THE STATE-REVERSION BUG ───────────────────────────────────────────
         @decartai/sdk@0.1.5's StreamSession ALREADY retries a dropped mid-session
         connection internally (media/signaling loss → handleConnectionLoss() →
         scheduleReconnect(), p-retry, 5 attempts, 1s/2s/4s/8s/10s backoff) - this file
         does not need to reimplement that, and did not need a queue for outgoing
         messages either. What it DOES need is this: scheduleReconnect()'s internal
         reconnect calls runOneConnect(), which resends getInitialState() - and that
         reads this.config.initialImage/initialPrompt, captured ONCE when
         client.realtime.connect() was first called and never updated by any later
         rtClient.set()/setPrompt() (verified in stream-session.js - neither method
         touches those fields). So an SDK-level reconnect silently puts the shopper back
         in whatever garment/pose was live at the ORIGINAL go-live moment, discarding
         every colour swap, orientation flip, or profile-pose update sent since - with
         no error, no log, nothing to say it happened. That is a correctness bug a
         message queue could not have fixed either: replaying literal past messages
         would restore whichever one happened to be queued, not necessarily what is
         actually true NOW if the shopper kept interacting during the outage.
         The fix already exists in this file's architecture: applyActive() re-derives
         the CURRENT desired state from live values (activeItem, effectiveAngle(),
         profileActive(), resolveLook()) rather than replaying anything captured
         earlier - which is exactly the property angleAtStart/profileAtStart rely on
         elsewhere. So the correct response to "the SDK just reconnected" is simply to
         call it again. isGarmentApplied gates this to sessions that had actually
         dressed the shopper (never fires on the FIRST connect, where prevState can
         only be "connecting" - the SDK never reports "reconnecting" before an initial
         "connected"). */
      if ((state === "connected" || state === "generating") &&
          prevState === "reconnecting" && isGarmentApplied) {
        console.log("[PEAR] connectRealtime() - SDK reconnected; re-applying the CURRENT garment/pose",
          "(the SDK's own recovery only restores the ORIGINAL go-live state)");
        /* ── THE WIRE STATE DID NOT SURVIVE THE RECONNECT, so neither may our belief
           about it ────────────────────────────────────────────────────────────────
           lastSentImageRef/rtImageOnWire/lastSentPrompt describe what THIS PEER
           CONNECTION holds. connectRealtime() clears them for a brand-new session, but an
           SDK-internal reconnect never re-enters connectRealtime() - runOneConnect()
           rebuilds the transport underneath us and this file's bookkeeping sails straight
           through it, still claiming the composite Blob is on the wire.

           Before strict image-only that produced a prompt-only setPrompt() on the
           re-apply: wrong, but the garment survived because the SDK's own
           getInitialState() replay had put SOMETHING there. With one frozen prompt the
           re-apply matches on BOTH halves and applyGarment() skips the dispatch entirely,
           so the recovered connection would be left holding whatever the SDK replayed -
           the ORIGINAL go-live state, which is precisely what this block exists to
           correct. Clearing here is what makes the re-apply a real set({ image }) and
           puts the CURRENT garment blob back on the new transport. */
        invalidateWireState("SDK reconnect - the transport was rebuilt underneath us");
        applyActive().catch((e) =>
          console.warn("[PEAR] post-reconnect re-apply failed:", e?.message || e));
      }

      /* ── PERMANENT FAILURE CLEANUP ──────────────────────────────────────────
         "disconnected" is also the SDK's terminal state after scheduleReconnect()
         exhausts all 5 internal attempts (stream-session.js: tearDown() + setState
         ("disconnected") + events.emit("error", ...) in the same catch block) - so this
         file's EXISTING rtClient.on("error", ...) listener below already shows the
         shopper a message for that exact case. What it did not do is retire the
         session: billing timers, the recorder and the orientation watcher were left
         running against a connection the SDK itself has already given up on. Scoped to
         a transition FROM "reconnecting" specifically (not the ordinary "connected" →
         "disconnected" step every teardown() also produces, which must NOT re-enter
         stopLive() while teardown() is still unwinding) - a permanent failure is always
         preceded by at least one "reconnecting" tick, per handleConnectionLoss()'s own
         gate on state. stopLive() (not bare teardown()) so the "Go Live" control resets
         and any final frame is handled the same way a manual Stop would. */
      if (state === "disconnected" && prevState === "reconnecting") {
        console.warn("[PEAR] connectRealtime() - SDK reconnect exhausted; retiring the session");
        stopLive();
      }
    },
  };
}

async function connectRealtime({ force = false } = {}) {
  /* `force` EXISTS FOR THE COLD-START RECOVERY, and without it that recovery was a no-op.
     The hang it recovers from is a set() that never gets a response on a session the SDK
     still reports as connected - so isLive() is TRUE, and this early return fired before
     anything was reset. The whole point of that path is to throw away a session that
     looks healthy and is not, so it says so explicitly. Every other caller keeps the
     original behaviour: never open a second session on top of a working one. */
  if (!force && rtClient && isLive()) return;
  if (connecting) return;

  // Bug 3 fix: explicitly close any stale/dropped session before opening a new one
  // so the old server-side WebRTC session is terminated and stops billing immediately.
  if (rtClient) {
    try { rtClient.disconnect(); } catch (_) {}
    rtClient = null;
  }
  // Free the previous session's throttle (paint loop + canvas + cloned source) and
  // its input stream (if any) so they don't leak into the new session.
  if (inputThrottle) {
    try { inputThrottle.dispose(); } catch (_) {}
    inputThrottle = null;
  }
  if (realtimeInput) {
    try { realtimeInput.getTracks().forEach((t) => t.stop()); } catch (_) {}
    realtimeInput = null;
  }

  // Bug 3 fix: claim a fresh generation. Callbacks below capture `gen` and bail
  // out the moment a teardown/new-connect bumps sessionGen - so a late callback
  // from a previous client can never stomp this session's state. We also reset
  // connState to "connecting" here so waitConnected() can't observe a stale
  // terminal value ("disconnected") left behind by the prior session.
  const gen = ++sessionGen;
  connState = "connecting";
  connecting = true;
  setConn("connecting");

  // Fresh session → reset the once-per-session billing guard and cancel any stale
  // no-first-frame safety timer, so the billed window re-arms cleanly on THIS session's
  // first rendered frame (see startBillingWindow / armFirstFrameBilling).
  billingStarted = false;
  billingStartedAt = 0;            // diagnostics clock - re-stamped on this session's own first frame
  dressedFrameReady = false;
  isGarmentApplied = false;
  /* A fresh session holds NO reference image, whatever the last one held. Without this
     the first applyGarment() of the new session could match lastSentImageRef (the
     composite Blob is memoized across sessions) and take the prompt-only path - leaving
     Decart generating against no garment reference at all. */
  lastSentImageRef = null;
  rtImageOnWire = false;
  lastSentPrompt = null;
  /* ...and the QUEUE with them. A write left pending against the client we just
     disconnected would otherwise make this session's very first apply see wireBusy() and
     wait behind a promise that can no longer settle - the go-live hang, reintroduced by
     the very mutex that exists to prevent it. */
  resetConditionWire();
  debugStreamCheckedThisGen = false;   // DEBUG WRAPPER: re-arm the undressed-stream check for this session
  if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }

  // DEBUG WRAPPER: stamp the flag's state at the top of the session transcript, so a
  // captured log is unambiguous about whether this run had it on.
  if (typeof window !== "undefined" && window.__pearDebugForceFullReupload) {
    console.warn("[PEAR][DEBUG] this session is starting with __pearDebugForceFullReupload = true");
  }
  console.log("[PEAR] connectRealtime() - stage 1/4: loading SDK from CDN…");
  try {
    /* ── load SDK ─────────────────────────────────────────────────────────── */
    const { createDecartClient } = await loadSDK();

    /* ── mint token → create client → build the throttled input, WITH ONE RETRY ──
       THE FAILURE THIS COVERS: "WebSocket is not open" thrown from the SDK's
       signaling channel (openAndJoin → writeMessage({type:"livekit_join"})). Reading
       the SDK source (realtime/signaling-channel.js): openSocket() resolves once
       ws.onopen fires, then openAndJoin() immediately tries to send the join frame -
       if the socket has ALREADY closed again by that point (readyState !== OPEN),
       writeMessage() returns false and this exact message is thrown, with no error
       code to distinguish it by. That is a signaling-layer race - the ek_ token
       itself was accepted (the socket opened), but the join handshake lost a very
       narrow window, which upstream network jitter or a momentarily overloaded
       signaling server can both produce. It surfaced to the shopper as "המדידה
       החיה נכשלה" with zero retry, on a call this file otherwise treats as
       reliable once the token is in hand.
       ONE retry, matched narrowly on this message text so a real auth/permission
       failure (bad key, camera denied, model not permitted) still fails fast rather
       than silently eating 2x the latency. The cached ek_ token is invalidated
       before retrying: it already failed one join, and mintEphemeralToken()'s cache
       has no way to know that on its own. */
    let attempt = 0;
    for (;;) {
      attempt++;
      console.log(`[PEAR] connectRealtime() - stage 2/4: SDK loaded. Minting ephemeral token… (attempt ${attempt})`);

      /* ── mint a short-lived ek_ token from the secure proxy (only now, never on
            page load) - the permanent dct_ key stays server-side ─────────────── */
      const ekToken = await mintEphemeralToken();

      // A teardown may have fired while we were awaiting the SDK/token - abort.
      if (gen !== sessionGen) return;
      console.log("[PEAR] connectRealtime() - stage 3/4: token OK. Creating Decart client…");

      /* ── create client with the ephemeral token ───────────────────────────── */
      const client = createDecartClient({ apiKey: ekToken });
      console.log("[PEAR] connectRealtime() - stage 4/4: opening WebRTC session (waiting for 'connected')…");

      /* Bug 3 fix: work off a CLONE of the camera tracks so disconnect/teardown never
         stops localStream (our persistent preview). The clone is OWNED by the throttle,
         which stops it on dispose().
         BILLING FIX: route that clone through createThrottledInputStream() so the SDK
         receives a canvas capture pinned to LIVE_INFERENCE_FPS / LIVE_W×LIVE_H - the
         SDK's own fps/resolution caps are no-ops on Chromium (see the throttler note). */
      const camClone = new MediaStream(localStream.getVideoTracks().map((t) => t.clone()));
      inputThrottle = createThrottledInputStream(camClone, {
        fps: LIVE_INFERENCE_FPS, width: LIVE_W, height: LIVE_H,
      });
      realtimeInput = inputThrottle.stream;

      try {
        /* ── connect realtime ───────────────────────────────────────────────── */
        // FIX: model passed as a plain string, NOT via models.realtime()
        rtClient = await client.realtime.connect(realtimeInput, buildRealtimeConnectOpts(gen));
        break;      // success - fall through to the post-connect code below
      } catch (e) {
        // Dispose THIS attempt's throttle/clone before either retrying (a fresh one is
        // built above) or rethrowing (the outer catch's stopLive() would otherwise find
        // a dangling throttle from an attempt that never became the live session).
        if (inputThrottle) { try { inputThrottle.dispose(); } catch (_) {} inputThrottle = null; }
        realtimeInput = null;

        const isSignalingRace = /WebSocket is not open/.test(e?.message || "");
        if (!isSignalingRace || attempt >= 2 || gen !== sessionGen) throw e;

        console.warn("[PEAR] connectRealtime() - signaling race on attempt", attempt,
          "(" + e.message + ") - invalidating cached token and retrying once…");
        _tokenCache = null;             // do not reuse a token that just failed its join
      }
    }

    // If a teardown landed during connect(), immediately close this orphan - and
    // dispose the throttle so its paint loop / cloned camera track don't outlive it.
    if (gen !== sessionGen) {
      try { rtClient.disconnect(); } catch (_) {}
      rtClient = null;
      if (inputThrottle) { try { inputThrottle.dispose(); } catch (_) {} inputThrottle = null; }
      realtimeInput = null;
      return;
    }

    rtClient.on("error", (err) => {
      console.error("[session] Decart error:", err?.message || String(err));
      showCamError("שגיאת Decart: " + (err?.message || err));
    });

    connState = (rtClient.getConnectionState && rtClient.getConnectionState()) || "connected";
    setConn(connState);
    console.log("[PEAR] connectRealtime() - WebRTC session open. connState:", connState);

  } catch (err) {
    console.error("[connectRealtime] failed at stage:", err?.message || String(err), err);
    throw err;   // re-throw so goLive()'s catch block can show the user-facing error
  } finally {
    connecting = false;
  }
}

/**
 * Single teardown that kills the server-side Decart session immediately so
 * billing stops at once (rather than running until token TTL expiry). Called by
 * stopLive (the manual billing kill-switch) and on beforeunload, pagehide, and visibilitychange.
 * @returns {void}
 */
function teardown() {
  // Cancel the 5s auto-teardown timer before bumping the generation - order matters:
  // clearing first means the timer callback (which checks sessionGen) can never fire
  // concurrently with this teardown, even on the same tick.
  if (liveDurationTimer) { clearTimeout(liveDurationTimer); liveDurationTimer = null; }
  // Cancel the frozen-hold finalize timer + clear its state so a Stop/tab-hide during
  // the hold (or at any time) fully retires the session instead of leaving the held
  // recorder running. stopRecording() below then flushes whatever clip exists so far.
  if (videoFinalizeTimer) { clearTimeout(videoFinalizeTimer); videoFinalizeTimer = null; }
  recordHold = false;
  recordHoldSrc = null;
  // Same leak guard for the visual countdown ticker + overlay.
  hideLiveCountdown();
  // ...and for the lower-body compositing guard's rAF loop, as the authoritative
  // backstop: stopLive()/beginFreezeHold() already call this at their own call sites,
  // but teardown() is what EVERY exit path eventually reaches, so a future path that
  // disconnects without going through either of those two still stops it here.
  stopLowerBodyGuard();
  stopPresenceWatcher();

  // Cancel the no-first-frame safety timer and reset the billing-armed guard so the next
  // session starts clean (the billed window re-arms only on its own first rendered frame).
  if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }
  billingStarted = false;
  billingStartedAt = 0;            // diagnostics clock - re-stamped on the next session's first frame
  dressedFrameReady = false;

  // Bug 3 fix: bump the generation FIRST so any in-flight callbacks from the
  // client we're about to disconnect become no-ops (see connectRealtime).
  sessionGen++;

  // Stop the diagnostic stats poller before the pc is torn down.
  stopStatsMonitor();

  // Retire the AI Auto orientation watcher with the session - it samples the camera and
  // issues live set() swaps, so it must never outlive isLive().
  if (orientWatcher) { try { orientWatcher.stop(); } catch (_) {} orientWatcher = null; }

  // Same rule, same reason, for the frame-freeze watchdog: it can fire applyActive(), so
  // a surviving instance would issue set() calls against a disconnected session. Its own
  // tick is sessionGen- and isLive()-guarded as well, so this is the second of two locks
  // rather than the only one - deliberately, since it is the timer most likely to be
  // running at the exact moment a session ends.
  stopFrameFreezeWatch();

  // Feature 2 - flush the recorder while the edited tracks are still live, so the
  // download clip is finalized before disconnect ends the stream.
  stopRecording();

  if (rtClient) {
    try { rtClient.disconnect(); } catch (_) {}
    rtClient = null;
  }
  // The session is gone, so nothing is on the wire. connectRealtime() resets these too;
  // clearing here as well keeps the invariant true at every point the session ends.
  lastSentImageRef = null;
  rtImageOnWire = false;
  lastSentPrompt = null;
  redrapeCoverEnd("session-torn-down");   // a cover must never outlive the session it covered
  resetConditionWire();          // nothing may be queued for a session that no longer exists

  // Bug 3 fix: stop this session's cloned camera tracks (the WebRTC sender side).
  // localStream - the real camera/preview - is intentionally left running.
  // The throttle owns the canvas track AND the cloned source track, so dispose it
  // first (stops the paint loop + both tracks), then null the input stream handle.
  if (inputThrottle) {
    try { inputThrottle.dispose(); } catch (_) {}
    inputThrottle = null;
  }
  if (realtimeInput) {
    try { realtimeInput.getTracks().forEach((t) => t.stop()); } catch (_) {}
    realtimeInput = null;
  }

  // Hide AND detach the now-dead edited stream so the CSS state classes govern the
  // view again (otherwise the inline display:block from onRemoteStream would freeze
  // it on top, and a stale srcObject would block the next session's first frame).
  const ai = $("aiVideo");
  if (ai) { ai.style.display = "none"; ai.srcObject = null; }
  resetAiFeedVisibility();   // never leave a dead session's opacity:0 on a reused element

  // Bug 3 fix: clear every guard so the next try-on starts from a pristine state.
  connState = "idle";
  connecting = false;
  setConn("idle");
}

/**
 * Full exit teardown - runs the normal teardown() above (Decart/WebRTC session)
 * AND additionally releases the raw camera (localStream), which teardown() leaves
 * running on purpose for in-page garment swaps (see the sessionGen comment above).
 * Only call this when the fitting room itself is being closed/discarded (the
 * PEAR_TEARDOWN handler below) - never from the in-page swap path, or every
 * garment change would re-prompt for camera permission.
 */
function fullTeardown() {
  teardown();
  if (localStream) {
    try { localStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    localStream = null;
  }
  const v = $("webcam");
  if (v) v.srcObject = null;
}

/* The host widget sends this right before it removes our iframe from its DOM
   (modal close / X button). A plain iframe removal doesn't reliably fire our own
   beforeunload/pagehide handlers, and even when it does, teardown() intentionally
   keeps the camera open for same-session reuse - neither is safe to rely on for a
   real exit, so the parent asks us explicitly. Acks back so the widget can remove
   the iframe immediately instead of always waiting out its fallback timeout. */
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  if (!e.data || e.data.type !== "PEAR_TEARDOWN") return;
  try { fullTeardown(); } catch (_) {}
  try { window.parent.postMessage({ type: "PEAR_TEARDOWN_ACK" }, "*"); } catch (_) {}
});

function waitConnected(timeout) {
  return new Promise((resolve, reject) => {
    if (isLive()) return resolve();
    const start = Date.now();
    (function poll() {
      if (isLive()) return resolve();
      if (connState === "error" || connState === "disconnected") return reject(new Error("session " + connState));
      if (Date.now() - start > timeout) return reject(new Error("timeout מחכה לחיבור (" + connState + ")"));
      setTimeout(poll, 50);
    })();
  });
}

/**
 * Fetch a garment image via /api/img-proxy so the Decart SDK receives a Blob
 * rather than a raw CDN URL.  The SDK's imageToBase64() calls fetch(url) on any
 * http/https string - which fails for CDNs (suitsupply, magnific, etc.) that don't
 * send CORS headers.  Routing through our same-origin proxy avoids that entirely.
 * Returns null on any error so the caller can fall back to the raw URL or prompt-only.
 */
async function fetchGarmentBlob(imgUrl) {
  console.log('[PEAR] fetchGarmentBlob url:', imgUrl);
  if (!imgUrl) { console.log('[PEAR] fetchGarmentBlob result:', 'NULL'); return null; }
  const proxyUrl = `/api/img-proxy?url=${encodeURIComponent(imgUrl)}`;
  console.log("[PEAR] fetchGarmentBlob() - GET", proxyUrl);
  try {
    const resp = await fetch(proxyUrl);
    console.log("[PEAR] fetchGarmentBlob() - response", resp.status, resp.ok ? "OK" : "FAILED", "for", imgUrl);
    if (!resp.ok) {
      console.warn("[PEAR] img-proxy returned", resp.status, "for", imgUrl);
      console.log('[PEAR] fetchGarmentBlob result:', 'NULL');
      return null;
    }
    const blob = await resp.blob();
    console.log('[PEAR] fetchGarmentBlob result:', blob ? 'success' : 'NULL');
    return blob;
  } catch (e) {
    console.warn("[PEAR] img-proxy fetch error:", e?.message || e);
    console.log('[PEAR] fetchGarmentBlob result:', 'NULL');
    return null;
  }
}

/* Fallback for a garment fetch that fails through /api/img-proxy (upstream error,
   proxy rate limit, transient network blip): retry once via the proxy, then fall
   back to fetching the raw CDN URL directly from the browser. Some CDNs allow an
   anonymous cross-origin GET even without img-proxy's SSRF/CORS handling, so this
   recovers cases the proxy alone gives up on - specifically the "back image never
   arrives" failure mode this backs (see prewarmOrientationAssets/maybeSwap). */
async function fetchWithFallback(url, attempts = 3) {
  if (!url) return null;
  for (let i = 1; i <= attempts; i++) {
    // Route 1 - our own /api/img-proxy (CORS-clean, SSRF-guarded, content-type checked).
    try {
      const blob = await fetchGarmentBlob(url);
      if (blob) return blob;
    } catch (e) {
      console.warn(`[PEAR] fetchWithFallback attempt ${i}/${attempts} - proxy threw:`, e?.message || e);
    }
    // Route 2 - the raw CDN URL. Only works for CDNs that send permissive CORS
    // headers, but when the proxy is the thing that's broken (rate limit, cold
    // lambda, upstream bot-filter) this is a genuinely independent path.
    try {
      const resp = await fetch(url, { mode: "cors", credentials: "omit" });
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob && blob.size > 0) return blob;
      }
    } catch (e) {
      console.warn(`[PEAR] fetchWithFallback attempt ${i}/${attempts} - direct CDN threw:`, e?.message || e);
    }
    // Linear backoff between rounds - a cold serverless proxy or a transient CDN
    // blip usually clears within a second; there is no point hammering it faster.
    if (i < attempts) await new Promise((r) => setTimeout(r, 400 * i));
  }
  console.error(`[PEAR] CRITICAL: image fetch failed after ${attempts} attempts (proxy + direct):`, url);
  return null;
}

/* Guarantee the bytes handed to Decart are a format its image pipeline definitely
   accepts. /api/img-proxy already asks CDNs for JPEG/PNG, but two paths can still
   yield something else: the raw-CDN fallback inside fetchWithFallback() uses the
   BROWSER's own Accept (which advertises webp/avif), and a store whose master asset
   is natively webp/avif has nothing to transcode from. In AI Auto mode the Blob goes
   to rtClient.set({ image }) verbatim, so an exotic format there is a silent
   "back view didn't render". JPEG and PNG pass through untouched - PNG deliberately
   so, because flattening a transparent cut-out garment to JPEG would paint its
   background solid black. Anything else is re-encoded to JPEG. */
async function normalizeToSupportedImage(blob) {
  if (!blob || /^image\/(jpeg|png)$/i.test(blob.type || "")) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const off = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
    const ctx = off.getContext("2d", { alpha: false });
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const out = off.convertToBlob
      ? await off.convertToBlob({ type: "image/jpeg", quality: 0.95 })
      : await new Promise((res) => off.toBlob(res, "image/jpeg", 0.95));
    if (out && out.size) {
      console.log(`[PEAR] normalized ${blob.type || "unknown"} → image/jpeg (${out.size.toLocaleString()} bytes)`);
      return out;
    }
  } catch (e) {
    console.warn("[PEAR] image normalization failed, passing original through:", e?.message || e);
  }
  return blob;   // better to send the original than nothing
}

/* Cheap "is this basically a solid color?" check - catches a broken-image/gray
   placeholder graphic that fetches and decodes perfectly fine (so every check above
   this one passes) but has no real garment texture in it: a bad classification, or a
   CDN that soft-404s a missing photo with a plain filler image instead of a real HTTP
   error. Downscales to a tiny 32×32 canvas and measures luma standard deviation across
   it - a real product photo has meaningfully varied texture/shading even in a tight
   crop; a flat placeholder fill does not. Used to keep a bad back-view asset from
   silently reaching the live session and reading to the shopper as "blank back view".
   Fails OPEN (false) on any probe error - never block a genuinely good image because
   the cheap check itself hiccuped. */
const FLAT_IMAGE_STDDEV_MIN = 4;   // luma std-dev below this reads as a flat/solid fill
async function bitmapLooksFlat(bitmap) {
  try {
    const cw = 32, ch = 32;
    const off = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement("canvas"), { width: cw, height: ch });
    const ctx = off.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const total = cw * ch;
    const lumas = new Float32Array(total);
    let sum = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      lumas[p] = luma; sum += luma;
    }
    const mean = sum / total;
    let variance = 0;
    for (let p = 0; p < total; p++) { const d = lumas[p] - mean; variance += d * d; }
    return Math.sqrt(variance / total) < FLAT_IMAGE_STDDEV_MIN;
  } catch (e) {
    console.warn("[PEAR] bitmapLooksFlat() probe failed, assuming the image is fine:", e?.message || e);
    return false;
  }
}

/* ── Context-Aware Asset Switching - pre-cached per-orientation Blobs ─────────
   The instant-swap guarantee: rtClient.set({ image }) accepts a Blob directly, and a Blob
   ships the bytes over the already-open session - Decart never has to fetch a URL server-
   side (the 20-25s worst case that motivated /api/img-proxy). Pre-fetching BOTH orientation
   assets the moment AI Auto is armed means an orientation flip costs exactly one in-flight
   set() - no fetch, no reconnect, no flicker; the model transitions over a few frames.
   Memoized per URL, and a failed fetch is never cached, so a later retry isn't stuck
   serving the same failure forever. */
/* ═══════════════════════════════════════════════════════════════════════════
   Bounded LRU for the three Blob caches
   ───────────────────────────────────────────────────────────────────────────
   _assetBlobCache, _lookStitchCache and _compositeCache all previously grew
   without limit: the only `.delete()` calls on any of them sat on the FAILURE
   paths ("never cache a failure - allow a retry"), so every SUCCESSFUL Blob was
   pinned for the lifetime of the page. Their keys are combinatorial - per URL,
   per colour variant, per front/back pair, and per top×bottom look - and the
   composites are 2048px JPEGs at quality 0.95 (several hundred KB each), so a
   few minutes of browsing retained tens of MB that could never be reclaimed.

   Map preserves insertion order, so `delete` + `set` moves a key to the
   most-recently-used end. lruTouch() does that on every hit; lruSet() does it
   on write and then evicts from the least-recently-used front until the cache
   is back within MAX.

   ⚠️ WHY THERE IS NO revokeObjectURL() HERE - these caches store
   Promise<Blob|null>, NOT object-URL strings. There is nothing to revoke: a
   Blob is reclaimed by GC once the last reference drops, which is exactly what
   evicting the Map entry does. The object URLs that ARE derived from these
   blobs are minted and owned elsewhere, on the item itself
   (item._compositeObjectUrl - see createObjectURL in ensureActiveGarmentComposite),
   and they already have a correct lifecycle of their own: releaseCompositePreview()
   revokes them on every garment swap. Revoking those from here would be actively
   WRONG - that URL is what the visible "Now fitting" chip is displaying (see
   garmentThumb/displaySrcOf), so tearing it down on an unrelated cache eviction
   would blank a thumbnail the user is still looking at. Dropping the Map entry
   frees the bytes; the URLs stay under their existing owner's control.

   Eviction is functionally invisible: an evicted key is simply rebuilt on next
   use (a cache miss, never an error), and a job evicted while still in flight
   still resolves normally for whoever is already awaiting it.
   ═══════════════════════════════════════════════════════════════════════════ */
const BLOB_CACHE_MAX = 10;   // entries per cache

/** Mark `key` as most-recently-used and return its value. Caller checks .has() first. */
function lruTouch(map, key) {
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

/** Insert as most-recently-used, then evict the oldest entries beyond `max`. */
function lruSet(map, key, value, max = BLOB_CACHE_MAX) {
  map.delete(key);                 // a re-set must count as fresh, not stay in place
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    const evicted = map.get(oldest);
    map.delete(oldest);            // last reference dropped → Blob becomes GC-eligible
    // Defensive only: these caches never hold URL strings (see the note above),
    // but if one ever does, release it rather than leaking it.
    if (typeof evicted === "string" && /^blob:/i.test(evicted)) {
      try { URL.revokeObjectURL(evicted); } catch (_) {}
    }
  }
  return value;
}

const _assetBlobCache = new Map();   // url → Promise<Blob|null>  (LRU-capped, see above)

function garmentBlobCached(url) {
  console.log('[PEAR] garmentBlobCached url:', url);
  if (!url) { console.log('[PEAR] garmentBlobCached result:', 'miss'); return Promise.resolve(null); }
  if (_assetBlobCache.has(url)) {
    console.log('[PEAR] garmentBlobCached result:', 'hit');
    return lruTouch(_assetBlobCache, url);
  }
  console.log('[PEAR] garmentBlobCached result:', 'miss');
  const job = (async () => {
    try {
      // data:/blob: URLs (custom uploads) decode locally; http(s) rides the same-origin
      // proxy with a raw-CDN fallback and retries. This is the path AI Auto uses for
      // EVERY orientation swap, so a single transient proxy failure here is exactly
      // what a blank back view looks like to the user - it must not be a one-shot fetch.
      const raw = /^(data:|blob:)/i.test(url)
        ? await (await fetch(url)).blob()
        : await fetchWithFallback(url);
      if (!raw) { _assetBlobCache.delete(url); return null; }   // never cache a failure - allow a retry
      // These bytes go straight to rtClient.set({ image }) in AI Auto mode.
      return await normalizeToSupportedImage(raw);
    } catch (e) {
      console.warn("[PEAR] asset pre-cache failed:", e?.message || e);
      _assetBlobCache.delete(url);
      return null;
    }
  })();
  /* The settled value, parked ON the promise. garmentBlobIfWarm() below needs to answer
     "are these bytes ALREADY here?" without awaiting - awaiting a still-pending fetch is
     precisely the stall it exists to avoid - and hanging the result off the cached job
     keeps that answer in lockstep with the LRU for free: evicting the promise evicts the
     value with it, so there is no second map to keep honest. */
  job.then((blob) => { job.settled = blob || null; }, () => {});
  lruSet(_assetBlobCache, url, job);
  return job;
}

/**
 * The warm bytes for this URL, or null - NEVER a fetch, never a wait.
 *
 * This is the whole prefetch payoff, and the "never" is the point. referenceImageFor()
 * calls it on the go-live critical path: a hit means Decart is handed the actual image
 * bytes and has nothing to fetch before it can condition, and a miss falls straight
 * through to the proxied URL exactly as before. Awaiting on a miss would trade the
 * server-side fetch for a client-side one at the worst possible moment.
 * @param {string} url
 * @returns {Blob|null}
 */
function garmentBlobIfWarm(url) {
  if (!url) return null;
  const job = _assetBlobCache.get(url);
  return (job && job.settled) || null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE WIRE ENCODING, PRE-PAID - the half of the swap cost the prefetch left behind
   ──────────────────────────────────────────────────────────────────────────────
   REPORTED: garment swaps lag the click even when the bytes are already resident -
   which is precisely the case the prefetch above was built to create, so "fetch it
   earlier" had already been spent. The remaining cost is not in this file at all;
   it is in what the SDK does with what we hand it.

   MEASURED AGAINST THE SDK (@decartai/sdk@0.1.5, utils/media.js imageToBase64 -
   read, not assumed; the note at rtClient.set()'s flicker-fix comment already
   records that set() re-encodes on every call):

     a Blob      -> blobToBase64(): a FileReader.readAsDataURL round trip over the
                    WHOLE image, resolved through an event-loop callback.
     a data: URL -> image.split(",", 2)[1]. One synchronous string split. No decode,
                    no FileReader, nothing that can be queued behind anything else.

   So every swap pays a full base64 encode ON THE CLICK TICK. The raw cost is only
   single-digit milliseconds, but FileReader resolves through the event loop and the
   moment it runs is the moment the main thread is busiest - the WebRTC handshake,
   the camera, the reveal-gate frame callbacks. What it actually costs is the encode
   PLUS however long that queue is, which is the part the shopper sees.

   THE FIX IS ENTIRELY A MATTER OF WHEN. Same encode, moved into the prewarm that
   already fires the instant a garment is selected, while the shopper is still
   looking at the catalog and the main thread is idle. By the time they press the
   button the string is resident and the dispatch is a memcpy.

   ── WHY A WeakMap KEYED ON THE BLOB, AND NOT A SECOND URL CACHE ─────────────────
   The obvious shape - another url -> string Map beside _assetBlobCache - gets two
   things wrong that this one gets right for free:

     LIFETIME. A base64 string is ~1.37x the bytes it encodes, and it has to be held
     ALONGSIDE the Blob (which the composite builder, the flatness probe and the
     preload gate all still consume). A second Map means a second eviction clock and
     a second memory ceiling to keep honest, and the LRU note above is already
     emphatic about what unbounded Blob caching cost here. Keyed on the Blob, the
     string becomes unreachable exactly when the Blob does - one clock, and the cap
     that already exists governs both.

     COVERAGE. A url key only fits references that HAVE a url. The stitched composite
     is memoized under a `${front} ${back}` pair key inside createGarmentComposite(),
     so a url cache would either miss it - and it is the LARGEST reference this app
     sends, and in combined mode the only one - or have to duplicate that key format
     at a second site. Blob identity works for every reference this file produces,
     whatever built it.

   WARM ONLY, NEVER ON DEMAND - the same discipline garmentBlobIfWarm() states, for
   the same reason. A miss returns the Blob, so the worst case is byte-for-byte
   today's behaviour: set() runs the FileReader itself, exactly as it does now.
   Encoding here on a miss would move the cost back onto the critical path, which is
   the whole thing this exists to remove. */
const _wireEncodedBlobs = new WeakMap();   // Blob → its data: URL, pre-paid during prewarm

/** Blob → data: URL, or null. Never throws - a failure just leaves the Blob in play. */
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader();
      fr.onloadend = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror   = () => resolve(null);
      fr.readAsDataURL(blob);
    } catch (_) { resolve(null); }
  });
}

/* Fire-and-forget: pre-pay the base64 for a Blob that is already built, so the dispatch
   does not. Called from prewarmOrientationAssets() only - nothing awaits it, and any
   failure leaves the Blob path exactly as it was. */
async function prewarmWireEncoding(blob, label) {
  if (!blob || _wireEncodedBlobs.has(blob)) return;
  try {
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl) return;
    _wireEncodedBlobs.set(blob, dataUrl);
    console.log(`[PEAR] wire encoding pre-paid for ${label}`,
      `(${(dataUrl.length / 1024).toFixed(0)}KB base64) - set() will skip the FileReader`);
  } catch (e) {
    console.warn("[PEAR] wire pre-encode failed (harmless - the Blob path still works):", e?.message || e);
  }
}

/**
 * The cheapest wire form of a Blob already in hand: its pre-encoded data: URL when the
 * prewarm got to it, else the Blob itself. Never encodes, never fetches, never waits.
 * @param {Blob|null} blob @returns {string|Blob|null}
 */
function wireRefFor(blob) {
  if (!blob) return null;
  return _wireEncodedBlobs.get(blob) || blob;
}

/**
 * The best reference already resident for this URL: a pre-encoded data: URL, else the
 * warm Blob, else null. NEVER fetches, never encodes, never waits.
 * @param {string} url @returns {string|Blob|null}
 */
function garmentWireRefIfWarm(url) {
  return wireRefFor(garmentBlobIfWarm(url));
}

/* Warm the cache with the front AND back assets of the active subject (both halves of a
   full look) - fire-and-forget from setAngle/goLive so the fetches overlap the user's
   next action (or the WebRTC handshake) instead of serialising into the first swap. */
function prewarmOrientationAssets() {
  const look = resolveLook();
  for (const it of (look ? [look.top, look.bottom] : [activeItem])) {
    if (!it) continue;
    const g = galleryOf(it);
    const frontUrl = g.front || it.img;
    const backUrl = distinctBackOf(it, g);
    console.log('[PEAR] prewarm started for:', abbrevImg(frontUrl), '| back:', abbrevImg(backUrl));
    garmentBlobCached(frontUrl).then((frontBlob) => {
      console.log('[PEAR] prewarm front blob:', frontBlob ? `ok (${frontBlob.size.toLocaleString()} bytes)` : 'FAILED');
      /* ...and pre-pay the base64 the SDK would otherwise charge to the click tick.
         Chained off the fetch rather than fired beside it, so it encodes the Blob that
         actually landed and is a no-op when the fetch failed - see prewarmWireEncoding(). */
      prewarmWireEncoding(frontBlob, `front ${abbrevImg(frontUrl)}`);
    });
    // garmentBlobCached() now retries through the proxy AND the raw CDN internally
    // (fetchWithFallback), so no extra fallback layer is needed here - a null result
    // means all 3 rounds on both routes failed, which is a real, reportable failure.
    if (backUrl) {
      garmentBlobCached(backUrl).then((backBlob) => {
        prewarmWireEncoding(backBlob, `back ${abbrevImg(backUrl)}`);   // a flip dispatches like a swap
        if (backBlob) {
          console.log(`[PEAR] prewarm back blob: ok (${backBlob.size.toLocaleString()} bytes) - turning around will render the real rear photo`);
        } else {
          console.error("[PEAR] CRITICAL: back blob prewarm failed after all retries -", backUrl);
        }
      });
    } else {
      /* console.log, not warn: since this prewarm runs for EVERY item rather than only
         for dual-view ones, "no distinct back" is the ordinary case for most of the
         catalog and a warning here would train readers to ignore the channel. */
      console.log('[PEAR] prewarm back blob: skipped - this garment has no distinct back image');
    }
    /* Composite mode: warm the STITCHED reference too. It is what actually reaches
       rtClient.set(), and building it needs both bitmaps decoded - doing that lazily
       on the first frame would stall exactly the moment the session goes live. */
    if (backUrl && COMPOSITE_MODE && !look) {
      createGarmentComposite(frontUrl, backUrl).then((c) => {
        console.log('[PEAR] prewarm composite:', c ? `ok (${(c.size / 1024).toFixed(0)}KB)` : 'FAILED - will fall back to single-asset');
        /* The composite is the LARGEST reference this app sends (2048px, q0.95) and in
           combined mode it is the only one, so it is the single biggest FileReader the
           dispatch would otherwise pay for. */
        prewarmWireEncoding(c, "composite");
      });
    }
  }
}

/**
 * Mandatory Pre-load & Validation Gate - AWAITED, unlike prewarmOrientationAssets()
 * above (which is deliberately fire-and-forget for opportunistic early warming while
 * the shopper is still browsing). This is the hard gate goLive() blocks on: fetch,
 * decode, AND content-validate every garment asset (both halves of a full look, when
 * one is active) BEFORE the billed Decart/WebRTC session opens. The point is to catch
 * a broken/missing BACK asset here - narrowing this run to front-only - instead of
 * discovering it mid-session on the shopper's first turn, which is what "blank back
 * view" looked like from the outside. Updates #scanSub with live progress per item/side.
 * @returns {Promise<{ ok: boolean, hasBack: boolean }>}
 *   ok=false      → at least one item's FRONT is unusable - goLive() must abort entirely
 *                    (there is no reasonable fallback for a missing front).
 *   hasBack=false → at least one item's BACK is missing/broken - goLive() should proceed
 *                    FRONT-ONLY rather than arm AI Auto with a known-bad asset.
 */
async function preloadGarmentAssets() {
  const look = resolveLook();
  const items = (look ? [look.top, look.bottom] : [activeItem]).filter(Boolean);
  const el = $("scanSub");
  const setText = (msg) => { if (el) el.textContent = msg; };

  let ok = true, hasBack = true;
  for (const item of items) {
    const g = galleryOf(item);
    const front = g.front || item.img;
    const back  = distinctBackOf(item, g);
    const label = item.name || item.garmentType || "garment";

    setText(`בודק תמונות בגד… · Scanning Garment Assets… ${label} Front […]`);
    const frontBlob = front ? await garmentBlobCached(front) : null;
    setText(`בודק תמונות בגד… · Scanning Garment Assets… ${label} Front [${frontBlob ? "OK" : "FAIL"}]`);
    if (!frontBlob) {
      console.error("[PEAR] CRITICAL: GARMENT_FRONT failed pre-load validation -", label, front);
      ok = false;
      continue;   // keep checking the rest so every failure gets logged, not just the first
    }

    if (!back) { hasBack = false; continue; }

    setText(`בודק תמונות בגד… · Scanning Garment Assets… ${label} Back […]`);
    const backBlob = await garmentBlobCached(back);
    let backOk = !!backBlob;
    if (backOk) {
      try {
        const probe = await createImageBitmap(backBlob);
        if (await bitmapLooksFlat(probe)) { backOk = false; _assetBlobCache.delete(back); }
        probe.close?.();
      } catch (_) { /* fail open on probe error - the fetch itself already succeeded */ }
    }
    setText(`בודק תמונות בגד… · Scanning Garment Assets… ${label} Back [${backOk ? "OK" : "FAIL"}]`);
    if (!backOk) {
      console.warn("[PEAR] GARMENT_BACK failed pre-load validation - proceeding FRONT-ONLY -", label, back);
      hasBack = false;
      continue;   // no point validating a composite built from a back we already rejected
    }

    /* THE GAP THIS CLOSES. This gate's entire job is "block go-live until every
       asset THIS RUN NEEDS is ready" - but until now it validated the plain
       front/back Blobs from the OLDER per-orientation AI Auto path and stopped
       there, with zero awareness that COMPOSITE_MODE (the default) actually feeds
       Lucy a DIFFERENT reference: the stitched FRONT|BACK image. Front and back
       individually validating fine says nothing about whether the composite built
       FROM them exists yet or decoded cleanly.
       prewarmOrientationAssets() already kicks off this exact build in the
       background the moment AI Auto becomes eligible (fire-and-forget, for the
       common case where it finishes well before go-live is even clicked) - but
       fire-and-forget has no floor. A shopper who taps go-live before it finishes
       (right as a widget correction lands and the button unblocks) previously
       sailed straight past this gate, connected, and the composite only got
       built - AWAITED, but no longer BEFORE billing/connect - inside the first
       applyGarment() call once already live. That is a strictly worse place for a
       multi-second build to happen for the first time, and is the most direct
       mechanical explanation for a first live session behaving differently from a
       later one on the exact same item: this call is a no-op cache hit if the
       prewarm already finished, and the actual missing wait if it had not. */
    if (compositeActiveFor(item)) {
      setText(`מכינים תצוגה משולבת… · Preparing combined view… ${label} […]`);
      let composite = null;
      if (item.composite) {
        // Prefer the widget's own composite (it is the exact image the store page
        // produced); a decode failure here is not fatal - fall through and build
        // one locally, same as referenceImageFor() already does at apply time.
        composite = await garmentBlobCached(item.composite);
        if (!composite) console.warn("[PEAR] handed-over composite failed to decode during preload -", label);
      }
      if (!composite) composite = await createGarmentComposite(front, back);
      setText(`מכינים תצוגה משולבת… · Preparing combined view… ${label} [${composite ? "OK" : "FAIL"}]`);
      if (!composite) {
        console.warn("[PEAR] COMPOSITE failed pre-load validation - proceeding FRONT-ONLY -", label);
        hasBack = false;   // same degrade path as a broken back blob - never go live on an unvalidated reference
      }
    }
  }
  return { ok, hasBack };
}

/* ── Context-Aware Asset Switching - OrientationWatcher ───────────────────────
   Watches the LOCAL camera (localStream - the raw preview feed, NOT the AI output) and
   flips autoOrientation between "front" and "back" as the user turns, hot-swapping the
   matching pre-cached reference through the normal applyActive() → rtClient.set() path
   (same session, no reconnect - a brief cross-fade overlay masks the swap instead of a
   jarring cut, see orientFadeFreeze/orientFadeReveal below).

   Detection engine: native FaceDetector (Shape Detection API) when available - a
   detected face means the user is facing the camera (FRONT). Demoted permanently after
   one runtime failure (some builds expose the class but throw NotSupportedError at
   detect()). Browsers without FaceDetector fall back to a skin-ratio heuristic: % of
   skin-tone pixels in the head band (upper 45%, central 50%) of a tiny 96×96 frame - a
   frontal face shows far more skin than the back of a head. DUAL thresholds (≥10% →
   front, ≤4% → back, dead-band between) so an ambiguous profile frame abstains instead
   of voting.

   ASYMMETRIC CORROBORATION: a face DETECTED is taken at face value; a face NOT DETECTED
   is cross-checked against the skin histogram before it may vote BACK, and the tick
   abstains when the two disagree. The two directions have very different error rates -
   see classify()'s comment for why hysteresis alone could not fix this (the failures
   are systematic, not random, so the streak accumulates rather than cancelling).

   Anti-flap discipline (this is what stops the view from flapping back and forth):
     • a flip needs ORIENT_LOCK_FRAMES consecutive agreeing votes OR
       ORIENT_LOCK_MS of sustained agreement, whichever comes first - a real turn
       satisfies both quickly; a single noisy frame satisfies neither;
     • ORIENT_COOLDOWN_MS minimum gap between actual live set() swaps, on top of that;
     • a single in-flight guard - the sampler itself is the retry loop, so a turn
       completed mid-swap is picked up by the very next confirmed vote;
     • abstains (null votes) never reset an in-progress streak - only a genuinely
       DISAGREEING vote does.

   STATE LOCK MODEL (three states: PENDING → FRONT | BACK). The session BOOTS in
   PENDING_MODE - the orientation is unresolved, not assumed - and the first pair of
   agreeing confident samples (ORIENT_ACQUIRE_FRAMES, ~500ms) acquires the real one.
   Both garment assets are already fetched, decoded and validated before this point
   (preloadGarmentAssets() gates go-live on it), so acquisition can apply EITHER side
   immediately; PENDING renders the front provisionally only because that is what is
   already on the wire at connect.

   Acquisition and flipping are separate transitions with separate bars on purpose.
   The anti-flap thresholds below exist to protect a CONFIRMED reading from noise;
   applying them to the first reading protected nothing and simply delayed it, which
   is what made a shopper who went live already turned around watch the front render
   on their back for the first few seconds.

   Once acquired, autoOrientation is a LOCK, not a live readout - every tick that
   disagrees only accumulates evidence (streak/held); it does NOT touch the rendered
   reference until that evidence clears BOTH ORIENT_LOCK_FRAMES consecutive agreeing
   samples AND enough elapsed time (ORIENT_LOCK_MS) to rule out a momentary head turn
   or a single misread. At the
   default 250ms sample rate the two thresholds land at the same ~4s mark by design
   (10 × 250ms = 2500ms) - ORIENT_LOCK_MS is a robustness backstop for a throttled/
   backgrounded tab where setInterval ticks slip, not an independent faster path. A
   confirmed transition logs "[VTON Pipeline] Current Active State: ..." so it's
   obvious in the console exactly when (and how rarely) the lock actually moves.
   The watcher never touches the camera track (shared with the preview); stop() only
   detaches its own <video> sampler. Lifecycle is owned by syncOrientationWatcher(). */
const ORIENT_SAMPLE_MS      = 250;   // ~4 analyses/s - cheap on a 96px canvas
/* ── HALVED 2026-08-24, ON MEASURED EVIDENCE ────────────────────────────────
   These were 10 / 2500 (~2.5s), sized to cover a window that turned out not to need
   covering. The reasoning was that a half-turned shopper renders against pre-turn
   conditioning and the most probable completion is their own clothing, so the reference
   had to be held until a turn was certain.

   WHAT THE EVIDENCE ACTUALLY SHOWS: the downloaded .mp4 records #aiVideo directly, with
   no UI overlay in its path (see the recorder's paint loop), so it is the honest view of
   what Decart sent. Across rotation it is clean - zero reversions to the shopper's own
   clothing. The mechanism these thresholds were sized against is not firing.

   WHY THAT IS CONSISTENT rather than lucky, at least for the session it was measured on:
   in composite mode the reference is ONE stitched FRONT|BACK image, identical for both
   orientations, so a confirmed turn re-issues set() with only the clause changed and the
   Blob memoized - there is no conditioning-replacement window to render badly through.
   See referenceImageFor()'s composite branch.

   ⚠️ WHAT IS STILL BOUGHT WITH THIS, and the reason it is halved rather than removed: a
   wrong flip does not merely look stuttery, it swaps the reference and renders the WRONG
   SIDE of the garment on the shopper (see the edge-on note below). 5 samples is still
   1.25s of SUSTAINED, confidence-gated agreement, which a glance over the shoulder does
   not produce, and ORIENT_COOLDOWN_MS (1500) remains underneath as the secondary
   anti-flap bar. If the wrong side starts appearing on head-turns, this is the first
   number to put back.

   KEPT IN STEP: the two are one threshold expressed two ways (5 x 250ms = 1250ms), so
   ORIENT_LOCK_MS stays the throttled-tab backstop it was, at the same mark. */
const ORIENT_LOCK_FRAMES    = 5;     // consecutive agreeing samples to unlock (~1.25s @ 250ms/sample)
const ORIENT_LOCK_MS        = 1250;  // OR this much sustained agreement - whichever comes first (see note above)
/* FIRST acquisition only - see PENDING_MODE below. Deliberately far lower than
   ORIENT_LOCK_FRAMES: that threshold's job is to stop a CONFIRMED state from
   flapping, and until the first reading lands there is no confirmed state to
   protect. Two agreeing confident samples (~500ms) is enough to establish one, and
   paying the full 2.5s anti-flap cost for it is what made a shopper who was already
   turned around watch the FRONT render on their back for the first few seconds. */
const ORIENT_ACQUIRE_FRAMES = 2;
const ORIENT_CONFIDENCE_MIN = 0.85;  // per-frame vote must clear this confidence or it abstains (see skinConfidence())
const ORIENT_COOLDOWN_MS    = 1500;  // min gap between live reference swaps (anti-flap, secondary to the lock)
/* Edge-on detection thresholds. Deliberately FAR looser than the orientation lock's,
   because the two protect different things and carry different costs when wrong. A wrong
   orientation flip swaps the garment reference and shows the wrong side of the shirt on a
   shopper's body - expensive, hence ORIENT_LOCK_FRAMES/ORIENT_LOCK_MS at ~2.5s. A wrong
   profile reading only softens a pose sentence and adds a "preserve their real body
   volume" instruction, which is a true statement at every angle; the worst case is a few
   hundred wasted prompt characters. The asymmetry is the whole reason this can react in
   ~500ms while the lock still takes seconds - and it matters, because a 90-degree turn
   passes through the window this is trying to catch. */
const ORIENT_PROFILE_ENTER  = 2;     // min samples in the buffer before it may assert anything (~500ms)
/* ROLLING WINDOW. The per-frame edge-on score is noisy by nature - it is read off a 96px
   canvas with no model behind it - so the decision is made on the MEAN of the last N
   scores rather than on any single frame. This is the anti-jitter mechanism: a shopper
   parked near the threshold angle produces scores that straddle it, and averaging turns
   that into one stable answer instead of a toggle every 250ms. Five samples is ~1.25s of
   evidence, short enough to still catch a turn in progress. */
const ORIENT_PROFILE_WINDOW = 5;
/* Mean score over that window required to ASSERT edge-on. Calibrated against the weights
   in profileScore() so that no single weak signal can reach it alone - see that
   function's table. */
const ORIENT_PROFILE_ENTER_SCORE = 0.55;
/* FAST PATH, and it is not redundant with the mean above. Averaging over five samples is
   the right answer for a shopper hovering near the threshold angle, but it is the wrong
   one for a decisive turn: the window still holds the square-on scores from before the
   rotation started, so a shopper who is unambiguously side-on has to wait for those to
   age out. Measured on the modelled spin in side-profile.test.mjs §5d, that cost a full
   sample - EDGE-ON landed at ~110° instead of at 90°.
   Two consecutive samples this high mean several independent signals agree at once
   (ambiguous skin AND a foreshortened silhouette - see profileScore's table), which is a
   turn, not noise. Borderline oscillation cannot reach it, so the jitter protection the
   mean provides is untouched: the two paths cover disjoint cases. */
const ORIENT_PROFILE_FAST_SCORE  = 0.85;
const ORIENT_PROFILE_FAST_FRAMES = 2;
/* Consecutive square-on samples required to LEAVE edge-on. The previous build exited on
   the first one; two sustained windows (~500ms) is the anti-jitter half of the same
   asymmetry, and stops a single well-lit frame mid-turn from dropping the depth clause
   and snapping the pose back for one message. Still deliberately short - a stale
   "they are side-on" claim is the same class of false pose assertion this feature exists
   to remove, so it must not outlive the evidence by much. */
const ORIENT_PROFILE_EXIT   = 2;
/* Floor below which a per-frame score counts as "no meaningful profile evidence" - used
   both by the squareStreak count above and, as the earliest possible signal, by the turn
   hold below (see orientHoldBegin's "profile-turn-detected" reason): the same asymmetry
   that makes ENTER slow and deliberate but EXIT/abandon fast applies to freezing the last
   dressed frame - a hold that outlives real evidence by much is a stuck still, not a fix. */
const ORIENT_PROFILE_EXIT_SCORE = 0.25;
/* Min gap between profile-driven prompt re-issues. These ride setPrompt() - a small
   control message, no image bytes (see applyGarment()'s flicker-fix comment) - so this
   guards against pointless chatter on a shopper who is oscillating around the threshold,
   not against bandwidth. Shorter than ORIENT_COOLDOWN_MS for the same asymmetry above. */
const ORIENT_PROFILE_COOLDOWN_MS = 1200;
/* ── Steering re-anchor ────────────────────────────────────────────────────────
   THE BUG: the garment renders, then quietly reverts to the shopper's real clothing
   part-way through the session - reported at 90° dwell AND (from the earliest reports)
   head-on.

   maybeUpdateProfile() only calls setPrompt() on a TRANSITION - autoProfile flipping.
   maybeSwap() only fires on a confirmed front/back flip. A shopper who simply STAYS in
   one pose triggers neither, so the steering prompt is asserted once and then never
   again for the rest of the session. Lucy has no cross-frame state (see
   COMPOSITE_TEMPORAL's comment) - the prompt is applied continuously server-side once
   set, not re-read from anywhere client-side - so this isn't the model "forgetting" a
   fact: it is a single assertion being asked to hold the whole generation window on its
   own, against a strong prior (a diffusion model's default completion for a person on
   camera is the person as photographed) pulling the other way the entire time.
   Periodically re-issuing the CURRENT prompt, unchanged, re-steers it.

   NOT scoped to edge-on. The first version of this was, which was an arbitrary
   restriction: the mechanism above is pose-INDEPENDENT, and a shopper standing still
   facing the camera goes just as long without a re-assertion as one holding a profile.
   applyActive() re-derives the current desired state (including profileActive()), so
   one cadence covers every pose without needing to know which one is live. */
/* Min gap between re-anchors, DERIVED from the session length rather than hardcoded.
   A hardcoded value is exactly how the first version of this shipped broken: it was set
   to 4000ms against a LIVE_DURATION_MS of 5000ms, so it could fire at most ONCE per
   session - and only for a shopper who held a single pose for 4 of their 5 seconds.
   Deriving it keeps the real invariant - "re-anchor several times WITHIN a session" -
   true by construction if the billed window is ever retuned.

   TIGHTENED /4 -> /8 (1250ms -> 625ms), against a report of drift into an unrelated
   outfit visible within the first ~1s and dominant by ~4s - faster than the previous
   cadence's SECOND re-anchor (~1.25s) even landed. maybeReanchorPrompt() fires as soon
   as the first frame is dressed (see prompt-reanchor.test.mjs §2 - that is tested,
   intended behaviour, not a bug), then every REANCHOR_MS after; halving the gap roughly
   doubles the corrective opportunities inside the same 5s window (~8 instead of ~4).

   THE HONEST LIMIT on what this can fix: it re-asserts the SAME prompt text, unchanged.
   @decartai/sdk@0.1.5's realtime setInputSchema exposes exactly { prompt, enhance,
   image } (z.core.$strip - unknown keys are silently discarded, not forwarded), so there
   is no temporal-consistency, frame-guidance-weight or seed parameter to raise instead -
   this cadence IS the substitute for one. If the backend holds any temporal state this
   API surface doesn't expose (plausible for a realtime video model, and consistent with
   drift existing at all despite "no cross-frame state" being the documented client-side
   contract), no cadence of re-asserting unchanged text can out-run it; only a genuinely
   stronger anchor - which this API does not offer a way to send - would.

   The floor is a chatter guard for a hypothetical very short window; at LIVE_DURATION_MS
   =5000 this resolves to 625ms (~8 re-anchors per session). Each rides setPrompt(): a
   small control message, no image bytes (see applyGarment()'s flicker-fix comment), so
   the cost of the extra frequency is negligible and does NOT re-upload the reference -
   the specific technique this file already ruled out re-sending the IMAGE periodically
   for (a full re-upload risks the same mid-stream glitch the flicker fix exists to
   prevent, whether or not the image content actually changed). */
const REANCHOR_MS = Math.max(500, Math.round(LIVE_DURATION_MS / 8));
/* ── Foreshortening (silhouette width) thresholds ─────────────────────────────
   Measured RELATIVE to the shopper's own square-on width, never as an absolute pixel
   count: absolute width depends on how far they stand from the lens, their build, and the
   camera's field of view, none of which are known. torsoWidth() learns the baseline from
   frames the lock has already confidently called front or back, so the comparison is
   always "narrower than THIS person was a moment ago". */
const ORIENT_NARROW_RATIO   = 0.78;  // width/baseline at or below this reads as foreshortened
const ORIENT_NARROW_FLOOR   = 0.55;  // ...and the evidence saturates here (a full 90° turn)
const ORIENT_BASELINE_MIN   = 3;     // confident square-on samples before the baseline is trusted
const ORIENT_SIZE           = 96;    // skin-histogram canvas edge - tiny on purpose (per-pixel loop)
const ORIENT_FACE_SIZE      = 256;   // face-detection canvas edge - 96px is too small to detect a face reliably
// Explicit enum for the per-orientation lock (a DIFFERENT axis from AUTO_ANGLE/"front"
// above, which is which TOP-LEVEL try-on mode is active - this is which SIDE of the
// garment AUTO_ANGLE mode is currently locked to).
const FRONT_MODE = "FRONT_MODE";
const BACK_MODE  = "BACK_MODE";
/* Third state, and the one that removes the startup FRONT lock: the session now boots
   with the orientation UNRESOLVED rather than asserting "the shopper is facing me".
   Both assets are already resident by this point (preloadGarmentAssets() blocks
   go-live on fetching AND validating both), so whichever side the first confident
   sample reports can be applied immediately - there is no front-biased warm-up.

   PENDING renders the FRONT reference provisionally, because that is what
   applyActive() already put on the wire at connect and because a shopper who just
   finished a camera-based measurement is nearly always facing the lens. The
   difference from the old behaviour is that this is a PROVISIONAL render, corrected
   within ~500ms, instead of a locked state that needed 2.5s+ of sustained
   disagreement to leave. */
const PENDING_MODE = "PENDING_MODE";
/* Single compact per-tick line for tuning the thresholds above. OPT-IN rather than always
   on: it fires ~4x/second for the entire life of a session, which is genuinely useful when
   diagnosing a live orientation problem and pure noise in every other console. Enabled per
   session with ?orient_debug=1, or stickily with localStorage pear_orient_debug=1 - the
   same pair of conventions the stats overlay already uses, so there is one way to do this
   in this file rather than two. Reads once at load; failures are swallowed because
   localStorage throws outright in some privacy modes. */
const ORIENT_DEBUG = (() => {
  try {
    if (new URLSearchParams(location.search).get("orient_debug") === "1") return true;
    return localStorage.getItem("pear_orient_debug") === "1";
  } catch (_) { return false; }
})();

let orientWatcher = null;         // { stop } while running, else null
let orientWatcherItem = null;     // the activeItem this instance's GARMENT_FRONT/BACK were
                                   // captured from - see the staleItem branch below.

/* Idempotent lifecycle gate - safe to call from ANY state change (angle switch, item swap,
   go-live, teardown): starts the watcher whenever it has something to protect, retires it
   otherwise.

   TWO tiers, not one. DUAL-VIEW (AI Auto, a real distinct back exists) gets the full
   watcher: front/back asset-switching AND the profile axis. SINGLE-VIEW (no real back -
   a custom upload, or a catalog item shipping only a front photo) used to get NONE of
   this - turning 90 degrees got no depth-fidelity clause, no truthful pose, and no
   freeze-hold, only the always-on generic STRICT_INPAINT/ROTATION_CONTINUITY text, which
   is exactly the reversion/flattening bug this file has already fixed once for the
   dual-view case. SINGLE-VIEW now arms the SAME watcher for the PROFILE axis only - there
   is no second asset to switch to, so the front/back half (maybeSwap, the acquiring/
   needsSwitch lock) stays permanently and safely inert for it; see maybeSwap()'s own
   `currentAngle !== AUTO_ANGLE` guard and the tick's `dualView` gate below. */
function syncOrientationWatcher() {
  const dualView = currentAngle === AUTO_ANGLE && canCombineViews(activeItem);
  const singleView = currentAngle !== AUTO_ANGLE && !!activeItem;
  const want = (dualView || singleView) && isLive() && !!localStream;
  /* A watcher armed for one item must never keep running against a DIFFERENT one - its
     GARMENT_FRONT/GARMENT_BACK (and, for single-view, the item its profile signal is
     meaningful for) are captured once at creation and go stale on a swap. `want` alone
     does not catch this: swapping between two items that are both dual-view (or both
     single-view) leaves `want` true throughout, so the watcher would otherwise never be
     torn down and rebuilt for the new item. */
  if (orientWatcher && orientWatcherItem !== activeItem) {
    try { orientWatcher.stop(); } catch (_) {}
    orientWatcher = null;
    orientWatcherItem = null;
  }
  if (want && !orientWatcher) { orientWatcher = createOrientationWatcher(); orientWatcherItem = activeItem; }
  else if (!want && orientWatcher) { try { orientWatcher.stop(); } catch (_) {} orientWatcher = null; orientWatcherItem = null; }
}

/* ── Orientation-swap cross-fade ──────────────────────────────────────────────
   A confirmed flip re-issues rtClient.set() with a new reference, but the live #aiVideo
   stream needs a few remote-rendered frames to catch up - cutting straight to that reads
   as a jarring replace, not a garment turning with the body. This freezes the CURRENT
   #aiVideo frame onto a canvas pinned exactly over it (same position/size/mirroring),
   holds it at full opacity while the swap is in flight, then cross-fades it out over
   ORIENT_FADE_MS once Decart has had a moment to render the new side - the frozen frame
   IS the "anchor" while the live feed underneath catches up and is revealed. One canvas
   draw + a CSS opacity transition; no per-frame cost. */
const ORIENT_FADE_MS      = 260;   // cross-fade duration - fast, not jarring
const ORIENT_FADE_HOLD_MS = 150;   // grace period after set() resolves before revealing, so the
                                    // frame the fade uncovers is actually the NEW side, not the old one
let _orientFadeCanvas = null;

function orientFadeEl() {
  if (_orientFadeCanvas) return _orientFadeCanvas;
  const card = $("cameraCard");
  if (!card) return null;
  if (!document.getElementById("pear-orient-fade-styles")) {
    const s = document.createElement("style");
    s.id = "pear-orient-fade-styles";
    s.textContent =
      // transform:none (NOT the generic .camera-card mirroring rule) - #aiVideo itself is
      // set to transform:none once live ("the edited feed is already correctly oriented",
      // see onRemoteStream), and this overlay must line up pixel-for-pixel with THAT frame.
      "#orientFadeCanvas{position:absolute;inset:0;width:100%;height:100%;" +
      "object-fit:cover;transform:none;z-index:6;pointer-events:none;" +
      `opacity:0;transition:opacity ${ORIENT_FADE_MS}ms ease-out;}`;
    document.head.appendChild(s);
  }
  const c = document.createElement("canvas");
  c.id = "orientFadeCanvas";
  card.appendChild(c);
  _orientFadeCanvas = c;
  return c;
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE AI FEED'S VISIBILITY - the DISPLAY half of the conditioning gate
   ══════════════════════════════════════════════════════════════════════════════
   THE INPUT GATE (createThrottledInputStream) is the primary fix for the grey-sweater
   flash: it withholds camera frames until the reference is acknowledged, so Decart never
   generates a placeholder frame in the first place. This is the second lock on the same
   door, and it exists because the first one depends on a remote service behaving as
   expected while this one does not depend on anything at all.

   THE HOLE IT CLOSES IS REAL AND WAS ITS OWN BUG. style.css hides #aiVideo until the card
   carries .show-live - which is added only at Model Ready - but onRemoteStream() set
   `aiVideo.style.display = "block"` the moment the remote stream arrived, and an INLINE
   style beats a stylesheet rule. So the AI feed was displayed from the first remote frame,
   with the reveal class still absent, and the only thing standing between it and the
   shopper was #scanOverlay - which is `rgba(8,8,10,.34)` plus a 3px blur. A 34%-opaque
   scrim does not hide a garment; it dims one. Whatever Decart rendered in that window was
   visible through it, slightly darkened, which is exactly what the report describes.

   OPACITY, NOT display:none, AND THAT IS DELIBERATE. armFirstFrameBilling() decides Model
   Ready by SAMPLING this element - requestVideoFrameCallback plus a luma read - so it must
   keep decoding and presenting frames throughout the gated window. A display:none video is
   not composited and may stop firing rVFC entirely, which would deadlock the very gate
   this is meant to serve. opacity:0 keeps the element in the render tree, decoding and
   presenting exactly as before, and contributing nothing visible.
   The two `ai.style.display !== "none"` readers (captureHoldFrame, freezeFinalFrame) are
   therefore untouched: display still means what it always meant. */
const AI_FEED_FADE_MS = 220;

/* Hold the feed invisible while it decodes. Called from onRemoteStream, i.e. the instant
   there is a stream at all - before which there is nothing to hide. */
function gateAiFeed(aiVideo) {
  if (!aiVideo) return;
  aiVideo.style.transition = "none";
  aiVideo.style.opacity = "0";
}

/* Fade it in. Called from the ONE place that already decides Model Ready - the same
   statement that adds .show-live - so the pixels and the state class can never disagree.
   A transition rather than a cut: by this point three consecutive qualifying frames have
   decoded, so the content is settled and the fade is pure polish over a correct frame. */
function revealAiFeed() {
  const ai = $("aiVideo");
  if (!ai) return;
  ai.style.transition = `opacity ${AI_FEED_FADE_MS}ms ease-out`;
  ai.style.opacity = "1";
}

/* Hand #aiVideo back to the stylesheet. MUST run wherever the element is retired or given
   different content - a session teardown, or a history clip loading into the same player -
   or that content inherits an opacity:0 from a session that is already over and renders
   nothing at all.

   IT CLEARS `display` TOO, AND THAT FIXES A SEPARATE PRE-EXISTING BUG. The teardown paths
   set an inline display:none to undo onRemoteStream's inline display:block, and nothing
   ever cleared it - so a history clip afterwards added .show-clip, whose whole job is
   `.camera-card.show-clip #aiVideo { display: block; }`, and lost to the leftover inline
   rule. The clip played with the element still hidden. Clearing rather than re-asserting
   is the fix for both: the stylesheet's base rule already hides #aiVideo, so the visual
   outcome at teardown is identical, and the state classes can govern again the way they
   were written to. This is the ONE place inline visibility is undone, so there is no
   second copy to forget. */
function resetAiFeedVisibility() {
  const ai = $("aiVideo");
  if (!ai) return;
  ai.style.transition = "";
  ai.style.opacity = "";
  ai.style.display = "";
}

/* Snapshot the live #aiVideo frame into the overlay and show it at full opacity with NO
   transition (an instant cut onto a frame identical to what's already showing is
   invisible). Call BEFORE issuing the swap. */
function orientFadeFreeze() {
  const ai = $("aiVideo");
  const c = orientFadeEl();
  if (!ai || !c || !ai.videoWidth) return;
  c.width = ai.videoWidth; c.height = ai.videoHeight;
  c.getContext("2d").drawImage(ai, 0, 0, c.width, c.height);
  c.style.transition = "none";
  c.style.opacity = "1";
  void c.offsetWidth;              // flush so the transition below re-arms
  c.style.transition = `opacity ${ORIENT_FADE_MS}ms ease-out`;
}

/* Fade the frozen overlay back out, revealing the (by now updated) live feed underneath.
   Call AFTER the swap's rtClient.set() has resolved (+ a short ORIENT_FADE_HOLD_MS). */
function orientFadeReveal() {
  if (!_orientFadeCanvas) return;
  _orientFadeCanvas.style.opacity = "0";
}

/* ── THE RE-DRAPE'S FRAME COVER ────────────────────────────────────────────────
   REPORTED, on video: the target garment is correct, then for a second or two it is a
   plain generic tee, then it is correct again - during body movement.

   THE MECHANISM IS THE ONE THE ATOMIC CONDITIONING GATE ALREADY DESCRIBES (see
   createThrottledInputStream): Decart renders every frame it is handed, and a full
   set({ image }) takes a datachannel round-trip to land. Frames arriving during that
   round-trip are rendered against conditioning that is mid-replacement, so the most
   probable completion is the model's own prior - a generic garment. The gate closes that
   window at session start and is one-shot by design; nothing covered the same window when
   reconditionForTopology() re-uploads on movement.

   So cover it the way a front/back swap is already covered: snapshot the last good
   dressed frame, hold it over #aiVideo while the re-upload is in flight, and cross-fade
   back once the new conditioning has landed. The shopper sees their own last dressed
   frame for the length of a round-trip instead of a garment they did not choose.

   A SEPARATE COVER FROM THE ORIENTATION HOLD, DELIBERATELY, and not for tidiness. The two
   have independent lifecycles and neither may release the other. The orientation watcher
   calls orientHoldEnd("turn-abandoned") from its 250ms tick whenever no front/back turn is
   in progress - which is nearly always during a plain re-drape - so sharing
   _orientHoldActive would have let that tick tear this cover down mid-re-upload, within
   one tick of it going up. Sharing the CANVAS has the same problem one layer down. Two
   overlays, two z-indexes, two timers; when both happen to be up they hold the same
   snapshot, so the stack reads identically either way.

   THE TRADE, STATED PLAINLY: this shows a still frame during movement. A re-drape fires at
   most every BODY_RECONDITION_COOLDOWN_MS (900ms), and each cover lasts a round-trip plus
   ORIENT_FADE_HOLD_MS before a 260ms cross-fade - so a shopper who moves continuously
   trades some live-motion fidelity for never seeing the wrong garment. That is the right
   way round (a laggy self is recognisable; a stranger's shirt is not), but it is a real
   trade and REDRAPE_HOLD_MAX_MS is what bounds the failure: a hung apply reveals the live
   feed rather than leaving a still up, exactly as the turn hold's ceiling does. */
/* 1800 -> 900. THIS IS A BACKSTOP, NOT THE NORMAL PATH, and that distinction is the whole
   reason it is not 300: reconditionForTopology() releases on its own as soon as the new
   conditioning has landed (see its finally), so this number only ever fires when that
   never happens. Cutting it to 300 would not make a healthy re-drape snappier - it would
   make the TIMEOUT fire before a normal set({ image }) round-trip completes, uncovering
   exactly the generic-garment window this cover exists to hide. That is the defect
   e937966 was written for: "the target garment is correct, then for a second or two it is
   a plain generic tee".

   900 IS CHOSEN, NOT SPLIT THE DIFFERENCE: it equals BODY_RECONDITION_COOLDOWN_MS, which
   is the minimum gap before another re-drape may dispatch. A cover can therefore never
   still be up when the next one becomes eligible - covers cannot queue behind each other,
   which is the state that would read as a long freeze rather than a short one.

   ⚠️ WHY THIS IS NOT THE TURN COVER'S 400. The .mp4 evidence that justified shortening
   the turn hold does not transfer: a composite TURN is prompt-only (one stitched
   reference, identical both ways, Blob memoized), while a RE-DRAPE is a full
   set({ image }) - lastSentImageRef/rtImageOnWire/lastSentPrompt are all cleared first.
   The conditioning-replacement window is real here in a way it is not there. Lowering
   this further wants its own measurement: record a session, move the body WITHOUT
   turning, and check the .mp4 for a generic garment at the re-drape. */
const REDRAPE_HOLD_MAX_MS = 900;    // ceiling - a stuck still is worse than an honest live frame
let _redrapeHoldActive = false;
let _redrapeHoldTimer  = null;
let _redrapeCanvas     = null;

function redrapeCoverEl() {
  if (_redrapeCanvas) return _redrapeCanvas;
  const card = $("cameraCard");
  if (!card) return null;
  if (!document.getElementById("pear-redrape-cover-styles")) {
    const s = document.createElement("style");
    s.id = "pear-redrape-cover-styles";
    /* z-index 7 - one above the orientation fade's 6. When a turn is confirmed during a
       re-drape both covers can be up; the turn's is the longer-lived and more important
       of the two, but they carry the same snapshot, so which one wins the stack is
       cosmetically irrelevant and the ordering is fixed only so it is not accidental. */
    s.textContent =
      "#redrapeCoverCanvas{position:absolute;inset:0;width:100%;height:100%;" +
      "object-fit:cover;transform:none;z-index:7;pointer-events:none;" +
      `opacity:0;transition:opacity ${ORIENT_FADE_MS}ms ease-out;}`;
    document.head.appendChild(s);
  }
  const c = document.createElement("canvas");
  c.id = "redrapeCoverCanvas";
  card.appendChild(c);
  _redrapeCanvas = c;
  return c;
}

/* Snapshot #aiVideo and hold it at full opacity with NO transition - an instant cut onto a
   frame identical to what is already on screen is invisible. Call BEFORE the re-upload.
   @returns {boolean} whether a cover actually went up (false = nothing paintable yet, in
   which case the caller must not wait for a fade it is not showing). */
function redrapeCoverBegin() {
  /* Returning FALSE, not just skipping the paint: the caller reads this as "no cover went
     up" and then skips its own post-dispatch frame wait, so disabling the overlay also
     removes the latency it used to add. See UI_HOLD_OVERLAYS_ENABLED in config.js. */
  if (!UI_HOLD_OVERLAYS_ENABLED) return false;
  if (_redrapeHoldActive) return false;
  const ai = $("aiVideo");
  const c = redrapeCoverEl();
  /* No decoded frame yet - there is nothing good to hold, and freezing a blank canvas over
     a live feed would CREATE the artifact this exists to prevent. Degrade to uncovered. */
  if (!ai || !c || !ai.videoWidth) return false;
  c.width = ai.videoWidth; c.height = ai.videoHeight;
  c.getContext("2d").drawImage(ai, 0, 0, c.width, c.height);
  c.style.transition = "none";
  c.style.opacity = "1";
  void c.offsetWidth;              // flush so the transition below re-arms
  c.style.transition = `opacity ${ORIENT_FADE_MS}ms ease-out`;
  _redrapeHoldActive = true;
  if (_redrapeHoldTimer) clearTimeout(_redrapeHoldTimer);
  _redrapeHoldTimer = setTimeout(() => {
    console.warn("[PEAR] body re-drape cover hit its", REDRAPE_HOLD_MAX_MS +
      "ms ceiling; revealing the live feed");
    redrapeCoverEnd("timeout");
  }, REDRAPE_HOLD_MAX_MS);
  return true;
}

/**
 * Resolve on the next PRESENTED frame of `video`, or after `maxMs`, whichever lands first.
 *
 * WHY THIS EXISTS, and why it is not just a shorter setTimeout. The cover used to be
 * released a flat ORIENT_FADE_HOLD_MS after the dispatch resolved. Two things are wrong
 * with a timer here, and the reported symptom is the second one:
 *
 *   1. AN ACK IS NOT A RENDER. applyActive() resolving means Decart ACCEPTED the new
 *      conditioning, not that a frame produced from it has arrived and decoded. A fixed
 *      grace is a guess at that gap.
 *   2. setTimeout IS MAIN-THREAD, AND SO IS THE THING COMPETING WITH IT. detectForVideo()
 *      is a WASM pass on the same thread that services the datachannel and paints the UI
 *      (see the presence watcher's own note), so under pose-inference load the release
 *      callback is queued behind it and the cover visibly outstays its welcome. That is
 *      the "the hold drags out much longer on screen" report.
 *
 * requestVideoFrameCallback fires on frame PRESENTATION, driven by the compositor rather
 * than by a queued timer, which is why the frame-freeze watcher already prefers it for
 * exactly this reason. The timer stays as the ceiling and as the fallback for browsers
 * without rVFC, so this is never SLOWER than what it replaces.
 *
 * HONEST LIMIT: the first presented frame after an ack is not guaranteed to be rendered
 * from the new conditioning - a frame already in flight can arrive first. This is bounded
 * by the same maxMs the fixed wait used, so the worst case is revealing a frame or two
 * earlier than before; the best case is releasing a full grace period sooner. If early
 * reveals are ever reported, wait for the SECOND frame rather than restoring the timer.
 *
 * @param {HTMLVideoElement|null} video
 * @param {number} maxMs  ceiling, also the whole wait when rVFC is unavailable
 * @returns {Promise<"frame"|"timeout">} which one won, for the log
 */
function nextPresentedFrame(video, maxMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (why) => { if (!settled) { settled = true; resolve(why); } };
    const timer = setTimeout(() => finish("timeout"), maxMs);
    if (video && typeof video.requestVideoFrameCallback === "function") {
      try {
        video.requestVideoFrameCallback(() => { clearTimeout(timer); finish("frame"); });
      } catch (_) { /* fall through to the timer */ }
    }
  });
}

/* Fade the cover out, revealing the (by now re-conditioned) live feed underneath.
   Idempotent, and safe to call when no cover is up - every session-ending path calls it
   unconditionally so a cover can never outlive the window that raised it. */
function redrapeCoverEnd(reason) {
  if (_redrapeHoldTimer) { clearTimeout(_redrapeHoldTimer); _redrapeHoldTimer = null; }
  if (!_redrapeHoldActive) return;
  _redrapeHoldActive = false;
  if (_redrapeCanvas) _redrapeCanvas.style.opacity = "0";
  if (ORIENT_DEBUG) console.log("[PEAR] body re-drape - releasing frame cover (" + reason + ")");
}

/* ── Freeze THROUGH the turn, not just through the swap ───────────────────────
   THE BUG: "when I turn around, my real shirt comes back for a moment."

   The freeze above used to start inside maybeSwap() - i.e. only once the flip was
   CONFIRMED, which was then ORIENT_LOCK_FRAMES (10 samples ≈ 2.5s, now 5 ≈ 1.25s) after
   the shopper began turning. It covered the reference swap and nothing else. But the reversion does not
   happen during the swap; it happens during those 2.5 seconds BEFORE it, while the
   shopper is mid-rotation, side-on and foreshortened, and the model is still being told
   "the person is FACING FORWARD, use the LEFT panel". Lucy regenerates every frame, and
   for a half-turned, partly-occluded person the most probable completion is the person as
   actually photographed - wearing their own shirt. So the garment drops, and the freeze
   arrives too late to hide any of it.

   The hold now starts on the FIRST disagreeing vote - the earliest moment we have any
   evidence a turn is underway - and the frame it captures is therefore still a good
   dressed one. It ends when the swap completes, when the shopper turns back (the vote
   returns to the locked side, so no flip is coming), or on a hard timeout.

   The hysteresis itself is deliberately NOT loosened to compensate. Lowering
   ORIENT_LOCK_FRAMES would swap the reference on a head-turn and re-introduce the
   flapping that threshold exists to stop; this covers the same window without touching
   the confirmation bar. */
/* 4000 -> 1800 -> 400, the last step on measured evidence rather than on argument.

   THE PARAGRAPH THAT USED TO SIT HERE SAID THE CONFIRMATION WINDOW WAS "DELIBERATELY NOT
   TOUCHED", because capping the cover would uncover mid-rotation frames that render the
   shopper's own shirt. That was the right call on the evidence available then. It is
   superseded by evidence, not by preference: the .mp4 records #aiVideo with no overlay in
   its path, and across rotation it shows zero reversions. There were no bad frames under
   the cover to uncover - see ORIENT_LOCK_FRAMES' note for why that is structural in
   composite mode.

   SO THE COVER NOW SPANS THE DISPATCH, NOT THE DECISION. What is still worth hiding is
   the swap's own datachannel round-trip; 400ms bounds that with room. The hold is raised
   on the first disagreeing vote and released on swap completion, so on a healthy turn
   this ceiling is what releases it - roughly a third of a blink instead of a second and a
   half of stillness.

   NOT ZERO, and that is deliberate. orientHoldBegin() snapshots and cross-fades; a
   ceiling of ~0 would still raise the overlay and then fade it out over ORIENT_FADE_MS,
   which is a visible blip for no cover at all. If the goal becomes "never hold", the
   honest change is to stop calling orientHoldBegin() on this path, not to set this to a
   number so small the mechanism only shows its seams.

   ⚠️ THE EVIDENCE IS FROM A COMPOSITE SESSION. A single-asset item (a real distinct back
   photo, no composite) DOES swap the reference Blob on a turn, so its conditioning-
   replacement window is real and is now covered for 400ms instead of 1800. If garment
   reversion is reported on a turn, check whether that item ships a composite before
   touching anything else. */
const ORIENT_TURN_HOLD_MAX_MS = 400;   // hard ceiling - spans the swap dispatch, not the decision
let _orientHoldActive = false;
let _orientHoldTimer  = null;

/* @param {"turn-detected"|"swap"} reason - which stage raised the hold, for the log only */
function orientHoldBegin(reason) {
  /* Before the re-freeze guard, so _orientHoldActive is never set while disabled - which
     matters beyond the overlay: reconditionForTopology() declines while a turn hold is up,
     and a hold that can never be raised must not be able to suppress a re-drape either. */
  if (!UI_HOLD_OVERLAYS_ENABLED) return;
  if (_orientHoldActive) return;        // NEVER re-freeze: a second snapshot this far into
                                        // the turn would capture the degraded frame we are
                                        // holding precisely to hide.
  _orientHoldActive = true;
  orientFadeFreeze();
  if (_orientHoldTimer) clearTimeout(_orientHoldTimer);
  _orientHoldTimer = setTimeout(() => {
    console.warn("[PEAR] AI Auto - turn hold hit its", ORIENT_TURN_HOLD_MAX_MS + "ms ceiling; revealing the live feed");
    orientHoldEnd("timeout");
  }, ORIENT_TURN_HOLD_MAX_MS);
  if (ORIENT_DEBUG) console.log("[PEAR] AI Auto - holding last dressed frame (" + reason + ")");
}

function orientHoldEnd(reason) {
  if (_orientHoldTimer) { clearTimeout(_orientHoldTimer); _orientHoldTimer = null; }
  if (!_orientHoldActive) return;
  _orientHoldActive = false;
  orientFadeReveal();
  if (ORIENT_DEBUG) console.log("[PEAR] AI Auto - releasing hold (" + reason + ")");
}

function createOrientationWatcher() {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return null;                       // no camera yet - sync will retry later

  /* ── Explicit, immutable per-session asset mapping (zero ambiguity) ───────────
     Resolved ONCE here, when this watcher arms for this session - NOT re-derived from
     galleryOf(activeItem) on every vote/swap. A mid-rotation mutation of activeItem
     (color swap, item swap) can no longer shift what "front"/"back" mean partway
     through a turn; this watcher instance always maps to the exact two assets it
     started with. Every reference this watcher ever hands to rtClient.set() comes
     from ONE of these two constants - GARMENT_BACK is never routed to FRONT_MODE's
     payload and GARMENT_FRONT is never routed to BACK_MODE's, by construction (see
     maybeSwap below). GARMENT_BACK is undefined when there's no real, distinct back
     photo - single-view items always hit this case, and maybeSwap's own
     `currentAngle !== AUTO_ANGLE` guard is what keeps the front/back half of this
     watcher inert for them, not the absence of GARMENT_BACK itself (see
     syncOrientationWatcher()'s dualView/singleView split). */
  const gInit = galleryOf(activeItem);
  const GARMENT_FRONT = gInit.front || activeItem.img;
  /* distinctBackOf() - never a raw string compare. Two URL spellings of the SAME
     photo must not qualify here: binding the front photo as GARMENT_BACK is what put
     the chest print on the back (see canonicalImageUrl's comment). */
  const GARMENT_BACK  = distinctBackOf(activeItem, gInit);
  /* Fresh instance, fresh reading - a stale EDGE-ON from whatever item/session this
     watcher's predecessor last saw must never carry into this one. profileActive() trusts
     `!!orientWatcher` as proof the CURRENT watcher produced `autoProfile`'s current value;
     that proof is only good if every new instance starts from a clean false.

     autoOrientation gets the same treatment, and for the first time here rather than only
     at the call sites that used to be the sole entry points into AUTO_ANGLE
     (renderPerspectiveSelector()'s `!wasAuto` branch, setAngle(), goLive()'s mode-settling
     block). Those all reset it on a MODE transition; none of them fire on a same-tier item
     swap - dual-view garment A to dual-view garment B, say - because currentAngle stays
     AUTO_ANGLE throughout and `wasAuto` is already true. That used to be harmless because
     the OLD watcher instance (with garment A's stale GARMENT_FRONT/BACK) just kept running
     unrecreated across the swap - itself a latent bug, now fixed by orientWatcherItem
     forcing a rebuild on every item change. Without this reset, THAT rebuild would hand
     garment B's brand new watcher a stale "confirmed BACK" lock left over from garment A,
     skipping the acquire phase and reading needsSwitch/confirmed off a side nobody has
     actually classified yet for the item now on screen. */
  autoOrientation = null;
  autoProfile = false;

  // Private sampler onto the SAME track the preview uses - reading is free, and we never
  // stop the track itself (it belongs to the shared preview camera).
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = ORIENT_SIZE; canvas.height = ORIENT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /* Separate, LARGER canvas for face detection. The 96px analysis canvas is right for
     the skin-ratio histogram (it is a per-pixel loop and wants to stay cheap) but is
     marginal for FaceDetector: at typical webcam framing the head occupies well under
     a third of the frame, so on a 96px canvas the face is ~20-25px - around the point
     where detectors start missing it. Every one of those misses used to become a
     full-confidence "BACK" vote. Face detection runs on this one instead; the skin
     histogram keeps the small one. */
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = ORIENT_FACE_SIZE; faceCanvas.height = ORIENT_FACE_SIZE;
  const faceCtx = faceCanvas.getContext("2d", { willReadFrequently: true });

  const faceDetector = typeof FaceDetector !== "undefined"
    ? (() => { try { return new FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (_) { return null; } })()
    : null;
  let fdBroken = false;
  let lastSkinRatio = null;        // surfaced in the ORIENT_DEBUG log line only
  let lastConfidence = 0;          // 0..1, surfaced in the ORIENT_DEBUG log line only
  /* Per-tick edge-on SCORE (0..1), set by classify(). NOT a third vote value: it is
     reported alongside the front/back vote on a separate channel, so it can never enter
     the streak/lock arithmetic that decides which garment asset is on the wire. */
  let lastProfileScore = 0;
  let lastNarrow = null;           // signed foreshortening evidence, surfaced in the debug line
  /* The shopper's own square-on silhouette width, learned from frames the LOCK has already
     confidently called front or back. Everything the width channel says is relative to
     this, because an absolute width conflates pose with distance from the lens, build and
     field of view. An EMA rather than a max: a max would ratchet up on one noisy frame and
     never come back down, permanently biasing every later comparison toward "narrow". */
  let baselineWidth = 0, baselineSamples = 0;
  console.log("[PEAR] AI Auto - orientation watcher armed (engine:",
    faceDetector ? "FaceDetector)" : "skin-ratio heuristic)",
    "| GARMENT_FRONT:", abbrevImg(GARMENT_FRONT), "| GARMENT_BACK:", GARMENT_BACK ? abbrevImg(GARMENT_BACK) : "(none)");

  /* The lock's state as the explicit enum, via the shared vtonState() resolver so
     PENDING/FRONT/BACK is reported from exactly one place. While PENDING the applied
     asset is GARMENT_FRONT (effectiveAngle() resolves null → "front"), but it is
     labelled provisional so a log reader can tell an unacquired state from a
     confirmed front - the distinction this whole three-state model exists for. */
  function logVtonState() {
    const state = vtonState();
    const asset = autoOrientation === "back" ? "GARMENT_BACK" : "GARMENT_FRONT";
    console.log(`[VTON Pipeline] Current Active State: ${state} | Applied Asset: ${asset}` +
      (state === PENDING_MODE ? " (provisional - awaiting first orientation sample)" : ""));
  }
  /* Initial state is PENDING, not FRONT: both assets are already fetched, decoded and
     validated (preloadGarmentAssets() gates go-live on it), so the watcher can apply
     either side the moment it has a reading - no front-biased warm-up. */
  logVtonState();

  let lastVote = null, streak = 0, streakSince = 0, sampling = false, applying = false, lastSwapAt = 0, disposed = false;
  /* Edge-on axis - its own rolling buffer, exit streak and cooldown, sharing only the
     `applying` mutex so a pose update and an asset swap can never be in flight at once.
     profileBuf holds the last ORIENT_PROFILE_WINDOW per-frame scores; squareStreak counts
     consecutive samples that look square-on, and is what the exit threshold reads. */
  let profileBuf = [], squareStreak = 0, strongStreak = 0, lastProfileAt = 0, lastReanchorAt = 0;

  /* Numeric confidence (0..1) for a skin-ratio vote: 0 right AT the classification
     threshold, saturating to 1 by double the threshold's margin into "obviously this
     side" territory. Gated against ORIENT_CONFIDENCE_MIN below so a read that JUST
     barely crossed the line doesn't count as confident - only the original dead-band
     used to do that; this makes the bar explicit and tunable. FaceDetector has no
     numeric confidence in the Shape Detection API spec - a positive/negative
     detection is treated as a fixed 1.0, which is what "the browser found a face at
     all in fastMode" already implies. */
  function skinConfidence(ratio, vote) {
    if (vote === "front") return Math.min(1, (ratio - 0.10) / 0.10);   // saturates by ratio=0.20
    if (vote === "back")  return Math.min(1, (0.04 - ratio) / 0.04);   // saturates by ratio=0
    return 0;
  }

  /* ── Lighting-invariant skin corroboration (YCbCr chroma) ────────────────────
     The RGB rule in skinRatioVote() is the classic Kovac test, and it is kept EXACTLY as
     it is: the 0.10/0.04 vote thresholds and the confidence ramp above are tuned against
     its output, and re-basing them on a different metric would re-open the front/back
     misdetection this watcher has already been through once. What it is not, though, is
     illumination-invariant - `r > 95 && g > 40 && b > 20` fails outright in a dim or
     strongly warm-lit room, and `max-min > 15` fails on a low-contrast one, both of which
     make real skin read as zero.

     Chroma tells a different story. Converting to YCbCr and testing Cb/Cr alone discards
     luminance entirely, so it holds up across exposure, and the skin locus in Cb/Cr is
     famously narrow and stable ACROSS skin tones - melanin moves Y far more than it moves
     chroma. Used here for two things only, never to override the vote:
       · the profile channel, where it is the lighting-robust half of "is the skin read
         ambiguous?";
       · a disagreement guard, where RGB reporting near-zero skin while chroma reports
         plenty means the lighting broke the RGB rule - which would otherwise have been
         cast as a confident BACK vote. */
  function chromaSkinRatio(px, x0, y0, w, h) {
    let skin = 0, n = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * ORIENT_SIZE + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) skin++;
        n++;
      }
    }
    return n ? skin / n : 0;
  }

  /* ── Silhouette width - the foreshortening signal ────────────────────────────
     WHY THIS EXISTS. Skin ratio answers "can I see a face?", which is a proxy for
     orientation and a weak one: it says nothing at all about the body, and it is exactly
     the measurement that harsh lighting ruins. Turning 90 degrees does something to the
     shopper that no lighting condition imitates - their silhouette NARROWS, because
     shoulder breadth (~40cm) is replaced by torso depth (~25cm) as the horizontal extent.
     That is a geometric fact about the pose, independent of colour, exposure and skin
     tone, which is precisely the axis the skin metric is blind to.

     HOW, with no segmentation model available. Sample the background from the outer
     columns of the torso band, then count per column how many rows differ from it. A
     column with enough differing rows is subject; the span between the first and last
     such column is the silhouette width.

     WHAT IT REFUSES TO ANSWER, which matters as much as what it measures. The method
     assumes a reasonably uniform backdrop, so it abstains (null) rather than guessing
     when: the background sample is itself high-variance (a cluttered room - everything
     "differs", so the span would be meaningless), the span fills nearly the whole frame
     (subject too close, or the abstain case above leaking through), or the span is
     vanishingly small (nobody in frame). Abstaining costs only the extra evidence; the
     skin channel still works on its own, exactly as it did before this existed. */
  function torsoWidth(px) {
    const y0 = Math.round(ORIENT_SIZE * 0.45), y1 = Math.round(ORIENT_SIZE * 0.85);
    const bandH = y1 - y0;
    const edge = 4;                                   // outer columns taken as background

    // Background reference + its variance, from the left and right margins of the band.
    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let y = y0; y < y1; y++) {
      for (let k = 0; k < edge; k++) {
        for (const x of [k, ORIENT_SIZE - 1 - k]) {
          const i = (y * ORIENT_SIZE + x) * 4;
          br += px[i]; bg += px[i + 1]; bb += px[i + 2]; bn++;
        }
      }
    }
    if (!bn) return null;
    br /= bn; bg /= bn; bb /= bn;
    let variance = 0;
    for (let y = y0; y < y1; y++) {
      for (let k = 0; k < edge; k++) {
        for (const x of [k, ORIENT_SIZE - 1 - k]) {
          const i = (y * ORIENT_SIZE + x) * 4;
          variance += Math.abs(px[i] - br) + Math.abs(px[i + 1] - bg) + Math.abs(px[i + 2] - bb);
        }
      }
    }
    variance /= bn;
    // A busy backdrop makes "differs from background" meaningless - say so instead of
    // returning a number that would read as a full-width subject.
    if (variance > 60) return null;

    // Threshold scales with the backdrop's own noise, so a slightly textured wall does not
    // register as subject while a genuinely uniform one stays sensitive.
    const thresh = Math.max(45, variance * 2.5);
    let first = -1, last = -1;
    for (let x = 0; x < ORIENT_SIZE; x++) {
      let hits = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * ORIENT_SIZE + x) * 4;
        if (Math.abs(px[i] - br) + Math.abs(px[i + 1] - bg) + Math.abs(px[i + 2] - bb) > thresh) hits++;
      }
      if (hits >= bandH * 0.25) { if (first === -1) first = x; last = x; }
    }
    if (first === -1) return null;
    const width = (last - first + 1) / ORIENT_SIZE;
    if (width >= 0.92 || width <= 0.08) return null;     // implausible - see the comment above
    return width;
  }

  /* Signed foreshortening evidence in [-1, 1] from the width measurement, or null when
     torsoWidth() abstained or no baseline has been established yet.
       +1  fully foreshortened (a square-on width collapsed to ORIENT_NARROW_FLOOR)
        0  right at ORIENT_NARROW_RATIO - the boundary, no evidence either way
       -1  at or above the shopper's own square-on baseline - positive evidence AGAINST
           edge-on, which is what vetoes a lighting-induced false positive.
     The negative half is the half that earns its keep: a dim room makes the skin read
     ambiguous while the shopper stands squarely facing the camera, and without this the
     ambiguity alone used to be enough to assert profile. */
  function narrowness(width) {
    if (width === null || baselineSamples < ORIENT_BASELINE_MIN || !baselineWidth) return null;
    const ratio = width / baselineWidth;
    if (ratio <= ORIENT_NARROW_RATIO) {
      const span = ORIENT_NARROW_RATIO - ORIENT_NARROW_FLOOR;
      return Math.min(1, (ORIENT_NARROW_RATIO - ratio) / span);
    }
    return Math.max(-1, (ORIENT_NARROW_RATIO - ratio) / (1 - ORIENT_NARROW_RATIO));
  }

  /* ── Evidence fusion → a single 0..1 edge-on score for this frame ────────────
     Additive weights, because the signals are independent and individually weak; the
     whole point of fusing them is that a real profile pose trips several at once while
     each one alone trips regularly for boring reasons (bad light, a missed detection, a
     shopper standing off-centre).

       face detected            hard 0   - a frontal face is proof they are not edge-on,
                                           and no combination of the others may override it
       skin read ambiguous       +0.55   - the original signal, still the strongest single one
       detector armed, no face   +0.20   - weak alone: this is also what every ordinary
                                           detection failure looks like
       silhouette narrowed    up to +0.45
       silhouette at baseline down to -0.35  ← the veto that makes this worth doing

     Calibration against ORIENT_PROFILE_ENTER_SCORE (0.55) is deliberate:
       · ambiguous skin alone (0.55) still passes when the width channel abstains, so a
         cluttered-room session degrades exactly to the previous behaviour rather than
         losing the feature;
       · ambiguous skin in a dim room WITH a normal-width silhouette lands at ~0.47 and is
         correctly rejected - the jitter case this hardening pass exists for;
       · a genuine 90° turn trips ambiguity AND narrowing together and saturates. */
  function profileScore(faceSeen, faceMissed, skinAmbiguous, n) {
    if (faceSeen) return 0;
    let score = skinAmbiguous ? 0.55 : 0;
    if (faceMissed) score += 0.20;
    if (n !== null) score += n > 0 ? 0.45 * n : 0.35 * n;   // n<0 subtracts - the veto
    return Math.max(0, Math.min(1, score));
  }

  /* One vote: "front" | "back" | null (abstain - includes a read that crossed the raw
     threshold but didn't clear ORIENT_CONFIDENCE_MIN).

     THE MISDETECTION FIX - the two directions are NOT equally reliable, and this used
     to treat them as if they were ("detected ⇒ front, not detected ⇒ back, no
     second-guessing"). A face DETECTED is strong evidence: false positives on hair or
     a shoulder are rare. A face NOT detected is weak evidence, because it is the
     outcome of every ordinary failure too - dim room, backlight, user stands too far
     back, motion blur while turning, a hand across the face, a steep head tilt. The
     old code scored that absence at confidence 1.0.

     The earlier comment argued the hysteresis downstream absorbs a stray misread,
     which is true for RANDOM noise - but these failures are SYSTEMATIC. In a poorly
     lit room FaceDetector misses on every single frame, so the streak does not cancel
     out; it accumulates, clears ORIENT_LOCK_FRAMES, and confirms a BACK flip while the
     shopper is still facing the camera. That is the reported misidentification, and no
     amount of hysteresis can fix a biased signal.

     So a face-absent vote is now CORROBORATED against the skin histogram before it
     counts. A genuine back-of-head shows hair, fabric and neck - little skin in the
     head band. A missed face still shows a face's worth of skin. When the two signals
     disagree the tick ABSTAINS (null), which neither flips the state nor resets the
     streak - the watcher simply waits for an unambiguous frame. A face-PRESENT vote is
     still taken at face value: it is the direction that doesn't need a second opinion. */
  /* THE EDGE-ON READING - two channels out of one function.

     classify() returns the front/back VOTE, whose contract is unchanged: it drives the
     hysteresis-protected lock that decides which garment reference is on the wire, and
     nothing about profile may influence it. Alongside it, and on a strictly separate
     channel, it publishes lastProfileScore - the fused 0..1 evidence that the shopper is
     edge-on, which drives only what the PROMPT asserts about their pose.

     The original signal was the vote's own ambiguity: at a true 90-degree turn a
     frontal-trained FaceDetector stops finding a face and the head band shows one cheek's
     worth of skin - neither a face (>=10%) nor the back of a head (<=4%). That dead band
     is what being side-on looks like to this pipeline, and it was previously discarded.

     Ambiguity alone, though, is not specific: a dim room, a backlit shopper or a low-
     contrast frame produce the same abstention while the shopper stands squarely facing
     the camera, and acting on it there is what made the pose toggle. So the score fuses
     that signal with two others chosen because they fail in DIFFERENT conditions -
     chroma-based skin (illumination-invariant, see chromaSkinRatio) and silhouette width
     (geometric, colour-blind, see torsoWidth). profileScore() states the weights and the
     calibration; the short version is that a real turn trips several at once, while each
     one alone trips regularly for boring reasons, and a normal-width silhouette actively
     VETOES a lighting-induced false positive.

     Cost is still ONE getImageData per tick, now over the whole 96px canvas instead of
     just the head band, plus two small per-pixel passes - ~21µs measured, against a 250ms
     sampling interval, on the watcher's own timer rather than the render path. */
  async function classify() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.max(ORIENT_SIZE / vw, ORIENT_SIZE / vh);   // cover-fit center crop
    ctx.drawImage(video, (ORIENT_SIZE - vw * s) / 2, (ORIENT_SIZE - vh * s) / 2, vw * s, vh * s);

    /* ONE readback for the whole tick, sliced by the metrics below rather than each
       pulling its own region. getImageData is a GPU→CPU sync, so the per-CALL overhead
       dominates the per-pixel cost at these sizes: this reads more pixels than the old
       head-band-only call (96×96 vs 96×43) but still makes exactly one of them, where the
       obvious alternative - leaving skinRatioVote() to fetch its band and giving
       torsoWidth() its own - would have made two. Measured cost of the added pixel work is
       ~21µs against a 250ms sampling interval, and none of it is on the render path. */
    const px = ctx.getImageData(0, 0, ORIENT_SIZE, ORIENT_SIZE).data;
    const width = torsoWidth(px);          // measured once per tick, reused for the baseline below
    const n = narrowness(width);
    lastNarrow = n;

    let vote, faceSeen = false, faceMissed = false;
    if (faceDetector && !fdBroken) {
      try {
        const fs = Math.max(ORIENT_FACE_SIZE / vw, ORIENT_FACE_SIZE / vh);
        faceCtx.drawImage(video, (ORIENT_FACE_SIZE - vw * fs) / 2, (ORIENT_FACE_SIZE - vh * fs) / 2, vw * fs, vh * fs);
        const faces = await faceDetector.detect(faceCanvas);
        if (faces.length > 0) {
          lastConfidence = 1;               // binary API - no partial score to report
          lastSkinRatio = null;
          faceSeen = true;
          vote = "front";
        } else {
          faceMissed = true;
          /* No face. Corroborate before calling it a back. skinRatioVote() populates
             lastSkinRatio/lastConfidence, so the debug line shows both engines. */
          const corroboration = skinRatioVote(px);
          // Both engines agree: squarely turned away, not mid-turn.
          if (corroboration === "back") vote = "back";
          else {
            // Skin says "there is a face here" (or is ambiguous) while the detector found
            // none - the likeliest reading is a MISSED face, not a turned back. Abstain.
            // Still right for the LOCK; the profile channel reads the same ambiguity below.
            lastConfidence = 0;
            vote = null;
          }
        }
      } catch (_) {
        fdBroken = true;
        console.log("[PEAR] AI Auto - FaceDetector unavailable at runtime; using skin-ratio heuristic");
        vote = skinRatioVote(px);
      }
    } else {
      vote = skinRatioVote(px);
    }

    /* Ambiguity is defined by the VOTE being withheld, which is exactly what the dead band
       and the sub-confidence band produce - the signal that used to be discarded. A face
       seen or a confident side both resolve it, so neither counts as ambiguous. */
    const skinAmbiguous = !faceSeen && vote === null;
    lastProfileScore = profileScore(faceSeen, faceMissed, skinAmbiguous, n);

    /* Learn the square-on baseline ONLY from frames the lock confidently resolved, and
       only when the width channel produced a real measurement. Using every frame would
       fold profile frames into the baseline and slowly erase the very difference being
       measured. EMA at 0.2 so a genuine change of position converges in about a second
       while a single bad frame moves it barely at all. */
    if (vote && !skinAmbiguous && width !== null) {
      baselineWidth = baselineWidth ? baselineWidth * 0.8 + width * 0.2 : width;
      baselineSamples++;
    }
    return vote;
  }

  /* Skin-tone share of the head band. Classic RGB skin rule - coarse, but the dual
     thresholds + confidence gate + lock absorb its noise. */
  function skinRatioVote(px) {
    const x0 = Math.round(ORIENT_SIZE * 0.25), w = Math.round(ORIENT_SIZE * 0.5);
    const h = Math.round(ORIENT_SIZE * 0.45);
    let skin = 0, total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * ORIENT_SIZE + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b) skin++;
        total++;
      }
    }
    const ratio = skin / total;
    lastSkinRatio = ratio;
    let vote = ratio >= 0.10 ? "front" : ratio <= 0.04 ? "back" : null;

    /* THE LIGHTING GUARD. A "back" here means the RGB rule found essentially no skin - but
       that is also precisely what a dim or strongly warm-lit room does to this rule, and a
       confident BACK vote is expensive: it swaps the garment reference. Before letting it
       through, check the illumination-invariant chroma metric over the same band. If
       chroma sees a face's worth of skin where RGB saw none, the disagreement is evidence
       the RGB rule broke rather than that the shopper turned around, so the tick abstains -
       the same conservative resolution the FaceDetector path already applies to its own
       weak direction. Never used to CREATE or flip a vote; only to withhold one. */
    if (vote === "back" && chromaSkinRatio(px, x0, 0, w, h) >= 0.12) {
      lastConfidence = 0;
      return null;
    }

    /* The dead band. Between "clearly a face" and "clearly the back of a head" is what one
       visible cheek looks like - i.e. a shopper in profile. It abstains from the front/back
       VOTE, unchanged; the profile channel in classify() reads that abstention. */
    if (!vote) { lastConfidence = 0; return null; }
    lastConfidence = skinConfidence(ratio, vote);
    // Crossed a threshold but not confidently - a rotation is likely underway. Abstain.
    if (lastConfidence < ORIENT_CONFIDENCE_MIN) return null;
    return vote;
  }

  /* Confirmed flip → cross-fade + hot-swap the live reference, using ONLY the frozen
     GARMENT_FRONT/GARMENT_BACK captured above - never a value re-derived elsewhere.
     The sampler keeps voting during the swap, so a turn completed mid-flight is
     re-confirmed and applied by a later tick - no queue needed. */
  async function maybeSwap(next) {
    if (applying || Date.now() - lastSwapAt < ORIENT_COOLDOWN_MS) return;
    if (disposed || !isLive() || currentAngle !== AUTO_ANGLE) return;

    /* ACQUIRING the side that is ALREADY on the wire is a state record, not a swap.
       PENDING renders the front (effectiveAngle() resolves null → "front") and
       applyActive() already sent that reference at connect, so the common case - the
       shopper is facing the camera when the session opens - would otherwise spend a
       redundant rtClient.set() and cross-fade the view for zero visual change, right
       at go-live. Record the lock and return. */
    if (autoOrientation === null && next === "front") {
      autoOrientation = "front";
      console.log("[PEAR] AI Auto - orientation ACQUIRED → FRONT (already rendered; no swap issued)");
      logVtonState();
      renderPerspectiveSelector();
      return;
    }

    /* Fallback guard: verify GARMENT_BACK is fully loaded AND valid BEFORE committing
       the flip - never switch to BACK_MODE (or wipe the current overlay) on a missing
       or broken asset; FRONT_MODE simply stays active. Swapping first and discovering
       the Blob is missing afterwards is what produced a blank back: the prompt would
       already be steering "render the BACK" while the model still held the front
       reference. garmentBlobCached() retries internally through the proxy AND the
       raw CDN, so reaching null here means every route failed. */
    /* An unusable back during ACQUISITION settles the lock to FRONT rather than
       leaving it PENDING. Without this the session would stay unresolved forever:
       every tick re-confirms "back", every attempt fails on the same broken asset,
       and the shopper gets a toast every cooldown. Front-only is the documented
       graceful degradation - make it the confirmed state and stop re-litigating it. */
    const settleFrontOnBackFailure = () => {
      lastSwapAt = Date.now();            // throttle repeat toasts while turned away
      if (autoOrientation === null) {
        autoOrientation = "front";
        logVtonState();
        renderPerspectiveSelector();
      }
    };

    if (next === "back") {
      if (!GARMENT_BACK) {
        console.error("[PEAR] CRITICAL: no GARMENT_BACK asset for this item; holding FRONT_MODE");
        settleFrontOnBackFailure();
        return;
      }
      const backBlob = await garmentBlobCached(GARMENT_BACK);
      /* THE SUPERSEDED-INSTANCE GUARD, first of three in this function. stop() can land
         while any of this function's awaits is in flight - syncOrientationWatcher() now
         tears down and rebuilds on every item swap (see orientWatcherItem), not just on a
         mode change, so a swap arriving mid-turn is a routine event, not a rare one.
         `disposed`, `autoOrientation`, `GARMENT_BACK` and the hold are ALL either
         per-instance or shared module state that a fresh watcher may already be relying
         on by the time this stale continuation resumes; touching any of it here would be
         exactly the "late callback from a superseded session" class of bug this file
         already guards against elsewhere (see reconnect.test.mjs). Re-checked after EVERY
         await in this function, not just the last one. */
      if (disposed) return;
      if (!backBlob) {
        console.error("[PEAR] CRITICAL: GARMENT_BACK unavailable at flip time; holding FRONT_MODE -", GARMENT_BACK);
        settleFrontOnBackFailure();
        toast("תמונת הגב אינה זמינה");
        return;                           // keep showing the front instead of a blank/failed swap
      }
      // Content check: a Blob can fetch/decode fine and still be a broken-image/
      // gray placeholder graphic (bad classification, a soft-404 from the CDN) - that
      // reaches the live session as a real image with no garment texture in it,
      // which reads to the shopper as "the back view is blank". Reject it the same
      // way as a failed fetch, so we never commit to showing a solid-fill panel.
      let backLooksFlat = false;
      try {
        const probe = await createImageBitmap(backBlob);
        backLooksFlat = await bitmapLooksFlat(probe);
        probe.close?.();
      } catch (_) { /* probe failure - fail open, let the already-validated Blob through */ }
      if (disposed) return;               // same guard, after the decode/probe awaits
      if (backLooksFlat) {
        console.error("[PEAR] CRITICAL: GARMENT_BACK decoded but looks like a blank/solid-color placeholder (no garment texture); holding FRONT_MODE -", GARMENT_BACK);
        _assetBlobCache.delete(GARMENT_BACK);   // don't keep serving this bad asset from cache
        settleFrontOnBackFailure();
        toast("תמונת הגב אינה תקינה");
        return;
      }
    }

    applying = true;
    lastSwapAt = Date.now();
    autoOrientation = next;
    logVtonState();
    /* No-ops when the sampler already raised the hold on the first disagreeing vote,
       which is the normal path - re-freezing here would replace the good dressed frame
       we are holding with a mid-turn one. Still called because a flip can also arrive
       without a preceding turn-detected tick (a swap forced by other state). */
    orientHoldBegin("swap");
    console.log("[PEAR] AI Auto - orientation flip →", next.toUpperCase(),
      "| reference:", abbrevImg(next === "back" ? GARMENT_BACK : GARMENT_FRONT));
    renderPerspectiveSelector();
    try {
      await applyActive();                       // one rtClient.set() - pre-cached Blob payload
      await new Promise((r) => setTimeout(r, ORIENT_FADE_HOLD_MS));   // let the new frame actually land
      // Third instance of the superseded-instance guard (see the comment above the first
      // one). orientHoldEnd/toast are exactly the shared state a fresh watcher's own hold
      // lifecycle now owns if this instance was torn down mid-await - stop() has already
      // released whatever hold IT was responsible for; this stale continuation must not
      // release whatever the NEW one has since raised.
      if (disposed) return;
      orientHoldEnd("swap-complete");
      toast(next === "back" ? "מציג גב · Back view" : "מציג חזית · Front view");
    } catch (e) {
      console.warn("[PEAR] AI Auto swap apply:", e?.message || e);
      if (!disposed) orientHoldEnd("swap-failed");   // never leave the frozen overlay stuck up on
                                                      // failure - but only if THIS instance still owns it
    } finally {
      applying = false;
    }
  }

  /* The edge-on counterpart of maybeSwap(), and far simpler than it for one structural
     reason: the reference image does not change. There is no back Blob to fetch, no
     flat-placeholder probe, no cross-fade overlay to freeze and no toast - and therefore
     no path by which this can leave the session displaying the wrong ASSET. It re-issues
     the payload, applyGarment() sees the reference is unchanged and takes the setPrompt()
     fast path (one small control message, no image bytes on the datachannel - see that
     function's flicker-fix comment), and the model gets a truthful pose plus the
     depth-fidelity clause. That is why this can afford a ~500ms trigger where an asset
     swap needs seconds of corroboration.

     That guarantee is about the ASSET, not the PIXELS, and used to overstate itself here -
     it does not cover the window before this function's own ENTER threshold fires. Until
     then Lucy is still regenerating a foreshortened, mid-turn frame against a prompt that
     has not caught up, which is the exact condition under which it reverts to the
     shopper's real shirt (see ROTATION_CONTINUITY's comment). The sampler tick now raises
     the SAME cross-fade hold used for a front/back flip the instant `score` clears
     ORIENT_PROFILE_EXIT_SCORE - see "profile-turn-detected" in the timer callback below -
     so that window is covered by the hold rather than by prompt text alone. */
  async function maybeUpdateProfile(score) {
    profileBuf.push(score);
    if (profileBuf.length > ORIENT_PROFILE_WINDOW) profileBuf.shift();
    const mean = profileBuf.reduce((a, b) => a + b, 0) / profileBuf.length;
    // "Square-on" for the EXIT test is the absence of meaningful evidence, not merely a
    // score below the enter threshold - otherwise the two thresholds would sit on top of
    // each other and the shopper would oscillate across the single boundary between them.
    squareStreak = score <= ORIENT_PROFILE_EXIT_SCORE ? squareStreak + 1 : 0;
    strongStreak = score >= ORIENT_PROFILE_FAST_SCORE ? strongStreak + 1 : 0;

    /* ASYMMETRIC BY DESIGN, and the two directions read different statistics.

       ENTER on the windowed MEAN: entering is the decision that must not be made on one
       noisy frame, and averaging is what stops a shopper parked near the threshold angle
       from toggling the pose every 250ms.

       LEAVE on a CONSECUTIVE run of square-on samples: the mean is deliberately slow to
       fall (an old high score lingers in the window for over a second), which would keep
       asserting "side-on" well after the shopper came back around - the same class of
       false pose assertion, pointing the other way. A short consecutive run answers "are
       they square-on NOW?" without waiting for history to decay out. */
    const next = autoProfile
      ? !(squareStreak >= ORIENT_PROFILE_EXIT)
      : (strongStreak >= ORIENT_PROFILE_FAST_FRAMES ||
         (profileBuf.length >= ORIENT_PROFILE_ENTER && mean >= ORIENT_PROFILE_ENTER_SCORE));
    if (next === autoProfile) return;
    if (applying || Date.now() - lastProfileAt < ORIENT_PROFILE_COOLDOWN_MS) return;
    /* ── THE GO-LIVE RACE, closed here ────────────────────────────────────────
       This watcher is armed by goLive() BEFORE goLive() issues its own first
       applyActive(), and this function is guarded on `applying` (a closure local, invisible
       to every other send site), a cooldown, `disposed` and isLive() - but NOT on
       isGarmentApplied. A shopper who is already edge-on when they press go-live therefore
       trips a pose transition inside ~500ms and fires an applyActive() ON TOP of the one
       goLive() is still awaiting: two set() calls in flight on a transport that is still
       settling, which is the reported "rtClient.set לא הגיב" timeout.
       wireBusy() is the cross-site half of the mutex `applying` could never provide. The
       pose axis is re-evaluated every ORIENT_SAMPLE_MS, so a skipped transition costs one
       sample; autoProfile is deliberately NOT advanced below, so the transition is still
       pending and the next tick offers it again. */
    if (wireBusy()) {
      console.log("[PEAR] AI Auto - pose transition deferred: a conditioning write is in flight");
      return;
    }
    /* No `currentAngle !== AUTO_ANGLE` bail here (unlike maybeSwap) - this axis runs for
       single-view items too now (see syncOrientationWatcher()'s dualView/singleView
       split), where currentAngle never becomes AUTO_ANGLE at all. disposed/isLive() are
       the only preconditions that still apply regardless of which tier armed this
       watcher. */
    if (disposed || !isLive()) return;

    applying = true;                    // shared with maybeSwap - one in-flight apply at a time
    lastProfileAt = Date.now();
    // Also counts as a fresh re-anchor - this update IS the prompt landing with the
    // current pose baked in, so maybeReanchorPrompt() firing again immediately
    // afterward in this same tick would be pure redundancy (same argument as skipping
    // it opposite a pending dual-view swap - see the tick's own comment).
    lastReanchorAt = Date.now();
    autoProfile = next;                 // set BEFORE applying, so the snapshot below reads it
    /* THE OLD LOG LINE CLAIMED A DISPATCH THAT NO LONGER HAPPENS - it read "depth-fidelity
       clause ENGAGED (prompt-only, reference unchanged)". Under strict image-only
       conditioning there is no depth-fidelity CLAUSE to engage: its instruction lives
       inside the frozen string and is on the wire at every pose, so applyActive() below
       finds nothing changed and correctly sends nothing. Saying otherwise in the console
       is how the 90-degree freeze survived diagnosis for as long as it did - the log
       described a transition that looked like it explained the stall. This axis is now
       tracked purely so profileActive() can report it; the prompt does not move. */
    console.log(`[PEAR] AI Auto - pose ${next ? "EDGE-ON (side profile)" : "SQUARE-ON"}` +
      " | tracking only - the frozen prompt already states body conformity at all angles," +
      " so no dispatch is expected here");
    try {
      await applyActive();
    } catch (e) {
      console.warn("[PEAR] AI Auto profile prompt update:", e?.message || e);
    } finally {
      applying = false;
    }
  }

  /* THE STEADY-STATE COUNTERPART of maybeUpdateProfile()/maybeSwap() - see REANCHOR_MS's
     comment for the mechanism this exists to counter.

     Deliberately a SEPARATE function rather than folded into maybeUpdateProfile(): that
     one's very first line is `if (next === autoProfile) return;` - it only ever acts on
     a CHANGE, by design (re-deriving `next` and re-running that check here would just
     reimplement the same guard badly). This one is the exact opposite: it only ever acts
     when NOTHING has changed and the shopper has simply held whatever pose they are in
     long enough to be worth re-steering again. Between them, every path that could
     re-assert the prompt is covered: transitions by those two, steady state by this.

     They share `lastReanchorAt`'s clock - a transition maybeUpdateProfile() just sent IS
     a fresh anchor, so it stamps this same timestamp rather than leaving this function to
     re-send an identical prompt a moment later. */
  async function maybeReanchorPrompt() {
    if (applying) return;                        // a swap or transition update owns the wire
    /* ...and the same question asked ACROSS send sites, which `applying` cannot see: the
       presence re-condition, the topology re-drape and goLive's own first apply all write
       to this wire without holding that closure flag. A re-anchor is the most skippable
       write in the file - it re-asserts an unchanged state on a cadence - so it never
       queues, it just waits for its next turn. */
    if (wireBusy()) return;
    if (Date.now() - lastReanchorAt < REANCHOR_MS) return;
    if (disposed || !isLive()) return;
    /* Nothing has been rendered yet - there is no steering to re-assert, and firing here
       would race the very first applyActive() that goLive() is still awaiting. */
    if (!isGarmentApplied) return;
    applying = true;
    lastReanchorAt = Date.now();
    try {
      await applyActive();
      /* Session-relative, because that is the only form that is actually useful for the
         diagnosis this keeps being needed for: billingStartedAt is stamped on the SAME
         first-dressed-frame event that starts the recorder, so t= here lines up 1:1 with
         the timestamp in a screen recording of the session. "Re-anchored at t=2400ms,
         reversion visible at t=2000ms in the clip" is a decidable statement; a wall-clock
         log line is not. */
      if (ORIENT_DEBUG) {
        console.log(`[PEAR] AI Auto - prompt re-anchor at t=${sessionElapsedMs()}ms` +
          ` | pose=${autoProfile ? "EDGE-ON" : "square-on"} | prompt-only, reference unchanged`);
      }
    } catch (e) {
      console.warn("[PEAR] AI Auto prompt re-anchor:", e?.message || e);
    } finally {
      applying = false;
    }
  }

  const timer = setInterval(async () => {
    if (disposed || sampling) return;
    sampling = true;
    try {
      const vote = await classify();
      if (vote) {
        if (vote === lastVote) streak++;
        else { lastVote = vote; streak = 1; streakSince = Date.now(); }
      }
      const held = lastVote ? Date.now() - streakSince : 0;
      /* Two DIFFERENT transitions, with deliberately different bars:

         ACQUIRING (autoOrientation === null, PENDING_MODE) - establishing the first
         reading of the session. There is no confirmed state to protect, so the full
         anti-flap threshold buys nothing and costs the shopper 2.5s of the wrong side
         rendered on their body. Two agreeing confident samples settle it.

         FLIPPING (a side is already locked) - un-doing a confirmed reading, which is
         exactly what the hysteresis exists for. Unchanged: ORIENT_LOCK_FRAMES
         consecutive agreeing votes OR ORIENT_LOCK_MS of sustained agreement.

         Note `acquiring` also makes needsSwitch true when the first vote happens to be
         "front": the lock still has to MOVE (null → "front") for the state to become
         confirmed, and that transition must be recorded rather than silently skipped. */
      const acquiring = autoOrientation === null;
      const needsSwitch = !!lastVote && (acquiring || lastVote !== autoOrientation);
      const confirmed = needsSwitch && (acquiring
        ? streak >= ORIENT_ACQUIRE_FRAMES
        : (streak >= ORIENT_LOCK_FRAMES || held >= ORIENT_LOCK_MS));

      if (ORIENT_DEBUG) {
        const confidence = faceDetector && !fdBroken
          ? `face:${vote ?? "none"}(${(lastConfidence * 100).toFixed(0)}%)`
          : `skin:${lastSkinRatio != null ? (lastSkinRatio * 100).toFixed(1) + "%" : "n/a"}(${(lastConfidence * 100).toFixed(0)}% conf)`;
        // Status reflects the LOCK, not the raw per-frame vote: "locked" covers both a
        // clean agreeing vote AND a disagreeing one that hasn't cleared the threshold
        // yet - i.e. exactly the case that used to flip the reference frame-by-frame.
        const status = confirmed ? (acquiring ? "ACQUIRING" : "SWITCHING")
          : needsSwitch ? (acquiring ? "waiting-to-acquire" : "waiting-to-switch") : "locked";
        // Progress is reported against whichever threshold actually applies, so the
        // debug line never shows a pending state counting toward a bar it isn't using.
        const progress = acquiring
          ? ` (${streak}/${ORIENT_ACQUIRE_FRAMES}f)`
          : ` (${streak}/${ORIENT_LOCK_FRAMES}f, ${held}/${ORIENT_LOCK_MS}ms)`;
        /* Pose is reported separately from the lock, because it IS separate - reading them
           on one line is what makes "locked FRONT, but edge-on right now" legible while
           tuning. ratio/score/width are the three numbers the thresholds are set from, so
           a live session can be diagnosed from the console without a debugger: `ratio` is
           the raw skin share, `score` the fused per-frame evidence against
           ORIENT_PROFILE_ENTER_SCORE, and `w` the silhouette width relative to this
           shopper's own square-on baseline (n/a until the baseline is learned, or when the
           backdrop is too busy to measure). */
        const mean = profileBuf.length
          ? profileBuf.reduce((a, b) => a + b, 0) / profileBuf.length : 0;
        const pose = `pose=${autoProfile ? "EDGE-ON" : "square-on"}` +
          ` | ratio=${lastSkinRatio != null ? (lastSkinRatio * 100).toFixed(1) + "%" : "n/a"}` +
          ` | score=${lastProfileScore.toFixed(2)}(avg ${mean.toFixed(2)}/${ORIENT_PROFILE_ENTER_SCORE})` +
          ` | w=${lastNarrow === null ? "n/a" : lastNarrow.toFixed(2)}`;
        console.log(`[PEAR][ORIENT] state=${vtonState()} | ${pose} | confidence=${confidence} | ${status}` +
          (needsSwitch ? progress : ""));
      }

      /* Raise the hold the INSTANT a turn looks like it is starting - one disagreeing
         vote against a locked side, OR early evidence the shopper is turning edge-on - so
         the frame we freeze is still a good dressed one. Waiting for `confirmed` (front/
         back) or the ENTER threshold (profile, ~500ms of corroboration by design - see
         ORIENT_PROFILE_ENTER's comment) is too late for the same reason either way.
         THE GAP THIS CLOSES: maybeUpdateProfile() never re-uploads the reference image, so
         the ASSET can never be wrong while turning edge-on - but that says nothing about
         the PIXELS in the meantime. Until its prompt update actually lands, Lucy is still
         regenerating a foreshortened, mid-turn person against a prompt that has not caught
         up - per ROTATION_CONTINUITY's own comment, the exact condition under which the
         most probable completion is the shopper's real shirt. SIDE_PROFILE_DEPTH is a
         probabilistic bias on that frame, not a guarantee (see COMPOSITE_TEMPORAL's
         comment) - this is the deterministic backstop the front/back axis already had and
         the profile axis never got when it was added.
         Excluded while ACQUIRING (dual-view) / before anything has ever been dressed
         (single-view): there is no confirmed side, or no rendered frame at all, to
         protect yet, and freezing the very first frames of a session would just stall
         the reveal.

         TWO TIERS, mirroring syncOrientationWatcher()'s split. `dualView` sessions have a
         front/back LOCK to protect, so frontBackTurn uses it exactly as before (`acquiring`
         is meaningless without a lock - autoOrientation never leaves PENDING for a
         single-view item, since maybeSwap() never runs for one). `holdReady` is the
         readiness gate for the profile axis specifically, and it needs its OWN readiness
         signal for single-view sessions, where there is no lock to be "acquiring": once
         the very first frame has ever been dressed (isGarmentApplied), a profile reading
         is worth protecting the same way a dual-view one is. */
      /* ╔════════════════════════════════════════════════════════════════════════╗
         ║  THE 90-DEGREE FREEZE. This block WAS the bug. Read before restoring.  ║
         ╚════════════════════════════════════════════════════════════════════════╝
         REPORTED: "the feed freezes for a second or two, but ONLY when I turn sideways,
         and ONLY live - the recording of the same session is smooth."

         That asymmetry is the whole diagnosis, and it rules out WebRTC entirely. The
         recorder's paint loop draws #aiVideo directly (see startRecording); the freeze
         was #orientFadeCanvas - an opaque still snapshot, z-index 6, pinned over #aiVideo
         inside #cameraCard - which the recorder cannot see. Live: frozen. Replay: smooth.
         Nothing was ever wrong with the stream.

         WHAT RAISED IT, and why it lasted so long. `enteringProfile` fired at
         lastProfileScore > ORIENT_PROFILE_EXIT_SCORE - the EXIT threshold, 0.25, which is
         deliberately low because its job is hysteresis on the way OUT. Used as an entry
         trigger it fires the instant a shopper starts to turn. Release then required
         autoProfile to actually flip, which needs ORIENT_PROFILE_ENTER samples at >= 0.55
         (~500ms at best), plus a tick to notice. So even a clean 90-degree turn froze the
         view for ~750ms - and a shopper who lingered anywhere between 0.25 and 0.55, which
         is most of a real rotation, held it raised until the 4s ceiling. That is the
         "1-2 second freeze".

         WHY IT IS RETIRED RATHER THAN RETUNED. Its stated purpose was to cover the window
         "until its prompt update actually lands" - the pose sentence catching up. There is
         no pose sentence any more. Under strict image-only conditioning the prompt is one
         frozen string, so maybeUpdateProfile()'s applyActive() finds the image AND the
         prompt unchanged and dispatches nothing at all (see applyGarment's no-op skip).
         The hold was freezing the live view for up to four seconds to hide a transition
         that no longer transitions anything. Retuning the threshold would only shorten a
         freeze that has no remaining purpose.

         THE FRONT/BACK HOLD STAYS, and the difference is not cosmetic: that one covers a
         real ASSET swap - with COMPOSITE_DEFAULT off, a confirmed flip changes the
         reference image and re-uploads it - so there genuinely is a window in which the
         model is between garments. It ends when the swap completes, not on a guess.

         TO RESTORE THE PROFILE HOLD you would first have to give it something to cover:
         restore a pose clause to the prompt (see IMAGE_ONLY_PROMPT's restore list) so the
         profile transition dispatches again. Then raise it on ORIENT_PROFILE_ENTER_SCORE,
         never on the EXIT threshold. */
      const dualView = currentAngle === AUTO_ANGLE;
      const frontBackTurn = dualView && !acquiring && needsSwitch && !confirmed;
      if (frontBackTurn) orientHoldBegin("turn-detected");
      /* The shopper turned back / straightened up before the flip confirmed: no swap is
         coming, so drop the hold now rather than sitting on a still until the ceiling. */
      else if (_orientHoldActive) orientHoldEnd("turn-abandoned");

      /* The pose axis, updated every tick. Skipped when a DUAL-VIEW swap is confirmed and
         about to run: maybeSwap() re-applies the entire payload, which picks up whatever
         autoProfile is by then anyway, so firing a second set() alongside it would be pure
         redundancy inside the exact window the flicker fix works to keep quiet.

         `confirmed` alone is NOT that signal for a single-view item: `acquiring` is
         `autoOrientation === null`, and for single-view sessions autoOrientation never
         leaves null (maybeSwap - the only place that ever sets it - is a no-op for them),
         so `confirmed` can go permanently true the moment the front/back vote settles,
         with no swap ever actually pending behind it. Gating on `dualView` too is what
         keeps this axis running for the entire life of a single-view session instead of
         going silent the moment the shopper is first read as "front". */
      /* NOT AWAITED - these run in the background, and the tick moves on. Both end in
         applyActive(), which can take a network round-trip; awaiting them here held
         `sampling` true for that whole time, so the NEXT orientation sample was skipped
         and the watcher's effective rate dropped from 250ms to however long Decart took
         to answer. That never froze #aiVideo (the video is composited independently of
         this timer), but it did make the orientation signal go stale during exactly the
         movement it is meant to be tracking - the turn - which is a slower, quieter
         version of the same complaint.

         Safe without the await because the mutex is INSIDE them, not here:
         maybeUpdateProfile() and maybeReanchorPrompt() both check and set the shared
         `applying` flag before doing anything, so two overlapping ticks still cannot
         produce two concurrent applies. What is lost is only the tick's knowledge of when
         they finished, which nothing below uses. maybeSwap() stays awaited - it owns the
         hold's lifecycle and the tick must not run ahead of it. */
      if (!(dualView && confirmed)) {
        maybeUpdateProfile(lastProfileScore).catch(() => {});
        /* Same redundancy argument as maybeUpdateProfile()'s skip above: a pending
           dual-view swap is about to re-apply the whole payload anyway. Called AFTER
           maybeUpdateProfile(), not instead of it - a fresh transition this very tick
           already stamps lastReanchorAt itself (see that function's comment), so
           back-to-back calls here never double-fire for the same transition.
           NOT gated on pose: the drift this counters is pose-independent, so a shopper
           standing still square-on needs it exactly as much as one holding a profile -
           see REANCHOR_MS's comment. */
        maybeReanchorPrompt().catch(() => {});
      }

      if (dualView && confirmed) await maybeSwap(lastVote);
    } catch (_) {} finally { sampling = false; }
  }, ORIENT_SAMPLE_MS);

  return {
    stop() {
      disposed = true;
      clearInterval(timer);
      /* A hold raised mid-turn outlives the watcher otherwise: the sampler that would
         have released it is gone, and the shopper is left staring at a frozen still with
         the live feed hidden underneath it forever. */
      orientHoldEnd("watcher-stopped");
      try { video.pause(); } catch (_) {}
      video.srcObject = null;                    // detach only - the track is the preview's
    },
  };
}

/* Decode a garment URL into an ImageBitmap without tainting the canvas: http(s) CDN
   URLs go through the same-origin proxy (exactly like the live reference path); data:
   and blob: URLs (custom uploads) are fetched directly - both yield a decodable Blob. */
async function loadGarmentBitmap(url, attempts = 3) {
  if (!url) throw new Error("no image url");
  let blob;
  if (/^(data:|blob:)/i.test(url)) {
    blob = await (await fetch(url)).blob();
  } else {
    blob = await fetchWithFallback(url, attempts);   // /api/img-proxy, then raw CDN, × attempts
  }
  if (!blob) throw new Error("image fetch failed: " + abbrevImg(url));
  // Decode failures are reported separately from fetch failures: a blob that arrived
  // but won't decode means the bytes are not a usable image (hotlink-block HTML, a
  // truncated response, an unsupported codec), which is a different fix than a 404.
  try {
    return await createImageBitmap(blob);
  } catch (e) {
    throw new Error(
      `image decoded failed (${blob.type || "unknown type"}, ${blob.size} bytes): ` + abbrevImg(url)
    );
  }
}

/* ── Backdrop sampling - the fix for "a dark seam is painted on my shirt" ─────
   Returns the colour to fill the composite's background and gutter with, sampled from
   the packshots themselves rather than hard-coded.

   Reads the four corners of each source image (garments are centred, so corners are
   backdrop, not fabric) and takes the MEDIAN per channel. Median, not mean: one corner
   landing on a stray shadow, a model's elbow or a watermark skews an average but cannot
   move a median of eight samples. If the two photos disagree wildly - a white packshot
   paired with a dark lifestyle shot - there is no single colour that hides the join, so
   it returns the brighter of the two, which reads as studio backdrop rather than as a
   dark band cutting through the reference.

   @param {Array<ImageBitmap|HTMLImageElement>} imgs  decoded panel sources
   @returns {{fill:string, contrast:string}} fill = backdrop; contrast = a legible
     ink colour for that backdrop (used by the label band, and by the divider if re-enabled)
*/
function sampleBackdrop(imgs) {
  const px = [];
  for (const img of imgs) {
    const w = img.width, h = img.height;
    if (!w || !h) continue;
    try {
      const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const inset = Math.max(1, Math.round(Math.min(w, h) * 0.02));   // step off the very edge (JPEG ring)
      for (const [x, y] of [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset]]) {
        const d = cx.getImageData(Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y)), 1, 1).data;
        px.push([d[0], d[1], d[2]]);
      }
    } catch (_) { /* tainted or zero-sized - just skip this source */ }
  }
  if (!px.length) return { fill: "#f2f2f2", contrast: "#101010" };   // neutral light, not the old dark grey

  const median = (i) => {
    const v = px.map((p) => p[i]).sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
  };
  const rgb = [median(0), median(1), median(2)];
  // Perceptual luminance - decides whether ink on this backdrop should be black or white.
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return {
    fill: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
    contrast: lum > 0.5 ? "#101010" : "#f5f5f5",
  };
}

/* object-fit: cover - fill the target rect (cropping overflow), preserving aspect ratio,
   so a portrait packshot never squashes into its half of the reference. */
function drawImageCover(ctx, img, dx, dy, dw, dh) {
  const scale = Math.max(dw / img.width, dh / img.height);
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/* In-canvas section label ("FRONT"/"BACK") as a HARD architectural marker for the model: a
   high-contrast SOLID WHITE box with a black border and black bold sans-serif text, pinned to
   the TOP corner of its section (`anchorX`/`top`, `align` = "left" anchors the box's left edge,
   "right" anchors its right edge) so it stamps the view's identity without covering the main
   garment area below. Size scales with the canvas. roundRect where supported, else a rect. */
function drawSectionLabel(ctx, text, anchorX, top, fontPx, align) {
  ctx.save();
  ctx.font = `800 ${fontPx}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = Math.round(fontPx * 0.5), padY = Math.round(fontPx * 0.32);
  const boxW = Math.round(ctx.measureText(text).width) + padX * 2;
  const boxH = fontPx + padY * 2;
  /* "center" anchors the box's MIDPOINT at anchorX - required by the side-by-side
     composite, where each label must sit centred over its own panel. "right" anchors
     the right edge, anything else (incl. "left") the left edge. */
  const x = align === "right"  ? Math.round(anchorX - boxW)
          : align === "center" ? Math.round(anchorX - boxW / 2)
          : Math.round(anchorX);
  const r = Math.round(boxH * 0.18);
  const hasRound = typeof ctx.roundRect === "function";

  ctx.fillStyle   = "#ffffff";                                   // high-contrast white box
  ctx.strokeStyle = "#000000";                                   // black border for a hard, defined edge
  ctx.lineWidth   = Math.max(2, Math.round(fontPx * 0.06));
  if (hasRound) { ctx.beginPath(); ctx.roundRect(x, top, boxW, boxH, r); ctx.fill(); ctx.stroke(); }
  else { ctx.fillRect(x, top, boxW, boxH); ctx.strokeRect(x, top, boxW, boxH); }

  ctx.fillStyle = "#000000";                                     // black text on white = max contrast
  ctx.fillText(text, x + boxW / 2, top + boxH / 2);
  ctx.restore();
}

/* ── Full-Look compositor - "TOP + BOTTOM Stitched Reference" ─────────────────
   Same rigid-geometry technique the removed front|back stitcher used, but stacked
   VERTICALLY: the TOP garment (shirt) boxed into the upper half, the BOTTOM garment
   (trousers) boxed into the lower half, separated by the same wide black no-man's-land
   bar + gutter. WHY THIS EXISTS: Decart's realtime set() only forwards ONE image
   ({prompt, enhance, image} - setInputSchema strips anything else), so a text-only
   description of the second garment (no visual reference) is weakly obeyed by the
   diffusion model and visually reads as "replaced" rather than "layered". Giving BOTH
   garments an actual pixel reference - even split across one image - is what makes
   the second garment actually render. Returns ONE JPEG Blob for rtClient.set({ image }).
   Memoized per top+bottom URL pair; falls back to null (caller falls back to the
   top-only reference) on any decode/composite failure. */
const LOOK_W   = 1024, LOOK_H = 2048, LOOK_SEP = 200;
const LOOK_PAD = 44;                                // black gutter framing each half (isolated panel)
const LOOK_BOX = (LOOK_H - LOOK_SEP) / 2;           // 924px per half
const _lookStitchCache = new Map();   // `${topUrl} ${bottomUrl}` → Promise<Blob|null>  (LRU-capped, see BLOB_CACHE_MAX)

/* ── Stitched Garment Composite Engine ───────────────────────────────────────────
   ONE reference image carrying BOTH views: FRONT on the left, BACK on the right,
   split by a divider and stamped with hard "FRONT"/"BACK" markers.

   HISTORY, because it matters when reading this. A front|back composite existed
   before and was removed in 23f5953 for producing double-logo / duplicated-garment
   renders: it fed Lucy a stitched image and asked the PROMPT to pick the correct
   half as the shopper turned, and a diffusion model with no notion of "panels"
   frequently rendered fragments of both.

   Two things are different now, which is why this is worth building rather than a
   repeat of that:
     1. LABELLED PANELS. The old bar was unmarked. This stamps each half with a
        high-contrast marker and the clause names the panel explicitly ("render ONLY
        the panel marked FRONT"). That exact technique is already load-bearing and
        working in this file for TOP/BOTTOM full looks (see LOOK_CLAUSE) - the
        precedent is in-repo, not theoretical.
     2. A RELIABLE ORIENTATION SIGNAL. The old version had none, so the prompt had to
        be ambiguous about which half applied. The OrientationWatcher now produces a
        confirmed FRONT/BACK lock, so the clause names ONE panel at a time and the
        model is never asked to choose.

   A real benefit falls out of this: the image is constant across a turn, so an
   orientation flip is a PROMPT-ONLY set() - no image re-upload, no re-fetch.

   Gated by COMPOSITE_MODE. If double-rendering reappears, flip that off and the
   per-orientation single-asset path (AI Auto) is back, unchanged. */
/* THE KILL SWITCH, NOW THROWN - and this is the one behavioural change in strict
   image-only mode that is not a prompt edit, so read this before flipping it back.

   The composite is a SPLIT image: two garment views side by side, a sampled gutter
   between them, and 'FRONT'/'BACK' text markers below. Nothing about that layout is
   self-evident to an image-conditioned model. Every bit of it was explained in words -
   DENSE.contract named it a split photo, DENSE.select named the half in play,
   DENSE.ignoreFurniture disclaimed the gutter and the markers - and IMAGE_ONLY_PROMPT
   removes all three. What is left is a reference the model has to interpret unaided:
   two garments, or a collage, or a garment with a seam down it. This file already has
   the record of what that produces (23f5953: both panels' designs rendered on one
   surface), and an ambiguous reference is precisely the condition under which a
   diffusion model falls back on its own prior - which is the tuxedo.

   So strict image-only sends the per-orientation SINGLE asset instead: one clean
   photograph of the garment, front or back, swapped by the OrientationWatcher when the
   shopper turns. That reference needs no explanation at all, which is the entire point
   of the mode. The path is not new - it is the pre-composite behaviour, still tested,
   still the fallback whenever a stitch fails.

   WHAT THROWING THIS COSTS, honestly: an orientation flip now changes the reference, so
   it re-uploads the image mid-turn instead of taking applyGarment()'s prompt-only fast
   path. That re-upload is what the composite was introduced to avoid, and the flicker it
   can cause is documented at that fast path. Whether it actually causes it was already
   in question - see window.__pearDebugForceFullReupload, added to test exactly that.
   Only items shipping a genuine distinct rear photo were ever affected either way.

   TO GO BACK: append ?composite=1 to the fitting-room URL (unchanged, and the right way
   to A/B this against a live session), or flip this constant. If you flip it, restore
   DENSE.contract + DENSE.select in buildCompositePrompt() in the same commit - a split
   reference with no panel contract is the worst of both modes. Keep both paths working;
   do not delete one for the other.

   ── THAT RESTORE HAS SINCE BEEN DONE, AND FOR A REASON THIS PARAGRAPH DID NOT ANTICIPATE.
   The panel contract is back in buildCompositePrompt() as of the COMBINED-handover fix, so
   flipping the constant no longer carries that debt. It was not restored in order to flip
   anything: the widget hands over a pre-stitched FRONT|BACK image (garment_composite), and
   compositeActiveFor() was gating that handover behind distinctBackOf() - a test for a
   separate back URL that a handed-over composite does not have by construction. The
   composite was therefore discarded on exactly the items that shipped one, and the session
   ran on the single-asset path while the "Now fitting" chip showed the shopper a composite.
   An EXISTING unified composite now activates the path on its own; COMPOSITE_DEFAULT still
   governs whether this room goes and BUILDS one, and is still false. */
const COMPOSITE_DEFAULT = false;
const COMPOSITE_MODE = (() => {
  try {
    const q = new URLSearchParams(location.search).get("composite");
    if (q === "0" || q === "false") return false;
    if (q === "1" || q === "true")  return true;
  } catch (_) {}
  return COMPOSITE_DEFAULT;
})();

const COMPOSITE_MAX_W   = 2048;   // cap on the stitched output - Decart gains nothing from more

/* ── Why there is no drawn divider any more ──────────────────────────────────
   The composite used to paint a #e8e8e8 line down a #3a3a3a gutter: a hard,
   high-contrast, full-height vertical edge sitting in the exact middle of the
   reference. Lucy is an image-conditioned diffusion model with no notion of "canvas
   furniture" - it samples texture from the reference, and the single strongest edge in
   that reference was the divider. It came out as a dark seam painted down the shopper's
   clothing. Telling the prompt to ignore it helps, but the reliable fix is to not draw a
   high-contrast edge into a texture source in the first place.

   So: no line, and a gutter filled with the panels' OWN background colour (sampled at
   runtime - see sampleBackdrop). On the white packshots that dominate storefronts the gap
   is genuinely invisible; on a dark-background shoot it goes dark to match. Either way
   there is no edge to mistake for a seam. Panel separation now comes from position plus
   the prompt naming the halves, which is what COMPOSITE_PANEL_CONTRACT already asserts.

   COMPOSITE_DIVIDER is kept as a switch rather than deleted: set it > 0 to paint the line
   again (it is drawn in the sampled backdrop's contrast colour, not hard-coded grey) if a
   future model build turns out to need the explicit boundary. */
const COMPOSITE_DIVIDER = 0;      // 0 = seamless gap (default). >0 = divider width in px.
const COMPOSITE_GUTTER  = 96;     // gap between panels - wider now that nothing is drawn in it

/* Label band: "FRONT"/"BACK" markers live BELOW the panels, never over the garment.
   The markers are load-bearing (the labelled-panel technique is what made this composite
   work where the unlabelled 23f5953 one failed), so they are not removed - but text drawn
   ON a garment is text that can be composited onto the shopper, which is the reported
   artifact. Moving them into a dedicated band below every garment pixel keeps the panel
   identity signal and removes the overlap. Set COMPOSITE_LABELS = false to drop them
   entirely and rely purely on left/right position + the prompt. */
const COMPOSITE_LABELS      = true;
const COMPOSITE_LABEL_BAND  = 0.11;   // band height as a fraction of the panel height
const _compositeCache = new Map();   // `${frontUrl} ${backUrl}` → Promise<Blob|null>  (LRU-capped, see BLOB_CACHE_MAX)

/**
 * Human-readable summary of a composite's panel geometry - and the one place that checks
 * the pixels actually match the contract the prompt asserts (LEFT = FRONT, RIGHT = BACK).
 *
 * WHY THIS IS WORTH A FUNCTION: the composite is built by two independent copies of the
 * same layout code - createGarmentComposite() here and createGarmentComposite() in
 * pear-widget.js - in separate bundles with no shared module system (that file's own
 * comment says the two "must stay in lockstep"). "Must stay in lockstep" is a convention,
 * not an invariant, and when it breaks the only symptom is a back view that renders the
 * front. The widget now reports the geometry it drew, and a panel-order drift shows up as
 * a console warning next to the prompt that assumes otherwise.
 *
 * @param {{w:number,h:number,front_x:number,front_w:number,back_x:number,back_w:number}} L
 * @returns {string}
 */
function describeCompositeLayout(L) {
  if (!L || !L.w) return "layout: not reported";
  const leftIsFront = L.front_x < L.back_x;
  return `${L.w}×${L.h}, FRONT x${L.front_x}+${L.front_w} | BACK x${L.back_x}+${L.back_w}` +
    (leftIsFront ? "" : "  ⚠ PANELS REVERSED - the prompt asserts LEFT=FRONT, RIGHT=BACK");
}

/**
 * Stitch a garment's FRONT and BACK photos into one side-by-side composite.
 *
 * Layout: front LEFT, back RIGHT, total width = frontW + backW + gutter, canvas height =
 * max(frontH, backH) plus a label band. The gutter is filled with the packshots' own
 * sampled backdrop and NOTHING is drawn in it, and the "FRONT" / "BACK" markers sit in the
 * band below the panels - both so that the only hard edges in the reference belong to the
 * garments themselves. See the COMPOSITE_DIVIDER / COMPOSITE_LABELS comments for why.
 *
 * Both images are first scaled to a COMMON height (the taller of the two) preserving
 * aspect ratio - the width formula then uses those drawn widths. Mixing a 1000px and
 * an 800px panel side by side would otherwise imply the two garments are different
 * sizes, which is exactly the kind of ambiguity this image exists to remove. The
 * result is capped at COMPOSITE_MAX_W.
 *
 * @param {string} frontImageUrl  front-view image (http(s)/data:/blob:)
 * @param {string} backImageUrl   back-view image
 * @param {{as?: "blob"|"dataURL", labelPlacement?: "below"|"over"|"none"}} [opts]
 *   as             - "blob" (default; what rtClient.set({ image }) takes) or "dataURL"
 *   labelPlacement - "below" (default) puts the markers in a band under the panels, off
 *                    the garment; "over" restores the legacy on-panel stamp; "none" drops
 *                    them and leaves the model to read the halves positionally
 * @returns {Promise<Blob|string|null>} null on any decode/fetch failure, so the caller
 *   can fall back to the single-asset path rather than going live with no reference.
 */
function createGarmentComposite(frontImageUrl, backImageUrl, opts = {}) {
  if (!frontImageUrl || !backImageUrl) return Promise.resolve(null);
  const { as = "blob", labelPlacement = "below" } = opts;
  const key = `${frontImageUrl} ${backImageUrl} ${as} ${labelPlacement}`;
  if (_compositeCache.has(key)) return lruTouch(_compositeCache, key);

  const job = (async () => {
    try {
      const [front, back] = await Promise.all([
        loadGarmentBitmap(frontImageUrl),
        loadGarmentBitmap(backImageUrl),
      ]);

      // 1. Common height, aspect preserved - see the doc comment for why.
      const panelH = Math.max(front.height, back.height);
      const frontW = Math.round(front.width  * (panelH / front.height));
      const backW  = Math.round(back.width   * (panelH / back.height));

      // 2. Spec geometry: width = frontW + backW + gutter, height = max(h).
      let totalW = frontW + backW + COMPOSITE_GUTTER;
      let totalH = panelH;
      const wantLabels = COMPOSITE_LABELS && labelPlacement !== "none";
      /* The band is what keeps marker text off the garment. "over" is still honoured for
         any caller that explicitly asks for the old on-panel placement, but nothing does
         by default any more - see the COMPOSITE_LABELS comment. */
      const labelBand = wantLabels && labelPlacement !== "over"
        ? Math.round(panelH * COMPOSITE_LABEL_BAND) : 0;
      totalH += labelBand;

      // 3. Cap the output - a 5000px composite costs upload time and buys nothing.
      const scale = Math.min(1, COMPOSITE_MAX_W / totalW);
      const W  = Math.round(totalW * scale);
      const H  = Math.round(totalH * scale);
      const fW = Math.round(frontW * scale);
      const bW = Math.round(backW  * scale);
      const gut = Math.round(COMPOSITE_GUTTER * scale);
      const pH = H - Math.round(labelBand * scale);

      /* Backdrop sampled from the packshots, so the gutter is the SAME colour as the
         background already inside each panel and the join between them has no edge for
         the model to read as a seam. Replaces the old fixed #3a3a3a, which was a dark
         band between two typically-white photos - the highest-contrast feature in the
         whole reference, and the one that ended up painted on the shopper.
         Sampled BEFORE the output canvas exists: it allocates scratch canvases of its
         own, and doing that after would interleave allocation with drawing for no reason. */
      const backdrop = sampleBackdrop([front, back]);

      const off    = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : null;
      const canvas = off || Object.assign(document.createElement("canvas"), { width: W, height: H });
      const ctx    = canvas.getContext("2d");

      ctx.fillStyle = backdrop.fill;
      ctx.fillRect(0, 0, W, H);

      // 4. FRONT panel on the LEFT, clipped so a wide packshot cannot cross the gutter.
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, fW, pH); ctx.clip();
      drawImageCover(ctx, front, 0, 0, fW, pH);
      ctx.restore();

      // 5. BACK panel on the RIGHT, same clip discipline.
      const backX = fW + gut;
      ctx.save();
      ctx.beginPath(); ctx.rect(backX, 0, bW, pH); ctx.clip();
      drawImageCover(ctx, back, backX, 0, bW, pH);
      ctx.restore();

      /* 6. Divider - OFF by default (COMPOSITE_DIVIDER = 0). The gutter is already the
            panels' own backdrop colour, so the two halves meet with no edge at all and
            there is nothing for the model to copy onto the shopper as a seam. When
            re-enabled it draws in the sampled contrast ink rather than a fixed grey, so
            it can never invert into a black bar on a dark shoot. */
      if (COMPOSITE_DIVIDER > 0) {
        const dividerW = Math.max(1, Math.round(COMPOSITE_DIVIDER * scale));
        ctx.fillStyle = backdrop.contrast;
        ctx.globalAlpha = 0.28;                       // ultra-subtle: a hint, not a hard edge
        ctx.fillRect(Math.round(fW + gut / 2 - dividerW / 2), 0, dividerW, pH);
        ctx.globalAlpha = 1;
      }

      // 7. Labels, in the band BELOW the panels - never over a garment pixel.
      const fontPx = Math.max(18, Math.round(W * 0.035));
      if (wantLabels) {
        const labelY = labelBand
          ? pH + Math.round((H - pH) / 2 - fontPx * 0.82)   // centred in the band, below every garment pixel
          : Math.round(pH * 0.035);                          // legacy "over" placement
        drawSectionLabel(ctx, "FRONT", Math.round(fW / 2), labelY, fontPx, "center");
        drawSectionLabel(ctx, "BACK",  Math.round(backX + bW / 2), labelY, fontPx, "center");
      }

      front.close?.(); back.close?.();            // release decoded bitmaps

      const blob = off
        ? await off.convertToBlob({ type: "image/jpeg", quality: 0.95 })
        : await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));

      console.log(`[PEAR] composite built: ${W}×${H} · FRONT ${fW}px | BACK ${bW}px · ` +
        `backdrop ${backdrop.fill} · divider ${COMPOSITE_DIVIDER > 0 ? COMPOSITE_DIVIDER + "px" : "none (seamless)"} · ` +
        `labels ${wantLabels ? (labelBand ? "below panels" : "over panels") : "off"} · ` +
        `${blob ? (blob.size / 1024).toFixed(0) + "KB" : "no blob"}`);

      if (as !== "dataURL") return blob;
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(blob);
      });
    } catch (e) {
      console.warn("[PEAR] createGarmentComposite failed:", e?.message || e);
      _compositeCache.delete(key);   // never cache a failure - allow a later retry
      return null;
    }
  })();

  lruSet(_compositeCache, key, job);
  return job;
}

/**
 * Stitch a TOP + BOTTOM garment asset into ONE fixed 1024×2048 reference Blob: TOP boxed
 * into the upper half (inset by a 44px black gutter) + "TOP" white marker, a WIDE 200px
 * opaque black separator bar, BOTTOM boxed into the lower half (same gutter) + "BOTTOM"
 * white marker. Same rigid geometry + wide bar + gutter that keeps the front/back stitch
 * from bleeding - here it keeps the shirt and pants from bleeding into each other.
 * @param {string} topUrl     upper-body garment image URL (http(s)/data:/blob:)
 * @param {string} bottomUrl  lower-body garment image URL
 * @returns {Promise<Blob|null>}  JPEG Blob, or null on any failure (caller falls back
 *   to the plain top-only reference so a full look is never left without ANY reference).
 */
function stitchLookBlob(topUrl, bottomUrl) {
  if (!topUrl || !bottomUrl) return Promise.resolve(null);
  const key = `${topUrl} ${bottomUrl}`;
  if (_lookStitchCache.has(key)) return lruTouch(_lookStitchCache, key);

  const job = (async () => {
    try {
      const [top, bottom] = await Promise.all([loadGarmentBitmap(topUrl), loadGarmentBitmap(bottomUrl)]);

      const boxH = LOOK_BOX, W = LOOK_W;
      const bottomY = boxH + LOOK_SEP;   // start of the BOTTOM box (after the bar)

      const off    = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(LOOK_W, LOOK_H) : null;
      const canvas = off || Object.assign(document.createElement("canvas"), { width: LOOK_W, height: LOOK_H });
      const ctx    = canvas.getContext("2d");

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, LOOK_W, LOOK_H);

      const pad = LOOK_PAD;
      const innerW = W - pad * 2, innerH = boxH - pad * 2;

      // Upper half = TOP, clipped to its box so a wide packshot can't bleed toward the bar.
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, boxH); ctx.clip();
      drawImageCover(ctx, top, pad, pad, innerW, innerH);
      ctx.restore();

      // Lower half = BOTTOM, clipped to its box (starts after the bar).
      ctx.save();
      ctx.beginPath(); ctx.rect(0, bottomY, W, boxH); ctx.clip();
      drawImageCover(ctx, bottom, pad, bottomY + pad, innerW, innerH);
      ctx.restore();

      // High-contrast 200px SOLID BLACK separator bar - the diffusion "no-man's-land".
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, boxH, W, LOOK_SEP);

      // Hard architectural markers: "TOP" in the upper half, "BOTTOM" in the lower half.
      const fontPx = Math.round(W * 0.09);
      const inset  = Math.round(W * 0.04);
      drawSectionLabel(ctx, "TOP",    inset, inset, fontPx, "left");
      drawSectionLabel(ctx, "BOTTOM", inset, bottomY + inset, fontPx, "left");
      top.close?.(); bottom.close?.();             // release decoded bitmaps

      return off
        ? await off.convertToBlob({ type: "image/jpeg", quality: 0.95 })
        : await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
    } catch (e) {
      console.warn("[PEAR] stitchLookBlob failed:", e?.message || e);
      _lookStitchCache.delete(key);   // never cache a failure - allow a later retry
      return null;
    }
  })();

  lruSet(_lookStitchCache, key, job);
  return job;
}

/**
 * Return an absolute URL that the Decart server can reliably fetch.
 * Raw CDN URLs (suitsupply, magnific, etc.) can take 20-25 s for Decart's
 * server to fetch, inflating billing from ~10 to ~60 tokens per session.
 * Routing through /api/img-proxy (our own Vercel endpoint) is fast, public,
 * and already sets Cache-Control so repeated fetches are instant.
 * On localhost the proxy URL isn't reachable from Decart's servers, so we
 * fall back to the raw CDN URL (acceptable for local dev only).
 */
function garmentImageRef(cdnUrl) {
  if (!cdnUrl) return undefined;
  // "Upload Your Own Garment": a cropped custom garment is a self-contained
  // data:/blob: URL - it is NOT a fetchable http(s) CDN URL, so it must be handed
  // to the SDK verbatim. Routing it through /api/img-proxy (which fetches a remote
  // URL) would corrupt it. Pass it straight through.
  if (/^(data:|blob:)/i.test(cdnUrl)) return cdnUrl;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (isLocal) {
    console.log("[PEAR] garmentImageRef() - localhost, using raw CDN URL:", cdnUrl);
    return cdnUrl;
  }
  const ref = `${location.origin}/api/img-proxy?url=${encodeURIComponent(cdnUrl)}`;
  console.log("[PEAR] garmentImageRef() - proxied ref:", ref, "for CDN URL:", cdnUrl);
  return ref;
}

/** Console-safe image ref: abbreviate long/data URLs so a base64 crop can't flood DevTools. */
function abbrevImg(ref) {
  if (!ref) return "(none)";
  if (typeof Blob !== "undefined" && ref instanceof Blob)
    return `Blob(${ref.type || "image"}, ${ref.size.toLocaleString()} bytes, stitched combined ref)`;
  if (/^data:/i.test(ref)) return `data:… (${ref.length.toLocaleString()} chars, custom crop)`;
  return ref.length > 100 ? ref.slice(0, 100) + "…" : ref;
}

/* ── Canonical image identity ────────────────────────────────────────────────────
   THE "FRONT PRINT RENDERED ON THE BACK" BUG. Six separate places decide whether an
   item ships a REAL, DISTINCT back photo, and every one of them compared raw URL
   strings (`g.back !== g.front`). Storefront CDNs serve the SAME photo under many
   URLs - a size param (?width=800 vs ?width=1400), a cache-busting version (?v=), a
   filename size suffix (_800x.jpg), a protocol or host-case difference. Two spellings
   of one photo therefore passed every "distinct" test, so a session could go live in
   AI Auto with the FRONT photo bound as the back reference - and then
   ANGLE_CLAUSE.backReal tells Lucy "this reference shows the BACK: reproduce it... do
   NOT render the front" while showing it the front. The model does exactly as asked
   with what it was given: it reproduces the chest print, on the back.

   canonicalImageUrl() reduces a URL to the ASSET it identifies, so sameImage() can
   answer "are these two references the same photograph?" instead of "are these two
   strings equal?". Deliberately conservative - it only strips parameters that are
   known to be presentation/cache concerns, never anything that could select a
   different asset. data:/blob: URLs are compared verbatim (a generated rear view is
   its own asset and has no meaningful canonical form). */
const PRESENTATION_PARAMS = new Set([
  "width", "height", "w", "h", "size", "quality", "q", "dpr", "format", "fm",
  "crop", "fit", "scale", "v", "ver", "version", "t", "cache", "_",
]);

/* Image-resizer endpoints (Next.js /_next/image, Cloudflare /cdn-cgi/image, imgproxy)
   carry the REAL asset in a `url=` param. Their own path is identical for every image
   on the site, so canonicalising on the path would make every product photo compare
   equal - collapsing a gallery to one entry and destroying the back reference. */
const RESIZER_RE = /\/(?:_next\/image|cdn-cgi\/image|_vercel\/image|imgproxy|thumbor|resize)\b|[?&]url=/i;

function canonicalImageUrl(url, depth = 0) {
  if (!url || typeof url !== "string") return "";
  if (/^(data:|blob:)/i.test(url)) return url;
  if (RESIZER_RE.test(url) && depth < 3) {
    const m = /[?&]url=([^&]+)/i.exec(url);
    if (m) {
      let inner = m[1];
      try { inner = decodeURIComponent(inner); } catch (_) {}
      /* Resolve a root-relative url= against the resizer's own origin, so the wrapped
         form and a direct reference to the same photo canonicalise identically. */
      try { inner = new URL(inner, new URL(url, location.href)).toString(); } catch (_) {}
      return canonicalImageUrl(inner, depth + 1);
    }
    return url.toLowerCase();                   // transform encoded in the path
  }
  let u;
  try {
    u = new URL(url, location.href);
  } catch (_) {
    return url.split("?")[0].toLowerCase();     // unparseable - fall back to the bare path
  }
  u.protocol = "https:";                        // http/https of the same asset are the same asset
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (PRESENTATION_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  // CDN size suffix baked into the filename (Shopify _800x.jpg / _small.jpg /
  // _100x100_crop_center.jpg, WooCommerce -300x300.jpg at thumbnail scale). Mirrors
  // upgradeImageUrl() in pear-widget.js - keep the two in lockstep.
  u.pathname = u.pathname
    .replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d{1,4}x(?:\d{1,4})?)(?:_crop_[a-z]+)?(?=\.(?:jpe?g|png|webp|gif)$)/i, "")
    .replace(/-(\d{2,3})x(\d{2,3})(?=\.(?:jpe?g|png|webp|gif)$)/i, (m, a, b) =>
      (parseInt(a, 10) <= 600 && parseInt(b, 10) <= 600) ? "" : m);
  return u.toString().toLowerCase();
}

/** True when two URLs identify the SAME photograph. Use this - never `a !== b` - for
 *  any "is the back really a different image from the front" decision. */
function sameImage(a, b) {
  if (!a || !b) return false;
  return canonicalImageUrl(a) === canonicalImageUrl(b);
}

/** The item's back asset ONLY when it is a genuinely different photograph from the
 *  front; undefined otherwise. Single chokepoint for that question, so a future
 *  caller cannot reintroduce a raw string compare. */
/* Warn once per offending pair. These predicates run on every applyGarment/render, so
   an unguarded warn would bury the console in duplicates - and this message needs to
   stay findable, since it names the exact condition that used to put the front print
   on the back. */
const _warnedSamePhotoPairs = new Set();

function distinctBackOf(item, g = galleryOf(item)) {
  if (!g || !g.back) return undefined;
  const front = g.front || (item && item.img);
  if (front && sameImage(g.back, front)) {
    const key = canonicalImageUrl(front) + "|" + canonicalImageUrl(g.back);
    if (!_warnedSamePhotoPairs.has(key)) {
      _warnedSamePhotoPairs.add(key);
      console.warn("[PEAR] back asset is the SAME photo as the front (different URL spelling) -",
        "treating this item as single-view rather than binding the front as a back reference.",
        "\n  front:", abbrevImg(front), "\n  back :", abbrevImg(g.back));
    }
    return undefined;
  }
  return g.back;
}

/* ── Multi-Image Product Gallery - variant + angle resolution + prompt steering ──
   ONE lookup chain feeds the whole UI and the live WebRTC sync, so no item, colour
   or angle can ever empty the gallery state. galleryOf() resolves, in priority order:
     1. item.variants[activeColor]  - the nested per-colour gallery (real store schema)
     2. item.images                 - a flat { front, back, side } gallery object
     3. item.img / item.imgBack     - the legacy single-image + optional back fields
   Whatever shape an item uses, it normalizes to one { front, back?, side?, detail? }
   map. A missing angle transparently falls back to the front image (+ a prompt clause),
   so EVERY garment and EVERY colour supports the full Front/Back/Side workflow - the
   rail is never empty and never hides. Angles/labels are data-driven and extensible. */
const ANGLES = ["front", "back", "side", "detail"];   // ordered render/priority list - extend freely
/* Angles usable as an actual VTON warp reference (a full garment presented on a body).
   `detail` is a close-up macro - perfect for product inspection, wrong as a try-on
   reference - so it is inspection-only: it is never fed to rtClient.set() and never
   appears in the live rail. Only WEARABLE angles hot-swap the stream. */
const WEARABLE_ANGLES = ["front", "back", "side"];
/* "AI Auto" - Context-Aware Asset Switching: both the front and back assets are
   pre-cached as Blobs, an OrientationWatcher reads the local camera, and the live
   session hot-swaps rtClient.set({ image }) to the SINGLE matching asset the instant
   the user turns. The model only ever sees ONE orientation at a time, so front/back
   cross-contamination is impossible by construction (there is no second view in the
   reference to bleed from). A synthetic pseudo-angle, deliberately NOT in ANGLES/
   WEARABLE_ANGLES, offered only when canCombineViews() (a real, distinct back photo
   exists) - and only while its OrientationWatcher can actually arm; see goLive()'s
   mode-settling block, which falls back to plain "front" (never a stitched
   composite - that approach was tried and removed, see git history, after it
   produced double-logo/duplicated-garment renders: Lucy has no concept of "panels"
   and would attempt to map both halves onto the body at once) if the watcher can't
   sample the camera. `autoOrientation` is the watcher-detected side currently in
   play; every angle-sensitive resolver reads effectiveAngle() so auto mode
   transparently reuses the entire existing front/back pipeline (images, clauses,
   fallbacks). */
const AUTO_ANGLE = "auto";
/* "front" | "back" - the side the user shows the camera - or NULL for "not yet
   acquired" (PENDING_MODE). Null is the boot value on purpose: the session no longer
   opens by ASSERTING the shopper faces the camera, it opens with the question still
   open and answers it from the first confident sample. See PENDING_MODE. */
let autoOrientation = null;
/* Is the shopper currently EDGE-ON to the camera? A deliberately separate axis from
   autoOrientation above, and the two must not be merged - see angleClause()'s `inProfile`
   comment for the full argument. In short: autoOrientation is a hysteresis-protected LOCK
   over which garment asset is on the wire, and a side-on frame is not evidence that the
   other side of the garment should now be showing. This flag changes only what the PROMPT
   asserts about the body's pose, never which reference image is sent, which is what makes
   it safe to move far more freely than the lock does.

   Sourced from a signal the watcher already computed and was throwing away: skinRatioVote()'s
   dead band, whose own comment read "ambiguous (profile/transition) - abstain". Abstaining
   was right for the lock and wrong for the prompt, which went on asserting a stale facing. */
let autoProfile = false;
/* Read by applyGarment()/applyLook() only, and only to take a SNAPSHOT - never called from
   inside angleClause(), which receives the frozen value as a parameter instead.

   Gated on the WATCHER's liveness, not on `currentAngle === AUTO_ANGLE` - that used to be
   the same thing, back when only dual-view items ever armed a watcher at all. Single-view
   items now do too (see syncOrientationWatcher()'s dualView/singleView split), and for
   them currentAngle never becomes AUTO_ANGLE, so that check would silently discard a real
   profile reading. `!!orientWatcher` is the correct generalisation: it is true exactly
   while a watcher is computing `autoProfile` for the CURRENT item (createOrientationWatcher()
   resets autoProfile to false at the top of every fresh instance, and
   syncOrientationWatcher() tears the watcher down - never leaving it running against a
   swapped item), so a stale reading from a torn-down watcher can never leak through here. */
function profileActive() { return !!orientWatcher && autoProfile; }
/* The angle every resolver should ACT on: auto mode delegates to the detected
   orientation, every other mode is what the user picked. PENDING (null) resolves to
   "front" for RENDERING only - the provisional reference, not a lock; the watcher's
   needsSwitch/confirmed logic reads autoOrientation directly so it can tell "pending"
   apart from "confirmed front", which is the whole point of the third state. */
function effectiveAngle() {
  if (currentAngle !== AUTO_ANGLE) return currentAngle;
  return autoOrientation || "front";
}
/* The lock's own state, as the explicit enum (PENDING/FRONT/BACK). Single source of
   truth for every log line and debug readout, so the three-state model can never
   drift back into being reported as two. */
function vtonState() {
  if (currentAngle !== AUTO_ANGLE) return null;
  return autoOrientation === "back" ? BACK_MODE : autoOrientation === "front" ? FRONT_MODE : PENDING_MODE;
}
const ANGLE_LABEL_HE = { front: "חזית", back: "גב",   side: "צד",   detail: "פרט",   auto: "אוטומטי AI" };
const ANGLE_LABEL_EN = { front: "Front", back: "Back", side: "Side", detail: "Detail", auto: "AI Auto" };

/** Ordered list of variant/colour keys an item ships (empty when it has no variants). */
function colorsOf(item) {
  return item && item.variants && typeof item.variants === "object" ? Object.keys(item.variants) : [];
}

/* Resolve the assets object for an item at a given colour (defaults to the global
   activeColor, then the item's first variant). Returns null when the item has no
   variants, so galleryOf() falls back to the flat images / legacy fields. */
function variantAssetsOf(item, color = activeColor) {
  const colors = colorsOf(item);
  if (!colors.length) return null;
  const key = colors.includes(color) ? color : colors[0];
  return item.variants[key] || null;
}

/* Swatch colour for a variant bubble: an explicit per-variant `swatch` hex wins, else
   the item's base colour, else a neutral grey. Keeps the swatch UI robust for any key. */
function swatchColor(item, key) {
  const v = item && item.variants && item.variants[key];
  return (v && v.swatch) || (item && item.color) || "#8a8f98";
}

/* ── Variant identity - the half of a colour swap that used to be dropped ─────
   THE BUG: setColor() moved `activeColor`, and galleryOf() reads through
   variantAssetsOf(), so picking a swatch DID swap the reference photo. Nothing else
   moved. Everything downstream still read the item's BASE fields:

     · the prompt said colorName(item.color)      → "the black t-shirt" for a red variant
     · the cart said activeItem.sku / .variantId  → the base SKU, whatever was picked

   So the model was handed a red packshot under an instruction naming black, and the
   shopper could add a colour to their cart that they never selected. The image half
   worked, which is exactly why it read as the model mutating the garment rather than as
   a state bug.

   Resolved through ONE accessor rather than by mutating activeItem on every swap:
   activeItem is shared with the outfit slots, the thumbnail cache and the handoff
   payload, so writing colour/sku into it would make a swatch click a mutation of
   catalog data - and a stale copy anywhere would then disagree. Reading derives the
   same answer everywhere, every time.

   Falls back through variant → item → id at each field independently, because a
   storefront variant may carry a sku and no variantId (or the reverse), and a catalog
   item may define variants purely for imagery with no commerce identity at all.
   @returns {{ color: string, variantId: string|undefined, sku: string }} */
function variantMetaOf(item, color = activeColor) {
  const base = {
    color: (item && item.color) || "#8a8f98",
    variantId: item && item.variantId,
    sku: (item && (item.sku || item.variantId)) || (item && item.id != null ? String(item.id) : ""),
  };
  if (!item) return base;
  const colors = colorsOf(item);
  if (!colors.length) return base;
  const key = colors.includes(color) ? color : colors[0];
  const v = item.variants[key];
  if (!v) return base;
  return {
    // `swatch` is the variant's own hex and is what the bubble renders, so it is also
    // the honest answer for "what colour is the shopper actually trying on".
    color: v.swatch || v.color || base.color,
    variantId: v.variantId ?? base.variantId,
    sku: v.sku || v.variantId || base.sku,
  };
}

/* The colour word the PROMPT should use. Separate one-liner because every builder needs
   it and none of them should have to know about the variant table. */
function activeColorOf(item) {
  return variantMetaOf(item).color;
}

/** Normalize any item (variant, flat-gallery, or legacy) into one { front, back?, … } map. */
function galleryOf(item) {
  if (!item) return {};
  const g = {};
  const src = variantAssetsOf(item) || item.images;   // nested colour gallery → flat gallery
  if (src && typeof src === "object") {
    for (const a of ANGLES) if (src[a]) g[a] = src[a];
  }
  // Legacy fallbacks so the entire existing catalog / handoff / upload flow keeps working.
  if (!g.front && item.img)     g.front = item.img;
  if (!g.back  && item.imgBack) g.back  = item.imgBack;
  return g;
}

/** Ordered list of angles this item actually ships an image for. */
function anglesOf(item) { const g = galleryOf(item); return ANGLES.filter((a) => g[a]); }

/* Angles the LIVE rail offers: only WEARABLE ones the item actually ships. Excludes
   inspection-only angles (e.g. `detail`), which are shown on the storefront PDP gallery
   but are never a warp target - feeding a close-up macro to the VTON model degrades it. */
function wearableAnglesOf(item) { const g = galleryOf(item); return WEARABLE_ANGLES.filter((a) => g[a]); }

/* ── Two-view (front / back) completeness - mirrors catalog.js ────────────────
   FRONT and BACK are the two canonical VTON views. hasFrontView/hasBackView report
   whether the item ships a REAL dedicated image for that angle (galleryOf() only
   ever exposes a real asset - the front-fallback for `back` happens later, at warp
   time in activeImageOf(), not here). "Fully documented" = both real views. Kept in
   lockstep with the storefront predicates of the same name in catalog.js.

   Gate policy (per product decision): GRACEFUL by default - a missing back never
   blocks going live; the front reference + ANGLE_CLAUSE.back render the rear. Only
   an item that OPTS IN with `requireBothViews: true` is hard-blocked when it lacks a
   real back. Uploaded/custom garments are single-view by nature and are never
   gated (they carry no requireBothViews flag). */
function hasFrontView(item) { return !!(item && galleryOf(item).front); }
function hasBackView(item)  { return !!(item && galleryOf(item).back); }
function hasBothViews(item) { return hasFrontView(item) && hasBackView(item); }

/* Reason a single garment can't go live (or null when it can). */
function itemBlockReason(item) {
  if (!item) return null;
  if (!hasFrontView(item)) return `ל־${item.name || "בגד זה"} אין תמונת חזית · no front-view image`;
  if (item.requireBothViews && !hasBackView(item))
    return `ל־${item.name || "בגד זה"} חסרה תמונת גב · missing required back-view image`;
  return null;
}

/* Reason the CURRENT subject (a full look, else the active single garment) can't go
   live - checks BOTH halves of a look. Returns null when go-live is allowed. */
function liveBlockReason() {
  const look = resolveLook();
  if (look) return itemBlockReason(look.top) || itemBlockReason(look.bottom);
  return itemBlockReason(activeItem);
}

/* Reason go-live should WAIT - or null when nothing is pending. Deliberately SEPARATE
   from itemBlockReason()/liveBlockReason() above: those describe a PERMANENT
   structural deficiency (no images at all, an opted-in required back genuinely
   missing) and are also read by the catalog grid to grey out tiles before a shopper
   has even picked an item. This describes a TRANSIENT in-flight state instead - the
   widget's classify+synthesize round trip on the store page, or this room's own local
   composite stitch - that resolves on its own within a bounded window (the 35s
   give-up timeout armed in setActiveItem()) and has no meaning for an item that
   hasn't been activated yet. Mixing the two would incorrectly greyed-out a catalog
   tile over async state that belongs only to whichever item is currently active.

   THE GATE: measured in production, a fresh back-view synthesis takes ~27-30s. Going
   live before it resolves would either (a) start the session already turned-around-
   ready with only a front reference and the weaker inferred-rear prompt clause, or
   (b) start AI Auto with no distinct back to switch to at all - in both cases the
   shopper pays for/starts a session that can't yet show what the corrected back-view
   pipeline was built to show. Blocking go-live until this clears (or gives up) is
   what makes the composite something the shopper's session actually uses, not a
   improvement that only helps if they happen to wait on their own. */
function itemPendingReason(item) {
  if (!item) return null;
  if (item._awaitingBackCorrection)
    return "עדיין מחפשים תצוגת גב לבגד, רק רגע · Still finding a back view for this item";
  if (item._compositeBuilding)
    return "מכינים תצוגה משולבת, רק רגע · Preparing the combined view";
  return null;
}
function livePendingReason() {
  const look = resolveLook();
  if (look) return itemPendingReason(look.top) || itemPendingReason(look.bottom);
  return itemPendingReason(activeItem);
}

/* The EXACT source image fed to the AI for the active angle. Falls back to the front
   asset when the active angle has no dedicated image, so a Back/Side toggle never
   breaks - it reuses the front reference and lets the prompt clause steer the warp.
   effectiveAngle() makes AI Auto transparent: the detected orientation picks the asset. */
function activeImageOf(item) {
  if (!item) return undefined;
  const g = galleryOf(item);
  return g[effectiveAngle()] || g.front || item.img;
}

/* True when the active angle has its OWN dedicated image (not a front fallback) - for
   a single garment or BOTH halves of a full look. Drives the "real image" UI hint. */
function hasDedicatedAngle(item) {
  const a = effectiveAngle();
  const look = resolveLook();
  if (look) return !!(galleryOf(look.top)[a] && galleryOf(look.bottom)[a]);
  return !!(item && galleryOf(item)[a]);
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  RETIRED - NOT ASSEMBLED INTO ANY PROMPT.  Read before editing.          ║
   ╚══════════════════════════════════════════════════════════════════════════╝
   Every constant from here down to COMPOSITE_QUALITY, plus STRICT_INPAINT,
   MODEL_AGNOSTIC_EXTRACTION, IGNORE_SOURCE_ARTIFACTS, PROFILE_ANOMALY_GUARD,
   ROTATION_CONTINUITY, QUALITY_SUFFIX, HEM_DETAIL, KEEP_TOP, KEEP_BOTTOMS,
   HARD_NEGATIVE and LOOK_CLAUSE further down, is DEAD. Nothing reads them. Every
   builder now assembles from the DENSE table through fitPrompt().

   WHY THEY ARE STILL HERE rather than deleted. Decart caps a prompt at 226 tokens
   and these totalled roughly 2,500 - so they were compressed, not removed for being
   wrong. Each one is the written record of a specific reproduced regression (the
   double-printed back, the flattened profile, the regenerated room, the garment
   dropping mid-turn, the model's shoulders on the shopper), and the one-sentence
   directives that replaced them carry the instruction but not the reasoning. When a
   regression returns - and the compression makes that likelier, not less - the clause
   that used to prevent it is the first thing worth reading.

   TO BUY A DIRECTIVE BACK: lift the sentence you need out of the relevant constant
   below, add it to DENSE, and give it a priority. Do NOT re-add a whole constant, and
   do not raise PROMPT_MAX_CHARS to make one fit - the ceiling is the API's, not ours.

   ⚠️ THAT LAST CLAUSE WAS BENT ONCE, 2026-08-24, AND IT IS RECORDED HERE RATHER THAN
   QUIETLY. PROMPT_MAX_CHARS went 650 → 700 to fit the garment colour clamp. The reason it
   is not the thing this sentence forbids: 700 is the value config.js's OWN rationale
   specifies and always has ("WHY 700 AND NOT 904 ... 700 keeps ~22% headroom"), while the
   API's ceiling is the ~904 characters that 226 tokens estimates to. 650 was a drift
   BELOW the documented figure, not the documented figure itself, and no prompt rejection
   is recorded against 700 - the "lower this if a real prompt is ever rejected" trigger
   never fired. So this raised the budget to its specified value; it did not spend API
   margin. Anything ABOVE 700 does, and this sentence still governs it.

   Angle-oriented prompt clauses. Switching the image alone isn't enough - Lucy
   regenerates every frame, so the prompt must ALSO name the viewing angle or the
   model keeps rendering a front. Front needs no clause. */
/* The rear POSE sentence, factored out of the three back clauses below for the same
   reason COMPOSITE_POSE is split from COMPOSITE_APPLY: all three opened with this exact
   sentence, and it is the one part of them that stops being true mid-turn. The garment
   instructions that follow it (reproduce the back print / infer a plain rear / the custom
   variant) stay correct at every angle, because the orientation lock that selected them
   has not moved. Concatenation below is byte-identical to the previous strings. */
const REAR_POSE =
  " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera.";
/* Its edge-on replacement. Same locked side, truthful rotation, plus the explicit ban on
   de-rotating - see COMPOSITE_POSE's comment for why asserting a square rear view while
   the shopper is side-on is what flattens their real profile volume. */
const REAR_POSE_PROFILE =
  " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right" +
  " angle to the camera - part-way through turning away, so the back of the garment faces off to" +
  " one side rather than squarely toward you. Render them at the exact rotation shown in the live" +
  " frame: do NOT rotate, straighten or re-pose them back to a square rear view.";
/* The garment half of each back clause, kept separate so either pose above can lead it. */
const BACK_TAIL = {
  real:
    " This reference photo shows the BACK of the garment: reproduce it faithfully - its back panel, rear yoke, back collar, rear hemline and especially any back graphics, prints, logos or lettering - keeping each element at the SAME size, height and horizontal position on the garment as in the reference, wrapping naturally around the body. Do not move, rescale, re-center or omit the back print, and do NOT render the front of the garment.",
  inferred:
    " Render the BACK of the garment: its back panel, rear yoke, back collar, rear hemline and the seams the cut implies, wrapping naturally around the body from the rear. This reference photo shows the FRONT of the garment, so you must INFER the corresponding rear from it. The back is a clean, plain expression of the same fabric, colour and texture: do NOT copy, mirror, repeat or relocate the front chest print, front logo, front lettering, buttons, placket, zipper or front pockets onto the back. Unless the garment's cut clearly implies a back panel print, the back carries NO graphic at all. Do NOT render the front of the garment.",
  custom:
    " Render the BACK of this custom garment. The back of the garment must be a clean, plain version of the" +
    " front's fabric and color, strictly without the front graphics or logos. Maintain the same seams," +
    " material texture, and drape as the front view. Do not mirror front-specific details to the back." +
    " Negative constraint - avoid printing, logos, or graphic motifs on the back side.",
};

const ANGLE_CLAUSE = {
  front: "",
  // Back, REAL rear reference: the active image IS a dedicated back photo. Tell Lucy to
  // REPRODUCE it - and pin the print's size/position to the reference so the graphic
  // doesn't drift, rescale or re-center between frames (the back-alignment ask).
  backReal: REAR_POSE + BACK_TAIL.real,
  /* Back, INFERRED rear: no dedicated back photo - the active image IS the front, so
     Lucy must infer a plausible rear from it (graceful fallback; placement can't be
     pinned). THE PRINT-DUPLICATION FIX: the previous wording asked for "any back
     graphics, prints or seams" while the only graphic in view was the FRONT chest
     print - so the model dutifully reproduced that print on the back. The reference
     is now named as the front explicitly, front-only elements are enumerated as
     forbidden (the model cannot avoid what it hasn't been told to avoid), and the
     default rear is stated as PLAIN. Mirrors CUSTOM_BACK_INFERRED, which already
     carried this constraint and did not exhibit the bug. */
  backInferred: REAR_POSE + BACK_TAIL.inferred,
  side:  " The person is viewed from the SIDE in profile: render the garment's side profile - shoulder line, sleeve, side seam and the way the fabric drapes along the flank - in an accurate three-quarter/profile perspective.",
  // AI Auto, facing camera: the reference is ONE clean front asset (no composite), so the
  // clause pins it explicitly as the front and forbids inventing rear details - the
  // orientation contract that makes Context-Aware Asset Switching bleed-proof.
  autoFront:
    " This reference photo shows the FRONT of the garment. The person is facing the camera:" +
    " reproduce the garment's front faithfully - its front panel, collar, closure, hemline and" +
    " any front graphics, prints, logos or lettering - keeping each element at the SAME size," +
    " height and horizontal position as in the reference. Do NOT render the back of the garment.",
  /* Single-asset counterpart of COMPOSITE_POSE.profileFront - same reasoning, same fix,
     for the path where the reference is one photo rather than a stitched pair. autoFront
     above opens by asserting "The person is facing the camera", which is the sentence
     that has to go when they are edge-on; the garment side it names is still correct,
     because the orientation lock did not move. */
  autoProfile:
    " This reference photo shows the FRONT of the garment. The person is TURNED TO THEIR SIDE," +
    " seen EDGE-ON in side profile at roughly a right angle to the camera, so the garment's front" +
    " faces off to one side rather than toward you: render the garment in that true side-on" +
    " perspective - the shoulder line, sleeve, side seam and the way the fabric drapes along the" +
    " flank - keeping its colour, texture and any visible front graphics faithful to the reference." +
    " Do NOT rotate, straighten or re-pose the person back toward the camera, and do NOT re-render" +
    " this as a front-facing shot.",
};

/* ── Side-profile depth fidelity - the volume that only exists edge-on ────────
   THE BUG THIS EXISTS FOR: a shopper with real torso depth (the test case was a pillow
   under a shirt) turns 90 degrees and the rendered body comes back flat - the garment
   drapes over a generic torso instead of over their actual projection.

   The mechanism is a blind spot in the prompt, not in the detector. Head-on, the body's
   width carries its shape and STRICT_INPAINT's "do not slim, flatten or idealize" is
   phrased for exactly that: it enumerates waist circumference and torso WIDTH. Edge-on,
   width is foreshortened to nearly nothing and the entire silhouette is DEPTH - how far
   the chest and stomach project forward, how the back curves behind. No clause in the
   prompt named that axis, so nothing defended it, and a diffusion model with a strong
   prior toward flat profiles had no instruction standing against that prior at precisely
   the angle where it is most exposed. This names the axis and pins it to the live frame's
   own silhouette edge, which is the only ground truth available in a pipeline with no
   depth sensor and no mesh.

   Complements rather than repeats its neighbours: PROFILE_ANOMALY_GUARD scopes out what
   is NOT body (held objects, lens distortion) while turned; this asserts what IS body and
   must survive. STRICT_INPAINT's ABSOLUTE BODY FIDELITY still governs at every angle -
   this is its profile-axis form, not a replacement. */
/* Structured as four numbered directives rather than one paragraph. Position and framing
   both matter for this model: the clause leads with WHERE THE BODY IS, because every
   instruction after it is relative to that, and the numbering keeps the four asks
   individually addressable instead of dissolving into a wall of qualifiers. */
const SIDE_PROFILE_DEPTH =
  " SIDE-PROFILE DEPTH FIDELITY - four requirements for this frame." +
  " (1) ORIENTATION: the person is positioned EDGE-ON, IN SIDE PROFILE, facing LATERALLY" +
  " relative to the camera frame - turned roughly a right angle away from the lens, so you" +
  " see the side of their body rather than its front or its back." +
  " (2) GROUND TRUTH: the lateral silhouette edge in the live frame - including any abdominal" +
  " curve, stomach or belly projection, chest depth, curve of the lower back and seat, and the" +
  " bulk of the clothing itself - is ABSOLUTE GROUND TRUTH and overrides any assumption you" +
  " hold about how a body is shaped. Because they are edge-on, that outline is their real" +
  " FRONT-TO-BACK DEPTH, not their width. Trace it exactly as it is. Any protrusion, bulge," +
  " overhang, rounding or expansion along that edge is REAL BODY VOLUME and must be preserved" +
  " at its exact depth, height and position, however far it extends." +
  " (3) FORESHORTENING: maintain the full side-view foreshortening exactly as captured. Do NOT" +
  " rotate, turn or twist the person's chest, waist, hips or shoulders back toward the front" +
  " camera view, and do NOT widen the torso back toward a front-facing silhouette. Do NOT" +
  " substitute a typical, average, slimmer, athletic or idealized profile; do NOT flatten," +
  " straighten, compress or pull the stomach, chest, belly or back edge inward toward the" +
  " spine; do NOT reduce the torso's front-to-back thickness." +
  " (4) DRAPE: wrap and drape the selected garment fabric seamlessly over those exact profile" +
  " contours, preserving their true physical depth - the side seam following their real side" +
  " contour, the fabric projecting outward wherever their body does, falling from the point of" +
  " greatest protrusion with natural tension, creases and fold shadows beneath it." +
  " Fit the garment to the body's true volume; never the body to the garment.";

/* ── Lateral seam synthesis - the band that NO reference view depicts ─────────
   THE GAP THIS FILLS, and why it is not the same gap SIDE_PROFILE_DEPTH fills. That
   clause is about the BODY: it pins the silhouette edge as ground truth so the shopper's
   real front-to-back volume survives. This one is about the GARMENT covering that edge.

   At 90 degrees the camera sees a band of the garment that neither reference view
   contains - the flank, the side seam, the underarm, the outer face of the sleeve. The
   composite holds a FRONT panel and a BACK panel; the side is the hinge between them and
   is photographed by neither. With nothing in the prompt naming that band, the model is
   inpainting a region it has no reference for, and the cheapest completion available to
   it is the pixels already there: the shopper's own real shirt. That is the "it drops the
   garment when I turn" report, and it is a DIFFERENT mechanism from the reversion
   ROTATION_CONTINUITY covers (that one is about the turn as a temporal event; this is
   about a spatial region being unreferenced at the moment of peak exposure).

   WHY THIS DOES NOT SAY "BLEND THE TWO PANELS", which is the obvious phrasing and the
   wrong one. COMPOSITE_PANEL_CONTRACT opens the prompt by calling the boundary between
   the panels an impassable wall, and COMPOSITE_APPLY then retires the unselected panel
   outright ("does not exist for this frame"). Instructing a blend here would contradict
   the two strongest, earliest instructions in the prompt, and the way that contradiction
   resolves in practice is already on the record: rendering both panels' designs on one
   surface is the double-print regression that got the previous stitcher removed in
   23f5953. So the synthesis is specified GEOMETRICALLY - the garment wraps, the side seam
   is where the wrap turns - while the locked panel remains the only texture source and
   the unreferenced band is filled by EXTRAPOLATING its cloth, never by dragging the
   opposite panel's graphics around the body. Continuity of fabric, not of print.

   Prompt-only, so it costs nothing at runtime: it rides the same assembly path every
   other clause does and is re-asserted by the existing re-anchor cadence. */
const LATERAL_SEAM_SYNTHESIS =
  " LATERAL SEAM SYNTHESIS - the side of the garment must be PREDICTED, not skipped." +
  " No reference view depicts the narrow lateral band now facing the camera: the flank," +
  " the side seam, the underarm and the outer face of the sleeve. Synthesize it." +
  " (1) CONTINUITY MANDATE: hold 100% garment replacement coverage across the entire" +
  " visible torso for every frame of the turn. There must be no frame, and no region of" +
  " any frame, in which the target garment thins, breaks, fades, turns transparent or lets" +
  " the person's own original shirt - its colour, collar, sleeves or hem - show through" +
  " anywhere, least of all along the flank, the shoulder line or the underarm." +
  " (2) WRAP: render how this garment continues around the torso's lateral depth - the" +
  " side seam running down their real side contour, the shoulder seam and sleeve head" +
  " turning with the shoulder, the hem closing unbroken around the flank, and the fabric" +
  " folding and gathering where the arm meets the body." +
  " (3) EXTRAPOLATE, NEVER RELOCATE: carry the colour, weave, sheen, material thickness" +
  " and fold behaviour of the reference view named above outward across that band, so the" +
  " side reads as the same garment in the same cloth and the transition into it is smooth" +
  " and gradual, with no hard edge, colour step, seam artifact or texture break. Where the" +
  " reference depicts no lateral detail, infer PLAIN fabric in that same colour and" +
  " texture. Do NOT drag, mirror, wrap or repeat the reference's graphics, prints, logos" +
  " or lettering around onto the side to fill it, and do NOT invent new ones there.";

/* ── Stitched Garment Composite - orientation clauses ────────────────────────────
   Deliberately modelled on LOOK_CLAUSE below, which is the in-repo proof that a
   labelled two-panel reference works with this model: name the panels, forbid
   cross-panel sampling in absolute terms, and state that the markers are guides that
   must never be painted onto the garment.

   The critical difference from the composite that was removed in 23f5953: that one
   left the model to decide which half applied. Here the OrientationWatcher has
   already resolved that, so exactly ONE panel is ever named as the source, and the
   other is explicitly excluded. The model is never asked to choose. */
/* The panel contract. States WHAT the reference image is, before anything else in the
   prompt describes the garment or the body. Everything downstream (COMPOSITE_SELECT,
   buildCompositePrompt) assumes this has already been said. */
const COMPOSITE_PANEL_CONTRACT =
  "High-quality, realistic virtual try-on." +
  " The garment reference is a SPLIT COMPOSITE IMAGE containing two views of the SAME garment," +
  " side by side: the LEFT HALF is the FRONT view, the RIGHT HALF is the BACK view." +
  " Treat the boundary between them as an impassable wall - never blend, mirror or copy any" +
  " detail from one half into the other, and never render both halves' designs on the same" +
  " surface of the garment." +
  /* The artifact clause. Everything that is not garment in this reference - the gap between
     the panels, the studio backdrop, the canvas edges, the marker band along the bottom -
     is layout, and Lucy has no way to know that unless it is said. It samples texture from
     the whole reference, which is how a divider became a seam painted down a shirt. The
     canvas fix (seamless sampled gutter, markers moved off the garment) removes most of
     the opportunity; this removes the rest. */
  " IGNORE ALL CANVAS FURNITURE. The gap between the two halves, the background field, the" +
  " outer canvas edges and the 'FRONT'/'BACK' text markers below the panels are layout" +
  " scaffolding, NOT part of the garment. Never reproduce a boundary, divider, seam, border," +
  " frame, band or letterform from this reference onto the clothing, the body or the scene." +
  " The only lines you may render on the garment are its own real seams, stitching and hems.";

/* Temporal contract. Appended LAST so it is the final instruction in the prompt, and
   carried on BOTH orientations - flicker is not a back-view-only problem.

   Read the honest limits here before tuning it. Lucy regenerates every frame independently;
   there is no cross-frame state, no seed and no motion-guidance parameter exposed by
   @decartai/sdk@0.1.5 (realtime connect takes model/fps/width/height/mirror/resolution/
   codec, and set() takes exactly { prompt, enhance, image } - see connectRealtime()). So
   this wording is a per-frame bias toward the same result, not a temporal filter, and it
   cannot be one. The mechanical half of the flicker fix is in applyGarment(): a confirmed
   turn now re-issues the PROMPT alone instead of re-uploading the reference image, so the
   model is never briefly without a garment reference at the exact moment the shopper
   turns. That is what actually stops the print vanishing mid-rotation. */
/* Trimmed once ROTATION_CONTINUITY landed: that clause now carries the "garment stays on
   through the turn" half, so repeating it here only spent tokens against the panel
   contract. What is left is the part specific to a two-panel reference - the PRINT's
   stability, frame to frame. */
const COMPOSITE_TEMPORAL =
  " Render with smooth, temporally consistent frame-to-frame output: the garment keeps the" +
  " same colour, print placement and scale in every frame, with ZERO flickering, popping," +
  " strobing or drifting. The print must never vanish, fade or re-position between frames.";

/* Orientation selector. The OrientationWatcher has ALREADY resolved which way the shopper
   is facing, so exactly one panel is ever named as the source and the other is excluded in
   absolute terms ("does not exist for this frame") rather than merely deprioritised - the
   model is never asked to choose. The back clause is phrased as an EXTRACT-and-APPLY
   instruction, not a "reproduce the reference" one: the task is a texture transfer from a
   named region of the reference onto a named region of the body, and naming both ends of
   that transfer is what the previous wording left implicit. */
/* Split into POSE + APPLY so the two can vary independently.

   They answer different questions and only one of them depends on how far the shopper
   has turned. APPLY is a texture-transfer instruction - WHICH panel of the reference is
   the legal source - and it stays correct at every rotation, because the orientation
   lock that picked the panel is unchanged. POSE is a claim about the body in the live
   frame, and it is the half that goes WRONG the moment the shopper is edge-on: see
   COMPOSITE_POSE.profileFront for the failure it caused. The concatenation below
   reproduces the previous strings byte for byte - this is a refactor to create a seam,
   not a rewording. */
const COMPOSITE_APPLY = {
  front:
    " Apply the LEFT PANEL (FRONT view) design to the FRONT of their body: extract that panel's" +
    " exact texture, print, graphic, logo, lettering and colour and render it on the front of the" +
    " garment they are wearing - its front panel, collar, closure and hemline - keeping every element" +
    " at the SAME size, height and horizontal position it has in that panel." +
    " The RIGHT PANEL does not exist for this frame: none of its content may appear anywhere in the output.",
  back:
    " Accurately EXTRACT the exact garment texture and print from the RIGHT PANEL (BACK view) and RENDER" +
    " IT ONTO THE BACK of the person: its back print, graphic, logo, lettering, colour blocking, rear yoke," +
    " back collar and rear hemline, each kept at the SAME size, height and horizontal position it has in" +
    " that panel, wrapping naturally around the torso and following the fabric as they move." +
    " The LEFT PANEL (FRONT view) does not exist for this frame: its chest print, front logo, front" +
    " lettering, buttons, placket, zipper and front pockets must NOT appear anywhere on the back you render.",
};

/* THE 90-DEGREE POSE LIE, and why the profile variants exist.

   The orientation lock is BINARY (front | back) and, by design, it holds through a turn:
   skinRatioVote()'s dead band abstains on an ambiguous frame rather than voting, so at a
   true side-on pose the lock simply stays wherever it last was. Everything about that is
   correct for choosing an ASSET - a profile frame genuinely does not justify flipping the
   reference.

   What was not correct is that the pose sentence rode along with it. At 90 degrees the
   prompt asserted "The person is FACING FORWARD, the front of their body toward the
   camera" (or, from the other lock, "has TURNED AROUND ... no face visible") while the
   pixels showed the shopper edge-on. Lucy regenerates every frame from the prompt plus
   that frame, so a categorical pose claim that contradicts the input is not a harmless
   inaccuracy: reconciling it means rotating the torso back to the asserted view, and a
   torso rendered as front-on has no profile depth left in it. The shopper's real
   front-to-back volume - which is ONLY visible edge-on, and is exactly what a pillow
   under a shirt is testing - is what gets normalised away. That is the "it falls back to
   a default body" report.

   So the profile poses do two things the front/back poses cannot: they describe the
   rotation truthfully instead of asserting a facing, and they explicitly forbid the
   de-rotation. They still name the locked side, because which half of the garment is
   toward the camera is still known and still steers the panel that APPLY selects. */
const COMPOSITE_POSE = {
  front: " The person is FACING FORWARD, the front of their body toward the camera.",
  back:
    " The person has TURNED AROUND and is presenting their BACK to the camera - rear view, the back of" +
    " their body toward you, no face visible.",
  profileFront:
    " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right angle" +
    " to the camera - you are seeing the side of their body, with the front of the garment facing off to" +
    " one side rather than toward you. Render them at the exact rotation shown in the live frame:" +
    " do NOT rotate, straighten or re-pose them back toward the camera, and do NOT re-render this as a" +
    " front-facing shot.",
  profileBack:
    " The person is TURNED TO THEIR SIDE and is seen EDGE-ON, in side profile, at roughly a right angle" +
    " to the camera - you are seeing the side of their body, part-way through turning away, with the back" +
    " of the garment facing off to one side rather than squarely away from you. Render them at the exact" +
    " rotation shown in the live frame: do NOT rotate, straighten or re-pose them, and do NOT re-render" +
    " this as a square rear shot.",
};

const COMPOSITE_SELECT = {
  front: COMPOSITE_POSE.front + COMPOSITE_APPLY.front,
  back:  COMPOSITE_POSE.back  + COMPOSITE_APPLY.back,
};

/* Same panel contract, same texture source, truthful pose - selected when the watcher
   reports the shopper is edge-on. Pairs with SIDE_PROFILE_DEPTH, which supplies the
   positive instruction about what the silhouette edge means; this one only stops the
   prompt from asserting a facing that is not there. */
const COMPOSITE_SELECT_PROFILE = {
  front: COMPOSITE_POSE.profileFront + COMPOSITE_APPLY.front,
  back:  COMPOSITE_POSE.profileBack  + COMPOSITE_APPLY.back,
};

/* Trimmed photorealism tail for composite mode, replacing QUALITY_SUFFIX + HEM_DETAIL.
   Two reasons, both specific to a two-panel reference:
     • LENGTH. Those two constants alone run ~660 characters of boilerplate that competes
       with the panel contract for the model's attention (see buildCompositePrompt).
     • CONTRADICTION. HEM_DETAIL says "preserve the garment's printed graphics, logos and
       text at their original scale, proportion and relative position" without naming a
       panel. Against a reference holding TWO sets of graphics that reads as "render both"
       - the double-logo symptom that got the previous stitcher removed in 23f5953. The
       per-panel form of that same instruction already lives inside COMPOSITE_SELECT,
       scoped to the one panel actually in play. */
const COMPOSITE_QUALITY =
  ", photorealistic real-world fabric texture with visible seams and stitching, natural" +
  " lighting matching the user's room, and natural material physics - no glitching, banding," +
  " tearing or unnatural structural folds";

/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN BUDGET - why every clause above this line was rewritten into a phrase
   ───────────────────────────────────────────────────────────────────────────
   Decart rejects an over-long prompt outright:

     "Prompt is too long: 1376 tokens (maximum 226, including the end-of-sequence
      token). Please shorten the prompt."

   That is not a soft quality signal - set() fails and the shopper gets NO garment.
   Measured against that 226-token ceiling (~904 characters at English prose's ~4
   chars/token), what this file had been assembling was:

       composite square-on   6,718 chars  ~1,680 tok    7.4x over
       composite edge-on    10,077 chars  ~2,520 tok   11.2x over

   SIDE_PROFILE_DEPTH alone was 454 tokens - twice the entire budget for a single
   clause. So this could not be a trim. Every long constant this file spent its
   history growing (each one written against a real, reproduced regression) had to
   collapse into one short directive, and several had to go entirely.

   WHAT WAS KEPT, and the order is the triage. The budget buys roughly a dozen short
   directives, so they are ranked by what breaks without them and dropped from the
   bottom when a particular garment's description runs long:

     CORE  panel contract, panel selection, pose, the substitution itself, and -
           edge-on only - body depth. Without any of these the render is simply
           wrong (wrong half of the garment, wrong rotation, flattened body).
     HIGH  body fidelity and model-agnostic extraction: the two most-reported
           failures ("it slimmed me", "it gave me the model's shoulders").
     MED   opposite-layer lock, background/person lock, lateral wrap.
     LOW   rotation continuity, fit modifier.
     TRIM  temporal stability and photorealism - the model's own priors already
           favour both, so these are the cheapest to lose.

   WHAT WAS LOST, stated plainly because it is real: the enumerated negatives are
   gone. STRICT_INPAINT's per-item list, BACK_TAIL's explicit "do not copy the front
   print onto the back", IGNORE_SOURCE_ARTIFACTS' watermark/badge list, and
   PROFILE_ANOMALY_GUARD entirely. Each was written because naming a failure
   explicitly is what stopped it. At 226 tokens there is no room to name them, so
   these prompts are a weaker instrument than what they replace - they are simply the
   strongest instrument that FITS. If a specific regression returns, the fix is to buy
   its directive back by dropping something in TRIM, not to grow the prompt.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Drop order. CORE is never shed - if a prompt cannot fit with CORE alone, it is
   truncated instead (see fitPrompt), because a slightly clipped prompt still renders
   while a rejected one renders nothing. */
const P = Object.freeze({ CORE: 0, HIGH: 1, MED: 2, LOW: 3, TRIM: 4 });

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  STRICT IMAGE-ONLY CONDITIONING - one static string, for every dispatch.  ║
   ╚══════════════════════════════════════════════════════════════════════════╝
   THE REPORTED FAILURE: a Spider-Man graphic tee, selected in the catalog and
   correctly delivered to the wire, rendering as a tuxedo with a bowtie. Twice - the
   first fix (an image-first anchor, with the garment description removed but the
   structural clauses kept) did not stop it.

   THE MECHANISM. Decart's realtime set() takes { prompt, image, enhance } and NOTHING
   else - no negative_prompt, no image-strength, no ControlNet weight (verified against
   @decartai/sdk@0.1.5 setInputSchema). The ONLY lever this app has over how hard the
   reference image is weighed against the text is HOW MUCH TEXT THERE IS. Every
   remaining clause, however structural, is another token competing with the pixels for
   the model's attention, and the first fix left roughly a dozen of them.

   THE MODE THIS IMPLEMENTS: the prompt stops being generated at all. It is one frozen
   string, byte-identical on every dispatch, for every garment, every angle, every pose
   and every shopper. It cannot contradict the reference because it says nothing the
   reference could contradict, and it cannot dilute it because there is nothing left to
   shed. The SDK requires a non-empty prompt, so this is the smallest thing that
   satisfies that requirement while pointing at the asset.

   WORDING IS PRODUCT-SPECIFIED - do not paraphrase, do not interpolate, do not append.
   `${...}` inside this string is how a description gets back in, one field at a time.

   ── REVISION 5: VOLUME PERSISTENCE, AND THE HEAD-ON CASE ─────────────────────
   TWO REPORTS, from video rather than stills, which is why they are new:

     · A session that starts side-on with correct stomach volume LOSES it part-way
       through a 360-degree turn, ending flat and slim.
     · A session that starts head-on renders flat from the first frame - no frontal
       convexity at all, the garment sized off shoulder width alone.

   ── READ THIS BEFORE TUNING THE PERSISTENCE SENTENCE ─────────────────────────
   The reported root cause is "Decart's model state is resetting its 3D depth memory
   across frames". That is close, but it is not a reset: THERE IS NO MEMORY TO RESET.
   Lucy regenerates every frame independently. There is no cross-frame state, no seed and
   no motion-guidance parameter exposed by @decartai/sdk@0.1.5 - realtime connect takes
   model/fps/width/height/mirror/resolution/codec, and set() takes exactly
   { prompt, enhance, image }. This file has that written down already, in
   COMPOSITE_TEMPORAL's comment, and it is the single most important limit to hold in mind
   here: NO PROMPT CAN CREATE PERSISTENCE THIS PIPELINE DOES NOT HAVE.

   What the sentence CAN do, and does, is bias each independently-generated frame toward
   the same interpretation - which is exactly why the failure looks progressive. Every
   frame re-derives the body from the live pixels; a square-on frame carries strong volume
   evidence, and a mid-turn frame is foreshortened and partly occluded, so the evidence
   weakens and the model falls toward its prior, which is slim. Naming the quantities that
   must not change (abdomen depth, waist volume, torso thickness) and the transition they
   must survive (360-degree rotation, mid-stream) raises the floor on those weak-evidence
   frames. It is a per-frame bias, not a temporal filter, and it cannot be one - so if
   volume still decays mid-turn, the answer is NOT stronger persistence language. It is
   that the weak-evidence frames need better evidence, which is a pipeline change (the
   reference, the crop, the input resolution), not a prompt change.

   THE HEAD-ON SENTENCE is the more tractable of the two, and it fills a real gap. Every
   revision since the abdomen reports began has described volume in terms a PROFILE makes
   visible - depth, contour, silhouette. Head-on, none of those are measurable from the
   frame: the stomach's projection is toward the camera, along the axis with no extent in
   a 2D image, so a model with nothing else to go on sizes the garment off shoulder width
   and renders flat. That is not the model failing to follow an instruction; it is the
   instruction not applying. The fix names what frontal volume actually looks like -
   convexity, forward hem extension, lighting falloff - which are the 2D cues a viewer
   reads as depth, and the only ones available at 0 degrees.

   ── WHAT THIS REVISION REINTRODUCES, and it is a knowing risk ────────────────
   "Natural fabric drape" and "forward hem extension" are the vocabulary revision 4
   removed, because drape-and-hem language is also how a designer describes a knotted or
   gathered hem - and that produced the front-knot artifact. They are back because the
   head-on case cannot be described without them: convexity has to be rendered as
   something, and drape and hem projection are what it is rendered as.
   Two things make this less exposed than revision 3 was: the language is SCOPED to
   front-facing views rather than stated as a general physics goal, and the structural
   boundary ("a closed back and normal un-knotted hem") is still on the wire immediately
   after it. If the knot returns, that scoping is the first thing to tighten - not the
   boundary, which is already as explicit as it can be.

   NOTE ALSO: revision 4's four-artifact enumeration ("do NOT generate front knots, tied
   fabric, open slits, or floating back flaps") is gone, leaving only the positive
   boundary. That is exactly the step revision 4's own risk note said to take if the named
   negatives proved counterproductive, and it happens to be the right shape for a prompt
   that has otherwise grown - the boundary sentence still states the correct structure
   completely on its own, which is why it was written to lead its own enumeration.

   ── REVISION 4: THE PHYSICS LANGUAGE STARTED STYLING THE GARMENT ─────────────
   THREE REPORTS, and the first two are the same mechanism seen from two sides.

     · A KNOT tied into the front hem, over the abdomen.
     · The BACK flaring open into loose floating fabric on a turn.

   Revision 3's third sentence asked for "realistic textile drape, natural tension lines,
   and proper 3D volume wrapping". Every one of those words is also the vocabulary of
   GARMENT STYLING - drape, gathering, tension are what a designer says about a knotted
   hem or an open-backed cut - and a diffusion model has no way to know we meant physics
   rather than construction. Asked for drape over a protruding stomach with no statement
   of what the garment's STRUCTURE is, the most probable way to produce visible drape is
   to give the garment somewhere to drape FROM: a knot, a gather, an open back. It was
   doing exactly what it was told, and what it was told was ambiguous.

   So this revision states the STRUCTURE first and asks for the physics only as a smooth
   wrap. "Standard, continuous t-shirt" is the frame; "normal, flat, un-knotted hem and a
   completely closed back" is the boundary; the four named artifacts are the enumeration.
   The physics vocabulary that invited the styling reading is gone entirely - what
   survives is "smoothly wrap ... around the subject's true body volume and stomach",
   which asks for the same outcome without ever naming a construction technique.

     · THE THIRD REPORT: the fit only came out right when the session STARTED at 90
       degrees; face-on it flattened. Revision 3 said "from all angles", which is true and
       useless - a model has no reason to treat an unenumerated range as including the
       case it is currently getting wrong. Both angles are now named explicitly, 0-degree
       front alongside 90-degree side, so neither is the default the other is measured
       against.

   ── TWO THINGS THIS REVISION TRADES AWAY, recorded because they are real ──────
     1. THE EXPLICIT BODY-DISCARD IS GONE. Revision 3 led with "completely ignoring the
        original model's body size, chest, and waist dimensions" - DENSE.modelAgnostic,
        stated outright. What replaces it is "Preserve ONLY the reference image's graphics,
        fabric texture, and color", which implies the same thing by exhaustion but never
        says it. That is a weaker instrument against the "it gave me the e-commerce
        model's shoulders" report, and it is the FIRST thing to restore if that returns:
        DENSE.modelAgnostic is still on file, and appending its sentence is a one-line
        edit. Recorded here rather than discovered later.
     2. THE EXTRACTION DIRECTIVE NO LONGER LEADS. Revision 3 moved it to the front
        deliberately, on this file's oldest lesson - leading tokens dominate - and it is
        now the closing sentence. The lead is still a reference-bound instruction ("a
        standard, continuous t-shirt FROM the reference image"), so the asset is anchored
        in the first clause either way; what moved is the isolation half. If the garment
        itself starts drifting again (wrong colour, wrong print), this ordering is the
        first thing to look at, before adding any words.

   ONE MORE, AND IT IS THE RISKIEST PART OF THIS STRING: "knots", "tied fabric", "open
   slits" and "floating back flaps" are NAMED NEGATIVES. This file's record is that naming
   a rendering FAULT is safe (a stretch, a float - there is no object to steer toward)
   while naming a GARMENT is not (the tuxedo outlived two prompts that banned it by name).
   These sit between: a knot is not a garment type, but it is more object-like than any
   negative shipped since the tuxedo list. They are named because the artifacts are already
   appearing and naming the failure is what has historically stopped it - but if knots
   persist or spread, deleting the enumeration and keeping only the positive boundary
   ("Maintain a normal, flat, un-knotted hem and a completely closed back") is the next
   thing to try, NOT a longer list.

   ── REVISION 3: THE REFERENCE IS A 2D MATERIAL, NOT A DRESSED PERSON ─────────
   THE SYMPTOM THAT SEPARATES THIS FROM THE REVISION BELOW: the previous wording asked
   the garment to conform to the shopper's real abdomen and it did - by STRETCHING. A
   flat 2D projection pulled forward over a torso that was still rendered thin, rather
   than cloth wrapping a volume. The shirt looked painted onto a protrusion, or floating
   in front of one.

   WHY THE PREVIOUS WORDING PERMITTED IT. It said "conform to the user's abdomen depth"
   without ever saying what the reference IS, so the model kept reading the packshot as a
   photograph of a dressed person - complete with that person's 3D geometry - and then
   deformed the whole assembly to fit. Deforming a thin body to cover a wide one is a
   stretch. There was no instruction to discard the source geometry and treat what remains
   as material, so the strongest available reading was the literal one.

   THE FIX IS AN ORDERING CHANGE AS MUCH AS A WORDING ONE. The extraction sentence now
   LEADS, and this file's whole record says leading tokens dominate: the first thing the
   model is told is that the reference is fabric texture, colour and pattern - a 2D
   material sample - and that the original model's size, chest and waist are to be ignored
   outright. Only once that is established does the drape instruction follow, so what gets
   draped is cloth rather than a re-proportioned photograph.

   THE THIRD SENTENCE IS NEW and is the physics the first two only imply: textile drape,
   natural tension lines, 3D volume wrapping, "whether large or small" (which removes the
   assumption rather than arguing with it), and the two reported artifacts named directly -
   2D stretching and floating. Naming the specific wrong output is this file's oldest
   working mechanism and it is safe here for the same reason "flat torso" was: these are
   RENDERING FAULTS, not garments, so there is no object for the sampler to steer toward.

   ── REVISION 2: BODY CONFORMATION FOLDED IN ──────────────────────────────────
   The first version of this string said only "render the provided asset, invent nothing".
   That fixed the garment but exposed the BODY: a shopper with a real waistline (the test
   case is a pillow under a shirt) got the slim proportions of the e-commerce model
   wearing the shirt in the catalog photo, and the fabric hovered off their actual
   silhouette instead of draping over it. The cause is the same unstated-region mechanism
   this file documents everywhere - a catalog reference is almost always model-worn, so
   there are TWO bodies in the conditioning and nothing said which one to fit.

   The three directives that used to cover this were separate, shed-able clauses -
   DENSE.bodyFidelity, DENSE.modelAgnostic and DENSE.profileLateral - and all three were
   retired when the prompt froze. They are back, but INSIDE the frozen string rather than
   beside it, which is the whole point: they cannot be shed, cannot be reordered, and
   cannot be separated from the instruction they qualify.

   ── THE FIVE SENTENCES ON THE WIRE TODAY ──────────────────────────────
     1. STRUCTURE + THE VOLUME CLAIM: "a standard t-shirt from the reference image ... with
        strictly persistent 3D body volume". Structure still leads (revision 4's fix for
        the knot and the open back), and the persistence claim is attached to it rather
        than left for a later sentence, so the very first thing stated about this render is
        that it has a body with volume in it.
        THE ONE COMPROMISE, unchanged from revision 4: "t-shirt" is a garment NOUN, of
        exactly the kind SHIRT_NOUN/SUBTYPE_PROMPT were retired for naming. Correct for the
        upper-body catalog and every case reported so far; WRONG for lower_body items
        (Nimbus) and long-sleeve tops, where it asserts what the reference contradicts. If
        trousers render as a shirt, this noun is the cause and "garment" is the one-word
        fix - see SUBTYPE_PROMPT's retired-noun note for the mechanism.
     2. PERSISTENCE: the exact same abdomen/stomach depth, waist volume and torso thickness
        through all 360-degree rotations, never flattening or resetting mid-stream. Three
        quantities named individually because "volume" alone is satisfiable by any one of
        them, and the transition named explicitly because the failure is progressive rather
        than static. Read the limit above before touching this: it is a per-frame bias, not
        a state lock, and it cannot be made into one from here.
     3. FRONTAL CONVEXITY: at 0 degrees, render the stomach's forward volume through fabric
        drape, forward hem extension and lighting falloff. The gap every previous revision
        left - depth, contour and silhouette are all profile-visible quantities, and none of
        them is measurable head-on, where the projection points at the camera. These three
        are the 2D cues that read as depth, and the only ones available at that angle.
     4. BOUNDARY: a closed back and a normal un-knotted hem. Revision 4's four-artifact
        enumeration is gone; this is the positive half it was deliberately written to lead,
        and it states the correct structure completely on its own.
     5. EXTRACTION: use ONLY the reference's graphics, fabric texture and colour. The
        provenance split, still reduced to its positive half - it implies the body-discard
        by exhaustion but does not state it. See "two things this revision trades away"
        under revision 4; that trade is unchanged and DENSE.modelAgnostic is still the
        one-line restore.

   NOTE WHAT LEFT, across revisions: the enumerated "without inventing any tuxedos, suits,
   or unrequested garments" tail, revision 2's "do NOT copy the source model's body frame or
   force a flat torso", and revision 3's physics vocabulary ("realistic textile drape,
   natural tension lines") - the last because it was read as STYLING and produced the knot.
   The tuxedo tail is deliberate and is this file's own recorded next step: with no
   negative_prompt field a named garment ships in the POSITIVE prompt where the sampler can
   steer toward it, and the tuxedo outlived two versions that named it. If invented garments
   return, do not re-add that noun list; re-read the DENSE table's assetLock comment for why
   it made things worse.

   ── WHAT WENT WITH IT, and how to get any of it back ─────────────────────────
   Every clause the builders assembled is retired from the prompt path. They are all
   still on file (see the DENSE table below, and the RETIRED block above it) with the
   reasoning that produced them, because each one is a reproduced regression:

     · the garment description  colour word + subtype noun, interpolated from catalog
                                metadata. The original tuxedo cause - a text
                                description is something a diffusion model can satisfy
                                from its own prior instead of from the reference.
     · assetLock                the enumerated ban ("never invent a ... suit, TUXEDO,
                                tie, BOWTIE"). With no negative_prompt field those
                                nouns shipped in the POSITIVE prompt, where a named
                                garment is a token the sampler can steer toward.
     · contract + select        the FRONT|BACK panel contract. Retiring this is what
                                forces COMPOSITE_DEFAULT to false - see its comment; a
                                split reference is unreadable without the text that
                                explains it, and shipping one anyway is how the
                                23f5953 double-print bug comes back.
     · pose / poseProfile       front/back/edge-on. The reference asset itself now
                                carries the orientation (the watcher swaps the photo),
                                so the pose sentence is the model's job to read off
                                the live frame, which is where it always came from.
     · profileLateral           the 90-degree flank/depth directive. SUPERSEDED, not
                                simply lost: the frozen string's "from all angles,
                                including 0-degree front and 90-degree side views" states
                                the same coverage with no pose flag to gate it - which
                                matters more than it reads, since nothing dispatches on a
                                profile transition any more. Same for bodyFidelity
                                ("the subject's true body volume and stomach"). NOT the
                                same for modelAgnostic - revision 4 reduced that one to an
                                IMPLICATION ("Preserve only ... graphics, fabric texture,
                                and color"), which is the weakest it has been. See the
                                revision notes above; it is first on the restore list.
     · inpaintLock              face/skin/hands/background passthrough. THE LARGEST
                                LOSS and the one to restore first if the model starts
                                repainting the shopper's room or face: nothing else
                                stands between this prompt and a regenerated scene.
     · keepTop / keepBottoms    the opposite-layer lock.
     · ignoreFurniture          the "don't paint the panel divider onto the shirt" ban.
     · fitSentence              the size-override selector's only route into the render.
                                The UI still works and still re-applies; the chosen size
                                no longer changes what Decart draws.

   TO RESTORE ONE: it is a two-line change - reinstate fitPrompt() in the builder that
   needs it and add [P.CORE, DENSE.<clause>] beside IMAGE_ONLY_PROMPT. fitPrompt(),
   clampPromptForWire() and the whole DENSE table are deliberately left intact for
   exactly that. Restore ONE at a time and re-test: the entire premise of this mode is
   that clause count is what was drowning the image. */
/* ── THE CATEGORY BRANCH - "I tried on jeans and it put the model's shirt on me" ──
   The frozen string above was ONE anchor for the whole catalog, and it opened by naming
   a t-shirt. On a trouser product that first sentence is a direct contradiction: the
   prompt says t-shirt, the reference photographs a model wearing a shirt AND trousers,
   and NOTHING told the model which half of that reference was the product. Lucy took the
   whole visual, so the source model's shirt replaced the shirt the shopper was still
   wearing on camera. run.mjs's suite index already named this gap before it was closed
   ("an 'upper garment' anchor on a trouser reference is the same contradiction").

   WHY THE ANCHOR AND NOT A RESTORED CLAUSE. KEEP_TOP/KEEP_BOTTOMS still exist in the
   DENSE table and would say much of this - but they were retired because clause COUNT was
   drowning the image, and adding one back re-enters that competition. Folding the
   opposite-layer lock INTO the anchor costs no extra clause: the sentence that has to
   name the target garment anyway is the same sentence that names what not to touch. It
   also cannot be shed, because it is the anchor.

   THE PROVENANCE HALF IS LOAD-BEARING, not a restatement. "Preserve the live upper
   garment" alone still leaves the reference's shirt as unclaimed territory, and an
   unstated region is precisely what this file's history keeps recording as the thing that
   gets reinterpreted (see STRICT_INPAINT's comment). So the bottoms branch names the
   REFERENCE as the thing not to copy an upper garment from, not just the live frame as
   the thing to keep.

   READ THE LAST BLOCK IN THIS RUN FOR THE CURRENT WORDING. The paragraph above is the
   record of WHY the lock lives inside the anchor rather than beside it, and that
   reasoning still holds. The sentences it describes do not - two revisions have rewritten
   both anchors since. What bottoms carries today is region naming inside its lead ("the
   live subject's CURRENT lower-body contour"); the explicit pin on the opposite layer
   came off with the dynamic-drape revision and is retired as KEEP_OPPOSITE_LAYER. */
/* ── REVISION: STRICT 1:1, BOTH BRANCHES (SUPERSEDED - see DYNAMIC BODY below) ────
   HISTORY, NOT THE LIVE WORDING. This block is the record of the three reports that
   collapsed both anchors to a 1:1 reference lock, and of the fourth that put the
   lower-body scoping back on bottoms. The dynamic-drape revision further down replaced
   both strings; what survives from here is the scoping (folded into the new bottoms lead)
   and the retirement list below, which is still accurate about what is off the wire.
   THE THIRD REPORT IN THIS SEQUENCE, and a different failure from the first two. The
   first was the WRONG REGION (a t-shirt anchor on a trouser reference). The second was
   the WRONG GARMENT (generic black shorts instead of the photographed white ones). This
   one is the RIGHT garment with INVENTED DETAIL - textures and design elements the
   reference never contained.

   So the clamp changed shape. "without inventing new shorts" only forbade SUBSTITUTION;
   it said nothing about embellishing the correct garment. The replacement bans all three
   operations explicitly - invent, add, alter - because adding a stripe and altering a
   stripe are different edits and only the first was previously excluded.

   BOTH BRANCHES ARE COLLAPSED, AND THE CLAMP IS SYMMETRIC. The previous revision cut
   bottoms only, on the principle of one branch at a time on evidence; tops kept its
   seven-sentence assembly. This finishes the job at the product owner's direction: every
   word either string says about the GARMENT is now the same word.

   THE SCOPING IS NOT SYMMETRIC, and that is the one asymmetry left. The collapse also
   took the opposite-layer lock, which re-opened the shirt-replacement report through the
   bottoms branch - the one it was filed against - so 69 characters of lower-body scoping
   went back on THERE and nowhere else. Same rule as every revision before it: one branch
   at a time, on evidence. Full detail in the first bullet below.

   ── WHAT THIS REMOVES, AND WHY IT IS WRITTEN DOWN HERE ──────────────────────────
   Every clause below is a reproduced regression, and all of them came off the wire in
   this revision. ONE OF THEM IS BACK - read the first bullet before the rest:

     · the OPPOSITE-LAYER LOCK - SPLIT IN TWO by the revisions since. Its job was the fix
       for the FIRST report in this sequence: trying on trousers putting the catalog
       model's shirt on the shopper. Collapsing it away left the scoping implicit - "the
       EXACT shorts/pants ... onto the subject" names a garment but no region - and the
       bottoms branch is the exact configuration that report was filed against, so the
       scoping went back on there and nowhere else.
       WHERE EACH HALF LIVES TODAY: the REGION NAMING survives, folded into the new
       bottoms lead ("the live subject's CURRENT lower-body contour"). The explicit PIN on
       the opposite layer does not - it came off with the dynamic-drape revision and is
       retired as KEEP_OPPOSITE_LAYER, one line from being back.
       THE TOPS BRANCH IS STILL IMPLICITLY SCOPED. No shirt-replacement report has been
       filed through it - the reported failure is a trouser try-on repainting the top,
       not the inverse - so tops keeps the shorter string on the same one-branch-at-a-
       time-on-evidence principle the bottoms collapse itself was made under.
       IF SHIRT-REPLACEMENT RETURNS, THIS IS THE CLAUSE TO RESTORE FIRST - it is the only
       loss here that re-opens a previously fixed report rather than degrading fidelity,
       and on tops the restore is the bottoms sentence with the two regions swapped
       (or KEEP_TOP, declared further down this file).
     · VOLUME_PERSISTENCE / FRONTAL_VOLUME - "it slimmed me down", and the head-on
       stomach-projection gap.
     · TEMPORAL_PERSISTENCE - the prompt's half of the late-entry presence fix. The gate
       and the watcher still run for both categories, so the mechanism survives.
     · CLOSED_BACK_HEM - the knotted-hem and open-back-flap artifacts. Still assembled on
       the full-look path, which was never collapsed; off the wire on both single-garment
       branches.
     · REFERENCE_EXTRACTION - superseded rather than lost: the anchor's own fidelity
       sentence states the same provenance rule ("Strictly preserve the original ...
       texture, pattern, and color" today; "Exactly match color, pattern, logos, and cut"
       under the 1:1 revision this block was written for).

   THE RESTORE PATHS ARE NOW UNIFORM, which they were not when this block was written.
   VOLUME_PERSISTENCE, FRONTAL_VOLUME, TEMPORAL_PERSISTENCE, CLOSED_BACK_HEM,
   REFERENCE_EXTRACTION and - since the dynamic-drape revision named it - KEEP_OPPOSITE_
   LAYER are each on file as a constant, so every restore here is one line in
   imageOnlyPrompt(). The budget is not the constraint: tops runs 342 characters and
   bottoms 320 against a 650 ceiling. Anything bought back is a deliberate choice about
   TEXT VOLUME COMPETING WITH THE REFERENCE, which is the mechanism every fidelity report
   in this sequence shares. Add one at a time, and re-test against a live session. */

/* The strict lock. STILL LIVE - lookAnchorPrompt() carries it - but no longer on the two
   single-garment branches, which the dynamic-drape revision below rewrote around a
   different fidelity sentence. Kept in one constant because more than one anchor uses it
   and two copies of a product-specified sentence are two places for it to drift. The
   first sentence supersedes REFERENCE_EXTRACTION (same provenance rule, and it names
   logos and cut); the second is the hallucination clamp, banning all three edits -
   invent, add, alter - because adding a stripe and altering a stripe are different
   operations. Leading space: it is appended to an anchor, never used alone. */
/* THE COLOUR HALF, SPLIT OUT SO IT CAN RIDE WHERE THE WHOLE CLAMP WILL NOT FIT.
   REPORTED: the rendered garment drifts in hue and saturation away from the reference.
   Nothing on the wire was pinning the GARMENT's colour - the "(color, pattern, length)"
   in the category anchor governs the LIVE CAMERA's non-target clothing, which is a
   different region and a different instruction. This is the sentence that pins the target.

   Split rather than duplicated: STRICT_REFERENCE_LOCK below is still the same string it
   has always been (its second sentence is the hallucination clamp, which is about
   INVENTION rather than colour and is what the composite branch has no budget for). */
const REFERENCE_COLOR_LOCK =
  " Exactly match color, pattern, logos, and cut.";
const STRICT_REFERENCE_LOCK =
  REFERENCE_COLOR_LOCK +
  " Do NOT invent, add, or alter any details.";

/* ── REVISION: DYNAMIC BODY, STATIC GARMENT ──────────────────────────────────────
   THE REPORT: a shopper who is fitted at 0 degrees and then turns 90, or who adds real
   profile volume (a cushion under the shirt, a belly the front view does not show), gets
   the ORIGINAL drape stretched and warped over the new shape instead of a garment
   re-draped over it. The fabric smears; the cut distorts.

   THE DIAGNOSIS IS A SPLIT THIS FILE HAD NEVER STATED. Two things are being fused every
   frame, and they have opposite requirements:
     · THE GARMENT is STATIC and INVARIANT. One reference image, one cut, one colour, one
       print, for the whole session. Nothing about the shopper may change it.
     · THE BODY is DYNAMIC and VARIABLE. Its contour, depth, volume and orientation are
       different in every single frame, and the frame is the only place they exist.
   Every previous revision of these anchors said "overlay and fit ... onto the subject" -
   a subject with no tense. A model reading that has no instruction to re-derive anything
   per frame, so the cheapest completion is to keep the drape it already produced and
   deform it to the new outline. That is the reported artifact, restated.

   WHAT THE NEW WORDING DOES, sentence by sentence, on both branches:
     1. binds to the EXACT STATIC garment from the reference (the invariant half), and
        names the target as the subject's CURRENT contour IN THIS FRAME (the variable
        half). "Static" and "current" in one sentence is the whole split;
     2. instructs an ADAPTATION rather than a transform - silhouette, angle, depth and
        volume - and names the two failure modes it must not use to get there
        (stretching, warping / distorting);
     3. re-asserts the invariant on the attributes a re-drape is most likely to smear.

   IT IS PAIRED WITH RUNTIME MACHINERY, and neither half works alone. Text cannot make a
   model re-read a body it is never re-conditioned on: under strict image-only prompting
   the payload is byte-identical from one dispatch to the next, so applyGarment()'s no-op
   skip means a re-anchor sends nothing at all. The CONTINUOUS BODY TOPOLOGY monitor -
   makeBodyTopologyTracker(), sampled by startPresenceWatcher(), dispatched by
   reconditionForTopology() - is what makes this sentence true: it watches the live
   skeleton and forces a real re-conditioning dispatch when the body has actually moved
   away from the shape the current render was drawn against. Read the two together;
   deleting either leaves the other lying.

   ── WHAT THE NEW WORDING GAVE UP, both branches ─────────────────────────────────
   Written down because both are reproduced regressions and this is the file that has to
   admit it if either returns:
     · THE HALLUCINATION CLAMP ("Do NOT invent, add, or alter any details.") is off the
       single-garment branches. What replaces it is weaker by construction: "Strictly
       preserve the original texture, pattern, and color" forbids CHANGING the garment
       but does not forbid ADDING to it. If invented detail comes back, the restore is one
       line - append STRICT_REFERENCE_LOCK to the anchor - and the constant is right above
       so it never has to be rewritten from memory.
     · THE OPPOSITE-LAYER PIN on bottoms ("Keep the subject's upper body and background
       unmodified.") is off with it. The primary half of that fix SURVIVES - the bottoms
       lead still names the region ("the live subject's CURRENT lower-body contour"), and
       an unscoped anchor was the actual configuration the shirt-replacement report was
       filed against - but the explicit pin on the opposite layer is gone. Retired as
       KEEP_OPPOSITE_LAYER below rather than deleted, so that restore is one line too.
   Budget is not the constraint for either: tops runs 342 characters and bottoms 320
   against a 650 ceiling. The constraint is the one every report in this sequence shares -
   TEXT VOLUME COMPETING WITH THE REFERENCE IMAGE. Add one at a time, re-tested live. */

/* Retired with the dynamic-drape revision, kept verbatim so its restore is genuinely one
   line (`[P.HIGH, KEEP_OPPOSITE_LAYER]` in imageOnlyPrompt's bottoms branch) rather than
   a re-derivation. Bottoms only: no report has ever been filed of a TOP try-on repainting
   the shopper's live trousers, so there has never been a tops equivalent to retire. */
const KEEP_OPPOSITE_LAYER = "Keep the subject's upper body and background unmodified.";

/* ── REVISION: MORPHOLOGY + A SYMMETRIC NON-TARGET LOCK ──────────────────────────
   TWO REPORTS, and the second one closes a hole this file opened itself.

   REPORT ONE - BUILD. The drape did not track how wide or narrow the subject actually is:
   on a slender build the garment hung loose, hovering off the shoulders and waist; on a
   broader one it clipped and warped rather than following the outer torso. The previous
   anchors asked for adaptation to "silhouette, angle, depth, and belly volume" - which
   names the DEPTH axis three times and the WIDTH axis not once. These name the width axis
   explicitly, per region: shoulder width and torso drape on tops, waistline and leg width
   on bottoms, both qualified "narrow or wide" so the instruction covers both directions
   rather than reading as "make it bigger".

   REPORT TWO - THE NON-TARGET GARMENT. Try on a shirt, then step back so your legs enter
   frame, and the model would invent trousers it was never asked for (and the mirror case
   for a bottoms try-on and the shopper's real shirt). This is the shirt-replacement family
   of report, arriving through a NEW trigger: not a mis-scoped anchor, but a region that
   simply enters frame mid-session with nothing said about it. An unstated region is what
   this file's history keeps recording as the thing that gets reinterpreted.

   THE OPPOSITE-LAYER LOCK IS BACK, AND THIS TIME ON BOTH BRANCHES. It was dropped in the
   dynamic-drape revision and flagged there as the loss most likely to re-open a fixed
   report; it did exactly that. What ships now is stronger than what was removed: the old
   pin said "keep the subject's upper body and background unmodified", which describes a
   REGION, while these name the shopper's actual CLOTHES as the thing to preserve and
   source them from the camera ("exactly as seen on camera"), then ban all three edits on
   them - changing, inventing, replacing. And it is symmetric: no report has been filed of
   a tops try-on repainting real trousers, but the mechanism is identical and the evidence
   for one direction is evidence for the shape of the other.

   "Fit ONLY" IS DOING WORK, in the first two words of both strings. It scopes the whole
   instruction before any noun is introduced, which is where a leading-token model is most
   sensitive - the same reasoning buildCompositePrompt() records for putting the anchor
   first in the first place.

   ── WHAT THIS TRADES AWAY, written down because both are reproduced regressions ──
     · THE GARMENT-FIDELITY CLAMP. "Strictly preserve the original shirt texture, pattern,
       and color" is gone: that sentence has been REPURPOSED to the opposite layer. The
       garment's own provenance now rests on "the exact reference shirt" alone. Report 3 in
       this sequence (invented detail on the correct garment) and the black-shorts report
       (wrong colour) are the two to watch, and the restore is one line -
       [P.HIGH, STRICT_REFERENCE_LOCK] in imageOnlyPrompt(), the constant is still on file.
     · THE PER-FRAME TENSE. "CURRENT ... in this frame" is gone with it. The runtime half
       is untouched and is what actually re-reads the body (see the topology monitor), so
       what is lost is the prompt's restatement of it rather than the behaviour.
   307 characters are free on tops and 316 on bottoms, so neither loss was forced by
   budget - both are the same deliberate bet every revision here makes: text volume
   competing with the reference image. One at a time, re-tested live. */
const CATEGORY_ANCHOR = Object.freeze({
  /* ── REVISION: THE NON-TARGET LOCK, AIMED AT THE MOMENT IT FAILS ──────────────
     REPORTED WITH A RECORDING: a SHIRT try-on. At 00:00 the shopper is close and their
     legs are out of frame entirely. At 00:03 they lift a leg in - wearing light blue
     shorts - and Decart renders black long trousers over it.

     THE PREVIOUS LOCK WAS ALREADY THERE and did not hold, which is the whole reason for
     this wording. It said "strictly preserve the subject's actual live lower
     clothing/pants exactly as seen on camera" - a statement about a region the model
     could reasonably read as describing what was in frame WHEN THE SESSION STARTED. At
     00:00 there was no lower clothing in frame at all, so at 00:03 there was nothing for
     that sentence to point at, and a region with no referent is the unstated region this
     file keeps recording as the thing that gets invented.

     SO THE NEW WORDING NAMES THE EVENT, not just the region: "for any lower body parts,
     legs, or shorts that ENTER the camera frame DURING THE VIDEO". It also names the
     attributes to carry across (color, pattern, length - length is the one the report
     turned on: shorts became long trousers) and bans all three edits on them.

     THE TWO STRINGS ARE STRUCTURALLY IDENTICAL and mirror each other exactly, because the
     failure is symmetric: a shopper who steps back during a TROUSERS session reveals their
     torso and gets an invented shirt by the same mechanism.

     WORDS ARE A BIAS, NOT A GUARANTEE, and this revision ships the guarantee alongside
     them: the non-target region guard composites the shopper's own camera pixels back over
     that region after the frame returns. Decart's set() has no mask channel, so the prompt
     is the only thing that can ask and the guard is the only thing that can enforce. Read
     them as one fix - see THE NON-TARGET REGION GUARD in this file.

     WHAT CAME OFF: the build/width adjustment sentence ("Dynamically adjust the shirt cut,
     shoulder width, and torso drape to match the subject's exact live body width and build
     (narrow or wide)", and the waistline/leg-width mirror on bottoms). Restoring it is one
     line - append it to the anchor - and the morphology monitor that decides WHEN to
     re-condition is untouched, so what is lost is the prompt's half of the width axis.
     Watch for a loose drape on a slender build; that is the report this would answer. */
  /* ── ORDER REVERSED 2026-08-24: THE PASSTHROUGH LEADS ─────────────────────────
     REPORTED AGAIN, same mechanism as the recording above: the lower body leaves frame,
     re-enters, and comes back in invented trousers. The wording that names the event was
     already on the wire and did not hold - so the lever left is not more words, it is
     WHICH words the model reads first.

     "The leading tokens dominate" is this file's own finding, recorded at
     buildCompositePrompt() where it drove two separate re-orderings. Every revision since
     has spent that lead position on the SUBSTITUTION ("Fit ONLY the reference shirt..."),
     which is the instruction the model was already going to follow - it has a reference
     image for it. The passthrough has no reference image; it is asking the model to leave
     a region alone that it cannot see any evidence for. That is the instruction that
     needs the attention, and it was sitting second.

     COSTS NOTHING AND ADDS NOTHING. Byte-for-byte the same two sentences, in the other
     order: no new clause, no new garment noun, identical length. That matters, because
     Decart's set() has no negative_prompt field - every noun in a ban ships inside the
     POSITIVE prompt, where it is a token the sampler can steer toward. This file records
     two reproduced failures of exactly that (a blue jacket, then a tuxedo with bowtie and
     badge), so "say pants more times" is the one move the evidence rules out.

     ⚠️ THIS IS A BIAS, NOT A GUARANTEE, and the guard below is the guarantee - see
     LOWER_BODY_GUARD_ENABLED in config.js. If the two ever disagree the guard wins,
     because it composites real camera pixels and this only asks. */
  top:
    "For any lower body parts, legs, or shorts that enter the camera frame during the" +
    " video, pass through and strictly preserve the subject's LIVE camera feed clothing" +
    " (color, pattern, length) without generating, replacing, or inventing any new pants" +
    " or garments. Fit ONLY the reference shirt onto the subject's upper torso.",
  bottom:
    "For any upper body parts, torso, or shirt that enter the camera frame during the" +
    " video, pass through and strictly preserve the subject's LIVE camera feed clothing" +
    " (color, pattern, length) without generating, replacing, or inventing any new top" +
    " or garments. Fit ONLY the reference pants/shorts onto the subject's lower body.",
});

/* The surviving halves of the old frozen string, split into individually priority-taggable
   parts. Every one of these is a reproduced regression and the wording is deliberately
   unchanged from the string it came out of - only the t-shirt ANCHOR was replaced.

   WHAT IS STILL ASSEMBLED, so nothing here reads as dead code by accident:
   VOLUME_PERSISTENCE and CLOSED_BACK_HEM ship on the FULL-LOOK path (lookAnchorPrompt),
   which was never collapsed. FRONTAL_VOLUME and REFERENCE_EXTRACTION are referenced by no
   builder at all - retired, not deleted, and kept verbatim because a restore that starts
   by rewriting the clause is not a restore. REFERENCE_EXTRACTION is the newer of the two
   retirements: STRICT_REFERENCE_LOCK's first sentence states the same provenance rule and
   also names logos and cut, so shipping both would spend budget restating one
   instruction. Deleting either constant breaks image-first.test.mjs §1 on purpose. */
const VOLUME_PERSISTENCE =
  "Maintain the exact same abdomen/stomach depth, waist volume, and torso thickness" +
  " continuously through all 360-degree rotations—never flatten or reset body size" +
  " mid-stream.";
const FRONTAL_VOLUME =
  "In front-facing (0-degree) views, realistically render the stomach's forward volume and" +
  " convexity using natural fabric drape, forward hem extension, and subtle lighting falloff.";
/* Both of these describe a SHIRT's construction - the knotted hem and the open back flap
   were top-specific failures - so they are simply not part of a trousers prompt rather
   than being reworded into a lower-body equivalent nobody has reproduced a bug for. */
const CLOSED_BACK_HEM = "Preserve a closed back and normal un-knotted hem.";
const REFERENCE_EXTRACTION = "Use only the reference image's graphics, fabric texture, and color.";

/* ── Temporal persistence - the prompt half of the presence fix ───────────────────
   The presence GATE stops a session opening on an empty frame. This covers what the gate
   cannot: the shopper who is briefly occluded, half out of shot, or steps back in
   mid-window. Every previous revision of this prompt described a subject who was assumed
   to be THERE, so a frame where they are not yet visible had no language attached to it
   at all - and an unstated state is what this file's history keeps recording as the thing
   the model reinterprets.

   "AS SOON AS VISIBLE" IS THE LOAD-BEARING PHRASE, not filler. It tells the model the
   subject may be absent RIGHT NOW and that the correct response is to wait and then fit -
   rather than to fit something to whatever is currently in frame, which is exactly how a
   garment ends up rendered onto a wall or a chair.

   The second sentence is scoped to the OPPOSITE region plus the background, so it
   reinforces the anchor's own isolation rule rather than competing with it. */
const TEMPORAL_PERSISTENCE = Object.freeze({
  top:
    "Continuously track and strictly fit the reference top to the subject's torso as soon" +
    " as visible. Keep lower body and background natural and unmodified.",
  bottom:
    "Continuously track and strictly fit the reference shorts/pants to the subject's lower" +
    " body as soon as visible. Keep upper body and background natural and unmodified.",
});

/* Lower-body tokens. Hebrew FIRST because it is the storefront's primary language, so a
   Hebrew-only product title is the common case here rather than an edge case; both geresh
   spellings are listed (U+05F3 ׳ and a plain ASCII apostrophe) because storefronts use
   them interchangeably. "מכנס" is left unanchored on purpose - Hebrew inflects by suffix
   (מכנסיים/מכנסי) and a prefix match covers the whole family.

   THE ENGLISH SIDE IS \b-ANCHORED AND USES "shorts" PLURAL, DELIBERATELY. A bare /short/
   matches "short_sleeve" - the subType this very file sets on tees - which would classify
   a t-shirt as trousers and repaint the shopper's real jeans: the reported bug, inverted.
   Same reason "sweatpants"/"tracksuit" are listed in full rather than relying on \bpants\b
   to find them inside a compound. */
const BOTTOMS_TOKENS =
  /(מכנס|ג['׳]ינס|חצאי|שורט|טייץ|טייצ|לגינ|\bpants\b|\btrousers\b|\bshorts\b|\bjeans\b|\bskirts?\b|\bleggings\b|\bchinos\b|\bjoggers\b|\bsweatpants\b|\btracksuit\b|\bslacks\b|\bculottes\b|\bbottoms?\b)/i;

/**
 * Which body region a garment belongs to.
 *
 * ORDER IS THE WHOLE DESIGN: garmentType is GROUND TRUTH when present. It is what
 * toItem() sets and what slotOf() already routes the outfit slots on, so a keyword sweep
 * that could override it would let a product NAME re-categorise an item the catalog had
 * already classified correctly - strictly worse than the metadata it second-guesses, and
 * the "Cargo Pants Print Tee" case is not hypothetical. Keywords are consulted ONLY for
 * items that arrived without a category at all (a bare widget handoff, a custom upload).
 *
 * DEFAULTS TO TOPS on absent/unknown input, matching the pre-existing bias of every
 * predicate around it (slotOf() returns "top" for anything not explicitly lower_body):
 * tops are the overwhelming majority of the catalog, so an unknown item guessed as tops
 * is wrong far less often - and its failure mode is the OLD behaviour, not a new one.
 *
 * @param {{garmentType?:string, type?:string, category?:string, subType?:string,
 *          name?:string, title?:string}|null|undefined} item
 * @returns {boolean} true only for a lower-body garment.
 */
function isBottomsGarment(item) {
  if (!item) return false;
  if (item.garmentType === "lower_body") return true;
  if (item.garmentType === "upper_body") return false;
  const fields = [item.type, item.category, item.subType, item.name, item.title]
    .filter(Boolean).join(" ");
  return BOTTOMS_TOKENS.test(fields);
}

/* ── HEM LENGTH: the one attribute of the TARGET garment nothing on the wire binds ──
   REPORTED: a lower-garment try-on renders generic trousers - wrong colour, wrong cut,
   and knee-length shorts coming back as full-length trousers.

   THE WORD "length" IS ALREADY IN BOTH ANCHORS AND POINTS THE WRONG WAY. Read
   CATEGORY_ANCHOR.bottom: "pass through and strictly preserve the subject's LIVE camera
   feed clothing (color, pattern, length)". That is the attribute list for the layer being
   PRESERVED. The sentence about the layer being RENDERED is "Fit ONLY the reference
   pants/shorts onto the subject's lower body" - which names the reference but says nothing
   about reproducing any of its properties. So the prompt spends its only length
   instruction on the garment it is not drawing, and the model is left to pick a hem.

   WHY THIS IS NOT "SAY IT LOUDER". The colour half of the report has an instruction on the
   wire already ("Exactly match color, pattern, logos, and cut"), and this file's last two
   revisions both concluded - against reproduced failures - that restating an instruction
   that did not hold is the one move the evidence rules out. Hem length is different in
   kind: there is NO instruction to restate. This adds information the prompt has never
   carried, which is the only kind of addition those revisions left open.

   ── THREE-WAY, AND THE THIRD CASE IS THE IMPORTANT ONE ─────────────────────────────
   The catalog's bottoms subTypes are "slim" / "regular" / "wide" - CUT, not LENGTH - so
   there is no metadata field that answers this. Length is inferred from the product name,
   which is reliable when a token is present ("Cargo Shorts", "שורט דנים") and absent
   entirely for most of the catalog ("Glide Slim", "Vector Regular").

   SO AN UNRECOGNISED ITEM GETS THE HEDGE, NEVER A GUESS. Asserting "reaches the ankle" on
   an item that is actually shorts is the reported bug, caused by us instead of by the
   model - strictly worse than the status quo, because it is a confident wrong instruction
   rather than a missing one. The unknown branch therefore binds the hem to the REFERENCE
   ("its own hem length, as photographed") without claiming to know what that length is,
   which is still new information: it tells the model the hem is not its to choose.

   ── PHRASED POSITIVELY, WITH NO BANNED OUTCOME NAMED ───────────────────────────────
   "never extend it into full-length trousers" was drafted and rejected. Decart's set()
   has no negative_prompt field, so every noun in a ban ships inside the POSITIVE prompt
   where the sampler can steer toward it - the mechanism behind this file's blue-jacket and
   tuxedo reports, and the reason the last revision refused a "STRICTLY FORBID generating
   generic/hallucinated pant colors" clause. Each branch states only the hem it wants. */
const SHORT_BOTTOMS_TOKENS =
  /(שורט|מכנס\S*\s*קצר|\bshorts\b|\bbermuda\b|\bcut-?offs?\b|\btrunks\b)/i;
/* \bshorts\b stays PLURAL-anchored for the same reason BOTTOMS_TOKENS documents: a bare
   /short/ matches "short_sleeve", the subType this file sets on tees. This only runs on
   items already classified as bottoms, so the blast radius is smaller - but a tee
   mis-classified upstream would then also be told its hem sits above the knee. */
const LONG_BOTTOMS_TOKENS =
  /(ג['׳]ינס|טייץ|טייצ|לגינ|\btrousers\b|\bjeans\b|\bchinos\b|\bslacks\b|\bsweatpants\b|\bjoggers\b|\bleggings\b|\bculottes\b)/i;

/**
 * Hem length for a lower-body garment, inferred from its own text fields.
 * @param {object|null} item
 * @returns {"short"|"long"|"unknown"} "unknown" whenever no token settles it - never a guess.
 */
function bottomsLength(item) {
  if (!item) return "unknown";
  const fields = [item.type, item.category, item.subType, item.name, item.title]
    .filter(Boolean).join(" ");
  if (SHORT_BOTTOMS_TOKENS.test(fields)) return "short";
  if (LONG_BOTTOMS_TOKENS.test(fields)) return "long";
  return "unknown";
}

/* The bottoms-only fidelity clause, one per resolved length. Both sentences describe the
   TARGET garment, which is the half of the report with no instruction on the wire at all.

   POCKETS AND SEAMS are named because they are what distinguishes one pair of trousers
   from the generic pair the model falls back to - and unlike a ban list, they are positive
   attributes of a garment that IS in the reference image, so there is nothing here for the
   sampler to steer toward that the pixels do not already show. That is the line this file
   draws between a description that competes with the reference (the tuxedo mechanism) and
   one that points at it. */
/* ── REVISION: THE SPAN, NOT JUST THE HEM ───────────────────────────────────────
   REPORTED: lower-garment try-ons drift to a generic trouser - the diagnosis offered with
   the report is that the pipeline "defaults to upper-body conditioning" and the lower
   garment has no spatial region tagging, so the reference is not bound to a region and
   the legs fall back to a prior.

   THE PREVIOUS REVISION BOUND ONE END. It added the hem (above the knee / at the ankle /
   as photographed), which is the BOTTOM boundary and was the half the shorts-to-trousers
   report turned on. The TOP boundary was never stated anywhere on the wire: the anchor
   says "onto the subject's lower body", which names a region without saying where it
   starts. A garment with an unstated upper edge is free to ride up the torso, and it is
   the same "unstated region gets reinterpreted" shape this file keeps recording.

   SO EACH BRANCH NOW STATES A SPAN, waist to hem, rather than a hem alone. That is the
   whole of the spatial half: two named anatomical endpoints, and nothing about attention,
   masks or regions in the machine-learning sense - set() has no mask channel and no
   cross-attention control (verified against @decartai/sdk@0.1.5 setInputSchema), so a
   "SPATIAL TARGET:" label would be a token the model reads as prose, not a directive it
   can act on. The endpoints are the part that carries information; the label is ceremony
   that costs the same budget as an instruction. Same trade this file made for the
   "[Dynamic Anatomy Lock: ...]" label.

   COSTS ~2 CHARACTERS PER BRANCH. The hem sentence was already there; "sits at the waist
   and" replaces "its hem", so the span ships essentially for free rather than displacing
   the fidelity clause it sits beside. */
const BOTTOMS_REFERENCE_BIND = Object.freeze({
  short:
    " Reproduce the reference garment's own pockets, seams and fabric." +
    " It sits at the waist and ends above the knee - keep that exact span.",
  long:
    " Reproduce the reference garment's own pockets, seams and fabric." +
    " It sits at the waist and ends at the ankle - keep that exact span.",
  unknown:
    " Reproduce the reference garment's own pockets, seams and fabric." +
    " It sits at the waist and ends at its own photographed hem.",
});

/**
 * The image-only prompt, resolved for THIS garment's category.
 *
 * ONE P.CORE PART, ON BOTH BRANCHES. There is no assembly left here: the function SELECTS
 * a frozen anchor (342 chars on tops, 320 on bottoms) and hands it to fitPrompt() as a
 * single part. The seven-clause assembly this used to run - and the priority tags that
 * decided what shed out of it - is described in CATEGORY_ANCHOR's comment above, together
 * with what came off the wire and how to put any of it back.
 *
 * FROZEN PER CATEGORY, NOT PER FRAME - and that is deliberate even though the anchor now
 * talks about "this frame". The per-frame half of the fix is not text: it is
 * the topology monitor (see reconditionForTopology) forcing a genuine re-conditioning
 * dispatch when the live body has moved, so the model re-reads a CURRENT frame rather
 * than being handed a description of one. Interpolating live measurements into the prompt would put this
 * function straight back into the text-volume competition every report in this sequence
 * was caused by, and would make the string non-constant for no gain.
 *
 * STILL ROUTED THROUGH fitPrompt() rather than returned raw, and that is not ceremony at
 * this length: it normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit
 * that lengthens an anchor - or adds the second part the restore notes describe - is
 * clamped HERE instead of over-running into clampPromptForWire()'s hard slice, which cuts
 * at the END and would take the fidelity sentence with it. The budget itself is
 * Decart's and app.js:5862 explicitly forbids raising it ("the ceiling is the API's, not
 * ours").
 *
 * @param {object|null} item - the garment being fitted; null resolves to the tops branch.
 * @returns {string}
 */
function imageOnlyPrompt(item) {
  /* ONE PART, BOTH BRANCHES. There is no assembly left on either side - see
     CATEGORY_ANCHOR above for the reports that drove it there, for the full list of what
     came off the wire, and for why bottoms names the lower body where tops names the
     whole contour.

     STILL ROUTED THROUGH fitPrompt() rather than returned raw, even at 342/320 chars:
     it normalises whitespace and enforces PROMPT_MAX_CHARS, so a future edit that
     lengthens an anchor is clamped here instead of over-running into
     clampPromptForWire()'s hard slice, which cuts at the END and would take the
     fidelity sentence with it.

     TO BUY A CLAUSE BACK, add it as a second part here - `[P.HIGH, STRICT_REFERENCE_LOCK]`
     for the hallucination clamp, `[P.HIGH, KEEP_OPPOSITE_LAYER]` on the bottoms branch for
     the opposite-layer pin; both are the retirements this revision made. The budget is not
     the constraint - 308 characters are free on tops and 330 on bottoms - so the only
     question is whether that text is worth the weight it takes away from the reference
     image, which is the mechanism every report in this sequence shares. One at a time,
     re-tested live. */
  return fitPrompt([
    [P.CORE, isBottomsGarment(item) ? CATEGORY_ANCHOR.bottom : CATEGORY_ANCHOR.top],
    /* BOUGHT BACK 2026-08-24 against a colour-drift report, and this is the restore this
       function's own note has prescribed since the 1:1 collapse: "TO BUY A CLAUSE BACK,
       add it as a second part here - [P.HIGH, STRICT_REFERENCE_LOCK] for the hallucination
       clamp". The budget note attached to it predicted 407 chars, which is what it costs.
       P.HIGH, so a pathological product name sheds it before it truncates the anchor. */
    [P.HIGH, STRICT_REFERENCE_LOCK],
    /* ── THE PASSTHROUGH CLAMP, BOUGHT BACK ────────────────────────────────────
       REQUESTED: preserve the shopper's face, hair, skin, legs and background. This is the
       clause built for exactly that, and app.js's own restore list has named it "THE
       LARGEST LOSS and the one to restore first if the model starts repainting the
       shopper's room or face" ever since it came off - with the restore spelled out as
       "add [P.HIGH, DENSE.inpaintLock]".

       55 CHARACTERS AGAINST THE 215 SPECIFIED, and it is the same instruction. The long
       form re-names every region ("face, hair, skin, lower body (pants/shorts), legs,
       background"), and Decart's set() has no negative_prompt field - every noun ships
       inside the POSITIVE prompt where the sampler can steer toward it, which is the
       mechanism behind this file's blue-jacket and tuxedo reports. The lower body is
       already covered by the passthrough sentence that now LEADS this prompt, so naming it
       a second time buys nothing and costs the budget twice. */
    [P.HIGH, DENSE.inpaintLock],
    /* ── THE TARGET GARMENT'S OWN PROPERTIES - bottoms only, and only here ──────────
       The clause above this one preserves what is NOT being replaced; every clause before
       it describes the reference's provenance in the abstract. Neither says to reproduce
       the lower garment's pockets, seams or hem - see BOTTOMS_REFERENCE_BIND for why the
       hem in particular had no instruction anywhere on the wire, and why the length is
       resolved three ways with a hedge rather than guessed.

       BOTTOMS ONLY, deliberately. No report has been filed of a TOP rendering at the wrong
       length, and the tops anchor already carries its own region wording; a mirrored clause
       here would spend budget on both branches to answer a failure reported on one. */
    [P.HIGH, isBottomsGarment(item) ? BOTTOMS_REFERENCE_BIND[bottomsLength(item)] : ""],
    /* ── modelAgnostic, ON THE BOTTOMS BRANCH ONLY - and why that is not a reversal ──
       model-agnostic.test.mjs retired this from the single-view path with a specific,
       calibrated reason, and it was right at the time: the composite reference is TWO
       packshots side by side, so it carries twice as much of another person's body, and
       the constant should "ship where the risk is, and nowhere else". Single-view carried
       one packshot and no report.

       WHAT CHANGED IS THE EVIDENCE, not the judgement. Two consecutive reports have now
       been filed against the SINGLE-VIEW lower-garment path - "generic/random trousers,
       wrong colour and cut" - and COMPOSITE_DEFAULT is false, so both landed on the path
       this clause was absent from. Meanwhile the composite branch is saturated at 683 of
       700 and sheds it there, so the sentence was reaching Decart on no path at all.

       A CATALOG PACKSHOT OF TROUSERS IS USUALLY SHOT ON A MODEL, and that is the specific
       reason this belongs on bottoms rather than everywhere: the reference then contains
       another person's legs already wearing another pair of trousers, and nothing told the
       model which of the two bodies to dress. "Generic trousers in the wrong colour" is
       what that ambiguity looks like from the outside - the model resolving toward its own
       prior for legs rather than toward the reference.

       STILL SCOPED, which is the part that keeps faith with the retirement: tops is
       untouched, because no tops report has been filed and the same reasoning that put
       this on bottoms says nothing about the other branch. If a tops equivalent is ever
       reported, that is a separate decision with its own evidence. */
    [P.HIGH, isBottomsGarment(item) ? DENSE.modelAgnostic : ""],
  ]);
}

const LOOK_ANCHOR =
  "Fit and replace BOTH the subject's upper garment and lower garment using the exact" +
  " garments from the reference image, which shows the top above the bottom as two" +
  " separate products. Render both simultaneously on the subject.";

/**
 * The full-look prompt - the THIRD case, and the one that must claim both layers rather
 * than isolate one. See buildLookPrompt() for why it cannot route through
 * imageOnlyPrompt(). Assembled the same way so it inherits the same budget guarantee.
 *
 * IT CARRIES THE STRICT LOCK TOO, and that is what this revision added here. The 1:1
 * collapse rewrote both category anchors around STRICT_REFERENCE_LOCK and left this path
 * on its old four-clause assembly, so the INVENTED-DETAIL report - the right garment
 * rendered with textures the reference never had - stayed reproducible through Full Look
 * while being fixed everywhere else. Nothing about that failure is specific to how many
 * garments are being replaced, so the clamp belongs on every path that reaches Decart.
 *
 * REFERENCE_EXTRACTION CAME OFF IN THE SAME EDIT rather than sitting beside it: the lock's
 * first sentence IS the provenance rule ("Exactly match color, pattern, logos, and cut"),
 * which this file already documents as superseding it, and shipping both would spend ~67
 * characters restating one instruction - the text-volume-against-the-reference mechanism
 * every report in this sequence shares. Net change: +20 characters, 533 of 650.
 *
 * VOLUME_PERSISTENCE and CLOSED_BACK_HEM STAY, unlike on the single-garment branches. This
 * path was never collapsed, no full-look report has been filed against clause count, and
 * removing them here would be a change made on no evidence. They are also the two clauses
 * a full-look render needs most, since it replaces the torso garment and the hem with it.
 *
 * A FUNCTION, not a module constant, and deliberately so: a `const X = fitPrompt(...)` at
 * module scope runs at LOAD time, which makes PROMPT_MAX_CHARS a load-order dependency for
 * every consumer - including the test harnesses that slice this file into a sandbox and
 * only stub the globals their own section needs. One of them (angle-race) does not, and a
 * load-time call turns that into a ReferenceError before a single assertion runs. Resolved
 * on demand it costs nothing measurable and cannot fail at import.
 * @returns {string}
 */
function lookAnchorPrompt() {
  return fitPrompt([
    [P.CORE, LOOK_ANCHOR + STRICT_REFERENCE_LOCK],
    [P.HIGH, VOLUME_PERSISTENCE],
    [P.MED,  CLOSED_BACK_HEM],
  ]);
}

/* The dense clause table. Deliberately lower-case and lightly punctuated wherever the
   meaning survives it: ALL-CAPS and heavy punctuation both tokenize worse than prose,
   so the few capitals left (EDGE-ON, LEFT/RIGHT) are spent only where the emphasis is
   doing real steering work.

   ── NOTHING HERE IS ASSEMBLED ANY MORE ───────────────────────────────────────
   Under strict image-only conditioning every builder returns IMAGE_ONLY_PROMPT, so this
   table is a RESTORE LIBRARY, not an assembly source. It is kept whole - and kept next
   to fitPrompt() and the P tiers, which are also intact - because a mode this aggressive
   is a starting point: each clause is a real, reproduced regression, and getting one
   back must be a two-line edit rather than an archaeology exercise. Restore ONE at a
   time and re-test; the premise of the mode is that clause COUNT was drowning the image.

   THREE OF THEM ARE SUPERSEDED rather than merely retired - the frozen string now
   carries their instruction inline, where it cannot be shed or reordered. Restoring
   these would DUPLICATE what is already on the wire, which is the one thing this mode
   is least able to afford:
     · assetLock      its directive is the frozen string's "the EXACT garment FROM the
                      reference image"; its enumerated noun list is deliberately NOT
                      reproduced (see this table's own assetLock comment).
     · bodyFidelity   → "the subject's true body volume and stomach".
     · profileLateral → "from all angles, including 0-degree front and 90-degree side
                      views" - both angles enumerated, neither gated on a pose event.
     · modelAgnostic  → ONLY IMPLIED, by "Preserve only the reference image's graphics,
                      fabric texture, and color". Revision 3 stated the discard outright
                      and revision 4 dropped that wording; the implication is weaker than
                      the statement. This is the one clause on this list whose restore is
                      an IMPROVEMENT rather than a duplication - append DENSE.modelAgnostic
                      the moment "it gave me the model's shoulders" is reported again.

   ── THE RESTORE BUDGET: BOTH BRANCHES NOW HAVE ROOM, AND THAT IS THE TRAP ────
   The number has moved eight times, so read the CURRENT row rather than remembering an
   older one. Against PROMPT_MAX_CHARS = 700, one space per part as fitPrompt() joins.
   The BASELINE moved this revision: both anchors now carry STRICT_REFERENCE_LOCK, bought
   back against a colour-drift report, which is why tops reads 407 rather than 342.

     TOPS (464 chars - anchor + locks)     BOTTOMS (657 chars - + bind + modelAgnostic)
     + DENSE.bodyFidelity  (45) → 510  fits              → SHEDS (would be 703)
     + DENSE.modelAgnostic (64) → 529  fits              → already LIVE on this branch
     + both of them        (109)→ 574  fits              → n/a

   THE TWO BRANCHES HAVE COMPLETELY DIVERGED, and that - not any individual row - is the
   thing to read off this table. Bottoms carries three clauses tops does not
   (BOTTOMS_REFERENCE_BIND's waist-to-hem span, and DENSE.modelAgnostic), all added
   against reported lower-garment failures that have no tops equivalent.

   ⚠️ BOTTOMS IS NOW SATURATED, AND THE WARNING BELOW INVERTS BACK FOR IT. 43 characters
   are free there against 236 on tops, so bodyFidelity no longer fits on bottoms at all:
   fitPrompt() sheds it rather than shipping it. For THIS branch the old hazard is live
   again - a restore silently SHEDS instead of silently succeeding - and a clause added
   here without checking will simply not reach Decart. Cost every bottoms restore against
   43 characters, and re-read this row rather than the tops one.

   TOPS STILL HAS ROOM, and there the warning stands as written: 236 characters free, so
   every retired clause would go back with room to spare. The risk on that branch is not
   that a restore sheds, it is that a restore silently SUCCEEDS.

   HEADROOM IS NOT PERMISSION. Tops was collapsed from 634 characters and bottoms from
   616 precisely BECAUSE text volume was outweighing the reference pixels - the tuxedo,
   the generic black shorts and the invented stripe are one mechanism seen three times.
   Two spends have been made since, both against REPRODUCED reports rather than to fill
   space: the lower-body scoping on bottoms (the shirt-replacement report), and the
   per-frame adaptation sentence on both branches (the stretched-garment report). The
   second is why the two anchors are ~170 characters longer than the 1:1 collapse left
   them, and it is also why the branches are now within 22 characters of each other
   rather than 69 apart. Size every further restore the same way: evidence first, then
   the character count.

   IF A RESTORE EVER DOES OVERRUN, the cheapest text to reclaim, in order:
     · CLOSED_BACK_HEM (49) - a P.MED, and now only on the full-look path.
     · VOLUME_PERSISTENCE (171) - P.HIGH on the full-look path; read model-agnostic
       .test.mjs first, it is the record of the body clauses.
     · TEMPORAL_PERSISTENCE (~150 per branch) is already off both single-garment
       branches - see the presence-gate suite before putting it back, not after.
     · The anchors are product-specified wording - change them deliberately or not at all.
   The order to restore in is below.

   THE REST ARE GENUINELY GONE from the wire, and are the ones worth buying back first:
     · inpaintLock    face/skin/hands/background passthrough. THE LARGEST LOSS.
                      Restore: add [P.HIGH, DENSE.inpaintLock].
     · contract, select, ignoreFurniture   the split-reference contract. Restore these
                      TOGETHER with COMPOSITE_DEFAULT, never one without the other.
     · lookPanels     the full-look TOP/BOTTOM layout. The only clause whose absence
                      costs a whole feature. Restore: add [P.CORE, DENSE.lookPanels].
     · pose, poseProfile, frontRef, backReal, backInferred, side
                      orientation steering, now carried by the ASSET the watcher swaps
                      to rather than by a sentence.
     · keepTop         the opposite-layer lock, TOPS ONLY. The bottoms half of it is back
                      on the wire - written INTO CATEGORY_ANCHOR.bottom ("Keep the
                      subject's upper body and background unmodified.") rather than
                      assembled from keepBottoms, because inside the anchor it cannot shed
                      and costs no extra clause. Restoring it on tops means mirroring that
                      sentence, not appending this table's two-word "Top unchanged."
     · rotation       "the garment dropped mid-turn". The mechanical half of that fix
                      (the prompt-only flip in applyGarment, and the OrientationWatcher's
                      turn hold) is code, not prompt, and is untouched by this.
     · temporal, quality  the file's own TRIM tier - the model's priors already favour
                      both, which is why they were always the first to shed. */
const DENSE = Object.freeze({
  /* NAMES THE REFERENCE AS A PHOTO OF THE GARMENT, in prose. The previous wording -
     "Try-on. Reference: split image, LEFT = garment front, RIGHT = back." - was
     telegraphic notation, and notation is a weak way to tell a diffusion model that an
     attached image is the thing it must copy. Costs ~65 characters more and buys the
     grounding back. */
  /* The "Virtual try-on." preamble that used to open this was dropped by the image-first
     refactor: garmentAnchor() now leads every prompt and states the task in its first six
     words, so the label was pure duplication sitting between the anchor and the layout
     fact it exists to state. What is left is only the layout fact. */
  contract:      "The reference image is a split photo of one garment: LEFT half its front, RIGHT half its back.",
  /* Split out of the contract so it can shed on its own. It guards a cosmetic artifact -
     a panel divider painted onto the shirt - which must never outrank grounding. */
  ignoreFurniture: "Ignore the gap, the background and any FRONT/BACK label.",
  select: {
    front:       "Use the LEFT half only; ignore the RIGHT.",
    back:        "Use the RIGHT half only; ignore the LEFT.",
  },
  /* THE CROSS-PANEL BAN. "Use the RIGHT half only" names a SOURCE; on its own it does not
     forbid a DESTINATION. Reported against exactly that gap: a shirt whose front reads
     "GO HIKING" rendered that chest text onto the shopper's BACK alongside the rear
     graphic when they turned - the model selected the right panel and still dragged the
     left panel's lettering around the body.

     This is the double-print regression that got the previous stitcher removed in
     23f5953, and the wording here is deliberately the surviving compression of the two
     clauses that were built to stop it and are still on file above:
     COMPOSITE_PANEL_CONTRACT's "never blend, mirror or copy any detail from one half into
     the other" and COMPOSITE_APPLY's "does not exist for this frame". Those two run ~450
     characters together and cannot ride inside a 650-char budget alongside the category
     anchor; this is the smallest phrasing that keeps both of their load-bearing halves -
     the panel is GONE, and its MARKS may not land on the render.

     NAMING THE MARKS IS THE MECHANISM, not padding: "print, text or logo" is the same
     device backInferred uses ("Never copy the front print, logo or buttons onto it") and
     the same one the anti-invention negative relies on. A bare "do not copy" leaves the
     model to decide what counts. Text is named FIRST because lettering is what the report
     was filed against and is the element a diffusion model most readily relocates. */
  panelExclusion: "The ignored half does not exist for this frame: never mirror or copy its print, text or logo onto the rendered garment.",
  pose: {
    front:       "They face the camera.",
    back:        "They are turned around, back to camera.",
  },
  poseProfile: {
    front:       "They are EDGE-ON in side profile; keep that rotation.",
    back:        "They are EDGE-ON, part-way turned away; keep that rotation.",
  },
  /* THE ANTI-MUTATION NEGATIVE. Compression removed every enumerated "do not" from this
     prompt, and this is the one that had to come back: with a weakly-bound reference and
     nothing forbidding invention, a diffusion model falls to its own prior, which for
     "shirt" is a plain mid-grey tee. Naming the failure is what suppresses it - the same
     mechanism as backInferred's front-print ban. */
  /* THE ANTI-INVENTION NEGATIVE. Widened twice against two separate reports of the same
     mechanism producing different specific outputs - first a blue JACKET, then a full
     TUXEDO with a bowtie and badge - which is the pattern that argues for naming the
     CLASS (formalwear/outerwear/accessories) rather than chasing individual garment
     words one report at a time; the next drift is not guaranteed to invent a jacket
     either. The underlying failure is unchanged from the first widening: the model kept
     a garment-shaped region and rendered something else into it - a layer, a type and
     now an ACCESSORY change, none of which the previous wording forbade.

     Naming the specific wrong output is deliberate and is the mechanism this file relies
     on everywhere (the same reason backInferred names the front print it must not copy),
     but the list cannot grow without bound inside a 226-token prompt - so it is pitched
     at garment CLASSES wide enough to cover what has actually been observed (jacket/coat/
     suit/tuxedo covers "outerwear or formalwear invented instead of a tee"; tie/bowtie/
     badge covers "accessories invented that were never in the reference") rather than an
     ever-growing enumeration of exact nouns. What is still NOT named is any particular
     garment's print text - that belongs to one product, and hardcoding it would state a
     falsehood about every other catalog item. The substitution sentence already binds the
     print generically ("every graphic, logo and lettering on it"). */
  /* RETIRED FROM ASSEMBLY - folded into garmentAnchor(). Kept verbatim because the
     comment above is the record of two live reports, and because it is the enumeration
     the anchor deliberately does NOT reproduce: with no negative_prompt field on
     Decart's set(), every noun here ships inside the POSITIVE prompt, where "tuxedo"
     is a token the sampler can steer toward rather than away from. See the anchor's
     own reservation note. */
  assetLock:     "Never invent a garment, jacket, coat, suit, tuxedo, tie, bowtie or badge, or change the garment type, and never leave their own top showing.",
  /* Depth and lateral wrap MERGED. Separately they cost ~155 characters and the budget
     could only afford one, so a 90-degree frame got the BODY clause and no GARMENT clause -
     leaving the side of the garment unreferenced, which is exactly where the model
     substitutes its own prior. One instruction about one region, ~175 chars. */
  profileLateral: "EDGE-ON: keep their full front-to-back depth; build the side by continuing its front and back panels.",
  bodyFidelity:  "Keep their real body volume; never slim them.",
  modelAgnostic: "Ignore the reference model's body; fit the cloth to THIS person.",
  keepBottoms:   "Bottoms unchanged.",
  keepTop:       "Top unchanged.",
  /* CONSIDERED AND REJECTED: adding "arms" here, after the tuxedo/blazer report - a
     blazer's sleeve is structurally different from a t-shirt's, so naming the arm/sleeve
     region alongside face/hands looked like a targeted fix. It is wrong for this shared
     table: PEAR_CATALOG ships long-sleeve items (Strata, Nimbus, Echo), and for those a
     correct render DOES cover the arm in sleeve fabric - "arms pass through untouched"
     would contradict the substitution itself on every one of them, the exact class of
     internal prompt contradiction this session has spent several commits removing, not
     one to reintroduce. The noun already carries this signal correctly ("t-shirt" implies
     short sleeves, "tank top" sleeveless, "long-sleeve shirt" full coverage) without a
     separate, subType-blind passthrough clause fighting it. */
  inpaintLock:   "Face, skin, hands and background pass through untouched.",
  rotation:      "The garment stays on through any turn.",
  temporal:      "Stable print, no flicker.",
  quality:       "Photoreal fabric, natural light.",

  /* Single-asset (non-composite) counterparts. The reference is ONE photo, so these say
     which side of the garment it shows instead of which half of a split image. */
  frontRef:      "The reference photo shows the garment's front; reproduce it, not the back.",
  backReal:      "The reference photo shows the garment's BACK: reproduce its back print at the same size and position; do not render the front.",
  /* The one enumerated negative the budget still pays for. With only a front photo the
     model's likeliest completion for a back is the front print repeated - the documented
     double-print bug - and nothing else in this compressed prompt forbids it. */
  backInferred:  "No back photo exists: infer a plain back in the same fabric and colour. Never copy the front print, logo or buttons onto it.",
  side:          "Show the garment's side: shoulder line, sleeve and side seam, draping along the flank.",
  /* Full-look stitched reference: two garments stacked in one image. Same job the
     composite contract does for front|back, for the top|bottom axis instead. */
  lookPanels:    "The reference stacks two garments: the TOP panel is the upper-body garment, the BOTTOM panel the lower. Render both at once; never mix them or draw the panel frames.",
});

/**
 * Assemble a prompt from priority-tagged parts, guaranteeing it fits PROMPT_MAX_CHARS.
 *
 * THE GUARANTEE IS THE POINT. Writing short clauses is necessary but not sufficient:
 * the garment description is interpolated from catalog data (or a shopper's own upload),
 * so its length is not known at authoring time and a long one could push a
 * hand-tuned-to-fit prompt back over the ceiling - reintroducing exactly the crash this
 * exists to prevent, for one unlucky product. Clauses are therefore SHED, worst-priority
 * first, until the result fits.
 *
 * The final clamp is a hard slice. It only triggers if CORE alone exceeds the budget
 * (a pathologically long garment name), and it is deliberate: a clipped prompt still
 * produces a garment, while a rejected one produces a failed session.
 *
 * @param {Array<[number, string]>} parts  [priority, text]; empty text is skipped.
 * @param {number} [max]  budget override, for tests.
 * @returns {string}
 */
/* getFitModifier() returns a bare noun phrase ("regular fit", "slightly oversized fit")
   because every previous caller embedded it mid-sentence as "Render a ${fitMod}". The
   dense builders join their parts as standalone sentences, where a bare phrase reads as
   a fragment - so it gets its own sentence here rather than being reworded at three
   separate call sites. */
function fitSentence(garmentType) {
  const mod = getFitModifier(getSizeDelta(), garmentType);
  return mod ? `Fit: ${String(mod).trim()}.` : "";
}

/* ── THE WIRE GUARD - last line of defence, and the one that generalises ──────
   fitPrompt() budgets the prompts this file BUILDS. That is not the same guarantee as
   "nothing over-long reaches Decart": a future builder, a hot-fix that concatenates one
   more clause onto a returned string, or any path that skips the builders entirely would
   sail straight past it and fail the session with the same opaque Hebrew banner.

   This clamps at the wire instead, so the guarantee holds no matter who produced the
   string. It should never fire - every builder already fits - so firing is itself the
   signal, and it logs loudly with the offending prefix rather than silently truncating.
   Truncation is the correct failure mode here: a clipped prompt still dresses the
   shopper, while a rejected one ends the session before the first frame. */
function clampPromptForWire(prompt, where) {
  const s = String(prompt ?? "");
  if (s.length <= PROMPT_MAX_CHARS) return s;
  console.error(
    `[PEAR] ${where}: prompt is ${s.length} chars, over the ${PROMPT_MAX_CHARS} budget ` +
    `(Decart hard-rejects >226 tokens). Truncating to keep the session alive - a builder ` +
    `is bypassing fitPrompt(). Prefix: ${s.slice(0, 120)}…`
  );
  return s.slice(0, PROMPT_MAX_CHARS).trim();
}

function fitPrompt(parts, max = PROMPT_MAX_CHARS) {
  let keep = parts.filter(([, text]) => text && String(text).trim());
  const render = (list) => list.map(([, t]) => String(t).trim()).join(" ").replace(/\s+/g, " ").trim();

  let out = render(keep);
  while (out.length > max) {
    const worst = Math.max(...keep.map(([p]) => p));
    if (worst === P.CORE) break;                       // nothing droppable left
    keep.splice(keep.findIndex(([p]) => p === worst), 1);
    out = render(keep);
  }
  if (out.length > max) {
    console.warn(`[PEAR] fitPrompt() - CORE alone is ${out.length} chars (budget ${max}); clamping.`);
    out = out.slice(0, max).trim();
  }
  return out;
}

/**
 * The prompt for a composite reference. Returns IMAGE_ONLY_PROMPT.
 *
 * ORDER USED TO BE THE POINT, and it moved twice before it stopped mattering. The
 * original shape was `buildPrompt(item) + angleClause(item)`: 1,403 characters of colour /
 * anatomy / fit / quality / hem / hard-negative boilerplate AHEAD of the panel contract,
 * pushing the single most important instruction in composite mode past the halfway mark of
 * a 2,636 character prompt. Lucy regenerates every frame from that prompt and the leading
 * tokens dominate, so that boilerplate was not merely wasteful - it was outranking the
 * contract. Fix one: put the panel contract first. Fix two (the tuxedo report): put the
 * image anchor first, because "which half of the reference to read" only matters once the
 * model is reading the reference at all.
 *
 * FIX THREE - the tuxedo survived both - WAS THAT THERE IS NOTHING TO ORDER. Every clause
 * is a token competing with the pixels, and ordering them only chooses which competitor
 * goes first. See IMAGE_ONLY_PROMPT for the mechanism and the full list of what this gave
 * up. That reasoning is untouched for a SINGLE-VIEW reference, which is what the ordinary
 * path still sends and still describes with the bare anchor.
 *
 * ── WHY THE CONTRACT IS BACK, AND ONLY HERE ────────────────────────────────────
 * The paragraph this replaces read: "a split FRONT|BACK reference is only legible
 * alongside the panel contract that explains it, and that contract is exactly the text
 * this mode removes." That was written as the argument for standing the composite path
 * DOWN, and it is just as much the argument for what to do when a split reference arrives
 * ANYWAY - which is exactly what the widget's garment_composite handover is.
 *
 * REPORTED: the shopper turns around and the back never renders. The handed-over
 * composite was reaching the wire as the reference while the prompt described one
 * undivided garment, so the model saw a seam it had never been told about and kept
 * rendering the LEFT panel onto a turned-around body. Sending a two-panel image with a
 * one-panel prompt is the worst of both modes by this file's own reasoning; the fix is
 * not to stop sending the composite (it is what the shopper sees in the "Now fitting"
 * chip) but to say what it is.
 *
 * SCOPE IS THE SAFETY PROPERTY. This rides only when a composite is ACTUALLY the
 * reference - the call site keys off `usingComposite`, read from what referenceImageFor()
 * RESOLVED rather than what it wanted, so a stitch that fails still falls back to the
 * single-asset prompt. This is not COMPOSITE_DEFAULT coming back on: nothing here builds
 * a split reference that did not already exist.
 *
 * THE PARAMETERS ARE NOW USED, and the seam they were kept for is what makes that safe:
 * applyGarment() freezes `angleAtStart`/`profileAtStart` before its awaits and threads
 * them here, so the panel this selects and the pixels on the wire describe the same
 * moment (angle-race, side-profile §6).
 *
 * @param {object} item   the active garment (catalog or custom upload)
 * @param {"front"|"back"} angle  which panel to read - frozen by the caller
 * @param {boolean} inProfile     true when the shopper is edge-on
 * @returns {string}
 */
function buildCompositePrompt(item, angle, inProfile) {   // eslint-disable-line no-unused-vars
  const side = angle === "back" ? "back" : "front";
  /* CONTRACT FIRST, then the selector, then the anchor - fix one's order, and the one
     thing fitPrompt()'s end-clamp preserves if a long product name ever pushes CORE over
     budget. Losing the tail of the anchor still leaves a legible split reference; losing
     the contract leaves an illegible one. */
  return fitPrompt([
    [P.CORE, DENSE.contract],
    [P.CORE, DENSE.select[side]],
    /* CORE, and directly after the selector rather than at the tail. The source rule and
       the destination rule are one instruction split across two sentences, and the leading
       tokens dominate - separating them by a shed-able clause is how the ban could go
       missing while the selector stayed, which is the exact failure shape this file
       already records for the negative/positive pair in IMAGE_ONLY_PROMPT. */
    [P.CORE, DENSE.panelExclusion],
    [P.CORE, isBottomsGarment(item) ? CATEGORY_ANCHOR.bottom : CATEGORY_ANCHOR.top],
    /* Same clause, same tier, same reason as imageOnlyPrompt() - see its note. It matters
       MORE here, not less: a composite reference is two catalog packshots side by side, so
       there is twice as much of the model's own body in the conditioning image. */
    [P.HIGH, DENSE.modelAgnostic],
    /* THE COLOUR HALF ONLY. The full STRICT_REFERENCE_LOCK does not fit here even at the
       restored 700-char cap (this branch would land at 729), and of its two sentences the
       colour one is what the drift report was filed against. The hallucination clamp it
       leaves behind is partly covered on this branch anyway - DENSE.panelExclusion already
       forbids the specific invention that matters most here, marks from the ignored half. */
    [P.HIGH, REFERENCE_COLOR_LOCK],
    /* Same clause, same tier, same reason as imageOnlyPrompt() - see its note. */
    [P.HIGH, DENSE.inpaintLock],
    /* Wired here too so the two builders cannot disagree about what a bottoms prompt
       says - but this branch is saturated (683 of 700 before this line), so in practice
       it SHEDS here and ships on the single-asset path. That is the correct way round:
       COMPOSITE_DEFAULT is false, so single-asset is the path the report came from, and
       a clause that cannot fit must not be allowed to push DENSE.select or
       DENSE.panelExclusion off the end - both are reproduced production bugs. */
    [P.MED,  isBottomsGarment(item) ? BOTTOMS_REFERENCE_BIND[bottomsLength(item)] : ""],
    [P.MED,  DENSE.ignoreFurniture],
  ]);
}

/* Full-Look composite clause, for stitchLookBlob() (TOP/BOTTOM, unrelated to front/back
   orientation). The reference image is TWO stacked, isolated garment photos
   (TOP over BOTTOM) rather than one image + a text-only description of the second
   garment, so the model has an actual pixel reference for BOTH the shirt and the
   pants and can render them together instead of favoring only the visually-referenced
   one. */
const LOOK_CLAUSE =
  " This image is two completely separate garment photographs stacked vertically, each isolated inside its own black-framed panel and divided by a WIDE solid-black separator band that is a strict no-man's-land." +
  " The two panels are distinct, mutually exclusive garment views. The panel marked 'TOP' is the ONLY valid source for the upper-body garment. The panel marked 'BOTTOM' is the ONLY valid source for the lower-body garment. Treat the black band and black frames as an impassable wall: you are strictly forbidden from sampling, blending, copying or bleeding ANY pixel from one panel into the other." +
  " Reproduce EACH panel's garment with 100% fidelity to its color, fabric and graphics - rendering the 'TOP' panel's garment on the person's upper body AND the 'BOTTOM' panel's garment on the person's lower body AT THE SAME TIME, in a single photorealistic pass. Neither garment replaces the other; both must be visible simultaneously." +
  " The 'TOP' and 'BOTTOM' text markers and the black frames/band are architectural guides only - never render that text, the frames or the band onto the clothing or the person.";

/* Custom upload, BACK angle, NO back photo supplied → a stronger inferred-rear than the
   generic backInferred. Product-approved wording: a clean, plain rear (front graphics
   stripped) that keeps the front's fabric/colour/seams/drape. The "negative prompt" is
   folded IN as an inline clause because Decart's realtime set() accepts only
   { prompt, image, enhance } - there is NO separate negative_prompt field to pass. */
const CUSTOM_BACK_INFERRED = REAR_POSE + BACK_TAIL.custom;
/* A REAL rear reference = a back image that DIFFERS from the front. A mirrored front
   (catalog auto-fill at load, or the graceful front-fallback) has g.back === g.front and
   is NOT a true back photo - so it must NOT claim "reproduce the back" steering. Only a
   distinct back asset (a storefront data-pear-back, or a catalog item's real rear photo)
   qualifies. For a full look, BOTH halves must ship a real back. */
function activeBackIsReal(item) {
  const real = (it) => !!distinctBackOf(it);
  const look = resolveLook();
  if (look) return real(look.top) && real(look.bottom);
  return real(item);
}

/* Whether "AI Auto" (Context-Aware Asset Switching) is MEANINGFUL for the current
   subject. It needs a real front AND a real, DISTINCT back photo - a mirrored front
   (g.back === g.front, the catalog auto-fill / graceful fallback) has nothing for the
   watcher to switch TO, so it must NOT offer the mode. Same realness test as
   activeBackIsReal; for a full look BOTH halves must qualify. Today only an item
   shipping a genuine rear asset (e.g. Strata) exposes it - deliberately consistent
   with the two-view gate. */
function canCombineViews(item) {
  const ok = (it) => { if (!it) return false; const g = galleryOf(it); return !!(g.front && distinctBackOf(it, g)); };
  const look = resolveLook();
  if (look) return ok(look.top) && ok(look.bottom);
  return ok(item);
}

/* Pick the angle clause for the active view. Back splits on whether a REAL back photo is
   in play (backReal - reproduce + pin the print's placement) vs a mirrored/inferred front
   (backInferred). `item` is the single garment; for a full look it's resolved internally. */
/* Whether THIS render should use the stitched composite. Single predicate so
   angleClause() and referenceImageFor() can never disagree about which reference the
   model is looking at - a clause describing two labelled panels sent alongside a
   single-view image would be worse than either option on its own. Requires a real,
   distinct back (distinctBackOf) and the auto orientation lock, since the clause names
   one panel based on the detected side. */
function hasUnifiedComposite(item) {
  return !!(item && (item.composite || item._compositeObjectUrl));
}

function compositeActiveFor(item) {
  /* BOTH OF THESE STAY UNCONDITIONAL. The clause names ONE panel by the DETECTED side, so
     without the auto orientation lock there is no detected side to name; and a full look
     is a different stitch entirely (TOP over BOTTOM - see LOOK_CLAUSE), whose panels this
     contract would describe wrongly. */
  if (currentAngle !== AUTO_ANGLE || resolveLook()) return false;
  /* A UNIFIED COMPOSITE THAT ALREADY EXISTS OUTRANKS BOTH REMAINING GATES, and that is the
     bug this closes. distinctBackOf() asks "is there a separate back URL to stitch FROM" -
     the right question for a composite this room has yet to build, and the WRONG one for a
     composite the widget already built and handed over, which by construction has no
     separate back URL to find. COMPOSITE_MODE is likewise a question about whether to opt
     IN to building one. Neither is a reason to discard a split reference that is already
     the model's reference and already what the "Now fitting" chip shows the shopper.

     Discarding it is what produced the report: referenceImageFor()'s handover branch sits
     INSIDE this predicate, so a false here did not fall back to a single-view image - it
     sent the composite with the single-view PROMPT, the one combination applyGarment()'s
     COMPOSITE BINDING guard exists to catch in the opposite direction. */
  if (hasUnifiedComposite(item)) return true;
  return COMPOSITE_MODE && !!distinctBackOf(item);
}

/* `angleOverride`, when given, is used INSTEAD of a fresh effectiveAngle() read - see
   applyGarment()'s "angleAtStart" comment for why: the caller may be applying a
   snapshot taken before an async gap during which the OrientationWatcher could have
   flipped the live orientation, and re-reading here would let the clause and the
   already-resolved reference image drift apart. Omitted by every OTHER caller
   (applyLook() has no per-orientation reference to race against), so this stays a
   pure addition, not a behaviour change for them. */
/* `useComposite` overrides the compositeActiveFor() guess when the CALLER already knows
   what reference actually got resolved. That distinction is load-bearing, not cosmetic:
   compositeActiveFor() reports whether a composite is *wanted*, while referenceImageFor()
   can want one and still fall through to a single-asset image when the stitch or the
   handed-over data URL fails to decode. Describing two labelled panels to a model that
   was handed ONE photo is strictly worse than either mode on its own - it names a right
   panel that does not exist, so there is nothing for the back instruction to point at.
   applyGarment() therefore passes what it actually sent. Omitted elsewhere, where the
   inferred value is correct. */
/* `inProfile` is the OrientationWatcher's edge-on reading, and it is a frozen snapshot for
   exactly the same reason `angleOverride` is: the watcher samples on its own 250ms
   interval and can change it during applyGarment()'s await, which would let the pose
   sentence and the already-resolved reference describe different moments. applyGarment()
   snapshots it beside angleAtStart and threads it through.

   It is deliberately a SEPARATE axis from `angleOverride`, not a third value of it. The
   angle decides WHICH GARMENT ASSET/panel is the source and is a hysteresis-protected
   lock; profile decides only WHAT POSE THE PROMPT ASSERTS about the body. Collapsing them
   would mean a side-on frame could change the reference image, which is precisely the
   flapping the lock exists to prevent - a profile frame is not evidence the shopper's
   other side is now showing. Keeping them independent is what lets this fix the pose
   without touching any asset-selection behaviour. */
function angleClause(item, angleOverride, useComposite, inProfile) {
  /* Edge-on: append BOTH profile clauses on every branch below - the body's depth axis,
     then the garment's lateral wrap over it. Both are orientation-independent (they
     describe the frame, not which panel was locked), so they ride on front, back and side
     alike. Order is deliberate and matches buildCompositePrompt(): what the body IS, then
     how the garment covers it - the second only means anything given the first. */
  /* One merged edge-on directive now, not two. Referencing the retired profileDepth /
     lateralWrap here would interpolate the string "undefined" straight into a live
     prompt - silent, and exactly the kind of thing the model would try to render. */
  const depth = inProfile ? " " + DENSE.profileLateral : "";

  // Composite mode: the reference carries BOTH views, so the clause names the panel
  // matching the detected orientation and excludes the other outright. Only the pose
  // sentence varies with profile; the panel contract and selection are unchanged.
  if (useComposite === undefined ? compositeActiveFor(item) : useComposite) {
    const a = (angleOverride || effectiveAngle()) === "back" ? "back" : "front";
    const pose = inProfile ? DENSE.poseProfile[a] : DENSE.pose[a];
    // depth rides DIRECTLY behind the pose, not at the tail - see buildCompositePrompt()'s
    // placement comment for why position is load-bearing for this model.
    return " " + DENSE.contract + " " + pose + " " + DENSE.select[a] + depth;
  }
  const angle = angleOverride || effectiveAngle();      // AI Auto resolves to the DETECTED orientation
  if (angle === "back") {
    // Which POSE leads the clause depends on whether they are square-on or mid-turn; which
    // GARMENT TAIL follows it depends on what reference we actually hold. Independent
    // choices, so they are resolved independently rather than as four hand-written strings.
    const pose = " " + (inProfile ? DENSE.poseProfile.back : DENSE.pose.back);
    // Dual asset (front + a REAL back photo, incl. a user's uploaded back) → reproduce it.
    // AI Auto always lands here with a real back (canCombineViews gates the mode on one).
    if (activeBackIsReal(item)) return pose + depth + " " + DENSE.backReal;
    // Only a front reference → the rear must be INFERRED, and the front print must not be
    // copied onto it. That negative is the one enumerated ban the budget still pays for:
    // it is the difference between a plain back and the chest logo printed twice.
    return pose + depth + " " + DENSE.backInferred;
  }
  // AI Auto: pin the reference explicitly as the garment FRONT - the mode's whole contract
  // is one unambiguous side - but state the shopper's real rotation, not an assumed facing.
  if (currentAngle === AUTO_ANGLE) {
    return " " + (inProfile ? DENSE.poseProfile.front : DENSE.pose.front) + " " + DENSE.frontRef + depth;
  }
  /* Single-view items (see profileActive()'s comment - the watcher now runs for these
     too): `angle` here is a GALLERY tab choice (which product photo to reference), not a
     claim about how the shopper is physically standing, and ANGLE_CLAUSE.front is "" - it
     never needed its own pose sentence because there used to be no live pose signal for
     this mode at all. `inProfile` is that signal now. When it's true, reach for
     DENSE.side - the garment-specific side-seam/flank wording - instead of whatever the
     selected tab's (possibly empty) clause says, same as AUTO_ANGLE substituting the
     profile pose for the square-on one above. */
  if (inProfile) return " " + DENSE.side + depth;
  return angle === "back" ? " " + DENSE.pose.back : "";
}

/**
 * Resolve the reference image handed to rtClient.set({ image }) for the active view.
 * Normal angles → the proxied gallery URL (garmentImageRef, a string). AI Auto → the
 * pre-cached per-orientation Blob (garmentBlobCached), never a combined image.
 * @param {object} item @param {string} [activeImg] pre-resolved activeImageOf(item)
 * @returns {Promise<Blob|string|undefined>}
 */
async function referenceImageFor(item, activeImg = activeImageOf(item), out = {}) {
  /* `out.composite` reports what this function ACTUALLY resolved, not what it set out to
     resolve. The two diverge on every fallback path below, and the caller has to know:
     the composite prompt describes a left and a right panel, so pairing it with a
     single-view image leaves the whole back instruction pointing at a panel that isn't
     there. See angleClause()'s `useComposite` comment. */
  out.composite = false;

  /* Composite mode: ONE stitched FRONT|BACK reference for the whole session. Because
     the image is identical for both orientations, a confirmed turn re-issues set()
     with only the clause changed - the Blob is memoized, so there is no re-fetch and
     no re-upload of pixels. Falls through to the per-orientation single asset if the
     stitch fails, which is the pre-composite behaviour and always safe. */
  if (compositeActiveFor(item)) {
    /* Prefer the composite the WIDGET already built and handed over: it is the exact
       image the store page produced, so there is no second stitch, no re-fetch of two
       CDN assets, and no chance of the two builders disagreeing. Decoded locally -
       it is a data: URL. */
    if (item.composite) {
      const handed = await garmentBlobCached(item.composite);
      if (handed) { out.composite = true; return wireRefFor(handed); }
      console.warn("[PEAR] handed-over composite failed to decode - rebuilding locally");
    }
    const g = galleryOf(item);
    const composite = await createGarmentComposite(g.front || item.img, distinctBackOf(item, g));
    if (composite) {
      /* Surface a locally-built composite in the "Now fitting" chip too, so the chip
         always shows what the model is actually looking at - not the front photo for a
         catalog item and the composite for a widget handover. One object URL per item;
         the previous one is revoked so a colour/item swap cannot leak them. */
      if (!item._compositeObjectUrl) {
        try {
          item._compositeObjectUrl = URL.createObjectURL(composite);
          renderActiveGarment();
        } catch (_) { /* non-fatal: the chip just keeps showing the front photo */ }
      }
      out.composite = true;
      /* THE BLOB IS STILL WHAT THE CHIP GETS, and the ordering is load-bearing:
         createObjectURL() above needs a real Blob, so the wire form is resolved only
         after it. wireRefFor() hands back the pre-encoded string when the prewarm built
         one and the Blob itself otherwise - the same bytes either way, so a miss is not
         a fallback in any visible sense, only a slower encode inside set(). */
      return wireRefFor(composite);
    }
    /* Both routes to a composite failed. out.composite stays false, so applyGarment()
       drops the panel prompt and steers the single asset below with the ordinary
       backReal/autoFront clauses - the pre-composite behaviour, which is always safe. */
    console.warn("[PEAR] composite unavailable - falling back to the single-asset reference for", effectiveAngle(),
      "(prompt will drop the FRONT|BACK panel contract to match)");
  }
  // AI Auto - the pre-cached Blob for the DETECTED orientation (activeImg already resolved
  // through effectiveAngle()). Sending bytes, not a URL, is what makes the swap instant.
  if (currentAngle === AUTO_ANGLE) {
    const blob = await garmentBlobCached(activeImg);
    /* Same Blob this branch always returned, in its cheapest wire form: the pre-encoded
       data: URL when the prewarm got to it (set() then splits a string instead of running
       a FileReader over it), the Blob itself when it did not. See prewarmWireEncoding(). */
    if (blob) return wireRefFor(blob);
    console.warn("[PEAR] AI Auto - Blob pre-cache miss; falling back to proxied URL reference");
  }
  /* ── SINGLE-VIEW GETS THE SAME TREATMENT, IF THE BYTES ARE ALREADY HERE ──────
     "Sending bytes, not a URL, is what makes the swap instant" was true for AI Auto and
     was never applied to the front-only path - which is most of the catalog. A URL means
     DECART fetches the image before it can condition on it, and until that lands the only
     thing it can render a garment from is its own prior: the reported generic grey sweater
     for the first second of the session. Handing over bytes removes that fetch entirely.
     WARM ONLY - garmentBlobIfWarm(), never garmentBlobCached(). On a hit this is free; on
     a miss it falls through to the URL immediately rather than moving the fetch onto the
     go-live path, where it would cost more than the server-side one it replaced. The hit
     rate is what setActiveItem()'s prewarm exists to raise. */
  const warm = garmentWireRefIfWarm(activeImg);
  if (warm) {
    /* Either a pre-encoded data: URL (the fast case - set() just splits the string) or
       the raw Blob (bytes are here, the encode is not pre-paid). Both skip the network;
       only the first also skips the FileReader. `.size` exists on one and `.length` on
       the other, so reading either unconditionally logs NaNKB - it is a log line, not a
       behaviour difference, but a size that reads NaN is how a real one stops being read. */
    const preEncoded = typeof warm === "string";
    const kb = ((preEncoded ? warm.length : warm.size) / 1024).toFixed(0);
    console.log("[PEAR] reference: warm bytes (prefetched) -", abbrevImg(activeImg),
      `${kb}KB${preEncoded ? " pre-encoded" : ""} - Decart has nothing to fetch before conditioning`);
    return warm;
  }
  return garmentImageRef(activeImg);
}

async function applyGarment(item) {
  if (!rtClient) throw new Error("not connected");

  /* THE "MIXING" BUG. Snapshot the angle ONCE, synchronously, right here - before any
     async work below. referenceImageFor() can await a real fetch/decode, or (the
     first time a pair is used) a multi-hundred-ms composite build; the
     OrientationWatcher's own independent 250ms sampler is free to confirm a flip and
     mutate the live autoOrientation lock during that exact window - it has no idea
     this call is in flight. angleClause() used to re-read effectiveAngle() AFTER
     that await, which meant it could pick up the NEW angle while imageRef still held
     the reference resolved for the OLD one: a front Blob paired with "reproduce the
     BACK, do NOT render the front" steering - the front-print-on-the-back failure
     this file already fixed once for a URL-matching reason (see canonicalImageUrl's
     comment), reintroduced here by a bare time-of-check-to-time-of-use race instead.
     Freezing the angle here means the image and the clause below always describe the
     SAME side, even if a flip lands mid-await - at worst this one application is a
     turn behind, corrected by the very next set() once the flip is observed again;
     it can never be internally self-contradictory. */
  const angleAtStart = effectiveAngle();
  /* Frozen for the SAME reason and in the SAME breath as angleAtStart above. The watcher
     samples on its own 250ms interval and can enter or leave the edge-on state during the
     await below, so re-reading it after would let the pose sentence describe a different
     moment than the reference resolved for. Cheaper to be one tick stale than internally
     inconsistent - and the next tick corrects it. */
  const profileAtStart = profileActive();
  const activeImg = activeImageOf(item);
  const refInfo   = {};                                          // ← filled in by referenceImageFor
  let   imageRef  = await referenceImageFor(item, activeImg, refInfo);   // Blob for combined, URL otherwise
  const usingComposite = refInfo.composite === true;             // what we ACTUALLY resolved

  /* ── LAST-DITCH REFERENCE RECOVERY - the prompt is image-first now ────────────
     This used to be tolerable: `...(imageRef ? { image: imageRef } : {})` quietly
     omitted the image key and the prompt still recited a catalog description ("white
     t-shirt: exact colour, texture and print"), so a prompt-only set() rendered
     SOMETHING garment-shaped. garmentAnchor() deleted that description on purpose -
     the prompt now says "the exact provided image asset" and nothing else - so a
     dispatch with no image is a prompt pointing at an asset that was never sent, and
     the model has only its own prior to fall back on. That is the tuxedo, arriving
     through the payload instead of through the text.

     referenceImageFor() already falls through composite → per-orientation Blob →
     proxied URL, so reaching here means activeImageOf() itself came back empty - a
     catalog/handover item with no usable asset for the active angle. Sweep the item's
     remaining assets rather than shipping a prompt with nothing behind it. */
  if (!imageRef) {
    const g = galleryOf(item) || {};
    /* item.composite is LAST on purpose. It is a split FRONT|BACK image, and strict
       image-only has no panel contract left to explain one (see COMPOSITE_DEFAULT) - so
       it is the reference this mode least wants. It stays in the list because it is only
       reachable when the item has no front, no back and no img at all, and an ambiguous
       reference still beats none. If it is ever being reached routinely, the item's
       gallery is broken and that is the bug to fix. */
    for (const candidate of [g.front, g.back, item.img, item.composite]) {
      if (!candidate) continue;
      const recovered = garmentImageRef(candidate);
      if (recovered) {
        console.warn("[PEAR] applyGarment() - no reference resolved for the active angle;",
          "recovered a fallback asset so the image-first prompt has something to bind to:",
          abbrevImg(candidate));
        imageRef = recovered;
        break;
      }
    }
  }
  /* Still nothing. Loud, and at ERROR: every prompt this file builds now depends on an
     image being on the wire, so this is a broken render, not a degraded one. It does NOT
     throw - a live session that renders the shopper undressed is still recoverable by the
     next applyActive()/re-anchor, while a throw ends the stream before the first frame. */
  if (!imageRef) {
    console.error("[PEAR] applyGarment() - NO garment asset could be resolved for", item.name,
      `(id=${item.id}, angle=${angleAtStart}).`,
      "\n  → the prompt is image-first and will have no reference to condition on;",
      "Decart will render its own default garment.",
      "\n  → check the item's gallery/img fields; window.__pearDebugReinjectGarment({ bustCache: true })",
      "forces a fresh resolve once they are fixed.");
  }

  /* ── STRICT ORIENTATION/ASSET BINDING (last line of defence) ──────────────────
     The pairing that produces "the chest print is rendered on the back" is a BACK
     clause sent with the FRONT photo: the clause says "this reference shows the BACK
     - reproduce it faithfully, do NOT render the front", so the model faithfully
     reproduces the only thing it can see, which is the front graphic.

     angleClause() already picks backReal vs backInferred correctly, and
     distinctBackOf() now stops the two from being confused upstream. This asserts the
     invariant at the single point where the prompt and the image are married, so any
     future path that reintroduces the mismatch is caught here rather than in a
     shopper's live session. Detection only - it never silently rewrites the payload,
     because the correct recovery differs by cause and guessing one would hide the bug.
     Checked against angleAtStart, not a fresh effectiveAngle() read, for the same
     reason angleClause() below is - see this function's opening comment. */
  if (angleAtStart === "back") {
    const g = galleryOf(item);
    const realBack = distinctBackOf(item, g);
    if (realBack && !sameImage(activeImg, realBack)) {
      console.error("[PEAR] BINDING VIOLATION: back angle active but the reference is not the back asset.",
        "\n  reference:", abbrevImg(activeImg), "\n  expected :", abbrevImg(realBack));
    }
    if (!realBack && activeBackIsReal(item)) {
      console.error("[PEAR] BINDING VIOLATION: 'reproduce the BACK' steering with no distinct back asset -",
        "the front would be reproduced as the back. Item:", item.name);
    }
  }

  /* ── COMPOSITE BINDING (the other half of the same invariant) ─────────────────
     compositeActiveFor() said a composite was WANTED but referenceImageFor() came back
     with a single-view image. That combination used to ship anyway: angleClause() asked
     compositeActiveFor() a second time, got "yes" again, and sent "read the RIGHT panel
     marked BACK" alongside a photo with no right panel in it - the model has no region
     to sample and falls back to whatever it can see, which is the front. That is the
     "back texture isn't mapped when the shopper turns" failure, arriving from the ONE
     path where the two halves of the payload were allowed to disagree. Now the prompt is
     chosen from what was actually resolved, and the divergence is logged rather than
     rendered. */
  if (compositeActiveFor(item) && !usingComposite) {
    console.warn("[PEAR] composite WANTED but not resolved - sending the single-asset prompt instead.",
      "\n  angle:", angleAtStart, "| reference:", abbrevImg(activeImg));
  }

  if (angleAtStart === "back") {
    const isBlob = typeof Blob !== "undefined" && imageRef instanceof Blob;
    console.log('[PEAR] applyGarment image:', activeImg);
    console.log('[PEAR] applyGarment blob:', isBlob ? 'ok' : 'NULL - will use URL fallback');
  }

  /* Composite mode gets a purpose-built prompt (panel contract FIRST), not the generic
     prompt with a clause bolted on the end - see buildCompositePrompt() for why order
     is the substantive difference. Both branches are driven by `usingComposite`, so the
     prompt can never describe a reference other than the one on the next line. */
  const payload = {
    prompt: clampPromptForWire(usingComposite
      ? buildCompositePrompt(item, angleAtStart, profileAtStart)
      : buildPrompt(item, angleClause(item, angleAtStart, false, profileAtStart)),
      "applyGarment"),
    enhance: false,
    ...(imageRef ? { image: imageRef } : {}),
  };

  console.group("[PEAR] applyGarment() - VTON payload debug");
  console.log("garment  :", item.name, `(id=${item.id}, type=${item.garmentType}${item.custom ? ", custom upload" : ""})`);
  console.log("angle    :", currentAngle,
    // angleAtStart, not a fresh effectiveAngle() read - this must report what the
    // payload above actually used, not whatever the live orientation has become by
    // the time this log line runs (which can differ - see this function's opening
    // comment. A log claiming a different angle than the payload it's describing
    // would make exactly this class of bug harder to diagnose, not easier).
    /* THE MODE IS NAMED HERE TOO, from usingComposite - what referenceImageFor() actually
       RESOLVED, never what compositeActiveFor() wanted. Before this fix the mode silently
       read FRONT_MODE on a session whose reference was a two-panel image, which is the
       report this closes and is exactly the thing this line exists to make visible.

       DELIBERATELY NOT `applied angle: composite`. The composite is the reference FORMAT;
       the angle is still front or back, and it is what selects the panel. Reporting the
       format in the angle slot would hide which side was applied - see the note directly
       above about a log claiming a different angle than its payload. The panel that was
       actually selected is spelled out on the `reference:` line below. */
    currentAngle === AUTO_ANGLE
      ? `(AI Auto - ${usingComposite ? "COMPOSITE_MODE" : vtonState()}, applied angle: ${angleAtStart}, ` +
        `${usingComposite ? "COMBINED composite" : "pre-cached Blob"})`
      : hasDedicatedAngle(item) ? "(dedicated gallery image)" : "(front fallback + prompt)");
  console.log("subType  :", item.subType, "| color:", item.color);
  console.log("img URL  :", abbrevImg(activeImg));   // data: URLs abbreviated so a base64 blob can't flood the console
  console.log("img ref  :", abbrevImg(imageRef));
  /* The line to read when the back doesn't render. It answers, for the payload actually
     on the wire: is the model looking at the two-panel COMBINED image, which panel was it
     told to read, and does the widget's stitch geometry agree with what the prompt claims
     (LEFT=FRONT, RIGHT=BACK)? A "single-asset" here during AI Auto means the composite
     never resolved and the warning above explains why. */
  console.log("reference:", usingComposite
    ? `COMBINED composite → panel ${angleAtStart === "back" ? "RIGHT/BACK" : "LEFT/FRONT"}` +
      (item._compositeLayout ? ` · ${describeCompositeLayout(item._compositeLayout)}` : "") +
      (item.composite ? " · built by widget" : " · built locally")
    : "single-asset (no panel contract in the prompt)");
  console.log("prompt   :", payload.prompt);
  console.groupEnd();

  if (!imageRef) console.warn("[PEAR] applyGarment() - no img URL; prompt-only.");

  /* ── THE FLICKER FIX: a turn re-sends the PROMPT, not the picture ─────────────
     In composite mode the reference is byte-identical across an orientation flip - one
     stitched FRONT|BACK image serves both sides, and only the clause naming the half
     changes. This file has claimed since the composite landed that "an orientation flip
     is a PROMPT-ONLY set()". It was not. rtClient.set({ image }) runs the Blob through
     imageToBase64() and ships the bytes every single time (verified in
     @decartai/sdk@0.1.5 realtime/methods.js) - so every turn pushed a few hundred KB of
     base64 through the datachannel and swapped the model's reference out from under
     itself, mid-rotation, inside a 5s billed window. That is the window in which the
     back print "flickers or disappears": the reference is being replaced at exactly the
     moment the shopper turns.

     setPrompt() takes the other path - session.sendPrompt(), which never touches the
     image - so the reference stays exactly as it was and the flip costs one small
     control message. Guarded on the image being UNCHANGED and already on the wire;
     anything else (first application, a garment swap, a fallback to a single-view asset)
     still goes through the full set(). enhance:false must be passed explicitly:
     setPromptInputSchema defaults it to TRUE, unlike set(). */
  /* DEBUG ONLY: window.__pearDebugForceFullReupload lets ONE live session force every
     dispatch through the full rtClient.set({ image }) path below, bypassing this fast
     path entirely - to test, with real Decart telemetry, whether repeated image
     re-uploads are what's actually dropping the garment reference, against the
     documented flicker-fix rationale this fast path exists for (the comment above).
     OFF by default; set it from DevTools for one diagnostic run, never flip the
     default. typeof-guarded: applyGarment() is extracted and executed standalone by
     prompt-only-flip.test.mjs/side-profile.test.mjs in a sandbox with no `window`
     global - a bare reference would throw ReferenceError there (see the matching
     guard on verifyGarmentAsset() below). */
  const debugForceFullReupload = typeof window !== "undefined" && !!window.__pearDebugForceFullReupload;
  const sameImageOnWire = !debugForceFullReupload && imageRef && lastSentImageRef === imageRef && rtImageOnWire;
  if (debugForceFullReupload && imageRef && lastSentImageRef === imageRef && rtImageOnWire) {
    console.warn("[PEAR][DEBUG] __pearDebugForceFullReupload is ON - forcing a full image",
      "re-upload even though the reference is unchanged. This intentionally reintroduces",
      "the flicker-fix regression (see prompt-only-flip.test.mjs) for ONE diagnostic",
      "session only - turn it back off (window.__pearDebugForceFullReupload = false)",
      "when done capturing the transcript.");
  }
  if (sameImageOnWire) {
    /* ── NOTHING TO SEND: same image, same prompt ─────────────────────────────
       This branch could not be reached before strict image-only mode, because the
       prompt was assembled per angle/pose/garment and every caller that got here had
       just changed one of them. IMAGE_ONLY_PROMPT is one frozen string, so the payload
       is now byte-identical to what Decart already holds - both halves of it - and
       setPrompt() would push a control message that provably changes nothing.

       The re-anchor cadence is what makes this common rather than theoretical:
       maybeReanchorPrompt() fires ~8 times per session specifically to re-assert the
       steering, and every one of those now lands here. Skipping is the honest
       behaviour, but it is worth being clear about what it means -

       THE RE-ANCHOR IS A NO-OP IN THIS MODE. It exists because the model drifts back
       toward "the person as photographed" mid-session, and re-stating the prompt is how
       it was pulled back. There is nothing left in the prompt to re-state. The only
       thing worth re-asserting now is the IMAGE, and that is a full set() with a real
       bandwidth cost inside a 5s billed window - a deliberate policy choice, not
       something to fall into by leaving a dispatch running. If drift-reversion returns,
       the fix is to make the re-anchor force a full re-upload (lastSentImageRef = null
       before applyActive(), exactly as __pearDebugReinjectGarment does), not to restore
       a prompt clause purely to give setPrompt() something to carry. */
    if (payload.prompt === lastSentPrompt) {
      console.log("[PEAR] no-op update skipped - reference AND prompt both unchanged",
        `(${angleAtStart}); strict image-only means a re-anchor has nothing to re-assert.`,
        "Force a real re-upload with window.__pearDebugReinjectGarment().");
      return;
    }
    console.log("[PEAR] prompt-only update - reference unchanged, image NOT re-uploaded",
      `(${angleAtStart})`);
    /* THE EXACT STRING HITTING DECART, logged immediately adjacent to the call that sends
       it - not earlier in the debug group above, which describes the payload BUILT, not
       necessarily the one about to go out this specific dispatch (this path and the
       full set() below are two different sends from two different places in this
       function). abbrevImg(), not the raw Blob/URL: the console.log("img ref", ...) line
       above already established that a raw data: URL or Blob here can flood the console. */
    console.log("[DECART PROMPT DEBUG]", payload.prompt, abbrevImg(imageRef),
      "(prompt-only - image already on the wire, unchanged)");
    /* Through the wire mutex like every other write. It is a small control message rather
       than an image upload, but it is still a write on the same signaling channel, and
       "small" is not "free" when the channel is mid-handshake - see sendCondition(). */
    await sendCondition("applyGarment/prompt-only",
      () => rtClient.setPrompt(payload.prompt, { enhance: false }));
    lastSentPrompt = payload.prompt;
    return;
  }

  console.log("[DECART PROMPT DEBUG]", payload.prompt, abbrevImg(imageRef));
  // DEBUG WRAPPER, typeof-guarded: applyGarment() is extracted and run standalone by
  // prompt-only-flip.test.mjs/side-profile.test.mjs against a fixed sandbox global list
  // that doesn't include this - a bare call would throw ReferenceError there.
  if (typeof verifyGarmentAsset === "function") verifyGarmentAsset(payload, "applyGarment");
  await sendCondition("applyGarment", () => rtClient.set(payload));
  /* Stamped only AFTER set() resolves, which is what makes a retry correct: applyActive()
     re-enters this function on a rejection, and if these had been written optimistically
     the second attempt would see its own reference "already on the wire" and take the
     prompt-only path - retrying a failed image upload by not uploading the image. */
  lastSentImageRef = imageRef || null;
  rtImageOnWire = !!imageRef;
  lastSentPrompt = payload.prompt;
  if (imageRef) lastAckedImageRef = imageRef;   // survives a wire invalidation - see its declaration
}

/**
 * Reads the Screen 1 physical inputs and returns a forceful anatomical anchor
 * sentence. This pins the AI's body model to real measurements so it cannot
 * hallucinate a generic body shape.
 * @returns {string}
 */
function getAnatomicalAnchor() {
  const num = (id) => { const el = $(id); return el && el.value ? parseFloat(el.value) : null; };
  const height = num("height"), weight = num("weight");
  const chest  = num("chest"),  waist  = num("waist"),  legs = num("legs");

  if (!height && !weight) {
    return "Fit the garment to a realistic human body with accurate anatomical proportions and photorealistic fabric physics.";
  }

  let sentence = "The person has ";
  if (height && weight) sentence += `an exact height of ${height}cm and weighs ${weight}kg`;
  else if (height)      sentence += `an exact height of ${height}cm`;
  else                  sentence += `a weight of ${weight}kg`;
  sentence += ".";

  const details = [];
  if (chest) details.push(`chest ${chest}cm`);
  if (waist) details.push(`waist ${waist}cm`);
  if (legs)  details.push(`inseam ${legs}cm`);
  if (details.length) sentence += ` Exact body measurements: ${details.join(", ")}.`;

  sentence += " Fit the garment strictly to these specific anatomical proportions - zero generic guessing, maximum physical fidelity.";
  return sentence;
}

/**
 * Return the signed delta between activeTryOnSize and currentUserSize in the
 * SIZE_SCALE ladder. Positive = user chose larger; negative = user chose smaller.
 * Returns 0 when either size is absent or not in the scale.
 *
 * Child sizes return 0 unconditionally: the numeric kids ladder (8-18) is not in
 * SIZE_SCALE, and a step there spans a whole growth stage rather than the
 * tight/oversized styling choice the adult delta encodes - so no fit modifier is
 * applied to the VTON prompt for child sizes. This is the SINGLE definition of
 * that rule; setSizeOverride() consumes it rather than re-deriving indices.
 * @returns {number}
 */
function getSizeDelta() {
  if (currentSizeCategory === "child") return 0;
  if (!currentUserSize || !activeTryOnSize) return 0;
  const baseIdx = SIZE_SCALE.indexOf(currentUserSize);
  const pickIdx = SIZE_SCALE.indexOf(activeTryOnSize);
  if (baseIdx === -1 || pickIdx === -1) return 0;
  return pickIdx - baseIdx;
}

/**
 * Translate a numeric size delta into a highly descriptive, textile-specific fit
 * modifier. The language is intentionally dense so the VTON engine has minimal
 * room for interpretation.
 * @param {number} delta    - getSizeDelta() result (negative = smaller, positive = larger)
 * @param {string} garmentType - "upper_body" | "lower_body"
 * @returns {string}
 */
/* ── Why the size-down wording is phrased the way it is ──────────────────────────
   These strings used to describe a SILHOUETTE - "sleek athletic compression fit,
   form-fitting tailored silhouette", "high-compression slim silhouette". A silhouette
   is the outline of the BODY, so on a shopper who sized down, the earliest and most
   concrete instruction in the prompt was read as "make this person's outline slim",
   and STRICT_INPAINT's "do not flatten, slim or reshape their physique" arrived ~1,200
   characters later to contradict it. Leading tokens dominate a realtime diffusion
   prompt (see buildCompositePrompt), so the contradiction resolved the wrong way -
   which is the "it compressed me into a thinner frame" report.
   Every clause below now attributes tightness to the GARMENT and to what the FABRIC
   does over a body whose dimensions are fixed: a smaller size stretches, pulls and
   tensions across the shopper's real contours rather than shrinking them. Same fit
   information, no instruction the body-fidelity clause has to fight. */
function getFitModifier(delta, garmentType) {
  if (garmentType === "upper_body") {
    if (delta <= -2) return "deliberately undersized garment stretched taut over the body's unchanged contours, fabric under visible tension with stretch lines radiating from the shoulders and chest, hem riding at the natural waistline";
    if (delta === -1) return "snug garment cut close to the body, fabric pulled smooth and slightly tensioned across the torso, following the shopper's real contours without compressing them";
    if (delta === 0)  return "perfectly tailored true-to-size fit, flawless natural drape with no excess fabric";
    if (delta === 1)  return "relaxed fit, slightly loose drape, comfortable room across the shoulders and chest";
    /* delta >= 2 */  return "oversized fashion-forward fit, generously dropped shoulders, easy relaxed volume through the torso, elongated hem with natural gravity drape";
  }
  /* lower_body */
  if (delta <= -2) return "deliberately undersized trousers stretched taut over the legs and hips as they actually are, fabric under visible tension at the thigh and seat with stretch lines at the waistband, full-length inseam with a tight ankle cuff";
  if (delta === -1) return "snug trousers cut close through the thigh and knee, fabric pulled smooth and slightly tensioned over the shopper's real leg shape, tapering to a narrow ankle opening";
  if (delta === 0)  return "perfectly tailored true-to-size fit, clean break at the ankle with no pooling";
  if (delta === 1)  return "relaxed wide fit, comfortable room through the thighs, natural break at the ankle";
  /* delta >= 2 */  return "wide-leg garment with generous volume through the thigh and a sweeping leg that breaks softly over the shoe, clean continuous fabric geometry";
}

/* ── Fabric-Aware Tension & Physics Conditioning ──────────────────────────────
   getFitModifier() above describes FIT - how loose or tight the cut is. This
   describes MATERIAL - how that specific fabric physically behaves once fit is
   accounted for: a dry-fit tee clings and shows compression lines under tension,
   raw denim holds a stiff, angular shape almost independent of the body inside
   it. The two compose (fit + material), they never overlap or contradict.
   Keyed by item.fabric - catalog metadata (PEAR_CATALOG), a custom upload's
   declared material, or a store handoff's fabric field - so the clause tracks
   whatever garment/colour is ACTIVE rather than being fixed per garment type. */
const FABRIC_PHYSICS = {
  dry_fit:  "a synthetic athletic dry-fit stretch material: sleek, body-conforming tension with the fabric hugging the body's real contours, subtle athletic stretch lines radiating across the chest, shoulders and back where the material tensions over muscle and bone, and a smooth skin-tight elasticity - without artificially slimming, compressing or reshaping the body underneath",
  cotton:   "medium-weight woven cotton: a natural, semi-structured drape with soft, rounded fold lines, moderate stiffness that holds its shape at the seams while relaxing over the body's contours, and a matte, breathable weave texture",
  denim:    "rigid, heavyweight denim: a structured, semi-stiff drape that holds its own shape largely independent of the body, thick angular fold lines at the hips, knees and elbows, visible top-stitching, and rigid shape retention over the body's mass - the fabric resists the body rather than clinging to it",
  silk:     "lightweight, fluid silk: a soft, liquid drape that skims the body with minimal resistance, fine cascading folds rather than sharp creases, and a subtle natural sheen that shifts with the fabric's movement",
  knitwear: "a soft knit weave: visible ribbed knit texture lines, a close, slightly elastic cling that follows the body's contours with gentle stretch recovery, and soft rolled edges at the hem, cuffs and collar rather than crisp woven seams",
};
const DEFAULT_FABRIC = "cotton";   // legacy/custom items with no declared fabric read as this, never with no physics clause at all

/**
 * Fabric-physics clause for one garment. `subject` lets a two-garment prompt
 * (buildLookPrompt) name which layer the clause is about; single-garment
 * builders leave it at the generic default.
 * @param {object} item - reads item.fabric; anything unset/unrecognized falls back to DEFAULT_FABRIC
 * @param {string} [subject]
 * @returns {string}
 */
function getFabricModifier(item, subject = "This garment's fabric") {
  const key = item && Object.prototype.hasOwnProperty.call(FABRIC_PHYSICS, item.fabric) ? item.fabric : DEFAULT_FABRIC;
  return ` ${subject} is ${FABRIC_PHYSICS[key]}.`;
}

/* Appended to every VTON prompt to lock the engine into photorealistic output.
   Kept as a module constant so changing it in one place affects all call sites. */
const QUALITY_SUFFIX = ", photorealistic real-world fabric texture, visible seams and stitching, micro-detailed weave, natural environmental lighting matching the user's room, cinematic shading, ultra-realistic physical garment appearance, strictly maintain flawless fabric integrity, continuous realistic 3D mesh, and natural material physics without any glitching, strange horizontal bands, tearing, or unnatural structural folds";

/* Bias the model toward keeping graphics/logos/text and the bottom-hem edge details in
   their original scale, proportion and relative position, and to render the full hem in
   frame. Lucy regenerates every frame, so this is a probabilistic bias, not a guarantee. */
const HEM_DETAIL = " Preserve the garment's printed graphics, logos, and text, and its bottom-hem edge details (including any small corner monogram or brand mark), at their original scale, proportion, and relative position on the garment; render the complete hem in-frame without cropping, stretching, or drifting details toward the center.";

/* Layer-isolation clauses. Lucy VTON regenerates the WHOLE frame every pass, so a
   single-garment prompt that never mentions the opposite layer lets that layer
   drift (e.g. trying a shirt silently restyles the user's real pants). These hard
   "do not touch" instructions pin the untouched layer to the live camera so a
   top swap edits ONLY the top, and a bottom swap edits ONLY the bottom. */
const KEEP_BOTTOMS = " Keep the person's existing lower body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the trousers, shorts, skirt, shoes, belt, or anything below the waist, and do not add, invent or restyle any accessories that were not already present.";
const KEEP_TOP     = " Keep the person's existing upper body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the shirt, top, jacket, hat, scarf, jewelry, or anything above the waist, and do not add, invent or restyle any accessories that were not already present.";

/* ── Model-agnostic extraction - the OTHER body in the pipeline ───────────────
   THE GAP: every clause in this file that defends body shape defends it against the
   model's own training prior (STRICT_INPAINT's "it slimmed me down", SIDE_PROFILE_DEPTH's
   flattened profile). None of them account for the fact that the reference image usually
   contains A SECOND HUMAN - the e-commerce model wearing the product - and that Lucy sees
   that figure as part of its conditioning. IGNORE_SOURCE_ARTIFACTS is the nearest thing
   and it is deliberately scoped to non-human noise: badges, watermarks, orientation
   labels. A whole person in the reference asset was never named, so their shoulder line,
   chest, build and posture sat in the conditioning with nothing marking them as
   off-limits - and an unstated region is exactly what this file's history keeps recording
   as the thing that gets reinterpreted. That is the "it gave me the model's shoulders"
   report: not a detection failure, an unstated constraint, same class as every other bug
   these constants exist for.

   DELIBERATELY NOT A RESTATEMENT of ABSOLUTE BODY FIDELITY below. That clause already
   says the live person's shape is 1:1 ground truth and that the garment fits the body
   rather than the reverse; repeating it here would spend several hundred characters
   re-asserting it ~200 characters before it actually appears, against a prompt this file
   already argues is competing for the model's attention. What is genuinely new is the
   PROVENANCE SPLIT - the reference is the only source of cloth, the live feed is the only
   source of body - so that is what this carries, and it hands off to STRICT_INPAINT for
   the positive fidelity language it is placed directly ahead of.

   THE PRINT-PLACEMENT CARVE-OUT at the end is load-bearing, not padding. "Re-proportion
   the garment to their body" and BACK_TAIL.real's "keep each element at the SAME size,
   height and horizontal position, do not move, rescale or re-center the back print" are
   one bad reading apart from contradicting each other, and that print alignment was its
   own fix. Scaling the garment to a different body must not become licence to relocate
   its artwork on the garment, so the boundary is stated rather than left to inference. */
const MODEL_AGNOSTIC_EXTRACTION =
  " GARMENT ISOLATION MANDATE: the reference image is a TEXTURE AND CLOTHING TEMPLATE and" +
  " nothing more. Extract ONLY the garment from it - fabric, weave, colour, pattern, print," +
  " logos, seams, cut, collar, closure and hemline. If a person, model or mannequin is" +
  " wearing that garment in the reference, they are packaging: completely ignore their" +
  " body, physique, height, build, skin tone, shoulder width, chest, waist, limb positions" +
  " and posture." +
  " ZERO MODEL BLEED: do NOT transfer, copy, blend, average or impose ANY of that reference" +
  " figure's anatomy, proportions, pose or body structure onto the live person, and never" +
  " reshape the live person toward them. The live camera feed is the ONLY source of BODY;" +
  " the reference image is the ONLY source of CLOTH." +
  " DYNAMIC USER FITTING: fit, stretch, drape and re-proportion the extracted garment onto" +
  " the live person's own exact body shape and volume - their real torso, chest, stomach," +
  " waist and hips - so it reads as cut for THEM, with fabric tension, creases and folds" +
  " following their contours rather than the reference figure's. Re-proportioning the" +
  " garment to their body is NOT licence to move its artwork: any print, graphic, logo or" +
  " lettering keeps the size, height and position on the garment specified above.";

/* ── Strict garment inpainting - the hallucination clamp ──────────────────────
   KEEP_BOTTOMS/KEEP_TOP only ever pinned the OPPOSITE GARMENT layer. Everything else in
   frame - face, hair, hands, skin, the room behind the shopper, AND the shopper's own
   body shape/volume under the new garment - was simply never mentioned, and Lucy
   regenerates the WHOLE frame on every pass. Anything the prompt does not pin is a
   region the model is free to reinterpret, which is what "it changed my pants / my
   background" - and separately, "it slimmed me down" - actually is: not a bug in the
   model so much as an unstated constraint. The body-fidelity clause below exists
   because the model's training prior skews toward idealized/slim proportions, so a
   fuller torso, belly or wider waist gets quietly flattened toward that prior unless
   the prompt explicitly forbids it every single frame.

   READ THIS BEFORE REACHING FOR A MASK OR A CONDITIONING WEIGHT. There is no mask, ROI,
   DensePose/depth input, ControlNet conditioning scale, or inpainting-region parameter on
   Lucy realtime - set() takes exactly { prompt, enhance, image } (verified against
   @decartai/sdk@0.1.5 setInputSchema, which strips everything else). The prompt text is
   the ONLY channel this SDK exposes; there is no "mask config" or "conditioning scale" to
   turn up. A true pixel-locked boundary would have to be enforced OUTSIDE the model:
   segment the torso locally per frame (DensePose/SAM or similar) and composite Decart's
   output over the untouched camera frame everywhere else. That is a real, separate
   feature - a segmentation model in the hot path at LIVE_INFERENCE_FPS - not a parameter
   this file can set, and it is deliberately NOT what this constant is. This is the
   strongest available lever through the one channel the API actually exposes, and it is a
   probabilistic bias on every generated frame, not a guarantee. */
const STRICT_INPAINT =
  " STRICT GARMENT INPAINTING MODE: edit ONLY the target garment(s) named above. Every" +
  " other pixel is locked source footage that must pass through EXACTLY as it appears in" +
  " the live video frame - the person's face, hair, head, neck, hands, arms and skin, and" +
  " the entire background, room and lighting. Do NOT generate, replace, restyle, recolor" +
  " or re-render the background, or any part of the person outside the target garment(s)." +
  " ABSOLUTE BODY FIDELITY: 1:1 adherence to the person's exact detected body shape," +
  " weight, volume and silhouette exactly as captured in the live frame, including their" +
  " chest, stomach/belly shape, hips, waist circumference and torso width. Do NOT flatten," +
  " slim, smooth, thin, reshape or idealize their physique in any way, and do NOT shrink" +
  " the chest, torso, waist, hips or belly boundary inward toward a thinner baseline. If" +
  " the person has a fuller figure, belly, wider hips or wider torso, drape and stretch the" +
  " garment realistically OVER their actual chest, stomach, hips and body volume - with" +
  " natural fabric tension, creases and shadow folds where it meets their real contours," +
  " not a flat model-cut fit. Map the garment onto that exact physical volume: fit the" +
  " garment to the body; never the body to the garment." +
  " STRICT GARMENT ISOLATION: replace and fit only the target garment named above - this is" +
  " a single-item substitution, not a full-outfit restyling. Preserve the shopper's" +
  " existing pants, shorts, skirt, belt and every other accessory exactly as seen in the" +
  " live camera frame: no added belts, no unrequested pants, no added accessories, and no" +
  " invented clothing items of any kind outside the one garment specified.";

/* ── Source-frame hygiene - camera/UI artifacts are not garment content ───────
   STRICT_INPAINT above says the live frame outside the target garment is "locked
   source footage" to pass through untouched - but it never said what to do with
   pixels that were never real footage of the person or garment in the first
   place: a product photo's price sticker or hangtag, a watermark, a capture
   timestamp, or any app/browser chrome that leaks into a frame. Nothing upstream
   filters these out before the prompt runs, and an unstated pixel is exactly the
   kind of region the model is free to reinterpret (the same class of gap
   STRICT_INPAINT's own comment documents for body shape) - so a stray badge or
   label sitting on a reference image reads as "content on the garment" with
   nothing telling the model otherwise, risking a rendered logo/print that never
   belonged to the actual product. Named explicitly as noise to discard. */
const IGNORE_SOURCE_ARTIFACTS =
  " Ignore any incidental on-screen text, UI overlays, badges, orientation labels" +
  " (e.g. \"FRONT\"/\"BACK\"), timestamps, watermarks or frame borders present in the" +
  " source image or live video feed - these are capture artifacts, not part of the" +
  " garment or the person, and must never be rendered, reproduced or interpreted as" +
  " clothing design, print or texture.";

/* ── Side-profile anomaly guard - what the garment drapes OVER while turned ───
   Paired with ROTATION_CONTINUITY below, which keeps the garment ON through a
   turn; this addresses a different failure in the same window. In profile the
   body's silhouette foreshortens, and whatever the shopper happens to be
   holding (a phone, a bag, any held object) or brief lens/motion distortion
   during the turn can sit right where torso volume would otherwise read. With
   nothing telling the model these aren't anatomy, they get treated as body the
   garment must fit around - an anomalous bulge or shape at exactly the moment
   the pose is already hardest to read.
   NOT the same claim as, and does NOT relax, STRICT_INPAINT's ABSOLUTE BODY
   FIDELITY guarantee above - that clause exists specifically because this
   model's training prior skews toward slimming real bodies, and was written
   after that exact complaint. This one is scoped ONLY to non-anatomical
   objects and transient capture artifacts; the person's actual body, at any
   angle including side-on, is still rendered with the same fidelity as head-on -
   never thinned, flattened or idealized. */
const PROFILE_ANOMALY_GUARD =
  " While the person is side-on or turning, do not mistake held objects, props," +
  " clothing caught by motion, or transient camera/lens distortion for part of" +
  " their body - these must never distort the rendered garment's fit or shape." +
  " Drape the garment following the person's actual, undistorted anatomical body" +
  " contour only, at exactly the same body-shape fidelity required at every other" +
  " angle - never as license to slim, smooth or idealize their real silhouette.";

/* ── Rotation continuity - the "my real shirt came back" clamp ────────────────
   Paired with the freeze-through-the-turn hold in the OrientationWatcher (see
   ORIENT_TURN_HOLD_MS). The hold covers the window visually; this tells the model what
   the window is FOR, so the frames it generates during the rotation are still dressed.

   The failure it addresses: mid-turn the shopper is in profile, the torso is foreshortened
   and the face is leaving frame. With nothing in the prompt about rotation, the most
   probable continuation for a partially-occluded person is the person as photographed -
   i.e. their real shirt. Naming the turn as an expected, continuous state makes staying
   dressed the likelier completion. */
const ROTATION_CONTINUITY =
  " The person may rotate to any angle, including turning fully away from the camera." +
  " Throughout the rotation the virtual garment stays ON the body, continuously fitted," +
  " with no frame in which it is dropped, faded, or replaced by the person's own real" +
  " clothing - even while they are side-on, partially occluded, or facing away with no" +
  " face visible. Carry it through the turn and transition smoothly to the correct side" +
  " of the reference as the body comes around.";

/* Universal hard negative appended to EVERY prompt (per product spec). Bars the opposite
   view's signature details from leaking in when the back is being rendered - a belt-and-
   suspenders backstop alongside ANGLE_CLAUSE.backReal/backInferred's own "do NOT render
   the front" instruction. */
const HARD_NEGATIVE = " Strictly prevent the rendering of FRONT details (like logos or front-pockets) when the BACK view is requested.";

/* THE MAIN ENTRY POINT for a single-garment dispatch, and the function the dynamic-drape
   contract is stated through: it resolves to CATEGORY_ANCHOR.top or .bottom, which are the
   two strings that tell the model the GARMENT is static and the BODY is per-frame. See
   CATEGORY_ANCHOR for the wording, the failure it answers, and the two clamps it gave up.

   `angleText` is angleClause()'s output, passed IN rather than concatenated on by the
   caller. That is what makes the budget enforceable: the old shape was
   `buildPrompt(item) + angleClause(...)`, two independently-sized strings glued together
   downstream, so neither half could know the total and nothing could shed a clause when
   the pair overran. Threaded through here, the orientation clause becomes one more
   priority-tagged part in a single fitPrompt() call - and it ranks CORE, because a prompt
   that has lost its orientation clause renders the wrong side of the garment. It is
   retained-and-unused today (see buildCompositePrompt's note on the same seam). */
function buildPrompt(item, angleText = "") {              // eslint-disable-line no-unused-vars
  return imageOnlyPrompt(item);
}

/**
 * Prompt for a user-uploaded ("custom") garment. Returns IMAGE_ONLY_PROMPT.
 *
 * IDENTICAL TO buildPrompt(), and has been since the image-first refactor rather than by
 * oversight. These two diverged for exactly one reason: a catalog item had metadata to
 * describe ("white t-shirt") and an upload did not, so the custom path pointed at the
 * reference image while the catalog path recited catalog fields. Neither describes
 * anything now, so there is nothing left to differ about - a shopper's uploaded photo and
 * a catalog packshot are the same kind of asset and get the same treatment.
 *
 * Kept as its own function because it is the documented entry point for the upload flow
 * and because the dispatch is a seam worth keeping: if the two ever need to diverge again
 * (a crop-confidence hint, say), it is already here. buildPrompt() no longer branches to
 * it - a branch between two identical returns is a false signal that they differ.
 * @param {object} item - a custom item ({ custom:true, garmentType, img, color })
 * @returns {string}
 */
function buildCustomPrompt(item, angleText = "") {        // eslint-disable-line no-unused-vars
  return imageOnlyPrompt(item);
}

const APPLY_ATTEMPTS = 2;    // set() tries per apply - see applyActive()
const APPLY_RETRY_MS = 200;  // gap between them; must stay well under ORIENT_TURN_HOLD_MAX_MS

/**
 * Apply whatever the user is currently trying on: the FULL look (shirt + pants in
 * ONE payload) when BOTH outfit slots are filled, otherwise the single active
 * garment. The single entry point goLive() and mid-session swaps call, so the live
 * flow stays identical for both modes.
 * @returns {Promise<void>}
 */
async function applyActive() {
  /* ── Skip cleanly while the SDK is mid-reconnect - BUT ONLY for an ALREADY-DRESSED
     session ─────────────────────────────────────────────────────────────────────
     "reconnecting" means StreamSession.scheduleReconnect() (stream-session.js) is
     already running its own multi-second recovery (p-retry, up to 1s/2s/4s/8s/10s
     between attempts) - every send() the SDK exposes calls assertConnected() first
     and throws immediately if the state isn't "connected"/"generating", so a set()
     fired here would fail on contact, and the loop below would burn both of ITS
     attempts (400ms total) against a recovery that operates on a completely
     different timescale.
     Gated on isGarmentApplied, and that gate is load-bearing, not incidental: the
     safety net this skip relies on - buildRealtimeConnectOpts()'s onConnectionChange
     re-running this exact function once the SDK actually reconnects - ONLY fires
     under that same isGarmentApplied condition (see its comment). Without the gate
     here, the very FIRST applyGarment() of a session (goLive()'s own call, before
     the shopper has ever been successfully dressed) could hit a reconnect that just
     started, skip silently, and have NOTHING re-apply it afterward - stranding the
     shopper undressed with no error at all, which is worse than the failure this
     exists to prevent. So a first-ever apply falls through to the retry loop below
     exactly as it always did (unaffected by this change); only a session that was
     already dressed once skips, because that is the one case with a recovery path
     waiting to restore it. */
  if (connState === "reconnecting" && isGarmentApplied) {
    console.log("[PEAR] applyActive() - skipped: SDK is mid-reconnect; will re-apply once it lands");
    return;
  }

  /* ── Bounded retry: a dropped set() used to cost the WHOLE session ────────────
     Every call site fires this and forgets it (`.catch(console.warn)`), because none
     of them - a colour tap, a mid-turn orientation flip, "Add to Look" - has anything
     useful to do with a rejection. So a single transient rtClient.set() failure (a
     datachannel stall, a re-negotiation blip) meant the garment silently never reached
     the model and the shopper watched their OWN clothes for the remainder of a 5s
     billed window, with the UI still claiming to be dressing them. That is the
     "it dropped back to my real clothes mid-session" report.
     Two attempts, ~200ms apart: the composite/Blob work behind applyGarment() is
     memoized, so the retry re-sends rather than rebuilds, and the whole path stays far
     inside the orientation watcher's ORIENT_TURN_HOLD_MAX_MS ceiling. Anything that
     fails twice is a dead session, not a hiccup - it rethrows to the caller's log. */
  for (let attempt = 1; attempt <= APPLY_ATTEMPTS; attempt++) {
    try {
      const look = resolveLook();    // non-null only when activeOutfit has top AND bottom
      if (look) await applyLook(look.top, look.bottom);
      else await applyGarment(activeItem);
      isGarmentApplied = true;       // rtClient.set() resolved - the NEXT rendered frame is dressed
      releaseInputGate("applyActive");
      return;
    } catch (e) {
      if (attempt === APPLY_ATTEMPTS || !rtClient || !isLive()) throw e;
      console.warn(`[PEAR] applyActive attempt ${attempt}/${APPLY_ATTEMPTS} failed - retrying:`, e?.message || e);
      await new Promise((r) => setTimeout(r, APPLY_RETRY_MS));
    }
  }
}

/**
 * Render BOTH garments of a verified look in ONE realtime set() call - never two
 * sequential requests (that would double-spend the strict 5s window). The unified
 * prompt names the shirt AND the pants, so the model renders the full outfit in a
 * single pass / one stream.
 *
 * SDK reality (verified against @decartai/sdk@0.1.5 `setInputSchema`): realtime
 * set() accepts exactly { prompt, enhance, image } and STRIPS unknown keys, so only
 * ONE reference image reaches the model today - a text-only description of a garment
 * with no pixel reference renders weakly (or not at all), which is what made "Add to
 * Look" look like it REPLACED the current garment instead of layering it. So the ONE
 * image we send is a stitchLookBlob() composite of BOTH garments (TOP over BOTTOM),
 * giving each an actual visual reference. We still bundle both image URLs + their
 * categories alongside it (images / garments) so they are forward-compatible the day
 * the model accepts true multi-garment input. The try/catch falls back to the minimal
 * documented shape so a full look can never break the live session.
 * @returns {Promise<void>}
 */
async function applyLook(top, bottom) {
  if (!rtClient) throw new Error("not connected");

  // Gallery sync: resolve each half against the active angle first.
  const topImg = activeImageOf(top), bottomImg = activeImageOf(bottom);

  // The SDK forwards exactly ONE image ({prompt, enhance, image} - extra keys are
  // stripped), so a text-only description of the second garment gets a real pixel
  // reference for the top but none for the bottom, and the model renders only the
  // top - visually indistinguishable from "replace". stitchLookBlob() gives BOTH
  // garments an actual reference by compositing them (TOP over BOTTOM) into the
  // single image the SDK does forward. Skip it for AI Auto, which already needs
  // that one image slot for its own per-orientation front/back Blob.
  const canStitchLook = currentAngle !== AUTO_ANGLE;
  /* Snapshotted BEFORE the stitch await for the reason applyGarment() documents at
     angleAtStart/profileAtStart: stitchLookBlob() is a real async gap, and the watcher's
     independent sampler can toggle the pose during it. The existing comment that
     applyLook() "has no per-orientation reference to race against" is about the ANGLE,
     which selects a reference this path does not use per-orientation; the pose clause
     below is read live and would race. */
  const profileAtStart = profileActive();
  let primaryImage = canStitchLook ? await stitchLookBlob(topImg, bottomImg) : null;
  const prompt = clampPromptForWire(primaryImage
    ? buildLookPrompt(top, bottom, DENSE.lookPanels)
    : buildLookPrompt(top, bottom, angleClause(undefined, undefined, undefined, profileAtStart)),
    "applyLook");

  if (!primaryImage) {
    // Stitch unavailable (AI Auto angle) or failed to decode - fall back to the
    // single top reference so the live session is never left without ANY image.
    if (canStitchLook) console.warn("[PEAR] look stitch failed; falling back to top-only reference");
    primaryImage = (await referenceImageFor(top, topImg)) ?? null;
  }
  /* …and if even THAT came back empty, the bottom's own asset, before giving up. Same
     reasoning as applyGarment()'s recovery sweep: buildLookPrompt() no longer describes
     either garment, so a payload with no image is a prompt pointing at nothing. One
     garment referenced is strictly better than none. */
  if (!primaryImage) {
    primaryImage = garmentImageRef(topImg) || garmentImageRef(bottomImg) || null;
    if (primaryImage) console.warn("[PEAR] applyLook() - stitch and top reference both failed;",
      "falling back to a single raw garment ref:", abbrevImg(primaryImage));
  }
  if (!primaryImage) {
    console.error("[PEAR] applyLook() - NO garment asset resolved for this look",
      `(${top?.name} + ${bottom?.name}).`,
      "\n  → the prompt is image-first and has no reference to condition on;",
      "Decart will render its own default garments.");
  }
  const images = [topImg, bottomImg].filter(Boolean).map(garmentImageRef).filter(Boolean);

  // ONE combined payload - both garments, one pass, same session.
  /* The image key is OMITTED rather than set to null when nothing resolved. `image: null`
     is not the same thing as no image: it is an explicit empty value on a key the SDK
     validates, and it is exactly the "sent as an empty/default image state" shape that
     looks, in a payload log, like a reference was delivered when none was. */
  const payload = {
    prompt,
    enhance: false,
    ...(primaryImage ? { image: primaryImage } : {}),   // SDK single-image slot: TOP+BOTTOM stitched composite (or fallback)
    images,                           // both verified proxy URLs, bundled together
    garments: [                       // per-slot metadata incl. category (top|bottom)
      { category: "top",    type: top.garmentType,    image: topImg,    color: top.color,    subType: top.subType,    name: top.name,    angle: currentAngle },
      { category: "bottom", type: bottom.garmentType, image: bottomImg, color: bottom.color, subType: bottom.subType, name: bottom.name, angle: currentAngle },
    ],
  };

  console.log("[DECART PROMPT DEBUG]", prompt, abbrevImg(primaryImage));
  // DEBUG WRAPPER, typeof-guarded - see the matching comment in applyGarment().
  if (typeof verifyGarmentAsset === "function") verifyGarmentAsset(payload, "applyLook");
  /* ONE wire slot for BOTH attempts, deliberately: the minimal retry is a fallback for
     the SAME dispatch, so releasing the mutex between them would let a queued write slip
     in and leave the look half-applied behind someone else's payload. */
  await sendCondition("applyLook", async () => {
    try {
      await rtClient.set(payload);
    } catch (e) {
      // A stricter SDK build may reject the enriched shape - retry with the minimal contract.
      console.warn("look payload rejected, retrying minimal:", e?.message || e);
      console.log("[DECART PROMPT DEBUG] (retry, minimal payload)", prompt, abbrevImg(primaryImage));
      // Same omit-don't-null rule as the enriched payload above.
      await rtClient.set({ prompt, enhance: false, ...(primaryImage ? { image: primaryImage } : {}) });
    }
  });
  /* Keep the reference tracker honest: a look sends its OWN stitched image, so whatever
     applyGarment() last recorded is no longer what the model holds. Without this, going
     look → single garment could match a stale lastSentImageRef and take the prompt-only
     path against the wrong reference. */
  lastSentImageRef = primaryImage || null;
  rtImageOnWire = !!primaryImage;
  lastSentPrompt = prompt;
  if (primaryImage) lastAckedImageRef = primaryImage;
}

/**
 * Build ONE prompt that instructs the model to overlay the shirt AND the pants
 * simultaneously (a single pass), so a full outfit is rendered together rather
 * than as two separate substitutions.
 */
function buildLookPrompt(top, bottom, angleText = "") {   // eslint-disable-line no-unused-vars
  /* THE ONE PLACE THIS MODE IS A REAL BET RATHER THAN A CLEAN WIN, recorded so it is not
     discovered by surprise. A full look ships ONE stitched reference holding two garments
     (TOP over BOTTOM), and DENSE.lookPanels is what told the model that image was two
     garments to render simultaneously rather than one to choose between. Strict image-only
     removes it, so the layout now has to carry that entirely on its own - which the
     stitcher is built for (isolated panels, wide separator band; see stitchLookBlob) but
     which was never tested without the sentence.

     If a look starts rendering only the shirt, or blending the two, DENSE.lookPanels is
     the first clause to buy back - and it is the one clause in this file whose absence
     costs a whole FEATURE rather than a degree of fidelity. */
  /* DELIBERATELY NOT imageOnlyPrompt(). The BOTTOMS branch there pins the opposite layer
     to the live camera - "Keep the subject's upper body and background unmodified." -
     which is exactly the instruction a full look must not carry: addToLook() ships a
     two-garment payload precisely because the shopper asked for both layers to be
     substituted, and telling the model to preserve the live top while handing it a
     stitched TOP+BOTTOM reference is a contradiction that resolves however the sampler
     feels like resolving it.

     THE TOPS BRANCH IS NOT SAFE HERE EITHER, and it is worth saying why, because it no
     longer carries that sentence: it still names ONE region ("the EXACT upper garment
     ... onto the subject") against a reference holding two garments, which is the
     wrong-region contradiction that opened this whole sequence. Neither branch is a
     substitute for this one. This anchor claims both layers instead, and carries the same
     STRICT_REFERENCE_LOCK the two single-garment branches do. */
  return lookAnchorPrompt();
}

/* =============================================================================
   Size Override Selector - Screen 2 (Try-On room)
   ─────────────────────────────────────────────────────────────────────────
   A glassmorphism button row injected below the active-garment chip. The scale
   depends on currentSizeCategory: adults get SIZE_SCALE (XS / S / M / L / XL /
   XXL / 3XL), children get CHILD_SIZE_SCALE (8 / 10 / 12 / 14 / 16 / 18) and no
   adult option is rendered at all.
   The button matching currentUserSize is highlighted by default.
   Selecting a different size sets activeTryOnSize, which buildFitModifier() then
   uses to append tight-fit or oversized descriptors to the VTON prompt. If a
   WebRTC session is already live, applyActive() is called immediately so the
   garment resizes without restarting the connection.
   ============================================================================= */
function injectSizeSelector() {
  // Remove any stale selector from a previous room entry before rebuilding.
  const old = $("pearSizeSelector");
  if (old) old.remove();

  /* Nothing to pick from on a blocked product - offering a size ladder for a garment
     the shopper has just been told they cannot try on is the contradiction the report
     showed (adult buttons drawn over a kids-only item). Left removed, not disabled. */
  if (hasSizeCategoryMismatch()) return;

  if (!$("pearSizeSelectorStyles")) {
    const s = document.createElement("style");
    s.id = "pearSizeSelectorStyles";
    s.textContent = `
      /* Liquid-glass size selector - matches the liquid-glass theme in style.css.
         Light refractive pod, glass pill tiles, pear-green active glow.

         LAYOUT FIX: this used to be ONE flex row - label, the button group, and
         the "★ recommended" hint all as direct flex children of a single
         align-items:center container with border-radius:100px (a full stadium
         shape). That only looks right if everything fits on one line. With 7
         sizes (SIZE_SCALE: XS/S/M/L/XL/XXL/3XL) plus the label and hint, a
         narrow phone screen doesn't have room for that - .pear-sz-btns wraps
         its own buttons onto 2-3 lines internally, and because it was still
         just ONE item in an align-items:center row, the label and hint floated
         to the VERTICAL CENTER of that now-tall wrapped block - landing
         visually in the MIDDLE row of buttons instead of staying put, and the
         100px stadium radius around 3 wrapped rows read as a broken blob
         rather than a pill.
         Fix: split into two always-separate rows - a header row (label + hint,
         never touched by however many rows the buttons wrap to) stacked above
         a button-grid row. A normal card radius replaces the stadium shape,
         since this can genuinely be 1-3 rows tall depending on screen width. */
      #pearSizeSelector {
        display: flex;
        flex-direction: column;
        gap: 8px;
        /* SPACING FIX: bottom margin was 4px - barely any air before the camera
           stage directly below this pod. 20px gives it real breathing room. */
        margin: 14px 0 20px;
        padding: 12px 16px;
        background: linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.18) 100%);
        border: 1px solid rgba(255,255,255,0.55);
        border-radius: 22px;
        backdrop-filter: blur(25px) saturate(210%);
        -webkit-backdrop-filter: blur(25px) saturate(210%);
        box-shadow: 0 8px 32px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.6);
      }
      .pear-sz-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .pear-sz-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .12em;
        text-transform: uppercase;
        color: #5f7d00;
        white-space: nowrap;
        flex-shrink: 0;
      }
      /* SYMMETRY FIX: was a plain flex-wrap row with no justify-content (default
         flex-start) and no fixed per-button width - with all 7 SIZE_SCALE entries
         (XS/S/M/L/XL/XXL/3XL), that let however many happened to fit on line 1 (6)
         wrap the single leftover (3XL) onto line 2, stuck to one edge with a big
         empty gap beside it. Two changes fix this together:
           • each button's flex-basis is pinned to calc(25% - 4.5px) - exactly
             ("100% - 3 gaps of 6px" / 4) - so rows are ALWAYS a clean 4-then-3
             split for these 7 sizes, not whatever the browser's organic wrap
             happens to land on.
           • justify-content:center centers each row's own content - including
             the short 3-item second row, which now sits centered instead of
             flush to one side. */
      .pear-sz-btns {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: center;
      }
      .pear-sz-btn {
        /* flex-basis pinned to a quarter-row (minus its share of the 6px gaps) so
           these 7 buttons always land as a clean 4-then-3 split - see the
           SYMMETRY FIX note on .pear-sz-btns above. min-width stays as a floor for
           very narrow screens where 25% would otherwise shrink below readable. */
        flex: 0 1 calc(25% - 4.5px);
        min-width: 40px;
        text-align: center;
        padding: 7px 13px;
        border-radius: 100px;
        border: 1px solid rgba(255,255,255,0.55);
        background: rgba(255,255,255,0.42);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
        color: #3a362f;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .04em;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.5);
        transition: all .5s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .pear-sz-btn:hover {
        transform: translateY(-2px);
        background: rgba(255,255,255,0.7);
        border-color: rgba(141,182,0,0.45);
        color: #0a0a0b;
        box-shadow: 0 8px 22px rgba(0,0,0,0.12);
      }
      .pear-sz-btn:active { transform: scale(0.94); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
      .pear-sz-btn.is-active {
        background: rgba(141,182,0,0.16);
        border-color: rgba(141,182,0,0.55);
        color: #5f7d00;
        box-shadow: 0 0 0 1px rgba(141,182,0,0.25), 0 6px 20px rgba(141,182,0,0.25),
                    inset 0 0 12px rgba(141,182,0,0.18);
        animation: pearSzPulse 2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
      }
      @keyframes pearSzPulse {
        0%, 100% { box-shadow: 0 0 0 1px rgba(141,182,0,0.22), 0 6px 20px rgba(141,182,0,0.22), inset 0 0 12px rgba(141,182,0,0.16); }
        50%      { box-shadow: 0 0 0 3px rgba(141,182,0,0.30), 0 10px 28px rgba(141,182,0,0.34), inset 0 0 18px rgba(141,182,0,0.28); }
      }
      .pear-sz-hint {
        /* margin-left:auto removed - .pear-sz-head's own justify-content:space-between
           now positions this, no longer needs to fight for its own space. */
        font-size: 10px;
        font-weight: 600;
        color: #6b6b70;
        white-space: nowrap;
        flex-shrink: 0;
      }
      @media (prefers-reduced-motion: reduce) {
        .pear-sz-btn.is-active { animation: none; }
      }
    `;
    document.head.appendChild(s);
  }

  const row = document.createElement("div");
  row.id = "pearSizeSelector";
  row.setAttribute("aria-label", "Size override selector");

  /* THE PRODUCT'S OWN SIZES WIN. Rendering a generic XS-3XL ladder over a garment the
     storefront sells in 8/10/12/14/16 was the second half of the FOX kids-tee report:
     every button offered a size the shopper could not actually buy. When the host page
     told us what it stocks, those are the only buttons there is any point drawing.
     The generic scales below remain the fallback for catalog/demo items and for any
     storefront we couldn't read a size list from. */
  const productSizes = parseSizeList(activeItem?.sizes ?? pendingSizes);
  const scale = productSizes.length ? productSizes
    // Child results get the numeric kids ladder ONLY - no adult S/M/L/XL button is
    // rendered at all, so there is nothing for a child profile to cross over into.
    : (currentSizeCategory === "child" ? CHILD_SIZE_SCALE : SIZE_SCALE);

  const current = activeTryOnSize || currentUserSize;
  const btnHtml = scale.map((sz) => {
    const isActive = sz === current;
    const isRec    = sz === currentUserSize;
    return `<button class="pear-sz-btn${isActive ? " is-active" : ""}" data-sz="${sz}" type="button" aria-pressed="${isActive}">${sz}${isRec ? " ★" : ""}</button>`;
  }).join("");

  row.innerHTML =
    `<div class="pear-sz-head">` +
      `<span class="pear-sz-label">מידה · Size</span>` +
      (currentUserSize ? `<span class="pear-sz-hint">★ מומלצת</span>` : "") +
    `</div>` +
    `<div class="pear-sz-btns">${btnHtml}</div>`;

  row.addEventListener("click", (e) => {
    const btn = e.target.closest(".pear-sz-btn");
    if (btn) setSizeOverride(btn.dataset.sz);
  });

  // Insert directly below the active-garment chip; fall back to #cameraCard.
  const anchor = $("activeGarment");
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
  } else {
    const cc = $("cameraCard");
    if (cc) cc.appendChild(row);
  }
}

/**
 * Switch the active try-on size, refresh button highlight states, and - if a
 * WebRTC session is currently live - push a new prompt payload immediately so
 * the garment resizes in real-time without restarting the connection.
 * @param {string} size - an entry from whichever scale the selector was built with:
 *                        SIZE_SCALE for adults, CHILD_SIZE_SCALE ('8'-'18') for children
 */
function setSizeOverride(size) {
  activeTryOnSize = size;

  document.querySelectorAll(".pear-sz-btn").forEach((btn) => {
    const on = btn.dataset.sz === size;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });

  if (isLive()) {
    applyActive().catch((e) => console.warn("size override apply:", e?.message || e));
  }

  // Toast wording derives from the ONE delta definition in getSizeDelta() rather
  // than re-deriving ladder indices here. `onLadder` mirrors exactly the conditions
  // under which that delta is meaningful, so a 0 from a child size takes the
  // neutral branch instead of falsely reading as "perfect fit".
  const onLadder = currentSizeCategory === "adult" &&
    SIZE_SCALE.includes(currentUserSize) && SIZE_SCALE.includes(size);
  const delta = getSizeDelta();
  if (!onLadder) {
    toast(`מידה שנבחרה: <b>${size}</b>`);
  } else if (delta < 0) {
    toast(`מידה <b>${size}</b> - הלבוש יראה הדוק יותר`);
  } else if (delta > 0) {
    toast(`מידה <b>${size}</b> - הלבוש יראה גדול יותר`);
  } else {
    toast(`מידה <b>${size}</b> - התאמה מדויקת`);
  }
}

/* =============================================================================
   Analytics - fire-and-forget try-on event (backend appends to Google Sheets)
   No PII is sent: only garment metadata and the recommended size.
   ============================================================================= */
function logTryOnAnalytics(item, size) {
  if (!item) return;
  const payload = {
    garmentId:   item.id          ?? "",
    garmentName: item.name        ?? "",
    garmentType: item.garmentType ?? "",
    subType:     item.subType     ?? "",
    // Lands in Sheets (/api/track-tryon → lib/sheets.js), a free-text cell with no
    // length cap - unlike logSessionMeasurements()'s Supabase-bound payload below,
    // formatting here is safe. "-" (not "") when unresolved, for the same
    // "intentional no-match marker, not a blank cell" reason as elsewhere.
    size:        formatSizeLabel(size) ?? "-",
  };
  console.log("[analytics] firing /api/track-tryon →", payload);
  fetch("/api/track-tryon", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  })
    .then(r => {
      console.log("[analytics] /api/track-tryon response:", r.status, r.ok ? "ok" : "ERROR");
      return r.json().then(body => console.log("[analytics] response body:", JSON.stringify(body)));
    })
    .catch(err => console.error("[analytics] /api/track-tryon fetch failed:", err));
}

/* =============================================================================
   Admin dashboard - anonymized session log
   One stable, anonymous id per browser session (NO name/email/PII). It lets the
   admin dashboard group multiple try-ons by the same visitor without ever
   identifying who they are.
   ============================================================================= */
const PEAR_SESSION_ID = (() => {
  const rnd = () =>
    (crypto?.randomUUID?.() ||
     "s-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2));
  try {
    let v = sessionStorage.getItem("pear_session_id");
    if (!v) { v = rnd(); sessionStorage.setItem("pear_session_id", v); }
    return v;
  } catch { return rnd(); }
})();

/* =============================================================================
   RETURNING-USER IDENTITY
   -----------------------------------------------------------------------------
   First-time visitors enter name + email ONCE. We generate a persistent device
   id (localStorage 'pear_device_id') and create a user server-side. On every
   later visit we find that device id, load the profile, and skip the form - new
   measurements just attach to the existing user via sessions.user_id.
   ============================================================================= */
const PEAR_DEVICE_KEY = "pear_device_id";
let PEAR_USER_ID = null;   // users.id once known - stamped onto each saved session

function getDeviceId() {
  try { return localStorage.getItem(PEAR_DEVICE_KEY) || ""; } catch { return ""; }
}
function setDeviceId(v) {
  try { localStorage.setItem(PEAR_DEVICE_KEY, v); } catch {}
}
function newUuid() {
  return (crypto?.randomUUID?.() ||
    "d-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2));
}

/* =============================================================================
   DEMO MODE - scoped to ONE specific embed, never the general product
   -----------------------------------------------------------------------------
   The fitting room is shared infrastructure: the SAME app.js/index.html serves
   real merchant embeds and the main platform (full name/email registration,
   no measurement limit) AND the public marketing-site demo widget on
   pear-platform.vercel.app (no registration, one measurement per browser).

   The two must never be conflated, so this is opt-in and explicit - a plain
   `?pear_demo=1` in the fitting-room URL, which ONLY widget/pear-widget.js
   ever adds, and ONLY when its own <script> tag carries
   data-pear-demo="true" (set on the marketing site's embed alone; every other
   embed - the main app, any real merchant - gets full registration by
   default, exactly as if this feature didn't exist). Nothing below this line
   changes when DEMO_MODE is false.
   ============================================================================= */
const DEMO_MODE = new URLSearchParams(location.search).get("pear_demo") === "1";

/* =============================================================================
   ONE-TIME PUBLIC DEMO LOCK - active ONLY when DEMO_MODE is true
   -----------------------------------------------------------------------------
   This public demo permits exactly one virtual measurement per browser. The
   FIRST completed try-on (a look actually saved to the gallery - see
   lockDemoAfterFirstMeasurement, called from stopLive()/beginFreezeHold())
   sets 'pear_demo_measured' in localStorage. Every entry point that can start
   a camera stream, recompute a size, or re-enter the fitting room checks it
   first (init(), goToFitting(), startCamera(), onRetake(), replayFitLive()).
   isDemoLocked() short-circuits to false outside DEMO_MODE, so none of those
   guards can ever fire for the main app / a real merchant - an authenticated
   production user can always re-measure and update their profile.

   This iframe and the host page's "מדוד וירטואלית" trigger button
   (widget/pear-widget.js) run on DIFFERENT origins, so they each have their
   OWN localStorage - postMessage is the only channel between them. We notify
   the parent the instant the lock is set so the outer button locks too,
   without the host page needing a reload.
   ============================================================================= */
const PEAR_DEMO_LOCK_KEY = "pear_demo_measured";
let demoLocked = false;

function isDemoLocked() {
  if (!DEMO_MODE) return false;   // main app / real merchant embeds: never locked
  try { return localStorage.getItem(PEAR_DEMO_LOCK_KEY) === "true"; } catch { return demoLocked; }
}

function notifyParentDemoLocked() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: "pear-fitting-room", type: "pear-demo-measured" }, "*");
    }
  } catch {}
}

/* Full-screen takeover - replaces Screen 1/2 entirely. Used both on load for a
   returning (already-locked) visitor and by every "tried to restart" guard. */
function showDemoLockedScreen() {
  $("screen-calculator")?.classList.remove("active");
  $("screen-fitting")?.classList.remove("active");
  $("screen-locked")?.classList.add("active");
  syncEditorialVideo();
}

/* Called once, right after the FIRST look is successfully saved to the
   gallery. Persists the lock and flips in-memory state so every guard below
   takes effect immediately - but does NOT navigate away from the result the
   user is currently looking at; that would yank away the try-on they just
   finished. The lock only blocks the NEXT attempt (reload, retake, edit
   measurements, …). */
function lockDemoAfterFirstMeasurement() {
  if (!DEMO_MODE || demoLocked) return;
  demoLocked = true;
  try { localStorage.setItem(PEAR_DEMO_LOCK_KEY, "true"); } catch {}
  notifyParentDemoLocked();
}

/* =============================================================================
   RETURNING-USER PROFILE + MONTHLY MEASUREMENTS REFRESH
   -----------------------------------------------------------------------------
   height/weight now live on the `users` row itself (supabase_setup_v7.sql) -
   GET/PATCH /api/users/:deviceId are the single source of truth, no local
   height/weight cache. `pear_last_measurements_date` is a lightweight LOCAL
   clock for "did THIS browser confirm/refresh measurements in the last 30
   days" - a fresh device that logs into a known profile still needs to answer
   that question once before skipping Screen 1 on every later visit.

   Bounds mirror calculateSize()'s "mandatoryReady" gate exactly (height
   110–240 cm, weight 18–220 kg, age 1–120) - also enforced server-side in
   updateUserMeasurements() - so no out-of-range value survives the round-trip.
   ============================================================================= */
const PEAR_LAST_MEASUREMENTS_KEY = "pear_last_measurements_date";
const MEASUREMENTS_REFRESH_MS    = 30 * 24 * 60 * 60 * 1000;   // 30 days
const PROFILE_HEIGHT_MIN = 110, PROFILE_HEIGHT_MAX = 240;
const PROFILE_WEIGHT_MIN = 18,  PROFILE_WEIGHT_MAX = 220;
/* Height and weight are the whole profile now - age is gone entirely (see the
   "AGE - REMOVED" note above). It only ever gated completeness here; it never
   contributed to the recommendation, so dropping it makes a stored profile from any
   era complete on the same terms. */
function isSaneProfile(height, weight) {
  return Number.isFinite(height) && Number.isFinite(weight) &&
    height >= PROFILE_HEIGHT_MIN && height <= PROFILE_HEIGHT_MAX &&
    weight >= PROFILE_WEIGHT_MIN && weight <= PROFILE_WEIGHT_MAX;
}

function isMeasurementsRefreshDue() {
  try {
    const raw = localStorage.getItem(PEAR_LAST_MEASUREMENTS_KEY);
    if (!raw) return true;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return true;
    return (Date.now() - ts) >= MEASUREMENTS_REFRESH_MS;
  } catch { return true; }
}

function stampMeasurementsDate() {
  try { localStorage.setItem(PEAR_LAST_MEASUREMENTS_KEY, new Date().toISOString()); } catch {}
}

/* =============================================================================
   MONTHLY RE-AUTHENTICATION
   -----------------------------------------------------------------------------
   Separate clock from PEAR_LAST_MEASUREMENTS_KEY above: that one governs "does
   this browser need to re-confirm height/weight", this one governs "does this
   browser need to re-prove it owns the email on this device" (identity gate +
   OTP), independent of whether the measurements happen to still be fresh. A
   known device with a stale auth date is re-gated (see setupIdentityGate)
   even if its measurements are otherwise within their 30-day window.
   ============================================================================= */
const PEAR_LAST_AUTH_KEY = "pear_last_auth_date";
const AUTH_REFRESH_MS    = 30 * 24 * 60 * 60 * 1000;   // 30 days

function isAuthRefreshDue() {
  try {
    const raw = localStorage.getItem(PEAR_LAST_AUTH_KEY);
    if (!raw) return true;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return true;
    return (Date.now() - ts) >= AUTH_REFRESH_MS;
  } catch { return true; }
}

function stampAuthDate() {
  try { localStorage.setItem(PEAR_LAST_AUTH_KEY, new Date().toISOString()); } catch {}
}

/* In-memory returning-user profile - populated by routeUser() from a GET
   /api/users/:deviceId lookup or a POST /api/users registration/auto-login.
   Powers the profile button/dropdown (Feature 3) and the measurements PATCH. */
let PEAR_USER = null;   // { id, name, email, height, weight } | null

/* Pending first-time registration awaiting OTP verification (see
   submitIdentity/verifyOtp below). Null whenever #screen-otp isn't showing. */
let PEAR_OTP_PENDING = null;   // { deviceId, name, email } | null

/* Set by showIdentityGate() when a KNOWN device's 30-day auth window lapsed
   (monthly re-auth - Case 2). Holds the server profile so submitIdentity()/
   verifyOtp() know to re-authenticate this existing user (stamp + routeUser)
   instead of registering a new one. Null for every other identity-gate path. */
let PEAR_REAUTH_USER = null;   // { id, name, email, height, weight } | null
let otpCountdownTimer = null;
const OTP_COUNTDOWN_SECONDS = 60;

function hideAllScreen1Forms() {
  const idForm = $("identityForm"), sizeForm = $("sizeForm");
  if (idForm)   { idForm.hidden = true;   idForm.style.display = "none"; }
  if (sizeForm) { sizeForm.hidden = true; sizeForm.style.display = "none"; }
}

/* Reveal Screen 1's measurement form - prefilled from PEAR_USER when a profile
   exists, with the "עבר חודש" nudge banner when opts.refreshNotice is set
   (a known profile whose 30-day window lapsed; never shown to a brand-new
   visitor who has no profile yet). Recomputes so a prefilled visitor sees
   their size immediately. */
/* Lift the pre-paint force-hide (see the inline script + html.pear-returning-
 * check rule in style.css) the instant we're about to reveal #screen-calculator
 * for real - whether that's the identity gate (unknown/404 device) or the
 * measurement form (no/stale profile). The fast path (known device, fresh
 * profile) never calls this: it goes straight to goToFitting() and
 * #screen-calculator is simply never shown. */
function clearReturningCheckGate() {
  document.documentElement.classList.remove("pear-returning-check");
}

function showSizeForm(opts) {
  clearReturningCheckGate();
  const idForm = $("identityForm");
  const sizeForm = $("sizeForm");
  const notice = $("measurementsRefreshNotice");
  // Use inline display too: #sizeForm has `display:grid` in CSS which outranks the
  // [hidden] attribute, so toggling `.hidden` alone can't hide/show it reliably.
  if (idForm)   { idForm.hidden = true;    idForm.style.display = "none"; }
  if (sizeForm) { sizeForm.hidden = false; sizeForm.style.display = "";   }
  if (notice) notice.hidden = !(opts && opts.refreshNotice);
  if (PEAR_USER) {
    const setIf = (id, v) => { const el = $(id); if (el && v != null && v !== "" && !el.value) el.value = String(v); };
    setIf("height", PEAR_USER.height); setIf("weight", PEAR_USER.weight);
  }
  try { calculateSize(); } catch {}
}

/* THE single decision point for what a visitor sees once we know who they are
   (a known device on page load - setupIdentityGate - or a fresh
   registration/auto-login - submitIdentity). user is the raw `user` object
   from the /api/users response, or null/undefined on infra failure.

     No profile at all       → Screen 1's measurement form, plain (first-time
                                visitor, or a known profile that never finished
                                sizing).
     Profile, refresh due    → Screen 1's measurement form, WITH the "עבר חודש"
                                nudge banner, prefilled - the visitor cannot
                                reach the camera without confirming/updating.
     Profile, refresh NOT due → Screen 1 is never shown; prefill straight into
                                calculateSize() and transition into the camera. */
function routeUser(user) {
  // `age` is deliberately NOT carried onto PEAR_USER any more, even when the server
  // still returns a stored one - that value is what the profile popover was painting
  // as "גיל: 5" for a visitor who was never asked. See the "AGE - REMOVED" note.
  PEAR_USER    = user ? { id: user.id, name: user.name, email: user.email, height: user.height, weight: user.weight } : null;
  PEAR_USER_ID = (user && user.id) || null;
  updateProfileButton();

  const hasProfile = user && isSaneProfile(Number(user.height), Number(user.weight));

  if (hasProfile && !isMeasurementsRefreshDue()) {
    hideAllScreen1Forms();
    const setIf = (id, v) => { const el = $(id); if (el && v != null && v !== "") el.value = String(v); };
    setIf("height", user.height); setIf("weight", user.weight);
    try { calculateSize(); } catch {}
    // A stored height/weight that was valid when saved can still land in the
    // "fits neither chart" gap calculateSize() now recognizes (it no longer
    // forces a closest-match guess). Don't silently instant-skip into the
    // fitting room with no resolved size - fall through to Screen 1 below,
    // exactly the same blocking "no matching size" state a fresh visitor would
    // hit, instead of bypassing it entirely via this fast path.
    if (currentUserSize) {
      // instant:true - this visitor never saw Screen 1 (pre-paint gate kept
      // #screen-calculator hidden the whole time), so skip the branded transition
      // and land directly on the camera with zero visible animation/delay.
      goToFitting({ instant: true });
      return;
    }
  }

  showSizeForm({ refreshNotice: !!hasProfile });
}

/* Send the current form's height/weight to the server (PATCH) and stamp today as the
 * last-measurements date. No-op (resolves immediately) when there's no logged-in
 * device profile to attach it to (e.g. demo mode, or infra-failure fallback where the
 * session was never linked to a server profile).
 * `age` is no longer collected or sent - see the "AGE - REMOVED" note. */
async function persistMeasurementsIfLoggedIn(height, weight) {
  if (!PEAR_USER_ID) return;
  try {
    await fetch(`/api/users/${encodeURIComponent(getDeviceId())}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ height, weight }),
    });
    stampMeasurementsDate();
    if (PEAR_USER) {
      PEAR_USER.height = Number(height);
      PEAR_USER.weight = Number(weight);
    }
    updateProfileButton();
  } catch (err) {
    console.error("[PEAR] measurements PATCH failed:", err?.message);
  }
}

/* Screen 1's "Continue →" action (button click AND Enter-to-submit - see
   onMeasurementKeydown). Persists the just-entered measurements server-side
   for a logged-in returning/new user before transitioning into the room. */
async function onSizeFormContinue() {
  await persistMeasurementsIfLoggedIn($("height")?.value, $("weight")?.value);
  goToFitting();
}

/* =============================================================================
   PROFILE BUTTON (Feature 3) - top-right corner, always visible in the fitting
   room once a user is known. Click reveals name/email/height/weight + logout.
   Hidden entirely while PEAR_USER is null (nothing to show pre-login).
   ============================================================================= */
/* First letter of first name + first letter of last name; a single-word name
   uses its own first two letters instead ("איתי ארזי" → "אא", "איתי" → "אי"). */
function getInitials(name) {
  const parts = (name || "").trim().split(/\s+/);
  if (!parts[0]) return "?";
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function updateProfileButton() {
  const btn = $("profileBtn");
  if (!btn) return;
  if (!PEAR_USER) { btn.hidden = true; closeProfileDropdown(); return; }
  btn.hidden = false;

  const initials = getInitials(PEAR_USER.name);
  const initial = $("profileInitial");
  if (initial) initial.textContent = initials;
  const avatar = $("profileAvatar");
  if (avatar) avatar.textContent = initials;

  const nameEl = $("profileName"), emailEl = $("profileEmail");
  if (nameEl) nameEl.textContent = PEAR_USER.name || "-";
  if (emailEl) emailEl.textContent = PEAR_USER.email || "-";

  // (no age row - the field is gone; see the "AGE - REMOVED" note)
  const heightEl = $("profileHeight"), weightEl = $("profileWeight");
  if (heightEl) heightEl.textContent = PEAR_USER.height != null ? `${PEAR_USER.height} ס"מ` : "-";
  if (weightEl) weightEl.textContent = PEAR_USER.weight != null ? `${PEAR_USER.weight} ק"ג` : "-";

  const sizeEl = $("profileSize");
  if (sizeEl) {
    const sizeText = $("final-size-text");
    // sizeText already carries the "(Kids)" suffix when applicable - #final-size-text
    // is set via formatSizeLabel() in goToFitting(). The fallback needs its own call
    // since currentUserSize itself is always the raw, unformatted chart code.
    sizeEl.textContent = (sizeText && sizeText.innerText.trim()) || formatSizeLabel(currentUserSize) || "-";
  }
}

function openProfileDropdown()  { updateProfileButton(); const p = $("profileDropdown"); if (p) p.hidden = false; }
function closeProfileDropdown() { const p = $("profileDropdown"); if (p) p.hidden = true; }
function toggleProfileDropdown() {
  const p = $("profileDropdown");
  if (!p) return;
  p.hidden ? openProfileDropdown() : closeProfileDropdown();
}

/* "התנתקות" - clear everything that identifies this browser (device id, the
 * measurements-refresh clock, and the legacy pre-refactor body-profile cache
 * key some browsers may still carry) and reload, landing fresh on the gate. */
function logoutUser() {
  try {
    localStorage.removeItem(PEAR_DEVICE_KEY);
    localStorage.removeItem(PEAR_LAST_MEASUREMENTS_KEY);
    localStorage.removeItem(PEAR_LAST_AUTH_KEY);
    localStorage.removeItem("pear_body_profile");   // legacy cache key, harmless if absent
    localStorage.removeItem("pear_fit_gallery");
    localStorage.removeItem("pear_cart_count");
    localStorage.removeItem("pear_custom_garment");
  } catch {}
  location.reload();
}

function setupProfileButton() {
  const btn = $("profileBtn");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggleProfileDropdown(); });
  }
  const logoutBtn = $("profileLogoutBtn");
  if (logoutBtn && !logoutBtn.dataset.wired) {
    logoutBtn.dataset.wired = "1";
    logoutBtn.addEventListener("click", logoutUser);
  }
  // Outside click closes the dropdown (idempotent - one document-level listener).
  if (!setupProfileButton._wired) {
    setupProfileButton._wired = true;
    document.addEventListener("click", (e) => {
      const panel = $("profileDropdown"), btnEl = $("profileBtn");
      if (!panel || panel.hidden) return;
      if (panel.contains(e.target) || (btnEl && btnEl.contains(e.target))) return;
      closeProfileDropdown();
    });
  }
  updateProfileButton();
}

/* ── Fullscreen / Expand toggle (#fullscreenToggleBtn, was "Back to Store") ──
   Gives the shopper an immersive, unconstrained view of the fitting room
   instead of a link that navigated them away mid-session. Feature-detects the
   Fullscreen API (Safari still needs the -webkit- prefix on every part of it)
   and hides the button entirely - the "Alternative Mode: Clean Hide" - on any
   browser/embed that can't support it, rather than leaving a dead control
   sitting in the header. A request can also be rejected at click-time (most
   commonly: this page is inside a THIRD-PARTY host's iframe whose <iframe>
   tag never granted the "fullscreen" Permissions-Policy value) - that's
   caught and hides the button too, for the same reason. */
function fullscreenSupported() {
  const el = document.documentElement;
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) &&
         !!(el.requestFullscreen || el.webkitRequestFullscreen);
}
function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function requestFullscreenCompat() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  return req ? req.call(el) : Promise.reject(new Error("Fullscreen API unavailable"));
}
function exitFullscreenCompat() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  return exit ? exit.call(document) : Promise.reject(new Error("Fullscreen API unavailable"));
}

/* #fullscreenToggleBtn's track geometry (style.css .fs-switch__seg / __thumb -
   keep these two in sync with that file if the pill is ever resized). Fixed,
   not measured at runtime: the switch is a constant icon-only size at every
   breakpoint, so there's no responsive case where the CSS and this constant
   could legitimately disagree, and skipping getBoundingClientRect() on every
   pointermove avoids a layout read on the drag's hot path. */
const FS_SWITCH_SEG_W = 34;   // fallback only - .fs-switch__thumb is authoritative

/* The premise above ("a constant icon-only size at every breakpoint") no longer
   holds: style.css scales this switch down at ≤600px so the phone header row
   can seat five controls without overlap, so a hardcoded 34 would snap the
   thumb ~6px past the segment it is aiming at. The thumb's CSS width is
   authored to equal exactly one segment (both are var(--fs-seg-w)), so reading
   it gives the live value. Read once per gesture - the drag handlers already
   call getBoundingClientRect() on the track every pointermove, so this adds no
   layout read to the hot path that was not already there. */
function fsSegW(btn) {
  const thumb = btn.querySelector(".fs-switch__thumb");
  return thumb?.offsetWidth || FS_SWITCH_SEG_W;
}

function setupFullscreenToggle() {
  const btn = $("fullscreenToggleBtn");
  if (!btn || btn.dataset.wired) return;

  if (!fullscreenSupported()) {
    btn.hidden = true;   // Alternative Mode - no dead control left in the header
    return;
  }
  btn.dataset.wired = "1";

  const segNormal = btn.querySelector(".fs-switch__seg--normal");
  const segFull   = btn.querySelector(".fs-switch__seg--full");

  const setThumbX = (px) => btn.style.setProperty("--thumb-x", px + "px");

  // Reflects the CONFIRMED fullscreen state (not a live drag position) onto
  // the thumb/segments/aria - called on init and on every real fullscreenchange,
  // never mid-drag (the drag handlers move the thumb directly for 1:1 tracking,
  // see pointermove below).
  function syncState() {
    const active = isFullscreenActive();
    btn.setAttribute("aria-checked", String(active));
    btn.setAttribute("aria-label", t(active ? "fullscreenExitAria" : "fullscreenToggleAria"));
    if (segNormal) segNormal.classList.toggle("is-active", !active);
    if (segFull)   segFull.classList.toggle("is-active", active);
    setThumbX(active ? fsSegW(btn) : 0);
  }

  // A rejected request (most commonly: an embedding host iframe whose <iframe>
  // tag never granted the "fullscreen" Permissions-Policy value) hides the
  // control entirely rather than leaving a control stuck out of sync with
  // reality - the "Alternative Mode: Clean Hide".
  function requestMode(wantFull) {
    const action = wantFull ? requestFullscreenCompat() : exitFullscreenCompat();
    action.catch((err) => {
      console.warn("[PEAR] fullscreen toggle failed - hiding the control:", err?.message || err);
      btn.hidden = true;
    });
  }

  // ── Press-and-drag physics ────────────────────────────────────────────────
  // One pointer-event trio handles BOTH a plain tap on either half AND a real
  // drag: every gesture - 0px of movement or 40px of it - ends in pointerup,
  // which reads the thumb's live position and snaps to whichever half it's
  // closer to. There is no separate "click" handler and no risk of the two
  // paths double-firing.
  let dragging = false;
  let pointerId = null;
  let segW = fsSegW(btn);   // refreshed at each pointerdown (breakpoint may have changed)

  btn.addEventListener("pointerdown", (e) => {
    dragging = true;
    pointerId = e.pointerId;
    btn.setPointerCapture(pointerId);
    btn.classList.add("is-dragging");   // suspends the CSS spring so the thumb tracks 1:1, no lag
    segW = fsSegW(btn);   // one read per gesture; the switch cannot resize mid-drag
    const r = btn.getBoundingClientRect();
    const x = Math.max(0, Math.min(segW, e.clientX - r.left - segW / 2));
    setThumbX(x);
    e.preventDefault();   // no text-selection/scroll gesture fighting the drag
  });

  btn.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = btn.getBoundingClientRect();
    const x = Math.max(0, Math.min(segW, e.clientX - r.left - segW / 2));
    setThumbX(x);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { btn.releasePointerCapture(pointerId); } catch { /* already released - browsers auto-release on pointerup anyway */ }
    btn.classList.remove("is-dragging");   // re-arms the spring for the snap below
    const r = btn.getBoundingClientRect();
    const wantFull = (e.clientX - r.left) > r.width / 2;
    if (wantFull !== isFullscreenActive()) requestMode(wantFull);
    else setThumbX(wantFull ? segW : 0);   // released back where it started - just re-settle
  }
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (e.key === "ArrowLeft")       requestMode(false);
    else if (e.key === "ArrowRight") requestMode(true);
    else                             requestMode(!isFullscreenActive());   // Space/Enter - simple toggle
  });

  document.addEventListener("fullscreenchange", syncState);
  document.addEventListener("webkitfullscreenchange", syncState);
  // This switch is NO LONGER a fixed size at every breakpoint (style.css scales
  // it down at ≤600px, and again at ≤389px, so the phone header row fits), so
  // the thumb's snapped position - written in pixels - has to be re-derived
  // whenever the viewport crosses one of those widths. Without this, dragging a
  // desktop window narrow while fullscreen is active leaves the thumb parked at
  // the old, wider offset, hanging off the end of its own track.
  // Skipped mid-drag: the pointer owns the thumb until it is released.
  let resettleQueued = false;
  addEventListener("resize", () => {
    if (dragging || resettleQueued) return;
    resettleQueued = true;
    requestAnimationFrame(() => { resettleQueued = false; syncState(); });
  }, { passive: true });
  syncState();
}

/* ── Full Bi-directional Cart Sync (#cartBtn / #cartDropdown) ────────────────
   Embedded (inIframe()), PEAR's own cart is a MIRROR of the HOST store's real
   cart (Shopify's /cart.js etc. - see pear-widget.js's Host Cart Integration),
   never an independent source of truth:
     - PEAR_CART_REQUEST_SYNC (posted below, on init() and every dropdown open)
       asks the host for a fresh snapshot.
     - PEAR_CART_SYNC (listened for below) is the host's reply - also pushed
       proactively after every add/remove and on live host-side cart changes
       detected while the widget's modal is open (pear-widget.js).
     - PEAR_REMOVE_FROM_CART (posted from removeCartLine) mirrors an in-PEAR
       deletion onto the host cart; the removal here is OPTIMISTIC (applied to
       local state immediately) and corrected by whatever sync arrives next,
       so the two carts can never drift apart even if the host removal fails.
   hostCart stays null (never fabricated as "empty") until the first REAL sync
   arrives - and in standalone/demo mode (no host to sync with) it never
   arrives at all, so this whole module stays a dormant no-op there and
   #cartCount keeps being driven by lux-interactions.js's local
   pear_cart_count counter exactly as before. */
let hostCart = null;

function inIframe() {
  try { return window.self !== window.top; } catch { return true; }
}

function requestCartSync() {
  if (!inIframe()) return;
  window.parent.postMessage({ type: "PEAR_CART_REQUEST_SYNC" }, "*");
}

function renderCartBadge(count) {
  const el = $("cartCount");
  if (!el) return;
  el.textContent = String(count);
  el.classList.toggle("is-empty", count === 0);
}

function renderCartDropdown() {
  const list = $("cartList"), empty = $("cartEmpty"), headCount = $("cartHeadCount");
  if (!list || !empty) return;
  const items = (hostCart && hostCart.items) || [];
  const count = (hostCart && hostCart.itemCount) || 0;

  if (headCount) headCount.textContent = count ? String(count) : "";

  /* countOnly: the host's cart COUNT is known (read off its own cart badge)
     but its line items are not - the store exposes no readable cart API and
     wired no PEAR_CART_CONFIG.getCart() hook. Showing "your cart is empty"
     there would be an outright lie while the store badge reads 2, so say
     exactly what is true instead: N items, listed on the store itself. */
  const countOnly = !!(hostCart && hostCart.countOnly) && count > 0;
  empty.hidden = items.length > 0 || countOnly;
  empty.textContent = t("cartDropdownEmpty");

  if (countOnly) {
    list.innerHTML = "";
    const note = document.createElement("p");
    note.className = "cart-dropdown__empty";   // same quiet centred treatment, different message
    note.textContent = t("cartDropdownCountOnly").replace("{n}", String(count));
    list.appendChild(note);
    return;
  }
  list.innerHTML = "";   // rebuilt from scratch below via DOM APIs (not innerHTML+interpolation) - the
                          // host cart's title/variant text is the MERCHANT's own data, but still untrusted
                          // input crossing an origin boundary, so it's never concatenated into markup.
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "cart-line";
    row.dataset.key = it.key || "";
    row.dataset.variantId = it.variantId || "";

    const media = document.createElement("div");
    media.className = "cart-line__media";
    if (it.image) {
      const img = document.createElement("img");
      img.src = it.image; img.alt = ""; img.loading = "lazy";
      media.appendChild(img);
    }

    const meta = document.createElement("div");
    meta.className = "cart-line__meta";
    const title = document.createElement("span");
    title.className = "cart-line__title";
    title.textContent = it.title || "";
    const variant = document.createElement("span");
    variant.className = "cart-line__variant";
    variant.textContent = [it.variantTitle, it.quantity > 1 ? `× ${it.quantity}` : ""].filter(Boolean).join(" · ");
    meta.append(title, variant);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cart-line__remove";
    removeBtn.setAttribute("aria-label", t("cartRemoveItemAria"));
    removeBtn.title = t("cartRemoveItemAria");
    removeBtn.textContent = "✕";

    row.append(media, meta, removeBtn);
    list.appendChild(row);
  });
}

function applyCartSync(cart) {
  hostCart = (cart && typeof cart === "object") ? cart : { items: [], itemCount: 0 };
  renderCartBadge(hostCart.itemCount || 0);
  renderCartDropdown();
}

function removeCartLine(key, variantId) {
  window.parent.postMessage({ type: "PEAR_REMOVE_FROM_CART", payload: { key, variantId } }, "*");
  if (!hostCart) return;   // nothing local to optimistically update - the next real sync is authoritative anyway
  hostCart = {
    ...hostCart,
    items: hostCart.items.filter((it) => (key ? it.key !== key : it.variantId !== variantId)),
  };
  hostCart.itemCount = hostCart.items.reduce((n, it) => n + (it.quantity || 1), 0);
  renderCartBadge(hostCart.itemCount);
  renderCartDropdown();
}

function setupCartButton() {
  const btn = $("cartBtn"), dd = $("cartDropdown"), list = $("cartList");
  if (!btn || !dd || btn.dataset.wired) return;
  btn.dataset.wired = "1";

  // .has-cart-open raises the header's own stacking context for exactly as long
  // as the popover is open - without it the popover is trapped under the header's
  // sticky z-index on phones and paints BELOW the fixed lang-switch/profile/help
  // chrome. See the .app-header.has-cart-open rule in style.css.
  const header = document.querySelector(".app-header");
  const openDropdown  = () => { dd.hidden = false; header?.classList.add("has-cart-open"); };
  const closeDropdown = () => { dd.hidden = true;  header?.classList.remove("has-cart-open"); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dd.hidden) {
      requestCartSync();   // refresh-on-open - catches anything a missed live-sync tick didn't
      openDropdown();
    } else {
      closeDropdown();
    }
  });
  document.addEventListener("click", (e) => {
    if (dd.hidden) return;
    if (dd.contains(e.target) || btn.contains(e.target)) return;
    closeDropdown();
  });
  list?.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".cart-line__remove");
    if (!removeBtn) return;
    const row = removeBtn.closest(".cart-line");
    if (!row) return;
    row.classList.add("is-removing");   // optimistic - removeCartLine() below corrects state either way
    removeCartLine(row.dataset.key || null, row.dataset.variantId || null);
  });
}

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  if (!e.data || e.data.type !== "PEAR_CART_SYNC") return;
  applyCartSync(e.data.cart);
});

/* Show the name/email gate and wire its controls (idempotent - safe to call
   more than once). Hides the measurement form until the visitor registers.
   opts.reauth + opts.user (Case 2 - known device, stale auth date): prefills
   name/email from the server profile and arms PEAR_REAUTH_USER so
   submitIdentity()/verifyOtp() re-authenticate this same user instead of
   registering a new one. */
function showIdentityGate(opts) {
  clearReturningCheckGate();
  const idForm   = $("identityForm");
  const sizeForm = $("sizeForm");
  // Inline display overrides #sizeForm's CSS `display:grid` (see showSizeForm).
  if (idForm)   { idForm.hidden = false;  idForm.style.display = "";     }
  if (sizeForm) { sizeForm.hidden = true; sizeForm.style.display = "none"; }

  PEAR_REAUTH_USER = (opts && opts.reauth && opts.user) ? opts.user : null;
  if (PEAR_REAUTH_USER) {
    const nameEl  = $("userName"), emailEl = $("userEmail");
    if (nameEl)  nameEl.value  = PEAR_REAUTH_USER.name  || "";
    if (emailEl) emailEl.value = PEAR_REAUTH_USER.email || "";
  }

  const btn   = $("btn-identity-continue");
  const errEl = $("identityError");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => submitIdentity());
  }
  // Enter inside the identity fields submits the gate.
  ["userName", "userEmail"].forEach((id) => {
    const el = $(id);
    if (el && !el.dataset.wired) {
      el.dataset.wired = "1";
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submitIdentity(); }
      });
    }
  });
  if (errEl) errEl.hidden = true;
}

/* Step 0 for EVERY visit. NOTE: this re-adds a device-id auto-skip that an
   earlier version deliberately removed (see git history / server.js comments
   on findUserByDeviceId) - a shared/QA browser typing a DIFFERENT name+email
   into the gate after another visitor already registered on it will silently
   land in the fitting room under the wrong identity instead of being asked to
   confirm. Accepted as a known tradeoff per explicit product decision; if that
   changes, drop the lookup below and always call showIdentityGate(). */
async function setupIdentityGate() {
  const deviceId = getDeviceId();
  console.log("[PEAR] device_id found:", deviceId || "(none)");

  if (!deviceId) {
    showIdentityGate();
    return;
  }

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(deviceId)}`);
    console.log("[PEAR] user lookup result:", res.status);

    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      if (data && data.ok && data.user) {
        // Case 2 - known device whose 30-day auth window lapsed (or never
        // stamped, e.g. a device that registered before this feature shipped):
        // re-gate with OTP before trusting this device again, rather than
        // routing straight in. Case 1 (auth still fresh) falls through to the
        // existing auto-login routing unchanged.
        if (isAuthRefreshDue()) {
          console.log("[PEAR] known device, auth refresh due → re-auth gate:", data.user.name);
          showIdentityGate({ reauth: true, user: data.user });
          return;
        }
        console.log("[PEAR] known device → auto-login user:", data.user.name, "→", data.user.id);
        routeUser(data.user);   // Feature 1/2 routing - camera, refresh form, or gate never shown
        return;
      }
      console.log("[PEAR] lookup returned 200 but no usable user payload → showing gate");
    } else {
      console.log("[PEAR] no known user for this device (404 or error) → showing gate");
    }
  } catch (err) {
    console.log("[PEAR] user lookup failed:", err?.message, "→ showing gate");
  }

  showIdentityGate();
}

/* =============================================================================
   EMAIL OTP VERIFICATION - inserted between the identity gate and the
   measurement form for first-time visitors only (submitIdentity below only
   ever runs when setupIdentityGate() decided this device has no usable
   profile, so there's no separate "first-time" branch to gate here).
   ============================================================================= */
function stopOtpCountdown() {
  if (otpCountdownTimer) { clearInterval(otpCountdownTimer); otpCountdownTimer = null; }
}

function startOtpCountdown() {
  stopOtpCountdown();
  let remaining = OTP_COUNTDOWN_SECONDS;
  const el = $("otp-countdown");
  const render = () => { if (el) el.textContent = remaining > 0 ? `${remaining} ${t("otpSecondsRemaining")}` : t("otpExpired"); };
  render();
  otpCountdownTimer = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) stopOtpCountdown();
  }, 1000);
}

function showOtpScreen(email) {
  const idForm  = $("identityForm");
  const otpForm = $("screen-otp");
  if (idForm)  { idForm.hidden = true; idForm.style.display = "none"; }
  if (otpForm) { otpForm.hidden = false; otpForm.style.display = ""; }
  // The shared Screen-1 heading/subtitle (also used by the identity gate and
  // measurement form) don't belong on the OTP step - hide them for its duration.
  const heading = $("calcHeading"), subtitle = $("calcSubtitle");
  if (heading)  heading.hidden = true;
  if (subtitle) subtitle.hidden = true;
  const hint = $("otp-email-hint");
  if (hint) hint.textContent = `${t("otpSentTo")} ${email}`;
  const input = $("otpInput");
  if (input) { input.value = ""; input.focus(); }
  const errEl = $("otp-error");
  if (errEl) errEl.hidden = true;
  startOtpCountdown();
}

function hideOtpScreen() {
  stopOtpCountdown();
  const otpForm = $("screen-otp");
  if (otpForm) { otpForm.hidden = true; otpForm.style.display = "none"; }
  const heading = $("calcHeading"), subtitle = $("calcSubtitle");
  if (heading)  heading.hidden = false;
  if (subtitle) subtitle.hidden = false;
  PEAR_OTP_PENDING = null;
  PEAR_REAUTH_USER = null;
}

/* Case 3 - new device, email already registered to a DIFFERENT device (POST
   /api/users just returned 409/email_taken). The OTP for this exact email has
   already been verified (see verifyOtp → finishRegistration), so this device
   has proven ownership of the address - relink it to the existing account
   rather than dead-ending on "email taken". */
async function relinkExistingDevice(deviceId, email) {
  const errEl = $("otp-error");
  toast(t("otpAlreadyRegistered"));
  try {
    const res = await fetch("/api/users/relink", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, deviceId }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data && data.id) {
      setDeviceId(deviceId);
      stampAuthDate();
      console.log("[identity] relinked device to existing user:", data.name, "→", data.id);
      hideOtpScreen();
      routeUser(data);
      return;
    }

    console.warn("[identity] relink failed (status", res.status, ")");
    if (errEl) { errEl.textContent = t("errDeviceLinkFailed"); errEl.hidden = false; }
  } catch (err) {
    console.warn("[identity] relink request failed:", err?.message || err);
    if (errEl) { errEl.textContent = t("errNetworkRetry"); errEl.hidden = false; }
  }
}

/* Shared with submitIdentity's own INFRA-failure degrade path: create the
   user (or accept an already-known one), remember the device, and route. */
async function finishRegistration(deviceId, name, email) {
  try {
    const res = await fetch("/api/users", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ deviceId, name, email }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.ok) {
      setDeviceId(deviceId);
      stampAuthDate();
      console.log(
        "[identity] " + (data.matched === "email" ? "auto-login (name+email)" : "registered") +
        " user:", data.user?.name, "→", data.user?.id
      );
      hideOtpScreen();
      routeUser(data.user);
      return;
    }

    if (res.status === 409 && data?.error === "email_taken") {
      await relinkExistingDevice(deviceId, email);
      return;
    }

    if (res.status === 409 || res.status === 400 || res.status === 422) {
      const errEl = $("otp-error");
      const msg = (data && (data.message || data.error)) || t("errGenericRetry");
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      return;
    }

    console.warn("[identity] save unavailable (status", res.status, ") - proceeding without server profile");
    setDeviceId(deviceId);
    hideOtpScreen();
    showSizeForm();
  } catch (err) {
    console.warn("[identity] save failed, proceeding offline:", err?.message || err);
    setDeviceId(deviceId);
    hideOtpScreen();
    showSizeForm();
  }
}

/* Case 2 - known device, OTP re-auth just verified: no server write needed,
   the device_id already points at this user. Stamp today's auth date and
   route exactly like a fresh auto-login (camera, or the measurements-refresh
   form if that clock separately lapsed). */
async function finishReauth() {
  const user = PEAR_REAUTH_USER;
  PEAR_REAUTH_USER = null;
  stampAuthDate();
  console.log("[identity] re-auth verified:", user?.name, "→", user?.id);
  hideOtpScreen();
  routeUser(user);
}

async function verifyOtp(code) {
  const errEl = $("otp-error");
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
  if (!PEAR_OTP_PENDING) return showErr(t("otpSomethingWrong"));
  if (!/^\d{6}$/.test(code)) return showErr(t("otpEnter6Digits"));

  const btn = $("btn-verify-otp");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/verify-otp", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email: PEAR_OTP_PENDING.email, code }),
    });
    const data = await res.json().catch(() => null);

    if (data?.ok) {
      if (PEAR_REAUTH_USER) {
        await finishReauth();
        return;
      }
      const { deviceId, name, email } = PEAR_OTP_PENDING;
      await finishRegistration(deviceId, name, email);
      return;
    }

    if (data?.error === "expired") {
      showErr(t("otpExpiredResend"));
    } else {
      showErr(t("otpWrongCode"));
    }
  } catch (err) {
    console.warn("[otp] verify failed:", err?.message || err);
    showErr(t("errNetworkRetry"));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resendOtp() {
  if (!PEAR_OTP_PENDING) return;
  const { name, email } = PEAR_OTP_PENDING;
  const btn = $("btn-resend-otp");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/send-otp", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, name }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      startOtpCountdown();
      const errEl = $("otp-error");
      if (errEl) errEl.hidden = true;
      toast(t("otpResent"));
    } else {
      const errEl = $("otp-error");
      if (errEl) { errEl.textContent = (data && (data.message || data.error)) || t("otpResendFailed"); errEl.hidden = false; }
    }
  } catch (err) {
    console.warn("[otp] resend failed:", err?.message || err);
    const errEl = $("otp-error");
    if (errEl) { errEl.textContent = t("errNetworkRetry"); errEl.hidden = false; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setupOtpScreen() {
  const verifyBtn = $("btn-verify-otp");
  if (verifyBtn && !verifyBtn.dataset.wired) {
    verifyBtn.dataset.wired = "1";
    verifyBtn.addEventListener("click", () => verifyOtp(($("otpInput")?.value || "").trim()));
  }
  const resendBtn = $("btn-resend-otp");
  if (resendBtn && !resendBtn.dataset.wired) {
    resendBtn.dataset.wired = "1";
    resendBtn.addEventListener("click", resendOtp);
  }
  const input = $("otpInput");
  if (input && !input.dataset.wired) {
    input.dataset.wired = "1";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); verifyOtp((input.value || "").trim()); }
    });
  }
}

/* Validate, send the OTP, then reveal the verification screen. The user row
   itself is only created once verifyOtp() confirms the code (see
   finishRegistration above). */
async function submitIdentity() {
  const nameEl  = $("userName");
  const emailEl = $("userEmail");
  const btn     = $("btn-identity-continue");
  const errEl   = $("identityError");

  const name  = (nameEl  && nameEl.value  || "").trim();
  const email = (emailEl && emailEl.value || "").trim();

  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };

  if (name.length < 2)  return showErr(t("errNameRequired"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(t("errEmailInvalid"));
  if (errEl) errEl.hidden = true;

  // Reuse the existing device id when re-registering (404 recovery); otherwise mint one.
  const deviceId = getDeviceId() || newUuid();
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/send-otp", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, name }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.ok) {
      if (btn) btn.disabled = false;
      PEAR_OTP_PENDING = { deviceId, name, email };
      setupOtpScreen();
      showOtpScreen(email);
      return;
    }

    // Rate limited / bad input → surface it, let the visitor retry from the gate.
    if (btn) btn.disabled = false;
    return showErr((data && (data.message || data.error)) || t("otpSendFailed"));
  } catch (err) {
    // Network error / API server down - never a dead end.
    if (btn) btn.disabled = false;
    console.warn("[identity] send-otp failed:", err?.message || err);
    showErr(t("errNetworkRetry"));
  }
}

/**
 * Send the visitor's measurements + the garment + calculated size to the admin
 * store. Fired when the size calculator is submitted (see goToFitting), so we
 * capture intent even if the user never starts the camera. Optional measurements
 * are sent as null when blank.
 * @param {object|null} item - the garment (id/name read off it)
 * @param {string}      size - the CALCULATED size (S/M/L/XL…)
 */
function logSessionMeasurements(item, size) {
  const num = (id) => { const el = $(id); return el && el.value ? parseFloat(el.value) : null; };
  // All entered measurements, grouped into one object per the payload spec.
  const measurements = {
    height: num("height"),
    weight: num("weight"),
    chest:  num("chest"),
    waist:  num("waist"),
    legs:   num("legs"),
  };
  const payload = {
    sessionId:   PEAR_SESSION_ID,
    userId:      PEAR_USER_ID,        // links this session to the remembered user
    garmentId:   item?.id   || "",
    garmentName: item?.name || "",
    // "-" (not "") when unresolved - a well-within-8-chars "no match" marker
    // for the Supabase sessions.size column (see the truncation note at the
    // goToFitting() call site above); RAW, never formatSizeLabel(), for the
    // same reason.
    size:        size       || "-",   // calculated size
    measurements,                    // ← object with ALL entered measurements
    ...measurements,                 // ← flat fields kept for the Sheets schema
  };
  console.log("[session-log] firing /api/sessions →", payload);
  fetch("/api/sessions", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
    keepalive: true,
  }).catch(err => console.warn("[session-log] fetch failed:", err));
}

/* =============================================================================
   Capture flow
   ============================================================================= */
/* One button toggles the live session: Go Live ⇄ Stop. */
function onLiveToggle() {
  if (isLive()) stopLive();
  else goLive();
}

/* ── Billed window - armed by the FIRST rendered Decart frame ─────────────────
   The 5s / 10-credit clock, the on-screen countdown, and the hard disconnect are all
   armed HERE, from the first frame Decart actually renders - never at connect or set().
   That makes the billed window measure real generation, not handshake/warm-up time.
   Idempotent (billingStarted) and sessionGen-guarded, so it fires exactly once per
   session and never for one that has already been torn down. */
function startBillingWindow(gen) {
  if (billingStarted) return;            // already ticking for this session
  if (gen !== sessionGen) return;        // stale first-frame from a torn-down session
  billingStarted = true;
  billingStartedAt = Date.now();         // diagnostics clock - see sessionElapsedMs()

  // Start recording from the SAME event that starts billing (the first DRESSED frame)
  // so the encoded clip and the billed window cover exactly the same span - no gap
  // for applyActive()'s rtClient.set() round-trip to eat into the recorded duration.
  startRecording();

  // First real frame arrived → cancel the no-first-frame safety teardown.
  if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }

  // STATE TRANSITION: Loading (w/ timer) → Model Ready → Start 5s capture. Everything
  // above this line only runs once armFirstFrameBilling has VERIFIED a real, non-black
  // AI-rendered frame - so this is the exact instant the model is "fully initialized."
  // Reveal the live stage + retire the loading overlay HERE (not earlier in goLive())
  // so the user never sees a "ready" UI before there's real content behind it.
  stopScanTimer();
  $("scanOverlay").hidden = true;
  card().classList.add("show-live");
  /* THE ONLY PLACE THE FEED BECOMES VISIBLE, and it is deliberately the same statement
     that flips the state class. Everything above this line has already been verified:
     the garment apply resolved, the frame is non-black, and it stayed that way for
     MODEL_READY_STABLE_FRAMES/_MS - so this fades in over content that is settled rather
     than over content that is merely present. */
  revealAiFeed();
  startLowerBodyGuard();   // no-op unless LOWER_BODY_GUARD_ENABLED - see its own comment
  /* Late-entry recovery starts with the billed window: from here on, a shopper who
     drifts out of shot and steps back in gets the garment re-conditioned into the
     window ALREADY RUNNING - never a second billed one. See startPresenceWatcher(). */
  startPresenceWatcher();
  // Feature 2 - start recording HERE, on the exact frame that arms billing, so the
  // encoded clip always matches the billed 5s window (no black warm-up frames at the
  // front - see the BLACK-FRAME FIX note in startRecording, and the isDressedFrame
  // check above that now guarantees this frame really is dressed content).
  startRecording();

  console.log("[PEAR] First verified AI frame - billing + 5s capture started (" +
    (LIVE_DURATION_MS / 1000) + "s / " + CREDITS_PER_SESSION + " credits)");

  // Visual countdown over the full VIDEO_LENGTH_MS experience. Drift-tolerant: the hard
  // stop below - not this ticker - is the source of truth for when billing actually ends.
  const timerGen = gen;
  const totalSec = Math.round(VIDEO_LENGTH_MS / 1000);
  hideLiveCountdown();                  // clear any stale ticker before arming a fresh one
  showLiveCountdown(totalSec);
  let remaining = totalSec;
  liveCountdownInterval = setInterval(() => {
    remaining -= 1;
    tickLiveCountdown(Math.max(remaining, 0));
    if (remaining <= 0 && liveCountdownInterval) { clearInterval(liveCountdownInterval); liveCountdownInterval = null; }
  }, 1000);

  // Hard BILLING stop EXACTLY LIVE_DURATION_MS after the first frame. Time-based, so it
  // still fires even if frames stall or stop arriving early - no credit can leak past it.
  liveDurationTimer = setTimeout(() => {
    if (sessionGen !== timerGen) return;   // a manual Stop already tore this session down
    console.log("[PEAR] Billing ended - disconnecting Decart (" + LIVE_DURATION_MS + "ms ≈ " +
      CREDITS_PER_SESSION + " credits @ " + CREDITS_PER_SECOND + "/s)" +
      (VIDEO_LENGTH_MS > LIVE_DURATION_MS ? ", holding frozen frame to " + VIDEO_LENGTH_MS + "ms" : ""));
    beginFreezeHold();
  }, LIVE_DURATION_MS);
}

/* Fire the billed window ONCE - at the first frame #aiVideo presents that is VERIFIED
   to be real AI-rendered output, not just "a frame decoded". Model ready == fully
   initialized here means "the remote track is actually producing dressed content", so
   we reuse sampleVideoLuma()'s black-frame test (same thresholds as the local-camera
   credit-saving gate above) on the REMOTE feed.

   PRECISION-TIMING FIX: the remote WebRTC track can start delivering frames (and
   requestVideoFrameCallback/videoWidth can go non-zero) up to ~1s BEFORE Decart's model
   finishes warming up server-side - that gap was previously a black/blank placeholder
   frame (see the BLACK-FRAME FIX note in startRecording). The old code fired billing on
   THAT first decoded frame regardless of content, so the 5s countdown - and the
   recorder, gated on the same signal below - could start while the model hadn't
   actually produced anything yet, shaving real seconds off the useful captured window.
   Now we keep checking subsequent frames (via the same rVFC/rAF mechanism) until one
   verifiably isn't black, and ONLY that frame arms billing.

   Prefers requestVideoFrameCallback (fires precisely on frame presentation, the same
   frame the recording paint loop draws to its canvas that tick); falls back to a rAF
   poll on videoWidth/currentTime where rVFC is unavailable. sessionGen-guarded so a
   stale session's late frame can never start the new one's billing. */
/* Minimum run of CONSECUTIVE qualifying frames (both isGarmentApplied and
   isDressedFrame true, uninterrupted) required before the reveal fires - both floors
   must be satisfied. isDressedFrame() only proves a frame isn't black; it has no way to
   tell "Decart's generic/default output" apart from "the actual sent garment", so a
   frame can pass it while the server is still finishing its transition off the base
   model. A brief run of consecutive good frames is a much stronger signal that the
   output has genuinely settled than any single frame can be - and the two floors
   together stay correct across a wide range of frame rates: MS alone could be satisfied
   by one stale frame sitting for 300ms with no new decode, and FRAMES alone could be
   satisfied in a few ms on a very high frame rate stream. */
const MODEL_READY_STABLE_FRAMES = 3;     // minimum consecutive qualifying decodes
const MODEL_READY_STABLE_MS     = 300;   // ...spanning at least this many ms

function armFirstFrameBilling(video, gen) {
  if (!video || billingStarted || gen !== sessionGen) return;
  let done = false;
  let stableSinceMs = null;    // Date.now() of the first frame in the current unbroken qualifying run
  let stableFrameCount = 0;    // length of that run; reset to 0 the instant a frame fails either gate
  /* DEBUG WRAPPER: window.__pearDebugFrameTiming - verbose trace of the isGarmentApplied
     / isDressedFrame race this function gates on, to test a specific hypothesis: that
     isDressedFrame() (which only proves the frame ISN'T BLACK, never that it matches the
     garment that was actually sent) can pass on a frame that's still Decart's generic/
     default output, briefly revealing it before the real garment frames catch up. OFF by
     default - this polls on every decoded frame while waiting, which is 20-30+ ticks in
     under a second and too noisy for a normal session. A local Date.now()-based clock,
     not sessionElapsedMs() - that one is relative to billingStartedAt, which this
     function's own fire() is what sets, so it reads -1 for this entire pre-fire window. */
  const frameTimingDebug = typeof window !== "undefined" && !!window.__pearDebugFrameTiming;
  const armedAt = Date.now();
  let lastLogAt = 0;
  const isDressedFrame = () => {
    const s = sampleVideoLuma(video);
    return s.ready && s.avgLuma > CAMERA_BLACK_AVG_LUMA && s.blackFrac < CAMERA_BLACK_PIXEL_FRAC;
  };
  const fire = () => {
    if (done) return;
    done = true;
    if (gen !== sessionGen) return;      // session was torn down before the first frame
    dressedFrameReady = true;            // model-ready signal shared with the recorder (startRecording)
    if (frameTimingDebug) {
      console.log(`[PEAR][DEBUG] armFirstFrameBilling FIRED at +${Date.now() - armedAt}ms`,
        `since arming (isGarmentApplied=${isGarmentApplied}, stableFrameCount=${stableFrameCount},`,
        `stableFor=${stableSinceMs !== null ? Date.now() - stableSinceMs : "n/a"}ms)`);
      watchPostFireLuma(video, gen, armedAt);   // keep sampling briefly - see if the frame is still settling
    }
    startBillingWindow(gen);
  };
  // THREE independent gates, ALL required before firing - each closes a gap the others
  // don't cover:
  //  (1) isGarmentApplied - rtClient.set() has resolved, so this can't be a stray
  //      raw/undressed passthrough frame that arrived before the apply request even
  //      went out. NEVER bypassed: a false here always resets the stability run below
  //      and re-schedules, so the reveal cannot fire while this is false, full stop.
  //  (2) isDressedFrame() - the frame is verified non-black, so it can't be the ~1s of
  //      blank/black placeholder Decart's server can still emit for a beat AFTER the
  //      apply was acknowledged (see the BLACK-FRAME FIX note in startRecording).
  //  (3) MODEL_READY_STABLE_FRAMES/_MS - (1) and (2) passing on a SINGLE frame is not
  //      enough: isDressedFrame() cannot distinguish "the real garment" from "Decart's
  //      generic/default output, which also isn't black" - a frame can pass both (1) and
  //      (2) while the server is still finishing its transition off the base model. A
  //      short run of CONSECUTIVE frames that keep passing is what actually distinguishes
  //      "settled" from "mid-transition, coincidentally not black this tick". Any frame
  //      that fails (1) or (2) resets the run to zero - this must be an UNBROKEN streak,
  //      not merely N good frames somewhere in the window.
  // Re-checked on every subsequent decoded frame (rVFC, or the rAF poll below where
  // rVFC is unavailable) until all three hold, THEN fire - so billing, the countdown, and
  // recording (started together in startBillingWindow) all begin on the first frame
  // that is genuinely ready, never before.
  const frameReady = () => {
    if (done || gen !== sessionGen) return;
    const dressed = isDressedFrame();
    const qualifies = isGarmentApplied && dressed;
    if (!qualifies) {
      stableSinceMs = null;
      stableFrameCount = 0;
    } else {
      if (stableSinceMs === null) stableSinceMs = Date.now();
      stableFrameCount++;
    }
    if (frameTimingDebug) {
      const now = Date.now();
      if (now - lastLogAt >= 80) {   // throttled - avoid one line per decoded frame
        lastLogAt = now;
        const s = sampleVideoLuma(video);
        console.log(`[PEAR][DEBUG] frame check +${now - armedAt}ms | isGarmentApplied=${isGarmentApplied}`,
          `| luma=${s.ready ? s.avgLuma.toFixed(1) : "n/a"} blackFrac=${s.ready ? s.blackFrac.toFixed(3) : "n/a"}`,
          `| dressed=${dressed} | stableFrameCount=${stableFrameCount}`,
          `| stableFor=${stableSinceMs !== null ? now - stableSinceMs : "n/a"}ms`);
      }
    }
    const stableLongEnough = stableSinceMs !== null && (Date.now() - stableSinceMs) >= MODEL_READY_STABLE_MS;
    if (!qualifies || stableFrameCount < MODEL_READY_STABLE_FRAMES || !stableLongEnough) {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(frameReady);
      } else {
        requestAnimationFrame(frameReady);
      }
      return;
    }
    fire();
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(frameReady);
  } else {
    // Fallback: poll until a real decoded frame exists, then hand off to frameReady's
    // own isGarmentApplied + isDressedFrame checks.
    (function poll() {
      if (done || gen !== sessionGen) return;
      if (video.videoWidth > 0 && video.currentTime > 0) return frameReady();
      requestAnimationFrame(poll);
    })();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FRAME-FREEZE WATCHDOG - the stream stops, then comes back wrong
   ───────────────────────────────────────────────────────────────────────────
   THE REPORTED FAILURE: the Decart feed freezes or stutters for a beat mid-session and
   then resumes - and what resumes is not always what was playing. Inside a 5s billed
   window a 1.5s stall is a third of the session.

   WHY NOTHING ELSE CATCHES IT. This file already has three watchdogs and none of them
   covers a freeze:
     · firstFrameGuardTimer  fires only if NO first frame ever arrives, then gives up.
     · armFirstFrameBilling  stops watching the instant it fires - by design, it is a
                             one-shot reveal gate, not a health monitor.
     · onConnectionChange    only sees states the SDK chooses to report. A media stall
                             that never trips its own loss detector is invisible here,
                             and that is the common case: the transport is "connected"
                             throughout, the frames simply stop.

   FIRST, THOUGH: THIS IS THE SECOND HALF OF THE FIX, NOT THE FIRST. The primary cause of
   the reported "plays, freezes 1-2s, resumes" is that the receiver was configured with NO
   jitter buffer at all (PLAYOUT_DELAY_HINT was 0), so any transient bitrate shift had
   nothing in reserve to play and the picture held until the stream caught up. That is
   fixed where it is caused - in config.js and the track handler at the top of this file -
   and it is what should make freezes rare. What follows catches the ones that still
   happen, and more importantly catches what a freeze can leave BEHIND.

   WHAT A FREEZE ACTUALLY COSTS, and why a recovery is more than a nudge. Three distinct
   things can be wrong when frames stop:
     1. THE ELEMENT stalled - a paused/suspended <video>, a backgrounded tab, a decoder
        hiccup. play() fixes it and nothing else needs to happen.
     2. THE SESSION went quiet - the transport is up but nothing is flowing. A small
        control message re-asserts it end-to-end without touching the image.
     3. THE CONDITIONING was lost - the transport was rebuilt under us (an SDK reconnect
        this file was not told about, an ICE restart), so Decart is generating from
        whatever getInitialState() replayed rather than from the garment actually
        selected. The picture comes back, dressed in the wrong thing, and every existing
        signal in this file still reports success.
   So recovery is staged cheapest-first: element ping, then an SDK keep-alive that sends
   no image, then - only if the freeze outlives both - forcing the CURRENT garment
   reference back onto the wire (see invalidateWireState). Ordering by cost is what lets
   the threshold sit at 800ms: the first two stages are safe to fire during a stall that
   may well resolve on its own, because neither adds meaningful traffic to a transport
   that is already struggling. Stage 3 is the one that matters and the one that must be
   rate-limited - a resumed stream no longer conditioned on the shopper's garment is
   exactly the failure this is here to prevent, and it is indistinguishable from a healthy
   stream from the outside.

   NO TEARDOWN, NO ERROR UI, AT ANY STAGE. Every recovery here runs on the existing
   session and is invisible to the shopper: no reconnect, no toast, no state change, no
   "Go Live" reset. A freeze is a transient the app should absorb, and a session torn down
   or an error banner shown mid-window is strictly worse than a stream that stutters once
   and continues. The only visible trace is in the console.

   DELIBERATELY LIGHTWEIGHT. One rVFC chain (the same mechanism armFirstFrameBilling
   already uses, so no new frame-detection machinery) plus a 500ms interval that does
   nothing but compare two numbers. It reads no pixels - sampleVideoLuma() is a canvas
   readback and far too expensive to run on a poll - and takes no action at all on a
   healthy stream. */
/* 800ms, down from 1500. The stall being reported is 1-2 seconds long, so a 1500ms
   threshold could only ever act at the very end of one - or miss a short one entirely -
   and inside a 5s billed window that is most of the session gone before anything moves.
   Not lower than this: at the 10fps this app runs inference at, frames legitimately
   arrive ~100ms apart and a slow frame is normal, so a threshold near the frame interval
   would fire on healthy jitter. 800ms is ~8 missed frames - unambiguous. */
const FRAME_FREEZE_MS = 800;
const FRAME_FREEZE_POLL_MS = 250;          // 3+ ticks inside the freeze window, so it is caught near its start
/* Minimum gap between two full RE-ANCHOR attempts (stage 2). The keep-alive ping in
   stage 1 is a small control message and is NOT rate-limited by this; a re-anchor ships
   the whole garment blob through the datachannel, and doing that on every 250ms tick
   would starve the very stream it is repairing. Comfortably longer than a set()
   round-trip, comfortably shorter than the 5s window. */
const FRAME_FREEZE_RECOVER_COOLDOWN_MS = 2500;
/* Gap between keep-alive pings. Cheap, but not free: each is a datachannel message, and
   firing one every 250ms tick through a two-second stall would add traffic to a transport
   that is already struggling. One every ~600ms re-asserts liveness without contributing
   to the problem. */
const FRAME_FREEZE_PING_MS = 600;

let freezeWatcher = null;                  // { stop } while running, else null

/**
 * Watch #aiVideo for decode stalls and recover them. See the block comment above.
 * @param {HTMLVideoElement} video  the live AI feed
 * @param {number} gen  sessionGen at arm time - every callback bails once it moves
 * @returns {{stop: () => void}}
 */
function createFrameFreezeWatcher(video, gen) {
  let disposed = false;
  let lastFrameAt = Date.now();     // wall clock of the last decoded frame we observed
  let lastMediaTime = -1;           // rVFC-less fallback signal: video.currentTime
  let frozenSince = null;           // when the current freeze began, or null while healthy
  let lastRecoverAt = 0;
  let lastPingAt = 0;
  let recovering = false;
  let pings = 0, reanchors = 0;

  const hasRVFC = typeof video.requestVideoFrameCallback === "function";

  /* Every decoded frame stamps the clock. Chained rVFC rather than a rAF loop: rVFC fires
     on frame PRESENTATION, so it stops firing exactly when the stream stops - which is
     the signal. rAF keeps firing at display rate whether or not a frame decoded, and
     would have to be paired with a currentTime comparison anyway (which is what the
     fallback below does). */
  const onFrame = () => {
    if (disposed || gen !== sessionGen) return;
    noteFrame();
    if (hasRVFC) video.requestVideoFrameCallback(onFrame);
  };
  const noteFrame = () => {
    if (frozenSince !== null) {
      console.log(`[PEAR] stream RESUMED after ${Date.now() - frozenSince}ms with no decoded frame`,
        `(${pings} ping${pings === 1 ? "" : "s"}, ${reanchors} re-anchor${reanchors === 1 ? "" : "s"})`);
      frozenSince = null;
      pings = 0;
      reanchors = 0;
    }
    lastFrameAt = Date.now();
  };
  if (hasRVFC) video.requestVideoFrameCallback(onFrame);

  const tick = async () => {
    if (disposed || gen !== sessionGen) return;

    /* Not our problem, and each of these would produce a false positive:
       · not live      - a torn-down or pre-connect session has no frames by definition;
       · hidden tab    - browsers legitimately stop decoding video in a background tab,
                         and "recovering" it would fire a set() the shopper cannot see;
       · reconnecting  - the SDK owns recovery during its own backoff, every send() throws
                         until it lands, and onConnectionChange already re-anchors on the
                         way out. Stamping the clock (rather than merely returning) is
                         what stops the whole outage from counting as one long freeze the
                         instant the tab or the transport comes back. */
    if (!isLive() || connState === "reconnecting" ||
        (typeof document !== "undefined" && document.hidden)) {
      lastFrameAt = Date.now();
      frozenSince = null;
      return;
    }

    // Where rVFC is unavailable, currentTime advancing IS the frame signal.
    if (!hasRVFC) {
      const t = video.currentTime;
      if (t !== lastMediaTime) { lastMediaTime = t; noteFrame(); }
    }

    const gap = Date.now() - lastFrameAt;
    if (gap < FRAME_FREEZE_MS) return;
    if (frozenSince === null) {
      frozenSince = lastFrameAt;
      console.warn(`[PEAR] stream FROZEN - no decoded frame for ${gap}ms while live`,
        `(state=${connState}, paused=${video.paused}, readyState=${video.readyState})`);
    }
    if (recovering) return;                  // an attempt is already in flight

    recovering = true;
    try {
      /* STAGE 1a - THE ELEMENT PING. Cheapest cause, cheapest fix, and safe to repeat: a
         <video> that autoplay or a decoder hiccup left paused resumes here with no
         session traffic at all. Tried on every frozen tick, because it costs nothing and
         a stall can begin at any point during a longer outage. */
      if (video.paused || video.readyState < 2) {
        try { await video.play(); } catch (_) { /* autoplay policy, or already playing */ }
      }

      /* STAGE 1b - THE SDK KEEP-ALIVE. A small control message on the existing session:
         setPrompt() takes session.sendPrompt(), which never touches the image, so this
         re-asserts liveness end-to-end without re-uploading a single byte of garment and
         without any teardown, reconnect or UI change. That is what makes it safe to fire
         DURING a stall rather than after it - the stream is already struggling, and the
         one thing recovery must not do is add a few hundred KB of base64 to it.

         It deliberately bypasses applyGarment(): that path would compare the payload to
         what it believes is on the wire, find both halves identical (one frozen prompt,
         one memoized Blob) and correctly skip - which is right for an ordinary update and
         exactly wrong here, where re-asserting the unchanged state IS the point. Sent
         through clampPromptForWire() like every other dispatch, so this send site cannot
         become the one that bypasses the budget guard. */
      if (rtClient && Date.now() - lastPingAt >= FRAME_FREEZE_PING_MS) {
        lastPingAt = Date.now();
        pings++;
        /* Resolved per category like every other dispatch: re-asserting a TOPS anchor
           over a live trouser session is the same contradiction this branch exists to
           remove, arriving through the recovery path instead of the apply path.

           AND PER LOOK, which is the same rule one level up. applyActive() branches on
           resolveLook() before choosing applyLook() vs applyGarment(); this ping did not,
           so during an "Add to Look" session it re-asserted a SINGLE-garment anchor over
           a two-garment payload. That was survivable while both anchors were bare, and
           stopped being so when the bottoms branch got its opposite-layer scoping back:
           "Keep the subject's upper body and background unmodified." tells the model to
           put the shopper's real shirt back, which is precisely the contradiction
           buildLookPrompt() documents as the thing a full-look payload must never carry.
           It would also persist - this send site bypasses applyGarment() and never
           updates lastSentPrompt, so nothing corrects it until the next explicit apply.

           Routed through buildLookPrompt() rather than lookAnchorPrompt() so this stays
           the SAME builder applyLook() uses: if the look prompt ever starts assembling
           again, recovery follows it without a second edit here. */
        const keepAliveLook = resolveLook();
        const keepAlive = clampPromptForWire(
          keepAliveLook ? buildLookPrompt(keepAliveLook.top, keepAliveLook.bottom)
                        : imageOnlyPrompt(activeItem),
          "freezeKeepAlive");
        console.log("[DECART PROMPT DEBUG]", keepAlive, "(keep-alive ping - no image, no teardown)");
        try {
          /* SKIPPED rather than queued when the wire is busy: this ping exists to poke a
             session that appears to be doing NOTHING, so a write already in flight is
             itself the evidence that the poke is unnecessary. */
          await sendCondition("freezeKeepAlive",
            () => rtClient.setPrompt(keepAlive, { enhance: false }), { skipIfBusy: true });
        } catch (e) {
          console.warn("[PEAR] freeze keep-alive ping failed:", e?.message || e);
        }
      }

      /* STAGE 2 - THE RE-ANCHOR, rate-limited. If frames are still absent the element is
         not the problem, and the live hypothesis is that the transport was rebuilt under
         us: Decart is either generating nothing or generating from the SDK's replayed
         initial state rather than the garment on screen. Forcing the wire state stale is
         what turns applyActive()'s next dispatch into a real set({ image }) - without it,
         a frozen prompt plus a memoized Blob matches on both halves and applyGarment()
         correctly skips, which is exactly the wrong answer here.

         applyActive() re-DERIVES the reference from live state rather than replaying a
         captured one, so this re-anchors to the garment the shopper currently has
         selected, at the current orientation - which is what "the last acknowledged
         reference" has to mean in a session where they can still be swapping items. The
         acknowledged ref is carried only to verify that. */
      if (Date.now() - lastRecoverAt < FRAME_FREEZE_RECOVER_COOLDOWN_MS) return;
      lastRecoverAt = Date.now();
      if (!isGarmentApplied) return;         // nothing acknowledged yet - go-live's own apply still owns the wire
      reanchors++;
      const before = lastAckedImageRef;
      invalidateWireState(`frame freeze (${Date.now() - frozenSince}ms) - forcing the garment back onto the wire`);
      await applyActive();
      if (before && lastAckedImageRef !== before) {
        console.warn("[PEAR] freeze recovery re-anchored to a DIFFERENT reference than the one last",
          "acknowledged - expected if the shopper swapped items during the stall, a bug otherwise.",
          "\n  was:", abbrevImg(before), "\n  now:", abbrevImg(lastAckedImageRef));
      }
    } catch (e) {
      console.warn("[PEAR] freeze recovery attempt failed:", e?.message || e);
    } finally {
      recovering = false;
    }
  };

  const timer = setInterval(() => { tick().catch(() => {}); }, FRAME_FREEZE_POLL_MS);

  return {
    stop() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}

/** Arm the freeze watchdog for this session, replacing any previous instance. */
function startFrameFreezeWatch(video, gen) {
  stopFrameFreezeWatch();
  if (!video) return;
  freezeWatcher = createFrameFreezeWatcher(video, gen);
}

/** Retire it. Safe to call repeatedly and from any exit path. */
function stopFrameFreezeWatch() {
  if (!freezeWatcher) return;
  try { freezeWatcher.stop(); } catch (_) {}
  freezeWatcher = null;
}

/* DEBUG WRAPPER: runs for a short, self-limiting window immediately AFTER
   armFirstFrameBilling() fires, purely to observe whether the frame is still visibly
   changing right after "dressed" was declared - a luma still drifting a few hundred ms
   post-reveal is consistent with the isDressedFrame() gap window.__pearDebugFrameTiming
   exists to investigate. Diagnostic only: never reads or writes billing/recording state,
   session-gen guarded, and capped at 20 ticks so it can never run past the session that
   started it. @returns {void} */
function watchPostFireLuma(video, gen, armedAt) {
  let ticks = 0;
  const tick = () => {
    if (gen !== sessionGen || ticks >= 20) return;
    ticks++;
    const s = sampleVideoLuma(video);
    console.log(`[PEAR][DEBUG] post-fire watch +${Date.now() - armedAt}ms`,
      `| luma=${s.ready ? s.avgLuma.toFixed(1) : "n/a"} blackFrac=${s.ready ? s.blackFrac.toFixed(3) : "n/a"}`);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(tick);
    } else {
      requestAnimationFrame(tick);
    }
  };
  tick();
}

/* ══════════════════════════════════════════════════════════════════════════════
   THE INITIAL APPLY, WITH ONE RECOVERY - "rtClient.set לא הגיב"
   ══════════════════════════════════════════════════════════════════════════════
   THE FAILURE: the bounded race around goLive()'s first applyActive() fires, goLive()
   throws, and the shopper gets "המדידה החיה נכשלה: timeout ממתין ליישום הבגד" in the
   modal with the session torn down under it. The bound itself is right - an unbounded
   await here is the silent-undress hang it was added for - but ENDING THE SESSION is a
   heavy response to the likeliest cause, which is a signaling channel that had not
   finished settling when the first write went out.

   WHAT THIS DOES INSTEAD, exactly once:
     1. resets and re-initialises the realtime client (connectRealtime() disconnects the
        stale one, disposes its throttle/input, claims a fresh sessionGen, and opens a new
        session on a freshly minted token - it is already the file's re-init path, not a
        new one);
     2. sends a LIGHTWEIGHT conditioning payload instead of re-running the full apply -
        see applyFallbackConditioning();
     3. tells the shopper what is happening in one inline toast, in the same voice as
        every other status message in this flow.
   A second failure is a real one and rethrows into goLive()'s existing handler, so the
   "genuine hang ends the session visibly" guarantee is unchanged - it just now takes two
   failures instead of one.

   ONE ATTEMPT, NOT A LOOP. Each attempt costs up to APPLY_TIMEOUT_MS against a shopper
   watching a loading overlay, and a second reconnect that also cannot get a write through
   is describing a broken transport, not a race. Two attempts is the same bound
   applyActive() itself uses for the same reason.

   SUPERSEDE CHECKS ARE ON EVERY LEG, and they cannot use one captured generation:
   connectRealtime() deliberately bumps sessionGen, so the recovery path re-reads it
   afterwards. What is being detected is a teardown or a manual Stop DURING a wait, which
   is `busy` going false or `sessionGen` moving for a reason this function did not cause.
   @returns {Promise<boolean>} true when the garment is on the wire; false when the
   session was superseded and the caller must simply stop. */
async function applyConditioningWithRecovery() {
  /* Attached unconditionally, independent of whether the race times out - a promise that
     eventually settles AFTER we have moved on must never become an unhandled rejection. */
  const race = (promise, label, budgetMs = APPLY_TIMEOUT_MS) => {
    promise.catch(() => {});
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          /* TAGGED, because only a TIMEOUT earns the reconnect below. A real rejection -
             an expired token, a permission failure, the signaling error signaling-retry
             already narrows on - is a definite answer, and answering it by minting a
             second token and opening a second session spends a shopper's time and a
             credit to arrive at the same failure. Those rethrow unchanged, exactly as
             they did before this recovery existed. */
          const e = new Error(`timeout ממתין ליישום הבגד (rtClient.set לא הגיב${label ? " - " + label : ""})`);
          e.isApplyTimeout = true;
          reject(e);
        }, budgetMs);
      }),
    ]);
  };

  const genBefore = sessionGen;
  try {
    /* THE COLD-START LEASH, not APPLY_TIMEOUT_MS. This is the FIRST thing a shopper sees,
       and 10 seconds of a loading overlay is not a bound they will wait out - they close
       the widget and reopen it, which is the "it never works on the first try" report
       almost verbatim. COLD_START_ACK_MS (2.5s) is past the p99 of a healthy first apply,
       so the automatic reconnect below happens instead of the manual one. The RECOVERY leg
       keeps the full budget: by then the shopper has been told what is happening, and a
       second reconnect would cost more than it could buy. */
    await race(applyActive(), "", COLD_START_ACK_MS);
    return sessionGen === genBefore;   // superseded mid-wait → the caller stops here
  } catch (err) {
    // Superseded while we were waiting (a manual Stop, a fresh connect): the session this
    // apply was FOR no longer exists, so let whichever path superseded it own what
    // happens next rather than opening ANOTHER one on top.
    if (sessionGen !== genBefore || !busy) return false;
    if (!err || !err.isApplyTimeout) throw err;   // a definite failure - see race()'s note
    console.warn("[PEAR] initial apply did not land -", err?.message || err,
      "\n  → resetting the realtime client once and retrying with a lightweight payload");
    toast("מרענן חיבור מדידה... · Refreshing the fitting connection…");

    /* FLUSH FIRST, then reset. The queue may still hold the write that never came back,
       and its epoch must be retired before a new session's first write is queued behind
       it - connectRealtime() does this too, but doing it here as well makes the flush
       unconditional rather than a side effect of a call that could early-return.
       force:true is load-bearing: the SDK still reports this session as connected (that
       is exactly the failure - a live-looking session that will not acknowledge a write),
       so without it connectRealtime() returns immediately and recovers nothing. */
    resetConditionWire();
    await connectRealtime({ force: true });
    await waitConnected(CONNECT_TIMEOUT_MS);
    const genAfter = sessionGen;

    await race(applyFallbackConditioning(), "fallback");
    if (sessionGen !== genAfter) return false;
    console.log("[PEAR] fitting connection refreshed - lightweight conditioning applied");
    return true;
  }
}

/**
 * The retry payload: the pristine garment image and its category anchor, and nothing else.
 *
 * DELIBERATELY NOT applyActive(). That path can resolve a stitched FRONT|BACK composite or
 * a two-garment look Blob, decode bitmaps, and ship a few hundred KB - work that is
 * correct for a healthy session and is exactly the wrong thing to put on a channel that
 * just failed to acknowledge a write. This sends a proxied URL reference (garmentImageRef,
 * no fetch, no decode, no canvas) plus the same frozen anchor imageOnlyPrompt() resolves
 * for that garment, so the shopper still gets THEIR garment rather than a degraded or
 * invented one - the reference is pristine, only the delivery is lighter.
 *
 * FOR A FULL LOOK it sends the TOP. One image is all set() accepts (see applyLook), the
 * stitched two-garment composite is precisely the heavy asset being avoided, and the next
 * ordinary applyActive() - a re-anchor, a swap, the topology monitor - restores the full
 * look on a channel that has proven it works. Half a look beats a dead session.
 *
 * It stamps the wire state on success like every other dispatch, so the session's
 * bookkeeping stays true and the next apply can take its usual fast path.
 * @returns {Promise<void>}
 */
async function applyFallbackConditioning() {
  const look = resolveLook();
  const item = look ? look.top : activeItem;
  if (!item || !rtClient) throw new Error("no garment / no client for the fallback apply");

  const gallery = galleryOf(item) || {};
  const image = garmentImageRef(gallery.front || item.img || gallery.back);
  const prompt = clampPromptForWire(imageOnlyPrompt(item), "fallbackConditioning");

  console.log("[PEAR] fallback conditioning:", item.name,
    "| reference:", abbrevImg(image) || "(none - prompt only)",
    look ? "| full look reduced to its TOP for this send" : "");
  console.log("[DECART PROMPT DEBUG]", prompt, abbrevImg(image), "(lightweight fallback)");

  await sendCondition("fallbackConditioning",
    () => rtClient.set({ prompt, enhance: false, ...(image ? { image } : {}) }));

  isGarmentApplied = true;         // the wire holds a garment - the next frame is dressed
  releaseInputGate("fallback conditioning");
  lastSentImageRef = image || null;
  rtImageOnWire = !!image;
  lastSentPrompt = prompt;
  if (image) lastAckedImageRef = image;
}

/**
 * Open ONE realtime session, apply the active garment, and stream the live
 * AI-edited video so the garment warps/tracks the user dynamically. The session
 * stays open until the user presses Stop (stopLive). Switching items reuses this
 * session via set() without reconnecting.
 *
 * Re-entrancy (Task 10): `busy` is claimed BEFORE the first await (the pre-use
 * connectivity probe and the camera prompt), so rapid double-clicks cannot open
 * two concurrent capture flows / billable sessions. The finally clause is the
 * single release point for `busy` and the capture button.
 * @returns {Promise<void>}
 */
async function goLive() {
  if (busy || isLive()) return;

  // Two-view gate - runs BEFORE any token mint / WebRTC connect / billing. Graceful
  // by default; only opt-in requireBothViews items (or a garment with no front) are
  // blocked. Bail out with a toast and never open a session for a blocked garment.
  const blockReason = liveBlockReason();
  if (blockReason) { toast(blockReason); return; }

  // See itemPendingReason()'s doc comment for why this is a separate check from the
  // one above. Re-evaluated fresh on every click, so a shopper who waits (or whose
  // 35s give-up timeout fires) and clicks again sails straight through with no
  // special-casing needed here.
  const pendingReason = livePendingReason();
  if (pendingReason) { toast(pendingReason); return; }

  // Same shape, same place in the gate chain: an adult shopper cannot launch a
  // kids-only garment. See sizeCategoryMismatchReason()'s own comment for why this
  // reuses ageGroup/currentSizeCategory rather than a new sizes-array data source.
  const sizeReason = sizeCategoryMismatchReason();
  if (sizeReason) { toast(sizeReason); return; }

  busy = true;                         // Task 10 - claim the flow before ANY await
  $("captureBtn").disabled = true;
  $("camError").hidden = true;
  exitClipReplay();                    // clear any history clip before a real session takes #aiVideo
  clearRecording();                    // Feature 2 - drop any previous clip + button
  card().classList.remove("show-result");  // drop any frozen snapshot so the live feed isn't covered by #resultCanvas

  try {
    // Health probe is a soft warning only - fire-and-forget so it never serialises
    // into the go-live path. If the network is down, WebRTC / token steps will fail
    // with a real error that is caught and shown to the user.
    ensureOnline().then(online => {
      if (!online) {
        console.warn("[go-live] health probe returned offline - proceeding anyway");
        toast("בדיקת קישוריות לא הצליחה - ממשיכים בניסיון חיבור");
      }
    });

    if (!localStream) { const ok = await startCamera(); if (!ok) return; }

    // ── Black-screen / camera-off gate (credit saver) ────────────────────────
    // Runs AFTER the camera is live but BEFORE any token mint / WebRTC connect /
    // billing. Streaming a black feed to Decart would burn the full
    // CREDITS_PER_SESSION for a render nobody can use, so if the local webcam is a
    // black screen (lens covered, camera off, privacy shutter) we bail out here -
    // no /api/realtime-token, no connectRealtime(), no credits - and tell the user
    // exactly what to fix. cameraLooksBlack() only inspects local pixels; it sends
    // nothing to any API.
    if (await cameraLooksBlack()) {
      showCamError("זוהה מסך שחור. הפעל את המצלמה או הסר חסימה מהעדשה כדי להמשיך. " +
        "(Black screen detected. Please turn on your camera or remove any obstacles to proceed.)");
      toast("📷 מסך שחור - המדידה לא הופעלה כדי לחסוך קרדיטים");
      return;   // finally{} resets busy + the capture button; no billed session opened
    }

    /* ── Presence check, call site (credit saver #2) ────────────────────────
       Header deliberately worded so it does not begin with the same phrase that opens
       the gate's own implementation block below - body-presence-gate.test.mjs extracts
       that block by matching its first line, and takes the FIRST occurrence in the file.
       goLive() sits ABOVE the implementation, so a matching header here silently becomes
       the code under test. Same trap the outfit-slot extract marker already documents.

       Same position and same reasoning as the black-screen check directly above: the
       camera is live, nothing has been minted or billed yet, and this is the last point
       at which we can still tell that the session about to open would be wasted.

       Decart conditions on the frame it is handed, and LIVE_DURATION_MS caps the session
       at 5s - so going live while the shopper is still out of shot spends the entire
       billed window on a garment fitted to an empty room. That is the reported
       "first try is always glitchy".

       UNLIKE the black-screen check, this one NEVER REFUSES. It delays, shows the
       "step into frame" overlay while it waits, and proceeds anyway on timeout or with
       no usable detector - see awaitBodyPresence(). A shopper the model cannot see must
       still get their try-on. */
    const presence = await awaitBodyPresence(isBottomsGarment(activeItem));
    if (presence !== "present") {
      console.warn(`[go-live] presence gate did not confirm (${presence}) - continuing`);
    }
    hidePresenceOverlay();   // belt-and-braces: never leave it over a live session

    /* BUG FIX (cross-run mode persistence): a PREVIOUS session in this same page load
       may have downgraded currentAngle to "front" below (watcher couldn't arm that
       time) - and since renderPerspectiveSelector() is only re-run on an item/colour
       swap, NOT on every go-live, that downgrade used to stick for every subsequent
       run until the shopper happened to touch something else. That is exactly the
       "run 1 fine, run 2/3 broken" pattern: whichever mode Run 1 ended up on kept
       being reused, not re-attempted. Re-derive fresh from canCombineViews() on
       EVERY go-live so each run gets its own honest attempt at AI Auto, rather than
       inheriting a downgrade from a run that's already over. */
    currentAngle = canCombineViews(activeItem) ? AUTO_ANGLE : "front";
    /* Boot the lock UNRESOLVED (PENDING_MODE), not FRONT. This used to assert
       "the shopper is facing the camera" before a single frame had been sampled,
       and because the watcher's needsSwitch test compares against autoOrientation,
       that assumption was indistinguishable from a CONFIRMED reading - so a shopper
       who went live already turned around had to clear the full anti-flap threshold
       (10 frames / 2.5s) before the back asset was applied, watching the front
       render on their back until then. PENDING resolves from the first confident
       sample instead (ORIENT_ACQUIRE_FRAMES, ~500ms). */
    if (currentAngle === AUTO_ANGLE) autoOrientation = null;

    /* ── Mandatory Pre-load & Validation Gate ─────────────────────────────────
       Blocks HERE, before any token mint / WebRTC connect / billing, until every
       garment asset this run needs is fetched, decoded, and content-validated.
       Previously the back Blob was only awaited lazily inside maybeSwap() at the
       moment of the FIRST turn - correct, but it meant a slow or genuinely broken
       back asset was discovered mid-session, after the shopper had already turned
       around: exactly what "blank back view" looked like from the outside. Doing
       it here means that failure surfaces (or is gracefully absorbed into a
       front-only run) BEFORE any camera/Decart resource - and any billing - is
       spent, never as a mid-turn surprise. */
    if (currentAngle === AUTO_ANGLE) {
      $("scanOverlay").hidden = false;
      const preload = await preloadGarmentAssets();
      if (!preload.ok) {
        $("scanOverlay").hidden = true;
        showCamError("לא ניתן לטעון את תמונת הבגד · Could not load the garment image.");
        toast("⚠ טעינת תמונת הבגד נכשלה");
        return;   // finally{} resets busy + the capture button; no billed session opened
      }
      if (!preload.hasBack) {
        // Known-bad/missing back BEFORE go-live - don't arm AI Auto with an asset we
        // already know is broken. Front-only is a fully supported, never-blocked mode.
        currentAngle = "front";
        toast("תצוגת הגב אינה זמינה - מוצג רק חזית · Back view unavailable - front only");
      }
    }

    // LOADING state: overlay + a live elapsed-time counter (generic copy, no model/
    // vendor names - see startScanTimer). Runs until startBillingWindow() confirms
    // Model Ready and hides it - see the state-transition comment there.
    $("scanOverlay").hidden = false;
    startScanTimer();

    // 1) mint ek_ token + open the WebRTC session. NOTE: billing no longer starts here -
    //    the WebRTC session is open, but the billed 5s window is armed by the FIRST
    //    rendered Decart frame (onRemoteStream → armFirstFrameBilling), not at connect.
    await connectRealtime();
    await waitConnected(CONNECT_TIMEOUT_MS);
    console.log("[PEAR] Decart connected - waiting for first frame");

    /* Settle the try-on mode BEFORE the first reference is built, so exactly one
       rtClient.set() is issued for it. This is a SECOND, independent guard from the
       pre-load gate above: that one validates the ASSET (is the back image itself
       fetchable/decodable/real); this one validates the WATCHER (can the local camera
       actually be sampled). AI Auto needs both. If currentAngle is already "front"
       here, the pre-load gate already made that call and this block is a no-op.

       RETRY, DON'T IMMEDIATELY DEGRADE: a failure to arm right after connect is
       usually a transient timing hiccup (the video track settling right as the
       WebRTC handshake lands) rather than a real hardware absence - cameraLooksBlack()
       already proved a live camera earlier in this same call. A few short retries
       give that a chance to resolve before giving up.

       If it still can't arm, fall back to plain "front" - NEVER a stitched front|back
       composite (that used to be the fallback here). A single 2048×1024 combined
       image asks Lucy - a diffusion model with no concept of "panels" - to decide
       which half to render every single frame, and it would frequently render
       fragments of BOTH at once: the double-logo/duplicated-garment symptom. Front-
       only has no such failure mode - it's the exact same single, unambiguous
       reference AI Auto already uses for FRONT_MODE, just without the ability to
       switch to the back. */
    syncOrientationWatcher();
    for (let attempt = 1; attempt <= 3 && currentAngle === AUTO_ANGLE && !orientWatcher; attempt++) {
      await new Promise((r) => setTimeout(r, 200));
      syncOrientationWatcher();
    }
    if (currentAngle === AUTO_ANGLE && !orientWatcher) {
      console.warn("[PEAR] AI Auto watcher unavailable after retry - proceeding FRONT-ONLY (never a stitched composite)");
      currentAngle = "front";
      toast("תצוגת הגב אינה זמינה - מוצג רק חזית · Back view unavailable - front only");
    }
    console.log(`[VTON Pipeline] Top-level mode this run: ${currentAngle}`,
      currentAngle === AUTO_ANGLE ? "(per-orientation asset switching - watcher armed; FRONT_MODE/BACK_MODE is a live lock, see [VTON Pipeline] Current Active State below)"
        : "(front only)");

    // 2) apply on the live stream - the full look (shirt + pants, ONE payload) when
    //    activeOutfit has both slots filled, else the single active garment. Same session.
    /* THE SILENT-UNDRESS HANG. This call sits in a gap neither of this function's other
       two timeouts covers: waitConnected(CONNECT_TIMEOUT_MS) above already resolved (the
       SDK reports "connected" independently of this call, via onConnectionChange), and
       FIRST_FRAME_TIMEOUT_MS below doesn't arm until AFTER this line returns. If the
       transport this specific rtClient.set() was writing to gets torn down and replaced
       by the SDK's OWN internal reconnect - most likely in exactly this first-second
       window, while media/signaling is still settling - and the SDK never rejects the
       now-orphaned promise, this awaited forever: "connected" was already showing, the
       shopper's real camera was already live under it, and the garment simply never
       arrived - no error, no retry, and nothing downstream (isGarmentApplied stays
       false) to tell the reconnect-recovery path at connectRealtime() there was
       ever anything worth re-applying. Bounded the same way CONNECT_TIMEOUT_MS/
       FIRST_FRAME_TIMEOUT_MS already bound their own stages, so a genuine hang here
       becomes the SAME visible "live measurement failed" + stopLive() this function
       already produces for any other go-live failure, instead of a silently undressed
       session with a healthy-looking badge. */
    /* IT NOW RECOVERS ONCE BEFORE IT GIVES UP. The bounded race below is unchanged in
       purpose; what changed is what happens when it fires. A timeout used to end the
       session outright, putting the raw "rtClient.set לא הגיב" string in front of the
       shopper - a harsh outcome for the stage whose likeliest cause is a transport that
       had not finished settling. See applyConditioningWithRecovery(). */
    if (!await applyConditioningWithRecovery()) return;
    // Log every garment being worn - both top AND bottom when a full look is active.
    const _trackSize = activeTryOnSize || currentUserSize;
    const _look = resolveLook();
    if (_look) {
      logTryOnAnalytics(_look.top,    _trackSize);
      logTryOnAnalytics(_look.bottom, _trackSize);
    } else {
      logTryOnAnalytics(activeItem, _trackSize);
    }

    // 3) "Stop" becomes available immediately - the user can always bail out of a slow
    //    connect/warm-up rather than being stuck watching the loading timer with no
    //    escape hatch. NOTE: the scanOverlay/"show-live" reveal itself is NOT done here
    //    anymore - that only happens once startBillingWindow() verifies Model Ready
    //    (see the state-transition comment there), so the user never sees "ready" UI
    //    before there's real AI content behind it.
    setLiveControls(true);
    syncOrientationWatcher();          // AI Auto: begin monitoring the user's orientation
    // Feature 2 - recording is now started in startBillingWindow(), on the same first
    // DRESSED frame that arms billing, so the encoded clip always matches the billed window.
    startStatsMonitor();               // diagnostic getStats poller (DevTools console; no billing effect)

    // The BILLED window (countdown + hard disconnect at LIVE_DURATION_MS) is NOT armed
    // here anymore - it arms on the first rendered Decart frame via onRemoteStream →
    // armFirstFrameBilling → startBillingWindow, so connect + warm-up time is never billed.
    // The only timer armed here is a SAFETY net: if that first frame never arrives, nothing
    // else would cap the open session, so tear it down after FIRST_FRAME_TIMEOUT_MS. It is
    // cancelled the moment billing actually starts. Guard against the fast-frame race where
    // the first frame already armed billing before we got here.
    const guardGen = sessionGen;
    if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }
    if (!billingStarted) {
      firstFrameGuardTimer = setTimeout(() => {
        firstFrameGuardTimer = null;
        if (sessionGen !== guardGen || billingStarted) return;   // session moved on / billing already ticking
        console.warn("[PEAR] No first frame within " + FIRST_FRAME_TIMEOUT_MS + "ms - tearing down (no idle billing)");
        stopScanTimer();                // model never became ready - retire the loading UI here
        $("scanOverlay").hidden = true;
        stopLive();
        showCamError("החיבור לא הניב תמונה - נסה שוב.");
        setConn("error");
      }, FIRST_FRAME_TIMEOUT_MS);
    }

    toast("✨ מדידה חיה · סרטון " + Math.round(VIDEO_LENGTH_MS / 1000) + " שניות");
  } catch (err) {
    stopLive();                        // close any partial session - no idle billing
    console.error("[go-live] failed:", err?.message || String(err));
    if (DEMO_FLAG) {
      await renderMockDemo(activeItem);
      card().classList.add("show-result");
    } else {
      showCamError("המדידה החיה נכשלה: " + (err?.message || err));
      setConn("error");
    }
  } finally {
    // Only force-hide the loading overlay here on a FAILURE path (never got to a live
    // session - isLive() false). On success the session is already connected and we're
    // just waiting on the model's first verified frame, so leave the overlay + ticking
    // timer showing - startBillingWindow() (Model Ready) is what closes them, not this.
    if (!isLive()) { stopScanTimer(); $("scanOverlay").hidden = true; }
    busy = false;
    if (!isLive()) $("captureBtn").disabled = !localStream;
  }
}

/**
 * Manual/early hard-stop (Stop button or tab hidden). Cancels the 5s timer and
 * disconnects immediately so billing stops the instant it's called.
 * @returns {void}
 */
function stopLive() {
  // 🖼 Freeze the final dressed frame onto the on-screen #resultCanvas and save it
  // as the high-quality "masterpiece" BEFORE teardown() detaches #aiVideo. Wrapped
  // so a capture hiccup can never delay the billing kill-switch below.
  let frozen = null;
  try {
    if (isLive()) {
      frozen = freezeFinalFrame();                 // paints #resultCanvas, returns its dataURL
      const size = activeTryOnSize || currentUserSize || "-";
      lastFitTs = saveFitToGallery(frozen || captureLiveFrame(), currentLookName(), size,
                                   activeItem && activeItem.id);
      if (lastFitTs) lockDemoAfterFirstMeasurement();   // first successful save → one-time demo used
    }
  } catch (_) {}

  teardown();                          // rtClient.disconnect() → billing stops now (also hides #aiVideo)
  card().classList.remove("show-live");
  stopLowerBodyGuard();
  stopPresenceWatcher();
  if (frozen) card().classList.add("show-result");   // surface the frozen snapshot as the final result
  setLiveControls(false);              // reset the button back to "Go Live" so a new session can start
  $("captureBtn").disabled = !localStream;
}

/* ── Billed-window cap → frozen-frame hold ───────────────────────────────────
   Fires at LIVE_DURATION_MS (the BILLED window). Captures the final dressed frame,
   disconnects Decart so billing stops NOW, then keeps the recorder + on-screen view
   on that frozen frame until VIDEO_LENGTH_MS so the saved/replayed clip is the full
   5s WITHOUT any extra token spend. The remaining tail is finalized by
   finalizeVideoClip(). A manual Stop / tab-hide during the live phase still uses the
   plain stopLive()→teardown() path (an early, shorter clip - the user chose to stop). */
function beginFreezeHold() {
  // 1) Grab the last dressed frame BEFORE disconnecting (needs the live #aiVideo).
  recordHoldSrc = captureHoldFrame();
  recordHold = true;                    // paint loop now records this frozen frame to VIDEO_LENGTH_MS

  // 2) Freeze the on-screen masterpiece + persist it to the gallery (frame is ready now).
  let frozen = null;
  try {
    frozen = freezeFinalFrame();
    const size = activeTryOnSize || currentUserSize || "-";
    lastFitTs = saveFitToGallery(frozen || captureLiveFrame(), currentLookName(), size,
                                 activeItem && activeItem.id);
    if (lastFitTs) lockDemoAfterFirstMeasurement();   // first successful save → one-time demo used
  } catch (_) {}

  // 3) Kill Decart billing immediately (tokens stop at LIVE_DURATION_MS) - but leave
  //    the recorder, paint loop and countdown alive for the frozen-hold tail.
  stopBilling();

  // 4) Surface the frozen result for the remainder of the window; lock the control so
  //    a mid-hold click can't start a second session before the clip finalizes.
  card().classList.remove("show-live");
  stopLowerBodyGuard();
  stopPresenceWatcher();
  if (frozen) card().classList.add("show-result");
  $("captureBtn").disabled = true;

  // 5) Finalize the full-length clip after the hold tail (VIDEO_LENGTH_MS − billed window).
  if (videoFinalizeTimer) clearTimeout(videoFinalizeTimer);
  videoFinalizeTimer = setTimeout(finalizeVideoClip, Math.max(0, VIDEO_LENGTH_MS - LIVE_DURATION_MS));
}

/* Capture the current dressed frame into a fresh off-DOM canvas (the recorder repaints
   it during the hold). Prefers the AI-edited feed; falls back to the mirrored webcam.
   Returns null if nothing is paintable. */
function captureHoldFrame() {
  const ai = $("aiVideo"), webcam = $("webcam");
  let src = null, mirror = false, w = 0, h = 0;
  if (ai && ai.videoWidth > 0 && ai.style.display !== "none") {
    src = ai; w = ai.videoWidth; h = ai.videoHeight;
  } else if (webcam && webcam.videoWidth > 0) {
    src = webcam; w = webcam.videoWidth; h = webcam.videoHeight; mirror = true;
  }
  if (!src || !w || !h) return null;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d", { alpha: false });
  c.save();
  if (mirror) { c.translate(w, 0); c.scale(-1, 1); }
  try { c.drawImage(src, 0, 0, w, h); } catch (_) { c.restore(); return null; }
  c.restore();
  return cv;
}

/* Stop ONLY the billable Decart session - a subset of teardown() that deliberately
   leaves the recorder, paint loop, countdown and finalize timer running so the
   frozen-hold tail can complete. Bumps sessionGen so any late SDK callback no-ops. */
function stopBilling() {
  if (liveDurationTimer) { clearTimeout(liveDurationTimer); liveDurationTimer = null; }
  sessionGen++;                         // neutralise in-flight onRemoteStream/onConnectionChange
  stopStatsMonitor();
  if (rtClient) { try { rtClient.disconnect(); } catch (_) {} rtClient = null; }
  lastSentImageRef = null; rtImageOnWire = false; lastSentPrompt = null;   // session over - nothing is on the wire
  resetConditionWire();
  /* Unlike teardown(), this deliberately leaves the watcher and the paint loop alive for
     the frozen-hold tail - so a turn hold raised a moment before the window closed has
     nothing left to release it, and its overlay (z-index 6, inside #cameraCard) would sit
     on top of that tail for the rest of the session. */
  orientHoldEnd("billing-stopped");
  /* Same exemption logic as the line above, same conclusion: the frozen-hold tail keeps
     the watcher and paint loop alive, so a re-drape cover raised just before the window
     closed has nothing left to release it and would sit on top of that tail (z-index 7,
     inside #cameraCard) for the rest of the session. */
  redrapeCoverEnd("billing-stopped");
  /* The freeze watchdog does NOT get that exemption, and the difference is what each one
     is for. The orientation watcher stays because the frozen-hold tail still has UI state
     to release; this one exists solely to keep a LIVE stream alive, and two lines above
     this the session was disconnected and #aiVideo detached - so from here it can only
     observe a video element with no source and correctly conclude nothing. Its own
     sessionGen/isLive guards already make it inert; stopping it is the difference between
     inert and not running, and a 500ms timer spinning through the tail for no reason is
     the kind of thing that reads as a leak the next time someone profiles this. */
  stopFrameFreezeWatch();
  if (inputThrottle) { try { inputThrottle.dispose(); } catch (_) {} inputThrottle = null; }
  if (realtimeInput) { try { realtimeInput.getTracks().forEach((t) => t.stop()); } catch (_) {} realtimeInput = null; }
  const ai = $("aiVideo");
  if (ai) { ai.style.display = "none"; ai.srcObject = null; }
  resetAiFeedVisibility();   // never leave a dead session's opacity:0 on a reused element
  connState = "idle";
  connecting = false;
  setConn("idle");
}

/* Close out the frozen-hold: stop the recorder (flushes the full-length clip),
   clear the hold state, and hand the UI back to the idle "Go Live" state. */
function finalizeVideoClip() {
  if (videoFinalizeTimer) { clearTimeout(videoFinalizeTimer); videoFinalizeTimer = null; }
  hideLiveCountdown();
  stopRecording();                      // stopPaintLoop + mediaRecorder.stop() → finalizeRecording
  recordHold = false;
  recordHoldSrc = null;
  setLiveControls(false);
  $("captureBtn").disabled = !localStream;
  toast("⏱ הסרטון בן " + Math.round(VIDEO_LENGTH_MS / 1000) + " שניות מוכן ✓");
}

/* ── Lower-body compositing guard (config.js LOWER_BODY_GUARD_ENABLED) ────────
   THE PROBLEM THIS EXISTS FOR: nothing in @decartai/sdk@0.1.5's realtime API can put a
   hard boundary on what Decart is allowed to touch (setInputSchema is exactly { prompt,
   enhance, image } - no mask/ROI/region parameter exists to configure). A prompt can ask
   the model not to alter the trousers; it cannot GUARANTEE it, and a live report showed
   it failing that ask (a hallucinated tuxedo/altered trousers reaching the screen). This
   is the one lever that CAN guarantee it: after Decart renders, paint the shopper's own
   raw camera pixels back over whatever is below the guard line, in the browser, where
   nothing the model does can override it.

   WHY IT IS OFF BY DEFAULT: see LOWER_BODY_GUARD_ENABLED's own comment in config.js.
   Short version - the boundary is a fixed fraction of frame height, not a real body-part
   detection, so it is a guess that can clip into a correctly-rendered shirt for a
   shopper framed close to the camera. Must be validated live before flipping true.

   ADDITIVE ONLY, matching lux-interactions.js's own stated design rule for exactly this
   reason: #aiVideo is never touched, never re-parented, never has its role changed. This
   only ever paints on top of it via the stacked #lowerBodyGuard canvas (style.css). */
/* ── Body-presence gate - "the first try is always glitchy" ──────────────────────
   THE FAILURE. Decart conditions on the frame it is handed. Press go-live while still
   reaching for the mouse, half out of shot, or mid-turn, and the garment is fitted to
   THAT frame - to an empty room, a shoulder, a blur. The session is hard-capped at
   LIVE_DURATION_MS (5s, 10 credits), so the shopper watches a broken render for the whole
   billed window and presses again. The retry reads as "it fixed itself"; nothing was
   fixed, they simply happened to be standing still the second time.

   THE SHAPE IS ALREADY IN THIS FILE. cameraLooksBlack() sits a few lines above the
   insertion point in goLive() and does exactly this for a covered lens: a local,
   pixel-only check that refuses to open a billed session it can already tell will be
   wasted, and sends nothing anywhere to decide. This is that, for an empty frame.

   ── WHY A POSE MODEL, AND WHY IT IS OPTIONAL ────────────────────────────────────
   The orientation watcher's FaceDetector can answer "is a person there". It cannot
   answer "are the HIPS AND KNEES in frame", which is the only question that matters for
   a trousers try-on - and gating trousers on a face is how "the first try is glitchy"
   survives this fix for exactly the category that reported it.

   But MediaPipe Pose is a multi-MB WASM runtime from a CDN, in a page that has zero
   external scripts, and app.js:10474 records this file declining that dependency once
   already. So the rules are: it is PRELOADED during Screen 2, never fetched on the
   go-live path (a 3-6MB download on the critical path would defeat the very feature),
   and EVERY failure of it - dead CDN, slow CDN, no WebAssembly, no WebGL - degrades to
   the native FaceDetector engine and then to simply proceeding. The gate is an
   optimisation; the try-on is the product, and no third party may block it.

   STILL A HEURISTIC, said plainly: landmark visibility is the model's own confidence
   that a joint is in frame, not a measurement. It is a far better signal than the fixed
   fraction the lower-body guard below has to use, and it is not a guarantee. */

/* BlazePose 33-point topology. Named rather than inlined because a bare `landmarks[23]`
   is unreviewable, and an off-by-one here silently gates trousers on an elbow. */
const POSE_LANDMARK = Object.freeze({
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
});

/**
 * Which joints must be visible before this garment can be fitted.
 *
 * TOPS need shoulders AND hips. Shoulders alone are satisfied by a head-and-neck crop
 * with no torso in frame at all - which is precisely the framing that produces a garment
 * fitted to nothing. Hips are the torso's lower anchor, so requiring them means the whole
 * region the garment will occupy is actually on camera.
 *
 * TOPS DELIBERATELY DO NOT REQUIRE KNEES. The most common webcam framing in the world is
 * a person seated at a desk, and requiring legs would refuse a shirt try-on to nearly
 * everyone. BOTTOMS do require them: hips alone do not prove the trousers will be in
 * frame, and the reported failure was a bottoms render.
 * @param {"top"|"bottom"} category
 * @returns {number[]}
 */
function requiredPoseLandmarks(category) {
  const L = POSE_LANDMARK;
  return category === "bottom"
    ? [L.LEFT_HIP, L.RIGHT_HIP, L.LEFT_KNEE, L.RIGHT_KNEE]
    : [L.LEFT_SHOULDER, L.RIGHT_SHOULDER, L.LEFT_HIP, L.RIGHT_HIP];
}

/**
 * Does ONE detected skeleton clear the bar for this category?
 * @param {Array<{visibility?:number}>|null|undefined} landmarks
 * @param {"top"|"bottom"} category
 * @param {number} minConfidence
 * @returns {boolean}
 */
function poseFrameQualifies(landmarks, category, minConfidence = POSE_MIN_CONFIDENCE) {
  if (!Array.isArray(landmarks) || !landmarks.length) return false;
  return requiredPoseLandmarks(category).every((i) => {
    const lm = landmarks[i];
    return !!lm && Number(lm.visibility ?? 0) >= minConfidence;
  });
}

/**
 * Interpret a raw detector result.
 *
 * THE THREE-STATE RETURN IS THE POINT. `null` means "cannot judge" - no detector, or it
 * failed - and is NOT the same as `false` ("looked, nobody there"). Collapsing the two
 * would let a broken CDN read as a permanently empty room and refuse every session,
 * which is the exact failure mode this gate must never have.
 * @returns {boolean|null}
 */
function presenceFromPoseResult(result, category) {
  if (!result || !Array.isArray(result.landmarks)) return null;
  if (!result.landmarks.length) return false;
  return result.landmarks.some((set) => poseFrameQualifies(set, category, POSE_MIN_CONFIDENCE));
}

/**
 * The consecutive-frame streak. One qualifying frame is not presence: a shopper walking
 * THROUGH the shot, or a poster on the wall catching the model for a frame, both produce
 * isolated hits. Requiring POSE_CONSECUTIVE_FRAMES in a row, with any miss resetting the
 * count, is what separates "someone is standing here" from "something passed by".
 */
function makePresenceGate(needed = POSE_CONSECUTIVE_FRAMES) {
  let streak = 0;
  return {
    feed(ok) { streak = ok ? streak + 1 : 0; return streak >= needed; },
    reset() { streak = 0; },
    get streak() { return streak; },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTINUOUS BODY TOPOLOGY - the dynamic half of "static garment, dynamic body"
   ══════════════════════════════════════════════════════════════════════════════
   THE REPORT: the garment is fitted while the shopper faces the camera, and then it is
   STRETCHED over whatever they do next. Turn 90 degrees and the 0-degree drape is smeared
   across a side-on silhouette; put a cushion under the shirt and the same drape is
   inflated over it. The cut warps, the print skews, the fabric reads as painted-on.

   THE CAUSE IS ARCHITECTURAL, not a threshold. Everything upstream treated the body as a
   fact established ONCE: awaitBodyPresence() is a gate - it asks "is anyone there?" at
   go-live and then it is done. Nothing afterwards ever re-asked what SHAPE that body is.
   So the render stayed conditioned on the frame it was born in, and a diffusion model
   handed a body that no longer matches its conditioning does the cheapest available
   thing - it deforms what it already has.

   THE SPLIT THIS ENFORCES, and it is the whole design:
     · THE GARMENT is STATIC and INVARIANT. Its cut, fabric, print and colour come from
       one reference image and nothing here may touch them. This module never reads the
       garment, never rewrites the prompt, and never selects a different asset.
     · THE BODY is DYNAMIC and VARIABLE, and it lives only in the current frame. Its
       orientation, profile depth and volume are re-measured every tick.
   When the live body has moved far enough from the shape the CURRENT render was
   conditioned against, this asks for a re-conditioning frame: same garment, same
   reference, re-draped over the contour that is actually in front of the camera now.

   WHAT IT MEASURES, said plainly, because the honest limits matter more than the numbers:
   BlazePose gives 33 joints. It does not give a body scan, and there is no landmark for
   "belly". What a skeleton CAN see is the torso's PROJECTION - how far the shoulder line
   has rotated out of the image plane, how much the torso leans toward or away from the
   lens, how much depth separates the shoulders from the hips, and the aspect of the box
   the four torso joints span. Turning changes the first two; adding real volume at the
   waist pushes the hips forward relative to the shoulders and squares up that box, which
   moves the last two. So this is a CHANGE DETECTOR on the body's contour, not a
   measurement of it - which is exactly what is needed, because the only decision it
   drives is "re-drape against the live frame or not". Decart re-reads the actual pixels;
   this only has to know when to ask.

   EVERYTHING IS SCALE-INVARIANT ON PURPOSE. Every metric is a ratio or an angle, never a
   pixel count, so a shopper stepping toward the camera does not read as a body that
   changed shape - the same reasoning torsoWidth() already applies on the orientation
   watcher's own baseline.

   IT RUNS ON THE LOOP THAT ALREADY EXISTED. startPresenceWatcher() is now the session's
   single pose sampler: one detectForVideo() per tick, feeding the presence gate and this
   monitor from the same result. Two independent samplers would have doubled a WASM/GPU
   inference on a phone AND risked MediaPipe's monotonic-timestamp contract (two callers
   landing on the same performance.now() millisecond throws outright). */

/* The four joints that define the torso. Shoulders and hips only: they bound the region
   both garment categories are actually draped over, they are the joints BlazePose places
   most reliably, and adding knees/elbows would make a shopper waving an arm read as a
   body that changed shape. */
const TORSO_LANDMARKS = Object.freeze([
  POSE_LANDMARK.LEFT_SHOULDER, POSE_LANDMARK.RIGHT_SHOULDER,
  POSE_LANDMARK.LEFT_HIP, POSE_LANDMARK.RIGHT_HIP,
]);

/**
 * Is this skeleton readable enough to MEASURE from?
 *
 * The bar is BODY_TRACK_MIN_VISIBILITY, deliberately below the presence gate's
 * POSE_MIN_CONFIDENCE. The gate is deciding whether to spend a shopper's credits; this is
 * deciding whether a frame can be measured, and the frames it most needs - mid-rotation,
 * one shoulder occluded - are exactly the ones a go-live-grade bar throws away. Failing
 * this is NOT "no body": it means "not measurable this frame", which is what starts the
 * hold-and-resume path rather than a re-drape against a guess.
 * @param {Array<{x?:number,y?:number,visibility?:number}>|null|undefined} landmarks
 * @param {number} minVisibility
 * @returns {boolean}
 */
function torsoReadable(landmarks, minVisibility = BODY_TRACK_MIN_VISIBILITY) {
  if (!Array.isArray(landmarks) || !landmarks.length) return false;
  return TORSO_LANDMARKS.every((i) => {
    const lm = landmarks[i];
    return !!lm && Number.isFinite(lm.x) && Number.isFinite(lm.y) &&
      Number(lm.visibility ?? 0) >= minVisibility;
  });
}

/**
 * The angle, in degrees, by which a body segment has rotated OUT of the image plane.
 *
 * `inPlane` is the segment's extent across the image, `outOfPlane` its extent in depth.
 * asin(outOfPlane / length) is 0 when the segment lies flat across the camera and ±90
 * when it points straight at (or away from) it. Written this way rather than as
 * atan2(z, x) on purpose: atan2 answers 0 or 180 for a square-on subject depending on
 * which landmark index happens to sit on which side of the image, so a sign convention
 * change in a future MediaPipe release would silently invert it. This form only ever
 * depends on the RATIO, so 0 always means square-on.
 * @returns {number|null} null when the segment has no measurable length.
 */
function planarAngleDeg(inPlane, outOfPlane) {
  const len = Math.hypot(inPlane, outOfPlane);
  if (!(len > 1e-6)) return null;
  return Math.asin(Math.max(-1, Math.min(1, outOfPlane / len))) * (180 / Math.PI);
}

/**
 * Shoulder-line yaw: 0 = square to the camera, ±90 = fully edge-on. This is the channel
 * the ">15 degrees and the body is a different shape" rule reads, and it is a genuinely
 * 3D measurement - unlike the orientation watcher's silhouette-width heuristic, which
 * infers the same turn from a 96px canvas because it has no landmarks to work with.
 * @param {Array<{x:number,z?:number}>} pts world (or image) landmarks
 * @returns {number|null}
 */
function bodyYawDegrees(pts) {
  const L = pts && pts[POSE_LANDMARK.LEFT_SHOULDER], R = pts && pts[POSE_LANDMARK.RIGHT_SHOULDER];
  if (!L || !R) return null;
  return planarAngleDeg(R.x - L.x, (R.z ?? 0) - (L.z ?? 0));
}

/**
 * Torso pitch: the shoulder-to-hip axis leaning toward or away from the lens. 0 = upright
 * and square. Separate from yaw because leaning over a counter changes which part of the
 * garment faces the camera just as much as turning does, and the garment has to be
 * re-draped for it the same way.
 * @returns {number|null}
 */
function bodyPitchDegrees(pts) {
  if (!pts) return null;
  const ls = pts[POSE_LANDMARK.LEFT_SHOULDER], rs = pts[POSE_LANDMARK.RIGHT_SHOULDER];
  const lh = pts[POSE_LANDMARK.LEFT_HIP],      rh = pts[POSE_LANDMARK.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return null;
  const shoulderY = (ls.y + rs.y) / 2, hipY = (lh.y + rh.y) / 2;
  const shoulderZ = ((ls.z ?? 0) + (rs.z ?? 0)) / 2, hipZ = ((lh.z ?? 0) + (rh.z ?? 0)) / 2;
  return planarAngleDeg(shoulderY - hipY, shoulderZ - hipZ);
}

/**
 * Torso DEPTH as a fraction of torso height - the volumetric channel.
 *
 * The numerator is how much depth separates the four torso joints; the denominator is the
 * shoulder-to-hip distance, which normalises out both build and distance from the camera.
 * It rises when the shopper turns (depth replaces width) AND when real volume is added at
 * the waist (the hips move forward relative to the shoulders). Both are "the body this
 * garment is draped on is a different shape now", which is the only question being asked.
 * @returns {number|null}
 */
function bodyDepthRatio(pts) {
  if (!pts) return null;
  const torso = TORSO_LANDMARKS.map((i) => pts[i]);
  if (torso.some((p) => !p)) return null;
  const zs = torso.map((p) => Number(p.z ?? 0));
  if (zs.some((z) => !Number.isFinite(z))) return null;
  const shoulderY = (torso[0].y + torso[1].y) / 2, hipY = (torso[2].y + torso[3].y) / 2;
  const height = Math.abs(shoulderY - hipY);
  if (!(height > 1e-6)) return null;
  return (Math.max(...zs) - Math.min(...zs)) / height;
}

/**
 * The torso's profile bounding box in NORMALISED image coordinates, and its aspect.
 *
 * Normalised, so it is already resolution- and distance-independent. `aspect` (width over
 * height) is the silhouette channel: a square-on shopper is wide, a side-on one is narrow,
 * and a shopper who has gained profile volume is neither - which is why it is read
 * alongside depth rather than instead of it.
 * @returns {{w:number,h:number,aspect:number}|null}
 */
function bodyProfileBox(landmarks) {
  if (!Array.isArray(landmarks)) return null;
  const pts = TORSO_LANDMARKS.map((i) => landmarks[i]);
  if (pts.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (!(h > 1e-6)) return null;
  return { w, h, aspect: w / h };
}

/**
 * THE SPATIAL SCALE MATRIX - how wide and how long this body actually is.
 *
 * WHAT IT IS FOR. The garment has to sit tightly on a slender build and stretch
 * proportionally on a broad one, and the axis that decides which is WIDTH - shoulder
 * breadth, hip breadth, and how both relate to torso length. Every other measurement in
 * this module is about ORIENTATION (yaw, pitch) or DEPTH (the volume channel); none of
 * them can tell a narrow shopper from a wide one, because a narrow body and a wide body
 * at the same angle produce the same angles and very nearly the same depth ratio.
 *
 * TWO SCALE-INVARIANT DESCRIPTORS, and the invariance is the entire point. Raw widths in
 * metres or pixels conflate build with distance from the lens - a slim shopper standing
 * close measures wider than a broad one standing back - so neither raw number is
 * comparable to anything. Dividing by torso length removes it:
 *   · BUILD  = shoulder width / torso length. The headline narrow-vs-wide figure.
 *   · TAPER  = hip width / shoulder width. The shape between them, which BUILD cannot
 *              see: two people with identical shoulders and torsos, one straight and one
 *              much wider at the hip, are the same BUILD and a different garment problem.
 *              This is the descriptor that decides how a trouser waistband has to sit.
 *
 * IT IS A MEASUREMENT, NOT A COMMAND. Nothing here reaches the wire: Decart's realtime
 * set() accepts exactly { prompt, enhance, image } and strips every other key (verified
 * against @decartai/sdk@0.1.5's setInputSchema, z.core.$strip), so there is no payload
 * field a bounding box could be fed into even in principle. What this drives is WHEN to
 * re-condition - a build that no longer matches the one the current render was drawn for
 * is a re-drape, and the live frame is what carries the actual shape to Decart. The
 * prompt states the requirement ("narrow or wide"); this decides when to restate it.
 *
 * @param {Array} world  world (metric) landmarks - widths are only comparable in these
 * @param {Array} image  normalised image landmarks - the on-screen bounding box
 * @returns {{shoulderW:number, hipW:number, torsoLen:number, build:number, taper:number,
 *            box:{w:number,h:number,aspect:number}}|null}
 */
function bodyScaleMatrix(world, image) {
  const box = bodyProfileBox(image);
  if (!world || !box) return null;
  const ls = world[POSE_LANDMARK.LEFT_SHOULDER], rs = world[POSE_LANDMARK.RIGHT_SHOULDER];
  const lh = world[POSE_LANDMARK.LEFT_HIP],      rh = world[POSE_LANDMARK.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return null;
  /* Widths span x AND z, not x alone: a shopper at any angle other than square-on has
     part of their breadth pointing at the camera, and measuring only the on-screen
     component would read every turn as a body that suddenly got narrower. */
  const shoulderW = Math.hypot(rs.x - ls.x, (rs.z ?? 0) - (ls.z ?? 0));
  const hipW      = Math.hypot(rh.x - lh.x, (rh.z ?? 0) - (lh.z ?? 0));
  const torsoLen  = Math.abs(((ls.y + rs.y) / 2) - ((lh.y + rh.y) / 2));
  if (!(torsoLen > 1e-6) || !(shoulderW > 1e-6)) return null;
  return {
    shoulderW, hipW, torsoLen,
    build: shoulderW / torsoLen,
    taper: hipW / shoulderW,
    box,
  };
}

/**
 * One frame's body topology, or null when the frame cannot be measured.
 *
 * WORLD LANDMARKS FIRST, image landmarks as the fallback. worldLandmarks are metric and
 * hip-centred, which is what makes the angles real angles; the normalised image set
 * carries a z that is only roughly comparable to x, so the same formulas still produce a
 * usable CHANGE signal from it, just a less precise one. Visibility is always read off the
 * IMAGE set - worldLandmarks do not reliably carry it.
 * @param {{landmarks?:Array, worldLandmarks?:Array}|null} result a PoseLandmarker result
 * @returns {{yaw:number, pitch:number, depth:number, build:number, taper:number}|null}
 */
function bodyContourSignature(result, minVisibility = BODY_TRACK_MIN_VISIBILITY) {
  const image = result && Array.isArray(result.landmarks) ? result.landmarks[0] : null;
  if (!torsoReadable(image, minVisibility)) return null;
  const world = result && Array.isArray(result.worldLandmarks) && result.worldLandmarks[0]
    ? result.worldLandmarks[0] : image;
  const yaw = bodyYawDegrees(world), pitch = bodyPitchDegrees(world);
  const depth = bodyDepthRatio(world), scale = bodyScaleMatrix(world, image);
  if (yaw === null || pitch === null || depth === null || !scale) return null;
  return { yaw, pitch, depth, build: scale.build, taper: scale.taper };
}

/* Proportional change between two readings, guarded against a near-zero denominator so a
   ratio that legitimately passes through ~0 cannot manufacture an infinite delta. */
function relativeDelta(a, b) {
  const base = Math.max(Math.abs(a), Math.abs(b), 0.05);
  return Math.abs(b - a) / base;
}

/**
 * How far apart two topologies are, on four axes that answer four different questions:
 * has the subject TURNED (yaw), LEANED (pitch), changed BUILD (the width axis), or changed
 * VOLUME (the depth axis)?
 *
 * BUILD AND VOLUME ARE SEPARATE ON PURPOSE, and separating them is what this revision
 * added. They used to be one fused figure - depth OR the profile box's aspect - which
 * meant a genuinely wider body was reported as "volume", the same word used for a shopper
 * leaning in. They are different garment problems: volume is a cushion under a shirt, and
 * build is a different person's shoulders. The prompt now names the width axis explicitly
 * ("narrow or wide"), so the monitor has to be able to notice when it changes.
 *
 * BUILD FUSES ITS OWN TWO DESCRIPTORS by the LARGER of them: shoulder-to-torso, and the
 * hip-to-shoulder taper. Larger rather than averaged, for the same reason the old fused
 * figure took a max - they see different halves of the same event (a broader shopper moves
 * BUILD; a pear-shaped one at the same shoulder width moves only TAPER), and averaging
 * would let a strong signal on one be diluted by a quiet one on the other.
 *
 * THE MEASURES ARE NOT ALL THE SAME KIND, and that asymmetry is load-bearing. DEPTH is
 * compared ABSOLUTELY: it is already a normalised ratio on a bounded scale (~0 for a flat
 * square-on torso, ~1 edge-on) and it legitimately PASSES THROUGH ZERO, where any
 * proportional measure explodes - a shopper shifting their weight two degrees took the
 * depth ratio from 0.00 to 0.03, which is a 100% relative change and a nothing of an
 * absolute one. Reading it relatively fired a full image re-upload on standing still.
 * BUILD and TAPER are compared PROPORTIONALLY: they are ratios with no meaningful zero, so
 * "15% broader than the body this was drawn for" is the statement that means something.
 * @returns {{yaw:number, pitch:number, build:number, volume:number}}
 */
function topologyDelta(prev, next) {
  return {
    yaw:    Math.abs(next.yaw - prev.yaw),
    pitch:  Math.abs(next.pitch - prev.pitch),
    build:  Math.max(relativeDelta(prev.build, next.build),
                     relativeDelta(prev.taper, next.taper)),
    volume: Math.abs(next.depth - prev.depth),
  };
}

/**
 * Does this delta warrant re-draping? Returns the REASON rather than a boolean, because
 * the reason is what goes in the log line a live session gets diagnosed from.
 *
 * "LEAN" AND "VOLUME" ARE NOT CLEANLY SEPARABLE FROM FOUR JOINTS, and pretending otherwise
 * would be the dishonest version of this function. A torso that gains depth at the waist
 * also tilts the shoulder-to-hip axis in the model's own estimate, so added belly volume
 * most often reports as "lean". That is a LABELLING limit, not a detection gap: both
 * reasons produce the identical response - re-drape against the live frame - and the frame
 * is where the actual volume is visible. The reason string exists to make a console trace
 * readable, and it is ordered rotation → lean → volume so the strongest, most
 * unambiguous signal names the event.
 * @returns {"rotation"|"lean"|"volume"|null}
 */
function topologyShift(delta, rotationDeg = BODY_ROTATION_DELTA_DEG,
                       volumeDelta = BODY_VOLUME_DELTA, buildDelta = BODY_BUILD_DELTA) {
  if (delta.yaw    >= rotationDeg) return "rotation";
  if (delta.pitch  >= rotationDeg) return "lean";
  /* BUILD ahead of VOLUME. Both can move on one event, and the more specific name is the
     more useful one in a trace: "the body got wider" is actionable, "the body changed"
     is not. Rotation still outranks both, because a turn moves every channel at once and
     naming it anything else would be misleading. */
  if (delta.build  >= buildDelta)  return "build";
  if (delta.volume >= volumeDelta) return "volume";
  return null;
}

/**
 * The monitor's state machine.
 *
 * THE BASELINE IS "THE SHAPE THE CURRENT RENDER WAS CONDITIONED ON", not "the previous
 * frame". That is the single most important line in this file's new code: comparing
 * against the previous frame would mean a slow, continuous turn never trips anything at
 * all (each step is tiny), while a baseline that only moves when a re-drape is actually
 * dispatched accumulates drift until it matters. Standing still costs nothing; turning
 * gradually still fires, once, at the point the drape has genuinely gone stale.
 *
 * IT NEVER RE-BASES ON A QUIET FRAME, for the same reason.
 *
 * THE HOLD IS THE FALLBACK the spec asks for. An unreadable frame is not a new body: it
 * is no information. The tracker holds its baseline (and therefore the last valid fit -
 * nothing is dispatched, so nothing changes on screen) for BODY_TRACK_HOLD_MS, then gives
 * up and re-acquires from the next clean read. Past that point the shopper has been gone
 * long enough that startPresenceWatcher()'s own absent→present path owns the recovery, and
 * two re-conditioning dispatches for one event would be one too many - hence "dropped"
 * returns a fresh acquisition rather than a shift.
 *
 * COOLDOWN LIVES HERE, not at the call site, so the "did it move?" decision and the "may
 * we send?" decision cannot drift apart: a shift suppressed by the cooldown must NOT move
 * the baseline, or the movement it represents would be silently forgotten.
 *
 * @param {{rotationDeg?:number, volumeDelta?:number, cooldownMs?:number, holdMs?:number,
 *          now?:() => number}} [opts] injectable for tests
 */
function makeBodyTopologyTracker(opts = {}) {
  const rotationDeg = opts.rotationDeg ?? BODY_ROTATION_DELTA_DEG;
  const volumeDelta = opts.volumeDelta ?? BODY_VOLUME_DELTA;
  const buildDelta  = opts.buildDelta  ?? BODY_BUILD_DELTA;
  const cooldownMs  = opts.cooldownMs  ?? BODY_RECONDITION_COOLDOWN_MS;
  const holdMs      = opts.holdMs      ?? BODY_TRACK_HOLD_MS;
  const settleDeg   = opts.settleDeg   ?? BODY_SETTLE_DELTA_DEG;
  const settleMs    = opts.settleMs    ?? BODY_SETTLE_MS;
  const now         = opts.now         ?? (() => Date.now());
  /* The PREVIOUS sample, and when the body was last seen moving. Distinct from `baseline`
     on purpose: baseline answers "has it moved since the render?", these answer "is it
     moving right NOW?". See BODY_SETTLE_DELTA_DEG in config.js for why the difference is
     the whole fix. */
  let prevSig = null;
  let movingSince = null;

  let baseline = null;      // the topology the CURRENT render was conditioned against
  /* null while the skeleton is readable, otherwise the timestamp it went unreadable at.
     A null sentinel rather than 0, because 0 is a legitimate timestamp on an injected
     clock and a falsy-check would then restart the hold on every tick - reporting a hold
     that never ages and therefore never reaches its ceiling. */
  let lostAt = null;
  /* -Infinity, not 0: 0 is a real timestamp on any injected clock, and it would make the
     FIRST shift of a session look like one that had just been sent - swallowing it into a
     cooldown for a movement nothing had yet responded to. "Never signalled" is its own
     value, so it gets one. */
  let lastSignalAt = -Infinity;

  return {
    get baseline() { return baseline; },
    /* Called after something ELSE has re-conditioned the session (a presence re-entry, a
       garment swap): the render no longer corresponds to the stored baseline, so the next
       readable frame must establish a new one instead of being compared to a stale shape. */
    reset() { baseline = null; lostAt = null; prevSig = null; movingSince = null; },
    /**
     * @param {object|null} sig bodyContourSignature() for this frame, or null if unreadable
     * @param {{canDispatch?: boolean}} [gate] false when the wire cannot accept a write
     *        right now (see wireBusy). A shift found under a closed gate is reported as
     *        "deferred" and the baseline is NOT advanced, so the movement is re-offered on
     *        the next evaluation instead of being silently absorbed. This lives inside the
     *        tracker for the same reason the cooldown does: the "did it move?" decision and
     *        the "may we send?" decision must not be able to drift apart, and a baseline
     *        advanced for a write that never happened is exactly that drift.
     * @returns {{state:"waiting"|"acquired"|"stable"|"resumed"|"hold"|"dropped"|"cooldown"
     *            |"deferred"|"settling"|"shift", reason?:string, delta?:object,
     *            heldMs?:number, movingMs?:number}}
     */
    feed(sig, { canDispatch = true } = {}) {
      const t = now();
      if (!sig) {
        if (!baseline) return { state: "waiting" };
        if (lostAt === null) lostAt = t;
        if (t - lostAt >= holdMs) { baseline = null; lostAt = null; return { state: "dropped" }; }
        return { state: "hold", heldMs: t - lostAt };
      }
      const heldMs = lostAt === null ? 0 : t - lostAt;
      lostAt = null;

      /* INSTANTANEOUS motion, sample-to-sample - the "is it moving right NOW?" half, as
         opposed to `delta` below which asks "has it moved since the render?".

         MEASURED BEFORE THE BASELINE EARLY-RETURN, and that placement is load-bearing: the
         first readable sample returns "acquired" without ever reaching the code below, so
         seeding prevSig there would leave the FIRST MOVING sample with no motion history.
         It would read as still, clear the settle gate, and dispatch - one re-drape at the
         very start of every turn, which is precisely the case this gate exists to stop.

         Rotation axes only (yaw/pitch). Build and volume are proportions, not angles; they
         do not sweep continuously the way a turn does, and holding a genuine build change
         hostage to an unrelated stillness clock would delay the one kind of re-drape that
         has no other trigger. */
      if (prevSig) {
        const step = topologyDelta(prevSig, sig);
        if (Math.max(step.yaw, step.pitch) >= settleDeg) movingSince = t;
      }
      prevSig = sig;

      if (!baseline) { baseline = sig; return { state: "acquired" }; }

      const delta = topologyDelta(baseline, sig);
      const reason = topologyShift(delta, rotationDeg, volumeDelta, buildDelta);
      /* Back in view and still the same shape: the hold did its job, the fit that was
         held is still the right one, and nothing needs to be sent. */
      if (!reason) return { state: heldMs ? "resumed" : "stable", delta, heldMs };
      if (t - lastSignalAt < cooldownMs) return { state: "cooldown", reason, delta, heldMs };
      /* ── SETTLE BEFORE DISPATCH ────────────────────────────────────────────
         Ordered AFTER the cooldown and BEFORE canDispatch deliberately. After the
         cooldown, because a rate-limited shift has nothing to settle for yet. Before the
         wire gate, because "still moving" is a fact about the BODY and should read that
         way in a trace even when the wire happens to be busy at the same instant.

         Like "cooldown" and "deferred", this does NOT advance the baseline - the movement
         is re-offered on the next evaluation, so nothing is lost by waiting for the turn
         to finish. That is what makes this a debounce rather than a filter. */
      if (movingSince !== null && t - movingSince < settleMs) {
        return { state: "settling", reason, delta, heldMs, movingMs: t - movingSince };
      }
      if (!canDispatch) return { state: "deferred", reason, delta, heldMs };
      lastSignalAt = t;
      baseline = sig;
      /* The reason is tagged when it arrives out of a hold, because "they turned" and
         "they turned while we could not see them" are different stories in a log. */
      return { state: "shift", reason: heldMs ? `${reason}-after-hold` : reason, delta, heldMs };
    },
  };
}

/* MediaPipe's VIDEO running mode rejects a timestamp that is not strictly greater than
   the last one it saw, and it throws rather than returning empty. performance.now() is
   monotonic but not strictly increasing - two calls inside the same millisecond return
   the same value - so every detectForVideo() in this file goes through here. It costs one
   comparison and removes an entire class of "Packet timestamp mismatch" session failure. */
let _lastPoseTimestamp = 0;
function detectPoseFrame(detector, video) {
  const ts = Math.max(performance.now(), _lastPoseTimestamp + 1);
  _lastPoseTimestamp = ts;
  return detector.detectForVideo(video, ts);
}

/* The loaded PoseLandmarker, as a memoized PROMISE - so N callers during preload share
   one download, and a second call never restarts it. Resolves to null on every failure. */
let _poseLandmarkerPromise = null;

/**
 * Load MediaPipe Tasks Vision. NEVER throws, NEVER rejects - resolves to null instead,
 * because every caller's correct response to "no detector" is to carry on without one.
 * @returns {Promise<object|null>}
 */
function loadPoseLandmarker() {
  if (_poseLandmarkerPromise) return _poseLandmarkerPromise;
  _poseLandmarkerPromise = (async () => {
    if (typeof _testDetector !== "undefined" && _testDetector) return _testDetector;
    try {
      /* Dynamic import of a CDN ES module: the only way to add this without a bundler,
         and it keeps the bytes off the initial page load entirely. */
      const vision = await import(/* webpackIgnore: true */ POSE_TASKS_MODULE);
      const fileset = await vision.FilesetResolver.forVisionTasks(POSE_WASM_BASE);
      return await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    } catch (e) {
      console.warn("[PEAR] pose detector unavailable, falling back to native presence:", e?.message || e);
      return null;
    }
  })();
  return _poseLandmarkerPromise;
}

/* Fire-and-forget warm-up. Called once the shopper is in the fitting room, which is
   typically many seconds before they press go-live - so by the time the gate needs the
   detector it is already resident, and the critical path pays nothing. */
function preloadPoseDetector() {
  /* Either consumer is reason enough to warm it: the gate needs it at go-live, and the
     topology monitor needs it for the whole session after that. Warming for one and not
     the other would put a multi-MB WASM download on the live path for whichever flag
     happened to be off. */
  if (!POSE_GATE_ENABLED && !BODY_TOPOLOGY_ENABLED) return;
  loadPoseLandmarker().catch(() => {});   // .catch is belt-and-braces; it never rejects
}

/* ── The native fallback ──────────────────────────────────────────────────────
   Reuses the SAME browser primitive the orientation watcher already runs (see
   ORIENT_FACE_SIZE) - no new dependency, nothing extra to download. It cannot see hips,
   so it answers the weaker question "is a person there at all". For a TOP that is very
   nearly the same question. For BOTTOMS it genuinely is not, and that is stated rather
   than papered over: a face-only pass on a trousers item is treated as unknown, so the
   gate proceeds rather than pretending it verified something it cannot see. */
async function nativePresenceFallback(video, category) {
  if (typeof FaceDetector === "undefined") return null;
  try {
    const det = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await det.detect(video);
    if (!faces || !faces.length) return false;
    return category === "bottom" ? null : true;
  } catch (_) {
    return null;
  }
}

/**
 * Wait until a body is actually in frame, or until the gate times out.
 *
 * ALWAYS RESOLVES, and resolves TRUTHY on timeout. Read that as the design rule it is:
 * this function may delay a session, and may never refuse one. A shopper who cannot be
 * detected - unusual lighting, a wheelchair user the model reads poorly, a browser with
 * no WebAssembly - still gets their try-on.
 *
 * @param {boolean} isBottoms - drives which landmarks are required
 * @returns {Promise<"present"|"timeout"|"skipped">}
 */
async function awaitBodyPresence(isBottoms) {
  if (!POSE_GATE_ENABLED) return "skipped";
  const video = $("webcam");
  if (!video) return "skipped";
  const category = isBottoms ? "bottom" : "top";
  const detector = await loadPoseLandmarker();
  const gate = makePresenceGate();
  const startedAt = Date.now();
  let shownOverlay = false;

  try {
    while (Date.now() - startedAt < POSE_GATE_TIMEOUT_MS) {
      let verdict = null;
      if (detector && video.videoWidth) {
        try {
          verdict = presenceFromPoseResult(detectPoseFrame(detector, video), category);
        } catch (e) {
          console.warn("[PEAR] pose detect failed, degrading:", e?.message || e);
          verdict = null;
        }
      }
      if (verdict === null) verdict = await nativePresenceFallback(video, category);
      /* Still unknown after both engines: nothing here can judge this frame, so waiting
         longer cannot help. Proceed immediately rather than burning the full timeout on
         a question no available detector can answer. */
      if (verdict === null) {
        console.log("[PEAR] presence gate: no usable detector - proceeding without it");
        return "skipped";
      }
      if (gate.feed(verdict === true)) {
        if (shownOverlay) hidePresenceOverlay();
        console.log(`[PEAR] presence gate: confirmed after ${Date.now() - startedAt}ms (${category})`);
        return "present";
      }
      if (!shownOverlay) { showPresenceOverlay(); shownOverlay = true; }
      await new Promise((r) => setTimeout(r, POSE_SAMPLE_MS));
    }
    /* TIMED OUT - and we PROCEED. The shopper asked for a session; a detector that
       cannot find them is not grounds to refuse one. */
    console.warn(`[PEAR] presence gate: timed out after ${POSE_GATE_TIMEOUT_MS}ms - proceeding anyway`);
    return "timeout";
  } finally {
    if (shownOverlay) hidePresenceOverlay();
  }
}

function showPresenceOverlay() {
  const el = $("presenceOverlay");
  if (el) el.hidden = false;
}
function hidePresenceOverlay() {
  const el = $("presenceOverlay");
  if (el) el.hidden = true;
}

/* ── Late entry: re-condition, never re-bill ──────────────────────────────────
   The gate above covers the START of a session. This covers the shopper who drifts out
   of shot and steps back in DURING one - the garment should re-fit the moment they are
   visible again, not stay broken for the rest of the window.

   IT MUST NOT TOUCH BILLING, and that is the whole reason this is its own function
   rather than a call to the go-live path. liveDurationTimer / startBillingWindow() arm
   the LIVE_DURATION_MS cap; re-arming either on a presence event would bill a second
   full session every time somebody stepped in and out. So this re-sends conditioning
   into the window ALREADY RUNNING, and touches nothing else.

   It reuses applyActive() and the same `applying` mutex maybeReanchorPrompt() uses, for
   the same reason: a swap or a profile transition may already own the wire. */
let presenceWatcherTimer = null;
/* The live tracker instance, kept at module scope only so teardown can drop it. Its state
   is per-session by construction: startPresenceWatcher() builds a new one each time. */
let bodyTopology = null;

/**
 * THE SESSION'S SINGLE POSE SAMPLER, feeding two independent consumers off ONE inference.
 *
 *   · PRESENCE (unchanged): did the shopper leave the frame, and did they come back?
 *     Answers with the go-live-grade landmark bar and re-conditions on re-entry.
 *   · TOPOLOGY (new): has the BODY this render was draped on actually changed shape -
 *     rotated past BODY_ROTATION_DELTA_DEG, leaned, or gained profile volume? See the
 *     CONTINUOUS BODY TOPOLOGY block above for why that question has to be asked every
 *     frame rather than once at go-live.
 *
 * ONE detectForVideo() PER TICK IS THE POINT. These were nearly built as two loops, and
 * that would have been wrong twice over: a second BlazePose inference per tick on a phone
 * is real battery and thermal cost for a question the first inference already answered,
 * and two callers racing the same landmarker can land on the same performance.now()
 * millisecond, which MediaPipe rejects outright (see detectPoseFrame).
 *
 * EACH HALF DEGRADES INDEPENDENTLY. A null presence verdict (no usable reading) skips the
 * presence half without touching the streak - the pre-existing behaviour - and the
 * topology half still runs, because "cannot judge presence" and "cannot measure shape"
 * are different failures with different bars.
 */
function startPresenceWatcher() {
  if ((!POSE_GATE_ENABLED && !BODY_TOPOLOGY_ENABLED) || presenceWatcherTimer) return;
  const video = $("webcam");
  if (!video) return;
  const category = isBottomsGarment(activeItem) ? "bottom" : "top";
  const gate = makePresenceGate();
  let wasPresent = true;      // the go-live gate just confirmed presence
  let inFlight = false;
  let lastTopologyAt = 0;
  bodyTopology = BODY_TOPOLOGY_ENABLED ? makeBodyTopologyTracker() : null;

  /* ── THE LOOP RATE IS THE PRESENCE RATE, UNCHANGED ────────────────────────────
     An earlier revision sped this loop up to BODY_TOPOLOGY_SAMPLE_MS so the topology
     monitor would catch a turn sooner. That was the wrong lever: it raised the rate of
     the MediaPipe inference - the expensive part, on the same thread that has to service
     the WebRTC datachannel - for the benefit of the cheap part, the arithmetic on four
     landmarks. The loop is back on the presence cadence it has always used, and the
     topology consumer is throttled INDEPENDENTLY below (~3/s, its own elapsed check), so
     re-evaluations can never outpace what the wire can absorb. Net effect: the inference
     load is exactly what it was before the monitor existed. */
  const tickMs = POSE_SAMPLE_MS * 2;

  presenceWatcherTimer = setInterval(async () => {
    if (inFlight || !isLive()) return;
    /* ── NO INFERENCE THE SHOPPER CANNOT SEE THE RESULT OF ─────────────────────
       detectForVideo() is a WASM/GPU pass on the main thread - the same thread that
       services the WebRTC datachannel and paints the UI - and it is the single most
       expensive thing this loop does. On a hidden tab its two consumers are both moot:
       nobody is looking at a presence overlay, and a body whose topology changed while
       the tab was backgrounded is re-measured on the first visible tick anyway (the
       tracker holds its baseline, then re-offers the shift). Skipping is free, and it
       stops a backgrounded session from competing with the foreground page for the
       thread that has to keep the stream flowing. */
    if (typeof document !== "undefined" && document.hidden) return;
    inFlight = true;
    try {
      const detector = await loadPoseLandmarker();
      if (!detector || !video.videoWidth) return;
      let result;
      try { result = detectPoseFrame(detector, video); } catch (_) { return; }
      const now = Date.now();

      /* ── Consumer zero: THE GUARD BOUNDARY ──────────────────────────────────
         Off landmarks that have already been computed - one extra read per tick, no extra
         inference. DELIBERATELY OUTSIDE the consumer blocks below, and outside any debug
         gate, because the non-target guard must keep tracking the body whether or not
         presence and topology happen to be enabled.

         ⚠️ THIS LINE IS THE FEATURE. Its previous call site was inside
         armFirstFrameBilling()'s `if (frameTimingDebug)` block, against a `result` that
         does not exist in that scope - so it never ran, bodyGuardLine stayed null forever,
         and the guard silently spent three bug reports running on the fixed-fraction
         fallback that config.js had already predicted would fail. updateBodyGuardLine()
         returns silently on anything it cannot read, by design, which means a wrong call
         site produces no error anywhere - only a guard that is quietly worse than the one
         that was specified. If this moves, it moves to somewhere a real pose `result`
         lives. */
      updateBodyGuardLine(result);

      /* ── Consumer one: presence ─────────────────────────────────────────────
         A null verdict still means "cannot judge this frame" and still leaves the streak
         untouched, exactly as before - it is now a skipped BLOCK rather than an early
         return, so it no longer takes the topology half down with it. */
      if (POSE_GATE_ENABLED) {
        const verdict = presenceFromPoseResult(result, category);
        if (verdict !== null) {
          const present = gate.feed(verdict === true);
          if (present && !wasPresent) {
            wasPresent = true;
            hidePresenceOverlay();
            await reconditionForPresence();
            /* That dispatch re-conditioned the render, so whatever shape the tracker was
               holding is no longer the shape on screen. Re-acquire rather than compare the
               next frame against a baseline the render has already moved off. */
            if (bodyTopology) bodyTopology.reset();
          } else if (!present && wasPresent && verdict === false) {
            wasPresent = false;
            showPresenceOverlay();
          }
        }
      }

      /* ── Consumer two: body topology ────────────────────────────────────────
         Only "shift" dispatches. "hold" is the fallback for a body that went unreadable
         mid-rotation and is deliberately silent - holding the last valid fit IS sending
         nothing - and "cooldown" is a shift the rate limit swallowed, which the tracker
         remembers so the movement is not lost. */
      if (bodyTopology && now - lastTopologyAt >= BODY_TOPOLOGY_SAMPLE_MS) {
        lastTopologyAt = now;
        /* THE GATE, evaluated here and passed IN. A shift found while the wire is busy
           must not advance the tracker's baseline, or the movement would be absorbed by a
           dispatch that never happened - see feed()'s own note. */
        const step = bodyTopology.feed(bodyContourSignature(result), { canDispatch: !wireBusy() });
        if (step.state === "shift") await reconditionForTopology(step);
        else if (ORIENT_DEBUG && step.state !== "stable") {
          console.log(`[PEAR][TOPOLOGY] ${step.state}` +
            (step.heldMs ? ` (held ${step.heldMs}ms)` : "") +
            (step.movingMs !== undefined ? ` (still moving, ${step.movingMs}ms quiet)` : "") +
            (step.reason ? ` | ${step.reason} held back` : ""));
        }
      }
    } finally {
      inFlight = false;
    }
  }, tickMs);
}

function stopPresenceWatcher() {
  if (presenceWatcherTimer) { clearInterval(presenceWatcherTimer); presenceWatcherTimer = null; }
  bodyTopology = null;        // a new session measures a new body from scratch
  hidePresenceOverlay();
}

/* Re-send the conditioning for the CURRENT garment into the window already running.

   Guarded on the same three conditions maybeReanchorPrompt() uses - not mid-send, still
   live, and something has actually been dressed already (re-asserting steering before
   the first frame would race the applyActive() goLive() is still awaiting).

   ON THE MUTEX, honestly: the orientation watcher's `applying` flag is a CLOSURE local
   inside syncOrientationWatcher(), not reachable from here, so this cannot share it.
   That leaves a narrow window where a re-anchor and a presence re-condition could both
   send. Both send the SAME payload for the same garment, so the outcome is a redundant
   set() rather than a wrong one - the same benign collision the re-anchor and the
   profile update already tolerate between themselves. Hoisting one real mutex for all
   three send sites is the right fix and is deliberately NOT bundled into this change. */
let presenceReconditionInFlight = false;

async function reconditionForPresence() {
  if (presenceReconditionInFlight || !isLive() || !isGarmentApplied) return;
  /* The shared mutex the comment above used to say was missing. Presence is re-sampled
     every tick, so a deferred re-condition is re-offered ~200ms later - cheaper than
     queueing a write behind one that is already going to re-condition this session. */
  if (wireBusy()) return;
  presenceReconditionInFlight = true;
  try {
    console.log(`[PEAR] presence regained at t=${sessionElapsedMs()}ms - re-conditioning (no re-bill)`);
    await applyActive();
  } catch (e) {
    console.warn("[PEAR] presence re-condition failed:", e?.message || e);
  } finally {
    presenceReconditionInFlight = false;
  }
}

/* ── Re-drape on the CURRENT body contour ─────────────────────────────────────
   The dispatch half of the topology monitor. Its sibling above answers "they came back";
   this answers "they are a different shape than the garment was drawn for".

   WHY THIS FORCES A FULL set() RATHER THAN A setPrompt(). The prompt is constant per
   category, so applyGarment()'s no-op skip is not an optimisation here - it is the whole
   obstacle. With the reference already on the wire and the prompt byte-identical, a
   re-anchor sends NOTHING, which is precisely why re-asserting text could never fix the
   stretched-garment report: there was no dispatch, so the model never re-read the body.
   Clearing the three wire-state fields is the documented way to force a real one (it is
   exactly what __pearDebugReinjectGarment does, and what applyGarment's own comment
   prescribes for this case: "the fix is to make the re-anchor force a full re-upload").
   What Decart then receives is the invariant garment reference against a LIVE frame that
   now shows the new contour - which is a re-drape, not a re-warp of the old one.

   THE COST IS REAL AND IS BOUNDED DELIBERATELY. A full set() re-uploads the packshot
   inside a billed window, and applyGarment's flicker-fix comment records that swapping
   the reference mid-rotation is itself capable of making a print flicker. Three things
   keep that in hand: BODY_RECONDITION_COOLDOWN_MS (~5 dispatches per 5s session at
   worst), the tracker only firing on movement that actually cleared a threshold, and the
   guard below.

   NEVER DURING A FRONT/BACK SWAP. _orientHoldActive means the orientation watcher has
   frozen the view and is mid-swap of the reference ITSELF; that path already re-applies
   the whole payload when it lands, so firing here would both collide with it and
   re-upload an asset that is about to be replaced. Skipping is free - the tracker keeps
   the movement in its baseline and the next tick re-offers it.

   SAME UN-SHARED-MUTEX CAVEAT as reconditionForPresence(): the watcher's `applying` flag
   is a closure local. A collision sends the same payload twice, never a wrong one. */
let topologyReconditionInFlight = false;

async function reconditionForTopology(step) {
  if (topologyReconditionInFlight || !isLive() || !isGarmentApplied) return;
  if (_orientHoldActive) return;
  /* THE SHARED MUTEX, and this is the send site that made hoisting it urgent: this one
     forces a full image re-upload, so stacking it on an in-flight write is the most
     expensive collision available.
     BELT AND BRACES, not the primary guard. The primary one is the `canDispatch` gate the
     sampler passes INTO the tracker, which is what keeps a declined shift from advancing
     the baseline - by the time a shift reaches this function the tracker has already
     committed to it, so declining here does lose that one movement. Reaching this branch
     therefore means a caller skipped the gate; it is here so that mistake degrades to a
     missed re-drape rather than to a collision on the wire. */
  if (wireBusy()) {
    console.log("[PEAR] body-contour re-drape deferred: a conditioning write is in flight");
    return;
  }
  topologyReconditionInFlight = true;
  /* RAISED BEFORE ANYTHING IS SENT, and before the three wire-state fields below are
     cleared: at this instant #aiVideo still carries a correctly dressed frame, and that is
     precisely the frame worth holding. A cover raised after the re-upload is in flight
     would snapshot the generic-garment frame it exists to hide - the same mistake the
     front/back hold made before it was moved to the first disagreeing vote. */
  const covered = redrapeCoverBegin();
  try {
    const d = step.delta || {};
    console.log(`[PEAR] body contour changed (${step.reason}) at t=${sessionElapsedMs()}ms` +
      ` - re-draping the SAME garment on the CURRENT frame (no re-bill)` +
      ` | Δyaw=${(d.yaw ?? 0).toFixed(1)}° Δpitch=${(d.pitch ?? 0).toFixed(1)}°` +
      ` Δbuild=${((d.build ?? 0) * 100).toFixed(0)}%` +
      ` Δvolume=${((d.volume ?? 0) * 100).toFixed(0)}%` +
      (step.heldMs ? ` | resumed after a ${step.heldMs}ms tracking hold` : ""));
    /* All three, for the reason debugReinjectGarment() clears all three: the first two
       bypass the "same image already on the wire" shortcut, the third gets past the
       "...and the prompt is unchanged too" no-op skip sitting in front of it. */
    lastSentImageRef = null;
    rtImageOnWire = false;
    lastSentPrompt = null;
    await applyActive();
    /* THE GRACE PERIOD, for the same reason maybeSwap() takes one after its own set():
       applyActive() resolving means Decart ACKNOWLEDGED the new conditioning, not that a
       frame rendered from it has arrived and decoded. Revealing on the acknowledgement
       alone uncovers the last few frames of the OLD conditioning - a brief flash of
       exactly what the cover was raised to hide. Skipped when no cover went up, because
       then this is just latency added to a re-drape nobody is waiting on. */
    if (covered) {
      const why = await nextPresentedFrame($("aiVideo"), ORIENT_FADE_HOLD_MS);
      if (ORIENT_DEBUG) console.log("[PEAR] body re-drape - cover released on", why);
    }
  } catch (e) {
    console.warn("[PEAR] body-contour re-condition failed:", e?.message || e);
  } finally {
    /* In the finally, not after the await: a rejected applyActive() must still reveal the
       live feed. Holding a still over a failed re-drape is the one outcome worse than the
       flicker - the shopper is then frozen out of their own session with no recovery. */
    redrapeCoverEnd("re-drape settled");
    topologyReconditionInFlight = false;
  }
}
/* ── end body-presence gate ── */

let lowerBodyGuardRAF = null;
/* The LIVE value the paint loop actually reads, distinct from the static
   LOWER_BODY_GUARD_FRAC config constant it starts equal to. calibrateLowerBodyGuard()
   (below) updates THIS, never the config constant - the config value stays the fallback
   for when calibration is off, unavailable, or hasn't found a face yet. Reset to the
   static default in stopLowerBodyGuard() so a new session never inherits a previous
   one's calibration (different shopper, different distance from the camera). */
let lowerBodyGuardFrac = LOWER_BODY_GUARD_FRAC;

/* ══════════════════════════════════════════════════════════════════════════════
   THE NON-TARGET REGION GUARD - the only HARD zero-invention guarantee available
   ══════════════════════════════════════════════════════════════════════════════
   REPORTED: trying on a SHIRT, the shopper lifts a leg into frame wearing light blue
   shorts, and Decart renders black long trousers over it. The prompt forbids exactly this
   in words ("pass through and strictly preserve the subject's LIVE camera feed clothing"),
   and words are a probabilistic bias on a diffusion model, not a guarantee. Decart's
   realtime set() exposes { prompt, enhance, image } and NO mask channel, so there is no
   way to protect a region on the server - it cannot be told "leave these pixels alone".

   THIS IS WHERE IT CAN BE MADE ABSOLUTE, and it is the only place: composite the shopper's
   OWN untouched camera pixels back over the non-target region, in the browser, after the
   frame comes back. Whatever Decart invented below the waist never reaches the screen.

   ── THE NAMES SAY "LOWER BODY"; THE BEHAVIOUR IS "WHICHEVER REGION IS NOT BEING FITTED" ──
   The DOM id (#lowerBodyGuard), the CSS class and these function names are historical -
   the feature was built for tops only, where the non-target region is always the lower
   body. It is category-aware now: a BOTTOMS try-on guards the UPPER body instead, because
   a shopper who steps back during a trousers session gets an invented shirt by the exact
   same mechanism. The names were left alone deliberately - they are stable identifiers
   with history in three files - so read guardedRegion() for what actually happens.

   ── THE BOUNDARY IS THE SHOPPER'S OWN HIP LINE ──────────────────────────────────
   Not a fraction of frame height. config.js records why the feature shipped disabled: a
   fixed fraction is "a GUESS calibrated to nothing about the actual shopper" that could
   "clip into the bottom of a correctly-rendered SHIRT". MediaPipe Pose - taken on for the
   presence gate, now running continuously for the topology monitor - reports the hips, so
   the boundary is re-read live from the body it is actually guarding. BODY_GUARD_MARGIN_FRAC
   pushes it clear of a hem that overhangs the line. The static fraction remains the
   fallback for frames where no pose reading is available; guarding on a rough boundary
   beats not guarding at all, now that the failure it prevents is reproduced. */

/* The live hip line as a fraction of frame height from the TOP, or null when the current
   frame yielded no usable reading. Written by the pose loop, read by three paint paths. */
let bodyGuardLine = null;
/* Torso length in the same normalised units, for scaling the margin. */
let bodyGuardTorso = null;

/**
 * Update the guard boundary from a PoseLandmarker result. Called once per pose tick, on
 * the loop that was already running - this costs one more read of landmarks that have
 * already been computed, not another inference.
 * @param {{landmarks?:Array}|null} result
 * @returns {void}
 */
function updateBodyGuardLine(result) {
  const lm = result && Array.isArray(result.landmarks) ? result.landmarks[0] : null;
  if (!torsoReadable(lm)) return;            // keep the last good line rather than guessing
  const ls = lm[POSE_LANDMARK.LEFT_SHOULDER], rs = lm[POSE_LANDMARK.RIGHT_SHOULDER];
  const lh = lm[POSE_LANDMARK.LEFT_HIP],      rh = lm[POSE_LANDMARK.RIGHT_HIP];
  const hipY = (lh.y + rh.y) / 2, shoulderY = (ls.y + rs.y) / 2;
  if (!Number.isFinite(hipY) || !Number.isFinite(shoulderY)) return;
  bodyGuardLine = Math.min(1, Math.max(0, hipY));
  bodyGuardTorso = Math.abs(hipY - shoulderY);
}

/** Which half of the body must NOT be synthesised for the active garment. */
function guardedRegion() {
  return isBottomsGarment(activeItem) ? "upper" : "lower";
}

/**
 * The band of the frame to restore from the live camera, in pixels.
 *
 * PREFERS THE LIVE HIP LINE, falls back to the static/face-calibrated fraction. The margin
 * always pushes AWAY from the region being fitted - down for a tops try-on so a long shirt
 * hem is never clipped, up for a bottoms try-on so a high waistband is not.
 * @param {number} h frame height in pixels
 * @returns {{y0:number, y1:number, source:"pose"|"fraction"}|null} null = guard nothing
 */
function guardBand(h) {
  const region = guardedRegion();
  const margin = (bodyGuardTorso || 0) * BODY_GUARD_MARGIN_FRAC;
  if (bodyGuardLine !== null) {
    const line = region === "lower"
      ? Math.min(1, bodyGuardLine + margin)     // guard BELOW the hips, pushed down
      : Math.max(0, bodyGuardLine - margin);    // guard ABOVE the hips, pushed up
    const y = Math.round(h * line);
    return region === "lower"
      ? { y0: y, y1: h, source: "pose" }
      : { y0: 0, y1: y, source: "pose" };
  }
  /* No pose reading yet. The static fraction only ever described a LOWER band, so it is
     the fallback for that region alone - inventing an upper-body equivalent out of the
     same number would be a guess about a guess, and for bottoms the un-guarded failure is
     the one this feature has no report for yet. */
  if (region !== "lower") return null;
  const y = Math.round(h * (1 - lowerBodyGuardFrac));
  return { y0: y, y1: h, source: "fraction" };
}

/**
 * Composite the shopper's real camera pixels over the non-target band of a destination
 * context. Shared by all three paths that must agree: the on-screen guard canvas, the
 * recorder, and the final frozen frame.
 *
 * THE SELFIE-MIRROR CORRECTION IS THE SUBTLE PART. #webcam's DECODED frame is never
 * mirrored - only its CSS display is - while #aiVideo comes back from Decart already
 * correctly oriented. Drawing the webcam raw would composite a mirror-flipped band under a
 * correctly-oriented one: buttons, pockets and prints landing on the wrong side at the
 * seam. This is the same translate+scale freezeFinalFrame() uses for its own webcam
 * fallback, applied to the guarded band alone.
 * @returns {boolean} true if a band was painted
 */
/* How many slices the alpha ramp is drawn in - see BODY_GUARD_FEATHER_FRAC. */
const GUARD_FEATHER_SLICES = 14;

/**
 * Where the guard's pixels come from, and whether they need the selfie flip.
 *
 * PREFERS THE INPUT THROTTLE'S OWN CANVAS - the frames actually being sent to Decart.
 * #webcam is the obvious source and is the wrong one: it is visibility:hidden for all of
 * .show-live while createThrottledInputStream() calls applyConstraints() on a clone of the
 * same device track, re-negotiating the shared source underneath it. Drawing from it
 * produced the reported BLACK BAND. The throttle canvas cannot be blank while there is a
 * session to guard, and it is already cover-fitted and mirrored into the geometry Decart
 * returns, so it needs no correction.
 *
 * #webcam stays as the fallback for the paths that run with no throttle, where its
 * unmirrored DECODED frame still needs the flip - which is why mirroring is a property of
 * the SOURCE here rather than something applied unconditionally.
 * @returns {{src:CanvasImageSource,w:number,h:number,mirror:boolean}|null}
 */
function guardSource() {
  const cv = inputThrottle && inputThrottle.canvas;
  if (cv && cv.width > 0 && cv.height > 0) {
    return { src: cv, w: cv.width, h: cv.height, mirror: false };
  }
  const webcam = $("webcam");
  if (webcam && webcam.videoWidth > 0) {
    return { src: webcam, w: webcam.videoWidth, h: webcam.videoHeight, mirror: true };
  }
  return null;
}

function paintGuardBand(ctx, w, h) {
  if (!LOWER_BODY_GUARD_ENABLED || !ctx) return false;
  const source = guardSource();
  if (!source) return false;
  const dst = guardBand(h);
  if (!dst || dst.y1 <= dst.y0) return false;
  /* SOURCE AND DESTINATION BANDS ARE COMPUTED INDEPENDENTLY, and that is not pedantry:
     the source surface's resolution and the destination canvas's are routinely different -
     the recorder sizes itself to #aiVideo, the frozen frame to whatever Decart returned -
     so reusing one offset for both silently misaligns the composited band on any camera
     whose aspect or scale does not happen to match. Each band is a fraction of ITS OWN
     surface's height. */
  const src = guardBand(source.h);
  if (!src || src.y1 <= src.y0) return false;

  const dstH = dst.y1 - dst.y0, srcH = src.y1 - src.y0;
  const scale = srcH / dstH;                   // source rows per destination row
  const lower = guardedRegion() === "lower";
  /* Clamped to the band's own height: a very short band must not feather past its far side
     and start letting Decart's invention back into the region this exists to protect. */
  const feather = Math.max(0, Math.min(Math.round(h * BODY_GUARD_FEATHER_FRAC), dstH));

  ctx.save();
  /* THE SELFIE-MIRROR CORRECTION, applied only to the source that needs it. #webcam's
     DECODED frame is never mirrored - only its CSS display is - while the throttle canvas
     was mirrored when it was painted. Drawing an unmirrored webcam raw would composite a
     flipped band under a correctly-oriented one: buttons, pockets and prints landing on
     the wrong side of the seam. */
  if (source.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  /* One destination row range, drawn from the source rows that correspond to it. Every
     draw in this function goes through here so the source mapping is written once. */
  const slice = (dy0, dy1, alpha) => {
    if (dy1 <= dy0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(source.src,
      0, src.y0 + (dy0 - dst.y0) * scale, source.w, (dy1 - dy0) * scale,
      0, dy0,                             w,        dy1 - dy0);
  };
  try {
    // The opaque core: everything past the ramp, at full strength.
    if (lower) slice(dst.y0 + feather, dst.y1, 1);
    else       slice(dst.y0, dst.y1 - feather, 1);
    // The ramp: alpha 0 at the boundary climbing to 1 where the core begins.
    for (let i = 0; i < GUARD_FEATHER_SLICES && feather > 0; i++) {
      const a0 = i / GUARD_FEATHER_SLICES, a1 = (i + 1) / GUARD_FEATHER_SLICES;
      const y0 = lower ? dst.y0 + feather * a0 : dst.y1 - feather * a1;
      const y1 = lower ? dst.y0 + feather * a1 : dst.y1 - feather * a0;
      slice(y0, y1, (a0 + a1) / 2);
    }
  } catch (_) {
    /* best-effort: a failed guard paint must never fail the frame it was protecting */
    ctx.restore();
    return false;
  }
  ctx.restore();
  return true;
}

/* ── Auto-calibration - one reading per session, not a guess held forever ──────────
   THE GAP THIS CLOSES: LOWER_BODY_GUARD_FRAC is one fixed number for every shopper at
   every distance from the camera. Standing close, the real waist line sits far higher
   in frame than a 34%-from-bottom guess; standing back, far lower - "if the user moves
   the suit is still visible" is exactly this, restated.

   THE METHOD: FaceDetector (Shape Detection API) - the SAME browser primitive the
   orientation watcher already uses elsewhere in this file (see ORIENT_FACE_SIZE), so
   this adds no new dependency, not the multi-MB WASM segmentation model this file has
   already declined once. A face box plus a standard figure-drawing proportion (a
   person's waist sits roughly LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS head-heights below
   the crown) gives an ESTIMATED waist line calibrated to how THIS shopper is actually
   framed, instead of one number guessed for everyone.

   STILL A HEURISTIC - said plainly, not oversold. It assumes an adult, upright, roughly
   front-facing posture at the moment it samples; it degrades to the static
   LOWER_BODY_GUARD_FRAC whenever no face is found, the browser lacks FaceDetector, or
   the shopper is turned away. It runs ONCE, at go-live, not every frame - recalculating
   continuously would make the guard line visibly JITTER as a head naturally bobs,
   trading one visible defect for another. Fire-and-forget from its caller: it updates
   lowerBodyGuardFrac in the background, and the paint loop (which reads that variable
   fresh every frame already) picks up the refined value on whichever frame it resolves,
   with zero extra wiring - go-live is never blocked waiting on it. */
async function calibrateLowerBodyGuard() {
  if (!LOWER_BODY_GUARD_ENABLED || !LOWER_BODY_GUARD_AUTO_CALIBRATE) return;
  if (typeof FaceDetector === "undefined") return;   // graceful degrade - stays on the static fraction
  const webcam = $("webcam");
  if (!webcam || webcam.videoWidth === 0) return;

  try {
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    /* Scaled down WITHOUT cropping - preserves the real aspect ratio, unlike the
       orientation watcher's own square 96x96/256x256 canvases (built for a different
       purpose: a fixed-size pixel histogram, where the crop-to-square doesn't matter).
       Here it would: a cropped canvas would make a Y-fraction in IT disagree with the
       same Y-fraction of the real webcam frame. A uniform scale-down has no such
       distortion, so the face box's fraction of THIS canvas's height is exactly its
       fraction of the webcam's real height - no separate coordinate mapping needed. */
    const scale = 256 / Math.max(webcam.videoWidth, webcam.videoHeight);
    const cw = Math.max(1, Math.round(webcam.videoWidth * scale));
    const ch = Math.max(1, Math.round(webcam.videoHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    cv.getContext("2d").drawImage(webcam, 0, 0, cw, ch);

    const faces = await detector.detect(cv);
    if (!faces || !faces.length) return;               // no face found - keep the static fraction
    const box = faces[0].boundingBox;
    const faceTopFrac = box.y / ch, faceHeightFrac = box.height / ch;
    const waistFrac = faceTopFrac + faceHeightFrac * LOWER_BODY_GUARD_HEAD_TO_WAIST_UNITS;

    /* Clamped, not trusted outright: a spurious tiny detection (a face in a photo on
       the wall behind the shopper, a bad reading) must not produce a guard that
       protects nearly nothing or nearly the whole frame. */
    lowerBodyGuardFrac = Math.min(0.55, Math.max(0.15, 1 - waistFrac));
    console.log(`[PEAR] lower-body guard calibrated: ${(lowerBodyGuardFrac * 100).toFixed(0)}% ` +
      `of frame height (face at ${(faceTopFrac * 100).toFixed(0)}%, ` +
      `${(faceHeightFrac * 100).toFixed(0)}% tall)`);
  } catch (e) {
    console.warn("[PEAR] lower-body guard calibration failed - staying on the static fraction:",
      e?.message || e);
  }
}

function startLowerBodyGuard() {
  if (!LOWER_BODY_GUARD_ENABLED) return;      // the whole feature is a no-op until validated live
  if (lowerBodyGuardRAF) return;              // already running - never stack a second loop
  const webcam = $("webcam"), canvas = $("lowerBodyGuard");
  if (!webcam || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  card().classList.add("lower-body-guard-active");   // CSS gate: .show-live is the other half
  calibrateLowerBodyGuard();   // fire-and-forget - see its own comment for why

  function paint() {
    // isLive() re-checked every frame, not just at start: the guard must stop painting
    // the instant the session ends, not ride one more rAF tick into a torn-down state.
    if (!isLive() || webcam.videoWidth === 0) {
      lowerBodyGuardRAF = requestAnimationFrame(paint);
      return;
    }
    const w = webcam.videoWidth, h = webcam.videoHeight;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    /* One helper, three callers - see paintGuardBand(). The band, its boundary and the
       mirror correction all live there so the live view, the recording and the frozen
       result cannot disagree about which pixels were the shopper's own. */
    paintGuardBand(ctx, w, h);
    lowerBodyGuardRAF = requestAnimationFrame(paint);
  }
  lowerBodyGuardRAF = requestAnimationFrame(paint);
}

/* Idempotent and safe to call from multiple teardown paths (see the three call sites) -
   exactly the redundant-safety style teardown() itself already uses for its other
   timers, because "did the rAF loop actually stop" must never depend on remembering the
   one right place to ask. */
function stopLowerBodyGuard() {
  if (lowerBodyGuardRAF) { cancelAnimationFrame(lowerBodyGuardRAF); lowerBodyGuardRAF = null; }
  const card_ = card();
  if (card_) card_.classList.remove("lower-body-guard-active");
  const canvas = $("lowerBodyGuard");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  // Reset to the static default so the NEXT session starts from the documented
  // fallback, not a stale calibration left over from a different shopper standing at
  // a different distance from the camera. The live hip line goes with it, for the same
  // reason and more so: it describes one specific body.
  lowerBodyGuardFrac = LOWER_BODY_GUARD_FRAC;
  bodyGuardLine = null;
  bodyGuardTorso = null;
}

/* Paint the final dressed frame onto the on-screen #resultCanvas at full capture
   resolution and return its JPEG dataURL. Doubles as (1) the frozen "masterpiece"
   shown via .show-result and (2) the high-quality poster saved to Previous Fits.
   Prefers the AI-edited feed; falls back to the mirrored webcam. Returns null if
   no frame is paintable - must NEVER throw into the teardown path. */
function freezeFinalFrame() {
  const ai = $("aiVideo");
  const webcam = $("webcam");
  let src = null, mirror = false, w = 0, h = 0;
  if (ai && ai.videoWidth > 0 && ai.style.display !== "none") {
    src = ai; w = ai.videoWidth; h = ai.videoHeight;            // already correctly oriented
  } else if (webcam && webcam.videoWidth > 0) {
    src = webcam; w = webcam.videoWidth; h = webcam.videoHeight; mirror = true;  // selfie-mirror
  }
  if (!src || !w || !h) return null;
  const cv = $("resultCanvas");
  if (!cv) return null;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { alpha: false });
  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  try { ctx.drawImage(src, 0, 0, w, h); } catch (_) { ctx.restore(); return null; }
  ctx.restore();
  /* The same guard the live view and the recorder apply. Only meaningful on the AI branch:
     the fallback branch is ALREADY the raw webcam, so there is nothing of Decart's in it to
     protect the shopper from. Without this the saved "masterpiece" would be the one
     artefact of the session still showing an invented non-target garment. */
  if (!mirror) paintGuardBand(ctx, w, h);
  try { return cv.toDataURL("image/jpeg", 0.85); } catch (_) { return null; }
}

/* ── Live countdown overlay (the strict 5s window) ──────────────────────────
   A circular pill on the #aiVideo container counts the session down to zero, so
   the user always knows the live (billable) window is about to close. */
function showLiveCountdown(sec) {
  const el = $("liveCountdown");
  if (!el) return;
  el.hidden = false;
  tickLiveCountdown(sec);
}
function tickLiveCountdown(sec) {
  const numEl = $("liveCountdownNum");
  if (numEl) numEl.textContent = String(sec);
  const el = $("liveCountdown");
  if (el) {
    // sweep the conic ring from full → empty as the seconds drain (full VIDEO_LENGTH_MS experience)
    const total = Math.max(1, Math.round(VIDEO_LENGTH_MS / 1000));
    el.style.setProperty("--cd-frac", String(Math.max(0, sec) / total));
    el.classList.toggle("is-final", sec <= 1);
  }
}
function hideLiveCountdown() {
  if (liveCountdownInterval) { clearInterval(liveCountdownInterval); liveCountdownInterval = null; }
  const el = $("liveCountdown");
  if (el) { el.hidden = true; el.classList.remove("is-final"); }
}

/* Swap the single capture button between "Go Live" and "Stop" states. */
function setLiveControls(live) {
  const btn = $("captureBtn");
  if (!btn) return;
  const icon  = btn.querySelector(".btn-capture__icon");
  const label = btn.querySelector(".btn-capture__label");
  const en    = btn.querySelector(".btn-capture__en");
  btn.classList.toggle("is-live", live);
  btn.disabled = false;
  if (icon)  icon.textContent  = live ? "⏹" : "📸";
  if (label) label.textContent = live ? "עצור מדידה חיה" : "התחל מדידה חיה";
  if (en)    en.textContent    = live ? "Stop" : "Go Live";
}

/* =============================================================================
   Feature 2 - Download the 5-second fitting clip (MediaRecorder)
   ─────────────────────────────────────────────────────────────────────────
   We record the INCOMING AI-edited WebRTC stream (the dressed output the user
   actually wants), not the raw webcam. Recording starts when the first edited
   frame arrives (onRemoteStream) and is flushed by teardown() the instant the
   5s window closes. On flush we build a Blob → object URL and reveal a clean
   "Download Video" button. Everything is torn down/revoked on the next session.
   ============================================================================= */
/* ── THE EXPORT CONTRACT: a clip leaves this app as .mp4, always ──────────────
   One container name, one extension, in one place. Everything the shopper can save -
   the Replay Zone's download button, the share sheet's File, the gallery lightbox -
   reads these rather than deriving an extension from whatever the recorder negotiated.
   That derivation is what used to hand out .webm on desktop. */
const EXPORT_MIME = "video/mp4";
const EXPORT_EXT  = "mp4";

/* Codec selection, MP4-first on EVERY platform.
   • MP4 IS NOW PREFERRED ON DESKTOP TOO. The previous order put WebM first here, on the
     recorded grounds that "Chrome/Firefox encode the canvas track into .webm most
     reliably; a missing/unsupported codec is what left the file black". That history is
     why the WebM rungs below are kept in full rather than deleted - they are the
     fallback, and the construction loop in beginRecorder() walks down to them the moment
     an MP4 rung fails to build. If black desktop clips ever return, this order is the
     first thing to look at.
   • MOBILE was already MP4-first and stays that way: iOS Photos / Android galleries
     natively ingest MP4, and the MP4 container carries a real top-level duration header,
     which is what kills the "broken 14-second clip" WebM shows on phone players.

   WHY THIS RETURNS A LIST RATHER THAN ONE WINNER, and it matters for the first rung:
   isTypeSupported() answers a question about a TYPE STRING, not about the stream it will
   be handed. `video/mp4;codecs=avc1.42E01E,mp4a.40.2` names an AAC AUDIO codec, and the
   stream here is recordCanvas.captureStream(30) - video-only, by construction. Chromium
   reports that string supported and can still throw NotSupportedError when asked to build
   a recorder for it against a stream with no audio track. Under the old single-pick shape
   that throw landed in beginRecorder()'s catch and killed the clip outright - no
   recording at all, which is a far worse outcome than a WebM one. So every supported
   candidate is returned in preference order and the caller tries them in turn.
   @returns {string[]} supported mime types, most-preferred first */
function recorderMimeCandidates() {
  if (typeof MediaRecorder === "undefined") return [];
  const mp4 = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=h264",
    "video/mp4",
  ];
  const webm = ["video/webm;codecs=vp8", "video/webm", "video/webm;codecs=vp9"];
  return [...mp4, ...webm].filter((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; }
  });
}

/**
 * Start recording the REMOTE Lucy-VTON output shown in #aiVideo (NOT the local
 * camera). We continuously paint the remote frames onto an off-DOM canvas and
 * record canvas.captureStream(), which guarantees real encoded pixels - recording
 * a raw remote WebRTC track directly produces a black video in Chromium. The clip
 * is video-only and is force-stopped by stopRecording() when the user presses Stop.
 * Idempotent within a session.
 */
function startRecording() {
  if (recordingActive || mediaRecorder || typeof MediaRecorder === "undefined") return;
  const video = $("aiVideo");
  if (!video) return;

  recordingActive = true;
  recordedChunks = [];

  // Off-DOM canvas mirroring the remote VTON frames. Seed a sane size so the
  // captureStream track is valid immediately (real frames overwrite it at once).
  recordCanvas = document.createElement("canvas");
  recordCanvas.width  = video.videoWidth  || LIVE_W;
  recordCanvas.height = video.videoHeight || LIVE_H;
  const ctx = recordCanvas.getContext("2d", { alpha: false });

  // iOS Safari only stabilised canvas.captureStream in 15.4 - if it's missing, bail
  // cleanly so the live try-on itself is unaffected (we just skip the downloadable clip).
  if (typeof recordCanvas.captureStream !== "function") {
    console.warn("canvas.captureStream unsupported - clip recording disabled on this device");
    stopPaintLoop();
    return;
  }

  // BLACK-FRAME FIX: the Decart server takes ~1s to warm up before the first
  // dressed frame arrives. If we start the recorder at go-live, the clip begins
  // with ~1s of solid black canvas, so any looped replay (gallery tile / modal)
  // opens on a black screen - this was the "Previous Fits black screen" symptom.
  // Instead we ARM the recorder lazily - only once the first REAL frame has been
  // painted - so the saved Live Photo contains dressed frames exclusively.
  const beginRecorder = () => {
    if (mediaRecorder) return;
    const captured = recordCanvas.captureStream(30);   // 30 fps, video-only
    /* WALK THE LADDER, don't bet the clip on one rung. isTypeSupported() saying yes is not
       the same as the recorder being constructible for THIS stream - see
       recorderMimeCandidates() for the concrete case (an MP4 rung naming an audio codec,
       against a video-only canvas capture). Each failure costs one throw and moves down;
       only running out of rungs falls through to the browser's own default. */
    for (const mime of recorderMimeCandidates()) {
      try {
        mediaRecorder = new MediaRecorder(captured, { mimeType: mime });
        break;
      } catch (e) {
        console.warn(`[PEAR] recorder: ${mime} reported supported but would not build -`,
          e?.message || e, "- trying the next candidate");
      }
    }
    if (!mediaRecorder) {
      /* No candidate built. Let the browser choose its own container rather than give up:
         a clip in a format we did not ask for still exports as .mp4 (see exportClipBlob)
         and is worth far more to the shopper than no clip. */
      try {
        mediaRecorder = new MediaRecorder(captured);
        console.warn("[PEAR] recorder: no preferred codec was constructible;",
          "falling back to the browser default -", mediaRecorder.mimeType || "(unreported)");
      } catch (e) {
        console.warn("MediaRecorder unavailable:", e?.message || e);
        stopPaintLoop();
        return;
      }
    }
    // Record what the recorder ACTUALLY negotiated. This is the TRUE container, and it
    // drives in-page replay - never the exported filename, which is always .mp4.
    recorderMime = (mediaRecorder.mimeType || "").toLowerCase() || null;
    if (recorderMime && recorderMime.indexOf("mp4") === -1) {
      console.warn(`[PEAR] recorder: this browser gave us "${recorderMime}", not MP4.`,
        "The exported file is still packaged and named .mp4 - see exportClipBlob() for",
        "what that does and does not guarantee.");
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = finalizeRecording;          // fires after stop() flushes the buffer
    // 200ms timeslice → proper WebM cluster timecodes, so the clip reports its TRUE
    // duration instead of the broken/inflated length a single-blob start() gives.
    try { mediaRecorder.start(200); }
    catch (e) { console.warn("recorder start failed:", e?.message || e); stopPaintLoop(); mediaRecorder = null; }
  };

  const paint = () => {
    if (!recordingActive) return;
    if (recordHold && recordHoldSrc) {
      // FROZEN-HOLD phase: Decart is disconnected (billing stopped); keep repainting
      // the captured final frame so canvas.captureStream keeps emitting and the clip
      // grows to VIDEO_LENGTH_MS. beginRecorder() is idempotent - it covers the case
      // where the first real frame only arrived right at the billing cap.
      try { ctx.drawImage(recordHoldSrc, 0, 0, recordCanvas.width, recordCanvas.height); beginRecorder(); } catch (_) {}
    } else {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        if (recordCanvas.width !== w || recordCanvas.height !== h) {
          recordCanvas.width = w; recordCanvas.height = h;
        }
        /* THE GUARD RIDES THE RECORDING TOO. This loop draws #aiVideo directly and has
           never seen the overlay canvases stacked over it on screen - which was fine while
           they were transient (the orientation cross-fade), and is not fine for the
           non-target guard: without this the clip and the saved poster would show the
           invented trousers the live view was protecting the shopper from. */
        try {
          ctx.drawImage(video, 0, 0, w, h);
          paintGuardBand(ctx, w, h);
          beginRecorder();
        } catch (_) {}
      }
    }
    recordRaf = requestAnimationFrame(paint);
  };
  paint();
}

/** Halt the canvas paint loop (does not touch the recorder). */
function stopPaintLoop() {
  recordingActive = false;
  if (recordRaf) { cancelAnimationFrame(recordRaf); recordRaf = 0; }
  recordCanvas = null;
}

/** Stop any in-progress local replay without touching the recorder or API state. */
function stopReplay() {
  if (!replayActive) return;
  replayActive = false;
  const vid = $("pearReplayVideo");
  if (vid) { vid.onended = null; try { vid.pause(); } catch (_) {} }
}

/**
 * Force-stop the recorder. Called by teardown (on Stop / tab-hide / unload) -
 * idempotent. onstop → finalizeRecording builds the downloadable clip.
 */
function stopRecording() {
  stopPaintLoop();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
}

/* =============================================================================
   Replay Zone - dedicated, premium UI injected below the camera card
   ─────────────────────────────────────────────────────────────────────────
   Once the 5-second clip is finalised we surface a glassmorphism "Replay Zone"
   directly below #cameraCard. It holds a proper <video> element with native
   controls so the user can scrub, replay, and download without any extra taps.
   The Watch-Again quick-button in the capture controls area scrolls them here.
   ============================================================================= */

/** Inject the Replay Zone CSS exactly once into <head>. */
function injectReplayStyles() {
  if ($("pearReplayStyles")) return;
  const s = document.createElement("style");
  s.id = "pearReplayStyles";
  s.textContent = `
    /* ── PEAR Replay Zone - "Your Try-On" review card (pear-green theme) ── */
    #pearReplayZone {
      margin-top: 20px;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(24,24,28,.93), rgba(11,11,13,.95));
      -webkit-backdrop-filter: blur(22px) saturate(150%);
      backdrop-filter: blur(22px) saturate(150%);
      border: 1px solid rgba(141,182,0,.30);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.06),
        inset 0 0 0 1px rgba(141,182,0,.06),
        0 26px 64px rgba(0,0,0,.52);
      padding: 16px 16px 15px;
      opacity: 0;
      transform: translateY(14px) scale(.99);
      transition: opacity .55s cubic-bezier(.16,1,.3,1),
                  transform .55s cubic-bezier(.16,1,.3,1);
      display: none;
    }
    #pearReplayZone.is-visible { display: block; }
    #pearReplayZone.is-ready   { opacity: 1; transform: none; }

    .pear-rz-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 2px 4px 14px;
    }
    /* garment name - now the prominent title (left, in RTL flow) */
    .pear-rz-title {
      font-family: "Urbanist", sans-serif;
      font-size: 1.06rem;
      font-weight: 800;
      letter-spacing: .005em;
      color: #fff;
      max-width: 58%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pear-rz-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-family: "Inter", sans-serif;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: #9cca00;
      background: rgba(141,182,0,.13);
      border: 1px solid rgba(141,182,0,.36);
      border-radius: 9999px;
      padding: 5px 12px;
      white-space: nowrap;
    }
    .pear-rz-badge::before {
      content: '';
      width: 7px; height: 7px; border-radius: 50%;
      background: #8DB600;
      box-shadow: 0 0 9px rgba(141,182,0,.7);
      animation: pearRzPulse 1.8s ease-in-out infinite;
    }
    @keyframes pearRzPulse { 0%,100% { opacity:1; } 50% { opacity:.25; } }

    #pearReplayVideo {
      width: 100%;
      max-height: 60vh;
      border-radius: 16px;
      display: block;
      background: #000;
      object-fit: contain;
      border: 1px solid rgba(255,255,255,.09);
      box-shadow: 0 12px 32px rgba(0,0,0,.42);
    }

    .pear-rz-actions {
      display: flex;
      gap: 10px;
      margin-top: 14px;
    }
    .pear-rz-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 13px 16px;
      border-radius: 9999px;
      font-family: "Urbanist", sans-serif;
      font-size: .92rem;
      font-weight: 800;
      cursor: pointer;
      border: 1px solid transparent;
      white-space: nowrap;
      transition: transform .35s cubic-bezier(.16,1,.3,1),
                  background .35s cubic-bezier(.16,1,.3,1),
                  box-shadow .35s cubic-bezier(.16,1,.3,1);
    }
    .pear-rz-btn:hover  { transform: translateY(-2px); }
    .pear-rz-btn:active { transform: translateY(0) scale(.97); }
    .pear-rz-btn__en {
      font-size: .68rem;
      font-weight: 700;
      opacity: .6;
      letter-spacing: .04em;
    }
    .pear-rz-btn--replay {
      background: rgba(255,255,255,.08);
      color: #fff;
      border-color: rgba(255,255,255,.16);
    }
    .pear-rz-btn--replay:hover {
      background: rgba(255,255,255,.16);
      box-shadow: 0 8px 22px rgba(0,0,0,.3);
    }
    .pear-rz-btn--dl {
      background: #8DB600;
      color: #0a0a0b;
      box-shadow: 0 12px 36px rgba(141,182,0,.26);
    }
    .pear-rz-btn--dl:hover {
      background: #9cca00;
      box-shadow: 0 12px 30px rgba(141,182,0,.42);
    }
    .pear-rz-btn--dl .pear-rz-btn__en { opacity: .55; }
  `;
  document.head.appendChild(s);
}

/**
 * Lazily create (once) the Replay Zone DOM and insert it directly below
 * #cameraCard. Returns the zone element. Buttons are wired at construction.
 */
function ensureReplayZone() {
  let zone = $("pearReplayZone");
  if (!zone) {
    zone = document.createElement("div");
    zone.id = "pearReplayZone";
    zone.setAttribute("aria-label", "Replay zone");
    zone.innerHTML =
      `<div class="pear-rz-header">` +
        `<span class="pear-rz-badge">Your Try-On · ההקלטה שלך</span>` +
        `<span id="pearRzTitle" class="pear-rz-title"></span>` +
      `</div>` +
      `<video id="pearReplayVideo" class="pear-rz-video"` +
             ` controls loop playsinline muted preload="metadata"></video>` +
      `<div class="pear-rz-actions">` +
        `<button id="pearRzReplayBtn" class="pear-rz-btn pear-rz-btn--replay" type="button">` +
          `<span aria-hidden="true">↺</span>` +
          `<span>צפה שוב</span>` +
          `<span class="pear-rz-btn__en">Replay</span>` +
        `</button>` +
        `<button id="pearRzDlBtn" class="pear-rz-btn pear-rz-btn--dl" type="button">` +
          `<span aria-hidden="true">⬇</span>` +
          `<span>הורד</span>` +
          `<span class="pear-rz-btn__en">Download</span>` +
        `</button>` +
      `</div>`;

    zone.querySelector("#pearRzReplayBtn").addEventListener("click", () => {
      const v = $("pearReplayVideo");
      if (!v) return;
      replayActive = true;
      try { v.currentTime = 0; } catch (_) {}
      v.play().catch(() => {});
    });
    zone.querySelector("#pearRzDlBtn").addEventListener("click", downloadRecording);

    const anchor = card();
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(zone, anchor.nextSibling);
    } else {
      document.body.appendChild(zone);
    }
  }
  return zone;
}

/** Build the downloadable clip from the buffered chunks and reveal the Replay Zone. */
function finalizeRecording() {
  if (!recordedChunks.length) return;
  const raw = (recordedChunks[0] && recordedChunks[0].type) || recorderMime || "video/webm";
  const type = raw.split(";")[0] || "video/webm";
  const blob = new Blob(recordedChunks, { type });
  recordedChunks = [];
  recordedBlob = blob;

  // 🎞 Live-Action gallery: hand the SAME clip to the most-recent saved fit as
  // its own object URL (independent of recordedUrl, so the revoke below is safe).
  try { attachClipToLastFit(blob); } catch (_) {}

  if (recordedUrl) { try { URL.revokeObjectURL(recordedUrl); } catch (_) {} }
  /* The previous session's .mp4-typed export URL dies with its blob. Revoked here as well
     as in clearRecording() because a second session in the same page reaches this
     function without necessarily passing through that one. */
  if (exportUrl) { try { URL.revokeObjectURL(exportUrl); } catch (_) {} exportUrl = null; }
  recordedUrl = URL.createObjectURL(blob);

  // Populate the dedicated Replay Zone and fade it in below the camera card.
  const zone = ensureReplayZone();
  const vid = $("pearReplayVideo");
  if (vid) { vid.src = recordedUrl; vid.muted = true; vid.load(); }
  const titleEl = $("pearRzTitle");
  if (titleEl) titleEl.textContent = activeItem ? activeItem.name : "";

  zone.classList.add("is-visible");
  // Two-rAF trick: browser paints display:block first, then transition fires.
  requestAnimationFrame(() => requestAnimationFrame(() => zone.classList.add("is-ready")));
}

/* ── THE .mp4 EXPORT, AND EXACTLY WHAT IT GUARANTEES ──────────────────────────
   Every saved clip is packaged as video/mp4 and named .mp4. On every browser that can
   record MP4 - which is all of mobile, plus current Safari and Chromium - that is simply
   the truth: recordedBlob is already an MP4 and this returns it unchanged.

   ON A BROWSER THAT CANNOT (desktop Firefox is the live case), THIS RE-LABELS RATHER THAN
   CONVERTS. The bytes stay WebM; only the container name on the Blob and the extension on
   the file change. That is a deliberate, requested trade and it is worth being precise
   about which half of it works:
     · it plays fine in browsers, which sniff the actual bytes rather than trusting a name;
     · it will NOT open in QuickTime, iOS Photos, or Windows Photos, which trust the
       extension and then find a container that is not MP4.
   Honestly re-containerising WebM into MP4 needs a real transcode (ffmpeg.wasm, multiple
   MB on the critical path) and is out of scope here. If a "the downloaded file won't
   open" report arrives from a desktop Firefox user, this function is the answer and
   EXPORT_MIME/EXPORT_EXT is the one place to change.

   THE REPLAY IS DELIBERATELY LEFT TRUTHFUL. recordedBlob and recordedUrl keep the real
   container, because they feed the in-page <video> and the gallery's Live Photo. Firefox
   trusts a blob's declared type for playback, so re-labelling those would break the
   preview on the exact browser where the re-label happens - trading a file that opens
   everywhere-but-QuickTime for one that also fails to play in the app itself.
   @returns {Blob|null} */
function exportClipBlob() {
  if (!recordedBlob) return null;
  if (recordedBlob.type === EXPORT_MIME) return recordedBlob;
  return new Blob([recordedBlob], { type: EXPORT_MIME });
}

/** `pear-tryon-20260823-142530.mp4` - sortable, filename-safe, no garment name to
 *  escape. The timestamp is what keeps repeat downloads from colliding in the
 *  browser's download folder. @returns {string} */
function exportClipName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
             `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `pear-tryon-${ts}.${EXPORT_EXT}`;
}

/**
 * Save the recorded clip locally - mobile-first (mobile download fix).
 *
 * On phones the classic `<a download>` is unreliable: iOS Safari ignores the
 * download attribute entirely (it just navigates to the blob, often playing it
 * inline), so the clip never lands in Photos. The robust path is the Web Share API
 * with a File - that opens the native share sheet whose "Save Video" action drops
 * the clip straight into the iOS/Android gallery. We only reach for it when the
 * platform reports it can actually share THIS file, and we fall back to the anchor
 * download on desktop or when sharing is unavailable/declined.
 *
 * Must run inside the click gesture: the File is built synchronously and
 * navigator.share() is invoked before any real async gap, preserving the gesture.
 * @returns {Promise<void>}
 */
async function downloadRecording() {
  if (!recordedBlob && !recordedUrl) return;
  /* ONE container, one extension, both from the export contract - never derived from what
     the recorder happened to negotiate. That derivation is what handed desktop users a
     .webm; see exportClipBlob() for what the guarantee is worth when the bytes are not
     actually MP4. */
  const type = EXPORT_MIME;
  const filename = exportClipName();
  const blob = exportClipBlob();

  // 1) Native gallery save via the share sheet (the reliable mobile path).
  if (blob && typeof navigator.canShare === "function" && typeof navigator.share === "function") {
    try {
      const file = new File([blob], filename, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "PEAR - מדידה וירטואלית",
          text: "הלוק שלי מ-PEAR · PEAR virtual fitting",
        });
        return;                                   // saved/shared - done
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;   // user dismissed the sheet - not an error
      console.warn("share failed, falling back to download:", err?.message || err);
      // fall through to the anchor download below
    }
  }

  // 2) Desktop / fallback: object-URL anchor download. Keep the URL alive (no
  //    immediate revoke) so mobile browsers that open it in a new tab can still
  //    read the blob and let the user long-press → "Save Video"; it is revoked on
  //    the next session (clearRecording / finalizeRecording).
  /* The anchor gets the .mp4-TYPED blob, not the replay one. They are the same object
     whenever the recorder produced MP4; when it did not, this is the object URL that
     carries video/mp4, and minting it here (rather than in finalizeRecording) keeps the
     cost on the download click instead of on every session that is never downloaded.
     Cached on exportUrl so repeat clicks do not leak a URL per press. */
  if (!exportUrl) {
    if (blob) exportUrl = URL.createObjectURL(blob);
    else if (!recordedUrl && recordedBlob) recordedUrl = URL.createObjectURL(recordedBlob);
  }
  const a = document.createElement("a");
  a.href = exportUrl || recordedUrl;
  a.download = filename;
  a.rel = "noopener";
  if (IS_MOBILE) a.target = "_blank";             // iOS w/o canShare: open so it can be saved manually
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Drop the current clip, stop any replay, and hide post-session buttons. */
function clearRecording() {
  stopPaintLoop();                     // ensure no stale paint loop leaks into the next session
  stopReplay();                        // abort any in-progress local blob replay
  if (recordedUrl) { try { URL.revokeObjectURL(recordedUrl); } catch (_) {} recordedUrl = null; }
  if (exportUrl) { try { URL.revokeObjectURL(exportUrl); } catch (_) {} exportUrl = null; }
  recordedChunks = [];
  recordedBlob = null;
  recorderMime = null;

  // Reset and hide the dedicated Replay Zone so the next session starts clean.
  const zone = $("pearReplayZone");
  if (zone) {
    zone.classList.remove("is-ready", "is-visible");
    const vid = $("pearReplayVideo");
    if (vid) {
      vid.onended = null;
      try { vid.pause(); } catch (_) {}
      vid.removeAttribute("src");
      try { vid.load(); } catch (_) {}
    }
    const titleEl = $("pearRzTitle");
    if (titleEl) titleEl.textContent = "";
  }
}

/* ── offline-dev mock (ONLY via ?demo=1) ─────────────────────────────────── */
async function renderMockDemo(item) {
  const webcam = $("webcam");
  const vw = webcam.videoWidth || 720, vh = webcam.videoHeight || 960;
  const cv = $("resultCanvas");
  cv.width = vw; cv.height = vh;
  const c = cv.getContext("2d");
  c.save(); c.translate(vw, 0); c.scale(-1, 1); c.drawImage(webcam, 0, 0, vw, vh); c.restore();
  try {
    const img = await loadImage(item.img);
    const upper = item.garmentType !== "lower_body";
    const gw = vw * (upper ? 0.54 : 0.46), gh = gw * (img.height / img.width || 1.2);
    const gx = (vw - gw) / 2, gy = upper ? vh * 0.24 : vh * 0.52;
    c.globalAlpha = 0.92;
    c.drawImage(img, gx, gy, gw, gh);
    c.globalAlpha = 1;
  } catch (_) {}
  c.fillStyle = "rgba(11,60,149,.92)";
  c.fillRect(vw - 192, 14, 178, 30);
  c.fillStyle = "#fff"; c.font = "700 15px Inter, sans-serif"; c.textBaseline = "middle";
  c.fillText("DEMO · ?demo=1 (no live API)", vw - 188, 29);
}

/* =============================================================================
   Complete the Look + catalog
   ============================================================================= */
function recommendFor(item) {
  const want = item.garmentType === "lower_body" ? "shirt" : "pants";
  const lum = (hex) => { const f = parseInt(hex.slice(1), 16); return (0.299 * (f >> 16) + 0.587 * ((f >> 8) & 255) + 0.114 * (f & 255)) / 255; };
  const base = lum(item.color);
  return PEAR_CATALOG
    // STRICT catalog match - a recommendation must be:
    //   • the complementary category (shirt ⇄ pants),
    //   • a DIFFERENT product than the one being worn,
    //   • a real, purchasable item with a valid front image, and
    //   • not blocked/incomplete - itemBlockReason() is the same gate as go-live, so
    //     the Gatekeeper "Incomplete Test" entry (id 99) and any item missing required
    //     imagery are never suggested. Nothing fictional or unavailable can slip in.
    .filter((x) => x.type === want && x.id !== item.id && !!x.img && !itemBlockReason(x))
    .map((x) => ({ x, score: Math.abs(lum(x.color) - base) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((r) => r.x);
}

/* Keyword-guess a scanned garment_cache image's category from its URL. garment_cache
   only stores { image_url, classification } and `classification` there means
   front|back (see classifyFrontBack in server.js) - it carries no garment-category
   signal, so this is the only classifier we have for store items. Returns "shirt" |
   "pants" (the SAME vocabulary as PEAR_CATALOG.type) so a store item can flow through
   toItem()/slotOf()/recommendFor's card rendering exactly like a catalog item. */
function guessTypeFromUrl(url) {
  const u = (url || "").toLowerCase();
  if (/pants|jeans|trouser/.test(u)) return "pants";
  if (/shirt|top|blouse/.test(u)) return "shirt";
  return "shirt";
}

/* Real-store "Complete the Look" source. A widget embed on an actual store
   (window.__pearStoreDomain set by parseHandoff() the moment a garment_url handoff
   arrives) must recommend items from THAT store - never the hardcoded demo
   PEAR_CATALOG, which is stock/placeholder imagery unrelated to any real retailer.
   Demo/catalog sessions (no storeDomain) keep the existing recommendFor() behavior
   unchanged. A store session that has no cached items yet (or the fetch fails)
   returns [] rather than ever falling back to the demo catalog - renderCompleteTheLook
   hides the section entirely in that case (see Step 5 requirement). */
async function fetchStoreLookItems(currentItem) {
  const domain = window.__pearStoreDomain;
  if (!domain) return recommendFor(currentItem);   // demo/catalog mode - existing behavior

  const wantType = currentItem.garmentType === "lower_body" ? "shirt" : "pants";
  try {
    const resp = await fetch("/api/store-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, type: wantType }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { items } = await resp.json();
    return (Array.isArray(items) ? items : [])
      .filter((it) => it && it.image_url)
      .map((it) => ({
        id: it.image_url,
        img: it.image_url,
        type: guessTypeFromUrl(it.image_url),
        name: "פריט מהחנות",
        custom: true,
      }))
      .filter((it) => it.type === wantType)
      .slice(0, 4);
  } catch (e) {
    console.warn("[PEAR] fetchStoreLookItems failed - hiding Complete the Look:", e?.message || e);
    return [];
  }
}

/* data-look is now an INDEX into this array, not a PEAR_CATALOG id - a store item's
   "id" is its image_url (a string, and one we'd rather not stuff into an HTML
   attribute verbatim), so both catalog and store recs are looked up the same safe
   way. Rebuilt on every render; stale after the section next re-renders. */
let _lookCards = [];

/* Guards against a slow store-catalog fetch resolving AFTER a newer garment has
   already been activated (rapid re-clicks) - the stale response is discarded rather
   than clobbering the section with recommendations for the wrong item. */
let _lookRenderToken = 0;

async function renderCompleteTheLook(item) {
  const myToken = ++_lookRenderToken;
  const recs = window.__pearStoreDomain ? await fetchStoreLookItems(item) : recommendFor(item);
  if (myToken !== _lookRenderToken) return;   // a newer item took over while this was in flight

  _lookCards = recs;
  // Conditional render (requirement 3): when there's NO real complementary product
  // (demo catalog has none, or the store's garment_cache has nothing cached yet for
  // this domain), hide the whole section - never an empty shell, placeholder, or the
  // wrong category, and never a demo-catalog fallback during a real store session.
  // .complete-look[hidden] { display: none; } in style.css makes this an actual
  // display:none, not just an ARIA-hidden section.
  const section = $("completeLook");
  if (!recs.length) {
    $("clTrack").innerHTML = "";
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const he = item.garmentType === "lower_body" ? "חולצות שמשלימות את המכנסיים" : "מכנסיים שמשלימים את החולצה";
  $("clSub").textContent = he + " · Complete the Look";
  $("clTrack").innerHTML = recs.map((r, i) => `
    <article class="cl-card" style="--i:${i}">
      <div class="cl-card__media">${garmentThumb(r)}</div>
      <div class="cl-card__body">
        <span class="cl-card__cat">${r.type === "pants" ? "Pants" : "Shirt"}${SUBTYPE_LABEL_HE[r.subType] ? " · " + SUBTYPE_LABEL_HE[r.subType] : ""}</span>
        <div class="cl-card__name">${r.name}</div>
        ${r.price != null ? `<span class="cl-card__price">$${r.price}</span>` : ""}
      </div>
      <button class="cl-card__look" data-look="${i}">הוסף ללוק · Add to Look</button>
    </article>`).join("");
}

/* Corner badge on a catalog card conveying its two-view completeness at a glance:
   a filled dot = a real image ships for that view, hollow = rendered from the front.
   A ✓ pill marks fully-documented (front+back) items; a blocked item (opt-in strict
   without a back) shows a lock. Purely informational - the actual gate lives in
   goLive()/liveBlockReason(). */
function viewBadge(p) {
  const front = hasFrontView(p), back = hasBackView(p);
  const blocked = !!itemBlockReason(p);
  const cls = blocked ? "viewbadge--blocked" : (front && back) ? "viewbadge--complete" : "viewbadge--partial";
  const title = blocked ? "חסרה תמונת גב · back view required"
              : (front && back) ? "חזית + גב · front + back ready"
              : "חזית בלבד · front only";
  const dot = (on) => `<i class="viewbadge__dot${on ? " is-on" : ""}"></i>`;
  const mark = blocked ? "🔒" : (front && back) ? "✓" : "";
  return `<span class="viewbadge ${cls}" title="${title}" aria-label="${title}">`
       + `${dot(front)}${dot(back)}${mark ? `<b class="viewbadge__mark">${mark}</b>` : ""}</span>`;
}

function renderCatalogPanel() {
  // "Upload Your Own Garment" - the first, prominent tile in the garment selector.
  // Clicking it opens the native file picker (delegated [data-upload] handler).
  const uploadCard = `
    <div class="cat-item cat-item--upload" data-upload role="button" tabindex="0"
         aria-label="העלה בגד משלך · Upload your own garment">
      <div class="cat-item__media cat-upload__media">
        <span class="cat-upload__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V4"></path><path d="M7 9l5-5 5 5"></path>
            <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
          </svg>
        </span>
      </div>
      <div class="cat-item__body">
        <span class="cat-item__name">העלה בגד משלך</span>
        <span class="cat-item__price cat-upload__en">Upload your own</span>
      </div>
    </div>`;

  $("catalogGrid").innerHTML = uploadCard + PEAR_CATALOG.map((p) => `
    <div class="cat-item${itemBlockReason(p) ? " cat-item--blocked" : ""}" data-pick="${p.id}">
      <div class="cat-item__media">${garmentThumb(p)}${viewBadge(p)}</div>
      <div class="cat-item__body">
        <span class="cat-item__name">${p.name}</span>
        <span class="cat-item__price">$${p.price}</span>
      </div>
    </div>`).join("");
}

function highlightCatalog(id) {
  document.querySelectorAll(".cat-item").forEach((el) =>
    el.classList.toggle("is-active", +el.dataset.pick === id));
}

/* ═════════════════════════════════════════════════════════════════════════════
   "UPLOAD YOUR OWN GARMENT" - detect · select · crop · inject
   ─────────────────────────────────────────────────────────────────────────────
   Flow:  upload card → file picker → handleGarmentFile() validates + loads the
   image → runDetection() opens the overlay and runs detectGarments() (a vanilla,
   dependency-free background-subtraction + connected-components pass) → the user
   clicks a bounding box → selectDetectedGarment() crops that region to a data-URL
   and hands it to setActiveItem() as a "custom" item. From there it is treated
   EXACTLY like a catalog garment: goLive() → applyActive() → rtClient.set({ prompt,
   image: <cropped dataURL> }), governed by the same ek_ token, strict LIVE_DURATION_MS
   window and pagehide/visibilitychange leak guards. All tunables live in CONFIG.UPLOAD.
   ═════════════════════════════════════════════════════════════════════════════ */

let uploadedImg    = null;  // the currently-loaded source Image (natural resolution)
let detectedBoxes  = [];    // [{ xmin, ymin, width, height, score }] in NATURAL image coords
let detectedOutfit = null;  // { topBounds, bottomBounds, … } when a full worn outfit is detected → TOP/BOTTOM toggle
let activeSide     = "top"; // which sub-region the outfit toggle currently targets ("top" | "bottom")

/* Dual-view custom upload (front required, back optional). uploadTarget routes the
   NEXT confirmed crop to the right slot; customFrontItem is the live custom garment a
   later back crop attaches to as imgBack. With both, galleryOf() exposes { front, back }
   and the existing angle hot-swap (activeImageOf → g.back, angleClause → backReal) drives
   a CLEAN single-view rear reference - no stitching, so the front print can't bleed. */
let uploadTarget    = "front";  // "front" | "back" - which slot the next confirmed crop fills
let customFrontItem = null;     // the live custom item awaiting an optional back crop

/** Open the native file picker (reset value so re-picking the SAME file re-fires change).
 *  `target` routes the next confirmed crop: "back" fills the optional rear view of the
 *  current custom garment, anything else (incl. a click Event) falls back to "front". */
function openGarmentUpload(target = "front") {
  const inp = $("garmentUploadInput");
  if (!inp) return;
  uploadTarget = target === "back" ? "back" : "front";
  inp.value = "";
  inp.click();
}

/** File-input change handler. */
function onGarmentFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (file) handleGarmentFile(file);
}

/**
 * Validate the picked file (type + size), decode it, then run detection.
 * @param {File} file
 */
function handleGarmentFile(file) {
  const U = CONFIG.UPLOAD;
  if (!/^image\//i.test(file.type)) { toast("קובץ לא נתמך - בחר/י תמונה"); return; }
  if (file.size > U.MAX_BYTES) {
    toast(`התמונה גדולה מדי (מקסימום ${Math.round(U.MAX_BYTES / (1024 * 1024))}MB)`);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    // Same-origin data URL → canvas stays untainted, so getImageData()/toDataURL() work.
    img.onload = () => runDetection(img);
    img.onerror = () => toast("טעינת התמונה נכשלה - נסה/י תמונה אחרת");
    img.src = String(reader.result);
  };
  reader.onerror = () => toast("קריאת הקובץ נכשלה");
  reader.readAsDataURL(file);
}

/**
 * Open the overlay in its loading state, paint the image, then (after a short,
 * config-driven delay so the modal can render) run the synchronous detect pass and
 * draw the boxes - or the empty state when nothing is found.
 * @param {HTMLImageElement} img
 */
function runDetection(img) {
  uploadedImg = img;
  detectedBoxes = [];

  openGarmentDetect();
  $("gdImage").src = img.src;

  setTimeout(() => {
    let boxes = [];
    try { boxes = detectGarments(img); }
    catch (err) { console.warn("[upload] detectGarments failed:", err?.message || err); }

    detectedBoxes = boxes;
    $("gdLoading").hidden = true;

    if (!boxes.length) {
      showDetectEmpty();
      toast("לא זוהו בגדים. נסה/י תמונה ברורה אחרת.");
      return;
    }

    // A worn full outfit is ONE figure → drive it with the TOP/BOTTOM toggle
    // (one bounding box that snaps between the top & bottom sub-regions). Flat-lays
    // with distinct garments stay in multi-bracket mode.
    const outfit = boxes.filter((b) => b.outfit)
                        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (outfit) {
      enterOutfitMode(outfit);
    } else {
      exitOutfitMode();
      $("gdSub").textContent =
        `${boxes.length} ${boxes.length === 1 ? "פריט זוהה" : "פריטים זוהו"} · tap to select`;
      renderDetectionBoxes(boxes);
    }
  }, CONFIG.UPLOAD.DETECT_RENDER_DELAY_MS);
}

/* ── overlay open/close (fade driven purely by the .show class + CSS) ───────── */
function openGarmentDetect() {
  const ov = $("garmentDetect");
  if (!ov) return;
  ov.hidden = false;                       // drop the initial display:none once
  $("gdBoxes").innerHTML = "";
  $("gdLoading").hidden = false;
  $("gdEmpty").hidden = true;
  $("gdSub").textContent = "מזהה בגדים בתמונה…";
  detectedOutfit = null; activeSide = "top";
  { const tabs = $("gdTabs"); if (tabs) tabs.hidden = true; }
  document.body.classList.add("gd-open");
  requestAnimationFrame(() => ov.classList.add("show"));
}

function closeGarmentDetect() {
  const ov = $("garmentDetect");
  if (!ov) return;
  ov.classList.remove("show");             // CSS transitions the fade-out; no JS timer
  document.body.classList.remove("gd-open");
}

function showDetectEmpty() {
  $("gdEmpty").hidden = false;
  $("gdSub").textContent = "לא זוהו בגדים";
}

/**
 * Draw a clickable royal-blue box over each detection. Coordinates are expressed
 * as PERCENTAGES of the natural image size, and .gd-boxes overlaps the rendered
 * image exactly (its .gd-frame parent wraps only the <img>), so the mapping is
 * scale-independent - no recompute on resize needed.
 * @param {Array<{xmin:number,ymin:number,width:number,height:number}>} boxes
 */
const GARMENT_LABEL_HE = { "Top": "עליון", "Bottom": "תחתון", "Full-body": "מלא" };

function renderDetectionBoxes(boxes) {
  const img = uploadedImg;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  $("gdBoxes").innerHTML = boxes.map((b, i) => {
    const left = (b.xmin / iw) * 100, top = (b.ymin / ih) * 100;
    const w = (b.width / iw) * 100,   h = (b.height / ih) * 100;
    const en = b.label || "Item", he = GARMENT_LABEL_HE[en] || "פריט";
    return `<button class="gd-box" type="button" data-box="${i}" aria-label="מדוד ${he}" style="--i:${i};` +
      `left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${w.toFixed(3)}%;height:${h.toFixed(3)}%">` +
      `<span class="gd-box__label"><b>${he}</b><span>${en}</span></span>` +
      `<i class="gd-corner gd-corner--tl"></i><i class="gd-corner gd-corner--tr"></i>` +
      `<i class="gd-corner gd-corner--bl"></i><i class="gd-corner gd-corner--br"></i>` +
      `</button>`;
  }).join("");
}

/* ── OUTFIT MODE - one bracket + a TOP/BOTTOM segmented toggle ────────────────
   For a full worn outfit we show a single bracket whose position/size + label snap
   between the outfit's TOP and BOTTOM sub-regions when the toggle changes. Switching
   sides mutates the SAME element's inline bounds so the CSS transition animates the
   move (the uploaded image is never reloaded). */
const SIDE_LABEL = {
  top:    { he: "בגד עליון", en: "Top Garment" },
  bottom: { he: "בגד תחתון", en: "Bottom Garment" },
};

function outfitBoundsPct(bounds) {
  const iw = uploadedImg.naturalWidth || uploadedImg.width;
  const ih = uploadedImg.naturalHeight || uploadedImg.height;
  return {
    left:  (bounds.xmin  / iw) * 100, top:    (bounds.ymin   / ih) * 100,
    width: (bounds.width / iw) * 100, height: (bounds.height / ih) * 100,
  };
}

function enterOutfitMode(outfit) {
  detectedOutfit = outfit;
  activeSide = "top";
  $("gdSub").textContent = "זוהתה תלבושת מלאה · בחר/י עליון או תחתון";
  const tabs = $("gdTabs"); if (tabs) tabs.hidden = false;
  updateTabsUI();
  renderOutfitBox();
}

function exitOutfitMode() {
  detectedOutfit = null;
  const tabs = $("gdTabs"); if (tabs) tabs.hidden = true;
}

function renderOutfitBox() {
  const b = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
  const p = outfitBoundsPct(b);
  const { he, en } = SIDE_LABEL[activeSide];
  $("gdBoxes").innerHTML =
    `<button class="gd-box gd-box--outfit" type="button" data-box="0" aria-label="מדוד ${he}" style="--i:0;` +
    `left:${p.left.toFixed(3)}%;top:${p.top.toFixed(3)}%;width:${p.width.toFixed(3)}%;height:${p.height.toFixed(3)}%">` +
    `<span class="gd-box__label"><b>${he}</b><span>${en}</span></span>` +
    `<i class="gd-corner gd-corner--tl"></i><i class="gd-corner gd-corner--tr"></i>` +
    `<i class="gd-corner gd-corner--bl"></i><i class="gd-corner gd-corner--br"></i>` +
    `</button>`;
}

/** Move/resize the existing outfit bracket to the active side (CSS animates it). */
function positionOutfitBox() {
  if (!detectedOutfit) return;
  const el = $("gdBoxes").querySelector(".gd-box");
  if (!el) return;
  const b = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
  const p = outfitBoundsPct(b);
  el.style.left = p.left.toFixed(3) + "%";  el.style.top    = p.top.toFixed(3) + "%";
  el.style.width = p.width.toFixed(3) + "%"; el.style.height = p.height.toFixed(3) + "%";
  const { he, en } = SIDE_LABEL[activeSide];
  el.setAttribute("aria-label", "מדוד " + he);
  const lbl = el.querySelector(".gd-box__label");
  if (lbl) lbl.innerHTML = `<b>${he}</b><span>${en}</span>`;
}

/** Toggle handler - snap the bracket + crop target between the TOP and BOTTOM regions. */
function setActiveSide(side) {
  if (side !== "top" && side !== "bottom" || !detectedOutfit) return;
  activeSide = side;
  updateTabsUI();
  positionOutfitBox();
}

function updateTabsUI() {
  const tabs = $("gdTabs"); if (!tabs) return;
  tabs.dataset.active = activeSide;                 // slides the pill indicator
  tabs.querySelectorAll(".gd-tab").forEach((t) => {
    const on = t.dataset.side === activeSide;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
}

/**
 * The user picked a box: crop the chosen region (the active TOP/BOTTOM sub-region in
 * outfit mode, else the tapped garment), build a "custom" item and route it through
 * the normal setActiveItem() path. Then close the overlay and nudge the user to go live.
 * @param {number} index - index into detectedBoxes (ignored in outfit mode)
 */
function selectDetectedGarment(index) {
  if (!uploadedImg) return;

  // Resolve which region to crop + its garment category.
  let box, gtype;
  if (detectedOutfit) {
    box   = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
    gtype = activeSide === "bottom" ? "lower_body" : "upper_body";
  } else {
    box = detectedBoxes[index];
    if (!box) return;
    const iw = uploadedImg.naturalWidth || uploadedImg.width;
    const ih = uploadedImg.naturalHeight || uploadedImg.height;
    gtype = box.garmentType || guessGarmentType(box, iw, ih);
  }

  // Crisp click-confirmation flash on the chosen bracket before the modal closes.
  const el = document.querySelector(`.gd-box[data-box="${index}"]`);
  if (el) el.classList.add("is-picked");

  const crop = cropRegion(uploadedImg, box);

  // ── BACK view: attach to the pending front item as imgBack (no new item) ──────
  // galleryOf() now exposes { front, back }, so the live Back tab hot-swaps THIS crop
  // as a clean single-view reference (activeImageOf → g.back) and angleClause() upgrades
  // to backReal ("reproduce the real back faithfully"). gtype is irrelevant here - the
  // back always belongs to the same garment/slot as its front.
  if (uploadTarget === "back" && customFrontItem) {
    customFrontItem.imgBack = crop.dataUrl;
    setTimeout(() => {
      closeGarmentDetect();
      uploadTarget = "front";
      setActiveItem(customFrontItem);                  // re-render: Back tab is now a REAL view (no AI badge)
      toast(`נוספה תמונת גב · back view added - <b>Front + Back</b> מוכן`);
    }, CONFIG.UPLOAD.PICK_ANIM_MS);
    return;
  }

  // ── FRONT view: build the custom item and remember it for an optional back crop ─
  const item = {
    id: null,
    custom: true,
    name: gtype === "lower_body" ? "המכנס שלך · Your garment" : "הבגד שלך · Your garment",
    price: null,
    type: gtype === "lower_body" ? "pants" : "shirt",  // feeds recommendFor()/thumbnails
    subType: "",                                       // no catalog subType → generic prompt
    garmentType: gtype,                                // drives slotOf() + opposite-layer lock
    color: crop.color,                                 // avg crop colour → recommendFor contrast + demo
    img: crop.dataUrl,                                 // the cropped garment as a data URL (rtClient image)
  };
  customFrontItem = item;                              // a later "Add back view" crop attaches here
  uploadTarget    = "front";

  // Let the pick animation play, then close + transition to the live room (Screen 2).
  setTimeout(() => {
    closeGarmentDetect();
    setActiveItem(item);                               // fills its slot, paints chip, resets to live
    const cc = $("cameraCard");
    if (cc) cc.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(`נבחר בגד מותאם - הוסף/י <b>תמונת גב</b> או שנשלים אותה ב־AI`);
  }, CONFIG.UPLOAD.PICK_ANIM_MS);
}

/**
 * Detect garment bounding boxes with a vanilla, dependency-free pass:
 *   1. downscale for speed;  2. estimate the background colour from the border;
 *   3. mask foreground (pixels far from bg);  4. dilate to close gaps;
 *   5. connected-components → blob boxes;  6. filter by size, merge overlaps, cap.
 * Handles flat-lays, white/plain backgrounds AND model-worn photos (one subject box).
 * Falls back to a single whole-image box if the canvas is unreadable (tainted).
 * @param {HTMLImageElement} img
 * @returns {Array<{xmin:number,ymin:number,width:number,height:number,score:number}>} boxes in NATURAL coords
 */
function detectGarments(img) {
  const U = CONFIG.UPLOAD;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return [];

  const scale = Math.min(1, U.DETECT_MAX_DIM / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; }
  catch (_) { return [{ xmin: 0, ymin: 0, width: iw, height: ih, score: 0.4 }]; }

  // 2) background colour = mean of a border band on all four edges.
  const band = Math.max(2, Math.round(Math.min(w, h) * U.BG_SAMPLE_BAND));
  let br = 0, bg = 0, bb = 0, bn = 0;
  const sample = (x, y) => { const i = (y * w + x) * 4; br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; };
  for (let y = 0; y < h; y++) for (let x = 0; x < band; x++) { sample(x, y); sample(w - 1 - x, y); }
  for (let x = 0; x < w; x++) for (let y = 0; y < band; y++) { sample(x, y); sample(x, h - 1 - y); }
  const bgR = br / bn, bgG = bg / bn, bgB = bb / bn;

  // 3) foreground mask (squared distance vs threshold²).
  const thr2 = U.FG_DIFF_THRESHOLD * U.FG_DIFF_THRESHOLD;
  let mask = new Uint8Array(w * h);
  let fgCount = 0;
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    if (dr * dr + dg * dg + db * db > thr2) { mask[p] = 1; fgCount++; }
  }
  if (fgCount === 0) return [];

  // 4) dilate (separable) so a single garment fragmented by shadows/prints → one blob.
  mask = dilateMask(mask, w, h, U.DILATE_RADIUS);

  // 5) connected components (4-connectivity, iterative flood fill).
  const visited = new Uint8Array(w * h);
  const stack = [];
  const raw = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (!mask[start] || visited[start]) continue;
      let minx = sx, maxx = sx, miny = sy, maxy = sy, area = 0;
      stack.length = 0; stack.push(start); visited[start] = 1;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % w, qy = (q / w) | 0;
        area++;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        if (qx > 0)     { const n = q - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qx < w - 1) { const n = q + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qy > 0)     { const n = q - w; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qy < h - 1) { const n = q + w; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }
      raw.push({ x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, area });
    }
  }

  // 6) filter by size, drop slivers + near-full-frame blobs, then merge + cap.
  const imgArea = w * h;
  let cand = raw
    .filter((b) => b.area >= imgArea * U.MIN_BOX_AREA_FRAC)
    .filter((b) => (b.w * b.h) <= imgArea * U.MAX_BOX_AREA_FRAC)
    .filter((b) => b.w >= w * U.MIN_BOX_DIM_FRAC && b.h >= h * U.MIN_BOX_DIM_FRAC)
    .sort((a, b) => b.area - a.area);

  // Fallback: nothing passed the size gate but there IS a clear subject → one box
  // around all foreground (covers a garment/person that fills most of the frame).
  if (!cand.length) {
    if (fgCount < imgArea * U.MIN_BOX_AREA_FRAC) return [];
    const all = raw.reduce((acc, b) => ({
      x0: Math.min(acc.x0, b.x), y0: Math.min(acc.y0, b.y),
      x1: Math.max(acc.x1, b.x + b.w), y1: Math.max(acc.y1, b.y + b.h),
    }), { x0: w, y0: h, x1: 0, y1: 0 });
    cand = [{ x: all.x0, y: all.y0, w: all.x1 - all.x0, h: all.y1 - all.y0, area: fgCount }];
  }

  cand = mergeBoxes(cand, U.MERGE_IOU);

  // Scale back to natural coords + pad outward so seams aren't clipped.
  const inv = 1 / scale;
  let natural = cand.map((b) => {
    const padX = b.w * U.BOX_PAD_FRAC, padY = b.h * U.BOX_PAD_FRAC;
    const x0 = Math.max(0, (b.x - padX)) * inv;
    const y0 = Math.max(0, (b.y - padY)) * inv;
    const x1 = Math.min(w, (b.x + b.w + padX)) * inv;
    const y1 = Math.min(h, (b.y + b.h + padY)) * inv;
    return {
      xmin: Math.round(x0), ymin: Math.round(y0),
      width: Math.round(x1 - x0), height: Math.round(y1 - y0),
      score: Math.min(1, b.area / imgArea),
    };
  });

  // Classify each blob (Top / Bottom / Full-body) and split a worn-outfit blob
  // into separate Top + Bottom garments, then confidence-gate + cap.
  natural = refineGarments(natural, iw, ih, U);

  /* ── ASPECT-RATIO GATE - the validation the area gates cannot express ────────
     MIN_BOX_AREA_FRAC / MAX_BOX_AREA_FRAC / MIN_BOX_DIM_FRAC above already reject boxes
     that are too small, too large, or too thin in either axis. None of them can reject a
     box that is a plausible SIZE but an implausible SHAPE - and that is the crop that
     does real damage, because it survives every existing check and gets sent to Decart
     as if it were a garment.

     The two cases seen in practice are a hard-shadow strip or a background seam merging
     into the blob (a long horizontal band, ratio well under 0.35) and a full-height
     column of wall caught beside the subject (a narrow vertical bar, ratio over ~4). A
     real upper- or lower-body garment photographed flat or worn sits comfortably inside
     those bounds. Rejecting here rather than downstream means the caller's existing
     "no garments found" UI (gdEmpty) handles it - the user is told to re-crop, instead
     of the model being handed a strip of wall and inventing a garment to match it. */
  const ASPECT_MIN = 0.35;   // w/h - flatter than this is a shadow band, not a garment
  const ASPECT_MAX = 4.0;    // w/h - narrower than this is a wall/door edge column
  const shaped = natural.filter((b) => {
    if (!b.width || !b.height) return false;
    const ratio = b.width / b.height;
    const ok = ratio >= ASPECT_MIN && ratio <= ASPECT_MAX;
    if (!ok) {
      console.warn(`[PEAR] detectGarments: rejected ${b.label || "box"} on aspect ratio ` +
        `${ratio.toFixed(2)} (allowed ${ASPECT_MIN}-${ASPECT_MAX}) - ${b.width}x${b.height}px`);
    }
    return ok;
  });

  /* Confidence is scored on the SURVIVING set. Scoring before the aspect gate would let
     a rejected shadow band's high area-score carry the whole detection over the
     confidence bar, so a photo whose only "garment" was noise would still open the
     picker with nothing usable in it. */
  const best = shaped.reduce((m, b) => Math.max(m, b.score || 0), 0);
  if (best < U.MIN_CONFIDENCE) return [];
  return shaped.slice(0, U.MAX_BOXES);
}

/**
 * Turn raw foreground boxes into labelled garments. A tall, person-shaped blob is
 * an outfit worn on a body → split it horizontally into a Top and a Bottom zone
 * (so both get their own viewfinder bracket, like the reference). Very tall narrow
 * blobs read as Full-body (dress/jumpsuit); everything else is classified by
 * geometry. Each returned box carries { garmentType, label }.
 */
function refineGarments(boxes, iw, ih, U) {
  const out = [];
  for (const b of boxes) {
    const aspect = b.width / Math.max(1, b.height);
    // A person-shaped blob (tall + narrow) = a full worn OUTFIT. Even when it fills
    // the frame we no longer emit a dead-end "Full-body" box - we mark it as an
    // outfit carrying TOP and BOTTOM sub-regions so the UI can toggle between them.
    const person = b.height >= ih * U.PERSON_MIN_HEIGHT_FRAC && aspect <= U.PERSON_MAX_ASPECT;
    if (person) {
      out.push(makeOutfit(b, U));
    } else {
      const c = classifyGarment(b, iw, ih, U);
      out.push({ ...b, garmentType: c.garmentType, label: c.label });
    }
  }
  return out;
}

/**
 * Build an OUTFIT detection from a full-figure box: one box that keeps the whole
 * figure bounds plus geometric TOP (upper ~SPLIT_TOP_FRAC) and BOTTOM (from
 * ~SPLIT_BOTTOM_FRAC down to the feet) sub-regions. The UI's TOP/BOTTOM toggle
 * snaps the visible bracket - and the crop - between these two sub-regions.
 */
function makeOutfit(b, U) {
  const topH = Math.round(b.height * U.SPLIT_TOP_FRAC);
  const botY = b.ymin + Math.round(b.height * U.SPLIT_BOTTOM_FRAC);
  const botH = (b.ymin + b.height) - botY;
  return {
    xmin: b.xmin, ymin: b.ymin, width: b.width, height: b.height, score: b.score,
    outfit: true, garmentType: "upper_body", label: "Top Garment",
    topBounds:    { xmin: b.xmin, ymin: b.ymin, width: b.width, height: topH },
    bottomBounds: { xmin: b.xmin, ymin: botY,   width: b.width, height: botH },
  };
}

/** Label a single box from its geometry: Full-body (tall+narrow) / Bottom / Top. */
function classifyGarment(box, iw, ih, U) {
  const aspect = box.width / Math.max(1, box.height);
  const cy     = (box.ymin + box.height / 2) / ih;
  const hFrac  = box.height / ih;
  if (hFrac >= U.FULLBODY_MIN_HEIGHT_FRAC && aspect < 0.72) return { garmentType: "upper_body", label: "Full-body" };
  if (aspect < 0.72 && cy > 0.45) return { garmentType: "lower_body", label: "Bottom" };
  return { garmentType: "upper_body", label: "Top" };
}

/** Separable morphological dilation by `r` pixels (closes small gaps in the mask). */
function dilateMask(mask, w, h, r) {
  if (!r || r < 1) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dx = -r; dx <= r; dx++) { const nx = x + dx; if (nx >= 0 && nx < w && mask[row + nx]) { on = 1; break; } }
      tmp[row + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let on = 0;
      for (let dy = -r; dy <= r; dy++) { const ny = y + dy; if (ny >= 0 && ny < h && tmp[ny * w + x]) { on = 1; break; } }
      out[y * w + x] = on;
    }
  }
  return out;
}

/**
 * Merge boxes that overlap strongly (IoU > iouThresh) or where one largely contains
 * another - collapses fragments of one garment while keeping distinct items apart.
 * @param {Array<{x:number,y:number,w:number,h:number,area:number}>} boxes (sorted by area desc)
 * @param {number} iouThresh
 * @returns {Array} merged boxes
 */
function mergeBoxes(boxes, iouThresh) {
  const out = [];
  for (const b of boxes) {
    let merged = false;
    for (const o of out) {
      const ix = Math.max(b.x, o.x), iy = Math.max(b.y, o.y);
      const ax = Math.min(b.x + b.w, o.x + o.w), ay = Math.min(b.y + b.h, o.y + o.h);
      const iw = Math.max(0, ax - ix), ih = Math.max(0, ay - iy);
      const inter = iw * ih;
      if (inter <= 0) continue;
      const iou = inter / (b.w * b.h + o.w * o.h - inter);
      const contain = inter / Math.min(b.w * b.h, o.w * o.h);   // fraction of the smaller box covered
      if (iou > iouThresh || contain > 0.72) {
        const x0 = Math.min(b.x, o.x), y0 = Math.min(b.y, o.y);
        const x1 = Math.max(b.x + b.w, o.x + o.w), y1 = Math.max(b.y + b.h, o.y + o.h);
        o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0; o.area += b.area;
        merged = true; break;
      }
    }
    if (!merged) out.push({ ...b });
  }
  return out;
}

/**
 * Guess whether a boxed garment is a top or a bottom. Bottoms (trousers/shorts) are
 * typically tall + narrow and sit lower in frame; everything else defaults to a top.
 * A best-effort heuristic - the generic custom prompt keeps either choice safe.
 * @returns {"upper_body"|"lower_body"}
 */
function guessGarmentType(box, iw, ih) {
  const aspect = box.width / Math.max(1, box.height);
  const centerY = (box.ymin + box.height / 2) / ih;
  if (aspect < 0.72 && centerY > 0.45) return "lower_body";
  return "upper_body";
}

/**
 * Crop a box from the source image to a padded, downscaled JPEG data URL and compute
 * the crop's average garment colour (skipping near-white background remnants). The
 * data URL is what gets handed to rtClient.set({ image }) at go-live.
 * @param {HTMLImageElement} img
 * @param {{xmin:number,ymin:number,width:number,height:number}} box  (natural coords, already padded)
 * @returns {{dataUrl:string, color:string, aspect:number}}
 */
/**
 * Mild in-place unsharp mask (3x3) on a canvas context - lifts the edge gradients of
 * logos/prints/text against the fabric so they read as sharper landmarks in the
 * reference image handed to Lucy. RGB only; alpha is passed through. Border pixels drop
 * the missing neighbour weights (they're background, so the slight brightening is moot).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w @param {number} h
 * @param {number} amount  0 = identity; ~0.6 mild; >1.2 starts adding halos Lucy will copy
 */
function sharpenCrop(ctx, w, h, amount) {
  const src = ctx.getImageData(0, 0, w, h), out = ctx.createImageData(w, h);
  const s = src.data, d = out.data, c = 1 + 4 * amount, n = -amount;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) {
      let v = s[i+k]*c
        + (x>0 ? s[i-4+k]*n : 0) + (x<w-1 ? s[i+4+k]*n : 0)
        + (y>0 ? s[i-w*4+k]*n : 0) + (y<h-1 ? s[i+w*4+k]*n : 0);
      d[i+k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    d[i+3] = s[i+3];
  }
  ctx.putImageData(out, 0, 0);
}

function cropRegion(img, box) {
  const U = CONFIG.UPLOAD;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;

  const sx = Math.max(0, Math.min(box.xmin, iw - 1));
  const sy = Math.max(0, Math.min(box.ymin, ih - 1));
  const sw = Math.max(1, Math.min(box.width,  iw - sx));
  const sh = Math.max(1, Math.min(box.height, ih - sy));

  const scale = Math.min(1, U.CROP_MAX_DIM / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));

  const cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

  let color = "#8a8f98";
  try { color = averageColor(ctx, cw, ch); } catch (_) {}

  // Sharpen AFTER sampling the average colour so the halo pixels don't skew it.
  try { if (U.SHARPEN_AMOUNT > 0) sharpenCrop(ctx, cw, ch, U.SHARPEN_AMOUNT); } catch (_) {}

  let dataUrl;
  try { dataUrl = cv.toDataURL("image/jpeg", U.CROP_QUALITY); }
  catch (_) { dataUrl = img.src; }   // tainted-canvas fallback: hand back the original

  return { dataUrl, color, aspect: sw / sh };
}

/** Average colour of a canvas (skips near-white pixels so flat-lay bg doesn't wash it out). */
function averageColor(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let r = 0, g = 0, b = 0, n = 0;
  const step = 4 * Math.max(1, Math.floor((w * h) / 4000));   // sub-sample ~4k pixels
  for (let i = 0; i < data.length; i += step) {
    const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
    if (A < 128) continue;
    if (R > 244 && G > 244 && B > 244) continue;               // skip near-white background
    r += R; g += G; b += B; n++;
  }
  if (!n) return "#8a8f98";
  const toHex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/* ── self-contained studio garment SVG ───────────────────────────────────────
   catalog.js is not loaded in the PEAR demo, so this duplicates the same
   shape data and rendering logic locally.  Output is always a white-background
   flat-lay with a CSS drop-shadow - no Unsplash, no model, no background. */
const _SHIRT_PATHS = {
  sleeveless:   "M92 50 Q110 64 128 50 L144 62 Q151 92 151 122 L151 236 L69 236 L69 122 Q69 92 76 62 Z",
  short_sleeve: "M88 50 Q110 66 132 50 L170 68 L188 122 L166 130 L152 106 L152 236 L68 236 L68 106 L54 130 L32 122 L50 68 Z",
  long_sleeve:  "M88 50 Q110 66 132 50 L170 68 L198 204 L170 212 L152 108 L152 236 L68 236 L68 108 L50 212 L22 204 L50 68 Z",
};
const _PANT_PATHS = {
  slim:    "M66 44 L154 44 L150 238 L124 238 L111 120 L96 238 L70 238 Z",
  regular: "M62 44 L158 44 L156 238 L120 238 L110 124 L100 238 L64 238 Z",
  wide:    "M58 44 L162 44 L172 238 L138 238 L112 126 L108 126 L82 238 L48 238 Z",
};

function _mix(hex, p) {
  const f = parseInt(hex.slice(1), 16), t = p < 0 ? 0 : 255, a = Math.abs(p);
  const R = f >> 16, G = (f >> 8) & 0xff, B = f & 0xff;
  const m = (c) => Math.round((t - c) * a) + c;
  return "#" + (0x1000000 + m(R) * 0x10000 + m(G) * 0x100 + m(B)).toString(16).slice(1);
}

function _garmentSVG(item) {
  const isShirt = item.type === "shirt";
  const d = isShirt ? _SHIRT_PATHS[item.subType] : _PANT_PATHS[item.subType];
  if (!d) return `<svg viewBox="0 0 220 260"><rect width="220" height="260" fill="${item.color}"/></svg>`;

  const lite = _mix(item.color,  0.30);
  const base = item.color;
  const mid  = _mix(item.color, -0.15);
  const dark = _mix(item.color, -0.38);
  const ink  = _mix(item.color, -0.54);
  const pid  = "t" + item.id;

  let det = "";
  if (isShirt) {
    det += `<ellipse cx="110" cy="55" rx="20" ry="7" fill="${mid}" stroke="${ink}" stroke-width="1.5" opacity="0.55"/>`;
    if (item.subType === "sleeveless") {
      det += `<path d="M91 52 Q76 62 69 86" stroke="${ink}" stroke-width="1.3" opacity="0.28" fill="none"/>`;
      det += `<path d="M129 52 Q144 62 151 86" stroke="${ink}" stroke-width="1.3" opacity="0.28" fill="none"/>`;
    } else {
      det += `<path d="M88 52 L50 68" stroke="${ink}" stroke-width="1.4" opacity="0.26" fill="none"/>`;
      det += `<path d="M132 52 L170 68" stroke="${ink}" stroke-width="1.4" opacity="0.26" fill="none"/>`;
      det += `<path d="M152 108 Q151 120 152 132" stroke="${ink}" stroke-width="1.3" opacity="0.18" fill="none"/>`;
      det += `<path d="M68 108 Q69 120 68 132" stroke="${ink}" stroke-width="1.3" opacity="0.18" fill="none"/>`;
    }
    if (item.subType === "short_sleeve") {
      det += `<path d="M33 120 Q43 124 55 128" stroke="${ink}" stroke-width="1.8" opacity="0.32" fill="none"/>`;
      det += `<path d="M166 128 Q178 124 187 120" stroke="${ink}" stroke-width="1.8" opacity="0.32" fill="none"/>`;
    }
    if (item.subType === "long_sleeve") {
      det += `<path d="M192 142 Q189 150 186 158" stroke="${ink}" stroke-width="1.6" opacity="0.20" fill="none"/>`;
      det += `<path d="M28 142 Q31 150 34 158" stroke="${ink}" stroke-width="1.6" opacity="0.20" fill="none"/>`;
      det += `<path d="M166 208 L174 204" stroke="${ink}" stroke-width="2.2" opacity="0.38"/>`;
      det += `<path d="M44 208 L36 204" stroke="${ink}" stroke-width="2.2" opacity="0.38"/>`;
      det += `<path d="M163 212 L175 207" stroke="${ink}" stroke-width="1.1" opacity="0.22"/>`;
      det += `<path d="M45 212 L33 207" stroke="${ink}" stroke-width="1.1" opacity="0.22"/>`;
    }
    det += `<path d="M110 62 L110 232" stroke="${ink}" stroke-width="0.9" opacity="0.15"/>`;
    det += `<path d="M72 232 H148" stroke="${ink}" stroke-width="1.6" opacity="0.28"/>`;
    det += `<path d="M70 118 Q67 158 70 198" stroke="${ink}" stroke-width="3" opacity="0.07" fill="none"/>`;
    det += `<path d="M150 118 Q153 158 150 198" stroke="${ink}" stroke-width="3" opacity="0.07" fill="none"/>`;
  } else {
    const wl = item.subType === "wide" ? 58 : item.subType === "regular" ? 62 : 66;
    const wr = item.subType === "wide" ? 162 : item.subType === "regular" ? 158 : 154;
    const fly = item.subType === "wide" ? 128 : 124;
    const ky  = item.subType === "wide" ? 156 : 152;
    det += `<path d="M${wl} 44 H${wr}" stroke="${ink}" stroke-width="2.5" opacity="0.38"/>`;
    det += `<path d="M${wl+1} 58 H${wr-1}" stroke="${ink}" stroke-width="1.3" opacity="0.28"/>`;
    det += `<rect x="80"  y="44" width="5" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    det += `<rect x="107" y="44" width="6" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    det += `<rect x="135" y="44" width="5" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    det += `<path d="M110 60 L110 ${fly}" stroke="${ink}" stroke-width="1.6" opacity="0.28"/>`;
    det += `<path d="M73 70 Q69 80 72 93" stroke="${ink}" stroke-width="1.3" opacity="0.22" fill="none"/>`;
    det += `<path d="M147 70 Q151 80 148 93" stroke="${ink}" stroke-width="1.3" opacity="0.22" fill="none"/>`;
    det += `<path d="M77 ${ky} Q86 ${ky+4} 96 ${ky}" stroke="${ink}" stroke-width="1.1" opacity="0.18" fill="none"/>`;
    det += `<path d="M124 ${ky} Q133 ${ky+4} 143 ${ky}" stroke="${ink}" stroke-width="1.1" opacity="0.18" fill="none"/>`;
    det += `<path d="M70 232 H97" stroke="${ink}" stroke-width="1.7" opacity="0.28"/>`;
    det += `<path d="M123 232 H150" stroke="${ink}" stroke-width="1.7" opacity="0.28"/>`;
  }

  return `<svg viewBox="0 0 220 260" role="img" aria-label="${item.name}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="gf${pid}" x1="0.15" y1="0" x2="0.38" y2="1">
        <stop offset="0%"   stop-color="${lite}"/>
        <stop offset="45%"  stop-color="${base}"/>
        <stop offset="100%" stop-color="${dark}"/>
      </linearGradient>
      <linearGradient id="hl${pid}" x1="0.05" y1="0" x2="0.9" y2="1">
        <stop offset="0%"   stop-color="#fff" stop-opacity="0.28"/>
        <stop offset="50%"  stop-color="#fff" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.05"/>
      </linearGradient>
    </defs>
    <rect width="220" height="260" fill="#ffffff"/>
    <g style="filter:drop-shadow(0px 5px 14px rgba(0,0,0,0.13))">
      <path d="${d}" fill="url(#gf${pid})" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>
      <path d="${d}" fill="url(#hl${pid})"/>
    </g>
    ${det}
  </svg>`;
}

/* The image the "Now fitting" chip should show. Prefers the COMBINED composite when
   one exists, so the chip shows the shopper the same FRONT|BACK reference the model is
   actually working from - previously it showed only the front photo, which understated
   what the try-on had to work with and gave no hint that a back view was in play.
     · item.composite            - the data URL the widget stitched and handed over
     · item._compositeObjectUrl  - an object URL for a composite the fitting room built
                                   itself (catalog items, or a widget handover without one)
   Falls back to the plain front photo when neither exists (single-view garments). */
function thumbSrcOf(item) {
  if (!item) return "";
  return item.composite || item._compositeObjectUrl || item.img || "";
}

/** True when the chip is showing a wide FRONT|BACK composite rather than one photo. */
function thumbIsComposite(item) {
  return !!(item && (item.composite || item._compositeObjectUrl));
}

/* True while the chip should show the "finding/generating a back view" indicator.
   Structurally impossible to show alongside an actual composite, regardless of
   whether _awaitingBackCorrection/_compositeBuilding happen to still read true for
   some other reason (a stale flag some future edit forgets to clear) - once a real
   composite exists there is nothing left to wait for, full stop. */
function thumbIsPending(item) {
  if (!item || thumbIsComposite(item)) return false;
  return !!(item._awaitingBackCorrection || item._compositeBuilding);
}

function garmentThumb(item) {
  const base = "display:block;width:100%;height:100%;overflow:hidden;";
  const src = thumbSrcOf(item);
  if (src) {
    return `<span style="${base}"><img src="${src}" alt="${item.name}" loading="lazy" decoding="async"></span>`;
  }
  return `<span style="${base}background:#f7f7f8;">${_garmentSVG(item)}</span>`;
}

/* =============================================================================
   helpers
   ============================================================================= */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function setConn(state) {
  const b = $("engineBadge");
  if (!b) return;
  b.classList.remove("live", "mock");
  b.style.color = "";
  if (state === "connected" || state === "generating") {
    b.classList.add("live");
    b.textContent = "● מחובר ל-API חי";
  } else if (state === "connecting") {
    b.style.color = "#d08a17";
    b.textContent = "● מתחבר…";
  } else if (state === "reconnecting") {
    /* A REAL SDK state (StreamSession.scheduleReconnect(), stream-session.js), not a
       hypothetical one: the SDK retries a dropped mid-session connection internally
       (p-retry, 5 attempts, 1s/2s/4s/8s/10s backoff) BEFORE ever surfacing a failure to
       this file. Distinguished from the initial "connecting" text so the shopper sees
       "recovering" rather than "starting a new session" - the live overlay and video
       element are untouched throughout, only this badge and the one-time toast below
       change. */
    b.style.color = "#d08a17";
    b.textContent = "● מתחבר מחדש…";
  } else if (state === "error" || state === "disconnected") {
    b.classList.add("mock");
    b.textContent = "● לא מחובר";
  } else {
    b.textContent = "●";
  }
}

let toastTimer;
/**
 * Show a transient toast message (auto-dismissed after TOAST_DURATION_MS).
 * @param {string} html Inner HTML for the toast (simple markup like <b> allowed).
 */
function toast(html) {
  const t = $("toast");
  t.innerHTML = html; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), TOAST_DURATION_MS);
}

const COLOR_NAMES = [
  ["black", 0x111114], ["charcoal", 0x2b2b30], ["navy", 0x22324f], ["royal blue", 0x0b3c95],
  ["blue", 0x1f6feb], ["cobalt", 0x3b5bdb], ["teal", 0x149c7a], ["green", 0x566b3e],
  ["red", 0xc2452f], ["lavender", 0x8e7bd0], ["tan", 0xa8794f], ["grey", 0x8a8f98],
  ["light grey", 0xb8c0cc], ["slate blue", 0x3f5a8a], ["off-white", 0xd8d4cb], ["steel", 0x6e7681],
];
function colorName(hex) {
  const f = parseInt(hex.replace("#", ""), 16);
  const r = (f >> 16) & 255, g = (f >> 8) & 255, b = f & 255;
  let best = "neutral", bd = Infinity;
  for (const [name, c] of COLOR_NAMES) {
    const dr = ((c >> 16) & 255) - r, dg = ((c >> 8) & 255) - g, db = (c & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

/* =============================================================================
   wiring
   ============================================================================= */
/**
 * Bootstrap: wire form inputs (live recalc + Enter-to-proceed), navigation
 * buttons, catalog/swap delegation, and the page-lifecycle teardown listeners
 * that stop billing the moment the user leaves or hides the tab.
 * @returns {void}
 */
/* =============================================================================
   PEAR Live-Action Gallery - client-side "Live Photo" history (zero server cost)
   ─────────────────────────────────────────────────────────────────────────
   Each fit stores TWO things:
     • a tiny JPEG poster  → persisted to localStorage (survives reload)
     • the 5s VTON clip    → an in-memory object URL built from the SAME
                              MediaRecorder blob the Replay Zone already records
                              (see finalizeRecording). No second recorder, no
                              upload/download, so LIVE_DURATION_MS is untouched.
   Blob URLs can't be serialized, so on reload tiles gracefully fall back to the
   static poster (Apple Live Photos degrade the same way). Render is pure DOM.
   ============================================================================= */
const GALLERY_KEY = "pear_fit_gallery";
const GALLERY_MAX = 18;                 // poster cap - stays well under the localStorage quota
const CLIP_MAX = 12;                    // in-memory clip cap - bounds blob memory per session

const liveClips = new Map();            // ts → object URL of the 5s clip (this session only)
let lastFitTs = null;                   // ts of the entry awaiting its clip from finalizeRecording
const compareSel = new Set();           // ts of fits picked for the Compare overlay (max 2)
let activeClipTs = null;                // ts of the clip currently replaying in #aiVideo

const escHtml = (s) => String(s == null ? "" : s)
  .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function readGallery() {
  try { const a = JSON.parse(localStorage.getItem(GALLERY_KEY)); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function writeGallery(arr) {
  try { localStorage.setItem(GALLERY_KEY, JSON.stringify(arr)); return true; }
  catch (_) {
    // quota exceeded → drop oldest entries until it fits
    while (arr.length > 1) {
      arr.shift();
      try { localStorage.setItem(GALLERY_KEY, JSON.stringify(arr)); return true; } catch (_) {}
    }
    return false;
  }
}

/* Revoke + forget a clip URL for a given timestamp (frees blob memory). */
function dropClip(ts) {
  const url = liveClips.get(ts);
  if (url) { try { URL.revokeObjectURL(url); } catch (_) {} liveClips.delete(ts); }
}

/* Grab the current dressed frame as a small JPEG data-URL (the poster). Prefers
   the live AI-edited stream; falls back to the (mirrored) raw webcam. Returns
   null if no frame is available - capture must never throw into teardown. */
function captureLiveFrame() {
  const ai = $("aiVideo");
  const webcam = $("webcam");
  let src = null, mirror = false, w = 0, h = 0;
  if (ai && ai.videoWidth > 0 && ai.style.display !== "none") {
    src = ai; w = ai.videoWidth; h = ai.videoHeight;            // already correctly oriented
  } else if (webcam && webcam.videoWidth > 0) {
    src = webcam; w = webcam.videoWidth; h = webcam.videoHeight; mirror = true;  // selfie-mirror
  }
  if (!src || !w || !h) return null;

  const maxW = 360;
  const scale = Math.min(1, maxW / w);
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const cnv = document.createElement("canvas");
  cnv.width = cw; cnv.height = ch;
  const ctx = cnv.getContext("2d");
  if (mirror) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
  try { ctx.drawImage(src, 0, 0, cw, ch); } catch (_) { return null; }
  try { return cnv.toDataURL("image/jpeg", 0.7); } catch (_) { return null; }
}

/* Friendly name for the look currently being worn (full outfit when present). */
function currentLookName() {
  const look = resolveLook();
  if (look) return `${look.top.name} + ${look.bottom.name}`;
  return activeItem && activeItem.name ? activeItem.name : "Look";
}

/* Public helper: push a look (poster) into history + persist + re-render.
   Returns the new entry's ts so the recorder can attach its clip afterwards. */
function saveFitToGallery(imageSrc, garmentName, size, itemId) {
  if (!imageSrc) return null;
  const ts = Date.now();
  const arr = readGallery();
  // itemId lets the gallery modal's "Try again live" restore the exact garment
  // and open a fresh 5s session. null when the look isn't a single catalog item.
  // Formatted once here, at the single write point - every reader (the gallery
  // tile badge, the compare panel, the lightbox) pulls it.size straight off the
  // stored record, same as #final-size-text already does for the profile panel.
  arr.push({ img: imageSrc, name: garmentName || "Look", size: formatSizeLabel(size) || "-", ts,
             itemId: (itemId == null ? null : itemId) });
  while (arr.length > GALLERY_MAX) { const old = arr.shift(); dropClip(old.ts); }
  writeGallery(arr);
  renderGallery(arr);
  toast("👗 הלוק נשמר בגלריית המדידות");
  return ts;
}

/* Capture the poster + save the current live look. Wrapped by callers in
   try/catch so a capture failure can never delay billing teardown. The matching
   5s clip is attached later by finalizeRecording → attachClipToLastFit. */
function addFitFromLive() {
  const img = captureLiveFrame();
  if (!img) return;
  const size = activeTryOnSize || currentUserSize || "-";
  lastFitTs = saveFitToGallery(img, currentLookName(), size);
}

/* Reuse the Replay Zone's recorded Blob as the gallery's Live Photo. We mint a
   SEPARATE object URL so clearRecording()'s revoke of recordedUrl can't break it. */
function attachClipToLastFit(blob) {
  if (lastFitTs == null || !blob || !blob.size) { lastFitTs = null; return; }
  let url = null;
  try { url = URL.createObjectURL(blob); } catch (_) { lastFitTs = null; return; }
  liveClips.set(lastFitTs, url);
  // bound in-memory clips: revoke the oldest beyond CLIP_MAX
  while (liveClips.size > CLIP_MAX) dropClip(liveClips.keys().next().value);
  lastFitTs = null;
  renderGallery();                       // upgrade the just-saved tile: poster → Live Photo
}

/* Build the swipe tray (newest first) and toggle the pod visibility. Tiles with
   a live clip render an autoplay-on-hover <video>; the rest show the poster. */
function renderGallery(arr) {
  const pod = $("pearGallery"), track = $("galleryTrack");
  if (!pod || !track) return;
  const data = arr || readGallery();
  if (!data.length) { track.innerHTML = ""; pod.hidden = true; return; }
  pod.hidden = false;
  track.innerHTML = data.map((it, idx) => ({ it, idx })).reverse().map(({ it, idx }, i) => {
    const clip = liveClips.get(it.ts);
    // Live Photo tiles autoplay-loop like animated badges; poster-only tiles
    // (after a reload, when the in-memory clip is gone) fall back to the image.
    const media = clip
      ? `<video class="lgi-video" src="${clip}" poster="${it.img}" autoplay loop muted playsinline preload="auto"></video>`
      : `<img src="${it.img}" alt="${escHtml(it.name)} ${escHtml(it.size)}" loading="lazy">`;
    const cls = "live-gallery-item" + (clip ? " has-clip" : "") +
      (it.ts === activeClipTs ? " is-playing" : "") + (compareSel.has(it.ts) ? " is-selected" : "");
    return `<button class="${cls}" type="button" data-idx="${idx}" data-ts="${it.ts}"${clip ? ` data-video-src="${clip}"` : ""} style="--gi:${i}">
       <span class="live-gallery-item__media">${media}</span>
       <span class="lgi-select" role="checkbox" aria-checked="${compareSel.has(it.ts)}" title="בחר להשוואה">✓</span>
       <span class="live-gallery-item__badge">
         <span class="live-gallery-item__name">${escHtml(it.name)}</span>
         <span class="live-gallery-item__size">${escHtml(it.size)}</span>
       </span>
     </button>`;
  }).join("");

  // reconcile selection with the freshly built DOM: drop picks that no longer exist
  [...compareSel].forEach((ts) => { if (!data.some((d) => d.ts === ts)) compareSel.delete(ts); });
  syncCompareUI();
}

/* Toggle whether the tile's clip is playing-highlighted (no re-render → no flash). */
function markActiveTile() {
  document.querySelectorAll(".live-gallery-item").forEach((el) =>
    el.classList.toggle("is-playing", Number(el.dataset.ts) === activeClipTs));
}

/* Compare selection (max two). Updates tile state + the floating Compare pill. */
function toggleCompareSelect(ts) {
  if (compareSel.has(ts)) compareSel.delete(ts);
  else if (compareSel.size >= 2) { toast("ניתן להשוות שתי מדידות בלבד"); return; }
  else compareSel.add(ts);
  syncCompareUI();
  // Open the split-screen comparison the instant a 2nd look is picked - no extra
  // tap on the "Compare" pill (which now just acts as a re-open affordance).
  if (compareSel.size === 2) openCompareOverlay();
}
function syncCompareUI() {
  document.querySelectorAll(".live-gallery-item").forEach((el) => {
    const on = compareSel.has(Number(el.dataset.ts));
    el.classList.toggle("is-selected", on);
    const sb = el.querySelector(".lgi-select");
    if (sb) sb.setAttribute("aria-checked", on ? "true" : "false");
  });
  const bar = $("compareBar");
  if (bar) bar.hidden = compareSel.size !== 2;
}

/* ── Compare overlay: page-scroll lock ───────────────────────────────────────
   .pear-compare-overlay is position:fixed, so without this a mobile swipe over the
   comparison scrolls the catalog UNDERNEATH it - the split-screen appears to drift
   off its own backdrop. Freeze the page while the modal owns the screen and restore
   the caller's original value verbatim on close. Null = not currently locked, which
   also makes a second openCompareOverlay() (the "Compare" pill re-opening an already
   open overlay) a no-op instead of clobbering the saved value with "hidden". */
let compareScrollLock = null;
function lockPageScroll() {
  if (compareScrollLock !== null) return;          // already locked - don't overwrite the saved value
  compareScrollLock = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}
function unlockPageScroll() {
  if (compareScrollLock === null) return;
  document.body.style.overflow = compareScrollLock;
  compareScrollLock = null;
}

/* ── Smooth-scroll the side-by-side comparison into view ─────────────────────
   Called the moment a 2nd measurement is picked (via openCompareOverlay).

   CONTAINER RESOLUTION: #pearCompare is `position: fixed; inset: 0` (style.css
   .pear-compare-overlay), so it is already viewport-anchored and contributes
   nothing to document scroll - window.scrollTo()/scrollIntoView() on it (or on
   document/body) would be a guaranteed no-op, which is exactly why a plain
   window-scroll approach can't work here. The element that genuinely scrolls is
   .pcmp__panel (`max-height: 92vh; overflow-y: auto`), so instead of manually
   walking up to find it, we call scrollIntoView() on #compareSplit - the native
   API already walks the ancestor chain and scrolls whichever real container
   (panel, or the window, on a layout where nothing overflows) needs it. That is
   a real scroll on mobile, where the two cells stack tall and the second
   measurement would otherwise sit below the fold; on desktop the panel usually
   fits and this correctly resolves to a no-op.

   THE ACTUAL BUG (deployed build): .pcmp__panel plays its own CSS entrance
   animation on open (galleryItemIn .45s: translateY(14px) scale(.96) → none).
   The previous fix used two nested requestAnimationFrame calls (~2 frames,
   ~32ms) as its "DOM is laid out" check - but that only proves a layout/paint
   has happened, NOT that the panel's transform animation has settled. Calling
   scrollIntoView() while an ANCESTOR is still mid CSS-transform computes the
   scroll target from that transient (shrunk/shifted) geometry, not the final
   one - so on the one case that matters (mobile, panel taller than 92vh, an
   internal scroll is actually required) it was landing on the wrong offset,
   which read as "the auto-scroll does nothing." Fix: wait for the entrance
   animation to actually finish (animationend), with a timeout fallback in case
   the event is ever missed (reduced motion skips it entirely; some engines can
   drop `animation: … both` events), THEN measure + scroll.

   Honours prefers-reduced-motion (instant jump, same final position; also
   short-circuits straight to a single rAF since there's no entrance transform
   to race against). Guards scrollIntoView's existence for any environment
   where it might not be implemented. */
const PANEL_ENTRANCE_MS = 520;   // .pcmp__panel's galleryItemIn is .45s - padded well past that
function scrollCompareIntoView() {
  const split = $("compareSplit");
  if (!split || typeof split.scrollIntoView !== "function") return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduce ? "auto" : "smooth";

  const doScroll = () => {
    try {
      // block:"start"  → comparison top-aligned in .pcmp__panel (the real scroll container)
      // inline:"nearest" → never nudges horizontally, so the RTL layout is left untouched
      split.scrollIntoView({ behavior, block: "start", inline: "nearest" });
    } catch (_) {
      try { split.scrollIntoView(true); } catch (_) {}   // legacy Safari: no options object
    }
  };

  const panel = $("pearCompare")?.querySelector(".pcmp__panel");
  if (reduce || !panel) {
    // No entrance transform to race (motion reduced, or markup changed) -
    // one rAF is enough to guarantee the just-injected DOM has laid out.
    requestAnimationFrame(doScroll);
    return;
  }
  let done = false;
  const fire = () => { if (done) return; done = true; doScroll(); };
  panel.addEventListener("animationend", fire, { once: true });
  setTimeout(fire, PANEL_ENTRANCE_MS);   // safety net if animationend never fires
}

/* Build + reveal the side-by-side Compare overlay from the two selected fits. */
function openCompareOverlay() {
  const data = readGallery();
  const picks = [...compareSel].map((ts) => data.find((d) => d.ts === ts)).filter(Boolean);
  if (picks.length !== 2) return;
  const split = $("compareSplit"), ov = $("pearCompare");
  if (!split || !ov) return;
  split.innerHTML = picks.map((it) => {
    const clip = liveClips.get(it.ts);
    const media = clip
      ? `<video src="${clip}" autoplay loop muted playsinline></video>`
      : `<img src="${it.img}" alt="${escHtml(it.name)}">`;
    return `<div class="pcmp__cell">
       <div class="pcmp__media">${media}</div>
       <div class="pcmp__label"><b>${escHtml(it.name)}</b><span class="pcmp__size">${escHtml(it.size)}</span></div>
     </div>`;
  }).join("");
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add("show"));
  lockPageScroll();          // mobile: swipes now belong to the panel, not the page behind it
  scrollCompareIntoView();   // smooth-scroll the side-by-side in once it has laid out
}
function closeCompare() {
  const ov = $("pearCompare");
  if (!ov || ov.hidden) return;
  ov.classList.remove("show");
  ov.hidden = true;
  unlockPageScroll();                     // hand scrolling back to the page
  const split = $("compareSplit");
  if (split) split.innerHTML = "";        // stop the two playing clips
}

/* Render function: read persisted history on init and build the DOM. */
function loadGallery() { renderGallery(readGallery()); }

function clearGallery() {
  liveClips.forEach((url) => { try { URL.revokeObjectURL(url); } catch (_) {} });
  liveClips.clear();
  compareSel.clear();
  activeClipTs = null;
  const bar = $("compareBar"); if (bar) bar.hidden = true;
  try { localStorage.removeItem(GALLERY_KEY); } catch (_) {}
  renderGallery([]);
  toast("גלריית המדידות נוקתה");
}

/* Leave the clip-replay view: pause + detach the history clip from #aiVideo and
   drop the .show-clip state so the CSS state classes govern the camera again. */
function exitClipReplay() {
  const ai = $("aiVideo");
  if (ai && ai.getAttribute("src")) {
    try { ai.pause(); } catch (_) {}
    ai.removeAttribute("src");
    try { ai.load(); } catch (_) {}
  }
  card().classList.remove("show-clip");
  activeClipTs = null;
  markActiveTile();
}

/* Inter-capsule replay: load a history clip into the MAIN top player (#aiVideo)
   and loop it. Refuses to hijack a paid live session. Poster-only items (no clip
   after reload) fall back to the lightbox image. */
function playClipInMainPlayer(url, idx, ts) {
  if (isLive()) { toast("עצור מדידה חיה כדי לצפות בהיסטוריה"); return; }
  const ai = $("aiVideo");
  if (!ai || !url) { if (idx != null) openFitLightbox(idx); return; }

  resetToLive();                       // clean any frozen result / stale replay first (clears activeClipTs)
  resetAiFeedVisibility();             // a clip is different content - it must not inherit
                                       // the conditioning gate's opacity from a past session
  ai.srcObject = null;                 // detach any (dead) WebRTC stream
  ai.src = url;
  ai.loop = true; ai.muted = true; ai.playsInline = true;
  card().classList.remove("show-result");
  card().classList.add("show-clip");   // CSS reveals #aiVideo without live billing semantics
  ai.play().catch(() => {});

  activeClipTs = (ts == null ? null : ts);   // glow the source tile in the tray
  markActiveTile();

  const cc = $("cameraCard");
  if (cc) cc.scrollIntoView({ behavior: "smooth", block: "center" });
  toast("▶ מציג מדידה קודמת");
}

/* The fit currently open in the large modal (so the delegated action buttons
   know which history entry they act on). */
let lightboxIt = null;

/* Close the large fit modal: stop any inline clip + forget the open entry. */
function closeFitLightbox() {
  const lb = $("pearLightbox");
  if (!lb) return;
  lb.classList.remove("show");
  const stage = lb.querySelector(".pear-lightbox__stage");
  if (stage) stage.innerHTML = "";     // stop any playing clip on close
  lightboxIt = null;
}

/* Tap a history card → the large interactive modal (Image 1 layout): the saved
   high-quality snapshot/clip, garment name, size badge, and the action row:
     • צפה שוב · Replay      - loop the saved clip for FREE (zero tokens)
     • מדוד שוב · Try again live - restore the garment + open a fresh 5s session
     • הורד · Download       - save the recorded clip (only when one exists) */
function openFitLightbox(idx) {
  const it = readGallery()[idx];
  if (!it) return;
  lightboxIt = it;
  let lb = $("pearLightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "pearLightbox";
    lb.className = "pear-lightbox";
    lb.innerHTML =
      `<div class="pear-lightbox__backdrop" data-lb-close></div>` +
      `<figure class="pear-lightbox__fig">` +
        `<button class="pear-lightbox__close" type="button" aria-label="סגור" data-lb-close>×</button>` +
        `<div class="pear-lightbox__stage"></div>` +
        `<figcaption class="pear-lightbox__cap">` +
          `<span class="pear-lightbox__name"></span>` +
          `<span class="pear-lightbox__size"></span>` +
        `</figcaption>` +
        `<div class="pear-lightbox__actions">` +
          `<button class="plb-btn plb-btn--replay" type="button" data-lb-replay hidden>` +
            `<span class="plb-btn__icon" aria-hidden="true">↺</span><span>צפה שוב</span><span class="plb-btn__en">Replay</span></button>` +
          `<button class="plb-btn plb-btn--live" type="button" data-lb-live>` +
            `<span class="plb-btn__icon" aria-hidden="true">▶</span><span>מדוד שוב</span><span class="plb-btn__en">Try again live</span></button>` +
          `<a class="plb-btn plb-btn--dl" data-lb-dl hidden download>` +
            `<span class="plb-btn__icon" aria-hidden="true">⤓</span><span>הורד</span><span class="plb-btn__en">Download</span></a>` +
        `</div>` +
      `</figure>`;
    document.body.appendChild(lb);
    lb.addEventListener("click", (e) => {
      if (e.target.closest("[data-lb-close]"))  { closeFitLightbox(); return; }
      if (e.target.closest("[data-lb-replay]")) {
        // FREE replay - loop the saved clip in the main player, then close the modal.
        const cur = lightboxIt; const url = cur ? liveClips.get(cur.ts) : null;
        if (url) { closeFitLightbox(); playClipInMainPlayer(url, readGallery().findIndex((g) => g.ts === cur.ts), cur.ts); }
        return;
      }
      if (e.target.closest("[data-lb-live]"))   { const cur = lightboxIt; closeFitLightbox(); replayFitLive(cur); return; }
      // [data-lb-dl] is a plain <a download> - let the browser handle it.
    });
  }
  const clip = liveClips.get(it.ts);
  lb.querySelector(".pear-lightbox__stage").innerHTML = clip
    ? `<video class="pear-lightbox__video" src="${clip}" autoplay loop muted playsinline controls></video>`
    : `<img class="pear-lightbox__img" src="${it.img}" alt="${escHtml(it.name)}">`;
  lb.querySelector(".pear-lightbox__name").textContent = it.name;
  lb.querySelector(".pear-lightbox__size").textContent = it.size;

  // Replay + Download only make sense when the in-memory clip still exists
  // (it's gone after a reload - posters survive, blobs don't).
  const replayBtn = lb.querySelector("[data-lb-replay]");
  if (replayBtn) replayBtn.hidden = !clip;
  const dlBtn = lb.querySelector("[data-lb-dl]");
  if (dlBtn) {
    if (clip) {
      dlBtn.hidden = false; dlBtn.href = clip;
      /* The export contract reaches the gallery too - this used to be the one saved-clip
         path that could still hand out a .webm, and it read recorderMime to decide, which
         is wrong twice over: a gallery clip can outlive the session that recorded it, so
         by the time this runs recorderMime may describe a DIFFERENT recording (or have
         been nulled by clearRecording). The extension is a constant now, not a guess. */
      dlBtn.download = `PEAR-fit-${it.ts}.${EXPORT_EXT}`;
      if (IS_MOBILE) dlBtn.target = "_blank";
    } else { dlBtn.hidden = true; dlBtn.removeAttribute("href"); }
  }
  lb.classList.add("show");
}

/* "Try again live" - restore the exact garment this fit was captured with (when
   still in the catalog) and open a fresh, optimized 5-second live session. */
function replayFitLive(it) {
  if (isDemoLocked()) { toast(t("demoAlreadyUsed")); return; }
  if (isLive()) { toast("עצור מדידה חיה כדי להתחיל מחדש"); return; }
  if (it && it.itemId != null) {
    const p = PEAR_CATALOG.find((x) => x.id === it.itemId);
    if (p) setActiveItem(toItem(p));               // sets active garment + resets to live standby
  }
  if (!activeItem) { toast("בחר בגד מהקטלוג כדי למדוד שוב"); return; }
  const cc = $("cameraCard");
  if (cc) cc.scrollIntoView({ behavior: "smooth", block: "center" });
  goLive();                                         // fresh 5s WebRTC try-on (billing starts here)
}

/* Retake - stop a running session (auto-saving the look) or clear a frozen
   result, then return to the live-camera standby. */
function onRetake() {
  if (isLive()) {
    stopLive();   // saves, then resets the button - see stopLive
  } else if (isDemoLocked()) {
    toast(t("demoAlreadyUsed"));
    return;
  } else {
    resetToLive();
  }
  const cc = $("cameraCard");
  if (cc) cc.scrollIntoView({ behavior: "smooth", block: "center" });
}

function init() {
  setupLangToggle();   // global page-level toggle - wired regardless of demo-gate state below
  // (Floating contextual help beacon: help-widget.js is loaded as its own
  // <script type="module"> in index.html and self-initializes independently
  // - nothing to wire here.)

  // One-time public demo - strict check BEFORE anything else runs: no camera
  // wiring, no identity gate, no size-form listeners, nothing. A returning
  // visitor who already completed their demo measurement sees only the
  // locked screen. (No-op outside DEMO_MODE - see isDemoLocked().)
  if (isDemoLocked()) {
    demoLocked = true;
    showDemoLockedScreen();
    return;
  }

  injectReplayStyles();
  updateProgress();

  const handoff = parseHandoff();
  console.group("[PEAR] init() - fitting room startup");
  console.log("mode    :", handoff ? `focus (garment: ${handoff.name})` : "catalog (no garment in URL)");
  console.log("SDK URLs:", CONFIG.SDK_URLS);
  console.log("token @ :", CONFIG.TOKEN_ENDPOINT, "| health @:", CONFIG.HEALTH_ENDPOINT);
  if (handoff) {
    console.log("garment :", handoff.name, "| type:", handoff.type, "| subType:", handoff.subType);
    console.log("color   :", handoff.color, "| img:", handoff.img ? handoff.img.slice(0, 60) + "…" : "(none)");
  }
  console.groupEnd();

  if (handoff) {
    const hint = $("focusCalcHint");
    if (hint) { hint.hidden = false; hint.innerHTML = `נבחר הפריט <strong>${handoff.name}</strong> - מלא מידות כדי להמשיך למדידה הוירטואלית.`; }
  }

  // Identity gate - ALWAYS Step 0 for the main app / a real merchant embed
  // (device-id auto-login / measurements-refresh routing happens in
  // setupIdentityGate → routeUser). Two exceptions skip straight to the size
  // form's flow instead: DEMO_MODE (the marketing-site widget demo) always
  // shows the form; DEMO_GATE (the public demo embed's one-time measurement)
  // shows the "already used" screen instead once spent.
  //
  // BUGFIX: this previously called showSizeForm() unconditionally here, which
  // never actually called setupIdentityGate() at all - despite the comment
  // above (and the pre-paint html.pear-returning-check gate in index.html)
  // describing exactly that flow. showSizeForm() immediately clears the
  // pre-paint hide (clearReturningCheckGate()) and reveals Screen 1's
  // measurement form BEFORE the device-id lookup even started, so every
  // visitor - including an already-known returning device with a fresh
  // profile - flashed Screen 1 first and only reached the camera once the
  // (now redundant) async check resolved. Calling setupIdentityGate() here
  // restores the real routing: unknown/new device → identity gate; known
  // device, stale/missing profile → size form; known device, fresh profile →
  // straight to the camera with #screen-calculator never revealed at all.
  if (DEMO_MODE) {
    showSizeForm();
  } else if (DEMO_GATE && isDemoGateLocked()) {
    showDemoGateLockedMessage();
  } else {
    setupIdentityGate();
  }

  // Permanent "Update Measurements" CTA + "Edit Measurements" Screen 2 CTA -
  // main-app-only. A gated demo visitor gets exactly one measurement, so these
  // secondary re-measure entry points stay unwired/hidden in that mode instead
  // of offering a way around the one-time limit within a single widget open.
  if (DEMO_GATE) {
    const em = $("btn-edit-measurements");   if (em) em.style.display = "none";
  } else {
    // "Edit Measurements" - always-visible Screen 2 CTA. A returning visitor whose
    // fresh profile skipped Screen 1 entirely may never have seen it; this brings
    // it up pre-filled.
    $("btn-edit-measurements")?.addEventListener("click", () => {
      if (isDemoLocked()) { showDemoLockedScreen(); return; }
      backToCalculator();
      showSizeForm();
    });
    setupProfileButton();
  }
  setupFullscreenToggle();   // header "Back to Store" -> fullscreen toggle; wired regardless of DEMO_GATE
  setupCartButton();
  requestCartSync();         // no-op in standalone/demo mode (inIframe() guard) - see the module comment above

  document.querySelectorAll("#sizeForm input").forEach((i) => {
    i.addEventListener("input", calculateSize);
    i.addEventListener("keydown", onMeasurementKeydown);   // Task 5 - Enter to proceed
  });
  $("btn-next-screen").addEventListener("click", onSizeFormContinue);

  // Explicit open only - startCamera() is also called from flipCamera() and
  // reinitCameraForOrientation(), where the page shouldn't jump since the user is
  // already looking at the camera. rAF lets the newly-.live layout (card grows,
  // Go-Live button enables) settle before we measure it.
  $("startCamBtn").addEventListener("click", () => {
    startCamera().then((ok) => { if (ok) requestAnimationFrame(scrollToCamera); });
  });
  $("flipCamBtn")?.addEventListener("click", () => flipCamera());
  $("captureBtn").addEventListener("click", onLiveToggle);
  // Size-mismatch card's CTA - same destination as the existing "Edit Measurements"
  // Screen 2 button, so the shopper lands on the exact form that can actually change
  // currentSizeCategory (see updateSizeMismatchUI()'s own comment for why this card
  // exists at all).
  $("sizeMismatchUpdateBtn")?.addEventListener("click", backToCalculator);

  // Re-fit the preview camera to the device's orientation on rotate. matchMedia fires
  // exactly on a portrait↔landscape flip; orientationchange is a legacy fallback.
  window.matchMedia("(orientation: portrait)").addEventListener?.("change", reinitCameraForOrientation);
  window.addEventListener("orientationchange", reinitCameraForOrientation);
  $("retakeBtn").addEventListener("click", onRetake);

  // Colour swatches - delegated over the (dynamically rebuilt) bubbles so one listener
  // survives every re-render; setColor() re-renders the strip against the chosen colour's
  // own images and hot-swaps the live stream in place. (The perspective / AI-mode rail was
  // removed - AI Auto is applied automatically, so there is no angle picker to wire.)
  const swatches = $("productSwatches");
  if (swatches) swatches.addEventListener("click", (e) => {
    const b = e.target.closest(".pg-swatch");
    if (b) setColor(b.dataset.color);
  });

  // Complete-the-Look carousel - desktop-only arrow buttons (CSS hides them
  // below 1024px; wiring them unconditionally here is harmless on touch, they're
  // just never visible/clickable there). scrollBy({left}) is a PHYSICAL-axis
  // operation per spec - it always scrolls the viewport visually left/right
  // regardless of the page's RTL direction, so no RTL sign-flipping is needed:
  // the left button simply scrolls left, the right button scrolls right.
  // ~2 cards per click (.cl-card flex-basis 182px + .cl-track gap 16px).
  const CL_SCROLL_PX = (182 + 16) * 2;
  $("clArrowPrev")?.addEventListener("click", () => {
    $("clTrack")?.scrollBy({ left: -CL_SCROLL_PX, behavior: "smooth" });
  });
  $("clArrowNext")?.addEventListener("click", () => {
    $("clTrack")?.scrollBy({ left: CL_SCROLL_PX, behavior: "smooth" });
  });

  // PEAR Live-Action Gallery - render persisted looks + wire tray/clear/retake
  loadGallery();
  const galleryTrack = $("galleryTrack");
  if (galleryTrack) {
    galleryTrack.addEventListener("click", (e) => {
      // the corner select toggle (Compare mode) takes priority over replay
      const selBtn = e.target.closest(".lgi-select");
      if (selBtn) {
        e.preventDefault();
        const host = selBtn.closest(".live-gallery-item");
        if (host) toggleCompareSelect(Number(host.dataset.ts));
        return;
      }
      const item = e.target.closest(".live-gallery-item");
      if (!item) return;
      const idx = Number(item.dataset.idx);
      // Always open the large interactive modal (Image 1): snapshot/clip + name +
      // size badge + Replay (free) / Try again live / Download. The modal's own
      // buttons drive the free clip replay and the fresh live session.
      openFitLightbox(idx);
    });
  }
  const galleryClear = $("galleryClear");
  if (galleryClear) galleryClear.addEventListener("click", clearGallery);

  // Compare mode - open the split-screen overlay; close via ✕ / backdrop / Esc
  const compareBar = $("compareBar");
  if (compareBar) compareBar.addEventListener("click", openCompareOverlay);
  const compareOverlay = $("pearCompare");
  if (compareOverlay) compareOverlay.addEventListener("click", (e) => {
    if (e.target.closest("[data-compare-close]")) closeCompare();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeCompare(); closeFitLightbox(); closeGarmentDetect(); } });

  /* ── "Upload Your Own Garment" wiring ─────────────────────────────────────── */
  const uploadInput = $("garmentUploadInput");
  if (uploadInput) uploadInput.addEventListener("change", onGarmentFileChosen);

  const gdRetry = $("gdRetry");
  if (gdRetry) gdRetry.addEventListener("click", openGarmentUpload);

  // Close the detection overlay via ✕ / backdrop.
  const gdOverlay = $("garmentDetect");
  if (gdOverlay) gdOverlay.addEventListener("click", (e) => {
    if (e.target.closest("[data-gd-close]")) closeGarmentDetect();
  });

  // Pick a detected garment (delegated over the box layer).
  const gdBoxes = $("gdBoxes");
  if (gdBoxes) gdBoxes.addEventListener("click", (e) => {
    const b = e.target.closest("[data-box]");
    if (b) selectDetectedGarment(Number(b.dataset.box));
  });

  // TOP / BOTTOM segmented toggle (outfit mode) - snap the bracket between regions.
  const gdTabs = $("gdTabs");
  if (gdTabs) gdTabs.addEventListener("click", (e) => {
    const t = e.target.closest(".gd-tab");
    if (t) setActiveSide(t.dataset.side);
  });

  // Keyboard access for the (role="button") upload card: Enter / Space open the picker.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest && e.target.closest("[data-upload]")) { e.preventDefault(); openGarmentUpload(); }
  });

  document.addEventListener("click", (e) => {
    // "Upload Your Own Garment" card - open the native file picker.
    if (e.target.closest("[data-upload]")) { openGarmentUpload(); return; }

    // "Add to Look" (הוסף ללוק) - drop this recommendation into its slot beside the
    // active garment (additive; keeps the opposite category). toItem() rebuilds the
    // full record so image URL, metadata AND category (garmentType → top|bottom) are
    // always extracted, regardless of where on the card the user tapped. data-look is
    // an index into _lookCards (not a PEAR_CATALOG id) so this works identically for
    // both demo-catalog recs and real-store recs (see renderCompleteTheLook).
    const lk = e.target.closest("[data-look]");
    if (lk) {
      const p = _lookCards[Number(lk.dataset.look)];
      if (p) addToLook(toItem(p));
      return;
    }
    const pk = e.target.closest("[data-pick]");
    if (pk) {
      const p = PEAR_CATALOG.find((x) => x.id === Number(pk.dataset.pick));
      if (p) { setActiveItem(toItem(p)); $("cameraCard").scrollIntoView({ behavior: "smooth", block: "center" }); }
      return;
    }
  });

  // Terminate the Decart WebRTC session the moment the user leaves or hides the
  // page so billing stops immediately instead of running until TTL expiry.
  // beforeunload/pagehide: page is dying → bare teardown (disconnect) is enough.
  // visibilitychange→hidden: page may return → stopLive() also resets the UI.
  window.addEventListener("beforeunload", teardown);
  window.addEventListener("pagehide", teardown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopLive();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

/* ════════════════════════════════════════════════════════════════════════
   UI ONLY - subtle 3D parallax tilt on the Screen-1 size card.
   Purely decorative; does not touch the try-on flow, tokens, or live window.
   Tracks the pointer across #screen-calculator .container and maps it to a
   gentle rotateX/rotateY, resetting smoothly on leave / touchend. Disabled
   for touch-primary devices and when the user prefers reduced motion.
   ════════════════════════════════════════════════════════════════════════ */
(function initCardTilt() {
  const start = () => {
    const card = document.querySelector("#screen-calculator .container");
    if (!card) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(hover: none), (pointer: coarse)").matches;
    if (reduce || coarse) return;

    const MAX = 6; // degrees of tilt at the card edges
    let raf = 0;                // pending frame handle; 0 means nothing scheduled
    let lastX = 0, lastY = 0;   // newest pointer position, consumed by the frame

    /* rAF COALESCING. A mouse reports far more often than the display refreshes
       (125Hz-1000Hz polling vs a 60/120Hz screen), and the card sits on top of a
       backdrop-filtered glass surface, so every extra paint is expensive. This
       used to cancel and re-schedule - allocating a fresh closure - on EVERY
       pointermove, so the work scaled with the pointer's report rate rather than
       the frame rate. Now a move only stores two numbers, and schedules a frame
       solely when none is already pending; the frame then reads whichever
       position was latest. The tilt still tracks the cursor exactly (the newest
       sample always wins) and the maths below is unchanged - we simply stopped
       doing it for samples the browser was going to discard anyway. */
    const paint = () => {
      raf = 0;
      const r = card.getBoundingClientRect();
      const fx = (lastX - r.left) / r.width;   // 0 … 1
      const fy = (lastY - r.top) / r.height;   // 0 … 1
      const px = fx - 0.5;                      // -0.5 … 0.5
      const py = fy - 0.5;
      const rotX = (-py * MAX).toFixed(2);
      const rotY = (px * MAX).toFixed(2);
      card.classList.add("is-tilting");
      // 3D parallax tilt
      card.style.transform =
        `perspective(1200px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-2px)`;
      // environment mapping: move the specular highlight to the cursor
      card.style.setProperty("--mx", (fx * 100).toFixed(1) + "%");
      card.style.setProperty("--my", (fy * 100).toFixed(1) + "%");
    };

    const reset = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      card.classList.remove("is-tilting");
      card.style.transform = "";
    };

    card.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      lastX = e.clientX;
      lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(paint);
    });
    card.addEventListener("pointerleave", reset);
    card.addEventListener("touchend", reset, { passive: true });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();