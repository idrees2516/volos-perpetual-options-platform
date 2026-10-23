// ---------------------------------------------------------------------------
// backtest — strategy backtesting engine on REAL exchange history.
//
// Data: Bybit spot klines (public) + live Deribit IV calibration. For every
// cycle the strategy legs are re-struck at that cycle's entry spot, priced
// with Black-Scholes at a realized-vol-implied IV (calibrated so today's
// surface matches the live Deribit chain), marked to market daily and settled
// at intrinsic on expiry. Fees + slippage per leg.
// ---------------------------------------------------------------------------

import { bsGreeks, VOL_CONFIG, ivForStrike, atmVol } from '@/lib/pricing';
import { snapToGrid } from '@/lib/strategies';
import type { Leg } from '@/lib/types';
import { getHistory, getLiveAtmIv, type FeedAsset } from './exchange-feeds';
import { ASSET_IDS, type AssetId } from './market-intel';

export interface BacktestLegSpec {
  kind: 'call' | 'put';
  side: 'buy' | 'sell';
  qty: number;
  /** strike as multiplier of entry spot (e.g. 1.10) */
  strike: number;
  expiryDays: number;
}

export interface BacktestTrade {
  cycle: number;
  entryDate: string;
  exitDate: string;
  entrySpot: number;
  exitSpot: number;
  entryDebit: number; // net debit (positive) / credit (negative) per package, USD
  exitValue: number;
  pnl: number;
  rMultiple: number | null;
  win: boolean;
  holdDays: number;
}

export interface BacktestStats {
  cycles: number;
  totalPnl: number;
  returnPct: number;
  cagrPct: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  avgHoldDays: number;
}

export interface BacktestResult {
  asset: AssetId;
  strategyName: string;
  legs: BacktestLegSpec[];
  windowDays: number;
  stats: BacktestStats;
  equityCurve: { t: number; v: number }[];
  sampleTrades: BacktestTrade[];
  volModel: {
    calibrationFactor: number;
    avgEntryIv: number;
    liveAtmIv: number;
  };
  dataSource: string;
  assumptions: string[];
}

const DAYS_PER_YEAR = 365;

/** Rolling realized vol (stdev of log returns, annualized). */
function rollingRealizedVol(closes: number[], idx: number, window = 20): number {
  const lo = Math.max(0, idx - window);
  const rets: number[] = [];
  for (let i = lo + 1; i <= idx; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 5) return 0.5;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.min(Math.max(Math.sqrt(varr * DAYS_PER_YEAR), 0.08), 3);
}

function legPrice(spot: number, strike: number, tYears: number, iv: number, isCall: boolean): number {
  return bsGreeks(spot, strike, Math.max(tYears, 1 / (365 * 24)), iv, 0, isCall ? 'call' : 'put').price;
}

/** Solve the volShift that makes the synthetic surface's ATM equal `target`. */
function volShiftForTarget(cfg: (typeof VOL_CONFIG)[string], tYears: number, target: number): number {
  const t = Math.max(tYears, (1 / 365) / 8);
  const base = cfg.atm30d * Math.exp(Math.log(t / (30 / DAYS_PER_YEAR)) * cfg.termSlope);
  return Math.min(Math.max(target / base - 1, -0.8), 3);
}

export interface BacktestOptions {
  asset: AssetId | string;
  legs: BacktestLegSpec[];
  strategyName?: string;
  windowDays?: number;
  feeBps?: number; // on underlying notional, per leg per fill
  slippagePct?: number; // on premium
  capitalBase?: number; // USD risk capital per package; auto if omitted
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const assetRaw = String(opts.asset ?? 'BTC').toUpperCase();
  const asset: AssetId = (ASSET_IDS as string[]).includes(assetRaw) ? (assetRaw as AssetId) : 'BTC';
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const legs = opts.legs.filter((l) => l.qty > 0 && l.strike > 0);
  if (legs.length === 0) throw new Error('backtest needs at least one leg');

  const windowDays = Math.min(Math.max(opts.windowDays ?? 365, 90), 730);
  const feeBps = opts.feeBps ?? 2;
  const slippagePct = opts.slippagePct ?? 0.01;
  const maxExpiry = Math.max(...legs.map((l) => l.expiryDays));
  const barsNeeded = Math.min(windowDays + maxExpiry + 40, 1000);

  // --- real data -------------------------------------------------------------
  const [bars, liveIv] = await Promise.all([
    getHistory(asset as FeedAsset, '1d', barsNeeded),
    getLiveAtmIv(asset as FeedAsset).catch(() => null),
  ]);
  // bars are chronological; simulate on the last `windowDays` entries
  const simStart = Math.max(maxExpiry + 5, bars.length - windowDays);
  const closes = bars.map((b) => b.c);

  // calibrate the RV-implied surface to today's live market IV
  // (getLiveAtmIv returns PERCENT — convert to fraction)
  const lastRv = rollingRealizedVol(closes, closes.length - 1, 20);
  const liveAtm = liveIv != null ? liveIv / 100 : cfg.atm30d;
  const calibration = Math.min(Math.max(liveAtm / Math.max(lastRv, 0.05), 0.4), 2.2);

  // --- simulation -------------------------------------------------------------
  const equityCurve: { t: number; v: number }[] = [];
  const trades: BacktestTrade[] = [];
  let equity = 0;

  const resolveEntryIv = (barIdx: number, tYears: number): number => {
    const rv = rollingRealizedVol(closes, barIdx, 20);
    const target = Math.min(Math.max(rv * calibration, 0.1), 2.5);
    return atmVol(cfg, tYears, volShiftForTarget(cfg, tYears, target));
  };

  // estimate capital base: max loss of the first cycle (defined risk) or margin proxy
  let capitalBase = opts.capitalBase ?? 0;

  for (let start = simStart; start + maxExpiry < bars.length; start += maxExpiry) {
    const entrySpot = closes[start];
    const entryDate = bars[start].t;
    const expiryBar = start + maxExpiry;

    // resolve concrete legs for this cycle
    const resolved = legs.map((l) => {
      const strike = snapToGrid(entrySpot, l.strike);
      const tYears = l.expiryDays / DAYS_PER_YEAR;
      const iv = ivForStrike(cfg, entrySpot, strike, tYears, volShiftForTarget(cfg, tYears, resolveEntryIv(start, tYears)));
      const mid = legPrice(entrySpot, strike, tYears, iv, l.kind === 'call');
      const fill = l.side === 'buy' ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
      return { ...l, strike, tYears, iv, fill };
    });

    let entryDebit = 0;
    for (const l of resolved) {
      const cash = l.fill * l.qty * (l.side === 'buy' ? 1 : -1);
      entryDebit -= cash; // debit positive when net buying
      entryDebit -= (feeBps / 10_000) * entrySpot * l.qty;
    }
    if (capitalBase === 0 && trades.length === 0) {
      // defined risk: worst case at expiry across the path grid
      let worst = 0;
      for (let s = entrySpot * 0.5; s <= entrySpot * 1.5; s += entrySpot * 0.02) {
        let v = 0;
        for (const l of resolved) {
          const intr = Math.max(0, l.kind === 'call' ? s - l.strike : l.strike - s);
          v += (l.side === 'buy' ? intr : -intr) * l.qty;
        }
        worst = Math.max(worst, entryDebit - v);
      }
      capitalBase = Math.max(worst, entrySpot * 0.15);
    }

    // daily mark-to-market + settlement
    let cycleEquity = 0;
    let prevMtm = -entryDebit;
    for (let d = start; d <= expiryBar; d++) {
      const spot = closes[d];
      const t = d === expiryBar ? 0 : (expiryBar - d) / DAYS_PER_YEAR;
      const dayIv = resolveEntryIv(d, Math.max(t, 5 / DAYS_PER_YEAR));
      let mtm = 0;
      for (const l of resolved) {
        const tRemain = l.expiryDays === maxExpiry ? t : Math.max(0, (start + l.expiryDays - d) / DAYS_PER_YEAR);
        if (tRemain <= 0) {
          // this leg already expired at its own expiry
          const intr = Math.max(0, l.kind === 'call' ? closes[start + l.expiryDays] - l.strike : l.strike - closes[start + l.expiryDays]);
          mtm += (l.side === 'buy' ? intr : -intr) * l.qty;
          continue;
        }
        const iv = ivForStrike(cfg, spot, l.strike, tRemain, volShiftForTarget(cfg, tRemain, dayIv));
        const px = legPrice(spot, l.strike, tRemain, iv, l.kind === 'call');
        mtm += (l.side === 'buy' ? px : -px) * l.qty;
      }
      mtm += entryDebit; // entry cash offset
      cycleEquity = mtm;
      equity += mtm - prevMtm;
      prevMtm = mtm;
      equityCurve.push({ t: bars[d].t, v: +(equity.toFixed(2)) });
    }
    // exit fees
    for (const l of resolved) equity -= (feeBps / 10_000) * closes[expiryBar] * l.qty;

    const exitSpot = closes[expiryBar];
    const pnl = cycleEquity;
    const maxLoss = capitalBase;
    trades.push({
      cycle: trades.length + 1,
      entryDate: new Date(entryDate).toISOString().slice(0, 10),
      exitDate: new Date(bars[expiryBar].t).toISOString().slice(0, 10),
      entrySpot,
      exitSpot,
      entryDebit: +entryDebit.toFixed(2),
      exitValue: +(cycleEquity + entryDebit).toFixed(2),
      pnl: +pnl.toFixed(2),
      rMultiple: maxLoss > 0 ? +(pnl / maxLoss).toFixed(2) : null,
      win: pnl > 0,
      holdDays: maxExpiry,
    });
  }

  // --- stats --------------------------------------------------------------------
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const eq = equityCurve.map((p) => p.v);
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of eq) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, peak - v);
  }
  // daily returns from the equity curve
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) rets.push((eq[i] - eq[i - 1]) / capitalBase);
  const meanRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (rets.length - 1)) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : 0;
  const years = Math.max(windowDays / DAYS_PER_YEAR, 0.25);

  const stats: BacktestStats = {
    cycles: trades.length,
    totalPnl: +equity.toFixed(2),
    returnPct: +((equity / capitalBase) * 100).toFixed(1),
    cagrPct: +(((equity / capitalBase) / years) * 100).toFixed(1),
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
    expectancy: trades.length ? +(equity / trades.length).toFixed(2) : 0,
    bestTrade: trades.length ? +Math.max(...trades.map((t) => t.pnl)).toFixed(2) : 0,
    worstTrade: trades.length ? +Math.min(...trades.map((t) => t.pnl)).toFixed(2) : 0,
    maxDrawdownPct: +((maxDd / capitalBase) * 100).toFixed(1),
    sharpe: sd > 0 ? +((meanRet / sd) * Math.sqrt(DAYS_PER_YEAR)).toFixed(2) : 0,
    sortino: dsd > 0 ? +((meanRet / dsd) * Math.sqrt(DAYS_PER_YEAR)).toFixed(2) : 0,
    avgHoldDays: trades.length ? +(trades.reduce((a, t) => a + t.holdDays, 0) / trades.length).toFixed(0) : 0,
  };

  const avgEntryIvs = trades.length ? resolveEntryIv(simStart, 30 / DAYS_PER_YEAR) : 0;

  return {
    asset,
    strategyName: opts.strategyName ?? 'custom structure',
    legs,
    windowDays,
    stats,
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 120)) === 0),
    sampleTrades: trades.slice(-8).reverse(),
    volModel: {
      calibrationFactor: +calibration.toFixed(2),
      avgEntryIv: +(avgEntryIvs * 100).toFixed(1),
      liveAtmIv: +(liveAtm * 100).toFixed(1),
    },
    dataSource: 'Bybit spot klines (real) · Deribit live IV calibration · BS daily MTM',
    assumptions: [
      `European hold-to-${maxExpiry}d settlement at close (no early assignment/american exercise)`,
      `legs re-struck per cycle at ${feeBps}bps fee + ${slippagePct * 100}% premium slippage`,
      'IV per cycle from rolling 20d realized vol × live-market calibration factor',
      'capital base = worst-case loss of first cycle (defined risk) or 15% spot margin proxy',
    ],
  };
}

/** Convert builder/catalog legs to backtest leg specs (strikeMult from live spot). */
export function legsToSpecs(legs: Leg[], spot: number): BacktestLegSpec[] {
  return legs
    .filter((l) => l.kind === 'call' || l.kind === 'put')
    .map((l) => ({
      kind: l.kind as 'call' | 'put',
      side: l.side,
      qty: l.qty,
      strike: +(l.strike != null ? l.strike / spot : 1).toFixed(4),
      expiryDays: l.expiryDays ?? 30,
    }));
}
