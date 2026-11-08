// ---------------------------------------------------------------------------
// backquant/mcp — the BackQuant MCP integration layer.
//
// BackQuant ships a remote MCP server (https://mcp.backquant.com/mcp,
// Streamable HTTP, JSON-RPC 2.0, OAuth or API-key bearer auth) exposing 23
// tools. VolOS integrates MCP in BOTH directions:
//
//   1. CLIENT  — mcpToolsList() / mcpToolsCall() talk to the real server when
//      BACKQUANT_API_KEY is set, so the Copilot can answer through the same
//      conversational data path Claude/Cursor use.
//   2. SERVER  — runBackQuantTool() mirrors all 23 tools on VolOS's own data
//      plane (live REST or demo engine) with the same result contract
//      (summary / units / as_of / data_age_seconds / venues), and
//      /api/backquant/mcp exposes them as a local Streamable-HTTP MCP server.
//
// The tool layer is transport-agnostic: call it through MCP, through the
// Copilot toolbelt, or directly — identical answers.
// ---------------------------------------------------------------------------

import type { BqMode, BqToolResult } from './types';
import { BQ_MCP_URL, bqApiKey, bqGet, bqMode } from './client';
import { normalizeSymbol } from './demo';

// ── the 23-tool catalog (mirrors mcp.backquant.com) ─────────────────────────

export const BQ_MCP_TOOLS: Array<{ name: string; group: string; answers: string; args: string }> = [
  { name: 'get_brief', group: 'start here', answers: 'Everything at once for one market: price vs dealer-gamma levels, perp positioning, what the tape has been doing', args: 'symbol' },
  { name: 'get_gex_levels', group: 'positioning', answers: 'Gamma flip (HVL), call wall, put support for a market', args: 'symbol, positioning?' },
  { name: 'get_gex_strike_profile', group: 'positioning', answers: 'Dealer gamma broken down by strike', args: 'symbol, expiry?' },
  { name: 'get_greek', group: 'positioning', answers: 'Dealer exposure for a single greek, in several cuts', args: 'symbol, greek (gamma|vanna|charm|vega), view?' },
  { name: 'get_max_pain', group: 'positioning', answers: 'The strike where the most option value expires worthless', args: 'symbol, expiry?' },
  { name: 'compare_symbols', group: 'positioning', answers: 'Gamma levels for several assets side by side', args: 'symbols (comma list, up to 8)' },
  { name: 'get_tape', group: 'flow & tape', answers: 'Individual prints and aggregates over them (hours sets lookback 1–168)', args: 'symbol, hours?, min_premium_usd?, limit?' },
  { name: 'get_flow_by_strike', group: 'flow & tape', answers: 'Where aggressors actually bought and sold, strike by strike', args: 'symbol, strike?, expiry?' },
  { name: 'get_dealer_flow', group: 'flow & tape', answers: 'Dealer hedging pressure over time, measured from the tape', args: 'symbol, positioning?' },
  { name: 'get_iv', group: 'volatility', answers: 'Implied volatility in whichever cut you need', args: 'symbol, view? (atm|surface|skew|term|cm)' },
  { name: 'get_expected_move', group: 'volatility', answers: 'The move the market is pricing for an expiry; view=calibrated gives realistic 68/90% bands', args: 'symbol, view?' },
  { name: 'get_probability', group: 'volatility', answers: 'Market-implied odds of finishing above or below a price', args: 'symbol, price?, expiry?' },
  { name: 'get_basis', group: 'volatility', answers: 'The dated-futures curve, annualised basis by expiry', args: 'symbol' },
  { name: 'get_oi', group: 'structure', answers: 'Open interest by expiry or over time', args: 'symbol, view? (by_expiry|history)' },
  { name: 'get_expiry_summary', group: 'structure', answers: 'Every listed expiry with DTE, ATM IV and open interest', args: 'symbol' },
  { name: 'get_opex', group: 'structure', answers: 'Upcoming expiries and how much OI rolls off at each', args: 'symbol, horizon_days?' },
  { name: 'get_history', group: 'structure', answers: 'How a positioning metric has changed over time', args: 'symbol, metric (gex|oi|stress), days?' },
  { name: 'get_liquidation', group: 'structure', answers: 'Where leveraged perp positions get liquidated', args: 'symbol, view? (heatmap|distribution)' },
  { name: 'get_perps', group: 'structure', answers: 'Perp picture: OI, funding, spot & perp CVD, liquidations, perp basis', args: 'symbol, view?, interval?, hours?' },
  { name: 'get_etf_flows', group: 'spot ETFs', answers: 'Daily net creations/redemptions for US spot crypto ETFs + cumulative', args: 'symbol (BTC|ETH)' },
  { name: 'get_filings', group: 'filings', answers: 'CFTC COT positioning, SEC Form 4 insider trades, top 13F holders', args: 'kind (cot|insider|holders), ticker/key?' },
  { name: 'list_symbols', group: 'discovery', answers: 'Which markets are covered and which have data right now', args: '' },
  { name: 'list_expiries', group: 'discovery', answers: 'Valid expiry tokens for the other tools (any expiry also accepts next)', args: 'symbol' },
];

export const BQ_MCP_TOOL_NAMES = BQ_MCP_TOOLS.map((t) => t.name);

// ── MCP client (Streamable HTTP, JSON-RPC 2.0) ─────────────────────────────

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let mcpSessionId: string | null = null;
let mcpInitialized = false;

async function mcpRpc(method: string, params: Record<string, unknown> = {}, id: number): Promise<McpJsonRpcResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bqApiKey()}`,
  };
  if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
  const res = await fetch(BQ_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    cache: 'no-store',
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSessionId = sid;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    return JSON.parse(dataLine || '{}') as McpJsonRpcResponse;
  }
  return (await res.json().catch(() => ({}))) as McpJsonRpcResponse;
}

/** true when the Copilot can reach the real mcp.backquant.com (needs a key). */
export function mcpAvailable(): boolean {
  return bqMode() === 'live';
}

export async function mcpEnsureInit(): Promise<void> {
  if (mcpInitialized || !mcpAvailable()) return;
  const res = await mcpRpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'volos-copilot', version: '1.0.0' },
  }, 0);
  if (res.error) throw new Error(`BackQuant MCP initialize failed: ${res.error.message}`);
  mcpInitialized = true;
  void mcpRpc('notifications/initialized', {}, -1).catch(() => undefined);
}

/** tools/list from the REAL remote server (live mode only). */
export async function mcpToolsList(): Promise<Array<Record<string, unknown>>> {
  await mcpEnsureInit();
  const res = await mcpRpc('tools/list', {}, 1);
  if (res.error) throw new Error(`BackQuant MCP tools/list failed: ${res.error.message}`);
  const tools = (res.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? [];
  return tools;
}

/** tools/call on the REAL remote server (live mode only). */
export async function mcpToolsCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  await mcpEnsureInit();
  const res = await mcpRpc('tools/call', { name, arguments: args }, 2);
  if (res.error) throw new Error(`BackQuant MCP tools/call ${name} failed: ${res.error.message}`);
  const result = res.result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown } | undefined;
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { summary: text };
    }
  }
  return result;
}

// ── the VolOS tool layer (works live AND demo) ──────────────────────────────

type ToolArgs = Record<string, unknown>;

const num = (v: unknown, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const str = (v: unknown, dflt: string) => (typeof v === 'string' && v ? v : dflt);
const usd = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};
const px = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }) : '—';
};

function toolResult(tool: string, summary: string, data: Record<string, unknown>, mode: BqMode, extra?: Partial<BqToolResult>): BqToolResult {
  const now = new Date();
  return {
    tool,
    summary,
    mode,
    as_of: now.toISOString(),
    data_age_seconds: 0,
    venues: ['deribit', 'bybit', 'okx', 'binance', 'derive', 'thalex', 'delta'],
    data,
    ...extra,
  };
}

async function get(path: string, params: ToolArgs): Promise<Record<string, unknown>> {
  const r = await bqGet(path, params);
  return (r.envelope.data ?? {}) as Record<string, unknown>;
}

/**
 * Run one of the 23 BackQuant tools on VolOS's data plane.
 * Mirrors the remote MCP tool semantics (compact, shaped answers with
 * summary / units / as_of / venues), so the Copilot and the local MCP server
 * speak exactly the language mcp.backquant.com would.
 */
export async function runBackQuantTool(name: string, rawArgs: ToolArgs): Promise<BqToolResult> {
  const a = rawArgs ?? {};
  const mode = bqMode();
  const symbol = normalizeSymbol(str(a.symbol, 'BTCUSDT'));

  switch (name) {
    case 'get_brief': {
      const [levels, perps, tapeStats, expirySummary, expectedMove] = await Promise.all([
        get('/gex/levels', { symbol, include: 'max_pain,expected_move' }),
        get('/market/bundle', { symbol, interval: '1h', hours: 48 }),
        get('/tape/stats', { symbol, hours: 12 }),
        get('/options/expiry-summary', { symbol }),
        get('/options/expected-move', { symbol }),
      ]);
      const lv = levels as { all_expiry?: Record<string, number>; odte?: Record<string, number>; spot?: number };
      const ps = perps as { points?: Array<Record<string, number>> };
      const ts = tapeStats as { total_premium_usd?: number; trade_count?: number; call_share_pct?: number };
      const es = expirySummary as { expiries?: Array<Record<string, unknown>> };
      const em = expectedMove as { one_sigma?: Record<string, number> };
      const last = ps.points?.[ps.points.length - 1] ?? {};
      const front = es.expiries?.find((e) => Number(e.dte) > 0) ?? es.expiries?.[0] ?? {};
      return toolResult(
        'get_brief',
        `${symbol}${lv.spot ? ` spot ${usd(lv.spot)} vs ` : ''}HVL ${px(lv.all_expiry?.hvl)} (call wall ${px(lv.all_expiry?.call_resistance)}, put support ${px(lv.all_expiry?.put_support)}); 1σ band ${em.one_sigma ? `${px(em.one_sigma.low)}–${px(em.one_sigma.high)}` : '—'}; perp OI ${usd(last.open_interest)}, funding ${(Number(last.funding_rate ?? 0) * 100).toFixed(4)}%/interval; 12h tape ${usd(ts.total_premium_usd)} premium across ${ts.trade_count ?? 0} trades, calls ${ts.call_share_pct ?? 50}%.`,
        { levels, perps, tape_stats: tapeStats, expiry_summary_front: front, expected_move: expectedMove },
        mode,
        { units: 'usd where monetary; strikes in underlying price' },
      );
    }
    case 'get_gex_levels': {
      const d = await get('/gex/levels', { symbol, positioning: str(a.positioning, 'flow'), include: 'max_pain,expected_move' });
      const lv = d as { all_expiry?: Record<string, number>; odte?: Record<string, number> };
      return toolResult('get_gex_levels', `${symbol} gamma flip (HVL) ${px(lv.all_expiry?.hvl)} · call wall ${px(lv.all_expiry?.call_resistance)} · put support ${px(lv.all_expiry?.put_support)} · 0DTE HVL ${px(lv.odte?.hvl)}`, d, mode, { units: 'underlying price levels; GEX $ per 1% move' });
    }
    case 'get_gex_strike_profile': {
      const d = await get('/gex/strike-profile', { symbol, expiry: str(a.expiry, 'all') });
      const pf = d as { ranked_top_10?: Array<{ strike: number; net_gex: number }> };
      const top = pf.ranked_top_10?.slice(0, 3).map((r) => `${px(r.strike)} (${r.net_gex >= 0 ? '+' : ''}${Math.round(r.net_gex / 1e6)}M/1%)`).join(', ') ?? '—';
      return toolResult('get_gex_strike_profile', `${symbol} largest GEX strikes: ${top}`, d, mode, { units: 'net GEX $ per 1% spot move by strike' });
    }
    case 'get_greek': {
      const greek = ['gamma', 'vanna', 'charm', 'vega', 'theta', 'delta'].includes(String(a.greek)) ? String(a.greek) : 'gamma';
      const d = await get(`/options/greeks/${greek}`, { symbol, positioning: str(a.positioning, 'flow') });
      return toolResult('get_greek', `${symbol} dealer ${greek} exposure profile by strike (net / call / put cuts)`, d, mode, { units: greek === 'gamma' ? '$ per 1% spot' : greek === 'vega' ? '$ per vol point' : 'exposure units' });
    }
    case 'get_max_pain': {
      const d = await get('/gex/max-pain', { symbol, expiry: str(a.expiry, 'next') });
      const mp = d as { expiry?: string; max_pain?: number };
      return toolResult('get_max_pain', `${symbol} max pain for ${mp.expiry}: ${px(mp.max_pain)} — the strike where option writers profit most at expiry`, d, mode, { units: 'strike price' });
    }
    case 'compare_symbols': {
      const symbols = String(a.symbols ?? a.symbol ?? 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => normalizeSymbol(s)).slice(0, 8);
      const d = await get('/multi/gex/levels', { symbols: [...new Set(symbols)].join(',') });
      return toolResult('compare_symbols', `Gamma levels side by side for ${[...new Set(symbols)].join(', ')}`, d, mode, { units: 'underlying price levels' });
    }
    case 'get_tape': {
      const hours = Math.round(num(a.hours, 12));
      const d = await get('/tape/recent', { symbol, limit: Math.round(num(a.limit, 20)) });
      const stats = await get('/tape/stats', { symbol, hours });
      const trades = (d as { trades?: Array<Record<string, unknown>> }).trades ?? [];
      const biggest = [...trades].sort((x, y) => Number(y.premium_usd ?? 0) - Number(x.premium_usd ?? 0))[0];
      return toolResult('get_tape', `${symbol} tape (last ${hours}h): ${trades.length} recent prints, biggest ${usd(biggest?.premium_usd)} ${biggest?.instrument ?? ''} on ${biggest?.venue ?? '—'}`, { trades, stats }, mode, { units: 'premium_usd per print' });
    }
    case 'get_flow_by_strike': {
      const d = await get('/tape/flow-by-strike', { symbol, min_premium_usd: num(a.min_premium_usd, 25_000) });
      const strikes = (d as { strikes?: Array<{ strike: number; net_aggressor_usd: number }> }).strikes ?? [];
      const topBuy = [...strikes].sort((x, y) => y.net_aggressor_usd - x.net_aggressor_usd)[0];
      const topSell = [...strikes].sort((x, y) => x.net_aggressor_usd - y.net_aggressor_usd)[0];
      const one = a.strike ? ` (asked about ${px(a.strike)}: ${usd(strikes.find((s) => s.strike === Number(a.strike))?.net_aggressor_usd)} net)` : '';
      return toolResult('get_flow_by_strike', `${symbol} aggressors net buying ${px(topBuy?.strike)} (${usd(topBuy?.net_aggressor_usd)}) and net selling ${px(topSell?.strike)}${one}`, d, mode, { units: 'net aggressor USD by strike' });
    }
    case 'get_dealer_flow': {
      const d = await get('/gex/dealer-flow', { symbol, positioning: str(a.positioning, 'flow') });
      return toolResult('get_dealer_flow', `${symbol} dealer hedge flow time series (gamma + vanna + charm components)`, d, mode, { units: 'USD hedge flow per interval' });
    }
    case 'get_iv': {
      const view = str(a.view, 'atm');
      const path = view === 'surface' ? '/options/iv/surface' : view === 'skew' ? '/options/iv/skew' : view === 'term' ? '/options/iv/term-structure' : view === 'cm' ? '/options/iv/constant-maturity' : '/options/iv/term-structure';
      const d = await get(path, { symbol });
      const ts = d as { points?: Array<{ dte: number; atm_iv: number }> };
      const front = ts.points?.find((p) => p.dte > 0) ?? ts.points?.[0];
      return toolResult('get_iv', `${symbol} IV (${view}): front ATM ${front ? `${front.atm_iv}% at ${front.dte}d` : 'see surface data'}`, d, mode, { units: 'IV in annualized %' });
    }
    case 'get_expected_move': {
      const d = await get(str(a.view, '') === 'calibrated' ? '/options/range' : '/options/expected-move', { symbol });
      const em = d as { one_sigma?: { low: number; high: number; pct?: number } };
      return toolResult('get_expected_move', `${symbol} implied 1σ move: ${px(em.one_sigma?.low)} – ${px(em.one_sigma?.high)} (${em.one_sigma?.pct ?? '—'}%)${a.view === 'calibrated' ? ' — calibrated 68/90% bands at 1h/4h/24h' : ''}`, d, mode, { units: 'underlying price' });
    }
    case 'get_probability': {
      const d = await get('/options/probability/density', { symbol, expiry: str(a.expiry, 'next') });
      const pd = d as { prob_above_spot?: number; prob_below_spot?: number; mode?: number };
      if (a.price) {
        const strikes = (d.strikes as number[] | undefined) ?? [];
        const cdf = (d.cdf as number[] | undefined) ?? [];
        let idx = strikes.findIndex((s) => s >= Number(a.price));
        if (idx < 0) idx = strikes.length - 1;
        const below = cdf[idx] ?? pd.prob_below_spot ?? 50;
        return toolResult('get_probability', `${symbol} risk-neutral odds of finishing below $${a.price} at ${str(a.expiry, 'next expiry')}: ~${Math.round(below)}% (above: ~${Math.round(100 - below)}%)`, d, mode, { units: '%' });
      }
      return toolResult('get_probability', `${symbol} risk-neutral PDF: mode ${px(pd.mode)}, ~${Math.round(pd.prob_above_spot ?? 50)}% above / ${Math.round(pd.prob_below_spot ?? 50)}% below spot`, d, mode, { units: '% probability' });
    }
    case 'get_basis': {
      const d = await get('/options/futures/term-structure', { symbol });
      const ft = d as { maturities?: Array<{ maturity: string; basis_annualized_pct: number }>; curve_shape?: string };
      return toolResult('get_basis', `${symbol} dated-futures curve ${ft.curve_shape ?? ''}: front basis ${ft.maturities?.[0]?.basis_annualized_pct ?? '—'}% ann., back ${ft.maturities?.[ft.maturities.length - 1]?.basis_annualized_pct ?? '—'}%`, d, mode, { units: 'annualized % basis' });
    }
    case 'get_oi': {
      const d = await get(str(a.view, '') === 'history' ? '/options/oi/history' : '/options/oi/by-expiry', { symbol, limit: num(a.limit, 200) });
      return toolResult('get_oi', `${symbol} open interest ${str(a.view, 'by expiry')}`, d, mode, { units: 'contracts (× contract size)' });
    }
    case 'get_expiry_summary': {
      const d = await get('/options/expiry-summary', { symbol });
      const rows = (d as { expiries?: Array<{ expiry: string; dte: number; atm_iv: number; total_oi: number }> }).expiries ?? [];
      return toolResult('get_expiry_summary', `${symbol}: ${rows.length} active expiries, front ${rows[0]?.expiry} (${rows[0]?.dte}d, ATM ${rows[0]?.atm_iv}%, OI ${Math.round(Number(rows[0]?.total_oi ?? 0)).toLocaleString()})`, d, mode, { units: 'IV %; OI contracts' });
    }
    case 'get_opex': {
      const d = await get('/options/opex', { symbol, horizon: num(a.horizon_days, 45) });
      const ev = (d as { events?: Array<{ date: string; type: string; oi_rolling_off: number; is_anchor?: boolean }> }).events ?? [];
      const next = ev.find((e) => e.is_anchor) ?? ev[0];
      return toolResult('get_opex', `${symbol} next OPEX of note: ${next?.date} (${next?.type}, ${Math.round(Number(next?.oi_rolling_off ?? 0)).toLocaleString()} contracts roll off) — ${ev.length} expiries in window`, d, mode, { units: 'OI contracts rolling off' });
    }
    case 'get_history': {
      const metric = ['gex', 'oi', 'stress'].includes(String(a.metric)) ? String(a.metric) : 'gex';
      const path = metric === 'oi' ? '/options/oi/history' : metric === 'stress' ? '/gex/stress-history' : '/gex/history';
      const d = await get(path, { symbol, limit: num(a.days, 90), days: num(a.days, 90) });
      return toolResult('get_history', `${symbol} ${metric} history over ${num(a.days, 90)} observations`, d, mode, { units: metric === 'gex' ? '$ per 1% spot' : 'contracts' });
    }
    case 'get_liquidation': {
      const d = await get(str(a.view, '') === 'distribution' ? '/liquidation/distribution' : '/liquidation/heatmap', { symbol });
      const lh = d as { clusters?: Array<{ price: number; intensity: number }> };
      const top = lh.clusters?.[0];
      return toolResult('get_liquidation', `${symbol} liquidation heatmap: hottest cluster ~${px(top?.price)} (intensity ${top?.intensity ?? '—'}/100)`, d, mode, { units: 'intensity 0–100; USD at level' });
    }
    case 'get_perps': {
      const d = await get('/market/bundle', { symbol, interval: str(a.interval, '1h'), hours: num(a.hours, 72) });
      const pts = (d as { points?: Array<Record<string, number>> }).points ?? [];
      const last = pts[pts.length - 1] ?? {};
      return toolResult('get_perps', `${symbol} perps: OI ${usd(last.open_interest)}, funding ${(Number(last.funding_rate ?? 0) * 100).toFixed(4)}%/interval, price ${px(last.price)}`, d, mode, { units: 'USD; rate per interval' });
    }
    case 'get_etf_flows': {
      const sym = String(a.symbol ?? 'BTC').toUpperCase().startsWith('ETH') ? 'ETHUSDT' : 'BTCUSDT';
      const d = await get('/etf/flows', { symbol: sym, region: 'us' });
      const f = d as { total?: { daily_net_flow_usd?: number }; as_of_settlement?: string };
      return toolResult('get_etf_flows', `US spot ${sym.slice(0, 3)} ETFs net flow (settlement ${f.as_of_settlement}): ${usd(f.total?.daily_net_flow_usd)} — per-fund splits in data`, d, mode, { units: 'USD daily net creations/redemptions', venues: undefined, as_of: (f.as_of_settlement ?? '') + 'T00:00:00Z' });
    }
    case 'get_filings': {
      const kind = ['cot', 'insider', 'holders'].includes(String(a.kind)) ? String(a.kind) : 'cot';
      if (kind === 'insider') {
        const d = await get('/filings/insider', { ticker: str(a.ticker, 'COIN'), lookback: '90d' });
        const txs = (d as { transactions?: Array<{ insider: string; action: string; value_usd: number }> }).transactions ?? [];
        return toolResult('get_filings', `${str(a.ticker, 'COIN')} Form 4: ${txs.length} insider transactions in lookback — top values in data`, d, mode, { venues: undefined });
      }
      if (kind === 'holders') {
        const d = await get('/filings/holders', { ticker: str(a.ticker, 'MSTR'), limit: 10 });
        const hs = (d as { holders?: Array<{ holder: string; value_usd: number }> }).holders ?? [];
        return toolResult('get_filings', `${str(a.ticker, 'MSTR')} 13F: top holder ${hs[0]?.holder} (${usd(hs[0]?.value_usd)}) of ${hs.length}`, d, mode, { venues: undefined });
      }
      const d = await get('/cot/summary', { window: '3y', limit: 8 });
      const ms = (d as { markets?: Array<{ name: string; percentile_3y: number; net_leveraged_funds: number }> }).markets ?? [];
      return toolResult('get_filings', `COT extremes: ${ms[0]?.name} at ${Math.round(ms[0]?.percentile_3y)}th pct (net lev-funds ${ms[0]?.net_leveraged_funds?.toLocaleString()})`, d, mode, { venues: undefined });
    }
    case 'list_symbols': {
      const d = await get('/symbols', {});
      const syms = (d as { symbols?: Array<{ symbol: string; status: string }> }).symbols ?? [];
      return toolResult('list_symbols', `${syms.length} markets covered: ${syms.map((s) => s.symbol).join(', ')} — per-category availability in data`, d, mode);
    }
    case 'list_expiries': {
      const d = await get('/expiries', { symbol });
      const ex = (d as { expiries?: Array<{ token: string; dte: number; type: string }> }).expiries ?? [];
      return toolResult('list_expiries', `${symbol}: ${ex.length} active expiries, front ${ex.find((e) => e.dte > 0)?.token ?? ex[0]?.token} — pass any token (or "next") to expiry-taking tools`, d, mode);
    }
    default:
      throw new Error(`Unknown BackQuant tool: ${name}. Valid: ${BQ_MCP_TOOL_NAMES.join(', ')}`);
  }
}
