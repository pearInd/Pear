# PEAR — project status

Living file. **Every task ends by updating it** (CLAUDE.md §9). Newest facts win.
Hashes are on `main` unless a branch is named. Stages: *not started · in progress ·
done · blocked*.

_Last updated: 2026-10-01 · main @ `ef1d28d` + this status commit_

## At a glance

| Workstream | Stage | Where |
|---|---|---|
| Children's sizing (kids/adult guard) | done (core); follow-ups open | main |
| Store size guides (Phase 0 + 1) | in progress — Phase 1 shipped, data capture pending | main (also re-cut server-side on `hide/main-v2`) |
| Ready-signal product signals fix | done | main `137188d` (merge of `3fb3c37`) |
| JSON-LD size list (proposal B) | done | main `bd766b2` |
| Size-chart "inches" backspace-byte bug | done | main `3345467` |
| garment_cache rows missing `age_group` | code done — backfill pending on you | main `ef1d28d` |
| `DECART_ALLOWED_ORIGINS` / token origin | in progress — fix on a branch only | `hide/main-v2` `f93ef87` |
| Back-image orientation (front/back on a turn) | in progress — active on a branch | main `3a9b55d`; `hide/main-v2` |
| Hebrew/English i18n | done (core) | main |
| Security hardening + client-code hiding | in progress — on a branch | main `e523cc3`; `hide/main-v2`, `harden/hide-client-logic` |
| Landing / brand video | done | main `e8d2c7f` |
| Black-screen on reopen | done | main `3a533d6`, `af5f4d4` |
| Visual QA gate | done, known flaky (§8.5) | main |
| Liquid Glass UI + consent gate | done | main `0827e51`, `89a5848` |

## Waiting on you (manual steps)

- [ ] **Run the size-guide dry runs** and send back the `COVERAGE_JSON` lines
      (fox.co.il, adidas.co.il, terminalx.com, castro.com):
      `node scanner/scan-store.js --size-charts --max-products=12 <url>`
- [ ] **Capture size guides** for stores worth it: `node scanner/scan-store.js --size-charts --save <url>`
      (needs `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`). Nothing is served to the room until this runs.
- [x] Migration **v15** (`store_size_charts`) — run (confirmed 2026-10-01).
- [ ] **Confirm which `garment_cache` migrations production has** (v8, v12, v13, v14).
      Code comments record production as *v9 + v11 without v8*; the `age_group` fix
      below no longer depends on the answer, but the diagnostics in v8 do.
- [ ] **`DECART_ALLOWED_ORIGINS` in Vercel** must list every production origin
      (e.g. `https://app.pear-ai.io`). Preview URLs are only covered once `f93ef87`
      (on `hide/main-v2`) reaches main.
- [ ] **Deploy main, THEN re-run the age_group backfill** (`cd scanner && node backfill-age-group.js`,
      `--dry-run` first if you like). Order matters: until `ef1d28d` is live, every try-on
      re-wipes the rows the backfill fills (see the age_group entry).
- [ ] **Decide the fate of `hide/main-v2`** — 39 commits ahead of `bd766b2` and now 5
      behind main (`bf879b7`, `137188d`, `3345467`, `ef1d28d`, this status commit); it
      needs main merged in before it can land.

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
- **Stage:** in progress. Phase 0 (measure) + Phase 1 (stored fallback, tie-break only,
  §2.5b unchanged) shipped in `bd766b2`. Phases 2–6 not started.
- **Done:** widget reads the PDP chart (`2026-09-17` spec); scanner `--size-charts`
  dry run + `--save` capture; `store_size_charts` (v15, run); `GET /api/store-size-chart`;
  room fallback with gender/type/overlap guards; EU/US aliases; `[PEAR] store chart vs
  default` log; generated scanner parser with a byte-identity test.
- **Remaining:** your coverage runs → decide Phase 2 (widget sightings, gender/type
  matching from live data) vs Phase 3 (vision for image/PDF charts). Smoke runs
  (3 products) showed: fox.co.il captured; terminalx and castro chart content is
  JS-loaded; adidas.co.il answers a plain client with a bot challenge / 403.
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
- **Stage:** code done (`ef1d28d`); data repair pending on you.
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
- **Remaining:** deploy, then re-run `scanner/backfill-age-group.js`. It targets every
  `age_group IS NULL` row; the cache-first live path never re-classifies them itself.

## `DECART_ALLOWED_ORIGINS` / token origin
- **Stage:** in progress.
- **Done:** CORS allowlist + own-host auto-allow (main, `server.js`); tokens scoped to
  the allowlist (main). `f93ef87` (`hide/main-v2` only): the token also names the
  requesting page's own origin — fixes "Origin not allowed" on a fresh preview.
- **Remaining:** `f93ef87` reaching main; the Vercel env var (manual, above).

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
| `hide/main-v2` | 39 / 0 at `bd766b2` | active — see above |
| `harden/hide-client-logic` | 46 / 1 | experiments |
| `fix/v142-angle-rollback` | 5 / 15 | camera AE/AWB pin — unmerged, decide |
| `feat/back-view-pipeline` | 1 / 63 | stale |
| `feat/vto-quality-gates-and-modularization` | 2 / 171 | stale |
| `vton-model-from-token-response` | 1 / 146 | stale |
| `rescue/*`, `rollback/*`, `restore-*` | — | safety snapshots; keep or prune |
