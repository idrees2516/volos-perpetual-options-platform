// ─────────────────────────────────────────────────────────────────────────────
// DECISION · hub — THE unified decision surface of the whole product.
//
// One call fuses every data family the terminal has:
//   the model room (GARCH · HMM · Kalman · OU · Merton · ML · Kelly · mixed MC)
//   the signal battery (gamma/vol/flow/perps/structure regime)
//   the vol cycle (IV rank, IV-vs-RV triangle)
//   the forecast layer (conformal drift, P(up), expected move)
//   order flow (buy share, CVD slope)
//   whole-market breadth + funding
//   the live paper book (positions, greeks, alerts, margin)
//   the 131-strategy catalog (regime-conditioned fit ranking)
// and turns it into: stance · confidence · pillars · model verdicts · top
// strategy fits · risk sizing · the action battery — the answer to "what
// should I do right now, and why".
// ─────────────────────────────────────────────────────────────────────────────

import { loadMergedBars } from '@/lib/forecast/panel';
import { buildProjectedState } from '@/lib/forecast/state';
import { decisionBrief } from '@/lib/quant/signals';
import { volRegime } from '@/lib/quant/volatility';
import { marketBreadth } from '@/lib/quant/breadth';
import { buildPositionIntelligence } from '@/lib/positions/intelligence';
import { STRATEGIES } from '@/lib/strategies';
import type { Signal } from '@/lib/quant/signals';
import { computeModelCore } from './core';
import type { ModelCore } from './core';
import {
  fusePillars,
  scoreStrategies,
  deriveActions,
  stanceLabelFor,
  r2,
  clamp,
} from './fusion';
import type { Pillar, PillarFusionInput, PillarFusionOutput, StrategyFit, HubAction } from './fusion';

export type HubAsset = 'BTC' | 'ETH' | 'SOL';

const TF_MS = 900_000; // 15m bars
const BARS_PER_YEAR = 35_040; // 96/day × 365 (24/7)
const HORIZON_BARS = 24; // 6h decision horizon
const CACHE_TTL_MS = 30_000;

export interface ModelVerdict {
  id: 'garch' | 'hmm' | 'kalman' | 'ou' | 'merton' | 'ml' | 'kelly' | 'fan';
  label: string;
  headline: string;
  numbers: { label: string; value: number | null }[];
  /** −100..+100 stance contribution */
  stance: number | null;
}

export interface HubWatchLevel {
  label: string;
  price: number | null;
  distancePct: number | null;
  kind: string;
}

export interface DecisionHubReport {
  tsMs: number;
  asset: HubAsset;
  tf: number;
  horizonBars: number;
  horizonMin: number;
  spot: number;
  /** the fused stance: −100..+100 */
  stance: number;
  stanceLabel: string;
  confidence: number;
  agreement: number;
  pillars: Pillar[];
  volEdgePts: number | null;
  volVerdict: 'RICH' | 'CHEAP' | 'FAIR' | null;
  models: ModelVerdict[];
  strategyFit: StrategyFit[];
  actions: HubAction[];
  risk: {
    kellyFull: number | null;
    kellyHalf: number | null;
    kellyGrowth: number | null;
    cvar95Pct: number | null;
    var95Pct: number | null;
    maxDdPct: number | null;
    horizonBars: number;
    marginUtilPct: number | null;
  };
  forecast: {
    driftPct: number | null;
    pUpClimatology: number | null;
    pUpMl: number | null;
    pUpFan: number | null;
    expectedMovePct: number | null;
    bandLoPct: number | null;
    bandHiPct: number | null;
    agreementPct: number | null;
    modelLabel: string | null;
  };
  positions: {
    count: number;
    netDeltaUsd: number | null;
    marginUtilPct: number | null;
    alerts: { critical: number; warn: number; info: number } | null;
    decisionCounts: Record<string, number> | null;
    healthAvg: number | null;
  };
  breadth: {
    advancers: number | null;
    decliners: number | null;
    medianChangePct: number | null;
    avgFundingApr: number | null;
  } | null;
  watch: HubWatchLevel[];
  context: {
    ivRank: number | null;
    iv30Pct: number | null;
    rv30Pct: number | null;
    garchVolPctNow: number | null;
    garchVolPctH: number | null;
    fundingPctile: number | null;
    hmmLabel: string | null;
    hmmProb: number | null;
    trendLabel: string | null;
    regimeScore: number | null;
    regimeLabel: string | null;
    topSignals: string[];
  };
  notes: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** Signal states → −1..+1 (the signal battery's own mapping). */
const STATE_SCORE: Record<Signal['state'], number> = {
  'extreme-bullish': 1,
  bullish: 0.6,
  neutral: 0,
  bearish: -0.6,
  'extreme-bearish': -1,
};

function groupSignalScore(signals: Signal[], groups: Signal['group'][]): number | null {
  const sel = signals.filter((s) => groups.includes(s.group));
  if (!sel.length) return null;
  let acc = 0;
  let w = 0;
  for (const s of sel) {
    const wi = s.weight * (0.5 + (s.strength / 100) * 0.5);
    acc += STATE_SCORE[s.state] * wi;
    w += wi;
  }
  return w > 0 ? clamp((acc / w) * 100, -100, 100) : null;
}

function modelVerdicts(core: ModelCore): ModelVerdict[] {
  const out: ModelVerdict[] = [];
  if (core.garch && core.garchVolPctNow != null && core.garchVolPctH != null) {
    const dir = core.garchVolPctH - core.garchVolPctNow;
    out.push({
      id: 'garch',
      label: 'GARCH(1,1) vol forecast',
      headline: `σ ${core.garchVolPctNow.toFixed(1)}% → ${core.garchVolPctH.toFixed(1)}% @ h (${dir >= 0 ? 'expanding' : 'compressing'}), long-run ${core.garchVolPctLongRun?.toFixed(1) ?? '?'}%`,
      numbers: [
        { label: 'σ now %', value: r2(core.garchVolPctNow, 1) },
        { label: `σ @ ${HORIZON_BARS} bars %`, value: r2(core.garchVolPctH, 1) },
        { label: 'persistence', value: r2(core.garch.persistence, 3) },
        { label: 'shock half-life bars', value: core.garch.shockHalfLifeBars },
      ],
      stance: clamp((dir / Math.max(1, core.garchVolPctNow)) * 400, -100, 100) || 0,
    });
  }
  if (core.hmmDominant) {
    out.push({
      id: 'hmm',
      label: 'Hidden Markov regime',
      headline: `${core.hmmDominant.label.toUpperCase()} state @ ${(core.hmmDominant.prob * 100).toFixed(0)}% — expected run ${Number.isFinite(core.hmmDominant.expectedDurationBars) ? Math.round(core.hmmDominant.expectedDurationBars) : '∞'} bars`,
      numbers: [
        { label: 'dominant state', value: null },
        { label: 'state prob', value: r2(core.hmmDominant.prob, 2) },
        { label: 'regime score', value: core.hmmDominant.regimeScore },
      ],
      stance: core.hmmDominant.regimeScore,
    });
  }
  if (core.kalmanVerdict) {
    out.push({
      id: 'kalman',
      label: 'Kalman local trend',
      headline: `Filtered trend ${core.kalmanVerdict.label} (z=${core.kalmanVerdict.z.toFixed(2)}σ/bar, stability ${(core.kalmanVerdict.stability * 100).toFixed(0)}%)`,
      numbers: [
        { label: 'slope z', value: r2(core.kalmanVerdict.z, 2) },
        { label: 'stability', value: r2(core.kalmanVerdict.stability, 2) },
      ],
      stance: clamp((core.kalmanVerdict.z / 1.5) * 100, -100, 100),
    });
  }
  if (core.ou && core.ouStretchZ != null) {
    out.push({
      id: 'ou',
      label: 'Ornstein–Uhlenbeck pull',
      headline: `Stretch ${core.ouStretchZ.toFixed(1)}σ from θ (half-life ${core.ou.halfLifeBars ? Math.round(core.ou.halfLifeBars) : '∞'} bars, score ${core.ou.score}/100)`,
      numbers: [
        { label: 'stretch σ', value: r2(core.ouStretchZ, 1) },
        { label: 'half-life bars', value: core.ou.halfLifeBars },
        { label: 'reversion score', value: core.ou.score },
        { label: 'φ', value: r2(core.ou.phi, 4) },
      ],
      stance: clamp(-core.ouStretchZ * 25, -100, 100),
    });
  }
  if (core.merton && core.merton.params.lambda > 0) {
    const mult = core.mertonTailMass ? core.mertonTailMass.merton / Math.max(1e-9, core.mertonTailMass.gaussian) : null;
    out.push({
      id: 'merton',
      label: 'Merton jump tails',
      headline: `λ=${core.merton.params.lambda.toFixed(0)}/yr of ${(core.merton.tailShare * 100).toFixed(1)}%-bar tails, 3σ tail mass ${mult ? mult.toFixed(1) : '?'}× Gaussian`,
      numbers: [
        { label: 'λ per year', value: r2(core.merton.params.lambda, 1) },
        { label: 'μ_J', value: r2(core.merton.params.muJ, 4) },
        { label: 'σ_J', value: r2(core.merton.params.sigmaJ, 4) },
        { label: 'tail × Gaussian', value: r2(mult, 1) },
      ],
      stance: core.merton.params.muJ < 0 ? -25 : 25,
    });
  }
  if (core.ml) {
    out.push({
      id: 'ml',
      label: 'ML P(up) classifier',
      headline: `P(up)=${(core.ml.pUpNow * 100).toFixed(1)}% (walk-forward acc ${(core.ml.accuracy * 100).toFixed(0)}%, AUC ${core.ml.auc?.toFixed(2) ?? '—'})`,
      numbers: [
        { label: 'P(up) now', value: r2(core.ml.pUpNow, 3) },
        { label: 'holdout accuracy', value: r2(core.ml.accuracy, 3) },
        { label: 'AUC', value: core.ml.auc },
        { label: 'log loss', value: r2(core.ml.logLoss, 3) },
      ],
      stance: clamp((core.ml.pUpNow - 0.5) * 200, -100, 100),
    });
  }
  if (core.kelly) {
    out.push({
      id: 'kelly',
      label: 'Kelly sizing',
      headline: `f*=${(core.kelly.f * 100).toFixed(1)}% of book per ${HORIZON_BARS}-bar trade (half-Kelly ${(core.kelly.fHalf * 100).toFixed(1)}%)`,
      numbers: [
        { label: 'f*', value: r2(core.kelly.f, 3) },
        { label: 'f half', value: r2(core.kelly.fHalf, 3) },
        { label: 'growth at f*', value: r2(core.kelly.growth, 5) },
        { label: 'continuous μ/σ²', value: r2(core.kelly.fContinuous, 3) },
      ],
      stance: null,
    });
  }
  if (core.fan) {
    const last = core.fan.steps[core.fan.steps.length - 1];
    out.push({
      id: 'fan',
      label: 'Mixed-process MC fan',
      headline: `${HORIZON_BARS}-bar band [${((last.q05 / core.spot - 1) * 100).toFixed(1)}% … ${((last.q95 / core.spot - 1) * 100).toFixed(1)}%], P(up)=${(core.fan.terminal.pUp * 100).toFixed(0)}%`,
      numbers: [
        { label: 'q05', value: r2(last.q05, 2) },
        { label: 'q50', value: r2(last.q50, 2) },
        { label: 'q95', value: r2(last.q95, 2) },
        { label: 'P(up)', value: r2(core.fan.terminal.pUp, 3) },
        { label: 'paths', value: core.fan.nPaths },
      ],
      stance: clamp((core.fan.terminal.pUp - 0.5) * 200, -100, 100),
    });
  }
  return out;
}

// ── cache (single-flight + TTL per asset) ───────────────────────────────────

interface HubCacheEntry {
  promise: Promise<DecisionHubReport> | null;
  report: DecisionHubReport | null;
  at: number;
}
const g = globalThis as unknown as { __decisionHub?: Map<string, HubCacheEntry> };
const cache: Map<string, HubCacheEntry> = g.__decisionHub ?? new Map();
g.__decisionHub = cache;

/**
 * Build the Decision Hub report — every data family in the product fused into
 * one decision surface. Cached 30 s (single-flight per asset).
 */
export async function buildDecisionHub(asset: HubAsset = 'BTC'): Promise<DecisionHubReport> {
  const key = String(asset);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.report && now - hit.at < CACHE_TTL_MS) return hit.report;
  if (hit && hit.promise) return hit.promise;

  const promise = (async (): Promise<DecisionHubReport> => {
    const notes: string[] = [];
    // ── data gathering (every source timeout-guarded, degrade gracefully) ──
    const [barsSet, signalsBrief, volReg, intel, projected, breadth] = await Promise.all([
      loadMergedBars(asset, TF_MS, 720).catch(() => null),
      withTimeout(decisionBrief(asset), 12_000),
      withTimeout(volRegime(asset), 10_000),
      withTimeout(buildPositionIntelligence(), 18_000),
      withTimeout(
        buildProjectedState(asset, TF_MS, { h: HORIZON_BARS, levels: [80, 95], nWindows: 6, asset, backfill: 720 }),
        15_000,
      ),
      withTimeout(marketBreadth(), 8_000),
    ]);
    if (!barsSet || barsSet.bars.length < 80) {
      throw new Error(`insufficient bar history for ${asset} (bars=${barsSet?.bars.length ?? 0})`);
    }
    if (barsSet.klineError) notes.push(`klines: ${barsSet.klineError}`);

    // ── the model room (one compute pass) ───────────────────────────────────
    const core = computeModelCore(barsSet.bars, { h: HORIZON_BARS, barsPerYear: BARS_PER_YEAR });
    if (!core) throw new Error('model core could not be fitted');

    const signals = signalsBrief?.signals ?? [];
    const flowSignals = groupSignalScore(signals, ['Flow']);
    const derivativesSignals = groupSignalScore(signals, ['Gamma', 'Perps', 'Structure']);
    const rollup = intel?.portfolio ?? null;
    const posList = intel?.positions ?? [];
    const healthAvg = posList.length
      ? posList.reduce((a, p) => a + (p.decision.healthScore ?? 0), 0) / posList.length
      : null;

    // ── the fusion (pure) ──────────────────────────────────────────────────
    const iv30Pct = volReg?.triangle?.iv30Pct ?? null;
    const garchH = core.garchVolPctH;
    const ivEdgePts = iv30Pct != null && garchH != null ? iv30Pct - garchH : null;
    const fusion: PillarFusionOutput = fusePillars(
      {
        signalsRegime: signalsBrief?.regimeScore ?? 0,
        kalmanZ: core.kalmanVerdict?.z ?? null,
        macdSigma: core.macdSigma,
        driftPct: projected?.drift?.pct ?? null,
        hmmScore: core.hmmDominant?.regimeScore ?? null,
        mlPUp: core.ml?.pUpNow ?? null,
        fanPUp: core.fan?.terminal.pUp ?? null,
        climPUp: projected?.pUp ?? null,
        buyShare: core.buyShare,
        cvdSlope: core.cvdSlope,
        flowSignals,
        derivativesSignals,
        netDeltaUsd: rollup?.netGreeks?.total?.deltaUsd ?? null,
        marginUtilPct: rollup?.marginUtilizationPct ?? null,
        alertsCritical: rollup?.alerts?.critical ?? 0,
        positionsCount: posList.length,
        healthAvg,
      },
      ivEdgePts,
    );

    // ── strategy fit + actions (pure) ───────────────────────────────────────
    const volDirection =
      core.garchVolPctNow != null && garchH != null ? clamp(((garchH - core.garchVolPctNow) / Math.max(1, core.garchVolPctNow)) * 400, -100, 100) : null;
    const strategyFit = scoreStrategies(STRATEGIES, {
      stance: fusion.stance,
      stanceLabel: fusion.stanceLabel,
      volEdgePts: fusion.volEdgePts,
      volDirection,
      hmmLabel: core.hmmDominant?.label ?? null,
      trendLabel: core.kalmanVerdict?.label ?? null,
      ivRank: volReg?.ivStats?.rank ?? signalsBrief?.context?.ivRank ?? null,
      fundingPctile: signalsBrief?.context?.fundingPctile ?? null,
    });
    const actions = deriveActions({
      fusion,
      strategyFit,
      hmmLabel: core.hmmDominant?.label ?? null,
      hmmProb: core.hmmDominant?.prob ?? null,
      ouStretchZ: core.ouStretchZ,
      trendLabel: core.kalmanVerdict?.label ?? null,
      kellyHalf: core.kelly?.fHalf ?? null,
      cvar95Pct: core.cvar ? core.cvar.cvarHist * 100 : null,
      fundingPctile: signalsBrief?.context?.fundingPctile ?? null,
      ivRank: volReg?.ivStats?.rank ?? null,
      alertsCritical: rollup?.alerts?.critical ?? 0,
      positionsCount: posList.length,
    });

    // ── forecast cross-check ───────────────────────────────────────────────
    const last = core.fan?.steps[core.fan?.steps.length - 1];
    const bandLoPct = last && core.fan ? ((last.q05 / core.spot - 1) * 100) : null;
    const bandHiPct = last && core.fan ? ((last.q95 / core.spot - 1) * 100) : null;
    const pUps = [projected?.pUp ?? null, core.ml?.pUpNow ?? null, core.fan?.terminal.pUp ?? null].filter(
      (v): v is number => v != null,
    );
    // agreement: the majority share of the P(up) estimators on one side of 0.5
    let pUpAgreement: number | null = null;
    if (pUps.length >= 2) {
      const ups = pUps.filter((v) => v >= 0.5).length;
      pUpAgreement = Math.round((Math.max(ups, pUps.length - ups) / pUps.length) * 100);
    }

    // ── watch levels (signal battery watchlist + fan bands) ────────────────
    const watch: HubWatchLevel[] = (signalsBrief?.watchlist ?? [])
      .filter((w) => w.price != null)
      .slice(0, 5)
      .map((w) => ({
        label: w.label,
        price: w.price,
        distancePct: w.price != null ? r2((w.price / core.spot - 1) * 100, 2) : null,
        kind: String(w.kind ?? 'level'),
      }));
    if (last && core.fan) {
      watch.push({ label: 'MC fan 5% band', price: last.q05, distancePct: r2(((last.q05 / core.spot - 1) * 100), 2), kind: 'fan' });
      watch.push({ label: 'MC fan 95% band', price: last.q95, distancePct: r2(((last.q95 / core.spot - 1) * 100), 2), kind: 'fan' });
    }

    if (!signalsBrief) notes.push('signal battery unavailable (timeout)');
    if (!volReg) notes.push('vol regime unavailable (timeout)');
    if (!intel) notes.push('position intelligence unavailable (timeout)');
    if (!projected) notes.push('projected state unavailable (timeout)');
    if (!breadth) notes.push('market breadth unavailable (timeout)');
    if (!core.ml) notes.push('ML classifier needs ≥ 40 bars of features');
    if (core.kelly == null) notes.push('Kelly/CVaR need ≥ 40 h-step observations');

    return {
      tsMs: Date.now(),
      asset,
      tf: TF_MS,
      horizonBars: HORIZON_BARS,
      horizonMin: (HORIZON_BARS * TF_MS) / 60_000,
      spot: core.spot,
      stance: fusion.stance,
      stanceLabel: fusion.stanceLabel,
      confidence: fusion.confidence,
      agreement: fusion.agreement,
      pillars: fusion.pillars,
      volEdgePts: fusion.volEdgePts,
      volVerdict: fusion.volVerdict,
      models: modelVerdicts(core),
      strategyFit,
      actions,
      risk: {
        kellyFull: r2(core.kelly?.f, 3),
        kellyHalf: r2(core.kelly?.fHalf, 3),
        kellyGrowth: r2(core.kelly?.growth, 5),
        cvar95Pct: core.cvar ? r2(core.cvar.cvarHist * 100, 2) : null,
        var95Pct: core.cvar ? r2(core.cvar.varHist * 100, 2) : null,
        maxDdPct: r2(core.dd.maxDd * 100, 2),
        horizonBars: HORIZON_BARS,
        marginUtilPct: rollup ? r2(rollup.marginUtilizationPct, 1) : null,
      },
      forecast: {
        driftPct: projected?.drift?.pct ?? null,
        pUpClimatology: projected?.pUp ?? null,
        pUpMl: core.ml?.pUpNow ?? null,
        pUpFan: core.fan?.terminal.pUp ?? null,
        expectedMovePct: projected?.expectedMove?.widthPct ?? null,
        bandLoPct: r2(bandLoPct, 2),
        bandHiPct: r2(bandHiPct, 2),
        agreementPct: pUpAgreement,
        modelLabel: projected?.price?.modelLabel ?? null,
      },
      positions: {
        count: posList.length,
        netDeltaUsd: rollup ? r2(rollup.netGreeks.total.deltaUsd, 0) : null,
        marginUtilPct: rollup ? r2(rollup.marginUtilizationPct, 1) : null,
        alerts: rollup ? { critical: rollup.alerts.critical, warn: rollup.alerts.warn, info: rollup.alerts.info } : null,
        decisionCounts: rollup
          ? Object.fromEntries(Object.entries(rollup.decisionCounts).map(([k, v]) => [k, v as number]))
          : null,
        healthAvg: r2(healthAvg, 0),
      },
      breadth: breadth
        ? {
            advancers: breadth.stats.advancers,
            decliners: breadth.stats.decliners,
            medianChangePct: r2(breadth.stats.medianChangePct, 2),
            avgFundingApr: r2(breadth.stats.avgFundingApr, 2),
          }
        : null,
      watch,
      context: {
        ivRank: volReg?.ivStats?.rank ?? signalsBrief?.context?.ivRank ?? null,
        iv30Pct: iv30Pct,
        rv30Pct: volReg?.triangle?.rv30Pct ?? null,
        garchVolPctNow: core.garchVolPctNow,
        garchVolPctH: core.garchVolPctH,
        fundingPctile: signalsBrief?.context?.fundingPctile ?? null,
        hmmLabel: core.hmmDominant?.label ?? null,
        hmmProb: r2(core.hmmDominant?.prob, 2),
        trendLabel: core.kalmanVerdict?.label ?? null,
        regimeScore: signalsBrief?.regimeScore ?? null,
        regimeLabel: signalsBrief?.regimeLabel ?? null,
        topSignals: signals.slice(0, 4).map((s) => `${s.title}: ${s.state} (${s.strength})`),
      },
      notes,
    };
  })();

  const entry: HubCacheEntry = { promise, report: null, at: now };
  cache.set(key, entry);
  try {
    const report = await promise;
    entry.report = report;
    entry.at = Date.now();
    return report;
  } finally {
    entry.promise = null;
  }
}

export { stanceLabelFor };
export type { Pillar, PillarFusionInput, PillarFusionOutput, StrategyFit, HubAction, ModelCore };
