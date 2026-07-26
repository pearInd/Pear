# PEAR — Virtual Fitting Room 👕👖

> **PEAR** (חדר הלבשה וירטואלי) is a browser-based virtual try-on demo. A user enters their body
> measurements, gets a recommended clothing size, then sees garments rendered live onto their body
> through the webcam using real-time pose tracking.

No backend. No build step. No API keys. Just open `index.html` and it runs entirely in the browser.

The UI is in **Hebrew (RTL)**.

---

## ✨ Features
- **Smart size calculator** — recommends a size (S/M/L/XL) from height + weight, refined by optional
  chest / waist / leg measurements, using a weighted penalty match against a Zara-style size chart.
- **Live virtual try-on** — webcam feed with [MediaPipe Pose](https://google.github.io/mediapipe/)
  body tracking; garments are warped onto the body in real time.
- **Built-in garment catalog** — shirts (sleeveless / short / long sleeve) and pants (slim / regular /
  wide) generated as inline SVG — no external image assets or CORS issues.
- **Upload your own** — drop in an image and it becomes a fabric texture mapped onto the chosen
  garment silhouette.
- **Mesh-based cloth warping** — triangle affine warp follows shoulders, elbows, hips, knees, and
  ankles so clothes bend with the body.
- **Polished premium UI** — animated progress, validity checks, screen transitions, scan-line camera
  overlay, fullscreen preview, and a floating camera button.

---

## 🚀 Getting Started

### Prerequisites
- A modern browser (Chrome / Edge recommended) with **webcam access**.
- An internet connection on first load (MediaPipe + Camera Utils load from CDN).

### Run it

Because the app uses the webcam and CDN scripts, serve it over `http://localhost` rather than opening
the file directly (`file://`).

```bash
cd pear-demo

# Pick any static server, e.g.:
python -m http.server 8000
#   or
npx serve .
```

Then open **http://localhost:8000** and allow camera access when prompted.

---

## 🧭 How It Works

The app is a two-screen single-page flow.

### Screen 1 — Size Calculator
1. Enter **height** and **weight** (required); optionally **chest**, **waist**, and **leg length**.
2. Each size in the chart accrues a *penalty* based on how far your measurements fall outside its
   range (height/weight weighted ×2, optional measurements ×0.5).
3. The lowest-penalty size wins. If even the best match exceeds a threshold, it reports
   "out of range." Implausible inputs are rejected outright.
4. The size unlocks the "continue" button and is carried into the fitting room as a width multiplier.

### Screen 2 — Virtual Fitting Room
1. Pick a shirt and/or pants from the catalog (or upload your own image).
2. Start the camera. MediaPipe Pose detects 33 body landmarks per frame.
3. For each frame, `onResults()`:
   - Mirrors and draws the webcam image to a canvas.
   - Smooths landmarks with exponential smoothing to kill jitter.
   - Computes torso/leg geometry, distance factor, and orientation (front vs. sideways).
   - Warps the garment SVG onto the body via a triangle affine mesh:
     - **Shirt** → 3×3 control-point mesh (8 triangles) + multi-segment tapered sleeves.
     - **Pants** → six independent leg segments (thigh / knee / calf × left / right), each following
       its own bone direction so a bent knee rotates the calf without dragging the thigh.
   - Scales width by recommended size, distance from camera, and selected fit.

---

## 🛠 Tech Stack

| Concern              | Choice                                                            |
|----------------------|------------------------------------------------------------------|
| Language             | Vanilla JavaScript (no framework, no bundler)                    |
| Pose tracking        | [`@mediapipe/pose`](https://www.npmjs.com/package/@mediapipe/pose) (via jsDelivr CDN) |
| Camera loop          | [`@mediapipe/camera_utils`](https://www.npmjs.com/package/@mediapipe/camera_utils)    |
| Rendering            | HTML5 Canvas 2D — affine triangle warping                       |
| Garment art          | Inline SVG (data URIs), procedurally colored                    |
| Styling              | Hand-written CSS (custom properties, RTL, keyframe animations)  |

---

## 📁 Project Structure

```
PEAR/
└── pear-demo/
    ├── index.html   # Two-screen markup: size calculator + fitting room
    ├── style.css    # Premium light theme, animations, RTL layout
    └── app.js       # Size logic, catalog/SVG generation, pose tracking, mesh warp
```

### Key pieces in `app.js`

| Area                  | What it does                                                          |
|-----------------------|----------------------------------------------------------------------|
| `ZARA_SIZE_CHART`     | Size ranges for height/weight/chest/waist/legs.                      |
| `calculateSize()`     | Weighted-penalty size matcher.                                       |
| `shirtSVG / pantsSVG` | Procedural garment art (gradients, weave/denim patterns, fabric filter). |
| `GARMENT_CATALOG`     | The built-in shirts and pants rendered into the grid.               |
| `applyArchetypeTexture` / `applyWhiteRemoval` | Map an uploaded image onto a garment silhouette; strip white backgrounds. |
| `solveAffine` / `drawWarpedTri` / `drawMeshWarped` | Core triangle affine warping engine. |
| `drawSleeveQuad` / `buildLegSegment` | Per-limb segment warping for sleeves and legs.       |
| `onResults()`         | The per-frame pipeline: landmarks → geometry → warped garments.     |

---

## ⚙️ Tuning Knobs

A few constants you can tweak in `app.js`:

- `WHITE_THRESHOLD` (`240`) — how aggressively white pixels become transparent on uploads.
- `SIZE_MULTIPLIERS` — garment width scaling per size.
- `PANTS_FIT_SCALE` (`slim 1.25 / regular 1.45 / wide 1.70`) — leg width per fit.
- Smoothing `alpha` values in `onResults()` — higher = snappier, lower = smoother.
- `pose.setOptions({ modelComplexity: 2, ... })` — drop to `1` for more FPS on weak hardware.

---

## ⚠️ Notes & Limitations

- This is a **demo / proof-of-concept**, not a production garment-fitting product.
- Garment warping is a 2D approximation — it doesn't model true 3D drape, occlusion, or fabric physics.
- Best results: well-lit room, full or upper body in frame, facing the camera.
- Size recommendations are based on a generic chart and shouldn't be treated as exact fitting advice.
- Camera access and the CDN-hosted ML model require a secure/local context and internet on first load.

---

## 📜 License

No license file is currently included — treat as all rights reserved unless the owner specifies otherwise.
