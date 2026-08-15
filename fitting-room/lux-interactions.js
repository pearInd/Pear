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
    if (fine && !reduce) initMagnetic();
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
          springToast("לא זוהה פריט פעיל - בחרו בגד ונסו שוב · No active item - pick a garment and try again");
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
          ? `הפריט במידה ${garment.size} נוסף לעגלה · Size ${garment.size} added to cart`
          : "נוסף לסל · Added to cart");
      } else {
        // Standalone (PEAR demo site, no host store to sync with) - this
        // local counter IS the source of truth here, so it still owns the badge.
        count += 1;
        localStorage.setItem("pear_cart_count", String(count));
        renderBadge();
        springToast("הפריט נוסף לסל! (דמו)");
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
        springToast("נשמר - ההוספה האוטומטית לסל החנות נכשלה, נא להוסיף ידנית · Saved - couldn't add to the store cart automatically, please add it manually");
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
  function springToast(msg) {
    if (!cartToastEl) {
      cartToastEl = document.createElement("div");
      cartToastEl.className = "lux-cart-toast";
      cartToastEl.setAttribute("role", "status");
      cartToastEl.innerHTML =
        '<span class="lux-cart-toast__icon" aria-hidden="true">✓</span><span class="lux-cart-toast__msg"></span>';
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
})();
