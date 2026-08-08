/* ============================================================================
   PEAR - Floating Help Widget
   ----------------------------------------------------------------------------
   A fixed, bottom-corner "?" button with a popover of step-by-step guidance for
   whichever step is currently on screen: the email/identity gate, the profile
   & body-measurements form, or the live try-on room. Additive only - it reads
   the SAME DOM state app.js itself uses to switch screens (.screen.active, and
   #sizeForm's [hidden]) and never writes back to app state or imports app.js.

   Language: the only external signal this reads is document.documentElement.
   lang/dir, which i18n.js keeps in sync on every language change (geo-IP boot
   + the EN/עב toggle) - so this file never imports i18n.js and still tracks it
   live via a MutationObserver.

   Position: `inset-inline-start` puts the button at the reading-start edge -
   the LEFT in LTR (English), the RIGHT in RTL (Hebrew) - which is this file's
   own request (bottom-left EN / bottom-right HE) expressed as ONE logical
   offset instead of a [dir="rtl"] override, matching the inset-inline-*
   convention already used elsewhere in style.css. It also keeps the button
   clear of the lang toggle (top-left) and the profile button (top-right) in
   either language.
   ============================================================================ */
"use strict";

/* ── copy ─────────────────────────────────────────────────────────────────
   Hebrew and English side by side per string, same shape as i18n.js's I18N
   table. Kept local to this file rather than merged into i18n.js: nothing
   here is static markup i18n.js's data-i18n walk would ever touch, and this
   widget must keep working even if i18n.js's dictionary changes shape. */
const COPY = {
  helpAria:  { he: "עזרה",  en: "Help" },
  closeAria: { he: "סגור",  en: "Close" },
  steps: {
    email: {
      title: { he: "כניסה עם אימייל", en: "Signing in with email" },
      items: [
        { he: "הזן/י שם מלא וכתובת אימייל כדי להתחיל מדידה חדשה או לשחזר מדידה קודמת.",
          en: "Enter your full name and email to start a new fitting or restore a previous one." },
        { he: "בפעם הראשונה נשלח קוד בן 6 ספרות לאימייל שלך - הזן/י אותו לאימות הזהות.",
          en: "First time here? We'll text a 6-digit code to your email - enter it to verify it's you." },
        { he: "בפעם הבאה, מאותו מכשיר, תדולג/י ישירות למדידה בלי להזין שוב פרטים.",
          en: "On your next visit, from the same device, you'll skip straight to your measurements." },
      ],
    },
    profile: {
      title: { he: "גובה, משקל והמידות שלך", en: "Height, weight & your measurements" },
      items: [
        { he: "גובה ומשקל הם שדות חובה - מהם מחושבת המידה המומלצת עבורך.",
          en: "Height and weight are required - they're what the recommended size is calculated from." },
        { he: "אפשר לדייק עוד יותר עם היקף חזה, מותניים ואורך רגליים בתיבת \"כוונון עדין\" (אופציונלי).",
          en: "For an even more precise fit, add chest, waist and leg length under \"Fine-tune\" (optional)." },
        { he: "המידה המומלצת מופיעה אוטומטית - לחצ/י על הכפתור כדי להמשיך לחדר המדידה הוירטואלי.",
          en: "Your recommended size appears automatically - press the button to continue to the virtual fitting room." },
      ],
    },
    liveTryOn: {
      title: { he: "מדידה חיה", en: "Live try-on" },
      items: [
        { he: "התמקמ/י במרכז הפריים במרחק שמאפשר לראות את כל הגוף, ובתאורה טובה.",
          en: "Center yourself in frame at a distance where your full body is visible, in good lighting." },
        { he: "עמד/י ללא תנועה לרגע כדי שהבגד יתאים את עצמו אלייך.",
          en: "Hold still for a moment so the garment can lock onto you." },
        { he: "כדי לראות את הגב, הסתובב/י לאט ובתנועה חלקה - תנועות פתאומיות עלולות לבלבל את המדידה.",
          en: "To see the back, turn slowly and smoothly - quick movements can confuse the fitting." },
        { he: "השתמש/י ברצועת הצבעים/הזוויות כדי להחליף בגד או לעבור בין זוויות צילום.",
          en: "Use the color swatches and angle rail to switch garments or camera angles." },
      ],
    },
  },
};

/* ── DOM refs, filled in by build() ──────────────────────────────────────── */
let rootEl, btnEl, popoverEl, titleEl, listEl;

function currentLang() {
  return document.documentElement.lang === "he" ? "he" : "en";
}

/* Mirrors the exact screen/step signals app.js itself flips: .screen.active
   for the three top-level screens, #sizeForm.hidden for the identity-vs-
   measurements sub-step inside #screen-calculator (see showSizeForm() /
   hideAllScreen1Forms() in app.js). Returns null on the "already used" locked
   screen, where there is nothing left to help with. */
function currentStep() {
  const fitting = document.getElementById("screen-fitting");
  if (fitting && fitting.classList.contains("active")) return "liveTryOn";
  const locked = document.getElementById("screen-locked");
  if (locked && locked.classList.contains("active")) return null;
  const sizeForm = document.getElementById("sizeForm");
  if (sizeForm && !sizeForm.hidden) return "profile";
  return "email"; // identityForm and/or #screen-otp - both part of the email/identity flow
}

function build() {
  rootEl = document.createElement("div");
  rootEl.className = "pear-help-widget";
  rootEl.id = "pearHelpWidget";

  btnEl = document.createElement("button");
  btnEl.type = "button";
  btnEl.className = "pear-help-widget__btn";
  btnEl.id = "pearHelpBtn";
  btnEl.setAttribute("aria-haspopup", "dialog");
  btnEl.setAttribute("aria-expanded", "false");
  btnEl.textContent = "?";

  popoverEl = document.createElement("div");
  popoverEl.className = "pear-help-widget__popover";
  popoverEl.id = "pearHelpPopover";
  popoverEl.setAttribute("role", "dialog");
  popoverEl.setAttribute("aria-labelledby", "pearHelpTitle");
  popoverEl.hidden = true;

  const header = document.createElement("div");
  header.className = "pear-help-widget__header";

  titleEl = document.createElement("h3");
  titleEl.className = "pear-help-widget__title";
  titleEl.id = "pearHelpTitle";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pear-help-widget__close";
  closeBtn.id = "pearHelpClose";
  closeBtn.innerHTML = "&times;";

  header.append(titleEl, closeBtn);

  listEl = document.createElement("ol");
  listEl.className = "pear-help-widget__steps";

  popoverEl.append(header, listEl);
  rootEl.append(btnEl, popoverEl);
  document.body.appendChild(rootEl);

  btnEl.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  document.addEventListener("click", (e) => {
    if (popoverEl.hidden) return;
    if (popoverEl.contains(e.target) || btnEl.contains(e.target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popoverEl.hidden) close();
  });
}

function renderText() {
  const lang = currentLang();
  btnEl.setAttribute("aria-label", COPY.helpAria[lang]);
  closeButtonLabel(lang);
  const step = currentStep();
  const content = step && COPY.steps[step];
  if (!content) return;
  titleEl.textContent = content.title[lang];
  listEl.innerHTML = "";
  content.items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item[lang];
    listEl.appendChild(li);
  });
}

function closeButtonLabel(lang) {
  const closeBtn = document.getElementById("pearHelpClose");
  if (closeBtn) closeBtn.setAttribute("aria-label", COPY.closeAria[lang]);
}

function open() {
  const step = currentStep();
  if (!step) return; // nothing to show on the locked screen
  renderText();
  popoverEl.hidden = false;
  btnEl.setAttribute("aria-expanded", "true");
}
function close() {
  popoverEl.hidden = true;
  btnEl.setAttribute("aria-expanded", "false");
  queueGuard();   // the guard stands down while open - re-evaluate now it isn't
}
function toggle() { popoverEl.hidden ? open() : close(); }

/* Shows/hides the button itself (locked screen = nothing to help with) and
   keeps an already-open popover's copy in sync with the step/language it is
   CURRENTLY reporting - a visitor mid-way through submitting the identity
   form and opening the popover shouldn't see stale copy if the step changes
   under them a moment later. */
function sync() {
  const step = currentStep();
  rootEl.hidden = !step;
  if (!step) { close(); return; }
  if (!popoverEl.hidden) renderText();
  queueGuard();   // a step change relays the page - what sits under us changed
}

/* ── Obstruction guard ────────────────────────────────────────────────────
   This button is position:fixed in a bottom corner while the page scrolls
   underneath it, and the app's primary controls (capture / add-to-cart /
   every .btn-primary) are full-bleed rows on a phone - so there are always
   scroll positions where a control passes directly beneath the button. At
   z-index:150 the button wins that stack and swallows the tap: measured at
   360-480px, #addToCartBtn lost a 36×14px bite of itself to this button, and
   #captureBtn lost 33×3px at 414-540px. A help affordance must never cost the
   user a tap on the primary action.
   No CSS can express "these two never coincide" for a fixed layer over a
   scrolling one, so the button yields instead: while it would cover a
   protected control it fades out and drops out of the hit path entirely,
   returning the moment the control has scrolled clear.
   PROTECTED is the whole contract - add a selector here and the new control is
   covered too; nothing else in this file needs to know about it. */
const PROTECTED = [
  "#captureBtn", "#addToCartBtn", "#startCamBtn", "#btn-next-screen",
  ".btn-primary", ".btn-capture", ".btn-watch", ".btn-download",
  ".pear-compare-bar", ".cam-controls button", ".result-actions button",
].join(", ");

const CLEARANCE = 8;   // px of breathing room around the button, not just touching

function guardObstruction() {
  if (!rootEl || rootEl.hidden) return;
  // An open popover is a deliberate act - never yank it out from under the user.
  if (!popoverEl.hidden) { rootEl.classList.remove("is-yielding"); return; }

  const b = btnEl.getBoundingClientRect();
  const zone = { left: b.left - CLEARANCE, right: b.right + CLEARANCE,
                 top: b.top - CLEARANCE, bottom: b.bottom + CLEARANCE };

  let blocked = false;
  for (const el of document.querySelectorAll(PROTECTED)) {
    /* Deliberately NOT skipping [disabled]: #captureBtn ships disabled until
       the camera opens, and while a disabled control cannot lose a tap, it is
       still the visual anchor of the screen - parking a "?" bubble on the
       corner of the big capture button looks broken whether or not it is
       armed yet. Visual obstruction counts, not just the tap-stealing kind. */
    if (el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;                       // display:none / collapsed
    if (r.bottom < zone.top || r.top > zone.bottom) continue;  // cheap reject before the x test
    if (r.right < zone.left || r.left > zone.right) continue;
    blocked = true;
    break;
  }
  rootEl.classList.toggle("is-yielding", blocked);
}

/* rAF-coalesced: scroll fires far more often than the layout can change. */
let guardQueued = false;
function queueGuard() {
  if (guardQueued) return;
  guardQueued = true;
  requestAnimationFrame(() => { guardQueued = false; guardObstruction(); });
}

function init() {
  if (document.getElementById("pearHelpWidget")) return; // idempotent - defensive against double-inclusion
  build();
  sync();

  addEventListener("scroll", queueGuard, { passive: true });
  addEventListener("resize", queueGuard, { passive: true });
  /* Scroll and resize are not the only ways a control can end up under this
     button: the header's padding animates as you scroll past the top-corner
     controls, sections un-hide as a try-on completes, and images settle late -
     each re-flows the page with no scroll event to react to. Capturing
     transitionend/animationend on the document covers those cheaply (the
     handler is rAF-coalesced and reads a handful of rects), so the guard
     re-evaluates once the layout has actually come to rest. */
  for (const ev of ["transitionend", "animationend", "load"])
    addEventListener(ev, queueGuard, { passive: true, capture: true });
  queueGuard();

  const observer = new MutationObserver(sync);
  ["screen-calculator", "screen-fitting", "screen-locked"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  });
  const sizeForm = document.getElementById("sizeForm");
  if (sizeForm) observer.observe(sizeForm, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "dir"] });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
