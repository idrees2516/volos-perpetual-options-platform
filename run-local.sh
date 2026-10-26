#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VolOS — always-on local preview
#
# Keeps the Strategies terminal running locally, forever:
#   • installs dependencies on first run (bun → npm → pnpm → yarn)
#   • starts the Next.js dev server on http://localhost:3000
#   • auto-restarts the server if it ever crashes
#   • --full   also builds & starts the Rust engine (:3031) for authoritative
#              SVI analytics + real venue quotes
#   • --stop   kills everything this script started
#
# Usage:
#   bash run-local.sh                 # UI preview on :3000 (auto-restart)
#   bash run-local.sh --full          # UI + Rust engine
#   bash run-local.sh --port 3001     # custom port
#   bash run-local.sh --stop          # stop the preview
#
# package.json aliases:  bun run local | local:full | local:stop | preview
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PORT="${PORT:-3000}"
WITH_ENGINE=0
STOP=0
ENGINE_PID=""
UI_PID=""
LOG_DIR=".local-logs"
UI_LOG="$LOG_DIR/ui.log"
ENGINE_LOG="$LOG_DIR/engine.log"

cd "$(dirname "$0")"
mkdir -p "$LOG_DIR"

log()  { printf '\033[1;36m[volos-local]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[volos-local]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)   PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --full)   WITH_ENGINE=1; shift ;;
    --stop)   STOP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) warn "unknown flag: $1 (see --help)"; shift ;;
  esac
done

# ── stop mode ────────────────────────────────────────────────────────────────
if [[ "$STOP" == "1" ]]; then
  log "stopping the local preview…"
  for pidfile in "$LOG_DIR/ui.pid" "$LOG_DIR/engine.pid"; do
    if [[ -f "$pidfile" ]]; then
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && log "stopped pid $pid"
      fi
      rm -f "$pidfile"
    fi
  done
  # Free the port of any orphaned next-server from previous runs.
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "$pids" ]] && { kill $pids 2>/dev/null; log "freed port $PORT (pids: $pids)"; }
  fi
  log "preview stopped."
  exit 0
fi

# ── pick a package manager ───────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  PM="bun"; PM_RUN=(bun run); PM_INSTALL=(bun install)
elif command -v npm >/dev/null 2>&1; then
  PM="npm"; PM_RUN=(npm run); PM_INSTALL=(npm install)
elif command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"; PM_RUN=(pnpm run); PM_INSTALL=(pnpm install)
elif command -v yarn >/dev/null 2>&1; then
  PM="yarn"; PM_RUN=(yarn run); PM_INSTALL=(yarn install)
else
  warn "no bun/npm/pnpm/yarn found — install Node.js 20+ (bun recommended) and retry."
  exit 1
fi
log "package manager: $PM"

# ── dependencies ─────────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  log "installing dependencies (first run)…"
  "${PM_INSTALL[@]}" || { warn "install failed"; exit 1; }
else
  log "dependencies present — skipping install (delete node_modules to force)"
fi

# ── optional Rust engine ─────────────────────────────────────────────────────
start_engine() {
  if ! command -v cargo >/dev/null 2>&1; then
    warn "--full requested but cargo is not installed; running UI-only (client mirror analytics)."
    return 1
  fi
  log "building + starting the Rust engine on :3031 (background)…"
  ( cd rust-backend && cargo build --release >/dev/null 2>&1 ) || { warn "cargo build failed — engine skipped"; return 1; }
  ( cd rust-backend && cargo run --release --bin volos-backend ) >"$ENGINE_LOG" 2>&1 &
  ENGINE_PID=$!
  echo "$ENGINE_PID" > "$LOG_DIR/engine.pid"
  log "engine pid $ENGINE_PID · log: $ENGINE_LOG"
  return 0
}
if [[ "$WITH_ENGINE" == "1" ]]; then
  start_engine
else
  log "engine not requested — the terminal runs on its identical client-side mirror."
fi

# ── health banner ────────────────────────────────────────────────────────────
banner() {
  printf '\n'
  log "╔══════════════════════════════════════════════════╗"
  log "║  VolOS is running in local preview               ║"
  log "║  Terminal →  http://localhost:%-4s             ║" "$PORT"
  log "║  Auto-restart: ON   Logs: %s              ║" "$UI_LOG"
  log "║  Stop any time:   bash run-local.sh --stop       ║"
  log "╚══════════════════════════════════════════════════╝"
  printf '\n'
}

# ── the always-on loop ───────────────────────────────────────────────────────
cleanup() {
  log "shutting down…"
  [[ -n "$UI_PID" ]] && kill "$UI_PID" 2>/dev/null
  [[ -n "$ENGINE_PID" ]] && kill "$ENGINE_PID" 2>/dev/null
  rm -f "$LOG_DIR/ui.pid" "$LOG_DIR/engine.pid"
  exit 0
}
trap cleanup INT TERM

log "starting the dev server on :$PORT (auto-restart loop)…"
while true; do
  if [[ "$PM" == "bun" ]]; then
    bun x next dev -p "$PORT" >"$UI_LOG" 2>&1 &
  else
    "${PM_RUN[@]}" dev >"$UI_LOG" 2>&1 &
  fi
  UI_PID=$!
  echo "$UI_PID" > "$LOG_DIR/ui.pid"

  # Wait for readiness (or crash).
  ready=0
  for _ in $(seq 1 90); do
    if ! kill -0 "$UI_PID" 2>/dev/null; then break; fi
    if curl -sf -o /dev/null "http://localhost:$PORT"; then ready=1; break; fi
    sleep 1
  done

  if [[ "$ready" == "1" ]]; then
    banner
    wait "$UI_PID"
  else
    log "server did not become ready — tail of $UI_LOG:"
    tail -n 20 "$UI_LOG" || true
  fi

  log "dev server exited — restarting in 2s (Ctrl-C to quit)…"
  sleep 2
done
