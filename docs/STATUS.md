# PEAR — project status

Living file. **Every task ends by updating it** (CLAUDE.md §9). Newest facts win.
Hashes are on `main` unless a branch is named. Stages: *not started · in progress ·
done · blocked*.

_Last updated: 2026-10-10 · branch merge/edge-main (preview-oct8): rear-photo mask, the head out of frame, the tick waits for a fresh pose reading, the full look in AI Auto; the 10-09 changes REVERTED (not on main)_

## At a glance

| Workstream | Stage | Where |
|---|---|---|
| Children's sizing (kids/adult guard) | done (core); follow-ups open | main |
| Store size guides (Phase 0 + 1 + store-chart decides) | in progress — shared-parser fixes, all-charts key (v16) and the store-chart decision shipped `0fccee8`, and run server-side since the merge (`lib/sizing.js`, proven identical over 146,440 cases - CLAUDE.md §2.27); **v16 migration + 3 re-saves waiting on you**; next: Phase 2 (not started) | main |
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

- [ ] **Run `archive/supabase_setup_v16.sql`** in the Supabase SQL editor (adds `size_system` to
      `store_size_charts`' unique key; safe to re-run, changes no row). Until it runs, every
      `--save` writes NOTHING and prints "run archive/supabase_setup_v16.sql" (verified on castro
      2026-10-03). Confirm with: `SELECT indexname FROM pg_indexes WHERE tablename = 'store_size_charts';`
      → `store_size_charts_key_v16_idx` present, `store_size_charts_key_idx` gone.
- [ ] **Then re-save the three stores** (from `scanner/`, where its `.env` lives):
      `node scan-store.js --size-charts --save https://www.castro.com` — adds the women's EU 32–46
      chart the old key dropped (dry run 2026-10-03: 3 charts, was 2);
      `node scan-store.js --size-charts --save https://www.fox.co.il` — dry run shows the same 11
      charts as before (no chart was lost to the old key there); re-save refreshes them;
      `node scan-store.js --size-charts --save https://www.adidas.co.il` — **blocked from this
      machine today** (home page HTTP 403, twice; not probed further). Run it when adidas answers you.
      Verify: `GET /api/store-size-chart?host=castro.com` should list women/tops twice (alpha + numeric).

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
  Phases 2–6 not started.
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
- **Remaining:** the v16 run + re-saves above. **Phase 2** (widget sightings) — approved, not
  started; the only route to terminalx (out of scope for now). Phase 3 (vision) has zero
  measured demand. Known limits: (a) a product sold in NUMERIC tops sizes (EU 34–46) is routed
  to bottoms by `isPantsProduct()`'s size-run tier (pre-existing), so a numeric women's TOPS
  chart (castro's EU table) is stored but today only usable through its letter aliases;
  (b) with only height+weight, the estimate decides only when the body sits well inside a band
  — near a band edge, or with the shopper's gender unset, it abstains (by design); (c) the
  men's waist coefficient is calibrated on a derived column (weakest of the three); (d) the
  widget's PDP chart never decides (no audience labels) — it stays a tie-break; (e) the adidas
  "unknown/adult/tops" exclusion above is open.
- **Open decisions:** `hide/main-v2` moved this logic server-side (`b2ac5ad`, `dae0138`) —
  which shape is canonical once that branch lands.

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
  front at the side and the good one keeps its timing.
- **Three sessions the next night - "almost perfect, a tiny bit later; no stutters":** the return's
  aim 280 -> 290 (model median 275-278, p10 259+), and no re-drape inside the window in AI Auto.
- **2026-10-07 13:53 report - "the angles are not accurate, it disappears too fast" (CLAUDE.md §2.36):** eight of your
  clips through the pose model, each lined up with its record: the engine puts a swap on frames taken ~0.1s BEFORE the
  send (0.31s before to 0.02s after, by session) - every aim since 10-05 was tuned on ~80ms after. Recalibrated (the
  projection's lead from the measured delay, aim 280, it may wait past the side): on your own clips the landing median
  266 -> 277.5, the two fast turns that put the back on the chest 294 -> 282 and 305 -> 292. Today's session moves only
  251 -> 253 (its engine held the most frames, and its output stood still at ~255). That session-to-session spread needs
  the lag measured live: TEST records now carry it (`lag`, passive). No Decart credit used.
- **2026-10-08 07:31 report - "almost perfect; the back disappears too early, frames with nothing on the back"
  (CLAUDE.md §2.37):** the pose model read your back as facing the camera for one reading and the back was withdrawn on
  it. Now one reading can't do that (two in a row are needed, a reading is voted once), and a back confirmed by the
  shoulder order arms the return at the side: replayed on its own clip, the front lands ~308 instead of ~210. Its record
  also carries the first live lag reading (median 1,081ms). No Decart credit used.
  **Next: your measurement - 2-3 sessions calibrate the live lag.**
- **2026-10-08 11:40-11:41 report - "front and back work perfectly; the model from the store photo appeared in the first
  measurement, and it put a necklace on me" (CLAUDE.md §2.38):** the 11:40 record shows the output leaving the camera for
  ~1.4s of the back view - the store's rear photo (a man with his back to the camera) drawn instead of you. The rear photo
  is now sent with the model painted out above the collar and below the hem (same size, the print in the same place); the
  front is untouched. The necklace is the engine's own (not in any photo, prompt or your shirt): one sentence, sent only
  in TEST sessions until you have measured it. Swap timing untouched. No Decart credit used. Committed on
  `merge/edge-main` (endpoint `b19d697` + the room); **the push to main and the Worker deploy wait on your OK.**
- **2026-10-08 15:29 preview measurement - "it changed the shirt to the colour of the shirt I'm wearing; the angles are fine"
  (CLAUDE.md §2.38):** the necklace sentence (TEST sessions only) made the engine keep your own shirt. Removed entirely;
  the prompts are byte-identical to production again. The back-photo mask and the angle logic are unchanged. The
  necklace is open again.
- **2026-10-08 11:45 report - "the front and back of the shorts got mixed up" (CLAUDE.md §2.39):** the shorts session was
  framed from the neck down; without the head the pose model read your back as the front and the FRONT went out with your
  back to the camera. The room now notices a head out of frame (never on the nine head-in sessions on record) and the
  engine counts which side you face instead of reading it: on that session's own record the back now holds through the
  back view and the front returns at the side. No Decart credit used. Needs the same push + Worker deploy.
- **2026-10-08 15:43 preview measurement - "the back wasn't right at the back, it took time to load; it put a necklace on
  me that disappeared after the turn" (CLAUDE.md §2.38, §2.40):** the back went out one pose reading late - every decision
  of that session ran on a reading ~200ms old (the pose timer and the decision timer at their worst phase; about a third
  of the 33 records), so it went out at the side instead of at ~60 degrees. The decision now waits for the pose loop's next
  reading when its own is stale (no extra pose inference - the 10-05 attempt that ran one cost camera fps); modelled on 11
  recorded 360s: the back on the same reading, a median 10 degrees sooner (up to 23), the return unchanged. Browser only -
  no Worker deploy for it. The necklace: the first sentence removed it but kept your shirt's colour; the second wording,
  "Clean, unadorned neckline." (no garment, nothing "worn"), goes out in TEST sessions only. No Decart credit used.
  On `preview-oct8` only; **nothing on main.**
- **2026-10-09 10:51-10:53 preview measurement - "the shirt works well but doesn't feel smooth; the shorts went crazy at the end
  and went away at the wrong time" (CLAUDE.md §2.41):** the fresh-reading fix works live (every decision on a reading 2-52ms
  old, was ~200). The shorts' front came back ~130ms late: its image is bigger (316 KB) and slower than the back's, and the
  timing used the average of both - now each image its own pace (replayed: the front out ~110ms sooner). Smoothness: the
  render's frames arrive in bursts (two close, then a ~200ms gap); the receiver now buffers 150ms instead of 80 (about 70ms more
  delay on screen, no change in where the swaps land), and a TEST session records where the bursts come from. No Decart
  credit used. On `preview-oct8` only; **nothing on main.**
- **2026-10-10 19:13-19:15 preview measurement - "what you did broke it, put it back" (CLAUDE.md §2.38, §2.41):** the shirt
  came back from the turn as a bare chest with the print on the skin (the neckline sentence), and the shorts opened on your
  own shorts for 2.4s. Both 10-09 commits reverted (`44c114a`, `5f50349`); the fresh-reading tick (`77acef0`) stays - it
  changes no picture.
- **2026-10-10 verified through the engine (3 real sessions, owner's cap 80 credits):** a driver opens the FOX product page,
  injects the preview widget (TEST key; the widget's demo flag only skips the e-mail sign-up), and feeds the room the owner's
  own recorded 360 as the camera. PEAK shirt (record `mv2m9wyl`): the PEAK front from the first second over a white jersey,
  the back print from the three-quarter back on, the front back at the end, no bare chest. CHICAGO shorts (`mv2mgezp`): the
  product from the first second over green shorts, the stripe at the sides, the plain back, the front back at the end. The
  first session (`mv2m2wmf`) was spent on a driver mistake - the room opened without the widget, so no classifier verdict
  arrived and after its 30s gate it went live with the gallery's SECOND photo (a three-quarter front) as the back: a real
  fallback that breaks §2.1 when the classifier never answers - **open, not fixed**.
- **2026-10-10 "make both work well at the same time" - the full look (CLAUDE.md §2.42):** with garments that have back
  photos only the shirt's photo reached the engine, and FOX had no way to put two products together. Now: one combined image
  per side (shirt + shorts front / shirt + shorts back), the shirt cut to its own band, and the room remembers what you tried
  so the shorts' page offers your shirt under "Complete the Look". Verified on the preview through the engine - see below.

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
| `hide/edge` | merged into main 2026-10-04 | the hidden build - main now |
| `hide/main-v2` | superseded by `hide/edge` | not to be merged |
| `harden/hide-client-logic` | 46 / 10 | experiments |
| `fix/v142-angle-rollback` | 5 / 15 | camera AE/AWB pin — unmerged, decide |
| `feat/back-view-pipeline` | 1 / 63 | stale |
| `feat/vto-quality-gates-and-modularization` | 2 / 171 | stale |
| `vton-model-from-token-response` | 1 / 146 | stale |
| `rescue/*`, `rollback/*`, `restore-*` | — | safety snapshots; keep or prune |
