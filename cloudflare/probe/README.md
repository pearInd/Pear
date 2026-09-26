# PEAR · Cloudflare probe

Measurements for phases 5 and 6 of the hide-the-client-logic plan: whether the front/back
decision can live in a free-plan Cloudflare Worker, and whether the render engine's
signaling can be relayed through our own domain. **Nothing in the app points here.** It is
deployed alone, measured, and deleted.

| Route (behind `/<PROBE_KEY>/`) | Question it answers |
|---|---|
| `echo` | round trip from the shopper to the edge |
| `cpu?n=` | does a plain Worker hold a WebSocket for a whole session of ~8 small decisions/s, on the free plan's 10ms CPU limit? |
| `cpu-do?n=` | the same inside a Durable Object (limit documented to reset per message) |
| `where` | which colo ran us, and how far the engine's realtime host is from it (it geo-routes by client IP; behind a relay the client is Cloudflare) |
| `relay/…` | a byte-for-byte WebSocket relay to the engine's realtime host — what `realtimeBaseUrl` would point at |

## Run it

```bash
npx wrangler login                                   # once, in your own browser
cd cloudflare/probe
export PROBE_KEY=$(openssl rand -hex 16)
npx wrangler deploy --var PROBE_KEY:$PROBE_KEY        # prints https://pear-probe.<you>.workers.dev
PROBE_URL=https://pear-probe.<you>.workers.dev node run-probe.mjs
npx wrangler delete                                  # when done
```

About ten minutes, and free: `/relay` is exercised with a deliberately invalid api key,
so no engine session is opened and no credits are spent. While it runs,
`npx wrangler tail` shows each invocation's outcome — an `exceededCpu` there is the
answer to the `cpu` question.

## What the numbers decide

- **`cpu n=1` / `n=40` survive the full 90s** → per-frame decisions can run in a plain
  Worker. **They close early** → CPU is counted across the connection; phase 5 needs the
  Durable Object variant (`cpu-do`) or per-request HTTP instead of one socket.
- **The `n=20000` spike** (~30ms a message, over the line on its own) separates a
  per-message limit from a per-connection one.
- **`where`**: if the engine host is ~1–5ms from the colo, a relay costs nothing; if it is
  ~150ms, the engine is routing Cloudflare's egress to the US and a relay would move every
  Israeli shopper off the Tel Aviv region — phase 6 would then need a region pin.
- **`relay`** must return exactly what the engine returns directly.

The relay only covers the first hop. The engine answers the signaling socket with a
`livekit_url` — a second host the media connects to — which a real session through the
relay (billed, ~10 credits, only on request) would reveal. Phase 6 has to cover that hop too.
