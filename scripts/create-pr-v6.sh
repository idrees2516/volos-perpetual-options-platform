#!/usr/bin/env bash
# Upload the whole local stack to GitHub — one PR from feat/position-intelligence-ai
# (local main is 10 commits ahead of origin/main: everything from create-pr-v5
# [Track B + venues + Copilot tools, OmniRoute+RAG memory, AI gateways, InstaBox
# deploy + build portability] PLUS this round: the Position Intelligence system —
# position × whole-market decision fusion, per-position management settings,
# deep copilot integration, Paper Desk UI panel + tests).
#
# Usage: GH_TOKEN=<your PAT> bash scripts/create-pr-v6.sh
# (same flow as create-pr-v3/v4/v5: temporary token remote → push → PR → API merge → cleanup)
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="feat/position-intelligence-ai"

# 0. make sure the branch matches local main HEAD
git rev-parse --verify -q "refs/heads/${BRANCH}" >/dev/null || git branch "${BRANCH}" main
git rev-parse --verify -q "refs/heads/main" >/dev/null || { echo "not on a repo with main"; exit 1; }
if [ "$(git rev-parse ${BRANCH})" != "$(git rev-parse main)" ]; then
  git branch -f "${BRANCH}" main   # move the branch to main HEAD (unpushed branch, safe)
fi

# 1. push the branch (origin main is protected)
git remote set-url origin "https://${TOKEN}@github.com/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${REPO}.git"' EXIT
git push -u origin "${BRANCH}"

# 2. open the PR
BODY=$(cat <<'EOF'
## Position Intelligence — position × market decision fusion + management settings + deep AI integration (plus the previously staged stack)

Everything since origin/main in one PR: Track B + venues + Copilot tools, OmniRoute+RAG memory, AI gateways, InstaBox deploy, build portability — **and the new Position Intelligence system**:

### Position Intelligence (this round)
- **Fusion engine** (`src/lib/positions/intelligence.ts`): every open paper position × the whole live market stack (spot/IV/funding/OI, 4h technicals + bias + ATR, vol-regime + IV rank, VolQuant signal regime) → per-position live Greeks, prob ITM, prob of touching breakeven, **P&L attribution (delta/vega/theta/residual)**, theta-bleed rate, strike/BE distance in ATR units, market-alignment score, and a composite decision **HOLD / ADJUST / SCALE_IN / TAKE_PROFIT / EXIT / ROLL** with confidence, health score and reasons. Portfolio rollup: net Greeks by asset, ±1-ATR stress P&L, margin utilization, alert census.
- **Management settings** (`src/lib/positions/settings.ts`): per-position overrides over global defaults — TP/SL %, theta-bleed tolerance, DTE floor, prob-ITM bands (side-aware), IV-move + alignment alerts, time stop — with 4 one-click presets (scalper / swing / harvester / longshot), disk-persisted, readable AND writable from the UI and the AI.
- **API**: `GET /api/positions/intelligence`, `GET|POST /api/positions/settings`.
- **Deep AI integration**: 4 new copilot tools (position_intelligence, position_decisions, get_position_settings, update_position_settings) + system-prompt engagement rules — the copilot grounds every position answer in the fused metrics and can retune settings itself to chase better returns.
- **UI**: Paper Desk gains the Position Intelligence panel — decision badges with health bars, 8-metric grid, attribution bars, trigger chips, per-position + global settings editors, Ask-AI buttons (one click hands the full context to the copilot), and one-click execution on EXIT/TAKE_PROFIT verdicts.
- **Tests**: 12 new vitest cases (settings sanitization, presets, trigger evaluation — all 112 passing); typecheck + eslint clean on changed files; production build passes with the new routes.

### Previously staged (from create-pr-v5)
- Track B signal research harness; Kraken WS v2; Hyperliquid/Coinbase/Kraken/Bitget connectors; Deribit options chains (Greeks/IV/skew/GEX) as a new data domain; research + options Copilot tools
- OmniRoute AI providers + RAG conversation memory (hybrid recall, session restore, memory tools)
- Self-hosted AI gateway stack (zai-shim, OmniRoute, Respan) + `run-local.sh --gateways`
- InstaBox one-command cloud deploy (public HTTPS URL) + portable standalone build fixes

**Secrets:** none in the diff — INSTABOX_API_KEY/OMNIROUTE_API_KEY/RESPAN_API_KEY live only in git-ignored `.env.local`; `external/*` ignored except `external/respan/gateway.toml` (env refs only).

**Setup after merge:** none required for the UI; `.env.local` keys are opt-in accelerators.
EOF
)
curl -sS -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg t "Position Intelligence: market-fused decisions + settings + deep AI (full stack upload)" \
             --arg h "${BRANCH}" --arg b "main" --arg body "${BODY}" \
             '{title:$t, head:$h, base:$b, body:$body}')" \
  | jq '{number, html_url, state}'

# 3. merge it (main is protected — API merge)
PR=$(curl -sS -H "Authorization: token ${TOKEN}" \
  "https://api.github.com/repos/${REPO}/pulls?head=${REPO}:${BRANCH}&state=open" | jq -r '.[0].number')
if [ -n "$PR" ] && [ "$PR" != "null" ]; then
  curl -sS -X PUT \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/pulls/${PR}/merge" \
    -d '{"merge_method":"merge"}' | jq '{merged, sha}'
  git fetch origin main 2>/dev/null || true
  git checkout main && git pull origin main
  git branch -d "${BRANCH}"
fi
