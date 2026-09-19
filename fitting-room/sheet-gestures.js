/* ============================================================================
   sheet-gestures.js - PEAR fitting room · mobile sheet physics
   ----------------------------------------------------------------------------
   ADDITIVE, like mobile-ux.js: reads no app.js state and writes none. It moves
   an element marked [data-sheet] under the shopper's finger, and when a swipe
   completes it triggers that surface's OWN close path - so what app.js believes
   is open never diverges from what is on screen.

     [data-sheet="compare"]  → clicks #compareClose   (Compare Fits overlay)
     [data-sheet="detect"]   → clicks #gdClose        (garment-detection overlay)
     [data-sheet="room"]     → posts PEAR_CLOSE_REQUEST to the host page, whose
                               widget runs its normal closeModal() - camera
                               teardown ack included (pear-widget.js). Embedded
                               only (html.pear-embedded, set in index.html): a
                               standalone room has no modal to close.

   Grab zones: [data-sheet-handle] (the .drag-indicator bar) and [data-sheet-grab]
   (a sheet's header - minus any control inside it). Never the sheet body: the
   Screen-1 card is a form and the overlays scroll, and a drag that starts on
   either would steal the gesture the shopper actually meant.

   WHY `translate`, NOT `transform`. Both overlay panels run a fill-mode:both
   entrance animation on `transform`, and an animation's held end value outranks
   every inline style - a transform-based drag would not move them at all. The
   individual `translate` property composes with the animated transform instead.

   Mobile only (≤768px, the same breakpoint the .drag-indicator CSS uses), checked
   at press time so a rotated or resized viewport is honoured without re-binding.
   ============================================================================ */
(() => {
  "use strict";

  const MOBILE = matchMedia("(max-width: 768px)");
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";   // iOS sheet curve - see --ease-sheet in style.css
  const HAS_TRANSLATE = typeof CSS !== "undefined" && CSS.supports && CSS.supports("translate", "0 1px");

  const START_SLOP_PX   = 6;      // a press only becomes a drag past this - taps still click
  const MIN_DISMISS_PX  = 24;     // never dismiss on a twitch, however fast
  const DISMISS_FRAC    = 0.28;   // ...or past this share of the sheet's height
  const DISMISS_CAP_PX  = 160;    // ...capped, so a tall sheet is not a marathon
  const FLING_PX_PER_MS = 0.55;   // a downward flick this fast dismisses early
  const RUBBER          = 0.18;   // upward drag resistance (the sheet is already "open")
  const RUBBER_MAX_PX   = 28;
  const SPRING_MS       = 520;
  const EXIT_MS         = 320;
  const HOST_WAIT_MS    = 700;    // room only: spring back if no host modal closed us

  const INTERACTIVE = "button, a, input, select, textarea, label, [role='button'], [role='tab'], [role='switch']";

  const DISMISS = {
    compare: () => clickEl("#compareClose"),
    detect:  () => clickEl("#gdClose"),
    terms:   () => clickEl("#termsClose"),   // the policy popup (setupTermsModal in app.js)
    room:    requestHostClose,
  };

  function clickEl(sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }

  /* The host's widget validates e.source against its own iframe, so the wildcard
     target origin leaks nothing: the message carries no data, and only the frame
     the widget itself opened can close it. */
  function requestHostClose() {
    try {
      if (window.parent === window) return false;
      window.parent.postMessage({ type: "PEAR_CLOSE_REQUEST", source: "sheet-swipe" }, "*");
      console.log("[PEAR] sheet: swipe-to-dismiss → PEAR_CLOSE_REQUEST sent to host");
      return true;
    } catch (_) { return false; }
  }

  function setOffset(sheet, px) {
    if (HAS_TRANSLATE) sheet.style.translate = `0 ${px}px`;
    else sheet.style.transform = `translate3d(0, ${px}px, 0)`;
  }

  function backdropOf(sheet) {
    return sheet.parentElement
      ? sheet.parentElement.querySelector(":scope > .pcmp__backdrop, :scope > .gd-overlay__backdrop, :scope > .terms-modal__backdrop")
      : null;
  }

  function clearInline(sheet, backdrop) {
    sheet.classList.remove("is-dragging");
    ["translate", "transform", "transition", "will-change"].forEach((p) => sheet.style.removeProperty(p));
    if (backdrop) { backdrop.style.removeProperty("opacity"); backdrop.style.removeProperty("transition"); }
  }

  let drag = null;

  function onPointerDown(e) {
    if (drag || !MOBILE.matches) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const grab = e.target.closest && e.target.closest("[data-sheet-handle], [data-sheet-grab]");
    if (!grab) return;
    // A header is a grab zone, the close button / tabs inside it are not.
    if (!grab.hasAttribute("data-sheet-handle") && e.target.closest(INTERACTIVE)) return;
    const sheet = grab.closest("[data-sheet]");
    if (!sheet || !DISMISS[sheet.dataset.sheet]) return;
    if (sheet.dataset.sheet === "room" && !document.documentElement.classList.contains("pear-embedded")) return;

    drag = {
      sheet, grab,
      kind: sheet.dataset.sheet,
      pointerId: e.pointerId,
      startY: e.clientY,
      dy: 0,
      active: false,
      armed: false,   // crossed the dismiss threshold (drives the one-shot haptic)
      height: sheet.getBoundingClientRect().height || window.innerHeight,
      backdrop: backdropOf(sheet),
      samples: [{ t: e.timeStamp, y: e.clientY }],
    };
  }

  function onPointerMove(e) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const raw = e.clientY - d.startY;

    if (!d.active) {
      if (Math.abs(raw) < START_SLOP_PX) return;
      d.active = true;
      try { d.grab.setPointerCapture(e.pointerId); } catch (_) {}
      d.sheet.classList.add("is-dragging");
      d.sheet.style.transition = "none";
      d.sheet.style.willChange = HAS_TRANSLATE ? "translate" : "transform";
      if (d.backdrop) d.backdrop.style.transition = "none";
    }

    // Follow the finger 1:1 downward; resist (and cap) upward - the sheet is open already.
    d.dy = raw >= 0 ? raw : Math.max(-RUBBER_MAX_PX, raw * RUBBER);
    setOffset(d.sheet, d.dy);

    if (d.backdrop) {
      const progress = Math.min(1, Math.max(0, d.dy) / d.height);
      d.backdrop.style.opacity = String(1 - progress * 0.75);
    }

    const threshold = Math.min(DISMISS_CAP_PX, d.height * DISMISS_FRAC);
    const armed = d.dy > threshold;
    if (armed && !d.armed && navigator.vibrate) { try { navigator.vibrate(6); } catch (_) {} }
    d.armed = armed;

    d.samples.push({ t: e.timeStamp, y: e.clientY });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 100) d.samples.shift();
  }

  /* Downward speed over the last ~100ms of movement, px/ms. */
  function releaseVelocity(d) {
    const s = d.samples;
    if (s.length < 2) return 0;
    const a = s[0], b = s[s.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.y - a.y) / dt : 0;
  }

  function onPointerEnd(e) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    drag = null;
    if (!d.active) return;   // it was a tap - the click proceeds untouched
    try { d.grab.releasePointerCapture(e.pointerId); } catch (_) {}

    const v = releaseVelocity(d);
    const threshold = Math.min(DISMISS_CAP_PX, d.height * DISMISS_FRAC);
    const dismiss = e.type === "pointerup" && d.dy > MIN_DISMISS_PX &&
                    (d.dy > threshold || v > FLING_PX_PER_MS);
    if (dismiss) dismissSheet(d, v);
    else springBack(d);
  }

  function springBack(d) {
    const { sheet, backdrop } = d;
    sheet.classList.remove("is-dragging");
    const ms = REDUCE.matches ? 0 : SPRING_MS;
    sheet.style.transition = `${HAS_TRANSLATE ? "translate" : "transform"} ${ms}ms ${EASE}`;
    setOffset(sheet, 0);
    if (backdrop) {
      backdrop.style.transition = `opacity ${ms}ms ${EASE}`;
      backdrop.style.opacity = "1";
    }
    setTimeout(() => clearInline(sheet, backdrop), ms + 30);
  }

  function dismissSheet(d, v) {
    const { sheet, backdrop, kind } = d;
    sheet.classList.remove("is-dragging");
    // A hard flick leaves faster than a slow drag released past the line.
    const ms = REDUCE.matches ? 0 : (v > FLING_PX_PER_MS * 1.6 ? Math.round(EXIT_MS * 0.75) : EXIT_MS);
    const offscreen = Math.max(d.height, window.innerHeight) + 40;
    sheet.style.transition = `${HAS_TRANSLATE ? "translate" : "transform"} ${ms}ms ${EASE}`;
    setOffset(sheet, offscreen);
    if (backdrop) {
      backdrop.style.transition = `opacity ${ms}ms ${EASE}`;
      backdrop.style.opacity = "0";
    }

    setTimeout(() => {
      const handled = DISMISS[kind]();
      if (kind === "room") {
        // The host tears the iframe down (teardown ack ≤250ms, pear-widget.js). Still
        // here after that? Standalone, or a widget build without PEAR_CLOSE_REQUEST -
        // come back up rather than leave the shopper on an empty screen.
        setTimeout(() => springBack(d), handled ? HOST_WAIT_MS : 0);
      } else {
        // The overlay has hidden itself by now; reset so the next open starts clean.
        setTimeout(() => clearInline(sheet, backdrop), 340);
      }
    }, ms);
  }

  addEventListener("pointerdown", onPointerDown, { passive: true });
  addEventListener("pointermove", onPointerMove, { passive: true });
  addEventListener("pointerup", onPointerEnd, { passive: true });
  addEventListener("pointercancel", onPointerEnd, { passive: true });
})();
