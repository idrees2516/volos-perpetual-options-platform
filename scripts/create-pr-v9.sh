#!/usr/bin/env bash
# Upload the P2b heatmaps round to GitHub — one PR from
# feat/depth-heatmap-v2 (V2 roadmap §1 visual set: funding heat grid +
# IV surface v2 + GEX session heatmap + depth heatmap v2 walls), merged
# into main via the API.
#
# Usage: GH_TOKEN=<your PAT> bash scripts/create-pr-v9.sh
set -euo pipefail
TOKEN="${GH_TOKEN:?missing — set GH_TOKEN to your GitHub PAT}"
REPO="idrees2516/volos-perpetual-options-platform"
BRANCH="feat/depth-heatmap-v2"

# 0. branch already carries the 6 commits (main + P2b); verify it is a
# fast-forward of main
git rev-parse --verify -q "refs/heads/${BRANCH}" >/dev/null || { echo "branch ${BRANCH} not found"; exit 1; }

# 1. push (origin main is protected)
git remote set-url origin "https://${TOKEN}@github.com/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${REPO}.git"' EXIT
git push -u origin "${BRANCH}"

# 2. open the PR
BODY=$(cat <<'EOF'
## V2 P2b — the §1 visual set completed: funding heat · IV surface v2 · GEX session · depth walls

The V2 roadmap's heatmap phase lands its remaining four views (`docs/ROADMAP-V2-AESTHETICS-INDICATORS.md` §1) — same doctrine as every prior phase: one shared color language, store-first data discipline, zero new chart dependencies.

### Funding heat grid — the "where is the leverage" map (Market Map tab)
`src/lib/quant/funding-grid.ts` + `GET /api/quant/market/funding?window=7d|30d` — rows = desk majors, columns = 8h funding events, cells = annualized APR. **Store-first** (DerivativesPoint mirror) with a staggered live sweep (batches of 3, 150 ms gaps) when the store is cold; **per-asset drop-resilience** (one failed sweep drops that row, it rejoins next refresh); robust p90 |APR| color domain; 5 min cache, degenerate sweeps never cached. Pure assembly unit-tested (7 tests: bucketing, APR annualization, union axis, stride cap, row census). Rose = longs pay (crowded), teal = shorts pay — the desk's funding semantics.

### IV surface v2 (Quant Lab · IV Analytics)
`?view=surface` now returns rows keyed by **log-moneyness vs the front forward**, a term-structure strip (ATM IV per tenor) and a 25Δ rr25/fly25 skew strip. The grid mode moved onto the shared visual language: viridis sequential scale over a robust p10..p90 IV domain, the shared HeatLegend (moved into `quant-viz` for every panel).

### GEX session heatmap — net dealer gamma × time (Quant Lab · GEX tab)
`src/lib/quant/gex-session.ts` + `GET /api/quant/gex?view=session&minutes=15..240` — a server-side ring buffer samples the per-strike netGex aggregate **at most once a minute off the shared cached chain snapshot** (zero extra venue calls, single-flight, 240-sample ring ≈ 4 h). Pure `assembleGexSession` (6 tests: peak-strike row selection, stride-capped columns, NaN holes, windowing, time-injectable for tests) + canvas render with the **amber zero-gamma line**, white spot trace, right-edge labels and hover tooltips.

### Depth heatmap v2 — resting-liquidity walls (Order Flow)
`src/lib/orderflow/walls.ts` pure detector over the same 1-second depth columns the chart paints: threshold = **max(p98 size, median×6)**, gap-tolerant life-cycle (appear ≥ TH → persist ≥ 0.6·TH or unseen ≤ 6 s → vanish), bid/ask side inferred from the column mid, sub-2 s flickers filtered (5 tests). Chart renders **bracket lines at defended levels** (teal bid / rose ask + peak dot) and **amber ✕ at vanish events**; a persisted `walls` toggle; `?walls=1` on `/api/orderflow/heatmap` runs the same scan server-side so the wall list survives reloads. `usePersisted` now merges defaults over restored objects so NEW option keys default-on for old sessions (scalars untouched).

**Verified live:** funding grid 168/168 cells colored (a values-transpose bug against HeatMatrix's `[col][row]` indexing was caught live in the browser and fixed); GEX sampler 1 → 2 → 3+ columns over minutes with SHORT-GAMMA regime + zero-gamma trace pixels confirmed; IV surface moneyness rows −47%…ATM with term + skew strips; orderflow walls on real BTC depth (286 s → 14 live walls, 30 recent vanishes, markers pixel-confirmed). 190/190 vitest (18 new), tsc + eslint clean on every touched file, zero console/page errors. Captures: `docs/assets/ui-v2-captures/r6-*`.

**Secrets:** none in the diff.
EOF
)
PR=$(curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "$(jq -n --arg title "V2 P2b: funding heat grid · IV surface v2 · GEX session heatmap · depth walls" --arg head "${BRANCH}" --arg base "main" --arg body "${BODY}" '{title:$title,head:$head,base:$base,body:$body}')")
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
