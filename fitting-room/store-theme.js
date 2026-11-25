/* =============================================================================
   STORE THEME - the room in the store's own colours (2026-11-25)
   -----------------------------------------------------------------------------
   Asked: "the interface should change its UI by the store's site, and not look AI -
   e.g. FOX gets a script that sets the interface's colours to theirs (red, white,
   black); if colours can be set per script, even better - easy to change."

   HOW A STORE GETS ITS COLOURS - configuration only, never store code:
     1. The store's embed names a preset:   <script src=".../pear-widget.js"
                                                data-pear-key="…" data-pear-theme="fox">
     2. ...and/or overrides any single colour on the same tag:
            data-pear-color-primary="#000000"   buttons / strong fills
            data-pear-color-on-primary="#ffffff" text on those buttons
            data-pear-color-accent="#e21836"    highlights (active, progress, required)
            data-pear-color-bg="#ffffff"        page / card background
            data-pear-color-text="#0b0b0b"      text
            data-pear-radius="4px"              corner radius of controls (0-24px), or "pill"
                                                (round buttons, soft cards - PEAR's own shape)
            data-pear-font="Rubik"              a Google Fonts family name
   The widget forwards these to the room as theme / theme_* query params; this file
   reads them before the first paint, sets CSS variables on <html> and the class
   `pear-store-theme`. style.css's STORE THEME layer (the end of the file) draws the
   room from those variables - flat, solid, the store's colours, text aligned to the
   reading direction - instead of PEAR's glass look.

   No theme param -> this file does nothing, and the room is PEAR's default exactly.
   A preset is a row in STORE_THEMES below; changing a store's colours is editing its
   row (or its script tag), nothing else.

   Every value is validated (hex colours, px radius, a plain family name): the params
   come from a URL anyone can type, and they land in a style attribute.
   Runs as a classic script in <head>, before style.css paints - no flash of green.
   ============================================================================= */
(function () {
  var STORE_THEMES = {
    /* FOX (fox.co.il): red and white lead - FOX red (--fox-red on their site, read off
       fox.co.il's stylesheet 2026-11-25) fills the buttons, white text on it, a white
       page, shades of that red for lines and soft fills, round (pill) buttons, Rubik.
       The first cut was black buttons and square corners; the owner the same day:
       "buttons stay round, red and white should dominate, maybe shades of red". */
    fox: {
      primary: "#e21836",
      onPrimary: "#ffffff",
      accent: "#e21836",
      bg: "#ffffff",
      text: "#0b0b0b",
      radius: "pill",
      font: "Rubik",
    },
  };

  var HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function hex(v) {
    if (typeof v !== "string" || !HEX.test(v.trim())) return null;
    var h = v.trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h.toLowerCase();
  }
  function rgbOf(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /* Relative luminance, to pick a readable muted grey and line colour for a dark or
     a light background without asking the store for them. */
  function lum(h) {
    var c = rgbOf(h).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function radius(v) {
    if (typeof v === "string" && v.trim().toLowerCase() === "pill") return "pill";
    var m = typeof v === "string" && v.trim().match(/^(\d{1,2})(px)?$/);
    if (!m) return null;
    return Math.min(24, +m[1]) + "px";
  }
  function font(v) {
    return typeof v === "string" && /^[A-Za-z][A-Za-z0-9 ]{1,39}$/.test(v.trim()) ? v.trim() : null;
  }

  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }
  var name = (q.get("theme") || "").toLowerCase();
  var preset = Object.prototype.hasOwnProperty.call(STORE_THEMES, name) ? STORE_THEMES[name] : null;
  var keys = ["primary", "on_primary", "accent", "bg", "text", "radius", "font"];
  var any = !!preset;
  keys.forEach(function (k) { if (q.get("theme_" + k)) any = true; });
  if (!any) return;   // no theme: PEAR's default, untouched

  var base = preset || {};
  var t = {
    primary: hex(q.get("theme_primary")) || hex(base.primary) || "#111111",
    onPrimary: hex(q.get("theme_on_primary")) || hex(base.onPrimary) || null,
    accent: hex(q.get("theme_accent")) || hex(base.accent) || null,
    bg: hex(q.get("theme_bg")) || hex(base.bg) || "#ffffff",
    text: hex(q.get("theme_text")) || hex(base.text) || null,
    radius: radius(q.get("theme_radius")) || radius(base.radius) || "6px",
    font: font(q.get("theme_font")) || font(base.font) || null,
  };
  var darkBg = lum(t.bg) < 0.4;
  if (!t.text) t.text = darkBg ? "#ffffff" : "#111111";
  if (!t.onPrimary) t.onPrimary = lum(t.primary) < 0.4 ? "#ffffff" : "#111111";
  if (!t.accent) t.accent = t.primary;

  var root = document.documentElement;
  var s = root.style;
  s.setProperty("--store-primary", t.primary);
  s.setProperty("--store-on-primary", t.onPrimary);
  s.setProperty("--store-accent", t.accent);
  s.setProperty("--accent-rgb", rgbOf(t.accent).join(", "));
  s.setProperty("--store-bg", t.bg);
  s.setProperty("--store-text", t.text);
  s.setProperty("--store-text-rgb", rgbOf(t.text).join(", "));
  s.setProperty("--store-muted", darkBg ? "rgba(255, 255, 255, .62)" : "rgba(" + rgbOf(t.text).join(", ") + ", .58)");
  /* Lines and soft fills are SHADES OF THE ACCENT (a hairline at 22%, a wash at 6%), so
     the page reads in the store's colour and not in grey. */
  var acc = rgbOf(t.accent).join(", ");
  s.setProperty("--store-line", "rgba(" + acc + (darkBg ? ", .45)" : ", .22)"));
  s.setProperty("--store-soft", "rgba(" + acc + (darkBg ? ", .16)" : ", .06)"));
  /* A darker shade of the primary, for hover and press. */
  s.setProperty("--store-primary-deep", "rgb(" + rgbOf(t.primary).map(function (x) { return Math.round(x * 0.82); }).join(", ") + ")");
  var pill = t.radius === "pill";
  s.setProperty("--store-btn-radius", pill ? "9999px" : t.radius);
  s.setProperty("--store-radius", pill ? "14px" : t.radius);
  s.setProperty("--store-radius-lg", pill ? "20px" : Math.min(16, parseInt(t.radius, 10) * 2) + "px");
  if (t.font) s.setProperty("--store-font", '"' + t.font + '"');
  root.classList.add("pear-store-theme");
  if (darkBg) root.classList.add("pear-store-theme--dark");
  if (preset) root.setAttribute("data-pear-theme", name);

  /* The browser chrome's colour (mobile address bar) follows the store's page. */
  try {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", t.bg);
  } catch (e) {}

  /* The store's typeface, from Google Fonts (the room already loads its own faces there).
     Latin + Hebrew subsets come with the family's css2 response. */
  if (t.font) {
    try {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=" +
        encodeURIComponent(t.font).replace(/%20/g, "+") + ":wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    } catch (e) {}
  }
})();
