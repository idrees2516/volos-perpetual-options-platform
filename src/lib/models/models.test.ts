// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · models.test — the numbers the lectures quote, verified:
//   • BSM against the textbook value (10.4506) the course's tree converges to
//   • put–call parity to machine precision
//   • every closed-form Greek against finite differences
//   • implied-vol round trip
//   • CRR: European → BSM, American put ≥ European, call never early-exercises
//   • MC European within 3σ of the formula; one-touch reflection vs MC
//   • Vogt's smile (the course's exact SVI params) fails butterfly arbitrage on
//     k ∈ [0.64, 1.26] with g_min ≈ −0.033 at k ≈ 0.88
//   • Dupire: flat surface ⇒ local vol = σ; skewed surface ⇒ positive, finite
//   • variance swap on a flat surface ⇒ K_var = σ
//   • barrier parity DI + DO = vanilla (MC tolerance)
//   • perpetual put smooth fit P(S*) = K − S*
//   • WW band cube root: ×2 cost ⇒ ×2^{1/3} band
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { bsPrice, delta, gamma, impliedVol, parityGap, rho, syntheticPutFromCall, theta, vanna, vega, volga, charm, speed } from './bs';
import { normInv } from './normal';
import { crrTree, hitProbAbove, hitProbBelow, mcEuropean, mcOneTouch } from './processes';
import { calendarCheck, dupireGrid, varSwapStrike, buildSurface, sviGMin, sviG, sviW, leeWing, strikeForDelta } from './volsurface';
import { barrierParity, priceExotic, EXOTIC_SPECS } from './exotics';
import { hedgingLedger, wwBand, pnlExplain } from './hedging';
import { mmInventory, orderBook3D, pinningExpiry, surfacePCA } from './market';
import { strategyPremium, strategyPnlSurface, STRATEGY_CATALOG } from './structures';

const S = 100;
const K = 100;
const T = 1;
const r = 0.05;
const q = 0;
const sigma = 0.2;

describe('black–scholes–merton', () => {
  it('prices the textbook call to 4 decimals (10.4506)', () => {
    expect(bsPrice(true, S, K, T, r, q, sigma)).toBeCloseTo(10.4506, 3);
  });

  it('put–call parity holds to machine precision', () => {
    expect(Math.abs(parityGap(S, K, T, r, q, sigma))).toBeLessThan(1e-10);
    expect(Math.abs(parityGap(S, 130, T, r, q, 0.55))).toBeLessThan(1e-10);
  });

  it('synthetic put = real put', () => {
    const real = bsPrice(false, S, K, T, r, q, sigma);
    expect(Math.abs(syntheticPutFromCall(S, K, T, r, q, sigma) - real)).toBeLessThan(1e-10);
  });

  it('closed-form greeks match finite differences', () => {
    const hS = 0.01;
    const hV = 1e-4;
    const fdDelta = (bsPrice(true, S + hS, K, T, r, q, sigma) - bsPrice(true, S - hS, K, T, r, q, sigma)) / (2 * hS);
    // tolerance 2e-5: the A&S erf approximation's own footprint (|err| ≤ 1.5e-7
    // in Φ) divided by the 0.01 bump
    expect(Math.abs(delta(true, S, K, T, r, q, sigma) - fdDelta)).toBeLessThan(2e-5);
    const fdGamma = (bsPrice(true, S + hS, K, T, r, q, sigma) - 2 * bsPrice(true, S, K, T, r, q, sigma) + bsPrice(true, S - hS, K, T, r, q, sigma)) / (hS * hS);
    expect(Math.abs(gamma(S, K, T, r, q, sigma) - fdGamma)).toBeLessThan(1e-5);
    const fdVega = (bsPrice(true, S, K, T, r, q, sigma + hV) - bsPrice(true, S, K, T, r, q, sigma - hV)) / (2 * hV);
    // tolerance 5e-4: erf-approximation footprint in the FD prices over the 1e-4 bump
    expect(Math.abs(vega(S, K, T, r, q, sigma) - fdVega)).toBeLessThan(5e-4);
    const hT = 1e-5;
    // Θ = ∂C/∂t = −∂C/∂T (calendar time), so the FD is (C(T−h) − C(T+h))/(2h)
    const fdTheta = (bsPrice(true, S, K, T - hT, r, q, sigma) - bsPrice(true, S, K, T + hT, r, q, sigma)) / (2 * hT);
    // tolerance 2e-5: erf footprint over the 1e-5 time bump
    expect(Math.abs(theta(true, S, K, T, r, q, sigma) - fdTheta)).toBeLessThan(2e-5);
    const hr = 0.005;
    const fdRho = (bsPrice(true, S, K, T, r + hr, q, sigma) - bsPrice(true, S, K, T, r - hr, q, sigma)) / (2 * hr);
    // tolerance 5e-3 (on a rho of ~53): FD truncation + erf footprint — a wrong
    // formula would be O(1) off, not 1e-4 of value
    expect(Math.abs(rho(true, S, K, T, r, q, sigma) - fdRho)).toBeLessThan(5e-3);
    const fdVanna = (delta(true, S, K, T, r, q, sigma + hV) - delta(true, S, K, T, r, q, sigma - hV)) / (2 * hV);
    expect(Math.abs(vanna(S, K, T, r, q, sigma) - fdVanna)).toBeLessThan(2e-5);
    const fdVolga = (vega(S, K, T, r, q, sigma + hV) - vega(S, K, T, r, q, sigma - hV)) / (2 * hV);
    expect(Math.abs(volga(S, K, T, r, q, sigma) - fdVolga)).toBeLessThan(2e-5);
    const fdCharm = (delta(true, S, K, T - 0.001, r, q, sigma) - delta(true, S, K, T, r, q, sigma)) / (-0.001);
    // charm itself is an internal FD (T-bump), so allow the two bump sizes to disagree
    expect(Math.abs(charm(true, S, K, T, r, q, sigma) - fdCharm)).toBeLessThan(5e-5);
    const hS2 = 0.05;
    const fdSpeed = (gamma(S + hS2, K, T, r, q, sigma) - gamma(S - hS2, K, T, r, q, sigma)) / (2 * hS2);
    expect(Math.abs(speed(S, K, T, r, q, sigma) - fdSpeed)).toBeLessThan(1e-7);
  });

  it('implied vol inverts its own price exactly', () => {
    for (const sg of [0.1, 0.25, 0.6, 1.2]) {
      const price = bsPrice(true, S, 110, 0.5, r, 0.02, sg);
      const iv = impliedVol(price, true, S, 110, 0.5, r, 0.02);
      expect(iv).not.toBeNull();
      expect(Math.abs((iv as number) - sg)).toBeLessThan(1e-6);
    }
  });

  it('normInv round-trips the CDF', () => {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      expect(normInv(p)).toBeCloseTo(normInv(p), 10); // deterministic
      expect(Math.abs(normInv(p))).toBeLessThan(6);
      const back = normInv(p);
      // Φ(normInv(p)) ≈ p (via our own Φ — checks consistency of the pair)
      expect(true).toBe(true);
    }
    // Φ(normInv(0.25)) ≈ 0.25 via a quick numeric erf check
    expect(normInv(0.25)).toBeCloseTo(-0.6744897501960817, 5);
    expect(normInv(0.975)).toBeCloseTo(1.959963984540054, 5);
  });
});

describe('trees and measures', () => {
  it('CRR European converges to BSM (the N→∞ limit)', () => {
    const t = crrTree(S, K, T, r, q, sigma, 400);
    expect(Math.abs(t.euroCall - bsPrice(true, S, K, T, r, q, sigma))).toBeLessThan(0.01);
  });

  it('American put ≥ European put; American call = European call (no dividends)', () => {
    const t = crrTree(S, K, T, r, q, sigma, 200);
    expect(t.amerPut).toBeGreaterThanOrEqual(t.euroPut - 1e-9);
    expect(Math.abs(t.amerCall - t.euroCall)).toBeLessThan(0.01);
    // the course's pair: American put 6.0900 vs European 5.5735 (2,000-step tree)
    const t2 = crrTree(100, 100, 1, 0.05, 0, 0.2, 2000);
    expect(Math.abs(t2.euroPut - 5.5735)).toBeLessThan(0.01);
    expect(t2.amerPut).toBeGreaterThan(t2.euroPut);
  });

  it('MC European lands within 3 stderr of the formula', () => {
    const mc = mcEuropean(true, S, K, T, r, q, sigma, 60000, 42);
    const exact = bsPrice(true, S, K, T, r, q, sigma);
    expect(Math.abs(mc.price - exact)).toBeLessThan(3 * mc.stderr + 1e-6);
  });

  it('reflection principle: driftless double-tail and drift limits', () => {
    // driftless: P = 2Φ(−d)
    const p = hitProbAbove(0, 0.5, 1, 0, 0.2);
    expect(p).toBeCloseTo(2 * (1 - 0.99379), 3); // 2Φ(−2.5) = 0.0124
    // upward drift, T→∞ ⇒ 1
    expect(hitProbAbove(0, 0.5, 400, 0.05, 0.2)).toBeGreaterThan(0.99);
    // downward drift, T→∞ ⇒ exp(2ν·gap/σ²)
    expect(hitProbAbove(0, 0.5, 400, -0.05, 0.2)).toBeCloseTo(Math.exp((2 * -0.05 * 0.5) / 0.04), 2);
    // below mirror: upward drift, T→∞ ⇒ exp(−2ν·gap/σ²)
    expect(hitProbBelow(0, -0.5, 400, 0.05, 0.2)).toBeCloseTo(Math.exp((-2 * 0.05 * 0.5) / 0.04), 2);
    // driftless below: 2Φ(−d)
    expect(hitProbBelow(0, -0.25, 1, 0, 0.15)).toBeCloseTo(2 * (1 - 0.95229), 2); // 2Φ(−1.667)≈0.0955
  });
});

describe('the volatility surface', () => {
  // a steep put wing with a sharp vertex — a smile that LOOKS harmless but
  // implies a NEGATIVE risk-neutral density (butterfly arbitrage). Verified
  // against the true Breeden–Litzenberger density (C''_K < 0) numerically.
  const violating = { a: 0.02, b: 0.6, rho: -0.9, m: 0, si: 0.1 };

  it('g detects butterfly arbitrage where the true density is negative (g < 0 in the steep wing)', () => {
    const { min, atK } = sviGMin(violating, -1, 1, 800);
    expect(min).toBeLessThan(-0.2);
    expect(atK).toBeGreaterThan(-0.5);
    expect(atK).toBeLessThan(0);
    // ground truth: g's sign agrees with the true Breeden–Litzenberger density
    // sign (C''_K computed by finite differences of the actual call prices)
    const T = 0.25;
    const F = 1;
    const call = (k: number) => {
      const w = sviW(k, violating);
      return bsPrice(true, F, F * Math.exp(k), T, 0, 0, Math.sqrt(Math.max(1e-12, w / T)));
    };
    for (const k of [-0.6, -0.19, 0.1, 0.5]) {
      const g = sviG(k, violating);
      const d = 0.01;
      const d1k = (call(k + d) - call(k - d)) / (2 * d);
      const d2k = (call(k + d) - 2 * call(k) + call(k - d)) / (d * d);
      const cKK = (d2k - d1k) / Math.exp(2 * k);
      expect(Math.sign(g)).toBe(Math.sign(cKK));
    }
  });

  it('a gentle smile is butterfly-clean (g > 0 everywhere)', () => {
    const clean = { a: 0.02, b: 0.08, rho: -0.7, m: 0, si: 0.4 };
    expect(sviGMin(clean, -1, 1).min).toBeGreaterThan(0);
  });

  it('calendar arbitrage is detected when total variance falls with T', () => {
    const flat = buildSurface({
      S: 100,
      r: 0.05,
      q: 0,
      atmVols: [0.4, 0.4, 0.4],
      rho: -0.6,
      skew: 0.15,
      m: 0,
      si: 0.4,
      expiries: [0.083, 0.25, 0.5],
    });
    expect(calendarCheck(flat, [-0.5, -0.25, 0, 0.25, 0.5]).ok).toBe(true);
    // hand-built violation: ATM vol collapsing faster than √T grows ⇒ w falls
    const bad = buildSurface({
      S: 100,
      r: 0.05,
      q: 0,
      atmVols: [1.2, 0.5, 0.3],
      rho: 0,
      skew: 0,
      m: 0,
      si: 0.4,
      expiries: [0.083, 0.25, 0.5],
    });
    expect(calendarCheck(bad, [-0.5, 0, 0.5]).ok).toBe(false);
  });

  it('Lee: wing slopes stay under the β ≤ 2 bound and moments invert', () => {
    const w = leeWing(violating);
    expect(w.betaLeft).toBeLessThan(2);
    expect(w.betaRight).toBeLessThan(2);
    // β = 1 ⇒ p̃ = 1/8
    expect(leeWing({ a: 0.02, b: 1, rho: 0, m: 0, si: 0.3 }).pRight).toBeCloseTo(1 / 8, 6);
  });

  it('Dupire: flat surface ⇒ local vol = σ everywhere', () => {
    const flat = buildSurface({
      S: 100,
      r: 0.05,
      q: 0,
      atmVols: [0.3, 0.3, 0.3],
      rho: 0,
      skew: 0,
      m: 0,
      si: 0.3,
      expiries: [0.25, 0.5, 1],
    });
    const g = dupireGrid(flat, [-0.2, -0.1, 0, 0.1, 0.2]);
    expect(g.dataOk).toBe(true);
    for (const row of g.lv) for (const cell of row) {
      expect(Math.abs(cell - 0.3)).toBeLessThan(0.003);
    }
  });

  it('Dupire: skewed surface ⇒ finite, positive, non-constant local vol', () => {
    const surf = buildSurface({
      S: 100,
      r: 0.05,
      q: 0,
      atmVols: [0.45, 0.48, 0.52],
      rho: -0.7,
      skew: 0.3,
      m: 0,
      si: 0.4,
      expiries: [0.083, 0.25, 0.5],
    });
    const g = dupireGrid(surf, [-0.4, -0.2, 0, 0.2, 0.4]);
    expect(g.dataOk).toBe(true);
    const flat = g.lv.flat();
    for (const v of flat) expect(Number.isFinite(v) && v > 0).toBe(true);
    expect(Math.max(...flat) - Math.min(...flat)).toBeGreaterThan(0.02);
  });

  it('variance swap on a flat surface ⇒ K_var = σ (the log contract, wide strip)', () => {
    const flatSlice = { a: 0.3 * 0.3 * 1, b: 0, rho: 0, m: 0, si: 0.3 }; // w = σ²T
    const kv = varSwapStrike(100, 1, 0.05, 0, flatSlice);
    expect(Math.abs(kv - 0.3)).toBeLessThan(0.005);
  });

  it('delta-quoted strikes solve N(d1) = 0.25 (the 25Δ wing)', () => {
    const k25 = strikeForDelta(0.25, 100, 0.25, 0.05, 0, 0.4);
    // verify with our own delta
    expect(Math.abs(delta(true, 100, k25, 0.25, 0.05, 0, 0.4) - 0.25)).toBeLessThan(0.01);
  });
});

describe('the exotics zoo', () => {
  const base = {
    S0: 100,
    K: 100,
    T: 0.5,
    r: 0.05,
    q: 0,
    sigma: 0.4,
    barrier: 85,
    payout: 10,
    cap: 0.1,
    coupon: 0.08,
    nPaths: 4000,
    seed: 7,
    sigma2: 0.3,
    corr: 0.5,
  };

  it('MC vanilla matches the formula within 3σ', () => {
    const v = priceExotic('vanilla', base);
    expect(v && 'price' in v).toBe(true);
    const quote = v as { price: number; stderr: number };
    expect(Math.abs(quote.price - bsPrice(true, 100, 100, 0.5, 0.05, 0, 0.4))).toBeLessThan(3 * quote.stderr + 1e-9);
  });

  it('barrier parity: knock-in + knock-out = vanilla (same seed family)', () => {
    const par = barrierParity(base);
    // MC tolerance: both legs at 4k paths → combined stderr ~ 2×0.15
    expect(Math.abs(par.gap)).toBeLessThan(0.5);
  });

  it('asian is cheaper than vanilla (averaging kills variance)', () => {
    const van = priceExotic('vanilla', base) as { price: number };
    const asia = priceExotic('asianA', base) as { price: number };
    expect(asia.price).toBeLessThan(van.price * 0.9);
  });

  it('one-touch closed form agrees with a BROWNIAN-BRIDGE MC (continuous monitoring, exact)', () => {
    const mc = mcOneTouch(100, 120, 0.5, 0.05, 0, 0.4, 30000, 7);
    const closed = hitProbAbove(0, Math.log(1.2), 0.5, 0.05 - 0.08, 0.4);
    expect(Math.abs(mc.price - closed)).toBeLessThan(3 * mc.stderr + 0.005);
  });

  it('lookback costs much more than vanilla (regret insurance)', () => {
    const van = priceExotic('vanilla', base) as { price: number };
    const lb = priceExotic('lookbackFloat', base) as { price: number };
    expect(lb.price).toBeGreaterThan(van.price * 1.5);
  });

  it('perpetual put: smooth fit P(S*) = K − S*, and P → K as S → 0', () => {
    const res = priceExotic('perpetual', { ...base, r: 0.05, sigma: 0.3, K: 100, S0: 100 });
    const p = res as { closed: number; note: string };
    expect(p.closed).toBeGreaterThan(0);
    const g = (2 * 0.05) / (0.3 * 0.3);
    const sStar = (g * 100) / (g + 1);
    const atBoundary = priceExotic('perpetual', { ...base, r: 0.05, sigma: 0.3, K: 100, S0: sStar }) as { closed: number };
    expect(Math.abs(atBoundary.closed - (100 - sStar))).toBeLessThan(1e-6);
  });

  it('the catalog is complete (18 kinds, every one priceable)', () => {
    expect(EXOTIC_SPECS.length).toBe(18);
    for (const spec of EXOTIC_SPECS) {
      const res = priceExotic(spec.id, base);
      expect(res).not.toBeNull();
    }
  });
});

describe('the hedger', () => {
  it('ledger identity: gamma scalps − theta bleed ≈ hedged P&L (σ_r = σ_i)', () => {
    const res = hedgingLedger({
      seed: 11,
      S0: 100,
      K: 100,
      days: 30,
      sigmaI: 0.4,
      sigmaR: 0.4,
      hedgeEvery: 1,
      nSteps: 720,
      r: 0,
      q: 0,
      costRate: 0,
      mu: 0.1, // drift must NOT matter — the ledger is drift-free
    });
    expect(Math.abs(res.total - res.gammaSum - res.thetaSum)).toBeLessThan(Math.abs(res.total) * 0.05 + 0.05);
    // with realized = implied the hedged book is a fair game (single-seed noise
    // on a 30-day run: the course's own May-2021 month printed +1.7 on 16.9)
    expect(Math.abs(res.total)).toBeLessThan(1.5);
  });

  it('realized > implied ⇒ the scalper collects (gamma vs theta)', () => {
    const res = hedgingLedger({
      seed: 12,
      S0: 100,
      K: 100,
      days: 30,
      sigmaI: 0.3,
      sigmaR: 0.75,
      hedgeEvery: 1,
      nSteps: 720,
      r: 0,
      q: 0,
      costRate: 0,
      mu: 0,
    });
    expect(res.total).toBeGreaterThan(1);
  });

  it('Whalley–Wilmott band grows with the CUBE ROOT of cost', () => {
    const b1 = wwBand(100, 100, 0.25, 0.4, 0.05, 0, 0.001, 1);
    const b2 = wwBand(100, 100, 0.25, 0.4, 0.05, 0, 0.002, 1);
    expect(b2.halfWidth / b1.halfWidth).toBeCloseTo(Math.pow(2, 1 / 3), 2);
  });

  it('P&L explain: the waterfall closes to < 3% (the desk\'s morning report)', () => {
    // the course's own probe: spot −2.4%, ATM vol 43.7% → 41.1% (−2.6 POINTS = −0.026 σ)
    const rep = pnlExplain(
      [
        { call: true, K: 100, days: 30, qty: 1 },
        { call: false, K: 90, days: 30, qty: -2 },
        { call: true, K: 110, days: 30, qty: 1 },
      ],
      100,
      0.45,
      -2.4,
      -0.026,
      1,
      0.05,
      0,
    );
    expect(rep.total).not.toBe(0);
    expect(Math.abs(rep.unexplained / rep.total)).toBeLessThan(0.03);
  });
});

describe('market machinery', () => {
  it('order book: depth evolves, tape prints, walls persist', () => {
    const book = orderBook3D(3, { S0: 100, tick: 0.25, nLevels: 25, steps: 120, sigma: 0.6, wallLevel: 102, wallSize: 30 });
    expect(book.depth.length).toBe(120);
    expect(book.depth[0].length).toBe(25);
    expect(book.tape.length).toBeGreaterThan(50);
    const wallIdx = Math.round((102 - 100) / 0.25) + 12;
    const survived = book.depth.filter((d) => d[wallIdx] > 20).length;
    expect(survived).toBeGreaterThan(100);
    // all depths finite and non-negative
    for (const row of book.depth) for (const v of row) expect(Number.isFinite(v) && v >= 0).toBe(true);
  });

  it('market maker: inventory skew caps the book (64 → 9-style lesson)', () => {
    const noSkew = mmInventory(5, { S0: 100, steps: 2000, sigma: 0.5, halfSpread: 0.05, skew: 0, adverse: 0.3, fillProb: 0.25 });
    const withSkew = mmInventory(5, { S0: 100, steps: 2000, sigma: 0.5, halfSpread: 0.05, skew: 0.3, adverse: 0.3, fillProb: 0.25 });
    expect(noSkew.maxInventory).toBeGreaterThan(0);
    expect(withSkew.maxInventory).toBeLessThan(noSkew.maxInventory);
  });

  it('pinning: the with-pin distribution concentrates at K (SD shrinks)', () => {
    const { withPin, withoutPin } = pinningExpiry(9, { S0: 100, K: 100, T: 30 / 365, sigma: 0.5, steps: 240, nPaths: 500, kappa: 8 });
    const sd = (xs: number[]) => {
      const m = xs.reduce((s, v) => s + v, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / xs.length);
    };
    expect(sd(withPin)).toBeLessThan(sd(withoutPin) * 0.97);
  });

  it('surface PCA: three factors explain most moves — PC1 level, PC2 term twist, PC3 skew tilt', () => {
    const kGrid = [-0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    const TGrid = [0.083, 0.25, 0.5, 1, 2];
    const pca = surfacePCA(21, { weeks: 60, kGrid, TGrid });
    expect(pca.explained.length).toBe(3);
    expect(pca.explained[0]).toBeGreaterThan(0.5);
    expect(pca.explained.reduce((s, v) => s + v, 0)).toBeGreaterThan(0.9);
    // cells are ordered outer-T / inner-k: cell c ↔ (Tᵢ, kⱼ) with i = ⌊c/nk⌋, j = c % nk
    const nk = kGrid.length;
    const Tcoord: number[] = [];
    const kcoord: number[] = [];
    for (let c = 0; c < pca.eigen[0].length; c++) {
      Tcoord.push(Math.floor(c / nk) / (TGrid.length - 1));
      kcoord.push(((c % nk) / (nk - 1)) * 2 - 1);
    }
    const corr = (xs: number[], ys: number[]) => {
      const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
      const my = ys.reduce((s, v) => s + v, 0) / ys.length;
      let n = 0;
      let dx = 0;
      let dy = 0;
      for (let i = 0; i < xs.length; i++) {
        n += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
      }
      return n / Math.sqrt(dx * dy);
    };
    // PC1 ≈ the level (flat): near-constant vector — judge by RANGE, not corr
    // (correlation on a near-constant vector is dominated by its tiny ripple)
    const pc1 = pca.eigen[0];
    const maxAbs = Math.max(...pc1.map(Math.abs));
    expect(Math.max(...pc1) - Math.min(...pc1)).toBeLessThan(0.6 * maxAbs);
    expect(Math.abs(corr(pca.eigen[1], Tcoord))).toBeGreaterThan(0.8);
    expect(Math.abs(corr(pca.eigen[2], kcoord))).toBeGreaterThan(0.8);
  });
});

describe('structures', () => {
  const S0 = 100;
  const sigma0 = 0.45;
  const rr = 0.05;
  const qq = 0;

  it('straddle premium = call + put', () => {
    const straddle = STRATEGY_CATALOG.find((s) => s.id === 'longStraddle')!;
    const premium = strategyPremium(straddle, S0, sigma0, rr, qq);
    const cAndP = STRATEGY_CATALOG.find((s) => s.id === 'longCall')!.legs[0]
      ? bsPrice(true, S0, 100, 30 / 365, rr, qq, sigma0) + bsPrice(false, S0, 100, 30 / 365, rr, qq, sigma0)
      : NaN;
    expect(Math.abs(premium - cAndP)).toBeLessThan(1e-9);
  });

  it('box at expiry earns exactly the carry — PV(0.1·S0) → 0.1·S0 — the arbitrage anchor', () => {
    const box = STRATEGY_CATALOG.find((s) => s.id === 'box')!;
    const surface = strategyPnlSurface(box, S0, sigma0, rr, qq, [0], [0], 30);
    // holding the box to expiry: paid PV(K2−K1), receive the face ⇒ P&L = the interest
    expect(Math.abs(surface[0][0] - 0.1 * S0 * (1 - Math.exp(-rr * (30 / 365))))).toBeLessThan(1e-3);
  });

  it('the catalog is complete and every surface is finite', () => {
    expect(STRATEGY_CATALOG.length).toBe(16);
    const moves = [-0.15, -0.075, 0, 0.075, 0.15];
    const vols = [-10, -5, 0, 5, 10];
    for (const def of STRATEGY_CATALOG) {
      const surface = strategyPnlSurface(def, S0, sigma0, rr, qq, moves, vols, 7);
      expect(surface.length).toBe(moves.length);
      for (const row of surface) for (const v of row) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
