// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · ml — the statistical-learning wing (pure, seeded, tiny).
//
//   • Logistic regression — online SGD with L2, walk-forward validation
//     (train chronologically, test strictly out-of-sample): P(up) classifier
//     that cross-checks the forecast layer's climatology.
//   • Ridge regression    — closed-form normal equations.
//   • k-means            — seeded k-means++ init + Lloyd, silhouette.
//   • CART + mini forest — gini decision trees (depth ≤ 4) with seeded
//     bagging and out-of-bag scoring: the signal-confluence learner.
//   • Feature builder    — marketFeatureMatrix: momentum/trend/vol-regime
//     columns from a close (and optional flow) history, no look-ahead.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from './rng';

export interface Matrix {
  /** rows × cols, row-major */
  x: Float64Array[];
  /** labels */
  y: number[];
}

/** Solve (XᵀX + λI)β = Xᵀy by Gaussian elimination with partial pivoting. */
export function solveRidge(x: Float64Array[], y: number[], lambda = 1e-4): number[] | null {
  const m = x.length;
  if (m < 2 || y.length !== m) return null;
  const k = x[0].length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < m; i++) {
    const row = x[i];
    for (let a = 0; a < k; a++) {
      b[a] += row[a] * y[i];
      for (let c = 0; c < k; c++) A[a][c] += row[a] * row[c];
    }
  }
  for (let a = 0; a < k; a++) A[a][a] += lambda * m;
  // gaussian elimination
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[k] / row[i]);
}

// ── logistic regression ────────────────────────────────────────────────────

export interface LogisticModel {
  w: Float64Array;
  b: number;
  /** z-scoring used at fit time (apply before predict) */
  mu: Float64Array;
  sd: Float64Array;
  featureCount: number;
  trainN: number;
}

export interface LogisticMetrics {
  accuracy: number;
  logLoss: number;
  auc: number | null;
  n: number;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Column-wise z-scoring of the design matrix (mutates nothing). */
function zscore(x: Float64Array[]): { z: Float64Array[]; mu: Float64Array; sd: Float64Array } {
  const k = x[0]?.length ?? 0;
  const mu = new Float64Array(k);
  const sd = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    let s = 0;
    for (const row of x) s += row[c];
    mu[c] = s / x.length;
  }
  for (let c = 0; c < k; c++) {
    let v = 0;
    for (const row of x) v += (row[c] - mu[c]) ** 2;
    sd[c] = Math.sqrt(v / Math.max(1, x.length - 1)) || 1;
  }
  const z = x.map((row) => {
    const out = new Float64Array(k);
    for (let c = 0; c < k; c++) out[c] = (row[c] - mu[c]) / sd[c];
    return out;
  });
  return { z, mu, sd };
}

/**
 * Batch-SGD logistic regression with a seeded shuffle: (epochs × lr) fixed,
 * L2 regularization. Deterministic given the seed.
 */
export function trainLogistic(
  x: Float64Array[],
  y: number[],
  opts: { lr?: number; epochs?: number; l2?: number; seed?: number } = {},
): LogisticModel | null {
  const m = x.length;
  const k = x[0]?.length ?? 0;
  if (m < 20 || k === 0) return null;
  const { z, mu, sd } = zscore(x);
  const lr = opts.lr ?? 0.1;
  const epochs = opts.epochs ?? 60;
  const l2 = opts.l2 ?? 1e-3;
  const rng = mulberry32((opts.seed ?? 20260101) >>> 0);
  const w = new Float64Array(k);
  let b = 0;
  const idx = Array.from({ length: m }, (_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    // seeded Fisher-Yates shuffle
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const i of idx) {
      const row = z[i];
      let acc = b;
      for (let c = 0; c < k; c++) acc += w[c] * row[c];
      const p = sigmoid(acc);
      const gErr = p - (y[i] > 0 ? 1 : 0);
      for (let c = 0; c < k; c++) w[c] -= lr * (gErr * row[c] + l2 * w[c]);
      b -= lr * gErr;
    }
  }
  return { w, b, mu, sd, featureCount: k, trainN: m };
}

/** P(up) prediction of a raw (unstandardized) feature row. */
export function logisticPredict(model: LogisticModel, row: Float64Array): number {
  let acc = model.b;
  for (let c = 0; c < model.featureCount; c++) {
    const raw = row[c];
    if (!Number.isFinite(raw)) return 0.5; // missing data ⇒ no information
    const z = (raw - model.mu[c]) / model.sd[c];
    acc += Number.isFinite(z) ? model.w[c] * z : 0;
  }
  return sigmoid(acc);
}

/** Out-of-sample metrics: accuracy, log loss, AUC (rank-based). */
export function logisticEvaluate(model: LogisticModel, x: Float64Array[], y: number[]): LogisticMetrics | null {
  const m = x.length;
  if (m < 5) return null;
  let correct = 0;
  let ll = 0;
  const probs: number[] = [];
  for (let i = 0; i < m; i++) {
    const p = logisticPredict(model, x[i]);
    probs.push(p);
    if ((p >= 0.5 ? 1 : 0) === (y[i] > 0 ? 1 : 0)) correct++;
    const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
    ll += (y[i] > 0 ? 1 : 0) ? Math.log(pc) : Math.log(1 - pc);
  }
  // AUC by rank (Mann–Whitney)
  let auc: number | null = null;
  const pos = probs.filter((_, i) => y[i] > 0);
  const neg = probs.filter((_, i) => y[i] <= 0);
  if (pos.length && neg.length) {
    let wins = 0;
    for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
    auc = wins / (pos.length * neg.length);
  }
  return { accuracy: correct / m, logLoss: -ll / m, auc, n: m };
}

// ── k-means ────────────────────────────────────────────────────────────────

export interface KMeansFit {
  centroids: Float64Array[];
  assignments: number[];
  inertia: number;
  iters: number;
  k: number;
}

/** Seeded k-means++ init + Lloyd iterations. Deterministic. */
export function kMeans(x: Float64Array[], k: number, opts: { seed?: number; iters?: number } = {}): KMeansFit | null {
  const m = x.length;
  if (m < k || k < 1) return null;
  const dims = x[0].length;
  const rng = mulberry32((opts.seed ?? 42) >>> 0);
  const dist2 = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let d = 0; d < dims; d++) s += (a[d] - b[d]) ** 2;
    return s;
  };
  // k-means++ seeding
  const centroids: Float64Array[] = [x[Math.floor(rng() * m)].slice()];
  while (centroids.length < k) {
    const d2 = x.map((row) => Math.min(...centroids.map((c) => dist2(row, c))));
    const total = d2.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      centroids.push(x[Math.floor(rng() * m)].slice());
      continue;
    }
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < m; i++) {
      r -= d2[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(x[pick].slice());
  }
  const assignments = new Array<number>(m).fill(0);
  let iters = 0;
  let inertia = Infinity;
  for (let it = 0; it < (opts.iters ?? 40); it++) {
    iters = it + 1;
    inertia = 0;
    for (let i = 0; i < m; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(x[i], centroids[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assignments[i] = best;
      inertia += bd;
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < m; i++) {
      counts[assignments[i]]++;
      for (let d = 0; d < dims; d++) sums[assignments[i]][d] += x[i][d];
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const newC = new Float64Array(dims);
      for (let d = 0; d < dims; d++) newC[d] = sums[c][d] / counts[c];
      moved += dist2(newC, centroids[c]);
      centroids[c] = newC;
    }
    if (moved < 1e-10) break;
  }
  return { centroids, assignments, inertia, iters, k };
}

/** Mean silhouette coefficient (O(n²) — fine for the hub's ≤ 700 points). */
export function silhouette(x: Float64Array[], assignments: number[], centroids: Float64Array[]): number | null {
  const m = x.length;
  if (m < 3 || m > 2000) return null;
  const k = centroids.length;
  const dist = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let d = 0; d < a.length; d++) s += (a[d] - b[d]) ** 2;
    return Math.sqrt(s);
  };
  // cluster means of pairwise distances (streamed)
  const inSum = new Array<number>(k).fill(0);
  const inCnt = new Array<number>(k).fill(0);
  const outSum: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const outCnt: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const d = dist(x[i], x[j]);
      const ci = assignments[i];
      const cj = assignments[j];
      if (ci === cj) {
        inSum[ci] += 2 * d;
        inCnt[ci] += 2;
      } else {
        outSum[ci][cj] += d;
        outCnt[ci][cj]++;
        outSum[cj][ci] += d;
        outCnt[cj][ci]++;
      }
    }
  }
  let total = 0;
  let nUsed = 0;
  for (let i = 0; i < m; i++) {
    const c = assignments[i];
    const a = inCnt[c] > 0 ? inSum[c] / inCnt[c] : 0;
    let b = Infinity;
    for (let c2 = 0; c2 < k; c2++) {
      if (c2 === c || outCnt[c][c2] === 0) continue;
      // mean distance from i's cluster to c2 (approximated by cluster means)
      b = Math.min(b, outSum[c][c2] / outCnt[c][c2]);
    }
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    nUsed++;
  }
  return nUsed > 0 ? total / nUsed : null;
}

// ── CART decision tree + mini random forest ─────────────────────────────────

export interface TreeNode {
  leaf: true;
  /** class vote mass per class (0/1 binary) */
  dist: [number, number];
} export interface TreeBranch {
  leaf: false;
  feature: number;
  threshold: number;
  left: TreeNode | TreeBranch;
  right: TreeNode | TreeBranch;
}
export type Tree = TreeNode | TreeBranch;

const gini = (n0: number, n1: number): number => {
  const n = n0 + n1;
  if (n === 0) return 0;
  const p = n1 / n;
  return 2 * p * (1 - p);
};

/** Single CART tree (binary classification, gini, midpoint thresholds). */
export function cartTree(
  x: Float64Array[],
  y: number[],
  opts: { maxDepth?: number; minLeaf?: number; maxThresholds?: number; seed?: number } = {},
): Tree | null {
  const m = x.length;
  if (m < 8 || x[0]?.length === 0) return null;
  const maxDepth = opts.maxDepth ?? 3;
  const minLeaf = opts.minLeaf ?? 8;
  const maxThresholds = opts.maxThresholds ?? 24;

  const build = (rows: number[], depth: number): Tree => {
    let n1 = 0;
    for (const i of rows) if (y[i] > 0) n1++;
    const leaf: TreeNode = { leaf: true, dist: [rows.length - n1, n1] };
    if (depth >= maxDepth || rows.length < 2 * minLeaf || n1 === 0 || n1 === rows.length) return leaf;
    // candidate thresholds per feature from quantile cut points
    let best: { feature: number; thr: number; gain: number; left: number[]; right: number[] } | null = null;
    const parentImpurity = gini(rows.length - n1, n1);
    for (let f = 0; f < x[0].length; f++) {
      const vals = rows.map((i) => x[i][f]).sort((a, b) => a - b);
      const cuts: number[] = [];
      for (let t = 1; t <= maxThresholds; t++) {
        const v = vals[Math.floor((t / (maxThresholds + 1)) * vals.length)];
        if (v !== undefined && (cuts.length === 0 || v > cuts[cuts.length - 1])) cuts.push(v);
      }
      for (const thr of cuts) {
        const left: number[] = [];
        const right: number[] = [];
        for (const i of rows) (x[i][f] <= thr ? left : right).push(i);
        if (left.length < minLeaf || right.length < minLeaf) continue;
        let l1 = 0;
        let r1 = 0;
        for (const i of left) if (y[i] > 0) l1++;
        for (const i of right) if (y[i] > 0) r1++;
        const impurity = (left.length * gini(left.length - l1, l1) + right.length * gini(right.length - r1, r1)) / rows.length;
        const gain = parentImpurity - impurity;
        if (gain > 1e-6 && (!best || gain > best.gain)) best = { feature: f, thr, gain, left, right };
      }
    }
    if (!best) return leaf;
    return {
      leaf: false,
      feature: best.feature,
      threshold: best.thr,
      left: build(best.left, depth + 1),
      right: build(best.right, depth + 1),
    };
  };

  return build(Array.from({ length: m }, (_, i) => i), 0);
}

export function treePredict(tree: Tree, row: Float64Array): number {
  let node: Tree = tree;
  while (!node.leaf) node = row[node.feature] <= node.threshold ? node.left : node.right;
  return node.dist[1] >= node.dist[0] ? 1 : 0;
}

export interface MiniForest {
  trees: Tree[];
  oobAccuracy: number | null;
  nTrees: number;
}

/** Bagged mini-forest of CART trees with out-of-bag accuracy. Deterministic. */
export function miniForest(
  x: Float64Array[],
  y: number[],
  opts: { nTrees?: number; depth?: number; seed?: number } = {},
): MiniForest | null {
  const m = x.length;
  if (m < 24 || x[0]?.length === 0) return null;
  const nTrees = opts.nTrees ?? 9;
  const rng = mulberry32((opts.seed ?? 777) >>> 0);
  const trees: Tree[] = [];
  const oobVotes: number[][] = Array.from({ length: m }, () => []);
  for (let t = 0; t < nTrees; t++) {
    const bag: number[] = [];
    for (let i = 0; i < m; i++) bag.push(Math.floor(rng() * m));
    const oob: number[] = [];
    const bagSet = new Set(bag);
    for (let i = 0; i < m; i++) if (!bagSet.has(i)) oob.push(i);
    const tree = cartTree(
      bag.map((i) => x[i]),
      bag.map((i) => y[i]),
      { maxDepth: opts.depth ?? 3, minLeaf: 6 },
    );
    if (!tree) continue;
    trees.push(tree);
    for (const i of oob) oobVotes[i].push(treePredict(tree, x[i]));
  }
  if (!trees.length) return null;
  let correct = 0;
  let n = 0;
  for (let i = 0; i < m; i++) {
    if (!oobVotes[i].length) continue;
    const up = oobVotes[i].filter((v) => v > 0).length;
    const pred = up * 2 > oobVotes[i].length ? 1 : 0;
    if (pred === (y[i] > 0 ? 1 : 0)) correct++;
    n++;
  }
  return { trees, oobAccuracy: n > 0 ? correct / n : null, nTrees: trees.length };
}

export function forestPredict(forest: MiniForest, row: Float64Array): { up: number; down: number; p: number } {
  let up = 0;
  let down = 0;
  for (const tree of forest.trees) {
    const v = treePredict(tree, row);
    if (v > 0) up++;
    else down++;
  }
  const total = up + down || 1;
  return { up, down, p: up / total };
}

// ── market feature matrix ───────────────────────────────────────────────────

export interface FeatureMatrix {
  x: Float64Array[];
  y: number[];
  /** human labels for each column */
  featureNames: string[];
  n: number;
}

/**
 * Lagged market features from closes (+optional flow): momentum 1/3/7/14,
 * RSI(14)/100, rolling-vol z, short-vs-long |ret| ratio, EMA12−EMA26 gap in
 * σ units, CVD-slope z (when flow supplied). Target: next-bar up. All columns
 * are known at time t (no look-ahead).
 */
export function marketFeatureMatrix(
  closes: number[],
  flow?: { buyShares?: number[]; deltas?: number[] },
): FeatureMatrix | null {
  const n = closes.length;
  if (n < 40) return null;
  const rets = new Array<number>(n - 1);
  for (let i = 1; i < n; i++) rets[i - 1] = Math.log(closes[i] / closes[i - 1]);
  // RSI(14) Wilder
  const rsiArr = new Array<number>(n).fill(50);
  {
    let g = 0;
    let l = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d;
      else l -= d;
    }
    let ag = g / 14;
    let al = l / 14;
    rsiArr[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = 15; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * 13 + Math.max(0, d)) / 14;
      al = (al * 13 + Math.max(0, -d)) / 14;
      rsiArr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  // EMA12/26
  const ema = (period: number): number[] => {
    const k = 2 / (period + 1);
    const out = new Array<number>(n).fill(closes[0]);
    for (let i = 1; i < n; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
    return out;
  };
  const ema12 = ema(12);
  const ema26 = ema(26);
  // rolling σ20 and σ84 of returns
  const sig20 = (i: number): number => {
    const from = Math.max(0, i - 20);
    let m = 0;
    const seg = rets.slice(from, i);
    if (!seg.length) return 1e-4;
    for (const v of seg) m += v;
    m /= seg.length;
    let v = 0;
    for (const r of seg) v += (r - m) ** 2;
    return Math.sqrt(v / Math.max(1, seg.length - 1)) || 1e-4;
  };
  const absMean = (from: number, to: number): number => {
    let s = 0;
    let c = 0;
    for (let i = Math.max(0, from); i < Math.max(0, to); i++) {
      s += Math.abs(rets[i]);
      c++;
    }
    return c > 0 ? s / c : 1e-4;
  };
  const x: Float64Array[] = [];
  const y: number[] = [];
  const featureNames = [
    'ret1',
    'ret3',
    'ret7',
    'ret14',
    'rsi14',
    'volZ20',
    'shortLongVol',
    'macdGap',
    flow?.deltas ? 'cvdSlope5' : '-',
  ].filter((s) => s !== '-');
  for (let t = 22; t < n - 1; t++) {
    const r1 = rets[t - 1];
    const r3 = rets[t - 1] + rets[t - 2] + rets[t - 3];
    const r7 = rets.slice(t - 7, t).reduce((a, b) => a + b, 0);
    const r14 = rets.slice(t - 14, t).reduce((a, b) => a + b, 0);
    const s20 = sig20(t);
    let vzAcc = 0;
    let vzN = 0;
    let vzMean = 0;
    // σ20 z-score: (current σ20 − mean σ20 over last 60) / std of σ20
    const win: number[] = [];
    for (let j = t - 60; j < t; j++) win.push(sig20(j));
    if (win.length > 5) {
      vzMean = win.reduce((a, b) => a + b, 0) / win.length;
      vzAcc = win.reduce((a, b) => a + (b - vzMean) ** 2, 0);
      vzN = win.length - 1;
    }
    const vzStd = Math.sqrt(vzAcc / Math.max(1, vzN)) || 1e-6;
    const volZ20 = (s20 - vzMean) / vzStd;
    const shortLongVol = absMean(t - 5, t) / Math.max(1e-9, absMean(t - 84, t));
    const macdGap = (ema12[t] - ema26[t]) / Math.max(1e-9, s20 * Math.sqrt(20));
    const row = [r1, r3, r7, r14, rsiArr[t] / 100 - 0.5, volZ20, shortLongVol, macdGap];
    if (flow?.deltas) {
      let cvd5 = 0;
      for (let j = t - 5; j < t; j++) cvd5 += flow.deltas[j] ?? 0;
      const cvdAbs = flow.deltas.slice(t - 60, t).reduce((a, b) => a + Math.abs(b), 0) / 60 || 1;
      row.push(cvd5 / cvdAbs);
    }
    // one bad bar (gap, zero volume, store glitch) must never poison a feature row
    if (!row.every(Number.isFinite)) continue;
    x.push(new Float64Array(row));
    y.push(rets[t] > 0 ? 1 : 0);
  }
  return { x, y, featureNames, n: x.length };
}

/**
 * Walk-forward validation of the P(up) classifier: train on the first
 * trainFrac of the (chronological) matrix, test strictly on the later tail.
 */
export function walkForwardPUp(
  fm: FeatureMatrix,
  opts: { trainFrac?: number; seed?: number } = {},
): { metrics: LogisticMetrics; model: LogisticModel } | null {
  const m = fm.x.length;
  if (m < 60) return null;
  const cut = Math.floor(m * (opts.trainFrac ?? 0.7));
  if (cut < 30 || m - cut < 15) return null;
  const model = trainLogistic(fm.x.slice(0, cut), fm.y.slice(0, cut), { seed: opts.seed });
  if (!model) return null;
  const metrics = logisticEvaluate(model, fm.x.slice(cut), fm.y.slice(cut));
  if (!metrics) return null;
  return { metrics, model };
}
