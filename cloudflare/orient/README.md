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
