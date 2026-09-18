/* ============================================================================
   cookie-consent.js - PEAR fitting room · cookie / local-storage consent banner
   ----------------------------------------------------------------------------
   Owns #cookieBanner (index.html) and exactly one storage key:

     pear_cookie_consent = { v, essential: true, preferences: bool, decidedAt }

   The banner is revealed ONLY when that key is missing or from an older version,
   so an acknowledged visitor never sees it paint. It never dismisses without a
   choice - "Accept all" or "Save choices" - because closing a consent prompt is
   not consenting.

   Independent of app.js on purpose: a room that fails to boot must still ask.
   Copy comes from i18n.js through the banner's data-i18n markup, like every other
   static string.

   WHAT A CHOICE DOES TODAY. The decision is stored, published as
   window.PearCookieConsent.get() and announced as a `pear:cookieconsent` event.
   The room's existing storage writers (language, measurement-refresh date, fit
   gallery) do not read it yet - declining "Preferences" is recorded, not yet
   enforced. That wiring belongs in each writer, not here.

   Storage refusal (private mode, blocked site data): the banner still hides on a
   choice for this page view, and asks again next visit - the only honest answer
   when the choice cannot be remembered.
   ============================================================================ */
(() => {
  "use strict";

  const KEY = "pear_cookie_consent";
  const VERSION = 1;
  const SHOW_DELAY_MS = 700;   // let Screen 1's own entrance settle first
  const HIDE_MS = 620;         // matches .cookie-banner's .6s transform transition
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function read() {
    try {
      const rec = JSON.parse(localStorage.getItem(KEY) || "null");
      return rec && rec.v === VERSION ? rec : null;
    } catch (_) { return null; }
  }

  function write(preferences) {
    const rec = { v: VERSION, essential: true, preferences: !!preferences, decidedAt: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent("pear:cookieconsent", { detail: rec })); } catch (_) {}
    console.log("[PEAR] cookie consent recorded:", rec.preferences ? "all" : "essential only");
    return rec;
  }

  let api = { get: read, open: () => {} };
  window.PearCookieConsent = api;

  function start() {
    const banner = document.getElementById("cookieBanner");
    if (!banner) return;
    const acceptBtn   = document.getElementById("cookieAcceptAll");
    const settingsBtn = document.getElementById("cookieSettingsBtn");
    const settings    = document.getElementById("cookieSettings");
    const saveBtn     = document.getElementById("cookieSaveChoices");
    const prefsToggle = document.getElementById("cookiePrefsToggle");

    let hideTimer = 0;
    const ro = "ResizeObserver" in window ? new ResizeObserver(() => publishHeight()) : null;

    /* The help FAB lifts over the banner by this much (style.css, §8). */
    function publishHeight() {
      document.documentElement.style.setProperty("--cookie-banner-h", banner.offsetHeight + "px");
    }

    function setSettingsOpen(open) {
      if (!settings) return;
      settings.hidden = !open;
      banner.classList.toggle("is-settings-open", open);
      if (settingsBtn) settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
      publishHeight();
    }

    function show(withSettings) {
      clearTimeout(hideTimer);
      const rec = read();
      if (prefsToggle) prefsToggle.checked = rec ? !!rec.preferences : true;
      banner.hidden = false;
      setSettingsOpen(!!withSettings);
      document.body.classList.add("has-cookie-banner");
      if (ro) ro.observe(banner);
      publishHeight();
      // Two frames: the first paints the off-screen start state, the second slides it in.
      requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add("is-visible")));
    }

    function hide() {
      banner.classList.remove("is-visible");
      document.body.classList.remove("has-cookie-banner");
      if (ro) ro.disconnect();
      hideTimer = setTimeout(() => {
        banner.hidden = true;
        setSettingsOpen(false);
      }, REDUCE ? 0 : HIDE_MS);
    }

    acceptBtn && acceptBtn.addEventListener("click", () => { write(true); hide(); });
    saveBtn && saveBtn.addEventListener("click", () => { write(prefsToggle ? prefsToggle.checked : true); hide(); });
    settingsBtn && settingsBtn.addEventListener("click", () => setSettingsOpen(settings ? settings.hidden : false));

    api.open = () => show(true);   // re-open from a future "cookie settings" link

    if (!read()) setTimeout(() => show(false), SHOW_DELAY_MS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
