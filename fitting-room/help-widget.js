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
}

function init() {
  if (document.getElementById("pearHelpWidget")) return; // idempotent - defensive against double-inclusion
  build();
  sync();

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
