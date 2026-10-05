# How to add a new store's size charts

Goal: every size chart the store publishes ends up in `store_size_charts`, so the fitting
room recommends sizes from the store's own charts (CLAUDE.md §2.5b).

All commands run from the repo root. Keys are read from `scanner/.env` by name
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`). The browser fallback
needs Chromium once: `npx playwright install chromium`.

## 1. Dry run first (writes nothing)

```bash
npm run capture -- https://www.example.co.il --dry-run
```

This runs three stages and stops before saving:

1. **Static**: server HTML, linked size-guide pages, JSON size-guide endpoints.
2. **Browser** (headless Chromium): starts automatically when static capture found no
   chart, found size-guide buttons with no link, or detected a JS size app. It opens up to
   6 product pages, clicks the size-guide buttons and each tab inside the guide, and reads
   the tables plus any size-chart JSON the page fetched.
3. **Images**: chart images that appeared when a guide was clicked are read by Gemini
   (up to 4). Static image hits are read only when nothing else was captured.

Read the summary. Each chart shows who it is for, the garment type, the size system,
store-wide vs this-product-only, the sizes, the measurement ranges, the confidence and the
method (`source`). Check it against the store's real guide:

- Wrong gender or type? Don't save it. Re-import that chart manually with the right labels (step 3).
- "this product only": the chart was seen on just one product page. It is stored, but
  the room serves store-wide charts only. Run again with `--max-products 20` so the guide
  can be seen on 2+ products, or import the guide page itself (step 3, `--url`).
- `image_ocr` charts have lower confidence because a model read the digits. Compare them
  against the image before saving.

Useful flags: `--browser` (force the browser), `--no-browser`, `--images` (also read
static image hits), `--no-images`, `--max-products N`. Set `PEAR_CAPTURE_VERBOSE=1` to log
every page, button and network response the browser looked at.

## 2. Save

```bash
npm run capture -- https://www.example.co.il
```

The same run, then `Save these N chart(s)? [y/N]`. After saving it reads back
`GET /api/store-size-chart?host=…` and reports how many saved charts are live. The
endpoint caches for up to 5 minutes, so a just-saved chart can show as pending. Outside
a terminal it never saves unless you pass `--yes`.

If it says the table still has the v15 key, run `archive/supabase_setup_v16.sql` once in
the Supabase SQL editor, then save again.

## 3. When nothing is found: the reason line tells you what to do

| Reason | Meaning | What to do |
|---|---|---|
| `BLOCKED` | The store refused us (403, 429 or a challenge page). We don't work around bot protection. | Open the guide in your own browser and save the page (Ctrl+S) or screenshot the table, then use `--html` / `--image` below |
| `GUIDE HAS NO BODY MEASUREMENTS` | The guide is only a size-conversion table (EU/IT/UK/US), with nothing to fit a body against | Import a measurement chart if the store has one elsewhere (`--url`) |
| `IMAGE UNREADABLE` | The guide is an image the parser couldn't validate | Screenshot just the table, sharply, then use `--image` |
| `JS GUIDE NOT OPENED` | Size-guide signals were found, but the browser read no table | Open the guide yourself, save the page with the guide open, then use `--html` |
| `NO SIZE GUIDE FOUND` | No guide control on any sampled page | If the store has a guide page, use `--url` |

Manual import goes through the same parser, validation and save as the automatic
capture:

```bash
npm run import:chart -- --host example.co.il --url https://www.example.co.il/size-guide
npm run import:chart -- --host example.co.il --html "C:\Users\me\Downloads\size-guide.html"
npm run import:chart -- --host example.co.il --image chart.png --gender women --type tops
```

- `--gender men|women|unisex|unknown`, `--age adult|kids` and
  `--type tops|bottoms|jeans|dresses|outerwear` label the charts when the source doesn't say.
  They can't change a number or rescue a table the parser rejects.
- `--only 1,3` keeps only those charts from the summary. `--dry-run` previews; `--yes`
  saves without asking.
- Manual charts are always store-wide.

## 4. What is never saved

- Anything the shared parser rejects: values outside human ranges, a ladder that zig-zags,
  no body-measurement column (prices, stock, conversion tables), garment dimensions
  ("half chest", "length").
- A chart with no garment type, when neither its own context, its columns nor `--type`
  says what it is for. A heading naming suits or blazers leaves a chart untyped on purpose.
- Heights or weights: store charts never carry them.

## 5. Re-capturing later

Charts upsert on (store, gender, age group, garment type, size system, product, source), so
re-running `capture` refreshes the store's charts in place. A store's letter and numeric
charts for the same audience are kept side by side.
