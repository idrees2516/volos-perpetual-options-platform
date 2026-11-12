#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VolOS — always-on local preview
#
# Keeps the Strategies terminal running locally, forever:
#   • installs dependencies on first run (bun → npm → pnpm → yarn)
#   • starts the Next.js dev server on http://localhost:3000 IMMEDIATELY
#     (auto-restart loop — if it ever crashes it comes back in 2s)
#   • --full   also builds & starts the Rust engine (:3031) for authoritative
#              SVI analytics + real venue quotes — the build runs in the
#              background so the UI is up within seconds, and the engine
#              joins as soon as it is healthy (Live Data tab flips from the
#              client mirror to engine-backed numbers automatically)
#   • --gateways  also starts the local AI gateway stack in the background:
#              zai-shim (:20130 — OpenAI-compatible front for the in-sandbox
#              GLM endpoint with live session headers), OmniRoute self-host
#              (:20128 — free AI gateway; dashboard + /v1; data under
#              external/omniroute-data) and Respan (:8080 — Rust AI gateway,
#              external/respan/gateway.toml). The desk's model router picks
#              them up from .env.local (OMNIROUTE_API_KEY / RESPAN_API_KEY);
#              GLM stays the automatic failover, so a missing gateway never
#              breaks the copilot.
#   • --stop   kills everything this script started
#
# Usage:
#   bash run-local.sh                 # UI preview on :3000 (auto-restart)
#   bash run-local.sh --full          # UI immediately + Rust engine when ready
#   bash run-local.sh --gateways      # UI + local AI gateway stack
#   bash run-local.sh --port 3001     # custom UI port
#   bash run-local.sh --stop          # stop the preview
#
# package.json aliases:  bun run local | local:full | local:stop | preview
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PORT="${PORT:-3000}"
WITH_ENGINE=0
WITH_GATEWAYS=0
STOP=0
ENGINE_PID=""
UI_PID=""
LOG_DIR=".local-logs"
UI_LOG="$LOG_DIR/ui.log"
ENGINE_LOG="$LOG_DIR/engine.log"
OMNI_LOG="$LOG_DIR/omniroute.log"
RESPAN_LOG="$LOG_DIR/respan.log"
SHIM_LOG="$LOG_DIR/zai-shim.log"

cd "$(dirname "$0")"
mkdir -p "$LOG_DIR"

log()  { printf '\033[1;36m[volos-local]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[volos-local]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)   PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --full)   WITH_ENGINE=1; shift ;;
    --gateways) WITH_GATEWAYS=1; shift ;;
    --stop)   STOP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) warn "unknown flag: $1 (see --help)"; shift ;;
  esac
done

# ── stop mode ────────────────────────────────────────────────────────────────
if [[ "$STOP" == "1" ]]; then
  log "stopping the local preview…"
  for pidfile in "$LOG_DIR/ui.pid" "$LOG_DIR/engine.pid" "$LOG_DIR/zai-shim.pid" "$LOG_DIR/omniroute.pid" "$LOG_DIR/respan.pid"; do
    if [[ -f "$pidfile" ]]; then
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && log "stopped pid $pid"
      fi
      rm -f "$pidfile"
    fi
  done
  # Free the ports of any orphaned servers from previous runs.
  for port in "$PORT" 3031 20128 20129 20130 8080; do
    if command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
      [[ -n "$pids" ]] && { kill $pids 2>/dev/null; log "freed port $port (pids: $pids)"; }
    fi
  done
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

# ── optional Rust engine (background, non-blocking) ──────────────────────────
start_engine_bg() {
  # Prefer an existing prebuilt binary — works even without cargo installed.
  if [[ -x rust-backend/target/release/volos-backend ]]; then
    log "engine: starting prebuilt binary on :3031 in the background…"
    (
      ( cd rust-backend && exec ./target/release/volos-backend ) >>"$ENGINE_LOG" 2>&1
    ) &
    ENGINE_PID=$!
    echo "$ENGINE_PID" > "$LOG_DIR/engine.pid"
  elif command -v cargo >/dev/null 2>&1; then
    log "engine: building + starting on :3031 in the background…"
    log "engine: first build — release mode with LTO, a few minutes; the UI is already starting in parallel"
    (
      ( cd rust-backend && cargo build --release ) >>"$ENGINE_LOG" 2>&1 \
        || { echo "CARGO_BUILD_FAILED" >>"$ENGINE_LOG"; exit 1; }
      ( cd rust-backend && exec cargo run --release --bin volos-backend ) >>"$ENGINE_LOG" 2>&1
    ) &
    ENGINE_PID=$!
    echo "$ENGINE_PID" > "$LOG_DIR/engine.pid"
  else
    warn "--full requested but neither a prebuilt engine nor cargo is available; the UI runs on its identical client-side mirror."
    return 1
  fi
  # announce readiness asynchronously — never blocks the UI
  (
    for _ in $(seq 1 3600); do
      if curl -sf -o /dev/null "http://localhost:3031/health"; then
        log "engine: UP — authoritative numbers now served from :3031 (health: http://localhost:3031/health)"
        exit 0
      fi
      if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
        warn "engine exited — the UI keeps running on the client mirror; see $ENGINE_LOG"
        exit 1
      fi
      sleep 1
    done
  ) &
  disown
  return 0
}
# ── optional AI gateway stack (background, non-blocking) ───────────────────
start_gateways_bg() {
  # 1 — zai-shim: OpenAI-compatible front for the in-sandbox GLM endpoint.
  #     Re-reads /etc/.z-ai-config on every request, so session-header
  #     rotation stays transparent to the gateways behind it.
  if [[ -f mini-services/zai-shim.mjs ]] && command -v node >/dev/null 2>&1; then
    log "gateways: starting zai-shim on :20130 in the background…"
    (
      ( exec node mini-services/zai-shim.mjs ) >>"$SHIM_LOG" 2>&1
    ) &
    echo $! > "$LOG_DIR/zai-shim.pid"
  else
    warn "gateways: mini-services/zai-shim.mjs not found — gateways lose the GLM upstream (desk itself is fine: GLM failover)."
  fi

  # 2 — OmniRoute self-host (published omniroute package: prebuilt standalone).
  local OMNI_BIN=""
  OMNI_BIN="$(command -v omniroute 2>/dev/null || true)"
  [[ -z "$OMNI_BIN" && -x /home/z/.npm-global/bin/omniroute ]] && OMNI_BIN=/home/z/.npm-global/bin/omniroute
  if [[ -n "$OMNI_BIN" ]]; then
    if [[ -f external/omniroute-data/omniroute.env ]]; then
      log "gateways: starting OmniRoute self-host on :20128 (dashboard + /v1) in the background…"
      (
        set -a; . external/omniroute-data/omniroute.env; set +a
        export DATA_DIR="${DATA_DIR:-/home/z/my-project/external/omniroute-data}"
        ( exec "$OMNI_BIN" serve --port 20128 --no-open ) >>"$OMNI_LOG" 2>&1
      ) &
      echo $! > "$LOG_DIR/omniroute.pid"
    else
      warn "gateways: external/omniroute-data/omniroute.env missing (JWT_SECRET / API_KEY_SECRET / INITIAL_PASSWORD) — OmniRoute skipped."
    fi
  else
    warn "gateways: omniroute binary not found (npm install -g omniroute) — OmniRoute skipped."
  fi

  # 3 — Respan gateway (Rust single binary; pip install respan-gateway).
  local RESPAN_BIN=""
  RESPAN_BIN="$(command -v respan-gateway 2>/dev/null || true)"
  [[ -z "$RESPAN_BIN" && -x /home/z/.venv/bin/respan-gateway ]] && RESPAN_BIN=/home/z/.venv/bin/respan-gateway
  local RK=""
  [[ -f .env.local ]] && RK="$(grep '^RESPAN_API_KEY=' .env.local | cut -d= -f2)"
  if [[ -n "$RESPAN_BIN" && -f external/respan/gateway.toml && -n "$RK" ]]; then
    log "gateways: starting Respan on :8080 (/v1 + /ui/) in the background…"
    (
      export ZAI_API_KEY=shim-local RESPAN_CLIENT_KEY="$RK"
      ( exec "$RESPAN_BIN" --config external/respan/gateway.toml ) >>"$RESPAN_LOG" 2>&1
    ) &
    echo $! > "$LOG_DIR/respan.pid"
  else
    warn "gateways: respan-gateway binary, external/respan/gateway.toml or RESPAN_API_KEY (in .env.local) missing — Respan skipped."
  fi

  # Announce the critical upstream (the shim) asynchronously — never blocks the UI.
  (
    for _ in $(seq 1 60); do
      if curl -sf -o /dev/null http://localhost:20130/healthz; then
        log "gateways: zai-shim UP — OmniRoute (:20128) and Respan (:8080) route glm-* to the in-sandbox GLM endpoint"
        exit 0
      fi
      sleep 1
    done
    warn "gateways: zai-shim did not answer on :20130 within 60s — see $SHIM_LOG"
  ) &
  disown
  return 0
}

if [[ "$WITH_ENGINE" == "1" ]]; then
  start_engine_bg
else
  log "engine not requested — the terminal runs on its identical client-side mirror."
fi
if [[ "$WITH_GATEWAYS" == "1" ]]; then
  start_gateways_bg
fi

# ── health banner ────────────────────────────────────────────────────────────
banner() {
  printf '\n'
  log "╔══════════════════════════════════════════════════╗"
  log "║  VolOS is running in local preview               ║"
  log "║  Terminal →  http://localhost:%-4s             ║" "$PORT"
  log "║  Engine   →  http://localhost:3031  $( [[ $WITH_ENGINE == 1 ]] && echo '(starting in background)' || echo '(not requested)')  ║"
  log "║  AI gates →  OmniRoute :20128 · shim :20130 · Respan :8080  $( [[ $WITH_GATEWAYS == 1 ]] && echo '(starting)' || echo '(off)') ║"
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
  for pidfile in "$LOG_DIR/zai-shim.pid" "$LOG_DIR/omniroute.pid" "$LOG_DIR/respan.pid"; do
    if [[ -f "$pidfile" ]]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
  done
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
