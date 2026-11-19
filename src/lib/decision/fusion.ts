// ─────────────────────────────────────────────────────────────────────────────
// DECISION · fusion — the pure decision math of the hub.
//
//   • fusePillars    — the stance engine: trend / models / flow / derivatives
//                      / positions pillars → one −100..+100 stance + confidence
//                      + agreement + the vol-edge verdict.
//   • scoreStrategies— the 131-strategy catalog scored against the live
//                      decision context (view × vol edge × regime × funding).
//   • deriveActions  — the action battery: what to actually DO right now.
//
// Everything here is a pure function of plain numbers — unit-tested in
// fusion.test.ts, consumed by the async hub.
// ─────────────────────────────────────────────────────────────────────────────

import { STRATEGIES } from '@/lib/strategies';
import type { StrategySpec, StrategyView, StrategyCategory } from '@/lib/strategies';

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const r2 = (v: number | null | undefined, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : +v.toFixed(dp);

// ── pillar fusion ───────────────────────────────────────────────────────────

export interface PillarFusionInput {
  /** signal-battery regime score (−100..100) from decisionBrief */
  signalsRegime: number;
  /** Kalman trend z (slope / σ) */
  kalmanZ: number | null;
  /** EMA12−EMA26 gap in σ units */
  macdSigma: number | null;
  /** forecast drift % over the horizon */
  driftPct: number | null;
  /** HMM regime score (−100 calm-friendly..+100? sign: high vol = negative) */
  hmmScore: number | null;
  /** ML walk-forward P(up) now */
  mlPUp: number | null;
  /** mixed-MC fan P(up) */
  fanPUp: number | null;
  /** empirical climatology P(up) */
  climPUp: number | null;
  /** mean buy share (0..1) last window */
  buyShare: number | null;
  /** normalized CVD slope */
  cvdSlope: number | null;
  /** Flow-group signal state score (−100..100) from the signal battery */
  flowSignals: number | null;
  /** Gamma+Perps+Structure-group signal state score */
  derivativesSignals: number | null;
  /** book net delta (USD) */
  netDeltaUsd: number | null;
  /** margin utilization % */
  marginUtilPct: number | null;
  /** critical position alerts count */
  alertsCritical: number;
  /** open positions count */
  positionsCount: number;
  /** average position health 0..100 */
  healthAvg: number | null;
}

export interface Pillar {
  id: 'trend' | 'models' | 'flow' | 'derivatives' | 'positions';
  label: string;
  /** −100..+100 directional conviction */
  score: number;
  /** 0..100 how much data actually backed this pillar */
  confidence: number;
  drivers: { label: string; value: number; contribution: number }[];
}

export interface PillarFusionOutput {
  pillars: Pillar[];
  /** −100..+100 composite stance */
  stance: number;
  stanceLabel: string;
  confidence: number;
  /** share of weighted pillar magnitude agreeing with the stance sign (0..1) */
  agreement: number;
  /** IV(30d) − GARCH-forecast vol, in vol points; > 0 ⇒ premium rich */
  volEdgePts: number | null;
  volVerdict: 'RICH' | 'CHEAP' | 'FAIR' | null;
}

const scale = (v: number | null, unit: number): { s: number; known: boolean } => {
  if (v == null || !Number.isFinite(v)) return { s: 0, known: false };
  return { s: clamp((v / unit) * 100, -100, 100), known: true };
};

/** Stance label thresholds (same bands as the signal battery's regime label). */
export function stanceLabelFor(stance: number): string {
  if (stance >= 45) return 'RISK-ON';
  if (stance >= 18) return 'CONSTRUCTIVE';
  if (stance > -18) return 'TWO-WAY';
  if (stance > -45) return 'DEFENSIVE';
  return 'RISK-OFF';
}

/**
 * Fuse every pillar into one stance. Directional pillars (trend, models, flow,
 * derivatives, positions) carry the stance; the vol edge is reported
 * separately because it answers "which premium side", not "which direction".
 */
export function fusePillars(input: PillarFusionInput, ivEdgePts: number | null): PillarFusionOutput {
  const pillars: Pillar[] = [];

  // ── trend ────────────────────────────────────────────────────────────────
  {
    const parts: { label: string; v: number | null; unit: number; w: number }[] = [
      { label: 'Kalman trend', v: input.kalmanZ, unit: 1.5, w: 0.4 },
      { label: 'MACD (σ units)', v: input.macdSigma, unit: 1.2, w: 0.25 },
      { label: 'Forecast drift', v: input.driftPct, unit: 2.0, w: 0.35 },
    ];
    let acc = 0;
    let wsum = 0;
    let known = 0;
    const drivers: Pillar['drivers'] = [];
    for (const p of parts) {
      if (p.v == null || !Number.isFinite(p.v)) continue;
      const s = scale(p.v, p.unit).s;
      acc += s * p.w;
      wsum += p.w;
      known++;
      drivers.push({ label: p.label, value: p.v, contribution: r2(s * p.w / parts.reduce((a, b) => a + b.w, 0), 1) ?? 0 });
    }
    pillars.push({
      id: 'trend',
      label: 'Trend & momentum',
      score: wsum > 0 ? Math.round(acc / wsum) : 0,
      confidence: Math.round((known / parts.length) * 100),
      drivers,
    });
  }

  // ── models (the P(up) panel + regime prior) ─────────────────────────────
  {
    const parts: { label: string; v: number | null; unit: number; w: number }[] = [
      { label: 'ML P(up)', v: input.mlPUp == null ? null : (input.mlPUp - 0.5) * 2, unit: 1, w: 0.3 },
      { label: 'Mixed-MC fan P(up)', v: input.fanPUp == null ? null : (input.fanPUp - 0.5) * 2, unit: 1, w: 0.25 },
      { label: 'Climatology P(up)', v: input.climPUp == null ? null : (input.climPUp - 0.5) * 2, unit: 1, w: 0.2 },
      { label: 'HMM regime', v: input.hmmScore, unit: 100, w: 0.25 },
    ];
    let acc = 0;
    let wsum = 0;
    let known = 0;
    const drivers: Pillar['drivers'] = [];
    for (const p of parts) {
      if (p.v == null || !Number.isFinite(p.v)) continue;
      const s = scale(p.v, p.unit).s;
      acc += s * p.w;
      wsum += p.w;
      known++;
      drivers.push({ label: p.label, value: p.v, contribution: r2(s * p.w / 0.99, 1) ?? 0 });
    }
    pillars.push({
      id: 'models',
      label: 'Model room (P↑ + regime)',
      score: wsum > 0 ? Math.round(acc / wsum) : 0,
      confidence: Math.round((known / parts.length) * 100),
      drivers,
    });
  }

  // ── flow ─────────────────────────────────────────────────────────────────
  {
    const parts: { label: string; v: number | null; unit: number; w: number }[] = [
      { label: 'Buy share', v: input.buyShare == null ? null : (input.buyShare - 0.5) * 2, unit: 0.6, w: 0.3 },
      { label: 'CVD slope', v: input.cvdSlope, unit: 1.2, w: 0.35 },
      { label: 'Flow signals', v: input.flowSignals, unit: 100, w: 0.35 },
    ];
    let acc = 0;
    let wsum = 0;
    let known = 0;
    const drivers: Pillar['drivers'] = [];
    for (const p of parts) {
      if (p.v == null || !Number.isFinite(p.v)) continue;
      const s = scale(p.v, p.unit).s;
      acc += s * p.w;
      wsum += p.w;
      known++;
      drivers.push({ label: p.label, value: p.v, contribution: r2(s * p.w / 1.0, 1) ?? 0 });
    }
    pillars.push({
      id: 'flow',
      label: 'Order flow & tape',
      score: wsum > 0 ? Math.round(acc / wsum) : 0,
      confidence: Math.round((known / parts.length) * 100),
      drivers,
    });
  }

  // ── derivatives (gamma / perps / structure signals) ──────────────────────
  {
    const parts: { label: string; v: number | null; unit: number; w: number }[] = [
      { label: 'Gamma & structure signals', v: input.derivativesSignals, unit: 100, w: 0.6 },
      { label: 'Signal-battery regime', v: input.signalsRegime, unit: 100, w: 0.4 },
    ];
    let acc = 0;
    let wsum = 0;
    let known = 0;
    const drivers: Pillar['drivers'] = [];
    for (const p of parts) {
      if (p.v == null || !Number.isFinite(p.v)) continue;
      const s = scale(p.v, p.unit).s;
      acc += s * p.w;
      wsum += p.w;
      known++;
      drivers.push({ label: p.label, value: p.v, contribution: r2(s * p.w / 1.0, 1) ?? 0 });
    }
    pillars.push({
      id: 'derivatives',
      label: 'Dealer gamma & structure',
      score: wsum > 0 ? Math.round(acc / wsum) : 0,
      confidence: Math.round((known / parts.length) * 100),
      drivers,
    });
  }

  // ── positions (book alignment — needs the stance, computed two-pass) ─────
  const stance0 = (() => {
    const w = { trend: 26, models: 22, flow: 18, derivatives: 14 } as const;
    let acc = 0;
    let wsum = 0;
    for (const p of pillars) {
      if (p.id === 'positions') continue;
      acc += p.score * w[p.id];
      wsum += w[p.id];
    }
    return wsum > 0 ? acc / wsum : 0;
  })();

  {
    const netDir = input.netDeltaUsd == null || !Number.isFinite(input.netDeltaUsd) ? null : Math.sign(input.netDeltaUsd);
    const alignment =
      netDir == null || stance0 === 0 ? 0 : netDir * Math.sign(stance0) * clamp(Math.abs(stance0) / 45, 0.3, 1) * 60;
    const health = input.healthAvg == null ? 0 : (input.healthAvg - 50) * 0.6;
    const alertPenalty = Math.min(40, input.alertsCritical * 15);
    const exposure =
      input.marginUtilPct == null ? 0 : -clamp((input.marginUtilPct - 60) / 40, 0, 1) * 25;
    const score = Math.round(clamp(alignment + health - alertPenalty + exposure, -100, 100));
    const drivers: Pillar['drivers'] = [
      { label: 'Book direction vs stance', value: alignment, contribution: r2(alignment, 1) ?? 0 },
      { label: 'Avg position health', value: input.healthAvg ?? 0, contribution: r2(health, 1) ?? 0 },
      { label: 'Critical alerts', value: input.alertsCritical, contribution: -alertPenalty },
      { label: 'Margin utilization %', value: input.marginUtilPct ?? 0, contribution: r2(exposure, 1) ?? 0 },
    ];
    pillars.push({
      id: 'positions',
      label: 'Paper book alignment',
      score: input.positionsCount === 0 ? 0 : score,
      confidence: input.positionsCount === 0 ? 0 : 100,
      drivers,
    });
  }

  // ── stance + confidence ──────────────────────────────────────────────────
  const weights: Record<Pillar['id'], number> = { trend: 26, models: 22, flow: 18, derivatives: 14, positions: 10 };
  let acc = 0;
  let wsum = 0;
  for (const p of pillars) {
    acc += p.score * weights[p.id];
    wsum += weights[p.id];
  }
  const stance = Math.round(clamp(acc / Math.max(1e-9, wsum), -100, 100));
  // agreement: the share of total weighted pillar MAGNITUDE on the stance's side
  let agreeMag = 0;
  let totalMag = 0;
  for (const p of pillars) {
    const w = weights[p.id];
    const mag = w * Math.abs(p.score);
    totalMag += mag;
    if (p.score * stance > 0) agreeMag += mag;
  }
  const agreement = totalMag > 0 ? clamp(agreeMag / totalMag, 0, 1) : 0;
  const confidence = Math.round(clamp(agreement * 100 * (0.55 + 0.45 * Math.abs(stance) / 80), 4, 97));

  const volEdgePts = ivEdgePts == null || !Number.isFinite(ivEdgePts) ? null : +ivEdgePts.toFixed(2);
  const volVerdict =
    volEdgePts == null ? null : volEdgePts > 2 ? 'RICH' : volEdgePts < -2 ? 'CHEAP' : 'FAIR';

  return {
    pillars,
    stance,
    stanceLabel: stanceLabelFor(stance),
    confidence,
    agreement,
    volEdgePts,
    volVerdict,
  };
}

// ── strategy fit ────────────────────────────────────────────────────────────

export interface StrategyFitContext {
  stance: number;
  stanceLabel: string;
  /** IV − GARCH forecast, vol points; > 0 premium rich */
  volEdgePts: number | null;
  /** −100..+100 expected vol direction (GARCH h vs now) */
  volDirection: number | null;
  hmmLabel: string | null;
  trendLabel: 'UP' | 'DOWN' | 'FLAT' | null;
  ivRank: number | null;
  fundingPctile: number | null;
}

export interface StrategyFit {
  id: string;
  name: string;
  category: StrategyCategory;
  view: StrategyView;
  complexity: number;
  /** 0..100 fit under the current decision context */
  score: number;
  why: string[];
}

const VIEW_DIRECTIONAL: Partial<Record<StrategyView, 1 | -1>> = { bullish: 1, bearish: -1 };

/** Score the whole strategy catalog against the decision context (pure). */
export function scoreStrategies(
  catalog: StrategySpec[],
  ctx: StrategyFitContext,
  limit = 6,
): StrategyFit[] {
  const stanceN = clamp(ctx.stance, -100, 100) / 100;
  const edge = ctx.volEdgePts == null ? 0 : clamp(ctx.volEdgePts / 8, -1.5, 1.5);
  const volDir = ctx.volDirection == null ? 0 : clamp(ctx.volDirection / 100, -1, 1);
  const out: StrategyFit[] = [];
  for (const s of catalog) {
    let score = 40;
    const why: string[] = [];
    // view vs stance
    const dir = VIEW_DIRECTIONAL[s.view];
    if (dir) {
      const align = dir * stanceN;
      score += align * 34;
      if (Math.abs(align) > 0.3) {
        why.push(
          align > 0
            ? `stance ${ctx.stanceLabel} agrees with the ${s.view} view`
            : `stance ${ctx.stanceLabel} opposes the ${s.view} view`,
        );
      }
    } else if (s.view === 'neutral') {
      const fit = 1 - Math.abs(stanceN);
      score += fit * 18;
      why.push(`two-way stance (${ctx.stanceLabel}) favors non-directional structure`);
    } else if (s.view === 'volatile') {
      score += volDir * 22;
      why.push(ctx.volDirection && volDir > 0.15 ? 'vol forecast expands' : ctx.volDirection && volDir < -0.15 ? 'vol forecast compresses' : 'vol view neutral');
    } else if (s.view === 'low-vol') {
      score += -volDir * 22;
    }
    // vol edge (premium side)
    if (edge !== 0) {
      const seller = s.category === 'income' || s.category === 'volatility' || s.tags.includes('credit');
      const buyer = s.category === 'direction' || s.tags.includes('debit') || s.category === '0dte';
      if (edge > 0 && seller) {
        score += edge * 14;
        why.push(`IV rich vs GARCH forecast (+${ctx.volEdgePts?.toFixed(1)} pts) — premium selling`);
      } else if (edge > 0 && buyer) {
        score -= edge * 9;
        why.push(`IV rich (+${ctx.volEdgePts?.toFixed(1)} pts) — premium is against the buyer`);
      } else if (edge < 0 && buyer) {
        score += -edge * 14;
        why.push(`IV cheap vs GARCH forecast (${ctx.volEdgePts?.toFixed(1)} pts) — premium is on sale`);
      } else if (edge < 0 && seller) {
        score -= -edge * 9;
        why.push(`IV cheap (${ctx.volEdgePts?.toFixed(1)} pts) — sellers underpaid`);
      }
    }
    // HMM regime
    const hmm = ctx.hmmLabel;
    if (hmm === 'extreme' || hmm === 'volatile') {
      if (s.category === 'protection') {
        score += 10;
        why.push(`${hmm} regime — protection is the house special`);
      }
      if (s.category === 'income' || s.view === 'low-vol') score -= 8;
      if (s.category === '0dte') score -= 5;
    } else if (hmm === 'calm' || hmm === 'trending') {
      if (s.category === '0dte') {
        score += 6;
        why.push(`${hmm} regime — 0DTE speed is tradable`);
      }
      if (s.category === 'protection') score -= 3;
    }
    // trend vs category
    if (ctx.trendLabel && ctx.trendLabel !== 'FLAT') {
      if (s.category === 'direction') score += 4;
      if (s.category === 'income') score -= 2;
    } else if (ctx.trendLabel === 'FLAT') {
      if (s.view === 'neutral' || s.category === 'income') score += 3;
      if (s.category === 'direction') score -= 3;
    }
    // funding carry
    if (ctx.fundingPctile != null && s.category === 'perpetual') {
      if (ctx.fundingPctile >= 85 && ctx.stance > 15) {
        score += 7;
        why.push(`funding percentile ${Math.round(ctx.fundingPctile)} — carry harvest`);
      } else if (ctx.fundingPctile <= 15 && ctx.stance < -15) {
        score += 5;
        why.push(`funding percentile ${Math.round(ctx.fundingPctile)} — longs get paid`);
      }
    }
    // IV rank guardrail
    if (ctx.ivRank != null) {
      if (ctx.ivRank >= 70 && s.category === 'income') score += 4;
      if (ctx.ivRank <= 30 && s.category === 'direction') score += 4;
    }
    // hygiene
    if (s.tags.includes('defined-risk')) score += 3;
    if (s.complexity >= 4) score -= (s.complexity - 3) * 2.5;
    if (Math.abs(score - 40) < 0.5 && why.length === 0) why.push('no strong context match');
    out.push({
      id: s.id,
      name: s.name,
      category: s.category,
      view: s.view,
      complexity: s.complexity,
      score: Math.round(clamp(score, 0, 100)),
      why: why.slice(0, 3),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── actions ────────────────────────────────────────────────────────────────

export type HubActionKind = 'deploy' | 'hedge' | 'trim' | 'harvest' | 'wait';

export interface HubAction {
  id: string;
  kind: HubActionKind;
  title: string;
  rationale: string;
  strategyIds: string[];
  numbers: { label: string; value: number | null }[];
}

export interface ActionContext {
  fusion: PillarFusionOutput;
  strategyFit: StrategyFit[];
  hmmLabel: string | null;
  hmmProb: number | null;
  ouStretchZ: number | null;
  trendLabel: 'UP' | 'DOWN' | 'FLAT' | null;
  kellyHalf: number | null;
  cvar95Pct: number | null;
  fundingPctile: number | null;
  ivRank: number | null;
  alertsCritical: number;
  positionsCount: number;
}

/** The action battery — the "what do I do right now" list (pure). */
export function deriveActions(ctx: ActionContext): HubAction[] {
  const actions: HubAction[] = [];
  const f = ctx.fusion;
  const top = (pred: (s: StrategyFit) => boolean): string[] =>
    ctx.strategyFit.filter(pred).slice(0, 3).map((s) => s.id);

  // 1. book emergencies first
  if (ctx.alertsCritical > 0) {
    actions.push({
      id: 'resolve-alerts',
      kind: 'trim',
      title: `Resolve ${ctx.alertsCritical} critical position alert${ctx.alertsCritical > 1 ? 's' : ''} first`,
      rationale: 'Critical triggers on live paper positions outrank any new deployment — the desk is already carrying risk that the fusion engine wants gone.',
      strategyIds: [],
      numbers: [{ label: 'critical alerts', value: ctx.alertsCritical }],
    });
  }

  // 2. the headline deployment
  if (Math.abs(f.stance) >= 45 && f.confidence >= 55) {
    const dir = f.stance > 0 ? 'upside' : 'downside';
    actions.push({
      id: 'press-edge',
      kind: 'deploy',
      title: `Press the ${dir} edge — deploy top-fit structures at ≤ half-Kelly`,
      rationale: `Stance ${f.stance} (${f.stanceLabel}) with ${f.confidence}% confidence and ${(f.agreement * 100).toFixed(0)}% pillar agreement — the room agrees. Size with the Kelly block, not with feelings.`,
      strategyIds: top((s) => Math.sign(VIEW_DIRECTIONAL[s.view] ?? 0) === Math.sign(f.stance)),
      numbers: [
        { label: 'stance', value: f.stance },
        { label: 'confidence %', value: f.confidence },
        { label: 'half-Kelly size', value: ctx.kellyHalf },
      ],
    });
  } else if (f.volVerdict === 'RICH' && Math.abs(f.stance) < 45) {
    actions.push({
      id: 'sell-rich-vol',
      kind: 'harvest',
      title: 'Sell the rich premium — income & volatility structures',
      rationale: `IV sits ${f.volEdgePts} pts over the GARCH forecast — the market is paying for fear the models don't forecast. Structured premium selling with defined risk.`,
      strategyIds: top((s) => s.category === 'income' || s.category === 'volatility'),
      numbers: [
        { label: 'vol edge pts', value: f.volEdgePts },
        { label: 'IV rank', value: ctx.ivRank },
        { label: 'GARCH-σ forecast %', value: null },
      ],
    });
  } else if (f.volVerdict === 'CHEAP' && Math.abs(f.stance) >= 18) {
    actions.push({
      id: 'buy-cheap-vol',
      kind: 'deploy',
      title: 'Buy the cheap premium in your direction',
      rationale: `IV sits ${f.volEdgePts} pts UNDER the GARCH forecast while the stance is ${f.stanceLabel} — convexity is on sale exactly when direction pays.`,
      strategyIds: top((s) => s.category === 'direction'),
      numbers: [
        { label: 'vol edge pts', value: f.volEdgePts },
        { label: 'stance', value: f.stance },
        { label: 'confidence %', value: f.confidence },
      ],
    });
  }

  // 3. violent regime ⇒ defense
  if ((ctx.hmmLabel === 'extreme' || ctx.hmmLabel === 'volatile') && (ctx.hmmProb ?? 0) > 0.5) {
    actions.push({
      id: 'regime-defense',
      kind: 'hedge',
      title: `Hedge the ${ctx.hmmLabel} regime (P=${Math.round((ctx.hmmProb ?? 0) * 100)}%)`,
      rationale: `The HMM says the market is in its ${ctx.hmmLabel} state with ${(ctx.hmmProb ?? 0 * 100).toFixed(0)}% probability and fat Merton tails (${ctx.cvar95Pct != null ? `CVaR₉₅ ${ctx.cvar95Pct}%` : 'tail mass elevated'}) — protection before expression.`,
      strategyIds: top((s) => s.category === 'protection'),
      numbers: [
        { label: 'HMM state prob', value: ctx.hmmProb },
        { label: 'CVaR 95 %', value: ctx.cvar95Pct },
      ],
    });
  }

  // 4. stretched rubber band
  if (ctx.ouStretchZ != null && Math.abs(ctx.ouStretchZ) > 2 && Math.abs(f.stance) < 30) {
    actions.push({
      id: 'mean-reversion',
      kind: 'harvest',
      title: `Fade the ${ctx.ouStretchZ > 0 ? 'stretch' : 'flush'} — mean-reversion structure`,
      rationale: `OU stretch ${ctx.ouStretchZ.toFixed(1)}σ from the pull level with the trend pillar too weak (${ctx.trendLabel ?? 'FLAT'}) to carry continuation — the rubber band is the trade.`,
      strategyIds: top((s) => s.view === 'neutral' || s.category === 'income'),
      numbers: [{ label: 'OU stretch σ', value: ctx.ouStretchZ }],
    });
  }

  // 5. no edge ⇒ say so
  if (f.confidence < 40) {
    actions.push({
      id: 'stand-aside',
      kind: 'wait',
      title: 'Stand aside — the room does not agree',
      rationale: `Pillar agreement is only ${(f.agreement * 100).toFixed(0)}% and confidence ${f.confidence}%: the model room, the flow, and the dealer positioning are telling different stories. Waiting is a position.`,
      strategyIds: [],
      numbers: [
        { label: 'agreement %', value: Math.round(f.agreement * 100) },
        { label: 'confidence %', value: f.confidence },
      ],
    });
  }

  // 6. flat book + funding extremes ⇒ carry
  if (ctx.positionsCount === 0 && ctx.fundingPctile != null && ctx.fundingPctile >= 90 && f.stance > 15) {
    actions.push({
      id: 'carry-harvest',
      kind: 'harvest',
      title: 'Harvest the extreme funding',
      rationale: `Funding percentile ${Math.round(ctx.fundingPctile)} with a constructive stance — shorts collect while premium structures pay.`,
      strategyIds: top((s) => s.category === 'perpetual'),
      numbers: [{ label: 'funding percentile', value: ctx.fundingPctile }],
    });
  }

  // never leave the desk without an answer
  if (actions.length === 0) {
    actions.push({
      id: 'no-edge',
      kind: 'wait',
      title: 'No standing edge — hold, keep size small',
      rationale: `The stance is ${f.stanceLabel} (${f.stance}) at ${f.confidence}% confidence with ${(f.agreement * 100).toFixed(0)}% pillar agreement and the vol edge is ${f.volVerdict ?? 'unmeasured'}: nothing lines up. Waiting for the pillars to agree beats paying to guess.`,
      strategyIds: [],
      numbers: [
        { label: 'stance', value: f.stance },
        { label: 'confidence %', value: f.confidence },
        { label: 'vol edge pts', value: f.volEdgePts },
      ],
    });
  }

  return actions.slice(0, 5);
}

export { STRATEGIES };
