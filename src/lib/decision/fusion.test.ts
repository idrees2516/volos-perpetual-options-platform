// ─────────────────────────────────────────────────────────────────────────────
// DECISION · fusion tests — the pure decision math: pillars → stance, strategy
// fit under every context family, and the action battery.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { fusePillars, scoreStrategies, deriveActions, stanceLabelFor } from './fusion';
import type { StrategyFit } from './fusion';
import { STRATEGIES } from '@/lib/strategies';

const fullInput = {
  signalsRegime: 0,
  kalmanZ: 0,
  macdSigma: 0,
  driftPct: 0,
  hmmScore: 0,
  mlPUp: 0.5,
  fanPUp: 0.5,
  climPUp: 0.5,
  buyShare: 0.5,
  cvdSlope: 0,
  flowSignals: 0,
  derivativesSignals: 0,
  netDeltaUsd: null,
  marginUtilPct: null,
  alertsCritical: 0,
  positionsCount: 0,
  healthAvg: null,
};

describe('fusePillars', () => {
  it('all-neutral inputs ⇒ stance 0, TWO-WAY, zero confidence', () => {
    const out = fusePillars(fullInput, 0);
    expect(out.stance).toBe(0);
    expect(out.stanceLabel).toBe('TWO-WAY');
    expect(out.confidence).toBeLessThan(30);
    expect(out.pillars.map((p) => p.id)).toEqual(['trend', 'models', 'flow', 'derivatives', 'positions']);
  });

  it('everything bullish ⇒ strong RISK-ON stance, high agreement', () => {
    const out = fusePillars(
      {
        ...fullInput,
        kalmanZ: 1.4,
        macdSigma: 1.0,
        driftPct: 2.5,
        mlPUp: 0.62,
        fanPUp: 0.63,
        climPUp: 0.6,
        hmmScore: 40,
        buyShare: 0.56,
        cvdSlope: 1.0,
        flowSignals: 55,
        derivativesSignals: 50,
        signalsRegime: 48,
      },
      1,
    );
    expect(out.stance).toBeGreaterThan(45);
    expect(out.stanceLabel).toBe('RISK-ON');
    expect(out.agreement).toBeGreaterThan(0.7);
    expect(out.confidence).toBeGreaterThan(50);
    for (const p of out.pillars.slice(0, 4)) expect(p.score).toBeGreaterThan(0);
  });

  it('everything bearish ⇒ mirror-image RISK-OFF stance', () => {
    const out = fusePillars(
      {
        ...fullInput,
        kalmanZ: -1.4,
        macdSigma: -1.0,
        driftPct: -2.5,
        mlPUp: 0.38,
        fanPUp: 0.37,
        climPUp: 0.4,
        buyShare: 0.44,
        cvdSlope: -1.0,
        flowSignals: -55,
        derivativesSignals: -50,
        signalsRegime: -48,
      },
      1,
    );
    expect(out.stance).toBeLessThan(-45);
    expect(out.stanceLabel).toBe('RISK-OFF');
    expect(out.pillars.find((p) => p.id === 'trend')!.score).toBeLessThan(0);
  });

  it('mixed signals ⇒ two-way stance with middling agreement', () => {
    const out = fusePillars(
      { ...fullInput, kalmanZ: 1.5, driftPct: 2.5, mlPUp: 0.3, fanPUp: 0.32, flowSignals: -60 },
      0,
    );
    expect(Math.abs(out.stance)).toBeLessThan(30);
    expect(out.agreement).toBeLessThan(0.8);
  });

  it('null inputs degrade pillar confidence without breaking the stance', () => {
    const out = fusePillars(
      { ...fullInput, kalmanZ: null, macdSigma: null, driftPct: null, mlPUp: null },
      null,
    );
    expect(out.pillars.find((p) => p.id === 'trend')!.confidence).toBe(0);
    expect(Number.isFinite(out.stance)).toBe(true);
    expect(out.volEdgePts).toBeNull();
    expect(out.volVerdict).toBeNull();
  });

  it('book alignment: same-direction book scores positive, opposite scores negative', () => {
    const up = fusePillars(
      { ...fullInput, kalmanZ: 1.4, driftPct: 2.5, positionsCount: 2, netDeltaUsd: 10_000, healthAvg: 70 },
      0,
    );
    const down = fusePillars(
      { ...fullInput, kalmanZ: 1.4, driftPct: 2.5, positionsCount: 2, netDeltaUsd: -10_000, healthAvg: 70 },
      0,
    );
    const pos = up.pillars.find((p) => p.id === 'positions')!.score;
    const neg = down.pillars.find((p) => p.id === 'positions')!.score;
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeLessThan(pos);
    // critical alerts flip the pillar hard negative
    const alerting = fusePillars(
      { ...fullInput, positionsCount: 2, netDeltaUsd: 10_000, alertsCritical: 3 },
      0,
    );
    expect(alerting.pillars.find((p) => p.id === 'positions')!.score).toBeLessThan(0);
  });

  it('vol edge classification: RICH / CHEAP / FAIR thresholds', () => {
    expect(fusePillars(fullInput, 5).volVerdict).toBe('RICH');
    expect(fusePillars(fullInput, -5).volVerdict).toBe('CHEAP');
    expect(fusePillars(fullInput, 1).volVerdict).toBe('FAIR');
  });

  it('stance labels use the shared bands', () => {
    expect(stanceLabelFor(80)).toBe('RISK-ON');
    expect(stanceLabelFor(20)).toBe('CONSTRUCTIVE');
    expect(stanceLabelFor(0)).toBe('TWO-WAY');
    expect(stanceLabelFor(-25)).toBe('DEFENSIVE');
    expect(stanceLabelFor(-70)).toBe('RISK-OFF');
  });
});

describe('scoreStrategies', () => {
  const ctx = {
    stance: 0,
    stanceLabel: 'TWO-WAY',
    volEdgePts: 0,
    volDirection: null,
    hmmLabel: null,
    trendLabel: null,
    ivRank: null,
    fundingPctile: null,
  };

  it('strong bullish stance ranks directional bullish strategies above bearish ones', () => {
    const out = scoreStrategies(STRATEGIES, { ...ctx, stance: 60, stanceLabel: 'RISK-ON' });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].score).toBeGreaterThan(55);
    const bullishViews = out.filter((s) => s.view === 'bullish').length;
    const bearishViews = out.filter((s) => s.view === 'bearish').length;
    expect(bullishViews).toBeGreaterThan(bearishViews);
    for (const s of out) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(s.why.length).toBeGreaterThan(0);
    }
  });

  it('rich IV ranks income/volatility (premium-selling) structures up', () => {
    const rich = scoreStrategies(STRATEGIES, { ...ctx, stance: 8, volEdgePts: 6 });
    const fair = scoreStrategies(STRATEGIES, { ...ctx, stance: 8, volEdgePts: 0 });
    const incomeRich = rich.filter((s) => s.category === 'income' || s.category === 'volatility').length;
    const incomeFair = fair.filter((s) => s.category === 'income' || s.category === 'volatility').length;
    expect(incomeRich).toBeGreaterThan(incomeFair);
    expect(rich[0].why.join(' ')).toMatch(/rich|premium/i);
  });

  it('cheap IV ranks direction (premium-buying) structures up', () => {
    const cheap = scoreStrategies(STRATEGIES, { ...ctx, stance: 25, volEdgePts: -6 });
    expect(cheap.filter((s) => s.category === 'direction').length).toBeGreaterThan(
      scoreStrategies(STRATEGIES, { ...ctx, stance: 25, volEdgePts: 6 }).filter((s) => s.category === 'direction').length,
    );
  });

  it('extreme HMM regime ranks protection up and income down', () => {
    const extreme = scoreStrategies(STRATEGIES, { ...ctx, hmmLabel: 'extreme' });
    const calm = scoreStrategies(STRATEGIES, { ...ctx, hmmLabel: 'calm' });
    const protExt = extreme.filter((s) => s.category === 'protection').length;
    const protCalm = calm.filter((s) => s.category === 'protection').length;
    expect(protExt).toBeGreaterThan(protCalm);
  });

  it('deterministic + bounded + covers the whole catalog without crashing', () => {
    const a = scoreStrategies(STRATEGIES, { ...ctx, stance: -60, volEdgePts: 4, hmmLabel: 'volatile', trendLabel: 'DOWN', fundingPctile: 92, ivRank: 80 });
    const b = scoreStrategies(STRATEGIES, { ...ctx, stance: -60, volEdgePts: 4, hmmLabel: 'volatile', trendLabel: 'DOWN', fundingPctile: 92, ivRank: 80 });
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
  });
});

describe('deriveActions', () => {
  const mkFit = (over: Partial<StrategyFit>[]): StrategyFit[] =>
    over.map((o) => ({
      id: 'x',
      name: 'X',
      category: 'direction',
      view: 'bullish',
      complexity: 2,
      score: 60,
      why: [],
      ...o,
    })) as StrategyFit[];

  const baseCtx = {
    fusion: fusePillars(fullInput, 0),
    strategyFit: mkFit([]),
    hmmLabel: null,
    hmmProb: null,
    ouStretchZ: null,
    trendLabel: null,
    kellyHalf: 0.1,
    cvar95Pct: -4,
    fundingPctile: null,
    ivRank: null,
    alertsCritical: 0,
    positionsCount: 0,
  };

  it('low-agreement context produces the stand-aside action', () => {
    const actions = deriveActions({ ...baseCtx, fusion: fusePillars(fullInput, 0) });
    const wait = actions.find((a) => a.kind === 'wait');
    expect(wait).toBeDefined();
    expect(wait!.id).toBe('stand-aside');
    expect(wait!.rationale).toMatch(/agree/i);
  });

  it('strong confident stance produces the press-the-edge deployment', () => {
    const fusion = fusePillars(
      {
        ...fullInput,
        kalmanZ: 1.5,
        macdSigma: 1.0,
        driftPct: 3.0,
        hmmScore: 40,
        mlPUp: 0.65,
        fanPUp: 0.65,
        climPUp: 0.62,
        buyShare: 0.56,
        cvdSlope: 0.8,
        flowSignals: 55,
        derivativesSignals: 50,
        signalsRegime: 50,
      },
      0,
    );
    expect(fusion.stance).toBeGreaterThanOrEqual(45);
    const actions = deriveActions({
      ...baseCtx,
      fusion,
      strategyFit: mkFit([{ id: 'long-call', name: 'Long Call', view: 'bullish', category: 'direction' }]),
    });
    const deploy = actions.find((a) => a.id === 'press-edge');
    expect(deploy).toBeDefined();
    expect(deploy!.kind).toBe('deploy');
    expect(deploy!.strategyIds).toContain('long-call');
    expect(deploy!.title).toMatch(/upside/i);
  });

  it('rich vol with no directional edge produces the premium-selling action', () => {
    const fusion = fusePillars(fullInput, 6);
    const actions = deriveActions({
      ...baseCtx,
      fusion,
      strategyFit: mkFit([{ id: 'iron-condor', name: 'Iron Condor', category: 'income' }]),
    });
    const sell = actions.find((a) => a.id === 'sell-rich-vol');
    expect(sell).toBeDefined();
    expect(sell!.strategyIds).toContain('iron-condor');
  });

  it('violent HMM regime produces the hedge action', () => {
    const actions = deriveActions({
      ...baseCtx,
      hmmLabel: 'extreme',
      hmmProb: 0.7,
      strategyFit: mkFit([{ id: 'protective-put', name: 'Protective Put', category: 'protection' }]),
    });
    const hedge = actions.find((a) => a.id === 'regime-defense');
    expect(hedge).toBeDefined();
    expect(hedge!.kind).toBe('hedge');
    expect(hedge!.strategyIds).toContain('protective-put');
  });

  it('critical position alerts produce the trim-first action and it leads the list', () => {
    const actions = deriveActions({ ...baseCtx, alertsCritical: 2 });
    expect(actions[0].id).toBe('resolve-alerts');
    expect(actions[0].title).toMatch(/2 critical/i);
  });

  it('stretched OU with weak trend produces the mean-reversion action', () => {
    const actions = deriveActions({ ...baseCtx, ouStretchZ: 2.6, trendLabel: 'FLAT' });
    const mr = actions.find((a) => a.id === 'mean-reversion');
    expect(mr).toBeDefined();
    expect(mr!.title).toMatch(/stretch|flush/i);
  });

  it('extreme funding with a flat book and a constructive stance produces the carry-harvest action', () => {
    const fusion = fusePillars({ ...fullInput, kalmanZ: 1.5, driftPct: 2.5, mlPUp: 0.58, fanPUp: 0.58 }, 0);
    const actions = deriveActions({ ...baseCtx, fusion, fundingPctile: 95, positionsCount: 0 });
    expect(actions.find((a) => a.id === 'carry-harvest')).toBeDefined();
  });

  it('never returns an empty action battery (no-edge fallback)', () => {
    // a quiet but confident context: no rule fires ⇒ the no-edge action appears
    const fusion = fusePillars({ ...fullInput, kalmanZ: 0.2, driftPct: 0.2, mlPUp: 0.52 }, 0);
    const actions = deriveActions({ ...baseCtx, fusion, positionsCount: 5 });
    expect(fusion.confidence).toBeGreaterThanOrEqual(40); // stand-aside does not fire
    expect(actions.length).toBeGreaterThanOrEqual(1);
    const noEdge = actions.find((a) => a.id === 'no-edge');
    expect(noEdge).toBeDefined();
    expect(noEdge!.kind).toBe('wait');
    expect(noEdge!.rationale).toMatch(/nothing lines up/i);
  });

  it('never returns more than 5 actions', () => {
    const fusion = fusePillars(fullInput, 6);
    const actions = deriveActions({
      ...baseCtx,
      fusion,
      alertsCritical: 3,
      hmmLabel: 'volatile',
      hmmProb: 0.6,
      ouStretchZ: 2.2,
      fundingPctile: 96,
      positionsCount: 0,
    });
    expect(actions.length).toBeLessThanOrEqual(5);
  });
});
