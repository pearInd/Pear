# How to add a new store's size charts

Goal: every size chart the store publishes ends up in `store_size_charts`, so the fitting
room recommends sizes from the store's own charts (CLAUDE.md §2.5b).

All commands run from the repo root. Keys are read from `scanner/.env` by name
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`); no command prints a value.
The browser fallback needs Chromium once: `npx playwright install chromium`. Without
`GEMINI_API_KEY` nothing reads an image chart (step 1, Images).

## 1. Dry run first (writes nothing)

```bash
npm run capture -- https://www.example.co.il --dry-run
```

This runs three stages and stops before saving:

1. **Static**: server HTML, linked size-guide pages, JSON size-guide endpoints. After 3
   refusals in a row (403, 429 or a challenge page) it asks the store for nothing more
   (a polite stop). A guessed guide address (a well-known path like `/pages/size-guide`
   that the store never linked) refusing is not the store refusing us: 3 of those in a
   row only stop the guessing.
2. **Browser** (headless Chromium): starts automatically when static capture found no
   chart, found size-guide buttons with no link, or detected a JS size app. It opens up to
   6 of the sampled product pages (or, with no sample, the product links on the rendered
   home page), clicks the size-guide buttons and each tab inside the guide, and reads the
   tables plus any size-chart JSON the page fetched.
   - It never starts on a store that refused us: if the static stage was blocked, made a
     polite stop, or every sampled product page refused, the run reports `BLOCKED`
     instead (not even `--browser` overrides that). A page that refused on its own is
     left out of the browser's list.
   - The browser itself stops after 2 refusals in a row. A guide request the store
     refuses (403, 429 or a challenge page, on the store's own host, between a guide click
     and the read of what it opened) is a refusal too: no further guide is clicked.
3. **Images**: up to 4 chart images are read by Gemini, 5 seconds apart, in this order:
   - images that appeared when a guide was clicked, always and first;
   - the static stage's image hits, only in the slots left, and only when nothing
     store-wide was captured (or with `--images`). They are word matches, often banners.
   - After the store refused us (static stage or browser), no image on its own site
     (`shop.`, `www.`, `cdn.` or bare `example.co.il` alike) is fetched; images on another
     domain (a CDN, a size app's servers) still are.
   - With no `GEMINI_API_KEY` nothing is read and the run ends `IMAGE NOT READ`. If Gemini
     answers 429, no further image is read that run (`IMAGE READER RATE-LIMITED`).
   - PDFs and inline `data:` images are never read automatically: screenshot the chart
     and use `--image` (step 3).

Read the summary. Each chart shows who it is for, the garment type, the size system,
store-wide vs this-product-only, the sizes, the measurement ranges, the confidence and the
method (`source`). Check it against the store's real guide:

- The save question covers every chart listed, all or none. If any chart is wrong (gender,
  type), answer N and import the charts one at a time with the right labels (step 3,
  `--only <n> --gender ... --type ...`). A chart only the browser or an image found has no
  page `--url` can read: save the page with the guide open (`--html`) or screenshot it
  (`--image`).
- "this product only": the chart was seen on just one product page. It is stored, but
  the room serves store-wide charts only. `--max-products 20` widens only the static
  sample (the browser still opens at most 6 pages), so it helps only a chart the static
  stage found. Otherwise import the guide itself (step 3): `--url` for a guide page,
  `--html` or `--image` for a guide that opens in a popup. Manual charts are store-wide.
- `image_ocr` charts have lower confidence because a model read the digits. Compare them
  against the image before saving.

Useful flags: `--browser` (force the browser), `--no-browser`, `--images` (also read
static image hits), `--no-images`, `--max-products N` (static sample, 1-50, default 12).
Set `PEAR_CAPTURE_VERBOSE=1` to log each page's size-guide controls, failed clicks and the
network responses that looked like size charts (a response the pre-filter dropped is not
listed).

In both commands a flag's value can follow a space or an `=` (`--max-products 20` and
`--max-products=20` are the same). The yes/no flags (`--yes`, `--dry-run`, `--browser`,
`--no-browser`, `--images`, `--no-images`) take no value: `--yes=`, `--yes=true` and
`--yes=1` are plain `--yes`, and any other value (`--yes=no`, `--dry-run=false`,
`--yes no`, `--dry-run off`) stops with a usage error before anything runs (`capture`
exits 2; `import:chart` prints `✗ import failed: ... takes no value` and exits 1).

## 2. Save

```bash
npm run capture -- https://www.example.co.il
```

The same run, then `Save these N chart(s) for <host>? [y/N]`. Outside a terminal it never
saves unless you pass `--yes`; `--dry-run` never saves, not even with `--yes`.

After saving it reads back `GET /api/store-size-chart?host=…`. A chart counts as live
only when the room is served its labels *and* the numbers just saved. The last line is
one of:

- `✓ all N store-wide chart(s) just saved are live`
- `… X/N store-wide chart(s) live with the numbers just saved`, then how many are served
  with different numbers (the previous version, cached for up to 5 minutes, or rows the
  endpoint drops) and how many are not served yet (the endpoint caches for up to 5
  minutes), with a `curl` line to re-check.
- `? could not verify what the room receives`: the live check failed or the endpoint
  reported its own storage failure. Nothing to wait for; re-check with the `curl` line.
- `… no store-wide chart saved`: every chart was product-scoped. They are stored, but the
  room serves none of them.

If the table is missing or still has the v15 key, the run says which file to run once in
the Supabase SQL editor (`archive/supabase_setup_v15.sql` or `archive/supabase_setup_v16.sql`),
then run the same command again to save. A save skipped that way, or with
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` unset, exits with code 1, so
`npm run capture -- <url> --yes && echo saved` only says saved when something was.

## 3. When nothing is found: the reason line tells you what to do

| Reason | Meaning | What to do |
|---|---|---|
| `BLOCKED` | The store refused us (403, 429 or a challenge page), in the static stage or the browser, including a refused size-guide request. We don't work around bot protection. | Open the guide in your own browser and save the page (Ctrl+S, "Webpage, Complete") or screenshot the table, then use `--html` / `--image` below. `--url` would be refused the same way. |
| `UNREACHABLE` | The store did not answer at all (the home page, or every page the browser tried: reset, timeout) | Check the URL, or use `--html` |
| `BROWSER UNAVAILABLE` | Chromium could not start, or the browser stage failed (the message says why) | Run `npx playwright install chromium`, or use `--url` |
| `GUIDE HAS NO BODY MEASUREMENTS` | The guide is only a size-conversion table (EU/IT/UK/US), with nothing to fit a body against | Import a measurement chart if the store has one elsewhere (`--url`) |
| `IMAGE UNREADABLE` | The guide is an image (or a PDF) the parser couldn't validate | Screenshot just the table, sharply, then use `--image` |
| `IMAGE NOT READ` | A chart image was found, but `GEMINI_API_KEY` is not set | Set it in `scanner/.env` and run the same command again |
| `IMAGE READER RATE-LIMITED` | Gemini answered 429 (too many requests); nothing is wrong with the image | Wait a minute or two and run the same command again |
| `IMAGE GUIDE NOT READ` | A chart image was found, but `--no-images` was given | Run again without `--no-images`, or screenshot the table and use `--image` |
| `JS GUIDE NOT OPENED` | Size-guide signals were found, but the browser read no table | Open the guide yourself, save the page with the guide open ("Webpage, Complete"), then use `--html` |
| `NO SIZE GUIDE FOUND` | No guide control on any sampled page, or the browser found no product page to open | If the store has a guide page, use `--url` (a guide page or a product page) |

Manual import goes through the same parser, validation and save as the automatic
capture:

```bash
npm run import:chart -- --host example.co.il --url https://www.example.co.il/size-guide
npm run import:chart -- --host example.co.il --html "C:\Users\me\Downloads\size-guide.html"
npm run import:chart -- --host example.co.il --image chart.png --gender women --type tops
```

- `--host` is the store's hostname (`fox.co.il`); an internationalised name goes in its
  `xn--` form (the error names it). With `--url` to a page on the store it can be left
  out; an image URL needs it (images are usually on a CDN).
- `--url` is fetched once. A 403, 429 or challenge page is `BLOCKED` and never retried:
  save the page or screenshot it instead. An image URL is read as an image; a PDF is not
  read (screenshot it).
- `--html`: save with Ctrl+S as **"Webpage, Complete"**, with the guide open. "Webpage,
  HTML only" saves the page as first served, without a guide you opened. A "Webpage,
  Single File" `.mhtml` save is read too; one it cannot decode says so and asks for a
  "Webpage, Complete" save. The address Chrome records in the save is used as context
  (as `--url` would), when it is on the store's host. A table inside the guide's
  dialog or popup takes its garment type from the guide, never from the product page.
- `--image` takes PNG, JPEG (including `.jfif`) or WebP, judged by the file's bytes, not
  its name, up to 8 MB, and needs `GEMINI_API_KEY`. GIF is refused: save it as PNG or
  screenshot it.
- Every table the parser accepted has one number (`#1`, `#2`, ...), the same with or
  without flags. A table the source doesn't type (a suits or blazers table) is not in the
  summary; a `!` line names it by its number and says how to import it.
- `--only 1,3` imports only those charts, by those numbers.
- `--gender men|women|unisex|unknown`, `--age adult|kids` and
  `--type tops|bottoms|jeans|dresses|outerwear` replace the labels of the charts `--only`
  picked, or of every chart when there is no `--only`. So when a page holds several charts,
  run it once without flags, then import each chart that needs a label on its own:
  `--only 2 --gender women`. They can't change a number or rescue a table the parser rejects.
- Two charts that end up with the same labels can't both be stored: the summary says which
  one is saved and which isn't.
- `--gender`, `--age` or `--type` with no value (`--type=`) stops with an error instead of
  importing unlabelled.
- `Nothing importable.` means no table in the source passed: either the guide opens
  client-side (save the page with it open, or screenshot it) or its table was refused for
  its values (not a body-measurement chart).
- `--dry-run` previews; `--yes` saves without asking. Saving, the live check and the
  skipped-save exit code are as in step 2; a source it cannot use (`BLOCKED`, a file it
  cannot read) or a bad `--host` / label / `--only` value exits 2.
- Manual charts are always store-wide.

## 4. What is never saved

- Anything the shared parser rejects: values outside human ranges, a ladder that zig-zags,
  no body-measurement column (prices, stock, conversion tables), garment dimensions
  ("half chest", "length").
- A chart with no garment type, when neither its own context, its columns nor `--type`
  says what it is for. A heading naming suits or blazers leaves a chart untyped on purpose
  (import it with `--only <n> --type ...` if you know what it is for).
- Heights or weights: store charts never carry them.

## 5. Re-capturing later

Charts upsert on (store, gender, age group, garment type, size system, product, source), so
re-running `capture` refreshes the store's charts in place. A store's letter and numeric
charts for the same audience are kept side by side.
