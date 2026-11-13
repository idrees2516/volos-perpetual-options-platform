#!/usr/bin/env bash
# Upload the whole local stack to GitHub — one PR from feat/ai-gateway-stack-deploy
# (local main is N commits ahead of origin/main: Track B + venues + Copilot tools,
#  OmniRoute+RAG memory, AI gateways, InstaBox deploy infra + build portability fixes)
#
# Usage: GH_TOKEN=<your PAT> bash scripts/create-pr-v5.sh
# (same flow as create-pr-v3/v4: temporary token remote → push → PR → API merge → cleanup)
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="feat/ai-gateway-stack-deploy"

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
## Upload the full local stack: Track B · venues + Copilot tools · OmniRoute+RAG memory · AI gateways · InstaBox deploy

Everything since PR #11 (`data-foundation-conformal-v2`), in one PR.

### 1. Track B — signal research harness + venues + Copilot tools
- Signal research harness over the stored history; Kraken WS v2 adapter; new venue connectors (Hyperliquid on-chain perp flow, Coinbase, Kraken, Bitget); Deribit options chains as a new data domain (Greeks/IV/skew/GEX); research + options Copilot tools so the desk can reason over the full dataset
### 2. OmniRoute AI providers + RAG conversation memory
- `src/lib/ai/model-router.ts`: env-driven backend selection (AI_PROVIDER=auto|omniroute|respan|zai) with automatic GLM failover + circuit breaker (3 failures → 5-min cooldown, half-open retry); any OpenAI-compatible gateway via OMNIROUTE_*/RESPAN_*/OPENAI_COMPAT_* env
- RAG memory (Prisma ConversationSession/ConversationMessage, deterministic 384-dim hashing embeddings, 55% cosine + 45% BM25 hybrid recall): copilot remembers past exchanges across sessions, restores threads after reloads; `memory_search`/`memory_stats` tools; `/api/ai/providers` status route
- UI: provider badge, memory chip, New chat; sessionId persists in localStorage
### 3. AI gateway stack (local, self-hosted)
- zai-shim (:20130) — OpenAI-compatible front over the in-sandbox GLM endpoint; OmniRoute self-host (published npm package, :20128, data under git-ignored external/omniroute-data); Respan (:8080, external/respan/gateway.toml — env refs only, no secrets); `run-local.sh --gateways` boots the whole stack; README AI-providers section
### 4. Production build portability + fixes (first real `next build`)
- `next.config.ts`: dropped the sandbox-absolute `turbopack.root` (default = project root — builds anywhere)
- `/api/backtest`: imports rewired from the removed v1.9 `blackScholes/surfaceIv/BASE_IV` surface onto the real pricing kernel (`bsPrice`, SVI-style `ivForStrike`, `VOL_CONFIG`) — Turbopack build was failing on the missing exports; route now compiles and serves
- `package.json` build/start: no more hardcoded `.next/standalone/volos-perpetual-options-platform/` path — scripts locate `server.js` via find, so any checkout dir works
### 5. InstaBox deployment — cloud machine + public HTTPS URL
- `scripts/deploy-instabox.sh` (+ `bun run deploy:instabox[:wake]`): one command → create machine (agent-browser template, 4 vCPU/8 GiB) → `instabox push` of tracked files only (secrets/node_modules/.next/dev DB never leave) → bun install + prisma generate/db push (fresh SQLite at /data/volos/db) → `next build` → background standalone server on :3000 → `port publish --public`
- Live today: **https://3000-agq5gk3gjcm4ckkv6ptcf3rygu.instabox.tech** (HTTP 200 verified from outside; /api/venues + /api/ai/providers serving; Prisma store connected)
- `--update` re-pushes + rebuilds + restarts; `--wake` restores an idle-paused free-plan machine (process kept in memory); README "Deploy on InstaBox" quickstart section
- Free plan notes documented: 30-min idle auto-pause (not changeable), URL + disk persist across pause

**Secrets:** none in the diff — INSTABOX_API_KEY/OMNIROUTE_API_KEY/RESPAN_API_KEY live only in git-ignored `.env.local`; `external/*` ignored except `external/respan/gateway.toml` (env refs only).

**Setup after merge:** none required for the UI; `.env.local` keys are opt-in accelerators.
EOF
)
curl -sS -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg t "Track B + venues + OmniRoute/RAG memory + AI gateways + InstaBox deploy (build portability fixes)" \
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
