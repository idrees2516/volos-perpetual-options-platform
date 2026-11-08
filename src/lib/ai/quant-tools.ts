// ---------------------------------------------------------------------------
// ai/quant-tools — the Copilot's VOLQUANT toolbelt (native, realtime).
//
// Replaces the former BackQuant MCP toolbelt: every tool is served by OUR OWN
// engine (src/lib/quant) computing live from Deribit/Binance/Bybit/OKX/CFTC/
// SEC/Farside — no external quant API, no demo mode, no static data. The tool
// names mirror the conversational surface the Research Director already
// knows (brief → levels → tape → vol → structure → macro → discovery).
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import { brief, multiSymbolLevels, normalizeSymbol, serviceStatus, symbolCatalog, OPTIONS_SYMBOLS } from '@/lib/quant/quant';
import { getChainSnapshot } from '@/lib/quant/engine';
import { flowByStrike, tapeAggregates, tapePrints } from '@/lib/quant/tape';
import { getPerpBundle, liquidationHeatmap } from '@/lib/quant/perps';
import { dealerFlow, history } from '@/lib/quant/history';
import { cot, etfFlows, form4, holders13f } from '@/lib/quant/macro';
import { ENDPOINTS, ENDPOINT_COUNT } from '@/lib/quant/registry';

const SYMBOL_DESC = 'Underlying symbol: BTC, ETH or SOL (options analytics: BTC/ETH)';

type ToolParamMap = Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; enum?: string[] }>;

function vqTool(name: string, params: ToolParamMap, required: string[], description: string, run: (args: Record<string, unknown>) => Promise<unknown>) {
  return tool({
    description,
    parameters: jsonSchema<Record<string, unknown>>({
      type: 'object',
      properties: params,
      required,
    }),
    execute: async (args: Record<string, unknown>) => {
      try {
        const r = await run(args);
        return { ...(r as object), tool: name, transport: 'volquant-native', mode: 'live' };
      } catch (e) {
        return { tool: name, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

export const quantTools = {
  // ── start here ─────────────────────────────────────────────────────────────
  vq_brief: vqTool(
    'vq_brief',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'ONE-CALL MARKET BRIEF from the native VolQuant engine: spot vs dealer-gamma levels (HVL, call wall, put support, 0DTE), CM30 IV vs realized vol (VRP), 1σ expected move, perp OI/funding/CVD, 12h options-tape premium and the front expiry summary. BEST FIRST MOVE for any open market question. 100% live venue data (Deribit/Binance/Bybit/OKX).',
    async (a) => brief(normalizeSymbol(String(a.symbol ?? 'BTC'))),
  ),

  // ── positioning & levels ───────────────────────────────────────────────────
  vq_gex_levels: vqTool(
    'vq_gex_levels',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      expiry: { type: 'string', description: 'all | 0dte | expiry token like 2026-11-28' },
    },
    [],
    'GEX KEY LEVELS (native): gamma flip (HVL), call wall/resistance, put support, max pain — all-expiry and 0DTE — plus total/call/put gamma exposure in USD per 1% move and the top strikes. Use for "where are the gamma walls", pinning zones, dealer regime.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      return {
        symbol,
        spot: snap.spot,
        asOf: snap.asOf,
        levels: snap.levels,
        levels0dte: snap.levels0dte,
        unit: 'USD per 1% spot move',
        model: 'dealer short calls / long puts convention on the live Deribit chain',
      };
    },
  ),
  vq_gex_strike_profile: vqTool(
    'vq_gex_strike_profile',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      expiry: { type: 'string', description: 'all | 0dte | expiry token' },
      limit: { type: 'number', description: 'Top strikes to return, default 15' },
    },
    [],
    'GEX BY STRIKE (native): net/call/put gamma exposure and OI per strike, ranked by |GEX|. Use for strike-by-strike dealer positioning.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const expiry = String(a.expiry ?? 'all');
      const rows = expiry === '0dte' ? snap.rows.filter((r) => r.expiry === snap.expiries[0]?.expiry) : expiry !== 'all' ? snap.rows.filter((r) => r.expiry === expiry) : snap.rows;
      const strikes = expiry === 'all' ? snap.strikes : null;
      if (strikes) {
        return { symbol, spot: snap.spot, top: [...strikes].sort((x, y) => Math.abs(y.netGex) - Math.abs(x.netGex)).slice(0, Number(a.limit ?? 15)) };
      }
      const m = new Map<number, { strike: number; callGex: number; putGex: number; netGex: number; callOi: number; putOi: number }>();
      for (const r of rows) {
        const e = m.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0, netGex: 0, callOi: 0, putOi: 0 };
        if (r.isCall) { e.callGex += r.gexUsd1pct; e.callOi += r.oi; } else { e.putGex += r.gexUsd1pct; e.putOi += r.oi; }
        e.netGex = e.callGex - e.putGex;
        m.set(r.strike, e);
      }
      return { symbol, spot: snap.spot, top: [...m.values()].sort((x, y) => Math.abs(y.netGex) - Math.abs(x.netGex)).slice(0, Number(a.limit ?? 15)) };
    },
  ),
  vq_greek: vqTool(
    'vq_greek',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      greek: { type: 'string', enum: ['gamma', 'vanna', 'charm', 'vega', 'theta', 'delta'], description: 'Which dealer greek exposure to profile' },
    },
    [],
    'GREEK EXPOSURE PROFILE (native): dealer net exposure by strike for any greek — gamma, vanna, charm, vega, theta, delta. Use for vanna/charm regimes, "where is dealer vega", hedging pressure beyond gamma.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const greek = String(a.greek ?? 'gamma');
      const m = new Map<number, { strike: number; call: number; put: number; net: number }>();
      for (const r of snap.rows) {
        const raw =
          greek === 'gamma' ? r.gamma * r.oi * r.forward * r.forward * 0.01
          : greek === 'delta' ? r.delta * r.oi * r.forward
          : greek === 'vega' ? r.vega * r.oi
          : greek === 'theta' ? r.thetaUsd * r.oi
          : greek === 'vanna' ? r.vanna * r.oi * r.forward * 0.01
          : r.charm * r.oi * r.forward;
        const e = m.get(r.strike) ?? { strike: r.strike, call: 0, put: 0, net: 0 };
        if (r.isCall) e.call += raw; else e.put += raw;
        e.net = e.call - e.put;
        m.set(r.strike, e);
      }
      const prof = [...m.values()].sort((x, y) => Math.abs(y.net) - Math.abs(x.net)).slice(0, 15);
      return { symbol, greek, spot: snap.spot, profile: prof, totalNet: [...m.values()].reduce((s, p) => s + p.net, 0) };
    },
  ),
  vq_max_pain: vqTool(
    'vq_max_pain',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      expiry: { type: 'string', description: 'front | all | expiry token' },
    },
    [],
    'MAX PAIN (native): the strike where the most option value expires worthless — per expiry plus all-expiry. Use for expiry pinning and OPEX-day magnets.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const expiry = String(a.expiry ?? 'front');
      const list = expiry === 'all' ? snap.expiries : snap.expiries.filter((e) => e.expiry === (expiry === 'front' ? snap.expiries[0]?.expiry : expiry));
      return {
        symbol,
        spot: snap.spot,
        allExpiryMaxPain: snap.levels.maxPain,
        byExpiry: list.map((e) => ({ expiry: e.expiry, dte: e.dte, maxPain: e.maxPain, oiUsd: e.oiUsd })),
      };
    },
  ),
  vq_compare_symbols: vqTool(
    'vq_compare_symbols',
    {},
    [],
    'MULTI-SYMBOL GEX: HVL / call wall / put support / max pain / CM30 IV / PCR for BTC and ETH side by side (the symbols with live options chains).',
    async () => multiSymbolLevels(),
  ),

  // ── flow & tape ────────────────────────────────────────────────────────────
  vq_tape: vqTool(
    'vq_tape',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      hours: { type: 'number', description: 'Lookback 1–48 hours, default 24' },
      min_premium_usd: { type: 'number', description: 'Only prints above this premium (USD)' },
      limit: { type: 'number', description: 'Prints to return, default 20' },
      whale_usd: { type: 'number', description: 'Whale threshold, default 100000' },
    },
    [],
    'OPTIONS TAPE (native, live): individual Deribit option prints (instrument, strike, taker side, premium USD, IV) plus window aggregates — premium totals, buy/sell imbalance, put/call split, whales. Use for "what traded", biggest print, aggressive call buying.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      if (!OPTIONS_SYMBOLS.includes(symbol)) throw new Error(`no options tape for ${symbol}`);
      const hours = Math.min(48, Math.max(1, Number(a.hours ?? 24)));
      const agg = await tapeAggregates(symbol, hours, Number(a.whale_usd ?? 100_000) || 100_000);
      const prints = tapePrints(symbol, { hours, minPremiumUsd: Number(a.min_premium_usd ?? 0) || 0, limit: Number(a.limit ?? 20) || 20 });
      return { symbol, ...agg, recentPrints: prints };
    },
  ),
  vq_flow_by_strike: vqTool(
    'vq_flow_by_strike',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      strike: { type: 'number', description: 'Ask about ONE strike, e.g. 80000' },
    },
    [],
    'FLOW BY STRIKE (native): cumulative aggressor premium by strike on still-open contracts — call-buy/call-sell/put-buy/put-sell split. Pass strike to ask "is anyone buying calls at 80k".',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const strike = a.strike ? Number(a.strike) : undefined;
      const flow = flowByStrike(symbol, 168, strike);
      return { symbol, windowHours: 168, byStrike: flow.slice(0, 25) };
    },
  ),
  vq_dealer_flow: vqTool(
    'vq_dealer_flow',
    { symbol: { type: 'string', description: SYMBOL_DESC }, days: { type: 'number', description: '1–30, default 3' } },
    [],
    'DEALER HEDGE FLOW (estimated): time series of estimated dealer hedging flow (−GEX × Δspot%) from persisted snapshots. Use for "are dealers buying dips or selling rallies".',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      return dealerFlow(symbol, Math.min(30, Number(a.days ?? 3)));
    },
  ),

  // ── volatility & pricing ───────────────────────────────────────────────────
  vq_iv: vqTool(
    'vq_iv',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['atm', 'skew', 'term', 'cm', 'surface'], description: 'atm = front tenor; skew = 25Δ/10Δ RR+butterfly; term = ATM by tenor; cm = constant maturity; surface = strike×expiry grid' },
    },
    [],
    'IV SUITE (native): implied vol in whichever cut — ATM by tenor, 25Δ/10Δ skew + butterflies, term structure, constant-maturity tenors, or the OTM-composite surface. All from live Deribit marks.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const view = String(a.view ?? 'term');
      if (view === 'atm') {
        const f = snap.expiries[0];
        return { symbol, front: f ? { expiry: f.expiry, dte: f.dte, atmIvPct: f.atmIvPct, rr25: f.rr25, fly25: f.fly25 } : null, cm30Pct: snap.iv30vsRv30.iv30Pct };
      }
      if (view === 'skew') return { symbol, byExpiry: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, atmIvPct: e.atmIvPct, rr25: e.rr25, fly25: e.fly25, rr10: e.rr10 })) };
      if (view === 'cm') return { symbol, cm30Pct: snap.iv30vsRv30.iv30Pct, vrp: snap.iv30vsRv30 };
      if (view === 'surface') return { symbol, strikes: snap.heatmap.strikes, expiries: snap.heatmap.expiries, ivPct: snap.heatmap.iv };
      return { symbol, termStructure: snap.termStructure, cm30Pct: snap.iv30vsRv30.iv30Pct };
    },
  ),
  vq_expected_move: vqTool(
    'vq_expected_move',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'EXPECTED MOVE (native): ATM-straddle premium and 1σ/2σ lognormal move bands per expiry (±range), plus a VRP-calibrated 1σ. Use for "how much can BTC move today / this opex".',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      return { symbol, spot: snap.spot, byExpiry: snap.expectedMoves };
    },
  ),
  vq_probability: vqTool(
    'vq_probability',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      price: { type: 'number', description: 'A price level, e.g. 80000 — odds of finishing above/below it' },
      expiry: { type: 'string', description: 'front | expiry token' },
    },
    [],
    'PROBABILITY (native): risk-neutral PDF/CDF per expiry (Breeden–Litzenberger on live marks) — odds of finishing above/below a price, distribution mode, quartiles. Use for "odds of 80k by Friday".',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const price = a.price ? Number(a.price) : null;
      const expiry = String(a.expiry ?? 'front');
      const slice = (expiry === 'front' ? snap.probability[0] : snap.probability.find((s) => s.expiry === expiry)) ?? snap.probability[0];
      if (!slice) throw new Error('no probability slice');
      const interpCdf = (x: number) => {
        const c = slice.cdf;
        const k = slice.strikes;
        if (x <= k[0]) return 0;
        if (x >= k[k.length - 1]) return 1;
        let lo = 0, hi = k.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid] > x) hi = mid; else lo = mid; }
        const t = (x - k[lo]) / (k[hi] - k[lo] || 1);
        return c[lo] + t * (c[hi] - c[lo]);
      };
      return {
        symbol,
        spot: snap.spot,
        expiry: slice.expiry,
        dte: slice.dte,
        mode: slice.mode,
        quartiles: [slice.p1, slice.p3],
        expected: slice.expected,
        ...(price ? { levelPrice: price, pAbove: 1 - interpCdf(price), pBelow: interpCdf(price) } : {}),
        method: 'Breeden–Litzenberger on the live OTM composite curve',
      };
    },
  ),
  vq_basis: vqTool(
    'vq_basis',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'BASIS (native): dated-futures annualized basis curve by maturity + perp basis, from live Deribit marks. Use for carry and curve-shape questions.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const perp = await getPerpBundle(symbol);
      return { symbol, spot: perp.spot, perpBasisPct: perp.perpBasisPct, futures: perp.futuresTerm };
    },
  ),

  // ── structure & history ────────────────────────────────────────────────────
  vq_oi: vqTool(
    'vq_oi',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['by_expiry', 'history'], description: 'by_expiry (default) or history time-series' },
    },
    [],
    'OPEN INTEREST (native): call/put OI per expiry with PCR, or OI history from our persisted snapshots. Also totals + futures OI.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      if (String(a.view ?? 'by_expiry') === 'history') return history(symbol, 'oi', 7);
      const snap = await getChainSnapshot(symbol);
      return {
        symbol,
        totalOiUsd: snap.totalOiUsd,
        putCallRatioOi: snap.putCallRatioOi,
        byExpiry: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, callOi: e.callOi, putOi: e.putOi, oiUsd: e.oiUsd, pcr: e.putCallRatioOi })),
      };
    },
  ),
  vq_expiry_summary: vqTool(
    'vq_expiry_summary',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'EXPIRY SUMMARY (native): every active expiry with DTE, type (daily/weekly/monthly/quarterly), ATM IV, skew, PCR, OI, net GEX, max pain and straddle. Use for chain-wide screening and picking expiries.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      return { symbol, spot: snap.spot, expiries: snap.expiries };
    },
  ),
  vq_opex: vqTool(
    'vq_opex',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      horizon_days: { type: 'number', description: 'Days ahead, default 45' },
    },
    [],
    'OPEX CALENDAR (native): upcoming expirations with OI/notional rolling off, ATM IV, max pain and expected move per event. Use for OPEX workflow planning and roll timing.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      const horizon = Number(a.horizon_days ?? 45);
      return {
        symbol,
        spot: snap.spot,
        events: snap.expiries
          .filter((e) => e.dte <= horizon)
          .map((e) => ({ expiry: e.expiry, dte: e.dte, type: e.type, isAnchor: e.isAnchor, oiUsd: e.oiUsd, atmIvPct: e.atmIvPct, maxPain: e.maxPain, expectedMove1sUsd: snap.expectedMoves.find((m) => m.expiry === e.expiry)?.oneSigmaUsd ?? e.expectedMove1sUsd })),
      };
    },
  ),
  vq_history: vqTool(
    'vq_history',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      metric: { type: 'string', enum: ['gex', 'oi', 'stress'], description: 'gex = total GEX history; oi = OI history; stress = long-window HVL/wall ranges' },
      days: { type: 'number', description: 'Observations window 1–30, default 7' },
    },
    [],
    'HISTORY (native): how a positioning metric (total GEX, OI, or HVL/wall stress ranges) evolved — from OUR OWN snapshot store, computed live since the engine started.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      return history(symbol, (['gex', 'oi', 'stress'].includes(String(a.metric)) ? a.metric : 'gex') as 'gex' | 'oi' | 'stress', Math.min(30, Number(a.days ?? 7)));
    },
  ),
  vq_liquidation: vqTool(
    'vq_liquidation',
    {
      symbol: { type: 'string', description: SYMBOL_DESC },
      view: { type: 'string', enum: ['heatmap', 'distribution'], description: 'heatmap (price grid) or distribution (per level, with leverage tiers)' },
    },
    [],
    'LIQUIDATIONS (model-estimated): where leveraged perp positions would get liquidated — intensity heatmap or per-level long/short notionals with leverage tiers (10x/25x/50x/100x). CoinGlass-style estimate from live OI build-up vs price.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const perp = await getPerpBundle(symbol);
      const hm = liquidationHeatmap(symbol, perp);
      if (String(a.view ?? 'heatmap') === 'distribution') {
        return {
          symbol,
          spot: hm.spot,
          clusters: hm.clusters.slice(0, 15),
          byLeverage: [10, 25, 50, 100].map((l) => {
            const c = perp.liquidationClusters.filter((x) => x.leverage === l);
            return { leverage: l, count: c.length, longUsd: c.filter((x) => x.side === 'long').reduce((s, x) => s + x.notionalUsd, 0), shortUsd: c.filter((x) => x.side === 'short').reduce((s, x) => s + x.notionalUsd, 0) };
          }),
        };
      }
      return { symbol, spot: hm.spot, priceGrid: hm.priceGrid, longIntensity: hm.longIntensity, shortIntensity: hm.shortIntensity, topLong: hm.topLong, topShort: hm.topShort, model: hm.model };
    },
  ),
  vq_perps: vqTool(
    'vq_perps',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'PERPS (native): the perpetual-futures picture — cross-venue OI (Binance/Bybit/OKX/Deribit), funding + history, CVD from taker flow, futures basis curve, RV30, top estimated liquidation clusters. One aligned perp view.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const perp = await getPerpBundle(symbol);
      return {
        symbol,
        spot: perp.spot,
        perpBasisPct: perp.perpBasisPct,
        fundingRate: perp.fundingRate,
        fundingApr: perp.fundingApr,
        nextFundingTs: perp.nextFundingTs,
        fundingHist: perp.fundingHist.slice(-14),
        oi: perp.oi,
        oiUsdTotal: perp.oiUsdTotal,
        cvd24hUsd: perp.cvd.at(-1)?.cvdUsd ?? null,
        rv30Pct: perp.rv30Pct,
        futuresTerm: perp.futuresTerm,
        liquidationTop: perp.liquidationClusters.slice(0, 8),
      };
    },
  ),

  // ── spot ETFs / filings ────────────────────────────────────────────────────
  vq_etf_flows: vqTool(
    'vq_etf_flows',
    { asset: { type: 'string', enum: ['BTC', 'ETH'], description: 'Which spot-ETF complex' } },
    [],
    'ETF FLOWS (real, Farside): daily net creations/redemptions for the US spot crypto ETFs, per fund and in total, plus the recent cumulative window. Settlement lags a business day. Use for structural demand, "is IBIT seeing inflows".',
    async (a) => etfFlows(a.asset === 'ETH' ? 'ETH' : 'BTC'),
  ),
  vq_filings: vqTool(
    'vq_filings',
    {
      kind: { type: 'string', enum: ['cot', 'insider', 'holders'], description: 'cot = CFTC positioning; insider = SEC Form 4 at COIN/HOOD/MSTR; holders = 13F top holders of MSTR/COIN/HOOD/IBIT' },
      ticker: { type: 'string', description: 'For insider: COIN | HOOD | MSTR. For holders: MSTR | COIN | HOOD | IBIT.' },
    },
    [],
    'FILINGS (real, CFTC/SEC): CFTC Commitments-of-Traders positioning with history, SEC Form 4 insider trades, and 13F institutional holders from live EDGAR infotables. Use for smart-money positioning.',
    async (a) => {
      const kind = String(a.kind ?? 'cot');
      if (kind === 'insider') return form4((['COIN', 'HOOD', 'MSTR'].includes(String(a.ticker)) ? a.ticker : 'COIN') as 'COIN' | 'HOOD' | 'MSTR');
      if (kind === 'holders') return holders13f(['MSTR', 'COIN', 'HOOD', 'IBIT'].includes(String(a.ticker)) ? String(a.ticker) : 'MSTR');
      return cot('BITCOIN');
    },
  ),

  // ── discovery ──────────────────────────────────────────────────────────────
  vq_list_symbols: vqTool(
    'vq_list_symbols',
    {},
    [],
    'SYMBOL CATALOG: which markets the native engine covers live (BTC/ETH options + BTC/ETH/SOL perps) and which analytics categories are on. Use when unsure what the desk can pull.',
    async () => symbolCatalog(),
  ),
  vq_list_expiries: vqTool(
    'vq_list_expiries',
    { symbol: { type: 'string', description: SYMBOL_DESC } },
    [],
    'ACTIVE EXPIRIES: the valid expiry tokens (with DTE and type) passable to expiry-taking tools.',
    async (a) => {
      const symbol = normalizeSymbol(String(a.symbol ?? 'BTC'));
      const snap = await getChainSnapshot(symbol);
      return { symbol, expiries: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, type: e.type })) };
    },
  ),
  vq_catalog: tool({
    description:
      'VolQuant data catalog transparency: what the desk can pull — all native tools grouped (positioning, flow/tape, volatility, structure, ETFs, filings, discovery), the /api/quant endpoint registry, and per-source health. Use for "what quant data do you have", "which tools can you use", data-freshness questions.',
    parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => ({
      engine: 'volquant-native v1',
      transport: 'all tools compute live in-process — no external quant API, no MCP dependency',
      restEndpoints: ENDPOINT_COUNT,
      tools: ENDPOINTS.map((e) => ({ group: e.group, path: e.path, summary: e.summary })),
      health: await serviceStatus().catch(() => null),
    }),
  }),
};

/** System-prompt section teaching the Copilot the native quant layer. */
export function quantSystemPrompt(): string {
  const lines: string[] = [];
  lines.push('## VolQuant market intelligence (native realtime engine)');
  lines.push(
    'You have VOLQUANT tools — institutional crypto-options analytics computed LIVE by VolOS\'s own engine from Deribit (options chain, tape, futures), Binance/Bybit/OKX (perps) and CFTC/SEC/Farside (macro). No external data vendor, no demo mode: every number is real and timestamped. They answer: where dealer gamma is (walls, HVL, max pain, pin zones), what aggressors traded (options tape, whales, flow by strike), the vol surface (skew, smiles, term structure, VRP, expected move, risk-neutral odds), perp positioning (OI, funding, CVD, liquidation estimates), spot-ETF flows, COT and SEC filings.',
  );
  lines.push('- Start open market questions with vq_brief (one call: price vs gamma levels + IV/VRP + expected move + perps + tape + front expiry).');
  lines.push('- Positioning: vq_gex_levels / vq_gex_strike_profile / vq_greek / vq_max_pain / vq_compare_symbols.');
  lines.push('- Flow: vq_tape (prints + aggregates), vq_flow_by_strike ("is anyone buying calls at 80k"), vq_dealer_flow.');
  lines.push('- Vol: vq_iv (any cut), vq_expected_move, vq_probability (odds of a level), vq_basis.');
  lines.push('- Structure: vq_oi, vq_expiry_summary, vq_opex, vq_history, vq_liquidation, vq_perps.');
  lines.push('- Macro/flows: vq_etf_flows, vq_filings (COT / Form 4 / 13F). Discovery: vq_list_symbols, vq_list_expiries, vq_catalog.');
  lines.push('- Options analytics cover BTC and ETH (Deribit is the only free keyless options venue); SOL covers perps/market tools — say so if asked.');
  lines.push('- The Quant Lab workspace renders the same engine (/api/quant/*) — cite its numbers consistently.');
  lines.push('- Liquidation clusters and dealer hedge-flow are MODEL ESTIMATES (labeled in results) — always qualify them as estimates.');
  lines.push('- Render quant answers as cards: StatGrid for levels/expected move, DataTable for strikes/whales/expiries, LineChart for series (term structure, CVD, flows), BarChart for venue splits / flow by strike, and HeatMatrix for strike×expiry GEX / IV surface / TRACE maps.');
  return lines.join('\n');
}
