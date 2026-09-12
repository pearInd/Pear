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
| **D. Size ladder** | the recommended size in the UI | `calculateSize`, `SIZE_SCALE`, `*_SIZE_CHART` | live in UI, **and live on the wire** (restored 2026-09-03, see §0) |

**Layer B is where most real fit/back-view problems actually live.** "The back
came out plain" is almost never a prompt problem — it is `distinctBackOf()`
returning `undefined`. Run `window.__pearDebugBackView()` in a live session; it
returns one of five `BACK_VIEW_REASON` values and tells you which.

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

### 2.6 Extract markers are an interface
Several tests slice a block out of `app.js` by matching its **opening line as a
literal string**, taking the **first occurrence in the file**, and executing it
in a sandbox. Affected blocks: `setActiveItem`'s slot write
(`outfit-slot-isolation`), the presence gate (`body-presence-gate`),
`applyGarment` (`prompt-only-flip`, `side-profile`).

- Do not introduce an identically-shaped statement **or a comment quoting the
  marker** above a marked block. Both steal the match.
- If you must move a marked block, update the matching `.test.mjs` in the same commit.

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

The widget's category verdict is **explicit** and therefore outranks the room's
own classifier. A widget-side category bug cannot be fixed room-side.

---

## 4. Commands

```bash
npm run test:unit      # .test.mjs suite  — the regression guardrail
npm run test:api       # /api/classify-images health
npm run test:e2e       # widget injection + modal, headless Chrome
npm run trace:prompt   # prints every string that actually reaches Decart
```

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

If any of these come back red, say so plainly and stop — don't fix it by
silently loosening the check.
