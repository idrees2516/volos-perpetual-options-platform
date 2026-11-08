// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · registry — OUR OWN endpoint catalog (replaces BackQuant's 70-
// endpoint registry): every native route the product exposes, with the view
// parameters it accepts. Rendered by the Quant Lab "API Catalog" tab and the
// vq_catalog copilot tool.
// ─────────────────────────────────────────────────────────────────────────────

export interface EndpointSpec {
  method: 'GET' | 'POST';
  path: string;
  group: string;
  summary: string;
  params: { name: string; desc: string; example?: string }[];
  views?: string[];
}

export const ENDPOINTS: EndpointSpec[] = [
  // ── decision support ───────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/signals', group: 'Decision Support', summary: 'THE decision brief: live signal battery (gamma regime, IV rank, VRP, skew, term, funding, OI, CVD, tape, PCR, liquidation magnets), composite regime score, strategy playbook with concrete strikes, and a watchlist of the levels that matter', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL', example: 'BTC' }] },
  { method: 'GET', path: '/api/quant/screener', group: 'Decision Support', summary: 'Whole-market scanner: every symbol side-by-side (momentum, crowding, vol pricing, gamma regime, flow, liq magnets) with cross-symbol z-scores, leaderboards and regime scores', params: [] },
  { method: 'GET', path: '/api/quant/risk', group: 'Decision Support', summary: 'Portfolio risk on the LIVE paper account: per-position greeks, portfolio totals, full spot×vol scenario P&L (Black-76 repriced), break-evens, working-order fill odds, concentration', params: [] },
  { method: 'POST', path: '/api/quant/risk', group: 'Decision Support', summary: 'What-if structure analysis: hypothetical legs → instant greeks, premium, payoff curve and break-evens from the live chain', params: [{ name: 'body', desc: '{ legs: [{symbol, expiry, strike, kind, side, qty}] }' }] },
  { method: 'GET', path: '/api/quant/vol', group: 'Decision Support', summary: 'Vol-cycle brief: IV percentile/rank from our own snapshot history, realized-vol cone (3/7/14/30/60/90d windows vs own distribution), DVOL index + series, IV-vs-DVOL-vs-RV triangle', params: [{ name: 'symbol', desc: 'BTC | ETH', example: 'BTC' }] },
  // ── positioning & levels ────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/brief', group: 'Positioning', summary: 'One-call market brief: spot vs dealer-gamma levels, IV/VRP, expected move, perps, 12h tape, front expiry', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL', example: 'BTC' }] },
  { method: 'GET', path: '/api/quant/gex', group: 'Positioning', summary: 'GEX suite: dealer levels (HVL/call wall/put support/max pain), strike profile, per-expiry GEX, strike×expiry heatmap, strike ladder, multi-symbol comparison', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'view', desc: 'levels | strike | expiry | heatmap | ladder | multi' }], views: ['levels', 'strike', 'expiry', 'heatmap', 'ladder', 'multi'] },
  { method: 'GET', path: '/api/quant/greeks', group: 'Positioning', summary: 'Dealer greek exposure by strike (gamma/delta/vega/theta/vanna/charm), greek surface, TRACE forward projection (time × price) and summary', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'greek', desc: 'gamma | delta | vega | theta | vanna | charm' }, { name: 'view', desc: 'profile | surface | trace | summary' }], views: ['profile', 'surface', 'trace', 'summary'] },
  { method: 'GET', path: '/api/quant/history', group: 'Positioning', summary: 'Persisted metric history: total GEX, OI notional, or stress (long-window HVL/wall ranges) from our own snapshot store', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'metric', desc: 'gex | oi | stress' }, { name: 'days', desc: '1–30, default 7' }] },
  // ── chain & opex ───────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/chain', group: 'Chain & OPEX', summary: 'Live Deribit option chain (per-contract greeks/IV/OI), per-expiry summary, cross-venue book snapshot, OPEX calendar', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'view', desc: 'chain | summary | opex | book' }, { name: 'expiry', desc: 'expiry token, e.g. 2026-11-27' }, { name: 'dteMax', desc: 'chain filter: max days-to-expiry' }], views: ['chain', 'summary', 'opex', 'book'] },
  // ── volatility ─────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/iv', group: 'Volatility', summary: 'IV analytics: ATM by tenor, term structure, 25Δ/10Δ skew + butterflies, per-expiry smiles, constant-maturity, IV-vs-RV (VRP), expected move, calibrated range', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'view', desc: 'atm | term | skew | smile | cm | vrp | em | surface' }], views: ['atm', 'term', 'skew', 'smile', 'cm', 'vrp', 'em', 'surface'] },
  { method: 'GET', path: '/api/quant/probability', group: 'Volatility', summary: 'Risk-neutral PDF/CDF per expiry (Breeden–Litzenberger): odds of finishing above/below a price, mode, quartiles, probability surface across expiries', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'price', desc: 'price level for P(above/below)' }, { name: 'expiry', desc: 'expiry token, or front' }] },
  // ── flow & tape ────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/tape', group: 'Flow & Tape', summary: 'Live options tape: recent prints, window aggregates (premium, buy/sell imbalance, put/call), whale prints, premium by strike/expiry, flow by strike', params: [{ name: 'symbol', desc: 'BTC | ETH' }, { name: 'hours', desc: '1–48, default 24' }, { name: 'minPremiumUsd', desc: 'filter, default 0' }, { name: 'view', desc: 'prints | aggregates | flow (default aggregates)' }], views: ['prints', 'aggregates', 'flow'] },
  { method: 'GET', path: '/api/quant/tape/stream', group: 'Flow & Tape', summary: 'LIVE SSE stream of option prints the moment they land (server-side 5s venue poll → push)', params: [{ name: 'symbol', desc: 'BTC | ETH' }] },
  { method: 'GET', path: '/api/quant/oi', group: 'Flow & Tape', summary: 'Open interest: by expiry (call/put), PCR, OI history, premium tide (rolling net taker premium), futures term structure/basis', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL' }, { name: 'view', desc: 'by-expiry | pcr | history | premium | term' }], views: ['by-expiry', 'pcr', 'history', 'premium', 'term'] },
  // ── perps & market ─────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/perps', group: 'Perps & Market', summary: 'Perp picture: cross-venue OI distribution (Binance/Bybit/OKX/Deribit), funding current + history, CVD, candles, futures basis curve, RV30', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL' }] },
  { method: 'GET', path: '/api/quant/liquidations', group: 'Perps & Market', summary: 'Model-estimated liquidation heatmap (OI buildup × leverage tiers): price-grid intensities, top long/short clusters', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL' }, { name: 'lev', desc: 'comma list of 10,25,50,100' }] },
  { method: 'GET', path: '/api/quant/market', group: 'Perps & Market', summary: 'Market bundle: spot/perp marks, funding, OI, 24h stats, recent candles', params: [{ name: 'symbol', desc: 'BTC | ETH | SOL' }] },
  // ── macro ──────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/macro', group: 'ETF, COT & Filings', summary: 'Real TradFi data: US spot-ETF daily flows (Farside), CFTC COT positioning, SEC Form 4 insider trades, 13F institutional holders', params: [{ name: 'view', desc: 'etf | cot | cot-markets | form4 | holders13f' }, { name: 'asset', desc: 'etf: BTC | ETH' }, { name: 'market', desc: 'cot: BITCOIN | ETHER | MICRO BITCOIN' }, { name: 'ticker', desc: 'form4: COIN | HOOD | MSTR; holders13f: MSTR | COIN | HOOD | IBIT' }], views: ['etf', 'cot', 'cot-markets', 'form4', 'holders13f'] },
  // ── discovery & meta ───────────────────────────────────────────────────────
  { method: 'GET', path: '/api/quant/catalog', group: 'Discovery & Meta', summary: 'Symbol catalog with live coverage flags, active expiries, service status (per-source health + cache ages), and this endpoint registry', params: [{ name: 'view', desc: 'symbols | expiries | status | registry' }], views: ['symbols', 'expiries', 'status', 'registry'] },
];

export const ENDPOINT_COUNT = ENDPOINTS.length;
