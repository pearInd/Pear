# PEAR — Working Rules for Claude Code

Virtual fitting room. A store page injects `pear-widget.js`, which scrapes the
garment gallery and opens `fitting-room/` in an iframe. The room resolves a
front/back reference pair and conditions a live Decart (Lucy) VTON session.

The correctness of this repo lives in comment blocks that record *specific past
regressions*. Most of them look like dead prose and are not. Read this file
before editing, and read the comment block above any function you touch.

---

## 0. THE ONE THING TO READ FIRST

**The repo is in strict image-only conditioning mode.**

**The engine lives in `lib/prompts.js`, server-side, since 2026-09-26 (§2.13)** —
every function and constant named in this section is there, not in `app.js`, and
`npm run trace:prompt` traces that file. The browser asks `POST /api/prompt` for the
one string a dispatch needs.

Every prompt builder — `buildPrompt()`, `buildCustomPrompt()`,
`buildCompositePrompt()` — returns `imageOnlyPrompt()`. The only text that
reaches Decart is:

```
imageOnlyPrompt()  →  fitPrompt([
                        [P.CORE, PLAIN_TEE_ANCHOR | CATEGORY_ANCHOR.top
                                 | CATEGORY_ANCHOR.bottom
                                 | BACK_CATEGORY_ANCHOR.*],
                        [P.HIGH, FRONT_CLOSURE_LOCK]   // tops, front, only if hasFrontClosure()
                        [P.MED,  fitSentence(garmentType)]   // RESTORED 2026-09-03, see below
                      ])
lookAnchorPrompt() →  full-look path only (both slots filled)
```

`COMPOSITE_DEFAULT = false`.

### These are currently DEAD CODE relative to the wire

`getFabricModifier()` · `getAnatomicalAnchor()` · `QUALITY_SUFFIX` ·
`HEM_DETAIL` · `KEEP_TOP` · `KEEP_BOTTOMS` · `STRICT_INPAINT` · most of the
`DENSE` table.

They are retained deliberately as a restore seam — **not** by oversight.

### RESTORED, not dead: `fitSentence()` / `getFitModifier()`

Bought back 2026-09-03 (report: size picker worked in the UI but never
changed the render — "fabric too tight/loose, doesn't match the selected
size"). One clause, `[P.MED, fitSentence(bottoms ? "lower_body" :
"upper_body")]`, added at the tail of `imageOnlyPrompt()`'s `fitPrompt()`
call, both branches, all angles. `getFitModifier()`'s wording already
attributes tightness to the garment/fabric, never the body outline (§2.4),
so this restore does not reopen that bug. Do not re-run the restore
procedure for this clause — it is already wired. See imageOnlyPrompt()'s
`SIZE-OVERRIDE RESTORE` comment in app.js for the full rationale.

**Known, deliberate limitation:** on a top that also carries
`FRONT_CLOSURE_LOCK` (P.HIGH), the fit sentence (P.MED) is the first thing
`fitPrompt()` sheds under budget pressure — by design, since a shirt
rendered hanging open is a worse failure than a wrong tension. In practice
this means sizing down 1-2 steps on a button-front top can silently drop
the fit-modifier text (163 free chars on that branch vs. up to ~213 chars
for the largest size-down phrasing); true-to-size and sizing up always fit.
This is not a bug — see the comment above the `[P.MED, fitSentence(...)]`
line in `imageOnlyPrompt()` before "fixing" it by raising its priority,
which would risk the closure lock shedding instead and reopening the
"rendered wide open" report.

> **RULE 0 — NEVER edit a dead clause and report the behaviour as changed.**
> If a request is about how the garment renders (fit, drape, print placement,
> body fidelity, back view), first run `npm run trace:prompt` (below) and
> confirm the string you are about to edit actually reaches the wire.
> If it does not, say so and offer the restore path instead of silently editing it.

### The restore path (the ONLY way to change rendering via text)

Restoring a clause is a two-line edit in `imageOnlyPrompt()`:

```js
return fitPrompt([
  [P.CORE, plainTee ? PLAIN_TEE_ANCHOR : bottoms ? anchors.bottom : anchors.top],
  ...(closure ? [[P.HIGH, FRONT_CLOSURE_LOCK]] : []),
  [P.HIGH, DENSE.inpaintLock],        // ← the restored clause
]);
```

Rules for a restore:
- **One clause at a time.** The entire premise of this mode is that clause count
  was drowning the reference image. A batch restore destroys the signal.
- Priority is not decoration. `P.CORE` is undroppable; `fitPrompt()` sheds the
  highest priority number first under budget pressure. A clause that must never
  outrank the category anchor is `P.HIGH` or lower.
- Budget is `PROMPT_MAX_CHARS` (Decart hard-rejects >226 tokens). The category
  anchor alone is 338 chars on tops, 320 on bottoms; with the restored
  `fitSentence()` clause (§0), a real dispatch ships 338-644 chars on tops and
  320-550 on bottoms depending on size delta and closure. Adding a clause can
  silently evict another one — state the new total in the PR description.
- Restore order recorded in `IMAGE_ONLY_PROMPT`'s comment: `inpaintLock` first
  (largest loss), then `modelAgnostic`.

---

## 1. Fit & measurement requests — required protocol

Typical requests: *"make the shirt sit better on the body"*, *"the back print is
wrong"*, *"it slimmed me down"*, *"front and back aren't right"*.

**Before writing code:**

1. Classify the request into one of the four layers below. Say which one.
2. If it is Layer A, apply RULE 0.
3. Run the matching test file *first* so you have a red/green baseline.

| Layer | What it controls | Where it lives | Live? |
|---|---|---|---|
| **A. Prompt text** | what the model is told | `lib/prompts.js` (server): `imageOnlyPrompt`, `*_ANCHOR`, `DENSE` — §2.13 | mostly dead |
| **B. Reference image** | what the model is shown | `referenceImageFor`, `galleryOf`, `distinctBackOf`, `createGarmentComposite` | **live** |
| **C. Orientation** | which asset is on the wire when | the DECISION in `lib/orient-engine.js` (server, §2.14): streaks, `makeTurnYawWindow`, `orientFlipDecision`, early turn, `orientPredictBack`, the hold; the browser's `OrientationWatcher` measures (`classify`, the pose loop) and executes (`maybeSwap`, `effectiveAngle`, `autoOrientation`) | **live** |
| **D. Size ladder** | the recommended size in the UI | `calculateSize` (client shell, `app.js`) → `lib/sizing.js` (`productVerdict`, `*_SIZE_CHART`, `computeSizeVerdict`, `applyStoreChartOverlay`, `storeChartRecommendation` (§2.5b), §2.12) | live in UI, **and live on the wire** (restored 2026-09-03, see §0) |

**Layer B is where most real fit/back-view problems actually live.** "The back
came out plain" is almost never a prompt problem — it is `distinctBackOf()`
returning `undefined`. Run `window.__pearDebugBackView()` in a live session; it
returns one of five `BACK_VIEW_REASON` values and tells you which. On the deployed site
that hook only exists in the support view (`/fitting-room/?pear_debug=<PEAR_DEBUG_TOKEN>`,
§2.11) — the production bundle strips it.

**Layers B and C have a visual gate now.** `npm run qa:visual` (§8) drives a full 360 with
a mocked Decart session and scores the frames, so "the back came out plain" and "the back
carried the front print" are decidable without a live session or a real garment. Run it
after any Layer-B or Layer-C edit — §7.

**Layer D update:** the size selector's choice now DOES reach Decart, via
`fitSentence()`/`getFitModifier()` at `P.MED` (§0) — sizing up or down changes
the drape tension in the render. The one exception: on a top that also carries
`FRONT_CLOSURE_LOCK`, sizing down 1-2 steps can get shed under budget pressure
(163 free chars there vs. up to ~213 needed) — true-to-size and sizing up
always land. Don't assume this is still dead; check `trace:prompt`'s
reachability audit if in doubt.

---

## 2. Hard invariants — breaking these reintroduces a known bug

### 2.1 Never derive a back view from position
`urls[1]`, "the second gallery photo", `images[i+1]` — all banned as back-image
evidence. On a gallery of front-view crops this labels a FRONT photo as the
back, and the model then receives "this is the BACK, do NOT render the front"
and suppresses the only graphic it can see. That is the print-less back bug.

A back is claimed only on **positive evidence**: `data-pear-back` → filename /
alt / label (`looksLikeBackImage`) → server classifier verdict → generated rear.

### 2.2 Never compare image URLs with `===` / `!==`
Always `sameImage(a, b)` / `distinctBackOf(item)` / `canonicalImageUrl(u)`.
`shirt.jpg`, `shirt_800x.jpg` and `shirt_100x100_crop_center.jpg` are one photo
with three spellings. A raw compare lets the front bind as the back reference.

### 2.3 Never force COMPOSITE to fix a back view
A stitched `FRONT|BACK` reference asks a model with no notion of panels to pick
a half every frame; it renders fragments of both (double-logo — commit
`23f5953`). **AI Auto** — two clean single-view assets swapped by the
`OrientationWatcher` — is the architecture that renders a rear view.
`COMPOSITE_DEFAULT = false` is a decision, not a default to flip.

### 2.4 Fit language attributes tightness to the GARMENT, never the body
`getFitModifier()`'s strings once described a *silhouette* ("slim athletic
compression fit"). A silhouette is the outline of the **body**, so it read as
"make this person thinner" and won against the body-fidelity clause ~1,200 chars
later, because leading tokens dominate a realtime diffusion prompt. That is the
"it compressed me into a thinner frame" report.

Any new fit wording must describe what the **fabric** does over a body whose
dimensions are fixed. Never the body's outline.

### 2.5 Never block on ambiguity
`isKidsProduct` / `isAdultProduct` (`lib/sizing.js`) / `isCompatibleSizeCategory` /
`liveBlockReason` all pass when uncertain. A wrong block stops a paying shopper.
That includes a product verdict still in flight or lost to the network:
`productVerdictNow()` answers `null`, which reads as "no mismatch, letter ladder" (§2.12).
`DEFAULT_CATEGORY = "unknown"`, never `"tops"` — a guess indistinguishable from
a verdict outranks the room's own stronger classifier.

### 2.5b A confident STORED store chart decides the adult size; the kernel still gates
*Changed 2026-10-03 by owner decision — before that, a store chart could only break ties.*

`calculateSize()` has two stages. The **kernel** is height + weight, scored by
`coreHwPenalty()`, and it decides which rows are candidates at all,
`currentBodyCategory`/`currentSizeCategory` (and so the kids/adult go-live guard),
and the overflow ceiling behind "no size available". The **fine-tune** is the
`×0.5` chest/waist/legs pass that breaks a tie *between* rows the kernel admitted.

Store charts now act in two places, and **neither reaches the kernel**:

1. **The overlay (unchanged).** `applyStoreChartOverlay()` writes fine-tune columns
   and nothing else — it does not name `min/maxHeight` or `min/maxWeight`, and it may
   only *change* a band the base row already carries. Fed by the widget's PDP chart,
   else the stored chart.
2. **The decision (new).** `storeChartRecommendation()` lets the store's **stored**
   chart (`store_size_charts`, via `pickStoredSizeChart()`) *decide* the adult size
   when it is confident: matched by store, the garment's gender (else unisex, else
   unlabelled only if the store has no gendered chart), adult, garment type, and
   **≥ 2 sizes shared with the product's own list** (the list must be known). The
   shopper's typed chest/waist/outseam are used when present (±1.5 cm); otherwise
   chest/waist/hips are **estimated** from height + weight (+ the shopper's gender) by
   `estimateBodyMeasurements()` — `C = k·sqrt(weight/height)`, documented
   coefficients and ±4–6 cm error ranges in its comment. Each size is scored by the
   share of that range inside the store's band. It **abstains → today's logic** when
   the best size holds < 35 % or beats the runner-up by < 10 points, when nothing
   comparable exists (chest for tops; waist/hips for bottoms), when the garment's
   gender is unknown and the store has men's *and* women's charts, or when the answer
   is a letter on a numeric-pants route. The widget's PDP chart never decides: it
   carries no gender/age/type labels to match.

What must NOT move: the decision runs **after** `currentBodyCategory` /
`currentSizeCategory` are fixed and **after** the "fits neither chart" early return,
only when `currentSizeCategory === "adult"`, and it only ever returns a size the
product sells. So `isKidsProduct`/`isAdultProduct`, genuine-fit-or-no-match, the
blocked Continue and the overflow copy are exactly as before — a store chart picks
*which adult size*, it cannot admit a body the kernel refused or flip adult↔child.

Do not widen either path to the kernel "so the store's chart really counts". The
store's chart is evidence about **cloth**; ours is vetted evidence about **bodies**.
`test/size-chart-overlay.test.mjs` §1 and §6 assert this as absences (no
height/weight name in either function, decision placed after the guard);
`test/store-chart-recommendation.test.mjs` drives the real `calculateSize()` through
every decide/abstain case.

**Where it runs (2026-10-04, §2.27):** with the rest of the fit, server-side - `pickStoredSizeChart()`,
`storeChartRecommendation()` and `estimateBodyMeasurements()` are in `lib/sizing.js`, called from
`computeSizeVerdict()` at the same point main's `calculateSize()` called them; the shopper's gender is
`ev.gender`, the charts `ev.storedCharts` (now with `size_system`). Main's console lines come back to the
support view as `verdict.storeChartLog`. The tests above run the real room shell + the real module.

### 2.6 Extract markers are an interface
Several tests slice a block out of `app.js` by matching its **opening line as a
literal string**, taking the **first occurrence in the file**, and executing it
in a sandbox. Affected blocks: `setActiveItem`'s slot write
(`outfit-slot-isolation`), the presence gate (`body-presence-gate`),
`applyGarment` (`prompt-only-flip`, `side-profile`). `canonicalImageUrl` is one too
(`back-view-readiness`, `back-view-diagnostic` slice from that literal; `url-identity`
and `cdn-url-integrity` slice `server.js`/`scan-store.js` the same way). The OTP/identity
block is one as well: `otp-single-verification` slices `app.js` from
`const OTP_IN_FLIGHT = { send: false, verify: false };` to the `logSessionMeasurements`
JSDoc, and `server.js` from `const otpStore = new Map();`.
The fit's fine-tune tie-break is one too: `size-chart-overlay` slices **`lib/sizing.js`**
(server-side since 2026-09-26, §2.12) from
`const candidates = currentSizeCategory === "child" ? childFits : adultFits;` to
`// SNAP TO THE PRODUCT'S OWN LIST.` and runs that loop standalone, so it scores the real
penalty formula rather than a copy of it - the local names inside `computeSizeVerdict()`
are therefore an interface. The browser's Screen 1 sizing region is sliced by
`numeric-pants-sizing`, `adult-pants-sizing` and `kids-product-sizes` from
`const CHILD_SIZE_SCALE = [` (it was `const ZARA_SIZE_CHART` until the charts moved out) to
`function calculateSize()` or `\nfunction onMeasurementKeydown` (as are `kids-adult-size-guard`
and `size-mismatch-view` from `function resolvedGarmentAgeGroup(`, and `size-fit-pin`, whose §2
drives `sizeProductEvidence()` out of the same slice); `requestSizeVerdict()` sits deliberately
just AFTER that end marker, so each harness injects its own and runs the real `lib/sizing.js`
through it. `size-chart-overlay` also slices `lib/sizing.js` from
`const useNumericPantsChart = product.chart` to `const childFits =` to pin where the overlay
sits. `stored-size-chart` runs that same tie-break loop against `fineTunePickForDiagnostics()`
(main's Phase 0 mirror of it, in `lib/sizing.js` too) on a grid of bodies — change one, the
test tells you to change the other. The widget's `@pear-shared:size-token` BEGIN/END comments
and `scanner/size-chart-reader.src.js`'s `@pear-shared:size-chart-parser` ones are markers
(`sync-size-chart-parser.mjs` slices between them), as are `var SIZE_TOKEN_ALPHA_RE`,
`var LD_OUT_OF_STOCK_RE` and `function canonicalStoreHost(raw) {` in the widget
(`jsonld-sizes`, `store-size-chart-api`).
The shared prompt slice (from the `P` priority table to the full-look composite clause) is
sliced out of **`lib/prompts.js`** now (§2.13) by `image-first`, `plain-tee-fidelity`,
`model-agnostic`, `garment-category-prompt`, `summoning-tokens`, `body-presence-gate` and
`composite` — which read the engine first and `app.js` after it. `applyGarment` is sliced from
`app.js` up to the pointer comment `/* getAnatomicalAnchor() (restore seam`, `applyLook` up to
`/* buildLookPrompt() (returns lookAnchorPrompt()`, and `side-profile`/`angle-race` assemble
`REAR_POSE … angleClause()` from the engine plus `activeBackIsReal … compositeActiveFor` from
`app.js` (up to `/* angleClause() (dead relative to the wire`). Those pointer comments are
markers now — and `lib/prompts.js`'s header must never quote the slice's opening line.
`server.js`'s public-roots + static-hosting block is one too: `static-allowlist` slices it
from `/* ── Public roots` to `/* ── Start (local only` and mounts it on a bare express app
with only `app`/`express`/`path`/`fs`/`crypto`/`__dirname`/`process` in scope (§2.10).
`orient-link` slices `app.js` from `const ORIENT_KNOB_KEYS = [` to `/* ── end flight recorder ── */`
(the whole orientation link and the recorder, run on a fake clock and socket) plus
`function edgeApiUrl(route) {` to its closing brace - keep the recorder inside that span.
`live-timer` slices `app.js` from `const LIVE_TIMER_CHOICES` to `/* ── CODE VERIFIED (2026-09-29)`
(the self-timer, §2.18) and runs it on a fake clock - keep the block self-contained.
`pose-focus` slices `app.js` from `let _lastPoseTimestamp = 0;` to
`/* The loaded PoseLandmarker, as a memoized PROMISE` (the pose call and its focus window, §2.19).
`torso-twist` slices `app.js` from `const TWIST_SHOULDER_MAX` to `let _poseTwist = makeTwistState();`
(the torso-only turn rule, the yaw guard and the head-out-of-frame measurement, §2.20/§2.22/§2.39) and runs it
standalone - keep the block self-contained (`head-frame` takes `const HEAD_ROOM_OUT` to the same end). `back-prime` slices `let _primedBackGen = -1;` to `function armFirstFrameBilling(video, gen) {`
(the back sent before the reveal, §2.22). `return-side` takes the same torso-twist slice (for `torsoOrder()`,
§2.23) and pins the tick's `ord: typeof _poseOrd === …` line by text.
`reveal-settle` §8 slices the mock client from `async function mockRealtimeConnect(` to the
guarded `window.__pearMockDecart = …` line that follows it — that line's exact text (with its
`PEAR_DEBUG_BUILD` guard, §2.11) is its end marker.
The orientation decision (§2.14) is sliced out of **`lib/orient-engine.js`** now: `turn-yaw-window`
and `orientation-yaw-mirror` take `function makeTurnYawWindow(` to `/* Edge-on detection thresholds.`
(and `function orientPredictBackReason(` to the same end); `turn-hold` and `turn-yaw-window` append
the engine's `/* ── ONE WATCHER'S DECISION STATE` to `function armLine()` to the browser's
`function createOrientationWatcher()` … `\n/* Decode a garment URL into an ImageBitmap`;
`side-profile` and `prompt-reanchor` take `function step(s) {` to `function armLine()`, and
`side-profile` `function profileNext(score, autoProfile)` to `/** One tick`. On the browser side,
`prompt-reanchor` slices `async function maybeReanchorPrompt()` to
`\n\n  /* What only the browser measured`, `orient-engine` §4 the tick from
`  const timer = setInterval(async () => {` to `}, ORIENT_SAMPLE_MS);`, and `test/orient-replay.mjs`
(the harness `orient-engine` §1 replays) runs `const ORIENT_SAMPLE_MS` through the end of
`function createOrientationWatcher() {`. `pose-follow` slices `app.js` from `/* ── THE TICK WAITS FOR THE READING (2026-10-09)` to
`/* ── end THE TICK WAITS FOR THE READING ── */` (§2.40, run on a fake clock - keep the block self-contained). `picture-pace` slices `app.js` from
`/* ── THE PACE OF THE PICTURE (2026-10-09)` to `/* ── end THE PACE OF THE PICTURE ── */` (§2.41). `garment-box` slices `app.js` from `const REF_BAND_TIMEOUT_MS` to
`/** The rows to paint on an image` (the rear band request, run on a fake fetch). `garment-cache-age-group` slices
`server.js` from `async function garmentCacheQuery(imageUrl, columns) {` to
`/* Per-product view lookup` and `scanner/scan-store.js` from
`async function saveClassification(` to `/* ── Gemini classification` — keep the
garment_cache read/write helpers inside those spans.

- Do not introduce an identically-shaped statement **or a comment quoting the
  marker** above a marked block. Both steal the match.
- If you must move a marked block, update the matching `.test.mjs` in the same commit.
- A marked block must be **self-contained**. Adding a module-scope helper *above* the
  marker and calling it from inside is the same failure as moving the block: the
  sandbox never sees the helper and the extracted copy dies on a `ReferenceError`
  while the real file is fine. That is why `stripCdnTransformPath` is defined *inside*
  each canonicaliser rather than next to it.

### 2.7 Sandbox-safe globals
`applyGarment` and friends run standalone with no `window`. Every browser global
reference inside an extracted block must be `typeof`-guarded:

```js
const x = typeof window !== "undefined" && !!window.__pearDebugForceFullReupload;
if (typeof verifyGarmentAsset === "function") verifyGarmentAsset(payload, "applyGarment");
```

Also: never build a prompt with `const X = fitPrompt(...)` at module scope — a
load-time call makes `PROMPT_MAX_CHARS` a load-order dependency and turns
`angle-race` into a `ReferenceError` before the first assertion. Use a function.

### 2.8 TOCTOU: angle and reference must come from the same reading
`applyGarment()` freezes `angleAtStart` / `profileAtStart` before its awaits and
threads them into `imageOnlyPrompt(item, angle)` and `referenceImageFor()`.
Never re-read `effectiveAngle()` downstream — the watcher can flip mid-await and
the prompt and image will describe different orientations.

### 2.9 Never put a still frame over a live session
The shopper watches `#aiVideo` as a mirror. Three freezes shipped as "fixes" and were reported
as the bug ("the whole view freezes for 1-2s on every swap", v136 clips): the swap's input hold
(Decart gets no frames → its output repeats one frame), and the snapshot covers pinned over the
feed on turns and re-drapes. All are **off by default**, restorable only by URL
(`?swap_hold=1`, `?still_covers=1`). A Decart output stall is bridged by LIVE CONTINUITY - the
live camera cross-faded in over the silent output and back out - and the recorder blends the
same layer so the clip matches the screen. The recorder's timestamps were never the problem;
a frozen clip means frozen *content*. Never pause, gate or hold `#webcam`/`localStream`.

**The camera bridge is OFF by default since 2026-10-04 (the owner's call, §2.28):** "make Decart live the whole
measurement". A stall now holds the render's last frame (the `<video>`'s own behaviour - nothing is laid over it, so the
rule above stands); the layer still measures every stall (`out-stall`, `out-stats.stallMs`). `?live_camera=1` restores
the bridge for an A/B.

**This one is now checked automatically.** `npm run qa:visual` (§8) captures a burst of
consecutive frames through a turn and fails on `frozen-feed` (two identical frames) or
`white-flash` (a near-uniform bright frame — i.e. an overlay pinned over the feed). If you
are restoring `?swap_hold=1` / `?still_covers=1` for an A/B, expect those findings: they
are the gate correctly reporting what those flags do.

### 2.10 The server serves an allowlist, never the repo
`server.js` used to run `express.static(__dirname)`, which handed the repository to anyone
who asked: `/server.js`, `/CLAUDE.md`, `/package.json`, `/scanner/…`, `/test/…` and even
`/node_modules/…` answered 200. Public files now come only from `PUBLIC_DIRS`
(`fitting-room`, `widget`) and `PUBLIC_FILES` (`pear-logo.png`,
`Commercial_video_for_a_tech_fa.mp4`); everything else is a 404 by construction. If an
asset 404s, add its directory or file to those lists — never widen back to the root.
`test/static-allowlist.test.mjs` asserts the absence, the presence, and that `../` cannot
climb out of a public directory.

**There is no admin in this project.** The admin dashboard (`admin/`), `requireAdminAuth`,
`ADMIN_EMAILS`/`ADMIN_PASSWORDS`, every `/api/admin*` route, `/api/test-sheets` and the
GET/DELETE on `/api/sessions` were removed on 2026-09-26. The session log is ingest-only
(POST); the rows live in Supabase and are read there. `static-allowlist` §4.5/§4.6 assert
the absence, so re-adding an admin surface here is a deliberate act, not a drive-by.

### 2.11 Shoppers download the BUILD, not the source
Production serves `dist/` (`scripts/build.mjs`, run on Vercel by the `vercel-build` script):
minified, every comment and log line stripped, the mock harness and debug hooks folded
away, and the vendor SDK bundled same-origin as `rt.<hash>.js` instead of imported from a
CDN URL that names it. The source stays the source — tests, `trace:prompt` and `qa:visual`
run on the unbuilt files. Rules that keep the build honest:

- **Any new debug hook or mock seam is guarded** with the inline expression
  `(typeof PEAR_DEBUG_BUILD === "undefined" || PEAR_DEBUG_BUILD) && …` (never a module-scope
  const — §2.6/§2.7). The build defines it `false`, the branch folds away, and the mock
  block tree-shakes out. An unguarded `window.__pearDebugX = …` fails the build.
- **Shipped strings are vendor-neutral.** `console.error` messages, thrown errors and
  anything a shopper can see survive minification; write "render engine", not the vendor's
  name. Developer-only hints go behind the same guard. The build's `FORBIDDEN` list fails on
  comment blocks, vendor CDN URLs, `createDecartClient`, `DECART_API_KEY`, the mock and
  debug-hook registrations.
- **The `[PEAR]` console contract (§6) lives in the support view.** With
  `PEAR_DEBUG_TOKEN` set (≥16 chars), `/fitting-room/?pear_debug=<token>` serves the source
  room — every log line and `window.__pearDebug*` hook — through `/__src/<token>/<dir>/`.
  Each support mount is rooted at its own public directory: a repo-rooted one served
  `server.js` through `fitting-room/../` (static-allowlist §5.18).
- **A missing `dist/` degrades to source, loudly** (`[PEAR] ✖ dist/ is missing`) rather
  than taking the room down. If that line shows up in Vercel logs, the build did not run.
- After a change to anything the build touches, `npm run qa:visual:dist` drives the same
  360 against the minified room (build `--qa` keeps the mock so the agent can run it).
- **Every shipped file is cloaked and the engine is reached through our edge (§2.24)** - the render
  SDK and the pose library included; the build fails on any vendor, engine or model word in any file.
- **The bundled SDK must carry the dependency versions the CDN would.** rt.js is built from
  node_modules; the source room's CDN import resolves the SDK's own ranges to their newest
  release. The first bundle shipped livekit-client 2.19.1 where production (3a9b55d, CDN) ran
  2.22.3 - the one runtime difference found when the room was reported to work better on
  3a9b55d (2026-09-27). `package.json` pins them (`overrides["@decartai/sdk"]`) and the build
  refuses a node_modules that disagrees. Neither `qa:visual` nor the unit suite can see this:
  the mock replaces the SDK. The build also silences the SDK's and livekit's console loggers
  (they print the vendor's hosts) - see `SDK_ENTRY` and `connectRealtime()`.

### 2.12 The size fit is server-side
Since 2026-09-26 every size chart (FOX's bands and their derivations), `coreHwPenalty()`, the
store-chart decode/overlay and the fit itself live in `lib/sizing.js`, served by
`POST /api/size` - and so do the **product** rules that pick a chart (`isKidsProduct()`,
`isAdultProduct()`, `isPantsProduct()` and its tiers, `isAlphaSizeRun()`'s veto,
`pantsChartKindForSizes()`, the Hebrew/English pants vocabulary), moved the same day into
`productVerdict()`, and so does the storefront's own size-chart READER (which header is
chest or waist, word sizes, range/inch cells, clamps, monotonicity, which table wins —
`readStoreSizeChart()`): the widget only collects the page's tables and sends them raw
(`encodeRawSizeChart()`, 1,506 pages proven identical to the old in-widget reader, both
transports). An old widget's v1 string still decodes. `calculateSize()` in `app.js` is a shell: it sends the measurements and
the product's RAW evidence (`sizeProductEvidence()`: size list, title, age group, cached
category and size-run type, the item's type fields, and its own `isBottomsGarment()` verdict
as `item.bottoms` - true/false, or null for "no verdict"), and `applySizeVerdict()` paints the
answer in the old order. Garment-title classification (`classifyGarmentTitle`,
`categoryFromSizeRun`) and image selection stay in the browser.

- **The browser reads back only what it acts on:** `verdict.product` = `{chart, kidsOnly,
  adultOnly, adultNumericPants}` on EVERY status, including `"empty"` - a product-only request
  (`loadProductVerdict()`) is how the in-room ladder (`activeSizeLadder()`) and the kids/adult
  card (`hasSizeCategoryMismatch()`) learn about a garment swapped in after the last size. They
  read it synchronously through `productVerdictNow()`, which is `null` until it lands (§2.5);
  the late answer repaints the card by itself. `lowerBody` stays server-side.
- **The product move was proven the same way:** the old in-browser rules vs the new
  evidence → JSON → sanitiser → `productVerdict()` path over 1,092,000 product situations, zero
  differences, with four mutations each caught (kids ladder, the `bottoms` tri-state, EU-before-
  waist, the geresh fold); the 1,458,028-case fit grid re-ran identical. `size-fit-pin` §2 pins
  92,695 of those situations against a hash computed from the pre-move code.

- **Behaviour was proven identical**, not assumed: the old in-browser `calculateSize()` and
  the new shell + server were run over the same 1,458,028 cases (26 garment situations × the
  height/weight grid × the optional-measurement grid) and matched byte for byte; a 1cm edit to
  one band showed up in 18,182 of them. Re-run that comparison for any change to the fit.
- **Synchronous when it can be.** Missing/out-of-range input is answered locally; every verdict
  is memoised by its evidence, so re-runs on known inputs paint in the same tick. Only new
  evidence waits on the network - Continue is locked until it lands, and the newest call wins.
- **It never rejects, and a failure keeps the last answer.** A failed request paints
  `resultLabelServiceError`/`sizeResultServiceError` but leaves the size STATE alone, so
  `goLive()`'s re-check can never turn a network blip into a false block (§2.5).
- **`goLive()` awaits the re-check BEFORE claiming `busy`** (adult-pants-sizing §7: a recompute
  never holds billing state) and guards that one await with `goLiveResolvingSize`;
  `stream-continuity` asserts it is the only await ahead of the claim.
- **No chart may come back to the browser.** `scripts/build.mjs` fails if the room bundle
  carries a body-measurement band key (`minChest`, `maxHeight`, …). The visual harness runs the
  real `lib/sizing.js` for `/api/size` - it is shipped logic, not a stub target (§8.6).


### 2.13 The prompt engine is server-side
Since 2026-09-26 every prompt word — the category/back/plain-tee anchors, the closure lock, the
identity/colour/print sentence, the fit ladder, `fitPrompt()`'s priorities and budget, and the
whole restore seam (`DENSE`, the composite contract, side-profile/lateral-seam clauses) — lives
in `lib/prompts.js`, moved verbatim, behind `POST /api/prompt`. RULE 0 applies there now.

- **What the browser sends:** `promptFactsOf(item)` — plain fields only (`name`, `title`,
  `type`, `category`, `subType`, `garmentType`, `colorHex`, `textOcr`, `fabric`,
  `backIsPlain`, `_backLooksPrinted`, `custom`) plus its own `isBottomsGarment()` verdict as
  `__bottoms` — and the angle, the frozen pose (`inProfile`) and `getSizeDelta()`. A field a
  builder starts reading must be added to BOTH lists (`prompt-engine` §3 asserts they match).
- **`isBottomsGarment()` has two copies** — the browser's (sizing, go-live and the presence gate
  read it synchronously) and the server's, which honours the browser's verdict first and only
  runs its own body for callers that send none. `prompt-engine` §2 asserts identical bodies.
- **Behaviour was proven identical:** 351,779 prompts from the old in-browser engine vs the new
  browser→server path matched byte for byte (a dropped field changed 87,885 of them), and
  `trace:prompt --json` is identical. `prompt-engine` §1 pins ~162k of them to a hash computed
  from the pre-move engine.
- **Dispatch discipline is unchanged:** `applyGarment()` requests its prompt right after freezing
  `angleAtStart`/`profileAtStart` and before the first await (§2.8), in parallel with the
  reference resolve; the session start prefetches the other angle/pose variants so a turn never
  waits on the network. Prompts are memoised per request for the session.
- **The browser carries no wording:** `scripts/build.mjs` fails on engine phrases in the room
  bundle; `prompt-engine` §5 asserts the absence over `app.js`. The pre-commit hook traces
  `lib/prompts.js` (falling back to HEAD's `app.js` only for the commit that moved it).

### 2.14 The orientation decision is server-side
Since 2026-09-26 the half of Layer C that DECIDES — the vote streaks, `makeTurnYawWindow`,
`orientFlipDecision`, the early-turn handshake, `orientPredictBack`, when the turn hold rises and
falls, `orientTurnMark`, the profile ladder (`profileNext`), which swap goes out and when, and every
`ORIENT_*` threshold and `?early_turn=`/`?pose_pass=`… knob — lives in `lib/orient-engine.js`, moved
verbatim. In production it runs in a Cloudflare Worker (`cloudflare/orient/`) over one WebSocket per
page (`lib/orient-protocol.js`); locally `server.js` and the visual harness serve the same protocol
at `/orient` (`lib/orient-server.js`). The browser MEASURES (`classify()`, the pose loop, MediaPipe,
skin/face) and EXECUTES (`maybeSwap`, the hold, `turnMark`, the profile/re-anchor dispatch).

- **The contract:** `createOrientEngine(knobs, {debug}) → step(sample) → actions`. The sample is
  plain measurements (`t, vote, faceSeen, poseVoted, profileScore, yawAbs, yawAt, lostAt, lock,
  profile, dualView`, and since 2026-10-01 `ord, ordAt` - §2.23); the actions run IN ORDER in the tick exactly where the old code ran them,
  `swap` last and awaited. **Time comes from the browser's sample**, never the server's clock, so a
  decision is independent of network latency — that is what made it provable.
- **Behaviour was proven identical:** 4,116 scripted sessions (turn trajectories × speeds × dropouts
  × noise × every knob combination) replayed through the old in-browser watcher and the new
  browser→engine path produced the same action sequence byte for byte (239,223 events); four
  mutated thresholds were each caught (a 1° early-turn change moved 185 sessions). `orient-engine` §1 pins 504 of them to a hash computed from
  the pre-move code.
- **Latency, measured (6,174 sessions, the harness's random busy-wire off so only the link moves):**
  at 10 and 50 ms every decision lands on the same sample, shifted by the latency alone — 6
  sessions differ, each a reply still in flight when the session ended. At 200 ms the round trip
  plus the measurement overruns the 250 ms tick, `sampling` skips every other sample, and later
  swaps change in 122 sessions (34 more, 88 fewer; the first back view never moves). Tel Aviv
  measured ~7 ms. With the busy-wire noise ON, even 50 ms reshuffles ~100 sessions each way (back lost 47 / gained 52) —
  that is the harness keying its randomness on execution time, not the link; compare outcomes,
  not byte logs, when you re-measure.
- **The fallback is the front view, never a local copy.** If the link is down, dead (§2.16) or
  unset, a tick decides nothing: no swap, the lock stays PENDING, the front renders —
  the same safe path as a product with no back photo. Only `maybeReanchorPrompt()` keeps its
  cadence. One `[PEAR] AI Auto - the orientation link is unavailable …` warning says so. Do not
  "fix" an outage by putting a copy of the decision back in the browser: that is the thing this
  section exists to keep out.
- **Where the room connects:** `PEAR_ORIENT_URL` (a `wss://` URL, injected by `scripts/build.mjs`,
  set in Vercel) or, when empty, the page's own origin at `/orient` — which Vercel cannot serve, so
  a production build without it warns. The link opens at `enterRoom()` (`orientLinkKeepAlive()`),
  not at go-live, and is proven alive before every go-live (§2.16).
- **Knobs travel as data.** The browser forwards only `ORIENT_KNOB_KEYS` from its URL at channel
  open; the engine sanitises them (`sanitizeOrientKnobs`) and every sample (`sanitizeOrientSample`).
  The protocol is bounded (16 channels, 16 KB per message) because the body is shopper-controlled.
- **Debug is gated.** The engine's per-tick trace prints every threshold, so a channel gets it only
  when `allowDebug(dk)` passes — in the Worker, `dk` must equal `PEAR_DEBUG_TOKEN` (the support
  view's `?pear_debug=` token, §2.11); the local server always allows it.
- **The Worker fails closed** (`cloudflare/orient/`, deploy steps in its README): `/orient` only,
  an Origin allowlist (`ALLOWED_ORIGINS`; empty refuses everyone, `*` is one `[a-z0-9-]` run), a
  per-connection message rate cap, no `workers.dev` hostname and no logs. The Origin gate is a
  fence, not a lock — a scripted client can forge it and use the engine as an oracle; what it
  never gets is the thresholds. It was checked against `wrangler dev` byte for byte (33,122 steps)
  and drove the minified room through the visual gate. **A change to `lib/orient-engine.js` needs
  a `wrangler deploy` too**, or production keeps deciding with the old engine. Since 2026-09-27 it
  also answers POST `/size` and `/prompt` (§2.15) - so a change to `lib/sizing.js` or
  `lib/prompts.js` needs the same redeploy, or the edge and the origin answer differently.
- **The browser carries no decision:** `scripts/build.mjs` fails on the engine's reason codes in
  the room bundle (it fired on the pre-move room); `orient-engine` §4 asserts the thresholds and
  decision functions are absent from `app.js`. The action names and knob keys ARE in the room —
  they are the protocol.
- **A decision is never lost between the engine and the wire (§2.16).**

### 2.15 The room must not wait where main did not
Reported 2026-09-27: "the whole interface is laggy… main is excellent - it should be the same
version, only with the code hidden." Measured against origin/main on the same machine
(scratch perf harness: the real room, the render engine mocked, real CDNs), and fixed at the cause:

- **A second pose model on the GPU** (the reference crop, 479cdfd - reverted): go-live 12.8s vs
  4.0s, GPU work 34.6s vs 12.6s. It fixed a real bug (a model-worn store photo's jeans/back bled into
  the render) but main has that bug too; if it comes back, the garment box must come from the server
  (e.g. the classifier that already sees every photo), never from a second MediaPipe in the browser.
  **It came back on 2026-10-08 that way, as a MASK on the rear photo only (§2.38).**
- **Server round trips on the critical path**: every /api/size and /api/prompt went to Vercel iad1
  (~350ms from Israel, 620ms cold) where the in-browser original took 0ms - Continue locked for two
  (+~720ms), go-live waited on two (+~750ms). The Worker behind the orientation link answers POST
  `/size` and `/prompt` from the SAME modules (`handleApi`, `orient-engine` §6) at ~10-20ms;
  `postPearApi()` asks it first and falls back to `/api/<route>` on anything but a 200, backing off
  for `EDGE_API_RETRY_MS`. `prewarmOrientationAssets()` prefetches the four wire prompts, so go-live
  reads the memo. Measured after: room entry 1.11s, live 4.18s - main's 1.05s / 4.0s.
- ~~The recorder drew only on a presented frame~~ - **reverted 2026-09-28** (§2.17): `startRecording()`
  is main's again, byte for byte.
- The Worker change needs a `wrangler deploy`; until then the room falls back to the origin and is
  exactly as slow as before, never broken. `room-latency` pins both.

### 2.16 A decision the engine made reaches the room - and a TEST session records why
Reported 2026-09-27, a first measurement read frame by frame: no back print through the whole back
view, then the rear reference landing as the shopper faced front again; a second one showed the
print arriving late. The engine's early turn fires ONCE per turn (~40°) and resets the vote
streaks, so any path that loses that one "send BACK" leaves the FRONT on a turned-away body until a
back-of-head vote at ~150°+. On main the decision was a function call and could not go missing;
over a socket it could. The link is what closes that:

- **The link watchdog proves the link, it does not race the reply.** A step that missed its timer
  (800 ms, on a busy main thread) was DROPPED while the engine had already acted on it. Now a slow
  reply (`ORIENT_LINK_STEP_TIMEOUT_MS`, 1200) triggers a ping; only a link that cannot answer is
  dropped (`orientLinkDrop()`: pending steps resolve null, every channel re-opens on the next socket
  with a fresh engine that starts from the room's real lock, no retry back-off);
  `ORIENT_LINK_STEP_HARD_MS` (4000) caps it. The room also pings every `ORIENT_LINK_PING_MS` while it
  is open (`orientLinkKeepAlive()`) and checks the link at go-live (`orientLinkEnsureFresh()`), so a
  socket that died quietly is replaced before a turn needs it. The ping is `{k:"ping",q}` →
  `{k:"pong",q}` in `lib/orient-protocol.js` - **the Worker must be deployed with it BEFORE a room
  that pings ships**, or the room reads a healthy link as dead. `orient-link` §1-§3.
- ~~`maybeSwap()` waits out a busy `applying`~~ - **reverted 2026-09-28** (§2.17). It changed WHEN
  swaps land (2,737 of 4,116 replayed sessions) and was reported as worse than main on a real body.
  `maybeSwap()` drops on `applying` exactly as main does; `orient-engine` §1 is back on main's pin.
- **The FLIGHT RECORDER** (`fitting-room/app.js`, after the orientation link). A TEST session -
  store key `TEST` (the preview script's `data-pear-key="TEST"`) or `?pear_trace=1` - keeps every
  orientation tick (the sample, the engine's reply, its round trip), every swap from `swap-req` to
  `swap-render` or the reason it was dropped, pose/re-anchor applies with their duration, output
  stalls (`out-stall`/`out-resume`/`out-stats`) and link events, and posts it once when the session
  ends to the Worker's `POST /trace` (KV binding `TRACES`, 7 days). Read it back with
  `cd cloudflare/orient && npx wrangler kv key list --binding TRACES --remote` and
  `... kv key get <key> --binding TRACES --remote`. A shopper's session records nothing and sends
  nothing; the record holds numbers, decisions and timings only. In the source room
  `window.__pearDebugTrace()` returns it, and `PEAR_VISUAL_TRACE=1 npm run test:visual` saves the
  harness's as `test-results/visual/flight.json`. `orient-link` §4, `orient-engine` §6.

### 2.17 The branch behaves as main, one to one - only the code is hidden (2026-09-28)
Reported after the rule changes of 2026-09-27: "I measured again - the same result, it works
very badly… copy exactly how main works, one to one, and only keep the code hiding." Every
BEHAVIOURAL change made after the verbatim moves was reverted:

| Reverted | What it had changed |
|---|---|
| `5835270`, `99387d2`, `43ef549` | engine rules: side-view send scheduling, return default 50 → 0, FRONT-only return |
| `8d27676`, `5835270` (prompts) | the back anchors' lower-body lock; the plain-tee anchor wording |
| `126650a` | the render-lag probe (per-frame grids over the input and output) |
| `eafe242` (part) | `maybeSwap()`'s wait on a busy `applying` |
| `744de6d` (part) | the recorder's frame gating |
| `05d1e99` | LIVE CONTINUITY drawn from the throttle's clone instead of `#webcam` |

What stays is hiding and its plumbing: the server-side engines (§2.12-§2.14), the minified build
(§2.11), the edge API and prompt prefetch (§2.15), the link watchdog (§2.16) and the TEST-session
recorder (passive: it records, it decides nothing).

**Proven, not assumed:** `lib/orient-engine.js` is the 854d629 verbatim move again and
`orient-engine` §1 replays 504 sessions to main's pre-move hash (`4b2ead79…`); `lib/prompts.js` is the
897ab44 move and `prompt-engine` pins main's hash (`221a5b58…`); `trace:prompt --json` is byte
identical to a run on `3a9b55d`; `startRecording()` and the continuity layer are main's text.

**Before changing behaviour here again**: the fix goes to main's code FIRST, measured on a real body
against main, and only then through the move. A rule tuned on this branch alone is what this
section undoes.

**Changes tried on top of main on 2026-09-28 - ALL REVERTED 2026-09-29** ("take main and copy it
one to one, keep only the hiding"). Recorded so they are not re-tried blind:
- **`LIVE_INFERENCE_FPS` 10 -> 20.** The output did double (TEST records: 12-19 fps out against ~10),
  but the uplink could not carry it. A record with the media connection's stats read the camera at
  1.1-1.4 Mbps against a 1.2-1.45 Mbps send estimate, the browser's send queue growing from 2.5s to
  57s of cumulative packet delay across the turn, and the output falling to 8-12 fps. The reference
  images ride the same uplink on the engine's signalling socket: at 20 fps two of five back
  references were acknowledged 1.35s and 2.9s late (130-500ms in twelve sessions at 10), so the back
  landed as the shopper was already facing front again - "the back on the front", "lots of delay".
  Raising it again needs a way to keep the uplink clear for a reference upload - measured first.
- **The back tops anchors' "shirt" -> "top" and "back contour/volume" -> "body contour/volume".**
  Each answered one real frame-by-frame failure (an open button-up at the side view; a chest left
  bare), but the sessions they were judged in ran at 20 fps as well, so neither was ever measured on
  main's transport. `lib/prompts.js` is main's move again and `prompt-engine` main's pin.
- **A TEST record sampling the media connection every 500ms** (`rtc`). It found the above; it is
  recurring work main does not do, so it went too. The record's other events are passive and stay.
Not changed on this branch, and why: the reveal wait (~5s from connect - recorded fixes in
`config.js`); uploading references in advance (`client.files`, swap by id) - it would land every
swap earlier on the body.

---

### 2.18 The camera guide and the self-timer - ZERO IS THE FITTING
Added 2026-09-29 ("if the camera doesn't see the whole body the result isn't the best"), reworked the
same day after two 10s sessions ("it started before the timer ended", "a second or two of loading
after zero"). `#camGuide` sits between `#startCamBtn` and the camera once per room load (three steps,
the full-body one first; no "turn slowly"). The self-timer (`#timerBtn`, beside the LIVE badge,
preview only; off / 3 / 5 / 10s on a glass slider you tap or drag - `setupGenderSwitch`'s physics)
opens the measurement EXACTLY at zero, never before it and with no loading screen after it:
- **One hold per session.** `onRemoteStream()` can fire more than once and each call arms its own
  `armFirstFrameBilling()`; main never minded (the second fire finds `billingStarted`), but a held
  reveal leaves it false. That is how the first cut revealed at 7.6s of 10. `revealAfterCountdown()`
  ignores a second fire for a gen already held (`plan.heldGen`) and the plan lives until the reveal.
- **Main's presence gate still runs under a timer** - the engine must first see the whole body. It
  was skipped for one day so the session could connect at the press, and a session opened while the
  shopper was still walking back had no legs in frame: the render invented long trousers and shoes
  and kept them until the next reference write. `liveTimerConnected()` (right after `waitConnected`)
  times zero to the render expected `LIVE_TIMER_READY_AFTER_CONNECT_MS` later (5.1-5.4s measured,
  5.7 used); a connect that comes late spreads the countdown's last numbers instead.
- **10s ("during")**: numbers from the press; a render verified before zero waits for it; a slow
  connect spreads the remaining numbers to the expected render (never back up, never skipped).
  **3s / 5s ("prep")**: "get ready" until the connect, then a full N..1 placed so zero lands on the
  expected render. A render not yet verified at zero (never measured) keeps the stage in a short
  "starting" state - never the loading overlay.
Nothing else moves: preload, connect, every reveal gate, what is sent and the orientation run as with
the timer off; the billed 5s window, recorder and kill-clock start at the reveal. The engine generates
during a hold (~0.3-2.5s). `live-timer` pins it on a fake clock - including the reported double fire
(the old consume-on-first-fire code fails it in three places). The visual agent clicks through the
guide as a shopper would. **The pose model's first inference is paid in preview**
(`warmPoseInference()`, after the camera opens, and at a timer's go-live as a backstop; never once
the fitting shows): while the timer skipped the presence gate, the first inference landed on the
fitting's first second - a ~1.9s main-thread block, the render starved, LIVE CONTINUITY on the raw
camera for the rest of the window (reported 2026-09-29). With the gate back it would stall the
countdown's numbers instead, so it stays in preview - **and since 2026-09-30 only when a timer is set**
(camera open with a timer, or a timer set while the preview is open): with the timer off the go-live is
main's to the millisecond (§2.21). `live-timer` §9. **The "verified" moment** (`#otpSuccess`, `celebrateOtpVerified()`): a
pear-green check across the screen when the emailed code is accepted - fire-and-forget,
pointer-transparent, typeof-guarded inside the OTP block (`otp-single-verification` runs it
standalone), never awaited, so the flow is not held for it.

### 2.19 The pose model sees a far-back shopper in any light (2026-09-29)
Reported with a clip in a living room with a bright window behind the shopper: "it has to work
whatever the lighting - it keeps changing the shape of the shirt". The flight record: the pose model
found NO body in 24s (no yaw, no shoulder order), so the presence gate held the fitting 9s past the
timer's zero, and the 96px skin heuristic - which cannot read a small backlit head - claimed a
PROFILE for 4s (the side-view prompt on a shopper facing the lens) and then a BACK while they faced
front. Replayed through the model on the clip (tasks-vision 0.10.14, VIDEO, 512×288): it was never
the light - a full-length figure in a wide 16:9 frame is ~55px tall once the detector shrinks it to
224px; a square window around the shopper finds them (41 of 47 frames vs 15, none of the first 32).
- **`detectPoseFrame()`'s POSE FOCUS WINDOW:** after `POSE_FOCUS_AFTER_MISSES` (2) empty whole-frame
  inferences, a square the frame's height (centre, then either side), following the hips; landmarks
  mapped back to whole-frame coordinates (y untouched, x and image z scaled, worldLandmarks untouched);
  `POSE_FOCUS_LOSE_MISSES` (3) empty windows hand back. Still one inference per call. While the whole
  frame finds the body nothing changes (replayed on four good-light sessions: the window never opens).
- **`POSE_MODEL_URL` is main's LITE model (2026-09-30).** The full model was tried for the backlit
  session (with the window, lite read that shopper's shoulders mirrored for the first second; full
  read FRONT, the turn, BACK) on a claim that good light was identical. Measured through the whole
  room against main (§2.21's A/B, 24 sessions on the user's own 360s) it was not: on one clip the back
  went out ~300ms earlier every run, on another the front came back ~250ms later, and on a third it
  flashed the back for ~0.5s before the shopper had turned; main never did. The full turn is main's,
  so the model is too; the window is the lighting fix.
- `pose-focus` pins it (a window whose x is not mapped back fails 4 checks). The engine, the prompts,
  the reference and the render input are untouched. The skin heuristic is still what votes when the
  pose abstains (edge-on) - main's.

---

### 2.20 The torso-only turn - "the back, with my legs where they are" (2026-09-30)
Asked for with the rebuild: "it recognises the turn well when I turn my whole body - I want it to
recognise it when only my back turns and my legs stay in place". Main reads a turn from the shoulder
ORDER (it votes only past ±0.25 of torso height) and the shoulder-line |yaw| from the pose model's WORLD
landmarks (the early turn at 40). On a torso turned over planted legs both go quiet: the shoulders
overlap in the image, so the order abstains, and the world depth - compressed by BlazePose and kept
coherent with legs that face the lens - stays under 40, so nothing fires and the lock stays FRONT.
- **What tells them apart, measured:** thirteen recorded full 360s, every frame through the room's lite
  model - a whole-body turn narrows the shoulders and the hips TOGETHER in the image (wherever the
  shoulders were down to 20% of their square-on width, the hips were at 31% or less), while a torso
  turned over planted legs narrows the shoulders and leaves the hips wide.
- **The rule (`app.js`, THE TORSO-ONLY TURN, measurement only):** the shopper's square-on widths and
  torso height are learned from readings the shoulder order already calls a side; shoulders at or under
  `TWIST_SHOULDER_MAX` (0.2) of theirs while the hips keep `TWIST_HIP_MIN` (0.7), on a torso of its usual
  height, `TWIST_READINGS` (2) in a row. While it holds the pose vote says BACK where the order abstains
  (on the FaceDetector path only where no face was found) and the published |yaw| is acos(shoulder
  ratio) when larger than the world one. **`lib/orient-engine.js` was not touched** - main's rules decide
  on those readings, so no Worker deploy is needed for it. `?twist=0` is main's measurement; a TEST
  record logs every on/off (`twist`) with the two ratios.
- **Pinned by `torso-twist`:** the rule on literals; the twelve cleanly tracked recordings
  (`test/torso-twist-poses.json`, 698 readings) fire it 0 times and a loosened rule does fire on them;
  through the real engine a scripted torso-only turn sends BACK during the hold and FRONT after the
  release, and `?twist=0` sends nothing (the report). The live room on four of the 360s logged no
  activation, and §2.21's A/B keeps main's swap timing.
- **Not yet measured on a real torso-only turn** - no recording of one existed. The first TEST sessions
  of one are the check: their `twist` events and `shR`/`hipR` say whether a real twist reaches the bars.

### 2.21 This branch is main (bd766b2) + the hiding, rebuilt 2026-09-30 - and how that was proven
"Take the version on main now, give it all the code hiding, and make sure it works exactly the same;
then add the display improvements, make sure the interface isn't laggy, improve the detection."
`hide/main-v2` was cut from origin/main (bd766b2, the store size guides - which the old hiding branch
never had) and 1cb8c2d (the hiding at "main one to one again", §2.17) merged in; the display
improvements came from the approved f275ab4 WITHOUT its prompt edits; nothing of the solo experiment.
- **bd766b2's stored-chart pick, aliases, overlay token map and Phase 0 comparison moved into
  `lib/sizing.js`** with the rest of the fit; the browser fetches `/api/store-size-chart` as main does and
  forwards the adult charts raw. The Phase 0 summary describes our bands, so it goes to the support view
  only. The scanner's DOM reader left the widget with the rest of the reader:
  `scanner/size-chart-reader.src.js` (SHARED_BLOCK_HASH unchanged). Proven: main's in-browser
  calculateSize() vs the new path over 113,491 cases incl. 20 stored-guide situations - 0 differences in
  outcome and in main's 2,662 Phase 0 log lines; three mutations caught.
- **Found in a line-by-line read of every browser line the hiding added:** the render client was created
  with `telemetry:false`, which in SDK 0.1.5 also switched off its stats loop. Created as main does now
  (only the console logger silenced); the build refuses `telemetry:!1`.
- **The whole-room A/B** (scratch harness, re-runnable): main's worktree vs this branch's MINIFIED build,
  the user's own recorded 360s as the camera (a getUserMedia swap - a sensor), the real pose model, a
  fake render SDK served to both at the network layer that records every connect option, dispatch
  (prompt + image hashes, time in the clip), input frame and long task. Base: identical wire (model,
  options, prompts, images, 10fps), swap timings within main's own run-to-run spread (the pose loop and
  the orientation tick are two timers whose phase is random per run - proven by shifting it), connect
  and reveal the same. With the pose warm-up paid in preview for everyone, connect was 793ms vs 1186
  and the reveal ~0.5s sooner - but that moved the pose readings' phase against a turn, and on one clip
  a 30-degree look (a documented cost of main's 40-degree early turn) swapped and withdrew at some
  phases where main never did (4 of ~26 runs vs 0 of 11; 0 of 6 with the warm-up off). So the warm-up
  runs ONLY under a self-timer (the countdown must not stall on it): with the timer off, go-live is
  main's to the millisecond, its ~430ms first inference under the loading overlay as on main.
- **The full pose model was measured the same way and taken out** (§2.19): it changed full-turn timing.
- **prompts:** `trace:prompt --json` byte-identical to main's; `prompt-engine` on main's pin.

### 2.22 The back is sent before the reveal; a depth spike is not a turn (2026-10-01)
The first measurement of `hide/main-v2` (a clip + its TEST record): the back view came out plain and
the print arrived as the shopper faced front again. The record: the early turn fired at 1.29s on a
|yaw| of 41 while the shopper still faced the lens (14 -> 41 in two readings, the shoulder order still
voting FRONT, a dim room), and the BACK reference was acknowledged **2,058ms** after it was sent - the
tick awaits that acknowledgement (main's `await maybeSwap`), so nothing was decided for 2.5s.
- **The render engine is slow on an image the session has not sent, not on the upload.** Every TEST
  record (64 swaps): a FRONT swap - the image already sent at connect - 130-250ms almost always; the
  BACK's first send 400-900ms typically and 1.3-2.9s about one session in seven; the one session that
  sent the back twice, 912ms then 141ms. A pre-uploaded file reference (`client.files`, measured in one
  real session within the 15 credits the user allowed) took 1,242ms on first use - uploading ahead buys
  nothing. **`primeBackReference()`**: the cold-start re-assert (a hidden re-send inside the reveal hold,
  main's) sends the BACK first, once per session, byte for byte what the turn will send, then the
  front as before; the settle hold waits on the front, so the shopper first sees the front, settled. The
  cost is the back's first acknowledgement on the loading screen instead of on the turn. AI Auto with a
  real back only; `?prime_back=0` is main's hold; TEST records carry `prime-sent`/`prime-acked`.
  `back-prime`; `composite` counts it as the 7th send site (prompt from `wirePrompt`, clamped). **Moved to the
  connect on 2026-10-04 (§2.25)** - the reveal hold's re-assert is main's again.
- **THE YAW GUARD** (`torsoYawGuard()`, in the torso-only block): the published |yaw| is capped at the
  IMAGE angle of the shoulders (acos of their width over the learned square-on width) + 20. On the
  twelve recorded 360s it changes no turn's first 40-degree crossing and, through main's real engine,
  no clip's swap sequence (`torso-twist` §5.1b); the reported spike reads < 40 and fires nothing
  (§5.10; without the guard it fires - §5.9). The square-on width is learned in the PRESENCE GATE too
  (`awaitBodyPresence`), since the live pose loop only starts at the reveal - that session's spike came
  four readings in. `?yaw_guard=0` is main's measurement; TEST records carry `yaw-guard`, and every tick
  now records `sep` and `shR`.
- **The render token names the page's own origin** (`ownPageOrigin()`, server.js; `token-origin`): a new
  preview failed with "Origin not allowed" - the token was scoped to `DECART_ALLOWED_ORIGINS` alone.
- **The edge answers with the room's own engines or not at all** (`lib/api-version.js`, `api-version`):
  the deployed Worker had still been answering "top" where main's engine says "shirt".
- Found in the same record and left as main's: the first seconds rendered the garment's text without
  its graphic until a re-send completed it - the render engine's convergence, not a dispatch.

### 2.23 The return goes out when the chest comes round (2026-10-01)
"Everything works well except the back disappears too fast - it keeps happening, fix it once and for all."
The clip, frame by frame: the back print from ~2.47s to 3.304s, plain at 3.338s with the back still three-quarters
to the lens (~210 degrees). The TEST record: FRONT went out on main's EARLY RETURN - |yaw| 59 rising on the back
leg (shoulders at 51% of square-on, ~240 degrees: a real reading). A swap lands on about the body angle it was sent
at (here ~28 degrees before it; the outbound BACK sent ~88 landed ~72), so a 50-degree return lands the front
40-60 degrees before the side view on a body still showing its back: a FRONT reference there renders a plain back.
Main does exactly this; how early depends on how much the pose model compresses that shopper's depth.
- **THE CHEST COMES ROUND (`lib/orient-engine.js`, `makeEarlyTurnTrigger`'s `sideOrder`):** on the BACK leg, FRONT
  goes out on the first new reading of the shoulder ORDER at or past `ORIENT_RETURN_SIDE` (0.2) on the FRONT side,
  after the torso was seen turning toward the side since the trigger armed (an order in the side band, |yaw| 40+,
  or a torso loss) - the last condition is what keeps a mirrored skeleton on a back-facing body from firing it. The
  |yaw| fast/slow/loss paths stand down on that leg. The outbound leg is main's, untouched.
- **The same order gates PREDICTIVE BACK:** a fresh order on the FRONT side (the chest round to the lens) never
  predicts BACK - the |yaw| descent toward the lens after a return is what that path reads as a pass to the back.
  Seen in the engine replay at the per-frame reading rate (BACK onto the chest after most returns, main's rules);
  not seen in the whole room at its ~240ms reading rate (0 of 20 main runs) - stated, not claimed as a fix.
- **The measurement (`app.js`, `torsoOrder()` in the torso-twist block):** the signed image shoulder width over
  the shopper's learned square-on width (+1 facing the lens, -1 away, 0 the side); null until the baseline is
  learned and on a degenerate torso; published from the twist state's inference as `_poseOrd`/`_poseOrdAt`, sent
  as `ord`/`ordAt`, bounded by `sanitizeOrientSample`. The TEST record logs `o`/`oa` per tick.
- **Compatible both ways:** a room that sends no order (older build, no baseline yet) and `?return_side=0` are
  main's return exactly (`return-side` §1.3/§1.4/§4.1); an old Worker ignores the field. `orient-engine` §1 (main's
  replay hash) is unchanged. **It needs a `wrangler deploy`** (the engine runs in the Worker), deployed before the
  room that sends `ord`.
- **Measured:** `return-side` §4 - 13 recorded 360s x 4 tick phases through the real measurement and engine: the
  front lands median 238 degrees under main's rule, 287 with the chest (the outbound BACK on the same tick, no 360
  swapping more). The whole-room A/B (the minified room, 10 of the user's 360s x 2 phases, landing read as the
  clip's body angle 380ms before the dispatch - the room reads the pose every ~240ms, ~150-200ms old at the tick,
  calibrated on the reported session): main median 229 [148..271], the chest 280 [227..309]; outbound 56 vs 58;
  swaps per run 3.1 -> 2.5. The few under 255 are the pose model's own snaps (the order jumping 40-60 degrees between
  two readings). Higher bars (0.3/0.4) moved the landing toward a chest facing the lens; 0.1 barely differs.
- **Not measured live yet:** the first TEST sessions with it are the check - `o` per tick and where the FRONT went out.

### 2.24 Nothing the page loads names an AI we use - the engine behind our edge (2026-10-03)
"Nobody should be able to see anything in the code related to Decart or any AI we use - put it on Cloudflare."
Audited first: the room bundle carried the model id and the pose library's CDN/model URLs; the SDK bundle (shipped
as-is) carried the engine's hosts, telemetry URL, user agent and every media-library name; the page opened the
engine's signalling socket and media server by name and posted telemetry to the engine's host; the token route
returned the engine's raw key format and model id; `/api/health` named the engine; two classifier answers named
the classifier.
- **The cloak (`scripts/cloak.mjs`, `cloak` test):** every syntax position a vendor word can occupy in a
  third-party bundle (string, template, regex, member name, object/pattern/class key) becomes a runtime-decoded
  expression with the same value - deterministic per build input, so hashed names stay cached. Words that
  travel on the wire are RENAMED to the room's dialect instead (`RT_WORDS`), and the edge translates them back.
  A free identifier it cannot rewrite fails the build. `VENDOR_WORDS` is the list; the build refuses any match
  in ANY shipped file (GSAP/three on a CDN in the merchant guide are fine - an AI package is caught by name).
- **The engine behind our edge (`lib/rt-proxy.js` pure, `cloudflare/orient/src/rt.js` the Worker, `rt-proxy`
  test):** `wss://<edge>/v/s?api_key=<sealed ticket>&model=v` is relayed to the engine with the real key, model
  (`RT_MODEL`), query words and user agent; the engine's room info comes back with the media URL and token
  SEALED behind `/k/<sealed>`, which relays the media signalling (WebSocket + its HTTP checks) to the real host;
  `/m` forwards the SDK's telemetry. A refused upstream is closed with its reason (the SDK stops retrying a
  permanent failure). The media itself (WebRTC) is not relayed - only signalling - so the video path and its
  latency are as before. Engine hosts and the model id are Worker vars (`wrangler.jsonc`), never shipped.
- **The ticket (`sealTicket`/`openTicket`):** the token route (`server.js` mintToken) answers `{t, exp}` - the
  engine's key sealed (XOR + check byte, base64url); only the edge opens it. Obfuscation of a name, not a new
  credential: a ticket is exactly as usable through our edge as the key was directly.
- **The pose library:** bundled same-origin and cloaked (`pv.<hash>.js`, loaders `pl/pn.<hash>.js`); its
  runtime (.wasm, ~9 MB) and model (~6 MB) - binaries that carry the library's name hundreds of times and
  exceed the Vercel function's ~4.5 MB response - are served from the edge's static assets XOR-scrambled under
  content-hash names (`scripts/build-edge-assets.mjs`, manifest `lib/edge-assets.json`) and unscrambled in memory
  by `loadPoseLandmarker()`. The build refuses a node_modules whose runtime the manifest does not describe.
- **Server answers:** `/api/health` says only `ok` (details for the support token); the token route's errors
  are neutral; the classifier's answers say `source: "ai"` / `classifier_unconfigured`. Logs keep the detail.
- **Proven without the engine (scratch E2E, re-runnable):** the minified room (a QA build pointed at a local
  `wrangler dev` of the edge with `RT_EDGE_WS`) went live through the edge to a stand-in signalling server and a
  REAL LiveKit server (a participant playing the inference server): revealed at 4.3s, the output video played,
  every WebSocket URL was the edge's, no frame carried a vendor word, the stand-in saw the real model/key/user
  agent/origin, and the pose model loaded from the edge. Telemetry: real key/model/user agent at the engine, a
  bad key not forwarded, a foreign Origin 403.
- **Deploy order:** `npm run build:edge-assets` (when the pose runtime changes) -> `wrangler deploy` (routes +
  assets; old rooms never call them) -> the room. A real engine session through the edge is the final check.
- **Residual, stated:** a determined reverse-engineer can still run the cloaked code, read WebRTC internals (the
  media server's IPs and TURN hosts) or decode the media library's binary join request; and **the GitHub
  repository is public** - every source file, this one included, names everything. Hiding needs it private.

### 2.25 The front goes out AT THE SIDE; the back is primed at connect (2026-10-04)
"At the start it didn't put the shirt at all, then the back worked, then the back jumped onto the front."
The clip: 0-2.4s a sleeveless panel with the print instead of the T-shirt; the back right from 3.2s; 4.6-5.0s
the back print on a chest facing the lens to the end. Its TEST record (acks slow all session: prime 1120ms, back
723ms, FRONT 505ms): the chest rule (§2.23) waited for the order to pass 0.2 - the tick at the side read 0.12 -
and fired on the next one, 0.74 (~318 degrees, 3.96s); 505ms + the render switch put the front past the 5s window.
- **AT THE SIDE (`makeEarlyTurnTrigger`, `SIDE_FIRE`/`BACK_SEEN`):** on the BACK leg, FRONT also goes out on the
  first new order reading within `SIDE_FIRE` (-0.25) of overlapping, rising from a reading at or past `BACK_SEEN`
  (-0.5) since the arm - the side view itself. A mirrored skeleton jumps past that band, never into it; the
  chest condition (0.2, side seen) stays as the fallback for a side that fell between two readings. On the
  reported record it fires on the order -0.19 at 3.48s - a tick (~480ms) sooner (`return-side` §3b). Replayed
  on 13 recorded 360s x 4 phases (per-frame readings): median landing 263 (main 238, the chest rule 287).
- **The back is primed at connect (`primeAtConnect`):** right after the garment is applied at connect - the back
  once, the front again - while the first frames are still on their way. The reveal hold's re-assert is main's
  exactly again (a re-send of the image on the wire); the prime no longer adds its first acknowledgement to the
  reveal (twin: reveal 6.9s vs ~8.0s). The sleeveless start is NOT proven to be the prime: every pre-prime
  session (7, OASIS) revealed on the full shirt, one post-prime one (s3) did too; this product (PEAK) had a
  "tank" start on record before the prime existed (§2.9's reveal note). Its front photo is the next suspect.
- **The engine twin (scratch harness, re-runnable):** a stand-in engine with the measured behaviour - output
  ~0.95s behind the camera, a reference visible ~0.48s after its ack, first/repeat ack distributions from the
  TEST records - painting the very image the room sent; the camera carries the clip's clock (a barcode on the
  left edge - the top strip covered the head and blinded the pose model), so every output frame says which
  moment of the clip it shows and which reference was on it: where each swap lands, as the shopper sees it.
- **The order confirms the early side (`ORDER_CONFIRMS`, 0.2):** |yaw| folds at 90, so on the way INTO the back it
  falls under the threshold again, and a skin vote for FRONT there withdrew a real turn (the twin: FRONT on a body at
  ~140 degrees for 1.4s). An order reading on the early side's own half blocks the withdrawal; a look that came back
  reads the other half and withdraws as main does; a room that sends no order is main's exactly (`return-side` §1.14-§1.16).

### 2.26 "It takes forever to load" - a credit refusal is final; the go-live stages are recorded (2026-10-04)
Two TEST sessions of `hide/edge` sat 34s and 22s after the press: no `watch`, no prime - nothing before the connect
was recorded. The third showed the cause on screen: the engine answered **"Insufficient credits"** (the account was
empty), and the SDK retries every refusal not on its permanent list (`permanentErrorSubstrings`: "not allowed",
"401", "invalid api key"…) five times, 1+2+4+8+10s apart - ~30s of loading screen, then the engine's raw text.
- **The edge makes it final (`lib/rt-proxy.js` `roomErrorText`/`NO_CREDITS`):** an engine ERROR frame about credits
  (insufficient/out of credits, quota exceeded, payment required) reaches the room as `NO_CREDITS`, which says "not
  allowed" - the SDK stops at once; an upstream 402 closes the same way (`rt.js`). Any other error is only scrubbed
  and retried as before (main's). `rt-proxy` §3.9-§3.12 check it against the bundled SDK's own list.
- **The room's words (`goLive()`'s catch):** the shopper reads "the live try-on is unavailable right now"; a TEST
  session reads that the render account is out of credits. Twin, an engine refusing as the real one did: the message
  at 1.35s, one connect (was ~27s, six connects; "Server overloaded" still takes the retries).
- **Credits are topped up by the account owner** on the engine's platform; the key is `DECART_API_KEY` in Vercel
  (Production + Preview), and a changed key needs a new deployment.
- **A TEST record now carries every go-live stage:** `gate` {v, ms}, `preload` {ok, back, ms}, `rt-sdk`/`rt-floor`/
  `rt-token`/`rt-open` (ms since the connect began), `rt-queue` (the engine's queue position - `connect()` waits
  there with no timeout of its own), `rt-warn`/`rt-err` (the SDK's logger, silent in the shopper's console),
  `rt-error`, `live-connected`, `live-fail`. Passive: a shopper's session records nothing.
- **The presence gate's whole wait is bounded:** it awaited the pose detector with no limit and only then started
  its `POSE_GATE_TIMEOUT_MS` clock. The hidden build loads the detector from our edge (§2.24) and compiles it per
  room load, where main's came from a long-cached CDN; the clock now starts first and covers the load - a detector
  not ready in time is one that failed (§2.5). Preloaded at room entry, as in every measured session, nothing changes.
- **Measured in the twin (idle machine):** gate 0.8s, garment 0.03s, connect 0.85s, reveal 6.8s after the press.
- **Run nothing heavy on the shopper's machine while they test** - the twin runs Chrome, the pose model and a media
  server (one ran during the first two reported sessions; it was not the cause, the credits were).

### 2.27 Main (93e2c01) merged into the hidden build - main's size work carried through the hiding (2026-10-04)
"What's in the screenshot (main's production deploy) I want in main, together with the new key and what we're doing
now - not in a preview." Main had moved 12 commits past the hiding branch's base (bd766b2): the store's chart DECIDES
the adult size (§2.5b), one stored chart per size system (v16), adidas/castro size-guide capture (ARIA div-grids, the
glued "86cm", the inches/cm twin, JSON envelopes, CSS-Modules class tokens), the widget's product signals on every
PEAR_UPDATE_GARMENT, garment_cache age_group. Merged into `hide/edge` and carried to where the hiding keeps each part:
- **The fit (§2.12):** main's new `pickStoredSizeChart()` tier pick, `storeChartRecommendation()`,
  `estimateBodyMeasurements()` and `normalCdf()` moved verbatim into `lib/sizing.js`; the room's `calculateSize()` stays
  the shell. **Proven:** main's in-browser `calculateSize()` (93e2c01) vs the room shell + JSON + sanitiser + server over
  146,440 cases (37 product situations incl. 18 with stored charts, the height/weight grid, the optional measurements):
  0 differences in outcome, in main's Phase 0 lines and in its 31,733 decision lines; 15,576 cases where a stored
  chart moved main's answer. Three mutations caught (a 1cm band: 18; the decision margin 0.1->0.12: 266; one body
  coefficient: 28 outcomes / 25,208 log lines).
- **The scanner:** `scanner/size-chart-reader.src.js`'s parser block was byte-identical to main's old widget block, so
  it is main's new block now; the generated `scanner/size-chart-parser.js` equals main's in every line of code.
- **The widget:** main's DOM half (ARIA grids, the twin collapse, the declared-inches fix) is in the collector; the
  cell half (the glued unit) in `lib/sizing.js`; the correction message uses main's `productSignals()` with the raw chart.
- **Tests:** main's new suites run against this architecture with main's assertions unchanged (`store-chart-
  recommendation` through the real shell + module; `size-chart-shared-fixes` through the widget's raw wire and the
  server's reader, plus §0 pinning the copies); `lib/api-version.js` re-synced - **so the Worker must be deployed
  before the room that carries it**, or the room falls back to the origin for `/size` (correct, slower).

### 2.28 A slow engine on a heavy product - the turn timed by the engine's pace; the camera never shown (2026-10-04)
"Too many times it went back to the original camera and then to the video; the back's drawing showed on the front at the
end; and it grabbed the shirt at the start though I didn't." The record (PEAK tee, the new key, production): output 7 fps
with 3 stalls (0.5-0.7s, two at a reference switch) bridged by the camera; the return FRONT sent on time at the side but
acknowledged in 743ms on a full turn of ~2.5s, so it landed on a chest facing the lens; the "grab" was the render's own
hands-on-the-hem in its first second (the product photo has the hands down - an engine artifact, not a dispatch).
- **NOT the edge (measured, so nobody re-treads it):** every TEST record tabulated - the OASIS tee acked a repeat image
  in 127-325ms (33 sessions, direct), the PEAK tee in 323-743ms on the SAME direct path (09-30) and through the edge
  alike; a relay identical to `rt.js` on a temporary Worker added nothing to 58-84 KB WebSocket round trips to Frankfurt
  (259/279 vs 264/263ms) or Virginia (326/319 vs 310/354ms). The engine's host is GeoDNS (Route 53): from Israel a
  CoreWeave address, from US/Cloudflare subnets AWS us-west-2 - the two answer `x-decart-rgn: coreweave` / `usw2`.
- **THE ENGINE'S PACE (`lib/orient-engine.js` LEAD_BASE_MS/LEAD_MAX_MS/LEAD_FLOOR, `app.js` ENGINE_PACE_LABELS,
  `engineAckEstimate()`):** the room times every IMAGE write (never prompt-only) and sends the median of the last three as
  `lat`; above 250ms the return FRONT fires as soon as the order's own speed reaches the side within the extra ack time
  (at most 700ms earlier, never from deeper than -0.7, never on a falling or snapping order). A fast engine, no `lat` or
  `?lat_lead=0` is the side rule exactly (`return-side` §4b.1). Replayed on the 13 recorded 360s x 4 phases with a 750ms
  engine: the return landed at median 333 degrees without it, 307 with it (a fast engine 276) - not all the way, because
  the earliest fire is the first order reading after the turn's deepest back point and a fast turn crosses from the back
  to the side in one ~250ms reading. `return-side` §1.17-§1.21, §4b, §5.8-§5.12. **Needs a `wrangler deploy`.**
- **Reworked the same day after the next session** ("the back works, then at the front the back appears on the front too"):
  FRONT went out on the side reading (0.16), acked in 556ms, showed ~0.52s later on a chest coming round - the back print
  on the chest for ~0.27s (3.63-3.85s of the clip). The first cut projected the last two readings' speed and fired
  nothing: that turn ran ~90 deg/s from the back to 238 and ~220 deg/s after it. Now the speed is the TURN'S AVERAGE since
  its last square-on front reading (ord >= 0.9 on the FRONT lock) - the recorded returns run a steady 100-180 deg/s - the
  base is 200ms (a fast engine's repeat ack), the floor -0.85, and the decision is taken BEFORE the re-arm (a reading the
  shoulders still vote back on, |yaw| under 50, re-armed and ended the tick: the 04:55 session's -0.74). Both sessions,
  replayed from their own records (`test/return-side-pace.json`, `return-side` §3c): the return goes out a reading earlier
  (-0.74 / -0.53, 237 / 206ms sooner), every swap before it the record's own. Replay median 333 -> 299 degrees.
- **THE BACK WAITS FOR AN ENGINE THAT CAN KEEP UP (`gateBack()`, after `armLine()` - the suites slice `step()` by text):**
  the third session ("in one frame the back's drawing is on the front and the back at once, and after the turn it's on the
  front") fired its return as early as the readings allowed (~245 degrees) and the engine took **1,582ms** to accept it -
  the back print on both sides in profile, then on the chest. On a ~2.5s 360 a BACK and a FRONT cannot both land. Asked,
  the owner chose a guarantee now AND a faster engine next. A BACK is HELD (`backHeld`, the lock stays FRONT, a plain back)
  when its return - firing at the earliest at ~240 degrees - would land past ~295 at the turn's average speed and a SLOW
  ack (twice the median of the last three repeat acks, or their slowest: `lat`/`latHi`); a turn once held stays held until
  the shopper is square to the lens again (without that latch a vote-confirmed BACK passed on the return leg and landed at
  360 - the twin, m5). The back's first send (the prime) is not a pace sample - counted, it read a fast engine as slow.
  Twin: a slow engine holds the back on every fast clip (back-on-front 0), a fast engine shows it (52-62 -> 269-276);
  `return-side` §3d (the three sessions held, a fast engine and a 3x slower turn not, the latch, no engine = the rule).
  **The cost, stated:** with this engine's pace on this tee, a 5-second measurement shows a plain back on almost any turn.
  **TURNED OFF BY DEFAULT the same night (`?back_gate=1` turns it on):** the first real-body sessions with it (PEAK, two
  2.4s 360s, the back held both times - lands 389/350) did NOT show a plain back: the FRONT reference held through the
  turn drew the FRONT print on the shopper's back (clip 23:19, 3.0-3.6s) - "it put the front's drawing on the back too".
  Worse than the late return it was built to stop, so the default is the open path again (`return-side` §3d asserts it).
  The second session (23:20) rendered a tank top from the first frame to the last - the engine's reading of this
  product's photo, seen before the prime and the gate existed (§2.25); not a dispatch.
- **THE ENGINE-SPEED EXPERIMENT (TEST sessions only, `?pear_exp=small|ref|small-ref`, `engine-exp`):** "small" sends each
  reference downscaled to 640px; "ref" uploads both references once at connect through the edge (`/f/v1/files` ->
  `RT_FILES_URL`, the sealed key opened) and sends the file id after that. The record carries `ctx.exp`, `exp-small` and
  `exp-upload`. The owner approved 3-4 short real sessions to measure which (if any) brings the acks down.
  **Ran 2026-10-04 (production, PEAK tee, clip m1 as the camera, one session each) - NEITHER IS FASTER:** base - the back's
  first send acked 557ms, repeats <= 557, no stall; ref - the uploads took 2.4s at connect and the back BY ID acked in
  733ms, repeats 521; small (84 -> 61 KB) - 1,481ms, repeats 746-1,103 (that session's connect took 6.0s - the engine was
  slow all round). A first ref session posted to `/v/f/...` (fixed, 923b788) and fell back to data URLs: 603ms, then
  repeats 482 -> 1,125 -> **3,468ms** with 3.4s of output stall in the 5s window - nothing of ours on the wire changed.
  Removing the upload (ref) or a quarter of the bytes (small) does not move the ack: the time is the engine's, and it
  varies more between sessions than any lever of ours. In all four the gate held the back for the whole turn (110-158
  deg/s; planned landing 333-565 degrees) - the stated cost above, now measured: the back print does not appear.
  **Not separated yet:** every fast-ack record (OASIS, 127-325ms) predates 09-30 18:16 and every slow one (PEAK) follows
  it - the product, the date and `fbe85c1` (the render client created with telemetry ON, as main does: a stats loop and an
  HTTP report, no signalling traffic) change together. One OASIS session today separates the product from the rest.
  The experiment code stays TEST-only (a shopper's session never reads `pear_exp`); nothing became a default.
  **Separated the same evening (two more approved sessions):** OASIS today acked its repeats in 592-769ms (its first back
  1,258ms) where it acked 128-250ms on 09-27..29 - **not the product**; a PEAK session with the SDK's telemetry off
  (`?pear_exp=notel`, 5d4ebfb) acked in 1,026-2,324ms with an 11s connect - **not the telemetry**. The driver timed every
  signalling frame at the network: each `set_image` (104-116 KB) -> `set_image_ack` gap equals the room's own ack to the
  millisecond - **nothing is lost on the page's thread**. The engine host (`RT_SIGNAL_URL`'s, GeoDNS, TTL 42s) resolves
  from Israel - and for a German subnet - to one CoreWeave address in Michigan, US, answering `x-decart-rgn: usw2` (now and
  then `coreweave`): a 220ms TCP round trip from here, against which a ~105 KB reference costs several round trips before
  the engine even starts. The fast OASIS weeks were served from closer. That is the engine's routing, not a line of ours -
  the owner's to raise with the vendor (an EU region, or why Israel moved ~09-30). Until it changes the gate stays (asked
  2026-10-04: "keep the guarantee"): never the back print on the chest, a plain back on a normal turn with this engine.
- **The camera bridge is off** (§2.9) - `stream-continuity` pins the default.

### 2.29 THE SWAP FLOW - the turn is read while a swap is on the wire (2026-10-05)
"The back's drawing stays on my chest at the end of the turn - make it work by what the real camera sees, learn the delay
and fix it." Read from the 23:57 TEST record and clip (the back gate already off, §2.28): the BACK went out at |yaw| 74,
and **nothing was measured or decided for 1.67s** - main awaited every swap inside the tick (`await maybeSwap`) - the whole
back view; the next reading was |yaw| 26 on the way back, FRONT went out then, and its print reached the chest after the
window closed (4.1-4.8s of the clip). Two more of ours in the same record: 411-546ms between the decision and the send
(3-30ms in every earlier record), and no shoulder order the whole turn (4 of the 5 baseline readings in).
- **THE SWAP FLOW (`app.js`, `SWAP_FLOW` / `pendingSwap` / `runPendingSwap()` in the watcher):** the tick no longer awaits the
  swap, so the engine keeps receiving the turn's readings while a reference is on the wire (its return rules read the back
  half - §2.23/§2.25), and a swap it decides meanwhile is KEPT (the latest wins) and goes out the moment the wire is free
  (after a swap's ack, a profile or a re-anchor) instead of being dropped on `applying`. The cooldown and every other
  pre-flight are unchanged. `?swap_flow=0` is main's (await, drop). Measured through the real engine on the replay corpus
  (`orient-engine` §1b, 4,116 sessions): a full 360 ending with the BACK still on (the back print on a chest facing the
  lens) 44 -> 12 of 1,008; every trajectory 98 -> 38; never two applies on the wire. `orient-engine` §1 still pins MAIN's
  watcher - `test/orient-replay.mjs` puts `swap_flow=0` on the location only, so its keys, seeds and hash are unchanged.
- **The whole room, measured (the engine twin, §2.25, with that day's engine: repeat acks 500-700ms, one in ten 1.0-1.6s;
  the minified room, the real pose model, 11 of the user's recorded 360s x 2 seeds, production vs this):** the back print on
  a chest facing the lens 7.3s in 15 of 22 runs -> 2.5s in 8; the front print on the back unchanged (5.9s in 13 -> 5.7s in
  12). What is left is a BACK the engine acknowledged in 1.3-1.6s - it lands late whatever we do.
- **THE ORDER FROM THE SECOND READING (`torsoOrder()`, `ORDER_BASELINE_MIN`):** until the baseline settles (5 readings) the
  order is scaled by the widest square-on reading so far, from the 2nd; after, by the learned width as before.
- **A swap never waits on the network for its words (`wirePromptSettled()`):** the exact memoised prompt, else the closest
  settled one for the same garment and angle (same pose, then any size delta); the next re-anchor sends the exact words.
- **The record names the waits:** `apply-wait` {ref, prompt, settled} when a payload took >30ms to build, `wire-wait`
  {label, ms} when a write queued >30ms, `swap-pend` when a decision waited for the wire.

### 2.30 THE LANDING, PROJECTED - a fast return goes out on time (2026-10-05)
"It only fails when I turn fast; turning slowly works. Make it react much faster, without the shirt jumping." Two fast 360s
read frame by frame against their records (06:09 - a ~2.1s 360 - and 05:55): the front reached the body 0.25-0.35s after
it passed the side - the back print on the chest - and in both the reading the return should have gone out on had already
arrived. The 2026-10-04 lead rule (`angle + avg x (lat - 200) >= 270`) missed it at 06:09 by under one degree (269.x on
the Worker; the next reading was 250ms - ~50 degrees - later). What it left out:
- **the reading's age** - taken 120-160ms before the tick (`oa`), so the body was already 25-30 degrees further round;
- **the speed now** - the return runs faster than the turn's average (179 vs 152 deg/s there): the last plausible step's
  own speed (measured across the deepest point on each reading's own leg), the average only without one;
- **the tick's grain** - a reading every ~250ms is 45-60 degrees of a fast turn.
`makeEarlyTurnTrigger` (`LEAD_SCHEDULE_MS`, `?lead_project=0` is the 2026-10-04 rule) now fires when
`angle + speed x (age + lat - 200) >= 270`, and when that landing is due before the next reading the fire carries a
`delay` the room honours (`delayedSwap()`, THE SWAP FLOW only; a newer swap supersedes it; `stop()` clears it). An old room
ignores the delay and sends at once - up to a tick early, never later than before. **Deploy the room first, then the Worker.**
Replayed from the records (`return-side` §3e): 06:09 fires on its -0.72 reading at once (250ms sooner, with ~30 degrees of
margin); 05:55 on its -0.82 (290ms before the 2026-10-04 rule, 500ms before the record); 06:11 (slow) within 64ms of before;
every outbound BACK unchanged. The twin calibrated to the clips (the render switch 550-750ms after the ack, not 480).
- **A back-to-side jump is a step (`SIDE_JUMP_YAW`):** the first real session with it live (the user's 360 at 1.3x, a ~300
  deg/s return) read -0.98 -> -0.04 between two readings; the 0.8 snap filter threw that away and the FRONT waited for the
  chest (0.53) - the back print on it ~0.4s. On the BACK leg a jump from the back that lands short of the chest counts when
  the same reading's world |yaw| says side-on (>= 60; 85 there) - `return-side` §3e.2b (267ms sooner); the synthetic snap of
  §1.19 (|yaw| 40) is still a snap. Even so, a return that fast lands ~0.25s late: the side comes one reading after the
  deepest back, and the deepest reading cannot yet say the shopper is coming round.
- **THE LANDING MODEL (`return-side` §4c) - the consistency bar, slow to fast:** the thirteen recorded 360s x 4 tick phases
  at 0.8x / 1x / 1.3x (1.3x is the user's own fast turn, a ~2.1s 360), today's engine (lat 520ms), a swap landing on the
  body at send + (lat - 250ms). Pinned: the back print on a chest past 300 degrees 0ms (0.8x) and 20ms (1x) over 48 turns,
  at 1.3x p90 42ms / 606ms total (the 2026-10-04 rule 1,960ms); a front landing before 235 at most once in 48; never a
  third swap in a turn. Near the back the order saturates (-0.98..-1.0 on bodies at 150-230 degrees), so the projection
  fires from -0.9 (`LEAD_FLOOR_PROJECTED`; the 2026-10-04 rule keeps -0.85) - a shopper standing at the back wobbles
  -0.93..-1.07 and never fires it (`return-side` §1.20b). At 1.6x (a ~1.3s 360) the model shows no gain over before: the
  side comes one reading after the saturated back, and only a faster reading rate could see it sooner.

### 2.31 THE POSE, READ FOR THE DECISION - every decision on a fresh reading (2026-10-05)
"Make it react as fast as you can." The live pose loop (240ms, `startPresenceWatcher`) and the orientation tick (250ms)
ran on two timers, so the reading a decision was taken on was 4-215ms old (`oa`/`ya` in every TEST record), wandering with
their phase - and the outbound BACK, which fires on a reading (the early turn), went out that much later on the body; the
return's projection (§2.30) corrects for the age, the BACK's rules do not. With `POSE_SYNC` the tick runs the session's
inference itself before it samples (`_poseInferNow`, at most `POSE_SYNC_WAIT_MS` 120), and the loop's own timer only
covers what the tick does not (no watcher, a single-view garment): the same ~4 inferences a second, one in flight at a
time, always fresh. The replay harnesses run the tick without the pose loop (typeof-guarded), so `orient-engine` §1 is
unchanged; §4 pins the step. **OFF BY DEFAULT the same evening (`?pose_sync=1` turns it on):** "it's laggy" - the room's
camera presented 24-26 fps in all three of that day's sessions against 28-30 before it (one longer main-thread block per tick,
a dropped frame each, four times a second). The return's projection corrects the reading's age without it.

### 2.32 THE SESSION CAP - no engine session outlives 90s through the edge (2026-10-05)
A TEST run on a machine that froze mid-session (load 19, the WiFi daemon at 65% CPU) left its engine session open ~5
minutes: the room's 5s kill clock is a timer in that page, and a frozen page - or a phone tab put away - runs none. The
edge's relay (`cloudflare/orient/src/rt.js` `relay()`, `rtMaxSessionMs()`) now closes every `/v/s` session after
`RT_MAX_SESSION_MS` (default 90s, bounded 30s-10min; a real one takes 15-25s, ~45s with a slow connect and a 10s timer),
the room's side with a reason on the SDK's permanent list ("not allowed") so it does not reconnect into a second one.
`rt-proxy` §7. Worker deploy.

### 2.33 "The back disappears too fast, in the middle" - the shoulder scale re-learns; a projection needs a deep back (2026-10-05)
After §2.30 the user reported the front perfect and the back vanishing mid-back. The 17:25 record: the shoulders read 0.46-0.56
square to the lens and -0.71 at the deepest back - the square-on width the presence gate had learned was 2x the live one (the
raw separation was symmetric, +0.35 / -0.35); the next back reading (-0.60) read as a crossing of the deepest point (135 ->
233 degrees at ~380 deg/s) and the projection sent the FRONT on a body still at ~200. 17:23 carried a 3-4x scale and, worse,
a mirrored skeleton for the whole back view (the shoulders read FRONT while the shopper faced away), which withdrew the BACK.
- **THE BASELINE RE-LEARNS (`app.js`, the torso-twist block, `BASELINE_OFF`):** two live square-on readings in a row outside
  0.6-1.6x the learned width start the baseline afresh (a TEST record logs `baseline-relearn`). The twelve recorded 360s never
  re-learn (`torso-twist` §6).
- **...and the torso's height (17:41):** the gate learned it ~2x (the shopper still walking back), every live reading fell
  outside `TWIST_TORSO_BAND`, and the order went stale for 12s through the whole turn - the FRONT went out on a vote, late,
  the back print on the chest. Two square-on readings out of the height band re-learn it too (`torso-twist` §6.3b).
- **Pixel proportions:** `poseTorsoWidths(result, aspect)` multiplies by the frame's width over its height (`_poseAspect`,
  set at every inference; a change is logged as `pose-aspect`) - if the camera changes shape between the gate and the live
  loop, the width no longer changes with it. Ratios are unchanged at a constant aspect, so nothing else moves.
- **The projection needs the back seen DEEP (`lib/orient-engine.js` `DEEP_SEEN` -0.85):** a turn that never reads past it is
  left to the side rule; a re-arm on the same leg keeps it. `return-side` §3e.2c (17:25: now on the side reading, 0.14);
  the landing model (§4c) is unchanged. **Worker deploy.**
- **Not fixed:** a mirrored skeleton for a whole back view (17:23) - the pose model's own front/back confusion.

### 2.34 The landing recalibrated - the back stays to the side (2026-10-05 evening)
"Now the back disappears too fast." The 18:10 clip, read against its record: the front reached the body 0-100ms after it was
sent (acks 408-413ms that evening - 17:25 the same) and the panel went from a back at ~200 degrees to plain at ~230-240. The
projection had assumed the front lands (ack - 200ms) after the send and aimed it at 270 - so it went out early.
- `LEAD_BASE_MS` 200 -> 350: a reference reaches the body about (ack - 350ms) after the send; the lead still follows the
  session's own pace (`lat`), so a slower engine gets more.
- `RETURN_TARGET` 270 -> 280 (the order's own angle): in the landing model with the measured delay (`return-side` §4c, now
  lat 430 / L 80ms) the front lands median 270 / 270 / 275 degrees at 0.8x / 1x / 1.3x, p10 251 / 256 / 263 - the 270 aim
  landed it 262 / 265 / 273, p10 243 / 251 / 261 - and the back on a chest 0 / 0 / 244ms over 48 turns. §4c.5 pins the
  median at 265-290 and p10 at 250+ at every speed. **Worker deploy.**
- The 06:09 and 05:55 fast returns still fire on the same readings (now 5ms / 49ms later, `return-side` §3e).

### 2.35 Making "the second measurement" the rule - 18:21 vs 18:22 (2026-10-05 evening)
"The first time it vanished too fast, the second time it worked perfectly - make the second consistent." Read against
their records, the first had three causes the second did not:
- **A rotation re-drape held the wire (`reconditionForTopology`):** the turn's first 15 degrees fired a body-contour
  re-drape - a full FRONT re-upload - and the BACK waited 418ms behind it. In AI Auto dual view a ROTATION-only shift
  now stands aside (the front/back swap re-conditions the rotation); a lean or a volume change still re-drapes. TEST
  records log `redrape` / `redrape-skip`.
- **The phantom step at the bottom of the back (`lib/orient-engine.js`, THE DEEPEST IS THE BACK):** the back read -0.87 at
  its deepest; on the order's own scale -0.87 (150 on the way in) -> -0.84 (213 on the way out) was a 63-degree step at
  285 deg/s and the FRONT was scheduled at the back. The projection now measures both readings against the deepest the
  leg has read (`deepest`, at least `DEEP_SEEN`). Replayed (`return-side` §3e.2d/e): 18:21 now goes out at the side
  (-0.18); 18:22, the perfect one, keeps its reading (within 32ms); 18:10 within 5ms. **Worker deploy.**
- **The camera changes shape at go-live:** in a portrait room the stream opens 9:16 and turns 512x288 when the input
  throttle's constraints reach the shared source (`pose-aspect` 0.56 -> 1.78); the shoulder baseline now starts afresh on
  the first reading of a new shape (`torsoTwistObserve`), and an "off" reading no longer averages into the baseline
  before its pair forms (`torsoTwistStep`). `return-side` §4d.
- Landing model (§4c, measured delay): the front lands median 268 / 270 / 276 degrees at 0.8x / 1x / 1.3x, p10
  249 / 259 / 263; the back on a chest 0 / 0 / 239ms over 48 turns.
- **The next night - "almost perfect, it goes a little before; add a tiny bit, and no stutters at all":** three sessions sent
  the front at -0.16 / -0.28 / -0.52 (+236ms) - 10-20 degrees before the side. `RETURN_TARGET` 280 -> 290: the model lands it
  median 276 / 275 / 278, p10 259 / 261 / 267, the back on a chest 0 / 110 / 240ms over 48 turns. And no body-contour
  re-drape at all in AI Auto dual view (two of the three, at 5 and 4 output fps, carried a volume re-drape - a full
  reference upload - inside the window); a single-view garment re-drapes as before. The output stalls themselves (one
  2.1s) were the engine's, with nothing of ours on the wire.
  Two of the three fired AT ONCE (the first reading past the deepest back already projected past the aim), so the aim did
  not move them: every projected return now waits at least `RETURN_MIN_DELAY_MS` (50ms, ~8 degrees) - the model moves 1-2
  degrees at p10 (261 / 262 / 268), nothing else. A smaller lead (`LEAD_BASE_MS` 400) was tried and rejected: the back on a
  chest 116 / 290 / 342ms in the model, and the 05:55 / 18:22 returns a reading later.

### 2.36 The landing, measured on the clips - every aim had been tuned on a delay ~0.2s too late (2026-10-07)
"Now the angles are not accurate, it disappears too fast." The 13:53 clip: the back print gone at ~250 degrees, the front
aimed at 290 by the projection. Until now a landing was read off a clip by eye and the clip's body angle guessed; this time
the room's own lite pose model ran over every presented frame of eight of the user's clips (10-04 to 10-07; scratch
`pose-clip.mjs`), each clip's shoulder-order curve lined up with its record's readings (least squares), and the frame the
back print left the body found frame by frame:
- **The engine's swap reaches frames taken BEFORE the send:** -0.31 to +0.02s across the eight, median -0.10s, where
  `LEAD_BASE_MS` assumed (ack - 350ms) - ~80ms after it. The send-to-screen time stayed ~1.0s in every clean session; what
  moved was how old the body on screen was (1.02s in some sessions, 1.14s in others) - the engine renders frames it already
  holds with a reference it has just received. Across acks it follows the old rule's slope (a ~200ms ack lands ~0.33s
  before the send - the 2026-09-27 sessions; ~550ms at the send), so it is still keyed on `lat`.
- **The projection now leads by (lat - `LAND_BASE_MS` 530), negative on a usual engine** (bounded by `LAND_LEAD_MIN_MS`), and
  runs whenever the room sends a pace, a fast engine included (§4b.1: never sooner than the side rule). Past the side it
  HOLDS the side/chest rules while the front would still land on the back, up to order 0.5 (`PAST_SIDE_HOLD`). Its speed is
  the faster of the last step and the turn's average (05:55 read one 86 deg/s step on a 154 deg/s turn and waited a
  reading too long). `RETURN_TARGET` 290 -> 280. `?lead_project=0` (the 2026-10-04 rule) keeps `LEAD_BASE_MS`.
- **Measured, not modelled (`return-side` §3f, `test/return-side-clips.json`):** each session replayed, its observed vanish
  moved by the change in send time, read off its own clip: median 266 -> 277.5, none before 250 (was 211 and 249), the two
  fast turns that put the back on the chest 294 -> 282 and 305 -> 292. The 13:53 report itself only 251 -> 253: its engine
  held the most frames of the eight AND its output stood still ~0.15s at ~255 degrees. 18:22 (the perfect one) 270 -> 287:
  it held the fewest. That spread (+-0.1s, +-15 degrees) is what a fixed rule cannot take out.
- **The landing model (§4c) now counts every turn once per measured (ack, delay) pair** instead of the assumed delay: median
  271 / 270 / 273 at 0.8x / 1x / 1.3x, before 255 in 18-24% of turns, past 295 in 4-9%. On it the previous engine landed
  median ~255-258 with nearly half before 255 - the reports since 18:10 ("too fast", "a little before") were that bias.
- **THE RENDER'S LAG, MEASURED IN THE SESSION (`app.js`, recorder span, TEST sessions only):** the 2026-09-27 grid probe is
  back, passive - each sent and each rendered frame as a 24x14 luma grid, matched; `lag` events and a `lag-sum` per record.
  If it agrees with the clips, the session's own lag can time its return (the spread above). Nothing decides on it.
  `orient-link` §5. **Worker deploy** for the engine; the probe ships with the room.

### 2.37 One mirrored reading no longer pulls the back off (2026-10-08)
"Almost perfect - the back disappears too early, many frames with nothing on the back." The 07:31 record: the early BACK
went out at the side (|yaw| 84), then the pose model read the shopper's BACK as a full-width FRONT (+1.0, |yaw| 7 - a
mirrored skeleton) and the early BACK was WITHDRAWN on that one reading (the order said "front half", so ORDER_CONFIRMS
let it through); the clip, through the pose model, shows the back print gone at ~210 and a plain back to ~270. The next
reading was -0.52. Three rules, each only where the room measures the order (a room that sends none is main's exactly):
- **The two-reading withdrawal (`makeEarlyTurnTrigger`):** an early BACK is withdrawn by the order only on two such
  readings IN A ROW. A look that really came back reads the front again on the next one (`return-side` §1.15: it costs
  that look one reading, ~250ms).
- **ONE READING, ONE VOTE (`step()`, `poseStreak`):** the pose loop reads every ~240ms and the tick runs every 250ms, so one
  reading was voted twice and made a two-vote "pose flip" by itself; a vote on the reading the last one came from (the same
  `yawAt`) adds nothing.
- **THE BACK HALF CONFIRMS THE TURN:** the shoulders' vote abstained through that whole back (the separation never reached
  its margin), so the early BACK stayed "pending" and the return leg never armed; a new order reading at or past
  -ORDER_CONFIRMS ends it as a back vote would and arms the return there.
Replayed on its own clip (`return-side` §3f.6, `k-0731`): the front lands 209 -> ~308 - the back stays through the back
view; the return goes out on the first order reading past the side, which was 144ms old in a session whose engine put the
swap ~0.07s after the send. The other eight sessions and the landing model (§4c) are unchanged. **Worker deploy.**

### 2.38 The store's model painted out of the rear photo; FRONT_CLEAR for TEST sessions (2026-10-08, reworded 2026-10-09)
"Front and back work perfectly - don't touch it. Two small things: in the first measurement it just added the guy who
models the shirt, with his back to the camera, in the middle of the measurement (the second was fine); and it put a
necklace on me." Layer B and Layer A, each scoped so the turn timing and the front reference are untouched.
- **The model (Layer B).** Two PEAK sessions 40s apart; the first one's TEST record (`muzadbir`) shows the render-lag probe
  (§2.16) losing the camera for ~1.4s of the back view (1.76s / 1.43s / 2.0s on matches of 0.05-0.06; clean sessions read
  ~1.0-1.1s on 0.1-0.4), then a 0.37s stall until the FRONT landed - the output was the store's rear photo, a man with his
  back to the camera, not the shopper. The mechanism of 479cdfd and 30a7710 (§2.15), both reverted. Now: `GET
  /api/garment-box` (`lib/garment-box.js`, the classifier's model, one call per photo, cached in memory + CDN) answers the
  band to keep, collar to hem; the room (`referenceBackBand()` / `maskReferenceBand()`, inside `garmentBlobCached()`)
  PAINTS the photo above and below it with the photo's own backdrop - a MASK, not a crop: same size, the garment at the
  same place and scale - on the garment's DISTINCT REAR photo only. The front goes exactly as before. It abstains (the photo
  goes whole) on no person, an unsure/tiny box, a band that fills the photo, no answer in 3.5s, a heavy re-encode, or any
  failure; `?ref_mask=0` is off; a TEST record's `ctx.ref` says what was done. On the PEAK rear photo (by-eye box): 34%
  above the collar and 10% below the hem painted, 84 -> 67 KB. `garment-box` (a padding that keeps the head fails 3; a
  hint that matches the front fails 4). It ships in two steps - the endpoint first, so the band can be read on the
  real photo before the room relies on it. Intermittent, so one clean session does not prove it; a record whose lag
  stays ~1s through the back view does.
- **The necklace (Layer A) - TRIED AND REVERTED.** A gold chain with a pendant over the printed chest - 07:31 after the
  return, 11:41 from the first second, also 10-04 23:57 and faintly 10-05 18:10. Neither store photo has one, no prompt
  word names one, `enhance` is false, and the shopper's own shirt in a shorts session five minutes later has none: the
  engine adds it. `FRONT_CLEAR` ("Nothing is worn over the garment's collar or front." - no noun, the tuxedo rule) went
  out at P.LOW on the front of a top, from TEST sessions only (`clearFront`). The FIRST measured session (15:29, record
  `muzijj7m`, the preview) rendered the PEAK print on the shopper's OWN dark shirt from the first second - "it changed the
  shirt to the colour of the shirt I am wearing": "the garment" read as what the shopper wears and "nothing over it" as
  keep it. The front reference was the same 76 KB photo as before, so the sentence was the only change on the front.
  Reverted whole: `lib/prompts.js` and `lib/api-version.js` are byte-identical to before it again, the room asks for
  nothing, and `prompt-engine` §7 pins the absence. A sentence naming what the shopper WEARS is the same trap as naming
  a garment (the tuxedo): the engine draws toward it. The necklace stays open - any next attempt is measured first.
- **The necklace, second wording (2026-10-09) - TEST sessions only, measuring.** The next session without the sentence
  (15:43, record `muzj03pc`) had the chain again, a thin chain with a ring pendant, from the first second until the turn,
  then gone; the shirt was darker than the product until the turn as well (the shopper's own dark shirt showing through a
  start that has not converged - the turn regenerates the torso). Across the owner's PEAK clips the chain shows in 6 of 17
  sessions without the sentence (5 from the first second), in 0 of 2 with it: the sentence is the lever, its subject was
  the fault. `FRONT_CLEAR` is now **"Clean, unadorned neckline."** - the neckline itself, no garment, nothing worn, no
  object named; it holds for any top's neckline. Same P.LOW, same gate (`clearFront`, TEST sessions only - every shopper
  request byte-identical, `trace:prompt --json` identical to HEAD); the PEAK front is 533 chars with it (sheds at -2).
  `prompt-engine` §7 pins it and the first wording's trap (no garment / worn / nothing). If the colour moves again it
  comes off. `lib/api-version.js` regenerated - until a Worker deploy the room takes /size and /prompt from the origin.

### 2.39 The head out of frame - the side is counted, not read (2026-10-08)
"I measured the shorts and the front and back of the shorts got mixed up." The 11:45 session (TEST record `muzajx17`) was
framed from the neck down - the presence gate showed its step-back guide and timed out at 12s. The pose model tells front
from back by the face; without one it read the shopper's BACK as a full-width FRONT three readings in a row (order 0.87,
1.05, 1.19 - camera 1.97-2.49s), the early BACK was withdrawn on the two-reading rule (§2.37) and the FRONT sent at 2.23s
with the back to the camera; on the way round it read the front as a back (-0.56). Through the room's lite model the clip
itself reads -0.6 on a body square to the lens at its end; neither the nose (guessed on the frame's edge) nor the feet
(heel vs toe) tell the two apart there. What a headless reading still says truly is HOW FAR from the side it is.
- **The measurement (`headRoomStep()`, app.js, inside the torso-twist slice):** headroom = the shoulder line's height in the
  frame over the torso height. Ten recorded clips through the room's lite model: the nine with the head in view never go
  under 0.35 (10-04 05:55, the head touching the top edge); the shorts clip sits at 0.10-0.23 and climbs to 0.4-0.55 at the
  side views and its end with the head still out. So it is sticky: out after 2 readings under 0.30, in again after 3 over
  0.60. Learned in the presence gate too, so it is set before the reveal. The sample carries `headOut: true` (only when
  true); a TEST record carries `ho` per tick and a `head-frame` event on each change.
- **The decision (`headlessReading()`, lib/orient-engine.js, before `step()` and typeof-guarded in it):** for a headOut
  reading the side the body faces is COUNTED: it starts facing the lens, a pass through the side view (|order| <= 0.25 on a
  |yaw| of 45+, then out past 0.45) turns it over, and the reading goes on to every rule with that sign - the pose vote too;
  nothing that reads a head votes. A head-in reading keeps its sign and sets the count (a shopper who steps back). A look
  that comes back reads, headless, like a turn: a back that lasts HEADLESS_BACK_MAX_MS (2.5s - longer than the back of any
  recorded 360) with no side view is read as the front again, and that reading goes on as the side view (order 0), so the
  return rules send the FRONT on it (scripted: 2.75s after leaving the side, not ~5s).
- **Measured:** the record replayed (`head-frame` §3): as sent, BACK 1.72s then FRONT 2.23s (the report); headOut, the same
  BACK, no FRONT through the back, FRONT at the return's side view (2.69s, |order| 0.17, |yaw| 83), two swaps in all.
  Without the flag nothing changes (§5; `orient-engine` §1 on its pin). Mutations: the engine ignoring the flag fails 4;
  a 0.40 threshold marks a head-in clip and fails 2. **Worker deploy** (the engine).
- **Not covered:** a session whose head leaves the frame only mid-turn (no record of one), and the look rule on a real body.

### 2.40 The tick waits for the reading - the back on the reading that calls it, not a tick later (2026-10-09)
"The back wasn't right at the back, it took time to load." The 15:43 clip, frame by frame: a fast turn (the side to the back
in ~250ms); the side plain at 2.30-2.58s, an unformed patch at 2.61, the print complete only at 2.84 on a body already
square away. Its TEST record (`muzj03pc`): BACK went out on the reading at the side (order -0.17, ~100 degrees), where 19
of the owner's 33 recorded turns send it on one at ~52-69 (order 0.36-0.61). The reading between (shoulders at 39% of
square-on, ~67 degrees) landed just after its tick had sampled: every tick carried a reading ~200ms old (`oa` 190-215) -
the pose loop's 240ms timer and the tick's 250ms one at their worst phase, as in about a third of the 33 records - so BACK went out a
tick (~275ms) later. Not the engine's ack (480ms, as every session: the prime no longer makes the back's ack faster - 33
records, back 395-1259ms after a prime, front 398-743ms) and not the image size (the shorts' 313 KB acked in 588ms).
- **`awaitFreshPose()` / `notePoseStep()`** (app.js, beside POSE_SYNC): a tick whose latest reading is over
  `POSE_FOLLOW_STALE_MS` (100) old waits for the live loop's NEXT one (at most `POSE_FOLLOW_WAIT_MS`, 180) and resumes on a
  task of its own. No inference in the tick - POSE_SYNC (§2.21's laggy 2026-10-05 attempt) ran one there and cost 2-5 camera
  fps; this adds none. The same readings reach the engine in the same order, sooner; the engine, its rules and the Worker
  are untouched (no deploy). No live loop (before the reveal, the replay harnesses): no wait. `?pose_follow=0` is the
  free-running pair; `?pose_sync=1` keeps its own path.
- **Measured (`pose-follow` §3, the room's cadence on the 11 full recorded 360s x 4 loop phases x 5 tick phases):** the
  decision's reading age median 125ms / max 235 -> 1ms; BACK decided on the very same reading in every run, on the wire
  ~1ms after it instead of up to 235ms - on the body a median 10 degrees sooner (p90 23), never later; the return FRONT
  unmoved (291 vs 292 degrees, the projection already corrects age); no run swaps more. The landing itself (the engine's
  ~0.25s to form a new print) is the engine's. **Not measured live yet** - the next TEST session's `oa` should read under ~100.
  **Measured live 2026-10-09** (records `mv0o1l3b` shirt, `mv0o42ul` shorts): `oa` 2-52ms on every tick (was 190-215).

### 2.41 Each image its own pace; the picture's pace (2026-10-09)
"The shirt works well but it doesn't feel smooth - make it smoother; and the shorts went crazy at the end and went away at
the wrong time." Two TEST sessions on the preview (records `mv0o1l3b` PEAK, `mv0o42ul` basketball shorts, clip 10:53).
- **The shorts' return (`engineAckEstimate(key)`, app.js THE ENGINE'S PACE):** the FRONT went out on the projection at a pace
  of 592ms - the session's median, pulled down by the BACK's ack (597ms, 222 KB) - and took 721ms (316 KB), as its own sends
  at connect had (684-709). It landed ~130ms late: the rear photo's shorts on a body coming round (~314 degrees for a 280
  aim) - the distorted frames at 3.96-4.03s of the clip, CHICAGO only at 4.06. Acks are now kept per reference side
  (`applyGarment` passes `paceKey`, its frozen angle) and the tick sends the pace of the image the NEXT swap sends (the front
  on the back leg); an image with none yet falls back to the session's. Replayed on the record: the FRONT goes out at 2.87-2.91s
  instead of 3.00. On the PEAK tee (76 vs 70 KB, the same acks) nothing moves. Browser only - the engine reads `lat` as before.
  `return-side` §5.8-§5.9d.
- **The picture (`PLAYOUT_DELAY_HINT` 0.08 -> 0.15, config.js):** every presented frame of the owner's clips: the ~10 fps
  render arrives in bursts - two frames 25-45ms apart, then 170-230ms (p90 140-170) - 10 fps on average, 5 in the gaps; and
  one 0.5s output stall in the shirt session. 80ms held back less than one gap; 150ms holds the p90 one, at ~70ms more between
  the camera and the screen (where a swap lands on the BODY is the engine's camera time and does not move). The top of the
  range `image-first` pins.
- **THE PACE OF THE PICTURE (app.js, TEST sessions only):** which of four places makes the bursts decides whether the buffer
  can absorb them - our camera frames (the throttle's setInterval shares the main thread with the pose model), the engine's
  spacing (RTP timestamps), the network (arrival), or the screen. `out-stats.pace` = { in, rtp, recv, show } as [p10, p50,
  p90, max] ms, plus `jb` (the buffer). Bursty `in` -> fix our input pacing; bursty `rtp` with even `in` -> the engine's;
  even `rtp`, bursty `recv` -> the network, which the buffer is for. `picture-pace` (14).
- **Not measured live yet:** both. The next TEST session's `out-stats.pace` and its return landing are the check.

---

## 3. Cross-file lockstep

These have **no shared module system**. Copies must be edited together, in the
same commit. Whichever is wrong is the one that wins.

| Logic | Copies |
|---|---|
| URL canonicalisation | `pear-widget.js: canonicalPhoto` ↔ `app.js: canonicalImageUrl` |
| CDN size-suffix strip | `pear-widget.js: upgradeImageUrl` ↔ `app.js: canonicalImageUrl` |
| Composite layout (front left, back right, labels below panels) | `pear-widget.js: createGarmentComposite` ↔ `app.js: createGarmentComposite` |
| Backdrop sampling | `pear-widget.js: sampleBackdrop` ↔ `app.js: sampleBackdrop` |
| Garment title → category, incl. `FABRIC_AMBIGUOUS` | `pear-widget.js: detectCategory` ↔ `app.js: classifyGarmentTitle` |
| Resizer detection | `RESIZER_RE` in both |
| CDN transform in the **path** (`/images/w_1880,f_auto,q_auto/…`) | `pear-widget.js: upgradeImageUrl` ↔ `app.js` ↔ `server.js` ↔ `scan-store.js: canonicalImageUrl` — **four** copies |
| `srcset` parsing (split on whitespace, never on `,`) | `pear-widget.js: largestFromSrcset` ↔ `scan-store.js: largestFromSrcset` |
| Decorative-image keyword list | `pear-widget.js: EXCLUDE_SRC` ↔ `scan-store.js: EXCLUDE_IMG_SRC` |
| Trust-tiered exclusion + name corroboration | `isExcludedSrc` / `nameEchoesProduct` in `pear-widget.js` ↔ `scan-store.js` |
| Raw size-chart wire (`raw;` + candidate tables, U+001C–U+001F separators) | `pear-widget.js: encodeRawSizeChart` ↔ `lib/sizing.js: decodeRawSizeChart` (`size-chart-overlay` §4 round-trips it) |
| Size-chart sanity clamps (cm) | `lib/sizing.js: SIZE_CHART_CLAMPS` (the reader, per column) ↔ `lib/sizing.js: STORE_CHART_CLAMPS` (the overlay) ↔ `lib/store-size-charts.js: STORE_CHART_CLAMPS` (stored charts, re-applied per read) ↔ `scanner/size-chart-reader.src.js: SIZE_CHART_CLAMPS` (the scanner's reader) |
| Size-token plausibility (`isPlausibleSizeToken`, `SIZE_TOKEN_ALPHA_RE`) | `pear-widget.js` (the size-list scrape; copied into the generated scanner parser) ↔ `lib/sizing.js` (the chart reader) |
| Store host key (`store_size_charts.store_domain`) | `canonicalStoreHost` in `pear-widget.js` ↔ `app.js` ↔ `lib/store-size-charts.js` ↔ `scanner/size-charts.js` — **four** copies |
| Size-guide reader, two runtimes | `lib/sizing.js`'s grid reader (the live widget chart) ↔ `scanner/size-chart-reader.src.js` → **generated** `scanner/size-chart-parser.js` (stored charts; `npm run sync:size-chart-parser`) - `size-chart-parser-sync` §3 runs one fixture set through both |
| Centimetre/inch unit regexes (`SIZE_CHART_CM_RE`, `SIZE_CHART_IN_RE`, `SIZE_CHART_DECLARED_IN_RE`) | `pear-widget.js` (caption tier + the inches/cm twin) ↔ `scanner/size-chart-reader.src.js` ↔ `lib/sizing.js` (cell/header tier) - `size-chart-shared-fixes` §0 |
| The page's grid finder (`sizeChartGrid` incl. ARIA div-grids, `sizeChartTables` twin collapse, `sizeChartIsGridEl`) | `pear-widget.js` (the live collector) ↔ `scanner/size-chart-reader.src.js` (the scanner) - `size-chart-shared-fixes` §0 asserts the same text |
| Garment region classifier (`isBottomsGarment`, `BOTTOMS_TOKENS`, `TOPS_TOKENS`) | `app.js` ↔ `lib/prompts.js` (server copy honours the browser's verdict; asserted identical by `prompt-engine` §2) |
| Orientation knobs the browser forwards vs the knobs the engine reads | `app.js: ORIENT_KNOB_KEYS` ↔ `lib/orient-engine.js: ORIENT_KNOB_KEYS` (`orient-engine` §2) |
| Orientation values both halves need | `ORIENT_YAW_FRESH_MS`, `PRESENCE_PROMPT_YAW_SUPPRESS_DEG`, `ORIENT_EARLY_TURN_DEFAULT_SPEED` and the `?early_turn_speed` parse (`ORIENT_EARLY_TURN_MIN_SPEED`) in `app.js` (the pose loop, the presence prompt) ↔ `lib/orient-engine.js` (`orient-engine` §2) |
| Prompt facts the browser sends vs the fields the engine accepts | `app.js: PROMPT_FACT_STRINGS / PROMPT_FACT_BOOLS` ↔ `lib/prompts.js: PROMPT_ITEM_STRINGS / PROMPT_ITEM_BOOLS` (`prompt-engine` §3) |
| Apostrophe/geresh fold | `pear-widget.js: normApos` ↔ `app.js: _normApos` ↔ `lib/sizing.js: _normApos` — **three** copies (`numeric-pants-sizing` §7 runs all three) |
| Size tokens (`parseSizeList`, `ADULT_ALPHA_SIZES`) | `app.js` (ladders, `categoryFromSizeRun`) ↔ `lib/sizing.js` (the product rules) |
| Lower-body vocabulary | `lib/sizing.js: PANTS_TITLE_STEMS_HE / PANTS_TITLE_WORDS_EN / PANTS_EXPLICIT_TYPES` ↔ `app.js: GARMENT_CATEGORY_KEYWORDS.bottom / BOTTOMS_TOKENS / EXPLICIT_BOTTOM_TYPES` — a word added to one side only is a miss on the other path |
| Size product evidence the browser sends vs the fields the rules accept | `app.js: sizeProductEvidence` ↔ `lib/sizing.js: sanitizeProductEvidence` (`size-fit-pin` §3) |
| Size ladders (labels only) vs the charts they index | `app.js: CHILD_SIZE_SCALE / ADULT_PANTS_NUMERIC_SIZES / ADULT_JEANS_WAIST_SIZES` ↔ `lib/sizing.js: CHILD_SIZE_CHART / ADULT_PANTS_SIZE_CHART / ADULT_JEANS_WAIST_CHART` (asserted by `numeric-pants-sizing` §5) |

The widget's category verdict is **explicit** and therefore outranks the room's
own classifier. A widget-side category bug cannot be fixed room-side.

**The size-guide parser is the one lockstep pair that is generated, not hand-kept.**
Edit the widget's `@pear-shared:size-token` block or `scanner/size-chart-reader.src.js`
(the reader left the widget with the code hiding, §2.12 - the widget only collects tables
now), then run `npm run sync:size-chart-parser`; never edit `scanner/size-chart-parser.js`
by hand. `test/size-chart-parser-sync.test.mjs` fails on a single-byte difference and runs
one fixture set through the live path (the real widget + `lib/sizing.js`) and the scanner's.
The blocks must stay self-contained (only `d` and `console` are free) — the §2.6 rule, since
the scanner copy runs with nothing around it. The three clamp copies and
the four `canonicalStoreHost` copies are compared by value in
`test/store-size-chart-api.test.mjs`.

**`isExcludedSrc` is trust-tiered — a keyword is the weakest signal, not a veto.**
SVG is refused at every tier (Gemini cannot classify a vector). An image the store
*declared* as the product — JSON-LD `Product.image`, its own product API, the theme's
gallery selectors, `itemprop="image"` — skips the keyword list entirely; pass
`{ declared: true }`. Everything else passes `{ name: productNameHint() }`, where a
token the product's own name explains **and** whose filename echoes that name is
forgiven. A bare one-argument call is the old blanket behaviour and is correct only for
genuinely untrusted URLs. Never widen `EXCLUDE_SRC` to "fix" a false positive — that is
what refused adidas's "Icon" line and every `logo-tee.jpg` in the industry.
It also stays IN THE WIDGET: moving it server-side was measured on 2026-09-26 and opened
the room on a badge / logo / banner with the real photo never sent — several widget paths
choose a single image, and the server cannot repair a choice it never sees (see the note
above `isExcludedSrc` in `pear-widget.js`).

**`canonicalImageUrl` has FOUR copies, not two** — `app.js`, `server.js`,
`scanner/scan-store.js` and (as `canonicalPhoto`) `pear-widget.js`. They are the
cache key for `garment_cache` as well as the front/back identity test, so a copy
that drifts writes duplicate rows that then disagree about front vs back.
`archive/supabase_setup_v9.sql: pear_canonical_url()` is a **fifth, historical**
copy: it is a one-time backfill script, it already predates the SFCC
`sw/sh/sm/sfrm/bgcolor` params and the path-transform strip, and it is not on any
runtime path (the key is computed in JS and passed to Supabase). Do not treat it as
live — but if you ever re-run that backfill, port the current rules first.

---

## 4. Commands

```bash
npm run test:unit        # .test.mjs suite  — the regression guardrail (alias: npm test)
npm run trace:prompt     # prints every string that actually reaches Decart (traces lib/prompts.js)
npm start                # the server (node server.js); npm run dev for --watch
npm run scan             # scanner/scan-store.js over a storefront

npm run qa:visual        # the visual gate: drive a 360 + swap, then score the frames
npm run test:visual      #   …just the agent  (npx playwright test test/e2e/visual-agent.spec.mjs)
npm run inspect:visuals  #   …just the scoring (node scripts/inspect-visuals.mjs)
npm run fixtures         # regenerate test/fixtures/ (generated, gitignored, --force to rebuild)

npm run build            # dist/ — the minified client production serves (§2.11)
npm run qa:visual:dist   # the visual gate against the MINIFIED room (build --qa → dist-qa/)
PEAR_SERVE_DIST=1 npm start   # run the server the way production does, after npm run build
(cd cloudflare/orient && npx wrangler dev)   # the orientation Worker locally (README there; §2.14)
npm run sync:size-chart-parser            # regenerate scanner/size-chart-parser.js (widget token block + scanner/size-chart-reader.src.js)
npm run build:edge-assets                 # the pose model's scrambled binaries for the edge + lib/edge-assets.json (§2.24); then wrangler deploy
npm run scan:size-charts -- <store-url>   # size-guide DRY RUN: coverage report, no keys, writes nothing
node scanner/scan-store.js --size-charts --save <store-url>   # capture into store_size_charts (needs v15 + Supabase env)
```

`test:api` still **does not exist** in `package.json` — there is no API-health
script. Don't re-add that dead line; if you want a real API target, add the script
first.

**`test:e2e` is also deliberately still absent, and that is not an oversight.** The
browser suite is `test:visual`, under a different name on purpose: `.husky/pre-commit`
stage 4 turns blocking the moment a script called `test:e2e` exists, and a 30-second
Chromium run on *every commit* is how a mandatory check gets commented out. The visual
suite runs once per **push** instead — see §8. If you ever do want it on every commit,
rename it knowingly rather than by accident.

The widget is exercised from inside `test:unit`: `widget-dom`, `widget-combined`,
`stock-dom-scrape` and `size-chart-scrape` load `pear-widget.js` into jsdom and
drive a real injection + modal open.

`npm run trace:prompt` before and after any Layer-A edit. If the output is
byte-identical, the edit changed nothing on the wire — say so.

---

## 5. Definition of done for a fit/back-view change

- [ ] Layer (A/B/C/D) stated
- [ ] If Layer A: `trace:prompt` output differs, and the char total is quoted
- [ ] `npm run test:unit` green
- [ ] Cross-file copies from §3 updated together, if touched
- [ ] Any restored clause is **one** clause
- [ ] The comment block above the edited function is updated to record *why* —
      that block is the only record of what already failed

---

## 6. Style

- Never delete a "THE BUG THIS CLOSES" / "THE ROOT CAUSE" comment. Update it.
- Prefer abstaining over guessing. An unconfident verdict must not outrank a
  downstream classifier.
- `console.log("[PEAR] ...")` is the debugging contract with live merchants; keep
  the prefix and keep messages findable. The production build strips log/warn/group
  lines, so on a live store that contract is served by the support view (§2.11).
- Never log a raw `data:` URL — use `abbrevImg()` / `abbrevUrl()`.

---

## 7. Self-check before reporting anything done

Do this yourself, unprompted, every time — not only at commit time:

- touched app.js in a way that could affect rendering (Layer A/B/C per §1)?
  run `npm run trace:prompt` yourself and read the reachability audit before
  telling me the change is done. If the branch you edited is still marked
  DEAD, say so instead of reporting success.
- touched anything covered by test/run.mjs? run `npm run test:unit` yourself
  before reporting done. Don't wait for the git hook to catch it.
- touched pear-widget.js or app.js copies listed in §3? check the other
  file's copy yourself and flag it if it's now out of sync, even if I didn't
  ask you to look.
- touched anything that changes what the shopper SEES — the reference that
  reaches the wire (Layer B), the orientation that selects it (Layer C), the
  reveal gate, any overlay over `#aiVideo`, the recorder? run
  `npm run qa:visual` yourself and read the findings. §8 is the full protocol.

If any of these come back red, say so plainly and stop — don't fix it by
silently loosening the check.

---

## 8. MANDATORY PRE-PUSH VISUAL QA PROTOCOL

Before executing any `git push`, run this loop to completion:

1. **CODE MODIFICATION.** Apply the requested changes to `fitting-room/app.js` or
   related modules.
2. **SYNTAX & UNIT CHECKS.** `node --check fitting-room/app.js` and
   `npm run test:unit`.
3. **VISUAL QA EXECUTION.** `npx playwright test test/e2e/visual-agent.spec.mjs`
   (alias `npm run test:visual`), then `node scripts/inspect-visuals.mjs`
   (alias `npm run inspect:visuals`). `npm run qa:visual` runs both.
4. **SELF-HEALING LOOP.** If the visual check fails:
   a. Open the frames in `test-results/visual/` — *look at them* before anything else.
   b. Diagnose the root cause and fix the code.
   c. Re-run steps 2–3.
   d. Repeat until every visual check passes.
5. **DEPLOYMENT GATE.** Commit and push only once unit tests **and** visual
   inspection are green.

`.husky/pre-push` enforces steps 2–3 mechanically. `PEAR_SKIP_VISUAL=1 git push`
is the documented escape hatch; it announces itself loudly, and a push that used
it has **not** been visually verified — say so.

### 8.1 What the loop actually runs, and why it is free

| Piece | File | Job |
|---|---|---|
| Mock Decart | `fitting-room/app.js` (`?mock_decart=1`) | replaces `loadSDK()` and `mintEphemeralToken()` — no ek_ token, no WebRTC, no billing |
| Mock pose sensor | same block, same flag | replaces the PoseLandmarker with a scripted skeleton, so a 360 is drivable |
| Fake camera | `test/e2e/fixtures.mjs` → `user-turn-360.y4m` | Chromium's `--use-file-for-fake-video-capture` |
| Agent | `test/e2e/visual-agent.spec.mjs` | drives the funnel, turns the shopper, captures 14 frames + `meta.json` |
| Harness server | `test/e2e/static-server.mjs` | static repo + 3 stub routes; **counts** hits on `/api/realtime-token` |
| Inspector | `scripts/inspect-visuals.mjs` | scores the PNG bytes; the only thing that passes or fails |

Cost is enforced, not assumed: `?mock_decart=1` short-circuits **above** the token
mint, and the last assertion in the spec is that `/api/realtime-token` was hit
zero times. If that count is ever non-zero, the run was not free and the mock seam
is broken — fix that before anything else.

Fixtures are **generated** (`npm run fixtures`) and gitignored. A fresh clone needs
`npm install && npx playwright install chromium`; nothing else.

**The run is hermetic — every off-origin request is aborted, and that is load-bearing.**
The suite ran green in ~24 s a dozen times, then began taking 8+ minutes and timing out,
at 2 % CPU: blocked on I/O start to finish. The room reaches four public hosts on the way
into a session — `fonts.googleapis.com` and three chained geo-IP lookups
(`get.geojs.io`, `ipapi.co`, `ipwho.is`) — and once those start answering 429 or hanging,
the fallback chain multiplies the stall. None of it is the code under test, and a
mandatory gate that fails for reasons the committer did not cause is a gate that gets
skipped. The spec now routes everything except its own origin to `abort()` and records
the blocked hosts in `meta.json`. **Never "fix" a slow run by raising the timeout —
check `blockedHosts` first.** If a change ever makes an external asset genuinely
required, that list is where it will show up.

### 8.2 The four checks, and the report each one closes

| Finding | Means | Rule |
|---|---|---|
| `plain-shirt-gap` | the torso patch is a flat fill — no print reached the garment | §2.1 |
| `missing-back-print` | the 180° frame carries the **front** photo | §2.1 / §2.2 |
| `white-flash` | a near-uniform bright frame — an overlay pinned over the live feed | §2.9 |
| `frozen-feed` | consecutive frames are identical — the output stopped presenting | §2.9 |
| `front-not-restored` | after a full 360 the back asset is still on the shopper's chest | §2.3 |
| `cost` | the run reached `/api/realtime-token` | §8.1 |

**The inspector is calibrated against its own fixtures and must be able to fail.**
`npm run inspect:visuals -- --self-test` proves the thresholds separate a printed
garment from a plain one and a front photo from a back one. Two end-to-end negative
controls exist and both were verified to fire:

```bash
PEAR_VISUAL_FRONT=plain.png npm run test:visual && npm run inspect:visuals
#   → plain-shirt-gap on 00-front and 03-return-front, nothing else

PEAR_VISUAL_BACK=front-mislabelled-as-back.png npm run test:visual && npm run inspect:visuals
#   → missing-back-print on 02-back
```

The second one is worth understanding before trusting a green run: the two wire
keys **differ** (they are genuinely different files), so a byte comparison passes —
and the frame still shows the front print on the shopper's back. That gap is the
entire reason this gate looks at pixels.

### 8.3 Reading a red run — do this before touching a threshold

`npm run inspect:visuals -- --verbose` prints every measurement, passes included.
Move a threshold only with the distribution in front of you, and only after looking
at the frames. **A threshold loosened to go green is the same sin as deleting a
regression assertion (§4, `.husky/pre-commit`).** Record why in the comment block
above `T` in `scripts/inspect-visuals.mjs`.

If the *agent* fails rather than the inspector, it is usually the room refusing to
go live, not a rendering fault. The timeout message prints the wire state at the
moment it gave up: connection state, dispatch count, the current prompt (trimmed),
the image key, the pose angle, and the camera-card classes.

### 8.4 What this harness does NOT prove — state these limits, don't overclaim

- **It does not evaluate Decart's output.** The mock paints the reference that is
  *on the wire* into the torso rect; it does not render a garment. So the gate
  answers "which asset and which prompt are live, and what did the page composite
  over them" — never "does the try-on look good". A green run says nothing about
  drape, fit or realism.
- **Orientation is scripted.** The pose sensor is replaced, so MediaPipe's real
  reading of a real body is untested here. What *is* tested is everything
  downstream of the sensor: the yaw window, the anti-flap lock, `maybeSwap()`,
  `applyActive()` and the dispatch. `?mock_pose_gap=<deg>` reproduces the real
  detector's edge-on dropout when you want that path exercised.
- **The billed window is widened.** `?mock_live_ms=` (mock only — see
  `liveWindowMs()`) lifts the 5 s `LIVE_DURATION_MS` cap so the agent can
  photograph a turn instead of racing it. The turn still runs at a realistic
  72–90 °/s. The countdown UI is deliberately left un-rescaled, so it reads 0 while
  a mocked session continues — a visible artifact, kept visible on purpose.
- **Layer A is still out of scope.** Prompt text reaching the wire is
  `trace:prompt`'s job (§0, RULE 0), not this gate's.

### 8.5 KNOWN LIMITATION — the agent is not yet reliable enough to be a hard gate

**State as of 2026-09-18: the gate is not yet reliable enough to be trusted as a hard
blocker.** Measured over repeated back-to-back batches it passes roughly half to
five-sixths of runs; the last clean batch of six was 3 pass / 2 agent stall / 1 inspector
red on a session that looked healthy. Read that honestly before trusting
`.husky/pre-push`:

- **It fails CLOSED, always.** Every observed failure is the agent giving up on a wait or
  a capture, or the inspector rejecting frames — never a bad render scored as good. A
  flaky run blocks a push; it does not wave one through. The direction is the safe one.
- **The inspector is deterministic on a GIVEN set of frames** — its self-test and both
  negative controls reproduce exactly — but it has been seen to report `frozen-feed` on a
  completed run, which on inspection was a capture artifact rather than a real freeze. So
  a red inspector is strong evidence, not yet proof. Look at the frames.
- **A red gate is therefore not automatically a code problem.** Read the `[PEAR]`
  transcript the failure prints. If it ends inside the room's go-live sequence rather than
  on a finding, it is the harness.

Until this is fixed, `PEAR_SKIP_VISUAL=1 git push` is a legitimate move — **and it must be
stated in the PR**, because the visual checks genuinely did not run.

**What has already been ruled out**, so nobody re-treads it:

| Tried | Result |
|---|---|
| Blocking off-origin requests | Real fix — the room chains 3 geo-IP lookups + fonts, which hung for minutes once rate-limited |
| `--disable-renderer-backgrounding` etc. | Real fix — headless counts as occluded and every loop on the page throttles together |
| `--disable-gpu` / software compositing | Real fix — GPU compositing returned *stale* video frames, so healthy sessions read as `frozen-feed` |
| Not awaiting `src.play()` in the mock | Real fix — `play()` on an off-screen element can never settle, parking `connectRealtime()` forever |
| `animations: "disabled"` on the screenshot | **Reverted** — it freezes the video too, and blinded `frozen-feed` entirely (§8.6) |
| `channel: "chromium"` | Kept, but it is *not* sufficient on its own |
| Raising the reveal wait to 90s | Helped, did not eliminate |

**The most likely remaining cause** is the reveal gate: `armFirstFrameBilling()` verifies a
frame as genuinely AI-rendered before revealing, by watching real frames over real time,
and under headless that verification is slow and variable. The next thing to try is
instrumenting *that* function rather than widening another timeout — every timeout
widening so far has moved the failure rather than removed it.

### 8.6 Do not "improve" these

- **The mock must never paint a near-white or near-uniform frame.** That is what
  makes `white-flash` decidable: any such frame in a capture came from the app's
  own overlay layer, never from the mock.
- **The beacon must alternate every rendered frame.** It is the only evidence that
  can distinguish a frozen feed from a still scene.
- **Never add a test-only shortcut past `applyGarment` / the OrientationWatcher.**
  The mock replaces *sensors and transports* — the camera, the SDK, the pose model.
  Everything that decides what the shopper sees is the shipped code, deliberately.
  A harness that forced `autoOrientation` would pass while the turn was broken.
- **The reveal wait is load-bearing.** The spec waits for `.show-live` + the scan
  overlay coming down before it captures. The first cut of it did not, photographed
  the loading scrim, and every pixel check passed on an animation. Never remove it.

---

## 9. Status tracking — at the end of EVERY task

`docs/STATUS.md` is the living project status: one entry per workstream with its
stage (not started / in progress / done / blocked), what is done (with commit hashes),
what remains, open decisions, and the manual steps waiting on the owner (migrations,
env vars, scanner runs).

At the end of every task, without being asked:

1. **Update `docs/STATUS.md`** — the stage and hashes of every workstream the task
   touched, the "Waiting on you" checklist, and the branch table if branches moved.
   Commit it with the task (or as the task's last commit).
2. **End the final report with a short `Status` section:** where this workstream stands
   (start / middle / end), what was done this time, what remains, and what is waiting on
   the owner.

A task that changed nothing still gets the `Status` section; a status file that lags the
code is how a finished migration gets run twice or a pending one gets forgotten.
