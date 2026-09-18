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
| **A. Prompt text** | what the model is told | `imageOnlyPrompt`, `*_ANCHOR`, `DENSE` | mostly dead |
| **B. Reference image** | what the model is shown | `referenceImageFor`, `galleryOf`, `distinctBackOf`, `createGarmentComposite` | **live** |
| **C. Orientation** | which asset is on the wire when | `OrientationWatcher`, `effectiveAngle`, `autoOrientation` | **live** |
| **D. Size ladder** | the recommended size in the UI | `calculateSize`, `SIZE_SCALE`, `*_SIZE_CHART`, `applyStoreChartOverlay` | live in UI, **and live on the wire** (restored 2026-09-03, see §0) |

**Layer B is where most real fit/back-view problems actually live.** "The back
came out plain" is almost never a prompt problem — it is `distinctBackOf()`
returning `undefined`. Run `window.__pearDebugBackView()` in a live session; it
returns one of five `BACK_VIEW_REASON` values and tells you which.

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
`isKidsProduct` / `isAdultProduct` / `isCompatibleSizeCategory` /
`liveBlockReason` all pass when uncertain. A wrong block stops a paying shopper.
`DEFAULT_CATEGORY = "unknown"`, never `"tops"` — a guess indistinguishable from
a verdict outranks the room's own stronger classifier.

### 2.5b A storefront's size chart may refine the fine-tune, never the kernel
`calculateSize()` has two stages. The **kernel** is height + weight, scored by
`coreHwPenalty()`, and it decides which rows are candidates at all,
`currentBodyCategory`/`currentSizeCategory` (and so the kids/adult go-live guard),
and the overflow ceiling behind "no size available". The **fine-tune** is the
`×0.5` chest/waist/legs pass that only breaks a tie *between* rows the kernel
already admitted.

`applyStoreChartOverlay()` writes fine-tune columns and nothing else — it does not
name `min/maxHeight` or `min/maxWeight` anywhere, and it may only *change* a band
the base row already carries, never add or remove one. That bound is the whole
reason parsing a merchant's HTML is an acceptable input to the size calculator: a
bad scrape can at worst move the recommendation between two sizes that already fit
this body, and only for a shopper who filled in an optional measurement. It cannot
invent a candidate, remove one, flip adult↔child, or turn a match into a no-match.

Do not widen it to the kernel "so the store's chart really counts". The store's
chart is evidence about **cloth**; ours is vetted evidence about **bodies**, and
the kernel is the half we vetted. `test/size-chart-overlay.test.mjs` §1 asserts
this as an absence — the form that catches a new well-meant line being added.

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
`calculateSize()`'s fine-tune tie-break is the newest one: `size-chart-overlay` slices
`app.js` from `const candidates = currentSizeCategory === "child" ? childFits : adultFits;`
to `// SNAP TO THE PRODUCT'S OWN LIST.` and runs that loop standalone, so it scores the
real penalty formula rather than a copy of it.

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

**This one is now checked automatically.** `npm run qa:visual` (§8) captures a burst of
consecutive frames through a turn and fails on `frozen-feed` (two identical frames) or
`white-flash` (a near-uniform bright frame — i.e. an overlay pinned over the feed). If you
are restoring `?swap_hold=1` / `?still_covers=1` for an A/B, expect those findings: they
are the gate correctly reporting what those flags do.

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
| Size-chart wire format (`<unit>;<source>;SIZE:chest:waist:hips:legs\|…`) | `pear-widget.js: encodeSizeChart` ↔ `app.js: parseStoreSizeChart` |
| Size-chart sanity clamps (cm) | `pear-widget.js: SIZE_CHART_CLAMPS` ↔ `app.js: STORE_CHART_CLAMPS` |

The widget's category verdict is **explicit** and therefore outranks the room's
own classifier. A widget-side category bug cannot be fixed room-side.

**`isExcludedSrc` is trust-tiered — a keyword is the weakest signal, not a veto.**
SVG is refused at every tier (Gemini cannot classify a vector). An image the store
*declared* as the product — JSON-LD `Product.image`, its own product API, the theme's
gallery selectors, `itemprop="image"` — skips the keyword list entirely; pass
`{ declared: true }`. Everything else passes `{ name: productNameHint() }`, where a
token the product's own name explains **and** whose filename echoes that name is
forgiven. A bare one-argument call is the old blanket behaviour and is correct only for
genuinely untrusted URLs. Never widen `EXCLUDE_SRC` to "fix" a false positive — that is
what refused adidas's "Icon" line and every `logo-tee.jpg` in the industry.

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
npm run trace:prompt     # prints every string that actually reaches Decart
npm start                # the server (node server.js); npm run dev for --watch
npm run scan             # scanner/scan-store.js over a storefront

npm run qa:visual        # the visual gate: drive a 360 + swap, then score the frames
npm run test:visual      #   …just the agent  (npx playwright test test/e2e/visual-agent.spec.mjs)
npm run inspect:visuals  #   …just the scoring (node scripts/inspect-visuals.mjs)
npm run fixtures         # regenerate test/fixtures/ (generated, gitignored, --force to rebuild)
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
  the prefix and keep messages findable.
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
