/* ============================================================================
   hero-pass.js - State-driven animation engine for the interactive Pear trio
   ----------------------------------------------------------------------------
   PURE ENHANCEMENT, same contract as mobile-ux.js / lux-interactions.js: reads
   #userName / #userEmail (focus/blur/input/keydown) and #btn-identity-continue
   (click/hover), and writes transforms + state classes onto the mascot. Never
   touches app.js state, the identity/OTP flow, or any existing id/class/state
   hook - deleting this file costs nothing but the animation.

   ── STRICTLY STATE-DRIVEN, NOT PROCEDURAL ───────────────────────────────
   An earlier revision drifted the trio toward the cursor and scheduled
   random ambient gestures on a timer. That's gone: every pose below is a
   direct, named reaction to a real user action (focus / typing / a field
   validating / hovering-or-clicking Continue / a validation error). The
   spring/lerp math is still here - it's what makes STATE CHANGES read as
   fluid instead of snapping - it just never invents motion between events.

   ── layer/property ownership (mirrored in the style.css header) ─────────
     .pear__drift  translate + rotate   (spring toward the current pose target)
     .pear__squish scale                (derived every frame from drift's OWN
                                          vertical velocity - squash/stretch
                                          is a readout of real motion, not a
                                          separate scripted effect)
     .pear__tilt   rotate               (synchronized huddle-lean / droop sway -
                                          one shared value applied to all three,
                                          so it reads as one team moving together)
     .pear__arm/.pear__leg rotate       (pose target, spring-lagged behind the body)
     .pear__pupils translate            (gaze target: the focused field, the
                                          centre of the group, or resting-forward)
   ============================================================================ */
(function () {
  "use strict";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /* Semi-implicit Euler spring, integrated against real dt - frame-rate
     independent, and unlike a plain lerp it carries momentum, so a target
     change overshoots and settles instead of snapping straight there. */
  function spring(cur, vel, target, stiff, damp, dt) {
    var a = (target - cur) * stiff - vel * damp;
    var v = vel + a * dt;
    return [cur + v * dt, v];
  }

  /* ── per-character identity ────────────────────────────────────────────
     sideToMain: which of ITS OWN arms is the one that reaches toward the
     main pear during anticipation/error (+1 = its right arm, -1 = its left,
     0 = both, since main is flanked on both sides).
     pull: how far (local px) this character travels toward the group
     centre in anticipate/error - solved per-character from the actual
     rest-position gap so "until they touch shoulders" is geometrically
     true, not guessed. */
  /* Independent, spaced-out at rest (this is the whole point per the
     brief - they only draw together for a real reason), so rest arms are
     simple and SYMMETRIC: a small relaxed-hang angle on both sides, no
     T-pose stiffness. pull is solved so peak anticipation (intensity 1)
     closes the actual rest gap until shoulders meet; hugPull is the EXTRA
     squeeze added on top during the submit burst for a real embrace
     overlap, not a second full crossing. */
  var PROFILES = {
    main:  { stiff: 42, damp: 9.2, limbStiff: 30, limbDamp: 7.0, sideToMain: 0,  pull: 0,  hugPull: 0,  restArmL: -11, restArmR: 11, swayFreq: 0.31, swayAmp: 4.5 },
    small: { stiff: 60, damp: 7.8, limbStiff: 44, limbDamp: 6.4, sideToMain: 1,  pull: 48, hugPull: 22, restArmL: -11, restArmR: 11, swayFreq: 0.44, swayAmp: 5.2 },
    tall:  { stiff: 34, damp: 10.2, limbStiff: 26, limbDamp: 7.8, sideToMain: -1, pull: 54, hugPull: 24, restArmL: -11, restArmR: 11, swayFreq: 0.24, swayAmp: 4.0 },
  };

  function Pear(root, key) {
    var p = PROFILES[key];
    this.key = key; this.p = p;
    this.drift  = root.querySelector(".pear__drift");
    this.squish = root.querySelector(".pear__squish");
    this.tilt   = root.querySelector(".pear__tilt");
    this.armL   = root.querySelector(".pear__arm--l");
    this.armR   = root.querySelector(".pear__arm--r");
    this.legL   = root.querySelector(".pear__leg--l");
    this.legR   = root.querySelector(".pear__leg--r");
    this.pupils = root.querySelector(".pear__pupils");
    this.lids   = root.querySelectorAll(".pear__lid");
    this.shadow = root.querySelector(".pear__shadow");
    this.crown  = root.querySelector(".pear__crown");

    this.x = 0; this.vx = 0; this.y = 0; this.vy = 0; this.rot = 0; this.rotV = 0;
    this.sx = 1; this.sxV = 0; this.sy = 1; this.syV = 0;
    this.aL = p.restArmL; this.aLv = 0; this.aR = p.restArmR; this.aRv = 0;
    this.lL = 0; this.lLv = 0; this.lR = 0; this.lRv = 0;
    this.crownRot = 0; this.crownV = 0;
    this.gx = 0; this.gy = 0;
    this.blinkAt = 1.5 + Math.random() * 3.5; this.blinkT = -1;
    this.swayPhase = Math.random() * Math.PI * 2;   // randomised once, then fixed - desyncs the trio without being "random every frame"
  }

  Pear.prototype.setLids = function (v) {
    for (var i = 0; i < this.lids.length; i++) this.lids[i].style.scale = "1 " + v;
  };

  /* pose targets for the current mode - a pure function of shared state, no
     per-character randomness or hidden timers beyond the spring itself */
  Pear.prototype.poseFor = function (ctx) {
    var p = this.p, t = { x: 0, y: 0, rot: 0, armL: p.restArmL, armR: p.restArmR, legL: null, legR: null, gx: 0, gy: 0 };

    if (ctx.mode === "error") {
      t.x = p.pull * p.sideToMain * 0.42;   // a smaller, comforting huddle-in (signed toward main)
      t.y = 16;                          // droop
      // rot stays 0 here - the synchronized sway is applied separately via
      // .pear__tilt (one shared value fed identically to all three), kept
      // deliberately apart from this per-character drift rotation
      var inSad = p.sideToMain;
      t.armL = inSad >= 0 ? -50 : p.restArmL;
      t.armR = inSad <= 0 ? 50 : p.restArmR;
      if (inSad === 0) { t.armL = -50; t.armR = 50; }   // main: both hands up, framing its face
      t.gx = 0; t.gy = 6;                // looking down, dejected
    } else if (ctx.mode === "anticipate") {
      /* ONE tense/anticipation pose, graduated by intensity rather than a
         separate softer "focus" mode - the brief is explicit that the WHOLE
         typing process should read as held-breath anticipation, just less
         acute than the peak (hovering Continue, or the form fully valid).
         intensity: .4 merely focused -> .68 actively typing -> 1 at the peak */
      var intensity = ctx.peak ? 1 : ctx.typing ? 0.68 : 0.4;
      t.x = p.pull * p.sideToMain * intensity;
      t.y = -9 - intensity * 6;                  // -11 lightly focused .. -15 at peak
      t.rot = -2.5 * intensity + p.sideToMain * -6 * intensity;
      var reachIn = p.sideToMain;
      var armPull = 30 + intensity * 28;          // 30..58deg of inward reach
      t.armL = reachIn >= 0 ? -armPull : p.restArmL;
      t.armR = reachIn <= 0 ? armPull : p.restArmR;
      if (reachIn === 0) { t.armL = -armPull; t.armR = armPull; }   // main: hands up, ready to meet both
      // gaze blends from "watching the field being typed in" toward
      // "glancing at the group" as intensity climbs toward the peak
      t.gx = ctx.gazeX * (1 - intensity) + p.sideToMain * -3.4 * intensity;
      t.gy = (ctx.gazeY - 2) * (1 - intensity) + -2 * intensity;
      // peeking: once the group has walked to the edge (progress > .8),
      // lean further forward over it rather than just standing there
      if (ctx.peeking) { t.rot -= 5; t.y -= 4; t.gy -= 2; }
    } else if (ctx.mode === "lying") {
      /* mobile-only "resting on elbows, watching the form below" pose - a
         sink + forward tilt, NOT a literal 90deg flip: the face is drawn
         front-on, so rotating the whole body that far would turn the
         eyes/mouth sideways instead of reading as "looking down". Arms bend
         hard inward as if propping up the chin; legs kick back (the sway on
         top is added in update(), same treatment as the idle sway term). */
      t.y = 22;
      t.rot = -12;
      t.armL = -62;
      t.armR = 62;
      t.legL = 26;
      t.legR = -26;
      t.gx = 0; t.gy = 7;
    } else {
      // idle: one calm resting pose - the only motion is the lightweight
      // organic sway added in update() below, never a new target here
      t.gx = 0; t.gy = 0;
    }
    return t;
  };

  Pear.prototype.update = function (dt, now, ctx) {
    var p = this.p;

    /* procedural-but-not-random blink: a fixed per-character interval, not
       a scheduled "ambient gesture" - it's closer to a held breath than a
       loop, and it never moves position/pose, only the lids. */
    this.blinkAt -= dt;
    if (this.blinkT < 0 && this.blinkAt <= 0) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      var BD = 0.14, k = this.blinkT / BD;
      this.setLids(clamp(k < 0.5 ? k * 2 : (1 - k) * 2, 0, 1));
      if (this.blinkT >= BD) { this.blinkT = -1; this.setLids(0); this.blinkAt = 2.5 + Math.random() * 3.5; }
    } else {
      this.setLids(0);
    }

    var target = this.poseFor(ctx);
    // one-shot bursts (nod / complete-hop / celebrate) ADD to whatever the
    // sustained mode target already is, so they read as a reaction on top
    // of the current pose rather than replacing it outright
    var burstY = 0, burstArm = 0, burstX = 0;
    if (ctx.burst) {
      var u = clamp(ctx.burst.t / ctx.burst.dur, 0, 1);
      var pulse = Math.sin(u * Math.PI);       // 0 -> 1 -> 0
      var stag = ctx.burst.stagger[this.key] || 0;
      var up = clamp((ctx.burst.t - stag) / ctx.burst.dur, 0, 1);
      var pulseStag = ctx.burst.t < stag ? 0 : Math.sin(up * Math.PI);
      if (ctx.burst.name === "nod") burstY = pulseStag * 12;
      if (ctx.burst.name === "complete") { burstY = -pulseStag * 26; burstArm = pulseStag * 46; }
      if (ctx.burst.name === "celebrate") {
        // the group hug: pull in FURTHER than the sustained anticipate
        // pull (hugPull, not pull) so the outer two visibly reach main,
        // plus a bigger arm-wrap and a hop on top
        burstY = -pulseStag * 34;
        burstArm = pulseStag * 78;
        burstX = p.sideToMain * p.hugPull * pulseStag;
      }
    }

    // idle organic sway: a small ADDITIVE term, never its own target, so it
    // layers under any state instead of competing with it. Frequencies are
    // per-character and phase is randomised once at construction, so the
    // trio drifts out of sync rather than breathing in lockstep - "loose
    // and airy", not a shared mechanical loop.
    var sway = ctx.mode === "idle" ? Math.sin(now * p.swayFreq * Math.PI * 2 + this.swayPhase) * p.swayAmp : 0;

    var tx = target.x + burstX, ty = target.y + burstY - sway;
    var sx1 = spring(this.x, this.vx, tx, p.stiff, p.damp, dt); this.x = sx1[0]; this.vx = sx1[1];
    var sy1 = spring(this.y, this.vy, ty, p.stiff, p.damp, dt); this.y = sy1[0]; this.vy = sy1[1];
    var sr1 = spring(this.rot, this.rotV, target.rot, p.stiff * 0.8, p.damp, dt); this.rot = sr1[0]; this.rotV = sr1[1];

    /* ── squish: a direct readout of vertical velocity, every frame ─────
       Rising fast -> stretch tall/thin. Settling near zero velocity after
       having moved -> squash wide/short. This is what makes jumps, the
       lean-in, and the droop all feel soft instead of rigid, and it costs
       nothing extra to trigger - it just IS the motion. */
    var stretch = clamp(-this.vy * 0.0032, -0.16, 0.22);
    var squashFromArm = clamp(Math.abs(burstArm) * 0.003, 0, 0.08);
    var targetSy = 1 + stretch + (target.y < -6 && Math.abs(this.vy) < 40 ? 0.05 : 0);
    var targetSx = 1 - stretch * 0.6 + squashFromArm;
    var ssy = spring(this.sy, this.syV, targetSy, 70, 9, dt); this.sy = ssy[0]; this.syV = ssy[1];
    var ssx = spring(this.sx, this.sxV, targetSx, 70, 9, dt); this.sx = ssx[0]; this.sxV = ssx[1];

    /* limbs: pose target plus the burst's own arm-raise, spring-LAGGED
       behind the body on a softer spring so they visibly trail and
       overshoot rather than snapping to the body's own timing */
    var armLT = target.armL - (ctx.burst && ctx.burst.name !== "nod" ? burstArm : 0);
    var armRT = target.armR + (ctx.burst && ctx.burst.name !== "nod" ? burstArm : 0);
    var s1 = spring(this.aL, this.aLv, armLT, p.limbStiff, p.limbDamp, dt); this.aL = s1[0]; this.aLv = s1[1];
    var s2 = spring(this.aR, this.aRv, armRT, p.limbStiff, p.limbDamp, dt); this.aR = s2[0]; this.aRv = s2[1];

    /* walking step cycle: blended in proportional to how fast the GROUP is
       currently walking (ctx.walkVel, the shared translateX spring's own
       velocity from the frame loop) - silent at rest, an alternating
       step-swing while actually travelling, silent again once settled at
       the edge. Legs stay velocity-reactive the rest of the time too, so
       the two blend rather than one replacing the other. */
    var legTargetL, legTargetR;
    if (target.legL != null) {
      // lying pose: legs hold a kicked-back angle with a gentle shared sway,
      // not the walk/velocity-driven twitch used everywhere else
      var legSway = Math.sin(now * 1.6 + p.sideToMain) * 6;
      legTargetL = target.legL + legSway;
      legTargetR = target.legR - legSway;
    } else {
      var walkSpeed = Math.abs(ctx.walkVel || 0);
      var stepAmp = clamp(walkSpeed * 0.35, 0, 11);
      var stepCycle = Math.sin(now * 10 + p.sideToMain) * stepAmp;   // per-character phase offset so they don't all step in unison
      var legT = clamp(-this.vy * 0.05, -10, 10);
      legTargetL = -legT + stepCycle;
      legTargetR = legT - stepCycle;
    }
    var s3 = spring(this.lL, this.lLv, legTargetL, p.limbStiff, p.limbDamp, dt); this.lL = s3[0]; this.lLv = s3[1];
    var s4 = spring(this.lR, this.lRv, legTargetR, p.limbStiff, p.limbDamp, dt); this.lR = s4[0]; this.lRv = s4[1];

    /* crown/leaf: a soft-inertia spring that TRAILS the body's own rotation
       (looser stiffness/damping than the body itself, so it visibly lags
       and overshoots like a floppy antenna) plus an explicit droop while
       sad - the one deliberate, discrete pose on top of the ambient trail */
    var droop = ctx.mode === "error" ? (p.sideToMain > 0 ? 33 : p.sideToMain < 0 ? -36 : -27) : 0;
    var crownTarget = droop - this.rot * 1.5;
    var scr = spring(this.crownRot, this.crownV, crownTarget, 22, 5, dt); this.crownRot = scr[0]; this.crownV = scr[1];

    /* gaze: a plain exponential lerp toward the pose's gaze target - gaze
       wants smoothing, not spring momentum (eyes overshooting look wrong) */
    var gl = 1 - Math.exp(-10 * dt);
    this.gx += (target.gx - this.gx) * gl;
    this.gy += (target.gy - this.gy) * gl;

    /* ── commit: one write per property per frame ─────────────────────── */
    this.drift.style.translate = this.x.toFixed(2) + "px " + this.y.toFixed(2) + "px";
    this.drift.style.rotate = this.rot.toFixed(2) + "deg";
    this.squish.style.scale = this.sx.toFixed(3) + " " + this.sy.toFixed(3);
    if (this.tilt) this.tilt.style.rotate = ctx.sharedSway.toFixed(2) + "deg";
    if (this.crown) this.crown.style.rotate = this.crownRot.toFixed(2) + "deg";
    if (this.armL) this.armL.style.rotate = this.aL.toFixed(2) + "deg";
    if (this.armR) this.armR.style.rotate = this.aR.toFixed(2) + "deg";
    if (this.legL) this.legL.style.rotate = this.lL.toFixed(2) + "deg";
    if (this.legR) this.legR.style.rotate = this.lR.toFixed(2) + "deg";
    if (this.pupils) this.pupils.style.translate = this.gx.toFixed(2) + "px " + this.gy.toFixed(2) + "px";
    if (this.shadow) {
      // shrinks + fades as the body rises (further from the ground = a
      // smaller, fainter contact shadow), and separately stretches WIDER
      // right at a hop's landing instant (high squish-x) for a connected
      // "thump" cue between the body's squash and the shadow underneath it
      var lift = clamp((-this.y) / 30, 0, 1);
      var landStretch = clamp((this.sx - 1) * 0.6, 0, 0.18);
      this.shadow.style.scale = (1 - lift * 0.32 + landStretch).toFixed(3) + " " + (1 - lift * 0.32 - landStretch * 0.6).toFixed(3);
      this.shadow.style.opacity = (1 - lift * 0.45).toFixed(3);
    }
  };

  function init() {
    var wrap = document.getElementById("pearMascotWrap");
    var nameEl = document.getElementById("userName");
    var emailEl = document.getElementById("userEmail");
    var btn = document.getElementById("btn-identity-continue");
    if (!wrap || !nameEl || !emailEl) return;

    var pears = [];
    ["main", "small", "tall"].forEach(function (k) {
      var el = wrap.querySelector(".pear--" + k);
      if (el) pears.push(new Pear(el, k));
    });
    if (!pears.length) return;

    if (REDUCED) return;   // hold the authored resting pose; no engine, no motion at all

    var focused = null, hoverCTA = false, tier = 0;
    var sadUntil = 0, celebrateUntil = 0;
    var burst = null;   // { name, t, dur, stagger }

    function fireBurst(name, dur, staggerMs) {
      var stagger = { main: 0, small: (staggerMs || 0) / 1000, tall: ((staggerMs || 0) * 2) / 1000 };
      burst = { name: name, t: 0, dur: dur, stagger: stagger };
    }

    function refreshTier() {
      var hasName = nameEl.value.trim().length > 1;
      var okEmail = EMAIL_RE.test(emailEl.value.trim());
      var next = hasName && okEmail ? 2 : hasName ? 1 : 0;
      if (next !== tier) {
        if (next > tier) { sadUntil = 0; fireBurst("complete", 0.6, 70); }
        tier = next;
        wrap.setAttribute("data-progress", String(tier));
      }
    }

    [nameEl, emailEl].forEach(function (el) {
      el.addEventListener("focus", function () {
        focused = el; wrap.classList.add("is-focused");
      });
      el.addEventListener("blur", function () {
        if (focused === el) focused = null;
        wrap.classList.remove("is-focused");
        refreshTier();
        // Deliberately NO error reaction here, even for an invalid email -
        // the trio stays in anticipation for the whole typing process; a
        // validation problem only becomes a "reaction" once the user
        // actually tries to submit (see the Continue click handler below).
        // A field that already has content still earns a small positive
        // beat for finishing it.
        if (el.value.trim()) fireBurst("complete", 0.55, 60);
      });
      var lastNod = 0;
      el.addEventListener("input", function () {
        refreshTier();
        var now = performance.now() / 1000;
        typingUntil = now + 0.6;
        if (now - lastNod > 0.28) { fireBurst("nod", 0.32, 40); lastNod = now; }
      });
    });

    nameEl.addEventListener("keydown", function (e) {
      if (e.key !== " ") return;
      var v = nameEl.value;
      if (v.trim().length && !/\s$/.test(v)) fireBurst("nod", 0.32, 40);
    });

    /* Sparkles on submission - driven directly via Element.animate() (Web
       Animations API), NOT a CSS class + @keyframes trigger. That version
       was tried first: the browser correctly reported the animation as
       recognised and "running" (name/duration/delay all correct), but the
       computed opacity measured 0 for the animation's entire first cycle in
       testing - a real, reproducible issue, not a measurement mistake (it
       was re-checked with size, timing, and forced-static isolation tests).
       WAAPI sidesteps whatever cascade/scheduling quirk that was: it's
       triggered imperatively at the exact moment we want it, and its
       returned Animation object is directly inspectable/awaitable, so
       there's no ambiguity about whether or when it actually started. */
    function fireSparkles() {
      var stars = wrap.querySelectorAll(".pear__sparkle");
      var delays = [0, 80, 160, 50, 220, 120];
      stars.forEach(function (star, i) {
        star.animate(
          [
            { opacity: 0, scale: "0" },
            { opacity: 1, scale: "1.15", offset: 0.35 },
            { opacity: 1, scale: ".85", offset: 0.6 },
            { opacity: 0, scale: "0" },
          ],
          { duration: 900, delay: delays[i] || 0, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" }
        );
      });
    }

    if (btn) {
      btn.addEventListener("mouseenter", function () { hoverCTA = true; });
      btn.addEventListener("mouseleave", function () { hoverCTA = false; });
      btn.addEventListener("click", function () {
        // Error is bound STRICTLY to this click, and only when the form is
        // actually invalid at the moment of submit - never while merely
        // typing. Checked synchronously here (mirroring app.js's own
        // hasName/okEmail rules) so an obvious problem (empty name, no @)
        // reacts instantly; the MutationObserver below is what still
        // catches an ASYNC failure (e.g. the server rejects it a moment
        // later) - and because "error" outranks "celebrate" in the mode
        // priority below, that can correctly interrupt a celebration
        // already in progress, which is exactly the "abruptly collapses
        // from anticipation into disappointment" the brief asks for.
        var validNow = nameEl.value.trim().length > 1 && EMAIL_RE.test(emailEl.value.trim());
        if (validNow) {
          sadUntil = 0;
          celebrateUntil = performance.now() / 1000 + 1.3;
          wrap.classList.add("is-celebrating");
          setTimeout(function () { wrap.classList.remove("is-celebrating"); }, 1150);
          fireBurst("celebrate", 0.7, 60);
          fireSparkles();
        } else {
          celebrateUntil = 0;
          sadUntil = performance.now() / 1000 + 4.2;
        }
      });
    }

    /* Async/complementary error trigger: watches the SAME #identityError
       element app.js already writes to (missing name, malformed email, a
       failed submit request - see errNameRequired/errEmailInvalid/
       errGenericRetry in its I18N dict), so a failure that only surfaces
       after the click handler above already judged the form "valid enough
       to try" (e.g. the server itself rejects it) still gets the
       disappointed reaction, just slightly delayed instead of instant. */
    var identityError = document.getElementById("identityError");
    if (identityError) {
      var checkIdentityError = function () {
        if (!identityError.hidden && identityError.textContent.trim()) {
          sadUntil = performance.now() / 1000 + 4.2;
        }
      };
      new MutationObserver(checkIdentityError).observe(identityError, {
        attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true,
      });
    }

    /* ── walk-to-the-form ────────────────────────────────────────────────
       A SEPARATE outer layer from the per-character huddle drift: this
       moves the whole .pear-trio wrapper, not individual characters, so it
       composes cleanly with everything else (CSS only touches `scale` on
       this element for the celebrate zoom - never `translate` - so there's
       nothing to conflict with).

       AXIS is layout-aware, not just direction-aware: below 920px
       .calc-shell stacks to a single column (see style.css), so the mascot
       panel sits ABOVE the form instead of beside it - walking sideways at
       that point would move AWAY from the form, not toward it. mqStacked
       tracks the SAME 920px breakpoint the CSS uses, via a MediaQueryList
       (cheap to read every frame, and its own change listener keeps it
       correct across a live resize/orientation change rather than only at
       load).
       Horizontal direction is still dir-aware for the wide layout: the
       mascot panel and form panel swap physical sides with the page
       direction (grid mirrors under dir=rtl), so "toward the form" is the
       LEFT edge in Hebrew/RTL but the RIGHT edge in English/LTR. Read fresh
       every frame (cheap) rather than cached once, in case the language
       toggle flips mid-session. */
    var WALK_DISTANCE = 84;     // px, wide/side-by-side layout
    var WALK_DISTANCE_Y = 34;   // px, stacked mobile layout - the banner itself is short
    var mqStacked = window.matchMedia("(max-width: 920px)");
    // dedicated, narrower breakpoint for the "resting on elbows, watching
    // the form" pose - true phones only; 768-920px (stacked but not yet
    // phone-narrow) keeps the older walk-toward-the-form motion.
    var mqLying = window.matchMedia("(max-width: 768px)");
    var walkX = 0, walkV = 0;
    // a live resize that crosses the breakpoint mid-interaction would
    // otherwise carry the OTHER axis's spring value over and reinterpret it
    // on the new axis (a visible jump) - reset cleanly instead
    mqStacked.addEventListener("change", function () { walkX = 0; walkV = 0; });

    var typingUntil = 0;
    var ctx = {
      mode: "idle", gazeX: 0, gazeY: 0, sharedSway: 0, typing: false, peak: false,
      walkVel: 0, peeking: false, burst: null,
    };
    var last = performance.now() / 1000;

    function frame(now) {
      var t = now / 1000;
      var dt = Math.min(t - last, 0.05);
      last = t;

      var errorOn = t < sadUntil;
      var celebrateOn = t < celebrateUntil;
      if (errorOn !== wrap.classList.contains("is-sad")) wrap.classList.toggle("is-sad", errorOn);
      // anticipation now covers the WHOLE typing process, not just tier 2 /
      // hover - poseFor grades how tense the pose is via ctx.typing/ctx.peak
      // rather than switching to a separate, softer "focus" mode
      var anticipateOn = !errorOn && (tier === 2 || hoverCTA || !!focused);
      ctx.typing = t < typingUntil;
      ctx.peak = tier === 2 || hoverCTA;
      if (anticipateOn !== wrap.classList.contains("is-anticipate")) wrap.classList.toggle("is-anticipate", anticipateOn);
      // exposed as a class (not just ctx.typing, which the pose engine
      // already used internally) purely so the mouth-crossfade CSS can key
      // off "actively typing right now" independently of body pose
      if (ctx.typing !== wrap.classList.contains("is-typing")) wrap.classList.toggle("is-typing", ctx.typing);

      // 0 -> .18 the moment typing starts -> .55 once the name validates ->
      // 1 once the whole form does. Error recoils ALL THE WAY back to
      // centre, regardless of tier - "step back" is a full reset, not a
      // partial one.
      var progress = errorOn ? 0 : celebrateOn ? 1 : tier === 2 ? 1 : tier === 1 ? 0.55 : ctx.typing ? 0.18 : 0;

      // phones only, and only once there's actually something to react to -
      // idle (progress 0) still stands normally even on a phone
      var lyingOn = !errorOn && mqLying.matches && progress > 0;
      if (lyingOn !== wrap.classList.contains("is-lying")) wrap.classList.toggle("is-lying", lyingOn);

      ctx.mode = errorOn ? "error" : lyingOn ? "lying" : (celebrateOn || anticipateOn) ? "anticipate" : "idle";
      ctx.sharedSway = errorOn ? Math.sin(t * 2.1) * 3.2 : 0;   // ONE value, fed to all three - synchronized

      var stacked = mqStacked.matches;
      // lying sinks/tilts each character in place - the outer wrapper must
      // NOT also walk them down into the form beneath it. Otherwise: stacked
      // always walks DOWN (positive Y) toward the form below - there's no
      // left/right ambiguity once the layout is a single column; side-by-side
      // is horizontal, signed by page direction as before.
      var walkTarget = lyingOn ? 0
                      : stacked ? WALK_DISTANCE_Y * progress
                                : (document.documentElement.dir === "rtl" ? -1 : 1) * WALK_DISTANCE * progress;
      var sw = spring(walkX, walkV, walkTarget, 24, 7.5, dt); walkX = sw[0]; walkV = sw[1];
      wrap.style.translate = stacked ? ("0px " + walkX.toFixed(2) + "px") : (walkX.toFixed(2) + "px 0px");
      ctx.walkVel = walkV;
      ctx.peeking = !errorOn && progress > 0.8;

      if (focused) {
        var r = focused.getBoundingClientRect();
        var stageRect = wrap.getBoundingClientRect();
        ctx.gazeX = clamp((r.left + r.width / 2 - (stageRect.left + stageRect.width / 2)) / 40, -4, 4);
        ctx.gazeY = clamp((r.top + r.height / 2 - (stageRect.top + stageRect.height / 2)) / 60, -3, 3);
      }

      if (burst) {
        burst.t += dt;
        var maxStag = Math.max(burst.stagger.main, burst.stagger.small, burst.stagger.tall);
        if (burst.t > burst.dur + maxStag) burst = null;
      }
      ctx.burst = burst;

      for (var i = 0; i < pears.length; i++) pears[i].update(dt, t, ctx);
      requestAnimationFrame(frame);
    }

    refreshTier();
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
