// ─────────────────────────────────────────────────────────────────────────────
// The Strategy Lab → Script Lab bridge (EXPERIMENTAL).
//
// Takes an options strategy from the 131-strategy catalog (legs: calls, puts,
// everlasting perp-options, perps, spot) and COMPILES it into VolScript —
// Pine-v5-style code the unified studio runs natively. The structure's
// mark-to-market P&L plots below the price chart, its code sits in the Pine
// editor where the AI desk can rewrite it, and every input stays editable.
//
// Valuation rules (documented in the generated header):
//   • call / put legs  — Black-Scholes (r=0, crypto convention) at the iv
//                       input, time to expiry from real bar timestamps.
//   • perp_option legs — everlasting natives: a ROLLING synthetic expiry
//                       equal to the funding period (t = funding/365.25).
//   • spot / perp legs — linear exposure (close − entry close); funding and
//                       carry are ignored.
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice } from './builtins';
import type { StrategySpec, StrategyLegSpec } from '../strategies';

export interface CompileOpts {
  /** default implied vol rendered into the script's iv input (decimal) */
  iv?: number;
  /** default entry bar index rendered into the script's entryB input */
  entryBar?: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 31_557_600_000; // 365.25 d

function fmt(x: number): string {
  if (!Number.isFinite(x)) return 'na';
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(6)));
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const LEG_COLORS = ['color.teal', 'color.amber', 'color.violet', 'color.sky', 'color.rose', 'color.emerald'];

/** true when the leg is an option the Black-Scholes pricer can mark */
function isOptionLeg(kind: StrategyLegSpec['kind']): kind is 'call' | 'put' | 'perp_option' {
  return kind === 'call' || kind === 'put' || kind === 'perp_option';
}

/**
 * Compile a catalog strategy into a complete VolScript indicator. The script
 * is fully self-contained: entry marks are captured with ta.valuewhen at the
 * entryB input, every leg marks bar-by-bar, and the structure P&L plots in a
 * sub pane below the price chart.
 */
export function compileStrategyToScript(spec: StrategySpec, opts: CompileOpts = {}): string {
  const iv = fmt(opts.iv ?? 0.6);
  const entryBar = Math.max(0, Math.round(opts.entryBar ?? 0));
  const L: string[] = [];

  L.push('//@version=1');
  L.push('// Strategy Lab → Script Lab bridge · EXPERIMENTAL');
  L.push(`// ${spec.name} · ${spec.legs.length} leg${spec.legs.length === 1 ? '' : 's'} · ${spec.category} · ${spec.view}`);
  L.push('// Marks: Black-Scholes (r=0) at the iv input · perp_option legs roll a');
  L.push('// synthetic expiry = funding period · spot/perp legs are linear (no funding).');
  L.push(`indicator("${esc(spec.name)} — options bridge", overlay=false)`);
  L.push('');
  L.push(`iv = input.float(${iv}, "Implied vol (decimal, 0.60 = 60%)", minval=0.05, maxval=3.0, step=0.05)`);
  L.push(`entryB = input.int(${entryBar}, "Entry bar index", minval=0)`);
  L.push('');
  L.push('entrySpot = ta.valuewhen(bar_index == entryB, close, 0)');
  L.push('entryTime = ta.valuewhen(bar_index == entryB, time, 0)');
  L.push('');

  const perLeg: string[] = [];
  spec.legs.forEach((leg, i) => {
    const n = i + 1;
    const side = leg.side === 'buy' ? 'buy' : 'sell';
    const sign = leg.side === 'buy' ? 1 : -1;
    const qty = Math.max(1, Math.round(leg.qty ?? 1));

    if (isOptionLeg(leg.kind)) {
      const mult = leg.strike ?? 1.0;
      const days = leg.expiryDays ?? (leg.kind === 'perp_option' ? undefined : 30);
      L.push(`// leg ${n} · ${side} ${qty}× ${leg.kind} · strike ${fmt(mult)}× entry spot${days !== undefined ? ` · ${days} d expiry` : leg.kind === 'perp_option' ? ' · everlasting' : ''}`);
      L.push(`k${n} = entrySpot * ${fmt(mult)}`);
      if (days !== undefined) {
        L.push(`t${n} = math.max(0, (entryTime + ${days} * ${MS_PER_DAY} - time) / ${MS_PER_YEAR})`);
      } else {
        // everlasting native: rolling synthetic expiry = the funding period
        const fundingDays = leg.fundingPeriodDays ?? 7;
        L.push(`t${n} = ${fmt(Math.max(fundingDays, 1) / 365.25)} // rolling: synthetic expiry = ${fundingDays} d funding period`);
      }
      const fn = leg.kind === 'put' ? 'options.bs_put' : 'options.bs_call';
      L.push(`m${n} = ${fn}(close, k${n}, t${n}, iv)`);
      L.push(`me${n} = ta.valuewhen(bar_index == entryB, m${n}, 0)`);
      L.push(`p${n} = (m${n} - me${n}) * ${qty} * ${sign}`);
    } else {
      // linear legs — spot / perp exposure, no strike, no decay
      L.push(`// leg ${n} · ${side} ${qty}× ${leg.kind} · linear (funding ignored)`);
      L.push(`m${n} = close`);
      L.push(`me${n} = ta.valuewhen(bar_index == entryB, m${n}, 0)`);
      L.push(`p${n} = (m${n} - me${n}) * ${qty} * ${sign}`);
    }
    perLeg.push(`p${n}`);
    L.push('');
  });

  L.push(`pnl = ${perLeg.join(' + ')}`);
  L.push('');
  L.push('plot(pnl, "Structure P&L", color.teal, 2, plot.style_area)');
  const legPlots = Math.min(perLeg.length, 6);
  if (legPlots > 1) {
    for (let i = 0; i < legPlots; i++) {
      const leg = spec.legs[i];
      const c = LEG_COLORS[i % LEG_COLORS.length];
      L.push(`plot(p${i + 1}, "leg ${i + 1} · ${leg.side} ${leg.kind}", ${c}, 1)`);
    }
  }
  L.push('plotshape(bar_index == entryB, "Entry", shape.diamond, location.top, color.amber)');
  L.push('hline(0, "Zero", color.zinc, hline.style_dotted)');
  L.push('');

  return L.join('\n');
}

// ── panel-side preview (what the structure looks like BEFORE applying) ──────

export interface BridgeLegPreview {
  kind: StrategyLegSpec['kind'];
  side: 'buy' | 'sell';
  qty: number;
  /** strike multiplier (options legs) */
  mult: number;
  /** absolute strike resolved against the entry spot */
  strikeAbs: number;
  /** expiry in days (vanilla options), undefined for everlasting/linear legs */
  expiryDays?: number;
  /** rolling synthetic expiry days for everlasting perp_option legs */
  fundingDays?: number;
  /** per-unit entry premium: BS at the entry spot (options) / spot itself (linear) */
  entryMark: number;
}

export interface BridgePreview {
  entrySpot: number;
  /** net entry premium as cash RECEIVED — positive = net credit, negative = net debit */
  netPremium: number;
  legs: BridgeLegPreview[];
  /** payoff at expiry over the spot grid, per 1 structure (P&L incl. entry premium) */
  payoff: Array<{ spot: number; value: number }>;
  breakevens: number[];
  /** best / worst over the grid — bounded by the grid, labelled as such */
  maxProfit: number;
  maxLoss: number;
  gridMin: number;
  gridMax: number;
  notes: string[];
}

/** intrinsic value of one option leg at expiry */
function intrinsicAt(kind: StrategyLegSpec['kind'], spot: number, k: number): number {
  if (kind === 'put') return Math.max(k - spot, 0);
  return Math.max(spot - k, 0); // call + perp_option (expiry-style)
}

/** entry mark of one leg, per unit */
function entryMarkOf(leg: StrategyLegSpec, spot: number, iv: number): number {
  if (leg.kind === 'call' || leg.kind === 'perp_option') {
    const years = leg.kind === 'perp_option' ? Math.max(leg.fundingPeriodDays ?? 7, 1) / 365.25 : Math.max(leg.expiryDays ?? 30, 1) / 365.25;
    return bsPrice(spot, (leg.strike ?? 1) * spot, years, iv, true);
  }
  if (leg.kind === 'put') return bsPrice(spot, (leg.strike ?? 1) * spot, Math.max(leg.expiryDays ?? 30, 1) / 365.25, iv, false);
  return spot; // spot / perp — linear
}

/**
 * Resolve a strategy at a concrete entry spot and iv for the panel preview:
 * absolute strikes, per-leg entry premiums, expiry payoff over a spot grid,
 * breakevens and grid-bounded best/worst case.
 */
export function buildBridgePreview(
  spec: StrategySpec,
  opts: { entrySpot: number; iv: number; gridPct?: number; points?: number },
): BridgePreview {
  const { entrySpot, iv } = opts;
  const gridPct = opts.gridPct ?? 0.6;
  const points = opts.points ?? 121;
  const gridMin = entrySpot * (1 - gridPct);
  const gridMax = entrySpot * (1 + gridPct);
  const notes: string[] = [];

  const legs: BridgeLegPreview[] = spec.legs.map((leg) => {
    const mark = entryMarkOf(leg, entrySpot, iv);
    return {
      kind: leg.kind,
      side: leg.side,
      qty: Math.max(1, Math.round(leg.qty ?? 1)),
      mult: leg.strike ?? 1,
      strikeAbs: (leg.strike ?? 1) * entrySpot,
      expiryDays: leg.kind === 'call' || leg.kind === 'put' ? (leg.expiryDays ?? 30) : undefined,
      fundingDays: leg.kind === 'perp_option' ? (leg.fundingPeriodDays ?? 7) : undefined,
      entryMark: mark,
    };
  });

  // cash flow at entry: sells receive, buys pay — trader convention: credit
  // positive (short straddle → +13.7 credit, long call → −6.85 debit)
  const paid = legs.reduce((acc, l) => acc + (l.side === 'buy' ? 1 : -1) * l.qty * l.entryMark, 0);
  const netPremium = -paid;

  // payoff at expiry: intrinsic(now-grid spot) − entry marks, per structure
  const payoff: Array<{ spot: number; value: number }> = [];
  for (let g = 0; g < points; g++) {
    const s = gridMin + ((gridMax - gridMin) * g) / (points - 1);
    let value = 0;
    for (let i = 0; i < spec.legs.length; i++) {
      const leg = spec.legs[i];
      const lp = legs[i];
      const sign = leg.side === 'buy' ? 1 : -1;
      const expiryValue = isOptionLeg(leg.kind) ? intrinsicAt(leg.kind, s, lp.strikeAbs) : s;
      value += sign * lp.qty * expiryValue;
    }
    // P&L at expiry = expiry value − premium paid (equivalently + credit)
    payoff.push({ spot: s, value: value - paid });
  }

  // breakevens: zero crossings on the grid (linear interpolation)
  const breakevens: number[] = [];
  for (let g = 1; g < payoff.length; g++) {
    const a = payoff[g - 1];
    const b = payoff[g];
    if ((a.value <= 0 && b.value >= 0) || (a.value >= 0 && b.value <= 0)) {
      if (a.value === b.value) continue;
      const t = -a.value / (b.value - a.value);
      if (t >= 0 && t <= 1) breakevens.push(a.spot + t * (b.spot - a.spot));
    }
  }

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const p of payoff) {
    if (p.value > maxProfit) maxProfit = p.value;
    if (p.value < maxLoss) maxLoss = p.value;
  }

  if (spec.legs.some((l) => l.kind === 'perp_option')) notes.push('everlasting legs use a rolling synthetic expiry = funding period');
  if (spec.legs.some((l) => l.kind === 'perp' || l.kind === 'spot')) notes.push('linear legs ignore funding/carry');
  if (spec.legs.some((l) => l.side === 'sell' && l.kind === 'call')) notes.push('short-call loss is unbounded — grid shows ±60% only');
  notes.push('r = 0, single flat iv across strikes');

  return { entrySpot, netPremium, legs, payoff, breakevens, maxProfit, maxLoss, gridMin, gridMax, notes };
}
