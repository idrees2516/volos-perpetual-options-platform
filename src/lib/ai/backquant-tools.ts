// ---------------------------------------------------------------------------
// ai/backquant-tools — the Copilot's BACKQUANT MARKET INTELLIGENCE toolbelt.
//
// Mirrors BackQuant's 23 MCP tools (get_brief, get_gex_levels, get_tape,
// get_iv, get_probability …) into the Vercel AI SDK tool() shape so the
// Research Director can pull dealer positioning, GEX walls, IV surfaces,
// options-tape flow, liquidation maps, ETF flows, COT and SEC filings
// conversationally — through the same data plane the BackQuant workspace
// uses (live REST when BACKQUANT_API_KEY is set, honest demo engine
// otherwise; every result carries mode: 'live' | 'demo').
//
// When the key is present the Copilot can ALSO route through the real
// mcp.backquant.com server (bq_transport=mcp) — the same conversational
// data path Claude/Cursor use.
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import { runBackQuantTool, mcpAvailable, BQ_MCP_TOOLS } from '../backquant/mcp';
import { bqMode, bqApiKey, BQ_BASE_URL, BQ_MCP_URL } from '../backquant/client';
import { BQ_ENDPOINT_COUNT } from '../backquant/endpoints';

const SYMBOL_DESC = 'Underlying symbol: BTC, ETH or SOL (mapped to BTCUSDT/ETHUSDT/SOLUSDT)';

/** JSON-Schema-shaped tool parameter map (compatible with the AI SDK's jsonSchema). */
type ToolParamMap = Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; enum?: string[] }>;

function bqTool(
  name: string,
  params: ToolParamMap,
  required: string[],
  description: string,
) {
  return tool({
    description,
    parameters: jsonSchema<Record<string, unknown>>({
      type: 'object',
      properties: params,
      required,
    }),
    execute: async (args: Record<string, unknown>) => {
      // Route through the REAL BackQuant MCP server when the user asked for
      // MCP transport and a key is configured; otherwise the VolOS data plane.
      const transport = String(args.bq_transport ?? '');
      if (transport === 'mcp' && mcpAvailable()) {
        try {
          const { mcpToolsCall } = await import('../backquant/mcp');
          const remote = (await mcpToolsCall(name, args)) as Record<string, unknown>;
          if (remote && typeof remote === 'object') {
            return { ...remote, tool: name, mode: 'live', transport: 'mcp' };
          }
        } catch {
          // fall through to the VolOS data plane below
        }
      }
      try {
        const r = await runBackQuantTool(name, args);
        return { ...r, transport: bqMode() === 'live' ? 'rest' : 'demo-engine' };
      } catch (e) {
        return { tool: name, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export const backquantTools = {
  // ── start here ─────────────────────────────────────────────────────────────
  bq_brief: bqTool(
    'get_brief',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'], description: 'Force transport: mcp routes through the real mcp.backquant.com (needs API key); rest/demo uses the VolOS data plane. Default auto.' },
    },
    [],
    'ONE-CALL MARKET BRIEF from BackQuant: spot vs dealer-gamma levels (HVL, call wall, put support), 1σ expected move, perp OI + funding, 12h options-tape premium and the front expiry summary. BEST FIRST MOVE for any open question about a crypto market (positioning, "where are we", regime). Combines GEX levels + market bundle + tape stats + expiry summary + expected move.',
  ),

  // ── positioning & levels ───────────────────────────────────────────────────
  bq_gex_levels: bqTool(
    'get_gex_levels',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      positioning: { type: 'string', enum: ['flow', 'std'], description: 'Dealer positioning model: flow (tape-signed, default) or std (static)' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant GEX KEY LEVELS: gamma flip (HVL), call wall/resistance, put support (all-expiry + 0DTE), plus ranked largest-GEX strikes, max pain and expected move. Use for "where are the gamma walls", "flip level", dealer pinning zones.',
  ),
  bq_gex_strike_profile: bqTool(
    'get_gex_strike_profile',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      expiry: { type: 'string', description: 'all | 0dte | an expiry token like 2026-11-14' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant GEX BY STRIKE: net/call/put gamma exposure and OI per strike with the ranked top-10 by |GEX|. Use for strike-by-strike dealer positioning, "which strikes hold the biggest gamma".',
  ),
  bq_greek: bqTool(
    'get_greek',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      greek: { type: 'string', enum: ['gamma', 'vanna', 'charm', 'vega', 'theta', 'delta'], description: 'Which dealer greek exposure to profile' },
      positioning: { type: 'string', enum: ['flow', 'std'] },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant GREEK EXPOSURE PROFILE: dealer net/call/put exposure by strike for any greek (gamma, vanna, charm, vega, theta, delta). Use for vanna/charm regimes, "where is dealer vega", hedging-pressure questions beyond gamma.',
  ),
  bq_max_pain: bqTool(
    'get_max_pain',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      expiry: { type: 'string', description: 'next | 0dte | all | an expiry token' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant MAX PAIN: the strike where the most option value expires worthless, per expiry, with the full pain curve. Use for expiry pinning, OPEX-day magnets.',
  ),
  bq_compare_symbols: bqTool(
    'compare_symbols',
    {
      symbols: { type: 'string', description: 'Comma list, e.g. "BTC,ETH,SOL" (up to 8)' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant MULTI-SYMBOL GEX: HVL / call wall / put support for up to 8 symbols side by side in one call. Use for cross-asset positioning comparisons.',
  ),

  // ── flow & tape ────────────────────────────────────────────────────────────
  bq_tape: bqTool(
    'get_tape',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      hours: { type: 'number', description: 'Lookback 1–168 hours. Default 12.' },
      limit: { type: 'number', description: 'Number of prints to return, default 20' },
      min_premium_usd: { type: 'number', description: 'Only show prints above this premium' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant OPTIONS TAPE: individual multi-venue option prints (venue, instrument, strike, side, premium_usd, IV, delta) plus window aggregates. Use for "what traded", biggest print this week, aggressive call buying checks.',
  ),
  bq_flow_by_strike: bqTool(
    'get_flow_by_strike',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      strike: { type: 'number', description: 'Ask about ONE strike directly, e.g. 100000' },
      expiry: { type: 'string', description: 'Optional expiry token filter' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant FLOW BY STRIKE: cumulative aggressor buying vs selling by strike on still-open contracts, split call-buy / call-sell / put-buy / put-sell. Pass strike to ask "is anyone buying calls at 100k".',
  ),
  bq_dealer_flow: bqTool(
    'get_dealer_flow',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      positioning: { type: 'string', enum: ['flow', 'std'] },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant DEALER FLOW: estimated dealer hedging flow time series (gamma + vanna + charm components) across chain snapshots. Use for hedge-pressure regimes and "are dealers buying dips or selling rallies".',
  ),

  // ── volatility & pricing ───────────────────────────────────────────────────
  bq_iv: bqTool(
    'get_iv',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['atm', 'surface', 'skew', 'term', 'cm'], description: 'atm = front tenor; surface = fitted strike×expiry; skew = 25Δ/10Δ RR+butterfly; term = ATM by tenor; cm = constant-maturity' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant IV SUITE: implied volatility in whichever cut you need — ATM by tenor, the fitted surface (SVI per expiry), 25Δ/10Δ skew + butterflies, or constant-maturity vols with arbitrage checks. Use for any IV level, skew, smile, term-structure or VRP-adjacent question.',
  ),
  bq_expected_move: bqTool(
    'get_expected_move',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['implied', 'calibrated'], description: 'calibrated (BTC/ETH) gives realistic 68%/90% bands for 1h/4h/24h with hit-rate record' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant EXPECTED MOVE: ATM-straddle 1σ/2σ implied move bands; view=calibrated rescales to realized moves at 1h/4h/24h with out-of-sample hit rates. Use for "how much can BTC move today / this opex".',
  ),
  bq_probability: bqTool(
    'get_probability',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      price: { type: 'number', description: 'A specific price level, e.g. 100000 — odds of finishing above/below it' },
      expiry: { type: 'string', description: 'next | expiry token' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant PROBABILITY: risk-neutral PDF/CDF (Breeden-Litzenberger) per expiry — market-implied odds of finishing above/below a price, distribution mode and confidence bands. Use for "what are the odds of 100k by Friday".',
  ),
  bq_basis: bqTool(
    'get_basis',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant BASIS: dated-futures annualized basis curve by maturity + perp basis. Use for carry, cash-and-carry, curve-shape questions.',
  ),

  // ── structure & history ────────────────────────────────────────────────────
  bq_oi: bqTool(
    'get_oi',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['by_expiry', 'history'], description: 'by_expiry (default) or history time-series' },
      limit: { type: 'number', description: 'History points, default 200' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant OPEN INTEREST: call/put OI per expiry, or total OI history over time. Use for positioning build-up, OI roll-off ahead of OPEX.',
  ),
  bq_expiry_summary: bqTool(
    'get_expiry_summary',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant EXPIRY SUMMARY: every active expiry with DTE, type (daily/weekly/monthly/quarterly, anchor flags), ATM IV, skew, PCR, OI, net GEX, notional and max pain. Use for chain-wide screening and picking expiries.',
  ),
  bq_opex: bqTool(
    'get_opex',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      horizon_days: { type: 'number', description: 'Days ahead, default 45' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant OPEX CALENDAR: upcoming expirations with how much OI and notional rolls off each, ATM IV and expected move per event. Use for OPEX-day workflow planning, roll timing, event risk.',
  ),
  bq_history: bqTool(
    'get_history',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      metric: { type: 'string', enum: ['gex', 'oi', 'stress'], description: 'gex = total GEX history; oi = OI history; stress = long-window HVL/walls from Postgres' },
      days: { type: 'number', description: 'Observations, default 90' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant HISTORY: how a positioning metric (total GEX, OI, or long-window HVL/wall levels) has changed over time. Use for regime analysis, backtests, "where has positioning been".',
  ),
  bq_liquidation: bqTool(
    'get_liquidation',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['heatmap', 'distribution'], description: 'heatmap (price × time) or distribution (per level, with leverage tiers)' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant LIQUIDATIONS: where leveraged perp positions get liquidated — intensity heatmap (price × time) or per-level long/short volumes with leverage estimates. Use for magnet/air-pocket risk around price levels.',
  ),
  bq_perps: bqTool(
    'get_perps',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] },
      hours: { type: 'number', description: 'Window, default 72' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant PERPS: the perpetual-futures picture — OI, funding, price, perp CVD and liquidations on one aligned axis, plus perp basis. Use for funding-pressure, leverage and perp-positioning questions.',
  ),

  // ── spot ETFs / filings ────────────────────────────────────────────────────
  bq_etf_flows: bqTool(
    'get_etf_flows',
    {
      symbol: { type: 'string', description: 'BTC or ETH' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant ETF FLOWS: daily net creations/redemptions for the US spot crypto ETFs, per fund and in total, plus cumulative since launch. Settlement lags a business day by design. Use for structural demand, "is IBIT seeing inflows".',
  ),
  bq_filings: bqTool(
    'get_filings',
    {
      kind: { type: 'string', enum: ['cot', 'insider', 'holders'], description: 'cot = CFTC positioning across markets; insider = SEC Form 4 at COIN/HOOD; holders = 13F top holders of MSTR/COIN/HOOD/IBIT' },
      ticker: { type: 'string', description: 'For insider: COIN or HOOD. For holders: MSTR, COIN, HOOD or IBIT.' },
      key: { type: 'string', description: 'For cot instrument view: e.g. cme_btc' },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant FILINGS: public regulatory data — CFTC Commitments of Traders positioning (leveraged funds / asset managers / dealers, weekly change, 3y percentile), SEC Form 4 insider trades at COIN/HOOD, and top 13F institutional holders of MSTR/COIN/HOOD/IBIT. Use for smart-money positioning questions.',
  ),

  // ── discovery ──────────────────────────────────────────────────────────────
  bq_list_symbols: bqTool(
    'list_symbols',
    { bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] } },
    [],
    'BackQuant SYMBOL CATALOG: which crypto markets are covered and which data categories are live for each (gex/chain/iv/greeks/tape/oi/market). Use when unsure what symbols the BackQuant desk can pull.',
  ),
  bq_list_expiries: bqTool(
    'list_expiries',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      bq_transport: { type: 'string', enum: ['auto', 'mcp', 'rest'] },
    },
    [],
    'BackQuant ACTIVE EXPIRIES: the valid expiry tokens (with DTE and type) passable to expiry-taking tools. Rarely needed first — those tools also accept "next".',
  ),

  // ── catalog transparency ───────────────────────────────────────────────────
  bq_catalog: tool({
    description:
      'BackQuant data catalog transparency: what the desk can pull — all 23 MCP tools grouped (positioning, flow/tape, volatility, structure, ETFs, filings, discovery) plus how the transport works (live REST vs demo engine vs the real mcp.backquant.com server) and the full 70-endpoint REST registry. Use for "what BackQuant data do you have", "which tools can you use", transport/key questions.',
    parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => ({
      mode: bqMode(),
      configured: Boolean(bqApiKey()),
      apiBase: BQ_BASE_URL,
      mcpServer: BQ_MCP_URL,
      transportNote: bqMode() === 'live'
        ? 'BACKQUANT_API_KEY is set: tools hit the live BackQuant v2 API (and can route through the real MCP server via bq_transport=mcp).'
        : 'No BACKQUANT_API_KEY set: tools are served by VolOS\'s BackQuant-compatible demo engine (deterministic, anchored on live spot) — every result is labeled mode:"demo". Add the key to .env to go live.',
      restEndpoints: BQ_ENDPOINT_COUNT,
      mcpTools: BQ_MCP_TOOLS.map((t) => ({ name: `bq_${t.name.replace(/^get_/, '').replace(/^list_/, 'list_')}`, remote: t.name, group: t.group, answers: t.answers, args: t.args })),
    }),
  }),
};

/** System-prompt section teaching the Copilot the BackQuant data layer. */
export function backquantSystemPrompt(): string {
  const mode = bqMode();
  const lines: string[] = [];
  lines.push('## BackQuant market intelligence (dealer positioning, GEX, IV, tape, filings)');
  lines.push(
    'You have BACKQUANT tools — institutional crypto-options analytics mirroring the BackQuant MCP server (23 tools + the 70-endpoint v2 API). They answer: where dealer gamma is (walls, HVL, max pain, pin zones), what aggressors traded (multi-venue options tape, whale prints, flow by strike), the vol surface (skew, smiles, term structure, VRP, expected move, risk-neutral odds), perp positioning (OI, funding, CVD, liquidation maps), spot-ETF flows, COT and SEC filings.',
  );
  lines.push('- Start open market questions with bq_brief (one call: price vs gamma levels + perps + tape + front expiry).');
  lines.push('- Positioning: bq_gex_levels / bq_gex_strike_profile / bq_greek / bq_max_pain / bq_compare_symbols.');
  lines.push('- Flow: bq_tape (prints + aggregates), bq_flow_by_strike ("is anyone buying calls at 100k"), bq_dealer_flow.');
  lines.push('- Vol: bq_iv (any cut), bq_expected_move, bq_probability (odds of a level), bq_basis.');
  lines.push('- Structure: bq_oi, bq_expiry_summary, bq_opex, bq_history, bq_liquidation, bq_perps.');
  lines.push('- Macro/flows: bq_etf_flows, bq_filings (COT / Form 4 / 13F). Discovery: bq_list_symbols, bq_list_expiries, bq_catalog.');
  lines.push('- The BackQuant workspace view renders the same data plane (/api/backquant/*) — cite its numbers consistently.');
  if (mode === 'live') {
    lines.push('- LIVE MODE: BACKQUANT_API_KEY is set — BackQuant data is real (mcp.backquant.com / api.backquant.com v2). Results carry as_of/data_age_seconds/venues; read them before claiming freshness.');
  } else {
    lines.push('- DEMO MODE: no BACKQUANT_API_KEY. Every BackQuant tool returns mode:"demo" — deterministic simulation anchored on the REAL live spot. When using these numbers SAY they are simulated BackQuant-style data (label charts/cards "demo"), and recommend adding a BackQuant API key for live dealer-positioning data. Never present demo numbers as live BackQuant data.');
  }
  lines.push('- Render BackQuant answers as cards: StatGrid for levels/expected move, DataTable for strikes/whales/expiries, LineChart for series (dealer flow, term structure), BarChart for venue splits / flow by strike, and the HeatMatrix component for strike×expiry GEX / IV surface / TRACE maps.');
  return lines.join('\n');
}
