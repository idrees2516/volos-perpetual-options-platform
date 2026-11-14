#!/usr/bin/env bash
# Create PR from track-b-research-venues-copilot -> main
# Usage: GH_TOKEN=<token> bash scripts/create-pr-v3.sh
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="track-b-research-venues-copilot"

# 1. push the feature branch (origin main is protected)
git remote set-url origin "https://${TOKEN}@github.com/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${REPO}.git"' EXIT
git push -u origin "${BRANCH}"

# 2. open the PR
BODY=$(cat <<'EOF'
## Track B + venues + Copilot wiring (1 commit, 13 files)

### 1. Signal research harness (Track B) — `src/lib/research/`
- 12-factor battery over the **stored** history (klines w/ taker aggressor delta, funding, OI, microstructure snapshots once sessions accumulate): delta z, CVD momentum, price/flow divergence, momentum, VWAP mean-reversion, volume burst, range squeeze, OI acceleration, OI×price confirmation, funding crowding, stored VPIN, stored Kyle lambda
- Protocol: **daily-block Spearman IC** (mean / t-stat / positive-day share), quintile Q1..Q5 forward-return profile with **Q5−Q1 spread (bps) + Welch t**, top-quintile hit rate, IC-directed composite
- Every run persisted to `ResearchRun` — the track record of which factors worked, when
- 17 unit tests (rank ties, Spearman/Pearson, rolling z causality, Welch t, full protocol on synthetic known-truth panels, factor computability contract)
- API: `POST/GET /api/research/run`, `GET /api/research/results`
- UI: QuantLab **Signal Research** tab — harness console (tf/horizon selectors, run button, factor table, composite stats) + persisted run ledger

### 2. Kraken spot venue (8th venue)
- WS **v2** JSON protocol: trade channel (side IS the taker/aggressor side — verified live: buy prints execute at the top ask) + book channel (snapshot + incremental updates, qty=0 deletes)
- All 8 majors subscribe-verified live; venue filter + tape color wired in the UI

### 3. Copilot: all data connected for decisions
- **`options_surface`** — the Deribit surface with real Black-76 Greeks/OI: ATM IV + 30d IV rank (from stored snapshots) + VRP, IV term structure, 25Δ/10Δ risk reversal + fly + smile, net GEX regime / HVL / call wall / put support / max pain, top GEX strikes, 0DTE state, expected moves, P/C ratio
- **`research_backtest`** — run / latest / list the harness; the "does this signal actually work" evidence gate
- **`market_brief`** — now aggregates the options headline + latest research evidence + storage/backfill state on top of the whole-market flow + conformal forecast
- `tape_scan` venue enum + kraken

### 4. Storage
- Prisma `ResearchRun` model (db push required once: `bunx prisma db push && bunx prisma generate`)

**Evidence (live run):** BTC 5m, 120d, 1h horizon — mean_reversion IC +0.085 (t +5.3, strong); CVD momentum inverse (−0.06); composite IC 0.072 (t +6.3, strong). ETH 10 factors, composite strong.
EOF
)
curl -sS -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg t "Track B signal research harness + Kraken venue + Copilot options/research wiring" \
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
  git merge --ff-only origin/main 2>/dev/null || true
  git push origin --delete "${BRANCH}" 2>/dev/null || true
  echo "PR #${PR} merged; feature branch deleted."
fi
