// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · market — the machinery of the options market as living toys
// (Part 2 ch2, Part 36–38, Part 11 ch8–9):
//
//   • orderBook3D      — the book as queues: resting depth evolves over time,
//                        market orders walk it, walls form and get eaten —
//                        rendered as a depth×time 3D surface with the tape on top
//   • mmInventory     — a market maker quoting around mid, skew by inventory
//                        (no-skew vs skew: the 64 → 9 max-inventory lesson),
//                        adverse selection = fills happen when you're wrong
//   • pinningExpiry   — Avellaneda–Lipkin style: dealer gamma at the strike
//                        pulls spot toward K near expiry — distribution with
//                        and without the pin force, 1,000 paths each
//   • surfacePCA      — Cont–da Fonseca: 60 weeks of surface moves → the three
//                        eigen-surfaces (level breathing, term twist, skew tilt)
//                        with explained variance — Jacobi eigensolver, seeded
//   • liquidationProb — re-exported from processes for the margin panel
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, gaussianStream } from './rng';

// ── order book as a 3D object ────────────────────────────────────────────────

export interface Book3D {
  /** time labels (step index) */
  times: number[];
  /** price levels (absolute prices, ascending) */
  prices: number[];
  /** depth[i][j] = resting size at price[j] after step i — the 3D surface */
  depth: number[][];
  /** mid path */
  mid: number[];
  /** prints: {t, price, size, side ('buy'|'sell')} */
  tape: { t: number; price: number; size: number; side: 'buy' | 'sell' }[];
}

/** Simulated limit-order book with walls, sweeps and replenishment. */
export function orderBook3D(seed: number, opts: {
  S0: number;
  tick: number;
  nLevels: number;
  steps: number;
  sigma: number;
  wallLevel?: number;
  wallSize?: number;
}): Book3D {
  const rng = mulberry32(seed >>> 0);
  const z = gaussianStream(rng);
  const { S0, tick, nLevels, steps, sigma } = opts;
  const prices: number[] = [];
  for (let j = 0; j < nLevels; j++) {
    prices.push(S0 + (j - Math.floor(nLevels / 2)) * tick);
  }
  let mid = S0;
  const depth: number[][] = [];
  const midPath: number[] = [];
  const tape: { t: number; price: number; size: number; side: 'buy' | 'sell' }[] = [];
  // resting liquidity (lots) per level; walls seeded at opts.wallLevel
  let resting = new Float64Array(nLevels);
  for (let j = 0; j < nLevels; j++) {
    resting[j] = 2 + Math.floor(rng() * 6);
  }
  if (opts.wallLevel != null) {
    const idx = Math.min(nLevels - 1, Math.max(0, Math.round((opts.wallLevel - S0) / tick) + Math.floor(nLevels / 2)));
    resting[idx] = opts.wallSize ?? 40;
  }
  const dt = 1 / (252 * 390);
  // the mid reflects off the grid's edges so the fixed price axis always covers it
  const midHi = S0 + (Math.floor(nLevels / 2) - 4) * tick;
  const midLo = S0 - (Math.floor(nLevels / 2) - 4) * tick;
  for (let i = 0; i < steps; i++) {
    // mid random-walks in ticks (reflected at the grid's edges)
    mid *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z());
    if (mid > midHi) mid = 2 * midHi - mid;
    if (mid < midLo) mid = 2 * midLo - mid;
    // arrivals: new limit orders replenish nearby levels
    const newResting = new Float64Array(nLevels);
    for (let j = 0; j < nLevels; j++) {
      const price = prices[j];
      const dist = Math.abs(price - mid) / tick;
      // liquidity prefers levels near the mid; mean-revert toward 4 lots
      const attract = dist < 3 ? 6 : dist < 6 ? 3 : 0.4;
      newResting[j] = resting[j] * 0.94 + attract * 0.06 + (rng() - 0.5) * 0.3;
      if (opts.wallLevel != null && Math.abs(price - opts.wallLevel!) < tick / 2) {
        // the wall replenishes: institutional resting order
        newResting[j] = Math.max(resting[j], opts.wallSize ?? 40);
      }
    }
    resting = Float64Array.from(newResting, (x) => Math.max(x, 0));
    // market orders walk the book (buy = hit asks above mid, sell = hit bids below)
    const nOrders = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < nOrders; k++) {
      const side = rng() < 0.5 ? 'buy' : 'sell';
      const size = 1 + Math.floor(rng() * 5);
      // start one tick away
      let j = Math.floor(nLevels / 2) + (side === 'buy' ? 1 : -1);
      let remaining = size;
      while (remaining > 0 && j >= 0 && j < nLevels) {
        const onCorrectSide = side === 'buy' ? prices[j] > mid : prices[j] < mid;
        if (!onCorrectSide) break;
        const take = Math.min(resting[j], remaining);
        if (take > 0) {
          resting[j] -= take;
          remaining -= take;
          tape.push({ t: i, price: prices[j], size: take, side });
        }
        j += side === 'buy' ? 1 : -1;
      }
    }
    depth.push(Array.from(resting));
    midPath.push(mid);
  }
  return { times: Array.from({ length: steps }, (_, i) => i), prices, depth, mid: midPath, tape };
}

// ── market maker inventory ───────────────────────────────────────────────────

export interface MMResult {
  t: number[];
  inventory: number[];
  pnl: number[];
  quotes: { t: number; bid: number; ask: number }[];
  /** max |inventory| — the lecture's 64 → 9 number */
  maxInventory: number;
  endingPnl: number;
  nFills: number;
  adverseCost: number;
}

/** A quoting toy: half-spread, inventory skew κ, adverse selection intensity. */
export function mmInventory(seed: number, opts: {
  S0: number;
  steps: number;
  sigma: number;
  halfSpread: number;
  skew: number;
  adverse: number;
  fillProb: number;
}): MMResult {
  const rng = mulberry32(seed >>> 0);
  const z = gaussianStream(rng);
  const { S0, steps, sigma, halfSpread, skew, adverse, fillProb } = opts;
  const dt = 1 / (252 * 390);
  let S = S0;
  let inv = 0;
  let pnl = 0;
  const inventory: number[] = [];
  const pnlArr: number[] = [];
  const quotes: { t: number; bid: number; ask: number }[] = [];
  const ts: number[] = [];
  let fills = 0;
  let adverseCost = 0;
  for (let i = 0; i < steps; i++) {
    // quote: mid ± half-spread, skewed opposite to inventory (cap the skew)
    const skewTotal = -inv * skew * S0 * 0.01;
    const bid = S - halfSpread + skewTotal;
    const ask = S + halfSpread + skewTotal;
    const midNext = S * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z());
    if (rng() < fillProb) {
      // which side fills depends on WHERE the quotes sit: a long-inventory MM
      // skews both quotes DOWN ⇒ the ask is closer to (or through) mid ⇒ more
      // likely to SELL to an incoming buyer; the bid is pushed away ⇒ buys are
      // less likely — this is the mechanism that caps the book.
      const norm = Math.max(-0.9, Math.min(0.9, skewTotal / (4 * halfSpread)));
      let buy = rng() < 0.5 + norm * 0.5;
      // adverse selection: with probability `adverse` the fill is INFORMED —
      // the market about to go UP ⇒ a buyer lifts your ask (you sell); about to
      // go DOWN ⇒ a seller hits your bid (you buy)
      if (rng() < adverse) buy = midNext <= S;
      const size = 1;
      if (buy) {
        // you bought at bid, then the market tells you why
        inv += size;
        pnl += (midNext - bid) * size;
        if (midNext < bid) adverseCost += bid - midNext;
      } else {
        inv -= size;
        pnl += (ask - midNext) * size;
        if (midNext > ask) adverseCost += midNext - ask;
      }
      fills++;
    }
    // mark inventory to the new mid
    pnl += inv * (midNext - S);
    S = midNext;
    inventory.push(inv);
    pnlArr.push(pnl);
    quotes.push({ t: i, bid, ask });
    ts.push(i);
  }
  return {
    t: ts,
    inventory,
    pnl: pnlArr,
    quotes,
    maxInventory: Math.max(...inventory.map(Math.abs)),
    endingPnl: pnl,
    nFills: fills,
    adverseCost,
  };
}

// ── pinning at expiry ────────────────────────────────────────────────────────

/**
 * Avellaneda–Lipkin style pinning: a dealer with large gamma at K delta-hedges,
 * and their hedging exerts a mean-reverting force on spot near the strike.
 * 1,000 paths each with and without the force → the S_T distribution "pins".
 */
export function pinningExpiry(seed: number, opts: {
  S0: number;
  K: number;
  T: number;
  sigma: number;
  steps: number;
  nPaths: number;
  /** pin strength κ (0 = off) */
  kappa: number;
}): { withPin: number[]; withoutPin: number[] } {
  const run = (kappa: number) => {
    const out: number[] = [];
    for (let p = 0; p < opts.nPaths; p++) {
      const z = gaussianStream(mulberry32((seed + p * 7577) >>> 0));
      const dt = opts.T / opts.steps;
      let S = opts.S0;
      for (let i = 0; i < opts.steps; i++) {
        // the dealer force: proportional to distance from K, only near expiry
        const nearExpiry = i / opts.steps > 0.7 ? 1 : i / opts.steps / 0.7;
        const pull = kappa * nearExpiry * (opts.K - S);
        S = S * Math.exp(-0.5 * opts.sigma * opts.sigma * dt + opts.sigma * Math.sqrt(dt) * z()) + pull * dt;
      }
      out.push(S);
    }
    return out;
  };
  return { withPin: run(opts.kappa), withoutPin: run(0) };
}

/** Histogram (as density) of a sample for the pinning overlay. */
export function histDensity(xs: number[], lo: number, hi: number, bins = 60): { x: number[]; y: number[] } {
  const counts = new Array(bins).fill(0);
  const w = (hi - lo) / bins;
  for (const x of xs) {
    const b = Math.floor((x - lo) / w);
    if (b >= 0 && b < bins) counts[b]++;
  }
  const n = xs.length || 1;
  return {
    x: counts.map((_, i) => lo + (i + 0.5) * w),
    y: counts.map((c) => c / (n * w)),
  };
}

// ── PCA of surface moves ─────────────────────────────────────────────────────

export interface PcaResult {
  /** explained variance per component */
  explained: number[];
  /** eigen-surfaces flattened on the k×T grid */
  eigen: number[][]; // [component][cell]
  kGrid: number[];
  TGrid: number[];
}

/** Jacobi eigendecomposition of a real symmetric matrix (top-m eigenpairs). */
export function jacobiEigen(A: number[][], maxSweeps = 30): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-14) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = a.map((r, i) => r[i]);
  return { values, vectors: V };
}

/**
 * Cont–da Fonseca PCA on 60 weeks of synthetic surface moves (seeded): the
 * weekly change of each cell of a k×T log-vol grid is driven by 3 AR(1)
 * factors (level, term twist, skew tilt) + noise — exactly the shapes the
 * lecture animates. Returns eigen-surfaces + explained variance.
 */
export function surfacePCA(seed: number, opts: { weeks: number; kGrid: number[]; TGrid: number[] }): PcaResult {
  const rng = mulberry32(seed >>> 0);
  const z = gaussianStream(rng);
  const { weeks, kGrid, TGrid } = opts;
  const cells = kGrid.length * TGrid.length;
  // factor loadings: PC1 = level (uniform), PC2 = term twist (by T), PC3 = skew tilt (by k)
  const load1 = new Float64Array(cells);
  const load2 = new Float64Array(cells);
  const load3 = new Float64Array(cells);
  let c = 0;
  for (const T of TGrid) {
    for (const k of kGrid) {
      load1[c] = 1;
      load2[c] = (T - TGrid[Math.floor(TGrid.length / 2)]) / (TGrid[TGrid.length - 1] - TGrid[0] || 1);
      load3[c] = (k - kGrid[Math.floor(kGrid.length / 2)]) / (kGrid[kGrid.length - 1] - kGrid[0] || 1);
      c++;
    }
  }
  const scale = (f: Float64Array) => Math.sqrt(f.reduce((s, v) => s + v * v, 0));
  for (const f of [load1, load2, load3]) {
    const s = scale(f);
    for (let i = 0; i < f.length; i++) f[i] /= s;
  }
  // AR(1) factors with different persistence + noise
  const ar = (rho: number, sd: number, steps: number) => {
    const xs: number[] = [];
    let x = 0;
    for (let i = 0; i < steps; i++) {
      x = rho * x + sd * z();
      xs.push(x);
    }
    return xs;
  };
  const f1 = ar(0.6, 1.0, weeks);
  const f2 = ar(0.5, 0.55, weeks);
  const f3 = ar(0.4, 0.28, weeks);
  // weekly CHANGES of the grid
  const X: number[][] = [];
  for (let w = 1; w < weeks; w++) {
    const row = new Float64Array(cells);
    for (let i = 0; i < cells; i++) {
      row[i] = f1[w] * load1[i] + f2[w] * load2[i] + f3[w] * load3[i] + 0.12 * (rng() - 0.5);
    }
    X.push(Array.from(row));
  }
  // covariance (cells × cells) — 45×45 for a 9×5 grid
  const n = X.length;
  const mean = new Float64Array(cells);
  for (const row of X) for (let i = 0; i < cells; i++) mean[i] += row[i] / n;
  const cov: number[][] = Array.from({ length: cells }, () => new Array(cells).fill(0));
  for (const row of X) {
    for (let i = 0; i < cells; i++) {
      const di = row[i] - mean[i];
      for (let j = 0; j < cells; j++) {
        cov[i][j] += (di * (row[j] - mean[j])) / (n - 1);
      }
    }
  }
  const { values, vectors } = jacobiEigen(cov);
  // order descending
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 3);
  const totalVar = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
  const eigen = order.map(({ i }) => vectors.map((col) => col[i]));
  const explained = order.map(({ v }) => Math.max(0, v) / totalVar);
  return { explained, eigen, kGrid, TGrid };
}
