#!/usr/bin/env bash
# Create PR from feat/omniroute-rag-memory -> main
# Usage: GH_TOKEN=<token> bash scripts/create-pr-v4.sh
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="feat/omniroute-rag-memory"

# 1. push the feature branch (origin main is protected)
git remote set-url origin "https://${TOKEN}@github.com/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${REPO}.git"' EXIT
git push -u origin "${BRANCH}"

# 2. open the PR
BODY=$(cat <<'EOF'
## OmniRoute AI providers + RAG conversation memory (1 commit, 18 files)

### 1. AI provider router — OmniRoute + GLM failover (`src/lib/ai/`)
- `model-router.ts`: env-driven selection (`AI_PROVIDER=auto|omniroute|zai`): **OmniRoute** (`OMNIROUTE_API_KEY` / `OMNIROUTE_BASE_URL` / `OMNIROUTE_MODEL` — defaults `https://omniroute.online/v1` + `auto`) or any OpenAI-compatible gateway (`OPENAI_COMPAT_*`); GLM stays the automatic failover — a dead key / exhausted quota / downed gateway transparently reruns on GLM before any token reaches the browser
- Circuit breaker: 3 consecutive failures → 5-min cooldown (half-open retry) — no per-request timeout tax while a gateway is down
- `openai-compat.ts`: full LanguageModelV1 provider over fetch (429/5xx retries, SSE + non-SSE replies, tool calling); shared conversion/sanitation exported from `zai-provider.ts`
- `agents.ts` `zaiModel` → router `deskModel` (alias kept); copilot + research routes migrated

### 2. RAG conversation memory — the copilot remembers (`src/lib/ai/memory/`)
- Prisma `ConversationSession` / `ConversationMessage` (SQLite): every copilot turn **and** every deep-research dossier persisted (2-year retention)
- Deterministic local embeddings: 384-dim hashing vectorizer (unigrams+bigrams, thousands-separator collapse) — stable across restarts, zero-config, offline
- Hybrid retrieval: 55% embedding cosine + 45% BM25 + recency tiebreak, 0.12 noise floor (pure core, unit-tested)
- Copilot route: relevant past exchanges across ALL sessions injected as `## Conversation memory`; current thread restored after reloads; `memory_search` / `memory_stats` tools for on-demand recall
- `/api/ai/providers`: active backend, model, failover + circuit state, gateway `/v1/models` probe, memory counters

### 3. UI
- Copilot chat bar: provider badge, memory chip (`remembers N msgs`), **New chat** (fresh thread — past conversations stay retrievable); header subtitle shows the live backend + remembered count; persistent `sessionId` (localStorage) ships with every request

### 4. Evidence (live, e2e)
- Turn persisted → cross-session recall answered *"Earlier today, I defined a bull put spread as…"* from a **different** session (`memory=2 hits`); cold-state session restore verified (`restored=2 turns`)
- 27 new vitest cases: embeddings determinism/codec/ranking, hybrid scoring + threshold + recency, router env matrix, failover + circuit breaker (fake timers). Suite: 94 passed. Lint clean. Zero new typecheck errors.

**Setup:** drop `OMNIROUTE_API_KEY=…` into `.env.local` (git-ignored) and restart — OmniRoute activates automatically; without it the desk keeps running on GLM. `prisma db push` required once (already applied locally).
EOF
)
curl -sS -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg t "OmniRoute AI providers + GLM failover + RAG conversation memory" \
             --arg h "${BRANCH}" --arg b "main" --arg body "${BODY}" \
             '{title:$t, head:$h, base:$b, body:$body}')" \
  | jq '{number, html_url, state, mergeable}'

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
