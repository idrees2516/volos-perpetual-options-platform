// GET /api/forecast/state — the projected-state readout.
//
//   ?asset=BTC        BTC | ETH | SOL | …
//   ?tf=60000         1m | 5m | 15m | 30m flow-bar buckets
//   ?h=30             horizon steps ahead of the last bar
//   ?levels=80,95     interval levels (percent)
//   ?nWindows=10      conformal calibration windows
//   ?backfill=720      kline bars of exchange history
//
// One response answers the whole forward question, all from current +
// previous data on the shared merged-bar history:
//
//   price      FlowX conformal point + widest band per step (the fan drawn
//              ahead of the live price) + Ensemble cross-check path
//   metrics    volume · delta · CVD · buy share · prints (+ OI when the
//              engine has session history) each with its own band
//   indicators RSI(14) · EMA(21) · SMA(50) · MACD hist · Bollinger %B
//              rolled forward across the projected price path
//   volatility ATR(14), realized σ, expected-move-% per step
//   pUp        empirical climatology of h-step moves from history
//   snapshot   every "now" value in one flat record

import { buildProjectedState } from '@/lib/forecast/state';
import { json, parseAsset, parseTimeframe } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const tf = parseTimeframe(url.searchParams.get('tf'));
  const h = Math.max(1, Math.min(120, Number(url.searchParams.get('h')) || 30));
  const levels = (url.searchParams.get('levels') ?? '80,95')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v > 50 && v < 100);
  const useLevels = levels.length ? [...new Set(levels)].sort((a, b) => a - b) : [80, 95];
  const nWindows = Math.max(2, Math.min(64, Number(url.searchParams.get('nWindows')) || 10));
  const backfill = Math.max(60, Math.min(1500, Number(url.searchParams.get('backfill')) || 720));

  try {
    const state = await buildProjectedState(asset, tf, { h, levels: useLevels, nWindows, backfill });
    return json({ ...state, builtAt: Date.now() });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'projected state failed' }, 500);
  }
}
