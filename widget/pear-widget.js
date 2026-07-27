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

   Back-image discovery (opt-in, best-effort): an explicit data-pear-back on the
   product <img> or its container wins; otherwise the widget falls back to the
   next distinct product-gallery image. data-pear-front, when present, overrides
   the scraped front URL.

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
     Priority: explicit data-pear-back on the img/container → next distinct product-
     gallery image. data-pear-front, when set, overrides the scraped front URL. */
  function readAttr(el, name) {
    return (el && el.getAttribute && el.getAttribute(name)) || "";
  }

  /* Normalise for comparison - CDNs vary query params, so match on the path only. */
  function samePhoto(a, b) {
    return (a || "").split("?")[0] === (b || "").split("?")[0];
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

  /* Fall back to the next distinct product-gallery image as an approximate rear
     reference (best-effort - gallery order is a storefront convention, not a rule). */
  function findGalleryBack(primaryUrl, root) {
    var shopifyId = getShopifyProductId();
    var sel = (root || d).querySelectorAll(PRODUCT_IMG_SELECTORS);
    for (var i = 0; i < sel.length; i++) {
      var el = sel[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG") continue;
      var src = el.currentSrc || el.src || "";
      if (!src || isExcludedSrc(src) || samePhoto(src, primaryUrl)) continue;
      if (shopifyId && src.indexOf(shopifyId) === -1) continue;   // different product - skip
      return src;
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
       data-pear-back (or data-pear-front override) is captured per image. */
    var entries = found.map(function (img, idx) {
      return {
        img: img,
        url: explicitAttr(img, "data-pear-front") ||
             ((idx === 0 && ogUrl) ? ogUrl : (img.currentSrc || img.src)),
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
    /* Ground-truth product id (Shopify) takes over the filter outright, and treats
       a non-match as a real rejection, not just a "no signal" - this call is often
       made with root=d (whole document, see resolvePrimaryProductImage's og:image
       path), so on a page with related/recommended-product rails using the same
       THUMB_SELECTORS markup, the regex-only heuristic below could otherwise admit
       a sibling product's photo whenever its filename didn't yield an extractable
       id. The primary image is always kept regardless - it was already resolved
       as THIS product's photo by the caller. */
    var shopifyId = getShopifyProductId();
    var primaryId = shopifyId || extractProductId(primaryUrl);
    function add(u, isPrimary) {
      if (!u || isExcludedSrc(u)) return;
      var path = u.split("?")[0];
      if (seenPaths.indexOf(path) !== -1) return;
      if (!isPrimary) {
        if (shopifyId) {
          if (u.indexOf(shopifyId) === -1) return;   // ground truth - must actually match
        } else {
          var candId = extractProductId(u);
          if (primaryId && candId && candId !== primaryId) return;   // different product - skip
        }
      }
      seenPaths.push(path);
      urls.push(u);
    }
    add(primaryUrl, true);
    var imgs = (root || d).querySelectorAll(THUMB_SELECTORS);
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (!el || el.tagName !== "IMG") continue;
      add(el.currentSrc || el.src || "");
    }
    return urls;
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
     DOM order. */
  function classifyImages(urls) {
    var endpoint = PEAR_BASE + "/api/classify-images";
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: urls })
    }).then(function (r) {
      if (!r.ok) throw new Error("classify-images HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      var results = (data && data.results) || [];
      return results;
    });
  }

  function resolveFrontBack(urls, results) {
    var front, back;
    for (var i = 0; i < urls.length; i++) {
      if (results[i] === "front" && !front) front = urls[i];
      else if (results[i] === "back" && !back) back = urls[i];
    }
    return { front: front || urls[0], back: back || urls[1] || undefined };
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

    var params =
      "garment_url=" + encodeURIComponent(garment.url) +
      "&garment_type=" + encodeURIComponent(garment.type) +
      "&garment_name=" + encodeURIComponent(garment.name) +
      (garment.back ? "&garment_url_back=" + encodeURIComponent(garment.back) : "") +
      /* All gallery photos (each encoded, comma-joined) → the fitting room's
         automatic front/back pairing. Sent only when there's more than one distinct image. */
      (garment.images && garment.images.length > 1
        ? "&garment_images=" + garment.images.map(encodeURIComponent).join(",") : "") +
      (garment.variantId ? "&garment_variant_id=" + encodeURIComponent(garment.variantId) : "") +
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
      if (el && el.tagName === "IMG" && !isExcludedSrc(el.currentSrc || el.src)) return el;
    }
    /* else the largest non-decorative <img> inside this container (collection cards
       rarely use the PDP selectors above, so size is the reliable signal) */
    var imgs = (root.querySelectorAll && root.querySelectorAll("img")) || [];
    var best = null, bestArea = -1;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var src = im.currentSrc || im.src || "";
      if (!src || isExcludedSrc(src)) continue;
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
    var ogUrl = og && og.content ? og.content : "";
    if (ogUrl && !isExcludedSrc(ogUrl)) return ogUrl;

    var el = d.querySelector(PRODUCT_GALLERY_SELECTORS);
    if (el) {
      if (el.tagName !== "IMG") el = el.querySelector && el.querySelector("img");
      if (el && el.tagName === "IMG") {
        var src = el.currentSrc || el.src || "";
        if (src && !isExcludedSrc(src)) return src;
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
      return {
        url: primaryUrl,
        back: findGalleryBack(primaryUrl, d),
        images: pgImages,
        name: pgName,
        category: detectCategory(pgName),
        variantId: extractVariantId(btn)
      };
    }

    // Priority 3 - ancestor walk-up (see pickProductImageIn/collectGalleryImages
    // header comments for how this is scoped and filtered).
    var node = btn.parentElement;
    for (var depth = 0; depth < 10 && node; depth++) {
      var img = pickProductImageIn(node);
      if (img) {
        var url = explicitAttr(img, "data-pear-front") || (img.currentSrc || img.src) || "";
        if (url && !isExcludedSrc(url)) {
          var name = cardNameFor(node, img);
          var cardImages = collectGalleryImages(url, node);
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
        var openedIframe = openModal({ url: imgs[0], type: garment.category, name: garment.name, back: imgs[1], images: imgs, variantId: garment.variantId });

        classifyImages(imgs).then(function (results) {
          var sorted = sortByFrontBack(imgs, results);
          var resolved = resolveFrontBack(imgs, results);
          /* Only push a correction if the classifier actually disagrees with the DOM-order
             guess already showing, and only into the SAME modal that triggered this call
             (the shopper may have closed it, or opened a different product, in the meantime). */
          if (activeIframe === openedIframe && (resolved.front !== imgs[0] || resolved.back !== imgs[1])) {
            try {
              openedIframe.contentWindow.postMessage({
                type: "PEAR_UPDATE_GARMENT",
                garment_url: resolved.front,
                garment_back: resolved.back,
                garment_images: sorted
              }, PEAR_BASE);
            } catch (_) {}
          }
        }).catch(function (err) {
          console.warn("[PEAR widget] classify-images failed, using DOM order as-is:", err && err.message);
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
    if (h1 && h1.parentNode) h1.parentNode.insertBefore(btn, h1.nextSibling);
    else d.body.appendChild(btn);
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
