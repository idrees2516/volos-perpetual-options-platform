// ─────────────────────────────────────────────────────────────────────────────
// VIZ · model runner — ANY model from the room, on ANY series, in ONE place.
//
// The Model Studio's engine: every statistical/pricing model the product
// ships can be run here with user-set parameters on any catalog series
// (close, volume, RSI, funding… anything plottable). Stats models fit on the
// RETURNS of the chosen series; pricing models take direct params. Every run
// emits verdicts + chartable VizSeries outputs — which drop straight into the
// Chart Studio, closing the loop: any data → any model → any chart.
// ─────────────────────────────────────────────────────────────────────────────

import type { OfAsset } from '@/lib/orderflow/types';
import { loadVizSeries, SERIES_SPECS } from './series';
import { returnsOf, meanOf, sdOf, histogramOf } from './transforms';
import type { VizPoint, VizSeries } from './types';

export interface ParamSpec {
  name: string;
  label: string;
  type: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  def: number | string;
  options?: string[];
}

export interface ModelSpec {
  id: string;
  label: string;
  family: 'stats' | 'pricing' | 'mc' | 'risk';
  desc: string;
  /** series input: true = fits on a chosen series; false = pure params */
  usesSeries: boolean;
  params: ParamSpec[];
  outputs: { id: string; label: string; kind: string }[];
  consumedBy: string[];
}

export interface Verdict {
  label: string;
  value: string;
  tone?: 'teal' | 'rose' | 'amber' | 'zinc';
  sub?: string;
}

export interface ModelRunResult {
  model: string;
  label: string;
  input: { seriesId: string; seriesLabel: string; asset: string; tf: number; n: number; level: number };
  verdicts: Verdict[];
  outputs: VizSeries[];
  note?: string;
  builtAt: number;
}

export const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'garch',
    label: 'GARCH(1,1)',
    family: 'stats',
    desc: 'volatility clustering on the chosen series: fitted (ω, α, β), persistence, shock half-life, h-step σ forecast',
    usesSeries: true,
    params: [
      { name: 'h', label: 'horizon (bars)', type: 'number', def: 24, min: 4, max: 120, step: 1 },
    ],
    outputs: [
      { id: 'volPath', label: 'σ path + forecast', kind: 'points' },
      { id: 'longRun', label: 'long-run σ', kind: 'points' },
    ],
    consumedBy: ['decision hub · vol edge', 'forecast regime block', 'mixed-MC spec'],
  },
  {
    id: 'ou-kalman',
    label: 'OU + Kalman',
    family: 'stats',
    desc: 'mean-reversion stretch of the series + local-linear-trend filter: where the level is vs its anchor, trend z',
    usesSeries: true,
    params: [],
    outputs: [
      { id: 'kalman', label: 'Kalman level + slope', kind: 'points' },
      { id: 'ouMean', label: 'OU anchor ± stretch', kind: 'points' },
    ],
    consumedBy: ['decision hub · trend pillar', 'mean-reversion actions'],
  },
  {
    id: 'hmm',
    label: 'HMM regimes',
    family: 'stats',
    desc: 'k-state Gaussian hidden Markov on the series: Viterbi decode, filtered state probabilities, stationary mix',
    usesSeries: true,
    params: [
      { name: 'k', label: 'states', type: 'number', def: 3, min: 2, max: 5, step: 1 },
    ],
    outputs: [
      { id: 'decode', label: 'regime decode', kind: 'points' },
      { id: 'domProb', label: 'dominant probability', kind: 'points' },
    ],
    consumedBy: ['decision hub · regime conditioning', 'strategy ranking'],
  },
  {
    id: 'ml-pup',
    label: 'ML P(up)',
    family: 'stats',
    desc: 'walk-forward logistic classifier on the series\u2019 own momentum/RSI/vol features: out-of-sample P(next bar up)',
    usesSeries: true,
    params: [
      { name: 'trainFrac', label: 'train fraction', type: 'number', def: 0.7, min: 0.5, max: 0.9, step: 0.05 },
    ],
    outputs: [{ id: 'pUpPath', label: 'OOS P(up) path', kind: 'points' }],
    consumedBy: ['decision hub · model pillar', 'forecast cross-check'],
  },
  {
    id: 'merton',
    label: 'Merton jumps',
    family: 'stats',
    desc: 'jump-diffusion calibration from the realized tails of the series: λ, jump mean/σ, tail mass vs Gaussian',
    usesSeries: true,
    params: [],
    outputs: [
      { id: 'density', label: 'mixture vs gaussian density', kind: 'points' },
      { id: 'tailHist', label: 'return distribution', kind: 'points' },
    ],
    consumedBy: ['decision hub · tail pillar', 'mixed-MC jump leg'],
  },
  {
    id: 'mixed-mc',
    label: 'Mixed-process MC',
    family: 'mc',
    desc: 'the deep one: drift + GARCH vol clustering + Merton jumps + OU pull combined in one Monte Carlo fan',
    usesSeries: true,
    params: [
      { name: 'h', label: 'horizon (bars)', type: 'number', def: 24, min: 4, max: 120, step: 1 },
      { name: 'paths', label: 'paths', type: 'number', def: 2400, min: 400, max: 8000, step: 200 },
      { name: 'seed', label: 'seed', type: 'number', def: 7, min: 1, max: 999, step: 1 },
    ],
    outputs: [{ id: 'fan', label: 'price fan q05–q95', kind: 'points' }],
    consumedBy: ['decision hub · stance', 'P(up) 3-way cross-check'],
  },
  {
    id: 'kelly-cvar',
    label: 'Kelly / CVaR',
    family: 'risk',
    desc: 'growth-optimal fraction on the series: the g(f) curve with the Kelly cliff, VaR/CVaR/drawdown of full Kelly',
    usesSeries: true,
    params: [
      { name: 'bound', label: 'max fraction', type: 'number', def: 1, min: 0.25, max: 2, step: 0.25 },
    ],
    outputs: [{ id: 'gcurve', label: 'g(f) growth curve', kind: 'points' }],
    consumedBy: ['decision hub · risk block', 'autopilot half-Kelly sizing'],
  },
  {
    id: 'conformal',
    label: 'Conformal forecast',
    family: 'stats',
    desc: 'distribution-free h-step bands on ANY series: empirical h-step climatology + conformal residual quantiles',
    usesSeries: true,
    params: [
      { name: 'h', label: 'horizon (bars)', type: 'number', def: 24, min: 4, max: 120, step: 1 },
      { name: 'level', label: 'level %', type: 'number', def: 80, min: 50, max: 99, step: 1 },
    ],
    outputs: [{ id: 'fan', label: 'conformal fan', kind: 'points' }],
    consumedBy: ['forecast stack (price)', 'this studio extends it to any series'],
  },
  {
    id: 'bs-price',
    label: 'Black–Scholes',
    family: 'pricing',
    desc: 'the closed form: price + every greek, plotted over a spot grid with the payoff',
    usesSeries: false,
    params: [
      { name: 'S', label: 'spot', type: 'number', def: 100, min: 1, max: 200, step: 1 },
      { name: 'K', label: 'strike', type: 'number', def: 100, min: 1, max: 200, step: 1 },
      { name: 'T', label: 'years', type: 'number', def: 0.1, min: 0.005, max: 2, step: 0.005 },
      { name: 'r', label: 'rate', type: 'number', def: 0.04, min: 0, max: 0.15, step: 0.005 },
      { name: 'q', label: 'carry', type: 'number', def: 0, min: -0.05, max: 0.15, step: 0.005 },
      { name: 'sigma', label: 'σ', type: 'number', def: 0.45, min: 0.05, max: 2, step: 0.05 },
      { name: 'call', label: 'type', type: 'select', def: 'call', options: ['call', 'put'] },
    ],
    outputs: [
      { id: 'priceVsSpot', label: 'price vs spot', kind: 'points' },
      { id: 'payoff', label: 'payoff at expiry', kind: 'points' },
    ],
    consumedBy: ['131-strategy catalog pricing', 'greeks atlas', 'mental models lab'],
  },
  {
    id: 'heston',
    label: 'Heston smile',
    family: 'pricing',
    desc: 'stochastic-vol European pricing via the characteristic function (the little Heston trap) → the implied smile it produces',
    usesSeries: false,
    params: [
      { name: 'S', label: 'spot', type: 'number', def: 100, min: 1, max: 200, step: 1 },
      { name: 'T', label: 'years', type: 'number', def: 0.25, min: 0.01, max: 2, step: 0.01 },
      { name: 'v0', label: 'v₀', type: 'number', def: 0.09, min: 0.0025, max: 0.25, step: 0.0025 },
      { name: 'kappa', label: 'κ', type: 'number', def: 2.5, min: 0.2, max: 10, step: 0.1 },
      { name: 'theta', label: 'θ', type: 'number', def: 0.06, min: 0.0025, max: 0.25, step: 0.0025 },
      { name: 'xi', label: 'ξ vol-of-vol', type: 'number', def: 0.8, min: 0.05, max: 2, step: 0.05 },
      { name: 'rho', label: 'ρ', type: 'number', def: -0.6, min: -0.99, max: 0.99, step: 0.05 },
    ],
    outputs: [{ id: 'smile', label: 'Heston implied smile', kind: 'points' }],
    consumedBy: ['mental models lab · vol surface', 'decision hub models suite'],
  },
  {
    id: 'sabr',
    label: 'SABR smile',
    family: 'pricing',
    desc: 'Hagan\u2019s β=1 asymptotic smile — the desk standard for skew/curvature in one formula',
    usesSeries: false,
    params: [
      { name: 'F', label: 'forward', type: 'number', def: 100, min: 1, max: 200, step: 1 },
      { name: 'T', label: 'years', type: 'number', def: 0.25, min: 0.01, max: 2, step: 0.01 },
      { name: 'alpha', label: 'α', type: 'number', def: 0.45, min: 0.05, max: 1.5, step: 0.05 },
      { name: 'rho', label: 'ρ', type: 'number', def: -0.5, min: -0.99, max: 0.99, step: 0.05 },
      { name: 'nu', label: 'ν', type: 'number', def: 0.8, min: 0.05, max: 2, step: 0.05 },
    ],
    outputs: [{ id: 'smile', label: 'SABR implied smile', kind: 'points' }],
    consumedBy: ['vol surface calibration', 'decision hub models suite'],
  },
];

export const MODEL_MAP = new Map(MODEL_SPECS.map((m) => [m.id, m]));

// ── the runner ───────────────────────────────────────────────────────────────

const TFS: Record<number, string> = { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m' };

function out(id: string, label: string, points: VizPoint[], note?: string, unit?: string): VizSeries {
  return { id: `${id}`, label, group: 'model-output', kind: 'points', points, provenance: 'model studio run', builtAt: Date.now(), note, unit };
}

/**
 * Run ANY model on ANY series (or with pure params for pricing models).
 * Stats models fit on the chosen series' returns — RSI, funding, volume…
 * anything in the catalog becomes modelable data.
 */
export async function runModel(req: {
  model: string;
  asset: OfAsset;
  tf: number;
  backfill?: number;
  seriesId?: string;
  params?: Record<string, number | string>;
}): Promise<ModelRunResult> {
  const spec = MODEL_MAP.get(req.model);
  if (!spec) throw new Error(`unknown model: ${req.model}`);
  const p = req.params ?? {};
  const num = (name: string, def: number): number => {
    const v = p[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const str = (name: string, def: string): string => (typeof p[name] === 'string' ? (p[name] as string) : def);
  const tf = req.tf;
  const barsPerYear = (365 * 24 * 3_600_000) / tf;

  // ── pricing models: pure params, no series load ─────────────────────────────
  if (spec.family === 'pricing') {
    return runPricingModel(spec, { num, str });
  }

  // ── stats models: load the chosen series ────────────────────────────────────
  const seriesId = req.seriesId ?? 'close';
  const s = SERIES_SPECS.find((x) => x.id === seriesId) ?? { id: seriesId, group: 'model', label: seriesId, desc: '', tags: [] };
  const vs = await loadVizSeries(seriesId, req.asset, tf, req.backfill ?? 720);
  if (!vs.points || vs.points.length < 40) throw new Error(`series ${seriesId} has < 40 usable points`);
  const pts = vs.points;
  const levels = pts.map((x) => x.v).filter(Number.isFinite);
  const rets = returnsOf(pts.map((x) => x.v).filter((v) => Number.isFinite(v)));
  const levelNow = levels.at(-1) ?? 0;
  const input = { seriesId, seriesLabel: vs.label, asset: req.asset, tf, n: levels.length, level: levelNow };

  switch (req.model) {
    case 'garch': {
      const { fitGarch, garchForecast } = await import('@/lib/models/timeseries');
      const h = num('h', 24);
      const fit = fitGarch(rets, { barsPerYear });
      if (!fit) throw new Error('GARCH fit unavailable (degenerate returns)');
      const fc = garchForecast(fit, rets.at(-1) ?? 0, h);
      const toPct = (v: number) => v * Math.sqrt(barsPerYear) * 100;
      const tailPts: VizPoint[] = fit.volTail.map((v, i) => ({ t: i, v: toPct(v) }));
      const horizonPts: VizPoint[] = fc.volPctAnnual.map((v, i) => ({ t: fit.volTail.length + i, v }));
      const volPath: VizPoint[] = [
        ...tailPts.map((x, i) => ({ t: pts[Math.max(0, pts.length - fit.volTail.length + i)]?.t ?? x.t, v: x.v })),
        ...horizonPts.map((x, i) => ({ t: (pts.at(-1)?.t ?? 0) + tf * (i + 1), v: x.v })),
      ];
      const longRun: VizPoint[] = volPath.map((x) => ({ t: x.t, v: fit.longRunVol * Math.sqrt(barsPerYear) * 100 }));
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'σ now', value: `${toPct(fit.currentVol).toFixed(1)}%`, tone: 'zinc' },
          { label: `σ +${h}`, value: `${(fc.volPctAnnual.at(-1) ?? toPct(fit.currentVol)).toFixed(1)}%`, tone: 'teal' },
          { label: 'long-run σ', value: `${toPct(fit.longRunVol).toFixed(1)}%`, tone: 'amber' },
          { label: 'persistence α+β', value: fit.persistence.toFixed(3), sub: `shock half-life ${fit.shockHalfLifeBars ? fit.shockHalfLifeBars.toFixed(0) : '–'} bars` },
          { label: 'α / β', value: `${fit.alpha.toFixed(3)} / ${fit.beta.toFixed(3)}` },
        ],
        outputs: [
          out(`${spec.id}:volPath`, `${vs.label} · GARCH σ %`, volPath, 'annualized conditional σ — history tail + h-step forecast', '%'),
          out(`${spec.id}:longRun`, 'long-run σ', longRun, undefined, '%'),
        ],
        note: `fit on ${rets.length} returns of ${vs.label}`,
        builtAt: Date.now(),
      };
    }
    case 'ou-kalman': {
      const { fitOu, ouStretch, kalmanTrend, kalmanVerdict } = await import('@/lib/models/timeseries');
      const kalman = kalmanTrend(levels, { atr: null });
      if (!kalman) throw new Error('Kalman unavailable');
      const ou = fitOu(levels);
      const kv = kalmanVerdict(kalman, sdOf(rets) || 1e-9);
      const kalmanPts: VizPoint[] = kalman.level.map((v, i) => ({ t: pts[i]?.t ?? i, v }));
      let ouPts: VizPoint[] = [];
      if (ou) {
        const st = ouStretch(ou, levelNow);
        const band = sdOf(rets) * 4;
        ouPts = [
          { t: pts[0]?.t ?? 0, v: ou.theta, lo: ou.theta - band, hi: ou.theta + band },
          { t: pts.at(-1)?.t ?? 1, v: ou.theta, lo: ou.theta - band, hi: ou.theta + band },
        ];
        return {
          model: spec.id, label: spec.label, input,
          verdicts: [
            { label: 'OU anchor θ', value: ou.theta.toFixed(2), tone: 'teal' },
            { label: 'stretch z', value: st ? st.z.toFixed(2) : '–', tone: Math.abs(st?.z ?? 0) > 2 ? 'rose' : 'zinc', sub: st ? `expected decay ${st.expectedDecayBars.filter((x) => Number.isFinite(x)).map((x) => x.toFixed(0)).join('/')} bars` : undefined },
            { label: 'Kalman trend', value: kv.label, tone: kv.label === 'UP' ? 'teal' : kv.label === 'DOWN' ? 'rose' : 'zinc', sub: `z ${kv.z.toFixed(2)} · stability ${(kv.stability * 100).toFixed(0)}%` },
            { label: 'κ per bar', value: ou.kappaPerBar.toExponential(2), sub: `half-life ${ou.halfLifeBars != null ? ou.halfLifeBars.toFixed(0) : '–'} bars` },
          ],
          outputs: [
            out(`${spec.id}:kalman`, `${vs.label} · Kalman level`, kalmanPts, 'local-linear-trend filter level'),
            out(`${spec.id}:ouMean`, 'OU anchor ± 4σ', ouPts, 'the mean-reversion magnet'),
          ],
          note: `level ${levelNow.toFixed(2)} vs anchor ${ou.theta.toFixed(2)}`,
          builtAt: Date.now(),
        };
      }
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'Kalman trend', value: kv.label, tone: kv.label === 'UP' ? 'teal' : kv.label === 'DOWN' ? 'rose' : 'zinc', sub: `z ${kv.z.toFixed(2)} · stability ${(kv.stability * 100).toFixed(0)}%` },
          { label: 'slope / bar', value: kalman.currentSlope.toExponential(2) },
        ],
        outputs: [out(`${spec.id}:kalman`, `${vs.label} · Kalman level`, kalmanPts, 'local-linear-trend filter level')],
        builtAt: Date.now(),
      };
    }
    case 'hmm': {
      const { fitHmm, hmmRegime } = await import('@/lib/models/regimes');
      const k = Math.round(num('k', 3));
      const fit = fitHmm(rets, { k });
      if (!fit) throw new Error('HMM fit unavailable');
      const reg = hmmRegime(fit);
      const decodePts: VizPoint[] = fit.path.map((st, i) => ({ t: pts[i]?.t ?? i, v: st }));
      const domPts: VizPoint[] = fit.probsTail.map((ps, i) => {
        let bi = 0;
        for (let j = 1; j < ps.length; j++) if (ps[j] > ps[bi]) bi = j;
        return { t: pts[Math.max(0, pts.length - fit.probsTail.length + i)]?.t ?? i, v: ps[bi] };
      });
      const labels = fit.states.map((s, i) => `${i}:${s.label} ${(s.stationaryProb * 100).toFixed(0)}%`).join(' · ');
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'regime now', value: reg ? reg.label.toUpperCase() : '–', tone: reg?.regimeScore > 0 ? 'teal' : 'rose', sub: reg ? `prob ${(reg.prob * 100).toFixed(0)}% · E[dur] ${reg.expectedDurationBars.toFixed(0)} bars` : undefined },
          { label: 'states', value: labels },
          { label: 'converged', value: fit.converged ? `yes · ${fit.iterations} iters` : `${fit.iterations} iters` },
        ],
        outputs: [
          out(`${spec.id}:decode`, `${vs.label} · HMM decode`, decodePts, 'Viterbi per-bar state index (σ-ordered)'),
          out(`${spec.id}:domProb`, `${vs.label} · dominant prob`, domPts, undefined, '0–1'),
        ],
        note: `k=${k} on ${rets.length} returns`,
        builtAt: Date.now(),
      };
    }
    case 'ml-pup': {
      const { marketFeatureMatrix, walkForwardPUp, logisticPredict } = await import('@/lib/models/ml');
      const trainFrac = num('trainFrac', 0.7);
      const fm = marketFeatureMatrix(levels);
      if (!fm) throw new Error('feature matrix unavailable');
      const wf = walkForwardPUp(fm, { trainFrac });
      if (!wf) throw new Error('walk-forward unavailable');
      const cut = Math.floor(fm.x.length * trainFrac);
      const lag = levels.length - fm.x.length;
      const pUpPts: VizPoint[] = [];
      for (let i = cut; i < fm.x.length; i++) {
        pUpPts.push({ t: pts[Math.min(pts.length - 1, i + lag)]?.t ?? i, v: logisticPredict(wf.model, fm.x[i]) });
      }
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'accuracy', value: `${(wf.metrics.accuracy * 100).toFixed(1)}%`, tone: wf.metrics.accuracy > 0.55 ? 'teal' : 'zinc', sub: `train ${cut} · test ${fm.x.length - cut}` },
          { label: 'AUC', value: wf.metrics.auc != null ? wf.metrics.auc.toFixed(3) : '–', tone: (wf.metrics.auc ?? 0) > 0.58 ? 'teal' : 'zinc' },
          { label: 'log-loss', value: wf.metrics.logLoss != null ? wf.metrics.logLoss.toFixed(3) : '–' },
          { label: 'P(up) now', value: `${(logisticPredict(wf.model, fm.x.at(-1)!) * 100).toFixed(1)}%`, tone: 'amber' },
        ],
        outputs: [out(`${spec.id}:pUpPath`, `${vs.label} · OOS P(up)`, pUpPts, 'walk-forward out-of-sample path — no look-ahead', '0–1')],
        note: `features: ${fm.featureNames.join(', ')}`,
        builtAt: Date.now(),
      };
    }
    case 'merton': {
      const { calibrateMerton, jumpTailMass } = await import('@/lib/models/stochastic');
      const cal = calibrateMerton(rets, { barsPerYear });
      const sigma = sdOf(rets) || 1e-9;
      const tm = jumpTailMass(cal.params, sigma, 1, 3);
      // density comparison over a ±5σ grid at horizon of one bar
      const T = 1 / barsPerYear;
      const drift = meanOf(rets);
      const gridPts: VizPoint[] = [];
      const grid = Array.from({ length: 61 }, (_, i) => -5 * sigma + (10 * sigma * i) / 60);
      const mertonPdf = (x: number): number => {
        const lambdaT = cal.params.lambda * T;
        let f = 0;
        for (let n = 0; n <= 4; n++) {
          const w = (Math.exp(-lambdaT) * lambdaT ** n) / factorial(n);
          const m = drift + n * cal.params.muJ;
          const s = Math.sqrt(sigma * sigma + n * cal.params.sigmaJ * cal.params.sigmaJ);
          f += (w / (s * Math.sqrt(2 * Math.PI))) * Math.exp(-((x - m) ** 2) / (2 * s * s));
        }
        return f;
      };
      const gaussPdf = (x: number): number => (Math.exp(-((x - drift) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI)));
      for (const x of grid) gridPts.push({ t: Math.round(x / (sigma || 1e-9)), v: mertonPdf(x), lo: gaussPdf(x), hi: gaussPdf(x) });
      const bins = histogramOf(rets, 48);
      const histPts: VizPoint[] = bins.map((b) => ({ t: Math.round((b.x0 + b.x1) / 2 / (sigma || 1e-9)), v: b.count }));
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'λ / yr', value: cal.params.lambda.toFixed(1), tone: cal.params.lambda > 3 ? 'rose' : 'zinc', sub: `${cal.tailCount} tails in ${rets.length} bars (${(cal.tailShare * 100).toFixed(1)}%)` },
          { label: 'jump μ / σ', value: `${cal.params.muJ.toFixed(4)} / ${cal.params.sigmaJ.toFixed(4)}` },
          { label: 'P(|r| > 3σ)', value: `${(tm.merton * 100).toFixed(1)}%`, tone: 'rose', sub: `gaussian would say ${(tm.gaussian * 100).toFixed(1)}%` },
          { label: 'excess tail mass', value: `${(tm.merton - tm.gaussian >= 0 ? '+' : '') + ((tm.merton - tm.gaussian) * 100).toFixed(1)} pts` },
        ],
        outputs: [
          out(`${spec.id}:density`, 'mixture vs gaussian', gridPts, 'band = gaussian; line = Merton mixture (x in σ units)'),
          out(`${spec.id}:tailHist`, 'return distribution', histPts, 'empirical histogram (x in σ units)'),
        ],
        note: 'tails are 4σ departures from the mean',
        builtAt: Date.now(),
      };
    }
    case 'mixed-mc': {
      const { fitGarch } = await import('@/lib/models/timeseries');
      const { calibrateMerton } = await import('@/lib/models/stochastic');
      const { fitOu } = await import('@/lib/models/timeseries');
      const { mixedModelFan, mixedSpecFromFits } = await import('@/lib/models/mcfan');
      const h = Math.round(num('h', 24));
      const paths = Math.round(num('paths', 2400));
      const seed = Math.round(num('seed', 7));
      const garch = fitGarch(rets, { barsPerYear });
      const merton = calibrateMerton(rets, { barsPerYear });
      const ou = fitOu(levels);
      const drift = meanOf(rets);
      const mSpec = mixedSpecFromFits({
        drift,
        garch,
        lastReturn: rets.at(-1) ?? 0,
        merton: merton.params.lambda > 0 ? merton.params : null,
        ou: ou ? { kappaPerBar: ou.kappaPerBar, theta: ou.theta, strength: Math.min(0.5, ou.kappaPerBar * 8) } : null,
        barsPerYear,
      });
      const fan = mixedModelFan(seed, paths, levelNow, h, tf / (365 * 24 * 3_600_000), mSpec);
      const fanPts: VizPoint[] = [{ t: pts.at(-1)?.t ?? 0, v: levelNow, lo: levelNow, hi: levelNow }];
      for (const st of fan.steps) fanPts.push({ t: (pts.at(-1)?.t ?? 0) + tf * st.i, v: st.q50, lo: st.q05, hi: st.q95 });
      const emPct = ((fan.steps.at(-1)?.q50 ?? levelNow) - levelNow) / levelNow * 100;
      const term = fan.terminal;
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: `point +${h}`, value: `${fan.steps.at(-1)?.q50.toFixed(2)} (${emPct >= 0 ? '+' : ''}${emPct.toFixed(2)}%)`, tone: emPct >= 0 ? 'teal' : 'rose' },
          { label: `q05–q95`, value: `${fan.steps.at(-1)?.q05.toFixed(1)} … ${fan.steps.at(-1)?.q95.toFixed(1)}`, sub: `width ${(((fan.steps.at(-1)?.q95 ?? 0) - (fan.steps.at(-1)?.q05 ?? 0)) / levelNow * 100).toFixed(2)}%` },
          { label: 'P(up @ h)', value: `${(term.pUp * 100).toFixed(0)}%`, tone: term.pUp > 0.55 ? 'teal' : term.pUp < 0.45 ? 'rose' : 'zinc' },
          { label: 'legs', value: [garch ? 'GARCH' : null, mSpec.merton ? 'jumps' : null, mSpec.heston ? 'Heston-σ' : null, mSpec.ou ? 'OU' : null].filter(Boolean).join(' + ') || 'base vol', sub: `${paths} paths · seed ${seed}` },
        ],
        outputs: [out(`${spec.id}:fan`, `${vs.label} · mixed fan`, fanPts, 'q50 line with q05–q95 band')],
        note: 'drift + GARCH + jumps + OU combined in one simulator',
        builtAt: Date.now(),
      };
    }
    case 'kelly-cvar': {
      const { kellyFraction, kellyGrowth, tailRisk, drawdown } = await import('@/lib/models/portfolio');
      const bound = num('bound', 1);
      const kel = kellyFraction(rets, bound);
      if (!kel) throw new Error('Kelly unavailable (degenerate returns)');
      const gPts: VizPoint[] = [];
      for (let i = 0; i <= 80; i++) {
        const f = (bound * 2 * i) / 80;
        gPts.push({ t: Math.round(f * 100), v: kellyGrowth(rets, f) * barsPerYear * 100 });
      }
      const tr = tailRisk(rets, 0.95);
      const dd = drawdown(rets);
      const half = kel.fHalf;
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: 'full Kelly f*', value: `${(kel.f * 100).toFixed(1)}%`, tone: kel.f <= 0 ? 'rose' : 'teal', sub: `g(f*) ${(kel.growth * 100).toFixed(3)}%/bar · continuous ${kel.fContinuous != null ? `${(kel.fContinuous * 100).toFixed(1)}%` : '–'}` },
          { label: 'half Kelly', value: `${(half * 100).toFixed(1)}%`, tone: 'amber', sub: 'the desk size — the autopilot caps scale-ins here' },
          { label: 'VaR 95 / CVaR 95', value: tr ? `${(tr.varHist * 100).toFixed(2)}% / ${(tr.cvarHist * 100).toFixed(2)}%` : '–', tone: 'rose' },
          { label: 'max drawdown', value: `${(dd.maxDd * 100).toFixed(1)}%`, sub: `current ${dd.currentDd >= 0 ? '+' : ''}${(dd.currentDd * 100).toFixed(2)}% · ${dd.barsSincePeak} bars since peak` },
        ],
        outputs: [out(`${spec.id}:gcurve`, `${vs.label} · g(f) %/yr`, gPts, 'x = allocation % — the Kelly cliff past the peak')],
        note: 'f* > 0 means the series has positive drift to harvest',
        builtAt: Date.now(),
      };
    }
    case 'conformal': {
      const h = Math.round(num('h', 24));
      const level = num('level', 80);
      const vals = pts.map((x) => x.v).filter(Number.isFinite);
      const hs: number[] = [];
      const moves: number[] = [];
      for (let i = 0; i + h < vals.length; i++) {
        hs.push(vals[i + h] - vals[i]);
        moves.push(Math.sign(vals[i + h] - vals[i]));
      }
      if (hs.length < 30) throw new Error('not enough history for conformal calibration');
      const sorted = [...hs].sort((a, b) => a - b);
      const alpha = (100 - level) / 200;
      const loQ = sorted[Math.floor(sorted.length * alpha)] ?? sorted[0];
      const hiQ = sorted[Math.floor(sorted.length * (1 - alpha))] ?? sorted.at(-1)!;
      const pUp = moves.filter((m) => m > 0).length / moves.length;
      const base = vals.at(-1)!;
      const fanPts: VizPoint[] = [{ t: pts.at(-1)?.t ?? 0, v: base, lo: base, hi: base }];
      for (let i = 1; i <= h; i++) {
        // the band widens √i (random-walk scaling of the empirical quantiles)
        const w = Math.sqrt(i / h);
        fanPts.push({ t: (pts.at(-1)?.t ?? 0) + tf * i, v: base + (loQ + hiQ) / 2 * w, lo: base + loQ * w, hi: base + hiQ * w });
      }
      const expMove = (Math.abs(loQ) + Math.abs(hiQ)) / 2 / base * 100;
      return {
        model: spec.id, label: spec.label, input,
        verdicts: [
          { label: `P(up +${h})`, value: `${(pUp * 100).toFixed(0)}%`, tone: pUp > 0.55 ? 'teal' : pUp < 0.45 ? 'rose' : 'zinc' },
          { label: `${level}% band @ ${h}`, value: `${(base + loQ).toFixed(2)} … ${(base + hiQ).toFixed(2)}`, sub: `expected move ±${expMove.toFixed(2)}%` },
          { label: 'calibration windows', value: `${hs.length}`, sub: 'empirical h-step moves' },
          { label: 'method', value: 'climatology + √h scaling', tone: 'amber' },
        ],
        outputs: [out(`${spec.id}:fan`, `${vs.label} · conformal fan`, fanPts, `point line with ${level}% band`)],
        note: 'the forecast stack runs this on price; the studio runs it on anything',
        builtAt: Date.now(),
      };
    }
    default:
      throw new Error(`no runner for ${req.model}`);
  }
}

// ── pricing models ────────────────────────────────────────────────────────────

async function runPricingModel(spec: ModelSpec, fns: { num: (n: string, d: number) => number; str: (n: string, d: string) => string }): Promise<ModelRunResult> {
  const { num, str } = fns;
  const base = { model: spec.id, label: spec.label, input: { seriesId: 'params', seriesLabel: 'direct parameters', asset: '—', tf: 0, n: 0, level: 0 }, builtAt: Date.now() };
  switch (spec.id) {
    case 'bs-price': {
      const { bsPrice, delta, gamma, vega, theta } = await import('@/lib/models/bs');
      const S = num('S', 100), K = num('K', 100), T = num('T', 0.1), r = num('r', 0.04), q = num('q', 0), sigma = num('sigma', 0.45);
      const call = str('call', 'call') === 'call';
      const price = bsPrice(call, S, K, T, r, q, sigma);
      const grid = Array.from({ length: 61 }, (_, i) => Math.max(1, S * 0.6 + (S * 0.8 * i) / 60));
      const pricePts: VizPoint[] = grid.map((s) => ({ t: Math.round(s), v: bsPrice(call, s, K, T, r, q, sigma) }));
      const payoffPts: VizPoint[] = grid.map((s) => ({ t: Math.round(s), v: call ? Math.max(s - K, 0) : Math.max(K - s, 0) }));
      return {
        ...base,
        verdicts: [
          { label: 'price', value: price.toFixed(4), tone: 'teal', sub: `${call ? 'call' : 'put'} · K ${K} · T ${T.toFixed(3)}y` },
          { label: 'delta / gamma', value: `${delta(call, S, K, T, r, q, sigma).toFixed(3)} / ${gamma(S, K, T, r, q, sigma).toFixed(5)}` },
          { label: 'vega', value: vega(S, K, T, r, q, sigma).toFixed(3) },
          { label: 'theta / day', value: theta(call, S, K, T, r, q, sigma).toFixed(4) },
          { label: 'moneyness', value: `${(100 * S / K - 100).toFixed(1)}% ${S > K ? (call ? 'ITM' : 'OTM') : call ? 'OTM' : 'ITM'}` },
        ],
        outputs: [
          out(`${spec.id}:priceVsSpot`, `${call ? 'call' : 'put'} price vs spot`, pricePts, 'x = spot', 'usd'),
          out(`${spec.id}:payoff`, 'payoff at expiry', payoffPts, 'x = spot', 'usd'),
        ],
      };
    }
    case 'heston': {
      const { hestonSmile, hestonPrice } = await import('@/lib/models/stochastic');
      const S = num('S', 100), T = num('T', 0.25);
      const p = { v0: num('v0', 0.09), kappa: num('kappa', 2.5), theta: num('theta', 0.06), xi: num('xi', 0.8), rho: num('rho', -0.6) };
      const moneyness = Array.from({ length: 25 }, (_, i) => 0.8 + (0.4 * i) / 24);
      const smile = hestonSmile(S, T, 0.04, 0, p, moneyness);
      const smilePts: VizPoint[] = smile.map((row) => ({ t: Math.round(row.k * 1000) / 10, v: row.iv * 100 }));
      const atm = hestonPrice(true, S, S, T, 0.04, 0, p);
      return {
        ...base,
        verdicts: [
          { label: 'ATM price', value: atm.price.toFixed(4), tone: 'teal', sub: `${atm.nPoints} CF grid points` },
          { label: 'v₀ / θ', value: `${(Math.sqrt(p.v0) * 100).toFixed(1)}% / ${(Math.sqrt(p.theta) * 100).toFixed(1)}%`, sub: 'current vs long-run vol' },
          { label: 'κ · ξ · ρ', value: `${p.kappa.toFixed(1)} · ${p.xi.toFixed(2)} · ${p.rho.toFixed(2)}`, sub: 'mean reversion · vol-of-vol · spot/vol corr' },
          { label: 'skew 90/110', value: `${((smile[3]?.iv ?? 0) - (smile[21]?.iv ?? 0)).toFixed(1)} pts`, tone: Math.abs(((smile[3]?.iv ?? 0) - (smile[21]?.iv ?? 0))) > 0.02 ? 'rose' : 'zinc' },
        ],
        outputs: [out(`${spec.id}:smile`, 'Heston implied smile', smilePts, 'x = strike % of spot', 'IV %')],
      };
    }
    case 'sabr': {
      const { sabrImpliedVol } = await import('@/lib/models/stochastic');
      const F = num('F', 100), T = num('T', 0.25);
      const p = { alpha: num('alpha', 0.45), rho: num('rho', -0.5), nu: num('nu', 0.8) };
      const strikes = Array.from({ length: 25 }, (_, i) => 0.8 + (0.4 * i) / 24);
      const smilePts: VizPoint[] = strikes.map((m) => ({ t: Math.round(m * 1000) / 10, v: sabrImpliedVol(F, F * m, T, p) * 100 }));
      const atm = sabrImpliedVol(F, F, T, p) * 100;
      const rr = (sabrImpliedVol(F, F * 0.9, T, p) - sabrImpliedVol(F, F * 1.1, T, p)) * 100;
      return {
        ...base,
        verdicts: [
          { label: 'ATM vol', value: `${atm.toFixed(1)}%`, tone: 'teal', sub: `α ${p.alpha.toFixed(2)} backbone` },
          { label: '90/110 skew', value: `${rr.toFixed(1)} pts`, tone: 'rose', sub: `ρ ${p.rho.toFixed(2)} drives it` },
          { label: 'ν curvature', value: p.nu.toFixed(2), sub: 'smile wings' },
        ],
        outputs: [out(`${spec.id}:smile`, 'SABR implied smile', smilePts, 'x = strike % of forward', 'IV %')],
      };
    }
    default:
      throw new Error(`no pricing runner for ${spec.id}`);
  }
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
