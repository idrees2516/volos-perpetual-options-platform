// ---------------------------------------------------------------------------
// alexandria-sources — the VolOS "Alexandria": a curated catalog of options &
// derivatives industry data sources on the open web, in the spirit of
// Firecrawl Alexandria ("one catalog for every source").
//
// Every source declares: who they are, what they know, which industry focus
// categories they cover, how authoritative they are, and how to query them.
// `routeAlexandriaSources()` ranks sources for a research query the same way
// Firecrawl's semantic tool discovery ranks providers — but specialized for
// OPTIONS POSITION CREATION, MARKET DATA and ANALYTICS.
//
// The catalog powers:
//   • research_web  — domain-boosted Firecrawl / fallback web search
//   • scrape_page   — deep page digests
//   • web_sources   — transparency tool ("what can you read for me?")
//   • the Copilot's teaching mode ("where does this data come from?")
// ---------------------------------------------------------------------------

export type SourceCategory =
  | 'exchanges'      // venue-native data: chains, IV, OI, flows
  | 'market-data'    // cross-venue aggregators, vol surfaces
  | 'analytics'      // positioning / greeks / flow analytics desks
  | 'research'       // strategy research, papers, builder playbooks
  | 'news'           // industry news wires
  | 'education'      // options education & position creation tutorials
  | 'macro'          // macro / rates / index vol context
  | 'defi'           // DeFi options protocols & on-chain venues
  | 'traditional'    // equities / index options industry (SPX etc.)

export interface AlexandriaSource {
  /** Stable id used in tool results + citations. */
  id: string;
  /** Display name. */
  name: string;
  /** Hostname used for includeDomains boosting in Firecrawl search. */
  domain: string;
  categories: SourceCategory[];
  /** One-line "what this source knows" — also shown to the model. */
  focus: string;
  /** 1 = primary/authoritative (venue, exchange, big analytics desk), 2 = strong, 3 = context. */
  authority: 1 | 2 | 3;
}

export const ALEXANDRIA_SOURCES: AlexandriaSource[] = [
  // ── exchanges: venue-native data ─────────────────────────────────────────
  { id: 'deribit', name: 'Deribit', domain: 'deribit.com', categories: ['exchanges', 'market-data', 'analytics'], focus: 'BTC/ETH options: DVOL index, OI, IV surfaces, block trades, max pain, settlement', authority: 1 },
  { id: 'deribit-insights', name: 'Deribit Insights', domain: 'insights.deribit.com', categories: ['research', 'analytics'], focus: 'Institutional-grade options research: vol regimes, skew, flows, strategy pieces', authority: 1 },
  { id: 'cme', name: 'CME Group', domain: 'cmegroup.com', categories: ['exchanges', 'traditional', 'macro'], focus: 'BTC/ETH futures & options, FedWatch rate probabilities, margin data', authority: 1 },
  { id: 'cboe', name: 'CBOE', domain: 'cboe.com', categories: ['traditional', 'macro', 'education'], focus: 'SPX/VIX options data, VIX term structure, put/call ratios, education hub', authority: 1 },
  { id: 'okx-learn', name: 'OKX Learn', domain: 'okx.com', categories: ['education', 'exchanges'], focus: 'Crypto options strategy guides, Greeks explainers, position construction tutorials', authority: 2 },
  { id: 'bybit-ann', name: 'Bybit Announcements', domain: 'announcements.bybit.com', categories: ['exchanges'], focus: 'Options listings, contract changes, fee updates on Bybit', authority: 2 },
  { id: 'binance', name: 'Binance', domain: 'binance.com', categories: ['exchanges', 'defi'], focus: 'Derivatives listings, BVOL index, options product docs', authority: 1 },

  // ── market-data aggregators ──────────────────────────────────────────────
  { id: 'coinglass', name: 'CoinGlass', domain: 'coinglass.com', categories: ['market-data', 'analytics'], focus: 'Options OI, IV, max pain, liquidations, put/call ratios across venues', authority: 1 },
  { id: 'coinalyze', name: 'Coinalyze', domain: 'coinalyze.com', categories: ['market-data'], focus: 'Real-time derivatives data: OI, funding, liquidations, futures basis', authority: 2 },
  { id: 'amberdata', name: 'Amberdata', domain: 'amberdata.com', categories: ['market-data', 'analytics', 'research'], focus: 'Institutional digital-asset data: options IV, skew, greeks, OI dashboards', authority: 1 },
  { id: 'laevitas', name: 'Laevitas', domain: 'laevitas.ch', categories: ['analytics', 'market-data'], focus: 'Options analytics: vol surfaces, term structure, flows, futures roll analysis', authority: 1 },
  { id: 'coinstats', name: 'CoinStats', domain: 'coinstats.app', categories: ['market-data'], focus: 'Cross-venue price & portfolio aggregates', authority: 3 },

  // ── analytics desks ──────────────────────────────────────────────────────
  { id: 'greeks-live', name: 'Greeks Live', domain: 'greeks.live', categories: ['analytics', 'market-data'], focus: 'Crypto options greeks, IV term structure, live chains, trader positioning tools', authority: 1 },
  { id: 'velo', name: 'Velo Data', domain: 'velo.xyz', categories: ['analytics', 'market-data'], focus: 'Derivatives analytics: OI changes, funding, basis, options flows across venues', authority: 1 },
  { id: 'elluminet', name: 'Elluminet', domain: 'elluminet.io', categories: ['analytics'], focus: 'BTC/ETH options flow, block trades, greeks distribution, vol alerts', authority: 2 },
  { id: 'paradigm-research', name: 'Paradigm Research', domain: 'research.paradigm.co', categories: ['research', 'analytics'], focus: 'Crypto derivatives research: vol market structure, spreads, multi-leg structures', authority: 1 },
  { id: 'coco324', name: 'COCO IV Charts', domain: 'coco324.com', categories: ['analytics'], focus: 'BTC/ETH DVOL, IV surface visualizations, 25d skew, term structure history', authority: 2 },
  { id: 'thetas', name: 'Thetas', domain: 'thetas.network', categories: ['analytics'], focus: 'Crypto options analytics & portfolio greeks', authority: 3 },

  // ── research & strategy playbooks ────────────────────────────────────────
  { id: 'block-research', name: 'The Block Research', domain: 'theblock.co', categories: ['research', 'news'], focus: 'Derivatives deep-dives, options volume trends, market structure reports', authority: 1 },
  { id: 'glassnode', name: 'Glassnode', domain: 'glassnode.com', categories: ['research', 'analytics'], focus: 'On-chain analytics, derivatives indicators, market cycle research', authority: 1 },
  { id: 'kaiko', name: 'Kaiko Research', domain: 'kaiko.com', categories: ['research', 'market-data'], focus: 'Institutional crypto market research: liquidity, options volumes, volatility', authority: 1 },
  { id: 'delphi', name: 'Delphi Digital', domain: 'delphidigital.io', categories: ['research'], focus: 'Thematic crypto research incl. derivatives market structure', authority: 2 },
  { id: 'genesis-vol', name: 'Genesis Volatility', domain: 'genesisvolatility.com', categories: ['research', 'analytics'], focus: 'Daily crypto options market notes, IV analysis, trade structuring', authority: 2 },

  // ── news wires ───────────────────────────────────────────────────────────
  { id: 'coindesk', name: 'CoinDesk', domain: 'coindesk.com', categories: ['news', 'macro'], focus: 'Breaking crypto news, options/ETF flows coverage, macro events', authority: 1 },
  { id: 'cointelegraph', name: 'Cointelegraph', domain: 'cointelegraph.com', categories: ['news'], focus: 'Crypto markets coverage, liquidation events, derivatives news', authority: 2 },
  { id: 'theblock-news', name: 'The Block', domain: 'theblock.co', categories: ['news'], focus: 'Crypto news, exchange data stories, institutional flows', authority: 1 },
  { id: 'bitcoinmag', name: 'Bitcoin Magazine', domain: 'bitcoinmagazine.com', categories: ['news'], focus: 'Bitcoin macro coverage, options market commentary', authority: 3 },

  // ── education: position creation & analytics literacy ────────────────────
  { id: 'oic', name: 'Options Industry Council', domain: 'oic.ieee.org', categories: ['education'], focus: 'Canonical options education: strategy builders, Greeks tutorials, position management', authority: 1 },
  { id: 'tastytrade', name: 'tastytrade', domain: 'tastytrade.com', categories: ['education'], focus: 'Practical options mechanics: premium selling, defined-risk structures, management', authority: 2 },
  { id: 'projectfinance', name: 'projectfinance', domain: 'projectfinance.com', categories: ['education'], focus: 'Options strategy visualized guides: condors, butterflies, calendars, ratios', authority: 2 },
  { id: 'cmegroup-education', name: 'CME Education', domain: 'cmegroup.com/education', categories: ['education', 'traditional'], focus: 'Futures & options courses: hedging, spreads, margin mechanics', authority: 1 },
  { id: 'investopedia', name: 'Investopedia', domain: 'investopedia.com', categories: ['education'], focus: 'Reference definitions & strategy explainers for retail comprehension', authority: 3 },
  { id: 'optionstrat', name: 'OptionStrat', domain: 'optionstrat.com', categories: ['education', 'analytics'], focus: 'Strategy visualizer, expected-value analytics, trade ideas with probabilities', authority: 2 },

  // ── macro & index vol context ────────────────────────────────────────────
  { id: 'fed-watch', name: 'CME FedWatch', domain: 'cmegroup.com', categories: ['macro'], focus: 'Rate-hike/cut probabilities implied by Fed funds futures', authority: 1 },
  { id: 'macro-axis', name: 'MacroAxis', domain: 'macroaxis.in', categories: ['macro'], focus: 'Cross-asset vol, correlation and risk analytics', authority: 3 },
  { id: 'tradingview', name: 'TradingView', domain: 'tradingview.com', categories: ['market-data', 'education'], focus: 'Charts, community strategy scripts, vol indicator ideas', authority: 3 },

  // ── DeFi / on-chain options ──────────────────────────────────────────────
  { id: 'derive', name: 'Derive (ex-Lyra)', domain: 'derive.xyz', categories: ['defi', 'analytics'], focus: 'On-chain options AMM, IV oracles, perp options product docs', authority: 1 },
  { id: 'aevo', name: 'Aevo', domain: 'aevo.xyz', categories: ['defi', 'exchanges'], focus: 'On-chain options & perps: listings, IV, RGN points', authority: 1 },
  { id: 'dopex', name: 'Dopex', domain: 'dopex.io', categories: ['defi'], focus: 'On-chain options vaults, epoch structures', authority: 3 },
  { id: 'threshold', name: 'Threshold Network', domain: 'threshold.network', categories: ['defi'], focus: 'tBTC ecosystem DeFi options context', authority: 3 },
];

/** Keywords that pull a research query toward an industry focus category. */
const CATEGORY_KEYWORDS: Record<SourceCategory, string[]> = {
  exchanges: ['exchange', 'venue', 'deribit', 'bybit', 'okx', 'binance', 'listing', 'contract', 'settlement', 'platform'],
  'market-data': ['open interest', 'oi', 'volume', 'max pain', 'data', 'price', 'quote', 'term structure', 'surface'],
  analytics: ['greek', 'gamma', 'delta', 'theta', 'vega', 'skew', 'iv', 'implied volatility', 'dvol', 'flow', 'positioning', 'dealer', 'exposure', 'charm', 'vanna'],
  research: ['research', 'report', 'analysis', 'study', 'deep dive', 'regime', 'structure', 'outlook', 'monthly', 'weekly'],
  news: ['news', 'today', 'this week', 'latest', 'breaking', 'announce', 'event', 'cpi', 'fomc', 'fed'],
  education: ['how to', 'what is', 'explain', 'learn', 'tutorial', 'guide', 'beginner', 'build', 'construct', 'create', 'setup', 'management', 'defined risk', 'explained'],
  macro: ['macro', 'fed', 'fomc', 'cpi', 'rates', 'dxy', 'spx', 'vix', 'correlation', 'risk-off', 'risk-on', 'regime'],
  defi: ['defi', 'on-chain', 'onchain', 'protocol', 'amm', 'vault', 'lyra', 'derive', 'aevo', 'dopex', 'perpetual option'],
  traditional: ['spx', 's&p', 'index options', 'equity options', 'spy', 'qqq', '0dte', 'weekly options', 'cash-settled'],
};

/**
 * Rank the catalog for a query — Alexandria-style routing.
 * Scores: +3 per keyword hit in the source's categories, +authority bonus
 * (1 → +3, 2 → +2, 3 → +1), +2 if the domain is literally mentioned in
 * the query. Returns sources sorted best-first.
 */
export function routeAlexandriaSources(query: string, focus?: string, limit = 8): AlexandriaSource[] {
  const q = query.toLowerCase();
  const focusCat = focus ? (focus.toLowerCase().replace('_', '-') as SourceCategory | 'market-data' | undefined) : undefined;
  const scored = ALEXANDRIA_SOURCES.map((src) => {
    let score = 4 - src.authority; // authority 1 → 3 pts, 2 → 2, 3 → 1
    if (q.includes(src.domain.split('.')[0])) score += 2;
    if (q.includes(src.name.toLowerCase())) score += 2;
    for (const cat of src.categories) {
      for (const kw of CATEGORY_KEYWORDS[cat] ?? []) {
        if (q.includes(kw)) {
          score += 3;
          break; // one keyword hit per category is enough signal
        }
      }
    }
    if (focusCat && src.categories.includes(focusCat)) score += 4;
    return { src, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.src);
}

/** Compact catalog listing for the transparency tool and prompts. */
export function alexandriaCatalogBrief(): Array<{ id: string; name: string; domain: string; categories: string[]; focus: string }> {
  return ALEXANDRIA_SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    domain: s.domain,
    categories: s.categories,
    focus: s.focus,
  }));
}
