# Live (dynamic) Lucy VTON — transition blueprint

Read-only audit of `server.js`, `pear-demo/app.js`, `.env.example`. **No code changed.**

---

## 0. Headline finding (read first)

The realtime engine is **already wired**. `pear-demo/app.js` already:

- loads the SDK, calls `client.realtime.connect(localStream, { model, onRemoteStream, onConnectionChange })`
- receives the AI-edited WebRTC stream in `onRemoteStream` → assigns it to `#aiVideo`
- applies garments dynamically via `rtClient.set({ prompt, image })`

The garment **already warps and tracks** — that is what the Lucy realtime model does on the live stream. The current code **throws that away**: `capture()` (app.js:415) waits for ONE good AI frame, freezes it to `#resultCanvas` via `freezeFrom()`, then calls `teardown()` immediately. CSS keeps `#aiVideo { display:none }` (style.css:249) and only shows the frozen canvas (`.show-result`).

**So this is NOT a model/endpoint swap.** It is a **UX + lifecycle change**: stop freezing, keep the live `#aiVideo` on screen, gate it with explicit Go-Live / Stop controls.

There is **one real defect to fix in the same pass** (security + token leak): app.js:27 hardcodes the permanent `dct_` key in the browser and bypasses the proxy.

---

## 1. COMPATIBILITY CHECK — what swaps

### SDK methods — NOTHING new needed
All required calls already exist and are correct for live mode:

| Call | Location | Live-mode role |
|---|---|---|
| `createDecartClient({ apiKey })` | app.js:334 | unchanged — but `apiKey` must become an `ek_` token (see §2) |
| `client.realtime.connect(stream, opts)` | app.js:338 | unchanged — opens the WebRTC session |
| `onRemoteStream(editedStream)` | app.js:347 | the live dynamic feed — keep it **visible** instead of freezing |
| `rtClient.set({ prompt, image })` | app.js:399 | dynamic garment swap **without reconnect** — already called from `setActiveItem` when `isLive()` |
| `onConnectionChange` / `getConnectionState` | app.js:352/363 | drives badge — unchanged |
| `rtClient.disconnect()` | app.js:321/375 | session kill — unchanged |

### Client UX/control changes (app.js + index.html + style.css)

1. **Repurpose the capture button into a live toggle.** `capture()` (app.js:415) currently: connect → apply → `waitForAiFrame` → `freezeFrom` → `teardown`. New "Go Live" path: connect → apply → **stop here, leave session open**. Remove the `freezeFrom` + `teardown` tail.
2. **Show the live stream.** Flip CSS: `#aiVideo` must become `display:block` (and webcam hidden) while live, instead of the `.show-result`/`#resultCanvas` path (style.css:249-252). Add a `.live-result` class or reuse `.live`.
3. **Add an explicit "Stop" control** wired to `teardown()` (app.js:373) — this is the billing kill switch the user controls.
4. **Retire single-shot artifacts** for live mode: `freezeFrom` (app.js:473), `waitForAiFrame` (app.js:459), `#resultCanvas`, `retakeBtn`, `show-result`. Keep `freezeFrom` only if you still want an optional "snapshot/save photo" button off the live stream.
5. **Garment swap = already correct.** `setActiveItem` → `applyGarment` → `rtClient.set()` swaps the garment on the live stream with no reconnect. Verify it stays on this path (do NOT add a reconnect per swap — that would mint extra sessions).
6. **Listeners already present, keep them:** `beforeunload`, `pagehide`, `visibilitychange→hidden` all call `teardown()` (app.js:752-756). These are the leak guards.

### Server endpoints — NOTHING swaps
`server.js` already exposes `/api/realtime-token` (+ `/api/tryon` alias) minting `ek_` tokens via the SDK→REST waterfall. No new route needed. The only change is that the **browser must actually call it** again (see §2).

---

## 2. TOKEN EFFICIENCY — exact-consumption lifecycle

### The regression to fix
`pear-demo/app.js:27` hardcodes the permanent `dct_` key and `connectRealtime()` calls `createDecartClient({ apiKey: DECART_API_KEY })` with it directly (commit 89cc4bb "remove backend proxy dependency"). This:
- ships the permanent key to every browser (security hole), and
- defeats per-session scoping/origin-locking that bounds token blast-radius.

### Target lifecycle (mint late, kill early, one session)

```
page load            → NO token, NO session  (idle, zero cost)
user clicks Go Live  → fetch /api/realtime-token  → ek_ token (scoped, short TTL)
                     → createDecartClient({ apiKey: ek_token })
                     → client.realtime.connect()        ← billing starts HERE
garment swap         → rtClient.set()                   ← NO new token, NO reconnect
user clicks Stop     → rtClient.disconnect()             ← billing stops immediately
leave/hide tab       → teardown() (already wired)        ← billing stops immediately
```

Rules to guarantee zero waste:

1. **Mint the `ek_` token on Go-Live, not on page load.** A minted-but-unused token costs nothing, but minting on demand keeps TTL meaningful and avoids stale tokens.
2. **One session per live sitting.** Connect once; every garment change goes through `rtClient.set()`. Never reconnect to swap garments.
3. **`connectRealtime()` already closes a stale client before opening a new one** (app.js:320-324) — keep that guard; it prevents orphaned double sessions.
4. **`disconnect()` is the billing boundary, not TTL.** ek_ TTL only bounds the connect handshake window; active sessions survive expiry (per `.env` comment). So a short TTL is fine and safer.
5. **Idempotent teardown.** Ensure `teardown()` is safe to call twice (Stop then pagehide) — it already null-checks `rtClient`.
6. **Re-Go-Live mints a fresh token.** After Stop, the old ek_ may be expired; next Go-Live fetches a new one.

### Concretely in code
- In `connectRealtime()` (app.js:314): replace `createDecartClient({ apiKey: DECART_API_KEY })` with:
  - `const r = await fetch('/api/realtime-token').then(r => r.json());`
  - `createDecartClient({ apiKey: r.apiKey });`  (handle `r.error` → show badge error, abort)
- Delete the hardcoded `DECART_API_KEY` constant (app.js:27).

---

## 3. PRE-REQUISITES — env / config gaps

Current real `.env` keys: `DECART_API_KEY`, `DECART_VTON_MODEL=lucy-vton-latest`, `DECART_TOKEN_TTL=600`, `PORT=3000`.

| Item | Status | Action |
|---|---|---|
| `DECART_ALLOWED_ORIGINS` | **read by server.js:38 but absent from `.env`/`.env.example`** | Add it (e.g. `http://localhost:3000,https://<your-vercel-domain>`). Origin-locks the `ek_` token so a leaked token can't be replayed off-site — direct token-efficiency/security win. |
| `DECART_TOKEN_TTL` | 600s | Lower to ~120s. Token only needed at handshake; active session survives expiry. Shorter = smaller leaked-token window. |
| `DECART_VTON_MODEL` | `lucy-vton-latest` ✓ | OK. Confirm against docs.platform.decart.ai realtime VTON model id. |
| Key consistency | **mismatch** | `.env` has `dct_last-one_…`; app.js:27 has a different `dct_pearwww_…`. Pick the canonical permanent key; it lives **only** server-side after §2. |
| Stream params (`fps/width/height/urlPath`) | hardcoded app.js:339-344 | Optional: leave hardcoded for now. Only externalize to config if you need per-deploy tuning. Higher fps/resolution = more compute = more cost — keep 30fps/1088×624 unless quality requires more. |
| Static-image endpoint | n/a | None exists — Lucy VTON is realtime-only ([[reference_decart_lucy_vton]]). The frozen-canvas was a client-side fake of "still" output. Nothing to provision. |

---

## 4. Step-by-step checklist (execution order, when approved)

1. **Server stays as-is.** Verify `/api/realtime-token` returns `{ apiKey: "ek_…", expiresAt, model }` (`curl http://localhost:3000/api/realtime-token`). Fix waterfall only if it 502s.
2. **`.env`:** add `DECART_ALLOWED_ORIGINS`, lower `DECART_TOKEN_TTL` to ~120, reconcile the permanent key. Update `.env.example` to document `DECART_ALLOWED_ORIGINS`.
3. **app.js — token:** delete hardcoded `DECART_API_KEY` (line 27); in `connectRealtime()` fetch `ek_` from `/api/realtime-token` and pass it to `createDecartClient`. Handle error response.
4. **app.js — live UX:** split `capture()` into `goLive()` (connect + apply, no freeze, no teardown) and keep `teardown()` as `stopLive()`. Remove the `freezeFrom`/`waitForAiFrame`/`teardown` tail from the live path.
5. **index.html:** relabel `#captureBtn` → "Go Live"; add a "Stop" button; keep `#retakeBtn` only if you want an optional snapshot.
6. **style.css:** make `#aiVideo` visible during live (`display:block`) and hide `#webcam`; drop reliance on `.show-result`/`#resultCanvas` for the live path.
7. **Verify garment swap stays on `rtClient.set()`** (no reconnect) — test by switching items while live and confirming a single session in the Decart dashboard.
8. **Leak test:** Go Live → confirm session active; Stop → confirm session closes in dashboard within seconds; close tab mid-session → confirm `pagehide`/`visibilitychange` teardown closes it.
9. **Optional:** keep `?demo=1` mock fallback for offline dev (app.js:444) — it still works without changes.

### Net surface area
- **No new SDK methods, no new endpoints.** Realtime warp/tracking is inherent to the model already in use.
- **3 files touched:** `pear-demo/{app.js,index.html,style.css}` + `.env`.
- **Biggest single win:** removing the hardcoded browser key and routing through the existing `ek_` proxy (fixes both security and strict token consumption at once).
