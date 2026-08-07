/* ============================================================================
   PEAR - i18n: geo-IP language detection + manual toggle
   ----------------------------------------------------------------------------
   Boot sequence (see initLanguage() near the bottom of this file, invoked at
   module top-level so it fires as early as possible - it is NOT gated behind
   app.js's init()/DOMContentLoaded):
     1. Apply the best guess we already have (a GENUINE prior toggle click,
        else the server's SSR guess in window.__PEAR_DEFAULT_LANG__, else
        "en") immediately, so there's no flash of the wrong language while
        geo-IP resolves.
     2. Unless the visitor already made an explicit choice via the toggle,
        kick off client-side geo-IP lookup (shared timeout budget, multiple
        providers) and silently correct the DOM in place once it resolves.
        Any country other than "IL", or a total lookup failure/timeout,
        ALWAYS resolves to English - this never touches navigator.language
        (OS/browser locale is not a reliable proxy for the visitor's
        storefront market).
     3. A manual toggle click always wins from that point on: it's persisted
        with an explicit flag so no later geo-IP check on a future page load
        can override it.

   BUG HISTORY - read before touching the explicit flag again: an earlier
   version of the legacy-key migration below unconditionally treated ANY
   pre-existing localStorage value as if it came from a real click, setting
   the explicit flag on the visitor's behalf. That silently locked whatever
   language happened to already be in storage (e.g. "he" from a stale/older
   visit) FOREVER - geo-IP never ran again, on any device/network, including
   a US VPN - because initLanguage() returns immediately once explicit+stored
   are both truthy. A server restart naturally can't fix this: the broken
   state lives in the visitor's own browser, not on the server.

   Fixing the migration going forward (a plain, non-explicit app_lang seed)
   stops NEW corruption, but does nothing for browsers that already have the
   bad explicit=true sitting in storage from before that fix shipped - those
   still need a one-time, fully automatic purge (see sanitizeLanguageStorage
   below) so nobody has to open DevTools or click a toggle to get unstuck. */
"use strict";

const LANG_KEY = "app_lang";
const LANG_EXPLICIT_KEY = "app_lang_explicit";
const SANITIZED_KEY = "i18n_v2_sanitized";

/* One-time, fully automatic storage reset - runs at most once per browser
   (gated by SANITIZED_KEY), the instant this module boots, no reload/dialog/
   console command required. Wipes any language state that could be sitting
   around from before the explicit-flag bug fix (or any earlier scheme:
   app_lang, app_lang_explicit, the old pear_lang key) so initLanguage() below
   always starts from a clean slate and lets geo-IP make a fresh call. Safe to
   run unconditionally on a version-flag basis: if this browser was never
   corrupted, clearing already-empty keys is a no-op. */
(function sanitizeLanguageStorage() {
  try {
    if (localStorage.getItem(SANITIZED_KEY)) return; // already done - never repeat
    localStorage.removeItem(LANG_EXPLICIT_KEY);
    localStorage.removeItem(LANG_KEY);
    localStorage.removeItem("pear_lang");
    localStorage.setItem(SANITIZED_KEY, "true");
    console.log("[PEAR i18n] Storage sanitized and fresh geo-IP evaluation initiated.");
  } catch {}
})();

/* Only the static markup tagged with data-i18n / data-i18n-placeholder /
   data-i18n-aria in index.html is translated here - anything app.js writes
   itself at runtime (result labels, profile fields, OTP hints, catalog/gallery
   cards, etc.) stays exactly as it already was; those call sites hardcode
   their own Hebrew and are untouched by this dictionary.

   Hebrew is the source of truth (and the fallback if a key or lang is ever
   missing); English is a natural translation, not word-for-word. Bilingual
   "· English" sub-labels that already exist alongside some of these strings
   in the markup (e.g. "· Size", "· Complete the Look") are separate, static
   DOM nodes outside these data-i18n spans - they are intentionally left as
   embedded HTML and never touched here. */
const I18N = {
  docTitle:                 { he: "PEAR - חדר הלבשה וירטואלי", en: "PEAR - Virtual Fitting Room" },

  calcHeadline:              { he: "המידה שלך,<br>בדיוק מושלם", en: "Your size,<br>perfectly matched" },
  calcLead:                  { he: "חדר הלבשה וירטואלי בזמן אמת - הלוק נמדד על הגוף שלך, מתוך נתונים ולא ניחושים.", en: "A real-time virtual fitting room - your look is measured on your own body, from real data, not guesswork." },
  calcListAlgo:              { he: "התאמת מידה אלגוריתמית מדויקת", en: "Precise, algorithm-based size matching" },
  calcListLive:              { he: "מדידה חיה של הבגד על הגוף", en: "Live fitting of the garment on your body" },
  calcListSave:              { he: "שמירה והורדה של הלוק", en: "Save and download your look" },
  stepLabel:                 { he: "שלב 1 מתוך 2", en: "Step 1 of 2" },
  calcHeading:                { he: "התאמת מידה אישית", en: "Personalized Size Matching" },
  calcSubtitle:               { he: "הזן נתונים – האלגוריתם יחשב את המידה המדויקת עבורך", en: "Enter your details - the algorithm will calculate your exact size" },

  labelFullName:             { he: "שם מלא:", en: "Full name:" },
  placeholderName:           { he: "לדוגמה: דנה כהן", en: "e.g. Jane Cooper" },
  labelEmail:                { he: "אימייל:", en: "Email:" },
  placeholderEmail:          { he: "לדוגמה: dana@example.com", en: "e.g. jane@example.com" },
  btnContinue:               { he: "המשך →", en: "Continue →" },

  otpTitle:                  { he: "אימות אימייל", en: "Verify your email" },
  otpPlaceholder:            { he: "הכנס קוד בן 6 ספרות", en: "Enter the 6-digit code" },
  btnVerifyOtp:              { he: "אמת קוד", en: "Verify code" },
  btnResendOtp:              { he: "שלח קוד חדש", en: "Send new code" },

  measurementsRefreshNotice: { he: "עדכן את המידות שלך - עבר חודש מהפעם האחרונה", en: "Update your measurements - it's been a month since last time" },
  labelHeight:               { he: 'גובה (בס"מ):', en: "Height (cm):" },
  placeholderHeight:         { he: "לדוגמה: 175", en: "e.g. 175" },
  labelWeight:               { he: 'משקל (בק"ג):', en: "Weight (kg):" },
  placeholderWeight:         { he: "לדוגמה: 68", en: "e.g. 68" },
  btnNextScreen:             { he: "המשך לחדר המדידה הוירטואלי →", en: "Continue to the virtual fitting room →" },
  fineTuneLabel:             { he: "כוונון עדין", en: "Fine-tune" },
  labelChest:                { he: 'היקף חזה (בס"מ)', en: "Chest circumference (cm)" },
  optionalTag:               { he: "(אופציונלי)", en: "(optional)" },
  placeholderChest:          { he: "לדוגמה: 94", en: "e.g. 94" },
  labelWaist:                { he: 'היקף מותניים (בס"מ)', en: "Waist circumference (cm)" },
  placeholderWaist:          { he: "לדוגמה: 80", en: "e.g. 80" },
  labelLegs:                 { he: 'אורך רגליים (בס"מ)', en: "Leg length (cm)" },
  placeholderLegs:           { he: "לדוגמה: 102", en: "e.g. 102" },

  profileAria:               { he: "פרופיל משתמש · User profile", en: "User profile" },
  profileLabelHeight:        { he: "גובה:", en: "Height:" },
  profileLabelWeight:        { he: "משקל:", en: "Weight:" },
  profileLabelSize:          { he: "מידה:", en: "Size:" },
  profileLogout:             { he: "התנתקות", en: "Log out" },

  focusBarPrefix:            { he: "מדידת פריט ממוקדת:", en: "Focused fitting:" },
  /* Fullscreen / Expand toggle (was "Back to Store") - two paired states cycled
     by setupFullscreenToggle() in app.js as document.fullscreenElement changes. */
  fullscreenToggleAria:      { he: "מסך מלא · Full screen", en: "Full screen" },
  fullscreenToggleLabel:     { he: "מסך מלא", en: "Full screen" },
  fullscreenExitAria:        { he: "יציאה ממסך מלא · Exit full screen", en: "Exit full screen" },
  fullscreenExitLabel:       { he: "יציאה ממסך מלא", en: "Exit full screen" },
  editMeasurementsAria:      { he: "עריכת מידות · Edit measurements", en: "Edit measurements" },
  editMeasurementsLabel:     { he: "עריכת מידות", en: "Edit measurements" },
  appHeaderSub:              { he: "חדר הלבשה וירטואלי", en: "Virtual Fitting Room" },
  cartBtnAria:               { he: "סל קניות · Shopping cart", en: "Shopping cart" },

  personalTitlePrefix:       { he: "ככה המידה", en: "Here's how size" },
  personalTitleSuffix:       { he: "נראית עליך", en: "looks on you" },
  activeGarmentEyebrow:      { he: "פריט נמדד", en: "Item being fitted" },

  flipCamAria:               { he: "הפוך מצלמה · Flip camera", en: "Flip camera" },
  swatchesAria:              { he: "צבע · Colour", en: "Colour" },
  liveCountdownLabel:        { he: "שניות", en: "seconds" },
  /* Progressive loading-state guidance (#scanStepText) - cycled by
     startScanTimer()/updateScanTimer() in app.js while #scanOverlay is up,
     one step at a time, so the shopper always knows what's happening and how
     to help (frame themselves, hold still, wait for the garment). */
  scanStepFrame:             { he: "קח כמה צעדים אחורה שיראו אותך בבירור", en: "Please step back so your full body is in frame" },
  scanStepCalibrate:         { he: "מכייל פרופורציות גוף ותאורה...", en: "Calibrating body proportions & lighting..." },
  scanStepFitting:           { he: "מלביש את הטקסטורה והבד...", en: "Fitting active garment physics..." },
  camPlaceholderText:        { he: "כדי להתחיל במדידה, נשמח לקבל גישה למצלמה. אל דאגה, הצילום משמש למדידת מידות הגוף בלבד ואינו נשמר בשרתים שלנו.", en: "To start your fitting, we'll need access to your camera. Don't worry - the footage is used only to measure your body and is never stored on our servers." },
  startCamBtn:               { he: "הפעלת מצלמה לתחילת מדידה", en: "Turn on camera to start fitting" },
  captureBtnLabel:           { he: "מתחילים במדידה", en: "Start fitting" },
  addToCartAria:             { he: "הוסף לסל", en: "Add to Cart" },
  addToCartLabel:            { he: "הוסף לסל", en: "Add to Cart" },

  catalogTitle:              { he: "בחר בגד מהקטלוג", en: "Choose a garment from the catalog" },
  clTitle:                   { he: "השלמת הלוק", en: "Complete the Look" },
  clArrowPrevAria:           { he: "גלול שמאלה · Scroll left", en: "Scroll left" },
  clArrowNextAria:           { he: "גלול ימינה · Scroll right", en: "Scroll right" },

  pearGalleryAria:           { he: "גלריית מדידות", en: "Fitting gallery" },
  pipTitle:                  { he: "מדידות קודמות", en: "Previous Fits" },
  pipRetakeLabel:            { he: "מדוד שוב", en: "Measure again" },
  galleryClearLabel:         { he: "נקה", en: "Clear" },
  compareBarLabel:           { he: "השוואה בין המראה הנבחר", en: "Compare selected looks" },

  pearCompareAria:           { he: "השוואת מדידות", en: "Compare fittings" },
  pcmpTitle:                 { he: "השוואת מדידות", en: "Compare Fits" },
  ariaClose:                 { he: "סגור", en: "Close" },

  garmentDetectAria:         { he: "בחירת בגד מהתמונה שהעלית", en: "Choose a garment from the uploaded photo" },
  gdTitle:                   { he: "בחר/י את הבגד", en: "Choose the garment" },
  gdTabsAria:                { he: "בחירת סוג בגד", en: "Choose garment type" },
  gdTabTop:                  { he: "עליון", en: "Top" },
  gdTabBottom:               { he: "תחתון", en: "Bottom" },
  gdLoadingLabel:            { he: "מזהה בגדים…", en: "Detecting garments…" },
  gdEmptyText:               { he: "לא זוהו בגדים בתמונה.", en: "No garments were detected in the photo." },
  gdRetryBtn:                { he: "בחר/י תמונה אחרת", en: "Choose another photo" },
  gdHint:                    { he: "לחצ/י על המסגרת הכחולה סביב הבגד שתרצה/י למדוד", en: "Tap the blue frame around the garment you'd like to measure" },

  lockedHeadline:            { he: "תודה שניסית<br>את PEAR", en: "Thank you for trying<br>PEAR" },
  lockedHeading:             { he: "המדידה כבר בוצעה", en: "Measurement already completed" },
  lockedSubtitle:            { he: "כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!", en: "You've already completed your virtual fitting in this demo. Thank you!" },

  resultLabelDefault:       { he: "המידה המומלצת עבורך:", en: "Your recommended size:" },
  resultLabelError:         { he: "שגיאה בנתונים:", en: "Data error:" },
  sizeResultInvalid:        { he: "נתונים לא הגיוניים", en: "Values out of range" },
  bestSizeOutOfRange:       { he: "מידה מחוץ לטווח", en: "Size out of range" },
  resultLabelApprox:        { he: "קירוב מידה מומלץ:", en: "Closest size match:" },
  errNameRequired:          { he: "נא להזין שם מלא.", en: "Please enter your full name." },
  errEmailInvalid:          { he: "נא להזין כתובת אימייל תקינה.", en: "Please enter a valid email address." },
  errGenericRetry:          { he: "נא לבדוק את הפרטים ולנסות שוב.", en: "Please check your details and try again." },

  /* ── LOCALIZATION PASS ────────────────────────────────────────────────
     Everything below used to be a hardcoded Hebrew literal at its call
     site, so an English visitor still got Hebrew error/status text. These
     are the user-facing strings on the identity → OTP → camera path (the
     flow every visitor actually walks); each call site now goes through
     t() so it follows the active language like the rest of the UI. ── */

  /* OTP / verification */
  otpSecondsRemaining:      { he: "שניות נותרו", en: "seconds remaining" },
  otpExpired:               { he: "הקוד פג תוקף", en: "Code expired" },
  otpSentTo:                { he: "שלחנו קוד ל:", en: "We sent a code to:" },
  otpAlreadyRegistered:     { he: "האימייל הזה כבר רשום - שלחנו קוד לאימות זהות", en: "This email is already registered - we've sent a code to verify it's you" },
  otpEnter6Digits:          { he: "נא להזין קוד בן 6 ספרות.", en: "Please enter the 6-digit code." },
  otpSomethingWrong:        { he: "משהו השתבש - נא לשלוח קוד חדש.", en: "Something went wrong - please request a new code." },
  otpExpiredResend:         { he: "הקוד פג תוקף. שלח שוב", en: "That code expired. Send a new one" },
  otpWrongCode:            { he: "קוד שגוי. נסה שוב", en: "Wrong code. Try again" },
  otpResent:                { he: "קוד חדש נשלח", en: "A new code has been sent" },
  otpResendFailed:          { he: "שליחת הקוד נכשלה - נסה שוב.", en: "Couldn't send the code - please try again." },
  otpSendFailed:            { he: "שליחת קוד האימות נכשלה - נסה שוב.", en: "Couldn't send the verification code - please try again." },

  /* identity / device linking */
  errDeviceLinkFailed:      { he: "שיוך המכשיר נכשל - נסה שוב.", en: "Couldn't link this device - please try again." },
  errNetworkRetry:          { he: "שגיאת רשת - נסה שוב.", en: "Network error - please try again." },

  /* camera + fitting-room entry */
  camStarting:              { he: "מפעיל מצלמה…", en: "Starting camera…" },
  camDenied:                { he: "לא ניתן לגשת למצלמה:", en: "Couldn't access the camera:" },
  camDeniedHint:            { he: " - ודא הרשאת מצלמה ושהאתר מוגש מ-localhost/https.", en: " - check camera permissions and that the site is served over localhost/https." },
  errRoomLoad:              { he: "שגיאה בטעינת חדר המדידה - ", en: "Couldn't load the fitting room - " },
  errRoomLoadRetry:         { he: "נסה לרענן את הדף", en: "try refreshing the page" },

  /* demo gate */
  demoAlreadyUsed:          { he: "כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!", en: "You've already completed your virtual fitting in this demo. Thank you!" },
};

export function getActiveLang() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "he" || stored === "en") return stored;
  } catch {}
  // Pre-geo-IP guess only (server SSR hint, or English) - never navigator.language.
  return window.__PEAR_DEFAULT_LANG__ === "he" ? "he" : "en";
}

/* Looks up a single dictionary entry for the active language - for strings
   app.js sets itself at runtime (form validation, result labels) rather than
   static markup, which the data-i18n/-placeholder/-aria walk above already
   covers. Falls back to Hebrew if the key or language is ever missing. */
export function t(key) {
  const entry = I18N[key];
  if (!entry) return "";
  return entry[getActiveLang()] || entry.he;
}

/* Walks every tagged node and swaps in the active language's copy. Re-run on
   load and on every toggle - cheap (a few dozen small elements) and keeps
   text/placeholder/aria-label in sync without any per-element bookkeeping. */
function applyI18nText(lang) {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const entry = I18N[el.dataset.i18n];
    if (entry) el.innerHTML = entry[lang] || entry.he;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const entry = I18N[el.dataset.i18nPlaceholder];
    if (entry) el.placeholder = entry[lang] || entry.he;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const entry = I18N[el.dataset.i18nAria];
    if (entry) el.setAttribute("aria-label", entry[lang] || entry.he);
  });
  // Static "· English" partner labels that sit beside a data-i18n span as a
  // permanent bilingual design accent (e.g. "· Complete the Look", the
  // "Retake" span) become literal duplicates once their neighbour is itself
  // translated to English - hide them only in that case; Hebrew mode is
  // unchanged.
  document.querySelectorAll("[data-i18n-hide-on-en]").forEach((el) => {
    el.hidden = lang === "en";
  });
}

/* Core DOM applicator - the only place that actually writes the language to
   the page. <html lang/dir> is safe to set immediately (the <html> element
   exists as soon as the parser sees the opening tag); the text/placeholder/
   aria walk needs real body content to query against, so if the document is
   still mid-parse this defers that part to DOMContentLoaded instead of
   silently querying an empty/partial DOM and losing the update. */
export function applyLanguage(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";

  const applyText = () => {
    applyI18nText(lang);
    console.log("Applying language:", lang);
  };

  if (document.body) {
    applyText();
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyText, { once: true });
  } else {
    applyText();
  }
}

/* Persistence wrapper around applyLanguage(). explicit:true marks this as a
   deliberate visitor choice (toggle click) - it is the ONLY thing that can
   ever stop a later geo-IP check from overriding app_lang on the next boot.
   Never set explicit:true from anywhere except an actual click handler. */
export function setLanguage(lang, { explicit = false } = {}) {
  try {
    // Force-clear first, then write fresh - guarantees no stale value (from
    // this key or any earlier scheme) can linger under a partial write.
    localStorage.removeItem(LANG_KEY);
    localStorage.setItem(LANG_KEY, lang);
    if (explicit) localStorage.setItem(LANG_EXPLICIT_KEY, "true");
  } catch {}
  applyLanguage(lang);
}

/* ── Geo-IP country lookup ────────────────────────────────────────────────
   Multiple independent providers race in parallel; whichever answers first
   wins. GEO_BUDGET_MS is a SHARED ceiling across every provider combined
   (not per-provider) so a slow VPN/mobile connection still gets the full
   ~4s window rather than each provider eating its own separate timeout.
   Resolves to a 2-letter ISO country code, or null if every provider fails
   or the whole lookup blows the budget - callers must treat null as "assume
   not Israel" per the fallback policy. */
const GEO_PROVIDERS = [
  { url: "https://ipapi.co/json/", parse: (d) => d && d.country_code },
  { url: "https://ipwho.is/", parse: (d) => d && d.country_code },
  { url: "https://get.geojs.io/v1/ip/country.json", parse: (d) => d && d.country },
];
const GEO_BUDGET_MS = 4000;

async function detectCountryCode() {
  const controller = new AbortController();

  const attempts = GEO_PROVIDERS.map(async (provider) => {
    const res = await fetch(provider.url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`geo-ip provider HTTP ${res.status}: ${provider.url}`);
    const data = await res.json();
    const code = provider.parse(data);
    if (!code || typeof code !== "string" || code.length !== 2) {
      throw new Error(`geo-ip provider returned no usable country: ${provider.url}`);
    }
    return code.toUpperCase();
  });

  const firstSuccess = (Promise.any ? Promise.any(attempts) : raceAllSettledForFirstSuccess(attempts))
    .catch(() => null);

  const budgetTimeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), GEO_BUDGET_MS);
  });

  const result = await Promise.race([firstSuccess, budgetTimeout]);
  controller.abort(); // stop any providers still in flight, win or lose
  return result;
}

/* Promise.any fallback for older runtimes that lack it - resolves with the
   first attempt to fulfil, or null if every attempt rejects. */
function raceAllSettledForFirstSuccess(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) { resolve(null); return; }
    promises.forEach((p) => {
      p.then(resolve).catch(() => { if (--pending === 0) resolve(null); });
    });
  });
}

/* Wires the two explicit EN / עב toggle buttons (index.html). The DOM was
   already put in the right language by initLanguage() at module load, so
   this only needs to (a) reflect which one is currently active and (b) turn
   a click into an explicit, permanently-persisted choice. */
function syncLangToggleUI(lang) {
  const enBtn = document.getElementById("langToggleEn"), heBtn = document.getElementById("langToggleHe");
  if (enBtn) enBtn.classList.toggle("is-active", lang === "en");
  if (heBtn) heBtn.classList.toggle("is-active", lang === "he");
}

export function setupLangToggle() {
  syncLangToggleUI(getActiveLang());
  const enBtn = document.getElementById("langToggleEn"), heBtn = document.getElementById("langToggleHe");
  [[enBtn, "en"], [heBtn, "he"]].forEach(([btn, lang]) => {
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      setLanguage(lang, { explicit: true });
      syncLangToggleUI(lang);
    });
  });
}

/* Boot entry point - runs once, at this module's top level (see the call at
   the very end of this file), independent of app.js's init()/
   DOMContentLoaded, so the geo-IP fetch fires as early in the page's life as
   possible. */
function initLanguage() {
  let explicit = false, stored = null;
  try {
    explicit = localStorage.getItem(LANG_EXPLICIT_KEY) === "true";
    stored = localStorage.getItem(LANG_KEY);
  } catch {}

  // Immediate paint: a genuine prior toggle click, else the pre-geo-IP guess -
  // never a flash of the raw markup default while we wait on the network.
  const initialLang = explicit && stored ? stored : getActiveLang();
  applyLanguage(initialLang);
  syncLangToggleUI(initialLang);

  if (explicit && stored) {
    console.log("[PEAR i18n] explicit choice on file:", stored, "- skipping geo-IP");
    return; // a real click always wins - skip geo-IP entirely
  }

  detectCountryCode().then((country) => {
    // Re-check: the visitor may have clicked a toggle button while this was
    // still in flight, which must win over whatever geo-IP just decided.
    let explicitNow = false;
    try { explicitNow = localStorage.getItem(LANG_EXPLICIT_KEY) === "true"; } catch {}
    if (explicitNow) return;

    const lang = country === "IL" ? "he" : "en"; // any failure/timeout (country===null) -> "en"
    console.log("Detected Country:", country, "Applying language:", lang);
    setLanguage(lang, { explicit: false });
    syncLangToggleUI(lang);
  });
}
initLanguage();
