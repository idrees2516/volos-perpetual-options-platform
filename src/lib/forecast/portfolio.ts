// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — forward-looking hedged portfolio risk
//
// "Past and future" in one readout:
//   PAST  — realized volatility + the full cross-asset correlation matrix from
//           each asset's own stored/backfilled flow-bar closes
//   FUTURE— conformal_error bands (the honest intervals) turned into a
//           forward σ per asset, then a Gaussian portfolio view:
//             • forward VaR / ES at 95% for the weighted book
//             • per-asset β vs BTC, hedge notional and residual risk after
//               the BTC hedge (the classic perp-hedge construction)
//             • a BTC ±1σ/±2σ scenario grid, hedged vs unhedged
//
// Every number is derived from the terminal's own live engine data — no
// look-ahead: bands condition only on the panel cutoff.
// ─────────────────────────────────────────────────────────────────────────────

import { buildForecastPanel } from '@/lib/forecast/panel';
import { Forecaster } from '@/lib/forecast/forecaster';
import { OF_ASSETS, isOfAsset } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';
import type { FcPoint } from '@/lib/forecast/types';

const Z80 = 1.2816; // two-sided 80% normal quantile
const Z95 = 1.6449;
const BACKFILL = 240; // ~4 h of 1-minute history at default tf

export interface PortfolioAssetRisk {
  asset: OfAsset;
  weight: number;
  last: number;
  // past
  realizedVolPctHorizon: number | null; // realized σ over the same horizon window
  betaVsBtc: number | null;
  corrBtc: number | null;
  // future (conformal)
  point: number | null;
  band80: [number, number] | null;
  band95: [number, number] | null;
  fwdSigmaPct: number | null; // σ implied by the 80% conformal band
  expMove80Pct: number | null;
  // book impact
  positionUsd: number;
  fwdVaR95Usd: number | null;
  hedgeUsd: number | null; // BTC notional to neutralize β
  residualVaR95Usd: number | null;
}

export interface PortfolioRiskPayload {
  h: number;
  tfSec: number;
  levels: number[];
  notionalUsd: number;
  assets: PortfolioAssetRisk[];
  // aligned closes used for the correlation matrix (per asset)
  closes: Array<{ asset: OfAsset; n: number; from: number; to: number }>;
  corr: Array<{ a: OfAsset; b: OfAsset; rho: number | null }>;
  portfolio: {
    fwdVaR95Usd: number | null;
    fwdEs95Usd: number | null;
    fwdVolPct: number | null;
    realizedVolPct: number | null;
    hedgeFwdVaR95Usd: number | null; // after full BTC-β hedge on every asset
  };
  scenarios: Array<{
    btcMove: string;
    btcPct: number;
    unhedgedPnlUsd: number;
    hedgedPnlUsd: number;
  }>;
  provenance: Record<string, unknown>;
  tsMs: number;
}

function logReturns(points: FcPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].y;
    if (!(prev > 0) || !(points[i].y > 0)) continue;
    out.push(Math.log(points[i].y / prev));
  }
  return out;
}

function std(xs: number[]): number | null {
  if (xs.length < 8) return null;
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let v = 0;
  for (const x of xs) v += (x - m) ** 2;
  return Math.sqrt(v / Math.max(1, xs.length - 1));
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** h-step horizon σ from 1-step returns: σ_h = σ_1 · √h */
function horizonSigma(returns1: number[], h: number): number | null {
  const s = std(returns1);
  return s === null ? null : s * Math.sqrt(h);
}

export interface PortfolioOpts {
  h: number;
  tfSec: number;
  levels: number[];
  weights?: Partial<Record<OfAsset, number>>;
  notionalUsd?: number;
  assets?: OfAsset[];
  nWindows?: number;
}

export async function buildPortfolioRisk(opts: PortfolioOpts): Promise<PortfolioRiskPayload> {
  const h = Math.max(1, Math.min(120, opts.h || 30));
  const tfSec = Math.max(60, Math.min(1800, opts.tfSec || 60));
  const levels = opts.levels?.length ? [...new Set(opts.levels)].sort((a, b) => a - b) : [80, 95];
  const notionalUsd = opts.notionalUsd && opts.notionalUsd > 0 ? opts.notionalUsd : 100_000;
  const assets = (opts.assets ?? OF_ASSETS).filter((a) => isOfAsset(a));
  const specs = [
    { alias: 'FlowX', model: 'flowx' as const, intervals: 'conformal_error' as const, nWindows: opts.nWindows ?? 10 },
    { alias: 'Ensemble', model: 'ensemble' as const, intervals: 'conformal_error' as const, nWindows: opts.nWindows ?? 10 },
  ];
  const forecaster = new Forecaster(specs);

  // per-asset panels + forecasts (parallel)
  const panels = await Promise.all(
    assets.map(async (asset) => ({
      asset,
      panel: await buildForecastPanel(asset, tfSec * 1000, 'close', { backfill: BACKFILL }),
    })),
  );
  const forecasts = panels.map(({ asset, panel }) => ({
    asset,
    panel,
    out: forecaster.forecast(panel, { h, levels, nWindows: opts.nWindows ?? 10 }),
  }));

  // weights: explicit or equal over available assets, normalized
  const explicit = opts.weights ?? {};
  const rawW = assets.map((a) => {
    const w = explicit[a];
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : assets.length ? 1 / assets.length : 0;
  });
  const wSum = rawW.reduce((s, w) => s + w, 0) || 1;
  const weights = new Map<OfAsset, number>(assets.map((a, i) => [a, rawW[i] / wSum]));

  // ── per-asset future bands + past stats ────────────────────────────────────
  const rows = new Map<OfAsset, PortfolioAssetRisk>();
  const returnsByAsset = new Map<OfAsset, number[]>();
  const closeSeriesByAsset = new Map<OfAsset, Map<number, number>>();
  const fwdSigmaByAsset = new Map<OfAsset, number>(); // fraction (per horizon)

  for (const { asset, panel, out } of forecasts) {
    const ens = out.primary.find((m) => m.alias === 'Ensemble');
    const lastRow = ens?.rows[ens.rows.length - 1] ?? null;
    const close = panel.series[0]?.points.at(-1)?.y ?? null;
    const bandFor = (lvl: number): [number, number] | null => {
      const l = lastRow?.levels.find((x) => x.level === lvl);
      return l && Number.isFinite(l.lo) && Number.isFinite(l.hi) ? [l.lo, l.hi] : null;
    };
    const b80 = bandFor(80);
    const b95 = bandFor(95);
    const point = lastRow?.point ?? null;
    const fwdSigma =
      b80 && point !== null && point > 0 ? (b80[1] - b80[0]) / (2 * Z80) / point : null;
    if (fwdSigma !== null) fwdSigmaByAsset.set(asset, fwdSigma);

    const points = panel.series[0]?.points ?? [];
    returnsByAsset.set(asset, logReturns(points));
    closeSeriesByAsset.set(
      asset,
      new Map(points.filter((p) => Number.isFinite(p.y)).map((p) => [p.ds, p.y])),
    );

    rows.set(asset, {
      asset,
      weight: weights.get(asset) ?? 0,
      last: close ?? NaN,
      realizedVolPctHorizon: null,
      betaVsBtc: null,
      corrBtc: null,
      point,
      band80: b80,
      band95: b95,
      fwdSigmaPct: fwdSigma !== null ? fwdSigma * 100 : null,
      expMove80Pct:
        b80 && point !== null && point > 0 ? ((b80[1] - b80[0]) / 2 / point) * 100 : null,
      positionUsd: (weights.get(asset) ?? 0) * notionalUsd,
      fwdVaR95Usd: null,
      hedgeUsd: null,
      residualVaR95Usd: null,
    });
  }

  // ── correlation matrix over aligned 1-step returns ─────────────────────────
  const dsSets = [...closeSeriesByAsset.values()].map((m) => [...m.keys()]);
  const common = dsSets.length
    ? dsSets.reduce((acc, keys) => {
        const s = new Set(keys);
        return acc.filter((t) => s.has(t));
      }, dsSets[0])
    : [];
  const alignedReturns = new Map<OfAsset, number[]>();
  for (const [asset, closes] of closeSeriesByAsset) {
    const rs: number[] = [];
    const sorted = common.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const p0 = closes.get(sorted[i - 1]);
      const p1 = closes.get(sorted[i]);
      if (p0 !== undefined && p1 !== undefined && p0 > 0 && p1 > 0) rs.push(Math.log(p1 / p0));
    }
    alignedReturns.set(asset, rs);
  }
  const corr: PortfolioRiskPayload['corr'] = [];
  for (const a of assets) {
    for (const b of assets) {
      const ra = alignedReturns.get(a) ?? [];
      const rb = alignedReturns.get(b) ?? [];
      corr.push({ a, b, rho: a === b ? 1 : pearson(ra, rb) });
    }
  }
  const rhoMap = new Map<string, number>();
  for (const c of corr) if (c.rho !== null) rhoMap.set(`${c.a}|${c.b}`, c.rho);

  // ── assemble per-asset rows (β, VaR, hedges) ──────────────────────────────
  const btcSigma = assets.includes('BTC') ? fwdSigmaByAsset.get('BTC') ?? null : null;
  for (const a of assets) {
    const row = rows.get(a)!;
    const ret1 = returnsByAsset.get(a) ?? [];
    row.realizedVolPctHorizon = (() => {
      const s = horizonSigma(ret1, h);
      return s === null ? null : s * 100;
    })();
    if (a === 'BTC') {
      row.betaVsBtc = 1;
      row.corrBtc = 1;
      row.hedgeUsd = row.positionUsd; // hedge itself 1:1
    } else {
      const rho = rhoMap.get(`${a}|BTC`) ?? null;
      const sigA = fwdSigmaByAsset.get(a) ?? null;
      row.corrBtc = rho;
      row.betaVsBtc = rho !== null && sigA !== null && btcSigma !== null && btcSigma > 0 ? (rho * sigA) / btcSigma : null;
      row.hedgeUsd = row.betaVsBtc !== null ? row.betaVsBtc * row.positionUsd : null;
    }
    row.fwdVaR95Usd = row.fwdSigmaPct !== null ? (row.fwdSigmaPct / 100) * Z95 * row.positionUsd : null;
    if (row.betaVsBtc !== null && row.fwdSigmaPct !== null) {
      const rho = row.corrBtc ?? 0;
      const resid = (row.fwdSigmaPct / 100) * Math.sqrt(Math.max(0, 1 - rho * rho));
      row.residualVaR95Usd = resid * Z95 * row.positionUsd;
    }
  }

  // ── portfolio-level forward VaR / ES (Gaussian with conformal σ, corr) ────
  let var95: number | null = null;
  let es95: number | null = null;
  let fwdVol: number | null = null;
  let hedgedVar95: number | null = null;
  {
    const sigmas = assets.map((a) => fwdSigmaByAsset.get(a) ?? null);
    if (sigmas.every((s) => s !== null)) {
      const wVec = assets.map((a) => weights.get(a) ?? 0);
      // covariance matrix from forward σ and the return correlation
      const cov = (i: number, j: number): number => {
        const rho = i === j ? 1 : rhoMap.get(`${assets[i]}|${assets[j]}`) ?? 0;
        return sigmas[i]! * sigmas[j]! * rho;
      };
      let variance = 0;
      for (let i = 0; i < assets.length; i++) {
        for (let j = 0; j < assets.length; j++) variance += wVec[i] * wVec[j] * cov(i, j);
      }
      fwdVol = Math.sqrt(Math.max(0, variance));
      var95 = fwdVol * Z95 * notionalUsd;
      // Gaussian ES at 95%: σ·φ(z)/α
      es95 = fwdVol * (Math.exp(-0.5 * Z95 * Z95) / Math.sqrt(2 * Math.PI) / 0.05) * notionalUsd;

      // hedged book: subtract each asset's β-to-BTC exposure from its weight
      // (short BTC perp notional Σ β·pos) — exact covariance form:
      //   hedged w' = w − (Σ w_i·β_i)·e_btc
      const btcIdx = assets.indexOf('BTC');
      if (btcIdx >= 0) {
        const hedgeScalar = assets.reduce(
          (acc, a, i) => acc + wVec[i] * (rows.get(a)?.betaVsBtc ?? 0),
          0,
        );
        const hedgedW = wVec.slice();
        hedgedW[btcIdx] -= hedgeScalar;
        let hv = 0;
        for (let i = 0; i < assets.length; i++) {
          for (let j = 0; j < assets.length; j++) hv += hedgedW[i] * hedgedW[j] * cov(i, j);
        }
        hedgedVar95 = Math.max(0, hv);
      }
    }
  }
  const realizedVolPct = (() => {
    // realized book vol with the same weights and correlations, 1-step σ·√h
    const sigmas = assets.map((a) => horizonSigma(returnsByAsset.get(a) ?? [], h));
    if (sigmas.some((s) => s === null)) return null;
    const wVec = assets.map((a) => weights.get(a) ?? 0);
    let variance = 0;
    for (let i = 0; i < assets.length; i++) {
      for (let j = 0; j < assets.length; j++) {
        const rho = i === j ? 1 : rhoMap.get(`${assets[i]}|${assets[j]}`) ?? 0;
        variance += wVec[i] * wVec[j] * (sigmas[i] as number) * (sigmas[j] as number) * rho;
      }
    }
    return Math.sqrt(Math.max(0, variance)) * 100;
  })();

  // ── BTC scenario grid (propagate through β), hedged vs unhedged ───────────
  const scenarios: PortfolioRiskPayload['scenarios'] = [];
  if (btcSigma !== null) {
    const hedgeLeg = assets.reduce((acc, a) => acc + (rows.get(a)?.hedgeUsd ?? 0), 0);
    for (const mult of [-2, -1, 1, 2]) {
      const rBtc = mult * btcSigma; // BTC return as a fraction
      const btcPct = rBtc * 100;
      let unhedged = 0;
      for (const a of assets) {
        const row = rows.get(a)!;
        const beta = row.betaVsBtc ?? 0;
        unhedged += beta * rBtc * row.positionUsd;
      }
      // the short-BTC hedge leg offsets exactly the β-driven part; what
      // remains is idiosyncratic (zero-mean) — see residual VaR per asset
      const hedged = unhedged - hedgeLeg * rBtc;
      scenarios.push({
        btcMove: `${mult > 0 ? '+' : ''}${mult}σ`,
        btcPct,
        unhedgedPnlUsd: unhedged,
        hedgedPnlUsd: hedged,
      });
    }
  }

  return {
    h,
    tfSec,
    levels,
    notionalUsd,
    assets: assets.map((a) => rows.get(a)!),
    closes: assets.map((a) => {
      const pts = closeSeriesByAsset.get(a);
      const keys = pts ? [...pts.keys()].sort((x, y) => x - y) : [];
      return { asset: a, n: keys.length, from: keys[0] ?? 0, to: keys.at(-1) ?? 0 };
    }),
    corr,
    portfolio: {
      fwdVaR95Usd: var95,
      fwdEs95Usd: es95,
      fwdVolPct: fwdVol !== null ? fwdVol * 100 : null,
      realizedVolPct,
      hedgeFwdVaR95Usd: hedgedVar95 !== null ? Math.sqrt(hedgedVar95) * Z95 * notionalUsd : null,
    },
    scenarios,
    provenance: Object.fromEntries(panels.map((p) => [p.asset, p.panel.provenance])),
    tsMs: Date.now(),
  };
}
