# pear-orient — the front/back decision, on Cloudflare

The room's AI Auto turn logic (`lib/orient-engine.js`, CLAUDE.md §2.14) runs here so it
never ships to a shopper's browser. `src/worker.js` is only the socket: every message goes
to the same `lib/orient-protocol.js` session that `npm start` and the visual harness serve
at `/orient`, and wrangler bundles the engine in at deploy.

## Local

```bash
cd cloudflare/orient
npx wrangler dev --port 8787 --var "ALLOWED_ORIGINS:http://127.0.0.1:*,http://localhost:*"
```

To drive it with the real (minified) room through the visual gate:

```bash
PEAR_ORIENT_URL=ws://127.0.0.1:8787/orient node scripts/build.mjs --qa
PEAR_VISUAL_OVERLAY=dist-qa npm run qa:visual
```

`wrangler dev`'s log shows `GET /orient 101` when the room connected to it rather than to
the harness's own `/orient`. Only a `--qa` build accepts a `ws://localhost` URL.

## Deploy (once, then on engine changes)

1. `wrangler.jsonc`: set `ALLOWED_ORIGINS` to the room's origins — production and the
   Vercel preview pattern (`*` = one `[a-z0-9-]` run, never a dot) — and add the route:
   `"routes": [{ "pattern": "<sub>.<your-domain>", "custom_domain": true }]`.
   Empty `ALLOWED_ORIGINS` refuses everyone; the room then stays on the front view.
2. `npx wrangler secret put PEAR_DEBUG_TOKEN` — the same value as Vercel's, typed into your
   own terminal. Unset means the support view gets no per-tick tuning line; nothing else.
3. `npx wrangler deploy`.
4. Vercel → Environment Variables: `PEAR_ORIENT_URL = wss://<sub>.<your-domain>/orient`,
   then redeploy (the URL is built into the room by `scripts/build.mjs`).
5. Check: in the support view (`/fitting-room/?pear_debug=<token>`), a session's console
   has no `the orientation link is unavailable` line, and a turn swaps to the back.

The engine changes with `lib/orient-engine.js`; a change there needs a `wrangler deploy`
as well as the Vercel deploy, or production keeps deciding with the old engine.

## Test-session flight records (`POST /trace`, since 2026-09-27)

A TEST session (store key `TEST`, or `?pear_trace=1`) posts one record when it ends: every
orientation tick, swap and link event (CLAUDE.md §2.16). They are kept in the KV namespace bound as
`TRACES` for 7 days. Without the binding the route answers 404 and stores nothing.

```bash
npx wrangler kv namespace create TRACES          # once; put the id in wrangler.jsonc's kv_namespaces
npx wrangler kv key list --binding TRACES --remote
npx wrangler kv key get "<key>" --binding TRACES --remote
```

The ping (`{k:"ping"}` → `{k:"pong"}`, `lib/orient-protocol.js`) must be deployed here BEFORE a
room that pings its link ships - an older Worker never answers it, and the room would replace a
healthy link on every keepalive.

## The render engine behind this edge (since 2026-10-03, CLAUDE.md §2.24)

`src/rt.js` relays the render engine so the room never names it: `/v/s` (signalling, translated by
`lib/rt-proxy.js`), `/k/<sealed>/…` (the media server's signalling), `/m` (telemetry) and `/a/<name>`
(the pose model's scrambled binaries, static assets). The engine's URLs and model id are the `RT_*` vars
in `wrangler.jsonc`. Before a deploy that changes the pose runtime: `npm run build:edge-assets` (writes
`assets/a/` - git-ignored - and `lib/edge-assets.json`, which is committed). Local check:
`npx wrangler dev --var RT_SIGNAL_URL:<stand-in> --var RT_EDGE_WS:ws://127.0.0.1:8787` (wrangler dev reports
the production host in request.url, so the media URL needs the override).
