<!--
===============================================================================
  PEAR / MERIDIAN — SECURITY AUDIT REPORT
  Admin dashboard + backend API (server.js, admin.js, admin.html, lib/*,
  fitting-room/app.js)
  -----------------------------------------------------------------------------
  Date        : 2026-07-03
  Auditor     : Claude (automated security audit, authorized by repo owner)
  Scope       : Authentication/authorization, injection/input validation, CORS &
                headers, rate limiting, data/PII exposure, secrets, session/cookie
                security, and admin-specific risks (clickjacking, audit logging,
                destructive actions).

  EXECUTIVE SUMMARY — issues found by severity
    CRITICAL : 4   (all fixed in code; 2 require an out-of-band key revocation)
    HIGH     : 2   (all fixed in code)
    MEDIUM   : 4   (3 fixed in code, 1 documented)
    LOW      : 5   (3 fixed in code, 2 accepted risk)

  HEADLINE FINDINGS
    • CRIT-1  GET/DELETE /api/admin/sessions had NO auth middleware — anyone on
              the internet could read every session row and wipe the whole table
              with an unauthenticated request. FIXED.
    • CRIT-2  requireAdminAuth checked authentication but not authorization: any
              account that signs up against the PUBLIC anon key was treated as an
              admin. FIXED via an ADMIN_EMAILS allowlist.
    • CRIT-3/4 Two permanent Decart API keys are exposed in git (one in app.js
              history, one in the tracked .env.example). Code no longer uses them;
              THEY MUST BE REVOKED on platform.decart.ai.
    • HIGH-1  /api/img-proxy was a Server-Side Request Forgery primitive (fetched
              any caller-supplied URL). FIXED with a CDN host allowlist.

  ⚠ REQUIRED MANUAL ACTIONS (cannot be done from code — do these now):
    1. Revoke/rotate BOTH leaked Decart keys on https://platform.decart.ai:
         - dct_pearwww_kgYAhEHnig…  (committed in app.js history, commit 89cc4bb)
         - dct_last-one_hUguLSbP…   (committed in .env.example until this audit)
    2. Set ADMIN_EMAILS in your Vercel project env vars (Settings → Environment
       Variables) to your admin account email(s), comma-separated. Without it in
       production the admin API falls OPEN to any authenticated user (see CRIT-2).
    3. (Recommended) Rotate the Supabase service_role key — it lives only in the
       gitignored .env today, but rotate if it was ever pasted anywhere shared.
    4. (Recommended) Purge the leaked keys from git history (git filter-repo /
       BFG) and force-push, so the keys disappear from clones/forks.
===============================================================================
-->

# PEAR — Security Audit Report

**Date:** 2026-07-03 · **Scope:** admin dashboard + all backend endpoints
(`server.js`, `admin.js`, `admin.html`, `lib/supabase.js`, `lib/sheets.js`,
`fitting-room/app.js`, `config.js`, `.env*`).

---

## 1. Executive Summary

| Severity | Found | Fixed in code | Mitigated / Action required | Accepted |
|----------|:-----:|:-------------:|:---------------------------:|:--------:|
| CRITICAL | 4 | 2 | 2 (revoke keys) | 0 |
| HIGH     | 2 | 2 | 0 | 0 |
| MEDIUM   | 4 | 3 | 1 (documented) | 0 |
| LOW      | 5 | 3 | 0 | 2 |
| **Total**| **15** | **10** | **3** | **2** |

All CRITICAL and HIGH code defects are fixed. The two remaining CRITICAL items are
leaked API keys that **must be revoked on the Decart platform** — code can stop
using them (done) but cannot invalidate them.

---

## 2. Findings

### CRIT-1 — Unauthenticated admin alias routes (full read + table wipe)
**Severity:** CRITICAL · **Status:** ✅ FIXED

**Description.** The canonical routes were guarded, but the back-compat aliases were not:
```js
app.get("/api/sessions",  requireAdminAuth, getSessions);   // guarded
app.delete("/api/sessions", requireAdminAuth, clearSessions); // guarded
app.get("/api/admin/sessions",    getSessions);    // ← NO AUTH
app.delete("/api/admin/sessions", clearSessions);  // ← NO AUTH
```
**Exploit scenario.** Any anonymous caller runs `GET /api/admin/sessions` to
exfiltrate every session row (measurements, garments, timestamps, session IDs), or
`DELETE /api/admin/sessions` to permanently destroy all analytics data — no token
required. This completely nullifies the login gate.

**Fix applied.** Both aliases now carry `requireAdminAuth`. Verified at runtime:
unauthenticated `GET`/`DELETE /api/admin/sessions` now return **HTTP 401**.

---

### CRIT-2 — Authentication accepted as authorization (any signed-up user = admin)
**Severity:** CRITICAL · **Status:** ✅ FIXED (with a documented fail-open default)

**Description.** `requireAdminAuth` verified the Supabase JWT with `getUser()` but
performed **no authorization check**. The fitting room ships the **public anon key**
(`admin.js`), and Supabase Auth sign-up is reachable with that key. So any member of
the public who registers an account receives a valid JWT that passed the admin gate.

**Exploit scenario.** Attacker calls Supabase Auth `signUp` with the public anon key
(readable in `admin.js`), confirms their own email, obtains an `access_token`, and
uses it as `Authorization: Bearer …` to read all users' **names + phone numbers**
(PII) via `/api/admin/users` and wipe sessions via `/api/sessions`.

**Fix applied.** `requireAdminAuth` now enforces an `ADMIN_EMAILS` allowlist: the
verified `user.email` must be present or the request is rejected with **403**. The
verified email is attached to `req.adminEmail` for audit logging.
- `ADMIN_EMAILS` added to `.env` (seeded with the owner email) and `.env.example`.
- **Fail-open note:** if `ADMIN_EMAILS` is empty the middleware still authorizes any
  authenticated user but logs a loud warning each request. This preserves existing
  functionality when the env var is not yet deployed. **You must set `ADMIN_EMAILS`
  in Vercel** to fully close this in production. (A stricter deny-by-default posture
  is recommended once every admin email is enrolled.)

---

### CRIT-3 — Permanent Decart API key committed in git history (`app.js`)
**Severity:** CRITICAL · **Status:** ⚠ MITIGATED — key must be revoked

**Description.** Commit `89cc4bb` ("use direct API key in app.js") hardcoded a
permanent client-side key:
`const DECART_API_KEY = "dct_pearwww_kgYAhEHnig…";`. The current code correctly mints
short-lived `ek_` tokens server-side and the live `.env` no longer contains this key
(it was rotated), but the value is permanent in git history.

**Exploit scenario.** Anyone with repo/clone/fork access recovers the key from history
and bills Decart usage to your account until it is revoked.

**Fix applied.** Code already uses the secure ephemeral-token proxy; the key is not in
the working tree. **Action required:** revoke `dct_pearwww_kgYAhEHnig…` on
platform.decart.ai and purge it from history (BFG/filter-repo).

---

### CRIT-4 — Real Decart key committed in tracked `.env.example`
**Severity:** CRITICAL · **Status:** ✅ FIXED in code — key must be revoked

**Description.** `.env.example` is tracked in git and contained a real, valid-format
permanent key: `dct_last-one_hUguLSbP…` (distinct from the live key). Example files
are committed, so this key is exposed to anyone with the repo.

**Fix applied.** Replaced the value with the placeholder `dct_your_permanent_key_here`
and added a warning comment. **Action required:** revoke `dct_last-one_hUguLSbP…` on
platform.decart.ai and purge it from history.

---

### HIGH-1 — Server-Side Request Forgery (SSRF) in `/api/img-proxy`
**Severity:** HIGH · **Status:** ✅ FIXED

**Description.** `/api/img-proxy?url=` fetched **any** caller-supplied http(s) URL
server-side and returned the body (with `Access-Control-Allow-Origin: *`). Only the
protocol was validated — no host restriction.

**Exploit scenario.** `GET /api/img-proxy?url=http://169.254.169.254/latest/meta-data/`
to reach cloud metadata, or point it at internal services / `localhost`, or abuse the
server as an anonymizing open relay to burn your bandwidth.

**Fix applied.** Added `isProxyHostAllowed()` — a hard allowlist of the exact retail
CDN hosts the catalog uses (`cdn.suitsupply.com`, `image.hm.com`,
`images.unsplash.com`, `*.shopifycdn.com`, `*.shopify.com`, `img.magnific.com`,
`img.freepik.com`, `live.staticflickr.com`, `www.universalcolours.com`), plus an
explicit block on IP literals and internal-looking hostnames. Verified at runtime:
metadata IP, `localhost`, and arbitrary hosts → **403**; allowlisted CDN → passes.

---

### HIGH-2 — Open debug endpoint leaks secrets and allows arbitrary writes
**Severity:** HIGH · **Status:** ✅ FIXED

**Description.** `GET /api/test-sheets` was unauthenticated and echoed the
`GOOGLE_SHEET_ID` value and the `GOOGLE_SERVICE_ACCOUNT_EMAIL` value in its JSON
response, and wrote a test row to the sheet on every call.

**Exploit scenario.** Anyone hits the URL to learn the private spreadsheet ID and the
service-account identity (useful for further targeting) and to spam junk rows into the
analytics sheet.

**Fix applied.** Endpoint now requires `requireAdminAuth`, and even for admins it
reports only presence (`✓ present`) rather than the secret **values**. Verified:
unauthenticated call → **401**.

---

### MED-1 — No rate limiting (registration spam / table flood / token-cost abuse)
**Severity:** MEDIUM · **Status:** ✅ FIXED (best-effort)

**Description.** `POST /api/users`, `POST /api/sessions`, `POST /api/track-tryon`,
`/api/img-proxy`, and the `ek_` token mint had no throttling. An attacker could create
thousands of fake users, flood the sessions table, or spam the (billable) token mint.

**Fix applied.** Added a lightweight in-memory sliding-window limiter per client IP:
token mint 30/min, sessions 40/min, users 20/min, track 60/min, img-proxy 120/min
(HTTP 429 on exceed). **Limitation:** on Vercel each warm instance keeps its own
counters, so this is a casual-abuse brake, not a distributed guarantee — for hard
limits put Upstash/Redis or the platform WAF in front. Supabase Auth also applies its
own server-side rate limiting to admin login attempts.

---

### MED-2 — Clickjacking: admin page could be framed
**Severity:** MEDIUM · **Status:** ✅ FIXED

**Description.** No `X-Frame-Options` / CSP `frame-ancestors` was set, so `admin.html`
could be embedded in a malicious iframe for clickjacking of the Clear-all / logout
controls.

**Fix applied.** Global security-headers middleware sets `X-Content-Type-Options`,
`Referrer-Policy`, and `Strict-Transport-Security` on all responses; the admin surface
additionally gets `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors
'none'`, and `Cache-Control: no-store`. The rest of the site uses `SAMEORIGIN` /
`frame-ancestors 'self'` so the storefront can still embed the fitting room. Verified
on `admin.html` at runtime.

---

### MED-3 — Unauthenticated PII exposure via `GET /api/users/:deviceId`
**Severity:** MEDIUM · **Status:** ✅ FIXED

**Description.** The public returning-visitor lookup returned the **entire** user row,
including the **phone number**, to anyone who supplies a `device_id`. Device IDs are
random UUIDs (so mass enumeration is hard), but any leaked/shared device ID exposed PII
from an unauthenticated endpoint.

**Fix applied.** Added `publicUser()` which strips the row to `{ id, name, created_at }`
— the only fields the client needs to recognize a returning visitor. Phone numbers are
now returned **only** by the auth-gated admin API. Applied to both the device lookup and
the `POST /api/users` response.

---

### MED-4 — CORS falls open to all origins when `DECART_ALLOWED_ORIGINS` is unset
**Severity:** MEDIUM · **Status:** 📝 DOCUMENTED / MITIGATED

**Description.** When `DECART_ALLOWED_ORIGINS` is empty, `isOriginAllowed()` reflects
any `Origin`. CORS does not protect against non-browser clients (curl ignores it) and
the API uses bearer tokens rather than cookies, so this is not a direct auth bypass —
but it removes a layer of storefront-origin enforcement.

**Assessment / action.** The production `.env` already sets
`DECART_ALLOWED_ORIGINS=…vercel.app`. Ensure the same is set in Vercel env vars. Left
as-is in code to avoid breaking preview deployments; documented here as the intended
production configuration.

---

### LOW-1 — Verbose auth debug logging leaked the admin token to the console
**Severity:** LOW · **Status:** ✅ FIXED

**Description.** `admin.js` logged `JSON.stringify({ data, error })` from
`signInWithPassword`, which includes `data.session.access_token` /`refresh_token`, plus
the anon-key prefix and confirmed email — persisting live admin credentials in the
browser console.

**Fix applied.** Removed the verbose block; sign-in failures now log only a status code
and error name, never tokens or keys.

---

### LOW-2 — `/api/health` information disclosure
**Severity:** LOW · **Status:** ✅ ACCEPTED RISK

`/api/health` returns `{ decart, model, keySource, ttl }`. This is low-value
operational metadata (no secret values) and is used by the fitting-room pre-flight
probe. Left unchanged.

---

### LOW-3 — No audit logging of destructive admin actions
**Severity:** LOW · **Status:** ✅ FIXED

`clearSessions` now logs the authenticated admin's email
(`req.adminEmail`) alongside the wipe, so destructive actions are attributable.

---

### LOW-4 — Admin session stored in `localStorage` (XSS token theft)
**Severity:** LOW · **Status:** ✅ MITIGATED / ACCEPTED

Supabase Auth stores the session in `localStorage` by default, which is readable by any
XSS. The admin dashboard renders **all** user-supplied fields (name, phone, garment
name, size, IDs) through an HTML-escaping helper (`esc()`), so no stored-XSS sink was
found — the token-theft precondition is mitigated. Moving to cookie-based sessions would
be a larger architectural change; accepted for now with escaping as the control.

---

### LOW-5 — Missing HSTS / transport hardening
**Severity:** LOW · **Status:** ✅ FIXED

`Strict-Transport-Security` is now emitted on all responses. HTTPS itself is enforced by
the Vercel platform (HTTP is redirected to HTTPS).

---

## 3. Checked — no vulnerability / no change needed

- **SQL injection:** All DB access uses the Supabase JS client with parameterized
  `.eq()/.insert()/.select()` calls. No raw SQL string concatenation exists anywhere in
  `server.js`, `lib/supabase.js`, or `lib/sheets.js`. Not vulnerable.
- **Stored XSS in the admin dashboard:** Every dynamic value rendered via `innerHTML`
  (`renderRows`, `loadUsers`, `renderRankList`) is passed through `esc()` (escapes
  `& < > " '`). No unescaped user content sink found.
- **Service-role key exposure:** `SUPABASE_SERVICE_ROLE_KEY` is read only in
  `lib/supabase.js` (server-side) and never sent to the browser. The key embedded in
  `admin.js` is the **anon** key (`role":"anon"`), which is public by design. Confirmed
  no service-role JWT is present in any browser-served file or git history.
- **`.env` secrecy:** `.env` is gitignored and has never been tracked (verified via
  `git log --all -- .env`). Row-Level Security is enabled on `sessions` and `users`
  with a service-role-only policy.
- **Token expiry / re-auth:** `admin.js` re-reads the session on each request
  (`getSession()` → auto-refreshed token) and, on any `401`, signs out and returns to
  the login screen — it does not silently fail open. A working logout
  (`auth.signOut()`) is present. The destructive "Clear all" action is behind a
  `confirm()` dialog.

---

## 4. What was NOT changed, and why

1. **The two leaked Decart keys are not (and cannot be) invalidated from code.** Revoke
   them on platform.decart.ai and purge git history — this requires access to your
   Decart account and a history rewrite/force-push, which are owner actions.
2. **`ADMIN_EMAILS` fail-open default was kept** (warn instead of hard-deny when unset)
   to avoid locking you out of production before the env var is deployed. Recommend
   switching to deny-by-default after enrolling every admin email in Vercel.
3. **CORS open-fallback behavior was left in place** so preview/dev deployments keep
   working; production safety depends on `DECART_ALLOWED_ORIGINS` being set (it is, in
   the current `.env`).
4. **Cookie-based admin sessions were not introduced.** The `localStorage` XSS exposure
   is mitigated by output escaping; a cookie/session-store migration is a larger change
   outside this audit's fix scope.
5. **A distributed rate-limiter was not added.** The in-memory limiter is sufficient as
   a casual-abuse brake; a shared store (Upstash/Redis) or WAF is the production-grade
   upgrade if abuse is observed.

---

## 5. Files changed

| File | Change |
|------|--------|
| `server.js` | Admin allowlist (`ADMIN_EMAILS`) + authorization in `requireAdminAuth`; auth added to `/api/admin/sessions` aliases; SSRF host-allowlist on `/api/img-proxy`; per-route rate limiters; global + admin-strict security headers; `/api/test-sheets` gated and value-redacted; public user responses stripped of PII; admin-action audit logging |
| `admin.js` | Removed verbose auth debug logging that leaked the session token / anon key |
| `.env` | Added `ADMIN_EMAILS` (seeded with owner email) — gitignored |
| `.env.example` | Replaced the real Decart key with a placeholder; added `ADMIN_EMAILS` |
| `SECURITY_AUDIT.md` | This report |

*No existing functionality was removed. All changes verified against a running server:
admin routes reject unauthenticated/bogus tokens, SSRF payloads are blocked while
legitimate CDN images pass, and the fitting-room token/proxy flows are unchanged.*
