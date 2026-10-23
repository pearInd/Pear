/* ============================================================================
   PEAR - Luxury micro-interaction layer  (iOS / macOS-grade polish)
   ----------------------------------------------------------------------------
   ADDITIVE ONLY. Mirrors the contract of mobile-ux.js: this file never touches
   app.js state, the Decart VTON / billing flow, or any existing id/class/state
   hook. It only *adds* theatre on top of the existing DOM.

   Features
     1. Add-to-Cart micro-interaction - press → spinner (800ms) → a mini garment
        clone flies along a 3D Bézier arc into the header cart, which jiggles;
        the button morphs to a checkmark and back.
     2. Bitten-Pear screen transition - a vector pear masks the view, a chunk
        snaps out of its side, then it bursts open to reveal Screen 2.
     3. Ambient side rails - vertical editorial tracks that parallax to scroll
        and pointer, filling desktop/tablet margins without clutter.
     4. Universal polish - magnetic button content, floating-label fields,
        a top-center spring "cart" toast, and a metallic skeleton utility.

   Palette: logo-matched ivory canvas + crisp luxury black, with PEAR GREEN
   (#8DB600) as the sole accent (buttons, active states, the Add-to-Cart family).
   Honours prefers-reduced-motion and degrades to instant, correct behaviour.
   ============================================================================ */
(function () {
  "use strict";

  const $    = (id) => document.getElementById(id);
  const POWER = "cubic-bezier(0.25, 1, 0.5, 1)";   // Apple signature power-ease
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine   = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  ready(init);

  function init() {
    initCart();
    initLiquidMesh();
    initFloatingLabels();
    initSkeletons();
    /* initMagnetic() - the content drifting toward the cursor - is retired with the Liquid Glass pass (2026-10-11):
       glass does not chase the pointer; it is pressed. See initLiquidPress() / initLiquidThumbs() below. */
    initLiquidPress();
    initLiquidThumbs();
    enableTouchActive();
  }
  /* NOTE: the Bitten-Pear transition is now orchestrated entirely by app.js
     (goToFitting → playPearTransition) so the SAME sequenced timeline serves
     both the Continue-button click and the Enter-key path, and the screen swap
     lands at the mask's mid-point. The old click-only trigger that used to live
     here was removed to avoid a double-fire. The overlay markup + keyframes are
     unchanged and still defined in index.html / style.css. */

  /* ──────────────────────────────────────────────────────────────────────────
     1 · ADD TO CART  - spinner → 3D-arc fly → cart jiggle → checkmark → reset
     ────────────────────────────────────────────────────────────────────────── */
  function initCart() {
    const btn   = $("addToCartBtn");
    const cart  = $("cartBtn");
    const badge = $("cartCount");
    if (!btn || !cart) return;

    let count = parseInt(localStorage.getItem("pear_cart_count") || "0", 10) || 0;
    renderBadge();

    function renderBadge() {
      if (!badge) return;
      badge.textContent = String(count);
      badge.classList.toggle("is-empty", count === 0);
    }

    function inIframe() {
      try { return window.self !== window.top; } catch (_) { return true; }
    }

    /* ── Active-garment guard ────────────────────────────────────────────────
       app.js's window.pearGetActiveGarment() returns NULL when no garment is selected -
       a correct, honest answer. The `|| {}` that used to sit here turned that null into
       an empty object, and every field below then fell back to "" - so a click with
       nothing selected posted PEAR_ADD_TO_CART with sku:"", variantId:"" to the host
       store. The host has no way to tell that apart from a real request for a product
       whose SKU it simply doesn't recognise, so it either 404s or, worse, adds the
       wrong line. Never send an unidentified garment.

       A garment counts as usable only if it carries an identity the host can resolve.
       Name and image are for OUR toast; sku/variantId are what the store actually needs. */
    function usableGarment() {
      try {
        const g = window.pearGetActiveGarment && window.pearGetActiveGarment();
        if (!g || typeof g !== "object") return null;
        return (g.sku || g.variantId) ? g : null;
      } catch (err) {
        // pearGetActiveGarment reads app.js module state; if that throws, treat it as
        // "not ready" rather than letting the exception kill the click handler.
        console.warn("[PEAR lux] pearGetActiveGarment threw:", err && err.message);
        return null;
      }
    }

    /* app.js populates activeItem asynchronously on a handoff (parseHandoff → catalog
       lookup → classification), so a fast click right after the room opens can land in
       the gap. Retry a few times before giving up rather than failing a click that would
       have worked 200ms later. Bounded and short: this runs under a real click, so it
       must never leave the button hanging. */
    const GARMENT_RETRIES = 4;
    const GARMENT_RETRY_MS = 150;
    function resolveGarment(tries, cb) {
      const g = usableGarment();
      if (g) return cb(g);
      if (tries <= 0) return cb(null);
      setTimeout(() => resolveGarment(tries - 1, cb), GARMENT_RETRY_MS);
    }

    function land() {
      bounceCart();   // the jiggle plays regardless of who ends up owning the count below
      resolveGarment(GARMENT_RETRIES, (garment) => {
        if (!garment) {
          /* Blocked, and SAID so. The previous behaviour was silent: an empty payload
             went out and the optimistic toast claimed success, so the shopper believed
             the item was in their cart. Failing visibly is the point. */
          console.warn("[PEAR lux] add-to-cart blocked: no identifiable active garment " +
            `after ${GARMENT_RETRIES + 1} attempts (sku/variantId both empty)`);
          springToast(byLang("לא זוהה פריט פעיל - בחרו בגד ונסו שוב · No active item - pick a garment and try again", "No active item - pick a garment and try again"));
          return;
        }
        landWithGarment(garment);
      });
    }

    function landWithGarment(garment) {
      if (inIframe()) {
        // Embedded in a store (e.g. fox.co.il) - hand the garment off to the host
        // page's own Host Cart Integration (see pear-widget.js's PEAR_ADD_TO_CART
        // listener: platform auto-detection -> host cart request -> pear:addToCart
        // broadcast -> a PEAR_ADD_TO_CART_RESULT reply, listened for below).
        // `payload` is the documented contract other integrations key off of;
        // garmentUrl/garmentName ride alongside it for the host's own toast/UI,
        // same as before.
        /* sku/variantId are NOT ""-defaulted any more. usableGarment() has already
           guaranteed at least one of them is present, so an empty string here would be a
           real identity we are discarding rather than a missing one we are papering over -
           and the host must be able to tell "not provided" (undefined, key omitted) from
           "provided as blank". `color` rides along so the host's own cart UI can show the
           variant the shopper actually picked. */
        window.parent.postMessage({
          type: "PEAR_ADD_TO_CART",
          payload: {
            sku: garment.sku || undefined,
            size: garment.size || "",
            quantity: garment.quantity || 1,
            variantId: garment.variantId || undefined,
            color: garment.color || undefined,
          },
          garmentUrl: garment.url || "",
          garmentName: garment.name || "",
        }, "*");
        // The Full Bi-directional Cart Sync module in app.js owns #cartCount
        // in iframe mode from here (PEAR_ADD_TO_CART_RESULT / PEAR_CART_SYNC
        // land a moment after this resolves) - NOT bumped here too, so the
        // two never fight over the same badge with two competing counts.
        // Optimistic toast only - fires immediately so the interaction still
        // feels instant even on a slow host network. PEAR_ADD_TO_CART_RESULT
        // below only ever CORRECTS this on an explicit, host-reported
        // failure; a widget build that never replies (older embeds) simply
        // leaves this as the final word, exactly like the fire-and-forget
        // behaviour before it. Names the size when known (adult letter scale or
        // kids numeric scale alike) so the confirmation matches what was actually
        // tried on, not just "something was added".
        springToast(garment.size
          ? byLang(`הפריט במידה ${garment.size} נוסף לעגלה · Size ${garment.size} added to cart`, `Size ${garment.size} added to cart`)
          : byLang("נוסף לסל · Added to cart", "Added to cart"));
      } else {
        // Standalone (PEAR demo site, no host store to sync with) - this
        // local counter IS the source of truth here, so it still owns the badge.
        count += 1;
        localStorage.setItem("pear_cart_count", String(count));
        renderBadge();
        springToast(byLang("הפריט נוסף לסל! (דמו)", "Added to cart (demo)"));
      }
    }

    // Feedback Sync - pear-widget.js replies with this once its Host Cart
    // Integration actually resolves (see the PEAR_ADD_TO_CART listener there).
    // Only ever downgrades the optimistic toast above on an explicit,
    // host-reported failure (e.data.ok === false); an ok:true, or an older
    // widget build that never replies at all, leaves the optimistic toast as
    // the only - and final - word, so nothing regresses for merchants who
    // haven't updated pear-widget.js yet. e.source is checked against
    // window.parent (not a fixed origin allowlist - this page is embedded on
    // arbitrary, unknown-in-advance host stores) so only a reply from the
    // actual embedding page is ever acted on.
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      if (!e.data || e.data.type !== "PEAR_ADD_TO_CART_RESULT") return;
      if (e.data.ok === false) {
        springToast(byLang("נשמר - ההוספה האוטומטית לסל החנות נכשלה, נא להוסיף ידנית · Saved - couldn't add to the store cart automatically, please add it manually", "Saved - couldn't add to the store cart automatically, please add it manually"));
      }
    });

    let busy = false;
    btn.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      btn.setAttribute("aria-busy", "true");

      if (reduce) {                         // no theatre - just confirm
        land();
        btn.classList.add("is-done");
        setTimeout(() => { btn.classList.remove("is-done"); btn.removeAttribute("aria-busy"); busy = false; }, 1100);
        return;
      }

      // Press → loading spinner for 800ms (button stays scaled-in via :active style).
      btn.classList.add("is-loading");
      setTimeout(() => {
        btn.classList.remove("is-loading");
        btn.classList.add("is-done");        // elegant checkmark morph
        flyClone(land);                      // the mini garment takes flight
        // Smoothly morph back to the original label.
        setTimeout(() => { btn.classList.remove("is-done"); btn.removeAttribute("aria-busy"); busy = false; }, 1500);
      }, 800);
    });

    function bounceCart() {
      cart.classList.remove("is-bounce");
      void cart.offsetWidth;                 // restart the keyframe
      cart.classList.add("is-bounce");
      setTimeout(() => cart.classList.remove("is-bounce"), 720);
    }
  }

  /* Build a mini clone of the garment (or a clean pear-green dot) and animate it
     from the canvas centre into the cart icon along a lifted Bézier arc. */
  function flyClone(onLand) {
    const card = $("cameraCard");
    const cart = $("cartBtn");
    if (!card || !cart) { onLand && onLand(); return; }

    const from = card.getBoundingClientRect();
    const to   = cart.getBoundingClientRect();
    const sx = from.left + from.width / 2,  sy = from.top + from.height / 2;
    const ex = to.left   + to.width   / 2,  ey = to.top  + to.height  / 2;

    // A tiny pear-green particle dot (iOS dynamic-island style) flows into the bag.
    const clone = document.createElement("div");
    clone.className = "cart-fly cart-fly--dot";
    clone.style.left = sx + "px";
    clone.style.top  = sy + "px";
    document.body.appendChild(clone);

    const dx = ex - sx, dy = ey - sy;
    const arc = Math.min(140, Math.abs(dx) * 0.35 + 70);   // how high the arc lifts
    const anim = clone.animate(
      [
        { transform: "translate(-50%,-50%) scale(1) rotate(0deg)", opacity: 1, offset: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - arc}px)) scale(.62) rotate(10deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.14) rotate(-6deg)`, opacity: 0.35, offset: 1 },
      ],
      { duration: 850, easing: POWER, fill: "forwards" }
    );
    anim.onfinish = () => { clone.remove(); onLand && onLand(); };
    // Safety net if onfinish never fires (tab backgrounded, etc.)
    setTimeout(() => { if (clone.isConnected) { clone.remove(); onLand && onLand(); } }, 1200);
  }

  /* Top-center spring toast - reserved for cart confirmations so the existing
     bottom measurement toasts (app.js → toast()) are left exactly as they are. */
  let cartToastEl = null, cartToastTimer = 0;
  /* The page's language as i18n.js keeps it on <html lang> - this classic script imports
     nothing, so it reads the attribute. English gets English only, never the Hebrew half. */
  function byLang(he, en) { return document.documentElement.lang === "en" ? en : he; }

  function springToast(msg) {
    if (!cartToastEl) {
      cartToastEl = document.createElement("div");
      cartToastEl.className = "lux-cart-toast";
      cartToastEl.setAttribute("role", "status");
      cartToastEl.innerHTML =
        '<span class="lux-cart-toast__icon" aria-hidden="true"><svg class="lg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5.5 12.6l4.3 4.3 8.7-9.4"/></svg></span><span class="lux-cart-toast__msg"></span>';
      document.body.appendChild(cartToastEl);
    }
    cartToastEl.querySelector(".lux-cart-toast__msg").textContent = msg;
    cartToastEl.classList.remove("show");
    void cartToastEl.offsetWidth;
    cartToastEl.classList.add("show");
    clearTimeout(cartToastTimer);
    cartToastTimer = setTimeout(() => cartToastEl.classList.remove("show"), 2600);
  }

  /* ──────────────────────────────────────────────────────────────────────────
     4a · FLOATING LABELS + MICRO-INERTIA - the label glides up + tints when
     focused/filled, and (while focused, desktop pointers) drifts magnetically
     toward the cursor via --lblx/--lbly, giving the field tangible weight.
     Driven purely by classes/vars so app.js's input listeners stay untouched.
     ────────────────────────────────────────────────────────────────────────── */
  function initFloatingLabels() {
    document.querySelectorAll("#sizeForm .form-group").forEach((g) => {
      const input = g.querySelector("input");
      const label = g.querySelector("label");
      if (!input) return;
      g.classList.add("lux-field");
      const sync = () => g.classList.toggle("is-filled", !!input.value);
      input.addEventListener("focus", () => g.classList.add("is-focus"));
      input.addEventListener("blur",  () => { g.classList.remove("is-focus"); sync(); });
      input.addEventListener("input", sync);
      sync();

      // magnetic micro-inertia - only while the field is focused, on fine pointers
      if (label && fine && !reduce) {
        let raf = 0;
        const reset = () => { label.style.setProperty("--lblx", "0px"); label.style.setProperty("--lbly", "0px"); };
        g.addEventListener("pointermove", (e) => {
          if (e.pointerType === "touch" || !g.classList.contains("is-focus")) return;
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            const r = g.getBoundingClientRect();
            const px = (e.clientX - (r.left + r.width  / 2)) / r.width;
            const py = (e.clientY - (r.top  + r.height / 2)) / r.height;
            label.style.setProperty("--lblx", (px * 7).toFixed(1) + "px");
            label.style.setProperty("--lbly", (py * 4).toFixed(1) + "px");
          });
        });
        g.addEventListener("pointerleave", () => { cancelAnimationFrame(raf); reset(); });
        input.addEventListener("blur", () => { cancelAnimationFrame(raf); reset(); });
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────────────
     LIQUID-GLASS DYNAMIC BACKGROUND - inertial mesh parallax (transform only).
     The mesh eases toward a pointer/tilt-derived target each frame; the rAF loop
     runs ONLY while settling, so there is zero idle cost.
     ────────────────────────────────────────────────────────────────────────── */
  function initLiquidMesh() {
    const mesh = document.querySelector(".liquid-mesh");
    if (!mesh || reduce) return;

    const AMP = 26;                       // max drift in px (microscopic)
    let tx = 0, ty = 0, cx = 0, cy = 0, running = false;

    const loop = () => {
      cx += (tx - cx) * 0.06;             // inertia toward the target
      cy += (ty - cy) * 0.06;
      mesh.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`;
      if (Math.abs(tx - cx) > 0.08 || Math.abs(ty - cy) > 0.08) {
        requestAnimationFrame(loop);
      } else { running = false; }
    };
    const kick = () => { if (!running) { running = true; requestAnimationFrame(loop); } };

    if (fine) {
      window.addEventListener("mousemove", (e) => {
        tx = (e.clientX / window.innerWidth  - 0.5) * AMP;
        ty = (e.clientY / window.innerHeight - 0.5) * AMP;
        kick();
      }, { passive: true });
    } else if (window.DeviceOrientationEvent) {
      // mobile: subtle tilt parallax (no permission prompt - inert if denied)
      window.addEventListener("deviceorientation", (ev) => {
        const clamp = (v) => Math.max(-1, Math.min(1, v));
        tx = clamp((ev.gamma || 0) / 30) * AMP;
        ty = clamp((ev.beta  || 0) / 30) * AMP;
        kick();
      }, { passive: true });
    }
  }

  /* 4b · METALLIC SKELETON - shimmer garment thumbnails until their image loads. */
  function initSkeletons() {
    const media = $("activeGarmentMedia");
    if (!media || !("MutationObserver" in window)) return;
    const tag = () => {
      media.querySelectorAll("img:not([data-lux])").forEach((img) => {
        img.dataset.lux = "1";
        if (img.complete && img.naturalWidth) return;
        const host = img.closest("span") || media;
        host.classList.add("lux-skeleton");
        const clear = () => host.classList.remove("lux-skeleton");
        img.addEventListener("load",  clear, { once: true });
        img.addEventListener("error", clear, { once: true });
      });
    };
    new MutationObserver(tag).observe(media, { childList: true, subtree: true });
    tag();
  }

  /* 4c · MAGNETIC BUTTONS - the inner content drifts toward the cursor.
     We move the *content*, never the button box, so the existing transform-based
     hover / press / pulse states keep working untouched. Desktop pointers only. */
  function initMagnetic() {
    const targets = document.querySelectorAll(".btn-primary, .btn-capture, #addToCartBtn, .btn-watch");
    targets.forEach((el) => {
      const kids = Array.from(el.children);
      if (!kids.length) return;
      let raf = 0;
      el.classList.add("lux-magnetic");
      el.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          const px = (e.clientX - (r.left + r.width  / 2)) / r.width;
          const py = (e.clientY - (r.top  + r.height / 2)) / r.height;
          const tx = (px * 12).toFixed(1), ty = (py * 8).toFixed(1);
          kids.forEach((k) => { k.style.transform = `translate(${tx}px, ${ty}px)`; });
        });
      });
      el.addEventListener("pointerleave", () => {
        cancelAnimationFrame(raf);
        kids.forEach((k) => { k.style.transform = ""; });
      });
    });
  }

  /* 4e · THE BUBBLE PRESS (2026-10-11, the Liquid Glass pass - style.css "LIQUID GLASS"). "When you press it should
     sink in like a bubble, the way Apple's does - not this light." Held, a glass button squashes in (wider than it is
     tall, the way a bubble flattens under a finger) and its glass darkens inward (.lg-press, CSS); released, it springs
     back through one soft overshoot.
     HOVER, PRESS AND RELEASE ARE ONE MOTION (reported: "resting on a button with the mouse, or on a phone, doesn't feel
     good"). Each button has one small state - hovered (a mouse only), pressed - and one running animation of the
     individual `scale` property (Web Animations), always started from where the glass IS: a mouse lifts it (1.025),
     a press sinks it from there, a release springs it back to the lift if the mouse is still on it, to rest if not. A
     finger sinks it at once - like a native control - and a press the browser takes over for a scroll (pointercancel)
     settles back quietly, no pop. Touch never hovers (style.css 3b). Nothing here touches a button's own transform,
     transition list or entrance animation, and nothing intercepts the click: it only listens. Disabled, aria-disabled
     and busy buttons do not move. */
  function initLiquidPress() {
    const PRESSABLE = ".btn-primary, .btn-ghost, .btn-capture, .btn-add-cart, .btn-watch, .btn-download, " +
      ".btn-update-measure, .btn-edit-measurements, .cart-btn, .cookie-btn, .pear-compare-bar, .plb-btn, .pear-sz-btn, " +
      ".pear-rz-btn, .pcmp__close, .terms-modal__close, .gd-close, .pear-lightbox__close, .pear-help-widget__btn, " +
      ".pear-help-widget__close, .camera-card__flip, .camera-card__timer, .cl-arrow, .pip-retake, .pip-clear, " +
      ".profile-btn, .profile-dropdown__logout, .cart-line__remove, .cl-card__look";
    if (typeof Element === "undefined" || !Element.prototype.animate) return;
    const REST = [1, 1], LIFT = [1.025, 1.025], SINK = [0.955, 0.925];
    const QUICK_TAP_MS = 120;   // a release sooner than this has not let the glass sink yet
    const states = new WeakMap();
    const stateOf = (el) => { let st = states.get(el); if (!st) { st = { hover: false, pressed: false, anim: null }; states.set(el, st); } return st; };
    const inert = (el) => el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("is-loading");
    const now = (el) => {
      const v = getComputedStyle(el).scale;
      if (!v || v === "none") return REST;
      const n = v.trim().split(/\s+/).map(Number);
      return [n[0] || 1, Number.isFinite(n[1]) ? n[1] : (n[0] || 1)];
    };
    const fmt = (v) => `${v[0].toFixed(4)} ${v[1].toFixed(4)}`;
    const goal = (st) => (st.pressed ? SINK : st.hover ? LIFT : REST);
    const run = (el, frames, opts) => {
      const st = stateOf(el);
      let a = null;
      try { a = el.animate(frames, Object.assign({ fill: "forwards" }, opts)); } catch (_) { return; }
      const prev = st.anim;
      st.anim = a;
      if (prev) { try { prev.cancel(); } catch (_) {} }
      /* back at rest: nothing is left holding the property */
      a.onfinish = () => { if (st.anim === a && !st.hover && !st.pressed) { try { a.cancel(); } catch (_) {} st.anim = null; } };
    };
    const move = (el, how) => {
      const st = stateOf(el);
      if (reduce) { if (st.anim) { try { st.anim.cancel(); } catch (_) {} st.anim = null; } return; }
      const from = now(el), to = goal(st);
      /* Easing per SEGMENT (keyframe easing), the whole run linear: one easing over the whole run raced through the
         sink in ~40ms and the bubble was never seen. */
      const IN = "cubic-bezier(.3, .7, .4, 1)", OUT = "cubic-bezier(.22, .9, .36, 1)", SETTLE = "cubic-bezier(.45, 0, .55, 1)";
      if (how === "press") run(el, [{ scale: fmt(from), easing: IN }, { scale: fmt(to) }], { duration: 140 });
      else if (how === "pop" && performance.now() - st.since < QUICK_TAP_MS) {
        /* a tap quicker than the sink itself: play the whole bubble - in, then out - so a quick tap is felt too */
        run(el, [{ scale: fmt(from), easing: IN }, { scale: fmt(SINK), offset: 0.2, easing: OUT },
                 { scale: fmt([to[0] * 1.022, to[1] * 1.04]), offset: 0.5, easing: SETTLE },
                 { scale: fmt([to[0] * 0.996, to[1] * 0.992]), offset: 0.75, easing: SETTLE }, { scale: fmt(to) }],
            { duration: 640, easing: "linear" });
      }
      else if (how === "pop") run(el, [{ scale: fmt(from), easing: OUT }, { scale: fmt([to[0] * 1.022, to[1] * 1.04]), offset: 0.38, easing: SETTLE },
                                       { scale: fmt([to[0] * 0.996, to[1] * 0.992]), offset: 0.7, easing: SETTLE }, { scale: fmt(to) }],
                                  { duration: 520, easing: "linear" });
      else run(el, [{ scale: fmt(from) }, { scale: fmt(to) }], { duration: how === "cancel" ? 220 : 340, easing: "cubic-bezier(.34, 1.3, .64, 1)" });
    };

    /* the mouse: lift on the way in, settle on the way out (one hovered button at a time) */
    let hovered = null;
    const leave = () => { if (!hovered) return; const el = hovered; hovered = null; stateOf(el).hover = false; move(el, "hover"); };
    if (fine) {
      document.addEventListener("pointerover", (e) => {
        if (e.pointerType === "touch") return;
        const el = e.target.closest && e.target.closest(PRESSABLE);
        if (el === hovered) return;
        leave();
        if (!el || inert(el)) return;
        hovered = el; stateOf(el).hover = true; move(el, "hover");
      }, { passive: true });
      document.addEventListener("pointerout", (e) => {
        if (e.pointerType === "touch" || !hovered) return;
        if (e.relatedTarget && hovered.contains(e.relatedTarget)) return;
        leave();
      }, { passive: true });
    }

    /* the press: a mouse or a finger sinks the glass at once */
    let held = null;
    const release = (how) => {
      const el = held;
      if (!el) return;
      held = null;
      const st = stateOf(el);
      st.pressed = false;
      el.classList.remove("lg-press");
      move(el, how);
    };
    document.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const el = e.target.closest && e.target.closest(PRESSABLE);
      if (!el || inert(el)) return;
      if (held && held !== el) release("cancel");
      held = el;
      stateOf(el).pressed = true;
      stateOf(el).since = performance.now();
      el.classList.add("lg-press");
      if (navigator.vibrate) { try { navigator.vibrate(6); } catch (_) {} }
      move(el, "press");
    }, { passive: true });
    document.addEventListener("pointerup", () => release("pop"), { passive: true });
    document.addEventListener("pointercancel", () => release("cancel"), { passive: true });
    window.addEventListener("blur", () => { release("cancel"); leave(); });
  }

  /* 4f · ONE LIQUID THUMB for the four segmented controls (language, fullscreen, gender, timer). Their own code keeps
     moving the thumb - drag, rubber band, snap, keyboard - exactly as before. This only reads where the thumb IS each
     frame while it moves: touched, the track gets .lg-touch (the lens swells past it, CSS); travelling - under a finger
     or springing to its slot after a tap - the lens stretches along its motion and narrows across it (volume kept),
     like the WWDC liquid glass, and settles round when it stops. --lg-sx / --lg-sy on the thumb; style.css draws them
     on its ::before, so the thumb's own transform is never touched. */
  function initLiquidThumbs() {
    const SEGMENTED = [
      [".lang-switch", ".lang-switch__thumb"],
      [".fs-switch", ".fs-switch__thumb"],
      [".liquid-glass-track", ".liquid-glass-pill"],
      [".cam-timer__track", ".cam-timer__pill"],
    ];
    const watching = new Map();   // thumb -> { lastX, lastT, v, until, raf }
    const follow = (thumb, ms) => {
      if (reduce || !thumb) return;
      let w = watching.get(thumb);
      const now = performance.now();
      if (w) { w.until = Math.max(w.until, now + ms); return; }
      w = { lastX: thumb.getBoundingClientRect().left, lastT: now, v: 0, until: now + ms };
      watching.set(thumb, w);
      const tick = (t) => {
        const x = thumb.getBoundingClientRect().left;
        const dt = Math.max(1, t - w.lastT);
        const inst = (x - w.lastX) / dt;            // px per ms
        w.v = w.v * 0.55 + inst * 0.45;             // smoothed
        w.lastX = x; w.lastT = t;
        const speed = Math.min(1, Math.abs(w.v) / 1.6);
        const sx = 1 + speed * 0.42, sy = 1 / Math.sqrt(sx);
        /* Written only while it actually moves: a thumb at rest is never touched, so its style attribute (which the
           observer below watches) does not change for nothing. */
        if (w.set || sx > 1.004) {
          thumb.style.setProperty("--lg-sx", sx.toFixed(3));
          thumb.style.setProperty("--lg-sy", sy.toFixed(3));
          w.set = true;
        }
        if (t < w.until || speed > 0.02) { requestAnimationFrame(tick); return; }
        if (w.set) { thumb.style.removeProperty("--lg-sx"); thumb.style.removeProperty("--lg-sy"); }
        watching.delete(thumb);
      };
      requestAnimationFrame(tick);
    };
    document.addEventListener("pointerdown", (e) => {
      for (const [trackSel, thumbSel] of SEGMENTED) {
        const track = e.target.closest && e.target.closest(trackSel);
        if (!track) continue;
        const thumb = track.querySelector(thumbSel);
        track.classList.add("lg-touch");
        follow(thumb, 900);
        const end = () => {
          track.classList.remove("lg-touch");
          follow(thumb, 700);   // the snap to the slot plays after the finger lifts
          document.removeEventListener("pointerup", end, true);
          document.removeEventListener("pointercancel", end, true);
        };
        document.addEventListener("pointerup", end, true);
        document.addEventListener("pointercancel", end, true);
        return;
      }
    }, { passive: true });
    /* a thumb moved by code or keyboard (a language from the page, an arrow key) stretches too */
    for (const [trackSel, thumbSel] of SEGMENTED) {
      document.querySelectorAll(trackSel).forEach((track) => {
        const thumb = track.querySelector(thumbSel);
        if (!thumb || typeof MutationObserver === "undefined") return;
        /* Only a change that is not ours starts a watch: while one runs, this watcher's own --lg-sx writes are ignored,
           and at rest it writes nothing (above) - so it can never keep itself alive. */
        new MutationObserver(() => { if (!watching.has(thumb)) follow(thumb, 650); })
          .observe(track, { attributes: true, subtree: true, attributeFilter: ["class", "style", "data-active", "aria-checked"] });
      });
    }
  }

  /* 4d · TOUCH :active - iOS Safari only applies :active (the button overlay's
     scale(.97) press, style.css §4) when a touchstart listener exists somewhere up the
     tree. An empty passive one is the documented switch: it costs nothing and never
     blocks scrolling. */
  function enableTouchActive() {
    document.addEventListener("touchstart", () => {}, { passive: true });
  }
})();
