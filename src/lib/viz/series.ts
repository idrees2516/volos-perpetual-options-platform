// ─────────────────────────────────────────────────────────────────────────────
// VIZ · series registry — every plottable series in the product, ONE catalog.
//
// The Chart Studio's data source AND the Model Studio's input surface:
//
//   price      — OHLCV bars from the shared merged-bar history (store-first
//                klines + engine tail) with candle fields
//   indicators — the full technical battery computed on the same bars
//   flow       — delta / CVD / buy share / taker ratio from aggressor volume
//   forecast   — the conformal price fan (point + lo/hi per step)
//   models     — live model-room outputs (GARCH σ path, HMM decode + probs,
//                Kalman level, ML P(up) OOS path, mixed-MC fan)
//   surfaces   — matrix families (IV surface, GEX strike×time session,
//                funding heat, correlation)
//
// Everything rides loadMergedBars — the same cached store-first loader the
// forecast stack and Decision Hub use, so the studio costs no extra venue
// calls beyond one shared fetch per TTL window.
// ─────────────────────────────────────────────────────────────────────────────

import type { OfAsset } from '@/lib/orderflow/types';
import { loadMergedBars, type RawBar } from '@/lib/forecast/panel';
import { buildProjectedStateFromBars } from '@/lib/forecast/state';
import {
  rsi, ema, sma, macd, bollinger, atr, stoch, adx, obv, vwapAnchored, deltaPerBar, cvd, takerBuyRatio, historicalVol,
  type Bar as IndBar,
} from '@/lib/quant/indicators';
import { computeModelCore } from '@/lib/decision/core';
import { getGexSession } from '@/lib/quant/gex-session';
import { marketCorrelation } from '@/lib/quant/correlation';
import { fundingGrid } from '@/lib/quant/funding-grid';
import type { VizMatrix, VizSeries, SeriesSpec, VizPoint } from './types';

export const SERIES_GROUPS = ['price', 'indicators', 'flow', 'forecast', 'models', 'surfaces'] as const;
export type SeriesGroup = (typeof SERIES_GROUPS)[number];

export const SERIES_SPECS: SeriesSpec[] = [
  // ── price ──────────────────────────────────────────────────────────────────
  { id: 'close', group: 'price', label: 'close (candles)', unit: 'usd', desc: 'merged-bar close with OHLC candle fields', kinds: ['line', 'candles', 'area', 'band'], tags: ['ohlcv'], candles: true, consumedBy: ['forecast', 'decision hub', 'indicators', 'models'] },
  { id: 'volume', group: 'price', label: 'volume', unit: 'base', desc: 'per-bar base volume', kinds: ['bars', 'histogram', 'line'], tags: ['ohlcv'] },
  { id: 'buyVolume', group: 'price', label: 'taker-buy volume', unit: 'base', desc: 'aggressor buy volume per bar', kinds: ['bars', 'line'], tags: ['ohlcv', 'flow'] },
  { id: 'trades', group: 'price', label: 'trade count', unit: '#', desc: 'per-bar trade count', kinds: ['bars', 'line'], tags: ['ohlcv'] },
  // ── indicators ─────────────────────────────────────────────────────────────
  { id: 'rsi14', group: 'indicators', label: 'RSI 14', unit: '0–100', desc: 'Wilder RSI on closes', kinds: ['line', 'band'], tags: ['momentum'], consumedBy: ['indicators panel'] },
  { id: 'ema21', group: 'indicators', label: 'EMA 21', unit: 'usd', desc: 'exponential moving average on closes', tags: ['trend'] },
  { id: 'sma50', group: 'indicators', label: 'SMA 50', unit: 'usd', desc: 'simple moving average on closes', tags: ['trend'] },
  { id: 'macdHist', group: 'indicators', label: 'MACD histogram', desc: 'EMA12−EMA26 signal gap', kinds: ['bars', 'histogram', 'line'], tags: ['momentum'] },
  { id: 'bbPercentB', group: 'indicators', label: 'Bollinger %B', unit: '0–1', desc: 'close position inside 20/2σ bands', tags: ['volatility'] },
  { id: 'atr14', group: 'indicators', label: 'ATR 14', unit: 'usd', desc: 'average true range', tags: ['volatility'] },
  { id: 'stochK', group: 'indicators', label: 'Stochastic %K', unit: '0–100', desc: '14-bar stochastic raw %K', tags: ['momentum'] },
  { id: 'adx', group: 'indicators', label: 'ADX', desc: 'trend strength index', tags: ['trend'] },
  { id: 'obv', group: 'indicators', label: 'OBV', desc: 'on-balance volume (cumulative)', tags: ['flow'] },
  { id: 'vwap', group: 'indicators', label: 'VWAP (anchored)', unit: 'usd', desc: 'session-anchored volume-weighted price', tags: ['trend'] },
  { id: 'hv20', group: 'indicators', label: 'realized vol 20', unit: '%', desc: '20-bar rolling realized volatility, annualized', tags: ['volatility'] },
  // ── flow ───────────────────────────────────────────────────────────────────
  { id: 'delta', group: 'flow', label: 'delta', unit: 'base', desc: 'per-bar taker buy − sell', kinds: ['bars', 'histogram'], tags: ['flow'] },
  { id: 'cvd', group: 'flow', label: 'CVD', desc: 'cumulative volume delta', tags: ['flow'] },
  { id: 'buyShare', group: 'flow', label: 'buy share', unit: '0–1', desc: 'taker-buy share of volume per bar', tags: ['flow'] },
  { id: 'takerRatio', group: 'flow', label: 'taker buy ratio', unit: '0–1', desc: 'buyVolume / volume', tags: ['flow'] },
  // ── forecast ───────────────────────────────────────────────────────────────
  { id: 'forecastFan', group: 'forecast', label: 'conformal fan', unit: 'usd', desc: 'h-step conformal price forecast: point + widest-level band', kinds: ['band', 'line'], tags: ['forecast'], consumedBy: ['forecast view', 'order-flow chart overlay'] },
  // ── models ─────────────────────────────────────────────────────────────────
  { id: 'garchVolPath', group: 'models', label: 'GARCH σ path', desc: 'conditional per-bar vol — last 60 bars + h-step forecast', kinds: ['line', 'band'], tags: ['vol', 'model'], consumedBy: ['decision hub', 'vol edge'] },
  { id: 'hmmDecode', group: 'models', label: 'HMM regime decode', desc: 'Viterbi per-bar state (σ-ordered index)', kinds: ['step', 'band'], tags: ['regime', 'model'], consumedBy: ['decision hub', 'strategy ranking'] },
  { id: 'hmmDomProb', group: 'models', label: 'HMM dominant prob', unit: '0–1', desc: 'dominant-state filtered probability, final 120 bars', tags: ['regime', 'model'] },
  { id: 'kalmanLevel', group: 'models', label: 'Kalman level', unit: 'usd', desc: 'local-linear-trend filtered level', tags: ['trend', 'model'], consumedBy: ['decision hub'] },
  { id: 'mlPUp', group: 'models', label: 'ML P(up) OOS', unit: '0–1', desc: 'walk-forward out-of-sample P(next bar up)', kinds: ['line', 'band'], tags: ['ml', 'model'], consumedBy: ['decision hub', 'forecast cross-check'] },
  { id: 'mixedFan', group: 'models', label: 'mixed-MC fan', unit: 'usd', desc: 'mixed-process Monte Carlo price fan: q50 point + q05–q95 band', kinds: ['band', 'line'], tags: ['mc', 'model'], consumedBy: ['decision hub'] },
  // ── surfaces (matrix families) ─────────────────────────────────────────────
  { id: 'ivSurface', group: 'surfaces', label: 'IV surface', desc: 'IV by log-moneyness × tenor (matrix)', tags: ['iv', 'matrix'] },
  { id: 'gexSession', group: 'surfaces', label: 'GEX strike × time', desc: 'net dealer gamma per strike through time (matrix)', tags: ['gex', 'matrix'] },
  { id: 'fundingGrid', group: 'surfaces', label: 'funding heat', desc: '8h funding APR by asset × event (matrix)', tags: ['funding', 'matrix'] },
  { id: 'correlation', group: 'surfaces', label: 'correlation matrix', desc: 'asset × asset return correlation (matrix)', tags: ['correlation', 'matrix'] },
];

export const SERIES_MAP = new Map(SERIES_SPECS.map((s) => [s.id, s]));

export function seriesSpecOf(id: string): SeriesSpec | undefined {
  return SERIES_MAP.get(id);
}

// ── loaders ───────────────────────────────────────────────────────────────────

/** computeModelCore with a short cache so multiple series ids share one fit. */
function coreFor(bars: RawBar[], tf: number, key: string): ReturnType<typeof computeModelCore> | null {
  const hit = cfgCache.get(key);
  if (hit && Date.now() - hit.at < CORE_TTL) return hit.core;
  const core = computeModelCore(bars, { h: 24 });
  if (core) cfgCache.set(key, { at: Date.now(), core });
  return core;
}

function seriesOut(id: string, label: string, group: string, points: VizPoint[], provenance: string, extra: Partial<VizSeries> = {}): VizSeries {
  return { id, label, group, kind: 'points', points, provenance, builtAt: Date.now(), ...extra };
}

function toIndBars(bars: RawBar[]): IndBar[] {
  return bars.map((b) => ({ ts: b.ds, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, tb: b.buyVolume }));
}

const cfgCache = new Map<string, { at: number; core: ReturnType<typeof computeModelCore> }>();
const CORE_TTL = 30_000;

/**
 * Load ANY catalog series for (asset, tf). Pure consumers of the shared
 * merged-bar history; matrix families load their own family source.
 */
export async function loadVizSeries(id: string, asset: OfAsset, tf: number, backfill = 720): Promise<VizSeries> {
  const spec = SERIES_MAP.get(id);
  if (!spec) throw new Error(`unknown series: ${id}`);
  const cap = Math.max(60, Math.min(1500, backfill));

  const coreIds = ['ivSurface', 'gexSession', 'fundingGrid', 'correlation'];
  if (!coreIds.includes(id)) {
    const { bars, klineSource, klinesBars, engineCount } = await loadMergedBars(asset, tf, cap, { withKlines: true });
    const prov = `${klineSource} · ${klinesBars}+${engineCount} bars`;
    const indBars = toIndBars(bars);
    const closes = bars.map((b) => b.close);
    const ts = bars.map((b) => b.ds);
    const key = `${asset}|${tf}|${bars.length}|${bars.at(-1)?.ds ?? 0}`;
    const core = () => coreFor(bars, tf, key);

    switch (id) {
      case 'close':
        return seriesOut(id, spec.label, 'price', bars.map((b) => ({ t: b.ds, v: b.close, o: b.open, h: b.high, l: b.low, c: b.close })), prov, { unit: 'usd', domain: { lo: 0 } });
      case 'volume':
        return seriesOut(id, spec.label, 'price', bars.map((b) => ({ t: b.ds, v: b.volume })), prov);
      case 'buyVolume':
        return seriesOut(id, spec.label, 'price', bars.map((b) => ({ t: b.ds, v: b.buyVolume })), prov);
      case 'trades':
        return seriesOut(id, spec.label, 'price', bars.map((b) => ({ t: b.ds, v: b.trades })), prov);
      case 'rsi14':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, rsi(closes, 14)), prov, { domain: { lo: 0, hi: 100 } });
      case 'ema21':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, ema(closes, 21)), prov);
      case 'sma50':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, sma(closes, 50)), prov);
      case 'macdHist': {
        const m = macd(closes, 12, 26, 9);
        return seriesOut(id, spec.label, 'indicators', zipN(ts, m.hist), prov);
      }
      case 'bbPercentB': {
        const bb = bollinger(closes, 20, 2);
        return seriesOut(id, spec.label, 'indicators', zipN(ts, bb.pctB), prov);
      }
      case 'atr14':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, atr(indBars, 14)), prov);
      case 'stochK': {
        const st = stoch(indBars, 14, 3, 3);
        return seriesOut(id, spec.label, 'indicators', zipN(ts, st.k), prov, { domain: { lo: 0, hi: 100 } });
      }
      case 'adx':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, adx(indBars, 14).adx), prov);
      case 'obv':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, obv(indBars)), prov);
      case 'vwap':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, vwapAnchored(indBars)), prov);
      case 'hv20':
        return seriesOut(id, spec.label, 'indicators', zipN(ts, historicalVol(closes, 20, barsPerYearOf(tf))), prov);
      case 'delta':
        return seriesOut(id, spec.label, 'flow', zipN(ts, deltaPerBar(indBars)), prov);
      case 'cvd':
        return seriesOut(id, spec.label, 'flow', zipN(ts, cvd(indBars)), prov);
      case 'takerRatio':
        return seriesOut(id, spec.label, 'flow', zipN(ts, takerBuyRatio(indBars)), prov);
      case 'buyShare':
        return seriesOut(id, spec.label, 'flow', bars.map((b) => ({ t: b.ds, v: b.volume > 0 ? b.buyVolume / b.volume : Number.NaN })), prov, { domain: { lo: 0, hi: 1 } });
      case 'forecastFan': {
        const state = buildProjectedStateFromBars(bars, [], tf, { asset, h: 24, levels: [80, 95], nWindows: 40 });
        return seriesOut(
          id,
          spec.label,
          'forecast',
          state.price.rows.map((r) => ({ t: r.ds, v: r.point, lo: r.lo, hi: r.hi })),
          `conformal · ${state.price.primary}`,
          { unit: 'usd', note: state.price.note },
        );
      }
      case 'garchVolPath': {
        const c = core();
        if (!c?.garch) throw new Error('GARCH needs ≥60 usable bars');
        const tail = c.garch.volTail;
        const tailStart = bars.length - tail.length;
        const pts: VizPoint[] = tail.map((v, i) => ({ t: bars[Math.max(0, tailStart + i)]?.ds ?? Date.now(), v: v * Math.sqrt(barsPerYearOf(tf)) * 100 }));
        const fc = c.garchFc;
        if (fc) {
          const last = bars.at(-1)!;
          const stepMs = tf;
          for (let i = 0; i < fc.volPctAnnual.length; i++) {
            pts.push({ t: last.ds + stepMs * (i + 1), v: fc.volPctAnnual[i], lo: fc.longRunVolPctAnnual, hi: fc.longRunVolPctAnnual });
          }
        }
        return seriesOut(id, spec.label, 'models', pts, `${prov} · GARCH(1,1)`, { unit: '%', note: 'annualized σ — tail + forecast; long-run marked on the horizon' });
      }
      case 'hmmDecode': {
        const c = core();
        if (!c?.hmm) throw new Error('HMM needs more history');
        const path = c.hmm.path;
        const labels = c.hmm.states.map((s, i) => `${i}:${s.label}`).join(' ');
        return seriesOut(id, spec.label, 'models', path.map((st, i) => ({ t: bars[i]?.ds ?? i, v: st })), `${prov} · ${c.hmm.k} states`, { note: `state index — ${labels}` });
      }
      case 'hmmDomProb': {
        const c = core();
        if (!c?.hmm) throw new Error('HMM needs more history');
        const probs = c.hmm.probsTail;
        const start = bars.length - probs.length;
        const dom = probs.map((ps) => {
          let bi = 0;
          for (let i = 1; i < ps.length; i++) if (ps[i] > ps[bi]) bi = i;
          return ps[bi];
        });
        return seriesOut(id, spec.label, 'models', dom.map((v, i) => ({ t: bars[Math.max(0, start + i)]?.ds ?? i, v })), `${prov} · dominant-state probability`, { domain: { lo: 0, hi: 1 } });
      }
      case 'kalmanLevel': {
        const c = core();
        if (!c?.kalman) throw new Error('Kalman needs more history');
        return seriesOut(id, spec.label, 'models', c.kalman.level.map((v, i) => ({ t: bars[i]?.ds ?? i, v })), `${prov} · local-linear-trend`, { unit: 'usd' });
      }
      case 'mlPUp': {
        const c = core();
        if (!c?.ml) throw new Error('ML needs ≥60 bars (walk-forward)');
        const { marketFeatureMatrix, walkForwardPUp, logisticPredict } = await import('@/lib/models/ml');
        const fmatrix = marketFeatureMatrix(closes, { deltas: bars.map((b) => b.buyVolume - (b.volume - b.buyVolume)) });
        if (!fmatrix) throw new Error('ML feature matrix unavailable');
        const wf = walkForwardPUp(fmatrix, { trainFrac: 0.7 });
        if (!wf) throw new Error('walk-forward unavailable');
        const cut = Math.floor(fmatrix.x.length * 0.7);
        const lag = closes.length - fmatrix.x.length;
        const pts: VizPoint[] = [];
        for (let i = cut; i < fmatrix.x.length; i++) {
          pts.push({ t: bars[Math.min(bars.length - 1, i + lag)]?.ds ?? Date.now(), v: logisticPredict(wf.model, fmatrix.x[i]) });
        }
        return seriesOut(id, spec.label, 'models', pts, `${prov} · OOS tail ${pts.length} bars`, { domain: { lo: 0, hi: 1 }, note: `acc ${(c.ml.accuracy * 100).toFixed(1)}% · auc ${c.ml.auc?.toFixed(2) ?? '–'}` });
      }
      case 'mixedFan': {
        const c = core();
        if (!c?.fan) throw new Error('mixed MC needs more history');
        const last = bars.at(-1)!;
        const pts: VizPoint[] = [{ t: last.ds, v: c.spot, lo: c.spot, hi: c.spot }];
        for (const st of c.fan.steps) pts.push({ t: last.ds + tf * st.i, v: st.q50, lo: st.q05, hi: st.q95 });
        return seriesOut(id, spec.label, 'models', pts, `${prov} · ${c.fan.nPaths} paths`, { unit: 'usd', note: `P(up@h) ${(c.fan.terminal.pUp * 100).toFixed(0)}%` });
      }
      default:
        throw new Error(`series loader missing for ${id}`);
    }
  }

  // ── matrix families ─────────────────────────────────────────────────────────
  switch (id) {
    case 'ivSurface': {
      const { getChainSnapshot } = await import('@/lib/quant/engine');
      const symbol = asset === 'SOL' ? 'BTC' : asset;
      const snap = await getChainSnapshot(symbol);
      const fwd = snap.forwardFront || snap.spot;
      const matrix: VizMatrix = {
        rows: snap.heatmap.strikes.map((k) => `${(100 * Math.log(k / fwd)).toFixed(0)}% k`,),
        cols: snap.heatmap.expiries,
        values: snap.heatmap.iv.map((row) => row.map((v) => (v ?? 0) * 100)),
      };
      return { id, label: spec.label, group: 'surfaces', kind: 'matrix', matrix, provenance: `deribit · ${snap.heatmap.strikes.length} strikes × ${snap.heatmap.expiries.length} expiries`, builtAt: Date.now(), note: 'OTM-composite IV % by log-moneyness × expiry' };
    }
    case 'gexSession': {
      const symbol = asset === 'SOL' ? 'BTC' : asset;
      const sess = await getGexSession(symbol, 120);
      const matrix: VizMatrix = {
        rows: sess.strikes.map((s) => String(s)),
        cols: sess.times.map((c) => new Date(c).toISOString().slice(11, 16)),
        values: sess.netGex,
      };
      return { id, label: spec.label, group: 'surfaces', kind: 'matrix', matrix, provenance: sess.note, builtAt: Date.now(), note: sess.regime ? `regime: ${sess.regime}` : undefined };
    }
    case 'fundingGrid': {
      const grid = await fundingGrid('7d');
      const matrix: VizMatrix = {
        rows: grid.assets,
        cols: grid.times.map((t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ')),
        values: grid.aprPct.map((row) => row.map((v) => (v == null ? Number.NaN : v))),
      };
      return { id, label: spec.label, group: 'surfaces', kind: 'matrix', matrix, provenance: `${grid.source} · ${grid.venue}`, builtAt: grid.asOf, note: '8h funding APR % — rose longs pay' };
    }
    case 'correlation': {
      const corr = await marketCorrelation('30d');
      const matrix: VizMatrix = {
        rows: corr.assets,
        cols: corr.assets,
        values: corr.matrix.map((row) => row.map((v) => (v == null ? Number.NaN : v))),
      };
      return { id, label: spec.label, group: 'surfaces', kind: 'matrix', matrix, provenance: `${corr.source} · ${corr.barsUsed} bars`, builtAt: corr.asOf, note: corr.note };
    }
    default:
      throw new Error(`unknown matrix series ${id}`);
  }
}

/** zip timestamps with a nullable indicator series */
function zipN(ts: number[], values: (number | null)[]): VizPoint[] {
  const out: VizPoint[] = [];
  for (let i = 0; i < Math.min(ts.length, values.length); i++) {
    const v = values[i];
    out.push({ t: ts[i], v: v == null ? Number.NaN : v });
  }
  return out;
}

function barsPerYearOf(tf: number): number {
  const yearMs = 365 * 24 * 3_600_000;
  return yearMs / tf;
}
