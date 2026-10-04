# PEAR — project status

Living file. **Every task ends by updating it** (CLAUDE.md §9). Newest facts win.
Hashes are on `main` unless a branch is named. Stages: *not started · in progress ·
done · blocked*.

_Last updated: 2026-10-04 · main @ `93e2c01` + the merge of `hide/edge` (`1f5a4c2`) - the hidden build is main now_

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
| Back-image orientation (front/back on a turn) | in progress — the engine on Cloudflare, the front at the side (CLAUDE.md §2.23-§2.25); waiting on a real measurement | main (merged from `hide/edge`) |
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
- **Done on main:** angle thresholds `3a9b55d`, post-peak lock `c75307a`, presence
  `38cc621`, real back photo per orientation `8a4087f`, prompt orientation `0488167`.
- **On `hide/main-v2` only:** orientation engine moved behind a WebSocket
  (`854d629`), Cloudflare Worker (`155065b`, not deployed), return-leg timing
  `e7fc1d2` ("the back disappears too fast"), back sent once before reveal `7f627aa`.
- **Remaining:** land or retire that branch; deploy decision for the Worker.

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
