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

  /* Garment-category keyword map (scanned against product name + page title).

     HEBREW ENTRIES ARE STEMS, NOT SURFACE FORMS, and that is the fix for "מכנס קצר רגל -
     FOX" being fitted as a shirt. Hebrew inflects by SUFFIX: מכנס / מכנסי / מכנסיים are
     one word in three forms, and חולצה / חולצת likewise. The old list held only the fully
     inflected "מכנסיים" and "חולצה", so a substring test missed every other form and fell
     through to the silent "tops" default below. Matching the stem matches all of them.

     ALSO FIXED HERE: ברמודה/שורטס were absent entirely; ג'ינס was listed only with the
     Hebrew geresh (U+05F3) while storefronts type an ASCII apostrophe (U+0027) just as
     often; and חצאית was filed under `dress`, which the fitting room read as a top
     because its only lower-body test was `type === "pants" || type === "bottoms"`.
     A skirt is lower-body, so it belongs here.

     SPLIT INTO he/en - "I listed a Shortsleeve Tee and it was fitted as pants". Hebrew and
     English used to share one flat array matched by plain indexOf, and "shorts" is a
     substring of "shortsleeve" with no space to stop it - a one-word title with no boundary
     between "short" and "sleeve" matched the pants list on "shorts" alone. English needs
     word boundaries for exactly the reason classifyGarmentTitle()'s hasEnglishWord() in
     fitting-room/app.js already does (§3 there: "\bshort\b would swallow 'short sleeve'" -
     this is the same trap one word over, with no space to save it). Hebrew stays substring/
     stem matching on purpose - \b sits at every Hebrew/Latin transition and nowhere useful
     inside a Hebrew phrase, so a word-boundary test cannot replace stem matching there.
     Mirrors GARMENT_CATEGORY_KEYWORDS's {he,en} split in app.js - keep the two in lockstep. */
  var CATEGORY_KEYWORDS = {
    pants: {
      he: ["מכנס", "ג'ינס", "ג׳ינס", "ברמודה", "שורטס", "שורט", "חצאי", "טייץ", "לגינ"],
      en: ["pants", "jeans", "trousers", "shorts", "leggings", "skirt", "bermuda",
           "chinos", "joggers", "sweatpants"]
    },
    shirt: {
      he: ["חולצ", "טישרט", "טי-שירט", "סווטשירט", "סוודר", "גופי", "טופ"],
      en: ["shirt", "tee", "top", "blouse", "sweater", "hoodie", "crop", "polo", "tank"]
    },
    dress: {
      he: ["שמלה"],
      en: ["dress", "jumpsuit", "romper"]
    },
    outerwear: {
      he: ["מעיל", "ז'קט", "ז׳קט", "ג׳קט", "ג'קט"],
      en: ["coat", "jacket", "blazer", "cardigan"]
    }
  };
  /* Mirrors hasHebrewStem()/hasEnglishWord() in fitting-room/app.js exactly, minus the
     arrow-function/const syntax this ES5 file avoids elsewhere. */
  function hasHebrewStem(haystack, stems) {
    for (var i = 0; i < stems.length; i++) {
      if (haystack.indexOf(stems[i]) !== -1) return true;
    }
    return false;
  }
  function hasEnglishWord(haystack, words) {
    for (var i = 0; i < words.length; i++) {
      if (new RegExp("\\b" + words[i].replace(/-/g, "\\-") + "\\b", "i").test(haystack)) return true;
    }
    return false;
  }
  /* NOT "tops". A guess that is indistinguishable from a verdict is what let every miss
     above reach the fitting room as a confident upper-body classification, suppressing
     the room's own (stronger) classifier. "unknown" is forwarded as-is and parseHandoff()
     treats it as absent, so the room classifies the title itself. */
  var DEFAULT_CATEGORY = "unknown";

  /* src substrings that mark an image as decorative, never a garment. WEAK evidence -
     see isExcludedSrc() for the three tiers that decide when this list gets a vote.
     Lockstep with EXCLUDE_IMG_SRC in scanner/scan-store.js (CLAUDE.md §3): the two had
     silently drifted ("blank"/"pixel" here, "banner"/"avatar" there), so the crawler and
     the widget disagreed about the SAME photo - the crawler wrote no garment_cache row
     for a product the widget was happy to open, and vice versa. Unified here. */
  var EXCLUDE_SRC = ["logo", "icon", "sprite", "placeholder", "blank", "pixel", "banner", "avatar"];

  /* Tier 2, shared so every "the store declared this" call site reads the same. */
  var DECLARED = { declared: true };

  /* Upper bound on the gallery forwarded to /api/classify-images - see the cap note
     in collectGalleryImages() for why an unbounded list is a latency problem. */
  var MAX_GALLERY_IMAGES = 8;

  var PRODUCT_IMG_SELECTORS = [
    ".product-image img",
    ".product__media img",
    ".woocommerce-product-gallery img",
    "[data-product-image]",
    ".product-photo img",
    /* Salesforce Commerce Cloud / SFRA (adidas.co.il). Copied from the gallery templates
       in the store's own shipped main.js - <div class="main_image"><img ... itemprop=
       "image"> for each main slide, inside "main-image desktop" - not inferred. The page
       matched NO selector here before, which is what sent findGarmentForButton()'s
       walk-up to the wishlist heart beside "Add to Bag" (see isVectorSrc). The
       underscore spelling only: "main-image" is generic enough to name a hero banner. */
    ".main_image img"
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
    'img[src*="cdn.shopify.com/s/files"]',
    // SFCC/SFRA (adidas.co.il, same source as PRODUCT_IMG_SELECTORS): every main slide
    // and thumbnail lives under .primary-images; .main_image / .thumb_image also cover a
    // theme that mounts the thumbnail strip outside it.
    ".primary-images img",
    ".main_image img",
    ".thumb_image img"
  ].join(", ");

  /* Known single-product gallery containers - checked BEFORE the ancestor
     walk-up in findGarmentForButton() (see resolvePrimaryProductImage). These
     are page-wide selectors, only reliable on a genuine single-product page. */
  var PRODUCT_GALLERY_SELECTORS = [
    ".product__media-list img",
    ".product-images img",
    ".product-single__photo",
    "[data-product-single-media-wrapper] img",
    ".product__media img",
    // SFCC/SFRA main slides - see PRODUCT_IMG_SELECTORS.
    ".primary-images .main_image img",
    ".main-image .main_image img"
  ].join(", ");

  /* Containers that hold OTHER products' photos on a product page: product tiles,
     recently-viewed / wishlist carousels, other colourways' swatch photos, the mini-cart.
     Verified against adidas.co.il's shipped main.js (SFCC/SFRA). A gallery scan whose
     root is the whole page (or the generic .slick-slide/.swiper-slide selectors) sweeps
     these in, and on a CDN whose filenames carry no numeric product id - SFCC's do not -
     extractProductId() has no signal to reject them with: a recommended product's photo
     then reaches the classifier as a candidate BACK view of this garment. See
     inForeignProductScope(). */
  var FOREIGN_PRODUCT_SCOPES = [
    ".product-tile", ".js-product-tile", ".carousel-recently-viewed", ".highlight-section",
    ".alternativeimage-list", ".colorthumbnail-section", ".minicart",
    ".carousel-wishlist-items", ".wishlist-items-list"
  ].join(", ");

  /* Page chrome and UI controls - never a garment photo, however big. adidas.co.il puts
     1200px mega-menu wallpapers inside <nav> (verified on the live page), which pass
     every src- and size-based check. header/footer are handled separately in
     isChromeImage() because a product heading block may legitimately be a <header>. */
  var CHROME_SCOPES = [
    "nav", "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[class*='wishlist']", "[class*='favorite']", "[class*='favourite']"
  ].join(", ");

  /* ── page metadata helpers ──────────────────────────────────────────────── */
  function getGarmentName() {
    var h1 = d.querySelector("h1");
    var name = h1 && h1.textContent ? h1.textContent.trim() : "";
    return name || d.title || "Garment";
  }

  /* "ג'ינס"/"denim" name a lower-body garment AND a material, so "ז'קט ג'ינס" (a denim
     JACKET) matches the pants list on the fabric alone. Returning "pants" there is not a
     near-miss: the widget's verdict is EXPLICIT, so it outranks the fitting room's own
     (smarter) classifier, and a denim jacket would be fitted as trousers. Mirrors
     classifyGarmentTitle()'s FABRIC_AMBIGUOUS pass in fitting-room/app.js - keep the two
     in step, since whichever one is wrong is the one that wins. */
  /* ── APOSTROPHE NORMALISATION - one Hebrew word, four codepoints ───────────────
     THE BUG THIS CLOSES: a jeans product whose CMS has smart quotes turned on ships
     "ג’ינס" with a U+2019 RIGHT SINGLE QUOTATION MARK, not the U+0027 apostrophe or
     the U+05F3 geresh spelled in the lists below. The word is identical to a reader
     and unequal to indexOf, so detectCategory() abstained, forwarded "unknown", and
     the fitting room fitted a pair of jeans against the adult LETTER chart.

     Normalising the HAYSTACK once means each list below keeps ONE spelling of each
     word instead of four - the geresh appears in ג'ינס, ז'קט, קפוצ'ון and more, so
     spelling out every variant multiplies every list and a later contributor adding
     one word has to remember all of them.

     KEPT IN LOCKSTEP WITH _normApos() IN fitting-room/app.js - see CLAUDE.md §3, and
     note which way that lockstep cuts: this widget's category verdict is EXPLICIT and
     therefore OUTRANKS the room's own classifier, so a miss HERE cannot be fixed
     room-side. */
  function normApos(s) {
    return String(s == null ? "" : s)
      .replace(/[\u02BC\u05F3\u2018\u2019\u2032]/g, "'")
      .replace(/[\u05F4\u201C\u201D\u2033]/g, '"')
      .toLowerCase();
  }

  /* Already apostrophe-normalised - these are only ever matched against normApos()
     output, so the U+05F3 spelling that used to sit beside the ASCII one is gone
     rather than dead. */
  var FABRIC_AMBIGUOUS = ["ג'ינס", "jeans", "denim"];

  function matchCategory(haystack) {
    for (var cat in CATEGORY_KEYWORDS) {
      var kw = CATEGORY_KEYWORDS[cat];
      if (hasHebrewStem(haystack, kw.he) || hasEnglishWord(haystack, kw.en)) return cat;
    }
    return null;
  }

  function detectCategory(name) {
    /* normApos() rather than toLowerCase() - it lower-cases too, and folds every
       apostrophe/geresh variant onto ASCII so the keyword lists need one spelling of
       each word. See normApos() above for the report this closes. */
    var haystack = normApos((name || "") + " " + (d.title || ""));
    var hit = matchCategory(haystack);
    /* Only re-test when the hit came from the pants list AND a fabric word is present -
       so "מכנס ג'ינס" (real lower-body evidence) is untouched, while "ז'קט ג'ינס" falls
       through to the garment noun that actually names the product. */
    if (hit === "pants") {
      var stripped = haystack;
      for (var f = 0; f < FABRIC_AMBIGUOUS.length; f++) {
        stripped = stripped.split(FABRIC_AMBIGUOUS[f]).join(" ");
      }
      if (stripped !== haystack) {
        var reHit = matchCategory(stripped);
        if (reHit && reHit !== "pants") return reHit;
        if (!reHit) return DEFAULT_CATEGORY;   // the fabric WAS the only evidence
      }
    }
    if (hit) return hit;
    return DEFAULT_CATEGORY;
  }

  /* Is this URL decorative rather than a garment photo?

     THE BUG THIS CLOSES: this was a blanket substring test over EXCLUDE_SRC, applied
     identically to every source - including images the STORE ITSELF declared as the
     product. adidas ships an "Icon" apparel line, so `icon-8-tee.jpg` was refused; so
     were `iconic-oversized-hoodie.jpg` and `adicolor-logo-tee.jpg` ("Logo Tee" is an
     industry staple, not chrome). On a PDP whose JSON-LD declared only such photos the
     widget ended up with NOTHING - the same dead end as the wishlist-heart bug the list
     was written for, reached from the opposite direction.

     A filename substring is the weakest signal here, so it only decides when nothing
     better is available. Three tiers, strongest first:

       1. SVG - refused ALWAYS, at every tier, ctx or no ctx. Not a heuristic: Gemini
          cannot classify a vector and the try-on engine cannot read one, so this is a
          capability limit. `ctx.declared` must never reach past it.
       2. ctx.declared - the store named this image AS the product: JSON-LD
          Product.image, its own product API (Shopify /products/x.js), the theme's
          product-gallery selectors, itemprop="image". A substring in the filename does
          not outrank the store's own declaration, so the keyword list is skipped.
       3. everything else - generic DOM sweeps, the ancestor walk-up, thumbnails, an
          uncorroborated og:image. The keyword list applies, with one escape: a token
          that also appears in the PRODUCT'S OWN NAME, on a file that independently
          echoes that name, is explained by the product rather than by chrome.

          BOTH halves are required, and the second is the one that matters. "Icon 8 Tee"
          contains "icon", so a bare name test would have let `cart-icon.png` through on
          that page too - the wishlist-heart failure again, wearing the fix as a
          disguise. So the FILENAME must also carry a word from the product's name that
          is not itself the blacklisted token: `icon-8-tee.jpg` carries "tee",
          `cart-icon.png` carries nothing. See nameEchoesProduct().

     Note what tier 3 does NOT do: it never blocks something the name fails to explain
     that would otherwise have passed. It can only ever RELAX, so no page that worked
     before can stop working because of it (CLAUDE.md §2.5 - never block on ambiguity).

     A one-argument call is exactly the old behaviour, which is what every heuristic
     caller still wants. Lockstep with isExcludedSrc() in scanner/scan-store.js (§3). */
  function isExcludedSrc(src, ctx) {
    var s = String(src || "").toLowerCase();   // coerced like isVectorSrc - a non-string must not throw
    if (isVectorSrc(s)) return true;                       // tier 1 - never bypassed
    if (ctx && ctx.declared) return false;                 // tier 2 - the store's own verdict
    var name = ctx && ctx.name ? String(ctx.name).toLowerCase() : "";
    for (var i = 0; i < EXCLUDE_SRC.length; i++) {
      if (s.indexOf(EXCLUDE_SRC[i]) === -1) continue;
      if (name && name.indexOf(EXCLUDE_SRC[i]) !== -1 && nameEchoesProduct(s, name)) continue;
      return true;
    }
    return false;
  }

  /* Does this file NAME itself after the product? True when the last path segment
     carries a word from the product's name that is not itself a blacklist token - the
     independent corroboration tier 3 needs before it forgives a keyword.
       "Icon 8 Tee"  + .../icon-8-tee.jpg  → "tee" echoes      → forgiven
       "Icon 8 Tee"  + .../cart-icon.png   → nothing echoes    → still chrome
     Matched on the LAST path segment only: a store hosted at tee-shop.com would
     otherwise "echo" on every image it serves. Words shorter than 3 characters are
     ignored - "8" would match the 8 in a CDN transform like w_1880 - and so are words
     that themselves contain a blacklist token, or "iconic" would forgive "icon" on its
     own and we would be back to a bare substring test. */
  function nameEchoesProduct(url, name) {
    var file = String(url).split(/[?#]/)[0];
    file = file.slice(file.lastIndexOf("/") + 1);
    if (!file) return false;
    var words = name.split(/[^0-9a-z֐-׿]+/);
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word || word.length < 3) continue;
      var tainted = false;
      for (var j = 0; j < EXCLUDE_SRC.length; j++) {
        if (word.indexOf(EXCLUDE_SRC[j]) !== -1) { tainted = true; break; }
      }
      if (!tainted && file.indexOf(word) !== -1) return true;
    }
    return false;
  }

  /* Vector graphics are UI, never a garment photo: icons, arrows, brand marks and - the
     case that shipped - wishlist hearts. No storefront publishes a product photo as SVG,
     and neither the classifier (Gemini) nor the try-on engine can read one.
     THE BUG THIS CLOSES (adidas.co.il, Salesforce Commerce Cloud): no product selector
     matched the page, so findGarmentForButton()'s walk-up stopped at the tightest
     ancestor of "Add to Bag" holding any <img> - the wishlist row, whose only image was
     heart-empty.svg. Nothing in EXCLUDE_SRC names a heart, so the heart shipped as the
     garment: the fitting room opened on it, /api/classify-images could not classify it
     (so garment_cache never got a row for the product), and try-on was blocked.
     Tested on the PATH only - a raster photo whose query string mentions ".svg" is kept. */
  function isVectorSrc(s) {
    s = String(s || "");
    return /^data:image\/svg/i.test(s) || /\.svgz?$/i.test(s.split(/[?#]/)[0]);
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
     "url 1x, url 2x"). A bare, descriptor-less single URL is returned as-is.

     THE BUG THIS CLOSES: this used to `value.split(",")`, which is NOT how a srcset is
     parsed and tears apart every CDN that puts a comma INSIDE the URL. adidas
     (assets.adidas.com) encodes its transform as ONE comma-joined path segment -
     "/images/w_1880,f_auto,q_auto/<hash>/tee.jpg" - so the comma split produced:
        "https://assets.adidas.com/images/w_940"  → absolute but truncated → HTTP 404
        "f_auto"                                  → junk
        "q_auto/<hash>/tee.jpg 940w"              → RELATIVE, so absolutize() resolved
                                                    it against the STORE page → HTTP 404
     and whichever fragment happened to carry the "940w"/"1880w" descriptor won on
     weight. Those are the DevTools 404s on "w_940" / "w_1880"; the same mangled URL
     sent through /api/img-proxy came back 502, because the proxy reported the upstream
     404 as a gateway error. Cloudinary, imgix and Contentful all build transform URLs
     with commas the same way, so this was never adidas-specific - it silently broke
     the gallery scrape on every one of them.

     The HTML spec separates candidates on WHITESPACE, not on commas: a candidate is an
     unbroken non-whitespace run (the URL - commas and all), optionally followed by a
     descriptor, and the comma that ends a candidate comes AFTER the descriptor, or is
     left trailing on the URL when there is none. That is what this implements, so
     "a.jpg,b.jpg" (no space) stays one URL exactly as a browser would read it. */
  function largestFromSrcset(value) {
    if (!value) return "";
    var s = String(value), n = s.length, i = 0;
    var bestUrl = "", bestWeight = -1;
    while (i < n) {
      // Leading whitespace, plus the comma(s) that closed the previous candidate.
      while (i < n && /[\s,]/.test(s.charAt(i))) i++;
      if (i >= n) break;
      // The URL: everything up to the next whitespace. Commas inside it are KEPT.
      var start = i;
      while (i < n && !/\s/.test(s.charAt(i))) i++;
      var url = s.slice(start, i), descriptor = "";
      if (/,$/.test(url)) {
        url = url.replace(/,+$/, "");          // trailing comma ends a descriptor-less candidate
      } else {
        while (i < n && /\s/.test(s.charAt(i))) i++;
        var dStart = i;
        while (i < n && s.charAt(i) !== ",") i++;
        descriptor = s.slice(dStart, i).trim();
        i++;                                   // consume the separating comma
      }
      if (!url) continue;
      var d = descriptor.split(/\s+/)[0] || "";
      var weight = 0;
      if (/^[\d.]+w$/i.test(d))      weight = parseFloat(d);
      else if (/^[\d.]+x$/i.test(d)) weight = parseFloat(d) * 1000;  // 2x ranks above any plain width
      if (weight > bestWeight) { bestWeight = weight; bestUrl = url; }
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

  /* ── CDN transforms encoded as a PATH SEGMENT ────────────────────────────────
     Cloudinary-style CDNs put the rendered size in the PATH, not the query string.
     assets.adidas.com serves every gallery photo that way:
        /images/w_280,h_280,f_auto,q_auto:sensitive/<hash>/tee.jpg   ← thumbnail
        /images/w_1880,f_auto,q_auto/<hash>/tee.jpg                  ← zoom slide
     Those are ONE photograph. PRESENTATION_PARAMS below only strips QUERY params, so
     the two spellings canonicalised DIFFERENTLY and sailed through every "is the back
     really a different image" test - the §2.2 failure that binds the FRONT photo as
     the back reference and duplicates the chest print onto the back view. It also
     split one photo across several garment_cache rows that could then disagree about
     front vs back.

     Dropping the segment is also a real resolution upgrade: the CDN serves the full
     master asset when no transform is present (verified against assets.adidas.com -
     976KB original vs 86KB at w_1880), the same trick the SFCC sw/sh/sm strip relies on.

     Deliberately NARROW, because a wrong match here would collapse two DIFFERENT
     photos into one, which is worse than the bug it fixes. A segment is dropped only
     when every comma-separated token is "<short alphabetic key>_<value>" and at least
     one key is a known sizing/format key - and never the LAST segment, which is the
     filename ("w_940.jpg" is a file, not a transform):
        w_940,f_auto,q_auto → dropped     en_us       → kept (key "en" is not a transform)
        w_1880              → dropped     abc123_9366 → kept (key contains digits)
        f_auto              → kept (format alone is not a size)
        dw1a2b3c4d          → kept (no underscore at all)
     Lockstep with canonicalImageUrl() in fitting-room/app.js, server.js and
     scanner/scan-store.js (CLAUDE.md §3) - the same rules, defined inside the function
     that uses them in all four copies so a sliced-out block stays self-contained. */

  /* Query-string params known to be presentation/cache concerns, never asset identity.
     Mirrors PRESENTATION_PARAMS in fitting-room/app.js's canonicalImageUrl() - keep the
     two in lockstep. canonicalPhoto() below strips ONLY these; every other param is kept,
     because a store that serves distinct photos as img.php?asset=front / ?asset=back has
     its ENTIRE identity in the query string, and a canonicaliser that discards the whole
     thing collapses a real front/back pair into one "duplicate" entry. */
  var PRESENTATION_PARAMS = {
    width: 1, height: 1, w: 1, h: 1, size: 1, quality: 1, q: 1, dpr: 1, format: 1, fm: 1,
    crop: 1, fit: 1, scale: 1, v: 1, ver: 1, version: 1, t: 1, cache: 1, _: 1,
    // Salesforce Commerce Cloud Dynamic Imaging (.../dw/image/v2/...): box, scale mode,
    // output format, letterbox colour. adidas.co.il serves every gallery photo through
    // it; the thumbnail and the zoom slide of one photo differ ONLY in these.
    sw: 1, sh: 1, sm: 1, sfrm: 1, bgcolor: 1
  };

  function upgradeImageUrl(url) {
    var CDN_TRANSFORM_KEY_RE = /^(?:w|h|c|q|f|dpr|ar|g|e|b|o|fl|bo|co|cs|r)$/;
    function isCdnTransformSegment(seg) {
      if (!seg || seg.indexOf("_") === -1) return false;
      var tokens = seg.split(","), sizing = false;
      for (var i = 0; i < tokens.length; i++) {
        var m = /^([a-z]{1,3})_([a-z0-9:.%*+-]+)$/i.exec(tokens[i]);
        if (!m) return false;
        var key = m[1].toLowerCase();
        if (!CDN_TRANSFORM_KEY_RE.test(key)) return false;
        if (/^(?:w|h|c|dpr)$/.test(key)) sizing = true;
      }
      return sizing || tokens.length > 1;
    }
    /* Accepts a full URL or a bare pathname; query/hash are split off untouched so a
       transform-looking token in a query string is never mistaken for a path segment. */
    function stripCdnTransformPath(u2) {
      var m = /^([^?#]*)([\s\S]*)$/.exec(String(u2 || ""));
      var parts = m[1].split("/"), kept = [];
      for (var i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && isCdnTransformSegment(parts[i])) continue;
        kept.push(parts[i]);
      }
      return kept.join("/") + m[2];
    }
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
    /* SFCC Dynamic Imaging: sw/sh are the rendered box and sm its scale mode; without them
       the endpoint serves the original catalog asset. Otherwise the thumbnail strip's
       ?sw=100 copy of the back photo reaches the model at 100px. Scoped to the DIS path
       so another store's own sw= is never touched, and removed without consuming the
       delimiter so adjacent params all go in one pass. */
    if (/\/dw\/image\/v2\//i.test(out)) {
      out = out.replace(/([?&])(?:sw|sh|sm)=[^&#]*/gi, "$1")
               .replace(/([?&])&+/g, "$1")
               .replace(/[?&]+(?=#|$)/, "");
    }
    /* Cloudinary-style transform baked into the PATH (assets.adidas.com and friends) -
       dropping it yields the master asset, so it upgrades and canonicalises in one go. */
    out = stripCdnTransformPath(out);
    return out;
  }

  /* Every URL an <img>/<source>/<a> element could be hiding, best-first, absolute
     and resolution-upgraded. */
  /* `ctx` is the TRUST TIER this element was found at, forwarded to isExcludedSrc():
     `{ declared: true }` when the store named it as the product (gallery selectors,
     itemprop="image", JSON-LD, its own product API), and otherwise the page's product
     name so a keyword the product itself explains does not reject its photo. Omitted =
     tier 3 with the name filled in, which is what every heuristic caller wants. */
  function imageUrlsFrom(el, ctx) {
    var out = [];
    var scope = ctx || { name: productNameHint() };
    function push(u) {
      u = absolutize(u);
      if (!u || isPlaceholderSrc(u) || isExcludedSrc(u, scope)) return;
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
  function bestImageUrl(el, ctx) {
    var urls = imageUrlsFrom(el, ctx);
    return urls.length ? urls[0] : "";
  }

  /* The product's own name, for isExcludedSrc()'s tier-3 corroboration. Memoised per
     page URL - imageUrlsFrom() runs over every <img> in a sweep and the name cannot
     change without a navigation, which updates the key. Deliberately NOT read from
     JSON-LD: those images are already tier 2 (declared), and reaching into the JSON-LD
     reader from here would re-enter isExcludedSrc through its own addImage(). */
  var _nameMemo = { key: null, name: "" };
  function productNameHint() {
    var key = (w.location && w.location.href) || "";
    if (key !== _nameMemo.key) _nameMemo = { key: key, name: getGarmentName() };
    return _nameMemo.name;
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
        if (!u || isPlaceholderSrc(u) || isExcludedSrc(u, { name: productNameHint() })) continue;
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
     the back. upgradeImageUrl() already strips the size markers baked into the FILENAME
     (the _800x.jpg / -300x300.jpg cases); this function's own job is the rest of the
     identity - protocol, host case, hash, and the QUERY STRING.
     Mirrors canonicalImageUrl() in fitting-room/app.js - keep the two in lockstep.

     WAS `.split("?")[0]` - dropped the ENTIRE query string. That is too LOOSE for a store
     whose photo identity lives IN the query string (img.php?asset=front vs ?asset=back):
     both collapsed to the same bare path and a real back photo read as a duplicate of the
     front. It was also too TIGHT in the other direction - it never normalised protocol or
     stripped the hash, so http-vs-https or a #zoom fragment on the SAME photo compared as
     different. Fixed the same way app.js's canonicalImageUrl() is: parse the URL, keep
     ONLY the query params known to be presentation/cache (PRESENTATION_PARAMS above), drop
     everything else including a param this file has never seen before - an unknown param
     is far more likely to be part of the asset's identity than a new presentation concern
     nobody wrote a name for yet. */
  function canonicalPhoto(u, depth) {
    if (!u) return "";
    if (/^(?:data|blob):/i.test(u)) return u;
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
    var upgraded = upgradeImageUrl(u);
    try {
      var parsed = new URL(upgraded);
      parsed.protocol = "https:";               // http/https of the same asset are the same asset
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.hash = "";
      var keys = [];
      parsed.searchParams.forEach(function (_v, k) { keys.push(k); });
      for (var i = 0; i < keys.length; i++) {
        if (Object.prototype.hasOwnProperty.call(PRESENTATION_PARAMS, keys[i].toLowerCase())) {
          parsed.searchParams.delete(keys[i]);
        }
      }
      return parsed.toString().toLowerCase();
    } catch (_) {
      return upgraded.split("?")[0].toLowerCase();   // unparseable - fall back to the bare path
    }
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
    /* SFCC paths carry a per-asset cache segment ("/dw1a2b3c4d/") - a hex hash, not an
       id, that can hold a 6+ digit run by chance. Two photos of ONE product would then
       "disagree" on an id neither has and the back photo would be rejected as another
       product's. Removed before the scan. */
    var path = url.split("?")[0].replace(/\/dw[0-9a-f]{8}(?=\/)/gi, "");
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

  /* ── is this <img> a product photo at all? ─────────────────────────────────────
     The heuristic paths (the largest-image fallbacks, the itemprop tier) used to accept
     ANY <img> that had a URL - on a storefront the selectors do not know, that is
     whatever sits nearest the cart button or is biggest on the page: a wishlist heart, a
     payment badge, a mega-menu wallpaper. Three independent rejections below, each only
     on evidence. The targeted selector lists are NOT gated by them - they name product
     galleries, and some legitimately sit inside <button>s (thumbnail sliders). */

  /* 1. Page chrome / UI controls: CHROME_SCOPES, an element the theme itself classes as
        an icon or logo, or a site <header>/<footer>. header/footer count only outside
        <main>/<article> - a product heading block may be a <header>. */
  function isChromeImage(el) {
    if (!el || !el.closest) return false;
    if (/(?:^|\s)(?:icon|logo)(?:\s|$)/i.test(readAttr(el, "class"))) return true;
    if (el.closest(CHROME_SCOPES)) return true;
    var hf = el.closest("header, footer");
    return !!hf && !hf.closest("main, article, [role='main']");
  }

  /* 2. Another product's photo: FOREIGN_PRODUCT_SCOPES nested INSIDE the scan root. A
        scope that contains the root is this product's own card (the grid walk-up case,
        where the root is the tile itself), so it never counts against it. */
  function inForeignProductScope(el, root) {
    var f = el && el.closest ? el.closest(FOREIGN_PRODUCT_SCOPES) : null;
    return !!f && !(root && root.nodeType === 1 && f.contains(root));
  }

  /* 3. A glyph we can SEE is glyph-sized: the element is displaying exactly the URL we
        would ship (no upgrade rewrote it) and the decoded bitmap is under 100px both
        ways. A lazy slide is never judged - its decoded src is the 1x1 placeholder,
        which says nothing about the photo in its data-src - and neither is a thumbnail
        whose URL was upgraded to the full asset. A raw string compare ON PURPOSE, not
        samePhoto(): a 100px thumbnail and its original ARE the same photo, but only the
        exact URL on screen says anything about the size of what would ship. This is a
        size question, never a front/back identity decision. */
  function isKnownTinyImage(el, url) {
    if (!el || !el.complete || !el.naturalWidth || !url) return false;
    if (absolutize(el.currentSrc || el.src || "") !== url) return false;
    return el.naturalWidth < 100 && el.naturalHeight < 100;
  }

  /* The gate every heuristic candidate passes: a usable URL and none of the above. */
  function isProductPhotoCandidate(el, root, ctx) {
    var u = bestImageUrl(el, ctx);
    return !!u && !isChromeImage(el) && !inForeignProductScope(el, root) && !isKnownTinyImage(el, u);
  }

  /* ── schema.org Product markup - the platform-agnostic tier ─────────────────────
     Every major commerce platform emits its product photos in one standard shape,
     because Google Shopping requires it: JSON-LD (<script type="application/ld+json">,
     @type Product, possibly under @graph / mainEntity) and microdata (itemprop="image",
     which SFCC/SFRA puts on every gallery <img> - verified in adidas.co.il's own
     templates). A selector list has to be re-learned per theme and never catches up;
     this does not. Only Product-typed nodes are read: an Organization/WebSite node's
     image IS the store logo - the failure this exists to prevent.

     Trusted ONLY when the page describes exactly one product (counted by name/sku, so a
     review app repeating the theme's Product block is still one). A collection page can
     emit one Product per card, and a page-wide "product image" there would open every
     card's try-on on the first card's photo - the per-button walk-up stays the resolver
     for grids. Memoised per page URL + script text lengths: injection re-runs on every
     DOM mutation burst, and re-parsing a large JSON-LD block per burst is pure waste. */
  var PRODUCT_LD_TYPE_RE = /^(?:Product|ProductGroup|IndividualProduct|ProductModel)$/;
  var _ldMemo = { key: null, urls: [] };
  function jsonLdProductImages() {
    var scripts = d.querySelectorAll('script[type="application/ld+json"]');
    var key = (w.location && w.location.href) + "|" + scripts.length;
    for (var k = 0; k < scripts.length; k++) key += ":" + (scripts[k].textContent || "").length;
    if (key === _ldMemo.key) return _ldMemo.urls;
    var urls = [], keys = [], ids = [], anon = 0;
    function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
    function isProduct(n) {
      var t = isArr(n["@type"]) ? n["@type"] : [n["@type"]];
      for (var i = 0; i < t.length; i++) {
        // "Product", "schema:Product" and "https://schema.org/Product" are all Product
        if (typeof t[i] === "string" && PRODUCT_LD_TYPE_RE.test(t[i].replace(/^.*[\/:#]/, ""))) return true;
      }
      return false;
    }
    function addImage(v) {
      if (!v) return;
      if (isArr(v)) { for (var i = 0; i < v.length; i++) addImage(v[i]); return; }
      if (typeof v === "object") { addImage(v.contentUrl || v.url); return; }
      if (typeof v !== "string") return;
      var u = absolutize(v);
      /* JSON-LD Product.image IS the store naming its product photo - tier 2. */
      if (!u || isPlaceholderSrc(u) || isExcludedSrc(u, { declared: true })) return;
      u = upgradeImageUrl(u);
      var key = canonicalPhoto(u);          // once per URL - a long image list stays linear
      if (keys.indexOf(key) !== -1) return;
      keys.push(key);
      urls.push(u);
    }
    function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > 5) return;
      if (isArr(n)) { for (var i = 0; i < n.length; i++) walk(n[i], depth + 1); return; }
      if (isProduct(n)) {
        var id = String(n.name || n.sku || n.productID || n["@id"] || "").trim().toLowerCase() || ("#" + anon++);
        if (ids.indexOf(id) === -1) ids.push(id);
        addImage(n.image);
        return;   // not into offers/hasVariant - those carry other colourways' photos
      }
      if (n["@graph"]) walk(n["@graph"], depth + 1);
      if (n.mainEntity) walk(n.mainEntity, depth + 1);
    }
    for (var s = 0; s < scripts.length; s++) {
      var data = null;
      try { data = JSON.parse(scripts[s].textContent || ""); } catch (_) { continue; }
      walk(data, 0);
    }
    if (ids.length > 1) {
      console.log("[PEAR] JSON-LD describes", ids.length, "products - not a single-product page; its images are not used");
    }
    _ldMemo = { key: key, urls: ids.length === 1 ? urls : [] };
    return _ldMemo.urls;
  }

  /* samePhoto() plus one looser tier, used ONLY by the og:image cross-check: the same
     filename under a different host/path (a store's own domain vs its CDN hostname -
     Shopify serves one file under both). Loosening here can only KEEP an og:image the
     check would otherwise drop, i.e. it errs toward the behaviour before the check
     existed. Short names ("1.jpg", "image.jpg") are too generic to vouch for anything. */
  function sameAsset(a, b) {
    if (samePhoto(a, b)) return true;
    var fa = fileNameOf(canonicalPhoto(a)), fb = fileNameOf(canonicalPhoto(b));
    return !!fa && fa === fb && fa.replace(/\.[a-z0-9]+$/, "").length >= 6;
  }

  /* The page's og:image as a garment URL - absolute and upgraded - or "" when it cannot
     be one. og:image describes the PAGE for social cards, and stores routinely leave it
     on a site-wide default (a brand share image, a logo) on product pages. Refused when:
       - isExcludedSrc(): a logo/icon/SVG. findProductImages() used to ship the raw
         og:image as its first entry WITHOUT this check, so a logo og:image became the
         garment on every page that reached that fallback.
       - the page's own single-product JSON-LD lists photos and the og:image is none of
         them. JSON-LD is the only contradicting source trusted here: a DOM gallery is
         routinely incomplete (a lazy gallery may hold only the extra photos while the
         main one lives in og:image - widget-dom fixture E), so "absent from the DOM" is
         no evidence, and without JSON-LD the og:image is trusted exactly as before. */
  /* The keyword vetting and the JSON-LD cross-check were independent before, and in that
     order: a "Logo Tee" whose og:image the page's own Product node LISTS was still
     refused for containing "logo", because the keyword test ran first and never learned
     that the store had already vouched for the photo. Corroboration is resolved first
     now, and only a corroborated og:image is promoted past the keyword list. An
     uncorroborated one is vetted exactly as before, which is what keeps the "a logo
     og:image became the garment" refusal intact (widget-dom I1/J2). */
  function pageOgImage() {
    var og = d.querySelector('meta[property="og:image"]');
    var ogUrl = og && og.content ? absolutize(og.content) : "";
    if (!ogUrl) return "";
    var upgraded = upgradeImageUrl(ogUrl);
    var ld = jsonLdProductImages();
    var corroborated = false;
    for (var i = 0; i < ld.length; i++) {
      if (sameAsset(ld[i], upgraded)) { corroborated = true; break; }
    }
    if (isExcludedSrc(ogUrl, corroborated ? DECLARED : { name: productNameHint() })) return "";
    if (!ld.length || corroborated) return upgraded;
    console.log("[PEAR] og:image is not one of this product's JSON-LD photos - not using it:",
      abbrevUrl(upgraded), "| JSON-LD photos:", ld.length);
    return "";
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
      if (inForeignProductScope(el, scope)) continue;   // a recommended product's "back" is not ours
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

    var tiers = [];                     // parallel to found[] - the tier each was found at
    function push(img, ctx) {
      if (!img || seen.indexOf(img) !== -1) return;
      /* Judged by the photo it would SHIP (bestImageUrl already drops logo/icon/SVG
         candidates), never by the pixel it is showing: a lazy <img> displays a
         placeholder - often an SVG spacer, data:image/svg+xml - while its real photo
         waits in data-src. Gating on the rendered src rejected that photo once SVGs
         became excluded (widget-dom fixture M). */
      if (!bestImageUrl(img, ctx)) return;
      seen.push(img);
      found.push(img);
      tiers.push(ctx);                  // the same tier must be used when the URL is re-read
    }

    /* Priority 1 - the og:image, when a visible <img> carries the same URL. pageOgImage()
       has already refused an unusable or contradicted one; the raw content is kept for
       the path comparison below exactly as before. */
    var ogUrl = pageOgImage();
    var ogMeta = ogUrl ? d.querySelector('meta[property="og:image"]') : null;
    var ogRaw = ogMeta && ogMeta.content ? ogMeta.content : "";
    if (ogRaw) {
      var imgs = d.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].currentSrc || imgs[i].src || "";
        /* match on the path part - CDNs often vary query params / protocol */
        if (src && (src === ogRaw || src.split("?")[0] === ogRaw.split("?")[0])) {
          push(imgs[i]);
        }
      }
    }

    /* Priority 2 - well-known product-image selectors, minus another product's tile. */
    if (!found.length) {
      var sel = d.querySelectorAll(PRODUCT_IMG_SELECTORS);
      for (var j = 0; j < sel.length; j++) {
        var el = sel[j];
        /* [data-product-image] may be the container rather than the img */
        if (el.tagName !== "IMG") el = el.querySelector("img") || el;
        if (el.tagName === "IMG" && !inForeignProductScope(el, d)) push(el, DECLARED);
      }
    }

    /* Priority 3 - schema.org microdata: the page marking its own product photo. */
    if (!found.length) {
      var ip = d.querySelectorAll('img[itemprop="image"]');
      for (var p = 0; p < ip.length; p++) {
        if (isProductPhotoCandidate(ip[p], d, DECLARED)) push(ip[p], DECLARED);
      }
    }

    /* Priority 4 - any big image that is a product-photo candidate. Size was the whole
       test before, and a mega-menu wallpaper is big too. */
    if (!found.length) {
      var all = d.querySelectorAll("img");
      for (var k = 0; k < all.length; k++) {
        var im = all[k];
        if (im.naturalWidth > 200 && im.naturalHeight > 200 && isProductPhotoCandidate(im, d)) push(im);
      }
    }

    /* og:image wins as the garment URL for the page's primary image - only once
       pageOgImage() has vetted it; an explicit data-pear-back (or data-pear-front
       override) is captured per image. Non-explicit URLs go through imageUrlsFrom() so a
       lazy <img> resolves to its real, full-size asset instead of a placeholder pixel or
       a 100px thumbnail. */
    var entries = found.map(function (img, idx) {
      return {
        img: img,
        url: explicitAttr(img, "data-pear-front") ||
             ((idx === 0 && ogUrl) ? ogUrl : bestImageUrl(img, tiers[idx])),
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
    function add(u, isPrimary, ctx) {
      if (!u || isExcludedSrc(u, ctx || { name: productNameHint() })) return;
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
    /* THE GAP THIS CLOSES: only THUMB_SELECTORS were queried, so on a storefront whose
       gallery IS its main slides - Salesforce Commerce Cloud/SFRA ships every photo as
       <div class="main_image"><img itemprop="image">, which is how adidas.co.il builds a
       PDP - the gallery collapsed to the primary image alone and the back view could
       only ever come from findGalleryBack()'s narrower search. The main-image selectors
       name product photos just as much as the thumbnail ones do, so both are swept, and
       a main-image match is a DECLARED photo (the theme said so) rather than a guess. */
    var imgs = scope.querySelectorAll(THUMB_SELECTORS + ", " + PRODUCT_IMG_SELECTORS);
    var candidates = [];
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG") continue;
      // Another product's tile/carousel inside this root - never this garment's photo.
      if (inForeignProductScope(el, scope)) continue;
      /* Every URL this element carries, not just the rendered src - on a lazy gallery
         the off-screen slides (i.e. the back view) have only data-src/srcset. The
         first candidate is the best one; the rest are added too because a theme can
         put the full-size asset in one attribute and the only *distinct* photo in
         another, and de-duplication upstream makes extra candidates harmless. */
      var tier = (el.matches && el.matches(PRODUCT_IMG_SELECTORS)) ? DECLARED : null;
      var urlsFor = imageUrlsFrom(el, tier);
      for (var u = 0; u < urlsFor.length; u++) {
        candidates.push(urlsFor[u]);
        add(urlsFor[u], false, tier);
      }
    }
    /* Last resort for galleries that render NOTHING until interacted with: the
       theme's own <noscript> copy of the gallery markup. */
    var ns = noscriptImageUrls(scope);
    for (var n = 0; n < ns.length; n++) { candidates.push(ns[n]); add(ns[n]); }
    /* Structured-data supplement - page-scoped only (a card's root is not the page's
       product) and only when the DOM gallery came up thin: JSON-LD lists the product's
       photos whatever the gallery's lazy-loading does. A fallback rather than always
       merged, so a gallery the DOM already resolved never gains a second spelling of a
       photo it has - one photo under two URLs is what gets paired as front AND back. */
    if (scope === d && urls.length < 2) {
      var ld = jsonLdProductImages();
      for (var l = 0; l < ld.length; l++) { candidates.push(ld[l]); add(ld[l], false, DECLARED); }
    }

    console.log('[PEAR] gallery selectors matched', imgs.length, 'element(s) under root:', scope);
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
  // The SAME product.js fetch also carries the full variant list - cached here so the
  // Add-to-Cart bridge can resolve an in-room size change to its real variant id
  // instead of trusting whatever the PDP had selected when the fitting room opened
  // (see findVariantForSize()'s own comment below for the bug this closes).
  var _shopifyVariants = null;         // Shopify variant objects[] once resolved, [] when unavailable
  var _shopifySizeOptionIndex = -1;    // 0/1/2 (option1/2/3) for whichever option Shopify itself calls "Size", else -1

  function loadShopifyProductJSON() {
    if (_shopifyGallery) return Promise.resolve(_shopifyGallery);
    var path = w.location.pathname.split("?")[0].replace(/\/$/, "");
    if (path.indexOf("/products/") === -1) {
      _shopifyGallery = []; _shopifyVariants = []; _shopifySizeOptionIndex = -1;
      return Promise.resolve(_shopifyGallery);
    }
    return fetch(path + ".js", { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (p) {
        var imgs = [];
        var list = (p && p.images) || [];
        for (var i = 0; i < list.length; i++) {
          var u = absolutize(typeof list[i] === "string" ? list[i] : (list[i] && list[i].src));
          /* The store's OWN product API listed these - the strongest declaration there is. */
          if (u && !isExcludedSrc(u, { declared: true })) imgs.push(upgradeImageUrl(u));
        }
        _shopifyGallery = imgs;

        _shopifyVariants = (p && p.variants) || [];
        // Read the option's declared NAME rather than assuming a position - different
        // themes/merchants put Size at option1, option2 or option3 depending on
        // whichever other option (colour, material) they listed first.
        var opts = (p && p.options) || [];
        _shopifySizeOptionIndex = -1;
        for (var j = 0; j < opts.length; j++) {
          var name = ((opts[j] && opts[j].name) || "").trim().toLowerCase();
          if (name === "size" || name === "מידה") { _shopifySizeOptionIndex = j; break; }
        }

        console.log("[PEAR] Shopify product JSON:", imgs.length, "image(s),",
          _shopifyVariants.length, "variant(s) for", p && p.title,
          "- size option index:", _shopifySizeOptionIndex);
        return imgs;
      })
      .catch(function (e) {
        console.log("[PEAR] Shopify product JSON unavailable (not a Shopify PDP?):", e && e.message);
        _shopifyGallery = []; _shopifyVariants = []; _shopifySizeOptionIndex = -1;
        return _shopifyGallery;
      });
  }

  function normalizeSizeToken(s) {
    return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  /* ── Reading the product's REAL size list off the host page ────────────────────
     THE BUG THIS EXISTS FOR: the fitting room used to decide kids-vs-adult purely
     from Gemini's packshot classification, which server.js's own prompt tells the
     model to answer "uncertain" for a flat-lay with no model and no size label - so a
     FOX kids-only Spiderman tee (sizes 8-16) came back "uncertain", the adult/kids
     guard never fired, and an adult XS-3XL size ladder was drawn over it. The store
     page knew the answer the whole time. This reads it.

     A WRONG list here BLOCKS A PAYING SHOPPER, so both tiers below are deliberately
     strict: the Shopify tier only trusts the option the store itself named "Size",
     and the DOM tier only accepts a control whose values are ALL recognisable size
     tokens. Anything less confident yields nothing at all, which simply restores the
     previous (classifier-only) behaviour rather than risking a false block. */
  function isPlausibleSizeToken(s) {
    var t = String(s == null ? "" : s).trim();
    if (!t || t.length > 5) return false;
    return /^\d{1,2}$/.test(t) || /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL)$/i.test(t);
  }

  /* Distinct values of the declared Size option, in catalog order. sizeOptionIndex
     comes from the product's own options array (see loadShopifyProductJSON) - never a
     guessed position - so -1 correctly yields nothing rather than reading colours. */
  function sizesFromVariants(variants, sizeOptionIndex) {
    if (sizeOptionIndex < 0 || !variants || !variants.length) return [];
    var out = [], seen = {};
    for (var i = 0; i < variants.length; i++) {
      var raw = optionValueAt(variants[i], sizeOptionIndex);
      var v = String(raw == null ? "" : raw).trim();
      if (!v) continue;
      var key = v.toLowerCase();
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(v);
    }
    return out;
  }

  var SIZE_CONTROL_SELECTORS = [
    '[data-option-name="Size" i]', '[data-option-name="מידה"]',
    'select[name*="size" i]', 'select[id*="size" i]', 'select[name*="מידה"]',
    'fieldset[name*="size" i]', '[class*="size-selector" i]', '[class*="size-swatch" i]',
    '[class*="swatch" i][data-option*="size" i]', '[data-attribute*="size" i]'
  ].join(",");

  /* DOM tier - the universal fallback for every non-Shopify stack. Returns [] unless a
     single control yields 2+ values that are ALL plausible size tokens, so a stray
     <select> of colours or quantities can never masquerade as a size list.

     WHY THIS IS SPLIT IN TWO. The stock reader below has to answer "is THIS size
     buyable" and that is a property of the NODE, not of the string - so the walk that
     picks the winning control now yields {value,node} pairs (sizeOptionNodes) and
     sizesFromDOM() is the thin projection back down to strings. There is exactly ONE
     definition of "which control on this page is the size picker"; a second copy of
     that walk written for stock would be free to drift and start reading a DIFFERENT
     control than the one the size list came from, which is the one way this could
     report a size as sold out that the shopper is looking at in stock. */
  function sizeOptionNodes() {
    var nodes = d.querySelectorAll(SIZE_CONTROL_SELECTORS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], raw = [];
      var opts = el.querySelectorAll ? el.querySelectorAll("option") : [];
      for (var j = 0; j < opts.length; j++) raw.push({ v: opts[j].textContent, node: opts[j] });
      if (!raw.length) {
        var btns = el.querySelectorAll
          ? el.querySelectorAll("button,label,li,a,[data-value]") : [];
        for (var k = 0; k < btns.length; k++) {
          raw.push({ v: readAttr(btns[k], "data-value") || btns[k].textContent, node: btns[k] });
        }
      }
      var out = [], seen = {}, rejected = false;
      for (var m = 0; m < raw.length; m++) {
        var v = String(raw[m].v == null ? "" : raw[m].v).trim();
        if (!v) continue;                        // blank rows carry no signal either way
        if (!isPlausibleSizeToken(v)) {
          // A leading placeholder ("Choose a size", "בחר מידה") is normal and ignored;
          // a non-size value ANYWHERE else means this control isn't a size picker, so
          // the whole list is discarded rather than half-trusted.
          if (m === 0) continue;
          rejected = true; break;
        }
        var key = v.toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ value: v, node: raw[m].node });
      }
      if (rejected) continue;                    // try the next candidate control
      if (out.length >= 2) return out;
    }
    return [];
  }

  function sizesFromDOM() {
    var pairs = sizeOptionNodes();
    var out = [];
    for (var i = 0; i < pairs.length; i++) out.push(pairs[i].value);
    return out;
  }

  function extractHostSizes() {
    var fromVariants = sizesFromVariants(_shopifyVariants, _shopifySizeOptionIndex);
    if (fromVariants.length) return fromVariants;
    try { return sizesFromDOM(); } catch (e) { return []; }
  }

  /* ══ STOCK - which of those sizes the shopper cannot actually buy ════════════════
     WHAT THIS IS FOR: the room recommends a size off the body measurements alone, so
     it will happily hand a shopper "L" on a product whose L sold out three days ago.
     They go live, like it, press Add to Cart and only then find out. This reads the
     answer the PDP is already showing them.

     IT REPORTS SOLD-OUT, NEVER IN-STOCK, AND THAT DIRECTION IS THE WHOLE SAFETY
     ARGUMENT (CLAUDE.md §2.5 - never block on ambiguity; a wrong block stops a paying
     shopper). Every failure mode here - a theme we cannot read, a control that never
     hydrated, a thrown selector, a store with no stock markup at all - converges on the
     SAME empty list, and an empty list means "nothing is known to be sold out", i.e.
     the exact behaviour that shipped before this existed. Had this returned the
     IN-STOCK set instead, all of those same failures would have converged on "" and
     every size on the page would have been struck through on a store that was fully
     stocked. There is no reading of this list that can take a size away from someone
     who can buy it; the worst case is that it stays silent.

     Two tiers, strongest first, exactly mirroring extractHostSizes() above. */

  /* Tier 1 - the store's own variant JSON. `available` is Shopify's own computed
     answer (inventory policy, tracking and quantity already folded in), so this needs
     no heuristics at all and is the only tier that can be called authoritative.

     A SIZE IS SOLD OUT ONLY WHEN EVERY VARIANT CARRYING IT IS UNAVAILABLE. On a
     Size × Colour product, L-in-red being gone says nothing about L-in-blue, and the
     shopper can still buy an L. Requiring all of them to be unavailable is what keeps
     a multi-option product from reporting most of its ladder sold out.

     ABSTAINS WHOLESALE on a payload with no `available` field anywhere (a non-Shopify
     shape that happened to be parsed, or an older API): every size would otherwise
     read as available===undefined -> falsy -> "sold out", turning a missing field into
     a claim that the whole product is gone. Pure - no DOM, no globals - so the suite
     can exercise it directly.
     @returns {string[]} the sold-out values, in catalog order */
  function soldOutFromVariants(variants, sizeOptionIndex) {
    if (sizeOptionIndex < 0 || !variants || !variants.length) return [];
    var sawAvailabilityField = false;
    for (var a = 0; a < variants.length; a++) {
      if (variants[a] && typeof variants[a].available === "boolean") { sawAvailabilityField = true; break; }
    }
    if (!sawAvailabilityField) return [];

    var order = [], anyAvailable = {};
    for (var i = 0; i < variants.length; i++) {
      var raw = optionValueAt(variants[i], sizeOptionIndex);
      var v = String(raw == null ? "" : raw).trim();
      if (!v) continue;
      var key = v.toLowerCase();
      if (!(key in anyAvailable)) { order.push(v); anyAvailable[key] = false; }
      if (variants[i] && variants[i].available === true) anyAvailable[key] = true;
    }
    var out = [];
    for (var j = 0; j < order.length; j++) {
      if (!anyAvailable[order[j].toLowerCase()]) out.push(order[j]);
    }
    return out;
  }

  /* The class/text half of the DOM tier, kept pure and separate from the node poking
     so the suite can pin the vocabulary without a DOM. Deliberately NARROW: matched as
     whole dash/underscore/space-delimited words, so "size-disabled-hint" or a product
     genuinely called "Unavailable Hoodie" cannot trip it from a substring.

     "disabled" IS on the list. As a CLASS it is ambiguous (some themes use it for "not
     selectable yet"), but a mis-read here costs a strike-through and an alternative
     suggestion on a size that was in fact buyable - the shopper can still press it
     (the room never disables a size button, see injectSizeSelector in app.js) - while
     missing it costs them the purchase they were about to make. */
  var OOS_WORD_RE = /(?:^|[-_\s])(?:sold[-_\s]?out|soldout|out[-_\s]?of[-_\s]?stock|outofstock|oos|unavailable|no[-_\s]?stock|nostock|disabled|is-disabled|inactive)(?:$|[-_\s])/i;
  var OOS_TEXT_RE = /(?:sold\s*out|out\s*of\s*stock|unavailable|not\s*available|אזל|אזלה|לא\s*במלאי|חסר\s*במלאי|נגמר\s*המלאי)/i;
  function oosTokenSignal(className, text) {
    if (OOS_WORD_RE.test(" " + String(className == null ? "" : className) + " ")) return true;
    /* The size token itself is <=5 chars (isPlausibleSizeToken), so anything long
       enough to carry one of these phrases is extra copy the theme added - almost
       always a visually-hidden "Sold out" span inside the swatch. */
    return OOS_TEXT_RE.test(String(text == null ? "" : text));
  }

  /* Shopify's stock swatch pattern is <input type="radio" disabled><label for=...>L</label>
     - the string is on the LABEL and the disabled state is on the INPUT, so reading
     only the node the value came from misses it on a large share of real stores. */
  function stockStateNode(node) {
    if (!node) return null;
    try {
      if (node.tagName !== "LABEL") return null;
      var id = readAttr(node, "for");
      if (id && d.getElementById) {
        var target = d.getElementById(id);
        if (target) return target;
      }
      return node.querySelector ? node.querySelector("input") : null;
    } catch (e) { return null; }
  }

  function nodeSaysOutOfStock(node) {
    if (!node) return false;
    try {
      if (node.disabled === true) return true;
      if (readAttr(node, "aria-disabled") === "true") return true;
      /* hasAttribute, NOT readAttr - and this is the bug this line is written against.
         readAttr() returns "" for a MISSING attribute, never null (see its own
         definition above), so a `readAttr(node,"disabled") != null` presence test is
         true for every element on the page: the first jsdom run of this tier reported
         S/M/L/XL as sold out on a fully stocked product, i.e. the one direction this
         whole feature is built never to fail in. Every OTHER check here compares
         readAttr's result against a specific VALUE ("true"/"false"/"0"), where the ""
         default is correctly inert; presence is the only question that has to be asked
         a different way. Covers <label disabled>/<li disabled>, where there is no
         .disabled IDL property for the check above to have caught. */
      if (node.hasAttribute && node.hasAttribute("disabled")) return true;
      var avail = readAttr(node, "data-available");
      if (avail === "false" || avail === "0") return true;
      var stocked = readAttr(node, "data-in-stock") || readAttr(node, "data-instock");
      if (stocked === "false" || stocked === "0") return true;
      var qty = readAttr(node, "data-stock") || readAttr(node, "data-inventory") ||
                readAttr(node, "data-quantity");
      if (qty === "0") return true;
      /* SVG elements carry className as an SVGAnimatedString, not a string. */
      var cls = node.className;
      if (cls && typeof cls === "object" && "baseVal" in cls) cls = cls.baseVal;
      if (oosTokenSignal(cls, node.textContent)) return true;
      /* The line-through the task asks about. Computed, not inline, because themes set
         it from a stylesheet - and read off the node AND its first element child, since
         a swatch usually strikes an inner <span> rather than the label itself. */
      if (w.getComputedStyle) {
        var probes = [node, node.firstElementChild];
        for (var i = 0; i < probes.length; i++) {
          if (!probes[i]) continue;
          var cs = w.getComputedStyle(probes[i]);
          var deco = (cs && (cs.textDecorationLine || cs.textDecoration)) || "";
          if (String(deco).indexOf("line-through") !== -1) return true;
        }
      }
    } catch (e) { return false; }
    return false;
  }

  /* Tier 2 - the universal fallback, read off the SAME control sizesFromDOM() chose
     (see sizeOptionNodes' comment on why that is one walk and not two). */
  function soldOutFromDOM() {
    var pairs = sizeOptionNodes(), out = [];
    for (var i = 0; i < pairs.length; i++) {
      if (nodeSaysOutOfStock(pairs[i].node) || nodeSaysOutOfStock(stockStateNode(pairs[i].node))) {
        out.push(pairs[i].value);
      }
    }
    return out;
  }

  /* Tier order mirrors extractHostSizes() EXACTLY, and it has to: the room pairs this
     list against that one by token, so a stock verdict read off the DOM while the size
     list came from the variant JSON could be keyed on values that are spelled
     differently ("L" vs "Large") and would silently match nothing. Whichever tier
     answered for the sizes answers for their stock. */
  function extractSoldOutSizes() {
    try {
      if (sizesFromVariants(_shopifyVariants, _shopifySizeOptionIndex).length) {
        return soldOutFromVariants(_shopifyVariants, _shopifySizeOptionIndex);
      }
      return soldOutFromDOM();
    } catch (e) {
      console.log("[PEAR widget] stock scrape failed, treating every size as available:", e && e.message);
      return [];
    }
  }

  /* ── NUMERIC vs ALPHABETIC size run, read at scan time ──────────────────────────
     THE BUG THIS EXISTS FOR: a pair of sweatpants sold S/M/L matched the fitting
     room's isPantsProduct() on its TITLE alone ("sweatpants" is a bottoms noun), and
     with no numeric evidence of its own that title match fell through to the waist
     chart's default (pantsChartForSizes() treats "no confidently-numeric run" as "use
     the jeans waist ladder") - the same numeric routing meant for 28/30/32 jeans was
     applied to a garment whose picker only ever offers letters. The shopper was
     quoted a bare waist-inch number ("32") for a product with no such size.

     This is computed HERE, from the same size list extractHostSizes() already
     scraped, and sent alongside it so the fitting room has POSITIVE evidence the run
     is alphabetic rather than having to fall through a numeric-chart default.
     "every token or abstain" mirrors isPlausibleSizeToken()'s own confidence rule -
     a mixed or unrecognised run yields "unknown" rather than a guess in either
     direction.
     @param {string[]} sizes
     @returns {"numeric"|"alpha"|"unknown"} */
  function classifySizeRunType(sizes) {
    var list = (sizes || []).map(function (s) { return String(s == null ? "" : s).trim(); }).filter(Boolean);
    if (!list.length) return "unknown";
    var allNumeric = true, allAlpha = true;
    for (var i = 0; i < list.length; i++) {
      if (!/^\d{1,2}$/.test(list[i])) allNumeric = false;
      if (!/^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL)$/i.test(list[i])) allAlpha = false;
    }
    if (allNumeric) return "numeric";
    if (allAlpha) return "alpha";
    return "unknown";
  }


  /* ══ THE STORE'S OWN SIZE CHART ═════════════════════════════════════════════════
     WHAT THIS IS FOR: calculateSize() in the fitting room fits every shopper against
     ONE hardcoded global matrix (ZARA_SIZE_CHART and the two pants ladders). Those
     bands are vetted, but they are OURS - and the storefront the shopper is standing
     on almost always publishes its own "Size guide" / "מדריך מידות" table with real
     chest/waist/hip centimetres per size. That table is the one the merchant gets
     judged against when the parcel arrives. We were never reading it.

     ── THE SAFETY LINE, AND WHY READING MERCHANT HTML IS ACCEPTABLE AT ALL ──────────
     What travels from here can ONLY reach the fine-tune tie-break in calculateSize()
     (the x0.5 chest/waist/legs pass over rows that ALREADY passed the height/weight
     gate). applyStoreChartOverlay() in app.js refuses to write a height or weight
     column, so a wrong scrape can at worst move the recommendation between two
     adjacent sizes that both genuinely fit this body - it can never invent a
     candidate, remove one, flip adult<->child, or turn a match into a no-match. See
     docs/superpowers/specs/2026-09-17-storefront-size-chart-scraper.md.

     ── PASSIVE, AND LAZY (zero page-load cost) ──────────────────────────────────────
     Called ONLY from openModal(), i.e. after the shopper clicks the PEAR button -
     never on DOMContentLoaded, never on load, never in the rAF injection pass. It
     reads: no clicks, no dialog.showModal(), no fetch, no style writes. A size guide
     that only EXISTS after a click is simply not found, which is the same answer as
     "this store publishes no chart". A hidden-but-present modal (the common Shopify/
     Woo shape - the markup ships in the DOM and CSS hides it) reads fine, because
     querySelectorAll does not care about visibility.

     ── EVERY FAILURE CONVERGES ON null (CLAUDE.md §2.5) ─────────────────────────────
     No table, an unreadable header, ambiguous units, a non-monotonic column, a thrown
     selector, a merchant who ships a 4,000-row table: all of them yield null, the
     param is omitted, and the room uses the default global matrix - byte for byte the
     behaviour that shipped before this existed. There is deliberately no tier here
     that can half-trust a chart: a partially-read grid is worse than none, because it
     is indistinguishable from a correctly-read one downstream. */

  var SIZE_CHART_MAX_TABLES = 8;    // candidate tables scored per page
  var SIZE_CHART_MAX_ROWS   = 40;   // rows read per table
  var SIZE_CHART_MAX_COLS   = 12;   // columns read per row

  /* Absolute sanity clamps, in CENTIMETRES, applied AFTER any inch conversion. These
     are not "typical" bands - they are the outer edge of humanly-possible, sized to
     catch a column that is really prices, weights, or a mis-read grid, while never
     refusing a real chart. A value outside these drops its COLUMN, not the chart. */
  var SIZE_CHART_CLAMPS = {
    chest: { min: 50, max: 200 },
    waist: { min: 40, max: 200 },
    hips:  { min: 50, max: 200 },
    legs:  { min: 40, max: 140 }
  };
  /* A band wider than this is a mis-read: two adjacent cells parsed as one range. */
  var SIZE_CHART_MAX_BAND_CM = 40;
  /* Point-value charts ("M = 96cm") get a symmetric band, since the fine-tune pass
     scores DISTANCE OUTSIDE a band and a zero-width band would penalise every shopper
     whose chest isn't exactly the published number. 2cm each way is the half-step
     between adjacent sizes on every chart in this file. */
  var SIZE_CHART_POINT_TOL_CM = 2;
  /* Below this, a measurement column is inches, above it centimetres. A 38in chest and
     a 38cm chest are not both plausible garments - no adult chest chart is under 60cm
     and no inch chart is over 60in. Applied per COLUMN off that column's median, never
     per cell, so one mis-typed value cannot flip a whole column's units. */
  var SIZE_CHART_INCH_MAX = 60;

  /* Units. CM IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING: the Hebrew ס"מ contains
     a double-quote, which is also the inch mark, so an inch-first test reads every
     Hebrew centimetre chart as inches and divides the whole store by 2.54. */
  var SIZE_CHART_CM_RE = /(?:\bcm\b|centimet|ס\s*["'״]?\s*מ|סנטימטר)/i;
  var SIZE_CHART_IN_RE = /(?:inch(?:es)?|\bins?\b|["”″])/i;
  function sizeChartUnitFromText(s) {
    var t = String(s == null ? "" : s);
    if (SIZE_CHART_CM_RE.test(t)) return "cm";
    if (SIZE_CHART_IN_RE.test(t)) return "in";
    return null;
  }

  /* Header cell -> the column key app.js's chart rows already use. English + Hebrew.
     DELIBERATELY NARROW. An unmapped column contributes nothing, which is safe; a
     WRONGLY mapped one silently re-bands a real measurement, which is not. Two
     specific exclusions worth their own line:
       · bare "length" / "אורך" is NOT mapped - on almost every chart that is the
         GARMENT's length (shoulder to hem), a property of the cloth, not of the body,
         and the fine-tune pass scores body measurements.
       · "inseam" is NOT mapped to legs. app.js's minLegs/maxLegs is the OUTSEAM
         convention (~0.575x height - see ZARA_SIZE_CHART's own comment); an inseam is
         ~0.45x and would read as a shopper 25cm outside every band. A different
         convention for the same body is a second column, never a substitute - the same
         call ADULT_JEANS_WAIST_CHART's comment records for waist-inch vs EU. */
  var SIZE_CHART_MEASURE_KEYS = [
    ["chest", /(?:\bchest\b|\bbust\b|היקף\s*חזה|חזה)/i],
    ["waist", /(?:\bwaist\b|היקף\s*מותן|מותניים|מותן)/i],
    ["hips",  /(?:\bhips?\b|\bseat\b|היקף\s*אגן|ירכיים|אגן)/i],
    ["legs",  /(?:\boutseam\b|\boutside\s*leg\b|\bleg\s*length\b|\btrouser\s*length\b|אורך\s*רגל|אורך\s*מכנס)/i]
  ];
  /* ⚠️ THE \b ON THE ENGLISH ALTERNATIVES IS LOAD-BEARING, AND THE HEBREW ONES
     DELIBERATELY LACK IT. JavaScript's \b is defined on [A-Za-z0-9_], so a Hebrew
     letter is never a word character and \bמותן\b can never match anything - adding it
     "for consistency" silently unmaps every Hebrew chart in the catalog. On the English
     side the opposite is true: without \b, `hips?` matches "Ship Weight" and a column
     of shipping weights is read as a hip ladder.

     AND A BODY WORD IS NOT ENOUGH ON ITS OWN. Real spec sheets carry columns like
     "Waist to Hem", "Half Chest" and "Chest Width" - garment geometry (a length, or a
     FLAT half-circumference) that happens to name a body part. Scoring a shopper's
     94cm waist against a 63cm hem drop, or against a half-chest that is half the number
     it looks like, is the expensive failure this whole file is built to avoid: a
     confident, plausible, WRONG chart rather than a visible absence. So a header that
     also names a garment dimension is refused outright, which costs nothing (the room
     keeps its vetted band for that column).

     NOT APPLIED TO `legs`, whose own patterns are garment-length-shaped by construction
     ("leg length", "trouser length", "אורך רגל") - vetoing them would unmap the key
     entirely. They are narrowly anchored instead. */
  var SIZE_CHART_GARMENT_DIM_RE = new RegExp(
    "\\bto\\s+(?:hem|waist|chest|hip|cuff|knee)\\b|\\blength\\b|\\bdrop\\b|\\bopening\\b" +
    "|\\bhem\\b|\\bsleeve\\b|\\bshoulder\\b|\\binseam\\b|\\brise\\b|\\bacross\\b" +
    "|\\bhalf\\b|\\bflat\\b|\\bwidth\\b|\\bpit\\s*to\\s*pit\\b|\\bp2p\\b|1/2" +
    "|אורך|שרוול|כתף", "i");
  function sizeChartMeasureKey(text) {
    var t = String(text == null ? "" : text);
    if (!t.trim()) return null;
    for (var i = 0; i < SIZE_CHART_MEASURE_KEYS.length; i++) {
      if (!SIZE_CHART_MEASURE_KEYS[i][1].test(t)) continue;
      var key = SIZE_CHART_MEASURE_KEYS[i][0];
      if (key !== "legs" && SIZE_CHART_GARMENT_DIM_RE.test(t)) return null;
      return key;
    }
    return null;
  }

  /* Word sizes -> the tokens app.js's ladders are spelled in. Without this, a chart
     headed "Small / Medium / Large" (which is most of them outside fast fashion)
     yields a size column isPlausibleSizeToken() rejects wholesale, and the chart is
     discarded for a spelling. */
  var SIZE_CHART_WORD_SIZES = [
    [/^(?:xx[\s-]*small|2x[\s-]*small)$/i, "XXS"],
    [/^(?:x[\s-]*small|extra[\s-]*small)$/i, "XS"],
    [/^small$/i, "S"], [/^medium$/i, "M"], [/^large$/i, "L"],
    [/^(?:x[\s-]*large|extra[\s-]*large)$/i, "XL"],
    [/^(?:xx[\s-]*large|2x[\s-]*large)$/i, "XXL"],
    [/^(?:xxx[\s-]*large|3x[\s-]*large)$/i, "XXXL"]
  ];

  /* The size CELL, which is messier than the picker values isPlausibleSizeToken() was
     written for: "M / 38", "L (EU 40)", "Medium". Takes the leading token, maps the
     word forms, and then hands the result to the SAME plausibility test the size
     scrape already uses - so the two can never disagree about what a size looks like.
     @returns {string} the uppercased token, or "" when this is not a size cell */
  function sizeChartSizeToken(raw) {
    var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
    if (!t) return "";
    t = t.split(/[\/|(,]/)[0].trim();          // "L (EU 40)" -> "L", "M / 38" -> "M"
    for (var i = 0; i < SIZE_CHART_WORD_SIZES.length; i++) {
      if (SIZE_CHART_WORD_SIZES[i][0].test(t)) return SIZE_CHART_WORD_SIZES[i][1];
    }
    t = t.toUpperCase();
    return isPlausibleSizeToken(t) ? t : "";
  }

  /* One measurement cell -> { min, max, unit } in the cell's OWN units, or null.
     Handles the four forms that actually ship: a point value ("96"), a range
     ("92-96", "92 - 96", "92 to 96", "92/96"), a unit-suffixed value ("96 cm", 37.5in)
     and a dash/blank placeholder ("-", "", ""). Decimal comma ("96,5") is accepted;
     a thousands separator is not a thing in a chart of body centimetres.
     PURE - no DOM, no globals - so the suite can exercise it directly. */
  function parseMeasurementCell(raw) {
    var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
    if (!t) return null;
    var unit = sizeChartUnitFromText(t);
    /* Numbers are pulled AFTER the unit test, and the inch mark is stripped first, so
       the quote in 37.5" cannot be mistaken for part of the number. */
    var nums = t.replace(/[”″"']/g, " ").match(/\d+(?:[.,]\d+)?/g);
    if (!nums || !nums.length) return null;
    var a = parseFloat(String(nums[0]).replace(",", "."));
    var b = nums.length > 1 ? parseFloat(String(nums[1]).replace(",", ".")) : a;
    if (!isFinite(a) || !isFinite(b)) return null;
    /* Stored min-first. A chart printed "96-92" is a typo, not a reason to drop a row. */
    return { min: Math.min(a, b), max: Math.max(a, b), unit: unit };
  }

  /* Reads a <table> into a capped grid of trimmed strings. Colspans are NOT expanded:
     a chart that needs colspan arithmetic to line its columns up is exactly the kind
     this refuses, and a wrong column alignment is the one failure mode that produces a
     confident, plausible, WRONG chart. */
  function sizeChartGrid(table) {
    var rows = table.querySelectorAll ? table.querySelectorAll("tr") : [];
    var grid = [];
    for (var r = 0; r < rows.length && grid.length < SIZE_CHART_MAX_ROWS; r++) {
      var cells = rows[r].querySelectorAll ? rows[r].querySelectorAll("th,td") : [];
      if (!cells.length) continue;
      var line = [];
      for (var c = 0; c < cells.length && c < SIZE_CHART_MAX_COLS; c++) {
        line.push(String(cells[c].textContent == null ? "" : cells[c].textContent)
          .replace(/ /g, " ").replace(/\s+/g, " ").trim());
      }
      grid.push(line);
    }
    return grid;
  }

  /* ORIENTATION. Charts ship both ways round: sizes down the first column with
     measurement names across the header (the common case), or sizes across the header
     with measurement names down the first column. Decided by COUNTING plausible size
     tokens on each axis rather than by guessing from the header text - a chart with
     neither axis full of sizes reads as "not a size chart" instead of as a transposed
     one, which is what keeps a price table from being read sideways. */
  function sizeChartOrient(grid) {
    if (!grid.length) return grid;
    var down = 0, across = 0, i;
    for (i = 1; i < grid.length; i++) if (sizeChartSizeToken(grid[i][0])) down++;
    for (i = 1; i < (grid[0] || []).length; i++) if (sizeChartSizeToken(grid[0][i])) across++;
    if (across <= down) return grid;
    var width = 0;
    for (i = 0; i < grid.length; i++) width = Math.max(width, grid[i].length);
    var out = [];
    for (var c = 0; c < width; c++) {
      var line = [];
      for (var r = 0; r < grid.length; r++) line.push(grid[r][c] == null ? "" : grid[r][c]);
      out.push(line);
    }
    return out;
  }

  function sizeChartCap(key) { return key.charAt(0).toUpperCase() + key.slice(1); }

  /* One column of parsed cells -> centimetre bands, or null to DROP THE COLUMN.
     Column-level, never cell-level, because units, monotonicity and the clamp are all
     properties of the ladder rather than of any one value - and dropping a column
     leaves the rest of the chart (and app.js's own bands for that measurement) intact,
     which is the whole reason this refuses a column instead of the chart. */
  function sizeChartColumnToCm(col, tableUnit) {
    var i, v, mids = [], explicit = null;
    for (i = 0; i < col.vals.length; i++) {
      v = col.vals[i];
      if (!v) continue;
      if (v.unit) explicit = explicit || v.unit;
      mids.push((v.min + v.max) / 2);
    }
    if (mids.length < 2) return null;                 // a column of one value is noise

    /* Unit, strongest evidence first: a cell said so, the header said so, the table's
       caption/container said so, and only then the magnitude tier. */
    var unit = explicit || col.unit || tableUnit;
    if (!unit) {
      var sorted = mids.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      unit = median < SIZE_CHART_INCH_MAX ? "in" : "cm";
    }
    var factor = unit === "in" ? 2.54 : 1;
    var clamp = SIZE_CHART_CLAMPS[col.key];

    var out = [], seen = [];
    for (i = 0; i < col.vals.length; i++) {
      v = col.vals[i];
      if (!v) { out.push(null); continue; }
      var min = v.min * factor, max = v.max * factor;
      if (min === max) { min -= SIZE_CHART_POINT_TOL_CM; max += SIZE_CHART_POINT_TOL_CM; }
      if (!(min >= clamp.min && max <= clamp.max)) return null;   // out of human range
      if (max - min > SIZE_CHART_MAX_BAND_CM) return null;        // two cells read as one
      out.push({ min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 });
      seen.push((min + max) / 2);
    }

    /* MONOTONICITY IS THE REAL FILTER, and it is direction-agnostic on purpose: a
       chart may be printed largest-first, and the room keys rows by TOKEN so print
       order is irrelevant to it. What a real ladder can never do is wander - a chest
       that grows, shrinks and grows again across S/M/L is a column of prices, stock
       counts or garment lengths that happened to sit under a "chest" header. Ties are
       allowed (adjacent sizes really do share a band on some charts). */
    var up = true, downward = true;
    for (i = 1; i < seen.length; i++) {
      if (seen[i] < seen[i - 1]) up = false;
      if (seen[i] > seen[i - 1]) downward = false;
    }
    if (!up && !downward) return null;
    return out;
  }

  /* Grid (already oriented sizes-as-rows) -> the validated rows, or null.
     tableUnit is the unit named by the table's caption/container, used only when
     neither the cells nor the header say.
     PURE apart from the grid it is handed, so the suite drives it with literals. */
  function sizeChartFromGrid(grid, tableUnit) {
    if (!grid || grid.length < 3) return null;      // header + at least two size rows
    var header = grid[0], cols = [], i, r;
    for (i = 1; i < header.length; i++) {
      var key = sizeChartMeasureKey(header[i]);
      /* FIRST HEADER WINS on a duplicate key. A chart with two "waist" columns is
         usually body-waist followed by garment-waist; the body one is printed first by
         every convention this codebase has seen, and picking the later one silently
         re-bands the shopper against the cloth. */
      if (key && !sizeChartHasKey(cols, key)) {
        cols.push({ key: key, idx: i, unit: sizeChartUnitFromText(header[i]), vals: [] });
      }
    }
    if (!cols.length) return null;

    var sizes = [];
    for (r = 1; r < grid.length; r++) {
      var token = sizeChartSizeToken(grid[r][0]);
      if (!token) continue;                          // a notes row, a unit toggle row
      if (sizes.indexOf(token) !== -1) continue;     // duplicate size row - first wins
      sizes.push(token);
      for (i = 0; i < cols.length; i++) {
        cols[i].vals.push(parseMeasurementCell(grid[r][cols[i].idx]));
      }
    }
    if (sizes.length < 2) return null;

    var rowsOut = [];
    for (i = 0; i < sizes.length; i++) rowsOut.push({ size: sizes[i] });
    var kept = 0;

    for (i = 0; i < cols.length; i++) {
      var col = cols[i], band = sizeChartColumnToCm(col, tableUnit);
      if (!band) continue;
      for (r = 0; r < rowsOut.length; r++) {
        if (!band[r]) continue;
        rowsOut[r]["min" + sizeChartCap(col.key)] = band[r].min;
        rowsOut[r]["max" + sizeChartCap(col.key)] = band[r].max;
      }
      kept++;
    }
    return kept ? rowsOut : null;
  }

  function sizeChartHasKey(cols, key) {
    for (var i = 0; i < cols.length; i++) if (cols[i].key === key) return true;
    return false;
  }

  /* The unit named by the table's own caption or by the container around it ("All
     measurements in cm"), used only when neither a cell nor a header says. Walks at
     most four ancestors and reads at most 400 characters, so a unit toggle buried in
     the page chrome cannot pull in the whole document's text.

     ⚠️ IT USES A STRICTER INCH TEST THAN THE CELL/HEADER TIERS, ON PURPOSE. Free page
     prose is not a measurement label: "shown in blue", "Made in Portugal" and a stray
     typographic quote all contain what SIZE_CHART_IN_RE is looking for, and reading a
     centimetre chart as inches divides an entire store's bands by 2.54 - a wrong,
     plausible, confident chart, which is the one failure mode this whole file is built
     to avoid. At this tier only an unambiguous WORD counts ("inch"/"inches"). A cell or
     a header is short and measurement-labelled, so the loose test stays correct there;
     a paragraph is not. */
  var SIZE_CHART_DECLARED_IN_RE = /inch(?:es)?/i;
  function sizeChartTableUnit(table) {
    var node = table, depth = 0;
    while (node && depth < 4) {
      var txt = String(node.textContent == null ? "" : node.textContent).slice(0, 400);
      if (SIZE_CHART_CM_RE.test(txt)) return "cm";
      if (SIZE_CHART_DECLARED_IN_RE.test(txt)) return "in";
      node = node.parentNode; depth++;
    }
    return null;
  }

  /* ── WHERE THE CHART LIVES, per platform ─────────────────────────────────────────
     Tier 1. Every list is tried on EVERY page, whatever stack we think we are on: a
     Woo-flavoured theme on a headless Shopify is a real thing, and mis-detecting the
     platform must not cost us the chart. The platform name rides along only as
     provenance (it reaches the room as the chart's `source`, and the console line
     below) - it never gates anything. */
  var SIZE_CHART_CONTAINERS = [
    ["shopify", [
      ".size-chart", ".size-guide", ".sizing-chart", "[data-size-chart]",
      'modal-dialog[id*="size" i]', '.product-popup-modal[id*="size" i]',
      "[data-pear-size-chart]"
    ]],
    ["woocommerce", [
      ".woocommerce-size-guide", "#tab-size_guide", "#tab-size-guide", ".wc-size-chart",
      ".woo-size-chart", ".wcsg-table", '[class*="size-guide" i].woocommerce-tabs',
      ".woocommerce-Tabs-panel--size_guide"
    ]],
    ["magento", [
      ".size-guide-content", "#size-chart-modal", ".sizeguide", ".size-guide-popup",
      '[data-role="size-guide"]', ".product.attribute.size-chart", ".amsizechart"
    ]],
    /* ── THE WILDCARDS GO LAST, AND THEY ARE NOT A PLATFORM ───────────────────────
       These substring matchers ('[class*="size-guide" i]' and friends) catch the long
       tail of themes nobody has a selector for, and they are the reason tier 1 covers
       most real stores at all. But they also match the NAMED containers above -
       .size-guide-content is a "size-guide" substring - so listing them under a
       platform makes that platform claim every other platform's container, purely
       because it was iterated first. consider() de-dupes by node, so being tried last
       means they only ever label what no named selector recognised. The label is
       provenance (it rides along as the chart's `source`, and shows up in the console
       line and in merchant support threads); it gates nothing, which is why this is
       worth getting right but not worth a scoring rule. */
    ["container", [
      '[id*="size-chart" i]', '[id*="size-guide" i]',
      '[class*="size-chart" i]', '[class*="size-guide" i]'
    ]]
  ];

  /* THE PAGE'S OWN SIZE CHART, or null. Two tiers, strongest first, exactly mirroring
     extractHostSizes()/extractSoldOutSizes() above.
     @returns {{unit:"cm", source:string, rows:Array<object>}|null} */
  function extractSizeChart() {
    try {
      var candidates = [], nodes = [], i, j, k, m;

      function consider(table, source, bonus) {
        if (!table || nodes.indexOf(table) !== -1) return;
        if (candidates.length >= SIZE_CHART_MAX_TABLES) return;
        nodes.push(table);
        candidates.push({ table: table, source: source, bonus: bonus });
      }

      for (i = 0; i < SIZE_CHART_CONTAINERS.length; i++) {
        var platform = SIZE_CHART_CONTAINERS[i][0], sels = SIZE_CHART_CONTAINERS[i][1];
        for (j = 0; j < sels.length; j++) {
          var hosts;
          /* Per-selector try/catch: one selector an older engine refuses to parse must
             not take the other twenty-nine with it. */
          try { hosts = d.querySelectorAll(sels[j]); } catch (e) { continue; }
          for (k = 0; k < hosts.length; k++) {
            var inner = hosts[k].querySelectorAll ? hosts[k].querySelectorAll("table") : [];
            /* A container that IS the chart, laid out without a <table> at all, is not
               readable here and deliberately yields nothing rather than a guess. */
            for (m = 0; m < inner.length; m++) consider(inner[m], platform, 6);
          }
        }
      }

      /* Tier 2 - the universal fallback. Every remaining table on the page, judged
         purely on its own content by sizeChartFromGrid(). */
      var all = d.querySelectorAll ? d.querySelectorAll("table") : [];
      for (i = 0; i < all.length; i++) consider(all[i], "generic", 0);

      var best = null, bestScore = 0;
      for (i = 0; i < candidates.length; i++) {
        var cand = candidates[i], rows;
        try {
          rows = sizeChartFromGrid(sizeChartOrient(sizeChartGrid(cand.table)),
            sizeChartTableUnit(cand.table));
        } catch (e) { continue; }
        if (!rows) continue;
        var measured = 0;
        for (j = 0; j < rows.length; j++) {
          if (rows[j].minChest != null || rows[j].minWaist != null ||
              rows[j].minHips != null || rows[j].minLegs != null) measured++;
        }
        var score = cand.bonus + measured;
        if (score > bestScore) { bestScore = score; best = { source: cand.source, rows: rows }; }
      }

      if (!best) {
        console.log("[PEAR widget] no readable size chart on this page - the room keeps its default matrix");
        return null;
      }
      console.log("[PEAR widget] size chart read from the PDP (" + best.source + "):",
        best.rows.length + " row(s):", best.rows.map(function (r) { return r.size; }).join("/"));
      return { unit: "cm", source: best.source, rows: best.rows };
    } catch (e) {
      /* CLAUDE.md §2.5 - the room keeps its own vetted matrix, the shopper keeps their
         recommendation, and nothing about this feature can stop a sale. */
      console.log("[PEAR widget] size-chart scrape failed, using the default size matrix:", e && e.message);
      return null;
    }
  }

  /* ── THE WIRE FORMAT ─────────────────────────────────────────────────────────────
         <unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:...
         each measurement ::= "min-max", or "" when this chart doesn't publish it
     e.g. cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::

     COMPACT, NOT JSON, because this rides the iframe URL alongside the image URLs:
     ~25 chars a row, ~160 for a six-row chart, versus ~700 URL-encoded as JSON.

     CROSS-FILE LOCKSTEP (CLAUDE.md §3). The decoder is parseStoreSizeChart() in
     lib/sizing.js (server-side since 2026-09-26 - the room forwards this string raw).
     They are one format and must be edited in the same commit;
     test/size-chart-overlay.test.mjs round-trips this encoder's own output through
     that decoder for exactly that reason.
     @returns {string} "" when there is nothing to send */
  function encodeSizeChart(chart) {
    if (!chart || !chart.rows || !chart.rows.length) return "";
    function band(row, key) {
      var lo = row["min" + key], hi = row["max" + key];
      return (typeof lo === "number" && typeof hi === "number" && isFinite(lo) && isFinite(hi))
        ? lo + "-" + hi : "";
    }
    var parts = [];
    for (var i = 0; i < chart.rows.length; i++) {
      var r = chart.rows[i];
      /* A size token with no measurement at all is dropped rather than shipped as
         "M:::" - the room would index it, find nothing to overlay, and clone a row for
         no reason. */
      var cells = [band(r, "Chest"), band(r, "Waist"), band(r, "Hips"), band(r, "Legs")];
      if (!cells.join("")) continue;
      parts.push(r.size + ":" + cells.join(":"));
    }
    if (!parts.length) return "";
    return (chart.unit || "cm") + ";" + (chart.source || "generic") + ";" + parts.join("|");
  }

  function optionValueAt(variant, idx) {
    if (idx === 0) return variant && variant.option1;
    if (idx === 1) return variant && variant.option2;
    if (idx === 2) return variant && variant.option3;
    return undefined;
  }

  /* THE BUG THIS CLOSES: the fitting room's own size selector (setSizeOverride() in
     app.js) lets a shopper try on a DIFFERENT size than whatever the store's PDP had
     selected - pearGetActiveGarment() already reports that live choice correctly, but
     nothing previously re-resolved WHICH SHOPIFY VARIANT that size corresponds to, so
     /cart/add.js kept receiving the id captured off the PDP at handoff time. A shopper
     who tried on M, saw L recommended, switched in-room, and clicked Add to Cart got M
     silently added while the toast said success.

     sizeOptionIndex is read from the product's own DECLARED option name (see
     loadShopifyProductJSON above) - never assumed to be option1, since merchants order
     Size/Colour/Material differently. fallbackVariantId (the id captured off the DOM/
     PDP, still correct for every OTHER dimension - colour, material) anchors which of
     several same-size variants to pick when the product has more than one option;
     without it, any variant matching the size wins, which is still strictly better
     than never re-resolving at all. Returns null - never a guess - when there's no
     declared Size option, no variants loaded yet, or no size string to match. */
  function findVariantForSize(variants, sizeOptionIndex, size, fallbackVariantId) {
    if (sizeOptionIndex < 0 || !variants || !variants.length) return null;
    var target = normalizeSizeToken(size);
    if (!target) return null;

    var current = fallbackVariantId != null
      ? variants.filter(function (v) { return String(v.id) === String(fallbackVariantId); })[0]
      : null;

    function otherOptionsMatch(v) {
      if (!current) return true;
      for (var i = 0; i < 3; i++) {
        if (i === sizeOptionIndex) continue;
        if (normalizeSizeToken(optionValueAt(v, i)) !== normalizeSizeToken(optionValueAt(current, i))) return false;
      }
      return true;
    }

    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (normalizeSizeToken(optionValueAt(v, sizeOptionIndex)) === target && otherOptionsMatch(v)) return v;
    }
    return null;
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
  /* Kept in lockstep with fitting-room/app.js - see the long comments there for WHY each
     of these is what it is. Short version: the old build painted a #e8e8e8 line down a
     #3a3a3a gutter and stamped the FRONT/BACK markers on top of the garments. Those were
     the two highest-contrast features in the reference, and Lucy - which samples texture
     from that reference with no notion of canvas furniture - reproduced them as dark
     seams and text on the shopper's clothing. Now: nothing is drawn in the gutter, it is
     filled with the packshots' own sampled backdrop, and the markers live in a band below
     every garment pixel. */
  var COMPOSITE_MAX_W   = 2048;
  var COMPOSITE_DIVIDER = 0;      // 0 = seamless gap (default). >0 = subtle divider width in px.
  var COMPOSITE_GUTTER  = 96;
  var COMPOSITE_LABELS  = true;   // false → no markers at all, purely positional left/right
  var COMPOSITE_LABEL_BAND = 0.11;

  /* Median corner colour across both packshots - the gutter/background fill, so the join
     between the panels has no edge in it. Median over 8 corner samples so one shadowed or
     watermarked corner cannot skew it. Falls back to a light neutral (never the old dark
     grey) when the pixels cannot be read. Mirrors sampleBackdrop() in app.js. */
  function sampleBackdrop(imgs) {
    var px = [];
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i], w = img.width, h = img.height;
      if (!w || !h) continue;
      try {
        var c = d.createElement("canvas");
        c.width = w; c.height = h;
        var cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        var inset = Math.max(1, Math.round(Math.min(w, h) * 0.02));
        var corners = [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset]];
        for (var k = 0; k < corners.length; k++) {
          var x = Math.min(w - 1, Math.max(0, corners[k][0]));
          var y = Math.min(h - 1, Math.max(0, corners[k][1]));
          var dd = cx.getImageData(x, y, 1, 1).data;
          px.push([dd[0], dd[1], dd[2]]);
        }
      } catch (_) { /* tainted or unreadable - skip this source */ }
    }
    if (!px.length) return { fill: "#f2f2f2", contrast: "#101010" };
    function median(idx) {
      var v = px.map(function (p) { return p[idx]; }).sort(function (a, b) { return a - b; });
      var m = Math.floor(v.length / 2);
      return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
    }
    var rgb = [median(0), median(1), median(2)];
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return {
      fill: "rgb(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ")",
      contrast: lum > 0.5 ? "#101010" : "#f5f5f5"
    };
  }

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
        // Label band sits BELOW the panels, so the canvas is taller than the garments.
        var labelBand = COMPOSITE_LABELS ? Math.round(panelH * COMPOSITE_LABEL_BAND) : 0;
        var scale  = Math.min(1, COMPOSITE_MAX_W / totalW);
        var W = Math.round(totalW * scale), H = Math.round((panelH + labelBand) * scale);
        var fW = Math.round(frontW * scale), bW = Math.round(backW * scale);
        var gut = Math.round(COMPOSITE_GUTTER * scale);
        var pH = H - Math.round(labelBand * scale);   // panel height, excluding the band

        /* Sampled backdrop, not a fixed grey: the gutter ends up the same colour as the
           background already inside each panel, so the two halves meet with no visible
           edge and there is no seam for the model to paint onto the shopper. Sampled
           before the output canvas is allocated - it uses scratch canvases of its own. */
        var backdrop = sampleBackdrop([front, back]);

        var canvas = d.createElement("canvas");
        canvas.width = W; canvas.height = H;
        var ctx = canvas.getContext("2d");

        ctx.fillStyle = backdrop.fill;
        ctx.fillRect(0, 0, W, H);

        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, fW, pH); ctx.clip();
        drawCover(ctx, front, 0, 0, fW, pH);
        ctx.restore();

        var backX = fW + gut;
        ctx.save(); ctx.beginPath(); ctx.rect(backX, 0, bW, pH); ctx.clip();
        drawCover(ctx, back, backX, 0, bW, pH);
        ctx.restore();

        // Divider OFF by default; when re-enabled it is a faint tint of the backdrop's
        // contrast ink, never a hard grey bar that can invert on a dark shoot.
        if (COMPOSITE_DIVIDER > 0) {
          var dividerW = Math.max(1, Math.round(COMPOSITE_DIVIDER * scale));
          ctx.fillStyle = backdrop.contrast;
          ctx.globalAlpha = 0.28;
          ctx.fillRect(Math.round(fW + gut / 2 - dividerW / 2), 0, dividerW, pH);
          ctx.globalAlpha = 1;
        }

        var fontPx = Math.max(18, Math.round(W * 0.035));
        if (COMPOSITE_LABELS) {
          // Centred in the band UNDER the panels - never over a garment pixel.
          var labelY = pH + Math.round((H - pH) / 2 - fontPx * 0.82);
          drawLabel(ctx, "FRONT", Math.round(fW / 2), labelY, fontPx);
          drawLabel(ctx, "BACK",  Math.round(backX + bW / 2), labelY, fontPx);
        }

        if (front.close) front.close();
        if (back.close) back.close();

        // toDataURL throws SecurityError on a tainted canvas - which is exactly what
        // the CORS-proxied fetch above prevents. Caught so a taint never breaks the
        // try-on; the caller falls back to the two-URL handover.
        var dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        console.log("[PEAR] COMBINED composite built: " + W + "×" + H +
          " · FRONT " + fW + "px | BACK " + bW + "px · backdrop " + backdrop.fill +
          " · divider " + (COMPOSITE_DIVIDER > 0 ? COMPOSITE_DIVIDER + "px" : "none (seamless)") +
          " · labels " + (COMPOSITE_LABELS ? "below panels" : "off") +
          " · " + Math.round(dataUrl.length / 1365) + "KB");
        return {
          url: dataUrl,
          /* The contract, as drawn. front_x < back_x is what makes "LEFT PANEL = FRONT"
             true; the fitting room asserts exactly that to Decart and warns if this says
             otherwise. panel_h is the garment region's height - anything below it is the
             label band, which carries no garment and must never be sampled as one. */
          layout: {
            w: W, h: H,
            front_x: 0,     front_w: fW,
            back_x:  backX, back_w:  bW,
            panel_h: pH,
            divider_x: Math.round(fW + gut / 2),
            seamless: COMPOSITE_DIVIDER === 0,
            labels: COMPOSITE_LABELS ? "below" : "none"
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
    var hostSizeRunType = classifySizeRunType(extractHostSizes());
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: urls,
        front_image_url: (hint && hint.front) || urls[0] || "",
        back_image_url: scrapedBack,
        synthesize_back: !scrapedBack,
        page_url: w.location ? w.location.href : "",
        store_key: STORE_KEY || undefined,
        /* THIS PAGE's own scrape, sent so the server can CACHE it against page_url
           (garment_cache.size_run_type - see archive/supabase_setup_v14.sql) for a
           future visit where the size picker fails to scrape (a JS-rendered control
           not yet hydrated). Omitted on "unknown" - never cache a guess, only a
           confidently-read run. */
        size_run_type: hostSizeRunType !== "unknown" ? hostSizeRunType : undefined
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("classify-images HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      return {
        results: (data && data.results) || [],
        front: (data && data.front_image_url) || "",
        back: (data && data.back_image_url) || "",
        backSource: (data && data.back_source) || "none",
        // Per-product kids/adult verdict from the same classify call. "uncertain" on
        // an older server build that doesn't send it yet, same as an unresolved one.
        ageGroup: (data && data.age_group) || "uncertain",
        ageGroupConfidence: (data && data.age_group_confidence) || 0,
        /* Numeric-vs-alphabetic verdict for THIS product. THIS page's own scrape wins
           when it read one (see hostSizeRunType above) - the server only ever echoes
           that back or falls to a cache learned on a PREVIOUS visit, so preferring the
           live read here is never wrong and skips a needless round trip through the
           echo. "unknown" when neither this scrape nor the cache has an answer. */
        sizeRunType: hostSizeRunType !== "unknown" ? hostSizeRunType
          : ((data && data.size_run_type) || "unknown"),
        /* Main-fabric colour sampled from the FRONT photo by the same classify call
           (server.js: primary_color_hex). "" on an older server build that does not
           send it, which the room treats identically to "could not sample" - the
           colour clause simply does not ship. Never defaulted to a colour. */
        colorHex: (data && data.primary_color_hex) || "",
        /* The FRONT photo's garment lettering, from the same classify call. The room
           asserts this as the chest print in its P.CORE identity lock, and only on the
           FRONT angle - see identityLockSentence() in app.js for why naming front
           lettering while rendering the back is the original double-print bug. */
        textOcr: (data && typeof data.front_text_ocr === "string") ? data.front_text_ocr : "",
        /* true/false/null - is the resolved REAR blank? The room uses this to pick a
           plain-back anchor instead of one that names "rear print, logos", which on a
           blank back is an instruction to invent graphics. `null` when the server did
           not answer (or is an older build) and must NOT be read as false. */
        backIsPlain: (data && typeof data.back_is_plain === "boolean") ? data.back_is_plain : null
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

  /* Max time to wait for the fitting room to ack PEAR_TEARDOWN (stop its camera +
     WebRTC session) before force-removing its iframe anyway - never let a close
     action hang on a child that fails to respond. */
  var TEARDOWN_ACK_TIMEOUT_MS = 250;

  function closeModal() {
    var overlay = activeOverlay;
    var iframe = activeIframe;
    activeOverlay = null;
    activeIframe = null;
    if (escHandler) {
      d.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    stopCartWatch();   // nothing in PEAR needs a live cart mirror while it's closed

    if (!overlay) return;

    var removed = false;
    function removeOverlay() {
      if (removed) return;
      removed = true;
      w.removeEventListener("message", onAck);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onAck(e) {
      if (iframe && e.source === iframe.contentWindow &&
          e.data && e.data.type === "PEAR_TEARDOWN_ACK") {
        removeOverlay();
      }
    }

    /* Tell the fitting room to release its camera/WebRTC session BEFORE its iframe
       is torn down - a plain removeChild() doesn't reliably fire the child's own
       unload/pagehide handlers, and even when it does, the room's internal
       teardown() intentionally leaves the camera running (it's built for in-page
       garment swaps, not a full exit). Keep the iframe attached until the child
       acks or the fallback timeout fires, whichever is first, so a re-opened
       fitting room never inherits a still-locked camera device. */
    try {
      if (iframe && iframe.contentWindow) {
        w.addEventListener("message", onAck);
        iframe.contentWindow.postMessage({ type: "PEAR_TEARDOWN" }, "*");
      }
    } catch (e) {}

    w.setTimeout(removeOverlay, TEARDOWN_ACK_TIMEOUT_MS);
  }

  /* Swipe-to-dismiss from INSIDE the room. On a phone the modal is the whole
     viewport and the only way out was the small × in its corner; the room's
     Screen-1 card now carries a drag handle, and a completed downward swipe posts
     PEAR_CLOSE_REQUEST here (fitting-room/sheet-gestures.js). It runs the same
     closeModal() as × / Esc / backdrop - PEAR_TEARDOWN ack included - so a swipe
     can never leave the camera or the WebRTC session running behind a closed modal.
     Honoured ONLY from the iframe this widget itself opened: the origin check is
     the same one every other room message gets, and the source check stops any
     other PEAR frame on the page from closing this one. */
  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.type !== "PEAR_CLOSE_REQUEST") return;
    if (!activeIframe || e.source !== activeIframe.contentWindow) return;
    console.log("[PEAR widget] fitting room requested close (" + (e.data.source || "unknown") + ")");
    closeModal();
  });

  function openModal(garment) {
    closeModal(); // never stack two modals

    /* A generated rear view is a data: URL - far past any browser's URL length limit,
       and it would be re-encoded into the iframe src for nothing. Those only ever
       travel via the PEAR_UPDATE_GARMENT postMessage correction (structured clone,
       no length limit); the query string carries http(s) URLs only. */
    var backParam = (garment.back && !/^data:/i.test(garment.back)) ? garment.back : "";
    var hostSizes = extractHostSizes();
    var hostSizeRunType = classifySizeRunType(hostSizes);
    var hostSoldOut = extractSoldOutSizes();
    /* READ HERE AND NOWHERE EARLIER - see extractSizeChart()'s "PASSIVE, AND LAZY"
       note. This is the first moment the shopper has asked for anything, so a DOM walk
       costs them nothing they did not request, and the page-load path stays untouched. */
    var hostSizeChart = encodeSizeChart(extractSizeChart());
    console.log("[PEAR widget] host product sizes:", hostSizes.length ? hostSizes.join("/") : "(none readable)",
      "| run type:", hostSizeRunType,
      "| sold out:", hostSoldOut.length ? hostSoldOut.join("/") : "(none detected)",
      "| size chart:", hostSizeChart || "(none readable - the room keeps its default matrix)");

    var params =
      "garment_url=" + encodeURIComponent(garment.url) +
      "&garment_type=" + encodeURIComponent(garment.type) +
      "&garment_name=" + encodeURIComponent(garment.name) +
      /* v2 alias for the same string. parseHandoff() prefers ?garment_title= and falls
         back to ?garment_name=, so both builds of the widget work either way - the same
         both-spellings contract front_image_url/garment_url already have below.

         IT IS THE SIZE CALCULATOR THAT NEEDS THIS, not the focus bar. isPantsProduct()
         in the fitting room reads the title to decide whether the shopper is sized
         against a WAIST chart or the chest-banded letter chart, and that runs on
         Screen 1 - so the title has to travel on the URL at open, not arrive later with
         the PEAR_UPDATE_GARMENT correction. A jeans product whose size picker is
         rendered in JavaScript (nothing for extractHostSizes() to scrape) has its title
         as the only evidence there is. */
      "&garment_title=" + encodeURIComponent(garment.name) +
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
      /* ── THE CLASSIFICATION GATE ──────────────────────────────────────────────────
         garment_url above is imgs[0] - the first gallery photo in DOM ORDER, scraped
         off the PDP and validated by NOBODY. Merchants routinely lead with the most
         striking photo, which is often the BACK. The room binds whatever arrives here
         as the front reference, so on such a product it goes live rendering the back
         graphic on the shopper's chest until the classifier's correction lands
         (reported on the PEAK tee at 00:00-00:02).
         This tells the room a verdict is coming so it can block try-on until then. Sent
         ONLY when a classify call is genuinely about to run - a single-image product
         with nothing to resolve must not arm a gate that will only ever time out. */
      (garment.classifyPending ? "&classify_pending=1" : "") +
      (garment.variantId ? "&garment_variant_id=" + encodeURIComponent(garment.variantId) : "") +
      /* The product's REAL size list - the fitting room's PRIMARY kids/adult signal
         (see extractHostSizes / isKidsProduct there). Sent at open so the guard and the
         size selector are correct on the very first paint, not only after the classify
         round trip lands. */
      (hostSizes && hostSizes.length ? "&garment_sizes=" + hostSizes.map(encodeURIComponent).join(",") : "") +
      /* Which of those sizes the PDP is already showing as gone. Sent at open for the
         same reason garment_sizes is - calculateSize() paints its recommendation on
         Screen 1, before any round trip lands, and a recommendation that appears first
         and is corrected to "sold out" a second later is worse than either answer on
         its own. OMITTED when nothing is sold out, so an absent param reads as "no
         stock evidence" rather than as a claim; both render identically (every size
         available), which is what makes the omission safe. */
      (hostSoldOut && hostSoldOut.length ? "&garment_soldout=" + hostSoldOut.map(encodeURIComponent).join(",") : "") +
      /* Numeric-vs-alphabetic verdict on that same list, sent at open for the same
         reason garment_sizes is: calculateSize() runs on Screen 1, before the classify
         round trip lands. Omitted on "unknown" - an absent param reads as "no run-type
         evidence" the same way an absent garment_sizes does, never as a claim. */
      (hostSizeRunType !== "unknown" ? "&garment_size_type=" + hostSizeRunType : "") +
      /* THE STORE'S OWN SIZE CHART, compact-encoded (see encodeSizeChart's format
         block). Sent at open for the same reason garment_sizes is: calculateSize()
         paints its recommendation on Screen 1, and a returning shopper with a saved
         profile is routed straight past Screen 1 by routeUser()'s instant-skip path -
         a chart that only arrived with the PEAR_UPDATE_GARMENT correction would land
         after the recommendation was already computed and shown.
         OMITTED when nothing was readable, so an absent param reads as "no chart
         evidence" rather than as a claim; the room then uses its own vetted matrix,
         which is exactly the behaviour that shipped before this existed. */
      (hostSizeChart ? "&garment_size_chart=" + encodeURIComponent(hostSizeChart) : "") +
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
      // Belt-and-suspenders initial sync: the fitting room ALSO pulls one itself
      // via PEAR_CART_REQUEST_SYNC once its own cart UI is ready (the more
      // robust path, since it can't race its own message listener wiring up
      // by construction) - this push just covers the gap either way.
      pushCartSync(iframe.contentWindow);
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
    startCartWatch(iframe);   // live-mirror host cart changes for as long as this modal is open
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
    '[data-button-action="add-to-cart"]',
    /* "Bag"/"basket" storefronts. adidas.co.il - the store this widget's SFCC handling
       was written for - labels its button "Add to Bag", and so do Nike and ASOS; M&S and
       much of UK retail say "Add to basket". NO tier here matched any of them, so those
       PDPs fell through to injectFallbackButton() (an <h1> button, or a floating one)
       instead of a button beside the real control. */
    ".add-to-bag",
    ".add-to-basket"
  ].join(", ");
  var ATC_TEXTS = [
    "add to cart", "add to bag", "add to basket",
    "הוסף לסל", "הוסף לעגלה", "buy now", "קנה עכשיו"
  ];

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
    if (!root || !root.querySelectorAll) return null;
    /* 1. The theme's own product-image selectors - the first match that carries a URL
          and is not another product's tile nested in this root. */
    var sel = root.querySelectorAll(PRODUCT_IMG_SELECTORS);
    for (var s = 0; s < sel.length; s++) {
      var el = sel[s];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (el && el.tagName === "IMG" && bestImageUrl(el, DECLARED) && !inForeignProductScope(el, root)) return el;
    }
    /* 2. schema.org microdata: itemprop="image" is the page marking its own product photo
          (SFCC/SFRA tags every gallery <img>). Preferred over raw size. */
    var ip = root.querySelectorAll('img[itemprop="image"]');
    for (var p = 0; p < ip.length; p++) {
      if (isProductPhotoCandidate(ip[p], root, DECLARED)) return ip[p];
    }
    /* 3. else the largest product-photo candidate inside this container (collection cards
          rarely use the PDP selectors above, so size is the reliable signal). Having a URL
          was the ONLY test here before, which is how the adidas.co.il wishlist heart won:
          it was the sole <img> in the tightest ancestor of "Add to Bag". Now a candidate is
          never chrome, never another product's tile, never a visibly glyph-sized image -
          see isProductPhotoCandidate(). */
    var imgs = root.querySelectorAll("img");
    var best = null, bestArea = -1;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (!isProductPhotoCandidate(im, root)) continue;
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
          Vetted by pageOgImage(): a logo/SVG og:image, or one the page's own
          single-product JSON-LD contradicts, is skipped.
       2. Known single-product gallery containers (PRODUCT_GALLERY_SELECTORS) -
          same page-wide caveat as above. The first USABLE match: a URL-less first
          element used to end the search.
       3. schema.org JSON-LD Product.image - the platform-agnostic tier for a store
          whose theme none of the selectors know (see jsonLdProductImages(); it
          answers only on a single-product page, so grids are unaffected).
     Returns "" when none is present, so the caller falls back to the
     per-button ancestor walk-up, which is the only signal actually scoped to
     ONE product and so remains the resolver for collection/grid pages. */
  function resolvePrimaryProductImage() {
    var ogUrl = pageOgImage();
    if (ogUrl) return ogUrl;

    var sel = d.querySelectorAll(PRODUCT_GALLERY_SELECTORS);
    for (var i = 0; i < sel.length; i++) {
      var el = sel[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG" || inForeignProductScope(el, d)) continue;
      var src = bestImageUrl(el);
      if (src) return src;
    }

    var ld = jsonLdProductImages();
    if (ld.length) {
      console.log("[PEAR] primary product image from JSON-LD:", abbrevUrl(ld[0]));
      return ld[0];
    }
    return "";
  }

  function findGarmentForButton(btn) {
    // Priority 1/2/3 - og:image, known product-gallery containers, JSON-LD
    // (see resolvePrimaryProductImage).
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
        if (url && !isExcludedSrc(url, { name: productNameHint() })) {
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
          back: openBack, images: imgs, variantId: garment.variantId,
          /* A classify call runs immediately below, so the room must treat imgs[0] as a
             GUESS and block try-on until the verdict lands. Mirrors the condition that
             actually gates the call, rather than being hardcoded true: if this ever
             stops matching, the room waits for a message nobody sends. */
          classifyPending: imgs.length > 0
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
              /* WORDING CORRECTED - the old line read "handing the single composite to
                 the try-on engine", which is not what happens and cost real debugging
                 time: a reviewer read this log, opened the two-panel image it refers to,
                 and reasonably concluded Decart was being conditioned on it. It is not.
                 The room gates the composite behind compositeActiveFor(), which requires
                 COMPOSITE_MODE - and COMPOSITE_DEFAULT is false (see app.js: a split
                 FRONT|BACK reference with no panel contract renders fragments of both,
                 commit 23f5953). With the default in force this composite is used for
                 the "Now fitting" thumbnail and as a ?composite=1 opt-in only; the actual
                 reference is a SINGLE-VIEW asset the OrientationWatcher swaps. Say what
                 is true, so the next person reads the right file. */
              console.log("[PEAR widget] composite built and sent (thumbnail + ?composite=1 opt-in; " +
                "the live reference stays single-view unless COMPOSITE_MODE is on)");
            }
            /* Only push a correction if this actually changes what the room is showing,
               and only into the SAME modal that triggered the call (the shopper may have
               closed it, or opened a different product, in the meantime). */
            if (activeIframe !== openedIframe) return;
            /* ── THE VERDICT MUST ALWAYS BE ANNOUNCED, EVEN WHEN IT CHANGES NOTHING ──
               This early-return exists so a verdict that AGREES with the DOM-order guess
               does not churn the room's reference for no reason - re-anchoring
               mid-session renders a generic garment, so the optimisation is correct and
               stays. What it must NOT do any more is stay silent: the room now blocks
               try-on until it hears a verdict (?classify_pending=1), and on a
               well-marked-up store "the classifier agreed" is the COMMON path - so
               returning here without a word left the gate to sit until its 30s timeout
               on exactly the products that were never at risk.
               A bare ready signal carries no garment fields, so the room releases the
               gate and returns without touching activeItem. Nothing is re-anchored. */
            if (!composite && frontUrl === imgs[0] && backUrl === openBack) {
              console.log("[PEAR widget] classifier agreed with the DOM-order guess - " +
                "sending a bare ready signal (no re-anchor)");
              try {
                openedIframe.contentWindow.postMessage(
                  { type: "PEAR_UPDATE_GARMENT", garment_classify_done: true }, PEAR_BASE);
              } catch (e) {
                console.warn("[PEAR widget] ready signal failed to post:", e && e.message);
              }
              return;
            }
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
                garment_images: sorted,
                // Kids/adult verdict for this product, resolved server-side from the
                // same classify call. "uncertain" is sent explicitly (not omitted) so
                // the fitting room can tell "we checked and don't know" apart from
                // "this correction predates the field existing".
                garment_age_group: res.ageGroup,
                garment_age_group_confidence: res.ageGroupConfidence,
                /* Numeric-vs-alphabetic size-run verdict for this product (this page's
                   own scrape, or a cache hit from a previous visit - see classifyImages()).
                   Sent as "unknown" explicitly, not omitted, mirroring garment_age_group
                   above: the room tells "checked, no answer" apart from "correction
                   predates this field". Re-sent alongside garment_sizes for the same
                   reason - a size list that scrapes in late still needs its run type. */
                garment_size_type: res.sizeRunType,
                /* Sampled main-fabric colour for THIS product. Sent so the room can
                   name the colour in the prompt instead of relying on the anchor's
                   generic "preserve the original color" - the black/yellow
                   hallucination report. Omitted (not ""-ed) when unsampleable, so the
                   room's own `typeof === "string"` check distinguishes "no value" from
                   a value; a colour this pipeline guessed would be stated to Decart
                   with the same authority as a measured one. */
                garment_color_hex: res.colorHex || undefined,
                /* The garment's own lettering, transcribed from the FRONT photo. Sent as
                   "" when the garment is genuinely plain (a real answer), omitted only
                   when the server never answered - the room distinguishes the two. */
                garment_text_ocr: typeof res.textOcr === "string" ? res.textOcr : undefined,
                /* Whether the rear is positively known blank. Omitted (not false-d) when
                   unknown, so the room can abstain rather than assume. */
                garment_back_is_plain: typeof res.backIsPlain === "boolean" ? res.backIsPlain : undefined,
                /* Re-sent alongside the verdict above, and OUTRANKING it in the room.
                   The Shopify product JSON is fetched at boot but can resolve after the
                   modal already opened, so this is the delivery for a size list that
                   wasn't readable yet at open time. */
                garment_sizes: extractHostSizes(),
                /* Stock for that same list, re-read HERE rather than reused from the
                   open URL. The Shopify product JSON is fetched at boot and routinely
                   resolves after the modal opened, so at open time the DOM tier may
                   have been the only thing readable (or nothing was) - this is the
                   delivery for the authoritative variant-level answer. Sent as an ARRAY
                   always, including the empty one: unlike the URL param, an empty array
                   here is a real message ("re-checked, nothing is sold out") that must
                   be able to CLEAR a stale strike-through from the open-time scrape. */
                garment_soldout: extractSoldOutSizes(),
                /* The store's own size chart, RE-READ here rather than reused from the
                   open URL. A size-guide modal is routinely rendered by the theme's JS
                   (or fetched into a drawer) and can hydrate well after the shopper
                   clicked, so this is the delivery for a chart that was not in the DOM
                   at open time. Sent as a STRING ALWAYS, including "" - unlike the URL
                   param, an empty string here is a real message ("re-checked, this page
                   publishes no chart we can read") that must be able to CLEAR a chart
                   the open-time scrape got wrong, the same argument garment_soldout's
                   always-sent array makes one field up. */
                garment_size_chart: encodeSizeChart(extractSizeChart()),
                /* Re-sent with the correction, not only on the open URL. The PDP heading
                   can still be a skeleton placeholder at open on a JS-rendered store, so
                   this is the more accurate reading of the two and the room overwrites
                   pendingTitle with it - see its "A LATE TITLE" note. */
                garment_title: getGarmentName()
              }, PEAR_BASE);
            } catch (_) {}
          });
        }).catch(function (err) {
          console.warn("[PEAR widget] combined pipeline failed, using DOM order as-is:", err && err.message);
          /* ── TELL THE ROOM ANYWAY, OR THE GATE WAITS OUT ITS FULL TIMEOUT ──────────
             The room blocks try-on until it hears a verdict (?classify_pending=1). A
             failed classify is still an answer to "is one coming?" - it is just a
             negative one - and staying silent here would make every classify failure
             cost the shopper a 30s dead button before the backstop timer released it.
             The room proceeds on the unvalidated DOM-order guess, which is exactly the
             behaviour that shipped before the gate existed (CLAUDE.md 2.5: never block
             on ambiguity; a wrong block stops a paying shopper).
             Still guarded on the SAME modal - the shopper may have closed it or opened
             a different product while the request was in flight. */
          if (activeIframe !== openedIframe) return;
          try {
            openedIframe.contentWindow.postMessage(
              { type: "PEAR_UPDATE_GARMENT", garment_classify_done: true }, PEAR_BASE);
          } catch (e) {
            console.warn("[PEAR widget] ready signal failed to post after error:", e && e.message);
          }
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

  /* ── Host Store Cart Integration ───────────────────────────────────────────
     Fitting room's "הוסף לסל" button posts PEAR_ADD_TO_CART on click (see
     lux-interactions.js's land()) so the actual cart mutation happens on the
     HOST page, where the store's real cart session/cookies/endpoint live.
     Three tiers, tried in order, so this widget works out of the box on
     Shopify (the one platform most PEAR merchants run today) while staying
     honest about what it can and can't know on an arbitrary/private stack:

       1. SHOPIFY - the one add-to-cart contract that's public, stable, and
          safe to call blind: POST /cart/add.js.
       2. MERCHANT HOOK (window.PEAR_CART_CONFIG.addToCart) - an opt-in
          extensibility point a merchant on Magento, a custom engine, or any
          platform without a public/stable add-to-cart endpoint (Fox,
          Terminal X, and most Israeli retail stacks fall here) wires up ONCE
          during onboarding, pointing at whatever their real cart mutation
          actually is: window.PEAR_CART_CONFIG = { addToCart(payload) {...} }.
          We never guess a private endpoint/CSRF scheme on a merchant's
          behalf - a wrong guess can silently "succeed" against the wrong
          request, which is worse than not trying at all.
       3. BROADCAST (window.dispatchEvent(new CustomEvent("pear:addToCart"))) -
          fired unconditionally, regardless of (1)/(2)'s outcome, so a
          store's own theme/app code (its mini-cart, an analytics listener,
          anything) can react live with zero PEAR-side platform-specific code.

     Feedback Sync: whichever tier actually confirms the add (or the final
     failure) drives a PEAR_ADD_TO_CART_RESULT reply back to the iframe -
     lux-interactions.js listens for it and only ever corrects its optimistic
     "added to cart" toast on an explicit, reported failure. */
  function detectCartPlatform() {
    if (w.Shopify || d.querySelector('script[src*="cdn.shopify.com"]') ||
        d.querySelector('meta[name="shopify-digital-wallet"]')) {
      return "shopify";
    }
    /* A merchant may only need to implement a subset of the hook (e.g.
       getCart + removeFromCart but not addToCart) - any one of the three is
       enough to count as "custom" so the others still get tried. */
    if (w.PEAR_CART_CONFIG && (typeof w.PEAR_CART_CONFIG.addToCart === "function" ||
        typeof w.PEAR_CART_CONFIG.getCart === "function" ||
        typeof w.PEAR_CART_CONFIG.removeFromCart === "function")) {
      return "custom";
    }
    return "unknown";
  }

  function addToShopifyCart(payload) {
    return fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: payload.variantId, quantity: payload.quantity || 1 })
    }).then(function (r) {
      if (!r.ok) throw new Error("cart/add.js HTTP " + r.status);
      return r.json();
    });
  }

  function addToHostCart(payload, platform) {
    var attempt;
    if (platform === "shopify" && payload.variantId) {
      attempt = addToShopifyCart(payload);
    } else if (platform === "custom") {
      attempt = Promise.resolve(w.PEAR_CART_CONFIG.addToCart(payload));
    } else {
      attempt = Promise.reject(new Error("no known host cart integration (platform: " + platform + ")"));
    }

    /* Broadcast regardless of the outcome above - a theme's own mini-cart/
       analytics code may listen for this independent of whether OUR request
       above succeeded (their own listener might BE the real add-to-cart action). */
    if (w.CustomEvent) {
      w.dispatchEvent(new w.CustomEvent("pear:addToCart", { detail: payload }));
    }
    return attempt;
  }

  /* ── Full Bi-directional Cart Sync ─────────────────────────────────────────
     Reads and mirrors the HOST cart (the same one the shopper's Shopify/host
     session already owns) into PEAR's own cart UI, and mirrors deletions the
     other way. Same three-tier honesty as addToHostCart above: Shopify's
     /cart.js and /cart/change.js are the one public, stable, safe-to-call-
     blind contract; window.PEAR_CART_CONFIG.getCart()/removeFromCart() is the
     merchant-provided hook for Magento/Fox/Terminal X/custom stacks; an
     unrecognized platform gets NO sync at all rather than a fabricated
     "empty cart" - a false empty is worse than staying silent. */
  function normalizeShopifyCart(raw) {
    var items = ((raw && raw.items) || []).map(function (it) {
      return {
        key: it.key,
        variantId: it.variant_id || it.id,
        sku: it.sku || "",
        title: it.product_title || it.title || "",
        /* Shopify's own placeholder for a product with no real variants -
           not meaningful to show as a cart-line detail. */
        variantTitle: (it.variant_title && it.variant_title !== "Default Title") ? it.variant_title : "",
        image: it.image || "",
        price: it.price,
        quantity: it.quantity
      };
    });
    return {
      items: items,
      itemCount: raw && typeof raw.item_count === "number" ? raw.item_count : items.length,
      totalPrice: raw && raw.total_price,
      empty: items.length === 0
    };
  }

  /* Selectors for the host's own rendered cart-count badge. Used for BOTH
     jobs: reading the count (readHostCartCountFromDOM below) and detecting
     that it changed (startCartWatch further down). */
  var CART_COUNT_SELECTORS = [
    ".cart-count", "#CartCount", "[data-cart-count]", ".cart-count-bubble",
    ".cart-link__bubble", ".site-header__cart-count", ".cart__count",
    ".cart-quantity", ".minicart-quantity", ".header-cart__count", ".cart-items-count"
  ].join(", ");

  /* Reads the count straight off the host's rendered badge. This is the
     UNIVERSAL tier - no API, no platform detection, no merchant hook - so it
     works on Fox / Terminal X / any custom stack that simply renders its cart
     total as text. It yields a COUNT ONLY, never line items, so the snapshot
     is flagged countOnly:true and PEAR says "N items in your store cart"
     instead of pretending to an item list it cannot actually see.
     Returns null (no badge found) which is deliberately DISTINCT from 0 (a
     badge that really does read empty) - only the latter is safe to mirror. */
  function readHostCartCountFromDOM() {
    var nodes = d.querySelectorAll(CART_COUNT_SELECTORS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var raw = (el.getAttribute("data-cart-count") || el.textContent || "").trim();
      var m = raw.match(/\d+/);   // badges render "2", "(2)", "2 items", "Cart (2)"
      if (!m) continue;
      var n = parseInt(m[0], 10);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  function cartFromDOMBadge() {
    var n = readHostCartCountFromDOM();
    if (n === null) return null;
    return { items: [], itemCount: n, empty: n === 0, countOnly: true };
  }

  /* A well-known host cart global (window.FoxCart). Shape-checked, not
     trusted by name: a global that happens to share the name but exposes
     nothing cart-like is ignored rather than guessed at. */
  function readHostCartGlobal() {
    var g = w.FoxCart;
    if (!g || typeof g !== "object") return null;
    var items = g.items || g.lines || null;
    var count = typeof g.item_count === "number" ? g.item_count
              : typeof g.itemCount === "number" ? g.itemCount
              : (items && typeof items.length === "number") ? items.length
              : null;
    if (count === null) return null;
    /* Reuse the Shopify normalizer only when this really carries line items -
       its field names (variant_id/product_title/...) are the common
       e-commerce JSON spelling, and anything it can't find degrades to "".
       With no items array we still know the count, so report it as
       countOnly rather than inventing an empty list. */
    if (items && items.length) return normalizeShopifyCart({ items: items, item_count: count });
    return { items: [], itemCount: count, empty: count === 0, countOnly: true };
  }

  function fetchHostCart(platform) {
    if (platform === "shopify") {
      return fetch("/cart.js", { headers: { "Accept": "application/json" } }).then(function (r) {
        if (!r.ok) throw new Error("cart.js HTTP " + r.status);
        return r.json();
      }).then(normalizeShopifyCart).catch(function (err) {
        /* Even on Shopify the endpoint can be proxied away, rate-limited, or
           blocked by a consent/CDN layer. Falling back to the rendered badge
           keeps PEAR showing the right COUNT instead of stalling at zero. */
        var fallback = cartFromDOMBadge();
        if (fallback) return fallback;
        throw err;
      });
    }
    if (platform === "custom" && w.PEAR_CART_CONFIG && typeof w.PEAR_CART_CONFIG.getCart === "function") {
      return Promise.resolve(w.PEAR_CART_CONFIG.getCart());
    }
    /* No readable cart API on this platform - the Fox case. Try a known
       global, then the rendered badge, before giving up entirely. */
    var fromGlobal = readHostCartGlobal();
    if (fromGlobal) return Promise.resolve(fromGlobal);
    var fromBadge = cartFromDOMBadge();
    if (fromBadge) return Promise.resolve(fromBadge);
    return Promise.reject(new Error("no readable host cart (platform: " + platform + ")"));
  }

  /* Last snapshot we successfully read, cached from the moment this script
     boots (primeHostCart below). It is what makes hydration INSTANT: the
     iframe gets the real count on the very first tick it can receive a
     message, instead of rendering 0 while a /cart.js round-trip is still in
     flight. */
  var lastKnownCart = null;

  function postCart(targetWindow, cart) {
    if (!targetWindow || !cart) return;
    try { targetWindow.postMessage({ type: "PEAR_CART_SYNC", cart: cart }, PEAR_BASE); }
    catch (err) { /* iframe may already be torn down (session ended) - nothing to sync into */ }
  }

  /* Pushes the host cart into `targetWindow` (the fitting-room iframe) in two
     beats: the cached snapshot goes out SYNCHRONOUSLY so PEAR paints the
     right count with zero delay, then the freshly-read authoritative one
     follows the moment it resolves. Called on the PEAR_CART_REQUEST_SYNC
     handshake, after every add/remove, and by the live host-change watch. */
  function pushCartSync(targetWindow) {
    if (!targetWindow) return;
    postCart(targetWindow, lastKnownCart);
    fetchHostCart(detectCartPlatform()).then(function (cart) {
      lastKnownCart = cart;
      postCart(targetWindow, cart);
    }).catch(function (err) {
      console.warn("[PEAR widget] couldn't read host cart:", err && err.message);
    });
  }

  /* Immediate hydration - runs at widget boot, long before the shopper opens
     anything, so `lastKnownCart` is already populated by the time an iframe
     exists to receive it. Also pushes straight into an already-open modal,
     which is what makes a host-side cart change show up in PEAR live. */
  function primeHostCart() {
    fetchHostCart(detectCartPlatform()).then(function (cart) {
      var changed = !lastKnownCart || lastKnownCart.itemCount !== cart.itemCount;
      lastKnownCart = cart;
      if (changed && activeIframe && activeIframe.contentWindow) {
        postCart(activeIframe.contentWindow, cart);
      }
    }).catch(function (err) {
      /* Genuinely unreadable cart (no API, no hook, no badge on the page).
         Deliberately NOT synthesised as an empty cart - claiming "0 items"
         when the store may well hold several is worse than PEAR simply
         keeping its own local count. */
      console.warn("[PEAR widget] host cart not readable at boot:", err && err.message);
    });
  }

  function removeFromShopifyCart(payload) {
    var id = payload.key || payload.variantId;
    return fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, quantity: 0 })
    }).then(function (r) {
      if (!r.ok) throw new Error("cart/change.js HTTP " + r.status);
      return r.json();
    });
  }

  function removeFromHostCart(payload, platform) {
    var attempt;
    if (platform === "shopify" && (payload.key || payload.variantId)) {
      attempt = removeFromShopifyCart(payload);
    } else if (platform === "custom" && w.PEAR_CART_CONFIG && typeof w.PEAR_CART_CONFIG.removeFromCart === "function") {
      attempt = Promise.resolve(w.PEAR_CART_CONFIG.removeFromCart(payload));
    } else {
      attempt = Promise.reject(new Error("no known host cart integration (platform: " + platform + ")"));
    }

    /* Same broadcast parity as addToHostCart - a theme's own mini-cart/
       analytics code may want to react to a PEAR-initiated removal too. */
    if (w.CustomEvent) {
      w.dispatchEvent(new w.CustomEvent("pear:removeFromCart", { detail: payload }));
    }
    return attempt;
  }

  /* ── Live host-cart-change detection (only while the PEAR modal is open -
     nothing in PEAR needs updating while it's closed) ─────────────────────
     No universal cross-theme "cart changed" DOM event exists, so this
     combines two theme-agnostic signals into the same re-sync:
       1. A MutationObserver on common cart-count badge selectors - catches
          most themes' own AJAX-cart updates within a frame or two.
       2. A light background poll as a backstop for whatever (1) misses - a
          theme with no visible count badge, a badge rendered inside a
          closed shadow root, a full reload of the host tab, etc.
     (CART_COUNT_SELECTORS is shared with the badge READER - see
     readHostCartCountFromDOM above.) */
  var CART_POLL_MS = 2000;
  var cartWatchObserver = null;
  var cartWatchTimer = null;

  function startCartWatch(iframeEl) {
    stopCartWatch();
    var syncNow = function () {
      if (iframeEl && iframeEl.contentWindow) pushCartSync(iframeEl.contentWindow);
    };

    if (w.MutationObserver) {
      cartWatchObserver = new w.MutationObserver(function (records) {
        /* Ignore mutations originating inside our OWN overlay - the widget's
           modal/iframe churns the DOM and would otherwise re-trigger this on
           every one of its own paints. */
        for (var r = 0; r < records.length; r++) {
          var target = records[r].target;
          if (activeOverlay && target && activeOverlay.contains(target)) continue;
          syncNow();
          return;
        }
      });
      var badges = d.querySelectorAll(CART_COUNT_SELECTORS);
      for (var i = 0; i < badges.length; i++) {
        /* Observe the badge AND its parent: many themes REPLACE the badge
           node outright on update rather than editing its text, which an
           observer bound only to the old node would never see. */
        cartWatchObserver.observe(badges[i], { childList: true, characterData: true, subtree: true });
        if (badges[i].parentNode && badges[i].parentNode.nodeType === 1) {
          cartWatchObserver.observe(badges[i].parentNode, { childList: true, characterData: true, subtree: true });
        }
      }
      /* No badge on the page yet (a theme that renders its cart chrome
         lazily): watch for one appearing, cheaply - childList only, no
         characterData, so this is a structural-change watch rather than a
         full text observer over the whole document. */
      if (!badges.length && d.body) {
        cartWatchObserver.observe(d.body, { childList: true, subtree: true });
      }
    }

    /* The poll re-reads through the same tiered reader, so it also covers
       the case where the badge is unchanged but the underlying cart JSON
       moved (e.g. a quantity edit that leaves the item count the same). */
    cartWatchTimer = w.setInterval(syncNow, CART_POLL_MS);
  }

  function stopCartWatch() {
    if (cartWatchObserver) { cartWatchObserver.disconnect(); cartWatchObserver = null; }
    if (cartWatchTimer) { w.clearInterval(cartWatchTimer); cartWatchTimer = null; }
  }

  /* PEAR asks for a fresh snapshot - sent once the fitting room's own cart UI
     is ready to receive it (on load, and whenever the shopper opens the cart
     dropdown), so the very first sync can't race the iframe's own message
     listener still being wired up. */
  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.type !== "PEAR_CART_REQUEST_SYNC") return;
    pushCartSync(e.source);
  });

  /* Item deleted from inside PEAR - mirror the removal on the host cart, then
     push a fresh, AUTHORITATIVE snapshot back (rather than trusting the
     iframe's own optimistic local removal) so the two can never drift apart -
     on a failure too, since the optimistic removal still needs correcting
     back to whatever the host cart actually contains. */
  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.type !== "PEAR_REMOVE_FROM_CART") return;

    var payload = e.data.payload || {};
    var sourceWindow = e.source;
    var platform = detectCartPlatform();

    removeFromHostCart(payload, platform).then(function () {
      pushCartSync(sourceWindow);
    }).catch(function (err) {
      console.warn("[PEAR widget] host cart removal failed:", err && err.message);
      showToast(isHebrewPage() ? "לא הצלחנו להסיר מהסל אוטומטית" : "Couldn't remove the item automatically");
      pushCartSync(sourceWindow);
    });
  });

  w.addEventListener("message", function (e) {
    if (e.origin !== PEAR_BASE) return;
    if (!e.data || e.data.type !== "PEAR_ADD_TO_CART") return;

    // e.data.payload is the current contract; e.data.variantId (flat, no
    // payload wrapper) is what pre-Host-Cart-Integration fitting-room builds
    // sent - kept working here rather than silently dropping older sessions.
    var payload = e.data.payload || { variantId: e.data.variantId };
    var sourceWindow = e.source;   // the fitting-room iframe's window - the Feedback Sync target

    function notifyFittingRoom(ok, message) {
      if (!sourceWindow) return;
      try {
        sourceWindow.postMessage({ type: "PEAR_ADD_TO_CART_RESULT", ok: ok, message: message || "" }, PEAR_BASE);
      } catch (err) { /* iframe may already be torn down (session ended) - nothing to notify */ }
    }

    var platform = detectCartPlatform();

    // Prefer the variant that matches the shopper's CURRENT in-room size over
    // whatever the PDP had selected at handoff - see findVariantForSize()'s own
    // comment for the bug this closes. Never overrides on a miss (unknown Size
    // option, product JSON not loaded yet, no matching size): payload.variantId
    // stays exactly what it already was.
    if (platform === "shopify" && payload.size) {
      var sizedVariant = findVariantForSize(_shopifyVariants, _shopifySizeOptionIndex, payload.size, payload.variantId);
      if (sizedVariant) {
        payload = Object.assign({}, payload, {
          variantId: sizedVariant.id,
          sku: sizedVariant.sku || payload.sku,
        });
      }
    }

    if (!payload.variantId && platform !== "custom") {
      showToast(isHebrewPage() ? "לא נמצאה גרסת מוצר להוספה לסל" : "Couldn't find a product variant to add");
      notifyFittingRoom(false, "no-variant");
      return;
    }

    addToHostCart(payload, platform).then(function () {
      showToast(payload.size
        ? (isHebrewPage() ? "הפריט במידה " + payload.size + " נוסף לעגלה" : "Size " + payload.size + " added to cart")
        : (isHebrewPage() ? "הפריט נוסף לסל!" : "Added to cart!"));
      notifyFittingRoom(true);
      pushCartSync(sourceWindow);   // real host state, not just an optimistic count bump
    }).catch(function (err) {
      console.warn("[PEAR widget] host cart add failed:", err && err.message);
      showToast(isHebrewPage() ? "לא הצלחנו להוסיף לסל אוטומטית - נסה/י ידנית" : "Couldn't add to cart automatically - please add it manually");
      notifyFittingRoom(false, err && err.message);
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
    /* Read the host cart straight away - boot is the earliest point this can
       happen, so PEAR has the real count cached and ready before the shopper
       has even opened the fitting room. Fire-and-forget: an unreadable cart
       just leaves the cache empty (see primeHostCart). */
    primeHostCart();
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
