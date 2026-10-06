# PEAR — project status

Living file. **Every task ends by updating it** (CLAUDE.md §9). Newest facts win.
Hashes are on `main` unless a branch is named. Stages: *not started · in progress ·
done · blocked*.

_Last updated: 2026-10-05 · main: THE SWAP FLOW + THE LANDING, PROJECTED · branch `claude/project-thread-cr4uyn`: size-guide capture Phase 2 (ready for your review)_

## At a glance

| Workstream | Stage | Where |
|---|---|---|
| Children's sizing (kids/adult guard) | done (core); follow-ups open | main |
| Store size guides (Phase 0 + 1 + store-chart decides) | in progress — shared-parser fixes, all-charts key (v16, run) and the store-chart decision shipped `0fccee8`, and run server-side since the merge (`lib/sizing.js`, proven identical over 146,440 cases - CLAUDE.md §2.27); **adidas re-save waiting on you** | main |
| Store size guides — Phase 2: capture any store (browser, image OCR, manual import, one command) | done on the branch, **waiting on your review**; 11-store sweep run from your machine, nothing saved beyond fox/castro | `claude/project-thread-cr4uyn` |
| Ready-signal product signals fix | done | main `137188d` (merge of `3fb3c37`) |
| JSON-LD size list (proposal B) | done | main `bd766b2` |
| Size-chart "inches" backspace-byte bug | done | main `3345467` |
| garment_cache rows missing `age_group` | code done — full backfill **deferred by choice** (demo products only for now) | main `ef1d28d` |
| `DECART_ALLOWED_ORIGINS` / token origin | done (Vercel env set + redeployed 2026-10-02); the preview-origin fix is on main with the merge | main |
| Back-image orientation (front/back on a turn) | in progress — the back gate (§2.28) ends "back print on the chest", but on the PEAK tee the engine is too slow for a normal turn and the back print does not appear (4 real sessions 2026-10-04); neither a smaller image nor pre-uploading speeds the engine; the cause is the engine's region (Michigan, US since ~09-30); **raising it with the vendor is yours** | main |
| Hebrew/English i18n | done (core) | main |
| Security hardening + client-code hiding | done on main with the merge (engines server-side, minified/cloaked build, the render engine behind our edge - CLAUDE.md §2.11-§2.24); **the GitHub repo is still public** and **key rotation pending on you** | main |
| Render engine account | the Decart key was replaced by you 2026-10-04 (Vercel Production + Preview); the old account had run out of credits ("Insufficient credits", now shown to a shopper as "unavailable right now" within ~1.5s) | Vercel env |
| Landing / brand video | done | main `e8d2c7f` |
| Black-screen on reopen | done | main `3a533d6`, `af5f4d4` |
| Visual QA gate | done, known flaky (§8.5) | main |
| Liquid Glass UI + consent gate | done | main `0827e51`, `89a5848` |

## Waiting on you (manual steps)

- [x] **`archive/supabase_setup_v16.sql` is in place** — castro's third chart (the women's EU 32–46
      table the old key dropped) is live: `GET /api/store-size-chart?host=castro.com` answered 3 charts
      on 2026-10-05. fox answers its 5 store-wide charts, as before.
- [ ] **Re-save adidas** when it answers you: `node scan-store.js --size-charts --save https://www.adidas.co.il`
      (from `scanner/`). It refused your machine in the 2026-10-03 sweep (HTTP 403 on the static and the
      browser stage); its 2 charts from the 2026-10-03 capture are still live.
- [ ] **Review the Phase 2 PR** (`claude/project-thread-cr4uyn` → main) — the capture CLI. Nothing merges
      or saves without you.
- [ ] **Decide which sweep charts to save** (none saved; dry runs only, see *Phase 2 coverage*): delta's 4
      store-wide charts look ready; hoodies (men's tops with only L/XXL), twentyfourseven (bottoms
      0/1/2/3/4) and terminalx's image chart (women/kids tops 92/98) look wrong - check before saving;
      renuar, twentyfourseven and terminalx are product-scoped (the room does not serve those yet).

- [x] Size-guide dry runs for all 4 stores — done 2026-10-02 (results under *Store size guides*).
- [x] fox.co.il captured with `--save` — 11 rows in `store_size_charts`, 5 store-level served by the API.
- [x] adidas.co.il captured from your machine 2026-10-03 (it was NOT blocked for you - the
      bot protection seen from here was IP/fingerprint-specific). 2 charts saved, API verified
      (results under *Store size guides*). One chart excluded as suspect, not saved - see below.
- [ ] **Decide the fate of the excluded adidas "unknown/adult/tops" chart.** It came off the
      `size-w_bottoms` guide (waist/hips only, no chest, yet typed "tops" from page context I
      could not independently confirm - a follow-up fetch to inspect the raw page got
      bot-challenged, so I stopped per your instruction rather than keep probing). It is
      currently just not saved. If you want it investigated: `cd scanner && node -e` a fetch of
      `https://www.adidas.co.il/on/demandware.store/Sites-adidas-IL-Site/en_IL/Product-SizeChart?cid=size-w_bottoms`
      from your machine, saved to a file, and I'll read it.
- [x] Next phase decided: castro fix (done, `8ce3de6`), adidas fix (done, this commit), then
      Phase 2 — separately, not started.
- [ ] **SECURITY — rotate two keys** (both were exposed in plain text outside the repo).
      Issue the new key, update every place listed, redeploy, THEN revoke the old one.
      **Gemini API key** (`GEMINI_API_KEY`) — create a new key in Google AI Studio
      (aistudio.google.com/apikey) and delete the old one there. Update:
        1. Vercel → project env vars → `GEMINI_API_KEY` (Production, Preview, Development), then
           redeploy (server-side garment classification, `lib/garment-category.js`);
        2. `scanner/.env` (scanner + `scanner/backfill-age-group.js`);
        3. a root `.env` on any machine that runs `scripts/batch-scan-clothes.js` or
           `scripts/backfill-garment-categories.js` (none in this checkout);
        4. the Railway scanner service's variables, if it is deployed (`scanner/README.md`, Deploy).
      **Supabase service_role key** (`SUPABASE_SERVICE_ROLE_KEY`, project `jyhilack…`) — a legacy
      JWT key; it cannot be rotated on its own. Either (a, preferred) Supabase → Project Settings →
      API Keys: create a new **secret** key (`sb_secret_…`), switch every consumer below to it,
      then **disable the legacy JWT-based keys**; or (b) rotate the JWT secret — which also
      invalidates the anon key and every signed-in session. Update:
        1. Vercel → `SUPABASE_SERVICE_ROLE_KEY` (all environments), then redeploy (`lib/supabase.js`:
           sessions, users/OTP, garment_cache, `/api/store-size-chart`);
        2. `scanner/.env` (scanner `--save`, `backfill-age-group.js`);
        3. a root `.env` on any machine that runs the `scripts/` backfills (none in this checkout);
        4. the Railway scanner service, if deployed.
      Not affected: `admin/admin.js` ships a public **anon** key for a *different* project (`nhkaiucb…`).
      Check afterwards: `GET /api/store-size-chart?host=fox.co.il` returns 5 charts with no `note`,
      and a scanner `--size-charts --save` run still saves.
- [ ] **Live test of the kids/adult guard** in a real session: a kids garment + adult measurements
      must block going live, and an adult garment + child measurements must block too (the reverse).
      Code-level coverage exists (`kids-adult-size-guard`); this is the end-to-end check.
- [x] Migration **v15** (`store_size_charts`) — run (confirmed 2026-10-01).
- [ ] **Confirm which `garment_cache` migrations production has** (v8, v12, v13, v14).
      Code comments record production as *v9 + v11 without v8*; the `age_group` fix
      below no longer depends on the answer, but the diagnostics in v8 do.
- [x] **`DECART_ALLOWED_ORIGINS` in Vercel** — done 2026-10-02: `https://app.pear-ai.io`,
      `https://platform.pear-ai.io` and all 4 stores with and without `www`; redeployed.
- [ ] **Full age_group backfill — DEFERRED by choice, not blocked.** Stopped partway on purpose;
      only demo products need it for now. When wanted: `cd scanner && node backfill-age-group.js`
      (`ef1d28d` must be deployed first, or try-ons re-wipe the rows it fills).
- [x] **The fate of the hiding branches** — decided 2026-10-04: `hide/edge` (its successor) merged into main with
      main's 12 newer commits carried through (CLAUDE.md §2.27). `hide/main-v2` is superseded.
- [ ] **Make the GitHub repository private** (pearInd/Pear) - every source file names the engine and the
      models; the shipped code no longer does, the repository still does (CLAUDE.md §2.24).
- [ ] **Credit on the render engine account** behind the new key - a session needs it; without it the room says
      "unavailable right now" (a TEST session says it is the credit).

---

## Children's sizing
- **Stage:** done (core).
- **Done:** age-based + classified kids sizing `0d3d756`; code-level kids/adult go-live
  guard `d619212`; returning-user bypass closed `71ddcd4`; reverse gap closed `ec59d78`;
  `garment_cache.age_group` (v11) + backfill script `0a0627e`; the product's own size
  list outranks the classifier (kids-tee report).
- **Remaining:** `CHILD_SIZE_CHART` has no chest/waist columns, so a store's kids chart
  cannot refine it (captured by the scanner, unused). Kids sizes written `4Y`/`110` are
  not parsed. The `age_group` NULL bug (below) weakens the classifier fallback.
- **Open decisions:** whether kids charts get a fine-tune pass at all.

## Store size guides
- **Stage:** in progress. Phase 0 (measure) + Phase 1 (stored fallback) shipped in `bd766b2`;
  **§2.5b changed 2026-10-03 (`0fccee8`): a confident stored chart now DECIDES the adult size**.
  Phase 2 (capture any store) built on `claude/project-thread-cr4uyn`, waiting on your review (below).
  Phases 3–6 not started.
- **Done:** widget reads the PDP chart (`2026-09-17` spec); scanner `--size-charts`
  dry run + `--save` capture; `store_size_charts` (v15, run); `GET /api/store-size-chart`;
  room fallback with gender/type/overlap guards; EU/US aliases; `[PEAR] store chart vs
  default` log; generated scanner parser with a byte-identity test.
- **Coverage, 2026-10-02** (12-product dry runs):

  | Store | Outcome | Path that worked / what blocks it |
  |---|---|---|
  | fox.co.il (Shopify) | captured, 11 charts | linked_page 5/6 + inline_table 6/12. **Saved** (5 store-level + 6 product-scoped; only store-level is served in Phase 1). Spot-checked against the live tables |
  | castro.com | first run js_app_detected (misdiagnosed); **after `8ce3de6`: captured, 2 charts — saved, API verified** | Charts are plain server HTML at `/idus/staticblock/view?id=N`, linked by a `data_url` (underscore) attr and wrapped in `{"success":true,"html":…}`. The existing parser reads 4/6 blocks (adult); 2 kids blocks are age-only, correctly abstained. Also: `/size-guide` & `/size-chart` are soft-404s (return the home page). Endpoint 302s to an abuse page for a bare curl UA; the scanner UA is fine. Stored: women/adult/tops XS–XL (chest/waist/hips; gender from the `/נשים/` PDPs that link it) and men/adult/tops XS–XXXL (chest). Not stored: the blazers & suits table (untyped), the EU 32–46 women's table (same key; castro sells tops in alpha), 2 kids blocks (age-only). Castro's own "XSS" row (typo for XXS) is skipped by the parser. The home-echo paths now count as missing |
  | terminalx.com (Magento SPA) | js_app_detected | PDP state carries only the CMS block id (`blocks.size_chart: "sizechart_terminal_x_1"`, 6 distinct ids incl. brand charts); content is behind `/graphql`, which answers 401 anonymously. Genuinely JS-only → Phase 2. Sampler fixed in `8ce3de6`: no category pages now (2/12 are dead sitemap 404s) |
  | adidas.co.il (Salesforce Commerce Cloud) | blocked from here; **not blocked from your machine 2026-10-03 → captured, saved, API verified** | Platform was misreported "shopify" - a Global-e checkout config key literally named `UseShopifyCheckoutForPickUpDeliveryMethod` is the ONLY "shopify" mention on the whole homepage; real markers (`/on/demandware.static/`, `Sites-adidas-IL-Site`) now drive detection. Charts are ARIA div-grids (`role="table"/"row"/"cell"`, no `<table>` anywhere) behind `{action,content,success}` JSON (same shape as castro's, different field name) - inline on the PDP there is NOTHING, only a click-triggered AJAX endpoint (the 50+ "size-guide triggers with no link" per run are this). Stored: men/adult/tops XS–3XL (chest/waist/hips) and women/adult/bottoms 2XS–XXL (waist/hips). Excluded, not saved: an "unknown/adult/tops" chart off the bottoms guide with no chest column - couldn't confirm why before a follow-up fetch got bot-challenged, so investigation stopped (§"Waiting on you"). `Union.png`, a 16px icon riding the already-followed size-guide `<a>` (hidden via a `d-none` class, its OWN class text literally containing the word "sizeguide"), was being reported as a found IMAGE chart - fixed with a hidden-markup + small-dimension + "icon rides an already-followed trigger" exclusion. A reused `"kids-table___1-YOY"` CSS-Modules skin class sits on BOTH the men's and women's ADULT chart containers - a styling hook, not an audience claim; stripped from context text generally (any `___<hash>`-suffixed class/id token). Every cm cell is written with no space before the unit (`"83 - 86cm"`), which defeats the shared parser's own `\bcm\b` test and was silently doubling already-correct values by 2.54 via the ancestor-text unit fallback; fixed by normalizing the one missing space before handing text to the (otherwise untouched) shared parser |

  Image charts detected: **0 across all reachable stores** (Union.png was a false positive, not a real chart - see above).
- **Done 2026-10-02/03 (`8ce3de6`, this commit):** castro capture (`data_url`, JSON envelope,
  home-echo guide paths, referrer-derived gender, suits/blazers untyped, alpha-for-tops
  tie-break); adidas capture (platform detection, ARIA div-grid→synthetic-table, JSON
  `{content}` envelope, decorative-image exclusion, CSS-Modules-hash context stripping,
  no-space-unit normalization, inches/cm toggle-pair dedup); product sampler by URL shape;
  product keys percent-encoded (fox's one raw-Hebrew row fixed in place).
  `store_size_charts`: 15 rows — fox 11 (5 served), castro 2 (2 served), adidas 2 (2 served).
- **Done 2026-10-03 (`0fccee8`):**
  1. *Shared parser* — the adidas fixes moved from the scanner into the widget's
     `@pear-shared:size-chart-parser` block (scanner copy regenerated, sync test green): glued
     units (`86cm`, `38in`), ARIA div-grids, Inches|cm twin collapse (only when one grid is cm and
     the other inches — two same-shaped cm charts stay two), `___hash` class stripping, `{html}`/
     `{content}` envelopes. The glued-unit bug was live in the widget: a women's 62/68/74cm waist
     ladder beside an "Inches" label shipped as 155.5–190cm (reproduced on the old code in
     `size-chart-shared-fixes` §2).
  2. *All charts kept* — `archive/supabase_setup_v16.sql` (size_system in the key, **not run yet**);
     scanner keys on it and refuses to save until it runs; the room picks between same-audience
     charts by size overlap with the product, own labels breaking ties.
  3. *Store chart decides* — `storeChartRecommendation()`: typed measurements, else a
     `k·sqrt(weight/height)` estimate (±4–6cm); abstains below 35% / within a 10-point margin, on
     unknown garment gender with gendered charts, or with nothing comparable. Runs after the
     kernel's adult/child + no-match decisions (guard untouched). `trace:prompt` byte-identical.
- **Remaining:** the adidas re-save above; Phase 2's review (below). Widget sightings (the earlier
  Phase 2 idea) not started - the browser path now reaches terminalx without it. Phase 3 (vision)
  has zero measured demand. Known limits: (a) a product sold in NUMERIC tops sizes (EU 34–46) is routed
  to bottoms by `isPantsProduct()`'s size-run tier (pre-existing), so a numeric women's TOPS
  chart (castro's EU table) is stored but today only usable through its letter aliases;
  (b) with only height+weight, the estimate decides only when the body sits well inside a band
  — near a band edge, or with the shopper's gender unset, it abstains (by design); (c) the
  men's waist coefficient is calibrated on a derived column (weakest of the three); (d) the
  widget's PDP chart never decides (no audience labels) — it stays a tie-break; (e) the adidas
  "unknown/adult/tops" exclusion above is open.
- **Open decisions:** none on the code shape - server-side (`lib/sizing.js`) since the `hide/edge`
  merge (CLAUDE.md §2.27).

### Phase 2 — capture any store (branch `claude/project-thread-cr4uyn`, waiting on your review)
- **Stage:** done on the branch, waiting on your review. Not on main; nothing saved by it.
- **Commands:** `npm run capture -- <store-url> [--dry-run]` (static → browser → image OCR,
  summary, y/n, save, then reads `GET /api/store-size-chart` back); `npm run import:chart --
  --host <h> (--url|--html|--image) <src> [--gender/--age/--type] [--only n]` (manual, store-wide);
  `npm run mutation:capture`. How-to: `docs/ADDING-A-STORE.md`.
- **Sources:** `browser_page` / `browser_modal` / `browser_network` (headless Chromium, clicks the
  guide and its tabs), `image_ocr` (Gemini reads a chart image, confidence −0.2), `manual_url` /
  `manual_html` / `manual_image` (−0.1 for an image). Every path goes through the same shared
  parser, `buildRecords()` and `saveSizeChartRecords()` as Phase 1.
- **Never worked around:** a store that refuses us (403/429/challenge) is reported BLOCKED with the
  manual way in; the static stage stops after 3 refusals in a row (or when every sampled product
  page refused) and the browser is then never started, nor the store's own images fetched; the
  browser stops after 2. A guessed guide path's 403 is not the store refusing. No stealth, no
  fingerprint tricks, no CAPTCHA, no proxies.
- **Done:** WIP from the 2026-10-03 session `eee19e7`; main merged `0bb6c3d` and `71df521`
  (main `528888a`); a 36-finding review fixed, then a verify pass found 5 more, all fixed with
  tests in `ffce4a7`: a store that began refusing was re-asked by the browser; a theme's page
  wrapper (Debut/Brooklyn) read as a guide dialog in a manual import; a chart's `--only` number
  differed with flags and untyped tables (suits) had none; a guide hidden by CSS (Dawn) never
  counted as opened; the mutation script restored same-file edits in the wrong order. An
  independent check of those 5 found 3 more, fixed with tests that failed first in `0630a23`: a
  store that refused every sampled product page (under the 3 of a polite stop) was re-asked by the
  browser; three guessed guide paths answering 403 marked a store that served every product page
  BLOCKED; `--only=1` (the equals form) was ignored and imported every chart. Also: after a
  refusal, images on the store's own host are no longer fetched.
- **Verified 2026-10-05 (after `0630a23`):** unit suite green (4,014 checks, real Chromium for the
  browser tests); `npm run mutation:capture` 21/21 killed with Chromium (without Chromium the
  CSS-visibility one is reported SKIPPED); `trace:prompt --json` byte-identical to main (`528888a`);
  `qa:visual` 40/40.
- **Coverage — sweep from your machine, 2026-10-03, 11 stores, dry runs (all exit 0):**

  | Store | Result |
  |---|---|
  | fox.co.il | 11 charts (6 inline product-scoped + 5 linked_page store-wide) - unchanged, no regression |
  | castro.com | 3 linked_page (incl. the women's EU table) - unchanged, no regression |
  | terminalx.com | browser_modal: women tops/bottoms XXS–XL (product-scoped) + image_ocr women/kids tops 92/98 (product-scoped, looks wrong) |
  | delta | 4 linked_page, store-wide |
  | renuar.co.il | 2 image_ocr bottoms, numeric 32–44 / 36–50 (Kiwi Sizing, product-scoped) |
  | twentyfourseven | 1 image_ocr bottoms, numeric 0–4 (product-scoped, looks wrong) |
  | hoodies | 1 men/adult/tops with only L/XXL (looks wrong) |
  | factory54 | no body measurements (6 guides opened, all size-conversion tables) |
  | yanga | no size-guide control found |
  | adidas.co.il | BLOCKED (403, static and browser) |
  | golfco | BLOCKED (403) |

  The sweep predates the last 8 fixes; re-run a dry run before saving any of them.
- **Remaining:** your review + merge; which sweep charts to save (Waiting on you). Product-scoped
  charts are stored but not served (Phase 1 serves store-wide only).

## Ready-signal product signals fix
- **Stage:** done — merged as `137188d`.
- **Done:** `3fb3c37`: `productSignals()` builder used by all three
  `PEAR_UPDATE_GARMENT` messages, so the kids/adult verdict and a late size list reach
  the room on the ready and failure signals too. The merge keeps `bd766b2`'s JSON-LD-aware
  re-reads and the `store_host` / `garment_gender` URL params; `ready-signal-signals` §5
  proves both on one page. §2's timing race (failed 1 run in 3 on the branch alone) was
  fixed by anchoring the delay to the click.
- **Remaining:** none.

## JSON-LD size list (proposal B)
- **Stage:** done — `bd766b2`. Shopify variants → JSON-LD → DOM; 2XS/3XS tokens.

## Size-chart "inches" caption bug
- **Stage:** done — `3345467`. `SIZE_CHART_DECLARED_IN_RE` carried a literal backspace
  byte where `\b` was meant, so a caption saying "inches" never declared the unit and a
  plus-size chart (62/64/66 in) read as centimetres. Fixed in the widget, scanner copy
  regenerated; `size-chart-parser-sync` §5 pins it and scans both copies for control bytes.
- **Remaining:** none.

## garment_cache rows missing `age_group`
- **Stage:** code done (`ef1d28d`); full data repair deferred by choice.
- **Cause** (on production's v9 + v11 table without v8):
  1. writes fell back through a version-ordered ladder that dropped `age_group` (both
     writers until `b730ef8`, 2026-09-15; the server's "no v8" retry since then);
  2. the cached read selected v8 columns in every tier, so it returned `age_group: null`
     even when the column held a value;
  3. `GET /api/garment-category` (since 2026-09-14) re-saved that null over the real
     value on every try-on, because the write sent `age_group` unconditionally.
- **Done:** schema-adaptive read/write (drop exactly the missing column); `age_group`
  written only with a verdict; same in the scanner; `garment-cache-age-group` test
  (fails 8 checks on the pre-fix code).
- **Remaining:** the full backfill is **deferred by choice** (2026-10-02) — stopped partway
  because only demo products need it now. Not blocked: re-run `scanner/backfill-age-group.js`
  when wanted; it targets every `age_group IS NULL` row, and the cache-first live path never
  re-classifies them itself.

## `DECART_ALLOWED_ORIGINS` / token origin
- **Stage:** done for production — Vercel `DECART_ALLOWED_ORIGINS` set 2026-10-02 (app, platform,
  and the 4 stores with and without www) and redeployed.
- **Done:** CORS allowlist + own-host auto-allow (main, `server.js`); tokens scoped to
  the allowlist (main). `f93ef87` (`hide/main-v2` only): the token also names the
  requesting page's own origin — fixes "Origin not allowed" on a fresh preview.
- **Remaining:** preview deployments only — a fresh preview URL is not in the list; it is
  covered once `f93ef87` (on `hide/main-v2`) reaches main.

## Back-image orientation (front/back on a turn)
- **Stage:** in progress — the most active stream.
- **On main (production):** the orientation engine on Cloudflare (§2.14), the front at the side
  (§2.23-§2.25), the return timed by the engine's pace (`0d0c087`), the back gate (`e43952d`:
  a BACK whose return would land on the chest is held), the camera never shown during a
  measurement (`af5b705`). Worker `49c3ca31`.
- **Measured 2026-10-04 (4 approved real sessions, PEAK tee, CLAUDE.md §2.28):** the engine
  acknowledged references in 482-3,468ms; a smaller image (`small`) and pre-uploaded files
  (`ref`) were no faster. In all four the gate held the back for the whole turn — **no back
  print appears** on a normal-speed turn with this tee. The experiment's upload path had a
  bug (`/v/f`), fixed `923b788` (TEST sessions only).
- **Separated (2 more approved sessions, same evening):** OASIS is slow today too (repeats
  592-769ms vs 128-250ms in late September) and the SDK's telemetry off is no faster
  (1.0-2.3s) — not the product, not us. The network-level ack equals the room's. The engine
  for Israel now answers from **Michigan, US** (CoreWeave, region `usw2`, ~220ms round trip).
- **Decided (you, 2026-10-04):** keep the guarantee — never the back print on the chest; a plain
  back on a normal turn while the engine is this far. **Reversed the same night after your two
  sessions (23:19/23:20):** the held FRONT reference drew the front print on your back, not a plain
  back - the gate is off by default again (`?back_gate=1` for an A/B), Worker `bd0f14a0`. The tank
  top (23:20) is the engine's reading of this product's photo - open.
- **Open (yours):** ask the vendor for a closer region / why Israel moved ~09-30. When acks are
  back near 150-250ms the back print returns by itself (the gate measures every session).
- **2026-10-05 - THE SWAP FLOW (CLAUDE.md §2.29):** the 23:57 record showed the cause of "the back
  print stays on the chest": while a swap was on the wire nothing was measured for 1.67s (the whole
  back view), so the FRONT went out on the way back. The turn is now read during a swap and the
  decision waits for the wire instead of being dropped; the shoulder order is available from the
  2nd reading; a swap never waits for its prompt. Replay corpus: a full 360 ending with the back
  on the chest 44 -> 12 of 1,008. Whole-room twin A/B (that day's engine, 11 recorded 360s x 2):
  back print on the chest 7.3s in 15/22 runs -> 2.5s in 8/22. Shipped `30d35e9` (room only, no
  Worker change). One real production session (driver, clip m1, PEAK): readings every ~250ms
  through both swaps, BACK sent 4ms after the decision (ack 597ms), FRONT at the side (order -0.22)
  6ms after it (ack 542ms); the render showed the back print on the back.
- **2026-10-05 - THE LANDING, PROJECTED (CLAUDE.md §2.30):** "only fast turns fail". The 06:09
  (fast) and 05:55 records: the return's right reading had arrived and the rule missed it (by
  under 1 degree at 06:09) - it ignored the reading's age and used the turn's average speed. Now
  it projects with both and schedules between readings: the two fast sessions replay 250-290ms
  earlier, the slow one (06:11) within 64ms. Live: room `d7d63d7`, Worker `dddfa41e`; then a
  back-to-side jump in one reading counts as a step (`c781818`, Worker `32f73241`) - a real
  ~300 deg/s session had its return held for the chest by the snap filter. Real sessions this
  round: 3 (budget 50). One hit a congested uplink (image acks ~1.25s, the orientation link
  1.1s) - nothing to read from it.
- **2026-10-05 - every decision on a fresh pose reading (`528888a`, §2.31)** and **the session
  cap at the edge (`2839d9c`, Worker `83081607`, §2.32)**. Verified live: a fast real session
  (1.2x) read every tick 2-4ms fresh (was 4-215ms), BACK at ~60 degrees, FRONT by the
  projection at ~220 with a scheduled send - the render showed the back print on the back and
  the front print back on the chest, no back on the chest; a normal session after the cap ran
  15.6s end to end. One TEST session on a frozen machine stayed open ~5 minutes before the cap
  existed.
- **2026-10-05 - consistency (`300257f`, Worker `136acf18`, CLAUDE.md §2.30):** the landing model
  (13 recorded 360s x 4 phases, slow/normal/fast, the real measurement and engine) is now a
  test: the back print on a chest past 300 degrees 0ms / 20ms / 606ms (p90 42ms) over 48 turns at
  0.8x / 1x / 1.3x (was 730 / 1,330 / 1,960ms), never a third swap. The projection fires from -0.9
  (the order saturates near the back). A browser sweep in the twin could not run: the machine was
  on battery at load 52.
- **2026-10-05 17:25 report - "front perfect, the back disappears too fast" (§2.33):** a wrong
  shoulder scale (2x / 3-4x) made a reading at the back look like one coming round. The scale
  now re-learns from live readings and is aspect-proof; the projection needs a deep back.
  17:23 also had a mirrored skeleton through the whole back view - not fixed.
- **17:41 report - "the back on the front a little, and laggy":** the torso height learned in the
  gate (~2x) kept the order stale through the turn - it re-learns now too; and the tick-driven
  pose inference (§2.31) cost the camera 4-6 fps - off by default again.
- **18:10 report - "the back disappears too fast" (§2.34):** the front landed 0-100ms after the
  send (fast acks that evening), so the projection's lead and aim were recalibrated: the model
  lands the front median 270 at every speed, p10 251+.
- **18:21 / 18:22 report - "make the perfect one consistent" (§2.35):** the bad one had a rotation
  re-drape delaying the BACK 418ms, a phantom 63-degree step at the bottom of the back, and a
  camera that changed shape at go-live - all three fixed; replayed, the bad one now sends the
  front at the side and the good one keeps its timing. **Next: your measurement.**

## Hebrew/English i18n
- **Stage:** done (core).
- **Done:** language toggle + English strings `a7de91c`, `310b174`; geo-IP language
  lock fix + `fitting-room/i18n.js` module `4ecda99`; cart popover i18n `82de850`.
- **Remaining:** none recorded. New strings must go through `i18n.js`.

## Security hardening + client-code hiding
- **Stage:** in progress.
- **Done on main:** admin auth bypass / SSRF / secret leaks `e523cc3`; audit in
  `archive/SECURITY_AUDIT.md`.
- **On `hide/main-v2`:** public allowlist instead of serving the repo root `f7da87e`,
  minified client `4ce8fde`, admin dashboard removed `937bb4e`, prompt engine and size
  rules server-side (`897ab44`, `0eb6e8f`, `5ae486a`), vendor names refused by the build.
- **On `harden/hide-client-logic`:** the "solo" front|back experiment (v2–v6), pose
  in any light — experimental, not for main as-is.
- **Remaining:** review + merge plan for `hide/main-v2`.

## Landing / brand video
- **Stage:** done. Identity-screen brand video `e8d2c7f`
  (`/Commercial_video_for_a_tech_fa.mp4`, `fitting-room/index.html`); widget guide
  videos `widget/pear-ad.mp4`, `widget/pear-anmtion.mp4`. No open work in git.

## Black-screen on reopen
- **Stage:** done. Camera released on modal close `3a533d6`; live-camera bridge and
  orientation watcher retired when a window runs out `af5f4d4`.

## Other branches (not merged)
| Branch | Ahead / behind main | Note |
|---|---|---|
| `claude/project-thread-cr4uyn` | Phase 2 capture | size-guide capture CLI - your review |
| `size-capture-phase2-local` | — | the 2026-10-03 WIP as pushed from your machine; superseded by the branch above |
| `hide/edge` | merged into main 2026-10-04 | the hidden build - main now |
| `hide/main-v2` | superseded by `hide/edge` | not to be merged |
| `harden/hide-client-logic` | 46 / 10 | experiments |
| `fix/v142-angle-rollback` | 5 / 15 | camera AE/AWB pin — unmerged, decide |
| `feat/back-view-pipeline` | 1 / 63 | stale |
| `feat/vto-quality-gates-and-modularization` | 2 / 171 | stale |
| `vton-model-from-token-response` | 1 / 146 | stale |
| `rescue/*`, `rollback/*`, `restore-*` | — | safety snapshots; keep or prune |
