// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · structures — every standard structure as a SHAPE, not a line
// (Part 11 ch5): the P&L surface over (spot move, vol move) morphs as you
// scroll the catalog, and the expiration diagram is just the surface's last
// slice. Legs are marked with Black–Scholes at the CURRENT smile so the
// "bets" are visible: straddles are a hill (gamma), calendars sink with time,
// risk reversals ride the tilt.
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice } from './bs';

export interface StrategyLeg {
  kind: 'call' | 'put' | 'stock';
  dir: 1 | -1;
  /** strike as a fraction of spot (ignored for stock) */
  K: number;
  /** days to expiry at entry */
  days: number;
  qty: number;
}

export interface StrategyDef {
  id: string;
  name: string;
  family: string;
  /** the one-line mental model */
  idea: string;
  legs: StrategyLeg[];
  /** what the structure bets on — the desk's "bets" card */
  bets: { gamma: '+' | '−' | '0'; vega: '+' | '−' | '0'; delta: '+' | '−' | '0'; theta: '+' | '−' | '0'; skew: string };
}

const L = (kind: StrategyLeg['kind'], dir: 1 | -1, K: number, days: number, qty = 1): StrategyLeg => ({ kind, dir, K, days, qty });

export const STRATEGY_CATALOG: StrategyDef[] = [
  { id: 'longCall', name: 'Long call', family: 'directional', idea: 'the hockey stick — unlimited upside, premium at risk', legs: [L('call', 1, 1, 30)], bets: { delta: '+', gamma: '+', vega: '+', theta: '−', skew: 'long right wing' } },
  { id: 'longPut', name: 'Long put', family: 'directional', idea: 'the mirrored stick — crash insurance', legs: [L('put', 1, 1, 30)], bets: { delta: '−', gamma: '+', vega: '+', theta: '−', skew: 'long left wing' } },
  { id: 'coveredCall', name: 'Covered call', family: 'income', idea: 'stock minus a call: capped upside, premium now', legs: [L('stock', 1, 0, 0), L('call', -1, 1, 30)], bets: { delta: '+', gamma: '−', vega: '−', theta: '+', skew: 'short right wing' } },
  { id: 'protectivePut', name: 'Protective put', family: 'insurance', idea: 'stock plus a put: the floor under the house', legs: [L('stock', 1, 0, 0), L('put', 1, 0.95, 30)], bets: { delta: '+', gamma: '+', vega: '+', theta: '−', skew: 'long left wing' } },
  { id: 'syntheticLong', name: 'Synthetic long (conversion)', family: 'parity', idea: 'put + stock − call = the forward — parity made visible', legs: [L('put', -1, 1, 30), L('stock', 1, 0, 0), L('call', 1, 1, 30)], bets: { delta: '+', gamma: '0', vega: '0', theta: '0', skew: 'none — it IS the forward' } },
  { id: 'bullCallSpread', name: 'Bull call spread', family: 'directional', idea: 'buy 100Δ-strike call, sell the 110% — finance the bet', legs: [L('call', 1, 1, 30), L('call', -1, 1.1, 30)], bets: { delta: '+', gamma: '0', vega: '0', theta: '0', skew: 'long left, short right' } },
  { id: 'bearPutSpread', name: 'Bear put spread', family: 'directional', idea: 'buy the 100% put, sell the 90% — the bear on a budget', legs: [L('put', 1, 1, 30), L('put', -1, 0.9, 30)], bets: { delta: '−', gamma: '0', vega: '0', theta: '0', skew: 'short left, long right' } },
  { id: 'longStraddle', name: 'Long straddle', family: 'volatility', idea: 'call + put at the money — pure movement, direction unknown', legs: [L('call', 1, 1, 30), L('put', 1, 1, 30)], bets: { delta: '0', gamma: '+', vega: '+', theta: '−', skew: 'both wings' } },
  { id: 'longStrangle', name: 'Long strangle', family: 'volatility', idea: 'wings apart (95/105): cheaper, needs a bigger break', legs: [L('call', 1, 1.05, 30), L('put', 1, 0.95, 30)], bets: { delta: '0', gamma: '+', vega: '+', theta: '−', skew: 'both wings, more volga' } },
  { id: 'shortIronCondor', name: 'Short iron condor', family: 'income', idea: 'sell the 95/105 strangle, buy the 90/110 fence — the carry trade', legs: [L('put', -1, 0.95, 30), L('call', -1, 1.05, 30), L('put', 1, 0.9, 30), L('call', 1, 1.1, 30)], bets: { delta: '0', gamma: '−', vega: '−', theta: '+', skew: 'short both wings' } },
  { id: 'longButterfly', name: 'Long butterfly', family: 'pin', idea: 'buy 95/105, sell two 100s — the pin-risk bet', legs: [L('call', 1, 0.95, 30), L('call', -1, 1, 30, 2), L('call', 1, 1.05, 30)], bets: { delta: '0', gamma: '−', vega: '0', theta: '+', skew: 'short the body, long nothing' } },
  { id: 'riskReversal', name: 'Risk reversal (25Δ)', family: 'skew', idea: 'sell the 25Δ put, buy the 25Δ call — the skew itself', legs: [L('put', -1, 0.93, 30), L('call', 1, 1.07, 30)], bets: { delta: '0', gamma: '0', vega: '0', theta: '0', skew: 'THE skew trade' } },
  { id: 'calendar', name: 'Calendar (30/60)', family: 'term', idea: 'sell 30d, buy 60d ATM — bet the term structure steepens', legs: [L('call', -1, 1, 30), L('call', 1, 1, 60)], bets: { delta: '0', gamma: '−', vega: '+', theta: '0', skew: 'long back, short front' } },
  { id: 'ratio1x2', name: 'Call ratio 1×2', family: 'directional', idea: 'buy the 100%, sell two 110%s — finance the upside, cap it', legs: [L('call', 1, 1, 30), L('call', -1, 1.1, 30, 2)], bets: { delta: '+', gamma: '−', vega: '−', theta: '+', skew: 'short right wing, doubled' } },
  { id: 'backspread', name: 'Call backspread 2×1', family: 'directional', idea: 'sell one ATM, buy two OTM — convex upside, financed', legs: [L('call', -1, 1, 30), L('call', 1, 1.1, 30, 2)], bets: { delta: '0', gamma: '+', vega: '+', theta: '−', skew: 'long right wing, doubled' } },
  { id: 'box', name: 'Box (synthetic forward)', family: 'parity', idea: '1.0–1.1 box: bull spread + bear spread = PV(0.1) — arbitrage anchor', legs: [L('call', 1, 1, 30), L('call', -1, 1.1, 30), L('put', 1, 1.1, 30), L('put', -1, 1, 30)], bets: { delta: '0', gamma: '0', vega: '0', theta: '0', skew: 'none — it IS the discount factor' } },
];

/** Entry premium of a structure (mark at S0, σ0) — negative ⇒ credit. */
export function strategyPremium(def: StrategyDef, S0: number, sigma0: number, r: number, q: number): number {
  let prem = 0;
  for (const leg of def.legs) {
    if (leg.kind === 'stock') {
      prem += leg.dir * leg.qty * S0;
    } else {
      prem += leg.dir * leg.qty * bsPrice(leg.kind === 'call', S0, leg.K * S0, leg.days / 365, r, q, sigma0);
    }
  }
  return prem;
}

/** Payoff at expiry of the EARLIEST maturity (the classic T-diagram slice). */
export function strategyPayoffAtExpiry(def: StrategyDef, S0: number, xs: number[], r: number, q: number): number[] {
  const earliest = Math.min(...def.legs.filter((l) => l.kind !== 'stock').map((l) => l.days));
  return xs.map((x) => {
    const S = S0 * x;
    let v = 0;
    for (const leg of def.legs) {
      if (leg.kind === 'stock') v += leg.dir * leg.qty * S;
      else if (leg.days === earliest) {
        v += leg.dir * leg.qty * (leg.kind === 'call' ? Math.max(S - leg.K * S0, 0) : Math.max(leg.K * S0 - S, 0));
      }
      // legs of LATER maturities are marked at their remaining BS value
      else {
        const tau = Math.max((leg.days - earliest) / 365, 1e-9);
        // rough mark: same sigma — the diagram is a teaching slice
        v += leg.dir * leg.qty * bsPrice(leg.kind === 'call', S, leg.K * S0, tau, r, q, 0.4);
      }
    }
    return v;
  });
}

/**
 * The P&L surface over (spot move %, vol move in points) after `horizonDays`:
 * revalue every leg at (S0·(1+x), σ0 + Δσ·0.01, T−h) minus entry premium.
 */
export function strategyPnlSurface(
  def: StrategyDef,
  S0: number,
  sigma0: number,
  r: number,
  q: number,
  spotMoves: number[],
  volMoves: number[],
  horizonDays: number,
): number[][] {
  const prem = strategyPremium(def, S0, sigma0, r, q);
  // values[spotIdx][volIdx]
  const values: number[][] = [];
  for (let xi = 0; xi < spotMoves.length; xi++) {
    const S = S0 * (1 + spotMoves[xi]);
    const row: number[] = [];
    for (let vi = 0; vi < volMoves.length; vi++) {
      const sigma = Math.max(0.01, sigma0 + volMoves[vi] * 0.01);
      let v = 0;
      for (const leg of def.legs) {
        if (leg.kind === 'stock') {
          v += leg.dir * leg.qty * S;
        } else {
          const tau = Math.max((leg.days - horizonDays) / 365, 1e-6);
          v += leg.dir * leg.qty * bsPrice(leg.kind === 'call', S, leg.K * S0, tau, r, q, sigma);
        }
      }
      row.push(v - prem);
    }
    values.push(row);
  }
  return values;
}

/** Greeks of the whole structure at entry (sum of legs). */
export function strategyGreeks(
  def: StrategyDef,
  S0: number,
  sigma0: number,
  r: number,
  q: number,
  greeks: {
    delta: (call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number) => number;
    gamma: (S: number, K: number, T: number, r: number, q: number, sigma: number) => number;
    vega: (S: number, K: number, T: number, r: number, q: number, sigma: number) => number;
    theta: (call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number) => number;
  },
): { delta: number; gamma: number; vega: number; thetaDay: number } {
  let d = 0;
  let g = 0;
  let v = 0;
  let th = 0;
  for (const leg of def.legs) {
    if (leg.kind === 'stock') {
      d += leg.dir * leg.qty;
      continue;
    }
    const T = leg.days / 365;
    d += leg.dir * leg.qty * greeks.delta(leg.kind === 'call', S0, leg.K * S0, T, r, q, sigma0);
    g += leg.dir * leg.qty * greeks.gamma(S0, leg.K * S0, T, r, q, sigma0);
    v += leg.dir * leg.qty * greeks.vega(S0, leg.K * S0, T, r, q, sigma0);
    th += (leg.dir * leg.qty * greeks.theta(leg.kind === 'call', S0, leg.K * S0, T, r, q, sigma0)) / 365;
  }
  return { delta: d, gamma: g, vega: v, thetaDay: th };
}
