# Kids/Adult size category guard

## Problem
Nothing currently stops an adult shopper from launching a live try-on session
on a kids-only garment. The size calculator (`calculateSize()`) already
excludes cross-category matches when *recommending* a size, but a shopper who
already has an adult size resolved (`currentSizeCategory === "adult"`) can
still hit "Go Live" on a garment `resolvedGarmentAgeGroup()` reports as
`"kids"`, since nothing reads that combination before `goLive()` opens a
billed session.

## Data source decision
The spec described deriving product category from a raw `item.sizes` /
Shopify variant-options list. This codebase has no such ingestion today —
category already flows through `activeItem.ageGroup` (kids/adult/uncertain,
resolved server-side) and the shopper's own `currentSizeCategory`
(adult/child, from the height/weight calculator in `calculateSize()`). The
guard reuses that existing, already-trusted state instead of adding new
DOM/payload scraping. Raw size-list ingestion is out of scope here and can be
a separate feature later if a host page needs it.

## Functions (`fitting-room/app.js`, near `resolvedGarmentAgeGroup()`)
- `isKidsProduct(item)` — `true` iff the item's resolved age group
  (`item.ageGroup` for a passed item, falling back to
  `resolvedGarmentAgeGroup()`'s own inputs for the current `activeItem`) is
  confidently `"kids"`. Uncertain/unset is NOT kids (fail open, matching
  every other gate in this file).
- `isCompatibleSizeCategory(userCategory, item)` — `false` only when
  `isKidsProduct(item)` is true AND `userCategory === "adult"`. All other
  combinations (uncertain garment, child user, no user category yet) return
  `true`.
- `sizeCategoryMismatchReason()` — the go-live gate. Returns the localized
  message when `!isCompatibleSizeCategory(currentSizeCategory, activeItem)`,
  else `null`. Mirrors `liveBlockReason()` / `livePendingReason()`.

## Wiring
`goLive()` calls `sizeCategoryMismatchReason()` immediately after the
existing `blockReason` / `pendingReason` checks, before any camera/token/
billing work. On a hit: `showCamError(msg)` + `toast(...)` + `return` (no
session opened, no credits spent) — the same shape as the black-screen and
asset-load gates already in `goLive()`.

## Messaging
New `i18n.js` key pair, `sizeCategoryMismatchKids`:
- he: `"הפריט אינו בטווח המידות שלך (מידת ילדים)"`
- en: `"This item is not within your size range (Kids item)"`

## Config
No new `CONFIG` flag, no default-off ship. Unlike the lower-body pixel guard
(a geometric *guess*), this is deterministic category logic built on state
(`ageGroup`, `currentSizeCategory`) the app already trusts elsewhere
(`calculateSize()`'s own kids/adult exclusion). Ships on by default.

## Tests
New `test/kids-adult-size-guard.test.mjs` (registered in `test/run.mjs`),
function-extraction style matching the rest of the suite:
- adult `L` profile blocked on a kids-only item.
- adult profile allowed on an adult (`S`-`XL`) item.
- uncertain-category item never blocks.
- child-profile user never blocked by a kids item.
- `goLive()` wiring: the new gate is called in the right place, before token
  mint / camera / billing.

## Versioning
Bump the `app.js?v=` cache-buster in `fitting-room/index.html`.

## Not doing
- Not pushing to `main` without explicit confirmation.
- Not adding Shopify variant-option scraping.
