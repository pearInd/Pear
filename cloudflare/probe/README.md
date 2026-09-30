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

## Results — 2026-09-26 (free plan, laptop in Israel, Worker deleted afterwards)

| Measurement | Result |
|---|---|
| Colo | **TLV** |
| Edge round trip (WebSocket echo, 60 pings) | median **7ms**, p90 30ms, max 93ms |
| Plain Worker, 90s at one frame / 120ms, n=1 and n=40 (740 msgs each) | **both survived**; median 7–8ms, p90 41–46ms, max 157–196ms |
| Plain Worker, ~30ms/message spike (n=20000) | **killed after ~2s** — `exceededCpu` (~1.9s CPU) |
| Durable Object, same sessions | survived, but median **~61ms** (the object is not placed in TLV) |
| Engine host from the colo / from the laptop (HTTPS round trip) | 49ms / 63ms — same neighbourhood, not a US reroute |
| Relay handshake (invalid key) | **identical answer** to a direct connection (same message, close 1008); open 887 vs 687ms, first reply 1062 vs 1209ms (single samples) |

**What it means.**

- A plain Worker's WebSocket is **one invocation for the whole session**. `wrangler tail` logged
  ~208ms of CPU for each 90s session, 20× the documented 10ms free-plan figure, and it was not
  cut off, while a genuinely heavy burst was. So a light per-frame decision passes on the free
  plan **today**, but on enforcement behaviour Cloudflare does not document. Phase 5 must keep
  the per-message work at or below the n=1 level (the real watcher is lighter than that). It must
  also keep the in-browser watcher as the fallback if the socket closes, or move to Workers Paid
  for a documented limit.
- A Durable Object resets CPU per message (documented) but costs ~55ms per decision from Israel.
- The relay carries the signaling handshake byte for byte at no measurable cost, and the engine
  host is not farther from Cloudflare's TLV egress than from the shopper.
- **Not answered here:** the second hop (`livekit_url`, where the media goes) and which region
  the engine assigns to a session arriving through the relay. Both need one real, billed session
  through the relay.
