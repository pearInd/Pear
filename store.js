/* ============================================================
   MERIDIAN storefront - vanilla JS (no build, no dependencies)
   Modules: announcement ticker · hero ticker · New Arrivals grid ·
   Lookbook collage · filterable catalog · Customer Favorites carousel ·
   PEAR Camera handoff → ./pear-demo/index.html (root-relative)
   ============================================================ */
"use strict";

/* ── config ──
   PRODUCTS, SUBTYPE_LABEL, shade(), garmentSVG() live in catalog.js,
   which is loaded before this file. */
const PEAR_PATH = "/fitting-room/";
const LS_TRYON  = "pear_tryon";
const LS_BAG    = "meridian_bag";
const LS_CUSTOM = "pear_custom_garment";   // handoff channel for an uploaded garment (data URL is too big for a query param)

/* ── "Upload Your Own Garment" - externalized config (this storefront has no
   config.js; store.js is its app.js, so its tunables live here, mirroring
   fitting-room/config.js → CONFIG.UPLOAD). Every timing / threshold the upload →
   detect → crop → handoff flow uses lives HERE and nowhere else.

   Detector: dependency-free canvas background-subtraction + connected-components
   (see detectGarments). Chosen over MediaPipe Object Detector because its shipped
   COCO/EfficientDet model has NO apparel classes ("clothing/top/bottom/dress"
   aren't in COCO) and it adds a multi-MB WASM+model CDN dependency that can 404 -
   against this store's "layout never breaks" ethos. Swap MediaPipe in later by
   replacing detectGarments()'s body; the rest of the flow only consumes boxes. */
const STORE_UPLOAD = Object.freeze({
  MAX_BYTES:              12 * 1024 * 1024, // reject uploads larger than 12 MB
  DETECT_MAX_DIM:         512,   // downscale the longest side to this before analysis
  BG_SAMPLE_BAND:         0.06,  // fraction of each edge sampled to estimate the background colour
  FG_DIFF_THRESHOLD:      46,    // Euclidean RGB distance from bg above which a pixel is "foreground"
  DILATE_RADIUS:          3,     // morphological dilation (downscaled px) - closes gaps so one garment = one blob
  MIN_BOX_AREA_FRAC:      0.015, // ignore foreground blobs smaller than this fraction of the image
  MAX_BOX_AREA_FRAC:      0.985, // ignore blobs that fill essentially the whole frame (bg-estimate failure)
  MIN_BOX_DIM_FRAC:       0.05,  // ignore slivers thinner than this fraction of the image in either axis
  MERGE_IOU:              0.18,  // merge two boxes overlapping more than this (or on strong containment)
  MAX_BOXES:              6,     // cap on how many detection boxes are drawn
  BOX_PAD_FRAC:           0.05,  // expand the crop outward so seams/edges aren't clipped
  CROP_MAX_DIM:           1024,  // longest side of the exported cropped garment (kept modest for the localStorage handoff)
  CROP_QUALITY:           0.9,   // JPEG quality of the exported crop (data URL handed to the fitting room)
  DETECT_RENDER_DELAY_MS: 240,   // let the modal paint its loading state before the (synchronous) detect pass
  LAUNCH_DELAY_MS:        650,   // toast dwell before navigating to the fitting room (matches launchPearCamera)

  /* ── multi-garment separation + viewfinder labels (mirrors CONFIG.UPLOAD) ── */
  PERSON_MIN_HEIGHT_FRAC:   0.55, // a blob taller than this fraction of the image = a worn outfit → split Top+Bottom
  PERSON_MAX_ASPECT:        0.85, // …and no wider than this (w/h) to read as a person rather than a wide flat-lay
  SPLIT_TOP_FRAC:           0.56, // the Top garment spans the upper N of the outfit blob
  SPLIT_BOTTOM_FRAC:        0.50, // the Bottom garment starts this far down (slight waist overlap → natural framing)
  FULLBODY_MIN_HEIGHT_FRAC: 0.86, // a single tall, narrow blob at least this tall = a full-body item (dress/jumpsuit)
  MIN_CONFIDENCE:           0.02, // if the best box's area-fraction score is below this → treat as "no clear garment"
  PICK_ANIM_MS:             260,  // crisp click-confirmation animation played before the modal closes
});

const FILTERS = {
  all:   { title: "All Products", sub: "Our complete range of premium essentials.",         test: () => true },
  shirt: { title: "Shirts",       sub: "Tailored upper-body essentials for every day.",      test: (p) => p.type === "shirt" },
  pants: { title: "Pants",        sub: "Refined trousers cut for comfort and movement.",      test: (p) => p.type === "pants" },
  new:   { title: "New Arrivals", sub: "The latest additions to the Spring 2026 collection.", test: (p) => p.isNew },
};

/* ── DOM refs ── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const grid     = $("#grid");
const newGrid  = $("#newGrid");
const lookGrid = $("#lookGrid");
const favTrack = $("#favTrack");
const catTitle = $("#catTitle");
const catSub   = $("#catSub");
const navLinks = $$("#nav a");
const chips    = $$("#filters .chip");
const bagCount = $("#bagCount");
const toastEl  = $("#toast");

/* ── network-quality guard ── */
const NET_PROBE_URL     = "/api/speed-probe";
const NET_PROBE_BYTES   = 102_400;  // must match server payload (bytes)
const NET_MIN_KBPS      = 2000;     // 2 Mbps minimum for live AI video
const NET_PROBE_TIMEOUT = 8000;     // abort probe after 8 s

const netModalEl = $("#netModal");
let   netChecking    = false;
let   pendingProduct = null; // product queued while net check is in-flight

/* ── card template ── */
function cardHTML(p, i) {
  const href = `product.html?id=${p.id}`;
  return `
  <article class="card" style="--i:${i}">
    <a class="card__media" href="${href}" aria-label="View ${p.name}">
      <span class="card__badge"${p.isNew ? "" : " hidden"}>New</span>
      ${garmentSVG(p)}
    </a>
    <div class="card__body">
      <span class="card__cat">${p.category} · ${SUBTYPE_LABEL[p.subType]}</span>
      <a class="card__name" href="${href}">${p.name}</a>
      <span class="card__price">$${p.price}</span>
      <div class="card__actions">
        <a class="btn--try" href="${href}">View Product <span>→</span></a>
        <button class="btn--add" data-bag="${p.id}" aria-label="Add ${p.name} to bag">+</button>
      </div>
    </div>
  </article>`;
}

/* ── catalog (filterable) ── */
function renderCatalog(filterKey) {
  const cfg = FILTERS[filterKey] || FILTERS.all;
  const list = PRODUCTS.filter(cfg.test);
  catTitle.textContent = cfg.title;
  catSub.textContent = cfg.sub;
  grid.innerHTML = list.length
    ? list.map((p, i) => cardHTML(p, i)).join("")
    : `<div class="empty">No products found in this category.</div>`;
  navLinks.forEach((a) => a.classList.toggle("is-active", a.dataset.filter === filterKey));
  chips.forEach((c) => c.classList.toggle("is-active", c.dataset.filter === filterKey));
}

/* ── "Upload Your Own Garment" card ──
   A 5th New-Arrivals tile that matches the storefront card style 1:1 (.card /
   .card__media / .card__badge / .card__body / .btn--try), but its media shows a
   dashed garment silhouette with a big royal-blue "?" and its button reads
   "Upload & Try On →". The whole card + its button carry data-upload, which the
   delegated click handler routes to openGarmentUpload(). */
function uploadCardSVG() {
  const d = SHIRT_PATHS.short_sleeve;   // generic garment silhouette (from catalog.js)
  return `<svg viewBox="0 0 220 260" role="img" aria-label="Upload your own garment" xmlns="http://www.w3.org/2000/svg">
    <rect width="220" height="260" fill="#ffffff"/>
    <g style="filter:drop-shadow(0px 6px 16px rgba(11,60,149,0.14))">
      <path d="${d}" fill="#eef3fc" stroke="#4169e1" stroke-width="2.6"
            stroke-linejoin="round" stroke-dasharray="7 6"/>
    </g>
    <text x="110" y="150" text-anchor="middle" dominant-baseline="central"
          font-family="Inter, system-ui, sans-serif" font-size="92" font-weight="800"
          fill="#0b3c95">?</text>
  </svg>`;
}

function uploadCardHTML(i) {
  return `
  <article class="card card--upload" style="--i:${i}" data-upload role="button" tabindex="0"
           aria-label="Upload your own garment and try it on">
    <div class="card__media card__media--upload" data-upload>
      <span class="card__badge card__badge--upload">Custom</span>
      ${uploadCardSVG()}
    </div>
    <div class="card__body">
      <span class="card__cat">Your Garment · Any Style</span>
      <span class="card__name">Upload Your Own</span>
      <span class="card__price card__price--upload">AI Try-On</span>
      <div class="card__actions">
        <button class="btn--try" type="button" data-upload>Upload &amp; Try On <span>→</span></button>
      </div>
    </div>
  </article>`;
}

/* ── New Arrivals (static) - 4 newest products + the Upload Your Own card ── */
function renderNew() {
  const cards = PRODUCTS.filter((p) => p.isNew).slice(0, 4).map((p, i) => cardHTML(p, i)).join("");
  newGrid.innerHTML = cards + uploadCardHTML(4);
}

/* ── Lookbook collage (static, editorial spans) ── */
function renderLookbook() {
  const picks = [1, 9, 3, 13, 6, 11].map((id) => PRODUCTS.find((p) => p.id === id));
  const spans = ["tall", "", "wide", "", "", ""]; // first tall, third wide → editorial rhythm
  lookGrid.innerHTML = picks.map((p, i) => `
    <div class="look__tile ${spans[i]}" data-filter="${p.type}">
      ${garmentSVG(p)}
      <div class="look__cap"><b>${p.name}</b><span>${p.category}</span></div>
    </div>`).join("");
}

/* ── Customer Favorites carousel (static) ── */
function renderFavs() {
  favTrack.innerHTML = PRODUCTS.filter((p) => p.fav).map((p, i) => cardHTML(p, i)).join("");
}

/* ── routing (hash ↔ catalog filter) ── */
const HASH_TO_FILTER = { home: "all", all: "all", shirts: "shirt", shirt: "shirt", pants: "pants", new: "new" };
function currentFilter() {
  const h = location.hash.replace("#", "").toLowerCase();
  if (h === "lookbook" || h === "catalog") return null; // anchor-only, keep current catalog state
  return HASH_TO_FILTER[h] || "all";
}
function routeFromHash() {
  const f = currentFilter();
  if (f) renderCatalog(f);
}

/* ── PEAR handoff URL builder (focused / isolated mode) ── */
function pearUrl(p, embed) {
  const params = {
    id: p.id,
    itemType: p.type,
    subType: p.subType,
    color: p.color.replace("#", ""),
    name: p.name,
    img: p.imageUrl || "",
  };
  if (embed) params.embed = "1";
  return `${PEAR_PATH}?${new URLSearchParams(params).toString()}`;
}

/* ── PEAR full-camera handoff (deep-link with the active garment) ── */
function launchPearCamera(p) {
  const color = p.color.replace("#", "");
  try { localStorage.setItem(LS_TRYON, JSON.stringify({ itemType: p.type, subType: p.subType, color, name: p.name })); } catch (_) {}
  showToast(`Launching full <b>PEAR Camera</b> - ${p.name}…`);
  setTimeout(() => { window.location.href = pearUrl(p, false); }, 650);
}

/* ============================================================
   TRY-ON VIEW - product-isolated in-store camera + Complete the Look
   ============================================================ */
const tryonEl    = $("#tryon");
const statusEl    = $("#tryonStatus");
const ctlTrack   = $("#ctlTrack");
const ctlSub     = $("#ctlSub");
const frame      = $("#tryonFrame");
let activeItem   = null;   // the garment currently isolated in the session
let frameLoaded  = false;  // lazy-load the camera iframe only once per session

/* Cross-category recommendation engine.
   Trying a SHIRT → surface PANTS that pair well (and vice-versa).
   Pairing heuristic: opposite category, ranked by tonal contrast against the
   active garment (a premium outfit balances a statement piece with a neutral),
   then by favorite / new status. Returns 4 picks. */
function recommendFor(p) {
  const wantType = p.type === "shirt" ? "pants" : "shirt";
  const lum = (hex) => {
    const f = parseInt(hex.slice(1), 16);
    return (0.299 * (f >> 16) + 0.587 * ((f >> 8) & 0xff) + 0.114 * (f & 0xff)) / 255;
  };
  const baseLum = lum(p.color);
  return PRODUCTS
    .filter((x) => x.type === wantType)
    .map((x) => ({
      item: x,
      score: Math.abs(lum(x.color) - baseLum) * 2 + (x.fav ? 0.6 : 0) + (x.isNew ? 0.3 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((r) => r.item);
}

/* Status bar - isolates and presents the selected garment beside the feed. */
function renderTryOnStatus(p) {
  statusEl.innerHTML = `
    <div class="tryon__swatch" style="--c:${p.color}">${garmentSVG(p)}</div>
    <div class="tryon__meta">
      <span class="tryon__eyebrow">Now trying on · פריט נבחר</span>
      <h2 class="tryon__name">${p.name}</h2>
      <div class="tryon__facts">
        <span class="tryon__fact"><b>Price</b>$${p.price}</span>
        <span class="tryon__fact"><b>Fit</b>${SUBTYPE_LABEL[p.subType]}</span>
        <span class="tryon__fact"><b>Category</b>${p.category}</span>
      </div>
    </div>
    <div class="tryon__cta">
      <button class="btn btn--white tryon__launch" data-launch="${p.id}">Open in PEAR Camera →</button>
      <button class="tryon__add btn--add" data-bag="${p.id}" aria-label="Add ${p.name} to bag">Add to bag</button>
    </div>`;
}

/* Complete the Look slider - mini-thumbnails + quick-swap. */
function renderRecommendations(p) {
  const recs = recommendFor(p);
  const wantHe = p.type === "shirt" ? "מכנסיים תואמים" : "חולצות תואמות";
  const wantEn = p.type === "shirt" ? "Pants that pair with this shirt" : "Shirts that pair with these pants";
  ctlSub.textContent = `${wantHe} · ${wantEn}`;
  ctlTrack.innerHTML = recs.map((r, i) => `
    <article class="ctl__card" style="--i:${i}">
      <div class="ctl__media">${garmentSVG(r)}</div>
      <div class="ctl__body">
        <span class="ctl__cat">${r.category} · ${SUBTYPE_LABEL[r.subType]}</span>
        <h4 class="ctl__name">${r.name}</h4>
        <span class="ctl__price">$${r.price}</span>
      </div>
      <button class="ctl__swap" data-switch="${r.id}">החלף פריט · Switch Item</button>
    </article>`).join("");
}

/* Make a garment the active try-on item (entry point + quick-swap target). */
function setActiveItem(p, opts = {}) {
  activeItem = p;
  renderTryOnStatus(p);
  renderRecommendations(p);
  if (opts.pulse) {
    statusEl.animate(
      [{ boxShadow: "0 0 0 0 rgba(65,105,225,0.55)" }, { boxShadow: "0 0 0 14px rgba(65,105,225,0)" }],
      { duration: 600, easing: "ease-out" }
    );
  }
}

async function openTryOn(p) {
  pendingProduct = null;
  setActiveItem(p);
  frame.src = pearUrl(p, true);
  frameLoaded = true;
  tryonEl.classList.add("open");
  tryonEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("tryon-open");
}

function closeTryOn() {
  tryonEl.classList.remove("open");
  tryonEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("tryon-open");
}

async function checkNetworkQuality() {
  if (navigator.connection) {
    const { effectiveType, downlink } = navigator.connection;
    if (effectiveType === "slow-2g" || effectiveType === "2g") return false;
    if (typeof downlink === "number" && downlink > 0 && downlink < NET_MIN_KBPS / 1000) return false;
  }
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NET_PROBE_TIMEOUT);
    const t0    = performance.now();
    const resp  = await fetch(`${NET_PROBE_URL}?_=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
    if (!resp.ok) { clearTimeout(timer); return false; }
    await resp.arrayBuffer();
    clearTimeout(timer);
    const kbps = (NET_PROBE_BYTES * 8) / 1024 / ((performance.now() - t0) / 1000);
    return kbps >= NET_MIN_KBPS;
  } catch (_) {
    return false;
  }
}

function showNetworkModal() { /* disabled */ }

function hideNetworkModal() {
  netModalEl.classList.remove("open");
  netModalEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("net-modal-open");
  pendingProduct = null;
}

function switchItem(p) {
  setActiveItem(p, { pulse: true });
  // Live-swap the garment inside the running camera (no reload → no restart).
  if (frame.contentWindow) {
    frame.contentWindow.postMessage(
      { type: "pear:swap", itemType: p.type, subType: p.subType, color: p.color.replace("#", ""), name: p.name },
      "*"
    );
  }
  showToast(`Now trying on <b>${p.name}</b>`);
}

/* ── bag ── */
function getBag() { return parseInt(localStorage.getItem(LS_BAG) || "0", 10); }
function setBag(n) { localStorage.setItem(LS_BAG, String(n)); bagCount.textContent = n; bagCount.classList.toggle("show", n > 0); }
function addToBag(p) {
  setBag(getBag() + 1);
  bagCount.animate([{ transform: "scale(1.4)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  showToast(`<b>${p.name}</b> added to bag`);
}

/* ── toast ── */
let toastTimer;
function showToast(html) {
  toastEl.innerHTML = html; toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
}

/* ── tickers ── */
function buildTickers() {
  const ann = ["Free shipping & returns on every order", "Try on instantly via PEAR Camera 👕", "New Spring 2026 collection now live", "Members get early access to drops"];
  const a = ann.map((t) => `<span>${t}</span>`).join("");
  $("#announce").innerHTML = a + a;
  const tk = ["Made to move", "Fitted in seconds", "Premium essentials", "Engineered tailoring", "Spring 2026"];
  const t = tk.map((x) => `<span>${x}</span>`).join("");
  $("#ticker").innerHTML = t + t + t;
}

/* ============================================================
   "UPLOAD YOUR OWN GARMENT" - detect · select · crop · hand off
   ------------------------------------------------------------
   Flow:  upload card → file picker → handleGarmentFile() validates + loads the
   image → runDetection() opens the overlay and runs detectGarments() (a vanilla,
   dependency-free background-subtraction + connected-components pass) → the user
   clicks a royal-blue bounding box → selectDetectedGarment() crops it to a data
   URL → launchCustomGarment() stashes it in localStorage and navigates to the
   fitting room (/fitting-room/?custom=1), where it is treated EXACTLY like a
   native store garment (ek_ token, strict LIVE_DURATION_MS window, leak guards).
   All tunables live in STORE_UPLOAD. ============================================ */
let uploadedImg    = null;  // the currently-loaded source Image (natural resolution)
let detectedBoxes  = [];    // [{ xmin, ymin, width, height, score }] in NATURAL image coords
let detectedOutfit = null;  // { topBounds, bottomBounds, … } when a full worn outfit is detected → TOP/BOTTOM toggle
let activeSide     = "top"; // which sub-region the outfit toggle currently targets ("top" | "bottom")

/** Open the native file picker (reset value so re-picking the SAME file re-fires change). */
function openGarmentUpload() {
  const inp = $("#garmentUploadInput");
  if (!inp) return;
  inp.value = "";
  inp.click();
}

function onGarmentFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (file) handleGarmentFile(file);
}

/** Validate the picked file (type + size), decode it, then run detection. */
function handleGarmentFile(file) {
  const U = STORE_UPLOAD;
  if (!/^image\//i.test(file.type)) { showToast("Unsupported file - please choose an image"); return; }
  if (file.size > U.MAX_BYTES) {
    showToast(`Image is too large (max ${Math.round(U.MAX_BYTES / (1024 * 1024))}MB)`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload  = () => runDetection(img);
    img.onerror = () => showToast("Could not load that image - try another");
    img.src = String(reader.result);   // same-origin data URL → canvas stays untainted
  };
  reader.onerror = () => showToast("Could not read that file");
  reader.readAsDataURL(file);
}

/** Open the overlay (loading state), paint the image, then run the detect pass. */
function runDetection(img) {
  uploadedImg = img;
  detectedBoxes = [];
  openGarmentDetect();
  $("#gdImage").src = img.src;

  setTimeout(() => {
    let boxes = [];
    try { boxes = detectGarments(img); }
    catch (err) { console.warn("[upload] detectGarments failed:", err && err.message); }

    detectedBoxes = boxes;
    $("#gdLoading").hidden = true;

    if (!boxes.length) {
      showDetectEmpty();
      showToast("No garments detected. Please try another clear image.");
      return;
    }

    // A worn full outfit = one figure → TOP/BOTTOM toggle (one box that snaps between
    // sub-regions). Flat-lays with distinct garments keep multi-bracket mode.
    const outfit = boxes.filter((b) => b.outfit)
                        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (outfit) {
      enterOutfitMode(outfit);
    } else {
      exitOutfitMode();
      $("#gdSub").textContent = `${boxes.length} ${boxes.length === 1 ? "garment" : "garments"} detected · tap to select`;
      renderDetectionBoxes(boxes);
    }
  }, STORE_UPLOAD.DETECT_RENDER_DELAY_MS);
}

/* fade in/out driven purely by the .show class + CSS transitions (no JS timers) */
function openGarmentDetect() {
  const ov = $("#garmentDetect");
  if (!ov) return;
  ov.hidden = false;                        // drop the initial display:none once
  $("#gdBoxes").innerHTML = "";
  $("#gdLoading").hidden = false;
  $("#gdEmpty").hidden = true;
  $("#gdSub").textContent = "Detecting garments…";
  detectedOutfit = null; activeSide = "top";
  { const tabs = $("#gdTabs"); if (tabs) tabs.hidden = true; }
  document.body.classList.add("gd-open");
  requestAnimationFrame(() => ov.classList.add("show"));
}

function closeGarmentDetect() {
  const ov = $("#garmentDetect");
  if (!ov) return;
  ov.classList.remove("show");
  document.body.classList.remove("gd-open");
}

function showDetectEmpty() {
  $("#gdEmpty").hidden = false;
  $("#gdSub").textContent = "No garments detected";
}

/**
 * Draw a clickable royal-blue box over each detection. Coordinates are PERCENTAGES
 * of the natural image size, and .gd-boxes overlaps the rendered image exactly (its
 * .gd-frame parent wraps only the <img>), so the mapping is scale-independent.
 */
function renderDetectionBoxes(boxes) {
  const iw = uploadedImg.naturalWidth || uploadedImg.width;
  const ih = uploadedImg.naturalHeight || uploadedImg.height;
  $("#gdBoxes").innerHTML = boxes.map((b, i) => {
    const left = (b.xmin / iw) * 100, top = (b.ymin / ih) * 100;
    const w = (b.width / iw) * 100,   h = (b.height / ih) * 100;
    const label = b.label || "Item";
    return `<button class="gd-box" type="button" data-box="${i}" aria-label="Try on ${label}" style="--i:${i};` +
      `left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${w.toFixed(3)}%;height:${h.toFixed(3)}%">` +
      `<span class="gd-box__label"><b>${label}</b></span>` +
      `<i class="gd-corner gd-corner--tl"></i><i class="gd-corner gd-corner--tr"></i>` +
      `<i class="gd-corner gd-corner--bl"></i><i class="gd-corner gd-corner--br"></i>` +
      `</button>`;
  }).join("");
}

/* ── OUTFIT MODE - one bracket + a TOP/BOTTOM segmented toggle ────────────────
   A full worn outfit shows a single bracket whose bounds + label snap between the
   outfit's TOP and BOTTOM sub-regions when the toggle changes. Switching sides
   mutates the SAME element's inline bounds so the CSS transition animates the move
   (the uploaded image is never reloaded). */
const SIDE_LABEL = {
  top:    { title: "Top Garment",    en: "Top" },
  bottom: { title: "Bottom Garment", en: "Bottom" },
};

function outfitBoundsPct(bounds) {
  const iw = uploadedImg.naturalWidth || uploadedImg.width;
  const ih = uploadedImg.naturalHeight || uploadedImg.height;
  return {
    left:  (bounds.xmin  / iw) * 100, top:    (bounds.ymin   / ih) * 100,
    width: (bounds.width / iw) * 100, height: (bounds.height / ih) * 100,
  };
}

function enterOutfitMode(outfit) {
  detectedOutfit = outfit;
  activeSide = "top";
  $("#gdSub").textContent = "Full outfit detected · choose Top or Bottom";
  const tabs = $("#gdTabs"); if (tabs) tabs.hidden = false;
  updateTabsUI();
  renderOutfitBox();
}

function exitOutfitMode() {
  detectedOutfit = null;
  const tabs = $("#gdTabs"); if (tabs) tabs.hidden = true;
}

function renderOutfitBox() {
  const b = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
  const p = outfitBoundsPct(b);
  const { title } = SIDE_LABEL[activeSide];
  $("#gdBoxes").innerHTML =
    `<button class="gd-box gd-box--outfit" type="button" data-box="0" aria-label="Try on ${title}" style="--i:0;` +
    `left:${p.left.toFixed(3)}%;top:${p.top.toFixed(3)}%;width:${p.width.toFixed(3)}%;height:${p.height.toFixed(3)}%">` +
    `<span class="gd-box__label"><b>${title}</b></span>` +
    `<i class="gd-corner gd-corner--tl"></i><i class="gd-corner gd-corner--tr"></i>` +
    `<i class="gd-corner gd-corner--bl"></i><i class="gd-corner gd-corner--br"></i>` +
    `</button>`;
}

/** Move/resize the existing outfit bracket to the active side (CSS animates it). */
function positionOutfitBox() {
  if (!detectedOutfit) return;
  const el = $("#gdBoxes").querySelector(".gd-box");
  if (!el) return;
  const b = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
  const p = outfitBoundsPct(b);
  el.style.left = p.left.toFixed(3) + "%";  el.style.top    = p.top.toFixed(3) + "%";
  el.style.width = p.width.toFixed(3) + "%"; el.style.height = p.height.toFixed(3) + "%";
  const { title } = SIDE_LABEL[activeSide];
  el.setAttribute("aria-label", "Try on " + title);
  const lbl = el.querySelector(".gd-box__label");
  if (lbl) lbl.innerHTML = `<b>${title}</b>`;
}

/** Toggle handler - snap the bracket + crop target between the TOP and BOTTOM regions. */
function setActiveSide(side) {
  if (side !== "top" && side !== "bottom" || !detectedOutfit) return;
  activeSide = side;
  updateTabsUI();
  positionOutfitBox();
}

function updateTabsUI() {
  const tabs = $("#gdTabs"); if (!tabs) return;
  tabs.dataset.active = activeSide;                 // slides the pill indicator
  tabs.querySelectorAll(".gd-tab").forEach((t) => {
    const on = t.dataset.side === activeSide;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
}

/** Pick: crop the chosen region (active TOP/BOTTOM in outfit mode, else the tapped
    garment) and hand off to the fitting room with the right category. */
function selectDetectedGarment(index) {
  if (!uploadedImg) return;

  let box, gtype, label;
  if (detectedOutfit) {
    box   = activeSide === "bottom" ? detectedOutfit.bottomBounds : detectedOutfit.topBounds;
    gtype = activeSide === "bottom" ? "lower_body" : "upper_body";
    label = SIDE_LABEL[activeSide].en;
  } else {
    box = detectedBoxes[index];
    if (!box) return;
    const iw = uploadedImg.naturalWidth || uploadedImg.width;
    const ih = uploadedImg.naturalHeight || uploadedImg.height;
    gtype = box.garmentType || guessGarmentType(box, iw, ih);
    label = box.label || (gtype === "lower_body" ? "Bottom" : "Top");
  }

  // Crisp click-confirmation flash on the chosen bracket before the modal closes.
  const el = document.querySelector(`.gd-box[data-box="${index}"]`);
  if (el) el.classList.add("is-picked");

  const crop = cropRegion(uploadedImg, box);

  setTimeout(() => {
    closeGarmentDetect();
    launchCustomGarment({
      img: crop.dataUrl,
      garmentType: gtype,
      color: crop.color,
      name: `Your garment (${label})`,
    });
  }, STORE_UPLOAD.PICK_ANIM_MS);
}

/**
 * Stash the cropped custom garment in localStorage (the data URL is too big for a
 * query param) and navigate to the fitting room, flagged with ?custom=1. The fitting
 * room's parseHandoff() reconstructs it as a "custom" Active Item on Screen 2.
 */
function launchCustomGarment(item) {
  try {
    localStorage.setItem(LS_CUSTOM, JSON.stringify({
      img: item.img, garmentType: item.garmentType, color: item.color, name: item.name, custom: true,
    }));
  } catch (_) {
    showToast("That crop is too large to hand off - try a smaller image");
    return;
  }
  showToast("Launching <b>PEAR Camera</b> - your garment…");
  setTimeout(() => { window.location.href = `${PEAR_PATH}?custom=1`; }, STORE_UPLOAD.LAUNCH_DELAY_MS);
}

/**
 * Detect garment bounding boxes with a vanilla, dependency-free pass:
 *   1. downscale;  2. estimate the background colour from the border;  3. mask
 *   foreground (pixels far from bg);  4. dilate to close gaps;  5. connected
 *   components → blob boxes;  6. filter by size, merge overlaps, cap.
 * Handles flat-lays, white/plain backgrounds AND model-worn photos (one subject box).
 * Falls back to a whole-image box if the canvas is unreadable (tainted).
 * @returns {Array<{xmin,ymin,width,height,score}>} boxes in NATURAL coords
 */
function detectGarments(img) {
  const U = STORE_UPLOAD;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return [];

  const scale = Math.min(1, U.DETECT_MAX_DIM / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; }
  catch (_) { return [{ xmin: 0, ymin: 0, width: iw, height: ih, score: 0.4 }]; }

  // 2) background colour = mean of a border band on all four edges.
  const band = Math.max(2, Math.round(Math.min(w, h) * U.BG_SAMPLE_BAND));
  let br = 0, bg = 0, bb = 0, bn = 0;
  const sample = (x, y) => { const i = (y * w + x) * 4; br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; };
  for (let y = 0; y < h; y++) for (let x = 0; x < band; x++) { sample(x, y); sample(w - 1 - x, y); }
  for (let x = 0; x < w; x++) for (let y = 0; y < band; y++) { sample(x, y); sample(x, h - 1 - y); }
  const bgR = br / bn, bgG = bg / bn, bgB = bb / bn;

  // 3) foreground mask (squared distance vs threshold²).
  const thr2 = U.FG_DIFF_THRESHOLD * U.FG_DIFF_THRESHOLD;
  let mask = new Uint8Array(w * h);
  let fgCount = 0;
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    if (dr * dr + dg * dg + db * db > thr2) { mask[p] = 1; fgCount++; }
  }
  if (fgCount === 0) return [];

  // 4) dilate (separable) so a single garment fragmented by shadows/prints → one blob.
  mask = dilateMask(mask, w, h, U.DILATE_RADIUS);

  // 5) connected components (4-connectivity, iterative flood fill).
  const visited = new Uint8Array(w * h);
  const stack = [];
  const raw = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (!mask[start] || visited[start]) continue;
      let minx = sx, maxx = sx, miny = sy, maxy = sy, area = 0;
      stack.length = 0; stack.push(start); visited[start] = 1;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % w, qy = (q / w) | 0;
        area++;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx;
        if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        if (qx > 0)     { const n = q - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qx < w - 1) { const n = q + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qy > 0)     { const n = q - w; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (qy < h - 1) { const n = q + w; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }
      raw.push({ x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, area });
    }
  }

  // 6) filter by size, drop slivers + near-full-frame blobs, then merge + cap.
  const imgArea = w * h;
  let cand = raw
    .filter((b) => b.area >= imgArea * U.MIN_BOX_AREA_FRAC)
    .filter((b) => (b.w * b.h) <= imgArea * U.MAX_BOX_AREA_FRAC)
    .filter((b) => b.w >= w * U.MIN_BOX_DIM_FRAC && b.h >= h * U.MIN_BOX_DIM_FRAC)
    .sort((a, b) => b.area - a.area);

  // Fallback: nothing passed the size gate but there IS a clear subject → one box
  // around all foreground (covers a garment/person filling most of the frame).
  if (!cand.length) {
    if (fgCount < imgArea * U.MIN_BOX_AREA_FRAC) return [];
    const all = raw.reduce((acc, b) => ({
      x0: Math.min(acc.x0, b.x), y0: Math.min(acc.y0, b.y),
      x1: Math.max(acc.x1, b.x + b.w), y1: Math.max(acc.y1, b.y + b.h),
    }), { x0: w, y0: h, x1: 0, y1: 0 });
    cand = [{ x: all.x0, y: all.y0, w: all.x1 - all.x0, h: all.y1 - all.y0, area: fgCount }];
  }

  cand = mergeBoxes(cand, U.MERGE_IOU);

  // Scale back to natural coords + pad outward so seams aren't clipped.
  const inv = 1 / scale;
  let natural = cand.map((b) => {
    const padX = b.w * U.BOX_PAD_FRAC, padY = b.h * U.BOX_PAD_FRAC;
    const x0 = Math.max(0, (b.x - padX)) * inv;
    const y0 = Math.max(0, (b.y - padY)) * inv;
    const x1 = Math.min(w, (b.x + b.w + padX)) * inv;
    const y1 = Math.min(h, (b.y + b.h + padY)) * inv;
    return {
      xmin: Math.round(x0), ymin: Math.round(y0),
      width: Math.round(x1 - x0), height: Math.round(y1 - y0),
      score: Math.min(1, b.area / imgArea),
    };
  });

  // Classify (Top / Bottom / Full-body) + split a worn-outfit blob into Top + Bottom,
  // then confidence-gate and cap.
  natural = refineGarments(natural, iw, ih, U);
  const best = natural.reduce((m, b) => Math.max(m, b.score || 0), 0);
  if (best < U.MIN_CONFIDENCE) return [];
  return natural.slice(0, U.MAX_BOXES);
}

/**
 * Turn raw foreground boxes into labelled garments. A tall, person-shaped blob is an
 * outfit worn on a body → split it into a Top and a Bottom zone (so both get their
 * own bracket). Very tall narrow blobs read as Full-body; everything else is
 * classified by geometry. Each returned box carries { garmentType, label }.
 */
function refineGarments(boxes, iw, ih, U) {
  const out = [];
  for (const b of boxes) {
    const aspect = b.width / Math.max(1, b.height);
    // A person-shaped blob (tall + narrow) = a full worn OUTFIT. Even when it fills
    // the frame we no longer emit a dead-end "Full-body" box - we mark it as an outfit
    // carrying TOP + BOTTOM sub-regions so the UI can toggle between them.
    const person = b.height >= ih * U.PERSON_MIN_HEIGHT_FRAC && aspect <= U.PERSON_MAX_ASPECT;
    if (person) {
      out.push(makeOutfit(b, U));
    } else {
      const c = classifyGarment(b, iw, ih, U);
      out.push({ ...b, garmentType: c.garmentType, label: c.label });
    }
  }
  return out;
}

/** Build an OUTFIT detection: full-figure bounds + geometric TOP/BOTTOM sub-regions. */
function makeOutfit(b, U) {
  const topH = Math.round(b.height * U.SPLIT_TOP_FRAC);
  const botY = b.ymin + Math.round(b.height * U.SPLIT_BOTTOM_FRAC);
  const botH = (b.ymin + b.height) - botY;
  return {
    xmin: b.xmin, ymin: b.ymin, width: b.width, height: b.height, score: b.score,
    outfit: true, garmentType: "upper_body", label: "Top Garment",
    topBounds:    { xmin: b.xmin, ymin: b.ymin, width: b.width, height: topH },
    bottomBounds: { xmin: b.xmin, ymin: botY,   width: b.width, height: botH },
  };
}

/** Label a single box from its geometry: Full-body (tall+narrow) / Bottom / Top. */
function classifyGarment(box, iw, ih, U) {
  const aspect = box.width / Math.max(1, box.height);
  const cy     = (box.ymin + box.height / 2) / ih;
  const hFrac  = box.height / ih;
  if (hFrac >= U.FULLBODY_MIN_HEIGHT_FRAC && aspect < 0.72) return { garmentType: "upper_body", label: "Full-body" };
  if (aspect < 0.72 && cy > 0.45) return { garmentType: "lower_body", label: "Bottom" };
  return { garmentType: "upper_body", label: "Top" };
}

/** Separable morphological dilation by `r` pixels (closes small gaps in the mask). */
function dilateMask(mask, w, h, r) {
  if (!r || r < 1) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dx = -r; dx <= r; dx++) { const nx = x + dx; if (nx >= 0 && nx < w && mask[row + nx]) { on = 1; break; } }
      tmp[row + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let on = 0;
      for (let dy = -r; dy <= r; dy++) { const ny = y + dy; if (ny >= 0 && ny < h && tmp[ny * w + x]) { on = 1; break; } }
      out[y * w + x] = on;
    }
  }
  return out;
}

/**
 * Merge boxes that overlap strongly (IoU > iouThresh) or where one largely contains
 * another - collapses fragments of one garment while keeping distinct items apart.
 */
function mergeBoxes(boxes, iouThresh) {
  const out = [];
  for (const b of boxes) {
    let merged = false;
    for (const o of out) {
      const ix = Math.max(b.x, o.x), iy = Math.max(b.y, o.y);
      const ax = Math.min(b.x + b.w, o.x + o.w), ay = Math.min(b.y + b.h, o.y + o.h);
      const iw = Math.max(0, ax - ix), ih = Math.max(0, ay - iy);
      const inter = iw * ih;
      if (inter <= 0) continue;
      const iou = inter / (b.w * b.h + o.w * o.h - inter);
      const contain = inter / Math.min(b.w * b.h, o.w * o.h);
      if (iou > iouThresh || contain > 0.72) {
        const x0 = Math.min(b.x, o.x), y0 = Math.min(b.y, o.y);
        const x1 = Math.max(b.x + b.w, o.x + o.w), y1 = Math.max(b.y + b.h, o.y + o.h);
        o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0; o.area += b.area;
        merged = true; break;
      }
    }
    if (!merged) out.push({ ...b });
  }
  return out;
}

/** Guess top vs bottom: bottoms are typically tall + narrow and sit lower in frame. */
function guessGarmentType(box, iw, ih) {
  const aspect = box.width / Math.max(1, box.height);
  const centerY = (box.ymin + box.height / 2) / ih;
  if (aspect < 0.72 && centerY > 0.45) return "lower_body";
  return "upper_body";
}

/**
 * Crop a box to a padded, downscaled JPEG data URL + compute the crop's average
 * garment colour (skipping near-white background). The data URL is the handoff image.
 * @returns {{dataUrl:string, color:string, aspect:number}}
 */
function cropRegion(img, box) {
  const U = STORE_UPLOAD;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;

  const sx = Math.max(0, Math.min(box.xmin, iw - 1));
  const sy = Math.max(0, Math.min(box.ymin, ih - 1));
  const sw = Math.max(1, Math.min(box.width,  iw - sx));
  const sh = Math.max(1, Math.min(box.height, ih - sy));

  const scale = Math.min(1, U.CROP_MAX_DIM / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));

  const cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

  let color = "#8a8f98";
  try { color = averageColor(ctx, cw, ch); } catch (_) {}

  let dataUrl;
  try { dataUrl = cv.toDataURL("image/jpeg", U.CROP_QUALITY); }
  catch (_) { dataUrl = img.src; }   // tainted-canvas fallback

  return { dataUrl, color, aspect: sw / sh };
}

/** Average colour of a canvas (skips near-white pixels so a flat-lay bg doesn't wash it out). */
function averageColor(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  const step = 4 * Math.max(1, Math.floor((w * h) / 4000));   // sub-sample ~4k pixels
  for (let i = 0; i < data.length; i += step) {
    const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
    if (A < 128) continue;
    if (R > 244 && G > 244 && B > 244) continue;               // skip near-white background
    r += R; g += G; b += B; n++;
  }
  if (!n) return "#8a8f98";
  const hx = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/* ── init ── */
function init() {
  setBag(getBag());
  buildTickers();
  renderNew();
  renderLookbook();
  renderFavs();

  // delegated clicks
  document.addEventListener("click", (e) => {
    // "Upload Your Own Garment" card / button - open the native file picker.
    if (e.target.closest("[data-upload]")) { openGarmentUpload(); return; }

    // TOP / BOTTOM segmented toggle (outfit mode) - snap the bracket between regions.
    const tab = e.target.closest(".gd-tab");
    if (tab) { setActiveSide(tab.dataset.side); return; }

    // Pick a detected garment inside the overlay.
    const gb = e.target.closest(".gd-box");
    if (gb) { selectDetectedGarment(Number(gb.dataset.box)); return; }

    // Close the detection overlay (✕ / backdrop) or retry the picker.
    if (e.target.closest("[data-gd-close]")) { closeGarmentDetect(); return; }
    if (e.target.closest("#gdRetry"))        { openGarmentUpload(); return; }

    const f = e.target.closest("[data-filter]");
    if (f) {
      const key = f.dataset.filter;
      const hash = key === "all" ? "home" : key === "shirt" ? "shirts" : key;
      if (location.hash.replace("#", "") === hash) renderCatalog(HASH_TO_FILTER[hash]);
      else location.hash = hash;
      if (key !== "all" || f.closest(".look__tile") || f.closest(".lookbook")) {
        $("#catalog").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    const t = e.target.closest("[data-try]");
    if (t) { const p = PRODUCTS.find((x) => x.id === +t.dataset.try); if (p) openTryOn(p); return; }
    const sw = e.target.closest("[data-switch]");
    if (sw) { const p = PRODUCTS.find((x) => x.id === +sw.dataset.switch); if (p) switchItem(p); return; }
    const lc = e.target.closest("[data-launch]");
    if (lc) { const p = PRODUCTS.find((x) => x.id === +lc.dataset.launch); if (p) launchPearCamera(p); return; }
    if (e.target.closest("[data-tryon-close]")) { closeTryOn(); return; }
    if (e.target.closest("[data-netmodal-close]")) { hideNetworkModal(); return; }
    const a = e.target.closest("[data-bag]");
    if (a) { const p = PRODUCTS.find((x) => x.id === +a.dataset.bag); if (p) addToBag(p); return; }
  });

  // close modals with Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const gd = $("#garmentDetect");
      if (gd && gd.classList.contains("show")) { closeGarmentDetect(); return; }
      if (netModalEl.classList.contains("open")) { hideNetworkModal(); return; }
      if (tryonEl.classList.contains("open")) closeTryOn();
    }
  });

  // "Upload Your Own Garment" - file input + keyboard access on the (role=button) card.
  const uploadInput = $("#garmentUploadInput");
  if (uploadInput) uploadInput.addEventListener("change", onGarmentFileChosen);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest && e.target.closest("[data-upload]")) { e.preventDefault(); openGarmentUpload(); }
  });

  // network modal actions
  $("#netModalRetry").addEventListener("click", async () => {
    const p = pendingProduct;
    hideNetworkModal();
    if (p) await openTryOn(p);
  });

  // favorites carousel controls
  const step = () => Math.min(favTrack.clientWidth * 0.8, 360);
  $("#favPrev").addEventListener("click", () => favTrack.scrollBy({ left: -step(), behavior: "smooth" }));
  $("#favNext").addEventListener("click", () => favTrack.scrollBy({ left: step(), behavior: "smooth" }));

  $("#bagBtn").addEventListener("click", () => {
    const n = getBag();
    showToast(n ? `Your bag holds <b>${n}</b> ${n === 1 ? "item" : "items"}` : "Your bag is empty");
  });

  $("#newsForm").addEventListener("submit", (e) => { e.preventDefault(); e.target.reset(); showToast("Thanks - you're <b>subscribed</b>!"); });

  window.addEventListener("hashchange", routeFromHash);

  // initial catalog state from hash (default all)
  renderCatalog(currentFilter() || "all");
}

document.addEventListener("DOMContentLoaded", init);
