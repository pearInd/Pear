# Storefront size-chart scraper & engine overlay (Task 2)

## Layer (CLAUDE.md §1)

**Layer D — the size ladder.** Nothing here touches a prompt string, a reference
image, or an orientation. No Layer-A edit, so `trace:prompt` is expected to be
byte-identical before and after; that is the *correct* result here, not a
failure. (Layer D is live on the wire since 2026-09-03 via `fitSentence()`, so a
changed recommendation *can* change the render — but only through the size the
shopper ends up on, never through new text.)

## Problem

`calculateSize()` fits every shopper against ONE hardcoded global matrix
(`ZARA_SIZE_CHART` for letters, `ADULT_PANTS_SIZE_CHART` /
`ADULT_JEANS_WAIST_CHART` for numeric bottoms). Those bands are vetted and they
are *ours*. The storefront the shopper is standing on almost always publishes
its **own** size chart — a "מדריך מידות" / "Size guide" modal with a real table
of chest/waist/hip centimetres per size — and that table is the one the merchant
will be judged against when the parcel arrives.

Today we never read it. On a brand whose M is 100–105cm chest (ours says 96–101)
a 103cm shopper who typed their chest into the optional field is told M by the
store and L by us, off the same number.

## What this does NOT change — the safety line

The recommendation kernel is **height + weight**, scored by `coreHwPenalty()`
and used in exactly three places that all stay untouched:

1. the genuine-fit filter (`coreHwPenalty(row,…) === 0`) that decides which rows
   are candidates at all,
2. `currentBodyCategory` / `currentSizeCategory` (adult-vs-child, and therefore
   the kids/adult go-live guard),
3. the overflow ceiling (`Math.max(...chart.map(r => r.maxHeight/maxWeight))`)
   behind the "no size available" copy.

A store chart NEVER supplies a height or weight band. `applyStoreChartOverlay()`
copies `minHeight/maxHeight/minWeight/maxWeight` through verbatim and is only
allowed to write the **fine-tune** columns — `minChest/maxChest`,
`minWaist/maxWaist`, `minHips/maxHips`, `minLegs/maxLegs`. Those feed one loop:
the `× 0.5` tie-break among rows that *already* passed the height/weight gate.

So the blast radius of a wrong scrape is bounded to "which of two adjacent sizes
that both genuinely fit this body gets shown", and only for a shopper who filled
in an optional measurement. It can never invent a candidate, never remove one,
never flip adult↔child, and never turn a match into a no-match. That bound is
what makes reading merchant HTML acceptable at all.

## A. Extraction — `widget/pear-widget.js`

### Passivity contract

- Runs **only** from `openModal()`, i.e. after the shopper clicks the PEAR
  button. Never on `DOMContentLoaded`, never on `load`, never in the injection
  rAF pass. Page-load cost is exactly zero.
- Read-only: no clicks, no `.showModal()`, no fetch, no style writes. A size
  guide that only exists after a click is simply not found (→ `null`).
  A hidden-but-present modal — the common Shopify/Woo case, the markup ships in
  the DOM and CSS hides it — reads fine, because `querySelectorAll` does not
  care about visibility.
- Bounded: at most `SIZE_CHART_MAX_TABLES` (8) candidate tables are scored, at
  most `SIZE_CHART_MAX_ROWS` (40) rows and `SIZE_CHART_MAX_COLS` (12) columns
  are read per table. A merchant who ships a 4,000-row table costs us nothing.
- Wrapped in `try/catch` at the top level, returning `null`. Per CLAUDE.md §2.5
  every failure path converges on the SAME answer as "no chart on this page",
  which is byte-for-byte the pre-existing behaviour.

### Tier 1 — platform-specific containers

Scoped selectors, strongest first, for the three stacks that ship a recognisable
size-guide container:

| Platform | Container selectors (abridged) |
|---|---|
| Shopify | `.size-chart`, `.size-guide`, `[id*="size-chart" i]`, `[data-size-chart]`, `modal-dialog[id*="size" i]`, `.product-popup-modal[id*="size" i]` |
| WooCommerce | `.woocommerce-size-guide`, `#tab-size_guide`, `.wc-size-chart`, `.woo-size-chart`, `[class*="size-guide" i].woocommerce-tabs` |
| Magento | `.size-guide-content`, `#size-chart-modal`, `.sizeguide`, `[data-role="size-guide"]`, `.product.attribute.size-chart` |

A `<table>` found inside one of these is tagged with that platform as its
`source` and scored with a container bonus. Platform detection itself is
*advisory only* — every container list is tried on every page, because a Woo
theme on a headless Shopify is a real thing and mis-detecting the stack must not
cost us the chart.

### Tier 2 — universal fallback

Every remaining `<table>` on the page, plus any element carrying a
`size`/`chart`/`guide`/`מידות` token in its `id`/`class`, is scored on its own
content:

- header row maps ≥1 measurement column (chest/bust/waist/hip/length/sleeve, EN+HE), **and**
- ≥2 data rows whose size cell is a plausible size token, **and**
- ≥1 numeric measurement that survives the sanity clamp.

Highest score wins; ties go to the earlier table in document order. A table that
fails any of the three is discarded whole — a half-read chart is worse than none.

### Orientation

Charts ship both ways round. `extractSizeChart()` reads the grid, then decides:

- **sizes-as-rows** (default): header row carries measurement names, first
  column carries size tokens.
- **sizes-as-columns**: the *first column* carries measurement names and the
  header row carries size tokens → the grid is transposed before parsing.

The decision is made by counting which axis has more plausible size tokens, so a
chart with neither reads as no chart rather than as a transposed guess.

### Normalisation

`parseMeasurementCell(raw, unit)`:

| Input form | Result |
|---|---|
| `96` | point value → band `[96 − TOL, 96 + TOL]`, `TOL = 2cm` |
| `92-96`, `92 – 96`, `92 to 96`, `92/96` | range → `[92, 96]` |
| `96 cm`, `96cm`, `96 ס"מ` | unit-suffixed → cm |
| `37.5"`, `38 in`, `38 inches` | inches → `× 2.54` |
| `M / 96` , `-`, `—`, `` | no value → column left on the default |

Unit resolution, strongest first: an explicit per-cell suffix → an explicit
`cm`/`inch` token in the header/caption/container text → **magnitude
inference**, the tier that actually carries most real charts: a chest band whose
midpoint is under `INCH_MAX` (60) is inches, above is centimetres. Magnitude
inference is applied per *column*, from that column's median, never per cell —
one mis-typed cell must not flip the units of a whole column.

Ranges are stored min-first; `96-92` is swapped, not rejected.

### Header mapping — the expensive failure mode

Every other refusal in this document produces *no chart*, which costs nothing. One
class of mis-read produces a **full, well-formed, monotonic, in-clamp chart that is
simply wrong**, and that is the one worth designing against:

| Real header | Naive match | What it actually is |
|---|---|---|
| `Waist to Hem` | waist | a drop length (~63cm), not a circumference |
| `Half Chest` / `Chest Width` | chest | a FLAT half-circumference — half the number it looks like |
| `Ship Weight` | `hips?` as a substring of "Ship" | a shipping weight |

Two rules close it:

1. **English alternatives are `\b`-anchored; Hebrew ones deliberately are not.**
   JavaScript's `\b` is defined on `[A-Za-z0-9_]`, so a Hebrew letter is never a word
   character and `\bמותן\b` can never match — adding it "for consistency" would
   silently unmap every Hebrew chart in the catalog.
2. **A body word is not sufficient.** A header that *also* names a garment dimension
   (`to hem`, `length`, `drop`, `opening`, `hem`, `sleeve`, `shoulder`, `inseam`,
   `rise`, `across`, `half`, `flat`, `width`, `pit to pit`, `1/2`, `אורך`, `שרוול`,
   `כתף`) is refused outright. Not applied to `legs`, whose own patterns are
   garment-length-shaped by construction and are narrowly anchored instead.

### Sanity clamps

Per-measurement absolute bounds (cm), applied after conversion:

```
chest  50 – 200      waist  40 – 200
hips   50 – 200      legs   40 – 140
```

Plus structural clamps, all of which discard the WHOLE chart:

- fewer than 2 surviving rows,
- no surviving measurement column,
- a column that is not weakly monotonic across the ladder (a real chart's chest
  never shrinks as the size grows; a non-monotonic one is a mis-read grid, e.g.
  a column of prices),
- a band wider than `MAX_BAND_CM` (40) — that is a column read across two cells.

### Wire format

The chart travels as a compact string, not JSON, so it fits the open URL
alongside the image URLs:

```
<unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:…
        chest/waist/hips/legs ::= min-max  |  "" when absent
e.g.    cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::
```

~25 chars per row, ~160 chars for a six-row chart. Sent two ways, exactly
mirroring `garment_sizes`/`garment_soldout`:

- `&garment_size_chart=` on the iframe URL at open, so Screen 1 (and the
  returning-shopper fast path that never renders Screen 1) sees it on the first
  paint;
- `garment_size_chart` on the `PEAR_UPDATE_GARMENT` correction, re-read at that
  point, because a JS-rendered size-guide modal routinely hydrates after open.
  Sent as `""` when nothing is readable — a real answer that can CLEAR a stale
  chart, the same reason `garment_soldout` always sends its array.

Encoder (`encodeSizeChart`) lives in the widget; decoder (`parseStoreSizeChart`)
lives in `app.js`. They are a format contract and must be edited together —
added as a row in CLAUDE.md §3.

## B. Engine overlay — `fitting-room/app.js`

### New state, mirroring `pendingSizes`

```js
let pendingSizeChart = undefined;     // compact string | undefined
function resolvedStoreSizeChart()     // activeItem.sizeChart ?? pendingSizeChart → rows[]
```

Seeded in `parseHandoff()` (seeds, never overwrites — same rule as
`pendingSizes`), corrected in the `PEAR_UPDATE_GARMENT` listener (overwrites,
including to empty). **No `pendingSoldOutForImg`-style product stamp**: unlike a
sold-out list, a stale chart is not a false claim about a SKU — it can at worst
nudge a tie-break between two sizes that both already fit the body. This is the
same call `pendingSizes` makes, for the same reason, and is recorded as a known
limitation below rather than papered over.

### `applyStoreChartOverlay(baseChart, storeRows)`

```js
/** @returns {Array<object>} a NEW array; baseChart is never mutated. */
function applyStoreChartOverlay(baseChart, storeRows)
```

1. No store rows, a non-array, or a non-array base → **return `baseChart`
   unchanged** (identity, not a copy) — the fail-safe.
2. Index the store rows by normalised size token (`parseSizeList`'s own
   trim+uppercase, per CLAUDE.md §2.2's "never compare two spellings raw").
3. For each base row: if no store row carries that token, the base row passes
   through **by reference**. Otherwise clone it and, for each of
   `chest`/`waist`/`hips`/`legs`, overwrite `min*`/`max*` **only when the store
   supplied both, both are finite, `min <= max`, and both survive the clamp**.
   A store chart that publishes chest alone leaves waist and legs on ours.
4. `minHeight`/`maxHeight`/`minWeight`/`maxWeight` are never written. The
   function does not even name them.
5. A store row whose size is not on the base chart is ignored — `bestSize` can
   only ever be one of the base chart's own rows, so a row nothing can select is
   not worth carrying.
6. Any throw → `baseChart`. The whole body is inside one `try`.

### Call site — one line in `calculateSize()`

```js
const adultChart = applyStoreChartOverlay(
  useNumericPantsChart ? pantsChartForSizes(garmentSizes) : ZARA_SIZE_CHART,
  resolvedStoreSizeChart());
```

Placed where `adultChart` is already resolved, i.e. **after** chart selection and
**before** the genuine-fit filter. Because the overlay cannot touch
height/weight, `bodyAdultFits`, `currentBodyCategory`, `currentSizeCategory`,
the kids/adult guard and the overflow ceiling all compute identically to today;
the only consumer of the changed columns is the `× 0.5` fine-tune loop.

`CHILD_SIZE_CHART` is deliberately NOT overlaid: it carries no measurement
columns at all and `calculateSize()` skips the fine-tune pass outright on the
child path, so an overlay there would be dead code (CLAUDE.md RULE 0's spirit —
do not add a clause that cannot reach the wire).

## Fail-safe summary

| Failure | Result |
|---|---|
| No size guide on the page | `extractSizeChart()` → `null`, param omitted |
| Table found, header unreadable | discarded whole → `null` |
| Units ambiguous | magnitude inference; out-of-clamp → column dropped |
| One bad column | that column dropped, the rest of the chart kept |
| Fewer than 2 good rows | whole chart discarded |
| Non-monotonic ladder | whole chart discarded |
| Malformed string on the wire | `parseStoreSizeChart()` → `[]` |
| Anything throws, anywhere | `applyStoreChartOverlay()` returns the base chart |

Every one of them lands on the default global matrix — today's behaviour.

## Tests

Two new suites, registered in `test/run.mjs`.

`test/size-chart-scrape.test.mjs` — the widget, run for real in jsdom
(the `stock-dom-scrape` pattern, because a regex over the source cannot see a
`readAttr` that returns `""` instead of `null`):
- Shopify size-guide modal → chart on the iframe URL,
- WooCommerce `#tab-size_guide` table,
- Magento `.size-guide-content` table,
- universal fallback: a bare `<table>` with no platform container,
- a transposed (sizes-as-columns) chart,
- an inches chart converted to cm,
- a point-value chart banded,
- **silence**: a page with no chart, a colour table, a price table, a non-monotonic
  table, an out-of-clamp table and a one-row table each yield no param at all,
- **the header hazard class**: `Waist to Hem` does not become a waist (while the real
  chest column beside it still lands), `Half Chest` / `Chest Width` yield nothing,
  `Ship Weight` is not a hip band, and the Hebrew headers still map after the `\b` fix,
- prose around the table ("Shown **in** blue", "Made **in** Portugal") cannot flip a
  centimetre chart into inches,
- a shipping table beside a real size guide: the size guide wins,
- the pure halves (`parseMeasurementCell`, `sanitizeChartRows`, `encodeSizeChart`)
  exercised directly.

`test/size-chart-overlay.test.mjs` — the engine, fragment-extracted from
`app.js` in the `stock-fallback` style:
- the kernel is untouched: every `minHeight/maxHeight/minWeight/maxWeight` on
  every row is identical before and after, on every chart,
- a store chart moves the fine-tune tie-break between two genuinely-fitting sizes,
- a partial chart (chest only) leaves waist/legs on the defaults,
- an unknown size token is ignored,
- an out-of-clamp band is refused,
- `min > max` is refused,
- empty / null / garbage / a throwing input all return the base chart,
- the base chart is never mutated,
- `parseStoreSizeChart()` round-trips the widget's own `encodeSizeChart()`
  output — the §3 lockstep pin.

## Versioning

Bump `app.js?v=147` → `?v=148` in `fitting-room/index.html`.

## Not doing

- No new UI. The overlay is invisible; the shopper sees a size, not a chart.
  (Showing the merchant's chart in the room is a separate, bigger feature.)
- No hip/sleeve input on the form. `minHips/maxHips` is overlaid because the
  pants chart already carries the column, but nothing reads it yet — same
  standing-by-for-a-future-input state that column is already in.
- No server-side caching of a scraped chart against the product URL (what
  `sizeRunType` does). Worth doing later; out of scope here.
- No overlay of `CHILD_SIZE_CHART` — see above.
