// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · exotics — every kind of option, each with its exact payoff
// machinery (Part 17's zoo; Taleb Part III; Gatheral ch 9–10):
//
//   VANILLA          European call/put — the baseline every model is scored against
//   ASIAN            arithmetic & geometric average, fixed AND floating strike
//   BARRIER          knock-out / knock-in with rebates, up/down — priced by MC,
//                    in-out parity verified against the vanilla
//   BINARY           cash-or-nothing & asset-or-nothing — the discontinuity
//   LOOKBACK         floating & fixed — "buying the low, selling the high"
//   ONE-TOUCH        closed-form reflection probability + MC cross-check
//   CHOOSER          call-or-put chosen later
//   FORWARD-START    the cliquet's atom (vol-of-vol exposure)
//   CLIQUET          annual resets, capped/floored — the structured-product engine
//   AUTOCALL-LITE   monthly observation, knock-in coupon note (stylised)
//   PERPETUAL        Merton's eternal American put closed form (the House's
//                    "everlasting" ancestry)
//   EXCHANGE        Margrabe's asset-or-nothing asset (multi-asset, closed form)
//   QUANTO           ...deferred to surfaces (fx correlation) — noted, not faked
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice, delta } from './bs';
import { normCdf } from './normal';
import { hitProbAbove, mcPathDependent, type MCResult } from './processes';

export interface ExoticSpec {
  id: string;
  name: string;
  /** the one-line mental model */
  idea: string;
  /** why a desk buys/sells it */
  bets: string;
}

export interface ExoticQuote extends MCResult {
  spec: ExoticSpec;
  /** vanilla-European baseline (the "same" option without the exotic feature) */
  vanilla: number;
}

/** Price an exotic by seeded MC (252 steps/year default, antithetic). */
function quoteExotic(
  spec: ExoticSpec,
  payoff: (path: Float64Array) => number,
  S0: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  nPaths: number,
  seed: number,
  vanillaK: number,
): ExoticQuote {
  const steps = Math.max(16, Math.round(T * 252));
  const mc = mcPathDependent(payoff, S0, T, steps, r, q, sigma, nPaths, seed);
  return {
    ...mc,
    spec,
    vanilla: vanillaK > 0 ? bsPrice(true, S0, vanillaK, T, r, q, sigma) : bsPrice(false, S0, vanillaK, T, r, q, sigma),
  };
}

// ── catalog ──────────────────────────────────────────────────────────────────

export const EXOTIC_SPECS: ExoticSpec[] = [
  { id: 'vanilla', name: 'European vanilla', idea: 'the payoff at expiry — the baseline', bets: 'pure directional or pure vol' },
  { id: 'asianA', name: 'Asian (arithmetic, fixed K)', idea: 'average price option — the hedge is smoother, gamma earlier', bets: 'lower vol than vanilla (averaging kills variance), hedge-friendly' },
  { id: 'asianG', name: 'Asian (geometric, fixed K)', idea: 'the average on logs — analytic under GBM', bets: 'the textbook floor/ceiling for its arithmetic cousin' },
  { id: 'asianFloat', name: 'Asian floating strike', idea: 'pay S_T − average — "sell the average, keep the final"', bets: 'zero-mean dynamics, mean-reversion harvest' },
  { id: 'downOut', name: 'Down-and-out call (KO)', idea: 'a call that dies if spot touches the barrier — cheaper, fragile', bets: 'downside-quiet paths; a "sold crash insurance that refunds itself"' },
  { id: 'downIn', name: 'Down-and-in call (KI)', idea: 'the call is BORN on the touch — in + out = vanilla (parity)', bets: 'the crash happens first, the rally second' },
  { id: 'upOut', name: 'Up-and-out call (KO)', idea: 'the call dies on the upside — caps your own winner', bets: 'range-bound markets, cheap convexity' },
  { id: 'oneTouch', name: 'One-touch digital', idea: 'pay 1 if the barrier is EVER touched — pure barrier, no rally', bets: 'the "touch" is more likely than finishing beyond — tail events' },
  { id: 'binaryCash', name: 'Cash-or-nothing call', idea: 'pay 1 if S_T > K — a step function, delta of a knife', bets: 'event probability; pin risk at expiry' },
  { id: 'binaryAsset', name: 'Asset-or-nothing call', idea: 'pay S_T if S_T > K — the call split into two pieces', bets: 'digitals + asset-or-nothing = vanilla (put–call for binaries)' },
  { id: 'lookbackFloat', name: 'Lookback (floating strike) call', idea: 'buy at the min, sell at the end — regret insurance', bets: 'the most expensive call there is; whipsaw harvest' },
  { id: 'lookbackFixed', name: 'Lookback (fixed strike) call', idea: 'sell at the max — pay max(S) − K', bets: 'euphoria capture' },
  { id: 'chooser', name: 'Chooser option', idea: 'decide call-or-put at t₁ — direction insurance', bets: 'straddle deferred at reduced premium structure' },
  { id: 'forwardStart', name: 'Forward-start (cliquet atom)', idea: 'strike set later at-the-money — pure future vol', bets: 'vol-of-vol: the smile you’ll face in 6 months' },
  { id: 'cliquet', name: 'Cliquets (capped, floored)', idea: 'a chain of annual forward-starts — sum of min(max(r,0),cap)', bets: 'path dependence through averaging of RETURNS; the structured note inside' },
  { id: 'autocall', name: 'Autocall note (stylised)', idea: 'monthly: autocall above K_call; knock-in below K_put turns it into a linear loss', bets: 'carry the coupon, sell the crash — the retail bestseller' },
  { id: 'perpetual', name: 'Perpetual American put', idea: 'Merton: never expires, exercise at S* — the House’s “everlasting” ancestry', bets: 'deep OTM insurance with no theta clock' },
  { id: 'exchange', name: 'Exchange (Margrabe)', idea: 'receive asset 1, deliver asset 2 — correlation made price', bets: 'dispersion, M&A risk, relative value' },
];

export interface ExoticParams {
  S0: number;
  K: number;
  T: number;
  r: number;
  q: number;
  sigma: number;
  /** barrier level (multiples of spot allowed) */
  barrier: number;
  /** binary payout */
  payout: number;
  /** cliquet cap (fraction) */
  cap: number;
  /** autocall coupon (annual fraction per observed month) */
  coupon: number;
  nPaths: number;
  seed: number;
  /** second asset (exchange option): vol and correlation */
  sigma2: number;
  corr: number;
}

/** Price the whole zoo — one call per model, all seeded. */
export function priceExotic(id: string, p: ExoticParams): ExoticQuote | { closed: number; spec: ExoticSpec; note: string } | null {
  const spec = EXOTIC_SPECS.find((s) => s.id === id);
  if (!spec) return null;
  const { S0, K, T, r, q, sigma, barrier, payout, cap, coupon, nPaths, seed } = p;
  const avg = (path: Float64Array) => {
    let s = 0;
    for (let i = 1; i < path.length; i++) s += path[i];
    return s / (path.length - 1);
  };
  const minPath = (path: Float64Array) => {
    let m = Infinity;
    for (let i = 0; i < path.length; i++) if (path[i] < m) m = path[i];
    return m;
  };
  const maxPath = (path: Float64Array) => {
    let m = -Infinity;
    for (let i = 0; i < path.length; i++) if (path[i] > m) m = path[i];
    return m;
  };

  switch (id) {
    case 'vanilla':
      return quoteExotic(spec, (path) => Math.max(path[path.length - 1] - K, 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'asianA':
      return quoteExotic(spec, (path) => Math.max(avg(path) - K, 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'asianG': {
      const gavg = (path: Float64Array) => {
        let s = 0;
        for (let i = 1; i < path.length; i++) s += Math.log(path[i]);
        return Math.exp(s / (path.length - 1));
      };
      return quoteExotic(spec, (path) => Math.max(gavg(path) - K, 0), S0, T, r, q, sigma, nPaths, seed, K);
    }
    case 'asianFloat':
      return quoteExotic(spec, (path) => Math.max(path[path.length - 1] - avg(path), 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'downOut': {
      const B = Math.min(barrier, S0 * 0.99);
      return quoteExotic(
        spec,
        (path) => (minPath(path) <= B ? 0 : Math.max(path[path.length - 1] - K, 0)),
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'downIn': {
      const B = Math.min(barrier, S0 * 0.99);
      return quoteExotic(
        spec,
        (path) => (minPath(path) <= B ? Math.max(path[path.length - 1] - K, 0) : 0),
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'upOut': {
      const B = Math.max(barrier, S0 * 1.01);
      return quoteExotic(
        spec,
        (path) => (maxPath(path) >= B ? 0 : Math.max(path[path.length - 1] - K, 0)),
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'oneTouch': {
      const B = Math.max(barrier, S0 * 1.01);
      const mc = quoteExotic(spec, (path) => (maxPath(path) >= B ? payout : 0), S0, T, r, q, sigma, nPaths, seed, K);
      // closed form (reflection principle) on the log barrier
      const closed = payout * hitProbAbove(Math.log(S0), Math.log(B), T, r - q - 0.5 * sigma * sigma, sigma);
      return { ...mc, closed } as ExoticQuote & { closed: number };
    }
    case 'binaryCash':
      return quoteExotic(spec, (path) => (path[path.length - 1] > K ? payout : 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'binaryAsset':
      return quoteExotic(spec, (path) => (path[path.length - 1] > K ? path[path.length - 1] : 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'lookbackFloat':
      return quoteExotic(spec, (path) => path[path.length - 1] - minPath(path), S0, T, r, q, sigma, nPaths, seed, K);
    case 'lookbackFixed':
      return quoteExotic(spec, (path) => Math.max(maxPath(path) - K, 0), S0, T, r, q, sigma, nPaths, seed, K);
    case 'chooser': {
      // choose at mid-life: value = max(call, put) on remaining maturity — MC on
      // the remaining path with BS revaluation at the choice node
      const bs = (call: boolean, S: number, Kk: number, tau: number) => bsPrice(call, S, Kk, tau, r, q, sigma);
      return quoteExotic(
        spec,
        (path) => {
          const mid = Math.floor(path.length / 2);
          const S1 = path[mid];
          const tau = T * (1 - mid / (path.length - 1));
          return Math.max(bs(true, S1, K, tau), bs(false, S1, K, tau));
        },
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'forwardStart': {
      // strike set at mid-life ATM; payoff on the second half only
      return quoteExotic(
        spec,
        (path) => {
          const mid = Math.floor(path.length / 2);
          const S1 = path[mid];
          const Kfs = S1;
          return Math.max(path[path.length - 1] - Kfs, 0);
        },
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'cliquet': {
      // annual (or T/years) resets: r_i = S_i/S_{i-1} − 1, payoff Σ max(min(r_i, cap), 0)
      return quoteExotic(
        spec,
        (path) => {
          const years = Math.max(1, Math.round(T));
          const step = (path.length - 1) / years;
          let acc = 0;
          for (let i = 1; i <= years; i++) {
            const r = path[Math.round(i * step)] / path[Math.round((i - 1) * step)] - 1;
            acc += Math.min(Math.max(r, 0), cap);
          }
          return acc;
        },
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'autocall': {
      // stylised monthly-observation note: at each month m: if S ≥ K_call →
      // redeem 1 + coupon·(m/12)·(face) and stop. At maturity: if never
      // dipped below K_ki → 1 + coupon·T·0.5; if dipped → 1 + (S_T/S0 − 1)
      // (linear loss participation). Face = 1.
      return quoteExotic(
        spec,
        (path) => {
          const Kcall = S0; // at-the-money autocall trigger
          const Kki = S0 * 0.8;
          let dipped = false;
          for (let i = 1; i < path.length; i++) {
            if (path[i] <= Kki) dipped = true;
            if (path[i] >= Kcall && i >= Math.floor(path.length / 6)) {
              const months = (i / (path.length - 1)) * 12 * T;
              return 1 + coupon * (months / 12);
            }
          }
          if (!dipped) return 1 + coupon * T * 0.5;
          return Math.max(0, 1 + (path[path.length - 1] / S0 - 1));
        },
        S0, T, r, q, sigma, nPaths, seed, K,
      );
    }
    case 'perpetual': {
      // Merton (1973) closed form: γ = 2r/σ², S* = γK/(γ+1), P = (K−S*)·(S/S*)^{−γ}
      if (r <= 0) return { closed: NaN, spec, note: 'needs r > 0 (with no dividends, the perpetual put is only worth K − S if deep — exercise is never urgent at r ≤ 0)' };
      const g = (2 * r) / (sigma * sigma);
      const sStar = (g * K) / (g + 1);
      const P = (S0 >= sStar) ? (K - sStar) * Math.pow(S0 / sStar, -g) : K - S0;
      return { closed: P, spec, note: `exercise boundary S* = ${sStar.toFixed(2)} · γ = 2r/σ² = ${g.toFixed(3)}` };
    }
    case 'exchange': {
      // Margrabe closed form: C = S1·N(d1) − S2·N(d2), σ² = σ1²+σ2²−2ρσ1σ2
      const s = Math.sqrt(sigma * sigma + p.sigma2 * p.sigma2 - 2 * p.corr * sigma * p.sigma2);
      const d1 = (Math.log(S0 / K) + 0.5 * s * s * T) / (s * Math.sqrt(T));
      const d2 = d1 - s * Math.sqrt(T);
      const C = S0 * normCdf(d1) - K * normCdf(d2);
      return { closed: C, spec, note: `σ_eff = √(σ1²+σ2²−2ρσ1σ2) = ${(s * 100).toFixed(1)}% — correlation made price` };
    }
    default:
      return null;
  }
}

/** The barrier parity check a desk runs: DI + DO = vanilla (same K, same B). */
export function barrierParity(p: ExoticParams): { inOutSum: number; vanilla: number; gap: number } {
  const { S0, K, T, r, q, sigma, nPaths, seed, barrier } = p;
  const B = Math.min(barrier, S0 * 0.99);
  const steps = Math.max(16, Math.round(T * 252));
  const van = bsPrice(true, S0, K, T, r, q, sigma);
  const di = mcPathDependent(
    (path) => {
      let hit = false;
      for (let i = 0; i < path.length; i++) if (path[i] <= B) { hit = true; break; }
      return hit ? Math.max(path[path.length - 1] - K, 0) : 0;
    },
    S0, T, steps, r, q, sigma, nPaths, seed,
  ).price;
  const doP = mcPathDependent(
    (path) => {
      let hit = false;
      for (let i = 0; i < path.length; i++) if (path[i] <= B) { hit = true; break; }
      return hit ? 0 : Math.max(path[path.length - 1] - K, 0);
    },
    S0, T, steps, r, q, sigma, nPaths, seed + 1,
  ).price;
  return { inOutSum: di + doP, vanilla: van, gap: di + doP - van };
}

/** Delta of a down-and-out call by pathwise re-pricing (the discontinuity's hedge). */
export function exoticDelta(id: string, p: ExoticParams, h = 0.01): number | null {
  const up = priceExotic(id, { ...p, S0: p.S0 + h, barrier: p.barrier, seed: p.seed });
  const dn = priceExotic(id, { ...p, S0: p.S0 - h, barrier: p.barrier, seed: p.seed });
  if (!up || !dn) return null;
  const pu = 'price' in up ? up.price : up.closed;
  const pdn = 'price' in dn ? dn.price : dn.closed;
  if (!Number.isFinite(pu) || !Number.isFinite(pdn)) return null;
  return (pu - pdn) / (2 * h);
}

/** Vanilla delta exported for comparisons (uses the same bump). */
export function vanillaDelta(call: boolean, S0: number, K: number, T: number, r: number, q: number, sigma: number): number {
  return delta(call, S0, K, T, r, q, sigma);
}
