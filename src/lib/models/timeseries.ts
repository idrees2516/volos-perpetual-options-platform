// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · timeseries — the statistical estimation wing.
//
//   • GARCH(1,1)  — quasi-maximum-likelihood fit by deterministic grid +
//                   golden refinement with variance targeting; h-step variance
//                   forecasts, persistence, shock half-life, long-run vol —
//                   the vol-forecast engine that feeds the conformal fan.
//   • OU           — Ornstein–Uhlenbeck fit (AR(1) on the level): speed κ,
//                   half-life, stationary vol, mean-reversion strength — the
//                   "rubber band" score for stretch plays.
//   • Kalman       — local-linear-trend filter: level + slope states, filtered
//                   trend in noise, normalized innovations — the honest trend
//                   detector behind the decision hub's trend pillar.
// ─────────────────────────────────────────────────────────────────────────────

/** per-bar log returns (input to all three engines) */
export type Returns = number[];

// ── GARCH(1,1) ──────────────────────────────────────────────────────────────

export interface GarchFit {
  omega: number;
  alpha: number;
  beta: number;
  /** α + β — variance persistence */
  persistence: number;
  /** long-run (unconditional) variance, ω/(1−α−β) */
  longRunVar: number;
  /** current conditional variance σ²_T and vol σ_T (per-bar) */
  currentVar: number;
  currentVol: number;
  /** unconditional per-bar vol */
  longRunVol: number;
  /** half-life (bars) of a variance shock: ln(0.5)/ln(α+β) */
  shockHalfLifeBars: number | null;
  /** negative Gaussian QML log-likelihood of the fit (lower = better) */
  qll: number;
  /** in-sample standardized residuals */
  residuals: number[];
  /** last-60 conditional vols (per-bar), for the vol fan chart */
  volTail: number[];
  n: number;
  barsPerYear: number;
}

export interface GarchForecast {
  /** h-step-ahead conditional variance path (σ²_{T+1} … σ²_{T+h}) */
  variance: number[];
  /** per-bar vol path */
  vol: number[];
  /** annualized vol % at each step */
  volPctAnnual: number[];
  /** annualized long-run vol % */
  longRunVolPctAnnual: number;
  /** steps for the conditional vol to cover half the gap to long-run */
  convergeBars: number | null;
}

/** Gaussian QML objective + full filter pass for (ω, α, β). */
function garchPass(returns: number[], omega: number, alpha: number, beta: number): { qll: number; residuals: number[]; vars: number[] } {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const varr = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const vars = new Array<number>(n);
  const residuals = new Array<number>(n);
  let v = varr; // σ²₁ = unconditional
  let qll = 0;
  for (let t = 0; t < n; t++) {
    const e = returns[t] - mean;
    vars[t] = v;
    residuals[t] = e / Math.sqrt(Math.max(1e-12, v));
    qll += Math.log(Math.max(1e-12, v)) + (e * e) / Math.max(1e-12, v);
    v = omega + alpha * e * e + beta * v;
    if (!Number.isFinite(v) || v <= 1e-12) v = varr;
  }
  return { qll, residuals, vars };
}

/**
 * Fit GARCH(1,1) by QML: coarse deterministic grid over (α, β) with variance
 * targeting (ω = σ̄²(1−α−β)), then a local refinement grid around the best
 * cell. Deterministic — no RNG anywhere.
 */
export function fitGarch(returns: number[], opts: { barsPerYear?: number } = {}): GarchFit | null {
  const n = returns.length;
  if (n < 60) return null;
  const barsPerYear = opts.barsPerYear ?? 35_040; // 15m bars, 24/7 (callers override)
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const varr = Math.max(1e-12, returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));

  const evaluate = (alpha: number, beta: number): { qll: number; omega: number } | null => {
    if (alpha < 0.005 || beta < 0.2 || alpha + beta > 0.9995) return null;
    const omega = varr * (1 - alpha - beta);
    if (omega <= 0) return null;
    const { qll } = garchPass(returns, omega, alpha, beta);
    if (!Number.isFinite(qll)) return null;
    return { qll, omega };
  };

  // coarse grid
  let bestA = 0.08;
  let bestB = 0.9;
  let bestQ = Infinity;
  let bestO = varr * (1 - bestA - bestB);
  for (const alpha of [0.02, 0.05, 0.08, 0.11, 0.14, 0.17, 0.2, 0.25, 0.3]) {
    for (const beta of [0.3, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99]) {
      const e = evaluate(alpha, beta);
      if (e && e.qll < bestQ) {
        bestQ = e.qll;
        bestA = alpha;
        bestB = beta;
        bestO = e.omega;
      }
    }
  }
  // local refinement (5×5 around the best cell)
  const da = 0.02;
  const db = 0.015;
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const e = evaluate(bestA + i * da, bestB + j * db);
      if (e && e.qll < bestQ) {
        bestQ = e.qll;
        bestA = bestA + i * da;
        bestB = bestB + j * db;
        bestO = e.omega;
      }
    }
  }

  const { residuals, vars } = garchPass(returns, bestO, bestA, bestB);
  const persistence = bestA + bestB;
  const longRunVar = bestO / Math.max(1e-9, 1 - persistence);
  return {
    omega: bestO,
    alpha: bestA,
    beta: bestB,
    persistence,
    longRunVar,
    currentVar: vars[n - 1],
    currentVol: Math.sqrt(Math.max(0, vars[n - 1])),
    longRunVol: Math.sqrt(Math.max(0, longRunVar)),
    shockHalfLifeBars: persistence > 0 && persistence < 1 ? Math.log(0.5) / Math.log(persistence) : null,
    qll: bestQ,
    residuals,
    volTail: vars.slice(-60).map((v) => Math.sqrt(Math.max(0, v))),
    n,
    barsPerYear,
  };
}

/** h-step conditional variance/vol forecast from a fitted GARCH (last return known). */
export function garchForecast(fit: GarchFit, lastReturn: number, h: number): GarchForecast {
  const variance: number[] = [];
  const vol: number[] = [];
  let v = fit.omega + fit.alpha * lastReturn * lastReturn + fit.beta * fit.currentVar;
  const gap0 = Math.abs(v - fit.longRunVar);
  let convergeBars: number | null = null;
  for (let j = 0; j < h; j++) {
    if (!Number.isFinite(v) || v <= 1e-12) v = fit.longRunVar;
    variance.push(v);
    vol.push(Math.sqrt(v));
    if (convergeBars === null && gap0 > 0 && Math.abs(v - fit.longRunVar) <= gap0 / 2) convergeBars = j + 1;
    v = fit.omega + (fit.alpha + fit.beta) * v;
  }
  const perBarToAnnualPct = (s: number): number => s * Math.sqrt(fit.barsPerYear) * 100;
  return {
    variance,
    vol,
    volPctAnnual: vol.map(perBarToAnnualPct),
    longRunVolPctAnnual: perBarToAnnualPct(fit.longRunVol),
    convergeBars,
  };
}

// ── Ornstein–Uhlenbeck (AR(1) on the level) ──────────────────────────────────

export interface OuFit {
  /** AR(1) coefficient φ */
  phi: number;
  /** speed of mean reversion κ = −ln(φ)/Δt (per bar) */
  kappaPerBar: number;
  /** half-life (bars) of a deviation */
  halfLifeBars: number | null;
  /** stationary mean */
  theta: number;
  /** stationary per-bar vol σ/√(2κ) */
  sigmaEq: number;
  /** share of variance explained by the AR(1) pull (0..1) */
  rSquared: number;
  /** 0..100 strength score: reversion significance × usable half-life */
  score: number;
  n: number;
}

/** Fit OU on a level series x_t (e.g. log price, or a basis). */
export function fitOu(levels: number[]): OuFit | null {
  const n = levels.length;
  if (n < 30) return null;
  const xbar = levels.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let t = 1; t < n; t++) {
    num += (levels[t] - xbar) * (levels[t - 1] - xbar);
    den += (levels[t - 1] - xbar) ** 2;
  }
  if (den <= 1e-12) return null;
  const phi = num / den;
  if (phi <= 0 || phi >= 1) return null;
  // residual variance about the AR(1) prediction
  let ssr = 0;
  let sst = 0;
  for (let t = 1; t < n; t++) {
    const pred = xbar + phi * (levels[t - 1] - xbar);
    ssr += (levels[t] - pred) ** 2;
    sst += (levels[t] - xbar) ** 2;
  }
  const rSquared = sst > 0 ? Math.max(0, 1 - ssr / sst) : 0;
  const kappaPerBar = -Math.log(phi);
  const halfLifeBars = kappaPerBar > 0 ? Math.log(2) / kappaPerBar : null;
  const sigmaResid = Math.sqrt(ssr / Math.max(1, n - 2));
  // stationary std of the AR(1) level process: σ_resid/√(1−φ²)
  const sigmaEq = sigmaResid / Math.sqrt(Math.max(1e-9, 1 - phi * phi));
  // significance of the pull (κ·√n — variance-ratio-flavored t-scale): a pure
  // random walk scores ≈0 no matter how high its R² is
  const kScore = Math.min(1, (kappaPerBar * Math.sqrt(n)) / 2);
  // usable half-life band: 8..600 bars scores full, log-decays outside
  const hlScore = halfLifeBars
    ? Math.max(0, 1 - Math.abs(Math.log(Math.min(600, Math.max(8, halfLifeBars)) / 90)) / 3)
    : 0;
  const score = Math.round(100 * rSquared * kScore * (0.35 + 0.65 * hlScore));
  return { phi, kappaPerBar, halfLifeBars, theta: xbar, sigmaEq, rSquared, score, n };
}

/** OU stretch: (x − θ)/σ_eq in σ units + expected decay path. */
export function ouStretch(fit: OuFit, x: number): { z: number; expectedDecayBars: number[] } {
  const z = (x - fit.theta) / Math.max(1e-9, fit.sigmaEq);
  const expectedDecayBars: number[] = [];
  for (let j = 1; j <= 30; j++) {
    expectedDecayBars.push((x - fit.theta) * Math.exp(-fit.kappaPerBar * j) + fit.theta);
  }
  return { z, expectedDecayBars };
}

// ── Kalman local-linear-trend filter ────────────────────────────────────────

export interface KalmanTrend {
  /** filtered level series (same length as input) */
  level: number[];
  /** filtered slope series (units per bar) */
  slope: number[];
  /** final slope (units per bar) */
  currentSlope: number;
  /** current level */
  currentLevel: number;
  /** slope in ATR units (if atr supplied) */
  slopeInAtr: number | null;
  /** normalized innovation variance (≈1 when the model trusts observations) */
  innovationRatio: number;
  /** one-step-ahead residuals */
  residuals: number[];
  /** final innovation variance estimate */
  innovationVar: number;
  n: number;
}

/**
 * Kalman filter with a local-linear-trend state [level, slope] and constant
 * process/measurement noise (q, r). Deterministic. The trend verdict for the
 * decision hub: slope/σ(z-scored) + innovation ratio.
 */
export function kalmanTrend(prices: number[], opts: { q?: number; r?: number; atr?: number | null } = {}): KalmanTrend | null {
  const n = prices.length;
  if (n < 10) return null;
  // state [level, slope], P 2×2, F = [[1,1],[0,1]], H = [1,0]
  const r = opts.r ?? 1;
  const q = opts.q ?? 0.01;
  let l = prices[0];
  let b = n > 1 ? prices[1] - prices[0] : 0;
  let p00 = 1;
  let p01 = 0;
  let p11 = 1;
  const level: number[] = [l];
  const slope: number[] = [b];
  const residuals: number[] = [];
  let innovVarAcc = 0;
  let innovVarN = 0;
  for (let t = 1; t < n; t++) {
    // predict: state [level, slope], F = [[1,1],[0,1]]
    const pl = l + b;
    const pb = b;
    const a00 = p00 + 2 * p01 + p11 + q;
    const a01 = p01 + p11;
    const a11 = p11 + q;
    // innovation
    const innov = prices[t] - pl;
    const s = a00 + r;
    const k0 = a00 / Math.max(1e-12, s);
    const k1 = a01 / Math.max(1e-12, s);
    // update
    l = pl + k0 * innov;
    b = pb + k1 * innov;
    // P = (I − K H) A (I − K H)ᵀ + K R Kᵀ (Joseph form; H = [1,0])
    const i00 = 1 - k0;
    const i10 = -k1;
    const t00 = i00 * a00;
    const t01 = i00 * a01;
    const t10 = i10 * a00 + a01;
    const t11 = i10 * a01 + a11;
    p00 = t00 * i00 + t01 * 0 + k0 * r * k0;
    p01 = t00 * i10 + t01 * 1 + k0 * r * k1;
    p11 = t10 * i10 + t11 * 1 + k1 * r * k1;
    residuals.push(innov);
    innovVarAcc += innov * innov;
    innovVarN++;
    level.push(l);
    slope.push(b);
  }
  const innovationVar = innovVarN > 0 ? innovVarAcc / innovVarN : 1;
  const xbar = prices.reduce((x, y) => x + y, 0) / n;
  const sigmaPrice =
    Math.sqrt(prices.reduce((a, p) => a + (p - xbar) ** 2, 0) / n) || 1e-9;
  const innovationRatio = innovationVar / (sigmaPrice * sigmaPrice);
  const atr = opts.atr ?? null;
  return {
    level,
    slope,
    currentSlope: b,
    currentLevel: l,
    slopeInAtr: atr && atr > 0 ? b / atr : null,
    innovationRatio,
    residuals,
    innovationVar,
    n,
  };
}

/** Trend verdict off a Kalman fit: z-scored slope + stability. */
export function kalmanVerdict(k: KalmanTrend, sigmaPerBar: number): { z: number; label: 'UP'|'DOWN'|'FLAT'; stability: number } {
  const z = sigmaPerBar > 0 ? k.currentSlope / sigmaPerBar : 0;
  const stability = Math.max(0, Math.min(1, 1 / Math.max(0.05, k.innovationRatio)));
  const label = z > 0.35 ? 'UP' : z < -0.35 ? 'DOWN' : 'FLAT';
  return { z, label, stability };
}
