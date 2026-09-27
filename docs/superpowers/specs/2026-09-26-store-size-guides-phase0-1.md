# Store size guides — Phase 0 (measure) + Phase 1 (stored fallback) + proposal B

## Layer (CLAUDE.md §1)

**Layer D, the size ladder.** No prompt string, reference image or orientation changes.
`trace:prompt` must stay byte-identical. The fit sentence follows `getSizeDelta()`, and
nothing here changes that function.

**CLAUDE.md §2.5b is unchanged.** Every chart this work adds reaches `calculateSize()`
only through `resolvedStoreSizeChart()` → `applyStoreChartOverlay()`. That path is the
×0.5 fine-tune tie-break between rows the height/weight kernel already admitted.
`size-chart-overlay.test.mjs` §1 passes unmodified. `stored-size-chart.test.mjs` §5
re-asserts the same limit on the new stored/aliased path.

## Proposal B — available sizes from JSON-LD (`widget/pear-widget.js`)

`extractHostSizes()` tier order is **Shopify variant JSON → JSON-LD → DOM control**.
`extractSoldOutSizes()` follows the same order, so stock always comes from the tier that
produced the list.

- `productFactsFromLd(docs)` is pure. It reads `ProductGroup.hasVariant[].size`,
  `Product.offers[].size`, `offers[].itemOffered.size` and AggregateOffer `offers[]`.
  Values may be Text, a number or a SizeSpecification `{name}`, and the product may sit
  under `@graph` or `mainEntity`.
- It filters null, undefined and blank values *before* the plausibility check. adidas.it
  lists `[undefined, "2XS", …, "3XL"]`. Without this filter, the undefined entry would
  have made the whole run abstain.
- It uses the same strictness as the other tiers:
  - exactly one product on the page;
  - every non-empty value must be a plausible size, or the whole list abstains;
  - at least 2 distinct sizes.
- Sold out: a size counts as sold out only when *every* offer carrying it says
  OutOfStock, SoldOut or Discontinued. If no offer states availability, the tier makes
  no sold-out claim.
- `isPlausibleSizeToken` now accepts `2XS`, `3XS` and `XXXS` (`SIZE_TOKEN_ALPHA_RE`).
  `classifySizeRunType` uses the same regex.

## Phase 0 — measure only

- **`store_host`** is sent on the iframe URL. It comes from `canonicalStoreHost()`:
  lowercase, no scheme or port, no `www.`/`m.`. The same function exists in 4 copies
  (§3), and it is the `store_size_charts` key.
- **`garment_gender` + `garment_gender_source`** are sent on the iframe URL. Evidence
  order: JSON-LD `audience.suggestedGender`, then URL path, then breadcrumb (JSON-LD
  BreadcrumbList, then the DOM trail), else `unknown` (sent explicitly).
  - Words are matched as whole tokens, in English and Hebrew; Hebrew may carry one
    prefix letter.
  - If both men and women are named, the signal abstains.
  - The signal is logged. It is consulted for one decision only: choosing between
    *stored* charts (Phase 1).
- **`[PEAR] store chart vs default:`** is logged by `calculateSize()` after the
  recommendation is final. It shows:
  - the chart's source;
  - matched and unmatched store sizes;
  - per-size band deltas;
  - the tie-break pick on our chart vs on the store's chart, and whether they disagree;
  - whether the tie-break was idle (no optional measurement entered).

  It is logged once per distinct outcome. The mirror of the tie-break loop it uses,
  `fineTunePickForDiagnostics()`, is checked against the real marked loop on a grid of
  bodies.
- **Scanner dry run:** `node scanner/scan-store.js --size-charts <url>`. It needs no
  keys and writes nothing. For each path it reports `inline_table`,
  `product_description`, `linked_page`, `image_chart_detected` and `js_app_detected`,
  plus an outcome (`captured`, `image_chart_detected`, `js_app_detected`,
  `blocked_by_bot_protection`, `none_found` or `unreachable`). `js_app_detected` also
  covers a chart id referenced in the PDP's embedded state (terminalx.com ships
  `"size_chart":"sizechart_…"`), and a bot challenge or a 403 is never reported as
  `none_found`. The last line is `COVERAGE_JSON`.

## Phase 1 — stored charts as a fallback

1. **Capture** (`scanner/size-charts.js`, `--size-charts --save`).
   - Sample product pages: Shopify `products.json`, else the sitemap, else homepage
     links. The sample is evenly spaced across the catalogue.
   - Parse every table on each PDP, on each Shopify description, and on each linked
     same-site size-guide page (plus well-known `/pages/size-guide` paths). Parsing uses
     jsdom with scripts disabled.
   - Label each table men/women/unisex/unknown, adult/kids and
     tops/bottoms/jeans/dresses.
     - The table's own surroundings come first: caption, nearest headings, tab label,
       container id/class. Sibling headings from before a previous table are excluded.
     - Page context comes second.
     - Columns decide the *type* only as a last resort.
   - One row per (store, gender, age, type, product_key, source).
     - A PDP chart seen on 2+ products is store-wide (`product_key ''`).
     - Seen once, it stays product-scoped.
     - Two different charts under one key: keep the one seen more often, and report the
       conflict.
2. **Parser sync.** The widget's `@pear-shared:*` blocks are copied mechanically into
   `scanner/size-chart-parser.js` (`npm run sync:size-chart-parser`).
   `size-chart-parser-sync.test.mjs` does three things:
   - fails on any byte difference;
   - proves the blocks are self-contained;
   - runs one fixture set through the real widget and the scanner and requires
     identical output, including the silent pages.

   A generated copy was chosen over a hand-kept one because hand-kept copies drift
   silently. It was chosen over runtime slicing and eval because production code would
   then depend on comment markers.
3. **Migration:** `archive/supabase_setup_v15.sql`. It is idempotent, has RLS on with no
   policies, and changes no existing table.
4. **`GET /api/store-size-chart?host=`** (`lib/store-size-charts.js`).
   - Returns store-wide, active rows only.
   - Clamps are re-applied on every read. A bad band is dropped. A row left with no
     band is dropped. A chart left with fewer than 2 rows is not served.
   - Every storage problem returns 200 with `{charts: []}` plus a note:
     `storage_unavailable`, `table_missing` or `query_failed`.
5. **Room.**
   - `parseHandoff()` seeds the new signals and makes **one** GET per host.
   - `resolvedStoreSizeChart()` returns the widget's rows when they are non-empty.
     Otherwise it returns `pickStoredSizeChart()`.
   - The picker abstains on:
     - a kids product;
     - no chart of the garment's type (type from `isPantsProduct()`, with jeans vs
       bottoms decided by the title);
     - a gender it would have to guess — see below;
     - fewer than 2 sizes shared with the product's own list.
   - Gender rules:
     - Known gender: use that gender's chart, else a unisex one, else an unlabelled one
       only if the store has no gendered chart of that type.
     - Unknown gender: use a unisex or unlabelled chart only.
6. **Aliases.** `canonicalSizeToken()` treats 2XL as XXL and 3XS as XXXS on both sides.
   Row aliases come from the store's own EU/US/UK/IT/FR/INT columns, or from a second
   token in the size cell.
   - A letter alias always applies.
   - A number alias applies only if it is labelled `eu` and the base chart is numeric.
   - Aliases claim only sizes that no row's own size already holds.
   - The single hardcoded convention is `WOMEN_TOPS_EU_SIZE_CHART`. It applies only to a
     stored chart the store labelled women's tops.

   US and men's EU numeric conventions are **not** hardcoded, because they vary by brand
   and gender. They arrive only through the store's own columns.

## Known limits (deliberately not done)

- Stored charts land asynchronously. A returning shopper routed straight past Screen 1
  gets the recommendation computed before the GET returns. The tie-break only runs with
  optional measurements anyway.
- Product-scoped rows are stored but not served (Phase 2).
- Kids charts are captured but not used: `CHILD_SIZE_CHART` takes no overlay.
- Kids sizes written with a `Y` or as 3-digit height sizes are not plausible tokens, so
  those charts are not parsed.
- Image or PDF charts and JS-rendered modals are reported, not captured (Phases 2–3).
- Aliases do not travel on the widget's wire format. Only stored charts carry them.
- A Complete-the-Look item uses the open-time gender signal, the same approach
  `pendingSizes` already takes.
