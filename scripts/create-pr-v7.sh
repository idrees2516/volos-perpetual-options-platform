#!/usr/bin/env bash
# Upload the P1 heatmap/tokens round to GitHub — one PR from
# feat/heatmap-market-map (V2 roadmap phase 1: design tokens + heatmap system
# + the Market Map tab), merged into main via the API.
#
# Usage: GH_TOKEN=<your PAT> bash scripts/create-pr-v7.sh
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="feat/heatmap-market-map"

# 0. branch at main HEAD
git rev-parse --verify -q "refs/heads/${BRANCH}" >/dev/null || git branch "${BRANCH}" main
if [ "$(git rev-parse ${BRANCH})" != "$(git rev-parse main)" ]; then
  git branch -f "${BRANCH}" main
fi

# 1. push (origin main is protected)
git remote set-url origin "https://${TOKEN}@github.com/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${REPO}.git"' EXIT
git push -u origin "${BRANCH}"

# 2. open the PR
BODY=$(cat <<'EOF'
## V2 Phase 1 — design tokens + heatmap system + the Market Map tab

The V2 roadmap's first implementation phase (plan: `docs/ROADMAP-V2-AESTHETICS-INDICATORS.md`), in two commits:

### feat: design tokens — one surface/numeral language
- `globals.css` gains the `--volos-*` token layer: 4 surfaces, hairline edges, focus ring, pos/neg/neut numeral colors, warn; density CSS vars; flash/skeleton keyframes — all `prefers-reduced-motion`-safe. Topbar migrated onto the tokens.
- **Density control** (`density-store`, persisted `volos-density`): compact | comfortable toggle in the topbar — row heights / cell padding / panel padding resize across every density-aware table/panel (`volos-table`, `volos-pad`).
- **LiveNum / LivePct** (`components/ui/live-num.tsx`): tabular numerals that flash teal (up) / rose (down) on change — key-remount restarts the animation for back-to-back moves, no layout shift. Live on the topbar ticker.
- **PanelState** (`components/ui/panel-state.tsx`): the shared loading (content-sized shimmer skeletons) / empty / error+retry surface for panels.

### feat: heatmap system + Market Map (Quant Lab → Market Map tab)
- **`src/lib/quant/heatmap.ts`** — the shared visual system: rose↔slate↔teal diverging scale, viridis-class sequential scale, legend ticks, the squarified-treemap layout, pearson + timestamp alignment. Pure functions, **13 unit tests**.
- **Market breadth** (`lib/quant/breadth.ts` + `GET /api/quant/market/breadth`): the whole USDT-perp universe in ONE fapi sweep (weight 40+10) → 64 tiles sized by 24h turnover, colored by 24h change / funding APR / volume share; breadth stats (advancers/decliners, turnover, dominance, volume-weighted funding APR); 15 s cache.
- **Cross-asset correlation** (`lib/quant/correlation.ts` + `GET /api/quant/market/correlation?window=7d|30d|90d`): Pearson on log returns, 8 majors; reads the A1 backfill kline store FIRST (never re-hits the venue) with a staggered live fallback for cold stores; per-asset drop-resilience (one transient venue failure drops one asset, never the whole matrix); degenerate sweeps are never cached.
- **Market Map tab** (`panels-map.tsx`): canvas treemap (squarify, zero new chart dependencies — one visual language with the depth-heatmap core) with hover tooltips, click-to-focus, robust p90 color domains (outliers saturate, don't wash); correlation matrix on the existing HeatMatrix with the shared color fn; shared **HeatLegend** everywhere; PanelState skeletons/empty/error on both panels.

**Verified live:** breadth 64 tiles / $51B tracked turnover; all correlation windows real (BTC-ETH 0.90-0.93); treemap hover/click/metric-switch + density toggle persistence browser-verified with zero console/page errors; 147/147 vitest; eslint + tsc clean on all touched files.

**Secrets:** none in the diff.
EOF
)
PR=$(curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg title "V2 P1: design tokens + heatmap system + Market Map (breadth treemap, correlation matrix)" --arg head "${BRANCH}" --arg base "main" --arg body "${BODY}" '{title:$title,head:$head,base:$base,body:$body}')")
PR_NUM=$(echo "${PR}" | jq -r '.number // empty')
if [ -z "${PR_NUM}" ]; then echo "PR creation failed:"; echo "${PR}" | head -c 400; exit 1; fi
echo "opened PR #${PR_NUM}"

# 3. wait for mergeability then merge via API
for i in $(seq 1 20); do
  MERGEABLE=$(curl -sS -H "Authorization: Bearer ${TOKEN}" "https://api.github.com/repos/${REPO}/pulls/${PR_NUM}" | jq -r '.mergeable // "null"')
  [ "${MERGEABLE}" = "true" ] && break
  [ "${MERGEABLE}" = "false" ] && { echo "PR not mergeable"; exit 1; }
  sleep 3
done
curl -sS -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls/${PR_NUM}/merge" \
  -d '{"merge_method":"merge"}' | jq -r '.message // .'
echo "merged PR #${PR_NUM}"

# 4. sync local main + cleanup
git fetch origin main
git checkout main
git merge --ff-only origin/main
git branch -D "${BRANCH}" 2>/dev/null || true
git push origin --delete "${BRANCH}" 2>/dev/null || true
echo "done — local main synced with origin/main"
