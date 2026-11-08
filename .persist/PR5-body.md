## What

Two deeply-integrated capabilities on top of the Strategy Lab stack (#4), inspired by **Firecrawl Alexandria** and **@json-render/chat**:

### 1. Internet research — the VolOS Alexandria web-intel engine

- **`src/lib/ai/alexandria-sources.ts`** — the VolOS "Alexandria": a curated catalog of **40+ options & derivatives industry sources** across 9 categories (exchanges, market-data aggregators, analytics desks, research shops, news wires, education hubs, macro, DeFi, traditional index options) — Deribit Insights, Paradigm Research, Laevitas, Amberdata, CoinGlass, Velo, Greeks Live, The Block Research, CBOE, CME, OIC, tastytrade, Aevo, Derive… Each source declares focus + authority; `routeAlexandriaSources()` ranks the catalog per query (keyword→category scoring), the same "one catalog for every source" idea as Firecrawl Alexandria, specialized for **options position creation, market data and analytics**.
- **`src/lib/ai/web-intel.ts`** — the research engine with a provider chain: **Firecrawl** (`search` with domain-boosting from routed sources, `scrape` markdown, `findTools` + Alexandria provider calls) when `FIRECRAWL_API_KEY` is set → **z-ai `web_search`** fallback (real internet results, no key needed) → plain-HTTP page digest → clearly-labeled local degradation. TTL-cached; normalized `WebHit`/`PageDigest` shapes regardless of provider.
- **`src/lib/ai/web-intel-tools.ts`** — three new agent tools: `research_web` (industry web search with source attribution + routing preview), `scrape_page` (deep URL digest), `web_sources` (catalog transparency — "where can you read for me?").

### 2. Generative UI — @json-render cards in the Copilot chat

- **`src/lib/cards/catalog.ts`** — a `defineCatalog` (from `@json-render/core` + the React element-tree schema) with 10 options-domain components: `SectionCard`, `Grid`, `StatGrid`, `DataTable`, `LineChart`, `BarChart`, `ResearchDigest`, `InsightList`, `Alert`, `ActionCard`, plus platform actions `load_strategy` / `paper_deploy` / `open_url`. The system-prompt section is **derived from the catalog definition itself** (components + zod-derived prop signatures + rules), ~4.9k chars.
- **`src/lib/cards/render-card-tool.ts`** — the `render_card` tool: model-friendly normalization (payload-nested buttons, string findings/columns, positional rows, omitted nullish fields, dangling children refs) + **deep zod validation with precise rejection issues** so the orchestrator self-corrects and re-calls with a fixed spec.
- **`src/components/terminal/copilot/json-cards.tsx`** — the frontend half: `defineRegistry` renders the SAME catalog as real VolOS-styled components (SVG sparklines with baselines, horizontal bars, dense tables, source chips, action buttons) via `Renderer`; card buttons bridge to the REAL platform — load strategy into the builder, paper-deploy the current strategy to the desk, open sources in a new tab.
- **Copilot route** — webIntelTools + `render_card` merged into the toolbelt; system prompt gains the web-research guide + card vocabulary; `maxSteps: 16`.
- **Copilot panel** — `render_card` invocations render as `JsonCard` inline in the chat; card action handlers registered (paper-deploy resolves the current strategy legs through the same venue-routing API as the variant cards); new **Research capability chip** + per-view web-research suggestion chips.
- **agent-activity** — pretty tool cards: `research_web` (hits with domains/dates/source badges + Alexandria routing footer + engine badge), `scrape_page` (expandable digest), `web_sources` (source catalog cloud).

### 3. Reliability fix (zai-provider)

`sanitizeToolArgs` repairs malformed/truncated GLM tool-call JSON before it reaches the Vercel AI SDK: raw control chars inside strings, unterminated strings, unbalanced brackets from stream cuts — 4-stage repair with truncation closing, unit-tested (8/8 cases). Without it, large card specs occasionally killed the whole stream with "An error occurred."

## Verified end-to-end (dev server, live)

- Web research: `research_web` "BTC options implied volatility outlook" → 4–6 real hits (CME, CoinDesk, Deribit…) with Alexandria routing (Deribit Insights · Amberdata · Paradigm · …); `scrape_page` digested coinglass + derive.xyz pages.
- Full agentic card flow: research question → `research_web` → `scrape_page` → `get_market_state` → first `render_card` **rejected with precise issues** → model fixed the spec → second `render_card` **rendered** `SectionCard + ResearchDigest + StatGrid + DataTable + ActionCard` (5 elements).
- In the real UI: web-research hits card + research digest with clickable source chips (↗ Delta Exchange / Fidelity / Investopedia) + live StatGrid (BTC $76,034 +0.52% · IV 36.1% · OI $5.35B · theta) + action buttons — then clicking **"Paper-Deploy Strategy"** filled a real paper position (BTC 76,000 call on **OKX**, net premium −$2,690, cash $97,295, toast + desk confirmed). Zero console errors.
- `tsc --noEmit`: 0 new errors (38 pre-existing, unchanged).

## Configuration

- `FIRECRAWL_API_KEY` (optional) — unlocks full Firecrawl: domain-boosted search, deep markdown scrapes, Alexandria provider tool discovery/execution. Without it the desk still researches the real internet via the built-in fallback chain.

Stacked on #4 (merge #1 ← #2 ← #3 ← #4 ← this).
