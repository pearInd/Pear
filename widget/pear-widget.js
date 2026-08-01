/* ============================================================================
   PEAR Widget - embeddable virtual try-on button for any store
   ----------------------------------------------------------------------------
   TWO WAYS TO EMBED - both work standalone: no build step, no extra setup,
   just swap STORE_KEY for your key.

   1) SCRIPT TAG (permanent - paste ONE line into your product page/template):

        <script src="https://pear-web-demo-sigma.vercel.app/widget/pear-widget.js"
                data-pear-key="STORE_KEY"></script>

   2) BROWSER CONSOLE (instant test on ANY live site - no code changes). Open
      DevTools → Console on a product page and paste:

        var s=document.createElement('script');
        s.src='https://pear-web-demo-sigma.vercel.app/widget/pear-widget.js';
        s.setAttribute('data-pear-key','STORE_KEY');
        document.head.appendChild(s);

      The widget resolves its own <script> tag (and its data-pear-key) from the
      DOM, so the console method boots exactly like the script-tag embed.

   What it does:
     1. Scans the host page for the product image (og:image → known product-image
        selectors → generic large-image heuristic) and its gallery thumbnails.
        Every candidate is read through imageUrlsFrom(), which pulls the REAL asset
        out of lazy-gallery attributes (data-src / srcset / data-zoom-image / a
        <noscript> copy of the markup) rather than the rendered src alone. That is
        what makes the BACK photo discoverable at all: on a Shopify slick/swiper or
        WooCommerce FlexSlider gallery only the active slide has a usable src, so
        reading src alone found exactly one image - the front - and the rear view
        never became a candidate. URLs are also upgraded past the CDN's thumbnail
        size suffix (…_100x100_crop_center.jpg → ….jpg), since a 100px rear photo
        has no legible print left to warp.
     2. Injects a "VIRTUAL FIT" button ("מדוד וירטואלית" on Hebrew/RTL pages)
        styled like a native Add-to-Cart button, placed right AFTER *every*
        Add-to-Cart button on the page (falls back to just below the product
        <h1> when the page has no cart button). A MutationObserver re-runs the
        injection as products load in (infinite scroll, tab/filter switches),
        and each cart button is stamped data-pear-injected so it's never doubled.
     3. On click, classifies the full gallery via the PEAR server (so every visit
        contributes to the server's front/back cache), sorts the images front-
        first/back-second, then immediately opens a fullscreen modal with the
        PEAR fitting room in an iframe - no picker popup - handing over the
        garment via URL params (garment_url / garment_type / garment_name),
        plus garment_url_back so the live Back view warps from a real rear photo
        instead of a prompt-steered guess off the front image, and a
        garment_images list (all gallery photos, front-sorted) the fitting room
        derives its front/back pair from - there is no user-facing picker.

   Back-image discovery, highest-trust first:
     1. an explicit data-pear-back on the product <img> or its container;
     2. a gallery image that POSITIVELY identifies itself as the rear view - its
        filename ("…_back.jpg", "…-rear-2.jpg"), its alt text, or its thumbnail
        label, in English or Hebrew (looksLikeBackImage);
     3. the server's classifier verdict, applied post-open via PEAR_UPDATE_GARMENT;
     4. a rear view GENERATED from the front photo, when the product genuinely
        ships only one image (back_source: "synthetic" - see /api/classify-images).
   data-pear-front, when present, overrides the scraped front URL.

   Explicitly NOT in that list: "the second gallery photo". Positional guessing is
   the documented root cause of the print-less back view - on a gallery that is all
   front-view crops it labels a FRONT photo as the back, and the model then receives
   "this is the BACK, do NOT render the front" and suppresses the only graphic it
   can see. No back is claimed without positive evidence.

   Self-contained: no globals leak (everything lives in this IIFE), all CSS is
   injected via a single <style class="pear-widget-styles"> tag, and every class
   name is prefixed "pear-widget-" so nothing collides with the host page.
   ============================================================================ */
(function (w, d) {
  "use strict";

  /* Re-embed guard - a page that includes the script twice (or a store re-runs it
     on purpose, e.g. after an SPA navigation swaps the DOM) reinjects rather than
     silently no-oping: __pearReinject clears the idempotency stamps and re-scans
     the page so buttons come back instead of staying gone for the rest of the
     script's lifetime. */
  if (w.__pearWidgetLoaded) {
    w.__pearReinject && w.__pearReinject();
    return;
  }
  w.__pearWidgetLoaded = true;

  /* ── configuration ──────────────────────────────────────────────────────── */
  // DOMAIN FIX: was hardcoded to pear-web-demo.vercel.app, a separate Vercel
  // deployment this project no longer controls/deploys to (see troubleshooting
  // notes). This constant only matters when the normal script.src resolution
  // below fails (no document.currentScript AND no matching <script> tag found
  // in the DOM - a rare embed pattern) - but if it ever DOES kick in, it must
  // point at a domain that's actually current, or every API call/iframe src
  // the widget builds would silently target a stale build.
  var FALLBACK_BASE = "https://pear-web-demo-sigma.vercel.app";

  /* Resolve the PEAR origin from this script's own src so the widget works
     against localhost / preview deployments too; fall back to production. */
  var script = d.currentScript ||
    (function () {
      var s = d.querySelectorAll('script[src*="pear-widget"]');
      return s.length ? s[s.length - 1] : null;
    })();

  var PEAR_BASE = FALLBACK_BASE;
  try {
    if (script && script.src) PEAR_BASE = new URL(script.src).origin;
  } catch (_) {}

  var STORE_KEY = (script && script.getAttribute("data-pear-key")) || "";

  /* Opt-in strict two-view gate: when data-pear-require-both-views is present (and
     not "false"), the fitting room hard-blocks go-live unless a real back image
     arrived. Absent → graceful default (Back view falls back to the front + prompt). */
  var _reqBoth = script ? script.getAttribute("data-pear-require-both-views") : null;
  var REQUIRE_BOTH_VIEWS = _reqBoth !== null && _reqBoth !== "false";

  /* Stitched Garment Composite: the fitting room builds ONE reference image with the
     FRONT and BACK panels side by side and labelled, and names the panel to render
     per the detected orientation (see createGarmentComposite in fitting-room/app.js).
     On by default there; a store can force the older per-orientation single-asset
     path with data-pear-composite="false" without waiting on a redeploy, which is the
     escape hatch if double-rendering shows up on a particular catalog. */
  var _composite = script ? script.getAttribute("data-pear-composite") : null;
  var COMPOSITE_PARAM = _composite === null ? ""
    : (_composite === "false" || _composite === "0") ? "0" : "1";

  /* Opt-in strict one-time measurement gate for public demo embeds (e.g. the
     marketing site): when data-pear-demo-gate is the EXACT string "true", the
     fitting room skips its normal name/phone registration and allows exactly one
     measurement per browser, then shows a friendly "already used" screen instead
     of the camera. Config-driven ONLY - never a hostname/domain check - so a
     normal store embed (no attribute) always gets the regular, unlimited,
     server-backed flow untouched.
     Strict-equality on purpose (not "present and not false"): a bare attribute
     (data-pear-demo-gate with no value → getAttribute() returns ""), a stray
     placeholder, or any other value must all evaluate to false - only the
     literal "true" turns this on. */
  var DEMO_GATE = !!script && script.getAttribute("data-pear-demo-gate") === "true";
  var DEMO_GATE_KEY = "pear_demo_gated_measured";

  /* This is the PARENT PAGE's own localStorage - a different origin from the
     fitting-room iframe (PEAR_BASE) in the general case, so it can only reflect
     a lock this same host page already learned about (either from a previous
     load, persisted here, or via the "message" listener wired below once the
     iframe reports a fresh lock). */
  function isDemoGateLockedLocally() {
    if (!DEMO_GATE) return false;
    try { return w.localStorage.getItem(DEMO_GATE_KEY) === "true"; } catch (_) { return false; }
  }
  function persistDemoGateLock() {
    try { w.localStorage.setItem(DEMO_GATE_KEY, "true"); } catch (_) {}
  }

  /* ── demo mode - opt-in, explicit, OFF by default ─────────────────────────
     A SEPARATE, older one-time-lock mechanism that coexists with DEMO_GATE above
     (fitting-room/app.js reads both `demo_gate=1` and `pear_demo=1` as distinct,
     parallel triggers - see openModal()'s query-string builder below). Demo
     behavior only activates when the embedding page's own <script> tag
     explicitly opts in:
       <script src="…/pear-widget.js" data-pear-key="…" data-pear-demo="true">
     Absent (every normal embed) → DEMO_MODE is false and nothing below in
     this file behaves any differently than before demo mode existed. */
  var _demoAttr = script ? script.getAttribute("data-pear-demo") : null;
  var DEMO_MODE = _demoAttr === "true" || _demoAttr === "1";

  /* ── one-time public demo lock - active ONLY when DEMO_MODE is true ──────
     This host page and the fitting-room iframe (PEAR_BASE, a DIFFERENT origin)
     each have their OWN localStorage, so they can't share this flag directly.
     The fitting room sets its own copy the instant a first look is saved and
     posts a message here so every trigger button on THIS page locks too,
     with no reload - see the "message" listener near the bottom of this file. */
  var PEAR_DEMO_LOCK_KEY = "pear_demo_measured";
  var injectedButtons = [];

  function isDemoLocked() {
    if (!DEMO_MODE) return false;   // normal embeds: never locked
    try { return w.localStorage.getItem(PEAR_DEMO_LOCK_KEY) === "true"; } catch (_) { return false; }
  }
  function setDemoLocked() {
    try { w.localStorage.setItem(PEAR_DEMO_LOCK_KEY, "true"); } catch (_) {}
  }
  function lockButton(btn) {
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = isHebrewPage() ? "כבר ביצעת מדידה" : "Already Measured";
  }
  // Named distinctly from DEMO_GATE's lockAllButtons() below (two coexisting
  // mechanisms with two different button-tracking approaches - this one walks
  // the injectedButtons array; DEMO_GATE's queries .pear-widget-btn directly).
  function lockAllDemoModeButtons() {
    for (var i = 0; i < injectedButtons.length; i++) lockButton(injectedButtons[i]);
  }

  /* Garment-category keyword map (scanned against product name + page title). */
  var CATEGORY_KEYWORDS = {
    shirt: ["חולצה", "טישרט", "גופייה", "shirt", "tee", "top",
            "blouse", "sweater", "hoodie", "crop"],
    pants: ["מכנסיים", "ג׳ינס", "pants", "jeans", "trousers",
            "shorts", "leggings", "skirt"],
    dress: ["שמלה", "חצאית", "dress", "jumpsuit", "romper"],
    outerwear: ["מעיל", "ג׳קט", "coat", "jacket", "blazer", "cardigan"]
  };
  var DEFAULT_CATEGORY = "tops";

  /* src substrings that mark an image as decorative, never a garment */
  var EXCLUDE_SRC = ["logo", "icon", "sprite", "placeholder", "blank", "pixel"];

  /* Upper bound on the gallery forwarded to /api/classify-images - see the cap note
     in collectGalleryImages() for why an unbounded list is a latency problem. */
  var MAX_GALLERY_IMAGES = 8;

  var PRODUCT_IMG_SELECTORS = [
    ".product-image img",
    ".product__media img",
    ".woocommerce-product-gallery img",
    "[data-product-image]",
    ".product-photo img"
  ].join(", ");

  /* Gallery-thumbnail selectors - every product photo we can hand the fitting room
     as a switchable reference (garment_images). Covers Shopify (product__media-list),
     WooCommerce/generic (.thumbnails, .product-thumbnails), and the common carousels
     (Slick, Swiper). */
  var THUMB_SELECTORS = [
    ".product-thumbnails img",
    ".product__media-list img",
    ".thumbnails img",
    "[data-thumbnail] img",
    ".slick-slide img",
    ".swiper-slide img",
    // Shopify gallery variants seen on fox.co.il and similar themes - the
    // plain ".product__media-list img"/.slick-slide selectors above miss
    // these markup shapes (media wrapped in <li> or gated by data attrs
    // instead of a list container, or images identified only by their CDN
    // URL rather than any surrounding class).
    '[data-media-type="image"] img',
    '.product__media img',
    '.product-single__media img',
    'li.product__media-item img',
    '[data-product-media-type-image] img',
    '.slick-slide img[src*="cdn.shopify"]',
    'img[src*="cdn.shopify.com/s/files"]'
  ].join(", ");

  /* Known single-product gallery containers - checked BEFORE the ancestor
     walk-up in findGarmentForButton() (see resolvePrimaryProductImage). These
     are page-wide selectors, only reliable on a genuine single-product page. */
  var PRODUCT_GALLERY_SELECTORS = [
    ".product__media-list img",
    ".product-images img",
    ".product-single__photo",
    "[data-product-single-media-wrapper] img",
    ".product__media img"
  ].join(", ");

  /* ── page metadata helpers ──────────────────────────────────────────────── */
  function getGarmentName() {
    var h1 = d.querySelector("h1");
    var name = h1 && h1.textContent ? h1.textContent.trim() : "";
    return name || d.title || "Garment";
  }

  function detectCategory(name) {
    var haystack = ((name || "") + " " + (d.title || "")).toLowerCase();
    for (var cat in CATEGORY_KEYWORDS) {
      var words = CATEGORY_KEYWORDS[cat];
      for (var i = 0; i < words.length; i++) {
        if (haystack.indexOf(words[i].toLowerCase()) !== -1) return cat;
      }
    }
    return DEFAULT_CATEGORY;
  }

  function isExcludedSrc(src) {
    var s = (src || "").toLowerCase();
    for (var i = 0; i < EXCLUDE_SRC.length; i++) {
      if (s.indexOf(EXCLUDE_SRC[i]) !== -1) return true;
    }
    return false;
  }

  /* ── back-image discovery helpers ───────────────────────────────────────────
     A garment's rear photo lets the fitting room warp the Back view from a real
     reference (e.g. a jersey's back print) instead of inferring it from the front.
     Priority: explicit data-pear-back on the img/container → a gallery image whose
     URL/alt POSITIVELY reads as a rear shot. data-pear-front, when set, overrides
     the scraped front URL.

     Deliberately NOT in that list: "the second gallery image". Positional guessing
     is the documented root cause of the blank/print-less back view (see
     resolveFrontBack below) - on a gallery that's entirely front-view crops it hands
     a FRONT photo to the live session labeled "back", which then reaches Lucy with
     "do NOT render the front" and suppresses the only graphic it can see. A DOM-side
     back is only claimed on positive evidence; everything else defers to the
     server-side classifier. */
  function readAttr(el, name) {
    return (el && el.getAttribute && el.getAttribute(name)) || "";
  }

  /* ── lazy-gallery URL extraction ──────────────────────────────────────────────
     THE SCRAPER'S ACTUAL BLIND SPOT. Reading `currentSrc || src` only sees images the
     browser has already decoded - on the ecommerce galleries this widget targets
     (Shopify slick/swiper, WooCommerce FlexSlider, every "lazyload" plugin) only the
     ACTIVE slide has a real src; every off-screen slide - which is where the back
     photo lives - carries a 1×1 gif, a blurred base64 placeholder, or nothing at all,
     and holds its true URL in data-src/srcset/<noscript> until it scrolls into view.
     That is why a product page reliably yielded exactly one image (the front) and the
     rear view was never even a candidate.

     Order matters: the FIRST usable candidate wins, so explicit full-size attributes
     (zoom/large) are checked before the rendered src, which is often a thumbnail. */
  var LAZY_SRC_ATTRS = [
    "data-zoom-image", "data-zoom-src", "data-large_image", "data-full",
    "data-image", "data-master", "data-photoswipe-src",
    "data-src", "data-original", "data-lazy", "data-lazy-src", "data-thumb"
  ];
  var LAZY_SRCSET_ATTRS = ["srcset", "data-srcset", "data-lazy-srcset"];

  /* Placeholder pixels/blurs that lazy loaders park in `src` - never a garment. */
  function isPlaceholderSrc(u) {
    if (!u) return true;
    if (/^data:/i.test(u)) return true;                       // inline blur/1×1 gif
    return /(^|\/)(1x1|blank|spacer|transparent|loading|lazy)[.\-_]/i.test(u);
  }

  /* Pick the highest-resolution entry out of a srcset ("url 400w, url 1200w" or
     "url 1x, url 2x"). A bare, descriptor-less single URL is returned as-is. */
  function largestFromSrcset(value) {
    if (!value) return "";
    var parts = value.split(",");
    var bestUrl = "", bestWeight = -1;
    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].trim().split(/\s+/);
      if (!bits[0]) continue;
      var d = bits[1] || "";
      var weight = 0;
      if (/w$/i.test(d))      weight = parseFloat(d);
      else if (/x$/i.test(d)) weight = parseFloat(d) * 1000;   // 2x ranks above any plain width
      if (weight > bestWeight) { bestWeight = weight; bestUrl = bits[0]; }
    }
    return bestUrl;
  }

  /* Protocol-relative ("//cdn…") and root-relative ("/files/…") srcs are extremely
     common in lazy attributes; the API and the fitting room both need absolute URLs. */
  function absolutize(u) {
    if (!u) return "";
    try { return new URL(u, d.baseURI || w.location.href).href; } catch (_) { return ""; }
  }

  /* Storefront CDNs encode the RENDERED size into the filename, so a gallery
     thumbnail scraped as-is is a 100px image. Handing that to the VTON model as the
     back reference is its own flavour of "blank back" - there is no print left to
     read at that size. Rewrite to the original asset:
       Shopify  shirt_100x100_crop_center.jpg → shirt.jpg  (+ drop ?width=/&height=)
       WooCommerce  shirt-300x300.jpg         → shirt.jpg
     The Woo rewrite is restricted to thumbnail-scale dimensions on purpose: a real
     asset legitimately named "poster-1920x1080.jpg" must not be rewritten into a 404. */
  /* Image-RESIZER endpoints carry the real asset in a `url=` param and REQUIRE their
     sizing params: Next.js /_next/image answers HTTP 400 ("w is required") without
     `w`, and Cloudflare/imgproxy-style paths encode the transform in the path itself.
     Stripping those yields a broken URL, not a bigger image - so these are returned
     untouched. Caught by fixture E in the widget harness; without this guard every
     Next.js-hosted storefront would hand the API un-fetchable image URLs. */
  var RESIZER_RE = /\/(?:_next\/image|cdn-cgi\/image|_vercel\/image|imgproxy|thumbor|resize)\b|[?&]url=/i;
  function isResizerUrl(u) { return RESIZER_RE.test(u || ""); }

  function upgradeImageUrl(url) {
    if (!url || /^data:/i.test(url)) return url;
    if (isResizerUrl(url)) return url;
    var out = url;
    // Shopify size suffix, immediately before the extension.
    out = out.replace(
      /_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d{1,4}x(?:\d{1,4})?)(?:_crop_[a-z]+)?(?=\.(?:jpe?g|png|webp|gif)\b)/i,
      ""
    );
    // WooCommerce/WordPress size suffix - thumbnail scale only (both dims ≤ 600).
    out = out.replace(/-(\d{2,3})x(\d{2,3})(?=\.(?:jpe?g|png|webp|gif)\b)/i, function (m, a, b) {
      return (parseInt(a, 10) <= 600 && parseInt(b, 10) <= 600) ? "" : m;
    });
    // Resize query params (Shopify's newer CDN, Next/image-style loaders).
    out = out.replace(/([?&])(?:width|height|w|h|size)=\d+(&|$)/gi, "$1").replace(/[?&]+$/, "");
    return out;
  }

  /* Every URL an <img>/<source>/<a> element could be hiding, best-first, absolute
     and resolution-upgraded. */
  function imageUrlsFrom(el) {
    var out = [];
    function push(u) {
      u = absolutize(u);
      if (!u || isPlaceholderSrc(u) || isExcludedSrc(u)) return;
      u = upgradeImageUrl(u);
      if (out.indexOf(u) === -1) out.push(u);
    }
    if (!el || !el.getAttribute) return out;
    for (var i = 0; i < LAZY_SRC_ATTRS.length; i++) push(readAttr(el, LAZY_SRC_ATTRS[i]));
    for (var j = 0; j < LAZY_SRCSET_ATTRS.length; j++) push(largestFromSrcset(readAttr(el, LAZY_SRCSET_ATTRS[j])));
    // The rendered src last: it's the most likely to be a placeholder or a thumbnail.
    push(el.currentSrc || el.src || "");
    // <picture><source srcset> siblings - the <img> itself may carry only a fallback.
    var pic = el.parentElement;
    if (pic && pic.tagName === "PICTURE") {
      var sources = pic.querySelectorAll("source");
      for (var s = 0; s < sources.length; s++) {
        for (var k = 0; k < LAZY_SRCSET_ATTRS.length; k++) {
          push(largestFromSrcset(readAttr(sources[s], LAZY_SRCSET_ATTRS[k])));
        }
      }
    }
    return out;
  }

  /* The single best URL for an element (first candidate), "" when it has none. */
  function bestImageUrl(el) {
    var urls = imageUrlsFrom(el);
    return urls.length ? urls[0] : "";
  }

  /* <noscript> gallery fallbacks. Lazy-loading themes ship the REAL <img> markup
     inside <noscript> for crawlers/JS-off visitors, which makes it the single most
     reliable source of a full gallery on a page whose slides haven't rendered yet.
     Its contents are inert text to the parser, so pull the srcs out with a regex
     rather than querySelector. */
  function noscriptImageUrls(root) {
    var out = [];
    var tags = (root || d).querySelectorAll("noscript");
    for (var i = 0; i < tags.length && i < 40; i++) {
      var html = tags[i].textContent || "";
      if (html.indexOf("<img") === -1) continue;
      var re = /<img[^>]+?(?:data-src|srcset|src)\s*=\s*["']([^"']+)["']/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var u = absolutize(largestFromSrcset(m[1]) || m[1]);
        if (!u || isPlaceholderSrc(u) || isExcludedSrc(u)) continue;
        u = upgradeImageUrl(u);
        if (out.indexOf(u) === -1) out.push(u);
      }
    }
    return out;
  }

  /* ── positive back-view signals ───────────────────────────────────────────────
     Storefronts that shoot a rear photo almost always SAY so - in the filename
     ("…_back.jpg", "…-rear-2.jpg", "…_b.jpg"), in the alt text ("Model wearing …,
     back view"), or on the thumbnail's own label. These are free, instant and
     require no Gemini round trip, so they run first and give the widget a real
     back_image_url to hand over on the very first open.
     Hebrew: "גב" is matched only when NOT followed by another Hebrew letter, so
     "גב" (back) hits and "גבוה" (tall) does not. */
  var BACK_WORD_RE  = /(^|[^a-z0-9])(back|backside|rear|behind)([^a-z0-9]|$)/i;
  var BACK_FILE_RE  = /[_\-.](b|bk|back|rear)[_\-.]?\d*\.(?:jpe?g|png|webp|gif)\b/i;
  var BACK_HE_RE    = /(?:גב|אחורי|מאחור)(?![א-ת])/;
  var FRONT_WORD_RE = /(^|[^a-z0-9])(front|face|frontside)([^a-z0-9]|$)/i;

  /* Only the filename is tested for the English word, never the whole URL: a store
     hosted under "…/backend/" or a CDN path containing "rearrange" would otherwise
     mark every single photo as a back view. */
  function fileNameOf(url) {
    var path = (url || "").split("?")[0];
    var slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
  }

  function looksLikeBackImage(url, text) {
    var file = fileNameOf(url);
    if (BACK_FILE_RE.test(file)) return true;
    if (BACK_WORD_RE.test(file) && !FRONT_WORD_RE.test(file)) return true;
    var t = (text || "").trim();
    if (!t) return false;
    if (BACK_HE_RE.test(t)) return true;
    return BACK_WORD_RE.test(t) && !FRONT_WORD_RE.test(t);
  }

  /* Text a gallery image carries about itself - alt, title, aria-label, and the
     thumbnail button/link wrapping it (themes often label the swatch, not the img). */
  function labelTextFor(el) {
    if (!el) return "";
    var bits = [readAttr(el, "alt"), readAttr(el, "title"), readAttr(el, "aria-label")];
    var p = el.parentElement;
    for (var depth = 0; depth < 2 && p; depth++) {
      bits.push(readAttr(p, "title"), readAttr(p, "aria-label"), readAttr(p, "data-alt"));
      p = p.parentElement;
    }
    return bits.join(" ");
  }

  /* Normalise for comparison. Matching on the bare path was not enough: the SAME photo
     routinely appears in a gallery as "shirt.jpg", "shirt_800x.jpg" and
     "shirt_100x100_crop_center.jpg", which have three different paths. Two spellings of
     one photo getting through as a front/back PAIR is what bound the front image as the
     back reference downstream - and the fitting room then asked the model to
     "reproduce the BACK" while showing it the front, duplicating the chest print onto
     the back. upgradeImageUrl() already strips the size markers, so canonicalising
     through it makes those three collapse to one identity.
     Mirrors canonicalImageUrl() in fitting-room/app.js - keep the two in lockstep. */
  function canonicalPhoto(u, depth) {
    if (!u) return "";
    if (/^data:/i.test(u)) return u;
    /* Resizer endpoints: the identity is the `url=` param (the REAL asset), not the
       endpoint path. Keying on the path would make every image on a Next.js store
       canonicalise to ".../_next/image" - collapsing an entire product gallery into a
       single entry and silently destroying the back photo. Recurse into the wrapped
       URL instead; depth-limited because a resizer can legally wrap another. */
    if (isResizerUrl(u)) {
      var m = /[?&]url=([^&]+)/i.exec(u);
      if (m && (depth || 0) < 3) {
        var inner = m[1];
        try { inner = decodeURIComponent(inner); } catch (_) {}
        // Root-relative url= resolved against the resizer's own origin, so the wrapped
        // form and a direct reference to the same photo canonicalise identically.
        try { inner = new URL(inner, u).href; } catch (_) {}
        return canonicalPhoto(inner, (depth || 0) + 1);
      }
      return u.toLowerCase();     // transform encoded in the path - compare whole
    }
    return upgradeImageUrl(u).split("?")[0].toLowerCase();
  }
  function samePhoto(a, b) {
    return !!a && !!b && canonicalPhoto(a) === canonicalPhoto(b);
  }

  /* Console-safe URL: a server-generated rear view arrives as a data: URL of a few
     hundred KB, which would flood DevTools if logged raw. */
  function abbrevUrl(u) {
    if (!u) return "(none)";
    if (/^data:/i.test(u)) return "data:… (" + u.length.toLocaleString() + " chars, generated rear view)";
    return u.length > 120 ? u.slice(0, 120) + "…" : u;
  }

  /* Extract a "same product" identifier from a CDN image URL so gallery
     collection can tell this product's photos apart from a sibling product's.
     Shopify (fox.co.il included) - and most storefront CDNs - embed a long
     numeric id somewhere in the path/filename (product id, variant id, or an
     asset id scoped to the product); the longest run of 6+ digits is that id.
     Returns "" when no such run is found (e.g. filenames are plain words) -
     callers must treat that as "no signal" rather than "no match", so stores
     without numeric ids in their CDN paths aren't over-filtered. */
  function extractProductId(url) {
    if (!url) return "";
    var path = url.split("?")[0];
    var matches = path.match(/\d{6,}/g);
    if (!matches || !matches.length) return "";
    return matches.reduce(function (longest, m) { return m.length > longest.length ? m : longest; });
  }

  /* Ground-truth product id straight from the store's own page data, when the
     platform exposes one - far more reliable than guessing a numeric run out of
     a CDN filename (extractProductId above), which can't tell a product id from
     an unrelated asset/variant id that happens to also be 6+ digits. Currently
     Shopify only (window.ShopifyAnalytics.meta.product.id, or the older
     window.meta.product.id some themes still expose); "" means no signal, same
     contract as extractProductId, so non-Shopify stores fall back to it untouched. */
  function getShopifyProductId() {
    try {
      var id = (w.ShopifyAnalytics && w.ShopifyAnalytics.meta && w.ShopifyAnalytics.meta.product &&
                 w.ShopifyAnalytics.meta.product.id) ||
                (w.meta && w.meta.product && w.meta.product.id);
      return id ? String(id) : "";
    } catch (_) { return ""; }
  }

  function explicitAttr(img, name) {
    return readAttr(img, name) || readAttr(img.parentElement, name);
  }

  /* Shopify (and Shopify-alike) variant id - read off the store's own Add-to-Cart
     form so the fitting room's "הוסף לסל" button can hand it back for a real
     /cart/add.js call. Prefer the id scoped to THIS button's own form (multi-
     product pages); fall back to a page-wide lookup for bare PDPs. */
  function extractVariantId(atcBtn) {
    var form = atcBtn && atcBtn.closest ? atcBtn.closest("form") : null;
    var input = (form && form.querySelector('input[name="id"], select[name="id"]')) ||
                d.querySelector('input[name="id"], select[name="id"]');
    return input ? input.value : "";
  }

  /* Scan the product gallery for an image that POSITIVELY identifies itself as the
     rear view (filename / alt / thumbnail label - see looksLikeBackImage). Returns ""
     when nothing does, which is a meaningful answer: it tells the caller "this DOM
     has no evidence of a back photo", and the server-side classifier - not a
     positional guess - decides from there.

     Scans both the thumbnail strip (where a lazy gallery keeps its off-screen slides)
     and the main product-image selectors, since themes split the two differently. */
  function findGalleryBack(primaryUrl, root) {
    var shopifyId = getShopifyProductId();
    var primaryRegexId = extractProductId(primaryUrl);
    var scope = root || d;
    var sel = scope.querySelectorAll(THUMB_SELECTORS + ", " + PRODUCT_IMG_SELECTORS);
    for (var i = 0; i < sel.length; i++) {
      var el = sel[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG") continue;
      var urls = imageUrlsFrom(el);
      if (!urls.length) continue;
      var label = labelTextFor(el);
      for (var u = 0; u < urls.length; u++) {
        var src = urls[u];
        if (samePhoto(src, primaryUrl)) continue;
        if (!looksLikeBackImage(src, label)) continue;
        // Same confirm-don't-veto logic as collectGalleryImages - see its comment.
        if (!(shopifyId && src.indexOf(shopifyId) !== -1)) {
          var candId = extractProductId(src);
          if (primaryRegexId && candId && candId !== primaryRegexId) continue;   // different product - skip
        }
        console.log("[PEAR] back image identified from DOM signals:", src, "| label:", label.trim().slice(0, 80));
        return src;
      }
    }
    /* Also scan the theme's <noscript> gallery copy. On a gallery that renders nothing
       until interacted with, those are the ONLY product images present - the element
       loop above has nothing to walk, so a rear photo named "…-rear.jpg" in there was
       invisible to this function. No element means no alt/label to read, so the
       filename is the only signal available (caught by fixture B in the harness). */
    var nsUrls = noscriptImageUrls(scope);
    for (var n = 0; n < nsUrls.length; n++) {
      var nsSrc = nsUrls[n];
      if (samePhoto(nsSrc, primaryUrl) || !looksLikeBackImage(nsSrc, "")) continue;
      if (!(shopifyId && nsSrc.indexOf(shopifyId) !== -1)) {
        var nsId = extractProductId(nsSrc);
        if (primaryRegexId && nsId && nsId !== primaryRegexId) continue;
      }
      console.log("[PEAR] back image identified from <noscript> gallery:", nsSrc);
      return nsSrc;
    }
    return "";
  }

  /* ── STEP 1 - scan the page for garment images ──────────────────────────── */
  function findProductImages() {
    var found = [];
    var seen = [];

    function push(img) {
      if (!img || seen.indexOf(img) !== -1) return;
      if (isExcludedSrc(img.currentSrc || img.src)) return;
      seen.push(img);
      found.push(img);
    }

    /* Priority 1 - the og:image, when a visible <img> carries the same URL. */
    var og = d.querySelector('meta[property="og:image"]');
    var ogUrl = og && og.content ? og.content : "";
    if (ogUrl) {
      var imgs = d.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].currentSrc || imgs[i].src || "";
        /* match on the path part - CDNs often vary query params / protocol */
        if (src && (src === ogUrl || src.split("?")[0] === ogUrl.split("?")[0])) {
          push(imgs[i]);
        }
      }
    }

    /* Priority 2 - well-known product-image selectors. */
    if (!found.length) {
      var sel = d.querySelectorAll(PRODUCT_IMG_SELECTORS);
      for (var j = 0; j < sel.length; j++) {
        var el = sel[j];
        /* [data-product-image] may be the container rather than the img */
        if (el.tagName !== "IMG") el = el.querySelector("img") || el;
        if (el.tagName === "IMG") push(el);
      }
    }

    /* Priority 3 - any big image that doesn't look like chrome/logo. */
    if (!found.length) {
      var all = d.querySelectorAll("img");
      for (var k = 0; k < all.length; k++) {
        var im = all[k];
        if (im.naturalWidth > 200 && im.naturalHeight > 200) push(im);
      }
    }

    /* og:image wins as the garment URL for the page's primary image; an explicit
       data-pear-back (or data-pear-front override) is captured per image. Non-explicit
       URLs go through imageUrlsFrom() so a lazy <img> resolves to its real, full-size
       asset instead of a placeholder pixel or a 100px thumbnail. */
    var entries = found.map(function (img, idx) {
      return {
        img: img,
        url: explicitAttr(img, "data-pear-front") ||
             ((idx === 0 && ogUrl) ? upgradeImageUrl(absolutize(ogUrl)) : bestImageUrl(img)),
        back: explicitAttr(img, "data-pear-back")
      };
    });

    /* Gallery fallback for the primary product: when no explicit rear photo was
       annotated, borrow the next distinct product-gallery image. */
    if (entries.length && !entries[0].back) {
      entries[0].back = findGalleryBack(entries[0].url);
    }

    return entries;
  }

  /* Collect every distinct product-gallery photo for the fitting room's automatic
     front/back resolution. The primary (og:image / scraped front) is forced first so it
     stays the loaded-on-open garment; gallery thumbnails follow in DOM order. De-duped on the
     path (CDNs vary query params), decorative images excluded.

     Also filtered to the SAME PRODUCT as primaryUrl: `root` scopes the THUMB_SELECTORS
     query, but a root that's climbed too high (a shared grid/collection container -
     see findGarmentForButton's ancestor walk-up) or a deliberately page-wide root
     can still surface a sibling product's thumbnails. The id check below is the
     second, independent line of defense against that - see getShopifyProductId /
     extractProductId's own comments for how the two id sources differ. */
  function collectGalleryImages(primaryUrl, root) {
    var urls = [];
    var seenPaths = [];
    /* Ground-truth product id (Shopify) is a CONFIRMING signal, not a veto: when
       a candidate's URL contains it, that's a strong same-product match, but its
       ABSENCE is not proof of a different product - most Shopify themes (fox.co.il
       included, see the test image "1823292409-1.jpg") name CDN files after an
       asset/media id, never the product's own internal id, so requiring a literal
       substring match rejected every real gallery thumbnail and collapsed the
       gallery down to just the primary image. Fall back to the regex heuristic
       (extractProductId) - which IS validated against fox.co.il's naming scheme -
       whenever the Shopify id doesn't literally appear; only reject on an actual
       regex-id disagreement. The primary image is always kept regardless - it was
       already resolved as THIS product's photo by the caller. */
    var shopifyId = getShopifyProductId();
    var primaryRegexId = extractProductId(primaryUrl);
    console.log('[PEAR] primary URL:', primaryUrl);
    console.log('[PEAR] shopifyId:', shopifyId);
    var rejected = [];
    function add(u, isPrimary) {
      if (!u || isExcludedSrc(u)) return;
      /* Canonical identity, not the bare path: "shirt.jpg", "shirt_800x.jpg" and
         "shirt_100x100_crop_center.jpg" are ONE photo with three paths, and letting
         two of them through as separate gallery entries is what allowed a front/back
         "pair" that is really the same image twice. */
      var path = canonicalPhoto(u);
      if (seenPaths.indexOf(path) !== -1) return;
      if (!isPrimary) {
        var confirmedByShopifyId = shopifyId && u.indexOf(shopifyId) !== -1;
        if (!confirmedByShopifyId) {
          var candId = extractProductId(u);
          if (primaryRegexId && candId && candId !== primaryRegexId) {
            rejected.push(u);
            return;   // different product - skip
          }
        }
      }
      seenPaths.push(path);
      urls.push(u);
    }
    add(primaryUrl, true);
    var scope = root || d;
    var imgs = scope.querySelectorAll(THUMB_SELECTORS);
    var candidates = [];
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG") continue;
      /* Every URL this element carries, not just the rendered src - on a lazy gallery
         the off-screen slides (i.e. the back view) have only data-src/srcset. The
         first candidate is the best one; the rest are added too because a theme can
         put the full-size asset in one attribute and the only *distinct* photo in
         another, and de-duplication upstream makes extra candidates harmless. */
      var urlsFor = imageUrlsFrom(el);
      for (var u = 0; u < urlsFor.length; u++) {
        candidates.push(urlsFor[u]);
        add(urlsFor[u]);
      }
    }
    /* Last resort for galleries that render NOTHING until interacted with: the
       theme's own <noscript> copy of the gallery markup. */
    var ns = noscriptImageUrls(scope);
    for (var n = 0; n < ns.length; n++) { candidates.push(ns[n]); add(ns[n]); }

    console.log('[PEAR] THUMB_SELECTORS matched', imgs.length, 'element(s) under root:', scope);
    console.log('[PEAR] all candidates before filter:', candidates);
    console.log('[PEAR] rejected by id filter:', rejected);
    console.log('[PEAR] candidates after filter:', urls);

    /* Cap the list. Better lazy-attribute extraction legitimately surfaces 15-30
       photos on a rich PDP, and /api/classify-images spends ~1.1s per UNCACHED image
       (Gemini rate limit) - an uncapped gallery turns the post-open correction into a
       30s wait, long after the shopper has gone live on the DOM-order guess. The
       front/back pair is always inside the first few gallery photos. */
    if (urls.length > MAX_GALLERY_IMAGES) {
      console.log('[PEAR] gallery capped at', MAX_GALLERY_IMAGES, 'of', urls.length, 'images');
      urls = urls.slice(0, MAX_GALLERY_IMAGES);
    }
    return urls;
  }

  /* ── Shopify product JSON - the authoritative gallery ─────────────────────────
     Every Shopify storefront (FOX included) serves the current product as JSON at
     <product-path>.js. It lists EVERY image at full resolution, in catalog order,
     with no lazy-loading, no placeholder pixels and no thumbnail suffixes - i.e. it
     sidesteps the entire class of DOM-scraping problems the selectors below exist to
     work around. Same-origin, so a console-injected widget can read it directly.

     Used as an ADDITIVE source, not a replacement: it only exists on Shopify product
     pages, and the DOM scrape still covers everything else (and quick-shop grids where
     the page path is not the product's). Fetched once at boot so a click never waits. */
  var _shopifyGallery = null;      // string[] once resolved, [] when unavailable

  function loadShopifyProductJSON() {
    if (_shopifyGallery) return Promise.resolve(_shopifyGallery);
    var path = w.location.pathname.split("?")[0].replace(/\/$/, "");
    if (path.indexOf("/products/") === -1) { _shopifyGallery = []; return Promise.resolve(_shopifyGallery); }
    return fetch(path + ".js", { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (p) {
        var imgs = [];
        var list = (p && p.images) || [];
        for (var i = 0; i < list.length; i++) {
          var u = absolutize(typeof list[i] === "string" ? list[i] : (list[i] && list[i].src));
          if (u && !isExcludedSrc(u)) imgs.push(upgradeImageUrl(u));
        }
        _shopifyGallery = imgs;
        console.log("[PEAR] Shopify product JSON:", imgs.length, "image(s) for", p && p.title);
        return imgs;
      })
      .catch(function (e) {
        console.log("[PEAR] Shopify product JSON unavailable (not a Shopify PDP?):", e && e.message);
        _shopifyGallery = [];
        return _shopifyGallery;
      });
  }

  /* ── COMBINED composite - built here, on the store page ───────────────────────
     Layout contract is IDENTICAL to createGarmentComposite() in fitting-room/app.js
     (front left, back right, height = max(h), width = frontW + backW + gutter, a
     divider centred in the gutter, centred FRONT/BACK labels). The two must stay in
     lockstep - they are separate bundles with no shared module system, the same way
     canonicalPhoto/canonicalImageUrl are already triplicated across this repo.

     CANVAS TAINTING is the reason this is not naive. Drawing a store CDN image via an
     <img> tag taints the canvas and makes toBlob()/toDataURL() throw SecurityError on
     most storefront CDNs. So the bytes are fetched through PEAR's own /api/img-proxy,
     which answers with Access-Control-Allow-Origin: * - a CORS-readable response
     produces an untainted canvas, and the proxy also solves the hotlink-blocking that
     defeats a direct CDN fetch from a third-party origin. */
  var COMPOSITE_MAX_W   = 2048;
  var COMPOSITE_DIVIDER = 4;
  var COMPOSITE_GUTTER  = 64;

  function proxied(url) {
    if (/^(data:|blob:)/i.test(url)) return url;
    return PEAR_BASE + "/api/img-proxy?url=" + encodeURIComponent(url);
  }

  /* Decoded bitmap with an untainted-canvas guarantee. Tries the proxy first, then the
     raw CDN - some CDNs are CORS-open and some block the proxy, so neither route alone
     is reliable across arbitrary stores. */
  function loadBitmapCORS(url) {
    function decode(u, mode) {
      return fetch(u, mode ? { mode: mode } : undefined)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then(function (b) {
          if (w.createImageBitmap) return w.createImageBitmap(b);
          // Safari <15 has no createImageBitmap: fall back to an object URL + <img>,
          // which is same-origin (blob:) and therefore also untainted.
          return new Promise(function (res, rej) {
            var img = new Image();
            var obj = URL.createObjectURL(b);
            img.onload = function () { URL.revokeObjectURL(obj); res(img); };
            img.onerror = function () { URL.revokeObjectURL(obj); rej(new Error("decode failed")); };
            img.src = obj;
          });
        });
    }
    if (/^(data:|blob:)/i.test(url)) return decode(url);
    return decode(proxied(url)).catch(function (e) {
      console.warn("[PEAR] composite: proxy fetch failed for", abbrevUrl(url), "-", e && e.message, "; trying the CDN directly");
      return decode(url, "cors");
    });
  }

  function drawCover(ctx, img, dx, dy, dw, dh) {
    var iw = img.width, ih = img.height;
    var scale = Math.max(dw / iw, dh / ih);
    var wpx = iw * scale, hpx = ih * scale;
    ctx.drawImage(img, dx + (dw - wpx) / 2, dy + (dh - hpx) / 2, wpx, hpx);
  }

  /* High-contrast marker box - the model reads these as the panel's identity, so they
     are deliberately loud: white plate, black border, black bold text. */
  function drawLabel(ctx, text, centerX, top, fontPx) {
    ctx.save();
    ctx.font = "800 " + fontPx + "px system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var padX = Math.round(fontPx * 0.5), padY = Math.round(fontPx * 0.32);
    var boxW = Math.round(ctx.measureText(text).width) + padX * 2;
    var boxH = fontPx + padY * 2;
    var x = Math.round(centerX - boxW / 2);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = Math.max(2, Math.round(fontPx * 0.06));
    ctx.fillRect(x, top, boxW, boxH);
    ctx.strokeRect(x, top, boxW, boxH);
    ctx.fillStyle = "#000000";
    ctx.fillText(text, x + boxW / 2, top + boxH / 2);
    ctx.restore();
  }

  /* Stitch FRONT + BACK into one labelled reference. Resolves to
     { url, layout } - a data URL (the form that survives postMessage to the fitting-room
     iframe) plus the panel geometry actually drawn - or { url: "" } on any failure, in
     which case the caller falls back to handing over the two URLs separately rather than
     going live with nothing.

     THE LAYOUT IS NOT DECORATION. The fitting room turns this image into a Decart prompt
     that asserts "LEFT PANEL = FRONT, RIGHT PANEL = BACK" and tells the model to read one
     named half. That assertion is about pixels drawn HERE, by a copy of the layout code
     that lives in a different bundle from the code making the claim. Reporting the
     geometry lets the consumer verify the contract instead of assuming it - if the panels
     ever swap, the console says so next to the prompt that got it wrong. */
  function createGarmentComposite(frontUrl, backUrl) {
    if (!frontUrl || !backUrl) return Promise.resolve({ url: "", layout: null });
    return Promise.all([loadBitmapCORS(frontUrl), loadBitmapCORS(backUrl)])
      .then(function (imgs) {
        var front = imgs[0], back = imgs[1];
        // Common height first, aspect preserved: two panels of different heights would
        // imply two differently-sized garments.
        var panelH = Math.max(front.height, back.height);
        var frontW = Math.round(front.width * (panelH / front.height));
        var backW  = Math.round(back.width  * (panelH / back.height));

        var totalW = frontW + backW + COMPOSITE_GUTTER;
        var scale  = Math.min(1, COMPOSITE_MAX_W / totalW);
        var W = Math.round(totalW * scale), H = Math.round(panelH * scale);
        var fW = Math.round(frontW * scale), bW = Math.round(backW * scale);
        var gut = Math.round(COMPOSITE_GUTTER * scale);

        var canvas = d.createElement("canvas");
        canvas.width = W; canvas.height = H;
        var ctx = canvas.getContext("2d");

        ctx.fillStyle = "#3a3a3a";      // neutral field - white reads as fabric on a packshot
        ctx.fillRect(0, 0, W, H);

        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, fW, H); ctx.clip();
        drawCover(ctx, front, 0, 0, fW, H);
        ctx.restore();

        var backX = fW + gut;
        ctx.save(); ctx.beginPath(); ctx.rect(backX, 0, bW, H); ctx.clip();
        drawCover(ctx, back, backX, 0, bW, H);
        ctx.restore();

        var dividerW = Math.max(2, Math.round(COMPOSITE_DIVIDER * scale));
        ctx.fillStyle = "#e8e8e8";
        ctx.fillRect(Math.round(fW + gut / 2 - dividerW / 2), 0, dividerW, H);

        var fontPx = Math.max(18, Math.round(W * 0.035));
        var labelY = Math.round(H * 0.035);
        drawLabel(ctx, "FRONT", Math.round(fW / 2), labelY, fontPx);
        drawLabel(ctx, "BACK",  Math.round(backX + bW / 2), labelY, fontPx);

        if (front.close) front.close();
        if (back.close) back.close();

        // toDataURL throws SecurityError on a tainted canvas - which is exactly what
        // the CORS-proxied fetch above prevents. Caught so a taint never breaks the
        // try-on; the caller falls back to the two-URL handover.
        var dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        console.log("[PEAR] COMBINED composite built: " + W + "×" + H +
          " · FRONT " + fW + "px | BACK " + bW + "px · " + Math.round(dataUrl.length / 1365) + "KB");
        return {
          url: dataUrl,
          /* The contract, as drawn. front_x < back_x is what makes "LEFT PANEL = FRONT"
             true; the fitting room asserts exactly that to Decart and warns if this says
             otherwise. divider_x is the vertical line the prompt calls the wall. */
          layout: {
            w: W, h: H,
            front_x: 0,     front_w: fW,
            back_x:  backX, back_w:  bW,
            divider_x: Math.round(fW + gut / 2)
          }
        };
      })
      .catch(function (e) {
        console.warn("[PEAR] createGarmentComposite failed:", e && e.message,
          "- falling back to separate front/back handover");
        return { url: "", layout: null };
      });
  }

  /* ── shared widget CSS (single removable style tag) ─────────────────────── */
  function injectStyles() {
    if (d.querySelector("style.pear-widget-styles")) return;
    var css =
      /* Styled to read as a native "Add to Cart" button - sits inline in the product
         form (no longer floated over the image), and CHANGE-5 sizing copies the real
         cart button's width/height/font-size/radius on top of this at inject time. */
      ".pear-widget-btn{" +
        "display:block;box-sizing:border-box;width:100%;margin-top:8px;" +
        "background:#000;color:#fff;border:none;border-radius:4px;" +
        "padding:14px 24px;font-size:14px;font-weight:600;letter-spacing:0.08em;" +
        "text-transform:uppercase;cursor:pointer;transition:background 0.2s;" +
        "font-family:inherit;line-height:1.2;" +
      "}" +
      ".pear-widget-btn:hover{background:#222;}" +
      /* Floating variant - used only when the page has no cart button AND no <h1>
         (see injectFallbackButton). z-index sits below the try-on overlay (999999). */
      ".pear-widget-btn-floating{" +
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
        "width:auto;min-width:220px;margin:0;z-index:999998;" +
        "box-shadow:0 6px 24px rgba(0,0,0,0.35);border-radius:999px;" +
      "}" +
      ".pear-widget-btn:disabled,.pear-widget-btn:disabled:hover{" +
        "background:#ccc;color:#666;cursor:not-allowed;" +
      "}" +
      ".pear-widget-overlay{" +
        "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.88);" +
        "display:flex;align-items:center;justify-content:center;" +
      "}" +
      ".pear-widget-frame{" +
        "width:min(480px,100vw);height:min(820px,100vh);border:none;" +
        "border-radius:16px;background:#000;" +
      "}" +
      ".pear-widget-close{" +
        "position:absolute;top:16px;right:16px;width:40px;height:40px;" +
        "border-radius:50%;background:rgba(255,255,255,0.15);color:#fff;" +
        "font-size:20px;border:none;cursor:pointer;line-height:40px;" +
        "padding:0;text-align:center;" +
      "}" +
      ".pear-widget-close:hover{background:rgba(255,255,255,0.25);}" +
      ".pear-widget-toast{" +
        "position:fixed;top:24px;left:50%;transform:translate(-50%,-12px);z-index:1000000;" +
        "background:#111;color:#fff;padding:12px 22px;border-radius:999px;" +
        "font-size:14px;font-weight:600;font-family:inherit;white-space:nowrap;" +
        "opacity:0;pointer-events:none;transition:opacity 0.25s,transform 0.25s;" +
      "}" +
      ".pear-widget-toast.show{opacity:1;transform:translate(-50%,0);}";
    var style = d.createElement("style");
    style.className = "pear-widget-styles";
    style.textContent = css;
    d.head.appendChild(style);
  }

  /* ── demo-gate button state ───────────────────────────────────────────────
     The fitting-room iframe (PEAR_BASE) reports "measurement spent" via
     postMessage rather than shared localStorage, since the host page and
     PEAR_BASE are generally different origins. Only wired at all when this
     embed opted into data-pear-demo-gate. Every PEAR button on the page is
     locked together - a multi-product page can have one per Add-to-Cart
     button, but the gate is one measurement for the whole visit, not per
     button. */
  function applyLockedButtonState(btn) {
    btn.disabled = true;
    btn.title = isHebrewPage()
      ? "כבר ביצעת את המדידה הווירטואלית שלך בדמו. תודה!"
      : "You've already used your one virtual fit in this demo. Thanks!";
    btn.textContent = isHebrewPage() ? "👗 נוסה" : "👗 TRIED";
  }

  function lockAllButtons() {
    var btns = d.querySelectorAll(".pear-widget-btn");
    for (var i = 0; i < btns.length; i++) applyLockedButtonState(btns[i]);
  }

  if (DEMO_GATE) {
    w.addEventListener("message", function (e) {
      /* Trust only messages from PEAR_BASE (the fitting-room origin) carrying
         our specific lock signal - never act on arbitrary postMessage traffic
         from other embeds/frames sharing the host page. */
      if (e.origin !== PEAR_BASE) return;
      if (!e.data || e.data.type !== "pear-demo-gate-locked") return;
      persistDemoGateLock();
      lockAllButtons();
    });
  }

  /* ── toast (Add-to-Cart confirmation/error) ───────────────────────────────
     Own z-index sits ABOVE the fitting-room overlay (999999) so it's visible
     while the modal is still open - the click that triggers it happens inside
     the iframe, before the shopper closes the modal. */
  var toastEl = null, toastTimer = 0;
  function showToast(msg) {
    injectStyles();
    if (!toastEl) {
      toastEl = d.createElement("div");
      toastEl.className = "pear-widget-toast";
      toastEl.setAttribute("role", "status");
      d.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    w.clearTimeout(toastTimer);
    toastTimer = w.setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  /* ── front/back classification (Gemini, via the PEAR server) ──────────────────
     Called on every PEAR button click - even a single-image product - so every
     visit contributes to the Supabase cache (garment_cache), not just the ones
     where the shopper reaches the multi-photo popup. Asks the server which
     images are the garment's front vs. back (POST /api/classify-images) instead
     of assuming images[0] is the front and images[1] the back. Cache-backed
     server-side, so repeat visits to the same product are instant. On any
     failure - network, timeout, missing Gemini key - the caller falls back to
     DOM order.

     PAYLOAD (v2 - back-view aware). Alongside the raw `images` gallery the widget now
     sends what its own DOM scrape concluded:
       front_image_url  - the scraped front (og:image / primary product image)
       back_image_url   - a rear photo the DOM POSITIVELY identified (filename/alt),
                          or "" when the page gave no such evidence
       synthesize_back  - true only in that "" case: permission for the server to
                          generate an inferred rear from the front (see /api/classify-
                          images' back-view resolution block). Never sent when a real
                          back exists, so a genuine rear photo is never overridden by
                          a generated one, and no generation is billed for a product
                          that already ships two views.
     RESPONSE: the legacy { results } array plus a resolved
     { front_image_url, back_image_url, back_source } pair. Older widget builds ignore
     the new fields; this build prefers them and falls back to resolveFrontBack(). */
  function classifyImages(urls, hint) {
    var endpoint = PEAR_BASE + "/api/classify-images";
    var scrapedBack = (hint && hint.back) || "";
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: urls,
        front_image_url: (hint && hint.front) || urls[0] || "",
        back_image_url: scrapedBack,
        synthesize_back: !scrapedBack,
        page_url: w.location ? w.location.href : "",
        store_key: STORE_KEY || undefined
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("classify-images HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      return {
        results: (data && data.results) || [],
        front: (data && data.front_image_url) || "",
        back: (data && data.back_image_url) || "",
        backSource: (data && data.back_source) || "none"
      };
    });
  }

  /* THE ROOT CAUSE of "back view renders as a plain/print-less garment": this used to
     fall back to urls[1] (the second gallery photo) as "the back" whenever NO image
     was actually classified "back" by Gemini. For an item whose gallery is entirely
     front-view photos (different angles/crops of the SAME front, e.g. a t-shirt with
     no back-of-garment product photo at all - a very common real case), that silently
     hands the SECOND FRONT PHOTO to the live session labeled as the back. It passes
     every fetch/decode/flatness check fine (it's a perfectly valid image, just the
     wrong content) and reaches Lucy with "this reference shows the BACK - do NOT
     render the front" - so the model suppresses the graphic it can actually see,
     producing exactly the blank/print-less back that was reported. Only trust an
     image Gemini actually called "back"; never guess from position. */
  function resolveFrontBack(urls, results) {
    var front, back;
    for (var i = 0; i < urls.length; i++) {
      if (results[i] === "front" && !front) front = urls[i];
      else if (results[i] === "back" && !back) back = urls[i];
    }
    return { front: front || urls[0], back: back };
  }

  /* Re-order the gallery so front images lead and back images follow - the
     fitting room's garment_url/garment_url_back and its automatic AI Combined
     pairing assume index 0/1 are front/back, which only holds once the classifier's results
     are folded in (raw DOM order is not reliable). Anything the classifier
     didn't call front/back keeps its relative order after those two. */
  function sortByFrontBack(urls, results) {
    var front = [], back = [], other = [];
    for (var i = 0; i < urls.length; i++) {
      if (results[i] === "front") front.push(urls[i]);
      else if (results[i] === "back") back.push(urls[i]);
      else other.push(urls[i]);
    }
    return front.concat(back, other);
  }

  /* ── STEP 3 - fullscreen modal with the fitting-room iframe ─────────────── */
  var activeOverlay = null;
  var activeIframe = null;
  var escHandler = null;

  function closeModal() {
    if (activeOverlay && activeOverlay.parentNode) {
      activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    activeIframe = null;
    if (escHandler) {
      d.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
  }

  function openModal(garment) {
    closeModal(); // never stack two modals

    /* A generated rear view is a data: URL - far past any browser's URL length limit,
       and it would be re-encoded into the iframe src for nothing. Those only ever
       travel via the PEAR_UPDATE_GARMENT postMessage correction (structured clone,
       no length limit); the query string carries http(s) URLs only. */
    var backParam = (garment.back && !/^data:/i.test(garment.back)) ? garment.back : "";

    var params =
      "garment_url=" + encodeURIComponent(garment.url) +
      "&garment_type=" + encodeURIComponent(garment.type) +
      "&garment_name=" + encodeURIComponent(garment.name) +
      (backParam ? "&garment_url_back=" + encodeURIComponent(backParam) : "") +
      /* Explicit v2 aliases - same values, named the way the API/product schema names
         them. parseHandoff() accepts either spelling, so an older fitting-room build
         still reads garment_url/garment_url_back above. */
      "&front_image_url=" + encodeURIComponent(garment.url) +
      (backParam ? "&back_image_url=" + encodeURIComponent(backParam) : "") +
      /* All gallery photos (each encoded, comma-joined) → the fitting room's
         automatic front/back pairing. Sent only when there's more than one distinct image. */
      (garment.images && garment.images.length > 1
        ? "&garment_images=" + garment.images.map(encodeURIComponent).join(",") : "") +
      (garment.variantId ? "&garment_variant_id=" + encodeURIComponent(garment.variantId) : "") +
      (COMPOSITE_PARAM ? "&composite=" + COMPOSITE_PARAM : "") +
      (REQUIRE_BOTH_VIEWS ? "&require_both_views=1" : "") +
      (DEMO_GATE ? "&demo_gate=1" : "") +
      (STORE_KEY ? "&pear_key=" + encodeURIComponent(STORE_KEY) : "") +
      /* Tells the fitting room to skip registration + apply the one-time lock -
         see the "demo mode" block above. Only ever set for the marketing-site
         embed; every other embed (main app, real merchants) omits it entirely.
         Independent of DEMO_GATE above - the two are separate, coexisting triggers. */
      (DEMO_MODE ? "&pear_demo=1" : "");
    var src = PEAR_BASE + "/fitting-room/?" + params;
    console.log("[PEAR widget] openModal() - iframe src:", src);

    var overlay = d.createElement("div");
    overlay.className = "pear-widget-overlay";

    var iframe = d.createElement("iframe");
    iframe.className = "pear-widget-frame";
    iframe.src = src;
    iframe.title = "PEAR virtual fitting room";
    /* the fitting room needs webcam access inside the cross-origin iframe */
    iframe.setAttribute("allow", "camera; microphone; fullscreen");
    /* Cross-origin iframes fire "load" even on a 404 response body (it's still a valid
       HTML document), so this can't distinguish 200 from 404 - but it confirms the
       browser at least reached PEAR_BASE and got SOME response back for `src`. */
    iframe.addEventListener("load", function () {
      console.log("[PEAR widget] fitting-room iframe fired 'load' for:", src);
    });
    iframe.addEventListener("error", function () {
      console.error("[PEAR widget] fitting-room iframe fired 'error' for:", src);
    });

    var close = d.createElement("button");
    close.className = "pear-widget-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", closeModal);

    /* close on a click on the dark backdrop (outside the iframe) */
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });

    escHandler = function (e) {
      if (e.key === "Escape") closeModal();
    };
    d.addEventListener("keydown", escHandler);

    overlay.appendChild(iframe);
    overlay.appendChild(close);
    d.body.appendChild(overlay);
    activeOverlay = overlay;
    activeIframe = iframe;
    return iframe;
  }

  /* ── STEP 2 - locate the store's Add-to-Cart button(s) ───────────────────────
     Three tiers, all combined and de-duped so EVERY cart button on the page is
     covered - a PDP has one, a collection / quick-shop grid has many:
       1. submit/add controls inside cart <form>s (Shopify's canonical markup),
       2. well-known Add-to-Cart selectors (Shopify / WooCommerce / generic themes),
       3. any <button> whose visible text reads like "add to cart" (EN + HE + buy-now). */
  var ATC_SELECTORS = [
    ".product-form__submit",
    ".btn-addtocart",
    ".single_add_to_cart_button",
    "#AddToCart",
    ".add-to-cart",
    '[data-button-action="add-to-cart"]'
  ].join(", ");
  var ATC_TEXTS = ["add to cart", "הוסף לסל", "הוסף לעגלה", "buy now", "קנה עכשיו"];

  function findAllAddToCartButtons() {
    var out = [];
    function add(b) { if (b && out.indexOf(b) === -1) out.push(b); }
    /* Priority 1 - the cart form's Add button. Shopify's canonical markup is
       button[name="add"] inside form[action="/cart/add"], so match that FIRST,
       then fall back to any other submit control in a cart form. */
    var forms = d.querySelectorAll('form[action*="/cart"]');
    for (var i = 0; i < forms.length; i++) {
      var addBtns = forms[i].querySelectorAll('button[name="add"]');
      for (var a = 0; a < addBtns.length; a++) add(addBtns[a]);
      var submitBtns = forms[i].querySelectorAll('button[type="submit"]');
      for (var f = 0; f < submitBtns.length; f++) add(submitBtns[f]);
    }
    /* Priority 2 - known Add-to-Cart selectors. */
    var known = d.querySelectorAll(ATC_SELECTORS);
    for (var s = 0; s < known.length; s++) add(known[s]);
    /* Priority 3 - button text heuristic. */
    var btns = d.querySelectorAll("button");
    for (var j = 0; j < btns.length; j++) {
      var t = (btns[j].textContent || "").trim().toLowerCase();
      if (!t) continue;
      for (var k = 0; k < ATC_TEXTS.length; k++) {
        if (t.indexOf(ATC_TEXTS[k].toLowerCase()) !== -1) { add(btns[j]); break; }
      }
    }
    return out;
  }

  /* CHANGE 1 - button label follows the page language: Hebrew/RTL storefronts get
     the Hebrew label, everything else the English one. Also drives the locked
     ("already measured") label, so both states speak the same language. */
  function isHebrewPage() {
    var docEl = d.documentElement;
    var lang   = (docEl && (docEl.lang || readAttr(docEl, "lang"))) || "";
    var dirEl  = (docEl && (docEl.dir  || readAttr(docEl, "dir")))  || "";
    var dirBody = (d.body && (d.body.dir || readAttr(d.body, "dir"))) || "";
    return lang.toLowerCase().indexOf("he") === 0 ||
           dirEl.toLowerCase() === "rtl" || dirBody.toLowerCase() === "rtl";
  }
  function getButtonText() {
    return isHebrewPage() ? "מדוד וירטואלית" : "VIRTUAL FIT";
  }

  /* ── per-button garment resolution ──────────────────────────────────────────
     On a multi-product page each Add-to-Cart belongs to its OWN product, so the
     PEAR button beside it must open THAT product - not one page-wide garment. Walk
     up from the cart button to the tightest ancestor that contains a product image
     (its card) and read the garment from there; if none is found within a few
     levels, fall back to the page's primary product image. */
  function pickProductImageIn(root) {
    var el = root.querySelector && root.querySelector(PRODUCT_IMG_SELECTORS);
    if (el) {
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (el && el.tagName === "IMG" && bestImageUrl(el)) return el;
    }
    /* else the largest non-decorative <img> inside this container (collection cards
       rarely use the PDP selectors above, so size is the reliable signal) */
    var imgs = (root.querySelectorAll && root.querySelectorAll("img")) || [];
    var best = null, bestArea = -1;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var src = bestImageUrl(im);
      if (!src) continue;
      var area = (im.naturalWidth || im.width || 1) * (im.naturalHeight || im.height || 1);
      if (area > bestArea) { bestArea = area; best = im; }
    }
    return best;
  }

  /* A human name for the card's product: image alt → a heading/titled link in the
     card → the page's <h1>. Feeds the modal label and keyword category detection. */
  function cardNameFor(root, img) {
    var alt = readAttr(img, "alt");
    if (alt && alt.trim()) return alt.trim();
    var h = root.querySelector && root.querySelector("h1, h2, h3, h4");
    if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
    var a = root.querySelector && root.querySelector("a[title]");
    var at = a && readAttr(a, "title");
    if (at && at.trim()) return at.trim();
    return getGarmentName();
  }

  /* Resolve the single most reliable product image on THIS page, tried in order:
       1. og:image meta tag - the most reliable signal there is, but PAGE-WIDE
          (it describes the page, not any one card), so it's only trustworthy
          on a genuine single-product page.
       2. Known single-product gallery containers (PRODUCT_GALLERY_SELECTORS) -
          same page-wide caveat as above.
     Returns "" when neither is present, so the caller falls back to the
     per-button ancestor walk-up, which is the only signal actually scoped to
     ONE product and so remains the resolver for collection/grid pages. */
  function resolvePrimaryProductImage() {
    var og = d.querySelector('meta[property="og:image"]');
    var ogUrl = og && og.content ? absolutize(og.content) : "";
    if (ogUrl && !isExcludedSrc(ogUrl)) return upgradeImageUrl(ogUrl);

    var el = d.querySelector(PRODUCT_GALLERY_SELECTORS);
    if (el) {
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (el && el.tagName === "IMG") {
        var src = bestImageUrl(el);
        if (src) return src;
      }
    }
    return "";
  }

  function findGarmentForButton(btn) {
    // Priority 1/2 - og:image, then known product-gallery containers.
    var primaryUrl = resolvePrimaryProductImage();
    if (primaryUrl) {
      var pgName = getGarmentName();
      var pgImages = collectGalleryImages(primaryUrl, d);
      console.log('[PEAR] final imgs array:', pgImages);
      return {
        url: primaryUrl,
        back: findGalleryBack(primaryUrl, d),
        images: pgImages,
        name: pgName,
        category: detectCategory(pgName),
        variantId: extractVariantId(btn),
        /* This garment came from PAGE-WIDE signals (og:image / the single-product
           gallery), so the page's own Shopify product JSON describes the same product
           and its images can be merged in at click time. NOT set on the ancestor
           walk-up path below, where the button belongs to one card among many and the
           page-level product would be a different garment entirely. */
        pageScoped: true
      };
    }

    // Priority 3 - ancestor walk-up (see pickProductImageIn/collectGalleryImages
    // header comments for how this is scoped and filtered).
    var node = btn.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      var img = pickProductImageIn(node);
      if (img) {
        var url = explicitAttr(img, "data-pear-front") || bestImageUrl(img);
        if (url && !isExcludedSrc(url)) {
          var name = cardNameFor(node, img);
          var cardImages = collectGalleryImages(url, node);
          console.log('[PEAR] final imgs array:', cardImages);
          return {
            url: url,
            back: explicitAttr(img, "data-pear-back") || findGalleryBack(url, node),
            images: cardImages,
            name: name,
            category: detectCategory(name),
            variantId: extractVariantId(btn)
          };
        }
      }
      node = node.parentElement;
    }
    /* Fallback - the page's primary product image (og:image → selectors → largest). */
    var primary = findProductImages()[0];
    if (primary && primary.url) {
      var pname = getGarmentName();
      var fallbackImages = collectGalleryImages(primary.url, d);
      console.log('[PEAR] final imgs array:', fallbackImages);
      return {
        url: primary.url, back: primary.back,
        images: fallbackImages,
        name: pname, category: detectCategory(pname),
        variantId: extractVariantId(btn)
      };
    }
    return null;
  }

  /* CHANGE 5 + CHANGE 3 - smart sizing: copy the real Add-to-Cart button's rendered
     box + type metrics so the PEAR button looks native, AND copy the exact vertical
     metrics (line-height + top/bottom padding) with box-sizing:border-box + display:
     block so the two buttons end up the SAME height on every theme. */
  function matchButtonToAddToCart(pearBtn, addToCartBtn) {
    try {
      var rect = addToCartBtn.getBoundingClientRect();
      var cs = w.getComputedStyle(addToCartBtn);
      /* Match the FULL cart-form/container width (not just the button) so the PEAR
         button spans the row cleanly below a Shopify qty-selector layout. */
      var form = addToCartBtn.closest ? addToCartBtn.closest("form") : null;
      var formWidth = form ? form.getBoundingClientRect().width : rect.width;
      if (formWidth) pearBtn.style.width  = formWidth + "px";
      if (rect.height) pearBtn.style.height = rect.height + "px";
      pearBtn.style.fontSize      = cs.fontSize;
      pearBtn.style.borderRadius  = cs.borderRadius;
      pearBtn.style.lineHeight    = cs.lineHeight;
      pearBtn.style.paddingTop    = cs.paddingTop;
      pearBtn.style.paddingBottom = cs.paddingBottom;
      /* Predictable box so the copied height + padding resolve identically; sit the
         button cleanly on its own line below the entire cart row. */
      pearBtn.style.boxSizing = "border-box";
      pearBtn.style.display    = "block";
      pearBtn.style.marginTop  = "10px";
    } catch (_) {}
  }

  /* Shopify quantity-selector fix: some themes (e.g. fox.co.il) put the Add-to-Cart
     button in a FLEX row next to a quantity stepper. Inserting the PEAR button right
     after the button then lands it INSIDE that row, skewing its height. So we look
     for the nearest ancestor row that also holds a quantity control and, when found,
     drop the PEAR button AFTER that whole row instead. */
  var QTY_SELECTORS = 'input[type="number"], .quantity, [class*="quantity"], [class*="qty"]';

  function findQtyRow(atcBtn) {
    var node = atcBtn.parentElement;
    for (var depth = 0; depth < 6 && node; depth++) {
      if (node.querySelector && node.querySelector(QTY_SELECTORS)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* ── STEP 2b - inject a native-looking try-on button next to each Add-to-Cart ──
     A PEAR button is inserted as the next sibling AFTER each cart button (or after the
     whole quantity row - see findQtyRow), wired to that button's own product. Idempotent:
     the cart button is stamped data-pear-injected="true" so repeat passes never double it. */
  function makePearButton(garment) {
    var btn = d.createElement("button");
    btn.className = "pear-widget-btn";
    btn.type = "button";
    btn.textContent = getButtonText();

    /* Demo-gate: render already-locked and skip wiring the click handler
       entirely when this browser has already spent its one measurement -
       covers a fresh page load after the lock was set on a previous visit. */
    if (DEMO_GATE && isDemoGateLockedLocally()) {
      applyLockedButtonState(btn);
      return btn;
    }

    // Demo-mode's separate one-time lock (coexists with demo-gate above - see the
    // "demo mode" block near the top of this file).
    if (isDemoLocked()) {
      /* Locked from a previous visit on this browser+origin - render disabled from
         the start; a genuinely disabled <button> never dispatches click events, so
         no extra guard is needed inside the handler below. */
      lockButton(btn);
    } else {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        /* Logic safeguard: block re-entry even if this button instance somehow
           still has a click listener attached after the demo-gate lock landed
           mid-session (e.g. the postMessage lock arrived between two rapid
           clicks). Disabled styling is UI; this is the actual gate. */
        if (DEMO_GATE && isDemoGateLockedLocally()) return;

        /* Open the fitting room INSTANTLY on DOM order (no waiting on the server) -
           the ~1-7s classify-images round trip used to block the modal from opening
           at all, which felt like the button was broken. Classification now runs in
           parallel and, if it disagrees with the DOM-order guess, silently corrects
           the live garment via postMessage once it resolves (see fitting-room/app.js's
           PEAR_UPDATE_GARMENT listener) - the shopper sees the room immediately and
           the front/back swap (if any) lands a moment later without a reconnect. */
        var imgs = (garment.images && garment.images.length) ? garment.images : [garment.url];
        /* Merge the Shopify product JSON gallery (prefetched at boot) - full-resolution,
           complete, and immune to every lazy-loading trick the DOM scrape has to work
           around. Only for a page-scoped garment: on a grid, the page product is not
           this card's product. De-duped canonically, so a photo already found in the
           DOM is not added twice under a different URL spelling. */
        if (garment.pageScoped && _shopifyGallery && _shopifyGallery.length) {
          var merged = imgs.slice();
          for (var si = 0; si < _shopifyGallery.length; si++) {
            var cand = _shopifyGallery[si], dup = false;
            for (var mi = 0; mi < merged.length; mi++) {
              if (samePhoto(cand, merged[mi])) { dup = true; break; }
            }
            if (!dup) merged.push(cand);
          }
          if (merged.length !== imgs.length) {
            console.log("[PEAR] merged Shopify JSON gallery:", imgs.length, "→", merged.length, "image(s)");
          }
          imgs = merged.slice(0, MAX_GALLERY_IMAGES);
        }
        /* The instant-open back. ONLY a DOM-identified rear photo (garment.back) is
           handed over here - never imgs[1]. Opening on the second gallery photo was a
           positional guess that, on a front-only gallery, labels a FRONT photo as the
           back and reaches Lucy as "this is the BACK, do NOT render the front" - the
           exact blank-back failure resolveFrontBack() below was written to stop. With
           no DOM evidence the room opens front-only and the classifier's verdict (or a
           generated rear) lands a moment later via PEAR_UPDATE_GARMENT. */
        var openBack = (garment.back && !samePhoto(garment.back, imgs[0])) ? garment.back : undefined;
        console.log("[PEAR widget] button click - " + imgs.length + " image(s) to classify:", imgs,
          "| DOM-identified back:", openBack || "(none - server will resolve/synthesize)");
        var openedIframe = openModal({
          url: imgs[0], type: garment.category, name: garment.name,
          back: openBack, images: imgs, variantId: garment.variantId
        });

        /* ── COMBINED pipeline ────────────────────────────────────────────────────
           The try-on engine receives ONE unified composite and nothing else. The
           sequence is fixed by a real dependency, not by preference:

             1. classify  - the gallery URLs go to /api/classify-images, which returns
                            WHICH image is the front and which is the back. This step
                            is unavoidable and cannot be replaced by the composite: you
                            cannot stitch a front|back pair before knowing which photo
                            is which. It exchanges URLs and a label - it is metadata,
                            not a render, and no individual image is ever handed to the
                            model as a try-on reference.
             2. synthesize - single-view product? the server generates the rear from
                            the front (synthesizeBackView) so step 3 always has a pair.
             3. combine   - both views stitched into ONE labelled canvas here.
             4. hand over - ONLY that composite goes to the fitting room / Decart.

           Sent by postMessage rather than the iframe URL because a composite data URL
           is far past any browser's URL length limit. */
        classifyImages(imgs, { front: imgs[0], back: openBack }).then(function (res) {
          var results = res.results;
          console.log("[PEAR widget] classify-images results (" + results.length + "):", results);
          var sorted = sortByFrontBack(imgs, results);
          var local = resolveFrontBack(imgs, results);
          /* Server-resolved pair wins when present: it folds in the DOM hints, the
             classifier, the per-product cache AND the generated-rear fallback
             (back_source tells which). Falls back to the local resolution for
             older/failing server builds. */
          var frontUrl = res.front || local.front;
          var backUrl  = res.back  || local.back;
          console.log("[PEAR widget] resolved front:", abbrevUrl(frontUrl));
          console.log("[PEAR widget] resolved back :", abbrevUrl(backUrl), "| source:", res.backSource);

          if (!backUrl) {
            /* No back anywhere - not in the DOM, not from the classifier, not in the
               per-product cache, and generation was declined or failed. There is
               nothing to combine, so hand over front-only; the fitting room's own
               inferred-rear clause covers the turn. */
            console.warn("[PEAR widget] no back view available - handing over FRONT-ONLY (no composite possible)");
          }

          return createGarmentComposite(frontUrl, backUrl).then(function (built) {
            var composite = built && built.url;
            if (composite) {
              console.log("[PEAR widget] COMBINED payload ready - handing the single composite to the try-on engine");
            }
            /* Only push a correction if this actually changes what the room is showing,
               and only into the SAME modal that triggered the call (the shopper may have
               closed it, or opened a different product, in the meantime). */
            if (activeIframe !== openedIframe) return;
            if (!composite && frontUrl === imgs[0] && backUrl === openBack) return;
            try {
              openedIframe.contentWindow.postMessage({
                type: "PEAR_UPDATE_GARMENT",
                garment_url: frontUrl,
                garment_back: backUrl || undefined,
                garment_back_source: res.backSource,
                /* The unified COMBINED reference. When present the fitting room uses
                   THIS as the model reference and skips its own stitching entirely -
                   the front/back URLs above remain only as provenance and as the
                   fallback if the composite is unusable. */
                garment_composite: composite || undefined,
                /* Panel geometry of that composite, so the fitting room can verify the
                   LEFT=FRONT / RIGHT=BACK contract it is about to assert to Decart rather
                   than trusting that two separately-bundled stitchers still agree. */
                garment_composite_layout: (composite && built.layout) || undefined,
                garment_images: sorted
              }, PEAR_BASE);
            } catch (_) {}
          });
        }).catch(function (err) {
          console.warn("[PEAR widget] combined pipeline failed, using DOM order as-is:", err && err.message);
        });
      });
    }
    injectedButtons.push(btn);
    return btn;
  }

  function injectAfterButton(atcBtn) {
    if (!atcBtn || !atcBtn.parentNode) return;
    if (atcBtn.getAttribute("data-pear-injected") === "true") return;   // already done
    var garment = findGarmentForButton(atcBtn);
    if (!garment || !garment.url) return;   // no garment for this button → skip
    injectStyles();
    var btn = makePearButton(garment);
    /* Drop AFTER the whole quantity row when the cart button shares a flex row with a
       quantity stepper; otherwise as the next sibling right after the button. */
    var qtyRow = findQtyRow(atcBtn);
    if (qtyRow && qtyRow.parentNode) {
      qtyRow.parentNode.insertBefore(btn, qtyRow.nextSibling);
    } else {
      atcBtn.parentNode.insertBefore(btn, atcBtn.nextSibling);
    }
    matchButtonToAddToCart(btn, atcBtn);
    atcBtn.setAttribute("data-pear-injected", "true");
  }

  /* No cart button anywhere (a bare PDP): inject a single button below the <h1>. */
  var _fallbackDone = false;
  function injectFallbackButton() {
    if (_fallbackDone) return;
    var primary = findProductImages()[0];
    if (!primary || !primary.url) return;
    _fallbackDone = true;
    injectStyles();
    var name = getGarmentName();
    var btn = makePearButton({
      url: primary.url, back: primary.back,
      images: collectGalleryImages(primary.url, d),
      name: name, category: detectCategory(name),
      variantId: extractVariantId(null)
    });
    var h1 = d.querySelector("h1");
    if (h1 && h1.parentNode) {
      h1.parentNode.insertBefore(btn, h1.nextSibling);
    } else {
      /* Last resort: a FLOATING button. Appending to <body> put a full-width block
         button at the very bottom of the document, where it is effectively invisible -
         which reads as "the widget did nothing" in exactly the console-injection
         testing this path exists for. Pinned bottom-centre instead, above the page's
         own chrome but below the try-on overlay's z-index. */
      btn.className += " pear-widget-btn-floating";
      d.body.appendChild(btn);
      console.log("[PEAR] no cart button and no <h1> - injected the FLOATING try-on button");
    }
  }

  /* Inject beside every cart button; fall back to the <h1> when there are none. */
  function injectAllButtons() {
    var btns = findAllAddToCartButtons();
    if (btns.length) {
      for (var i = 0; i < btns.length; i++) injectAfterButton(btns[i]);
    } else {
      injectFallbackButton();
    }
  }

  /* Global re-inject hook - invoked by the re-embed guard at the top of the IIFE
     when the widget script runs a second time on the same page. Clears the
     idempotency stamp so injectAllButtons() treats every Add-to-Cart button as
     unseen and reattaches a PEAR button next to it. */
  w.__pearReinject = function () {
    d.querySelectorAll("[data-pear-injected]").forEach(function (el) {
      el.removeAttribute("data-pear-injected");
    });
    injectAllButtons();
  };

  /* Fitting room (PEAR_BASE, a different origin) posts this the instant a visitor's
     FIRST look is saved, so every trigger button on this page locks immediately -
     no reload, no polling. Origin-checked against the same base the iframe itself
     was opened from, so only the actual PEAR fitting room can trigger this. */
  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.source !== "pear-fitting-room" || e.data.type !== "pear-demo-measured") return;
    setDemoLocked();
    lockAllDemoModeButtons();
  });

  /* Fitting room's "הוסף לסל" button posts this on click (see lux-interactions.js
     in fitting-room/) so the actual cart mutation happens on the HOST page, where
     the store's own cart endpoint lives. Tries Shopify's /cart/add.js first; on
     any failure (non-Shopify store, no variant id resolved, network error) falls
     back to telling the shopper to add it manually rather than guessing a URL. */
  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.type !== "PEAR_ADD_TO_CART") return;

    var variantId = e.data.variantId;
    if (!variantId) {
      showToast(isHebrewPage() ? "לא נמצאה גרסת מוצר להוספה לסל" : "Couldn't find a product variant to add");
      return;
    }
    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: variantId, quantity: 1 })
    }).then(function (r) {
      if (!r.ok) throw new Error("cart/add.js HTTP " + r.status);
      return r.json();
    }).then(function () {
      showToast(isHebrewPage() ? "הפריט נוסף לסל!" : "Added to cart!");
    }).catch(function (err) {
      console.warn("[PEAR widget] /cart/add.js failed:", err && err.message);
      showToast(isHebrewPage() ? "לא הצלחנו להוסיף לסל אוטומטית - נסה/י ידנית" : "Couldn't add to cart automatically - please add it manually");
    });
  });

  /* ── boot ───────────────────────────────────────────────────────────────── */
  /* Coalesce bursts of DOM mutations into a single injection pass per frame. */
  var _rafPending = false;
  var raf = w.requestAnimationFrame ? w.requestAnimationFrame.bind(w)
                                    : function (fn) { return w.setTimeout(fn, 16); };
  function scheduleInject() {
    if (_rafPending) return;
    _rafPending = true;
    raf(function () { _rafPending = false; injectAllButtons(); });
  }

  var _observing = false;
  function boot() {
    /* Kick the Shopify product JSON fetch at boot so a click never waits on it.
       Fire-and-forget: the result is merged opportunistically, and its absence
       (non-Shopify store, collection page) changes nothing. */
    loadShopifyProductJSON();
    injectAllButtons();
    /* Re-inject as the DOM changes - infinite scroll, tab/filter switches, quick-
       shop modals - so dynamically added products get their button too. Injection
       is idempotent (data-pear-injected), so the observer converges immediately. */
    if (!_observing && w.MutationObserver && d.body) {
      _observing = true;
      new w.MutationObserver(scheduleInject).observe(d.body, { childList: true, subtree: true });
    }
  }

  if (d.readyState === "loading") {
    d.addEventListener("DOMContentLoaded", function () {
      /* lazy-loaded imagery: give natural sizes a beat to resolve, then a
         second pass for anything the load event brings in */
      boot();
      w.addEventListener("load", boot);
    });
  } else {
    boot();
    if (d.readyState !== "complete") w.addEventListener("load", boot);
  }
})(window, document);
