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
const {
  CONNECT_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  TOAST_DURATION_MS,
  TOKEN_ENDPOINT,
  HEALTH_ENDPOINT,
  SDK_URLS,
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
      '<p style="font-size:16px;font-weight:600;margin:0;">כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!</p>';
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

    // (1) playoutDelayHint = 0 - flush the client jitter buffer immediately on every
    //     incoming video track. Chromium-only; the `in` guard silently no-ops elsewhere.
    pc.addEventListener("track", (e) => {
      try {
        const r = e.receiver;
        if (r && "playoutDelayHint" in r && e.track && e.track.kind === "video") {
          r.playoutDelayHint = PLAYOUT_DELAY_HINT;
        }
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
   ============================================================================= */
let statsMonitorTimer = null;
let _lastStatsSample = null;   // { ts, bytes, frames } from the previous tick, for deltas

function startStatsMonitor() {
  stopStatsMonitor();          // never stack two pollers
  _lastStatsSample = null;
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
/* Catalog item shape: { id, name, price, type, subType, color, img, imgBack?, images?, variants? }.
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
  { id: 1,  name: "Halo Tank",         price: 88,  type: "shirt", subType: "sleeveless",   color: "#3f5a8a",
    img: "https://images.unsplash.com/photo-1556821840-3a63f15732ce?w=1600&q=90&auto=format&fit=crop&crop=top,center" },
  { id: 2,  name: "Vapor Sleeveless",  price: 72,  type: "shirt", subType: "sleeveless",   color: "#b8c0cc",
    img: "https://burst.shopifycdn.com/photos/grey-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 3,  name: "Ion Crew Tee",      price: 96,  type: "shirt", subType: "short_sleeve", color: "#c2452f",
    img: "https://burst.shopifycdn.com/photos/red-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 4,  name: "Pulse Tee",         price: 84,  type: "shirt", subType: "short_sleeve", color: "#1f6feb",
    img: "https://burst.shopifycdn.com/photos/cobalt-blue-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 5,  name: "Circuit Tee",       price: 90,  type: "shirt", subType: "short_sleeve", color: "#149c7a",
    img: "https://burst.shopifycdn.com/photos/teal-t-shirt.jpg?width=1600&format=pjpg&quality=90" },
  { id: 6,  name: "Strata Longsleeve", price: 128, type: "shirt", subType: "long_sleeve",  color: "#2b2b30",
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
  { id: 7,  name: "Nimbus Henley",     price: 134, type: "shirt", subType: "long_sleeve",  color: "#8e7bd0",
    img: "https://cdn.shopify.com/s/files/1/0831/9103/products/DK_LS_Henley_Dark_Purple-Final-Web.jpg?v=1665703111" },
  { id: 8,  name: "Echo Longsleeve",   price: 118, type: "shirt", subType: "long_sleeve",  color: "#d8d4cb",
    img: "https://img.magnific.com/premium-photo/beige-long-sleeve-shirt-isolated-white-background_1166140-13287.jpg" },
  /* ── Pants ── */
  { id: 9,  name: "Glide Slim",        price: 142, type: "pants", subType: "slim",    color: "#2a2d34",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6905_28.jpg" },
  { id: 10, name: "Mono Slim",         price: 118, type: "pants", subType: "slim",    color: "#6e7681",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6906_28.jpg" },
  { id: 11, name: "Vector Regular",    price: 132, type: "pants", subType: "regular", color: "#3b5bdb",
    img: "https://image.hm.com/assets/hm/54/71/5471b01a9ccf7562c74cf7d8f0102228465f30b5.jpg?imwidth=2160" },
  { id: 12, name: "Apex Regular",      price: 124, type: "pants", subType: "regular", color: "#8a8f98",
    img: "https://image.hm.com/assets/hm/72/56/7256f227cb82ac834363dfb140f245652797d841.jpg?imwidth=2160" },
  { id: 13, name: "Drift Wide",        price: 156, type: "pants", subType: "wide",    color: "#1a1a1d",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_300px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_768,h_922,f_auto,q_auto,fl_progressive/products/Trousers/default/B25209_28.jpg" },
  { id: 14, name: "Terra Wide",        price: 148, type: "pants", subType: "wide",    color: "#a8794f",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B25212_28.jpg" },
  { id: 15, name: "Null Slim",         price: 138, type: "pants", subType: "slim",    color: "#22324f",
    img: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B9449_28.jpg" },
  { id: 16, name: "Cargo Wide",        price: 162, type: "pants", subType: "wide",    color: "#566b3e",
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
const SUBTYPE_PROMPT = {
  sleeveless: "sleeveless", short_sleeve: "short-sleeve", long_sleeve: "long-sleeve",
  slim: "slim-fit", regular: "regular-fit", wide: "wide-leg",
};
const SHIRT_NOUN = { sleeveless: "tank top", short_sleeve: "t-shirt", long_sleeve: "long-sleeve shirt" };

const $ = (s) => document.getElementById(s);

/* ── state ───────────────────────────────────────────────────────────────── */
let currentUserSize = null;
let activeTryOnSize = null;   // size the user has selected in the Screen 2 override selector
let activeItem = null;
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
let dressedFrameReady = false;   // true once #aiVideo has shown a VERIFIED non-black AI-rendered frame this
                                  // session - the single "model ready" signal shared by billing/countdown
                                  // (armFirstFrameBilling/startBillingWindow) AND the recorder (startRecording)
let isGarmentApplied = false;    // true once rtClient.set() has resolved - gates billing/recording to the first DRESSED frame, not raw passthrough

/** @returns {boolean} true while a billable realtime session is active. */
const isLive = () => connState === "connected" || connState === "generating";

/* =============================================================================
   SCREEN 1 - Size / measurement calculator
   ============================================================================= */
const ZARA_SIZE_CHART = [
  { size: "S",  minHeight: 160, maxHeight: 172, minWeight: 55, maxWeight: 65,  minChest: 88,  maxChest: 94,  minWaist: 74, maxWaist: 80,  minLegs: 94,  maxLegs: 98  },
  { size: "M",  minHeight: 170, maxHeight: 180, minWeight: 65, maxWeight: 76,  minChest: 94,  maxChest: 102, minWaist: 80, maxWaist: 88,  minLegs: 98,  maxLegs: 102 },
  { size: "L",  minHeight: 178, maxHeight: 186, minWeight: 75, maxWeight: 87,  minChest: 102, maxChest: 110, minWaist: 88, maxWaist: 96,  minLegs: 102, maxLegs: 106 },
  { size: "XL", minHeight: 184, maxHeight: 195, minWeight: 85, maxWeight: 100, minChest: 110, maxChest: 118, minWaist: 96, maxWaist: 106, minLegs: 106, maxLegs: 112 },
];

/* Ordered size scale - full range used by the override selector and delta math. */
const SIZE_SCALE = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];

/* Task 6 - conditional input flow: the optional fields stay hidden until BOTH
   mandatory fields (height + weight) hold sane, in-range values. */
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
 * Recompute the recommended size from the form inputs (Zara chart, penalty-scored).
 * Drives the result box, the "continue" button enabled-state, and - via
 * setOptionalVisible - the conditional reveal of the optional measurement fields.
 * Re-run on every input event. Pure UI/state; no network.
 * @returns {void}
 */
function calculateSize() {
  const num = (id) => ($(id).value ? parseFloat($(id).value) : null);
  const height = num("height"), weight = num("weight");

  // Reveal optional fields only once both mandatory values are present and sane.
  const mandatoryReady = !!height && !!weight &&
    height >= 130 && height <= 240 && weight >= 35 && weight <= 220;
  setOptionalVisible(mandatoryReady);

  const chest = num("chest"), waist = num("waist"), legs = num("legs");

  const resultBox = $("resultBox"), sizeResult = $("sizeResult"), resultLabel = $("resultLabel");
  const nextBtn = $("btn-next-screen");
  const resultActions = $("resultActions");

  resultBox.classList.remove("show", "error-result");
  if (resultActions) resultActions.classList.remove("is-ready");   // collapse the tray
  resultLabel.innerText = "המידה המומלצת עבורך:";
  nextBtn.disabled = true;
  currentUserSize = null;
  updateProgress();

  if (!height || !weight) return;

  if (height > 240 || height < 130 || weight > 220 || weight < 35) {
    resultLabel.innerText = "שגיאה בנתונים:";
    sizeResult.innerText = "נתונים לא הגיוניים";
    resultBox.classList.add("show", "error-result");
    if (resultActions) resultActions.classList.add("is-ready");
    return;
  }

  let bestSize = "מידה מחוץ לטווח", minPenalty = Infinity;
  const MAX_ALLOWED_PENALTY = 35;

  ZARA_SIZE_CHART.forEach((row) => {
    let pen = 0;
    if (height < row.minHeight) pen += (row.minHeight - height) * 2;
    if (height > row.maxHeight) pen += (height - row.maxHeight) * 2;
    if (weight < row.minWeight) pen += (row.minWeight - weight) * 2;
    if (weight > row.maxWeight) pen += (weight - row.maxWeight) * 2;
    if (chest) { if (chest < row.minChest) pen += (row.minChest - chest) * 0.5; if (chest > row.maxChest) pen += (chest - row.maxChest) * 0.5; }
    if (waist) { if (waist < row.minWaist) pen += (row.minWaist - waist) * 0.5; if (waist > row.maxWaist) pen += (waist - row.maxWaist) * 0.5; }
    if (legs)  { if (legs  < row.minLegs)  pen += (row.minLegs  - legs)  * 0.5; if (legs  > row.maxLegs)  pen += (legs  - row.maxLegs)  * 0.5; }
    if (pen < minPenalty) { minPenalty = pen; bestSize = row.size; }
  });

  if (minPenalty > MAX_ALLOWED_PENALTY) {
    // Measurements don't match any chart row exactly, but we still let the user
    // proceed - the fitting room works without a size recommendation, it just
    // won't show a size badge. bestSize still holds the closest row found.
    resultLabel.innerText = "קירוב מידה מומלץ:";
    sizeResult.innerText = bestSize;
    resultBox.classList.add("show");
    if (resultActions) resultActions.classList.add("is-ready");
    currentUserSize = bestSize;   // use closest match rather than blocking
    nextBtn.disabled = false;
  } else {
    sizeResult.innerText = bestSize;
    resultBox.classList.add("show");
    if (resultActions) resultActions.classList.add("is-ready");
    currentUserSize = bestSize;
    nextBtn.disabled = false;
  }
  updateProgress();
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

    const wType   = (q.get("garment_type") || "tops").toLowerCase();
    const isPants = wType === "pants" || wType === "bottoms";
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
    const galleryBack = (pearImages && pearImages[1] && pearImages[1] !== pearImages[0])
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
      distinct_from_front: !!(result.imgBack && result.imgBack !== result.img),
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

function toItem(raw) {
  return { ...raw, garmentType: raw.type === "pants" ? "lower_body" : "upper_body" };
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
    size:        currentUserSize   || "",
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
      $("final-size-text").innerText = currentUserSize || "";
      $("screen-calculator").classList.remove("active");
      $("screen-fitting").classList.add("active");
      window.scrollTo(0, 0);
      enterRoom();
    } catch (err) {
      console.error("[goToFitting] screen transition failed:", err?.message || String(err), err);
      // Force the screen switch even if enterRoom() threw so the user isn't left on Screen 1
      try {
        $("screen-calculator").classList.remove("active");
        $("screen-fitting").classList.add("active");
      } catch (_) {}
      toast("שגיאה בטעינת חדר המדידה - " + (err?.message || "נסה לרענן את הדף"));
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

function backToCalculator() {
  $("screen-fitting").classList.remove("active");
  $("screen-calculator").classList.add("active");
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
    if (currentUserSize) $("focusSizeBadge").innerText = "מידה " + currentUserSize;
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

  // Pre-warm SDK + token so the go-live path skips both round-trips.
  warmupSDKAndToken();
}

function setActiveItem(item, opts = {}) {
  activeItem = item;
  // Reset the active colour to the new item's first variant (null when it has none) so
  // the swatch strip + gallery always resolve to a valid colour for THIS product.
  activeColor = colorsOf(item)[0] || null;

  // ADDITIVE write: fill ONLY this garment's slot (top|bottom) and leave the
  // opposite slot untouched. Picking a different shirt replaces the top; adding
  // pants fills the bottom while KEEPING the shirt - the whole point of the
  // incremental "Add to Look" outfit.
  activeOutfit[slotOf(item)] = item;

  $("focusItemName").innerText = item.name;
  renderActiveGarment();             // shows either the single item or the full look
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
// app.js's module-scoped `activeItem`) so the "הוסף לסל" click handler knows which
// garment/variant to send to the host store's cart.
window.pearGetActiveGarment = function () {
  if (!activeItem) return null;
  return { url: activeItem.img, name: activeItem.name, variantId: activeItem.variantId };
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
    autoOrientation = "front";               // every auto session opens facing the camera
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
  const front = e.data.garment_url;
  const back = e.data.garment_back;
  if (!activeItem || !front) return;
  if (activeItem.img === front && activeItem.imgBack === back) return;
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
  // currentAngle is deliberately NOT set here: renderPerspectiveSelector() re-derives
  // it (AI Auto when the corrected pair qualifies, else front) with no user input.
  renderActiveGarment();
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
      autoOrientation = "front";               // every fresh auto session (re)arms facing the camera
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
  } else {
    const item = activeItem;
    $("activeGarmentMedia").innerHTML = garmentThumb(item);
    $("activeGarmentName").innerText = item.name;
    $("activeGarmentType").innerText = item.custom
      ? (item.garmentType === "lower_body" ? "בגד תחתון שהעלית · Custom upload" : "בגד עליון שהעלית · Custom upload")
      : (item.garmentType === "lower_body" ? "מכנסיים · " : "חולצה · ") + (SUBTYPE_LABEL_HE[item.subType] || "");
    if (eyebrow) eyebrow.innerText = "פריט נמדד · Now fitting";
    chip.classList.remove("is-duo");
  }
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

  // Additive slot write: setActiveItem fills activeOutfit[slotOf(piece)] = piece and
  // refreshes the chip + recommendations, leaving the opposite slot intact. silent so
  // we own the toast/apply below.
  setActiveItem(piece, { silent: true });
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
    toast("כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!");
    showDemoLockedScreen();
    return false;
  }
  if (localStream) return true;
  if (cameraStartPromise) return cameraStartPromise;   // a request is already in flight

  cameraStartPromise = (async () => {
    showPearLoader("מפעיל מצלמה…");        // 🍐 loading cue while permission/stream opens
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
      showCamError("לא ניתן לגשת למצלמה: " + (err && err.message ? err.message : err) +
        " - ודא הרשאת מצלמה ושהאתר מוגש מ-localhost/https.");
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

/* ── Loading-state elapsed timer (#scanOverlay / #scanSub) ───────────────────
   LOADING (w/ timer) → Model Ready → Start 5s capture. Ticks a live mm:ss counter
   for as long as the loading overlay is up (goLive() start → startBillingWindow()'s
   Model Ready reveal, or an earlier failure/timeout - see those call sites for
   start/stop wiring). Copy is deliberately generic: never names the underlying AI
   vendor/model, just what the user is waiting for. */
let scanTimerInterval = null;
let scanTimerStartMs = 0;
function startScanTimer() {
  stopScanTimer();                 // clear any stale interval before arming a fresh one
  scanTimerStartMs = Date.now();
  updateScanTimer();
  scanTimerInterval = setInterval(updateScanTimer, 1000);
}
function updateScanTimer() {
  const el = $("scanSub");
  if (!el) return;
  const elapsedSec = Math.floor((Date.now() - scanTimerStartMs) / 1000);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  el.textContent = `Preparing Virtual Fitting Room · ${mm}:${ss}`;
}
function stopScanTimer() {
  if (scanTimerInterval) { clearInterval(scanTimerInterval); scanTimerInterval = null; }
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
   enforced above: fewer frames/sec, smaller frames, no redundant capture. */
function createThrottledInputStream(srcStream, { fps = LIVE_INFERENCE_FPS, width = LIVE_W, height = LIVE_H } = {}) {
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
    if (disposed) return;
    try {
      drawFrame();
      if (outTrack && typeof outTrack.requestFrame === "function") outTrack.requestFrame();
    } catch (_) {}
  };

  const start = () => { if (!disposed && !timer) timer = setInterval(tick, frameMs); };
  video.play().then(start).catch(start);

  return {
    stream: out,
    dispose: () => {
      if (disposed) return;
      disposed = true;
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
 * Mint an ephemeral ek_ token and open ONE Decart Lucy VTON realtime session
 * over WebRTC. Any stale/dropped client is disconnected first so no orphaned
 * server-side session keeps billing. SECURITY: the permanent dct_ key never
 * reaches the browser - only the short-lived ek_ token from the proxy does.
 * @returns {Promise<void>}
 */
async function connectRealtime() {
  if (rtClient && isLive()) return;
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
  dressedFrameReady = false;
  isGarmentApplied = false;
  if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }

  console.log("[PEAR] connectRealtime() - stage 1/4: loading SDK from CDN…");
  try {
    /* ── load SDK ─────────────────────────────────────────────────────────── */
    const { createDecartClient } = await loadSDK();
    console.log("[PEAR] connectRealtime() - stage 2/4: SDK loaded. Minting ephemeral token…");

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

    /* ── connect realtime ─────────────────────────────────────────────────── */
    // FIX: model passed as a plain string, NOT via models.realtime()
    rtClient = await client.realtime.connect(realtimeInput, {
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
        // Official pattern: map the live edited WebRTC stream straight to the
        // video element so the garment warps/tracks the user in realtime.
        const aiVideo = document.querySelector("#aiVideo");
        aiVideo.srcObject = editedStream;
        aiVideo.style.display = "block";   // make sure it's visible
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
      },
      onConnectionChange: (state) => {
        if (gen !== sessionGen) return;    // stale callback from a torn-down session
        connState = state;
        setConn(state);
      },
    });

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

  // Cancel the no-first-frame safety timer and reset the billing-armed guard so the next
  // session starts clean (the billed window re-arms only on its own first rendered frame).
  if (firstFrameGuardTimer) { clearTimeout(firstFrameGuardTimer); firstFrameGuardTimer = null; }
  billingStarted = false;
  dressedFrameReady = false;

  // Bug 3 fix: bump the generation FIRST so any in-flight callbacks from the
  // client we're about to disconnect become no-ops (see connectRealtime).
  sessionGen++;

  // Stop the diagnostic stats poller before the pc is torn down.
  stopStatsMonitor();

  // Retire the AI Auto orientation watcher with the session - it samples the camera and
  // issues live set() swaps, so it must never outlive isLive().
  if (orientWatcher) { try { orientWatcher.stop(); } catch (_) {} orientWatcher = null; }

  // Feature 2 - flush the recorder while the edited tracks are still live, so the
  // download clip is finalized before disconnect ends the stream.
  stopRecording();

  if (rtClient) {
    try { rtClient.disconnect(); } catch (_) {}
    rtClient = null;
  }

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

  // Bug 3 fix: clear every guard so the next try-on starts from a pristine state.
  connState = "idle";
  connecting = false;
  setConn("idle");
}

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
const _assetBlobCache = new Map();   // url → Promise<Blob|null>

function garmentBlobCached(url) {
  console.log('[PEAR] garmentBlobCached url:', url);
  if (!url) { console.log('[PEAR] garmentBlobCached result:', 'miss'); return Promise.resolve(null); }
  if (_assetBlobCache.has(url)) {
    console.log('[PEAR] garmentBlobCached result:', 'hit');
    return _assetBlobCache.get(url);
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
  _assetBlobCache.set(url, job);
  return job;
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
    const backUrl = (g.back && g.back !== g.front) ? g.back : undefined;
    console.log('[PEAR] prewarm started for:', abbrevImg(frontUrl), '| back:', abbrevImg(backUrl));
    garmentBlobCached(frontUrl).then((frontBlob) => {
      console.log('[PEAR] prewarm front blob:', frontBlob ? `ok (${frontBlob.size.toLocaleString()} bytes)` : 'FAILED');
    });
    // garmentBlobCached() now retries through the proxy AND the raw CDN internally
    // (fetchWithFallback), so no extra fallback layer is needed here - a null result
    // means all 3 rounds on both routes failed, which is a real, reportable failure.
    if (backUrl) {
      garmentBlobCached(backUrl).then((backBlob) => {
        if (backBlob) {
          console.log(`[PEAR] prewarm back blob: ok (${backBlob.size.toLocaleString()} bytes) - turning around will render the real rear photo`);
        } else {
          console.error("[PEAR] CRITICAL: back blob prewarm failed after all retries -", backUrl);
        }
      });
    } else {
      console.warn('[PEAR] prewarm back blob: SKIPPED - this garment has no distinct back image');
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
    const back  = (g.back && g.back !== g.front) ? g.back : undefined;
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
   detected face means the user is facing the camera (FRONT); no face means the back
   of the head/body is showing (BACK). Demoted permanently after one runtime failure
   (some builds expose the class but throw NotSupportedError at detect()). Browsers
   without FaceDetector fall back to a skin-ratio heuristic: % of skin-tone pixels in
   the head band (upper 45%, central 50%) of a tiny 96×96 frame - a frontal face shows
   far more skin than the back of a head. DUAL thresholds (≥10% → front, ≤4% → back,
   dead-band between) so an ambiguous profile frame abstains instead of voting.
   A single stray misread (e.g. a false-positive face hit on hair texture) is deliberately
   NOT cross-checked here against a second engine - the hysteresis below is what absorbs
   that noise, so classify() stays one simple, direct rule instead of two engines
   arguing with each other every tick.

   Anti-flap discipline (this is what stops the view from flapping back and forth):
     • a flip needs ORIENT_LOCK_FRAMES consecutive agreeing votes OR
       ORIENT_LOCK_MS of sustained agreement, whichever comes first - a real turn
       satisfies both quickly; a single noisy frame satisfies neither;
     • ORIENT_COOLDOWN_MS minimum gap between actual live set() swaps, on top of that;
     • a single in-flight guard - the sampler itself is the retry loop, so a turn
       completed mid-swap is picked up by the very next confirmed vote;
     • abstains (null votes) never reset an in-progress streak - only a genuinely
       DISAGREEING vote does.

   STATE LOCK MODEL: autoOrientation is a LOCK, not a live readout - once locked to
   FRONT or BACK, every tick that disagrees only accumulates evidence (streak/held);
   it does NOT touch the rendered reference until that evidence clears BOTH
   ORIENT_LOCK_FRAMES consecutive agreeing samples AND enough elapsed time
   (ORIENT_LOCK_MS) to rule out a momentary head turn or a single misread. At the
   default 250ms sample rate the two thresholds land at the same ~4s mark by design
   (10 × 250ms = 2500ms) - ORIENT_LOCK_MS is a robustness backstop for a throttled/
   backgrounded tab where setInterval ticks slip, not an independent faster path. A
   confirmed transition logs "[VTON Pipeline] Current Active State: ..." so it's
   obvious in the console exactly when (and how rarely) the lock actually moves.
   The watcher never touches the camera track (shared with the preview); stop() only
   detaches its own <video> sampler. Lifecycle is owned by syncOrientationWatcher(). */
const ORIENT_SAMPLE_MS      = 250;   // ~4 analyses/s - cheap on a 96px canvas
const ORIENT_LOCK_FRAMES    = 10;    // consecutive agreeing samples to unlock (~2.5s @ 250ms/sample)
const ORIENT_LOCK_MS        = 2500;  // OR this much sustained agreement - whichever comes first (see note above)
const ORIENT_CONFIDENCE_MIN = 0.85;  // per-frame vote must clear this confidence or it abstains (see skinConfidence())
const ORIENT_COOLDOWN_MS    = 1500;  // min gap between live reference swaps (anti-flap, secondary to the lock)
const ORIENT_SIZE           = 96;    // analysis canvas edge - tiny on purpose
// Explicit 2-state enum for the per-orientation lock (a DIFFERENT axis from
// AUTO_ANGLE/"front" above, which is which TOP-LEVEL try-on mode is active - this
// is which SIDE of the garment AUTO_ANGLE mode is currently locked to).
const FRONT_MODE = "FRONT_MODE";
const BACK_MODE  = "BACK_MODE";
// TEMPORARY - single compact per-tick log line for tuning the thresholds above; flip
// off (or delete the ORIENT_DEBUG block below) once the values are settled.
const ORIENT_DEBUG          = true;

let orientWatcher = null;         // { stop } while running, else null

/* Idempotent lifecycle gate - safe to call from ANY state change (angle switch, item swap,
   go-live, teardown): starts the watcher when AI Auto is live-armed, retires it otherwise. */
function syncOrientationWatcher() {
  const want = currentAngle === AUTO_ANGLE && isLive() && canCombineViews(activeItem) && !!localStream;
  if (want && !orientWatcher) orientWatcher = createOrientationWatcher();
  else if (!want && orientWatcher) { try { orientWatcher.stop(); } catch (_) {} orientWatcher = null; }
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

function createOrientationWatcher() {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return null;                       // no camera yet - sync will retry later

  /* ── Explicit, immutable per-session asset mapping (zero ambiguity) ───────────
     Resolved ONCE here, when AI Auto arms for this session - NOT re-derived from
     galleryOf(activeItem) on every vote/swap. A mid-rotation mutation of activeItem
     (color swap, item swap) can no longer shift what "front"/"back" mean partway
     through a turn; this watcher instance always maps to the exact two assets it
     started with. Every reference this watcher ever hands to rtClient.set() comes
     from ONE of these two constants - GARMENT_BACK is never routed to FRONT_MODE's
     payload and GARMENT_FRONT is never routed to BACK_MODE's, by construction (see
     maybeSwap below). GARMENT_BACK is undefined when there's no real, distinct back
     photo - canCombineViews() already gates this watcher's existence on that being
     true, so this is a belt-and-suspenders capture, not the source of that decision. */
  const gInit = galleryOf(activeItem);
  const GARMENT_FRONT = gInit.front || activeItem.img;
  const GARMENT_BACK  = (gInit.back && gInit.back !== gInit.front) ? gInit.back : undefined;

  // Private sampler onto the SAME track the preview uses - reading is free, and we never
  // stop the track itself (it belongs to the shared preview camera).
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = ORIENT_SIZE; canvas.height = ORIENT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const faceDetector = typeof FaceDetector !== "undefined"
    ? (() => { try { return new FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (_) { return null; } })()
    : null;
  let fdBroken = false;
  let lastSkinRatio = null;        // surfaced in the ORIENT_DEBUG log line only
  let lastConfidence = 0;          // 0..1, surfaced in the ORIENT_DEBUG log line only
  console.log("[PEAR] AI Auto - orientation watcher armed (engine:",
    faceDetector ? "FaceDetector)" : "skin-ratio heuristic)",
    "| GARMENT_FRONT:", abbrevImg(GARMENT_FRONT), "| GARMENT_BACK:", GARMENT_BACK ? abbrevImg(GARMENT_BACK) : "(none)");

  /* vtonState mirrors autoOrientation (the module-level value effectiveAngle()/
     activeImageOf() read) as the explicit FRONT_MODE/BACK_MODE enum requested for
     logging/tracking - two names for the same fact, kept in lockstep only inside
     logVtonState() below so there is exactly one place that can drift. */
  function logVtonState() {
    const state = autoOrientation === "back" ? BACK_MODE : FRONT_MODE;
    console.log(`[VTON Pipeline] Current Active State: ${state} | Applied Asset: ${state === BACK_MODE ? "GARMENT_BACK" : "GARMENT_FRONT"}`);
  }
  logVtonState();   // initial state, always FRONT_MODE / GARMENT_FRONT (goLive() just reset autoOrientation)

  let lastVote = null, streak = 0, streakSince = 0, sampling = false, applying = false, lastSwapAt = 0, disposed = false;

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

  /* One vote: "front" | "back" | null (abstain - includes a read that crossed the
     raw threshold but didn't clear ORIENT_CONFIDENCE_MIN). Face detection is
     authoritative when available - detected ⇒ front, not detected ⇒ back, no
     second-guessing here. The lock in the sampler loop below (not this function) is
     what absorbs a stray misread, so this stays one direct rule per engine. */
  async function classify() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.max(ORIENT_SIZE / vw, ORIENT_SIZE / vh);   // cover-fit center crop
    ctx.drawImage(video, (ORIENT_SIZE - vw * s) / 2, (ORIENT_SIZE - vh * s) / 2, vw * s, vh * s);

    if (faceDetector && !fdBroken) {
      try {
        const faces = await faceDetector.detect(canvas);
        lastConfidence = 1;   // binary API - no partial score to report
        return faces.length > 0 ? "front" : "back";
      } catch (_) {
        fdBroken = true;
        console.log("[PEAR] AI Auto - FaceDetector unavailable at runtime; using skin-ratio heuristic");
      }
    }
    return skinRatioVote();
  }

  /* Skin-tone share of the head band. Classic RGB skin rule - coarse, but the dual
     thresholds + confidence gate + lock absorb its noise. */
  function skinRatioVote() {
    const x = Math.round(ORIENT_SIZE * 0.25), w = Math.round(ORIENT_SIZE * 0.5);
    const h = Math.round(ORIENT_SIZE * 0.45);
    const d = ctx.getImageData(x, 0, w, h).data;
    let skin = 0;
    const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b) skin++;
    }
    const ratio = skin / total;
    lastSkinRatio = ratio;
    const vote = ratio >= 0.10 ? "front" : ratio <= 0.04 ? "back" : null;
    if (!vote) { lastConfidence = 0; return null; }         // ambiguous (profile/transition) - abstain
    lastConfidence = skinConfidence(ratio, vote);
    return lastConfidence >= ORIENT_CONFIDENCE_MIN ? vote : null;   // crossed the line, not confidently
  }

  /* Confirmed flip → cross-fade + hot-swap the live reference, using ONLY the frozen
     GARMENT_FRONT/GARMENT_BACK captured above - never a value re-derived elsewhere.
     The sampler keeps voting during the swap, so a turn completed mid-flight is
     re-confirmed and applied by a later tick - no queue needed. */
  async function maybeSwap(next) {
    if (applying || Date.now() - lastSwapAt < ORIENT_COOLDOWN_MS) return;
    if (disposed || !isLive() || currentAngle !== AUTO_ANGLE) return;

    /* Fallback guard: verify GARMENT_BACK is fully loaded AND valid BEFORE committing
       the flip - never switch to BACK_MODE (or wipe the current overlay) on a missing
       or broken asset; FRONT_MODE simply stays active. Swapping first and discovering
       the Blob is missing afterwards is what produced a blank back: the prompt would
       already be steering "render the BACK" while the model still held the front
       reference. garmentBlobCached() retries internally through the proxy AND the
       raw CDN, so reaching null here means every route failed. */
    if (next === "back") {
      if (!GARMENT_BACK) {
        console.error("[PEAR] CRITICAL: no GARMENT_BACK asset for this item; staying in FRONT_MODE");
        lastSwapAt = Date.now();
        return;
      }
      const backBlob = await garmentBlobCached(GARMENT_BACK);
      if (!backBlob) {
        console.error("[PEAR] CRITICAL: GARMENT_BACK unavailable at flip time; staying in FRONT_MODE -", GARMENT_BACK);
        lastSwapAt = Date.now();          // throttle repeat toasts while turned away
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
      if (backLooksFlat) {
        console.error("[PEAR] CRITICAL: GARMENT_BACK decoded but looks like a blank/solid-color placeholder (no garment texture); staying in FRONT_MODE -", GARMENT_BACK);
        _assetBlobCache.delete(GARMENT_BACK);   // don't keep serving this bad asset from cache
        lastSwapAt = Date.now();
        toast("תמונת הגב אינה תקינה");
        return;
      }
    }

    applying = true;
    lastSwapAt = Date.now();
    autoOrientation = next;
    logVtonState();
    orientFadeFreeze();                   // freeze the last good frame BEFORE the reference changes
    console.log("[PEAR] AI Auto - orientation flip →", next.toUpperCase(),
      "| reference:", abbrevImg(next === "back" ? GARMENT_BACK : GARMENT_FRONT));
    renderPerspectiveSelector();
    try {
      await applyActive();                       // one rtClient.set() - pre-cached Blob payload
      await new Promise((r) => setTimeout(r, ORIENT_FADE_HOLD_MS));   // let the new frame actually land
      orientFadeReveal();
      toast(next === "back" ? "מציג גב · Back view" : "מציג חזית · Front view");
    } catch (e) {
      console.warn("[PEAR] AI Auto swap apply:", e?.message || e);
      orientFadeReveal();                         // never leave the frozen overlay stuck up on failure
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
      const needsSwitch = !!lastVote && lastVote !== autoOrientation;
      const confirmed = needsSwitch && (streak >= ORIENT_LOCK_FRAMES || held >= ORIENT_LOCK_MS);

      if (ORIENT_DEBUG) {
        const confidence = faceDetector && !fdBroken
          ? `face:${vote ?? "none"}(${(lastConfidence * 100).toFixed(0)}%)`
          : `skin:${lastSkinRatio != null ? (lastSkinRatio * 100).toFixed(1) + "%" : "n/a"}(${(lastConfidence * 100).toFixed(0)}% conf)`;
        // Status reflects the LOCK, not the raw per-frame vote: "locked" covers both a
        // clean agreeing vote AND a disagreeing one that hasn't cleared the threshold
        // yet - i.e. exactly the case that used to flip the reference frame-by-frame.
        const status = confirmed ? "SWITCHING" : needsSwitch ? "waiting-to-switch" : "locked";
        const state = autoOrientation === "back" ? BACK_MODE : FRONT_MODE;
        console.log(`[PEAR][ORIENT] state=${state} | confidence=${confidence} | ${status}` +
          (needsSwitch ? ` (${streak}/${ORIENT_LOCK_FRAMES}f, ${held}/${ORIENT_LOCK_MS}ms)` : ""));
      }

      if (confirmed) await maybeSwap(lastVote);
    } catch (_) {} finally { sampling = false; }
  }, ORIENT_SAMPLE_MS);

  return {
    stop() {
      disposed = true;
      clearInterval(timer);
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
  const x = align === "right" ? Math.round(anchorX - boxW) : Math.round(anchorX);
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
const _lookStitchCache = new Map();   // `${topUrl} ${bottomUrl}` → Promise<Blob|null>

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
  if (_lookStitchCache.has(key)) return _lookStitchCache.get(key);

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

  _lookStitchCache.set(key, job);
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
let autoOrientation = "front";        // "front" | "back" - the side the user shows the camera
/* The angle every resolver should ACT on: auto mode delegates to the detected orientation,
   every other mode is what the user picked. */
function effectiveAngle() { return currentAngle === AUTO_ANGLE ? autoOrientation : currentAngle; }
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

/* Angle-oriented prompt clauses. Switching the image alone isn't enough - Lucy
   regenerates every frame, so the prompt must ALSO name the viewing angle or the
   model keeps rendering a front. Front needs no clause. */
const ANGLE_CLAUSE = {
  front: "",
  // Back, REAL rear reference: the active image IS a dedicated back photo. Tell Lucy to
  // REPRODUCE it - and pin the print's size/position to the reference so the graphic
  // doesn't drift, rescale or re-center between frames (the back-alignment ask).
  backReal: " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera. This reference photo shows the BACK of the garment: reproduce it faithfully - its back panel, rear yoke, back collar, rear hemline and especially any back graphics, prints, logos or lettering - keeping each element at the SAME size, height and horizontal position on the garment as in the reference, wrapping naturally around the body. Do not move, rescale, re-center or omit the back print, and do NOT render the front of the garment.",
  // Back, INFERRED rear: no dedicated back photo - the active image is the FRONT, so Lucy
  // must infer a plausible rear from it (graceful fallback; placement can't be pinned).
  backInferred: " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera. Render the BACK of the garment: its back panel, rear yoke, back collar, rear hemline and any back graphics, prints or seams, wrapping naturally around the body from the rear. This reference photo shows the front, so infer the corresponding rear; do NOT render the front of the garment.",
  side:  " The person is viewed from the SIDE in profile: render the garment's side profile - shoulder line, sleeve, side seam and the way the fabric drapes along the flank - in an accurate three-quarter/profile perspective.",
  // AI Auto, facing camera: the reference is ONE clean front asset (no composite), so the
  // clause pins it explicitly as the front and forbids inventing rear details - the
  // orientation contract that makes Context-Aware Asset Switching bleed-proof.
  autoFront:
    " This reference photo shows the FRONT of the garment. The person is facing the camera:" +
    " reproduce the garment's front faithfully - its front panel, collar, closure, hemline and" +
    " any front graphics, prints, logos or lettering - keeping each element at the SAME size," +
    " height and horizontal position as in the reference. Do NOT render the back of the garment.",
};

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
const CUSTOM_BACK_INFERRED =
  " The person is seen from BEHIND - rear view, turned around, the back of the body facing the camera." +
  " Render the BACK of this custom garment. The back of the garment must be a clean, plain version of the" +
  " front's fabric and color, strictly without the front graphics or logos. Maintain the same seams," +
  " material texture, and drape as the front view. Do not mirror front-specific details to the back." +
  " Negative constraint - avoid printing, logos, or graphic motifs on the back side.";
/* A REAL rear reference = a back image that DIFFERS from the front. A mirrored front
   (catalog auto-fill at load, or the graceful front-fallback) has g.back === g.front and
   is NOT a true back photo - so it must NOT claim "reproduce the back" steering. Only a
   distinct back asset (a storefront data-pear-back, or a catalog item's real rear photo)
   qualifies. For a full look, BOTH halves must ship a real back. */
function activeBackIsReal(item) {
  const real = (it) => { if (!it) return false; const g = galleryOf(it); return !!(g.back && g.back !== g.front); };
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
  const ok = (it) => { if (!it) return false; const g = galleryOf(it); return !!(g.front && g.back && g.back !== g.front); };
  const look = resolveLook();
  if (look) return ok(look.top) && ok(look.bottom);
  return ok(item);
}

/* Pick the angle clause for the active view. Back splits on whether a REAL back photo is
   in play (backReal - reproduce + pin the print's placement) vs a mirrored/inferred front
   (backInferred). `item` is the single garment; for a full look it's resolved internally. */
function angleClause(item) {
  const angle = effectiveAngle();      // AI Auto resolves to the DETECTED orientation
  if (angle === "back") {
    // Dual asset (front + a REAL back photo, incl. a user's uploaded back) → reproduce it.
    // AI Auto always lands here with a real back (canCombineViews gates the mode on one).
    if (activeBackIsReal(item)) return ANGLE_CLAUSE.backReal;
    // Custom upload with only a front → the strict "clean plain rear, no front graphics"
    // constraint (+ inlined negative). Catalog items keep the generic inferred clause.
    if (item && item.custom) return CUSTOM_BACK_INFERRED;
    return ANGLE_CLAUSE.backInferred;
  }
  // AI Auto, facing the camera: unlike the plain front tab (no clause), pin the reference
  // explicitly as the garment FRONT - the mode's whole contract is one unambiguous side.
  if (currentAngle === AUTO_ANGLE) return ANGLE_CLAUSE.autoFront;
  return ANGLE_CLAUSE[angle] || "";
}

/**
 * Resolve the reference image handed to rtClient.set({ image }) for the active view.
 * Normal angles → the proxied gallery URL (garmentImageRef, a string). AI Auto → the
 * pre-cached per-orientation Blob (garmentBlobCached), never a combined image.
 * @param {object} item @param {string} [activeImg] pre-resolved activeImageOf(item)
 * @returns {Promise<Blob|string|undefined>}
 */
async function referenceImageFor(item, activeImg = activeImageOf(item)) {
  // AI Auto - the pre-cached Blob for the DETECTED orientation (activeImg already resolved
  // through effectiveAngle()). Sending bytes, not a URL, is what makes the swap instant.
  if (currentAngle === AUTO_ANGLE) {
    const blob = await garmentBlobCached(activeImg);
    if (blob) return blob;
    console.warn("[PEAR] AI Auto - Blob pre-cache miss; falling back to proxied URL reference");
  }
  return garmentImageRef(activeImg);
}

async function applyGarment(item) {
  if (!rtClient) throw new Error("not connected");

  const activeImg = activeImageOf(item);
  const imageRef  = await referenceImageFor(item, activeImg);   // Blob for combined, URL otherwise

  if (effectiveAngle() === "back") {
    const isBlob = typeof Blob !== "undefined" && imageRef instanceof Blob;
    console.log('[PEAR] applyGarment image:', activeImg);
    console.log('[PEAR] applyGarment blob:', isBlob ? 'ok' : 'NULL - will use URL fallback');
  }

  const payload = {
    prompt: buildPrompt(item) + angleClause(item),
    enhance: false,
    ...(imageRef ? { image: imageRef } : {}),
  };

  console.group("[PEAR] applyGarment() - VTON payload debug");
  console.log("garment  :", item.name, `(id=${item.id}, type=${item.garmentType}${item.custom ? ", custom upload" : ""})`);
  console.log("angle    :", currentAngle,
    currentAngle === AUTO_ANGLE ? `(AI Auto - detected orientation: ${autoOrientation}, pre-cached Blob)`
      : hasDedicatedAngle(item) ? "(dedicated gallery image)" : "(front fallback + prompt)");
  console.log("subType  :", item.subType, "| color:", item.color);
  console.log("img URL  :", abbrevImg(activeImg));   // data: URLs abbreviated so a base64 blob can't flood the console
  console.log("img ref  :", abbrevImg(imageRef));
  console.log("prompt   :", payload.prompt);
  console.groupEnd();

  if (!imageRef) console.warn("[PEAR] applyGarment() - no img URL; prompt-only.");

  await rtClient.set(payload);
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
 * @returns {number}
 */
function getSizeDelta() {
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
function getFitModifier(delta, garmentType) {
  if (garmentType === "upper_body") {
    if (delta <= -2) return "sleek athletic compression fit, form-fitting tailored silhouette with a snug contour seamlessly hugging the torso, structurally intact fabric lying smooth and flat against the body, cropped hem sitting cleanly at the natural waistline";
    if (delta === -1) return "slim tailored athletic fit, close contour following the torso with clean structural drape, fabric lying taut but smooth with no distortion";
    if (delta === 0)  return "perfectly tailored true-to-size fit, flawless natural drape with no excess fabric";
    if (delta === 1)  return "relaxed fit, slightly loose drape, comfortable room across the shoulders and chest";
    /* delta >= 2 */  return "oversized fashion-forward fit, generously dropped shoulders, easy relaxed volume through the torso, elongated hem with natural gravity drape";
  }
  /* lower_body */
  if (delta <= -2) return "high-compression slim silhouette, fabric lying smooth and continuous from waist to ankle in a seamlessly fitted contour, structurally clean at the knee and thigh with no creasing or distortion, full-length inseam with a tailored ankle cuff";
  if (delta === -1) return "slim tailored fit, close through the thigh and knee with a clean tapered leg, fabric draping smoothly to a narrow ankle opening";
  if (delta === 0)  return "perfectly tailored true-to-size fit, clean break at the ankle with no pooling";
  if (delta === 1)  return "relaxed wide fit, comfortable room through the thighs, natural break at the ankle";
  /* delta >= 2 */  return "wide-leg fashion silhouette, generous volume through the thigh with a sweeping leg that breaks softly over the shoe, clean continuous fabric geometry";
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
const KEEP_BOTTOMS = " Keep the person's existing lower body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the trousers, shorts, skirt, shoes, or anything below the waist.";
const KEEP_TOP     = " Keep the person's existing upper body exactly as it is in the live camera - do not change, recolor, restyle, or re-render the shirt, top, jacket, or anything above the waist.";

/* Universal hard negative appended to EVERY prompt (per product spec). Bars the opposite
   view's signature details from leaking in when the back is being rendered - a belt-and-
   suspenders backstop alongside ANGLE_CLAUSE.backReal/backInferred's own "do NOT render
   the front" instruction. */
const HARD_NEGATIVE = " Strictly prevent the rendering of FRONT details (like logos or front-pockets) when the BACK view is requested.";

function buildPrompt(item) {
  // "Upload Your Own Garment": the reference image IS the garment, so we point the
  // model AT that image instead of naming a catalog color/subType. We still keep the
  // anatomical anchor, size-driven fit modifier and the opposite-layer lock, so a
  // custom upload behaves exactly like a built-in item in the strict live flow.
  if (item.custom) return buildCustomPrompt(item);

  const colorWord = colorName(item.color);
  const sub    = SUBTYPE_PROMPT[item.subType] || "";
  const anchor = getAnatomicalAnchor();
  const delta  = getSizeDelta();
  const fitMod = getFitModifier(delta, item.garmentType);
  const suffix = HARD_NEGATIVE;   // universal hard negative (combined orientation lives in angleClause)

  if (item.garmentType === "lower_body") {
    return `Substitute the current bottoms with ${colorWord} ${sub} trousers. ${anchor} Render a ${fitMod}${QUALITY_SUFFIX}.${HEM_DETAIL}${KEEP_TOP}${suffix}`
      .replace(/\s+/g, " ").trim();
  }
  const noun = SHIRT_NOUN[item.subType] || "top";
  return `Substitute the current top with a ${colorWord} ${sub} ${noun}. ${anchor} Render a ${fitMod}${QUALITY_SUFFIX}.${HEM_DETAIL}${KEEP_BOTTOMS}${suffix}`
    .replace(/\s+/g, " ").trim();
}

/**
 * Prompt for a user-uploaded ("custom") garment. The cropped image is passed as the
 * reference (image: dataURL) so the instruction tells the model to replicate the
 * exact garment shown, rather than a named catalog color/subType.
 * @param {object} item - a custom item ({ custom:true, garmentType, img, color })
 * @returns {string}
 */
function buildCustomPrompt(item) {
  const anchor = getAnatomicalAnchor();
  const delta  = getSizeDelta();
  const fitMod = getFitModifier(delta, item.garmentType);
  const suffix = HARD_NEGATIVE;
  const ref = "the exact garment shown in the reference image - a custom uploaded garment - replicating its precise color, pattern, print, fabric texture and silhouette";

  if (item.garmentType === "lower_body") {
    return `Substitute the current bottoms with ${ref}, worn as trousers. ${anchor} Render a ${fitMod}${QUALITY_SUFFIX}.${HEM_DETAIL}${KEEP_TOP}${suffix}`
      .replace(/\s+/g, " ").trim();
  }
  return `Substitute the current top with ${ref}, worn on the upper body. ${anchor} Render a ${fitMod}${QUALITY_SUFFIX}.${HEM_DETAIL}${KEEP_BOTTOMS}${suffix}`
    .replace(/\s+/g, " ").trim();
}

/**
 * Apply whatever the user is currently trying on: the FULL look (shirt + pants in
 * ONE payload) when BOTH outfit slots are filled, otherwise the single active
 * garment. The single entry point goLive() and mid-session swaps call, so the live
 * flow stays identical for both modes.
 * @returns {Promise<void>}
 */
async function applyActive() {
  const look = resolveLook();        // non-null only when activeOutfit has top AND bottom
  if (look) await applyLook(look.top, look.bottom);
  else await applyGarment(activeItem);
  isGarmentApplied = true;           // rtClient.set() resolved - the NEXT rendered frame is dressed
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
  let primaryImage = canStitchLook ? await stitchLookBlob(topImg, bottomImg) : null;
  const prompt = primaryImage
    ? buildLookPrompt(top, bottom) + LOOK_CLAUSE
    : buildLookPrompt(top, bottom) + angleClause();

  if (!primaryImage) {
    // Stitch unavailable (AI Auto angle) or failed to decode - fall back to the
    // single top reference so the live session is never left without ANY image.
    if (canStitchLook) console.warn("[PEAR] look stitch failed; falling back to top-only reference");
    primaryImage = (await referenceImageFor(top, topImg)) ?? null;
  }
  const images = [topImg, bottomImg].filter(Boolean).map(garmentImageRef).filter(Boolean);

  // ONE combined payload - both garments, one pass, same session.
  const payload = {
    prompt,
    enhance: false,
    image: primaryImage,               // SDK single-image slot: TOP+BOTTOM stitched composite (or top-only fallback)
    images,                           // both verified proxy URLs, bundled together
    garments: [                       // per-slot metadata incl. category (top|bottom)
      { category: "top",    type: top.garmentType,    image: topImg,    color: top.color,    subType: top.subType,    name: top.name,    angle: currentAngle },
      { category: "bottom", type: bottom.garmentType, image: bottomImg, color: bottom.color, subType: bottom.subType, name: bottom.name, angle: currentAngle },
    ],
  };

  try {
    await rtClient.set(payload);
  } catch (e) {
    // A stricter SDK build may reject the enriched shape - retry with the minimal contract.
    console.warn("look payload rejected, retrying minimal:", e?.message || e);
    await rtClient.set({ prompt, image: primaryImage, enhance: false });
  }
}

/**
 * Build ONE prompt that instructs the model to overlay the shirt AND the pants
 * simultaneously (a single pass), so a full outfit is rendered together rather
 * than as two separate substitutions.
 */
function buildLookPrompt(top, bottom) {
  const tColor = colorName(top.color), tSub = SUBTYPE_PROMPT[top.subType] || "";
  const tNoun  = SHIRT_NOUN[top.subType] || "top";
  const bColor = colorName(bottom.color), bSub = SUBTYPE_PROMPT[bottom.subType] || "";
  const anchor = getAnatomicalAnchor();
  const delta  = getSizeDelta();
  const topFit = getFitModifier(delta, top.garmentType);
  const botFit = getFitModifier(delta, bottom.garmentType);
  const suffix = HARD_NEGATIVE;
  return (
    `Dress the person in one complete outfit in a single pass: ` +
    `replace the top with a ${tColor} ${tSub} ${tNoun} rendered as a ${topFit}, ` +
    `and at the same time replace the bottoms with ${bColor} ${bSub} trousers rendered as a ${botFit}. ` +
    `${anchor} Render both garments together in a single photorealistic pass${QUALITY_SUFFIX}.${suffix}`
  ).replace(/\s+/g, " ").trim();
}

/* =============================================================================
   Size Override Selector - Screen 2 (Try-On room)
   ─────────────────────────────────────────────────────────────────────────
   A glassmorphism button row (XS / S / M / L / XL / XXL / 3XL) injected below
   the active-garment chip. The button matching currentUserSize is highlighted by default.
   Selecting a different size sets activeTryOnSize, which buildFitModifier() then
   uses to append tight-fit or oversized descriptors to the VTON prompt. If a
   WebRTC session is already live, applyActive() is called immediately so the
   garment resizes without restarting the connection.
   ============================================================================= */
function injectSizeSelector() {
  // Remove any stale selector from a previous room entry before rebuilding.
  const old = $("pearSizeSelector");
  if (old) old.remove();

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

  const current = activeTryOnSize || currentUserSize;
  const btnHtml = SIZE_SCALE.map((sz) => {
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
 * @param {string} size - one of SIZE_SCALE ('S'|'M'|'L'|'XL'|'XXL')
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

  const baseIdx = SIZE_SCALE.indexOf(currentUserSize);
  const pickIdx = SIZE_SCALE.indexOf(size);
  if (!currentUserSize || baseIdx === -1) {
    toast(`מידה שנבחרה: <b>${size}</b>`);
  } else if (pickIdx < baseIdx) {
    toast(`מידה <b>${size}</b> - הלבוש יראה הדוק יותר`);
  } else if (pickIdx > baseIdx) {
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
    size:        size             ?? "",
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
   130–240 cm, weight 35–220 kg) - also enforced server-side in
   updateUserMeasurements() - so no out-of-range value survives the round-trip.
   ============================================================================= */
const PEAR_LAST_MEASUREMENTS_KEY = "pear_last_measurements_date";
const MEASUREMENTS_REFRESH_MS    = 30 * 24 * 60 * 60 * 1000;   // 30 days
const PROFILE_HEIGHT_MIN = 130, PROFILE_HEIGHT_MAX = 240;
const PROFILE_WEIGHT_MIN = 35,  PROFILE_WEIGHT_MAX = 220;

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
  PEAR_USER    = user ? { id: user.id, name: user.name, email: user.email, height: user.height, weight: user.weight } : null;
  PEAR_USER_ID = (user && user.id) || null;
  updateProfileButton();

  const hasProfile = user && isSaneProfile(Number(user.height), Number(user.weight));

  if (hasProfile && !isMeasurementsRefreshDue()) {
    hideAllScreen1Forms();
    const setIf = (id, v) => { const el = $(id); if (el && v != null && v !== "") el.value = String(v); };
    setIf("height", user.height); setIf("weight", user.weight);
    try { calculateSize(); } catch {}
    // instant:true - this visitor never saw Screen 1 (pre-paint gate kept
    // #screen-calculator hidden the whole time), so skip the branded transition
    // and land directly on the camera with zero visible animation/delay.
    goToFitting({ instant: true });
    return;
  }

  showSizeForm({ refreshNotice: !!hasProfile });
}

/* Send the current form's height/weight to the server (PATCH) and stamp today
 * as the last-measurements date. No-op (resolves immediately) when there's no
 * logged-in device profile to attach it to (e.g. demo mode, or infra-failure
 * fallback where the session was never linked to a server profile). */
async function persistMeasurementsIfLoggedIn(height, weight) {
  if (!PEAR_USER_ID) return;
  try {
    await fetch(`/api/users/${encodeURIComponent(getDeviceId())}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ height, weight }),
    });
    stampMeasurementsDate();
    if (PEAR_USER) { PEAR_USER.height = Number(height); PEAR_USER.weight = Number(weight); }
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

  const heightEl = $("profileHeight"), weightEl = $("profileWeight");
  if (heightEl) heightEl.textContent = PEAR_USER.height != null ? `${PEAR_USER.height} ס"מ` : "-";
  if (weightEl) weightEl.textContent = PEAR_USER.weight != null ? `${PEAR_USER.weight} ק"ג` : "-";

  const sizeEl = $("profileSize");
  if (sizeEl) {
    const sizeText = $("final-size-text");
    sizeEl.textContent = (sizeText && sizeText.innerText.trim()) || currentUserSize || "-";
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
  const render = () => { if (el) el.textContent = remaining > 0 ? `${remaining} שניות נותרו` : "הקוד פג תוקף"; };
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
  if (hint) hint.textContent = `שלחנו קוד ל: ${email}`;
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
  toast("האימייל הזה כבר רשום - שלחנו קוד לאימות זהות");
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
    if (errEl) { errEl.textContent = "שיוך המכשיר נכשל - נסה שוב."; errEl.hidden = false; }
  } catch (err) {
    console.warn("[identity] relink request failed:", err?.message || err);
    if (errEl) { errEl.textContent = "שגיאת רשת - נסה שוב."; errEl.hidden = false; }
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
      const msg = (data && (data.message || data.error)) || "נא לבדוק את הפרטים ולנסות שוב.";
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
  if (!PEAR_OTP_PENDING) return showErr("משהו השתבש - נא לשלוח קוד חדש.");
  if (!/^\d{6}$/.test(code)) return showErr("נא להזין קוד בן 6 ספרות.");

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
      showErr("הקוד פג תוקף. שלח שוב");
    } else {
      showErr("קוד שגוי. נסה שוב");
    }
  } catch (err) {
    console.warn("[otp] verify failed:", err?.message || err);
    showErr("שגיאת רשת - נסה שוב.");
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
      toast("קוד חדש נשלח");
    } else {
      const errEl = $("otp-error");
      if (errEl) { errEl.textContent = (data && (data.message || data.error)) || "שליחת הקוד נכשלה - נסה שוב."; errEl.hidden = false; }
    }
  } catch (err) {
    console.warn("[otp] resend failed:", err?.message || err);
    const errEl = $("otp-error");
    if (errEl) { errEl.textContent = "שגיאת רשת - נסה שוב."; errEl.hidden = false; }
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

  if (name.length < 2)  return showErr("נא להזין שם מלא.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr("נא להזין כתובת אימייל תקינה.");
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
    return showErr((data && (data.message || data.error)) || "שליחת קוד האימות נכשלה - נסה שוב.");
  } catch (err) {
    // Network error / API server down - never a dead end.
    if (btn) btn.disabled = false;
    console.warn("[identity] send-otp failed:", err?.message || err);
    showErr("שגיאת רשת - נסה שוב.");
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
    size:        size       || "",   // calculated size
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
function armFirstFrameBilling(video, gen) {
  if (!video || billingStarted || gen !== sessionGen) return;
  let done = false;
  const isDressedFrame = () => {
    const s = sampleVideoLuma(video);
    return s.ready && s.avgLuma > CAMERA_BLACK_AVG_LUMA && s.blackFrac < CAMERA_BLACK_PIXEL_FRAC;
  };
  const fire = () => {
    if (done) return;
    done = true;
    if (gen !== sessionGen) return;      // session was torn down before the first frame
    dressedFrameReady = true;            // model-ready signal shared with the recorder (startRecording)
    startBillingWindow(gen);
  };
  // TWO independent gates, both required before firing - each closes a gap the other
  // doesn't cover:
  //  (1) isGarmentApplied - rtClient.set() has resolved, so this can't be a stray
  //      raw/undressed passthrough frame that arrived before the apply request even
  //      went out.
  //  (2) isDressedFrame() - the frame is verified non-black, so it can't be the ~1s of
  //      blank/black placeholder Decart's server can still emit for a beat AFTER the
  //      apply was acknowledged (see the BLACK-FRAME FIX note in startRecording).
  // Re-checked on every subsequent decoded frame (rVFC, or the rAF poll below where
  // rVFC is unavailable) until both hold, THEN fire - so billing, the countdown, and
  // recording (started together in startBillingWindow) all begin on the first frame
  // that is genuinely ready, never before.
  const frameReady = () => {
    if (done || gen !== sessionGen) return;
    if (!isGarmentApplied || !isDressedFrame()) {
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
    if (currentAngle === AUTO_ANGLE) autoOrientation = "front";

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
    await applyActive();               // rtClient.set({ prompt, image(s), enhance:false })
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
  if (inputThrottle) { try { inputThrottle.dispose(); } catch (_) {} inputThrottle = null; }
  if (realtimeInput) { try { realtimeInput.getTracks().forEach((t) => t.stop()); } catch (_) {} realtimeInput = null; }
  const ai = $("aiVideo");
  if (ai) { ai.style.display = "none"; ai.srcObject = null; }
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
/* Codec selection is platform-aware (mobile download fix):
   • MOBILE - try H.264 MP4 first. iOS Photos / Android galleries natively save MP4,
     and the MP4 container carries a correct duration header, which kills the
     "broken 14-second clip" bug WebM exhibits (WebM from MediaRecorder ships no
     top-level duration, so phone players show a bogus/black length).
   • DESKTOP - keep the proven VP8/WebM path (Chrome/Firefox encode the canvas track
     into .webm most reliably; a missing/unsupported codec is what left the file
     black). MP4 stays as a tail fallback either way.
   Every candidate is feature-tested via isTypeSupported before use. */
function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const mp4  = ["video/mp4;codecs=h264", "video/mp4;codecs=avc1.42E01E", "video/mp4"];
  const webm = ["video/webm;codecs=vp8", "video/webm", "video/webm;codecs=vp9"];
  const candidates = IS_MOBILE ? [...mp4, ...webm] : [...webm, ...mp4];
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
  }
  return null;
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
    try {
      const mime = pickRecorderMime();
      mediaRecorder = new MediaRecorder(captured, mime ? { mimeType: mime } : undefined);
      // Record what the recorder ACTUALLY negotiated so the Blob/File + filename carry
      // the true container (the browser may pick something other than our request).
      recorderMime = (mediaRecorder.mimeType || mime || "").toLowerCase() || null;
    } catch (e) {
      console.warn("MediaRecorder unavailable:", e?.message || e);
      stopPaintLoop();
      return;
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
        try { ctx.drawImage(video, 0, 0, w, h); beginRecorder(); } catch (_) {}
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
  const type = (recordedBlob && recordedBlob.type) || (recorderMime || "").split(";")[0] || "video/webm";
  const ext = type.indexOf("mp4") > -1 ? "mp4" : "webm";
  const base = (activeItem && activeItem.name ? activeItem.name : "session").replace(/\s+/g, "-");
  const filename = `pear-fitting-${base}.${ext}`;

  // 1) Native gallery save via the share sheet (the reliable mobile path).
  if (recordedBlob && typeof navigator.canShare === "function" && typeof navigator.share === "function") {
    try {
      const file = new File([recordedBlob], filename, { type });
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
  if (!recordedUrl && recordedBlob) recordedUrl = URL.createObjectURL(recordedBlob);
  const a = document.createElement("a");
  a.href = recordedUrl;
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
  const best = natural.reduce((m, b) => Math.max(m, b.score || 0), 0);
  if (best < U.MIN_CONFIDENCE) return [];
  return natural.slice(0, U.MAX_BOXES);
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

function garmentThumb(item) {
  const base = "display:block;width:100%;height:100%;overflow:hidden;";
  if (item.img) {
    return `<span style="${base}"><img src="${item.img}" alt="${item.name}" loading="lazy" decoding="async"></span>`;
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
  } else if (state === "connecting" || state === "reconnecting") {
    b.style.color = "#d08a17";
    b.textContent = "● מתחבר…";
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
  arr.push({ img: imageSrc, name: garmentName || "Look", size: size || "-", ts,
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
      dlBtn.download = `PEAR-fit-${it.ts}.${(recorderMime && recorderMime.includes("mp4")) ? "mp4" : "webm"}`;
      if (IS_MOBILE) dlBtn.target = "_blank";
    } else { dlBtn.hidden = true; dlBtn.removeAttribute("href"); }
  }
  lb.classList.add("show");
}

/* "Try again live" - restore the exact garment this fit was captured with (when
   still in the catalog) and open a fresh, optimized 5-second live session. */
function replayFitLive(it) {
  if (isDemoLocked()) { toast("כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!"); return; }
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
    toast("כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!");
    return;
  } else {
    resetToLive();
  }
  const cc = $("cameraCard");
  if (cc) cc.scrollIntoView({ behavior: "smooth", block: "center" });
}

function init() {
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
    let raf = 0;

    const reset = () => {
      cancelAnimationFrame(raf);
      card.classList.remove("is-tilting");
      card.style.transform = "";
    };

    card.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;   // 0 … 1
        const fy = (e.clientY - r.top) / r.height;   // 0 … 1
        const px = fx - 0.5;                          // -0.5 … 0.5
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
      });
    });
    card.addEventListener("pointerleave", reset);
    card.addEventListener("touchend", reset, { passive: true });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();