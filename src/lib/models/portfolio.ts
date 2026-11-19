// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · portfolio — position sizing & risk math.
//
//   • Kelly criterion — the discrete (growth-optimal) fraction solved by
//     bisection on E[ln(1 + f·r)] — plus the half-Kelly convention and the
//     expected log-growth curve g(f).
//   • Risk parity    — inverse-volatility weights (sum-1) with a vol-of-vol
//     diversity score.
//   • VaR / CVaR    — historical and Gaussian, per-trade and per-position.
//   • Drawdown      — max/current drawdown from a return stream.
// ─────────────────────────────────────────────────────────────────────────────

export interface KellyResult {
  /** growth-optimal fraction (discrete solve) */
  f: number;
  /** continuous (normal) approximation μ/σ² — for the diagnostic */
  fContinuous: number | null;
  /** expected log growth at f */
  growth: number;
  /** half-Kelly fraction */
  fHalf: number;
  /** fraction that maximizes growth on the observed returns (bounded search) */
  bounded: number;
  n: number;
}

/** Expected log growth E[ln(1 + f·r)] over the return stream. */
export function kellyGrowth(returns: number[], f: number): number {
  let g = 0;
  let n = 0;
  for (const r of returns) {
    const v = 1 + f * r;
    if (v > 0) g += Math.log(v);
    else return -Infinity;
    n++;
  }
  return n > 0 ? g / n : 0;
}

/**
 * Kelly fraction for a stream of per-period returns: bisection maximization
 * of E[ln(1 + f·r)] on f ∈ [0, bound]. Returns the discrete optimum, the
 * continuous μ/σ² cross-check, growth at f, half-Kelly, and the bound-limited
 * value when the unconstrained optimum sits outside [0, bound].
 */
export function kellyFraction(returns: number[], bound = 1): KellyResult | null {
  const n = returns.length;
  if (n < 20) return null;
  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const varr = returns.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1);
  if (varr <= 0) return null;
  const fContinuous = mu / varr;
  // g(f) is concave on its positivity domain — golden-section search on [0, min(bound, maxSafe)]
  const maxSafe = Math.min(bound, 1 / Math.max(1e-9, -Math.min(...returns)));
  let lo = 0;
  let hi = Math.max(0, maxSafe);
  for (let it = 0; it < 60 && hi - lo > 1e-6; it++) {
    const m1 = lo + 0.382 * (hi - lo);
    const m2 = lo + 0.618 * (hi - lo);
    if (kellyGrowth(returns, m1) < kellyGrowth(returns, m2)) lo = m1;
    else hi = m2;
  }
  const f = (lo + hi) / 2;
  return {
    f,
    fContinuous,
    growth: kellyGrowth(returns, f),
    fHalf: f / 2,
    bounded: Math.min(f, bound),
    n,
  };
}

export interface RiskParityResult {
  weights: number[];
  /** 1 − HHI of weights (0..1 diversity) */
  diversity: number;
}

/** Inverse-volatility risk parity weights from per-asset vols. */
export function riskParity(vols: number[]): RiskParityResult | null {
  if (!vols.length) return null;
  const inv = vols.map((v) => 1 / Math.max(1e-9, Math.abs(v) || 1e-9));
  const s = inv.reduce((a, b) => a + b, 0);
  const weights = inv.map((v) => v / s);
  const hhi = weights.reduce((a, w) => a + w * w, 0);
  return { weights, diversity: 1 - hhi };
}

export interface TailRisk {
  /** historical Value-at-Risk (positive number = loss) */
  varHist: number;
  /** historical Conditional VaR (expected shortfall) */
  cvarHist: number;
  /** Gaussian CVaR (μ + σ·φ(z)/(1−c)) */
  cvarGauss: number;
  level: number;
  n: number;
}

/** Historical + Gaussian tail risk of a return stream at confidence c (e.g. 0.95). */
export function tailRisk(returns: number[], c = 0.95): TailRisk | null {
  const n = returns.length;
  if (n < 30) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor((1 - c) * n));
  const worst = sorted.slice(0, k);
  // VaR = the (1−c) empirical quantile (the k-th smallest — the boundary of
  // the tail), CVaR = the mean of the k worst — always at least as extreme.
  const varHist = sorted[k - 1];
  const cvarHist = worst.reduce((a, b) => a + b, 0) / worst.length;
  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1));
  const z = -Math.sqrt(2) * erfinv(1 - 2 * (1 - c)); // z at the left tail
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cvarGauss = mu - (sd * phi) / (1 - c);
  return { varHist, cvarHist, cvarGauss, level: c, n };
}

/** Inverse error function (numerically compact). */
function erfinv(x: number): number {
  const a = 0.147;
  const ln = Math.log(Math.max(1e-300, 1 - x * x));
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = Math.sqrt(Math.max(0, t1 * t1 - (ln / a)));
  const sign = x >= 0 ? 1 : -1;
  return sign * Math.sqrt(Math.max(0, t1 - t2));
}

export interface DrawdownStats {
  maxDd: number;
  currentDd: number;
  barsSincePeak: number;
  n: number;
}

/** Max/current drawdown from a return stream. */
export function drawdown(returns: number[]): DrawdownStats {
  let peak = 1;
  let cur = 1;
  let maxDd = 0;
  let barsSincePeak = 0;
  let lastPeak = 0;
  let n = 0;
  for (const r of returns) {
    cur *= 1 + r;
    if (cur >= peak) {
      peak = cur;
      lastPeak = n;
    }
    maxDd = Math.max(maxDd, 1 - cur / peak);
    n++;
  }
  barsSincePeak = n - lastPeak;
  return { maxDd, currentDd: 1 - cur / peak, barsSincePeak, n };
}

/** Portfolio vol from weights + per-asset vols + a shared correlation ρ. */
export function portfolioVol(weights: number[], vols: number[], rho = 0.7): number | null {
  if (weights.length !== vols.length || !weights.length) return null;
  const s = weights.reduce((a, b) => a + b, 0) || 1;
  const w = weights.map((v) => v / s);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += (w[i] * w[i] * vols[i] * vols[i]);
    for (let j = 0; j < w.length; j++) {
      if (i === j) continue;
      acc += w[i] * w[j] * vols[i] * vols[j] * rho;
    }
  }
  return Math.sqrt(Math.max(0, acc));
}
