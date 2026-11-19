// ─────────────────────────────────────────────────────────────────────────────
// DECISION · model core — every statistical model fitted on ONE bar history.
//
// The pure heart of the Decision Hub: given the merged flow-bar history it
// fits the whole model room (GARCH, HMM, Kalman, OU, Merton tails, ML P(up),
// Kelly/CVaR) and runs the mixed-process Monte Carlo fan — one compute pass
// shared by the hub report, the /api/decision/models suite (the Mental Models
// Lab's live room), and the forecast layer's regime block.
// ─────────────────────────────────────────────────────────────────────────────

import type { RawBar } from '@/lib/forecast/panel';
import { fitGarch, garchForecast, fitOu, ouStretch, kalmanTrend, kalmanVerdict } from '@/lib/models/timeseries';
import type { GarchFit, GarchForecast, OuFit, KalmanTrend } from '@/lib/models/timeseries';
import { fitHmm, hmmRegime } from '@/lib/models/regimes';
import type { HmmFit } from '@/lib/models/regimes';
import { calibrateMerton, jumpTailMass } from '@/lib/models/stochastic';
import type { MertonParams } from '@/lib/models/stochastic';
import { marketFeatureMatrix, walkForwardPUp, logisticPredict } from '@/lib/models/ml';
import type { FeatureMatrix, LogisticModel, LogisticMetrics } from '@/lib/models/ml';
import { kellyFraction, tailRisk, drawdown } from '@/lib/models/portfolio';
import type { KellyResult, TailRisk, DrawdownStats } from '@/lib/models/portfolio';
import { mixedModelFan, mixedSpecFromFits } from '@/lib/models/mcfan';
import type { MixedFanResult } from '@/lib/models/mcfan';

export interface ModelCoreOpts {
  /** horizon in bars for the vol forecast + mixed fan (default 24) */
  h?: number;
  /** bars per year for annualization (default 35_040 = 15m 24/7) */
  barsPerYear?: number;
  /** Monte Carlo paths for the mixed fan (default 2400) */
  fanPaths?: number;
  /** deterministic seed for the fan (default time-bucketed) */
  seed?: number;
  /** include the ML walk-forward classifier (default true) */
  withMl?: boolean;
}

export interface MlPUpBlock {
  pUpNow: number;
  accuracy: number;
  auc: number | null;
  logLoss: number | null;
  trainN: number;
  testN: number;
  featureNames: string[];
}

export interface ModelCore {
  bars: number;
  spot: number;
  closes: number[];
  /** per-bar log returns */
  rets: number[];
  /** rolling σ of the last 20 log returns */
  sigmaPerBar: number;
  garch: GarchFit | null;
  garchFc: GarchForecast | null;
  /** annualized GARCH vol % now / at horizon / long-run */
  garchVolPctNow: number | null;
  garchVolPctH: number | null;
  garchVolPctLongRun: number | null;
  hmm: HmmFit | null;
  hmmDominant: { label: string; prob: number; regimeScore: number; expectedDurationBars: number } | null;
  kalman: KalmanTrend | null;
  kalmanVerdict: { z: number; label: 'UP' | 'DOWN' | 'FLAT'; stability: number } | null;
  ou: OuFit | null;
  ouStretchZ: number | null;
  merton: { params: MertonParams; tailCount: number; tailShare: number } | null;
  mertonTailMass: { merton: number; gaussian: number } | null;
  ml: MlPUpBlock | null;
  kelly: KellyResult | null;
  cvar: TailRisk | null;
  dd: DrawdownStats;
  fan: MixedFanResult | null;
  /** EMA12−EMA26 gap in σ units (trend cross-check) */
  macdSigma: number;
  /** mean buy share over the last 24 bars */
  buyShare: number;
  /** CVD slope over the last 24 bars, normalized by mean |delta| */
  cvdSlope: number;
}

/** σ of the log-return tail (20-bar rolling, last value). */
function sigmaPerBarOf(rets: number[]): number {
  const seg = rets.slice(-20);
  const m = seg.reduce((a, b) => a + b, 0) / Math.max(1, seg.length);
  return Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, seg.length - 1)) || 1e-6;
}

/**
 * Fit the whole model room on one merged bar history. Deterministic given
 * (bars, seed). Pure — no venue calls, no DB.
 */
export function computeModelCore(bars: RawBar[], opts: ModelCoreOpts = {}): ModelCore | null {
  if (bars.length < 80) return null;
  const h = Math.max(4, Math.min(120, opts.h ?? 24));
  const barsPerYear = opts.barsPerYear ?? 35_040;
  const closes = bars.map((b) => b.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 60) return null;
  const spot = closes[closes.length - 1];
  const sigmaPerBar = sigmaPerBarOf(rets);

  // ── GARCH ────────────────────────────────────────────────────────────────
  const garch = fitGarch(rets, { barsPerYear });
  const garchFc = garch ? garchForecast(garch, rets[rets.length - 1], h) : null;
  const perBarToPct = (v: number): number => v * Math.sqrt(barsPerYear) * 100;

  // ── HMM (last 600 returns keeps the fit fast and reactive) ───────────────
  const hmm = fitHmm(rets.slice(-600), { k: 3 });
  const hmmReg = hmm ? hmmRegime(hmm) : null;
  const hmmDominant = hmmReg
    ? {
        label: hmmReg.label,
        prob: hmmReg.prob,
        regimeScore: hmmReg.regimeScore,
        expectedDurationBars: hmmReg.expectedDurationBars,
      }
    : null;

  // ── Kalman trend ─────────────────────────────────────────────────────────
  const atrProxy = sigmaPerBar * spot;
  const kalman = kalmanTrend(closes, { atr: atrProxy });
  // the z-scale must be the PRICE-unit σ (slope is in price/bar): σ_log × S
  const kalmanV = kalman ? kalmanVerdict(kalman, sigmaPerBar * spot) : null;

  // ── OU on the log level ──────────────────────────────────────────────────
  const logCloses = closes.map((c) => Math.log(c));
  const ou = fitOu(logCloses);
  const ouStretchZ = ou ? ouStretch(ou, logCloses[logCloses.length - 1]).z : null;

  // ── Merton tails ─────────────────────────────────────────────────────────
  const merton = calibrateMerton(rets, { barsPerYear });
  const mertonTailMass =
    merton.params.lambda > 0 && merton.params.sigmaJ > 0
      ? jumpTailMass(merton.params, sigmaPerBar, h / barsPerYear, 3)
      : null;

  // ── ML P(up) walk-forward ────────────────────────────────────────────────
  let ml: MlPUpBlock | null = null;
  if (opts.withMl ?? true) {
    const deltas = bars.slice(1).map((b) => 2 * b.buyVolume - b.volume);
    const fm: FeatureMatrix | null = marketFeatureMatrix(closes, { deltas });
    const wf = fm ? walkForwardPUp(fm, { seed: 20260101 }) : null;
    if (fm && wf) {
      const lastRow = fm.x[fm.x.length - 1];
      ml = {
        pUpNow: logisticPredict(wf.model, lastRow),
        accuracy: wf.metrics.accuracy,
        auc: wf.metrics.auc,
        logLoss: wf.metrics.logLoss,
        trainN: wf.model.trainN,
        testN: wf.metrics.n,
        featureNames: fm.featureNames,
      };
    }
  }

  // ── Kelly / CVaR on the h-step historical distribution ───────────────────
  const hStepRets: number[] = [];
  for (let i = h; i < closes.length; i += 2) hStepRets.push(Math.log(closes[i] / closes[i - h]));
  const kelly = hStepRets.length >= 40 ? kellyFraction(hStepRets, 1) : null;
  const cvar = hStepRets.length >= 40 ? tailRisk(hStepRets, 0.95) : null;
  const dd = drawdown(rets);

  // ── mixed-process Monte Carlo fan ───────────────────────────────────────
  const volOfVol = garch
    ? (() => {
        const tail = garch.volTail;
        if (!tail.length) return 0;
        const m = tail.reduce((a, b) => a + b, 0) / tail.length;
        return m > 0 ? Math.sqrt(tail.reduce((a, b) => a + (b - m) ** 2, 0) / tail.length) / m : 0;
      })()
    : 0;
  // fan drift: the observed h-step mean log move (total, incl. jump mean)
  const histHMean = hStepRets.length ? hStepRets.reduce((a, b) => a + b, 0) / hStepRets.length : 0;
  const fanDrift = (histHMean / h) * barsPerYear;
  const seed = opts.seed ?? Math.floor(Date.now() / 60_000);
  const spec = mixedSpecFromFits({
    drift: fanDrift,
    garch,
    lastReturn: rets[rets.length - 1],
    merton: merton.params,
    ou: ou ? { kappaPerBar: ou.kappaPerBar, theta: ou.theta, strength: ou.score } : null,
    barsPerYear,
    volOfVol,
  });
  const fan = mixedModelFan(seed, opts.fanPaths ?? 2400, spot, h, 1 / barsPerYear, spec);

  // ── cross-checks the hub consumes ───────────────────────────────────────
  const macdSigma = (() => {
    const k12 = 2 / 13;
    const k26 = 2 / 27;
    let e12 = closes[0];
    let e26 = closes[0];
    for (const c of closes) {
      e12 = c * k12 + e12 * (1 - k12);
      e26 = c * k26 + e26 * (1 - k26);
    }
    return (e12 - e26) / Math.max(1e-9, sigmaPerBar * Math.sqrt(26) * spot);
  })();
  const win = bars.slice(-24);
  let buyShareAcc = 0;
  let volAcc = 0;
  let cvd = 0;
  const cvdHist: number[] = [];
  for (const b of win) {
    const delta = 2 * b.buyVolume - b.volume;
    cvd += delta;
    cvdHist.push(cvd);
    buyShareAcc += b.volume > 0 ? b.buyVolume / b.volume : 0.5;
    volAcc += Math.abs(delta);
  }
  const buyShare = buyShareAcc / Math.max(1, win.length);
  const cvdSlope =
    cvdHist.length >= 6
      ? (cvdHist[cvdHist.length - 1] - cvdHist[0]) / Math.max(1e-9, volAcc / Math.max(1, cvdHist.length))
      : 0;

  return {
    bars: bars.length,
    spot,
    closes,
    rets,
    sigmaPerBar,
    garch,
    garchFc,
    garchVolPctNow: garch ? perBarToPct(garch.currentVol) : null,
    garchVolPctH: garchFc ? garchFc.volPctAnnual[Math.max(0, h - 1)] : null,
    garchVolPctLongRun: garch ? perBarToPct(garch.longRunVol) : null,
    hmm,
    hmmDominant,
    kalman,
    kalmanVerdict: kalmanV,
    ou,
    ouStretchZ,
    merton,
    mertonTailMass,
    ml,
    kelly,
    cvar,
    dd,
    fan,
    macdSigma,
    buyShare,
    cvdSlope,
  };
}

export type { GarchFit, GarchForecast, HmmFit, KalmanTrend, OuFit, LogisticModel, LogisticMetrics, KellyResult, TailRisk, DrawdownStats, MixedFanResult, MertonParams };
