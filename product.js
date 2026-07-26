/* ============================================================
   MERIDIAN - Product Detail View (product.html)
   Reads ?id=N, renders the garment, and hands off to the PEAR
   Camera (calculator-first flow) via URL query parameters.
   Depends on catalog.js (PRODUCTS, SUBTYPE_LABEL, SIZES, shade, garmentSVG).
   ============================================================ */
"use strict";

const PEAR_PATH = "/fitting-room/";
const LS_BAG    = "meridian_bag";
const LS_TRYON  = "pear_tryon";

const $ = (s, r = document) => r.querySelector(s);

/* ── bag ── */
function getBag() { return parseInt(localStorage.getItem(LS_BAG) || "0", 10); }
function setBag(n) {
  localStorage.setItem(LS_BAG, String(n));
  const el = $("#bagCount");
  if (el) { el.textContent = n; el.classList.toggle("show", n > 0); }
}

/* ── toast ── */
let toastTimer;
function showToast(html) {
  const t = $("#toast");
  if (!t) return;
  t.innerHTML = html; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ── product-page color display ──────────────────────────────────────────────
   garmentSVG() (from catalog.js) generates a procedural garment in any hex
   color. It always shows the correct garment shape (subType) and the exact
   selected color - same composition every time, zero jarring image swaps.
   The canonical imageUrl is reserved for the VTON reference payload only. */
function pdpSvgOf(color) {
  const wrap = "display:flex;align-items:center;justify-content:center;"
    + "width:100%;height:100%;background:#f3f4f6;padding:32px;box-sizing:border-box";
  return `<span style="${wrap}">${garmentSVG({ ...product, color })}</span>`;
}

/* ── PEAR handoff URL ────────────────────────────────────────────────────────
   Always sends the canonical imageUrl so PEAR receives the correct
   garment-shape reference regardless of which color variant is active.
   Color is communicated separately via the `color` query param (and the
   PEAR text prompt uses colorName() to describe it to the VTON model). */
function pearUrl(p, color, angle) {
  const params = {
    id: p.id,
    itemType: p.type,
    subType: p.subType,
    color: color.replace("#", ""),
    name: p.name,
    angle: angle || "front",       // ← the view the shopper is inspecting (front|back|side|detail)
    img: p.imageUrl || "",         // real FRONT packshot stays the VTON reference; the angle
                                   //   param (not a placeholder photo) tells PEAR which side to render
  };
  return `${PEAR_PATH}?${new URLSearchParams(params).toString()}`;
}

/* The angle key of the thumbnail the shopper currently has open - this is the
   piece of gallery state the try-on needs, so the AI renders THAT side. */
function activeAngleKey() {
  const imgs = productImages(product);
  const cur = imgs[activeImageIndex];
  return (cur && cur.angle) || "front";
}

/* ── state ── */
let product = null;         // the selected product object == the spec's `activeGarment`
let activeColor = null;
let activeSize = "M";
let activeImageIndex = 0;   // index into productImages(product) shown in the main viewport

function findProduct() {
  const id = parseInt(new URLSearchParams(location.search).get("id"), 10);
  return PRODUCTS.find((p) => p.id === id) || null;
}

/* ── render ── */
function render() {
  const grid = $("#pdpGrid");

  grid.innerHTML = `
    <section class="pdp__media${hasPhotoGallery(product) ? " pdp__media--gallery" : ""}">
      ${hasPhotoGallery(product)
        ? `<div class="pdp__gallery" id="pdpGallery"></div>`
        : `<span class="pdp__badge"${product.isNew ? "" : " hidden"}>New Arrival</span>
           <div class="pdp__svg" id="pdpSvg">${pdpSvgOf(activeColor)}</div>`}
    </section>

    <section class="pdp__info">
      <span class="pdp__cat">${product.category} · ${SUBTYPE_LABEL[product.subType]}</span>
      <h1 class="pdp__name">${product.name}</h1>
      <div class="pdp__price">$${product.price}</div>
      <p class="pdp__desc">
        Engineered premium ${product.type === "shirt" ? "upper-body essential" : "trouser"},
        cut for comfort and movement. Preview the exact fit on yourself with the PEAR Camera.
      </p>

      <div class="pdp__field">
        <span class="pdp__label">Color</span>
        <div class="pdp__swatches" id="swatches"></div>
      </div>

      <div class="pdp__field">
        <span class="pdp__label">Size</span>
        <div class="pdp__sizes" id="sizes"></div>
      </div>

      <!-- Two-view (front/back) completeness indicator - mirrors the fitting-room badge -->
      ${viewStatusChip(product)}

      <!-- Prominent Virtual Try-On CTA, directly below the product image column -->
      <button class="pdp__tryon" id="tryonBtn"${canTryOn(product) ? "" : " disabled aria-disabled=\"true\""}>
        <span class="pdp__tryon-he">מדידה וירטואלית</span>
        <span class="pdp__tryon-en">Virtual Try-On · PEAR Camera</span>
        <span class="pdp__tryon-icon" aria-hidden="true">👕</span>
      </button>

      <button class="pdp__add" id="addBtn">Add to Bag</button>

      <ul class="pdp__perks">
        <li>Free shipping &amp; returns</li>
        <li>Try before you buy - virtually</li>
        <li>Spring 2026 collection</li>
      </ul>
    </section>`;

  renderSwatches();
  renderSizes();
  if (hasPhotoGallery(product)) renderProductGallery(product);

  $("#crumbs").innerHTML =
    `<a href="index.html#home">Home</a>` +
    `<span>/</span><a href="index.html#${product.type === "shirt" ? "shirts" : "pants"}">${product.category}</a>` +
    `<span>/</span><b>${product.name}</b>`;

  $("#tryonBtn").addEventListener("click", launchPear);
  $("#addBtn").addEventListener("click", () => {
    setBag(getBag() + 1);
    showToast(`<b>${product.name}</b> (${activeSize}) added to bag`);
  });
}

function renderSwatches() {
  const wrap = $("#swatches");
  const variants = product.variants || [];
  wrap.innerHTML = variants.map((v) => `
    <button class="swatch${v.color === activeColor ? " is-active" : ""}"
            style="--c:${v.color}" data-color="${v.color}" title="${v.label}"
            aria-label="${v.label}"></button>`).join("");
  wrap.querySelectorAll(".swatch").forEach((b) => {
    b.addEventListener("click", () => {
      activeColor = b.dataset.color;
      // SVG media (single-image products) OR the hidden broken-image fallback
      // (gallery products) - update whichever is present. In gallery mode the
      // photos are fixed, so the swatch just tracks activeColor for the handoff.
      const svg = $("#pdpSvg");
      if (svg) svg.innerHTML = pdpSvgOf(activeColor);
      const fb = $(".pdp__main-fallback");
      if (fb) fb.innerHTML = pdpSvgOf(activeColor);
      wrap.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("is-active", x === b));
    });
  });
}

function renderSizes() {
  const wrap = $("#sizes");
  wrap.innerHTML = SIZES.map((s) => `
    <button class="size-pill${s === activeSize ? " is-active" : ""}" data-size="${s}">${s}</button>`).join("");
  wrap.querySelectorAll(".size-pill").forEach((b) => {
    b.addEventListener("click", () => {
      activeSize = b.dataset.size;
      wrap.querySelectorAll(".size-pill").forEach((x) => x.classList.toggle("is-active", x === b));
    });
  });
}

/* ── Multi-image product gallery (main viewport + thumbnail strip) ────────────
   Fully generic: driven only by productImages(product) + activeImageIndex, so
   EVERY product with 2+ images renders a gallery - nothing is hard-coded to a
   specific item. Products with a single image never reach here (the
   hasPhotoGallery() gate in render() keeps them on the recolour SVG), so the
   strip is never empty or broken. Clicking a thumbnail crossfades the main
   viewport and moves the active border - a real retail PDP gallery. */
function renderProductGallery(p) {
  const host = $("#pdpGallery");
  if (!host) return;
  const images = productImages(p);
  if (images.length < 2) return;                          // safety: single/no image → no strip
  if (activeImageIndex < 0 || activeImageIndex >= images.length) activeImageIndex = 0;
  const current = images[activeImageIndex];

  host.innerHTML = `
    <ul class="product-thumbnails" id="pdpThumbs" role="listbox" aria-label="Product views">
      ${images.map((img, i) => `
        <li role="presentation">
          <button type="button" class="product-thumb${i === activeImageIndex ? " is-active" : ""}"
                  data-index="${i}" data-angle="${img.angle}"
                  role="option" aria-selected="${i === activeImageIndex}"
                  aria-label="${img.label} view">
            <img src="${img.url}" alt="${p.name} - ${img.label}" loading="lazy" decoding="async"
                 onerror="this.closest('.product-thumb')?.setAttribute('hidden','');">
            <span class="product-thumb__label">${img.label}</span>
          </button>
        </li>`).join("")}
    </ul>
    <div class="pdp__stage">
      <span class="pdp__badge"${p.isNew ? "" : " hidden"}>New Arrival</span>
      <img class="pdp__main" id="pdpMain" style="grid-area:1/1" src="${current.url}"
           alt="${p.name} - ${current.label}" decoding="async"
           onerror="this.style.display='none';var f=this.parentNode.querySelector('.pdp__main-fallback');if(f)f.style.display='flex';">
      <span class="pdp__main-fallback" style="grid-area:1/1;display:none;width:100%;height:100%;align-items:center;justify-content:center">${pdpSvgOf(activeColor)}</span>
    </div>`;

  host.querySelectorAll(".product-thumb").forEach((btn) => {
    btn.addEventListener("click", () => setActiveImage(p, parseInt(btn.dataset.index, 10)));
  });
}

function setActiveImage(p, index) {
  const images = productImages(p);
  if (Number.isNaN(index) || index === activeImageIndex || !images[index]) return;
  activeImageIndex = index;

  // active border on the clicked thumb
  document.querySelectorAll("#pdpThumbs .product-thumb").forEach((b) => {
    const on = parseInt(b.dataset.index, 10) === index;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", String(on));
  });

  // crossfade the main viewport: preload → fade out → swap cached src → fade in.
  // Preloading first guarantees no flicker / blank frame during the swap.
  const main = $("#pdpMain");
  if (!main) return;
  const fallback = main.parentNode.querySelector(".pdp__main-fallback");
  const { url, label } = images[index];
  const pre = new Image();
  pre.decoding = "async";
  pre.onload = () => {
    main.classList.add("is-fade");
    setTimeout(() => {
      main.src = url;
      main.alt = `${p.name} - ${label}`;
      main.style.display = "";                            // restore if a prior view had errored
      if (fallback) fallback.style.display = "none";
      main.classList.remove("is-fade");
    }, 170);                                              // matches .pdp__main opacity transition
  };
  pre.onerror = () => {                                   // broken image → show the SVG stand-in
    main.style.display = "none";
    if (fallback) fallback.style.display = "flex";
  };
  pre.src = url;
}

/* Two-view completeness chip shown above the try-on CTA. Reflects the SAME
   hasFrontView/hasBackView predicates the fitting room uses, so what the shopper
   sees here matches what the live engine will (or won't) let them do. A garment
   with both real views reads "Front + Back ready"; one missing its back reads as
   front-only (and, if the item opts into requireBothViews, the CTA is disabled). */
function viewStatusChip(p) {
  const front = hasFrontView(p), back = hasBackView(p);
  const both = front && back;
  const blocked = !canTryOn(p);
  const dot = (on) => `<span class="viewchip__dot${on ? " is-on" : ""}" aria-hidden="true"></span>`;
  const label = blocked
    ? tryOnBlockReason(p)
    : both ? "Front + Back views ready"
           : "Front view · back rendered from front";
  return `<div class="viewchip${both ? " viewchip--complete" : ""}${blocked ? " viewchip--blocked" : ""}"
               role="status" aria-label="${label}">
    <span class="viewchip__views">${dot(front)}Front ${dot(back)}Back</span>
    <span class="viewchip__label">${label}</span>
  </div>`;
}

/* ── handoff to PEAR (remembers the garment; PEAR runs the calculator first) ── */
function launchPear() {
  // Two-view gate: graceful by default (front stands in for a missing back), but a
  // product flagged requireBothViews is hard-blocked until it ships a real back view.
  const blockReason = tryOnBlockReason(product);
  if (blockReason) { showToast(`<b>Try-on unavailable</b> - ${blockReason}`); return; }

  const angle = activeAngleKey();                 // ← current gallery selection drives the try-on view
  const url = pearUrl(product, activeColor, angle);
  const payload = {
    id:       product.id,
    itemType: product.type,
    subType:  product.subType,
    color:    activeColor.replace("#", ""),
    name:     product.name,
    size:     activeSize,
    angle:    angle,                              // persisted so PEAR opens on the same side the shopper chose
    img:      product.imageUrl || "(none)",
  };

  console.group("[PEAR] launchPear() - handoff debug");
  console.log("product :", product.name, `(id=${product.id})`);
  console.log("type    :", product.type, "| subType:", product.subType);
  console.log("color   :", activeColor, "| size:", activeSize);
  console.log("angle   :", angle, "(active gallery thumbnail)");
  console.log("img URL :", product.imageUrl || "(no imageUrl on this product)");
  console.log("target  :", url);
  console.log("payload :", payload);
  console.groupEnd();

  if (!product.imageUrl) {
    console.warn("[PEAR] launchPear() - product.imageUrl is empty; the VTON model will have no garment reference image.");
  }

  try {
    localStorage.setItem(LS_TRYON, JSON.stringify(payload));
  } catch (_) {}
  showToast(`Launching <b>PEAR Camera</b> - ${product.name} · ${angle} view…`);
  setTimeout(() => { location.href = url; }, 600);
}

/* ── not found ── */
function renderNotFound() {
  $("#pdpGrid").innerHTML = `
    <div class="pdp__missing">
      <h1>Product not found</h1>
      <p>We couldn't find that item. Browse the full collection instead.</p>
      <a class="btn btn--primary" href="index.html#catalog">Back to shop</a>
    </div>`;
}

/* ── init ── */
function init() {
  setBag(getBag());
  $("#bagBtn").addEventListener("click", () => {
    const n = getBag();
    showToast(n ? `Your bag holds <b>${n}</b> ${n === 1 ? "item" : "items"}` : "Your bag is empty");
  });

  product = findProduct();
  if (!product) { renderNotFound(); return; }
  activeColor = product.variants?.[0]?.color || product.color;
  render();
}

document.addEventListener("DOMContentLoaded", init);
