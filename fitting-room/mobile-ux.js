/* ============================================================================
   mobile-ux.js - PEAR fitting room · additive touch-interaction layer
   ----------------------------------------------------------------------------
   PURE ENHANCEMENT. This file only ADDS classes and decorative nodes. It never
   reads, writes, or interferes with app.js state, the Decart session, billing,
   or any existing id/class/state hook. Safe to remove with zero functional loss.

   It provides four things the phone UI was missing:
     1. Scroll-reveal - Screen-2 blocks rise + fade in as they enter the viewport.
     2. Sticky-header shrink - the app header compacts once you scroll into the stage.
     3. Tap ripple - a soft pear-tinted ripple blooms from the touch point.
     4. Haptics - a 7ms tick on key controls (Android; iOS silently ignores).

   All motion is gated behind prefers-reduced-motion. Reveal classes are added by
   JS only, so with JS disabled (or reduced motion) every block stays fully visible.
   ============================================================================ */
(() => {
  "use strict";

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── 1) Scroll-reveal ─────────────────────────────────────────────────────
     Targets the fitting-room blocks that have no entrance orchestration of their
     own (the calculator + gallery pod already animate themselves). reveal-up's
     hidden state lives in CSS but only applies once THIS script adds the class,
     so a no-JS / reduced-motion visit shows everything immediately. */
  const SEL = ".personal-title, .camera-card, .cam-controls, .catalog-panel, .complete-look";
  let io = null;

  if (!reduce && "IntersectionObserver" in window) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in-view"); io.unobserve(e.target); }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });

    document.querySelectorAll(SEL).forEach((el) => {
      el.classList.add("reveal-up");
      io.observe(el);
    });
  }

  /* Belt-and-suspenders: when a block is already on screen (e.g. right after the
     calculator → fitting-room screen switch, when the hidden→visible flip can make
     the observer miss the first frame), reveal anything within reach so nothing can
     ever get stuck invisible. */
  const sweep = () => {
    document.querySelectorAll(".reveal-up:not(.in-view)").forEach((el) => {
      if (el.offsetParent === null) return;                 // still inside a hidden screen
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight * 1.15 && r.bottom > 0) {
        el.classList.add("in-view");
        if (io) io.unobserve(el);
      }
    });
  };
  ["btn-next-screen"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => setTimeout(sweep, 90), { passive: true });
  });
  setTimeout(sweep, 1400);

  /* ── 2) Sticky-header shrink ─────────────────────────────────────────────── */
  const header = document.querySelector(".app-header");
  const focusBar = document.querySelector(".focus-bar");
  if (header || focusBar) {
    const onScroll = () => {
      const scrolled = scrollY > 12;
      // .profile-btn is position:fixed and sits BEFORE .app-header in the DOM (see
      // index.html), so a `.app-header.is-scrolled ~ .profile-btn` sibling selector
      // can't reach it - CSS combinators only select forward. A shared flag on
      // <body> lets ANY component react to the same scroll threshold regardless of
      // its position in the document (see style.css: body.is-scrolled .profile-btn).
      document.body.classList.toggle("is-scrolled", scrolled);
      if (header) header.classList.toggle("is-scrolled", scrolled);
      if (focusBar) focusBar.classList.toggle("is-scrolled", scrolled);
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ── 3) Tap ripple + 4) haptic ───────────────────────────────────────────
     Delegated so it covers controls app.js injects later (Watch / Download). The
     ripple node is pointer-events:none and self-removes, so it can never swallow a
     click or alter behaviour. */
  const RIPPLE = ".btn-capture, .btn-primary, .btn-watch, .btn-download, .pip-retake, .plb-btn, .pear-compare-bar";
  addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(RIPPLE);
    if (!el || el.disabled) return;

    if (navigator.vibrate) { try { navigator.vibrate(7); } catch (_) {} }
    if (reduce) return;

    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement("span");
    s.className = "pear-ripple";
    s.style.cssText =
      `width:${size}px;height:${size}px;` +
      `left:${ev.clientX - r.left - size / 2}px;` +
      `top:${ev.clientY - r.top - size / 2}px`;
    el.appendChild(s);
    s.addEventListener("animationend", () => s.remove(), { once: true });
  }, { passive: true });
})();
