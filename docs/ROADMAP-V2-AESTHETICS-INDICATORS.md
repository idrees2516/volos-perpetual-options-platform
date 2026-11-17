# VolOS V2 — Aesthetics, Heatmaps, Indicators & Copilot Deep-Integration Roadmap

> **Status: PLAN ONLY — no implementation in this document.** This is the agreed next-steps
> roadmap for the VolOS perpetual-options terminal. Two items landed alongside this plan
> (they were explicit, bounded instructions, not part of the "plan-only" batch):
> 1. The left (Analytics) and right (Strategy Lab) nav rails were **merged into ONE unified
>    rail** with **Strategies pinned on top** and everything else below.
> 2. InstaBox deployment retired — the app now runs **only on localhost + preview**.
>
> Everything else below is design + research + phasing for future PRs. Estimated as a
> whole: ~4 focused PRs over multiple sessions.

---

## 0. Context & principles

VolOS today is a dense, data-rich terminal: 131-strategy catalog, gamma/GEX lab,
orderflow desk (heatmap, absorption, liquidations), quant lab (IV/PDF, perps,
SSE tape), conformal forecasting, paper desk with autopilot, and an AI copilot
with 40+ tools and RAG memory. The next chapter is about **making it look and
feel like a professional desk**: calmer chrome, deeper visuals (heatmaps front
and center), every component foldable, a real indicator library, and the AI
wired into all of it.

Working principles:

- **Traders first**: every visual upgrade must make a decision faster or a
  pattern more legible. Aesthetic changes that only decorate get cut.
- **One visual language**: shared design tokens, one charting core, one
  collapsible primitive, one tooltip/toast system — no per-view one-offs.
- **Data gravity**: indicators and web pulls flow through the same pipelines
  the copilot already trusts (venue adapters, Prisma store, RAG memory), so UI
  and AI always see the same numbers.

---

## 1. Heatmap visualizations (the headline track)

VolOS already has heatmap bones: `/api/orderflow/heatmap` (resting-liquidity
grid), `heatmap-render.ts` (canvas renderer), and the gamma lab heatmaps
(VEX / IV-by-delta). V2 promotes heatmaps from "a panel in orderflow" to a
first-class visual system across the whole terminal.

| Heatmap | What it shows | Data source (exists / new) | Reference look |
|---|---|---|---|
| **Market breadth treemap** | whole-market map: tiles sized by market cap / OI / perp volume, colored by 24h change, funding, OI delta, RSI or relative volume | new aggregate endpoint over the existing 11-venue connectors (Binance, Bybit, OKX, Hyperliquid, Coinbase, Kraken, Bitget…) | Coin360 / CoinMarketCap heatmap, Sharpe.ai treemap |
| **Orderbook depth heatmap v2** | historical bid/ask liquidity walls behind price, time × price grid, wall-event markers | existing `orderflow/heatmap` API + depth snapshots already stored | Bookmap, CoinGlass BTC liquidity heatmap |
| **Cross-asset correlation matrix** | rolling correlation of the desk's underlyings + perps vs. BTC/ETH, multiple horizons (1d/1w/1m) | computed from stored price history (A1 backfill) | quant-desk standard |
| **IV surface heatmap** | IV by strike × tenor, per venue, with skew gradient + term structure strip | existing Deribit chain pulls (`quant/deribit.ts`) | Deribit / Laevitas surfaces |
| **GEX by strike × time** | net dealer gamma exposure evolving through the session, zero-gamma pivot line | existing GEX engine (`gamma-flow.ts`, `quant/gex`) | SpotGamma-style grid |
| **Funding / basis heatmap** | perp funding + basis across venues as a venue × time grid — the "where is leverage" map | existing funding/OI endpoints | CoinGlass funding heat |

Rendering plan: keep the canvas heatmap-render core (proven, 60fps on dense
grids), add a shared legend/tooltip layer and a single color-scale module
(viridis ↔ desk-brand teal-amber diverging) so all six heatmaps read as one
family. ECharts (Apache-2.0, MIT-class) covers the treemap and correlation
matrix; the depth heatmap stays custom canvas (SciChart-style commercial
alternatives were surveyed and rejected — license + bundle weight).

---

## 2. Professional aesthetics & modern chrome

Audit-derived upgrade list (each item is small, together they are "the look"):

1. **Design tokens pass** — one `globals.css` token layer for surfaces
   (`zinc-950/900/850`), borders, focus rings, positive/negative/neutral
   numerals; deprecate ad-hoc hexes (`#05070a` sprinkles).
2. **Typography** — tabular numerals everywhere numbers animate; a display
   weight for view titles; consistent 8/9/10/11px type ladder (today: 14 sizes
   ad hoc). Monospace price/data cells only where values change per tick.
3. **Density control** — a `compact | comfortable` toggle that swaps row
   heights/paddings via CSS variables; traders get more rows on screen.
4. **Number animation** — flash-on-change (teal/rose) for live prices, smooth
   count-up for P&L; no layout shift (reserve digit width).
5. **Chart polish** — shared axis/grid styling, crosshair with axis labels,
   consistent tooltip cards, sparkline baselines; sunset the three different
   tooltip styles that currently coexist.
6. **States** — every panel gets real loading (skeletons sized to content),
   empty ("no data — venue feed paused"), and error states with a retry; kill
   silent spinners.
7. **Motion** — 150-250ms ease transitions on panel fold/unfold and view
   swaps; nothing bounces; reduced-motion respected.
8. **Scanlines → focus** — the topbar ticker becomes a single live strip with
   better hierarchy (venue source badge, clock UTC, session state).
9. **Page-level scroll containment** — center column scrolls internally on
   every view (today some views stretch the page ~270px and drag the rail
   footer below the fold; pre-existing, fix in this pass).

---

## 3. Every component collapsible

Target: **any panel, anywhere, can fold** — sections inside views, view
sub-panels, cards, even the footer strips — with persisted state.

- **Primitive**: standardize on shadcn `Collapsible` (already vendored) +
   a `PanelHeader` contract: title, live badge, kebab menu (collapse, pop-out
   to builder dock, reset). One component, used ~40 places.
- **State**: extend `ui-store` (zustand + persist) with a
   `panelState: Record<panelId, {collapsed, order, height?}>` map; localStorage
   key `volos-panel-state`. Defaults per panel from a registry.
- **Affordances**: chevron in every header; `[`/`]` for the nav rail (kept),
   `\` toggles "zen mode" (fold everything non-critical), ⌘K palette exposes
   "fold/unfold all".
- **Nesting rules**: max two levels (view → section → card); folding never
   unmounts live subscriptions — panels hide DOM and pause render loops
   (interval/SSE consumers keep running cheaply or resume on unfold).
- **Migration order**: paper desk → strategies (list/catalog/intelligence) →
   orderflow panels → quantlab → gamma lab → forecast panels → trade view.

---

## 4. Indicator library (research done — decision proposed)

**What "openalgocharts" is**: the user-referenced library is
[openalgo-charts](https://github.com/marketcalls/openalgo-charts) (npm
`openalgo-charts`, Apache-2.0, from the OpenAlgo ecosystem): 19 chart types
(candles, hollow/volume candles, OHLC bars, Heikin-Ashi, Renko, Range bars,
Line Break, Point & Figure, Kagi…), **112 built-in indicators + custom via
`registerIndicator`**, ~90 drawing tools, first-class React/Next.js support,
bars keyed by UTC-second timestamps with **optional per-bar open interest** —
a natural fit for perp OI-tagged candles from our venue connectors.

Comparison (researched):

| Option | License | Indicators | Drawings | Fit for VolOS |
|---|---|---|---|---|
| **openalgo-charts** | Apache-2.0 | 112 built-in + custom `registerIndicator` | ~90 | ★★★ purpose-built, React-native, OI-aware bars, active ecosystem |
| **PineTS** (LuxAlgo) | open source (commercial for closed-source) | runs the whole Pine Script® v5/v6 ecosystem, 60+ ta fns, `request.security()` MTF, streaming mode | none (engine only) | ★★★ server-side brain: Pine indicators as data feeds for copilot/autopilot |
| TradingView Lightweight Charts | Apache-2.0 | 0 (bring your own) | few | ★★ rendering-only, 35KB, 50k candles smooth |
| klinecharts | MIT | ~90 built-in | ~20 | ★★ solid candlestick alternative |
| ECharts | Apache-2.0 | n/a (viz primitives: treemap, heatmap, matrix) | n/a | ★★★ already the heat/viz layer choice |
| technicalindicators / Trading-Lib | MIT | 30-127 | none | ★ stale / early-stage, TS-only compute |

**Proposed stack (decision to confirm before build):**
`openalgo-charts` as the interactive candlestick/indicator chart core +
`PineTS` as the server-side indicator runtime (Pine ecosystem + MTF +
streaming recalc on our SSE tape) + ECharts for heatmaps/treemaps/correlations.
All Apache-2.0/MIT-class, zero license risk, no vendor lock.

**Indicator families to expose** (progressive):

1. **Trend / momentum**: SMA/EMA/WMA, RSI, MACD, Stochastic, ADX/DMI, Aroon,
   Supertrend, Ichimoku.
2. **Volatility**: Bollinger Bands, ATR, Keltner, Donchian, historical vol,
   realized-vs-implied spread (IV from our own chain!), Squeeze.
3. **Volume / orderflow-native**: OBV, VWAP (anchored), CVD/footprint,
   volume delta per bar, absorption score (from our own engine), liquidations
   per bar, funding/basis overlay.
4. **Options-native (our differentiator)**: IV rank/percentile overlay, GEX
   level lines on price, zero-gamma pivot marker, skew z-score, expected-move
   cone (from the conformal forecaster), theta-decay grid.
5. **Perps/derivatives**: OI-weighted candles (openalgo-charts per-bar `oi`),
   funding-rate strip, basis chart, long/short ratio.
6. **Multi-timeframe**: 1m→1d via our stored history; PineTS
   `request.security()` for higher-TF context on live tape.

**Architecture** (when implemented):
- Server-side compute first (`src/lib/quant/indicators.ts` calling PineTS /
  openalgo indicator kernels over stored + live bars), cached with the
  existing TTL-cache pattern, exposed via `/api/quant/indicators`.
- Chart component `<IndicatorChart symbol venue timeframe overlays…>` wrapping
  openalgo-charts; overlays declared in URL/search-param state so views are
  shareable.
- Per-user defaults persisted (`ui-store`), and every indicator value stream
  is readable by the copilot (see §5).

---

## 5. Deep integration into the AI copilot

Goal: the copilot stops being a bolt-on chat and becomes the **analyst who
sees everything the trader sees** — indicators, heatmaps, web pulls — and
reasons over them.

1. **Indicator context bridge**: extend `CopilotContextBridge` with the
   active view's indicator snapshot (which overlays, current values, alerts
   firing). New tools: `compute_indicator` (any family, any symbol/TF),
   `read_chart_state`, `screen_by_indicator` (screener over stored history).
2. **Heatmap grounding**: the morning brief and `analyze_market_environment`
   gain treemap/correlation/GEX summaries as structured inputs (top moves,
   regime flips, zero-gamma distance).
3. **Firecrawl web data** (already wired: `research_web`, `scrape_page`,
   `pull_web_data`): set `FIRECRAWL_API_KEY` in `.env.local` to activate
   domain-boosted search, deep scrapes and Alexandria provider tools; then
   schedule recurring pulls (funding/OI snapshots, macro calendar, venue
   changelogs) into the Prisma store so the copilot cites fresh numbers, and
   the morning brief gets a "what changed on the web" section.
4. **RAG loop**: indicator-triggered events (RSI extremes, GEX flips, funding
   spikes) are journaled into the existing memory store — the copilot can
   answer "what happened last time funding was here?" from real history.
5. **Autopilot**: decision engine consumes the same indicator snapshot;
   guardrails extended with indicator-based conditions (e.g. only auto-roll
   when IV rank > x).
6. **Cards**: new render-cards for indicator panels and heatmaps so the
   copilot can answer with the same visuals the UI shows.

---

## 6. Navigation & layout (partially shipped)

Shipped this round (not plan-only): **unified rail** — the old left Analytics
rail + right Strategy Lab rail collapsed into one nav rail, Strategies pinned
on top, then Paper Desk, then all analytics views; single collapse key
(`[`/`]`), persisted. Copilot keeps its own right-side drawer.

Planned next:
1. **Command palette (⌘K)**: jump to any view/strategy/venue/asset, run
   actions ("fold all", "deploy iron condor"), ask copilot inline — one entry
   point for power users.
2. **Breadcrumb → context header**: current view + active strategy/venue/TF
   as shareable state (URL params), so refresh/deep-link lands exactly.
3. **Responsive tier**: tablet layout (rail auto-collapses), mobile layout
   (bottom tab bar + copilot sheet) — currently desktop-only.
4. **Keyboard map**: single cheat-sheet overlay (`?`), consistent single-key
   nav (1-8 for views), `[`/`]` rail, `\` zen.
5. **Footer slim-down**: the capabilities paragraph moves to an About dialog;
   footer becomes a live status strip (feeds, engine, memory, build).

---

## 7. Phasing (proposed PR sequence)

| Phase | PR | Scope | Depends on |
|---|---|---|---|
| P0 | `feat/unified-rail` | shipped (this round) | — |
| P0 | `chore/retire-instabox` | shipped (this round): remove deploy scripts/docs; preview+localhost only | — |
| P1 | `feat/design-tokens` | §2 items 1-6 (tokens, type, density, states, chart polish) | — |
| P1 | `feat/heatmap-system` | §1: shared color/legend/tooltip module + breadth treemap + correlation matrix | stored history |
| P2 | `feat/indicator-core` | §4: openalgo-charts + PineTS wiring, `/api/quant/indicators`, `<IndicatorChart>` with family-1/2/3 overlays | P1 tokens |
| P2 | `feat/depth-heatmap-v2` + IV/GEX heatmaps | §1 remaining visual set | heatmap-system |
| P3 | `feat/collapsible-everywhere` | §3 primitive + registry + migration order | P1 |
| P3 | `feat/copilot-indicator-integration` | §5 tools + bridges + scheduled Firecrawl pulls + RAG journaling | indicator-core |
| P4 | `feat/navigation-v2` | command palette, URL state, responsive, keyboard map | collapsible |
| P5 | `chore/ci-hardening` | typecheck baseline (323 pre-existing errors → 0), lint gates, Playwright smoke of the golden paths, dev.log hygiene | all |

Acceptance per phase: browser-verified golden path, existing vitest suite
green, no console errors, `bun run lint` clean on touched files, screenshots
in `docs/assets/`.

---

## 8. Risks & open questions

- **Bundle weight**: openalgo-charts + ECharts + PineTS in one terminal —
  dynamic-import both chart cores per view; budget < 350KB gz per view chunk.
- **License check**: PineTS commercial terms apply only to closed-source
  distribution — VolOS is an open repo; confirm at build time.
- **Indicator sprawl**: ship curated defaults per view; full catalog behind
  the picker — avoid 112 toggles on first paint.
- **Firecrawl credits**: budget pulls per day + cache TTLs (already in
  `web-intel`); morning brief pulls must stay free-plan friendly.
- **Pre-existing debt to fix during P5**: `page.tsx` localStorage-restore
  effect trips the new `react-hooks/set-state-in-effect` lint rule; `tsc
  --noEmit` baseline has 323 errors (Prisma client generation, chain route
  narrowing) — clean before CI gates on it.

## 9. Research appendix (sources consulted)

- openalgo-charts — https://github.com/marketcalls/openalgo-charts (Apache-2.0; 19 chart types, 112 indicators, ~90 drawings, React/Next.js)
- OpenAlgo platform — https://github.com/marketcalls/openalgo
- PineTS (Pine Script runtime) — https://github.com/LuxAlgo/PineTS , https://www.luxalgo.com/pinets
- TradingView Lightweight Charts — https://www.tradingview.com/free-charting-libraries ; performance comparisons (index.dev, chenguangliang.com)
- klinecharts / ECharts / technicalindicators — npm survey
- Heatmap references: Coin360 (coin360.com), CoinMarketCap crypto-heatmap, Sharpe.ai heatmap (treemap colored by funding/OI/RSI/relative volume), CoinGlass BTC liquidity heatmap, Bookmap, SciChart orderbook-heatmap demo, D3 treemap walkthroughs (massive.com, dev.to)
- InstaBox CLI (deployment retired) — https://instabox.sh/docs/reference/cli
