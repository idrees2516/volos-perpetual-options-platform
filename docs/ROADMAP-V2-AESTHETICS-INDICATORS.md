# VolOS V2 — Aesthetics, Heatmaps, Indicators & Copilot Deep-Integration Roadmap

> **Status: PLAN + P0/P1/P2/P2b SHIPPED.** This is the agreed next-steps roadmap for the
> VolOS perpetual-options terminal. Landed so far:
> 1. *(shipped earlier)* The left (Analytics) and right (Strategy Lab) nav rails
>    were **merged into ONE unified rail** with **Strategies pinned on top**;
>    InstaBox deployment retired — localhost + preview only.
> 2. *(shipped — P1)* **`feat/design-tokens`**: the `--volos-*` token
>    layer (surfaces / edges / pos-neg-neut numerals / focus) in `globals.css`,
>    a persisted **compact|comfortable density toggle** (row heights / cell
>    padding via CSS vars, wired through the topbar), **LiveNum/LivePct**
>    flash-on-change numerals (teal up / rose down, tabular, no layout shift)
>    live on the topbar ticker, and the shared **PanelState** primitive
>    (skeletons sized to content / empty / error+retry) with shimmer +
>    reduced-motion discipline.
> 3. *(shipped — P1)* **`feat/heatmap-system`**: shared
>    `src/lib/quant/heatmap.ts` (rose↔slate↔teal diverging scale, viridis-class
>    sequential scale, legend ticks, squarified-treemap layout — 13 unit tests),
>    the **Market Map tab** in Quant Lab with the **market-breadth treemap**
>    (64 tiles from ONE Binance sweep — area = 24h turnover, color = 24h
>    change / funding APR / volume share, robust p90 domains so outliers
>    saturate instead of washing the map, hover tooltips, click-to-focus),
>    the **cross-asset correlation matrix** (8 majors × 7d/30d/90d Pearson on
>    log returns from the backfill store with a live fallback, per-asset
>    drop-resilience), and the shared **HeatLegend**.
> 4. *(shipped — P2)* **`feat/indicator-core`**: the technical battery end-to-end —
>    `src/lib/quant/indicators.ts` (pure kernels: SMA/EMA/WMA, RSI, MACD,
>    Stochastic, ADX/DMI, Aroon, Supertrend, Ichimoku, Bollinger, ATR, Keltner,
>    Donchian, historical vol, BB-vs-KC squeeze, OBV, anchored VWAP, per-bar
>    delta, CVD, taker ratio — **25 unit tests**), the store-first
>    `indicator-service.ts` (native tf → 30m/1m aggregation → live fallback,
>    **contiguity trim** so mirror holes can't fabricate moves, staleness
>    guard, store-stale degrade ladder, escalating venue backoff),
>    `GET /api/quant/indicators` (39 aligned series + decision stats), the
>    **Indicators tab** in Quant Lab with `<IndicatorChart>` — canvas candles
>    + volume shadow + EMA/BB/VWAP/Supertrend/Ichimoku-cloud/Donchian overlays,
>    Δ+CVD / RSI / MACD / Stoch / ADX / OBV sub-panes, crosshair + OHLCV tooltip,
>    and every control persisted (new `usePersistedState` external-store hook).
> 5. *(shipped — P2b)* **`feat/depth-heatmap-v2` — the §1 visual set completed:**
>    the **funding heat grid** (`/api/quant/market/funding`, asset × 8h-event
>    APR heat, store-first with a staggered live sweep + per-asset
>    drop-resilience — 7 tests, Market Map tab), the **IV surface v2**
>    (moneyness row axis, shared viridis scale + HeatLegend — now in
>    `quant-viz` — term-structure & 25Δ-skew strips, robust p10..p90 domain),
>    the **GEX session heatmap** (`/api/quant/gex?view=session` — a server-side
>    1-minute sampler ring off the SHARED chain snapshot, so the strike × time
>    grid costs zero extra venue calls; canvas render with the amber zero-gamma
>    line + white spot trace — 6 tests), and the **depth heatmap v2 walls**
>    (`src/lib/orderflow/walls.ts` pure detector — robust p98 threshold,
>    gap-tolerant wall life-cycle, bid/ask side inference — chart bracket/✕
>    markers + toggle + `?walls=1` server scan that survives reloads — 5 tests).
>    Verification: 190/190 vitest, tsc/eslint clean on every touched file,
>    browser-verified golden paths incl. a transpose bug in the funding grid
>    caught live (168/168 cells), captures in `docs/assets/ui-v2-captures/r6-*`.

5. *(shipped — P3)* **`feat/script-lab` — the workspace went FREE-FORM + scriptable:**
    the **Script Lab** view — a fully adjustable studio where every panel is a
    floating window (drag by title bar, resize from 8 edges/corners,
    maximize/restore, minimize-to-dock, close & reopen, focus z-order, tile &
    reset, layout persisted). Its engine is **VolScript** — a Pine-Script-v5-
    COMPATIBLE subset with the desk's orderflow natives (buyvol/sellvol/
    delta/cvd) as first-class series: `indicator()`/`strategy()` declarations,
    `ta.*` kernels (sma/ema/wma/rma/rsi/atr/stoch/macd/supertrend/kama/
    linreg/correlation/percentrank/vwap/obv…), `math.*`, `input.*` auto-form,
    `plot/plotshape/hline`, `strategy.entry/close/exit` with **next-bar-open
    fills, intrabar stops, commission** — a deterministic vectorized engine
    (lexer/parser/interpreter/backtest, 20 unit tests, every library script
    is a conformance fixture). The **17-category script library** (Trend …
    Validation, mirroring the classic TradingView taxonomy) ships ~45
    working templates; user scripts persist to SQLite (`Script`,
    `ScriptRun` — every strategy run auto-logged with its code+stats as a
    track record). The **AI Script Desk** writes VolScript from plain-English
    descriptions, explains/improves the current script, and translates pasted
    Pine (`POST /api/scriptlab/ai`, glm desk model grounded on the live
    dataset; verified end-to-end: AI-generated strategies compile and
    backtest on real bars). Bars come from the same store-first ladder as
    Quant Lab (`loadBars` extracted from indicator-service →
    `GET /api/scriptlab/bars`). Browser-verified golden paths: drag/resize/
    maximize/minimize/restore, category→script→run, compile-error reporting
    with jump-to-line, save→library, AI generate→open&run.

Everything else below is design + research + phasing for future PRs.

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

## 4. Indicator library (P2 core SHIPPED — kernels in-house)

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

**Decision as shipped (P2): the compute layer went IN-HOUSE.** The kernel
library (`src/lib/quant/indicators.ts`, pure TS, zero dependencies, 25 unit
tests) + store-first service + `/api/quant/indicators` + `<IndicatorChart>`
landed with no new chart dependencies — same doctrine as the heatmap phase
(one visual language, no bundle weight). openalgo-charts and PineTS remain
candidates for LATER phases where they earn their keep:

- **openalgo-charts** — if/when we want drawing tools, the exotic bar types
  (Renko, P&F, Kagi) and the long-tail indicator catalog (112), wired as a
  SECOND chart core for the Indicators tab behind a dynamic import.
- **PineTS** — if/when the copilot needs to run Pine Script logic
  (`request.security()` MTF context) as server-side indicator feeds.

Until then the shipped kernels cover families 1/2/3 and the options-native
family 4 hooks into our own GEX/IV engines (see §5).

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

**Architecture (as implemented in P2):**
- Server-side compute first: `src/lib/quant/indicators.ts` (pure kernels) +
  `src/lib/quant/indicator-service.ts` (store-first bar loader: native tf →
  30m/1m aggregation → live fallback, contiguity trim, staleness guard,
  60 s cache), exposed via `GET /api/quant/indicators` — 39 aligned series +
  decision stats per snapshot.
- Chart component `<IndicatorChart symbol-bars overlays subpane>` — canvas
  core in the terminal's visual language; overlay choices persisted per user
  (`usePersistedState`, localStorage, external-store pattern).
- Every indicator value stream is readable by the copilot (see §5 — P3).
- openalgo-charts / PineTS enter only as later additions (see decision above).

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
| P0 | `feat/unified-rail` | shipped | — |
| P0 | `chore/retire-instabox` | shipped: deploy tooling removed; preview+localhost only | — |
| P1 | `feat/design-tokens` | **SHIPPED** — `--volos-*` token layer, density toggle, LiveNum flash, PanelState | — |
| P1 | `feat/heatmap-system` | **SHIPPED** — shared color/legend module + breadth treemap + correlation matrix (Market Map tab) | stored history |
| P2 | `feat/indicator-core` | **SHIPPED** — indicator kernels (25 tests) + store-first `/api/quant/indicators` + `<IndicatorChart>` + Indicators tab (families 1/2/3) | P1 tokens |
| P2b | `feat/depth-heatmap-v2` + IV/GEX heatmaps | **SHIPPED** — funding heat grid (Market Map) + IV surface v2 (moneyness/viridis/skew+term strips) + GEX session (strike × time + zero-gamma) + depth walls (markers + `?walls=1`) — 18 new tests | heatmap-system |
| P3 | `feat/script-lab` | **SHIPPED** — VolScript engine + floating-window studio + 17-category library + backtests + AI codegen (§4 scripting track realized) | indicator-core |
| P3 | `feat/collapsible-everywhere` | §3 primitive + registry + migration order | P1 |
| P3 | `feat/copilot-indicator-integration` | §5 tools + bridges + scheduled Firecrawl pulls + RAG journaling | indicator-core |
| P4 | `feat/navigation-v2` | command palette, URL state, responsive, keyboard map | collapsible |
| P5 | `chore/ci-hardening` | typecheck baseline (251 pre-existing errors → 0), lint gates, Playwright smoke of the golden paths, dev.log hygiene | all |

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
