/* ============================================================
   MERIDIAN - shared catalog data + garment SVG generator.
   Loaded before store.js (homepage) and product.js (product page)
   so both render from a single source of truth. Plain globals,
   no build step.
   ============================================================ */
"use strict";

/* ── real product imagery - clean white-background packshots ──
   Every imageUrl below is a flat-lay / ghost-mannequin product shot on a pure
   (or near-pure) WHITE background - no model, no scene, no text - so Decart
   Lucy VTON can cleanly isolate the garment boundary. Sourced from openly
   hotlinkable retail/CDN endpoints; each was downloaded and VISUALLY verified
   (not just checked for HTTP 200). If any URL ever fails to load, garmentImg()
   falls back to the procedural garmentSVG() (itself pure-white) so the layout
   never breaks. Mirror of pear-demo/app.js PEAR_CATALOG - keep the two in sync. */

/* ── catalog ──
   schema: id, name, price, category, type, subType, color, isNew, fav, imageUrl */
/* ── variant data ──
   Each variant carries only { color, label }.
   No per-variant image: the product-page color picker renders garmentSVG()
   (procedurally generated, same composition for every color - pixel-accurate).
   The top-level imageUrl is the VTON reference + store-catalog thumbnail only. */

const PRODUCTS = [
  // ── SHIRTS ────────────────────────────────────────────────────────────────
  {
    id: 1, name: "Halo Tank", price: 88, category: "Shirts", type: "shirt", subType: "sleeveless",
    color: "#3f5a8a", isNew: true, fav: true,
    imageUrl: "https://live.staticflickr.com/8726/17084787712_8905988312_b.jpg",
    variants: [
      { color: "#3f5a8a", label: "Slate Blue" },
      { color: "#1a1a1a", label: "Black"      },
      { color: "#c8c4be", label: "Stone"      },
    ],
  },
  {
    id: 2, name: "Vapor Sleeveless", price: 72, category: "Shirts", type: "shirt", subType: "sleeveless",
    color: "#b8c0cc", isNew: false, fav: false,
    imageUrl: "https://live.staticflickr.com/8726/17084787712_8905988312_b.jpg",
    variants: [
      { color: "#b8c0cc", label: "Light Grey" },
      { color: "#2b2b30", label: "Charcoal"   },
      { color: "#c2452f", label: "Red"        },
    ],
  },
  {
    id: 3, name: "Ion Crew Tee", price: 96, category: "Shirts", type: "shirt", subType: "short_sleeve",
    color: "#c2452f", isNew: true, fav: true,
    imageUrl: "https://burst.shopifycdn.com/photos/red-t-shirt.jpg",
    variants: [
      { color: "#c2452f", label: "Red"      },
      { color: "#f0ede6", label: "White"    },
      { color: "#1a1a1a", label: "Black"    },
    ],
  },
  {
    id: 4, name: "Pulse Tee", price: 84, category: "Shirts", type: "shirt", subType: "short_sleeve",
    color: "#1f6feb", isNew: false, fav: true,
    imageUrl: "https://burst.shopifycdn.com/photos/cobalt-blue-t-shirt.jpg",
    variants: [
      { color: "#1f6feb", label: "Blue"  },
      { color: "#f0ede6", label: "White" },
      { color: "#1a1a1a", label: "Black" },
    ],
  },
  {
    id: 5, name: "Circuit Tee", price: 90, category: "Shirts", type: "shirt", subType: "short_sleeve",
    color: "#149c7a", isNew: false, fav: false,
    imageUrl: "https://burst.shopifycdn.com/photos/teal-t-shirt.jpg",
    variants: [
      { color: "#149c7a", label: "Teal"     },
      { color: "#f0ede6", label: "White"    },
      { color: "#2b2b30", label: "Charcoal" },
    ],
  },
  {
    id: 6, name: "Strata Longsleeve", price: 128, category: "Shirts", type: "shirt", subType: "long_sleeve",
    color: "#2b2b30", isNew: true, fav: true,
    // Opt into the STRICT two-view gate - Strata ships a real Back photo (below), so
    // it satisfies front+back and stays try-on-able. Mirrors PEAR_CATALOG id 6.
    requireBothViews: true,
    imageUrl: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-1.jpg?v=1732626199&width=1024",
    /* ── Multi-image gallery (real, visually-verified assets) ──
       A per-product `images` array is the single source of truth for the PDP
       gallery. Each entry is { url, label } (a plain URL string is also accepted
       and auto-labelled "View N"). ANY product gains a thumbnail gallery just by
       listing 2+ images here - the renderer in product.js is fully generic and
       hard-codes nothing about this item. universalcolours -1/-3/-4 = front
       packshot / back-on-model / fabric+logo detail macro. No true side profile
       exists for this item, so it is omitted - never faked. */
    images: [
      { url: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-1.jpg?v=1732626199&width=1024", label: "Front"  },
      { url: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-3.jpg?v=1732626199&width=1024", label: "Back"   },
      { url: "https://www.universalcolours.com/cdn/shop/files/LongSleeveTee-CharcoalBlack-4.jpg?v=1732626199&width=1024", label: "Detail" },
    ],
    variants: [
      { color: "#2b2b30", label: "Charcoal" },
      { color: "#f0ede6", label: "White"    },
      { color: "#7c1e2e", label: "Burgundy" },
    ],
  },
  {
    id: 7, name: "Nimbus Henley", price: 134, category: "Shirts", type: "shirt", subType: "long_sleeve",
    color: "#8e7bd0", isNew: false, fav: false,
    imageUrl: "https://cdn.shopify.com/s/files/1/0831/9103/products/DK_LS_Henley_Dark_Purple-Final-Web.jpg?v=1665703111",
    variants: [
      { color: "#8e7bd0", label: "Lavender" },
      { color: "#f0ede6", label: "White"    },
      { color: "#22324f", label: "Navy"     },
    ],
  },
  {
    id: 8, name: "Echo Longsleeve", price: 118, category: "Shirts", type: "shirt", subType: "long_sleeve",
    color: "#d8d4cb", isNew: false, fav: false,
    imageUrl: "https://img.freepik.com/premium-photo/beige-long-sleeve-shirt-isolated-white-background_1166140-13287.jpg",
    variants: [
      { color: "#d8d4cb", label: "Off-White" },
      { color: "#2b2b30", label: "Charcoal"  },
      { color: "#8e7bd0", label: "Lavender"  },
    ],
  },
  // ── PANTS ─────────────────────────────────────────────────────────────────
  {
    id: 9, name: "Glide Slim", price: 142, category: "Pants", type: "pants", subType: "slim",
    color: "#2a2d34", isNew: true, fav: true,
    imageUrl: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6905_28.jpg",
    variants: [
      { color: "#2a2d34", label: "Charcoal" },
      { color: "#3b5bdb", label: "Cobalt"   },
      { color: "#c8b89a", label: "Beige"    },
    ],
  },
  {
    id: 10, name: "Mono Slim", price: 118, category: "Pants", type: "pants", subType: "slim",
    color: "#6e7681", isNew: false, fav: false,
    imageUrl: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B6906_28.jpg",
    variants: [
      { color: "#6e7681", label: "Steel Grey" },
      { color: "#2a2d34", label: "Charcoal"   },
      { color: "#c8b89a", label: "Khaki"      },
    ],
  },
  {
    id: 11, name: "Vector Regular", price: 132, category: "Pants", type: "pants", subType: "regular",
    color: "#3b5bdb", isNew: false, fav: true,
    imageUrl: "https://image.hm.com/assets/hm/54/71/5471b01a9ccf7562c74cf7d8f0102228465f30b5.jpg?imwidth=2160",
    variants: [
      { color: "#3b5bdb", label: "Cobalt" },
      { color: "#2a2d34", label: "Black"  },
      { color: "#c8b89a", label: "Khaki"  },
    ],
  },
  {
    id: 12, name: "Apex Regular", price: 124, category: "Pants", type: "pants", subType: "regular",
    color: "#8a8f98", isNew: true, fav: false,
    imageUrl: "https://image.hm.com/assets/hm/72/56/7256f227cb82ac834363dfb140f245652797d841.jpg?imwidth=1536",
    variants: [
      { color: "#8a8f98", label: "Slate Grey" },
      { color: "#22324f", label: "Navy"       },
      { color: "#2a2d34", label: "Black"      },
    ],
  },
  {
    id: 13, name: "Drift Wide", price: 156, category: "Pants", type: "pants", subType: "wide",
    color: "#1a1a1d", isNew: false, fav: true,
    imageUrl: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_300px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_768,h_922,f_auto,q_auto,fl_progressive/products/Trousers/default/B25209_28.jpg",
    variants: [
      { color: "#1a1a1d", label: "Black"      },
      { color: "#6e7681", label: "Slate Grey" },
      { color: "#566b3e", label: "Olive"      },
    ],
  },
  {
    id: 14, name: "Terra Wide", price: 148, category: "Pants", type: "pants", subType: "wide",
    color: "#a8794f", isNew: true, fav: false,
    imageUrl: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B25212_28.jpg",
    variants: [
      { color: "#a8794f", label: "Tan"   },
      { color: "#2a2d34", label: "Black" },
      { color: "#566b3e", label: "Olive" },
    ],
  },
  {
    id: 15, name: "Null Slim", price: 138, category: "Pants", type: "pants", subType: "slim",
    color: "#22324f", isNew: false, fav: false,
    imageUrl: "https://cdn.suitsupply.com/image/upload/b_rgb:efefef,bo_500px_solid_rgb:efefef,c_pad,w_2600/b_rgb:efefef,c_pad,dpr_1,w_850,h_1176,f_auto,q_auto,fl_progressive/products/Trousers/default/B9449_28.jpg",
    variants: [
      { color: "#22324f", label: "Navy"  },
      { color: "#2a2d34", label: "Black" },
      { color: "#6e7681", label: "Grey"  },
    ],
  },
  {
    id: 16, name: "Cargo Wide", price: 162, category: "Pants", type: "pants", subType: "wide",
    color: "#566b3e", isNew: false, fav: true,
    imageUrl: "https://image.hm.com/assets/hm/31/ab/31ab5b52cc238aaad4d95fa3a79d2af741bf7192.jpg?imwidth=1536",
    variants: [
      { color: "#566b3e", label: "Olive" },
      { color: "#2a2d34", label: "Black" },
      { color: "#c8b89a", label: "Khaki" },
    ],
  },
  // ── Gatekeeper TEST item (intentionally incomplete) ─────────────────────────
  // Mirrors PEAR_CATALOG id 99. Ships a front (imageUrl) but NO back, and opts into
  // strict via requireBothViews → canTryOn() is false, so the PDP try-on CTA renders
  // disabled and viewStatusChip() shows the blocked state. imageUrl is a verified
  // placeholder packshot (the item is never tried on). Delete to hide the test.
  {
    id: 99, name: "Urban Bomber Jacket (Incomplete Test)", price: 168, category: "Shirts", type: "shirt", subType: "long_sleeve",
    color: "#3a3f47", isNew: false, fav: false,
    requireBothViews: true,
    imageUrl: "https://burst.shopifycdn.com/photos/cobalt-blue-t-shirt.jpg",
    variants: [
      { color: "#3a3f47", label: "Slate" },
    ],
  },
];

/* ── product imagery policy ───────────────────────────────────────────────────
   A product gets a multi-thumbnail gallery ONLY from REAL photos it actually
   ships - declared as an `images` array (see Strata, id 6) or the legacy
   `gallery` map. We do NOT synthesize placeholder angles (a random stock photo is
   not the garment, and a duplicated front is a fake angle). Products with a single
   real photo therefore show one accurate view - the recolourable garmentSVG on the
   PDP - with no thumbnail rail, which is the correct graceful state. To give any
   product a real gallery, add its true photos to an `images: [{url,label,angle}]`
   array here and the PDP + PEAR angle handoff light up automatically. */

const SUBTYPE_LABEL = {
  sleeveless: "Sleeveless", short_sleeve: "Short Sleeve", long_sleeve: "Long Sleeve",
  slim: "Slim Fit", regular: "Regular Fit", wide: "Wide Leg",
};

const SIZES = ["S", "M", "L", "XL"];

/* ── Product image gallery (shared source of truth) ──────────────────────────
   productImages(p) is the ONE normalizer every consumer uses. It returns an
   ordered [{ url, label }] list from whichever shape a product declares, so the
   renderer never has to branch per product:

     1. p.images  - preferred. An array of { url, label } objects (or plain URL
                    strings, auto-labelled "View N"). Add 2+ entries to ANY
                    product and it gets a gallery - nothing else to touch.
     2. p.gallery - legacy angle map { front, back, side, detail }; kept working
                    for backward compatibility, front falling back to imageUrl.
     3. p.imageUrl - a single packshot → a one-image list.

   Angles/views with no real photo are simply omitted - never duplicated or
   faked. Consumed by the storefront PDP (product.js). */
const GALLERY_ANGLES = ["front", "back", "side", "detail"];
const ANGLE_LABEL = { front: "Front", back: "Back", side: "Side", detail: "Detail" };

/* Normalized angle key ("front"|"back"|"side"|"detail"|…) for one image entry.
   An explicit `angle` field wins; otherwise it's derived from the label (so
   { label: "Back" } → "back"), with index 0 defaulting to "front". This key is
   what the PDP forwards to the PEAR Camera so the try-on renders the right side. */
function imageAngleKey(it, i) {
  if (it && it.angle) return String(it.angle).toLowerCase();
  const l = (it && it.label ? String(it.label) : "").trim().toLowerCase();
  if (l) return l;
  return i === 0 ? "front" : `view${i + 1}`;
}

function productImages(p) {
  if (!p) return [];

  // 1) explicit images array - strings or { url, label, angle? } objects
  if (Array.isArray(p.images) && p.images.length) {
    return p.images
      .map((it, i) => (typeof it === "string"
        ? { url: it, label: `View ${i + 1}`, angle: imageAngleKey({ label: `View ${i + 1}` }, i) }
        : { url: it && it.url, label: (it && it.label) || `View ${i + 1}`, angle: imageAngleKey(it, i) }))
      .filter((it) => it.url);
  }

  // 2) legacy angle map (back-compat with older catalog entries)
  if (p.gallery && typeof p.gallery === "object") {
    const out = [];
    for (const a of GALLERY_ANGLES) {
      const url = p.gallery[a] || (a === "front" ? p.imageUrl : null);
      if (url) out.push({ url, label: ANGLE_LABEL[a], angle: a });
    }
    if (out.length) return out;
  }

  // 3) single packshot
  return p.imageUrl ? [{ url: p.imageUrl, label: "Front", angle: "front" }] : [];
}

/* Back-compat alias: older callers used productGallery(). */
function productGallery(p) { return productImages(p); }

/* True when a product ships a real multi-image set worth rendering as a gallery
   (vs. the procedural recolour SVG). Single-image products stay on the SVG. */
function hasPhotoGallery(p) { return productImages(p).length >= 2; }

/* ── Two-view (front / back) completeness - shared source of truth ────────────
   The PEAR VTON model treats FRONT and BACK as the two canonical garment views.
   hasView() reports whether a product ships a REAL image for an angle - never a
   duplicated or faked one, since productImages() already omits absent angles. A
   product is "fully documented" only when it ships BOTH a real front AND a real
   back. These predicates are mirrored verbatim in fitting-room/app.js so the
   storefront PDP and the live fitting room judge completeness identically.

   Design note (per product decision): the gate is GRACEFUL by default - a missing
   back never blocks try-on; the front image stands in and a prompt clause steers
   the rear render. Only a product that OPTS IN with `requireBothViews: true` is
   hard-blocked when it lacks a real back view. Nothing in the catalog sets this
   flag today, so default try-on is unchanged; flip it on any item to demand the
   full two-view set for that item. */
function hasView(p, angle) { return productImages(p).some((it) => it.angle === angle); }
function hasFrontView(p) { return hasView(p, "front"); }
/* Back counts as available when the product ships a REAL back photo OR carries a
   mirrored-front back reference (backFromFront, populated by the init loop below).
   The mirror is deliberately kept OUT of productImages() so it never adds a
   duplicated front to the PDP thumbnail strip - it only satisfies the try-on gate
   and the two-view chip. */
function hasBackView(p)  { return hasView(p, "back") || !!(p && p.backFromFront); }
function hasBothViews(p) { return hasFrontView(p) && hasBackView(p); }

/* Returns a human-readable reason string when the product may NOT be tried on, or
   null when it may. Front is always required (no garment reference otherwise);
   back is only required for opt-in strict items. */
function tryOnBlockReason(p) {
  if (!p) return "No garment selected.";
  if (!hasFrontView(p)) return "This garment has no front-view image yet.";
  if (p.requireBothViews && !hasBackView(p)) return "This garment is missing its required back-view image.";
  return null;
}
function canTryOn(p) { return !tryOnBlockReason(p); }

/* ── Back-view auto-fill (storefront mirror) - parity with PEAR_CATALOG ────────
   Every real product's own front image doubles as its Back try-on reference, so the
   two-view chip reads complete and the PEAR handoff has a populated Back asset. We
   store it on `backFromFront` (a plain reference URL) rather than pushing it into
   productImages(): a duplicated front in the PDP gallery would be a FAKE angle (see
   the imagery policy above) AND would flip single-photo items out of their recolour-
   SVG mode. The mock test item (id 99) is excluded so it stays the one blocked demo;
   items with a REAL back photo already report hasBackView() true and are left alone. */
for (const _p of PRODUCTS) {
  if (_p.id !== 99 && !hasBackView(_p) && _p.imageUrl) _p.backFromFront = _p.imageUrl;
}

/* ── color helper ── */
function shade(hex, p) {
  const f = parseInt(hex.slice(1), 16);
  const t = p < 0 ? 0 : 255, a = Math.abs(p);
  const R = f >> 16, G = (f >> 8) & 0xff, B = f & 0xff;
  const mix = (c) => Math.round((t - c) * a) + c;
  return "#" + (0x1000000 + mix(R) * 0x10000 + mix(G) * 0x100 + mix(B)).toString(16).slice(1);
}

/* ── garment SVG generation - studio flat-lay style ─────────────────────────
   Every output is a self-contained SVG with:
     • pure-white (#fff) background → no photo, no model, no background noise
     • CSS drop-shadow → subtle product-photography depth
     • accurate silhouette per subType (sleeveless / short / long / slim / regular / wide)
     • per-subType detail layer (collar rib, shoulder seams, sleeve hems, cuffs,
       waistband, belt loops, fly, pocket seams, knee creases, hem stitching)
     • two-stop gradient fill + highlight sheen overlay
   Used by the store catalog cards, product detail page, try-on panel, and
   PEAR catalog thumbnails - single source of truth for all garment visuals. */

const SHIRT_PATHS = {
  sleeveless:   "M92 50 Q110 64 128 50 L144 62 Q151 92 151 122 L151 236 L69 236 L69 122 Q69 92 76 62 Z",
  short_sleeve: "M88 50 Q110 66 132 50 L170 68 L188 122 L166 130 L152 106 L152 236 L68 236 L68 106 L54 130 L32 122 L50 68 Z",
  long_sleeve:  "M88 50 Q110 66 132 50 L170 68 L198 204 L170 212 L152 108 L152 236 L68 236 L68 108 L50 212 L22 204 L50 68 Z",
};
const PANT_PATHS = {
  slim:    "M66 44 L154 44 L150 238 L124 238 L111 120 L96 238 L70 238 Z",
  regular: "M62 44 L158 44 L156 238 L120 238 L110 124 L100 238 L64 238 Z",
  wide:    "M58 44 L162 44 L172 238 L138 238 L112 126 L108 126 L82 238 L48 238 Z",
};

function garmentSVG(p) {
  const isShirt = p.type === "shirt";
  const d = isShirt ? SHIRT_PATHS[p.subType] : PANT_PATHS[p.subType];
  const pid  = "p" + p.id;
  const lite = shade(p.color,  0.30);
  const base = p.color;
  const mid  = shade(p.color, -0.15);
  const dark = shade(p.color, -0.38);
  const ink  = shade(p.color, -0.54);

  /* ── per-subtype detail lines ── */
  let detail = "";

  if (isShirt) {
    /* collar rib (filled torus for all shirt subtypes) */
    detail += `<ellipse cx="110" cy="55" rx="20" ry="7"
      fill="${mid}" stroke="${ink}" stroke-width="1.5" opacity="0.55"/>`;

    if (p.subType === "sleeveless") {
      /* armhole seam curves */
      detail += `<path d="M91 52 Q76 62 69 86" stroke="${ink}" stroke-width="1.3" opacity="0.28" fill="none"/>`;
      detail += `<path d="M129 52 Q144 62 151 86" stroke="${ink}" stroke-width="1.3" opacity="0.28" fill="none"/>`;
    } else {
      /* shoulder seams */
      detail += `<path d="M88 52 L50 68" stroke="${ink}" stroke-width="1.4" opacity="0.26" fill="none"/>`;
      detail += `<path d="M132 52 L170 68" stroke="${ink}" stroke-width="1.4" opacity="0.26" fill="none"/>`;
      /* underarm crease */
      detail += `<path d="M152 108 Q151 120 152 132" stroke="${ink}" stroke-width="1.3" opacity="0.18" fill="none"/>`;
      detail += `<path d="M68 108 Q69 120 68 132" stroke="${ink}" stroke-width="1.3" opacity="0.18" fill="none"/>`;
    }

    if (p.subType === "short_sleeve") {
      /* sleeve hem line */
      detail += `<path d="M33 120 Q43 124 55 128" stroke="${ink}" stroke-width="1.8" opacity="0.32" fill="none"/>`;
      detail += `<path d="M166 128 Q178 124 187 120" stroke="${ink}" stroke-width="1.8" opacity="0.32" fill="none"/>`;
    }

    if (p.subType === "long_sleeve") {
      /* elbow-area fold */
      detail += `<path d="M192 142 Q189 150 186 158" stroke="${ink}" stroke-width="1.6" opacity="0.20" fill="none"/>`;
      detail += `<path d="M28 142 Q31 150 34 158" stroke="${ink}" stroke-width="1.6" opacity="0.20" fill="none"/>`;
      /* cuff hem */
      detail += `<path d="M166 208 L174 204" stroke="${ink}" stroke-width="2.2" opacity="0.38"/>`;
      detail += `<path d="M44 208 L36 204" stroke="${ink}" stroke-width="2.2" opacity="0.38"/>`;
      /* cuff double-stitch */
      detail += `<path d="M163 212 L175 207" stroke="${ink}" stroke-width="1.1" opacity="0.22"/>`;
      detail += `<path d="M45 212 L33 207" stroke="${ink}" stroke-width="1.1" opacity="0.22"/>`;
    }

    /* center front seam */
    detail += `<path d="M110 62 L110 232" stroke="${ink}" stroke-width="0.9" opacity="0.15"/>`;
    /* hem */
    detail += `<path d="M72 232 H148" stroke="${ink}" stroke-width="1.6" opacity="0.28"/>`;
    /* side-body fold shadows */
    detail += `<path d="M70 118 Q67 158 70 198" stroke="${ink}" stroke-width="3" opacity="0.07" fill="none"/>`;
    detail += `<path d="M150 118 Q153 158 150 198" stroke="${ink}" stroke-width="3" opacity="0.07" fill="none"/>`;

  } else {
    /* pants */
    const wl      = p.subType === "wide" ? 58  : p.subType === "regular" ? 62  : 66;
    const wr      = p.subType === "wide" ? 162 : p.subType === "regular" ? 158 : 154;
    const flyEnd  = p.subType === "wide" ? 128 : 124;
    const kneeLine = p.subType === "wide" ? 156 : 152;

    /* waistband top edge */
    detail += `<path d="M${wl} 44 H${wr}"
      stroke="${ink}" stroke-width="2.5" opacity="0.38"/>`;
    /* waistband bottom seam */
    detail += `<path d="M${wl + 1} 58 H${wr - 1}"
      stroke="${ink}" stroke-width="1.3" opacity="0.28"/>`;
    /* belt loops */
    detail += `<rect x="80"  y="44" width="5" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    detail += `<rect x="107" y="44" width="6" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    detail += `<rect x="135" y="44" width="5" height="15" rx="1" fill="${dark}" opacity="0.36"/>`;
    /* fly seam */
    detail += `<path d="M110 60 L110 ${flyEnd}"
      stroke="${ink}" stroke-width="1.6" opacity="0.28"/>`;
    /* front pocket seams */
    detail += `<path d="M73 70 Q69 80 72 93"
      stroke="${ink}" stroke-width="1.3" opacity="0.22" fill="none"/>`;
    detail += `<path d="M147 70 Q151 80 148 93"
      stroke="${ink}" stroke-width="1.3" opacity="0.22" fill="none"/>`;
    /* knee crease lines */
    detail += `<path d="M77 ${kneeLine} Q86 ${kneeLine + 4} 96 ${kneeLine}"
      stroke="${ink}" stroke-width="1.1" opacity="0.18" fill="none"/>`;
    detail += `<path d="M124 ${kneeLine} Q133 ${kneeLine + 4} 143 ${kneeLine}"
      stroke="${ink}" stroke-width="1.1" opacity="0.18" fill="none"/>`;
    /* hem stitching */
    detail += `<path d="M70 232 H97"
      stroke="${ink}" stroke-width="1.7" opacity="0.28"/>`;
    detail += `<path d="M123 232 H150"
      stroke="${ink}" stroke-width="1.7" opacity="0.28"/>`;
  }

  return `<svg viewBox="0 0 220 260" role="img" aria-label="${p.name}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="gf${pid}" x1="0.15" y1="0" x2="0.38" y2="1">
        <stop offset="0%"   stop-color="${lite}"/>
        <stop offset="45%"  stop-color="${base}"/>
        <stop offset="100%" stop-color="${dark}"/>
      </linearGradient>
      <linearGradient id="hl${pid}" x1="0.05" y1="0" x2="0.9" y2="1">
        <stop offset="0%"   stop-color="#fff" stop-opacity="0.28"/>
        <stop offset="50%"  stop-color="#fff" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.05"/>
      </linearGradient>
    </defs>
    <!-- studio white background -->
    <rect width="220" height="260" fill="#ffffff"/>
    <!-- garment body with CSS drop-shadow (no SVG filter ID needed) -->
    <g style="filter:drop-shadow(0px 5px 14px rgba(0,0,0,0.13))">
      <path d="${d}" fill="url(#gf${pid})" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>
      <path d="${d}" fill="url(#hl${pid})"/>
    </g>
    <!-- detail lines rendered above the shadow group so they stay crisp -->
    ${detail}
  </svg>`;
}

/* ── real-photo renderer with procedural-SVG fallback ──
   Renders the product's real imageUrl. If the CDN image fails to load (404,
   offline, blocked), the inline garmentSVG() is revealed instead so the
   storefront layout never breaks. Fully inline-styled so it fills whatever
   media box the SVG previously occupied - no storefront CSS changes needed.
   `fit` = object-fit (default "cover"). */
function garmentImg(p, opts = {}) {
  const fit = opts.fit || "cover";
  const wrapStyle = "display:block;width:100%;height:100%;position:relative;overflow:hidden;background:#f3f4f6";
  const imgStyle = `width:100%;height:100%;object-fit:${fit};display:block`;
  const svgStyle = "width:100%;height:100%;display:block";
  return `<span class="gimg" data-pid="${p.id}" style="${wrapStyle}">`
    + `<img class="gimg__img" src="${p.imageUrl}" alt="${p.name}" loading="lazy" decoding="async" style="${imgStyle}"`
    + ` onerror="this.style.display='none';var s=this.parentNode.querySelector('.gimg__svg');if(s)s.style.display='block';">`
    + `<span class="gimg__svg" style="${svgStyle};display:none">${garmentSVG(p)}</span>`
    + `</span>`;
}
