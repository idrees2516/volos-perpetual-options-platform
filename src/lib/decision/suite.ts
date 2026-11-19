// ─────────────────────────────────────────────────────────────────────────────
// DECISION · model suite — the per-model detail pass (chart-ready series).
//
// Serves /api/decision/models and the Mental Models Lab's LIVE model room:
// every new model with its fitted parameters, its recent series, and — the
// integration story — WHERE in the product each model is already consumed.
// ─────────────────────────────────────────────────────────────────────────────

import { loadMergedBars } from '@/lib/forecast/panel';
import { computeModelCore } from './core';
import { kellyGrowth } from '@/lib/models/portfolio';

const TF_MS = 900_000;
const BARS_PER_YEAR = 35_040;

export interface ModelSuiteEntry {
  id: 'garch' | 'hmm' | 'kalman' | 'ou' | 'merton' | 'ml' | 'kelly' | 'fan';
  label: string;
  kind: string;
  params: { label: string; value: number | string | null }[];
  /** chart series: {name, points} (≤ 240 points each) */
  series: { name: string; points: number[] }[];
  verdict: string;
  /** where this model already feeds the product */
  consumedBy: string[];
}

export interface ModelSuite {
  asset: string;
  tf: number;
  bars: number;
  klineSource: string;
  spot: number;
  builtAt: number;
  models: ModelSuiteEntry[];
}

const round = (v: number | null | undefined, dp = 3): number | null =>
  v == null || !Number.isFinite(v) ? null : +v.toFixed(dp);

/**
 * Build the model-suite detail: every model's fit + chart series + the list
 * of product surfaces it already powers (the deep-integration map).
 */
export async function buildModelSuite(asset: string = 'BTC', opts: { h?: number; backfill?: number } = {}): Promise<ModelSuite> {
  const h = opts.h ?? 24;
  const barsSet = await loadMergedBars(asset as never, TF_MS, opts.backfill ?? 720);
  const core = computeModelCore(barsSet.bars, { h, barsPerYear: BARS_PER_YEAR });
  if (!core) throw new Error(`model core could not be fitted for ${asset}`);
  const models: ModelSuiteEntry[] = [];

  if (core.garch && core.garchFc) {
    models.push({
      id: 'garch',
      label: 'GARCH(1,1)',
      kind: 'volatility clustering',
      params: [
        { label: 'ω', value: core.garch.omega.toExponential(2) },
        { label: 'α (news)', value: round(core.garch.alpha, 4) },
        { label: 'β (memory)', value: round(core.garch.beta, 4) },
        { label: 'persistence', value: round(core.garch.persistence, 4) },
        { label: 'long-run σ %', value: round(core.garchVolPctLongRun, 1) },
        { label: 'shock half-life (bars)', value: round(core.garch.shockHalfLifeBars, 1) },
      ],
      series: [
        { name: 'conditional σ % (60 bars)', points: core.garch.volTail.map((v) => +((v * Math.sqrt(BARS_PER_YEAR) * 100).toFixed(2))) },
        { name: 'forecast σ % (h)', points: core.garchFc.volPctAnnual.map((v) => +v.toFixed(2)) },
      ],
      verdict: `σ ${core.garchVolPctNow?.toFixed(1)}% → ${core.garchVolPctH?.toFixed(1)}% over ${h} bars (long-run ${core.garchVolPctLongRun?.toFixed(1)}%)`,
      consumedBy: ['Decision Hub (vol edge vs IV)', 'Forecast regime block', 'Mixed MC fan (vol leg)', 'Strategy fit (premium side)'],
    });
  }
  if (core.hmm && core.hmmDominant) {
    const hmm = core.hmm;
    models.push({
      id: 'hmm',
      label: 'Hidden Markov (3-state)',
      kind: 'regime detection',
      params: [
        ...hmm.states.map((s, i) => ({ label: `state ${i} μ/σ`, value: `${s.mu.toExponential(1)} / ${s.sigma.toFixed(4)}` })),
        ...hmm.states.map((s, i) => ({ label: `state ${i} label/E[run]`, value: `${s.label} / ${Number.isFinite(s.expectedDurationBars) ? Math.round(s.expectedDurationBars) : '∞'}b` })),
        { label: 'log-lik', value: round(hmm.logLik, 1) },
        { label: 'BW iterations', value: hmm.iterations },
      ],
      series: [
        ...hmm.probsTail[0]?.map((_, i) => ({
          name: `P(state ${i})`,
          points: hmm.probsTail.map((row) => +(row[i]?.toFixed(3) ?? 0)),
        })) ?? [],
        { name: 'decoded state (tail)', points: hmm.path.slice(-120) },
      ],
      verdict: `dominant ${core.hmmDominant.label.toUpperCase()} @ ${(core.hmmDominant.prob * 100).toFixed(0)}%`,
      consumedBy: ['Decision Hub (models pillar + regime prior)', 'Strategy fit (regime tags)', 'Autopilot stance gate'],
    });
  }
  if (core.kalman && core.kalmanVerdict) {
    models.push({
      id: 'kalman',
      label: 'Kalman local trend',
      kind: 'trend filtering',
      params: [
        { label: 'current level', value: round(core.kalman.currentLevel, 2) },
        { label: 'slope / bar', value: round(core.kalman.currentSlope, 4) },
        { label: 'slope z', value: round(core.kalmanVerdict.z, 2) },
        { label: 'innovation ratio', value: round(core.kalman.innovationRatio, 3) },
        { label: 'verdict', value: core.kalmanVerdict.label },
      ],
      series: [
        { name: 'filtered level (tail)', points: core.kalman.level.slice(-120).map((v) => +v.toFixed(2)) },
        { name: 'price (tail)', points: core.closes.slice(-120).map((v) => +v.toFixed(2)) },
        { name: 'slope (tail)', points: core.kalman.slope.slice(-120).map((v) => +v.toFixed(4)) },
      ],
      verdict: `trend ${core.kalmanVerdict.label} at z=${core.kalmanVerdict.z.toFixed(2)}`,
      consumedBy: ['Decision Hub (trend pillar)', 'Position intelligence alignment', 'Strategy fit (trend category)'],
    });
  }
  if (core.ou) {
    models.push({
      id: 'ou',
      label: 'Ornstein–Uhlenbeck',
      kind: 'mean reversion',
      params: [
        { label: 'φ (AR1)', value: round(core.ou.phi, 4) },
        { label: 'κ / bar', value: round(core.ou.kappaPerBar, 4) },
        { label: 'half-life (bars)', value: round(core.ou.halfLifeBars, 1) },
        { label: 'θ (log level)', value: round(core.ou.theta, 4) },
        { label: 'R²', value: round(core.ou.rSquared, 3) },
        { label: 'score /100', value: core.ou.score },
        { label: 'stretch σ', value: round(core.ouStretchZ, 2) },
      ],
      series: [
        { name: 'log price (tail)', points: core.closes.slice(-120).map((c) => +Math.log(c).toFixed(4)) },
        { name: 'θ', points: core.closes.slice(-120).map(() => +core.ou!.theta.toFixed(4)) },
      ],
      verdict: `stretch ${core.ouStretchZ?.toFixed(1)}σ, pull score ${core.ou.score}/100`,
      consumedBy: ['Decision Hub (mean-reversion action)', 'Mixed MC fan (OU leg)'],
    });
  }
  if (core.merton) {
    models.push({
      id: 'merton',
      label: 'Merton jump diffusion',
      kind: 'gap-risk tails',
      params: [
        { label: 'λ / year', value: round(core.merton.params.lambda, 1) },
        { label: 'μ_J', value: round(core.merton.params.muJ, 4) },
        { label: 'σ_J', value: round(core.merton.params.sigmaJ, 4) },
        { label: 'tail bars', value: core.merton.tailCount },
        { label: '3σ tail × Gaussian', value: core.mertonTailMass ? round(core.mertonTailMass.merton / Math.max(1e-9, core.mertonTailMass.gaussian), 2) : null },
      ],
      series: [
        { name: 'returns (tail)', points: core.rets.slice(-120).map((v) => +v.toFixed(5)) },
      ],
      verdict: core.merton.params.lambda > 0
        ? `λ=${core.merton.params.lambda.toFixed(0)}/yr · tail mass ${core.mertonTailMass ? (core.mertonTailMass.merton / Math.max(1e-9, core.mertonTailMass.gaussian)).toFixed(1) : '—'}× Gaussian`
        : 'no 3σ exceedances in the window',
      consumedBy: ['Decision Hub (tail verdict + hedge action)', 'Mixed MC fan (jump leg)', 'Mental Models Lab pricing demo'],
    });
  }
  if (core.ml) {
    models.push({
      id: 'ml',
      label: 'Logistic P(up) + features',
      kind: 'statistical learning',
      params: [
        { label: 'P(up) now', value: round(core.ml.pUpNow, 3) },
        { label: 'holdout accuracy', value: round(core.ml.accuracy, 3) },
        { label: 'AUC', value: round(core.ml.auc, 3) },
        { label: 'log loss', value: round(core.ml.logLoss, 3) },
        { label: 'train / test bars', value: `${core.ml.trainN} / ${core.ml.testN}` },
      ],
      series: [
        { name: 'P(up) history is not stored — features are recomputed live', points: [] },
      ],
      verdict: `P(up)=${(core.ml.pUpNow * 100).toFixed(1)}% (acc ${(core.ml.accuracy * 100).toFixed(0)}%)`,
      consumedBy: ['Decision Hub (models pillar)', 'Forecast P(up) cross-check'],
    });
  }
  if (core.kelly) {
    const curve: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const f = i / 20;
      const g = kellyGrowth(core.rets.slice(-200), f);
      curve.push(Number.isFinite(g) ? +g.toFixed(5) : 0);
    }
    models.push({
      id: 'kelly',
      label: 'Kelly + CVaR sizing',
      kind: 'position sizing',
      params: [
        { label: 'f* (discrete)', value: round(core.kelly.f, 3) },
        { label: 'f continuous', value: round(core.kelly.fContinuous, 3) },
        { label: 'growth at f*', value: round(core.kelly.growth, 5) },
        { label: 'CVaR 95 %', value: round(core.cvar?.cvarHist != null ? core.cvar.cvarHist * 100 : null, 2) },
        { label: 'VaR 95 %', value: round(core.cvar?.varHist != null ? core.cvar.varHist * 100 : null, 2) },
        { label: 'max drawdown %', value: round(core.dd.maxDd * 100, 2) },
      ],
      series: [{ name: 'g(f) curve (last 200 bars)', points: curve }],
      verdict: `half-Kelly ${(core.kelly.fHalf * 100).toFixed(1)}% per ${h}-bar trade`,
      consumedBy: ['Decision Hub risk block', 'Autopilot scale-in sizing', 'Action battery sizing cap'],
    });
  }
  if (core.fan) {
    models.push({
      id: 'fan',
      label: 'Mixed-process MC fan',
      kind: 'everything combined',
      params: [
        { label: 'paths', value: core.fan.nPaths },
        { label: 'P(up)', value: round(core.fan.terminal.pUp, 3) },
        { label: 'q05 / q95', value: `${core.fan.terminal.q05.toFixed(0)} / ${core.fan.terminal.q95.toFixed(0)}` },
        { label: 'legs', value: 'GARCH vol + Merton jumps + OU pull' },
      ],
      series: [
        { name: 'q05', points: core.fan.steps.map((s) => +s.q05.toFixed(2)) },
        { name: 'q50', points: core.fan.steps.map((s) => +s.q50.toFixed(2)) },
        { name: 'q95', points: core.fan.steps.map((s) => +s.q95.toFixed(2)) },
        ...core.fan.samplePaths.map((p, i) => ({ name: `sample path ${i + 1}`, points: p.map((v) => +v.toFixed(2)) })),
      ],
      verdict: `${h}-bar band ${((core.fan.terminal.q05 / core.spot - 1) * 100).toFixed(1)}% … ${((core.fan.terminal.q95 / core.spot - 1) * 100).toFixed(1)}%`,
      consumedBy: ['Decision Hub forecast cross-check', 'Conformal fan sanity check', 'Watch levels'],
    });
  }

  return {
    asset,
    tf: TF_MS,
    bars: barsSet.bars.length,
    klineSource: barsSet.klineSource,
    spot: core.spot,
    builtAt: Date.now(),
    models,
  };
}
