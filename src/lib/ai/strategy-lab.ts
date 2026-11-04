// ---------------------------------------------------------------------------
// strategy-lab — the Copilot's Strategy Lab engine: live optimization
// (raise POP · cut max loss · boost profit), catalog alternatives with real
// comparisons, and a teaching pack that explains every metric grounded in
// the user's ACTUAL live numbers.
//
// Pure server-side functions over the pricing core + live market state.
// Consumed by the agent toolbelt (agent-tools.ts) which anchors every run
// to real exchange data.
// ---------------------------------------------------------------------------

import type { Leg, LegKind, Side, AssetMarket } from '@/lib/types';
import { STRATEGIES, resolveStrategyLegs, type StrategySpec } from '@/lib/strategies';
import { analyzeStrategy } from '@/lib/pricing';
import { ASSET_IDS, liveMarketState, marketDataSource, primeLiveMarket } from './market-intel';

export type OptimizeGoal = 'increase_pop' | 'reduce_risk' | 'increase_profit' | 'balanced';
export const OPTIMIZE_GOALS: OptimizeGoal[] = ['increase_pop', 'reduce_risk', 'increase_profit', 'balanced'];

const ASSET_IDS_SET = new Set<string>(ASSET_IDS);
export function asLabAsset(v: unknown, fallback = 'BTC'): 'BTC' | 'ETH' | 'SOL' {
  const s = String(v ?? '').toUpperCase();
  return ASSET_IDS_SET.has(s) ? (s as 'BTC' | 'ETH' | 'SOL') : (fallback as 'BTC' | 'ETH' | 'SOL');
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

const GRID: Record<string, number> = { BTC: 500, ETH: 25, SOL: 1 };
function snap(strike: number, u: string): number {
  const step = GRID[u] ?? 1;
  return Math.max(step, Math.round(strike / step) * step);
}

function liveAssetMarket(asset: 'BTC' | 'ETH' | 'SOL'): AssetMarket {
  const s = liveMarketState()[asset];
  return {
    spot: s.spot,
    volShift: s.volShift,
    fundingRate: s.fundingRate,
    change24h: s.change24h,
    openInterest: s.openInterest,
    volume24h: s.volume24h,
  };
}

/** Normalize free-form legs into engine `Leg`s (mirrors agent-tools semantics). */
function toEngineLegs(raw: Array<Partial<Leg>>, spot: number): Leg[] {
  const KINDS: LegKind[] = ['call', 'put', 'perp_option', 'perp', 'spot'];
  const out: Leg[] = [];
  raw.slice(0, 25).forEach((r, i) => {
    const kind = KINDS.includes(r.kind as LegKind) ? (r.kind as LegKind) : 'call';
    const leg: Leg = {
      id: `lab-${i + 1}`,
      kind,
      side: r.side === 'sell' ? 'sell' : 'buy',
      qty: clampNum(r.qty, 0.001, 1000, 1),
    };
    if (kind === 'call' || kind === 'put' || kind === 'perp_option') {
      leg.strike = clampNum(r.strike, spot * 0.2, spot * 5, spot);
    }
    if (kind === 'call' || kind === 'put') leg.expiryDays = clampNum(r.expiryDays, 1, 365, 30);
    if (kind === 'perp_option') leg.fundingPeriodDays = clampNum(r.fundingPeriodDays, 1, 90, 7);
    out.push(leg);
  });
  return out;
}

/** Serializable leg spec the client can load straight into the builder. */
function legSpec(legs: Leg[]): Array<{ kind: LegKind; side: Side; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }> {
  return legs.map((l) => ({
    kind: l.kind,
    side: l.side,
    qty: +l.qty.toFixed(3),
    strike: l.strike != null ? +l.strike.toFixed(2) : undefined,
    expiryDays: l.expiryDays,
    fundingPeriodDays: l.fundingPeriodDays,
  }));
}

interface LabAnalysis {
  legCount: number;
  netPremium: number;
  isCredit: boolean;
  pop: number;
  expectedValue: number;
  riskReward: number;
  maxProfit: { kind: string; value?: number; atPrice?: number };
  maxLoss: { kind: string; value?: number; atPrice?: number };
  breakevens: number[];
  delta: number;
  thetaPerDay: number;
  marginEstimate: number;
}

function labAnalyze(legs: Leg[], underlying: 'BTC' | 'ETH' | 'SOL', market: AssetMarket, size: number): LabAnalysis {
  const a = analyzeStrategy(legs, underlying, market, size);
  const rr =
    a.riskReward ??
    (a.maxLoss.kind === 'value' && a.maxLoss.value && a.maxProfit.kind === 'value' && a.maxProfit.value
      ? Math.abs(a.maxProfit.value / a.maxLoss.value)
      : 0);
  return {
    legCount: a.legs.length,
    netPremium: a.netPremium,
    isCredit: a.isCredit,
    pop: a.pop,
    expectedValue: a.expectedValue,
    riskReward: rr,
    maxProfit: a.maxProfit,
    maxLoss: a.maxLoss,
    breakevens: a.breakevens,
    delta: a.greeks.delta,
    thetaPerDay: a.greeks.theta,
    marginEstimate: a.marginEstimate,
  };
}

// ---------------------------------------------------------------------------
// ADJUSTMENT MOVES — each transforms legs deterministically
// ---------------------------------------------------------------------------

interface Move {
  id: string;
  label: string;
  rationale: string;
  appliesTo: 'credit' | 'debit' | 'any';
  apply: (legs: Leg[], spot: number, u: string) => Leg[];
}

const PCT_STEP = 0.025; // push strikes 2.5% of spot, then snap to grid

function withOptions(legs: Leg[]): Leg[] {
  return legs.filter((l) => l.strike !== undefined && (l.kind === 'call' || l.kind === 'put' || l.kind === 'perp_option'));
}

const MOVES: Move[] = [
  {
    id: 'shorts_otm',
    label: 'Push short strikes further OTM',
    rationale: 'Moves sold strikes ~2.5% further from the money (grid-snapped): less chance of finishing in-the-money, so POP rises and decay works for you — at the cost of thinner premium collected.',
    appliesTo: 'any',
    apply: (legs, spot, u) =>
      legs.map((l) => {
        if (l.side !== 'sell' || l.strike === undefined) return l;
        const away = l.strike >= spot ? l.strike * (1 + PCT_STEP) : l.strike * (1 - PCT_STEP);
        return { ...l, strike: snap(away, u) };
      }),
  },
  {
    id: 'widen_wings',
    label: 'Widen the wings',
    rationale: 'Pushes long (protective) strikes ~2.5% further out: collects a bigger credit → higher POP and higher max profit, but max loss grows with the wider spread.',
    appliesTo: 'any',
    apply: (legs, spot, u) =>
      legs.map((l) => {
        if (l.side !== 'buy' || l.strike === undefined) return l;
        const away = l.strike >= spot ? l.strike * (1 + PCT_STEP) : l.strike * (1 - PCT_STEP);
        return { ...l, strike: snap(away, u) };
      }),
  },
  {
    id: 'narrow_wings',
    label: 'Narrow the wings',
    rationale: 'Pulls long strikes ~2.5% closer to the shorts: the spread width — and with it max loss and margin — shrinks, at the price of a smaller credit and slightly lower POP.',
    appliesTo: 'any',
    apply: (legs, spot, u) =>
      legs.map((l) => {
        if (l.side !== 'buy' || l.strike === undefined) return l;
        const toward = l.strike >= spot ? l.strike * (1 - PCT_STEP) : l.strike * (1 + PCT_STEP);
        return { ...l, strike: snap(toward, u) };
      }),
  },
  {
    id: 'shorten_tenor',
    label: 'Shorten the tenor (~0.65×)',
    rationale: 'Cuts DTE by ~35%: theta decay accelerates and there is simply less time for adverse moves, which typically raises POP for credit structures — while lowering the absolute premium at stake.',
    appliesTo: 'any',
    apply: (legs) =>
      legs.map((l) => {
        if (l.expiryDays !== undefined) return { ...l, expiryDays: Math.max(1, Math.round(l.expiryDays * 0.65)) };
        if (l.fundingPeriodDays !== undefined) return { ...l, fundingPeriodDays: Math.max(1, Math.round(l.fundingPeriodDays * 0.65)) };
        return l;
      }),
  },
  {
    id: 'extend_tenor',
    label: 'Extend the tenor (~1.5×)',
    rationale: 'Adds ~50% more DTE: more premium collected (higher max profit / EV) and more time to be right — but POP typically drops because the underlying has longer to wander off.',
    appliesTo: 'any',
    apply: (legs) =>
      legs.map((l) => {
        if (l.expiryDays !== undefined) return { ...l, expiryDays: Math.min(365, Math.round(l.expiryDays * 1.5)) };
        if (l.fundingPeriodDays !== undefined) return { ...l, fundingPeriodDays: Math.min(90, Math.round(l.fundingPeriodDays * 1.5)) };
        return l;
      }),
  },
  {
    id: 'add_tail_wings',
    label: 'Add catastrophe tail wings',
    rationale: 'Buys cheap far-OTM protection on the tail side where the structure is short risk: converts open-ended loss into a defined, capped one for the cost of a little premium.',
    appliesTo: 'any',
    apply: (legs, spot, u) => {
      const hasLongCall = legs.some((l) => l.kind === 'call' && l.side === 'buy' && l.strike !== undefined);
      const hasLongPut = legs.some((l) => l.kind === 'put' && l.side === 'buy' && l.strike !== undefined);
      const shorts = legs.filter((l) => l.side === 'sell' && l.strike !== undefined && (l.kind === 'call' || l.kind === 'put'));
      const maxShortQty = shorts.length > 0 ? Math.max(...shorts.map((l) => l.qty)) : 1;
      const worstDte = legs.reduce((m, l) => Math.max(m, l.expiryDays ?? 30), 1);
      const added: Leg[] = [];
      if (!hasLongPut) {
        added.push({ id: `lab-wing-p-${Date.now() % 100000}`, kind: 'put', side: 'buy', qty: maxShortQty, strike: snap(spot * 0.7, u), expiryDays: worstDte });
      }
      if (!hasLongCall) {
        added.push({ id: `lab-wing-c-${Date.now() % 100000}`, kind: 'call', side: 'buy', qty: maxShortQty, strike: snap(spot * 1.3, u), expiryDays: worstDte });
      }
      return added.length > 0 ? [...legs, ...added] : legs;
    },
  },
  {
    id: 'half_size',
    label: 'Cut size 50%',
    rationale: 'Halves every leg quantity: dollar max loss, margin and theta all scale down linearly — the simplest, most reliable de-risking move when structure tweaks are not enough.',
    appliesTo: 'any',
    apply: (legs) => legs.map((l) => ({ ...l, qty: +(l.qty * 0.5).toFixed(4) })),
  },
];

interface Combo {
  id: string;
  label: string;
  rationale: string;
  moves: string[];
}

const COMBOS: Combo[] = [
  {
    id: 'max_pop',
    label: 'Max-POP combo: shorts OTM + shorter tenor',
    rationale: 'Stacks the two highest-POP levers at once — short strikes pushed further out AND ~35% less time to expiry. Expect a large POP jump on a thinner credit.',
    moves: ['shorts_otm', 'shorten_tenor'],
  },
  {
    id: 'min_loss',
    label: 'Min-loss combo: narrow wings + half size',
    rationale: 'Halves exposure AND tightens spread width at the same time — max loss and margin drop by more than half, trading away premium and POP.',
    moves: ['narrow_wings', 'half_size'],
  },
  {
    id: 'max_profit',
    label: 'Max-profit combo: wider wings + longer tenor',
    rationale: 'Collects a much bigger premium with wider wings over ~50% more time — max profit and EV rise together, with more risk and lower POP as the trade-off.',
    moves: ['widen_wings', 'extend_tenor'],
  },
];

function runMoves(ids: string[], legs: Leg[], spot: number, u: string): Leg[] {
  let cur = legs;
  for (const id of ids) {
    const mv = MOVES.find((m) => m.id === id);
    if (mv) cur = mv.apply(cur, spot, u);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// OPTIMIZER
// ---------------------------------------------------------------------------

export interface OptimizeArgs {
  strategyId?: string;
  legs?: Array<Partial<Leg>>;
  underlying?: string;
  size?: number;
  goal?: string;
}

export async function optimizeStrategyPayload(args: OptimizeArgs) {
  await primeLiveMarket();
  const underlying = asLabAsset(args.underlying);
  const size = clampNum(args.size, 0.001, 10000, 1);
  const goal = (OPTIMIZE_GOALS as string[]).includes(String(args.goal)) ? (args.goal as OptimizeGoal) : 'balanced';
  const market = liveAssetMarket(underlying);
  const spot = market.spot;

  let legs: Leg[] = [];
  let name = 'Custom strategy';
  let strategyId: string | undefined;
  if (args.strategyId) {
    const spec = STRATEGIES.find((s) => s.id === args.strategyId);
    if (!spec) return { error: `unknown strategyId '${args.strategyId}'. Use search_strategies to find ids.` };
    legs = resolveStrategyLegs(spec, spot);
    name = spec.name;
    strategyId = spec.id;
  } else if (Array.isArray(args.legs) && args.legs.length > 0) {
    legs = toEngineLegs(args.legs, spot);
    name = args.strategyId ? String(args.strategyId) : 'Custom strategy';
  } else {
    return { error: 'provide either strategyId or a non-empty legs array (the user\'s current strategy legs come in the terminal context)' };
  }

  const base = labAnalyze(legs, underlying, market, size);
  const optionLegs = withOptions(legs);
  if (optionLegs.length === 0) {
    return {
      error: 'this strategy has no option legs (perp/spot only) — optimization applies to option structures. Suggest the user load an option strategy first.',
    };
  }

  interface Variant {
    moveId: string;
    label: string;
    rationale: string;
    legCount: number;
    popPct: number;
    dPop: number;
    maxProfit: { kind: string; value?: number; atPrice?: number };
    dMaxProfit: number | null;
    maxLoss: { kind: string; value?: number; atPrice?: number };
    dMaxLoss: number | null;
    expectedValue: number;
    dEv: number;
    riskReward: number;
    netPremium: number;
    loadLegs: ReturnType<typeof legSpec>;
  }

  const buildVariant = (moveId: string, label: string, rationale: string, ids: string[]): Variant | null => {
    const vLegs = runMoves(ids, legs, spot, underlying);
    if (vLegs.length === 0) return null;
    const a = labAnalyze(vLegs, underlying, market, size);
    const dMaxProfit =
      base.maxProfit.kind === 'value' && a.maxProfit.kind === 'value' && base.maxProfit.value !== undefined && a.maxProfit.value !== undefined
        ? a.maxProfit.value - base.maxProfit.value
        : null;
    const dMaxLoss =
      base.maxLoss.kind === 'value' && a.maxLoss.kind === 'value' && base.maxLoss.value !== undefined && a.maxLoss.value !== undefined
        ? a.maxLoss.value - base.maxLoss.value
        : base.maxLoss.kind !== 'value' && a.maxLoss.kind === 'value'
          ? null // unbounded → defined: huge improvement, flag via note
          : null;
    return {
      moveId,
      label,
      rationale,
      legCount: a.legCount,
      popPct: +(a.pop * 100).toFixed(1),
      dPop: +((a.pop - base.pop) * 100).toFixed(1),
      maxProfit: a.maxProfit,
      dMaxProfit: dMaxProfit === null ? null : +dMaxProfit.toFixed(2),
      maxLoss: a.maxLoss,
      dMaxLoss: dMaxLoss === null ? null : +dMaxLoss.toFixed(2),
      expectedValue: +a.expectedValue.toFixed(2),
      dEv: +(a.expectedValue - base.expectedValue).toFixed(2),
      riskReward: +a.riskReward.toFixed(2),
      netPremium: +a.netPremium.toFixed(2),
      loadLegs: legSpec(vLegs),
    };
  };

  const variants: Variant[] = [];
  for (const mv of MOVES) {
    const v = buildVariant(mv.id, mv.label, mv.rationale, [mv.id]);
    if (v) variants.push(v);
  }
  for (const c of COMBOS) {
    const v = buildVariant(c.id, c.label, c.rationale, c.moves);
    if (v) variants.push(v);
  }

  // goal-specific filtering + ranking
  const lossScore = (v: Variant) => {
    if (v.maxLoss.kind !== 'value') return -1e9; // still unbounded
    if (base.maxLoss.kind === 'value' && base.maxLoss.value) return Math.abs(v.maxLoss.value ?? 0) - Math.abs(base.maxLoss.value);
    return 1e6 - Math.abs(v.maxLoss.value ?? 0); // newly defined risk
  };
  const profitScore = (v: Variant) => (v.maxProfit.kind === 'value' ? v.maxProfit.value ?? 0 : 1e6);
  const baseProfitScore = base.maxProfit.kind === 'value' ? base.maxProfit.value ?? 0 : 1e6;

  let ranked: Variant[];
  switch (goal) {
    case 'increase_pop':
      ranked = variants.filter((v) => v.dPop > 0.5).sort((a, b) => b.dPop - a.dPop || b.dEv - a.dEv);
      break;
    case 'reduce_risk':
      ranked = variants
        .filter((v) => lossScore(v) < 0 || (base.maxLoss.kind !== 'value' && v.maxLoss.kind === 'value'))
        .sort((a, b) => lossScore(a) - lossScore(b) || b.dEv - a.dEv);
      break;
    case 'increase_profit':
      ranked = variants.filter((v) => profitScore(v) > baseProfitScore + 1 || v.dEv > 0.5).sort((a, b) => profitScore(b) - profitScore(a) || b.dEv - a.dEv);
      break;
    default: {
      const normPop = (v: Variant) => Math.max(-30, Math.min(30, v.dPop)) / 30;
      const normEv = (v: Variant) => {
        const scale = Math.max(1, Math.abs(base.expectedValue));
        return Math.max(-1, Math.min(1, v.dEv / scale));
      };
      const normLoss = (v: Variant) => {
        const bl = base.maxLoss.kind === 'value' ? Math.abs(base.maxLoss.value ?? 0) : 1e6;
        const vl = v.maxLoss.kind === 'value' ? Math.abs(v.maxLoss.value ?? 0) : 1e6;
        return Math.max(-1, Math.min(1, (vl - bl) / Math.max(1, bl)));
      };
      const normProfit = (v: Variant) => {
        const bp = base.maxProfit.kind === 'value' ? Math.abs(base.maxProfit.value ?? 0) : 1e6;
        const vp = v.maxProfit.kind === 'value' ? Math.abs(v.maxProfit.value ?? 0) : 1e6;
        return Math.max(-1, Math.min(1, (vp - bp) / Math.max(1, bp)));
      };
      ranked = [...variants]
        .map((v) => ({ v, s: normPop(v) * 0.3 + normEv(v) * 0.35 - normLoss(v) * 0.2 + normProfit(v) * 0.15 }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.v);
    }
  }

  const top = ranked.slice(0, 5);

  const rec = top[0];
  return {
    action: 'optimize_strategy',
    goal,
    goalLabel: GOAL_LABELS[goal],
    underlying,
    spot: +spot.toFixed(2),
    size,
    source: marketDataSource(),
    baseline: {
      strategyId,
      name,
      legCount: base.legCount,
      popPct: +(base.pop * 100).toFixed(1),
      netPremium: +base.netPremium.toFixed(2),
      isCredit: base.isCredit,
      expectedValue: +base.expectedValue.toFixed(2),
      riskReward: +base.riskReward.toFixed(2),
      maxProfit: base.maxProfit,
      maxLoss: base.maxLoss,
      breakevens: base.breakevens.map((b) => +b.toFixed(1)),
      marginEstimate: +base.marginEstimate.toFixed(2),
      loadLegs: legSpec(legs),
    },
    variants: top,
    recommendation: rec
      ? {
          moveId: rec.moveId,
          label: rec.label,
          why: `Best fit for "${GOAL_LABELS[goal]}": ΔPOP ${rec.dPop >= 0 ? '+' : ''}${rec.dPop}pp, ΔEV ${rec.dEv >= 0 ? '+' : ''}${rec.dEv}, Δmax loss ${
            rec.dMaxLoss === null ? 'risk now defined' : `${rec.dMaxLoss >= 0 ? '+' : ''}${rec.dMaxLoss}`
          }, Δmax profit ${rec.dMaxProfit === null ? '—' : `${rec.dMaxProfit >= 0 ? '+' : ''}${rec.dMaxProfit}`}.`,
        }
      : { moveId: '', label: 'no improving adjustment found', why: 'Every tested adjustment hurt more than it helped for this goal — the current structure is already near its efficient frontier. Consider suggest_alternatives for a different structure.' },
  };
}

const GOAL_LABELS: Record<OptimizeGoal, string> = {
  increase_pop: 'increase probability of profit',
  reduce_risk: 'decrease max loss / risk',
  increase_profit: 'increase profit potential',
  balanced: 'balanced improvement',
};

// ---------------------------------------------------------------------------
// ALTERNATIVES
// ---------------------------------------------------------------------------

export interface AlternativesArgs {
  strategyId?: string;
  legs?: Array<Partial<Leg>>;
  underlying?: string;
  size?: number;
}

export async function alternativesPayload(args: AlternativesArgs) {
  await primeLiveMarket();
  const underlying = asLabAsset(args.underlying);
  const size = clampNum(args.size, 0.001, 10000, 1);
  const market = liveAssetMarket(underlying);
  const spot = market.spot;

  let legs: Leg[] = [];
  let currentId: string | undefined;
  let currentName = 'Custom strategy';
  let currentSpec: StrategySpec | undefined;
  if (args.strategyId) {
    currentSpec = STRATEGIES.find((s) => s.id === args.strategyId);
    if (!currentSpec) return { error: `unknown strategyId '${args.strategyId}'. Use search_strategies to find ids.` };
    legs = resolveStrategyLegs(currentSpec, spot);
    currentId = currentSpec.id;
    currentName = currentSpec.name;
  } else if (Array.isArray(args.legs) && args.legs.length > 0) {
    legs = toEngineLegs(args.legs, spot);
  } else {
    return { error: 'provide either strategyId or the current legs (from the terminal context strategy)' };
  }

  const base = labAnalyze(legs, underlying, market, size);

  // candidate pool: same market view, sane complexity/legs, exclude self
  const curView = currentSpec?.view;
  let pool = STRATEGIES.filter((s) => s.id !== currentId && s.legs.length <= 6 && s.complexity <= (currentSpec?.complexity ?? 3) + 2);
  if (curView) {
    const same = pool.filter((s) => s.view === curView);
    if (same.length >= 6) pool = same;
  }
  if (pool.length === 0) return { error: 'no alternatives available in the catalog for this profile' };

  // score: tag overlap + category diversity
  const curTags = new Set((currentSpec?.tags ?? []).map((t) => t.toLowerCase()));
  const scored = pool
    .map((s) => {
      const overlap = s.tags.filter((t) => curTags.has(t.toLowerCase())).length;
      return { s, score: overlap + (s.view === curView ? 1.5 : 0) };
    })
    .sort((a, b) => b.score - a.score);

  const picked: typeof scored = [];
  const perCategory = new Map<string, number>();
  for (const x of scored) {
    const c = x.s.category;
    const n = perCategory.get(c) ?? 0;
    if (n >= 2) continue;
    perCategory.set(c, n + 1);
    picked.push(x);
    if (picked.length >= 6) break;
  }

  interface Alt {
    strategyId: string;
    name: string;
    category: string;
    view: string;
    legCount: number;
    complexity: number;
    why: string;
    popPct: number;
    dPop: number;
    maxProfit: { kind: string; value?: number; atPrice?: number };
    dMaxProfit: number | null;
    maxLoss: { kind: string; value?: number; atPrice?: number };
    dMaxLoss: number | null;
    expectedValue: number;
    dEv: number;
    riskReward: number;
    netPremium: number;
    isCredit: boolean;
    delta: number;
  }

  const alts: Alt[] = [];
  for (const { s } of picked) {
    const aLegs = resolveStrategyLegs(s, spot);
    const a = labAnalyze(aLegs, underlying, market, size);
    const dPop = +((a.pop - base.pop) * 100).toFixed(1);
    const dEv = +(a.expectedValue - base.expectedValue).toFixed(2);
    const dMaxProfit =
      base.maxProfit.kind === 'value' && a.maxProfit.kind === 'value' && base.maxProfit.value !== undefined && a.maxProfit.value !== undefined
        ? +(a.maxProfit.value - base.maxProfit.value).toFixed(2)
        : null;
    const dMaxLoss =
      base.maxLoss.kind === 'value' && a.maxLoss.kind === 'value' && base.maxLoss.value !== undefined && a.maxLoss.value !== undefined
        ? +(a.maxLoss.value - base.maxLoss.value).toFixed(2)
        : null;

    // auto-reason from the numbers
    const bits: string[] = [];
    bits.push(s.view === curView ? `keeps the same ${s.view} stance` : `switches stance to ${s.view}`);
    if (dPop >= 1.5) bits.push(`+${dPop}pp POP`);
    else if (dPop <= -1.5) bits.push(`${dPop}pp POP (harder to win, bigger wins)`);
    if (a.isCredit !== base.isCredit) bits.push(a.isCredit ? 'flips to net credit (premium in first)' : 'flips to net debit (pay up front, no margin)');
    if (dMaxLoss !== null && dMaxLoss < -50) bits.push('much smaller worst case');
    if (base.maxLoss.kind !== 'value' && a.maxLoss.kind === 'value') bits.push('turns undefined risk into defined risk');
    if (dMaxProfit !== null && dMaxProfit > 50) bits.push('far higher profit ceiling');
    bits.push(`${s.legs.length} legs · complexity ${s.complexity}/5`);

    alts.push({
      strategyId: s.id,
      name: s.name,
      category: s.category,
      view: s.view,
      legCount: a.legCount,
      complexity: s.complexity,
      why: `${s.name} ${bits.join(' · ')}.`,
      popPct: +(a.pop * 100).toFixed(1),
      dPop,
      maxProfit: a.maxProfit,
      dMaxProfit,
      maxLoss: a.maxLoss,
      dMaxLoss,
      expectedValue: +a.expectedValue.toFixed(2),
      dEv,
      riskReward: +a.riskReward.toFixed(2),
      netPremium: +a.netPremium.toFixed(2),
      isCredit: a.isCredit,
      delta: +a.delta.toFixed(2),
    });
  }

  alts.sort((a, b) => {
    const sa = (a.dPop > 0 ? 1 : 0) + (a.dEv > 0 ? 1 : 0) + (a.dMaxLoss !== null && a.dMaxLoss < 0 ? 1 : 0) + (a.dMaxProfit !== null && a.dMaxProfit > 0 ? 1 : 0);
    const sb = (b.dPop > 0 ? 1 : 0) + (b.dEv > 0 ? 1 : 0) + (b.dMaxLoss !== null && b.dMaxLoss < 0 ? 1 : 0) + (b.dMaxProfit !== null && b.dMaxProfit > 0 ? 1 : 0);
    return sb - sa;
  });

  return {
    action: 'suggest_alternatives',
    underlying,
    spot: +spot.toFixed(2),
    size,
    source: marketDataSource(),
    current: {
      strategyId: currentId,
      name: currentName,
      legCount: base.legCount,
      popPct: +(base.pop * 100).toFixed(1),
      netPremium: +base.netPremium.toFixed(2),
      isCredit: base.isCredit,
      expectedValue: +base.expectedValue.toFixed(2),
      riskReward: +base.riskReward.toFixed(2),
      maxProfit: base.maxProfit,
      maxLoss: base.maxLoss,
    },
    alternatives: alts.slice(0, 4),
    guidance:
      'Present these as a comparison table (POP, max profit, max loss, EV, credit/debit) against the current strategy, name the single best swap for the user\'s goal, and offer load_strategy for any of them. Note that delta signs show directional tilt.',
  };
}

// ---------------------------------------------------------------------------
// TEACHING PACK — every metric explained, grounded in the live numbers
// ---------------------------------------------------------------------------

export interface TeachingArgs {
  underlying?: string;
  strategyId?: string;
  legs?: Array<Partial<Leg>>;
  size?: number;
  topics?: string[];
}

interface Lesson {
  key: string;
  term: string;
  group: 'economics' | 'risk' | 'greeks' | 'market';
  valueNow: string;
  what: string;
  howComputed: string;
  howToUse: string;
  watchOut: string;
}

export async function teachingPayload(args: TeachingArgs) {
  await primeLiveMarket();
  const underlying = asLabAsset(args.underlying);
  const size = clampNum(args.size, 0.001, 10000, 1);
  const market = liveAssetMarket(underlying);
  const ms = liveMarketState()[underlying];
  const spot = market.spot;

  let legs: Leg[] | null = null;
  let stratName = '';
  if (args.strategyId) {
    const spec = STRATEGIES.find((s) => s.id === args.strategyId);
    if (spec) {
      legs = resolveStrategyLegs(spec, spot);
      stratName = spec.name;
    }
  } else if (Array.isArray(args.legs) && args.legs.length > 0) {
    legs = toEngineLegs(args.legs, spot);
    stratName = 'your strategy';
  }

  const a = legs ? labAnalyze(legs, underlying, market, size) : null;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const usd = (x: number) => `$${x >= 0 ? '' : '-'}${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const extreme = (e: { kind: string; value?: number; atPrice?: number }) =>
    e.kind === 'value' && e.value !== undefined ? `${usd(e.value)}${e.atPrice !== undefined ? ` (at spot ${e.atPrice.toFixed(0)})` : ''}` : 'unbounded (undefined risk)';

  const all: Lesson[] = [
    {
      key: 'net_premium',
      term: 'Net premium',
      group: 'economics',
      valueNow: a ? `${a.isCredit ? 'credit' : 'debit'} ${usd(Math.abs(a.netPremium))} per package` : `${underlying} ATM IV ${pct(ms.atmIv30d ?? 0)}`,
      what: 'The net cash that changes hands when the position is opened: credit means money is received (you sold more premium than you bought), debit means money is paid.',
      howComputed: 'Sum over legs of signed quantity × leg price: sold legs add, bought legs subtract.',
      howToUse: 'Credits are the income-trading engine — you keep the credit if the structure expires worthless. Debits cap your cost up front and uncap the upside. Match the choice to whether you want to be paid to wait or pay to win.',
      watchOut: 'A fat credit is not free money — it is compensation for the risk you are taking. Compare credit against max loss (that ratio IS the risk/reward).',
    },
    {
      key: 'pop',
      term: 'POP — probability of profit',
      group: 'risk',
      valueNow: a ? `${pct(a.pop)} on ${stratName}` : 'compute after loading a strategy',
      what: 'The chance, under the live volatility surface, that the structure finishes with any profit ≥ 0 at expiry.',
      howComputed: 'P&L is evaluated across the whole spot distribution at expiry (log-normal with the live ATM IV and horizon); POP is the probability mass where P&L > 0.',
      howToUse: 'POP is your hit-rate. Income sellers typically run 70–85% POP structures with small wins; buyers run 15–40% POP with asymmetry. Decide which game you are playing and size accordingly.',
      watchOut: 'High POP + negative EV = picking up pennies in front of a steamroller. Always read POP together with expected value and max loss, never alone.',
    },
    {
      key: 'expected_value',
      term: 'EV — expected value',
      group: 'risk',
      valueNow: a ? `${a.expectedValue >= 0 ? '+' : ''}${usd(a.expectedValue)} per package` : 'compute after loading a strategy',
      what: 'The probability-weighted average P&L of the structure at expiry — what you would make on average if you could repeat this exact trade many times.',
      howComputed: 'Integral of expiry P&L over the risk-neutral spot distribution (same engine as POP).',
      howToUse: 'EV is the only number that tells you if the trade has an edge. Positive EV means the structure is priced in your favour; scale size with EV, not with gut feel.',
      watchOut: 'EV says nothing about variance — a +EV trade can still be a 90% drawdown ride. Pair with max loss and margin. Note markets are close to fair: large |EV| usually means an assumption (IV, distribution) is doing the work.',
    },
    {
      key: 'max_profit',
      term: 'Max profit',
      group: 'risk',
      valueNow: a ? extreme(a.maxProfit) : '—',
      what: 'The best-case P&L of the structure at expiry, and the spot price where it happens.',
      howComputed: 'Max of the expiry payoff over all spot levels, including premiums paid/received.',
      howToUse: 'Your reward ceiling. Defined max profits (spreads, condors) tell you exactly what you are playing for; compare it to the credit collected to see if the trade pays enough.',
      watchOut: 'Max profit is usually earned exactly at pin risk zones — places where the market rarely finishes. Realistic P&L lives between breakevens, not at the peak.',
    },
    {
      key: 'max_loss',
      term: 'Max loss',
      group: 'risk',
      valueNow: a ? extreme(a.maxLoss) : '—',
      what: 'The worst-case P&L at expiry and where it occurs. "Unbounded/undefined" means no cap exists (naked shorts).',
      howComputed: 'Min of the expiry payoff over all spot levels. Buying protective wings converts undefined into defined.',
      howToUse: 'This is the number you size your account against — never risk more on one structure than you can lose without flinching. Defined-risk structures let you compute it exactly; that is why the platform margin-checks them.',
      watchOut: 'Undefined-risk structures look cheap on margin until the gap happens. Crypto gaps. If max loss is unbounded, treat the position as an accident waiting for a tweet.',
    },
    {
      key: 'breakevens',
      term: 'Breakevens',
      group: 'risk',
      valueNow: a && a.breakevens.length > 0 ? a.breakevens.map((b) => b.toFixed(0)).join(' / ') : '—',
      what: 'The spot price(s) where the structure finishes at exactly zero P&L — the borders of your profit zone.',
      howComputed: 'Spot levels where expiry payoff (premium included) crosses zero.',
      howToUse: 'Breakevens tell you how far price can move against you before you lose. Compare them to the expected move over the horizon: breakevens outside the expected move = high-POP trade.',
      watchOut: 'Breakevens move with time (theta) and IV. A breakeven that looks safe today can be violated by a single red CPI print.',
    },
    {
      key: 'risk_reward',
      term: 'Risk/reward',
      group: 'risk',
      valueNow: a ? `${a.riskReward.toFixed(2)} : 1` : '—',
      what: 'Max profit divided by max loss — how many dollars you win per dollar you risk.',
      howComputed: '|max profit| / |max loss| for defined-risk structures.',
      howToUse: 'Combined with POP it defines your trading style: high R:R + low POP = buyer/lottos; low R:R + high POP = income seller. A structure is attractive when POP × (1+R:R) > 1.',
      watchOut: 'R:R is meaningless when risk is undefined — a naked call sale has infinite R:R computation nonsense. Define risk first, then compare.',
    },
    {
      key: 'margin',
      term: 'Margin estimate',
      group: 'economics',
      valueNow: a ? `${usd(a.marginEstimate)} per package` : '—',
      what: 'The collateral the venue will lock to hold this position — your capital-at-work per package.',
      howComputed: 'Aggregate stress-based estimate across the structure (width of defined-risk spreads, premium at risk for longs).',
      howToUse: 'Return on margin — EV / margin — is how professional desks rank structures. The same dollar EV on half the margin is twice the trade.',
      watchOut: 'Margin can rise after entry when vol spikes or positions grow. Keep portfolio margin headroom of 2–3× your worst day.',
    },
    {
      key: 'delta',
      term: 'Delta',
      group: 'greeks',
      valueNow: a ? `${a.delta.toFixed(2)} per package` : '—',
      what: 'P&L sensitivity to a $1 move in spot — and, roughly, the option\'s probability of finishing in the money.',
      howComputed: '∂price/∂spot summed over legs (Black-Scholes for dated, closed-form for everlasting).',
      howToUse: 'Direction dial. Net delta 0.30 ≈ being long 30% of the notional in spot. Sell premium with small |delta| for income; buy delta when you have a view. Hedge residual delta with perps.',
      watchOut: 'Delta is a snapshot: it changes as spot moves (that is gamma). A delta-hedged book at 10:00 is not hedged at 10:05 after a 2% rip.',
    },
    {
      key: 'gamma',
      term: 'Gamma',
      group: 'greeks',
      valueNow: legs ? 'see strategy analytics for live value' : `${underlying} dealers absorb flow near expiry`,
      what: 'How fast delta itself changes when spot moves — the curvature of your P&L. Short gamma = your position fights accelerating moves.',
      howComputed: 'Second derivative ∂²price/∂spot² summed over legs; explodes near expiry near the strike.',
      howToUse: 'Income structures are typically short gamma: you profit from stillness and get punished by momentum. Flip to long gamma (buy options) when you expect a violent move — 0DTE and event trades are pure gamma bets.',
      watchOut: 'Short gamma near expiry is how accounts die: each hedge lock-in loses more than the last. Cap short-gamma size before catalysts.',
    },
    {
      key: 'vega',
      term: 'Vega',
      group: 'greeks',
      valueNow: legs ? 'see strategy analytics for live value' : `${underlying} ATM IV ${pct(ms.atmIv30d ?? 0)}`,
      what: 'P&L sensitivity to a 1-point (1%) change in implied volatility.',
      howComputed: '∂price/∂iv summed over legs; scales with √time and proximity to the money.',
      howToUse: 'Buy vega when IV is cheap vs realized (volatility risk premium is thin); sell vega when IV is rich. Structures like calendars and condors let you isolate vega from direction.',
      watchOut: 'Vega P&L depends on the WHOLE surface moving — skew can move against you even when ATM IV stays flat.',
    },
    {
      key: 'theta',
      term: 'Theta',
      group: 'greeks',
      valueNow: a ? `${a.thetaPerDay.toFixed(2)} USD/day per package` : '—',
      what: 'Daily P&L from time decay — the income engine of premium selling and the bleed of premium buying.',
      howComputed: '−∂price/∂t summed over legs; grows quadratically into expiry.',
      howToUse: 'Theta is rent collected for carrying risk. Match theta income to your risk budget: a structure earning $50/day with $10k max loss is a slow machine; check it survives one adverse day.',
      watchOut: 'Theta is not linear — it accelerates brutally in the last days, which also concentrates gamma risk. High theta near expiry and near the money = gamma knife-edge.',
    },
    {
      key: 'iv',
      term: 'Implied volatility (ATM)',
      group: 'market',
      valueNow: `${pct(ms.atmIv30d ?? 0)} 30d ATM`,
      what: 'The market\'s forward-looking volatility forecast, priced from live option quotes — the single most important input in every metric above.',
      howComputed: 'Backed out of real venue quotes (Deribit/Bybit/OKX/Aevo/Paradex/Derive); the platform shifts the whole surface live.',
      howToUse: 'IV percentile is your mean-reversion signal: sell premium when IV ranks high (vol is expensive), buy it when IV ranks low. Compare IV to realized vol to find the volatility risk premium.',
      watchOut: 'IV prints around events are rational, not mispriced: a 90% IV into CPI is the market telling you a move is coming. Shorting it "because it\'s high" is fighting information.',
    },
    {
      key: 'skew',
      term: 'Skew',
      group: 'market',
      valueNow: legs ? 'see live surface' : `${underlying} put/call skew live`,
      what: 'How IV differs across strikes — typically crypto puts carry richer IV than calls because crash fear outbids upside greed.',
      howComputed: 'Difference between OTM put IV and OTM call IV at matched delta on the live surface.',
      howToUse: 'Rich put skew makes put-credit structures better paid; flat or inverted (call) skew after a crash is the classic signal to buy cheap calls. Skew is a tradable spread, not just context.',
      watchOut: 'Skew can invert hard in squeezes — structures priced on "puts are always richer" assumptions break exactly then.',
    },
    {
      key: 'term_structure',
      term: 'IV term structure',
      group: 'market',
      valueNow: 'live surface on the Gamma & Flow view',
      what: 'IV across expiries: contango (long-dated richer) in calm markets, backwardation (front expiries rich) when fear is concentrated now.',
      howComputed: 'ATM IV ladder across listed expiries from venue data.',
      howToUse: 'Backwardation = sell near-dated richness against cheaper deferred months (calendar structures). Contango = the reverse. Term structure trades are the cleanest pure-vol positions.',
      watchOut: 'Front-month IV can stay elevated far longer than expected during cascades — "rich" can get richer.',
    },
    {
      key: 'expected_move',
      term: 'Expected move',
      group: 'market',
      valueNow: `derived from ${pct(ms.atmIv30d ?? 0)} 30d IV`,
      what: 'The ± band the market implies for spot over a horizon — one standard deviation under the live IV.',
      howComputed: 'spot × IV × √(days/365).',
      howToUse: 'The yardstick for every strike decision: short strikes OUTSIDE the expected move push POP up; breakevens beyond it mean you need a bigger-than-implied move to win.',
      watchOut: 'One sigma is 68%, not certainty — and real crypto distributions have fat tails far beyond what the log-normal math admits.',
    },
    {
      key: 'funding',
      term: 'Funding rate',
      group: 'market',
      valueNow: `${((ms.fundingRate ?? 0) * 100).toFixed(3)}%/period`,
      what: 'The periodic payment between long and short perp holders — the temperature gauge of leveraged positioning.',
      howComputed: 'Live perp basis from venue data (positive = longs pay shorts).',
      howToUse: 'High positive funding = crowded longs = contrarian caution for delta-long structures and a tailwind for short-perp carries. Everlasting option funding embeds this directly.',
      watchOut: 'Funding flips fast in squeezes; carry strategies built on today\'s funding can invert overnight.',
    },
    {
      key: 'gex',
      term: 'GEX — gamma exposure',
      group: 'market',
      valueNow: 'live on the Gamma & Flow view',
      what: 'Dealer hedging flow implied by aggregate option gamma: where market-makers must buy dips / sell rips (positive GEX, sticky prices) or chase the move (negative GEX, acceleration).',
      howComputed: 'Sum of open interest × gamma × spot factor across the live chain, mapped per strike and expiry.',
      howToUse: 'Trade WITH the GEX regime: in positive GEX ranges, sell premium and fade extremes at the range walls; when net GEX flips negative, cut short gamma and let long-convexity structures run. The gamma flip level is your regime line.',
      watchOut: 'GEX models are approximations of dealer books, not gospel — zero-expiry OI decays fast, so the map redraws daily.',
    },
    {
      key: 'liquidity',
      term: 'Liquidity score',
      group: 'economics',
      valueNow: 'per-venue live spreads on the Chain view',
      what: 'How executable the structure is: spread width, listed depth and venue quality around your strikes.',
      howComputed: 'Per-leg scoring of moneyness × tenor × venue book quality from live quotes.',
      howToUse: 'Structures only pay if you can enter AND exit: route legs to the venue with the tightest real book (the platform\'s router does this automatically for paper fills), and prefer strikes near the money near expiries with fat OI.',
      watchOut: 'A model price on an illiquid far-OTM strike is fiction — you will pay the whole spread to exit in a hurry. Liquidity is a hidden cost that quietly eats thin-edge structures.',
    },
  ];

  const wanted = Array.isArray(args.topics) && args.topics.length > 0 ? new Set(args.topics.map((t) => t.toLowerCase())) : null;
  const lessons = wanted ? all.filter((l) => wanted.has(l.key) || wanted.has(l.term.toLowerCase())) : all;

  return {
    action: 'explain_metrics',
    underlying,
    spot: +spot.toFixed(2),
    source: marketDataSource(),
    strategy: a
      ? {
          name: stratName,
          popPct: +(a.pop * 100).toFixed(1),
          expectedValue: +a.expectedValue.toFixed(2),
          netPremium: +a.netPremium.toFixed(2),
          isCredit: a.isCredit,
          maxProfit: a.maxProfit,
          maxLoss: a.maxLoss,
          breakevens: a.breakevens.map((b) => +b.toFixed(1)),
          riskReward: +a.riskReward.toFixed(2),
          marginEstimate: +a.marginEstimate.toFixed(2),
        }
      : null,
    market: {
      atmIv30dPct: +((ms.atmIv30d ?? 0) * 100).toFixed(1),
      fundingRatePct: +((ms.fundingRate ?? 0) * 100).toFixed(4),
      change24hPct: +((ms.change24h ?? 0) * 100).toFixed(2),
      openInterestUsd: ms.openInterest,
      volume24hUsd: ms.volume24h,
    },
    lessonCount: lessons.length,
    lessons,
    combinations: [
      'POP × EV: high POP with negative EV is the classic premium-selling trap — the desk treats positive EV as non-negotiable, then maximizes POP within it.',
      'POP vs risk/reward: they trade off almost linearly — push POP up and your wins shrink. Pick your point on the spectrum consciously, size deliberately.',
      'Theta pays you for gamma risk: the daily carry is the rent for the acceleration you are short. Size theta income against ONE adverse day, not the average day.',
      'IV feeds every probability: POP, EV and expected move all inherit the live surface — when IV reprices, your "safe" 80% POP structure may already be a 65% one.',
      'Breakevens vs expected move is the fastest trade-quality check: profits you must reach beyond the implied move require the market to be wrong, not just you to be right.',
      'GEX regime selects the strategy family: positive-gamma ranges reward sellers (condors, credit spreads); negative-gamma regimes reward long convexity (butterflies, calendars, long vega).',
    ],
    teachingDirective:
      'TEACH with these live numbers: for each metric quote the user\'s actual valueNow, explain what/howComputed/howToUse/watchOut in plain language with a concrete trading implication, and show how the metrics combine (combinations list). Ground every lesson in their strategy and live market. End with 2–3 concrete actions they can take on this platform with these numbers.',
  };
}
