# PEAR — Virtual Fitting Room (Lucy VTON)

Self-contained feature module. Everything the virtual try-on needs lives in this
single folder; the root project only hosts the separate storefront and the secure
token proxy (`../server.js`).

## Structure

| File         | Responsibility                                                                 |
|--------------|--------------------------------------------------------------------------------|
| `index.html` | Two screens — Screen 1: size calculator · Screen 2: live try-on room.           |
| `config.js`  | **Single source of truth** for all timings + endpoints (see below).            |
| `app.js`     | All client logic: size calc, conditional form, camera, Lucy VTON realtime flow. |
| `style.css`  | Luxury white / royal-blue theme (Robosize-style compact calculator card).       |

## Configuration (`config.js`)

All tunable timings and endpoints live in `config.js` and are imported by `app.js`
as derived constants — nothing is hardcoded in the logic. Key values:

| Constant                  | Value                   | Notes                                  |
|---------------------------|-------------------------|----------------------------------------|
| `LIVE_DURATION_MS`        | `5000`                  | **Strict 5s live window — do not change.** |
| `CONNECT_TIMEOUT_MS`      | `12000`                 | Max wait for the realtime session.     |
| `HEALTH_PROBE_TIMEOUT_MS` | `4000`                  | Pre-use connectivity probe abort.      |
| `TOAST_DURATION_MS`       | `2600`                  | Toast lifetime.                        |
| `TOKEN_ENDPOINT`          | `/api/realtime-token`   | Mints the ephemeral `ek_` token.       |
| `HEALTH_ENDPOINT`         | `/api/health`           | Pre-use connectivity probe target.     |
| `SDK_URLS`                | esm.sh → jsDelivr        | Decart SDK CDN fallbacks.              |

## Flow

1. **Screen 1 — Size calculator.** User enters height + weight (mandatory). Optional
   measurements (chest / waist / legs) are revealed only once both mandatory fields
   are valid. `Enter` proceeds to the fitting room (or advances to the next field).
2. **Screen 2 — Live try-on.** A pre-use connectivity check runs before any session
   opens. Going live mints a short-lived `ek_` token from the proxy, connects Lucy
   VTON over WebRTC, applies the garment, and **auto-tears-down after a strict 5s**
   window so no tokens are spent past it.

## Do-not-touch invariants

- The 5-second live window (`LIVE_DURATION_MS`) and `autoStopAndFreeze` teardown.
- The secure token proxy in `../server.js` (the permanent `dct_` key never reaches
  the browser — only ephemeral `ek_` tokens do).
- The WebRTC connect / teardown lifecycle (`connectRealtime`, `teardown`, `stopLive`).
