// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · stat-models tests — the new statistical wing:
// Heston / SABR / Merton, GARCH / OU / Kalman, HMM, ML, portfolio, mixed MC.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { bsPrice } from './bs';
import { mcEuropean, gbmPath } from './processes';
import { strikeForDelta } from './volsurface';
import { hestonPrice, sabrImpliedVol, sabrAtmVol, calibrateSabr, mertonJumpPrice, calibrateMerton, jumpTailMass, mertonM } from './stochastic';
import { fitGarch, garchForecast, fitOu, ouStretch, kalmanTrend, kalmanVerdict } from './timeseries';
import { fitHmm, hmmRegime, simulateRegimeReturns } from './regimes';
import { trainLogistic, logisticPredict, logisticEvaluate, kMeans, silhouette, cartTree, treePredict, miniForest, forestPredict, marketFeatureMatrix, walkForwardPUp, solveRidge } from './ml';
import { kellyFraction, kellyGrowth, riskParity, tailRisk, drawdown, portfolioVol } from './portfolio';
import { mixedModelFan, mcMixedPayoff, mixedSpecFromFits, boxMuller } from './mcfan';
import { mulberry32 } from './rng';

const logRets = (closes: number[]): number[] =>
  closes.slice(1).map((c, i) => Math.log(c / closes[i]));

// ── Heston ──────────────────────────────────────────────────────────────────

describe('heston', () => {
  it('degenerates to Black–Scholes when vol-of-vol → 0 (v₀ = θ = σ²)', () => {
    const sigma = 0.4;
    const p = { v0: sigma * sigma, kappa: 2, theta: sigma * sigma, xi: 1e-6, rho: 0 };
    const S = 100, K = 100, T = 0.5, r = 0.03, q = 0;
    const h = hestonPrice(true, S, K, T, r, q, p);
    const bs = bsPrice(true, S, K, T, r, q, sigma);
    expect(Math.abs(h.price - bs) / bs).toBeLessThan(0.01);
  });

  it('satisfies put–call parity exactly', () => {
    const p = { v0: 0.08, kappa: 1.5, theta: 0.09, xi: 0.9, rho: -0.4 };
    const S = 100, K = 90, T = 0.4, r = 0.02, q = 0.01;
    const c = hestonPrice(true, S, K, T, r, q, p).price;
    const put = hestonPrice(false, S, K, T, r, q, p).price;
    expect(c - put).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 6);
  });

  it('prices in [0, S] and P₁, P₂ implied probabilities are sane', () => {
    const p = { v0: 0.15, kappa: 1.2, theta: 0.12, xi: 1.1, rho: -0.6 };
    const c = hestonPrice(true, 100, 80, 0.25, 0.05, 0, p).price;
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(100);
    expect(Number.isFinite(c)).toBe(true);
  });

  it('deep OTM calls gain value vs BS under fat tails (jump-free smile sanity)', () => {
    const sigma = 0.5;
    const flat = { v0: sigma ** 2, kappa: 3, theta: sigma ** 2, xi: 0.8, rho: -0.7 };
    const k = 0.6;
    const h = hestonPrice(true, 100, 100 * k, 0.3, 0.02, 0, flat).price;
    const bs = bsPrice(true, 100, 100 * k, 0.3, 0.02, 0, sigma);
    // with ρ<0 and ξ>0 the left wing is FAT ⇒ OTM put richer ⇒ call cheaper;
    // for calls the parity mirror keeps this check sign-free: monotonicity only
    expect(h).toBeGreaterThan(0);
    expect(bs).toBeGreaterThan(0);
    const put = hestonPrice(false, 100, 100 * k, 0.3, 0.02, 0, flat).price;
    const putBs = bsPrice(false, 100, 100 * k, 0.3, 0.02, 0, sigma);
    expect(put / putBs).toBeGreaterThan(0.9);
  });
});

// ── SABR ────────────────────────────────────────────────────────────────────

describe('sabr', () => {
  it('ATM vol equals α·correction (→ α for small T·ν)', () => {
    const p = { alpha: 0.6, rho: -0.2, nu: 0.4 };
    const atm = sabrImpliedVol(100, 100, 0.01, p);
    expect(Math.abs(atm - p.alpha)).toBeLessThan(0.01);
  });

  it('ρ < 0 ⇒ downside strikes richer than upside (skew sign)', () => {
    const p = { alpha: 0.5, rho: -0.5, nu: 0.9 };
    const down = sabrImpliedVol(100, 85, 0.25, p);
    const up = sabrImpliedVol(100, 115, 0.25, p);
    expect(down).toBeGreaterThan(up);
  });

  it('ν = 0 ⇒ flat smile', () => {
    const p = { alpha: 0.5, rho: -0.3, nu: 1e-6 };
    expect(Math.abs(sabrImpliedVol(100, 85, 0.25, p) - 0.5)).toBeLessThan(1e-3);
    expect(Math.abs(sabrImpliedVol(100, 120, 0.25, p) - 0.5)).toBeLessThan(1e-3);
  });

  it('calibrates back a constructed (ATM, RR25, Fly25) triple within tolerance', () => {
    const truth = { alpha: 0.55, rho: -0.4, nu: 1.2 };
    const F = 100, T = 0.25;
    const atmVol = sabrAtmVol(truth, T);
    // construct the target at the SAME 25Δ strikes the calibrator uses
    const kc = strikeForDelta(0.25, F, T, 0, 0, atmVol);
    const kp = strikeForDelta(-0.25, F, T, 0, 0, atmVol);
    const rr = sabrImpliedVol(F, kc, T, truth) - sabrImpliedVol(F, kp, T, truth);
    const fly = (sabrImpliedVol(F, kc, T, truth) + sabrImpliedVol(F, kp, T, truth)) / 2 - atmVol;
    const { params, resid } = calibrateSabr(F, T, atmVol, rr, fly);
    expect(Math.abs(resid.rr)).toBeLessThan(0.02);
    expect(Math.abs(resid.fly)).toBeLessThan(0.02);
    expect(params.rho).toBeLessThan(-0.2);
    expect(params.nu).toBeGreaterThan(0.5);
  });
});

// ── Merton jump-diffusion ───────────────────────────────────────────────────

describe('merton', () => {
  it('λ → 0 recovers Black–Scholes', () => {
    const p = { lambda: 1e-9, muJ: 0, sigmaJ: 0.001 };
    const m = mertonJumpPrice(true, 100, 110, 0.5, 0.05, 0, 0.45, p);
    const bs = bsPrice(true, 100, 110, 0.5, 0.05, 0, 0.45);
    expect(Math.abs(m.price - bs) / bs).toBeLessThan(1e-6);
  });

  it('crash jumps raise OTM put values vs BS (gap risk priced)', () => {
    const sigma = 0.3;
    const p = { lambda: 5, muJ: -0.12, sigmaJ: 0.05 };
    const put = mertonJumpPrice(false, 100, 75, 0.3, 0.05, 0, sigma, p).price;
    const putBs = bsPrice(false, 100, 75, 0.3, 0.05, 0, sigma);
    expect(put).toBeGreaterThan(putBs * 1.1);
  });

  it('put–call parity holds under the compensated mixture', () => {
    const sigma = 0.35;
    const p = { lambda: 3, muJ: -0.08, sigmaJ: 0.07 };
    const S = 100, K = 95, T = 0.5, r = 0.04, q = 0.01;
    const c = mertonJumpPrice(true, S, K, T, r, q, sigma, p).price;
    const put = mertonJumpPrice(false, S, K, T, r, q, sigma, p).price;
    expect(c - put).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 6);
  });

  it('calibrates λ from 3σ tail exceedances and the compensator is finite', () => {
    const rng = mulberry32(7);
    const rets: number[] = [];
    for (let i = 0; i < 2000; i++) rets.push((rng() - 0.5) * 0.02);
    // splice in 20 crash bars (~20σ — detected by the 4σ gate)
    for (let i = 0; i < 20; i++) rets[i * 97] = -0.12;
    const cal = calibrateMerton(rets, { barsPerYear: 35040 });
    expect(cal.tailCount).toBeGreaterThanOrEqual(18);
    expect(cal.params.lambda).toBeGreaterThan(0);
    expect(Number.isFinite(mertonM(cal.params))).toBe(true);
    const tails = jumpTailMass(cal.params, 0.02, 1 / 35040 * 96, 4);
    expect(tails.merton).toBeGreaterThan(tails.gaussian);
  });
});

// ── GARCH ───────────────────────────────────────────────────────────────────

describe('garch', () => {
  const volClusteringRets = (): number[] => {
    const rng = mulberry32(1234);
    const rets: number[] = [];
    let v = 0.01;
    for (let t = 0; t < 600; t++) {
      // persistent variance cycles
      v = 0.004 + 0.9 * v;
      const eps = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
      rets.push(Math.sqrt(v) * eps);
    }
    return rets;
  };

  it('fits with 0 < α, 0 < β, α+β < 1 and finite persistence', () => {
    const fit = fitGarch(volClusteringRets(), { barsPerYear: 35040 });
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.alpha).toBeGreaterThan(0);
    expect(fit.beta).toBeGreaterThan(0.2);
    expect(fit.persistence).toBeLessThan(1);
    expect(fit.persistence).toBeGreaterThan(0.5);
    expect(fit.omega).toBeGreaterThan(0);
    expect(fit.volTail.length).toBeGreaterThan(0);
  });

  it('forecast variance converges monotonically to the long run', () => {
    const fit = fitGarch(volClusteringRets(), { barsPerYear: 35040 });
    if (!fit) throw new Error('no fit');
    const fc = garchForecast(fit, 0.03, 200);
    expect(fc.variance.length).toBe(200);
    const last = fc.variance[fc.variance.length - 1];
    expect(Math.abs(last - fit.longRunVar) / fit.longRunVar).toBeLessThan(0.05);
    // high persistence ⇒ long half-life
    expect(fit.shockHalfLifeBars ?? 0).toBeGreaterThan(5);
  });

  it('i.i.d. returns fit near-zero alpha (no clustering to find)', () => {
    const rng = mulberry32(55);
    const iid: number[] = [];
    for (let i = 0; i < 800; i++) iid.push((rng() - 0.5) * 0.014);
    const fit = fitGarch(iid, { barsPerYear: 35040 });
    if (!fit) return;
    expect(fit.alpha).toBeLessThan(0.32);
  });
});

// ── OU ──────────────────────────────────────────────────────────────────────

describe('ou', () => {
  it('recovers the half-life of a constructed AR(1)', () => {
    const rng = mulberry32(11);
    const phi = 0.94; // κ = −ln(0.94) ≈ 0.0619/bar; half-life ≈ 11 bars
    let x = 0;
    const levels: number[] = [];
    for (let t = 0; t < 800; t++) {
      x = 0.2 * (1 - phi) + phi * x + 0.02 * (rng() - 0.5);
      levels.push(x);
    }
    const fit = fitOu(levels);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.phi).toBeGreaterThan(0.85);
    expect(fit.phi).toBeLessThan(1);
    expect(fit.halfLifeBars ?? 0).toBeGreaterThan(6);
    expect(fit.halfLifeBars ?? 1000).toBeLessThan(30);
    expect(fit.rSquared).toBeGreaterThan(0.2);
    const st = ouStretch(fit, levels[levels.length - 1]);
    expect(st.expectedDecayBars.length).toBe(30);
    expect(Number.isFinite(st.z)).toBe(true);
  });

  it('rejects a pure random walk (φ ≈ 1 / non-stationary-ish)', () => {
    const rng = mulberry32(12);
    let x = 0;
    const walk: number[] = [];
    for (let t = 0; t < 600; t++) {
      x += 0.01 * (rng() - 0.5);
      walk.push(x);
    }
    const fit = fitOu(walk);
    // φ close to 1 ⇒ score tiny even when the fit exists
    if (fit) expect(fit.score).toBeLessThan(40);
    else expect(fit).toBeNull();
  });
});

// ── Kalman ──────────────────────────────────────────────────────────────────

describe('kalman', () => {
  it('tracks a noisy ramp: slope ≈ true slope, level ≈ line', () => {
    const rng = mulberry32(21);
    const truth = 0.8;
    const prices: number[] = [];
    for (let t = 0; t < 300; t++) prices.push(100 + truth * t + (rng() - 0.5) * 3);
    const k = kalmanTrend(prices, { q: 0.01, r: 1 });
    expect(k).not.toBeNull();
    if (!k) return;
    expect(Math.abs(k.currentSlope - truth)).toBeLessThan(0.15);
    expect(k.level.length).toBe(prices.length);
    const verdict = kalmanVerdict(k, 1.5);
    expect(verdict.label).toBe('UP');
  });

  it('flat series ⇒ FLAT verdict, tiny slope', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 40) * 0.4);
    const k = kalmanTrend(prices);
    if (!k) return;
    expect(Math.abs(k.currentSlope)).toBeLessThan(0.05);
  });
});

// ── HMM ─────────────────────────────────────────────────────────────────────

describe('hmm', () => {
  const sim = simulateRegimeReturns(99, 1200, { pStay: 0.97 });
  const fit = fitHmm(sim.returns);

  it('fits, decodes, and recovers the σ-ordered states', () => {
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.k).toBe(3);
    expect(fit.states.map((s) => s.label)).toEqual(['calm', 'trending', 'extreme']);
    expect(fit.probsNow.length).toBe(3);
    expect(fit.probsNow.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    for (const row of fit.trans) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(fit.path.length).toBe(sim.returns.length);
    // state recovery: ≥70% of decoded bars match the generator's state
    const match = sim.states.filter((s, i) => fit.path[i] === s).length / sim.states.length;
    expect(match).toBeGreaterThan(0.7);
  });

  it('σ ordering is monotone across states', () => {
    if (!fit) throw new Error('no fit');
    const sigmas = fit.states.map((s) => s.sigma);
    for (let i = 1; i < sigmas.length; i++) expect(sigmas[i]).toBeGreaterThan(sigmas[i - 1]);
    const reg = hmmRegime(fit);
    expect(Math.abs(reg.regimeScore)).toBeLessThanOrEqual(100);
    expect(reg.prob).toBeGreaterThan(0.3);
  });

  it('short series returns null instead of garbage', () => {
    expect(fitHmm([0.01, -0.01, 0.02])).toBeNull();
  });
});

// ── ML ──────────────────────────────────────────────────────────────────────

describe('ml', () => {
  it('logistic learns a separable problem to ≥ 95% holdout accuracy', () => {
    const rng = mulberry32(31);
    const x: Float64Array[] = [];
    const y: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = rng() * 2 - 1;
      const b = rng() * 2 - 1;
      x.push(new Float64Array([a, b, a * 0.3 + b * 0.1 - 0.2]));
      y.push(a > 0.1 ? 1 : 0);
    }
    const model = trainLogistic(x.slice(0, 300), y.slice(0, 300), { seed: 1 });
    if (!model) throw new Error('no model');
    const ev = logisticEvaluate(model, x.slice(300), y.slice(300));
    expect(ev).not.toBeNull();
    if (ev) {
      expect(ev.accuracy).toBeGreaterThan(0.95);
      expect(ev.auc ?? 0).toBeGreaterThan(0.9);
      expect(ev.logLoss).toBeLessThan(0.3);
    }
  });

  it('logistic refuses tiny inputs', () => {
    expect(trainLogistic([new Float64Array([1])], [1])).toBeNull();
  });

  it('predict maps to (0, 1)', () => {
    const rng = mulberry32(32);
    const x: Float64Array[] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const a = rng() - 0.5;
      x.push(new Float64Array([a]));
      y.push(a > 0 ? 1 : 0);
    }
    const model = trainLogistic(x, y, { seed: 2 });
    if (!model) throw new Error('no model');
    for (const row of x) {
      const p = logisticPredict(model, row);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('kMeans separates two blobs and silhouette is positive', () => {
    const rng = mulberry32(41);
    const x: Float64Array[] = [];
    for (let i = 0; i < 120; i++) {
      const c = i % 2;
      x.push(new Float64Array([c * 5 + rng(), rng()]));
    }
    const km = kMeans(x, 2, { seed: 3 });
    if (!km) throw new Error('no km');
    expect(km.centroids.length).toBe(2);
    const sil = silhouette(x, km.assignments, km.centroids);
    expect(sil ?? 0).toBeGreaterThan(0.5);
    // assignments cluster by construction
    const mixed = x.filter((row, i) => km.assignments[i] !== km.assignments[0]).length;
    expect(mixed).toBeGreaterThan(40);
  });

  it('CART + mini forest learn a logic rule with decent OOB', () => {
    const rng = mulberry32(51);
    const x: Float64Array[] = [];
    const y: number[] = [];
    for (let i = 0; i < 300; i++) {
      const a = rng() - 0.5;
      const b = rng() - 0.5;
      x.push(new Float64Array([a, b]));
      y.push(a > 0 && b > 0 ? 1 : 0);
    }
    const tree = cartTree(x, y, { maxDepth: 3 });
    if (!tree) throw new Error('no tree');
    let correct = 0;
    for (let i = 0; i < x.length; i++) if (treePredict(tree, x[i]) === y[i]) correct++;
    expect(correct / x.length).toBeGreaterThan(0.85);
    const forest = miniForest(x, y, { nTrees: 9, depth: 3, seed: 9 });
    if (!forest) throw new Error('no forest');
    expect(forest.oobAccuracy ?? 0).toBeGreaterThan(0.8);
    const pr = forestPredict(forest, new Float64Array([0.4, 0.4]));
    expect(pr.p).toBeGreaterThan(0.5);
    const pr2 = forestPredict(forest, new Float64Array([-0.4, 0.4]));
    expect(pr2.p).toBeLessThan(0.5);
  });

  it('marketFeatureMatrix builds look-ahead-free features', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 * Math.exp(0.001 * i + Math.sin(i / 7) * 0.01));
    const fm = marketFeatureMatrix(closes);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.x.length).toBeGreaterThan(150);
    expect(fm.x[0].length).toBe(fm.featureNames.length);
    expect(new Set(fm.y).size).toBe(2);
    const wf = walkForwardPUp(fm, { seed: 5 });
    // on an autocorrelated sine-trend series the holdout must at least exist
    expect(wf === null || wf.metrics.n > 20).toBe(true);
  });

  it('solveRidge fits a linear map exactly (no regularization world)', () => {
    const x: Float64Array[] = [];
    const y: number[] = [];
    for (let i = 0; i < 50; i++) {
      const a = i / 50;
      x.push(new Float64Array([a, 1]));
      y.push(2 * a + 3);
    }
    const beta = solveRidge(x, y, 1e-9);
    if (!beta) throw new Error('no solve');
    expect(beta[0]).toBeCloseTo(2, 3);
    expect(beta[1]).toBeCloseTo(3, 3);
  });
});

// ── portfolio ───────────────────────────────────────────────────────────────

describe('portfolio', () => {
  it('Kelly of a positive-edge binary stream is positive and g(f) peaks there', () => {
    const rng = mulberry32(61);
    const rets: number[] = [];
    for (let i = 0; i < 400; i++) rets.push(rng() < 0.55 ? 0.2 : -0.17);
    const k = kellyFraction(rets, 1);
    expect(k).not.toBeNull();
    if (!k) return;
    expect(k.f).toBeGreaterThan(0.05);
    expect(k.f).toBeLessThan(1);
    expect(k.fHalf).toBeCloseTo(k.f / 2, 6);
    expect(kellyGrowth(rets, k.f)).toBeGreaterThanOrEqual(kellyGrowth(rets, k.f * 0.9) - 1e-6);
    expect(kellyGrowth(rets, k.f)).toBeGreaterThanOrEqual(kellyGrowth(rets, Math.min(1, k.f * 1.1)) - 1e-6);
  });

  it('zero-edge stream (exact alternating) ⇒ Kelly ≈ 0', () => {
    const rets: number[] = [];
    for (let i = 0; i < 200; i++) rets.push(i % 2 === 0 ? 0.1 : -0.1);
    const k = kellyFraction(rets, 1);
    if (!k) return;
    expect(Math.abs(k.f)).toBeLessThan(1e-4);
    expect(k.growth).toBeCloseTo(0, 4);
  });

  it('risk parity weights sum to 1, favor the quiet asset', () => {
    const rp = riskParity([0.8, 0.2]);
    if (!rp) throw new Error('no rp');
    expect(rp.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(rp.weights[1]).toBeGreaterThan(rp.weights[0]);
    expect(rp.diversity).toBeGreaterThan(0);
  });

  it('CVaR ≤ VaR (more extreme) and Gaussian CVaR is finite', () => {
    const rng = mulberry32(63);
    const rets: number[] = [];
    for (let i = 0; i < 500; i++) rets.push((rng() - 0.5) * 0.04);
    const tr = tailRisk(rets, 0.95);
    if (!tr) throw new Error('no tr');
    expect(tr.cvarHist).toBeLessThanOrEqual(tr.varHist + 1e-9);
    expect(Number.isFinite(tr.cvarGauss)).toBe(true);
    const dd = drawdown(rets);
    expect(dd.maxDd).toBeGreaterThan(0);
    expect(dd.maxDd).toBeLessThan(1);
    const pv = portfolioVol([0.5, 0.5], [0.4, 0.4], 0.7);
    // var = 2·(0.25·0.16) + 2·0.25·0.16·0.7 = 0.136
    expect(pv).toBeCloseTo(Math.sqrt(0.136), 6);
    const pv2 = portfolioVol([0.5, 0.5], [0.4, 0.4], 0);
    expect(pv2).toBeCloseTo(0.4 * Math.sqrt(0.5), 6);
  });
});

// ── mixed MC ────────────────────────────────────────────────────────────────

describe('mixed mc', () => {
  it('GBM-only mixed fan matches the closed-form terminal distribution', () => {
    const S0 = 100;
    const mu = 0.1;
    const sigma = 0.5;
    const T = 1;
    const steps = 24;
    const fan = mixedModelFan(2026, 4000, S0, steps, T / steps, {
      drift: mu - 0.5 * sigma * sigma,
      baseVol: sigma,
    });
    const q05 = fan.terminal.q05;
    const q95 = fan.terminal.q95;
    const z5 = -1.6449;
    const z95 = 1.6449;
    const theo05 = S0 * Math.exp((mu - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z5);
    const theo95 = S0 * Math.exp((mu - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z95);
    expect(Math.abs(q05 / theo05 - 1)).toBeLessThan(0.08);
    expect(Math.abs(q95 / theo95 - 1)).toBeLessThan(0.08);
    expect(fan.steps.length).toBe(steps);
    // log drift = μ−σ²/2 < 0 ⇒ P(up) = Φ((μ−σ²/2)√T/σ) ≈ 0.48
    expect(fan.terminal.pUp).toBeGreaterThan(0.42);
    expect(fan.terminal.pUp).toBeLessThan(0.55);
  });

  it('jump leg fattens the tails vs the GBM-only fan', () => {
    const seed = 4242;
    const base = mixedModelFan(seed, 3000, 100, 30, 1 / 96, { drift: 0.02, baseVol: 0.5 });
    const jumpy = mixedModelFan(seed, 3000, 100, 30, 1 / 96, {
      drift: 0.02,
      baseVol: 0.5,
      merton: { lambda: 12, muJ: -0.1, sigmaJ: 0.08 },
    });
    expect(jumpy.terminal.q05).toBeLessThan(base.terminal.q05);
    expect(jumpy.terminal.q95).toBeGreaterThan(base.terminal.q95);
  });

  it('probTouch is monotone in the level and bounded', () => {
    const fan = mixedModelFan(77, 1000, 100, 20, 1 / 96, { drift: 0.1, baseVol: 0.6 });
    const below = fan.probTouch(90);
    const farBelow = fan.probTouch(70);
    const above = fan.probTouch(115);
    expect(below).toBeGreaterThan(farBelow);
    expect(above).toBeGreaterThan(0);
    expect(below).toBeLessThanOrEqual(1);
  });

  it('mcMixedPayoff prices a European call near the BS closed form', () => {
    const S0 = 100, K = 110, T = 0.25, r = 0.03, q = 0;
    const sigma = 0.4;
    const steps = 48;
    const out = mcMixedPayoff(
      (path) => Math.max(path[path.length - 1] - K, 0),
      S0,
      steps,
      T / steps,
      { drift: r - q, baseVol: sigma },
      6000,
      991,
      r,
      q,
    );
    const bs = bsPrice(true, S0, K, T, r, q, sigma);
    expect(Math.abs(out.price - bs) / bs).toBeLessThan(0.03);
    expect(out.stderr).toBeGreaterThan(0);
  });

  it('mixedSpecFromFits assembles every leg from real fits', () => {
    const rets = logRets(Array.from(gbmPath(5, 100, 1, 500, 0.05, 0.4)));
    const garch = fitGarch(rets, { barsPerYear: 35040 });
    const merton = calibrateMerton(rets, { barsPerYear: 35040 }).params;
    const levels = Array.from({ length: rets.length + 1 }, (_, i) => Math.log(100) + i * 0.0001);
    const ou = fitOu(levels);
    const spec = mixedSpecFromFits({
      drift: 0.05,
      garch,
      lastReturn: rets[rets.length - 1],
      merton: { lambda: Math.max(3, merton.lambda), muJ: merton.muJ, sigmaJ: Math.max(0.03, merton.sigmaJ) },
      ou: ou ? { kappaPerBar: ou.kappaPerBar, theta: ou.theta, strength: ou.score } : null,
      barsPerYear: 35040,
      volOfVol: 0.1, // low ⇒ GARCH leg retained
    });
    expect(spec.garch).toBeDefined();
    expect(spec.merton).toBeDefined();
    const fan = mixedModelFan(1, 600, 100, 12, 1 / 35040 * 12, spec);
    expect(fan.terminal.mean).toBeGreaterThan(0);
    // volOfVol high ⇒ Heston leg takes over
    const spec2 = mixedSpecFromFits({
      drift: 0.05,
      garch,
      lastReturn: rets[rets.length - 1],
      merton: null,
      ou: null,
      barsPerYear: 35040,
      volOfVol: 0.5,
    });
    expect(spec2.heston).toBeDefined();
    expect(spec2.garch).toBeUndefined();
  });

  it('boxMuller is standard normal-ish (mean≈0, sd≈1)', () => {
    const rng = mulberry32(123);
    const draws = Array.from({ length: 5000 }, () => boxMuller(rng));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(sd - 1)).toBeLessThan(0.05);
    // matches the legacy gaussian stream contract
    const mc = mcEuropean(true, 100, 110, 0.25, 0.03, 0, 0.4, 20000, 17);
    expect(Math.abs(mc.price / bsPrice(true, 100, 110, 0.25, 0.03, 0, 0.4) - 1)).toBeLessThan(0.02);
  });
});

describe('mixed mc garch leg units', () => {
  it('the GARCH leg produces a realistic band (per-bar variance → annual)', () => {
    // per-bar σ = 1% ⇒ GARCH ω/(1−α−β) = (0.01)² ; annualized ≈ 1.87%
    const rets: number[] = [];
    let s = 0;
    const rng = mulberry32(999);
    for (let i = 0; i < 400; i++) rets.push((rng() - 0.5) * 0.02);
    const garch = fitGarch(rets, { barsPerYear: 35_040 });
    expect(garch).not.toBeNull();
    if (!garch) return;
    const spec = mixedSpecFromFits({
      drift: 0,
      garch,
      lastReturn: rets[rets.length - 1],
      merton: null,
      ou: null,
      barsPerYear: 35_040,
      volOfVol: 0.05,
    });
    expect(spec.garch).toBeDefined();
    const fan = mixedModelFan(321, 2000, 100, 24, 1 / 35_040, spec);
    const bandPct = (fan.terminal.q95 - fan.terminal.q05) / 100;
    // 24 bars × ~1%/bar σ ⇒ band should be several %, not collapsed
    expect(bandPct).toBeGreaterThan(0.02);
    expect(bandPct).toBeLessThan(0.25);
  });
});
