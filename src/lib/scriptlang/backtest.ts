// ─────────────────────────────────────────────────────────────────────────────
// VolScript — backtest simulator. Event-driven, next-bar-open fills (never
// repaints), intrabar stop/limit checks, pyramiding = 0, long & short with
// all-in equity sizing and per-side commission in percent.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScriptBar, BacktestResult, StrategyStats, TradeEvent } from './types';
import type { InterpEvents } from './interpreter';

interface Position {
  side: 'long' | 'short';
  entryIdx: number;
  entryPrice: number;
  qty: number;
  feePaid: number; // entry-leg commission, realized at close
}

/** stop/limit orders live with the position: set on strategy.exit() bars,
 *  persist until the position closes, reset on close. */

export function simulateBacktest(
  bars: ScriptBar[],
  events: InterpEvents,
  cfg: { initialCapital: number; commissionPct: number },
): BacktestResult {
  const n = bars.length;
  const equity: number[] = new Array(n).fill(cfg.initialCapital);
  const trades: TradeEvent[] = [];
  const markers: BacktestResult['markers'] = [];
  const feePct = cfg.commissionPct / 100;

  // position lives in a holder object — closure writes are opaque to TS flow
  // analysis and we intentionally narrow through it at each use site
  const st = { pos: null as Position | null };
  let cash = cfg.initialCapital; // equity settled (position P&L added on close)
  let pendingClose: { reason: TradeEvent['reason'] } | null = null;
  let pendingEntry: 'long' | 'short' | null = null;
  let curStop = NaN;
  let curLimit = NaN;

  const closePosition = (price: number, idx: number, reason: TradeEvent['reason']) => {
    const p = st.pos;
    if (!p) return;
    const notionalExit = p.qty * price;
    const fee = notionalExit * feePct;
    const gross = p.side === 'long' ? p.qty * (price - p.entryPrice) : p.qty * (p.entryPrice - price);
    const pnl = gross - fee - p.feePaid;
    cash += pnl;
    const pnlPct = p.side === 'long' ? (price / p.entryPrice - 1) * 100 : (1 - price / p.entryPrice) * 100;
    trades.push({
      id: `${p.side === 'long' ? 'L' : 'S'}${trades.length + 1}`,
      side: p.side,
      entryIdx: p.entryIdx,
      entryPrice: p.entryPrice,
      exitIdx: idx,
      exitPrice: price,
      pnl,
      pnlPct,
      reason,
      bars: idx - p.entryIdx,
    });
    markers.push({ idx: p.entryIdx, price: p.entryPrice, side: p.side, kind: 'entry', reason });
    markers.push({ idx, price, side: p.side, kind: 'exit', reason });
    st.pos = null;
    curStop = NaN;
    curLimit = NaN;
  };

  const openPosition = (side: 'long' | 'short', price: number, idx: number) => {
    const qty = cash / price; // all-in, no leverage
    const fee = (qty * price) * feePct;
    st.pos = { side, entryIdx: idx, entryPrice: price, qty, feePaid: fee }; // fees realized at close
  };

  for (let i = 0; i < n; i++) {
    const bar = bars[i];

    // 1 — execute pendings at this bar's open (next-bar-open fills)
    if (i > 0) {
      if (pendingClose && st.pos) closePosition(bar.o, i, pendingClose.reason);
      if (pendingEntry && !st.pos) openPosition(pendingEntry, bar.o, i);
      pendingClose = null;
      pendingEntry = null;
    }

    // 2 — arm/refresh standing stop & limit orders (a strategy.exit() call may
    //     arrive on the same bar as the entry signal, before the next-open fill)
    if (Number.isFinite(events.stop[i])) curStop = events.stop[i];
    if (Number.isFinite(events.limit[i])) curLimit = events.limit[i];
    if (st.pos) {
      const p = st.pos;
      if (p.side === 'long') {
        if (Number.isFinite(curStop) && bar.l <= curStop) closePosition(curStop, i, 'stop');
        else if (Number.isFinite(curLimit) && bar.h >= curLimit) closePosition(curLimit, i, 'limit');
      } else {
        if (Number.isFinite(curStop) && bar.h >= curStop) closePosition(curStop, i, 'stop');
        else if (Number.isFinite(curLimit) && bar.l <= curLimit) closePosition(curLimit, i, 'limit');
      }
    }

    // 3 — signals on this bar schedule next-open fills
    if (events.closeAll[i] !== 0 && st.pos) pendingClose = { reason: 'signal' };
    const wantLong = events.enterLong[i] !== 0;
    const wantShort = events.enterShort[i] !== 0;
    if (wantLong || wantShort) {
      const side: 'long' | 'short' = wantLong ? 'long' : 'short';
      if (!st.pos && !pendingEntry) pendingEntry = side;
      else if (st.pos && st.pos.side !== side) {
        pendingClose = { reason: 'reverse' };
        pendingEntry = side;
      }
      // same-direction signal while in position → ignored (pyramiding 0)
    }

    // 4 — mark-to-market
    const p = st.pos;
    equity[i] =
      p && cash > 0
        ? cash + (p.side === 'long' ? p.qty * (bar.c - p.entryPrice) : p.qty * (p.entryPrice - bar.c)) - p.feePaid
        : cash;
  }

  // 5 — close any residual position at the last close
  if (st.pos) {
    const last = bars[n - 1];
    closePosition(last.c, n - 1, 'end');
    equity[n - 1] = cash;
  }

  // ── stats ───────────────────────────────────────────────────────────────────
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = cfg.initialCapital;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) maxDD = Math.max(maxDD, ((peak - e) / peak) * 100);
  }
  // Sharpe from per-bar equity returns, annualized by bar spacing
  const rets: number[] = [];
  for (let i = 1; i < n; i++) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  let sharpe = 0;
  if (rets.length > 2) {
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
    const sd = Math.sqrt(variance);
    if (sd > 0) {
      let barMs = 3_600_000;
      if (n > 2) {
        const gaps: number[] = [];
        for (let i = 1; i < n; i++) gaps.push(bars[i].ts - bars[i - 1].ts);
        gaps.sort((a, b) => a - b);
        barMs = gaps[Math.floor(gaps.length / 2)] || barMs;
      }
      const barsPerYear = (365.25 * 86_400_000) / barMs;
      sharpe = (mean / sd) * Math.sqrt(barsPerYear);
    }
  }
  const inMarketBars = trades.reduce((s, t) => s + Math.max(1, t.bars), 0);
  const finalEquity = equity[n - 1] ?? cfg.initialCapital;

  const stats: StrategyStats = {
    initialCapital: cfg.initialCapital,
    finalEquity,
    netProfit: finalEquity - cfg.initialCapital,
    netProfitPct: ((finalEquity - cfg.initialCapital) / cfg.initialCapital) * 100,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    maxDrawdownPct: maxDD,
    sharpe,
    avgHoldBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
    bestTradePct: trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0,
    worstTradePct: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0,
    expectancyPct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0,
    exposurePct: n ? Math.min(100, (inMarketBars / n) * 100) : 0,
  };

  return { stats, equity, trades, markers };
}
