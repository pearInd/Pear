#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────────
# PEAR · measure THIS branch on your own machine, before it goes to main.
#
#   ./scripts/measure-local.sh            # the PEAK tee (front + back photo)
#   ./scripts/measure-local.sh shorts     # FOX basketball shorts (CHICAGO)
#   ./scripts/measure-local.sh custom <front-url> <back-url> <tops|shorts|pants> "<name>"
#   ./scripts/measure-local.sh records    # list the TEST records the local runs left
#
# Everything the branch changed runs locally, and production is not touched:
#   · the room            - the minified room (a QA build), served by this checkout's server.js
#   · the decision engine - a local `wrangler dev` of the Worker (cloudflare/orient): the turn rules,
#                           the prompts (/prompt), the size (/size), the TEST records (/trace, local)
#                           and the relay to the render engine (/v) - the new code, not the deployed one
#   · the render engine   - the real one, through that local relay, with the key from your .env
#                           (Decart credits are used per session, exactly as in production).
# The session is a TEST session (pear_key=TEST): it records itself, and the FRONT_CLEAR sentence is on.
# The rear-photo mask needs GEMINI_API_KEY in the .env to ask for the garment's band; without it the
# rear photo goes whole (the old behaviour) and the record says so (ctx.ref: "no-key").
#
# Stop with Ctrl+C - both servers stop with it.
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PEAR_ENV_FILE:-/Users/yairgertner/pear interface/.env}"
EDGE_PORT="${PEAR_EDGE_PORT:-8787}"
LOGS="$REPO/test-results/local-measure"
mkdir -p "$LOGS"

if [ "${1:-}" = "records" ]; then
  cd "$REPO/cloudflare/orient"
  npx wrangler kv key list --binding TRACES --local
  echo
  echo "Read one: (cd \"$REPO/cloudflare/orient\" && npx wrangler kv key get '<name>' --binding TRACES --local)"
  exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "✖ No .env at: $ENV_FILE  (set PEAR_ENV_FILE=/path/to/.env)"; exit 1
fi
PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
PORT="${PORT:-3000}"

case "${1:-peak}" in
  peak)
    FRONT="https://fox.co.il/cdn/shop/files/1824346900-1.jpg?v=1784034748"
    BACK="https://fox.co.il/cdn/shop/files/1824346900-3.jpg?v=1784034777"
    TYPE="tops"; NAME="חולצה עם הדפס" ;;
  shorts)
    FRONT="https://cdn.shopify.com/s/files/1/0638/8252/6908/files/3108650200-1.jpg?v=1752403462"
    BACK="https://cdn.shopify.com/s/files/1/0638/8252/6908/files/3108650200-4.jpg?v=1752403464"
    TYPE="shorts"; NAME="מכנסי כדורסל" ;;
  custom)
    FRONT="${2:?front image URL}"; BACK="${3:?back image URL}"; TYPE="${4:-tops}"; NAME="${5:-מוצר}" ;;
  *) echo "usage: $0 [peak|shorts|custom <front> <back> <type> <name>|records]"; exit 1 ;;
esac

for p in "$PORT" "$EDGE_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✖ Port $p is already in use - stop what runs there first (lsof -nP -iTCP:$p -sTCP:LISTEN)."; exit 1
  fi
done

cd "$REPO"
echo "▸ branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

echo "▸ building the room (QA build, pointed at the local edge)…"
PEAR_ORIENT_URL="ws://127.0.0.1:$EDGE_PORT/orient" node scripts/build.mjs --qa > "$LOGS/build.log" 2>&1 \
  || { echo "✖ build failed - see $LOGS/build.log"; exit 1; }
rm -rf dist && cp -R dist-qa dist

PIDS=()
cleanup() {
  echo; echo "▸ stopping…"
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo "  dist/ holds the local QA build - 'npm run build' makes the production one again."
}
trap cleanup EXIT INT TERM

echo "▸ starting the edge (wrangler dev :$EDGE_PORT)…"
( cd cloudflare/orient && exec npx wrangler dev --port "$EDGE_PORT" --ip 127.0.0.1 \
    --var "ALLOWED_ORIGINS:http://127.0.0.1:*,http://localhost:*" ) > "$LOGS/edge.log" 2>&1 &
PIDS+=($!)

echo "▸ starting the server (:$PORT, your .env)…"
PEAR_SERVE_DIST=1 node --env-file="$ENV_FILE" server.js > "$LOGS/server.log" 2>&1 &
PIDS+=($!)

wait_for() {  # url, label
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 1
  done
  echo "✖ $2 did not come up - see $LOGS/"; exit 1
}
wait_for "http://localhost:$PORT/api/health" "the server"
wait_for "http://127.0.0.1:$EDGE_PORT/" "the edge"

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
URL="http://localhost:$PORT/fitting-room/?pear_key=TEST&garment_type=$TYPE&garment_name=$(enc "$NAME")&garment_url=$(enc "$FRONT")&garment_url_back=$(enc "$BACK")"

echo
echo "✅ ready. Opening the fitting room:"
echo "   $URL"
echo
echo "   Measure as usual (stand back so your HEAD is in the picture - or not, to test the shorts fix),"
echo "   download the clip, and send it with the time. Records: ./scripts/measure-local.sh records"
echo "   Logs: $LOGS/   ·   Ctrl+C to stop."
[ "${PEAR_NO_OPEN:-0}" = "1" ] || open "$URL" 2>/dev/null || true
wait
