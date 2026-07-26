# PEAR — UI Consolidation & Structural Cleanup Design

**Date:** 2026-06-13
**Status:** Approved
**Scope:** Cosmetic / structural only — zero changes to functional logic, WebRTC streaming, or security model.

---

## 1. Goal

Consolidate all browser-facing files into a single `/ui/` folder, rename the fitting-room URL from `/pear-demo/` to `/fitting-room/`, move secondary documentation to `/docs/`, and remove decorative noise from the three main code files — making the project root clean, professional, and conventionally structured.

---

## 2. New Directory Tree

```
PEAR/
├── server.js                        ← Express backend (only file here that runs server-side)
├── lib/
│   └── sheets.js                    ← Google Sheets analytics helper
├── package.json
├── package-lock.json
├── .env
├── .env.example
├── .gitignore
├── vercel.json
├── README.md                        ← root README stays at root
│
├── docs/                            ← all secondary documentation
│   ├── LIVE-VTON-TRANSITION.md      ← already here
│   └── FITTING-ROOM.md              ← moved from pear-demo/README.md
│
└── ui/                              ← every browser-facing file lives here
    ├── DESIGN.md                    ← this file
    ├── index.html                   ← MERIDIAN storefront
    ├── style.css                    ← storefront styles
    ├── catalog.js                   ← storefront catalog data + rendering
    ├── store.js                     ← storefront store/bag logic
    ├── product.html                 ← product detail page
    ├── product.js                   ← product page JS
    └── fitting-room/                ← virtual fitting room (was: pear-demo/)
        ├── index.html               ← two-screen fitting room
        ├── app.js                   ← all fitting-room client logic
        ├── config.js                ← single source of truth for timings + endpoints
        └── style.css                ← fitting-room theme
```

---

## 3. File Move Map

All moves are pure renames/relocations. Zero content changes on any moved file.

| From (current) | To (new) |
|---|---|
| `index.html` | `ui/index.html` |
| `style.css` | `ui/style.css` |
| `catalog.js` | `ui/catalog.js` |
| `store.js` | `ui/store.js` |
| `product.html` | `ui/product.html` |
| `product.js` | `ui/product.js` |
| `pear-demo/index.html` | `ui/fitting-room/index.html` |
| `pear-demo/app.js` | `ui/fitting-room/app.js` |
| `pear-demo/config.js` | `ui/fitting-room/config.js` |
| `pear-demo/style.css` | `ui/fitting-room/style.css` |
| `pear-demo/README.md` | `docs/FITTING-ROOM.md` |

### Why no internal path changes are needed

- All `fitting-room/` internal references are same-folder relative (`app.js`, `style.css`, `config.js`) — depth does not change.
- `ui/fitting-room/config.js` → `app.js` import stays `./config.js`.
- `ui/index.html` → `style.css`, `catalog.js`, `store.js` stay relative, still valid.
- API endpoints (`/api/realtime-token`, `/api/health`, etc.) are same-origin absolute paths — unaffected by any file relocation.

---

## 4. Code Changes

### 4.1 `server.js` — 4 surgical edits

**Edit 1 — Static file root** (line ~242):
```js
// Before
app.use(express.static(__dirname, { extensions: ["html"] }));

// After
app.use(express.static(path.join(__dirname, "ui"), { extensions: ["html"] }));
```

**Edit 2 — Wildcard fallback path resolution** (3 occurrences, lines ~252-264):
```js
// Before
const target   = path.join(__dirname, rel);
const dirIndex = path.join(__dirname, req.path, "index.html");
res.sendFile(path.join(__dirname, "index.html"), ...);

// After
const uiRoot   = path.join(__dirname, "ui");
const target   = path.join(uiRoot, rel);
const dirIndex = path.join(uiRoot, req.path, "index.html");
res.sendFile(path.join(uiRoot, "index.html"), ...);
```

**Edit 3 — Startup log** (line ~276):
```js
// Before
console.log(`  Fitting room: http://localhost:${PORT}/pear-demo/   ← OPEN THIS`);

// After
console.log(`  Fitting room: http://localhost:${PORT}/fitting-room/   ← OPEN THIS`);
```

**Edit 4 — Remove decorative ASCII header** (lines 1-19):
Replace the 20-line tier-waterfall comment block with a single clean description line. All functional inline comments inside the functions are kept.

### 4.2 `vercel.json` — 1 change

```json
// Before — 7 individual entries
"includeFiles": [
  "index.html", "product.html", "style.css",
  "catalog.js", "store.js", "product.js",
  "pear-demo/**", "lib/**"
]

// After — 2 globs
"includeFiles": ["ui/**", "lib/**"]
```

### 4.3 `ui/fitting-room/app.js` — cosmetic cleanup only

Items removed:
- Decorative `/* ══════════════ */` section-divider banners (≈30 lines of pure decoration)
- Multi-paragraph JSDoc blocks where the function name and its 3-line body already communicate intent

Items kept intact (untouched):
- Every `console.warn` / `console.error` call (all diagnostic or error-path)
- All WebRTC, MediaRecorder, and token-minting logic
- The `installRealtimeLatencyHook` IIFE
- The `DEMO_FLAG` / `?demo=1` offline path
- Size calculator, outfit slot logic, size override selector
- All event listeners and lifecycle hooks

### 4.4 `ui/fitting-room/config.js` — 1 comment line

```js
// Before
* ⚠️ Endpoints are served by the secure proxy in `../server.js`.

// After
* ⚠️ Endpoints are served by the secure proxy in `../../server.js`.
```

### 4.5 `ui/style.css` and `ui/fitting-room/style.css` — no changes

Both files are already clean and compact. No dead rules, no commented-out code, no unused selectors.

---

## 5. Invariants — Guaranteed Untouched

| Area | What stays |
|---|---|
| WebRTC lifecycle | `connectRealtime`, `teardown`, `stopLive`, `autoStopAndFreeze` |
| Billing cap | `LIVE_DURATION_MS = 5000` and the `setTimeout(autoStopAndFreeze, ...)` |
| Security model | `dct_` key never reaches browser; only short-lived `ek_` tokens via proxy |
| Token waterfall | SDK tier → REST tier 1 → REST tier 2 |
| Size calculator | Zara chart, penalty scoring, optional-field reveal |
| Outfit logic | `activeOutfit`, `slotOf`, `resolveLook`, `addToLook` |
| MediaRecorder | Canvas-mirror record path, `finalizeRecording`, `downloadRecording` |
| All API routes | `/api/realtime-token`, `/api/tryon`, `/api/health`, `/api/track-tryon`, `/api/speed-probe` |
| Storefront logic | `catalog.js`, `store.js`, `product.js` — zero changes |

---

## 6. Implementation Sequence

1. Move storefront files → `ui/`
2. Move `pear-demo/` contents → `ui/fitting-room/`
3. Move `pear-demo/README.md` → `docs/FITTING-ROOM.md`
4. Delete empty `pear-demo/` directory
5. Update `server.js` (4 edits)
6. Update `vercel.json` (1 edit)
7. Clean `ui/fitting-room/app.js` (strip decorative banners + verbose JSDoc)
8. Update comment in `ui/fitting-room/config.js`
9. Verify: `node server.js` → storefront at `/`, fitting room at `/fitting-room/`
10. Verify: all API routes respond correctly
