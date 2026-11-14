#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VolOS — InstaBox deployment (cloud computer for agents)
#
# Deploys the production standalone build of the VolOS terminal onto an
# InstaBox machine and publishes a public HTTPS URL for port 3000.
#
#   bash scripts/deploy-instabox.sh            # full deploy (creates the machine if missing)
#   bash scripts/deploy-instabox.sh --update    # re-push tracked files + rebuild + restart server
#   bash scripts/deploy-instabox.sh --wake      # wake a paused machine and health-check it
#   bash scripts/deploy-instabox.sh --stop      # stop the machine (disk + published URL stay)
#
# Auth: INSTABOX_API_KEY (ibk_…) in the environment or in .env.local (git-ignored).
# Free plan notes: only the agent-browser template is allowed, and the machine
# auto-pauses after 30 idle minutes — `--wake` brings it (and the server
# process, kept in memory) back in under a minute.
#
# Machine layout: tracked repo files at /data/volos, SQLite at /data/volos/db,
# standalone build at /data/volos/.next/standalone/server.js, app on :3000.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NAME="${INSTABOX_NAME:-volos-desk}"
REMOTE="${INSTABOX_REMOTE:-/data/volos}"
PORT="${INSTABOX_PORT:-3000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="deploy"
case "${1:-}" in
  --update) MODE="update" ;;
  --wake)   MODE="wake" ;;
  --stop)   MODE="stop" ;;
  "")       MODE="deploy" ;;
  *) echo "unknown flag: $1 (use --update | --wake | --stop or nothing)" >&2; exit 64 ;;
esac

# ── auth ────────────────────────────────────────────────────────────────────
KEY="${INSTABOX_API_KEY:-$(grep -E '^INSTABOX_API_KEY=' "$ROOT/.env.local" 2>/dev/null | cut -d= -f2 || true)}"
if [ -z "$KEY" ]; then
  echo "missing INSTABOX_API_KEY — export it or put INSTABOX_API_KEY=ibk_… in .env.local" >&2
  exit 1
fi
export INSTABOX_API_KEY="$KEY"

ib() { instabox "$@" </dev/null; }   # keep exec from latching onto a busy stdin

machine_state() { ib get "$NAME" --json 2>/dev/null | jq -r '.state // empty'; }
machine_id()   { ib get "$NAME" --json 2>/dev/null | jq -r '.id // empty'; }
published_url() {
  ib port ls "$NAME" --json 2>/dev/null | jq -r --argjson p "$PORT" '.ports[]? | select(.port == $p) | .url' | head -1
}
health() {
  ib exec "$NAME" --timeout 30 -- "curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/" 2>/dev/null | tail -1
}

# ── stop ────────────────────────────────────────────────────────────────────
if [ "$MODE" = "stop" ]; then
  ib stop "$NAME"; echo "machine '$NAME' stopped (disk + published URL stay)"; exit 0
fi

# ── wake ────────────────────────────────────────────────────────────────────
if [ "$MODE" = "wake" ]; then
  st="$(machine_state)"
  [ -n "$st" ] || { echo "machine '$NAME' does not exist — run a full deploy first" >&2; exit 1; }
  if [ "$st" != "running" ]; then ib wake "$NAME"; fi
  for i in $(seq 1 20); do
    code="$(health)"
    [ "$code" = "200" ] && break
    sleep 3
  done
  code="$(health)"
  echo "machine '$NAME' state=$(machine_state) app HTTP=${code:-none}"
  published_url || true
  exit 0
fi

# ── deploy / update ─────────────────────────────────────────────────────────
st="$(machine_state)"
if [ -z "$st" ]; then
  echo "▶ creating machine '$NAME' (template agent-browser — free plan)"
  ib create --name "$NAME" --template agent-browser --meta project=volos --json | jq '{id, name, state, readyAt}'
elif [ "$st" != "running" ]; then
  echo "▶ machine '$NAME' is '$st' — waking"
  ib wake "$NAME"
fi

echo "▶ pushing tracked repo files → ${NAME}:${REMOTE}"
ib push "$NAME" "$ROOT/" "$REMOTE" -p | tail -1

echo "▶ deps + prisma + build"
ib exec "$NAME" --cwd "$REMOTE" --timeout 600 -- "
  printf 'DATABASE_URL=file:${REMOTE}/db/custom.db\n' > .env
  mkdir -p db
  bun install 2>&1 | tail -1
  bunx prisma generate >/dev/null 2>&1
  bunx prisma db push --accept-data-loss 2>&1 | tail -2
  bun run build 2>&1 | tail -3
" | tail -8

echo "▶ (re)starting the production server on :${PORT}"
ib exec "$NAME" --timeout 60 -- "pkill -f 'next-server' 2>/dev/null; pkill -f 'standalone.*server.js' 2>/dev/null; sleep 2; exit 0" || true
ib exec --background "$NAME" --cwd "$REMOTE" \
  --env PORT="$PORT" --env HOSTNAME=0.0.0.0 --env NODE_ENV=production \
  -- node .next/standalone/server.js --json | jq '{jobId, pid}'

echo "▶ publishing port ${PORT} (public HTTPS)"
URL="$(published_url)"
if [ -z "$URL" ]; then
  URL="$(ib port publish "$NAME" "$PORT" --public --json | jq -r '.url // empty')"
fi
echo "public URL: ${URL}"

sleep 4
echo "▶ health check"
code="$(health)"
echo "machine : ${NAME} ($(machine_id)) — state $(machine_state)"
echo "app    : http://localhost:${PORT} inside the machine → HTTP ${code:-none}"
URL="$(published_url)"
[ -n "$URL" ] && echo "public : ${URL}"
[ "$code" = "200" ] || { echo "health check failed — inspect: instabox exec $NAME -- 'tail -50 ${REMOTE}/dev.log'" >&2; exit 1; }
